import { describe, expect, it } from 'vitest';
import { CHART_VIEWS, type DatasetContext, type QueryPlan } from '../src/core/types';
import { MAX_WINDOW_HOURS } from '../src/core/query-limits';
import {
  buildLocalSystemPrompt, buildSystemPrompt, LOCAL_MODEL_RESPONSE_SCHEMA,
  MODEL_RESPONSE_SCHEMA, parseLocalModelPlan, parseModelPlan,
} from '../src/inference/plan';

const context: DatasetContext = {
  id: 'fleet-v1', label: 'Fleet telemetry', rowCount: 1000,
  start: Date.UTC(2026, 8, 1), end: Date.UTC(2026, 8, 15),
  vessels: ['Aurora', 'Borealis', 'Calypso', 'Discovery', 'Endeavour', 'Fjord'], description: 'Fixed test data',
};
const full: QueryPlan = { metric: 'speed', aggregate: 'avg', bucketMinutes: 60, windowHours: 24, splitByVessel: false, vessel: null, view: 'line' };
const compact = { m: 'speed', a: 'avg', b: 60, h: 24, s: false, v: null, c: 'line' };

describe('compact local model contract', () => {
  it('expands short keys into exactly the original allowlisted intent', () => {
    expect(parseLocalModelPlan(JSON.stringify(compact), context)).toEqual(full);
    expect(parseLocalModelPlan('{"m":"wave_height","a":"max","b":5,"h":336,"s":true,"v":5,"c":"surface"}', context))
      .toEqual({ metric: 'wave_height', aggregate: 'max', bucketMinutes: 5, windowHours: 336, splitByVessel: true, vessel: 5, view: 'surface' });
  });

  it.each(CHART_VIEWS)('preserves %s as presentation intent without new executable fields', view => {
    expect(parseLocalModelPlan(JSON.stringify({ ...compact, c: view, s: true }), context))
      .toEqual({ ...full, view, splitByVessel: true });
  });

  it.each([337, 15 * 24, 710 * 24, MAX_WINDOW_HOURS])('preserves a %s hour request instead of treating coverage as an intent limit', h => {
    expect(parseLocalModelPlan(JSON.stringify({ ...compact, h }), context)).toEqual({ ...full, windowHours: h });
    expect(LOCAL_MODEL_RESPONSE_SCHEMA.anyOf[0]).toHaveProperty('properties.h.maximum', MAX_WINDOW_HOURS);
  });

  it.each([
    null, [], {}, { ...compact, sql: 'SELECT * FROM telemetry' }, full,
    { m: 'speed', a: 'avg', b: 60, h: 24, s: false, v: null },
    { ...compact, m: 'fuel' }, { ...compact, a: 'sum' }, { ...compact, b: 30 },
    { ...compact, h: '24' }, { ...compact, h: 1.5 }, { ...compact, h: 0 }, { ...compact, h: MAX_WINDOW_HOURS + 1 },
    { ...compact, s: 1 }, { ...compact, s: 'true' }, { ...compact, v: -1 }, { ...compact, v: 6 },
    { ...compact, v: 0.5 }, { ...compact, v: '0' }, { ...compact, c: 'gallery' },
    { ...compact, m: ['speed', 'wind'] }, { ...compact, not: 'Aurora' },
    { ...compact, error: 'unsupported_request' }, { error: 'unsupported' }, { error: null },
  ])('rejects incomplete, extended and invalid encodings without coercion: %j', value => {
    expect(() => parseLocalModelPlan(JSON.stringify(value), context)).toThrow();
  });

  it.each(['map', 'density', 'tracks'])('still rejects unsafe cross-vessel %s coordinates', c => {
    expect(() => parseLocalModelPlan(JSON.stringify({ ...compact, c }), context)).toThrow('separate vessel positions');
  });

  it('preserves dataset bounds and a faithful refusal instead of manufacturing a plan', () => {
    expect(() => parseLocalModelPlan(JSON.stringify({ ...compact, v: 1 }), { ...context, vessels: ['Aurora'] })).toThrow('Unknown vessel');
    expect(() => parseLocalModelPlan('{"error":"unsupported_request"}', context)).toThrow('The model marked this request as unsupported.');
    expect(LOCAL_MODEL_RESPONSE_SCHEMA.anyOf).toContainEqual(MODEL_RESPONSE_SCHEMA.anyOf[1]);
  });

  it('never executes partial, fenced or oversized model text', () => {
    expect(() => parseLocalModelPlan('{"m":"speed",', context)).toThrow('incomplete or invalid JSON');
    expect(() => parseLocalModelPlan('```json\n' + JSON.stringify(compact) + '\n```', context)).toThrow('incomplete or invalid JSON');
    expect(() => parseLocalModelPlan(' '.repeat(16_385), context)).toThrow('size limit');
    expect(() => parseLocalModelPlan('{"__proto__":{},"m":"speed","a":"avg","b":60,"h":24,"s":false,"v":null,"c":"line"}', context)).toThrow('unsupported fields');
  });

  it('keeps the remote contract backward compatible and rejects short keys there', () => {
    expect(parseModelPlan(JSON.stringify(full), context)).toEqual(full);
    expect(() => parseModelPlan(JSON.stringify(compact), context)).toThrow('unsupported fields');
    expect(MODEL_RESPONSE_SCHEMA.anyOf[0]).toHaveProperty('properties.metric');
    expect(LOCAL_MODEL_RESPONSE_SCHEMA.anyOf[0]).toHaveProperty('properties.m');
  });
});

describe('shorter local instructions', () => {
  it('retains meaning restrictions, defaults, dataset identity and the refusal path', () => {
    const prompt = buildLocalSystemPrompt(context);
    expect(prompt).toContain(JSON.stringify(compact));
    expect(prompt).toContain(CHART_VIEWS.join('|'));
    expect(prompt).toContain('never metric vs metric');
    expect(prompt).toContain('no spatial interpolation');
    expect(prompt).toContain('s=true always');
    expect(prompt).toContain('not raw-event density or time spent');
    expect(prompt).toContain('No invented seasonal patterns, monthly/seasonal aggregation, missing months or extrapolation');
    expect(prompt).toContain('Requested windows may exceed coverage: preserve h');
    expect(prompt).toContain('1days or 1day means h=24');
    expect(prompt).not.toContain('At most 14 days');
    expect(prompt).toContain('never silently drop unsupported meaning');
    expect(prompt).toContain('photos/galleries/image URLs: unsupported');
    expect(prompt).toContain('FULL request cannot be represented faithfully');
    expect(prompt).toContain('{"error":"unsupported_request"}');
    expect(prompt).toContain('fixed dataset end, not today');
    expect(prompt).toContain('2026-09-15T00:00:00.000Z');
    expect(prompt).toContain('{"id":5,"name":"Fjord"}');
    expect(new TextEncoder().encode(prompt).length).toBeLessThan(new TextEncoder().encode(buildSystemPrompt(context)).length * 0.6);
  });
});
