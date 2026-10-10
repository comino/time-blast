import { describe, expect, it } from 'vitest';
import { defaultInference, describePlacement, loadSettings, sanitizeConfig, saveSettings } from '../src/ui/defaults';

const memory = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }; };

describe('UI defaults', () => {
  it('uses the build-time endpoint for remote inference, else WebGPU with the default profile', () => {
    expect(defaultInference(' wss://infer.example/tb1 ')).toEqual({ kind: 'remote', endpoint: 'wss://infer.example/tb1' });
    expect(defaultInference(undefined)).toEqual({ kind: 'webgpu', model: 'qwen-1.5b' });
    expect(defaultInference('')).toEqual({ kind: 'webgpu', model: 'qwen-1.5b' });
    expect(describePlacement({ kind: 'remote', endpoint: 'wss://infer.example/tb1' })).toBe('REMOTE · infer.example');
  });

  it('round-trips settings and drops invalid persisted values', () => {
    const storage = memory();
    saveSettings({ inference: { kind: 'webgpu', model: 'qwen3-4b' }, coordinator: { latencyDialMs: 40, inferencePolicy: 'restart' } }, storage);
    expect(loadSettings(storage)).toEqual({ inference: { kind: 'webgpu', model: 'qwen3-4b' }, coordinator: { latencyDialMs: 40, inferencePolicy: 'restart' } });
    storage.setItem('time-blast.ui.v1', JSON.stringify({ inference: { kind: 'webgpu', model: 'gpt-9' }, coordinator: { minChars: -1, latencyDialMs: 5000, live: 'yes', translationCache: false } }));
    expect(loadSettings(storage)).toEqual({ coordinator: { translationCache: false } });
    storage.setItem('time-blast.ui.v1', '{broken');
    expect(loadSettings(storage)).toEqual({});
    expect(loadSettings(undefined)).toEqual({});
    expect(sanitizeConfig({ latencyDialMs: null, minChars: 3 })).toEqual({ latencyDialMs: null, minChars: 3 });
  });
});
