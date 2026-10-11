/**
 * Database first-batch benchmark and exactness check (docs/batch-2/database.md).
 *
 * Two `DuckDatabaseNode`s on separate DuckDB-Wasm instances (node-blocking bundle, same Wasm as
 * the browser), both with the `vessels` fixture:
 *   baseline  — batch-1 behaviour: default catalog, no rollups, no result cache
 *   optimized — the node's defaults: compressed catalog, background rollups + rewrite, result cache
 * Every statement (corpus references, $SINCE expanded, plus saved model SQL from eval reports) runs
 * on both; results must be identical: same column names (case-sensitive) and Arrow types, same
 * rows, values equal within the eval scorer's tolerance (1e-6 relative), in order when the
 * statement has ORDER BY. Timing is paired and interleaved: EXEC → first BATCH from ExecStats.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseManifest } from '../src/engine/datasets';
import type { RecordBatch, Schema } from 'apache-arrow';
import { DuckDatabaseNode, lockDown, type DuckBindings, type ExecStats, type RollupStats } from '../src/engine/database-node';
import type { DatasetSource, LocalFrame } from '../src/engine/contracts';
import { header, Kind, readJson, text } from '../src/protocol/frame';
import { compareResults, references, type Column, type Corpus } from './sql-eval';

type Value = number | string | boolean | null | Value[];
export interface Outcome {
  ok: boolean;
  code?: string;
  message?: string;
  names: string[];
  types: string[];
  columns: Column[];
  rows: Value[][];
  stats: ExecStats;
}

export interface BenchNode {
  node: DuckDatabaseNode;
  bindings: DuckBindings;
  openMs: number;
  rollups: RollupStats[];
  rollupsDone: Promise<void>;
  run(sql: string): Promise<Outcome>;
  memory(): Promise<string>;
}

async function bindings(parquet = false): Promise<DuckBindings> {
  const require = createRequire(import.meta.url);
  const bundle = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
  const dist = bundle.replace(/[^/]+$/, '');
  const duck = require(bundle);
  const db = await duck.createDuckDB({
    mvp: { mainModule: `${dist}duckdb-mvp.wasm`, mainWorker: '' },
    eh: { mainModule: `${dist}duckdb-eh.wasm`, mainWorker: '' },
  }, new duck.VoidLogger(), duck.NODE_RUNTIME);
  await db.instantiate();
  db.open({ query: { queryPollingInterval: 4 } });
  await lockDown(db as DuckBindings, { parquet });
  return db as DuckBindings;
}

const kindOf = (type: string): Column['kind'] =>
  /^Timestamp|^Date|^Time/.test(type) ? 'temporal' : /^(Int|Uint|Float|Decimal)/.test(type) ? 'numeric' : /Utf8/.test(type) ? 'text' : type === 'Bool' ? 'boolean' : 'other';

function plain(value: unknown): Value {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'object' && Symbol.iterator in (value as object)) return Array.from(value as Iterable<unknown>, plain);
  return String(value);
}

/** How the optimized node gets `vessels` (docs/batch-3/cold-start.md): generated in the engine
 * (the default), its Parquet file, or the prebuilt database (public/data, scripts/build-datasets.mjs). */
export type LoadMode = 'generated' | 'parquet' | 'prebuilt';

/** Node options that open fixtures from public/data/datasets.json the way the browser does. */
export function manifestOptions(root: string, mode: LoadMode): ConstructorParameters<typeof DuckDatabaseNode>[2] {
  if (mode === 'generated') return {};
  const file = (path: string) => resolve(root, 'public', path);
  return {
    manifest: async () => parseManifest(JSON.parse(readFileSync(file('data/datasets.json'), 'utf8'))),
    dataUrl: file,
    fetchBytes: async path => new Uint8Array(readFileSync(path)),
    prebuilt: mode === 'prebuilt',
    extensions: mode === 'prebuilt' ? ['json'] : ['json', 'parquet'],
  };
}

export async function openNode(options: ConstructorParameters<typeof DuckDatabaseNode>[2] = {}, source: DatasetSource = { kind: 'fixture', name: 'vessels' }, parquet = false): Promise<BenchNode> {
  const db = await bindings(parquet);
  let pending: { request: number; resolve: (o: Outcome) => void; out: Outcome } | undefined;
  const rollups: RollupStats[] = [];
  let rollupsResolve!: () => void;
  const rollupsDone = new Promise<void>(resolve => { rollupsResolve = resolve; });
  const node = new DuckDatabaseNode(db, (frame: LocalFrame) => {
    if (!pending || frame.request !== pending.request) return;
    const p = pending;
    if (frame.kind === Kind.RESULT_SCHEMA) {
      const schema = frame.payload as Schema;
      p.out.names = schema.fields.map(f => f.name);
      p.out.types = schema.fields.map(f => String(f.type));
      p.out.columns = schema.fields.map(f => ({ name: f.name, kind: kindOf(String(f.type)) }));
    } else if (frame.kind === Kind.BATCH) {
      const batch = frame.payload as RecordBatch;
      const cols = batch.schema.fields.map((_, i) => batch.getChildAt(i)!);
      for (let r = 0; r < batch.numRows; r++) p.out.rows.push(cols.map(c => plain(c.get(r))));
    } else if (frame.kind === Kind.ERROR) {
      const e = readJson<{ code: string; message: string }>(frame.payload as Uint8Array);
      p.out.ok = false; p.out.code = e.code; p.out.message = e.message;
    }
  }, {
    ...options,
    onRollupStats: s => { rollups.push(s); if (s.done) rollupsResolve(); options.onRollupStats?.(s); },
    onExecStats: s => {
      if (!pending || s.request !== pending.request) return;
      const p = pending; pending = undefined;
      p.out.stats = s;
      p.resolve(p.out);
    },
  });
  if (options.rollups === false) rollupsResolve();
  const t0 = performance.now();
  await node.open(source, 1);
  const openMs = performance.now() - t0;
  let request = 0;
  const run = (sql: string) => new Promise<Outcome>(resolve => {
    request++;
    pending = { request, resolve, out: { ok: true, names: [], types: [], columns: [], rows: [], stats: undefined as unknown as ExecStats } };
    node.handle({ ...header(Kind.EXEC, { request, epoch: 1, context: 1, revision: request }), stamps: [], payload: text(sql) });
  });
  const memory = async () => {
    const o = await run('SELECT memory_usage FROM pragma_database_size() LIMIT 1');
    return String(o.rows[0]?.[0]);
  };
  return { node, bindings: db, openMs, rollups, rollupsDone, run, memory };
}

/** Exactness of `b` against `a`: identical names/types/row count, values within tolerance, in
 * order when the statement orders. */
export function sameResult(sql: string, a: Outcome, b: Outcome): { exact: boolean; reason: string; maxRel: number } {
  if (!a.ok || !b.ok) {
    const same = a.ok === b.ok && a.code === b.code;
    return { exact: same, reason: same ? (a.ok ? '' : `both ${a.code}`) : `ok/code ${a.ok}/${a.code} vs ${b.ok}/${b.code}`, maxRel: 0 };
  }
  if (a.names.join('\u0000') !== b.names.join('\u0000')) return { exact: false, reason: `names ${a.names} vs ${b.names}`, maxRel: 0 };
  if (a.types.join('\u0000') !== b.types.join('\u0000')) return { exact: false, reason: `types ${a.types} vs ${b.types}`, maxRel: 0 };
  if (a.rows.length !== b.rows.length) return { exact: false, reason: `rows ${a.rows.length} vs ${b.rows.length}`, maxRel: 0 };
  const ordered = /\border\s+by\b/i.test(sql);
  const verdict = compareResults({ columns: a.columns, rows: a.rows }, { columns: b.columns, rows: b.rows }, ordered);
  let maxRel = 0;
  if (verdict.category === 'exact' && ordered) {
    for (let r = 0; r < a.rows.length; r++) for (let c = 0; c < a.names.length; c++) {
      const x = a.rows[r][c], y = b.rows[r][c];
      if (typeof x === 'number' && typeof y === 'number' && x !== y) maxRel = Math.max(maxRel, Math.abs(x - y) / Math.max(1, Math.abs(x), Math.abs(y)));
    }
  }
  return { exact: verdict.category === 'exact', reason: verdict.reason || verdict.category, maxRel };
}

export function statements(corpus: Corpus, reports: Array<{ cases: Array<{ sql?: string }> }>): Array<{ sql: string; origin: string }> {
  const seen = new Set<string>();
  const out: Array<{ sql: string; origin: string }> = [];
  for (const c of corpus.cases) for (const sql of references(c, corpus.now)) if (!seen.has(sql)) { seen.add(sql); out.push({ sql, origin: `ref:${c.id}` }); }
  for (const r of reports) for (const c of r.cases) if (c.sql && !seen.has(c.sql)) { seen.add(c.sql); out.push({ sql: c.sql, origin: 'model' }); }
  return out;
}

export function quantiles(values: number[]): { n: number; p50: number; p95: number; min: number; max: number } | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => +s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)].toFixed(2);
  return { n: s.length, p50: at(0.5), p95: at(0.95), min: +s[0].toFixed(2), max: +s[s.length - 1].toFixed(2) };
}
