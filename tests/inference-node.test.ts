import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decode, encode, header, json, Kind, Node, readJson, readText, Stage, text, type Frame } from '../src/protocol/frame';
import { createInferenceNode, type ChatChunk, type EngineLike } from '../src/inference-node/node';
import { editPrompt, editRepairMessage, repairMessage, systemPrompt, userMessage } from '../src/inference-node/prompt';
import { editBaseJson, parseEditBase } from '../src/protocol/edit';
import { check, keywordAlias, rawRows, rowCheckInputs, SqlStream } from '../src/inference-node/sql';
import { generationOptions, resolveModelId } from '../src/inference-node/models';
import type { DatasetContext } from '../src/engine/contracts';

const fixture = (name: string) => readFileSync(new URL(`../crates/inference-server/tests/fixtures/${name}`, import.meta.url), 'utf8');
const vessels = JSON.parse(fixture('vessels-context.json')) as DatasetContext;

describe('prompt builder twin of crates/inference-server/src/prompt.rs', () => {
  it.each(['refine', 'regenerate'])('shares the exact %s edit prefix, including SQL, lineage, presentation and Unicode', mode => {
    const raw = fixture('edit-base.json').trim().replace('"mode":"refine"', `"mode":"${mode}"`);
    expect(editBaseJson(parseEditBase(raw))).toBe(raw);
    expect(editPrompt(raw)).toBe(fixture(`edit-${mode}-prompt.txt`));
  });
  it.each(['vessels', 'edge', 'weather', 'flights', 'cities'].map(name => [`${name}-context.json`, `${name}-prompt.txt`]))(
    '%s renders the shared golden prompt byte for byte', (context, golden) => {
      expect(systemPrompt(JSON.parse(fixture(context)))).toBe(fixture(golden));
    });

  it('puts only the trimmed question in the user turn and names the dialect in repairs', () => {
    expect(userMessage('  avg speed per vessel \n')).toBe('avg speed per vessel');
    expect(repairMessage(vessels, 'empty reply')).toBe(
      'That reply was rejected: empty reply. Reply with only one DuckDB SELECT statement for my original question.');
  });
});

describe('SQL extraction twin of crates/inference-server/src/sql.rs', () => {
  const cases = JSON.parse(fixture('sql-cases.json')) as {
    stream: Array<{ chunks: string[]; deltas: string; sql: string }>;
    check: Array<{ sql: string; error: string | null }>;
    rows: Array<{ sql: string; error: string | null }>;
    alias: Array<{ sql: string; error: string | null }>;
  };
  it.each(cases.stream)('streams $chunks', ({ chunks, deltas, sql }) => {
    const stream = new SqlStream();
    let seen = '';
    for (const chunk of chunks) {
      seen += stream.push(chunk) ?? '';
      expect(stream.finish().startsWith(seen)).toBe(true);
    }
    expect(seen).toBe(deltas);
    expect(stream.finish()).toBe(sql);
  });
  it.each(cases.rows)('row pre-check $sql', ({ sql, error }) => {
    const { large, time } = rowCheckInputs(vessels);
    expect(large).toEqual([['telemetry', 1209600]]);
    expect(time).toEqual(['ts']);
    const reason = rawRows(sql, large, time);
    if (error === null) expect(reason).toBeUndefined();
    else expect(reason).toContain(error);
  });
  it.each(cases.alias)('keyword alias $sql', ({ sql, error }) => {
    const reason = keywordAlias(sql);
    if (error === null) expect(reason).toBeUndefined();
    else expect(reason).toContain(error);
  });
  it.each(cases.check)('checks $sql', ({ sql, error }) => {
    const reason = check(sql);
    if (error === null) expect(reason).toBeUndefined();
    else expect(reason).toContain(error);
  });
});

describe('model profiles', () => {
  it('picks precision from the adapter and passes concrete ids through', () => {
    expect(resolveModelId(undefined, true)).toBe('Qwen2.5-1.5B-Instruct-q4f16_1-MLC');
    expect(resolveModelId('qwen3-4b', false)).toBe('Qwen3-4B-q4f32_1-MLC');
    expect(resolveModelId('Qwen3-1.7B-q4f16_1-MLC', false)).toBe('Qwen3-1.7B-q4f16_1-MLC');
    expect(generationOptions('Qwen3-4B-q4f16_1-MLC')).toEqual({ extra_body: { enable_thinking: false } });
    expect(generationOptions('Qwen2.5-1.5B-Instruct-q4f16_1-MLC')).toEqual({});
  });
});

// ───────────── the node with a fake engine ─────────────

type Script = Array<string | { content: string; wait: Promise<void> }>;

function fakeEngine(scripts: Script[]) {
  const requests: Array<Record<string, unknown>> = [];
  let interrupted = false;
  let interrupts = 0;
  const engine: EngineLike = {
    chat: { completions: { create: async (request) => {
      requests.push(request);
      if (request.stream === false) return { choices: [] };
      const script = scripts.shift() ?? [];
      interrupted = false;
      return (async function* (): AsyncGenerator<ChatChunk> {
        for (const step of script) {
          const piece = typeof step === 'string' ? step : step.content;
          if (typeof step !== 'string') await step.wait;
          if (interrupted) { yield { choices: [{ delta: {}, finish_reason: 'abort' }] }; return; }
          yield { choices: [{ delta: { content: piece }, finish_reason: null }] };
        }
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
        yield { choices: [], usage: { prompt_tokens: 700, completion_tokens: 12 } };
      })();
    } } },
    interruptGenerate: () => { interrupted = true; interrupts++; },
    resetChat: async () => {},
  };
  return { engine, requests, interrupts: () => interrupts };
}

function harness(scripts: Script[], loadError?: Error) {
  const fake = fakeEngine(scripts);
  const out: Frame[] = [];
  let clock = 1000;
  const node = createInferenceNode({
    post: (buffer) => {
      expect(buffer).toBeInstanceOf(ArrayBuffer);
      out.push(decode(new Uint8Array(buffer)));
    },
    resolveModel: async (requested) => resolveModelId(requested, true),
    createEngine: async (_model, onProgress) => {
      onProgress(0.5, 'half');
      if (loadError) throw loadError;
      return fake.engine;
    },
    options: generationOptions,
    now: () => ++clock,
  });
  const send = (kind: Kind, fields: Partial<Frame>, payload: Uint8Array) =>
    node.receive(encode({ ...header(kind), stamps: [], payload, ...fields }).buffer as ArrayBuffer);
  return {
    ...fake, out, send,
    hello: (model?: string) => send(Kind.HELLO, {}, json({ node: 'coordinator', model })),
    context: () => send(Kind.CONTEXT, { context: 1 }, text(fixture('vessels-context.json'))),
    infer: (request: number, question: string, epoch = 0) => send(Kind.INFER, { request, epoch, revision: request, context: 1 }, text(question)),
    cancel: (request: number, epoch: number) => send(Kind.CANCEL, { request, epoch }, new Uint8Array()),
    frames: (request: number) => out.filter((f) => f.request === request),
    waitFor: async (predicate: () => boolean) => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 0)); expect(predicate()).toBe(true); },
  };
}
const kinds = (frames: Frame[]) => frames.map((f) => f.kind);
const has = (h: ReturnType<typeof harness>, request: number, kind: Kind) => () => h.frames(request).some((f) => f.kind === kind);

describe('WebLLM inference node over tb1', () => {
  it('keeps the selected SQL and lineage in a prepared edit base through repair, and rejects stale handles', async () => {
    const h = harness([['Here is a query: SELECT 1'], ['SELECT 2']]);
    h.hello(); h.context();
    const raw = fixture('edit-base.json').trim();
    h.send(Kind.EDIT_CONTEXT, { request: 90, revision: 3, context: 1 }, text(raw));
    const payload = new Uint8Array(8 + text('weekly instead').length);
    new DataView(payload.buffer).setUint32(0, 90, true); new DataView(payload.buffer).setUint32(4, 3, true); payload.set(text('weekly instead'), 8);
    h.send(Kind.EDIT_INFER, { request: 5, revision: 7, context: 1 }, payload);
    await h.waitFor(has(h, 5, Kind.INFER_STATS));
    const requests = h.requests.filter(r => r.stream === true);
    expect(requests).toHaveLength(2);
    const messages = requests[1].messages as Array<{ role: string; content: string }>;
    expect(messages[0].content).toBe(systemPrompt(vessels) + editPrompt(raw));
    expect(messages[1].content).toBe('weekly instead');
    expect(messages[3].content).toContain('preserving the chart definition and revision mode above');
    expect(readText(h.frames(5).find(f => f.kind === Kind.SQL)!.payload)).toBe('SELECT 2');
    h.send(Kind.EDIT_CONTEXT, { request: 90, revision: 3, context: 1 }, text(raw.replace("Aurora", "Calypso")));
    expect(readJson(h.out.at(-1)!.payload)).toMatchObject({ code: 'bad_edit_context' });
    expect(h.out.at(-1)!.request).toBe(0);
    new DataView(payload.buffer).setUint32(4, 2, true);
    h.send(Kind.EDIT_INFER, { request: 6, revision: 8, context: 1 }, payload);
    expect(readJson(h.frames(6)[0].payload)).toMatchObject({ code: 'unknown_edit_context' });
  });
  it('loads with STATUS frames, warms up, then answers READY with the concrete model', async () => {
    const h = harness([]);
    h.hello('qwen3-4b');
    await h.waitFor(() => h.out.some((f) => f.kind === Kind.READY));
    const statuses = h.out.filter((f) => f.kind === Kind.STATUS).map((f) => readJson<{ state: string; progress?: number }>(f.payload));
    expect(statuses[0]).toMatchObject({ state: 'loading', progress: 0 });
    expect(statuses).toContainEqual(expect.objectContaining({ state: 'loading', progress: 0.5, detail: 'half' }));
    expect(statuses.at(-1)).toMatchObject({ state: 'ready', progress: 1 });
    expect(readJson(h.out.at(-1)!.payload)).toEqual({ node: 'inference', name: 'webllm', version: 1, model: 'Qwen3-4B-q4f16_1-MLC', capabilities: ['edit-context-v1'] });
    expect(h.requests[0]).toMatchObject({ stream: false, max_tokens: 1, extra_body: { enable_thinking: false } });
  });

  it('streams SQL_DELTA, then SQL with the full ledger, then INFER_STATS', async () => {
    const h = harness([['<think>\n\n</think>\n\n', '```sql\nSELECT vessel, ', 'avg(speed) AS speed FROM telemetry GROUP BY 1', '\n```']]);
    h.hello('qwen3-4b'); h.context();
    h.infer(5, ' average speed per vessel ');
    await h.waitFor(has(h, 5, Kind.INFER_STATS));
    const frames = h.frames(5);
    const sql = 'SELECT vessel, avg(speed) AS speed FROM telemetry GROUP BY 1';
    expect(kinds(frames)).toEqual([Kind.SQL_DELTA, Kind.SQL_DELTA, Kind.SQL, Kind.INFER_STATS]);
    expect(frames.filter((f) => f.kind === Kind.SQL_DELTA).map((f) => readText(f.payload)).join('')).toBe(sql);
    expect(readText(frames[2].payload)).toBe(sql);
    const stages = (f: Frame) => f.stamps.map((s) => [s.stage, s.node]);
    expect(stages(frames[0])).toEqual([[Stage.INFER_RECEIVED, Node.INFERENCE], [Stage.PROVIDER_REQUEST, Node.INFERENCE],
      [Stage.FIRST_TOKEN, Node.PROVIDER], [Stage.SQL_FIRST_DELTA, Node.INFERENCE]]);
    expect(frames[1].stamps).toEqual([]);
    expect(stages(frames[2])).toEqual([...stages(frames[0]), [Stage.SQL_COMPLETE, Node.INFERENCE]]);
    for (const f of frames) expect([f.request, f.revision, f.context, f.epoch]).toEqual([5, 5, 1, 0]);
    expect(readJson(frames[3].payload)).toEqual({ model: 'Qwen3-4B-q4f16_1-MLC', promptTokens: 700, completionTokens: 12, attempts: 1 });
    const request = h.requests[1] as { messages: Array<{ role: string; content: string }>; temperature: number; stream: boolean };
    expect(request.messages).toEqual([{ role: 'system', content: fixture('vessels-prompt.txt') }, { role: 'user', content: 'average speed per vessel' }]);
    expect([request.temperature, request.stream]).toEqual([0, true]);
  });

  it('repairs once after prose and streams the repair', async () => {
    const h = harness([['I think you want: SELECT 1'], ['SELECT max(wind) FROM telemetry']]);
    h.hello(); h.context();
    h.infer(1, 'max wind');
    await h.waitFor(has(h, 1, Kind.INFER_STATS));
    const frames = h.frames(1);
    expect(kinds(frames)).toEqual([Kind.SQL_DELTA, Kind.SQL, Kind.INFER_STATS]);
    expect(readJson<{ attempts: number; promptTokens: number }>(frames[2].payload)).toMatchObject({ attempts: 2, promptTokens: 1400 });
    const messages = (h.requests[2] as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages[3].content).toMatch(/^That reply was rejected: the reply must start with SELECT/);
  });

  it('repairs raw rows of a large table once; the SQL frame carries the repair', async () => {
    const fixed = "SELECT time_bucket(INTERVAL '1 hour', ts) AS t, avg(wind) AS w FROM telemetry GROUP BY t ORDER BY t";
    const h = harness([['SELECT ts, wind FROM telemetry'], [fixed]]);
    h.hello(); h.context();
    h.infer(1, 'wind');
    await h.waitFor(has(h, 1, Kind.INFER_STATS));
    const frames = h.frames(1);
    expect(kinds(frames)).toEqual([Kind.SQL_DELTA, Kind.SQL, Kind.INFER_STATS]);
    expect(readText(frames[0].payload)).toBe('SELECT ts, wind FROM telemetry');
    expect(readText(frames[1].payload)).toBe(fixed);
    const messages = (h.requests[2] as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages[3].content).toMatch(/^That reply was rejected: it returns raw rows of telemetry \(1209600 rows\)/);
  });

  it('reports invalid_sql after the second failure, with stats', async () => {
    const h = harness([['DROP TABLE t'], ['Sorry.']]);
    h.hello(); h.context();
    h.infer(2, 'drop');
    await h.waitFor(has(h, 2, Kind.INFER_STATS));
    const frames = h.frames(2);
    expect(kinds(frames)).toEqual([Kind.ERROR, Kind.INFER_STATS]);
    expect(readJson(frames[0].payload)).toMatchObject({ code: 'invalid_sql' });
  });

  it('CANCEL interrupts the engine, silences the request and lets the next one run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness([['SELECT ts', { content: ', 1', wait: gate }], ['SELECT 2']]);
    h.hello(); h.context();
    h.infer(1, 'slow');
    await h.waitFor(has(h, 1, Kind.SQL_DELTA));
    h.cancel(1, 7); // targeted: the epoch stays 0
    expect(h.interrupts()).toBe(1);
    h.infer(2, 'fast', 0);
    release();
    await h.waitFor(has(h, 2, Kind.INFER_STATS));
    expect(kinds(h.frames(1))).toEqual([Kind.SQL_DELTA, Kind.INFER_STATS]);
    expect(readJson(h.frames(1)[1].payload)).toEqual({ model: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', promptTokens: 0, completionTokens: 0, attempts: 1, cancelled: true });
    expect(readText(h.frames(2).find((f) => f.kind === Kind.SQL)!.payload)).toBe('SELECT 2');
  });

  it('drops stale epochs, supersedes a waiting INFER and rejects unknown contexts', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness([['SELECT 1', { content: ' AS a', wait: gate }], ['SELECT 3']]);
    h.hello(); h.context();
    h.infer(1, 'first', 3);
    await h.waitFor(has(h, 1, Kind.SQL_DELTA));
    h.cancel(0, 4); // cancel everything; epoch 4 fences request 1 (epoch 3)
    h.infer(2, 'stale', 3);
    h.infer(3, 'waits', 4);
    h.infer(4, 'replaces the waiting one', 4);
    h.send(Kind.INFER, { request: 5, epoch: 4, context: 42 }, text('q'));
    release();
    await h.waitFor(has(h, 4, Kind.INFER_STATS));
    expect(h.frames(2)).toEqual([]);
    expect(readJson(h.frames(3)[0].payload)).toMatchObject({ code: 'busy' });
    expect(readJson(h.frames(5)[0].payload)).toMatchObject({ code: 'unknown_context' });
    expect(kinds(h.frames(1))).toEqual([Kind.SQL_DELTA, Kind.INFER_STATS]);
    expect(h.frames(1).every((f) => f.epoch === 3)).toBe(true);
  });

  it('queues INFER until the model is ready and reports load failures', async () => {
    const h = harness([['SELECT 1']]);
    h.send(Kind.INFER, { request: 1, context: 1 }, text('x'));
    expect(readJson(h.out[0].payload)).toMatchObject({ code: 'protocol' });
    h.hello(); h.context(); h.infer(2, 'early');
    await h.waitFor(has(h, 2, Kind.INFER_STATS));
    const failing = harness([], new Error('no adapter'));
    failing.hello();
    await failing.waitFor(() => failing.out.some((f) => f.kind === Kind.ERROR));
    expect(readJson(failing.out.at(-1)!.payload)).toMatchObject({ code: 'load_failed', message: 'no adapter' });
  });
});
