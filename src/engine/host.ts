/**
 * Engine host: owns the coordinator, database and renderer nodes inside the engine worker and
 * routes frames between them, the UI and the inference link (routing rules: the comment
 * above the factories in src/engine/contracts.ts).
 *
 *   database → RESULT_SCHEMA/BATCH: renderer gets the Arrow object first (drawing is the goal),
 *              then the coordinator gets a HEADER_ONLY copy; DONE to both; everything else
 *              (ERROR, STATUS, CONTEXT) to the coordinator.
 *   renderer → coordinator (DRAWN).
 *   coordinator outbox → by LinkId; `ui` frames are encoded and their buffer transferred.
 *
 * Coordinator input is serialized: a frame produced while the coordinator's outbox is being
 * routed (a database emit inside database.handle, a DRAWN inside renderer.handle) is queued
 * and fed after the current one, so the coordinator is never re-entered. Nodes start
 * creating as soon as the host exists; anything arriving earlier is queued (bounded).
 * Dependencies are injected so routing, queuing and tick scheduling are testable in Node.
 */
import type {
  CoordinatorCore, CreateCoordinator, StatusComponent, CreateDatabase, CreateRenderer, DatabaseNode, DatasetContext, DatasetSource,
  InferencePlacement, Link, LinkId, LocalFrame, PostToUi, RendererNode, UiToEngine,
} from './contracts';
import { decode, encode, Flag, header, json, Kind, Node, readJson, SENDER_REQUEST_BIT, Stage, now as clockNow, type Frame } from '../protocol/frame';
import { CachedTools, manipulate, type SqlTools } from './manipulate';
import { PrimedTranslations } from './prime';
import { yieldToEventLoop } from './yield';
import { bootClock, bootMark } from './boot-trace';

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface HostDeps {
  createCoordinator: CreateCoordinator;
  createRenderer: CreateRenderer;
  createDatabase: CreateDatabase;
  postToUi: PostToUi;
  /** Open the inference link for a placement; it must send HELLO itself. */
  connectInference: (placement: InferencePlacement) => Link;
  now?: () => number;
  timers?: Timers;
  /** Bound for every pre-ready queue. */
  maxQueued?: number;
  /** Reconnect delays after the inference link closes (ms); the last one repeats. */
  reconnectDelays?: number[];
}

/** A coordinator input: decoded (in-process) or still encoded (straight off the UI port). */
type Input = [LinkId, Frame<Uint8Array> | Uint8Array];

type RenderControl = Extract<UiToEngine, { type: 'attach' | 'resize' | 'detach' | 'view' | 'param' | 'presentation' | 'export' | 'snapshot' }>;

const EMPTY = new Uint8Array(0);
const defaultTimers: Timers = { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as number) };

/** Pre-ready queue: bounded; on overflow the oldest entry is dropped and counted. */
class Backlog<T> {
  items: T[] = [];
  dropped = 0;
  constructor(private readonly max: number) {}
  push(item: T): void {
    if (this.items.length >= this.max) { this.items.shift(); this.dropped++; }
    this.items.push(item);
  }
  take(): T[] { const items = this.items; this.items = []; return items; }
}

export class EngineHost {
  coordinator?: CoordinatorCore;
  renderer?: RendererNode;
  database?: DatabaseNode;
  inference?: Link;
  /** Resolves when all three nodes exist (rejects if one fails to start). */
  readonly ready: Promise<void>;
  /** PRIMEd question → SQL pairs answered at the edge of the inference link (src/engine/prime.ts). */
  readonly primed: PrimedTranslations;

  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly coordinatorInbox: Backlog<Input>;
  private readonly databaseReady: Promise<DatabaseNode>;
  private placement?: InferencePlacement;
  private reconnectAttempt = 0;
  private reconnectTimer: unknown;
  private readonly rendererBacklog: Backlog<LocalFrame>;
  private readonly controlBacklog: Backlog<RenderControl>;
  private readonly databaseBacklog: Backlog<Frame<Uint8Array>>;
  private readonly inferenceBacklog: Backlog<Frame<Uint8Array>>;
  private feeding = false;
  private timer: unknown;
  private timerAt = Infinity;
  private timerGeneration = 0;
  private contextSeq = 0;
  private opening: Promise<unknown> = Promise.resolve();
  /** The open dataset (dialect and column names for chart-as-query rewrites). */
  private context?: DatasetContext;
  private columns?: Set<string>;
  /** DuckDB's parser behind a memo (undefined: not looked up yet; null: unavailable). */
  private tools?: CachedTools | null;
  private disposed = false;
  private readonly targets = new Map<number, { generation: number; active: boolean; request?: number; manualViewRevision?: number }>();
  private readonly executions = new Map<number, { epoch: number; context: number }>();
  private readonly renderBindings = new Map<number, number>();

  constructor(private readonly deps: HostDeps) {
    this.now = deps.now ?? clockNow;
    this.timers = deps.timers ?? defaultTimers;
    const max = deps.maxQueued ?? 1024;
    this.coordinatorInbox = new Backlog(max);
    this.rendererBacklog = new Backlog(max);
    this.controlBacklog = new Backlog(max);
    this.databaseBacklog = new Backlog(max);
    this.inferenceBacklog = new Backlog(max);
    this.primed = new PrimedTranslations(this.now);

    const coordinator = deps.createCoordinator().then(core => {
      this.coordinator = core;
      bootMark('coordinator.ready');
      this.statusToUi('coordinator', 'ready', 'Coordinator ready');
      this.feedCoordinator();
    });
    const renderer = deps.createRenderer(frame => this.fromRenderer(frame), (message, transfer) => {
      if ('slot' in message) {
        const target = this.targets.get(message.slot);
        if (target) {
          if (!target.active || !('request' in message) || message.request === undefined || message.request !== target.request) return;
          message = { ...message, generation: target.generation };
        }
      }
      deps.postToUi(message, transfer);
    })
      .then(node => {
        this.renderer = node;
        bootMark('renderer.ready');
        for (const control of this.controlBacklog.take()) this.control(control);
        for (const frame of this.rendererBacklog.take()) if (this.admitsQueuedRender(frame)) node.handle(this.preserveManualView(frame));
        this.feedCoordinator();
      });
    this.databaseReady = deps.createDatabase(frame => this.fromDatabase(frame)).then(node => {
      this.database = node;
      for (const frame of this.databaseBacklog.take()) node.handle(frame);
      this.feedCoordinator();
      return node;
    });
    const database = this.databaseReady;
    const report = (component: StatusComponent) => (error: unknown) => {
      this.statusToUi(component, 'error', `${component} failed to start`, String(error instanceof Error ? error.message : error));
      throw error;
    };
    this.ready = Promise.all([coordinator.catch(report('coordinator')), renderer.catch(report('renderer')), database.catch(report('database'))])
      .then(() => undefined);
    this.ready.catch(() => { /* reported to the UI as STATUS */ });
  }

  // ───────────────────────── UI → engine ─────────────────────────

  onMessage(message: UiToEngine): void {
    if (this.disposed) return;
    switch (message.type) {
      case 'frame': {
        const bytes = new Uint8Array(message.bytes);
        // Suggestions (docs/batch-2/voice-anticipation.md): PRIME goes to the inference edge, a
        // WARM EXEC straight to the database. Everything else is encoded straight into the
        // coordinator: no decode + re-encode in JS.
        if (bytes[1] === Kind.PRIME || bytes[1] === Kind.EXEC) { this.fromUiSide(bytes); return; }
        this.toCoordinator('ui', bytes);
        return;
      }
      case 'boot':
        bootMark('boot.message');
        this.setInference(message.inference);
        void this.openDataset(message.dataset).then(context => {
          if (message.token) this.deps.postToUi({ type: 'activation', token: message.token, context: context ?? null });
        });
        return;
      case 'dataset':
        void this.openDataset(message.source).then(context => {
          if (message.token) this.deps.postToUi({ type: 'activation', token: message.token, context: context ?? null });
        });
        return;
      case 'inference': this.setInference(message.placement); return;
      case 'manipulate': this.manipulate(message); return;
      default: this.control(message);
    }
  }

  /** PRIME and WARM EXEC from the UI. Only WARM EXECs with sender-assigned request ids pass:
   * a UI can never start visible work behind the coordinator's back. */
  private fromUiSide(bytes: Uint8Array): void {
    let frame: Frame<Uint8Array>;
    try { frame = decode(bytes); } catch { return; }
    if (frame.kind === Kind.PRIME) { this.primed.prime(frame); return; }
    if (!(frame.flags & Flag.WARM) || !(frame.request & SENDER_REQUEST_BIT)) return;
    if (this.database) this.database.handle(frame);
    else this.databaseBacklog.push(frame);
  }

  /** Chart-as-query (docs/batch-2/manipulation.md): hit-test → deterministic SQL change → QUERY
   * frame into the coordinator on the UI link, as if the UI had sent it. No model call. The
   * stamps are the pointer event (KEY_INPUT), the post (DRAFT_SENT), both from the UI, and the end
   * of the rewrite (SQL_COMPLETE, engine worker). */
  private manipulate(m: Extract<UiToEngine, { type: 'manipulate' }>): void {
    if (!this.admitsControl(m) || m.context !== this.context?.id) return;
    const t0 = performance.now();
    let out: { sql: string | null; method: 'rewrite' | 'wrap' | 'as-is' | 'none'; reason: string };
    if (m.gesture.kind === 'sql') out = { sql: m.gesture.sql, method: 'as-is', reason: 'back' };
    else {
      const hit = this.renderer?.hit(m.slot, m.request, m.gesture) ?? null;
      if (!hit) out = { sql: null, method: 'none', reason: 'nothing under the pointer (or the result changed)' };
      else {
        if (this.tools === undefined) {
          const raw = (this.database as { sqlTools?: () => SqlTools | undefined } | undefined)?.sqlTools?.();
          this.tools = raw ? new CachedTools(raw) : null;
        }
        out = manipulate(m.sql, hit, m.gesture, { tools: this.tools ?? undefined, dialect: this.context?.dialect ?? 'duckdb', columns: this.columns });
      }
    }
    const ms = performance.now() - t0;
    this.deps.postToUi({ type: 'manipulated', slot: m.slot, request: m.request, generation: m.generation, from: m.sql, sql: out.sql, method: out.method, reason: out.reason, ms });
    if (!out.sql || m.prepareOnly) return;
    const sql = new TextEncoder().encode(out.sql);
    const payload = new Uint8Array(4 + sql.byteLength);
    new DataView(payload.buffer).setUint32(0, m.slot, true);
    payload.set(sql, 4);
    this.toCoordinator('ui', {
      ...header(Kind.QUERY, { request: m.generation ?? 0, epoch: m.epoch, revision: m.revision, context: m.context }),
      stamps: [
        { stage: Stage.KEY_INPUT, node: Node.UI, at: m.keyAt },
        { stage: Stage.DRAFT_SENT, node: Node.UI, at: m.sentAt },
        { stage: Stage.SQL_COMPLETE, node: Node.COORDINATOR, at: this.now() },
      ],
      payload,
    });
  }

  private control(message: RenderControl): void {
    const renderer = this.renderer;
    if (!renderer) { this.controlBacklog.push(message); return; }
    if (message.type === 'snapshot') { renderer.snapshot?.(message.id, message.slots, message.devicePixelRatio); return; }
    if (message.type === 'detach') {
      const target = this.targets.get(message.slot);
      if (target && target.generation !== message.generation) return;
    } else if (message.type !== 'attach' && message.type !== 'resize' && !this.admitsControl(message)) return;
    switch (message.type) {
      case 'attach': renderer.attach(message.slot, message.canvas, message.size, message.dormant); break;
      case 'resize': renderer.resize(message.slot, message.size); break;
      case 'detach': renderer.detach(message.slot); this.targets.delete(message.slot); break;
      case 'view': renderer.setView(message.slot, message.view); break;
      case 'param': renderer.setParam(message.slot, message.name, message.value); break;
      case 'presentation': {
        const target = this.targets.get(message.slot);
        if (target && message.manualViewRevision !== undefined) target.manualViewRevision = Math.max(target.manualViewRevision ?? 0, message.manualViewRevision);
        renderer.setPresentation(message.slot, message.presentation); break;
      }
      case 'export': renderer.export(message.slot, message.format); break;
    }
  }

  private admitsControl(message: { slot: number; generation?: number; request?: number }): boolean {
    const target = this.targets.get(message.slot);
    if (!target) return message.generation === undefined;
    return target.active && message.generation === target.generation
      && (message.request === undefined || message.request === target.request);
  }

  // ───────────────────────── datasets and inference ─────────────────────────

  /** Opens are serialized; each gets a new context id. Returns the context, or undefined if
   * a newer open superseded this one or loading failed (the database reports STATUS). */
  openDataset(source: DatasetSource): Promise<DatasetContext | undefined> {
    const id = ++this.contextSeq;
    const run = async () => {
      const o0 = bootClock();
      let database: DatabaseNode;
      try { database = await this.databaseReady; } catch { return undefined; }
      if (id !== this.contextSeq || this.disposed) return undefined;
      // Opening can cancel the database's old queue even if loading fails. Terminate
      // those executions before touching the source, so none can later commit.
      this.context = undefined;
      this.columns = undefined;
      this.tools = undefined;
      this.toCoordinator('database', { ...header(Kind.CONTEXT, { context: 0 }), stamps: [], payload: json({ id: 0, tables: [] }) });
      let context: DatasetContext;
      try {
        context = await database.open(source, id);
      } catch (error) {
        this.toCoordinator('database', {
          ...header(Kind.ERROR, {}), stamps: [],
          payload: json({ code: 'dataset', message: error instanceof Error ? error.message : String(error) }),
        });
        return undefined;
      }
      if (id !== this.contextSeq || this.disposed) return undefined;
      this.context = context;
      this.tools = undefined;
      this.columns = new Set(context.tables.flatMap(t => t.columns.map(c => c.name.toLowerCase())));
      this.toCoordinator('database', { ...header(Kind.CONTEXT, { context: context.id }), stamps: [], payload: json(context) });
      this.deps.postToUi({ type: 'context', context });
      bootMark('dataset.open', o0, source.name);
      return context;
    };
    const result = this.opening.then(run, run);
    this.opening = result;
    return result;
  }

  /** Switch the inference placement. A link that closes is reconnected with backoff; the
   * new link's READY makes the coordinator resend CONTEXT and retry in-flight work. A closed
   * link is not a coordinator input; the UI sees a STATUS frame. */
  setInference(placement: InferencePlacement): void {
    this.placement = placement;
    this.reconnectAttempt = 0;
    this.connect();
  }

  private connect(): void {
    const placement = this.placement;
    if (!placement || this.disposed) return;
    if (this.reconnectTimer !== undefined) { this.timers.clear(this.reconnectTimer); this.reconnectTimer = undefined; }
    const previous = this.inference;
    this.inference = undefined;
    previous?.close();
    let link: Link;
    try {
      link = this.deps.connectInference(placement);
    } catch (error) {
      this.linkLost(String(error instanceof Error ? error.message : error));
      return;
    }
    this.inference = link;
    link.listen(frame => {
      if (this.inference !== link) return;
      if (frame.kind === Kind.READY) {
        this.reconnectAttempt = 0;
        bootMark('inference.ready');
        let model = '';
        try { model = (readJson<{ model?: string }>(frame.payload as Uint8Array).model) ?? ''; } catch { /* READY payload is optional detail */ }
        let capabilities: string[] = [];
        try {
          const value = readJson<{ capabilities?: unknown }>(frame.payload as Uint8Array).capabilities;
          if (Array.isArray(value)) capabilities = value.filter((v): v is string => typeof v === 'string');
        } catch { /* Older nodes need not advertise capabilities. */ }
        this.deps.postToUi({ type: 'capabilities', component: 'inference', capabilities });
        this.statusToUi('inference', 'ready', model ? `Inference ready · ${model}` : 'Inference ready');
      }
      this.toCoordinator('inference', frame as Frame<Uint8Array>);
    }, reason => {
      if (this.inference !== link) return;
      this.inference = undefined;
      this.linkLost(reason);
    });
    for (const frame of this.inferenceBacklog.take()) link.send(frame);
  }

  private linkLost(reason: string): void {
    const delays = this.deps.reconnectDelays ?? [250, 1000, 4000];
    const delay = delays[Math.min(this.reconnectAttempt++, delays.length - 1)];
    this.statusToUi('inference', 'error', 'Inference link closed; reconnecting', reason);
    this.reconnectTimer = this.timers.set(() => { this.reconnectTimer = undefined; this.connect(); }, delay);
  }

  // ───────────────────────── node outputs ─────────────────────────

  private fromDatabase(frame: LocalFrame): void {
    if (frame.request & SENDER_REQUEST_BIT) {
      // Answers to a UI's WARM EXEC (DONE or ERROR) go back to the UI only.
      if (frame.kind === Kind.DONE || frame.kind === Kind.ERROR) {
        const bytes = encode(frame as Frame<Uint8Array>);
        this.deps.postToUi({ type: 'frame', bytes: bytes.buffer as ArrayBuffer }, [bytes.buffer as ArrayBuffer]);
      }
      return;
    }
    if (frame.request && (frame.kind === Kind.RESULT_SCHEMA || frame.kind === Kind.BATCH || frame.kind === Kind.DONE || frame.kind === Kind.ERROR)) {
      const execution = this.executions.get(frame.request);
      if (!execution || execution.epoch !== frame.epoch || execution.context !== frame.context) return;
      if (frame.kind === Kind.DONE || frame.kind === Kind.ERROR) this.executions.delete(frame.request);
    }
    switch (frame.kind) {
      case Kind.RESULT_SCHEMA:
      case Kind.BATCH:
        this.toRenderer(frame);
        this.toCoordinator('database', { ...frame, flags: frame.flags | Flag.HEADER_ONLY, payload: EMPTY });
        return;
      case Kind.DONE:
        this.toRenderer(frame);
        this.toCoordinator('database', frame as Frame<Uint8Array>);
        return;
      default:
        this.toCoordinator('database', frame as Frame<Uint8Array>);
    }
  }

  private fromRenderer(frame: LocalFrame): void {
    this.toCoordinator('renderer', frame as Frame<Uint8Array>);
  }

  private toRenderer(frame: LocalFrame): void {
    if (frame.payload instanceof Uint8Array) {
      const payload = frame.payload;
      const p = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      if ((frame.kind === Kind.REGISTER_TARGET || frame.kind === Kind.RELEASE_TARGET) && p.byteLength === 8) {
        const slot = p.getUint32(0, true), generation = p.getUint32(4, true);
        const target = this.targets.get(slot);
        if (frame.kind === Kind.REGISTER_TARGET) {
          if (target && target.generation >= generation) return;
          this.targets.set(slot, { generation, active: true });
        } else {
          if (target && target.generation > generation) return;
          this.targets.set(slot, { generation, active: false });
        }
        this.renderBindings.delete(slot);
      } else if ((frame.kind === Kind.BIND || frame.kind === Kind.UNBIND) && p.byteLength >= 4) {
        const slot = p.getUint32(0, true), target = this.targets.get(slot);
        if (target) {
          if (!target.active || p.byteLength < 12 || target.generation !== p.getUint32(8, true)) return;
          if (frame.kind === Kind.BIND) target.request = frame.request;
          else if (target.request === frame.request) target.request = undefined;
        } else if (p.byteLength >= 12) return;
        if (frame.kind === Kind.BIND) this.renderBindings.set(slot, frame.request);
        else if (this.renderBindings.get(slot) === frame.request) this.renderBindings.delete(slot);
      }
    }
    if (this.renderer) this.renderer.handle(this.preserveManualView(frame));
    else this.rendererBacklog.push(frame);
  }

  /** A picker change made after a question takes precedence over that question's
   * late view hint. The next question sequence may explicitly request a new view. */
  private preserveManualView(frame: LocalFrame): LocalFrame {
    if (frame.kind !== Kind.BIND || !(frame.payload instanceof Uint8Array) || frame.payload.byteLength !== 12) return frame;
    const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
    const target = this.targets.get(view.getUint32(0, true));
    if (target?.manualViewRevision === undefined || frame.revision > target.manualViewRevision) return frame;
    const payload = frame.payload.slice(); new DataView(payload.buffer).setUint32(4, 256, true);
    return { ...frame, payload };
  }

  /** Startup can outlast several edits. Replaying an obsolete batch can draw
   * synchronously, so reject it before the renderer ever sees it. */
  private admitsQueuedRender(frame: LocalFrame): boolean {
    if (frame.kind === Kind.REGISTER_TARGET || frame.kind === Kind.RELEASE_TARGET || frame.kind === Kind.BIND || frame.kind === Kind.UNBIND) {
      const bytes = frame.payload as Uint8Array;
      if (bytes.byteLength < 4) return false;
      const p = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), slot = p.getUint32(0, true);
      const target = this.targets.get(slot);
      if (frame.kind === Kind.REGISTER_TARGET || frame.kind === Kind.RELEASE_TARGET) {
        return !!target && target.generation === p.getUint32(4, true) && target.active === (frame.kind === Kind.REGISTER_TARGET);
      }
      if (target && (!target.active || p.byteLength < 12 || target.generation !== p.getUint32(8, true))) return false;
      return frame.kind === Kind.BIND ? this.renderBindings.get(slot) === frame.request : !this.renderBindings.has(slot);
    }
    if (frame.kind === Kind.RESULT_SCHEMA || frame.kind === Kind.BATCH || frame.kind === Kind.DONE) {
      return [...this.renderBindings.values()].includes(frame.request);
    }
    return true;
  }

  // ───────────────────────── coordinator ─────────────────────────

  private toCoordinator(link: LinkId, frame: Frame<Uint8Array> | Uint8Array): void {
    this.coordinatorInbox.push([link, frame]);
    this.feedCoordinator();
  }

  /** Feed queued inputs one at a time, routing each one's outbox before the next. */
  private feedCoordinator(): void {
    const coordinator = this.coordinator;
    if (!coordinator || this.feeding || this.disposed) return;
    this.feeding = true;
    try {
      const inbox = this.coordinatorInbox;
      while (inbox.items.length) {
        const [link, frame] = inbox.items.shift()!;
        if (frame instanceof Uint8Array) coordinator.inputEncoded(link, frame, this.now());
        else coordinator.input(link, frame, this.now());
        this.route(coordinator.drainEncoded());
      }
    } finally {
      this.feeding = false;
    }
    this.schedule();
  }

  private route(outputs: Array<[LinkId, Uint8Array]>): void {
    for (const [link, encoded] of outputs) {
      if (link === 'ui') {
        // Already encoded in its own buffer: transfer it as is.
        this.deps.postToUi({ type: 'frame', bytes: encoded.buffer as ArrayBuffer }, [encoded.buffer as ArrayBuffer]);
        continue;
      }
      const frame = decode(encoded); // payload is a view, not a copy
      switch (link) {
        case 'renderer': this.toRenderer(frame); break;
        case 'database':
          if (frame.kind === Kind.EXEC) this.executions.set(frame.request, { epoch: frame.epoch, context: frame.context });
          else if (frame.kind === Kind.CANCEL) {
            const cancelled = frame.request ? [frame.request] : [...this.executions.keys()];
            for (const request of cancelled) for (const [slot, bound] of this.renderBindings) if (bound === request) {
              this.renderBindings.delete(slot);
              const target = this.targets.get(slot); if (target?.request === request) target.request = undefined;
            }
            if (frame.request) this.executions.delete(frame.request);
            else this.executions.clear();
          }
          if (this.database) this.database.handle(frame);
          else this.databaseBacklog.push(frame);
          break;
        case 'inference': {
          const primed = this.primed.answer(frame);
          if (primed) { for (const answer of primed) this.toCoordinator('inference', answer); break; }
          if (this.inference) this.inference.send(frame);
          else this.inferenceBacklog.push(frame);
          break;
        }
      }
    }
  }

  /** Keep one timer armed for the coordinator's earliest deadline. */
  private schedule(): void {
    const coordinator = this.coordinator;
    if (!coordinator || this.disposed) return;
    const deadline = coordinator.nextDeadline();
    if (deadline === null) { this.disarm(); return; }
    if (deadline === this.timerAt) return;
    this.disarm();
    this.timerAt = deadline;
    const generation = ++this.timerGeneration;
    const fire = () => {
      if (generation !== this.timerGeneration || this.disposed) return;
      this.timer = undefined;
      this.timerAt = Infinity;
      this.tick();
    };
    const delay = deadline - this.now();
    // setTimeout clamps nested timers to 4 ms; sub-millisecond deadlines go through a
    // MessageChannel turn instead.
    if (delay < 1) void yieldToEventLoop().then(fire);
    else this.timer = this.timers.set(fire, delay);
  }

  private disarm(): void {
    this.timerGeneration++;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    this.timerAt = Infinity;
  }

  private tick(): void {
    const coordinator = this.coordinator;
    if (!coordinator) return;
    if (this.feeding) { this.schedule(); return; }
    this.feeding = true;
    try {
      coordinator.tick(this.now());
      this.route(coordinator.drainEncoded());
    } finally {
      this.feeding = false;
    }
    this.feedCoordinator();
    this.schedule();
  }

  // ───────────────────────── misc ─────────────────────────

  private statusToUi(component: StatusComponent, state: 'error' | 'loading' | 'ready', label: string, detail?: string): void {
    const bytes = encode({ ...header(Kind.STATUS, {}), stamps: [], payload: json({ component, state, label, ...(detail ? { detail } : {}) }) });
    this.deps.postToUi({ type: 'frame', bytes: bytes.buffer as ArrayBuffer }, [bytes.buffer as ArrayBuffer]);
  }

  /** Frames dropped from full pre-ready queues, for diagnostics. */
  droppedFrames(): number {
    return this.coordinatorInbox.dropped + this.rendererBacklog.dropped + this.controlBacklog.dropped
      + this.databaseBacklog.dropped + this.inferenceBacklog.dropped;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disarm();
    if (this.reconnectTimer !== undefined) this.timers.clear(this.reconnectTimer);
    this.inference?.close();
    this.database?.dispose();
    this.coordinator?.dispose();
  }
}
