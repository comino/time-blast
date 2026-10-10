import type { DatasetContext, QueryPlan } from '../core/types';
import { buildSystemPrompt, MODEL_RESPONSE_SCHEMA, parseModelPlan } from './plan';
import { buildSemanticSystemPromptV5, SEMANTIC_MODEL_RESPONSE_SCHEMA_V5, parseSemanticModelPlanV5 } from './semantic-plan';

interface ModelContract {
  readonly schema: string;
  readonly systemPrompt: (context: DatasetContext) => string;
  readonly parse: (text: string, context: DatasetContext) => QueryPlan;
}

// Compile each model's prompt, grammar and decoder as one choice. Schema strings
// stay stable across generations so the engine can reuse its grammar matcher.
const FULL: ModelContract = Object.freeze({
  schema: JSON.stringify(MODEL_RESPONSE_SCHEMA), systemPrompt: buildSystemPrompt, parse: parseModelPlan,
});
const LITERAL: ModelContract = Object.freeze({
  schema: JSON.stringify(SEMANTIC_MODEL_RESPONSE_SCHEMA_V5),
  systemPrompt: buildSemanticSystemPromptV5, parse: parseSemanticModelPlanV5,
});

/** Native screening favored literal extraction on 4B, full fields on Qwen2.5. */
export function modelPlanContract(model: string): ModelContract {
  return model === 'Qwen3-4B-q4f16_1-MLC' || model === 'Qwen3-4B-q4f32_1-MLC' ? LITERAL : FULL;
}
