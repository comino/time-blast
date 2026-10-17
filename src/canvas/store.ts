import { CANVAS_FORMAT, newId, type CanvasHeader, type CanvasPatch, type CanvasSnapshot } from './model';
import { validateCanvas, validatePatch } from './validation';

export class CanvasConflictError extends Error { override name = 'CanvasConflictError'; }
export interface StoreChange { canvasId: string; writer: string; storeVersion?: number; drafts: string[] }
export interface CanvasStorage {
  load(canvasId: string): Promise<CanvasSnapshot | null>;
  write(patch: CanvasPatch): Promise<void>;
  list(): Promise<CanvasHeader[]>;
  getActive(): Promise<string | null>;
  setActive(canvasId: string): Promise<void>;
  subscribe(listener: (change: StoreChange) => void): () => void;
  close(): void;
}
const RECORD_STORES = ['commits', 'revisions', 'sources', 'drafts'] as const;
const STORES = ['canvases', ...RECORD_STORES] as const;
const request = <T>(r: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
});
const completion = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Canvas transaction aborted'));
  tx.onerror = () => {}; // abort owns the terminal error; no duplicate rejection
});

/** Small metadata records, atomic compare-and-swap, no data-plane storage. */
export class IndexedCanvasStore implements CanvasStorage {
  private readonly writer = newId();
  private readonly listeners = new Set<(change: StoreChange) => void>();
  private readonly channel: BroadcastChannel | null;
  private constructor(private readonly db: IDBDatabase) {
    this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`${db.name}:changes`);
    if (this.channel) this.channel.onmessage = e => {
      const change = e.data as StoreChange;
      if (change && typeof change.canvasId === 'string' && change.writer !== this.writer) for (const listener of this.listeners) listener(change);
    };
    db.onversionchange = () => this.close();
  }
  static async open(name = 'timeblast-canvases', factory: IDBFactory = indexedDB): Promise<IndexedCanvasStore> {
    const open = factory.open(name, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore('canvases', { keyPath: 'id' });
      for (const name of RECORD_STORES) {
        const store = db.createObjectStore(name, { keyPath: ['canvasId', 'id'] });
        store.createIndex('canvas', 'canvasId');
      }
      db.createObjectStore('preferences');
    };
    return new IndexedCanvasStore(await request(open));
  }
  async load(canvasId: string): Promise<CanvasSnapshot | null> {
    const tx = this.db.transaction([...STORES], 'readonly'), done = completion(tx);
    const header = request<CanvasHeader | undefined>(tx.objectStore('canvases').get(canvasId));
    const records = RECORD_STORES.map(name => request(tx.objectStore(name).index('canvas').getAll(canvasId)));
    const [canvas, [commits, revisions, sources, drafts]] = await Promise.all([header, Promise.all(records), done]);
    if (!canvas) return null;
    return validateCanvas({ format: 'timeblast-canvas', formatVersion: CANVAS_FORMAT, canvas, commits, revisions, sources, drafts });
  }
  async list(): Promise<CanvasHeader[]> {
    const tx = this.db.transaction('canvases', 'readonly'), done = completion(tx);
    const [records] = await Promise.all([request<CanvasHeader[]>(tx.objectStore('canvases').getAll()), done]); return records;
  }
  async getActive(): Promise<string | null> {
    const tx = this.db.transaction('preferences', 'readonly'), done = completion(tx);
    const [id] = await Promise.all([request<string | undefined>(tx.objectStore('preferences').get('active')), done]); return id ?? null;
  }
  async setActive(canvasId: string): Promise<void> {
    const tx = this.db.transaction('preferences', 'readwrite'), done = completion(tx);
    tx.objectStore('preferences').put(canvasId, 'active'); await done;
  }

  write(patch: CanvasPatch): Promise<void> {
    return new Promise((resolve, reject) => {
      validatePatch(patch);
      const tx = this.db.transaction([...STORES], 'readwrite');
      let failure: unknown;
      const abort = (error: unknown) => { failure = error; try { tx.abort(); } catch {} };
      tx.onerror = () => {};
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Canvas save aborted'));
      tx.oncomplete = () => {
        // A BroadcastChannel is advisory; closing the store cannot undo a completed
        // transaction or strand its storage acknowledgement.
        try {
          this.channel?.postMessage({ canvasId: patch.canvasId, writer: this.writer,
            storeVersion: patch.head?.value.storeVersion, drafts: patch.drafts?.map(d => d.value.id) ?? [] } satisfies StoreChange);
        } catch { /* store/channel may have closed while the transaction was running */ }
        resolve();
      };
      let pending = 0;
      const checks: Array<() => void> = [];
      const read = <T>(r: IDBRequest<T>, check: (previous: T) => void) => {
        pending++;
        r.onsuccess = () => {
          if (failure) return;
          try {
            check(r.result);
            if (--pending === 0) for (const write of checks) write();
          } catch (error) { abort(error); }
        };
      };
      const conflict = (message: string): never => { throw new CanvasConflictError(message); };
      read<CanvasHeader | undefined>(tx.objectStore('canvases').get(patch.canvasId), previous => {
        if (patch.head) {
          const { expectedVersion, value } = patch.head;
          if (value.id !== patch.canvasId) conflict('Canvas identity changed');
          if (expectedVersion === null ? !!previous : !previous || previous.storeVersion !== expectedVersion) conflict('This canvas changed in another tab. Your local work is still available for export.');
          if (value.storeVersion !== (expectedVersion === null ? 0 : expectedVersion + 1)) conflict('Invalid canvas store version');
        } else if (!previous) conflict('The canvas has not been saved yet');
      });
      if (patch.head) checks.push(() => tx.objectStore('canvases').put(patch.head!.value));
      for (const name of ['commits', 'revisions', 'sources'] as const) for (const value of patch[name] ?? []) {
        if (value.canvasId !== patch.canvasId) { abort(new CanvasConflictError('Record belongs to another canvas')); return; }
        const store = tx.objectStore(name);
        read(store.get([patch.canvasId, value.id]), previous => {
          if (previous && JSON.stringify(previous) !== JSON.stringify(value)) conflict('Immutable canvas record was modified');
        });
        checks.push(() => store.put(value));
      }
      for (const { expectedVersion, value } of patch.drafts ?? []) {
        if (value.canvasId !== patch.canvasId) { abort(new CanvasConflictError('Draft belongs to another canvas')); return; }
        const store = tx.objectStore('drafts');
        read(store.get([patch.canvasId, value.id]), previous => {
          if (expectedVersion === null ? !!previous : !previous || previous.version !== expectedVersion) conflict('A newer draft has already been saved');
          if (previous?.state === 'closed') conflict('A finished draft cannot be reopened by an old save');
          // Coalesced keystrokes skip intermediate versions; versions only move forward.
          if (expectedVersion !== null && value.version <= expectedVersion) conflict('Invalid draft version');
        });
        checks.push(() => store.put(value));
      }
    });
  }
  subscribe(listener: (change: StoreChange) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close(): void { this.channel?.close(); this.db.close(); this.listeners.clear(); }
}
