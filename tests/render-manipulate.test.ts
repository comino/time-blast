/** Steady charts and hit-testing through the JS glue and the real tb-render Wasm (null GPU). */
import { readFileSync } from 'node:fs';
import { Dictionary, Float64, Int32, makeData, makeVector, Table, TimestampMicrosecond, type RecordBatch, Utf8, vectorFromArray } from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import type { EngineToUi, LocalFrame } from '../src/engine/contracts';
import { createRenderer } from '../src/engine/render';
import type { NullBackend } from '../src/engine/render/backend';
import { header, Kind, Stage, type Frame } from '../src/protocol/frame';

const wasm = readFileSync(new URL('../public/wasm/tb-render.wasm', import.meta.url));
const canvas = {} as OffscreenCanvas;
const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const bind = (slot: number, request: number): LocalFrame => ({ ...header(Kind.BIND, { request, revision: request }), stamps: [], payload: u32(slot) });
const schema = (request: number, b: RecordBatch): LocalFrame => ({ ...header(Kind.RESULT_SCHEMA, { request }), stamps: [], payload: b.schema });
const batch = (request: number, b: RecordBatch): LocalFrame => ({ ...header(Kind.BATCH, { request }), stamps: [], payload: b });
const done = (request: number): LocalFrame => ({ ...header(Kind.DONE, { request }), stamps: [], payload: new Uint8Array(16) });

const H = 3_600_000;
/** Hourly speed of two vessels; `bump` changes one value. */
function hourly(bump = 0, valueName = 'speed'): RecordBatch {
  const rows = 12, ts = new BigInt64Array(rows), speed = new Float64Array(rows), vessel: string[] = [];
  for (let i = 0; i < rows; i++) {
    ts[i] = BigInt(Date.UTC(2026, 8, 3) + Math.floor(i / 2) * H) * 1000n;
    vessel.push(i % 2 ? 'Borealis' : 'Aurora');
    speed[i] = i % 2 ? 20 + i : 5 + i;
  }
  speed[5] += bump;
  return new Table({
    hour: makeVector(makeData({ type: new TimestampMicrosecond(), length: rows, data: ts })),
    vessel: vectorFromArray(vessel, new Dictionary(new Utf8(), new Int32())),
    [valueName]: makeVector(makeData({ type: new Float64(), length: rows, data: speed })),
  }).batches[0];
}

async function setup(steady = true) {
  const frames: Frame[] = [], ui: EngineToUi[] = [];
  let t = 1_000;
  const r = await createRenderer(f => frames.push(f as Frame), m => ui.push(m), { wasm, backend: 'null', now: () => ++t, steady });
  r.attach(1, canvas, { width: 600, height: 300, devicePixelRatio: 1 });
  r.frame(false);
  const show = (request: number, b: RecordBatch) => { r.handle(bind(1, request)); r.handle(schema(request, b)); r.handle(batch(request, b)); r.handle(done(request)); r.frame(false); };
  return { r, frames, ui, show, backend: r.backend as NullBackend };
}

describe('steady charts (JS glue)', () => {
  it('an identical result is not redrawn and reports one DRAWN with submitted = presented', async () => {
    const { r, frames, show, backend } = await setup();
    show(1, hourly());
    const draws = backend.draws;
    frames.length = 0;
    show(2, hourly(0, 'avg_speed')); // alias variant: same data, new column name
    expect(backend.draws).toBe(draws);
    expect(r.steadyCount).toBe(1);
    const drawn = frames.filter(f => f.kind === Kind.DRAWN && f.request === 2);
    expect(drawn).toHaveLength(1);
    const at = (stage: number) => drawn[0].stamps.find(s => s.stage === stage)?.at;
    expect(at(Stage.FIRST_DRAW_SUBMITTED)).toBeDefined();
    expect(at(Stage.FIRST_PRESENTED)).toBe(at(Stage.FIRST_DRAW_SUBMITTED));
    expect(at(Stage.RENDER_FIRST_BATCH)).toBeLessThan(at(Stage.FIRST_DRAW_SUBMITTED)!);
    // Different data draws as usual.
    show(3, hourly(1));
    expect(backend.draws).toBeGreaterThan(draws);
    expect(r.steadyCount).toBe(1);
  });

  it('off: identical results redraw', async () => {
    const { r, show, backend } = await setup(false);
    show(1, hourly());
    const draws = backend.draws;
    show(2, hourly());
    expect(backend.draws).toBeGreaterThan(draws);
    expect(r.steadyCount).toBe(0);
  });
});

describe('hit-testing (JS glue)', () => {
  it('brush, legend and point map to exact data of the result on screen', async () => {
    const { r, ui, show } = await setup();
    show(4, hourly());
    const axes = ui.filter(m => m.type === 'axes').at(-1) as Extract<EngineToUi, { type: 'axes' }>;
    const { plot } = axes.ticks;
    // Brush the left half of the plot: hours 0..2 of 0..5.
    const brush = r.hit(1, 4, { kind: 'brush', x0: plot.left - 5, x1: plot.left + plot.width * 0.5 })!;
    expect(brush.range).toMatchObject({ column: 0, name: 'hour', type: 'timestamp', lo: Date.UTC(2026, 8, 3) * 1000, hi: Date.UTC(2026, 8, 3, 2) * 1000, count: 6 });
    expect(r.hit(1, 4, { kind: 'legend', index: 1 })!.series).toMatchObject({ column: 1, name: 'vessel', label: 'Borealis', null: false });
    expect(r.hit(1, 99, { kind: 'legend', index: 1 })).toBeNull(); // not the result on screen
    expect(r.hit(1, 4, { kind: 'point', x: 1, y: 1 })).toBeNull(); // outside the plot
  });
});
