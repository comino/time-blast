/**
 * Batch-1 contracts between the pieces built in parallel. See docs/plan-batch-1.md
 * for ownership and docs/protocol-v1.md for frame semantics. Change these only with
 * the coordinating agent; every owner builds against them.
 */
import type { RecordBatch, Schema } from 'apache-arrow';
import type { Frame } from '../protocol/frame';

// ───────────────────────── links ─────────────────────────

export type LinkId = 'ui' | 'inference' | 'database' | 'renderer';

/** A frame travelling inside one thread. RESULT_SCHEMA/BATCH carry Arrow objects;
 * everything else carries bytes. Nothing is encoded on in-process links. */
export type LocalFrame = Frame<Uint8Array> | Frame<Schema> | Frame<RecordBatch>;

/** One end of a link. In-process, MessagePort and WebSocket links share this shape. */
export interface Link {
  readonly id: LinkId;
  readonly placement: 'in-process' | 'worker' | 'remote';
  send(frame: LocalFrame): void;
  /** Exactly one listener per link end. */
  listen(onFrame: (frame: LocalFrame) => void, onClose?: (reason: string) => void): void;
  close(): void;
}

// ───────────────────────── coordinator (owner: coordinator agent) ─────────────────────────

/** JS face of the Rust/Wasm sans-IO coordinator (crates/tb-coordinator). */
export interface CoordinatorCore {
  /** Feed one frame received on `link`. `now` is Unix ms. Payloads are copied into
   * Wasm memory; RESULT_SCHEMA/BATCH must arrive HEADER_ONLY. */
  input(link: LinkId, frame: Frame<Uint8Array>, now: number): void;
  /** Same as `input` for a frame that is still encoded (e.g. straight from a MessagePort). */
  inputEncoded(link: LinkId, bytes: Uint8Array, now: number): void;
  /** Advance timers (latency dial, deadlines). */
  tick(now: number): void;
  /** Frames the coordinator wants sent, in order. Draining clears the outbox. */
  drain(): Array<[LinkId, Frame<Uint8Array>]>;
  /** Same as `drain`, still encoded: each entry owns a fresh transferable buffer. Lets the
   * host forward UI frames without a decode + re-encode. */
  drainEncoded(): Array<[LinkId, Uint8Array]>;
  /** Earliest Unix ms at which `tick` must be called, or null. */
  nextDeadline(): number | null;
  dispose(): void;
}

/** protocol-v1 `CoordinatorConfig`. Every field optional; a CONFIG updates only what it names. */
export interface CoordinatorConfig {
  live?: boolean;
  minChars?: number;
  inferencePolicy?: 'latest' | 'restart';
  latencyDialMs?: number | null;
  translationCache?: boolean;
  speculate?: boolean;
  /** Adds already-attached slots to the coordinator's pool. */
  freeSlots?: number[];
}

/** STATUS frame `component` values. */
export type StatusComponent = 'database' | 'inference' | 'renderer' | 'coordinator';

// ───────────────────────── database node (owner: engine/database agent) ─────────────────────────

export type DatasetSource =
  | { kind: 'fixture'; name: 'vessels' | 'vessels-small' }
  | { kind: 'file'; name: string; file: File }
  | { kind: 'url'; name: string; url: string }
  /** Remote database node over a tb1 WebSocket (e.g. crates/database-server → ClickHouse). */
  | { kind: 'remote'; name: string; endpoint: string };

export interface DatabaseNode {
  /** Load data and compute the DatasetContext (protocol-v1 "DatasetContext"). */
  open(source: DatasetSource, contextId: number): Promise<DatasetContext>;
  /** Handle EXEC/CANCEL frames. Results go out through `emit`: RESULT_SCHEMA and BATCH
   * as Arrow objects to the renderer, HEADER_ONLY copies plus DONE/ERROR to the coordinator. */
  handle(frame: Frame<Uint8Array>): void;
  dispose(): void;
}

export interface DatasetContext {
  id: number;
  name: string;
  dialect: 'duckdb' | 'clickhouse';
  description?: string;
  tables: Array<{
    name: string;
    rows: number;
    columns: Array<{ name: string; type: string; min?: string | number; max?: string | number; distinct?: number; values?: string[] }>;
    sample?: unknown[][];
  }>;
}

// ───────────────────────── renderer (owner: render agent) ─────────────────────────

export type ViewName = 'line' | 'bar' | 'scatter' | 'table' | 'heatmap' | 'surface' | 'map' | 'density' | 'tracks' | 'seasons';
export type ColumnRole = 'time' | 'category' | 'series' | 'value' | 'measure' | 'lat' | 'lon';

/** JS face of the Rust/Wasm renderer (crates/tb-render) plus its WebGPU/WebGL2 shim. */
export interface RendererNode {
  /** Register a render target ahead of any result. */
  attach(slot: number, canvas: OffscreenCanvas, size: SlotSize): void;
  resize(slot: number, size: SlotSize): void;
  detach(slot: number): void;
  /** null = automatic choice from column roles. */
  setView(slot: number, view: ViewName | null): void;
  /** View-specific interaction. Names: `rotation` (surface, degrees −180..180),
   * `playback` (tracks, 0..1 of the time range). */
  setParam(slot: number, name: string, value: number): void;
  /** BIND/UNBIND, RESULT_SCHEMA, BATCH, DONE frames. Emits DRAWN to the coordinator. */
  handle(frame: LocalFrame): void;
  /** Build an export of the slot's current result and post `{type:'export'}` to the UI. */
  export(slot: number, format: 'csv'): void;
  /** Views available for a slot's current result, for the UI's view picker. */
  views(slot: number): ViewName[];
}
export interface SlotSize { width: number; height: number; devicePixelRatio: number }

// ───────────────────────── factories (stable entry points; owners replace the stubs) ─────────────────────────
// Routing lives in the engine host (src/engine/engine.worker.ts), not in the nodes:
//   database → RESULT_SCHEMA/BATCH to renderer (objects) + HEADER_ONLY copies to coordinator;
//              DONE to both; ERROR/STATUS to coordinator.
//   renderer → DRAWN to coordinator; UI data (views/table/axes/export) straight to the UI.
//   coordinator outbox → by LinkId.
export type Emit = (frame: LocalFrame) => void;
export type PostToUi = (message: EngineToUi, transfer?: Transferable[]) => void;
export type CreateCoordinator = () => Promise<CoordinatorCore>;
export type CreateRenderer = (emit: Emit, ui: PostToUi) => Promise<RendererNode>;
export type CreateDatabase = (emit: Emit) => Promise<DatabaseNode>;

// ───────────────────────── UI ⇄ engine worker (owner: UI agent ⇄ engine agent) ─────────────────────────

/** Main thread → engine worker. Protocol frames travel as transferred ArrayBuffers
 * (`{frame}`); everything else is UI control that never leaves the page. */
export type UiToEngine =
  | { type: 'frame'; bytes: ArrayBuffer }
  | { type: 'boot'; inference: InferencePlacement; dataset: DatasetSource }
  | { type: 'dataset'; source: DatasetSource }
  | { type: 'inference'; placement: InferencePlacement }
  | { type: 'attach'; slot: number; canvas: OffscreenCanvas; size: SlotSize }
  | { type: 'resize'; slot: number; size: SlotSize }
  | { type: 'detach'; slot: number }
  | { type: 'view'; slot: number; view: ViewName | null }
  | { type: 'param'; slot: number; name: string; value: number }
  | { type: 'export'; slot: number; format: 'csv' };

export type InferencePlacement =
  | { kind: 'remote'; endpoint: string }
  | { kind: 'webgpu'; model: WebGpuModel };
export type WebGpuModel = 'qwen-0.5b' | 'qwen-1.5b' | 'qwen3-4b';

/** Engine worker → main thread. STATUS, RESULT, TIMING, KEEP, BIND, UNBIND, ERROR and
 * INFER_STATS arrive as frames; the rest is UI data. */
export type EngineToUi =
  | { type: 'frame'; bytes: ArrayBuffer }
  | { type: 'context'; context: DatasetContext }
  | { type: 'views'; slot: number; available: ViewName[]; chosen: ViewName; columns?: Array<{ name: string; role: ColumnRole | 'none' }> }
  | { type: 'table'; slot: number; columns: string[]; rows: string[][]; total: number }
  | { type: 'axes'; slot: number; ticks: AxisTicks }
  | { type: 'export'; slot: number; blob: Blob; filename: string };

/** Text is the boring part: the renderer computes tick positions, the UI draws labels in DOM. */
export interface AxisTicks {
  /** `at`: CSS pixels from the canvas's top-left corner (same frame as `plot`). */
  x: Array<{ at: number; label: string }>;
  y: Array<{ at: number; label: string }>;
  /** Plot area in CSS pixels relative to the canvas. */
  plot: { left: number; top: number; width: number; height: number };
  legend?: Array<{ label: string; color: string }>;
  /** Free-positioned text (polar views): CSS px from the canvas's top-left, vertically centred;
   * `anchor` 0 = starts at x, 0.5 = centred, 1 = ends at x. */
  labels?: Array<{ x: number; y: number; label: string; anchor: number }>;
}
