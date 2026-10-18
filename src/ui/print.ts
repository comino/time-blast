/** Print / PDF. The live board is never touched: printing builds a static sheet from copies of
 * the shown cards and lets the browser print that (Save as PDF). Chart pixels come from the
 * render worker as PNGs at print resolution, because a canvas whose control moved to a worker
 * prints blank. Titles, axis labels and legends are the cards' own DOM, so they stay text.
 * Cold path: runs only when the user prints. */
import type { EngineToUi, UiToEngine } from '../engine/contracts';

export interface PrintCard { readonly slot: number; readonly element: HTMLElement; readonly x: number; readonly y: number; readonly width: number }

/** ~290 dpi on paper (a CSS px is 1/96 in). */
const PRINT_DPR = 3;
/** Content width of A4 or Letter portrait inside the 12 mm page padding, in CSS px: wider cards scale down. */
const PAGE_WIDTH = 700;
const SNAPSHOT_TIMEOUT_MS = 5000;

type Images = Extract<EngineToUi, { type: 'snapshot' }>['images'];

export class Printer {
  private next = 1;
  private readonly waiting = new Map<number, (images: Images) => void>();
  private sheet?: HTMLElement;
  private urls: string[] = [];
  private title?: string;
  private busy = false;

  constructor(private readonly post: (message: UiToEngine) => void) {
    addEventListener('afterprint', () => this.cleanup());
  }

  /** Handles a worker reply; false when `message` is not for the printer. */
  receive(message: EngineToUi): boolean {
    if (message.type !== 'snapshot') return false;
    this.waiting.get(message.id)?.(message.images);
    this.waiting.delete(message.id);
    return true;
  }

  async print(title: string, cards: readonly PrintCard[]): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.cleanup();
      const ordered = [...cards].sort((a, b) => a.y - b.y || a.x - b.x);
      const images = await this.snapshot(ordered.map(c => c.slot));
      this.sheet = await this.build(title, ordered, images);
      document.body.append(this.sheet);
      document.body.classList.add('printing');
      // The browser names the PDF after the document title.
      this.title = document.title; document.title = title;
      print();
    } finally { this.busy = false; }
  }

  private snapshot(slots: number[]): Promise<Map<number, Blob>> {
    const id = this.next++;
    return new Promise(resolve => {
      const done = (images: Images) => { clearTimeout(timer); resolve(new Map(images.filter(i => i.image).map(i => [i.slot, i.image!]))); };
      const timer = setTimeout(() => { this.waiting.delete(id); done([]); }, SNAPSHOT_TIMEOUT_MS);
      this.waiting.set(id, done);
      this.post({ type: 'snapshot', id, slots, devicePixelRatio: Math.max(PRINT_DPR, devicePixelRatio || 1) });
    });
  }

  private async build(title: string, cards: readonly PrintCard[], images: Map<number, Blob>): Promise<HTMLElement> {
    const sheet = document.createElement('div');
    sheet.className = 'print-sheet';
    const head = document.createElement('header');
    head.className = 'print-head';
    const brand = document.querySelector('.brand')?.cloneNode(true) as HTMLElement | undefined;
    const h1 = document.createElement('h1'); h1.textContent = title;
    const meta = document.createElement('p');
    meta.textContent = `${cards.length} ${cards.length === 1 ? 'view' : 'views'} · ${new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
    head.append(...(brand ? [brand] : []), h1, meta);
    const flow = document.createElement('div');
    flow.className = 'print-flow';
    const decoding: Promise<void>[] = [];
    for (const card of cards) {
      const item = document.createElement('section');
      item.className = 'print-item';
      if (card.width > PAGE_WIDTH) item.style.zoom = String(PAGE_WIDTH / card.width);
      item.append(this.copy(card, images.get(card.slot), decoding));
      flow.append(item);
    }
    sheet.append(head, flow);
    await Promise.all(decoding);
    return sheet;
  }

  /** A static copy of a card. The plot keeps its exact on-screen size, so the PNG and the DOM
   * axis labels (positioned in CSS px) line up as they do on screen. */
  private copy(card: PrintCard, image: Blob | undefined, decoding: Promise<void>[]): HTMLElement {
    const live = card.element, copy = live.cloneNode(true) as HTMLElement;
    copy.removeAttribute('data-selected');
    copy.style.position = 'relative'; copy.style.left = copy.style.top = ''; copy.style.height = 'auto';
    for (const selector of ['.plot-container', '.data-table-wrap']) {
      const from = live.querySelector<HTMLElement>(selector), to = copy.querySelector<HTMLElement>(selector);
      if (from && to && from.offsetWidth) { to.style.width = `${from.offsetWidth}px`; to.style.height = `${from.offsetHeight}px`; }
    }
    copy.querySelector('details.card-sql')?.setAttribute('open', '');
    const canvas = copy.querySelector('canvas');
    if (canvas) {
      const img = document.createElement('img');
      img.className = 'print-plot'; img.alt = canvas.getAttribute('aria-label') ?? 'Chart';
      if (image) {
        const url = URL.createObjectURL(image); this.urls.push(url); img.src = url;
        decoding.push(img.decode().catch(() => {}));
      }
      canvas.replaceWith(img);
    }
    return copy;
  }

  private cleanup(): void {
    this.sheet?.remove(); this.sheet = undefined;
    document.body.classList.remove('printing');
    if (this.title !== undefined) { document.title = this.title; this.title = undefined; }
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
  }
}
