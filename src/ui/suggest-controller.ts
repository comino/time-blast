/**
 * Next-question anticipation, runtime: after a result draws, propose follow-ups (src/ui/suggest.ts)
 * and prepare them so a click shows the chart immediately.
 *
 * Per suggestion, two frames go to the engine (protocol-v1 "Suggestions"):
 *   PRIME {question, sql}   the engine host answers an INFER for exactly this question with this SQL
 *                           (no model call; SQL flag CACHED, INFER_STATS model "primed", cost 0)
 *   EXEC  flag WARM         the database node runs the SQL at the lowest priority and keeps the
 *                           result in its result cache; it streams nothing and answers DONE/ERROR
 *                           to the UI. Request ids carry SENDER_REQUEST_BIT.
 * A click puts the question into the input and sends a normal COMMIT, so the coordinator runs its
 * usual path (translation → EXEC → result cache replay → draw) with full identities and TIMING.
 * Typing the same question (case and spacing aside) hits the same primed answer.
 *
 * Chips appear when generated ("warming") and become "ready" on DONE; a variant whose warm-up fails
 * or returns no rows is withdrawn. Trigger: the live result's first draw (TIMING with
 * FIRST_DRAW_SUBMITTED), once per request.
 */
import type { DatasetContext } from '../engine/contracts';
import { encode, Flag, header, json, Kind, readJson, SENDER_REQUEST_BIT, Stage, text, type Frame } from '../protocol/frame';
import { suggest, type Suggestion } from './suggest';

export type ChipStatus = 'warming' | 'ready';
export interface Chip {
  id: number;
  suggestion: Suggestion;
  status: ChipStatus;
  /** The result request the chip follows up on. */
  from: number;
  warmMs?: number;
  rows?: number;
  /** DONE flags of the warm-up (ROLLUP / RESULT_CACHE). */
  source?: 'raw' | 'rollup' | 'cache';
}
export interface SuggestView { show(chips: Chip[]): void }

export interface SuggestPorts {
  /** Post an encoded frame to the engine (transferred). */
  send(bytes: ArrayBuffer): void;
  epoch(): number;
  context(): DatasetContext | null;
  textOf(revision: number): string | undefined;
  now(): number;
}

export interface SuggestOptions {
  enabled?: boolean;
  /** Send WARM EXECs (pre-execution). */
  warm?: boolean;
  /** Send PRIMEs (click without inference). */
  prime?: boolean;
  max?: number;
}

export interface SuggestStats {
  /** Results that got suggestions / suggestions generated. */
  results: number; generated: number;
  primed: number; warmSent: number; warmDone: number; warmFailed: number; warmEmpty: number;
  /** Warm-ups answered from the result cache already (an earlier suggestion or query). */
  warmCacheHits: number;
  warmMs: number[]; generateUs: number[];
  picks: number;
}

const MAX_TRACKED = 64;

export class SuggestController {
  chips: Chip[] = [];
  readonly stats: SuggestStats = { results: 0, generated: 0, primed: 0, warmSent: 0, warmDone: 0, warmFailed: 0, warmEmpty: 0, warmCacheHits: 0, warmMs: [], generateUs: [], picks: 0 };
  options: Required<SuggestOptions>;
  private readonly sql = new Map<number, string>();
  private lastSuggested = 0;
  private seq = 0;
  private readonly warming = new Map<number, { chip: Chip; sentAt: number }>();

  constructor(private readonly ports: SuggestPorts, private readonly view: SuggestView, options: SuggestOptions = {}) {
    this.options = { enabled: true, warm: true, prime: true, max: 4, ...options };
  }

  /** Observe one engine → UI frame. Returns true when the frame was ours (a WARM answer). */
  observe(frame: Frame): boolean {
    if (frame.request & SENDER_REQUEST_BIT) { this.warmAnswer(frame); return true; }
    if (!this.options.enabled) return false;
    if (frame.kind === Kind.RESULT) {
      try {
        const info = readJson<{ sql?: string }>(frame.payload);
        if (typeof info.sql === 'string') {
          this.sql.set(frame.request, info.sql);
          if (this.sql.size > MAX_TRACKED) this.sql.delete(this.sql.keys().next().value!);
        }
      } catch { /* the controller reports unreadable RESULTs */ }
    } else if (frame.kind === Kind.TIMING && frame.request > this.lastSuggested && frame.stamps.some(s => s.stage === Stage.FIRST_DRAW_SUBMITTED)) {
      const sql = this.sql.get(frame.request), question = this.ports.textOf(frame.revision);
      if (sql !== undefined && question) { this.lastSuggested = frame.request; this.propose(frame.request, question, sql); }
    }
    return false;
  }

  /** A chip was clicked: count it; the caller sends the COMMIT. */
  picked(chip: Chip): void { this.stats.picks++; void chip; }

  clear(): void { this.chips = []; this.warming.clear(); this.view.show(this.chips); }

  private propose(from: number, question: string, sql: string): void {
    const t0 = this.ports.now();
    const list = suggest(question, sql, this.ports.context(), this.options.max);
    this.stats.generateUs.push((this.ports.now() - t0) * 1000);
    this.chips = list.map(suggestion => ({ id: 0, suggestion, status: 'warming' as ChipStatus, from }));
    if (list.length) { this.stats.results++; this.stats.generated += list.length; }
    const context = this.ports.context()?.id ?? 0, epoch = this.ports.epoch();
    for (const chip of this.chips) {
      chip.id = (SENDER_REQUEST_BIT | (++this.seq & 0x7fff_ffff)) >>> 0;
      if (this.options.prime) {
        this.post({ ...header(Kind.PRIME, { context, epoch }), stamps: [], payload: json({ question: chip.suggestion.question, sql: chip.suggestion.sql }) });
        this.stats.primed++;
      }
      if (this.options.warm) {
        this.warming.set(chip.id, { chip, sentAt: this.ports.now() });
        this.post({ ...header(Kind.EXEC, { flags: Flag.WARM, context, epoch, request: chip.id }), stamps: [], payload: text(chip.suggestion.sql) });
        this.stats.warmSent++;
      } else chip.status = 'ready';
    }
    // Bound the bookkeeping for warm-ups nobody will answer (cancelled by a new epoch).
    while (this.warming.size > MAX_TRACKED) this.warming.delete(this.warming.keys().next().value!);
    this.view.show(this.chips);
  }

  private warmAnswer(frame: Frame): void {
    const entry = this.warming.get(frame.request);
    if (!entry) return;
    this.warming.delete(frame.request);
    const { chip } = entry;
    if (frame.kind === Kind.DONE) {
      const rows = frame.payload.byteLength >= 8 ? Number(new DataView(frame.payload.buffer, frame.payload.byteOffset, 8).getBigUint64(0, true)) : 0;
      chip.warmMs = this.ports.now() - entry.sentAt;
      chip.rows = rows;
      chip.source = frame.flags & Flag.RESULT_CACHE ? 'cache' : frame.flags & Flag.ROLLUP ? 'rollup' : 'raw';
      this.stats.warmDone++;
      this.stats.warmMs.push(chip.warmMs);
      if (chip.source === 'cache') this.stats.warmCacheHits++;
      if (rows === 0) { this.stats.warmEmpty++; this.withdraw(chip); return; }
      chip.status = 'ready';
    } else {
      this.stats.warmFailed++;
      this.withdraw(chip);
      return;
    }
    if (this.chips.includes(chip)) this.view.show(this.chips);
  }

  /** A follow-up whose SQL fails or returns nothing is not worth offering. */
  private withdraw(chip: Chip): void {
    const at = this.chips.indexOf(chip);
    if (at < 0) return;
    this.chips = this.chips.filter(c => c !== chip);
    this.view.show(this.chips);
  }

  private post(frame: Frame): void {
    const bytes = encode(frame);
    this.ports.send(bytes.buffer as ArrayBuffer);
  }
}
