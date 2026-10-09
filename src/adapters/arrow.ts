import { DataType, Precision, type RecordBatch, type Vector } from 'apache-arrow';
import type { ColumnBatch } from '../core/types';

export const MAX_RESULT_ROWS = 250_000;
export const MAX_RESULT_BYTES = 32 * 1024 * 1024;
export function abortError(): DOMException { return new DOMException('Query canceled', 'AbortError'); }
export function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw abortError(); }

/** Primitive contiguous Arrow columns return views; never convert to row objects. */
function numericColumn(batch: RecordBatch, name: string, integer = false): Float64Array | Int32Array {
  const vector: Vector | null = batch.getChild(name);
  if (!vector) throw new Error(`Database result is missing column "${name}"`);
  if (vector.nullCount !== 0) throw new Error(`Database column "${name}" contains nulls`);
  if (vector.data.length !== 1) throw new Error(`Database column "${name}" is not contiguous`);
  const type = vector.type;
  const validType = integer
    ? DataType.isInt(type) && type.bitWidth === 32 && type.isSigned
    : DataType.isFloat(type) && type.precision === Precision.DOUBLE;
  if (!validType) throw new Error(`Database column "${name}" must be ${integer ? 'Int32' : 'Float64'}`);
  const values = vector.toArray();
  if (integer ? !(values instanceof Int32Array) : !(values instanceof Float64Array)) {
    throw new Error(`Unexpected storage for database column "${name}"`);
  }
  if (values.length < batch.numRows) throw new Error(`Short database column "${name}"`);
  return values.subarray(0, batch.numRows) as Float64Array | Int32Array;
}

export function retainArrowBatch(batch: RecordBatch, seriesCount?: number): ColumnBatch {
  const x = numericColumn(batch, 'x') as Float64Array;
  const y = numericColumn(batch, 'y') as Float64Array;
  const series = numericColumn(batch, 'series', true) as Int32Array;
  const lat = batch.getChild('lat') ? numericColumn(batch, 'lat') as Float64Array : undefined;
  const lon = batch.getChild('lon') ? numericColumn(batch, 'lon') as Float64Array : undefined;
  if (!!lat !== !!lon) throw new Error('Latitude and longitude must be supplied together');
  for (let i = 0; i < batch.numRows; i++) {
    if (!Number.isSafeInteger(x[i]) || !Number.isFinite(y[i])) throw new Error('Database returned an invalid timestamp or value');
    if (series[i] < 0 || (seriesCount !== undefined && series[i] >= seriesCount)) throw new Error('Database returned an invalid vessel identity');
    if (lat && lon && (!Number.isFinite(lat[i]) || !Number.isFinite(lon[i]) || Math.abs(lat[i]) > 90 || Math.abs(lon[i]) > 180)) {
      throw new Error('Database returned invalid geographic coordinates');
    }
  }
  return { x, y, series, lat, lon, length: batch.numRows,
    byteLength: x.byteLength + y.byteLength + series.byteLength + (lat?.byteLength ?? 0) + (lon?.byteLength ?? 0), owner: batch };
}

/** One active query plus one waiting query; scoped cancellation/idempotent release. */
export class QueryGate {
  private occupied = false;
  private waiting?: { signal: AbortSignal; abort: () => void; resolve: (release: () => void) => void };
  async acquire(signal: AbortSignal): Promise<() => void> {
    checkAbort(signal);
    if (!this.occupied) { this.occupied = true; return this.releaseHandle(); }
    if (this.waiting) throw new Error('Database admission queue is full; wait for the current request');
    return new Promise((resolve, reject) => {
      const abort = () => { this.waiting = undefined; reject(abortError()); };
      this.waiting = { signal, abort, resolve };
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting;
      this.waiting = undefined;
      if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(this.releaseHandle()); }
      else this.occupied = false;
    };
  }
}
