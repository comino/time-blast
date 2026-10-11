/** Table preview rows and CSV export. Boring, cold-path JS: per-cell formatting only for the
 * first rows (table) or on explicit user export. Times are exact UTC from the raw int64. */
import { makeVector, Type, type Data, type RecordBatch, type Schema } from 'apache-arrow';

export const TABLE_ROWS = 50;

const pad = (n: number | bigint, width = 2) => String(n).padStart(width, '0');

/** µs since epoch (BigInt) → `YYYY-MM-DD HH:MM:SS[.ffffff]` UTC; midnight-only dates stay short. */
export function formatMicros(us: bigint): string {
  const ms = us / 1000n - (us % 1000n < 0n ? 1n : 0n);
  const date = new Date(Number(ms));
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const sub = ((us % 1_000_000n) + 1_000_000n) % 1_000_000n;
  const inDay = date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds();
  if (!inDay && !sub) return day;
  const time = `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  if (!sub) return time;
  return sub % 1000n ? `${time}.${pad(sub, 6)}` : `${time}.${pad(sub / 1000n, 3)}`;
}

function valid(data: Data, i: number): boolean {
  const bitmap = data.nullBitmap as Uint8Array | undefined;
  if (!bitmap || !bitmap.byteLength || data.nullCount === 0) return true;
  const bit = data.offset + i;
  return (bitmap[bit >> 3] >> (bit & 7) & 1) === 1;
}

function decimal(words: Uint32Array, at: number, scale: number, width: number): string {
  let v = 0n;
  for (let k = width - 1; k >= 0; k--) v = (v << 32n) | BigInt(words[at + k]);
  if (v >> BigInt(width * 32 - 1)) v -= 1n << BigInt(width * 32);
  if (!scale) return v.toString();
  const neg = v < 0n, abs = (neg ? -v : v).toString().padStart(scale + 1, '0');
  return `${neg ? '-' : ''}${abs.slice(0, -scale)}.${abs.slice(-scale)}`;
}

/** Format row `i` of column data, or null for SQL NULL. `digits` limits float significant
 * digits (table preview); exports keep full precision. */
export function cell(data: Data, i: number, digits?: number): string | null {
  if (!valid(data, i)) return null;
  const t = data.type as any;
  const values = data.values as any;
  switch (data.type.typeId) {
    case Type.Timestamp: {
      const raw = BigInt(values[i]);
      const us = t.unit === 0 ? raw * 1_000_000n : t.unit === 1 ? raw * 1000n : t.unit === 2 ? raw : raw / 1000n;
      return formatMicros(us);
    }
    case Type.Date:
      return formatMicros(t.unit === 0 ? BigInt(values[i]) * 86_400_000_000n : BigInt(values[i]) * 1000n).slice(0, t.unit === 0 ? 10 : undefined);
    case Type.Decimal: {
      const width = t.bitWidth / 32;
      return decimal(values as Uint32Array, i * width, t.scale, width);
    }
    case Type.Float: {
      const v = Number(values[i]);
      return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(digits ?? (t.precision === 2 ? 17 : 9))));
    }
    case Type.Int: return String(values[i]);
    default: {
      const v = getValue(data, i);
      if (v === null || v === undefined) return null;
      return typeof v === 'object' ? JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? String(x) : x) : String(v);
    }
  }
}

const vectors = new WeakMap<Data, { get(i: number): unknown }>();
function getValue(data: Data, i: number): unknown {
  let v = vectors.get(data);
  if (!v) { v = makeVector(data); vectors.set(data, v); }
  return v.get(i);
}

/** Accumulates the first rows of a result as strings. */
export class TablePreview {
  readonly columns: string[];
  readonly rows: string[][] = [];
  total = 0;
  constructor(schema: Schema) { this.columns = schema.fields.map(f => f.name); }
  get full(): boolean { return this.rows.length >= TABLE_ROWS; }
  add(batch: RecordBatch): void {
    this.total += batch.numRows;
    const columns = batch.data.children as Data[];
    for (let i = 0; i < batch.numRows && this.rows.length < TABLE_ROWS; i++) this.rows.push(columns.map(c => cell(c, i, 6) ?? 'NULL'));
  }
}

const csvField = (v: string | null): string => v === null ? '' : /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

/** CSV of retained batches. Built in parts so no single giant string is concatenated. */
export function toCsv(schema: Schema, batches: readonly RecordBatch[]): Blob {
  const parts: string[] = [schema.fields.map(f => csvField(f.name)).join(',') + '\n'];
  for (const batch of batches) {
    const columns = batch.data.children as Data[];
    let chunk = '';
    for (let i = 0; i < batch.numRows; i++) {
      chunk += columns.map(c => csvField(cell(c, i))).join(',') + '\n';
      if (chunk.length > 1 << 20) { parts.push(chunk); chunk = ''; }
    }
    if (chunk) parts.push(chunk);
  }
  return new Blob(parts, { type: 'text/csv' });
}
