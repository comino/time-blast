// Page side of tests/render_geo.py: the geo views (map, density, tracks) through the real
// RendererNode on transferred OffscreenCanvases, plus first-draw / per-batch timings.
// `?backend=webgpu|webgl2`, `?reps=N`. Result in `window.__geo`.
import { Dictionary, Float64, Int32, makeData, makeVector, Table, TimestampMicrosecond, Utf8, vectorFromArray, type RecordBatch } from 'apache-arrow';
import type { EngineToUi, LocalFrame, ViewName } from '../src/engine/contracts';
import { createRenderer } from '../src/engine/render';
import type { BackendKind } from '../src/engine/render/backend';
import { header, Kind, type Frame } from '../src/protocol/frame';

const BATCH_ROWS = 2048;
const params = new URLSearchParams(location.search);
const backend = (params.get('backend') ?? 'webgpu') as BackendKind;
const reps = Number(params.get('reps') ?? 5);
const page = window as unknown as { __geo?: unknown; __playback?: (p: number) => Promise<void> };

function rng(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const f64 = (a: Float64Array) => makeVector(makeData({ type: new Float64(), length: a.length, data: a }));

/** `tracks × perTrack` positions: random walks in the North Sea, rows interleaved in time order. */
function voyages(tracks: number, perTrack: number): RecordBatch[] {
  const rand = rng(7), names = Array.from({ length: tracks }, (_, i) => `vessel-${i + 1}`);
  const state = names.map((_, i) => ({ lat: 53.6 + i * 0.45, lon: 3 + i * 0.6, heading: rand() * Math.PI * 2 }));
  const n = tracks * perTrack, start = Date.UTC(2026, 0, 1);
  const out: RecordBatch[] = [];
  for (let from = 0; from < n; from += BATCH_ROWS) {
    const rows = Math.min(BATCH_ROWS, n - from);
    const ts = new BigInt64Array(rows), lat = new Float64Array(rows), lon = new Float64Array(rows), speed = new Float64Array(rows), vessel: string[] = [];
    for (let k = 0; k < rows; k++) {
      const i = from + k, s = i % tracks, step = Math.floor(i / tracks), v = state[s];
      v.heading += (rand() - 0.5) * 0.35;
      v.lat += Math.sin(v.heading) * 0.004; v.lon += Math.cos(v.heading) * 0.0065;
      ts[k] = BigInt(start + step * 60_000) * 1000n; lat[k] = v.lat; lon[k] = v.lon; vessel.push(names[s]);
      speed[k] = 8 + 6 * Math.sin(step / 200 + s) + rand();
    }
    out.push(new Table({
      ts: makeVector(makeData({ type: new TimestampMicrosecond(), length: rows, data: ts })),
      vessel: vectorFromArray(vessel, new Dictionary(new Utf8(), new Int32())),
      lat: f64(lat), lon: f64(lon), speed: f64(speed),
    }).batches[0]);
  }
  return out;
}

/** `n` raw positions: clustered ports plus shipping lanes (density input), `lat, lon` only. */
function positions(n: number): RecordBatch[] {
  const rand = rng(11), gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const ports = [[53.55, 9.95], [51.95, 4.1], [57.7, 11.9], [55.7, 12.6], [51.3, 3.2], [59.9, 10.7]];
  const out: RecordBatch[] = [];
  for (let from = 0; from < n; from += BATCH_ROWS) {
    const rows = Math.min(BATCH_ROWS, n - from);
    const lat = new Float64Array(rows), lon = new Float64Array(rows);
    for (let k = 0; k < rows; k++) {
      const a = ports[Math.floor(rand() * ports.length)], b = ports[Math.floor(rand() * ports.length)];
      if (rand() < 0.45) { lat[k] = a[0] + gauss() * 0.08; lon[k] = a[1] + gauss() * 0.12; }
      else { const t = rand(); lat[k] = a[0] + (b[0] - a[0]) * t + gauss() * 0.04; lon[k] = a[1] + (b[1] - a[1]) * t + gauss() * 0.06; }
    }
    out.push(new Table({ lat: f64(lat), lon: f64(lon) }).batches[0]);
  }
  return out;
}

/** Port calls: a text x (one colour per port) plus a value (sized by it). */
function portCalls(): RecordBatch[] {
  const names = ['Hamburg', 'Rotterdam', 'Gothenburg', 'Copenhagen', 'Zeebrugge', 'Oslo', 'Aberdeen', 'Gdansk'];
  const lat = new Float64Array([53.55, 51.95, 57.7, 55.7, 51.3, 59.9, 57.15, 54.4]);
  const lon = new Float64Array([9.95, 4.1, 11.9, 12.6, 3.2, 10.7, -2.1, 18.7]);
  const calls = new Float64Array([1240, 2210, 610, 480, 900, 300, 150, 520]);
  return [new Table({ port: vectorFromArray(names, new Utf8()), lat: f64(lat), lon: f64(lon), calls: f64(calls) }).batches[0]];
}

const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const bind = (slot: number, request: number): LocalFrame => ({ ...header(Kind.BIND, { request, revision: request, epoch: 0 }), stamps: [], payload: u32(slot) });
const schema = (request: number, b: RecordBatch): LocalFrame => ({ ...header(Kind.RESULT_SCHEMA, { request }), stamps: [], payload: b.schema });
const batch = (request: number, b: RecordBatch): LocalFrame => ({ ...header(Kind.BATCH, { request }), stamps: [], payload: b });
const done = (request: number): LocalFrame => ({ ...header(Kind.DONE, { request }), stamps: [], payload: new Uint8Array(16) });
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const stats = (xs: number[]) => {
  const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b), q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return s.length ? { n: s.length, median: r(q(0.5)), p95: r(q(0.95)), max: r(s[s.length - 1]) } : { n: 0 };
};

async function main() {
  const frames: Frame[] = [], ui: EngineToUi[] = [];
  const r = await createRenderer(f => frames.push(f as Frame), m => ui.push(m), { backend });
  const canvases = [...document.querySelectorAll('canvas')];
  for (const c of canvases) r.attach(Number(c.dataset.slot), c.transferControlToOffscreen(), { width: 480, height: 260, devicePixelRatio: 1 });
  await tick();
  let next = 1;

  /** Stream `batches` into `slot`, measuring the first draw and every later batch. */
  async function run(slot: number, batches: RecordBatch[], view: ViewName | null) {
    r.setView(slot, view);
    const request = next++;
    await tick();
    r.handle(bind(slot, request)); r.handle(schema(request, batches[0]));
    const t0 = performance.now();
    r.handle(batch(request, batches[0]));
    const firstCall = performance.now() - t0;
    const timing = r.timing(request)!;
    const drawn = frames.find(f => f.kind === Kind.DRAWN && f.request === request && f.stamps.some(s => s.stage === 16));
    const stamps = drawn?.stamps ?? [];
    const firstDraw = stamps.length >= 2 ? stamps[1].at - stamps[0].at : NaN;
    // The frame after the first one carries the deferred coastline (urgent frames don't wait for rAF).
    const c0 = performance.now(); r.frame(false); const coastFrame = performance.now() - c0;
    const coastBytes = r.metrics.lastFrame.uploadedBytes, coastBuild = r.metrics.lastFrame.build, coastReplay = r.metrics.lastFrame.replay;
    const ingest: number[] = [], frame: number[] = [], build: number[] = [], replay: number[] = [];
    for (let k = 1; k < batches.length; k++) {
      const a = performance.now(); r.handle(batch(request, batches[k])); ingest.push(performance.now() - a);
      const f = performance.now(); r.frame(false); frame.push(performance.now() - f);
      build.push(r.metrics.lastFrame.build); replay.push(r.metrics.lastFrame.replay);
    }
    r.handle(done(request)); r.frame(false);
    const all = performance.now() - t0;
    await r.backend.presented();
    const presented = performance.now() - t0;
    const views = ui.filter(m => m.type === 'views' && m.slot === slot).map(m => (m as { chosen: ViewName }).chosen);
    return { request, rows: batches.reduce((s, b) => s + b.numRows, 0), batches: batches.length, chosen: views[views.length - 1],
      points: drawn ? new DataView((drawn.payload as Uint8Array).buffer, (drawn.payload as Uint8Array).byteOffset).getUint32(4, true) : 0,
      firstBatchCallMs: firstCall, firstDrawMs: firstDraw, firstIngestMs: timing.ingest, firstBuildMs: timing.build, firstReplayMs: timing.replay,
      coastFrameMs: coastFrame, coastBuildMs: coastBuild, coastReplayMs: coastReplay, coastFrameUploadedBytes: coastBytes,
      batchIngestMs: ingest, batchFrameMs: frame, batchBuildMs: build, batchReplayMs: replay, allBatchesMs: all, untilGpuDoneMs: presented };
  }

  const summarise = (runs: Awaited<ReturnType<typeof run>>[]) => ({
    rows: runs[0].rows, batches: runs[0].batches, chosen: runs[0].chosen, points: runs[0].points,
    firstBatchCallMs: stats(runs.map(x => x.firstBatchCallMs)), firstDrawMs: stats(runs.map(x => x.firstDrawMs)),
    firstIngestMs: stats(runs.map(x => x.firstIngestMs ?? NaN)), firstBuildMs: stats(runs.map(x => x.firstBuildMs ?? NaN)), firstReplayMs: stats(runs.map(x => x.firstReplayMs ?? NaN)),
    coastFrameMs: stats(runs.map(x => x.coastFrameMs)), coastBuildMs: stats(runs.map(x => x.coastBuildMs)), coastReplayMs: stats(runs.map(x => x.coastReplayMs)),
    coastFrameUploadedBytes: runs[0].coastFrameUploadedBytes,
    batchIngestMs: stats(runs.flatMap(x => x.batchIngestMs)), batchFrameMs: stats(runs.flatMap(x => x.batchFrameMs)),
    batchBuildMs: stats(runs.flatMap(x => x.batchBuildMs)), batchReplayMs: stats(runs.flatMap(x => x.batchReplayMs)),
    allBatchesMs: stats(runs.map(x => x.allBatchesMs)), untilGpuDoneMs: stats(runs.map(x => x.untilGpuDoneMs)),
  });

  const ships = voyages(6, 2000), dense = positions(100_000), ports = portCalls();
  const result: Record<string, unknown> = { backend: r.backend.kind, label: r.backend.label, userAgent: navigator.userAgent, reps };
  const measure = async (slot: number, data: RecordBatch[], view: ViewName | null) => {
    const runs = [];
    for (let i = 0; i < reps; i++) runs.push(await run(slot, data, view));
    return summarise(runs);
  };
  result.mapPorts = summarise([await run(1, ports, null)]);
  result.tracks = await measure(3, ships, null);
  result.density = await measure(2, dense, 'density');
  result.mapShips = await measure(1, ships, 'map');
  // Final images: ports on the map (slot 1), tracks at playback 0.4 (slot 4).
  await run(1, ports, null);
  await run(4, ships, null);
  const p0 = performance.now();
  r.setParam(4, 'playback', 0.4); r.frame(false);
  result.playbackFrameMs = performance.now() - p0;
  await tick(); await r.backend.presented(); await tick();
  result.views = Object.fromEntries([1, 2, 3, 4].map(s => [s, r.views(s)]));
  result.axes = ui.filter(m => m.type === 'axes').slice(-4).map(m => ({ slot: m.slot, legend: (m as any).ticks.legend }));
  page.__playback = async (p: number) => { r.setParam(4, 'playback', p); await tick(); await r.backend.presented(); await tick(); };
  (page as any).__frames = () => r.metrics.frames;
  page.__geo = { ok: true, result };
}

main().catch(error => { page.__geo = { ok: false, error: String(error?.stack ?? error) }; });
