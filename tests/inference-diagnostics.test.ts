import { describe, expect, it } from 'vitest';
import { readInferenceDiagnostics, webLLMDiagnostics } from '../src/inference/diagnostics';

describe('inference telemetry boundaries', () => {
  it('converts WebLLM seconds to milliseconds using its reported decode token convention', () => {
    expect(webLLMDiagnostics({ prompt_tokens: 100, completion_tokens: 20, extra: {
      time_to_first_token_s: .4, time_per_output_token_s: .05,
      prefill_tokens_per_s: 250, decode_tokens_per_s: 20,
      grammar_init_s: .01, grammar_per_token_s: .002,
    } })).toEqual({ promptTokens: 100, completionTokens: 20, prefillMs: 400, decodeMs: 1000,
      prefillTokensPerSecond: 250, decodeTokensPerSecond: 20, grammarInitMs: 10, grammarPerTokenMs: 2 });
  });
  it('does not fabricate missing phase durations or accept malformed remote values', () => {
    expect(webLLMDiagnostics(undefined)).toEqual({});
    expect(webLLMDiagnostics({ completion_tokens: 12, extra: {} })).toEqual({ completionTokens: 12 });
    expect(readInferenceDiagnostics({ queueMs: -1, prefillMs: '3', generationMs: Infinity,
      promptTokens: 1.5, completionTokens: Number.MAX_SAFE_INTEGER + 1, cacheHit: 'true', bogus: 10 })).toBeUndefined();
    expect(readInferenceDiagnostics({ queueMs: 0, promptTokens: 0, cacheHit: true, bogus: 10 }))
      .toEqual({ queueMs: 0, promptTokens: 0, cacheHit: true });
  });
  it('omits overflow and empty-output division telemetry while retaining valid counts', () => {
    expect(webLLMDiagnostics({ prompt_tokens: 0, completion_tokens: 0, extra: {
      time_to_first_token_s: 0, time_per_output_token_s: NaN, prefill_tokens_per_s: Infinity,
      decode_tokens_per_s: NaN, grammar_init_s: Number.MAX_VALUE,
    } })).toEqual({ promptTokens: 0, completionTokens: 0, prefillMs: 0 });
  });
});
