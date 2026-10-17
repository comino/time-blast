import { describe, expect, it } from 'vitest';
import { CanvasModel, type DraftSession, type Presentation } from '../src/canvas/model';
import { forkCanvas, parseCanvas, validateCanvas, validatePatch } from '../src/canvas/validation';

function setup() {
  let serial = 0, at = 100;
  const id = () => `id-${++serial}`;
  const model = CanvasModel.create('Weather research', id, () => ++at);
  const sourceId = id();
  model.addSource({ id: sourceId, name: 'weather', locator: { kind: 'fixture', name: 'weather' }, policy: 'current',
    tables: [{ name: 'weather', columns: [{ name: 'temperature', type: 'DOUBLE' }] }] });
  return { model, sourceId, id };
}
function create(model: CanvasModel, sourceRefId: string, text = 'Average temperature', sql = 'SELECT avg(temperature) FROM weather'): DraftSession {
  const { draft } = model.startDraft({ sourceRefId, text });
  model.recordSql(draft.id, draft.sequence, sql);
  model.finishDraft(draft.id);
  model.outcome(draft.id, draft.sequence, sql, 'succeeded');
  return model.drafts.get(draft.id)!;
}
function edit(model: CanvasModel, chartId: string, text: string, sql: string) {
  const { draft } = model.startDraft({ chartId, text });
  model.recordSql(draft.id, draft.sequence, sql);
  model.outcome(draft.id, draft.sequence, sql, 'succeeded');
  model.finishDraft(draft.id);
  return model.selected(chartId)!;
}

describe('canvas definition and edit lifecycle', () => {
  it('preserves original intent and appends exact SQL revisions without result data', () => {
    const { model, sourceId } = setup();
    const created = create(model, sourceId), base = model.selected(created.chartId)!;
    const revision = edit(model, created.chartId, 'Use maximum instead', 'SELECT max(temperature) FROM weather');
    expect(revision.originalQuestion).toBe(base.originalQuestion);
    expect(revision.parentId).toBe(base.id);
    expect(model.lineage(revision.id).map(r => r.change.text)).toEqual(['Average temperature', 'Use maximum instead']);
    const saved = parseCanvas(JSON.stringify(model.snapshot()));
    expect(saved.revisions.map(r => r.sql)).toEqual(['SELECT avg(temperature) FROM weather', 'SELECT max(temperature) FROM weather']);
    expect(Object.keys(saved)).toEqual(['format', 'formatVersion', 'canvas', 'commits', 'revisions', 'sources', 'drafts']);
  });

  it.each(['before', 'after'])('checkpoints the same candidate when finishing %s successful execution', order => {
    const { model, sourceId } = setup();
    const { draft } = model.startDraft({ sourceRefId: sourceId, text: 'Average temperature' });
    model.recordSql(draft.id, 0, 'SELECT 1');
    if (order === 'before') model.finishDraft(draft.id);
    model.outcome(draft.id, 0, 'SELECT 1', 'succeeded');
    if (order === 'after') model.finishDraft(draft.id);
    expect(model.state.charts).toHaveLength(1);
    expect(model.selected(draft.chartId)?.sql).toBe('SELECT 1');
    expect(model.drafts.get(draft.id)?.closedAs).toBe('committed');
    expect(model.outcome(draft.id, 0, 'SELECT 1', 'succeeded')).toBeNull();
    expect(model.finishDraft(draft.id)).toBeNull();
    expect(model.commits.size).toBe(2);
  });

  it('recovers final SQL, source, presentation and layout before the first successful query', () => {
    const { model, sourceId } = setup();
    const layout = { x: 99, y: -50, width: 650, height: 510 };
    const { draft } = model.startDraft({ sourceRefId: sourceId, text: 'An unfinished question', layout });
    model.draftPresentation(draft.id, { view: 'bar', params: {} });
    model.recordSql(draft.id, 0, 'SELECT missing FROM weather');
    model.finishDraft(draft.id);
    model.outcome(draft.id, 0, 'SELECT missing FROM weather', 'failed', 'Column unavailable');
    const restored = new CanvasModel(parseCanvas(JSON.stringify(model.snapshot())));
    expect(restored.state.charts).toHaveLength(0);
    expect(restored.drafts.get(draft.id)).toMatchObject({ state: 'open', sourceRefId: sourceId, layout,
      text: 'An unfinished question', presentation: { view: 'bar', params: {} },
      candidate: { sql: 'SELECT missing FROM weather', status: 'failed', error: 'Column unavailable' } });
  });

  it('retains the prior revision after failure partway through an edit', () => {
    const { model, sourceId } = setup(), chart = create(model, sourceId);
    const previous = model.selected(chart.chartId);
    const { draft } = model.startDraft({ chartId: chart.chartId, text: 'Group by station' });
    model.recordSql(draft.id, 0, 'SELECT station, avg(temperature) FROM weather GROUP BY station');
    model.finishDraft(draft.id);
    model.outcome(draft.id, 0, model.drafts.get(draft.id)!.candidate!.sql, 'failed', 'Stream interrupted');
    expect(model.selected(chart.chartId)).toEqual(previous);
    expect(model.drafts.get(draft.id)?.candidate?.sql).toContain('GROUP BY station');
  });

  it('ignores SQL and completion for old sequences or closed sessions', () => {
    const { model, sourceId } = setup();
    const { draft } = model.startDraft({ sourceRefId: sourceId, text: 'one' });
    model.recordSql(draft.id, 0, 'SELECT 1');
    model.updateText(draft.id, 'two');
    expect(model.recordSql(draft.id, 0, 'SELECT 1')).toBeNull();
    expect(model.outcome(draft.id, 0, 'SELECT 1', 'succeeded')).toBeNull();
    model.recordSql(draft.id, 1, 'SELECT 2');
    model.closeDraft(draft.id);
    expect(model.outcome(draft.id, 1, 'SELECT 2', 'succeeded')).toBeNull();
    expect(model.updateText(draft.id, 'three')).toBeNull();
    expect(model.state.charts).toHaveLength(0);
  });

  it('reopening a pending checkpoint gives it a fresh session and supersedes old callbacks', () => {
    const { model, sourceId } = setup();
    const { draft } = model.startDraft({ sourceRefId: sourceId, text: 'one' });
    model.recordSql(draft.id, 0, 'SELECT 1'); model.finishDraft(draft.id);
    expect(() => model.updateText(draft.id, 'two')).toThrow('Reopen');
    const resumed = model.reopenDraft(draft.id);
    expect(resumed.draft.id).not.toBe(draft.id);
    expect(resumed.draft.finishSequence).toBeUndefined();
    expect(model.outcome(draft.id, 0, 'SELECT 1', 'succeeded')).toBeNull();
    model.updateText(resumed.draft.id, 'two');
    expect(model.drafts.get(resumed.draft.id)?.originalQuestion).toBe('two');
    expect(model.drafts.get(draft.id)?.closedAs).toBe('superseded');
  });

  it('records different user requests even when they produce identical SQL', () => {
    const { model, sourceId } = setup();
    const created = create(model, sourceId, 'one', 'SELECT 1');
    const first = model.selected(created.chartId)!;
    const second = edit(model, created.chartId, 'Keep the same result', 'SELECT 1');
    expect(second.id).not.toBe(first.id);
    expect(second.sql).toBe(first.sql);
    expect(model.lineage(second.id)).toHaveLength(2);
  });
});

describe('capturing a displayed draft before a gesture', () => {
  it('captures the displayed definition, retains newer text, and requires a fresh execution', () => {
    const { model, sourceId } = setup(), created = create(model, sourceId);
    const base = model.selected(created.chartId)!;
    const { draft } = model.startDraft({ chartId: created.chartId, text: 'Use maximum instead' });
    const shownSql = 'SELECT max(temperature) FROM weather', newerSql = 'SELECT min(temperature) FROM weather';
    model.draftPresentation(draft.id, { view: 'bar', params: {} });
    model.recordSql(draft.id, 0, shownSql);
    model.outcome(draft.id, 0, shownSql, 'succeeded');
    const displayed = structuredClone(model.drafts.get(draft.id)!);
    model.updateText(draft.id, 'Use minimum instead');
    model.recordSql(draft.id, 1, newerSql);
    model.draftPresentation(draft.id, { view: 'line', params: {} });
    const competing = model.startDraft({ chartId: created.chartId, text: 'Another unfinished edit' }).draft;
    const unrelated = model.startDraft({ sourceRefId: sourceId, text: 'A separate chart' }).draft;
    const priorVersion = model.drafts.get(draft.id)!.version;

    const captured = model.captureDraft(displayed, shownSql);
    expect(captured.draft).toMatchObject({ chartId: created.chartId, baseRevisionId: base.id,
      version: 0, sequence: 0, finishSequence: 0, text: 'Use maximum instead', originalQuestion: base.originalQuestion,
      presentation: { view: 'bar', params: {} }, candidate: { sequence: 0, sql: shownSql, status: 'pending' }, state: 'open' });
    expect(captured.draft.id).not.toBe(draft.id);
    expect(captured.patch.head).toBeUndefined();
    expect(captured.patch.drafts).toHaveLength(3);
    expect(captured.patch.drafts?.find(w => w.value.id === draft.id)).toMatchObject({ expectedVersion: priorVersion,
      value: { text: 'Use minimum instead', state: 'closed', closedAs: 'superseded', candidate: { sql: newerSql } } });
    expect(model.drafts.get(competing.id)?.closedAs).toBe('superseded');
    expect(model.drafts.get(unrelated.id)?.state).toBe('open');
    expect(model.selected(created.chartId)?.id).toBe(base.id);
    expect(model.outcome(draft.id, 1, newerSql, 'succeeded')).toBeNull();
    expect(model.recordSql(competing.id, 0, 'SELECT 2')).toBeNull();
    expect(model.finishDraft(captured.draft.id)).toBeNull();
    validatePatch(captured.patch);

    model.outcome(captured.draft.id, 0, shownSql, 'succeeded');
    expect(model.selected(created.chartId)).toMatchObject({ parentId: base.id, sql: shownSql,
      originalQuestion: base.originalQuestion, change: { kind: 'refine', text: 'Use maximum instead' },
      presentation: { view: 'bar', params: {} } });
    validateCanvas(model.snapshot());
  });

  it('retains an older creation question and provisional placement before the first revision', () => {
    const { model, sourceId } = setup(), layout = { x: 700, y: -20, width: 620, height: 400 };
    const { draft } = model.startDraft({ sourceRefId: sourceId, text: 'Average temperature', layout });
    const sql = 'SELECT avg(temperature) FROM weather';
    model.recordSql(draft.id, 0, sql);
    const displayed = structuredClone(model.drafts.get(draft.id)!);
    model.updateText(draft.id, 'Maximum temperature');
    const captured = model.captureDraft(displayed, sql);
    expect(captured.draft).toMatchObject({ chartId: draft.chartId, baseRevisionId: null,
      text: 'Average temperature', originalQuestion: 'Average temperature', layout, sourceRefId: sourceId });
    expect(model.state.charts).toHaveLength(0);
    model.outcome(captured.draft.id, 0, sql, 'succeeded');
    expect(model.state.charts).toEqual([{ id: draft.chartId, revisionId: model.selected(draft.chartId)!.id, layout }]);
    expect(model.selected(draft.chartId)?.originalQuestion).toBe('Average temperature');
    expect(model.drafts.get(draft.id)?.text).toBe('Maximum temperature');
    validateCanvas(model.snapshot());
  });

  it('clears captured terminal errors and finish authority when checkpointing is not requested', () => {
    const { model, sourceId } = setup();
    const { draft } = model.startDraft({ sourceRefId: sourceId, text: 'First question' });
    model.updateText(draft.id, 'Second question');
    model.recordSql(draft.id, 1, 'SELECT 2'); model.finishDraft(draft.id);
    model.outcome(draft.id, 1, 'SELECT 2', 'failed', 'Old execution failed');
    const captured = model.captureDraft(structuredClone(model.drafts.get(draft.id)!), 'SELECT 2', { finish: false });
    expect(captured.draft.candidate).toEqual({ sequence: 0, sql: 'SELECT 2', status: 'pending' });
    expect(captured.draft.finishSequence).toBeUndefined();
    expect(captured.draft.closedAs).toBeUndefined();
    expect(captured.draft.committedRevisionId).toBeUndefined();
    expect(model.outcome(captured.draft.id, 1, 'SELECT 2', 'succeeded')).toBeNull();
    model.outcome(captured.draft.id, 0, 'SELECT 2', 'succeeded');
    expect(model.state.charts).toHaveLength(0);
    model.finishDraft(captured.draft.id);
    expect(model.selected(draft.chartId)?.sql).toBe('SELECT 2');
  });

  it('rejects a changed selected base before closing any draft or mutating state', () => {
    const { model, sourceId } = setup(), created = create(model, sourceId);
    const { draft } = model.startDraft({ chartId: created.chartId, text: 'Maximum temperature' });
    model.recordSql(draft.id, 0, 'SELECT max(temperature) FROM weather');
    const displayed = structuredClone(model.drafts.get(draft.id)!);
    model.changePresentation(created.chartId, { view: 'bar', params: {} });
    const before = model.snapshot();
    expect(() => model.captureDraft(displayed, displayed.candidate!.sql)).toThrow('chart changed');
    expect(model.snapshot()).toEqual(before);
  });

  it('rejects abandoned and repeated captures even when a creation base is still absent', () => {
    const { model, sourceId } = setup();
    const { draft } = model.startDraft({ sourceRefId: sourceId, text: 'New chart' });
    const displayed = structuredClone(draft);
    const captured = model.captureDraft(displayed, 'SELECT 1');
    const beforeDuplicate = model.snapshot();
    expect(() => model.captureDraft(displayed, 'SELECT 1')).toThrow('no longer active');
    expect(model.snapshot()).toEqual(beforeDuplicate);
    model.restoreCanvas(model.head.id);
    const afterRestore = model.snapshot();
    expect(() => model.captureDraft(captured.draft, 'SELECT 1')).toThrow('no longer active');
    expect(model.snapshot()).toEqual(afterRestore);
    expect(model.outcome(captured.draft.id, 0, 'SELECT 1', 'succeeded')).toBeNull();
    expect(model.state.charts).toHaveLength(0);
  });

  it('rejects mismatched identity, changed original intent and invalid text before mutation', () => {
    const { model, sourceId } = setup(), created = create(model, sourceId);
    const { draft } = model.startDraft({ chartId: created.chartId, text: 'Maximum temperature' });
    const before = model.snapshot();
    expect(() => model.captureDraft({ ...draft, canvasId: 'another-canvas' }, 'SELECT 1')).toThrow('no longer active');
    expect(() => model.captureDraft({ ...draft, sourceRefId: 'another-source' }, 'SELECT 1')).toThrow('no longer active');
    expect(() => model.captureDraft({ ...draft, sequence: draft.sequence + 1 }, 'SELECT 1')).toThrow('known edit sequence');
    expect(() => model.captureDraft({ ...draft, originalQuestion: 'Rewritten original' }, 'SELECT 1')).toThrow('original question');
    expect(() => model.captureDraft({ ...draft, text: 'x'.repeat(16385) }, 'SELECT 1')).toThrow('limit');
    expect(() => model.captureDraft(draft, ' ')).toThrow('empty');
    expect(model.snapshot()).toEqual(before);
  });
});

describe('explicit SQL source rebinding', () => {
  function alternateSource(model: CanvasModel, sourceId = 'replacement-source'): string {
    model.addSource({ id: sourceId, name: 'Replacement weather', locator: { kind: 'fixture', name: 'weather' },
      policy: 'current', tables: [{ name: 'replacement_weather', columns: [{ name: 'temperature', type: 'DOUBLE' }] }] });
    return sourceId;
  }

  it('records a SQL rebind as a new revision with the same original question', () => {
    const { model, sourceId } = setup(), created = create(model, sourceId), base = model.selected(created.chartId)!;
    const replacement = alternateSource(model), sql = 'SELECT avg(temperature) FROM replacement_weather';
    const { draft } = model.startDraft({ chartId: created.chartId, sourceRefId: replacement, mode: 'sql', text: sql });
    expect(draft).toMatchObject({ baseRevisionId: base.id, sourceRefId: replacement, originalQuestion: base.originalQuestion });
    model.recordSql(draft.id, 0, sql); model.finishDraft(draft.id);
    model.outcome(draft.id, 0, sql, 'succeeded');
    expect(model.selected(created.chartId)).toMatchObject({ parentId: base.id, sourceRefId: replacement, sql,
      originalQuestion: base.originalQuestion, change: { kind: 'sql', text: sql } });
    model.restoreChart(created.chartId, base.id);
    expect(model.selected(created.chartId)?.sourceRefId).toBe(sourceId);
    validateCanvas(model.snapshot());
  });

  it('keeps the previous source active when rebinding execution fails', () => {
    const { model, sourceId } = setup(), created = create(model, sourceId), base = model.selected(created.chartId)!;
    const replacement = alternateSource(model), sql = 'SELECT unavailable FROM replacement_weather';
    const { draft } = model.startDraft({ chartId: created.chartId, sourceRefId: replacement, mode: 'sql', text: sql });
    model.recordSql(draft.id, 0, sql); model.finishDraft(draft.id);
    model.outcome(draft.id, 0, sql, 'failed', 'Column unavailable');
    expect(model.selected(created.chartId)).toEqual(base);
    expect(model.drafts.get(draft.id)).toMatchObject({ sourceRefId: replacement, text: sql, state: 'open',
      candidate: { sql, status: 'failed' } });
    validateCanvas(model.snapshot());
  });

  it('requires an explicit SQL edit and a known source', () => {
    const { model, sourceId } = setup(), created = create(model, sourceId), replacement = alternateSource(model);
    const before = model.snapshot();
    for (const mode of ['question', 'regenerate', 'gesture'] as const) {
      expect(() => model.startDraft({ chartId: created.chartId, sourceRefId: replacement, mode })).toThrow('explicit SQL edit');
    }
    expect(() => model.startDraft({ chartId: created.chartId, sourceRefId: 'unknown-source', mode: 'sql' })).toThrow('Choose a source');
    expect(model.snapshot()).toEqual(before);
  });
});

describe('canvas history and branching', () => {
  it('whole-canvas restore closes unfinished creation drafts before late success', () => {
    const { model, sourceId } = setup(), empty = model.head.id;
    const { draft } = model.startDraft({ sourceRefId: sourceId, text: 'one' });
    model.recordSql(draft.id, 0, 'SELECT 1'); model.finishDraft(draft.id);
    model.restoreCanvas(empty);
    expect(model.outcome(draft.id, 0, 'SELECT 1', 'succeeded')).toBeNull();
    expect(model.state.charts).toHaveLength(0);
    expect(model.drafts.get(draft.id)?.closedAs).toBe('superseded');
  });
  it('preserves the abandoned future through export, import and redo selection', () => {
    const { model, sourceId } = setup();
    const created = create(model, sourceId, 'one', 'SELECT 1');
    const forkPoint = model.head.id;
    const oldFuture = edit(model, created.chartId, 'two', 'SELECT 2'), oldHead = model.head.id;
    model.undo();
    edit(model, created.chartId, 'three', 'SELECT 3');
    const newHead = model.head.id;
    expect(model.branches(forkPoint).map(c => c.id)).toEqual([oldHead, newHead]);
    const restored = new CanvasModel(parseCanvas(JSON.stringify(model.snapshot())));
    restored.undo(); restored.redo(oldHead);
    expect(restored.selected(created.chartId)?.id).toBe(oldFuture.id);
    const imported = forkCanvas(model.snapshot());
    expect(imported.canvas.id).not.toBe(model.header.id);
    expect(imported.revisions.map(r => r.sql)).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
    expect(imported.commits).toHaveLength(model.commits.size);
    expect(imported.canvas.headCommitId).not.toBe(newHead);
    validateCanvas(imported);
  });

  it('uses a monotonic store version even when undo returns to an earlier head', () => {
    const { model } = setup(), original = model.header.headCommitId, version = model.header.storeVersion;
    model.rename('Changed title'); model.undo();
    expect(model.header.headCommitId).toBe(original);
    expect(model.header.storeVersion).toBe(version + 2);
  });

  it('invalidates an affected draft on undo and never commits its late outcome', () => {
    const { model, sourceId } = setup(), created = create(model, sourceId, 'one', 'SELECT 1');
    edit(model, created.chartId, 'two', 'SELECT 2');
    const { draft } = model.startDraft({ chartId: created.chartId, text: 'three' });
    model.recordSql(draft.id, 0, 'SELECT 3'); model.finishDraft(draft.id);
    const undo = model.undo();
    expect(undo?.drafts?.[0].value.closedAs).toBe('superseded');
    expect(model.outcome(draft.id, 0, 'SELECT 3', 'succeeded')).toBeNull();
    expect(model.selected(created.chartId)?.sql).toBe('SELECT 1');
  });

  it('keeps chart restore independent of other charts and canvas restore undoable', () => {
    const { model, sourceId } = setup(), a = create(model, sourceId, 'one', 'SELECT 1'), b = create(model, sourceId, 'two', 'SELECT 2');
    const oldCanvas = model.head.id, originalA = model.selected(a.chartId)!, originalB = model.selected(b.chartId)!;
    edit(model, a.chartId, 'three', 'SELECT 3');
    model.layout([{ chartId: a.chartId, layout: { x: 700, y: 9, width: 500, height: 470 } }]);
    model.restoreChart(a.chartId, originalA.id);
    expect(model.selected(b.chartId)).toEqual(originalB);
    expect(model.state.charts[0].layout.x).toBe(700);
    const beforeRestore = model.head.id;
    model.restoreCanvas(oldCanvas);
    expect(model.state.charts[0].layout.x).toBe(24);
    expect(model.head.restoredFrom).toBe(oldCanvas);
    model.undo(); expect(model.head.id).toBe(beforeRestore);
  });

  it('restores exact presentation and keeps deleted charts in history', () => {
    const { model, sourceId } = setup(), a = create(model, sourceId);
    const first = model.selected(a.chartId)!;
    const changed: Presentation = { view: 'surface', params: { rotation: 90, playback: 0.4 } };
    model.changePresentation(a.chartId, changed);
    model.restoreChart(a.chartId, first.id);
    expect(model.selected(a.chartId)?.presentation).toEqual({ view: null, params: {} });
    model.removeCharts([a.chartId]); expect(model.state.charts).toHaveLength(0);
    model.undo(); expect(model.selected(a.chartId)?.id).toBe(first.id);
    expect(model.revisions.size).toBe(2);
  });
});

describe('portable document validation', () => {
  it('rejects oversized authoring input before mutating the model', () => {
    const { model, sourceId } = setup(), before = model.snapshot();
    expect(() => model.rename('x'.repeat(1025))).toThrow('limit');
    expect(() => model.startDraft({ sourceRefId: sourceId, text: 'x'.repeat(16385) })).toThrow('limit');
    expect(model.snapshot()).toEqual(before);
    validateCanvas(model.snapshot());
  });
  it('rejects unknown versions, unsupported data fields and credential-bearing sources', () => {
    const { model, sourceId } = setup(); create(model, sourceId);
    const future = model.snapshot(); (future as { formatVersion: number }).formatVersion = 2;
    expect(() => validateCanvas(future)).toThrow('Unsupported canvas format');
    const data = { ...model.snapshot(), results: [[1, 2]] };
    expect(() => validateCanvas(data)).toThrow('Unsupported field');
    const sample = model.snapshot(); Object.assign(sample.sources[0].tables[0], { sample: [[27]] });
    expect(() => validateCanvas(sample)).toThrow('Unsupported field');
    const credentials = model.snapshot(); credentials.sources[0].locator = { kind: 'url', url: 'https://example.test/data.csv?token=secret' };
    expect(() => validateCanvas(credentials)).toThrow('credentials');
  });
  it('rejects cycles, dangling sources and cross-chart revision references before import', () => {
    const { model, sourceId } = setup(); create(model, sourceId);
    const cycle = model.snapshot(); cycle.commits[0].parentId = cycle.commits[1].id;
    expect(() => validateCanvas(cycle)).toThrow();
    const dangling = model.snapshot(); dangling.sources = [];
    expect(() => validateCanvas(dangling)).toThrow('Missing revision source');
    const wrong = model.snapshot(); wrong.commits[1].state.charts[0].id = 'wrong-chart';
    expect(() => validateCanvas(wrong)).toThrow('different chart revision');
  });
  it('does not accept an altered original question on a child revision', () => {
    const { model, sourceId } = setup(), created = create(model, sourceId);
    edit(model, created.chartId, 'Maximum', 'SELECT max(temperature) FROM weather');
    const snapshot = model.snapshot(); snapshot.revisions[1].originalQuestion = 'Rewritten question';
    expect(() => validateCanvas(snapshot)).toThrow('original question');
  });
});

describe('review 2026-10-17', () => {
  it('rebases a change typed after Enter onto the checkpointed refinement', () => {
    const { model, sourceId } = setup();
    const created = create(model, sourceId), base = model.selected(created.chartId)!;
    const { draft: first } = model.startDraft({ chartId: created.chartId, text: 'Use maximum' });
    model.recordSql(first.id, 0, 'SELECT max(temperature) FROM weather'); model.finishDraft(first.id);
    const { draft: next } = model.startDraft({ chartId: created.chartId, text: 'Only station 7' });
    model.finishDraft(next.id);
    expect(model.rebaseDraft(next.id, base.id)).toBeNull(); // already on that base
    model.outcome(first.id, 0, 'SELECT max(temperature) FROM weather', 'succeeded');
    const refined = model.selected(created.chartId)!;
    expect(model.rebaseDraft(next.id, 'unknown')).toBeNull();
    const patch = model.rebaseDraft(next.id, refined.id)!;
    const rebased = model.drafts.get(next.id)!;
    expect(rebased).toMatchObject({ baseRevisionId: refined.id, sequence: 1, finishSequence: 1, text: 'Only station 7' });
    expect(rebased.candidate).toBeUndefined();
    expect(() => validatePatch(patch)).not.toThrow();
    expect(() => validateCanvas(model.snapshot())).not.toThrow();
  });

  it('rejects imported layouts beyond interactive bounds', () => {
    const { model, sourceId } = setup();
    create(model, sourceId);
    const snapshot = model.snapshot();
    snapshot.commits.at(-1)!.state.charts[0].layout.width = 1e6;
    expect(() => validateCanvas(snapshot)).toThrow(/layout width/);
    snapshot.commits.at(-1)!.state.charts[0].layout = { x: -2e6, y: 0, width: 500, height: 400 };
    expect(() => validateCanvas(snapshot)).toThrow(/layout x/);
  });
});
