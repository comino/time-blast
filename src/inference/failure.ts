import type { InferenceResult } from '../core/types';
import { readInferenceDiagnostics } from './diagnostics';

export type InferenceFailureDetails = Pick<InferenceResult, 'source' | 'model' | 'diagnostics'>;

/** Preserve measured work when inference finishes with a refusal or invalid plan. */
export class InferenceFailure extends Error {
  readonly details: InferenceFailureDetails;

  constructor(cause: unknown, details: InferenceFailureDetails) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = cause instanceof Error ? cause.name : 'Error';
    this.details = { source: details.source,
      model: typeof details.model === 'string' ? details.model.slice(0, 200) : undefined,
      diagnostics: readInferenceDiagnostics(details.diagnostics) };
  }
}

export function inferenceFailureDetails(error: unknown): Partial<InferenceFailureDetails> {
  return error instanceof InferenceFailure ? error.details : {};
}
