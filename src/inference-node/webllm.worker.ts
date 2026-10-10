// In-browser inference node: tb1 frames as transferred ArrayBuffers over the worker's global
// postMessage. The engine spawns it as
//   new Worker(new URL('../inference-node/webllm.worker.ts', import.meta.url), { type: 'module' })
// and sends HELLO {"node":"coordinator","model":"<profile or MLC id>"} first; the worker answers
// STATUS frames while loading and READY {"node":"inference","name":"webllm","model"} when warm.
import { CreateMLCEngine, prebuiltAppConfig } from '@mlc-ai/web-llm';
import { now } from '../protocol/frame';
import { generationOptions, pinModelAssets, resolveModelId } from './models';
import { createInferenceNode, type EngineLike } from './node';

interface GpuAdapterLike { features: { has(name: string): boolean } }
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ArrayBuffer | Uint8Array>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  navigator: { gpu?: { requestAdapter(): Promise<GpuAdapterLike | null> } };
};

const node = createInferenceNode({
  post: (buffer) => scope.postMessage(buffer, [buffer]),
  async resolveModel(requested) {
    if (!scope.navigator.gpu) throw new Error('WebGPU is unavailable in this browser worker.');
    const adapter = await scope.navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available.');
    const model = resolveModelId(requested, adapter.features.has('shader-f16'));
    if (!prebuiltAppConfig.model_list.some((record) => record.model_id === model)) throw new Error(`Unknown WebLLM model: ${model}`);
    return model;
  },
  createEngine: async (model, onProgress) => (await CreateMLCEngine(model, {
    appConfig: pinModelAssets(model, prebuiltAppConfig),
    initProgressCallback: (report) => onProgress(report.progress, report.text),
  })) as unknown as EngineLike,
  options: generationOptions,
  now,
});

scope.onmessage = (event) => node.receive(event.data);
