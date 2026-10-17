import { describe, expect, it, vi } from 'vitest';
import type { DatasetContext } from '../src/engine/contracts';
import { decode, Flag, Kind, readJson, readText, SENDER_REQUEST_BIT, Stage } from '../src/protocol/frame';
import { UiController } from '../src/ui/controller';
import { suggest, tokenize } from '../src/ui/suggest';
import { SuggestController, type Chip } from '../src/ui/suggest-controller';
import { engineFrame, FakeEngine, FakeHost, FakeRail, fakeClock, jsonPayload, slotPayload } from './ui-fake-engine';

const CONTEXT: DatasetContext = {
  id: 5, name: 'vessels', dialect: 'duckdb', tables: [{
    name: 'telemetry', rows: 1_209_600, columns: [
      { name: 'ts', type: 'TIMESTAMP', min: '2026-09-01 00:00:00', max: '2026-09-14 23:59:54' },
      { name: 'vessel', type: 'VARCHAR', distinct: 6, values: ['Aurora', 'Borealis', 'Corsair', 'Kestrel', 'Meridian', 'Nomad'] },
      { name: 'speed', type: 'DOUBLE', min: 0, max: 21 }, { name: 'wind', type: 'DOUBLE', min: 0, max: 40 },
    ],
  }],
};
const by = (list: ReturnType<typeof suggest>, kind: string) => list.find(s => s.kind === kind);

describe('suggest: deterministic SQL variants', () => {
  const hourly = "SELECT time_bucket(INTERVAL '1 hour', ts) AS hour, avg(speed) AS avg_speed FROM telemetry GROUP BY 1 ORDER BY 1";

  it('proposes split, bucket, window and aggregate variants of an hourly series', () => {
    const list = suggest('average speed per hour', hourly, CONTEXT);
    expect(list.map(s => s.kind)).toEqual(['split', 'bucket', 'window', 'agg']);
    expect(by(list, 'split')).toEqual({
      kind: 'split', label: 'by vessel', question: 'average speed per hour, split by vessel',
      sql: "SELECT time_bucket(INTERVAL '1 hour', ts) AS hour, vessel, avg(speed) AS avg_speed FROM telemetry GROUP BY 1, vessel ORDER BY 1, vessel",
    });
    expect(by(list, 'bucket')!.sql).toBe("SELECT time_bucket(INTERVAL '1 day', ts) AS day, avg(speed) AS avg_speed FROM telemetry GROUP BY 1 ORDER BY 1");
    expect(by(list, 'window')!.sql).toBe("SELECT time_bucket(INTERVAL '1 hour', ts) AS hour, avg(speed) AS avg_speed FROM telemetry WHERE ts >= TIMESTAMP '2026-09-14 23:59:54' - INTERVAL '24 hours' GROUP BY 1 ORDER BY 1");
    expect(by(list, 'agg')).toMatchObject({ label: 'max', question: 'average speed per hour, maximum instead of average',
      sql: "SELECT time_bucket(INTERVAL '1 hour', ts) AS hour, max(speed) AS max_speed FROM telemetry GROUP BY 1 ORDER BY 1" });
  });

  it('shifts positional references and keeps GROUP BY ALL when splitting', () => {
    const sql = "SELECT date_trunc('day', ts) AS day, max(wind) AS w, count(*) AS n FROM telemetry GROUP BY 1 ORDER BY 1, 2 DESC";
    expect(by(suggest('max wind per day', sql, CONTEXT), 'split')!.sql)
      .toBe("SELECT date_trunc('day', ts) AS day, vessel, max(wind) AS w, count(*) AS n FROM telemetry GROUP BY 1, vessel ORDER BY 1, 3 DESC");
    const all = "SELECT date_trunc('day', ts) AS day, max(wind) AS w FROM telemetry GROUP BY ALL ORDER BY 1";
    expect(by(suggest('max wind per day', all, CONTEXT), 'split')!.sql).toBe("SELECT date_trunc('day', ts) AS day, vessel, max(wind) AS w FROM telemetry GROUP BY ALL ORDER BY 1, vessel");
  });

  it('turns a scalar aggregate into one bar per value and swaps max → avg with the alias', () => {
    const list = suggest('max wind', 'SELECT max(wind) AS max_wind FROM telemetry', CONTEXT);
    expect(by(list, 'split')!.sql).toBe('SELECT vessel,  max(wind) AS max_wind FROM telemetry GROUP BY vessel ORDER BY vessel');
    expect(by(list, 'agg')!.sql).toBe('SELECT avg(wind) AS avg_wind FROM telemetry');
  });

  it('wraps an existing filter when adding the window, and offers a heatmap for time × series', () => {
    const sql = "SELECT date_trunc('hour', ts) AS hour, vessel, avg(wind) AS wind FROM telemetry WHERE vessel <> 'Aurora' GROUP BY ALL ORDER BY 1, 2";
    const list = suggest('hourly wind by vessel', sql, CONTEXT, 5);
    expect(by(list, 'window')!.sql).toContain("WHERE ( vessel <> 'Aurora') AND ts >= TIMESTAMP '2026-09-14 23:59:54' - INTERVAL '24 hours' GROUP BY ALL");
    expect(by(list, 'split')).toBeUndefined(); // already split by vessel
    expect(by(list, 'view')).toEqual({ kind: 'view', label: 'as heatmap', question: 'hourly wind by vessel, as a heatmap', sql: `-- view: heatmap\n${sql}`, view: 'heatmap' });
  });

  it('never stacks a second time window, never renames inside literals or units', () => {
    const sql = "SELECT time_bucket(INTERVAL 1 HOUR, ts) AS hour, avg(speed) AS speed FROM telemetry WHERE ts >= TIMESTAMP '2026-09-14 23:59:54' - INTERVAL '2 days' GROUP BY 1 ORDER BY hour";
    const list = suggest('speed per hour last 2 days', sql, CONTEXT);
    expect(by(list, 'window')).toBeUndefined();
    expect(by(list, 'bucket')!.sql).toBe("SELECT time_bucket(INTERVAL '1 day', ts) AS day, avg(speed) AS speed FROM telemetry WHERE ts >= TIMESTAMP '2026-09-14 23:59:54' - INTERVAL '2 days' GROUP BY 1 ORDER BY day");
  });

  it('declines shapes it cannot edit exactly', () => {
    for (const sql of [
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'SELECT vessel FROM telemetry UNION SELECT vessel FROM telemetry',
      "SELECT time_bucket(INTERVAL '1 hour', ts) AS ts, avg(speed) AS s FROM telemetry GROUP BY ts", // alias shadows a column
      'SELECT a FROM (SELECT 1 AS a)',
    ]) expect(suggest('q', sql, CONTEXT).filter(s => s.kind !== 'view')).toEqual([]);
    expect(by(suggest('top hours', "SELECT date_trunc('hour', ts) AS h, avg(speed) AS s FROM telemetry GROUP BY 1 ORDER BY 2 DESC LIMIT 5", CONTEXT), 'split')).toBeUndefined();
    expect(suggest('raw speed', 'SELECT ts, speed FROM telemetry LIMIT 100', CONTEXT).map(s => s.kind)).toEqual(['window', 'view']);
    expect(suggest('', 'SELECT 1', CONTEXT)).toEqual([]);
  });

  it('inserts before a trailing comment, never into it', () => {
    const list = suggest('max wind per day', "SELECT date_trunc('day', ts) AS d, max(wind) AS w FROM telemetry GROUP BY 1 -- per day", CONTEXT);
    expect(by(list, 'split')!.sql).toBe("SELECT date_trunc('day', ts) AS d, vessel, max(wind) AS w FROM telemetry GROUP BY 1, vessel -- per day");
    expect(by(suggest('max wind', 'SELECT max(wind) AS w FROM telemetry -- all', CONTEXT), 'split')!.sql).toBe('SELECT vessel,  max(wind) AS w FROM telemetry GROUP BY vessel ORDER BY vessel -- all');
  });

  it('tokenizes strings, quoted identifiers and comments without splitting them', () => {
    const toks = tokenize(`-- view: x\nSELECT 'a, b' AS "x,y" /* c, d */ FROM t`)!;
    expect(toks.filter(t => t.t === 'comma')).toEqual([]);
    expect(tokenize("SELECT 'open")).toBeNull();
    expect(tokenize('SELECT (1')).toBeNull();
  });
});

function harness(options = {}) {
  const engine = new FakeEngine(), host = new FakeHost(), rail = new FakeRail(), clock = fakeClock();
  const ui = new UiController(engine, host, rail, { clock });
  ui.boot({ kind: 'webgpu', model: 'qwen-1.5b' }, { kind: 'fixture', name: 'vessels' });
  ui.receive({ type: 'context', context: CONTEXT });
  const shown: Chip[][] = [];
  let t = 0;
  const suggestions = new SuggestController({
    send: bytes => ui.sendFrame(bytes), epoch: () => ui.drafts.epoch, context: () => ui.context,
    textOf: r => ui.drafts.textOf(r), revision: () => ui.drafts.revision, now: () => (t += 0.5),
  }, { show: chips => shown.push([...chips]) }, { settleMs: 0, ...options });
  ui.observer = frame => suggestions.observe(frame);
  engine.clear();
  return { engine, ui, rail, suggestions, shown };
}
const drawn = (request: number, revision: number) => engineFrame(Kind.TIMING, { request, revision }, new Uint8Array(0), [{ stage: Stage.KEY_INPUT, node: 1, at: 1 }, { stage: Stage.FIRST_DRAW_SUBMITTED, node: 5, at: 9 }]);
const sql = "SELECT time_bucket(INTERVAL '1 hour', ts) AS hour, avg(speed) AS avg_speed FROM telemetry GROUP BY 1 ORDER BY 1";

describe('SuggestController: PRIME + WARM after a drawn result', () => {
  it('primes and warms each suggestion once per drawn request, with sender request ids and the current epoch/context', () => {
    const h = harness();
    h.ui.input('average speed per hour', false, 1);
    const revision = h.ui.drafts.revision;
    h.engine.clear();
    h.ui.receive(engineFrame(Kind.BIND, { request: 7, revision }, slotPayload(1)));
    h.ui.receive(engineFrame(Kind.RESULT, { request: 7, revision }, jsonPayload({ slot: 1, sql, columns: [], view: null, cached: false })));
    expect(h.engine.frames).toEqual([]); // nothing before the first draw
    h.ui.receive(drawn(7, revision));
    h.ui.receive(drawn(7, revision)); // a later DRAWN/PRESENTED TIMING does not regenerate
    const frames = h.engine.frames;
    expect(frames.map(f => f.kind)).toEqual([Kind.PRIME, Kind.EXEC, Kind.PRIME, Kind.EXEC, Kind.PRIME, Kind.EXEC, Kind.PRIME, Kind.EXEC]);
    for (const f of frames) expect([f.context, f.epoch]).toEqual([5, 0]);
    const execs = frames.filter(f => f.kind === Kind.EXEC);
    expect(execs.every(f => f.flags === Flag.WARM && (f.request & SENDER_REQUEST_BIT) !== 0)).toBe(true);
    expect(readJson(frames[0].payload)).toEqual({ question: 'average speed per hour, split by vessel', sql: readText(execs[0].payload) });
    expect(h.shown.at(-1)!.map(c => [c.suggestion.label, c.status])).toEqual([['by vessel', 'warming'], ['per day', 'warming'], ['last 24 hours', 'warming'], ['max', 'warming']]);

    // Answers: ready, withdrawn on error, withdrawn when empty. None reaches cards or the rail.
    const done = (request: number, rows: number, flags: number = Flag.DONE_WARM) => {
      const payload = new Uint8Array(16); new DataView(payload.buffer).setBigUint64(0, BigInt(rows), true);
      h.ui.receive(engineFrame(Kind.DONE, { request, flags }, payload));
    };
    done(execs[0].request, 288, Flag.DONE_WARM | Flag.ROLLUP);
    h.ui.receive(engineFrame(Kind.ERROR, { request: execs[1].request }, jsonPayload({ code: 'sql_error', message: 'x' })));
    done(execs[2].request, 0);
    done(execs[3].request, 336, Flag.DONE_WARM | Flag.RESULT_CACHE);
    expect(h.shown.at(-1)!.map(c => [c.suggestion.label, c.status, c.source])).toEqual([['by vessel', 'ready', 'rollup'], ['max', 'ready', 'cache']]);
    expect(h.rail.errors).toEqual([]);
    expect(h.suggestions.stats).toMatchObject({ results: 1, generated: 4, primed: 4, warmSent: 4, warmDone: 3, warmFailed: 1, warmEmpty: 1, warmCacheHits: 1 });
  });

  it('waits for the editor to settle after a live draw; typing on skips that result, KEEP prepares at once', () => {
    vi.useFakeTimers();
    try {
      const h = harness({ settleMs: 250 });
      h.ui.input('average speed per hour', false, 1);
      h.engine.clear();
      h.ui.receive(engineFrame(Kind.RESULT, { request: 3, revision: 1 }, jsonPayload({ slot: 1, sql })));
      h.ui.receive(drawn(3, 1));
      h.ui.input('average speed per hour b', false, 2); // still typing
      vi.advanceTimersByTime(300);
      expect(h.engine.frames.filter(f => f.kind !== Kind.DRAFT)).toEqual([]);
      h.ui.receive(engineFrame(Kind.RESULT, { request: 4, revision: 2 }, jsonPayload({ slot: 1, sql })));
      h.ui.receive(drawn(4, 2));
      vi.advanceTimersByTime(249);
      expect(h.engine.frames.filter(f => f.kind === Kind.PRIME)).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(h.engine.frames.filter(f => f.kind === Kind.PRIME)).toHaveLength(4);
      h.engine.clear();
      h.ui.receive(engineFrame(Kind.KEEP, { request: 4, revision: 2 }, slotPayload(1))); // same result: nothing new
      expect(h.engine.frames.filter(f => f.kind === Kind.PRIME)).toEqual([]);
      h.ui.input('max wind', false, 3);
      h.ui.receive(engineFrame(Kind.RESULT, { request: 5, revision: 3 }, jsonPayload({ slot: 2, sql: 'SELECT max(wind) AS w FROM telemetry' })));
      h.ui.receive(engineFrame(Kind.KEEP, { request: 5, revision: 3 }, slotPayload(2)));
      expect(h.engine.frames.filter(f => f.kind === Kind.PRIME).length).toBeGreaterThan(0);
    } finally { vi.useRealTimers(); }
  });

  it('can prime without warming, and does nothing when disabled', () => {
    const h = harness({ warm: false });
    h.ui.input('average speed per hour', false, 1);
    h.engine.clear();
    h.ui.receive(engineFrame(Kind.RESULT, { request: 3, revision: 1 }, jsonPayload({ slot: 1, sql })));
    h.ui.receive(drawn(3, 1));
    expect(h.engine.frames.map(f => f.kind)).toEqual([Kind.PRIME, Kind.PRIME, Kind.PRIME, Kind.PRIME]);
    expect(h.shown.at(-1)!.every(c => c.status === 'ready')).toBe(true);
    const off = harness({ enabled: false });
    off.ui.input('average speed per hour', false, 1);
    off.engine.clear();
    off.ui.receive(engineFrame(Kind.RESULT, { request: 3, revision: 1 }, jsonPayload({ slot: 1, sql })));
    off.ui.receive(drawn(3, 1));
    expect(off.engine.frames).toEqual([]);
  });

  it('a pick commits the suggestion question like Enter (one COMMIT with KEY_INPUT = the click)', () => {
    const h = harness();
    h.ui.input('average speed per hour', false, 1);
    h.ui.receive(engineFrame(Kind.RESULT, { request: 3, revision: 1 }, jsonPayload({ slot: 1, sql })));
    h.ui.receive(drawn(3, 1));
    h.engine.clear();
    const chip = h.suggestions.chips[0];
    h.suggestions.picked(chip);
    h.ui.commit(chip.suggestion.question, 42);
    const [commit] = h.engine.frames;
    expect(commit.kind).toBe(Kind.COMMIT);
    expect(readText(commit.payload)).toBe('average speed per hour, split by vessel');
    expect(commit.stamps[0]).toEqual({ stage: Stage.KEY_INPUT, node: 1, at: 1_000_042 });
    expect(h.suggestions.stats.picks).toBe(1);
    expect(decode).toBeTypeOf('function');
  });
});
