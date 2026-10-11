/** Page entry (batch 1): thin glue between the DOM and the engine worker.
 * Hot path = the textarea `input` listener → UiController.input → one transferred tb1 frame.
 * Everything visible beyond that is deferred to animation frames or driven by engine messages. */
import { engineWorker } from './boot';
import './styles.css';
import './app.css';
import type { CoordinatorConfig, SlotCard, SlotHost } from './controller';
import { ResizeBatcher, UiController } from './controller';
import { installDropZone } from './dataset-drop';
import { coordinatorDefaults, DEFAULT_DATASET, defaultInference, describePlacement, loadSettings, saveSettings } from './defaults';
import { appShell } from './app-shell';
import { Board } from './board';
import { Rail } from './rail';
import { SettingsPanel } from './settings-panel';
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
let controller!: UiController;
const resizes = new ResizeBatcher((slot, size) => { sizes.set(slot, size); controller.resize(slot, size); });
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
controller = new UiController(worker, host, rail);
worker.addEventListener('message', (event: MessageEvent) => controller.receive(event.data));
worker.addEventListener('error', event => { event.preventDefault(); rail.error({ code: 'worker', message: 'The engine worker failed to start', detail: event.message }, 0); });
worker.addEventListener('messageerror', () => rail.error({ code: 'worker', message: 'A message from the engine could not be read' }, 0));

// ───────────── settings ─────────────
const envEndpoint = import.meta.env.VITE_INFERENCE_ENDPOINT as string | undefined;
const stored = loadSettings();
let inference = stored.inference ?? defaultInference(envEndpoint);
const initialConfig: CoordinatorConfig = { ...coordinatorDefaults(), ...stored.coordinator };
const persist = () => { const { freeSlots: _, ...coordinator } = controller.config; saveSettings({ inference, coordinator }); };
const toggles = root.querySelectorAll<HTMLButtonElement>('[data-toggle]');
const syncToggles = (config: CoordinatorConfig) => toggles.forEach(t => {
  const value = config[t.dataset.toggle as 'live' | 'speculate'];
  if (value !== undefined) t.setAttribute('aria-checked', String(value));
});
const applyConfig = (patch: CoordinatorConfig) => { controller.setConfig(patch); settings.sync(patch); syncToggles(controller.config); persist(); };
const settings = new SettingsPanel(root, inference, initialConfig, {
  inference: placement => { inference = placement; q('placement-label').textContent = describePlacement(placement); controller.setInference(placement); persist(); notice(`Inference: ${describePlacement(placement).toLowerCase()}`); },
  dataset: source => { controller.setDataset(source); notice(`Loading ${source.name}…`); },
  config: patch => applyConfig(patch),
}, envEndpoint);
toggles.forEach(t => t.addEventListener('click', () => { const key = t.dataset.toggle as 'live' | 'speculate'; applyConfig({ [key]: !controller.config[key] }); }));
syncToggles(initialConfig);
q('placement-label').textContent = describePlacement(inference);
q('dataset-badge').textContent = DEFAULT_DATASET.name.toUpperCase();

installDropZone(window, source => { controller.setDataset(source); notice(`Loading ${source.name}…`); },
  active => { q('drop-hint').hidden = !active; },
  names => notice(`Not a Parquet or CSV file: ${names}`));

// ───────────── input: the hot path ─────────────
const input = q<HTMLTextAreaElement>('input');
const COST_RING = 256;
const costs = new Float64Array(COST_RING);
let costCount = 0, composing = false, chromeFrame = 0, costShownAt = 0;

const updateChrome = () => {
  chromeFrame = 0;
  q('revision').textContent = `r.${controller.drafts.revision}`;
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
  costs[costCount++ % COST_RING] = performance.now() - start;
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
root.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach(button => button.addEventListener('click', () => {
  input.value = button.dataset.prompt!; input.focus();
  input.dispatchEvent(new InputEvent('input', { inputType: 'insertReplacementText' }));
}));

// Voice input and next-question chips (docs/batch-2/voice-anticipation.md).
const interactions = mountInteractions(root, input, controller, scheduleChrome);

// ───────────── boot ─────────────
controller.boot(inference, DEFAULT_DATASET, initialConfig);
bootMark('page.boot');
input.focus();

/** Diagnostics for smoke tests and manual measurement (cheap; read on demand). */
(globalThis as unknown as { __timeBlastUi: unknown }).__timeBlastUi = {
  controller,
  costs: () => Array.from(costs.subarray(0, Math.min(costCount, COST_RING))),
  framesSent: () => controller.drafts.sent,
  interactions,
};
