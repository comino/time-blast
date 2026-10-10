/**
 * Browser equivalence + latency check for the remote database placement (driven by
 * tests/remote_database.py via remote-database.html).
 *
 * Runs the real EngineHost with the real database factory the engine worker uses
 * (`createPlacedDatabase(createDatabase)`), plus a scripted fake coordinator and a recording
 * fake renderer. The same queries run twice through the same host routing: once after
 * opening the `vessels` fixture in DuckDB-Wasm, once after opening `{kind: 'remote'}` (the
 * ClickHouse node over a tb1 WebSocket). Results are compared cell by cell; timings are
 * EXEC routed by the host → first BATCH / DONE at the renderer, cold and warm.
 */
import type { RecordBatch, Schema } from 'apache-arrow';
import type { CoordinatorCore, DatasetContext, LinkId, LocalFrame, RendererNode } from '../src/engine/contracts';
import { EngineHost } from '../src/engine/host';
import { createDatabase } from '../src/engine/database';
import { createPlacedDatabase } from '../src/engine/remote-database';
import { encode, header, Kind, readJson, Stage, text, type Frame } from '../src/protocol/frame';

const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent) => void) | null };

// ───────────────────────── fakes ─────────────────────────

/** Coordinator stand-in: records what the host feeds it and releases scripted outputs. */
class ScriptedCoordinator implements CoordinatorCore {
  outbox: Array<[LinkId, Frame<Uint8Array>]> = [];
  received: Array<[LinkId, Frame<Uint8Array>]> = [];
  onInput?: (link: LinkId, frame: Frame<Uint8Array>) => void;
  input(link: LinkId, frame: Frame<Uint8Array>): void { this.received.push([link, frame]); this.onInput?.(link, frame); }
  inputEncoded(): void { /* the poke frame from the "UI" */ }
  tick(): void {}
  drain(): Array<[LinkId, Frame<Uint8Array>]> { const out = this.outbox; this.outbox = []; return out; }
  nextDeadline(): number | null { return null; }
  dispose(): void {}
}

interface Collected { schema?: Schema; batches: RecordBatch[]; firstBatchAt?: number; doneAt?: number; done?: Frame; error?: Frame; frames: LocalFrame[] }

class RecordingRenderer implements RendererNode {
  results = new Map<number, Collected>();
  waiters = new Map<number, (c: Collected) => void>();
  attach(): void {}
  resize(): void {}
  detach(): void {}
  setView(): void {}
  setParam(): void {}
  export(): void {}
  views(): never[] { return []; }
  handle(frame: LocalFrame): void {
    const at = performance.now();
    const c = this.get(frame.request);
    c.frames.push(frame);
    if (frame.kind === Kind.RESULT_SCHEMA) c.schema = frame.payload as Schema;
    else if (frame.kind === Kind.BATCH) { c.firstBatchAt ??= at; c.batches.push(frame.payload as RecordBatch); }
    else if (frame.kind === Kind.DONE) { c.doneAt = at; c.done = frame as Frame; this.waiters.get(frame.request)?.(c); }
  }
  get(request: number): Collected {
    let c = this.results.get(request);
    if (!c) this.results.set(request, c = { batches: [], frames: [] });
    return c;
  }
}

// ───────────────────────── harness ─────────────────────────

const coordinator = new ScriptedCoordinator();
const renderer = new RecordingRenderer();
const decodeMs: number[] = [];
const host = new EngineHost({
  createCoordinator: async () => coordinator,
  createRenderer: async () => renderer,
  createDatabase: createPlacedDatabase(createDatabase, { onDecode: (_kind, _request, ms) => decodeMs.push(ms) }),
  postToUi: () => {},
  connectInference: () => { throw new Error('no inference in this test'); },
  reconnectDelays: [1e9],
});
const poke = encode({ ...header(Kind.DRAFT, { revision: 1 }), stamps: [], payload: text('poke') });

let request = 0;
let context = 0;

interface Run { request: number; outcome: 'done' | 'error'; code?: string; firstBatchMs?: number; doneMs?: number; rows: number; result?: Collected; server?: { firstBatchMs: number; doneMs: number; uplinkMs: number; downlinkMs: number } }

function exec(sql: string, timeoutMs = 30_000): Promise<Run> {
  const id = ++request;
  return new Promise<Run>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`request ${id} timed out: ${sql}`)), timeoutMs);
    let t0 = 0;
    const finish = (run: Run) => { clearTimeout(timer); coordinator.onInput = undefined; renderer.waiters.delete(id); resolve(run); };
    renderer.waiters.set(id, c => {
      const rows = c.batches.reduce((n, b) => n + b.numRows, 0);
      const received = c.frames.find(f => f.kind === Kind.RESULT_SCHEMA)?.stamps.find(s => s.stage === Stage.EXEC_RECEIVED)?.at;
      const first = c.frames.find(f => f.kind === Kind.BATCH)?.stamps.find(s => s.stage === Stage.DB_FIRST_BATCH)?.at;
      const done = c.done!.stamps.find(s => s.stage === Stage.DB_DONE)?.at;
      finish({
        request: id, outcome: 'done', rows, result: c,
        firstBatchMs: c.firstBatchAt !== undefined ? c.firstBatchAt - t0 : undefined, doneMs: c.doneAt! - t0,
        server: received !== undefined && done !== undefined ? { firstBatchMs: first !== undefined ? first - received : NaN, doneMs: done - received, uplinkMs: received - (performance.timeOrigin + t0), downlinkMs: first !== undefined && c.firstBatchAt !== undefined ? performance.timeOrigin + c.firstBatchAt - first : NaN } : undefined,
      });
    });
    coordinator.onInput = (link, frame) => {
      if (link === 'database' && frame.kind === Kind.ERROR && frame.request === id) {
        finish({ request: id, outcome: 'error', code: readJson<{ code: string }>(frame.payload).code, rows: 0 });
      }
    };
    coordinator.outbox.push(['database', { ...header(Kind.EXEC, { request: id, epoch: 1, revision: id, context }), stamps: [], payload: text(sql) }]);
    t0 = performance.now();
    host.onMessage({ type: 'frame', bytes: poke.slice().buffer as ArrayBuffer });
  });
}

// ───────────────────────── comparison ─────────────────────────

const typeName = (schema: Schema) => schema.fields.map(f => `${f.name}:${String(f.type)}`);

function cells(c: Collected): unknown[][] {
  const rows: unknown[][] = [];
  for (const batch of c.batches) {
    const columns = batch.schema.fields.map((_, i) => batch.getChildAt(i)!);
    for (let r = 0; r < batch.numRows; r++) {
      rows.push(columns.map(column => {
        const v = column.get(r);
        if (typeof v === 'bigint') return Number(v);
        if (v instanceof Date) return v.getTime();
        return v ?? null;
      }));
    }
  }
  return rows;
}

function compare(a: Collected, b: Collected): { rows: number; mismatches: number; maxRelDiff: number; examples: unknown[] } {
  const x = cells(a), y = cells(b);
  let mismatches = Math.abs(x.length - y.length), maxRelDiff = 0;
  const examples: unknown[] = [];
  for (let r = 0; r < Math.min(x.length, y.length); r++) {
    for (let c = 0; c < Math.max(x[r].length, y[r].length); c++) {
      const u = x[r][c], v = y[r][c];
      if (typeof u === 'number' && typeof v === 'number') {
        const rel = Math.abs(u - v) / Math.max(1e-12, Math.abs(u), Math.abs(v));
        maxRelDiff = Math.max(maxRelDiff, rel);
        if (rel <= 1e-9) continue;
      } else if (u === v) continue;
      mismatches++;
      if (examples.length < 5) examples.push({ row: r, column: c, duckdb: u, clickhouse: v });
    }
  }
  return { rows: x.length, mismatches, maxRelDiff, examples };
}

const quantiles = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((p, q) => p - q);
  const at = (q: number) => +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(3);
  return sorted.length ? { n: sorted.length, min: at(0), p50: at(0.5), p95: at(0.95), max: at(1) } : { n: 0 };
};

// Same SQL text on both engines unless a pair is given.
const QUERIES: Array<{ name: string; duckdb: string; clickhouse?: string }> = [
  { name: 'aggregate60k', duckdb: "SELECT date_trunc('minute', ts) AS t, vessel, avg(speed) AS speed FROM telemetry WHERE ts < TIMESTAMP '2026-09-08' GROUP BY ALL ORDER BY 1, 2" },
  { name: 'hourly', duckdb: "SELECT date_trunc('hour', ts) AS t, vessel, max(wind) AS wind, min(water_temp) AS cold, count(*) AS n FROM telemetry GROUP BY ALL ORDER BY 1, 2" },
  { name: 'scan158k', duckdb: "SELECT ts, speed, lat, lon FROM telemetry WHERE vessel = 'Aurora' AND ts < TIMESTAMP '2026-09-12' ORDER BY ts" },
  { name: 'perVessel', duckdb: 'SELECT vessel, avg(wave_height) AS wave, max(speed) AS top, count(*) AS n FROM telemetry GROUP BY vessel ORDER BY vessel' },
  {
    name: 'bucketDialect',
    duckdb: "SELECT time_bucket(INTERVAL '6 hours', ts) AS t, vessel, avg(wind) AS wind FROM telemetry GROUP BY ALL ORDER BY 1, 2",
    clickhouse: 'SELECT toStartOfInterval(ts, INTERVAL 6 hour) AS t, vessel, avg(wind) AS wind FROM telemetry GROUP BY ALL ORDER BY 1, 2',
  },
  { name: 'tiny', duckdb: 'SELECT 42 AS answer' },
];
const ERRORS = [
  { name: 'twoStatements', sql: 'SELECT 1; SELECT 2' },
  { name: 'unknownColumn', sql: 'SELECT nope FROM telemetry' },
  { name: 'ddl', sql: 'DROP TABLE telemetry' },
  { name: 'tooManyRows', sql: 'SELECT * FROM telemetry' },
];

async function open(source: Parameters<EngineHost['openDataset']>[0]): Promise<{ context: DatasetContext; ms: number }> {
  const t0 = performance.now();
  const opened = await host.openDataset(source);
  if (!opened) throw new Error(`could not open ${JSON.stringify(source)}`);
  context = opened.id;
  return { context: opened, ms: performance.now() - t0 };
}

async function runPlacement(placement: 'duckdb' | 'clickhouse', warm: number) {
  const out: Record<string, unknown> = {};
  const results: Record<string, Collected> = {};
  for (const q of QUERIES) {
    const sql = placement === 'clickhouse' ? q.clickhouse ?? q.duckdb : q.duckdb;
    const cold = await exec(sql);
    if (cold.outcome !== 'done') { out[q.name] = { error: cold.code }; continue; }
    results[q.name] = cold.result!;
    const runs: Run[] = [];
    for (let i = 0; i < warm; i++) runs.push(await exec(sql));
    out[q.name] = {
      rows: cold.rows, batches: cold.result!.batches.length, types: typeName(cold.result!.schema!),
      cold: { firstBatchMs: cold.firstBatchMs, doneMs: cold.doneMs, server: cold.server },
      warm: {
        firstBatchMs: quantiles(runs.map(r => r.firstBatchMs!)), doneMs: quantiles(runs.map(r => r.doneMs!)),
        serverFirstBatchMs: quantiles(runs.map(r => r.server?.firstBatchMs ?? NaN)), serverDoneMs: quantiles(runs.map(r => r.server?.doneMs ?? NaN)),
        // Cross-process (browser clock vs server stamps, same host): EXEC send → EXEC_RECEIVED, DB_FIRST_BATCH → renderer.
        uplinkMs: quantiles(runs.map(r => r.server?.uplinkMs ?? NaN)), downlinkMs: quantiles(runs.map(r => r.server?.downlinkMs ?? NaN)),
      },
    };
    // Drop warm results: only the cold one is kept for comparison.
    for (const r of runs) renderer.results.delete(r.request);
  }
  const errors: Record<string, string | undefined> = {};
  for (const e of ERRORS) { const r = await exec(e.sql); errors[e.name] = r.outcome === 'error' ? r.code : 'NOT REJECTED'; }
  out.errors = errors;
  return { summary: out, results };
}

async function run(endpoint: string, warm: number) {
  await host.ready;
  const out: Record<string, unknown> = { crossOriginIsolated: (self as unknown as { crossOriginIsolated: boolean }).crossOriginIsolated };

  const local = await open({ kind: 'fixture', name: 'vessels' });
  out.duckdbOpen = { ms: local.ms, rows: local.context.tables[0].rows };
  const duck = await runPlacement('duckdb', warm);
  out.duckdb = duck.summary;

  decodeMs.length = 0;
  const remote = await open({ kind: 'remote', name: 'vessels', endpoint } as never);
  out.clickhouseOpen = { ms: remote.ms, rows: remote.context.tables[0].rows, dialect: remote.context.dialect, columns: remote.context.tables[0].columns };
  const ch = await runPlacement('clickhouse', warm);
  out.clickhouse = ch.summary;
  out.decodeMs = quantiles(decodeMs);

  const equal: Record<string, unknown> = {};
  for (const q of QUERIES) {
    const a = duck.results[q.name], b = ch.results[q.name];
    equal[q.name] = a && b ? compare(a, b) : { missing: !a ? 'duckdb' : 'clickhouse' };
  }
  out.equal = equal;
  // The coordinator saw HEADER_ONLY copies of every RESULT_SCHEMA/BATCH, from both placements.
  out.headerOnlyToCoordinator = coordinator.received.filter(([l, f]) => l === 'database' && (f.kind === Kind.BATCH || f.kind === Kind.RESULT_SCHEMA))
    .every(([, f]) => (f.flags & 0x80) !== 0 && f.payload.byteLength === 0);
  out.contextsSeen = coordinator.received.filter(([l, f]) => l === 'database' && f.kind === Kind.CONTEXT).map(([, f]) => f.context);
  return out;
}

scope.onmessage = (event: MessageEvent) => {
  const { endpoint, warm } = event.data as { endpoint: string; warm: number };
  run(endpoint, warm).then(result => scope.postMessage({ ok: true, result }), error => scope.postMessage({ ok: false, error: String(error?.stack ?? error) }));
};
