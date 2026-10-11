#!/usr/bin/env node
// Micro benches for the perf harness (docs/perf/README.md): the Wasm coordinator's input() per
// DRAFT and the tb1 frame codec. Node, same .wasm as the browser.
//
//   node scripts/perf/micro.mjs [--batches 30] [--batch 2000]  → JSON on stdout
//
// Each sample is the mean cost per operation over one batch of `--batch` calls (timer overhead
// amortized); the summary is over batches. Batches of different benches are interleaved so a
// load spike on this shared host hits all of them alike.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : fallback; };
const BATCHES = option('--batches', 30), BATCH = option('--batch', 2000);

const load = path => runnerImport(resolve(root, path), { root, configFile: false, logLevel: 'error' }).then(m => m.module);
const frameLib = await load('src/protocol/frame.ts');
const { loadCoordinator } = await load('src/engine/coordinator.ts');
const { encode, decode, header, json, Kind, Node, Stage, text } = frameLib;

const frame = (kind, fields = {}) => ({ ...header(kind), stamps: [], payload: new Uint8Array(), ...fields });
const texts = Array.from({ length: 64 }, (_, i) => `average speed by hour for vessel ${i}`);
const draft = (revision, value) => frame(Kind.DRAFT, { revision, context: 7, payload: text(value),
  stamps: [{ stage: Stage.KEY_INPUT, node: Node.UI, at: 1 }, { stage: Stage.DRAFT_SENT, node: Node.UI, at: 2 }] });
// A TIMING frame as the coordinator emits it: the full ledger of one drawn request (17 stamps).
const timing = frame(Kind.TIMING, { request: 9, revision: 12, epoch: 1, context: 7,
  stamps: Array.from({ length: 17 }, (_, i) => ({ stage: i + 1, node: 1 + (i % 5), at: 1.79e12 + i * 0.25 })) });
const timingBytes = encode(timing);
const sqlFrame = frame(Kind.SQL, { request: 9, revision: 12, epoch: 1, context: 7,
  payload: text("SELECT date_trunc('hour', ts) AS hour, vessel, avg(speed) AS speed FROM telemetry GROUP BY 1, 2 ORDER BY 1") });

async function boot(config) {
  const wasm = readFileSync(resolve(root, 'public/wasm/tb-coordinator.wasm'));
  const c = await loadCoordinator(wasm);
  c.input('ui', frame(Kind.CONFIG, { payload: json({ freeSlots: [1, 2], ...config }) }), 0);
  c.input('database', frame(Kind.CONTEXT, { context: 7, payload: json({ id: 7 }) }), 0);
  c.drain();
  return c;
}

// The common typing path: `latest` policy with a translation in flight, so a DRAFT is stored.
const latest = await boot({ inferencePolicy: 'latest' });
latest.input('ui', draft(1, 'avg speed'), 0); latest.drain();
// Every DRAFT emits CANCEL + INFER (restart policy, no translation cache).
const restart = await boot({ inferencePolicy: 'restart', translationCache: false });
let revision = 2;
const drafts = Array.from({ length: 64 }, (_, i) => draft(0, texts[i]));

const benches = {
  'micro.coordinator_input_latest': () => { const f = drafts[revision & 63]; f.revision = revision++; latest.input('ui', f, 0); latest.drain(); },
  'micro.coordinator_input_restart': () => { const f = drafts[revision & 63]; f.revision = revision++; restart.input('ui', f, 0); restart.drain(); },
  'micro.frame_encode_timing': () => encode(timing),
  'micro.frame_decode_timing': () => decode(timingBytes),
  'micro.frame_encode_sql': () => encode(sqlFrame),
};
const samples = Object.fromEntries(Object.keys(benches).map(k => [k, []]));
// Warm-up: JIT and Wasm tiers.
for (const fn of Object.values(benches)) for (let i = 0; i < 20_000; i++) fn();
for (let b = 0; b < BATCHES; b++) {
  const names = Object.keys(benches);
  // Rotate the order every batch (interleaving).
  for (let k = 0; k < names.length; k++) {
    const name = names[(k + b) % names.length], fn = benches[name];
    const t0 = performance.now();
    for (let i = 0; i < BATCH; i++) fn();
    samples[name].push(((performance.now() - t0) / BATCH) * 1000);
  }
}
latest.dispose(); restart.dispose();
console.log(JSON.stringify({ unit: 'µs', batches: BATCHES, batch: BATCH, samples }));
