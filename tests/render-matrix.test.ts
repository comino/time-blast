import { readFileSync } from 'node:fs';
import { Dictionary, Float64, Int32, makeData, makeVector, Table, TimestampMicrosecond, Utf8, vectorFromArray, type RecordBatch } from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import type { AxisTicks, EngineToUi, LocalFrame } from '../src/engine/contracts';
import { createRenderer } from '../src/engine/render';
import type { NullBackend } from '../src/engine/render/backend';
import { header, Kind, type Frame } from '../src/protocol/frame';

const wasm = readFileSync(new URL('../public/wasm/tb-render.wasm', import.meta.url));
const canvas = {} as OffscreenCanvas;
const size = { width: 480, height: 260, devicePixelRatio: 1 };
const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const bind = (slot: number, request: number): LocalFrame => ({ ...header(Kind.BIND, { request, revision: request, epoch: 0 }), stamps: [], payload: u32(slot) });
const schema = (request: number, b: RecordBatch): LocalFrame => ({ ...header(Kind.RESULT_SCHEMA, { request }), stamps: [], payload: b.schema });
const batch = (request: number, b: RecordBatch): LocalFrame => ({ ...header(Kind.BATCH, { request }), stamps: [], payload: b });

/** ORDER BY ts, station: `series` stations × `buckets` minutes. */
function grid(series: number, buckets: number): RecordBatch {
  const rows = series * buckets, ts = new BigInt64Array(rows), v = new Float64Array(rows), names: string[] = [];
  for (let i = 0; i < rows; i++) {
    ts[i] = BigInt(Date.UTC(2026, 0, 1) + Math.floor(i / series) * 60_000) * 1000n;
    names.push(`st-${i % series}`);
    v[i] = Math.sin(i / 50) * 10 + (i % series);
  }
  return new Table({
    ts: makeVector(makeData({ type: new TimestampMicrosecond(), length: rows, data: ts })),
    station: vectorFromArray(names, new Dictionary(new Utf8(), new Int32())),
    v: makeVector(makeData({ type: new Float64(), length: rows, data: v })),
  }).batches[0];
}

async function harness() {
  const frames: Frame[] = [], ui: EngineToUi[] = [];
  const r = await createRenderer(f => frames.push(f as Frame), m => ui.push(m), { wasm, backend: 'null' });
  r.attach(1, canvas, size);
  r.frame(false);
  return { r, frames, ui, backend: r.backend as NullBackend };
}
const lastViews = (ui: EngineToUi[]) => ui.filter(m => m.type === 'views').at(-1) as Extract<EngineToUi, { type: 'views' }>;
const lastAxes = (ui: EngineToUi[]) => (ui.filter(m => m.type === 'axes').at(-1) as { ticks: AxisTicks }).ticks;

describe('tb-render matrix views (null GPU backend, real Wasm core)', () => {
  it('offers heatmap and surface after the xy views; line stays automatic for few series', async () => {
    const { r, ui, frames } = await harness();
    const b = grid(6, 20);
    r.handle(bind(1, 1)); r.handle(schema(1, b)); r.handle(batch(1, b));
    expect(lastViews(ui)).toMatchObject({ available: ['line', 'bar', 'scatter', 'heatmap', 'surface', 'seasons', 'table'], chosen: 'line' });
    expect(frames.filter(f => f.kind === Kind.DRAWN)).toHaveLength(1);
  });

  it('switches to the heatmap before the first draw when many series arrive, with a colour legend', async () => {
    const { r, ui, frames } = await harness();
    const b = grid(30, 10);
    r.handle(bind(1, 2)); r.handle(schema(2, b));
    expect(lastViews(ui).chosen).toBe('line');
    r.handle(batch(2, b));
    expect(lastViews(ui)).toMatchObject({ chosen: 'heatmap', available: ['heatmap', 'line', 'bar', 'scatter', 'surface', 'seasons', 'table'] });
    expect(frames.filter(f => f.kind === Kind.DRAWN)).toHaveLength(1);
    const ticks = lastAxes(ui);
    expect(ticks.legend!.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ticks.legend!.map(l => l.color)).size).toBe(ticks.legend!.length);
    expect(ticks.y.length).toBeGreaterThan(3);
  });

  it('draws the surface and redraws on rotation without new vertex data', async () => {
    const { r, ui, backend } = await harness();
    const b = grid(4, 50);
    r.setView(1, 'surface');
    r.handle(bind(1, 3)); r.handle(schema(3, b)); r.handle(batch(3, b));
    expect(lastViews(ui).chosen).toBe('surface');
    r.frame(false);
    const draws = backend.draws;
    r.setParam(1, 'rotation', -10);
    r.frame(false);
    expect(backend.draws - draws).toBe(11); // 4 floors + 2 floor edges + 4 ribbons + value axis
    expect(r.metrics.lastFrame.uploadedBytes).toBeLessThanOrEqual(16 * 256);
    expect(lastAxes(ui).x.length).toBeGreaterThanOrEqual(2);
  });
});
