import { DEFAULT_CONFIG, type AdapterStatus, type DatasetContext, type PipelineEvent, type RuntimeConfig } from '../core/types';
import { CanvasWorkspace } from './workspace';
import { shell } from './shell';
import './styles.css';
import { MAX_PROMPT_CHARS } from '../inference/plan';
import { prewarmViews } from './renderer-registry';
import { DRAFT_IDLE_MS } from '../core/scheduling';
import { BROWSER_MODEL_PROFILES, isLocalModelProfile } from '../inference/models';

export interface UICallbacks {
  onDraft(text: string, composing: boolean): void;
  onCommit(text: string): void;
  onFocus(): void;
  onConfig(config: RuntimeConfig): void;
  onCancel(): void;
  onWarmModel(): void;
  onDraw(id: string, at: number): void;
}
type Component = 'database' | 'model' | 'compiler' | 'coordinator';
const integer = new Intl.NumberFormat('en');
const date = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const syntheticDatasetIds = new Set(['synthetic-vessels-2026-09-v1', 'synthetic-vessels-2026-09-6s-v1']);

export function createUI(root: HTMLElement, callbacks: UICallbacks) {
  root.innerHTML = shell;
  const el = <T extends HTMLElement = HTMLElement>(name: string): T => root.querySelector(`[data-el="${name}"]`)!;
  const action = <T extends HTMLElement = HTMLButtonElement>(name: string): T => root.querySelector(`[data-action="${name}"]`)!;
  const input = el<HTMLTextAreaElement>('input'); input.maxLength = MAX_PROMPT_CHARS;
  const runtimeForm = el<HTMLFormElement>('runtime-form');
  (runtimeForm.elements.namedItem('translationMinChars') as HTMLInputElement).max = String(MAX_PROMPT_CHARS);
  const runtimeDialog = el<HTMLDialogElement>('runtime-dialog'), datasetDialog = el<HTMLDialogElement>('dataset-dialog');
  let config: RuntimeConfig = { ...DEFAULT_CONFIG };
  let context: DatasetContext | undefined;
  let composing = false, modelLoading = false, historyFrame = 0;
  let runtimeReady = false, destroyed = false, internalCancel = false, liveEpoch = 0;
  let lastDraft = '', lastDraftComposing = false, suppressedLiveText: string | undefined;
  let lastDraftAt = 0, liveTimer: ReturnType<typeof setTimeout> | undefined;
  const workspace = new CanvasWorkspace(root, {
    cancel: () => { cancelLiveTimer(); if (!internalCancel) suppressedLiveText = input.value; callbacks.onCancel(); },
    busy: value => showBusy(value), draw: (id, at) => callbacks.onDraw(id, at),
    added(card) {
      const id = card.id, prompt = card.prompt;
      const item = document.createElement('button'); item.className = 'history-question'; item.textContent = prompt;
      item.title = 'Focus this view on the canvas'; item.dataset.historyCard = id;
      item.addEventListener('click', () => workspace.focusById(id));
      el('history').append(item); while (el('history').children.length > 16) el('history').firstElementChild!.remove();
      scrollHistory();
    },
  });
  function scrollHistory(): void {
    if (!historyFrame) historyFrame = requestAnimationFrame(() => { historyFrame = 0; const history = el('chat-scroll'); history.scrollTop = history.scrollHeight; });
  }
  function showBusy(value: boolean): void {
    action('cancel-active').hidden = !value;
    el('submit').setAttribute('aria-label', config.liveQuery ? 'Keep this view on the canvas' : value ? 'Run a new question' : 'Run question');
    el('composer').classList.toggle('working', value);
  }
  // Runtime startup/teardown may stop work without emitting a query terminal event.
  function cancelInternally(action: () => void): void { internalCancel = true; try { action(); } finally { internalCancel = false; } }
  function setBusy(value: boolean): void { if (!value) cancelInternally(() => workspace.cancelActive('RUNTIME CHANGED')); showBusy(value); }
  function cancelLiveTimer(): void { liveEpoch++; clearTimeout(liveTimer); liveTimer = undefined; }
  function queueLive(): void {
    cancelLiveTimer();
    const text = input.value, epoch = liveEpoch;
    if (!config.liveQuery || !runtimeReady || composing || text.trim().length < config.translationMinChars || text === suppressedLiveText) return;
    // Retain the edit deadline while the runtime warms or reconnects. Draft
    // transport/model warmup are immediate, but expensive work waits for rest.
    const run = () => {
      liveTimer = undefined;
      if (destroyed || epoch !== liveEpoch || !runtimeReady || !config.liveQuery || composing || input.value !== text || suppressedLiveText === text) return;
      if (workspace.submitLive(text)) callbacks.onCommit(text);
    };
    const wait = Math.max(0, lastDraftAt + DRAFT_IDLE_MS - performance.now());
    if (wait > 0) liveTimer = setTimeout(run, Math.ceil(wait)); else queueMicrotask(run);
  }
  function draftChanged(): void {
    const text = input.value;
    // Browsers may send the final composition value twice. A duplicate draft
    // would otherwise trigger a second speculative model/database execution.
    if (text === lastDraft && composing === lastDraftComposing) return;
    cancelLiveTimer(); lastDraftAt = performance.now();
    if (text !== lastDraft) suppressedLiveText = undefined;
    if (config.liveQuery && (text !== lastDraft || composing)) cancelInternally(() => workspace.invalidateLive(text.trim().length < config.translationMinChars));
    lastDraft = text; lastDraftComposing = composing;
    callbacks.onDraft(text, composing);
    if (!composing) prewarmViews(text);
    queueLive();
  }
  function setPrompt(text: string): void { input.value = text; input.focus(); input.setSelectionRange(text.length, text.length); draftChanged(); }
  function submit(): void {
    const text = input.value; if (!text.trim() || composing) return;
    cancelLiveTimer(); suppressedLiveText = text;
    if (workspace.pinLive(text)) return;
    workspace.submit(text); callbacks.onCommit(text);
  }
  el('composer').addEventListener('submit', e => { e.preventDefault(); submit(); });
  input.addEventListener('focus', () => callbacks.onFocus());
  input.addEventListener('compositionstart', () => { composing = true; draftChanged(); });
  input.addEventListener('compositionend', () => { composing = false; draftChanged(); });
  input.addEventListener('input', draftChanged);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !composing && e.keyCode !== 229) { e.preventDefault(); submit(); } });
  root.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach(button => button.addEventListener('click', () => setPrompt(button.dataset.prompt!)));
  root.querySelector<HTMLAnchorElement>('.brand')!.addEventListener('click', e => { e.preventDefault(); input.focus(); });
  action('cancel-active').addEventListener('click', () => workspace.cancelActive());
  action('trace').addEventListener('click', () => { el('trace-panel').hidden = !el('trace-panel').hidden; action('trace').setAttribute('aria-expanded', String(!el('trace-panel').hidden)); });
  action('dataset').addEventListener('click', () => datasetDialog.showModal());
  action('close-dataset').addEventListener('click', () => datasetDialog.close());
  action('settings').addEventListener('click', () => { fillRuntime(); runtimeDialog.showModal(); });
  action('close-settings').addEventListener('click', () => runtimeDialog.close());
  for (const dialog of [runtimeDialog, datasetDialog]) dialog.addEventListener('click', e => { if (e.target === dialog) { const b = dialog.getBoundingClientRect(); if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) dialog.close(); } });
  action('warm-model').addEventListener('click', () => callbacks.onWarmModel());
  function setConfig(next: RuntimeConfig): void {
    if (JSON.stringify(next) !== JSON.stringify(config)) {
      cancelLiveTimer(); runtimeReady = false; suppressedLiveText = undefined;
      if (config.liveQuery && !next.liveQuery) workspace.pinLive(input.value);
      cancelInternally(() => workspace.cancelActive('RUNTIME CHANGED'));
      cancelInternally(() => workspace.invalidateLive(true));
    }
    config = { ...next };
    const local = next.coordinatorMode === 'browser' && next.databaseMode === 'browser' && next.inferenceMode !== 'remote';
    el('placement').lastChild!.textContent = local ? ' LOCAL FIRST' : ' HYBRID RUNTIME';
    action('speculation').setAttribute('aria-checked', String(config.speculation));
    action('live-query').setAttribute('aria-checked', String(config.liveQuery));
    el('composer-caption').textContent = config.liveQuery ? 'Live view · Enter to keep' : 'Add a view';
    el('submit-hint').textContent = config.liveQuery ? '↵ Keep this view' : '↵ Add to canvas';
    el('submit').setAttribute('aria-label', config.liveQuery ? 'Keep this view on the canvas' : 'Run question');
    el('draft-note').textContent = (config.liveQuery ? `Charts update after a 2 s pause, from ${config.translationMinChars} characters. ` : config.liveTranslation ? `Translate after a 2 s pause, from ${config.translationMinChars} characters. ` : config.speculation ? 'Prepare after a 2 s pause. ' : '')
      + (local ? 'Drafts stay in this browser.' : 'Drafts may be sent to configured remote services.');
    el('draft-state').textContent = idleDraftLabel(); el('draft-dot').dataset.state = 'quiet';
  }
  function idleDraftLabel(): string {
    return config.liveQuery ? `Live charts after 2 s · ${config.translationMinChars}+ characters` : config.liveTranslation ? `Translate after 2 s · ${config.translationMinChars}+ characters` : config.speculation ? 'Prepare after a 2 s pause' : 'Preparation paused';
  }
  action('live-query').addEventListener('click', () => { const next = { ...config, liveQuery: !config.liveQuery }; setConfig(next); callbacks.onConfig(next); });
  action('speculation').addEventListener('click', () => { const next = { ...config, speculation: !config.speculation }; setConfig(next); callbacks.onConfig(next); });
  function field(name: string): HTMLInputElement | HTMLSelectElement { return runtimeForm.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement; }
  function updateEndpointFields(): void {
    for (const name of ['coordinator', 'inference', 'database']) { const remote = field(`${name}Mode`).value === 'remote'; const endpoint = field(`${name}Endpoint`) as HTMLInputElement; endpoint.hidden = !remote; endpoint.required = remote; }
    el('inference-draft-field').hidden = field('inferenceMode').value !== 'remote';
    const browserDatabase = field('databaseMode').value === 'browser';
    el('dataset-profile-field').hidden = !browserDatabase;
    field('datasetProfile').disabled = !browserDatabase;
    const localModel = ['auto', 'webgpu'].includes(field('inferenceMode').value);
    root.querySelector<HTMLElement>('.model-load')!.hidden = !localModel;
    field('localModel').disabled = !localModel;
    field('cacheModelPlans').disabled = !localModel;
    const profile = BROWSER_MODEL_PROFILES.find(candidate => candidate.id === field('localModel').value);
    el('local-model-help').textContent = profile?.detail ?? '';
    const modelChanged = field('inferenceMode').value !== config.inferenceMode || field('localModel').value !== config.localModel;
    action<HTMLButtonElement>('warm-model').disabled = modelLoading || modelChanged || !['auto', 'webgpu'].includes(config.inferenceMode);
    action('warm-model').title = modelChanged ? 'Apply runtime before preparing this model' : 'Prepare the current local model';
    const live = (field('liveQuery') as HTMLInputElement).checked || (field('liveTranslation') as HTMLInputElement).checked;
    el('translation-threshold').hidden = !live;
    (field('translationMinChars') as HTMLInputElement).disabled = !live;
    (field('translationMinChars') as HTMLInputElement).required = live;
  }
  function fillRuntime(value = config): void {
    for (const [key, val] of Object.entries(value)) {
      if (typeof val === 'boolean') (field(key) as HTMLInputElement).checked = val;
      else field(key).value = String(val);
    }
    field('inferenceDraftEndpoint').value = value.inferenceDraftEndpoint || '';
    (field('speculation') as HTMLInputElement).checked = value.speculation; el('runtime-error').textContent = ''; updateEndpointFields();
  }
  runtimeForm.addEventListener('change', updateEndpointFields);
  action('reset-settings').addEventListener('click', () => fillRuntime(DEFAULT_CONFIG));
  runtimeForm.addEventListener('submit', e => {
    e.preventDefault();
    const liveTranslation = (field('liveTranslation') as HTMLInputElement).checked;
    const liveQuery = (field('liveQuery') as HTMLInputElement).checked;
    const minimum = (field('translationMinChars') as HTMLInputElement).valueAsNumber;
    const validMinimum = Number.isInteger(minimum) && minimum >= 1 && minimum <= MAX_PROMPT_CHARS;
    if ((liveQuery || liveTranslation) && !validMinimum) {
      el('runtime-error').textContent = `Use a whole number from 1 to ${MAX_PROMPT_CHARS} for minimum characters.`; return;
    }
    const localModel = field('localModel').value;
    if (!isLocalModelProfile(localModel)) {
      el('runtime-error').textContent = 'Choose an available browser model.'; return;
    }
    const next: RuntimeConfig = {
      coordinatorMode: field('coordinatorMode').value as RuntimeConfig['coordinatorMode'], coordinatorEndpoint: field('coordinatorEndpoint').value.trim(),
      inferenceMode: field('inferenceMode').value as RuntimeConfig['inferenceMode'], inferenceEndpoint: field('inferenceEndpoint').value.trim(),
      inferenceDraftEndpoint: field('inferenceDraftEndpoint').value.trim(),
      localModel, cacheModelPlans: (field('cacheModelPlans') as HTMLInputElement).checked,
      databaseMode: field('databaseMode').value as RuntimeConfig['databaseMode'], databaseEndpoint: field('databaseEndpoint').value.trim(),
      datasetProfile: field('datasetProfile').value as RuntimeConfig['datasetProfile'],
      speculation: (field('speculation') as HTMLInputElement).checked,
      liveQuery, liveTranslation, translationMinChars: validMinimum ? minimum : config.translationMinChars,
    };
    for (const name of ['coordinator', 'inference', 'database'] as const) if (next[`${name}Mode`] === 'remote') {
      try { const url = new URL(next[`${name}Endpoint`]); const valid = name === 'coordinator' ? ['ws:', 'wss:'] : ['http:', 'https:']; if (!valid.includes(url.protocol)) throw new Error(); }
      catch { el('runtime-error').textContent = `Use a valid ${name === 'coordinator' ? 'ws:// or wss://' : 'http:// or https://'} ${name} endpoint.`; return; }
    }
    if (next.inferenceMode === 'remote' && next.inferenceDraftEndpoint) {
      try { if (!['http:', 'https:'].includes(new URL(next.inferenceDraftEndpoint).protocol)) throw new Error(); }
      catch { el('runtime-error').textContent = 'Use a valid http:// or https:// draft endpoint, or leave it empty.'; return; }
    }
    setConfig(next); callbacks.onConfig(next); runtimeDialog.close();
  });

  function setDataset(value: DatasetContext): void {
    context = value; el('dataset-name').textContent = value.label;
    const synthetic = syntheticDatasetIds.has(value.id);
    el('dataset-badge').textContent = synthetic ? 'SYNTHETIC DATA' : 'DATASET';
    el('dataset-dialog-badge').textContent = synthetic ? 'GENERATED FIXTURE' : 'DATASET';
    el('dataset-note').textContent = synthetic ? 'Generated observations feed the query. Each chart point aggregates a time bucket and vessel group, so chart point counts differ from dataset rows.' : 'Dataset metadata supplied by the configured database.';
    el('dataset-sub').textContent = `${integer.format(value.rowCount)} observations · ${value.vessels.length} vessels`;
    el('dataset-footer').textContent = `${date.format(value.start)} — ${date.format(value.end)} · ${integer.format(value.rowCount)} observations`;
    el('dataset-description').textContent = value.description;
    const facts = el('dataset-facts'); facts.replaceChildren();
    for (const [name, detail] of [['Dataset rows', integer.format(value.rowCount)], ['Period · UTC', `${date.format(value.start)} — ${date.format(value.end)}`], ['Vessels', value.vessels.join(', ')], ['Metrics', 'Speed, wind, wave height, water temperature']]) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = detail; facts.append(dt, dd); }
  }
  function setStatus(component: Component, status: AdapterStatus): void {
    const stage = root.querySelector<HTMLElement>(`[data-stage="${component}"]`)!; stage.dataset.state = status.state;
    stage.querySelector('small')!.textContent = status.label; stage.title = status.detail || status.label;
    if (component === 'coordinator') {
      runtimeReady = status.state === 'ready';
      if (runtimeReady) queueLive();
      else { cancelLiveTimer(); cancelInternally(() => { workspace.cancelActive('RUNTIME CHANGED'); workspace.invalidateLive(true); }); }
    }
    if (component === 'database') { el('dataset-dot').dataset.state = status.state; if (!context || status.state !== 'ready') el('dataset-sub').textContent = status.label; }
    if (component === 'model') { modelLoading = status.state === 'loading'; const progress = status.progress === undefined ? '' : ` · ${Math.round(status.progress <= 1 ? status.progress * 100 : status.progress)}%`; el('model-progress').textContent = status.label + progress; updateEndpointFields(); }
  }
  function handleEvent(event: PipelineEvent): void {
    if (event.type === 'draft') { el('revision').textContent = `r.${event.revision}`; return; }
    if (event.type === 'speculation') {
      const labels = { idle: idleDraftLabel(), resolving: 'Translating your draft…', translated: config.liveQuery ? 'SQL prepared' : 'SQL prepared before Enter', querying: config.liveQuery ? 'Updating live chart…' : 'Preparing query results…', ready: `${integer.format(event.points)} points ${config.liveQuery ? 'ready' : 'staged before Enter'}`, canceled: 'Draft changed · preparing again' };
      const active = config.liveQuery || config.speculation || config.liveTranslation;
      el('draft-state').textContent = active ? labels[event.state] : 'Preparation paused';
      el('draft-dot').dataset.state = active && ['ready', 'translated'].includes(event.state) ? 'ready' : active && ['resolving', 'querying'].includes(event.state) ? 'loading' : 'quiet'; return;
    }
    if (event.type === 'trace') {
      el('trace-empty').hidden = true; const li = document.createElement('li'), name = document.createElement('span'), detail = document.createElement('span'); name.textContent = event.entry.event; detail.textContent = event.entry.detail; li.append(name, detail); el('trace-list').prepend(li); while (el('trace-list').children.length > 12) el('trace-list').lastElementChild!.remove(); return;
    }
    const liveError = workspace.isLiveActive;
    workspace.handle(event);
    if (event.type === 'error' && !event.id && !liveError) {
      const message = document.createElement('div'); message.className = 'error-message'; message.setAttribute('role', 'alert'); message.textContent = event.message;
      el('history').append(message); scrollHistory();
    }
  }
  setConfig(config);
  return { setDataset, setStatus, setConfig, handleEvent, setBusy, setPrompt,
    destroy() { destroyed = true; cancelLiveTimer(); workspace.destroy(); if (historyFrame) cancelAnimationFrame(historyFrame); root.replaceChildren(); } };
}
