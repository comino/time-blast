import { DEFAULT_LOCAL_MODEL_PROFILE, type LocalModelProfile } from '../core/types';

/** Concrete IDs verified against the pinned WebLLM 0.2.85 registry. */
export const BROWSER_MODEL_PROFILES = [
  {
    id: 'qwen-0.5b',
    label: 'Qwen2.5 · 0.5B',
    detail: 'Smallest download. Frequently misinterpreted requests in native tests; inspect its query details.',
    f16: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    f32: 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC',
  },
  {
    id: 'qwen-1.5b',
    label: 'Qwen2.5 · 1.5B',
    detail: 'Lighter than 4B, with more interpretation errors in native tests. Compare timing on this device.',
    f16: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    f32: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
  },
  {
    id: 'qwen3-4b',
    label: 'Qwen3 · 4B',
    detail: 'About 2.3 GB of weights. Estimated GPU memory: 3.4 GB (f16) or 4.3 GB (f32).',
    f16: 'Qwen3-4B-q4f16_1-MLC',
    f32: 'Qwen3-4B-q4f32_1-MLC',
  },
] as const satisfies readonly { id: LocalModelProfile; label: string; detail: string; f16: string; f32: string }[];

export function isLocalModelProfile(value: string): value is LocalModelProfile {
  return BROWSER_MODEL_PROFILES.some(profile => profile.id === value);
}

/** Select precision from the actual worker adapter; never assume shader-f16. */
export function selectBrowserModel(profile: LocalModelProfile | undefined, shaderF16: boolean): string {
  const selected = BROWSER_MODEL_PROFILES.find(candidate => candidate.id === (profile ?? DEFAULT_LOCAL_MODEL_PROFILE));
  if (!selected) throw new Error(`Unknown browser model profile: ${profile}`);
  return selected[shaderF16 ? 'f16' : 'f32'];
}
