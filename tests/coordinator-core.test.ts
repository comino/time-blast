// Drives the real built public/wasm/tb-coordinator.wasm through the CoordinatorCore loader.
// Rule-by-rule coverage lives in the native Rust tests (crates/tb-coordinator/src/tests.rs);
// this checks the ABI, the loader and one realistic session end to end.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCoordinator, type WasmCoordinator } from '../src/engine/coordinator';
import type { LinkId } from '../src/engine/contracts';
import { encode, Flag, header, json, Kind, Node, readJson, readText, Stage, text, type Frame } from '../src/protocol/frame';

const wasm = readFileSync(new URL('../public/wasm/tb-coordinator.wasm', import.meta.url));
const CTX = 7;
let core: WasmCoordinator | undefined;
afterEach(() => { core?.dispose(); core = undefined; });

const frame = (kind: Kind, fields: Partial<Frame> = {}): Frame =>
  ({ ...header(kind), stamps: [], payload: new Uint8Array(), ...fields });
const draft = (kind: Kind, revision: number, value: string, at: number): Frame =>
  frame(kind, { revision, context: CTX, payload: text(value), stamps: [
    { stage: Stage.KEY_INPUT, node: Node.UI, at: at - 2 }, { stage: Stage.DRAFT_SENT, node: Node.UI, at: at - 1 }] });
const slotPayload = (slot: number, points = 0) => new Uint8Array(new Uint32Array([slot, points]).buffer);
const summary = (out: Array<[LinkId, Frame]>) => out.map(([link, f]) => `${link}:${f.kind.toString(16)}`);

async function boot(config: object = { freeSlots: [1, 2] }) {
  core = await loadCoordinator(wasm);
  core.input('ui', frame(Kind.CONFIG, { payload: json(config) }), 0);
  core.input('database', frame(Kind.CONTEXT, { context: CTX, payload: json({ id: CTX, name: 't' }) }), 0);
  const out = core.drain();
  expect(summary(out)).toEqual([`inference:${Kind.CONTEXT.toString(16)}`]);
  return core;
}

describe('tb-coordinator wasm', () => {
  it('runs a typed session: draft → INFER → SQL → BIND/EXEC → RESULT → DRAWN → TIMING → COMMIT/KEEP', async () => {
    const c = await boot();
    c.input('ui', draft(Kind.DRAFT, 1, 'avg', 1000), 1000);
    const [[link, infer]] = c.drain();
    expect(link).toBe('inference');
    expect(infer).toMatchObject({ kind: Kind.INFER, request: 1, revision: 1, context: CTX, epoch: 0 });
    expect(readText(infer.payload)).toBe('avg');
    expect(infer.stamps.map(s => s.stage)).toEqual([Stage.KEY_INPUT, Stage.DRAFT_SENT, Stage.COORD_RECEIVED, Stage.INFER_SENT]);

    // latest: newer keystrokes wait for the in-flight translation.
    c.input('ui', draft(Kind.DRAFT, 2, 'avg sp', 1010), 1010);
    c.input('ui', draft(Kind.DRAFT, 3, 'avg speed', 1020), 1020);
    expect(c.drain()).toEqual([]);

    c.input('inference', frame(Kind.SQL, { request: 1, payload: text('-- view: line\nSELECT 1') }), 1100);
    let out = c.drain();
    expect(summary(out)).toEqual(['inference:18', 'renderer:30', 'ui:30', 'database:20']);
    expect(out[0][1]).toMatchObject({ request: 2, revision: 3 });
    expect(out[3][1].flags).toBe(Flag.SPECULATIVE);
    expect(new DataView(out[1][1].payload.buffer, out[1][1].payload.byteOffset).getUint32(0, true)).toBe(1);

    c.input('database', frame(Kind.RESULT_SCHEMA, { request: 1, flags: Flag.HEADER_ONLY, stamps: [{ stage: Stage.EXEC_RECEIVED, node: Node.DATABASE, at: 1101 }] }), 1101);
    out = c.drain();
    expect(summary(out)).toEqual(['ui:33']);
    // 'avg' never asks for a line chart, so the unasked hint is not honored.
    expect(readJson(out[0][1].payload)).toEqual({ slot: 1, sql: '-- view: line\nSELECT 1', columns: [], view: null, cached: false });

    c.input('renderer', frame(Kind.DRAWN, { request: 1, payload: slotPayload(1, 24), stamps: [{ stage: Stage.FIRST_DRAW_SUBMITTED, node: Node.RENDERER, at: 1105 }] }), 1105);
    out = c.drain();
    expect(summary(out)).toEqual(['ui:34']);
    expect(out[0][1].stamps.at(-1)).toEqual({ stage: Stage.FIRST_DRAW_SUBMITTED, node: Node.RENDERER, at: 1105 });
    expect(out[0][1].stamps[0]).toEqual({ stage: Stage.KEY_INPUT, node: Node.UI, at: 998 });

    // Newer translation with identical SQL: rebind the revision, no EXEC.
    c.input('inference', frame(Kind.SQL, { request: 2, payload: text('-- view: line\nSELECT 1') }), 1200);
    out = c.drain();
    expect(summary(out)).toEqual(['ui:34', 'ui:30']);
    expect(out[1][1]).toMatchObject({ kind: Kind.BIND, request: 1, revision: 3 });

    // Enter on the shown text keeps the slot at once.
    c.input('ui', draft(Kind.COMMIT, 3, 'avg speed', 1300), 1300);
    out = c.drain();
    expect(summary(out)).toEqual(['ui:35']);
    expect(out[0][1]).toMatchObject({ request: 1, revision: 3 });
  });

  it('applies the latency dial to cache hits through tick/nextDeadline', async () => {
    const c = await boot();
    c.input('ui', draft(Kind.DRAFT, 1, 'avg speed', 10), 10);
    c.input('inference', frame(Kind.SQL, { request: 1, payload: text('SELECT 1') }), 20);
    c.input('ui', draft(Kind.DRAFT, 2, 'max speed', 30), 30);
    c.input('inference', frame(Kind.SQL, { request: 2, payload: text('SELECT 2') }), 40);
    c.input('ui', frame(Kind.CONFIG, { payload: json({ latencyDialMs: 25 }) }), 41);
    c.drain();
    expect(c.nextDeadline()).toBeNull();
    c.input('ui', draft(Kind.DRAFT, 3, 'avg speed', 100), 100);
    expect(c.drain()).toEqual([]);
    expect(c.nextDeadline()).toBe(125);
    c.tick(124);
    expect(c.drain()).toEqual([]);
    c.tick(125);
    const out = c.drain();
    expect(summary(out)).toEqual(['database:12', 'renderer:30', 'ui:30', 'database:20']);
    expect(readText(out[3][1].payload)).toBe('SELECT 1');
    expect(c.nextDeadline()).toBeNull();
  });

  it('accepts encoded frames, fences cancelled epochs and reports input errors', async () => {
    const c = await boot();
    c.inputEncoded('ui', encode(draft(Kind.DRAFT, 1, 'avg speed', 5)), 5);
    expect(summary(c.drain())).toEqual(['inference:18']);
    c.input('ui', frame(Kind.CANCEL), 6);
    const out = c.drain();
    expect(summary(out)).toEqual(['inference:12', 'database:12']);
    expect(out.every(([, f]) => f.epoch === 1 && f.request === 0)).toBe(true);
    c.input('inference', frame(Kind.SQL, { request: 1, epoch: 0, payload: text('SELECT 1') }), 7);
    expect(c.drain()).toEqual([]);

    expect(() => c.input('ui', frame(Kind.CONFIG, { payload: text('{') }), 8)).toThrow(/CONFIG payload/);
    expect(() => c.inputEncoded('ui', new Uint8Array(10), 8)).toThrow(/truncated frame/);
    expect(() => c.input('ui', frame(Kind.DRAFT, { revision: 9, epoch: 1, payload: new Uint8Array([0xff]) }), 8)).toThrow(/UTF-8/);
  });

  it('survives memory growth with large frames and returns independent buffers', async () => {
    const c = await boot();
    const big = 'x'.repeat(3 << 20);
    c.input('ui', draft(Kind.DRAFT, 1, big, 1), 1);
    const [[, infer]] = c.drain();
    expect(infer.payload.byteLength).toBe(big.length);
    c.input('ui', draft(Kind.DRAFT, 2, 'avg speed', 2), 2);
    c.input('inference', frame(Kind.SQL, { request: 1, payload: text('SELECT big') }), 3);
    const out = c.drain();
    const buffers = new Set(out.map(([, f]) => f.payload.buffer));
    expect(buffers.size).toBe(out.length);
    expect(readText(infer.payload)).toBe(big);
  });

  it('isolates coordinators that share one module', async () => {
    const module = await WebAssembly.compile(wasm);
    const a = await loadCoordinator(module), b = await loadCoordinator(module);
    try {
      a.input('ui', frame(Kind.CANCEL), 0);
      a.drain();
      b.input('ui', frame(Kind.HELLO), 0);
      const [[link, ready]] = b.drain();
      expect(link).toBe('ui');
      expect(ready.epoch).toBe(0);
      expect(readJson(ready.payload)).toMatchObject({ node: 'coordinator' });
    } finally { a.dispose(); b.dispose(); }
    expect(() => a.drain()).toThrow(/disposed/);
  });
});
