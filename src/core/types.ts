/** Placement-independent contracts. Numeric batches must never become row objects. */
export type Metric = 'speed' | 'wind' | 'wave_height' | 'water_temp';
export type Aggregate = 'avg' | 'min' | 'max';
export type ChartView = 'line' | 'bar';
export interface QueryPlan {
  metric: Metric;
  aggregate: Aggregate;
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
export interface Draft {
  revision: number;
  text: string;
  contextId: string;
  sentAt: number;
}
export interface InferenceResult {
  plan: QueryPlan;
  source: 'template' | 'webgpu' | 'remote';
  model?: string;
  tokens?: number;
}
export interface AdapterStatus {
  state: 'cold' | 'loading' | 'ready' | 'unavailable' | 'error';
  label: string;
  progress?: number;
  detail?: string;
}
export interface InferenceAdapter {
  readonly id: string;
  readonly placement: 'browser' | 'remote';
  prepare(context: DatasetContext): Promise<void>;
  observeDraft(draft: Draft): void;
  resolve(draft: Draft, signal: AbortSignal): Promise<InferenceResult>;
  dispose(): void;
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
export interface QueryRequest {
  id: string;
  sql: string;
  plan: QueryPlan;
  context: DatasetContext;
  signal: AbortSignal;
  priority: 'committed' | 'speculative';
}
export interface DatabaseAdapter {
  readonly id: string;
  readonly placement: 'browser' | 'remote';
  prepare(onProgress?: (status: AdapterStatus) => void): Promise<DatasetContext>;
  execute(request: QueryRequest): AsyncIterable<ColumnBatch>;
  dispose(): Promise<void>;
}
export interface QueryCompiler {
  prepare(): Promise<void>;
  compile(plan: QueryPlan, context: DatasetContext): string;
  readonly kind: 'rust-wasm';
}
export interface QueryTiming {
  startedAt: number;
  committedAt?: number;
  intentAt?: number;
  firstBatchAt?: number;
  firstDrawAt?: number;
  completedAt?: number;
  promoted: boolean;
  batches: number;
  points: number;
  bytes: number;
}
export interface TraceEvent { at: number; event: string; detail: string; }
export interface QueryView {
  id: string;
  prompt: string;
  revision: number;
  plan: QueryPlan;
  sql: string;
  source: InferenceResult['source'];
  model?: string;
  context: DatasetContext;
  timing: QueryTiming;
}
export type PipelineEvent =
  | { type: 'draft'; revision: number; chars: number }
  | { type: 'speculation'; state: 'idle' | 'resolving' | 'translated' | 'querying' | 'ready' | 'canceled'; text: string; points: number }
  | { type: 'start'; view: QueryView }
  | { type: 'batch'; id: string; batch: ColumnBatch }
  | { type: 'complete'; id: string; timing: QueryTiming }
  | { type: 'error'; id?: string; message: string }
  | { type: 'trace'; entry: TraceEvent };
export type InferenceMode = 'auto' | 'webgpu' | 'templates' | 'remote';
export type DatasetProfile = 'demo' | 'large';
export interface RuntimeConfig {
  inferenceMode: InferenceMode;
  inferenceEndpoint: string;
  inferenceDraftEndpoint: string;
  databaseMode: 'browser' | 'remote';
  databaseEndpoint: string;
  datasetProfile: DatasetProfile;
  coordinatorMode: 'browser' | 'remote';
  coordinatorEndpoint: string;
  speculation: boolean;
  liveTranslation: boolean;
  translationMinChars: number;
}
export const DEFAULT_CONFIG: RuntimeConfig = {
  inferenceMode: 'auto', inferenceEndpoint: '', inferenceDraftEndpoint: '', databaseMode: 'browser',
  databaseEndpoint: '', coordinatorMode: 'browser', coordinatorEndpoint: '', speculation: true,
  liveTranslation: false, translationMinChars: 20,
  datasetProfile: 'large',
};
export const METRIC_LABELS: Record<Metric, { name: string; unit: string }> = {
  speed: { name: 'Vessel speed', unit: 'kn' }, wind: { name: 'Wind speed', unit: 'kn' },
  wave_height: { name: 'Wave height', unit: 'm' }, water_temp: { name: 'Water temperature', unit: '°C' },
};
