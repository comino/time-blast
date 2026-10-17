/** Document/runtime bridge. Authoring is synchronous; storage acknowledgements,
 * source activation and query execution have independent lifetimes. */
import { decode, encode, header, json, Kind, readJson, type Frame } from '../protocol/frame';
import type { DatasetContext, DatasetSource, EngineToUi, InferencePlacement, PointerGesture, SlotSize, UiToEngine, ViewName } from '../engine/contracts';
import { UiController, DEFAULT_COORDINATOR_CONFIG, type CardHandlers, type CoordinatorConfig, type EnginePort, type RailView, type ResultInfo, type SlotCard, type SlotHost } from '../ui/controller';
import { DraftEncoder } from '../ui/draft-encoder';
import { VIEW_NAMES } from '../engine/render/core';
import { breakdown, type InferStats } from '../ui/timing';
import { CanvasModel, defaultLayout, newId, type DraftSession, type Id, type Layout, type Presentation, type SourceRef } from './model';
import { CanvasSession } from './session';
import { IndexedCanvasStore, type CanvasStorage } from './store';
import { SourceBindings } from './sources';
import { CANVAS_CAPABILITY, EDIT_CAPABILITY, editBase, prepareEdit, registerTarget, releaseTarget, savedQuery, type CandidateInfo, type ExecutionInfo } from './protocol';
import { boundedText, CANVAS_LIMITS } from './limits';

export interface CanvasHooks {
  changed(): void;
  editor(value: string, label: string, mode: 'question' | 'sql' | 'regenerate', focus: boolean): void;
  history(chartId?: Id): void;
  reattach(source: SourceRef): void;
  notice(message: string): void;
}
interface Attempt {
  request: number; generation: number; wire: number; sql: string;
  captured?: DraftSession; status?: ExecutionInfo['status']; error?: string;
}
interface Entry {
  chartId: Id; slot: number; card: SlotCard; generation: number;
  resident: boolean; ready: boolean; context: number; request: number; shown?: Attempt;
  revisionId?: Id; draftId?: Id; encoder?: DraftEncoder;
  attempts: Map<number, Attempt>; sent: Map<number, DraftSession>;
  status: string; presentation: Presentation; used: number; ticket: number;
  done?: () => void; gesture?: { request: number; generation: number; captured?: DraftSession; revisionId?: Id; kind: PointerGesture['kind']; at: number };
  replayingWire?: number;
  manualViewWire?: number;
  cancelCapability?: () => void;
  afterCheckpoint?: { sql: string; text: string; draftId: Id };
  /** A job for this entry is queued or preparing; it has not registered yet. */
  starting?: boolean;
  /** The next change typed after Enter on a refinement; it starts once this one resolves. */
  successor?: Id;
  /** The endpoint lacks edit-context-v1: saved SQL may run, change requests may not. */
  noEdit?: boolean;
}
/** A job runs until its work is submitted, not until it completes. `sourceId`
 * groups queued hydration by source; priority jobs (interactive edits) go first. */
interface Job { entry?: Entry; ticket?: number; sourceId?: Id; priority?: boolean; run(): Promise<void> }
const RESIDENT_LIMIT = 8;
const errorText = (e: unknown): string => e instanceof Error ? e.message : String(e);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const now = (): number => performance.now();
/** Parameters at their control defaults are not intent: playing to the end or
 * rotating back to the start does not create a revision. */
const PARAM_DEFAULTS: Record<string, number> = { playback: 1, rotation: -30 };
export function normalizePresentation(p: Presentation): Presentation {
  const params = Object.fromEntries(Object.entries(p.params).filter(([k, v]) => PARAM_DEFAULTS[k] !== v));
  return { view: p.view, params };
}

export class CanvasController extends UiController {
  session: CanvasSession | null = null;
  storage: CanvasStorage | null = null;
  defaultSourceId: Id | null = null;
  private readonly entries = new Map<Id, Entry>();
  private readonly bySlot = new Map<number, Entry>();
  /** Coordinator request id → the entry whose attempt it is (TIMING/ERROR routing). */
  private readonly byRequest = new Map<number, Entry>();
  private readonly sources = new SourceBindings();
  private readonly sessions = new Map<Id, CanvasSession>();
  private slotCounter = 1;
  private inputCounter = 0;
  private extraFrames = 0;
  private editorId?: Id;
  private readonly jobs: Job[] = [];
  private runningJob = false;
  private activeJob?: Job;
  private activeSourceId?: Id;
  private activation?: { token: string; resolve(c: DatasetContext | null): void };
  private coordinatorReady = false;
  private capabilityWait?: (ready: boolean) => void;
  private editSupported: boolean | null = null;
  private readonly editWaiters = new Set<() => void>();
  private switching = false;
  private hydrated = false;
  private initializing = true;
  private fallbackDataset?: DatasetSource;
  private sessionSubscription?: () => void;
  /** Work registered on the active source: a source switch waits for it. */
  private readonly busy = new Map<Entry, Promise<void>>();
  /** Input that arrived before the engine and a source were ready (replayed once). */
  private pendingInput?: { value: string; commit: boolean };
  /** Sources of an imported canvas that contact other hosts load only on request. */
  private readonly untrusted = new Set<Id>();
  /** The edit that failed only because inference lacked edit-context-v1. */
  private unsupportedDraft?: Id;

  constructor(private readonly engine: EnginePort, private readonly cardHost: SlotHost, private readonly canvasRail: RailView, private readonly hooks: CanvasHooks) {
    super(engine, cardHost, canvasRail, { minFree: 0 });
  }
  get model(): CanvasModel | null { return this.session?.model ?? null; }
  get editing(): DraftSession | undefined { return this.editorId ? this.model?.drafts.get(this.editorId) : undefined; }
  override get inputSequence(): number { return this.inputCounter; }
  override get sentFrames(): number { return this.drafts.sent + this.extraFrames; }
  // A durable chart can retain its original question after its SQL changes.
  // Global question-to-SQL PRIME keys cannot identify those distinct definitions.
  override get primeSuggestions(): boolean { return false; }
  override sendFrame(bytes: ArrayBuffer): void { this.extraFrames++; super.sendFrame(bytes); }
  override questionFor(request: number, _revision: number): string | undefined {
    const entry = [...this.entries.values()].find(e => e.ready && e.request === request && e.context === this.context?.id);
    if (!entry || this.activation) return undefined;
    const captured = entry.attempts.get(request)?.captured, selected = this.model?.selected(entry.chartId);
    if ((captured?.sourceRefId ?? selected?.sourceRefId) !== this.activeSourceId) return undefined;
    return captured?.originalQuestion ?? selected?.originalQuestion;
  }
  override suggested(question: string, request: number, _timeStamp: number, sql?: string, view?: ViewName): boolean {
    if (!this.model || !this.coordinatorReady || this.switching) return false;
    const entry = [...this.entries.values()].find(e => e.ready && e.request === request);
    const sourceId = entry?.attempts.get(request)?.captured?.sourceRefId ?? (entry ? this.model?.selected(entry.chartId)?.sourceRefId : undefined);
    if (!sourceId) { this.hooks.notice('The chart for this suggestion changed. Choose a current suggestion.'); return false; }
    if (!question.trim() || !sql?.trim()) { this.hooks.notice('This suggestion has no executable definition. Choose a current suggestion.'); return false; }
    try {
      boundedText(question, CANVAS_LIMITS.question, 'Question'); boundedText(sql, CANVAS_LIMITS.sql, 'SQL');
      this.finishEditor();
      const draft = this.command(m => m.startDraft({ sourceRefId: sourceId, text: question, layout: this.nextLayout() })).draft;
      if (view) this.command(m => m.draftPresentation(draft.id, { view, params: {} }));
      this.command(m => m.recordSql(draft.id, draft.sequence, sql));
      this.command(m => m.finishDraft(draft.id));
      this.editorId = draft.id; this.inputCounter++; this.sync(); this.startEditing(this.model.drafts.get(draft.id)!);
      return true;
    } catch (e) { this.notify(e); return false; }
  }
  override get liveSlot(): number | null { return this.editing ? this.entries.get(this.editing.chartId)?.slot ?? null : null; }
  override get freeSlots(): number[] { return []; }
  override get keptSlots(): number[] { return this.model?.state.charts.map(c => this.entries.get(c.id)?.slot).filter((s): s is number => s !== undefined) ?? []; }

  async initialize(inference: InferencePlacement, dataset: DatasetSource, config: CoordinatorConfig = {}, storage?: CanvasStorage | null): Promise<void> {
    this.fallbackDataset = dataset;
    let session: CanvasSession;
    try {
      this.storage = storage === undefined ? await IndexedCanvasStore.open() : storage;
      const active = await this.storage?.getActive();
      const snapshot = active ? await this.storage?.load(active) : null;
      session = snapshot ? new CanvasSession(new CanvasModel(snapshot), this.storage) : CanvasSession.create(this.storage);
    } catch (e) {
      this.hooks.notice(`Could not open the saved canvas: ${errorText(e)}. A recoverable working canvas is available.`);
      session = CanvasSession.create(null);
    }
    this.useSession(session);
    const ready = new Promise<boolean>(resolve => { this.capabilityWait = resolve; });
    const token = newId();
    const context = new Promise<DatasetContext | null>(resolve => { this.activation = { token, resolve }; });
    this.config = { ...DEFAULT_COORDINATOR_CONFIG, ...config };
    this.sendControl({ type: 'boot', inference, dataset, token });
    this.drafts.config({ ...this.config, freeSlots: [] });
    this.sendFrame(encode({ ...header(Kind.HELLO), stamps: [], payload: json({ node: 'ui', capabilities: [CANVAS_CAPABILITY] }) }).buffer as ArrayBuffer);
    if (!await ready) { this.hooks.notice('This engine does not support persistent chart targets. Update the engine to edit this canvas.'); return; }
    const initial = await context;
    if (initial) await this.rememberSource(dataset, initial);
    else this.hooks.notice('The initial source could not be loaded. Saved definitions are available; choose or reattach a source.');
    this.hydrated = true;
    this.initializing = false;
    this.sync();
    // A chart opened for editing during boot already has its edit job queued;
    // hydrating it would move that edit to Drafts and the replayed text would
    // start a new chart.
    for (const entry of [...this.entries.values()].slice(0, RESIDENT_LIMIT)) {
      if (entry.revisionId && !(this.editing?.state === 'open' && this.editing.chartId === entry.chartId)) this.hydrate(entry);
    }
    void this.pumpJobs();
    this.replayInput();
    this.hooks.changed();
  }
  /** Keystrokes typed during cold start are not lost: the latest text runs once. */
  private replayInput(): void {
    const pending = this.pendingInput; this.pendingInput = undefined;
    if (!pending || !pending.value.trim()) return;
    this.input(pending.value, false, now());
    if (pending.commit) this.commit(pending.value, now());
  }

  private useSession(session: CanvasSession): void {
    this.sessionSubscription?.();
    this.session = session; this.sessions.set(session.model.header.id, session);
    this.sessionSubscription = session.subscribe(() => this.hooks.changed());
    this.defaultSourceId = session.model.sources.keys().next().value ?? null;
    this.activeSourceId = undefined;
    this.sync(); this.hooks.changed();
  }
  private command<T>(fn: (model: CanvasModel) => T): T {
    if (!this.session) throw new Error('Canvas is opening');
    // Command's public contract permits only model-generated atomic mutations.
    const result = this.session.command(fn as Parameters<CanvasSession['command']>[0]);
    this.hooks.changed();
    return result as T;
  }
  private notify(e: unknown): void { this.hooks.notice(errorText(e)); }

  private get accepting(): boolean { return !!this.model && !!this.defaultSourceId && this.coordinatorReady && !this.switching; }
  override input(value: string, composing: boolean, timeStamp: number): boolean {
    if (!this.accepting) {
      if (!this.switching) this.pendingInput = { value, commit: this.pendingInput?.value === value && this.pendingInput.commit };
      return false;
    }
    try {
      let draft = this.editing;
      if (!draft || draft.text !== value) this.inputCounter++;
      // Enter is a decision: new text after it is the next question, never an
      // edit of the one already committed (that may still be running).
      const decided = draft && (draft.state === 'closed' || (draft.finishSequence !== undefined && draft.text !== value));
      if (!draft || decided) {
        if (!value.trim()) return false;
        const previous = draft;
        const refine = previous && previous.baseRevisionId !== null && (previous.state === 'open' || previous.closedAs === 'committed')
          && this.model!.selected(previous.chartId) ? previous : undefined;
        draft = this.command(m => m.startDraft(refine
          ? { chartId: refine.chartId, mode: refine.mode === 'gesture' ? 'question' : refine.mode, text: value }
          : { sourceRefId: this.defaultSourceId!, text: value, layout: this.nextLayout() })).draft;
        this.editorId = draft.id;
        const entry = refine ? this.entries.get(refine.chartId) : undefined;
        if (refine?.state === 'open' && entry?.draftId === refine.id && (entry.ready || entry.starting)) {
          // The committed refinement is still running: this change applies to its result.
          entry.successor = draft.id;
          this.status(entry, 'Checkpoint pending · next change follows it');
          return false;
        }
        this.sync(); this.startEditing(draft);
      } else this.command(m => m.updateText(draft!.id, value));
      draft = this.model!.drafts.get(draft.id)!;
      const entry = this.entries.get(draft.chartId)!;
      if (entry.successor === draft.id && entry.draftId !== draft.id && (entry.ready || entry.starting)) return false;
      entry.card.title(draft.originalQuestion || draft.text || 'SQL chart', draft.sequence + 1);
      if (entry.draftId !== draft.id || (!entry.ready && !entry.starting)) {
        // Stopped (Escape) or interrupted: continuing to type resumes this same edit.
        if (entry.successor === draft.id) entry.successor = undefined;
        this.startEditing(draft); return false;
      }
      if (entry.ready && entry.replayingWire !== undefined && !draft.candidate && draft.baseRevisionId && (draft.mode === 'question' || draft.mode === 'regenerate')) {
        this.startEditing(draft); return false;
      }
      if (entry.ready) return this.sendDraft(entry, draft, composing, timeStamp);
      return false;
    } catch (e) { this.notify(e); return false; }
  }
  override commit(value: string, timeStamp: number): void {
    if (!value.trim()) return;
    if (!this.accepting) { if (!this.switching) this.pendingInput = { value, commit: true }; return; }
    const d = this.editing;
    // A second Enter on text that is already committed (or pending) is not a new chart.
    if (d && d.text === value && (d.state === 'closed' ? d.closedAs === 'committed' : d.finishSequence === d.sequence)) return;
    if (!d || d.state !== 'open' || d.text !== value) this.input(value, false, timeStamp);
    if (this.editing?.text !== value) return;
    this.finishEditor(timeStamp);
  }
  /** Same checkpoint boundary for Enter and leaving the complete editor area. */
  finishEditor(timeStamp = now()): void {
    const draft = this.editing;
    if (!draft || draft.state !== 'open') return;
    if (!draft.text.trim()) {
      this.command(m => m.closeDraft(draft.id)); this.editorId = undefined;
      const e = this.entries.get(draft.chartId);
      if (e) { this.invalidate(e); e.draftId = undefined; this.document(e, 'Definition retained · Load to resume the chart'); }
      this.sync(); return;
    }
    this.command(m => m.finishDraft(draft.id));
    const entry = this.entries.get(draft.chartId);
    if (entry?.ready && entry.draftId === draft.id && this.model?.drafts.get(draft.id)?.state === 'open') {
      const current = this.model.drafts.get(draft.id)!;
      if ((current.mode === 'question' || current.mode === 'regenerate') && entry.replayingWire !== current.sequence + 1) entry.encoder?.commit(current.text, timeStamp);
    }
    this.promoted(entry);
  }
  newQuestion(): void {
    this.finishEditor(); this.editorId = undefined;
    this.hooks.editor('', 'New chart', 'question', true);
  }
  editChart(chartId: Id, mode: 'question' | 'sql' | 'regenerate' = 'question'): void {
    if (!this.model?.selected(chartId)) return;
    this.finishEditor();
    for (const open of this.model.drafts.values()) if (open.chartId === chartId && open.state === 'open') this.command(m => m.closeDraft(open.id, 'superseded'));
    const revision = this.model.selected(chartId)!;
    const text = mode === 'sql' ? revision.sql : '';
    const draft = this.command(m => m.startDraft({ chartId, mode, text })).draft;
    this.editorId = draft.id;
    this.startEditing(draft);
    this.hooks.editor(text, mode === 'sql' ? 'Edit exact SQL' : mode === 'regenerate' ? 'Regenerate from intent + revisions' : 'Refine this chart', mode, true);
    this.hooks.changed();
  }
  resumeDraft(draftId: Id): void {
    try {
      this.finishEditor();
      const draft = this.command(m => m.reopenDraft(draftId)).draft;
      this.editorId = draft.id; this.sync(); this.startEditing(draft);
      this.hooks.editor(draft.text, 'Resume saved edit', draft.mode === 'sql' || draft.mode === 'regenerate' ? draft.mode : 'question', true);
    } catch (e) { this.notify(e); }
  }
  discardDraft(draftId: Id): void {
    const draft = this.model?.drafts.get(draftId); if (!draft) return;
    this.command(m => m.closeDraft(draftId));
    if (this.editorId === draftId) this.editorId = undefined;
    const entry = this.entries.get(draft.chartId); if (entry?.draftId === draftId) this.invalidate(entry);
    this.sync(); if (entry?.revisionId) this.hydrate(entry);
  }

  private startEditing(draft: DraftSession): void {
    const entry = this.ensureEntry(draft.chartId);
    this.invalidate(entry);
    entry.draftId = draft.id; entry.presentation = structuredClone(draft.presentation);
    this.document(entry, 'Edit · preparing source', true);
    entry.starting = true;
    const ticket = entry.ticket;
    this.enqueue({ entry, ticket, sourceId: draft.sourceRefId, priority: true, run: async () => {
      if (!this.current(entry, ticket)) return;
      const source = this.model!.sources.get(draft.sourceRefId)!;
      const context = await this.activate(source, false, entry);
      if (!this.current(entry, ticket)) return;
      let current = this.model!.drafts.get(draft.id);
      if (!current || current.state !== 'open') return;
      const base = editBase(this.model!, current);
      // Every question-mode edit of a saved chart carries its base, even when it
      // starts from a saved candidate: later keystrokes are change requests.
      const needsBase = !!base && (current.mode === 'question' || current.mode === 'regenerate');
      if (needsBase) {
        await this.waitForEditCapability(entry);
        if (!this.current(entry, ticket)) return;
        if (!this.editSupported && !current.candidate?.sql) {
          this.unsupportedDraft = current.id;
          throw new Error('This inference endpoint cannot refine saved charts. Choose an endpoint with edit-context-v1 or edit the SQL directly.');
        }
      }
      current = this.model!.drafts.get(draft.id);
      if (!current || current.state !== 'open') return;
      this.register(entry, context.id);
      entry.noEdit = needsBase && !this.editSupported;
      if (needsBase && this.editSupported) this.sendFrame(prepareEdit(entry, context.id, base!));
      entry.encoder = new DraftEncoder(bytes => this.sendFrame(bytes));
      entry.encoder.context = context.id; entry.encoder.epoch = this.drafts.epoch;
      entry.encoder.setTarget(entry, current.sequence);
      const held = new Promise<void>(resolve => { entry.done = resolve; });
      this.status(entry, 'Editing · preview follows each change');
      if (current.candidate?.sql) {
        entry.encoder.setTarget(entry, current.sequence + 1, current.text);
        this.runSql(entry, current, current.candidate.sql);
      }
      else if (current.text.trim()) this.sendDraft(entry, current, false, now());
      else entry.encoder.setTarget(entry, current.sequence + 1, current.text);
      if (!current.candidate && current.finishSequence !== undefined && (current.mode === 'question' || current.mode === 'regenerate')) entry.encoder.commit(current.text, now());
      this.hold(entry, held);
    } });
  }
  private sendDraft(entry: Entry, draft: DraftSession, composing: boolean, timeStamp: number): boolean {
    if (!entry.ready || entry.draftId !== draft.id || draft.state !== 'open') return false;
    if (draft.mode === 'sql' || draft.mode === 'gesture') {
      if (!composing && draft.text.trim()) this.runSql(entry, draft, draft.mode === 'gesture' ? draft.candidate?.sql ?? draft.text : draft.text);
      return !composing;
    }
    if (entry.noEdit) {
      this.status(entry, 'This inference endpoint cannot refine saved charts · edit the SQL directly');
      return false;
    }
    entry.sent.set(draft.sequence + 1, structuredClone(draft));
    entry.replayingWire = undefined;
    while (entry.sent.size > 64) entry.sent.delete(entry.sent.keys().next().value!);
    this.status(entry, draft.finishSequence === undefined ? 'Draft · translating / running' : 'Checkpoint pending · translating / running');
    return entry.encoder!.draft(draft.text, composing, timeStamp);
  }
  private runSql(entry: Entry, draft: DraftSession | undefined, sql: string): void {
    const wire = draft ? draft.sequence + 1 : 1;
    if (entry.replayingWire === wire) return;
    entry.replayingWire = wire;
    if (draft) entry.sent.set(wire, structuredClone(draft));
    this.sendFrame(savedQuery(entry, sql, entry.context, this.drafts.epoch, wire));
    this.status(entry, draft ? 'Draft · running exact SQL' : 'Loading current data from saved SQL');
  }
  private promoted(entry?: Entry): void {
    if (!entry?.draftId || !this.model) return;
    const draft = this.model.drafts.get(entry.draftId);
    if (draft?.closedAs !== 'committed' || !draft.committedRevisionId) return;
    entry.revisionId = draft.committedRevisionId;
    entry.draftId = undefined; entry.card.keep(); this.status(entry, 'Ready · definition checkpointed');
    this.canvasRail.kept(entry.slot, draft.originalQuestion || 'SQL chart');
    entry.done?.(); entry.done = undefined;
    const following = entry.afterCheckpoint;
    entry.afterCheckpoint = undefined;
    this.hooks.changed();
    if (following?.draftId === draft.id) this.gestureDraft(entry, following.sql, following.text);
    else this.startSuccessor(entry, draft.committedRevisionId);
  }
  /** Run the change that was typed while this chart's checkpoint was pending. */
  private startSuccessor(entry: Entry, committedRevisionId?: Id): void {
    const id = entry.successor; entry.successor = undefined;
    const next = id ? this.model?.drafts.get(id) : undefined;
    if (!next || next.state !== 'open') return;
    if (committedRevisionId) this.command(m => m.rebaseDraft(next.id, committedRevisionId));
    this.startEditing(this.model!.drafts.get(next.id)!);
  }

  /** Stop all work. Chart jobs stop waiting for their source; a source the user
   * chose keeps loading. The edit stays the editor's, so typing on resumes it. */
  override cancel(): void {
    const dropped = this.jobs.splice(0);
    if (!this.initializing && this.activation && this.activeJob?.entry) { this.activation.resolve(null); this.activation = undefined; }
    for (const entry of this.entries.values()) {
      const draft = entry.draftId ? this.model?.drafts.get(entry.draftId) : undefined;
      if (draft?.candidate?.status === 'pending') this.command(m => m.outcome(draft.id, draft.sequence, draft.candidate!.sql, 'cancelled'));
      if (entry.done || entry.draftId || entry.starting) { this.invalidate(entry); this.status(entry, entry.draftId ? 'Stopped · edit can be resumed' : 'Stopped · Refresh to load current data'); }
      else if (dropped.some(j => j.entry === entry)) this.status(entry, 'Stopped · Refresh to load current data');
    }
    this.drafts.cancel(); this.hooks.changed();
  }
  override resize(slot: number, size: SlotSize): void {
    if (this.bySlot.has(slot) && size.width > 0 && size.height > 0) this.sendControl({ type: 'resize', slot, size });
  }
  override close(slot: number): void {
    const entry = this.bySlot.get(slot); if (!entry) return;
    this.command(m => m.removeCharts([entry.chartId]));
    if (this.editing?.chartId === entry.chartId) this.editorId = undefined;
    this.sync();
  }
  override clear(): void {
    if (!this.model) return;
    this.cancel(); this.command(m => m.removeCharts([...this.entries.keys()])); this.sync();
  }
  private restore(action: (m: CanvasModel) => ReturnType<CanvasModel['undo']>): void {
    if (!this.model) return;
    this.command(action);
    if (this.editing?.state !== 'open') this.editorId = undefined;
    this.sync(true); this.hooks.changed();
  }
  undo(): void { this.restore(m => m.undo()); }
  redo(id?: Id): void { this.restore(m => m.redo(id)); }
  restoreCanvas(id: Id): void { this.restore(m => m.restoreCanvas(id)); }
  restoreChart(chartId: Id, revisionId: Id): void { this.restore(m => m.restoreChart(chartId, revisionId)); }
  rename(title: string): void { this.command(m => m.rename(title)); }
  layouts(changes: Array<{ slot: number; layout: Layout }>): void {
    const committed: Array<{ chartId: Id; layout: Layout }> = [];
    for (const { slot, layout } of changes) {
      const e = this.bySlot.get(slot); if (!e) continue;
      if (e.draftId && this.model?.drafts.get(e.draftId)?.state === 'open') this.command(m => m.draftLayout(e.draftId!, layout));
      if (this.model?.selected(e.chartId)) committed.push({ chartId: e.chartId, layout });
    }
    if (committed.length) this.command(m => m.layout(committed));
  }

  private readonly cardHandlers: CardHandlers = {
    edit: (slot, mode) => { const e = this.bySlot.get(slot); if (e) this.editChart(e.chartId, mode); },
    history: slot => { const e = this.bySlot.get(slot); if (e) this.hooks.history(e.chartId); },
    refresh: slot => { const e = this.bySlot.get(slot); if (e) {
      this.finishEditor();
      const selected = this.model?.selected(e.chartId);
      if (selected) { this.untrusted.delete(selected.sourceRefId); this.hydrate(e, true); }
      else if (e.draftId) this.resumeDraft(e.draftId);
    } },
    reattach: slot => { const e = this.bySlot.get(slot), d = e?.draftId ? this.model?.drafts.get(e.draftId) : undefined;
      const id = d?.sourceRefId ?? (e ? this.model?.selected(e.chartId)?.sourceRefId : undefined);
      if (id) this.hooks.reattach(this.model!.sources.get(id)!); },
    view: (slot, view) => { const e = this.bySlot.get(slot); if (!e) return;
      e.presentation = { ...e.presentation, view }; this.persistPresentation(e);
      const draft = e.draftId ? this.model?.drafts.get(e.draftId) : undefined;
      e.manualViewWire = draft ? draft.sequence + 1 : e.shown?.wire ?? e.replayingWire ?? 1;
      if (e.ready) this.sendControl({ type: 'presentation', slot, generation: e.generation, presentation: e.presentation, manualViewRevision: e.manualViewWire }); },
    param: (slot, name, value) => { const e = this.bySlot.get(slot); if (!e?.ready) return;
      e.presentation.params[name] = value;
      this.sendControl({ type: 'param', slot, generation: e.generation, request: e.request, name, value }); },
    paramEnd: slot => { const e = this.bySlot.get(slot); if (e) this.persistPresentation(e); },
    exportCsv: slot => { const e = this.bySlot.get(slot); if (e?.ready && e.request) this.sendControl({ type: 'export', slot, generation: e.generation, request: e.request, format: 'csv' }); },
    close: slot => this.close(slot), gesture: (slot, gesture, stamp) => this.gesture(slot, gesture, stamp),
    back: (slot, stamp, afterClick) => this.back(slot, stamp, afterClick),
  };
  private persistPresentation(entry: Entry): void {
    entry.presentation = normalizePresentation(entry.presentation);
    const d = entry.draftId ? this.model?.drafts.get(entry.draftId) : undefined;
    if (d?.state === 'open') { if (!same(normalizePresentation(d.presentation), entry.presentation)) this.command(m => m.draftPresentation(d.id, entry.presentation)); }
    else {
      const selected = this.model?.selected(entry.chartId);
      if (selected && !same(normalizePresentation(selected.presentation), entry.presentation)) {
        this.command(m => m.changePresentation(entry.chartId, entry.presentation));
        entry.revisionId = this.model!.selected(entry.chartId)!.id;
      }
    }
  }

  override gesture(slot: number, gesture: PointerGesture, stamp: number): boolean {
    const e = this.bySlot.get(slot), a = e?.shown;
    if (!e?.ready || !a || e.request !== a.request || e.gesture) return false;
    const captured = a.captured ? { ...structuredClone(a.captured), presentation: structuredClone(e.presentation),
      layout: structuredClone(this.model?.state.charts.find(c => c.id === e.chartId)?.layout ?? this.model?.drafts.get(a.captured.id)?.layout ?? a.captured.layout) } : undefined;
    e.gesture = { request: a.request, generation: e.generation, captured,
      revisionId: e.revisionId, kind: gesture.kind, at: stamp };
    const send = () => this.sendControl({ type: 'manipulate', slot, request: a.request, generation: e.generation, revision: a.wire,
      epoch: this.drafts.epoch, context: this.context!.id, sql: a.sql, gesture, prepareOnly: true,
      keyAt: performance.timeOrigin + stamp, sentAt: performance.timeOrigin + now() });
    if (e.context === this.context?.id) send();
    else {
      this.finishEditor();
      const generation = e.generation, ticket = e.ticket;
      const sourceId = a.captured?.sourceRefId ?? this.model?.selected(e.chartId)?.sourceRefId;
      this.enqueue({ entry: e, ticket, sourceId, priority: true, run: async () => {
        if (!sourceId) return;
        await this.activate(this.model!.sources.get(sourceId)!, false, e);
        if (this.current(e, ticket) && e.generation === generation && e.request === a.request) send();
      } });
    }
    return true;
  }
  private onManipulated(e: Entry, message: Extract<EngineToUi, { type: 'manipulated' }>): void {
    const pending = e.gesture; e.gesture = undefined;
    if (!pending || pending.generation !== e.generation || pending.request !== message.request || !message.sql || message.from !== e.shown?.sql) return;
    const text = `${pending.kind} filter (${message.method}): ${message.sql}`;
    const selected = this.model!.selected(e.chartId);
    if (pending.captured && this.model!.drafts.get(pending.captured.id)?.state === 'open') {
      const draft = this.command(m => m.captureDraft(pending.captured!, message.from)).draft;
      this.editorId = undefined;
      this.startEditing(draft);
      e.afterCheckpoint = { sql: message.sql, text, draftId: draft.id };
    } else if (selected && selected.sql === message.from && (selected.id === pending.revisionId ||
      (pending.captured && this.model!.drafts.get(pending.captured.id)?.committedRevisionId === selected.id &&
        selected.sourceRefId === pending.captured.sourceRefId && same(selected.presentation, pending.captured.presentation)))) this.gestureDraft(e, message.sql, text);
    else this.status(e, 'Result changed before the gesture; try again');
  }
  private gestureDraft(entry: Entry, sql: string, text: string): void {
    const draft = this.command(m => m.startDraft({ chartId: entry.chartId, mode: 'gesture', text })).draft;
    this.command(m => m.recordSql(draft.id, draft.sequence, sql));
    this.command(m => m.finishDraft(draft.id));
    this.startEditing(this.model!.drafts.get(draft.id)!);
  }
  override back(slot: number, _stamp: number, _afterClick = false): void {
    const e = this.bySlot.get(slot); if (!e) return;
    const selected = this.model?.selected(e.chartId);
    // Back undoes a chart-as-query step; text and SQL edits are undone from history.
    if (selected?.parentId && selected.change.kind === 'gesture') this.restoreChart(e.chartId, selected.parentId);
  }

  private ensureEntry(chartId: Id): Entry {
    const known = this.entries.get(chartId); if (known) return known;
    const slot = this.slotCounter++, { card, canvas, size } = this.cardHost.create(slot, this.cardHandlers);
    const entry: Entry = { chartId, slot, card, generation: 0, resident: false, ready: false, context: 0, request: 0,
      attempts: new Map(), sent: new Map(), status: 'Definition · load current data', presentation: { view: null, params: {} }, used: 0, ticket: 0 };
    this.entries.set(chartId, entry); this.bySlot.set(slot, entry);
    this.sendControl({ type: 'attach', slot, canvas, size, dormant: true }, [canvas]);
    return entry;
  }
  private sync(rehydrate = false): void {
    if (!this.model) return;
    const visible = new Set(this.model.state.charts.map(c => c.id));
    const opens = [...this.model.drafts.values()].filter(d => d.state === 'open');
    for (const d of opens) visible.add(d.chartId);
    for (const e of this.entries.values()) if (!visible.has(e.chartId)) {
      this.invalidate(e, true); this.sendControl({ type: 'detach', slot: e.slot, generation: e.generation });
      e.card.destroy(); this.entries.delete(e.chartId); this.bySlot.delete(e.slot);
    }
    let loading = 0;
    for (const id of visible) {
      const e = this.ensureEntry(id), revision = this.model.selected(id);
      const open = opens.find(d => d.chartId === id);
      if (e.revisionId !== revision?.id || (e.draftId && this.model.drafts.get(e.draftId)?.state !== 'open')) {
        this.invalidate(e);
        e.revisionId = revision?.id; e.draftId = open?.id;
        e.presentation = structuredClone(open?.presentation ?? revision?.presentation ?? { view: null, params: {} });
        this.document(e, open ? 'Unfinished edit · Resume to continue' : 'Definition · load current data', !!open);
        if (rehydrate && revision && this.hydrated && loading++ < RESIDENT_LIMIT) this.hydrate(e);
      } else if (!e.revisionId && !e.draftId && open) {
        e.draftId = open.id; e.presentation = structuredClone(open.presentation); this.document(e, 'Unfinished edit · Resume to continue', true);
      } else if (rehydrate) this.document(e, e.status, !!e.draftId);
    }
  }
  private document(e: Entry, status: string, editing = false): void {
    const revision = this.model?.selected(e.chartId), draft = e.draftId ? this.model?.drafts.get(e.draftId) : undefined;
    const layout = this.model?.state.charts.find(c => c.id === e.chartId)?.layout ?? draft?.layout ?? defaultLayout();
    const question = draft?.originalQuestion ?? revision?.originalQuestion ?? '';
    e.status = status;
    e.card.document?.({ layout, presentation: e.presentation, originalQuestion: question, sql: draft?.candidate?.sql ?? revision?.sql ?? '', status, editing });
    e.card.title(question || draft?.text || 'SQL chart', draft ? draft.sequence + 1 : 0);
    e.card.keep(); e.card.status?.(status);
    e.card.drill(revision ? this.model!.lineage(revision.id).length - 1 : 0, '');
  }
  private status(e: Entry, text: string): void { e.status = text; e.card.status?.(text); }
  /** First two-column grid cell that overlaps no saved or drafted chart. */
  private nextLayout(): Layout {
    const size = defaultLayout(), taken = [...this.entries.values()].map(e => this.model?.state.charts.find(c => c.id === e.chartId)?.layout
      ?? (e.draftId ? this.model?.drafts.get(e.draftId)?.layout : undefined)).filter((l): l is Layout => !!l);
    for (let cell = 0; ; cell++) {
      const x = 24 + cell % 2 * (size.width + 24), y = 24 + Math.floor(cell / 2) * (size.height + 24);
      if (!taken.some(o => x < o.x + o.width + 12 && x + size.width + 12 > o.x && y < o.y + o.height + 12 && y + size.height + 12 > o.y)) return { ...size, x, y };
    }
  }
  private invalidate(e: Entry, release = false): void {
    e.ticket++; e.ready = false; e.request = 0; e.shown = undefined; e.gesture = undefined; e.afterCheckpoint = undefined;
    e.done?.(); e.done = undefined;
    for (const request of e.attempts.keys()) if (this.byRequest.get(request) === e) this.byRequest.delete(request);
    e.attempts.clear(); e.sent.clear(); e.encoder = undefined;
    e.cancelCapability?.(); e.cancelCapability = undefined;
    e.starting = false; e.noEdit = undefined;
    if (this.activeJob?.entry === e && this.activation) { this.activation.resolve(null); this.activation = undefined; }
    e.replayingWire = undefined;
    e.manualViewWire = undefined;
    // A new context-zero registration fences old work immediately, retaining the
    // last picture while the real source is opening. Release additionally evicts.
    if (e.generation || e.resident) {
      e.generation++;
      this.sendFrame(release ? releaseTarget(e, this.drafts.epoch) : registerTarget(e, 0, this.drafts.epoch));
      if (release) e.resident = false;
    }
  }
  private register(e: Entry, context: number): void {
    const resident = [...this.entries.values()].filter(v => v.resident && v !== e).sort((a, b) => a.used - b.used);
    while (resident.length >= RESIDENT_LIMIT) {
      const victim = resident.shift()!;
      this.invalidate(victim, true); this.status(victim, 'Definition retained · Load to view current data');
    }
    e.generation++; e.context = context; e.ready = true; e.resident = true; e.used = now(); e.starting = false;
    this.sendFrame(registerTarget(e, context, this.drafts.epoch));
    this.sendControl({ type: 'presentation', slot: e.slot, generation: e.generation, presentation: e.presentation });
  }
  private current(e: Entry, ticket: number): boolean { return this.entries.get(e.chartId) === e && e.ticket === ticket; }
  private hydrate(e: Entry, reload = false): void {
    const revision = this.model?.selected(e.chartId); if (!revision) return;
    if (this.untrusted.has(revision.sourceRefId)) {
      // An imported file chose this host: contact it only when the user asks.
      const locator = this.model!.sources.get(revision.sourceRefId)!.locator;
      const host = locator.kind === 'url' ? locator.url : locator.kind === 'remote' ? locator.endpoint : '';
      let name = host; try { name = new URL(host, location.href).host; } catch { /* keep the raw locator */ }
      this.document(e, `Imported · loads from ${name} · Refresh to load`); return;
    }
    if (this.editing?.state === 'open' && this.editing.chartId === e.chartId) {
      this.editorId = undefined;
      this.hooks.editor('', 'New chart · previous edit is in Drafts', 'question', false);
    }
    this.invalidate(e); e.draftId = undefined; e.revisionId = revision.id;
    e.presentation = structuredClone(revision.presentation); this.document(e, 'Waiting to load current data');
    const ticket = e.ticket;
    this.enqueue({ entry: e, ticket, sourceId: revision.sourceRefId, run: async () => {
      const context = await this.activate(this.model!.sources.get(revision.sourceRefId)!, reload, e);
      const selected = this.model?.selected(e.chartId);
      if (!this.current(e, ticket) || !selected || selected.sql !== revision.sql || selected.sourceRefId !== revision.sourceRefId) return;
      // A picker change while loading appends a presentation revision. Its SQL is
      // still this hydration job's definition, with the newly selected settings.
      e.revisionId = selected.id; e.presentation = structuredClone(selected.presentation);
      e.card.presentation?.(e.presentation);
      this.register(e, context.id);
      const finished = new Promise<void>(resolve => { e.done = resolve; });
      this.runSql(e, undefined, revision.sql);
      this.hold(e, finished);
    } });
  }
  private enqueue(job: Job): void {
    this.jobs.push(job);
    void this.pumpJobs();
  }
  /** Interactive edits first, then work on the source that is already open. */
  private nextJob(): Job {
    let i = this.jobs.findIndex(j => j.priority);
    if (i < 0) i = this.jobs.findIndex(j => j.sourceId !== undefined && j.sourceId === this.activeSourceId);
    return this.jobs.splice(Math.max(0, i), 1)[0];
  }
  /** `entry` keeps the active source until `work` settles (or is invalidated). */
  private hold(entry: Entry, work: Promise<void>): void {
    this.busy.set(entry, work);
    void work.then(() => { if (this.busy.get(entry) === work) this.busy.delete(entry); });
  }
  private async pumpJobs(): Promise<void> {
    if (this.runningJob || this.initializing) return;
    this.runningJob = true;
    try {
      while (this.jobs.length) {
        const job = this.nextJob();
        if (job.entry && !this.current(job.entry, job.ticket!)) continue;
        this.activeJob = job;
        try { await job.run(); }
        catch (e) {
          if (!job.entry || this.current(job.entry, job.ticket!)) {
            if (job.entry) { job.entry.ready = false; job.entry.starting = false; this.status(job.entry, errorText(e)); job.entry.done?.(); job.entry.done = undefined; }
            this.notify(e);
          }
        }
      }
    } finally { this.activeJob = undefined; this.runningJob = false; if (this.jobs.length) void this.pumpJobs(); }
  }
  private async activate(source: SourceRef, reload = false, self?: Entry): Promise<DatasetContext> {
    if (!reload && this.activeSourceId === source.id && this.context) return this.context;
    const dataset = this.sources.resolve(source), owner = this.model?.header.id;
    await this.quiesce(self);
    const context = await this.load(dataset);
    if (owner !== this.model?.header.id) throw new Error('Canvas changed while the source was loading');
    if (!context) throw new Error(`Could not load ${source.name}. Its definition and SQL are retained.`);
    this.activeSourceId = source.id;
    return context;
  }
  private async rememberSource(source: DatasetSource, context: DatasetContext): Promise<void> {
    const owner = this.model?.header.id;
    const ref = await this.sources.describe(source, context);
    if (owner !== this.model?.header.id) return;
    const existing = [...this.model!.sources.values()].find(s => same(s.locator, ref.locator) && same(s.tables, ref.tables) && s.format === ref.format);
    if (!existing) this.command(m => m.addSource(ref));
    else if (source.kind === 'file') await this.sources.reattach(existing, source.file);
    this.fallbackDataset = source;
    this.defaultSourceId = existing?.id ?? ref.id;
    this.activeSourceId = this.defaultSourceId;
    this.hooks.changed();
  }
  /** Loading a source changes the engine context and cancels its queries:
   * wait until registered work on the current source has settled. */
  private async quiesce(self?: Entry): Promise<void> {
    for (;;) {
      const others = [...this.busy].filter(([e]) => e !== self).map(([, work]) => work);
      if (!others.length) return;
      await Promise.race(others);
    }
  }
  private load(dataset: DatasetSource): Promise<DatasetContext | null> {
    const token = newId();
    this.activeSourceId = undefined;
    return new Promise<DatasetContext | null>(resolve => {
      this.activation = { token, resolve }; this.sendControl({ type: 'dataset', source: dataset, token });
    });
  }
  override setDataset(source: DatasetSource): void {
    this.finishEditor();
    const owner = this.model?.header.id;
    this.enqueue({ priority: true, run: async () => {
      if (owner !== this.model?.header.id) return;
      await this.quiesce();
      if (owner !== this.model?.header.id) return;
      const context = await this.load(source);
      if (owner !== this.model?.header.id) return;
      if (context) await this.rememberSource(source, context);
      else throw new Error(`Could not load ${source.name}`);
    } });
  }
  async reattach(sourceId: Id, file: File): Promise<void> {
    const source = this.model?.sources.get(sourceId); if (!source) throw new Error('Source not found');
    await this.sources.reattach(source, file);
    for (const entry of this.entries.values()) if (this.model?.selected(entry.chartId)?.sourceRefId === sourceId) this.hydrate(entry);
    this.hooks.notice(`Reattached ${source.name}. Charts keep their original table names.`);
  }
  rebindChart(chartId: Id): void {
    if (!this.defaultSourceId || !this.model?.selected(chartId)) return;
    this.finishEditor();
    for (const open of this.model.drafts.values()) if (open.chartId === chartId && open.state === 'open') this.command(m => m.closeDraft(open.id, 'superseded'));
    const revision = this.model.selected(chartId)!;
    const draft = this.command(m => m.startDraft({ chartId, sourceRefId: this.defaultSourceId!, mode: 'sql', text: revision.sql })).draft;
    this.command(m => m.finishDraft(draft.id));
    this.startEditing(this.model.drafts.get(draft.id)!);
  }
  private async waitForEditCapability(entry: Entry): Promise<void> {
    if (this.editSupported !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.editWaiters.delete(done); resolve(); }, 15000);
      const done = () => { clearTimeout(timer); this.editWaiters.delete(done); resolve(); };
      this.editWaiters.add(done);
      entry.cancelCapability = done;
    });
    entry.cancelCapability = undefined;
  }
  override setInference(placement: InferencePlacement): void { this.editSupported = null; super.setInference(placement); }

  async listCanvases(): Promise<Array<{ id: Id; title: string; at: number }>> {
    const all = new Map<Id, { id: Id; title: string; at: number }>();
    for (const header of await this.storage?.list() ?? []) {
      try { const snapshot = await this.storage!.load(header.id); if (snapshot) all.set(header.id, { id: header.id,
        title: snapshot.commits.find(c => c.id === header.headCommitId)?.state.title ?? 'Canvas', at: header.createdAt }); } catch { /* retain damaged document in storage */ }
    }
    for (const session of this.sessions.values()) all.set(session.model.header.id, { id: session.model.header.id, title: session.model.state.title, at: session.model.header.createdAt });
    return [...all.values()];
  }
  async newCanvas(): Promise<void> { await this.switchTo(() => CanvasSession.create(this.storage)); }
  async openCanvas(id: Id): Promise<void> {
    await this.switchTo(async () => {
      const local = this.sessions.get(id); if (local) return local;
      const saved = await this.storage?.load(id); if (!saved) throw new Error('Canvas not found');
      return new CanvasSession(new CanvasModel(saved), this.storage);
    });
  }
  async importCanvas(raw: string): Promise<void> { await this.switchTo(() => CanvasSession.import(this.storage, raw), true); }
  async saveCopy(): Promise<void> { if (this.session) { const raw = this.session.exportFile().content; await this.switchTo(() => CanvasSession.import(this.storage, raw)); } }
  private async switchTo(load: () => CanvasSession | Promise<CanvasSession>, imported = false): Promise<void> {
    if (this.switching) return;
    this.switching = true;
    try {
      this.finishEditor();
      const previous = this.session;
      // A stalled IndexedDB write cannot lock the app; unsaved work stays in `sessions`.
      await Promise.race([previous?.settled(), new Promise(resolve => setTimeout(resolve, 5000))]);
      const next = await load();
      this.cancel(); this.editorId = undefined; this.pendingInput = undefined;
      for (const e of this.entries.values()) { this.invalidate(e, true); this.sendControl({ type: 'detach', slot: e.slot, generation: e.generation }); e.card.destroy(); }
      this.entries.clear(); this.bySlot.clear(); this.busy.clear();
      this.canvasRail.clearKept?.();
      this.untrusted.clear();
      if (imported) for (const source of next.model.sources.values()) if (source.locator.kind === 'url' || source.locator.kind === 'remote') this.untrusted.add(source.id);
      if (previous && previous !== next && previous.saveState.state === 'saved') {
        previous.close(); this.sessions.delete(previous.model.header.id);
      }
      this.useSession(next);
      await next.settled();
      if (next.saveState.state === 'saved') await this.storage?.setActive(next.model.header.id);
      for (const e of [...this.entries.values()].slice(0, RESIDENT_LIMIT)) if (e.revisionId) this.hydrate(e);
      if (!this.defaultSourceId && this.fallbackDataset) this.setDataset(this.fallbackDataset);
      this.hooks.editor('', 'New chart', 'question', false);
    } finally { this.switching = false; this.hooks.changed(); }
  }

  override receive(message: EngineToUi): void {
    if (message.type === 'context') {
      super.receive(message); return;
    }
    if (message.type === 'activation') {
      if (this.activation?.token === message.token) { const pending = this.activation; this.activation = undefined; pending.resolve(message.context); }
      return;
    }
    if (message.type === 'capabilities') {
      this.editSupported = message.capabilities.includes(EDIT_CAPABILITY);
      for (const done of this.editWaiters) done();
      const draft = this.editing, entry = draft ? this.entries.get(draft.chartId) : undefined;
      if (this.editSupported && draft?.state === 'open' && draft.id === this.unsupportedDraft && entry && !entry.ready && !entry.starting) {
        this.unsupportedDraft = undefined; this.startEditing(draft);
      }
      this.hooks.changed(); return;
    }
    if (message.type === 'frame') {
      let frame: Frame; try { frame = decode(new Uint8Array(message.bytes)); } catch { return; }
      if (!this.onFrame(frame)) this.frame(frame); // decoded once
      return;
    }
    if ('slot' in message) {
      const e = this.bySlot.get(message.slot);
      if (!e?.ready || message.generation !== e.generation || message.request !== e.request) return;
      switch (message.type) {
        case 'views': e.card.views(message.available, message.chosen, message.columns); e.shown = e.attempts.get(e.request); break;
        case 'axes': e.card.axes(message.ticks); break;
        case 'table': e.card.table(message.columns, message.rows, message.total); break;
        case 'export': this.cardHost.download(message.blob, message.filename); break;
        case 'manipulated': this.onManipulated(e, message); break;
      }
    }
  }
  private onFrame(frame: Frame): boolean {
    if (frame.kind === Kind.READY) {
      const info = readJson<{ capabilities?: string[] }>(frame.payload);
      this.coordinatorReady = info.capabilities?.includes(CANVAS_CAPABILITY) ?? false;
      this.capabilityWait?.(this.coordinatorReady); this.capabilityWait = undefined; return true;
    }
    if (frame.kind === Kind.CANDIDATE || frame.kind === Kind.EXECUTION) {
      const info = readJson<CandidateInfo & ExecutionInfo>(frame.payload), e = this.bySlot.get(info.slot);
      if (!e?.ready || e.generation !== info.generation || e.context !== frame.context) return true;
      const draft = e.draftId ? this.model?.drafts.get(e.draftId) : undefined;
      if (frame.kind === Kind.CANDIDATE) {
        let a = e.attempts.get(frame.request);
        if (!a || a.wire !== frame.revision) {
          a = { request: frame.request, generation: e.generation, wire: frame.revision, sql: info.sql, captured: e.sent.get(frame.revision) };
          e.attempts.set(frame.request, a); this.byRequest.set(frame.request, e);
          if (draft?.state === 'open' && draft.sequence + 1 === frame.revision) this.command(m => m.recordSql(draft.id, draft.sequence, info.sql));
        }
      } else {
        const a = e.attempts.get(frame.request);
        if (a && a.wire === frame.revision) {
          if (a.status) return true;
          a.status = info.status;
          if (draft?.state === 'open' && draft.sequence + 1 === frame.revision) this.command(m => m.outcome(draft.id, draft.sequence, a.sql, info.status, a.error));
        }
        const current = draft && this.model?.drafts.get(draft.id);
        if (!draft || draft.sequence + 1 === frame.revision) {
          this.status(e, info.status === 'succeeded' ? draft ? 'Draft succeeded · Enter / leave editor to checkpoint' : 'Ready · current data' : `Query ${info.status} · definition and draft retained`);
          this.promoted(e);
          if (!draft || current?.finishSequence !== undefined) { e.done?.(); e.done = undefined; }
          if (current?.state === 'open' && current.finishSequence !== undefined && info.status !== 'succeeded') this.startSuccessor(e);
        }
      }
      return true;
    }
    if (frame.kind === Kind.BIND && frame.payload.byteLength === 12) {
      const p = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength), e = this.bySlot.get(p.getUint32(0, true));
      if (e?.ready && e.generation === p.getUint32(8, true) && e.context === frame.context) {
        e.request = frame.request; e.used = now();
        const viewCode = p.getUint32(4, true), view = viewCode === 255 ? null : VIEW_NAMES[viewCode];
        if (view !== undefined) {
          const attempt = e.attempts.get(frame.request);
          const draft = e.draftId ? this.model?.drafts.get(e.draftId) : undefined;
          if (draft?.state === 'open' && draft.sequence + 1 === frame.revision) {
            if (e.manualViewWire === undefined || frame.revision > e.manualViewWire) {
              e.presentation = { ...e.presentation, view }; this.persistPresentation(e); e.card.presentation?.(e.presentation);
            }
            if (attempt?.captured) attempt.captured.presentation = structuredClone(e.presentation);
          } else if (attempt?.captured) {
            attempt.captured.presentation = { ...attempt.captured.presentation, view: e.manualViewWire !== undefined && frame.revision <= e.manualViewWire ? e.presentation.view : view };
          }
        }
      }
      return true;
    }
    if (frame.kind === Kind.RESULT) {
      const info = readJson<ResultInfo>(frame.payload), e = this.bySlot.get(info.slot);
      if (e?.ready && e.request === frame.request && e.context === frame.context) {
        e.card.result(info, frame.request); e.shown = e.attempts.get(frame.request); e.card.status?.(e.status);
        this.observer?.(frame);
      }
      return true;
    }
    if (frame.kind === Kind.KEEP || frame.kind === Kind.UNBIND || frame.kind === Kind.REGISTER_TARGET || frame.kind === Kind.RELEASE_TARGET) return true;
    const e = this.byRequest.get(frame.request);
    if (e?.ready && e.attempts.has(frame.request)) {
      if (frame.kind === Kind.TIMING) e.card.timing(breakdown(frame.stamps, frame.request, frame.revision));
      if (frame.kind === Kind.INFER_STATS) e.card.inferStats(readJson<InferStats>(frame.payload));
      if (frame.kind === Kind.ERROR) {
        const error = readJson<{ code: string; message: string }>(frame.payload), a = e.attempts.get(frame.request)!;
        a.error = error.message; if (e.request === frame.request) e.card.error(error);
      }
    }
    return false;
  }
  private sendControl(message: UiToEngine, transfer?: Transferable[]): void { this.engine.postMessage(message, transfer); }
}
