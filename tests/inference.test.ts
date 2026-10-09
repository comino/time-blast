import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterStatus, DatasetContext, Draft, QueryPlan } from '../src/core/types';
import { CHART_VIEWS } from '../src/core/types';
import { MAX_WINDOW_HOURS } from '../src/core/query-limits';
import { createInferenceAdapter, parseTemplate, parseModelPlan, validateQueryPlan } from '../src/inference';
import { buildSystemPrompt, QUERY_PLAN_SCHEMA, validateDraft } from '../src/inference/plan';
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
    ['Show wave height over the last 15 days', { ...plan, metric: 'wave_height', windowHours: 360 }],
    ['Average speed over the last 337 hours', { ...plan, windowHours: 337 }],
    ['Compare vessel wave height by hour over the last 710 days as a 3D surface', { ...plan, metric: 'wave_height', windowHours: 17040, splitByVessel: true, view: 'surface' }],
  ])('supports the advertised request: %s', (text, expected) => {
    expect(parseTemplate(text as string, context)).toEqual(expected);
  });

  it('binds exact vessel names, explicit supported buckets and windows', () => {
    expect(parseTemplate('Minimum water temperature for vessel Borealis by 5 minutes over the last 2 days as a bar chart.', context))
      .toEqual({ ...plan, metric: 'water_temp', aggregate: 'min', vessel: 1, bucketMinutes: 5, windowHours: 48, view: 'bar' });
  });

  it.each([
    ['1days', 24], ['1day', 24], ['1 days', 24], ['1 day', 24], ['1\tday', 24],
    ['710days', 17040], ['710 days', 17040], ['24hours', 24], ['24 hours', 24], ['1hour', 1],
  ])('accepts numeric window spacing in the reported surface request: %s', (window, windowHours) => {
    expect(parseTemplate(`Compare vessel wave height by hour over the last ${window} as a 3D surface`, context))
      .toEqual({ ...plan, metric: 'wave_height', windowHours, splitByVessel: true, view: 'surface' });
  });

  it.each([
    ['Show a heatmap of vessel speeds by hour over the last 7 days', { ...plan, view: 'heatmap', windowHours: 168, splitByVessel: true }],
    ['Compare vessel wave height by hour over the last 7 days as a 3D surface', { ...plan, metric: 'wave_height', view: 'surface', windowHours: 168, splitByVessel: true }],
    ['Show a scatter plot of maximum wind by 5 minutes over the last 2 days', { ...plan, metric: 'wind', aggregate: 'max', view: 'scatter', bucketMinutes: 5, windowHours: 48 }],
    ['Show a data table of minimum water temperature for vessel Borealis by hour', { ...plan, metric: 'water_temp', aggregate: 'min', vessel: 1, view: 'table' }],
    ['Show a geographic map of vessel speeds by hour over the last 7 days', { ...plan, view: 'map', windowHours: 168, splitByVessel: true }],
    ['Show a density map of vessel speeds by hour', { ...plan, view: 'density', splitByVessel: true }],
    ['Show voyage tracks of speed for vessel Aurora by minute', { ...plan, view: 'tracks', vessel: 0, bucketMinutes: 1, splitByVessel: true }],
    ['Compare vessel water temperature over the last 14 days as a seasonal wheel', { ...plan, metric: 'water_temp', view: 'seasons', windowHours: 336, splitByVessel: true }],
    ['Plot a surface plot of fleet wave height', { ...plan, metric: 'wave_height', view: 'surface', splitByVessel: true }],
    ['Show a heatmap of average wind', { ...plan, metric: 'wind', view: 'heatmap' }],
  ])('selects the requested view without losing the query meaning: %s', (text, expected) => {
    expect(parseTemplate(text as string, context)).toEqual(expected);
  });

  it('does not mutate the immutable request or context to normalize visualization wording', () => {
    const request = Object.freeze(draft('  Show a HEATMAP of vessel speeds by hour over the last 7 days.  ', 11));
    const before = { ...request };
    expect(parseTemplate(request.text, context)?.view).toBe('heatmap');
    expect(request).toEqual(before);
    expect(request.contextId).toBe(context.id);
  });

  it.each([
    'Average speed excluding Aurora', 'Average speed where speed > 10', 'Average speed and wind',
    'Not average speed', 'Compare vessel speeds except Borealis', 'Average speed since yesterday',
    'Average speed for vessel Unknown', 'Average speed for vessel 6', 'Maximum wind by 2 minutes',
    'Average speed over the last 0 hours', 'Average speed over the last 4294967296hours',
    'Average speed over the last 1.5 hours', 'Show wave height over the last 178956971days',
    'Average speed by hour; DROP TABLE telemetry',
    'Show a heatmap of vessel speeds excluding Aurora',
    'Compare vessel wave height by hour over the last 7 days as a 3D surface where speed > 10',
    'Compare vessel wave height by hour over the last 1days as a 3D surface excluding Aurora',
    'Compare vessel wave height by hour over the last 710days as a 3D surface where speed > 10',
    'Compare vessel wave height by hour over the last 1days as a 3D surface and wind',
    'Compare vessel wave height by hour over the last 1daysish as a 3D surface',
    'Show a scatter plot of speed versus wind',
    'Show a geographic map of vessel speeds except Borealis',
    'Show a density map of vessel speeds weighted by speed',
    'Show a seasonal wheel of average water temperature by month',
    'Show a seasonal wheel of water temperature over the last 2 years',
    'Show a photo gallery of vessels', 'Show photos of vessel Aurora',
    'Show a heatmap of wind as a bar chart',
  ])('does not silently discard unsupported meaning: %s', (text) => {
    expect(parseTemplate(text, context)).toBeNull();
  });
});

describe('untrusted model plan validation', () => {
  it('returns a fresh validated plan', () => {
    expect(validateQueryPlan(plan, context)).toEqual(plan);
    expect(validateQueryPlan(plan, context)).not.toBe(plan);
  });
  it.each([337, 15 * 24, 710 * 24, MAX_WINDOW_HOURS])('keeps a %s hour request intact beyond sample coverage', windowHours => {
    expect(validateQueryPlan({ ...plan, windowHours }, context)).toEqual({ ...plan, windowHours });
    expect(QUERY_PLAN_SCHEMA.properties.windowHours.maximum).toBe(MAX_WINDOW_HOURS);
  });
  it.each(CHART_VIEWS)('validates %s as presentation intent without adding query fields', (view) => {
    const expected = { ...plan, view, splitByVessel: true };
    expect(parseModelPlan(JSON.stringify(expected), context)).toEqual(expected);
    expect(QUERY_PLAN_SCHEMA.properties.view.enum).toContain(view);
  });
  it.each(['map', 'density', 'tracks'])('rejects %s plans that would average positions across vessels', (view) => {
    expect(() => validateQueryPlan({ ...plan, view }, context)).toThrow('separate vessel positions');
  });
  it.each([
    null, [], {}, { ...plan, sql: 'SELECT * FROM telemetry' }, { ...plan, metric: 'fuel' },
    { ...plan, aggregate: 'sum' }, { ...plan, windowHours: '24' }, { ...plan, windowHours: Infinity },
    { ...plan, windowHours: NaN }, { ...plan, windowHours: 0 }, { ...plan, windowHours: -1 },
    { ...plan, windowHours: MAX_WINDOW_HOURS + 1 }, { ...plan, windowHours: 1.5 }, { ...plan, bucketMinutes: 30 }, { ...plan, splitByVessel: 'false' },
    { ...plan, vessel: 6 }, { ...plan, vessel: -1 }, { ...plan, vessel: 0.5 }, { ...plan, view: 'pie' },
    { ...plan, view: 'gallery' }, { ...plan, view: 'scatter', secondMetric: 'wind' },
  ])('rejects invalid values without coercion: %j', (value) => {
    expect(() => validateQueryPlan(value, context)).toThrow();
  });
  it('also restricts vessel IDs to the current dataset', () => {
    expect(() => validateQueryPlan({ ...plan, vessel: 2 }, { ...context, vessels: ['Aurora'] })).toThrow('Unknown vessel');
  });
  it('rejects partial, fenced and declined output', () => {
    expect(() => parseModelPlan('{"metric":', context)).toThrow('incomplete or invalid JSON');
    expect(() => parseModelPlan('```json\n' + JSON.stringify(plan) + '\n```', context)).toThrow();
    expect(() => parseModelPlan('{"error":"unsupported_request"}', context)).toThrow('The model marked this request as unsupported.');
  });
  it('checks full prompt limits and context identity', () => {
    expect(() => validateDraft(draft('x'.repeat(4097)), context)).toThrow('4096');
    expect(() => validateDraft({ ...draft('Average speed'), contextId: 'other' }, context)).toThrow('dataset changed');
    expect(() => validateDraft(draft('   '), context)).toThrow('Enter a data request');
    expect(buildSystemPrompt(context)).toContain('2026-09-15T00:00:00.000Z');
    expect(buildSystemPrompt(context)).toContain('fixed dataset end');
  });
  it('describes view semantics and declines unsupported dimensions rather than changing the data', () => {
    const prompt = buildSystemPrompt(context);
    expect(prompt).toContain(CHART_VIEWS.join('|'));
    expect(prompt).toContain('scatter does not compare two metrics');
    expect(prompt).toContain('counts of returned bucket-mean positions');
    expect(prompt).toContain('no monthly/seasonal aggregation');
    expect(prompt).toContain('Photo galleries, photos, image URLs');
    expect(prompt).toContain('Requested windows may exceed coverage. Preserve the requested windowHours');
    expect(prompt).toContain('1days or 1day means windowHours 24');
    expect(prompt).not.toContain('at most 14 days');
  });
});

describe('generation ownership and cancellation', () => {
  it('bounds admission and immediately releases canceled waiters behind a stalled task',async()=>{
    const queue=new GenerationQueue();const body=deferred<string>();
    const active=queue.run('active',()=>body.promise,()=>{});await Promise.resolve();
    for(let i=0;i<100;i++) {
      const waiting=queue.run(`wait-${i}`,async()=> 'obsolete',()=>{});
      await expect(queue.run(`overflow-${i}`,async()=> 'overflow',()=>{})).rejects.toThrow('queue is full');
      queue.cancel(`wait-${i}`);
      await expect(waiting).rejects.toMatchObject({name:'AbortError'});
    }
    const latest=queue.run('latest',async()=> 'current',()=>{});
    body.resolve('done');await active;await expect(latest).resolves.toBe('current');
  });
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
  it('releases canceled edits during cold warmup and admits only the latest after readiness',async()=>{
    let worker:any;
    vi.stubGlobal('navigator',{gpu:{}});
    vi.stubGlobal('Worker',class {
      messages:WorkerRequest[]=[];onmessage:any;terminate(){};
      constructor(){worker=this;}postMessage(message:WorkerRequest){this.messages.push(message);}
    });
    const adapter=createInferenceAdapter('webgpu');const preparation=adapter.prepare(context);
    for(let i=0;i<50;i++) {
      const controller=new AbortController();const remove=vi.spyOn(controller.signal,'removeEventListener');
      const result=adapter.resolve(draft('Please show vessel speeds',i),controller.signal);
      controller.abort();await expect(result).rejects.toMatchObject({name:'AbortError'});
      expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));
    }
    const latest=adapter.resolve(draft('Please show the latest vessel speeds',51),signal());
    worker.onmessage({data:{type:'ready',id:worker.messages[0].id,model:'test'}});await preparation;
    await vi.waitFor(()=>expect(worker.messages.filter((message:WorkerRequest)=>message.type==='resolve')).toHaveLength(1));
    const request=worker.messages.find((message:WorkerRequest)=>message.type==='resolve');
    expect(request.draft.revision).toBe(51);
    worker.onmessage({data:{type:'result',id:request.id,result:{source:'webgpu',plan}}});await expect(latest).resolves.toMatchObject({plan});adapter.dispose();
  });
  it('retries failed preparation with a fresh worker and retains a successful worker',async()=>{
    const workers:any[]=[];
    class Worker {
      messages:WorkerRequest[]=[];onmessage:any;onerror:any;terminate=vi.fn();
      constructor(){workers.push(this);}postMessage(message:WorkerRequest){this.messages.push(message);}
    }
    vi.stubGlobal('navigator',{gpu:{}});vi.stubGlobal('Worker',Worker);
    const adapter=createInferenceAdapter('webgpu');const first=adapter.prepare(context);
    const rejected=expect(first).rejects.toThrow('Temporary download failure');
    workers[0].onmessage({data:{type:'error',id:workers[0].messages[0].id,message:'Temporary download failure'}});await rejected;
    const retry=adapter.prepare(context);expect(workers).toHaveLength(2);expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    workers[1].onmessage({data:{type:'ready',id:workers[1].messages[0].id,model:'test'}});await retry;
    workers[0].onerror({message:'Late failure from replaced worker'});
    await adapter.prepare(context);expect(workers).toHaveLength(2);
    workers[1].onerror({message:'Device lost'});
    const restart=adapter.prepare(context);expect(workers).toHaveLength(3);
    workers[2].onmessage({data:{type:'ready',id:workers[2].messages[0].id,model:'test'}});await restart;adapter.dispose();
  });
  it.each(['ModelNotLoadedError','DeviceLostError'])('invalidates a lost engine on %s and permits explicit preparation to recover',async name=>{
    const workers:any[]=[];const statuses:AdapterStatus[]=[];
    vi.stubGlobal('navigator',{gpu:{}});
    vi.stubGlobal('Worker',class {
      messages:WorkerRequest[]=[];onmessage:any;terminate=vi.fn();
      constructor(){workers.push(this);}postMessage(message:WorkerRequest){this.messages.push(message);}
    });
    const adapter=createInferenceAdapter('webgpu',{onStatus:status=>statuses.push(status)});
    const preparation=adapter.prepare(context);const first=workers[0];
    first.onmessage({data:{type:'ready',id:first.messages[0].id,model:'test'}});await preparation;
    const active=adapter.resolve(draft('Average speed by hour'),signal());
    const waiting=adapter.resolve(draft('Maximum wind by hour',2),signal());
    const rejected=Promise.all([expect(active).rejects.toMatchObject({name}),expect(waiting).rejects.toMatchObject({name})]);
    const request=first.messages.find((message:WorkerRequest)=>message.type==='resolve');
    first.onmessage({data:{type:'error',id:request.id,name,message:'The model engine was unloaded'}});await rejected;
    expect(first.terminate).toHaveBeenCalledOnce();expect(statuses.at(-1)?.state).toBe('error');
    await expect(adapter.resolve(draft('Average speed by hour'),signal())).rejects.toThrow('needs a local language model');
    const retry=adapter.prepare(context);expect(workers).toHaveLength(2);
    const second=workers[1];second.onmessage({data:{type:'ready',id:second.messages[0].id,model:'test'}});await retry;
    first.onmessage({data:{type:'error',id:request.id,name,message:'Late old engine failure'}});
    const recovered=adapter.resolve(draft('Average speed by hour'),signal());
    const replacement=second.messages.find((message:WorkerRequest)=>message.type==='resolve');
    second.onmessage({data:{type:'result',id:replacement.id,result:{source:'webgpu',plan}}});
    await expect(recovered).resolves.toMatchObject({plan});expect(second.terminate).not.toHaveBeenCalled();adapter.dispose();
  });
  it('handles fatal engine errors after their request was canceled but retains workers after semantic errors',async()=>{
    const workers:any[]=[];vi.stubGlobal('navigator',{gpu:{}});
    vi.stubGlobal('Worker',class {
      messages:WorkerRequest[]=[];onmessage:any;terminate=vi.fn();
      constructor(){workers.push(this);}postMessage(message:WorkerRequest){this.messages.push(message);}
    });
    const adapter=createInferenceAdapter('webgpu');const preparation=adapter.prepare(context);const worker=workers[0];
    worker.onmessage({data:{type:'ready',id:worker.messages[0].id,model:'test'}});await preparation;
    const unsupported=adapter.resolve(draft('An unsupported data request'),signal());
    const rejected=expect(unsupported).rejects.toThrow('unsupported');
    const first=worker.messages.find((message:WorkerRequest)=>message.type==='resolve');
    worker.onmessage({data:{type:'error',id:first.id,name:'Error',message:'This request is unsupported'}});await rejected;
    await adapter.prepare(context);expect(workers).toHaveLength(1);expect(worker.terminate).not.toHaveBeenCalled();
    const controller=new AbortController();const canceled=adapter.resolve(draft('Average speed by hour'),controller.signal);
    const aborted=expect(canceled).rejects.toMatchObject({name:'AbortError'});controller.abort();await aborted;
    const last=worker.messages.filter((message:WorkerRequest)=>message.type==='resolve').at(-1);
    worker.onmessage({data:{type:'error',id:last.id,name:'ModelNotLoadedError',message:'Model was unloaded'}});
    expect(worker.terminate).toHaveBeenCalledOnce();adapter.dispose();
  });
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

  it('accepts a wide remote plan against coverage extending beyond the demo dataset', async () => {
    const remoteContext = { ...context, id: 'remote-history', start: Date.UTC(2020, 0, 1) };
    const widePlan = { ...plan, windowHours: 710 * 24 };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ plan: widePlan })));
    const adapter = createInferenceAdapter('remote', { endpoint: 'https://example.test/infer', fetchImpl: fetcher as typeof fetch });
    await adapter.prepare(remoteContext);
    const request = { ...draft('Average speed over the last 710 days'), contextId: remoteContext.id };
    await expect(adapter.resolve(request, signal())).resolves.toMatchObject({ source: 'remote', plan: widePlan });
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
