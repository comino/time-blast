/** render-bench.html: legacy Canvas2D StreamChart vs the Rust/Wasm renderer (WebGPU, WebGL2)
 * on identical synthetic Arrow batches, plus data-path micro-measurements and the functional
 * view/fencing harness used by tests/render_views.py. Results land in `window.__bench` /
 * `window.__views`. Runs on the main thread (the legacy chart needs DOM); the renderer runs
 * on transferred OffscreenCanvases exactly as in the engine worker. */
import { Dictionary, Float64, Int32, makeData, makeVector, Table, TimestampMicrosecond, Utf8, vectorFromArray, type RecordBatch } from 'apache-arrow';
import type { AxisTicks, EngineToUi, LocalFrame, ViewName } from './engine/contracts';
import { createRenderer, type Renderer } from './engine/render';
import type { BackendKind } from './engine/render/backend';
import { header, Kind, type Frame } from './protocol/frame';
import { StreamChart } from './ui/chart';
import type { ColumnBatch, QueryView } from './core/types';

const VESSELS = ['Aurora', 'Borealis', 'Calypso', 'Discovery', 'Endeavour', 'Fjord'];
const START = Date.UTC(2026, 0, 1);
const BATCH_ROWS = 2048; // DuckDB vector size
const out = document.getElementById('out')!;
const grid = document.getElementById('grid')!;
const log = (value: unknown) => { out.textContent = JSON.stringify(value, null, 1); };

// ───────────────────────── data ─────────────────────────

/** `points` rows: minute timestamps, 6 interleaved series, a smooth signal with noise. */
function dataset(points: number, series = VESSELS.length): RecordBatch[] {
  const batches: RecordBatch[] = [];
  for (let from = 0; from < points; from += BATCH_ROWS) {
    const rows = Math.min(BATCH_ROWS, points - from);
    const ts = new BigInt64Array(rows), value = new Float64Array(rows), vessel: string[] = [];
    for (let k = 0; k < rows; k++) {
      const i = from + k, s = i % series, minute = Math.floor(i / series);
      ts[k] = BigInt(START + minute * 60_000) * 1000n;
      vessel.push(VESSELS[s]);
      value[k] = 12 + s * 1.5 + 4 * Math.sin(minute / 90 + s) + Math.sin(i * 12.9898) * 0.15;
    }
    batches.push(new Table({
      ts: makeVector(makeData({ type: new TimestampMicrosecond(), length: rows, data: ts })),
      vessel: vectorFromArray(vessel, new Dictionary(new Utf8(), new Int32())),
      value: makeVector(makeData({ type: new Float64(), length: rows, data: value })),
    }).batches[0]);
  }
  return batches;
}

/** The legacy adapter's ColumnBatch (conversion done before timing; it belongs to the old adapter). */
function legacyBatches(batches: RecordBatch[]): ColumnBatch[] {
  return batches.map(b => {
    const ts = b.getChildAt(0)!.data[0].values as BigInt64Array, n = b.numRows;
    const x = new Float64Array(n), series = new Int32Array(n);
    const dict = b.getChildAt(1)!.data[0];
    const idx = dict.values as Int32Array, names = dict.dictionary!.toArray() as string[];
    for (let i = 0; i < n; i++) { x[i] = Number(ts[i] / 1000n); series[i] = VESSELS.indexOf(names[idx[i]]); }
    const y = b.getChildAt(2)!.data[0].values as Float64Array;
    return { x, y: y.subarray(0, n), series, length: n, byteLength: n * 20 };
  });
}

// ───────────────────────── helpers ─────────────────────────

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return { n: s.length, median: r(q(0.5)), p95: r(q(0.95)), min: r(s[0]), max: r(s[s.length - 1]) };
};
const frameTick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const bindFrame = (slot: number, request: number, epoch = 0): LocalFrame => ({ ...header(Kind.BIND, { request, revision: request, epoch }), stamps: [], payload: u32(slot) });
const schemaFrame = (request: number, b: RecordBatch): LocalFrame => ({ ...header(Kind.RESULT_SCHEMA, { request }), stamps: [], payload: b.schema });
const batchFrame = (request: number, b: RecordBatch): LocalFrame => ({ ...header(Kind.BATCH, { request }), stamps: [], payload: b });
const doneFrame = (request: number): LocalFrame => ({ ...header(Kind.DONE, { request }), stamps: [], payload: new Uint8Array(16) });

interface Card { figure: HTMLElement; plot: HTMLElement; canvas: HTMLCanvasElement; labels: HTMLElement }
function card(title: string, id: string): Card {
  const figure = document.createElement('figure');
  figure.dataset.card = id;
  figure.innerHTML = `<figcaption>${title}</figcaption><div class="plot"><canvas></canvas><div class="labels"></div></div>`;
  grid.append(figure);
  const plot = figure.querySelector<HTMLElement>('.plot')!;
  return { figure, plot, canvas: figure.querySelector('canvas')!, labels: figure.querySelector<HTMLElement>('.labels')! };
}

/** DOM labels from AxisTicks, as the UI would draw them. */
function drawLabels(c: Card, t: AxisTicks): void {
  c.labels.textContent = '';
  for (const x of t.x) { const s = document.createElement('span'); s.textContent = x.label; s.style.left = `${x.at}px`; s.style.top = `${t.plot.top + t.plot.height + 6}px`; s.style.transform = 'translateX(-50%)'; c.labels.append(s); }
  for (const y of t.y) { const s = document.createElement('span'); s.textContent = y.label; s.style.left = `${t.plot.left - 6}px`; s.style.top = `${y.at}px`; s.style.transform = 'translate(-100%,-50%)'; c.labels.append(s); }
}

interface Harness { renderer: Renderer; frames: Frame[]; ui: EngineToUi[]; cards: Map<number, Card> }
async function harness(backend: BackendKind): Promise<Harness> {
  const frames: Frame[] = [], ui: EngineToUi[] = [], cards = new Map<number, Card>();
  const renderer = await createRenderer(f => frames.push(f as Frame), m => {
    ui.push(m);
    if (m.type === 'axes') { const c = cards.get(m.slot); if (c) drawLabels(c, m.ticks); }
  }, { backend });
  return { renderer, frames, ui, cards };
}
function attach(h: Harness, slot: number, title: string): Card {
  const c = card(title, `${h.renderer.backend.kind}-${slot}`);
  h.cards.set(slot, c);
  const box = c.plot.getBoundingClientRect();
  h.renderer.attach(slot, c.canvas.transferControlToOffscreen(), { width: box.width, height: box.height, devicePixelRatio: devicePixelRatio || 1 });
  return c;
}

// ───────────────────────── bench: new renderer ─────────────────────────

let nextRequest = 1;
async function benchRenderer(h: Harness, slot: number, batches: RecordBatch[], reps: number) {
  const r = h.renderer;
  const first: number[] = [], firstIngest: number[] = [], firstBuild: number[] = [], firstReplay: number[] = [];
  const append: number[] = [], appendFrame: number[] = [], redraw: number[] = [], redrawGpu: number[] = [], rebuild: number[] = [], total: number[] = [];
  for (let rep = 0; rep < reps; rep++) {
    const request = nextRequest++;
    await frameTick();
    r.handle(bindFrame(slot, request));
    r.handle(schemaFrame(request, batches[0]));
    const t0 = performance.now();
    r.handle(batchFrame(request, batches[0]));
    const timing = r.timing(request)!;
    // RENDER_FIRST_BATCH → FIRST_DRAW_SUBMITTED, from the DRAWN stamps.
    const stamps = h.frames.filter(f => f.kind === Kind.DRAWN && f.request === request)[0].stamps;
    first.push(stamps[1].at - stamps[0].at);
    firstIngest.push(timing.ingest ?? NaN); firstBuild.push(timing.build ?? NaN); firstReplay.push(timing.replay ?? NaN);
    for (let k = 1; k < batches.length; k++) {
      const a = performance.now();
      r.handle(batchFrame(request, batches[k]));
      append.push(performance.now() - a);
      const f = performance.now();
      r.frame(false);
      appendFrame.push(performance.now() - f);
    }
    r.handle(doneFrame(request));
    r.frame(false);
    total.push(performance.now() - t0);
    await r.backend.presented();
    // Full redraw of every point: a same-size resize forces a full frame (geometry stays on the GPU).
    const box = h.cards.get(slot)!.plot.getBoundingClientRect();
    const d = performance.now();
    r.resize(slot, { width: box.width, height: box.height, devicePixelRatio: devicePixelRatio || 1 });
    redraw.push(performance.now() - d);
    await r.backend.presented();
    redrawGpu.push(performance.now() - d);
    // Full rebuild: switch geometry (scatter) and back; re-ingest + full upload.
    const b = performance.now();
    r.setView(slot, 'scatter'); r.frame(false);
    r.setView(slot, null); r.frame(false);
    rebuild.push((performance.now() - b) / 2);
  }
  return {
    batchToFirstDrawSubmittedMs: stats(first), firstIngestMs: stats(firstIngest), firstBuildMs: stats(firstBuild), firstReplaySubmitMs: stats(firstReplay),
    appendIngestMs: stats(append), appendFrameMs: stats(appendFrame), allBatchesMs: stats(total),
    fullRedrawCpuMs: stats(redraw), fullRedrawGpuDoneMs: stats(redrawGpu), fullRebuildMs: stats(rebuild),
    lastFrame: { ...r.metrics.lastFrame },
  };
}

// ───────────────────────── bench: legacy Canvas2D ─────────────────────────

async function benchLegacy(batches: ColumnBatch[], points: number, reps: number) {
  const c = card(`legacy Canvas2D StreamChart · ${points} points`, `legacy-${points}`);
  let drewAt = 0, settledAt = 0;
  let settled: () => void = () => {};
  const chart = new StreamChart(c.canvas, (_id, at) => { drewAt = at; }, () => {}, () => {}, (_id, s) => { if (s) { settledAt = performance.now(); settled(); } });
  const view = {
    id: 'bench', prompt: '', revision: 1, sql: '', source: 'template', timing: {},
    plan: { metric: 'speed', aggregate: 'avg', bucketMinutes: 1, windowHours: points / VESSELS.length / 60, splitByVessel: true, vessel: null, view: 'line' },
    context: { id: 'bench', label: 'bench', rowCount: points, start: START, end: START + points / VESSELS.length * 60_000, vessels: VESSELS, description: '' },
  } as unknown as QueryView;
  const first: number[] = [], append: number[] = [], total: number[] = [], redraw: number[] = [];
  for (let rep = 0; rep < reps; rep++) {
    await frameTick();
    chart.begin(view);
    const done = new Promise<void>(resolve => { settled = resolve; });
    const t0 = performance.now();
    chart.append(batches[0]);
    first.push(drewAt - t0);
    for (let k = 1; k < batches.length; k++) { const a = performance.now(); chart.append(batches[k]); append.push(performance.now() - a); }
    await done;
    total.push(settledAt - t0);
    const again = new Promise<void>(resolve => { settled = resolve; });
    const d = performance.now();
    chart.setRepresentation('scatter');
    await again;
    redraw.push(settledAt - d);
    chart.setRepresentation('line');
    await new Promise<void>(resolve => { settled = resolve; });
  }
  chart.stop();
  return { batchToFirstDrawMs: stats(first), appendMs: stats(append), allBatchesDrawnMs: stats(total), fullRedrawMs: stats(redraw),
    note: 'Canvas2D work runs in 4 ms slices per animation frame (FrameWork); totals are wall time including frame pacing.' };
}

// ───────────────────────── data-path micro-measurements ─────────────────────────

/** Per-call ms; each sample averages `inner` calls so timer granularity doesn't dominate. */
function time(reps: number, fn: () => void, inner = 20): ReturnType<typeof stats> {
  const xs: number[] = [];
  for (let i = 0; i < 3; i++) fn();
  for (let i = 0; i < reps; i++) { const t = performance.now(); for (let k = 0; k < inner; k++) fn(); xs.push((performance.now() - t) / inner); }
  return stats(xs);
}

async function microBench(h: Harness, batches: RecordBatch[]) {
  const core = h.renderer.core, n = batches.reduce((s, b) => s + b.numRows, 0);
  const column = new Float64Array(n);
  let at = 0;
  for (const b of batches) { column.set((b.getChildAt(2)!.data[0].values as Float64Array).subarray(0, b.numRows), at); at += b.numRows; }
  const src = new Uint8Array(column.buffer);
  const ptr = core.x.tb_staging(src.byteLength + 16);
  const result: Record<string, unknown> = { rows: n, bytes: src.byteLength };
  result.copyColumnIntoWasm = time(50, () => core.u8.set(src, ptr));
  core.u8.set(src, ptr);
  result.rustConvertF64toRelativeF32 = time(50, () => core.x.tb_bench_convert(n));
  result.rustMinMaxScalar = time(50, () => core.x.tb_bench_minmax(n, 0));
  result.rustMinMaxSimd128 = time(50, () => core.x.tb_bench_minmax(n, 1));
  const f32 = new Float32Array(n);
  result.jsFloat32SetFromFloat64 = time(50, () => f32.set(column));
  const gpu = (navigator as any).gpu;
  if (gpu) {
    const adapter = await gpu.requestAdapter(), device = await adapter.requestDevice();
    const vertex = device.createBuffer({ size: src.byteLength, usage: 0x20 | 0x08 | 0x04 });
    const read = device.createBuffer({ size: 16, usage: 0x01 | 0x08 });
    // Upload the raw Arrow f64 column straight from its ArrayBuffer (alternative a: no Wasm hop).
    result.webgpuWriteBufferRawArrowF64 = time(30, () => device.queue.writeBuffer(vertex, 0, column.buffer, 0, src.byteLength), 1);
    const done: number[] = [];
    for (let i = 0; i < 20; i++) { const t = performance.now(); device.queue.writeBuffer(vertex, 0, column.buffer, 0, src.byteLength); await device.queue.onSubmittedWorkDone(); done.push(performance.now() - t); }
    result.webgpuUploadUntilDoneMs = stats(done);
    // Lower bound for GPU-computed stats the CPU needs (axis labels): copy 16 bytes + mapAsync.
    const trips: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(vertex, 0, read, 0, 16); device.queue.submit([enc.finish()]);
      await read.mapAsync(1); read.getMappedRange(); read.unmap();
      trips.push(performance.now() - t);
    }
    result.webgpuReadbackRoundTripMs = stats(trips);
    device.destroy();
  }
  return result;
}

async function rafInWorker(): Promise<string> {
  const source = `postMessage(typeof requestAnimationFrame === 'function' ? 'requestAnimationFrame' : 'absent')`;
  const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
  const answer = await new Promise<string>(resolve => { worker.onmessage = e => resolve(e.data); });
  worker.terminate();
  return answer;
}

// ───────────────────────── modes ─────────────────────────

async function bench(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const sizes = (params.get('points') ?? '8640,60480').split(',').map(Number);
  const reps = Number(params.get('reps') ?? 7);
  const wasm = await fetch(`${import.meta.env.BASE_URL}wasm/tb-render.wasm`).then(r => r.arrayBuffer());
  const results: Record<string, unknown> = {
    userAgent: navigator.userAgent, devicePixelRatio, crossOriginIsolated, reps, batchRows: BATCH_ROWS, series: VESSELS.length,
    wasmBytes: wasm.byteLength, workerRequestAnimationFrame: await rafInWorker(), runs: {} as Record<string, unknown>,
  };
  const runs = results.runs as Record<string, unknown>;
  const backends: BackendKind[] = [];
  for (const kind of ['webgpu', 'webgl2'] as BackendKind[]) {
    try { const h = await harness(kind); backends.push(kind); (results as any)[`${kind}Label`] = h.renderer.backend.label; } catch (error) { runs[`${kind}Unavailable`] = String(error); }
  }
  for (const points of sizes) {
    const batches = dataset(points);
    runs[`legacy-canvas2d-${points}`] = await benchLegacy(legacyBatches(batches), points, reps);
    log(results);
    for (const kind of backends) {
      const h = await harness(kind);
      attach(h, 1, `${kind} · ${points} points`);
      await frameTick();
      const memoryBefore = h.renderer.core.x.memory.buffer.byteLength;
      runs[`${kind}-${points}`] = { ...await benchRenderer(h, 1, batches, reps), wasmMemoryBytesBefore: memoryBefore, wasmMemoryBytesAfter: h.renderer.core.x.memory.buffer.byteLength };
      log(results);
    }
  }
  const h = await harness(backends.includes('webgpu') ? 'webgpu' : 'null');
  results.dataPath = await microBench(h, dataset(Math.max(...sizes)));
  results.jsHeapBytes = (performance as any).memory?.usedJSHeapSize ?? null;
  (window as any).__bench = results;
  log(results);
}

/** Functional harness: one slot per wave-1 view, plus a fencing slot. */
async function views(): Promise<void> {
  const backend = (new URLSearchParams(location.search).get('backend') ?? 'webgpu') as BackendKind;
  const h = await harness(backend);
  const data = dataset(6 * 720), hourly = dataset(6 * 24);
  const wanted: ViewName[] = ['line', 'bar', 'scatter', 'table'];
  wanted.forEach((view, i) => attach(h, i + 1, `${backend} · ${view}`));
  attach(h, 9, `${backend} · fencing`);
  await frameTick();
  const summary: Record<string, unknown> = { backend: h.renderer.backend.kind, label: h.renderer.backend.label };
  for (const [i, view] of wanted.entries()) {
    const slot = i + 1, request = nextRequest++;
    h.renderer.setView(slot, view);
    h.renderer.handle(bindFrame(slot, request));
    const batches = view === 'bar' ? hourly : data; // bars read best with fewer, wider buckets
    h.renderer.handle(schemaFrame(request, batches[0]));
    for (const b of batches) h.renderer.handle(batchFrame(request, b));
    h.renderer.handle(doneFrame(request));
  }
  await frameTick(); await h.renderer.backend.presented(); await frameTick();
  summary.drawn = h.frames.filter(f => f.kind === Kind.DRAWN && f.stamps.some(s => s.stage === 16)).map(f => f.request);
  summary.views = h.ui.filter(m => m.type === 'views').map(m => (m as any).chosen);
  // Fencing: A draws; B binds; stale A batches must not draw; B's first batch replaces A.
  const A = nextRequest++, B = nextRequest++;
  const r = h.renderer;
  r.handle(bindFrame(9, A)); r.handle(schemaFrame(A, data[0])); r.handle(batchFrame(A, data[0]));
  await frameTick(); await r.backend.presented();
  r.handle(bindFrame(9, B)); r.handle(schemaFrame(B, data[1]));
  const passesBefore = r.metrics.frames;
  r.handle(batchFrame(A, data[1])); r.handle(batchFrame(A, data[2]));
  await frameTick(); await frameTick();
  summary.fencing = {
    staleBatchesFramed: r.metrics.frames - passesBefore,
    drawnForA: h.frames.filter(f => f.kind === Kind.DRAWN && f.request === A && f.stamps.some(s => s.stage === 16)).length,
  };
  (window as any).__fencing = {
    /** Called by the test after its "before" screenshot. */
    drawB: async () => { r.handle(batchFrame(B, data[1])); await frameTick(); await r.backend.presented(); await frameTick();
      return h.frames.filter(f => f.kind === Kind.DRAWN && f.request === B && f.stamps.some(s => s.stage === 16)).length; },
  };
  (window as any).__views = summary;
  log(summary);
}

const mode = new URLSearchParams(location.search).get('mode') ?? 'bench';
(mode === 'views' ? views() : bench()).catch(error => { (window as any).__error = String(error?.stack ?? error); log({ error: String(error?.stack ?? error) }); });
