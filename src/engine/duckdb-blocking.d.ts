// DuckDB-Wasm 1.32.0 ships a browser build of its blocking (synchronous) API but leaves it
// out of the package `exports` map, and `@duckdb/duckdb-wasm/blocking` resolves browsers to a
// file that does not exist. vite.config.ts aliases `duckdb-browser-blocking` to
// dist/duckdb-browser-blocking.mjs; this declares the part of it the engine uses.
declare module 'duckdb-browser-blocking' {
  import type { DuckDBBundles, DuckDBConfig, Logger, PlatformFeatures, ScriptTokens } from '@duckdb/duckdb-wasm';

  export interface BlockingConnection {
    useUnsafe<R>(callback: (bindings: never, conn: number) => R): R;
    close(): void;
  }
  export interface BlockingBindings {
    instantiate(onProgress?: (progress: unknown) => void): Promise<this>;
    open(config: DuckDBConfig): void;
    getVersion(): string;
    connect(): BlockingConnection;
    tokenize(text: string): ScriptTokens;
    startPendingQuery(conn: number, text: string, allowStreamResult?: boolean): Uint8Array | null;
    pollPendingQuery(conn: number): Uint8Array | null;
    cancelPendingQuery(conn: number): boolean;
    fetchQueryResults(conn: number): Uint8Array | null;
    registerFileBuffer(name: string, buffer: Uint8Array): void;
    registerFileHandle(name: string, handle: Blob, protocol: number, directIO: boolean): void;
    dropFile(name: string): void;
  }
  export const BROWSER_RUNTIME: unknown;
  export function createDuckDB(bundles: DuckDBBundles, logger: Logger, runtime: unknown): Promise<BlockingBindings>;
  export function getPlatformFeatures(): Promise<PlatformFeatures>;
  export { ConsoleLogger, LogLevel, VoidLogger } from '@duckdb/duckdb-wasm';
}
