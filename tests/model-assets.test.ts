import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prebuiltAppConfig, type AppConfig } from '@mlc-ai/web-llm';
import { pinBrowserModelAssets } from '../src/inference/model-assets';

const evidence = JSON.parse(readFileSync(new URL('../docs/benchmarks/model-candidate-assets-2026-10-09.json', import.meta.url), 'utf8')) as {
  qwen3_candidates: { model: string; pinned_model_url: string; pinned_model_lib: { url: string } }[];
  qwen3_4b_fallback: { models: { model: string; model_url: string; files: { model_lib: { url: string } } }[] };
};
const qwen25Evidence = JSON.parse(readFileSync(new URL('../docs/benchmarks/qwen25-browser-assets-2026-10-09.json', import.meta.url), 'utf8')) as {
  models: { model: string; model_url: string; files: { model_lib: { url: string } } }[];
};
const candidates = [...evidence.qwen3_candidates, ...[...qwen25Evidence.models, ...evidence.qwen3_4b_fallback.models].map(candidate => ({
  model: candidate.model, pinned_model_url: candidate.model_url, pinned_model_lib: candidate.files.model_lib,
}))];

describe('verified browser model asset pins', () => {
  it.each(candidates)('uses inspected immutable assets for $model', candidate => {
    const before = structuredClone(prebuiltAppConfig);
    const pinned = pinBrowserModelAssets(candidate.model, prebuiltAppConfig);
    const record = pinned.model_list.find(record => record.model_id === candidate.model)!;
    const original = prebuiltAppConfig.model_list.find(record => record.model_id === candidate.model)!;
    expect(record).toEqual({ ...original, model: candidate.pinned_model_url, model_lib: candidate.pinned_model_lib.url });
    expect(record.model).toMatch(/\/resolve\/[a-f0-9]{40}\/$/);
    expect(record.model_lib).toMatch(/binary-mlc-llm-libs\/[a-f0-9]{40}\//);
    expect(prebuiltAppConfig).toEqual(before);
    expect(pinned.model_list).toHaveLength(prebuiltAppConfig.model_list.length);
    for (let index = 0; index < pinned.model_list.length; index++) {
      if (pinned.model_list[index].model_id !== candidate.model) {
        expect(pinned.model_list[index]).toBe(prebuiltAppConfig.model_list[index]);
      }
    }
  });

  it.each(qwen25Evidence.models)('preserves the verified Qwen2 library filename for $model', candidate => {
    const pinned = pinBrowserModelAssets(candidate.model, prebuiltAppConfig);
    const library = pinned.model_list.find(record => record.model_id === candidate.model)!.model_lib;
    expect(library.split('/').at(-1)).toBe(candidate.files.model_lib.url.split('/').at(-1));
    expect(library).toMatch(/\/Qwen2-(?:0\.5|1\.5)B-Instruct-q4f(?:16|32)_1_cs1k-webgpu\.wasm$/);
  });

  it('preserves cache, context, feature, memory and other registry settings without mutation', () => {
    const model = 'Qwen3-0.6B-q4f16_1-MLC';
    const candidate = evidence.qwen3_candidates.find(candidate => candidate.model === model)!;
    const source = prebuiltAppConfig.model_list.find(record => record.model_id === model)!;
    const record = Object.freeze({ ...source, overrides: Object.freeze({ context_window_size: 2048 }),
      required_features: ['shader-f16'], buffer_size_required_bytes: 12345 });
    const config: AppConfig = Object.freeze({ cacheBackend: 'opfs', opfsAccessMode: 'sync', model_list: [record] });
    Object.freeze(config.model_list);
    const pinned = pinBrowserModelAssets(model, config);
    expect(pinned.cacheBackend).toBe(config.cacheBackend);
    expect(pinned.opfsAccessMode).toBe(config.opfsAccessMode);
    expect(pinned.model_list[0]).toEqual({ ...record,
      model: candidate.pinned_model_url,
      model_lib: candidate.pinned_model_lib.url });
    expect(pinned.model_list[0].overrides).toBe(record.overrides);
    expect(pinned.model_list[0].required_features).toBe(record.required_features);
  });

  it.each(['Qwen2.5-3B-Instruct-q4f16_1-MLC', 'Qwen3.5-0.8B-q4f16_1-MLC',
    'Qwen3-0.6B-q0f16-MLC', 'unrecognized', '__proto__'])('leaves other models unchanged: %s', model => {
    expect(pinBrowserModelAssets(model, prebuiltAppConfig)).toBe(prebuiltAppConfig);
  });

  it.each(candidates)('requires the engine registry record for $model', candidate => {
    expect(() => pinBrowserModelAssets(candidate.model, { model_list: [] })).toThrow('Missing WebLLM registry record');
  });

  it('rejects an ambiguous selected record rather than leaving a mutable duplicate', () => {
    const model = 'Qwen3-0.6B-q4f16_1-MLC';
    const record = prebuiltAppConfig.model_list.find(record => record.model_id === model)!;
    expect(() => pinBrowserModelAssets(model, { model_list: [record, { ...record }] })).toThrow('Ambiguous WebLLM registry records');
  });

  it.each(candidates)('accepts its already pinned verified assets for $model', candidate => {
    const pinned = pinBrowserModelAssets(candidate.model, prebuiltAppConfig);
    expect(pinBrowserModelAssets(candidate.model, pinned)).toEqual(pinned);
  });

  it.each(candidates)('rejects missing, altered or unverified library URLs for $model', candidate => {
    const source = prebuiltAppConfig.model_list.find(record => record.model_id === candidate.model)!;
    for (const model_lib of [undefined, '',
      source.model_lib.replace('raw.githubusercontent.com', 'example.com'),
      source.model_lib.replace('/main/', '/unverified-branch/'),
      source.model_lib.replace('/v0_2_84/', '/v0_2_83/'),
      source.model_lib.replace('_cs1k-webgpu.wasm', '_cs2k-webgpu.wasm'),
      source.model_lib + '?unchecked=true',
      candidate.pinned_model_lib.url.replace(/\/([a-f0-9]{40})\//, '/' + '0'.repeat(40) + '/'),
    ]) {
      const config = { model_list: [{ ...source, model_lib }] } as AppConfig;
      expect(() => pinBrowserModelAssets(candidate.model, config)).toThrow('Unexpected WebLLM library URL');
    }
  });

  it('rejects a fabricated Qwen2.5 library name instead of replacing the verified Qwen2 filename', () => {
    const model = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';
    const source = prebuiltAppConfig.model_list.find(record => record.model_id === model)!;
    const config = { model_list: [{ ...source, model_lib: source.model_lib.replace('/Qwen2-', '/Qwen2.5-') }] };
    expect(() => pinBrowserModelAssets(model, config)).toThrow('Unexpected WebLLM library URL');
  });
});
