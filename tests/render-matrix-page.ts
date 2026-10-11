/** tests/render-matrix.html: heatmap and surface on the Rust/Wasm renderer (WebGPU or WebGL2).
 * `?mode=views` renders each case for tests/render_matrix.py (results in `window.__views`);
 * `?mode=bench` times first draw and per-batch appends (results in `window.__bench`). */
import { Dictionary, Float64, Int32, makeData, makeVector, Table, TimestampMicrosecond, Utf8, vectorFromArray, type RecordBatch } from 'apache-arrow';
import type { AxisTicks, EngineToUi, LocalFrame, ViewName } from '../src/engine/contracts';
import { createRenderer, type Renderer } from '../src/engine/render';
import type { BackendKind } from '../src/engine/render/backend';
import { header, Kind, Stage, type Frame } from '../src/protocol/frame';

const START = Date.UTC(2026, 0, 1);
const BATCH_ROWS = 2048; // DuckDB vector size
const out = document.getElementById('out')!;
const grid = document.getElementById('grid')!;
const log = (value: unknown) => { out.textContent = JSON.stringify(value, null, 1); };

// ───────────────────────── data ─────────────────────────

/** `series` × `buckets` minute buckets, ORDER BY ts, series; one NULL per 97 rows. */
function matrixData(series: number, buckets: number): RecordBatch[] {
  const names = Array.from({ length: series }, (_, s) => `station-${String(s).padStart(2, '0')}`);
  const total = series * buckets, batches: RecordBatch[] = [];
  for (let from = 0; from < total; from += BATCH_ROWS) {
    const rows = Math.min(BATCH_ROWS, total - from);
    const ts = new BigInt64Array(rows), value = new Float64Array(rows), name: string[] = [];
    const nulls = new Uint8Array(Math.ceil(rows / 8)).fill(0xff);
    let nullCount = 0;
    for (let k = 0; k < rows; k++) {
      const i = from + k, s = i % series, minute = Math.floor(i / series);
      ts[k] = BigInt(START + minute * 60_000) * 1000n;
      name.push(names[s]);
      value[k] = 10 + 6 * Math.sin(minute / 120 + s * 0.7) + s * 0.3 + Math.sin(i * 12.9898) * 0.4;
      if (i % 97 === 50) { nulls[k >> 3] &= ~(1 << (k & 7)); nullCount++; }
    }
    batches.push(new Table({
      ts: makeVector(makeData({ type: new TimestampMicrosecond(), length: rows, data: ts })),
      station: vectorFromArray(name, new Dictionary(new Utf8(), new Int32())),
      value: makeVector(makeData({ type: new Float64(), length: rows, data: value, nullBitmap: nulls, nullCount })),
    }).batches[0]);
  }
  return batches;
}

/** weekday × site × value: a two-category heatmap. */
function categoryData(): RecordBatch[] {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], sites = ['north', 'east', 'south', 'west', 'harbour'];
  const weekday: string[] = [], site: string[] = [], v: number[] = [];
  for (const [d, day] of days.entries()) for (const [s, name] of sites.entries()) { weekday.push(day); site.push(name); v.push(d * 3 + s * 5 + (d === 5 ? 20 : 0)); }
  return [new Table({
    weekday: vectorFromArray(weekday, new Utf8()),
    site: vectorFromArray(site, new Utf8()),
    visits: makeVector(makeData({ type: new Float64(), length: v.length, data: Float64Array.from(v) })),
  }).batches[0]];
}

// ───────────────────────── harness ─────────────────────────

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return { n: s.length, median: r(q(0.5)), p95: r(q(0.95)), min: r(s[0]), max: r(s[s.length - 1]) };
};
const frameTick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const bindFrame = (slot: number, request: number): LocalFrame => ({ ...header(Kind.BIND, { request, revision: request, epoch: 0 }), stamps: [], payload: u32(slot) });
const schemaFrame = (request: number, b: RecordBatch): LocalFrame => ({ ...header(Kind.RESULT_SCHEMA, { request }), stamps: [], payload: b.schema });
const batchFrame = (request: number, b: RecordBatch): LocalFrame => ({ ...header(Kind.BATCH, { request }), stamps: [], payload: b });
const doneFrame = (request: number): LocalFrame => ({ ...header(Kind.DONE, { request }), stamps: [], payload: new Uint8Array(16) });

interface Card { plot: HTMLElement; canvas: HTMLCanvasElement; labels: HTMLElement; legend: HTMLElement }
function card(title: string, id: string): Card {
  const figure = document.createElement('figure');
  figure.dataset.card = id;
  figure.innerHTML = `<figcaption>${title}</figcaption><div class="plot"><canvas></canvas><div class="labels"></div></div><div class="legend"></div>`;
  grid.append(figure);
  return { plot: figure.querySelector<HTMLElement>('.plot')!, canvas: figure.querySelector('canvas')!,
    labels: figure.querySelector<HTMLElement>('.labels')!, legend: figure.querySelector<HTMLElement>('.legend')! };
}

/** DOM labels and legend from AxisTicks, as the UI would draw them. */
function drawLabels(c: Card, t: AxisTicks): void {
  c.labels.textContent = '';
  for (const x of t.x) { const s = document.createElement('span'); s.textContent = x.label; s.style.left = `${x.at}px`; s.style.top = `${t.plot.top + t.plot.height + 6}px`; s.style.transform = 'translateX(-50%)'; c.labels.append(s); }
  for (const y of t.y) { const s = document.createElement('span'); s.textContent = y.label; s.style.left = `${t.plot.left - 6}px`; s.style.top = `${y.at}px`; s.style.transform = 'translate(-100%,-50%)'; c.labels.append(s); }
  c.legend.innerHTML = (t.legend ?? []).map(l => `<span><i style="background:${l.color}"></i>${l.label}</span>`).join('');
}

interface Harness { renderer: Renderer; frames: Frame[]; ui: EngineToUi[]; cards: Map<number, Card>; axes: Map<number, AxisTicks> }
async function harness(backend: BackendKind): Promise<Harness> {
  const frames: Frame[] = [], ui: EngineToUi[] = [], cards = new Map<number, Card>(), axes = new Map<number, AxisTicks>();
  const renderer = await createRenderer(f => frames.push(f as Frame), m => {
    ui.push(m);
    if (m.type === 'axes') { axes.set(m.slot, m.ticks); const c = cards.get(m.slot); if (c) drawLabels(c, m.ticks); }
  }, { backend });
  return { renderer, frames, ui, cards, axes };
}
function attach(h: Harness, slot: number, title: string): Card {
  const c = card(title, `${h.renderer.backend.kind}-${slot}`);
  h.cards.set(slot, c);
  const box = c.plot.getBoundingClientRect();
  h.renderer.attach(slot, c.canvas.transferControlToOffscreen(), { width: box.width, height: box.height, devicePixelRatio: devicePixelRatio || 1 });
  return c;
}
const firstDrawn = (h: Harness, request: number) => h.frames.find(f => f.kind === Kind.DRAWN && f.request === request && f.stamps.some(s => s.stage === Stage.FIRST_DRAW_SUBMITTED));

let nextRequest = 1;
function run(h: Harness, slot: number, batches: RecordBatch[]): number {
  const request = nextRequest++;
  h.renderer.handle(bindFrame(slot, request));
  h.renderer.handle(schemaFrame(request, batches[0]));
  for (const b of batches) h.renderer.handle(batchFrame(request, b));
  h.renderer.handle(doneFrame(request));
  return request;
}

// ───────────────────────── views (functional check) ─────────────────────────

interface Case { title: string; hint: ViewName | null; data: RecordBatch[]; rotation?: number; expect: ViewName }

async function views(): Promise<void> {
  const backend = (new URLSearchParams(location.search).get('backend') ?? 'webgpu') as BackendKind;
  const h = await harness(backend);
  const six = matrixData(6, 240);
  const cases: Case[] = [
    { title: 'heatmap · 6 series × 240 min', hint: 'heatmap', data: six, expect: 'heatmap' },
    { title: 'surface · 6 series × 240 min', hint: 'surface', data: six, expect: 'surface' },
    { title: 'surface · rotation 120°', hint: 'surface', data: six, rotation: 120, expect: 'surface' },
    { title: 'auto · 20 series → heatmap', hint: null, data: matrixData(20, 90), expect: 'heatmap' },
    { title: 'auto · 6 series → line', hint: null, data: six, expect: 'line' },
    { title: 'heatmap · weekday × site', hint: 'heatmap', data: categoryData(), expect: 'heatmap' },
  ];
  cases.forEach((c, i) => attach(h, i + 1, `${backend} · ${c.title}`));
  await frameTick();
  const results: Array<Record<string, unknown>> = [];
  for (const [i, c] of cases.entries()) {
    const slot = i + 1;
    h.renderer.setView(slot, c.hint);
    if (c.rotation !== undefined) h.renderer.setParam(slot, 'rotation', c.rotation);
    const request = run(h, slot, c.data);
    results.push({ slot, request, title: c.title, expect: c.expect });
  }
  await frameTick(); await h.renderer.backend.presented(); await frameTick();
  for (const r of results) {
    const slot = r.slot as number, chosen = h.ui.filter(m => m.type === 'views' && m.slot === slot).map(m => (m as { chosen: ViewName }).chosen);
    const ticks = h.axes.get(slot);
    Object.assign(r, { chosen: chosen.at(-1), drawn: !!firstDrawn(h, r.request as number),
      ticks: ticks ? { x: ticks.x.length, y: ticks.y.length, legend: ticks.legend?.length ?? 0, legendColors: (ticks.legend ?? []).map(l => l.color) } : null });
  }
  // Rotating a drawn surface redraws from uniforms only. The first turn into "high x farther"
  // builds each lane's reversed copy once; later turns upload only the uniform block.
  h.renderer.setParam(2, 'rotation', 60);
  await frameTick(); await h.renderer.backend.presented();
  const firstTurn = h.renderer.metrics.lastFrame.uploadedBytes;
  const before = h.renderer.metrics.frames;
  h.renderer.setParam(2, 'rotation', 75);
  await frameTick(); await h.renderer.backend.presented();
  const rotate = { frames: h.renderer.metrics.frames - before, uploadedBytes: h.renderer.metrics.lastFrame.uploadedBytes,
    commands: h.renderer.metrics.lastFrame.commands, firstTurnUploadedBytes: firstTurn };
  h.renderer.setParam(2, 'rotation', -30);
  await frameTick(); await h.renderer.backend.presented(); await frameTick();
  const summary = { backend: h.renderer.backend.kind, label: h.renderer.backend.label, cases: results, rotate };
  (window as any).__views = summary;
  log(summary);
}

// ───────────────────────── bench ─────────────────────────

async function benchCase(h: Harness, slot: number, view: ViewName, batches: RecordBatch[], reps: number) {
  const r = h.renderer;
  r.setView(slot, view);
  const first: number[] = [], firstIngest: number[] = [], firstBuild: number[] = [], firstReplay: number[] = [], firstPresented: number[] = [];
  const append: number[] = [], appendFrame: number[] = [], appendUploaded: number[] = [], total: number[] = [], redraw: number[] = [], redrawGpu: number[] = [], rotate: number[] = [], rotateGpu: number[] = [];
  let lastFrame = { ...r.metrics.lastFrame };
  for (let rep = 0; rep < reps; rep++) {
    const request = nextRequest++;
    await frameTick();
    r.handle(bindFrame(slot, request));
    r.handle(schemaFrame(request, batches[0]));
    const t0 = performance.now();
    r.handle(batchFrame(request, batches[0]));
    const timing = r.timing(request)!;
    const stamps = firstDrawn(h, request)!.stamps;
    first.push(stamps[1].at - stamps[0].at);
    firstIngest.push(timing.ingest ?? NaN); firstBuild.push(timing.build ?? NaN); firstReplay.push(timing.replay ?? NaN);
    await r.backend.presented();
    firstPresented.push(performance.now() - t0);
    for (let k = 1; k < batches.length; k++) {
      const a = performance.now();
      r.handle(batchFrame(request, batches[k]));
      append.push(performance.now() - a);
      const f = performance.now();
      r.frame(false);
      appendFrame.push(performance.now() - f);
      appendUploaded.push(r.metrics.lastFrame.uploadedBytes);
    }
    r.handle(doneFrame(request));
    r.frame(false);
    await r.backend.presented();
    total.push(performance.now() - t0);
    lastFrame = { ...r.metrics.lastFrame };
    const box = h.cards.get(slot)!.plot.getBoundingClientRect();
    const d = performance.now();
    r.resize(slot, { width: box.width, height: box.height, devicePixelRatio: devicePixelRatio || 1 });
    redraw.push(performance.now() - d);
    await r.backend.presented();
    redrawGpu.push(performance.now() - d);
    if (view === 'surface') {
      const t = performance.now();
      r.setParam(slot, 'rotation', rep % 2 ? -30 : 40);
      r.frame(false);
      rotate.push(performance.now() - t);
      await r.backend.presented();
      rotateGpu.push(performance.now() - t);
    }
  }
  return {
    rows: batches.reduce((s, b) => s + b.numRows, 0), batches: batches.length,
    batchToFirstDrawSubmittedMs: stats(first), firstIngestMs: stats(firstIngest), firstBuildMs: stats(firstBuild), firstReplaySubmitMs: stats(firstReplay),
    firstBatchToPresentedMs: stats(firstPresented),
    appendIngestMs: stats(append), appendFrameMs: stats(appendFrame), appendUploadedBytes: stats(appendUploaded),
    allBatchesPresentedMs: stats(total), fullRedrawCpuMs: stats(redraw), fullRedrawGpuDoneMs: stats(redrawGpu),
    ...(rotate.length ? { rotateCpuMs: stats(rotate), rotateGpuDoneMs: stats(rotateGpu) } : {}),
    lastFullFrame: lastFrame,
  };
}

async function bench(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const reps = Number(params.get('reps') ?? 5);
  const sizes = (params.get('sizes') ?? '6x1440,50x2000').split(',').map(s => s.split('x').map(Number) as [number, number]);
  const backends = (params.get('backends') ?? 'webgpu,webgl2').split(',') as BackendKind[];
  const results: Record<string, unknown> = { userAgent: navigator.userAgent, devicePixelRatio, crossOriginIsolated, reps, batchRows: BATCH_ROWS, runs: {} };
  const runs = results.runs as Record<string, unknown>;
  for (const kind of backends) {
    let h: Harness;
    try { h = await harness(kind); } catch (error) { runs[`${kind}Unavailable`] = String(error); continue; }
    results[`${kind}Label`] = h.renderer.backend.label;
    attach(h, 1, `${kind} bench`);
    await frameTick();
    for (const [series, buckets] of sizes) {
      const data = matrixData(series, buckets);
      for (const view of ['line', 'heatmap', 'surface'] as ViewName[]) {
        runs[`${kind}-${view}-${series}x${buckets}`] = await benchCase(h, 1, view, data, reps);
        log(results);
      }
    }
  }
  (window as any).__bench = results;
  log(results);
}

const mode = new URLSearchParams(location.search).get('mode') ?? 'views';
(mode === 'bench' ? bench() : views()).catch(error => { (window as any).__error = String(error?.stack ?? error); log({ error: String(error?.stack ?? error) }); });
