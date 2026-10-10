import { describe, expect, it } from 'vitest';
import { Node, Stage, type Stamp } from '../src/protocol/frame';
import { breakdown, describeInferStats, formatMs, quantile, RollingStats } from '../src/ui/timing';

const s = (stage: number, at: number, node: number = Node.COORDINATOR): Stamp => ({ stage, node, at });

describe('timing breakdown', () => {
  it('measures last keystroke → first draw and per-stage deltas', () => {
    const t0 = 1_700_000_000_000;
    const stamps = [
      s(Stage.KEY_INPUT, t0, Node.UI), s(Stage.DRAFT_SENT, t0 + 0.2, Node.UI), s(Stage.COORD_RECEIVED, t0 + 0.5),
      s(Stage.INFER_SENT, t0 + 0.6), s(Stage.FIRST_TOKEN, t0 + 40, Node.INFERENCE), s(Stage.SQL_RECEIVED, t0 + 80),
      s(Stage.EXEC_SENT, t0 + 80.1), s(Stage.DB_FIRST_BATCH, t0 + 95, Node.DATABASE), s(Stage.RENDER_FIRST_BATCH, t0 + 95.5, Node.RENDERER),
      s(Stage.FIRST_DRAW_SUBMITTED, t0 + 97, Node.RENDERER), s(Stage.FIRST_PRESENTED, t0 + 110, Node.RENDERER),
    ];
    const t = breakdown(stamps, 4, 9);
    expect(t.headline).toBeCloseTo(97);
    expect(t.presented).toBeCloseTo(110);
    expect(t.cacheHit).toBe(false);
    expect(t.rows.map(r => r.label)).toEqual(['key', 'draft sent', 'coordinator', 'inference sent', 'first token', 'SQL received', 'exec sent', 'DB first batch', 'render first batch', 'first draw submitted', 'presented']);
    expect(t.rows[4].offset).toBeCloseTo(40);
    expect(t.rows[4].delta).toBeCloseTo(39.4);
    expect(t.rows[0]).toMatchObject({ offset: 0, delta: 0 });
  });

  it('uses the latest keystroke before the draw as origin and flags cache hits', () => {
    const stamps = [s(Stage.KEY_INPUT, 100), s(Stage.KEY_INPUT, 150), s(Stage.CACHE_HIT, 151), s(Stage.FIRST_DRAW_SUBMITTED, 170), s(Stage.KEY_INPUT, 200)];
    const t = breakdown(stamps, 1, 1);
    expect(t.keyAt).toBe(150);
    expect(t.headline).toBe(20);
    expect(t.cacheHit).toBe(true);
  });

  it('reports no headline without a draw and keeps stages that preceded the keystroke negative', () => {
    const t = breakdown([s(Stage.SQL_RECEIVED, 90), s(Stage.KEY_INPUT, 100), s(Stage.COORD_RECEIVED, 101)], 1, 1);
    expect(t.headline).toBeNull();
    expect(t.rows.find(r => r.stage === Stage.SQL_RECEIVED)!.offset).toBe(-10);
  });
});

describe('rolling history', () => {
  it('keeps the last N samples and reports median and nearest-rank p95', () => {
    const stats = new RollingStats(50);
    for (let i = 1; i <= 120; i++) stats.add(i);
    const summary = stats.summary();
    expect(summary.count).toBe(50);
    expect(summary.min).toBe(71); expect(summary.max).toBe(120);
    expect(summary.median).toBe(95.5);
    expect(summary.p95).toBe(118); // ceil(.95*50)=48th of 71..120
  });
  it('handles empty, odd counts and non-finite samples', () => {
    const stats = new RollingStats(5);
    expect(stats.summary().median).toBeNull();
    stats.add(3); stats.add(NaN); stats.add(1); stats.add(2);
    expect(stats.summary()).toMatchObject({ count: 3, median: 2, p95: 3 });
    expect(quantile([5], .95)).toBe(5);
  });
});

describe('formatting', () => {
  it('formats durations and inference stats', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatMs(3.14159)).toBe('3.14 ms');
    expect(formatMs(42.25)).toBe('42.3 ms');
    expect(formatMs(512.4)).toBe('512 ms');
    expect(describeInferStats({ model: 'm', promptTokens: 900, cachedTokens: 800, completionTokens: 40, costUsd: 0.00012, attempts: 1 })).toBe('m · 900 (800 cached) → 40 tok · $0.00012');
  });
});
