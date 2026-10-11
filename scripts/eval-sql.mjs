#!/usr/bin/env node
// NL→SQL eval by executed results (evals/sql-eval.ts; corpora evals/sql-corpus.json for vessels,
// evals/sql-corpus-<dataset>.json for the public datasets in public/data/datasets.json).
//
//   node scripts/eval-sql.mjs --self-test [--dataset vessels|weather|flights|cities|all]
//       fake model (reference SQL + scripted wrong answers); checks the scorer and every reference, no network
//   node scripts/eval-sql.mjs --endpoint ws://127.0.0.1:8787/session [--dataset name|all] [--label x] [--only id,id]
//       live: tb1 over WebSocket to a running inference server; writes
//       docs/batch-3/eval-<dataset>-<model>-<date>[-<label>].json per dataset and prints a summary row;
//       --db-repair: on a database error, translate once more with the SQL and error appended to
//       the question (simulates a repair turn the protocol cannot express yet), scored separately
//   node scripts/eval-sql.mjs --rescore docs/batch-3/eval-….json
//       re-run the scorer on a saved report's SQL (after a corpus or scorer change), no model calls
//   node scripts/eval-sql.mjs --rollup-check [--dataset name|all] [--reports a.json,b.json]
//       exactness of the rollup rewrite: every reference (and saved model SQL) on a node with the
//       engine's defaults vs. one with rollups, compression and the result cache off; exits 1 on a mismatch
//   --no-description: send the CONTEXT without the dataset description (as for a dropped file)
//   node scripts/eval-sql.mjs --export-arrow <dir> [--dataset name|all] [--reports a.json,b.json]
//       executed results (references, model SQL) as Arrow IPC for tests/render_generality.py
//   node scripts/eval-sql.mjs --print-prompt --dataset name
//       the DatasetContext the database node returns and the system prompt built from it
//   node scripts/eval-sql.mjs --endpoint ws://… --prefixes 0.5,0.75,0.9 [--dataset name] [--label x]
//       prefix replay: translate each question and its typed prefixes; how often a prefix already
//       yields the final SQL/result. Writes docs/batch-3/prefixes-<dataset>-<model>-<date>[-<label>].json
//
// Datasets load into the engine's own DuckDatabaseNode exactly as in the browser (vessels generated;
// the others from their Parquet files), and the runner waits for the background rollups before
// asking, so the guard, statistics, context and rollups are the real ones.
// The TypeScript modules are loaded with Vite's module runner (no build step, no new deps).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg, platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import { Table, tableToIPC } from 'apache-arrow';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (flag('--help')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 25).join('\n')); process.exit(0); }

const { module: lib } = await runnerImport(resolve(root, 'evals/sql-eval.ts'), { root, configFile: false, logLevel: 'error' });
// The engine yields through an unref'd MessageChannel; keep Node alive while it works.
const keepAlive = setInterval(() => {}, 1000);
const corpusPathFor = name => name === 'vessels' ? 'evals/sql-corpus.json' : `evals/sql-corpus-${name}.json`;
const only = option('--only') ? new Set(option('--only').split(',')) : undefined;
const date = new Date().toISOString().slice(0, 10);
const slug = model => model.replace(/^.*\//, '').replace(/[^a-z0-9.-]+/gi, '-');

const rescore = option('--rescore');
const previous = rescore ? JSON.parse(readFileSync(resolve(root, rescore), 'utf8')) : undefined;
const datasetArg = option('--dataset') ?? previous?.dataset ?? (option('--corpus') ? JSON.parse(readFileSync(resolve(root, option('--corpus')), 'utf8')).dataset : 'vessels');
const datasets = datasetArg === 'all'
  ? ['vessels', ...lib.readManifest(root).map(e => e.name).filter(n => n !== 'vessels' && existsSync(resolve(root, corpusPathFor(n))))]
  : datasetArg.split(',');

async function open(name, node) {
  const t0 = performance.now();
  const database = await lib.openDatabase(name, { root, node });
  await database.rollupsDone;
  const built = database.rollups.filter(r => r.grain).map(r => `${r.table}/${r.grain} ${r.rows} rows ${r.ms.toFixed(0)} ms`);
  const skipped = database.rollups.filter(r => r.skipped).map(r => `${r.table}: ${r.skipped}`);
  console.error(`${name}: loaded + context in ${(database.generateMs / 1000).toFixed(1)} s, rollups ${built.length ? built.join(', ') : 'none'}${skipped.length ? ` (skipped ${skipped.join('; ')})` : ''}, ready after ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return database;
}

/** The CONTEXT sent to inference. --no-description drops the dataset description, as for a
 * dropped file (measures how much e.g. the join hints in a manifest description matter). */
const contextPayload = database => flag('--no-description')
  ? new TextEncoder().encode(JSON.stringify({ ...database.context, description: undefined }))
  : database.contextPayload;

let failed = false;
const rows = [];
for (const dataset of datasets) {
  const corpusPath = option('--corpus') ?? previous?.corpus?.path ?? corpusPathFor(dataset);
  const corpus = flag('--print-prompt') ? { dataset } : JSON.parse(readFileSync(resolve(root, corpusPath), 'utf8'));
  if (corpus.dataset !== dataset) throw new Error(`${corpusPath} is for ${corpus.dataset}, not ${dataset}`);
  const loadAtStart = loadavg().map(v => +v.toFixed(1));
  const database = await open(dataset);
  const rollupInfo = database.rollups;

  if (flag('--print-prompt')) {
    // The DatasetContext as the engine sends it, and the system prompt the TS twin builds from it.
    const { module: prompt } = await runnerImport(resolve(root, 'src/inference-node/prompt.ts'), { root, configFile: false, logLevel: 'error' });
    console.log(JSON.stringify(database.context, null, 1));
    console.log(prompt.systemPrompt(database.context));
  } else if (option('--export-arrow')) {
    // Executed results as Arrow IPC for the renderer check (tests/render_generality.py): the first
    // reference of every case and, with --reports, every model SQL that returned rows.
    const dir = resolve(root, option('--export-arrow'));
    mkdirSync(dir, { recursive: true });
    const reportPaths = (option('--reports') ?? '').split(',').filter(Boolean);
    const saved = reportPaths.map(p => JSON.parse(readFileSync(resolve(root, p), 'utf8'))).filter(r => (r.dataset ?? 'vessels') === dataset);
    const items = [];
    const add = async (id, origin, question, sql) => {
      const r = await database.run(sql);
      if (!r.ok || !r.rows.length) return;
      const batches = database.lastBatches();
      items.push({ id, origin, question, sql, hint: lib.viewHint(sql) ?? null, rows: r.rows.length,
        columns: r.columns, ipc: Buffer.from(tableToIPC(new Table(batches), 'stream')).toString('base64') });
    };
    for (const c of corpus.cases) await add(c.id, 'reference', c.question, lib.corpusReferences(corpus, c)[0]);
    for (const rep of saved) for (const c of rep.cases) if (c.sql) await add(c.id, `model:${rep.label ?? ''}`, c.question, c.sql);
    writeFileSync(resolve(dir, `${dataset}.json`), JSON.stringify({ dataset, items }));
    console.log(JSON.stringify({ dataset, exported: items.length, dir }));
  } else if (flag('--self-test')) {
    const script = dataset === 'vessels' ? lib.SELF_TEST_SCRIPT : {};
    const translator = lib.fakeTranslator(corpus, Object.fromEntries(Object.entries(script).map(([id, s]) => [id, s.sql])));
    const cases = await lib.evaluate(corpus, database, translator, { only, log: flag('--verbose') ? line => console.error(line) : undefined });
    for (const c of cases) {
      const want = script[c.id]?.expect ?? 'exact';
      if (c.category !== want) { failed = true; console.error(`FAIL ${dataset}/${c.id}: ${c.category} (${c.reason}), expected ${want}`); }
    }
    const summary = lib.summarize(cases);
    console.log(JSON.stringify({ dataset, selfTest: failed ? 'failed' : 'ok', n: summary.n, counts: summary.counts }));
  } else if (flag('--rollup-check')) {
    const plain = await open(dataset, { rollups: false, resultCache: false, compressed: false });
    const reportPaths = (option('--reports') ?? '').split(',').filter(Boolean);
    const saved = reportPaths.map(p => JSON.parse(readFileSync(resolve(root, p), 'utf8'))).filter(r => (r.dataset ?? 'vessels') === dataset);
    const statements = new Map();
    for (const c of corpus.cases) for (const sql of lib.corpusReferences(corpus, c)) statements.set(sql, `ref:${c.id}`);
    for (const r of saved) for (const c of r.cases) if (c.sql && !statements.has(c.sql)) statements.set(c.sql, `model:${c.id}`);
    let mismatches = 0;
    for (const [sql, origin] of statements) {
      const a = await plain.run(sql), b = await database.run(sql);
      const verdict = lib.sameExecution(sql, a, b);
      if (!verdict.same) { mismatches++; console.error(`MISMATCH ${dataset} ${origin}: ${verdict.reason}\n  ${sql}`); }
    }
    plain.dispose();
    if (mismatches) failed = true;
    console.log(JSON.stringify({ dataset, rollupCheck: mismatches ? 'failed' : 'ok', statements: statements.size, mismatches, rollups: rollupInfo }));
  } else if (option('--prefixes')) {
    const fractions = option('--prefixes').split(',').map(Number);
    const translator = await lib.tb1Translator(option('--endpoint'), contextPayload(database));
    const cases = await lib.evaluatePrefixes(corpus, database, translator, fractions, { only, log: line => console.error(line) });
    translator.close();
    const summary = lib.summarizePrefixes(cases, fractions);
    const model = translator.model ?? 'unknown', label = option('--label');
    const out = option('--output') ?? `docs/batch-3/prefixes-${dataset}-${slug(model)}-${date}${label ? `-${label}` : ''}.json`;
    mkdirSync(dirname(resolve(root, out)), { recursive: true });
    writeFileSync(resolve(root, out), JSON.stringify({
      kind: 'time-blast.sql-prefix-replay', version: 1, date: new Date().toISOString(), label, model, dataset,
      server: option('--server-note'), corpus: { path: corpusPath, cases: corpus.cases.length, version: corpus.version }, fractions, summary, cases,
    }, null, 1) + '\n');
    console.log(JSON.stringify(summary));
    console.error(`wrote ${out}`);
  } else {
    const endpoint = option('--endpoint');
    if (!endpoint && !rescore) { console.error('--endpoint ws://host:port/session, --rescore report.json, --rollup-check or --self-test'); process.exit(2); }
    const translator = previous ? lib.replayTranslator(previous) : await lib.tb1Translator(endpoint, contextPayload(database));
    const cases = await lib.evaluate(corpus, database, translator, { only, log: line => console.error(`${dataset.padEnd(8)} ${line}`), dbRepair: flag('--db-repair') });
    translator.close();
    const summary = lib.summarize(cases);
    const model = translator.model ?? cases.find(c => c.stats?.model)?.stats.model ?? 'unknown';
    const label = option('--label') ?? previous?.label;
    const report = previous ? { ...previous, dataset, rescoredAt: new Date().toISOString(), corpus: { path: corpusPath, cases: corpus.cases.length, version: corpus.version }, summary, cases } : {
      kind: 'time-blast.sql-eval', version: 1, date: new Date().toISOString(), label, translator: translator.name, model, dataset,
      endpoint: endpoint.replace(/\/\/[^@/]*@/, '//'), server: option('--server-note'),
      corpus: { path: corpusPath, cases: corpus.cases.length, version: corpus.version },
      environment: { node: process.version, platform: platform(), arch: arch(), cpus: cpus().length, duckdbWasm: '1.32.0', loadavgAtStart: loadAtStart, loadavgAtEnd: loadavg().map(v => +v.toFixed(1)) },
      context: { tables: database.context.tables.map(t => ({ name: t.name, rows: t.rows, columns: t.columns.length })), promptBytes: database.contextPayload.length },
      rollups: rollupInfo,
      summary, cases,
    };
    const out = (datasets.length === 1 ? option('--output') : undefined) ?? rescore
      ?? `docs/batch-3/eval-${dataset}-${slug(model)}-${date}${label ? `-${label}` : ''}.json`;
    mkdirSync(dirname(resolve(root, out)), { recursive: true });
    writeFileSync(resolve(root, out), JSON.stringify(report, null, 1) + '\n');
    const k = summary.counts, l = summary.latency, i = summary.issues;
    const row = `| ${dataset} | ${model}${label ? ` (${label})` : ''} | ${summary.n} | ${k.exact} | ${k.equivalent} | ${k['shape-violation']} | ${k.wrong} | ${k['sql-error']} | ${k['rejected-by-guard']} | **${(summary.correct * 100).toFixed(0)} %** | ${l.firstDeltaP50} / ${l.firstDeltaP95} | ${l.sqlP50} / ${l.sqlP95} | $${summary.costUsd.toFixed(4)} | ${i.viewHintUnasked} / ${i.rawRows} / ${i.foreignDialect} |`;
    rows.push(row);
    console.log(row);
    console.error(`wrote ${out}`);
  }
  database.dispose();
}
if (rows.length > 1) {
  console.log('\n| dataset | model | n | exact | equiv | shape | wrong | sql-err | guard | correct | first delta p50/p95 ms | SQL p50/p95 ms | cost | unasked view / raw rows / foreign dialect |');
  for (const row of rows) console.log(row);
}
clearInterval(keepAlive);
process.exit(failed ? 1 : 0);
