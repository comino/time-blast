import { describe, expect, it } from 'vitest';
import { ColumnOrder } from '../src/ui/order';
import type { ColumnBatch } from '../src/core/types';

function batch(x: number[], series: number[]): ColumnBatch {
  return { x: Float64Array.from(x), y: Float64Array.from(x, value => value * 2), series: Int32Array.from(series), length: x.length, byteLength: x.length * 20 };
}

describe('chart column ordering', () => {
  it('sorts timestamp references across interleaved series and batches without changing columns', () => {
    const batches: ColumnBatch[] = [], order = new ColumnOrder(batches);
    const first = batch([30, 20, 10], [0, 1, 0]), second = batch([10, 15, 20], [1, 0, 1]);
    for (const current of [first, second]) { batches.push(current); order.append(current); }
    order.sort();
    const times = (id: number) => order.series.get(id)!.refs.map(ref => { const index = order.batchIndex(ref); return batches[index].x[order.rowIndex(ref, index)]; });
    expect(times(0)).toEqual([10, 15, 30]);
    expect(times(1)).toEqual([10, 20, 20]);
    expect(Array.from(first.x)).toEqual([30, 20, 10]);
    expect(batches[0]).toBe(first);
    const third = batch([18], [0]); batches.push(third); order.append(third); order.sort();
    expect(times(0)).toEqual([10, 15, 18, 30]);
  });

  it('handles empty batches, ignores invalid timestamps, and resets between queries', () => {
    const batches: ColumnBatch[] = [], order = new ColumnOrder(batches);
    for (const current of [batch([], []), batch([NaN, 5], [0, 0]), batch([], [])]) { batches.push(current); order.append(current); }
    const ref = order.series.get(0)!.refs[0], index = order.batchIndex(ref);
    expect(batches[index].x[order.rowIndex(ref, index)]).toBe(5);
    batches.length = 0; order.clear();
    expect(order.series.size).toBe(0);
    const next = batch([1], [2]); batches.push(next); order.append(next);
    expect(order.series.get(2)!.refs).toEqual([0]);
  });
});
