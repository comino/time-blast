import { describe, expect, it } from 'vitest';
import { CanvasModel, type CanvasPatch, type CanvasSnapshot } from '../src/canvas/model';
import { CanvasSession } from '../src/canvas/session';
import { CanvasConflictError, type CanvasStorage, type StoreChange } from '../src/canvas/store';
import { importCanvasFile, parseCanvasFile, validateRecovery, type CanvasRecovery } from '../src/canvas/recovery';
import { parseCanvas, validateCanvas } from '../src/canvas/validation';

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(r => { resolve = r; }), resolve: () => resolve() };
}
class Storage implements CanvasStorage {
  snapshot: CanvasSnapshot | null = null;
  calls: CanvasPatch[] = [];
  gates: Promise<void>[] = [];
  failure?: Error;
  active: string | null = null;
  listener?: (c: StoreChange) => void;
  async write(patch: CanvasPatch) {
    this.calls.push(structuredClone(patch));
    await this.gates.shift();
    if (this.failure) throw this.failure;
    const before = this.snapshot;
    if (patch.head && patch.head.expectedVersion !== (before?.canvas.storeVersion ?? null)) throw new CanvasConflictError('head changed');
    const merge = <T extends { id: string }>(old: T[], added: T[]) => [...new Map([...old, ...added].map(r => [r.id, r])).values()];
    this.snapshot = validateCanvas(structuredClone({ format: 'timeblast-canvas', formatVersion: 1, canvas: patch.head?.value ?? before!.canvas,
      commits: merge(before?.commits ?? [], patch.commits ?? []), revisions: merge(before?.revisions ?? [], patch.revisions ?? []),
      sources: merge(before?.sources ?? [], patch.sources ?? []), drafts: merge(before?.drafts ?? [], patch.drafts?.map(d => d.value) ?? []) }));
  }
  async load() { return structuredClone(this.snapshot); }
  async list() { return this.snapshot ? [this.snapshot.canvas] : []; }
  async getActive() { return this.active; }
  async setActive(id: string) { this.active = id; }
  subscribe(listener: (c: StoreChange) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
  close() {}
}
function source(session: CanvasSession) {
  session.command(m => m.addSource({ id: 'weather', name: 'Weather', policy: 'current', locator: { kind: 'fixture', name: 'weather' }, tables: [] }));
}
function chart(session: CanvasSession, text = 'Average wind', sql = 'SELECT 1', chartId?: string) {
  const { draft } = session.command(m => m.startDraft({ sourceRefId: 'weather', chartId, text }));
  session.command(m => m.recordSql(draft.id, 0, sql));
  session.command(m => m.finishDraft(draft.id));
  session.command(m => m.outcome(draft.id, 0, sql, 'succeeded'));
  return draft;
}
async function setup() {
  const storage = new Storage(), session = CanvasSession.create(storage);
  await session.settled(); source(session); await session.settled();
  return { storage, session };
}

describe('canvas acknowledgement and recovery boundaries', () => {
  it('drains a command queued between the last acknowledgement and the drain cleanup', async () => {
    const { session, storage } = await setup();
    let queued = false;
    session.subscribe(() => {
      if (!queued && session.saveState.state === 'saved') {
        queued = true; queueMicrotask(() => session.command(m => m.rename('Second name')));
      }
    });
    session.command(m => m.rename('First name'));
    await session.settled();
    expect(session.saveState.state).toBe('saved');
    expect(new CanvasModel(storage.snapshot!).state.title).toBe('Second name');
  });

  it('does not change the active canvas after a session was closed during its initial save', async () => {
    const storage = new Storage(), gate = deferred(); storage.gates.push(gate.promise);
    const session = CanvasSession.create(storage);
    session.close(); storage.active = 'newer-canvas'; gate.resolve(); await session.settled();
    expect(storage.active).toBe('newer-canvas');
    expect(storage.snapshot?.canvas.id).toBe(session.model.header.id);
  });
  it('never calls later commands saved when an earlier write acknowledges', async () => {
    const { storage, session } = await setup();
    const first = deferred(), second = deferred(); storage.gates.push(first.promise, second.promise);
    session.command(m => m.rename('First name'));
    session.command(m => m.rename('Second name'));
    let exported = parseCanvasFile(session.exportFile().content) as CanvasRecovery;
    expect(new CanvasModel(exported.acknowledged!).state.title).toBe('Untitled canvas');
    expect(new CanvasModel(exported.working).state.title).toBe('Second name');
    first.resolve(); await new Promise(r => setTimeout(r, 0));
    exported = parseCanvasFile(session.exportFile().content) as CanvasRecovery;
    expect(new CanvasModel(exported.acknowledged!).state.title).toBe('First name');
    expect(session.saveState).toMatchObject({ state: 'saving', pending: 1 });
    second.resolve(); await session.settled();
    expect(session.saveState.state).toBe('saved');
    expect(parseCanvas(session.exportFile().content).commits).toHaveLength(3);
  });

  it('exports failed promotion as unacknowledged and recovers it atomically in a new namespace', async () => {
    const { storage, session } = await setup();
    const original = chart(session); await session.settled();
    const prior = session.model.selected(original.chartId)!;
    const { draft } = session.command(m => m.startDraft({ chartId: original.chartId, text: 'Maximum instead' }));
    session.command(m => m.recordSql(draft.id, 0, 'SELECT 2'));
    session.command(m => m.finishDraft(draft.id)); await session.settled();
    storage.failure = new DOMException('Quota exhausted', 'QuotaExceededError');
    session.command(m => m.outcome(draft.id, 0, 'SELECT 2', 'succeeded')); await session.settled();
    const raw = session.exportFile().content, file = parseCanvasFile(raw) as CanvasRecovery;
    expect(() => parseCanvas(raw)).toThrow();
    expect(file.acknowledged!.canvas.headCommitId).not.toBe(file.working.canvas.headCommitId);
    expect(new CanvasModel(file.acknowledged!).selected(original.chartId)?.id).toBe(prior.id);
    expect(file.working.drafts.find(d => d.id === draft.id)?.closedAs).toBe('committed');
    const recoveredStorage = new Storage(), gate = deferred(); recoveredStorage.gates.push(gate.promise);
    const recovered = CanvasSession.import(recoveredStorage, raw);
    expect(recovered.model.header.id).not.toBe(session.model.header.id);
    expect(recovered.model.head.action).toBe('Recover working copy');
    expect(recovered.saveState.state).toBe('saving'); expect(recoveredStorage.active).toBeNull();
    gate.resolve(); await recovered.settled();
    expect(recovered.saveState.state).toBe('saved'); expect(recoveredStorage.active).toBe(recovered.model.header.id);
    expect([...recovered.model.revisions.values()].map(r => r.sql)).toEqual(['SELECT 1', 'SELECT 2']);
    expect(storage.snapshot!.canvas.headCommitId).toBe(file.acknowledged!.canvas.headCommitId);
  });

  it('retains failed layout, rename, restore, undo and both history branches', async () => {
    const { storage, session } = await setup(), created = chart(session); await session.settled();
    const a = session.model.head.id;
    chart(session, 'Second', 'SELECT 2', created.chartId); await session.settled();
    const b = session.model.head.id;
    session.command(m => m.undo()); await session.settled();
    storage.failure = new Error('disk unavailable');
    chart(session, 'Other branch', 'SELECT 3', created.chartId); await session.settled();
    session.command(m => m.layout([{ chartId: created.chartId, layout: { x: 100, y: 200, width: 600, height: 450 } }]));
    session.command(m => m.rename('Research'));
    session.command(m => m.restoreCanvas(b));
    session.command(m => m.undo());
    const file = parseCanvasFile(session.exportFile().content) as CanvasRecovery;
    expect(file.working.commits.some(c => c.action === 'Restore canvas revision')).toBe(true);
    const recovered = importCanvasFile(file);
    expect(recovered.state.title).toBe('Research');
    expect(recovered.state.charts[0].layout.x).toBe(100);
    expect([...recovered.revisions.values()].map(r => r.sql)).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
    expect(session.model.branches(a)).toHaveLength(2);
  });

  it('retains unsaved initial work and never promotes imported successful drafts automatically', async () => {
    const session = CanvasSession.create(null); source(session);
    const { draft } = session.command(m => m.startDraft({ sourceRefId: 'weather', text: 'One' }));
    session.command(m => m.recordSql(draft.id, 0, 'SELECT 1'));
    session.command(m => m.outcome(draft.id, 0, 'SELECT 1', 'succeeded'));
    await session.settled();
    const file = parseCanvasFile(session.exportFile().content) as CanvasRecovery;
    expect(file.acknowledged).toBeNull();
    const recovered = CanvasSession.import(null, session.exportFile().content); await recovered.settled();
    expect(recovered.model.state.charts).toEqual([]);
    const restored = [...recovered.model.drafts.values()][0];
    expect(restored.candidate).toMatchObject({ sql: 'SELECT 1', status: 'succeeded' });
    const resumed = recovered.command(m => m.reopenDraft(restored.id)).draft;
    expect(resumed.candidate?.status).toBe('pending');
    recovered.command(m => m.finishDraft(resumed.id));
    expect(recovered.model.state.charts).toEqual([]);
    expect(recovered.exportFile().content).toContain('timeblast-canvas-recovery');
  });

  it('freezes dependent writes after a conflict while local authoring and export remain available', async () => {
    const { storage, session } = await setup();
    storage.listener!({ canvasId: session.model.header.id, writer: 'another-tab', storeVersion: 10, drafts: [] });
    const count = storage.calls.length;
    session.command(m => m.rename('Local work'));
    chart(session); await session.settled();
    expect(session.saveState.state).toBe('conflict'); expect(storage.calls).toHaveLength(count);
    expect((parseCanvasFile(session.exportFile().content) as CanvasRecovery).working.revisions).toHaveLength(1);
  });

  it('rejects recovery files which rewrite acknowledged records or reopen closed sessions', async () => {
    const { session } = await setup(); chart(session); await session.settled();
    const saved = session.model.snapshot();
    const recovery = (): CanvasRecovery => ({ format: 'timeblast-canvas-recovery', formatVersion: 1, exportedAt: Date.now(), acknowledged: structuredClone(saved), working: structuredClone(saved) });
    const changed = recovery(); changed.working.revisions[0].sql = 'SELECT 9'; changed.working.drafts[0].candidate!.sql = 'SELECT 9';
    expect(() => validateRecovery(changed)).toThrow(/acknowledged/);
    const reopened = recovery(), draft = reopened.working.drafts[0];
    draft.state = 'open'; draft.closedAs = undefined; draft.committedRevisionId = undefined; draft.version++;
    expect(() => validateRecovery(reopened)).toThrow(/acknowledged draft/);
  });
});
