#!/usr/bin/env node
// Database first-batch benchmark + exactness check (evals/database-bench.ts, docs/batch-2/database.md).
//
//   node scripts/bench-database.mjs [--repeats 5] [--json docs/batch-2/database-bench.json] [--limit n] [--no-models]
//                                   [--load generated|parquet|prebuilt]
//
// --load: how the optimized node gets `vessels` (the baseline is always generated in the engine):
// prebuilt = public/data/vessels/vessels.duckdb with its rollups (scripts/build-datasets.mjs),
// parquet = public/data/vessels/telemetry.parquet (rollups built here).
//
// Runs every corpus reference statement ($SINCE expanded) and every saved model statement from
// docs/batch-1/eval-*.json on a baseline node (batch-1 behaviour) and an optimized node (compressed
// storage + rollups + result cache), checks results are identical, then times EXEC → first batch,
// paired and interleaved. Exits non-zero on any mismatch.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg, platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const repeats = Number(option('--repeats', '5'));
const limit = Number(option('--limit', '0'));
const { module: lib } = await runnerImport(resolve(root, 'evals/database-bench.ts'), { root, configFile: false, logLevel: 'error' });
const corpus = JSON.parse(readFileSync(resolve(root, 'evals/sql-corpus.json'), 'utf8'));
const reportFiles = args.includes('--no-models') ? [] : readdirSync(resolve(root, 'docs/batch-1')).filter(f => /^eval-.*\.json$/.test(f));
const reports = reportFiles.map(f => JSON.parse(readFileSync(resolve(root, 'docs/batch-1', f), 'utf8')));
let list = lib.statements(corpus, reports);
if (limit) list = list.slice(0, limit);
const log = (...a) => console.error(...a);
// The engine yields through an unref'd MessageChannel; keep Node alive while it works.
const keepAlive = setInterval(() => {}, 1000);
const round = v => v === undefined ? undefined : Number(v.toFixed(2));

const out = {
  kind: 'time-blast.database-bench', version: 1, date: new Date().toISOString(),
  environment: { node: process.version, platform: platform(), arch: arch(), cpus: cpus().length, loadavgAtStart: loadavg().map(v => +v.toFixed(1)), duckdbWasm: '1.32.0 (node-blocking, eh)' },
  load: option('--load', 'generated'),
  method: `EXEC → first BATCH (ExecStats.firstBatchMs, worker-side performance.now()), ${repeats} paired interleaved repeats after one warm-up each; optimized result cache cleared before every timed run (rewrite memo kept: steady state); cold rewrite = first execution`,
};

log('opening baseline (default catalog, no rollups, no cache) …');
const base = await lib.openNode({ rollups: false, resultCache: false, compressed: false });
log('opening optimized (compressed catalog, rollups, cache) …');
const load = option('--load', 'generated');
const opt = await lib.openNode(lib.manifestOptions(root, load), undefined, load === 'parquet');
const during = [];
const probe = "SELECT date_trunc('minute', ts) AS t, vessel, avg(speed) AS speed FROM telemetry WHERE ts < TIMESTAMP '2026-09-08' GROUP BY ALL ORDER BY 1, 2";
let building = true;
opt.rollupsDone.then(() => { building = false; });
const b0 = performance.now();
while (building && during.length < 20) { opt.node.cache?.clear(); const o = await opt.run(probe); during.push({ atMs: round(performance.now() - b0), firstBatchMs: round(o.stats.firstBatchMs), source: o.stats.source }); }
await opt.rollupsDone;
const buildMs = performance.now() - b0;
out.load = {
  baselineOpenMs: round(base.openMs), optimizedOpenMs: round(opt.openMs),
  rollups: opt.rollups, rollupWallMs: round(buildMs),
  memory: { baseline: await base.memory(), optimized: await opt.memory() },
  queriesDuringBuild: during,
};
log(JSON.stringify(out.load));

// Correctness, with the first (cold) rewrite cost.
const results = [];
let mismatches = 0;
for (const [i, { sql, origin }] of list.entries()) {
  const a = await base.run(sql);
  opt.node.cache?.clear();
  const b = await opt.run(sql);
  const same = lib.sameResult(sql, a, b);
  if (!same.exact) { mismatches++; log(`MISMATCH ${origin}: ${same.reason}\n  ${sql.replace(/\s+/g, ' ').slice(0, 300)}`); }
  results.push({ origin, sql, ok: a.ok, code: a.code, rows: a.rows.length, source: b.stats.source, grain: b.stats.grain, rewrite: b.stats.rewrite, fallback: b.stats.fallback,
    coldRewriteMs: round(b.stats.rewriteMs), exact: same.exact, reason: same.reason, maxRel: same.maxRel || undefined });
  if (i % 25 === 0) log(`checked ${i + 1}/${list.length}`);
}
log(`exactness: ${list.length - mismatches}/${list.length} identical`);

// Timing.
for (const [i, r] of results.entries()) {
  if (!r.ok) continue;
  const bt = [], ot = [], rw = [];
  await base.run(r.sql); opt.node.cache?.clear(); await opt.run(r.sql);
  for (let k = 0; k < repeats; k++) {
    const flip = k % 2 === 1;
    const runBase = async () => { bt.push((await base.run(r.sql)).stats.firstBatchMs); };
    const runOpt = async () => { opt.node.cache?.clear(); const o = await opt.run(r.sql); ot.push(o.stats.firstBatchMs); if (o.stats.rewriteMs !== undefined) rw.push(o.stats.rewriteMs); };
    if (flip) { await runOpt(); await runBase(); } else { await runBase(); await runOpt(); }
  }
  // Result cache: the statement was just executed, so this is a hit.
  const hit = await opt.run(r.sql);
  Object.assign(r, { base: lib.quantiles(bt.filter(v => v !== undefined)), opt: lib.quantiles(ot.filter(v => v !== undefined)), rewriteMs: lib.quantiles(rw),
    cacheHit: hit.stats.source === 'cache' ? round(hit.stats.firstBatchMs) : undefined });
  if (i % 25 === 0) log(`timed ${i + 1}/${results.length}`);
}

// Summaries: per class, p50/p95 over the per-statement medians.
const summarize = rows => {
  const t = rows.filter(r => r.base && r.opt);
  return { statements: t.length, baseP50: lib.quantiles(t.map(r => r.base.p50))?.p50, baseP95: lib.quantiles(t.map(r => r.base.p50))?.p95,
    optP50: lib.quantiles(t.map(r => r.opt.p50))?.p50, optP95: lib.quantiles(t.map(r => r.opt.p50))?.p95,
    baseTotalMs: round(t.reduce((s, r) => s + r.base.p50, 0)), optTotalMs: round(t.reduce((s, r) => s + r.opt.p50, 0)),
    cacheHitP50: lib.quantiles(t.map(r => r.cacheHit).filter(v => v !== undefined))?.p50 };
};
const classOf = r => r.source === 'rollup' ? `rollup ${r.grain}` : r.source === 'raw' ? 'raw (not rewritten)' : r.source;
out.summary = {
  identical: list.length - mismatches, statements: list.length,
  all: summarize(results), references: summarize(results.filter(r => r.origin !== 'model')), models: summarize(results.filter(r => r.origin === 'model')),
  byClass: Object.fromEntries([...new Set(results.map(classOf))].sort().map(c => [c, summarize(results.filter(r => classOf(r) === c))])),
  rewriteCold: lib.quantiles(results.map(r => r.coldRewriteMs).filter(v => v !== undefined)),
  notRewrittenReasons: Object.entries(results.filter(r => r.source === 'raw' && r.ok).reduce((m, r) => { const k = (r.rewrite ?? '').replace(/ [a-z_]+\(\)$/, ''); m[k] = (m[k] ?? 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]),
};
out.environment.loadavgAtEnd = loadavg().map(v => +v.toFixed(1));
out.results = results;
console.log(JSON.stringify(out.summary, null, 1));
const json = option("--json");
if (json) writeFileSync(resolve(root, json), JSON.stringify(out, null, 1) + '\n');
base.node.dispose(); opt.node.dispose();
clearInterval(keepAlive);
process.exit(mismatches ? 1 : 0);
