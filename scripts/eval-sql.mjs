#!/usr/bin/env node
// NL→SQL eval by executed results (evals/sql-eval.ts, corpus evals/sql-corpus.json).
//
//   node scripts/eval-sql.mjs --self-test
//       fake model (reference SQL + scripted wrong answers); checks the scorer, no network
//   node scripts/eval-sql.mjs --endpoint ws://127.0.0.1:8787/session [--label prompt-v2] [--only id,id]
//       live: tb1 over WebSocket to a running inference server; writes
//       docs/batch-1/eval-<model>-<date>[-<label>].json and prints a summary row for evals.md
//   node scripts/eval-sql.mjs --rescore docs/batch-1/eval-….json
//       re-run the scorer on a saved report's SQL (after a corpus or scorer change), no model calls
//
// The TypeScript modules are loaded with Vite's module runner (no build step, no new deps).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (flag('--help')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split("\n").slice(1, 11).join('\n')); process.exit(0); }

const { module: lib } = await runnerImport(resolve(root, 'evals/sql-eval.ts'), { root, configFile: false, logLevel: 'error' });
const corpusPath = option('--corpus') ?? 'evals/sql-corpus.json';
const corpus = JSON.parse(readFileSync(resolve(root, corpusPath), 'utf8'));
const only = option('--only') ? new Set(option('--only').split(',')) : undefined;

const t0 = performance.now();
const database = await lib.openDatabase();
console.error(`vessels generated + context in ${(database.generateMs / 1000).toFixed(1)} s (DuckDB-Wasm node-blocking)`);

let failed = false;
if (flag('--self-test')) {
  const script = lib.SELF_TEST_SCRIPT;
  const translator = lib.fakeTranslator(corpus, Object.fromEntries(Object.entries(script).map(([id, s]) => [id, s.sql])));
  const cases = await lib.evaluate(corpus, database, translator, { log: flag('--verbose') ? line => console.error(line) : undefined });
  for (const c of cases) {
    const want = script[c.id]?.expect ?? 'exact';
    if (c.category !== want) { failed = true; console.error(`FAIL ${c.id}: ${c.category} (${c.reason}), expected ${want}`); }
  }
  const summary = lib.summarize(cases);
  console.log(JSON.stringify({ selfTest: failed ? 'failed' : 'ok', counts: summary.counts, issues: summary.issues, seconds: Number(((performance.now() - t0) / 1000).toFixed(1)) }));
} else {
  const endpoint = option('--endpoint'), rescore = option('--rescore');
  if (!endpoint && !rescore) { console.error('--endpoint ws://host:port/session, --rescore report.json or --self-test'); process.exit(2); }
  const previous = rescore ? JSON.parse(readFileSync(resolve(root, rescore), 'utf8')) : undefined;
  const translator = previous ? lib.replayTranslator(previous) : await lib.tb1Translator(endpoint, database.contextPayload);
  const cases = await lib.evaluate(corpus, database, translator, { only, log: line => console.error(line) });
  translator.close();
  const summary = lib.summarize(cases);
  const date = new Date().toISOString().slice(0, 10);
  const model = translator.model ?? cases.find(c => c.stats?.model)?.stats.model ?? 'unknown';
  const label = option('--label') ?? previous?.label;
  const report = previous ? { ...previous, rescoredAt: new Date().toISOString(), corpus: { path: corpusPath, cases: corpus.cases.length, version: corpus.version }, summary, cases } : {
    kind: 'time-blast.sql-eval', version: 1, date: new Date().toISOString(), label, translator: translator.name, model,
    endpoint: endpoint.replace(/\/\/[^@/]*@/, '//'), server: option('--server-note'),
    corpus: { path: corpusPath, cases: corpus.cases.length, version: corpus.version },
    environment: { node: process.version, platform: platform(), arch: arch(), cpus: cpus().length, duckdbWasm: '1.32.0' },
    summary, cases,
  };
  const out = option('--output') ?? rescore ?? `docs/batch-1/eval-${model.replace(/^.*\//, '').replace(/[^a-z0-9.-]+/gi, '-')}-${date}${label ? `-${label}` : ''}.json`;
  mkdirSync(dirname(resolve(root, out)), { recursive: true });
  writeFileSync(resolve(root, out), JSON.stringify(report, null, 1) + '\n');
  const k = summary.counts, l = summary.latency, i = summary.issues;
  console.log(`| ${model}${label ? ` (${label})` : ''} | ${summary.n} | ${k.exact} | ${k.equivalent} | ${k['shape-violation']} | ${k.wrong} | ${k['sql-error']} | ${k['rejected-by-guard']} | **${(summary.correct * 100).toFixed(0)} %** | ${l.firstDeltaP50} / ${l.firstDeltaP95} | ${l.sqlP50} / ${l.sqlP95} | $${summary.costUsd.toFixed(4)} | ${i.viewHintUnasked} / ${i.rawRows} / ${i.foreignDialect} |`);
  console.error(`wrote ${out}`);
}
database.dispose();
process.exit(failed ? 1 : 0);
