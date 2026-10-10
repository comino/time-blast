/**
 * Browser model profiles for the WebLLM inference node (copied from the legacy
 * src/inference/models.ts, model-assets.ts and model-output.ts, which batch 1 deletes).
 * IDs and asset revisions are verified against the pinned WebLLM 0.2.85 registry; see
 * docs/benchmarks/model-candidate-assets-2026-10-09.json and qwen25-browser-assets-2026-10-09.json.
 */
import type { AppConfig } from '@mlc-ai/web-llm';

export const MODEL_PROFILES = [
  { id: 'qwen-0.5b', label: 'Qwen2.5 · 0.5B · 4-bit', f16: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC' },
  { id: 'qwen-1.5b', label: 'Qwen2.5 · 1.5B · 4-bit', f16: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', f32: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC' },
  { id: 'qwen3-4b', label: 'Qwen3 · 4B · 4-bit', f16: 'Qwen3-4B-q4f16_1-MLC', f32: 'Qwen3-4B-q4f32_1-MLC' },
] as const;
export type ModelProfileId = typeof MODEL_PROFILES[number]['id'];
export const DEFAULT_MODEL_PROFILE: ModelProfileId = 'qwen-1.5b';

/** A profile id picks precision from the adapter; a concrete MLC id is used as given. */
export function resolveModelId(requested: string | undefined, shaderF16: boolean): string {
  const profile = MODEL_PROFILES.find((p) => p.id === (requested || DEFAULT_MODEL_PROFILE));
  if (profile) return shaderF16 ? profile.f16 : profile.f32;
  return requested!;
}

const MODEL_REVISIONS = new Map([
  ['Qwen2.5-0.5B-Instruct-q4f16_1-MLC', '32ff081fe7e4dfe4ffb167b94c66fdf11e02b8ad'],
  ['Qwen2.5-0.5B-Instruct-q4f32_1-MLC', '8e6ec5f417c7d0e1414703ef619b8a24686e3ab0'],
  ['Qwen2.5-1.5B-Instruct-q4f16_1-MLC', '9bd564b064631febf14deadcac492efb761d60c3'],
  ['Qwen2.5-1.5B-Instruct-q4f32_1-MLC', 'a822ee410075710c9673005eafa017b90136b85d'],
  ['Qwen3-0.6B-q4f16_1-MLC', '8c14ce481d4c692769976ad52afea453a102df19'],
  ['Qwen3-0.6B-q4f32_1-MLC', '9b4f0b05b08c692ea86fe151ea878406ad22f428'],
  ['Qwen3-1.7B-q4f16_1-MLC', '80b3abcec6c3b3f5355dc0cc99cc4fb578f192bc'],
  ['Qwen3-1.7B-q4f32_1-MLC', 'bddd4d584cabe19113f7e4ff46fd9e73b4d3dc89'],
  ['Qwen3-4B-q4f16_1-MLC', 'a5c9fab855e3ccbdfed2e7e69683d75f30332161'],
  ['Qwen3-4B-q4f32_1-MLC', 'b7e4eb1ba80728187fb5df44055cc1a7c32310e0'],
]);
const BINARY_COMMIT = '025bcaf3780fa8254f5e5efd3bfea0a5397248f4';
const MUTABLE_BINARY_BASE = 'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/';
const PINNED_BINARY_BASE = MUTABLE_BINARY_BASE.replace('/main/', `/${BINARY_COMMIT}/`);

/** Pin verified weights and library for known models without changing registry behavior. */
export function pinModelAssets(model: string, config: AppConfig): AppConfig {
  const revision = MODEL_REVISIONS.get(model);
  if (!revision) return config;
  const index = config.model_list.findIndex((record) => record.model_id === model);
  if (index < 0) throw new Error(`Missing WebLLM registry record for pinned model: ${model}`);
  if (config.model_list.some((record, other) => other !== index && record.model_id === model)) {
    throw new Error(`Ambiguous WebLLM registry records for pinned model: ${model}`);
  }
  // The registry reuses Qwen2 libraries for Qwen2.5 weights; check the full URL before pinning.
  const libraryName = `${model.replace(/^Qwen2\.5-/, 'Qwen2-').slice(0, -'-MLC'.length)}_cs1k-webgpu.wasm`;
  const library = config.model_list[index].model_lib;
  if (library !== MUTABLE_BINARY_BASE + libraryName && library !== PINNED_BINARY_BASE + libraryName) {
    throw new Error(`Unexpected WebLLM library URL for pinned model: ${model}`);
  }
  const model_list = config.model_list.slice();
  model_list[index] = {
    ...model_list[index],
    model: `https://huggingface.co/mlc-ai/${model}/resolve/${revision}/`,
    model_lib: library.replace('/main/', `/${BINARY_COMMIT}/`),
  };
  return { ...config, model_list };
}

/** Qwen3 profiles: disable thinking. WebLLM then streams an empty <think></think> header as
 * content, which SqlStream strips. */
const NONTHINKING = /^Qwen3-/;
export function generationOptions(model: string): { extra_body?: { enable_thinking: false } } {
  return NONTHINKING.test(model) ? { extra_body: { enable_thinking: false } } : {};
}
