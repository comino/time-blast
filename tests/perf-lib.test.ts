import { describe, expect, it } from 'vitest';
import { bootstrapMedian, budgetFor, check, ingest, parseHistory, quantile, stageTable, summarize, type Budgets, type MeasureJson, type PerfRecord } from '../scripts/perf/lib';

const host = { key: 'h|cpu|4|arm64', name: 'h', cpu: 'cpu', cores: 4, arch: 'arm64', os: 'linux', memGb: 8, loadBefore: [1, 1, 1], loadAfter: [1, 1, 1] };
const record = (commit: string, median: number, band = 2, extra: Partial<PerfRecord> = {}): PerfRecord => ({
  kind: 'time-blast.perf', version: 1, source: 'harness', suite: 'default', commit, dirty: false, date: `2026-10-11T00:00:0${commit.length}Z`,
  host, gpu: { backend: 'swiftshader' },
  metrics: { 'e2e.keystroke_to_draw': { unit: 'ms', n: 10, median, p95: median * 1.5, min: median / 2, max: median * 2, ciLow: median - band, ciHigh: median + band } },
  ...extra,
});
const budgets: Budgets = { baselineRuns: 3, default: { relative: 0.5, absolute: 10 }, metrics: { 'e2e.*': { relative: 0.3, absolute: 5 } } };

describe('perf statistics', () => {
  it('quantile matches src/ui/timing.ts (nearest rank, mean-of-middle median)', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3], 0.5)).toBe(2);
    expect(quantile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95)).toBe(19);
  });
  it('summarize gives a deterministic band around the median', () => {
    const xs = Array.from({ length: 30 }, (_, i) => 40 + (i % 7));
    const a = summarize(xs)!, b = summarize(xs)!;
    expect(a).toEqual(b);
    expect(a.n).toBe(30);
    expect(a.ciLow).toBeLessThanOrEqual(a.median);
    expect(a.ciHigh).toBeGreaterThanOrEqual(a.median);
    expect(summarize([])).toBeNull();
    expect(bootstrapMedian([5])).toEqual([5, 5]);
  });
  it('stage table keeps pipeline order and summarizes each stage', () => {
    const t = stageTable([[['key', 0], ['db', 10]], [['key', 0], ['db', 30], ['draw', 1]]]);
    expect(t.map(r => r.label)).toEqual(['key', 'db', 'draw']);
    expect(t[1]).toMatchObject({ n: 2, median: 20 });
  });
});

describe('perf budget check', () => {
  it('passes noise, fails a separated regression beyond both limits', () => {
    const base = [record('a', 40), record('bb', 42), record('ccc', 41)];
    const noisy = record('dddd', 47, 8); // +6 ms, bands overlap
    expect(check(noisy, [...base, noisy], budgets)[0].verdict).toBe('ok');
    const slow = record('dddd', 80); // +39 ms > max(5, 0.3·41), band 78–82 above 43
    const rows = check(slow, [...base, slow], budgets);
    expect(rows[0].verdict).toBe('regressed');
    expect(rows[0].baseline).toBe(41);
    const fast = record('dddd', 20);
    expect(check(fast, [...base, fast], budgets)[0].verdict).toBe('improved');
  });
  it('compares only the same host, suite and GPU backend', () => {
    const other = record('a', 10, 1, { gpu: { backend: 'hardware' } });
    const run = record('bb', 80);
    expect(check(run, [other, run], budgets)[0].verdict).toBe('no-baseline');
  });
  it('reports a metric that disappeared', () => {
    const base = record('a', 40);
    const run: PerfRecord = { ...record('bb', 40), metrics: {} };
    expect(check(run, [base, run], budgets)[0].verdict).toBe('missing');
  });
  it('picks the longest matching prefix budget', () => {
    expect(budgetFor(budgets, 'e2e.chip_to_draw').relative).toBe(0.3);
    expect(budgetFor(budgets, 'db.first_batch').relative).toBe(0.5);
  });
  it('parses JSONL history and skips blank lines', () => {
    const text = `${JSON.stringify(record('a', 1))}\n\n${JSON.stringify(record('bb', 2))}\n`;
    expect(parseHistory(text).map(r => r.commit)).toEqual(['a', 'bb']);
  });
});

describe('hardware page ingest', () => {
  const report: MeasureJson = {
    kind: 'time-blast.measure', version: 1, date: '2026-10-11T10:00:00Z',
    page: { url: 'https://x/measure.html', userAgent: 'UA', browser: { name: 'Chrome', version: '145' } },
    hardware: { cores: 8, deviceMemoryGb: 8, platform: 'macOS', refreshHz: 120, gpu: { api: 'webgpu', vendor: 'apple', architecture: 'metal-3' } },
    metrics: { 'hw.keystroke_to_frame': { unit: 'ms', samples: [10, 12, 14] } },
  };
  it('marks a real adapter as hardware and summarizes samples', () => {
    const r = ingest(report, 'abc');
    expect(r.source).toBe('hardware');
    expect(r.gpu.backend).toBe('hardware');
    expect(r.commit).toBe('abc');
    expect(r.metrics['hw.keystroke_to_frame'].median).toBe(12);
  });
  it('labels SwiftShader as software', () => {
    const r = ingest({ ...report, hardware: { ...report.hardware, gpu: { api: 'webgpu', vendor: 'google', architecture: 'swiftshader' } } });
    expect(r.gpu.backend).toBe('swiftshader');
  });
  it('rejects other JSON', () => {
    expect(() => ingest({ kind: 'nope' } as unknown as MeasureJson)).toThrow();
  });
});
