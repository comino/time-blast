import type { InferenceResult, ModelResponseFailure } from '../core/types';
import { readInferenceDiagnostics } from './diagnostics';

export type InferenceFailureDetails = Pick<InferenceResult, 'source' | 'model' | 'diagnostics'> & {
  response?: ModelResponseFailure;
};

export const MAX_FAILED_RESPONSE_CHARS = 2048;

/** Accept output text only, with fixed bounds at worker and adapter boundaries. */
export function readFailureResponse(value: unknown): ModelResponseFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const response = value as Record<string, unknown>;
  if (typeof response.text !== 'string') return;
  return { text: response.text.slice(0, MAX_FAILED_RESPONSE_CHARS),
    truncated: response.truncated === true || response.text.length > MAX_FAILED_RESPONSE_CHARS,
    ...(typeof response.finishReason === 'string' ? { finishReason: response.finishReason.slice(0, 40) } : {}) };
}

/** Preserve measured work when inference finishes with a refusal or invalid plan. */
export class InferenceFailure extends Error {
  readonly details: InferenceFailureDetails;

  constructor(cause: unknown, details: InferenceFailureDetails) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = cause instanceof Error ? cause.name : 'Error';
    this.details = { source: details.source,
      model: typeof details.model === 'string' ? details.model.slice(0, 200) : undefined,
      diagnostics: readInferenceDiagnostics(details.diagnostics),
      response: readFailureResponse(details.response) };
  }
}

export function inferenceFailureDetails(error: unknown): Partial<InferenceFailureDetails> {
  return error instanceof InferenceFailure ? error.details : {};
}
