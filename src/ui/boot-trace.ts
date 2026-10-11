/**
 * Boot trace, page side (docs/batch-3/cold-start.md). Lines up main-thread marks, the engine
 * worker's marks and the browser's own navigation/resource timing against navigation start
 * (`performance.timeOrigin` of this page = 0), and prints one console table when the first
 * question becomes answerable and another when rollups are ready. Cheap: marks are pushed into
 * an array; the table is built twice per page load.
 *
 * "First question answerable": the dataset context is ready (EXEC runs at once), and the
 * coordinator, renderer and inference link are up. Read it in tests via
 * `globalThis.__timeBlastBoot.report()`.
 */
import { bootMark, setBootSink, type BootMark } from '../engine/boot-trace';

export interface BootRow { stage: string; thread: 'page' | 'worker' | 'net'; startMs: number | null; endMs: number; ms: number | null; detail?: string }
export interface BootReport {
  /** ms from navigation start, or null if not reached yet. */
  answerable: number | null;
  rollups: number | null;
  rows: BootRow[];
  /** Transfer sizes of the boot's resources (bytes on the wire; 0 = served from cache). */
  transfer: Record<string, { transferSize: number; decodedBodySize: number; ms: number }>;
}

const workerMarks: BootMark[] = [];
const pageMarks: BootMark[] = [];
const REQUIRED = ['dataset.open', 'coordinator.ready', 'renderer.ready', 'inference.ready'];
let printedAnswerable = false, printedRollups = false;

const origin = performance.timeOrigin;
const rel = (at: number) => +(at - origin).toFixed(2);
const first = (name: string) => workerMarks.find(m => m.name === name) ?? pageMarks.find(m => m.name === name);

/** Short label for a resource URL (hashed asset names stripped). */
function resourceLabel(url: string): string | undefined {
  const path = new URL(url, location.href).pathname;
  const file = path.split('/').pop() ?? path;
  const duck = /duckdb-(eh|mvp)/.exec(file);
  if (duck) return `duckdb ${duck[1]} wasm`;
  if (/^engine\.worker/.test(file)) return 'engine worker js';
  if (/^index-.*\.js$/.test(file) || /src\/ui\/app\.ts$/.test(path)) return 'page js';
  if (/\.css$/.test(file)) return 'page css';
  if (/tb-coordinator/.test(file)) return 'coordinator wasm';
  if (/tb-render/.test(file)) return 'renderer wasm';
  if (/datasets\.json$/.test(file)) return 'manifest';
  if (/\.duckdb$/.test(file)) return `prebuilt ${file}`;
  if (/\.parquet$/.test(file)) return `parquet ${file}`;
  if (/duckdb_extension/.test(file)) return `extension ${file.split('.')[0]}`;
  return undefined;
}

export function bootReport(): BootReport {
  const rows: BootRow[] = [];
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (nav) {
    rows.push({ stage: 'html', thread: 'net', startMs: +nav.requestStart.toFixed(2), endMs: +nav.responseEnd.toFixed(2), ms: +(nav.responseEnd - nav.requestStart).toFixed(2) });
    rows.push({ stage: 'dom interactive', thread: 'page', startMs: null, endMs: +nav.domInteractive.toFixed(2), ms: null });
  }
  const transfer: BootReport['transfer'] = {};
  for (const entry of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
    const label = resourceLabel(entry.name);
    if (!label || transfer[label]) continue;
    transfer[label] = { transferSize: entry.transferSize, decodedBodySize: entry.decodedBodySize, ms: +entry.duration.toFixed(2) };
    rows.push({ stage: `fetch ${label}`, thread: 'net', startMs: +entry.startTime.toFixed(2), endMs: +entry.responseEnd.toFixed(2), ms: +entry.duration.toFixed(2) });
  }
  for (const [thread, marks] of [['page', pageMarks], ['worker', workerMarks]] as const) {
    for (const m of marks) {
      rows.push({ stage: m.name, thread, startMs: m.from === undefined ? null : rel(m.from), endMs: rel(m.at),
        ms: m.from === undefined ? null : +(m.at - m.from).toFixed(2), ...(m.detail ? { detail: m.detail } : {}) });
    }
  }
  rows.sort((a, b) => a.endMs - b.endMs);
  const reached = REQUIRED.map(first);
  const answerable = reached.every(Boolean) ? rel(Math.max(...reached.map(m => m!.at))) : null;
  const rollupsMark = first('rollups.ready');
  return { answerable, rollups: rollupsMark ? rel(rollupsMark.at) : null, rows, transfer };
}

function print(title: string): void {
  const report = bootReport();
  console.info(`[time-blast] ${title}: first question answerable ${report.answerable ?? '—'} ms, rollups ready ${report.rollups ?? '—'} ms after navigation start`);
  console.table(report.rows.map(r => ({ stage: r.stage, thread: r.thread, start: r.startMs, end: r.endMs, ms: r.ms, detail: r.detail ?? '' })));
}

function check(): void {
  if (!printedAnswerable && REQUIRED.every(first)) {
    printedAnswerable = true;
    bootMark('answerable');
    print('boot');
  }
  if (!printedRollups && first('rollups.ready')) {
    printedRollups = true;
    if (printedAnswerable) print('rollups');
  }
}

/** Collect page marks (src/engine/boot-trace.ts sink) and worker `{type:'trace'}` messages. */
export function installBootTrace(worker: Worker): void {
  setBootSink(mark => { pageMarks.push(mark); });
  worker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; marks?: BootMark[] };
    if (data?.type !== 'trace' || !data.marks) return;
    workerMarks.push(...data.marks);
    check();
  });
  (globalThis as unknown as { __timeBlastBoot: unknown }).__timeBlastBoot = { report: bootReport, pageMarks, workerMarks };
}
