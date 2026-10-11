#!/usr/bin/env node
// Database first-batch bench for the perf harness (docs/perf/README.md). A fixed subset of
// scripts/bench-database.mjs: only the optimized node (the app's defaults: compressed storage,
// rollups, result cache), only the corpus reference statements, no exactness pass (that is
// bench-database.mjs's job).
//
//   node scripts/perf/database.mjs [--repeats 3]  → JSON on stdout
//
// Per statement: one warm-up, then `--repeats` timed runs with the result cache cleared before
// each (EXEC → first BATCH, ExecStats.firstBatchMs, worker-side performance.now()). Statement order
// is reshuffled every repeat (fixed seed), so load spikes spread over all statements.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : fallback; };
const repeats = option('--repeats', 3);
const { module: lib } = await runnerImport(resolve(root, 'evals/database-bench.ts'), { root, configFile: false, logLevel: 'error' });
const corpus = JSON.parse(readFileSync(resolve(root, 'evals/sql-corpus.json'), 'utf8'));
const list = lib.statements(corpus, []);
const keepAlive = setInterval(() => {}, 1000);

const opened = performance.now();
const opt = await lib.openNode({});
await opt.rollupsDone;
const rollupWallMs = performance.now() - opened - opt.openMs;

let seed = 7;
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const shuffled = xs => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const times = new Map(list.map(s => [s.sql, []]));
const failed = new Set();
for (const { sql } of list) { opt.node.cache?.clear(); const o = await opt.run(sql); if (!o.ok) failed.add(sql); }
for (let k = 0; k < repeats; k++) {
  for (const { sql } of shuffled(list)) {
    if (failed.has(sql)) continue;
    opt.node.cache?.clear();
    const o = await opt.run(sql);
    if (o.stats?.firstBatchMs !== undefined) times.get(sql).push(o.stats.firstBatchMs);
  }
}
// Result-cache hits: each statement was just executed.
const hits = [];
for (const { sql } of list) { if (failed.has(sql)) continue; const o = await opt.run(sql); if (o.stats?.source === 'cache') hits.push(o.stats.firstBatchMs); }

const median = xs => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const perStatement = [...times.values()].filter(xs => xs.length).map(median);
opt.node.dispose();
clearInterval(keepAlive);
console.log(JSON.stringify({
  statements: list.length, timed: perStatement.length, errors: failed.size, repeats,
  openMs: opt.openMs, rollupWallMs,
  samples: { 'db.first_batch': perStatement, 'db.cache_hit': hits, 'db.open': [opt.openMs], 'db.rollup_build': [rollupWallMs] },
}));
process.exit(0);
