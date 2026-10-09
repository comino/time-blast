import { CreateMLCEngine, prebuiltAppConfig, type MLCEngine } from '@mlc-ai/web-llm';
import type { Draft, InferenceDiagnostics } from '../core/types';
import { GenerationQueue } from './generation';
import type { WorkerRequest, WorkerResponse } from './messages';
import { abortError, buildLocalSystemPrompt, LOCAL_MODEL_RESPONSE_SCHEMA, parseLocalModelPlan, validateDraft } from './plan';
import { webLLMDiagnostics } from './diagnostics';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
  navigator: { gpu?: { requestAdapter(): Promise<{ features: { has(name: string): boolean } } | null> } };
};
let engine: MLCEngine | undefined;
let initializing: Promise<void> | undefined;
let model = '';
let latestDraft: Draft | undefined;
const queue = new GenerationQueue();
const send = (message: WorkerResponse) => scope.postMessage(message);

async function prepare(requested?: string): Promise<void> {
  if (engine) return;
  if (initializing) return initializing;
  initializing = (async () => {
    if (!scope.navigator.gpu) throw new Error('WebGPU is unavailable in this browser worker. Limited templates remain available in Auto mode.');
    const adapter = await scope.navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available. Limited templates remain available in Auto mode.');
    model = requested ?? `Qwen2.5-0.5B-Instruct-q4${adapter.features.has('shader-f16') ? 'f16' : 'f32'}_1-MLC`;
    if (!prebuiltAppConfig.model_list.some((record) => record.model_id === model)) throw new Error(`Unknown WebLLM model: ${model}`);
    engine = await CreateMLCEngine(model, {
      initProgressCallback: (report) => send({ type: 'status', status: {
        state: 'loading', label: `Loading ${model}`, progress: Math.max(0, Math.min(1, report.progress)), detail: report.text,
      } }),
    });
    send({ type: 'status', status: { state: 'ready', label: 'Local WebGPU model ready', progress: 1, detail: model } });
  })().catch(error=>{initializing=undefined;throw error;});
  return initializing;
}

scope.onmessage = ({ data }) => {
  if (data.type === 'draft') {
    // Stored immediately, independent of inference; no mutable prefill/cache claim.
    if (!latestDraft || data.draft.contextId !== latestDraft.contextId || data.draft.revision >= latestDraft.revision) latestDraft = { ...data.draft };
    return;
  }
  if (data.type === 'cancel') { queue.cancel(data.id); return; }
  const id = data.id;
  const queuedAt = performance.now();
  let admittedAt: number | undefined, generationAt: number | undefined;
  let diagnostics: InferenceDiagnostics = {}, firstTokenMs: number | undefined;
  const measured = (): InferenceDiagnostics => ({ ...diagnostics, firstTokenMs,
    queueMs: admittedAt === undefined ? undefined : admittedAt - queuedAt,
    warmupMs: admittedAt === undefined ? undefined : (generationAt ?? performance.now()) - admittedAt,
    generationMs: generationAt === undefined ? undefined : performance.now() - generationAt });
  const task = data.type === 'prepare'
    ? prepare(data.model).then(() => send({ type: 'ready', id, model }))
    : queue.run(id, async () => {
      admittedAt = performance.now();
      await prepare();
      if (queue.isCanceled(id)) throw abortError();
      validateDraft(data.draft, data.context);
      // WebLLM 0.2.85's streaming path resets its interrupt flag per generation.
      // Drain the iterator internally: only a finished, validated plan leaves this worker.
      generationAt = performance.now();
      const stream = await engine!.chat.completions.create({
        messages: [{ role: 'system', content: buildLocalSystemPrompt(data.context) }, { role: 'user', content: data.draft.text }],
        stream: true, stream_options: { include_usage: true }, temperature: 0, max_tokens: 256,
        response_format: { type: 'json_object', schema: JSON.stringify(LOCAL_MODEL_RESPONSE_SCHEMA) },
      });
      let text = '', finishReason: string | null | undefined, tokens: number | undefined;
      const iterator = stream[Symbol.asyncIterator]();
      while (true) {
        const next = iterator.next();
        if (queue.isCanceled(id)) await engine!.interruptGenerate();
        const chunk = await next;
        if (chunk.done) break;
        const content = chunk.value.choices[0]?.delta.content ?? '';
        if (content && firstTokenMs === undefined) firstTokenMs = performance.now() - generationAt;
        text += content;
        finishReason = chunk.value.choices[0]?.finish_reason ?? finishReason;
        tokens = chunk.value.usage?.completion_tokens ?? tokens;
        if (chunk.value.usage) diagnostics = webLLMDiagnostics(chunk.value.usage);
      }
      if (queue.isCanceled(id)) throw abortError();
      if (finishReason !== 'stop') throw new Error('The local model did not complete its query plan. Try a simpler request.');
      return { plan: parseLocalModelPlan(text, data.context), source: 'webgpu' as const, model, tokens,
        diagnostics: measured() };
    }, () => engine?.interruptGenerate()).then((result) => send({ type: 'result', id, result }));
  void task.catch((error: unknown) => send({ type: 'error', id,
    message: error instanceof Error ? error.message : String(error), name: error instanceof Error ? error.name : 'Error',
    ...(data.type === 'resolve' ? { inference: { source: 'webgpu', model, diagnostics: measured() } } : {}),
  }));
};
