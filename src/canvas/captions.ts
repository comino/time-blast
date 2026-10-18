/** Chart captions: an AI title and explanation per saved revision (docs/plan-captions.md).
 *
 * Isolated from the data path by construction:
 * - its own tb1 link (a second WebSocket to the inference server), opened lazily and closed
 *   when idle, so no caption byte queues in front of a translation and the coordinator never
 *   sees one;
 * - its own IndexedDB database, so caption writes never join a canvas journal transaction or
 *   fire the canvas cross-tab conflict channel;
 * - one request at a time per tab, oldest revision of a chain first, so `previousTitle` exists.
 *
 * Revisions are immutable: a caption stored for (canvas, revision) is valid while its SQL equals
 * the revision's SQL and its prompt version is current. Captions are derived data: losing them
 * only means asking again (a server cache hit when the payload is unchanged). */
import { header, json, Kind, readJson, type Frame } from '../protocol/frame';
import { createWebSocketLink } from '../engine/links';
import type { Link } from '../engine/contracts';
import { CAPTION_CAPABILITY, CAPTION_PROMPT_VERSION, MAX_CAPTION_PAYLOAD, type CaptionRequest } from '../inference-node/caption';
import type { Id } from './model';

export interface StoredCaption {
  canvasId: Id; revisionId: Id;
  /** The revision's SQL when the caption was written (validity check). */
  sql: string;
  promptVersion: number;
  title: string; explanation: string; model: string; at: number;
}

export interface CaptionStorage {
  all(canvasId: Id): Promise<StoredCaption[]>;
  put(caption: StoredCaption): Promise<void>;
}

const request = <T>(r: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

/** A database of its own: the canvas database's schema, transactions and BroadcastChannel are
 * untouched (store.ts opens every canvas store per journal write; any same-canvas broadcast
 * there is treated as a cross-tab conflict). */
export class IndexedCaptionStore implements CaptionStorage {
  private constructor(private readonly db: IDBDatabase) { db.onversionchange = () => db.close(); }
  static async open(name = 'timeblast-captions', factory: IDBFactory = indexedDB): Promise<IndexedCaptionStore> {
    const open = factory.open(name, 1);
    open.onupgradeneeded = event => {
      if (event.oldVersion < 1) open.result.createObjectStore('captions', { keyPath: ['canvasId', 'revisionId'] }).createIndex('canvas', 'canvasId');
    };
    return new IndexedCaptionStore(await request(open));
  }
  async all(canvasId: Id): Promise<StoredCaption[]> {
    return request(this.db.transaction('captions').objectStore('captions').index('canvas').getAll(canvasId)) as Promise<StoredCaption[]>;
  }
  put(caption: StoredCaption): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('captions', 'readwrite');
      tx.objectStore('captions').put(caption);
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
    });
  }
}

export class MemoryCaptionStore implements CaptionStorage {
  readonly records = new Map<string, StoredCaption>();
  async all(canvasId: Id): Promise<StoredCaption[]> { return [...this.records.values()].filter(c => c.canvasId === canvasId).map(c => ({ ...c })); }
  async put(caption: StoredCaption): Promise<void> { this.records.set(`${caption.canvasId}\u0000${caption.revisionId}`, { ...caption }); }
}

/** What to caption: built by the controller when the request is about to be sent, so the
 * parent's caption (previousTitle) is known by then. `inherit` reuses the parent's caption for
 * a presentation-only revision (same SQL). */
export type CaptionWork =
  | { kind: 'request'; canvasId: Id; chartId: Id; revisionId: Id; sql: string; payload: CaptionRequest }
  | { kind: 'inherit'; canvasId: Id; revisionId: Id; sql: string; from: StoredCaption }
  | { kind: 'skip' };

export interface CaptionLinkLike { send(frame: Frame): void; close(): void }
export type CaptionLinkFactory = (endpoint: string, onFrame: (frame: Frame) => void, onClose: (reason: string) => void) => CaptionLinkLike;

const webSocketLink: CaptionLinkFactory = (endpoint, onFrame, onClose) => {
  const link: Link = createWebSocketLink('inference', endpoint, { hello: { ...header(Kind.HELLO), stamps: [], payload: json({ node: 'ui', name: 'time-blast-captions', version: 1 }) } });
  link.listen(frame => onFrame(frame as Frame), onClose);
  return { send: frame => link.send(frame), close: () => link.close() };
};

/** The link closes after this long without work; the next caption opens it again. */
export const CAPTION_IDLE_MS = 30_000;
/** After a quota refusal, captions wait this long before asking again. */
export const CAPTION_BUDGET_PAUSE_MS = 60_000;
const MAX_QUEUE = 256;

interface Queued { canvasId: Id; revisionId: Id }
interface InFlight extends Queued { id: number; sql: string; sentAt: number }

export interface CaptionStats { requested: number; received: number; cached: number; failed: number; inherited: number; lastMs?: number }

export class CaptionService {
  private readonly captions = new Map<Id, StoredCaption>();
  private loadedCanvas?: Id;
  private loading?: Promise<void>;
  private readonly queue: Queued[] = [];
  private readonly failed = new Set<Id>();
  private inFlight?: InFlight;
  private link?: CaptionLinkLike;
  private linkState: 'closed' | 'connecting' | 'ready' = 'closed';
  private unsupported = new Set<string>();
  private endpoint: string | null = null;
  private nextId = 1;
  private pausedUntil = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  enabled = true;
  readonly stats: CaptionStats = { requested: 0, received: 0, cached: 0, failed: 0, inherited: 0 };
  /** Changes whenever a caption is added (history rendering keys on it). */
  version = 0;

  constructor(
    private store: CaptionStorage | null,
    /** Build the request when it is about to be sent; `skip` if the revision is gone. */
    private readonly build: (item: Queued) => CaptionWork,
    private readonly onCaption: (caption: StoredCaption) => void,
    private readonly factory: CaptionLinkFactory = webSocketLink,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  useStore(store: CaptionStorage | null): void { this.store = store; }

  /** The remote inference endpoint, or null when inference runs in the browser (no captions). */
  setEndpoint(endpoint: string | null): void {
    if (endpoint === this.endpoint) return;
    this.endpoint = endpoint;
    this.closeLink();
    this.pump();
  }
  get available(): boolean { return this.enabled && !!this.endpoint && !this.unsupported.has(this.endpoint) && this.clock() >= this.pausedUntil; }

  /** Load a canvas's stored captions; queued work for other canvases is dropped. */
  load(canvasId: Id): Promise<void> {
    if (this.loadedCanvas === canvasId && this.loading) return this.loading;
    this.loadedCanvas = canvasId;
    this.captions.clear(); this.failed.clear();
    this.queue.splice(0, this.queue.length, ...this.queue.filter(q => q.canvasId === canvasId));
    const loading = this.loading = (async () => {
      let records: StoredCaption[] = [];
      try { records = await this.store?.all(canvasId) ?? []; } catch { /* derived data: regenerate */ }
      if (this.loadedCanvas !== canvasId) return;
      for (const c of records) if (c.promptVersion === CAPTION_PROMPT_VERSION && !this.captions.has(c.revisionId)) this.captions.set(c.revisionId, c);
      this.version++;
    })();
    return loading.then(() => this.pump());
  }

  /** A valid caption for this revision, or undefined. */
  get(revisionId: Id, sql: string): StoredCaption | undefined {
    const c = this.captions.get(revisionId);
    return this.enabled && c && c.sql === sql && c.promptVersion === CAPTION_PROMPT_VERSION ? c : undefined;
  }
  has(revisionId: Id): boolean { return this.captions.has(revisionId) || this.failed.has(revisionId); }

  /** Ask for captions of these revisions, in order (oldest of a chain first). */
  want(canvasId: Id, revisionIds: Id[]): void {
    if (!this.enabled || canvasId !== this.loadedCanvas) return;
    for (const revisionId of revisionIds) {
      if (this.has(revisionId) || this.inFlight?.revisionId === revisionId || this.queue.some(q => q.revisionId === revisionId)) continue;
      if (this.queue.length >= MAX_QUEUE) this.queue.shift();
      this.queue.push({ canvasId, revisionId });
    }
    this.pump();
  }

  /** Stop: drop the queue and the in-flight request (a late reply is ignored). */
  cancel(): void {
    this.queue.length = 0;
    if (this.inFlight && this.linkState === 'ready') this.link?.send({ ...header(Kind.CANCEL, { request: this.inFlight.id }), stamps: [], payload: new Uint8Array() });
    this.inFlight = undefined;
  }

  close(): void { this.cancel(); this.closeLink(); }

  private pump(): void {
    if (this.inFlight || this.loading === undefined) return;
    while (this.queue.length && this.available && this.loadedCanvas) {
      const item = this.queue.shift()!;
      if (item.canvasId !== this.loadedCanvas || this.has(item.revisionId)) continue;
      const work = this.build(item);
      if (work.kind === 'skip') continue;
      if (work.kind === 'inherit') {
        this.stats.inherited++;
        this.accept({ ...work.from, canvasId: work.canvasId, revisionId: work.revisionId, sql: work.sql, at: Date.now() });
        continue;
      }
      const bytes = json(work.payload);
      if (bytes.byteLength > MAX_CAPTION_PAYLOAD) { this.failed.add(work.revisionId); continue; }
      this.inFlight = { canvasId: work.canvasId, revisionId: work.revisionId, sql: work.sql, id: this.nextId++, sentAt: this.clock() };
      this.stats.requested++;
      this.ensureLink();
      if (this.linkState === 'ready') this.sendInFlight(bytes);
      else this.pendingBytes = bytes;
      return;
    }
    if (!this.inFlight && !this.queue.length) this.armIdle();
  }
  private pendingBytes?: Uint8Array;

  private sendInFlight(bytes: Uint8Array): void {
    const f = this.inFlight!;
    clearTimeout(this.idleTimer);
    this.link!.send({ ...header(Kind.DESCRIBE, { request: f.id }), stamps: [], payload: bytes });
  }

  private ensureLink(): void {
    if (this.linkState !== 'closed' || !this.endpoint) return;
    const endpoint = this.endpoint;
    this.linkState = 'connecting';
    try {
      const link = this.link = this.factory(endpoint, frame => { if (this.link === link) this.onFrame(endpoint, frame); }, () => { if (this.link === link) this.linkClosed(); });
    } catch { this.linkClosed(); }
  }

  private onFrame(endpoint: string, frame: Frame): void {
    if (frame.kind === Kind.READY) {
      let capabilities: unknown = [];
      try { capabilities = readJson<{ capabilities?: unknown }>(frame.payload).capabilities; } catch { /* none */ }
      if (!Array.isArray(capabilities) || !capabilities.includes(CAPTION_CAPABILITY)) {
        this.unsupported.add(endpoint); this.closeLink(); this.inFlight = undefined; this.queue.length = 0; return;
      }
      this.linkState = 'ready';
      if (this.inFlight && this.pendingBytes) { const bytes = this.pendingBytes; this.pendingBytes = undefined; this.sendInFlight(bytes); }
      else this.pump();
      return;
    }
    const f = this.inFlight;
    if (!f || frame.request !== f.id) return;
    if (frame.kind === Kind.DESCRIPTION) {
      this.inFlight = undefined;
      try {
        const body = readJson<{ title?: unknown; explanation?: unknown; model?: unknown; cached?: unknown }>(frame.payload);
        if (typeof body.title === 'string' && typeof body.explanation === 'string' && body.title && f.canvasId === this.loadedCanvas) {
          this.stats.received++; if (body.cached) this.stats.cached++;
          this.stats.lastMs = this.clock() - f.sentAt;
          this.accept({ canvasId: f.canvasId, revisionId: f.revisionId, sql: f.sql, promptVersion: CAPTION_PROMPT_VERSION,
            title: body.title, explanation: body.explanation, model: typeof body.model === 'string' ? body.model : '', at: Date.now() });
        }
      } catch { this.failed.add(f.revisionId); this.stats.failed++; }
      this.pump();
    } else if (frame.kind === Kind.ERROR) {
      this.inFlight = undefined;
      this.stats.failed++;
      let code = '';
      try { code = readJson<{ code?: string }>(frame.payload).code ?? ''; } catch { /* unknown */ }
      // Quota and capacity are temporary: stop asking for now; anything else will not improve.
      if (code === 'budget' || code === 'busy') this.queue.unshift({ canvasId: f.canvasId, revisionId: f.revisionId });
      else this.failed.add(f.revisionId);
      if (code === 'budget') this.pausedUntil = this.clock() + CAPTION_BUDGET_PAUSE_MS;
      if (code === 'budget' || code === 'unsupported') { if (code === 'unsupported' && this.endpoint) this.unsupported.add(this.endpoint); this.closeLink(); return; }
      this.pump();
    }
  }

  private accept(caption: StoredCaption): void {
    this.captions.set(caption.revisionId, caption);
    this.version++;
    void this.store?.put(caption).catch(() => { /* derived data: regenerate next time */ });
    this.onCaption(caption);
  }

  private linkClosed(): void {
    this.link = undefined; this.linkState = 'closed'; this.pendingBytes = undefined;
    // An unanswered request is retried once the link is back (it reconnects on demand).
    if (this.inFlight) { this.queue.unshift({ canvasId: this.inFlight.canvasId, revisionId: this.inFlight.revisionId }); this.inFlight = undefined; }
  }
  private closeLink(): void {
    clearTimeout(this.idleTimer);
    const link = this.link; this.link = undefined; this.linkState = 'closed'; this.pendingBytes = undefined;
    if (this.inFlight) { this.queue.unshift({ canvasId: this.inFlight.canvasId, revisionId: this.inFlight.revisionId }); this.inFlight = undefined; }
    try { link?.close(); } catch { /* already closed */ }
  }
  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (this.link) this.idleTimer = setTimeout(() => { if (!this.inFlight && !this.queue.length) this.closeLink(); }, CAPTION_IDLE_MS);
  }
}
