/** Boot defaults and persisted runtime settings. Pure apart from guarded localStorage. */
import type { DatasetSource, InferencePlacement } from '../engine/contracts';
import { DEFAULT_COORDINATOR_CONFIG, type CoordinatorConfig } from './controller';
import { sanitizeMotion, type MotionSettings } from './motion';

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
  { name: 'flights-2024', label: 'Flights · US domestic, all of 2024 · 3 tables · 7.1 M rows' },
  { name: 'cities', label: 'Cities · world cities over 15,000 people · 2 tables · 34 k rows' },
  { name: 'nyc-taxi', label: 'NYC taxi · yellow cab trips, Jan–Mar 2024 · 2 tables · 9.4 M rows' },
] as const;
export const DEFAULT_DATASET: DatasetSource = { kind: 'fixture', name: 'vessels' };

/** Datasets served by the remote DuckDB node (crates/database-server) when the build sets
 * `VITE_DATABASE_ENDPOINT`. The name matches the server's TIME_BLAST_DB_NAME. */
export const SERVER_DATASETS = [
  { name: 'nyc-taxi-big', label: 'NYC taxi · yellow + green cabs, 2022–2024 · 120 M rows · server DuckDB' },
] as const;

/** A dataset picker value: a fixture name, or `server:<name>` for a server dataset. */
export function datasetFromChoice(value: string, databaseEndpoint: string | undefined): DatasetSource | null {
  if (value.startsWith('server:')) {
    const name = value.slice(7);
    return databaseEndpoint && SERVER_DATASETS.some(d => d.name === name) ? { kind: 'remote', name, endpoint: databaseEndpoint } : null;
  }
  return FIXTURES.some(f => f.name === value) ? { kind: 'fixture', name: value } : null;
}

/** Remote endpoint from the build (`VITE_INFERENCE_ENDPOINT`) if set, else in-browser WebGPU. */
export function defaultInference(endpoint: string | undefined): InferencePlacement {
  const trimmed = endpoint?.trim();
  return trimmed ? { kind: 'remote', endpoint: trimmed } : { kind: 'webgpu', model: DEFAULT_MODEL_PROFILE };
}

export interface StoredSettings { inference?: InferencePlacement; coordinator?: CoordinatorConfig; motion?: MotionSettings; focus?: boolean }
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
    const motion = sanitizeMotion(parsed.motion);
    if (motion) out.motion = motion;
    if (typeof parsed.focus === 'boolean') out.focus = parsed.focus;
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
