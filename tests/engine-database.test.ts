/**
 * Database node on DuckDB-Wasm's node-blocking bundle: the same Wasm engine and bindings API
 * as the browser-blocking bundle the engine worker uses. No network: Parquet (an extension
 * fetched from extensions.duckdb.org) is not loaded here; the browser smoke covers it.
 */
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { RecordBatch, Schema } from 'apache-arrow';
import { DuckDatabaseNode, lockDown, type DuckBindings, type ExecStats } from '../src/engine/database-node';
import { guardSql, unwrapError } from '../src/engine/sql-guard';
import type { DatasetContext, LocalFrame } from '../src/engine/contracts';
import { header, Kind, readJson, Stage, text, type Frame } from '../src/protocol/frame';
import { tableNameFor } from '../src/engine/dataset';
import { yieldToEventLoop } from '../src/engine/yield';

const require = createRequire(import.meta.url);
const dist = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs').replace(/[^/]+$/, '');

let db: DuckBindings & { open(config: object): void };
const chunks: Uint8Array[] = [];

beforeAll(async () => {
  const duck = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
  const bindings = await duck.createDuckDB({
    mvp: { mainModule: `${dist}duckdb-mvp.wasm`, mainWorker: '' },
    eh: { mainModule: `${dist}duckdb-eh.wasm`, mainWorker: '' },
  }, new duck.VoidLogger(), duck.NODE_RUNTIME);
  await bindings.instantiate();
  bindings.open({ query: { queryPollingInterval: 4 } });
  // Record every Arrow message DuckDB hands out, to check batches are views into them.
  const fetch = bindings.fetchQueryResults.bind(bindings);
  bindings.fetchQueryResults = (conn: number) => { const chunk = fetch(conn); if (chunk) chunks.push(chunk); return chunk; };
  db = bindings;
  await lockDown(db, { parquet: false });
}, 60_000);

type Collected = { frames: LocalFrame[]; stats: ExecStats[] };
function makeNode(options: ConstructorParameters<typeof DuckDatabaseNode>[2] = {}): { node: DuckDatabaseNode } & Collected {
  const frames: LocalFrame[] = [], stats: ExecStats[] = [];
  const node = new DuckDatabaseNode(db, frame => frames.push(frame), { ...options, onExecStats: s => stats.push(s) });
  return { node, frames, stats };
}
const exec = (sql: string, fields: Partial<Frame> = {}): Frame => ({ ...header(Kind.EXEC, { request: 1, epoch: 1, context: 7, revision: 3, ...fields }), stamps: [], payload: text(sql) });
const cancel = (epoch: number, request = 0): Frame => ({ ...header(Kind.CANCEL, { epoch, request }), stamps: [], payload: new Uint8Array(0) });
const settle = async (collected: Collected, count: number) => {
  for (let i = 0; i < 2000 && collected.stats.length < count; i++) await new Promise(resolve => setTimeout(resolve, 2));
};
const kinds = (frames: LocalFrame[]) => frames.filter(f => f.kind !== Kind.STATUS).map(f => f.kind);
const errorOf = (frames: LocalFrame[]) => readJson<{ code: string; message: string }>(frames.find(f => f.kind === Kind.ERROR)!.payload as Uint8Array);

describe('SQL guard (DuckDB tokenizer + subquery wrapper)', () => {
  it('accepts one statement, trailing semicolons and comments, and wraps it', () => {
    expect(guardSql('SELECT 1', db)).toEqual({ ok: true, sql: 'SELECT * FROM (SELECT 1\n)' });
    expect(guardSql("-- view: line\nselect ';' as x; -- done\n ;", db)).toEqual({ ok: true, sql: "SELECT * FROM (-- view: line\nselect ';' as x\n)" });
    expect(guardSql('select $$a;b$$, "c;d" from t /* ; */', db).ok).toBe(true);
  });
  it('rejects multiple statements and empty input', () => {
    expect(guardSql('select 1; drop table telemetry', db)).toMatchObject({ ok: false, code: 'multiple_statements' });
    expect(guardSql('select 1) ; drop table x; select * from (select 1', db)).toMatchObject({ ok: false, code: 'multiple_statements' });
    expect(guardSql('  -- nothing\n', db)).toMatchObject({ ok: false, code: 'empty' });
    expect(guardSql(';', db)).toMatchObject({ ok: false, code: 'empty' });
  });
  it('maps DuckDB error positions back to the unwrapped SQL', () => {
    const raw = 'Parser Error: syntax error at or near "fro"\n\nLINE 1: SELECT * FROM (selec 1 fro x\n                                ^';
    expect(unwrapError(raw)).toBe('Parser Error: syntax error at or near "fro"\n\nLINE 1: selec 1 fro x\n                 ^');
  });
  it('measures guard cost', () => {
    const sql = "-- view: line\nSELECT date_trunc('hour', ts) AS t, vessel, avg(speed) AS speed FROM telemetry WHERE ts >= TIMESTAMP '2026-09-03' GROUP BY ALL ORDER BY 1";
    for (let i = 0; i < 200; i++) guardSql(sql, db);
    const n = 2000, t0 = performance.now();
    for (let i = 0; i < n; i++) guardSql(sql, db);
    console.log(`[engine-database] guard ${(((performance.now() - t0) / n) * 1000).toFixed(1)} µs for ${sql.length} chars (Node)`);
  });
});

describe('database node', () => {
  const ctx = { frames: [] as LocalFrame[], context: undefined as unknown as DatasetContext };
  let open: { loadMs: number; contextMs: number; statisticsMs: number } | undefined;

  beforeAll(async () => {
    const node = new DuckDatabaseNode(db, frame => ctx.frames.push(frame), { onOpenStats: s => { open = s; } });
    ctx.context = await node.open({ kind: 'fixture', name: 'vessels' }, 7);
    node.dispose();
  }, 60_000);

  it('opens the vessels fixture with a TIMESTAMP time column, VARCHAR vessels and statistics', () => {
    const context = ctx.context;
    console.log(`[engine-database] vessels open: load ${open!.loadMs.toFixed(0)} ms, context ${open!.contextMs.toFixed(0)} ms (statistics query ${open!.statisticsMs.toFixed(0)} ms) (Node)`);
    expect(context).toMatchObject({ id: 7, name: 'vessels', dialect: 'duckdb' });
    const [table] = context.tables;
    expect(table.name).toBe('telemetry');
    expect(table.rows).toBe(1_209_600);
    const byName = Object.fromEntries(table.columns.map(c => [c.name, c]));
    expect(byName.ts).toEqual({ name: 'ts', type: 'TIMESTAMP', min: '2026-09-01 00:00:00', max: '2026-09-14 23:59:54' });
    expect(byName.vessel).toEqual({ name: 'vessel', type: 'VARCHAR', distinct: 6, values: ['Atlas', 'Aurora', 'Kestrel', 'Meridian', 'Nomad', 'Solstice'] });
    expect(byName.speed).toMatchObject({ type: 'DOUBLE', min: 6.04, max: 18.4 });
    expect(table.sample).toHaveLength(3);
    expect(table.sample![0][0]).toBe('2026-09-01 00:00:00');
    expect(typeof table.sample![0][2]).toBe('number');
    const status = ctx.frames.filter(f => f.kind === Kind.STATUS).map(f => readJson<{ state: string }>(f.payload as Uint8Array).state);
    expect(status.at(-1)).toBe('ready');
  });

  it('streams RESULT_SCHEMA, BATCH (Arrow objects, views into DuckDB messages) and DONE with stamps', async () => {
    const run = makeNode();
    (run.node as unknown as { contextId: number }).contextId = 7; // same DuckDB instance, context opened above
    chunks.length = 0;
    run.node.handle(exec("SELECT ts, vessel, speed FROM telemetry WHERE ts < TIMESTAMP '2026-09-01 01:00:00' ORDER BY ts, vessel"));
    await settle(run, 1);
    expect(kinds(run.frames)[0]).toBe(Kind.RESULT_SCHEMA);
    expect(kinds(run.frames).at(-1)).toBe(Kind.DONE);
    const schema = run.frames[0].payload as Schema;
    expect(schema).toBeInstanceOf(Schema);
    expect(schema.fields.map(f => `${f.name}:${f.type}`)).toEqual(['ts:Timestamp<MICROSECOND>', 'vessel:Utf8', 'speed:Float64']);
    const batches = run.frames.filter(f => f.kind === Kind.BATCH);
    expect(batches.length).toBeGreaterThan(0);
    let rows = 0;
    for (const f of batches) {
      const batch = f.payload as RecordBatch;
      expect(batch).toBeInstanceOf(RecordBatch);
      rows += batch.numRows;
      const values = batch.getChild('speed')!.data[0].values;
      expect(chunks.some(chunk => chunk.buffer === values.buffer)).toBe(true);
    }
    expect(rows).toBe(600 * 6);
    const done = run.frames.at(-1)! as Frame;
    const view = new DataView(done.payload.buffer, done.payload.byteOffset, 16);
    expect(Number(view.getBigUint64(0, true))).toBe(3600);
    expect(Number(view.getBigUint64(8, true))).toBe(run.stats[0].bytes);
    for (const f of run.frames) expect(f).toMatchObject({ request: 1, epoch: 1, context: 7, revision: 3 });
    expect(run.frames[0].stamps.map(s => s.stage)).toEqual([Stage.EXEC_RECEIVED]);
    expect(batches[0].stamps.map(s => s.stage)).toEqual([Stage.DB_FIRST_BATCH]);
    expect(done.stamps.map(s => s.stage)).toEqual([Stage.DB_DONE]);
    expect(batches[0].stamps[0].at).toBeGreaterThanOrEqual(run.frames[0].stamps[0].at);
  });

  it('measures a 60k-row aggregate', async () => {
    const run = makeNode();
    (run.node as unknown as { contextId: number }).contextId = 7;
    // 14 days × 24 h × 60 min × 6 vessels = 120,960 rows; half the period → 60,480 rows.
    const sql = "SELECT date_trunc('minute', ts) AS t, vessel, avg(speed) AS speed FROM telemetry WHERE ts < TIMESTAMP '2026-09-08' GROUP BY ALL ORDER BY 1, 2";
    for (let i = 0; i < 4; i++) {
      run.node.handle(exec(sql, { request: i + 1 }));
      await settle(run, i + 1);
    }
    const s = run.stats.at(-1)!;
    console.log(`[engine-database] 60k aggregate (Node, warm): guard ${(s.guardMs * 1000).toFixed(0)} µs, schema ${s.schemaMs!.toFixed(1)} ms, first batch ${s.firstBatchMs!.toFixed(1)} ms, done ${s.doneMs!.toFixed(1)} ms, ${s.batches} batches, ${s.polls} polls, ${s.fetchRetries} retries, ${s.yields} yields, ${s.rows} rows, ${s.bytes} bytes`);
    expect(s.rows).toBe(60_480);
    expect(s.outcome).toBe('done');
  });

  it('rejects writes, settings, file access and multiple statements', async () => {
    const run = makeNode();
    (run.node as unknown as { contextId: number }).contextId = 7;
    const cases: Array<[string, string]> = [
      ['DROP TABLE telemetry', 'sql_error'],
      ['CREATE TABLE x AS SELECT 1', 'sql_error'],
      ["SET memory_limit = '4GB'", 'sql_error'],
      ["COPY telemetry TO '/upload/x.csv'", 'sql_error'],
      ["ATTACH ':memory:' AS y", 'sql_error'],
      ['BEGIN TRANSACTION', 'sql_error'],
      ["SELECT * FROM read_csv('/etc/passwd')", 'sql_error'],
      ["SELECT * FROM read_csv('https://example.com/a.csv')", 'sql_error'],
      ["FROM query('DROP TABLE telemetry')", 'sql_error'],
      ['SELECT 1; DROP TABLE telemetry', 'sql_rejected'],
    ];
    for (const [i, [sql]] of cases.entries()) {
      run.node.handle(exec(sql, { request: i + 1 }));
      await settle(run, i + 1);
    }
    const errors = run.frames.filter(f => f.kind === Kind.ERROR).map(f => [f.request, readJson<{ code: string }>(f.payload as Uint8Array).code]);
    expect(errors).toEqual(cases.map(([, code], i) => [i + 1, code]));
    // The table survived.
    run.node.handle(exec('SELECT count(*) AS n FROM telemetry', { request: 99 }));
    await settle(run, cases.length + 1);
    expect(run.stats.at(-1)!.outcome).toBe('done');
  });

  it('accepts read-only shapes: WITH, VALUES, FROM-first, DESCRIBE, SUMMARIZE, view comment', async () => {
    const run = makeNode();
    (run.node as unknown as { contextId: number }).contextId = 7;
    const sqls = ['WITH a AS (SELECT 1 AS x) SELECT * FROM a', 'VALUES (1), (2)', 'FROM telemetry LIMIT 2', 'DESCRIBE telemetry',
      'SUMMARIZE (SELECT speed FROM telemetry LIMIT 10)', '-- view: bar\nSELECT vessel, max(speed) FROM telemetry GROUP BY 1;'];
    for (const [i, sql] of sqls.entries()) {
      run.node.handle(exec(sql, { request: i + 1 }));
      await settle(run, i + 1);
    }
    expect(run.stats.map(s => s.outcome)).toEqual(sqls.map(() => 'done'));
  });

  it('CANCEL: targeted stops one request; full (request 0) stops everything and fences older epochs', async () => {
    const run = makeNode();
    (run.node as unknown as { contextId: number }).contextId = 7;
    const slow = 'SELECT a.vessel, count(*) FROM telemetry a JOIN telemetry b ON a.vessel = b.vessel AND a.ts = b.ts GROUP BY 1';
    // Targeted CANCEL (epoch unchanged): stops request 1 only; queued request 5 still runs.
    run.node.handle(exec(slow, { request: 1, epoch: 1 }));
    run.node.handle(exec('SELECT 5 AS five', { request: 5, epoch: 1 }));
    run.node.handle(cancel(1, 1));
    await settle(run, 2);
    expect(run.stats.map(s => [s.request, s.outcome])).toEqual([[1, 'canceled'], [5, 'done']]);
    expect(run.frames.filter(f => f.kind === Kind.DONE).map(f => f.request)).toEqual([5]);
    run.stats.splice(0, 1);

    run.node.handle(exec(slow, { request: 2, epoch: 2 }));
    // Node drains MessagePort messages ahead of timers, so interleave through the same
    // channel the node yields on: the CANCEL lands between two polls.
    for (let i = 0; i < 3; i++) await yieldToEventLoop();
    run.node.handle(cancel(3, 0));
    await settle(run, 2);
    console.log('[engine-database] cancel-by-epoch stats', JSON.stringify(run.stats[1]));
    expect(run.stats[1].outcome).toBe('canceled');

    run.node.handle(exec('SELECT 1', { request: 3, epoch: 2 })); // older than epoch 3: dropped
    expect(run.node.dropped).toBe(1);
    run.node.handle(exec('SELECT 1', { request: 4, epoch: 3 }));
    await settle(run, 3);
    expect(run.stats[2]).toMatchObject({ request: 4, outcome: 'done' });
    // The connection is usable after cancellation.
    expect(run.frames.filter(f => f.request === 4).map(f => f.kind)).toEqual([Kind.RESULT_SCHEMA, Kind.BATCH, Kind.DONE]);
  });

  it('enforces row, byte and time limits', async () => {
    const run = makeNode({ limits: { maxRows: 5000 } });
    (run.node as unknown as { contextId: number }).contextId = 7;
    run.node.handle(exec('SELECT * FROM telemetry', { request: 1 }));
    await settle(run, 1);
    expect(errorOf(run.frames).code).toBe('result_limit');
    const rows = run.frames.filter(f => f.kind === Kind.BATCH).reduce((n, f) => n + (f.payload as RecordBatch).numRows, 0);
    expect(rows).toBeLessThanOrEqual(5000);

    const timed = makeNode({ limits: { timeMs: 5 } });
    (timed.node as unknown as { contextId: number }).contextId = 7;
    timed.node.handle(exec('SELECT a.vessel, count(*) FROM telemetry a JOIN telemetry b ON a.vessel = b.vessel AND a.ts = b.ts GROUP BY 1'));
    await settle(timed, 1);
    expect(errorOf(timed.frames).code).toBe('timeout');
  });

  it('drops EXEC for another context and runs queued EXECs in order', async () => {
    const run = makeNode();
    (run.node as unknown as { contextId: number }).contextId = 7;
    run.node.handle(exec('SELECT 1', { context: 6 }));
    expect(run.node.dropped).toBe(1);
    run.node.handle(exec('SELECT 1 AS a', { request: 10 }));
    run.node.handle(exec('SELECT 2 AS b', { request: 11 }));
    await settle(run, 2);
    expect(run.frames.filter(f => f.kind === Kind.DONE).map(f => f.request)).toEqual([10, 11]);
  });

  it('reports SQL errors with the model\'s own SQL in the message', async () => {
    const run = makeNode();
    (run.node as unknown as { contextId: number }).contextId = 7;
    run.node.handle(exec('SELECT nope FROM telemetry'));
    await settle(run, 1);
    const error = errorOf(run.frames);
    expect(error.code).toBe('sql_error');
    expect(error.message).toMatch(/nope/);
    expect(error.message).not.toMatch(/SELECT \* FROM \(/);
  });
});

describe('dropped files', () => {
  it('loads a CSV file as a table named after the file and replaces the previous dataset', async () => {
    const frames: LocalFrame[] = [];
    const node = new DuckDatabaseNode(db, f => frames.push(f));
    const file = new File(['city,temp,when\nOslo,3.5,2026-01-01\nRome,14.25,2026-01-02\nOslo,4,2026-01-03\n'], 'My Weather 2026.csv');
    const context = await node.open({ kind: 'file', name: 'My Weather 2026.csv', file }, 9);
    expect(context.tables.map(t => t.name)).toEqual(['my_weather_2026']);
    const [table] = context.tables;
    expect(table.rows).toBe(3);
    expect(table.columns).toEqual([
      { name: 'city', type: 'VARCHAR', distinct: 2, values: ['Oslo', 'Rome'] },
      { name: 'temp', type: 'DOUBLE', min: 3.5, max: 14.25 },
      { name: 'when', type: 'DATE', min: '2026-01-01', max: '2026-01-03' },
    ]);
    frames.length = 0;
    node.handle(exec('SELECT avg(temp) FROM my_weather_2026', { context: 9 }));
    for (let i = 0; i < 100 && !frames.some(f => f.kind === Kind.DONE); i++) await new Promise(r => setTimeout(r, 2));
    expect(frames.map(f => f.kind)).toEqual([Kind.RESULT_SCHEMA, Kind.BATCH, Kind.DONE]);
    node.dispose();
  });

  it('names tables safely', () => {
    expect(tableNameFor('2024 Sales (final).CSV')).toBe('t_2024_sales_final');
    expect(tableNameFor('/x/y/Data.parquet')).toBe('data');
    expect(tableNameFor('...')).toBe('data');
  });
});
