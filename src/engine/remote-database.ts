/**
 * Remote database placement: the database node runs on a server (crates/database-server,
 * ClickHouse) and the engine reaches it over a `tb1` WebSocket `Link`. To the engine host it
 * is just another `DatabaseNode`: the host routes EXEC/CANCEL into `handle()` and receives
 * RESULT_SCHEMA/BATCH/DONE/ERROR/STATUS through `emit`, exactly as with the in-browser DuckDB
 * node. Coordinator, renderer, UI and the host's routing are unchanged; only the link differs
 * (docs/protocol-v1.md "Nodes and links", docs/batch-1/remote-database.md).
 *
 * The one thing a remote link adds is the Arrow decode: RESULT_SCHEMA/BATCH arrive as Arrow
 * IPC encapsulated messages and leave this adapter as `Schema`/`RecordBatch` objects for the
 * in-process renderer. Column buffers are **views into the received WebSocket message**: the
 * frame payload starts 8-aligned in its ArrayBuffer and the server keeps Arrow bodies 8-aligned
 * inside it, so apache-arrow builds typed arrays in place (no copy; tests/remote-database.test.ts).
 *
 * Node semantics kept identical to the browser node:
 * - A cancelled request emits nothing: frames already on the wire for a cancelled request (or
 *   an older epoch) are dropped here.
 * - EXEC for another context is dropped. The context id is the host's: HELLO carries it
 *   (`{"context": id}`) and the server answers CONTEXT with that id.
 * - If the link drops, in-flight requests get ERROR `unavailable`, STATUS reports the outage
 *   and the link reconnects with backoff (HELLO with the same context, then the last epoch).
 */
import type { CreateDatabase, DatabaseNode, DatasetContext, DatasetSource, Emit, Link } from './contracts';
import { createWebSocketLink } from './links';
import { IpcMessageDecoder } from './arrow-ipc';
import { header, json, Kind, readJson, type Frame } from '../protocol/frame';

/** Proposed DatasetSource variant (contract change requested in docs/batch-1/remote-database.md). */
export type RemoteDatasetSource = Extract<DatasetSource, { kind: 'remote' }>;
/** Kept as an alias: `DatasetSource` now includes the remote placement. */
export type AnyDatasetSource = DatasetSource;

export const isRemoteSource = (source: AnyDatasetSource): source is RemoteDatasetSource => source.kind === 'remote';

export interface RemoteDatabaseOptions {
  /** Open the link (tests inject an in-process pair or a fake socket). */
  connect?: (endpoint: string, hello: Frame<Uint8Array>) => Link;
  /** Reconnect delays (ms) after the link drops; the last one repeats. */
  reconnectDelays?: number[];
  /** Give up on a connect that has not produced CONTEXT within this time (ms). */
  openTimeoutMs?: number;
  /** Measurement hook: decode time per RESULT_SCHEMA/BATCH (ms). */
  onDecode?: (kind: number, request: number, ms: number) => void;
}

interface Pending { resolve: (context: DatasetContext) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

const EMPTY = new Uint8Array(0);
const MAX_CANCELLED = 256;

const defaultConnect = (endpoint: string, hello: Frame<Uint8Array>): Link => createWebSocketLink('database', endpoint, { hello });

export class RemoteDatabaseNode implements DatabaseNode {
  private link?: Link;
  private source?: RemoteDatasetSource;
  private contextId = 0;
  private epoch = 0;
  private pending?: Pending;
  /** EXECs sent and not yet answered: request → its EXEC header. */
  private readonly inflight = new Map<number, Frame<Uint8Array>>();
  private readonly decoders = new Map<number, IpcMessageDecoder>();
  /** Targeted CANCELs whose frames may still be on the wire. */
  private readonly cancelled = new Set<number>();
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private disposed = false;
  /** Request-scoped frames dropped (stale epoch, cancelled, other context). */
  dropped = 0;

  constructor(private readonly emit: Emit, private readonly options: RemoteDatabaseOptions = {}) {}

  open(source: DatasetSource, contextId: number): Promise<DatasetContext> {
    const remote = source as AnyDatasetSource;
    if (!isRemoteSource(remote)) return Promise.reject(new Error(`remote database cannot open a ${source.kind} source`));
    if (this.disposed) return Promise.reject(new Error('database node is disposed'));
    this.shutdown('superseded');
    this.source = remote;
    this.contextId = 0;
    this.reconnectAttempt = 0;
    this.status('loading', `Connecting to ${remote.name}`, 0.1);
    return new Promise<DatasetContext>((resolve, reject) => {
      const timer = setTimeout(() => this.failOpen(new Error(`no CONTEXT from ${remote.endpoint} within ${this.options.openTimeoutMs ?? 15000} ms`)),
        this.options.openTimeoutMs ?? 15000);
      this.pending = { resolve, reject, timer };
      this.connect(contextId);
    });
  }

  handle(frame: Frame<Uint8Array>): void {
    if (this.disposed) return;
    if (frame.kind === Kind.EXEC) {
      if (frame.epoch < this.epoch || frame.context !== this.contextId || this.contextId === 0) { this.dropped++; return; }
      if (!this.link) { this.unavailable(frame, 'Database link is down; reconnecting'); return; }
      this.inflight.set(frame.request, frame);
      this.cancelled.delete(frame.request);
      this.link.send(frame);
    } else if (frame.kind === Kind.CANCEL) {
      if (frame.request === 0) {
        if (frame.epoch > this.epoch) this.epoch = frame.epoch;
        this.inflight.clear();
        this.decoders.clear();
        this.cancelled.clear();
      } else {
        this.inflight.delete(frame.request);
        this.decoders.delete(frame.request);
        this.cancelled.add(frame.request);
        if (this.cancelled.size > MAX_CANCELLED) this.cancelled.delete(this.cancelled.values().next().value!);
      }
      this.link?.send(frame);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.shutdown('disposed');
  }

  // ───────────────────────── link ─────────────────────────

  private connect(contextId: number): void {
    const source = this.source!;
    const generation = ++this.generation;
    const hello = { ...header(Kind.HELLO, {}), stamps: [], payload: json({ node: 'coordinator', name: 'time-blast-engine', version: 1, context: contextId }) };
    let link: Link;
    try {
      link = (this.options.connect ?? defaultConnect)(source.endpoint, hello);
    } catch (error) {
      this.lost(generation, contextId, error instanceof Error ? error.message : String(error));
      return;
    }
    this.link = link;
    link.listen(frame => { if (generation === this.generation) this.receive(frame as Frame<Uint8Array>, contextId); },
      reason => { if (generation === this.generation) this.lost(generation, contextId, reason); });
  }

  private receive(frame: Frame<Uint8Array>, contextId: number): void {
    switch (frame.kind) {
      case Kind.READY: return;
      case Kind.CONTEXT: this.onContext(frame, contextId); return;
      case Kind.STATUS: this.emit(frame); return;
      case Kind.RESULT_SCHEMA:
      case Kind.BATCH:
      case Kind.DONE:
      case Kind.ERROR:
        if (frame.request === 0) {
          // Session-level error (e.g. the dataset could not be described).
          if (frame.kind === Kind.ERROR && this.pending) {
            const { message } = readJson<{ message?: string }>(frame.payload);
            this.failOpen(new Error(message ?? 'database error'));
          } else if (frame.kind === Kind.ERROR) {
            this.emit(frame);
          }
          return;
        }
        this.result(frame);
        return;
      default: return;
    }
  }

  private onContext(frame: Frame<Uint8Array>, contextId: number): void {
    const context = readJson<DatasetContext>(frame.payload);
    if (frame.context !== contextId || context.id !== contextId) {
      this.failOpen(new Error(`server answered context ${frame.context} for ${contextId}`));
      return;
    }
    this.reconnectAttempt = 0;
    // A reconnect restores the epoch fence on the new session.
    if (this.epoch > 0) this.link?.send({ ...header(Kind.CANCEL, { epoch: this.epoch, request: 0 }), stamps: [], payload: EMPTY });
    this.contextId = contextId;
    this.status('ready', `${context.name} · ${context.tables.map(t => `${Number(t.rows).toLocaleString('en-US')} rows`).join(', ')} · ClickHouse (remote)`, 1);
    const pending = this.pending;
    if (pending) {
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.resolve(context);
    }
  }

  /** RESULT_SCHEMA/BATCH → Arrow objects (views into the frame), DONE/ERROR as they are. */
  private result(frame: Frame<Uint8Array>): void {
    const request = frame.request;
    if (frame.epoch < this.epoch || this.cancelled.has(request) || !this.inflight.has(request)) {
      this.dropped++;
      if (frame.kind === Kind.DONE || frame.kind === Kind.ERROR) this.cancelled.delete(request);
      return;
    }
    switch (frame.kind) {
      case Kind.RESULT_SCHEMA:
      case Kind.BATCH: {
        let decoder = this.decoders.get(request);
        if (frame.kind === Kind.RESULT_SCHEMA) this.decoders.set(request, decoder = new IpcMessageDecoder());
        if (!decoder) { this.dropped++; return; }
        const t0 = performance.now();
        let decoded;
        try {
          decoded = decoder.decode(frame.payload);
        } catch (error) {
          this.finish(request);
          this.emit({ ...frame, kind: Kind.ERROR, flags: 0, payload: json({ code: 'sql_error', message: `Arrow decode failed: ${(error as Error).message}` }) });
          return;
        }
        this.options.onDecode?.(frame.kind, request, performance.now() - t0);
        if (decoded.kind === 'schema') this.emit({ ...frame, payload: decoded.schema });
        else if (decoded.kind === 'batch') this.emit({ ...frame, payload: decoded.batch });
        return;
      }
      default:
        this.finish(request);
        this.emit(frame);
    }
  }

  private finish(request: number): void {
    this.inflight.delete(request);
    this.decoders.delete(request);
  }

  private unavailable(exec: Frame<Uint8Array>, message: string): void {
    this.emit({ ...exec, kind: Kind.ERROR, flags: 0, stamps: [], payload: json({ code: 'unavailable', message }) });
  }

  private lost(generation: number, contextId: number, reason: string): void {
    if (generation !== this.generation || this.disposed) return;
    this.link = undefined;
    if (this.pending) { this.failOpen(new Error(`database link closed: ${reason}`)); return; }
    // Every request the link started is gone with it.
    for (const exec of this.inflight.values()) this.unavailable(exec, `Database link closed: ${reason}`);
    this.inflight.clear();
    this.decoders.clear();
    this.status('error', 'Database link closed; reconnecting', undefined, reason);
    const delays = this.options.reconnectDelays ?? [250, 1000, 4000];
    const delay = delays[Math.min(this.reconnectAttempt++, delays.length - 1)];
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; if (generation === this.generation) this.connect(contextId); }, delay);
  }

  private failOpen(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    this.generation++;
    const link = this.link;
    this.link = undefined;
    link?.close();
    this.status('error', `Could not open ${this.source?.name ?? 'remote database'}`, undefined, error.message);
    pending.reject(error);
  }

  /** Close the current link (the server cancels everything it started) and reset state. */
  private shutdown(reason: string): void {
    this.generation++;
    if (this.reconnectTimer !== undefined) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    const link = this.link;
    this.link = undefined;
    link?.close();
    this.contextId = 0;
    this.inflight.clear();
    this.decoders.clear();
    this.cancelled.clear();
    const pending = this.pending;
    if (pending) { this.pending = undefined; clearTimeout(pending.timer); pending.reject(new Error(`open ${reason}`)); }
  }

  private status(state: 'loading' | 'ready' | 'error', label: string, progress?: number, detail?: string): void {
    this.emit({
      ...header(Kind.STATUS, {}), stamps: [],
      payload: json({ component: 'database', state, label, ...(detail ? { detail } : {}), ...(progress !== undefined ? { progress } : {}) }),
    });
  }
}

/**
 * Database placement by dataset source: `{kind: 'remote'}` opens the remote node, anything
 * else the in-browser one. The in-browser engine (DuckDB-Wasm) is created on the first local
 * open, so a remote-only session never pays its boot. Frames go to the node that owns the
 * current context; CANCEL goes to both so their epochs stay in step. Switching placement
 * cancels the previous node's work.
 */
export function createPlacedDatabase(createLocal: CreateDatabase, options: RemoteDatabaseOptions = {}): CreateDatabase {
  return async emit => new PlacedDatabase(emit, createLocal, options);
}

class PlacedDatabase implements DatabaseNode {
  private local?: Promise<DatabaseNode>;
  private localNode?: DatabaseNode;
  private remote?: RemoteDatabaseNode;
  private active?: DatabaseNode;

  constructor(private readonly emit: Emit, private readonly createLocal: CreateDatabase, private readonly options: RemoteDatabaseOptions) {}

  async open(source: DatasetSource, contextId: number): Promise<DatasetContext> {
    const target: DatabaseNode = isRemoteSource(source as AnyDatasetSource)
      ? (this.remote ??= new RemoteDatabaseNode(this.emit, this.options))
      : await (this.local ??= this.createLocal(this.emit).then(node => (this.localNode = node)));
    const previous = this.active;
    if (previous && previous !== target) previous.handle({ ...header(Kind.CANCEL, { epoch: 0, request: 0 }), stamps: [], payload: EMPTY });
    this.active = target;
    return target.open(source, contextId);
  }

  handle(frame: Frame<Uint8Array>): void {
    if (frame.kind === Kind.CANCEL) {
      this.localNode?.handle(frame);
      this.remote?.handle(frame);
      return;
    }
    this.active?.handle(frame);
  }

  dispose(): void {
    this.remote?.dispose();
    this.localNode?.dispose();
  }
}
