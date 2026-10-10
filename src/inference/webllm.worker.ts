import { CreateMLCEngine, prebuiltAppConfig, type ChatCompletionMessageParam, type MLCEngine } from '@mlc-ai/web-llm';
import type { Draft, InferenceDiagnostics, LocalModelProfile } from '../core/types';
import { GenerationQueue } from './generation';
import type { WorkerRequest, WorkerResponse } from './messages';
import { abortError, validateDraft } from './plan';
import { combineAttemptDiagnostics, webLLMDiagnostics } from './diagnostics';
import { readFailureResponse } from './failure';
import { selectBrowserModel } from './models';
import { pinBrowserModelAssets } from './model-assets';
import { EMPTY_THINKING_PREFIX, modelGenerationOptions, normalizeModelOutput } from './model-output';
import { modelPlanContract } from './model-contract';
import { prepareQueryGrammar } from './grammar-warmup';

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

async function prepare(requested?: string, profile?: LocalModelProfile): Promise<void> {
  if (initializing) return initializing;
  if (engine) return;
  initializing = (async () => {
    if (!scope.navigator.gpu) throw new Error('WebGPU is unavailable in this browser worker. Limited templates remain available in Auto mode.');
    const adapter = await scope.navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available. Limited templates remain available in Auto mode.');
    model = requested ?? selectBrowserModel(profile, adapter.features.has('shader-f16'));
    if (!prebuiltAppConfig.model_list.some((record) => record.model_id === model)) throw new Error(`Unknown WebLLM model: ${model}`);
    const created = await CreateMLCEngine(model, {
      appConfig: pinBrowserModelAssets(model, prebuiltAppConfig),
      initProgressCallback: (report) => send({ type: 'status', status: {
        state: 'loading', label: `Loading ${model}`, progress: Math.max(0, Math.min(1, report.progress)), detail: report.text,
      } }),
    });
    try {
      send({ type: 'status', status: { state: 'loading', label: 'Preparing query grammar', detail: model } });
      await prepareQueryGrammar(created, model);
    } catch (error) {
      // The shared preparation owns this unpublished engine. Draft cancellation
      // cannot interrupt it, and a later prepare may retry after cleanup.
      try { await created.unload(); } catch { /* Preserve the preparation error. */ }
      throw error;
    }
    engine = created;
    send({ type: 'status', status: { state: 'ready', label: 'Local WebGPU model ready', progress: 1, detail: model } });
  })().finally(() => { initializing = undefined; });
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
  let admittedAt: number | undefined, generationAt: number | undefined, repairAt: number | undefined;
  let firstTokenMs: number | undefined;
  const attemptDiagnostics: InferenceDiagnostics[] = [];
  let text = '', finishReason: string | null | undefined;
  const measured = (): InferenceDiagnostics => ({ ...combineAttemptDiagnostics(attemptDiagnostics), firstTokenMs,
    attempts: attemptDiagnostics.length || undefined,
    repairMs: repairAt === undefined ? undefined : performance.now() - repairAt,
    queueMs: admittedAt === undefined ? undefined : admittedAt - queuedAt,
    warmupMs: admittedAt === undefined ? undefined : (generationAt ?? performance.now()) - admittedAt,
    generationMs: generationAt === undefined ? undefined : performance.now() - generationAt });
  const task = data.type === 'prepare'
    ? prepare(data.model, data.localModel).then(() => send({ type: 'ready', id, model }))
    : queue.run(id, async () => {
      admittedAt = performance.now();
      await prepare();
      if (queue.isCanceled(id)) throw abortError();
      validateDraft(data.draft, data.context);
      // WebLLM 0.2.85's streaming path resets its interrupt flag per generation.
      // Drain the iterator internally: only a finished, validated plan leaves this worker.
      const generationOptions = modelGenerationOptions(model);
      const contract = modelPlanContract(model);
      let messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: contract.systemPrompt(data.context) }, { role: 'user', content: data.draft.text },
      ];
      for (let attempt = 0; attempt < 2; attempt++) {
        if (queue.isCanceled(id)) throw abortError();
        if (attempt === 0) generationAt = performance.now();
        else repairAt = performance.now();
        attemptDiagnostics.push({}); text = ''; finishReason = undefined;
        // Engine failures are outside the validation catch: unavailable devices,
        // interrupted streams and other runtime faults must never trigger repair.
        const stream = await engine!.chat.completions.create({
          ...generationOptions, messages, stream: true, stream_options: { include_usage: true }, temperature: 0, max_tokens: 256,
          response_format: { type: 'json_object', schema: contract.schema },
        });
        const iterator = stream[Symbol.asyncIterator]();
        while (true) {
          const next = iterator.next();
          if (queue.isCanceled(id)) await engine!.interruptGenerate();
          const chunk = await next;
          if (chunk.done) break;
          const content = chunk.value.choices[0]?.delta.content ?? '';
          text += content;
          // A forced empty thinking header is prompt material, not generated content.
          if (content && firstTokenMs === undefined && !(generationOptions.extra_body && EMPTY_THINKING_PREFIX.startsWith(text))) {
            firstTokenMs = performance.now() - generationAt!;
          }
          finishReason = chunk.value.choices[0]?.finish_reason ?? finishReason;
          if (chunk.value.usage) attemptDiagnostics[attempt] = webLLMDiagnostics(chunk.value.usage);
        }
        if (queue.isCanceled(id)) throw abortError();
        const incomplete = 'The local model did not complete its query plan.';
        // Only length truncation can be repaired; abort and unknown finish reasons
        // do not establish a completed model response to correct.
        if (finishReason !== 'stop' && finishReason !== 'length') throw new Error(incomplete);
        try {
          if (finishReason === 'length') throw new Error(`${incomplete} Output reached the token limit.`);
          const plan = contract.parse(normalizeModelOutput(text, model), data.context);
          const diagnostics = measured();
          return { plan, source: 'webgpu' as const, model, tokens: diagnostics.completionTokens, diagnostics };
        } catch (error) {
          if (attempt === 1 || (error instanceof Error && error.name === 'AbortError')) throw error;
          const previous = readFailureResponse({ text: normalizeModelOutput(text, model) })!;
          messages = [...messages, { role: 'assistant', content: previous.text }, { role: 'user', content:
            `Your previous response failed validation: ${error instanceof Error ? error.message : String(error)}\n` +
            (previous.truncated ? 'The previous assistant response was truncated for this correction.\n' : '') +
            'Re-check the supported capabilities in the system instructions and correct the response for the original complete request. ' +
            'Preserve its metric, aggregation, grouping, time bucket, time window, filters and view. Do not simplify or silently drop any requirement. ' +
            'If the entire request is supported, return its correct JSON plan. If it is truly unsupported, return the unsupported_request JSON response. ' +
            'Return only the JSON response, with no explanation.' }];
        }
      }
      throw new Error('Model correction did not produce a query plan.');
    }, () => engine?.interruptGenerate()).then((result) => send({ type: 'result', id, result }));
  void task.catch((error: unknown) => send({ type: 'error', id,
    message: error instanceof Error && error.name === 'ContextWindowSizeExceededError'
      ? `${attemptDiagnostics.length > 1 ? 'The correction would exceed' : 'The question and model instructions exceed'} this model's context capacity. Shorten the question and try again.`
      : error instanceof Error ? error.message : String(error), name: error instanceof Error ? error.name : 'Error',
    ...(data.type === 'resolve' ? { inference: { source: 'webgpu', model, diagnostics: measured(),
      // Only public completion content is retained, never messages or reasoning fields.
      response: generationAt !== undefined && !(error instanceof Error && error.name === 'AbortError')
        ? readFailureResponse({ text, finishReason }) : undefined } } : {}),
  }));
};
