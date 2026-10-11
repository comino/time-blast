/**
 * Chart-as-query SQL transforms (src/engine/manipulate.ts), round-tripped through DuckDB-Wasm
 * (node-blocking bundle, `vessels` fixture, the node's defaults incl. rollups and result cache).
 *
 * For every corpus reference statement and every restriction a gesture can produce on its result
 * (x range, text value, text set, NULL), both the rewrite (DuckDB parser/printer) and the wrap
 * must return exactly the original result filtered in JS: same names, types, rows and order.
 * Bucket refinement is checked against hand-written SQL. Needs the json extension (fetched from
 * extensions.duckdb.org by lockDown); without it the rewrite cases are skipped with a warning.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openNode, sameResult, type BenchNode, type Outcome } from '../evals/database-bench';
import { references, type Corpus } from '../evals/sql-eval';
import { apply, CachedTools, formatMicros, manipulate, refinedBucket, restrictionOf, splitLead, wrap, type Restriction, type SqlTools } from '../src/engine/manipulate';
import type { Hit } from '../src/engine/contracts';

const corpus = JSON.parse(readFileSync(new URL('../evals/sql-corpus.json', import.meta.url), 'utf8')) as Corpus;

let bench: BenchNode;
let tools: SqlTools | undefined;
let columns: Set<string>;

beforeAll(async () => {
  bench = await openNode();
  tools = bench.node.sqlTools() as SqlTools | undefined;
  if (!tools) console.warn('json extension unavailable: rewrite cases skipped');
  const described = await bench.run('DESCRIBE telemetry');
  columns = new Set(described.rows.map(r => String(r[0]).toLowerCase()));
}, 240_000);
afterAll(() => bench?.node.dispose());

type Type = Restriction['type'];
const typeOf = (arrow: string): Type =>
  /^Timestamp/.test(arrow) ? 'timestamp' : /^Date/.test(arrow) ? 'date' : /^(Int|Uint)/.test(arrow) ? 'integer'
    : /^(Float|Decimal)/.test(arrow) ? 'number' : /Utf8/.test(arrow) ? 'text' : arrow === 'Bool' ? 'boolean' : 'other';

/** The original result filtered in JS: the meaning every transform must have. */
function filtered(o: Outcome, r: Restriction): Outcome {
  const keep = (v: unknown): boolean => {
    if (r.kind === 'eq') return r.value === null ? v === null : v === r.value;
    if (r.kind === 'in') return r.labels.includes(v as string);
    if (v === null || typeof v !== 'number') return false;
    const scale = r.type === 'timestamp' || r.type === 'date' ? 1000 : 1; // rows: ms, restriction: µs
    return v * scale >= r.lo && v * scale <= r.hi;
  };
  return { ...o, rows: o.rows.filter(row => keep(row[r.column])) };
}

/** Restrictions a gesture could produce on this result. */
function restrictions(o: Outcome): Restriction[] {
  const out: Restriction[] = [];
  o.types.forEach((arrow, column) => {
    const type = typeOf(arrow), name = o.names[column];
    const values = o.rows.map(r => r[column]);
    if (type === 'timestamp' || type === 'date' || ((type === 'integer' || type === 'number') && column === 0)) {
      const sorted = [...new Set(values.filter((v): v is number => typeof v === 'number'))].sort((a, b) => a - b);
      if (sorted.length < 2) return;
      const scale = type === 'timestamp' || type === 'date' ? 1000 : 1;
      const lo = sorted[Math.floor(sorted.length * 0.25)] * scale, hi = sorted[Math.floor(sorted.length * 0.6)] * scale;
      out.push({ kind: 'range', column, name, type, lo, hi, refine: false });
      out.push({ kind: 'range', column, name, type, lo: hi, hi, refine: false });
    } else if (type === 'text') {
      const labels = [...new Set(values.filter((v): v is string => typeof v === 'string'))];
      if (!labels.length) return;
      out.push({ kind: 'eq', column, name, type, value: labels[labels.length > 1 ? 1 : 0] });
      if (labels.length > 2) out.push({ kind: 'in', column, name, type, labels: [labels[0], labels[2]] });
      if (values.includes(null)) out.push({ kind: 'eq', column, name, type, value: null });
    }
  });
  return out;
}

const statements = [...new Set(corpus.cases.flatMap(c => references(c, corpus.now)))];

describe('manipulate: transformed SQL == original result filtered', () => {
  it('holds for every corpus statement and restriction (rewrite and wrap)', async () => {
    const tally = { statements: 0, restrictions: 0, rewrite: 0, wrap: 0, chained: 0, chainedRewrite: 0 };
    const reasons = new Map<string, number>();
    const failures: string[] = [];
    const cached = tools ? new CachedTools(tools) : undefined;
    for (const sql of statements) {
      const original = await bench.run(sql);
      if (!original.ok || original.rows.length < 2) continue;
      tally.statements++;
      const rs = restrictions(original);
      // Chained gestures (e.g. brush, then click a series) on the SQL a gesture produced: the
      // printed tree comes from CachedTools' memo, not a new parse.
      const eq = rs.find(x => x.kind === 'eq' && x.value !== null);
      if (cached && eq) for (const r of rs) {
        if (r === eq || r.column === eq.column) continue;
        const first = apply(sql, r, { tools: cached, columns });
        const second = apply(first.sql!, eq, { tools: cached, columns });
        tally.chained++; if (second.method === 'rewrite') tally.chainedRewrite++;
        const got = await bench.run(second.sql!);
        const v = sameResult(sql, filtered(filtered(original, r), eq), got);
        if (!v.exact) failures.push(`chained ${v.reason}\n  original: ${sql}\n  sql: ${second.sql}\n  ${got.message ?? ''}`);
      }
      for (const r of rs) {
        tally.restrictions++;
        const expected = filtered(original, r);
        const check = async (label: string, text: string | null) => {
          if (!text) { failures.push(`${label}: no SQL for ${JSON.stringify(r)} on ${sql}`); return; }
          const got = await bench.run(text);
          const v = sameResult(sql, expected, got);
          if (!v.exact) failures.push(`${label} ${v.reason}\n  original: ${sql}\n  restriction: ${JSON.stringify(r)}\n  sql: ${text}\n  ${got.message ?? ''}`);
        };
        await check('wrap', wrap(sql, r));
        if (tools) {
          const m = apply(sql, r, { tools: cached, columns });
          tally[m.method === 'rewrite' ? 'rewrite' : 'wrap']++;
          reasons.set(m.reason, (reasons.get(m.reason) ?? 0) + 1);
          await check(m.method, m.sql);
        }
      }
    }
    if (process.env.TB_MANIPULATE_REPORT) writeFileSync(process.env.TB_MANIPULATE_REPORT, JSON.stringify({ tally, reasons: Object.fromEntries(reasons) }, null, 1));
    expect(failures).toEqual([]);
    expect(tally.statements).toBeGreaterThan(30);
    if (tools) expect(tally.rewrite).toBeGreaterThan(tally.restrictions / 2);
  }, 300_000);
});

describe('manipulate: bucket refinement', () => {
  const H = 3600e6;
  const start = Date.UTC(2026, 8, 3, 4) * 1000; // 2026-09-03 04:00 UTC in µs
  const cases: Array<{ sql: string; lo: number; hi: number; expected: string }> = [
    {
      // Brush 3 hours of an hourly line → 1-minute buckets (180 ≥ 48; 5 minutes would be 36).
      sql: "SELECT date_trunc('hour', ts) AS hour, avg(speed) AS speed FROM telemetry GROUP BY 1 ORDER BY 1",
      lo: start, hi: start + 2 * H,
      expected: `SELECT date_trunc('minute', ts) AS hour, avg(speed) AS speed FROM telemetry WHERE ts >= TIMESTAMP '2026-09-03 04:00:00' AND ts < TIMESTAMP '2026-09-03 07:00:00' GROUP BY 1 ORDER BY 1`,
    },
    {
      // Per-vessel 6-hour buckets, GROUP BY ALL; a 12-hour window → 15 minutes (48 buckets).
      sql: "SELECT time_bucket(INTERVAL '6 hours', ts) AS t, vessel, avg(wind) AS wind FROM telemetry GROUP BY ALL ORDER BY 1, 2",
      lo: start - 4 * H, hi: start + 2 * H,
      expected: `SELECT time_bucket(INTERVAL '15 minutes', ts) AS t, vessel, avg(wind) AS wind FROM telemetry WHERE ts >= TIMESTAMP '2026-09-03 00:00:00' AND ts < TIMESTAMP '2026-09-03 12:00:00' GROUP BY ALL ORDER BY 1, 2`,
    },
    {
      // A click on one daily bar → that day in 15-minute buckets (96), existing filter kept.
      sql: "-- view: bar\nSELECT date_trunc('day', ts) AS day, max(wave_height) AS wave FROM telemetry WHERE vessel = 'Aurora' GROUP BY day ORDER BY day",
      lo: Date.UTC(2026, 8, 5) * 1000, hi: Date.UTC(2026, 8, 5) * 1000,
      expected: `SELECT time_bucket(INTERVAL '15 minutes', ts) AS day, max(wave_height) AS wave FROM telemetry WHERE vessel = 'Aurora' AND ts >= TIMESTAMP '2026-09-05 00:00:00' AND ts < TIMESTAMP '2026-09-06 00:00:00' GROUP BY 1 ORDER BY 1`,
    },
  ];
  it.each(cases)('refines $sql', async ({ sql, lo, hi, expected }) => {
    if (!tools) return;
    const r: Restriction = { kind: 'range', column: 0, name: 'x', type: 'timestamp', lo, hi, refine: true };
    const m = apply(sql, r, { tools, columns });
    expect(m.method).toBe('rewrite');
    expect(m.reason).toMatch(/bucket refined/);
    expect(m.sql!.startsWith(splitLead(sql)[0])).toBe(true);
    const [got, want] = [await bench.run(m.sql!), await bench.run(expected)];
    expect(got.ok, got.message).toBe(true);
    expect(sameResult(expected, want, got)).toMatchObject({ exact: true });
    expect(got.rows.length).toBeGreaterThan(40);
  });

  it('does not refine when the window already holds enough buckets, or under HAVING', () => {
    expect(refinedBucket(48 * H, H)).toBeUndefined();
    expect(refinedBucket(3 * H, H)).toBe("date_trunc('minute', $)");
    expect(refinedBucket(12 * H, 6 * H)).toBe("time_bucket(INTERVAL '15 minutes', $)");
    expect(refinedBucket(60e6, 60e6)).toBeUndefined(); // nothing finer than a minute
    if (!tools) return;
    const r: Restriction = { kind: 'range', column: 0, name: 'h', type: 'timestamp', lo: start, hi: start + H, refine: true };
    const having = apply("SELECT date_trunc('hour', ts) AS h, count(*) AS n FROM telemetry GROUP BY 1 HAVING count(*) > 10 ORDER BY 1", r, { tools, columns });
    expect(having.method).toBe('rewrite');
    expect(having.reason).not.toMatch(/refined/);
  });
});

describe('manipulate: shapes that must wrap', () => {
  const r: Restriction = { kind: 'eq', column: 0, name: 'vessel', type: 'text', value: 'Aurora' };
  it.each([
    ['LIMIT', 'SELECT vessel, avg(speed) AS speed FROM telemetry GROUP BY vessel ORDER BY speed DESC LIMIT 3'],
    ['window', 'SELECT vessel, avg(speed) OVER (PARTITION BY vessel) AS s FROM telemetry'],
    ['CTE', 'WITH x AS (SELECT * FROM telemetry) SELECT vessel, count(*) AS n FROM x GROUP BY 1'],
    ['subquery', 'SELECT vessel, n FROM (SELECT vessel, count(*) AS n FROM telemetry GROUP BY 1)'],
    ['aggregate column', 'SELECT max(vessel) AS vessel, count(*) AS n FROM telemetry'],
    ['alias reference', 'SELECT upper(vessel) AS v, v AS vessel, count(*) AS n FROM telemetry GROUP BY ALL'],
  ])('%s', async (_label, sql) => {
    if (!tools) return;
    const m = apply(sql, { ...r, column: _label === 'alias reference' ? 1 : 0 }, { tools, columns });
    expect(m.method).toBe('wrap');
    const got = await bench.run(m.sql!);
    expect(got.ok, got.message).toBe(true);
  });

  it('wrap survives a trailing comment, a semicolon and keeps the view hint in front', async () => {
    const sql = "-- view: bar\nSELECT vessel, count(*) AS n FROM telemetry GROUP BY 1 ORDER BY 1;\n-- typed: count per vessel";
    const text = wrap(sql, r);
    expect(text.startsWith('-- view: bar\nSELECT * FROM (')).toBe(true);
    const got = await bench.run(text);
    expect(got.ok, got.message).toBe(true);
    expect(got.rows).toEqual([['Aurora', 201_600]]);
    expect(wrap(sql, r, 'clickhouse')).toContain(`"vessel" = 'Aurora'`);
  });
});

describe('manipulate: gestures → restrictions', () => {
  const hit = (h: Partial<Hit>): Hit => ({ request: 1, view: 'line', ...h });
  it('brush, series click, bar click, time bar click', () => {
    expect(restrictionOf(hit({ range: { column: 0, name: 't', type: 'timestamp', lo: 1, hi: 2, count: 2 } }), { kind: 'brush', x0: 0, x1: 9 }))
      .toEqual({ kind: 'range', column: 0, name: 't', type: 'timestamp', lo: 1, hi: 2, refine: true });
    expect(restrictionOf(hit({ x: { column: 0, name: 't', type: 'timestamp', value: 5 }, series: { column: 1, name: 'vessel', type: 'text', label: 'Atlas', null: false } }), { kind: 'point', x: 1, y: 1 }))
      .toEqual({ kind: 'eq', column: 1, name: 'vessel', type: 'text', value: 'Atlas' });
    expect(restrictionOf(hit({ view: 'bar', x: { column: 0, name: 'vessel', type: 'text', label: 'NULL', null: true } }), { kind: 'point', x: 1, y: 1 }))
      .toEqual({ kind: 'eq', column: 0, name: 'vessel', type: 'text', value: null });
    expect(restrictionOf(hit({ view: 'bar', x: { column: 0, name: 'day', type: 'timestamp', value: 7 } }), { kind: 'point', x: 1, y: 1 }))
      .toEqual({ kind: 'range', column: 0, name: 'day', type: 'timestamp', lo: 7, hi: 7, refine: true });
    expect(restrictionOf(hit({ range: { column: 0, name: 'v', type: 'text', labels: ['a', 'b'], count: 2 } }), { kind: 'brush', x0: 0, x1: 9 }))
      .toEqual({ kind: 'in', column: 0, name: 'v', type: 'text', labels: ['a', 'b'] });
    expect(manipulate('SELECT 1', hit({}), { kind: 'point', x: 0, y: 0 }).method).toBe('none');
  });
  it('formats microsecond timestamps exactly', () => {
    expect(formatMicros(Date.UTC(2026, 8, 3, 4, 5, 6) * 1000)).toBe('2026-09-03 04:05:06');
    expect(formatMicros(Date.UTC(2026, 8, 3) * 1000 + 123_456)).toBe('2026-09-03 00:00:00.123456');
    expect(formatMicros(Date.UTC(2026, 8, 3) * 1000 + 120_000)).toBe('2026-09-03 00:00:00.12');
  });
});
