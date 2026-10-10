/**
 * Renderer through the real engine data path (driven by tests/render_engine.py via
 * render-engine.html): DuckDB-Wasm database node + tb-render on transferred OffscreenCanvases in
 * one module worker, wired like src/engine/host.ts routes them (database → renderer objects,
 * BIND before EXEC). Measures EXEC → DB first batch → render first batch → first draw
 * submitted → presented per query shape, and checks roles/views on real DuckDB Arrow types.
 */
import { createDatabaseWith } from '../src/engine/database';
import type { EngineToUi, LocalFrame } from '../src/engine/contracts';
import { createRenderer } from '../src/engine/render';
import { Flag, header, Kind, Stage, text, type Frame } from '../src/protocol/frame';

const scope = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent) => void) | null; crossOriginIsolated: boolean };

const QUERIES: Array<{ name: string; slot: number; sql: string; view: string }> = [
  { name: 'minute-avg-60k', slot: 1, view: 'line',
    sql: "SELECT date_trunc('minute', ts) AS t, vessel, avg(speed) AS speed FROM telemetry WHERE ts < TIMESTAMP '2026-09-08' GROUP BY ALL ORDER BY 1, 2" },
  { name: 'count-by-vessel', slot: 2, view: 'bar', sql: 'SELECT vessel, count(*) AS n FROM telemetry GROUP BY ALL ORDER BY 1' },
  { name: 'hourly-two-measures', slot: 3, view: 'line',
    sql: "SELECT date_trunc('hour', ts) AS t, avg(wind) AS wind, avg(speed) AS speed FROM telemetry GROUP BY ALL ORDER BY 1" },
  { name: 'raw-table', slot: 4, view: 'table', sql: 'SELECT vessel, CAST(ts AS VARCHAR) AS stamp FROM telemetry LIMIT 100' },
];

const quantiles = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b), at = (q: number) => +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(3);
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: at(1) };
};

async function run(canvases: OffscreenCanvas[], size: { width: number; height: number; devicePixelRatio: number }) {
  const ui: EngineToUi[] = [];
  const drawn: Frame[] = [];
  const renderer = await createRenderer(f => { if (f.kind === Kind.DRAWN) drawn.push(f as Frame); }, m => ui.push(m));
  const pending = new Map<number, () => void>();
  const stamps = new Map<number, Array<{ stage: number; at: number }>>();
  const { node } = await createDatabaseWith(frame => {
    const f = frame as LocalFrame;
    const list = stamps.get(f.request) ?? [];
    list.push(...f.stamps); stamps.set(f.request, list);
    if (f.flags & Flag.HEADER_ONLY) return;
    if (f.kind === Kind.RESULT_SCHEMA || f.kind === Kind.BATCH || f.kind === Kind.DONE) renderer.handle(f);
    if (f.kind === Kind.DONE || f.kind === Kind.ERROR) pending.get(f.request)?.();
  });
  await node.open({ kind: 'fixture', name: 'vessels' }, 1);
  canvases.forEach((canvas, i) => renderer.attach(i + 1, canvas, size));
  await new Promise(resolve => setTimeout(resolve, 50));

  let request = 0;
  const exec = (slot: number, sql: string) => new Promise<number>(resolve => {
    const id = ++request;
    pending.set(id, () => { pending.delete(id); resolve(id); });
    const u32 = new Uint8Array(4); new DataView(u32.buffer).setUint32(0, slot, true);
    renderer.handle({ ...header(Kind.BIND, { request: id, revision: id, epoch: 1, context: 1 }), stamps: [], payload: u32 });
    node.handle({ ...header(Kind.EXEC, { request: id, epoch: 1, context: 1 }), stamps: [], payload: text(sql) });
  });
  const stage = (id: number, s: number) => [...(stamps.get(id) ?? []), ...drawn.filter(f => f.request === id).flatMap(f => f.stamps)].find(x => x.stage === s)?.at;

  const out: Record<string, unknown> = { crossOriginIsolated: scope.crossOriginIsolated, backend: renderer.backend.kind, label: renderer.backend.label, scheduler: renderer.scheduler };
  for (const q of QUERIES) {
    const runs: Record<string, number[]> = { dbFirstBatch: [], dbToRender: [], renderToSubmitted: [], execToSubmitted: [], execToPresented: [], dbDone: [] };
    let last = 0;
    for (let rep = 0; rep < 11; rep++) {
      const id = await exec(q.slot, q.sql);
      await new Promise(resolve => setTimeout(resolve, 30));
      last = id;
      const received = stage(id, Stage.EXEC_RECEIVED)!, first = stage(id, Stage.DB_FIRST_BATCH)!, render = stage(id, Stage.RENDER_FIRST_BATCH)!;
      const submitted = stage(id, Stage.FIRST_DRAW_SUBMITTED)!, presented = stage(id, Stage.FIRST_PRESENTED), done = stage(id, Stage.DB_DONE)!;
      if (rep === 0) continue; // cold run reported separately below
      runs.dbFirstBatch.push(first - received); runs.dbToRender.push(render - first); runs.renderToSubmitted.push(submitted - render);
      runs.execToSubmitted.push(submitted - received); if (presented) runs.execToPresented.push(presented - received); runs.dbDone.push(done - received);
    }
    const views = ui.filter(m => m.type === 'views' && m.slot === q.slot).at(-1) as Extract<EngineToUi, { type: 'views' }> | undefined;
    const table = ui.filter(m => m.type === 'table' && m.slot === q.slot).at(-1) as Extract<EngineToUi, { type: 'table' }> | undefined;
    const d = drawn.find(f => f.request === last && f.stamps.some(s => s.stage === Stage.FIRST_DRAW_SUBMITTED));
    out[q.name] = {
      chosen: views?.chosen, available: views?.available, expected: q.view,
      points: d ? new DataView((d.payload as Uint8Array).buffer).getUint32(4, true) : null,
      tableTotal: table?.total, tableFirstRow: table?.rows[0],
      warmMs: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, quantiles(v)])),
    };
  }
  renderer.export(2, 'csv');
  const exp = ui.find(m => m.type === 'export') as Extract<EngineToUi, { type: 'export' }> | undefined;
  out.exportCsv = exp ? (await exp.blob.text()).split('\n').slice(0, 3) : null;
  return out;
}

scope.onmessage = event => {
  const { canvases, size } = event.data as { canvases: OffscreenCanvas[]; size: { width: number; height: number; devicePixelRatio: number } };
  run(canvases, size).then(result => scope.postMessage({ ok: true, result }), error => scope.postMessage({ ok: false, error: String(error?.stack ?? error) }));
};
