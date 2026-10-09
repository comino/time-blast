import type { AdapterStatus, DatasetContext, Draft, InferenceResult } from '../core/types';
import type { InferenceFailureDetails } from './failure';

export type WorkerRequest =
  | { type: 'prepare'; id: string; model?: string }
  | { type: 'draft'; draft: Draft }
  | { type: 'resolve'; id: string; draft: Draft; context: DatasetContext }
  | { type: 'cancel'; id: string };
export type WorkerResponse =
  | { type: 'status'; status: AdapterStatus }
  | { type: 'ready'; id: string; model: string }
  | { type: 'result'; id: string; result: InferenceResult }
  | { type: 'error'; id: string; message: string; name?: string; inference?: InferenceFailureDetails };
