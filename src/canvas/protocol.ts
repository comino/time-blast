/** Cold-path document controls; DRAFT's text encoding remains in DraftEncoder. */
import { encode, header, json, Kind, text } from '../protocol/frame';
import type { CanvasModel, DraftSession } from './model';
import { editBaseJson, parseEditBase, type EditBase } from '../protocol/edit';
export { EDIT_CAPABILITY, type EditBase } from '../protocol/edit';

export const CANVAS_CAPABILITY = 'canvas-targets-v1';
export const PRESERVE_VIEW = 256;
export interface TargetIdentity { slot: number; generation: number }
export type ExecutionStatus = 'succeeded' | 'failed' | 'cancelled';
export interface CandidateInfo extends TargetIdentity { sql: string }
export interface ExecutionInfo extends TargetIdentity { status: ExecutionStatus }
const targetBytes = (target: TargetIdentity): Uint8Array => {
  const bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
  view.setUint32(0, target.slot, true); view.setUint32(4, target.generation, true); return bytes;
};
export function registerTarget(target: TargetIdentity, context: number, epoch: number): ArrayBuffer {
  return encode({ ...header(Kind.REGISTER_TARGET, { context, epoch }), stamps: [], payload: targetBytes(target) }).buffer as ArrayBuffer;
}
export function releaseTarget(target: TargetIdentity, epoch: number): ArrayBuffer {
  return encode({ ...header(Kind.RELEASE_TARGET, { epoch }), stamps: [], payload: targetBytes(target) }).buffer as ArrayBuffer;
}
export function prepareEdit(target: TargetIdentity, context: number, base: EditBase): ArrayBuffer {
  const raw = editBaseJson(base); parseEditBase(raw);
  return encode({ ...header(Kind.EDIT_CONTEXT, { request: target.slot, revision: target.generation, context }), stamps: [], payload: text(raw) }).buffer as ArrayBuffer;
}
export function savedQuery(target: TargetIdentity, sql: string, context: number, epoch: number, revision: number): ArrayBuffer {
  const body = text(sql), payload = new Uint8Array(body.length + 4);
  new DataView(payload.buffer).setUint32(0, target.slot, true); payload.set(body, 4);
  return encode({ ...header(Kind.QUERY, { request: target.generation, context, epoch, revision }), stamps: [], payload }).buffer as ArrayBuffer;
}
export function editBase(model: CanvasModel, draft: DraftSession): EditBase | null {
  if (!draft.baseRevisionId) return null;
  const selected = model.revisions.get(draft.baseRevisionId)!;
  // The complete lineage remains in the document. Bound provider input without
  // inventing a summary or letting distant instructions override selected SQL.
  const history = model.lineage(selected.id).slice(-32).map(r => ({ ...r.change }));
  return { mode: draft.mode === 'regenerate' ? 'regenerate' : 'refine', originalQuestion: selected.originalQuestion,
    sql: selected.sql, history, presentation: structuredClone(selected.presentation) };
}
