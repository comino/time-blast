import { METRIC_LABELS, type ColumnBatch } from '../core/types';
import { FrameWork } from './frame-work';
import type { RendererCallbacks, RendererSource, ResultRenderer } from './renderer-contract';

export type MatrixMode = 'heatmap' | 'surface';
const BACKGROUND = '#0d1b24';
const DOMAINS = { speed: [0, 40], wind: [0, 60], wave_height: [0, 8], water_temp: [-2, 35] } as const;
const PALETTE = Array.from({ length: 64 }, (_, i) => {
  const t = i / 63;
  return `rgb(${Math.round(27 + 217 * t)},${Math.round(73 + 122 * t)},${Math.round(100 - 7 * t)})`;
});
const timeLabel = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
interface Cursor { count: number; previous: number }

/** Borrowed columns and a shared index; no dense matrix or copied vertex array. */
export class MatrixRenderer implements ResultRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly observer: ResizeObserver;
  private readonly work = new FrameWork(deadline => this.render(deadline));
  private source?: RendererSource;
  private callbacks?: RendererCallbacks;
  private readonly cursors = new Map<number, Cursor>();
  private readonly rows = new Map<number, number>();
  private labels: string[] = [];
  private width = 0; private height = 0; private dpr = 0;
  private projectedHeight = 1;
  private projectedBottom = 61; private keyColumns = 1; private keyHeight = 0;
  private visible = false; private stopped = false; private destroyed = false;
  private settled = true; private repaint = true; private drawn = false;
  private firstBatch?: ColumnBatch;
  private xLow = 0; private xHigh = 1; private low = 0; private high = 1; private bucket = 60_000;
  private angle = 28; private cosine = Math.cos(28 * Math.PI / 180); private sine = Math.sin(28 * Math.PI / 180);
  private readonly pad = { left: 73, right: 18, top: 28, bottom: 61 };

  constructor(private canvas: HTMLCanvasElement, readonly mode: MatrixMode, source: RendererSource, callbacks: RendererCallbacks) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas 2D is unavailable in this browser.');
    this.ctx = context; this.source = source; this.callbacks = callbacks;
    const { plan, context: data } = source.view;
    [this.low, this.high] = DOMAINS[plan.metric]; this.bucket = plan.bucketMinutes * 60_000;
    this.xLow = Math.max(data.start, data.end - plan.windowHours * 3_600_000);
    // Reserve the last bucket's width so a point exactly at context.end stays visible.
    this.xHigh = Math.max(this.xLow + this.bucket, data.end + this.bucket);
    if (plan.vessel !== null) { this.rows.set(plan.vessel, 0); this.labels = [data.vessels[plan.vessel] ?? `Vessel ${plan.vessel}`]; }
    else if (plan.splitByVessel) { this.labels = data.vessels; for (let i = 0; i < data.vessels.length; i++) this.rows.set(i, i); }
    else { this.rows.set(0, 0); this.labels = ['Fleet']; }
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(canvas); this.resize();
  }

  append(batch: ColumnBatch): void {
    if (this.stopped || this.destroyed) return;
    if (!this.firstBatch && batch.length && this.valid(batch, 0)) this.firstBatch = batch;
    if (!this.visible) return;
    this.setSettled(false);
    // The leading validated point is drawn before indexing or scanning any history.
    this.firstMark();
  }
  indexed(reordered: boolean): void {
    if (this.destroyed || this.stopped) return;
    this.repaint ||= reordered;
    if (this.visible) { this.setSettled(false); this.work.schedule(); }
  }
  setVisible(visible: boolean): void {
    if (this.destroyed || visible === this.visible) return;
    this.visible = visible;
    if (!visible) { this.work.cancel(); this.setSettled(true); return; }
    this.repaint = true;
    if (this.stopped) return;
    this.setSettled(false); this.firstMark(); this.work.schedule();
  }
  setAngle(degrees: number): void {
    if (this.destroyed || this.mode !== 'surface' || !Number.isFinite(degrees)) return;
    const angle = ((degrees % 360) + 360) % 360;
    if (angle === this.angle) return;
    this.angle = angle; this.cosine = Math.cos(angle * Math.PI / 180); this.sine = Math.sin(angle * Math.PI / 180);
    this.repaint = true;
    if (this.visible && !this.stopped) { this.setSettled(false); this.work.schedule(); }
  }
  get isSettled(): boolean { return this.settled && !this.stopped && !this.destroyed; }
  private setSettled(value: boolean): void {
    if (this.stopped || this.destroyed || value === this.settled) return;
    this.settled = value; this.callbacks?.settled(value);
  }
  private resize(): void {
    if (this.destroyed) return;
    const width = this.canvas.clientWidth ?? this.canvas.getBoundingClientRect().width;
    const height = this.canvas.clientHeight ?? this.canvas.getBoundingClientRect().height;
    const dpr = window.devicePixelRatio || 1;
    if (width < 1 || height < 1 || width === this.width && height === this.height && dpr === this.dpr) return;
    this.width = width; this.height = height; this.dpr = dpr;
    this.keyColumns = Math.max(1, Math.min(3, Math.floor((width - 24) / 105)));
    this.keyHeight = Math.ceil(this.labels.length / this.keyColumns) * 11;
    // The category key lives below the projection, clear of the top-right Rotate control.
    this.projectedBottom = this.pad.bottom + this.keyHeight + 18;
    this.projectedHeight = Math.max(1, height - this.projectedBottom - 40);
    this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.repaint = true;
    if (this.visible && !this.stopped) { this.setSettled(false); this.work.schedule(); }
  }
  private valid(batch: ColumnBatch, row: number): boolean {
    return Number.isFinite(batch.x[row]) && Number.isFinite(batch.y[row]) && this.rows.has(batch.series[row]) &&
      batch.x[row] + this.bucket > this.xLow && batch.x[row] < this.xHigh;
  }
  private color(value: number): string { return PALETTE[Math.max(0, Math.min(63, Math.round((value - this.low) / (this.high - this.low) * 63)))]; }
  private x(timestamp: number): number { return this.pad.left + (timestamp - this.xLow) / (this.xHigh - this.xLow) * (this.width - this.pad.left - this.pad.right); }
  private normalizedTime(timestamp: number): number { return (timestamp - this.xLow) / (this.xHigh - this.xLow) - 0.5; }
  private normalizedRow(row: number): number { return (row + 0.5) / this.labels.length - 0.5; }
  private normalizedValue(value: number): number { return Math.max(0, Math.min(1, (value - this.low) / (this.high - this.low))); }
  private projectX(x: number, y: number): number {
    return this.width / 2 + (x * this.cosine - y * this.sine) * Math.max(1, this.width - 112) * 0.68;
  }
  private projectY(x: number, y: number, value: number): number {
    const h = this.projectedHeight;
    return this.height - this.projectedBottom - h * 0.25 + (x * this.sine + y * this.cosine) * h * 0.3 - value * h * 0.64;
  }
  private firstMark(): void {
    if (!this.visible || this.stopped || this.drawn || !this.firstBatch || !this.width || !this.height) return;
    if (this.repaint) this.scaffold();
    this.point(this.firstBatch, 0);
    this.drawn = true; this.callbacks?.draw(performance.now());
  }
  private point(batch: ColumnBatch, row: number): void {
    const c = this.ctx, lane = this.rows.get(batch.series[row])!;
    c.fillStyle = this.color(batch.y[row]);
    if (this.mode === 'heatmap') {
      const height = Math.max(1, this.height - this.pad.top - this.pad.bottom) / this.labels.length;
      const left = Math.max(this.pad.left, this.x(batch.x[row]));
      const right = Math.min(this.width - this.pad.right, this.x(batch.x[row] + this.bucket));
      if (right > left) {
        // Raster-aligned shared edges avoid dark anti-alias seams between adjacent buckets.
        const pixelLeft = Math.floor(left * this.dpr) / this.dpr, pixelRight = Math.ceil(right * this.dpr) / this.dpr;
        c.fillRect(pixelLeft, this.pad.top + lane * height + 1, Math.max(0.5, pixelRight - pixelLeft), Math.max(1, height - 2));
      }
    } else {
      const x = this.normalizedTime(batch.x[row]), y = this.normalizedRow(lane), z = this.normalizedValue(batch.y[row]);
      c.beginPath(); c.arc(this.projectX(x, y), this.projectY(x, y, z), 2, 0, Math.PI * 2); c.fill();
    }
  }
  private surfaceSegment(previous: number, batch: ColumnBatch, row: number): void {
    const source = this.source!, index = source.order.batchIndex(previous), before = source.batches[index], i = source.order.rowIndex(previous, index);
    // A missing, duplicate, or nonaligned time bucket breaks the ribbon. No invented zero-height samples.
    if (!this.valid(before, i) || before.series[i] !== batch.series[row] || batch.x[row] - before.x[i] !== this.bucket) { this.point(batch, row); return; }
    const x0 = this.normalizedTime(before.x[i]), x1 = this.normalizedTime(batch.x[row]);
    const lane = this.normalizedRow(this.rows.get(batch.series[row])!), half = 0.32 / this.labels.length;
    const z0 = this.normalizedValue(before.y[i]), z1 = this.normalizedValue(batch.y[row]);
    const c = this.ctx;
    c.beginPath();
    c.moveTo(this.projectX(x0, lane - half), this.projectY(x0, lane - half, z0));
    c.lineTo(this.projectX(x1, lane - half), this.projectY(x1, lane - half, z1));
    c.lineTo(this.projectX(x1, lane + half), this.projectY(x1, lane + half, z1));
    c.lineTo(this.projectX(x0, lane + half), this.projectY(x0, lane + half, z0));
    c.closePath();
    c.fillStyle = c.strokeStyle = this.color(batch.y[row]);
    c.globalAlpha = 0.28; c.fill(); c.globalAlpha = 0.78; c.lineWidth = 0.65; c.stroke(); c.globalAlpha = 1;
  }
  private scaffold(): void {
    this.repaint = false; this.cursors.clear();
    const c = this.ctx, source = this.source!;
    c.fillStyle = BACKGROUND; c.fillRect(0, 0, this.width, this.height);
    c.font = '9px "IBM Plex Mono", ui-monospace, monospace'; c.fillStyle = '#91a5b0';
    const unit = METRIC_LABELS[source.view.plan.metric].unit;
    c.fillText(this.mode === 'surface' ? this.width < 410 ? `Ribbons · ${unit}` : `Vessel ribbons · height ${unit} · gaps preserved` : `Time × vessel · ${unit} · blank = missing`, 12, 15);
    if (this.mode === 'heatmap') {
      const rowHeight = Math.max(1, this.height - this.pad.top - this.pad.bottom) / this.labels.length;
      for (let i = 0; i < this.labels.length; i++) c.fillText(this.labels[i].slice(0, 11), 4, this.pad.top + rowHeight * (i + 0.5) + 3);
    } else {
      c.strokeStyle = '#2b4551'; c.lineWidth = 0.8;
      for (let row = 0; row < this.labels.length; row++) c.fillText(`${row + 1} ${this.labels[row].slice(0, 14)}`,
        12 + row % this.keyColumns * (this.width - 24) / this.keyColumns,
        this.height - this.pad.bottom - this.keyHeight + Math.floor(row / this.keyColumns) * 11);
      for (let row = 0; row < this.labels.length; row++) {
        const lane = this.normalizedRow(row);
        c.beginPath(); c.moveTo(this.projectX(-0.5, lane), this.projectY(-0.5, lane, 0));
        c.lineTo(this.projectX(0.5, lane), this.projectY(0.5, lane, 0)); c.stroke();
        c.fillText(String(row + 1), this.projectX(-0.5, lane) - 3, this.projectY(-0.5, lane, 0) + 13);
      }
      const axisX = this.projectX(-0.5, -0.5);
      c.beginPath(); c.moveTo(axisX, this.projectY(-0.5, -0.5, 0)); c.lineTo(axisX, this.projectY(-0.5, -0.5, 1)); c.stroke();
      c.fillText(`${this.high} ${unit}`, axisX - 18, this.projectY(-0.5, -0.5, 1) - 5);
      c.fillText(`${this.low}`, axisX - 18, this.projectY(-0.5, -0.5, 0) + 3);
    }
    c.fillStyle = '#91a5b0';
    c.fillText(timeLabel.format(this.xLow), 12, this.height - 40);
    const end = `${timeLabel.format(source.view.context.end)} UTC`;
    c.fillText(end, Math.max(12, this.width - 155), this.height - 40);
    const start = 14, barWidth = Math.min(120, this.width * 0.28);
    for (let i = 0; i < PALETTE.length; i++) { c.fillStyle = PALETTE[i]; c.fillRect(start + i * barWidth / 64, this.height - 27, barWidth / 64 + 0.5, 7); }
    c.fillStyle = '#91a5b0'; c.fillText(`${this.low}–${this.high} ${unit} · clamped color${this.mode === 'surface' ? ' / height' : ''}`, start + barWidth + 8, this.height - 21);
  }
  private render(deadline: number): boolean {
    const source = this.source;
    if (this.destroyed || this.stopped || !this.visible || !source || !this.width || !this.height) return false;
    // Index publication wakes us after a sort. Never spin while another component is sorting.
    if (source.order.needsSort) return false;
    if (this.repaint) { this.scaffold(); if (this.firstBatch) this.point(this.firstBatch, 0); }
    let work = 0; const limit = this.mode === 'surface' ? 512 : 1024;
    for (const [id, ordered] of source.order.series) {
      let state = this.cursors.get(id);
      if (!state) { state = { count: 0, previous: -1 }; this.cursors.set(id, state); }
      while (state.count < ordered.refs.length && work < limit) {
        const ref = ordered.refs[state.count++], index = source.order.batchIndex(ref), batch = source.batches[index], row = source.order.rowIndex(ref, index);
        work++;
        if (!this.valid(batch, row)) { state.previous = -1; }
        else {
          if (this.mode === 'surface' && state.previous !== -1) this.surfaceSegment(state.previous, batch, row); else this.point(batch, row);
          state.previous = ref;
          if (!this.drawn) { this.drawn = true; this.callbacks?.draw(performance.now()); }
        }
        if (work % 64 === 0 && performance.now() >= deadline) break;
      }
      if (work >= limit || performance.now() >= deadline) break;
    }
    let pending = false;
    for (const [id, series] of source.order.series) if ((this.cursors.get(id)?.count ?? 0) < series.refs.length) { pending = true; break; }
    this.setSettled(!pending); return pending;
  }
  stop(): void { this.stopped = true; this.work.cancel(); }
  destroy(): void {
    this.stop(); this.destroyed = true; this.observer.disconnect(); this.cursors.clear(); this.rows.clear();
    this.labels = []; this.firstBatch = undefined; this.source = undefined; this.callbacks = undefined;
    this.canvas.width = 0; this.canvas.height = 0;
  }
}
