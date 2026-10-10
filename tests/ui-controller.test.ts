import { describe, expect, it } from 'vitest';
import { Flag, Kind, Node, Stage, readJson } from '../src/protocol/frame';
import { DEFAULT_COORDINATOR_CONFIG, ResizeBatcher, UiController } from '../src/ui/controller';
import { engineFrame, FakeEngine, FakeHost, FakeRail, fakeClock, jsonPayload, slotPayload } from './ui-fake-engine';

const vessels = { kind: 'fixture', name: 'vessels' } as const;
const webgpu = { kind: 'webgpu', model: 'qwen-1.5b' } as const;

function booted() {
  const engine = new FakeEngine(), host = new FakeHost(), rail = new FakeRail(), clock = fakeClock();
  const ui = new UiController(engine, host, rail, { clock });
  ui.boot(webgpu, vessels);
  return { engine, host, rail, clock, ui };
}

describe('boot', () => {
  it('boots the engine, attaches two transferred canvases and sends CONFIG with the pool', () => {
    const { engine } = booted();
    expect(engine.posted.map(p => p.message.type)).toEqual(['boot', 'attach', 'attach', 'frame']);
    expect(engine.posted[0].message).toEqual({ type: 'boot', inference: webgpu, dataset: vessels });
    for (const [i, p] of engine.posted.slice(1, 3).entries()) {
      const attach = p.message as Extract<typeof p.message, { type: 'attach' }>;
      expect(attach.slot).toBe(i + 1);
      expect(p.transfer).toEqual([attach.canvas]);
      expect(attach.size).toEqual({ width: 500, height: 300, devicePixelRatio: 2 });
    }
    const [config] = engine.frames;
    expect(config.kind).toBe(Kind.CONFIG);
    expect(readJson(config.payload)).toEqual({ ...DEFAULT_COORDINATOR_CONFIG, freeSlots: [1, 2] });
  });
});

describe('input path', () => {
  it('turns keystrokes into transferred DRAFT frames with revisions, context and stamps', () => {
    const { engine, ui, clock } = booted();
    ui.receive({ type: 'context', context: { id: 5, name: 'vessels', dialect: 'duckdb', tables: [] } });
    engine.clear();
    clock.t = 12.5; ui.input('ma', false, 12);
    clock.t = 30.5; ui.input('max', false, 30);
    ui.input('max', false, 31);
    expect(engine.posted).toHaveLength(2);
    for (const p of engine.posted) expect(p.transfer).toEqual([(p.message as { bytes: ArrayBuffer }).bytes]);
    const frames = engine.frames;
    expect(frames.map(f => [f.kind, f.revision, f.context])).toEqual([[Kind.DRAFT, 1, 5], [Kind.DRAFT, 2, 5]]);
    expect(frames[1].stamps).toEqual([{ stage: Stage.KEY_INPUT, node: Node.UI, at: 1_000_030 }, { stage: Stage.DRAFT_SENT, node: Node.UI, at: 1_000_030.5 }]);
  });

  it('Enter sends COMMIT with the full text; composition sets the COMPOSING flag', () => {
    const { engine, ui } = booted(); engine.clear();
    ui.input('wind', true, 1);
    ui.input('wind', false, 2);
    ui.commit('wind', 3);
    expect(engine.frames.map(f => [f.kind, f.revision, f.flags])).toEqual([[Kind.DRAFT, 1, Flag.COMPOSING], [Kind.DRAFT, 1, 0], [Kind.COMMIT, 1, 0]]);
  });

  it('Stop sends CANCEL with a new epoch', () => {
    const { engine, ui } = booted(); engine.clear();
    ui.cancel(); ui.cancel();
    expect(engine.frames.map(f => [f.kind, f.epoch])).toEqual([[Kind.CANCEL, 1], [Kind.CANCEL, 2]]);
  });

  it('settings travel as partial CONFIG frames and UI messages', () => {
    const { engine, ui } = booted(); engine.clear();
    ui.setConfig({ latencyDialMs: 50, inferencePolicy: 'restart', freeSlots: [99] });
    ui.setInference({ kind: 'remote', endpoint: 'wss://x.test/tb1' });
    expect(readJson(engine.frames[0].payload)).toEqual({ latencyDialMs: 50, inferencePolicy: 'restart' });
    expect(engine.messages('inference')).toEqual([{ type: 'inference', placement: { kind: 'remote', endpoint: 'wss://x.test/tb1' } }]);
    expect(ui.config.latencyDialMs).toBe(50);
  });
});

describe('slots and cards', () => {
  it('BIND shows the bound slot as the live card titled by its revision; UNBIND hides it', () => {
    const { ui, host, rail } = booted();
    ui.input('speed by hour', false, 1);
    ui.receive(engineFrame(Kind.BIND, { request: 11, revision: 1 }, slotPayload(1)));
    const card = host.cards.get(1)!;
    expect(card.visible).toBe(true);
    expect(card.titleText).toBe('speed by hour');
    expect(ui.liveSlot).toBe(1);
    expect(host.cards.get(2)!.visible).toBe(false);
    ui.receive(engineFrame(Kind.UNBIND, { request: 11 }, slotPayload(1)));
    expect(card.visible).toBe(false);
    expect(ui.liveSlot).toBeNull();
    expect(rail.lives).toEqual([[1, 1], [null, 0]]);
  });

  it('ignores an UNBIND for a request that is no longer bound', () => {
    const { ui, host } = booted();
    ui.receive(engineFrame(Kind.BIND, { request: 11, revision: 1 }, slotPayload(1)));
    ui.receive(engineFrame(Kind.BIND, { request: 12, revision: 2 }, slotPayload(1)));
    ui.receive(engineFrame(Kind.UNBIND, { request: 11 }, slotPayload(1)));
    expect(host.cards.get(1)!.visible).toBe(true);
  });

  it('a BIND to another pool slot moves the live card', () => {
    const { ui, host } = booted();
    ui.receive(engineFrame(Kind.BIND, { request: 1, revision: 1 }, slotPayload(1)));
    ui.receive(engineFrame(Kind.BIND, { request: 2, revision: 2 }, slotPayload(2)));
    expect([host.cards.get(1)!.visible, host.cards.get(2)!.visible]).toEqual([false, true]);
  });

  it('KEEP pins the card and replenishes the pool with a newly attached slot', () => {
    const { ui, host, engine, rail } = booted();
    ui.input('waves', false, 1);
    ui.receive(engineFrame(Kind.BIND, { request: 3, revision: 1 }, slotPayload(1)));
    engine.clear();
    ui.receive(engineFrame(Kind.KEEP, { request: 3, revision: 1 }, slotPayload(1)));
    expect(host.cards.get(1)!.kept).toBe(true);
    expect(rail.keptSlots).toEqual([[1, 'waves']]);
    expect(ui.keptSlots).toEqual([1]);
    expect(ui.freeSlots.sort()).toEqual([2, 3]);
    expect(ui.liveSlot).toBeNull();
    const attach = engine.messages('attach');
    expect(attach.map(a => a.slot)).toEqual([3]);
    expect(engine.posted.find(p => p.message.type === 'attach')!.transfer).toEqual([attach[0].canvas]);
    expect(readJson(engine.frames[0].payload)).toEqual({ freeSlots: [3] });
    // kept cards ignore UNBIND
    ui.receive(engineFrame(Kind.UNBIND, { request: 3 }, slotPayload(1)));
    expect(host.cards.get(1)!.visible).toBe(true);
  });

  it('closing a kept card detaches its slot; closing the live card cancels and hides', () => {
    const { ui, host, engine } = booted();
    ui.receive(engineFrame(Kind.BIND, { request: 3, revision: 0 }, slotPayload(1)));
    ui.receive(engineFrame(Kind.KEEP, { request: 3 }, slotPayload(1)));
    ui.receive(engineFrame(Kind.BIND, { request: 4 }, slotPayload(2)));
    engine.clear();
    host.cards.get(1)!.handlers.close(1);
    expect(engine.messages('detach')).toEqual([{ type: 'detach', slot: 1 }]);
    expect(host.cards.get(1)!.destroyed).toBe(true);
    host.cards.get(2)!.handlers.close(2);
    expect(engine.frames.map(f => f.kind)).toEqual([Kind.CANCEL]);
    expect(host.cards.get(2)!.visible).toBe(false);
    expect(ui.freeSlots).toContain(2);
  });

  it('routes RESULT, views, axes, table, export and view controls to the right card', () => {
    const { ui, host, engine } = booted();
    ui.receive(engineFrame(Kind.BIND, { request: 8, revision: 0 }, slotPayload(2)));
    const result = { slot: 2, sql: 'SELECT 1', columns: [{ name: 'ts', type: 'TIMESTAMP', role: 'time' }], view: 'line', cached: false };
    ui.receive(engineFrame(Kind.RESULT, { request: 8 }, jsonPayload(result)));
    ui.receive({ type: 'views', slot: 2, available: ['line', 'table', 'surface'], chosen: 'line' });
    const ticks = { x: [{ at: 10, label: 'Jan' }], y: [], plot: { left: 40, top: 8, width: 400, height: 200 } };
    ui.receive({ type: 'axes', slot: 2, ticks });
    ui.receive({ type: 'table', slot: 2, columns: ['ts'], rows: [['1']], total: 1 });
    const card = host.cards.get(2)!;
    expect(card.lastResult).toEqual({ info: result, request: 8 });
    expect(card.lastViews).toEqual({ available: ['line', 'table', 'surface'], chosen: 'line' });
    expect(card.lastAxes).toEqual(ticks);
    expect(card.lastTable?.total).toBe(1);
    engine.clear();
    card.handlers.view(2, 'surface'); card.handlers.param(2, 'rotation', 30); card.handlers.exportCsv(2);
    expect(engine.posted.map(p => p.message)).toEqual([
      { type: 'view', slot: 2, view: 'surface' }, { type: 'param', slot: 2, name: 'rotation', value: 30 }, { type: 'export', slot: 2, format: 'csv' },
    ]);
    const blob = new Blob(['a,b']);
    ui.receive({ type: 'export', slot: 2, blob, filename: 'result.csv' });
    expect(host.downloads).toEqual([{ blob, filename: 'result.csv' }]);
  });
});

describe('timing, stats, status and errors', () => {
  it('TIMING updates the bound card, the rail and the rolling history; INFER_STATS accumulates cost', () => {
    const { ui, host, rail } = booted();
    ui.receive(engineFrame(Kind.BIND, { request: 5, revision: 1 }, slotPayload(1)));
    const stats = { model: 'm', promptTokens: 10, completionTokens: 5, costUsd: 0.001, attempts: 1 };
    ui.receive(engineFrame(Kind.INFER_STATS, { request: 5 }, jsonPayload(stats)));
    ui.receive(engineFrame(Kind.INFER_STATS, { request: 6 }, jsonPayload({ ...stats, costUsd: 0.002 })));
    ui.receive(engineFrame(Kind.TIMING, { request: 5, revision: 1 }, undefined, [
      { stage: Stage.KEY_INPUT, node: Node.UI, at: 1000 }, { stage: Stage.CACHE_HIT, node: Node.COORDINATOR, at: 1001 },
      { stage: Stage.FIRST_DRAW_SUBMITTED, node: Node.RENDERER, at: 1012 },
    ]));
    const card = host.cards.get(1)!;
    expect(card.lastTiming?.headline).toBe(12);
    expect(card.lastTiming?.cacheHit).toBe(true);
    expect(card.lastStats).toEqual(stats);
    expect(rail.timings[0].summary).toMatchObject({ count: 1, median: 12 });
    expect(rail.timings[0].stats).toEqual(stats);
    expect(rail.stats.at(-1)!.total).toBeCloseTo(0.003);
  });

  it('STATUS goes to the rail; ERROR goes to the bound card and the rail', () => {
    const { ui, host, rail } = booted();
    ui.receive(engineFrame(Kind.STATUS, {}, jsonPayload({ component: 'database', state: 'ready', label: 'DuckDB ready' })));
    expect(rail.statuses).toEqual([{ component: 'database', state: 'ready', label: 'DuckDB ready' }]);
    ui.receive(engineFrame(Kind.BIND, { request: 9 }, slotPayload(1)));
    ui.receive(engineFrame(Kind.ERROR, { request: 9 }, jsonPayload({ code: 'sql', message: 'Binder Error' })));
    ui.receive(engineFrame(Kind.ERROR, {}, jsonPayload({ code: 'model', message: 'Model failed' })));
    expect(host.cards.get(1)!.errors).toEqual([{ code: 'sql', message: 'Binder Error' }]);
    expect(rail.errors.map(e => [e.e.code, e.request])).toEqual([['sql', 9], ['model', 0]]);
  });

  it('reports undecodable frames instead of throwing', () => {
    const { ui, rail } = booted();
    ui.receive({ type: 'frame', bytes: new ArrayBuffer(3) });
    expect(rail.errors[0].e.code).toBe('decode');
  });
});

describe('resize coalescing', () => {
  it('sends at most one resize per slot per animation frame, with the latest size', () => {
    const { ui, engine } = booted(); engine.clear();
    const queue: Array<() => void> = [];
    const batcher = new ResizeBatcher((slot, size) => ui.resize(slot, size), cb => queue.push(cb));
    batcher.push(1, { width: 10, height: 10, devicePixelRatio: 1 });
    batcher.push(1, { width: 20, height: 20, devicePixelRatio: 1 });
    batcher.push(2, { width: 30, height: 30, devicePixelRatio: 1 });
    batcher.push(2, { width: 0, height: 0, devicePixelRatio: 1 }); // hidden: dropped
    expect(queue).toHaveLength(1);
    queue[0]();
    expect(engine.posted.map(p => p.message)).toEqual([{ type: 'resize', slot: 1, size: { width: 20, height: 20, devicePixelRatio: 1 } }]);
  });
});
