import type { DatasetContext, Draft, InferenceAdapter, InferenceResult } from '../core/types';
import type { InferenceOptions } from './index';
import { abortError, assertNotAborted, MAX_PROMPT_CHARS, validateDraft, validateQueryPlan } from './plan';
import { readInferenceDiagnostics } from './diagnostics';
import { InferenceFailure, readFailureResponse } from './failure';

export const INFERENCE_SOCKET_PROTOCOL = 'time-blast.inference.v1';
const MAX_MESSAGE_BYTES = 65_536;
const MAX_PENDING = 2;
const encoder = new TextEncoder();
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

interface Session {
  socket: WebSocket;
  context: DatasetContext;
  ready: boolean;
  cachePolicy: boolean;
  promise: Promise<void>;
  finish(error?: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface Pending {
  draft: Draft;
  sent: boolean;
  resolve(result: InferenceResult): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** One persistent control connection; results still enter the local typed pipeline. */
export class RemoteSocketInferenceAdapter implements InferenceAdapter {
  readonly placement = 'remote' as const;
  readonly id = 'remote-inference-websocket';
  private context?: DatasetContext;
  private session?: Session;
  private disposed = false;
  private nextId = 0;
  private cacheEnabled: boolean;
  private readonly pending = new Map<string, Pending>();
  private latestDraft?: Draft;
  private draftTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: InferenceOptions) { this.cacheEnabled = options.cacheModelPlans !== false; }

  setPlanCacheEnabled(enabled: boolean): void {
    this.assertLive();
    if (this.cacheEnabled === enabled) return;
    this.cacheEnabled = enabled;
    const session = this.session;
    if (session?.ready) this.sendCachePolicy(session);
  }

  async prepare(context: DatasetContext): Promise<void> {
    this.assertLive();
    if (JSON.stringify(context) !== JSON.stringify(this.context)) {
      this.endSession(abortError());
      this.latestDraft = undefined;
      this.context = { ...context, vessels: [...context.vessels] };
    }
    await this.connection().promise;
  }

  observeDraft(draft: Draft): void {
    if (this.disposed || draft.contextId !== this.context?.id || !Number.isSafeInteger(draft.revision) || draft.revision < 0) return;
    this.latestDraft = { ...draft, text: draft.text.slice(0, MAX_PROMPT_CHARS + 1) };
    if (!this.draftTimer) this.draftTimer = setTimeout(() => { this.draftTimer = undefined; this.flushDraft(); }, 25);
  }

  async resolve(draft: Draft, signal: AbortSignal): Promise<InferenceResult> {
    this.assertLive(); assertNotAborted(signal);
    if (!this.context) throw new Error('Prepare a dataset before requesting inference.');
    validateDraft(draft, this.context);
    if (this.pending.size >= MAX_PENDING) throw new Error('Remote inference admission queue is full.');
    const session = this.connection(), id = `remote-${++this.nextId}`;
    return new Promise<InferenceResult>((resolve, reject) => {
      const cancel = (error: Error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id); pending.cleanup(); pending.reject(error);
        if (pending.sent && this.session === session && session.ready) {
          try { this.send(session, { type: 'CANCEL', id }); }
          catch (cause) { this.fail(session, cause); }
        }
      };
      const abort = () => cancel(abortError());
      const timer = setTimeout(() => cancel(new InferenceFailure(new Error('Remote inference timed out after 35 seconds.'), { source: 'remote' })), 35_000);
      this.pending.set(id, { draft: { ...draft }, sent: false, resolve, reject,
        cleanup: () => { clearTimeout(timer); signal.removeEventListener('abort', abort); } });
      signal.addEventListener('abort', abort, { once: true });
      if (session.ready) this.dispatch(session, id);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.endSession(abortError());
    this.context = undefined;
  }

  private assertLive(): void { if (this.disposed) throw new Error('Inference adapter has been disposed.'); }

  private connection(): Session {
    if (this.session) return this.session;
    const context = this.context;
    if (!context) throw new Error('Prepare a dataset before requesting inference.');
    const endpoint = new URL(this.options.endpoint ?? '', typeof location === 'undefined' ? 'http://localhost' : location.href);
    if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error('Inference socket endpoints must be WS(S) URLs without embedded credentials or fragments.');
    }
    const Socket = this.options.wsImpl ?? WebSocket;
    const socket = new Socket(endpoint.href, INFERENCE_SOCKET_PROTOCOL);
    let settle!: (error?: Error) => void;
    const promise = new Promise<void>((resolve, reject) => { settle = error => error ? reject(error) : resolve(); });
    // The connection can be reopened by resolve() after a network failure, without
    // adding a readiness-promise subscriber per canceled draft.
    void promise.catch(() => {});
    const session: Session = { socket, context, ready: false, cachePolicy: this.cacheEnabled, promise, finish: settle,
      timer: setTimeout(() => this.fail(session, new Error('Remote inference session handshake timed out.')), 10_000) };
    this.session = session;
    this.options.onStatus?.({ state: 'loading', label: 'Connecting remote inference' });
    socket.onopen = () => {
      if (this.session !== session) return;
      try {
        if (socket.protocol !== INFERENCE_SOCKET_PROTOCOL) throw new Error('The inference service did not negotiate the supported socket protocol.');
        session.cachePolicy = this.cacheEnabled;
        this.send(session, { type: 'HELLO', version: 1, context, cachePlans: session.cachePolicy });
      } catch (error) { this.fail(session, error); }
    };
    socket.onmessage = event => {
      if (this.session !== session) return;
      try { this.receive(session, event.data); }
      catch (error) { this.fail(session, error); }
    };
    socket.onerror = () => this.fail(session, new Error('Remote inference socket failed.'));
    socket.onclose = () => this.fail(session, new Error('Remote inference socket closed.'));
    return session;
  }

  private send(session: Session, message: unknown): void {
    const text = JSON.stringify(message), bytes = encoder.encode(text).byteLength;
    if (bytes > MAX_MESSAGE_BYTES) throw new Error('Remote inference message exceeds 64 KiB.');
    if (session.socket.readyState !== 1) throw new Error('Remote inference socket is not open.');
    if (session.socket.bufferedAmount + bytes > MAX_MESSAGE_BYTES) throw new Error('Remote inference socket send buffer is full.');
    session.socket.send(text);
  }

  private dispatch(session: Session, id: string): void {
    const pending = this.pending.get(id);
    if (!pending || pending.sent) return;
    try {
      this.send(session, { type: 'INFER', id, draft: pending.draft, cachePlans: this.cacheEnabled });
      pending.sent = true;
    } catch (error) { this.fail(session, error); }
  }

  private sendCachePolicy(session: Session): void {
    try {
      this.send(session, { type: 'CACHE_POLICY', cachePlans: this.cacheEnabled });
      session.cachePolicy = this.cacheEnabled;
    } catch (error) { this.fail(session, error); }
  }

  private flushDraft(): void {
    const session = this.session, draft = this.latestDraft;
    if (!session?.ready || !draft) return;
    // Drafts are disposable hints. Never grow a queue or delay a committed INFER.
    if (session.socket.bufferedAmount > 0) return;
    this.latestDraft = undefined;
    if (draft.text.length > MAX_PROMPT_CHARS) return;
    try { this.send(session, { type: 'DRAFT', draft }); }
    catch (error) { this.fail(session, error); }
  }

  private receive(session: Session, data: unknown): void {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE_BYTES || encoder.encode(data).byteLength > MAX_MESSAGE_BYTES) {
      throw new Error('Remote inference response must be JSON text within 64 KiB.');
    }
    const message = record(JSON.parse(data));
    if (!message || typeof message.type !== 'string') throw new Error('Invalid remote inference message.');
    if (message.type === 'READY') {
      if (session.ready || message.version !== 1) throw new Error('Invalid remote inference readiness response.');
      session.ready = true;
      if (session.cachePolicy !== this.cacheEnabled) this.sendCachePolicy(session);
      if (this.session !== session) return;
      this.flushDraft();
      for (const id of this.pending.keys()) this.dispatch(session, id);
      if (this.session !== session) return;
      clearTimeout(session.timer); session.finish();
      this.options.onStatus?.({ state: 'ready', label: 'Remote inference connected',
        detail: 'Session and dataset context ready; provider model warmup is independent.' });
      return;
    }
    if (message.type === 'ERROR' && message.id === undefined) {
      throw new InferenceFailure(new Error(typeof message.message === 'string' ? message.message : 'Remote inference session failed.'), {
        source: 'remote', model: typeof message.model === 'string' ? message.model : undefined,
        diagnostics: readInferenceDiagnostics(message.diagnostics), response: readFailureResponse(message.response) });
    }
    if (!session.ready || !['RESULT', 'ERROR'].includes(message.type) || typeof message.id !== 'string') throw new Error('Unexpected remote inference message.');
    const pending = this.pending.get(message.id);
    if (!pending) return; // Canceled and obsolete results cannot enter the pipeline.
    if (!pending.sent) throw new Error('Remote inference returned a result before its request.');
    this.pending.delete(message.id); pending.cleanup();
    const result = record(message.type === 'RESULT' ? message.result : message);
    const model = typeof result?.model === 'string' ? result.model.slice(0, 200) : undefined;
    const diagnostics = readInferenceDiagnostics(result?.diagnostics);
    try {
      if (message.type === 'ERROR') throw new Error(typeof message.message === 'string' ? message.message.slice(0, 2048) : 'Remote inference failed.');
      if (!result) throw new Error('Remote inference returned no result.');
      const plan = validateQueryPlan(result.plan, session.context);
      pending.resolve({ plan, source: 'remote', model, diagnostics,
        tokens: typeof result.tokens === 'number' && Number.isSafeInteger(result.tokens) && result.tokens >= 0 ? result.tokens : undefined });
    } catch (error) {
      pending.reject(new InferenceFailure(error, { source: 'remote', model, diagnostics, response: readFailureResponse(result?.response) }));
    }
  }

  private fail(session: Session, cause: unknown): void {
    if (this.session !== session) return;
    const error = cause instanceof InferenceFailure ? cause : new InferenceFailure(cause, { source: 'remote' });
    this.endSession(error);
    if (!this.disposed) this.options.onStatus?.({ state: 'error', label: 'Remote inference disconnected', detail: error.message });
  }

  private endSession(error: Error): void {
    const session = this.session;
    this.session = undefined;
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = undefined; this.latestDraft = undefined;
    if (session) {
      clearTimeout(session.timer); session.finish(error);
      session.socket.onopen = null; session.socket.onmessage = null; session.socket.onclose = null; session.socket.onerror = null;
      session.socket.close();
    }
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
  }
}
