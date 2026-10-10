/**
 * The database node: DuckDB-Wasm's blocking (synchronous) API running in the engine worker.
 * Placement-independent logic over a minimal bindings interface, so the same code runs on
 * DuckDB's browser-blocking bundle (src/engine/database.ts) and node-blocking bundle (tests).
 *
 * Hot path per EXEC (docs/batch-1/engine.md has the measurements):
 *   guard (DuckDB tokenizer + subquery wrapper) → startPendingQuery(stream) → poll (each poll
 *   runs ≤ POLL_INTERVAL_MS, then we yield so CANCEL can arrive) → schema → fetch one Arrow
 *   message per call → decode in place → emit BATCH (a RecordBatch whose buffers are views
 *   into DuckDB's message copy) → yield every SLICE_MS of continuous work → DONE.
 *
 * Copies that remain: DuckDB-Wasm copies each Arrow message out of Wasm memory (required:
 * the next fetch reuses that memory); the SQL text is decoded from the EXEC payload. No
 * per-row objects, no concatenation.
 */
import type { RecordBatch, Schema } from 'apache-arrow';
import type { DatabaseNode, DatasetContext, DatasetSource, Emit } from './contracts';
import { Kind, Node, Stage, json, now, readText, type Frame, type Stamp } from '../protocol/frame';
import { IpcMessageDecoder } from './arrow-ipc';
import { guardSql, unwrapError, type Tokenizer } from './sql-guard';
import { DEFAULT_LIMITS, SLICE_MS, type QueryLimits } from './limits';
import { yieldToEventLoop } from './yield';
import {
  applyStatistics, loadFileSql, sampleSql, sniffFormat, statisticsSql, tableNameFor, UPLOAD_DIR,
  VESSELS_DESCRIPTION, VESSELS_SMALL_DESCRIPTION, VESSELS_SQL, type ColumnInfo,
} from './dataset';

/** The subset of DuckDB-Wasm's DuckDBBindings this node uses (browser and node bundles). */
export interface DuckBindings extends Tokenizer {
  connect(): { useUnsafe<R>(callback: (bindings: never, conn: number) => R): R; close(): void };
  startPendingQuery(conn: number, text: string, allowStreamResult?: boolean): Uint8Array | null;
  pollPendingQuery(conn: number): Uint8Array | null;
  cancelPendingQuery(conn: number): boolean;
  fetchQueryResults(conn: number): Uint8Array | null;
  registerFileBuffer(name: string, buffer: Uint8Array): void;
  dropFile(name: string): void;
}

/** Per-EXEC measurements, for tests and the browser smoke. Times are ms from EXEC receipt. */
export interface ExecStats {
  request: number;
  outcome: 'done' | 'canceled' | 'error';
  guardMs: number;
  schemaMs?: number;
  firstBatchMs?: number;
  doneMs?: number;
  polls: number;
  fetchRetries: number;
  yields: number;
  batches: number;
  rows: number;
  bytes: number;
}

export interface DatabaseNodeOptions {
  limits?: Partial<QueryLimits>;
  /** JS work between yields while streaming batches. */
  sliceMs?: number;
  /** Fetch a URL's bytes (fixtures and URL sources). */
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  /** URL of the `vessels-small` fixture. */
  fixtureUrl?: (name: string) => string;
  /** Measurement hook, called once per EXEC. */
  onExecStats?: (stats: ExecStats) => void;
  /** Measurement hook for dataset loads. */
  onOpenStats?: (stats: { loadMs: number; contextMs: number; statisticsMs: number }) => void;
}

interface Job {
  request: number; epoch: number; revision: number; context: number;
  sql: string; receivedAt: number; t0: number; canceled: boolean;
}

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url} failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

export class DuckDatabaseNode implements DatabaseNode {
  private readonly limits: QueryLimits;
  private readonly sliceMs: number;
  private readonly queryConn: number;
  private readonly loadConn: number;
  private readonly connections: Array<{ close(): void }>;
  private epoch = 0;
  private contextId = 0;
  private readonly queue: Job[] = [];
  private running?: Job;
  private pumping?: Promise<void>;
  private disposed = false;
  /** EXEC frames dropped for a stale epoch or another context. */
  dropped = 0;

  constructor(private readonly db: DuckBindings, private readonly emit: Emit, private readonly options: DatabaseNodeOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.sliceMs = options.sliceMs ?? SLICE_MS;
    const query = db.connect(), load = db.connect();
    this.connections = [query, load];
    this.queryConn = query.useUnsafe((_, conn) => conn);
    this.loadConn = load.useUnsafe((_, conn) => conn);
  }

  // ───────────────────────── frames ─────────────────────────

  handle(frame: Frame<Uint8Array>): void {
    if (this.disposed) return;
    if (frame.kind === Kind.EXEC) this.onExec(frame);
    else if (frame.kind === Kind.CANCEL) this.onCancel(frame.epoch, frame.request);
  }

  private onExec(frame: Frame<Uint8Array>): void {
    const receivedAt = now(), t0 = performance.now();
    if (frame.epoch < this.epoch || frame.context !== this.contextId || this.contextId === 0) { this.dropped++; return; }
    const job: Job = {
      request: frame.request, epoch: frame.epoch, revision: frame.revision, context: frame.context,
      sql: readText(frame.payload), receivedAt, t0, canceled: false,
    };
    if (this.queue.length >= this.limits.maxQueued) {
      this.fail(job, 'queue_full', `More than ${this.limits.maxQueued} queries are waiting`);
      return;
    }
    this.queue.push(job);
    this.pump();
  }

  /** protocol-v1 CANCEL: request 0 cancels everything and carries the new epoch (older-epoch
   * EXECs are dropped from then on); request ≠ 0 cancels only that request, epoch unchanged. */
  private onCancel(epoch: number, request: number): void {
    if (request === 0) {
      if (epoch > this.epoch) this.epoch = epoch;
      this.cancelAll();
      return;
    }
    const index = this.queue.findIndex(job => job.request === request);
    if (index >= 0) this.queue.splice(index, 1);
    if (this.running?.request === request) this.running.canceled = true;
  }

  private cancelAll(): void {
    this.queue.length = 0;
    if (this.running) this.running.canceled = true;
  }

  /** Starts executing synchronously: a small query may finish inside handle(). */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = (async () => {
      try {
        while (this.queue.length && !this.disposed) await this.execute(this.queue.shift()!);
      } finally {
        this.pumping = undefined;
      }
    })();
  }

  private stamp(stage: number, at = now()): Stamp { return { stage, node: Node.DATABASE, at }; }

  private send(job: Job, kind: number, payload: Uint8Array | Schema | RecordBatch, stamps: Stamp[]): void {
    this.emit({
      kind: kind as Frame['kind'], flags: 0, epoch: job.epoch, request: job.request, revision: job.revision,
      context: job.context, stamps, payload,
    } as Frame<Uint8Array>);
  }

  private fail(job: Job, code: string, message: string): void {
    this.send(job, Kind.ERROR, json({ code, message }), [this.stamp(Stage.EXEC_RECEIVED, job.receivedAt)]);
  }

  private async execute(job: Job): Promise<void> {
    const { db, queryConn: conn, limits } = this;
    const stats: ExecStats = { request: job.request, outcome: 'error', guardMs: 0, polls: 0, fetchRetries: 0, yields: 0, batches: 0, rows: 0, bytes: 0 };
    const deadline = job.t0 + limits.timeMs;
    let started = false, finished = false;
    this.running = job;
    const pause = async () => { stats.yields++; await yieldToEventLoop(); };
    try {
      if (job.canceled) { stats.outcome = 'canceled'; return; }
      const g0 = performance.now();
      const guard = guardSql(job.sql, db);
      stats.guardMs = performance.now() - g0;
      if (!guard.ok) { this.fail(job, 'sql_rejected', guard.message); return; }

      let header: Uint8Array | null;
      try {
        header = db.startPendingQuery(conn, guard.sql, true);
        started = true;
        while (header === null) {
          await pause();
          if (job.canceled || this.disposed) { stats.outcome = 'canceled'; return; }
          if (performance.now() > deadline) { this.fail(job, 'timeout', `Query exceeded ${limits.timeMs} ms`); return; }
          stats.polls++;
          header = db.pollPendingQuery(conn);
        }
      } catch (error) {
        this.fail(job, 'sql_error', unwrapError(messageOf(error)));
        return;
      }

      const decoder = new IpcMessageDecoder();
      const first = decoder.decode(header);
      if (first.kind !== 'schema') throw new Error('DuckDB result did not start with a schema');
      stats.schemaMs = performance.now() - job.t0;
      this.send(job, Kind.RESULT_SCHEMA, first.schema, [this.stamp(Stage.EXEC_RECEIVED, job.receivedAt)]);

      let sliceStart = performance.now();
      for (;;) {
        if (job.canceled || this.disposed) { stats.outcome = 'canceled'; return; }
        const chunk = db.fetchQueryResults(conn);
        if (chunk === null) {
          // DuckDB ran a polling interval without producing a chunk: let messages in.
          stats.fetchRetries++;
          await pause();
          sliceStart = performance.now();
          if (sliceStart > deadline) { this.fail(job, 'timeout', `Query exceeded ${limits.timeMs} ms`); return; }
          continue;
        }
        if (chunk.byteLength === 0) break;
        const decoded = decoder.decode(chunk);
        if (decoded.kind !== 'batch' || decoded.batch.numRows === 0) continue;
        stats.rows += decoded.batch.numRows;
        stats.bytes += chunk.byteLength;
        if (stats.rows > limits.maxRows || stats.bytes > limits.maxBytes) {
          this.fail(job, 'result_limit', `Result exceeds ${limits.maxRows} rows or ${limits.maxBytes} bytes`);
          return;
        }
        const stamps = stats.batches === 0 ? [this.stamp(Stage.DB_FIRST_BATCH)] : [];
        if (stats.batches === 0) stats.firstBatchMs = performance.now() - job.t0;
        stats.batches++;
        this.send(job, Kind.BATCH, decoded.batch, stamps);
        const t = performance.now();
        if (t > deadline) { this.fail(job, 'timeout', `Query exceeded ${limits.timeMs} ms`); return; }
        if (t - sliceStart >= this.sliceMs) { await pause(); sliceStart = performance.now(); }
      }
      finished = true;
      const done = new Uint8Array(16), view = new DataView(done.buffer);
      view.setBigUint64(0, BigInt(stats.rows), true);
      view.setBigUint64(8, BigInt(stats.bytes), true);
      stats.doneMs = performance.now() - job.t0;
      stats.outcome = 'done';
      this.send(job, Kind.DONE, done, [this.stamp(Stage.DB_DONE)]);
    } catch (error) {
      this.fail(job, 'sql_error', unwrapError(messageOf(error)));
    } finally {
      if (started && !finished) { try { db.cancelPendingQuery(conn); } catch { /* connection already idle */ } }
      if (this.running === job) this.running = undefined;
      this.options.onExecStats?.(stats);
    }
  }

  // ───────────────────────── datasets ─────────────────────────

  async open(source: DatasetSource, contextId: number): Promise<DatasetContext> {
    if (this.disposed) throw new Error('database node is disposed');
    // Work for the previous context is meaningless now: stop it and refuse new EXECs.
    this.contextId = 0;
    this.cancelAll();
    await this.pumping;
    this.status('loading', `Loading ${source.name}`, 0.1);
    const t0 = performance.now();
    try {
      await this.dropAll();
      let description: string;
      if (source.kind === 'fixture' && source.name === 'vessels') {
        await this.run(this.loadConn, VESSELS_SQL);
        description = VESSELS_DESCRIPTION;
      } else {
        const fetchBytes = this.options.fetchBytes ?? defaultFetchBytes;
        let fileName: string, bytes: Uint8Array;
        if (source.kind === 'fixture') {
          const url = this.options.fixtureUrl?.(source.name) ?? new URL('data/telemetry.parquet', globalThis.location?.href).href;
          fileName = 'telemetry.parquet'; bytes = await fetchBytes(url);
        } else if (source.kind === 'file') {
          fileName = source.file.name || source.name; bytes = new Uint8Array(await source.file.arrayBuffer());
        } else {
          fileName = new URL(source.url, globalThis.location?.href).pathname.split('/').pop() || source.name;
          bytes = await fetchBytes(source.url);
        }
        const format = sniffFormat(fileName, bytes);
        const table = tableNameFor(fileName);
        const path = `${UPLOAD_DIR}${table}.${format}`;
        this.db.registerFileBuffer(path, bytes); // copies into Wasm memory; `bytes` can be collected
        try {
          await this.run(this.loadConn, loadFileSql(table, path, format));
        } finally {
          this.db.dropFile(path);
        }
        description = source.kind === 'fixture' ? VESSELS_SMALL_DESCRIPTION : `${format === 'parquet' ? 'Parquet' : 'CSV'} file ${fileName}`;
      }
      const t1 = performance.now();
      this.status('loading', 'Computing statistics', 0.8);
      const { context, statisticsMs } = await this.describe(contextId, source.name, description);
      const t2 = performance.now();
      this.options.onOpenStats?.({ loadMs: t1 - t0, contextMs: t2 - t1, statisticsMs });
      this.contextId = contextId;
      this.status('ready', `${source.name} · ${context.tables.map(t => `${t.rows.toLocaleString('en-US')} rows`).join(', ')}`, 1);
      return context;
    } catch (error) {
      this.status('error', `Could not load ${source.name}`, undefined, messageOf(error));
      throw error;
    }
  }

  private status(state: 'loading' | 'ready' | 'error', label: string, progress?: number, detail?: string): void {
    this.emit({
      kind: Kind.STATUS, flags: 0, epoch: 0, request: 0, revision: 0, context: 0, stamps: [],
      payload: json({ component: 'database', state, label, ...(detail ? { detail } : {}), ...(progress !== undefined ? { progress } : {}) }),
    });
  }

  private async dropAll(): Promise<void> {
    const rows = await this.rows(this.loadConn,
      "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'main' AND table_catalog = current_database()");
    for (const [name, type] of rows as Array<[string, string]>) {
      await this.run(this.loadConn, `DROP ${type === 'VIEW' ? 'VIEW' : 'TABLE'} IF EXISTS "${name.replaceAll('"', '""')}"`);
    }
  }

  private async describe(id: number, name: string, description: string): Promise<{ context: DatasetContext; statisticsMs: number }> {
    const columns = await this.rows(this.loadConn,
      "SELECT table_name, column_name, data_type FROM duckdb_columns() WHERE schema_name = 'main' AND database_name = current_database() ORDER BY table_name, column_index");
    const byTable = new Map<string, ColumnInfo[]>();
    for (const [table, column, type] of columns as Array<[string, string, string]>) {
      if (!byTable.has(table)) byTable.set(table, []);
      byTable.get(table)!.push({ name: column, type });
    }
    const tables: DatasetContext['tables'] = [];
    let statisticsMs = 0;
    for (const [table, info] of byTable) {
      const s0 = performance.now();
      const [values] = await this.rows(this.loadConn, statisticsSql(table, info));
      statisticsMs += performance.now() - s0;
      const { rows, columns: described } = applyStatistics(info, values);
      const sample = await this.rows(this.loadConn, sampleSql(table, info, 3));
      tables.push({ name: table, rows, columns: described, sample });
    }
    return { context: { id, name, dialect: 'duckdb', description, tables }, statisticsMs };
  }

  /** Run SQL to completion on a connection, yielding between polls; returns its batches. */
  private async run(conn: number, sql: string): Promise<RecordBatch[]> {
    let header = this.db.startPendingQuery(conn, sql, false);
    while (header === null) {
      await yieldToEventLoop();
      if (this.disposed) throw new Error('database node is disposed');
      header = this.db.pollPendingQuery(conn);
    }
    const decoder = new IpcMessageDecoder();
    decoder.decode(header);
    const batches: RecordBatch[] = [];
    for (;;) {
      const chunk = this.db.fetchQueryResults(conn);
      if (chunk === null) { await yieldToEventLoop(); continue; }
      if (chunk.byteLength === 0) break;
      const decoded = decoder.decode(chunk);
      if (decoded.kind === 'batch') batches.push(decoded.batch);
    }
    return batches;
  }

  /** Cold path only: rows as plain JSON-friendly arrays. */
  private async rows(conn: number, sql: string): Promise<unknown[][]> {
    const out: unknown[][] = [];
    for (const batch of await this.run(conn, sql)) {
      const columns = batch.schema.fields.map((_, i) => batch.getChildAt(i)!);
      for (let row = 0; row < batch.numRows; row++) out.push(columns.map(column => plain(column.get(row))));
    }
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll();
    for (const connection of this.connections) { try { connection.close(); } catch { /* ignore */ } }
  }
}

function plain(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value && typeof value === 'object' && Symbol.iterator in value && typeof (value as { toArray?: unknown }).toArray === 'function') {
    return Array.from(value as Iterable<unknown>, plain);
  }
  return value ?? null;
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Boot-time configuration. After this, model SQL cannot read files or URLs (only registered
 * uploads under UPLOAD_DIR, which are dropped once materialized), load extensions, or change
 * settings. Parquet support is an extension DuckDB-Wasm fetches from extensions.duckdb.org,
 * so it must be loaded before external access is disabled. */
export async function lockDown(db: DuckBindings, { parquet = true, memoryLimit = '512MB' } = {}): Promise<{ parquet: boolean; parquetMs: number; error?: string }> {
  const connection = db.connect();
  const conn = connection.useUnsafe((_, id) => id);
  const exec = (sql: string) => {
    let header = db.startPendingQuery(conn, sql, false);
    while (header === null) header = db.pollPendingQuery(conn);
    while (true) { const chunk = db.fetchQueryResults(conn); if (chunk && chunk.byteLength === 0) break; }
  };
  try {
    exec(`SET memory_limit = '${memoryLimit}'`);
    let loaded = false, error: string | undefined;
    const t0 = performance.now();
    if (parquet) {
      try { exec('LOAD parquet'); loaded = true; } catch (e) { error = messageOf(e); }
    }
    const parquetMs = performance.now() - t0;
    exec('SET autoinstall_known_extensions = false');
    exec('SET autoload_known_extensions = false');
    exec(`SET allowed_directories = ['${UPLOAD_DIR}']`);
    exec('SET enable_external_access = false');
    exec('SET lock_configuration = true');
    return { parquet: loaded, parquetMs, ...(error ? { error } : {}) };
  } finally {
    connection.close();
  }
}

