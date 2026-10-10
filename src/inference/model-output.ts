/** Known Qwen3 profiles whose pinned WebLLM assets use the verified chat template. */
const NONTHINKING_MODELS = new Set([
  'Qwen3-0.6B-q4f16_1-MLC', 'Qwen3-0.6B-q4f32_1-MLC',
  'Qwen3-1.7B-q4f16_1-MLC', 'Qwen3-1.7B-q4f32_1-MLC',
  'Qwen3-4B-q4f16_1-MLC', 'Qwen3-4B-q4f32_1-MLC',
]);

// WebLLM 0.2.85 appends these exact bytes to both the assistant prompt and
// outputIds when extra_body.enable_thinking=false. It streams them as content;
// the JSON grammar applies only to subsequently sampled tokens. Evidence:
// docs/benchmarks/model-candidate-assets-2026-10-09.json.
export const EMPTY_THINKING_PREFIX = '<think>\n\n</think>\n\n';

export interface ModelGenerationOptions {
  extra_body?: { enable_thinking: false };
}
const NONTHINKING_OPTIONS: ModelGenerationOptions = Object.freeze({
  extra_body: Object.freeze({ enable_thinking: false as const }),
});
const DEFAULT_OPTIONS: ModelGenerationOptions = Object.freeze({});

/** Other model families retain their existing generation behavior. */
export function modelGenerationOptions(model: string): ModelGenerationOptions {
  return NONTHINKING_MODELS.has(model) ? NONTHINKING_OPTIONS : DEFAULT_OPTIONS;
}

/**
 * Normalize completed output only, then apply the ordinary strict JSON decoder.
 * Remove one documented empty header at byte zero for an allowlisted model.
 * Actual reasoning, alternate whitespace, repeated headers, prose and suffixes
 * are never discarded to salvage a plan. Their remaining text fails validation.
 */
export function normalizeModelOutput(text: string, model: string): string {
  return NONTHINKING_MODELS.has(model) && text.startsWith(EMPTY_THINKING_PREFIX)
    ? text.slice(EMPTY_THINKING_PREFIX.length)
    : text;
}
