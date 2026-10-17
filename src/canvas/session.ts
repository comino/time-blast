import { CanvasModel, type CanvasPatch, type CanvasSnapshot, type DraftSession } from './model';
import { type CanvasStorage, CanvasConflictError } from './store';
import { encodeCanvasFile, importCanvasFile, parseCanvasFile, type CanvasFile } from './recovery';

type Mutation = CanvasPatch | null | { draft: DraftSession; patch: CanvasPatch };
export interface SaveState { state: 'saved' | 'saving' | 'error' | 'conflict'; message: string; pending: number }

/** Synchronous authoring plus a serial acknowledgement queue. Rendering never
 * awaits a save. After failure, the model remains editable and recovery-exportable. */
export class CanvasSession {
  private acknowledged: CanvasModel | null;
  /** `count` is how many issued commands a coalesced patch acknowledges. */
  private readonly queue: Array<{ patch: CanvasPatch; count: number }> = [];
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private running?: Promise<void>;
  private failure?: Error;
  private issued = 0;
  private accepted = 0;
  private closed = false;
  private activate = false;
  private scheduled = false;

  constructor(readonly model: CanvasModel, private readonly storage: CanvasStorage | null, saved = true) {
    this.acknowledged = saved ? new CanvasModel(model.snapshot()) : null;
    this.unsubscribe = storage?.subscribe(change => {
      if (change.canvasId !== model.header.id || this.closed) return;
      this.failure = new CanvasConflictError('This canvas changed in another tab. Your local work is retained; export it or save a copy before loading the other version.');
      this.emit();
    }) ?? (() => {});
    if (!saved) { this.activate = true; this.enqueue(model.initialPatch()); }
  }

  static create(storage: CanvasStorage | null, title?: string): CanvasSession { return new CanvasSession(CanvasModel.create(title), storage, false); }
  static import(storage: CanvasStorage | null, raw: string): CanvasSession { return new CanvasSession(importCanvasFile(parseCanvasFile(raw)), storage, false); }

  /** Queue the exact result in the same call that mutates authoring state. */
  command<T extends Mutation>(fn: (model: CanvasModel) => T): T {
    if (this.closed) throw new Error('Canvas session is closed');
    const result = fn(this.model), mutation: Mutation = result;
    if (mutation) this.enqueue('patch' in mutation ? mutation.patch : mutation);
    return result;
  }

  get saveState(): SaveState {
    const pending = this.issued - this.accepted;
    if (this.failure) return { state: this.failure instanceof CanvasConflictError ? 'conflict' : 'error', message: this.failure.message, pending };
    return pending ? { state: 'saving', message: 'Saving…', pending } : { state: 'saved', message: 'Saved in this browser', pending: 0 };
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { for (const listener of this.listeners) listener(); }

  private enqueue(patch: CanvasPatch): void {
    this.issued++;
    // A failed suffix cannot be blindly retried against an external head. Its
    // complete working graph is retained by the model; no unbounded failed journal.
    if (!this.failure && !this.coalesce(patch)) this.queue.push({ patch, count: 1 });
    this.emit();
    // Journal after the caller's frame is out: validation and the IndexedDB
    // transaction never sit between a keystroke and its DRAFT.
    if (!this.scheduled) { this.scheduled = true; queueMicrotask(() => { this.scheduled = false; this.pump(); }); }
  }

  /** Typing writes one draft per keystroke. A queued draft-only patch that has
   * not started absorbs later versions of the same drafts: one transaction carries
   * the newest value with the oldest expected version (the store checks monotonicity). */
  private coalesce(patch: CanvasPatch): boolean {
    const draftsOnly = (p: CanvasPatch) => !p.head && !p.commits?.length && !p.revisions?.length && !p.sources?.length;
    const last = this.queue[this.queue.length - 1];
    if (!last || (this.running && this.queue.length === 1) || !draftsOnly(patch) || !draftsOnly(last.patch)) return false;
    const writes = last.patch.drafts ?? (last.patch.drafts = []);
    for (const write of patch.drafts ?? []) {
      const i = writes.findIndex(w => w.value.id === write.value.id);
      if (i < 0) writes.push(write);
      else writes[i] = { expectedVersion: writes[i].expectedVersion, value: write.value };
    }
    last.count++;
    return true;
  }

  private pump(): void {
    if (this.running || this.failure || !this.queue.length) return;
    this.running = this.drain().finally(() => {
      this.running = undefined; this.emit();
      // A microtask can enqueue after drain's final acknowledgement but before
      // this callback. It must not wait for another keystroke to get saved.
      this.pump();
    });
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length && !this.failure) {
        const { patch, count } = this.queue[0];
        if (!this.storage) throw new Error('Browser storage is unavailable. Your work is in memory; export a recovery file.');
        await this.storage.write(patch);
        this.acknowledge(patch);
        this.queue.shift(); this.accepted += count; this.emit();
        if (this.activate && !this.closed) {
          this.activate = false;
          // Active-canvas selection is a preference; its failure cannot undo the
          // already acknowledged document transaction.
          try { await this.storage.setActive(this.model.header.id); } catch { /* document remains listed */ }
        }
      }
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      if (this.failure) this.queue.length = 0;
    }
  }

  private acknowledge(patch: CanvasPatch): void {
    if (!this.acknowledged) {
      if (!patch.head) throw new Error('Missing initial canvas acknowledgement');
      this.acknowledged = new CanvasModel({ format: 'timeblast-canvas', formatVersion: 1, canvas: patch.head.value,
        commits: patch.commits ?? [], revisions: patch.revisions ?? [], sources: patch.sources ?? [], drafts: patch.drafts?.map(d => d.value) ?? [] });
      return;
    }
    // Never snapshot the optimistic model here: it may contain later commands.
    const saved = this.acknowledged;
    if (patch.head) saved.header = structuredClone(patch.head.value);
    for (const key of ['commits', 'revisions', 'sources'] as const) for (const value of patch[key] ?? []) {
      (saved[key] as Map<string, typeof value>).set(value.id, structuredClone(value));
    }
    for (const { value } of patch.drafts ?? []) saved.drafts.set(value.id, structuredClone(value));
  }

  /** Capture both sides of the boundary synchronously, including an in-flight save. */
  exportFile(): { filename: string; content: string } {
    const saved = this.acknowledged?.snapshot() ?? null;
    const dirty = this.saveState.state !== 'saved' || !saved;
    const file: CanvasFile = dirty ? { format: 'timeblast-canvas-recovery', formatVersion: 1, exportedAt: Date.now(),
      acknowledged: saved, working: this.model.snapshot() } : saved;
    return { filename: `canvas-${this.model.header.id}${dirty ? '-recovery' : ''}.timeblast.json`, content: encodeCanvasFile(file) };
  }
  savedSnapshot(): CanvasSnapshot | null { return this.acknowledged?.snapshot() ?? null; }
  async settled(): Promise<void> {
    if (this.scheduled) await Promise.resolve();
    while (this.running || this.scheduled) await (this.running ?? Promise.resolve());
  }
  close(): void { this.closed = true; this.activate = false; this.unsubscribe(); this.listeners.clear(); }
}
