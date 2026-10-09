import { afterEach, describe, expect, it, vi } from 'vitest';
import { readInferenceDiagnostics, webLLMDiagnostics } from '../src/inference/diagnostics';
import { createInferenceAdapter } from '../src/inference';
import { InferenceFailure } from '../src/inference/failure';
import type { WorkerRequest } from '../src/inference/messages';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
  it('preserves local refusal diagnostics and adds adapter warmup time exactly once', async () => {
    let now = 100, worker: any;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('navigator', { gpu: {} });
    vi.stubGlobal('Worker', class {
      messages: WorkerRequest[] = []; onmessage: any;
      constructor() { worker = this; }
      postMessage(message: WorkerRequest) { this.messages.push(message); }
      terminate() {}
    });
    const context = { id: 'test', start: 0, end: 86_400_000, rowCount: 3, label: 'Fleet', vessels: ['Aurora'], description: '' };
    const draft = { text: 'Please show fleet speed', revision: 1, contextId: context.id, sentAt: now };
    const adapter = createInferenceAdapter('webgpu');
    const preparation = adapter.prepare(context);
    const result = adapter.resolve(draft, new AbortController().signal);
    const rejected = expect(result).rejects.toMatchObject({ message: 'This request cannot be expressed.',
      details: { source: 'webgpu', model: 'test-model', diagnostics: { warmupMs: 105,
        generationMs: 140, queueMs: 10, promptTokens: 80, completionTokens: 9 } } });
    now = 200;
    worker.onmessage({ data: { type: 'ready', id: worker.messages[0].id, model: 'test-model' } });
    await preparation;
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const request = worker.messages.find((message: WorkerRequest) => message.type === 'resolve');
    expect(request).toBeDefined();
    now = 350;
    worker.onmessage({ data: { type: 'error', id: request.id, message: 'This request cannot be expressed.',
      inference: { source: 'webgpu', model: 'test-model', diagnostics: {
        warmupMs: 5, queueMs: 10, generationMs: 140, promptTokens: 80, completionTokens: 9,
      } } } });
    await rejected; adapter.dispose();
  });
  it('retains sanitized remote measurements when its returned plan fails validation', async () => {
    const context = { id: 'test', start: 0, end: 86_400_000, rowCount: 3, label: 'Fleet', vessels: ['Aurora'], description: '' };
    const adapter = createInferenceAdapter('remote', { endpoint: 'https://example.invalid/inference',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ model: 'remote-model', plan: {},
        diagnostics: { generationMs: 55, promptTokens: 80, queueMs: -3, completionTokens: 1.5, extra: 'ignore' },
      }))) });
    await adapter.prepare(context);
    await expect(adapter.resolve({ text: 'Please show fleet speed', revision: 1, contextId: context.id, sentAt: 0 },
      new AbortController().signal)).rejects.toMatchObject({ details: { source: 'remote', model: 'remote-model',
        diagnostics: { generationMs: 55, promptTokens: 80 } } });
    adapter.dispose();
  });
  it('attributes device-loss measurements only to the generation that performed the work', async () => {
    let worker: any;
    vi.stubGlobal('navigator', { gpu: {} });
    vi.stubGlobal('Worker', class {
      messages: WorkerRequest[] = []; onmessage: any;
      constructor() { worker = this; }
      postMessage(message: WorkerRequest) { this.messages.push(message); }
      terminate() {}
    });
    const context = { id: 'test', start: 0, end: 86_400_000, rowCount: 3, label: 'Fleet', vessels: ['Aurora'], description: '' };
    const adapter = createInferenceAdapter('webgpu');
    const preparation = adapter.prepare(context);
    worker.onmessage({ data: { type: 'ready', id: worker.messages[0].id, model: 'test-model' } });
    await preparation;
    const draft = { text: 'Please show fleet speed', revision: 1, contextId: context.id, sentAt: 0 };
    const active = adapter.resolve(draft, new AbortController().signal);
    const waiting = adapter.resolve({ ...draft, text: 'Please show fleet wind', revision: 2 }, new AbortController().signal);
    const activeError = active.catch(error => error), waitingError = waiting.catch(error => error);
    const request = worker.messages.find((message: WorkerRequest) => message.type === 'resolve');
    worker.onmessage({ data: { type: 'error', id: request.id, name: 'DeviceLostError', message: 'Device lost',
      inference: { source: 'webgpu', model: 'test-model', diagnostics: { generationMs: 90, firstTokenMs: 20 } } } });
    expect(await activeError).toMatchObject({ name: 'DeviceLostError', details: { source: 'webgpu',
      diagnostics: { generationMs: 90, firstTokenMs: 20 } } });
    expect((await waitingError).details.diagnostics).toEqual({ warmupMs: 0 });
    adapter.dispose();
  });
  it('does not turn arbitrary error properties into trusted telemetry', () => {
    const failure = new InferenceFailure(new Error('Failed'), { source: 'remote', model: 'x'.repeat(500),
      diagnostics: { generationMs: Infinity, promptTokens: 1.2, queueMs: 3 } });
    expect(failure.details.model).toHaveLength(200);
    expect(failure.details.diagnostics).toEqual({ queueMs: 3 });
  });
});
