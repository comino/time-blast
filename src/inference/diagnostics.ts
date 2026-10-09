import type { InferenceDiagnostics } from '../core/types';

const fields = ['warmupMs', 'queueMs', 'generationMs', 'firstTokenMs', 'prefillMs', 'decodeMs',
  'grammarInitMs', 'grammarPerTokenMs', 'promptTokens', 'completionTokens',
  'prefillTokensPerSecond', 'decodeTokensPerSecond'] as const;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Remote telemetry is optional and never trusted as an executable plan. */
export function readInferenceDiagnostics(value: unknown): InferenceDiagnostics | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const input = value as Record<string, unknown>, output: InferenceDiagnostics = {};
  for (const field of fields) if (nonnegative(input[field]) &&
    (!field.endsWith('Tokens') || Number.isSafeInteger(input[field]))) output[field] = input[field];
  if (typeof input.cacheHit === 'boolean') output.cacheHit = input.cacheHit;
  return Object.keys(output).length ? output : undefined;
}

/** Interpret the pinned WebLLM usage fields without enabling per-token GPU profiling. */
export function webLLMDiagnostics(value: unknown): InferenceDiagnostics {
  if (!value || typeof value !== 'object') return {};
  const usage = value as Record<string, any>, extra = usage.extra ?? {};
  const ms = (seconds: unknown) => nonnegative(seconds) ? seconds * 1000 : undefined;
  return readInferenceDiagnostics({
    promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
    prefillMs: ms(extra.time_to_first_token_s),
    decodeMs: nonnegative(extra.time_per_output_token_s) && nonnegative(usage.completion_tokens)
      ? ms(extra.time_per_output_token_s * usage.completion_tokens) : undefined,
    prefillTokensPerSecond: extra.prefill_tokens_per_s,
    decodeTokensPerSecond: extra.decode_tokens_per_s,
    grammarInitMs: ms(extra.grammar_init_s), grammarPerTokenMs: ms(extra.grammar_per_token_s),
  }) ?? {};
}
