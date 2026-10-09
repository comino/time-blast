import type { ColumnBatch } from '../core/types';
import { SERIES_COLORS } from './chart';
import { FrameWork } from './frame-work';
import type { RendererCallbacks, RendererSource, ResultRenderer } from './renderer-contract';

export type GeoMode = 'map' | 'density' | 'tracks';
const CHUNK = 512, GRID_X = 96, GRID_Y = 48;
const DENSITY_COLORS = Array.from({ length: 512 }, (_, count) => {
  const intensity = Math.min(1, Math.log2(1 + count) / 9);
  return `hsl(${185 - intensity * 150} 78% ${38 + intensity * 24}%)`;
});
const densityColor = (count: number): string => DENSITY_COLORS[Math.min(511, count)];
type Frame = { west: number; east: number; south: number; north: number };
const WORLD: Frame = { west: -180, east: 180, south: -90, north: 90 };
const ATLANTIC: Frame = { west: -95, east: 25, south: 15, north: 85 };
interface Cursor { count: number; lon: number; lat: number; hasPoint: boolean }
const valid = (batch: ColumnBatch, row: number): boolean => !!batch.lat && !!batch.lon &&
  Number.isFinite(batch.lat[row]) && Number.isFinite(batch.lon[row]) &&
  Math.abs(batch.lat[row]) <= 90 && Math.abs(batch.lon[row]) <= 180;

/** Geographic coordinates stay in producer buffers. Only the bounded density grid is derived. */
export class GeoRenderer implements ResultRenderer {
  private source?: RendererSource;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base: HTMLCanvasElement;
  private readonly baseCtx: CanvasRenderingContext2D;
  private readonly heads?: HTMLCanvasElement;
  private readonly headsCtx?: CanvasRenderingContext2D;
  private readonly observer: ResizeObserver;
  private readonly work = new FrameWork(deadline => this.advance(deadline));
  private readonly cursors = new Map<number, Cursor>();
  private readonly density: Uint32Array;
  private width = 0; private height = 0; private dpr = 0;
  private visible = false; private stopped = false; private destroyed = false; private settled = false;
  private frame: Frame = WORLD; private domainChosen = false;
  private nextBatch = 0; private nextRow = 0; private repaint = true;
  private firstBatch?: ColumnBatch; private firstRow = 0; private drawn = false;
  private received = false;
  private fraction = 1;
  private coast?: Float32Array; private coastRequested = false; private coastRow = 0;
  private coastPrevious = false; private coastX = 0; private coastY = 0;
  private baseDirty = true;
  private readonly pad = { left: 34, right: 13, top: 16, bottom: 26 };

  constructor(private readonly canvas: HTMLCanvasElement, readonly mode: GeoMode, source: RendererSource,
    private readonly callbacks: RendererCallbacks) {
    this.source = source;
    this.density = new Uint32Array(mode === 'density' ? GRID_X * GRID_Y : 0);
    if (mode === 'density') this.pad.bottom = 55;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
    this.ctx = ctx;
    this.base = document.createElement('canvas');
    this.base.setAttribute('aria-hidden', 'true');
    this.base.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
    this.base.hidden = true;
    canvas.parentElement!.insertBefore(this.base, canvas);
    // Both layers remain within the existing result surface. The data layer is transparent.
    canvas.style.position = 'relative';
    this.baseCtx = this.base.getContext('2d', { alpha: false })!;
    if (mode === 'tracks') {
      this.heads = document.createElement('canvas'); this.heads.setAttribute('aria-hidden', 'true');
      this.heads.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
      this.heads.hidden = true;
      canvas.parentElement!.append(this.heads); this.headsCtx = this.heads.getContext('2d')!;
    }
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(canvas); this.resize();
  }

  get isSettled(): boolean { return this.settled && !this.stopped; }
  private setSettled(value: boolean): void {
    if (this.stopped || this.destroyed || value === this.settled) return;
    this.settled = value; this.callbacks.settled(value);
  }
  private resize(): void {
    if (this.destroyed) return;
    const width = this.canvas.clientWidth ?? this.canvas.getBoundingClientRect().width;
    const height = this.canvas.clientHeight ?? this.canvas.getBoundingClientRect().height;
    const dpr = window.devicePixelRatio || 1;
    if (width < 1 || height < 1 || width === this.width && height === this.height && dpr === this.dpr) return;
    this.width = width; this.height = height; this.dpr = dpr;
    for (const canvas of [this.canvas, this.base]) { canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); }
    if (this.heads) { this.heads.width = Math.round(width * dpr); this.heads.height = Math.round(height * dpr); this.headsCtx!.setTransform(dpr, 0, 0, dpr, 0, 0); }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.repaint = true; this.baseDirty = true;
    if (this.visible && !this.stopped) { this.setSettled(false); if (this.received) this.firstMarker(this.firstBatch ?? this.source?.batches[0], this.firstBatch ? this.firstRow : 0); this.work.schedule(); }
  }
  append(batch: ColumnBatch): void {
    if (this.stopped || this.destroyed) return;
    this.received = true;
    // Exactly one candidate, never a scan on the delivery stack.
    this.firstMarker(batch, 0);
    this.setSettled(false);
    if (this.visible) this.work.schedule();
  }
  indexed(reordered: boolean): void {
    if (this.stopped || this.destroyed) return;
    if (this.mode === 'tracks' && reordered) this.repaint = true;
    this.setSettled(false);
    if (this.visible) this.work.schedule();
  }
  setVisible(visible: boolean): void {
    if (this.destroyed || visible === this.visible) return;
    this.visible = visible; this.base.hidden = !visible; if (this.heads) this.heads.hidden = !visible;
    if (!visible) { this.work.cancel(); return; }
    if (!this.stopped) {
      this.setSettled(false);
      this.firstMarker(this.firstBatch ?? this.source?.batches[0], this.firstBatch ? this.firstRow : 0);
      this.work.schedule();
    }
  }
  setTimeFraction(fraction: number): void {
    if (this.destroyed || this.stopped || this.mode !== 'tracks' || !Number.isFinite(fraction)) return;
    const next = Math.max(0, Math.min(1, fraction)); if (next === this.fraction) return;
    this.fraction = next; this.repaint = true; this.setSettled(false);
    if (this.visible) this.work.schedule();
  }
  private cutoff(): number {
    const view = this.source!.view;
    const start = Math.max(view.context.start, view.context.end - view.plan.windowHours * 3_600_000);
    return start + (view.context.end - start) * this.fraction;
  }
  private x(lon: number): number { return this.pad.left + (lon - this.frame.west) / (this.frame.east - this.frame.west) * Math.max(1, this.width - this.pad.left - this.pad.right); }
  private y(lat: number): number { return this.pad.top + (this.frame.north - lat) / (this.frame.north - this.frame.south) * Math.max(1, this.height - this.pad.top - this.pad.bottom); }
  private chooseFrame(lon: number, lat: number): boolean {
    let next = this.frame;
    if (!this.domainChosen) {
      this.domainChosen = true;
      if (lon >= ATLANTIC.west && lon <= ATLANTIC.east && lat >= ATLANTIC.south && lat <= ATLANTIC.north) next = ATLANTIC;
    } else if (lon < this.frame.west || lon > this.frame.east || lat < this.frame.south || lat > this.frame.north) next = WORLD;
    if (next === this.frame) return false;
    this.frame = next; this.repaint = true; this.baseDirty = true; return true;
  }
  private firstMarker(batch: ColumnBatch | undefined, row: number): void {
    if (!batch || this.drawn || !this.visible || this.stopped || !this.width || !this.height || row >= batch.length || !valid(batch, row)) return;
    if (this.mode === 'tracks' && (!Number.isFinite(batch.x[row]) || batch.x[row] > this.cutoff())) return;
    this.chooseFrame(batch.lon![row], batch.lat![row]);
    if (this.baseDirty) this.grid();
    this.hint(batch, row);
    this.firstBatch = batch; this.firstRow = row; this.drawn = true;
    this.callbacks.draw(performance.now());
  }
  private dot(lon: number, lat: number, series: number, radius = 1.65, ctx = this.ctx): void {
    ctx.beginPath(); ctx.fillStyle = SERIES_COLORS[Math.abs(series) % SERIES_COLORS.length];
    ctx.arc(this.x(lon), this.y(lat), radius, 0, Math.PI * 2); ctx.fill();
  }
  private hint(batch: ColumnBatch, row: number): void {
    if (this.mode !== 'density') { this.dot(batch.lon![row], batch.lat![row], batch.series[row], 3.5, this.headsCtx ?? this.ctx); return; }
    const gx = Math.min(GRID_X - 1, Math.max(0, Math.floor((batch.lon![row] - this.frame.west) / (this.frame.east - this.frame.west) * GRID_X)));
    const gy = Math.min(GRID_Y - 1, Math.max(0, Math.floor((this.frame.north - batch.lat![row]) / (this.frame.north - this.frame.south) * GRID_Y)));
    const w = (this.width - this.pad.left - this.pad.right) / GRID_X, h = (this.height - this.pad.top - this.pad.bottom) / GRID_Y;
    this.ctx.fillStyle = densityColor(1);
    this.ctx.fillRect(this.pad.left + gx * w, this.pad.top + gy * h, Math.max(1, w - 0.2), Math.max(1, h - 0.2));
  }
  private grid(): void {
    this.baseDirty = false; this.coastRow = 0; this.coastPrevious = false;
    const c = this.baseCtx;
    c.fillStyle = '#091923'; c.fillRect(0, 0, this.width, this.height);
    c.font = '9px "IBM Plex Mono", ui-monospace, monospace'; c.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const lon = this.frame.west + (this.frame.east - this.frame.west) * i / 4;
      const lat = this.frame.south + (this.frame.north - this.frame.south) * i / 4;
      c.strokeStyle = '#203643'; c.beginPath(); c.moveTo(this.x(lon), this.pad.top); c.lineTo(this.x(lon), this.height - this.pad.bottom);
      c.moveTo(this.pad.left, this.y(lat)); c.lineTo(this.width - this.pad.right, this.y(lat)); c.stroke();
      c.fillStyle = '#64808d'; c.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
      c.fillText(`${Math.abs(lon).toFixed(0)}°${lon < 0 ? 'W' : lon > 0 ? 'E' : ''}`, this.x(lon), this.height - this.pad.bottom + 15);
      c.textAlign = 'right'; c.fillText(`${Math.abs(lat).toFixed(0)}°${lat < 0 ? 'S' : lat > 0 ? 'N' : ''}`, this.pad.left - 5, this.y(lat) + 3);
    }
    c.fillStyle = '#658591'; c.textAlign = 'right'; c.fillText('Natural Earth · equirectangular', this.width - this.pad.right, 10);
    if (this.mode === 'density') {
      // Fixed four-stop key: no source scan or running maximum on the first-point path.
      c.textAlign = 'left';
      [1, 8, 64, 511].forEach((count, i) => {
        const x = this.pad.left + i * 47;
        c.fillStyle = densityColor(count); c.fillRect(x, this.height - 29, 10, 7);
        c.fillStyle = '#acc6ca'; c.fillText(count === 511 ? '≥511' : String(count), x + 14, this.height - 22);
      });
      c.font = '8px "IBM Plex Mono", ui-monospace, monospace'; c.fillStyle = '#7597a2';
      c.fillText('Returned positions / cell · log, color capped ≥511', this.pad.left, this.height - 7);
    }
  }
  private loadCoast(): void {
    if (this.coastRequested) return; this.coastRequested = true;
    void import('./geo-coastline').then(({ COASTLINE }) => {
      if (this.destroyed || this.stopped) return;
      this.coast = COASTLINE; this.coastRow = 0; this.coastPrevious = false;
      if (this.visible) this.work.schedule();
    }).catch(() => { /* A basemap failure must never hide data or fail the query. */ });
  }
  private paintCoast(deadline: number): void {
    if (!this.coast || this.coastRow >= this.coast.length) return;
    const c = this.baseCtx; c.save(); c.beginPath();
    c.rect(this.pad.left, this.pad.top, this.width - this.pad.left - this.pad.right, this.height - this.pad.top - this.pad.bottom); c.clip();
    c.strokeStyle = '#41616b'; c.lineWidth = 0.8; c.beginPath();
    if (this.coastPrevious) c.moveTo(this.coastX, this.coastY);
    let count = 0;
    while (this.coastRow < this.coast.length && count++ < CHUNK && performance.now() < deadline) {
      const lon = this.coast[this.coastRow++], lat = this.coast[this.coastRow++];
      if (!Number.isFinite(lon)) { this.coastPrevious = false; continue; }
      const x = this.x(lon), y = this.y(lat);
      if (this.coastPrevious && Math.abs(x - this.coastX) < (this.width - this.pad.left - this.pad.right) * 0.8) c.lineTo(x, y); else c.moveTo(x, y);
      this.coastX = x; this.coastY = y; this.coastPrevious = true;
    }
    c.stroke(); c.restore();
  }
  private reset(): void {
    this.repaint = false; this.nextBatch = 0; this.nextRow = 0; this.cursors.clear(); this.density.fill(0);
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.headsCtx?.clearRect(0, 0, this.width, this.height);
    // Keep the acknowledged first mark visible while bulk paths are deferred.
    if (this.firstBatch && (this.mode !== 'tracks' || this.firstBatch.x[this.firstRow] <= this.cutoff()))
      this.hint(this.firstBatch, this.firstRow);
  }
  private paintRows(deadline: number): void {
    const batches = this.source!.batches; let processed = 0;
    while (this.nextBatch < batches.length && processed++ < CHUNK && performance.now() < deadline) {
      const batch = batches[this.nextBatch];
      if (this.nextRow >= batch.length) { this.nextBatch++; this.nextRow = 0; continue; }
      const row = this.nextRow++;
      if (!valid(batch, row)) continue;
      const lon = batch.lon![row], lat = batch.lat![row];
      if (this.chooseFrame(lon, lat)) return;
      this.firstMarker(batch, row);
      if (this.mode === 'map') this.dot(lon, lat, batch.series[row]);
      else {
        const gx = Math.min(GRID_X - 1, Math.max(0, Math.floor((lon - this.frame.west) / (this.frame.east - this.frame.west) * GRID_X)));
        const gy = Math.min(GRID_Y - 1, Math.max(0, Math.floor((this.frame.north - lat) / (this.frame.north - this.frame.south) * GRID_Y)));
        const count = ++this.density[gy * GRID_X + gx];
        const w = (this.width - this.pad.left - this.pad.right) / GRID_X, h = (this.height - this.pad.top - this.pad.bottom) / GRID_Y;
        // Stable log scale means one cell update never repaints the entire grid.
        this.ctx.fillStyle = densityColor(count);
        this.ctx.fillRect(this.pad.left + gx * w, this.pad.top + gy * h, Math.max(1, w - 0.2), Math.max(1, h - 0.2));
      }
    }
  }
  private paintTracks(deadline: number): void {
    const { order, batches } = this.source!; let processed = 0;
    const cutoff = this.cutoff();
    for (const [id, series] of order.series) {
      let cursor = this.cursors.get(id);
      if (!cursor) { cursor = { count: 0, lon: 0, lat: 0, hasPoint: false }; this.cursors.set(id, cursor); }
      if (cursor.count >= series.refs.length) continue;
      this.ctx.beginPath(); this.ctx.strokeStyle = SERIES_COLORS[Math.abs(id) % SERIES_COLORS.length]; this.ctx.lineWidth = 1.5;
      if (cursor.hasPoint) this.ctx.moveTo(this.x(cursor.lon), this.y(cursor.lat));
      while (cursor.count < series.refs.length && processed++ < CHUNK && performance.now() < deadline) {
        const ref = series.refs[cursor.count++], bi = order.batchIndex(ref), batch = batches[bi], row = order.rowIndex(ref, bi);
        if (batch.x[row] > cutoff) { cursor.count = series.refs.length; break; }
        if (!valid(batch, row)) { cursor.hasPoint = false; continue; }
        const lon = batch.lon![row], lat = batch.lat![row];
        if (this.chooseFrame(lon, lat)) { this.ctx.stroke(); return; }
        this.firstMarker(batch, row);
        if (cursor.hasPoint && Math.abs(lon - cursor.lon) <= 180) this.ctx.lineTo(this.x(lon), this.y(lat));
        else {
          this.ctx.stroke(); this.dot(lon, lat, id); this.ctx.beginPath();
          this.ctx.moveTo(this.x(lon), this.y(lat));
        }
        cursor.lon = lon; cursor.lat = lat; cursor.hasPoint = true;
      }
      this.ctx.stroke();
      if (processed >= CHUNK || performance.now() >= deadline) return;
    }
  }
  private needsData(): boolean {
    if (this.repaint) return true;
    if (this.mode !== 'tracks') return this.nextBatch < this.source!.batches.length;
    for (const [id, series] of this.source!.order.series) if ((this.cursors.get(id)?.count ?? 0) < series.refs.length) return true;
    return false;
  }
  private paintHeads(): void {
    if (!this.headsCtx || !this.cursors.size) return;
    this.headsCtx.clearRect(0, 0, this.width, this.height);
    for (const [id, cursor] of this.cursors) if (cursor.hasPoint) this.dot(cursor.lon, cursor.lat, id, 3.5, this.headsCtx);
  }
  private advance(deadline: number): boolean {
    if (this.stopped || this.destroyed || !this.visible || !this.source || !this.width || !this.height) return false;
    this.loadCoast();
    if (this.baseDirty) this.grid();
    if (this.repaint) this.reset();
    const waiting = this.mode === 'tracks' && this.source.order.needsSort;
    if (!waiting) this.mode === 'tracks' ? this.paintTracks(deadline) : this.paintRows(deadline);
    if (this.mode === 'tracks') this.paintHeads();
    if (performance.now() < deadline) this.paintCoast(deadline);
    const pending = !waiting && this.needsData();
    this.setSettled(!pending && !waiting);
    return pending || !!this.coast && this.coastRow < this.coast.length;
  }
  stop(): void { this.stopped = true; this.work.cancel(); }
  destroy(): void {
    if (this.destroyed) return;
    this.stop(); this.destroyed = true; this.observer.disconnect(); this.source = undefined; this.firstBatch = undefined;
    this.cursors.clear(); this.coast = undefined; this.density.fill(0);
    this.canvas.width = 0; this.canvas.height = 0; this.base.width = 0; this.base.height = 0; this.base.remove();
    if (this.heads) { this.heads.width = 0; this.heads.height = 0; this.heads.remove(); }
  }
}
