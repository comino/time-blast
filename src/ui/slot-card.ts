/** A result card: DOM chrome around one slot's `<canvas>`, whose control belongs to the
 * engine worker. Everything here is cold path: it changes on BIND/RESULT/axes/table, not
 * per keystroke. Text (axis labels, legend, table) is DOM; pixels are the renderer's. */
import type { AxisTicks, SlotSize, ViewName } from '../engine/contracts';
import type { Board, BoardItem } from './board';
import type { CardHandlers, ErrorInfo, ResultInfo, SlotCard } from './controller';
import { icons } from './icons';
import { describeInferStats, formatMs, type InferStats, type TimingBreakdown } from './timing';

export const VIEW_LABELS: Record<ViewName, string> = {
  line: 'Line', bar: 'Bars', scatter: 'Scatter', table: 'Table', heatmap: 'Heatmap', surface: '3D surface',
  map: 'Map', density: 'Density map', tracks: 'Voyage tracks', seasons: 'Seasonal wheel',
};

const markup = `
<header class="card-header card-drag-handle"><span class="card-glyph">${icons.chart}</span><div class="card-heading"><h2 class="card-title" data-c="title"></h2><p class="card-subtitle" data-c="subtitle">Waiting for a question</p></div><div class="card-header-actions"><button class="icon-button" data-a="close" aria-label="Remove view" title="Remove view">${icons.close}</button></div></header>
<div class="card-toolbar"><select data-c="view" aria-label="Visualization type"><option value="">Auto</option></select><div class="plot-tabs" role="tablist" aria-label="Result view"><button data-tab="chart" role="tab" aria-selected="true" class="active">Chart</button><button data-tab="table" role="tab" aria-selected="false">Data</button></div><button type="button" class="back-button" data-a="back" data-c="back" hidden title="Back to the previous query (Esc, double-click)">← Back</button><span class="drill-note mono" data-c="drill"></span><span class="live-indicator" data-c="state" data-state="loading"><span></span><b data-c="state-label">LIVE</b></span></div>
<div class="card-body">
  <div class="plot-container" data-c="plot" tabindex="0" title="Drag to zoom into a time range · click a line, bar or point to filter · double-click or Esc to go back"><canvas data-c="canvas" role="img" aria-label="Query result"></canvas><div class="axis-layer" data-c="axes" aria-hidden="true"></div><div class="brush-band" data-c="brush" hidden></div>
    <div class="view-controls" data-c="controls" hidden><label data-c="rotation-wrap" hidden>Rotate <input data-c="rotation" aria-label="Surface rotation" type="range" min="-180" max="180" value="-35" step="1"/></label><label data-c="playback-wrap" hidden><button type="button" data-a="play">Play</button><input data-c="playback" aria-label="Playback position" type="range" min="0" max="1000" value="1000" step="1"/></label></div>
    <div class="card-error" data-c="error" role="alert" hidden></div></div>
  <div class="data-table-wrap" data-c="table-wrap" hidden><table class="data-table"><thead data-c="thead"></thead><tbody data-c="tbody"></tbody></table><p data-c="table-note">No rows yet.</p></div>
</div>
<div class="plot-bottom"><div class="legend" data-c="legend"></div><span class="mono" data-c="columns"></span></div>
<details class="card-sql"><summary>${icons.code}<span>SQL</span><span class="source-pill" data-c="source">—</span></summary><pre data-c="sql">No query yet.</pre><p data-c="stats"></p></details>
<footer class="card-footer"><div class="card-latency" title="Last keystroke → first draw submitted (software timestamps, not photons)"><small>KEY → FIRST DRAW</small><strong data-c="latency">—</strong><span class="cache-pill" data-c="cache" hidden>CACHE HIT</span></div><button class="icon-button" data-a="export" aria-label="Export result as CSV" title="Export result as CSV" disabled>${icons.download}</button></footer>
<button class="card-resize-handle" aria-label="Resize view" title="Drag to resize">◢</button>`;
const template = typeof document === 'undefined' ? null : document.createElement('template');
if (template) template.innerHTML = markup;

const CHROME_HEIGHT = 200; // header + toolbar + legend + SQL + footer, for the first size estimate

export class SlotCardView implements SlotCard, BoardItem {
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  x = 0; y = 0; width: number; height: number;
  shown = false;
  readonly minHeight = 340;
  kept = false;
  private revision = -1;
  private readonly q: Record<string, HTMLElement> = {};
  private readonly xLabels: HTMLSpanElement[] = [];
  private readonly yLabels: HTMLSpanElement[] = [];
  private readonly freeLabels: HTMLSpanElement[] = [];
  private chosen: ViewName | null = null;
  private available: ViewName[] = [];
  private playing = 0;
  private readonly controller = new AbortController();
  /** Plot rectangle of the last axes (CSS px), for the brush band. */
  private plotRect: AxisTicks['plot'] | null = null;
  private lastClick: { at: number; sent: boolean } | null = null;

  constructor(readonly slot: number, private readonly handlers: CardHandlers, private readonly board: Board, private readonly onDestroy: () => void = () => {}) {
    const element = document.createElement('article');
    element.className = 'result-card card slot-card';
    element.dataset.slot = String(slot); element.dataset.idle = 'true';
    element.append(template!.content.cloneNode(true));
    this.element = element;
    for (const node of element.querySelectorAll<HTMLElement>('[data-c]')) this.q[node.dataset.c!] = node;
    this.canvas = this.q.canvas as HTMLCanvasElement;
    this.canvas.dataset.slot = String(slot);
    ({ width: this.width, height: this.height } = board.defaultSize());
    const signal = this.controller.signal;
    const on = (name: string, fn: (e: Event) => void) => element.querySelector(`[data-a="${name}"]`)!.addEventListener('click', fn, { signal });
    on('close', () => handlers.close(slot));
    on('export', () => handlers.exportCsv(slot));
    on('play', () => this.togglePlay());
    for (const tab of element.querySelectorAll<HTMLButtonElement>('[data-tab]')) tab.addEventListener('click', () => this.tab(tab.dataset.tab as 'chart' | 'table'), { signal });
    this.q.view.addEventListener('change', () => {
      const value = (this.q.view as HTMLSelectElement).value as ViewName | '';
      handlers.view(slot, value || null);
      this.controls(value || this.chosen);
    }, { signal });
    this.q.rotation.addEventListener('input', () => handlers.param(slot, 'rotation', Number((this.q.rotation as HTMLInputElement).value)), { signal });
    this.q.playback.addEventListener('input', () => { this.stopPlay(); handlers.param(slot, 'playback', Number((this.q.playback as HTMLInputElement).value) / 1000); }, { signal });
    on('back', e => handlers.back(slot, e.timeStamp));
    this.pointer(signal);
    board.add(this);
  }

  /** Initial render target size before the ResizeObserver reports the real one. */
  initialSize(): SlotSize {
    return { width: Math.max(1, Math.round(this.width - 2)), height: Math.max(1, Math.round(this.height - CHROME_HEIGHT)), devicePixelRatio: globalThis.devicePixelRatio || 1 };
  }

  // ───────────── SlotCard ─────────────

  showLive(): void {
    this.element.dataset.live = 'true';
    if (this.shown) return;
    this.board.place(this);
    this.element.dataset.idle = 'false';
    this.board.shown(this, true);
    this.board.focus(this);
  }
  hide(): void {
    this.element.dataset.idle = 'true';
    this.board.shown(this, false);
    this.reset();
  }
  keep(): void {
    this.kept = true;
    this.element.dataset.live = 'false';
    this.q['state-label'].textContent = 'KEPT';
    this.element.setAttribute('aria-label', this.q.title.textContent ?? '');
    if (!this.shown) { this.board.place(this); this.element.dataset.idle = 'false'; this.board.shown(this, true); }
  }
  title(text: string, revision: number): void {
    this.q.title.textContent = text;
    this.element.setAttribute('aria-label', `${this.kept ? '' : 'Live preview: '}${text}`);
    if (revision === this.revision) return;
    this.revision = revision;
    this.q.subtitle.textContent = `r.${revision}`;
    this.q.state.dataset.state = 'loading';
    this.q.error.hidden = true;
  }
  result(info: ResultInfo, request: number): void {
    this.q.sql.textContent = info.sql;
    this.q.source.textContent = info.cached ? 'CACHED SQL' : `REQUEST ${request}`;
    // The coordinator never sees the schema (columns: []); the renderer's views message fills
    // columns and the subtitle, so only overwrite them when RESULT actually carries columns.
    if (info.columns.length) {
      this.q.columns.textContent = info.columns.map(c => `${c.name}${c.role ? `·${c.role}` : ''}`).join('  ');
      const subtitle = this.q.subtitle.textContent?.split(' · ')[0] ?? '';
      this.q.subtitle.textContent = `${subtitle} · ${info.columns.length} columns${info.view ? ` · ${VIEW_LABELS[info.view] ?? info.view}` : ''}`;
    }
    this.q.state.dataset.state = 'ready';
    (this.element.querySelector('[data-a="export"]') as HTMLButtonElement).disabled = false;
  }
  views(available: ViewName[], chosen: ViewName, columns?: Array<{ name: string; role: string }>): void {
    this.available = available; this.chosen = chosen;
    const select = this.q.view as HTMLSelectElement, current = select.value;
    const options = [`<option value="">Auto · ${VIEW_LABELS[chosen] ?? chosen}</option>`, ...available.map(v => `<option value="${v}">${VIEW_LABELS[v] ?? v}</option>`)];
    select.innerHTML = options.join('');
    // Each new result starts from the renderer's choice; keep a pick only if it is what's shown.
    select.value = current === chosen ? current : '';
    if (columns) {
      this.q.columns.textContent = columns.map(c => `${c.name}${c.role ? `·${c.role}` : ''}`).join('  ');
      const subtitle = this.q.subtitle.textContent?.split(' · ')[0] ?? '';
      this.q.subtitle.textContent = `${subtitle} · ${columns.length} columns · ${VIEW_LABELS[chosen] ?? chosen}`;
    }
    this.controls((select.value as ViewName) || chosen);
  }
  axes(ticks: AxisTicks): void {
    const layer = this.q.axes, { plot } = ticks;
    this.plotRect = plot.width > 0 && plot.height > 0 ? plot : null;
    this.labels(this.xLabels, ticks.x.length, 'axis-x');
    this.labels(this.yLabels, ticks.y.length, 'axis-y');
    const below = plot.top + plot.height + 4;
    ticks.x.forEach((tick, i) => {
      const span = this.xLabels[i];
      if (span.textContent !== tick.label) span.textContent = tick.label;
      span.style.transform = `translate(${tick.at}px,${below}px) translateX(-50%)`;
    });
    ticks.y.forEach((tick, i) => {
      const span = this.yLabels[i];
      if (span.textContent !== tick.label) span.textContent = tick.label;
      span.style.transform = `translate(${plot.left - 6}px,${tick.at}px) translate(-100%,-50%)`;
    });
    const free = ticks.labels ?? [];
    this.labels(this.freeLabels, free.length, 'axis-free');
    free.forEach((l, i) => {
      const span = this.freeLabels[i];
      if (span.textContent !== l.label) span.textContent = l.label;
      span.style.transform = `translate(${l.x}px,${l.y}px) translate(${-l.anchor * 100}%,-50%)`;
    });
    layer.hidden = false;
    const legend = this.q.legend;
    legend.textContent = '';
    (ticks.legend ?? []).forEach((entry, i) => {
      const span = document.createElement('span'), dot = document.createElement('i');
      span.dataset.i = String(i);
      dot.style.background = entry.color; span.append(dot, entry.label); legend.append(span);
    });
  }
  table(columns: string[], rows: string[][], total: number): void {
    const head = document.createElement('tr');
    for (const c of columns) { const th = document.createElement('th'); th.textContent = c; head.append(th); }
    this.q.thead.replaceChildren(head);
    const body = document.createDocumentFragment();
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const cell of row) { const td = document.createElement('td'); td.textContent = cell; tr.append(td); }
      body.append(tr);
    }
    this.q.tbody.replaceChildren(body);
    this.q['table-note'].textContent = `${rows.length.toLocaleString('en')} of ${total.toLocaleString('en')} rows shown. Export for the complete result.`;
  }
  timing(t: TimingBreakdown): void {
    this.q.latency.textContent = formatMs(t.headline);
    this.q.cache.hidden = !t.cacheHit;
    this.q.state.dataset.state = t.headline === null ? 'loading' : 'ready';
  }
  inferStats(s: InferStats): void { this.q.stats.textContent = describeInferStats(s); }
  error(e: ErrorInfo): void {
    const box = this.q.error;
    box.textContent = '';
    const strong = document.createElement('strong'); strong.textContent = e.message;
    box.append(strong);
    if (e.detail) { const small = document.createElement('small'); small.textContent = e.detail; box.append(small); }
    box.hidden = false;
    this.q.state.dataset.state = 'error';
  }
  drill(depth: number, note: string): void {
    this.q.back.hidden = depth === 0;
    this.q.back.textContent = depth > 1 ? `← Back (${depth})` : '← Back';
    this.q.drill.textContent = note;
  }
  destroy(): void {
    this.stopPlay();
    this.controller.abort();
    this.board.remove(this);
    this.onDestroy();
  }

  // ───────────── internals ─────────────

  /** Chart-as-query gestures: drag = brush an x range, click = point (series/bar/map point),
   * legend click = series, double-click / Esc / Back = previous SQL. Coordinates are CSS px of the
   * canvas (the board may scale the card, so client px are divided by that scale). */
  private pointer(signal: AbortSignal): void {
    const plot = this.q.plot, brush = this.q.brush, canvas = this.canvas;
    const local = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect(), scale = r.width / (canvas.clientWidth || r.width || 1) || 1;
      return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
    };
    let start: { x: number; id: number } | null = null, brushing = false, swallowClick = false;
    const band = (x0: number, x1: number) => {
      const p = this.plotRect!;
      const a = Math.max(p.left, Math.min(x0, x1)), b = Math.min(p.left + p.width, Math.max(x0, x1));
      brush.style.transform = `translate(${a}px,${p.top}px)`; brush.style.width = `${Math.max(0, b - a)}px`; brush.style.height = `${p.height}px`;
      brush.hidden = false;
    };
    plot.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !this.plotRect || (e.target as HTMLElement).closest('.view-controls,.card-error')) return;
      plot.focus({ preventScroll: true });
      start = { x: local(e).x, id: e.pointerId }; brushing = false;
      plot.setPointerCapture(e.pointerId);
    }, { signal });
    plot.addEventListener('pointermove', e => {
      if (!start || e.pointerId !== start.id) return;
      const x = local(e).x;
      if (!brushing && Math.abs(x - start.x) < 5) return;
      brushing = true;
      band(start.x, x);
    }, { signal });
    plot.addEventListener('pointerup', e => {
      if (!start || e.pointerId !== start.id) return;
      const from = start.x, x = local(e).x;
      start = null;
      if (!brushing) return;
      brushing = false; brush.hidden = true; swallowClick = true;
      this.handlers.gesture(this.slot, { kind: 'brush', x0: from, x1: x }, e.timeStamp);
    }, { signal });
    plot.addEventListener('pointercancel', () => { start = null; brushing = false; brush.hidden = true; }, { signal });
    plot.addEventListener('click', e => {
      if (swallowClick) { swallowClick = false; return; }
      if (e.detail > 1 || (e.target as HTMLElement).closest('.view-controls,.card-error')) return;
      const p = local(e);
      this.lastClick = { at: e.timeStamp, sent: this.handlers.gesture(this.slot, { kind: 'point', x: p.x, y: p.y }, e.timeStamp) };
    }, { signal });
    plot.addEventListener('dblclick', e => {
      e.preventDefault();
      this.handlers.back(this.slot, e.timeStamp, !!this.lastClick?.sent && e.timeStamp - this.lastClick.at < 700);
    }, { signal });
    plot.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      this.handlers.back(this.slot, e.timeStamp);
    }, { signal });
    this.q.legend.addEventListener('click', e => {
      const span = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (span) this.handlers.gesture(this.slot, { kind: 'legend', index: Number(span.dataset.i) }, e.timeStamp);
    }, { signal });
  }

  private reset(): void {
    this.revision = -1;
    this.plotRect = null;
    this.drill(0, '');
    this.element.dataset.live = 'false';
    this.q.title.textContent = '';
    this.q.subtitle.textContent = 'Waiting for a question';
    this.q.sql.textContent = 'No query yet.'; this.q.stats.textContent = ''; this.q.source.textContent = '—';
    this.q.columns.textContent = ''; this.q.legend.textContent = ''; this.q.latency.textContent = '—';
    this.q.cache.hidden = true; this.q.error.hidden = true; this.q.axes.hidden = true;
    this.q.tbody.textContent = ''; this.q.thead.textContent = ''; this.q['table-note'].textContent = 'No rows yet.';
    (this.element.querySelector('[data-a="export"]') as HTMLButtonElement).disabled = true;
    this.stopPlay();
  }
  private labels(pool: HTMLSpanElement[], count: number, className: string): void {
    while (pool.length < count) { const span = document.createElement('span'); span.className = className; this.q.axes.append(span); pool.push(span); }
    for (let i = 0; i < pool.length; i++) pool[i].hidden = i >= count;
  }
  private tab(which: 'chart' | 'table'): void {
    for (const tab of this.element.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      const active = tab.dataset.tab === which; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active));
    }
    this.q['table-wrap'].hidden = which !== 'table';
    this.q.plot.hidden = which !== 'chart';
  }
  private controls(view: ViewName | null): void {
    const surface = view === 'surface', tracks = view === 'tracks';
    this.q['rotation-wrap'].hidden = !surface;
    this.q['playback-wrap'].hidden = !tracks;
    this.q.controls.hidden = !surface && !tracks;
    if (!tracks) this.stopPlay();
  }
  private togglePlay(): void {
    if (this.playing) { this.stopPlay(); return; }
    const input = this.q.playback as HTMLInputElement, button = this.element.querySelector('[data-a="play"]')!;
    let start = performance.now();
    const from = Number(input.value) >= 1000 ? 0 : Number(input.value);
    button.textContent = 'Pause';
    const step = (now: number) => {
      const value = Math.min(1000, from + (now - start) / 6);
      input.value = String(value);
      this.handlers.param(this.slot, 'playback', value / 1000);
      if (value >= 1000) { this.stopPlay(); return; }
      this.playing = requestAnimationFrame(step);
    };
    start = performance.now();
    this.playing = requestAnimationFrame(step);
  }
  private stopPlay(): void {
    if (!this.playing) return;
    cancelAnimationFrame(this.playing); this.playing = 0;
    const button = this.element.querySelector('[data-a="play"]'); if (button) button.textContent = 'Play';
  }
}
