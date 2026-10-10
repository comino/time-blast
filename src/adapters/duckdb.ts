import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import type { AdapterStatus, ColumnBatch, DatabaseAdapter, DatasetContext, DatasetProfile, QueryRequest } from '../core/types';
import { abortError, accountRetainedBytes, checkAbort, MAX_RESULT_BYTES, MAX_RESULT_ROWS, QueryGate, retainArrowBatch } from './arrow';
import { fetchEngineWasm } from './engine-asset';
import { LARGE_DATASET_SQL, SYNTHETIC_CONTEXTS } from './synthetic-data';

export const SYNTHETIC_CONTEXT = SYNTHETIC_CONTEXTS.demo;

/** Locally bundled engine assets. Each query owns a connection so late cancellation
 * cannot cancel a newer query. Streaming granularity is Arrow batches, not rows. */
export class DuckDBAdapter implements DatabaseAdapter {
  readonly id = 'duckdb-wasm';
  readonly placement = 'browser' as const;
  readonly supportsFirstBucket = true as const;
  private engine?: duckdb.AsyncDuckDB;
  private worker?: Worker;
  private loading?: Promise<DatasetContext>;
  private disposed = false;
  private startupAbort = new AbortController();
  private gate = new QueryGate();
  private active?: { connection: duckdb.AsyncDuckDBConnection; cancel: () => Promise<void> };

  constructor(private readonly profile: DatasetProfile = 'large') {
    if (profile !== 'demo' && profile !== 'large') throw new Error('Unknown browser dataset profile');
  }

  prepare(onProgress: (status: AdapterStatus) => void = () => {}): Promise<DatasetContext> {
    if (this.disposed) return Promise.reject(new Error('Database adapter is disposed'));
    return this.loading ??= this.load(onProgress).catch(async error => {
      onProgress({ state: 'error', label: 'DuckDB could not start', detail: String(error) });
      await this.engine?.terminate().catch(() => {});
      this.worker?.terminate();
      this.engine = undefined; this.worker = undefined; this.loading = undefined;
      throw error;
    });
  }
  private async load(progress: (status: AdapterStatus) => void): Promise<DatasetContext> {
    progress({ state: 'loading', label: 'Starting embedded DuckDB', progress: 0.1 });
    const bundle = await duckdb.selectBundle({
      mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
      eh: { mainModule: ehWasm, mainWorker: ehWorker },
    });
    if (this.disposed) throw abortError();
    this.worker = new Worker(bundle.mainWorker!);
    const db = this.engine = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), this.worker);
    let engineURL = bundle.mainModule;
    let objectURL: string | undefined;
    try {
      if (import.meta.env.PROD) {
        const wasm = await fetchEngineWasm(`${engineURL}.gz`, { signal: this.startupAbort.signal });
        if (this.disposed) throw abortError();
        engineURL = objectURL = URL.createObjectURL(wasm);
      }
      await db.instantiate(engineURL);
    } finally {
      if (objectURL) URL.revokeObjectURL(objectURL);
    }
    const connection = await db.connect();
    const context = SYNTHETIC_CONTEXTS[this.profile];
    try {
      // Bound materialization too, rather than imposing the limit only after loading.
      await connection.query("SET memory_limit = '256MB'");
      progress({ state: 'loading', label: `${this.profile === 'large' ? 'Generating' : 'Loading'} ${context.rowCount.toLocaleString()} synthetic readings`, progress: 0.55 });
      if (this.profile === 'large') {
        await connection.query(LARGE_DATASET_SQL);
      } else {
        const dataURL = new URL(`${import.meta.env.BASE_URL}data/telemetry.parquet`, location.href).href;
        await db.registerFileURL('telemetry.parquet', dataURL, duckdb.DuckDBDataProtocol.HTTP, false);
        await connection.query("CREATE TABLE telemetry AS SELECT * FROM 'telemetry.parquet'");
        await db.dropFile('telemetry.parquet');
      }
      await connection.query("SET enable_external_access = false");
      await connection.query("SET lock_configuration = true");
    } finally { await connection.close(); }
    if (this.disposed) throw abortError();
    progress({ state: 'ready', label: `DuckDB ready · ${context.rowCount.toLocaleString()} readings`, progress: 1 });
    return context;
  }
  async *execute(request: QueryRequest): AsyncGenerator<ColumnBatch> {
    checkAbort(request.signal);
    const context = await this.prepare();
    if (request.context.id !== context.id) throw new Error('Dataset context changed; resolve the request again');
    const firstBucket = request.firstBucket;
    if (firstBucket && (firstBucket.kind !== 'first-complete-bucket' || firstBucket.sql !== request.sql
      || firstBucket.contextId !== context.id || firstBucket.start !== context.start || firstBucket.end !== context.end
      || request.context.start !== context.start || request.context.end !== context.end || request.context.rowCount !== context.rowCount
      || request.context.vessels.length !== context.vessels.length || request.context.vessels.some((name, i) => name !== context.vessels[i]))) {
      throw new Error('First-bucket execution does not match the owned dataset and logical query');
    }
    // This private engine owns only the bundled telemetry table. Physical SQL is
    // produced by the bounded Rust compiler; remote execution never uses it.
    const statements = firstBucket ? [firstBucket.firstSql, firstBucket.remainderSql] : [request.sql];
    const release = await this.gate.acquire(request.signal);
    let connection: duckdb.AsyncDuckDBConnection | undefined;
    let reader: Awaited<ReturnType<duckdb.AsyncDuckDBConnection['send']>> | undefined;
    let finished = false, stopped = false, transaction = false;
    let canceling: Promise<void> | undefined;
    const cancel = (): Promise<void> => {
      stopped = true;
      if (connection && !canceling) canceling = connection.cancelSent().then(() => {}, () => {});
      return canceling ?? Promise.resolve();
    };
    const onAbort = () => { void cancel(); };
    try {
      checkAbort(request.signal);
      if (this.disposed || !this.engine) throw abortError();
      connection = await this.engine.connect();
      checkAbort(request.signal);
      this.active = { connection, cancel };
      request.signal.addEventListener('abort', onAbort, { once: true });
      if (firstBucket) {
        // One stable read-only snapshot spans both complete-group statements.
        // The baseline retains its existing single-statement transaction.
        await connection.query('BEGIN TRANSACTION READ ONLY');
        transaction = true;
      }
      let rows = 0, bytes = 0;
      const retained = new WeakSet<ArrayBufferLike>();
      for (const sql of statements) {
        checkAbort(request.signal);
        if (stopped || this.disposed) throw abortError();
        reader = await connection.send(sql, true);
        if (!reader) throw new Error('DuckDB worker stopped before producing a result');
        for await (const record of reader) {
          checkAbort(request.signal);
          if (stopped || this.disposed) throw abortError();
          const batch = retainArrowBatch(record, context.vessels.length);
          rows += batch.length; bytes += accountRetainedBytes(batch, retained);
          if (rows > MAX_RESULT_ROWS || bytes > MAX_RESULT_BYTES) throw new Error('Query exceeded the result budget');
          if (batch.length) yield batch;
        }
        await reader.cancel().catch(() => {});
        reader = undefined;
      }
      checkAbort(request.signal);
      if (stopped || this.disposed) throw abortError();
      if (transaction) { await connection.query('COMMIT'); transaction = false; }
      checkAbort(request.signal);
      if (stopped || this.disposed) throw abortError();
      finished = true;
    } catch (error) {
      if (request.signal.aborted || stopped || this.disposed) throw abortError();
      throw error;
    } finally {
      request.signal.removeEventListener('abort', onAbort);
      if (!finished) await cancel();
      await canceling;
      await reader?.cancel().catch(() => {});
      if (transaction) await connection?.query('ROLLBACK').catch(() => {});
      await connection?.close().catch(() => {});
      if (this.active?.connection === connection) this.active = undefined;
      release();
    }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.startupAbort.abort();
    await this.active?.cancel();
    await this.engine?.terminate().catch(() => {});
    this.worker?.terminate();
    this.engine = undefined; this.worker = undefined;
  }
}
