import { describe, expect, it } from 'vitest';
import { CHART_VIEWS, type DatasetContext, type QueryPlan } from '../src/core/types';
import { MAX_WINDOW_HOURS } from '../src/core/query-limits';
import { parseSemanticModelPlan, parseSemanticModelPlanV5, parseSemanticModelPlanV6, SEMANTIC_MODEL_RESPONSE_SCHEMA, SEMANTIC_MODEL_RESPONSE_SCHEMA_V5, SEMANTIC_MODEL_RESPONSE_SCHEMA_V6 } from '../src/inference/semantic-plan';

const context: DatasetContext = {
  id: 'fleet', label: 'Fleet', rowCount: 1209600,
  start: Date.UTC(2026, 8, 1), end: Date.UTC(2026, 8, 15),
  vessels: ['Aurora', 'Meridian', 'Kestrel', 'Solstice', 'Atlas', 'Nomad'], description: 'Synthetic data',
};
const extracted = {
  metrics: ['wave_height'], aggregate: 'avg', bucket: { count: 1, unit: 'minute' },
  window: { count: 7, unit: 'day' }, grouping: 'vessel', vessel: null, view: null, unsupported: [],
};
const expected: QueryPlan = {
  metric: 'wave_height', aggregate: 'avg', bucketMinutes: 1,
  windowHours: 168, splitByVessel: true, vessel: null, view: 'line',
};
const parse = (changes: Record<string, unknown> = {}, dataset = context) => parseSemanticModelPlan(JSON.stringify({ ...extracted, ...changes }), dataset);

describe('experimental V6 temporal intent remains non-executable when unsupported', () => {
  const candidate = (changes: Record<string, unknown> = {}) => parseSemanticModelPlanV6(JSON.stringify({ ...extracted, timeScope: 'trailing', ...changes }), context);
  it.each(['absolute', 'future'])('rejects %s even when every other query field would execute', timeScope => {
    expect(() => candidate({ timeScope })).toThrow(`The model classified the time scope as ${timeScope}`);
    expect(() => candidate({ timeScope })).toThrow('do not replace absolute dates or future predictions with historical data');
  });
  it('requires explicit temporal intent instead of defaulting missing or unknown scope to historical data', () => {
    expect(() => parseSemanticModelPlanV6(JSON.stringify(extracted), context)).toThrow('missing or unsupported fields');
    for (const timeScope of [null, true, 'past', {}, ['trailing']]) expect(() => candidate({ timeScope })).toThrow('Invalid time scope');
  });
  it('admits literal units during generation while refusing unsupported units during execution', () => {
    const branch = SEMANTIC_MODEL_RESPONSE_SCHEMA_V6.anyOf[0];
    expect(branch).toHaveProperty('properties.window.properties.unit', { type: 'string', maxLength: 64 });
    expect(branch).toHaveProperty('properties.bucket.properties.unit', { type: 'string', maxLength: 64 });
    expect(() => candidate({ window: { count: 1, unit: 'month' } })).toThrow('invalid time window quantity or unit');
    expect(() => candidate({ window: { count: 90, unit: 'minute' } })).toThrow('invalid time window quantity or unit');
    expect(() => candidate({ bucket: { count: 1, unit: 'second' } })).toThrow('invalid time bucket quantity or unit');
  });
  it('converts explicit fractions exactly, never rounds or substitutes a supported interval', () => {
    expect(candidate({ bucket: { count: 0.25, unit: 'hour' }, window: { count: 1.5, unit: 'day' } }))
      .toEqual({ ...expected, bucketMinutes: 15, windowHours: 36 });
    expect(() => candidate({ bucket: { count: 0.2, unit: 'hour' } })).toThrow('Unsupported time bucket');
    expect(() => candidate({ window: { count: 0.5, unit: 'hour' } })).toThrow('positive whole number');
  });
});

describe('experimental v5 preserves unsupported operations and neutral correction feedback', () => {
  it.each(['median', 'sum'])('allows the model to name %s without making it executable', aggregate => {
    expect(SEMANTIC_MODEL_RESPONSE_SCHEMA_V5.anyOf[0]).toHaveProperty('properties.aggregate', { type: 'string', maxLength: 64 });
    expect(SEMANTIC_MODEL_RESPONSE_SCHEMA.anyOf[0]).toHaveProperty('properties.aggregate.enum', ['avg', 'min', 'max']);
    expect(() => parseSemanticModelPlanV5(JSON.stringify({ ...extracted, aggregate }), context)).toThrow('Unsupported aggregation');
  });
  it.each(['avg', 'min', 'max'])('preserves supported aggregate %s', aggregate => {
    expect(parseSemanticModelPlanV5(JSON.stringify({ ...extracted, aggregate }), context)).toEqual({ ...expected, aggregate });
  });
  it('lets the model reconsider a captured false rejection without silently removing its requirements', () => {
    // Exact native Qwen3-4B v4.1 response for the reported adjacent 1days request.
    const captured = '{"metrics":["wave_height"],"aggregate":"avg","bucket":{"count":1,"unit":"hour"},"window":{"count":1,"unit":"day"},"grouping":"vessel","vessel":null,"view":"surface","unsupported":["3D surface"]}';
    expect(() => parseSemanticModelPlan(captured, context)).toThrow('This request includes unsupported requirements: 3D surface.');
    expect(() => parseSemanticModelPlanV5(captured, context)).toThrow('The model marked these requirements as unsupported: 3D surface.');
    expect(() => parseSemanticModelPlanV5(captured, context)).toThrow('Remove an item only if the complete plan represents it');
    const corrected = { ...JSON.parse(captured), unsupported: [] };
    expect(parseSemanticModelPlanV5(JSON.stringify(corrected), context)).toEqual({ ...expected, bucketMinutes: 60, windowHours: 24, view: 'surface' });
    expect(() => parseSemanticModelPlanV5(JSON.stringify({ ...corrected, unsupported: ['excluding Aurora'] }), context)).toThrow('excluding Aurora');
  });
});

describe('literal model quantities', () => {
  it('converts seven days to 168 hours mechanically without asking the model to multiply', () => {
    expect(parse()).toEqual(expected);
  });
  it.each([
    [{ count: 1, unit: 'hour' }, { count: 1, unit: 'day' }, 60, 24],
    [{ count: 15, unit: 'minute' }, { count: 2, unit: 'week' }, 15, 336],
    [{ count: 6, unit: 'hour' }, { count: 710, unit: 'day' }, 360, 17040],
    [{ count: 1, unit: 'day' }, { count: MAX_WINDOW_HOURS, unit: 'hour' }, 1440, MAX_WINDOW_HOURS],
    [{ count: 0.25, unit: 'hour' }, { count: 1.5, unit: 'day' }, 15, 36],
    [{ count: 1, unit: 'hour' }, { count: 0.5, unit: 'day' }, 60, 12],
    [{ count: 1, unit: 'hour' }, { count: 0.5, unit: 'week' }, 60, 84],
  ])('preserves requested quantities %j and %j', (bucket, window, bucketMinutes, windowHours) => {
    expect(parse({ bucket, window })).toEqual({ ...expected, bucketMinutes, windowHours });
  });
  it.each([
    { window: { count: MAX_WINDOW_HOURS, unit: 'day' } },
    { window: { count: 0, unit: 'day' } },
    { window: { count: 0.5, unit: 'hour' } },
    { window: { count: 0.1, unit: 'day' } },
    { window: { count: -1, unit: 'day' } },
    { window: { count: 1e308, unit: 'day' } },
    { window: { count: '7', unit: 'day' } },
    { window: { count: 7, unit: 'month' } },
    { window: { count: 7, unit: 'day', hours: 168 } },
    { window: { count: 7, unit: '__proto__' } },
    { bucket: { count: 2, unit: 'minute' } },
    { bucket: { count: 30, unit: 'minute' } },
    { bucket: { count: 1, unit: 'second' } },
  ])('rejects unsupported quantities instead of rounding or clamping: %j', changes => {
    expect(() => parse(changes)).toThrow();
  });
});

describe('semantic grouping and vessel identity', () => {
  it('uses deterministic defaults only when the model explicitly leaves them unspecified', () => {
    expect(parse({ grouping: null })).toEqual({ ...expected, splitByVessel: false });
  });
  it.each(['heatmap', 'surface', 'map', 'density', 'tracks'])('uses separate vessels for the unspecified grouping of %s', view => {
    expect(parse({ grouping: null, view }).splitByVessel).toBe(true);
  });
  it.each(['heatmap', 'surface'])('preserves an explicit fleet-wide average in %s', view => {
    expect(parse({ grouping: 'fleet', view }).splitByVessel).toBe(false);
  });
  it.each(['map', 'density', 'tracks'])('rejects explicit fleet-coordinate averaging for %s', view => {
    expect(() => parse({ grouping: 'fleet', view })).toThrow('separate vessel positions');
  });
  it.each(CHART_VIEWS)('preserves an explicit %s view', view => {
    expect(parse({ view }).view).toBe(view);
  });
  it('resolves names from the current dataset, accepting case and surrounding space only', () => {
    expect(parse({ vessel: ' atlas ', grouping: null }).vessel).toBe(4);
    expect(parse({ vessel: 'Atlas' }, { ...context, vessels: ['Atlas', 'Aurora'] }).vessel).toBe(0);
    expect(() => parse({ vessel: 'Atlass' })).toThrow('Unknown');
    expect(() => parse({ vessel: 'Atlantis' })).toThrow('Unknown');
    expect(() => parse({ vessel: 'Atlas' }, { ...context, vessels: ['Atlas', 'atlas'] })).toThrow('ambiguous');
    expect(() => parse({ vessel: 'Aurora and Atlas' })).toThrow('Unknown');
  });
  it.each(['A'.repeat(65), 'A'.repeat(128), '🚢'.repeat(64)])('preserves a known vessel name up to the remote context limit (%j)', vessel => {
    expect(parse({ vessel }, { ...context, vessels: [vessel] }).vessel).toBe(0);
  });
  it.each(['A'.repeat(129), '🚢'.repeat(65)])('enforces the context UTF-16 length bound even when code points fit the grammar', vessel => {
    expect(() => parse({ vessel }, { ...context, vessels: [vessel] })).toThrow('Unknown vessel');
  });
});

describe('faithful unsupported extraction', () => {
  it('rejects the whole request when the model preserves more than one metric', () => {
    expect(() => parse({ metrics: ['wave_height', 'wind'] })).toThrow('multiple metrics');
  });
  it('does not force an unknown metric or chart into the nearest supported choice', () => {
    expect(() => parse({ metrics: ['salinity'] })).toThrow('Unsupported metric');
    expect(() => parse({ view: 'pie' })).toThrow('Unsupported chart view');
    expect(SEMANTIC_MODEL_RESPONSE_SCHEMA.anyOf[0]).not.toHaveProperty('properties.metrics.items.enum');
  });
  it.each(['excluding Aurora', 'wind above 20 knots', 'median speed', 'photos', 'correlation with wind'])('preserves unsupported requirement %s as a failure', requirement => {
    expect(() => parse({ unsupported: [requirement] })).toThrow(requirement);
  });
  it('allows a complete explicit refusal but refuses malformed refusal envelopes', () => {
    expect(() => parseSemanticModelPlan('{"error":"unsupported_request"}', context)).toThrow('marked this request as unsupported');
    expect(() => parseSemanticModelPlan('{"error":"unsupported_request","metrics":["speed"]}', context)).toThrow('Invalid model refusal');
    expect(() => parseSemanticModelPlan('{"error":"oops"}', context)).toThrow('Invalid model refusal');
  });
  it.each([
    { metrics: [] }, { metrics: [123] }, { metrics: ['speed', 'wind', 'wave_height', 'water_temp', 'salinity'] },
    { metrics: ['x'.repeat(65)] }, { unsupported: 'none' }, { unsupported: [null] },
    { unsupported: ['x'.repeat(161)] }, { unsupported: Array(9).fill('extra') },
    { grouping: true }, { grouping: 'all' }, { view: 5 }, { vessel: 0 },
    { sql: 'SELECT * FROM telemetry' }, { aggregate: 'sum' },
  ])('never coerces or executes malformed model output: %j', changes => {
    expect(() => parse(changes)).toThrow();
  });
  it('rejects incomplete, fenced, missing-field and oversized outputs', () => {
    expect(() => parseSemanticModelPlan('{"metrics":', context)).toThrow('incomplete or invalid JSON');
    expect(() => parseSemanticModelPlan('```json\n' + JSON.stringify(extracted) + '\n```', context)).toThrow('incomplete or invalid JSON');
    expect(() => parseSemanticModelPlan(' '.repeat(16385), context)).toThrow('size limit');
    const { unsupported: _, ...missing } = extracted;
    expect(() => parseSemanticModelPlan(JSON.stringify(missing), context)).toThrow('missing or unsupported fields');
  });
});
