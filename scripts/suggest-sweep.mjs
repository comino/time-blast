#!/usr/bin/env node
/**
 * Deterministic follow-up suggestions (src/ui/suggest.ts) over every SQL we have: the eval
 * corpus's references and every model SQL saved in docs/batch-*\/eval-*.json. For each base
 * statement that runs, every variant is executed on the generated `vessels` fixture (DuckDB-Wasm,
 * node-blocking bundle, the database node with rollups + result cache) and checked against the
 * invariants its label promises:
 *   split   one more column, at least as many rows      bucket  same columns, different row count
 *   window  same columns, at most as many rows           agg     same column count and row count
 *   view    identical rows (same SQL plus a view hint)
 * Prints a summary and exits non-zero on any failed variant.
 *
 *   node scripts/suggest-sweep.mjs [--json out.json]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const load = path => runnerImport(resolve(root, path), { root, configFile: false, logLevel: 'error' }).then(r => r.module);
const lib = await load('evals/sql-eval.ts');
const { suggest } = await load('src/ui/suggest.ts');

const corpus = JSON.parse(readFileSync(resolve(root, 'evals/sql-corpus.json'), 'utf8'));
const bases = new Map(); // sql → question
for (const c of corpus.cases) for (const sql of lib.references(c, corpus.now).slice(0, 1)) bases.set(sql, c.question);
for (const dir of ['docs/batch-1', 'docs/batch-2']) {
  for (const file of readdirSync(resolve(root, dir)).filter(f => /^eval-.*\.json$/.test(f))) {
    const report = JSON.parse(readFileSync(resolve(root, dir, file), 'utf8'));
    for (const c of report.cases ?? []) if (typeof c.sql === 'string' && c.sql.trim() && !bases.has(c.sql)) bases.set(c.sql, c.question);
  }
}

// The database node yields through MessageChannel turns, which do not keep Node's event loop
// alive on their own; without this the process can exit mid-open with an unsettled await.
const keepAlive = setInterval(() => {}, 1000);
const db = await lib.openDatabase();
console.error(`vessels generated in ${(db.generateMs / 1000).toFixed(1)} s; ${bases.size} base statements`);
const run = sql => Promise.race([db.run(sql), new Promise(resolve => setTimeout(() => resolve({ ok: false, code: 'no_answer', message: 'no DONE/ERROR within 30 s', rows: [] }), 30_000))]);
const context = db.context;
const stats = { bases: bases.size, basesRun: 0, withSuggestions: 0, variants: 0, ok: 0, failed: [], byKind: {}, genUs: [], perBase: [] };
const sig = r => JSON.stringify(r.rows);
for (const [sql, question] of bases) {
  const base = await run(sql);
  if (!base.ok) continue;
  stats.basesRun++;
  const t0 = performance.now();
  const list = suggest(question, sql, context);
  stats.genUs.push((performance.now() - t0) * 1000);
  stats.perBase.push(list.length);
  if (list.length) stats.withSuggestions++;
  for (const s of list) {
    stats.variants++;
    const k = (stats.byKind[s.kind] ??= { n: 0, ok: 0 });
    k.n++;
    const r = await run(s.sql);
    let why = r.ok ? '' : `${r.code}: ${r.message.slice(0, 160)}`;
    if (r.ok) {
      const bc = base.columns.length, vc = r.columns.length, br = base.rows.length, vr = r.rows.length;
      if (s.kind === 'split' && !(vc === bc + 1 && vr >= br)) why = `split shape ${bc}x${br} → ${vc}x${vr}`;
      const limited = /\blimit\s+\d+\s*$/i.test(s.sql.trim()) || br === 0;
      if (s.kind === 'bucket' && !(vc === bc && (vr !== br || limited))) why = `bucket shape ${bc}x${br} → ${vc}x${vr}`;
      if (s.kind === 'window' && !(vc === bc && vr <= br)) why = `window shape ${bc}x${br} → ${vc}x${vr}`;
      if (s.kind === 'agg' && !(vc === bc && vr === br)) why = `agg shape ${bc}x${br} → ${vc}x${vr}`;
      if (s.kind === 'view' && sig(r) !== sig(base)) why = 'view changed the rows';
    }
    if (r.ok && r.rows.length === 0) { stats.empty = (stats.empty ?? 0) + 1; (k.empty = (k.empty ?? 0) + 1); }
    if (why) stats.failed.push({ question, sql, kind: s.kind, variant: s.sql, why });
    else { stats.ok++; k.ok++; }
  }
}
clearInterval(keepAlive);
db.dispose();
const sorted = stats.genUs.sort((a, b) => a - b);
const q = f => sorted[Math.min(sorted.length - 1, Math.round(f * (sorted.length - 1)))];
const summary = {
  bases: stats.bases, basesRun: stats.basesRun, withSuggestions: stats.withSuggestions,
  meanPerBase: +(stats.perBase.reduce((a, b) => a + b, 0) / stats.perBase.length).toFixed(2),
  variants: stats.variants, ok: stats.ok, failed: stats.failed.length, emptyResults: stats.empty ?? 0, byKind: stats.byKind,
  generateUs: { p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +sorted[sorted.length - 1].toFixed(1) },
};
console.log(JSON.stringify(summary, null, 1));
for (const f of stats.failed.slice(0, 20)) console.log('FAIL', f.kind, '|', f.why, '\n  base:', f.sql.replace(/\s+/g, ' '), '\n  var: ', f.variant.replace(/\s+/g, ' '));
if (option('--json')) writeFileSync(resolve(root, option('--json')), JSON.stringify({ date: new Date().toISOString(), summary, failed: stats.failed }, null, 1));
process.exit(stats.failed.length ? 1 : 0);
