#!/usr/bin/env node
// Performance regression harness (docs/perf/README.md).
//
//   pnpm perf                      build, run the default suite, append one record to docs/perf/history.jsonl
//   pnpm perf --check              same, then fail (exit 1) when a metric regressed beyond docs/perf/budgets.json
//   pnpm perf --compare            no run: check the latest harness record against its baseline
//   pnpm perf --ingest file.json   append a /measure.html report (hardware run) to the history
//
// Options: --suite default|quick, --rounds n, --boots n, --repeat n (whole suite n times, pooled),
//   --only micro,db,e2e, --no-build (reuse dist/), --gpu software|default, --dry-run (don't append),
//   --with-eval [--eval-endpoint ws://…] (live NL→SQL eval: costs money, off by default),
//   --note "text" (stored with the record), --history path (default docs/perf/history.jsonl).
//
// It starts and stops its own `vite preview` server (production build) and the fake inference
// node (inside scripts/perf/e2e.py). Every child is stopped by PID.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { arch, cpus, hostname, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback; };
if (flag('--help')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 17).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }

const { module: lib } = await runnerImport(resolve(root, 'scripts/perf/lib.ts'), { root, configFile: false, logLevel: 'error' });
const historyPath = resolve(root, option('--history', 'docs/perf/history.jsonl'));
const budgets = JSON.parse(readFileSync(resolve(root, 'docs/perf/budgets.json'), 'utf8'));
const readHistory = () => existsSync(historyPath) ? lib.parseHistory(readFileSync(historyPath, 'utf8')) : [];
const log = (...a) => console.error('[perf]', ...a);

const SUITES = {
  default: { rounds: 10, boots: 2, dbRepeats: 3, microBatches: 40 },
  quick: { rounds: 4, boots: 1, dbRepeats: 1, microBatches: 15 },
};

// ───────────────────────── modes without a run ─────────────────────────

if (option('--ingest')) {
  const file = resolve(process.cwd(), option('--ingest'));
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const record = lib.ingest(report, report.commit ?? git(['rev-parse', '--short', 'HEAD']));
  if (!report.commit) (record.notes ??= []).push('commit not in the report; assumed the checkout HEAD at ingest time');
  if (!flag('--dry-run')) appendFileSync(historyPath, JSON.stringify(record) + '\n');
  printRecord(record);
  log(flag('--dry-run') ? 'dry run: not appended' : `appended hardware record to ${historyPath}`);
  process.exit(0);
}
if (flag('--compare')) {
  const history = readHistory();
  const latest = history.filter(r => r.source === 'harness').at(-1);
  if (!latest) { log('no harness record in the history'); process.exit(2); }
  process.exit(report(latest, history) ? 1 : 0);
}

// ───────────────────────── a run ─────────────────────────

const suiteName = option('--suite', 'default');
const suite = { ...SUITES[suiteName] };
if (!SUITES[suiteName]) { log(`unknown suite ${suiteName}`); process.exit(2); }
if (option('--rounds')) suite.rounds = Number(option('--rounds'));
if (option('--boots')) suite.boots = Number(option('--boots'));
const repeat = Number(option('--repeat', '1'));
const only = new Set(option('--only', 'micro,db,e2e').split(','));
const gpuMode = option('--gpu', 'software');
const started = Date.now();
const loadBefore = loadavg().map(v => +v.toFixed(2));
const children = new Set();
const stopChildren = () => { for (const child of children) { try { child.kill('SIGTERM'); } catch { /* gone */ } } children.clear(); };
process.on('SIGINT', () => { stopChildren(); process.exit(130); });
process.on('SIGTERM', () => { stopChildren(); process.exit(143); });

function git(argv) {
  try { return execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim(); } catch { return ''; }
}

/** Run a child to completion; stdout is returned, stderr streams through. */
function run(cmd, argv, { env } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, argv, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
    children.add(child);
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', code => { children.delete(child); code === 0 ? resolveRun(out) : reject(new Error(`${cmd} ${argv.join(' ')} exited ${code}`)); });
  });
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});

async function startPreview() {
  const port = await freePort();
  const child = spawn(resolve(root, 'node_modules/.bin/vite'), ['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  children.add(child);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url); if (r.ok) return { url, child }; } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('vite preview did not start');
}

function hostInfo() {
  let cpu = cpus()[0]?.model ?? '';
  if (!cpu || cpu === 'unknown') {
    try { cpu = execFileSync('lscpu', { encoding: 'utf8' }).match(/Model name:\s*(.+)/)?.[1]?.trim() ?? 'unknown'; } catch { cpu = 'unknown'; }
  }
  const name = hostname(), cores = cpus().length;
  return { key: `${name}|${cpu}|${cores}|${arch()}`, name, cpu, cores, arch: arch(), os: `${platform()} ${release()}`,
    memGb: +(totalmem() / 2 ** 30).toFixed(1), node: process.version, loadBefore, loadAfter: null };
}

const samples = {};
const stageSamples = {};
const pushSamples = (metric, values) => { (samples[metric] ??= []).push(...values); };
const notes = [];
if (option('--note')) notes.push(option('--note'));
let browser, gpu = { backend: 'unknown' }, e2eFailures = [], evalResult;
const tmp = mkdtempSync(join(tmpdir(), 'tb-perf-'));
let preview;
try {
  if (only.has('e2e')) {
    if (!flag('--no-build')) { log('building (vite build) …'); await run(resolve(root, 'node_modules/.bin/vite'), ['build', '--logLevel', 'warn']); }
    if (!existsSync(resolve(root, 'dist/index.html'))) throw new Error('dist/ missing: run without --no-build');
    preview = await startPreview();
    log(`preview at ${preview.url}`);
  }
  for (let r = 0; r < repeat; r++) {
    if (only.has('micro')) {
      log(`micro benches (pass ${r + 1}/${repeat}) …`);
      const m = JSON.parse(await run('node', ['scripts/perf/micro.mjs', '--batches', String(suite.microBatches)]));
      for (const [k, v] of Object.entries(m.samples)) pushSamples(k, v);
    }
    if (only.has('db')) {
      log(`database first-batch bench (pass ${r + 1}/${repeat}) …`);
      const d = JSON.parse(await run('node', ['scripts/perf/database.mjs', '--repeats', String(suite.dbRepeats)]));
      for (const [k, v] of Object.entries(d.samples)) pushSamples(k, v);
      if (d.errors) notes.push(`database bench: ${d.errors} statements failed`);
    }
    if (only.has('e2e')) {
      log(`browser e2e (pass ${r + 1}/${repeat}, ${suite.rounds} rounds, ${suite.boots} boots) …`);
      const out = join(tmp, `e2e-${r}.json`);
      await run('python3', ['scripts/perf/e2e.py', '--url', preview.url, '--rounds', String(suite.rounds), '--boots', String(suite.boots), '--gpu', gpuMode, '--json', out]);
      const e = JSON.parse(readFileSync(out, 'utf8'));
      browser = e.browser;
      const adapter = e.renderer?.adapter ?? '';
      gpu = { backend: /swiftshader|llvmpipe/i.test(adapter) ? 'swiftshader' : adapter ? 'hardware' : 'unknown', api: e.renderer?.api, adapter: adapter.replace(/; scheduler .*$/, '') };
      for (const [k, v] of Object.entries(e.samples)) pushSamples(k, v);
      for (const [k, v] of Object.entries(e.stages)) (stageSamples[k] ??= []).push(...v);
      e2eFailures.push(...e.failures);
    }
  }
  if (flag('--with-eval')) {
    const endpoint = option('--eval-endpoint', 'wss://time-blast.46-224-133-201.sslip.io/api/inference/session');
    log(`live NL→SQL eval against ${endpoint} (costs money) …`);
    const out = join(tmp, 'eval.json');
    await run('node', ['scripts/eval-sql.mjs', '--endpoint', endpoint, '--output', out, '--label', 'perf']);
    const e = JSON.parse(readFileSync(out, 'utf8'));
    evalResult = { model: e.model, n: e.summary.n, correct: e.summary.correct, costUsd: e.summary.costUsd, latency: e.summary.latency };
    // Latency only: correctness is higher-is-better and reported, not budget-checked.
    for (const c of e.cases) {
      if (typeof c.latency?.firstDeltaMs === 'number') pushSamples('eval.first_sql_delta', [c.latency.firstDeltaMs]);
      if (typeof c.latency?.sqlMs === 'number') pushSamples('eval.sql_complete', [c.latency.sqlMs]);
    }
  }
} finally {
  if (preview) { preview.child.kill('SIGTERM'); children.delete(preview.child); }
  stopChildren();
  rmSync(tmp, { recursive: true, force: true });
}

const unitOf = metric => metric.startsWith('micro.') ? 'µs' : 'ms';
const metrics = {};
for (const [k, v] of Object.entries(samples)) { const s = lib.summarize(v, unitOf(k)); if (s) metrics[k] = s; }
const stages = {};
for (const [k, v] of Object.entries(stageSamples)) stages[k] = lib.stageTable(v);
// docs/perf/ itself (history, dashboard) does not make a run dirty.
const dirty = git(['status', '--porcelain', '--', '.', ':(exclude)docs/perf']).length > 0;
const host = hostInfo();
host.loadAfter = loadavg().map(v => +v.toFixed(2));
if (e2eFailures.length) notes.push(...e2eFailures.map(f => `e2e: ${f}`));
const record = {
  kind: 'time-blast.perf', version: 1, source: 'harness', suite: suiteName,
  commit: git(['rev-parse', '--short=10', 'HEAD']) || 'unknown', dirty, branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
  date: new Date().toISOString(), host, browser, gpu,
  settings: { ...suite, repeat, only: [...only], gpuMode, delayMs: 70, inference: 'tests/fake_inference.py echo, 0 ms' },
  metrics, stages, ...(evalResult ? { eval: evalResult } : {}), notes, durationS: Math.round((Date.now() - started) / 1000),
};
if (!flag('--dry-run')) appendFileSync(historyPath, JSON.stringify(record) + '\n');
printRecord(record);
log(flag('--dry-run') ? 'dry run: not appended' : `appended to ${historyPath}`);
let failed = e2eFailures.length > 0;
if (flag('--check')) failed = report(record, [...readHistory().filter(r => r.date !== record.date), record]) || failed;
process.exit(failed ? 1 : 0);

// ───────────────────────── output ─────────────────────────

function printRecord(r) {
  console.log(`\n${r.source} · ${r.suite} · ${r.commit}${r.dirty ? ' (dirty)' : ''} · ${r.date}`);
  console.log(`host ${r.host.name} (${r.host.cpu}, ${r.host.cores} cores) · load ${r.host.loadBefore?.join('/') ?? '?'} → ${r.host.loadAfter?.join('/') ?? '?'} · ${r.browser ? `${r.browser.name} ${r.browser.version}` : ''} · GPU ${r.gpu.backend}${r.gpu.adapter ? ` (${r.gpu.adapter})` : ''}`);
  const rows = Object.entries(r.metrics).sort(([a], [b]) => a.localeCompare(b));
  const w = Math.max(...rows.map(([k]) => k.length), 6);
  console.log(`${'metric'.padEnd(w)}  ${'n'.padStart(4)}  ${'median'.padStart(9)}  ${'95% band'.padStart(19)}  ${'p95'.padStart(9)}  ${'min'.padStart(9)}  ${'max'.padStart(9)}`);
  for (const [k, s] of rows) {
    const f = v => String(v).padStart(9);
    console.log(`${k.padEnd(w)}  ${String(s.n).padStart(4)}  ${f(s.median)}  ${`${s.ciLow}–${s.ciHigh}`.padStart(19)}  ${f(s.p95)}  ${f(s.min)}  ${f(s.max)}  ${s.unit}`);
  }
  for (const n of r.notes ?? []) console.log(`note: ${n}`);
}

/** Print the budget check; returns true when something regressed. */
function report(record, history) {
  const rows = lib.check(record, history, budgets);
  const bad = rows.filter(r => r.verdict === 'regressed' || r.verdict === 'missing');
  console.log(`\nbudget check of ${record.commit} (${record.date}) against up to ${budgets.baselineRuns} earlier ${record.suite} runs on ${record.host.name} · GPU ${record.gpu.backend}`);
  for (const r of rows) console.log(`${r.verdict === 'regressed' ? '!! REGRESSED' : r.verdict === 'missing' ? '!! MISSING ' : r.verdict.padEnd(12)}  ${r.metric}: ${r.reason}`);
  if (bad.length) console.log(`\n!!!!!!!! ${bad.length} metric(s) regressed beyond budget: ${bad.map(r => r.metric).join(', ')} !!!!!!!!`);
  else console.log('\nno regressions beyond budget');
  return bad.length > 0;
}
