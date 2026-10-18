import { describe, expect, it, vi } from 'vitest';
import { CanvasController, type CanvasHooks } from '../src/canvas/controller';
import type { CanvasPatch, CanvasSnapshot } from '../src/canvas/model';
import { CANVAS_CAPABILITY, EDIT_CAPABILITY } from '../src/canvas/protocol';
import { CanvasConflictError, type CanvasStorage, type StoreChange } from '../src/canvas/store';
import { validateCanvas, validatePatch } from '../src/canvas/validation';
import type { DatasetContext, EngineToUi } from '../src/engine/contracts';
import { encode, header, json, Kind, readJson, readText, Stage, type Frame, type Header } from '../src/protocol/frame';
import { SuggestController } from '../src/ui/suggest-controller';
import { FakeEngine, FakeHost, FakeRail } from './ui-fake-engine';
import { MemoryCaptionStore, type CaptionLinkFactory } from '../src/canvas/captions';

/** The caption link: records frames per opened link; tests play the inference node. */
class CaptionWire {
  readonly links: Array<{ endpoint: string; sent: Frame[]; onFrame: (f: Frame) => void; closed: boolean }> = [];
  readonly factory: CaptionLinkFactory = (endpoint, onFrame) => {
    const link = { endpoint, sent: [] as Frame[], onFrame, closed: false };
    this.links.push(link);
    return { send: f => { link.sent.push(f); }, close: () => { link.closed = true; } };
  };
  get link() { return this.links.at(-1)!; }
  ready(capabilities = ['edit-context-v1', 'describe-v1']) { this.link.onFrame({ ...header(Kind.READY), stamps: [], payload: json({ capabilities }) }); }
  describes(): Array<{ request: number; payload: Record<string, unknown> }> {
    return this.links.flatMap(l => l.sent).filter(f => f.kind === Kind.DESCRIBE).map(f => ({ request: f.request, payload: readJson(f.payload) }));
  }
  reply(title: string, explanation = `${title}, explained.`, request = this.describes().at(-1)!.request) {
    this.link.onFrame({ ...header(Kind.DESCRIPTION, { request }), stamps: [], payload: json({ title, explanation, model: 'fake/captioner', cached: false }) });
  }
}

class MemoryStorage implements CanvasStorage {
  readonly snapshots = new Map<string, CanvasSnapshot>();
  readonly writes: CanvasPatch[] = [];
  active: string | null = null;
  async write(patch: CanvasPatch): Promise<void> {
    validatePatch(patch);
    const old = this.snapshots.get(patch.canvasId);
    if (patch.head && patch.head.expectedVersion !== (old?.canvas.storeVersion ?? null)) throw new CanvasConflictError('head changed');
    for (const write of patch.drafts ?? []) {
      const draft = old?.drafts.find(d => d.id === write.value.id);
      if ((draft?.version ?? null) !== write.expectedVersion || draft?.state === 'closed') throw new CanvasConflictError('draft changed');
    }
    const merge = <T extends { id: string }>(before: T[], added: T[]) => [...new Map([...before, ...added].map(v => [v.id, v])).values()];
    const snapshot = validateCanvas(structuredClone({ format: 'timeblast-canvas', formatVersion: 1,
      canvas: patch.head?.value ?? old!.canvas,
      commits: merge(old?.commits ?? [], patch.commits ?? []), revisions: merge(old?.revisions ?? [], patch.revisions ?? []),
      sources: merge(old?.sources ?? [], patch.sources ?? []), drafts: merge(old?.drafts ?? [], patch.drafts?.map(d => d.value) ?? []) }));
    this.writes.push(structuredClone(patch)); this.snapshots.set(patch.canvasId, snapshot);
  }
  async load(id: string): Promise<CanvasSnapshot | null> { return structuredClone(this.snapshots.get(id) ?? null); }
  async list() { return [...this.snapshots.values()].map(s => structuredClone(s.canvas)); }
  async getActive() { return this.active; }
  async setActive(id: string) { this.active = id; }
  subscribe(_listener: (change: StoreChange) => void) { return () => {}; }
  close() {}
}

const weather = { kind: 'fixture', name: 'weather' } as const;
const inference = { kind: 'remote', endpoint: 'wss://inference.test/session' } as const;
const context = (id = 11, name = 'weather'): DatasetContext => ({ id, name, dialect: 'duckdb',
  tables: [{ name, rows: 100, columns: [{ name: 'temperature', type: 'DOUBLE' }] }] });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const frame = (kind: Header['kind'], fields: Partial<Omit<Header, 'kind'>> = {}, payload: Uint8Array = new Uint8Array(), stamps: Frame['stamps'] = []): EngineToUi => ({
  type: 'frame', bytes: encode({ ...header(kind, fields), stamps, payload }).buffer as ArrayBuffer,
});
interface Harness {
  ui: CanvasController; engine: FakeEngine; host: FakeHost; rail: FakeRail; storage: MemoryStorage;
  notices: string[]; editors: Array<Parameters<CanvasHooks['editor']>>;
}
async function boot(storage = new MemoryStorage(), wire = new CaptionWire(), captionStore = new MemoryCaptionStore()): Promise<Harness> {
  const engine = new FakeEngine(), host = new FakeHost(), rail = new FakeRail(), notices: string[] = [];
  const editors: Array<Parameters<CanvasHooks['editor']>> = [];
  const ui = new CanvasController(engine, host, rail, { changed() {}, editor: (...args) => editors.push(args),
    history() {}, reattach() {}, notice: text => notices.push(text) }, { captionStore, captionLink: wire.factory });
  const initialized = ui.initialize(inference, weather, {}, storage);
  await flush();
  expect(engine.messages('boot')).toHaveLength(1);
  ui.receive(frame(Kind.READY, {}, json({ capabilities: [CANVAS_CAPABILITY] })));
  ui.receive({ type: 'capabilities', component: 'inference', capabilities: [EDIT_CAPABILITY] });
  ui.receive({ type: 'context', context: context() });
  ui.receive({ type: 'activation', token: engine.messages('boot')[0].token!, context: context() });
  await initialized; await ui.session!.settled(); await flush();
  return { ui, engine, host, rail, storage, notices, editors };
}
function lastFrame(h: Harness, kind: Header['kind']): Frame {
  const found = h.engine.frames.filter(f => f.kind === kind).at(-1);
  expect(found, `expected frame kind ${kind}`).toBeDefined(); return found!;
}
const requestText = (f: Frame) => readText(f.payload.subarray(4));
interface Execution { slot: number; generation: number; request: number; revision: number; context: number; epoch: number; sql: string }
function execution(input: Frame, request: number, sql: string): Execution {
  const view = new DataView(input.payload.buffer, input.payload.byteOffset, input.payload.byteLength);
  return { slot: input.kind === Kind.QUERY ? view.getUint32(0, true) : input.request,
    generation: input.kind === Kind.QUERY ? input.request : view.getUint32(0, true),
    request, revision: input.revision, context: input.context, epoch: input.epoch, sql };
}
function candidate(h: Harness, e: Execution, bind = true, viewCode = 256): void {
  h.ui.receive(frame(Kind.CANDIDATE, e, json({ slot: e.slot, generation: e.generation, sql: e.sql })));
  if (!bind) return;
  const payload = new Uint8Array(12), view = new DataView(payload.buffer);
  view.setUint32(0, e.slot, true); view.setUint32(4, viewCode, true); view.setUint32(8, e.generation, true);
  h.ui.receive(frame(Kind.BIND, e, payload));
  h.ui.receive(frame(Kind.RESULT, e, json({ slot: e.slot, sql: e.sql, columns: [], view: null, cached: false })));
}
function outcome(h: Harness, e: Execution, status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded'): void {
  h.ui.receive(frame(Kind.EXECUTION, e, json({ slot: e.slot, generation: e.generation, status })));
}
async function create(h: Harness, question = 'Average temperature', sql = 'SELECT avg(temperature) FROM weather', request = 101) {
  h.ui.input(question, false, 1); await flush();
  const draft = h.ui.editing!;
  const sent = lastFrame(h, Kind.DRAFT), e = execution(sent, request, sql);
  h.ui.commit(question, 2); candidate(h, e); outcome(h, e);
  await h.ui.session!.settled(); await flush();
  expect(h.ui.model!.selected(draft.chartId)?.sql).toBe(sql);
  return { chartId: draft.chartId, draftId: draft.id, e, revision: h.ui.model!.selected(draft.chartId)! };
}
async function activate(h: Harness, id: number, name: string): Promise<void> {
  const pending = h.engine.messages('dataset').at(-1)!;
  expect(pending?.token).toBeDefined();
  h.ui.receive({ type: 'context', context: context(id, name) });
  h.ui.receive({ type: 'activation', token: pending.token!, context: context(id, name) });
  await flush();
}
function attachSuggestions(h: Harness, settleMs = 0): SuggestController {
  const suggestions = new SuggestController({ send: bytes => h.ui.sendFrame(bytes), epoch: () => h.ui.drafts.epoch,
    context: () => h.ui.context, textOf: (revision, request) => h.ui.questionFor(request ?? 0, revision),
    revision: () => h.ui.inputSequence, now: () => performance.now(),
  }, { show() {} }, { settleMs, prime: h.ui.primeSuggestions });
  h.ui.observer = f => suggestions.observe(f);
  return suggestions;
}
const draw = (h: Harness, e: Execution) => h.ui.receive(frame(Kind.TIMING, e, new Uint8Array(), [
  { stage: Stage.KEY_INPUT, node: 1, at: 1 }, { stage: Stage.FIRST_DRAW_SUBMITTED, node: 5, at: 9 },
]));

describe('persistent canvas controller protocol', () => {
  it('delivers results and checkpoints in memory while storage acknowledgement is blocked', async () => {
    const h = await boot(), write = h.storage.write.bind(h.storage);
    let release!: () => void;
    const acknowledgement = new Promise<void>(resolve => { release = resolve; });
    h.storage.write = async patch => { await acknowledgement; await write(patch); };
    let chartId = '', sql = '';
    try {
      h.ui.input('Average temperature', false, 1); await flush();
      const draft = h.ui.editing!, e = execution(lastFrame(h, Kind.DRAFT), 891, 'SELECT avg(temperature) FROM weather');
      chartId = draft.chartId; sql = e.sql;
      h.ui.commit(draft.text, 2); candidate(h, e);
      expect(h.host.cards.get(e.slot)?.lastResult).toMatchObject({ request: e.request, info: { sql } });
      expect(h.ui.session!.saveState.state).toBe('saving');
      outcome(h, e);
      expect(h.ui.model!.selected(chartId)).toMatchObject({ originalQuestion: draft.text, sql });
      expect(h.ui.session!.saveState.state).toBe('saving');
      expect(h.ui.session!.saveState.pending).toBeGreaterThan(0);
      expect(h.ui.session!.savedSnapshot()!.revisions).toHaveLength(0);
      expect((await h.storage.load(h.ui.model!.header.id))!.revisions).toHaveLength(0);
    } finally { release(); await h.ui.session!.settled(); }
    expect(h.ui.session!.saveState.state).toBe('saved');
    expect(h.ui.session!.saveState.pending).toBe(0);
    expect((await h.storage.load(h.ui.model!.header.id))!.revisions).toContainEqual(expect.objectContaining({ chartId, sql }));
  });

  it('warms without global priming and executes SQL and view picks with their exact definitions and original source', async () => {
    const h = await boot(), suggestions = attachSuggestions(h), first = await create(h);
    draw(h, first.e);
    const chip = suggestions.chips.find(c => c.suggestion.kind === 'agg')!;
    expect(chip).toBeDefined(); expect(chip.suggestion.sql).toContain('max(temperature)');
    expect(h.engine.frames.filter(f => f.kind === Kind.PRIME)).toHaveLength(0);
    expect(h.engine.frames.filter(f => f.kind === Kind.EXEC).every(f => f.context === 11)).toBe(true);
    expect(h.engine.frames.filter(f => f.kind === Kind.EXEC).length).toBeGreaterThan(0);
    expect(h.ui.sentFrames).toBe(h.engine.frames.length);
    h.ui.setDataset({ kind: 'fixture', name: 'flights' }); await flush(); await activate(h, 12, 'flights');
    h.engine.clear(); const inputSequence = h.ui.inputSequence;
    expect(h.ui.suggested(chip.suggestion.question, chip.from, 3, chip.suggestion.sql)).toBe(true); await flush();
    const draft = h.ui.editing!;
    expect(draft).toMatchObject({ sourceRefId: first.revision.sourceRefId, originalQuestion: chip.suggestion.question,
      candidate: { sql: chip.suggestion.sql, status: 'pending' }, finishSequence: 0 });
    expect(h.ui.inputSequence).toBe(inputSequence + 1);
    expect(h.engine.messages('dataset').at(-1)?.source.name).toBe('weather');
    await activate(h, 13, 'weather');
    const query = lastFrame(h, Kind.QUERY);
    expect(requestText(query)).toBe(chip.suggestion.sql); expect(query.context).toBe(13);
    expect(h.engine.frames.filter(f => f.kind === Kind.DRAFT || f.kind === Kind.COMMIT || f.kind === Kind.EDIT_CONTEXT)).toHaveLength(0);
    const picked = execution(query, 901, chip.suggestion.sql); candidate(h, picked); outcome(h, picked); await h.ui.session!.settled();
    expect(h.ui.model!.selected(draft.chartId)).toMatchObject({ sourceRefId: first.revision.sourceRefId, sql: chip.suggestion.sql });
    expect(h.ui.model!.selected(first.chartId)?.id).toBe(first.revision.id);

    const table = suggestions.chips.find(c => c.suggestion.kind === 'view')!;
    expect(table.suggestion.view).toBe('table'); h.engine.clear();
    expect(h.ui.suggested(table.suggestion.question, table.from, 4, table.suggestion.sql, table.suggestion.view)).toBe(true); await flush();
    const tableDraft = h.ui.editing!, tableQuery = lastFrame(h, Kind.QUERY);
    expect(requestText(tableQuery)).toBe(table.suggestion.sql);
    expect(h.engine.messages('presentation').at(-1)?.presentation.view).toBe('table');
    expect(h.engine.frames.filter(f => f.kind === Kind.DRAFT || f.kind === Kind.COMMIT || f.kind === Kind.EDIT_CONTEXT)).toHaveLength(0);
    const displayed = execution(tableQuery, 902, table.suggestion.sql); candidate(h, displayed); outcome(h, displayed); await h.ui.session!.settled();
    const restored = await boot(h.storage);
    expect(restored.ui.model!.selected(tableDraft.chartId)).toMatchObject({ sql: table.suggestion.sql,
      sourceRefId: first.revision.sourceRefId, presentation: { view: 'table', params: {} } });
  });

  it('does not prepare delayed suggestions while their source is being replaced or after it changes', async () => {
    const h = await boot(); attachSuggestions(h, 250);
    const first = await create(h); h.engine.clear(); vi.useFakeTimers();
    try {
      draw(h, first.e); h.ui.setDataset({ kind: 'fixture', name: 'flights' }); await flush();
      expect(h.ui.questionFor(first.e.request, first.e.revision)).toBeUndefined();
      vi.advanceTimersByTime(300);
      expect(h.engine.frames.filter(f => f.kind === Kind.PRIME || f.kind === Kind.EXEC)).toHaveLength(0);
      await activate(h, 12, 'flights'); draw(h, first.e); vi.advanceTimersByTime(300);
      expect(h.engine.frames.filter(f => f.kind === Kind.PRIME || f.kind === Kind.EXEC)).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it('does not observe a stale result or replace the active editor when its old suggestion is picked', async () => {
    const h = await boot(), suggestions = attachSuggestions(h), first = await create(h); draw(h, first.e);
    const chip = suggestions.chips[0]; expect(chip).toBeDefined();
    h.ui.editChart(first.chartId); h.ui.input('Show minimum instead', false, 3); await flush();
    const draftId = h.ui.editing!.id, drafts = h.ui.model!.drafts.size, inputSequence = h.ui.inputSequence;
    let observed = 0; h.ui.observer = f => { if (f.kind === Kind.RESULT) observed++; return suggestions.observe(f); };
    candidate(h, first.e); draw(h, first.e);
    expect(observed).toBe(0);
    h.engine.clear();
    expect(h.ui.suggested(chip.suggestion.question, chip.from, 4, chip.suggestion.sql)).toBe(false);
    expect(h.ui.editing).toMatchObject({ id: draftId, text: 'Show minimum instead' });
    expect(h.ui.model!.drafts.size).toBe(drafts); expect(h.ui.inputSequence).toBe(inputSequence);
    expect(h.engine.frames).toHaveLength(0);
  });

  it('persists a requested chart view and restores it with the saved SQL', async () => {
    const h = await boot(); h.ui.input('Average temperature as a bar chart', false, 1); await flush();
    const draft = h.ui.editing!, e = execution(lastFrame(h, Kind.DRAFT), 91, 'SELECT avg(temperature) FROM weather');
    h.ui.commit(draft.text, 2); candidate(h, e, true, 1); outcome(h, e);
    await h.ui.session!.settled(); await flush();
    expect(h.ui.model!.selected(draft.chartId)?.presentation).toEqual({ view: 'bar', params: {} });

    const restored = await boot(h.storage);
    expect(restored.ui.model!.selected(draft.chartId)?.presentation).toEqual({ view: 'bar', params: {} });
    expect(restored.engine.messages('presentation').at(-1)?.presentation).toEqual({ view: 'bar', params: {} });
    expect(requestText(lastFrame(restored, Kind.QUERY))).toBe(e.sql);
    expect(restored.engine.frames.filter(f => f.kind === Kind.DRAFT || f.kind === Kind.COMMIT)).toHaveLength(0);
  });

  it('keeps a newer manual view when the pending translation returns its automatic hint', async () => {
    const h = await boot(); h.ui.input('Average temperature', false, 1); await flush();
    const draft = h.ui.editing!, e = execution(lastFrame(h, Kind.DRAFT), 92, 'SELECT avg(temperature) FROM weather');
    h.host.cards.get(e.slot)!.handlers.view(e.slot, 'bar'); h.ui.commit(draft.text, 2);
    candidate(h, e, true, 255); outcome(h, e); await h.ui.session!.settled();
    expect(h.ui.model!.selected(draft.chartId)?.presentation).toEqual({ view: 'bar', params: {} });
    expect(h.engine.messages('presentation').at(-1)).toMatchObject({ manualViewRevision: e.revision,
      presentation: { view: 'bar', params: {} } });
  });

  it('creates sequence zero, reloads without inference, refines with saved context, and undoes', async () => {
    const h = await boot(); h.engine.clear();
    const first = await create(h);
    const firstDraft = h.engine.frames.find(f => f.kind === Kind.DRAFT)!;
    const firstCommit = h.engine.frames.find(f => f.kind === Kind.COMMIT)!;
    expect(firstDraft.revision).toBe(1); expect(firstCommit.revision).toBe(1);
    expect(requestText(firstCommit)).toBe('Average temperature');
    expect(h.ui.model!.drafts.get(first.draftId)?.sequence).toBe(0);

    const restored = await boot(h.storage);
    expect(restored.engine.frames.some(f => new Set<number>([Kind.DRAFT, Kind.COMMIT, Kind.EDIT_CONTEXT]).has(f.kind))).toBe(false);
    const query = lastFrame(restored, Kind.QUERY);
    expect(requestText(query)).toBe(first.revision.sql);
    const hydrated = execution(query, 201, first.revision.sql); candidate(restored, hydrated); outcome(restored, hydrated);
    await flush(); restored.engine.clear();

    restored.ui.editChart(first.chartId); restored.ui.input('Use maximum instead', false, 3); await flush();
    expect(readJson(lastFrame(restored, Kind.EDIT_CONTEXT).payload)).toMatchObject({ mode: 'refine',
      originalQuestion: 'Average temperature', sql: first.revision.sql, history: [{ kind: 'create', text: 'Average temperature' }] });
    const edit = lastFrame(restored, Kind.DRAFT);
    expect(requestText(edit)).toBe('Use maximum instead');
    const refined = execution(edit, 202, 'SELECT max(temperature) FROM weather');
    restored.ui.commit('Use maximum instead', 4); candidate(restored, refined); outcome(restored, refined);
    await restored.ui.session!.settled(); await flush();
    expect(restored.ui.model!.selected(first.chartId)).toMatchObject({ parentId: first.revision.id,
      originalQuestion: first.revision.originalQuestion, sql: refined.sql });

    restored.engine.clear(); restored.ui.undo(); await flush();
    expect(restored.ui.model!.selected(first.chartId)?.id).toBe(first.revision.id);
    expect(requestText(lastFrame(restored, Kind.QUERY))).toBe(first.revision.sql);
    expect(restored.ui.model!.revisions.size).toBe(2);
    expect(restored.notices).toEqual([]);
  });

  it('aligns the first typed refinement after its empty editor has already activated', async () => {
    const h = await boot(), first = await create(h);
    h.engine.clear(); h.ui.editChart(first.chartId); await flush();
    expect(h.engine.frames.filter(f => f.kind === Kind.DRAFT)).toHaveLength(0);
    h.ui.input('Use maximum instead', false, 3); await flush();
    const draft = h.ui.editing!, sent = lastFrame(h, Kind.DRAFT);
    expect(draft.sequence).toBe(1); expect(sent.revision).toBe(draft.sequence + 1);
    h.ui.commit(draft.text, 4);
    expect(lastFrame(h, Kind.COMMIT).revision).toBe(sent.revision);
    const e = execution(sent, 251, 'SELECT max(temperature) FROM weather'); candidate(h, e); outcome(h, e);
    await h.ui.session!.settled();
    expect(h.ui.model!.selected(first.chartId)).toMatchObject({ parentId: first.revision.id,
      sql: e.sql, change: { text: 'Use maximum instead' } });
  });

  it('sends only the latest text and matching checkpoint when typing precedes source activation', async () => {
    const h = await boot(), first = await create(h);
    h.ui.setDataset({ kind: 'fixture', name: 'flights' }); await flush(); await activate(h, 12, 'flights');
    h.engine.clear(); h.ui.editChart(first.chartId);
    h.ui.input('Maximum', false, 3); h.ui.input('Maximum by station', false, 4);
    h.ui.commit('Maximum by station', 5); await flush();
    expect(h.engine.frames.filter(f => f.kind === Kind.DRAFT)).toHaveLength(0);
    expect(h.engine.messages('dataset').at(-1)?.source.name).toBe('weather');
    const sequence = h.ui.editing!.sequence;
    await activate(h, 13, 'weather');
    const sent = h.engine.frames.filter(f => f.kind === Kind.DRAFT);
    expect(sent).toHaveLength(1); expect(requestText(sent[0])).toBe('Maximum by station');
    expect(sent[0]).toMatchObject({ revision: sequence + 1, context: 13 });
    expect(lastFrame(h, Kind.COMMIT).revision).toBe(sequence + 1);
    const e = execution(sent[0], 301, 'SELECT max(temperature) FROM weather'); candidate(h, e); outcome(h, e);
    expect(h.ui.model!.selected(first.chartId)?.change.text).toBe('Maximum by station');
  });

  it('does not let a cancelled source job execute old text or block a newer source request', async () => {
    const h = await boot(), first = await create(h);
    h.ui.setDataset({ kind: 'fixture', name: 'flights' }); await flush(); await activate(h, 12, 'flights');
    h.engine.clear(); h.ui.editChart(first.chartId); h.ui.input('Pending maximum', false, 3); await flush();
    const abandoned = h.engine.messages('dataset').at(-1)!;
    h.ui.cancel(); h.ui.setDataset({ kind: 'fixture', name: 'cities' }); await flush();
    expect(h.engine.messages('dataset').at(-1)?.source.name).toBe('cities');
    expect(h.engine.messages('dataset').at(-1)?.token).not.toBe(abandoned.token);
    h.ui.receive({ type: 'activation', token: abandoned.token!, context: context(13, 'weather') });
    await flush();
    expect(h.engine.frames.filter(f => f.kind === Kind.DRAFT || f.kind === Kind.QUERY)).toHaveLength(0);
    await activate(h, 14, 'cities');
    // Escape keeps the refinement in the editor; a new chart is an explicit choice.
    h.ui.newQuestion(); h.ui.input('City temperature', false, 4); await flush();
    expect(lastFrame(h, Kind.DRAFT).context).toBe(14);
    expect(requestText(lastFrame(h, Kind.DRAFT))).toBe('City temperature');
  });

  it('uses the newest draft after waiting for inference edit capabilities', async () => {
    const h = await boot(), first = await create(h);
    h.ui.setInference({ kind: 'remote', endpoint: 'wss://another.test/session' });
    h.engine.clear(); h.ui.editChart(first.chartId); h.ui.input('Maximum temperature', false, 3); await flush();
    expect(h.engine.frames.filter(f => f.kind === Kind.DRAFT)).toHaveLength(0);
    h.ui.input('Minimum temperature by station', false, 4); h.ui.commit('Minimum temperature by station', 5);
    const sequence = h.ui.editing!.sequence;
    h.ui.receive({ type: 'capabilities', component: 'inference', capabilities: [EDIT_CAPABILITY] }); await flush();
    expect(requestText(lastFrame(h, Kind.DRAFT))).toBe('Minimum temperature by station');
    expect(lastFrame(h, Kind.DRAFT).revision).toBe(sequence + 1);
    expect(lastFrame(h, Kind.COMMIT).revision).toBe(sequence + 1);
    const e = execution(lastFrame(h, Kind.DRAFT), 351, 'SELECT min(temperature) FROM weather'); candidate(h, e); outcome(h, e);
    expect(h.ui.model!.selected(first.chartId)?.change.text).toBe('Minimum temperature by station');
  });

  it('cancels a deferred capability wait before activating a different source', async () => {
    const h = await boot(), first = await create(h);
    h.ui.setInference({ kind: 'remote', endpoint: 'wss://another.test/session' });
    h.engine.clear(); h.ui.editChart(first.chartId); h.ui.input('Pending maximum', false, 3); await flush();
    expect(h.engine.frames.filter(f => f.kind === Kind.DRAFT)).toHaveLength(0);
    const abandonedId = h.ui.editing!.id;
    h.ui.cancel(); h.ui.setDataset({ kind: 'fixture', name: 'flights' }); await flush();
    expect(h.engine.messages('dataset').at(-1)?.source.name).toBe('flights');
    h.ui.receive({ type: 'capabilities', component: 'inference', capabilities: [EDIT_CAPABILITY] }); await flush();
    expect(h.engine.frames.filter(f => f.kind === Kind.DRAFT)).toHaveLength(0);
    expect(h.ui.model!.drafts.get(abandonedId)?.text).toBe('Pending maximum');
    await activate(h, 12, 'flights');
    h.ui.newQuestion(); h.ui.input('Flight temperature', false, 4); await flush();
    expect(lastFrame(h, Kind.DRAFT).context).toBe(12);
  });

  it('retries an unsupported refinement after selecting a capable inference endpoint', async () => {
    const h = await boot(), first = await create(h);
    h.ui.receive({ type: 'capabilities', component: 'inference', capabilities: [] });
    h.ui.editChart(first.chartId); h.ui.input('Use maximum instead', false, 3); await flush();
    const draftId = h.ui.editing!.id;
    expect(h.notices.at(-1)).toContain('cannot refine saved charts');
    h.engine.clear(); h.ui.setInference({ kind: 'remote', endpoint: 'wss://capable.test/session' });
    h.ui.receive({ type: 'capabilities', component: 'inference', capabilities: [EDIT_CAPABILITY] }); await flush();
    expect(requestText(lastFrame(h, Kind.DRAFT))).toBe('Use maximum instead');
    expect(h.ui.editing!.id).toBe(draftId);
    expect(readJson(lastFrame(h, Kind.EDIT_CONTEXT).payload)).toMatchObject({ sql: first.revision.sql,
      originalQuestion: first.revision.originalQuestion });
  });

  it('keeps the editor usable after refreshing during a pending refinement', async () => {
    const h = await boot(), first = await create(h);
    h.ui.editChart(first.chartId); h.ui.input('Pending maximum', false, 3); await flush();
    const abandonedId = h.ui.editing!.id;
    h.engine.clear(); h.host.cards.get(first.e.slot)!.handlers.refresh!(first.e.slot); await flush();
    await activate(h, 12, 'weather');
    const hydration = execution(lastFrame(h, Kind.QUERY), 355, first.revision.sql);
    candidate(h, hydration); outcome(h, hydration); await flush();
    h.engine.clear(); h.ui.input('Minimum temperature', false, 4); await flush();
    expect(requestText(lastFrame(h, Kind.DRAFT))).toBe('Minimum temperature');
    expect(h.ui.model!.drafts.get(abandonedId)?.text).toBe('Pending maximum');
  });

  it('loads the saved SQL when presentation changes while its source is opening', async () => {
    const h = await boot(), first = await create(h);
    h.ui.setDataset({ kind: 'fixture', name: 'flights' }); await flush(); await activate(h, 12, 'flights');
    h.engine.clear(); const card = h.host.cards.get(first.e.slot)!;
    card.handlers.refresh!(first.e.slot); await flush();
    expect(h.engine.messages('dataset').at(-1)?.source.name).toBe('weather');
    card.handlers.view(first.e.slot, 'bar'); await activate(h, 13, 'weather');
    expect(requestText(lastFrame(h, Kind.QUERY))).toBe(first.revision.sql);
    expect(h.engine.messages('presentation').at(-1)?.presentation.view).toBe('bar');
    expect(h.ui.model!.selected(first.chartId)?.presentation.view).toBe('bar');
  });

  it('restores an interrupted draft without automatic work and resumes its SQL with aligned text sequences', async () => {
    const h = await boot(); h.ui.input('Temperature', false, 1); await flush();
    h.ui.input('Average temperature', false, 2);
    const pending = execution(lastFrame(h, Kind.DRAFT), 361, 'SELECT avg(temperature) FROM weather');
    const draft = h.ui.editing!; candidate(h, pending); h.ui.commit('Average temperature', 3);
    await h.ui.session!.settled();
    const restored = await boot(h.storage);
    expect(restored.ui.model!.state.charts).toHaveLength(0);
    expect(restored.ui.model!.drafts.get(draft.id)?.candidate?.sql).toBe(pending.sql);
    expect(restored.engine.frames.filter(f => f.kind === Kind.DRAFT || f.kind === Kind.QUERY)).toHaveLength(0);
    restored.engine.clear(); restored.ui.resumeDraft(draft.id); await flush();
    const resumed = restored.ui.editing!, query = lastFrame(restored, Kind.QUERY);
    expect(resumed.id).not.toBe(draft.id);
    expect(requestText(query)).toBe(pending.sql); expect(query.revision).toBe(resumed.sequence + 1);
    expect(restored.engine.frames.filter(f => f.kind === Kind.DRAFT)).toHaveLength(0);
    restored.ui.input('Maximum temperature', false, 4); await flush();
    const text = lastFrame(restored, Kind.DRAFT);
    expect(text.revision).toBe(restored.ui.editing!.sequence + 1);
    expect(text.revision).toBe(query.revision + 1);
    const oldSql = execution(query, 362, pending.sql); candidate(restored, oldSql); outcome(restored, oldSql);
    expect(restored.ui.model!.state.charts).toHaveLength(0);
    const latest = execution(text, 363, 'SELECT max(temperature) FROM weather');
    restored.ui.commit('Maximum temperature', 5); candidate(restored, latest); outcome(restored, latest);
    expect(restored.ui.model!.selected(draft.chartId)).toMatchObject({ originalQuestion: 'Maximum temperature', sql: latest.sql });
  });

  it('can resume and checkpoint saved refinement SQL without inference edit capability', async () => {
    const h = await boot(), first = await create(h);
    h.ui.editChart(first.chartId); h.ui.input('Use maximum instead', false, 3); await flush();
    const draft = h.ui.editing!, pending = execution(lastFrame(h, Kind.DRAFT), 371, 'SELECT max(temperature) FROM weather');
    candidate(h, pending); h.ui.commit(draft.text, 4); await h.ui.session!.settled();
    const restored = await boot(h.storage);
    const hydration = execution(lastFrame(restored, Kind.QUERY), 372, first.revision.sql);
    candidate(restored, hydration); outcome(restored, hydration); await flush();
    restored.ui.receive({ type: 'capabilities', component: 'inference', capabilities: [] });
    restored.engine.clear(); restored.ui.resumeDraft(draft.id); await flush();
    const query = lastFrame(restored, Kind.QUERY);
    expect(requestText(query)).toBe(pending.sql);
    expect(restored.engine.frames.filter(f => f.kind === Kind.DRAFT || f.kind === Kind.COMMIT || f.kind === Kind.EDIT_CONTEXT)).toHaveLength(0);
    const replayed = execution(query, 373, pending.sql); candidate(restored, replayed); outcome(restored, replayed);
    restored.ui.commit(draft.text, 5); await restored.ui.session!.settled();
    expect(restored.ui.model!.selected(first.chartId)).toMatchObject({ parentId: first.revision.id, sql: pending.sql,
      change: { text: 'Use maximum instead' } });
  });

  it('reexecutes the exact displayed SQL before a gesture and retains newer abandoned text', async () => {
    const h = await boot(); h.ui.input('Average temperature', false, 1); await flush();
    const origin = h.ui.editing!, shown = execution(lastFrame(h, Kind.DRAFT), 401, 'SELECT avg(temperature) FROM weather');
    candidate(h, shown); h.ui.input('Maximum temperature instead', false, 2);
    expect(h.ui.gesture(shown.slot, { kind: 'point', x: 20, y: 30 }, 3)).toBe(true);
    const manipulate = h.engine.messages('manipulate').at(-1)!;
    expect(manipulate).toMatchObject({ request: shown.request, generation: shown.generation, sql: shown.sql, prepareOnly: true });
    const changedSql = 'SELECT avg(temperature) FROM weather WHERE temperature > 20';
    h.engine.clear();
    h.ui.receive({ type: 'manipulated', slot: shown.slot, request: shown.request, generation: shown.generation,
      from: shown.sql, sql: changedSql, method: 'rewrite', reason: '', ms: 1 });
    await flush();
    expect(h.engine.frames.filter(f => f.kind === Kind.DRAFT || f.kind === Kind.COMMIT)).toHaveLength(0);
    const baseQuery = lastFrame(h, Kind.QUERY);
    expect(requestText(baseQuery)).toBe(shown.sql);
    expect(h.ui.model!.drafts.get(origin.id)).toMatchObject({ state: 'closed', closedAs: 'superseded', text: 'Maximum temperature instead' });
    outcome(h, shown);
    expect(h.ui.model!.state.charts).toHaveLength(0);
    const captured = execution(baseQuery, 402, shown.sql); candidate(h, captured); outcome(h, captured); await flush();
    expect(h.ui.model!.selected(origin.chartId)?.originalQuestion).toBe('Average temperature');
    const gestureQuery = lastFrame(h, Kind.QUERY);
    expect(requestText(gestureQuery)).toBe(changedSql);
    const gesture = execution(gestureQuery, 403, changedSql); candidate(h, gesture); outcome(h, gesture); await flush();
    const current = h.ui.model!.selected(origin.chartId)!;
    expect(h.ui.model!.lineage(current.id).map(r => r.sql)).toEqual([shown.sql, changedSql]);
    expect(current.change.kind).toBe('gesture');
    expect(h.notices).toEqual([]);
  });

  it('uses the committed preview as gesture parent if execution finishes while the hit is resolving', async () => {
    const h = await boot(); h.ui.input('Average temperature', false, 1); await flush();
    const draft = h.ui.editing!, shown = execution(lastFrame(h, Kind.DRAFT), 451, 'SELECT avg(temperature) FROM weather');
    candidate(h, shown); h.ui.commit('Average temperature', 2);
    expect(h.ui.gesture(shown.slot, { kind: 'point', x: 20, y: 30 }, 3)).toBe(true);
    outcome(h, shown); await flush();
    const parent = h.ui.model!.selected(draft.chartId)!;
    h.engine.clear();
    const sql = 'SELECT avg(temperature) FROM weather WHERE temperature > 20';
    h.ui.receive({ type: 'manipulated', slot: shown.slot, request: shown.request, generation: shown.generation,
      from: shown.sql, sql, method: 'rewrite', reason: '', ms: 1 }); await flush();
    expect(h.engine.frames.filter(f => f.kind === Kind.QUERY).map(requestText)).toEqual([sql]);
    const child = execution(lastFrame(h, Kind.QUERY), 452, sql); candidate(h, child); outcome(h, child);
    expect(h.ui.model!.selected(draft.chartId)?.parentId).toBe(parent.id);
    expect(h.ui.model!.revisions.size).toBe(2);
    expect(h.notices).toEqual([]);
  });

  it('hydrates each saved chart from its own source after the default dataset changes', async () => {
    const h = await boot(), first = await create(h);
    h.ui.setDataset({ kind: 'fixture', name: 'flights' }); await flush(); await activate(h, 12, 'flights');
    const second = await create(h, 'Average flight temperature', 'SELECT avg(temperature) FROM flights', 471);
    expect(second.revision.sourceRefId).not.toBe(first.revision.sourceRefId);
    const restored = await boot(h.storage);
    const initial = lastFrame(restored, Kind.QUERY);
    expect(requestText(initial)).toBe(first.revision.sql); expect(initial.context).toBe(11);
    const weatherQuery = execution(initial, 472, first.revision.sql); candidate(restored, weatherQuery); outcome(restored, weatherQuery);
    await flush();
    expect(restored.engine.messages('dataset').at(-1)?.source.name).toBe('flights');
    await activate(restored, 22, 'flights');
    const later = lastFrame(restored, Kind.QUERY);
    expect(requestText(later)).toBe(second.revision.sql); expect(later.context).toBe(22);
    expect(restored.engine.frames.filter(f => f.kind === Kind.DRAFT || f.kind === Kind.EDIT_CONTEXT)).toHaveLength(0);
  });

  it('fences late execution and controls after restoring an editing chart', async () => {
    const h = await boot(), first = await create(h);
    h.ui.editChart(first.chartId); h.ui.input('Use maximum instead', false, 3); await flush();
    const abandoned = execution(lastFrame(h, Kind.DRAFT), 501, 'SELECT max(temperature) FROM weather');
    candidate(h, abandoned); h.ui.commit('Use maximum instead', 4);
    h.engine.clear(); h.ui.restoreChart(first.chartId, first.revision.id); await flush();
    const head = h.ui.model!.head.id, card = h.host.cards.get(abandoned.slot)!;
    const priorResult = card.lastResult;
    candidate(h, abandoned); outcome(h, abandoned);
    h.ui.receive({ type: 'views', slot: abandoned.slot, request: abandoned.request, generation: abandoned.generation,
      available: ['bar'], chosen: 'bar' });
    h.ui.receive({ type: 'axes', slot: abandoned.slot, request: abandoned.request, generation: abandoned.generation,
      ticks: { x: [{ at: 1, label: 'STALE' }], y: [], plot: { left: 0, top: 0, width: 10, height: 10 } } });
    h.ui.receive({ type: 'table', slot: abandoned.slot, request: abandoned.request, generation: abandoned.generation,
      columns: ['stale'], rows: [['stale']], total: 1 });
    h.ui.receive({ type: 'export', slot: abandoned.slot, request: abandoned.request, generation: abandoned.generation,
      blob: new Blob(['stale']), filename: 'stale.csv' });
    h.ui.receive({ type: 'manipulated', slot: abandoned.slot, request: abandoned.request, generation: abandoned.generation,
      from: abandoned.sql, sql: 'SELECT 999', method: 'rewrite', reason: '', ms: 1 });
    expect(h.ui.model!.head.id).toBe(head);
    expect(h.ui.model!.selected(first.chartId)?.id).toBe(first.revision.id);
    expect(h.ui.model!.revisions.size).toBe(1);
    expect(card.lastResult).toEqual(priorResult);
    expect(card.lastViews).toBeUndefined(); expect(card.lastAxes).toBeUndefined(); expect(card.lastTable).toBeUndefined();
    expect(h.host.downloads).toHaveLength(0);
    expect(requestText(lastFrame(h, Kind.QUERY))).toBe(first.revision.sql);
  });

  it('leaving an empty refinement does not reserve the source queue', async () => {
    const h = await boot(), first = await create(h);
    h.ui.editChart(first.chartId); await flush(); h.ui.newQuestion();
    h.ui.setDataset({ kind: 'fixture', name: 'flights' }); await flush();
    expect(h.engine.messages('dataset').at(-1)?.source.name).toBe('flights');
    await activate(h, 12, 'flights');
    h.ui.input('New flights question', false, 1); await flush();
    expect(lastFrame(h, Kind.DRAFT).context).toBe(12);
  });

  it('keeps a failed edit recoverable when starting another edit on its chart', async () => {
    const h = await boot(), first = await create(h);
    h.ui.editChart(first.chartId); h.ui.input('Show unavailable field', false, 3); await flush();
    const abandonedId = h.ui.editing!.id;
    const failed = execution(lastFrame(h, Kind.DRAFT), 601, 'SELECT unavailable FROM weather');
    h.ui.commit('Show unavailable field', 4); candidate(h, failed); outcome(h, failed, 'failed'); await flush();
    h.ui.editChart(first.chartId, 'sql'); await flush();
    expect(h.ui.model!.drafts.get(abandonedId)).toMatchObject({ state: 'closed', closedAs: 'superseded',
      text: 'Show unavailable field', candidate: { sql: failed.sql, status: 'failed' } });
    expect(h.ui.editing!.id).not.toBe(abandonedId);
    expect(h.ui.model!.selected(first.chartId)?.id).toBe(first.revision.id);
    await h.ui.session!.settled();
    const saved = await h.storage.load(h.ui.model!.header.id);
    expect(saved!.drafts.find(d => d.id === abandonedId)?.closedAs).toBe('superseded');
  });
});

describe('canvas editing semantics (review 2026-10-17)', () => {
  const charts = (h: Harness) => h.ui.model!.state.charts;
  const openDrafts = (h: Harness) => [...h.ui.model!.drafts.values()].filter(d => d.state === 'open');

  it('starts a new chart when typing after Enter while the committed one is still running', async () => {
    const h = await boot();
    h.ui.input('Average temperature', false, 1); await flush();
    const first = h.ui.editing!, sent = lastFrame(h, Kind.DRAFT);
    h.ui.commit('Average temperature', 2);
    h.ui.input('M', false, 3); h.ui.input('Max wind', false, 4); await flush();
    expect(h.ui.editing!.chartId).not.toBe(first.chartId);
    expect(h.ui.model!.drafts.get(first.id)).toMatchObject({ originalQuestion: 'Average temperature', finishSequence: 0, state: 'open' });
    const e = execution(sent, 501, 'SELECT avg(temperature) FROM weather'); candidate(h, e); outcome(h, e);
    expect(h.ui.model!.selected(first.chartId)).toMatchObject({ originalQuestion: 'Average temperature', sql: e.sql });
    expect(requestText(lastFrame(h, Kind.DRAFT))).toBe('Max wind');
  });

  it('applies a change typed after Enter on a refinement to that refinement’s result', async () => {
    const h = await boot(), first = await create(h);
    h.engine.clear(); h.ui.editChart(first.chartId); h.ui.input('Use maximum', false, 3); await flush();
    const sent = lastFrame(h, Kind.DRAFT);
    h.ui.commit('Use maximum', 4);
    h.ui.input('Only station 7', false, 5); await flush();
    // Nothing previews against the stale base while the first change is pending.
    expect(h.engine.frames.filter(f => f.kind === Kind.DRAFT).map(requestText)).toEqual(['Use maximum']);
    const e = execution(sent, 511, 'SELECT max(temperature) FROM weather'); candidate(h, e); outcome(h, e); await flush();
    const refined = h.ui.model!.selected(first.chartId)!;
    expect(refined).toMatchObject({ sql: e.sql, change: { text: 'Use maximum' } });
    expect(h.ui.editing).toMatchObject({ chartId: first.chartId, baseRevisionId: refined.id, text: 'Only station 7', state: 'open' });
    expect(readJson(lastFrame(h, Kind.EDIT_CONTEXT).payload)).toMatchObject({ sql: e.sql });
    expect(requestText(lastFrame(h, Kind.DRAFT))).toBe('Only station 7');
  });

  it('ignores a second Enter on an already checkpointed question', async () => {
    const h = await boot();
    await create(h);
    const before = h.ui.model!.state.charts.length;
    h.engine.clear(); h.ui.commit('Average temperature', 9); await flush();
    expect(charts(h)).toHaveLength(before); expect(openDrafts(h)).toHaveLength(0);
    expect(h.engine.frames.filter(f => f.kind === Kind.DRAFT || f.kind === Kind.COMMIT)).toHaveLength(0);
  });

  it('replays text typed before the engine and the first source are ready', async () => {
    const engine = new FakeEngine(), host = new FakeHost(), rail = new FakeRail();
    const ui = new CanvasController(engine, host, rail, { changed() {}, editor() {}, history() {}, reattach() {}, notice() {} });
    const initialized = ui.initialize(inference, weather, {}, new MemoryStorage()); await flush();
    expect(ui.input('Avg', false, 1)).toBe(false); ui.input('Average temperature', false, 2); ui.commit('Average temperature', 3);
    ui.receive(frame(Kind.READY, {}, json({ capabilities: [CANVAS_CAPABILITY] })));
    ui.receive({ type: 'context', context: context() });
    ui.receive({ type: 'activation', token: engine.messages('boot')[0].token!, context: context() });
    await initialized; await flush();
    const drafts = engine.frames.filter(f => f.kind === Kind.DRAFT);
    expect(drafts.map(requestText)).toEqual(['Average temperature']);
    expect(engine.frames.filter(f => f.kind === Kind.COMMIT).map(requestText)).toEqual(['Average temperature']);
  });

  it('reports whether a chosen dataset became the new-chart source', async () => {
    const h = await boot();
    const loaded = h.ui.setDataset({ kind: 'fixture', name: 'flights' }); await flush(); await activate(h, 12, 'flights');
    await expect(loaded).resolves.toBe(true);
    expect(h.ui.model!.sources.get(h.ui.defaultSourceId!)?.name).toBe('flights');
    // A queued choice that never runs (dropped behind a busy queue by Escape) settles as false.
    await create(h);
    const first = h.ui.setDataset({ kind: 'fixture', name: 'cities' }), dropped = h.ui.setDataset({ kind: 'fixture', name: 'weather' });
    h.ui.cancel(); await flush();
    await expect(dropped).resolves.toBe(false);
    void first;
  });

  it('keeps a refinement started while a reloaded canvas is still booting', async () => {
    const h = await boot(), first = await create(h);
    const engine = new FakeEngine(), host = new FakeHost(), rail = new FakeRail();
    const ui = new CanvasController(engine, host, rail, { changed() {}, editor() {}, history() {}, reattach() {}, notice() {} });
    const initialized = ui.initialize(inference, weather, {}, h.storage); await flush();
    ui.editChart(first.chartId); ui.input('Use maximum', false, 3); ui.commit('Use maximum', 4);
    ui.receive(frame(Kind.READY, {}, json({ capabilities: [CANVAS_CAPABILITY] })));
    ui.receive({ type: 'capabilities', component: 'inference', capabilities: [EDIT_CAPABILITY] });
    ui.receive({ type: 'context', context: context() });
    ui.receive({ type: 'activation', token: engine.messages('boot')[0].token!, context: context() });
    await initialized; await flush();
    expect(ui.model!.state.charts).toHaveLength(1);
    expect(ui.editing).toMatchObject({ chartId: first.chartId, text: 'Use maximum' });
    expect(engine.frames.filter(f => f.kind === Kind.DRAFT).map(requestText)).toEqual(['Use maximum']);
    expect(engine.frames.some(f => f.kind === Kind.EDIT_CONTEXT)).toBe(true);
  });

  it('resumes the same refinement when typing continues after Escape', async () => {
    const h = await boot(), first = await create(h);
    h.ui.editChart(first.chartId); h.ui.input('Use max', false, 3); await flush();
    const draftId = h.ui.editing!.id;
    h.ui.cancel(); h.engine.clear();
    h.ui.input('Use maximum', false, 4); await flush();
    expect(charts(h)).toHaveLength(1);
    expect(h.ui.editing).toMatchObject({ id: draftId, chartId: first.chartId, text: 'Use maximum' });
    expect(requestText(lastFrame(h, Kind.DRAFT))).toBe('Use maximum');
    expect(lastFrame(h, Kind.EDIT_CONTEXT)).toBeDefined();
  });

  it('previews a new question while a saved chart is still loading on the same source', async () => {
    const h = await boot(); await create(h);
    const restored = await boot(h.storage);
    expect(lastFrame(restored, Kind.QUERY)).toBeDefined(); // hydration is running, no outcome yet
    restored.ui.input('Max wind', false, 5); await flush();
    expect(requestText(lastFrame(restored, Kind.DRAFT))).toBe('Max wind');
  });

  it('marks queued loads as stopped on cancel', async () => {
    const h = await boot();
    for (const [i, q] of ['A', 'B'].entries()) { await create(h, `Question ${q}`, `SELECT ${i}`, 601 + i); h.ui.newQuestion(); }
    h.ui.setDataset({ kind: 'fixture', name: 'flights' }); await flush(); await activate(h, 12, 'flights');
    const restored = await boot(h.storage); // reload: the first chart activates weather, the second waits
    restored.ui.cancel(); await flush();
    const statuses = [...restored.host.cards.values()].map(c => c.statusText);
    expect(statuses.every(s => !s.startsWith('Waiting'))).toBe(true);
  });

  it('journals each keystroke after its DRAFT is sent, coalescing writes behind a slow save', async () => {
    const h = await boot(), order: string[] = [], write = h.storage.write.bind(h.storage);
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    h.storage.write = async patch => { order.push('write'); await gate; await write(patch); };
    const post = h.engine.postMessage.bind(h.engine);
    h.engine.postMessage = (m, t) => { if (m.type === 'frame' || m.type === undefined) order.push('frame'); post(m, t); };
    h.ui.input('Average temperature', false, 1); await flush();
    order.length = 0;
    for (const text of ['Average temperature b', 'Average temperature by', 'Average temperature by hour']) h.ui.input(text, false, 2);
    expect(order[0]).toBe('frame');
    await flush(); release(); await h.ui.session!.settled();
    expect(order.filter(o => o === 'write').length).toBeLessThanOrEqual(2);
    expect((await h.storage.load(h.ui.model!.header.id))!.drafts.find(d => d.id === h.ui.editing!.id)?.text).toBe('Average temperature by hour');
    expect(h.ui.session!.saveState.state).toBe('saved');
  });

  it('sends the DRAFT before any storage work for that keystroke', async () => {
    const h = await boot(), order: string[] = [], write = h.storage.write.bind(h.storage);
    h.ui.input('Average temperature', false, 1); await flush(); await h.ui.session!.settled();
    h.storage.write = async patch => { order.push('write'); await write(patch); };
    const post = h.engine.postMessage.bind(h.engine);
    h.engine.postMessage = (m, t) => { order.push(m.type); post(m, t); };
    h.ui.input('Average temperature by hour', false, 2);
    await h.ui.session!.settled();
    expect(order).toEqual(['frame', 'write']);
  });

  it('places a new chart where no other chart is', async () => {
    const h = await boot();
    const a = await create(h, 'A', 'SELECT 1', 701); h.ui.newQuestion();
    const b = await create(h, 'B', 'SELECT 2', 702); h.ui.newQuestion();
    h.ui.close(h.host.cards.size ? [...h.host.cards.values()].find(c => !c.destroyed)!.slot : 0); await flush();
    expect(h.ui.model!.selected(a.chartId)).toBeUndefined();
    const c = await create(h, 'C', 'SELECT 3', 703);
    const layouts = h.ui.model!.state.charts.map(x => x.layout);
    const [lb, lc] = [b.chartId, c.chartId].map(id => h.ui.model!.state.charts.find(x => x.id === id)!.layout);
    expect(layouts).toHaveLength(2);
    expect(lb.x === lc.x && lb.y === lc.y).toBe(false);
  });

  it('does not create a revision when playback runs to its end', async () => {
    const h = await boot(), first = await create(h);
    const card = h.host.cards.get(first.e.slot)!, before = h.ui.model!.revisions.size;
    card.handlers.param(first.e.slot, 'playback', 0.5); card.handlers.param(first.e.slot, 'playback', 1); card.handlers.paramEnd?.(first.e.slot);
    expect(h.ui.model!.revisions.size).toBe(before);
  });

  it('does not undo a text refinement on a plot double-click', async () => {
    const h = await boot(), first = await create(h);
    h.ui.editChart(first.chartId); h.ui.input('Use maximum', false, 3); await flush();
    const e = execution(lastFrame(h, Kind.DRAFT), 801, 'SELECT max(temperature) FROM weather');
    h.ui.commit('Use maximum', 4); candidate(h, e); outcome(h, e);
    const refined = h.ui.model!.selected(first.chartId)!.id;
    h.ui.back(e.slot, 5); await flush();
    expect(h.ui.model!.selected(first.chartId)!.id).toBe(refined);
  });

  it('does not contact hosts named by an imported canvas until asked', async () => {
    const h = await boot(), first = await create(h);
    const file = JSON.parse(h.ui.session!.exportFile().content);
    const remote = { ...file.sources[0], id: 'remote-src', name: 'Remote', locator: { kind: 'url', url: 'https://attacker.example/data.csv' } };
    file.sources.push(remote);
    for (const r of file.revisions) r.sourceRefId = 'remote-src';
    for (const d of file.drafts) d.sourceRefId = 'remote-src';
    h.engine.clear();
    await h.ui.importCanvas(JSON.stringify(file)); await flush();
    expect(h.engine.messages('dataset').some(m => m.source.kind === 'url')).toBe(false);
    const card = [...h.host.cards.values()].find(c => !c.destroyed)!;
    expect(card.statusText).toContain('attacker.example');
    card.handlers.refresh?.(card.slot); await flush();
    expect(h.engine.messages('dataset').some(m => m.source.kind === 'url')).toBe(true);
    expect(first).toBeDefined();
  });
});

describe('chart captions', () => {
  const card = (h: Harness, chartId: string) => [...h.host.cards.values()].find(c => !c.destroyed && h.ui.model!.state.charts.some(ch => ch.id === chartId))!;

  it('captions a saved chart over its own link, never through the engine, and shows it only while no edit is open', async () => {
    const wire = new CaptionWire(), h = await boot(undefined, wire); h.engine.clear();
    const first = await create(h);
    expect(wire.links).toHaveLength(1);
    expect(wire.link.endpoint).toBe(inference.endpoint);
    expect(wire.describes()).toEqual([]); // waits for READY with describe-v1
    wire.ready();
    expect(wire.describes()).toEqual([{ request: 1, payload: { v: 1, sql: first.revision.sql, question: 'Average temperature', dialect: 'duckdb',
      tables: [{ name: 'weather', columns: [['temperature', 'DOUBLE']] }] } }]);
    expect(h.engine.frames.some(f => f.kind === Kind.DESCRIBE || f.kind === Kind.DESCRIPTION)).toBe(false);
    wire.reply('Average temperature overall', 'Mean of all temperature readings.');
    const c = card(h, first.chartId);
    expect(c.captionShown).toMatchObject({ title: 'Average temperature overall', explanation: 'Mean of all temperature readings.' });
    expect(c.captionQuestion).toBe('Average temperature');
    h.ui.editChart(first.chartId); await flush();
    expect(c.captionShown).toBeNull();
    h.ui.finishEditor(); await flush();
  });

  it('refinements carry the previous title and change; a presentation change inherits without a request', async () => {
    const wire = new CaptionWire(), h = await boot(undefined, wire);
    const first = await create(h); wire.ready(); wire.reply('Average temperature');
    h.ui.editChart(first.chartId); h.ui.input('Use maximum instead', false, 3); await flush();
    const refined = execution(lastFrame(h, Kind.DRAFT), 202, 'SELECT max(temperature) FROM weather');
    h.ui.commit('Use maximum instead', 4); candidate(h, refined); outcome(h, refined);
    await h.ui.session!.settled(); await flush();
    expect(wire.describes().at(-1)!.payload).toMatchObject({ sql: refined.sql, question: 'Average temperature',
      previousTitle: 'Average temperature', change: 'Use maximum instead' });
    wire.reply('Maximum temperature');
    const c = card(h, first.chartId);
    expect(c.captionShown?.title).toBe('Maximum temperature');
    const before = wire.describes().length;
    c.handlers.view(c.slot, 'bar'); await flush();
    const head = h.ui.model!.selected(first.chartId)!;
    expect(head.change.kind).toBe('view');
    expect(wire.describes()).toHaveLength(before);
    expect(h.ui.captions.get(head.id, head.sql)?.title).toBe('Maximum temperature');
  });

  it('ignores a late caption for a revision the chart no longer shows, and keeps it for history', async () => {
    const wire = new CaptionWire(), h = await boot(undefined, wire);
    const first = await create(h); wire.ready(); wire.reply('Average temperature');
    h.ui.editChart(first.chartId); h.ui.input('Use maximum instead', false, 3); await flush();
    const refined = execution(lastFrame(h, Kind.DRAFT), 202, 'SELECT max(temperature) FROM weather');
    h.ui.commit('Use maximum instead', 4); candidate(h, refined); outcome(h, refined);
    await h.ui.session!.settled(); await flush();
    const pending = wire.describes().at(-1)!;
    h.ui.undo(); await flush();
    wire.reply('Maximum temperature', 'Late.', pending.request);
    const c = card(h, first.chartId);
    expect(c.captionShown?.title).toBe('Average temperature');
    const refinedRevision = [...h.ui.model!.revisions.values()].find(r => r.sql === refined.sql)!;
    expect(h.ui.captions.get(refinedRevision.id, refinedRevision.sql)?.title).toBe('Maximum temperature');
  });

  it('restores stored captions after a reload without asking again, and backfills missing ones', async () => {
    const wire = new CaptionWire(), store = new MemoryCaptionStore(), h = await boot(undefined, wire, store);
    const first = await create(h); wire.ready(); wire.reply('Average temperature');
    const second = await create(h, 'Coldest reading', 'SELECT min(temperature) FROM weather', 301);
    expect(wire.describes().at(-1)!.payload).toMatchObject({ sql: second.revision.sql });
    // The second caption never arrives (tab closed).
    const wire2 = new CaptionWire(), restored = await boot(h.storage, wire2, store);
    const query = restored.engine.frames.filter(f => f.kind === Kind.QUERY);
    for (const [i, q] of query.entries()) { const e = execution(q, 400 + i, readText(q.payload.subarray(4))); candidate(restored, e); outcome(restored, e); }
    await flush();
    expect(card(restored, first.chartId).captionShown?.title).toBe('Average temperature');
    wire2.ready();
    expect(wire2.describes().map(d => d.payload.sql)).toEqual([second.revision.sql]);
  });

  it('turning captions off restores questions and stops asking; an endpoint without describe-v1 is not asked', async () => {
    const wire = new CaptionWire(), h = await boot(undefined, wire);
    const first = await create(h); wire.ready(); wire.reply('Average temperature');
    h.ui.setCaptions(false);
    expect(card(h, first.chartId).captionShown).toBeNull();
    await create(h, 'Coldest reading', 'SELECT min(temperature) FROM weather', 301);
    expect(wire.describes()).toHaveLength(1);
    h.ui.setCaptions(true);
    expect(card(h, first.chartId).captionShown?.title).toBe('Average temperature');

    const old = new CaptionWire(), o = await boot(undefined, old);
    await create(o); old.ready(['edit-context-v1']);
    expect(old.describes()).toEqual([]);
    expect(old.link.closed).toBe(true);
  });

  it('exports captions with the canvas; import and Save a copy keep them on the remapped revisions without asking', async () => {
    const wire = new CaptionWire(), h = await boot(undefined, wire);
    const first = await create(h); wire.ready(); wire.reply('Average temperature', 'Mean of every reading.');
    const raw = h.ui.session!.exportFile(h.ui.exportCaptions()).content;
    expect(JSON.parse(raw).captions).toEqual([{ revisionId: first.revision.id, title: 'Average temperature', explanation: 'Mean of every reading.', model: 'fake/captioner', promptVersion: 1 }]);
    const asked = wire.describes().length;
    // A malformed entry is dropped, never fatal.
    const tampered = JSON.stringify({ ...JSON.parse(raw), captions: [...JSON.parse(raw).captions, { revisionId: 'x', title: 7 }] });
    await h.ui.importCanvas(tampered); await flush();
    const imported = h.ui.model!, revision = [...imported.revisions.values()][0];
    expect(imported.header.id).not.toBe(first.revision.canvasId);
    expect(revision.id).not.toBe(first.revision.id);
    expect(h.ui.captions.get(revision.id, revision.sql)?.title).toBe('Average temperature');
    await h.ui.saveCopy(); await flush();
    const copy = [...h.ui.model!.revisions.values()][0];
    expect(copy.id).not.toBe(revision.id);
    expect(h.ui.captions.get(copy.id, copy.sql)?.explanation).toBe('Mean of every reading.');
    expect(wire.describes()).toHaveLength(asked);
  });
});

