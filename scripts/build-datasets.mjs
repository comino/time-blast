#!/usr/bin/env node
// Build prebuilt DuckDB databases for public/data/datasets.json (docs/batch-3/cold-start.md).
//
//   node scripts/build-datasets.mjs [--only vessels] [--public public] [--duckdb path] [--fetch-duckdb]
//
// For every manifest entry with a `prebuilt` path: loads the entry with the browser's own
// database node on DuckDB-Wasm's node-blocking bundle (tables from `tables[].url`, or the built-in
// generator for `vessels`), computes the dataset context and the rollup specs, then the DuckDB CLI
// of the engine's version (v1.4.3) writes one DuckDB file with tables, rollups and a metadata row
// (`__tb_rollup.__tb_meta`); the file is read back with DuckDB-Wasm and compared. Tables that were
// generated are also written to their Parquet `url`. Outputs are build artifacts (.gitignore); run
// this before `pnpm build` when deploying. Needs extensions.duckdb.org (json/parquet extensions)
// and the CLI: on PATH, $DUCKDB_CLI, --duckdb, or --fetch-duckdb (official release, SHA-256 pinned,
// cached in .cache/).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const publicDir = resolve(root, option('--public', 'public'));
const only = option('--only');
const { module: lib } = await runnerImport(resolve(root, 'scripts/build-datasets-lib.ts'), { root, configFile: false, logLevel: 'error' });
// The engine yields through an unref'd MessageChannel; keep Node alive while it works.
const keepAlive = setInterval(() => {}, 1000);
const log = (...a) => console.error(...a);

const cli = await lib.duckdbCli(resolve(root, '.cache'), { explicit: option('--duckdb'), fetch: args.includes('--fetch-duckdb') });
log(`DuckDB CLI: ${cli}`);
const entries = lib.readManifest(publicDir).filter(e => e.prebuilt && (!only || e.name === only));
if (!entries.length) log('nothing to build (no manifest entry with `prebuilt`)');
const results = [];
for (const entry of entries) {
  log(`building ${entry.name} → ${entry.prebuilt}`);
  const result = await lib.buildEntry(entry, publicDir, cli, log);
  log(`  ${(result.bytes / 1048576).toFixed(1)} MiB (gzip -9 ${(result.gzipBytes / 1048576).toFixed(1)} MiB), sha256 ${result.sha256.slice(0, 16)}…, ${(result.ms / 1000).toFixed(1)} s`);
  results.push(result);
}
console.log(JSON.stringify(results, null, 1));
clearInterval(keepAlive);
