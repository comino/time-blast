import type { ColumnBatch, QueryView } from '../core/types';
import type { ColumnOrder } from './order';

/** All presentations borrow the primary index and immutable producer columns. */
export interface RendererSource {
  view: QueryView;
  batches: readonly ColumnBatch[];
  order: ColumnOrder;
}
export interface RendererCallbacks {
  draw(at: number): void;
  settled(value: boolean): void;
}
export interface ResultRenderer {
  readonly isSettled: boolean;
  append(batch: ColumnBatch): void;
  indexed(reordered: boolean): void;
  setVisible(visible: boolean): void;
  stop(): void;
  destroy(): void;
  setAngle?(degrees: number): void;
  setTimeFraction?(fraction: number): void;
}
