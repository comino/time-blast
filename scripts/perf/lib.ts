/**
 * Performance history: summaries, confidence bands, baselines and the budget check
 * (docs/perf/README.md). Pure functions; loaded by scripts/perf/run.mjs through Vite's module
 * runner and tested by tests/perf-lib.test.ts. No I/O here.
 */

/** One metric of one run. `ciLow`/`ciHigh`: 95 % bootstrap band of the median. */
export interface Summary {
  unit: string;
  n: number;
  median: number;
  p95: number;
  min: number;
  max: number;
  ciLow: number;
  ciHigh: number;
}

export interface StageRow { label: string; n: number; median: number; p95: number }

export interface HostInfo {
  /** Stable identity used to pick baselines: hostname | CPU model | cores | arch. */
  key: string;
  name: string;
  cpu: string;
  cores: number;
  arch: string;
  os: string;
  memGb: number;
  node?: string;
  /** 1/5/15-minute load average before and after the run (null where unknown, e.g. browsers). */
  loadBefore: number[] | null;
  loadAfter: number[] | null;
}

export interface GpuInfo {
  /** `swiftshader` = software rasterization (CPU); `hardware` = a real GPU. */
  backend: 'swiftshader' | 'hardware' | 'unknown';
  /** Renderer path the app chose (webgpu / webgl2) and the adapter description. */
  api?: string;
  adapter?: string;
}

export interface PerfRecord {
  kind: 'time-blast.perf';
  version: 1;
  /** `harness`: pnpm perf on this host. `hardware`: ingested from /measure.html. */
  source: 'harness' | 'hardware';
  suite: string;
  commit: string;
  dirty: boolean;
  branch?: string;
  date: string;
  host: HostInfo;
  browser?: { name: string; version: string };
  gpu: GpuInfo;
  settings?: Record<string, unknown>;
  metrics: Record<string, Summary>;
  /** Per-stage breakdown (stage deltas) of composite metrics, e.g. keystroke → first draw. */
  stages?: Record<string, StageRow[]>;
  notes?: string[];
  durationS?: number;
}

export interface Budget {
  /** Allowed growth of the median relative to the baseline median (0.5 = +50 %). */
  relative: number;
  /** Allowed growth of the median in the metric's unit. Both limits must be exceeded. */
  absolute: number;
  /** Optional, looser limits for p95 (tails are noisier). */
  p95?: { relative: number; absolute: number };
}

export interface Budgets {
  /** How many earlier records of the same host, suite and GPU form the baseline. */
  baselineRuns: number;
  default: Budget;
  metrics: Record<string, Budget>;
}

export type Verdict = 'ok' | 'regressed' | 'improved' | 'no-baseline' | 'missing';
export interface CheckRow {
  metric: string;
  verdict: Verdict;
  current?: number;
  baseline?: number;
  delta?: number;
  limit?: number;
  reason: string;
}

// ───────────────────────── statistics ─────────────────────────

/** Nearest-rank quantile of an ascending array; the median of an even count is the mean of the
 * middle pair (same definition as src/ui/timing.ts). */
export function quantile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  if (q === 0.5 && n % 2 === 0) return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return sorted[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))];
}

/** Small deterministic PRNG so a summary is reproducible from its samples. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 95 % percentile-bootstrap band of the median (`resamples` resamples, fixed seed). */
export function bootstrapMedian(values: readonly number[], resamples = 2000, seed = 1): [number, number] {
  const n = values.length;
  if (n === 0) return [NaN, NaN];
  if (n === 1) return [values[0], values[0]];
  const random = mulberry32(seed);
  const medians = new Float64Array(resamples);
  const sample = new Float64Array(n);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < n; i++) sample[i] = values[(random() * n) | 0];
    sample.sort();
    medians[r] = quantile(sample, 0.5);
  }
  medians.sort();
  return [quantile(medians, 0.025), quantile(medians, 0.975)];
}

const round = (v: number, digits: number) => Number.isFinite(v) ? Number(v.toFixed(digits)) : v;

/** Summary of raw samples, or null when there are none. `digits`: rounding of every field. */
export function summarize(values: readonly number[], unit = 'ms', digits = 3): Summary | null {
  const xs = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  if (!xs.length) return null;
  const sorted = Float64Array.from(xs).sort();
  const [lo, hi] = bootstrapMedian(xs);
  return {
    unit, n: xs.length,
    median: round(quantile(sorted, 0.5), digits), p95: round(quantile(sorted, 0.95), digits),
    min: round(sorted[0], digits), max: round(sorted[sorted.length - 1], digits),
    ciLow: round(lo, digits), ciHigh: round(hi, digits),
  };
}

/** Stage rows from per-sample breakdowns: `rows` are [label, delta] lists in pipeline order. */
export function stageTable(samples: ReadonlyArray<ReadonlyArray<readonly [string, number]>>): StageRow[] {
  const order: string[] = [];
  const values = new Map<string, number[]>();
  for (const rows of samples) for (const [label, delta] of rows) {
    if (!values.has(label)) { values.set(label, []); order.push(label); }
    values.get(label)!.push(delta);
  }
  return order.map(label => {
    const sorted = Float64Array.from(values.get(label)!).sort();
    return { label, n: sorted.length, median: round(quantile(sorted, 0.5), 3), p95: round(quantile(sorted, 0.95), 3) };
  });
}

// ───────────────────────── history and budgets ─────────────────────────

export function parseHistory(text: string): PerfRecord[] {
  const out: PerfRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = JSON.parse(trimmed) as PerfRecord;
    if (record.kind === 'time-blast.perf') out.push(record);
  }
  return out;
}

/** Records comparable with `record`: same source, suite, host and GPU backend. */
export function comparable(a: PerfRecord, b: PerfRecord): boolean {
  return a.source === b.source && a.suite === b.suite && a.host.key === b.host.key && a.gpu.backend === b.gpu.backend;
}

export interface Baseline { median: number; p95: number; ciHigh: number; runs: number; commits: string[] }

/** Baseline of `metric` for `record`: the last `runs` comparable records before it (in history
 * order). Median of their medians and p95s; `ciHigh` is the median of their upper bands. */
export function baselineFor(history: readonly PerfRecord[], record: PerfRecord, metric: string, runs: number): Baseline | null {
  const end = history.indexOf(record);
  const earlier = (end >= 0 ? history.slice(0, end) : history).filter(r => comparable(r, record) && r.metrics[metric]);
  const pick = earlier.slice(-runs);
  if (!pick.length) return null;
  const med = (xs: number[]) => quantile(Float64Array.from(xs).sort(), 0.5);
  return {
    median: med(pick.map(r => r.metrics[metric].median)),
    p95: med(pick.map(r => r.metrics[metric].p95)),
    ciHigh: med(pick.map(r => r.metrics[metric].ciHigh)),
    runs: pick.length,
    commits: pick.map(r => r.commit),
  };
}

export function budgetFor(budgets: Budgets, metric: string): Budget {
  if (budgets.metrics[metric]) return budgets.metrics[metric];
  // Prefix entries ("e2e.stage.*") apply to every metric below them.
  const prefix = Object.keys(budgets.metrics).filter(k => k.endsWith('*') && metric.startsWith(k.slice(0, -1)))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? budgets.metrics[prefix] : budgets.default;
}

/**
 * A metric regresses when its median grew by more than BOTH its relative and absolute budget
 * over the baseline AND the run's 95 % band lies entirely above the baseline's band (so a
 * shift inside the noise never fails). p95 budgets, when set, are checked on thresholds alone.
 * Lower is better for every metric in the suite.
 */
export function check(record: PerfRecord, history: readonly PerfRecord[], budgets: Budgets): CheckRow[] {
  const rows: CheckRow[] = [];
  const names = new Set(Object.keys(record.metrics));
  // Metrics the previous comparable run had: a metric that disappears is reported too.
  const end = history.indexOf(record);
  const previous = (end >= 0 ? history.slice(0, end) : history).filter(r => comparable(r, record)).at(-1);
  for (const name of Object.keys(previous?.metrics ?? {})) names.add(name);
  for (const metric of [...names].sort()) {
    const current = record.metrics[metric];
    const base = baselineFor(history, record, metric, budgets.baselineRuns);
    if (!current) {
      if (base) rows.push({ metric, verdict: 'missing', baseline: base.median, reason: 'metric missing from this run' });
      continue;
    }
    if (!base) { rows.push({ metric, verdict: 'no-baseline', current: current.median, reason: 'no comparable earlier run' }); continue; }
    const budget = budgetFor(budgets, metric);
    const delta = current.median - base.median;
    const limit = Math.max(budget.absolute, budget.relative * base.median);
    const separated = current.ciLow > base.ciHigh;
    const unit = current.unit;
    const fmt = (v: number) => `${round(v, 3)} ${unit}`;
    if (delta > limit && separated) {
      rows.push({ metric, verdict: 'regressed', current: current.median, baseline: base.median, delta, limit,
        reason: `median ${fmt(current.median)} vs ${fmt(base.median)} (+${fmt(delta)} > ${fmt(limit)}; band ${fmt(current.ciLow)} above ${fmt(base.ciHigh)})` });
      continue;
    }
    if (budget.p95) {
      const d95 = current.p95 - base.p95;
      const l95 = Math.max(budget.p95.absolute, budget.p95.relative * base.p95);
      if (d95 > l95) {
        rows.push({ metric, verdict: 'regressed', current: current.p95, baseline: base.p95, delta: d95, limit: l95,
          reason: `p95 ${fmt(current.p95)} vs ${fmt(base.p95)} (+${fmt(d95)} > ${fmt(l95)})` });
        continue;
      }
    }
    const improved = -delta > limit && current.ciHigh < base.median;
    rows.push({ metric, verdict: improved ? 'improved' : 'ok', current: current.median, baseline: base.median, delta, limit,
      reason: `median ${fmt(current.median)} vs ${fmt(base.median)} (${delta >= 0 ? '+' : ''}${fmt(delta)}, limit ${fmt(limit)}, ${base.runs} baseline runs)` });
  }
  return rows;
}

// ───────────────────────── hardware page ingest ─────────────────────────

/** The JSON /measure.html downloads (src/measure/report.ts `MeasureReport`), the parts used here. */
export interface MeasureJson {
  kind: 'time-blast.measure';
  version: 1;
  date: string;
  commit?: string;
  page: { url: string; userAgent: string; browser?: { name: string; version: string } };
  hardware: {
    cores?: number; deviceMemoryGb?: number; platform?: string;
    refreshHz?: number;
    gpu: { api?: string; vendor?: string; architecture?: string; device?: string; description?: string; software?: boolean };
  };
  settings?: Record<string, unknown>;
  metrics: Record<string, { unit: string; samples: number[] }>;
  stages?: Record<string, StageRow[]>;
  notes?: string[];
}

/** Convert a hardware-page report into a history record. */
export function ingest(m: MeasureJson, fallbackCommit = 'unknown'): PerfRecord {
  if (m.kind !== 'time-blast.measure') throw new Error(`not a time-blast.measure report (kind ${String((m as { kind?: unknown }).kind)})`);
  const gpu = m.hardware.gpu ?? {};
  const adapter = [gpu.vendor, gpu.architecture, gpu.device, gpu.description].filter(Boolean).join(' ');
  const software = gpu.software ?? /swiftshader|llvmpipe|software|basic render/i.test(adapter);
  const browser = m.page.browser ?? { name: 'unknown', version: '' };
  const name = m.hardware.platform ?? 'unknown';
  const metrics: Record<string, Summary> = {};
  for (const [key, { unit, samples }] of Object.entries(m.metrics)) {
    const s = summarize(samples, unit);
    if (s) metrics[key] = s;
  }
  return {
    kind: 'time-blast.perf', version: 1, source: 'hardware', suite: 'measure-page',
    commit: m.commit ?? fallbackCommit, dirty: false, date: m.date,
    host: {
      key: `browser|${name}|${m.hardware.cores ?? '?'}|${adapter || 'gpu?'}`, name, cpu: 'unknown (browser)',
      cores: m.hardware.cores ?? 0, arch: '', os: name, memGb: m.hardware.deviceMemoryGb ?? 0,
      loadBefore: null, loadAfter: null,
    },
    browser,
    gpu: { backend: software ? 'swiftshader' : (adapter || gpu.api ? 'hardware' : 'unknown'), api: gpu.api, adapter },
    settings: { ...m.settings, refreshHz: m.hardware.refreshHz, url: m.page.url, userAgent: m.page.userAgent },
    metrics, stages: m.stages, notes: m.notes,
  };
}
