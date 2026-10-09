import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColumnBatch, QueryView } from '../src/core/types';
import { GeoRenderer, type GeoMode } from '../src/ui/geo-renderer';
import { ColumnOrder } from '../src/ui/order';

vi.mock('../src/ui/geo-coastline', () => ({ COASTLINE: new Float32Array([-80, 30, -70, 40, -60, 45, NaN, NaN, 10, 45, 20, 50]) }));
let frames: Map<number, FrameRequestCallback>, nextFrame: number, layers: ReturnType<typeof canvas>[], resizes: (() => void)[];
function frame() { const pending = [...frames.values()], at = performance.now(); frames.clear(); for (const callback of pending) callback(at); }
function settle() { for (let i = 0; frames.size && i < 500; i++) frame(); expect(frames.size).toBe(0); }
function canvas() {
  const ctx = { setTransform: vi.fn(), beginPath: vi.fn(), fillRect: vi.fn(), clearRect: vi.fn(), fillText: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(), save: vi.fn(), restore: vi.fn(), rect: vi.fn(), clip: vi.fn() };
  return { width: 0, height: 0, clientWidth: 800, clientHeight: 300, hidden: false, style: { cssText: '', position: '' },
    parentElement: { insertBefore: vi.fn(), append: vi.fn() }, setAttribute: vi.fn(), remove: vi.fn(), getContext: () => ctx,
    getBoundingClientRect: () => ({ width: 1600, height: 600 }), ctx };
}
function batch(n: number, start = 0): ColumnBatch {
  return { x: Float64Array.from({ length: n }, (_, i) => start + i), y: new Float64Array(n).fill(10), series: new Int32Array(n),
    lat: new Float64Array(n).fill(40), lon: Float64Array.from({ length: n }, (_, i) => -60 + (i % 100) / 10), length: n, byteLength: n * 36 };
}
function view(): QueryView {
  return { id: 'geo', prompt: 'map', revision: 1, plan: { metric: 'speed', aggregate: 'avg', bucketMinutes: 1,
    windowHours: 24, splitByVessel: true, vessel: null, view: 'line' }, sql: '', source: 'template',
    context: { id: 'geo', label: 'test', rowCount: 100, start: 0, end: 100, vessels: ['One'], description: 'test' },
    timing: { startedAt: 0, promoted: false, batches: 0, points: 0, bytes: 0 } };
}
function setup(mode: GeoMode = 'map', target = canvas()) {
  const batches: ColumnBatch[] = [], order = new ColumnOrder(batches), draw = vi.fn(), settled = vi.fn();
  const source = { view: view(), batches, order };
  const renderer = new GeoRenderer(target as unknown as HTMLCanvasElement, mode, source, { draw, settled });
  renderer.setVisible(true);
  return { renderer, target, source, draw, settled, append(input: ColumnBatch, index = true) {
    batches.push(input); renderer.append(input); if (index) { order.append(input); renderer.indexed(false); }
  } };
}
beforeEach(() => {
  frames = new Map(); nextFrame = 0; layers = []; resizes = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resizes.push(callback); } observe() {} disconnect() {} });
  vi.stubGlobal('document', { createElement: () => { const layer = canvas(); layers.push(layer); return layer; } });
  vi.stubGlobal('window', { devicePixelRatio: 1 });
});
afterEach(() => vi.unstubAllGlobals());

describe('geographic column renderers', () => {
  it('does not inspect or schedule populated source geometry before activation', () => {
    const target = canvas(), input = batch(100), batches = [input], order = new ColumnOrder(batches), draw = vi.fn();
    const renderer = new GeoRenderer(target as unknown as HTMLCanvasElement, 'map', { view: view(), batches, order }, { draw, settled() {} });
    expect(frames.size).toBe(0); expect(draw).not.toHaveBeenCalled(); expect(target.ctx.arc).not.toHaveBeenCalled();
    renderer.setVisible(false); expect(frames.size).toBe(0);
    renderer.setVisible(true); expect(draw).toHaveBeenCalledOnce(); settle(); renderer.destroy();
  });

  it('draws the first geographic point synchronously and defers bounded bulk geometry', () => {
    const s = setup(), input = batch(10_000); s.append(input, false);
    expect(s.draw).toHaveBeenCalledOnce(); expect(s.target.ctx.arc).toHaveBeenCalledOnce();
    expect(s.source.order.series.size).toBe(0); expect(s.source.batches[0]).toBe(input);
    expect(s.source.batches[0].lat).toBe(input.lat); expect(s.target.width).toBe(800);
    frame(); expect(s.target.ctx.arc).toHaveBeenCalledOnce();
    frame(); expect(s.target.ctx.arc.mock.calls.length).toBeLessThanOrEqual(514);
    expect(s.renderer.isSettled).toBe(false);
    s.renderer.stop(); const count = s.target.ctx.arc.mock.calls.length; settle(); expect(s.target.ctx.arc).toHaveBeenCalledTimes(count);
    s.renderer.destroy();
  });

  it('suppresses hidden geometry and records first draw only after becoming visible', () => {
    const s = setup(); s.renderer.setVisible(false); s.append(batch(100)); settle();
    expect(s.draw).not.toHaveBeenCalled(); expect(s.target.ctx.arc).not.toHaveBeenCalled();
    expect(frames.size).toBe(0); s.renderer.setVisible(true);
    expect(s.draw).toHaveBeenCalledOnce(); settle(); expect(s.renderer.isSettled).toBe(true);
    s.renderer.setVisible(true); expect(frames.size).toBe(0);
    s.renderer.setVisible(false); s.renderer.setVisible(true); settle(); expect(s.draw).toHaveBeenCalledOnce();
    s.renderer.destroy();
  });

  it('counts returned positions into a fixed grid without counting its immediate hint twice', () => {
    const s = setup('density'), input = batch(2000); s.append(input);
    expect(s.draw).toHaveBeenCalledOnce(); expect(s.target.ctx.fillRect).toHaveBeenCalledOnce();
    expect(s.target.ctx.arc).not.toHaveBeenCalled(); settle();
    const counts = Reflect.get(s.renderer, 'density') as Uint32Array;
    expect(counts.length).toBe(96 * 48); expect(counts.reduce((a, b) => a + b, 0)).toBe(2000);
    expect(s.renderer.isSettled).toBe(true); expect(s.source.batches[0]).toBe(input);
    s.renderer.destroy();
  });

  it('labels the fixed logarithmic density scale and its saturation without waiting for bulk rows', () => {
    const s = setup('density'); s.append(batch(6000), false);
    const labels = layers[0].ctx.fillText.mock.calls.map(([text]) => text);
    for (const stop of ['1', '8', '64', '≥511']) expect(labels).toContain(stop);
    expect(labels).toContain('Returned positions / cell · log, color capped ≥511');
    expect(s.source.order.series.size).toBe(0);
    expect((Reflect.get(s.renderer, 'density') as Uint32Array).every(count => count === 0)).toBe(true);
    s.renderer.destroy();
  });

  it('uses valid lon/lat rather than relative sample positions and falls back to the world frame', () => {
    const s = setup(), input = batch(3); input.lon!.set([-60, 170, 0]); input.lat!.set([40, -20, 91]); s.append(input); settle();
    expect(Reflect.get(s.renderer, 'frame')).toEqual({ west: -180, east: 180, south: -90, north: 90 });
    const calls = s.target.ctx.arc.mock.calls;
    const farEast = calls.find(([x, y]) => Math.abs(x - (34 + 350 / 360 * 753)) < 0.001 && Math.abs(y - (16 + 110 / 180 * 258)) < 0.001);
    expect(farEast).toBeDefined(); expect(calls.every(([, y]) => y >= 16 && y <= 274)).toBe(true);
    s.renderer.destroy();
  });

  it('does not fabricate coordinates for missing or invalid geographic columns', () => {
    const s = setup(), missing = batch(3), invalid = batch(3); delete missing.lat; delete missing.lon;
    invalid.lat!.fill(NaN); s.append(missing); s.append(invalid); settle();
    expect(s.draw).not.toHaveBeenCalled(); expect(s.target.ctx.arc).not.toHaveBeenCalled();
    expect(s.renderer.isSettled).toBe(true); s.renderer.destroy();
  });

  it('draws tracks from shared sorted references and does no scan in the playback handler', () => {
    const s = setup('tracks'), input = batch(101); s.append(input); settle();
    expect(s.target.ctx.lineTo).toHaveBeenCalledTimes(100);
    const refs = s.source.order.series.get(0)!.refs; s.target.ctx.lineTo.mockClear(); s.target.ctx.clearRect.mockClear();
    s.renderer.setTimeFraction(0.5);
    expect(s.target.ctx.lineTo).not.toHaveBeenCalled(); expect(s.target.ctx.clearRect).not.toHaveBeenCalled();
    settle(); expect(s.target.ctx.lineTo).toHaveBeenCalledTimes(50); expect(s.source.order.series.get(0)!.refs).toBe(refs);
    const head = layers[1].ctx.arc.mock.calls.at(-1)!;
    expect(head[0]).toBeCloseTo(34 + 40 / 120 * 753); // longitude -55 at t=50
    expect(head[2]).toBe(3.5);
    expect(s.source.batches[0]).toBe(input); expect(s.draw).toHaveBeenCalledOnce(); s.renderer.destroy();
  });

  it('waits without polling while shared track references need sorting', () => {
    const s = setup('tracks'), input = batch(20); input.x.reverse(); s.append(input); settle();
    expect(s.source.order.needsSort).toBe(true); expect(s.target.ctx.lineTo).not.toHaveBeenCalled();
    expect(s.renderer.isSettled).toBe(false); expect(frames.size).toBe(0);
    s.source.order.sort(); s.renderer.indexed(true); settle();
    expect(s.target.ctx.lineTo).toHaveBeenCalledTimes(19); expect(s.renderer.isSettled).toBe(true); s.renderer.destroy();
  });

  it('paints all 60,480 trajectory samples with one current endpoint per vessel', () => {
    const s = setup('tracks'), input = batch(60_480);
    s.source.view.context.end = 10_080; s.source.view.context.vessels = ['A', 'B', 'C', 'D', 'E', 'F'];
    for (let i = 0; i < input.length; i++) { input.series[i] = i % 6; input.x[i] = Math.floor(i / 6); }
    s.append(input); settle();
    expect(s.target.ctx.lineTo).toHaveBeenCalledTimes(6 * 10_079);
    const headCtx = layers[1].ctx;
    const lastClear = headCtx.clearRect.mock.invocationCallOrder.at(-1)!;
    expect(headCtx.arc.mock.invocationCallOrder.filter(at => at > lastClear)).toHaveLength(6);
    expect(s.renderer.isSettled).toBe(true); s.renderer.destroy();
    expect(layers[1].width).toBe(0); expect(layers[1].height).toBe(0); expect(layers[1].remove).toHaveBeenCalledOnce();
  });

  it('breaks tracks at invalid coordinates and the antimeridian', () => {
    const s = setup('tracks'), input = batch(5); input.lon!.set([175, 179, -179, -175, -170]); input.lat!.fill(0); input.lat![3] = NaN;
    s.append(input); settle(); expect(s.target.ctx.lineTo).toHaveBeenCalledTimes(1); s.renderer.destroy();
  });

  it('submits a deferred first mark when resize makes a zero-size canvas drawable', () => {
    const target = canvas(); target.clientWidth = 0; target.clientHeight = 0;
    const s = setup('map', target); s.append(batch(2)); settle(); expect(s.draw).not.toHaveBeenCalled();
    target.clientWidth = 800; target.clientHeight = 300; resizes[0]();
    expect(s.draw).toHaveBeenCalledOnce(); settle(); s.renderer.destroy();
  });

  it('keeps producer arrays alive when stopped and releases references and bitmaps on destruction', () => {
    const s = setup(), input = batch(2000); s.append(input); s.renderer.stop(); settle();
    expect(Reflect.get(s.renderer, 'source')).toBe(s.source); expect(Reflect.get(s.renderer, 'firstBatch')).toBe(input);
    s.renderer.destroy(); expect(Reflect.get(s.renderer, 'source')).toBeUndefined(); expect(Reflect.get(s.renderer, 'firstBatch')).toBeUndefined();
    expect(s.target.width).toBe(0); expect(s.target.height).toBe(0); expect(layers[0].width).toBe(0); expect(layers[0].remove).toHaveBeenCalledOnce();
    expect(input.lon).toHaveLength(2000); expect(s.source.batches[0]).toBe(input);
    s.renderer.append(input); s.renderer.indexed(true); s.renderer.setVisible(true); settle(); expect(s.draw).toHaveBeenCalledOnce();
  });
});
