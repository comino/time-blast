/**
 * Browser smoke for the database node (driven by tests/engine_smoke.py via engine-smoke.html).
 * Runs the real DuckDB-Wasm blocking bundle in a module worker exactly as the engine worker
 * does, then measures load, statistics, guard, yield and EXEC timings. Results are posted
 * back as one JSON object.
 */
import { RecordBatch, Schema } from 'apache-arrow';
import { bootDuckDB, fixtureUrl } from '../src/engine/database';
import { DuckDatabaseNode, type ExecStats } from '../src/engine/database-node';
import { guardSql } from '../src/engine/sql-guard';
import { yieldToEventLoop } from '../src/engine/yield';
import type { LocalFrame } from '../src/engine/contracts';
import { header, Kind, readJson, Stage, text, type Frame } from '../src/protocol/frame';

const scope = self as unknown as { postMessage(message: unknown): void; crossOriginIsolated: boolean; onmessage: unknown };

const quantiles = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(3);
  return { n: sorted.length, min: at(0), p50: at(0.5), p95: at(0.95), max: at(1) };
};

async function run() {
  const out: Record<string, unknown> = { crossOriginIsolated: scope.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined' };
  const t0 = performance.now();
  const { bindings, stats } = await bootDuckDB();
  out.boot = stats;

  const frames: LocalFrame[] = [];
  const execStats: ExecStats[] = [];
  let openStats: unknown;
  let waiter: ((s: ExecStats) => void) | undefined;
  const node = new DuckDatabaseNode(bindings, f => frames.push(f), {
    fixtureUrl, onExecStats: s => { execStats.push(s); waiter?.(s); }, onOpenStats: s => { openStats = s; },
  });

  let o0 = performance.now();
  const context = await node.open({ kind: 'fixture', name: 'vessels' }, 1);
  out.openVessels = { ...(openStats as object), totalMs: performance.now() - o0, rows: context.tables[0].rows, columns: context.tables[0].columns };
  out.bootToReadyMs = performance.now() - t0;

  let request = 0, epoch = 1;
  const exec = (sql: string) => new Promise<{ stats: ExecStats; frames: LocalFrame[]; handleMs: number }>(resolve => {
    const id = ++request, start = frames.length;
    let handleMs = 0;
    // Small queries finish inside handle(): resolve after it returns so handleMs is set.
    waiter = s => { if (s.request === id) { waiter = undefined; queueMicrotask(() => resolve({ stats: s, frames: frames.slice(start), handleMs })); } };
    const h0 = performance.now();
    node.handle({ ...header(Kind.EXEC, { request: id, epoch, context: 1 }), stamps: [], payload: text(sql) });
    handleMs = performance.now() - h0;
  });

  console.log('[smoke] Guard and yield costs.');
  // Guard and yield costs.
  const guardSqlText = "-- view: line\nSELECT date_trunc('hour', ts) AS t, vessel, avg(speed) AS speed FROM telemetry WHERE ts >= TIMESTAMP '2026-09-03' GROUP BY ALL ORDER BY 1";
  const guardTimes: number[] = [];
  for (let i = 0; i < 1200; i++) { const g = performance.now(); guardSql(guardSqlText, bindings); if (i >= 200) guardTimes.push((performance.now() - g) * 1000); }
  out.guardUs = quantiles(guardTimes);
  const yieldTimes: number[] = [];
  for (let i = 0; i < 1200; i++) { const y = performance.now(); await yieldToEventLoop(); if (i >= 200) yieldTimes.push((performance.now() - y) * 1000); }
  out.yieldUs = quantiles(yieldTimes);

  console.log('[smoke] 60,480-row aggregate');
  // 60,480-row aggregate: one cold run, then warm repeats.
  const aggregate = "SELECT date_trunc('minute', ts) AS t, vessel, avg(speed) AS speed FROM telemetry WHERE ts < TIMESTAMP '2026-09-08' GROUP BY ALL ORDER BY 1, 2";
  const cold = await exec(aggregate);
  const warm: ExecStats[] = [];
  const stampFirst: number[] = [], stampDone: number[] = [], handles: number[] = [];
  let typesOk = true;
  for (let i = 0; i < 20; i++) {
    const r = await exec(aggregate);
    warm.push(r.stats);
    handles.push(r.handleMs);
    const schemaFrame = r.frames.find(f => f.kind === Kind.RESULT_SCHEMA)!;
    const firstBatch = r.frames.find(f => f.kind === Kind.BATCH)!;
    const done = r.frames.find(f => f.kind === Kind.DONE)!;
    typesOk &&= schemaFrame.payload instanceof Schema && firstBatch.payload instanceof RecordBatch;
    const received = schemaFrame.stamps.find(s => s.stage === Stage.EXEC_RECEIVED)!.at;
    stampFirst.push(firstBatch.stamps.find(s => s.stage === Stage.DB_FIRST_BATCH)!.at - received);
    stampDone.push(done.stamps.find(s => s.stage === Stage.DB_DONE)!.at - received);
  }
  out.arrowObjectsAreSharedClasses = typesOk;
  out.aggregate60k = {
    sql: aggregate,
    cold: cold.stats,
    warm: {
      guardMs: quantiles(warm.map(s => s.guardMs)), schemaMs: quantiles(warm.map(s => s.schemaMs!)),
      firstBatchMs: quantiles(warm.map(s => s.firstBatchMs!)), doneMs: quantiles(warm.map(s => s.doneMs!)),
      stampExecToFirstBatchMs: quantiles(stampFirst), stampExecToDoneMs: quantiles(stampDone),
      rows: warm[0].rows, bytes: warm[0].bytes, batches: warm[0].batches, polls: quantiles(warm.map(s => s.polls)),
      yields: quantiles(warm.map(s => s.yields)), fetchRetries: quantiles(warm.map(s => s.fetchRetries)),
      handleMs: quantiles(handles),
    },
  };

  console.log('[smoke] Streaming scan');
  // Streaming scan: first batch arrives long before the end.
  const scan = "SELECT ts, speed FROM telemetry WHERE vessel = 'Aurora' AND ts < TIMESTAMP '2026-09-12'";
  await exec(scan);
  const scans: ExecStats[] = [];
  for (let i = 0; i < 10; i++) scans.push((await exec(scan)).stats);
  out.scan = {
    sql: scan, rows: scans[0].rows, batches: scans[0].batches,
    firstBatchMs: quantiles(scans.map(s => s.firstBatchMs!)), doneMs: quantiles(scans.map(s => s.doneMs!)),
    yields: quantiles(scans.map(s => s.yields)), fetchRetries: quantiles(scans.map(s => s.fetchRetries)),
  };
  console.log('[smoke] Yield policy');
  // Yield policy: time-sliced (default, SLICE_MS) versus a yield after every batch.
  const everyBatch = new DuckDatabaseNode(bindings, () => {}, { sliceMs: 0, onExecStats: s => { execStats.push(s); waiter?.(s); } });
  (everyBatch as unknown as { contextId: number }).contextId = 1;
  const perBatch: ExecStats[] = [];
  for (let i = 0; i < 11; i++) {
    const id = ++request;
    const done = new Promise<ExecStats>(resolve => { waiter = st => { if (st.request === id) { waiter = undefined; resolve(st); } }; });
    everyBatch.handle({ ...header(Kind.EXEC, { request: id, epoch, context: 1 }), stamps: [], payload: text(scan) });
    const st = await done;
    if (i) perBatch.push(st);
  }
  everyBatch.dispose();
  out.scanYieldEveryBatch = { doneMs: quantiles(perBatch.map(st => st.doneMs!)), yields: quantiles(perBatch.map(st => st.yields)), batches: perBatch[0].batches };
  console.log('[smoke] Point lookup');
  // Point lookup: per-query floor.
  const tiny: ExecStats[] = [];
  for (let i = 0; i < 30; i++) tiny.push((await exec('SELECT 42 AS answer')).stats);
  out.tiny = { doneMs: quantiles(tiny.slice(5).map(s => s.doneMs!)), firstBatchMs: quantiles(tiny.slice(5).map(s => s.firstBatchMs!)) };

  console.log('[smoke] Cancellation latency');
  // Cancellation latency during execution (full CANCEL raises the epoch) and during streaming.
  const slow = 'SELECT a.vessel, count(*) FROM telemetry a JOIN telemetry b ON a.vessel = b.vessel AND a.ts = b.ts GROUP BY 1';
  // waitMs: how late the CANCEL's task ran (time spent waiting for the database loop to
  // yield); cancelToStopMs: handle(CANCEL) → the query reported stopped.
  const cancels: Array<{ phase: string; waitMs: number; cancelToStopMs: number; outcome: string }> = [];
  for (const [phase, sql, after] of [['execute', slow, 40], ['stream', 'SELECT * FROM telemetry', 5]] as const) {
    for (let i = 0; i < 5; i++) {
      const pending = exec(sql);
      const due = performance.now() + after;
      await new Promise(resolve => setTimeout(resolve, after));
      const c0 = performance.now();
      const waitMs = +(c0 - due).toFixed(3);
      epoch++;
      node.handle({ ...header(Kind.CANCEL, { epoch, request: 0 }), stamps: [], payload: new Uint8Array(0) });
      const r = await pending;
      cancels.push({ phase, waitMs, cancelToStopMs: +(performance.now() - c0).toFixed(3), outcome: r.stats.outcome });
    }
  }
  out.cancel = cancels;

  console.log('[smoke] Guard rejections');
  // Guard rejections end to end.
  const rejected: Record<string, string> = {};
  for (const sql of ['DROP TABLE telemetry', "SET memory_limit='4GB'", 'SELECT 1; SELECT 2', "SELECT * FROM read_csv('https://example.com/x.csv')"]) {
    const r = await exec(sql);
    const error = r.frames.find(f => f.kind === Kind.ERROR) as Frame | undefined;
    rejected[sql] = error ? readJson<{ code: string }>(error.payload).code : 'NOT REJECTED';
  }
  out.rejected = rejected;

  console.log('[smoke] Parquet fixture');
  // Parquet fixture and a dropped CSV file.
  o0 = performance.now();
  try {
    const small = await node.open({ kind: 'fixture', name: 'vessels-small' }, 2);
    out.openVesselsSmall = { ...(openStats as object), totalMs: performance.now() - o0, rows: small.tables[0].rows, columns: small.tables[0].columns.map(c => `${c.name}:${c.type}`) };
  } catch (error) { out.openVesselsSmall = { error: String(error) }; }
  const csv = new File([Array.from({ length: 5000 }, (_, i) => `${i},${i % 7 === 0 ? 'a' : 'b'},${(i * 0.5).toFixed(1)}`).join('\n')], 'drop test.csv');
  o0 = performance.now();
  const dropped = await node.open({ kind: 'file', name: 'drop test.csv', file: csv }, 3);
  out.openCsv = { ...(openStats as object), totalMs: performance.now() - o0, table: dropped.tables[0].name, rows: dropped.tables[0].rows, columns: dropped.tables[0].columns };
  out.statusFrames = frames.filter(f => f.kind === Kind.STATUS).length;
  out.dropped = node.dropped;
  return out;
}

scope.onmessage = () => {
  run().then(result => scope.postMessage({ ok: true, result }), error => scope.postMessage({ ok: false, error: String(error?.stack ?? error) }));
};
