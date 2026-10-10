import { describe, expect, it } from 'vitest';
import { prebuiltAppConfig } from '@mlc-ai/web-llm';
import { BROWSER_MODEL_PROFILES, isLocalModelProfile, selectBrowserModel } from '../src/inference/models';
import { DEFAULT_CONFIG, DEFAULT_LOCAL_MODEL_PROFILE, type LocalModelProfile } from '../src/core/types';

describe('browser model profiles', () => {
  it.each(BROWSER_MODEL_PROFILES)('ships both precision variants of $id in the pinned engine registry', profile => {
    for (const shaderF16 of [true, false]) {
      const id = selectBrowserModel(profile.id, shaderF16);
      const record = prebuiltAppConfig.model_list.find(candidate => candidate.model_id === id);
      expect(record, `${profile.id} / shader-f16=${shaderF16}`).toBeDefined();
      expect(record!.model).toBe(`https://huggingface.co/mlc-ai/${id}`);
      expect(record!.model_lib).toMatch(/-webgpu\.wasm$/);
      expect(id).toContain(shaderF16 ? 'q4f16' : 'q4f32');
    }
  });
  it('uses the same smaller quantized default for settings and direct adapter callers', () => {
    expect(DEFAULT_CONFIG.localModel).toBe('qwen-1.5b');
    expect(DEFAULT_CONFIG.localModel).toBe(DEFAULT_LOCAL_MODEL_PROFILE);
    expect(DEFAULT_CONFIG.cacheModelPlans).toBe(true);
    expect(selectBrowserModel(undefined, true)).toBe('Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
    expect(selectBrowserModel(undefined, false)).toBe('Qwen2.5-1.5B-Instruct-q4f32_1-MLC');
  });
  it('offers the larger verified Qwen3 model without exposing smaller experimental profiles', () => {
    expect(BROWSER_MODEL_PROFILES.map(profile => profile.id)).toEqual(['qwen-0.5b', 'qwen-1.5b', 'qwen3-4b']);
    expect(isLocalModelProfile('qwen3-4b')).toBe(true);
    expect(selectBrowserModel('qwen3-4b', true)).toBe('Qwen3-4B-q4f16_1-MLC');
    expect(selectBrowserModel('qwen3-4b', false)).toBe('Qwen3-4B-q4f32_1-MLC');
    expect(isLocalModelProfile('qwen3-0.6b')).toBe(false);
    expect(isLocalModelProfile('qwen3-1.7b')).toBe(false);
  });
  it('rejects unrecognized profiles instead of choosing arbitrary model URLs', () => {
    expect(isLocalModelProfile('qwen-1.5b')).toBe(true);
    for (const value of ['https://untrusted.test/weights', 'qwen-3b', '', '__proto__']) {
      expect(isLocalModelProfile(value)).toBe(false);
      expect(() => selectBrowserModel(value as LocalModelProfile, true)).toThrow('Unknown browser model profile');
    }
  });
});
