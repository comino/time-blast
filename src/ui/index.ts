import { DEFAULT_CONFIG, METRIC_LABELS, type AdapterStatus, type DatasetContext, type PipelineEvent, type QueryTiming, type QueryView, type RuntimeConfig } from '../core/types';
import { SERIES_COLORS, StreamChart, TrackChart, type BatchProgress } from './chart';
import { shell } from './shell';
import './styles.css';
import { MAX_PROMPT_CHARS } from '../inference/plan';

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
const fmt = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('en');
const date = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const syntheticDatasetIds = new Set(['synthetic-vessels-2026-09-v1', 'synthetic-vessels-2026-09-6s-v1']);

export function createUI(root: HTMLElement, callbacks: UICallbacks) {
  root.innerHTML = shell;
  const elements = new Map<string, HTMLElement>(), actions = new Map<string, HTMLElement>();
  const el = <T extends HTMLElement = HTMLElement>(name: string): T => {
    let element = elements.get(name);
    if (!element) { element = root.querySelector<HTMLElement>(`[data-el="${name}"]`)!; elements.set(name, element); }
    return element as T;
  };
  const action = <T extends HTMLElement = HTMLButtonElement>(name: string): T => {
    let element = actions.get(name);
    if (!element) { element = root.querySelector<HTMLElement>(`[data-action="${name}"]`)!; actions.set(name, element); }
    return element as T;
  };
  const input = el<HTMLTextAreaElement>('input');
  input.maxLength = MAX_PROMPT_CHARS;
  const runtimeForm = el<HTMLFormElement>('runtime-form');
  (runtimeForm.elements.namedItem('translationMinChars') as HTMLInputElement).max = String(MAX_PROMPT_CHARS);
  const runtimeDialog = el<HTMLDialogElement>('runtime-dialog');
  const datasetDialog = el<HTMLDialogElement>('dataset-dialog');
  let config: RuntimeConfig = { ...DEFAULT_CONFIG };
  let context: DatasetContext | undefined, current: QueryView | undefined;
  let canceledId: string | undefined;
  let completedId: string | undefined;
  let composing = false, awaitingStart = false, modelLoading = false, sum = 0, count = 0, total = 0, minimum = Infinity, maximum = -Infinity, batchCount = 0;
  let tableFrame = 0, historyFrame = 0;
  const seenSeries = new Set<number>();
  const chart = new StreamChart(el<HTMLCanvasElement>('chart'), (id, at) => {
    callbacks.onDraw(id, at);
    if (current?.id === id) { current.timing.firstDrawAt = at; updateTiming(current.timing); }
  }, updateProgress, reordered => track.indexed(reordered), id => {
    if (id === current?.id) updateCompletionState();
  });
  const track = new TrackChart(el<HTMLCanvasElement>('track'));

  function updateProgress(progress: BatchProgress): void {
    sum += progress.sum; count += progress.count;
    minimum = Math.min(minimum, progress.minimum); maximum = Math.max(maximum, progress.maximum);
    let legendChanged = false;
    for (const series of progress.series) if (!seenSeries.has(series)) { seenSeries.add(series); legendChanged = true; }
    track.progress(progress);
    el('mean').textContent = count ? fmt.format(sum / count) : '—';
    el('range').textContent = count ? `${fmt.format(minimum)} — ${fmt.format(maximum)}` : '—';
    if (legendChanged) renderLegend();
  }

  function updateCompletionState(): void {
    if (!current || completedId !== current.id || canceledId === current.id || awaitingStart) return;
    const complete = !total || chart.isSettled;
    setBusy(!complete);
    setResultState(complete ? total ? 'COMPLETE' : 'EMPTY RESULT' : 'DRAWING', complete ? 'ready' : 'loading');
  }

  function scrollHistory(): void {
    if (!historyFrame) historyFrame = requestAnimationFrame(() => {
      historyFrame = 0; const history = el('chat-scroll'); history.scrollTop = history.scrollHeight;
    });
  }

  function setBusy(value: boolean): void {
    action('cancel').hidden = !value;
    el('submit').setAttribute('aria-label', value ? 'Run a new question' : 'Run question');
    el('composer').classList.toggle('working', value);
  }
  function setPrompt(text: string): void {
    input.value = text; input.focus(); input.setSelectionRange(text.length, text.length); callbacks.onDraft(text, false);
  }
  function submit(): void {
    const text = input.value; if (!text.trim() || composing) return;
    completedId = undefined;
    el('empty-title').textContent = 'Following your question…';
    if (!current) el('empty-detail').textContent = 'Preparing a validated query.';
    awaitingStart = true; setBusy(true); callbacks.onCommit(text);
  }
  el('composer').addEventListener('submit', e => { e.preventDefault(); submit(); });
  input.addEventListener('focus', () => callbacks.onFocus());
  input.addEventListener('compositionstart', () => { composing = true; callbacks.onDraft(input.value, true); });
  input.addEventListener('compositionend', () => { composing = false; callbacks.onDraft(input.value, false); });
  input.addEventListener('input', () => callbacks.onDraft(input.value, composing));
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !composing && e.keyCode !== 229) { e.preventDefault(); submit(); } });
  root.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach(button => button.addEventListener('click', () => setPrompt(button.dataset.prompt!)));
  root.querySelector<HTMLAnchorElement>('.brand')!.addEventListener('click', e => { e.preventDefault(); input.focus(); });
  action('cancel').addEventListener('click', () => {
    awaitingStart = false; completedId = undefined; canceledId = current?.id; chart.stop(); track.stop(); callbacks.onCancel(); setBusy(false); setResultState('CANCELED', 'quiet');
    if (!total) { el('plot-empty').hidden = false; el('empty-title').textContent = 'Query canceled.'; el('empty-detail').textContent = 'Your next question starts a fresh result.'; }
    else el('plot-subtitle').textContent = 'Canceled · partial result';
  });

  function setTab(tab: string): void {
    root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => { const selected = button.dataset.tab === tab; button.classList.toggle('active', selected); button.setAttribute('aria-selected', String(selected)); });
    el('plot-container').hidden = tab !== 'chart'; el('table-wrap').hidden = tab !== 'table'; if (tab === 'table') renderTable();
    chart.setVisible(tab === 'chart');
  }
  root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.addEventListener('click', () => setTab(button.dataset.tab!)));
  action('sql').addEventListener('click', () => { el('sql-panel').hidden = !el('sql-panel').hidden; action('sql').setAttribute('aria-expanded', String(!el('sql-panel').hidden)); });
  action('trace').addEventListener('click', () => { el('trace-panel').hidden = !el('trace-panel').hidden; action('trace').setAttribute('aria-expanded', String(!el('trace-panel').hidden)); });
  action('dataset').addEventListener('click', () => datasetDialog.showModal());
  action('close-dataset').addEventListener('click', () => datasetDialog.close());
  action('settings').addEventListener('click', () => { fillRuntime(); runtimeDialog.showModal(); });
  action('close-settings').addEventListener('click', () => runtimeDialog.close());
  for (const dialog of [runtimeDialog, datasetDialog]) dialog.addEventListener('click', e => { if (e.target === dialog) { const b = dialog.getBoundingClientRect(); if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) dialog.close(); } });
  action('warm-model').addEventListener('click', () => callbacks.onWarmModel());

  function setConfig(next: RuntimeConfig): void {
    config = { ...next };
    const local = next.coordinatorMode === 'browser' && next.databaseMode === 'browser' && next.inferenceMode !== 'remote';
    el('placement').lastChild!.textContent = local ? ' LOCAL FIRST' : ' HYBRID RUNTIME';
    action('speculation').setAttribute('aria-checked', String(config.speculation));
    el('draft-note').textContent = (config.liveTranslation ? `Translate each edit from ${config.translationMinChars} characters. ` : '')
      + (local ? 'Drafts stay in this browser.' : 'Drafts may be sent to configured remote services.');
    el('draft-state').textContent = idleDraftLabel(); el('draft-dot').dataset.state = 'quiet';
  }
  function idleDraftLabel(): string {
    return config.liveTranslation ? `Translation starts at ${config.translationMinChars} characters` : config.speculation ? 'Ready when you are' : 'Preparation paused';
  }
  action('speculation').addEventListener('click', () => { const next = { ...config, speculation: !config.speculation }; setConfig(next); callbacks.onConfig(next); });
  function field(name: string): HTMLInputElement | HTMLSelectElement { return runtimeForm.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement; }
  function updateEndpointFields(): void {
    for (const name of ['coordinator', 'inference', 'database']) { const remote = field(`${name}Mode`).value === 'remote'; const endpoint = field(`${name}Endpoint`) as HTMLInputElement; endpoint.hidden = !remote; endpoint.required = remote; }
    el('inference-draft-field').hidden = field('inferenceMode').value !== 'remote';
    const browserDatabase = field('databaseMode').value === 'browser';
    el('dataset-profile-field').hidden = !browserDatabase;
    field('datasetProfile').disabled = !browserDatabase;
    root.querySelector<HTMLElement>('.model-load')!.hidden = !['auto', 'webgpu'].includes(field('inferenceMode').value);
    action<HTMLButtonElement>('warm-model').disabled = modelLoading || field('inferenceMode').value !== config.inferenceMode || !['auto', 'webgpu'].includes(config.inferenceMode);
    action('warm-model').title = field('inferenceMode').value !== config.inferenceMode ? 'Apply runtime before preparing this model' : 'Prepare the current local model';
    const live = (field('liveTranslation') as HTMLInputElement).checked;
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
    const minimum = (field('translationMinChars') as HTMLInputElement).valueAsNumber;
    const validMinimum = Number.isInteger(minimum) && minimum >= 1 && minimum <= MAX_PROMPT_CHARS;
    if (liveTranslation && !validMinimum) {
      el('runtime-error').textContent = `Use a whole number from 1 to ${MAX_PROMPT_CHARS} for minimum characters.`; return;
    }
    const next: RuntimeConfig = {
      coordinatorMode: field('coordinatorMode').value as RuntimeConfig['coordinatorMode'], coordinatorEndpoint: field('coordinatorEndpoint').value.trim(),
      inferenceMode: field('inferenceMode').value as RuntimeConfig['inferenceMode'], inferenceEndpoint: field('inferenceEndpoint').value.trim(),
      inferenceDraftEndpoint: field('inferenceDraftEndpoint').value.trim(),
      databaseMode: field('databaseMode').value as RuntimeConfig['databaseMode'], databaseEndpoint: field('databaseEndpoint').value.trim(),
      datasetProfile: field('datasetProfile').value as RuntimeConfig['datasetProfile'],
      speculation: (field('speculation') as HTMLInputElement).checked,
      liveTranslation, translationMinChars: validMinimum ? minimum : config.translationMinChars,
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
    if (component === 'database') { el('dataset-dot').dataset.state = status.state; if (!context || status.state !== 'ready') el('dataset-sub').textContent = status.label; }
    if (component === 'model') { modelLoading = status.state === 'loading'; const progress = status.progress === undefined ? '' : ` · ${Math.round(status.progress <= 1 ? status.progress * 100 : status.progress)}%`; el('model-progress').textContent = status.label + progress; updateEndpointFields(); }
  }
  function setResultState(text: string, state: string): void { const label = el('result-state'); label.dataset.state = state; label.lastChild!.textContent = text; }
  function updateTiming(timing: QueryTiming): void {
    const start = timing.committedAt;
    if (start !== undefined && timing.firstDrawAt !== undefined) { const elapsed = Math.max(0, timing.firstDrawAt - start); el('latency').textContent = elapsed < 1000 ? `${elapsed.toFixed(1)} ms` : `${(elapsed / 1000).toFixed(2)} s`; el('latency-detail').textContent = timing.promoted ? 'Prepared result promoted' : 'First point draw submitted'; }
  }
  function renderTable(): void {
    tableFrame = 0; const body = el('table-body'); body.replaceChildren(); let rows = 0;
    for (const b of chart.batches) { for (let i = 0; i < b.length && rows < 12; i++, rows++) { const row = document.createElement('tr'); for (const value of [new Date(b.x[i]).toISOString().replace('T', ' ').slice(0, 16), seriesName(b.series[i]), Number.isFinite(b.y[i]) ? fmt.format(b.y[i]) : '—']) { const td = document.createElement('td'); td.textContent = value; row.append(td); } body.append(row); } if (rows === 12) break; }
  }
  function seriesName(id: number): string { const vessel = current && !current.plan.splitByVessel && current.plan.vessel !== null ? current.plan.vessel : id; return current && (current.plan.splitByVessel || current.plan.vessel !== null) ? (current.context.vessels[vessel] || `Series ${vessel + 1}`) : 'Fleet'; }
  function renderLegend(): void {
    const legend = el('legend'); legend.replaceChildren();
    for (const id of seenSeries) { const item = document.createElement('span'), dot = document.createElement('i'); dot.style.backgroundColor = SERIES_COLORS[Math.abs(id) % SERIES_COLORS.length]; item.append(dot, document.createTextNode(seriesName(id))); legend.append(item); }
  }
  function handleEvent(event: PipelineEvent): void {
    if (event.type === 'draft') { el('revision').textContent = `r.${event.revision}`; return; }
    if (event.type === 'speculation') {
      const labels = { idle: idleDraftLabel(), resolving: 'Translating your draft…', translated: 'SQL prepared before Enter', querying: 'Preparing query results…', ready: `${integer.format(event.points)} points staged before Enter`, canceled: 'Draft changed · preparing again' };
      const active = config.speculation || config.liveTranslation;
      el('draft-state').textContent = active ? labels[event.state] : 'Preparation paused';
      el('draft-dot').dataset.state = active && ['ready', 'translated'].includes(event.state) ? 'ready' : active && ['resolving', 'querying'].includes(event.state) ? 'loading' : 'quiet'; return;
    }
    if (event.type === 'trace') {
      el('trace-empty').hidden = true; const li = document.createElement('li'), name = document.createElement('span'), detail = document.createElement('span'); name.textContent = event.entry.event; detail.textContent = event.entry.detail; li.append(name, detail); el('trace-list').prepend(li); while (el('trace-list').children.length > 12) el('trace-list').lastElementChild!.remove(); return;
    }
    if (event.type === 'start') {
      current = event.view; awaitingStart = false; canceledId = undefined; completedId = undefined; sum = 0; count = 0; total = 0; batchCount = 0; minimum = Infinity; maximum = -Infinity; seenSeries.clear();
      chart.begin(current); setTab('chart'); track.begin(chart.batches, chart.order); setBusy(true); setResultState('QUERYING', 'loading');
      renderLegend(); el('table-body').replaceChildren();
      const metric = METRIC_LABELS[current.plan.metric];
      el('plot-title').textContent = `${metric.name}${current.plan.splitByVessel ? ' across the fleet' : ''}`;
      el('plot-subtitle').textContent = `${({ avg: 'Average', min: 'Minimum', max: 'Maximum' })[current.plan.aggregate]} · ${current.plan.bucketMinutes < 60 ? `${current.plan.bucketMinutes} minute` : `${current.plan.bucketMinutes / 60} hour`} buckets · last ${current.plan.windowHours < 48 ? `${current.plan.windowHours} hours` : `${current.plan.windowHours / 24} days`}`;
      el('time-range').textContent = `${date.format(Math.max(current.context.start, current.context.end - current.plan.windowHours * 3_600_000))} — ${date.format(current.context.end)} · UTC`;
      el('sql').textContent = current.sql; el('source').textContent = ({ template: 'LOCAL TEMPLATE', webgpu: 'LOCAL MODEL', remote: 'REMOTE MODEL' })[current.source];
      el('query-meta').textContent = `${current.id} · revision ${current.revision}${current.model ? ` · ${current.model}` : ''}`;
      el('empty-title').textContent = 'Listening for the first point…'; el('empty-detail').textContent = 'The chart draws as batches arrive.';
      el('plot-empty').hidden = false; el('track-empty').hidden = false;
      for (const key of ['mean', 'points', 'range', 'latency']) el(key).textContent = '—';
      el('mean-unit').textContent = metric.unit; el('batch-count').textContent = 'Waiting for the first batch'; el('latency-detail').textContent = 'First correct point submitted'; el('value-header').textContent = `${metric.name.toUpperCase()} · ${metric.unit}`;
      action<HTMLButtonElement>('export').disabled = true;
      const bubble = document.createElement('button'); bubble.className = 'history-question'; bubble.textContent = current.prompt; bubble.title = 'Click to edit this question'; bubble.addEventListener('click', () => setPrompt(event.view.prompt)); el('history').append(bubble); while (el('history').children.length > 8) el('history').firstElementChild!.remove();
      scrollHistory(); return;
    }
    if (event.type === 'batch') {
      if (event.id !== current?.id || event.id === canceledId) return;
      chart.append(event.batch); batchCount++;
      total += event.batch.length;
      if (total) { el('plot-empty').hidden = true; action<HTMLButtonElement>('export').disabled = false; }
      if (event.batch.lat && event.batch.lon && event.batch.length) el('track-empty').hidden = true;
      el('points').textContent = integer.format(total); el('batch-count').textContent = `${batchCount} ${batchCount === 1 ? 'batch' : 'batches'} received`;
      setResultState('STREAMING', 'ready'); if (!el('table-wrap').hidden && !tableFrame) tableFrame = requestAnimationFrame(renderTable); return;
    }
    if (event.type === 'complete') {
      if (event.id !== current?.id || event.id === canceledId) return;
      current.timing = event.timing; completedId = event.id; updateTiming(event.timing); updateCompletionState();
      if (!total) { el('empty-title').textContent = 'No matching observations.'; el('empty-detail').textContent = 'Try a wider time window or another vessel.'; el('points').textContent = '0'; } return;
    }
    if (event.type === 'error') {
      if (event.id && (event.id === canceledId || current && event.id !== current.id && !awaitingStart)) return;
      awaitingStart = false; completedId = undefined;
      setBusy(false); setResultState('QUERY ERROR', 'error'); const message = document.createElement('div'); message.className = 'error-message'; message.setAttribute('role', 'alert'); message.textContent = event.message; el('history').append(message); scrollHistory();
      if (!total) { el('plot-empty').hidden = false; el('empty-title').textContent = 'This question needs another pass.'; el('empty-detail').textContent = event.message; } else el('plot-subtitle').textContent = `Incomplete result · ${event.message}`;
    }
  }
  action('export').addEventListener('click', () => {
    if (!current || !total) return;
    const chunks: string[] = ['timestamp_utc,series,value\n'];
    for (const b of chart.batches) { let chunk = ''; for (let i = 0; i < b.length; i++) chunk += `${new Date(b.x[i]).toISOString()},"${seriesName(b.series[i]).replaceAll('"', '""')}",${Number.isFinite(b.y[i]) ? b.y[i] : ''}\n`; chunks.push(chunk); }
    const url = URL.createObjectURL(new Blob(chunks, { type: 'text/csv;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `time-blast-${current.plan.metric}.csv`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  setConfig(config);
  return { setDataset, setStatus, setConfig, handleEvent, setBusy, setPrompt, destroy() { chart.destroy(); track.destroy(); if (tableFrame) cancelAnimationFrame(tableFrame); if (historyFrame) cancelAnimationFrame(historyFrame); root.replaceChildren(); } };
}
