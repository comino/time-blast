import { Message, RecordBatchReader } from 'apache-arrow';
import type { AdapterStatus, ColumnBatch, DatabaseAdapter, DatasetContext, QueryRequest } from '../core/types';
import { abortError, accountRetainedBytes, checkAbort, MAX_RESULT_BYTES, MAX_RESULT_ROWS, QueryGate, retainArrowBatch, validateArrowSchema } from './arrow';

const COMPLETION_HEADER = 'x-time-blast-completion';
const COMPLETION_CONTRACT = 'arrow-eos-v1';

/** Remote bridge contract (not a raw ClickHouse endpoint):
 * GET /context -> immutable DatasetContext JSON.
 * POST /query -> {id, sql, plan, context_id, priority}; response is uncompressed
 * application/vnd.apache.arrow.stream with X-Time-Blast-Completion: arrow-eos-v1.
 * The bridge MUST withhold the final 8-byte Arrow EOS until source query success,
 * abort/truncate without EOS on any late failure, and close cleanly after EOS.
 * CORS deployments must expose that header. HTTP 200/header alone is NOT success.
 * Request abort is cancellation; the bridge must propagate it to its database.
 * Auth may use same-origin session cookies; no database secrets live here.
 */
export class RemoteDatabaseAdapter implements DatabaseAdapter {
  readonly id = 'remote-arrow';
  readonly placement = 'remote' as const;
  private base: string;
  private gate = new QueryGate();
  private context?: DatasetContext;
  private loading?: Promise<DatasetContext>;
  private lifetime = new AbortController();

  constructor(endpoint: string) {
    if (!endpoint.trim()) throw new Error('Configure a remote database bridge URL first');
    const url = new URL(endpoint, typeof location === 'undefined' ? 'http://localhost/' : location.href);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Database bridge must be an HTTP(S) base URL without credentials, query, or fragment');
    }
    this.base = url.href.replace(/\/$/, '');
  }

  prepare(progress: (status: AdapterStatus) => void = () => {}): Promise<DatasetContext> {
    checkAbort(this.lifetime.signal);
    return this.loading ??= (async () => {
      progress({ state: 'loading', label: 'Connecting to database bridge' });
      const response = await fetch(`${this.base}/context`, { signal: this.lifetime.signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Database context request failed (${response.status})`);
      // Context is bounded control metadata, not a result payload.
      const text = await boundedText(response, 64 * 1024);
      const data: unknown = JSON.parse(text);
      this.context = parseDatasetContext(data);
      progress({ state: 'ready', label: 'Remote database ready', progress: 1 });
      return this.context;
    })().catch(error => {
      this.loading = undefined;
      progress({ state: 'error', label: 'Remote database unavailable', detail: String(error) });
      throw error;
    });
  }

  async *execute(request: QueryRequest): AsyncGenerator<ColumnBatch> {
    const signal = AbortSignal.any([request.signal, this.lifetime.signal]);
    checkAbort(signal);
    const context = await this.prepare();
    if (context.id !== request.context.id) throw new Error('Remote dataset context changed');
    const release = await this.gate.acquire(signal);
    let source: VerifiedArrowSource | undefined;
    let reader: Awaited<ReturnType<typeof RecordBatchReader.from>> | undefined;
    try {
      checkAbort(signal);
      const response = await fetch(`${this.base}/query`, {
        method: 'POST', signal, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/vnd.apache.arrow.stream' },
        body: JSON.stringify({ id: request.id, sql: request.sql, plan: request.plan, context_id: context.id, priority: request.priority }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Database query failed (${response.status})`); }
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/vnd.apache.arrow.stream')) {
        await response.body?.cancel(); throw new Error('Database bridge must return an Arrow IPC stream');
      }
      if (response.headers.get(COMPLETION_HEADER) !== COMPLETION_CONTRACT || !response.body) {
        await response.body?.cancel(); throw new Error('Database bridge lacks the required arrow-eos-v1 completion contract');
      }
      source = new VerifiedArrowSource(response.body, signal);
      reader = await RecordBatchReader.from(source);
      let rows = 0, bytes = 0;
      const retained = new WeakSet<ArrayBufferLike>();
      for await (const record of reader) {
        checkAbort(signal);
        const batch = retainArrowBatch(record, context.vessels.length);
        rows += batch.length; bytes += accountRetainedBytes(batch, retained);
        if (rows > MAX_RESULT_ROWS || bytes > MAX_RESULT_BYTES) throw new Error('Query exceeded the result budget');
        if (batch.length) yield batch;
      }
      // Arrow can end before fetch does. Require clean transport completion too.
      await source.finish();
      checkAbort(signal);
    } catch (error) {
      if (signal.aborted) throw abortError();
      throw error;
    } finally {
      await reader?.cancel().catch(() => {});
      await source?.cancel();
      release();
    }
  }

  async dispose(): Promise<void> { this.lifetime.abort(); }
}

/** Validate message boundaries, not a byte pattern that can also occur inside a body.
 * Body buffers pass through untouched. Only fragmented, bounded metadata is assembled. */
class ArrowStreamFraming {
  private state: 'prefix' | 'metadata' | 'body' | 'done' = 'prefix';
  private prefix = new Uint8Array(8);
  private prefixBytes = 0;
  private prefixLength = 4;
  private metadataLength = 0;
  private metadata?: Uint8Array;
  private metadataBytes = 0;
  private bodyBytes = 0;
  private schemaSeen = false;
  private rows = 0;

  push(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.state === 'done') throw new Error('Database stream has trailing bytes after its success terminator');
      if (this.state === 'body') {
        const take = Math.min(this.bodyBytes, chunk.byteLength - offset);
        this.bodyBytes -= take; offset += take;
        if (!this.bodyBytes) this.state = 'prefix';
      } else if (this.state === 'prefix') {
        const take = Math.min(this.prefixLength - this.prefixBytes, chunk.byteLength - offset);
        this.prefix.set(chunk.subarray(offset, offset + take), this.prefixBytes);
        offset += take; this.prefixBytes += take;
        if (this.prefixBytes !== this.prefixLength) continue;
        const header = new DataView(this.prefix.buffer);
        if (this.prefixLength === 4 && header.getInt32(0, true) === -1) {
          this.prefixLength = 8; continue;
        }
        const length = header.getInt32(this.prefixLength - 4, true);
        const explicitEOS = this.prefixLength === 8 && length === 0;
        this.prefixBytes = 0; this.prefixLength = 4;
        if (explicitEOS) {
          if (!this.schemaSeen) throw new Error('Database stream success terminator preceded its schema');
          this.state = 'done'; continue;
        }
        // The primitive five-column contract needs only small control messages.
        if (length <= 0 || length > 64 * 1024) throw new Error('Database stream has an invalid Arrow metadata length');
        this.metadataLength = length; this.metadataBytes = 0; this.state = 'metadata';
      } else {
        const take = Math.min(this.metadataLength - this.metadataBytes, chunk.byteLength - offset);
        if (!this.metadataBytes && take === this.metadataLength) {
          this.readMetadata(chunk.subarray(offset, offset + take));
        } else {
          this.metadata ??= new Uint8Array(this.metadataLength);
          this.metadata.set(chunk.subarray(offset, offset + take), this.metadataBytes);
          this.metadataBytes += take;
          if (this.metadataBytes === this.metadataLength) {
            this.readMetadata(this.metadata); this.metadata = undefined;
          }
        }
        offset += take;
      }
    }
  }

  private readMetadata(bytes: Uint8Array): void {
    const message = Message.decode(bytes);
    if (!Number.isSafeInteger(message.bodyLength) || message.bodyLength < 0 || message.bodyLength > MAX_RESULT_BYTES) {
      throw new Error('Database stream has an invalid Arrow body length');
    }
    if (message.isSchema()) {
      if (this.schemaSeen || message.bodyLength !== 0) throw new Error('Database stream must contain exactly one Arrow schema');
      validateArrowSchema(message.header());
      this.schemaSeen = true;
    } else if (message.isRecordBatch() && this.schemaSeen) {
      const length = message.header().length;
      if (!Number.isSafeInteger(length) || length < 0 || (this.rows += length) > MAX_RESULT_ROWS) {
        throw new Error('Query exceeded the result row budget');
      }
    } else throw new Error('Database stream contains an unsupported Arrow message');
    this.bodyBytes = message.bodyLength;
    this.state = this.bodyBytes ? 'body' : 'prefix';
  }

  finish(): void {
    if (this.state !== 'done') throw new Error('Database stream ended without a verified success terminator');
  }
}

/** Strict single-stream framing and clean HTTP completion; result chunks are not copied. */
export class VerifiedArrowSource implements AsyncIterableIterator<Uint8Array> {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private framing = new ArrowStreamFraming();
  private bytes = 0;
  private ended = false;
  private canceled = false;
  private failure?: unknown;
  private readonly onAbort = () => { void this.reader.cancel(this.signal.reason).catch(() => {}); };
  constructor(stream: ReadableStream<Uint8Array>, private signal: AbortSignal, private limit = MAX_RESULT_BYTES) {
    checkAbort(signal);
    this.reader = stream.getReader();
    signal.addEventListener('abort', this.onAbort, { once: true });
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> { return this; }
  async next(): Promise<IteratorResult<Uint8Array>> {
    // Arrow's async iterable adapter can swallow source errors. Preserve failures
    // so finish() cannot turn a rejected chunk into a successful completion.
    if (this.failure) throw this.failure;
    try {
      checkAbort(this.signal);
      if (this.ended) return { done: true, value: undefined };
      const result = await this.reader.read();
      checkAbort(this.signal);
      if (result.done) {
        this.framing.finish(); this.ended = true;
        return { done: true, value: undefined };
      }
      const chunk = result.value;
      this.bytes += chunk.byteLength;
      if (this.bytes > this.limit) throw new Error('Database stream exceeded the encoded byte budget');
      this.framing.push(chunk);
      return { done: false, value: chunk };
    } catch (error) { this.failure = error; throw error; }
  }
  async finish(): Promise<void> {
    if (this.failure) throw this.failure;
    while (!this.ended) await this.next();
  }
  async cancel(): Promise<void> {
    if (this.canceled) return;
    this.canceled = true; this.signal.removeEventListener('abort', this.onAbort);
    await this.reader.cancel().catch(() => {}); this.reader.releaseLock();
  }
}

export function parseDatasetContext(value: unknown): DatasetContext {
  if (!value || typeof value !== 'object') throw new Error('Invalid database context');
  const c = value as DatasetContext;
  if (typeof c.id !== 'string' || !c.id || c.id.length > 256 || typeof c.label !== 'string' || typeof c.description !== 'string' ||
    !Number.isSafeInteger(c.start) || !Number.isSafeInteger(c.end) || c.start >= c.end ||
    !Number.isSafeInteger(c.rowCount) || c.rowCount < 0 || !Array.isArray(c.vessels) || !c.vessels.length || c.vessels.length > 128 ||
    !c.vessels.every(name => typeof name === 'string' && name.length > 0 && name.length <= 128)) {
    throw new Error('Invalid database context');
  }
  return Object.freeze({ id: c.id, label: c.label, description: c.description, start: c.start, end: c.end,
    rowCount: c.rowCount, vessels: Object.freeze([...c.vessels]) as unknown as string[] });
}

async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new Error('Empty database context');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('Database context exceeded its size limit');
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
