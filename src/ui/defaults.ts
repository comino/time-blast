/** Boot defaults and persisted runtime settings. Pure apart from guarded localStorage. */
import type { DatasetSource, InferencePlacement } from '../engine/contracts';
import { DEFAULT_COORDINATOR_CONFIG, type CoordinatorConfig } from './controller';

/** Browser model profiles offered for WebGPU inference. The id is what the engine receives in
 * `{kind:'webgpu', model}`; the inference node maps it to concrete WebLLM weights. */
export const MODEL_PROFILES = [
  { id: 'qwen-0.5b', label: 'Qwen2.5 · 0.5B · 4-bit', detail: 'Smallest download; least accurate.' },
  { id: 'qwen-1.5b', label: 'Qwen2.5 · 1.5B · 4-bit', detail: 'Default. About 0.87 GB of weights.' },
  { id: 'qwen3-4b', label: 'Qwen3 · 4B · 4-bit', detail: 'About 2.3 GB of weights; needs 3.4–4.3 GB GPU memory.' },
] as const;
export const DEFAULT_MODEL_PROFILE = 'qwen-1.5b';

export const FIXTURES = [
  { name: 'vessels', label: 'Vessels · 1.2 M rows (synthetic fixture)' },
  { name: 'vessels-small', label: 'Vessels · small (synthetic fixture)' },
  { name: 'weather', label: 'Weather · 12 European cities, hourly 2023–24 · 211 k rows' },
  { name: 'flights', label: 'Flights · US domestic, June 2024 · 3 tables · 611 k rows' },
  { name: 'cities', label: 'Cities · world cities over 15,000 people · 2 tables · 34 k rows' },
] as const;
export const DEFAULT_DATASET: DatasetSource = { kind: 'fixture', name: 'vessels' };

/** Remote endpoint from the build (`VITE_INFERENCE_ENDPOINT`) if set, else in-browser WebGPU. */
export function defaultInference(endpoint: string | undefined): InferencePlacement {
  const trimmed = endpoint?.trim();
  return trimmed ? { kind: 'remote', endpoint: trimmed } : { kind: 'webgpu', model: DEFAULT_MODEL_PROFILE };
}

export interface StoredSettings { inference?: InferencePlacement; coordinator?: CoordinatorConfig }
const KEY = 'time-blast.ui.v1';

export function loadSettings(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): StoredSettings {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredSettings;
    const out: StoredSettings = {};
    const inf = parsed.inference;
    if (inf?.kind === 'remote' && typeof inf.endpoint === 'string' && inf.endpoint) out.inference = inf;
    if (inf?.kind === 'webgpu' && MODEL_PROFILES.some(p => p.id === inf.model)) out.inference = inf;
    if (parsed.coordinator && typeof parsed.coordinator === 'object') out.coordinator = sanitizeConfig(parsed.coordinator);
    return out;
  } catch { return {}; }
}
export function saveSettings(settings: StoredSettings, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try { storage?.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode / blocked storage */ }
}

export function sanitizeConfig(c: CoordinatorConfig): CoordinatorConfig {
  const out: CoordinatorConfig = {};
  if (typeof c.live === 'boolean') out.live = c.live;
  if (typeof c.speculate === 'boolean') out.speculate = c.speculate;
  if (typeof c.translationCache === 'boolean') out.translationCache = c.translationCache;
  if (c.inferencePolicy === 'latest' || c.inferencePolicy === 'restart') out.inferencePolicy = c.inferencePolicy;
  if (Number.isInteger(c.minChars) && c.minChars! >= 0 && c.minChars! <= 500) out.minChars = c.minChars;
  if (c.latencyDialMs === null || (typeof c.latencyDialMs === 'number' && c.latencyDialMs >= 0 && c.latencyDialMs <= 1000)) out.latencyDialMs = c.latencyDialMs;
  return out;
}

export const coordinatorDefaults = (): Required<Omit<CoordinatorConfig, 'freeSlots'>> => ({ ...DEFAULT_COORDINATOR_CONFIG });

export function describePlacement(p: InferencePlacement): string {
  if (p.kind === 'webgpu') return `WEBGPU · ${p.model}`;
  try { return `REMOTE · ${new URL(p.endpoint).host}`; } catch { return 'REMOTE'; }
}
