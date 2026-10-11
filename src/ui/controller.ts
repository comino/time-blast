/** DOM-free UI logic: owns the draft encoder, the slot pool and the timing history, and
 * turns engine messages into calls on card/rail views. The DOM lives in app.ts,
 * slot-card.ts and rail.ts; tests drive this class with a fake engine. */
import { decode, Kind, readJson, readText, type Frame } from '../protocol/frame';
import type { AxisTicks, ColumnRole, DatasetContext, DatasetSource, EngineToUi, InferencePlacement, PointerGesture, SlotSize, UiToEngine, ViewName } from '../engine/contracts';
import { DraftEncoder, type Clock } from './draft-encoder';
import { breakdown, RollingStats, type InferStats, type RollingSummary, type TimingBreakdown } from './timing';

import type { CoordinatorConfig } from '../engine/contracts';
export type { CoordinatorConfig };
export const DEFAULT_COORDINATOR_CONFIG: Required<Omit<CoordinatorConfig, 'freeSlots'>> = {
  live: true, minChars: 3, inferencePolicy: 'latest', latencyDialMs: null, translationCache: true, speculate: true,
};

export interface EnginePort { postMessage(message: UiToEngine, transfer?: Transferable[]): void }

export interface ResultInfo {
  slot: number; sql: string; view: ViewName | null; cached: boolean;
  columns: Array<{ name: string; type: string; role: ColumnRole | null }>;
}
export interface StatusInfo { component: string; state: 'cold' | 'loading' | 'ready' | 'error'; label: string; detail?: string; progress?: number }
export interface ErrorInfo { code: string; message: string; detail?: string }

export interface CardHandlers {
  view(slot: number, view: ViewName | null): void;
  param(slot: number, name: string, value: number): void;
  exportCsv(slot: number): void;
  close(slot: number): void;
  /** Chart-as-query: a gesture on the chart (CSS px relative to the canvas). `timeStamp` is the
   * pointer event's. Returns whether a request went to the engine. */
  gesture(slot: number, gesture: PointerGesture, timeStamp: number): boolean;
  /** Back to the card's previous SQL. `afterClick`: a double-click, whose first click may have
   * drilled already; that drill is undone too. */
  back(slot: number, timeStamp: number, afterClick?: boolean): void;
}
/** One card's chrome. Pool cards start hidden. */
export interface SlotCard {
  showLive(): void;
  hide(): void;
  keep(): void;
  title(text: string, revision: number): void;
  result(info: ResultInfo, request: number): void;
  views(available: ViewName[], chosen: ViewName, columns?: Array<{ name: string; role: string }>): void;
  axes(ticks: AxisTicks): void;
  table(columns: string[], rows: string[][], total: number): void;
  timing(t: TimingBreakdown): void;
  inferStats(s: InferStats): void;
  error(e: ErrorInfo): void;
  /** Chart-as-query: how many earlier SQLs Back can return to, and the last outcome. */
  drill(depth: number, note: string): void;
  destroy(): void;
}
export interface SlotHost {
  /** Create a card with a fresh `<canvas>` and return its transferred OffscreenCanvas. */
  create(slot: number, handlers: CardHandlers): { card: SlotCard; canvas: OffscreenCanvas; size: SlotSize };
  download(blob: Blob, filename: string): void;
}
export interface RailView {
  status(s: StatusInfo): void;
  context(c: DatasetContext): void;
  timing(t: TimingBreakdown, summary: RollingSummary, stats: InferStats | undefined): void;
  inferStats(request: number, s: InferStats, sessionCostUsd: number): void;
  error(e: ErrorInfo, request: number): void;
  /** A slot became live (BIND) or idle (UNBIND / null). */
  live(slot: number | null, revision: number): void;
  /** A result was kept (KEEP): add it to the conversation history. */
  kept(slot: number, title: string): void;
}

/** One step back: the SQL shown before a manipulation, and the gesture that left it. */
interface Step { sql: string; kind: PointerGesture['kind']; at: number }
interface SlotEntry {
  card: SlotCard; kept: boolean; request: number; revision: number;
  /** SQL and request of the last RESULT (what a gesture transforms). */
  sql: string; resultRequest: number;
  /** Chart-as-query history of this card's question (cleared when the question changes). */
  history: Step[]; historyRevision: number;
  /** Gesture in flight: pushed to `history` when the engine confirms it. */
  pending?: Step;
}

const MAX_TRACKED = 256;
const bounded = <K, V>(map: Map<K, V>, key: K, value: V): void => {
  map.delete(key); map.set(key, value);
  if (map.size > MAX_TRACKED) map.delete(map.keys().next().value as K);
};
const u32 = (payload: Uint8Array): number =>
  payload.byteLength >= 4 ? (payload[0] | payload[1] << 8 | payload[2] << 16 | payload[3] << 24) >>> 0 : -1;

export interface ControllerOptions { minFree?: number; clock?: Clock; historySize?: number }

export class UiController {
  readonly drafts: DraftEncoder;
  readonly history: RollingStats;
  config: CoordinatorConfig = { ...DEFAULT_COORDINATOR_CONFIG };
  context: DatasetContext | null = null;
  sessionCostUsd = 0;
  private readonly slots = new Map<number, SlotEntry>();
  private readonly pool = new Set<number>();
  private readonly requests = new Map<number, number>();
  private readonly inferStatsByRequest = new Map<number, InferStats>();
  private readonly minFree: number;
  private live: number | null = null;
  private nextSlot = 1;
  private readonly handlers: CardHandlers = {
    view: (slot, view) => this.post({ type: 'view', slot, view }),
    param: (slot, name, value) => this.post({ type: 'param', slot, name, value }),
    exportCsv: slot => this.post({ type: 'export', slot, format: 'csv' }),
    close: slot => this.close(slot),
    gesture: (slot, gesture, timeStamp) => this.gesture(slot, gesture, timeStamp),
    back: (slot, timeStamp, afterClick) => this.back(slot, timeStamp, afterClick),
  };
  private readonly clock: Clock;

  constructor(private readonly port: EnginePort, private readonly host: SlotHost, private readonly rail: RailView, options: ControllerOptions = {}) {
    this.minFree = options.minFree ?? 2;
    this.clock = options.clock ?? { get origin() { return performance.timeOrigin; }, now: () => performance.timeOrigin + performance.now() };
    this.history = new RollingStats(options.historySize ?? 50);
    this.drafts = new DraftEncoder(bytes => port.postMessage({ type: 'frame', bytes }, [bytes]), options.clock);
  }

  // ───────────── UI → engine ─────────────

  /** Boot the engine, register the first slots and send the initial CONFIG. */
  boot(inference: InferencePlacement, dataset: DatasetSource, config: CoordinatorConfig = {}): void {
    this.config = { ...DEFAULT_COORDINATOR_CONFIG, ...config };
    this.post({ type: 'boot', inference, dataset });
    const fresh = this.fillPool();
    this.drafts.config({ ...this.config, freeSlots: fresh });
  }

  /** Hot path: one input/composition event. */
  input(value: string, composing: boolean, eventTimeStamp: number): boolean { return this.drafts.draft(value, composing, eventTimeStamp); }
  commit(value: string, eventTimeStamp: number): void { this.drafts.commit(value, eventTimeStamp); }
  cancel(): void { this.drafts.cancel(0); }

  setConfig(patch: CoordinatorConfig): void {
    const { freeSlots: _ignored, ...rest } = patch;
    this.config = { ...this.config, ...rest };
    this.drafts.config(rest);
  }
  setInference(placement: InferencePlacement): void { this.post({ type: 'inference', placement }); }
  setDataset(source: DatasetSource): void {
    this.post({ type: 'dataset', source });
  }
  resize(slot: number, size: SlotSize): void {
    if (!this.slots.has(slot) || size.width <= 0 || size.height <= 0) return;
    this.post({ type: 'resize', slot, size });
  }

  /** Chart-as-query: send a gesture on `slot`'s chart to the engine, which hit-tests it,
   * rewrites the card's SQL and runs it through the coordinator (docs/batch-2/manipulation.md). */
  gesture(slot: number, gesture: PointerGesture, timeStamp: number): boolean {
    const entry = this.slots.get(slot);
    if (!entry || !entry.sql || !entry.resultRequest || entry.request !== entry.resultRequest) return false;
    entry.pending = { sql: entry.sql, kind: gesture.kind, at: timeStamp };
    this.manipulate(slot, entry, { gesture, keyAt: this.clock.origin + timeStamp });
    return true;
  }

  /** Back to the previous SQL of the card (Escape, double-click, the Back button). */
  back(slot: number, timeStamp: number, afterClick = false): void {
    const entry = this.slots.get(slot);
    if (!entry) return;
    entry.pending = undefined;
    let step = entry.history.pop();
    // A double-click's first click drilled already: undo it as well.
    if (afterClick && step && step.kind === 'point' && timeStamp - step.at < 700) step = entry.history.pop() ?? step;
    if (!step) return;
    entry.card.drill(entry.history.length, 'back');
    this.manipulate(slot, entry, { gesture: { kind: 'sql', sql: step.sql }, keyAt: this.clock.origin + timeStamp });
  }

  private manipulate(slot: number, entry: SlotEntry, m: { gesture: Extract<UiToEngine, { type: 'manipulate' }>['gesture']; keyAt: number }): void {
    this.post({ type: 'manipulate', slot, request: entry.resultRequest, revision: entry.revision, epoch: this.drafts.epoch,
      context: this.drafts.context, sql: entry.sql, gesture: m.gesture, keyAt: m.keyAt, sentAt: this.clock.now() });
  }

  private manipulated(m: Extract<EngineToUi, { type: 'manipulated' }>): void {
    const entry = this.slots.get(m.slot);
    if (!entry) return;
    const pending = entry.pending;
    entry.pending = undefined;
    if (m.sql && m.method !== 'as-is' && pending && pending.sql === m.from) {
      entry.history.push(pending);
      if (entry.history.length > 64) entry.history.shift();
    }
    const note = m.sql ? `${m.method === 'as-is' ? 'back' : m.method} · ${m.ms.toFixed(1)} ms` : m.reason;
    entry.card.drill(entry.history.length, note);
  }

  /** Live slot currently shown, for tests and the app shell. */
  get liveSlot(): number | null { return this.live; }
  get freeSlots(): number[] { return [...this.pool]; }
  get keptSlots(): number[] { return [...this.slots].filter(([, e]) => e.kept).map(([slot]) => slot); }

  /** Close a card: kept cards detach their slot; the live card stops its work and hides. */
  close(slot: number): void {
    const entry = this.slots.get(slot);
    if (!entry) return;
    if (!entry.kept) {
      this.cancel();
      entry.card.hide(); entry.request = 0;
      if (this.live === slot) { this.live = null; this.rail.live(null, 0); }
      return;
    }
    this.post({ type: 'detach', slot });
    entry.card.destroy();
    this.slots.delete(slot);
    for (const [request, s] of this.requests) if (s === slot) this.requests.delete(request);
  }

  /** Remove every kept card and stop live work. */
  clear(): void {
    this.cancel();
    for (const slot of this.keptSlots) this.close(slot);
    if (this.live !== null) { this.slots.get(this.live)?.card.hide(); this.live = null; this.rail.live(null, 0); }
  }

  // ───────────── engine → UI ─────────────

  receive(message: EngineToUi): void {
    switch (message.type) {
      case 'frame': {
        let frame: Frame;
        try { frame = decode(new Uint8Array(message.bytes)); }
        catch (error) { this.rail.error({ code: 'decode', message: 'Unreadable frame from the engine', detail: String(error) }, 0); return; }
        this.frame(frame);
        return;
      }
      case 'context':
        this.context = message.context; this.drafts.context = message.context.id; this.rail.context(message.context); return;
      case 'views': this.slots.get(message.slot)?.card.views(message.available, message.chosen, message.columns); return;
      case 'table': this.slots.get(message.slot)?.card.table(message.columns, message.rows, message.total); return;
      case 'axes': this.slots.get(message.slot)?.card.axes(message.ticks); return;
      case 'export': this.host.download(message.blob, message.filename); return;
      case 'manipulated': this.manipulated(message); return;
    }
  }

  private frame(frame: Frame): void {
    switch (frame.kind) {
      case Kind.BIND: return this.bind(u32(frame.payload), frame.request, frame.revision);
      case Kind.UNBIND: return this.unbind(u32(frame.payload), frame.request);
      case Kind.KEEP: return this.keep(u32(frame.payload), frame.request, frame.revision);
      case Kind.RESULT: {
        const info = this.json<ResultInfo>(frame); if (!info) return;
        const slot = this.slots.has(info.slot) ? info.slot : this.requests.get(frame.request);
        const entry = slot === undefined ? undefined : this.slots.get(slot);
        if (entry) {
          entry.card.result(info, frame.request);
          if (entry.request === frame.request) { entry.sql = info.sql; entry.resultRequest = frame.request; }
        }
        return;
      }
      case Kind.TIMING: {
        const t = breakdown(frame.stamps, frame.request, frame.revision);
        if (t.headline !== null) this.history.add(t.headline);
        const slot = this.requests.get(frame.request);
        if (slot !== undefined) this.slots.get(slot)?.card.timing(t);
        this.rail.timing(t, this.history.summary(), this.inferStatsByRequest.get(frame.request));
        return;
      }
      case Kind.INFER_STATS: {
        const stats = this.json<InferStats>(frame); if (!stats) return;
        bounded(this.inferStatsByRequest, frame.request, stats);
        if (typeof stats.costUsd === 'number' && Number.isFinite(stats.costUsd)) this.sessionCostUsd += stats.costUsd;
        const slot = this.requests.get(frame.request);
        if (slot !== undefined) this.slots.get(slot)?.card.inferStats(stats);
        this.rail.inferStats(frame.request, stats, this.sessionCostUsd);
        return;
      }
      case Kind.STATUS: { const s = this.json<StatusInfo>(frame); if (s) this.rail.status(s); return; }
      case Kind.ERROR: {
        const e = this.json<ErrorInfo>(frame); if (!e) return;
        const slot = frame.request ? this.requests.get(frame.request) : undefined;
        const entry = slot === undefined ? undefined : this.slots.get(slot);
        if (entry && entry.request === frame.request) entry.card.error(e);
        this.rail.error(e, frame.request);
        return;
      }
      case Kind.CONTEXT: {
        const c = this.json<DatasetContext>(frame);
        if (c) this.receive({ type: 'context', context: c });
        return;
      }
      default: return; // other kinds never reach the UI
    }
  }

  private bind(slot: number, request: number, revision: number): void {
    const entry = this.slots.get(slot);
    if (!entry) return;
    entry.request = request; entry.revision = revision;
    if (revision !== entry.historyRevision) {
      // A new question in this card: its drill history no longer applies.
      entry.historyRevision = revision; entry.pending = undefined;
      if (entry.history.length) { entry.history.length = 0; entry.card.drill(0, ''); }
    }
    bounded(this.requests, request, slot);
    const text = this.drafts.textOf(revision);
    if (text !== undefined) entry.card.title(text, revision);
    if (entry.kept) return;
    if (this.live !== null && this.live !== slot) this.slots.get(this.live)?.card.hide();
    this.live = slot;
    entry.card.showLive();
    this.rail.live(slot, revision);
  }

  private unbind(slot: number, request: number): void {
    const entry = this.slots.get(slot);
    if (!entry || (request && entry.request && entry.request !== request)) return;
    entry.request = 0;
    if (entry.kept) return;
    entry.card.hide();
    if (this.live === slot) { this.live = null; this.rail.live(null, 0); }
  }

  private keep(slot: number, request: number, revision: number): void {
    const entry = this.slots.get(slot);
    if (!entry || entry.kept) return;
    entry.kept = true;
    this.pool.delete(slot);
    if (request) { entry.request = request; bounded(this.requests, request, slot); }
    if (revision) {
      entry.revision = revision;
      const text = this.drafts.textOf(revision);
      if (text !== undefined) entry.card.title(text, revision);
    }
    entry.card.keep();
    this.rail.kept(slot, this.drafts.textOf(entry.revision) ?? '');
    if (this.live === slot) { this.live = null; this.rail.live(null, 0); }
    const fresh = this.fillPool();
    if (fresh.length) this.drafts.config({ freeSlots: fresh });
  }

  /** Attach new slots until the pool holds `minFree`. Returns the new slot ids. */
  private fillPool(): number[] {
    const fresh: number[] = [];
    while (this.pool.size < this.minFree) {
      const slot = this.nextSlot++;
      const { card, canvas, size } = this.host.create(slot, this.handlers);
      this.slots.set(slot, { card, kept: false, request: 0, revision: 0, sql: '', resultRequest: 0, history: [], historyRevision: 0 });
      this.pool.add(slot);
      this.post({ type: 'attach', slot, canvas, size }, [canvas]);
      fresh.push(slot);
    }
    return fresh;
  }

  private json<T>(frame: Frame): T | null {
    try { return readJson<T>(frame.payload); }
    catch (error) {
      this.rail.error({ code: 'decode', message: `Unreadable ${Kind_NAMES[frame.kind] ?? frame.kind} payload`, detail: safeText(frame.payload) || String(error) }, frame.request);
      return null;
    }
  }

  private post(message: UiToEngine, transfer?: Transferable[]): void {
    if (transfer) this.port.postMessage(message, transfer); else this.port.postMessage(message);
  }
}

const Kind_NAMES: Record<number, string> = Object.fromEntries(Object.entries(Kind).map(([name, value]) => [value, name]));
const safeText = (payload: Uint8Array): string => { try { return readText(payload).slice(0, 200); } catch { return ''; } };

/** Coalesces per-slot resizes to one message per slot per animation frame. */
export class ResizeBatcher {
  private readonly pending = new Map<number, SlotSize>();
  private scheduled = false;
  constructor(private readonly flushTo: (slot: number, size: SlotSize) => void, private readonly schedule: (callback: () => void) => void = callback => requestAnimationFrame(() => callback())) {}
  push(slot: number, size: SlotSize): void {
    this.pending.set(slot, size);
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => this.flush());
  }
  flush(): void {
    this.scheduled = false;
    for (const [slot, size] of this.pending) this.flushTo(slot, size);
    this.pending.clear();
  }
}
