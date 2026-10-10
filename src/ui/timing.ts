/** TIMING ledger → per-stage breakdown and a rolling history. Pure; cold path.
 * These are software timestamps on the page's shared clock, not photons. */
import { Stage, type Stamp } from '../protocol/frame';

export const STAGE_LABELS: ReadonlyArray<readonly [number, string]> = [
  [Stage.KEY_INPUT, 'key'],
  [Stage.DRAFT_SENT, 'draft sent'],
  [Stage.COORD_RECEIVED, 'coordinator'],
  [Stage.INFER_SENT, 'inference sent'],
  [Stage.INFER_RECEIVED, 'inference received'],
  [Stage.PROVIDER_REQUEST, 'provider request'],
  [Stage.FIRST_TOKEN, 'first token'],
  [Stage.SQL_FIRST_DELTA, 'first SQL delta'],
  [Stage.SQL_COMPLETE, 'SQL complete'],
  [Stage.SQL_RECEIVED, 'SQL received'],
  [Stage.EXEC_SENT, 'exec sent'],
  [Stage.EXEC_RECEIVED, 'exec received'],
  [Stage.DB_FIRST_BATCH, 'DB first batch'],
  [Stage.DB_DONE, 'DB done'],
  [Stage.RENDER_FIRST_BATCH, 'render first batch'],
  [Stage.FIRST_DRAW_SUBMITTED, 'first draw submitted'],
  [Stage.FIRST_PRESENTED, 'presented'],
];

export interface StageRow {
  stage: number;
  label: string;
  /** ms since the origin keystroke (negative = before it, e.g. reused SQL). */
  offset: number;
  /** ms since the previous row. */
  delta: number;
}

export interface TimingBreakdown {
  request: number;
  revision: number;
  rows: StageRow[];
  /** Last keystroke → first draw submitted, ms. null when nothing was drawn. */
  headline: number | null;
  /** Last keystroke → presented (best effort), ms. */
  presented: number | null;
  cacheHit: boolean;
  /** Unix ms of the origin keystroke. */
  keyAt: number | null;
}

/** The origin is the bound revision's keystroke: the latest KEY_INPUT at or before the first
 * draw (the latest overall when nothing was drawn). Each other stage uses its earliest stamp at or
 * after the origin, else its latest one before it. */
export function breakdown(stamps: readonly Stamp[], request: number, revision: number): TimingBreakdown {
  const drawAt = earliest(stamps, Stage.FIRST_DRAW_SUBMITTED, -Infinity);
  let keyAt: number | null = null;
  for (const s of stamps) {
    if (s.stage !== Stage.KEY_INPUT) continue;
    if (drawAt !== null && s.at > drawAt) continue;
    if (keyAt === null || s.at > keyAt) keyAt = s.at;
  }
  if (keyAt === null) for (const s of stamps) if (s.stage === Stage.KEY_INPUT && (keyAt === null || s.at > keyAt)) keyAt = s.at;
  const origin = keyAt ?? Math.min(...stamps.map(s => s.at));
  const rows: StageRow[] = [];
  let previous = origin;
  for (const [stage, label] of STAGE_LABELS) {
    const at = stage === Stage.KEY_INPUT ? keyAt : earliest(stamps, stage, origin) ?? latest(stamps, stage);
    if (at === null || !Number.isFinite(origin)) continue;
    rows.push({ stage, label, offset: at - origin, delta: at - previous });
    previous = at;
  }
  const draw = rows.find(r => r.stage === Stage.FIRST_DRAW_SUBMITTED);
  const shown = rows.find(r => r.stage === Stage.FIRST_PRESENTED);
  return {
    request, revision, rows, keyAt,
    headline: keyAt !== null && draw ? draw.offset : null,
    presented: keyAt !== null && shown ? shown.offset : null,
    cacheHit: stamps.some(s => s.stage === Stage.CACHE_HIT),
  };
}

function earliest(stamps: readonly Stamp[], stage: number, from: number): number | null {
  let best: number | null = null;
  for (const s of stamps) if (s.stage === stage && s.at >= from && (best === null || s.at < best)) best = s.at;
  return best;
}
function latest(stamps: readonly Stamp[], stage: number): number | null {
  let best: number | null = null;
  for (const s of stamps) if (s.stage === stage && (best === null || s.at > best)) best = s.at;
  return best;
}

export interface RollingSummary { count: number; median: number | null; p95: number | null; min: number | null; max: number | null }

/** Fixed-capacity ring of samples with median and nearest-rank p95. */
export class RollingStats {
  private readonly values: Float64Array;
  private next = 0;
  private filled = 0;
  constructor(readonly capacity = 50) { this.values = new Float64Array(capacity); }
  add(value: number): void {
    if (!Number.isFinite(value)) return;
    this.values[this.next] = value;
    this.next = (this.next + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }
  get count(): number { return this.filled; }
  summary(): RollingSummary {
    if (!this.filled) return { count: 0, median: null, p95: null, min: null, max: null };
    const sorted = this.values.slice(0, this.filled).sort();
    return { count: this.filled, median: quantile(sorted, .5), p95: quantile(sorted, .95), min: sorted[0], max: sorted[this.filled - 1] };
  }
}

/** Nearest-rank quantile of an ascending array; the median of an even count is the mean of the middle pair. */
export function quantile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (q === .5 && n % 2 === 0) return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return sorted[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))];
}

export const formatMs = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const abs = Math.abs(ms);
  return `${abs >= 100 ? ms.toFixed(0) : abs >= 10 ? ms.toFixed(1) : ms.toFixed(2)} ms`;
};

export interface InferStats { model: string; promptTokens: number; completionTokens: number; cachedTokens?: number; costUsd?: number; attempts: number }

export function describeInferStats(s: InferStats): string {
  const tokens = `${s.promptTokens}${s.cachedTokens ? ` (${s.cachedTokens} cached)` : ''} → ${s.completionTokens} tok`;
  const cost = s.costUsd === undefined ? '' : ` · $${s.costUsd < .01 ? s.costUsd.toFixed(5) : s.costUsd.toFixed(3)}`;
  return `${s.model} · ${tokens}${cost}${s.attempts > 1 ? ` · ${s.attempts} attempts` : ''}`;
}
