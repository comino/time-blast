import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatasetContext, Draft, InferenceResult, QueryPlan } from '../src/core/types';
import { LocalInferenceAdapter } from '../src/inference';
import type { WorkerRequest, WorkerResponse } from '../src/inference/messages';
import { MAX_PROMPT_CHARS } from '../src/inference/plan';
import { PlanCache } from '../src/inference/plan-cache';

const context: DatasetContext = {
  id: 'cache-fleet', label: 'Fleet', rowCount: 100,
  start: Date.UTC(2026, 8, 1), end: Date.UTC(2026, 8, 15),
  vessels: ['Aurora', 'Meridian'], description: 'Fixed cache test dataset',
};
const plan: QueryPlan = {
  metric: 'speed', aggregate: 'avg', bucketMinutes: 60, windowHours: 24,
  splitByVessel: false, vessel: null, view: 'line',
};
const result = (): InferenceResult => ({
  plan: { ...plan }, source: 'webgpu', model: 'test-qwen', tokens: 37,
  diagnostics: { promptTokens: 555, completionTokens: 37, prefillMs: 100, decodeMs: 200 },
});
const draft = (text = 'How fast were the boats?', revision = 1): Draft => ({
  text, revision, contextId: context.id, sentAt: 0,
});
const signal = () => new AbortController().signal;

describe('bounded exact inference plan cache', () => {
  it('owns inserted plans and returns new plans without old generation telemetry', () => {
    const cache = new PlanCache(), input = result();
    cache.set('request', context, input);
    input.plan.metric = 'wind';
    const hit = cache.get('request', context)!;
    expect(hit).toEqual({ plan, source: 'webgpu', model: 'test-qwen', diagnostics: { cacheHit: true } });
    hit.plan.metric = 'water_temp';
    expect(cache.get('request', context)?.plan).toEqual(plan);
  });

  it('requires exact prompt bytes rather than normalized or similar wording', () => {
    const cache = new PlanCache();
    cache.set('Average speed', context, result());
    for (const text of ['average speed', 'Average speed ', ' Average speed', 'Average wind', 'Average\u00a0speed']) {
      expect(cache.get(text, context)).toBeUndefined();
    }
    expect(cache.get('Average speed', context)?.plan).toEqual(plan);
  });

  it('separates dataset identities, temporal anchors and ordered vessel catalogs', () => {
    const cache = new PlanCache();
    cache.set('request', context, result());
    for (const changed of [
      { ...context, id: 'other' }, { ...context, start: context.start + 1 },
      { ...context, end: context.end + 1 }, { ...context, vessels: [...context.vessels].reverse() },
      { ...context, vessels: ['Aurora', 'Other'] },
    ]) expect(cache.get('request', changed)).toBeUndefined();
    expect(cache.get('request', { ...context, vessels: [...context.vessels] })?.plan).toEqual(plan);
  });

  it('evicts the least recently used plan and keeps replacements within its bound', () => {
    const cache = new PlanCache(2);
    cache.set('first', context, result()); cache.set('second', context, result());
    cache.get('first', context);
    cache.set('third', context, result());
    expect(cache.get('second', context)).toBeUndefined();
    cache.set('first', context, { ...result(), plan: { ...plan, metric: 'wind' } });
    expect(cache.get('third', context)?.plan).toEqual(plan);
    expect(cache.get('first', context)?.plan.metric).toBe('wind');
    cache.clear();
    expect(cache.get('first', context)).toBeUndefined();
    expect(cache.get('third', context)).toBeUndefined();
  });

  it('rejects invalid capacities instead of allowing unbounded or nonterminating eviction', () => {
    for (const capacity of [-1, NaN, Infinity, 1.5]) expect(() => new PlanCache(capacity)).toThrow();
  });

  it('does not admit invalid plans or oversized prompts', () => {
    const cache = new PlanCache();
    expect(() => cache.set('invalid', context, { ...result(), plan: { ...plan, bucketMinutes: 2 } })).toThrow();
    expect(cache.get('invalid', context)).toBeUndefined();
    const largest = 'x'.repeat(MAX_PROMPT_CHARS);
    cache.set(largest, context, result()); cache.set(largest + 'x', context, result());
    expect(cache.get(largest, context)?.plan).toEqual(plan);
    expect(cache.get(largest + 'x', context)).toBeUndefined();
  });
});

class FakeWorker {
  messages: WorkerRequest[] = [];
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror = null;
  onmessageerror = null;
  postMessage(message: WorkerRequest) { this.messages.push(message); }
  terminate() {}
  emit(message: WorkerResponse) { this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>); }
  resolves() { return this.messages.filter((message): message is Extract<WorkerRequest, { type: 'resolve' }> => message.type === 'resolve'); }
  answer(index: number, value = result()) {
    this.emit({ type: 'result', id: this.resolves()[index].id, result: value });
  }
}
const adapters: LocalInferenceAdapter[] = [];
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.dispose(); vi.unstubAllGlobals(); });

async function prepared() {
  let worker!: FakeWorker;
  vi.stubGlobal('navigator', { gpu: {} });
  vi.stubGlobal('Worker', class extends FakeWorker { constructor() { super(); worker = this; } });
  const adapter = new LocalInferenceAdapter('webgpu'); adapters.push(adapter);
  const warming = adapter.prepare(context);
  const request = worker.messages.find((message) => message.type === 'prepare')!;
  worker.emit({ type: 'ready', id: request.id, model: 'test-qwen' }); await warming;
  return { adapter, worker };
}

describe('local inference cache integration', () => {
  it('skips worker generation for an exact repeat at a newer revision', async () => {
    const { adapter, worker } = await prepared();
    const first = adapter.resolve(draft(), signal()); worker.answer(0);
    const generated = await first; generated.plan.metric = 'wind';
    const hit = await adapter.resolve(draft(undefined, 99), signal());
    expect(worker.resolves()).toHaveLength(1);
    expect(hit).toEqual({ plan, source: 'webgpu', model: 'test-qwen', diagnostics: { cacheHit: true } });
    const controller = new AbortController(); controller.abort();
    await expect(adapter.resolve(draft(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.resolves()).toHaveLength(1);
  });

  it('does not cache a canceled request even if the worker replies later', async () => {
    const { adapter, worker } = await prepared();
    const controller = new AbortController(), first = adapter.resolve(draft(), controller.signal);
    const aborted = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await aborted; worker.answer(0);
    const retry = adapter.resolve(draft(undefined, 2), signal());
    expect(worker.resolves()).toHaveLength(2); worker.answer(1); await retry;
  });

  it('rejects invalid worker results and retries instead of caching failure', async () => {
    const { adapter, worker } = await prepared();
    const first = adapter.resolve(draft(), signal());
    worker.answer(0, { ...result(), plan: { ...plan, vessel: 4 } });
    await expect(first).rejects.toThrow('Unknown vessel');
    const retry = adapter.resolve(draft(undefined, 2), signal());
    expect(worker.resolves()).toHaveLength(2); worker.answer(1); await retry;
  });

  it('clears cached plans when dataset metadata changes despite the same context ID', async () => {
    const { adapter, worker } = await prepared();
    const first = adapter.resolve(draft(), signal()); worker.answer(0); await first;
    await adapter.prepare({ ...context, rowCount: 200 });
    const retry = adapter.resolve(draft(undefined, 2), signal());
    expect(worker.resolves()).toHaveLength(2); worker.answer(1); await retry;
  });

  it('never inserts an in-flight result after its prepared context was replaced', async () => {
    const { adapter, worker } = await prepared();
    const first = adapter.resolve(draft(), signal());
    await adapter.prepare({ ...context, rowCount: 200 });
    worker.answer(0); await first;
    const retry = adapter.resolve(draft(undefined, 2), signal());
    expect(worker.resolves()).toHaveLength(2); worker.answer(1); await retry;
  });

  it('binds cache admission to the exact draft snapshot sent to the worker', async () => {
    const { adapter, worker } = await prepared();
    const mutable = draft(), first = adapter.resolve(mutable, signal());
    mutable.text = 'What was the wind doing?';
    worker.answer(0); await first;
    const changed = adapter.resolve({ ...mutable, revision: 2 }, signal());
    expect(worker.resolves()).toHaveLength(2);
    worker.answer(1, { ...result(), plan: { ...plan, metric: 'wind' } });
    expect((await changed).plan.metric).toBe('wind');
    expect((await adapter.resolve(draft(undefined, 3), signal())).plan.metric).toBe('speed');
    expect(worker.resolves()).toHaveLength(2);
  });
});
