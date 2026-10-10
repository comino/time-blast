import type { AdapterStatus, DatasetContext, Draft, InferenceAdapter, InferenceMode, InferenceResult, LocalModelProfile } from '../core/types';
import type { WorkerRequest, WorkerResponse } from './messages';
import { abortError, assertNotAborted, MAX_PROMPT_CHARS, MODEL_RESPONSE_SCHEMA, validateDraft, validateQueryPlan } from './plan';
import { parseTemplate } from './templates';
import { PlanCache } from './plan-cache';
import { readInferenceDiagnostics } from './diagnostics';
import { InferenceFailure, inferenceFailureDetails } from './failure';

export { parseTemplate } from './templates';
export { validateQueryPlan, parseModelPlan, QUERY_PLAN_SCHEMA, MODEL_RESPONSE_SCHEMA } from './plan';

export interface InferenceOptions {
  endpoint?: string;
  /** Explicit opt-in; no draft URL is inferred from the generation endpoint. */
  draftEndpoint?: string;
  onStatus?: (status: AdapterStatus) => void;
  model?: string;
  localModel?: LocalModelProfile;
  cacheModelPlans?: boolean;
  fetchImpl?: typeof fetch;
}

function frozenContext(context: DatasetContext): DatasetContext {
  return { ...context, vessels: [...context.vessels] };
}

export class LocalInferenceAdapter implements InferenceAdapter {
  readonly placement = 'browser' as const;
  readonly id: string;
  private context?: DatasetContext;
  private worker?: Worker;
  private warming?: Promise<void>;
  private ready = false;
  private model?: string;
  private failure?: string;
  private disposed = false;
  private nextId = 0;
  private latestDraft?: Draft;
  private readonly plans = new PlanCache();
  private cacheEnabled: boolean;
  private cacheEpoch = 0;
  private pending = new Map<string, { resolve(value: InferenceResult | undefined): void; reject(error: Error): void; cleanup(): void }>();
  private warmWaiters=new Set<{finish(error?:unknown):void}>();

  constructor(private mode: Exclude<InferenceMode, 'remote'>, private options: InferenceOptions = {}) {
    this.id = mode === 'templates' ? 'deterministic-templates' : `webllm-${mode}`;
    this.cacheEnabled = options.cacheModelPlans !== false;
  }

  /** Fresh inference trials can bypass plan reuse while keeping the engine warm. */
  setPlanCacheEnabled(enabled: boolean): void {
    this.assertLive();
    if (this.cacheEnabled === enabled) return;
    this.cacheEnabled = enabled;
    this.cacheEpoch++;
    this.plans.clear();
  }

  async prepare(context: DatasetContext): Promise<void> {
    this.assertLive();
    if (JSON.stringify(this.context) !== JSON.stringify(context)) {
      this.plans.clear(); this.context = frozenContext(context);
    }
    if (this.mode === 'templates') {
      this.options.onStatus?.({ state: 'ready', label: 'Deterministic templates', detail: 'Limited exact grammar · no language model' });
      return;
    }
    if (!this.warming) {
      const attempt=this.warming=this.warm();
      // One subscription per warmup: canceled edits must not accumulate promise
      // handlers while a large model download is still running.
      void attempt.then(()=>{if(this.warming===attempt)this.finishWarmWaiters();},
        error=>{if(this.warming===attempt)this.finishWarmWaiters(error);});
    }
    const attempt=this.warming;
    try { await attempt; }
    catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      if(this.warming===attempt) {
        this.warming=undefined;
        this.resetWorker(new Error(this.failure));
      }
      if (!this.disposed) this.options.onStatus?.({ state: 'unavailable', label: 'Local model unavailable',
        detail: `${this.failure}${this.mode === 'auto' ? ' Exact templates still work; other requests need a model.' : ''}` });
      if (this.mode === 'webgpu') throw error;
    }
  }

  observeDraft(draft: Draft): void {
    if (this.disposed) return;
    // Retain one snapshot; the extra character preserves detection of over-limit input.
    this.latestDraft = { ...draft, text: draft.text.slice(0, MAX_PROMPT_CHARS + 1) };
    this.worker?.postMessage({ type: 'draft', draft: this.latestDraft } satisfies WorkerRequest);
  }

  async resolve(draft: Draft, signal: AbortSignal): Promise<InferenceResult> {
    const timing: { warmupMs?: number } = {};
    try { return await this.resolvePlan(draft, signal, timing); }
    catch (error) {
      if (signal.aborted) throw abortError();
      const details = inferenceFailureDetails(error);
      throw new InferenceFailure(error, { source: this.mode === 'templates' ? 'template' : 'webgpu',
        model: details.model ?? this.model ?? this.options.model,
        response: details.response,
        diagnostics: { ...details.diagnostics, ...(timing.warmupMs === undefined ? {} : {
          warmupMs: timing.warmupMs + (details.diagnostics?.warmupMs ?? 0),
        }) } });
    }
  }

  private async resolvePlan(draft: Draft, signal: AbortSignal, timing: { warmupMs?: number }): Promise<InferenceResult> {
    this.assertLive();
    assertNotAborted(signal);
    draft = { ...draft };
    const context = this.context;
    if (!context) throw new Error('Prepare a dataset before requesting inference.');
    validateDraft(draft, context);
    if (this.mode !== 'webgpu') {
      const plan = parseTemplate(draft.text, context);
      if (plan) return { plan, source: 'template', model: 'Exact template grammar' };
      if (this.mode === 'templates') throw new Error('This wording is outside the deterministic template grammar. Choose Auto, Local WebGPU or remote inference.');
    }
    const cacheEpoch = this.cacheEpoch;
    const cached = this.cacheEnabled ? this.plans.get(draft.text, context) : undefined;
    if (cached) return cached;
    let warmupMs = timing.warmupMs = 0;
    if (this.warming&&!this.ready) {
      const waitingAt = performance.now();
      try { await this.waitForWarm(signal); }
      catch (error) { if (signal.aborted) throw abortError(); }
      warmupMs = timing.warmupMs = performance.now() - waitingAt;
    }
    assertNotAborted(signal);
    this.assertLive();
    if (!this.ready || !this.worker) throw new Error(`This request needs a local language model. ${this.failure ?? 'The WebGPU model is not ready.'}`);
    const result = await this.request({ type: 'resolve', draft: { ...draft }, context }, signal);
    assertNotAborted(signal);
    if (!result) throw new Error('The local model returned no query plan.');
    const diagnostics = readInferenceDiagnostics(result.diagnostics);
    let validated: InferenceResult;
    try {
      validated = { ...result, plan: validateQueryPlan(result.plan, context), source: 'webgpu',
        diagnostics: { ...diagnostics, warmupMs: warmupMs + (diagnostics?.warmupMs ?? 0) } };
    } catch (error) { throw new InferenceFailure(error, { ...result, source: 'webgpu', diagnostics }); }
    if (this.cacheEnabled && this.cacheEpoch === cacheEpoch && this.context === context && !this.disposed) this.plans.set(draft.text, context, validated);
    return validated;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.plans.clear();
    this.ready = false;
    this.finishWarmWaiters(abortError());
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(abortError()); }
    this.pending.clear();
    this.worker?.terminate();
    this.worker = undefined;
  }

  private assertLive(): void { if (this.disposed) throw new Error('Inference adapter has been disposed.'); }

  private waitForWarm(signal:AbortSignal):Promise<void> {
    assertNotAborted(signal);
    if(this.warmWaiters.size>=2)return Promise.reject(new Error('Inference admission queue is full.'));
    return new Promise((resolve,reject)=>{
      const abort=()=>waiter.finish(abortError());
      const waiter={finish:(error?:unknown)=>{
        this.warmWaiters.delete(waiter);signal.removeEventListener('abort',abort);
        if(error!==undefined)reject(error);else resolve();
      }};
      this.warmWaiters.add(waiter);signal.addEventListener('abort',abort,{once:true});
    });
  }
  private finishWarmWaiters(error?:unknown):void {
    for(const waiter of this.warmWaiters)waiter.finish(error);
  }

  private resetWorker(error:Error):void {
    this.ready=false;
    this.plans.clear();
    this.finishWarmWaiters(error);
    for(const pending of this.pending.values()){pending.cleanup();pending.reject(error);}
    this.pending.clear();
    this.worker?.terminate();this.worker=undefined;
  }

  private async warm(): Promise<void> {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) throw new Error('WebGPU is not exposed by this browser.');
    if (typeof Worker === 'undefined') throw new Error('Web workers are unavailable.');
    this.options.onStatus?.({ state: 'loading', label: 'Starting local WebGPU model', progress: 0,
      detail: 'Downloading model weights when absent from browser cache' });
    const worker=this.worker = new Worker(new URL('./webllm.worker.ts', import.meta.url), { type: 'module', name: 'time-blast-inference' });
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      if (this.disposed||this.worker!==worker) return;
      if (data.type === 'status') { this.options.onStatus?.(data.status); return; }
      // WebLLM can unload after device loss without crashing this worker. Invalidate
      // that engine even when its request was canceled and has no pending listener.
      if(data.type==='error'&&(data.name==='ModelNotLoadedError'||data.name==='DeviceLostError')) {
        // Only this generation owns its measurements; other queued requests get
        // the device-loss error without inheriting work they did not perform.
        const pending=this.pending.get(data.id);
        if(pending) {
          this.pending.delete(data.id);pending.cleanup();
          const error=new Error(data.message);error.name=data.name;
          pending.reject(new InferenceFailure(error,{source:'webgpu',model:data.inference?.model??this.model,
            diagnostics:data.inference?.diagnostics,response:data.inference?.response}));
        }
        fail(data.message,data.name);return;
      }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      pending.cleanup();
      if (data.type === 'error') {
        const error = new Error(data.message); error.name = data.name ?? 'Error';
        pending.reject(new InferenceFailure(error, { source: 'webgpu', model: data.inference?.model ?? this.model,
          diagnostics: data.inference?.diagnostics, response: data.inference?.response }));
      } else {
        if (data.type === 'ready') { this.ready = true; this.model = data.model; }
        pending.resolve(data.type === 'result' ? data.result : undefined);
      }
    };
    const fail = (message: string, name='Error') => {
      if(this.disposed||this.worker!==worker)return;
      this.failure = message; this.ready = false;
      const error=new Error(message);error.name=name;
      this.resetWorker(error);
      this.warming=undefined;
      this.options.onStatus?.({ state: 'error', label: 'Local model stopped', detail: message });
    };
    worker.onerror = (event) => fail(event.message || 'Unable to load the local model worker.');
    worker.onmessageerror = () => fail('Unable to decode a message from the local model worker.');
    if (this.latestDraft) worker.postMessage({ type: 'draft', draft: this.latestDraft } satisfies WorkerRequest);
    await this.request({ type: 'prepare', model: this.options.model, localModel: this.options.localModel });
  }

  private request(message: { type: 'prepare'; model?: string; localModel?: LocalModelProfile } | { type: 'resolve'; draft: Draft; context: DatasetContext }, signal?: AbortSignal): Promise<InferenceResult | undefined> {
    if (signal) assertNotAborted(signal);
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('The local model worker is unavailable.'));
    const id = `inference-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (!this.pending.delete(id)) return;
        signal?.removeEventListener('abort', abort);
        worker.postMessage({ type: 'cancel', id } satisfies WorkerRequest);
        reject(abortError());
      };
      this.pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true });
      try { worker.postMessage({ ...message, id } satisfies WorkerRequest); }
      catch (error) { this.pending.delete(id); signal?.removeEventListener('abort', abort); reject(error); }
    });
  }
}

function endpointURL(value: string | undefined): string {
  if (!value?.trim()) throw new Error('Configure a remote inference endpoint first.');
  const base = typeof location === 'undefined' ? 'http://localhost' : location.href;
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Inference endpoints must be HTTP(S) URLs without embedded credentials.');
  return url.href;
}

async function readBoundedJSON(response: Response): Promise<unknown> {
  const limit = 65_536;
  if (Number(response.headers.get('content-length')) > limit) { void response.body?.cancel(); throw new Error('Remote inference response is too large.'); }
  if (!response.body) throw new Error('Remote inference returned an empty response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new Error('Remote inference response is too large.'); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  try { return JSON.parse(text); } catch { throw new Error('Remote inference returned invalid JSON.'); }
}

export class RemoteInferenceAdapter implements InferenceAdapter {
  readonly placement = 'remote' as const;
  readonly id = 'remote-inference';
  private context?: DatasetContext;
  private endpoint?: string;
  private draftEndpoint?: string;
  private disposed = false;
  private controllers = new Set<AbortController>();
  private latestDraft?: Draft;
  private draftTimer?: ReturnType<typeof setTimeout>;
  private draftSending = false;
  private fetcher: typeof fetch;

  constructor(private options: InferenceOptions = {}) { this.fetcher = options.fetchImpl ?? fetch; }

  async prepare(context: DatasetContext): Promise<void> {
    if (this.disposed) throw new Error('Inference adapter has been disposed.');
    this.context = frozenContext(context);
    this.endpoint = endpointURL(this.options.endpoint);
    this.draftEndpoint = this.options.draftEndpoint ? endpointURL(this.options.draftEndpoint) : undefined;
    this.options.onStatus?.({ state: 'ready', label: 'Remote inference configured',
      detail: 'Endpoint configured; model/cache readiness is determined by the remote service' });
  }

  observeDraft(draft: Draft): void {
    if (this.disposed || !this.draftEndpoint) return;
    this.latestDraft = { ...draft, text: draft.text.slice(0, MAX_PROMPT_CHARS + 1) };
    if (!this.draftTimer && !this.draftSending) this.draftTimer = setTimeout(() => { this.draftTimer = undefined; void this.flushDraft(); }, 25);
  }

  async resolve(draft: Draft, signal: AbortSignal): Promise<InferenceResult> {
    if (this.disposed) throw new Error('Inference adapter has been disposed.');
    assertNotAborted(signal);
    const context = this.context;
    if (!context || !this.endpoint) throw new Error('Prepare a dataset and remote endpoint before inference.');
    validateDraft(draft, context);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    this.controllers.add(controller);
    let diagnostics: InferenceResult['diagnostics'], model: string | undefined;
    try {
      const response = await this.fetcher(this.endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ text: draft.text, revision: draft.revision, draft, context, schema: MODEL_RESPONSE_SCHEMA }),
      });
      if (!response.ok) { void response.body?.cancel(); throw new Error(`Remote inference failed (${response.status}).`); }
      const payload = await readBoundedJSON(response);
      assertNotAborted(signal);
      if (controller.signal.aborted) throw abortError();
      const envelope = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
      diagnostics = readInferenceDiagnostics(envelope?.diagnostics);
      model = typeof envelope?.model === 'string' ? envelope.model.slice(0, 200) : undefined;
      const plan = validateQueryPlan(envelope && 'plan' in envelope ? envelope.plan : payload, context);
      return { plan, source: 'remote',
        model,
        tokens: typeof envelope?.tokens === 'number' && Number.isSafeInteger(envelope.tokens) && envelope.tokens >= 0 ? envelope.tokens : undefined,
        ...(diagnostics ? { diagnostics } : {}),
      };
    } catch (error) {
      if (signal.aborted || controller.signal.aborted) throw abortError();
      throw new InferenceFailure(error, { source: 'remote', model, diagnostics });
    } finally { signal.removeEventListener('abort', abort); this.controllers.delete(controller); }
  }

  dispose(): void {
    this.disposed = true;
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.latestDraft = undefined;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  private async flushDraft(): Promise<void> {
    const draft = this.latestDraft;
    if (!draft || !this.draftEndpoint || this.disposed) return;
    this.latestDraft = undefined;
    this.draftSending = true;
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await this.fetcher(this.draftEndpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ type: 'DRAFT', draft, contextId: draft.contextId }),
      });
      void response.body?.cancel();
    } catch { /* Draft transmission is best effort; resolve always sends the full immutable text. */ }
    finally {
      clearTimeout(timeout); this.controllers.delete(controller); this.draftSending = false;
      if (this.latestDraft && !this.disposed) void this.flushDraft();
    }
  }
}

export function createInferenceAdapter(mode: InferenceMode, options: InferenceOptions = {}): InferenceAdapter {
  return mode === 'remote' ? new RemoteInferenceAdapter(options) : new LocalInferenceAdapter(mode, options);
}
