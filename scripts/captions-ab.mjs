#!/usr/bin/env node
/**
 * A/B (plan-captions.md, phase 3, server level): does a caption in flight slow a translation?
 *
 * Two tb1 connections to one inference server, as the app opens them: a translation link
 * (CONTEXT + INFER) and a caption link (DESCRIBE only). For every corpus question, paired and in
 * random order: arm `off` translates alone; arm `on` sends a DESCRIBE on the caption link at the
 * same instant as the INFER (worst case: the app sends at most one caption per *saved* revision,
 * never per keystroke). Run the server with its SQL and caption caches off so every request
 * reaches the provider.
 *
 * Measured on this client (performance.now): INFER sent → first SQL_DELTA, → final SQL. Plus
 * refusals/errors per arm, caption outcomes and cost.
 *
 *   node scripts/captions-ab.mjs --endpoint ws://127.0.0.1:8797/session [--reps 2] [--json out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, d) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : d; };
const load = path => runnerImport(resolve(root, path), { root, configFile: false, logLevel: 'error' }).then(r => r.module);
const { decode, encode, header, json, Kind, readJson, text, SUBPROTOCOL } = await load('src/protocol/frame.ts');
const caption = await load('src/inference-node/caption.ts');
const lib = await load('evals/sql-eval.ts');
const endpoint = option('--endpoint', 'ws://127.0.0.1:8797/session');
const reps = Number(option('--reps', '2'));
const gapMs = Number(option('--gap', '150'));
const DATASETS = [['vessels', 'sql-corpus.json'], ['weather', 'sql-corpus-weather.json'], ['flights', 'sql-corpus-flights.json'], ['cities', 'sql-corpus-cities.json']];

async function connect(name) {
  const socket = new WebSocket(endpoint, SUBPROTOCOL);
  socket.binaryType = 'arraybuffer';
  const listeners = new Set();
  socket.addEventListener('message', e => { if (e.data instanceof ArrayBuffer) { const f = decode(new Uint8Array(e.data)); for (const l of listeners) l(f, performance.now()); } });
  await new Promise((ok, fail) => { socket.addEventListener('open', ok, { once: true }); socket.addEventListener('error', () => fail(new Error(`cannot connect ${endpoint}`)), { once: true }); });
  const send = f => socket.send(encode(f));
  const ready = await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error('no READY')), 10000);
    const l = f => { if (f.kind === Kind.READY) { clearTimeout(t); listeners.delete(l); ok(readJson(f.payload)); } };
    listeners.add(l);
    send({ ...header(Kind.HELLO), stamps: [], payload: json({ node: 'coordinator', name, version: 1 }) });
  });
  return { send, listeners, ready, close: () => socket.close() };
}

const translation = await connect('captions-ab-translation');
const captions = await connect('captions-ab-captions');
if (!captions.ready.capabilities?.includes(caption.CAPTION_CAPABILITY)) throw new Error('server does not offer describe-v1');

const questions = [], payloads = [];
for (const [i, [name, corpusFile]] of DATASETS.entries()) {
  const context = JSON.parse(readFileSync(resolve(root, `crates/inference-server/tests/fixtures/${name}-context.json`), 'utf8'));
  context.id = i + 1;
  translation.send({ ...header(Kind.CONTEXT, { context: context.id }), stamps: [], payload: json(context) });
  const corpus = JSON.parse(readFileSync(resolve(root, 'evals', corpusFile), 'utf8'));
  for (const c of corpus.cases) {
    questions.push({ id: `${name}/${c.id}`, context: context.id, question: c.question });
    const sql = lib.corpusReferences(corpus, c)[0];
    payloads.push(caption.validateCaptionRequest({ v: 1, sql, question: c.question, dialect: 'duckdb', tables: caption.referencedTables(context.tables, sql) }));
  }
}

let nextId = 1;
function translate(q) {
  const id = nextId++, out = { id: q.id };
  return new Promise(resolveDone => {
    const t0 = performance.now();
    const timer = setTimeout(() => { out.error = 'client_timeout'; done(); }, 45000);
    const done = () => { clearTimeout(timer); translation.listeners.delete(l); resolveDone(out); };
    const l = (f, at) => {
      if (f.request !== id) return;
      if (f.kind === Kind.SQL_DELTA) out.firstDeltaMs ??= at - t0;
      else if (f.kind === Kind.SQL) out.sqlMs = at - t0;
      else if (f.kind === Kind.ERROR) { out.error = readJson(f.payload).code; }
      else if (f.kind === Kind.INFER_STATS) { out.cost = readJson(f.payload).costUsd ?? 0; done(); }
    };
    translation.listeners.add(l);
    translation.send({ ...header(Kind.INFER, { request: id, revision: id, context: q.context, epoch: 0 }), stamps: [], payload: text(q.question) });
  });
}
function describe(payload) {
  const id = nextId++;
  return new Promise(resolveDone => {
    const t0 = performance.now();
    const timer = setTimeout(() => done({ error: 'client_timeout' }), 45000);
    const done = r => { clearTimeout(timer); captions.listeners.delete(l); resolveDone(r); };
    const l = (f, at) => {
      if (f.request !== id) return;
      if (f.kind === Kind.DESCRIPTION) { const b = readJson(f.payload); done({ ms: at - t0, title: b.title, cost: b.usage?.costUsd ?? 0, model: b.model }); }
      else if (f.kind === Kind.ERROR) done({ error: readJson(f.payload).code, ms: at - t0 });
    };
    captions.listeners.add(l);
    captions.send({ ...header(Kind.DESCRIBE, { request: id }), stamps: [], payload: json(payload) });
  });
}

const pairs = [];
const order = [];
for (let r = 0; r < reps; r++) for (const [i, q] of questions.entries()) order.push([q, payloads[(i * 7 + r * 13 + 3) % payloads.length]]);
const limit = Number(option('--limit', String(order.length)));
order.splice(limit);
for (const [n, [q, payload]] of order.entries()) {
  const arms = Math.random() < 0.5 ? ['off', 'on'] : ['on', 'off'];
  const pair = { id: q.id };
  for (const arm of arms) {
    if (arm === 'off') pair.off = await translate(q);
    else {
      const [t, c] = await Promise.all([translate(q), describe(payload)]);
      pair.on = t; pair.caption = c;
    }
    await new Promise(r => setTimeout(r, gapMs));
  }
  pairs.push(pair);
  if (n % 20 === 0) console.error(`${n + 1}/${order.length} ${q.id}: off ${Math.round(pair.off.sqlMs)} ms, on ${Math.round(pair.on.sqlMs)} ms, caption ${pair.caption.error ?? `${Math.round(pair.caption.ms)} ms “${pair.caption.title}”`}`);
}
translation.close(); captions.close();

const q = (xs, f) => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(f * (s.length - 1) + 0.5))] : null; };
const round = x => x == null ? null : Math.round(x * 10) / 10;
// Bootstrap over pairs: CI of (on − off) for p50 and p95, 2000 resamples (seeded LCG).
let seed = 12345; const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
function bootstrap(metric, f) {
  const ok = pairs.filter(p => p.on[metric] != null && p.off[metric] != null);
  const diffs = [];
  for (let b = 0; b < 2000; b++) {
    const on = [], off = [];
    for (let i = 0; i < ok.length; i++) { const p = ok[Math.floor(rand() * ok.length)]; on.push(p.on[metric]); off.push(p.off[metric]); }
    diffs.push(q(on, f) - q(off, f));
  }
  return { delta: round(q(ok.map(p => p.on[metric]), f) - q(ok.map(p => p.off[metric]), f)), ci95: [round(q(diffs, 0.025)), round(q(diffs, 0.975))] };
}
const summary = {};
for (const metric of ['firstDeltaMs', 'sqlMs']) {
  summary[metric] = {};
  for (const arm of ['off', 'on']) {
    const xs = pairs.map(p => p[arm][metric]);
    summary[metric][arm] = { n: xs.filter(x => x != null).length, p50: round(q(xs, .5)), p95: round(q(xs, .95)), p99: round(q(xs, .99)) };
  }
  summary[metric].p50Delta = bootstrap(metric, .5);
  summary[metric].p95Delta = bootstrap(metric, .95);
}
const errors = arm => pairs.map(p => p[arm].error).filter(Boolean);
summary.errors = { off: errors('off'), on: errors('on') };
const caps = pairs.map(p => p.caption);
summary.captions = { sent: caps.length, ok: caps.filter(c => c.title).length, errors: caps.filter(c => c.error).map(c => c.error),
  ms: { p50: round(q(caps.map(c => c.ms), .5)), p95: round(q(caps.map(c => c.ms), .95)) }, models: [...new Set(caps.map(c => c.model).filter(Boolean))],
  costUsd: +caps.reduce((s, c) => s + (c.cost ?? 0), 0).toFixed(5) };
summary.translationCostUsd = +pairs.reduce((s, p) => s + (p.on.cost ?? 0) + (p.off.cost ?? 0), 0).toFixed(5);
const report = { kind: 'timeblast.captions-ab', version: 1, date: new Date().toISOString(), endpoint, translationModel: translation.ready.model, reps,
  measurement: 'Client-side performance.now on this host; INFER sent → first SQL_DELTA / SQL received over loopback WebSocket to a local inference server with SQL and caption caches off (every request reaches the provider). Pairs in random arm order. Arm on = one DESCRIBE sent at the same instant on a second connection (worst case; the app sends one per saved revision). Provider warmth: warm after the first few requests.',
  summary, pairs };
const out = option('--json');
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(summary, null, 2));
