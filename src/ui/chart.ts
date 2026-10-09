import { METRIC_LABELS, type ColumnBatch, type QueryView } from '../core/types';
import { ColumnOrder } from './order';
import { barLayout } from './bar-layout';

export const SERIES_COLORS = ['#ff906c', '#74d4c3', '#d4c17e', '#83b9e3', '#e39eaf', '#b0c985'];
const BACKGROUND = '#171b1c';
const number = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const time = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
const day = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Retains producer buffers. Drawing never expands columns into row objects. */
export class StreamChart {
  readonly batches: ColumnBatch[] = [];
  readonly order = new ColumnOrder(this.batches);
  private readonly ctx: CanvasRenderingContext2D;
  private readonly observer: ResizeObserver;
  private view?: QueryView;
  private width = 0;
  private height = 0;
  private frame = 0;
  private drawn = false;
  private stopped = false;
  private visible = true;
  private low = 0;
  private high = 40;
  private xLow = 0;
  private xHigh = 1;
  private xPadding = 0;
  private readonly pad = { left: 53, right: 22, top: 26, bottom: 38 };

  constructor(private canvas: HTMLCanvasElement, private onDraw: (id: string, at: number) => void) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
    this.ctx = ctx;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
  }

  begin(view: QueryView): void {
    this.view = view;
    this.batches.length = 0;
    this.order.clear();
    this.drawn = false;
    this.stopped = false;
    this.xPadding = view.plan.view === 'bar' ? view.plan.bucketMinutes * 30_000 : 0;
    this.xLow = Math.max(view.context.start, view.context.end - view.plan.windowHours * 3_600_000) - this.xPadding;
    this.xHigh = view.context.end + this.xPadding;
    [this.low, this.high] = { speed: [0, 40], wind: [0, 60], wave_height: [0, 8], water_temp: [-2, 35] }[view.plan.metric];
    this.grid();
  }

  append(batch: ColumnBatch): void {
    if (this.stopped) return;
    this.batches.push(batch);
    // Submit the first marker before walking the batch or scheduling continuation.
    this.firstMarker(batch);
    this.order.append(batch);
    for (let i = 0; i < batch.length; i++) {
      if (!Number.isFinite(batch.x[i]) || !Number.isFinite(batch.y[i])) continue;
      this.low = Math.min(this.low, batch.y[i]);
      this.high = Math.max(this.high, batch.y[i] * (batch.y[i] >= 0 ? 1.05 : 1));
      this.xLow = Math.min(this.xLow, batch.x[i] - this.xPadding);
      this.xHigh = Math.max(this.xHigh, batch.x[i] + this.xPadding);
    }
    this.schedule();
  }

  private firstMarker(batch: ColumnBatch): void {
    if (this.stopped || !this.visible || this.drawn || !this.view || !this.width || !this.height) return;
    for (let i = 0; i < batch.length; i++) {
      if (!Number.isFinite(batch.x[i]) || !Number.isFinite(batch.y[i])) continue;
      this.low = Math.min(this.low, batch.y[i]);
      this.high = Math.max(this.high, batch.y[i]);
      this.xLow = Math.min(this.xLow, batch.x[i] - this.xPadding);
      this.xHigh = Math.max(this.xHigh, batch.x[i] + this.xPadding);
      this.grid();
      const offset = this.view.plan.view === 'bar' ? this.bar(batch.series[i]).offset : 0;
      this.dot(this.x(batch.x[i]) + offset, this.y(batch.y[i]), batch.series[i]);
      this.drawn = true;
      this.onDraw(this.view.id, performance.now());
      return;
    }
  }

  private resize(): void {
    const box = this.canvas.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;
    this.width = box.width;
    this.height = box.height;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(box.width * dpr);
    this.canvas.height = Math.round(box.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const batch of this.batches) {
      this.firstMarker(batch);
      if (this.drawn) break;
    }
    this.render();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && !this.drawn) for (const batch of this.batches) {
      this.firstMarker(batch);
      if (this.drawn) break;
    }
  }

  private x(value: number): number {
    return this.pad.left + (value - this.xLow) / Math.max(1, this.xHigh - this.xLow) * (this.width - this.pad.left - this.pad.right);
  }

  private y(value: number): number {
    return this.height - this.pad.bottom - (value - this.low) / Math.max(0.001, this.high - this.low) * (this.height - this.pad.top - this.pad.bottom);
  }

  private bar(series: number) {
    const { plan, context } = this.view!;
    const grouped = plan.splitByVessel && plan.vessel === null;
    const bucketPixels = plan.bucketMinutes * 60_000 / Math.max(1, this.xHigh - this.xLow) * (this.width - this.pad.left - this.pad.right);
    return barLayout(bucketPixels, grouped ? series : 0, grouped ? context.vessels.length : 1);
  }

  private dot(x: number, y: number, series: number): void {
    this.ctx.beginPath();
    this.ctx.fillStyle = SERIES_COLORS[Math.abs(series) % SERIES_COLORS.length];
    this.ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    this.ctx.fill();
  }

  private grid(): void {
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

  private schedule(): void {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }

  private render(): void {
    this.grid();
    if (!this.view) return;
    const c = this.ctx;
    this.order.sort();
    c.save(); c.beginPath(); c.rect(this.pad.left - 4, this.pad.top - 4, this.width - this.pad.left - this.pad.right + 8, this.height - this.pad.top - this.pad.bottom + 8); c.clip();
    for (const [series, ordered] of this.order.series) {
      let lastX = 0, lastY = 0, hasPoint = false;
      c.beginPath();
      const color = SERIES_COLORS[Math.abs(series) % SERIES_COLORS.length];
      const bar = this.view.plan.view === 'bar' ? this.bar(series) : undefined;
      for (const ref of ordered.refs) {
        const index = this.order.batchIndex(ref), batch = this.batches[index], i = this.order.rowIndex(ref, index);
        const t = batch.x[i], value = batch.y[i];
        if (!Number.isFinite(t) || !Number.isFinite(value)) continue;
        const x = this.x(t) + (bar?.offset ?? 0), y = this.y(value);
        if (bar) {
          c.fillStyle = color; c.globalAlpha = 0.78;
          const baseline = this.y(Math.max(this.low, Math.min(this.high, 0)));
          c.fillRect(x - bar.width / 2, Math.min(y, baseline), bar.width, Math.max(1, Math.abs(baseline - y))); c.globalAlpha = 1;
        } else if (hasPoint) c.lineTo(x, y);
        else c.moveTo(x, y);
        lastX = x; lastY = y; hasPoint = true;
      }
      if (this.view.plan.view === 'line') { c.strokeStyle = color; c.lineWidth = 1.7; c.stroke(); }
      if (hasPoint) this.dot(lastX, lastY, series);
    }
    c.restore();
  }

  stop(): void { this.stopped = true; if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0; }
  destroy(): void { this.observer.disconnect(); this.stop(); }
}

export class TrackChart {
  private ctx: CanvasRenderingContext2D;
  private observer: ResizeObserver;
  private batches: readonly ColumnBatch[] = [];
  private order?: ColumnOrder;
  private frame = 0;
  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(canvas);
  }
  update(batches: readonly ColumnBatch[], order: ColumnOrder): void { this.batches = batches; this.order = order; this.schedule(); }
  private schedule(): void {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }
  private render(): void {
    const { width, height } = this.canvas.getBoundingClientRect();
    if (!width || !height) return;
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = width * ratio; this.canvas.height = height * ratio;
    const c = this.ctx; c.setTransform(ratio, 0, 0, ratio, 0, 0);
    c.fillStyle = BACKGROUND; c.fillRect(0, 0, width, height);
    c.strokeStyle = '#28332f'; c.lineWidth = 1;
    for (let x = 28; x < width; x += 45) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, height); c.stroke(); }
    for (let y = 22; y < height; y += 36) { c.beginPath(); c.moveTo(0, y); c.lineTo(width, y); c.stroke(); }
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const b of this.batches) if (b.lat && b.lon) for (let i = 0; i < b.length; i++) {
      if (!Number.isFinite(b.lat[i]) || !Number.isFinite(b.lon[i])) continue;
      minLat = Math.min(minLat, b.lat[i]); maxLat = Math.max(maxLat, b.lat[i]);
      minLon = Math.min(minLon, b.lon[i]); maxLon = Math.max(maxLon, b.lon[i]);
    }
    if (!Number.isFinite(minLat)) return;
    if (!this.order) return;
    this.order.sort();
    for (const [series, ordered] of this.order.series) {
      let lastX = 0, lastY = 0, hasPoint = false;
      c.beginPath();
      for (const ref of ordered.refs) {
        const index = this.order.batchIndex(ref), b = this.batches[index], i = this.order.rowIndex(ref, index);
        if (!b.lat || !b.lon || !Number.isFinite(b.lat[i]) || !Number.isFinite(b.lon[i])) continue;
        const x = 25 + (b.lon[i] - minLon) / Math.max(0.001, maxLon - minLon) * (width - 50);
        const y = height - 22 - (b.lat[i] - minLat) / Math.max(0.001, maxLat - minLat) * (height - 44);
        if (hasPoint) c.lineTo(x, y); else c.moveTo(x, y);
        lastX = x; lastY = y; hasPoint = true;
      }
      c.strokeStyle = SERIES_COLORS[Math.abs(series) % SERIES_COLORS.length]; c.lineWidth = 1.1; c.stroke();
      if (hasPoint) { c.fillStyle = c.strokeStyle; c.beginPath(); c.arc(lastX, lastY, 3, 0, Math.PI * 2); c.fill(); }
    }
  }
  destroy(): void { this.observer.disconnect(); if (this.frame) cancelAnimationFrame(this.frame); }
}
