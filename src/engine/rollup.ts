/**
 * Time rollups ("materialized time-series tiles") and the exact rewrite of model SQL onto them.
 *
 * After a dataset loads, the database node builds, in the background, per-table rollups at a
 * few time grains (minute, hour, day): one row per (time bucket × low-cardinality dimension
 * values) with count(*) and sum/min/max (+ count when the column has NULLs) of every numeric
 * column. Coarser grains are built from finer ones. Nothing here assumes a schema: the time
 * column is the table's first TIMESTAMP column, dimensions are text/boolean columns whose
 * complete value set the dataset statistics listed (≤ 32 values), measures are integer and
 * floating-point columns.
 *
 * The rewrite works on DuckDB's own parse tree (`json_serialize_sql`), accepts only a whitelisted
 * subset and prints the result with `json_deserialize_sql`. It is exact because:
 *
 * 1. **Same groups.** The time column is only allowed inside expressions that are constant on
 *    every grain cell [m, m + g) — `time_bucket` widths that are multiples of the grain,
 *    `date_trunc`/`date_part` at the grain or coarser, `ts::DATE`, comparisons `ts < c` /
 *    `ts >= c` with a grain-aligned literal c — so evaluating them on the cell start m (the
 *    rollup's time column, same name and type) gives the same value for every raw row.
 *    Dimensions are rollup keys, so every row predicate over dimensions and such expressions
 *    keeps or drops a cell's rows together.
 * 2. **Decomposable aggregates.** count(*) = Σ n, count(x) = Σ count_x, sum = Σ sum,
 *    min = min of mins, max = max of maxes, avg = Σ sum / Σ count. Duplicate-insensitive
 *    aggregates over dimensions/invariant expressions (min, max, count(DISTINCT …), bool_and,
 *    bool_or) are unchanged. Anything else (corr, arg_max, quantiles, aggregates of expressions,
 *    window functions, subqueries, joins, measure predicates in WHERE …) falls back to the raw
 *    table. Types are preserved (counts cast back to BIGINT, sums keep DuckDB's sum type).
 * 3. **Arbitrary time ranges.** Top-level WHERE bounds `ts >= lo`, `ts > lo`, `ts < hi`,
 *    `ts <= hi`, `ts BETWEEN lo AND hi` need not be aligned: whole cells inside the range come
 *    from the rollup, the partial cells at either edge are aggregated from raw rows on the fly
 *    (a zone-map-pruned scan of at most one cell per edge) into the same layout. The three
 *    parts are disjoint by construction (see `sourceSql`).
 *
 * Floating-point sums and averages are re-associated (Σ of per-cell sums), so they can differ
 * from the raw plan in the last bits — as any change of DuckDB's plan or thread count does. The
 * eval tolerance (1e-6 relative) covers this; ties between float aggregates in ORDER BY … LIMIT
 * could in principle resolve differently.
 */
import { quoteIdent } from './dataset';
import type { DatasetContext } from './contracts';
import { classify } from './dataset';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ast = any;

export const ROLLUP_SCHEMA = '__tb_rollup';
const N = '__tb_n';
const SOURCE = '__tb_source';
const AGG_A = '__tb_a', AGG_B = '__tb_b';
const ALIAS_PREFIX = '__tb_alias_';

/** Grain ranks: 1 minute, 2 hour, 3 day. A time expression's rank is the coarsest grain it is
 * invariant on (0 = not invariant even per minute). */
export interface Grain { rank: 1 | 2 | 3; name: 'minute' | 'hour' | 'day'; micros: number; interval: string }
export const GRAINS: Grain[] = [
  { rank: 1, name: 'minute', micros: 60e6, interval: "INTERVAL '1 minute'" },
  { rank: 2, name: 'hour', micros: 3600e6, interval: "INTERVAL '1 hour'" },
  { rank: 3, name: 'day', micros: 86400e6, interval: "INTERVAL '1 day'" },
];
/** With range bounds, edges are aggregated from raw rows: cap the grain so an edge is ≤ 1 hour. */
const MAX_RANK_WITH_BOUNDS = 2;
/** A range this small (estimated raw rows; two DuckDB row groups) is answered as fast by the
 * zone-map-pruned raw scan as by the minute rollup + edge scans; with the hour rollup the
 * crossover is ~8× lower (measured, docs/batch-2/database.md). */
export const SHORT_RANGE_ROWS = 2 * 122_880;

export interface Measure { name: string; type: string; nulls: boolean }
export interface RollupSpec {
  table: string;
  time: string;
  dims: string[];
  measures: Measure[];
  /** Raw rows and time range (epoch ms), from the dataset statistics: for the short-range rule. */
  rows?: number;
  start?: number;
  end?: number;
}
export interface BuiltGrain { grain: Grain; table: string; rows: number; ms: number }
export interface RollupTable { spec: RollupSpec; grains: BuiltGrain[] }

const MEASURE_TYPES = /^(TINYINT|SMALLINT|INTEGER|BIGINT|FLOAT|REAL|DOUBLE)$/;

// ───────────────────────── planning and building ─────────────────────────

/** Rollup candidates from the dataset context: tables with a TIMESTAMP column and ≥ 1 measure. */
export function rollupSpecs(context: DatasetContext): Array<RollupSpec & { rows: number; estimate: (g: Grain) => number }> {
  const out = [];
  for (const table of context.tables) {
    const time = table.columns.find(c => c.type.toUpperCase() === 'TIMESTAMP');
    if (!time || typeof time.min !== 'string' || typeof time.max !== 'string') continue;
    const dims = table.columns.filter(c => c !== time && (classify(c.type) === 'text' || classify(c.type) === 'boolean') && Array.isArray(c.values));
    const measures = table.columns.filter(c => MEASURE_TYPES.test(c.type.toUpperCase())).map(c => ({ name: c.name, type: c.type.toUpperCase(), nulls: true }));
    if (!measures.length) continue;
    const span = Math.max(0, parseTimestamp(time.max) - parseTimestamp(time.min));
    if (!Number.isFinite(span)) continue;
    const combos = dims.reduce((p, d) => p * ((d.values?.length ?? 1) + 1), 1);
    const estimate = (g: Grain) => Math.min(table.rows, (Math.floor(span * 1000 / g.micros) + 1) * combos);
    out.push({ table: table.name, time: time.name, dims: dims.map(d => d.name), measures, rows: table.rows, estimate,
      start: parseTimestamp(time.min), end: parseTimestamp(time.max) });
  }
  return out;
}

function parseTimestamp(text: string): number {
  return Date.parse(text.replace(' ', 'T') + (/[zZ+]/.test(text.slice(10)) ? '' : 'Z'));
}

export function rollupTableName(spec: RollupSpec, grain: Grain): string {
  return `${quoteIdent(ROLLUP_SCHEMA)}.${quoteIdent(`${spec.table}__${grain.name}`)}`;
}

const stateName = (m: string, kind: 'sum' | 'min' | 'max' | 'cnt') => `${m}__tb_${kind}`;

/** Columns of a rollup row, in order: time, dims, n, per measure sum/min/max[/cnt] — all of
 * them, or only the states in `needed`. Used for the rollup tables, the rollup part of a
 * rewritten query and the raw-edge aggregation, so UNION ALL lines up. */
function stateColumns(spec: RollupSpec, grain: Grain, from: 'raw' | 'rollup' | 'select', needed?: Set<string>): string[] {
  const t = quoteIdent(spec.time);
  const cols = [from === 'select' ? t : `time_bucket(${grain.interval}, ${t}) AS ${t}`, ...spec.dims.map(quoteIdent)];
  const state = (name: string, raw: string, rollup: string) => {
    if (needed && !needed.has(name)) return;
    cols.push(from === 'raw' ? `${raw} AS ${quoteIdent(name)}` : from === 'rollup' ? `${rollup} AS ${quoteIdent(name)}` : quoteIdent(name));
  };
  state(N, 'count(*)', `CAST(sum(${N}) AS BIGINT)`);
  for (const m of spec.measures) {
    const c = quoteIdent(m.name), q = (k: 'sum' | 'min' | 'max' | 'cnt') => quoteIdent(stateName(m.name, k));
    state(stateName(m.name, 'sum'), `sum(${c})`, `sum(${q('sum')})`);
    state(stateName(m.name, 'min'), `min(${c})`, `min(${q('min')})`);
    state(stateName(m.name, 'max'), `max(${c})`, `max(${q('max')})`);
    if (m.nulls) state(stateName(m.name, 'cnt'), `count(${c})`, `CAST(sum(${q('cnt')}) AS BIGINT)`);
  }
  return cols;
}

/** SQL that counts NULLs per measure (one pass; decides whether count columns are needed). */
export function nullCheckSql(spec: RollupSpec): string {
  return `SELECT ${spec.measures.map(m => `count(*) - count(${quoteIdent(m.name)})`).join(', ')} FROM ${quoteIdent(spec.table)}`;
}

/** CREATE TABLE for one grain, from the raw table or from a finer rollup. Ordered by time so the
 * rollup's zone maps prune range queries. */
export function buildSql(spec: RollupSpec, grain: Grain, from?: Grain): string {
  const source = from ? rollupTableName(spec, from) : quoteIdent(spec.table);
  return `CREATE TABLE ${rollupTableName(spec, grain)} AS SELECT ${stateColumns(spec, grain, from ? 'rollup' : 'raw').join(', ')} FROM ${source} GROUP BY ALL ORDER BY 1`;
}

// ───────────────────────── the FROM source ─────────────────────────

export type LowerOp = 'none' | '>=' | '>';
export type UpperOp = 'none' | '<' | '<=';

/**
 * The FROM source replacing the raw table, for one grain and bound shape (`lo`/`hi` are the
 * model's bound expressions, printed by DuckDB). With
 *   C1 = first cell start whose cell lies entirely above the lower bound
 *        (`>= lo`: ceil_g(lo) = bucket(lo − 1 µs) + g;  `> lo`: bucket(lo) + g)
 *   C2 = start of the cell containing the upper bound (bucket(hi))
 * the source is
 *   rollup cells with C1 ≤ m < C2                       (whole cells inside the range)
 *   ∪ raw rows matching the bounds with ts < C1          (lower edge, ≤ 1 cell)
 *   ∪ raw rows matching the bounds with ts ≥ max(C1, C2) (upper edge, ≤ 1 cell)
 * Every raw row in range lands in exactly one part: the rollup part covers [C1, C2), the edges
 * the rest, and each rollup cell in [C1, C2) satisfies both bounds at every instant in it. The
 * edge filters fold to constants, so zone maps prune the raw scans. Only the states the query
 * needs are read or computed.
 */
export function sourceSql(spec: RollupSpec, grain: Grain, lower: LowerOp, upper: UpperOp, lo: string | undefined, hi: string | undefined, needed: Set<string>): string {
  const t = quoteIdent(spec.time), g = grain.interval, rollup = rollupTableName(spec, grain);
  const c1 = lower === '>=' ? `(time_bucket(${g}, CAST(${lo} AS TIMESTAMP) - INTERVAL '1 microsecond') + ${g})`
    : lower === '>' ? `(time_bucket(${g}, CAST(${lo} AS TIMESTAMP)) + ${g})` : undefined;
  const c2 = upper !== 'none' ? `time_bucket(${g}, CAST(${hi} AS TIMESTAMP))` : undefined;
  const rollupWhere = [c1 && `${t} >= ${c1}`, c2 && `${t} < ${c2}`].filter(Boolean);
  const parts = [`SELECT ${stateColumns(spec, grain, 'select', needed).join(', ')} FROM ${rollup}${rollupWhere.length ? ` WHERE ${rollupWhere.join(' AND ')}` : ''}`];
  const bounds = [lower !== 'none' && `${t} ${lower} ${lo}`, upper !== 'none' && `${t} ${upper} ${hi}`].filter(Boolean);
  const edge = (cond: string) => `SELECT ${stateColumns(spec, grain, 'raw', needed).join(', ')} FROM ${quoteIdent(spec.table)} WHERE ${[...bounds, cond].join(' AND ')} GROUP BY ALL`;
  if (c1) parts.push(edge(`${t} < ${c1}`));
  if (c2) parts.push(edge(`${t} >= ${c1 ? `greatest(${c1}, ${c2})` : c2}`));
  return parts.length === 1 ? parts[0] : parts.map(p => `(${p})`).join(' UNION ALL ');
}

/** Aggregate templates, serialized once: select_list[i] is the replacement shape. */
export const AGG_TEMPLATE_SQL = `SELECT CAST(coalesce(sum(${AGG_A}), 0) AS BIGINT), sum(${AGG_A}) / sum(${AGG_B}), min(${AGG_A}), max(${AGG_A}), sum(${AGG_A})`;
const enum AggT { COUNT = 0, AVG = 1, MIN = 2, MAX = 3, SUM = 4 }

// ───────────────────────── the rewrite ─────────────────────────

export interface Catalog {
  /** Lower-case names of aggregate functions (from duckdb_functions()). */
  aggregates: Set<string>;
  /** Lower-case names of functions that must not be rewritten: volatile, macros. */
  forbidden: Set<string>;
}

export interface RewriteInput {
  /** The parsed statement (json_serialize_sql output, already JSON.parse'd). */
  parsed: Ast;
  rollups: RollupTable[];
  catalog: Catalog;
  /** Serialized templates, keyed by template SQL. */
  template(sql: string): Ast;
  /** Ranges with fewer estimated raw rows run on the raw table (default SHORT_RANGE_ROWS). */
  shortRangeRows?: number;
}

export type RewritePlan =
  | {
    ok: true; statement: Ast; names: Ast[]; grain: Grain; table: string; edges: boolean; spec: RollupSpec; needed: Set<string>;
    lower?: { op: LowerOp; expr: Ast }; upper?: { op: UpperOp; expr: Ast };
  }
  | { ok: false; reason: string };

class Reject extends Error {}
const reject = (reason: string): never => { throw new Reject(reason); };

const PART_RANK: Record<string, number> = {};
for (const p of ['minute', 'minutes', 'min', 'mins']) PART_RANK[p] = 1;
for (const p of ['hour', 'hours', 'hr', 'hrs']) PART_RANK[p] = 2;
for (const p of ['day', 'days', 'dayofmonth', 'dow', 'dayofweek', 'weekday', 'isodow', 'doy', 'dayofyear', 'week', 'weeks',
  'weekofyear', 'yearweek', 'month', 'months', 'mon', 'quarter', 'quarters', 'year', 'years', 'yr', 'yrs', 'isoyear',
  'decade', 'decades', 'century', 'centuries', 'millennium', 'millennia', 'era']) PART_RANK[p] = 3;
/** date_trunc accepts fewer parts than date_part. */
const TRUNC_PARTS = new Set(['minute', 'minutes', 'min', 'mins', 'hour', 'hours', 'hr', 'hrs', 'day', 'days', 'week', 'weeks',
  'month', 'months', 'mon', 'quarter', 'quarters', 'year', 'years', 'yr', 'yrs', 'isoyear', 'decade', 'decades', 'century', 'centuries', 'millennium', 'millennia']);
/** One-argument time functions and the part they extract. */
const SHORTHAND: Record<string, number> = {
  minute: 1, hour: 2, year: 3, month: 3, day: 3, dayofmonth: 3, dayofweek: 3, dayofyear: 3, isodow: 3, isoyear: 3,
  week: 3, weekofyear: 3, weekday: 3, yearweek: 3, quarter: 3, dayname: 3, monthname: 3, last_day: 3, decade: 3,
  century: 3, millennium: 3, era: 3,
};
const INTERVAL_UNITS: Record<string, { micros?: number; days?: number; months?: number }> = {};
for (const u of ['second', 'seconds', 'sec', 'secs']) INTERVAL_UNITS[u] = { micros: 1e6 };
for (const u of ['minute', 'minutes', 'min', 'mins']) INTERVAL_UNITS[u] = { micros: 60e6 };
for (const u of ['hour', 'hours', 'hr', 'hrs']) INTERVAL_UNITS[u] = { micros: 3600e6 };
for (const u of ['day', 'days']) INTERVAL_UNITS[u] = { days: 1 };
for (const u of ['week', 'weeks']) INTERVAL_UNITS[u] = { days: 7 };
for (const u of ['month', 'months', 'mon', 'mons']) INTERVAL_UNITS[u] = { months: 1 };
for (const u of ['year', 'years', 'yr', 'yrs']) INTERVAL_UNITS[u] = { months: 12 };
const TO_INTERVAL: Record<string, { micros?: number; days?: number; months?: number }> = {
  to_seconds: { micros: 1e6 }, to_minutes: { micros: 60e6 }, to_hours: { micros: 3600e6 }, to_days: { days: 1 },
  to_weeks: { days: 7 }, to_months: { months: 1 }, to_years: { months: 12 },
};
const DECOMPOSABLE = new Set(['count_star', 'count', 'sum', 'avg', 'mean', 'min', 'max']);
const DUPLICATE_INSENSITIVE = new Set(['min', 'max', 'bool_and', 'bool_or']);

const lower = (s: unknown) => String(s).toLowerCase();
const isConst = (e: Ast) => e?.class === 'CONSTANT';
const isVarchar = (e: Ast) => isConst(e) && e.value?.type?.id === 'VARCHAR' && !e.value.is_null;

/** Interval literal → rank of the coarsest grain its time_bucket boundaries align to. */
function intervalRank(e: Ast): number {
  let micros = 0, days = 0, months = 0;
  if (e?.class === 'CAST' && e.cast_type?.id === 'INTERVAL' && isVarchar(e.child)) {
    const text = lower(e.child.value.value).trim();
    const re = /(\d+)\s*([a-z]+)/g;
    let m: RegExpExecArray | null, consumed = '';
    while ((m = re.exec(text))) {
      const unit = INTERVAL_UNITS[m[2]];
      if (!unit) return 0;
      const n = Number(m[1]);
      micros += n * (unit.micros ?? 0); days += n * (unit.days ?? 0); months += n * (unit.months ?? 0);
      consumed += m[0];
    }
    if (consumed.replace(/\s+/g, '') !== text.replace(/\s+/g, '')) return 0;
  } else if (e?.class === 'FUNCTION' && TO_INTERVAL[lower(e.function_name)] && e.children?.length === 1) {
    const n = integerConstant(e.children[0]);
    if (n === undefined) return 0;
    const unit = TO_INTERVAL[lower(e.function_name)];
    micros = n * (unit.micros ?? 0); days = n * (unit.days ?? 0); months = n * (unit.months ?? 0);
  } else return 0;
  if (micros < 0 || days < 0 || months < 0 || micros + days + months === 0) return 0;
  if (months) return micros === 0 && days === 0 ? 3 : 0;
  const total = days * 86400e6 + micros;
  for (const g of [...GRAINS].reverse()) if (total % g.micros === 0) return g.rank;
  return 0;
}

/** A non-negative integer constant, possibly under the casts/trunc DuckDB wraps around `INTERVAL n HOUR`. */
function integerConstant(e: Ast): number | undefined {
  while (e && (e.class === 'CAST' || (e.class === 'FUNCTION' && lower(e.function_name) === 'trunc' && e.children?.length === 1))) e = e.class === 'CAST' ? e.child : e.children[0];
  if (!isConst(e) || e.value?.is_null) return undefined;
  const v = Number(e.value.value);
  return Number.isInteger(v) && v >= 0 && /^(INTEGER|BIGINT|SMALLINT|TINYINT|UINTEGER|UBIGINT|HUGEINT)$/.test(e.value.type?.id) ? v : undefined;
}

/** A timestamp literal ('YYYY-MM-DD[ HH:MM[:SS[.f]]]', bare or cast to TIMESTAMP/DATE) → the
 * coarsest grain rank it is aligned to, or undefined if it is not such a literal. */
function literalRank(e: Ast): number | undefined {
  let text: string;
  if (isVarchar(e)) text = e.value.value;
  else if (e?.class === 'CAST' && (e.cast_type?.id === 'TIMESTAMP' || e.cast_type?.id === 'DATE') && !e.try_cast && isVarchar(e.child)) text = e.child.value.value;
  else return undefined;
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?\s*$/.exec(text);
  if (!m) return undefined;
  if (e.class === 'CAST' && e.cast_type.id === 'DATE' && m[4] !== undefined) return undefined;
  if (Number(m[6] ?? 0) || Number(m[7] ?? 0)) return 0;
  if (Number(m[5] ?? 0)) return 1;
  if (Number(m[4] ?? 0)) return 2;
  return 3;
}

/** Unqualified or `main.`-qualified (how DuckDB serializes `extract(…)`): a built-in function. */
function builtinSchema(e: Ast): boolean {
  return (!e.schema || lower(e.schema) === 'main') && !e.catalog;
}

/** strftime format → the coarsest grain on which the formatted text is constant. */
const STRFTIME_RANK: Record<string, number> = {};
for (const c of 'aAwudbBmyYjUWVG') STRFTIME_RANK[c] = 3;
for (const c of 'HIp') STRFTIME_RANK[c] = 2;
STRFTIME_RANK.M = 1;
STRFTIME_RANK['%'] = Infinity;
function strftimeRank(format: string): number {
  let rank = Infinity;
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== '%') continue;
    let c = format[++i];
    if (c === '-') c = format[++i];
    const r = c === undefined ? undefined : STRFTIME_RANK[c];
    if (r === undefined) return 0;
    rank = Math.min(rank, r);
  }
  return rank === Infinity ? 3 : rank;
}

/** Bound expressions we can prove are TIMESTAMP/DATE (or a string literal compared as one):
 * literals, `literal ± interval`, `date_trunc(part, bound)`. */
function isBoundExpr(e: Ast, top = true): boolean {
  if (top && isVarchar(e)) return literalRank(e) !== undefined;
  if (e?.class === 'CAST' && (e.cast_type?.id === 'TIMESTAMP' || e.cast_type?.id === 'DATE') && !e.try_cast) return isVarchar(e.child) && literalRank(e) !== undefined;
  if (e?.class !== 'FUNCTION' || e.filter || e.distinct || !builtinSchema(e) || e.order_bys?.orders?.length) return false;
  const name = lower(e.function_name);
  if ((name === '+' || name === '-') && e.children?.length === 2) {
    const [a, b] = e.children;
    if (isBoundExpr(a, false) && intervalLike(b)) return true;
    return name === '+' && intervalLike(a) && isBoundExpr(b, false);
  }
  if ((name === 'date_trunc' || name === 'datetrunc') && e.children?.length === 2) {
    return isVarchar(e.children[0]) && TRUNC_PARTS.has(lower(e.children[0].value.value)) && isBoundExpr(e.children[1], false);
  }
  return false;
}
function intervalLike(e: Ast): boolean {
  if (e?.class === 'CAST' && e.cast_type?.id === 'INTERVAL') return isVarchar(e.child);
  return e?.class === 'FUNCTION' && !!TO_INTERVAL[lower(e.function_name)] && e.children?.length === 1 && integerConstant(e.children[0]) !== undefined;
}

/** Value of a bound expression (see isBoundExpr) in epoch ms, UTC wall clock; undefined if
 * unknown. Only used to estimate a range's size (a performance heuristic, not for exactness). */
function evalBound(e: Ast): number | undefined {
  if (isVarchar(e) || (e?.class === 'CAST' && isVarchar(e.child))) {
    const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?\s*$/.exec(isVarchar(e) ? e.value.value : e.child.value.value);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : undefined;
  }
  if (e?.class !== 'FUNCTION') return undefined;
  const name = lower(e.function_name), [a, b] = e.children ?? [];
  if ((name === '+' || name === '-') && e.children.length === 2) {
    const base = evalBound(intervalLike(a) ? b : a), iv = intervalValue(intervalLike(a) ? a : b);
    if (base === undefined || !iv) return undefined;
    const sign = name === '-' ? -1 : 1, d = new Date(base);
    d.setUTCMonth(d.getUTCMonth() + sign * iv.months);
    return d.getTime() + sign * (iv.days * 86_400_000 + iv.micros / 1000);
  }
  if ((name === 'date_trunc' || name === 'datetrunc') && isVarchar(a)) {
    const v = evalBound(b), part = PART_RANK[lower(a.value.value)];
    if (v === undefined || part === undefined) return undefined;
    const unit = part === 1 ? 60_000 : part === 2 ? 3_600_000 : 86_400_000;
    return Math.floor(v / unit) * unit; // week/month/year truncate further; a day is a close enough estimate
  }
  return undefined;
}

function intervalValue(e: Ast): { micros: number; days: number; months: number } | undefined {
  let micros = 0, days = 0, months = 0;
  if (e?.class === 'CAST' && isVarchar(e.child)) {
    const text = lower(e.child.value.value);
    for (const m of text.matchAll(/(\d+)\s*([a-z]+)/g)) {
      const unit = INTERVAL_UNITS[m[2]];
      if (!unit) return undefined;
      micros += +m[1] * (unit.micros ?? 0); days += +m[1] * (unit.days ?? 0); months += +m[1] * (unit.months ?? 0);
    }
    return { micros, days, months };
  }
  const unit = e?.class === 'FUNCTION' ? TO_INTERVAL[lower(e.function_name)] : undefined;
  const n = unit ? integerConstant(e.children?.[0]) : undefined;
  return unit && n !== undefined ? { micros: n * (unit.micros ?? 0), days: n * (unit.days ?? 0), months: n * (unit.months ?? 0) } : undefined;
}

const COMPARE_FLIP: Record<string, string> = {
  COMPARE_LESSTHAN: 'COMPARE_GREATERTHAN', COMPARE_GREATERTHAN: 'COMPARE_LESSTHAN',
  COMPARE_LESSTHANOREQUALTO: 'COMPARE_GREATERTHANOREQUALTO', COMPARE_GREATERTHANOREQUALTO: 'COMPARE_LESSTHANOREQUALTO',
};

interface Ctx {
  spec: RollupSpec;
  qualifier: string;           // alias or table name, lower case
  dims: Set<string>;
  measures: Map<string, Measure>;
  time: string;
  aliases: Set<string>;        // select-list aliases, lower case
  catalog: Catalog;
  rank: number;                // min invariant rank seen (Infinity = no time use)
  aggregates: number;
  /** Rollup state columns the rewritten aggregates read. */
  needed: Set<string>;
  template(sql: string): Ast;
}

type Scope = 'row' | 'group' | 'order' | 'having' | 'groupby';

/** Column reference → lower-case column name, or undefined for names that are not table columns. */
function columnOf(e: Ast, ctx: Ctx): string | undefined {
  const names: string[] = e.column_names;
  if (!Array.isArray(names) || names.length === 0 || names.length > 2) reject('column reference shape');
  if (names.length === 2 && lower(names[0]) !== ctx.qualifier) reject('qualified column of another relation');
  const name = lower(names[names.length - 1]);
  if (name === ctx.time || ctx.dims.has(name) || ctx.measures.has(name)) return name;
  return undefined;
}

function isTimeRef(e: Ast, ctx: Ctx): boolean {
  return e?.class === 'COLUMN_REF' && columnOf(e, ctx) === ctx.time;
}

function noteRank(ctx: Ctx, rank: number): void {
  if (rank < 1) reject('time expression finer than a minute');
  ctx.rank = Math.min(ctx.rank, rank);
}

/** Returns the (possibly rewritten) expression. Throws Reject for anything outside the subset. */
function visit(e: Ast, ctx: Ctx, scope: Scope): Ast {
  if (e === null || e === undefined) return e;
  switch (e.class) {
    case 'CONSTANT': return e;
    case 'COLUMN_REF': {
      const name = columnOf(e, ctx);
      const bare = e.column_names.length === 1;
      if (bare && scope === 'order' && ctx.aliases.has(lower(e.column_names[0]))) return e; // ORDER BY binds aliases first
      if (name === undefined) {
        // Not a table column: a select-list alias (lateral, GROUP BY, HAVING, ORDER BY); same in both plans.
        if (bare && ctx.aliases.has(lower(e.column_names[0]))) return e;
        return reject(`unknown column ${e.column_names.join('.')}`);
      }
      if (bare && scope === 'having' && ctx.aliases.has(name) && !ctx.dims.has(name)) reject('HAVING name is both alias and column');
      if (ctx.dims.has(name)) return e;
      if (name === ctx.time) return reject('time column outside an invariant expression');
      return reject(`measure ${name} outside an aggregate`);
    }
    case 'CAST': {
      if (isTimeRef(e.child, ctx)) {
        if (e.cast_type?.id === 'DATE' && !e.try_cast) { noteRank(ctx, 3); return e; }
        return reject('cast of the time column');
      }
      return { ...e, child: visit(e.child, ctx, scope) };
    }
    case 'COMPARISON': {
      const timeLeft = isTimeRef(e.left, ctx), timeRight = isTimeRef(e.right, ctx);
      if (timeLeft || timeRight) {
        const type = timeLeft ? e.type : COMPARE_FLIP[e.type];
        const other = timeLeft ? e.right : e.left;
        const rank = literalRank(other);
        if (rank === undefined || (type !== 'COMPARE_LESSTHAN' && type !== 'COMPARE_GREATERTHANOREQUALTO')) return reject('time comparison that splits a grain cell');
        noteRank(ctx, rank);
        return e;
      }
      return { ...e, left: visit(e.left, ctx, scope), right: visit(e.right, ctx, scope) };
    }
    case 'CONJUNCTION':
    case 'OPERATOR': {
      if (e.class === 'OPERATOR' && !/^(OPERATOR_NOT|OPERATOR_IS_NULL|OPERATOR_IS_NOT_NULL|COMPARE_IN|COMPARE_NOT_IN|OPERATOR_COALESCE|OPERATOR_NULLIF)$/.test(e.type)) return reject(`operator ${e.type}`);
      return { ...e, children: e.children.map((c: Ast) => visit(c, ctx, scope)) };
    }
    case 'CASE':
      return {
        ...e,
        case_checks: e.case_checks.map((c: Ast) => ({ when_expr: visit(c.when_expr, ctx, scope), then_expr: visit(c.then_expr, ctx, scope) })),
        else_expr: visit(e.else_expr, ctx, scope),
      };
    case 'BETWEEN':
      return { ...e, input: visit(e.input, ctx, scope), lower: visit(e.lower, ctx, scope), upper: visit(e.upper, ctx, scope) };
    case 'FUNCTION': return visitFunction(e, ctx, scope);
    default: return reject(`expression class ${e.class}`);
  }
}

function visitFunction(e: Ast, ctx: Ctx, scope: Scope): Ast {
  const name = lower(e.function_name);
  if (!builtinSchema(e)) reject('qualified function');
  if (e.export_state) reject('export_state');
  if (ctx.catalog.aggregates.has(name) || name === 'count_star') {
    if (scope === 'row' || scope === 'groupby') reject('aggregate in a row context');
    return visitAggregate(e, ctx);
  }
  if (ctx.catalog.forbidden.has(name)) reject(`function ${name}`);
  if (e.filter || e.distinct || e.order_bys?.orders?.length) reject('modifiers on a scalar function');
  const args: Ast[] = e.children ?? [];
  const timeArg = args.findIndex(a => isTimeRef(a, ctx));
  if (timeArg >= 0) {
    const constPart = () => isVarchar(args[0]) ? lower(args[0].value.value) : reject('non-constant date part');
    if ((name === 'time_bucket') && args.length === 2 && timeArg === 1) noteRank(ctx, intervalRank(args[0]));
    else if ((name === 'date_trunc' || name === 'datetrunc') && args.length === 2 && timeArg === 1) {
      const part = constPart();
      noteRank(ctx, TRUNC_PARTS.has(part) ? PART_RANK[part] ?? 0 : 0);
    } else if ((name === 'date_part' || name === 'datepart' || name === 'extract') && args.length === 2 && timeArg === 1) noteRank(ctx, PART_RANK[constPart()] ?? 0);
    else if (SHORTHAND[name] !== undefined && args.length === 1) noteRank(ctx, SHORTHAND[name]);
    else if (name === 'strftime' && args.length === 2 && isVarchar(args[1 - timeArg])) noteRank(ctx, strftimeRank(String(args[1 - timeArg].value.value)));
    else reject(`time column inside ${name}()`);
    return e;
  }
  return { ...e, children: args.map(a => visit(a, ctx, scope)) };
}

function visitAggregate(e: Ast, ctx: Ctx): Ast {
  const name = lower(e.function_name);
  const args: Ast[] = e.children ?? [];
  if (e.order_bys?.orders?.length) reject('ordered aggregate');
  const filter = e.filter ? visit(e.filter, ctx, 'row') : null;
  ctx.aggregates++;
  const measureArg = args.length === 1 && args[0].class === 'COLUMN_REF' ? columnOf(args[0], ctx) : undefined;
  const measure = measureArg !== undefined ? ctx.measures.get(measureArg) : undefined;
  if (measure && DECOMPOSABLE.has(name)) {
    if (e.distinct && name !== 'min' && name !== 'max') reject('DISTINCT aggregate of a measure');
    const kind = name === 'count' ? 'count' : name === 'mean' ? 'avg' : name;
    const count = measure.nulls ? stateName(measure.name, 'cnt') : N;
    const [t, a, b] = kind === 'count' ? [AggT.COUNT, count, '']
      : kind === 'avg' ? [AggT.AVG, stateName(measure.name, 'sum'), count]
      : kind === 'sum' ? [AggT.SUM, stateName(measure.name, 'sum'), '']
      : kind === 'min' ? [AggT.MIN, stateName(measure.name, 'min'), '']
      : [AggT.MAX, stateName(measure.name, 'max'), ''];
    return aggregateFromTemplate(ctx, t, a, b, filter, e.alias);
  }
  if (name === 'count_star' && args.length === 0) {
    if (e.distinct) reject('count(DISTINCT *)');
    return aggregateFromTemplate(ctx, AggT.COUNT, N, '', filter, e.alias);
  }
  // Duplicate-insensitive aggregates over dimensions / invariant time expressions are unchanged.
  if (args.length === 1 && (DUPLICATE_INSENSITIVE.has(name) || (name === 'count' && e.distinct))) {
    return { ...e, children: [visit(args[0], ctx, 'row')], filter };
  }
  return reject(`aggregate ${name}`);
}

function aggregateFromTemplate(ctx: Ctx, which: AggT, a: string, b: string, filter: Ast, alias: string): Ast {
  ctx.needed.add(a);
  if (b) ctx.needed.add(b);
  const node = structuredClone(ctx.template(AGG_TEMPLATE_SQL).statements[0].node.select_list[which]);
  walk(node, n => {
    if (n.class === 'COLUMN_REF' && n.column_names.length === 1) {
      if (n.column_names[0] === AGG_A) n.column_names = [a];
      else if (n.column_names[0] === AGG_B) n.column_names = [b];
    }
    if (n.class === 'FUNCTION' && ['sum', 'min', 'max'].includes(n.function_name) && filter) n.filter = structuredClone(filter);
  });
  node.alias = alias ?? '';
  return node;
}

function walk(n: Ast, fn: (n: Ast) => void): void {
  if (Array.isArray(n)) { for (const x of n) walk(x, fn); return; }
  if (!n || typeof n !== 'object') return;
  if (typeof n.class === 'string') fn(n);
  for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v, fn);
}

interface Bound { op: string; expr: Ast }

/** Top-level WHERE term → a range bound on the time column, or undefined. */
function asBounds(term: Ast, ctx: Ctx): Bound[] | undefined {
  if (term.class === 'COMPARISON') {
    const timeLeft = isTimeRef(term.left, ctx), timeRight = isTimeRef(term.right, ctx);
    if (timeLeft === timeRight) return undefined;
    const type = timeLeft ? term.type : COMPARE_FLIP[term.type];
    const expr = timeLeft ? term.right : term.left;
    const op = { COMPARE_GREATERTHANOREQUALTO: '>=', COMPARE_GREATERTHAN: '>', COMPARE_LESSTHAN: '<', COMPARE_LESSTHANOREQUALTO: '<=' }[type as string];
    if (!op || !isBoundExpr(expr)) return undefined;
    // `ts >= c` / `ts < c` with a grain-aligned literal c is a plain invariant predicate (no edges).
    if ((op === '>=' || op === '<') && (literalRank(expr) ?? 0) >= 1) return undefined;
    return [{ op, expr }];
  }
  if (term.class === 'BETWEEN' && isTimeRef(term.input, ctx) && isBoundExpr(term.lower) && isBoundExpr(term.upper)) {
    return [{ op: '>=', expr: term.lower }, { op: '<=', expr: term.upper }];
  }
  return undefined;
}

function conjuncts(e: Ast): Ast[] {
  if (e?.class === 'CONJUNCTION' && e.type === 'CONJUNCTION_AND') return e.children.flatMap(conjuncts);
  return e ? [e] : [];
}

function andOf(terms: Ast[], like: Ast): Ast {
  if (terms.length === 0) return null;
  if (terms.length === 1) return terms[0];
  return { ...like, class: 'CONJUNCTION', type: 'CONJUNCTION_AND', alias: '', children: terms };
}

/** Plan the rewrite of one parsed statement. Pure: DuckDB calls are done by the caller. */
export function planRewrite(input: RewriteInput): RewritePlan {
  try {
    return plan(input);
  } catch (error) {
    if (error instanceof Reject) return { ok: false, reason: error.message };
    return { ok: false, reason: `internal: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function plan({ parsed, rollups, catalog, template, shortRangeRows = SHORT_RANGE_ROWS }: RewriteInput): RewritePlan {
  if (parsed?.error) reject('parse error');
  if (parsed.statements?.length !== 1) reject('not one statement');
  const statement = structuredClone(parsed.statements[0]);
  const node = statement.node;
  if (node?.type !== 'SELECT_NODE') reject(`query node ${node?.type}`);
  if (node.cte_map?.map?.length) reject('CTE');
  if (node.qualify || node.sample) reject('QUALIFY/SAMPLE');
  const from = node.from_table;
  if (from?.type !== 'BASE_TABLE' || from.sample || from.at_clause || from.column_name_alias?.length) reject('FROM is not a plain table');
  if (from.catalog_name || (from.schema_name && lower(from.schema_name) !== 'main')) reject('qualified table');
  const rollup = rollups.find(r => lower(r.spec.table) === lower(from.table_name));
  if (!rollup || rollup.grains.length === 0) reject('no rollup for this table');
  const spec = rollup!.spec;
  if (node.group_sets?.length > 1) reject('grouping sets');

  const ctx: Ctx = {
    spec, qualifier: lower(from.alias || from.table_name), dims: new Set(spec.dims.map(lower)),
    measures: new Map(spec.measures.map(m => [lower(m.name), m])), time: lower(spec.time),
    aliases: new Set(node.select_list.map((s: Ast) => s.alias).filter(Boolean).map(lower)), catalog, rank: Infinity, aggregates: 0, needed: new Set(), template,
  };

  // WHERE: peel off top-level time bounds, everything else must be a row predicate.
  const bounds: Bound[] = [];
  const rest: Ast[] = [];
  for (const term of conjuncts(node.where_clause)) {
    const b = asBounds(term, ctx);
    if (b) bounds.push(...b); else rest.push(visit(term, ctx, 'row'));
  }
  const lowerBounds = bounds.filter(b => b.op === '>=' || b.op === '>');
  const upperBounds = bounds.filter(b => b.op === '<' || b.op === '<=');
  if (lowerBounds.length > 1 || upperBounds.length > 1) reject('several bounds on one side');

  node.select_list = node.select_list.map((s: Ast) => {
    if (s.class === 'STAR') reject('SELECT *');
    return visit(s, ctx, 'group');
  });
  node.group_expressions = (node.group_expressions ?? []).map((g: Ast) => visit(g, ctx, 'groupby'));
  node.having = node.having ? visit(node.having, ctx, 'having') : null;
  for (const modifier of node.modifiers ?? []) {
    if (modifier.type === 'ORDER_MODIFIER') modifier.orders = modifier.orders.map((o: Ast) => ({ ...o, expression: visit(o.expression, ctx, 'order') }));
    else if (modifier.type === 'LIMIT_MODIFIER' || modifier.type === 'LIMIT_PERCENT_MODIFIER') {
      for (const k of ['limit', 'offset']) if (modifier[k] && !isConst(modifier[k])) reject('non-constant LIMIT/OFFSET');
    } else if (modifier.type === 'DISTINCT_MODIFIER') {
      modifier.distinct_on_targets = (modifier.distinct_on_targets ?? []).map((d: Ast) => visit(d, ctx, 'order'));
    } else reject(`modifier ${modifier.type}`);
  }
  const aggregating = ctx.aggregates > 0 || node.group_expressions.length > 0 || node.aggregate_handling === 'FORCE_AGGREGATES';
  if (!aggregating) reject('not an aggregate query');
  if (node.aggregate_handling !== 'STANDARD_HANDLING' && node.aggregate_handling !== 'FORCE_AGGREGATES') reject(`aggregate handling ${node.aggregate_handling}`);

  const lo = lowerBounds[0], hi = upperBounds[0];
  const edges = !!(lo || hi);
  const maxRank = Math.min(ctx.rank, edges ? MAX_RANK_WITH_BOUNDS : 3);
  const built = [...rollup!.grains].sort((a, b) => b.grain.rank - a.grain.rank).find(g => g.grain.rank <= maxRank);
  if (!built) reject(`no rollup grain fine enough (rank ${ctx.rank})`);
  const grain = built!.grain;
  if (edges && spec.rows && spec.start !== undefined && spec.end !== undefined && spec.end > spec.start) {
    const from = lo ? evalBound(lo.expr) : spec.start, to = hi ? evalBound(hi.expr) : spec.end;
    if (from !== undefined && to !== undefined) {
      const rows = spec.rows * Math.max(0, Math.min(to, spec.end) - Math.max(from, spec.start)) / (spec.end - spec.start);
      if (rows < shortRangeRows * (grain.rank === 1 ? 1 : 1 / 8)) reject('short range: the raw scan is as fast');
    }
  }

  // The new FROM: a placeholder table, replaced by the source SQL after printing.
  node.from_table = { ...from, table_name: SOURCE, schema_name: '', catalog_name: '', alias: from.alias || from.table_name };
  node.where_clause = andOf(rest, node.where_clause);

  // Unaliased select items whose text changed need their original name as an alias.
  const names: Ast[] = [];
  node.select_list.forEach((s: Ast, i: number) => {
    const original = parsed.statements[0].node.select_list[i];
    if (!original.alias && JSON.stringify(s) !== JSON.stringify(original)) {
      s.alias = `${ALIAS_PREFIX}${names.length}`;
      names.push(original);
    }
  });
  return {
    ok: true, statement, names, grain, table: spec.table, edges, spec, needed: ctx.needed,
    lower: lo ? { op: lo.op as LowerOp, expr: lo.expr } : undefined, upper: hi ? { op: hi.op as UpperOp, expr: hi.expr } : undefined,
  };
}

/** Statements to print with json_deserialize_sql: the rewritten statement, then `SELECT <expr>`
 * for the lower bound, the upper bound (when present) and each renamed select item. */
export function printJobs(plan: Extract<RewritePlan, { ok: true }>, parsed: Ast, emptyFrom: Ast): string[] {
  const wrap = (statement: Ast) => JSON.stringify({ error: false, statements: [statement] });
  const single = (expr: Ast) => {
    const s = structuredClone(parsed.statements[0]);
    s.node = { ...s.node, select_list: [{ ...expr, alias: '' }], from_table: emptyFrom, where_clause: null, group_expressions: [], group_sets: [],
      having: null, modifiers: [], aggregate_handling: 'STANDARD_HANDLING', qualify: null, sample: null };
    return wrap(s);
  };
  return [wrap(plan.statement), ...[plan.lower, plan.upper].filter(Boolean).map(b => single(b!.expr)), ...plan.names.map(single)];
}

/** Assemble the final SQL from the printed statements (same order as `printJobs`): splice in
 * the FROM source and put the original output names back (`__tb_alias_i` → the original
 * item's text: DuckDB names an unaliased column by its expression text). */
export function finishSql(plan: Extract<RewritePlan, { ok: true }>, printed: string[]): string {
  const text = (i: number) => printed[i].replace(/^SELECT\s+/i, '');
  let k = 1;
  const lo = plan.lower ? `(${text(k++)})` : undefined;
  const hi = plan.upper ? `(${text(k++)})` : undefined;
  let sql = printed[0];
  for (let i = 0; k < printed.length; i++, k++) {
    sql = sql.replace(new RegExp(`"?${ALIAS_PREFIX}${i}"?(?![0-9])`, 'g'), quoteIdent(text(k)));
  }
  const source = sourceSql(plan.spec, plan.grain, plan.lower?.op ?? 'none', plan.upper?.op ?? 'none', lo, hi, plan.needed);
  const placeholder = new RegExp(`"?${SOURCE}"?`, 'g');
  if ((sql.match(placeholder) ?? []).length !== 1) throw new Error('source placeholder not printed exactly once');
  return sql.replace(placeholder, () => `(${source})`);
}

/** Cheap pre-check before parsing: only SQL that names a rolled-up table and does not use our
 * reserved prefix can be rewritten. */
export function mayRewrite(sql: string, rollups: RollupTable[]): boolean {
  const text = sql.toLowerCase();
  if (text.includes('__tb_')) return false;
  return rollups.some(r => r.grains.length > 0 && text.includes(r.spec.table.toLowerCase()));
}
