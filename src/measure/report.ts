/** Pure helpers of /measure.html: frame grid lookups, refresh rate, per-request classification
 * and the downloadable report. No DOM. Tested by tests/measure-report.test.ts. */
import { quantile, type TimingBreakdown } from '../ui/timing';

/** Animation-frame timestamps (Unix ms, ascending) recorded by a main-thread rAF loop. */
export class FrameGrid {
  private readonly at: Float64Array;
  private count = 0;
  constructor(capacity = 1 << 14) { this.at = new Float64Array(capacity); }
  push(unixMs: number): void {
    if (this.count === this.at.length) { this.at.copyWithin(0, this.at.length >> 1); this.count = this.at.length >> 1; }
    this.at[this.count++] = unixMs;
  }
  /** First frame at or after `t`, or null when none was recorded yet. */
  firstAtOrAfter(t: number): number | null {
    let lo = 0, hi = this.count;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.at[mid] < t) lo = mid + 1; else hi = mid; }
    return lo < this.count ? this.at[lo] : null;
  }
  get last(): number | null { return this.count ? this.at[this.count - 1] : null; }
  /** Intervals between consecutive frames within [from, to]. */
  intervals(from: number, to: number): number[] {
    const out: number[] = [];
    for (let i = 1; i < this.count; i++) if (this.at[i - 1] >= from && this.at[i] <= to) out.push(this.at[i] - this.at[i - 1]);
    return out;
  }
}

/** Display refresh rate from rAF intervals: the median interval (robust to dropped frames). */
export function refreshHz(intervals: readonly number[]): number | null {
  const xs = intervals.filter(v => v > 1 && v < 200);
  if (xs.length < 10) return null;
  const median = quantile(Float64Array.from(xs).sort(), 0.5);
  return Math.round(1000 / median * 10) / 10;
}

/** One request drawn while typing, merged over its TIMING frames. Unix ms. */
export interface DrawnRequest {
  request: number;
  revision: number;
  keyAt: number;
  submitted: number;
  /** FIRST_PRESENTED: WebGPU onSubmittedWorkDone resolved (WebGL2: the worker's next frame). */
  gpuDone: number | null;
  /** The renderer kept the image on screen (identical data): no new frame was produced. */
  steady: boolean;
  /** First main-thread animation frame at or after `gpuDone` (redraws only). */
  frame: number | null;
  rows: Array<[string, number]>;
}

export function mergeDrawn(timings: readonly TimingBreakdown[], frames: FrameGrid | null): DrawnRequest[] {
  const by = new Map<number, TimingBreakdown>();
  for (const t of timings) {
    if (t.headline === null || t.keyAt === null) continue;
    const seen = by.get(t.request);
    if (!seen || (seen.presented === null && t.presented !== null)) by.set(t.request, t);
  }
  return [...by.values()].map(t => {
    const keyAt = t.keyAt!, submitted = keyAt + t.headline!;
    const gpuDone = t.presented === null ? null : keyAt + t.presented;
    const steady = t.presented !== null && t.presented === t.headline;
    const frame = !steady && gpuDone !== null && frames ? frames.firstAtOrAfter(gpuDone) : null;
    const rows: Array<[string, number]> = t.rows.map(r => [r.label === 'presented' ? 'GPU work done' : r.label, r.delta]);
    if (frame !== null && gpuDone !== null) rows.push(['next animation frame', frame - gpuDone]);
    return { request: t.request, revision: t.revision, keyAt, submitted, gpuDone, steady, frame, rows };
  });
}

export interface Stats { n: number; median: number; p95: number; min: number; max: number }
export function stats(values: readonly number[]): Stats | null {
  if (!values.length) return null;
  const s = Float64Array.from(values).sort();
  return { n: s.length, median: quantile(s, 0.5), p95: quantile(s, 0.95), min: s[0], max: s[s.length - 1] };
}

/** Per-stage medians over samples of [label, delta] rows, in first-seen order. */
export function stageTable(samples: ReadonlyArray<ReadonlyArray<readonly [string, number]>>): Array<{ label: string; n: number; median: number; p95: number }> {
  const order: string[] = [], values = new Map<string, number[]>();
  // Pipeline order: the longest sample's order first (its TIMING carried the most stages), then
  // labels only other samples have.
  const longest = [...samples].sort((a, b) => b.length - a.length)[0] ?? [];
  for (const [label] of longest) if (!values.has(label)) { values.set(label, []); order.push(label); }
  for (const rows of samples) for (const [label, delta] of rows) {
    if (!values.has(label)) { values.set(label, []); order.push(label); }
    values.get(label)!.push(delta);
  }
  return order.map(label => { const s = stats(values.get(label)!)!; return { label, n: s.n, median: s.median, p95: s.p95 }; });
}

/** The downloadable JSON; `pnpm perf --ingest` reads it (scripts/perf/lib.ts `MeasureJson`). */
export interface MeasureReport {
  kind: 'time-blast.measure';
  version: 1;
  date: string;
  commit?: string;
  page: { url: string; userAgent: string; browser?: { name: string; version: string }; crossOriginIsolated: boolean; timerResolutionMs: number | null };
  hardware: {
    cores?: number; deviceMemoryGb?: number; platform?: string; devicePixelRatio: number; screen: string;
    refreshHz?: number;
    gpu: { api?: string; vendor?: string; architecture?: string; device?: string; description?: string; software?: boolean; fallbackAdapter?: boolean; webgl?: string; engineRenderer?: string };
  };
  settings: Record<string, unknown>;
  metrics: Record<string, { unit: string; samples: number[] }>;
  stages: Record<string, Array<{ label: string; n: number; median: number; p95: number }>>;
  /** What each timestamp means (copied from the page). */
  definitions: Record<string, string>;
  notes: string[];
}
