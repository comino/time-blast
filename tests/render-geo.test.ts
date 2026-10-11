import { readFileSync } from 'node:fs';
import { Dictionary, Float64, Int32, makeData, makeVector, Table, TimestampMicrosecond, type RecordBatch, Utf8, vectorFromArray } from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import type { EngineToUi, LocalFrame } from '../src/engine/contracts';
import { createRenderer } from '../src/engine/render';
import type { NullBackend } from '../src/engine/render/backend';
import { header, Kind, type Frame } from '../src/protocol/frame';

// Geo views (map, density, tracks) through the real Wasm core with the null GPU backend.
// Pixels are checked by tests/render_geo.py in a browser.

const wasm = readFileSync(new URL('../public/wasm/tb-render.wasm', import.meta.url));
const canvas = {} as OffscreenCanvas;
const size = { width: 400, height: 240, devicePixelRatio: 1 };

const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const bind = (slot: number, request: number): LocalFrame => ({ ...header(Kind.BIND, { request, revision: request }), stamps: [], payload: u32(slot) });
const schema = (request: number, b: RecordBatch): LocalFrame => ({ ...header(Kind.RESULT_SCHEMA, { request }), stamps: [], payload: b.schema });
const batch = (request: number, b: RecordBatch): LocalFrame => ({ ...header(Kind.BATCH, { request }), stamps: [], payload: b });
const done = (request: number): LocalFrame => ({ ...header(Kind.DONE, { request }), stamps: [], payload: new Uint8Array(16) });
const f64 = (a: number[]) => makeVector(makeData({ type: new Float64(), length: a.length, data: new Float64Array(a) }));

/** ts, vessel, lat, lon, speed: two vessels, `rows` positions interleaved in time. */
function voyages(rows: number): RecordBatch {
  const ts = new BigInt64Array(rows), lat: number[] = [], lon: number[] = [], speed: number[] = [], vessel: string[] = [];
  for (let i = 0; i < rows; i++) {
    const s = i % 2, k = Math.floor(i / 2);
    ts[i] = BigInt(Date.UTC(2026, 0, 1) + k * 60_000) * 1000n;
    vessel.push(s ? 'Borealis' : 'Aurora'); lat.push(54 + s + k * 0.01); lon.push(8 + k * 0.02); speed.push(10 + s);
  }
  return new Table({
    ts: makeVector(makeData({ type: new TimestampMicrosecond(), length: rows, data: ts })),
    vessel: vectorFromArray(vessel, new Dictionary(new Utf8(), new Int32())),
    lat: f64(lat), lon: f64(lon), speed: f64(speed),
  }).batches[0];
}

async function harness() {
  const frames: Frame[] = [], ui: EngineToUi[] = [];
  const r = await createRenderer(f => frames.push(f as Frame), m => ui.push(m), { wasm, backend: 'null' });
  r.attach(1, canvas, size);
  r.frame(false);
  return { r, frames, ui, backend: r.backend as NullBackend };
}

describe('tb-render geo family (null GPU backend, real Wasm core)', () => {
  it('chooses tracks for time + positions and draws the first batch synchronously', async () => {
    const { r, frames, ui, backend } = await harness();
    const b = voyages(40);
    r.handle(bind(1, 1)); r.handle(schema(1, b));
    expect(ui.filter(m => m.type === 'views').at(-1)).toMatchObject({ chosen: 'tracks', available: ['tracks', 'map', 'density', 'line', 'bar', 'scatter', 'table'] });
    const before = backend.draws;
    r.handle(batch(1, b));
    expect(backend.draws).toBeGreaterThan(before);
    const drawn = frames.find(f => f.kind === Kind.DRAWN)!;
    expect(new DataView((drawn.payload as Uint8Array).buffer).getUint32(4, true)).toBe(40);
    // The coastline follows in the next frame (never on the first-draw path).
    const firstUpload = r.metrics.lastFrame.uploadedBytes;
    r.frame(false);
    expect(r.metrics.lastFrame.uploadedBytes).toBeGreaterThanOrEqual(8344 * 2);
    expect(firstUpload).toBeLessThan(8344 * 2);
    r.handle(done(1));
    // Legend: one entry per vessel plus the graticule step.
    const axes = ui.filter(m => m.type === 'axes').at(-1) as Extract<EngineToUi, { type: 'axes' }>;
    expect(axes.ticks.legend!.map(l => l.label).slice(0, 2)).toEqual(['Aurora', 'Borealis']);
    expect(axes.ticks.x).toEqual([]);
  });

  it('switches to map and density without losing the result, and playback redraws', async () => {
    const { r, backend } = await harness();
    r.handle(bind(1, 2)); r.handle(schema(2, voyages(10))); r.handle(batch(2, voyages(10))); r.handle(done(2));
    r.frame(false);
    for (const view of ['map', 'density', 'tracks'] as const) {
      r.setView(1, view);
      const before = backend.draws;
      r.frame(false);
      expect(backend.draws, view).toBeGreaterThan(before);
    }
    const frames = backend.frames;
    r.setParam(1, 'playback', 0.5);
    r.frame(false);
    expect(backend.frames).toBe(frames + 1);
  });

  it('maps positions without time and colours a value legend', async () => {
    const { r, ui } = await harness();
    const b = new Table({ lat: f64([51.9, 53.5, 57.7]), lon: f64([4.1, 9.9, 11.9]), calls: f64([2210, 1240, 610]) }).batches[0];
    r.handle(bind(1, 3)); r.handle(schema(3, b)); r.handle(batch(3, b)); r.handle(done(3));
    r.frame(false);
    expect(ui.filter(m => m.type === 'views').at(-1)).toMatchObject({ chosen: 'map', available: ['map', 'density', 'table'] });
    const axes = ui.filter(m => m.type === 'axes').at(-1) as Extract<EngineToUi, { type: 'axes' }>;
    expect(axes.ticks.legend![0]).toEqual({ label: 'calls 610', color: '#3b528b' });
  });
});
