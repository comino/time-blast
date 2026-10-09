import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_MODEL_RESPONSE_SCHEMA } from '../src/inference/plan';
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
      diagnostics: { queueMs: 0, warmupMs: 0, generationMs: 50, firstTokenMs: 20, prefillMs: 12, decodeMs: 20, promptTokens: 100, completionTokens: 20 },
    });
    const request = mock.create.mock.calls[0][0];
    expect(JSON.parse(request.response_format.schema)).toEqual(LOCAL_MODEL_RESPONSE_SCHEMA);
    expect(request.messages[1].content).toBe(draft.text);
    expect(request.extra_body?.enable_latency_breakdown).not.toBe(true);
    expect(h.messages.filter(m => m.type === 'result')).toHaveLength(1);
  });
  it.each(['length', 'abort'])('never publishes a truncated or interrupted plan (%s)', async finish_reason => {
    mock.create.mockImplementation(async () => (async function* () {
      yield { choices: [{ delta: { content: JSON.stringify(compact) }, finish_reason }] };
    })());
    const h = await worker(); h.send({ type: 'resolve', id: 'short', draft, context });
    await vi.waitFor(() => expect(h.messages.some(m => m.type === 'error')).toBe(true));
    expect(h.messages.some(m => m.type === 'result')).toBe(false);
  });
  it.each([
    ['refusal', '{"error":"unsupported_request"}', 'The model marked this request as unsupported.'],
    ['invalid JSON', '{"m":', 'invalid JSON'],
    ['invalid plan', '{}', 'missing or unsupported fields'],
  ])('preserves generation and token measurements after a model %s', async (_kind, text, message) => {
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    mock.create.mockImplementation(async () => (async function* () {
      now = 120; yield { choices: [{ delta: { content: text }, finish_reason: null }] };
      now = 150; yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      yield { choices: [], usage: { prompt_tokens: 80, completion_tokens: 9, extra: {
        time_to_first_token_s: .02, time_per_output_token_s: .003,
      } } };
    })());
    const h = await worker(); h.send({ type: 'resolve', id: 'failed', draft, context });
    await vi.waitFor(() => expect(h.messages.some(m => m.type === 'error')).toBe(true));
    const error = h.messages.find(m => m.type === 'error');
    expect(error).toMatchObject({ type: 'error', id: 'failed', message: expect.stringContaining(message),
      inference: { source: 'webgpu', model: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', diagnostics: {
        queueMs: 0, warmupMs: 0, generationMs: 50, firstTokenMs: 20, prefillMs: 20, decodeMs: 27,
        promptTokens: 80, completionTokens: 9,
      } } });
    expect(h.messages.some(m => m.type === 'result')).toBe(false);
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
      inference: { source: 'webgpu', diagnostics: { generationMs: 40, firstTokenMs: 15 } } });
    expect(h.messages.some(m => m.type === 'result')).toBe(false);
  });
  it('keeps draft transmission separate from expensive execution', async () => {
    const h = await worker();
    for (let revision = 1; revision <= 30; revision++) h.send({ type: 'draft', draft: { ...draft, revision } });
    await Promise.resolve(); expect(mock.load).not.toHaveBeenCalled(); expect(mock.create).not.toHaveBeenCalled();
  });
});
