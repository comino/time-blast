import { describe, expect, it } from 'vitest';
import { EMPTY_THINKING_PREFIX, modelGenerationOptions, normalizeModelOutput } from '../src/inference/model-output';
import { validateQueryPlan } from '../src/inference/plan';

const MODEL = 'Qwen3-0.6B-q4f16_1-MLC';
const plan = { metric: 'wave_height', aggregate: 'avg', bucketMinutes: 1, windowHours: 168,
  splitByVessel: true, vessel: null, view: 'line' };
const json = JSON.stringify(plan);
const decode = (text: string, model = MODEL) => validateQueryPlan(JSON.parse(normalizeModelOutput(text, model)));

describe('explicit non-thinking model output', () => {
  it.each([
    'Qwen3-0.6B-q4f16_1-MLC', 'Qwen3-0.6B-q4f32_1-MLC',
    'Qwen3-1.7B-q4f16_1-MLC', 'Qwen3-1.7B-q4f32_1-MLC',
    'Qwen3-4B-q4f16_1-MLC', 'Qwen3-4B-q4f32_1-MLC',
  ])('configures %s and decodes its documented empty header', model => {
    expect(modelGenerationOptions(model)).toEqual({ extra_body: { enable_thinking: false } });
    expect(decode(EMPTY_THINKING_PREFIX + json, model)).toEqual(plan);
    expect(decode(json, model)).toEqual(plan);
  });

  it.each([
    'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
    'Qwen3.5-0.8B-q4f16_1-MLC', 'Qwen3-8B-q4f16_1-MLC',
    'Qwen3-0.6B-q0f16-MLC', 'Qwen3-0.6B-q4f16_1-MLC-extra', '',
  ])('keeps generation and decoding unchanged for unapproved model %s', model => {
    expect(modelGenerationOptions(model)).toEqual({});
    expect(normalizeModelOutput(EMPTY_THINKING_PREFIX + json, model)).toBe(EMPTY_THINKING_PREFIX + json);
    expect(() => decode(EMPTY_THINKING_PREFIX + json, model)).toThrow();
    expect(decode(json, model)).toEqual(plan);
  });

  it.each([
    '<think>Reasoning must not be discarded.</think>\n\n',
    '<think>\n \n</think>\n\n', '<think></think>', '<think>\r\n\r\n</think>\r\n\r\n',
    '<THINK>\n\n</THINK>\n\n', '\n' + EMPTY_THINKING_PREFIX, ' ' + EMPTY_THINKING_PREFIX,
    'Prose before JSON. ', '\uFEFF' + EMPTY_THINKING_PREFIX,
  ])('rejects noncanonical content before a plan: %j', prefix => {
    expect(normalizeModelOutput(prefix + json, MODEL)).toBe(prefix + json);
    expect(() => decode(prefix + json)).toThrow();
  });

  it('does not strip a second header or trailing markup to manufacture valid JSON', () => {
    const repeated = EMPTY_THINKING_PREFIX + EMPTY_THINKING_PREFIX + json;
    expect(normalizeModelOutput(repeated, MODEL)).toBe(EMPTY_THINKING_PREFIX + json);
    expect(() => decode(repeated)).toThrow();
    expect(normalizeModelOutput(json + EMPTY_THINKING_PREFIX, MODEL)).toBe(json + EMPTY_THINKING_PREFIX);
    expect(() => decode(json + EMPTY_THINKING_PREFIX)).toThrow();
    expect(() => decode(EMPTY_THINKING_PREFIX + json + '</think>')).toThrow();
    expect(() => decode(EMPTY_THINKING_PREFIX + '```json\n' + json + '\n```')).toThrow();
  });

  it('retains embedded markers and still rejects unsupported plan fields', () => {
    const withExtra = JSON.stringify({ ...plan, explanation: EMPTY_THINKING_PREFIX });
    expect(normalizeModelOutput(EMPTY_THINKING_PREFIX + withExtra, MODEL)).toBe(withExtra);
    expect(() => decode(EMPTY_THINKING_PREFIX + withExtra)).toThrow('missing or unsupported fields');
    expect(() => decode(EMPTY_THINKING_PREFIX + JSON.stringify({ ...plan, bucketMinutes: 2 }))).toThrow('Unsupported time bucket');
  });

  it('normalizes refusal JSON without turning it into an executable plan', () => {
    const refusal = '{"error":"unsupported_request"}';
    expect(normalizeModelOutput(EMPTY_THINKING_PREFIX + refusal, MODEL)).toBe(refusal);
    expect(() => decode(EMPTY_THINKING_PREFIX + refusal)).toThrow();
    expect(() => decode(EMPTY_THINKING_PREFIX)).toThrow();
  });
});
