import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColumnBatch, QueryView } from '../src/core/types';
import { SeasonRenderer } from '../src/ui/season-renderer';
import { ColumnOrder } from '../src/ui/order';

let frames: Map<number, FrameRequestCallback>, sequence: number, resizes: (() => void)[];
function frame() { const ready = [...frames.values()]; frames.clear(); for (const run of ready) run(performance.now()); }
function settle() { for (let i = 0; frames.size && i < 1000; i++) frame(); expect(frames.size).toBe(0); }
function setup(split = true, vessel: number | null = null) {
  const ctx = { setTransform: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), stroke: vi.fn(), fill: vi.fn() };
  const canvas = { width: 0, height: 0, clientWidth: 640, clientHeight: 320, getContext: () => ctx };
  const view: QueryView = { id: 'season', prompt: 'calendar', revision: 1, source: 'template', sql: 'SELECT',
    plan: { metric: 'speed', aggregate: 'avg', bucketMinutes: 1, windowHours: 168, splitByVessel: split, vessel, view: 'seasons' },
    context: { id: 'test', label: 'test', rowCount: 10000, start: Date.UTC(2024, 0, 1), end: Date.UTC(2024, 11, 31), vessels: ['One', 'Two'], description: 'test' },
    timing: { startedAt: 0, promoted: false, points: 0, batches: 0, bytes: 0 } };
  const batches: ColumnBatch[] = [], order = new ColumnOrder(batches), draw = vi.fn(), settled = vi.fn();
  const source = { view, batches, order }, renderer = new SeasonRenderer(canvas as unknown as HTMLCanvasElement, source, { draw, settled });
  const append = (batch: ColumnBatch, index = true) => { batches.push(batch); renderer.append(batch); if (index) { order.append(batch); renderer.indexed(false); } };
  return { canvas, ctx, source, renderer, append, batches, order, draw, settled };
}
function batch(n: number, series = 0): ColumnBatch {
  return { x: Float64Array.from({ length: n }, (_, i) => Date.UTC(2024, 0, 1) + i * 60_000), y: new Float64Array(n).fill(12),
    series: new Int32Array(n).fill(series), length: n, byteLength: n * 20 };
}
beforeEach(() => {
  frames = new Map(); sequence = 0; resizes = [];
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++sequence, fn); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class { constructor(fn: () => void) { resizes.push(fn); } observe() {} disconnect() {} });
  vi.stubGlobal('window', { devicePixelRatio: 1 });
});
afterEach(() => vi.unstubAllGlobals());

describe('streaming seasonal wheel', () => {
  it('draws one real sample synchronously before indexing and preserves producer buffer identity', () => {
    const s = setup(), input = batch(10000); s.renderer.setVisible(true); s.append(input, false);
    expect(s.draw).toHaveBeenCalledOnce(); expect(s.order.series.size).toBe(0);
    expect(s.ctx.arc.mock.calls.filter(args => args[2] === 2.4)).toHaveLength(1);
    expect(s.batches[0]).toBe(input); expect(s.batches[0].x).toBe(input.x);
    frame(); expect(s.order.series.size).toBe(0); s.renderer.destroy(); settle();
  });
  it('skips hidden geometry and records its first draw only when revealed', () => {
    const s = setup(); s.append(batch(100)); settle();
    expect(s.ctx.arc).not.toHaveBeenCalled(); expect(s.draw).not.toHaveBeenCalled();
    s.renderer.setVisible(true); expect(s.draw).toHaveBeenCalledOnce(); settle(); expect(s.renderer.isSettled).toBe(true);
    s.ctx.arc.mockClear(); s.renderer.setVisible(true); settle(); expect(s.ctx.arc).not.toHaveBeenCalled(); s.renderer.destroy();
  });
  it('bounds indexed reads per work slice and stops all later geometry on cancellation', () => {
    const s = setup(); s.renderer.setVisible(true); s.append(batch(10000));
    const lookup = vi.spyOn(s.order, 'batchIndex'); frame(); expect(lookup).not.toHaveBeenCalled();
    frame(); expect(lookup.mock.calls.length).toBeGreaterThan(0); expect(lookup.mock.calls.length).toBeLessThanOrEqual(1024);
    const reads = lookup.mock.calls.length, marks = s.ctx.arc.mock.calls.length;
    s.renderer.stop(); s.renderer.indexed(true); settle();
    expect(lookup).toHaveBeenCalledTimes(reads); expect(s.ctx.arc).toHaveBeenCalledTimes(marks); expect(s.renderer.isSettled).toBe(false); s.renderer.destroy();
  });
  it('does not report invalid leading values but records the first valid indexed sample', () => {
    const s = setup(), input = batch(3); input.y[0] = NaN;
    s.renderer.setVisible(true); s.append(input); expect(s.draw).not.toHaveBeenCalled(); settle();
    expect(s.draw).toHaveBeenCalledOnce(); expect(s.ctx.arc.mock.calls.filter(args => args[2] === 2.4)).toHaveLength(2);
    for (const args of s.ctx.arc.mock.calls) expect(args.every(Number.isFinite)).toBe(true); s.renderer.destroy();
  });
  it('plots an actual UTC leap-year fraction and uses a single labeled ring for a filtered vessel', () => {
    const s = setup(true, 1), input = batch(1, 1); input.x[0] = Date.UTC(2024, 6, 1);
    s.renderer.setVisible(true); s.append(input, false);
    const point = s.ctx.arc.mock.calls.find(args => args[2] === 2.4)!;
    const radius = 128, angle = 182 / 366 * Math.PI * 2 - Math.PI / 2;
    expect(point[0]).toBeCloseTo(320 + Math.cos(angle) * radius); expect(point[1]).toBeCloseTo(160 + Math.sin(angle) * radius);
    expect(s.ctx.arc.mock.calls.filter(args => args[2] !== 2.4)).toHaveLength(1);
    expect(s.ctx.fillText.mock.calls.map(args => args[0])).toContain('Two'); s.renderer.destroy();
  });
  it('waits without polling while a shared index is sorting, then redraws without replacing it', () => {
    const s = setup(), input = batch(3); input.x.reverse(); s.renderer.setVisible(true); s.append(input); settle();
    expect(s.order.needsSort).toBe(true); s.order.sort(); const refs = s.order.series.get(0)!.refs;
    s.renderer.indexed(true); settle(); expect(s.renderer.isSettled).toBe(true); expect(s.order.series.get(0)!.refs).toBe(refs); expect(s.draw).toHaveBeenCalledOnce(); s.renderer.destroy();
  });
  it('releases source, callbacks, and bitmap on destruction without mutating borrowed data', () => {
    const s = setup(), input = batch(10); s.renderer.setVisible(true); s.append(input);
    s.renderer.destroy(); const internal = s.renderer as unknown as { source?: unknown; callbacks?: unknown };
    expect(internal.source).toBeUndefined(); expect(internal.callbacks).toBeUndefined(); expect(s.canvas.width).toBe(0); expect(s.canvas.height).toBe(0);
    expect(s.batches[0]).toBe(input); expect(s.order.series.get(0)!.refs).toHaveLength(10);
    resizes[0](); s.renderer.setVisible(true); s.renderer.indexed(true); settle(); expect(s.canvas.width).toBe(0);
  });
});
