import { describe, expect, it } from 'vitest';
import { FrameGrid, mergeDrawn, refreshHz, stageTable } from '../src/measure/report';
import { sqlFor } from '../src/measure/canned';
import type { TimingBreakdown } from '../src/ui/timing';

const t = (request: number, headline: number | null, presented: number | null, keyAt = 1000): TimingBreakdown => ({
  request, revision: request, keyAt, headline, presented, cacheHit: false,
  rows: [{ stage: 1, label: 'key', offset: 0, delta: 0 }, ...(headline === null ? [] : [{ stage: 16, label: 'first draw submitted', offset: headline, delta: headline }]),
    ...(presented === null ? [] : [{ stage: 17, label: 'presented', offset: presented, delta: presented - (headline ?? 0) }])],
});

describe('measure page helpers', () => {
  it('finds the first frame at or after a time', () => {
    const g = new FrameGrid(8);
    for (const at of [100, 116.7, 133.3, 150]) g.push(at);
    expect(g.firstAtOrAfter(116.7)).toBe(116.7);
    expect(g.firstAtOrAfter(120)).toBe(133.3);
    expect(g.firstAtOrAfter(151)).toBeNull();
    for (let i = 0; i < 20; i++) g.push(200 + i); // wraps: keeps the newer half
    expect(g.last).toBe(219);
    expect(g.firstAtOrAfter(0)).toBeGreaterThan(150);
  });
  it('estimates the refresh rate from the median interval', () => {
    expect(refreshHz(Array.from({ length: 30 }, (_, i) => (i % 10 === 0 ? 33.3 : 16.67)))).toBeCloseTo(60, 0);
    expect(refreshHz([16.7])).toBeNull();
  });
  it('merges TIMINGs per request and separates steady adoptions from redraws', () => {
    const grid = new FrameGrid();
    for (let at = 1000; at < 1200; at += 8.33) grid.push(at);
    const drawn = mergeDrawn([t(1, 20, null), t(1, 20, 35), t(2, 50, 50), t(3, null, null)], grid);
    expect(drawn).toHaveLength(2);
    const [redraw, steady] = drawn;
    expect(redraw).toMatchObject({ request: 1, submitted: 1020, gpuDone: 1035, steady: false });
    expect(redraw.frame).toBeGreaterThanOrEqual(1035);
    expect(redraw.frame! - 1035).toBeLessThan(8.34);
    expect(redraw.rows.map(r => r[0])).toEqual(['key', 'first draw submitted', 'GPU work done', 'next animation frame']);
    expect(steady).toMatchObject({ request: 2, steady: true, frame: null });
  });
  it('summarizes stages in first-seen order', () => {
    expect(stageTable([[['a', 1], ['b', 2]], [['a', 3], ['b', 4]]])).toEqual([
      { label: 'a', n: 2, median: 2, p95: 3 }, { label: 'b', n: 2, median: 3, p95: 4 }]);
  });
  it('canned answers: echo appends the question, vary shifts the window per character', () => {
    expect(sqlFor('wind every ten minutes', 'plain')).toContain('avg(wind)');
    expect(sqlFor('max  speed per vessel', 'echo')).toMatch(/\n-- max speed per vessel$/);
    const a = sqlFor('max speed per vessel', 'vary'), b = sqlFor('max speed per vessel x', 'vary');
    expect(a).not.toBe(b);
    expect(a).toContain("WHERE ts >= TIMESTAMP '2026-09-01 02:20:00' GROUP BY");
    expect(a).toContain('avg(speed) AS avg_speed');
  });
});
