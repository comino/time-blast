import type { ColumnBatch } from '../core/types';
import { METRIC_LABELS } from '../core/types';
import { FrameWork } from './frame-work';
import type { RendererCallbacks, RendererSource, ResultRenderer } from './renderer-contract';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOMAINS = { speed: [0, 40], wind: [0, 60], wave_height: [0, 8], water_temp: [-2, 35] } as const;
const PALETTE = Array.from({ length: 64 }, (_, i) => `hsl(${205 - i / 63 * 170} 68% ${30 + i / 63 * 38}%)`);
/** Calendar positions of actual returned values; this does not invent monthly aggregates. */
export class SeasonRenderer implements ResultRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly observer: ResizeObserver;
  private readonly work = new FrameWork(deadline => this.render(deadline));
  private source?: RendererSource;
  private callbacks?: RendererCallbacks;
  private visible = false; private stopped = false; private destroyed = false; private drawn = false;
  private settled = true; private repaint = true;
  private width = 0; private height = 0; private dpr = 0;
  private centerX = 0; private centerY = 0; private radius = 1;
  private first?: ColumnBatch; private firstRow = 0;
  private readonly cursors = new Map<number, number>();
  private readonly rings = new Map<number, number>();
  private labels: string[] = [];
  private readonly date = new Date(0);
  private year = NaN; private yearStart = 0; private yearEnd = 1;
  private readonly monthAngles = new Float64Array(12);
  private low = 0; private high = 1; private unit = '';
  constructor(private canvas: HTMLCanvasElement, source: RendererSource, callbacks: RendererCallbacks) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
    this.ctx = ctx; this.source = source; this.callbacks = callbacks;
    const { plan, context } = source.view;
    [this.low, this.high] = DOMAINS[plan.metric]; this.unit = METRIC_LABELS[plan.metric].unit;
    if (plan.vessel !== null) { this.rings.set(plan.vessel, 0); this.labels = [context.vessels[plan.vessel] ?? `Vessel ${plan.vessel}`]; }
    else if (plan.splitByVessel) { this.labels = context.vessels; for (let i = 0; i < context.vessels.length; i++) this.rings.set(i, i); }
    else { this.rings.set(0, 0); this.labels = ['Fleet']; }
    this.date.setTime(context.end); const calendarYear = this.date.getUTCFullYear(), start = this.utcStart(calendarYear), duration = this.utcStart(calendarYear + 1) - start;
    for (let i = 0; i < 12; i++) this.monthAngles[i] = (this.utcStart(calendarYear, i) - start) / duration * Math.PI * 2 - Math.PI / 2;
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(canvas); this.resize();
  }
  get isSettled(): boolean { return this.settled && !this.stopped && !this.destroyed; }
  private setSettled(value: boolean): void { if (this.settled === value || this.destroyed || this.stopped) return; this.settled = value; this.callbacks?.settled(value); }
  private resize(): void {
    if (this.destroyed) return;
    const width = this.canvas.clientWidth ?? this.canvas.getBoundingClientRect().width, height = this.canvas.clientHeight ?? this.canvas.getBoundingClientRect().height;
    const dpr = window.devicePixelRatio || 1;
    if (!width || !height || width === this.width && height === this.height && dpr === this.dpr) return;
    this.width = width; this.height = height; this.dpr = dpr;
    this.centerX = width / 2; this.centerY = height / 2; this.radius = Math.max(12, Math.min(width / 2 - 52, height / 2 - 32));
    this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr); this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.repaint = true; if (this.visible && !this.stopped) { this.firstMark(); this.schedule(); }
  }
  append(batch: ColumnBatch): void {
    if (this.stopped || this.destroyed) return;
    if (!this.first && batch.length && this.valid(batch, 0)) { this.first = batch; this.firstRow = 0; }
    this.firstMark(); if (this.visible) this.schedule();
  }
  indexed(reordered: boolean): void { if (this.stopped || this.destroyed) return; this.repaint ||= reordered; if (this.visible) this.schedule(); }
  setVisible(visible: boolean): void {
    if (this.visible === visible || this.destroyed) return;
    this.visible = visible;
    if (!visible) { this.work.cancel(); this.setSettled(true); }
    else if (!this.stopped) { this.resize(); this.repaint = true; this.firstMark(); this.schedule(); }
  }
  private schedule(): void { this.setSettled(false); this.work.schedule(); }
  private recordDraw(): void { if (this.drawn || this.stopped || !this.visible) return; this.drawn = true; this.callbacks?.draw(performance.now()); }
  private firstMark(): void {
    if (this.drawn || !this.visible || this.stopped || !this.width || !this.height || !this.first) return;
    if (this.repaint) { this.grid(); this.cursors.clear(); this.repaint = false; }
    this.point(this.first, this.firstRow); this.recordDraw();
  }
  private ringRadius(ring: number): number { return this.radius * (.27 + .73 * (ring + 1) / this.labels.length); }
  private grid(): void {
    const c = this.ctx, x = this.centerX, y = this.centerY, radius = this.radius;
    c.fillStyle = '#0d1b24'; c.fillRect(0, 0, this.width, this.height); c.strokeStyle = '#29434d'; c.lineWidth = 1;
    for (let ring = 0; ring < this.labels.length; ring++) { c.beginPath(); c.arc(x, y, this.ringRadius(ring), 0, Math.PI * 2); c.stroke(); }
    c.fillStyle = '#82adb4'; c.font = '9px monospace'; c.textAlign = 'center';
    for (let i = 0; i < 12; i++) c.fillText(MONTHS[i], x + Math.cos(this.monthAngles[i]) * (radius + 17), y + Math.sin(this.monthAngles[i]) * (radius + 17) + 3);
    c.fillStyle = '#607f8a'; c.font = '8px monospace'; c.fillText('UTC · observed dates', x, y - 3); c.fillText(`${this.unit} in color`, x, y + 10);
    c.textAlign = 'left'; c.fillStyle = '#82adb4';
    for (let ring = 0; ring < this.labels.length; ring++) c.fillText(this.labels[ring].slice(0, 12), x + 5, y + this.ringRadius(ring) - 2);
    for (let i = 0; i < 32; i++) { c.fillStyle = PALETTE[i * 2]; c.fillRect(14 + i * 2, 12, 2, 4); }
    c.fillStyle = '#82adb4'; c.fillText(`${this.low} — ${this.high} ${this.unit} · clamped`, 14, 29);
  }
  private color(value: number): string { return PALETTE[Math.max(0, Math.min(63, Math.round((value - this.low) / (this.high - this.low) * 63)))]; }
  private valid(batch: ColumnBatch, row: number): boolean {
    return Number.isFinite(batch.x[row]) && Math.abs(batch.x[row]) <= 8.64e15 && Number.isFinite(batch.y[row]) && this.rings.has(batch.series[row]);
  }
  private utcStart(year: number, month = 0): number {
    // setUTCFullYear preserves years 0–99, unlike the special 1900 offset in Date.UTC.
    this.date.setUTCFullYear(year, month, 1); this.date.setUTCHours(0, 0, 0, 0); return this.date.getTime();
  }
  private point(batch: ColumnBatch, row: number): void {
    this.date.setTime(batch.x[row]); const year = this.date.getUTCFullYear();
    if (year !== this.year) { this.year = year; this.yearStart = this.utcStart(year); this.yearEnd = this.utcStart(year + 1); }
    const a = (batch.x[row] - this.yearStart) / (this.yearEnd - this.yearStart) * Math.PI * 2 - Math.PI / 2;
    const r = this.ringRadius(this.rings.get(batch.series[row])!);
    const c = this.ctx; c.fillStyle = this.color(batch.y[row]); c.beginPath(); c.arc(this.centerX + Math.cos(a) * r, this.centerY + Math.sin(a) * r, 2.4, 0, Math.PI * 2); c.fill();
  }
  private render(deadline: number): boolean {
    const source = this.source;
    if (!this.visible || this.stopped || this.destroyed || !this.width || !this.height || !source) return false;
    if (source.order.needsSort) return false;
    if (this.repaint) { this.grid(); this.cursors.clear(); this.repaint = false; if (this.first) this.point(this.first, this.firstRow); }
    let work = 0;
    for (const [series, order] of source.order.series) {
      let next = this.cursors.get(series) ?? 0;
      while (next < order.refs.length && work < 1024) {
        const ref = order.refs[next++], index = source.order.batchIndex(ref), batch = source.batches[index], row = source.order.rowIndex(ref, index);
        if (this.valid(batch, row)) { this.point(batch, row); if (!this.first) { this.first = batch; this.firstRow = row; } this.recordDraw(); }
        if (++work % 64 === 0 && performance.now() >= deadline) break;
      }
      this.cursors.set(series, next);
      if (next < order.refs.length || performance.now() >= deadline) return true;
    }
    this.setSettled(true); return false;
  }
  stop(): void { this.stopped = true; this.work.cancel(); }
  destroy(): void {
    this.stop(); this.destroyed = true; this.observer.disconnect(); this.first = undefined; this.cursors.clear(); this.rings.clear();
    this.source = undefined; this.callbacks = undefined; this.labels = []; this.canvas.width = this.canvas.height = 0;
  }
}
