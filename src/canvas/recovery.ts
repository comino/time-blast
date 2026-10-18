/** A recovery file explicitly separates acknowledged history from RAM-only work. */
import { CanvasModel, newId, type CanvasSnapshot, type Id } from './model';
import { CanvasFormatError, forkCanvas, validateCanvas } from './validation';

export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
export const MAX_RECOVERY_BYTES = 2 * MAX_DOCUMENT_BYTES + 4096;
export interface CanvasRecovery {
  format: 'timeblast-canvas-recovery'; formatVersion: 1; exportedAt: number;
  acknowledged: CanvasSnapshot | null;
  working: CanvasSnapshot;
}
export type CanvasFile = CanvasSnapshot | CanvasRecovery;
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const fail = (message: string): never => { throw new CanvasFormatError(message); };

export function validateRecovery(value: unknown): CanvasRecovery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid recovery file');
  const r = value as CanvasRecovery;
  if (Object.keys(r).some(k => !['format', 'formatVersion', 'exportedAt', 'acknowledged', 'working'].includes(k))
    || r.format !== 'timeblast-canvas-recovery' || r.formatVersion !== 1 || !Number.isSafeInteger(r.exportedAt) || r.exportedAt < 0) fail('Unsupported recovery format');
  const working = validateCanvas(r.working);
  const withinDocumentLimit = (snapshot: CanvasSnapshot) => {
    if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_DOCUMENT_BYTES) fail('An embedded canvas exceeds 32 MiB');
  };
  withinDocumentLimit(working);
  if (r.acknowledged !== null) {
    const saved = validateCanvas(r.acknowledged);
    withinDocumentLimit(saved);
    if (saved.canvas.id !== working.canvas.id || saved.canvas.storeVersion > working.canvas.storeVersion) fail('Recovery boundary changes canvas identity or moves its store version backwards');
    if (saved.canvas.storeVersion === working.canvas.storeVersion && !equal(saved.canvas, working.canvas)) fail('Recovery header changed without advancing its version');
    for (const key of ['commits', 'revisions', 'sources'] as const) {
      const records = new Map(working[key].map(record => [record.id, record] as const));
      for (const record of saved[key]) if (!equal(record, records.get(record.id))) fail(`Recovery removed or changed an acknowledged ${key} record`);
    }
    const drafts = new Map(working.drafts.map(d => [d.id, d]));
    for (const before of saved.drafts) {
      const after = drafts.get(before.id);
      if (!after || after.version < before.version || (after.version === before.version && !equal(before, after))
        || (before.state === 'closed' && !equal(before, after))) fail('Recovery rewrites an acknowledged draft');
    }
  }
  return r;
}

/** Generated captions travel next to the document (derived data, not part of its strict
 * format): `captions` on the file root, split off before validation. Malformed entries are
 * dropped; they never fail an import. */
export interface ExportedCaption { revisionId: Id; title: string; explanation: string; model: string; promptVersion: number }
const MAX_EXPORTED_CAPTIONS = 20000;
function captionsOf(raw: unknown): ExportedCaption[] {
  if (!Array.isArray(raw)) return [];
  const ok = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && Array.from(v).length <= max;
  return raw.slice(0, MAX_EXPORTED_CAPTIONS).filter((c): c is ExportedCaption => !!c && typeof c === 'object'
    && ok(c.revisionId, 64) && ok(c.title, 80) && ok(c.explanation, 320) && typeof c.model === 'string' && c.model.length <= 200
    && Number.isSafeInteger(c.promptVersion)).map(c => ({ revisionId: c.revisionId, title: c.title, explanation: c.explanation, model: c.model, promptVersion: c.promptVersion }));
}

export function parseCanvasFile(raw: string): CanvasFile { return parseCanvasFileWithCaptions(raw).file; }
export function parseCanvasFileWithCaptions(raw: string): { file: CanvasFile; captions: ExportedCaption[] } {
  const bytes = new TextEncoder().encode(raw).byteLength;
  if (bytes > MAX_RECOVERY_BYTES) fail('Recovery file exceeds its two-document size limit');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { fail('Canvas file is not valid JSON'); }
  let captions: ExportedCaption[] = [];
  if (value && typeof value === 'object' && !Array.isArray(value) && 'captions' in value) {
    const { captions: rawCaptions, ...rest } = value as Record<string, unknown>;
    captions = captionsOf(rawCaptions); value = rest;
  }
  return { file: parseValidated(value, bytes), captions };
}
function parseValidated(value: unknown, bytes: number): CanvasFile {
  if ((value as { format?: string })?.format === 'timeblast-canvas-recovery') return validateRecovery(value);
  if (bytes > MAX_DOCUMENT_BYTES) fail('Canvas file exceeds 32 MiB');
  return validateCanvas(value);
}

export function encodeCanvasFile(file: CanvasFile, captions: ExportedCaption[] = []): string {
  if (file.format === 'timeblast-canvas-recovery') validateRecovery(file); else validateCanvas(file);
  const kept = captionsOf(captions);
  const raw = JSON.stringify(kept.length ? { ...file, captions: kept } : file);
  const limit = file.format === 'timeblast-canvas-recovery' ? MAX_RECOVERY_BYTES : MAX_DOCUMENT_BYTES;
  if (new TextEncoder().encode(raw).byteLength > limit) fail('Canvas file exceeds its document size limit; no history was truncated');
  return raw;
}

/** Recovering does not replay a source tab's CAS operations. It creates a labelled
 * new canvas. The caller must acknowledge its initial transaction before Saved. */
export function importCanvasFile(file: CanvasFile, identities = new Map<Id, Id>()): CanvasModel {
  const recovery = file.format === 'timeblast-canvas-recovery';
  if (recovery) validateRecovery(file);
  const snapshot = forkCanvas(recovery ? file.working : file, newId, identities);
  if (recovery) {
    const parent = snapshot.commits.find(c => c.id === snapshot.canvas.headCommitId)!;
    const id = newId();
    snapshot.commits.push({ id, canvasId: snapshot.canvas.id, parentId: parent.id, at: Date.now(),
      action: 'Recover working copy', state: structuredClone(parent.state) });
    snapshot.canvas.headCommitId = id;
    snapshot.canvas.redoChoices[parent.id] = id;
  }
  return new CanvasModel(validateCanvas(snapshot));
}
