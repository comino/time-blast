/**
 * Dataset loading SQL and DatasetContext statistics. Cold path (runs once per dataset).
 * Nothing here is used while executing model SQL.
 */
import type { DatasetContext } from './contracts';

/** Registered upload buffers live under this prefix; it is the only path DuckDB may read
 * after boot (`allowed_directories`), and files are dropped once materialized. */
export const UPLOAD_DIR = '/upload/';

const VESSEL_NAMES = ['Aurora', 'Meridian', 'Kestrel', 'Solstice', 'Atlas', 'Nomad'];
export const VESSELS_ROWS = 1_209_600;
const VESSELS_START_MS = 1_788_220_800_000; // 2026-09-01T00:00:00Z

/** The prototype's synthetic generator (src/adapters/synthetic-data.ts), evaluated inside
 * DuckDB: six vessels, one reading every six seconds, 1–14 September 2026 UTC. Time is a
 * real TIMESTAMP (UTC wall clock) and the vessel a VARCHAR name. */
export const VESSELS_SQL = `CREATE TABLE telemetry AS
WITH grid AS (
  SELECT (i % 6)::INTEGER AS vessel, (i // 6) * 6000 AS elapsed_ms,
         (i // 6)::DOUBLE / 10.0 AS minute_index
  FROM range(${VESSELS_ROWS}) AS readings(i)
), signals AS (
  SELECT *, minute_index / 1440.0 AS day,
         exp(-pow((minute_index / 1440.0 - 7.0 - vessel * 0.18) / 1.2, 2)) AS storm
  FROM grid
)
SELECT make_timestamp((${VESSELS_START_MS} + elapsed_ms) * 1000) AS ts,
       ([${VESSEL_NAMES.map(name => `'${name}'`).join(', ')}])[vessel + 1] AS vessel,
       round(12.8 + vessel * 0.7 + 2.1 * sin(minute_index / 420 + vessel) - storm * 4.7, 2)::DOUBLE AS speed,
       round(11.0 + 4.0 * sin(minute_index / 660 + vessel * 0.8) + storm * 25.0 + vessel * 0.4, 2)::DOUBLE AS wind,
       round(1.3 + 0.35 * sin(minute_index / 720 + vessel) + storm * 3.7 + vessel * 0.08, 3)::DOUBLE AS wave_height,
       round(18.0 - vessel * 0.5 + 0.65 * cos(minute_index / 1440 * 6.283185307179586) - day * 0.08, 2)::DOUBLE AS water_temp,
       round(36.0 + vessel * 2.3 + day * 0.48 + 1.2 * sin(day * 0.5 + vessel), 5)::DOUBLE AS lat,
       round(-61.0 + vessel * 1.2 + day * 2.1 + 1.5 * cos(day * 0.37 + vessel), 5)::DOUBLE AS lon
FROM signals`;

export const VESSELS_DESCRIPTION = 'Synthetic vessel telemetry: six fictional vessels, one reading every six seconds, '
  + '1–14 September 2026 UTC. Speed and wind in knots, wave height in metres, water temperature in °C, lat/lon in degrees.';
export const VESSELS_SMALL_DESCRIPTION = 'Synthetic vessel telemetry (small): one reading per minute, 1–14 September 2026 UTC; '
  + 't is Unix epoch milliseconds, vessel an index 0–5.';

export function quoteIdent(name: string): string { return `"${name.replaceAll('"', '""')}"`; }
export function quoteLiteral(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

/** A table name for a dropped file: the file stem, lowercase, [a-z0-9_], not starting with a digit. */
export function tableNameFor(fileName: string): string {
  const stem = fileName.replace(/^.*[\\/]/, '').replace(/\.(parquet|csv|tsv|txt)(\.gz)?$/i, '');
  let name = stem.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!name) name = 'data';
  if (/^[0-9]/.test(name)) name = `t_${name}`;
  return name.slice(0, 63);
}

export type FileFormat = 'parquet' | 'csv';
/** Parquet files start (and end) with the magic `PAR1`; everything else is read as CSV. */
export function sniffFormat(name: string, bytes: Uint8Array): FileFormat {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x41 && bytes[2] === 0x52 && bytes[3] === 0x31) return 'parquet';
  if (/\.parquet$/i.test(name)) return 'parquet';
  return 'csv';
}

export function loadFileSql(table: string, path: string, format: FileFormat): string {
  const reader = format === 'parquet' ? `read_parquet(${quoteLiteral(path)})` : `read_csv(${quoteLiteral(path)}, auto_detect = true)`;
  return `CREATE TABLE ${quoteIdent(table)} AS SELECT * FROM ${reader}`;
}

// ───────────────────────── statistics ─────────────────────────

export type ColumnClass = 'numeric' | 'temporal' | 'text' | 'boolean' | 'other';

export function classify(type: string): ColumnClass {
  const t = type.toUpperCase();
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|REAL|DOUBLE|DECIMAL)\b/.test(t)) return 'numeric';
  if (/^(DATE|TIME|TIMESTAMP)\b/.test(t)) return 'temporal';
  if (/^(VARCHAR|ENUM)\b/.test(t)) return 'text';
  if (t === 'BOOLEAN') return 'boolean';
  return 'other';
}

/** Low-cardinality text columns list their values when there are at most this many. */
export const MAX_LISTED_VALUES = 32;

export interface ColumnInfo { name: string; type: string }

/** One pass over the table: row count, min/max for numeric and temporal columns, and for
 * text columns approx_count_distinct plus approx_top_k(…, 33). approx_top_k tracks every
 * value exactly when a column has at most k distinct values, so a list of ≤ 32 entries is
 * the exact value set; 33 entries means "more than 32". Measured ~10× faster than SUMMARIZE
 * (docs/batch-1/engine.md). Output columns are positional: s0, s1, … */
export function statisticsSql(table: string, columns: ColumnInfo[]): string {
  const parts = ['count(*)::DOUBLE AS s0'];
  let n = 1;
  for (const column of columns) {
    const c = quoteIdent(column.name);
    switch (classify(column.type)) {
      case 'numeric': parts.push(`min(${c})::DOUBLE AS s${n++}`, `max(${c})::DOUBLE AS s${n++}`); break;
      case 'temporal': parts.push(`min(${c})::VARCHAR AS s${n++}`, `max(${c})::VARCHAR AS s${n++}`); break;
      case 'text': parts.push(`approx_count_distinct(${c})::DOUBLE AS s${n++}`,
        `approx_top_k(${c}::VARCHAR, ${MAX_LISTED_VALUES + 1}) AS s${n++}`); break;
      default: break;
    }
  }
  return `SELECT ${parts.join(', ')} FROM ${quoteIdent(table)}`;
}

/** Sample rows as JSON-friendly values: numbers as DOUBLE, text and booleans as they are,
 * everything else (temporal, nested, blobs) rendered by DuckDB as text. */
export function sampleSql(table: string, columns: ColumnInfo[], rows: number): string {
  const list = columns.map(column => {
    const c = quoteIdent(column.name);
    switch (classify(column.type)) {
      case 'numeric': return `${c}::DOUBLE AS ${c}`;
      case 'text': return `${c}::VARCHAR AS ${c}`;
      case 'boolean': return c;
      default: return `${c}::VARCHAR AS ${c}`;
    }
  });
  return `SELECT ${list.join(', ') || '*'} FROM ${quoteIdent(table)} LIMIT ${rows}`;
}

type Table = DatasetContext['tables'][number];
type Column = Table['columns'][number];

/** Turn one statistics row (values s0…sN in order) into the context columns. */
export function applyStatistics(columns: ColumnInfo[], values: unknown[]): { rows: number; columns: Column[] } {
  let n = 1;
  const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const out = columns.map(({ name, type }): Column => {
    const column: Column = { name, type };
    switch (classify(type)) {
      case 'numeric': {
        const min = finite(values[n++]), max = finite(values[n++]);
        if (min !== undefined) column.min = min;
        if (max !== undefined) column.max = max;
        break;
      }
      case 'temporal': {
        const min = values[n++], max = values[n++];
        if (typeof min === 'string') column.min = min;
        if (typeof max === 'string') column.max = max;
        break;
      }
      case 'text': {
        const approx = finite(values[n++]);
        const top = values[n++] as string[] | null;
        if (top && top.length <= MAX_LISTED_VALUES) {
          column.distinct = top.length;
          column.values = [...top].sort();
        } else if (approx !== undefined) {
          column.distinct = Math.max(approx, MAX_LISTED_VALUES + 1);
        }
        break;
      }
      default: break;
    }
    return column;
  });
  return { rows: Number(values[0] ?? 0), columns: out };
}
