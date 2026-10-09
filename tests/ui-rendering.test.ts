import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColumnBatch, QueryView } from '../src/core/types';
import { StreamChart, TrackChart } from '../src/ui/chart';

let frames: Map<number, FrameRequestCallback>, nextFrame: number;
let overlays: ReturnType<typeof canvas>[];
let resizes: (() => void)[];
function frame() { const pending = [...frames.values()], at = performance.now(); frames.clear(); for (const callback of pending) callback(at); }
function settle() { for (let i = 0; frames.size && i < 500; i++) frame(); expect(frames.size).toBe(0); }
function canvas() {
  const ctx = { setTransform: vi.fn(), beginPath: vi.fn(), fillRect: vi.fn(), clearRect: vi.fn(), fillText: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(), save: vi.fn(), restore: vi.fn(), rect: vi.fn(), clip: vi.fn() };
  return { width: 0, height: 0, style: { cssText: '' }, parentElement: { append: vi.fn() }, setAttribute: vi.fn(), remove: vi.fn(),
    getContext: () => ctx, getBoundingClientRect: () => ({ width: 800, height: 268 }), ctx };
}
function batch(n: number, start = 0, backwards = false): ColumnBatch {
  return { x: Float64Array.from({ length: n }, (_, i) => start + (backwards ? n - i : i)), y: new Float64Array(n).fill(10),
    series: new Int32Array(n), lat: Float64Array.from({ length: n }, (_, i) => i % 2), lon: Float64Array.from({ length: n }, (_, i) => i % 2), length: n, byteLength: n * 36 };
}
function view(id = 'test'): QueryView {
  return { id, prompt: 'speed', revision: 1, plan: { metric: 'speed', aggregate: 'avg', bucketMinutes: 1, windowHours: 24, splitByVessel: true, vessel: null, view: 'line' },
    sql: 'SELECT', source: 'template', context: { id: 'test', label: 'test', rowCount: 10000, start: 0, end: 10000, vessels: ['One'], description: 'test' },
    timing: { startedAt: 0, committedAt: 0, promoted: false, batches: 0, points: 0, bytes: 0 } };
}
beforeEach(() => {
  frames = new Map(); nextFrame = 0;
  overlays = []; resizes = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resizes.push(callback); } observe() {} disconnect() {} });
  vi.stubGlobal('document', { createElement: () => { const layer = canvas(); overlays.push(layer); return layer; } });
  vi.stubGlobal('window', { devicePixelRatio: 1 });
});
afterEach(() => vi.unstubAllGlobals());

describe('cooperative chart rendering', () => {
  it('submits a marker without scanning the batch, leaves the next frame free, and bounds indexing', () => {
    const target = canvas(), draw = vi.fn(), progress = vi.fn();
    const chart = new StreamChart(target as unknown as HTMLCanvasElement, draw, progress);
    chart.begin(view()); const input = batch(10000); chart.append(input);
    expect(chart.batches[0]).toBe(input); expect(draw).toHaveBeenCalledOnce();
    expect(chart.order.series.size).toBe(0); expect(progress).not.toHaveBeenCalled();
    frame(); expect(chart.order.series.size).toBe(0); expect(progress).not.toHaveBeenCalled();
    frame(); expect(chart.order.series.get(0)!.refs.length).toBe(2048);
    expect(progress).toHaveBeenCalledOnce();
    chart.stop(); settle(); expect(chart.order.series.get(0)!.refs.length).toBe(2048);
    chart.destroy();
  });

  it('appends ordered points once when domains do not change, including track paths', () => {
    const target = canvas(), trackTarget = canvas(), track = new TrackChart(trackTarget as unknown as HTMLCanvasElement);
    const chart = new StreamChart(target as unknown as HTMLCanvasElement, () => {}, p => track.progress(p), reordered => track.indexed(reordered));
    chart.begin(view()); track.begin(chart.batches, chart.order);
    chart.append(batch(100)); settle(); target.ctx.lineTo.mockClear(); trackTarget.ctx.lineTo.mockClear();
    for (let i = 1; i < 10; i++) { chart.append(batch(100, i * 100)); settle(); }
    expect(target.ctx.lineTo).toHaveBeenCalledTimes(900);
    expect(trackTarget.ctx.lineTo).toHaveBeenCalledTimes(900);
    chart.destroy(); track.destroy();
  });

  it('does no hidden drawing and redraws retained points once when shown', () => {
    const target = canvas(), chart = new StreamChart(target as unknown as HTMLCanvasElement, () => {});
    chart.begin(view()); chart.setVisible(false); target.ctx.lineTo.mockClear();
    chart.append(batch(100)); settle();
    expect(chart.order.series.get(0)!.refs).toHaveLength(100); expect(target.ctx.lineTo).not.toHaveBeenCalled();
    chart.setVisible(true); settle(); expect(target.ctx.lineTo.mock.calls.length).toBeGreaterThanOrEqual(99);
    chart.destroy();
  });

  it('keeps the first marker when a canceled, unindexed result is shown again', () => {
    const target = canvas(), draw = vi.fn(), chart = new StreamChart(target as unknown as HTMLCanvasElement, draw);
    chart.begin(view()); chart.append(batch(10000)); chart.stop();
    chart.setVisible(false); chart.setVisible(true); settle();
    expect(chart.order.series.size).toBe(0); expect(draw).toHaveBeenCalledOnce();
    expect(overlays[0].ctx.arc).toHaveBeenCalledTimes(2);
    chart.destroy();
  });

  it('cancels stale continuations on replacement and repaints reordered references', () => {
    const target = canvas(), progress = vi.fn(), chart = new StreamChart(target as unknown as HTMLCanvasElement, () => {}, progress);
    chart.begin(view('old')); chart.append(batch(10000)); frame();
    chart.begin(view('new')); chart.append(batch(10, 100)); settle();
    expect(chart.batches).toHaveLength(1); expect(progress).toHaveBeenCalledOnce();
    chart.append(batch(10, 50, true)); settle();
    const times = chart.order.series.get(0)!.refs.map(ref => { const b = chart.order.batchIndex(ref); return chart.batches[b].x[chart.order.rowIndex(ref, b)]; });
    expect(times).toEqual([...times].sort((a, b) => a - b));
    chart.destroy();
  });

  it('queues arriving batches until a yielded sort completes without losing any references', () => {
    const target = canvas(), chart = new StreamChart(target as unknown as HTMLCanvasElement, () => {});
    chart.begin(view()); chart.append(batch(2048, 0, true)); frame(); frame();
    expect(chart.order.needsSort).toBe(true);
    chart.append(batch(100, 3000)); settle();
    const times = chart.order.series.get(0)!.refs.map(ref => { const b = chart.order.batchIndex(ref); return chart.batches[b].x[chart.order.rowIndex(ref, b)]; });
    expect(times).toHaveLength(2148); expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(chart.order.series.get(0)!.refs).size).toBe(2148);
    chart.destroy();
  });

  it('waits for sorted references without polling after a canceled hidden result is resized', () => {
    const target = canvas(), trackTarget = canvas(), track = new TrackChart(trackTarget as unknown as HTMLCanvasElement);
    const chart = new StreamChart(target as unknown as HTMLCanvasElement, () => {}, p => track.progress(p), reordered => track.indexed(reordered));
    chart.begin(view()); track.begin(chart.batches, chart.order);
    chart.append(batch(4096, 0, true)); frame(); frame();
    expect(chart.order.needsSort).toBe(true);
    chart.stop(); track.stop(); chart.setVisible(false);
    trackTarget.getBoundingClientRect = () => ({ width: 900, height: 268 });
    resizes[0](); settle();
    expect(chart.order.needsSort).toBe(true);
    expect(trackTarget.ctx.lineTo.mock.calls.length).toBeLessThan(100); // grid only; no polling for the canceled sorter

    // Showing the stopped primary finishes ordering its retained partial result,
    // and the existing indexed notification must wake the track again.
    trackTarget.ctx.lineTo.mockClear(); chart.setVisible(true); settle();
    expect(chart.order.needsSort).toBe(false);
    expect(trackTarget.ctx.lineTo.mock.calls.length).toBeGreaterThanOrEqual(2047);
    expect(overlays[0].ctx.arc).toHaveBeenCalled();
    chart.destroy(); track.destroy();
  });

  it('draws reordered tracks when normal indexing publishes sorted references', () => {
    const target = canvas(), trackTarget = canvas(), track = new TrackChart(trackTarget as unknown as HTMLCanvasElement);
    const chart = new StreamChart(target as unknown as HTMLCanvasElement, () => {}, p => track.progress(p), reordered => track.indexed(reordered));
    chart.begin(view()); track.begin(chart.batches, chart.order);
    chart.append(batch(4096, 0, true)); settle();
    expect(chart.order.needsSort).toBe(false);
    expect(chart.order.series.get(0)!.refs).toHaveLength(4096);
    expect(trackTarget.ctx.lineTo.mock.calls.length).toBeGreaterThanOrEqual(4095);
    expect(overlays[0].ctx.arc).toHaveBeenCalled();
    chart.destroy(); track.destroy();
  });

  it('repaints existing geometry when the value domain changes and preserves bars', () => {
    const target = canvas(), chart = new StreamChart(target as unknown as HTMLCanvasElement, () => {});
    const request = view(); request.plan.view = 'bar'; chart.begin(request); chart.append(batch(100)); settle();
    target.ctx.fillRect.mockClear(); const next = batch(1, 200); next.y[0] = 100;
    chart.append(next); settle();
    expect(target.ctx.fillRect.mock.calls.length).toBe(102); // background and all 101 rescaled bars
    chart.destroy();
  });

  it('reports settlement only after indexing and painting, and invalidates it on redraw', () => {
    const target = canvas(), settled = vi.fn();
    const chart = new StreamChart(target as unknown as HTMLCanvasElement, () => {}, () => {}, () => {}, settled);
    chart.begin(view('large')); chart.append(batch(6000));
    expect(chart.isSettled).toBe(false); frame(); frame();
    expect(chart.isSettled).toBe(false); expect(settled).not.toHaveBeenCalled();
    settle(); expect(chart.isSettled).toBe(true); expect(settled.mock.calls).toEqual([['large', true]]);
    chart.setVisible(false); expect(chart.isSettled).toBe(true);
    chart.setVisible(true); expect(chart.isSettled).toBe(false);
    settle(); expect(settled.mock.calls).toEqual([['large', true], ['large', false], ['large', true]]);
    chart.destroy();
  });

  it('settles hidden results after indexing, but never settles canceled or replaced work', () => {
    const target = canvas(), settled = vi.fn();
    const chart = new StreamChart(target as unknown as HTMLCanvasElement, () => {}, () => {}, () => {}, settled);
    chart.begin(view('canceled')); chart.append(batch(6000)); chart.stop(); settle();
    expect(chart.isSettled).toBe(false); expect(settled).not.toHaveBeenCalled();
    chart.begin(view('replaced')); chart.append(batch(6000)); frame();
    chart.begin(view('hidden')); chart.setVisible(false); chart.append(batch(6000)); settle();
    expect(chart.isSettled).toBe(true);
    expect(settled.mock.calls.every(([id]) => id === 'hidden')).toBe(true);
    expect(settled.mock.calls.at(-1)).toEqual(['hidden', true]);
    chart.destroy();
  });
});
