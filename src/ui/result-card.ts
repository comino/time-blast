import { METRIC_LABELS, type ColumnBatch, type QueryTiming, type QueryView } from '../core/types';
import { SERIES_COLORS, StreamChart, TrackChart, type BatchProgress } from './chart';
import { icon } from './shell';

export type CardMode = 'line' | 'bar' | 'scatter' | 'map' | 'table';
const fmt = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('en');
const dates = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const chartModes = new Set<CardMode>(['line', 'bar', 'scatter']);
const glyph = icon('<path d="M4 17 9 10l4 3 7-9M4 4v16h16"/>');
const markup = `
  <header class="card-header card-drag-handle"><span class="card-glyph">${glyph}</span><div class="card-heading"><h2 class="card-title" data-card-el="plot-title"></h2><p class="card-subtitle" data-card-el="plot-subtitle">Preparing your question…</p></div><div class="card-header-actions"><button class="icon-button" data-card-action="duplicate" aria-label="Duplicate view" title="Duplicate view without a new query" disabled>${icon('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>')}</button><button class="icon-button" data-card-action="close" aria-label="Remove view" title="Remove view">${icon('<path d="m6 6 12 12M18 6 6 18"/>')}</button></div></header>
  <div class="card-toolbar"><select data-card-el="representation" aria-label="Visualization type"><option value="line">Time series</option><option value="bar">Bar chart</option><option value="scatter">Scatter plot</option><option value="map">Vessel tracks</option><option value="table">Data table</option></select><div class="plot-tabs" role="tablist" aria-label="Result view"><button data-card-tab="chart" role="tab" aria-selected="true" class="active">Chart</button><button data-card-tab="table" role="tab" aria-selected="false">Data</button></div><span class="live-indicator" data-card-el="result-state" data-state="loading"><span></span>THINKING</span></div>
  <div class="card-body">
    <div class="plot-container" data-card-el="plot-container"><canvas data-card-el="chart" aria-label="Query result chart" role="img"></canvas></div>
    <div class="track-surface" data-card-el="track-wrap" hidden><canvas data-card-el="track" aria-label="Vessel tracks from query data" role="img"></canvas><span class="track-north">N ↑</span><span class="track-caption">Mean coordinates · schematic tracks</span><div class="track-empty" data-card-el="track-empty" hidden>No coordinates in this result.</div></div>
    <div class="data-table-wrap" data-card-el="table-wrap" hidden><table class="data-table"><thead><tr><th>TIME · UTC</th><th>SERIES</th><th data-card-el="value-header">VALUE</th></tr></thead><tbody data-card-el="table-body"></tbody></table><p>First 12 points. Export the complete result below.</p></div>
    <div class="plot-empty card-loading" data-card-el="plot-empty"><div class="loading-orb"><i></i><i></i><i></i><b></b></div><span data-card-el="empty-title">Following your question</span><small data-card-el="empty-detail">Preparing a validated query.</small></div>
  </div>
  <div class="plot-bottom"><div class="legend" data-card-el="legend"></div><span class="mono" data-card-el="time-range">UTC</span></div>
  <div class="card-stats"><div><span>MEAN <small data-card-el="mean-unit"></small></span><strong data-card-el="mean">—</strong></div><div><span>POINTS</span><strong data-card-el="points">—</strong></div><div><span>RANGE</span><strong data-card-el="range">—</strong></div><div><span>ENTER → DRAW</span><strong data-card-el="latency">—</strong></div></div>
  <footer class="card-footer result-footer"><button class="detail-button" data-card-action="sql" aria-expanded="false">${icon('<path d="m8 7-5 5 5 5m8-10 5 5-5 5"/>')}<span>Query details</span><span class="source-pill" data-card-el="source">—</span></button><span class="card-batch-count" data-card-el="batch-count">Waiting for data</span><div class="result-actions"><button class="text-button cancel-button" data-card-action="cancel">Stop query</button><button class="icon-button" data-card-action="export" aria-label="Export result as CSV" title="Export result as CSV" disabled>${icon('<path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4"/>')}</button></div></footer>
  <div class="sql-panel" data-card-el="sql-panel" hidden><pre data-card-el="sql">A validated query will appear here.</pre><p data-card-el="query-meta"></p><p data-card-el="latency-detail">First point draw submitted</p></div>
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
  private track?: TrackChart;
  private visible = true;
  private explicitMode = false;
  private copied = false;
  private batchCount = 0;
  private tableRows = 0;
  private destroyed = false;
  private sum = 0; private count = 0;
  private minimum = Infinity; private maximum = -Infinity;
  private minLat = Infinity; private maxLat = -Infinity; private minLon = Infinity; private maxLon = -Infinity;
  private readonly series = new Set<number>();
  private readonly elements = new Map<string, HTMLElement>();
  private readonly actions = new Map<string, HTMLButtonElement>();

  constructor(readonly id: string, readonly prompt: string, parent: HTMLElement, private callbacks: CardCallbacks) {
    this.element.className = 'result-card card is-loading'; this.element.dataset.cardId = id;
    this.element.tabIndex = 0; this.element.setAttribute('aria-label', prompt); this.element.append(template.content.cloneNode(true));
    parent.append(this.element); this.layout();
    this.element.querySelectorAll<HTMLElement>('[data-card-el]').forEach(e => this.elements.set(e.dataset.cardEl!, e));
    this.element.querySelectorAll<HTMLButtonElement>('[data-card-action]').forEach(e => this.actions.set(e.dataset.cardAction!, e));
    this.part('plot-title').textContent = prompt;
    this.chart = new StreamChart(this.part<HTMLCanvasElement>('chart'), (id, at) => this.recordDraw(id, at),
      p => this.progress(p), reordered => this.track?.indexed(reordered), () => this.updateCompletion());
    this.element.addEventListener('pointerdown', () => callbacks.select(this));
    this.element.addEventListener('focusin', () => callbacks.select(this));
    this.part<HTMLSelectElement>('representation').addEventListener('change', () => this.setMode(this.part<HTMLSelectElement>('representation').value as CardMode));
    this.element.querySelectorAll<HTMLButtonElement>('[data-card-tab]').forEach(button => button.addEventListener('click', () => this.setMode(button.dataset.cardTab === 'table' ? 'table' : 'line')));
    this.actions.get('close')!.onclick = () => callbacks.close(this);
    this.actions.get('duplicate')!.onclick = () => callbacks.duplicate(this);
    this.actions.get('cancel')!.onclick = () => callbacks.cancel(this);
    this.actions.get('sql')!.onclick = () => { const panel = this.part('sql-panel'); panel.hidden = !panel.hidden; this.actions.get('sql')!.setAttribute('aria-expanded', String(!panel.hidden)); };
    this.actions.get('export')!.onclick = () => this.export();
  }

  private part<T extends HTMLElement = HTMLElement>(name: string): T { return this.elements.get(name)! as T; }
  get busy(): boolean { return !this.stopped && (!this.completeReceived || !this.settled); }
  private get settled(): boolean { return !this.total || this.chart.isSettled && (this.mode !== 'map' || !this.visible || !!this.track?.isSettled); }
  get batches(): readonly ColumnBatch[] { return this.chart.batches; }
  layout(): void { Object.assign(this.element.style, { left: `${this.x}px`, top: `${this.y}px`, width: `${this.width}px`, height: `${this.height}px` }); }
  select(selected: boolean): void {
    this.element.dataset.selected = String(selected);
    for (const [name, e] of this.elements) selected ? e.setAttribute('data-el', name) : e.removeAttribute('data-el');
    for (const [name, e] of this.actions) selected ? e.setAttribute('data-action', name) : e.removeAttribute('data-action');
    this.element.querySelectorAll<HTMLElement>('[data-card-tab]').forEach(e => selected ? e.setAttribute('data-tab', e.dataset.cardTab!) : e.removeAttribute('data-tab'));
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
    if (!this.explicitMode) this.mode = view.plan.view;
    this.setMode(this.mode, false);
    this.setState('QUERYING', 'loading'); this.part('empty-title').textContent = 'Listening for the first point'; this.part('empty-detail').textContent = 'Drawing begins as soon as data arrives.';
  }
  append(batch: ColumnBatch): void {
    if (this.stopped || this.destroyed || this.completeReceived || !this.view) return;
    this.total += batch.length; this.batchCount++;
    if (batch.length) { this.part('plot-empty').hidden = true; this.element.classList.remove('is-loading'); this.actions.get('export')!.disabled = false; }
    this.chart.append(batch);
    if (this.mode === 'map') this.track?.append(batch);
    if (this.mode === 'table') { this.renderTable(); if (this.visible && batch.length) this.recordDraw(this.view.id, performance.now()); }
    this.part('points').textContent = integer.format(this.total); this.part('batch-count').textContent = `${this.batchCount} ${this.batchCount === 1 ? 'batch' : 'batches'}`;
    this.setState('STREAMING', 'ready'); this.callbacks.change(this);
  }
  finish(timing: QueryTiming): void {
    if (this.stopped || this.completeReceived || !this.view) return;
    this.view.timing = timing; this.completeReceived = true; this.updateTiming();
    this.actions.get('duplicate')!.disabled = false;
    if (this.mode === 'map') this.part('track-empty').hidden = this.batches.some(b => b.length && b.lat && b.lon);
    if (!this.total) { this.element.classList.remove('is-loading'); this.part('empty-title').textContent = 'No matching observations'; this.part('empty-detail').textContent = 'Try a wider time window or another vessel.'; this.part('points').textContent = '0'; }
    this.updateCompletion();
  }
  cancel(label = 'CANCELED'): void {
    if (this.stopped || this.destroyed) return;
    this.stopped = true; this.chart.stop(); this.track?.stop(); this.element.classList.remove('is-loading');
    this.setState(label, 'quiet'); this.actions.get('cancel')!.hidden = true;
    if (!this.total) { this.part('empty-title').textContent = 'Question stopped'; this.part('empty-detail').textContent = 'Ask another question to add a fresh view.'; }
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
    this.chart.setVisible(visible && chartModes.has(this.mode)); this.track?.setVisible(visible && this.mode === 'map');
    if (visible && this.mode === 'table' && this.total && this.view) this.recordDraw(this.view.id, performance.now());
    this.updateCompletion();
  }
  setMode(mode: CardMode, explicit = true): void {
    if (!['line', 'bar', 'scatter', 'map', 'table'].includes(mode)) return;
    this.mode = mode; this.explicitMode ||= explicit;
    this.part<HTMLSelectElement>('representation').value = mode;
    this.part('plot-container').hidden = !chartModes.has(mode); this.part('track-wrap').hidden = mode !== 'map'; this.part('table-wrap').hidden = mode !== 'table';
    this.element.querySelectorAll<HTMLButtonElement>('[data-card-tab]').forEach(e => { const active = (mode === 'table') === (e.dataset.cardTab === 'table'); e.classList.toggle('active', active); e.setAttribute('aria-selected', String(active)); });
    this.chart.setVisible(this.visible && chartModes.has(mode));
    if (chartModes.has(mode)) this.chart.setRepresentation(mode as 'line' | 'bar' | 'scatter');
    if (mode === 'map') this.ensureTrack();
    this.track?.setVisible(this.visible && mode === 'map');
    if (mode === 'table') { this.renderTable(); if (this.visible && this.total && this.view) this.recordDraw(this.view.id, performance.now()); }
    this.updateCompletion();
  }
  private ensureTrack(): void {
    if (this.track || !this.view) return;
    this.track = new TrackChart(this.part<HTMLCanvasElement>('track'), () => this.updateCompletion(), at => {
      if (this.view) this.recordDraw(this.view.id, at);
    });
    this.track.setVisible(this.visible && this.mode === 'map');
    this.track.begin(this.chart.batches, this.chart.order);
    this.track.progress({ sum: 0, count: 0, minimum: Infinity, maximum: -Infinity, series: this.series,
      minLat: this.minLat, maxLat: this.maxLat, minLon: this.minLon, maxLon: this.maxLon });
    const batch = this.batches.find(b => b.length && b.lat && b.lon);
    if (batch) this.track.append(batch);
    this.track.indexed(true); this.part('track-empty').hidden = !this.completeReceived || !!batch;
  }
  private progress(p: BatchProgress): void {
    this.sum += p.sum; this.count += p.count; this.minimum = Math.min(this.minimum, p.minimum); this.maximum = Math.max(this.maximum, p.maximum);
    this.minLat = Math.min(this.minLat, p.minLat); this.maxLat = Math.max(this.maxLat, p.maxLat); this.minLon = Math.min(this.minLon, p.minLon); this.maxLon = Math.max(this.maxLon, p.maxLon);
    let changed = false; for (const id of p.series) if (!this.series.has(id)) { this.series.add(id); changed = true; }
    this.track?.progress(p);
    this.part('mean').textContent = this.count ? fmt.format(this.sum / this.count) : '—';
    this.part('range').textContent = this.count ? `${fmt.format(this.minimum)} — ${fmt.format(this.maximum)}` : '—';
    if (changed) { const legend = this.part('legend'); legend.replaceChildren(); for (const id of this.series) { const span = document.createElement('span'), dot = document.createElement('i'); dot.style.backgroundColor = SERIES_COLORS[Math.abs(id) % SERIES_COLORS.length]; span.append(dot, document.createTextNode(this.seriesName(id))); legend.append(span); } }
  }
  private updateCompletion(): void {
    if (this.destroyed || this.stopped || !this.completeReceived) return;
    const done = this.settled;
    this.actions.get('cancel')!.hidden = done; this.setState(done ? this.total ? 'COMPLETE' : 'EMPTY RESULT' : 'DRAWING', done ? 'ready' : 'loading');
    this.callbacks.change(this);
  }
  private setState(text: string, state: string): void { const label = this.part('result-state'); label.dataset.state = state; label.lastChild!.textContent = text; }
  private recordDraw(id: string, at: number): void {
    if (!this.view || this.view.timing.firstDrawAt !== undefined || this.stopped) return;
    if (!this.copied) this.callbacks.draw(id, at); this.view.timing.firstDrawAt = at; this.updateTiming();
  }
  private updateTiming(): void {
    const t = this.view?.timing;
    if (this.copied) { this.part('latency-detail').textContent = 'Shared result · no new query'; return; }
    if (t?.committedAt !== undefined && t.firstDrawAt !== undefined) { const elapsed = Math.max(0, t.firstDrawAt - t.committedAt); this.part('latency').textContent = elapsed < 1000 ? `${elapsed.toFixed(1)} ms` : `${(elapsed / 1000).toFixed(2)} s`; this.part('latency-detail').textContent = t.promoted ? 'Prepared result promoted' : 'First point draw submitted'; }
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
  destroy(): void { this.destroyed = true; this.chart.destroy(); this.track?.destroy(); this.chart.batches.length = 0; this.chart.order.clear(); this.view = undefined; this.element.remove(); }
}
