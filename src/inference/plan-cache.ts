import type { DatasetContext, InferenceResult } from '../core/types';
import { MAX_PROMPT_CHARS, validateQueryPlan } from './plan';

/** Small exact-match LRU. Never treats nearby wording or an old snapshot as equivalent. */
export class PlanCache {
  private readonly entries = new Map<string, Pick<InferenceResult, 'plan' | 'model' | 'source'>>();
  constructor(private readonly capacity = 64) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Plan cache capacity must be a positive integer.');
  }
  private key(text: string, context: DatasetContext): string {
    return JSON.stringify([text, context.id, context.start, context.end, context.vessels]);
  }
  get(text: string, context: DatasetContext): InferenceResult | undefined {
    if (text.length > MAX_PROMPT_CHARS) return;
    const key = this.key(text, context), entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.entries.set(key, entry);
    // Do not attribute the old generation's tokens or durations to this cache hit.
    return { ...entry, plan: validateQueryPlan(entry.plan, context), diagnostics: { cacheHit: true } };
  }
  set(text: string, context: DatasetContext, result: InferenceResult): void {
    if (text.length > MAX_PROMPT_CHARS) return;
    const entry = { plan: validateQueryPlan(result.plan, context), source: result.source, model: result.model };
    const key = this.key(text, context); this.entries.delete(key); this.entries.set(key, entry);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }
  clear(): void { this.entries.clear(); }
}
