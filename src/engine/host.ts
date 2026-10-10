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
import { encode, Flag, header, json, Kind, now as clockNow, type Frame } from '../protocol/frame';
import { yieldToEventLoop } from './yield';

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

type RenderControl = Extract<UiToEngine, { type: 'attach' | 'resize' | 'detach' | 'view' | 'param' | 'export' }>;

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
  private disposed = false;

  constructor(private readonly deps: HostDeps) {
    this.now = deps.now ?? clockNow;
    this.timers = deps.timers ?? defaultTimers;
    const max = deps.maxQueued ?? 1024;
    this.coordinatorInbox = new Backlog(max);
    this.rendererBacklog = new Backlog(max);
    this.controlBacklog = new Backlog(max);
    this.databaseBacklog = new Backlog(max);
    this.inferenceBacklog = new Backlog(max);

    const coordinator = deps.createCoordinator().then(core => {
      this.coordinator = core;
      this.feedCoordinator();
    });
    const renderer = deps.createRenderer(frame => this.fromRenderer(frame), (message, transfer) => deps.postToUi(message, transfer))
      .then(node => {
        this.renderer = node;
        for (const control of this.controlBacklog.take()) this.control(control);
        for (const frame of this.rendererBacklog.take()) node.handle(frame);
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
      case 'frame':
        // Encoded straight into the coordinator: no decode + re-encode in JS.
        this.toCoordinator('ui', new Uint8Array(message.bytes));
        return;
      case 'boot':
        this.setInference(message.inference);
        void this.openDataset(message.dataset);
        return;
      case 'dataset': void this.openDataset(message.source); return;
      case 'inference': this.setInference(message.placement); return;
      default: this.control(message);
    }
  }

  private control(message: RenderControl): void {
    const renderer = this.renderer;
    if (!renderer) { this.controlBacklog.push(message); return; }
    switch (message.type) {
      case 'attach': renderer.attach(message.slot, message.canvas, message.size); break;
      case 'resize': renderer.resize(message.slot, message.size); break;
      case 'detach': renderer.detach(message.slot); break;
      case 'view': renderer.setView(message.slot, message.view); break;
      case 'param': renderer.setParam(message.slot, message.name, message.value); break;
      case 'export': {
        // Not in RendererNode yet (requested contract change): call it if the renderer has it.
        const exporter = (renderer as RendererNode & { export?: (slot: number, format: 'csv') => void }).export;
        exporter?.call(renderer, message.slot, message.format);
        break;
      }
    }
  }

  // ───────────────────────── datasets and inference ─────────────────────────

  /** Opens are serialized; each gets a new context id. Returns the context, or undefined if
   * a newer open superseded this one or loading failed (the database reports STATUS). */
  openDataset(source: DatasetSource): Promise<DatasetContext | undefined> {
    const id = ++this.contextSeq;
    const run = async () => {
      let database: DatabaseNode;
      try { database = await this.databaseReady; } catch { return undefined; }
      if (id !== this.contextSeq || this.disposed) return undefined;
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
      this.toCoordinator('database', { ...header(Kind.CONTEXT, { context: context.id }), stamps: [], payload: json(context) });
      this.deps.postToUi({ type: 'context', context });
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
      if (frame.kind === Kind.READY) this.reconnectAttempt = 0;
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
    if (this.renderer) this.renderer.handle(frame);
    else this.rendererBacklog.push(frame);
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
        this.route(coordinator.drain());
      }
    } finally {
      this.feeding = false;
    }
    this.schedule();
  }

  private route(outputs: Array<[LinkId, Frame<Uint8Array>]>): void {
    for (const [link, frame] of outputs) {
      switch (link) {
        case 'ui': {
          const bytes = encode(frame);
          this.deps.postToUi({ type: 'frame', bytes: bytes.buffer as ArrayBuffer }, [bytes.buffer as ArrayBuffer]);
          break;
        }
        case 'renderer': this.toRenderer(frame); break;
        case 'database':
          if (this.database) this.database.handle(frame);
          else this.databaseBacklog.push(frame);
          break;
        case 'inference':
          if (this.inference) this.inference.send(frame);
          else this.inferenceBacklog.push(frame);
          break;
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
      this.route(coordinator.drain());
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
