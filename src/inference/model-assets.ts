import type { AppConfig } from '@mlc-ai/web-llm';

// Inspected config, actual tokenizer, shard manifest and Wasm hashes:
// docs/benchmarks/model-candidate-assets-2026-10-09.json and
// docs/benchmarks/qwen25-browser-assets-2026-10-09.json.
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

/** Pin verified assets at engine startup without changing registry behavior. */
export function pinBrowserModelAssets(model: string, config: AppConfig): AppConfig {
  const revision = MODEL_REVISIONS.get(model);
  if (!revision) return config;
  const index = config.model_list.findIndex(record => record.model_id === model);
  if (index < 0) throw new Error(`Missing WebLLM registry record for pinned model: ${model}`);
  if (config.model_list.some((record, otherIndex) => otherIndex !== index && record.model_id === model)) {
    throw new Error(`Ambiguous WebLLM registry records for pinned model: ${model}`);
  }
  // The verified registry reuses Qwen2 libraries for Qwen2.5 weights. Check
  // the complete source URL before pinning so a registry change cannot silently
  // select another binary. An already pinned matching record is also safe.
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
