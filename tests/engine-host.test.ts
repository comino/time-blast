import { describe, expect, it, vi } from 'vitest';
import { EngineHost, type HostDeps, type Timers } from '../src/engine/host';
import { createInProcessPair } from '../src/engine/links';
import type {
  CoordinatorCore, DatabaseNode, DatasetContext, Emit, EngineToUi, Link, LinkId, LocalFrame, PostToUi, RendererNode, UiToEngine,
} from '../src/engine/contracts';
import { decode, encode, Flag, header, json, Kind, readJson, text, type Frame } from '../src/protocol/frame';

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
  nextDeadline() { return this.deadline; }
  dispose() {}
}

class FakeRenderer implements RendererNode {
  frames: LocalFrame[] = [];
  calls: string[] = [];
  constructor(private readonly emit: Emit) {}
  attach(slot: number) { this.calls.push(`attach ${slot}`); }
  resize(slot: number) { this.calls.push(`resize ${slot}`); }
  detach(slot: number) { this.calls.push(`detach ${slot}`); }
  setView(slot: number, view: string | null) { this.calls.push(`view ${slot} ${view}`); }
  setParam(slot: number, name: string, value: number) { this.calls.push(`param ${slot} ${name}=${value}`); }
  views() { return []; }
  export(slot: number) { this.calls.push(`export ${slot}`); }
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
  constructor(private readonly emit: Emit) {}
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
    createRenderer: async (emit) => {
      await gates.renderer.promise;
      if (options.failRenderer) throw new Error('no GPU');
      return renderer = new FakeRenderer(emit);
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
      ['ui', Kind.CONFIG], ['ui', Kind.DRAFT], ['database', Kind.STATUS], ['database', Kind.CONTEXT],
    ].filter(([, kind]) => kind !== Kind.STATUS));
    const context = t.coordinator.inputs.find(([, f]) => f.kind === Kind.CONTEXT)![1];
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
    const status = t.uiFrames().find(f => f.kind === Kind.STATUS)!;
    expect(readJson(status.payload)).toMatchObject({ component: 'renderer', state: 'error', detail: 'no GPU' });
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
