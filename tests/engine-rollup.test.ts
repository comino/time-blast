/**
 * Rollups + exact rewrite (src/engine/rollup.ts) and the result cache (src/engine/result-cache.ts),
 * on DuckDB-Wasm's node-blocking bundle. A synthetic table with NULLs, BIGINT and DOUBLE measures,
 * two text dimensions (one with NULLs) and one-second readings with gaps is loaded into a
 * baseline node (batch-1 behaviour) and an optimized node. Every statement must give identical
 * results on both; the positive cases must actually run on a rollup, the negative ones must not.
 *
 * The rewrite needs DuckDB's json extension (fetched from extensions.duckdb.org by lockDown);
 * without network those cases are skipped with a warning.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openNode, sameResult, type BenchNode } from '../evals/database-bench';
import { cacheKey, ResultCache } from '../src/engine/result-cache';

/** Deterministic synthetic readings, 2026-03-01 00:00:03 … ~1 day later. */
function csv(): Uint8Array {
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const sites = ['north', 'south', 'east', ''];
  const lines = ['ts,site,kind,i,d,b'];
  const start = Date.UTC(2026, 2, 1, 0, 0, 3);
  for (let k = 0; k < 86_400; k++) {
    if (rnd() < 0.08) continue; // gaps
    const t = new Date(start + k * 1000).toISOString().replace('T', ' ').replace('Z', '');
    const i = rnd() < 0.05 ? '' : String(Math.floor(rnd() * 200) - 50);
    const d = rnd() < 0.05 ? '' : (rnd() * 100 - 20).toFixed(3);
    const b = String(Math.floor(rnd() * 1e9));
    lines.push(`${t},${sites[k % 4]},${k % 3 ? 'a' : 'b'},${i},${d},${b}`);
  }
  return new TextEncoder().encode(lines.join('\n') + '\n');
}

const REWRITTEN = [
  'SELECT site, avg(d), count(*), count(d), sum(i), min(d), max(b), sum(b), avg(i), mean(d) FROM obs GROUP BY 1 ORDER BY 1 NULLS FIRST',
  "SELECT time_bucket(INTERVAL '15 minutes', ts) AS t, kind, avg(d) AS d FROM obs GROUP BY ALL ORDER BY 1, 2",
  "SELECT time_bucket(INTERVAL '1 minute', ts) AS t, site, count(*) AS n, max(i) AS i FROM obs WHERE ts < TIMESTAMP '2026-03-01 02:00:00' GROUP BY ALL ORDER BY 1, 2 NULLS FIRST",
  "SELECT date_trunc('hour', ts) AS h, sum(b) AS b, avg(i) AS i FROM obs WHERE ts >= TIMESTAMP '2026-03-01 05:17:33' AND ts < '2026-03-01 19:00:00' GROUP BY 1 ORDER BY 1",
  "SELECT date_trunc('hour', ts) AS h, count(*) AS n, min(d) AS d FROM obs WHERE ts > TIMESTAMP '2026-03-01 05:00:00' AND ts <= TIMESTAMP '2026-03-01 19:30:07.5' GROUP BY 1 ORDER BY 1",
  "SELECT kind, count(*) AS n, avg(d) AS d FROM obs WHERE ts BETWEEN DATE '2026-03-01' AND TIMESTAMP '2026-03-01 12:34:56' GROUP BY kind ORDER BY kind",
  "SELECT time_bucket(INTERVAL '1 hour', ts) AS h, avg(d) AS d FROM obs WHERE ts >= date_trunc('day', TIMESTAMP '2026-03-01 23:59:54') - INTERVAL '6 hours' GROUP BY 1 ORDER BY 1",
  "SELECT time_bucket(INTERVAL '1 hour', ts) AS h, avg(d) AS d FROM obs WHERE ts >= TIMESTAMP '2026-03-01 23:59:54' - INTERVAL '30 minutes' GROUP BY 1 ORDER BY 1",
  "SELECT count(*) AS n, sum(d) AS d FROM obs WHERE ts >= TIMESTAMP '2026-03-01 10:00:00.5' AND ts < TIMESTAMP '2026-03-01 10:00:01'",
  "SELECT count(*) AS n, sum(d) AS d FROM obs WHERE ts >= TIMESTAMP '2026-03-01 10:20:30' AND ts <= TIMESTAMP '2026-03-01 10:40:10'",
  'SELECT hour(ts) AS h, avg(d) AS d FROM obs GROUP BY 1 ORDER BY 1',
  'SELECT dayname(ts) AS w, isodow(ts) AS n, avg(d) AS d FROM obs GROUP BY ALL ORDER BY 2',
  "SELECT strftime('%H', ts) AS h, avg(d) AS d FROM obs GROUP BY 1 ORDER BY 1",
  "SELECT strftime(ts, '%Y-%m-%d %H:%M') AS m, count(*) AS n FROM obs WHERE site = 'east' GROUP BY 1 ORDER BY 1",
  'SELECT extract(hour FROM ts) AS h, count(*) AS n FROM obs GROUP BY 1 ORDER BY 1',
  'SELECT ts::DATE AS day, site, avg(i) AS i FROM obs GROUP BY ALL ORDER BY 1, 2 NULLS LAST',
  "SELECT site, avg(d) FILTER (WHERE ts < TIMESTAMP '2026-03-01 12:00:00') AS am, avg(d) FILTER (WHERE ts >= '2026-03-01 12:00') AS pm, count(*) FILTER (WHERE site = 'zzz') AS z FROM obs GROUP BY site ORDER BY site NULLS FIRST",
  "SELECT CASE WHEN ts < TIMESTAMP '2026-03-01 12:00:00' THEN 'am' ELSE 'pm' END AS half, kind, sum(d) AS d FROM obs GROUP BY ALL ORDER BY 1, 2",
  "SELECT count(DISTINCT date_trunc('hour', ts)) AS hours, min(site) AS s, max(kind) AS k FROM obs WHERE kind = 'b'",
  "SELECT avg(d) AS d FROM obs WHERE site = 'north'",
  "SELECT count(*) AS n, sum(d) AS s, avg(d) AS a, min(d) AS lo FROM obs WHERE site = 'nowhere'",
  'SELECT site, count(*) AS n FROM obs GROUP BY site HAVING count(*) > 100 ORDER BY n DESC, site LIMIT 3',
  'SELECT site, avg(d) AS d FROM obs GROUP BY site ORDER BY avg(d) DESC NULLS LAST LIMIT 2',
  'SELECT site, avg(d) * 2, max(d) - min(d), count(*) / 60.0 FROM obs GROUP BY site ORDER BY site',
  'SELECT o.site, avg(o.d) AS d FROM obs AS o WHERE o.kind = \'a\' GROUP BY o.site ORDER BY 1',
  "SELECT site, kind, count(*) AS n FROM obs WHERE (site = 'north' OR kind = 'b') AND site IS NOT NULL AND site NOT IN ('east') GROUP BY ALL ORDER BY 1, 2",
  "SELECT time_bucket(INTERVAL '6 hours', ts) AS t, avg(d) AS d FROM obs GROUP BY 1 ORDER BY 1",
  "SELECT time_bucket(INTERVAL '1 day', ts) AS t, avg(d) AS d FROM obs GROUP BY 1 ORDER BY 1",
  "SELECT time_bucket(INTERVAL '1 week', ts) AS t, time_bucket(INTERVAL '1 month', ts) AS m, avg(d) AS d FROM obs GROUP BY ALL ORDER BY 1",
  "SELECT time_bucket(INTERVAL 2 HOUR, ts) AS t, avg(d) AS d FROM obs GROUP BY 1 ORDER BY 1",
  'SELECT avg(d) AS x, x * 2 AS y FROM obs',
  'SELECT DISTINCT kind, count(*) AS n FROM obs GROUP BY kind ORDER BY kind',
  '-- view: bar\nSELECT kind, count(*) AS n FROM obs GROUP BY kind ORDER BY kind;',
];

const RAW = [
  'SELECT avg(d * 2) AS d FROM obs',
  'SELECT site, count(*) AS n FROM obs WHERE d > 50 GROUP BY site ORDER BY site',
  "SELECT time_bucket(INTERVAL '1 hour', ts) AS ts, avg(d) AS d FROM obs GROUP BY ts ORDER BY ts LIMIT 5",
  'SELECT max(ts) AS t, min(ts) AS f FROM obs',
  "SELECT time_bucket(INTERVAL '90 seconds', ts) AS t, count(*) AS n FROM obs GROUP BY 1 ORDER BY 1 LIMIT 10",
  "SELECT date_trunc('second', ts) AS t, count(*) AS n FROM obs GROUP BY 1 ORDER BY 1 LIMIT 10",
  "SELECT CASE WHEN ts > TIMESTAMP '2026-03-01 12:00:00' THEN 1 ELSE 0 END AS pm, count(*) AS n FROM obs GROUP BY 1 ORDER BY 1",
  "SELECT count(*) AS n FROM obs WHERE ts = TIMESTAMP '2026-03-01 12:00:03'",
  "SELECT strftime('%S', ts) AS s, count(*) AS n FROM obs GROUP BY 1 ORDER BY 1 LIMIT 3",
  'SELECT site, corr(d, i) AS c FROM obs GROUP BY site ORDER BY site',
  'SELECT site, avg(d) OVER (PARTITION BY site) AS w FROM obs LIMIT 3',
  'SELECT count(*) AS n FROM obs WHERE d > (SELECT avg(d) FROM obs)',
  'WITH x AS (SELECT * FROM obs) SELECT count(*) AS n FROM x',
  'SELECT a.site, count(*) AS n FROM obs a JOIN obs b ON a.ts = b.ts GROUP BY 1 ORDER BY 1 NULLS FIRST',
  'SELECT ts, d FROM obs ORDER BY ts LIMIT 5',
  'SELECT site, count(i) AS n, sum(DISTINCT i) AS s FROM obs GROUP BY site ORDER BY site',
  'SELECT site, arg_max(d, ts) AS d FROM obs GROUP BY site ORDER BY site',
  "SELECT count(*) AS n FROM obs WHERE ts >= now() - INTERVAL '1 day'",
  'SELECT site, count(site) AS n FROM obs GROUP BY site ORDER BY site',
  'SELECT site, avg(d) AS d FROM obs GROUP BY site ORDER BY site LIMIT (SELECT 2)',
];

let base: BenchNode, opt: BenchNode;
let json = false;

beforeAll(async () => {
  const bytes = csv();
  const source = { kind: 'url', url: 'https://example.invalid/obs.csv', name: 'obs' } as const;
  base = await openNode({ rollups: false, resultCache: false, compressed: false, fetchBytes: async () => bytes }, source);
  opt = await openNode({ resultCache: false, rollupShortRangeRows: 0, fetchBytes: async () => bytes }, source);
  await opt.rollupsDone;
  json = opt.node.rollups.length > 0 && opt.rollups.every(s => !s.skipped);
  if (!json) console.warn('[engine-rollup] no rollups (json extension not loadable offline?):', JSON.stringify(opt.rollups));
}, 180_000);

afterAll(() => { base?.node.dispose(); opt?.node.dispose(); });

describe('rollup build', () => {
  it('builds minute, hour and day rollups in the background', () => {
    if (!json) return;
    const grains = opt.rollups.filter(s => s.grain).map(s => `${s.grain}:${s.rows}`);
    console.log(`[engine-rollup] built ${grains.join(', ')} in ${opt.rollups.reduce((s, r) => s + r.ms, 0).toFixed(0)} ms (Node)`);
    expect(opt.rollups.map(s => s.grain).filter(Boolean)).toEqual(['minute', 'hour', 'day']);
  });
});

describe('exact rewrite', () => {
  for (const sql of REWRITTEN) {
    it(`rewrites and matches: ${sql.slice(0, 90)}`, async () => {
      if (!json) return;
      const a = await base.run(sql), b = await opt.run(sql);
      expect(a.ok, a.message).toBe(true);
      expect(b.stats.source, `${b.stats.rewrite} ${b.stats.fallback ?? ''}`).toBe('rollup');
      const same = sameResult(sql, a, b);
      expect(same.exact, same.reason).toBe(true);
      expect(a.rows.length).toBeGreaterThan(0);
    });
  }
  for (const sql of RAW) {
    it(`falls back and matches: ${sql.slice(0, 90)}`, async () => {
      if (!json) return;
      const a = await base.run(sql), b = await opt.run(sql);
      expect(b.stats.source).toBe('raw');
      const same = sameResult(sql, a, b);
      expect(same.exact, same.reason).toBe(true);
    });
  }
  it('leaves short ranges to the raw table (default threshold)', async () => {
    if (!json) return;
    const node = opt.node as unknown as { options: { rollupShortRangeRows?: number }; rewrites: Map<string, unknown> };
    const sql = "SELECT time_bucket(INTERVAL '1 hour', ts) AS h, avg(d) AS d FROM obs WHERE ts >= TIMESTAMP '2026-03-01 23:59:54' - INTERVAL '3 hours' GROUP BY 1 ORDER BY 1";
    node.options.rollupShortRangeRows = undefined;
    node.rewrites.clear();
    try {
      const b = await opt.run(sql);
      expect(b.stats.source).toBe('raw');
      expect(b.stats.rewrite).toMatch(/short range/);
    } finally {
      node.options.rollupShortRangeRows = 0;
      node.rewrites.clear();
    }
  });
  it('memoizes the decision per statement text', async () => {
    if (!json) return;
    const sql = REWRITTEN[1];
    await opt.run(sql);
    const again = await opt.run(sql);
    expect(again.stats.rewriteMs!).toBeLessThan(0.5);
  });
});

describe('result cache', () => {
  it('replays a completed result with the same frames, and never caches the wall clock', async () => {
    const node = await openNode({ rollups: false, fetchBytes: async () => csv() }, { kind: 'url', url: 'https://example.invalid/obs.csv', name: 'obs' });
    try {
      const sql = "SELECT time_bucket(INTERVAL '1 minute', ts) AS t, avg(d) AS d FROM obs GROUP BY 1 ORDER BY 1";
      const first = await node.run(sql);
      const second = await node.run(`-- view: line\n${sql};`);
      expect(first.stats.source).toBe('raw');
      expect(second.stats.source).toBe('cache');
      expect(second.stats.batches).toBe(first.stats.batches);
      expect(second.rows).toEqual(first.rows);
      expect(second.names).toEqual(first.names);
      expect(second.types).toEqual(first.types);
      console.log(`[engine-rollup] cache hit first batch ${second.stats.firstBatchMs!.toFixed(3)} ms vs ${first.stats.firstBatchMs!.toFixed(1)} ms executed (Node)`);
      const clock = 'SELECT now() > TIMESTAMP \'2000-01-01\' AS later';
      await node.run(clock);
      expect((await node.run(clock)).stats.source).toBe('raw');
    } finally {
      node.node.dispose();
    }
  }, 60_000);

  it('keys by statement without leading comments, bounds bytes and entries', () => {
    expect(cacheKey('-- view: line\n /* x */ SELECT 1 ')).toBe('SELECT 1');
    expect(cacheKey('SELECT 1 -- trailing')).toBe('SELECT 1 -- trailing');
    const cache = new ResultCache({ maxBytes: 100, maxEntryBytes: 60, maxEntries: 2 });
    const entry = (bytes: number) => ({ schema: undefined as never, batches: [], rows: 0, bytes });
    expect(cache.set('a', entry(50))).toBe(true);
    expect(cache.set('big', entry(61))).toBe(false);
    expect(cache.set('b', entry(40))).toBe(true);
    expect(cache.set('c', entry(30))).toBe(true); // evicts a (bytes and entry count)
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toEqual({ entries: 2, bytes: 70 });
    expect(cache.cacheable('select random()')).toBe(false);
    expect(cache.cacheable('SELECT CURRENT_DATE')).toBe(false);
  });
});
