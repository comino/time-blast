import { abortError } from './plan';

/** Engine interruption belongs to one generation; await its stop before admitting the next. */
export class GenerationQueue {
  private tail: Promise<void> = Promise.resolve();
  private known = new Set<string>();
  private canceled = new Set<string>();
  private active?: { id: string; stop: () => void | Promise<void>; stopping?: Promise<void> };

  run<T>(id: string, task: () => Promise<T>, stop: () => void | Promise<void>): Promise<T> {
    if (this.known.has(id)) return Promise.reject(new Error('Duplicate inference request ID.'));
    this.known.add(id);
    const result = this.tail.then(async () => {
      try {
        if (this.canceled.has(id)) throw abortError();
        const active = { id, stop, stopping: undefined as Promise<void> | undefined };
        this.active = active;
        try {
          const value = await task();
          if (this.canceled.has(id)) throw abortError();
          return value;
        } finally {
          if (active.stopping) await active.stopping;
          if (this.active === active) this.active = undefined;
        }
      } finally { this.known.delete(id); this.canceled.delete(id); }
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  isCanceled(id: string): boolean { return this.canceled.has(id); }

  cancel(id: string): void {
    if (!this.known.has(id)) return;
    this.canceled.add(id);
    const active = this.active;
    if (active?.id === id && !active.stopping) {
      try { active.stopping = Promise.resolve(active.stop()).catch(() => undefined); }
      catch { active.stopping = Promise.resolve(); }
    }
  }
}
