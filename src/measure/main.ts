/**
 * /measure.html: the real pipeline (engine worker with the Wasm coordinator, DuckDB-Wasm and the
 * Wasm renderer on this machine's GPU, driven by the app's own UiController) with inference
 * replaced by an in-page fake that answers canned SQL after a configurable delay (0 ms by
 * default, so the numbers isolate our pipeline). It measures boot stages, scripted typing →
 * first draw / GPU done / next animation frame, the RTT to the inference server and the
 * hardware, shows a summary and offers the JSON that `pnpm perf --ingest` adds to the history.
 * See docs/batch-3/measurement.md for what each timestamp means.
 *
 * URL parameters: auto=1 (run without a click), reps=4, cadence=70 (ms between keys),
 * latency=0 (fake inference delay, ms), passes=echo,vary[,live], endpoint=wss://… (RTT and the
 * optional live pass; default: the build's VITE_INFERENCE_ENDPOINT), rtt=5 (connections).
 */
import { UiController, type RailView, type SlotCard, type SlotHost, type StatusInfo } from '../ui/controller';
import { coordinatorDefaults, DEFAULT_DATASET } from '../ui/defaults';
import type { TimingBreakdown } from '../ui/timing';
import type { InferencePlacement, SlotSize } from '../engine/contracts';
import { decode, encode, header, json, Kind, SUBPROTOCOL } from '../protocol/frame';
import { QUESTIONS, type AnswerMode } from './canned';
import { FrameGrid, mergeDrawn, refreshHz, stageTable, stats, type DrawnRequest, type MeasureReport } from './report';

/* eslint-disable @typescript-eslint/no-explicit-any */
const scriptStart = performance.now();
const params = new URLSearchParams(location.search);
const num = (name: string, fallback: number) => { const v = Number(params.get(name)); return params.has(name) && Number.isFinite(v) ? v : fallback; };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ───────────────────────── frame grid: every main-thread animation frame ─────────────────────────
const frames = new FrameGrid();
const onFrame = (ts: number) => { frames.push(performance.timeOrigin + ts); requestAnimationFrame(onFrame); };
requestAnimationFrame(onFrame);

// ───────────────────────── boot: the engine, the controller, slots ─────────────────────────
const marks = new Map<string, number>();
const mark = (name: string) => { if (!marks.has(name)) marks.set(name, performance.now()); };
const statuses = new Map<string, StatusInfo>();
const timings: TimingBreakdown[] = [];
const errors: string[] = [];
let costUsd = 0;
/** Latest inference READY (boot marks keep only the first). */
let inferenceReadyAt = -1;
let onChange: () => void = () => {};

const stage = $('stage');
const SIZE = { width: 640, height: 360 };
const host: SlotHost = {
  create(slot) {
    const canvas = document.createElement('canvas');
    canvas.width = SIZE.width * devicePixelRatio; canvas.height = SIZE.height * devicePixelRatio;
    canvas.style.width = `${SIZE.width}px`; canvas.style.height = `${SIZE.height}px`;
    canvas.hidden = true;
    stage.append(canvas);
    const noop = () => {};
    const card: SlotCard = {
      showLive: () => { for (const c of stage.querySelectorAll('canvas')) (c as HTMLCanvasElement).hidden = c !== canvas; },
      hide: () => { canvas.hidden = true; },
      keep: noop, title: noop, result: noop, views: noop, axes: noop, table: noop, timing: noop, inferStats: noop, error: noop, drill: noop,
      destroy: () => canvas.remove(),
    };
    const size: SlotSize = { ...SIZE, devicePixelRatio };
    return { card, canvas: canvas.transferControlToOffscreen(), size };
  },
  download: () => {},
};
const rail: RailView = {
  status(s) {
    statuses.set(s.component, s); mark(`${s.component}:${s.state}`);
    if (s.component === 'inference' && s.state === 'ready') inferenceReadyAt = performance.now();
    onChange();
  },
  context() { mark('context'); onChange(); },
  timing(t) { timings.push(t); onChange(); },
  inferStats(_request, _s, session) { costUsd = session; },
  error(e) { errors.push(`${e.code}: ${e.message}`); onChange(); },
  live() {}, kept() {},
};

const fakeEndpoint = (mode: AnswerMode) => `fake:?latency=${num('latency', 0)}&mode=${mode}`;
const worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'engine' });
mark('engine worker created');
const controller = new UiController(worker, host, rail);
worker.addEventListener('message', event => controller.receive(event.data));
worker.addEventListener('error', event => { errors.push(`worker: ${event.message}`); onChange(); });
let placement: InferencePlacement = { kind: 'remote', endpoint: fakeEndpoint('echo') };
controller.boot(placement, DEFAULT_DATASET, coordinatorDefaults());

const input = $<HTMLTextAreaElement>('input');
input.addEventListener('input', event => { controller.input(input.value, false, event.timeStamp); });

// ───────────────────────── helpers ─────────────────────────
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => T | null | undefined | false, timeoutMs: number, what: string): Promise<T> {
  const end = performance.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(5);
  }
}
const answerable = () => marks.has('context') && marks.has('inference:ready') && marks.has('renderer:ready') && marks.has('coordinator:ready');
const say = (text: string) => { $('state').textContent = text; };

/** Type `text` with synthetic input events at `cadence` ms; the first character replaces the box. */
async function typeText(text: string, cadence: number): Promise<number[]> {
  const gaps: number[] = [];
  let last = performance.now();
  for (let i = 0; i < text.length; i++) {
    input.value = text.slice(0, i + 1);
    input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text[i], bubbles: true }));
    const at = performance.now();
    if (i) gaps.push(at - last);
    last = at;
    if (i < text.length - 1) await sleep(cadence);
  }
  return gaps;
}

interface Sample { pass: string; question: string; final: DrawnRequest | null; drawn: DrawnRequest[]; dedup: boolean; gaps: number[] }

/** Type one question and wait until its last revision is answered and its frames are known. */
async function measureQuestion(pass: string, text: string, cadence: number): Promise<Sample> {
  const since = timings.length;
  const gaps = await typeText(text, cadence);
  const rev = controller.drafts.revision;
  const mine = () => timings.slice(since);
  await until(() => mine().some(t => t.revision === rev && (t.headline !== null || (t.rows.some(r => r.stage === 10) && !t.rows.some(r => r.stage === 11)))), 30_000, `answer to "${text}"`);
  // GPU completion of redraws, then one animation frame after it.
  const pending = () => mergeDrawn(mine(), null).filter(d => !d.steady && d.gpuDone === null);
  await until(() => !pending().length || null, 3000, 'GPU completion').catch(() => {});
  const lastGpu = Math.max(0, ...mergeDrawn(mine(), null).map(d => d.gpuDone ?? 0));
  await until(() => (frames.last ?? 0) >= lastGpu, 2000, 'a frame after GPU completion').catch(() => {});
  const drawn = mergeDrawn(mine(), frames);
  const finals = drawn.filter(d => d.revision === rev);
  return { pass, question: text, final: finals.at(-1) ?? null, drawn, dedup: !finals.length, gaps };
}

async function setPlacement(next: InferencePlacement): Promise<void> {
  if (JSON.stringify(next) === JSON.stringify(placement)) return;
  placement = next;
  const since = performance.now();
  // New answers: drop cached text → SQL translations of the previous mode.
  controller.setConfig({ translationCache: false });
  controller.setConfig({ translationCache: true });
  controller.setInference(next);
  await until(() => inferenceReadyAt > since, 30_000, 'inference READY after switching');
}

// ───────────────────────── network RTT ─────────────────────────
async function rtt(endpoint: string, n: number): Promise<{ connect: number[]; helloReady: number[]; error?: string }> {
  const connect: number[] = [], helloReady: number[] = [];
  for (let i = 0; i < n; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const t0 = performance.now();
        const ws = new WebSocket(endpoint, SUBPROTOCOL);
        ws.binaryType = 'arraybuffer';
        let sent = 0;
        const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 10_000);
        ws.onopen = () => {
          connect.push(performance.now() - t0);
          sent = performance.now();
          ws.send(encode({ ...header(Kind.HELLO), stamps: [], payload: json({ node: 'coordinator', name: 'time-blast-measure-rtt', version: 1 }) }));
        };
        ws.onmessage = event => {
          const f = decode(new Uint8Array(event.data as ArrayBuffer));
          if (f.kind !== Kind.READY) return;
          helloReady.push(performance.now() - sent);
          clearTimeout(timer); ws.close(1000); resolve();
        };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('connection failed')); };
      });
    } catch (error) {
      return { connect, helloReady, error: String((error as Error).message ?? error) };
    }
  }
  return { connect, helloReady };
}

// ───────────────────────── hardware ─────────────────────────
async function hardware(): Promise<MeasureReport['hardware'] & { browser: { name: string; version: string } }> {
  const nav = navigator as any;
  const gpu: MeasureReport['hardware']['gpu'] = {};
  try {
    const adapter = await nav.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter) {
      const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : undefined);
      Object.assign(gpu, { api: 'webgpu', vendor: info?.vendor || undefined, architecture: info?.architecture || undefined,
        device: info?.device || undefined, description: info?.description || undefined, fallbackAdapter: adapter.isFallbackAdapter ?? info?.isFallbackAdapter });
    }
  } catch { /* no WebGPU here */ }
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu.webgl = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { /* no WebGL2 */ }
  const r = statuses.get('renderer');
  if (r) { gpu.engineRenderer = `${r.label}${r.detail ? ` · ${r.detail}` : ''}`; gpu.api = r.label; }
  const all = [gpu.vendor, gpu.architecture, gpu.device, gpu.description, gpu.webgl, gpu.engineRenderer].join(' ');
  gpu.software = !!gpu.fallbackAdapter || /swiftshader|llvmpipe|software|basic render/i.test(all);
  let browser = { name: 'unknown', version: '' }, platform = nav.userAgentData?.platform ?? nav.platform ?? '';
  try {
    const h = await nav.userAgentData?.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture', 'model']);
    const brands: Array<{ brand: string; version: string }> = h?.fullVersionList ?? [];
    const pick = brands.find(b => /chrome|edge|opera|brave/i.test(b.brand)) ?? brands.find(b => !/not.a.brand/i.test(b.brand) && b.brand !== 'Chromium') ?? brands.find(b => b.brand === 'Chromium');
    if (pick) browser = { name: pick.brand, version: pick.version };
    if (h?.platform) platform = `${h.platform} ${h.platformVersion ?? ''} ${h.architecture ?? ''}`.replace(/\s+/g, ' ').trim();
  } catch { /* not Chromium */ }
  if (browser.name === 'unknown') {
    const ua = navigator.userAgent;
    const m = ua.match(/Firefox\/([\d.]+)/) ?? ua.match(/Version\/([\d.]+).*Safari/) ?? ua.match(/Chrome\/([\d.]+)/);
    if (m) browser = { name: /Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) && !/Chrome/.test(ua) ? 'Safari' : 'Chrome', version: m[1] };
  }
  return { cores: navigator.hardwareConcurrency, deviceMemoryGb: nav.deviceMemory, platform, devicePixelRatio, screen: `${screen.width}×${screen.height}`, gpu, browser };
}

function timerResolution(): number | null {
  let best = Infinity, prev = performance.now();
  for (let i = 0; i < 100_000 && best > 0.001; i++) { const t = performance.now(); if (t > prev) { best = Math.min(best, t - prev); prev = t; } }
  return Number.isFinite(best) ? +best.toFixed(4) : null;
}

// ───────────────────────── the run ─────────────────────────
export const DEFINITIONS: Record<string, string> = {
  keystroke: "KEY_INPUT: the synthetic input event's timeStamp (the page dispatches InputEvents; OS and hardware input latency are not included).",
  submitted: 'FIRST_DRAW_SUBMITTED: the renderer returned from queue.submit (WebGPU) or the last GL call for the first frame of this result, in the engine worker. CPU side; the GPU may not have started.',
  'steady': 'When a result has the same data as the image on screen, the renderer keeps that image and stamps submitted = presented at the moment the result is proven identical. No new frame exists, so no frame time is reported.',
  gpuDone: 'FIRST_PRESENTED: the promise of WebGPU queue.onSubmittedWorkDone() resolved in the engine worker (the GPU finished the frame\'s commands), observed one worker task later. With WebGL2 it is the worker\'s next animation frame instead.',
  frame: 'The first main-thread requestAnimationFrame timestamp (frame begin, vsync-aligned) at or after GPU done: the first compositor frame that can show the new image. A lower bound for the frame that shows it, accurate to about one refresh interval; the pixels reach the glass at least one more refresh interval later (scan-out and display latency are not measurable from a page). requestVideoFrameCallback applies to <video>, not canvases, so it is not used.',
  boot: 'Boot stages are performance.now() from navigation start when the main thread sees each engine STATUS ready frame and the dataset CONTEXT. "Answerable" = coordinator, renderer and inference ready and CONTEXT received. This page boots the same engine as the app but not the app shell.',
  rtt: 'A fresh WebSocket per sample: connect = constructor → open (DNS, TCP, TLS, upgrade); HELLO→READY = one tb1 round trip on the open socket.',
};

const samples: Sample[] = [];
let report: MeasureReport | null = null;
let firstQuery: Sample | null = null;
let rttResult: Awaited<ReturnType<typeof rtt>> | null = null;
let hw: Awaited<ReturnType<typeof hardware>> | null = null;
let refresh: number | null = null;
let running = false;

const endpoint = params.get('endpoint') ?? (import.meta.env.VITE_INFERENCE_ENDPOINT as string | undefined) ?? '';
$<HTMLInputElement>('endpoint').value = endpoint;
$<HTMLInputElement>('reps').value = String(num('reps', 4));
$<HTMLInputElement>('cadence').value = String(num('cadence', 70));
$<HTMLInputElement>('latency').value = String(num('latency', 0));
const passesParam = (params.get('passes') ?? 'echo,vary').split(',');
for (const p of ['echo', 'vary', 'live']) $<HTMLInputElement>(`pass-${p}`).checked = passesParam.includes(p);

/** Right after boot: the first question, cold (rollups may still be building). */
async function bootQuestion(): Promise<void> {
  await until(answerable, 600_000, 'engine boot');
  mark('answerable');
  say('Booted. Typing the first question (cold) …');
  try { firstQuery = await measureQuestion('boot', `${QUESTIONS[0]} boot`, num('cadence', 70)); }
  catch (error) { errors.push(String(error)); }
  render();
  say('Ready. Press Start to measure.');
  ($('start') as HTMLButtonElement).disabled = false;
  if (params.get('auto') === '1') void start();
}

async function start(): Promise<void> {
  if (running) return;
  running = true;
  ($('start') as HTMLButtonElement).disabled = true;
  try {
    const reps = Number($<HTMLInputElement>('reps').value) || 4, cadence = Number($<HTMLInputElement>('cadence').value) || 70;
    const latency = Number($<HTMLInputElement>('latency').value) || 0;
    const url = $<HTMLInputElement>('endpoint').value.trim();
    const passes = ['echo', 'vary', 'live'].filter(p => $<HTMLInputElement>(`pass-${p}`).checked);
    say('Reading hardware and refresh rate …');
    hw = await hardware();
    const from = performance.timeOrigin + performance.now();
    await sleep(1200);
    refresh = refreshHz(frames.intervals(from, performance.timeOrigin + performance.now()));
    if (url) { say(`Measuring RTT to ${url} …`); rttResult = await rtt(url, num('rtt', 5)); }
    await sleep(Math.max(0, 3000 - (performance.now() - (marks.get('answerable') ?? 0))));
    samples.length = 0;
    for (const pass of passes) {
      if (pass === 'live') {
        if (!url) { errors.push('live pass skipped: no endpoint'); continue; }
        await setPlacement({ kind: 'remote', endpoint: url });
      } else {
        await setPlacement({ kind: 'remote', endpoint: `fake:?latency=${latency}&mode=${pass}` });
      }
      for (let r = 0; r < reps; r++) for (const [i, q] of QUESTIONS.entries()) {
        const text = `${q} ${pass[0]}${String.fromCharCode(97 + ((r * QUESTIONS.length + i) % 26))}`;
        say(`Pass ${pass}: ${r * QUESTIONS.length + i + 1}/${reps * QUESTIONS.length} · typing “${text}”`);
        try { samples.push(await measureQuestion(pass, text, cadence)); }
        catch (error) { errors.push(String(error)); }
        await sleep(250);
      }
    }
    report = buildReport({ reps, cadence, latency, passes, endpoint: url });
    render();
    say('Done. Download the JSON and run `pnpm perf --ingest <file>` to add it to docs/perf/history.jsonl.');
    ($('download') as HTMLButtonElement).disabled = false;
  } catch (error) {
    errors.push(String(error));
    say(`Failed: ${String(error)}`);
    render();
  } finally {
    running = false;
    ($('start') as HTMLButtonElement).disabled = false;
  }
}

function bootStages(): Array<[string, number]> {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const at: Array<[string, number]> = [];
  if (nav) at.push(['response end', nav.responseEnd], ['DOM content loaded', nav.domContentLoadedEventEnd]);
  at.push(['script start', scriptStart]);
  for (const [name, label] of [['engine worker created', 'engine worker created'], ['coordinator:ready', 'coordinator ready'], ['inference:ready', 'inference ready'],
    ['renderer:ready', 'renderer ready'], ['database:ready', 'database ready'], ['context', 'context'], ['answerable', 'answerable']] as const) {
    const v = marks.get(name);
    if (v !== undefined) at.push([label, v]);
  }
  return at.filter(([, v]) => v > 0).sort((a, b) => a[1] - b[1]);
}

function buildReport(settings: Record<string, unknown>): MeasureReport {
  const metrics: MeasureReport['metrics'] = {};
  const stages: MeasureReport['stages'] = {};
  const add = (key: string, value: number | null | undefined, unit = 'ms') => {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    (metrics[key] ??= { unit, samples: [] }).samples.push(+value.toFixed(3));
  };
  const boot = bootStages();
  const bootAt = Object.fromEntries(boot);
  add('hw.boot.answerable', bootAt['answerable']);
  add('hw.boot.renderer_ready', bootAt['renderer ready']);
  add('hw.boot.engine_worker_created', bootAt['engine worker created']);
  let previous = 0;
  stages['hw.boot'] = boot.map(([label, v]) => { const d = v - previous; previous = v; return { label, n: 1, median: +d.toFixed(3), p95: +d.toFixed(3) }; });
  if (firstQuery?.final) add('hw.first_query_after_boot', firstQuery.final.submitted - firstQuery.final.keyAt);
  for (const pass of new Set(samples.map(s => s.pass))) {
    const mine = samples.filter(s => s.pass === pass);
    const finalRows: Array<Array<[string, number]>> = [];
    for (const s of mine) {
      const f = s.final;
      if (f) {
        add(`hw.${pass}.keystroke_to_draw`, f.submitted - f.keyAt);
        if (!f.steady && f.gpuDone !== null) add(`hw.${pass}.keystroke_to_gpu_done`, f.gpuDone - f.keyAt);
        if (!f.steady && f.frame !== null) add(`hw.${pass}.keystroke_to_frame`, f.frame - f.keyAt);
        finalRows.push(f.rows);
      }
      for (const d of s.drawn) if (!d.steady && d.frame !== null) add(`hw.${pass}.any_redraw_keystroke_to_frame`, d.frame - d.keyAt);
    }
    stages[`hw.${pass}.keystroke_to_draw`] = stageTable(finalRows);
  }
  if (rttResult) { for (const v of rttResult.connect) add('hw.net.ws_connect', v); for (const v of rttResult.helloReady) add('hw.net.hello_ready', v); }
  const notes: string[] = [];
  for (const pass of new Set(samples.map(s => s.pass))) {
    const mine = samples.filter(s => s.pass === pass);
    const steady = mine.filter(s => s.final?.steady).length, dedup = mine.filter(s => s.dedup).length;
    const gaps = stats(mine.flatMap(s => s.gaps));
    notes.push(`${pass}: ${mine.length} questions; final keystroke kept the image (steady) ${steady}, deduplicated (no new request) ${dedup}; typing gap median ${gaps?.median.toFixed(1)} ms, p95 ${gaps?.p95.toFixed(1)} ms`);
  }
  if (rttResult?.error) notes.push(`RTT: ${rttResult.error}`);
  if (costUsd) notes.push(`live inference cost this session: $${costUsd.toFixed(5)}`);
  for (const e of errors) notes.push(`error: ${e}`);
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  return {
    kind: 'time-blast.measure', version: 1, date: new Date().toISOString(),
    page: { url: location.href, userAgent: navigator.userAgent, browser: hw?.browser, crossOriginIsolated, timerResolutionMs: timerResolution() },
    hardware: { cores: hw?.cores, deviceMemoryGb: hw?.deviceMemoryGb, platform: hw?.platform, devicePixelRatio, screen: hw?.screen ?? '', refreshHz: refresh ?? undefined, gpu: hw?.gpu ?? {} },
    settings: { ...settings, navigationType: nav?.type, transferSize: nav?.transferSize, suggestions: 'off (not mounted on this page)', dataset: DEFAULT_DATASET },
    metrics, stages, definitions: DEFINITIONS, notes,
  };
}

// ───────────────────────── rendering ─────────────────────────
const fmt = (v: number | undefined | null, unit = 'ms') => v === undefined || v === null || !Number.isFinite(v) ? '—' : `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${unit}`;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const LABELS: Record<string, string> = {
  'hw.boot.answerable': 'Boot: navigation → first question answerable',
  'hw.boot.renderer_ready': 'Boot: navigation → renderer ready',
  'hw.boot.engine_worker_created': 'Boot: navigation → engine worker created',
  'hw.first_query_after_boot': 'First question after boot: last keystroke → first draw submitted',
  'hw.echo.keystroke_to_draw': 'Echo: last keystroke → first draw submitted (same data: image kept)',
  'hw.vary.keystroke_to_draw': 'Vary: last keystroke → first draw submitted',
  'hw.vary.keystroke_to_gpu_done': 'Vary: last keystroke → GPU work done',
  'hw.vary.keystroke_to_frame': 'Vary: last keystroke → next animation frame (presented frame)',
  'hw.echo.any_redraw_keystroke_to_frame': 'Echo: any keystroke that changed the image → next frame',
  'hw.vary.any_redraw_keystroke_to_frame': 'Vary: any keystroke that changed the image → next frame',
  'hw.live.keystroke_to_draw': 'Live inference: last keystroke → first draw submitted',
  'hw.net.ws_connect': 'Network: WebSocket connect',
  'hw.net.hello_ready': 'Network: tb1 HELLO → READY round trip',
};

function render(): void {
  const r = report ?? (firstQuery ? buildReport({}) : null);
  if (!r) return;
  const g = r.hardware.gpu;
  $('hardware').innerHTML = `<dl>
    <dt>GPU</dt><dd>${esc([g.vendor, g.architecture, g.device, g.description].filter(Boolean).join(' · ') || 'unknown')} ${g.software ? '<b class="warn">software GPU</b>' : ''}</dd>
    <dt>Renderer path</dt><dd>${esc(g.engineRenderer ?? '—')}</dd>
    <dt>WebGL renderer</dt><dd>${esc(g.webgl ?? '—')}</dd>
    <dt>Browser</dt><dd>${esc(r.page.browser ? `${r.page.browser.name} ${r.page.browser.version}` : navigator.userAgent)}</dd>
    <dt>Platform</dt><dd>${esc(r.hardware.platform ?? '—')} · ${r.hardware.cores ?? '?'} cores · ${r.hardware.deviceMemoryGb ?? '?'} GB (deviceMemory, capped) · DPR ${r.hardware.devicePixelRatio}</dd>
    <dt>Display</dt><dd>${r.hardware.refreshHz ? `${r.hardware.refreshHz} Hz (median rAF interval)` : 'not measured yet'} · ${esc(r.hardware.screen)}</dd>
    <dt>Timers</dt><dd>cross-origin isolated: ${r.page.crossOriginIsolated} · resolution ≈ ${r.page.timerResolutionMs ?? '?'} ms</dd></dl>`;
  const rows = Object.entries(r.metrics).map(([k, m]) => {
    const s = stats(m.samples)!;
    return `<tr><th>${esc(LABELS[k] ?? k)}<small>${esc(k)}</small></th><td>${s.n}</td><td><b>${fmt(s.median, m.unit)}</b></td><td>${fmt(s.p95, m.unit)}</td><td>${fmt(s.min, m.unit)}</td><td>${fmt(s.max, m.unit)}</td></tr>`;
  }).join('');
  $('metrics').innerHTML = `<table><thead><tr><th>Metric</th><th>n</th><th>median</th><th>p95</th><th>min</th><th>max</th></tr></thead><tbody>${rows}</tbody></table>`;
  $('stages').innerHTML = Object.entries(r.stages).filter(([, rows]) => rows.length).map(([k, rows]) =>
    `<h3>${esc(LABELS[k] ?? k)}</h3><table class="stages"><thead><tr><th>stage (delta from previous)</th><th>n</th><th>median</th><th>p95</th></tr></thead><tbody>${rows.map(s => `<tr><th>${esc(s.label)}</th><td>${s.n}</td><td>${fmt(s.median)}</td><td>${fmt(s.p95)}</td></tr>`).join('')}</tbody></table>`).join('');
  $('notes').innerHTML = r.notes.map(n => `<li>${esc(n)}</li>`).join('');
}

$('start').addEventListener('click', () => void start());
$('download').addEventListener('click', () => {
  if (!report) return;
  const blob = new Blob([JSON.stringify(report, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `time-blast-measure-${report.date.slice(0, 19).replace(/[:T]/g, '-')}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});
$('definitions').innerHTML = Object.entries(DEFINITIONS).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
onChange = () => {
  if (marks.has('answerable')) return;
  const s = [...statuses.values()].map(s => `${s.component} ${s.state}`).join(' · ');
  say(`Booting: ${s}${marks.has('context') ? ' · context' : ''}`);
};

/** For headless runs (tests/measure_page.py). */
(globalThis as any).__measure = { get report() { return report; }, get errors() { return errors; }, get firstQuery() { return firstQuery; }, start };
void bootQuestion();
