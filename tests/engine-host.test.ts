import { describe, expect, it, vi } from 'vitest';
import { EngineHost, type HostDeps, type Timers } from '../src/engine/host';
import { createInProcessPair } from '../src/engine/links';
import type {
  CoordinatorCore, DatabaseNode, DatasetContext, Emit, EngineToUi, Hit, Link, LinkId, LocalFrame, PointerGesture, PostToUi, RendererNode, UiToEngine,
} from '../src/engine/contracts';
import { decode, encode, Flag, header, json, Kind, readJson, readText, text, type Frame } from '../src/protocol/frame';

const frame = (kind: number, fields: Partial<Frame> = {}, payload: Uint8Array = new Uint8Array(0)): Frame =>
  ({ ...header(kind as never, fields), stamps: [], payload });
const uiFrame = (f: Frame): UiToEngine => ({ type: 'frame', bytes: encode(f).buffer as ArrayBuffer });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeCoordinator implements CoordinatorCore {
  inputs: Array<[LinkId, Frame]> = [];
  ticks: number[] = [];
  outbox: Array<[LinkId, Frame]> = [];
  deadline: number | null = null;
  depth = 0; maxDepth = 0;
  /** Scripted reactions: frames to emit for an input. */
  react: (link: LinkId, frame: Frame) => Array<[LinkId, Frame]> = () => [];
  input(link: LinkId, f: Frame, _now: number) {
    this.depth++; this.maxDepth = Math.max(this.maxDepth, this.depth);
    this.inputs.push([link, f]);
    this.outbox.push(...this.react(link, f));
    this.depth--;
  }
  encoded = 0;
  inputEncoded(link: LinkId, bytes: Uint8Array, now: number) { this.encoded++; this.input(link, decode(bytes), now); }
  tick(now: number) { this.ticks.push(now); }
  drain() { const out = this.outbox; this.outbox = []; return out; }
  drainEncoded() { return this.drain().map(([link, f]) => [link, encode(f)] as [LinkId, Uint8Array]); }
  nextDeadline() { return this.deadline; }
  dispose() {}
}

class FakeRenderer implements RendererNode {
  frames: LocalFrame[] = [];
  calls: string[] = [];
  constructor(private readonly emit: Emit, readonly ui: PostToUi) {}
  attach(slot: number) { this.calls.push(`attach ${slot}`); }
  resize(slot: number) { this.calls.push(`resize ${slot}`); }
  detach(slot: number) { this.calls.push(`detach ${slot}`); }
  setView(slot: number, view: string | null) { this.calls.push(`view ${slot} ${view}`); }
  setParam(slot: number, name: string, value: number) { this.calls.push(`param ${slot} ${name}=${value}`); }
  setPresentation(slot: number) { this.calls.push(`presentation ${slot}`); }
  views() { return []; }
  export(slot: number) { this.calls.push(`export ${slot}`); }
  hitResult: Hit | null = null;
  hit(slot: number, request: number, gesture: PointerGesture) { this.calls.push(`hit ${slot} ${request} ${gesture.kind}`); return this.hitResult; }
  handle(f: LocalFrame) {
    this.frames.push(f);
    // Draw synchronously on the first batch: DRAWN is emitted from inside handle().
    if (f.kind === Kind.BATCH) this.emit(frame(Kind.DRAWN, { request: f.request }, new Uint8Array(8)));
  }
}

const CONTEXT: DatasetContext = { id: 0, name: 'vessels', dialect: 'duckdb', tables: [{ name: 'telemetry', rows: 3, columns: [{ name: 'ts', type: 'TIMESTAMP' }] }] };

class FakeDatabase implements DatabaseNode {
  frames: Frame[] = [];
  opened: Array<[string, number]> = [];
  openGate?: Promise<void>;
  constructor(readonly emit: Emit) {}
  async open(source: { name: string }, id: number) {
    this.opened.push([source.name, id]);
    await this.openGate;
    return { ...CONTEXT, id, name: source.name };
  }
  handle(f: Frame) {
    this.frames.push(f);
    if (f.kind !== Kind.EXEC) return;
    // Synchronous emission from inside handle(), like the real node for small queries.
    const ids = { request: f.request, epoch: f.epoch, context: f.context };
    this.emit({ ...frame(Kind.RESULT_SCHEMA, ids), payload: { schema: true } } as unknown as LocalFrame);
    this.emit({ ...frame(Kind.BATCH, ids), payload: { batch: 1 } } as unknown as LocalFrame);
    this.emit(frame(Kind.DONE, ids, new Uint8Array(16)));
  }
  dispose() {}
}

class FakeTimers implements Timers {
  armed = new Map<number, [() => void, number]>();
  private next = 1;
  set(callback: () => void, ms: number) { const id = this.next++; this.armed.set(id, [callback, ms]); return id; }
  clear(handle: unknown) { this.armed.delete(handle as number); }
  fire() { const all = [...this.armed.values()]; this.armed.clear(); for (const [cb] of all) cb(); }
}

function setup(options: { gated?: boolean; failRenderer?: boolean } = {}) {
  const coordinator = new FakeCoordinator();
  let renderer!: FakeRenderer, database!: FakeDatabase;
  const gates = { coordinator: deferred<void>(), renderer: deferred<void>(), database: deferred<void>() };
  if (!options.gated) { gates.coordinator.resolve(); gates.renderer.resolve(); gates.database.resolve(); }
  const posted: Array<[EngineToUi, Transferable[] | undefined]> = [];
  const inferenceEnds: Link[] = [];
  const timers = new FakeTimers();
  let clock = 1000;
  const deps: HostDeps = {
    createCoordinator: async () => { await gates.coordinator.promise; return coordinator; },
    createRenderer: async (emit, ui) => {
      await gates.renderer.promise;
      if (options.failRenderer) throw new Error('no GPU');
      return renderer = new FakeRenderer(emit, ui);
    },
    createDatabase: async emit => { await gates.database.promise; return database = new FakeDatabase(emit); },
    postToUi: ((message, transfer) => posted.push([message, transfer])) as PostToUi,
    connectInference: () => {
      const [engineEnd, nodeEnd] = createInProcessPair(['inference', 'inference' as LinkId]);
      inferenceEnds.push(nodeEnd);
      return engineEnd;
    },
    now: () => clock,
    timers,
  };
  const host = new EngineHost(deps);
  return {
    host, coordinator, gates, posted, inferenceEnds, timers,
    get renderer() { return renderer; }, get database() { return database; },
    setClock: (value: number) => { clock = value; },
    uiFrames: () => posted.filter(([m]) => m.type === 'frame').map(([m]) => decode(new Uint8Array((m as { bytes: ArrayBuffer }).bytes))),
  };
}

describe('engine host', () => {
  it('fences renderer controls and UI messages by generation and execution, and prepares gestures without querying', async () => {
    const t = setup(); await t.host.ready;
    await t.host.openDataset({ kind: 'fixture', name: 'vessels' });
    const words = (...values: number[]) => new Uint8Array(new Uint32Array(values).buffer);
    t.coordinator.react = (link, f) => link === 'ui' ? [
      ['renderer', frame(Kind.REGISTER_TARGET, {}, words(2, 4))],
      ['renderer', frame(Kind.BIND, { request: 50 }, words(2, 256, 4))],
    ] : [];
    t.host.onMessage(uiFrame(frame(Kind.CONFIG)));
    t.coordinator.react = () => [];
    t.renderer.calls.length = 0;
    t.host.onMessage({ type: 'view', slot: 2, generation: 3, request: 49, view: 'table' });
    t.host.onMessage({ type: 'param', slot: 2, generation: 4, request: 49, name: 'rotation', value: 90 });
    t.host.onMessage({ type: 'view', slot: 2, view: 'table' });
    expect(t.renderer.calls).toEqual([]);
    t.host.onMessage({ type: 'presentation', slot: 2, generation: 4, presentation: { view: null, params: {} } });
    expect(t.renderer.calls).toEqual(['presentation 2']);
    const count = t.posted.length;
    t.renderer.ui({ type: 'table', slot: 2, request: 49, columns: [], rows: [], total: 1 });
    expect(t.posted).toHaveLength(count);
    t.renderer.ui({ type: 'table', slot: 2, request: 50, columns: [], rows: [], total: 2 });
    expect(t.posted.at(-1)![0]).toMatchObject({ generation: 4, request: 50, total: 2 });
    t.coordinator.inputs.length = 0;
    t.host.onMessage({ type: 'manipulate', slot: 2, generation: 4, request: 50, revision: 2, epoch: 0, context: 1,
      sql: 'SELECT 1', gesture: { kind: 'sql', sql: 'SELECT 2' }, keyAt: 1, sentAt: 2, prepareOnly: true });
    expect(t.posted.at(-1)![0]).toMatchObject({ type: 'manipulated', sql: 'SELECT 2', request: 50, generation: 4 });
    expect(t.coordinator.inputs).toEqual([]);
  });

  it('rejects database frames after cancellation or terminal completion before they reach rendering', async () => {
    const t = setup(); await t.host.ready;
    t.coordinator.react = (link) => link === 'ui' ? [['database', frame(Kind.EXEC, { request: 5, epoch: 2, context: 1 }, text('SELECT 1'))]] : [];
    t.host.onMessage(uiFrame(frame(Kind.CONFIG)));
    const count = t.renderer.frames.length;
    t.database.emit({ ...frame(Kind.BATCH, { request: 5, epoch: 2, context: 1 }), payload: { batch: 'late' } } as unknown as LocalFrame);
    expect(t.renderer.frames).toHaveLength(count);
    t.database.handle = f => { t.database.frames.push(f); };
    t.host.onMessage(uiFrame(frame(Kind.CONFIG)));
    t.coordinator.react = () => [['database', frame(Kind.CANCEL, { request: 5 })]];
    t.host.onMessage(uiFrame(frame(Kind.CONFIG)));
    t.database.emit(frame(Kind.DONE, { request: 5, epoch: 2, context: 1 }, new Uint8Array(16)));
    expect(t.renderer.frames).toHaveLength(count);
  });

  it('suspends the prior source before opening a new one, including a failed open', async () => {
    const t = setup(); await t.host.ready;
    await t.host.openDataset({ kind: 'fixture', name: 'vessels' });
    t.database.open = async () => {
      expect(t.coordinator.inputs.at(-1)![1]).toMatchObject({ kind: Kind.CONTEXT, context: 0 });
      throw new Error('offline');
    };
    expect(await t.host.openDataset({ kind: 'fixture', name: 'weather' })).toBeUndefined();
    expect(t.coordinator.inputs.at(-1)![1]).toMatchObject({ kind: Kind.ERROR });
  });
  it('turns a chart gesture into a QUERY frame on the UI link (hit-test, wrap without a parser, stamps)', async () => {
    const t = setup();
    await t.host.ready;
    await t.host.openDataset({ kind: 'fixture', name: 'vessels' });
    t.coordinator.inputs.length = 0;
    const base = { type: 'manipulate' as const, slot: 2, request: 9, revision: 4, epoch: 3, context: 1, keyAt: 900, sentAt: 901,
      sql: "SELECT vessel, avg(speed) AS speed FROM telemetry GROUP BY 1" };
    // Nothing under the pointer: the UI hears why, the coordinator hears nothing.
    t.host.onMessage({ ...base, gesture: { kind: 'point', x: 10, y: 20 } });
    expect(t.coordinator.inputs).toHaveLength(0);
    expect(t.posted.at(-1)![0]).toMatchObject({ type: 'manipulated', slot: 2, sql: null, method: 'none' });
    t.renderer.hitResult = { request: 9, view: 'bar', x: { column: 0, name: 'vessel', type: 'text', label: "O'Neil", null: false } };
    t.host.onMessage({ ...base, gesture: { kind: 'point', x: 10, y: 20 } });
    expect(t.renderer.calls.filter(c => c.startsWith('hit'))).toEqual(['hit 2 9 point', 'hit 2 9 point']);
    const [link, q] = t.coordinator.inputs.at(-1)!;
    expect(link).toBe('ui');
    expect([q.kind, q.epoch, q.revision, q.context]).toEqual([Kind.QUERY, 3, 4, 1]);
    expect(new DataView(q.payload.buffer, q.payload.byteOffset).getUint32(0, true)).toBe(2);
    const sql = new TextDecoder().decode(q.payload.subarray(4));
    expect(sql).toBe(`SELECT * FROM (\n${base.sql}\n) AS tb_drill WHERE "vessel" = 'O''Neil'`);
    expect(q.stamps.map(s => [s.stage, s.node, s.at])).toEqual([[1, 1, 900], [2, 1, 901], [9, 2, 1000]]);
    expect(t.posted.at(-1)![0]).toMatchObject({ type: 'manipulated', slot: 2, from: base.sql, sql, method: 'wrap' });
    // Back: the SQL runs as is, no hit-test.
    t.host.onMessage({ ...base, gesture: { kind: 'sql', sql: 'SELECT 1' } });
    expect(new TextDecoder().decode(t.coordinator.inputs.at(-1)![1].payload.subarray(4))).toBe('SELECT 1');
    expect(t.renderer.calls.filter(c => c.startsWith('hit'))).toHaveLength(2);
  });

  it('queues UI frames, slot attaches and dataset opens until the nodes exist, then delivers in order', async () => {
    const t = setup({ gated: true });
    const canvas = {} as OffscreenCanvas;
    t.host.onMessage({ type: 'attach', slot: 1, canvas, size: { width: 10, height: 10, devicePixelRatio: 1 } });
    t.host.onMessage(uiFrame(frame(Kind.CONFIG, {}, json({ freeSlots: [1] }))));
    t.host.onMessage({ type: 'boot', inference: { kind: 'remote', endpoint: 'wss://x' }, dataset: { kind: 'fixture', name: 'vessels' } });
    t.host.onMessage(uiFrame(frame(Kind.DRAFT, { revision: 1 }, text('spe'))));
    t.host.onMessage({ type: 'view', slot: 1, view: 'line' });
    await flush();
    expect(t.coordinator.inputs).toHaveLength(0);

    t.gates.renderer.resolve(); await flush();
    expect(t.renderer.calls).toEqual(['attach 1', 'view 1 line']);
    t.gates.database.resolve(); await flush();
    expect(t.database.opened).toEqual([['vessels', 1]]);
    t.gates.coordinator.resolve(); await flush();
    expect(t.coordinator.inputs.map(([link, f]) => [link, f.kind])).toEqual([
      ['ui', Kind.CONFIG], ['ui', Kind.DRAFT], ['database', Kind.CONTEXT], ['database', Kind.CONTEXT],
    ]);
    const context = t.coordinator.inputs.find(([, f]) => f.kind === Kind.CONTEXT && f.context !== 0)![1];
    expect(context.context).toBe(1);
    expect(readJson<DatasetContext>(context.payload)).toMatchObject({ id: 1, name: 'vessels' });
    expect(t.posted.find(([m]) => m.type === 'context')![0]).toMatchObject({ type: 'context', context: { id: 1 } });
  });

  it('routes database output: objects to the renderer first, HEADER_ONLY copies and DONE to the coordinator, DRAWN back, without re-entering the coordinator', async () => {
    const t = setup();
    await t.host.ready;
    t.coordinator.react = (link, f) => link === 'ui' && f.kind === Kind.DRAFT
      ? [['renderer', frame(Kind.BIND, { request: 5 }, new Uint8Array(4))], ['database', frame(Kind.EXEC, { request: 5, epoch: 2, context: 1 }, text('SELECT 1'))]]
      : [];
    t.host.onMessage(uiFrame(frame(Kind.DRAFT, { revision: 1 }, text('speed'))));
    expect(t.coordinator.encoded).toBe(1); // UI frames go in encoded
    expect(t.coordinator.maxDepth).toBe(1);
    expect(t.renderer.frames.map(f => f.kind)).toEqual([Kind.BIND, Kind.RESULT_SCHEMA, Kind.BATCH, Kind.DONE]);
    expect(t.renderer.frames[2].payload).toEqual({ batch: 1 });
    const fromDb = t.coordinator.inputs.filter(([link]) => link === 'database').map(([, f]) => f);
    expect(fromDb.map(f => [f.kind, f.flags & Flag.HEADER_ONLY, f.payload.byteLength, f.request])).toEqual([
      [Kind.RESULT_SCHEMA, Flag.HEADER_ONLY, 0, 5], [Kind.BATCH, Flag.HEADER_ONLY, 0, 5], [Kind.DONE, 0, 16, 5],
    ]);
    // The renderer sees the batch before the coordinator's header-only copy, so its DRAWN
    // (emitted inside renderer.handle) is queued ahead of that copy.
    expect(t.coordinator.inputs.map(([link, f]) => `${link}:${f.kind}`)).toEqual([
      `ui:${Kind.DRAFT}`, `database:${Kind.RESULT_SCHEMA}`, `renderer:${Kind.DRAWN}`, `database:${Kind.BATCH}`, `database:${Kind.DONE}`,
    ]);
  });

  it('encodes coordinator frames for the UI and transfers their buffers', async () => {
    const t = setup();
    await t.host.ready;
    t.coordinator.react = () => [['ui', frame(Kind.RESULT, { request: 3, revision: 2 }, json({ slot: 1 }))]];
    t.host.onMessage(uiFrame(frame(Kind.COMMIT, { revision: 2 }, text('x'))));
    const [message, transfer] = t.posted.at(-1)!;
    expect(message.type).toBe('frame');
    const bytes = (message as { bytes: ArrayBuffer }).bytes;
    expect(transfer).toEqual([bytes]);
    expect(decode(new Uint8Array(bytes))).toMatchObject({ kind: Kind.RESULT, request: 3, revision: 2 });
  });

  it('opens the inference link, queues frames sent before it exists, feeds replies and reports a closed link', async () => {
    const t = setup();
    await t.host.ready;
    t.coordinator.react = (link, f) => link === 'ui' ? [['inference', frame(Kind.INFER, { request: 1 }, text('q'))]] : [];
    t.host.onMessage(uiFrame(frame(Kind.DRAFT, { revision: 1 }, text('q'))));
    const seen: Frame[] = [];
    t.host.onMessage({ type: 'inference', placement: { kind: 'remote', endpoint: 'wss://example.test' } });
    const node = t.inferenceEnds[0];
    node.listen(f => seen.push(f as Frame));
    expect(seen.map(f => f.kind)).toEqual([Kind.INFER]);
    node.send(frame(Kind.READY, {}, json({ node: 'inference', name: 'srv' })));
    expect(t.coordinator.inputs.at(-1)).toMatchObject(['inference', { kind: Kind.READY }]);
    // A closed link is not a coordinator input: the UI gets STATUS and the host reconnects;
    // the new link's READY lets the coordinator retry in-flight work.
    const inputs = t.coordinator.inputs.length;
    node.close();
    expect(t.coordinator.inputs).toHaveLength(inputs);
    expect(readJson(t.uiFrames().at(-1)!.payload)).toMatchObject({ component: 'inference', state: 'error' });
    expect([...t.timers.armed.values()].map(([, ms]) => ms)).toEqual([250]);
    t.timers.fire();
    expect(t.inferenceEnds).toHaveLength(2);
    t.inferenceEnds[1].listen(() => {});
    t.inferenceEnds[1].send(frame(Kind.READY, {}, json({ node: 'inference' })));
    expect(t.coordinator.inputs.at(-1)).toMatchObject(['inference', { kind: Kind.READY }]);
    // Switching placement replaces the link; the old one no longer feeds the coordinator.
    t.host.onMessage({ type: 'inference', placement: { kind: 'webgpu', model: 'qwen-0.5b' } });
    expect(t.inferenceEnds).toHaveLength(3);
    // The replaced link was closed by the host.
    expect(() => t.inferenceEnds[1].send(frame(Kind.SQL, { request: 9 }, text('x')))).toThrow(/closed/);
  });

  it('arms one timer for the coordinator deadline, re-arms when it moves and ticks when it fires', async () => {
    const t = setup();
    await t.host.ready;
    t.coordinator.deadline = 1050;
    t.host.onMessage(uiFrame(frame(Kind.DRAFT, {}, text('a'))));
    expect([...t.timers.armed.values()].map(([, ms]) => ms)).toEqual([50]);
    t.coordinator.deadline = 1020;
    t.host.onMessage(uiFrame(frame(Kind.DRAFT, {}, text('ab'))));
    expect([...t.timers.armed.values()].map(([, ms]) => ms)).toEqual([20]);
    t.setClock(1020);
    t.coordinator.deadline = null;
    t.coordinator.react = () => [['ui', frame(Kind.SQL, { request: 1 }, text('SELECT 1'))]];
    t.timers.fire();
    expect(t.coordinator.ticks).toEqual([1020]);
    expect(t.timers.armed.size).toBe(0);
  });

  it('ticks sub-millisecond deadlines through a MessageChannel turn, not setTimeout', async () => {
    const t = setup();
    await t.host.ready;
    t.coordinator.deadline = 1000.5;
    t.host.onMessage(uiFrame(frame(Kind.DRAFT, {}, text('a'))));
    expect(t.timers.armed.size).toBe(0);
    t.coordinator.deadline = null;
    await flush();
    expect(t.coordinator.ticks).toHaveLength(1);
  });

  it('reports a node that fails to start as a STATUS frame to the UI', async () => {
    const t = setup({ failRenderer: true });
    await expect(t.host.ready).rejects.toThrow('no GPU');
    const statuses = t.uiFrames().filter(f => f.kind === Kind.STATUS).map(f => readJson(f.payload));
    expect(statuses).toContainEqual(expect.objectContaining({ component: 'renderer', state: 'error', detail: 'no GPU' }));
    expect(statuses).toContainEqual(expect.objectContaining({ component: 'coordinator', state: 'ready' }));
  });

  it('bounds pre-ready queues by dropping the oldest frame', async () => {
    const t = setup({ gated: true });
    const host = new EngineHost({
      createCoordinator: () => new Promise(() => {}), createRenderer: () => new Promise(() => {}), createDatabase: () => new Promise(() => {}),
      postToUi: vi.fn(), connectInference: vi.fn(), maxQueued: 2,
    });
    for (let i = 0; i < 5; i++) host.onMessage(uiFrame(frame(Kind.DRAFT, { revision: i })));
    expect(host.droppedFrames()).toBe(3);
    t.host.dispose();
  });

  it('serializes dataset opens and only announces the newest context', async () => {
    const t = setup();
    await t.host.ready;
    const gate = deferred<void>();
    t.database.openGate = gate.promise;
    const first = t.host.openDataset({ kind: 'fixture', name: 'vessels' });
    const second = t.host.openDataset({ kind: 'fixture', name: 'vessels-small' });
    gate.resolve();
    expect(await first).toBeUndefined();
    expect(await second).toMatchObject({ id: 2, name: 'vessels-small' });
    expect(t.database.opened).toEqual([['vessels-small', 2]]);
    expect(t.posted.filter(([m]) => m.type === 'context')).toHaveLength(1);
  });
});

describe('engine host: persistent presentation ordering', () => {
  for (const startup of [false, true]) it(`keeps a newer picker choice over a late hint${startup ? ' during renderer startup' : ''}`, async () => {
    const t = setup({ gated: startup });
    if (startup) { t.gates.coordinator.resolve(); t.gates.database.resolve(); await flush(); }
    else await t.host.ready;
    const target = new Uint8Array(new Uint32Array([2, 4]).buffer);
    t.coordinator.react = (_link, f) => f.kind === Kind.REGISTER_TARGET ? [['renderer', f]] :
      f.kind === Kind.QUERY ? [['renderer', frame(Kind.BIND, { request: f.request, revision: f.revision }, new Uint8Array(new Uint32Array([2, 4, 4]).buffer))]] : [];
    t.host.onMessage(uiFrame(frame(Kind.REGISTER_TARGET, {}, target)));
    t.host.onMessage({ type: 'presentation', slot: 2, generation: 4, presentation: { view: 'bar', params: {} }, manualViewRevision: 7 });
    t.host.onMessage(uiFrame(frame(Kind.QUERY, { request: 80, revision: 7 })));
    if (startup) { t.gates.renderer.resolve(); await t.host.ready; }
    const binds = () => t.renderer.frames.filter(f => f.kind === Kind.BIND);
    expect(new DataView((binds()[0].payload as Uint8Array).buffer, (binds()[0].payload as Uint8Array).byteOffset).getUint32(4, true)).toBe(256);
    // A later question explicitly asks for heatmap and may change the old picker intent.
    t.host.onMessage(uiFrame(frame(Kind.QUERY, { request: 81, revision: 8 })));
    const last = binds().at(-1)!.payload as Uint8Array;
    expect(new DataView(last.buffer, last.byteOffset).getUint32(4, true)).toBe(4);
    t.host.dispose();
  });
});

describe('engine host: suggestions (PRIME, WARM EXEC)', () => {
  const WARM_ID = 0x8000_0007;
  const prime = (question: string, sql: string, context = 1) => uiFrame(frame(Kind.PRIME, { context }, json({ question, sql })));

  it('answers a primed INFER at the inference edge: SQL (CACHED) + INFER_STATS with the INFER identities, nothing sent to the node', async () => {
    const t = setup();
    await t.host.ready;
    t.host.onMessage({ type: 'inference', placement: { kind: 'remote', endpoint: 'wss://example.test' } });
    const seen: Frame[] = [];
    t.inferenceEnds[0].listen(f => seen.push(f as Frame));
    t.host.onMessage(prime('  Max Speed   per vessel ', 'SELECT vessel, max(speed) AS s FROM telemetry GROUP BY 1'));
    expect(t.coordinator.inputs).toHaveLength(0); // PRIME never reaches the coordinator
    t.coordinator.react = (link, f) => link === 'ui' ? [['inference', frame(Kind.INFER, { request: 4, epoch: 2, revision: 9, context: 1 }, text(readText(f.payload)))]] : [];
    t.host.onMessage(uiFrame(frame(Kind.COMMIT, { revision: 9, context: 1 }, text('max speed per vessel'))));
    expect(seen).toEqual([]);
    const answers = t.coordinator.inputs.filter(([link]) => link === 'inference').map(([, f]) => f);
    expect(answers.map(f => [f.kind, f.flags, f.request, f.epoch, f.revision, f.context])).toEqual([
      [Kind.SQL, Flag.CACHED, 4, 2, 9, 1], [Kind.INFER_STATS, 0, 4, 2, 9, 1],
    ]);
    expect(readText(answers[0].payload)).toBe('SELECT vessel, max(speed) AS s FROM telemetry GROUP BY 1');
    expect(answers[0].stamps.map(s => s.stage)).toEqual([5, 9]);
    expect(readJson<{ costUsd: number; model: string }>(answers[1].payload)).toMatchObject({ costUsd: 0, model: 'primed' });
    // Another context or another question goes to the inference node.
    t.host.onMessage(uiFrame(frame(Kind.COMMIT, { revision: 10, context: 1 }, text('max speed per vessel today'))));
    expect(seen.map(f => f.kind)).toEqual([Kind.INFER]);
    expect(t.host.primed.hits).toBe(1);
  });

  it('routes a WARM EXEC from the UI to the database and its answer back to the UI only; refuses other EXECs from the UI', async () => {
    const t = setup();
    await t.host.ready;
    t.host.onMessage(uiFrame(frame(Kind.EXEC, { request: 3, context: 1 }, text('SELECT 1')))); // not WARM: dropped
    t.host.onMessage(uiFrame(frame(Kind.EXEC, { request: 3, context: 1, flags: Flag.WARM }, text('SELECT 1')))); // WARM, coordinator-range id: dropped
    expect(t.database.frames).toEqual([]);
    t.host.onMessage(uiFrame(frame(Kind.EXEC, { request: WARM_ID, context: 1, flags: Flag.WARM }, text('SELECT 1'))));
    expect(t.database.frames.map(f => [f.kind, f.request])).toEqual([[Kind.EXEC, WARM_ID]]);
    // The fake database streams; the host keeps everything of a sender-id request away from renderer and coordinator.
    expect(t.renderer.frames).toEqual([]);
    expect(t.coordinator.inputs).toEqual([]);
    expect(t.uiFrames().filter(f => f.kind === Kind.DONE).map(f => f.request)).toEqual([WARM_ID]);
  });
});
