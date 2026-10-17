#!/usr/bin/env node
// Contextual canvas refinement, scored by executed DuckDB results.
// node scripts/eval-canvas.mjs --self-test
// node scripts/eval-canvas.mjs --endpoint ws://127.0.0.1:8793/session [--only case,case] [--output file.json]
// Start an isolated current inference backend yourself; this runner never reads credentials or deploys.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { arch, cpus, loadavg, platform } from 'node:os';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
if (args.includes('--help')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 5).join('\n')); process.exit(0); }
const selfTest = args.includes('--self-test'), endpoint = option('--endpoint');
if (!selfTest && !endpoint) throw new Error('Use --self-test or provide --endpoint for a live backend');
const maximumCost = Number(option('--max-cost') ?? '0.04');
if (!Number.isFinite(maximumCost) || maximumCost <= 0) throw new Error('--max-cost must be positive');
const only = option('--only')?.split(',');
const { module: lib } = await runnerImport(resolve(root, 'evals/canvas-edit-eval.ts'), { root, configFile: false, logLevel: 'error' });
const { module: sql } = await runnerImport(resolve(root, 'evals/sql-eval.ts'), { root, configFile: false, logLevel: 'error' });
const cases = lib.canvasEditCases().filter(c => !only || only.includes(c.id));
if (!cases.length || only?.some(id => !cases.some(c => c.id === id))) throw new Error('Unknown or empty --only selection');
const keepAlive = setInterval(() => {}, 1000);
const reports = [], checks = [], opened = [], models = new Set(), loadAtStart = loadavg();
let costUsd = 0, unknownCost = false, failure;
const percentile = (values, p) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null; };
try {
  try {
  for (const dataset of [...new Set(cases.map(c => c.dataset))]) {
    const start = performance.now();
    const database = await sql.openDatabase(dataset, { root, node: { rollups: false, compressed: false, resultCache: false } });
    opened.push({ dataset, loadMs: performance.now() - start, tables: database.context.tables.map(t => ({ name: t.name, rows: t.rows })) });
    let translator;
    try {
      if (!selfTest) { translator = await lib.openEditTranslator(endpoint, database.contextPayload); models.add(translator.model ?? 'unknown'); }
      for (const c of cases.filter(c => c.dataset === dataset)) {
        if (selfTest) { checks.push(await lib.selfTestCase(c, database)); continue; }
        if (costUsd >= maximumCost || unknownCost) throw new Error('Stopping at reported-cost limit, or because the provider did not report cost');
        const report = await lib.evaluateCase(c, database, translator); reports.push(report);
        if (!report.cached && typeof report.stats?.costUsd !== 'number') unknownCost = true;
        costUsd += report.stats?.costUsd ?? 0;
        console.error(`${c.id}: ${report.category}, ${report.sqlMs?.toFixed(0) ?? '-'} ms to SQL, $${(report.stats?.costUsd ?? 0).toFixed(6)}, ${report.stats?.attempts ?? 0} attempts`);
      }
    } finally { translator?.close(); database.dispose(); }
  }
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  if (selfTest) console.log(JSON.stringify({ selfTest: failure ? 'failed' : 'passed', failure, cases: checks.length, checks: checks.reduce((n, c) => n + c.checks, 0), details: checks }));
  else {
    const date = new Date().toISOString(), out = resolve(root, option('--output') ?? `docs/reviews/canvas-edit-eval-${date.slice(0, 10)}.json`);
    const sourceFiles = ['src/protocol/edit.ts', 'src/canvas/protocol.ts', 'crates/inference-server/src/prompt.rs', 'crates/inference-server/src/session.rs', 'crates/inference-server/src/infer.rs'];
    const report = { kind: 'timeblast.canvas-edit-eval', version: 1, date, endpoint, models: [...models],
      environment: { node: process.version, platform: platform(), arch: arch(), cpus: cpus().length, loadAtStart, duckdbWasm: '1.32.0', browser: null },
      sources: Object.fromEntries(sourceFiles.map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])),
      measurement: 'One sequential pass. First request per dataset opens a new inference connection; provider warmth is unknown. Timings are client EDIT_INFER to SQL and SQL execution, not rendering or photons. Database result cache, rollups and compression disabled. No speculative requests.',
      datasets: opened, summary: { n: reports.length, correct: reports.filter(r => r.correct).length, costUsd, unknownCost, failure,
        automaticRepairCases: reports.filter(r => r.automaticRepairObserved).length,
        sqlMs: { p50: percentile(reports.map(r => r.sqlMs), .5), p95: percentile(reports.map(r => r.sqlMs), .95), p99: percentile(reports.map(r => r.sqlMs), .99) } }, cases: reports };
    mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ output: out, ...report.summary }));
    if (reports.some(r => !r.correct)) process.exitCode = 1;
  }
  if (failure) { console.error(failure); process.exitCode = 1; }
} finally { clearInterval(keepAlive); }
