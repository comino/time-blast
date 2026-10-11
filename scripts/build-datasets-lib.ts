/**
 * Prebuilt databases for the dataset manifest (docs/batch-3/cold-start.md).
 *
 * 1. The browser's own database node, on DuckDB-Wasm's node-blocking bundle (the same engine
 *    build as the page), loads the entry exactly as the browser would without a prebuilt file:
 *    tables, dataset context (statistics), rollup specs and the function catalog. That metadata is
 *    therefore identical to what the browser would compute.
 * 2. The DuckDB CLI of the same version writes the database file: tables from Parquet, rollups
 *    with the same `buildSql` statements, one metadata row. DuckDB-Wasm cannot write it: its file
 *    system ignores write offsets during checkpoints (the database header lands at the end of the
 *    file; measured with 1.32.0 / DuckDB 1.4.3), so the file is unreadable.
 * 3. The file is read back the way the browser reads it (registered buffer, ATTACH READ_ONLY in
 *    DuckDB-Wasm) and compared with the in-memory load: row counts and an order-independent hash
 *    of every raw table, row counts of every rollup.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { gzipSync, inflateRawSync } from 'node:zlib';
import {
  CATALOG_SQL, catalogFrom, DATA_CATALOG, DuckDatabaseNode, META_SQL_NAME, specShape, type DuckBindings, type RollupStats,
} from '../src/engine/database-node';
import { parseManifest, PREBUILT_FORMAT, type ManifestEntry, type PrebuiltMeta } from '../src/engine/datasets';
import { quoteIdent, quoteLiteral } from '../src/engine/dataset';
import { buildSql, ROLLUP_SCHEMA, rollupTableName } from '../src/engine/rollup';
import type { DatasetContext } from '../src/engine/contracts';

type Bindings = DuckBindings & { open(config: object): void; connect(): { query(sql: string): { toArray(): Array<{ toJSON(): Record<string, unknown> }> }; close(): void } };

/** The DuckDB CLI matching the DuckDB-Wasm build (`SELECT version()` there). */
export const CLI_VERSION = 'v1.4.3';
const CLI_ZIPS: Record<string, string> = {
  'linux-arm64': '6893c384ecd182bce637e18a715f750e8c79b8650504f5d61865c702ee523d9a',
  'linux-amd64': '7a9e36141a71a353f54dfbeed607a5218c3425ce2d417610da08443259a12f7c',
  'osx-universal': 'f44e488b1c67d007b6b12af9f1ad9122fad0f63a606caf2bfb10ca945042a3f6',
};

export async function bindings(): Promise<Bindings> {
  const require = createRequire(import.meta.url);
  const bundle = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
  const dist = bundle.replace(/[^/]+$/, '');
  const duck = require(bundle);
  const db = await duck.createDuckDB({
    mvp: { mainModule: `${dist}duckdb-mvp.wasm`, mainWorker: '' },
    eh: { mainModule: `${dist}duckdb-eh.wasm`, mainWorker: '' },
  }, new duck.VoidLogger(), duck.NODE_RUNTIME);
  await db.instantiate();
  db.open({ query: { queryPollingInterval: 50 } });
  return db as Bindings;
}

function rows(db: Bindings, sql: string): unknown[][] {
  const conn = db.connect();
  try {
    return conn.query(sql).toArray().map(r => Object.values(r.toJSON()).map(v => typeof v === 'bigint' ? Number(v) : v));
  } finally {
    conn.close();
  }
}

export function readManifest(publicDir: string): ManifestEntry[] {
  return parseManifest(JSON.parse(readFileSync(resolve(publicDir, 'data/datasets.json'), 'utf8')));
}

/** Path of a DuckDB CLI of CLI_VERSION: `explicit`, `$DUCKDB_CLI`, `duckdb` on PATH, the cache, or
 * (with `fetch`) the official release zip, verified against its pinned SHA-256. */
export async function duckdbCli(cacheDir: string, { explicit, fetch: allowFetch = false }: { explicit?: string; fetch?: boolean } = {}): Promise<string> {
  const version = (bin: string) => {
    const out = spawnSync(bin, ['-version'], { encoding: 'utf8' });
    return out.status === 0 ? out.stdout.trim().split(/\s+/)[0] : undefined;
  };
  const cached = resolve(cacheDir, `duckdb-cli-${CLI_VERSION}`, 'duckdb');
  for (const candidate of [explicit, process.env.DUCKDB_CLI, 'duckdb', cached]) {
    if (!candidate) continue;
    const v = version(candidate);
    if (v === CLI_VERSION) return candidate;
    if (v && candidate === explicit) throw new Error(`${candidate} is DuckDB ${v}; prebuilt files must be written by ${CLI_VERSION} (the DuckDB-Wasm engine's version)`);
  }
  const target = platform() === 'darwin' ? 'osx-universal' : `linux-${arch() === 'arm64' ? 'arm64' : 'amd64'}`;
  if (!allowFetch) throw new Error(`DuckDB CLI ${CLI_VERSION} not found. Install it, set DUCKDB_CLI, or pass --fetch-duckdb to download duckdb_cli-${target}.zip from github.com/duckdb/duckdb (SHA-256 pinned).`);
  const url = `https://github.com/duckdb/duckdb/releases/download/${CLI_VERSION}/duckdb_cli-${target}.zip`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const zip = Buffer.from(await response.arrayBuffer());
  const sha = createHash('sha256').update(zip).digest('hex');
  if (sha !== CLI_ZIPS[target]) throw new Error(`${url}: SHA-256 ${sha} does not match the pinned ${CLI_ZIPS[target]}`);
  // A single deflated entry: local file header (30 bytes + name + extra), then the data.
  if (zip.readUInt32LE(0) !== 0x04034b50) throw new Error('unexpected zip layout');
  const method = zip.readUInt16LE(8), size = zip.readUInt32LE(18), nameLength = zip.readUInt16LE(26), extraLength = zip.readUInt16LE(28);
  const start = 30 + nameLength + extraLength;
  const data = method === 8 ? inflateRawSync(zip.subarray(start, start + size)) : zip.subarray(start, start + size);
  mkdirSync(dirname(cached), { recursive: true });
  writeFileSync(`${cached}.tmp`, data);
  chmodSync(`${cached}.tmp`, 0o755);
  renameSync(`${cached}.tmp`, cached);
  if (version(cached) !== CLI_VERSION) throw new Error(`${cached} does not run`);
  return cached;
}

export interface BuildResult {
  name: string; file: string; bytes: number; gzipBytes: number; sha256: string;
  tables: Array<{ name: string; rows: number }>; rollups: Array<{ table: string; grains: string[] }>;
  parquet: string[]; ms: number;
}

/** Order-independent content hash of a table (DuckDB `hash` over all columns). */
const contentHash = (table: string) => `SELECT count(*)::BIGINT, bit_xor(hash(COLUMNS(*)))::VARCHAR FROM ${table}`;

/** Build `entry.prebuilt` (and, for generated tables, their Parquet files) under `publicDir`. */
export async function buildEntry(entry: ManifestEntry, publicDir: string, cli: string, log: (...a: unknown[]) => void = () => {}): Promise<BuildResult> {
  if (!entry.prebuilt) throw new Error(`${entry.name}: no prebuilt path in the manifest`);
  const t0 = performance.now();
  const db = await bindings();
  const extensions: string[] = [];
  // json: the function catalog stored in the file must match the browser's (json loaded at boot).
  // parquet: reading Parquet tables and writing generated ones.
  for (const ext of ['json', 'parquet']) {
    try { rows(db, `LOAD ${ext}`); extensions.push(ext); } catch (e) { log(`  ${ext} extension unavailable: ${(e as Error).message.slice(0, 120)}`); }
  }
  if (!extensions.includes('parquet')) throw new Error('the parquet extension is required to build (extensions.duckdb.org)');
  const file = (path: string) => resolve(publicDir, path);
  const rollupStats: RollupStats[] = [];
  let rollupsDone!: () => void;
  const done = new Promise<void>(r => { rollupsDone = r; });
  const node = new DuckDatabaseNode(db, () => {}, {
    manifest: async () => [entry],
    dataUrl: path => file(path),
    fetchBytes: async path => new Uint8Array(readFileSync(path)),
    prebuilt: false,
    resultCache: false,
    onRollupStats: s => { rollupStats.push(s); if (s.done) rollupsDone(); },
  });
  const context = await node.open({ kind: 'fixture', name: entry.name }, 1);
  await done;
  const failed = rollupStats.find(s => s.done && s.skipped);
  if (failed) log(`  rollups: ${failed.skipped}`);
  log(`  loaded ${context.tables.map(t => `${t.name} ${t.rows} rows`).join(', ')}; rollups ${node.rollups.map(r => `${r.spec.table}:${r.grains.map(g => g.grain.name)}`).join(' ')}`);

  // Every table as Parquet for the CLI: the manifest's file when it is Parquet; generated tables are
  // written to their `url` (kept: the Parquet path of the manifest); anything else to a temporary file.
  const parquet: string[] = [];
  const sources = new Map<string, string>();
  const temporary: string[] = [];
  for (const table of context.tables) {
    const listed = entry.tables.find(t => t.name === table.name);
    const target = listed && /\.parquet$/i.test(listed.url) ? file(listed.url) : file(`data/.build-${entry.name}-${table.name}.parquet`);
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${process.pid}`;
      rows(db, `COPY (SELECT * FROM ${DATA_CATALOG}.main.${quoteIdent(table.name)}) TO ${quoteLiteral(tmp)} (FORMAT parquet, COMPRESSION zstd)`);
      renameSync(tmp, target);
      if (listed && target === file(listed.url)) { parquet.push(listed.url); log(`  wrote ${listed.url} (${statSync(target).size} bytes)`); } else temporary.push(target);
    }
    sources.set(table.name, target);
  }

  const catalog = catalogFrom(rows(db, CATALOG_SQL) as Array<[string, string, string | null]>);
  const { id: _id, ...stored } = context as DatasetContext;
  const meta: PrebuiltMeta = {
    format: PREBUILT_FORMAT,
    duckdb: String(rows(db, 'SELECT version()')[0][0]),
    context: stored,
    rollups: node.rollups.map(r => ({
      table: r.spec.table,
      nulls: Object.fromEntries(r.spec.measures.map(m => [m.name, m.nulls])),
      spec: specShape(r.spec),
      grains: r.grains.map(g => ({ name: g.grain.name, rows: g.rows, ms: Math.round(g.ms) })),
    })),
    catalog: { extensions, ...catalog },
    built: new Date().toISOString(),
  };
  if (meta.duckdb !== CLI_VERSION) throw new Error(`DuckDB-Wasm is ${meta.duckdb}, the CLI ${CLI_VERSION}: update CLI_VERSION and the pinned hashes`);
  const expected = new Map<string, unknown[]>();
  for (const t of context.tables) expected.set(t.name, rows(db, contentHash(`${DATA_CATALOG}.main.${quoteIdent(t.name)}`))[0]);
  const rollupRows = new Map(node.rollups.flatMap(r => r.grains.map(g => [rollupTableName(r.spec, g.grain), g.rows] as const)));

  // The CLI writes the file: same statements as the browser (raw tables from Parquet, preserving
  // row order; rollups via rollup.ts buildSql), single-threaded like DuckDB-Wasm.
  const target = file(entry.prebuilt);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  rmSync(tmp, { force: true }); rmSync(`${tmp}.wal`, { force: true });
  const script = [
    'SET threads = 1;', 'SET preserve_insertion_order = true;',
    ...context.tables.map(t => `CREATE TABLE ${quoteIdent(t.name)} AS SELECT * FROM read_parquet(${quoteLiteral(sources.get(t.name)!)});`),
    `CREATE SCHEMA ${quoteIdent(ROLLUP_SCHEMA)};`,
    ...node.rollups.flatMap(r => r.grains.map((g, i) => `${buildSql(r.spec, g.grain, i ? r.grains[i - 1].grain : undefined)};`)),
    `CREATE TABLE ${META_SQL_NAME} AS SELECT ${quoteLiteral(JSON.stringify(meta))} AS meta;`,
    'CHECKPOINT;',
  ].join('\n');
  const run = spawnSync(cli, ['-bail', '-batch', tmp], { input: script, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (run.status !== 0) throw new Error(`duckdb CLI failed (${run.status}): ${(run.stderr || run.stdout).slice(0, 2000)}`);
  node.dispose();
  for (const path of temporary) rmSync(path, { force: true });

  // Read it back the way the browser does (registered buffer, attached read-only) and compare.
  const bytes = new Uint8Array(readFileSync(tmp));
  const check = await bindings();
  check.registerFileBuffer('/check.duckdb', bytes);
  rows(check, `ATTACH '/check.duckdb' AS c (READ_ONLY)`);
  for (const t of context.tables) {
    const got = rows(check, contentHash(`c.main.${quoteIdent(t.name)}`))[0];
    if (JSON.stringify(got) !== JSON.stringify(expected.get(t.name))) throw new Error(`${entry.name}: ${t.name} differs in the file (${got}) from the in-memory load (${expected.get(t.name)})`);
  }
  for (const [table, n] of rollupRows) {
    const [[got]] = rows(check, `SELECT count(*) FROM c.${table}`);
    if (Number(got) !== n) throw new Error(`${entry.name}: rollup ${table} has ${got} rows in the file, ${n} in memory`);
  }
  const [[text]] = rows(check, `SELECT meta FROM c.${META_SQL_NAME}`);
  if ((JSON.parse(String(text)) as PrebuiltMeta).format !== PREBUILT_FORMAT) throw new Error('meta row unreadable');
  rmSync(`${tmp}.wal`, { force: true });
  renameSync(tmp, target);
  return {
    name: entry.name, file: entry.prebuilt, bytes: bytes.byteLength, gzipBytes: gzipSync(bytes, { level: 9 }).byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    tables: context.tables.map(t => ({ name: t.name, rows: t.rows })),
    rollups: meta.rollups.map(r => ({ table: r.table, grains: r.grains.map(g => g.name) })),
    parquet, ms: Math.round(performance.now() - t0),
  };
}
