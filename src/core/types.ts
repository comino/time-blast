/** Placement-independent contracts. Numeric batches must never become row objects. */
export type Metric = 'speed' | 'wind' | 'wave_height' | 'water_temp';
export type Aggregate = 'avg' | 'min' | 'max';
export const CHART_VIEWS = ['line', 'bar', 'scatter', 'table', 'heatmap', 'surface', 'map', 'density', 'tracks', 'seasons'] as const;
export type ChartView = typeof CHART_VIEWS[number];
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
/** Durations are milliseconds measured within each component's own clock. */
export interface InferenceDiagnostics {
  warmupMs?: number;
  queueMs?: number;
  generationMs?: number;
  /** One generation, or an initial generation followed by one model correction. */
  attempts?: number;
  /** Wall time spent in the second generation, included in generationMs. */
  repairMs?: number;
  firstTokenMs?: number;
  prefillMs?: number;
  decodeMs?: number;
  grammarInitMs?: number;
  grammarPerTokenMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  prefillTokensPerSecond?: number;
  decodeTokensPerSecond?: number;
  cacheHit?: boolean;
}
export interface InferenceResult {
  plan: QueryPlan;
  source: 'template' | 'webgpu' | 'remote';
  model?: string;
  tokens?: number;
  diagnostics?: InferenceDiagnostics;
}
/** Bounded generated output for diagnosing a failed model request; never executed. */
export interface ModelResponseFailure {
  text: string;
  truncated: boolean;
  finishReason?: string;
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
  /** Changes local exact-plan reuse without unloading a warmed model. */
  setPlanCacheEnabled?(enabled: boolean): void;
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
/** Local execution strategy for complete, disjoint time buckets in one snapshot. */
export interface FirstBucketExecution {
  readonly kind: 'first-complete-bucket';
  readonly sql: string;
  readonly firstSql: string;
  readonly remainderSql: string;
  readonly contextId: string;
  readonly start: number;
  readonly end: number;
}
export interface QueryRequest {
  id: string;
  sql: string;
  plan: QueryPlan;
  context: DatasetContext;
  signal: AbortSignal;
  priority: 'committed' | 'speculative';
  firstBucket?: FirstBucketExecution;
}
export interface DatabaseAdapter {
  readonly id: string;
  readonly placement: 'browser' | 'remote';
  readonly supportsFirstBucket?: true;
  prepare(onProgress?: (status: AdapterStatus) => void): Promise<DatasetContext>;
  execute(request: QueryRequest): AsyncIterable<ColumnBatch>;
  dispose(): Promise<void>;
}
export interface QueryCompiler {
  prepare(): Promise<void>;
  compile(plan: QueryPlan, context: DatasetContext): string;
  compileFirstBucket?(plan: QueryPlan, context: DatasetContext): FirstBucketExecution | undefined;
  readonly kind: 'rust-wasm';
}
export interface QueryTiming {
  startedAt: number;
  committedAt?: number;
  /** Adapter wall time starts here; it may precede submission for prepared work. */
  inferenceStartedAt?: number;
  intentAt?: number;
  compiledAt?: number;
  /** Includes adapter admission, execution and streaming, not only engine CPU time. */
  queryStartedAt?: number;
  firstBatchAt?: number;
  /** First batch delivered to the renderer, including promotion of staged data. */
  firstPublishedAt?: number;
  firstDrawAt?: number;
  completedAt?: number;
  /** Terminal failure time; never implies a validated plan or completed query. */
  failedAt?: number;
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
  execution?: 'first-complete-bucket';
  source: InferenceResult['source'];
  model?: string;
  database?: string;
  inference?: InferenceDiagnostics;
  context: DatasetContext;
  timing: QueryTiming;
}
export interface QueryFailure {
  timing: QueryTiming;
  phase: 'inference' | 'compile' | 'query';
  source?: InferenceResult['source'];
  model?: string;
  inference?: InferenceDiagnostics;
  response?: ModelResponseFailure;
  database?: string;
}
export type PipelineEvent =
  | { type: 'draft'; revision: number; chars: number }
  | { type: 'speculation'; state: 'idle' | 'resolving' | 'translated' | 'querying' | 'ready' | 'canceled'; text: string; points: number }
  | { type: 'start'; view: QueryView }
  | { type: 'batch'; id: string; batch: ColumnBatch }
  | { type: 'complete'; id: string; timing: QueryTiming }
  | { type: 'error'; id?: string; message: string; failure?: QueryFailure }
  | { type: 'trace'; entry: TraceEvent };
export type InferenceMode = 'auto' | 'webgpu' | 'templates' | 'remote';
export type LocalModelProfile = 'qwen-0.5b' | 'qwen-1.5b' | 'qwen3-4b';
export const DEFAULT_LOCAL_MODEL_PROFILE: LocalModelProfile = 'qwen3-4b';
export type DatasetProfile = 'demo' | 'large';
export interface RuntimeConfig {
  inferenceMode: InferenceMode;
  localModel: LocalModelProfile;
  cacheModelPlans: boolean;
  inferenceEndpoint: string;
  inferenceDraftEndpoint: string;
  databaseMode: 'browser' | 'remote';
  databaseEndpoint: string;
  datasetProfile: DatasetProfile;
  coordinatorMode: 'browser' | 'remote';
  coordinatorEndpoint: string;
  speculation: boolean;
  liveQuery: boolean;
  liveTranslation: boolean;
  translationMinChars: number;
}
export const DEFAULT_CONFIG: RuntimeConfig = {
  inferenceMode: 'webgpu', inferenceEndpoint: '', inferenceDraftEndpoint: '', databaseMode: 'browser',
  localModel: DEFAULT_LOCAL_MODEL_PROFILE, cacheModelPlans: true,
  databaseEndpoint: '', coordinatorMode: 'browser', coordinatorEndpoint: '', speculation: true,
  liveQuery: true, liveTranslation: true, translationMinChars: 20,
  datasetProfile: 'large',
};
export const METRIC_LABELS: Record<Metric, { name: string; unit: string }> = {
  speed: { name: 'Vessel speed', unit: 'kn' }, wind: { name: 'Wind speed', unit: 'kn' },
  wave_height: { name: 'Wave height', unit: 'm' }, water_temp: { name: 'Water temperature', unit: '°C' },
};
