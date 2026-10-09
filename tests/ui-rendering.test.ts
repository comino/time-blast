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
  it('can index shared geometry without scanning unused coordinate statistics', () => {
    const target = canvas(), progress = vi.fn();
    const chart = new StreamChart(target as unknown as HTMLCanvasElement, () => {}, progress, () => {}, () => {}, false);
    const input = batch(100);
    Object.defineProperty(input, 'lat', { get() { throw new Error('Unused coordinate statistics accessed'); } });
    chart.begin(view()); chart.append(input); settle();
    expect(progress).toHaveBeenCalledOnce(); expect(progress.mock.calls[0][0].count).toBe(100);
    expect(chart.order.series.get(0)!.refs).toHaveLength(100); chart.destroy();
  });
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

  it('releases live draft buffers and stale frame work while retaining canvas storage', () => {
    const target = canvas(), draw = vi.fn(), progress = vi.fn();
    const chart = new StreamChart(target as unknown as HTMLCanvasElement, draw, progress);
    const old = batch(10000, 0, true);
    chart.begin(view('old')); chart.append(old); frame(); frame();
    expect(chart.order.series.size).toBe(1); expect(chart.order.needsSort).toBe(true);
    const staleFrames = [...frames.values()], dimensions = [target.width, target.height];
    progress.mockClear(); chart.reset();
    expect(chart.batches).toHaveLength(0); expect(chart.order.series.size).toBe(0); expect(chart.order.needsSort).toBe(false);
    expect(frames.size).toBe(0); expect([target.width, target.height]).toEqual(dimensions); expect(overlays).toHaveLength(1);
    Object.defineProperty(old, 'x', { get() { throw new Error('Released draft accessed'); } });
    for (const callback of staleFrames) callback(performance.now());
    chart.append(old); chart.setVisible(false); chart.setVisible(true); settle();
    expect(chart.batches).toHaveLength(0); expect(progress).not.toHaveBeenCalled(); expect(draw).toHaveBeenCalledOnce();
    const next = batch(5, 100);
    chart.begin(view('new')); chart.append(next); settle();
    expect(chart.batches).toEqual([next]); expect(chart.batches[0]).toBe(next); expect(chart.order.series.get(0)!.refs).toHaveLength(5);
    expect(progress).toHaveBeenCalledOnce(); expect(progress.mock.calls[0][0].count).toBe(5);
    expect(draw.mock.calls.map(call => call[0])).toEqual(['old', 'new']); expect(overlays).toHaveLength(1);
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

  it('switches display types using the same indexed producer buffers without changing the query', () => {
    const target = canvas(), progress = vi.fn(), draw = vi.fn();
    const chart = new StreamChart(target as unknown as HTMLCanvasElement, draw, progress);
    const request = view(), input = batch(100);
    chart.begin(request); chart.append(input); settle();
    const refs = chart.order.series.get(0)!.refs;
    progress.mockClear(); target.ctx.arc.mockClear();
    chart.setRepresentation('scatter');
    expect(chart.isSettled).toBe(false); expect(target.ctx.arc).not.toHaveBeenCalled();
    settle();
    expect(target.ctx.arc).toHaveBeenCalledTimes(100); expect(chart.isSettled).toBe(true);
    target.ctx.fillRect.mockClear(); chart.setRepresentation('bar'); settle();
    expect(target.ctx.fillRect).toHaveBeenCalledTimes(101); // background and each bar
    expect(chart.batches[0]).toBe(input); expect(chart.batches[0].x).toBe(input.x);
    expect(chart.order.series.get(0)!.refs).toBe(refs); expect(progress).not.toHaveBeenCalled();
    expect(draw).toHaveBeenCalledOnce(); expect(request.plan.view).toBe('line');
    const next = view('next'); next.plan.view = 'bar'; chart.begin(next);
    expect(chart.representation).toBe('bar');
    chart.destroy();
  });

  it('bounds scatter work after its immediate first marker and cancels remaining points', () => {
    const target = canvas(), draw = vi.fn();
    const chart = new StreamChart(target as unknown as HTMLCanvasElement, draw);
    chart.begin(view()); chart.setRepresentation('scatter'); chart.append(batch(10000));
    expect(draw).toHaveBeenCalledOnce(); expect(target.ctx.arc).not.toHaveBeenCalled();
    frame(); expect(target.ctx.arc).not.toHaveBeenCalled();
    frame(); expect(target.ctx.arc.mock.calls.length).toBeLessThanOrEqual(2048);
    expect(chart.isSettled).toBe(false);
    const drawn = target.ctx.arc.mock.calls.length;
    chart.stop(); settle(); expect(target.ctx.arc).toHaveBeenCalledTimes(drawn);
    expect(chart.isSettled).toBe(false); chart.destroy();
  });

  it('defers hidden representation changes and paints each retained point once when shown', () => {
    const target = canvas(), chart = new StreamChart(target as unknown as HTMLCanvasElement, () => {});
    chart.begin(view()); chart.append(batch(100)); settle(); chart.setVisible(false);
    target.ctx.arc.mockClear(); chart.setRepresentation('scatter'); settle();
    expect(target.ctx.arc).not.toHaveBeenCalled(); expect(chart.isSettled).toBe(true);
    chart.setVisible(true); settle();
    expect(target.ctx.arc).toHaveBeenCalledTimes(100); expect(chart.isSettled).toBe(true);
    target.ctx.arc.mockClear(); chart.setRepresentation('scatter'); settle();
    expect(target.ctx.arc).not.toHaveBeenCalled(); chart.destroy();
  });

  it('submits a track marker before indexing and settles only after shared geometry is painted', () => {
    const target = canvas(), trackTarget = canvas(), trackSettled = vi.fn();
    const track = new TrackChart(trackTarget as unknown as HTMLCanvasElement, trackSettled);
    const chart = new StreamChart(target as unknown as HTMLCanvasElement, () => {}, p => track.progress(p), reordered => track.indexed(reordered));
    chart.setVisible(false); chart.begin(view()); track.begin(chart.batches, chart.order);
    const input = batch(6000); chart.append(input);
    expect(track.append(input)).toBe(true); expect(overlays[0].ctx.arc).toHaveBeenCalledOnce();
    expect(chart.order.series.size).toBe(0); expect(track.isSettled).toBe(false);
    frame(); expect(chart.order.series.size).toBe(0); expect(track.isSettled).toBe(false);
    settle(); expect(chart.batches[0]).toBe(input);
    expect(chart.isSettled).toBe(true); expect(track.isSettled).toBe(true);
    expect(trackSettled.mock.calls.at(-1)).toEqual([true]);
    chart.destroy(); track.destroy();
  });

  it('does not schedule hidden track geometry and resumes retained coordinates when shown', () => {
    const target = canvas(), trackTarget = canvas();
    const track = new TrackChart(trackTarget as unknown as HTMLCanvasElement);
    const chart = new StreamChart(target as unknown as HTMLCanvasElement, () => {}, p => track.progress(p), reordered => track.indexed(reordered));
    track.setVisible(false); chart.begin(view()); track.begin(chart.batches, chart.order);
    trackTarget.ctx.lineTo.mockClear();
    const input = batch(100); chart.append(input); expect(track.append(input)).toBe(false); settle();
    expect(trackTarget.ctx.lineTo).not.toHaveBeenCalled(); expect(overlays[0].ctx.arc).not.toHaveBeenCalled();
    track.setVisible(true); expect(track.isSettled).toBe(false); settle();
    expect(trackTarget.ctx.lineTo.mock.calls.length).toBeGreaterThanOrEqual(99);
    expect(overlays[0].ctx.arc).toHaveBeenCalled(); expect(track.isSettled).toBe(true);
    const next = batch(6000, 100); chart.append(next); track.append(next);
    chart.stop(); track.stop(); const lines = trackTarget.ctx.lineTo.mock.calls.length; settle();
    expect(trackTarget.ctx.lineTo).toHaveBeenCalledTimes(lines); expect(track.isSettled).toBe(false);
    chart.destroy(); track.destroy();
  });

  it('reports the first track draw exactly once when a hidden result becomes visible', () => {
    const target = canvas(), trackTarget = canvas(), draw = vi.fn();
    const track = new TrackChart(trackTarget as unknown as HTMLCanvasElement, () => {}, draw);
    const chart = new StreamChart(target as unknown as HTMLCanvasElement, () => {}, p => track.progress(p), reordered => track.indexed(reordered));
    track.setVisible(false); chart.begin(view()); track.begin(chart.batches, chart.order);
    const input = batch(100); chart.append(input); expect(track.append(input)).toBe(false); settle();
    expect(draw).not.toHaveBeenCalled(); expect(overlays[0].ctx.arc).not.toHaveBeenCalled();
    const shownAt = performance.now(); track.setVisible(true);
    expect(draw).toHaveBeenCalledOnce(); expect(draw.mock.calls[0][0]).toBeGreaterThanOrEqual(shownAt);
    expect(overlays[0].ctx.arc).toHaveBeenCalledOnce(); settle();
    track.setVisible(false); track.setVisible(true); settle();
    expect(draw).toHaveBeenCalledOnce(); chart.destroy(); track.destroy();
  });

  it('reports a zero-size track first draw after resize makes its marker drawable', () => {
    const target = canvas(), trackTarget = Object.assign(canvas(), { clientWidth: 0, clientHeight: 0 }), draw = vi.fn();
    const track = new TrackChart(trackTarget as unknown as HTMLCanvasElement, () => {}, draw);
    const chart = new StreamChart(target as unknown as HTMLCanvasElement, () => {}, p => track.progress(p), reordered => track.indexed(reordered));
    chart.begin(view()); track.begin(chart.batches, chart.order);
    const input = batch(100); chart.append(input); expect(track.append(input)).toBe(false); settle();
    expect(draw).not.toHaveBeenCalled(); expect(overlays[0].ctx.arc).not.toHaveBeenCalled();
    const resizedAt = performance.now(); trackTarget.clientWidth = 800; trackTarget.clientHeight = 268;
    resizes[0](); settle();
    expect(draw).toHaveBeenCalledOnce(); expect(draw.mock.calls[0][0]).toBeGreaterThanOrEqual(resizedAt);
    expect(overlays[0].ctx.arc).toHaveBeenCalled();
    trackTarget.clientWidth = 900; resizes[0](); settle();
    expect(draw).toHaveBeenCalledOnce(); chart.destroy(); track.destroy();
  });

  it('preserves a canceled track first marker when its unindexed result is shown again', () => {
    const target = canvas(), trackTarget = canvas();
    const track = new TrackChart(trackTarget as unknown as HTMLCanvasElement);
    const chart = new StreamChart(target as unknown as HTMLCanvasElement, () => {}, p => track.progress(p), reordered => track.indexed(reordered));
    chart.begin(view()); track.begin(chart.batches, chart.order);
    const input = batch(6000); chart.append(input); track.append(input); chart.stop(); track.stop();
    track.setVisible(false); track.setVisible(true); settle();
    expect(chart.order.series.size).toBe(0); expect(overlays[0].ctx.arc).toHaveBeenCalledTimes(2);
    expect(track.isSettled).toBe(false); chart.destroy(); track.destroy();
  });

  it('uses logical canvas dimensions even when the canvas camera scales its screen rectangle', () => {
    const target = Object.assign(canvas(), { clientWidth: 800, clientHeight: 268 });
    const trackTarget = Object.assign(canvas(), { clientWidth: 800, clientHeight: 268 });
    target.getBoundingClientRect = trackTarget.getBoundingClientRect = () => ({ width: 1600, height: 536 });
    const chart = new StreamChart(target as unknown as HTMLCanvasElement, () => {});
    const track = new TrackChart(trackTarget as unknown as HTMLCanvasElement);
    expect(target.width).toBe(800); expect(trackTarget.width).toBe(800);
    chart.begin(view()); track.begin(chart.batches, chart.order); settle();
    target.ctx.setTransform.mockClear(); trackTarget.ctx.setTransform.mockClear();
    target.getBoundingClientRect = trackTarget.getBoundingClientRect = () => ({ width: 400, height: 134 });
    for (const resize of resizes) resize();
    expect(target.ctx.setTransform).not.toHaveBeenCalled(); expect(trackTarget.ctx.setTransform).not.toHaveBeenCalled();
    expect(frames.size).toBe(0); chart.destroy(); track.destroy();
  });

  it('does not repaint when viewport updates keep a chart visible', () => {
    const target = canvas(), trackTarget = canvas();
    const track = new TrackChart(trackTarget as unknown as HTMLCanvasElement);
    const chart = new StreamChart(target as unknown as HTMLCanvasElement, () => {}, p => track.progress(p), reordered => track.indexed(reordered));
    chart.begin(view()); track.begin(chart.batches, chart.order);
    const input = batch(100); chart.append(input); track.append(input); settle();
    target.ctx.lineTo.mockClear(); trackTarget.ctx.lineTo.mockClear();
    for (let i = 0; i < 10; i++) { chart.setVisible(true); track.setVisible(true); }
    expect(frames.size).toBe(0); expect(chart.isSettled).toBe(true); expect(track.isSettled).toBe(true);
    expect(target.ctx.lineTo).not.toHaveBeenCalled(); expect(trackTarget.ctx.lineTo).not.toHaveBeenCalled();
    chart.destroy(); track.destroy();
  });

  it('retains a stopped result but releases every producer owner and bitmap when destroyed', () => {
    const target = canvas(), trackTarget = canvas();
    const track = new TrackChart(trackTarget as unknown as HTMLCanvasElement);
    const chart = new StreamChart(target as unknown as HTMLCanvasElement, () => {}, p => track.progress(p), reordered => track.indexed(reordered));
    chart.begin(view()); track.begin(chart.batches, chart.order);
    const input = batch(6000); chart.append(input); track.append(input); frame(); frame();
    chart.stop(); track.stop();
    expect(chart.batches[0]).toBe(input); expect(chart.order.series.size).toBe(1);
    expect(Reflect.get(chart, 'firstBatch')).toBe(input); expect(Reflect.get(track, 'firstBatch')).toBe(input);
    chart.destroy(); track.destroy(); settle();
    expect(chart.batches).toHaveLength(0); expect(chart.order.series.size).toBe(0);
    for (const key of ['firstBatch', 'view', 'sorting']) expect(Reflect.get(chart, key)).toBeUndefined();
    for (const key of ['firstBatch', 'order']) expect(Reflect.get(track, key)).toBeUndefined();
    expect(Reflect.get(track, 'batches')).toHaveLength(0);
    for (const renderer of [chart, track]) expect(Reflect.get(renderer, 'cursors').size).toBe(0);
    for (const surface of [target, trackTarget, ...overlays]) { expect(surface.width).toBe(0); expect(surface.height).toBe(0); }
    expect(input.x).toHaveLength(6000); // shared buffers owned by another card are untouched
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
