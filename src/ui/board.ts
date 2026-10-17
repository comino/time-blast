/** The dotted spatial canvas: pan/zoom camera, card drag and resize, Fit and Arrange.
 * Camera and gesture logic carried over from the legacy workspace.ts, decoupled from results.
 * Only `shown` items take part in placement, Fit and Arrange (hidden pool cards don't). */
export interface BoardItem {
  readonly element: HTMLElement;
  x: number; y: number; width: number; height: number;
  shown: boolean;
  minHeight: number;
}

const GAP = 24;

export class Board {
  readonly items = new Set<BoardItem>();
  /** One authoring change after a completed drag/resize or Arrange, never per frame. */
  onLayout?: (items: BoardItem[]) => void;
  private x = 0; private y = 0; private scale = 1;
  private width = 1; private height = 1;
  private selected?: BoardItem;
  private gesture?: { pointer: number; startX: number; startY: number; x: number; y: number; item?: BoardItem; resize: boolean };
  private readonly controller = new AbortController();
  private readonly observer: ResizeObserver;

  constructor(private readonly viewport: HTMLElement, private readonly world: HTMLElement, private readonly zoomLabel: HTMLElement, private readonly changed: (shown: number) => void) {
    this.observer = new ResizeObserver(entries => {
      const box = entries[entries.length - 1].contentRect;
      this.width = box.width || 1; this.height = box.height || 1;
    });
    this.observer.observe(viewport);
    // One layout read at boot so the first cards get a sensible size; the observer keeps it current.
    this.width = viewport.clientWidth || 1; this.height = viewport.clientHeight || 1;
    const signal = this.controller.signal;
    viewport.addEventListener('pointerdown', e => this.pointerDown(e), { signal });
    viewport.addEventListener('pointermove', e => this.pointerMove(e), { signal });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) viewport.addEventListener(type, e => this.pointerEnd(e as PointerEvent), { signal });
    viewport.addEventListener('wheel', e => {
      if ((e.target as HTMLElement).closest('.data-table-wrap,.card-sql,select,input')) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.zoom(Math.exp(-e.deltaY * .004));
      else { this.x -= e.deltaX; this.y -= e.deltaY; this.paintCamera(); }
    }, { passive: false, signal });
    this.paintCamera();
  }

  /** Default card size for this viewport (no layout read: uses the observed size). */
  defaultSize(): { width: number; height: number } {
    const columns = this.width >= 900 ? 2 : 1;
    return { width: Math.min(548, Math.max(300, (this.width - GAP * (columns + 1)) / columns)), height: 470 };
  }

  add(item: BoardItem): void { this.items.add(item); this.world.append(item.element); this.layout(item); }
  remove(item: BoardItem): void {
    this.cancelGesture(item);
    this.items.delete(item); item.element.remove();
    if (this.selected === item) this.selected = undefined;
    this.count();
  }
  layout(item: BoardItem): void {
    const s = item.element.style;
    s.left = `${item.x}px`; s.top = `${item.y}px`; s.width = `${item.width}px`; s.height = `${item.height}px`;
  }
  /** Move `item` to the first grid position that overlaps no other shown item. */
  place(item: BoardItem): void {
    const columns = this.width >= 900 ? 2 : 1;
    const others = [...this.items].filter(o => o !== item && o.shown);
    for (let slot = 0; slot < 400; slot++) {
      const x = GAP + slot % columns * (item.width + GAP), y = GAP + Math.floor(slot / columns) * (item.height + GAP);
      if (!others.some(o => x < o.x + o.width + 12 && x + item.width + 12 > o.x && y < o.y + o.height + 12 && y + item.height + 12 > o.y)) {
        item.x = x; item.y = y; break;
      }
    }
    this.layout(item);
  }
  shown(item: BoardItem, value: boolean): void { item.shown = value; this.count(); }
  select(item: BoardItem): void {
    if (this.selected === item) return;
    if (this.selected) this.selected.element.dataset.selected = 'false';
    this.selected = item; item.element.dataset.selected = 'true';
  }
  /** Bring an item into view without moving it. */
  focus(item: BoardItem): void {
    this.select(item);
    const w = item.width * this.scale, h = item.height * this.scale;
    if (w > this.width - 24 || h > this.height - 24) this.scale = Math.max(.25, Math.min(1, (this.width - 32) / item.width, (this.height - 32) / item.height));
    const left = this.x + item.x * this.scale, top = this.y + item.y * this.scale;
    if (left < 12 || left + item.width * this.scale > this.width - 12) this.x = GAP - item.x * this.scale;
    if (top < 12 || top + item.height * this.scale > this.height - 12) this.y = GAP - item.y * this.scale;
    this.paintCamera();
  }
  zoom(factor: number): void {
    const next = Math.max(.25, Math.min(1.75, this.scale * factor));
    this.x = this.width / 2 - (this.width / 2 - this.x) * next / this.scale;
    this.y = this.height / 2 - (this.height / 2 - this.y) * next / this.scale;
    this.scale = next; this.paintCamera();
  }
  fit(): void {
    const shown = [...this.items].filter(i => i.shown);
    if (!shown.length) return;
    const left = Math.min(...shown.map(c => c.x)), top = Math.min(...shown.map(c => c.y));
    const right = Math.max(...shown.map(c => c.x + c.width)), bottom = Math.max(...shown.map(c => c.y + c.height));
    this.scale = Math.max(.25, Math.min(1, (this.width - 48) / (right - left), (this.height - 48) / (bottom - top)));
    this.x = (this.width - (right - left) * this.scale) / 2 - left * this.scale;
    this.y = (this.height - (bottom - top) * this.scale) / 2 - top * this.scale; this.paintCamera();
  }
  arrange(): void {
    this.cancelGesture();
    const columns = this.width >= 900 ? 2 : 1, shown = [...this.items].filter(i => i.shown);
    const w = Math.max(0, ...shown.map(c => c.width)), h = Math.max(0, ...shown.map(c => c.height));
    const changed: BoardItem[] = [];
    shown.forEach((item, i) => {
      const x = GAP + i % columns * (w + GAP), y = GAP + Math.floor(i / columns) * (h + GAP);
      if (item.x !== x || item.y !== y) changed.push(item);
      item.x = x; item.y = y; this.layout(item);
    });
    this.fit();
    if (changed.length) this.onLayout?.(changed);
  }
  resetCamera(): void { this.x = this.y = 0; this.scale = 1; this.paintCamera(); }
  /** A restored definition must not be overwritten by the end of an old gesture. */
  cancelGesture(item?: BoardItem): void {
    const g = this.gesture;
    if (!g || item && g.item !== item) return;
    this.gesture = undefined;
    this.viewport.classList.remove('is-panning');
    if (this.viewport.hasPointerCapture(g.pointer)) this.viewport.releasePointerCapture(g.pointer);
  }
  destroy(): void { this.cancelGesture(); this.controller.abort(); this.observer.disconnect(); }

  private count(): void { let n = 0; for (const i of this.items) if (i.shown) n++; this.changed(n); }
  private paintCamera(): void {
    this.world.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    this.zoomLabel.textContent = `${Math.round(this.scale * 100)}%`;
  }
  private itemFor(element: Element | null): BoardItem | undefined {
    if (!element) return undefined;
    for (const item of this.items) if (item.element === element) return item;
    return undefined;
  }
  private pointerDown(e: PointerEvent): void {
    if (e.button !== 0 || this.gesture) return;
    const target = e.target as HTMLElement, item = this.itemFor(target.closest('.result-card'));
    if (item) this.select(item);
    const resize = !!target.closest('.card-resize-handle');
    if (item && !resize && (!target.closest('.card-drag-handle') || target.closest('button,select,input,summary'))) return;
    if (!item && target.closest('button,a,select,input')) return;
    this.gesture = { pointer: e.pointerId, startX: e.clientX, startY: e.clientY, x: item ? resize ? item.width : item.x : this.x, y: item ? resize ? item.height : item.y : this.y, item, resize };
    this.viewport.setPointerCapture(e.pointerId); this.viewport.classList.toggle('is-panning', !item); e.preventDefault();
  }
  private pointerMove(e: PointerEvent): void {
    const g = this.gesture; if (!g || g.pointer !== e.pointerId) return;
    const dx = e.clientX - g.startX, dy = e.clientY - g.startY;
    if (g.item) {
      if (g.resize) { g.item.width = Math.max(300, Math.min(1200, g.x + dx / this.scale)); g.item.height = Math.max(g.item.minHeight, Math.min(900, g.y + dy / this.scale)); }
      else { g.item.x = g.x + dx / this.scale; g.item.y = g.y + dy / this.scale; }
      this.layout(g.item);
    } else { this.x = g.x + dx; this.y = g.y + dy; this.paintCamera(); }
  }
  private pointerEnd(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || g.pointer !== e.pointerId) return;
    this.gesture = undefined;
    this.viewport.classList.remove('is-panning');
    const item = g.item;
    if (!item || !this.items.has(item)) return;
    const changed = g.resize ? item.width !== g.x || item.height !== g.y : item.x !== g.x || item.y !== g.y;
    if (changed) this.onLayout?.([item]);
  }
}
