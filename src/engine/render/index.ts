/** RendererNode: JS glue around the Rust/Wasm renderer core (crates/tb-render) and a
 * WebGPU/WebGL2 shim. Runs in the engine worker on one OffscreenCanvas per slot.
 * See docs/batch-1/render.md. */
import type { RecordBatch, Schema } from 'apache-arrow';
import type { CreateRenderer, Emit, LocalFrame, PostToUi, RendererNode, SlotSize, ViewName } from '../contracts';
import { Flag, header, json, Kind, Node, now as clock, Stage, type Frame, type Stamp } from '../../protocol/frame';
import { NullBackend, WebGl2Backend, WebGpuBackend, type BackendKind, type GpuBackend } from './backend';
import { AUTO_VIEW, Ev, Flags, RenderCore, VIEW_NAMES } from './core';
import { BatchWriter, describeType, writeSchema } from './ingest';
import { TablePreview, toCsv } from './table';

export interface RendererOptions {
  /** Wasm bytes or URL; default `${BASE_URL}wasm/tb-render.wasm`. */
  wasm?: BufferSource | URL | string;
  /** Force a backend; default 'auto' = WebGPU, else WebGL2, else null (no pixels). */
  backend?: 'auto' | BackendKind;
  /** Clock in Unix ms (tests). */
  now?: () => number;
  /** Cap on result bytes retained for CSV export per request. */
  exportBytes?: number;
}

/** Per bound request. */
interface Bound {
  slot: number; request: number; revision: number; epoch: number; context: number;
  schema?: Schema; writer?: BatchWriter; preview?: TablePreview;
  batches: RecordBatch[]; retained: number; truncated: boolean;
  firstBatchAt?: number; firstDrawn: boolean; done: boolean;
  /** Measurements of the first-draw path (ms): copy+ingest, frame build, replay+submit. */
  timing: { ingest?: number; build?: number; replay?: number; submitted?: number; presented?: number };
}

/** Timings recorded for render-bench and tests. */
export interface RenderMetrics {
  frames: number;
  lastFrame: { build: number; replay: number; commands: number; calls: number; uploadedBytes: number };
  lastBatch: { ingest: number; copiedBytes: number; rows: number };
}

const DEFAULT_EXPORT_BYTES = 256 << 20;

/** Bytes held by a batch's buffers (validity, offsets, values; dictionaries not counted). */
function batchBytes(batch: RecordBatch): number {
  let n = 0;
  for (const d of batch.data.children) n += (d.values?.byteLength ?? 0) + (d.nullBitmap?.byteLength ?? 0) + (d.valueOffsets?.byteLength ?? 0);
  return n;
}

type RafLike = (cb: (t: number) => void) => number;

export class Renderer implements RendererNode {
  private readonly slots = new Map<number, { canvas: OffscreenCanvas; size: SlotSize; request?: number }>();
  private readonly requests = new Map<number, Bound>();
  private scheduled = false;
  private readonly raf: RafLike;
  readonly scheduler: 'requestAnimationFrame' | 'setTimeout';
  readonly metrics: RenderMetrics = { frames: 0, lastFrame: { build: 0, replay: 0, commands: 0, calls: 0, uploadedBytes: 0 }, lastBatch: { ingest: 0, copiedBytes: 0, rows: 0 } };

  constructor(readonly core: RenderCore, readonly backend: GpuBackend, private readonly emit: Emit, private readonly ui: PostToUi,
    private readonly now: () => number = clock, private readonly exportBytes = DEFAULT_EXPORT_BYTES) {
    // Dedicated workers in Chromium expose requestAnimationFrame (OffscreenCanvas animation);
    // elsewhere fall back to a 16 ms timer.
    const raf = (globalThis as any).requestAnimationFrame as RafLike | undefined;
    this.raf = raf ? raf.bind(globalThis) : (cb => setTimeout(() => cb(performance.now()), 16) as unknown as number);
    this.scheduler = raf ? 'requestAnimationFrame' : 'setTimeout';
  }

  attach(slot: number, canvas: OffscreenCanvas, size: SlotSize): void {
    this.slots.set(slot, { canvas, size });
    this.backend.attach(slot, canvas, size.width * size.devicePixelRatio, size.height * size.devicePixelRatio);
    this.core.x.tb_attach(slot, size.width, size.height, size.devicePixelRatio);
    this.schedule();
  }

  resize(slot: number, size: SlotSize): void {
    const s = this.slots.get(slot);
    if (!s) return;
    s.size = size;
    this.backend.resize(slot, size.width * size.devicePixelRatio, size.height * size.devicePixelRatio);
    this.core.x.tb_resize(slot, size.width, size.height, size.devicePixelRatio);
    // Resizing clears the canvas: redraw now rather than leave a blank frame.
    this.frame(false);
  }

  detach(slot: number): void {
    const s = this.slots.get(slot);
    if (s?.request !== undefined) this.requests.delete(s.request);
    this.core.x.tb_detach(slot);
    this.slots.delete(slot);
    this.frame(false);
    this.backend.detach(slot);
  }

  setView(slot: number, view: ViewName | null): void {
    const code = view === null ? AUTO_VIEW : VIEW_NAMES.indexOf(view);
    this.core.x.tb_set_view(slot, code < 0 ? AUTO_VIEW : code);
    this.drainEvents();
    this.schedule();
  }

  setParam(slot: number, name: string, value: number): void {
    this.core.setParam(slot, name, value);
    this.schedule();
  }

  views(slot: number): ViewName[] { return this.core.viewsOf(this.core.x.tb_views(slot)); }

  handle(frame: LocalFrame): void {
    if (frame.flags & Flag.HEADER_ONLY) return;
    switch (frame.kind) {
      case Kind.BIND: return this.bind(frame as Frame<Uint8Array>);
      case Kind.UNBIND: return this.unbind(frame as Frame<Uint8Array>);
      case Kind.RESULT_SCHEMA: { this.schema(frame.request, frame.epoch, (frame as Frame<Schema>).payload); return; }
      case Kind.BATCH: return this.batch(frame as Frame<RecordBatch>);
      case Kind.DONE: return this.done(frame);
    }
  }

  /** CSV of the slot's bound result (not in RendererNode yet; see docs/batch-1/render.md). */
  export(slot: number, format: 'csv' = 'csv'): void {
    const request = this.slots.get(slot)?.request;
    const b = request === undefined ? undefined : this.requests.get(request);
    if (!b?.schema || format !== 'csv') return;
    const blob = toCsv(b.schema, b.batches);
    this.ui({ type: 'export', slot, blob, filename: `result-${b.request}${b.truncated ? '-truncated' : ''}.csv` });
  }

  private bind(frame: Frame<Uint8Array>): void {
    const slot = new DataView(frame.payload.buffer, frame.payload.byteOffset, 4).getUint32(0, true);
    const s = this.slots.get(slot);
    if (!s || !this.core.x.tb_bind(slot, frame.request, frame.revision, frame.epoch)) return;
    if (s.request !== undefined && s.request !== frame.request) this.requests.delete(s.request);
    s.request = frame.request;
    const existing = this.requests.get(frame.request);
    if (existing) Object.assign(existing, { revision: frame.revision, epoch: frame.epoch, context: frame.context });
    else this.requests.set(frame.request, { slot, request: frame.request, revision: frame.revision, epoch: frame.epoch, context: frame.context,
      batches: [], retained: 0, truncated: false, firstDrawn: false, done: false, timing: {} });
  }

  private unbind(frame: Frame<Uint8Array>): void {
    const slot = new DataView(frame.payload.buffer, frame.payload.byteOffset, 4).getUint32(0, true);
    if (!this.core.x.tb_unbind(slot, frame.request)) return;
    const s = this.slots.get(slot);
    if (s) s.request = undefined;
    this.requests.delete(frame.request);
    this.schedule();
  }

  private schema(request: number, epoch: number, schema: Schema): Bound | undefined {
    const b = this.requests.get(request);
    if (!b || this.core.x.tb_accepts(request, epoch) < 0) return undefined;
    const count = writeSchema(this.core, schema);
    const needed = this.core.x.tb_schema(request, epoch, count);
    if (needed < 0) return undefined;
    const base = this.core.x.tb_out_ptr() >>> 2;
    const indices = Array.from(this.core.u32.subarray(base, base + needed));
    b.schema = schema;
    b.writer = new BatchWriter(this.core, schema.fields.map(f => describeType(f.type)), indices);
    b.preview = new TablePreview(schema);
    b.batches = []; b.retained = 0; b.truncated = false;
    this.drainEvents();
    return b;
  }

  private batch(frame: Frame<RecordBatch>): void {
    const at = this.now();
    const { request, epoch } = frame;
    if (this.core.x.tb_accepts(request, epoch) < 0) return;
    const batch = frame.payload;
    let b = this.requests.get(request);
    if (!b) return;
    if (!b.writer && !(b = this.schema(request, epoch, batch.schema))) return;
    b.firstBatchAt ??= at;
    const t0 = performance.now();
    const columns = b.writer!.write(batch);
    const flags = this.core.x.tb_batch(request, epoch, batch.numRows, columns);
    const ingest = performance.now() - t0;
    this.metrics.lastBatch = { ingest, copiedBytes: b.writer!.copied, rows: batch.numRows };
    if (!(flags & Flags.ACCEPTED)) return;
    const bytes = batchBytes(batch);
    if (b.retained + bytes <= this.exportBytes) { b.batches.push(batch); b.retained += bytes; } else b.truncated = true;
    const firstPreview = b.preview!.rows.length === 0;
    if (!b.preview!.full) b.preview!.add(batch); else b.preview!.total += batch.numRows;
    if (flags & Flags.URGENT) { b.timing.ingest = ingest; this.frame(true); } else this.schedule();
    // Text after pixels: the table preview never delays the first draw.
    if (firstPreview) this.postTable(b);
  }

  private done(frame: LocalFrame): void {
    const { request, epoch } = frame;
    const b = this.requests.get(request);
    if (!b) return;
    const flags = this.core.x.tb_done(request, epoch);
    if (!(flags & Flags.ACCEPTED)) return;
    b.done = true;
    if (flags & Flags.URGENT) this.frame(true); else this.schedule();
    this.postTable(b);
  }

  private postTable(b: Bound): void {
    if (!b.preview) return;
    this.ui({ type: 'table', slot: b.slot, columns: b.preview.columns, rows: b.preview.rows, total: b.preview.total });
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.raf(() => {
      this.scheduled = false;
      this.frame(false);
      if (this.core.x.tb_needs_frame()) this.schedule();
    });
  }

  /** Build and submit a frame now. `urgent` builds only slots with a first draw waiting. */
  frame(urgent: boolean): void {
    const x = this.core.x;
    const t0 = performance.now();
    const length = x.tb_frame(urgent ? 1 : 0);
    const t1 = performance.now();
    if (length) {
      const base = x.tb_words_ptr() >>> 2;
      this.backend.replay(this.core.u32.subarray(base, base + length), this.core.memory);
    }
    const t2 = performance.now();
    const submitted = this.now();
    x.tb_frame_done();
    // A view may defer work past the first draw (geo basemap): keep frames coming while asked.
    if (x.tb_needs_frame()) this.schedule();
    if (length) {
      this.metrics.frames++;
      this.metrics.lastFrame = { build: t1 - t0, replay: t2 - t1, ...this.backend.stats };
    }
    this.drainEvents(submitted, t1 - t0, t2 - t1);
  }

  private drainEvents(submitted = this.now(), build = 0, replay = 0): void {
    for (const e of this.core.events()) {
      if (e.kind === Ev.VIEWS) {
        const parsed = JSON.parse(e.text) as { available: ViewName[]; chosen: ViewName };
        this.ui({ type: 'views', slot: e.slot, available: parsed.available, chosen: parsed.chosen });
      } else if (e.kind === Ev.AXES) {
        this.ui({ type: 'axes', slot: e.slot, ticks: JSON.parse(e.text) });
      } else if (e.kind === Ev.FIRST_DRAW) {
        const b = this.requests.get(e.request);
        if (!b || b.firstDrawn) continue;
        b.firstDrawn = true;
        b.timing.build = build; b.timing.replay = replay; b.timing.submitted = submitted;
        this.drawn(b, e.slot, e.a, [
          ...(b.firstBatchAt !== undefined ? [{ stage: Stage.RENDER_FIRST_BATCH, node: Node.RENDERER, at: b.firstBatchAt }] : []),
          { stage: Stage.FIRST_DRAW_SUBMITTED, node: Node.RENDERER, at: submitted },
        ]);
        const points = e.a;
        this.backend.presented().then(() => {
          const at = this.now();
          b.timing.presented = at;
          this.drawn(b, e.slot, points, [{ stage: Stage.FIRST_PRESENTED, node: Node.RENDERER, at }]);
        }, () => {});
      }
    }
  }

  /** DRAWN echoes the binding's request, revision, epoch and context. */
  private drawn(b: Bound, slot: number, points: number, stamps: Stamp[]): void {
    const payload = new Uint8Array(8), view = new DataView(payload.buffer);
    view.setUint32(0, slot, true); view.setUint32(4, points, true);
    this.emit({ ...header(Kind.DRAWN, { request: b.request, revision: b.revision, epoch: b.epoch, context: b.context }), stamps, payload });
  }

  /** First-draw timings of a request (bench/tests). */
  timing(request: number): Bound['timing'] | undefined { return this.requests.get(request)?.timing; }
}

async function pickBackend(core: RenderCore, choice: RendererOptions['backend']): Promise<GpuBackend> {
  if (choice === 'null') return new NullBackend();
  if (choice !== 'webgl2') {
    try {
      const gpu = await WebGpuBackend.create(core.pipelines);
      if (gpu) return gpu;
    } catch (error) {
      if (choice === 'webgpu') throw error;
    }
    if (choice === 'webgpu') throw new Error('WebGPU is unavailable');
  }
  if (WebGl2Backend.available()) return new WebGl2Backend(core.pipelines);
  if (choice === 'webgl2') throw new Error('WebGL2 is unavailable');
  return new NullBackend();
}

export const createRenderer = (async (emit: Emit, ui: PostToUi, options: RendererOptions = {}) => {
  const core = await RenderCore.load(options.wasm ?? new URL(`${import.meta.env?.BASE_URL ?? '/'}wasm/tb-render.wasm`, globalThis.location?.href ?? 'http://localhost/'));
  const backend = await pickBackend(core, options.backend ?? 'auto');
  const renderer = new Renderer(core, backend, emit, ui, options.now, options.exportBytes);
  const state = backend.kind === 'null' ? 'error' : 'ready';
  emit({ ...header(Kind.STATUS), stamps: [], payload: json({ component: 'renderer', state, label: backend.kind,
    detail: `${backend.label}; scheduler ${renderer.scheduler}` }) });
  return renderer;
}) satisfies CreateRenderer as (emit: Emit, ui: PostToUi, options?: RendererOptions) => Promise<Renderer>;
