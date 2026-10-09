import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColumnBatch, QueryView } from '../src/core/types';
import { MatrixRenderer, type MatrixMode } from '../src/ui/matrix-renderer';
import { ColumnOrder } from '../src/ui/order';

let frames: Map<number, FrameRequestCallback>, frameId: number;
let resizeCallbacks: (() => void)[];
function frame() { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(performance.now()); }
function settle() { for (let i = 0; frames.size && i < 1000; i++) frame(); expect(frames.size).toBe(0); }
function canvas() {
  const ctx = { setTransform: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    closePath: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn() };
  return { width: 0, height: 0, clientWidth: 640, clientHeight: 320, getContext: () => ctx,
    getBoundingClientRect: () => ({ width: 1280, height: 640 }), ctx };
}
function batch(n: number, start = 0, series = 0): ColumnBatch {
  return { x: Float64Array.from({ length: n }, (_, i) => (start + i) * 60_000), y: new Float64Array(n).fill(10),
    series: new Int32Array(n).fill(series), length: n, byteLength: n * 20 };
}
function view(): QueryView {
  return { id: 'matrix', prompt: 'heatmap', revision: 1, plan: { metric: 'speed', aggregate: 'avg', bucketMinutes: 1,
    windowHours: 168, splitByVessel: true, vessel: null, view: 'line' }, sql: 'SELECT', source: 'template',
    context: { id: 'test', label: 'test', rowCount: 10000, start: 0, end: 600_000_000, vessels: ['One', 'Two'], description: 'test' },
    timing: { startedAt: 0, promoted: false, batches: 0, points: 0, bytes: 0 } };
}
function setup(mode: MatrixMode) {
  const target = canvas(), batches: ColumnBatch[] = [], order = new ColumnOrder(batches), draw = vi.fn(), settled = vi.fn();
  const source = { view: view(), batches, order }, renderer = new MatrixRenderer(target as unknown as HTMLCanvasElement, mode, source, { draw, settled });
  const append = (input: ColumnBatch, index = true) => { batches.push(input); renderer.append(input); if (index) { order.append(input); renderer.indexed(false); } };
  return { target, batches, order, draw, settled, source, renderer, append };
}
beforeEach(() => {
  frames = new Map(); frameId = 0; resizeCallbacks = [];
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++frameId, fn); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class { constructor(fn: () => void) { resizeCallbacks.push(fn); } observe() {} disconnect() {} });
  vi.stubGlobal('window', { devicePixelRatio: 1 });
});
afterEach(() => vi.unstubAllGlobals());

describe('shared-buffer matrix renderers', () => {
  it.each(['heatmap', 'surface'] as const)('draws the first %s sample synchronously before any indexing', mode => {
    const s = setup(mode), input = batch(10000); s.renderer.setVisible(true); s.append(input, false);
    expect(s.draw).toHaveBeenCalledOnce(); expect(s.order.series.size).toBe(0);
    expect(s.source.batches[0]).toBe(input); expect(s.source.batches[0].x).toBe(input.x);
    const marks = mode === 'heatmap' ? s.target.ctx.fillRect : s.target.ctx.arc;
    expect(marks).toHaveBeenCalled();
    frame(); expect(s.order.series.size).toBe(0); expect(s.draw).toHaveBeenCalledOnce();
    s.renderer.destroy(); settle();
  });

  it.each(['heatmap', 'surface'] as const)('does no hidden %s geometry; reveal submits its first sample immediately', mode => {
    const s = setup(mode), input = batch(100);
    s.append(input); settle(); expect(s.draw).not.toHaveBeenCalled(); expect(s.target.ctx.fillRect).not.toHaveBeenCalled(); expect(s.target.ctx.arc).not.toHaveBeenCalled();
    s.renderer.setVisible(true); expect(s.draw).toHaveBeenCalledOnce(); settle(); expect(s.renderer.isSettled).toBe(true);
    expect(s.order.series.get(0)!.refs).toHaveLength(100); expect(s.batches[0]).toBe(input);
    s.target.ctx.fillRect.mockClear(); s.target.ctx.arc.mockClear(); s.renderer.setVisible(true); settle();
    expect(s.target.ctx.fillRect).not.toHaveBeenCalled(); expect(s.target.ctx.arc).not.toHaveBeenCalled(); s.renderer.destroy();
  });

  it.each(['heatmap', 'surface'] as const)('bounds %s geometry per work slice and cancels queued continuation', mode => {
    const s = setup(mode); s.renderer.setVisible(true); s.append(batch(10000));
    s.target.ctx.fillRect.mockClear(); s.target.ctx.closePath.mockClear();
    frame(); expect(s.target.ctx.fillRect).not.toHaveBeenCalled(); expect(s.target.ctx.closePath).not.toHaveBeenCalled();
    frame();
    const calls = mode === 'heatmap' ? s.target.ctx.fillRect.mock.calls.length : s.target.ctx.closePath.mock.calls.length;
    expect(calls).toBeGreaterThan(0); expect(calls).toBeLessThanOrEqual(mode === 'heatmap' ? 1024 : 512);
    expect(s.renderer.isSettled).toBe(false); s.renderer.stop(); settle();
    expect(mode === 'heatmap' ? s.target.ctx.fillRect.mock.calls.length : s.target.ctx.closePath.mock.calls.length).toBe(calls);
    s.renderer.indexed(true); s.renderer.setAngle(80); settle(); expect(s.renderer.isSettled).toBe(false); s.renderer.destroy();
  });

  it('preserves missing and duplicate bucket gaps without joining different vessel categories', () => {
    const s = setup('surface'), input = batch(6);
    input.x.set([0, 60_000, 180_000, 180_000, 240_000, 300_000]); input.series[5] = 1;
    s.renderer.setVisible(true); s.append(input); settle();
    expect(s.target.ctx.closePath).toHaveBeenCalledTimes(2); // 0→60k and 180k→240k only.
    expect(s.draw).toHaveBeenCalledOnce(); s.renderer.destroy();
  });

  it('does not bridge an invalid metric sample with a synthetic zero', () => {
    const s = setup('surface'), input = batch(4); input.y[1] = NaN;
    s.renderer.setVisible(true); s.append(input); settle();
    expect(s.target.ctx.closePath).toHaveBeenCalledTimes(1); // Only 120k→180k.
    s.renderer.destroy();
  });

  it('waits for reordered reference publication and redraws correct topology', () => {
    const s = setup('surface'), input = batch(4); input.x.set([180_000, 60_000, 120_000, 0]);
    s.renderer.setVisible(true); s.append(input); settle();
    expect(s.target.ctx.closePath).not.toHaveBeenCalled(); expect(s.order.needsSort).toBe(true);
    s.order.sort(); const refs = s.order.series.get(0)!.refs; s.renderer.indexed(true); settle();
    expect(s.target.ctx.closePath).toHaveBeenCalledTimes(3); expect(s.order.series.get(0)!.refs).toBe(refs); expect(s.batches[0]).toBe(input); s.renderer.destroy();
  });

  it('rotates projected surface geometry without replacing producer columns or the shared index', () => {
    const s = setup('surface'), input = batch(8); s.renderer.setVisible(true); s.append(input); settle();
    const refs = s.order.series.get(0)!.refs, previous = s.target.ctx.lineTo.mock.calls.map(call => [...call]);
    s.target.ctx.lineTo.mockClear(); s.renderer.setAngle(110); expect(s.renderer.isSettled).toBe(false); settle();
    expect(s.target.ctx.lineTo.mock.calls).not.toEqual(previous); expect(s.order.series.get(0)!.refs).toBe(refs);
    expect(s.batches[0].x.buffer).toBe(input.x.buffer); expect(s.draw).toHaveBeenCalledOnce(); s.renderer.destroy();
  });

  it('uses logical canvas dimensions, states units and clipping, and releases references on disposal', () => {
    const s = setup('heatmap'), input = batch(1); s.renderer.setVisible(true); s.append(input); settle();
    expect(s.target.width).toBe(640); expect(s.target.height).toBe(320);
    const captions = s.target.ctx.fillText.mock.calls.map(call => call[0]).join(' ');
    expect(captions).toContain('blank = missing'); expect(captions).toContain('0–40 kn'); expect(captions).toContain('clamped color');
    s.renderer.destroy(); expect(s.target.width).toBe(0); expect(s.target.height).toBe(0);
    expect((s.renderer as unknown as { source?: unknown }).source).toBeUndefined();
    expect(s.batches[0].x).toBe(input.x); expect(s.order.series.get(0)!.refs).toHaveLength(1);
    resizeCallbacks[0](); settle(); expect(s.target.width).toBe(0);
  });
});
