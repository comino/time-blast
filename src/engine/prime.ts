/**
 * Primed translations (protocol-v1 `PRIME`): question → SQL pairs the UI already knows, e.g. the
 * follow-up suggestions it offers under a result (src/ui/suggest.ts). The engine host answers an
 * INFER for a primed question here, at the edge of the inference link, instead of sending it to
 * the inference node: SQL (flag CACHED) + INFER_STATS (cost 0), same identities and stamps as a
 * real answer. The coordinator cannot tell the difference, so a clicked suggestion takes the normal
 * path (translation → EXEC → result cache → draw) with full TIMING, minus the model round trip.
 *
 * Matching is exact after trimming, collapsing whitespace and lower-casing. Entries are scoped to
 * a dataset context and bounded (LRU).
 */
import { Flag, json, Kind, Node, Stage, now as clockNow, readJson, type Frame } from '../protocol/frame';

export interface PrimePayload { question: string; sql: string }

const MAX_PRIMED = 128;
const MAX_TEXT = 16 * 1024;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

export const normalizeQuestion = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

export class PrimedTranslations {
  private readonly entries = new Map<string, string>();
  hits = 0;
  primed = 0;

  constructor(private readonly now: () => number = clockNow) {}

  get size(): number { return this.entries.size; }

  /** Store one PRIME frame. Returns false for a malformed payload (ignored). */
  prime(frame: Frame<Uint8Array>): boolean {
    let body: PrimePayload;
    try { body = readJson<PrimePayload>(frame.payload); } catch { return false; }
    if (!body || typeof body.question !== 'string' || typeof body.sql !== 'string') return false;
    const question = normalizeQuestion(body.question);
    if (!question || !body.sql.trim() || question.length > MAX_TEXT || body.sql.length > MAX_TEXT) return false;
    const key = `${frame.context}\u0000${question}`;
    this.entries.delete(key);
    this.entries.set(key, body.sql);
    if (this.entries.size > MAX_PRIMED) this.entries.delete(this.entries.keys().next().value!);
    this.primed++;
    return true;
  }

  /** The frames answering `infer` if its question is primed, else null. */
  answer(infer: Frame<Uint8Array>): Array<Frame<Uint8Array>> | null {
    if (infer.kind !== Kind.INFER) return null;
    const key = `${infer.context}\u0000${normalizeQuestion(fromUtf8.decode(infer.payload))}`;
    const sql = this.entries.get(key);
    if (sql === undefined) return null;
    this.entries.delete(key); this.entries.set(key, sql);
    this.hits++;
    const at = this.now();
    const ids = { epoch: infer.epoch, request: infer.request, revision: infer.revision, context: infer.context };
    return [
      {
        kind: Kind.SQL, flags: Flag.CACHED, ...ids,
        stamps: [{ stage: Stage.INFER_RECEIVED, node: Node.INFERENCE, at }, { stage: Stage.SQL_COMPLETE, node: Node.INFERENCE, at }],
        payload: utf8.encode(sql),
      },
      {
        kind: Kind.INFER_STATS, flags: 0, ...ids, stamps: [],
        payload: json({ model: 'primed', promptTokens: 0, completionTokens: 0, costUsd: 0, attempts: 0 }),
      },
    ];
  }

  clear(): void { this.entries.clear(); }
}
