/** Durable authoring state. Execution results and runtime request identities never live here. */
import type { ViewName } from '../engine/contracts';
import { boundedText, CANVAS_LIMITS } from './limits';

export const CANVAS_FORMAT = 1;
export type Id = string;
export const newId = (): Id => crypto.randomUUID();
export interface Layout { x: number; y: number; width: number; height: number }
export interface Presentation { view: ViewName | null; params: Record<string, number> }
export const defaultPresentation = (): Presentation => ({ view: null, params: {} });
export const defaultLayout = (): Layout => ({ x: 24, y: 24, width: 500, height: 470 });
export interface SourceRef {
  id: Id; canvasId: Id; name: string;
  locator:
    | { kind: 'fixture'; name: string }
    | { kind: 'url'; url: string }
    | { kind: 'remote'; endpoint: string }
    | { kind: 'file'; name: string; size: number; lastModified: number; sha256: string };
  policy: 'current' | 'pinned';
  /** Logical names are stable even when a reattached file has a new filename. */
  tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>;
  format?: 'csv' | 'parquet';
  fingerprint?: string;
}
export interface Change {
  kind: 'create' | 'refine' | 'regenerate' | 'sql' | 'view' | 'gesture';
  text: string;
  details?: string;
}
export interface ChartRevision {
  id: Id; canvasId: Id; chartId: Id; parentId: Id | null; at: number;
  originalQuestion: string; sourceRefId: Id; sql: string;
  presentation: Presentation; change: Change;
}
export interface ChartState { id: Id; revisionId: Id; layout: Layout }
export interface CanvasState { title: string; charts: ChartState[] }
export interface CanvasCommit {
  id: Id; canvasId: Id; parentId: Id | null; at: number; action: string;
  restoredFrom?: Id; state: CanvasState;
}
export interface CanvasHeader {
  id: Id; formatVersion: typeof CANVAS_FORMAT; storeVersion: number;
  createdAt: number; headCommitId: Id;
  /** A visited branch is a preference, not a destructive change to the graph. */
  redoChoices: Record<Id, Id>;
}
export interface Candidate {
  sequence: number; sql: string;
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  error?: string;
}
export interface DraftSession {
  id: Id; canvasId: Id; chartId: Id; baseRevisionId: Id | null;
  version: number; sequence: number; at: number; updatedAt: number;
  mode: 'question' | 'sql' | 'regenerate' | 'gesture';
  originalQuestion: string; text: string; sourceRefId: Id;
  presentation: Presentation; layout: Layout;
  candidate?: Candidate;
  finishSequence?: number;
  state: 'open' | 'closed';
  closedAs?: 'committed' | 'discarded' | 'superseded';
  committedRevisionId?: Id;
}
export interface CanvasSnapshot {
  format: 'timeblast-canvas'; formatVersion: typeof CANVAS_FORMAT;
  canvas: CanvasHeader; commits: CanvasCommit[]; revisions: ChartRevision[];
  sources: SourceRef[]; drafts: DraftSession[];
}
export interface DraftWrite { expectedVersion: number | null; value: DraftSession }
/** Each patch is one storage transaction. Draft writes do not contend on the canvas head. */
export interface CanvasPatch {
  canvasId: Id;
  head?: { expectedVersion: number | null; value: CanvasHeader };
  commits?: CanvasCommit[]; revisions?: ChartRevision[]; sources?: SourceRef[];
  drafts?: DraftWrite[];
}
const copy = <T>(value: T): T => structuredClone(value);

/** Synchronous document commands; the session journals returned patches asynchronously.
 * Maps retain every canvas-owned branch. Export is deliberately not a head-ancestor walk. */
export class CanvasModel {
  header: CanvasHeader;
  readonly commits = new Map<Id, CanvasCommit>();
  readonly revisions = new Map<Id, ChartRevision>();
  readonly sources = new Map<Id, SourceRef>();
  readonly drafts = new Map<Id, DraftSession>();

  constructor(snapshot: CanvasSnapshot, private readonly id: () => Id = newId, private readonly now: () => number = Date.now) {
    this.header = copy(snapshot.canvas);
    for (const record of snapshot.commits) this.commits.set(record.id, copy(record));
    for (const record of snapshot.revisions) this.revisions.set(record.id, copy(record));
    for (const record of snapshot.sources) this.sources.set(record.id, copy(record));
    for (const record of snapshot.drafts) this.drafts.set(record.id, copy(record));
  }

  static create(title = 'Untitled canvas', id: () => Id = newId, now: () => number = Date.now): CanvasModel {
    title = title.trim() || 'Untitled canvas';
    boundedText(title, CANVAS_LIMITS.title, 'Canvas title');
    const canvasId = id(), commitId = id(), at = now();
    return new CanvasModel({ format: 'timeblast-canvas', formatVersion: CANVAS_FORMAT,
      canvas: { id: canvasId, formatVersion: CANVAS_FORMAT, storeVersion: 0, createdAt: at, headCommitId: commitId, redoChoices: {} },
      commits: [{ id: commitId, canvasId, parentId: null, at, action: 'Create canvas', state: { title, charts: [] } }],
      revisions: [], sources: [], drafts: [] }, id, now);
  }

  get head(): CanvasCommit { return this.commits.get(this.header.headCommitId)!; }
  get state(): CanvasState { return this.head.state; }
  selected(chartId: Id): ChartRevision | undefined {
    const chart = this.state.charts.find(c => c.id === chartId);
    return chart ? this.revisions.get(chart.revisionId) : undefined;
  }
  snapshot(): CanvasSnapshot {
    return copy({ format: 'timeblast-canvas', formatVersion: CANVAS_FORMAT, canvas: this.header,
      commits: [...this.commits.values()], revisions: [...this.revisions.values()], sources: [...this.sources.values()], drafts: [...this.drafts.values()] });
  }
  initialPatch(): CanvasPatch {
    const s = this.snapshot();
    return { canvasId: this.header.id, head: { expectedVersion: null, value: s.canvas },
      commits: s.commits, revisions: s.revisions, sources: s.sources,
      drafts: s.drafts.map(value => ({ expectedVersion: null, value })) };
  }
  addSource(source: Omit<SourceRef, 'canvasId'>): CanvasPatch {
    if (this.sources.has(source.id)) throw new Error('Source references are immutable');
    const value: SourceRef = copy({ ...source, canvasId: this.header.id });
    this.sources.set(value.id, value);
    return { canvasId: this.header.id, sources: [copy(value)] };
  }

  startDraft(options: { chartId?: Id; sourceRefId?: Id; layout?: Layout; mode?: DraftSession['mode']; text?: string }): { draft: DraftSession; patch: CanvasPatch } {
    const chartId = options.chartId ?? this.id(), base = this.selected(chartId);
    if (options.chartId && !base) throw new Error('Chart is not in the selected canvas state');
    const mode = options.mode ?? 'question';
    if (base && options.sourceRefId !== undefined && options.sourceRefId !== base.sourceRefId && mode !== 'sql') {
      throw new Error('Changing an existing chart source requires an explicit SQL edit');
    }
    const sourceRefId = options.sourceRefId ?? base?.sourceRefId;
    if (!sourceRefId || !this.sources.has(sourceRefId)) throw new Error('Choose a source before starting a chart');
    const at = this.now(), text = options.text ?? '';
    boundedText(text, mode === 'question' || mode === 'regenerate' ? CANVAS_LIMITS.question : CANVAS_LIMITS.sql, 'Draft text');
    const draft: DraftSession = { id: this.id(), canvasId: this.header.id, chartId, baseRevisionId: base?.id ?? null,
      version: 0, sequence: 0, at, updatedAt: at, mode, text,
      originalQuestion: base?.originalQuestion ?? (mode === 'question' ? text : ''), sourceRefId,
      presentation: copy(base?.presentation ?? defaultPresentation()),
      layout: copy(this.state.charts.find(c => c.id === chartId)?.layout ?? options.layout ?? defaultLayout()), state: 'open' };
    this.drafts.set(draft.id, draft);
    return { draft: copy(draft), patch: { canvasId: this.header.id, drafts: [{ expectedVersion: null, value: copy(draft) }] } };
  }

  /** Freeze the exact displayed definition, even when newer text is already being typed.
   * The caller captures this snapshot with its runtime request, not from today's draft.
   * A fresh session must execute the SQL again; old outcomes cannot validate this capture. */
  captureDraft(captured: DraftSession, sql: string, options: { finish?: boolean } = {}): { draft: DraftSession; patch: CanvasPatch } {
    const origin = this.openDraft(captured.id);
    if (!origin || captured.canvasId !== this.header.id || captured.state !== 'open'
      || origin.chartId !== captured.chartId || origin.baseRevisionId !== captured.baseRevisionId
      || origin.sourceRefId !== captured.sourceRefId || origin.mode !== captured.mode) {
      throw new Error('The displayed draft is no longer active');
    }
    if (!Number.isSafeInteger(captured.version) || captured.version < 0 || captured.version > origin.version
      || !Number.isSafeInteger(captured.sequence) || captured.sequence < 0 || captured.sequence > origin.sequence) {
      throw new Error('The displayed draft does not match a known edit sequence');
    }
    const base = this.selected(captured.chartId);
    if ((base?.id ?? null) !== captured.baseRevisionId) throw new Error('The chart changed since this preview was displayed');
    if (base && captured.originalQuestion !== base.originalQuestion) throw new Error('The displayed draft changes the original question');
    if (!this.sources.has(captured.sourceRefId)) throw new Error('The displayed draft source is unavailable');
    boundedText(captured.originalQuestion, CANVAS_LIMITS.question, 'Original question');
    boundedText(captured.text, captured.mode === 'question' || captured.mode === 'regenerate' ? CANVAS_LIMITS.question : CANVAS_LIMITS.sql, 'Draft text');
    boundedText(sql, CANVAS_LIMITS.sql, 'SQL');
    if (!sql.trim()) throw new Error('The displayed query is empty');
    const at = this.now();
    const draft: DraftSession = { id: this.id(), canvasId: this.header.id, chartId: captured.chartId,
      baseRevisionId: captured.baseRevisionId, version: 0, sequence: 0, at, updatedAt: at,
      mode: captured.mode, originalQuestion: captured.originalQuestion, text: captured.text,
      sourceRefId: captured.sourceRefId, presentation: copy(captured.presentation), layout: copy(captured.layout),
      candidate: { sequence: 0, sql, status: 'pending' }, state: 'open',
      ...(options.finish === false ? {} : { finishSequence: 0 }) };
    const writes = this.invalidateDrafts(new Set([captured.chartId]));
    this.drafts.set(draft.id, draft);
    writes.push({ expectedVersion: null, value: copy(draft) });
    return { draft: copy(draft), patch: { canvasId: this.header.id, drafts: writes } };
  }

  updateText(draftId: Id, text: string): CanvasPatch | null {
    const d = this.openDraft(draftId);
    if (!d || d.text === text) return null;
    if (d.finishSequence !== undefined) throw new Error('Reopen the edit before changing a finished sequence');
    boundedText(text, d.mode === 'question' || d.mode === 'regenerate' ? CANVAS_LIMITS.question : CANVAS_LIMITS.sql, 'Draft text');
    return this.writeDraft(d, { text, sequence: d.sequence + 1, candidate: undefined,
      originalQuestion: d.baseRevisionId === null && d.mode === 'question' ? text : d.originalQuestion });
  }

  recordSql(draftId: Id, sequence: number, sql: string): CanvasPatch | null {
    const d = this.openDraft(draftId);
    if (!d || d.sequence !== sequence) return null;
    boundedText(sql, CANVAS_LIMITS.sql, 'SQL');
    return this.writeDraft(d, { candidate: { sequence, sql, status: 'pending' } });
  }

  outcome(draftId: Id, sequence: number, sql: string, status: Candidate['status'], error?: string): CanvasPatch | null {
    const d = this.openDraft(draftId);
    if (!d || d.sequence !== sequence || !d.candidate || d.candidate.sql !== sql || d.candidate.sequence !== sequence) return null;
    if (d.candidate.status !== 'pending') return null; // exactly one terminal outcome per candidate
    const next = this.nextDraft(d, { candidate: { sequence, sql, status, ...(error ? { error } : {}) } });
    if (status === 'succeeded' && next.finishSequence === sequence) return this.promote(d, next);
    this.drafts.set(next.id, next);
    return { canvasId: this.header.id, drafts: [{ expectedVersion: d.version, value: copy(next) }] };
  }

  finishDraft(draftId: Id): CanvasPatch | null {
    const d = this.openDraft(draftId);
    if (!d || d.finishSequence === d.sequence) return null;
    const next = this.nextDraft(d, { finishSequence: d.sequence });
    if (next.candidate?.sequence === next.sequence && next.candidate.status === 'succeeded') return this.promote(d, next);
    this.drafts.set(next.id, next);
    return { canvasId: this.header.id, drafts: [{ expectedVersion: d.version, value: copy(next) }] };
  }

  /** A resumed edit has a fresh identity; delayed callbacks cannot belong to it. */
  reopenDraft(draftId: Id): { draft: DraftSession; patch: CanvasPatch } {
    const previous = this.drafts.get(draftId);
    if (!previous) throw new Error('Draft not found');
    if (previous.baseRevisionId !== (this.selected(previous.chartId)?.id ?? null)) throw new Error('Restore the draft base before resuming this edit');
    const at = this.now();
    const next: DraftSession = { ...copy(previous), id: this.id(), version: 0, at, updatedAt: at,
      finishSequence: undefined, state: 'open', closedAs: undefined, committedRevisionId: undefined,
      candidate: previous.candidate ? { ...copy(previous.candidate), status: 'pending', error: undefined } : undefined };
    const writes: DraftWrite[] = [{ expectedVersion: null, value: copy(next) }];
    if (previous.state === 'open') {
      const closed = this.nextDraft(previous, { state: 'closed', closedAs: 'superseded' });
      this.drafts.set(closed.id, closed); writes.unshift({ expectedVersion: previous.version, value: copy(closed) });
    }
    this.drafts.set(next.id, next);
    return { draft: copy(next), patch: { canvasId: this.header.id, drafts: writes } };
  }

  /** A change typed after Enter on a refinement applies to that refinement's result.
   * Once it is checkpointed, move the waiting draft onto it: a new sequence, no candidate. */
  rebaseDraft(draftId: Id, revisionId: Id): CanvasPatch | null {
    const d = this.openDraft(draftId), base = d && this.selected(d.chartId);
    if (!d || !base || base.id !== revisionId || d.baseRevisionId === base.id || base.originalQuestion !== d.originalQuestion) return null;
    const sequence = d.sequence + 1;
    return this.writeDraft(d, { baseRevisionId: base.id, sourceRefId: base.sourceRefId, presentation: copy(base.presentation),
      sequence, candidate: undefined, ...(d.finishSequence !== undefined ? { finishSequence: sequence } : {}) });
  }
  closeDraft(draftId: Id, reason: 'discarded' | 'superseded' = 'discarded'): CanvasPatch | null {
    const d = this.openDraft(draftId);
    return d ? this.writeDraft(d, { state: 'closed', closedAs: reason }) : null;
  }
  draftPresentation(draftId: Id, presentation: Presentation): CanvasPatch | null {
    const d = this.openDraft(draftId);
    return d ? this.writeDraft(d, { presentation: copy(presentation) }) : null;
  }
  draftLayout(draftId: Id, layout: Layout): CanvasPatch | null {
    const d = this.openDraft(draftId);
    return d ? this.writeDraft(d, { layout: copy(layout) }) : null;
  }

  changePresentation(chartId: Id, presentation: Presentation): CanvasPatch {
    const previous = this.selected(chartId);
    if (!previous) throw new Error('Chart not found');
    const revision: ChartRevision = { ...copy(previous), id: this.id(), parentId: previous.id, at: this.now(),
      presentation: copy(presentation), change: { kind: 'view', text: `Presentation: ${presentation.view ?? 'Auto'}`, details: JSON.stringify(presentation) } };
    const state = copy(this.state);
    state.charts.find(c => c.id === chartId)!.revisionId = revision.id;
    return this.commit('Change chart presentation', state, [revision]);
  }
  layout(layouts: Array<{ chartId: Id; layout: Layout }>, action = 'Move / resize charts'): CanvasPatch | null {
    const state = copy(this.state); let changed = false;
    for (const { chartId, layout } of layouts) {
      const chart = state.charts.find(c => c.id === chartId);
      if (chart && JSON.stringify(chart.layout) !== JSON.stringify(layout)) { chart.layout = copy(layout); changed = true; }
    }
    return changed ? this.commit(action, state) : null;
  }
  rename(title: string): CanvasPatch | null {
    const name = title.trim() || 'Untitled canvas';
    boundedText(name, CANVAS_LIMITS.title, 'Canvas title');
    return name === this.state.title ? null : this.commit('Rename canvas', { ...copy(this.state), title: name });
  }
  removeCharts(chartIds: Id[]): CanvasPatch | null {
    const removed = new Set(chartIds), state = copy(this.state);
    state.charts = state.charts.filter(c => !removed.has(c.id));
    const drafts = this.invalidateDrafts(removed);
    if (state.charts.length === this.state.charts.length) return drafts.length ? { canvasId: this.header.id, drafts } : null;
    return this.commit(chartIds.length === 1 ? 'Delete chart' : 'Clear canvas', state, [], drafts);
  }
  restoreChart(chartId: Id, revisionId: Id): CanvasPatch {
    const revision = this.revisions.get(revisionId);
    const state = copy(this.state), chart = state.charts.find(c => c.id === chartId);
    if (!revision || revision.chartId !== chartId || !chart) throw new Error('Revision does not belong to this chart');
    chart.revisionId = revisionId;
    return this.commit('Restore chart revision', state, [], this.invalidateDrafts(new Set([chartId])));
  }
  restoreCanvas(commitId: Id): CanvasPatch {
    const old = this.commits.get(commitId);
    if (!old) throw new Error('Canvas revision not found');
    // A whole-canvas restore is authoritative even for charts whose first revision
    // has not been accepted yet. They are absent from both membership snapshots.
    const affected = new Set([...this.drafts.values()].filter(d => d.state === 'open').map(d => d.chartId));
    return this.commit('Restore canvas revision', copy(old.state), [], this.invalidateDrafts(affected), commitId);
  }
  undo(): CanvasPatch | null {
    const parent = this.head.parentId;
    if (!parent) return null;
    const redoChoices = { ...this.header.redoChoices, [parent]: this.head.id };
    return this.moveHead(parent, redoChoices);
  }
  redo(childId?: Id): CanvasPatch | null {
    const id = childId ?? (Object.hasOwn(this.header.redoChoices, this.head.id) ? this.header.redoChoices[this.head.id] : undefined);
    if (!id) return null;
    const child = this.commits.get(id);
    if (!child || child.parentId !== this.head.id) throw new Error('Choose a child of the current history state');
    return this.moveHead(id, { ...this.header.redoChoices, [this.head.id]: id });
  }
  branches(commitId = this.head.id): CanvasCommit[] { return [...this.commits.values()].filter(c => c.parentId === commitId); }
  lineage(revisionId: Id): ChartRevision[] {
    const revisions: ChartRevision[] = [];
    for (let r = this.revisions.get(revisionId); r; r = r.parentId ? this.revisions.get(r.parentId) : undefined) revisions.push(r);
    return revisions.reverse();
  }

  private openDraft(id: Id): DraftSession | undefined {
    const d = this.drafts.get(id); return d?.state === 'open' ? d : undefined;
  }
  private nextDraft(d: DraftSession, patch: Partial<DraftSession>): DraftSession {
    return { ...copy(d), ...patch, version: d.version + 1, updatedAt: this.now() };
  }
  private writeDraft(d: DraftSession, patch: Partial<DraftSession>): CanvasPatch {
    const next = this.nextDraft(d, patch); this.drafts.set(next.id, next);
    return { canvasId: this.header.id, drafts: [{ expectedVersion: d.version, value: copy(next) }] };
  }
  private promote(previous: DraftSession, next: DraftSession): CanvasPatch {
    const selected = this.selected(next.chartId);
    if ((selected?.id ?? null) !== next.baseRevisionId) {
      // Preserve exact SQL/text; never commit against a newly selected history state.
      next.finishSequence = undefined;
      next.candidate = { ...next.candidate!, status: 'failed', error: 'The chart changed. Restore this draft’s base before resuming.' };
      this.drafts.set(next.id, next);
      return { canvasId: this.header.id, drafts: [{ expectedVersion: previous.version, value: copy(next) }] };
    }
    const kind: Change['kind'] = next.mode === 'sql' ? 'sql' : next.mode === 'gesture' ? 'gesture' : next.mode === 'regenerate' ? 'regenerate' : selected ? 'refine' : 'create';
    const revision: ChartRevision = { id: this.id(), canvasId: this.header.id, chartId: next.chartId,
      parentId: next.baseRevisionId, at: this.now(), originalQuestion: next.originalQuestion,
      sourceRefId: next.sourceRefId, sql: next.candidate!.sql, presentation: copy(next.presentation), change: { kind, text: next.text } };
    const state = copy(this.state), chart = state.charts.find(c => c.id === next.chartId);
    if (chart) chart.revisionId = revision.id;
    else state.charts.push({ id: next.chartId, revisionId: revision.id, layout: copy(next.layout) });
    next.state = 'closed'; next.closedAs = 'committed'; next.committedRevisionId = revision.id;
    this.drafts.set(next.id, next);
    return this.commit(selected ? 'Revise chart' : 'Add chart', state, [revision], [{ expectedVersion: previous.version, value: copy(next) }]);
  }
  private commit(action: string, state: CanvasState, revisions: ChartRevision[] = [], drafts: DraftWrite[] = [], restoredFrom?: Id): CanvasPatch {
    const commit: CanvasCommit = { id: this.id(), canvasId: this.header.id, parentId: this.head.id, at: this.now(), action, state,
      ...(restoredFrom ? { restoredFrom } : {}) };
    const expectedVersion = this.header.storeVersion;
    this.header = { ...this.header, storeVersion: expectedVersion + 1, headCommitId: commit.id,
      redoChoices: { ...this.header.redoChoices, [this.head.id]: commit.id } };
    this.commits.set(commit.id, commit);
    for (const revision of revisions) this.revisions.set(revision.id, revision);
    return { canvasId: this.header.id, head: { expectedVersion, value: copy(this.header) },
      commits: [copy(commit)], revisions: copy(revisions), drafts };
  }
  private affected(next: CanvasState): Set<Id> {
    const before = new Map(this.state.charts.map(c => [c.id, c.revisionId]));
    const after = new Map(next.charts.map(c => [c.id, c.revisionId]));
    return new Set([...before.keys(), ...after.keys()].filter(id => before.get(id) !== after.get(id)));
  }
  private invalidateDrafts(affected: Set<Id>): DraftWrite[] {
    const writes: DraftWrite[] = [];
    for (const d of this.drafts.values()) if (d.state === 'open' && affected.has(d.chartId)) {
      const next = this.nextDraft(d, { state: 'closed', closedAs: 'superseded' });
      this.drafts.set(next.id, next); writes.push({ expectedVersion: d.version, value: copy(next) });
    }
    return writes;
  }
  private moveHead(commitId: Id, redoChoices: Record<Id, Id>): CanvasPatch {
    const target = this.commits.get(commitId)!;
    const affected = this.affected(target.state);
    for (const d of this.drafts.values()) if (d.state === 'open' && d.baseRevisionId === null) affected.add(d.chartId);
    const drafts = this.invalidateDrafts(affected);
    const expectedVersion = this.header.storeVersion;
    this.header = { ...this.header, storeVersion: expectedVersion + 1, headCommitId: commitId, redoChoices };
    return { canvasId: this.header.id, head: { expectedVersion, value: copy(this.header) }, drafts };
  }
}
