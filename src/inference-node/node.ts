/**
 * In-browser inference node speaking tb1 (docs/protocol-v1.md). Transport-free: frames come in
 * through receive() and leave through deps.post() as transferable ArrayBuffers. The WebLLM
 * engine is injected so tests can drive the node with a fake.
 *
 * Flow per INFER: INFER_RECEIVED → PROVIDER_REQUEST → FIRST_TOKEN → SQL_DELTA* (first carries
 * SQL_FIRST_DELTA) → SQL (SQL_COMPLETE, full inference ledger) → INFER_STATS. One generation runs
 * at a time (one GPU); at most one INFER waits behind it. CANCEL interrupts the engine.
 */
import type { DatasetContext } from '../engine/contracts';
import { decode, encode, header, json, Kind, Node, readJson, readText, Stage, text, type Frame, type Header, type Stamp } from '../protocol/frame';
import { editPrompt, editRepairMessage, repairMessage, systemPrompt, userMessage } from './prompt';
import { EDIT_CAPABILITY, parseEditBase } from '../protocol/edit';
import { check, keywordAlias, rawRows, rowCheckInputs, SqlStream } from './sql';

export interface ChatChunk {
  choices: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
/** The subset of WebLLM's MLCEngine this node uses. */
export interface EngineLike {
  chat: { completions: { create(request: Record<string, unknown>): Promise<unknown> } };
  interruptGenerate(): void;
  resetChat(): Promise<void>;
}
export interface InferenceNodeDeps {
  /** Send one encoded frame; the buffer is transferred. */
  post(buffer: ArrayBuffer): void;
  /** Profile id or MLC id → concrete MLC model id (checks WebGPU). */
  resolveModel(requested: string | undefined): Promise<string>;
  createEngine(model: string, onProgress: (progress: number, detail: string) => void): Promise<EngineLike>;
  /** Extra request fields per model (e.g. Qwen3 enable_thinking=false). */
  options?(model: string): Record<string, unknown>;
  now(): number;
  maxTokens?: number;
}

interface Job {
  header: Header;
  question: string;
  context: Prepared;
  receivedAt: number;
  cancelled: boolean;
}
interface Prepared { context: DatasetContext; system: string; rows: ReturnType<typeof rowCheckInputs>; edit?: boolean }

const MAX_CONTEXTS = 4;
const MAX_QUESTION_CHARS = 16384;

export function createInferenceNode(deps: InferenceNodeDeps) {
  let greeted = false;
  let ready = false;
  let model = '';
  let engine: EngineLike | undefined;
  let epoch = 0;
  const contexts = new Map<number, Prepared>();
  const edits = new Map<number, { generation: number; context: number; raw: string; prepared: Prepared }>();
  let running: Job | undefined;
  let waiting: Job | undefined;

  const send = (frame: Frame) => {
    const bytes = encode(frame);
    deps.post(bytes.buffer as ArrayBuffer);
  };
  const reply = (kind: Kind, base: Header, payload: Uint8Array, stamps: Stamp[] = []): Frame =>
    ({ ...base, kind, flags: 0, stamps, payload });
  const error = (base: Header, code: string, message: string) => send(reply(Kind.ERROR, base, json({ code, message })));
  const status = (state: string, label: string, extra: Record<string, unknown> = {}) =>
    send({ ...header(Kind.STATUS), stamps: [], payload: json({ component: 'inference', state, label, ...extra }) });

  async function load(requested: string | undefined) {
    try {
      model = await deps.resolveModel(requested);
      status('loading', `Loading ${model}`, { progress: 0 });
      const created = await deps.createEngine(model, (progress, detail) =>
        status('loading', `Loading ${model}`, { progress: Math.max(0, Math.min(1, progress)), detail }));
      // Warm the generation pipeline (shader compilation, first dispatch) before READY.
      status('loading', 'Warming up', { detail: model });
      await created.chat.completions.create({
        ...deps.options?.(model), messages: [{ role: 'user', content: 'SELECT 1' }], stream: false, temperature: 0, max_tokens: 1,
      });
      await created.resetChat();
      engine = created;
      ready = true;
      status('ready', 'Browser model ready', { progress: 1, detail: model });
      send({ ...header(Kind.READY), stamps: [], payload: json({ node: 'inference', name: 'webllm', version: 1, model, capabilities: [EDIT_CAPABILITY] }) });
      pump();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      status('error', 'Browser model unavailable', { detail: message });
      error(header(Kind.ERROR), 'load_failed', message);
    }
  }

  function receive(data: ArrayBuffer | Uint8Array) {
    let frame: Frame;
    try {
      frame = decode(data instanceof Uint8Array ? data : new Uint8Array(data));
    } catch (cause) {
      error(header(Kind.ERROR), 'protocol', cause instanceof Error ? cause.message : String(cause));
      return;
    }
    const receivedAt = deps.now();
    if (!greeted) {
      if (frame.kind !== Kind.HELLO) { error(frame, 'protocol', 'The first frame must be HELLO.'); return; }
      greeted = true;
      let requested: string | undefined;
      try { requested = readJson<{ model?: string }>(frame.payload).model; } catch { /* default model */ }
      void load(requested);
      return;
    }
    switch (frame.kind) {
      case Kind.CONTEXT: return onContext(frame);
      case Kind.CANCEL: return onCancel(frame);
      case Kind.INFER: return onInfer(frame, receivedAt);
      case Kind.EDIT_CONTEXT: return onEditContext(frame);
      case Kind.EDIT_INFER: return onInfer(frame, receivedAt);
      default: return; // frames for other nodes are ignored
    }
  }

  function onEditContext(frame: Frame) {
    try {
      const context = contexts.get(frame.context);
      if (!context || !frame.request || !frame.revision) throw new Error('Unknown context or invalid edit handle');
      const raw = readText(frame.payload);
      parseEditBase(raw);
      const old = edits.get(frame.request);
      if (old && old.generation >= frame.revision) {
        if (old.generation === frame.revision && old.context === frame.context && old.raw === raw) return;
        throw new Error('Edit handles are immutable');
      }
      edits.delete(frame.request);
      edits.set(frame.request, { generation: frame.revision, context: frame.context, raw,
        prepared: { ...context, system: context.system + editPrompt(raw), edit: true } });
      while (edits.size > 64) edits.delete(edits.keys().next().value!);
    } catch (cause) {
      // EDIT_CONTEXT's request field is a target handle, not an execution id.
      error({ ...frame, request: 0, revision: 0 }, 'bad_edit_context', cause instanceof Error ? cause.message : String(cause));
    }
  }

  function onContext(frame: Frame) {
    try {
      const context = readJson<DatasetContext>(frame.payload);
      if (!Array.isArray(context.tables) || context.tables.length === 0) throw new Error('context lists no tables');
      if (frame.context !== 0 && frame.context !== context.id) throw new Error('CONTEXT header id differs from the payload id.');
      contexts.delete(context.id);
      contexts.set(context.id, { context, system: systemPrompt(context), rows: rowCheckInputs(context) });
      while (contexts.size > MAX_CONTEXTS) contexts.delete(contexts.keys().next().value!);
    } catch (cause) {
      error(frame, 'bad_context', `Invalid DatasetContext: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  /** request 0: cancel everything and adopt the new epoch; otherwise only that request. */
  function onCancel(frame: Frame) {
    if (frame.request === 0) epoch = Math.max(epoch, frame.epoch);
    const doomed = (job: Job) => frame.request === 0 || job.header.request === frame.request;
    if (waiting && doomed(waiting)) waiting = undefined;
    if (running && doomed(running) && !running.cancelled) {
      running.cancelled = true;
      engine?.interruptGenerate();
    }
  }

  function onInfer(frame: Frame, receivedAt: number) {
    if (frame.epoch < epoch) return; // stale
    let context = contexts.get(frame.context);
    if (!context) { error(frame, 'unknown_context', 'No CONTEXT with this id.'); return; }
    let payload = frame.payload;
    if (frame.kind === Kind.EDIT_INFER) {
      if (payload.byteLength < 8) { error(frame, 'bad_request', 'EDIT_INFER needs an edit handle'); return; }
      const p = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const edit = edits.get(p.getUint32(0, true));
      if (!edit || edit.context !== frame.context || edit.generation !== p.getUint32(4, true)) {
        error(frame, 'unknown_edit_context', 'No EDIT_CONTEXT with this handle.'); return;
      }
      context = edit.prepared; payload = payload.subarray(8);
    }
    let question = '';
    try { question = readText(payload); } catch { /* rejected below */ }
    if (question.trim() === '' || Array.from(question).length > MAX_QUESTION_CHARS) {
      error(frame, 'bad_request', 'The question must be non-empty UTF-8 of at most 16384 characters.');
      return;
    }
    const { stamps: _s, payload: _p, ...rest } = frame;
    const job: Job = { header: rest, question, context, receivedAt, cancelled: false };
    if (waiting) error(waiting.header, 'busy', 'Superseded by a newer INFER while the model was busy.');
    waiting = job;
    pump();
  }

  function pump() {
    if (!ready || running || !waiting) return;
    running = waiting;
    waiting = undefined;
    const job = running;
    void generate(job).finally(() => {
      if (running === job) running = undefined;
      pump();
    });
  }

  async function generate(job: Job) {
    const ledger: Stamp[] = [{ stage: Stage.INFER_RECEIVED, node: Node.INFERENCE, at: job.receivedAt }];
    const has = (stage: number) => ledger.some((s) => s.stage === stage);
    const messages: ChatMessage[] = [
      { role: 'system', content: job.context.system },
      { role: 'user', content: userMessage(job.question) },
    ];
    const spent = { promptTokens: 0, completionTokens: 0, attempts: 0 };
    let streamedAny = false;
    const live = () => !job.cancelled && job.header.epoch >= epoch;
    const stats = () => send(reply(Kind.INFER_STATS, job.header, json({ model, ...spent })));
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        spent.attempts = attempt;
        if (attempt === 1) ledger.push({ stage: Stage.PROVIDER_REQUEST, node: Node.INFERENCE, at: deps.now() });
        const streamDeltas = !streamedAny;
        const sql = new SqlStream();
        let raw = '';
        let finish: string | null | undefined;
        const stream = (await engine!.chat.completions.create({
          ...deps.options?.(model), messages, stream: true, stream_options: { include_usage: true },
          temperature: 0, max_tokens: deps.maxTokens ?? 512,
        })) as AsyncIterable<ChatChunk>;
        for await (const chunk of stream) {
          if (!live()) { engine!.interruptGenerate(); continue; } // drain without emitting
          const choice = chunk.choices[0];
          const content = choice?.delta?.content ?? '';
          if (content) {
            raw += content;
            if (!has(Stage.FIRST_TOKEN)) ledger.push({ stage: Stage.FIRST_TOKEN, node: Node.PROVIDER, at: deps.now() });
            const delta = sql.push(content);
            if (delta !== undefined && streamDeltas) {
              let stamps: Stamp[] = [];
              if (!streamedAny) {
                ledger.push({ stage: Stage.SQL_FIRST_DELTA, node: Node.INFERENCE, at: deps.now() });
                stamps = ledger.slice();
                streamedAny = true;
              }
              send(reply(Kind.SQL_DELTA, job.header, text(delta), stamps));
            }
          }
          finish = choice?.finish_reason ?? finish;
          if (chunk.usage) {
            spent.promptTokens += chunk.usage.prompt_tokens ?? 0;
            spent.completionTokens += chunk.usage.completion_tokens ?? 0;
          }
        }
        if (!live()) {
          // Cancelled: no SQL, but the spend stays visible.
          send(reply(Kind.INFER_STATS, job.header, json({ model, ...spent, cancelled: true })));
          return;
        }
        const final = sql.finish();
        // Attempt 1 also gets the keyword-alias and raw-row pre-checks (twin of infer.rs); attempt 2 is taken as is.
        const reason = finish !== 'stop' ? `the reply was cut off (finish reason ${finish ?? 'missing'})`
          : check(final)
            ?? (attempt === 1 && job.context.context.dialect === 'duckdb' ? keywordAlias(final) : undefined)
            ?? (attempt === 1 ? rawRows(final, job.context.rows.large, job.context.rows.time) : undefined);
        if (reason === undefined) {
          if (!has(Stage.SQL_FIRST_DELTA)) ledger.push({ stage: Stage.SQL_FIRST_DELTA, node: Node.INFERENCE, at: deps.now() });
          ledger.push({ stage: Stage.SQL_COMPLETE, node: Node.INFERENCE, at: deps.now() });
          send(reply(Kind.SQL, job.header, text(final), ledger.slice()));
          stats();
          return;
        }
        if (attempt === 2) {
          error(job.header, 'invalid_sql', `No valid SQL after one repair: ${reason}.`);
          stats();
          return;
        }
        messages.push({ role: 'assistant', content: raw }, { role: 'user', content: (job.context.edit ? editRepairMessage : repairMessage)(job.context.context, reason) });
      }
    } catch (cause) {
      if (!live()) {
        send(reply(Kind.INFER_STATS, job.header, json({ model, ...spent, cancelled: true })));
        return;
      }
      error(job.header, 'engine', cause instanceof Error ? cause.message : String(cause));
      if (spent.attempts > 0) stats();
    }
  }

  return { receive };
}
