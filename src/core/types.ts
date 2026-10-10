/**
 * Legacy types kept only for the Canvas2D chart (src/ui/chart.ts), which render-bench uses as
 * the baseline for the Rust/Wasm renderer. Delete this file together with chart.ts.
 */
export type Metric = 'speed' | 'wind' | 'wave_height' | 'water_temp';
export type ChartView = 'line' | 'bar' | 'scatter' | 'table' | 'heatmap' | 'surface' | 'map' | 'density' | 'tracks' | 'seasons';
export interface QueryPlan {
  metric: Metric;
  aggregate: 'avg' | 'min' | 'max';
  bucketMinutes: number;
  windowHours: number;
  splitByVessel: boolean;
  vessel: number | null;
  view: ChartView;
}
export interface DatasetContext {
  id: string;
  label: string;
  rowCount: number;
  start: number;
  end: number;
  vessels: string[];
  description: string;
}
export interface ColumnBatch {
  /** Views of retained Arrow numeric buffers; x uses exact epoch milliseconds. */
  x: Float64Array;
  y: Float64Array;
  series: Int32Array;
  lat?: Float64Array;
  lon?: Float64Array;
  length: number;
  byteLength: number;
  /** Backing allocations retained by this batch; budgets count each buffer once. */
  retainedBuffers?: readonly ArrayBufferLike[];
  /** Keeps the producer's immutable backing allocation alive. */
  owner?: unknown;
}
export interface QueryView {
  id: string;
  prompt: string;
  revision: number;
  plan: QueryPlan;
  sql: string;
  source: string;
  context: DatasetContext;
  timing: unknown;
}
export const METRIC_LABELS: Record<Metric, { name: string; unit: string }> = {
  speed: { name: 'Vessel speed', unit: 'kn' }, wind: { name: 'Wind speed', unit: 'kn' },
  wave_height: { name: 'Wave height', unit: 'm' }, water_temp: { name: 'Water temperature', unit: '°C' },
};
