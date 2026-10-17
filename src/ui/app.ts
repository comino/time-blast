/** Page entry (batch 1): thin glue between the DOM and the engine worker.
 * Hot path = the textarea `input` listener → UiController.input → one transferred tb1 frame.
 * Everything visible beyond that is deferred to animation frames or driven by engine messages. */
import { engineWorker } from './boot';
import './styles.css';
import './app.css';
import type { CoordinatorConfig, SlotCard, SlotHost } from './controller';
import { ResizeBatcher } from './controller';
import { CanvasController } from '../canvas/controller';
import { CanvasPanel } from './canvas-panel';
import { installDropZone } from './dataset-drop';
import { coordinatorDefaults, DEFAULT_DATASET, defaultInference, describePlacement, FIXTURES, loadSettings, saveSettings } from './defaults';
import type { DatasetSource } from '../engine/contracts';
import { appShell } from './app-shell';
import { Board } from './board';
import { Rail } from './rail';
import { SettingsPanel } from './settings-panel';
import { defaultMotion, type MotionSettings } from './motion';
import { SlotCardView } from './slot-card';
import { mountInteractions } from './suggest-voice';
import type { SlotSize } from '../engine/contracts';
import { bootMark } from '../engine/boot-trace';
import { installBootTrace } from './boot-trace';

const root = document.querySelector<HTMLElement>('#app')!;
root.innerHTML = appShell;
const q = <T extends HTMLElement = HTMLElement>(name: string): T => root.querySelector<T>(`[data-el="${name}"]`)!;
const action = (name: string, fn: () => void) => root.querySelectorAll(`[data-action="${name}"]`).forEach(b => b.addEventListener('click', fn));

// ───────────── board, rail ─────────────
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const notice = (text: string) => {
  const box = q('board-notice'); box.textContent = text; box.hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { box.hidden = true; }, 8000);
};
const board = new Board(q('board-viewport'), q('board-world'), q('zoom-label'), shown => {
  q('card-count').textContent = `${shown} ${shown === 1 ? 'view' : 'views'}`;
  q('board-empty').hidden = shown > 0;
});
action('zoom-in', () => board.zoom(1.2)); action('zoom-out', () => board.zoom(1 / 1.2));
action('fit', () => board.fit()); action('arrange', () => board.arrange());

const cards = new Map<number, SlotCardView>();
const rail = new Rail(root, {
  focusSlot: slot => { const card = cards.get(slot); if (!card) return false; board.focus(card); return true; },
  notice,
});

// ───────────── engine worker and slots ─────────────
const worker = engineWorker;
installBootTrace(worker);
const sizes = new Map<number, SlotSize>();
let controller!: CanvasController;
let canvasPanel: CanvasPanel | undefined;
const resizes = new ResizeBatcher((slot, size) => { if (!cards.has(slot)) return; sizes.set(slot, size); controller.resize(slot, size); });
const canvasObserver = new ResizeObserver(entries => {
  const dpr = devicePixelRatio || 1;
  for (const entry of entries) {
    const slot = Number((entry.target as HTMLElement).dataset.slot);
    const box = entry.contentBoxSize?.[0];
    const width = box ? box.inlineSize : entry.contentRect.width, height = box ? box.blockSize : entry.contentRect.height;
    if (width > 0 && height > 0) resizes.push(slot, { width, height, devicePixelRatio: dpr });
  }
});
let lastDpr = devicePixelRatio;
addEventListener('resize', () => {
  if (devicePixelRatio === lastDpr) return;
  lastDpr = devicePixelRatio;
  for (const [slot, size] of sizes) resizes.push(slot, { ...size, devicePixelRatio: lastDpr });
});

const host: SlotHost = {
  create(slot, handlers) {
    const card = new SlotCardView(slot, handlers, board, () => { canvasObserver.unobserve(card.canvas); cards.delete(slot); sizes.delete(slot); });
    cards.set(slot, card);
    const size = card.initialSize();
    sizes.set(slot, size);
    const canvas = card.canvas.transferControlToOffscreen();
    canvasObserver.observe(card.canvas);
    return { card: card as SlotCard, canvas, size };
  },
  download(blob, filename) {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};
const newChartSource = () => controller.defaultSourceId ? controller.model?.sources.get(controller.defaultSourceId)?.name : undefined;
controller = new CanvasController(worker, host, rail, {
  changed: () => { canvasPanel?.update(); const name = newChartSource(); if (name) rail.examples(name); },
  editor: (value, label, mode, focus) => {
    const editor = q<HTMLTextAreaElement>('input'); editor.value = value;
    editor.dataset.mode = mode; editor.placeholder = mode === 'sql' ? 'SELECT …' : mode === 'regenerate' ? 'Describe how to regenerate this chart…' : 'Describe the change you want…';
    q('composer').querySelector('.composer-caption span')!.textContent = label;
    if (focus) { editor.focus(); editor.setSelectionRange(value.length, value.length); }
  },
  history: chartId => canvasPanel?.showHistory(chartId),
  reattach: source => {
    if (source.locator.kind !== 'file') { notice('This source loads from its saved location. Choose a current source in settings, then use “Use current source” in chart history to rebind it.'); return; }
    const file = document.createElement('input'); file.type = 'file'; file.accept = '.csv,.parquet,.pq,.tsv,.gz';
    file.addEventListener('change', () => { const chosen = file.files?.[0]; if (chosen) void controller.reattach(source.id, chosen).catch(e => notice(String(e.message ?? e))); });
    file.click();
  }, notice,
});
board.onLayout = items => controller.layouts(items.map(item => ({ slot: (item as SlotCardView).slot,
  layout: { x: item.x, y: item.y, width: item.width, height: item.height } })));
canvasPanel = new CanvasPanel(root, () => controller.session, {
  listCanvases: () => controller.listCanvases(), newCanvas: () => controller.newCanvas(), openCanvas: id => controller.openCanvas(id),
  importCanvas: raw => controller.importCanvas(raw), saveCopy: () => controller.saveCopy(), rename: title => controller.rename(title),
  undo: () => controller.undo(), redo: id => controller.redo(id), restoreCanvas: id => controller.restoreCanvas(id),
  restoreChart: (chart, revision) => controller.restoreChart(chart, revision), resumeDraft: id => controller.resumeDraft(id),
  discardDraft: id => controller.discardDraft(id), rebindChart: id => controller.rebindChart(id),
  sourceInfo: () => ({ name: controller.defaultSourceId ? controller.model?.sources.get(controller.defaultSourceId)?.name ?? 'Choose a source' : 'Choose a source', detail: 'Used for new charts; existing charts keep their own source.' }),
  chooseSource: () => q<HTMLDialogElement>('settings-dialog').showModal(),
});
worker.addEventListener('message', (event: MessageEvent) => controller.receive(event.data));
worker.addEventListener('error', event => { event.preventDefault(); rail.error({ code: 'worker', message: 'The engine worker failed to start', detail: event.message }, 0); });
worker.addEventListener('messageerror', () => rail.error({ code: 'worker', message: 'A message from the engine could not be read' }, 0));

// ───────────── dataset choice (per browser) ─────────────
// The last built-in or URL dataset chosen is the one a reload boots with; files cannot be reopened.
const DATASET_KEY = 'time-blast.dataset.v1';
const rememberDataset = (source: DatasetSource) => {
  if (source.kind !== 'fixture' && source.kind !== 'url') return;
  try { localStorage.setItem(DATASET_KEY, JSON.stringify(source)); } catch { /* storage blocked */ }
};
const bootDataset = (): DatasetSource => {
  try {
    const raw = JSON.parse(localStorage.getItem(DATASET_KEY) ?? 'null') as DatasetSource | null;
    if (raw?.kind === 'fixture' && FIXTURES.some(f => f.name === raw.name)) return { kind: 'fixture', name: raw.name };
    if (raw?.kind === 'url' && typeof raw.url === 'string' && /^https?:/i.test(raw.url) && typeof raw.name === 'string') {
      return { kind: 'url', name: raw.name, url: raw.url, ...(typeof raw.table === 'string' ? { table: raw.table } : {}), ...(raw.format === 'csv' || raw.format === 'parquet' ? { format: raw.format } : {}) };
    }
  } catch { /* storage blocked or malformed */ }
  return DEFAULT_DATASET;
};

// ───────────── settings ─────────────
const envEndpoint = import.meta.env.VITE_INFERENCE_ENDPOINT as string | undefined;
const stored = loadSettings();
let inference = stored.inference ?? defaultInference(envEndpoint);
const initialConfig: CoordinatorConfig = { ...coordinatorDefaults(), ...stored.coordinator };
// Motion follows the OS reduced-motion preference until the user picks a setting.
let motion: MotionSettings = stored.motion ?? defaultMotion(), motionChanged = false;
const applyMotion = (value: MotionSettings) => {
  motion = value;
  root.dataset.motionGrow = String(value.grow);
  board.smooth = board.autoFit = value.camera;
};
applyMotion(motion);
const persist = () => { const { freeSlots: _, ...coordinator } = controller.config; saveSettings({ inference, coordinator, ...(stored.motion || motionChanged ? { motion } : {}), focus }); };
// Focus: only the canvas and the chat. The board's viewport changes size, so refit the camera.
let focus = stored.focus ?? false;
const applyFocus = (value: boolean) => {
  focus = value; root.dataset.focus = String(value);
  const toggle = q('focus-toggle'), label = value ? 'Leave focus' : 'Focus: fullscreen, only canvas and chat';
  toggle.setAttribute('aria-pressed', String(value)); toggle.setAttribute('aria-label', label); toggle.title = label;
  // The board's ResizeObserver reports the new size after this frame's layout: fit one frame later.
  requestAnimationFrame(() => requestAnimationFrame(() => board.fit()));
};
applyFocus(focus);
// Focus also takes the browser fullscreen (a click may request it). Leaving fullscreen with
// Esc leaves focus too; a reload restores focus mode only, since fullscreen needs a gesture.
let fullscreenByFocus = false;
action('focus', () => {
  applyFocus(!focus); persist();
  if (focus && !document.fullscreenElement && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => { fullscreenByFocus = true; }, () => { /* refused: focus mode alone */ });
  } else if (!focus && fullscreenByFocus && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
});
document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement || !fullscreenByFocus) return;
  fullscreenByFocus = false;
  if (focus) { applyFocus(false); persist(); }
});
const toggles = root.querySelectorAll<HTMLButtonElement>('[data-toggle]');
const syncToggles = (config: CoordinatorConfig) => toggles.forEach(t => {
  const value = config[t.dataset.toggle as 'live' | 'speculate'];
  if (value !== undefined) t.setAttribute('aria-checked', String(value));
});
const applyConfig = (patch: CoordinatorConfig) => { controller.setConfig(patch); settings.sync(patch); syncToggles(controller.config); persist(); };
const settings = new SettingsPanel(root, inference, initialConfig, {
  inference: placement => { inference = placement; q('placement-label').textContent = describePlacement(placement); controller.setInference(placement); persist(); notice(`Inference: ${describePlacement(placement).toLowerCase()}`); },
  dataset: source => { controller.setDataset(source); rememberDataset(source); notice(`Loading ${source.name}…`); },
  config: patch => applyConfig(patch),
  motion: value => { motionChanged = true; applyMotion(value); persist(); },
}, envEndpoint);
settings.syncMotion(motion);
toggles.forEach(t => t.addEventListener('click', () => { const key = t.dataset.toggle as 'live' | 'speculate'; applyConfig({ [key]: !controller.config[key] }); }));
syncToggles(initialConfig);
q('placement-label').textContent = describePlacement(inference);
q('dataset-badge').textContent = bootDataset().name.toUpperCase();

installDropZone(window, source => { controller.setDataset(source); notice(`Loading ${source.name}…`); },
  active => { q('drop-hint').hidden = !active; },
  names => notice(`Not a Parquet or CSV file: ${names}`));

// ───────────── input: the hot path ─────────────
const input = q<HTMLTextAreaElement>('input');
const newChart = document.createElement('button'); newChart.type = 'button'; newChart.className = 'text-button'; newChart.textContent = '+ New chart';
newChart.addEventListener('click', () => controller.newQuestion());
q('composer').querySelector('.composer-caption')!.append(newChart);
root.querySelector('.composer-area')!.addEventListener('focusout', event => {
  const area = event.currentTarget as HTMLElement, next = (event as FocusEvent).relatedTarget as Node | null;
  if (next && area.contains(next)) return;
  // Wait until a click has chosen its destination, while treating all editor
  // controls as one semantic edit session.
  queueMicrotask(() => { if (!area.contains(document.activeElement)) controller.finishEditor(); });
});
// Main-thread cost of our input handler per keystroke (ms): `costs` is controller.input itself
// (document update, synchronous part of the canvas save, DRAFT encode + post); `costsFull` also
// includes the microtasks queued during it, where deferred save work runs.
const COST_RING = 256;
const costs = new Float64Array(COST_RING), costsFull = new Float64Array(COST_RING);
let costCount = 0, composing = false, chromeFrame = 0, costShownAt = 0;

const updateChrome = () => {
  chromeFrame = 0;
  q('revision').textContent = `r.${controller.inputSequence}`;
  const now = performance.now();
  if (now - costShownAt > 500 && costCount) {
    costShownAt = now;
    const sorted = costs.slice(0, Math.min(costCount, COST_RING)).sort();
    rail.uiCost(sorted[sorted.length >> 1]);
  }
};
const scheduleChrome = () => { if (!chromeFrame) chromeFrame = requestAnimationFrame(updateChrome); };

input.addEventListener('input', event => {
  const start = performance.now();
  controller.input(input.value, composing || (event as InputEvent).isComposing, event.timeStamp);
  const at = costCount++ % COST_RING;
  costs[at] = performance.now() - start; costsFull[at] = NaN;
  queueMicrotask(() => { costsFull[at] = performance.now() - start; });
  scheduleChrome();
});
input.addEventListener('compositionstart', event => { composing = true; controller.input(input.value, true, event.timeStamp); });
input.addEventListener('compositionend', event => { composing = false; controller.input(input.value, false, event.timeStamp); scheduleChrome(); });
const commit = (timeStamp: number) => {
  if (!input.value.trim()) return;
  controller.commit(input.value, timeStamp);
  // Keep the text (an empty draft would cancel the committed work); typing replaces it.
  input.select();
  scheduleChrome();
};
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); commit(event.timeStamp); }
  else if (event.key === 'Escape') { event.preventDefault(); controller.cancel(); notice('Stopped all work.'); }
});
q<HTMLFormElement>('composer').addEventListener('submit', event => { event.preventDefault(); commit(event.timeStamp); input.focus(); });
action('stop', () => controller.cancel());
action('clear-canvas', () => { controller.clear(); board.resetCamera(); });
// Suggested prompts change with the dataset (rail.ts), so listen on their container.
q('examples').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-prompt]'); if (!button) return;
  input.value = button.dataset.prompt!; input.focus();
  input.dispatchEvent(new InputEvent('input', { inputType: 'insertReplacementText' }));
});

// Voice input and next-question chips (docs/batch-2/voice-anticipation.md).
const interactions = mountInteractions(root, input, controller, scheduleChrome);

// ───────────── boot ─────────────
void controller.initialize(inference, bootDataset(), initialConfig).catch(e => notice(`Canvas startup: ${String(e.message ?? e)}`));
bootMark('page.boot');
input.focus();

/** Diagnostics for smoke tests and manual measurement (cheap; read on demand). */
const ring = (a: Float64Array) => Array.from({ length: Math.min(costCount, COST_RING) }, (_, i) => a[(Math.max(0, costCount - COST_RING) + i) % COST_RING]);
(globalThis as unknown as { __timeBlastUi: unknown }).__timeBlastUi = {
  controller,
  costs: () => ring(costs), costsFull: () => ring(costsFull),
  framesSent: () => controller.sentFrames,
  interactions,
};
