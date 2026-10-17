// Regression coverage across the shipped coordinator/renderer Wasm and the real host.
// The database is deterministic; no provider, DuckDB or browser is needed.
import { readFileSync } from 'node:fs';
import { tableFromArrays } from 'apache-arrow';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCoordinator } from '../src/engine/coordinator';
import type { Emit, EngineToUi, LinkId } from '../src/engine/contracts';
import { EngineHost } from '../src/engine/host';
import { createRenderer, type Renderer } from '../src/engine/render';
import type { NullBackend } from '../src/engine/render/backend';
import { decode, encode, header, json, Kind, readJson, text, type Frame, type Header } from '../src/protocol/frame';

const coordinatorWasm = readFileSync(new URL('../public/wasm/tb-coordinator.wasm', import.meta.url));
const rendererWasm = readFileSync(new URL('../public/wasm/tb-render.wasm', import.meta.url));
const SLOT = 90, CONTEXT = 7;
const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

const frame = (kind: Kind, fields: Partial<Omit<Header, 'kind'>> = {}, payload: Uint8Array = new Uint8Array()): Frame =>
  ({ ...header(kind, fields), kind, stamps: [], payload });
function words(...values: number[]): Uint8Array {
  const bytes = new Uint8Array(4 * values.length), view = new DataView(bytes.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value, true));
  return bytes;
}
function prefixed(value: number, content: string): Uint8Array {
  const suffix = text(content), bytes = new Uint8Array(4 + suffix.length);
  bytes.set(words(value)); bytes.set(suffix, 4);
  return bytes;
}
const take = (outputs: Array<[LinkId, Frame]>, link: LinkId, kind: Kind): Frame[] =>
  outputs.filter(([destination, f]) => destination === link && f.kind === kind).map(([, f]) => f);
const payloads = (frames: Frame[]) => frames.map(f => readJson(f.payload));

async function coordinatorHarness() {
  const core = await loadCoordinator(coordinatorWasm);
  cleanup.push(() => core.dispose());
  let now = 0;
  const send = (link: LinkId, f: Frame) => { core.input(link, f, ++now); return core.drain(); };
  send('database', frame(Kind.CONTEXT, { context: CONTEXT }, json({ id: CONTEXT, name: 'test', dialect: 'duckdb', tables: [] })));
  return {
    send,
    register: (generation = 1) => send('ui', frame(Kind.REGISTER_TARGET, { context: CONTEXT }, words(SLOT, generation))),
    release: (generation = 1) => send('ui', frame(Kind.RELEASE_TARGET, { context: CONTEXT }, words(SLOT, generation))),
    query: (revision: number, sql: string, generation = 1) =>
      send('ui', frame(Kind.QUERY, { request: generation, revision, context: CONTEXT }, prefixed(SLOT, sql))),
    draft: (revision: number, question: string, commit = false) =>
      send('ui', frame(commit ? Kind.COMMIT : Kind.DRAFT, { request: SLOT, revision, context: CONTEXT }, prefixed(1, question))),
  };
}

describe('canvas target protocol (real coordinator Wasm)', () => {
  it('rejects reordered QUERY sequences without cancelling the newer execution', async () => {
    const h = await coordinatorHarness(); h.register();
    const current = take(h.query(2, 'SELECT 2'), 'database', Kind.EXEC)[0];
    expect(h.query(1, 'SELECT 1')).toEqual([]);
    expect(h.query(2, 'SELECT 3')).toEqual([]);
    expect(payloads(take(h.send('database', frame(Kind.DONE, current)), 'ui', Kind.EXECUTION)))
      .toEqual([{ slot: SLOT, generation: 1, status: 'succeeded' }]);
    h.draft(5, 'average wind');
    expect(h.query(4, 'SELECT 4')).toEqual([]);
  });

  it('keeps unseen and future release tombstones until a newer registration arrives', async () => {
    const h = await coordinatorHarness(); h.release();
    expect(h.register()).toEqual([]);
    expect(h.query(1, 'SELECT 1')).toEqual([]);
    h.register(2);
    const request = take(h.query(1, 'SELECT 2', 2), 'database', Kind.EXEC)[0].request;
    expect(take(h.release(3), 'database', Kind.CANCEL)).toMatchObject([{ request }]);
    expect(h.register(2)).toEqual([]);
    expect(h.register(3)).toEqual([]);
    expect(h.query(2, 'SELECT 3', 3)).toEqual([]);
    h.register(4);
    expect(take(h.query(1, 'SELECT 4', 4), 'database', Kind.EXEC)).toHaveLength(1);
  });

  it('rejects changed text at an existing sequence and accepts its unchanged COMMIT', async () => {
    const h = await coordinatorHarness(); h.register();
    const request = take(h.draft(1, 'average wind'), 'inference', Kind.INFER)[0].request;
    h.send('inference', frame(Kind.SQL, { request }, text('SELECT 1')));
    h.send('database', frame(Kind.DONE, { request }));
    expect(() => h.draft(1, 'maximum wind', true)).toThrow(/malformed payload/);
    const commit = h.draft(1, 'average wind', true);
    expect(take(commit, 'inference', Kind.INFER)).toEqual([]);
    expect(take(commit, 'database', Kind.EXEC)).toEqual([]);
  });

  it('waits for SQL before announcing an adopted candidate', async () => {
    const h = await coordinatorHarness(); h.register();
    const request = take(h.draft(1, 'average wind'), 'inference', Kind.INFER)[0].request;
    h.draft(2, 'average wind extra');
    expect(take(h.draft(3, 'average wind'), 'ui', Kind.CANDIDATE)).toEqual([]);
    const completed = h.send('inference', frame(Kind.SQL, { request }, text('SELECT 1')));
    expect(take(completed, 'ui', Kind.CANDIDATE)).toMatchObject([{ request, revision: 3 }]);
    expect(payloads(take(completed, 'ui', Kind.CANDIDATE))).toEqual([{ slot: SLOT, generation: 1, sql: 'SELECT 1' }]);
  });

  it.each([false, true])('keeps an adopted sequence ahead of a slower detour (committed=%s)', async committed => {
    const h = await coordinatorHarness(); h.register();
    h.send('ui', frame(Kind.CONFIG, {}, json({ inferencePolicy: 'latest' })));
    const first = take(h.draft(1, 'average wind'), 'inference', Kind.INFER)[0].request;
    h.send('inference', frame(Kind.SQL, { request: first }, text('SELECT 1')));
    h.send('database', frame(Kind.DONE, { request: first }));
    const detour = take(h.draft(2, 'maximum wind', committed), 'inference', Kind.INFER)[0].request;
    const adopted = h.draft(3, 'average wind');
    expect(take(adopted, 'ui', Kind.CANDIDATE)).toMatchObject([{ request: first, revision: 3 }]);
    expect(payloads(take(adopted, 'ui', Kind.EXECUTION))).toEqual([{ slot: SLOT, generation: 1, status: 'succeeded' }]);
    const late = h.send('inference', frame(Kind.SQL, { request: detour }, text('SELECT 2')));
    expect(take(late, 'renderer', Kind.BIND)).toEqual([]);
    expect(take(late, 'database', Kind.EXEC)).toEqual([]);
    expect(payloads(take(late, 'ui', Kind.EXECUTION))).toEqual([{ slot: SLOT, generation: 1, status: 'cancelled' }]);
  });

  it.each(['release', 'global cancel', 'source suspension'])('terminalizes translated, unexecuted work on %s', async action => {
    const h = await coordinatorHarness(); h.register();
    h.send('ui', frame(Kind.CONFIG, {}, json({ speculate: false })));
    const request = take(h.draft(1, 'average wind'), 'inference', Kind.INFER)[0].request;
    const translated = h.send('inference', frame(Kind.SQL, { request }, text('SELECT 1')));
    expect(take(translated, 'ui', Kind.CANDIDATE)).toHaveLength(1);
    expect(take(translated, 'database', Kind.EXEC)).toEqual([]);
    const cancelled = action === 'release' ? h.release()
      : action === 'global cancel' ? h.send('ui', frame(Kind.CANCEL)) : h.send('database', frame(Kind.CONTEXT));
    expect(take(cancelled, 'ui', Kind.EXECUTION)).toMatchObject([{ request, revision: 1 }]);
    expect(payloads(take(cancelled, 'ui', Kind.EXECUTION))).toEqual([{ slot: SLOT, generation: 1, status: 'cancelled' }]);
    expect(take(h.send('database', frame(Kind.DONE, { request })), 'ui', Kind.EXECUTION)).toEqual([]);
  });

  it.each([false, true])('keeps a document slot out of CONFIG.freeSlots (released=%s)', async released => {
    const h = await coordinatorHarness(); h.register(); if (released) h.release();
    h.send('ui', frame(Kind.CONFIG, {}, json({ freeSlots: [SLOT, SLOT + 1] })));
    const draft = h.send('ui', frame(Kind.DRAFT, { context: CONTEXT, revision: 1 }, text('average wind')));
    const request = take(draft, 'inference', Kind.INFER)[0].request;
    const translated = h.send('inference', frame(Kind.SQL, { request }, text('SELECT 1')));
    const bind = take(translated, 'renderer', Kind.BIND)[0];
    expect(new DataView(bind.payload.buffer, bind.payload.byteOffset).getUint32(0, true)).toBe(SLOT + 1);
    expect(take(translated, 'database', Kind.EXEC)).toHaveLength(1);
  });
});

async function hostHarness(complete = false) {
  const core = await loadCoordinator(coordinatorWasm);
  let resolveRenderer!: () => void;
  const gate = new Promise<void>(resolve => { resolveRenderer = resolve; });
  let renderer!: Renderer, emitDatabase!: Emit;
  const drawn: number[] = [], posted: EngineToUi[] = [], executions: Frame[] = [];
  const batch = tableFromArrays({ x: new Float64Array([1, 2]), y: new Float64Array([4, 5]) }).batches[0];
  const host = new EngineHost({
    createCoordinator: async () => core,
    createRenderer: async (emit, ui) => {
      await gate;
      renderer = await createRenderer(f => { if (f.kind === Kind.DRAWN) drawn.push(f.request); emit(f); }, ui,
        { wasm: rendererWasm, backend: 'null' });
      return renderer;
    },
    createDatabase: async emit => {
      emitDatabase = emit;
      return {
        open: async (source, id) => ({ id, name: source.name, dialect: 'duckdb', tables: [] }),
        handle(f) {
          if (f.kind !== Kind.EXEC) return;
          executions.push(f);
          emit({ ...f, kind: Kind.RESULT_SCHEMA, payload: batch.schema });
          emit({ ...f, kind: Kind.BATCH, payload: batch });
          if (complete) emit(frame(Kind.DONE, f));
        },
        dispose() {},
      };
    },
    postToUi: message => posted.push(message),
    connectInference: () => { throw new Error('SQL hydration must not call inference'); },
  });
  cleanup.push(() => { renderer?.detach(SLOT); host.dispose(); });
  host.onMessage({ type: 'attach', slot: SLOT, canvas: {} as OffscreenCanvas, size: { width: 400, height: 240, devicePixelRatio: 1 } });
  await host.openDataset({ kind: 'fixture', name: 'first' });
  const send = (f: Frame) => host.onMessage({ type: 'frame', bytes: encode(f).buffer as ArrayBuffer });
  return {
    host, send, drawn, posted, executions,
    register: (generation = 1) => send(frame(Kind.REGISTER_TARGET, { context: 1 }, words(SLOT, generation))),
    query: (revision = 1, generation = 1) => {
      send(frame(Kind.QUERY, { context: 1, request: generation, revision }, prefixed(SLOT, `SELECT ${revision}`)));
      return executions.at(-1)!;
    },
    release: () => send(frame(Kind.RELEASE_TARGET, { context: 1 }, words(SLOT, 1))),
    lateReply: (execution: Frame) => {
      emitDatabase({ ...execution, kind: Kind.RESULT_SCHEMA, payload: batch.schema });
      emitDatabase({ ...execution, kind: Kind.BATCH, payload: batch });
      emitDatabase(frame(Kind.DONE, execution));
    },
    uiFrames: () => posted.filter(m => m.type === 'frame').map(m => decode(new Uint8Array(m.bytes))),
    startRenderer: async () => { resolveRenderer(); await host.ready; renderer.frame(false); return renderer.backend as NullBackend; },
  };
}

describe('canvas startup (real host, coordinator and renderer Wasm)', () => {
  it.each(['generation', 'query revision'])('draws only the latest queued result after a newer %s', async replacement => {
    const h = await hostHarness(); h.register(); const old = h.query();
    if (replacement === 'generation') h.register(2);
    const current = replacement === 'generation' ? h.query(1, 2) : h.query(2);
    const backend = await h.startRenderer();
    expect(h.drawn).not.toContain(old.request);
    expect(h.drawn).toContain(current.request);
    expect(backend.draws).toBeGreaterThan(0);
    expect(h.posted.filter(m => m.type === 'table')).toMatchObject([
      { request: current.request, generation: replacement === 'generation' ? 2 : 1, total: 2 },
    ]);
    h.lateReply(old);
    expect(h.drawn).not.toContain(old.request);
  });

  it.each(['release', 'global cancel', 'source change'])('never draws an unfinished queued result after %s', async action => {
    const h = await hostHarness(); h.register(); const execution = h.query();
    if (action === 'release') h.release();
    else if (action === 'global cancel') h.send(frame(Kind.CANCEL));
    else await h.host.openDataset({ kind: 'fixture', name: 'second' });
    expect(payloads(h.uiFrames().filter(f => f.kind === Kind.EXECUTION)))
      .toEqual([{ slot: SLOT, generation: 1, status: 'cancelled' }]);
    const backend = await h.startRenderer();
    h.lateReply(execution);
    expect(h.drawn).toEqual([]);
    expect(backend.draws).toBe(0);
    expect(h.posted.filter(m => m.type === 'table')).toEqual([]);
  });

  it('still renders completed queued data after activating another source', async () => {
    const h = await hostHarness(true); h.register(); const execution = h.query();
    await h.host.openDataset({ kind: 'fixture', name: 'second' });
    const backend = await h.startRenderer();
    expect(h.drawn).toContain(execution.request);
    expect(backend.draws).toBeGreaterThan(0);
    expect(payloads(h.uiFrames().filter(f => f.kind === Kind.EXECUTION)))
      .toEqual([{ slot: SLOT, generation: 1, status: 'succeeded' }]);
    expect(h.posted.filter(m => m.type === 'table').at(-1)).toMatchObject({ request: execution.request, generation: 1, total: 2 });
  });
});
