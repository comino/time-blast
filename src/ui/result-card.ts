import { METRIC_LABELS, type ChartView, type ColumnBatch, type QueryTiming, type QueryView } from '../core/types';
import { SERIES_COLORS, StreamChart, type BatchProgress } from './chart';
import { icon } from './shell';
import { VIEWS, definition, isPrimary, isAdvanced, unavailableReason, warmRenderer, rendererFactory } from './renderer-registry';
import type { ResultRenderer } from './renderer-contract';

export type CardMode = ChartView;
const fmt = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('en');
const dates = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const viewOptions = VIEWS.map(view => `<option value="${view.id}">${view.label}</option>`).join('') + '<option disabled>Photos · dataset has no image URLs</option>';
const glyph = icon('<path d="M4 17 9 10l4 3 7-9M4 4v16h16"/>');
const markup = `
  <header class="card-header card-drag-handle"><span class="card-glyph">${glyph}</span><div class="card-heading"><h2 class="card-title" data-card-el="plot-title"></h2><p class="card-subtitle" data-card-el="plot-subtitle">Preparing your question…</p></div><div class="card-header-actions"><button class="icon-button" data-card-action="duplicate" aria-label="Duplicate view" title="Duplicate view without a new query" disabled>${icon('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>')}</button><button class="icon-button" data-card-action="close" aria-label="Remove view" title="Remove view">${icon('<path d="m6 6 12 12M18 6 6 18"/>')}</button></div></header>
  <div class="card-toolbar"><select data-card-el="representation" aria-label="Visualization type">${viewOptions}</select><div class="plot-tabs" role="tablist" aria-label="Result view"><button data-card-tab="chart" role="tab" aria-selected="true" class="active">Chart</button><button data-card-tab="table" role="tab" aria-selected="false">Data</button></div><span class="live-indicator" data-card-el="result-state" data-state="loading"><span></span>THINKING</span></div>
  <div class="card-body">
    <div class="plot-container" data-card-el="plot-container"><canvas data-card-el="chart" aria-label="Query result chart" role="img"></canvas></div>
    <div class="track-surface advanced-surface" data-card-el="track-wrap" hidden><canvas data-card-el="track" aria-label="Query visualization" role="img"></canvas><div class="view-controls" data-card-el="view-controls" hidden><label data-card-el="rotation-wrap" hidden>Rotate <input data-card-el="rotation" aria-label="Surface rotation" type="range" min="-180" max="180" value="-35" step="5"/></label><label data-card-el="playback-wrap" hidden><button type="button" data-card-action="playback">Play voyage</button><input data-card-el="playback" aria-label="Voyage time" type="range" min="0" max="1000" value="1000" step="1"/><span data-card-el="playback-time"></span></label></div><div class="track-empty" data-card-el="track-empty" hidden>No coordinates in this result.</div></div>
    <div class="data-table-wrap" data-card-el="table-wrap" hidden><table class="data-table"><thead><tr><th>TIME · UTC</th><th>SERIES</th><th data-card-el="value-header">VALUE</th></tr></thead><tbody data-card-el="table-body"></tbody></table><p>First 12 points. Export the complete result below.</p></div>
    <div class="plot-empty card-loading" data-card-el="plot-empty"><div class="loading-orb"><i></i><i></i><i></i><b></b></div><span data-card-el="empty-title">Following your question</span><small data-card-el="empty-detail">Preparing a validated query.</small></div>
  </div>
  <p class="view-caption" data-card-el="view-caption" hidden></p><div class="plot-bottom"><div class="legend" data-card-el="legend"></div><span class="mono" data-card-el="time-range">UTC</span></div>
  <div class="card-stats"><div><span>MEAN <small data-card-el="mean-unit"></small></span><strong data-card-el="mean">—</strong></div><div><span>POINTS</span><strong data-card-el="points">—</strong></div><div><span>RANGE</span><strong data-card-el="range">—</strong></div><div><span>RUN → DRAW</span><strong data-card-el="latency">—</strong></div></div>
  <div class="card-timings" aria-label="Query latency breakdown"><div title="Time spent resolving the query intent, including model queueing and remote transport when used"><span data-card-el="inference-label">TRANSLATION</span><strong data-card-el="inference-latency">—</strong></div><div title="Database request to first nonempty batch, including queueing and decoding"><span data-card-el="database-first-label">DB → FIRST</span><strong data-card-el="database-first-latency">—</strong></div><div title="Database request to stream completion; includes first-batch time and streaming"><span data-card-el="database-label">DB TOTAL</span><strong data-card-el="database-latency">—</strong></div><div title="First batch delivered to this card to first drawing submission, including renderer readiness"><span>DATA → DRAW</span><strong data-card-el="render-latency">—</strong></div></div>
  <footer class="card-footer result-footer"><button class="detail-button" data-card-action="sql" aria-expanded="false">${icon('<path d="m8 7-5 5 5 5m8-10 5 5-5 5"/>')}<span>Query details</span><span class="source-pill" data-card-el="source">—</span></button><span class="card-batch-count" data-card-el="batch-count">Waiting for data</span><div class="result-actions"><button class="text-button cancel-button" data-card-action="cancel">Stop query</button><button class="icon-button" data-card-action="export" aria-label="Export result as CSV" title="Export result as CSV" disabled>${icon('<path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4"/>')}</button></div></footer>
  <div class="sql-panel" data-card-el="sql-panel" hidden><p class="inference-detail" data-card-el="inference-detail" hidden></p><pre data-card-el="sql">A validated query will appear here.</pre><p data-card-el="query-meta"></p><p data-card-el="latency-detail">First point draw submitted</p></div>
  <button class="card-resize-handle" aria-label="Resize view" title="Drag to resize">◢</button>`;
// Parse static chrome once during module warmup, outside the Enter path.
const template = document.createElement('template');
template.innerHTML = markup;

export interface CardCallbacks {
  select(card: ResultCard): void;
  close(card: ResultCard): void;
  duplicate(card: ResultCard): void;
  cancel(card: ResultCard): void;
  change(card: ResultCard): void;
  draw(id: string, at: number): void;
}

/** A result owns only view/index state. Producer columns stay shared by reference. */
export class ResultCard {
  readonly element = document.createElement('article');
  readonly chart: StreamChart;
  view?: QueryView;
  mode: CardMode = 'line';
  x = 0; y = 0; width = 548; height = 440;
  total = 0;
  completeReceived = false;
  stopped = false;
  private renderer?: ResultRenderer;
  private rendererMode?: CardMode;
  private rendererLoading = false;
  private rendererError = false;
  private rendererEpoch = 0;
  private lastChart: CardMode = 'line';
  private playbackFrame = 0;
  private visible = true;
  private explicitMode = false;
  private copied = false;
  private batchCount = 0;
  private tableRows = 0;
  private destroyed = false;
  private sum = 0; private count = 0;
  private minimum = Infinity; private maximum = -Infinity;
  private readonly series = new Set<number>();
  private readonly elements = new Map<string, HTMLElement>();
  private readonly actions = new Map<string, HTMLButtonElement>();

  constructor(readonly id: string, public prompt: string, parent: HTMLElement, private callbacks: CardCallbacks) {
    this.element.className = 'result-card card is-loading'; this.element.dataset.cardId = id;
    this.element.tabIndex = 0; this.element.setAttribute('aria-label', prompt); this.element.append(template.content.cloneNode(true));
    parent.append(this.element); this.layout();
    this.element.querySelectorAll<HTMLElement>('[data-card-el]').forEach(e => this.elements.set(e.dataset.cardEl!, e));
    this.element.querySelectorAll<HTMLButtonElement>('[data-card-action]').forEach(e => this.actions.set(e.dataset.cardAction!, e));
    this.part('plot-title').textContent = prompt;
    this.chart = new StreamChart(this.part<HTMLCanvasElement>('chart'), (id, at) => this.recordDraw(id, at),
      p => this.progress(p), reordered => this.renderer?.indexed(reordered), () => this.updateCompletion(), false);
    this.element.addEventListener('pointerdown', () => callbacks.select(this));
    this.element.addEventListener('focusin', () => callbacks.select(this));
    this.part<HTMLSelectElement>('representation').addEventListener('change', () => this.setMode(this.part<HTMLSelectElement>('representation').value as CardMode));
    this.part('representation').addEventListener('pointerenter', () => { for (const mode of ['heatmap', 'map', 'seasons'] as const) void warmRenderer(mode).catch(() => {}); });
    this.element.querySelectorAll<HTMLButtonElement>('[data-card-tab]').forEach(button => button.addEventListener('click', () => this.setMode(button.dataset.cardTab === 'table' ? 'table' : this.lastChart)));
    this.part<HTMLInputElement>('rotation').addEventListener('input', () => this.renderer?.setAngle?.(Number(this.part<HTMLInputElement>('rotation').value)));
    this.part<HTMLInputElement>('playback').addEventListener('input', () => { this.stopPlayback(); this.setPlayback(Number(this.part<HTMLInputElement>('playback').value) / 1000); });
    this.actions.get('playback')!.onclick = () => this.togglePlayback();
    this.actions.get('close')!.onclick = () => callbacks.close(this);
    this.actions.get('duplicate')!.onclick = () => callbacks.duplicate(this);
    this.actions.get('cancel')!.onclick = () => callbacks.cancel(this);
    this.actions.get('sql')!.onclick = () => { const panel = this.part('sql-panel'); panel.hidden = !panel.hidden; this.actions.get('sql')!.setAttribute('aria-expanded', String(!panel.hidden)); };
    this.actions.get('export')!.onclick = () => this.export();
  }

  private part<T extends HTMLElement = HTMLElement>(name: string): T { return this.elements.get(name)! as T; }
  get busy(): boolean { return !this.stopped && (!this.completeReceived || !this.settled); }
  private get settled(): boolean { return !this.total || this.chart.isSettled && (!isAdvanced(this.mode) || !this.visible || this.rendererError || !this.rendererLoading && !!this.renderer?.isSettled); }
  get batches(): readonly ColumnBatch[] { return this.chart.batches; }
  layout(): void { Object.assign(this.element.style, { left: `${this.x}px`, top: `${this.y}px`, width: `${this.width}px`, height: `${this.height}px` }); }
  select(selected: boolean): void {
    this.element.dataset.selected = String(selected);
    for (const [name, e] of this.elements) selected ? e.setAttribute('data-el', name) : e.removeAttribute('data-el');
    for (const [name, e] of this.actions) selected ? e.setAttribute('data-action', name) : e.removeAttribute('data-action');
    this.element.querySelectorAll<HTMLElement>('[data-card-tab]').forEach(e => selected ? e.setAttribute('data-tab', e.dataset.cardTab!) : e.removeAttribute('data-tab'));
  }
  /** Reuse live card chrome and canvas storage; old query buffers are released. */
  reset(prompt: string): void {
    if (this.destroyed) return;
    this.rendererEpoch++; this.stopPlayback(); this.renderer?.destroy(); this.renderer = undefined;
    this.rendererMode = undefined; this.rendererLoading = this.rendererError = false;
    this.chart.reset(); this.view = undefined; this.prompt = prompt;
    this.mode = this.lastChart = 'line'; this.explicitMode = this.copied = false;
    this.total = this.batchCount = this.tableRows = this.sum = this.count = 0;
    this.minimum = Infinity; this.maximum = -Infinity; this.series.clear();
    this.completeReceived = this.stopped = false;
    this.element.classList.add('is-loading'); this.element.setAttribute('aria-label', prompt);
    this.part('plot-title').textContent = prompt; this.part('plot-subtitle').textContent = 'Preparing your question…';
    this.part('empty-title').textContent = 'Following your question'; this.part('empty-detail').textContent = 'Preparing a validated query.';
    this.part('plot-empty').hidden = false; this.part('plot-container').hidden = false;
    this.part('track-wrap').hidden = this.part('table-wrap').hidden = this.part('view-caption').hidden = true;
    this.part('sql-panel').hidden = true; this.actions.get('sql')!.setAttribute('aria-expanded', 'false');
    this.part('sql').textContent = 'A validated query will appear here.'; this.part('query-meta').textContent = '';
    this.part('latency-detail').textContent = 'First point draw submitted';
    this.part('inference-detail').textContent = ''; this.part('inference-detail').hidden = true;
    this.part('legend').replaceChildren(); this.part('table-body').replaceChildren();
    this.part('mean-unit').textContent = ''; this.part('time-range').textContent = 'UTC'; this.part('batch-count').textContent = 'Waiting for data';
    for (const name of ['source', 'mean', 'points', 'range', 'latency', 'inference-latency', 'database-first-latency', 'database-latency', 'render-latency']) this.part(name).textContent = '—';
    this.part('inference-label').textContent = 'TRANSLATION'; this.part('database-first-label').textContent = 'DB → FIRST'; this.part('database-label').textContent = 'DB TOTAL';
    this.actions.get('duplicate')!.disabled = this.actions.get('export')!.disabled = true; this.actions.get('cancel')!.hidden = false;
    const representation = this.part<HTMLSelectElement>('representation'); representation.disabled = false; representation.value = 'line';
    for (const option of representation.options) if (VIEWS.some(v => v.id === option.value)) { option.disabled = false; option.title = ''; }
    this.element.querySelectorAll<HTMLButtonElement>('[data-card-tab]').forEach(e => { const active = e.dataset.cardTab === 'chart'; e.classList.toggle('active', active); e.setAttribute('aria-selected', String(active)); });
    // begin() selects the validated view and restarts work when inference finishes.
    this.chart.setVisible(false); this.setState('THINKING', 'loading');
  }
  begin(view: QueryView): void {
    if (this.stopped || this.destroyed) return;
    this.view = view;
    const metric = METRIC_LABELS[view.plan.metric];
    this.part('plot-title').textContent = `${metric.name}${view.plan.splitByVessel ? ' across the fleet' : ''}`;
    this.part('plot-subtitle').textContent = `${({ avg: 'Average', min: 'Minimum', max: 'Maximum' })[view.plan.aggregate]} · ${view.plan.bucketMinutes} min buckets · ${view.plan.windowHours < 48 ? `${view.plan.windowHours} hours` : `${view.plan.windowHours / 24} days`}`;
    this.part('time-range').textContent = `${dates.format(Math.max(view.context.start, view.context.end - view.plan.windowHours * 3_600_000))} — ${dates.format(view.context.end)} · UTC`;
    this.part('sql').textContent = view.sql; this.part('source').textContent = ({ template: 'LOCAL TEMPLATE', webgpu: 'LOCAL MODEL', remote: 'REMOTE MODEL' })[view.source];
    this.part('query-meta').textContent = `${view.id} · revision ${view.revision}${view.model ? ` · ${view.model}` : ''}`;
    this.part('mean-unit').textContent = metric.unit; this.part('value-header').textContent = `${metric.name.toUpperCase()} · ${metric.unit}`;
    this.chart.begin(view);
    for (const option of this.part<HTMLSelectElement>('representation').options) if (VIEWS.some(v => v.id === option.value)) {
      const reason = unavailableReason(option.value as CardMode, view); option.disabled = !!reason; option.title = reason ?? '';
    }
    if (!this.explicitMode) this.mode = view.plan.view;
    this.setMode(this.mode, false);
    this.setState('QUERYING', 'loading'); this.part('empty-title').textContent = 'Listening for the first point'; this.part('empty-detail').textContent = 'Drawing begins as soon as data arrives.';
    this.updateTiming();
  }
  append(batch: ColumnBatch): void {
    if (this.stopped || this.destroyed || this.completeReceived || !this.view) return;
    this.total += batch.length; this.batchCount++;
    if (batch.length) { if (!this.rendererLoading) { this.part('plot-empty').hidden = true; this.element.classList.remove('is-loading'); } this.actions.get('export')!.disabled = false; }
    this.chart.append(batch);
    this.renderer?.append(batch);
    if (this.mode === 'table') { this.renderTable(); if (this.visible && batch.length) this.recordDraw(this.view.id, performance.now()); }
    this.part('points').textContent = integer.format(this.total); this.part('batch-count').textContent = `${this.batchCount} ${this.batchCount === 1 ? 'batch' : 'batches'}`;
    this.setState('STREAMING', 'ready'); this.callbacks.change(this);
    if (this.batchCount === 1) this.updateTiming();
  }
  finish(timing: QueryTiming): void {
    if (this.stopped || this.completeReceived || !this.view) return;
    this.view.timing = timing; this.completeReceived = true; this.updateTiming();
    this.actions.get('duplicate')!.disabled = false;
    if (definition(this.mode).family === 'geo') this.part('track-empty').hidden = this.batches.some(b => b.length && b.lat && b.lon);
    if (!this.total) { this.element.classList.remove('is-loading'); this.part('empty-title').textContent = 'No matching observations'; this.part('empty-detail').textContent = 'Try a wider time window or another vessel.'; this.part('points').textContent = '0'; }
    this.updateCompletion();
  }
  cancel(label = 'CANCELED'): void {
    if (this.stopped || this.destroyed) return;
    const loadingView = this.rendererLoading;
    this.stopped = true; this.chart.stop(); this.renderer?.stop(); this.rendererEpoch++; this.rendererLoading = false; this.stopPlayback(); this.element.classList.remove('is-loading');
    this.part<HTMLSelectElement>('representation').disabled = true;
    this.setState(label, 'quiet'); this.actions.get('cancel')!.hidden = true;
    if (!this.total || loadingView) { this.part('empty-title').textContent = 'Question stopped'; this.part('empty-detail').textContent = 'Ask another question to add a fresh view.'; }
    else this.part('plot-subtitle').textContent += ' · partial result';
    this.callbacks.change(this);
  }
  error(message: string): void {
    this.cancel('QUERY ERROR'); this.setState('QUERY ERROR', 'error');
    this.part('empty-title').textContent = 'This question needs another pass'; this.part('empty-detail').textContent = message;
    if (this.total) this.part('plot-subtitle').textContent = `Incomplete result · ${message}`;
  }
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible; this.element.classList.toggle('is-offscreen', !visible);
    if (!visible) this.stopPlayback();
    this.chart.setVisible(visible && isPrimary(this.mode)); this.renderer?.setVisible(visible && isAdvanced(this.mode));
    if (visible && this.mode === 'table' && this.total && this.view) this.recordDraw(this.view.id, performance.now());
    this.updateCompletion();
  }
  setMode(mode: CardMode, explicit = true): void {
    if (this.stopped || !VIEWS.some(view => view.id === mode)) return;
    const reason = unavailableReason(mode, this.view);
    if (reason) { this.part<HTMLSelectElement>('representation').value = this.mode; return; }
    if (mode !== 'table') this.lastChart = mode;
    if (this.mode !== mode) this.stopPlayback();
    this.mode = mode; this.explicitMode ||= explicit;
    this.part<HTMLSelectElement>('representation').value = mode;
    this.part('plot-container').hidden = !isPrimary(mode); this.part('track-wrap').hidden = !isAdvanced(mode); this.part('table-wrap').hidden = mode !== 'table';
    this.part('view-caption').textContent = definition(mode).caption; this.part('view-caption').hidden = !definition(mode).caption;
    this.part('view-controls').hidden = mode !== 'surface' && mode !== 'tracks'; this.part('rotation-wrap').hidden = mode !== 'surface'; this.part('playback-wrap').hidden = mode !== 'tracks';
    this.element.querySelectorAll<HTMLButtonElement>('[data-card-tab]').forEach(e => { const active = (mode === 'table') === (e.dataset.cardTab === 'table'); e.classList.toggle('active', active); e.setAttribute('aria-selected', String(active)); });
    this.chart.setVisible(this.visible && isPrimary(mode));
    if (isPrimary(mode)) this.chart.setRepresentation(mode as 'line' | 'bar' | 'scatter');
    if (isAdvanced(mode)) this.ensureRenderer(mode);
    else { this.rendererEpoch++; this.rendererLoading = false; this.renderer?.destroy(); this.renderer = undefined; this.rendererMode = undefined; if (this.total) this.part('plot-empty').hidden = true; }
    if (mode === 'table') { this.renderTable(); if (this.visible && this.total && this.view) this.recordDraw(this.view.id, performance.now()); }
    this.updateCompletion();
  }
  private ensureRenderer(mode: CardMode): void {
    if (!this.view || this.destroyed || this.stopped) return;
    if (this.rendererMode === mode && (this.renderer || this.rendererLoading)) { this.renderer?.setVisible(this.visible); return; }
    this.renderer?.destroy(); this.renderer = undefined; this.rendererMode = mode; this.rendererLoading = true; this.rendererError = false;
    const epoch = ++this.rendererEpoch;
    this.part('track-empty').hidden = true;
    this.part('plot-empty').hidden = false; this.element.classList.add('is-loading');
    this.part('empty-title').textContent = `Preparing ${definition(mode).label.toLowerCase()}`;
    this.part('empty-detail').textContent = 'Reusing query columns. No extra query.';
    const mount = () => {
      if (epoch !== this.rendererEpoch || this.destroyed || this.stopped || this.mode !== mode || !this.view) return;
      const factory = rendererFactory(mode)!;
      if (this.total) { this.part('plot-empty').hidden = true; this.element.classList.remove('is-loading'); }
      // Canvas context attributes are immutable. A fresh surface prevents an old
      // opaque matrix context from hiding a geographic renderer's basemap layer.
      const previous = this.part<HTMLCanvasElement>('track');
      const canvas = previous.cloneNode(false) as HTMLCanvasElement;
      previous.replaceWith(canvas); this.elements.set('track', canvas);
      this.renderer = factory(canvas, { view: this.view, batches: this.chart.batches, order: this.chart.order }, {
        draw: at => { if (this.view && epoch === this.rendererEpoch) this.recordDraw(this.view.id, at); },
        settled: () => { if (epoch === this.rendererEpoch) this.updateCompletion(); },
      });
      this.rendererLoading = false;
      this.renderer.setVisible(this.visible);
      if (mode === 'surface') this.renderer.setAngle?.(Number(this.part<HTMLInputElement>('rotation').value));
      if (mode === 'tracks') this.setPlayback(1);
      const batch = this.batches.find(b => b.length); if (batch) this.renderer.append(batch);
      this.renderer.indexed(true);
      if (this.total) { this.part('plot-empty').hidden = true; this.element.classList.remove('is-loading'); }
      else if (this.completeReceived) { this.element.classList.remove('is-loading'); this.part('empty-title').textContent = 'No matching observations'; this.part('empty-detail').textContent = 'Try a wider time window or another vessel.'; }
      if (definition(mode).family === 'geo') this.part('track-empty').hidden = !this.completeReceived || this.batches.some(b => b.length && b.lat && b.lon);
      this.updateCompletion();
    };
    const failed = (error: unknown) => {
      if (epoch !== this.rendererEpoch || this.destroyed || this.stopped) return;
      this.rendererLoading = false; this.rendererError = true; this.element.classList.remove('is-loading');
      this.part('plot-empty').hidden = false;
      this.part('empty-title').textContent = 'View could not load'; this.part('empty-detail').textContent = String(error);
      this.setState('VIEW ERROR', 'error'); this.updateCompletion();
    };
    if (rendererFactory(mode)) { try { mount(); } catch (error) { failed(error); } }
    else void warmRenderer(mode).then(mount).catch(failed);
  }
  private setPlayback(fraction: number): void {
    this.renderer?.setTimeFraction?.(fraction); this.part<HTMLInputElement>('playback').value = String(Math.round(fraction * 1000));
    if (this.view) { const end = this.view.context.end, start = Math.max(this.view.context.start, end - this.view.plan.windowHours * 3_600_000); this.part('playback-time').textContent = new Date(start + (end - start) * fraction).toISOString().slice(5, 16).replace('T', ' ') + ' UTC'; }
  }
  private stopPlayback(): void { if (this.playbackFrame) cancelAnimationFrame(this.playbackFrame); this.playbackFrame = 0; this.actions.get('playback')!.textContent = 'Play voyage'; }
  private togglePlayback(): void {
    if (this.playbackFrame) { this.stopPlayback(); return; }
    if (!this.renderer || !this.completeReceived || !this.visible || this.stopped) return;
    const slider = this.part<HTMLInputElement>('playback'); const initial = Number(slider.value) >= 1000 ? 0 : Number(slider.value) / 1000;
    const started = performance.now() - initial * 12000;
    this.actions.get('playback')!.textContent = 'Pause';
    const frame = (at: number) => { const fraction = Math.min(1, (at - started) / 12000); if (this.renderer?.isSettled) this.setPlayback(fraction); if (fraction < 1) this.playbackFrame = requestAnimationFrame(frame); else { this.setPlayback(1); this.stopPlayback(); } };
    this.playbackFrame = requestAnimationFrame(frame);
  }
  private progress(p: BatchProgress): void {
    this.sum += p.sum; this.count += p.count; this.minimum = Math.min(this.minimum, p.minimum); this.maximum = Math.max(this.maximum, p.maximum);
    let changed = false; for (const id of p.series) if (!this.series.has(id)) { this.series.add(id); changed = true; }
    this.part('mean').textContent = this.count ? fmt.format(this.sum / this.count) : '—';
    this.part('range').textContent = this.count ? `${fmt.format(this.minimum)} — ${fmt.format(this.maximum)}` : '—';
    if (changed) { const legend = this.part('legend'); legend.replaceChildren(); for (const id of this.series) { const span = document.createElement('span'), dot = document.createElement('i'); dot.style.backgroundColor = SERIES_COLORS[Math.abs(id) % SERIES_COLORS.length]; span.append(dot, document.createTextNode(this.seriesName(id))); legend.append(span); } }
  }
  private updateCompletion(): void {
    if (this.destroyed || this.stopped || !this.completeReceived) return;
    const done = this.settled;
    this.actions.get('cancel')!.hidden = done;
    if (this.rendererError && isAdvanced(this.mode)) this.setState('VIEW ERROR', 'error');
    else this.setState(done ? this.total ? 'COMPLETE' : 'EMPTY RESULT' : 'DRAWING', done ? 'ready' : 'loading');
    this.callbacks.change(this);
  }
  private setState(text: string, state: string): void { const label = this.part('result-state'); label.dataset.state = state; label.lastChild!.textContent = text; }
  private recordDraw(id: string, at: number): void {
    if (!this.view || this.view.timing.firstDrawAt !== undefined || this.stopped) return;
    if (!this.copied) this.callbacks.draw(id, at); this.view.timing.firstDrawAt = at; this.updateTiming();
  }
  private updateTiming(): void {
    const view = this.view; if (!view) return;
    const t = view.timing;
    this.part('inference-label').textContent = view.inference?.cacheHit ? 'PLAN CACHE' : view.source === 'template' ? 'TEMPLATE' : 'INFERENCE';
    const database = view.database === 'duckdb-wasm' ? 'DUCKDB' : 'DB';
    this.part('database-first-label').textContent = `${database} → FIRST`;
    this.part('database-label').textContent = `${database} TOTAL`;
    // A duplicate shares results, not a new execution. Do not reuse its source's latency.
    if (this.copied) { this.part('latency-detail').textContent = 'Shared result · no new query'; return; }
    const duration = (start?: number, end?: number): string => {
      if (start === undefined || end === undefined || end < start) return '—';
      const elapsed = end - start;
      return elapsed < 1000 ? `${elapsed.toFixed(1)} ms` : `${(elapsed / 1000).toFixed(2)} s`;
    };
    this.part('inference-latency').textContent = duration(t.inferenceStartedAt, t.intentAt);
    this.part('database-first-latency').textContent = duration(t.queryStartedAt, t.firstBatchAt);
    this.part('database-latency').textContent = duration(t.queryStartedAt, t.completedAt);
    this.part('render-latency').textContent = duration(t.firstPublishedAt, t.firstDrawAt);
    this.part('latency').textContent = duration(t.committedAt, t.firstDrawAt);
    const prepared = t.committedAt !== undefined && t.inferenceStartedAt !== undefined && t.inferenceStartedAt < t.committedAt;
    this.part('latency-detail').textContent = `${t.promoted ? 'Prepared result promoted. ' : prepared ? 'Preparation began before this run. ' : ''}SQL compile: ${duration(t.intentAt, t.compiledAt)}. Stage times may overlap; database total includes time to first batch. Run → draw starts at dispatch; data → draw starts at delivery to this card. Drawing measures submission, not screen presentation.`;
    const detail = this.part('inference-detail'), d = view.inference;
    detail.hidden = view.source === 'template';
    if (d?.cacheHit) {
      detail.textContent = 'Exact model-plan cache hit · no model generation for this run. The database query still executes for this request.';
      this.part('source').textContent = 'CACHED MODEL PLAN';
    } else if (view.source !== 'template') {
      const stages: string[] = [];
      for (const [name, value] of [['Model warmup wait', d?.warmupMs], ['Worker queue', d?.queueMs],
        ['Generation wall time', d?.generationMs], ['First token', d?.firstTokenMs],
        ['Prompt processing', d?.prefillMs], ['Token generation', d?.decodeMs],
        ['Grammar setup', d?.grammarInitMs], ['Grammar / token', d?.grammarPerTokenMs]] as const) {
        if (value !== undefined) stages.push(`${name}: ${duration(0, value)}`);
      }
      if (d?.promptTokens !== undefined) stages.push(`Input: ${integer.format(d.promptTokens)} tokens`);
      if (d?.completionTokens !== undefined) stages.push(`Output: ${integer.format(d.completionTokens)} tokens`);
      if (d?.decodeTokensPerSecond !== undefined) stages.push(`Decode: ${fmt.format(d.decodeTokensPerSecond)} tokens/s`);
      if (d?.prefillTokensPerSecond !== undefined) stages.push(`Prefill: ${fmt.format(d.prefillTokensPerSecond)} tokens/s`);
      detail.textContent = stages.length ? `${stages.join(' · ')}. Engine stages and grammar costs overlap; do not sum these values.`
        : 'This inference service did not report a phase breakdown.';
    }
  }
  private seriesName(id: number): string { const v = this.view; if (!v) return String(id); const vessel = !v.plan.splitByVessel && v.plan.vessel !== null ? v.plan.vessel : id; return v.plan.splitByVessel || v.plan.vessel !== null ? v.context.vessels[vessel] || `Series ${vessel + 1}` : 'Fleet'; }
  private renderTable(): void {
    if (this.tableRows >= Math.min(12, this.total)) return;
    const body = this.part('table-body'); body.replaceChildren(); this.tableRows = 0;
    for (const b of this.batches) { for (let i = 0; i < b.length && this.tableRows < 12; i++, this.tableRows++) { const row = document.createElement('tr'); for (const value of [new Date(b.x[i]).toISOString().replace('T', ' ').slice(0, 16), this.seriesName(b.series[i]), fmt.format(b.y[i])]) { const td = document.createElement('td'); td.textContent = value; row.append(td); } body.append(row); } if (this.tableRows === 12) break; }
  }
  private export(): void {
    if (!this.view || !this.total) return;
    const chunks = ['timestamp_utc,series,value\n'];
    for (const b of this.batches) { let chunk = ''; for (let i = 0; i < b.length; i++) chunk += `${new Date(b.x[i]).toISOString()},"${this.seriesName(b.series[i]).replaceAll('"', '""')}",${b.y[i]}\n`; chunks.push(chunk); }
    const url = URL.createObjectURL(new Blob(chunks, { type: 'text/csv;charset=utf-8' })), a = document.createElement('a'); a.href = url; a.download = `time-blast-${this.view.plan.metric}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  copyFrom(source: ResultCard): void {
    if (!source.view) return;
    this.copied = true; this.mode = source.mode; this.explicitMode = true;
    this.begin({ ...source.view, id: this.id, timing: { ...source.view.timing } });
    for (const batch of source.batches) this.append(batch);
    this.finish(this.view!.timing);
  }
  destroy(): void { this.destroyed = true; this.rendererEpoch++; this.stopPlayback(); this.chart.destroy(); this.renderer?.destroy(); this.renderer = undefined; this.view = undefined; this.element.remove(); }
}
