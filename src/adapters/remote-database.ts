import { RecordBatchReader } from 'apache-arrow';
import type { AdapterStatus, ColumnBatch, DatabaseAdapter, DatasetContext, QueryRequest } from '../core/types';
import { abortError, checkAbort, MAX_RESULT_BYTES, MAX_RESULT_ROWS, QueryGate, retainArrowBatch } from './arrow';

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
      for await (const record of reader) {
        checkAbort(signal);
        const batch = retainArrowBatch(record, context.vessels.length);
        rows += batch.length; bytes += batch.byteLength;
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

/** Only 8 trailing control bytes are copied. All data chunks pass through unchanged. */
export class VerifiedArrowSource implements AsyncIterableIterator<Uint8Array> {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private tail = new Uint8Array(8);
  private bytes = 0;
  private ended = false;
  constructor(stream: ReadableStream<Uint8Array>, private signal: AbortSignal, private limit = MAX_RESULT_BYTES) {
    this.reader = stream.getReader();
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> { return this; }
  async next(): Promise<IteratorResult<Uint8Array>> {
    checkAbort(this.signal);
    if (this.ended) return { done: true, value: undefined };
    const result = await this.reader.read();
    checkAbort(this.signal);
    if (result.done) {
      this.ended = true;
      if (this.bytes < 8 || !this.tail.every((byte, i) => byte === (i < 4 ? 255 : 0))) {
        throw new Error('Database stream ended without a verified success terminator');
      }
      return { done: true, value: undefined };
    }
    const chunk = result.value;
    this.bytes += chunk.byteLength;
    if (this.bytes > this.limit) throw new Error('Database stream exceeded the encoded byte budget');
    if (chunk.byteLength >= 8) this.tail.set(chunk.subarray(chunk.byteLength - 8));
    else if (chunk.byteLength) {
      this.tail.copyWithin(0, chunk.byteLength);
      this.tail.set(chunk, 8 - chunk.byteLength);
    }
    return { done: false, value: chunk };
  }
  async finish(): Promise<void> { while (!this.ended) await this.next(); }
  async cancel(): Promise<void> { await this.reader.cancel().catch(() => {}); this.reader.releaseLock(); }
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
