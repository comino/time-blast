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
    this.appendRange(batch, this.starts.length, 0, batch.length);
  }
  appendRange(batch: ColumnBatch, batchIndex: number, from: number, to: number): void {
    if (from === 0) { this.starts.push(this.length); this.length += batch.length; }
    const start = this.starts[batchIndex];
    for (let row = from; row < to; row++) {
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
  get needsSort(): boolean { for (const series of this.series.values()) if (series.dirty) return true; return false; }
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
  /** Reordered streams use a cooperative stable merge, never copy numeric columns. */
  *sortSteps(chunk = 1024): Generator<void> {
    for (const series of this.series.values()) if (series.dirty) {
      let source = series.refs, target = new Array<number>(source.length), work = 0;
      const spare = new Array<number>(source.length);
      for (let width = 1; width < source.length; width *= 2) {
        for (let start = 0; start < source.length; start += width * 2) {
          const mid = Math.min(start + width, source.length), end = Math.min(start + width * 2, source.length);
          let left = start, right = mid;
          for (let dest = start; dest < end; dest++) {
            target[dest] = right >= end || left < mid && (this.time(source[left]) < this.time(source[right]) ||
              this.time(source[left]) === this.time(source[right]) && source[left] <= source[right]) ? source[left++] : source[right++];
            if (++work === chunk) { work = 0; yield; }
          }
        }
        const previous = source; source = target; target = previous === series.refs ? spare : previous;
      }
      series.refs = source;
      series.lastTime = this.time(source[source.length - 1]); series.dirty = false;
    }
  }
}
