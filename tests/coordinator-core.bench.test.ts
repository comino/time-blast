// Opt-in micro-benchmark of the Wasm coordinator's input() cost per DRAFT.
// Run: TB_BENCH=1 pnpm vitest run tests/coordinator-core.bench.test.ts --silent=false
// Results and method: docs/batch-1/coordinator.md.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadCoordinator, type WasmCoordinator } from '../src/engine/coordinator';
import { encode, header, json, Kind, Node, Stage, text, type Frame } from '../src/protocol/frame';

const wasm = readFileSync(new URL('../public/wasm/tb-coordinator.wasm', import.meta.url));
const ITERATIONS = 200_000, WARMUP = 20_000, N = ITERATIONS + WARMUP;
const frame = (kind: Kind, fields: Partial<Frame> = {}): Frame => ({ ...header(kind), stamps: [], payload: new Uint8Array(), ...fields });
const draft = (revision: number, value: string): Frame => frame(Kind.DRAFT, { revision, context: 7, payload: text(value),
  stamps: [{ stage: Stage.KEY_INPUT, node: Node.UI, at: 1 }, { stage: Stage.DRAFT_SENT, node: Node.UI, at: 2 }] });
const texts = Array.from({ length: 64 }, (_, i) => `average speed by hour for vessel ${i}`);

const percentile = (sorted: Float64Array, p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

/** Times `step(i)` per call (performance.now(), sub-µs resolution in Node); `after(i)` runs
 * untimed. Also reports the batch mean of step+after, which has no per-call timer overhead. */
function measure(name: string, step: (i: number) => void, after: (i: number) => void = () => {}) {
  for (let i = 0; i < WARMUP; i++) { step(i); after(i); }
  const samples = new Float64Array(ITERATIONS);
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now(); step(WARMUP + i); samples[i] = performance.now() - t0; after(WARMUP + i);
  }
  const total = performance.now() - start;
  samples.sort();
  const us = (ms: number) => (ms * 1000).toFixed(2);
  console.log(`${name}: median ${us(percentile(samples, 0.5))} µs, p99 ${us(percentile(samples, 0.99))} µs, p99.9 ${us(percentile(samples, 0.999))} µs, batch mean incl. untimed part ${us(total / ITERATIONS)} µs`);
}

async function boot(config: object): Promise<WasmCoordinator> {
  const c = await loadCoordinator(wasm);
  c.input('ui', frame(Kind.CONFIG, { payload: json({ freeSlots: [1, 2], ...config }) }), 0);
  c.input('database', frame(Kind.CONTEXT, { context: 7, payload: json({ id: 7 }) }), 0);
  c.drain();
  return c;
}

describe.skipIf(!process.env.TB_BENCH)('tb-coordinator wasm input() cost', () => {
  it('measures DRAFT handling', async () => {
    const decoded = Array.from({ length: N }, (_, i) => draft(i + 2, texts[i & 63]));
    const encoded = decoded.map(f => encode(f));
    const timer = new Float64Array(ITERATIONS);
    const t = performance.now();
    for (let i = 0; i < ITERATIONS; i++) timer[i] = performance.now();
    console.log(`performance.now() pair overhead ≈ ${(((performance.now() - t) / ITERATIONS) * 1000).toFixed(3)} µs`);

    // 1. latest policy, translation in flight: the DRAFT is only stored (the common typing path).
    for (const [label, feed] of [['Frame', (c: WasmCoordinator, i: number) => c.input('ui', decoded[i], 0)],
      ['encoded', (c: WasmCoordinator, i: number) => c.inputEncoded('ui', encoded[i], 0)]] as const) {
      const c = await boot({ inferencePolicy: 'latest' });
      c.input('ui', draft(1, 'avg speed'), 0); c.drain();
      measure(`latest, in flight, input(${label})`, i => feed(c, i), () => c.drain());
      c.dispose();
    }
    // 2. restart policy: every DRAFT emits CANCEL + INFER.
    for (const [label, feed] of [['Frame', (c: WasmCoordinator, i: number) => c.input('ui', decoded[i], 0)],
      ['encoded', (c: WasmCoordinator, i: number) => c.inputEncoded('ui', encoded[i], 0)]] as const) {
      const c = await boot({ inferencePolicy: 'restart', translationCache: false });
      measure(`restart, CANCEL+INFER, input(${label})`, i => feed(c, i), () => c.drain());
      c.dispose();
    }
    const c = await boot({ inferencePolicy: 'restart', translationCache: false });
    measure('restart, CANCEL+INFER, drain() of 2 frames', () => c.drain(), i => c.input('ui', decoded[i], 0));
    c.dispose();
    expect(true).toBe(true);
  }, 120_000);
});
