import { METRIC_LABELS, type ColumnBatch, type QueryView } from '../core/types';
import { ColumnOrder } from './order';
import { barLayout } from './bar-layout';
import { FrameWork } from './frame-work';

export const SERIES_COLORS = ['#ff906c', '#74d4c3', '#d4c17e', '#83b9e3', '#e39eaf', '#b0c985'];
export type ChartRepresentation = 'line' | 'bar' | 'scatter';
const BACKGROUND = '#0d1b24';
const CHUNK = 2048;
const number = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const time = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
const day = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
// Camera transforms change the screen-space rectangle, not the bitmap's logical dimensions.
const canvasSize = (canvas: HTMLCanvasElement) => ({
  width: canvas.clientWidth ?? canvas.getBoundingClientRect().width,
  height: canvas.clientHeight ?? canvas.getBoundingClientRect().height,
});

export interface BatchProgress {
  sum: number; count: number; minimum: number; maximum: number; series: Set<number>;
  minLat: number; maxLat: number; minLon: number; maxLon: number;
}
interface Cursor { count: number; x: number; y: number; hasPoint: boolean }
const cursor = (): Cursor => ({ count: 0, x: 0, y: 0, hasPoint: false });

/** End markers live separately so appending a segment never leaves an old endpoint dot. */
class Markers {
  private canvas = document.createElement('canvas');
  readonly ctx = this.canvas.getContext('2d')!;
  constructor(canvas: HTMLCanvasElement) {
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
    canvas.parentElement!.append(this.canvas);
  }
  resize(width: number, height: number, dpr: number): void {
    this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  clear(): void { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }
  dot(x: number, y: number, series: number, radius = 3.5): void {
    this.ctx.beginPath(); this.ctx.fillStyle = SERIES_COLORS[Math.abs(series) % SERIES_COLORS.length];
    this.ctx.arc(x, y, radius, 0, Math.PI * 2); this.ctx.fill();
  }
  destroy(): void { this.canvas.width = 0; this.canvas.height = 0; this.canvas.remove(); }
}

/** Retains producer buffers; indexing and drawing run in cancelable, bounded slices. */
export class StreamChart {
  readonly batches: ColumnBatch[] = [];
  readonly order = new ColumnOrder(this.batches);
  private readonly ctx: CanvasRenderingContext2D;
  private readonly markers: Markers;
  private readonly observer: ResizeObserver;
  private readonly work = new FrameWork(deadline => this.advance(deadline));
  private readonly cursors = new Map<number, Cursor>();
  private view?: QueryView;
  private display: ChartRepresentation = 'line';
  private width = 0; private height = 0; private dpr = 0;
  private drawn = false; private stopped = false; private visible = true;
  private firstBatch?: ColumnBatch;
  private firstRow = 0;
  private nextBatch = 0; private nextRow = 0;
  private sorting?: Generator<void>;
  private repaint = true;
  private gridReady = false;
  private settled = false;
  private low = 0; private high = 40; private xLow = 0; private xHigh = 1; private xPadding = 0;
  private readonly pad = { left: 53, right: 22, top: 26, bottom: 38 };

  constructor(private canvas: HTMLCanvasElement, private onDraw: (id: string, at: number) => void,
    private onProgress: (progress: BatchProgress) => void = () => {},
    private onIndexed: (reordered: boolean) => void = () => {},
    private onSettledChange: (id: string, settled: boolean) => void = () => {}) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
    this.ctx = ctx; this.markers = new Markers(canvas);
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(canvas); this.resize();
  }

  begin(view: QueryView): void {
    this.work.cancel(); this.sorting = undefined;
    this.view = view; this.display = view.plan.view; this.batches.length = 0; this.order.clear(); this.cursors.clear();
    this.nextBatch = 0; this.nextRow = 0; this.drawn = false; this.stopped = false; this.repaint = true;
    this.firstBatch = undefined; this.settled = false;
    this.xPadding = this.display === 'bar' ? view.plan.bucketMinutes * 30_000 : 0;
    this.xLow = Math.max(view.context.start, view.context.end - view.plan.windowHours * 3_600_000) - this.xPadding;
    this.xHigh = view.context.end + this.xPadding;
    [this.low, this.high] = { speed: [0, 40], wind: [0, 60], wave_height: [0, 8], water_temp: [-2, 35] }[view.plan.metric];
    this.gridReady = false; this.markers.clear(); if (this.visible) this.grid();
  }

  append(batch: ColumnBatch): void {
    if (this.stopped) return;
    this.batches.push(batch);
    // Validated producer batches begin with a complete point. Invalid test inputs are scanned later.
    this.firstMarker(batch, 0);
    this.setSettled(false);
    this.work.schedule();
  }

  get representation(): ChartRepresentation { return this.display; }

  /** Change only the presentation; retain producer columns, the query plan, and indexed references. */
  setRepresentation(representation: ChartRepresentation): void {
    if (representation === this.display) return;
    this.display = representation;
    if (!this.view) return;
    const padding = representation === 'bar' ? this.view.plan.bucketMinutes * 30_000 : 0;
    this.xLow += this.xPadding - padding; this.xHigh += padding - this.xPadding; this.xPadding = padding;
    this.repaint = true;
    if (this.visible) {
      this.setSettled(false);
      if (this.stopped && this.order.needsSort) this.sorting = this.order.sortSteps();
      this.work.schedule();
    }
  }

  private firstMarker(batch: ColumnBatch, i: number): void {
    if (this.stopped || !this.visible || this.drawn || !this.view || !this.width || !this.height ||
      i >= batch.length || !Number.isFinite(batch.x[i]) || !Number.isFinite(batch.y[i])) return;
    const low = this.low, high = this.high, xLow = this.xLow, xHigh = this.xHigh;
    this.low = Math.min(this.low, batch.y[i]); this.high = Math.max(this.high, batch.y[i]);
    this.xLow = Math.min(this.xLow, batch.x[i] - this.xPadding); this.xHigh = Math.max(this.xHigh, batch.x[i] + this.xPadding);
    if (!this.gridReady || low !== this.low || high !== this.high || xLow !== this.xLow || xHigh !== this.xHigh) this.grid();
    const offset = this.display === 'bar' ? this.bar(batch.series[i]).offset : 0;
    this.markers.dot(this.x(batch.x[i]) + offset, this.y(batch.y[i]), batch.series[i]);
    this.firstBatch = batch; this.firstRow = i;
    this.drawn = true; this.onDraw(this.view.id, performance.now());
  }

  private resize(): void {
    const box = canvasSize(this.canvas), dpr = window.devicePixelRatio || 1;
    if (box.width < 1 || box.height < 1 || box.width === this.width && box.height === this.height && dpr === this.dpr) return;
    this.width = box.width; this.height = box.height; this.dpr = dpr;
    this.canvas.width = Math.round(box.width * dpr); this.canvas.height = Math.round(box.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.markers.resize(this.width, this.height, dpr);
    this.repaint = true;
    if (this.visible) this.setSettled(false);
    if (this.stopped && this.order.needsSort) this.sorting = this.order.sortSteps();
    if (this.visible) { this.grid(); this.work.schedule(); }
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    if (visible && !this.visible) this.gridReady = false;
    this.visible = visible;
    if (visible) {
      this.repaint = true;
      this.setSettled(false);
      if (this.stopped && this.order.needsSort) this.sorting = this.order.sortSteps();
      if (this.batches.length) this.firstMarker(this.batches[0], 0);
      this.work.schedule();
    } else if (this.nextBatch === this.batches.length && !this.sorting) this.setSettled(true);
  }

  get isSettled(): boolean { return this.settled && !this.stopped; }
  private setSettled(value: boolean): void {
    if (!this.view || this.stopped || value === this.settled) return;
    this.settled = value; this.onSettledChange(this.view.id, value);
  }

  private advance(deadline: number): boolean {
    if (!this.view) return false;
    if (this.sorting) {
      do { if (this.sorting.next().done) { this.sorting = undefined; this.repaint = true; this.onIndexed(true); break; } }
      while (performance.now() < deadline);
    } else if (!this.stopped && this.nextBatch < this.batches.length) {
      const batch = this.batches[this.nextBatch], from = this.nextRow, to = Math.min(batch.length, from + CHUNK);
      this.order.appendRange(batch, this.nextBatch, from, to);
      const progress: BatchProgress = { sum: 0, count: 0, minimum: Infinity, maximum: -Infinity, series: new Set(),
        minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity };
      const oldLow = this.low, oldHigh = this.high, oldXLow = this.xLow, oldXHigh = this.xHigh;
      for (let i = from; i < to; i++) {
        const x = batch.x[i], y = batch.y[i];
        progress.series.add(batch.series[i]);
        if (Number.isFinite(y)) { progress.sum += y; progress.count++; progress.minimum = Math.min(progress.minimum, y); progress.maximum = Math.max(progress.maximum, y); }
        if (Number.isFinite(x) && Number.isFinite(y)) {
          this.firstMarker(batch, i);
          this.low = Math.min(this.low, y); this.high = Math.max(this.high, Number.isFinite(y * 1.05) && y >= 0 ? y * 1.05 : y);
          this.xLow = Math.min(this.xLow, x - this.xPadding); this.xHigh = Math.max(this.xHigh, x + this.xPadding);
        }
        if (batch.lat && batch.lon && Number.isFinite(batch.lat[i]) && Number.isFinite(batch.lon[i])) {
          progress.minLat = Math.min(progress.minLat, batch.lat[i]); progress.maxLat = Math.max(progress.maxLat, batch.lat[i]);
          progress.minLon = Math.min(progress.minLon, batch.lon[i]); progress.maxLon = Math.max(progress.maxLon, batch.lon[i]);
        }
      }
      this.repaint ||= oldLow !== this.low || oldHigh !== this.high || oldXLow !== this.xLow || oldXHigh !== this.xHigh;
      this.nextRow = to;
      if (to === batch.length) { this.nextBatch++; this.nextRow = 0; }
      this.onProgress(progress);
      if (this.order.needsSort) this.sorting = this.order.sortSteps(); else this.onIndexed(false);
    }
    if (this.visible && !this.sorting && performance.now() < deadline) this.render(deadline);
    const pending = !this.stopped && this.nextBatch < this.batches.length || !!this.sorting || this.visible && this.needsPaint();
    this.setSettled(!pending);
    return pending;
  }

  private needsPaint(): boolean {
    if (!this.width || !this.height) return false;
    if (this.repaint) return true;
    for (const [id, series] of this.order.series) if ((this.cursors.get(id)?.count ?? 0) < series.refs.length) return true;
    return false;
  }
  private x(value: number): number { return this.pad.left + (value - this.xLow) / Math.max(1, this.xHigh - this.xLow) * (this.width - this.pad.left - this.pad.right); }
  private y(value: number): number { return this.height - this.pad.bottom - (value - this.low) / Math.max(0.001, this.high - this.low) * (this.height - this.pad.top - this.pad.bottom); }
  private bar(series: number) {
    const { plan, context } = this.view!;
    const grouped = plan.splitByVessel && plan.vessel === null;
    return barLayout(plan.bucketMinutes * 60_000 / Math.max(1, this.xHigh - this.xLow) * (this.width - this.pad.left - this.pad.right), grouped ? series : 0, grouped ? context.vessels.length : 1);
  }
  private grid(): void {
    this.gridReady = true;
    const c = this.ctx;
    c.fillStyle = BACKGROUND;
    c.fillRect(0, 0, this.width, this.height);
    c.font = '10px "IBM Plex Mono", ui-monospace, monospace';
    c.lineWidth = 1;
    for (let tick = 0; tick < 5; tick++) {
      const y = this.pad.top + (this.height - this.pad.top - this.pad.bottom) * tick / 4;
      c.strokeStyle = '#2a3030';
      c.beginPath(); c.moveTo(this.pad.left, y + 0.5); c.lineTo(this.width - this.pad.right, y + 0.5); c.stroke();
      if (this.view) {
        c.fillStyle = '#85928e'; c.textAlign = 'right';
        c.fillText(number.format(this.high - (this.high - this.low) * tick / 4), this.pad.left - 11, y + 3);
      }
    }
    if (this.view) {
      c.fillStyle = '#85928e';
      for (let tick = 0; tick < 5; tick++) {
        const value = this.xLow + (this.xHigh - this.xLow) * tick / 4;
        c.textAlign = tick === 0 ? 'left' : tick === 4 ? 'right' : 'center';
        c.fillText((this.xHigh - this.xLow > 172_800_000 ? day : time).format(value), this.x(value), this.height - 13);
      }
      c.textAlign = 'left'; c.fillText(METRIC_LABELS[this.view.plan.metric].unit, this.pad.left, 13);
    }
  }

  private render(deadline: number): void {
    if (!this.visible || !this.view || !this.width || !this.height) return;
    if (this.repaint) { this.grid(); this.cursors.clear(); this.repaint = false; }
    const c = this.ctx;
    c.save(); c.beginPath(); c.rect(this.pad.left - 4, this.pad.top - 4, this.width - this.pad.left - this.pad.right + 8, this.height - this.pad.top - this.pad.bottom + 8); c.clip();
    let work = 0;
    for (const [series, ordered] of this.order.series) {
      const state = this.cursors.get(series) ?? cursor(); this.cursors.set(series, state);
      const color = SERIES_COLORS[Math.abs(series) % SERIES_COLORS.length], bar = this.display === 'bar' ? this.bar(series) : undefined;
      c.beginPath(); if (state.hasPoint && this.display === 'line') c.moveTo(state.x, state.y);
      while (state.count < ordered.refs.length && work < CHUNK) {
        const ref = ordered.refs[state.count++], index = this.order.batchIndex(ref), batch = this.batches[index], i = this.order.rowIndex(ref, index);
        work++;
        if (!Number.isFinite(batch.x[i]) || !Number.isFinite(batch.y[i])) continue;
        const x = this.x(batch.x[i]) + (bar?.offset ?? 0), y = this.y(batch.y[i]);
        if (bar) {
          c.fillStyle = color; c.globalAlpha = 0.78;
          const baseline = this.y(Math.max(this.low, Math.min(this.high, 0)));
          c.fillRect(x - bar.width / 2, Math.min(y, baseline), bar.width, Math.max(1, Math.abs(baseline - y))); c.globalAlpha = 1;
        } else if (this.display === 'scatter') {
          c.moveTo(x + 2, y); c.arc(x, y, 2, 0, Math.PI * 2);
        } else if (state.hasPoint) c.lineTo(x, y); else c.moveTo(x, y);
        state.x = x; state.y = y; state.hasPoint = true;
        if (work % 128 === 0 && performance.now() >= deadline) break;
      }
      if (this.display === 'scatter') { c.fillStyle = color; c.globalAlpha = 0.72; c.fill(); c.globalAlpha = 1; }
      else if (!bar) { c.strokeStyle = color; c.lineWidth = 1.7; c.stroke(); }
      if (work >= CHUNK || performance.now() >= deadline) break;
    }
    c.restore(); this.markers.clear();
    let hasMarker = false;
    for (const [series, state] of this.cursors) if (state.hasPoint) { this.markers.dot(state.x, state.y, series); hasMarker = true; }
    // Cancellation can freeze the result before indexing; preserve its submitted point on resize/show.
    if (!hasMarker && this.firstBatch) {
      const b = this.firstBatch, i = this.firstRow, offset = this.display === 'bar' ? this.bar(b.series[i]).offset : 0;
      this.markers.dot(this.x(b.x[i]) + offset, this.y(b.y[i]), b.series[i]);
    }
  }

  stop(): void { this.stopped = true; this.work.cancel(); this.sorting = undefined; }
  destroy(): void {
    this.observer.disconnect(); this.stop(); this.markers.destroy();
    this.firstBatch = undefined; this.view = undefined; this.batches.length = 0;
    this.order.clear(); this.cursors.clear(); this.sorting = undefined;
    this.canvas.width = 0; this.canvas.height = 0;
  }
}

export class TrackChart {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly markers: Markers;
  private readonly observer: ResizeObserver;
  private readonly work = new FrameWork(deadline => this.render(deadline));
  private readonly cursors = new Map<number, Cursor>();
  private batches: readonly ColumnBatch[] = [];
  private order?: ColumnOrder;
  private width = 0; private height = 0; private dpr = 0;
  private minLat = Infinity; private maxLat = -Infinity; private minLon = Infinity; private maxLon = -Infinity;
  private repaint = true;
  private visible = true; private stopped = false; private settled = false; private drawn = false;
  private firstBatch?: ColumnBatch;
  constructor(private canvas: HTMLCanvasElement, private onSettledChange: (settled: boolean) => void = () => {},
    private onDraw: (at: number) => void = () => {}) {
    this.ctx = canvas.getContext('2d', { alpha: false })!; this.markers = new Markers(canvas);
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(canvas); this.resize();
  }
  begin(batches: readonly ColumnBatch[], order: ColumnOrder): void {
    this.work.cancel(); this.batches = batches; this.order = order; this.cursors.clear();
    this.minLat = this.minLon = Infinity; this.maxLat = this.maxLon = -Infinity;
    this.stopped = false; this.drawn = false; this.firstBatch = undefined;
    this.repaint = true; this.settled = true; this.markers.clear(); if (this.visible) this.grid();
  }
  /** Submit the leading coordinate before shared indexing; no second batch list or point scan. */
  append(batch: ColumnBatch): boolean {
    if (this.stopped) return false;
    if (this.visible) this.setSettled(false);
    if (this.firstBatch || !batch.length || !batch.lat || !batch.lon ||
      !Number.isFinite(batch.lat[0]) || !Number.isFinite(batch.lon[0])) return false;
    this.firstBatch = batch;
    this.minLat = Math.min(this.minLat, batch.lat[0]); this.maxLat = Math.max(this.maxLat, batch.lat[0]);
    this.minLon = Math.min(this.minLon, batch.lon[0]); this.maxLon = Math.max(this.maxLon, batch.lon[0]);
    this.repaint = true;
    return this.firstMarker();
  }
  private firstMarker(): boolean {
    const batch = this.firstBatch;
    if (this.drawn || !this.visible || !this.width || !this.height || !batch) return false;
    this.markers.dot(this.x(batch.lon![0]), this.y(batch.lat![0]), batch.series[0], 3);
    this.recordDraw(); return true;
  }
  private recordDraw(): void {
    if (this.drawn) return;
    this.drawn = true;
    if (!this.stopped) this.onDraw(performance.now());
  }
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (!visible) { this.work.cancel(); this.setSettled(true); return; }
    this.repaint = true; this.setSettled(false); this.firstMarker(); this.work.schedule();
  }
  get isSettled(): boolean { return this.settled && !this.stopped; }
  private setSettled(value: boolean): void {
    if (this.stopped || value === this.settled) return;
    this.settled = value; this.onSettledChange(value);
  }
  progress(p: BatchProgress): void {
    const a = this.minLat, b = this.maxLat, c = this.minLon, d = this.maxLon;
    this.minLat = Math.min(a, p.minLat); this.maxLat = Math.max(b, p.maxLat);
    this.minLon = Math.min(c, p.minLon); this.maxLon = Math.max(d, p.maxLon);
    this.repaint ||= a !== this.minLat || b !== this.maxLat || c !== this.minLon || d !== this.maxLon;
  }
  indexed(reordered: boolean): void {
    this.repaint ||= reordered;
    if (this.visible) { this.setSettled(false); this.work.schedule(); }
  }
  private resize(): void {
    const { width, height } = canvasSize(this.canvas), dpr = window.devicePixelRatio || 1;
    if (!width || !height || width === this.width && height === this.height && dpr === this.dpr) return;
    this.width = width; this.height = height; this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.markers.resize(width, height, dpr);
    this.repaint = true;
    if (this.visible) { this.setSettled(false); this.work.schedule(); }
  }
  private x(lon: number): number { return 25 + (lon - this.minLon) / Math.max(0.001, this.maxLon - this.minLon) * (this.width - 50); }
  private y(lat: number): number { return this.height - 22 - (lat - this.minLat) / Math.max(0.001, this.maxLat - this.minLat) * (this.height - 44); }
  private grid(): void {
    const c = this.ctx, { width, height } = this;
    c.fillStyle = BACKGROUND; c.fillRect(0, 0, width, height); c.strokeStyle = '#28332f'; c.lineWidth = 1;
    for (let x = 28; x < width; x += 45) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, height); c.stroke(); }
    for (let y = 22; y < height; y += 36) { c.beginPath(); c.moveTo(0, y); c.lineTo(width, y); c.stroke(); }
  }
  private render(deadline: number): boolean {
    if (!this.visible || !this.width || !this.height || !this.order || !Number.isFinite(this.minLat)) {
      this.setSettled(true); return false;
    }
    // The indexer notifies us when sorted references are ready. Polling here can
    // run forever if cancellation abandoned the sort while the primary is hidden.
    if (this.order.needsSort) return false;
    if (this.repaint) { this.grid(); this.cursors.clear(); this.repaint = false; }
    const c = this.ctx; let work = 0;
    for (const [series, ordered] of this.order.series) {
      const state = this.cursors.get(series) ?? cursor(); this.cursors.set(series, state);
      c.beginPath(); if (state.hasPoint) c.moveTo(state.x, state.y);
      while (state.count < ordered.refs.length && work < CHUNK) {
        const ref = ordered.refs[state.count++], index = this.order.batchIndex(ref), b = this.batches[index], i = this.order.rowIndex(ref, index);
        work++;
        if (!b.lat || !b.lon || !Number.isFinite(b.lat[i]) || !Number.isFinite(b.lon[i])) continue;
        const x = this.x(b.lon[i]), y = this.y(b.lat[i]);
        if (state.hasPoint) c.lineTo(x, y); else c.moveTo(x, y);
        state.x = x; state.y = y; state.hasPoint = true;
        if (work % 128 === 0 && performance.now() >= deadline) break;
      }
      c.strokeStyle = SERIES_COLORS[Math.abs(series) % SERIES_COLORS.length]; c.lineWidth = 1.1; c.stroke();
      if (work >= CHUNK || performance.now() >= deadline) break;
    }
    this.markers.clear();
    let hasMarker = false;
    for (const [series, state] of this.cursors) if (state.hasPoint) {
      this.markers.dot(state.x, state.y, series, 3); this.recordDraw(); hasMarker = true;
    }
    if (!hasMarker && this.firstBatch) {
      this.markers.dot(this.x(this.firstBatch.lon![0]), this.y(this.firstBatch.lat![0]), this.firstBatch.series[0], 3); this.recordDraw();
    }
    for (const [id, series] of this.order.series) if ((this.cursors.get(id)?.count ?? 0) < series.refs.length) { this.setSettled(false); return true; }
    this.setSettled(true);
    return false;
  }
  stop(): void { this.stopped = true; this.work.cancel(); }
  destroy(): void {
    this.observer.disconnect(); this.stop(); this.markers.destroy();
    this.batches = []; this.order = undefined; this.firstBatch = undefined; this.cursors.clear();
    this.canvas.width = 0; this.canvas.height = 0;
  }
}
