import { readFileSync } from 'node:fs';
import { Dictionary, Float64, Int32, makeData, makeVector, Table, TimestampMicrosecond, type RecordBatch, Utf8, vectorFromArray } from 'apache-arrow';
import { beforeAll, describe, expect, it } from 'vitest';
import type { EngineToUi, LocalFrame } from '../src/engine/contracts';
import { createRenderer, type Renderer } from '../src/engine/render';
import type { NullBackend } from '../src/engine/render/backend';
import { formatMicros } from '../src/engine/render/table';
import { header, Kind, readJson, Stage, type Frame } from '../src/protocol/frame';

const wasm = readFileSync(new URL('../public/wasm/tb-render.wasm', import.meta.url));
const canvas = {} as OffscreenCanvas;
const size = { width: 400, height: 240, devicePixelRatio: 2 };

function u32(v: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; }
const bind = (slot: number, request: number, epoch = 0): LocalFrame => ({ ...header(Kind.BIND, { request, revision: request, epoch }), stamps: [], payload: u32(slot) });
const unbind = (slot: number, request: number): LocalFrame => ({ ...header(Kind.UNBIND, { request }), stamps: [], payload: u32(slot) });
const schemaFrame = (request: number, b: RecordBatch, epoch = 0): LocalFrame => ({ ...header(Kind.RESULT_SCHEMA, { request, epoch }), stamps: [], payload: b.schema });
const batchFrame = (request: number, b: RecordBatch, epoch = 0): LocalFrame => ({ ...header(Kind.BATCH, { request, epoch }), stamps: [], payload: b });
const doneFrame = (request: number, epoch = 0): LocalFrame => ({ ...header(Kind.DONE, { request, epoch }), stamps: [], payload: new Uint8Array(16) });

/** ts (Timestamp µs), vessel (dictionary utf8), speed (f64; row 3 is NULL). */
function series(start: number, rows: number, vessels = ['Aurora', 'Borealis']): RecordBatch {
  const ts = new BigInt64Array(rows), speed = new Float64Array(rows), vessel: string[] = [];
  for (let i = 0; i < rows; i++) {
    ts[i] = BigInt(start + Math.floor(i / vessels.length) * 60_000) * 1000n;
    vessel.push(vessels[i % vessels.length]);
    speed[i] = 10 + Math.sin(i / 10) * 5;
  }
  const nullBitmap = new Uint8Array(Math.ceil(rows / 8)).fill(0xff);
  if (rows > 3) nullBitmap[0] &= ~(1 << 3);
  return new Table({
    ts: makeVector(makeData({ type: new TimestampMicrosecond(), length: rows, data: ts })),
    vessel: vectorFromArray(vessel, new Dictionary(new Utf8(), new Int32())),
    speed: makeVector(makeData({ type: new Float64(), length: rows, data: speed, nullBitmap, nullCount: rows > 3 ? 1 : 0 })),
  }).batches[0];
}

const timestampSchema = () => series(Date.UTC(2026, 0, 1), 8);

interface Harness { r: Renderer; frames: Frame[]; ui: EngineToUi[]; backend: NullBackend }
async function harness(): Promise<Harness> {
  const frames: Frame[] = [], ui: EngineToUi[] = [];
  let t = 1_000;
  const r = await createRenderer(f => frames.push(f as Frame), m => ui.push(m), { wasm, backend: 'null', now: () => ++t });
  r.attach(1, canvas, size);
  r.attach(2, canvas, size);
  r.frame(false);
  return { r, frames, ui, backend: r.backend as NullBackend };
}

const drawn = (frames: Frame[]) => frames.filter(f => f.kind === Kind.DRAWN);
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('tb-render RendererNode (null GPU backend, real Wasm core)', () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); });

  it('reports ready status and a scheduler', () => {
    const status = h.frames.find(f => f.kind === Kind.STATUS)!;
    expect(readJson<{ component: string; label: string }>(status.payload as Uint8Array)).toMatchObject({ component: 'renderer', label: 'null' });
  });

  it('infers roles and posts views on RESULT_SCHEMA', () => {
    const b = timestampSchema();
    h.r.handle(bind(1, 10, 3));
    h.r.handle(schemaFrame(10, b, 3));
    const views = h.ui.filter(m => m.type === 'views').at(-1)!;
    expect(views).toMatchObject({ slot: 1, available: ['line', 'bar', 'scatter', 'heatmap', 'surface', 'seasons', 'table'], chosen: 'line' });
    expect(h.r.views(1)).toEqual(['line', 'bar', 'scatter', 'table', 'heatmap', 'surface', 'seasons']);
  });

  it('draws the first batch synchronously and emits DRAWN with the binding epoch', async () => {
    const before = h.backend.draws;
    h.r.handle(batchFrame(10, timestampSchema(), 3));
    expect(h.backend.draws).toBeGreaterThan(before);
    const d = drawn(h.frames);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ request: 10, epoch: 3, revision: 10 });
    const payload = new DataView((d[0].payload as Uint8Array).buffer);
    expect(payload.getUint32(0, true)).toBe(1);
    expect(payload.getUint32(4, true)).toBe(7); // 8 rows, one null value
    expect(d[0].stamps.map(s => s.stage)).toEqual([Stage.RENDER_FIRST_BATCH, Stage.FIRST_DRAW_SUBMITTED]);
    expect(d[0].stamps[0].at).toBeLessThan(d[0].stamps[1].at);
    await flush();
    const presented = drawn(h.frames)[1];
    expect(presented.stamps.map(s => s.stage)).toEqual([Stage.FIRST_PRESENTED]);
    const axes = h.ui.find(m => m.type === 'axes' && m.slot === 1) as Extract<EngineToUi, { type: 'axes' }>;
    expect(axes.ticks.plot.width).toBeGreaterThan(100);
    expect(axes.ticks.y.length).toBeGreaterThan(1);
    expect(axes.ticks.legend?.map(l => l.label)).toEqual(['Aurora', 'Borealis']);
    const table = h.ui.find(m => m.type === 'table' && m.slot === 1) as Extract<EngineToUi, { type: 'table' }>;
    expect(table.columns).toEqual(['ts', 'vessel', 'speed']);
    expect(table.rows[1][1]).toBe('Borealis');
    expect(table.rows[3][2]).toBe('NULL');
  });

  it('fences stale requests and older epochs', () => {
    const draws = h.backend.draws, count = drawn(h.frames).length;
    h.r.handle(batchFrame(9, timestampSchema()));        // never bound
    h.r.handle(batchFrame(10, timestampSchema(), 2));    // bound request, older epoch
    h.r.frame(false);
    expect(h.backend.draws).toBe(draws);
    expect(drawn(h.frames)).toHaveLength(count);
  });

  it('keeps the old image until the new request draws, then replaces it', () => {
    h.r.handle(bind(1, 11, 4));
    h.r.handle(schemaFrame(11, timestampSchema(), 4));
    h.r.handle(batchFrame(10, timestampSchema(), 3));    // old request: now stale
    const passes = h.backend.passes;
    h.r.frame(false);
    expect(h.backend.passes).toBe(passes);               // nothing redrawn, nothing cleared
    h.r.handle(batchFrame(11, series(Date.UTC(2026, 1, 1), 4, ['Calypso']), 4));
    expect(drawn(h.frames).at(-1)).toMatchObject({ request: 11, epoch: 4 });
    expect(h.backend.passes).toBe(passes + 1);
  });

  it('coalesces later batches into one frame', async () => {
    const passes = h.backend.passes;
    for (let i = 0; i < 5; i++) h.r.handle(batchFrame(11, series(Date.UTC(2026, 1, 2 + i), 64, ['Calypso']), 4));
    expect(h.backend.passes).toBe(passes);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(h.backend.passes).toBe(passes + 1);
  });

  it('survives Wasm memory growth mid-stream', () => {
    const memory = h.r.core.x.memory.buffer.byteLength;
    h.r.handle(batchFrame(11, series(Date.UTC(2026, 2, 1), 200_000, ['Calypso']), 4));
    h.r.frame(false);
    expect(h.r.core.x.memory.buffer.byteLength).toBeGreaterThan(memory);
    h.r.handle(batchFrame(11, series(Date.UTC(2026, 3, 1), 1000, ['Calypso']), 4));
    h.r.frame(false);
    expect(h.r.metrics.lastBatch.rows).toBe(1000);
  });

  it('exports CSV and switches views by hint', async () => {
    h.r.handle(doneFrame(11, 4));
    h.r.export(1);
    const exp = h.ui.find(m => m.type === 'export') as Extract<EngineToUi, { type: 'export' }>;
    const text = await exp.blob.text();
    expect(text.split('\n')[0]).toBe('ts,vessel,speed');
    expect(text.split('\n').length).toBe(4 + 5 * 64 + 200_000 + 1000 + 2);
    h.r.setView(1, 'scatter');
    expect(h.ui.at(-1)).toMatchObject({ type: 'views', chosen: 'scatter' });
  });

  it('UNBIND clears the slot', () => {
    const draws = h.backend.drawsBySlot.get(1);
    expect(draws).toBeGreaterThan(0);
    h.r.handle(unbind(1, 11));
    h.r.frame(false);
    expect(h.backend.drawsBySlot.get(1)).toBe(0);
    expect(h.r.views(1)).toEqual([]);
  });

  it('formats exact UTC microseconds', () => {
    expect(formatMicros(BigInt(Date.UTC(2026, 9, 10, 13, 5, 7)) * 1000n + 1n)).toBe('2026-10-10 13:05:07.000001');
    expect(formatMicros(BigInt(Date.UTC(2026, 9, 10)) * 1000n)).toBe('2026-10-10');
  });
});
