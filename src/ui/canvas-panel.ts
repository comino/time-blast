/** Durable-document chrome. Actions belong to the app/controller; this view never runs SQL. */
import type { CanvasSession } from '../canvas/session';
import type { CanvasModel, ChartRevision, DraftSession, SourceRef } from '../canvas/model';
import { CANVAS_LIMITS } from '../canvas/limits';
import { MAX_RECOVERY_BYTES } from '../canvas/recovery';
import './canvas.css';

export interface CanvasListEntry { id: string; title: string; at?: number }
type ActionResult = void | Promise<void>;
export interface CanvasPanelActions {
  listCanvases(): Promise<CanvasListEntry[]>;
  newCanvas(): ActionResult;
  openCanvas(id: string): ActionResult;
  importCanvas(raw: string): ActionResult;
  saveCopy(): ActionResult;
  rename(title: string): ActionResult;
  undo(): ActionResult;
  redo(commitId?: string): ActionResult;
  restoreCanvas(commitId: string): ActionResult;
  restoreChart(chartId: string, revisionId: string): ActionResult;
  resumeDraft(draftId: string): ActionResult;
  discardDraft(draftId: string): ActionResult;
  sourceInfo?(): { name: string; detail?: string };
  chooseSource?(): ActionResult;
  rebindChart?(chartId: string): ActionResult;
}
type Tab = 'library' | 'canvas' | 'chart' | 'drafts' | 'sources';
const TABS: Array<[Tab, string]> = [['library', 'Canvases'], ['canvas', 'Canvas history'], ['chart', 'Chart history'], ['drafts', 'Drafts'], ['sources', 'Sources']];
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const date = (at: number): string => new Date(at).toLocaleString();
const short = (text: string, length = 80): string => text.length > length ? `${text.slice(0, length)}…` : text;

/** Parent-first ordering gives branches stable step labels even with equal timestamps. */
function historyOrder<T extends { id: string; parentId: string | null; at: number }>(records: T[]): Array<{ value: T; depth: number }> {
  const ids = new Set(records.map(r => r.id)), children = new Map<string | null, T[]>();
  for (const record of records) {
    const parent = record.parentId && ids.has(record.parentId) ? record.parentId : null;
    const list = children.get(parent) ?? []; list.push(record); children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const stack = (children.get(null) ?? []).slice().reverse().map(value => ({ value, depth: 0 }));
  const out: Array<{ value: T; depth: number }> = [], visited = new Set<string>();
  while (stack.length) {
    const entry = stack.pop()!; if (visited.has(entry.value.id)) continue;
    visited.add(entry.value.id); out.push(entry);
    const next = children.get(entry.value.id) ?? [];
    for (let i = next.length - 1; i >= 0; i--) stack.push({ value: next[i], depth: entry.depth + 1 });
  }
  return out;
}
function ancestors<T extends { id: string; parentId: string | null }>(records: Map<string, T>, id?: string): Set<string> {
  const result = new Set<string>();
  for (let record = id ? records.get(id) : undefined; record && !result.has(record.id); record = record.parentId ? records.get(record.parentId) : undefined) result.add(record.id);
  return result;
}

export class CanvasPanel {
  readonly element = element('section', 'canvas-document');
  private readonly title = element('input', 'canvas-document-title');
  private readonly status = element('span', 'canvas-save-status');
  private readonly warning = element('p', 'canvas-save-warning');
  private readonly error = element('p', 'canvas-action-error');
  private readonly sourceLabel = element('span', 'canvas-default-source');
  private readonly undo: HTMLButtonElement;
  private readonly redo: HTMLButtonElement;
  private readonly branches = element('select', 'canvas-branch-select');
  private readonly historyButton: HTMLButtonElement;
  private readonly draftsButton: HTMLButtonElement;
  private readonly exportButton: HTMLButtonElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly file = element('input');
  private readonly dialog = element('dialog', 'canvas-document-dialog');
  private readonly dialogTitle = element('h2', '', 'Your canvases');
  private readonly dialogError = element('p', 'canvas-action-error');
  private readonly dialogSave = element('p', 'canvas-dialog-save');
  private readonly content = element('div', 'canvas-dialog-content');
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
  private readonly expanded = new Set<string>();
  private tab: Tab = 'library';
  private chartId?: string;
  private frame = 0;
  private busy = false;
  private destroyed = false;
  private renderedKey = '';
  private sessionId?: string;
  private library: CanvasListEntry[] = [];
  private libraryLoading = false;
  private libraryError = '';
  private libraryVersion = 0;
  private libraryRequest = 0;

  constructor(mount: HTMLElement, private readonly getSession: () => CanvasSession | null, private readonly actions: CanvasPanelActions) {
    this.element.setAttribute('aria-label', 'Saved canvas controls');
    const line = element('div', 'canvas-document-line');
    const titleForm = element('form', 'canvas-title-form');
    this.title.type = 'text'; this.title.maxLength = CANVAS_LIMITS.title;
    this.title.setAttribute('aria-label', 'Canvas title'); this.title.placeholder = 'Untitled canvas';
    this.title.title = 'Rename this canvas';
    const rename = () => {
      const session = this.getSession();
      if (session && this.title.value.trim() !== session.model.state.title && !this.busy) void this.perform(() => this.actions.rename(this.title.value));
    };
    titleForm.addEventListener('submit', event => { event.preventDefault(); rename(); this.title.blur(); });
    this.title.addEventListener('blur', rename);
    this.title.addEventListener('keydown', event => {
      if (event.key === 'Escape') { this.title.value = this.getSession()?.model.state.title ?? ''; this.title.blur(); event.stopPropagation(); }
    });
    titleForm.append(this.title); line.append(titleForm);
    this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite'); line.append(this.status);
    const libraryButton = this.button('Canvases', () => this.open('library'), 'library');
    line.append(libraryButton);

    const tools = element('div', 'canvas-document-tools');
    this.undo = this.actionButton('Undo', () => this.actions.undo(), 'undo');
    this.redo = this.actionButton('Redo', () => this.actions.redo(), 'redo');
    this.branches.setAttribute('aria-label', 'Choose a redo branch');
    this.branches.addEventListener('change', () => { const id = this.branches.value; if (id) void this.perform(() => this.actions.redo(id)); });
    this.historyButton = this.button('History', () => this.showHistory(), 'history');
    this.draftsButton = this.button('Drafts', () => this.open('drafts'), 'drafts');
    this.exportButton = this.actionButton('Export', () => this.download(), 'export');
    const importButton = this.button('Import', () => this.file.click(), 'import');
    this.allow(importButton, true);
    this.copyButton = this.actionButton('Save a copy', () => this.actions.saveCopy(), 'save-copy');
    tools.append(this.undo, this.redo, this.branches, this.historyButton, this.draftsButton, this.exportButton, importButton, this.copyButton);
    this.sourceLabel.title = 'Default source for new charts; existing charts keep their saved sources.';
    tools.append(this.sourceLabel);
    if (actions.chooseSource) tools.append(this.actionButton('Choose source', () => actions.chooseSource!(), 'choose-source'));
    this.warning.hidden = true; this.warning.setAttribute('role', 'status');
    this.error.hidden = true; this.error.setAttribute('role', 'alert');
    this.file.type = 'file'; this.file.accept = '.json,application/json'; this.file.hidden = true;
    this.file.addEventListener('change', () => {
      const file = this.file.files?.[0]; this.file.value = '';
      if (file) void this.perform(async () => {
        if (file.size > MAX_RECOVERY_BYTES) throw new Error('This canvas file exceeds the supported recovery-file size.');
        await this.actions.importCanvas(await file.text());
        this.closeDialog();
      });
    });
    this.element.append(line, tools, this.warning, this.error, this.file);
    const toolbar = mount.matches('.canvas-toolbar') ? mount : mount.querySelector('.canvas-toolbar');
    if (toolbar) toolbar.insertAdjacentElement('afterend', this.element); else mount.append(this.element);

    const heading = element('div', 'canvas-dialog-heading');
    const close = this.button('Close', () => this.closeDialog(), 'close');
    close.classList.add('canvas-dialog-close'); heading.append(this.dialogTitle, close);
    this.dialogTitle.id = `canvas-dialog-${crypto.randomUUID()}`;
    this.dialog.setAttribute('aria-labelledby', this.dialogTitle.id);
    const tabs = element('nav', 'canvas-dialog-tabs'); tabs.setAttribute('aria-label', 'Canvas document sections');
    for (const [tab, label] of TABS) {
      const button = this.button(label, () => this.open(tab), `tab-${tab}`);
      this.tabButtons.set(tab, button); tabs.append(button);
    }
    this.dialogError.hidden = true; this.dialogError.setAttribute('role', 'alert');
    this.dialogSave.hidden = true; this.dialogSave.setAttribute('role', 'status');
    this.dialog.append(heading, tabs, this.dialogSave, this.dialogError, this.content);
    document.body.append(this.dialog);
    // Escape closes this dialog without also abandoning a chart edit underneath it.
    this.dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    this.dialog.addEventListener('click', event => {
      if (event.target !== this.dialog) return;
      const box = this.dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) this.closeDialog();
    });
    this.render();
  }

  /** Coalesce document notifications without adding work to the keystroke handler. */
  update(): void {
    if (!this.destroyed && !this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
  }
  showHistory(chartId?: string): void { this.chartId = chartId; this.open(chartId ? 'chart' : 'canvas'); }
  destroy(): void {
    this.destroyed = true; this.libraryRequest++; cancelAnimationFrame(this.frame);
    this.closeDialog(); this.dialog.remove(); this.element.remove();
  }

  private button(label: string, click: () => void, action: string): HTMLButtonElement {
    const button = element('button', 'canvas-document-button', label); button.type = 'button'; button.dataset.canvasAction = action;
    button.addEventListener('click', click); return button;
  }
  private actionButton(label: string, action: () => ActionResult, name: string, allowed = true): HTMLButtonElement {
    const button = this.button(label, () => { void this.perform(action); }, name); this.allow(button, allowed); return button;
  }
  private allow(button: HTMLButtonElement, allowed: boolean): void {
    button.dataset.canvasAllowed = String(allowed); button.disabled = this.busy || !allowed;
  }
  private syncBusy(): void {
    this.element.setAttribute('aria-busy', String(this.busy)); this.dialog.setAttribute('aria-busy', String(this.busy));
    this.branches.disabled = this.busy; this.title.disabled = this.busy || !this.getSession();
    for (const root of [this.element, this.dialog]) for (const button of root.querySelectorAll<HTMLButtonElement>('button[data-canvas-allowed]')) {
      button.disabled = this.busy || button.dataset.canvasAllowed !== 'true';
    }
  }
  private setError(message: string): void {
    for (const box of [this.error, this.dialogError]) { box.textContent = message; box.hidden = !message; }
  }
  private async perform(action: () => ActionResult): Promise<void> {
    if (this.busy || this.destroyed) return;
    this.busy = true; this.setError(''); this.syncBusy();
    try { await action(); }
    catch (error) { if (!this.destroyed) this.setError(error instanceof Error ? error.message : String(error)); }
    finally { this.busy = false; if (!this.destroyed) { this.syncBusy(); this.update(); } }
  }
  private closeDialog(): void { if (this.dialog.open) this.dialog.close(); }
  private open(tab: Tab): void {
    if (this.destroyed) return;
    this.tab = tab; this.renderedKey = ''; this.render();
    if (!this.dialog.open) this.dialog.showModal();
    // Content must be populated on the first open; render() normally leaves a closed dialog alone.
    this.renderDialog();
    if (tab === 'library') void this.refreshLibrary();
  }
  private async refreshLibrary(): Promise<void> {
    const request = ++this.libraryRequest; this.libraryLoading = true; this.libraryError = ''; this.libraryVersion++; this.renderDialog();
    try {
      const list = await this.actions.listCanvases();
      if (request !== this.libraryRequest || this.destroyed) return;
      this.library = list;
    } catch (error) {
      if (request !== this.libraryRequest || this.destroyed) return;
      this.libraryError = error instanceof Error ? error.message : String(error);
    } finally {
      if (request === this.libraryRequest && !this.destroyed) { this.libraryLoading = false; this.libraryVersion++; this.renderDialog(); }
    }
  }

  private render(): void {
    if (this.destroyed) return;
    const session = this.getSession(), model = session?.model;
    const changedSession = model?.header.id !== this.sessionId;
    if (changedSession) { this.sessionId = model?.header.id; this.renderedKey = ''; this.expanded.clear(); }
    if (document.activeElement !== this.title || changedSession) this.title.value = model?.state.title ?? '';
    this.title.disabled = this.busy || !model;
    const state = session?.saveState;
    this.status.textContent = state?.state === 'error' ? 'Not saved' : state?.state === 'conflict' ? 'Changed in another tab' : state?.message ?? 'Opening canvas…';
    this.status.dataset.state = state?.state ?? 'saving';
    this.status.title = `${state?.message ?? ''}${state?.pending ? ` · ${state.pending} ${state.pending === 1 ? 'change awaits' : 'changes await'} a save acknowledgement` : ''}`;
    const failed = state?.state === 'error' || state?.state === 'conflict';
    this.warning.hidden = !failed;
    this.warning.textContent = failed ? `${state.message} Your working changes are still in this tab. Export a recovery file or save a copy before leaving.` : '';
    this.dialogSave.hidden = !state || state.state === 'saved';
    this.dialogSave.dataset.state = state?.state ?? 'saving';
    this.dialogSave.textContent = failed ? this.warning.textContent : state?.message ?? '';
    this.allow(this.undo, !!model?.head.parentId);
    const children = model?.branches() ?? [], selectedChild = model?.header.redoChoices[model.header.headCommitId];
    this.allow(this.redo, !!selectedChild && children.some(c => c.id === selectedChild));
    const branchKey = children.map(c => c.id).join('|') + `:${selectedChild ?? ''}`;
    if (this.branches.dataset.key !== branchKey) {
      this.branches.dataset.key = branchKey; this.branches.replaceChildren(element('option', '', 'Choose future…'));
      this.branches.options[0].value = '';
      for (const child of children) {
        const option = element('option', '', `${child.id === selectedChild ? 'Last visited · ' : ''}${child.action} · ${date(child.at)}`);
        option.value = child.id; this.branches.append(option);
      }
    }
    if (document.activeElement !== this.branches) this.branches.value = '';
    this.branches.hidden = children.length < 2; this.branches.disabled = this.busy;
    for (const button of [this.historyButton, this.draftsButton, this.exportButton, this.copyButton]) this.allow(button, !!session);
    this.exportButton.textContent = failed || (state?.pending ?? 0) > 0 ? 'Export recovery' : 'Export';
    const source = this.actions.sourceInfo?.();
    this.sourceLabel.textContent = source ? `New charts: ${source.name}` : 'Each chart keeps its source';
    this.sourceLabel.title = source?.detail ?? 'Changing the default source applies to new charts. Existing charts keep their source.';
    this.renderDialog();
    if (changedSession && this.dialog.open && this.tab === 'library') void this.refreshLibrary();
  }

  private renderDialog(): void {
    if (!this.dialog.open || this.destroyed) return;
    const model = this.getSession()?.model;
    if (this.tab === 'chart' && model && (!this.chartId || ![...model.revisions.values()].some(r => r.chartId === this.chartId))) {
      this.chartId = model.state.charts[0]?.id ?? model.revisions.values().next().value?.chartId;
    }
    const draftKey = this.tab === 'drafts' && model ? [...model.drafts.values()].map(d => `${d.id}:${d.version}`).join('|') : '';
    const sourceKey = this.tab === 'sources' || this.tab === 'chart' ? JSON.stringify(this.actions.sourceInfo?.()) : '';
    const key = [this.tab, this.chartId, model?.header.id, model?.header.storeVersion, model?.commits.size,
      model?.revisions.size, model?.sources.size, this.libraryVersion, draftKey, sourceKey].join(':');
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    for (const [tab, button] of this.tabButtons) { button.dataset.selected = String(tab === this.tab); button.setAttribute('aria-current', tab === this.tab ? 'page' : 'false'); }
    this.dialogTitle.textContent = TABS.find(([tab]) => tab === this.tab)![1];
    const previousScroll = this.content.scrollTop;
    this.content.replaceChildren();
    if (this.tab === 'library') this.renderLibrary(model);
    else if (!model) this.content.append(this.note('Open or create a canvas to see its history.'));
    else if (this.tab === 'canvas') this.renderCanvasHistory(model);
    else if (this.tab === 'chart') this.renderChartHistory(model);
    else if (this.tab === 'drafts') this.renderDrafts(model);
    else this.renderSources(model);
    this.content.scrollTop = previousScroll;
    this.syncBusy();
  }
  private note(text: string): HTMLParagraphElement { return element('p', 'canvas-dialog-note', text); }
  private details(key: string, label: string, ...nodes: HTMLElement[]): HTMLDetailsElement {
    const details = element('details', 'canvas-record-details'); details.dataset.recordKey = key;
    details.open = this.expanded.has(key); details.append(element('summary', '', label), ...nodes);
    details.addEventListener('toggle', () => { if (details.isConnected) { if (details.open) this.expanded.add(key); else this.expanded.delete(key); } });
    return details;
  }
  private sql(sql: string): HTMLPreElement { const pre = element('pre', 'canvas-exact-sql'); pre.append(element('code', '', sql)); return pre; }
  private label(label: string, text: string): HTMLDivElement {
    const block = element('div', 'canvas-record-field'); block.append(element('strong', '', label), element('p', '', text)); return block;
  }
  private row(title: string, subtitle: string): { row: HTMLElement; actions: HTMLElement } {
    const row = element('article', 'canvas-record'), heading = element('div', 'canvas-record-heading'), actions = element('div', 'canvas-record-actions');
    heading.append(element('h3', '', title), actions); row.append(heading, this.note(subtitle)); return { row, actions };
  }

  private renderLibrary(model?: CanvasModel): void {
    const actions = element('div', 'canvas-library-actions');
    const importButton = this.button('Import a canvas', () => this.file.click(), 'library-import'); this.allow(importButton, true);
    actions.append(this.actionButton('New canvas', () => this.actions.newCanvas(), 'new'),
      importButton,
      this.actionButton('Save current as a copy', () => this.actions.saveCopy(), 'library-copy', !!model),
      this.button('Refresh list', () => { void this.refreshLibrary(); }, 'library-refresh'));
    this.content.append(actions, this.note('Questions, SQL, layout and history are saved in this browser. Charts load their results again from their sources. Export a file to keep a portable copy.'));
    if (this.libraryLoading) this.content.append(this.note('Loading saved canvases…'));
    if (this.libraryError) this.content.append(element('p', 'canvas-action-error', this.libraryError));
    const list = new Map(this.library.map(item => [item.id, item]));
    if (model) list.set(model.header.id, { id: model.header.id, title: model.state.title, at: model.head.at });
    if (!list.size && !this.libraryLoading) this.content.append(this.note('No saved canvases yet.'));
    for (const item of [...list.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))) {
      const current = item.id === model?.header.id;
      const { row, actions } = this.row(item.title, `${current ? 'Current canvas' : 'Saved in this browser'}${item.at !== undefined ? ` · ${date(item.at)}` : ''}`);
      row.dataset.selected = String(current);
      actions.append(this.actionButton(current ? 'Open now' : 'Open', async () => { await this.actions.openCanvas(item.id); this.closeDialog(); }, 'open-canvas', !current));
      this.content.append(row);
    }
  }

  private renderCanvasHistory(model: CanvasModel): void {
    this.content.append(this.note('Restore a canvas version to recover its charts, selected revisions and positions. Every branch is retained. Results are queried again from each chart’s saved source.'));
    const ordered = historyOrder([...model.commits.values()]), step = new Map(ordered.map((entry, i) => [entry.value.id, i + 1]));
    const path = ancestors(model.commits, model.header.headCommitId), children = new Map<string, number>();
    for (const { value } of ordered) if (value.parentId) children.set(value.parentId, (children.get(value.parentId) ?? 0) + 1);
    for (const { value: commit, depth } of ordered.reverse()) {
      const current = commit.id === model.header.headCommitId;
      const branch = current ? 'Current canvas' : path.has(commit.id) ? 'On selected branch' : 'Retained branch / future';
      const subtitle = `${branch} · ${date(commit.at)}${commit.parentId ? ` · from step ${step.get(commit.parentId)}` : ' · history root'}${(children.get(commit.id) ?? 0) > 1 ? ` · ${children.get(commit.id)} branches` : ''}`;
      const { row, actions } = this.row(`Step ${step.get(commit.id)} · ${commit.action}`, subtitle);
      row.dataset.selected = String(current); row.style.setProperty('--history-depth', String(Math.min(depth, 4)));
      actions.append(this.actionButton(current ? 'Selected' : 'Restore', () => this.actions.restoreCanvas(commit.id), 'restore-canvas', !current));
      const members = element('ul', 'canvas-history-members');
      for (const chart of commit.state.charts) {
        const revision = model.revisions.get(chart.revisionId);
        members.append(element('li', '', revision?.originalQuestion || revision?.change.text || 'SQL chart'));
      }
      if (!commit.state.charts.length) members.append(element('li', '', 'Empty canvas'));
      row.append(this.details(`commit:${commit.id}`, `${commit.state.charts.length} ${commit.state.charts.length === 1 ? 'chart' : 'charts'} · ${commit.state.title}`, members));
      this.content.append(row);
    }
  }

  private renderChartHistory(model: CanvasModel): void {
    const charts = new Map<string, ChartRevision>();
    for (const revision of model.revisions.values()) if (!charts.has(revision.chartId) || revision.parentId === null) charts.set(revision.chartId, revision);
    if (!charts.size) { this.content.append(this.note('A chart’s first successful edit starts its revision history. Unfinished work is in Drafts.')); return; }
    if (!this.chartId || !charts.has(this.chartId)) this.chartId = model.state.charts[0]?.id ?? charts.keys().next().value;
    const chartId = this.chartId!, selected = model.selected(chartId);
    const picker = element('select', 'canvas-chart-picker'); picker.setAttribute('aria-label', 'Chart to inspect');
    for (const [id, revision] of charts) {
      const option = element('option', '', `${short(revision.originalQuestion || revision.change.text || 'SQL chart')}${model.selected(id) ? '' : ' · removed from current canvas'}`);
      option.value = id; picker.append(option);
    }
    picker.value = chartId; picker.addEventListener('change', () => { this.chartId = picker.value; this.renderedKey = ''; this.renderDialog(); });
    this.content.append(picker, this.note('Each revision keeps the original question, change request, exact SQL and chart presentation. Restoring one chart leaves its neighbours and position unchanged.'));
    if (!selected) this.content.append(this.note('This chart is absent from the current canvas. Restore a canvas version containing it before restoring an individual chart revision.'));
    if (this.actions.rebindChart && selected) {
      const source = model.sources.get(selected.sourceRefId), target = this.actions.sourceInfo?.();
      const rebind = element('div', 'canvas-rebind');
      rebind.append(this.note(`Chart source: ${source?.name ?? 'Unavailable'}. ${target ? `Current default: ${target.name}.` : 'Choose a default source before rebinding.'} Source replacement runs the saved SQL and keeps the previous revision.`),
        this.actionButton('Use current source', () => this.actions.rebindChart!(chartId), 'rebind-chart'));
      this.content.append(rebind);
    }
    const revisions = [...model.revisions.values()].filter(r => r.chartId === chartId), ordered = historyOrder(revisions);
    const number = new Map(ordered.map((entry, i) => [entry.value.id, i + 1])), path = ancestors(model.revisions, selected?.id);
    for (const { value: revision, depth } of ordered.reverse()) {
      const current = selected?.id === revision.id, source = model.sources.get(revision.sourceRefId);
      const branch = current ? 'Current revision' : path.has(revision.id) ? 'On selected branch' : 'Retained branch / future';
      const { row, actions } = this.row(`Revision ${number.get(revision.id)} · ${revision.change.kind}`, `${branch} · ${date(revision.at)}${revision.parentId ? ` · from revision ${number.get(revision.parentId)}` : ' · original'}`);
      row.dataset.selected = String(current); row.style.setProperty('--history-depth', String(Math.min(depth, 4)));
      actions.append(this.actionButton(current ? 'Selected' : 'Restore revision', () => this.actions.restoreChart(chartId, revision.id), 'restore-chart', !!selected && !current));
      row.append(this.label('Change request', revision.change.text || 'SQL or presentation change'),
        this.details(`revision:${revision.id}`, 'Original question, exact SQL and presentation',
          this.label('Original question', revision.originalQuestion || 'Created directly from SQL'), this.sql(revision.sql),
          this.label('Presentation', JSON.stringify(revision.presentation)), this.label('Source', source?.name ?? 'Missing source reference')));
      this.content.append(row);
    }
  }

  private renderDrafts(model: CanvasModel): void {
    this.content.append(this.note('Drafts keep unfinished questions and SQL. Resume starts a fresh edit; restoring history never silently finishes an interrupted request.'));
    const drafts = [...model.drafts.values()].filter(d => d.state === 'open' || d.closedAs === 'superseded').sort((a, b) => b.updatedAt - a.updatedAt);
    if (!drafts.length) this.content.append(this.note('No unfinished drafts.'));
    for (const draft of drafts) this.renderDraft(model, draft);
  }
  private renderDraft(model: CanvasModel, draft: DraftSession): void {
    const selected = model.selected(draft.chartId), baseMatches = (selected?.id ?? null) === draft.baseRevisionId;
    const source = model.sources.get(draft.sourceRefId);
    const state = draft.state === 'closed' ? 'Preserved after another edit or history change' : draft.finishSequence !== undefined ? 'Waiting to finish' : 'Unfinished edit';
    const { row, actions } = this.row(short(draft.text || draft.originalQuestion || 'Empty draft'), `${state} · ${source?.name ?? 'Missing source'} · ${date(draft.updatedAt)}`);
    actions.append(this.actionButton('Resume', async () => { await this.actions.resumeDraft(draft.id); this.closeDialog(); }, 'resume-draft', baseMatches));
    if (!baseMatches && draft.baseRevisionId && selected) actions.append(this.actionButton('Restore base', () => this.actions.restoreChart(draft.chartId, draft.baseRevisionId!), 'restore-draft-base'));
    if (draft.state === 'open') actions.append(this.actionButton('Discard', () => this.actions.discardDraft(draft.id), 'discard-draft'));
    if (!baseMatches) row.append(this.note(draft.baseRevisionId === null ? 'Restore a canvas version before this chart was created to resume its creation draft.' : selected ? 'Restore this draft’s base revision before resuming.' : 'Restore a canvas version containing this draft’s base before resuming.'));
    if (draft.candidate?.error) row.append(element('p', 'canvas-action-error', draft.candidate.error));
    row.append(this.details(`draft:${draft.id}`, 'Saved request and SQL', this.label('Original question', draft.originalQuestion || 'Created directly from SQL'),
      this.label('Request', draft.text), this.sql(draft.candidate?.sql ?? 'No SQL has been generated yet.'),
      this.label('Execution', draft.candidate?.status ?? 'Not started')));
    this.content.append(row);
  }

  private renderSources(model: CanvasModel): void {
    const source = this.actions.sourceInfo?.();
    this.content.append(this.note(source ? `New charts use ${source.name}. Existing chart revisions retain their own sources.` : 'Choose a default source for new charts. Each saved chart retains its own source.'));
    if (this.actions.chooseSource) this.content.append(this.actionButton('Choose default source', () => this.actions.chooseSource!(), 'sources-choose'));
    this.content.append(this.note('Result rows and uploaded file contents are not stored in the canvas. After reload, local files may need to be reattached using the chart’s source controls. To use different data, choose a default source and use “Use current source” in chart history.'));
    if (!model.sources.size) this.content.append(this.note('No chart sources have been recorded yet.'));
    for (const ref of model.sources.values()) this.renderSource(model, ref);
  }
  private renderSource(model: CanvasModel, source: SourceRef): void {
    const currentCharts = model.state.charts.filter(c => model.revisions.get(c.revisionId)?.sourceRefId === source.id).length;
    const { row } = this.row(source.name, `${source.locator.kind} · ${source.policy === 'pinned' ? 'Pinned source identity' : 'Tracks current data'} · ${currentCharts} current ${currentCharts === 1 ? 'chart' : 'charts'}`);
    if (source.locator.kind === 'file') row.append(this.note('Reattach the original file through the chart controls. A differently named copy is accepted when its contents match.'));
    const tables = element('ul', 'canvas-history-members');
    for (const table of source.tables) tables.append(element('li', '', `${table.name} · ${table.columns.length} columns`));
    row.append(this.details(`source:${source.id}`, 'Saved tables', tables)); this.content.append(row);
  }
  private download(): void {
    const session = this.getSession(); if (!session) return;
    const file = session.exportFile(), url = URL.createObjectURL(new Blob([file.content], { type: 'application/json' }));
    const anchor = element('a'); anchor.href = url; anchor.download = file.filename;
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
