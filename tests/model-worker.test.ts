import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_MODEL_RESPONSE_SCHEMA } from '../src/inference/plan';
import { MAX_FAILED_RESPONSE_CHARS } from '../src/inference/failure';
import type { WorkerRequest, WorkerResponse } from '../src/inference/messages';

const mock = vi.hoisted(() => ({ create: vi.fn(), interrupt: vi.fn(), load: vi.fn() }));
vi.mock('@mlc-ai/web-llm', () => ({
  prebuiltAppConfig: { model_list: [{ model_id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC' }] },
  CreateMLCEngine: mock.load,
}));
const context = { id: 'test', start: 0, end: 86_400_000, rowCount: 3, label: 'Fleet', vessels: ['Aurora'], description: '' };
const draft = { text: 'Please show the fleet speed', revision: 1, contextId: context.id, sentAt: 0 };
const compact = { m: 'speed', a: 'avg', b: 60, h: 24, s: false, v: null, c: 'line' };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); mock.create.mockReset(); mock.interrupt.mockReset(); mock.load.mockReset(); });

async function worker() {
  const messages: WorkerResponse[] = [];
  const scope = { onmessage: null as null | ((event: { data: WorkerRequest }) => void),
    postMessage: (message: WorkerResponse) => messages.push(message),
    navigator: { gpu: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) } } };
  vi.stubGlobal('self', scope);
  mock.load.mockResolvedValue({ chat: { completions: { create: mock.create } }, interruptGenerate: mock.interrupt });
  await import('../src/inference/webllm.worker');
  return { messages, send: (data: WorkerRequest) => scope.onmessage!({ data }) };
}

describe('actual inference worker with a controlled engine', () => {
  it('requests compact constrained output and returns a validated full plan plus phase telemetry', async () => {
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    mock.create.mockImplementation(async () => (async function* () {
      now = 120; yield { choices: [{ delta: { content: JSON.stringify(compact) }, finish_reason: null }] };
      now = 150; yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, extra: {
        time_to_first_token_s: .012, time_per_output_token_s: .001,
        prefill_tokens_per_s: 100 / .012, decode_tokens_per_s: 1000,
      } } };
    })());
    const h = await worker(); h.send({ type: 'resolve', id: 'one', draft, context });
    await vi.waitFor(() => expect(h.messages.some(m => m.type === 'result')).toBe(true));
    const result = h.messages.find(m => m.type === 'result');
    expect(result?.type === 'result' && result.result).toMatchObject({ source: 'webgpu', tokens: 20,
      plan: { metric: 'speed', aggregate: 'avg', bucketMinutes: 60, windowHours: 24, splitByVessel: false, vessel: null, view: 'line' },
      diagnostics: { attempts: 1, queueMs: 0, warmupMs: 0, generationMs: 50, firstTokenMs: 20, prefillMs: 12, decodeMs: 20, promptTokens: 100, completionTokens: 20 },
    });
    const request = mock.create.mock.calls[0][0];
    expect(JSON.parse(request.response_format.schema)).toEqual(LOCAL_MODEL_RESPONSE_SCHEMA);
    expect(request.messages[1].content).toBe(draft.text);
    expect(request.extra_body?.enable_latency_breakdown).not.toBe(true);
    expect(h.messages.filter(m => m.type === 'result')).toHaveLength(1);
    expect(mock.create).toHaveBeenCalledOnce();
    expect(result?.type === 'result' && result.result.diagnostics?.repairMs).toBeUndefined();
    expect(result?.type === 'result' && result.result).not.toHaveProperty('response');
  });
  it.each(['length', 'abort'])('never publishes a truncated or interrupted plan (%s)', async finish_reason => {
    mock.create.mockImplementation(async () => (async function* () {
      yield { choices: [{ delta: { content: JSON.stringify(compact) }, finish_reason }] };
    })());
    const h = await worker(); h.send({ type: 'resolve', id: 'short', draft, context });
    await vi.waitFor(() => expect(h.messages.some(m => m.type === 'error')).toBe(true));
    expect(h.messages.some(m => m.type === 'result')).toBe(false);
    expect(mock.create).toHaveBeenCalledTimes(finish_reason === 'length' ? 2 : 1);
    expect(h.messages.find(m => m.type === 'error')).toMatchObject({ inference: {
      response: { text: JSON.stringify(compact), truncated: false, finishReason: finish_reason },
    } });
  });
  it.each([
    ['refusal', '{"error":"unsupported_request"}', 'stop', 'The model marked this request as unsupported.'],
    ['invalid JSON', '{"m":', 'stop', 'invalid JSON'],
    ['invalid plan', '{}', 'stop', 'missing or unsupported fields'],
    ['truncation', '{"m":', 'length', 'Output reached the token limit.'],
  ])('makes one model correction after %s and reports combined work', async (_kind, invalid, reason, feedback) => {
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const repaired = { ...compact, m: 'wave_height', b: 1, h: 168, s: true };
    const question = { ...draft, text: 'Compare vessel wave height by minute over the last 7 days' };
    mock.create.mockImplementationOnce(async () => (async function* () {
      now = 120; yield { choices: [{ delta: { content: invalid }, finish_reason: reason }] };
      now = 130; yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, extra: {
        time_to_first_token_s: .03, time_per_output_token_s: .001, grammar_init_s: .001,
        grammar_per_token_s: .0001, decode_tokens_per_s: 1000,
      } } };
    })());
    mock.create.mockImplementationOnce(async () => (async function* () {
      now = 150; yield { choices: [{ delta: { content: JSON.stringify(repaired) }, finish_reason: 'stop' }] };
      now = 180; yield { choices: [], usage: { prompt_tokens: 140, completion_tokens: 20, extra: {
        time_to_first_token_s: .04, time_per_output_token_s: .002, grammar_init_s: .002,
        grammar_per_token_s: .0002, decode_tokens_per_s: 500,
      } } };
    })());
    const h = await worker(); h.send({ type: 'resolve', id: 'repaired', draft: question, context });
    await vi.waitFor(() => expect(h.messages.some(m => m.type === 'result')).toBe(true));
    expect(mock.create).toHaveBeenCalledTimes(2);
    expect(mock.create.mock.calls[0][0].messages).toHaveLength(2);
    const repair = mock.create.mock.calls[1][0];
    expect(repair.messages).toHaveLength(4);
    expect(repair.messages[1]).toEqual({ role: 'user', content: question.text });
    expect(repair.messages[2]).toEqual({ role: 'assistant', content: invalid });
    expect(repair.messages[3]).toMatchObject({ role: 'user', content: expect.stringContaining(feedback) });
    expect(repair.messages[3].content).toContain('Do not simplify or silently drop any requirement.');
    expect(repair.messages[3].content).toContain('If it is truly unsupported');
    expect(repair.max_tokens).toBe(256);
    const result = h.messages.find(m => m.type === 'result');
    expect(result?.type === 'result' && result.result).toMatchObject({ source: 'webgpu', tokens: 30,
      plan: { metric: 'wave_height', aggregate: 'avg', bucketMinutes: 1, windowHours: 168, splitByVessel: true },
      diagnostics: { attempts: 2, repairMs: 50, generationMs: 80, firstTokenMs: 20,
        promptTokens: 240, completionTokens: 30, prefillMs: 70, decodeMs: 50, grammarInitMs: 3 },
    });
    if (result?.type !== 'result') throw new Error('Missing result');
    expect(result.result.diagnostics?.decodeTokensPerSecond).toBeUndefined();
    expect(result.result.diagnostics?.grammarPerTokenMs).toBeUndefined();
    expect(h.messages.filter(m => m.type === 'result')).toHaveLength(1);
    expect(h.messages.some(m => m.type === 'error')).toBe(false);
  });
  it.each([
    ['refusal', '{"error":"unsupported_request"}', 'The model marked this request as unsupported.'],
    ['invalid JSON', '{"m":', 'invalid JSON'],
    ['invalid plan', '{}', 'missing or unsupported fields'],
  ])('preserves generation and token measurements after a model %s', async (_kind, text, message) => {
    let now = 100, attempts = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    mock.create.mockImplementation(async () => (async function* () {
      const start = 100 + 50 * attempts++;
      now = start + 20; yield { choices: [{ delta: { content: text }, finish_reason: null }] };
      now = start + 50; yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      yield { choices: [], usage: { prompt_tokens: 80, completion_tokens: 9, extra: {
        time_to_first_token_s: .02, time_per_output_token_s: .003,
      } } };
    })());
    const h = await worker(); h.send({ type: 'resolve', id: 'failed', draft, context });
    await vi.waitFor(() => expect(h.messages.some(m => m.type === 'error')).toBe(true));
    const error = h.messages.find(m => m.type === 'error');
    expect(error).toMatchObject({ type: 'error', id: 'failed', message: expect.stringContaining(message),
      inference: { source: 'webgpu', model: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
        response: { text, truncated: false, finishReason: 'stop' }, diagnostics: {
        attempts: 2, repairMs: 50, queueMs: 0, warmupMs: 0, generationMs: 100, firstTokenMs: 20, prefillMs: 40, decodeMs: 54,
        promptTokens: 160, completionTokens: 18,
      } } });
    expect(h.messages.some(m => m.type === 'result')).toBe(false);
    expect(mock.create).toHaveBeenCalledTimes(2);
  });
  it('retains wall time and first-token measurements if the engine fails mid-generation', async () => {
    let now = 100; vi.spyOn(performance, 'now').mockImplementation(() => now);
    mock.create.mockImplementation(async () => (async function* () {
      now = 115; yield { choices: [{ delta: { content: '{' }, finish_reason: null }] };
      now = 140; throw new Error('Engine stopped');
    })());
    const h = await worker(); h.send({ type: 'resolve', id: 'failed', draft, context });
    await vi.waitFor(() => expect(h.messages.some(m => m.type === 'error')).toBe(true));
    expect(h.messages.find(m => m.type === 'error')).toMatchObject({ message: 'Engine stopped',
      inference: { source: 'webgpu', response: { text: '{', truncated: false },
        diagnostics: { generationMs: 40, firstTokenMs: 15 } } });
    expect(h.messages.some(m => m.type === 'result')).toBe(false);
    expect(mock.create).toHaveBeenCalledOnce();
  });
  it.each(['DeviceLostError', 'ModelNotLoadedError', 'TypeError'])('does not retry runtime failure %s', async name => {
    const error = new Error('Engine unavailable'); error.name = name;
    mock.create.mockRejectedValueOnce(error);
    const h = await worker(); h.send({ type: 'resolve', id: 'failed', draft, context });
    await vi.waitFor(() => expect(h.messages.some(m => m.type === 'error')).toBe(true));
    expect(mock.create).toHaveBeenCalledOnce();
    expect(h.messages.find(m => m.type === 'error')).toMatchObject({ name, inference: { diagnostics: { attempts: 1 } } });
  });
  it('retains only the final failed response when the correction itself fails', async () => {
    mock.create.mockImplementationOnce(async () => (async function* () {
      yield { choices: [{ delta: { content: '{"error":"unsupported_request"}' }, finish_reason: 'stop' }] };
      yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } };
    })());
    mock.create.mockImplementationOnce(async () => (async function* () {
      yield { choices: [{ delta: { content: '{"m":' }, finish_reason: null }] };
      throw new Error('Device failed during correction');
    })());
    const h = await worker(); h.send({ type: 'resolve', id: 'failed', draft, context });
    await vi.waitFor(() => expect(h.messages.some(m => m.type === 'error')).toBe(true));
    expect(mock.create).toHaveBeenCalledTimes(2);
    const error = h.messages.find(m => m.type === 'error');
    expect(error).toMatchObject({ message: 'Device failed during correction', inference: {
      response: { text: '{"m":', truncated: false }, diagnostics: { attempts: 2 },
    } });
    if (error?.type !== 'error') throw new Error('Missing failure');
    expect(error.inference?.diagnostics?.promptTokens).toBeUndefined();
    expect(error.inference?.diagnostics?.completionTokens).toBeUndefined();
    expect(h.messages.some(m => m.type === 'result')).toBe(false);
  });
  it('bounds failed completion text and omits unrelated reasoning and user input', async () => {
    const text = '<script>example</script>' + 'x'.repeat(MAX_FAILED_RESPONSE_CHARS);
    mock.create.mockImplementation(async () => (async function* () {
      yield { choices: [{ delta: { content: text, reasoning_content: 'Not completion output' }, finish_reason: 'stop' }] };
    })());
    const h = await worker(); h.send({ type: 'resolve', id: 'failed', draft, context });
    await vi.waitFor(() => expect(h.messages.some(m => m.type === 'error')).toBe(true));
    const error = h.messages.find(m => m.type === 'error');
    expect(error?.type === 'error' && error.inference?.response).toEqual({
      text: text.slice(0, MAX_FAILED_RESPONSE_CHARS), truncated: true, finishReason: 'stop',
    });
    expect(JSON.stringify(error)).not.toContain('Not completion output');
    expect(JSON.stringify(error)).not.toContain(draft.text);
  });
  it('distinguishes no generated content from a failure before generation', async () => {
    const h = await worker();
    mock.load.mockRejectedValueOnce(new Error('Loading failed'));
    h.send({ type: 'resolve', id: 'cold-failure', draft, context });
    await vi.waitFor(() => expect(h.messages.some(m => m.type === 'error')).toBe(true));
    const coldFailure = h.messages.find(m => m.type === 'error');
    expect(coldFailure?.type === 'error' && coldFailure.inference?.response).toBeUndefined();
    mock.create.mockRejectedValueOnce(new Error('Generation failed before any output'));
    h.send({ type: 'resolve', id: 'empty-failure', draft, context });
    await vi.waitFor(() => expect(h.messages.filter(m => m.type === 'error')).toHaveLength(2));
    expect(h.messages.find(m => m.type === 'error' && m.id === 'empty-failure')).toMatchObject({
      inference: { response: { text: '', truncated: false } },
    });
  });
  it('does not expose generated response content after explicit cancellation', async () => {
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    mock.create.mockImplementation(async () => (async function* () {
      yield { choices: [{ delta: { content: '{"error":' }, finish_reason: null }] };
      await held;
      yield { choices: [{ delta: { content: '"unsupported_request"}' }, finish_reason: 'stop' }] };
    })());
    const h = await worker(); h.send({ type: 'resolve', id: 'canceled', draft, context });
    await vi.waitFor(() => expect(mock.create).toHaveBeenCalledOnce());
    h.send({ type: 'cancel', id: 'canceled' }); finish();
    await vi.waitFor(() => expect(h.messages.some(m => m.type === 'error')).toBe(true));
    const error = h.messages.find(m => m.type === 'error');
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(error?.type === 'error' && error.inference?.response).toBeUndefined();
    expect(h.messages.some(m => m.type === 'result')).toBe(false);
    expect(mock.create).toHaveBeenCalledOnce();
  });
  it('honors cancellation after the first completion before starting correction', async () => {
    const h = await worker();
    mock.create.mockImplementation(async () => (async function* () {
      yield { choices: [{ delta: { content: '{"error":"unsupported_request"}' }, finish_reason: 'stop' }] };
      h.send({ type: 'cancel', id: 'canceled' });
    })());
    h.send({ type: 'resolve', id: 'canceled', draft, context });
    await vi.waitFor(() => expect(h.messages.some(m => m.type === 'error')).toBe(true));
    expect(mock.create).toHaveBeenCalledOnce();
    expect(h.messages.find(m => m.type === 'error')).toMatchObject({ name: 'AbortError' });
    expect(h.messages.some(m => m.type === 'result')).toBe(false);
  });
  it('keeps correction in its queue owner and admits the next request after cancellation', async () => {
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    mock.create.mockImplementationOnce(async () => (async function* () {
      yield { choices: [{ delta: { content: '{"error":"unsupported_request"}' }, finish_reason: 'stop' }] };
    })());
    mock.create.mockImplementationOnce(async () => (async function* () {
      yield { choices: [{ delta: { content: '{"m":' }, finish_reason: null }] };
      await held;
      yield { choices: [{ delta: { content: '"speed"}' }, finish_reason: 'stop' }] };
    })());
    mock.create.mockImplementationOnce(async () => (async function* () {
      yield { choices: [{ delta: { content: JSON.stringify(compact) }, finish_reason: 'stop' }] };
    })());
    const h = await worker(); h.send({ type: 'resolve', id: 'old', draft, context });
    await vi.waitFor(() => expect(mock.create).toHaveBeenCalledTimes(2));
    h.send({ type: 'resolve', id: 'new', draft: { ...draft, revision: 2 }, context });
    expect(mock.create).toHaveBeenCalledTimes(2);
    h.send({ type: 'cancel', id: 'old' }); finish();
    await vi.waitFor(() => expect(h.messages.some(m => m.type === 'result' && m.id === 'new')).toBe(true));
    expect(mock.create).toHaveBeenCalledTimes(3);
    const old = h.messages.find(m => m.type === 'error' && m.id === 'old');
    expect(old).toMatchObject({ name: 'AbortError' });
    expect(old?.type === 'error' && old.inference?.response).toBeUndefined();
    expect(h.messages.filter(m => m.type === 'result')).toHaveLength(1);
    expect(mock.create.mock.calls[2][0].messages).toHaveLength(2);
  });
  it('keeps draft transmission separate from expensive execution', async () => {
    const h = await worker();
    for (let revision = 1; revision <= 30; revision++) h.send({ type: 'draft', draft: { ...draft, revision } });
    await Promise.resolve(); expect(mock.load).not.toHaveBeenCalled(); expect(mock.create).not.toHaveBeenCalled();
  });
});
