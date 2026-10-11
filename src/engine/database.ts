/**
 * createDatabase: DuckDB-Wasm's blocking API instantiated inside the engine worker. There is
 * no separate DuckDB worker and no RPC: queries run on this thread and Arrow messages come
 * back as return values.
 *
 * Boot (docs/batch-3/cold-start.md): the module is compiled while streaming, started by the
 * worker's first chunk (src/engine/early.ts) before this module has even loaded, and the compiled
 * module is handed to DuckDB's Emscripten loader (no second fetch, browser code cache on repeat
 * visits). Bundle choice mirrors DuckDB's own: `eh` (Wasm exceptions) where supported, else `mvp`.
 *
 * Extensions: `json` (DuckDB's parser for the rollup rewrite and chart-as-query) loads at boot.
 * `parquet` loads only when a Parquet source is opened: prebuilt fixtures need no Parquet, and
 * after the boot lockdown no extension can load, so the first Parquet open re-instantiates DuckDB
 * from the already compiled module with Parquet loaded (`ParquetOnDemand`).
 */
import { BROWSER_RUNTIME, ConsoleLogger, createDuckDB, LogLevel, type BlockingBindings } from 'duckdb-browser-blocking';
import type { CreateDatabase, DatabaseNode, DatasetContext, DatasetSource, Emit } from './contracts';
import { DuckDatabaseNode, lockDown, NeedsParquet, type DatabaseNodeOptions } from './database-node';
import { POLL_INTERVAL_MS } from './limits';
import { bootClock, bootMark } from './boot-trace';
import { compileDuckDB, dataUrl, DUCKDB_VERSION, loadManifest, prefetchExtensions, takePrebuilt } from './early';
import type { Frame } from '../protocol/frame';

export interface BootStats {
  bundle: 'eh' | 'mvp';
  version: string;
  /** Fetch + compile + instantiate. */
  instantiateMs: number;
  /** `LOAD parquet` (0 when not loaded at boot). */
  parquetMs: number;
  parquet: boolean;
  /** `LOAD json`: DuckDB's parser/printer for the rollup rewrite. */
  jsonMs: number;
  json: boolean;
  /** Extension load errors (parquet and/or json). */
  parquetError?: string;
  totalMs: number;
}

export interface BootOptions { parquet?: boolean; json?: boolean }

export async function bootDuckDB({ parquet = true, json = true }: BootOptions = {}): Promise<{ bindings: BlockingBindings; stats: BootStats }> {
  const t0 = performance.now(), b0 = bootClock();
  prefetchExtensions([...(json ? ['json'] : []), ...(parquet ? ['parquet'] : [])]);
  const compiled = await compileDuckDB();
  const i0 = bootClock();
  // Both entries name the compiled module's URL; the instantiate hook below never fetches it.
  const bindings = await createDuckDB({ mvp: { mainModule: compiled.url, mainWorker: '' }, eh: { mainModule: compiled.url, mainWorker: '' } },
    new ConsoleLogger(LogLevel.WARNING), BROWSER_RUNTIME);
  const hooks = bindings as unknown as { _runtime: unknown; instantiateWasm: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => unknown };
  hooks.instantiateWasm = (imports, done) => {
    (globalThis as { DUCKDB_RUNTIME?: unknown }).DUCKDB_RUNTIME = hooks._runtime;
    void WebAssembly.instantiate(compiled.module, imports).then(instance => done(instance, compiled.module));
    return {};
  };
  await bindings.instantiate();
  bootMark('duckdb.instantiate', i0, compiled.bundle);
  const t1 = performance.now();
  bindings.open({ path: ':memory:', query: { queryPollingInterval: POLL_INTERVAL_MS } });
  const version = bindings.getVersion();
  if (version !== DUCKDB_VERSION) console.warn(`DuckDB ${version}: update DUCKDB_VERSION in src/engine/early.ts (extension prefetch, prebuilt catalogs)`);
  const l0 = bootClock();
  const lock = await lockDown(bindings, { parquet, json });
  bootMark('duckdb.lockdown', l0, [json && 'json', parquet && 'parquet'].filter(Boolean).join('+'));
  bootMark('duckdb.boot', b0);
  return {
    bindings,
    stats: {
      bundle: compiled.bundle, version, instantiateMs: t1 - t0, parquetMs: lock.parquetMs, parquet: lock.parquet,
      jsonMs: lock.jsonMs, json: lock.json,
      ...(lock.error ? { parquetError: lock.error } : {}), totalMs: performance.now() - t0,
    },
  };
}

export function fixtureUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}data/telemetry.parquet`, self.location.origin).href;
}

/** Measurement switches, set when starting Vite (e.g. `VITE_TB_RESULT_CACHE=0 pnpm dev`) to
 * compare end to end with batch-2 database features off. Default: everything on.
 * `VITE_TB_PREBUILT=0` ignores prebuilt databases (generate/load + statistics + rollups in the page). */
function envOptions(): DatabaseNodeOptions {
  const env = import.meta.env ?? {};
  const off = (name: string) => env[name] === '0' || env[name] === 'false';
  return {
    ...(off('VITE_TB_RESULT_CACHE') ? { resultCache: false } : {}),
    ...(off('VITE_TB_ROLLUPS') ? { rollups: false } : {}),
    ...(off('VITE_TB_COMPRESSED') ? { compressed: false } : {}),
    ...(off('VITE_TB_PREBUILT') ? { prebuilt: false } : {}),
  };
}

const browserOptions = (): DatabaseNodeOptions => ({
  fixtureUrl, manifest: loadManifest, dataUrl, fetchPrebuilt: takePrebuilt, ...envOptions(),
});

export async function createDatabaseWith(emit: Emit, options: DatabaseNodeOptions = {}, boot: BootOptions = {}) {
  const { bindings, stats } = await bootDuckDB(boot);
  const extensions = [stats.json && 'json', stats.parquet && 'parquet'].filter((e): e is string => !!e);
  return { node: new DuckDatabaseNode(bindings, emit, { ...browserOptions(), extensions, ...options }), stats };
}

/** The local DuckDB node with Parquet support on demand (see the file comment). */
export class ParquetOnDemand implements DatabaseNode {
  private upgrading?: Promise<DuckDatabaseNode>;
  constructor(private node: DuckDatabaseNode, private readonly emit: Emit, private hasParquet: boolean) {}

  async open(source: DatasetSource, contextId: number): Promise<DatasetContext> {
    try {
      return await this.node.open(source, contextId);
    } catch (error) {
      if (!(error instanceof NeedsParquet) || this.hasParquet) throw error;
      const t0 = bootClock();
      const next = await (this.upgrading ??= createDatabaseWith(this.emit, {}, { parquet: true }).then(r => r.node));
      if (this.node !== next) { this.node.dispose(); this.node = next; this.hasParquet = true; }
      bootMark('duckdb.parquet-reboot', t0);
      return this.node.open(source, contextId);
    }
  }

  handle(frame: Frame<Uint8Array>): void { this.node.handle(frame); }
  sqlTools(): ReturnType<DuckDatabaseNode['sqlTools']> { return this.node.sqlTools(); }
  dispose(): void { this.node.dispose(); }
}

export const createDatabase: CreateDatabase = async emit => {
  const { node, stats } = await createDatabaseWith(emit, {}, { parquet: false });
  return new ParquetOnDemand(node, emit, stats.parquet);
};
