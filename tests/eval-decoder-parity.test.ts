import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSemanticModelPlan, parseSemanticModelPlanV5, parseSemanticModelPlanV6 } from '../src/inference/semantic-plan';
import { parseLocalModelPlan, parseModelPlan } from '../src/inference/plan';
import type { DatasetContext } from '../src/core/types';

const corpus = JSON.parse(readFileSync(resolve('evals/inference-corpus.json'), 'utf8'));
const base = {
  metrics: ['wave_height'], aggregate: 'avg', bucket: { count: 1, unit: 'minute' },
  window: { count: 7, unit: 'day' }, grouping: 'vessel', vessel: null, view: null, unsupported: [],
};

// Actual application decoding and the independent evaluator must agree. Otherwise
// a model could appear accurate/safely rejected offline yet run differently here.
const edgeCases: { id: string; raw: string }[] = [
  ['user-regression', base],
  ['fraction-day', { ...base, window: { count: 1.5, unit: 'day' } }],
  ['fraction-week', { ...base, window: { count: 0.5, unit: 'week' } }],
  ['fraction-bucket', { ...base, bucket: { count: 0.25, unit: 'hour' } }],
  ['unsupported-fraction-hour', { ...base, window: { count: 0.5, unit: 'hour' } }],
  ['unsupported-fraction-bucket', { ...base, bucket: { count: 0.1, unit: 'hour' } }],
  ['adjacent-user-window', { ...base, window: { count: 710, unit: 'day' }, view: 'surface' }],
  ['named-case-space', { ...base, vessel: '  MeRiDiAn  ' }],
  ['named-bom-space', { ...base, vessel: '\ufeffAurora\ufeff' }],
  ['non-js-space', { ...base, vessel: '\x1cAurora\x1c' }],
  ['unknown-vessel', { ...base, vessel: 'Poseidon' }],
  ['unknown-metric', { ...base, metrics: ['fuel'] }],
  ['two-metrics', { ...base, metrics: ['speed', 'wind'] }],
  ['exclusion-captured', { ...base, unsupported: ['except Aurora'] }],
  ['filter-captured', { ...base, unsupported: ['wave_height > 4'] }],
  ['fleet-map-invalid', { ...base, grouping: 'fleet', view: 'map' }],
  ['implicit-map-grouping', { ...base, grouping: null, view: 'map' }],
  ['implicit-surface-grouping', { ...base, grouping: null, view: 'surface' }],
  ['explicit-fleet-surface', { ...base, grouping: 'fleet', view: 'surface' }],
  ['unknown-view', { ...base, view: 'pie' }],
  ['zero-quantity', { ...base, window: { count: 0, unit: 'day' } }],
  ['negative-quantity', { ...base, window: { count: -1, unit: 'day' } }],
  ['boolean-quantity', { ...base, window: { count: true, unit: 'day' } }],
  ['numeric-string', { ...base, window: { count: '7', unit: 'day' } }],
  ['overflow-hours', { ...base, window: { count: 4294967295, unit: 'day' } }],
  ['max-hours', { ...base, window: { count: 4294967295, unit: 'hour' } }],
  ['empty-unsupported-feature', { ...base, unsupported: [' '] }],
  ['empty-metric', { ...base, metrics: [' '] }],
  ['oversized-vessel', { ...base, vessel: 'a'.repeat(129) }],
  ['astral-metric-limit', { ...base, metrics: ['🐋'.repeat(33)] }],
  ['astral-vessel-limit', { ...base, vessel: '🐋'.repeat(65) }],
  ['astral-requirement-limit', { ...base, unsupported: ['🐋'.repeat(81)] }],
  ['extra-fields', { ...base, sql: 'SELECT 1' }],
  ['missing-fields', { metrics: ['speed'] }],
  ['refusal', { error: 'unsupported_request' }],
  ['invalid-refusal', { error: 'anything' }],
].map(([id, value]) => ({ id: id as string, raw: JSON.stringify(value) }));
edgeCases.push({ id: 'truncated-json', raw: '{"metrics":[' });
edgeCases.push({ id: 'oversized-output', raw: 'x'.repeat(16_385) });
edgeCases.push({ id: 'astral-oversized-output', raw: '🐋'.repeat(8193) });
edgeCases.push({ id: 'numeric-integer-as-float', raw: JSON.stringify(base).replace('"count":7', '"count":7.0') });
edgeCases.push({ id: 'non-json-number', raw: JSON.stringify(base).replace('"count":7', '"count":NaN') });

function actualDecoder(raw: string, context: DatasetContext = corpus.context, encoding = 'semantic-v2') {
  try { return { plan: encoding === 'compact' ? parseLocalModelPlan(raw, context)
    : encoding === 'full' ? parseModelPlan(raw, context)
    : encoding === 'semantic-v3' ? parseSemanticModelPlanV5(raw, context)
    : encoding === 'semantic-v4' ? parseSemanticModelPlanV6(raw, context) : parseSemanticModelPlan(raw, context) }; }
  catch (error) { return { error: (error as Error).message }; }
}

function referenceDecoder(cases: { id: string; raw: string }[], context: DatasetContext = corpus.context, encoding = 'semantic-v2') {
  const python = `import importlib.util,json,pathlib,sys
spec=importlib.util.spec_from_file_location('evaluate_inference',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
data=json.load(sys.stdin);results=[]
for case in data['cases']:
 try:
  plan=module.normalize(case['raw'],data['encoding'],data['context'],'stop')
  results.append({'error':'The model marked this request as unsupported.'} if plan==module.REFUSAL else {'plan':plan})
 except module.PlanError as error:results.append({'error':str(error)})
print(json.dumps(results))`;
  const result = spawnSync('python3', ['-c', python, resolve('scripts/evaluate-inference.py')], {
    input: JSON.stringify({ context, cases, encoding }), encoding: 'utf8', timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as ReturnType<typeof actualDecoder>[];
}

describe('native semantic evaluator and production decoder agreement', () => {
  it('matches V6 temporal scope, open unit literals and unchanged strict conversion', () => {
    const cases = edgeCases.map(test => {
      try {
        const value = JSON.parse(test.raw);
        return { ...test, raw: JSON.stringify(value && typeof value === 'object' && !Array.isArray(value) && !('error' in value)
          ? { ...value, timeScope: 'trailing' } : value) };
      } catch { return test; }
    });
    for (const timeScope of ['trailing', 'absolute', 'future', 'past', null, 1, {}]) {
      cases.push({ id: `scope-${JSON.stringify(timeScope)}`, raw: JSON.stringify({ ...base, timeScope }) });
    }
    cases.push({ id: 'missing-scope', raw: JSON.stringify(base) });
    for (const unit of ['month', 'minute', 'second', 'fortnight', 'x'.repeat(65)]) {
      cases.push({ id: `literal-window-unit-${unit}`, raw: JSON.stringify({ ...base, timeScope: 'trailing', window: { count: 1, unit } }) });
    }
    const references = referenceDecoder(cases, corpus.context, 'semantic-v4');
    for (const [index, test] of cases.entries()) expect(references[index], test.id).toEqual(actualDecoder(test.raw, corpus.context, 'semantic-v4'));
  });
  it('matches candidate v5 neutral correction feedback and literal unsupported aggregates', () => {
    const cases = [...edgeCases, ...['median', 'sum', 'avg', 'min', 'max'].map(aggregate => ({
      id: `literal-${aggregate}`, raw: JSON.stringify({ ...base, aggregate }),
    })), { id: 'supported-view-marked-unsupported', raw: JSON.stringify({ ...base, view: 'surface', unsupported: ['3D surface'] }) }];
    const references = referenceDecoder(cases, corpus.context, 'semantic-v3');
    for (const [index, test] of cases.entries()) {
      expect(references[index], test.id).toEqual(actualDecoder(test.raw, corpus.context, 'semantic-v3'));
    }
  });
  it('agrees on literal units, defaults, safety boundaries and exact repair errors', () => {
    const references = referenceDecoder(edgeCases);
    for (const [index, test] of edgeCases.entries()) {
      expect(references[index], test.id).toEqual(actualDecoder(test.raw));
    }
  });
  it('matches the dataset contract for long named vessels in UTF-16 units', () => {
    const name = '🐋'.repeat(64);
    const context = { ...corpus.context, vessels: [name] };
    const cases = [
      { id: 'known-128-unit-name', raw: JSON.stringify({ ...base, vessel: name }) },
      { id: 'over-128-unit-name', raw: JSON.stringify({ ...base, vessel: name + 'x' }) },
    ];
    const references = referenceDecoder(cases, context);
    expect(references[0]).toHaveProperty('plan.vessel', 0);
    expect(references[1]).toHaveProperty('error', 'Unknown vessel.');
    for (const [index, test] of cases.entries()) {
      expect(references[index], test.id).toEqual(actualDecoder(test.raw, context));
    }
  });
  it('also matches the original compact decoder used for model comparisons', () => {
    const compact = { m: 'wave_height', a: 'avg', b: 1, h: 168, s: true, v: null, c: 'line' };
    const cases = [
      { id: 'compact-user-regression', raw: JSON.stringify(compact) },
      { id: 'compact-max-hours', raw: JSON.stringify({ ...compact, h: 4294967295 }) },
      { id: 'compact-overflow-hours', raw: JSON.stringify({ ...compact, h: 4294967296 }) },
      { id: 'compact-invalid-grouping', raw: JSON.stringify({ ...compact, s: false, c: 'map' }) },
      { id: 'compact-invalid-vessel', raw: JSON.stringify({ ...compact, v: 6 }) },
      { id: 'compact-boolean-window', raw: JSON.stringify({ ...compact, h: true }) },
      { id: 'compact-fraction-window', raw: JSON.stringify({ ...compact, h: 1.5 }) },
      { id: 'compact-extra-field', raw: JSON.stringify({ ...compact, sql: 'SELECT 1' }) },
      { id: 'compact-refusal', raw: '{"error":"unsupported_request"}' },
    ];
    const references = referenceDecoder(cases, corpus.context, 'compact');
    for (const [index, test] of cases.entries()) {
      expect(references[index], test.id).toEqual(actualDecoder(test.raw, corpus.context, 'compact'));
    }
  });
  it('matches the full-plan adapter, including its fail-closed refusal policy', () => {
    const plan = corpus.cases[0].expected;
    const cases = [
      { id: 'full-user-regression', raw: JSON.stringify(plan) },
      { id: 'full-invalid-geography', raw: JSON.stringify({ ...plan, view: 'tracks', splitByVessel: false }) },
      { id: 'full-extra-field', raw: JSON.stringify({ ...plan, sql: 'SELECT 1' }) },
      { id: 'full-refusal', raw: '{"error":"unsupported_request"}' },
      { id: 'full-other-error-fails-closed', raw: '{"error":"other","metric":"speed"}' },
      { id: 'full-null', raw: 'null' },
    ];
    const references = referenceDecoder(cases, corpus.context, 'full');
    for (const [index, test] of cases.entries()) {
      expect(references[index], test.id).toEqual(actualDecoder(test.raw, corpus.context, 'full'));
    }
  });
  const directory = resolve('evals/results');
  const paths = existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.json')).sort() : [];
  for (const path of paths) {
    const report = JSON.parse(readFileSync(resolve(directory, path), 'utf8')) as {
      artifact?: { encoding: string }; context: DatasetContext;
      results: { id: string; attempts: { output?: { text: string; truncated: boolean }; finish_reason?: string; actual?: unknown; validation_error?: string | null; correction_feedback?: string }[] }[];
    };
    if (!report.artifact || !['semantic-v2', 'semantic-v3', 'semantic-v4', 'compact', 'full'].includes(report.artifact.encoding)) continue;
    const encoding = report.artifact.encoding;
    it(`agrees on every completed native response in ${path}`, () => {
      const cases = report.results.flatMap(result => result.attempts.flatMap((attempt, index) =>
        attempt.output && !attempt.output.truncated && attempt.finish_reason === 'stop'
          ? [{ id: `${result.id}/attempt-${index + 1}`, raw: attempt.output.text, recordedActual: attempt.actual, validationError: attempt.validation_error,
            followingFeedback: result.attempts[index + 1]?.correction_feedback }] : []));
      expect(cases.length).toBeGreaterThan(0);
      const references = referenceDecoder(cases, report.context, encoding);
      for (const [index, test] of cases.entries()) {
        const decoded = actualDecoder(test.raw, report.context, encoding);
        expect(references[index], test.id).toEqual(decoded);
        const recorded = 'plan' in decoded ? decoded.plan
          : decoded.error === 'The model marked this request as unsupported.' ? { error: 'unsupported_request' } : null;
        expect(test.recordedActual, `${test.id} saved evaluation`).toEqual(recorded);
        const validationError = 'error' in decoded && decoded.error !== 'The model marked this request as unsupported.' ? decoded.error : null;
        expect(test.validationError, `${test.id} saved validation feedback`).toEqual(validationError);
        if (test.followingFeedback) {
          // All frozen model outputs fit the 2,048 UTF-16 correction bound. This
          // assertion freezes the actual historical messages, not only outcomes.
          expect(test.raw.length).toBeLessThanOrEqual(2048);
          const error = validationError ?? 'The model marked this request as unsupported.';
          expect(test.followingFeedback).toBe(`Your previous response failed validation: ${error}\nRe-check the supported capabilities in the system instructions and correct the response for the original complete request. Preserve its metric, aggregation, grouping, time bucket, time window, filters and view. Do not simplify or silently drop any requirement. If the entire request is supported, return its correct JSON plan. If it is truly unsupported, return the unsupported_request JSON response. Return only the JSON response, with no explanation.`);
        }
      }
    });
  }
});
