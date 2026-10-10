/**
 * Scorer self-test for the NL→SQL eval (evals/sql-eval.ts). Unit checks on hand-made results,
 * then the scripted fake-model answers executed against the real fixture in DuckDB-Wasm.
 * The full corpus self-test (every reference variant) is `node scripts/eval-sql.mjs --self-test`.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyError, compareResults, evaluate, expandReference, fakeTranslator, issuesOf, openDatabase,
  SELF_TEST_SCRIPT, summarize, type Column, type Corpus, type Database,
} from '../evals/sql-eval';

const corpus = JSON.parse(readFileSync(new URL('../evals/sql-corpus.json', import.meta.url), 'utf8')) as Corpus;
const cols = (...spec: Array<[string, Column['kind']]>): Column[] => spec.map(([name, kind]) => ({ name, kind }));

describe('compareResults', () => {
  const ref = { columns: cols(['t', 'temporal'], ['vessel', 'text'], ['speed', 'numeric']), rows: [[1, 'A', 10], [1, 'B', 11], [2, 'A', 12]] };
  it('exact, ignoring row order', () => {
    expect(compareResults(ref, { columns: ref.columns, rows: [[2, 'A', 12], [1, 'A', 10], [1, 'B', 11.000000001]] }).category).toBe('exact');
  });
  it('equivalent: other names, rounded values, reordered value columns', () => {
    expect(compareResults(ref, { columns: cols(['x', 'temporal'], ['v', 'text'], ['s', 'numeric']), rows: ref.rows }).category).toBe('equivalent');
    expect(compareResults(ref, { columns: ref.columns, rows: [[1, 'A', 10.004], [1, 'B', 11], [2, 'A', 12]] })).toMatchObject({ category: 'equivalent', rounded: true });
    const two = { columns: cols(['t', 'temporal'], ['a', 'numeric'], ['b', 'numeric']), rows: [[1, 5, 6], [2, 7, 8]] };
    expect(compareResults(two, { columns: two.columns, rows: [[1, 6, 5], [2, 8, 7]] }).category).toBe('equivalent');
  });
  it('shape-violation: x not first, series after value, extra column, wrong order', () => {
    expect(compareResults(ref, { columns: cols(['vessel', 'text'], ['t', 'temporal'], ['speed', 'numeric']), rows: ref.rows.map(([t, v, s]) => [v, t, s]) }).category).toBe('shape-violation');
    expect(compareResults(ref, { columns: cols(['t', 'temporal'], ['speed', 'numeric'], ['vessel', 'text']), rows: ref.rows.map(([t, v, s]) => [t, s, v]) }).category).toBe('shape-violation');
    expect(compareResults(ref, { columns: [...ref.columns, { name: 'n', kind: 'numeric' }], rows: ref.rows.map(r => [...r, 1]) }).category).toBe('shape-violation');
    expect(compareResults(ref, { columns: ref.columns, rows: [...ref.rows].reverse() }, true)).toMatchObject({ category: 'shape-violation', reason: 'right rows in the wrong order' });
  });
  it('wrong: values, row count, missing column', () => {
    expect(compareResults(ref, { columns: ref.columns, rows: [[1, 'A', 10], [1, 'B', 11], [2, 'A', 13]] }).category).toBe('wrong');
    expect(compareResults(ref, { columns: ref.columns, rows: ref.rows.slice(1) }).category).toBe('wrong');
    expect(compareResults(ref, { columns: ref.columns.slice(0, 2), rows: ref.rows.map(r => r.slice(0, 2)) }).category).toBe('wrong');
  });
});

describe('references and issues', () => {
  it('expands $SINCE into three window spellings', () => {
    const out = expandReference('SELECT 1 WHERE $SINCE(7 days)', '2026-09-14 23:59:54');
    expect(out).toEqual([
      "SELECT 1 WHERE ts >= TIMESTAMP '2026-09-14 23:59:54' - INTERVAL '7 day'",
      "SELECT 1 WHERE ts > TIMESTAMP '2026-09-14 23:59:54' - INTERVAL '7 day'",
      "SELECT 1 WHERE ts >= date_trunc('day', TIMESTAMP '2026-09-14 23:59:54') - INTERVAL '6 day'",
    ]);
  });
  it('flags view hints, raw rows, foreign dialect and wall clock', () => {
    const c = corpus.cases.find(x => x.id === 'avg_speed_per_vessel')!;
    expect(issuesOf(c, "-- view: histogram\nSELECT DATETIME('now') AS t, now() AS n", { ok: false, code: 'result_limit', message: '', ms: 0 }))
      .toEqual({ viewHintUnasked: true, viewHintInvalid: true, viewHintMissed: false, rawRows: true, foreignDialect: true, wallClock: true });
    expect(classifyError('DROP TABLE telemetry', { code: 'sql_error', message: '{"exception_type":"Parser"}' })).toBe('rejected-by-guard');
    expect(classifyError('SELECT nope', { code: 'sql_error', message: 'Binder Error' })).toBe('sql-error');
  });
});

describe('self-test against DuckDB-Wasm (scripted cases)', () => {
  let db: Database;
  beforeAll(async () => { db = await openDatabase(); }, 120_000);
  afterAll(() => db?.dispose());
  it('scores every scripted answer as expected', async () => {
    const scripted = Object.fromEntries(Object.entries(SELF_TEST_SCRIPT).map(([id, s]) => [id, s.sql]));
    const only = new Set(Object.keys(SELF_TEST_SCRIPT));
    expect([...only].every(id => corpus.cases.some(c => c.id === id))).toBe(true);
    const cases = await evaluate(corpus, db, fakeTranslator(corpus, scripted), { only });
    expect(Object.fromEntries(cases.map(c => [c.id, c.category]))).toEqual(Object.fromEntries(Object.entries(SELF_TEST_SCRIPT).map(([id, s]) => [id, s.expect])));
    const summary = summarize(cases);
    expect(summary.issues).toMatchObject({ viewHintUnasked: 1, rawRows: 1, foreignDialect: 1 });
  }, 120_000);
});
