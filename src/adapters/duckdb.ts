import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import contextJSON from '../../public/data/context.json';
import type { AdapterStatus, ColumnBatch, DatabaseAdapter, DatasetContext, QueryRequest } from '../core/types';
import { abortError, checkAbort, MAX_RESULT_BYTES, MAX_RESULT_ROWS, QueryGate, retainArrowBatch } from './arrow';
import { fetchEngineWasm } from './engine-asset';

export const SYNTHETIC_CONTEXT: DatasetContext = Object.freeze({
  ...contextJSON, vessels: Object.freeze([...contextJSON.vessels]) as unknown as string[],
});

/** Locally bundled engine assets. Each query owns a connection so late cancellation
 * cannot cancel a newer query. Streaming granularity is Arrow batches, not rows. */
export class DuckDBAdapter implements DatabaseAdapter {
  readonly id = 'duckdb-wasm';
  readonly placement = 'browser' as const;
  private engine?: duckdb.AsyncDuckDB;
  private worker?: Worker;
  private loading?: Promise<DatasetContext>;
  private disposed = false;
  private startupAbort = new AbortController();
  private gate = new QueryGate();
  private active?: { connection: duckdb.AsyncDuckDBConnection; cancel: () => Promise<void> };

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
    try {
      progress({ state: 'loading', label: 'Loading 120,960 synthetic readings', progress: 0.55 });
      const dataURL = new URL(`${import.meta.env.BASE_URL}data/telemetry.parquet`, location.href).href;
      await db.registerFileURL('telemetry.parquet', dataURL, duckdb.DuckDBDataProtocol.HTTP, false);
      await connection.query("CREATE TABLE telemetry AS SELECT * FROM 'telemetry.parquet'");
      await db.dropFile('telemetry.parquet');
      await connection.query("SET enable_external_access = false");
      await connection.query("SET memory_limit = '256MB'");
      await connection.query("SET lock_configuration = true");
    } finally { await connection.close(); }
    if (this.disposed) throw abortError();
    progress({ state: 'ready', label: 'DuckDB ready · 120,960 readings', progress: 1 });
    return SYNTHETIC_CONTEXT;
  }
  async *execute(request: QueryRequest): AsyncGenerator<ColumnBatch> {
    checkAbort(request.signal);
    const context = await this.prepare();
    if (request.context.id !== context.id) throw new Error('Dataset context changed; resolve the request again');
    const release = await this.gate.acquire(request.signal);
    let connection: duckdb.AsyncDuckDBConnection | undefined;
    let reader: Awaited<ReturnType<duckdb.AsyncDuckDBConnection['send']>> | undefined;
    let finished = false, stopped = false;
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
      reader = await connection.send(request.sql, true);
      if (!reader) throw new Error('DuckDB worker stopped before producing a result');
      let rows = 0, bytes = 0;
      for await (const record of reader) {
        checkAbort(request.signal);
        if (stopped || this.disposed) throw abortError();
        const batch = retainArrowBatch(record, context.vessels.length);
        rows += batch.length; bytes += batch.byteLength;
        if (rows > MAX_RESULT_ROWS || bytes > MAX_RESULT_BYTES) throw new Error('Query exceeded the result budget');
        if (batch.length) yield batch;
      }
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
