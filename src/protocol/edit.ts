/** Shared immutable edit-context contract. Handles are transport-local, never cache keys. */
import type { ViewName } from '../engine/contracts';

export const EDIT_CAPABILITY = 'edit-context-v1';
export const MAX_EDIT_BYTES = 128 * 1024;
export interface EditBase {
  mode: 'refine' | 'regenerate';
  originalQuestion: string;
  sql: string;
  history: Array<{ kind: string; text: string; details?: string }>;
  presentation: { view: ViewName | null; params: Record<string, number> };
}

/** Reject malformed contexts before they become provider prompts. Results and schema
 * samples are not accepted fields; schema travels separately in CONTEXT. */
export function parseEditBase(raw: string): EditBase {
  if (new TextEncoder().encode(raw).length > MAX_EDIT_BYTES) throw new Error('Edit context exceeds 128 KiB');
  const value: unknown = JSON.parse(raw);
  const object = (v: unknown, keys: string[]): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw new Error('Invalid edit context fields');
    return v as Record<string, unknown>;
  };
  const str = (v: unknown, limit: number) => typeof v === 'string' && v.length <= limit;
  const b = object(value, ['mode', 'originalQuestion', 'sql', 'history', 'presentation']);
  if (!['refine', 'regenerate'].includes(b.mode as string) || !str(b.originalQuestion, 16384) || !str(b.sql, MAX_EDIT_BYTES) || !(b.sql as string).trim()) throw new Error('Invalid edit question or SQL');
  if (!Array.isArray(b.history) || b.history.length > 32) throw new Error('Edit context supports at most 32 lineage entries');
  for (const entry of b.history) {
    const h = object(entry, ['kind', 'text', 'details']);
    if (!['create', 'refine', 'regenerate', 'sql', 'view', 'gesture'].includes(h.kind as string) || !str(h.text, 16384) || (h.details !== undefined && !str(h.details, 16384))) throw new Error('Invalid edit history');
  }
  const p = object(b.presentation, ['view', 'params']);
  if (p.view !== null && !['line', 'bar', 'scatter', 'table', 'heatmap', 'surface', 'map', 'density', 'tracks', 'seasons'].includes(p.view as string)) throw new Error('Invalid edit view');
  const params = object(p.params, ['rotation', 'playback']);
  for (const [name, v] of Object.entries(params)) if (typeof v !== 'number' || !Number.isFinite(v) || (name === 'playback' && (v < 0 || v > 1))) throw new Error('Invalid edit parameter');
  return value as EditBase;
}

/** Stable field order for a document's edit base. The exact validated wire JSON is
 * the prompt suffix in both backends, avoiding reserialization differences. */
export function editBaseJson(base: EditBase): string {
  return JSON.stringify({ mode: base.mode, originalQuestion: base.originalQuestion, sql: base.sql,
    history: base.history.map(h => ({ kind: h.kind, text: h.text, ...(h.details === undefined ? {} : { details: h.details }) })),
    presentation: { view: base.presentation.view, params: Object.fromEntries(Object.entries(base.presentation.params).sort(([a], [b]) => a.localeCompare(b))) } });
}
