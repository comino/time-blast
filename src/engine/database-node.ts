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
import { Flag, Kind, Node, Stage, json, now, readText, type Frame, type Stamp } from '../protocol/frame';
import { IpcMessageDecoder } from './arrow-ipc';
import { guardSql, unwrapError, wrapStatement, type Tokenizer } from './sql-guard';
import { cacheKey, DEFAULT_RESULT_CACHE, NON_DETERMINISTIC, ResultCache, type CachedResult, type ResultCacheOptions } from './result-cache';
import {
  AGG_TEMPLATE_SQL, buildSql, finishSql, GRAINS, mayRewrite, nullCheckSql, planRewrite, printJobs, ROLLUP_SCHEMA, rollupSpecs,
  rollupTableName, type Catalog, type Grain, type RollupSpec, type RollupTable,
} from './rollup';
import { DEFAULT_LIMITS, SLICE_MS, type QueryLimits } from './limits';
import { yieldToEventLoop } from './yield';
import { bootClock, bootMark } from './boot-trace';
import { META_TABLE, PREBUILT_FORMAT, type ManifestEntry, type ManifestTable, type PrebuiltMeta } from './datasets';
import {
  applyStatistics, classify, loadFileSql, quoteIdent, quoteLiteral, sampleSql, sniffFormat, statisticsSql, tableNameFor, UPLOAD_DIR,
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
  /** Browser bundles: register a File/Blob DuckDB reads on demand (protocol 2 = FileReaderSync). */
  registerFileHandle?(name: string, handle: Blob, protocol: number, directIO: boolean): void;
  dropFile(name: string): void;
}

/** Per-EXEC measurements, for tests and the browser smoke. Times are ms from EXEC receipt. */
export interface ExecStats {
  request: number;
  outcome: 'done' | 'canceled' | 'error';
  /** A WARM EXEC (result-cache warm-up; nothing streamed). */
  warm?: boolean;
  /** Where the result came from: DuckDB on the raw table, DuckDB on a rollup, or the result cache. */
  source: 'raw' | 'rollup' | 'cache';
  guardMs: number;
  /** Rewrite decision (parse + plan + print, or a memo hit), when rollups exist. */
  rewriteMs?: number;
  /** Why the statement was not rewritten (when rollups exist). */
  rewrite?: string;
  /** Rollup grain used. */
  grain?: string;
  /** The rewritten statement failed to start and the raw statement ran instead. */
  fallback?: string;
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
  /** Background rollups + exact rewrite onto them (src/engine/rollup.ts). Default on. */
  rollups?: boolean;
  /** Exact result reuse (src/engine/result-cache.ts). Default on; `false` disables. */
  resultCache?: Partial<ResultCacheOptions> | false;
  /** Load tables into a compressed in-memory catalog (`ATTACH ':memory:' (COMPRESS)`). Default on. */
  compressed?: boolean;
  /** Measurement hook, called after each rollup grain is built (and once with `done`). */
  onRollupStats?: (stats: RollupStats) => void;
  /** Bounded queries estimated to touch fewer raw rows run on the raw table (rollup.ts SHORT_RANGE_ROWS). */
  rollupShortRangeRows?: number;
  /** Dataset manifest (public/data/datasets.json). Fixtures it lists open from it; others use the built-ins. */
  manifest?: () => Promise<ManifestEntry[]>;
  /** Resolve a manifest path (e.g. `data/vessels/vessels.duckdb`) to a URL. */
  dataUrl?: (path: string) => string;
  /** Fetch a prebuilt database file (browser: persisted in the Cache API). Default: fetchBytes. */
  fetchPrebuilt?: (url: string) => Promise<Uint8Array | Blob>;
  /** Use prebuilt databases (default true; false loads the manifest's tables and builds rollups here). */
  prebuilt?: boolean;
  /** Extensions loaded at boot (lockDown), to check a prebuilt function catalog applies. */
  extensions?: string[];
  /** Deferred boot lockdown (src/engine/database.ts): runs right after the first open, so the
   * dataset context is out before the json extension loads. No EXEC runs before it completes. */
  lockdown?: () => Promise<void>;
  /** Warm-up statements after the deferred lockdown (default on). */
  warmUp?: boolean;
  /** The bindings were created for this node alone (nothing loaded yet): the first open can skip
   * dropping tables. Leave unset when nodes share bindings (tests). */
  freshInstance?: boolean;
}

export interface RollupStats {
  table: string;
  grain?: string;
  rows?: number;
  ms: number;
  done?: boolean;
  /** Rollups were not built for this table (or the build failed), and why. */
  skipped?: string;
}

/** The compressed in-memory catalog every connection of the node uses. */
export const DATA_CATALOG = 'tb_data';
/** An attached prebuilt database (read-only) while a prebuilt fixture is open. */
export const FIXTURE_CATALOG = 'tb_fixture';
/** Prebuilt metadata: one row, column `meta` (JSON text, src/engine/datasets.ts PrebuiltMeta). */
export const META_SQL_NAME = `${quoteIdent(ROLLUP_SCHEMA)}.${quoteIdent(META_TABLE)}`;
export const CATALOG_SQL = 'SELECT DISTINCT lower(function_name), function_type, stability FROM duckdb_functions()';

/** Function catalog for the rollup rewrite and the result cache, from CATALOG_SQL rows. */
export function catalogFrom(functions: Array<[string, string, string | null]>): { aggregates: string[]; forbidden: string[]; volatile: string[] } {
  const aggregates = new Set<string>(), forbidden = new Set<string>(), volatile = new Set<string>();
  for (const [name, type, stability] of functions) {
    if (type === 'aggregate') aggregates.add(name);
    else if (type === 'macro' || type === 'table_macro' || stability === 'VOLATILE') forbidden.add(name);
    if (stability === 'VOLATILE' || stability === 'CONSISTENT_WITHIN_QUERY') volatile.add(name);
  }
  return { aggregates: [...aggregates].sort(), forbidden: [...forbidden].sort(), volatile: [...volatile].sort() };
}

/** The parts of a rollup spec that decide its tables' layout (compared against a prebuilt file). */
export function specShape(spec: RollupSpec): unknown {
  return { table: spec.table, time: spec.time, dims: spec.dims, measures: spec.measures.map(m => [m.name, m.type, m.nulls]) };
}

/** DuckDB-Wasm's DuckDBDataProtocol.BROWSER_FILEREADER: a File/Blob read with FileReaderSync. */
const FILE_READER_PROTOCOL = 2;

/** DuckDB database files carry the magic `DUCK` at byte 8. */
function isDuckDbFile(bytes: Uint8Array, size: number): boolean {
  return size > 4096 && bytes[8] === 0x44 && bytes[9] === 0x55 && bytes[10] === 0x43 && bytes[11] === 0x4b;
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 64)).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

function sameExtensions(a: string[] | undefined, b: string[] | undefined): boolean {
  const norm = (x: string[] | undefined) => [...new Set(x ?? [])].filter(e => e !== 'parquet').sort().join(',');
  return norm(a) === norm(b);
}
const REWRITE_MEMO = 256;

class Aborted extends Error {}

/** Opening this source needs the parquet extension, which this DuckDB instance did not load at
 * boot (src/engine/database.ts ParquetOnDemand re-instantiates DuckDB with it). */
export class NeedsParquet extends Error {
  constructor() { super('Parquet support is not loaded in this DuckDB instance (the parquet extension could not be loaded)'); }
}

/** A result being collected for the result cache. */
interface Keep { schema?: Schema; batches: RecordBatch[]; rows: number; bytes: number; overflow?: boolean }

interface Job {
  request: number; epoch: number; revision: number; context: number;
  sql: string; receivedAt: number; t0: number; canceled: boolean;
  /** WARM EXEC: run at the lowest priority, cache the result, stream nothing. */
  warm?: boolean;
  /** A warm job yielded to a real EXEC this many times (it is requeued up to MAX_WARM_PREEMPTIONS). */
  preempted?: number;
}

/** Waiting WARM EXECs beyond the running one; the oldest is refused first. */
const MAX_WARM_QUEUED = 8;
const MAX_WARM_PREEMPTIONS = 3;

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
  /** WARM EXECs: run only when `queue` is empty, newest first; a real EXEC preempts a running one. */
  private readonly warmQueue: Job[] = [];
  private running?: Job;
  private pumping?: Promise<void>;
  private disposed = false;
  /** EXEC frames dropped for a stale epoch or another context. */
  dropped = 0;
  readonly cache?: ResultCache;
  /** Rollups of the current dataset; grains appear as they finish building. */
  rollups: RollupTable[] = [];
  private buildToken = 0;
  private building?: Promise<void>;
  private warming?: Promise<void>;
  private catalog?: Catalog;
  private readonly templates = new Map<string, unknown>();
  private readonly rewrites = new Map<string, { sql?: string; reason: string; grain?: string }>();
  /** Registered prebuilt file (dropped on detach). */
  private attached?: string;
  private fixtureCatalog = false;
  /** Tables may be in the in-memory catalog (open() must drop them first). */
  private homeUsed: boolean;
  /** The catalog connections return to when no prebuilt database is attached. */
  private home = 'memory';

  constructor(private readonly db: DuckBindings, private readonly emit: Emit, private readonly options: DatabaseNodeOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.homeUsed = !options.freshInstance;
    if (options.lockdown) { this.lockOpen = false; this.lockGate = new Promise(resolve => { this.releaseLock = resolve; }); }
    this.sliceMs = options.sliceMs ?? SLICE_MS;
    const query = db.connect(), load = db.connect();
    this.connections = [query, load];
    this.queryConn = query.useUnsafe((_, conn) => conn);
    this.loadConn = load.useUnsafe((_, conn) => conn);
    if (options.resultCache !== false) {
      this.cache = new ResultCache({ ...DEFAULT_RESULT_CACHE, ...options.resultCache }, new Set(NON_DETERMINISTIC));
    }
    if (options.compressed !== false) {
      // Compressed in-memory storage: dictionary/RLE strings make GROUP BY on text columns
      // several times faster and tables smaller (docs/batch-2/database.md). ATTACH of ':memory:'
      // needs no external access, so it works after lockDown. On failure we stay on the default catalog.
      try {
        this.rowsSync(this.loadConn, `ATTACH IF NOT EXISTS ':memory:' AS ${DATA_CATALOG} (COMPRESS)`);
        for (const conn of [this.loadConn, this.queryConn]) this.rowsSync(conn, `USE ${DATA_CATALOG}`);
        this.home = DATA_CATALOG;
      } catch { /* uncompressed default catalog */ }
    }
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
    if (frame.flags & Flag.WARM) {
      job.warm = true;
      if (this.warmQueue.length >= MAX_WARM_QUEUED) this.fail(this.warmQueue.shift()!, 'queue_full', 'Too many warm-ups waiting');
      this.warmQueue.push(job);
      this.pump();
      return;
    }
    // Real work first: a running warm-up stops at its next poll and is requeued.
    if (this.running?.warm) { this.running.canceled = true; this.running.preempted = (this.running.preempted ?? 0) + 1; }
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
    for (const queue of [this.queue, this.warmQueue]) {
      const index = queue.findIndex(job => job.request === request);
      if (index >= 0) queue.splice(index, 1);
    }
    if (this.running?.request === request) this.running.canceled = true;
  }

  private cancelAll(): void {
    this.queue.length = 0;
    this.warmQueue.length = 0;
    if (this.running) { this.running.canceled = true; this.running.preempted = undefined; }
  }

  /** The open dataset (warm-up statements are derived from it). */
  private current?: DatasetContext;

  /** After the deferred lockdown: run two statements shaped like typical questions (a scan
   * aggregate; a time bucket, rewritten onto a rollup) so DuckDB's lazily compiled code paths and
   * the parser/printer are warm before the first real query. Background priority (yields to any
   * EXEC before every poll); derived from the context, no schema assumed. */
  private async warmUp(): Promise<void> {
    const context = this.current, token = this.buildToken;
    if (!context || this.disposed || this.options.warmUp === false) return;
    const w0 = bootClock();
    try {
      await this.building;
      const table = context.tables[0];
      const measure = table?.columns.find(c => classify(c.type) === 'numeric');
      if (!table || !measure) return;
      const time = table.columns.find(c => c.type.toUpperCase() === 'TIMESTAMP');
      const t = quoteIdent(table.name), m = quoteIdent(measure.name);
      const statements = [`SELECT count(*), min(${m}), max(${m}) FROM ${t}`];
      if (time) statements.push(`SELECT date_trunc('hour', ${quoteIdent(time.name)}) AS t, avg(${m}) AS v FROM ${t} GROUP BY 1 ORDER BY 1`);
      for (const sql of statements) {
        await this.idle(token);
        const rewritten = this.rollups.length ? this.rewrite(sql).sql ?? sql : sql;
        await this.background(token, rewritten);
      }
      bootMark('duckdb.warmup', w0);
    } catch { /* superseded or failed: only a warm-up */ }
  }

  private lockGate?: Promise<void>;
  private lockOpen = true;
  private lockStarted = false;
  private releaseLock?: () => void;

  /** Run the deferred lockdown once (after the first open, successful or not). */
  private startLockdown(): void {
    if (this.lockStarted || !this.options.lockdown) return;
    this.lockStarted = true;
    setTimeout(() => {
      const l0 = bootClock();
      void (this.disposed ? Promise.resolve() : this.options.lockdown!()).catch(() => { /* reported by the boot code */ }).finally(() => {
        this.lockOpen = true;
        this.releaseLock?.();
        bootMark('duckdb.lockdown-deferred', l0);
        this.warming = this.warmUp();
      });
    }, 0);
  }

  /** Starts executing synchronously (once the deferred lockdown, if any, is done): a small query
   * may finish inside handle(). */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = (async () => {
      try {
        if (!this.lockOpen) await this.lockGate;
        while ((this.queue.length || this.warmQueue.length) && !this.disposed) {
          // Warm-ups newest first: the latest result's suggestions are the ones on screen.
          const job = this.queue.shift() ?? this.warmQueue.pop()!;
          await this.execute(job);
          // A preempted warm-up runs again next (behind all real work).
          if (job.warm && job.canceled && job.preempted && job.preempted <= MAX_WARM_PREEMPTIONS && !this.disposed) {
            job.canceled = false;
            job.t0 = performance.now();
            this.warmQueue.push(job);
          }
        }
      } finally {
        this.pumping = undefined;
      }
    })();
  }

  private stamp(stage: number, at = now()): Stamp { return { stage, node: Node.DATABASE, at }; }

  private send(job: Job, kind: number, payload: Uint8Array | Schema | RecordBatch, stamps: Stamp[], flags = 0): void {
    this.emit({
      kind: kind as Frame['kind'], flags, epoch: job.epoch, request: job.request, revision: job.revision,
      context: job.context, stamps, payload,
    } as Frame<Uint8Array>);
  }

  private fail(job: Job, code: string, message: string): void {
    this.send(job, Kind.ERROR, json({ code, message }), [this.stamp(Stage.EXEC_RECEIVED, job.receivedAt)]);
  }

  private async execute(job: Job): Promise<void> {
    const stats: ExecStats = { request: job.request, outcome: 'error', source: 'raw', guardMs: 0, polls: 0, fetchRetries: 0, yields: 0, batches: 0, rows: 0, bytes: 0 };
    if (job.warm) stats.warm = true;
    this.running = job;
    try {
      if (job.canceled) { stats.outcome = 'canceled'; return; }
      const g0 = performance.now();
      const guard = guardSql(job.sql, this.db);
      stats.guardMs = performance.now() - g0;
      if (!guard.ok) { this.fail(job, 'sql_rejected', guard.message); return; }

      const key = cacheKey(guard.inner);
      if (job.warm && !this.cache?.cacheable(key)) { this.fail(job, 'not_cacheable', 'The statement is not cacheable; warming it is pointless'); return; }
      const hit = this.cache?.get(key);
      if (hit) {
        stats.source = 'cache';
        if (job.warm) { stats.rows = hit.rows; stats.bytes = hit.bytes; this.done(job, stats); return; }
        await this.replay(job, hit, stats);
        return;
      }

      let sql = guard.sql;
      if (this.rollups.length) {
        const r0 = performance.now();
        const rewrite = this.rewrite(guard.inner);
        stats.rewriteMs = performance.now() - r0;
        if (rewrite.sql) { sql = wrapStatement(rewrite.sql); stats.source = 'rollup'; stats.grain = rewrite.grain; } else stats.rewrite = rewrite.reason;
      }
      const keep = this.cache?.cacheable(key) ? { batches: [] as RecordBatch[], rows: 0, bytes: 0 } as Keep : undefined;
      let result = await this.stream(job, sql, stats, keep, stats.source === 'rollup');
      if (typeof result === 'object') {
        // The rewritten statement did not start: run the model's statement as written.
        stats.fallback = result.fallback;
        stats.source = 'raw';
        result = await this.stream(job, guard.sql, stats, keep, false);
      }
      if (result === 'done' && keep?.schema && !keep.overflow) this.cache!.set(key, { schema: keep.schema, batches: keep.batches, rows: keep.rows, bytes: keep.bytes });
    } catch (error) {
      this.fail(job, 'sql_error', unwrapError(messageOf(error)));
    } finally {
      if (this.running === job) this.running = undefined;
      try { this.options.onExecStats?.(stats); } catch { /* a measurement hook must not break the node */ }
    }
  }

  /** Run one statement and stream its result. With `fallback`, a failure before the schema is
   * returned (`{fallback}`) instead of being reported, so the caller can run the raw statement. */
  private async stream(job: Job, sql: string, stats: ExecStats, keep: Keep | undefined, fallback: boolean): Promise<'done' | 'canceled' | 'failed' | { fallback: string }> {
    const { db, queryConn: conn, limits } = this;
    const deadline = job.t0 + limits.timeMs;
    let started = false, finished = false;
    const pause = async () => { stats.yields++; await yieldToEventLoop(); };
    try {
      let header: Uint8Array | null;
      try {
        header = db.startPendingQuery(conn, sql, true);
        started = true;
        while (header === null) {
          await pause();
          if (job.canceled || this.disposed) { stats.outcome = 'canceled'; return 'canceled'; }
          if (performance.now() > deadline) { this.fail(job, 'timeout', `Query exceeded ${limits.timeMs} ms`); return 'failed'; }
          stats.polls++;
          header = db.pollPendingQuery(conn);
        }
      } catch (error) {
        started = false; // a failed pending query is already closed
        if (fallback) return { fallback: messageOf(error).slice(0, 300) };
        this.fail(job, 'sql_error', unwrapError(messageOf(error)));
        return 'failed';
      }

      const decoder = new IpcMessageDecoder();
      const first = decoder.decode(header);
      if (first.kind !== 'schema') throw new Error('DuckDB result did not start with a schema');
      stats.schemaMs = performance.now() - job.t0;
      if (keep) keep.schema = first.schema;
      if (!job.warm) this.send(job, Kind.RESULT_SCHEMA, first.schema, [this.stamp(Stage.EXEC_RECEIVED, job.receivedAt)]);

      let sliceStart = performance.now();
      for (;;) {
        if (job.canceled || this.disposed) { stats.outcome = 'canceled'; return 'canceled'; }
        const chunk = db.fetchQueryResults(conn);
        if (chunk === null) {
          // DuckDB ran a polling interval without producing a chunk: let messages in.
          stats.fetchRetries++;
          await pause();
          sliceStart = performance.now();
          if (sliceStart > deadline) { this.fail(job, 'timeout', `Query exceeded ${limits.timeMs} ms`); return 'failed'; }
          continue;
        }
        if (chunk.byteLength === 0) break;
        const decoded = decoder.decode(chunk);
        if (decoded.kind !== 'batch' || decoded.batch.numRows === 0) continue;
        stats.rows += decoded.batch.numRows;
        stats.bytes += chunk.byteLength;
        if (stats.rows > limits.maxRows || stats.bytes > limits.maxBytes) {
          this.fail(job, 'result_limit', `Result exceeds ${limits.maxRows} rows or ${limits.maxBytes} bytes`);
          return 'failed';
        }
        if (keep && !keep.overflow) {
          keep.bytes += chunk.byteLength;
          if (keep.bytes > this.cache!.options.maxEntryBytes) { keep.overflow = true; keep.batches = []; } else { keep.batches.push(decoded.batch); keep.rows += decoded.batch.numRows; }
        }
        if (!this.emitBatch(job, decoded.batch, stats)) return 'failed';
        if (performance.now() - sliceStart >= this.sliceMs) { await pause(); sliceStart = performance.now(); }
      }
      finished = true;
      this.done(job, stats);
      return 'done';
    } finally {
      if (started && !finished) { try { db.cancelPendingQuery(conn); } catch { /* connection already idle */ } }
    }
  }

  /** Emit one BATCH; false if the deadline passed (ERROR sent). */
  private emitBatch(job: Job, batch: RecordBatch, stats: ExecStats): boolean {
    const stamps = stats.batches === 0 ? [this.stamp(Stage.DB_FIRST_BATCH)] : [];
    if (stats.batches === 0) stats.firstBatchMs = performance.now() - job.t0;
    stats.batches++;
    if (!job.warm) this.send(job, Kind.BATCH, batch, stamps);
    if (performance.now() > job.t0 + this.limits.timeMs) { this.fail(job, 'timeout', `Query exceeded ${this.limits.timeMs} ms`); return false; }
    return true;
  }

  private done(job: Job, stats: ExecStats): void {
    const done = new Uint8Array(16), view = new DataView(done.buffer);
    view.setBigUint64(0, BigInt(stats.rows), true);
    view.setBigUint64(8, BigInt(stats.bytes), true);
    stats.doneMs = performance.now() - job.t0;
    stats.outcome = 'done';
    const source = stats.source === 'rollup' ? Flag.ROLLUP : stats.source === 'cache' ? Flag.RESULT_CACHE : 0;
    this.send(job, Kind.DONE, done, [this.stamp(Stage.DB_DONE)], source | (job.warm ? Flag.DONE_WARM : 0));
  }

  /** Replay a cached result: same frames, stamps, time slicing and cancellation as a live one. */
  private async replay(job: Job, hit: CachedResult, stats: ExecStats): Promise<void> {
    stats.schemaMs = performance.now() - job.t0;
    this.send(job, Kind.RESULT_SCHEMA, hit.schema, [this.stamp(Stage.EXEC_RECEIVED, job.receivedAt)]);
    let sliceStart = performance.now();
    for (const batch of hit.batches) {
      if (job.canceled || this.disposed) { stats.outcome = 'canceled'; return; }
      stats.rows += batch.numRows;
      if (!this.emitBatch(job, batch, stats)) return;
      if (performance.now() - sliceStart >= this.sliceMs) { stats.yields++; await yieldToEventLoop(); sliceStart = performance.now(); }
    }
    if (job.canceled || this.disposed) { stats.outcome = 'canceled'; return; }
    stats.bytes = hit.bytes;
    this.done(job, stats);
  }

  // ───────────────────────── rollups ─────────────────────────

  /** Rewrite decision for one statement, memoized per text. Synchronous: two small DuckDB calls
   * on the query connection (parse, print), only for statements naming a rolled-up table. */
  private rewrite(inner: string): { sql?: string; reason: string; grain?: string } {
    const memo = this.rewrites.get(inner);
    if (memo) { this.rewrites.delete(inner); this.rewrites.set(inner, memo); return memo; }
    let result: { sql?: string; reason: string; grain?: string };
    if (!this.catalog || !mayRewrite(inner, this.rollups)) result = { reason: 'no rollup for this statement' };
    else {
      try {
        const [parsedText] = this.rowsSync(this.queryConn, `SELECT json_serialize_sql(${quoteLiteral(inner)})`)[0] as [string];
        const parsed = parseAst(parsedText);
        const plan = !parsed ? { ok: false as const, reason: 'integer literal beyond 2^53' } : planRewrite({ parsed, rollups: this.rollups, catalog: this.catalog, template: sql => this.template(sql), shortRangeRows: this.options.rollupShortRangeRows });
        if (!plan.ok) result = { reason: plan.reason };
        else {
          const empty = (this.template(AGG_TEMPLATE_SQL) as { statements: Array<{ node: { from_table: unknown } }> }).statements[0].node.from_table;
          const jobs = printJobs(plan, parsed, empty);
          const printed = this.rowsSync(this.queryConn, `SELECT ${jobs.map(j => `json_deserialize_sql(${quoteLiteral(j)}::JSON)`).join(', ')}`)[0] as string[];
          result = { sql: finishSql(plan, printed), reason: 'rewritten', grain: plan.grain.name + (plan.edges ? '+edges' : '') };
        }
      } catch (error) {
        result = { reason: `rewrite failed: ${messageOf(error).slice(0, 200)}` };
      }
    }
    this.rewrites.set(inner, result);
    if (this.rewrites.size > REWRITE_MEMO) this.rewrites.delete(this.rewrites.keys().next().value!);
    return result;
  }

  private parserConn?: number | null;

  /** DuckDB's own parser and printer (json extension) for chart-as-query (src/engine/manipulate.ts),
   * on a dedicated connection so a streaming query or a rollup build is never disturbed.
   * Undefined when the json extension is not loaded. Synchronous; ~1–3 ms per call. */
  sqlTools(): { parse(sql: string): unknown; print(trees: unknown[]): string[] } | undefined {
    if (!this.lockOpen) return undefined; // json loads with the deferred lockdown
    if (this.parserConn === undefined) {
      try {
        const connection = this.db.connect();
        this.connections.push(connection);
        const conn = connection.useUnsafe((_, id) => id);
        this.rowsSync(conn, `SELECT json_serialize_sql('SELECT 1')`);
        this.parserConn = conn;
      } catch {
        this.parserConn = null;
      }
    }
    const conn = this.parserConn;
    if (conn === null || this.disposed) return undefined;
    return {
      parse: sql => {
        const [text] = this.rowsSync(conn, `SELECT json_serialize_sql(${quoteLiteral(sql)})`)[0] as [string];
        return parseAst(text);
      },
      print: trees => this.rowsSync(conn, `SELECT ${trees.map(t => `json_deserialize_sql(${quoteLiteral(JSON.stringify(t))}::JSON)`).join(', ')}`)[0] as string[],
    };
  }

  private template(sql: string): unknown {
    let t = this.templates.get(sql);
    if (!t) {
      const [text] = this.rowsSync(this.queryConn, `SELECT json_serialize_sql(${quoteLiteral(sql)})`)[0] as [string];
      t = parseAst(text);
      if ((t as { error?: boolean }).error) throw new Error(`template does not parse: ${text.slice(0, 200)}`);
      this.templates.set(sql, t);
    }
    return t;
  }

  /** Background: build rollups for the dataset just opened. Each DuckDB step waits until no
   * query is running or queued before every poll, so it delays a query by at most one DuckDB
   * task; a new open() aborts it. Grains become usable one by one as they finish. */
  private async buildRollups(token: number, context: DatasetContext): Promise<void> {
    const specs = rollupSpecs(context);
    if (!specs.length) { this.options.onRollupStats?.({ table: '*', ms: 0, done: true, skipped: 'no table with a TIMESTAMP column and numeric columns' }); return; }
    await this.loadCatalog(token);
    await this.background(token, `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(ROLLUP_SCHEMA)}`);
    for (const spec of specs) {
      const grains = GRAINS.filter(g => spec.estimate(g) * 4 <= spec.rows);
      if (!grains.length) { this.options.onRollupStats?.({ table: spec.table, ms: 0, skipped: 'too few rows per time cell' }); continue; }
      const [nulls] = await this.background(token, nullCheckSql(spec));
      spec.measures.forEach((m, i) => { m.nulls = Number(nulls[i]) > 0; });
      const table: RollupTable = { spec, grains: [] };
      this.rollups.push(table);
      let previous: Grain | undefined;
      for (const grain of grains) {
        const t0 = performance.now();
        await this.background(token, buildSql(spec, grain, previous));
        const [[rows]] = await this.background(token, `SELECT count(*) FROM ${rollupTableName(spec, grain)}`);
        const ms = performance.now() - t0;
        table.grains.push({ grain, table: rollupTableName(spec, grain), rows: Number(rows), ms });
        this.rewrites.clear();
        this.options.onRollupStats?.({ table: spec.table, grain: grain.name, rows: Number(rows), ms });
        bootMark(`rollup.${grain.name}`, performance.timeOrigin + t0, spec.table);
        previous = grain;
      }
    }
    this.options.onRollupStats?.({ table: '*', ms: 0, done: true });
    bootMark('rollups.ready');
  }

  /** Resolves when no EXEC is running or queued; throws Aborted when the build is superseded. */
  private async idle(token: number): Promise<void> {
    for (;;) {
      if (token !== this.buildToken || this.disposed) throw new Aborted('rollup build aborted');
      if (!this.pumping && !this.queue.length) return;
      await (this.pumping ?? yieldToEventLoop());
      await yieldToEventLoop();
    }
  }

  /** Run SQL on the load connection, giving way to queries before every poll. */
  /** A background statement is pending on the load connection (dispose cancels it). */
  private loadPending = false;

  private async background(token: number, sql: string): Promise<unknown[][]> {
    await this.idle(token);
    let header = this.db.startPendingQuery(this.loadConn, sql, false);
    this.loadPending = header === null;
    try {
      while (header === null) {
        await yieldToEventLoop();
        await this.idle(token);
        header = this.db.pollPendingQuery(this.loadConn);
      }
    } catch (error) {
      // After dispose the connection is closed and its id may already belong to another
      // connection (DuckDB reuses ids): cancelling it then would kill someone else's query.
      if (error instanceof Aborted && !this.disposed) { try { this.db.cancelPendingQuery(this.loadConn); } catch { /* idle */ } }
      throw error;
    } finally {
      this.loadPending = false;
    }
    return this.drain(this.loadConn, header);
  }

  /** Stop all background owners before a dataset load reuses the load connection. */
  private async stopRollups(): Promise<void> {
    this.buildToken++;
    await Promise.all([this.building, this.warming]);
    this.building = undefined;
    this.warming = undefined;
    this.rollups = [];
    this.rewrites.clear();
  }

  /** Small statements (hot-path parse/print, construction): run to completion without yielding. */
  private rowsSync(conn: number, sql: string): unknown[][] {
    let header = this.db.startPendingQuery(conn, sql, false);
    while (header === null) header = this.db.pollPendingQuery(conn);
    return this.drain(conn, header);
  }

  private drain(conn: number, header: Uint8Array): unknown[][] {
    const decoder = new IpcMessageDecoder();
    decoder.decode(header);
    const out: unknown[][] = [];
    for (;;) {
      const chunk = this.db.fetchQueryResults(conn);
      if (chunk === null) continue;
      if (chunk.byteLength === 0) break;
      const decoded = decoder.decode(chunk);
      if (decoded.kind === 'batch') appendPlain(out, decoded.batch);
    }
    return out;
  }

  // ───────────────────────── datasets ─────────────────────────

  async open(source: DatasetSource, contextId: number): Promise<DatasetContext> {
    try {
      return await this.openDataset(source, contextId);
    } finally {
      this.startLockdown();
    }
  }

  private async openDataset(source: DatasetSource, contextId: number): Promise<DatasetContext> {
    if (this.disposed) throw new Error('database node is disposed');
    // Work for the previous context is meaningless now: stop it and refuse new EXECs.
    this.contextId = 0;
    this.current = undefined;
    this.cancelAll();
    await this.pumping;
    await this.stopRollups();
    this.cache?.clear();
    this.status('loading', `Loading ${source.name}`, 0.1);
    const t0 = performance.now();
    try {
      await this.detachFixture();
      // Only an earlier in-memory load leaves tables behind (a prebuilt file is just detached).
      if (this.homeUsed) { await this.dropAll(); bootMark('dataset.drop', performance.timeOrigin + t0); }
      // Manifest fixtures (src/engine/datasets.ts): a prebuilt database first; nothing to compute.
      const entry = source.kind === 'fixture' ? await this.manifestEntry(source.name) : undefined;
      const prebuilt = entry?.prebuilt && this.options.prebuilt !== false ? await this.attachPrebuilt(entry) : undefined;
      if (prebuilt) return this.openPrebuilt(source.name, entry!, prebuilt, contextId, t0);
      let description: string;
      this.homeUsed = true;
      const tablesLoaded = entry ? await this.loadManifestTables(entry) : false;
      if (tablesLoaded) {
        description = entry!.description ?? entry!.title ?? source.name;
      } else if (source.kind === 'fixture' && source.name === 'vessels') {
        await this.run(this.loadConn, VESSELS_SQL);
        description = entry?.description ?? VESSELS_DESCRIPTION;
      } else {
        const fetchBytes = this.options.fetchBytes ?? defaultFetchBytes;
        let fileName: string, bytes: Uint8Array;
        if (source.kind === 'fixture') {
          if (source.name !== 'vessels-small') throw new Error(`Unknown dataset ${source.name}`);
          const url = this.options.fixtureUrl?.(source.name) ?? new URL('data/telemetry.parquet', globalThis.location?.href).href;
          fileName = 'telemetry.parquet'; bytes = await fetchBytes(url);
        } else if (source.kind === 'file') {
          fileName = source.file.name || source.name; bytes = new Uint8Array(await source.file.arrayBuffer());
        } else if (source.kind === 'remote') {
          throw new Error('Remote sources open through the remote database node, not DuckDB.');
        } else {
          fileName = new URL(source.url, globalThis.location?.href).pathname.split('/').pop() || source.name;
          bytes = await fetchBytes(source.url);
        }
        const detected = sniffFormat(fileName, bytes);
        const format = (source.kind === 'file' || source.kind === 'url') ? source.format ?? detected : detected;
        if (format === 'parquet') this.requireParquet();
        const table = (source.kind === 'file' || source.kind === 'url') ? source.table ?? tableNameFor(fileName) : tableNameFor(fileName);
        // The logical table name may come from an imported canvas: never put it in a path.
        const path = `${UPLOAD_DIR}${tableNameFor(table)}.${format}`;
        this.db.registerFileBuffer(path, bytes); // copies into Wasm memory; `bytes` can be collected
        try {
          await this.run(this.loadConn, loadFileSql(table, path, format));
        } finally {
          this.db.dropFile(path);
        }
        description = source.kind === 'fixture' ? VESSELS_SMALL_DESCRIPTION : `${format === 'parquet' ? 'Parquet' : 'CSV'} file ${fileName}`;
      }
      const t1 = performance.now();
      bootMark('dataset.load', performance.timeOrigin + t0, source.name);
      this.status('loading', 'Computing statistics', 0.8);
      const { context, statisticsMs } = await this.describe(contextId, source.name, description, entry?.tables.map(t => t.name));
      const t2 = performance.now();
      bootMark('dataset.context', performance.timeOrigin + t1, `statistics ${statisticsMs.toFixed(1)} ms`);
      this.options.onOpenStats?.({ loadMs: t1 - t0, contextMs: t2 - t1, statisticsMs });
      this.contextId = contextId;
      this.current = context;
      if (this.options.rollups !== false) {
        const token = this.buildToken;
        this.building = this.buildRollups(token, context).catch(error => {
          if (!(error instanceof Aborted)) this.options.onRollupStats?.({ table: '*', ms: 0, done: true, skipped: messageOf(error).slice(0, 300) });
        });
      }
      this.status('ready', `${source.name} · ${context.tables.map(t => `${t.rows.toLocaleString('en-US')} rows`).join(', ')}`, 1);
      return context;
    } catch (error) {
      if (!(error instanceof NeedsParquet)) this.status('error', `Could not load ${source.name}`, undefined, messageOf(error));
      throw error;
    }
  }

  /** Throws NeedsParquet when this instance is known to lack the parquet extension. */
  private requireParquet(): void {
    if (this.options.extensions && !this.options.extensions.includes('parquet')) throw new NeedsParquet();
  }

  // ───────────────────────── manifest fixtures and prebuilt databases ─────────────────────────

  private async manifestEntry(name: string): Promise<ManifestEntry | undefined> {
    if (!this.options.manifest) return undefined;
    try {
      return (await this.options.manifest()).find(entry => entry.name === name);
    } catch {
      return undefined; // no manifest: built-in fixtures
    }
  }

  private dataUrl(path: string): string {
    return this.options.dataUrl?.(path) ?? new URL(path, globalThis.location?.href).href;
  }

  /** Fetch and attach `entry.prebuilt` read-only; undefined (and nothing attached) if it is
   * missing, not a DuckDB file of our layout, or fails to attach: the caller falls back. */
  private async attachPrebuilt(entry: ManifestEntry): Promise<PrebuiltMeta | undefined> {
    const f0 = bootClock();
    let data: Uint8Array | Blob;
    try {
      data = await (this.options.fetchPrebuilt ?? this.options.fetchBytes ?? defaultFetchBytes)(this.dataUrl(entry.prebuilt!));
    } catch {
      return undefined;
    }
    const blob = typeof Blob !== 'undefined' && data instanceof Blob ? data : undefined;
    const size = blob ? blob.size : (data as Uint8Array).byteLength;
    bootMark('dataset.fetch', f0, `${(size / 1048576).toFixed(1)} MiB${blob ? ' blob' : ''}`);
    const head = blob ? new Uint8Array(await blob.slice(0, 4096 + 1).arrayBuffer()) : data as Uint8Array;
    if (!isDuckDbFile(head, size)) return undefined;
    const a0 = bootClock();
    const path = `${UPLOAD_DIR}${entry.name.replace(/[^A-Za-z0-9_-]+/g, '_')}.duckdb`;
    if (blob && this.db.registerFileHandle) {
      // Read lazily (FileReaderSync on the Blob, block by block): nothing is copied up front.
      this.db.registerFileHandle(path, blob, FILE_READER_PROTOCOL, true);
    } else {
      this.db.registerFileBuffer(path, blob ? new Uint8Array(await blob.arrayBuffer()) : data as Uint8Array); // copied into Wasm memory
    }
    this.attached = path;
    try {
      await this.run(this.loadConn, `ATTACH ${quoteLiteral(path)} AS ${FIXTURE_CATALOG} (READ_ONLY)`);
      this.fixtureCatalog = true;
      for (const conn of [this.loadConn, this.queryConn]) this.rowsSync(conn, `USE ${FIXTURE_CATALOG}`);
      const [[text]] = await this.rows(this.loadConn, `SELECT meta FROM ${META_SQL_NAME}`) as [[string]];
      const meta = JSON.parse(text) as PrebuiltMeta;
      if (meta.format !== PREBUILT_FORMAT) throw new Error(`prebuilt format ${meta.format}`);
      bootMark('dataset.attach', a0);
      return meta;
    } catch (error) {
      this.status('loading', `Prebuilt ${entry.name} unusable; loading tables`, 0.2, messageOf(error));
      await this.detachFixture();
      return undefined;
    }
  }

  /** Context and rollups straight from a prebuilt database's metadata. */
  private async openPrebuilt(name: string, entry: ManifestEntry, meta: PrebuiltMeta, contextId: number, t0: number): Promise<DatasetContext> {
    const t1 = performance.now();
    bootMark('dataset.load', performance.timeOrigin + t0, `${name} (prebuilt)`);
    const context: DatasetContext = { ...meta.context, id: contextId, name, ...(entry.description ? { description: entry.description } : {}) };
    if (this.options.rollups !== false) {
      const specs = rollupSpecs(context);
      for (const stored of meta.rollups) {
        const spec = specs.find(s => s.table === stored.table);
        if (!spec) continue;
        for (const m of spec.measures) m.nulls = stored.nulls[m.name] ?? true;
        // The file's rollups were built from this same context; refuse them if the derived
        // shape differs (then queries run raw, still exact).
        if (stored.spec && JSON.stringify(specShape(spec)) !== JSON.stringify(stored.spec)) continue;
        const table: RollupTable = { spec, grains: [] };
        for (const g of stored.grains) {
          const grain = GRAINS.find(x => x.name === g.name);
          if (grain) table.grains.push({ grain, table: rollupTableName(spec, grain), rows: g.rows, ms: 0 });
        }
        if (table.grains.length) this.rollups.push(table);
      }
      if (meta.catalog && meta.duckdb === this.version() && sameExtensions(meta.catalog.extensions, this.options.extensions)) {
        this.catalog = { aggregates: new Set(meta.catalog.aggregates), forbidden: new Set(meta.catalog.forbidden) };
        for (const name of meta.catalog.volatile) this.cache?.volatile.add(name);
      } else if (this.rollups.length) {
        // Different engine build: derive the function catalog here (rewrites wait for it).
        const token = this.buildToken;
        this.building = this.loadCatalog(token).catch(() => { this.rollups = []; });
      }
    }
    const t2 = performance.now();
    this.options.onOpenStats?.({ loadMs: t1 - t0, contextMs: t2 - t1, statisticsMs: 0 });
    this.contextId = contextId;
    this.current = context;
    if (this.options.rollups !== false) {
      for (const r of this.rollups) for (const g of r.grains) this.options.onRollupStats?.({ table: r.spec.table, grain: g.grain.name, rows: g.rows, ms: 0 });
      this.options.onRollupStats?.({ table: '*', ms: 0, done: true, ...(this.rollups.length ? {} : { skipped: 'no prebuilt rollups' }) });
      bootMark('rollups.ready', undefined, 'prebuilt');
    }
    this.status('ready', `${name} · ${context.tables.map(t => `${t.rows.toLocaleString('en-US')} rows`).join(', ')}`, 1);
    return context;
  }

  /** Load a manifest entry's table files; false if any is missing (then the caller falls back). */
  private async loadManifestTables(entry: ManifestEntry): Promise<boolean> {
    if (!entry.tables.length) return false;
    const fetchBytes = this.options.fetchBytes ?? defaultFetchBytes;
    const files: Array<{ table: ManifestTable; bytes: Uint8Array }> = [];
    try {
      for (const table of entry.tables) files.push({ table, bytes: await fetchBytes(this.dataUrl(table.url)) });
    } catch {
      return false;
    }
    // A dev server answers unknown paths with index.html: that is a missing file, not CSV.
    if (files.some(f => looksLikeHtml(f.bytes))) return false;
    if (files.some(f => sniffFormat(f.table.url, f.bytes) === 'parquet')) this.requireParquet();
    for (const { table, bytes } of files) {
      const format = sniffFormat(table.url, bytes);
      const path = `${UPLOAD_DIR}${tableNameFor(table.url)}.${format}`;
      this.db.registerFileBuffer(path, bytes);
      try {
        await this.run(this.loadConn, loadFileSql(table.name, path, format));
      } finally {
        this.db.dropFile(path);
      }
    }
    return true;
  }

  /** Back to the in-memory catalog; forget an attached prebuilt database. */
  private async detachFixture(): Promise<void> {
    if (this.fixtureCatalog) {
      for (const conn of [this.loadConn, this.queryConn]) this.rowsSync(conn, `USE ${this.home}`);
      await this.run(this.loadConn, `DETACH ${FIXTURE_CATALOG}`);
      this.fixtureCatalog = false;
    }
    if (this.attached) { this.db.dropFile(this.attached); this.attached = undefined; }
  }

  /** The function catalog the rewrite needs (aggregates, macros/volatile functions). */
  private async loadCatalog(token: number): Promise<void> {
    if (this.catalog) return;
    const functions = await this.background(token, CATALOG_SQL);
    const catalog = catalogFrom(functions as Array<[string, string, string | null]>);
    for (const name of catalog.volatile) this.cache?.volatile.add(name);
    this.catalog = { aggregates: new Set(catalog.aggregates), forbidden: new Set(catalog.forbidden) };
  }

  private versionText?: string;
  private version(): string {
    if (this.versionText === undefined) {
      try { this.versionText = String(this.rowsSync(this.loadConn, 'SELECT version()')[0][0]); } catch { this.versionText = ''; }
    }
    return this.versionText;
  }

  private status(state: 'loading' | 'ready' | 'error', label: string, progress?: number, detail?: string): void {
    this.emit({
      kind: Kind.STATUS, flags: 0, epoch: 0, request: 0, revision: 0, context: 0, stamps: [],
      payload: json({ component: 'database', state, label, ...(detail ? { detail } : {}), ...(progress !== undefined ? { progress } : {}) }),
    });
  }

  private async dropAll(): Promise<void> {
    await this.run(this.loadConn, `DROP SCHEMA IF EXISTS ${quoteIdent(ROLLUP_SCHEMA)} CASCADE`);
    const rows = await this.rows(this.loadConn,
      "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'main' AND table_catalog = current_database()");
    for (const [name, type] of rows as Array<[string, string]>) {
      await this.run(this.loadConn, `DROP ${type === 'VIEW' ? 'VIEW' : 'TABLE'} IF EXISTS "${name.replaceAll('"', '""')}"`);
    }
  }

  /** `order`: the manifest's table order (the prompt lists tables in it; evals were measured so).
   * Tables it doesn't name follow alphabetically. */
  private async describe(id: number, name: string, description: string, order: string[] = []): Promise<{ context: DatasetContext; statisticsMs: number }> {
    const columns = await this.rows(this.loadConn,
      "SELECT table_name, column_name, data_type FROM duckdb_columns() WHERE schema_name = 'main' AND database_name = current_database() ORDER BY table_name, column_index");
    const byTable = new Map<string, ColumnInfo[]>();
    for (const [table, column, type] of columns as Array<[string, string, string]>) {
      if (!byTable.has(table)) byTable.set(table, []);
      byTable.get(table)!.push({ name: column, type });
    }
    const tables: DatasetContext['tables'] = [];
    let statisticsMs = 0;
    const rank = (table: string) => { const i = order.indexOf(table); return i < 0 ? order.length : i; };
    const ordered = [...byTable].sort(([a], [b]) => rank(a) - rank(b));
    for (const [table, info] of ordered) {
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
    for (const batch of await this.run(conn, sql)) appendPlain(out, batch);
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.buildToken++;
    this.cancelAll();
    if (this.loadPending) { try { this.db.cancelPendingQuery(this.loadConn); } catch { /* idle */ } }
    for (const connection of this.connections) { try { connection.close(); } catch { /* ignore */ } }
  }
}

function appendPlain(out: unknown[][], batch: RecordBatch): void {
  const columns = batch.schema.fields.map((_, i) => batch.getChildAt(i)!);
  for (let row = 0; row < batch.numRows; row++) out.push(columns.map(column => plain(column.get(row))));
}

function plain(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value && typeof value === 'object' && Symbol.iterator in value && typeof (value as { toArray?: unknown }).toArray === 'function') {
    return Array.from(value as Iterable<unknown>, plain);
  }
  return value ?? null;
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** JSON.parse of a json_serialize_sql tree. `query_location` is UINT64_MAX for synthesized nodes,
 * which a JS number cannot hold (and json_deserialize_sql then rejects): those become 0. Any other
 * integer beyond 2^53 would change value in a JS number, so the tree is refused (undefined). */
function parseAst(text: string): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  const cleaned = text.replace(/"query_location":\d{16,}/g, '"query_location":0');
  if (/\d{16,}/.test(cleaned)) return undefined;
  return JSON.parse(cleaned);
}

/** Boot-time configuration. After this, model SQL cannot read files or URLs (only registered
 * uploads under UPLOAD_DIR, which are dropped once materialized), load extensions, or change
 * settings. Parquet support is an extension DuckDB-Wasm fetches from extensions.duckdb.org,
 * so it must be loaded before external access is disabled. The json extension (same source)
 * provides `json_serialize_sql`/`json_deserialize_sql`, DuckDB's own parser and printer, which
 * the rollup rewrite needs; without it queries simply run on the raw tables. */
export async function lockDown(db: DuckBindings, { parquet = true, json = true, memoryLimit = '512MB', memoryOnly = false } = {}): Promise<{ parquet: boolean; parquetMs: number; json: boolean; jsonMs: number; error?: string }> {
  const connection = db.connect();
  const conn = connection.useUnsafe((_, id) => id);
  const exec = (sql: string) => {
    let header = db.startPendingQuery(conn, sql, false);
    while (header === null) header = db.pollPendingQuery(conn);
    while (true) { const chunk = db.fetchQueryResults(conn); if (chunk && chunk.byteLength === 0) break; }
  };
  try {
    exec(`SET memory_limit = '${memoryLimit}'`);
    if (memoryOnly) return { parquet: false, parquetMs: 0, json: false, jsonMs: 0 };
    let loaded = false, error: string | undefined;
    const t0 = performance.now();
    if (parquet) {
      try { exec('LOAD parquet'); loaded = true; } catch (e) { error = messageOf(e); }
      bootMark('ext.parquet', performance.timeOrigin + t0);
    }
    const parquetMs = performance.now() - t0;
    let jsonLoaded = false;
    const j0 = performance.now();
    if (json) {
      try { exec('LOAD json'); jsonLoaded = true; } catch (e) { error = [error, messageOf(e)].filter(Boolean).join('; '); }
      bootMark('ext.json', performance.timeOrigin + j0);
    }
    const jsonMs = performance.now() - j0;
    exec('SET autoinstall_known_extensions = false');
    exec('SET autoload_known_extensions = false');
    exec(`SET allowed_directories = ['${UPLOAD_DIR}']`);
    exec('SET enable_external_access = false');
    exec('SET lock_configuration = true');
    return { parquet: loaded, parquetMs, json: jsonLoaded, jsonMs, ...(error ? { error } : {}) };
  } finally {
    connection.close();
  }
}

