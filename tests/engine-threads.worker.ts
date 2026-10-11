/**
 * Threads experiment (tests/engine_threads.py, docs/batch-2/database.md): does DuckDB-Wasm's
 * threaded COI build beat the engine's blocking in-worker DuckDB on EXEC → first batch?
 *
 * The blocking API only ships the `mvp`/`eh` builds, which are compiled without threads
 * (`SET threads = 2` fails), so the threaded build can only be reached through the async API:
 * AsyncDuckDB in its own worker (+ pthread workers), queried from this worker via postMessage.
 * Same fixture, same queries, measured from this worker: blocking = startPendingQuery → first
 * Arrow batch; async = conn.send(sql) → first RecordBatch from the stream reader.
 */
import * as duckdb from '@duckdb/duckdb-wasm';
import coiWasm from '@duckdb/duckdb-wasm/dist/duckdb-coi.wasm?url';
import coiWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-coi.worker.js?url';
import coiPthread from '@duckdb/duckdb-wasm/dist/duckdb-browser-coi.pthread.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { bootDuckDB } from '../src/engine/database';
import { VESSELS_SQL } from '../src/engine/dataset';

const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent) => void) | null; crossOriginIsolated: boolean };

export const QUERIES: Record<string, string> = {
  minute_vessel_week: "SELECT date_trunc('minute', ts) AS t, vessel, avg(speed) AS speed FROM telemetry WHERE ts < TIMESTAMP '2026-09-08' GROUP BY ALL ORDER BY 1, 2",
  hourly_vessel: "SELECT time_bucket(INTERVAL '1 hour', ts) AS hour, vessel, avg(wind) AS wind FROM telemetry GROUP BY ALL ORDER BY 1, 2",
  per_vessel: 'SELECT vessel, avg(speed) AS speed FROM telemetry GROUP BY vessel ORDER BY vessel',
  hourly_7d: "SELECT time_bucket(INTERVAL '1 hour', ts) AS hour, avg(speed) AS speed FROM telemetry WHERE ts >= TIMESTAMP '2026-09-14 23:59:54' - INTERVAL '7 days' GROUP BY 1 ORDER BY 1",
  scalar_max: 'SELECT max(wave_height) AS m FROM telemetry',
};

const quantiles = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(2);
  return { n: s.length, p50: at(0.5), p95: at(0.95), min: at(0), max: at(1) };
};

async function blocking(repeats: number) {
  const { bindings, stats } = await bootDuckDB();
  const c = bindings.connect(); const conn = c.useUnsafe((_, id) => id);
  const first = (sql: string) => {
    const t0 = performance.now();
    let h = bindings.startPendingQuery(conn, sql, true);
    while (h === null) h = bindings.pollPendingQuery(conn);
    let chunk; do chunk = bindings.fetchQueryResults(conn); while (chunk === null);
    const ms = performance.now() - t0;
    while (chunk && chunk.byteLength) chunk = bindings.fetchQueryResults(conn);
    return ms;
  };
  const g0 = performance.now(); first(VESSELS_SQL); const generateMs = performance.now() - g0;
  const out: Record<string, unknown> = { boot: stats, generateMs };
  for (const [name, sql] of Object.entries(QUERIES)) {
    first(sql);
    const t: number[] = []; for (let i = 0; i < repeats; i++) t.push(first(sql));
    out[name] = quantiles(t);
  }
  c.close();
  return out;
}

async function asyncDb(kind: 'coi' | 'eh', threads: number[], repeats: number) {
  const bundle = kind === 'coi'
    ? { mainModule: coiWasm, mainWorker: coiWorker, pthreadWorker: coiPthread }
    : { mainModule: ehWasm, mainWorker: ehWorker };
  const worker = new Worker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  const i0 = performance.now();
  await db.instantiate(bundle.mainModule, (bundle as { pthreadWorker?: string }).pthreadWorker ?? null);
  await db.open({ path: ':memory:', maximumThreads: Math.max(...threads) } as duckdb.DuckDBConfig);
  const instantiateMs = performance.now() - i0;
  const conn = await db.connect();
  const first = async (sql: string) => {
    const t0 = performance.now();
    const reader = await conn.send(sql, true);
    const it = reader[Symbol.asyncIterator]();
    await it.next();
    const ms = performance.now() - t0;
    for (;;) { const r = await it.next(); if (r.done) break; }
    return ms;
  };
  const g0 = performance.now(); await conn.query(VESSELS_SQL); const generateMs = performance.now() - g0;
  const out: Record<string, unknown> = { instantiateMs, generateMs, version: await db.getVersion() };
  for (const n of threads) {
    try { await conn.query(`SET threads = ${n}`); } catch (e) { out[`threads${n}`] = { error: String(e).slice(0, 200) }; continue; }
    const actual = (await conn.query("SELECT current_setting('threads') AS t")).getChildAt(0)!.get(0);
    const r: Record<string, unknown> = { actual: Number(actual) };
    for (const [name, sql] of Object.entries(QUERIES)) {
      await first(sql);
      const t: number[] = []; for (let i = 0; i < repeats; i++) t.push(await first(sql));
      r[name] = quantiles(t);
    }
    out[`threads${n}`] = r;
  }
  await conn.close(); await db.terminate(); worker.terminate();
  return out;
}

scope.onmessage = async event => {
  const { repeats = 9, threads = [1, 2, 4] } = (event.data ?? {}) as { repeats?: number; threads?: number[] };
  const result: Record<string, unknown> = { crossOriginIsolated: scope.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency };
  try {
    result.blockingEh = await blocking(repeats);
    result.asyncEh = await asyncDb('eh', [1], repeats);
    result.asyncCoi = await asyncDb('coi', threads, repeats);
    scope.postMessage({ ok: true, result });
  } catch (error) {
    scope.postMessage({ ok: false, error: String((error as Error)?.stack ?? error), result });
  }
};
