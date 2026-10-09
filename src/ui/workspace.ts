import type { ColumnBatch, PipelineEvent } from '../core/types';
import { ResultCard } from './result-card';

const MAX_CARDS = 8, MAX_BYTES = 64 * 1024 * 1024;
interface WorkspaceCallbacks { cancel(): void; busy(value: boolean): void; draw(id: string, at: number): void; added(card: ResultCard): void }

/** Spatial chrome never serializes results or waits for another card to settle. */
export class CanvasWorkspace {
  readonly cards: ResultCard[] = [];
  private readonly viewport: HTMLElement;
  private readonly world: HTMLElement;
  private readonly observer: ResizeObserver;
  private readonly byQuery = new Map<string, ResultCard>();
  private readonly retained = new Map<ArrayBufferLike, number>();
  private readonly cardBuffers = new Map<ResultCard, Set<ArrayBufferLike>>();
  private retainedBytes = 0;
  private selected?: ResultCard;
  private active?: ResultCard;
  private pending?: ResultCard;
  private preview?: ResultCard;
  private counter = 0;
  private width = 1; private height = 1;
  private x = 0; private y = 0; private scale = 1;
  private gesture?: { pointer: number; startX: number; startY: number; x: number; y: number; card?: ResultCard; resize: boolean };
  private readonly controller = new AbortController();
  private noticeTimer?: ReturnType<typeof setTimeout>;

  constructor(private root: HTMLElement, private callbacks: WorkspaceCallbacks) {
    this.viewport = this.el('board-viewport'); this.world = this.el('board-world');
    this.observer = new ResizeObserver(() => { this.width = this.viewport.clientWidth || 1; this.height = this.viewport.clientHeight || 1; this.paintCamera(); });
    this.observer.observe(this.viewport); this.width = this.viewport.clientWidth || 1; this.height = this.viewport.clientHeight || 1;
    const signal = this.controller.signal;
    const action = (name: string, fn: () => void) => root.querySelector(`[data-action="${name}"]`)!.addEventListener('click', fn, { signal });
    action('zoom-in', () => this.zoom(1.2)); action('zoom-out', () => this.zoom(1 / 1.2)); action('fit', () => this.fit());
    action('arrange', () => this.arrange()); action('clear-canvas', () => this.clear());
    this.viewport.addEventListener('pointerdown', e => this.pointerDown(e), { signal });
    this.viewport.addEventListener('pointermove', e => this.pointerMove(e), { signal });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) this.viewport.addEventListener(type, () => { this.gesture = undefined; this.viewport.classList.remove('is-panning'); }, { signal });
    this.viewport.addEventListener('wheel', e => {
      if ((e.target as HTMLElement).closest('.data-table-wrap,.sql-panel,select')) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.zoom(Math.exp(-e.deltaY * .004));
      else { this.x -= e.deltaX; this.y -= e.deltaY; this.paintCamera(); }
    }, { passive: false, signal });
    this.paintCamera(); this.updateCount();
  }
  private el(name: string): HTMLElement { return this.root.querySelector(`[data-el="${name}"]`)!; }
  get isLiveActive(): boolean { return !!this.preview && this.active === this.preview; }
  private create(prompt: string): ResultCard {
    const card = new ResultCard(`view-${++this.counter}`, prompt, this.world, {
      select: c => this.select(c), close: c => {
        // A finished preview can still have a replacement waiting on the typing timer.
        if (c === this.preview && !c.busy) this.callbacks.cancel();
        this.remove(c);
      }, duplicate: c => this.duplicate(c), cancel: c => this.cancel(c),
      change: c => { if (c === this.active) this.callbacks.busy(c.busy); }, draw: (id, at) => this.callbacks.draw(id, at),
    });
    const columns = this.width >= 900 ? 2 : 1;
    card.width = Math.min(548, Math.max(280, (this.width - 24 * (columns + 1)) / columns));
    card.height = matchMedia('(max-width: 650px)').matches
      ? Math.min(420, Math.max(380, this.height - 48))
      : Math.min(560, Math.max(520, this.height - 48));
    let slot = 0;
    do {
      card.x = 24 + slot % columns * (card.width + 24); card.y = 24 + Math.floor(slot / columns) * (card.height + 24); slot++;
    } while (this.cards.some(c => card.x < c.x + c.width + 12 && card.x + card.width + 12 > c.x && card.y < c.y + c.height + 12 && card.y + card.height + 12 > c.y));
    card.layout();
    this.cards.push(card); this.cardBuffers.set(card, new Set()); this.select(card); this.focus(card);
    this.updateCount(); return card;
  }
  submit(prompt: string): void {
    // COMMIT supersedes foreground execution itself and preserves an exact
    // speculative candidate. A full coordinator cancel here would destroy it.
    if (this.active?.busy) this.active.cancel('SUPERSEDED');
    if (this.preview) this.remove(this.preview);
    const card = this.create(prompt); this.active = this.pending = card;
    this.enforceBudget(card);
    this.callbacks.busy(true); this.callbacks.added(card);
  }
  /** Replace only the unpinned live view; saved questions keep their results. */
  submitLive(prompt: string): boolean {
    if (this.preview?.prompt === prompt && !this.preview.stopped) return false;
    if (this.active?.busy) this.active.cancel('SUPERSEDED');
    let card = this.preview;
    if (card) {
      if (card.view) this.byQuery.delete(card.view.id);
      this.release(card); card.reset(prompt);
    } else {
      card = this.create(prompt);
      const badge = document.createElement('span'); badge.className = 'live-preview-badge'; badge.textContent = 'LIVE'; badge.title = 'Updates after a 2 second pause · Enter to keep';
      card.element.querySelector('.card-toolbar')!.prepend(badge);
    }
    this.preview = this.active = this.pending = card;
    card.element.dataset.livePreview = 'true';
    card.element.setAttribute('aria-label', `Live preview: ${prompt}. Press Enter to keep this view.`);
    this.enforceBudget(card); this.callbacks.busy(true); return true;
  }
  pinLive(prompt: string): boolean {
    const card = this.preview;
    if (!card || card.prompt !== prompt || card.stopped) return false;
    this.preview = undefined; delete card.element.dataset.livePreview;
    card.element.setAttribute('aria-label', prompt); card.element.querySelector('.live-preview-badge')?.remove();
    this.callbacks.added(card); this.focus(card); return true;
  }
  invalidateLive(remove = false): void {
    if (!this.preview) return;
    if (this.preview.busy) this.cancel(this.preview, 'DRAFT CHANGED');
    if (remove) this.remove(this.preview);
  }
  handle(event: PipelineEvent): void {
    if (event.type === 'start') {
      const card = this.pending;
      if (!card || card.stopped || event.view.prompt !== card.prompt || this.byQuery.has(event.view.id)) return;
      this.pending = undefined; this.byQuery.set(event.view.id, card); card.begin(event.view); return;
    }
    if (event.type === 'batch') {
      const card = this.byQuery.get(event.id); if (!card || card.stopped || card.completeReceived) return;
      this.retain(card, event.batch); card.append(event.batch); this.enforceBudget(card); return;
    }
    if (event.type === 'complete') { this.byQuery.get(event.id)?.finish(event.timing); return; }
    if (event.type === 'error') {
      const card = event.id ? this.byQuery.get(event.id) : this.pending ?? (this.active?.busy ? this.active : undefined);
      if (card && !card.stopped && !card.completeReceived) { if (card === this.pending) this.pending = undefined; card.error(event.message, event.failure); }
      else if (!event.id) this.notice(event.message);
    }
  }
  select(card: ResultCard): void {
    if (this.selected === card) return;
    this.selected?.select(false); this.selected = card; card.select(true);
  }
  focus(card: ResultCard): void {
    if (!this.cards.includes(card)) return;
    this.select(card); card.setVisible(true);
    const w = card.width * this.scale, h = card.height * this.scale;
    if (w > this.width - 24 || h > this.height - 24) this.scale = Math.max(.25, Math.min(1, (this.width - 32) / card.width, (this.height - 32) / card.height));
    const left = this.x + card.x * this.scale, top = this.y + card.y * this.scale;
    if (left < 12 || left + card.width * this.scale > this.width - 12) this.x = 24 - card.x * this.scale;
    if (top < 12 || top + card.height * this.scale > this.height - 12) this.y = 24 - card.y * this.scale;
    this.paintCamera();
  }
  focusById(id: string): void { const card = this.cards.find(c => c.id === id); if (card) this.focus(card); else this.notice('This view was removed from the canvas. Ask the question again to recreate it.'); }
  cancelActive(label = 'CANCELED'): void { if (this.active?.busy) this.cancel(this.active, label); }
  private cancel(card: ResultCard, label = 'CANCELED'): void {
    if (card === this.pending) this.pending = undefined;
    if (card === this.active) this.callbacks.cancel();
    card.cancel(label);
  }
  private duplicate(source: ResultCard): void {
    if (!source.view || !source.completeReceived || source.stopped) return;
    const card = this.create(source.prompt); for (const batch of source.batches) this.retain(card, batch);
    card.copyFrom(source); this.enforceBudget(card); this.callbacks.added(card);
  }
  private retain(card: ResultCard, batch: ColumnBatch): void {
    const own = this.cardBuffers.get(card)!;
    const buffers = batch.retainedBuffers ?? [batch.x.buffer, batch.y.buffer, batch.series.buffer, ...(batch.lat ? [batch.lat.buffer] : []), ...(batch.lon ? [batch.lon.buffer] : [])];
    for (const buffer of buffers) if (!own.has(buffer)) { own.add(buffer); const count = this.retained.get(buffer) ?? 0; if (!count) this.retainedBytes += buffer.byteLength; this.retained.set(buffer, count + 1); }
  }
  private release(card: ResultCard): void {
    for (const buffer of this.cardBuffers.get(card) ?? []) { const count = this.retained.get(buffer)! - 1; if (count) this.retained.set(buffer, count); else { this.retained.delete(buffer); this.retainedBytes -= buffer.byteLength; } }
    this.cardBuffers.get(card)?.clear();
  }
  private enforceBudget(keep: ResultCard): void {
    let removed = false;
    while (this.cards.length > MAX_CARDS || this.retainedBytes > MAX_BYTES) {
      const oldest = this.cards.find(c => c !== keep && c !== this.active);
      if (!oldest) break;
      this.remove(oldest); removed = true;
    }
    if (removed) this.notice('Oldest views removed to keep the canvas responsive · up to 8 views / 64 MiB of result buffers.');
  }
  private remove(card: ResultCard): void {
    if (!this.cards.includes(card)) return;
    if (card === this.active) { if (card.busy) this.cancel(card); this.active = undefined; this.callbacks.busy(false); }
    if (card === this.pending) this.pending = undefined;
    if (card === this.preview) this.preview = undefined;
    if (card.view) this.byQuery.delete(card.view.id);
    this.release(card);
    this.cardBuffers.delete(card); this.cards.splice(this.cards.indexOf(card), 1); card.destroy();
    if (this.selected === card) { this.selected = undefined; const next = this.cards.at(-1); if (next) this.select(next); }
    this.updateCount();
  }
  clear(): void {
    // Clear also stops pending live work when no result card exists yet.
    this.callbacks.cancel();
    if (this.active?.busy) this.active.cancel('CANCELED');
    for (const card of [...this.cards]) this.remove(card);
    this.x = this.y = 0; this.scale = 1; this.paintCamera();
  }
  private notice(text: string): void { const notice = this.el('board-notice'); notice.textContent = text; notice.hidden = false; clearTimeout(this.noticeTimer); this.noticeTimer = setTimeout(() => { notice.textContent = ''; notice.hidden = true; }, 8000); }
  private updateCount(): void { this.el('card-count').textContent = `${this.cards.length} ${this.cards.length === 1 ? 'view' : 'views'}`; this.el('board-empty').hidden = !!this.cards.length; }
  private zoom(factor: number): void {
    const next = Math.max(.25, Math.min(1.75, this.scale * factor));
    this.x = this.width / 2 - (this.width / 2 - this.x) * next / this.scale;
    this.y = this.height / 2 - (this.height / 2 - this.y) * next / this.scale;
    this.scale = next; this.paintCamera();
  }
  private fit(): void {
    if (!this.cards.length) return;
    const left = Math.min(...this.cards.map(c => c.x)), top = Math.min(...this.cards.map(c => c.y));
    const right = Math.max(...this.cards.map(c => c.x + c.width)), bottom = Math.max(...this.cards.map(c => c.y + c.height));
    this.scale = Math.max(.25, Math.min(1, (this.width - 48) / (right - left), (this.height - 48) / (bottom - top)));
    this.x = (this.width - (right - left) * this.scale) / 2 - left * this.scale;
    this.y = (this.height - (bottom - top) * this.scale) / 2 - top * this.scale; this.paintCamera();
  }
  private arrange(): void {
    const columns = this.width >= 900 ? 2 : 1;
    const w = Math.max(0, ...this.cards.map(c => c.width)), h = Math.max(0, ...this.cards.map(c => c.height));
    this.cards.forEach((card, i) => { card.x = 24 + i % columns * (w + 24); card.y = 24 + Math.floor(i / columns) * (h + 24); card.layout(); }); this.fit();
  }
  private paintCamera(): void {
    this.world.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    this.el('zoom-label').textContent = `${Math.round(this.scale * 100)}%`;
    for (const c of this.cards) { const x = this.x + c.x * this.scale, y = this.y + c.y * this.scale; c.setVisible(x + c.width * this.scale > 0 && y + c.height * this.scale > 0 && x < this.width && y < this.height); }
  }
  private pointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement, element = target.closest<HTMLElement>('.result-card');
    const card = element ? this.cards.find(c => c.element === element) : undefined;
    const resize = !!target.closest('.card-resize-handle');
    if (card && !resize && (!target.closest('.card-drag-handle') || target.closest('button,select,input'))) return;
    if (!card && target.closest('button,a,select,input')) return;
    this.gesture = { pointer: e.pointerId, startX: e.clientX, startY: e.clientY, x: card ? resize ? card.width : card.x : this.x, y: card ? resize ? card.height : card.y : this.y, card, resize };
    this.viewport.setPointerCapture(e.pointerId); this.viewport.classList.toggle('is-panning', !card); e.preventDefault();
  }
  private pointerMove(e: PointerEvent): void {
    const g = this.gesture; if (!g || g.pointer !== e.pointerId) return;
    const dx = e.clientX - g.startX, dy = e.clientY - g.startY;
    if (g.card) { if (g.resize) { g.card.width = Math.max(280, Math.min(1000, g.x + dx / this.scale)); g.card.height = Math.max(350, Math.min(760, g.y + dy / this.scale)); } else { g.card.x = g.x + dx / this.scale; g.card.y = g.y + dy / this.scale; } g.card.layout(); }
    else { this.x = g.x + dx; this.y = g.y + dy; }
    this.paintCamera();
  }
  destroy(): void { this.controller.abort(); this.observer.disconnect(); clearTimeout(this.noticeTimer); this.clear(); }
}
