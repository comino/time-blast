import type { MLCEngine } from '@mlc-ai/web-llm';
import { modelPlanContract } from './model-contract';
import { modelGenerationOptions } from './model-output';

interface GrammarEngine {
  chat: { completions: Pick<MLCEngine['chat']['completions'], 'create'> };
  resetChat: MLCEngine['resetChat'];
}

/**
 * Compile the exact query grammar before the engine becomes ready. WebLLM 0.2.85
 * retains its compiled grammar across resetChat; the reset discards this fixed
 * preparation conversation and its statistics. No user request is generated.
 */
export async function prepareQueryGrammar(engine: GrammarEngine, model: string): Promise<void> {
  await engine.chat.completions.create({
    ...modelGenerationOptions(model),
    messages: [{ role: 'user', content: 'Return JSON.' }],
    stream: false, temperature: 0, max_tokens: 1,
    response_format: { type: 'json_object', schema: modelPlanContract(model).schema },
  });
  await engine.resetChat();
}
