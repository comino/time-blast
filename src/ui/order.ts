import type { ColumnBatch } from '../core/types';

interface SeriesOrder { refs: number[]; lastTime: number; dirty: boolean }

/** One numeric reference per point; producer columns remain untouched. */
export class ColumnOrder {
  readonly series = new Map<number, SeriesOrder>();
  private starts: number[] = [];
  private length = 0;
  constructor(private batches: readonly ColumnBatch[]) {}
  clear(): void { this.series.clear(); this.starts.length = 0; this.length = 0; }
  append(batch: ColumnBatch): void {
    const start = this.length;
    this.starts.push(start); this.length += batch.length;
    for (let row = 0; row < batch.length; row++) {
      const timestamp = batch.x[row];
      if (!Number.isFinite(timestamp)) continue;
      const id = batch.series[row];
      let series = this.series.get(id);
      if (!series) { series = { refs: [], lastTime: -Infinity, dirty: false }; this.series.set(id, series); }
      series.refs.push(start + row);
      if (timestamp < series.lastTime) series.dirty = true;
      series.lastTime = timestamp;
    }
  }
  batchIndex(ref: number): number {
    let low = 0, high = this.starts.length - 1;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (this.starts[mid] <= ref) low = mid; else high = mid - 1; }
    return low;
  }
  rowIndex(ref: number, batch: number): number { return ref - this.starts[batch]; }
  private time(ref: number): number { const index = this.batchIndex(ref); return this.batches[index].x[this.rowIndex(ref, index)]; }
  sort(): void {
    for (const series of this.series.values()) if (series.dirty) {
      series.refs.sort((a, b) => this.time(a) - this.time(b) || a - b);
      series.lastTime = this.time(series.refs[series.refs.length - 1]); series.dirty = false;
    }
  }
}
