import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterStatus, DatasetContext, Draft, QueryPlan } from '../src/core/types';
import { createInferenceAdapter, parseTemplate, parseModelPlan, validateQueryPlan } from '../src/inference';
import { buildSystemPrompt, validateDraft } from '../src/inference/plan';
import { GenerationQueue } from '../src/inference/generation';
import type { WorkerRequest, WorkerResponse } from '../src/inference/messages';

const context: DatasetContext = {
  id: 'fleet-v1', label: 'Fleet telemetry', rowCount: 1000,
  start: Date.UTC(2026, 8, 1), end: Date.UTC(2026, 8, 15),
  vessels: ['Aurora', 'Borealis', 'Calypso', 'Discovery', 'Endeavour', 'Fjord'], description: 'Fixed test data',
};
const plan: QueryPlan = { metric: 'speed', aggregate: 'avg', bucketMinutes: 60, windowHours: 24, splitByVessel: false, vessel: null, view: 'line' };
const draft = (text: string, revision = 1): Draft => ({ text, revision, contextId: context.id, sentAt: 0 });
const signal = () => new AbortController().signal;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('conservative deterministic templates', () => {
  it.each([
    ['Average speed by hour', plan],
    ['Compare vessel speeds over the last 24 hours', { ...plan, splitByVessel: true }],
    ['Maximum wind by hour', { ...plan, metric: 'wind', aggregate: 'max' }],
    ['Show wave height over the last 7 days', { ...plan, metric: 'wave_height', windowHours: 168 }],
  ])('supports the advertised request: %s', (text, expected) => {
    expect(parseTemplate(text as string, context)).toEqual(expected);
  });

  it('binds exact vessel names, explicit supported buckets and windows', () => {
    expect(parseTemplate('Minimum water temperature for vessel Borealis by 5 minutes over the last 2 days as a bar chart.', context))
      .toEqual({ ...plan, metric: 'water_temp', aggregate: 'min', vessel: 1, bucketMinutes: 5, windowHours: 48, view: 'bar' });
  });

  it.each([
    'Average speed excluding Aurora', 'Average speed where speed > 10', 'Average speed and wind',
    'Not average speed', 'Compare vessel speeds except Borealis', 'Average speed since yesterday',
    'Average speed for vessel Unknown', 'Average speed for vessel 6', 'Maximum wind by 2 minutes',
    'Average speed over the last 0 hours', 'Average speed over the last 337 hours',
    'Average speed over the last 1.5 hours', 'Show wave height over the last 15 days',
    'Average speed by hour; DROP TABLE telemetry',
  ])('does not silently discard unsupported meaning: %s', (text) => {
    expect(parseTemplate(text, context)).toBeNull();
  });
});

describe('untrusted model plan validation', () => {
  it('returns a fresh validated plan', () => {
    expect(validateQueryPlan(plan, context)).toEqual(plan);
    expect(validateQueryPlan(plan, context)).not.toBe(plan);
  });
  it.each([
    null, [], {}, { ...plan, sql: 'SELECT * FROM telemetry' }, { ...plan, metric: 'fuel' },
    { ...plan, aggregate: 'sum' }, { ...plan, windowHours: '24' }, { ...plan, windowHours: Infinity },
    { ...plan, windowHours: 1.5 }, { ...plan, bucketMinutes: 30 }, { ...plan, splitByVessel: 'false' },
    { ...plan, vessel: 6 }, { ...plan, vessel: -1 }, { ...plan, vessel: 0.5 }, { ...plan, view: 'pie' },
  ])('rejects invalid values without coercion: %j', (value) => {
    expect(() => validateQueryPlan(value, context)).toThrow();
  });
  it('also restricts vessel IDs to the current dataset', () => {
    expect(() => validateQueryPlan({ ...plan, vessel: 2 }, { ...context, vessels: ['Aurora'] })).toThrow('Unknown vessel');
  });
  it('rejects partial, fenced and declined output', () => {
    expect(() => parseModelPlan('{"metric":', context)).toThrow('incomplete or invalid JSON');
    expect(() => parseModelPlan('```json\n' + JSON.stringify(plan) + '\n```', context)).toThrow();
    expect(() => parseModelPlan('{"error":"unsupported_request"}', context)).toThrow('cannot be expressed');
  });
  it('checks full prompt limits and context identity', () => {
    expect(() => validateDraft(draft('x'.repeat(4097)), context)).toThrow('4096');
    expect(() => validateDraft({ ...draft('Average speed'), contextId: 'other' }, context)).toThrow('dataset changed');
    expect(() => validateDraft(draft('   '), context)).toThrow('Enter a data request');
    expect(buildSystemPrompt(context)).toContain('2026-09-15T00:00:00.000Z');
    expect(buildSystemPrompt(context)).toContain('fixed dataset end');
  });
});

describe('generation ownership and cancellation', () => {
  it('waits for the old stop acknowledgment and never lets an old cancel interrupt the next generation', async () => {
    const queue = new GenerationQueue();
    const firstBody = deferred<string>();
    const stopFinished = deferred<void>();
    const secondBody = deferred<string>();
    const stopFirst = vi.fn(() => stopFinished.promise);
    const stopSecond = vi.fn();
    const secondTask = vi.fn(() => secondBody.promise);
    const first = queue.run('first', () => firstBody.promise, stopFirst);
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = queue.run('second', secondTask, stopSecond);
    await Promise.resolve();
    queue.cancel('first');
    queue.cancel('first');
    firstBody.resolve('partial output');
    await Promise.resolve();
    expect(stopFirst).toHaveBeenCalledTimes(1);
    expect(secondTask).not.toHaveBeenCalled();
    stopFinished.resolve();
    await firstRejected;
    await vi.waitFor(() => expect(secondTask).toHaveBeenCalledTimes(1));
    queue.cancel('first');
    expect(stopSecond).not.toHaveBeenCalled();
    secondBody.resolve('complete output');
    await expect(second).resolves.toBe('complete output');
  });

  it('skips a canceled queued request without stopping the active generation', async () => {
    const queue = new GenerationQueue();
    const body = deferred<string>();
    const activeStop = vi.fn();
    const queuedTask = vi.fn(async () => 'wrong');
    const first = queue.run('active', () => body.promise, activeStop);
    const canceled = queue.run('queued', queuedTask, vi.fn());
    const canceledRejected = expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    queue.cancel('queued');
    expect(activeStop).not.toHaveBeenCalled();
    body.resolve('ok');
    await first;
    await canceledRejected;
    expect(queuedTask).not.toHaveBeenCalled();
  });
});

describe('adapter behavior', () => {
  it('forwards every draft before model readiness and discards late canceled worker output', async () => {
    const workers: FakeWorker[] = [];
    class FakeWorker {
      messages: WorkerRequest[] = [];
      onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
      onerror = null;
      onmessageerror = null;
      constructor() { workers.push(this); }
      postMessage(message: WorkerRequest) { this.messages.push(message); }
      terminate() {}
      emit(message: WorkerResponse) { this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>); }
    }
    vi.stubGlobal('navigator', { gpu: {} });
    vi.stubGlobal('Worker', FakeWorker);
    const adapter = createInferenceAdapter('auto');
    const preparation = adapter.prepare(context);
    const worker = workers[0];
    adapter.observeDraft(draft('How', 1));
    adapter.observeDraft(draft('How fast', 2));
    expect(worker.messages.filter((message) => message.type === 'draft').map((message) => message.draft.revision)).toEqual([1, 2]);
    await expect(adapter.resolve(draft('Average speed'), signal())).resolves.toMatchObject({ source: 'template' });
    const initialization = worker.messages.find((message) => message.type === 'prepare')!;
    worker.emit({ type: 'ready', id: initialization.id, model: 'test-engine' });
    await preparation;
    const controller = new AbortController();
    const canceled = adapter.resolve(draft('How fast were the boats?', 3), controller.signal);
    const rejected = expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(worker.messages.some((message) => message.type === 'resolve')).toBe(true));
    const first = worker.messages.find((message) => message.type === 'resolve')!;
    controller.abort();
    await rejected;
    expect(worker.messages).toContainEqual({ type: 'cancel', id: first.id });
    const next = adapter.resolve(draft('What were the fastest speeds?', 4), signal());
    await vi.waitFor(() => expect(worker.messages.filter((message) => message.type === 'resolve')).toHaveLength(2));
    const second = worker.messages.filter((message) => message.type === 'resolve')[1];
    worker.emit({ type: 'result', id: first.id, result: { source: 'webgpu', plan: { ...plan, metric: 'wind' } } });
    worker.emit({ type: 'result', id: second.id, result: { source: 'webgpu', plan, model: 'test-engine' } });
    await expect(next).resolves.toMatchObject({ source: 'webgpu', plan });
    adapter.dispose();
  });

  it('reports template-only fallback honestly when WebGPU is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const statuses: AdapterStatus[] = [];
    const adapter = createInferenceAdapter('auto', { onStatus: (status) => statuses.push(status) });
    await adapter.prepare(context);
    expect(statuses.at(-1)?.state).toBe('unavailable');
    await expect(adapter.resolve(draft('Average speed by hour'), signal())).resolves.toMatchObject({ source: 'template', plan });
    await expect(adapter.resolve(draft('How fast were the boats moving?'), signal())).rejects.toThrow('needs a local language model');
    adapter.dispose();
  });

  it('never represents a template as forced WebGPU inference', async () => {
    vi.stubGlobal('navigator', {});
    const adapter = createInferenceAdapter('webgpu');
    await expect(adapter.prepare(context)).rejects.toThrow('WebGPU');
    await expect(adapter.resolve(draft('Average speed by hour'), signal())).rejects.toThrow('needs a local language model');
    adapter.dispose();
  });

  it('checks cancellation even for a template hit', async () => {
    const adapter = createInferenceAdapter('templates');
    await adapter.prepare(context);
    const controller = new AbortController(); controller.abort();
    await expect(adapter.resolve(draft('Average speed'), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    adapter.dispose();
  });

  it('sends a complete remote request and validates the returned plan', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ plan, model: 'real-remote-model', tokens: 48 })));
    const adapter = createInferenceAdapter('remote', { endpoint: 'https://example.test/infer', fetchImpl: fetcher as typeof fetch });
    await adapter.prepare(context);
    adapter.observeDraft(draft('Average')); // No draft endpoint was authorized/configured.
    const result = await adapter.resolve(draft('Average speed', 7), signal());
    expect(fetcher).toHaveBeenCalledTimes(1);
    const request = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(request[1].body as string)).toMatchObject({ text: 'Average speed', revision: 7, context: { id: context.id } });
    expect(result).toEqual({ source: 'remote', plan, model: 'real-remote-model', tokens: 48 });
    adapter.dispose();
  });

  it('rejects unknown SQL fields from a remote service', async () => {
    const adapter = createInferenceAdapter('remote', { endpoint: 'https://example.test/infer',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ plan: { ...plan, sql: 'bad' } }))) as typeof fetch });
    await adapter.prepare(context);
    await expect(adapter.resolve(draft('Average speed'), signal())).rejects.toThrow('unsupported fields');
    adapter.dispose();
  });

  it('aborts only the remote request whose signal was canceled', async () => {
    const calls: AbortSignal[] = [];
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const requestSignal = init!.signal as AbortSignal;
      calls.push(requestSignal);
      requestSignal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true });
    }));
    const adapter = createInferenceAdapter('remote', { endpoint: 'https://example.test/infer', fetchImpl: fetcher as typeof fetch });
    await adapter.prepare(context);
    const firstController = new AbortController();
    const first = adapter.resolve(draft('Average speed', 1), firstController.signal);
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = adapter.resolve(draft('Maximum wind', 2), signal());
    const secondRejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    firstController.abort();
    await firstRejected;
    expect(calls[0].aborted).toBe(true);
    expect(calls[1].aborted).toBe(false);
    adapter.dispose();
    await secondRejected;
  });
});
