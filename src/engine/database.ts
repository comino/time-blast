/**
 * createDatabase: DuckDB-Wasm's blocking API instantiated inside the engine worker. There is
 * no separate DuckDB worker and no RPC: queries run on this thread and Arrow messages come
 * back as return values.
 *
 * Bundle choice mirrors DuckDB's own: the `eh` build (Wasm exceptions) where supported, else
 * `mvp`. Production builds ship the engine gzip-compressed (vite.config.ts) and load it
 * through a Blob URL (src/engine/wasm-asset.ts); dev serves the plain .wasm.
 */
import { BROWSER_RUNTIME, ConsoleLogger, createDuckDB, getPlatformFeatures, LogLevel, type BlockingBindings } from 'duckdb-browser-blocking';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import type { CreateDatabase } from './contracts';
import { DuckDatabaseNode, lockDown, type DatabaseNodeOptions } from './database-node';
import { POLL_INTERVAL_MS } from './limits';
import { fetchEngineWasm } from './wasm-asset';

export interface BootStats {
  bundle: 'eh' | 'mvp';
  version: string;
  /** Fetch + compile + instantiate. */
  instantiateMs: number;
  /** `LOAD parquet` (network fetch from extensions.duckdb.org on a cold cache). */
  parquetMs: number;
  parquet: boolean;
  parquetError?: string;
  totalMs: number;
}

export async function bootDuckDB(): Promise<{ bindings: BlockingBindings; stats: BootStats }> {
  const t0 = performance.now();
  const features = await getPlatformFeatures();
  const bundle = features.wasmExceptions ? 'eh' : 'mvp';
  let url = bundle === 'eh' ? ehWasm : mvpWasm;
  let objectURL: string | undefined;
  let bindings: BlockingBindings;
  try {
    if (import.meta.env.PROD) {
      url = objectURL = URL.createObjectURL(await fetchEngineWasm(`${url}.gz`));
    }
    // Both entries point at the chosen module; createDuckDB applies the same feature test.
    bindings = await createDuckDB({ mvp: { mainModule: url, mainWorker: '' }, eh: { mainModule: url, mainWorker: '' } },
      new ConsoleLogger(LogLevel.WARNING), BROWSER_RUNTIME);
    await bindings.instantiate();
  } finally {
    if (objectURL) URL.revokeObjectURL(objectURL);
  }
  const t1 = performance.now();
  bindings.open({ path: ':memory:', query: { queryPollingInterval: POLL_INTERVAL_MS } });
  const lock = await lockDown(bindings);
  return {
    bindings,
    stats: {
      bundle, version: bindings.getVersion(), instantiateMs: t1 - t0, parquetMs: lock.parquetMs, parquet: lock.parquet,
      ...(lock.error ? { parquetError: lock.error } : {}), totalMs: performance.now() - t0,
    },
  };
}

export function fixtureUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}data/telemetry.parquet`, self.location.origin).href;
}

export async function createDatabaseWith(emit: Parameters<CreateDatabase>[0], options: DatabaseNodeOptions = {}) {
  const { bindings, stats } = await bootDuckDB();
  return { node: new DuckDatabaseNode(bindings, emit, { fixtureUrl, ...options }), stats };
}

export const createDatabase: CreateDatabase = async emit => (await createDatabaseWith(emit)).node;
