/**
 * Manifest fixtures and prebuilt databases (docs/batch-3/cold-start.md) on DuckDB-Wasm's
 * node-blocking bundle. The prebuilt case needs `node scripts/build-datasets.mjs` to have run
 * (public/data/vessels/vessels.duckdb); it is skipped otherwise. Full exactness over the corpus:
 * `node scripts/bench-database.mjs --load prebuilt`.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RecordBatch } from 'apache-arrow';
import { DuckDatabaseNode, lockDown, type DuckBindings, type ExecStats } from '../src/engine/database-node';
import type { LocalFrame } from '../src/engine/contracts';
import type { ManifestEntry } from '../src/engine/datasets';
import { header, Kind, text } from '../src/protocol/frame';

const require = createRequire(import.meta.url);
const dist = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs').replace(/[^/]+$/, '');
const publicDir = new URL('../public/', import.meta.url).pathname;
const prebuiltFile = join(publicDir, 'data/vessels/vessels.duckdb');

async function bindings(): Promise<DuckBindings> {
  const duck = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
  const db = await duck.createDuckDB({
    mvp: { mainModule: `${dist}duckdb-mvp.wasm`, mainWorker: '' },
    eh: { mainModule: `${dist}duckdb-eh.wasm`, mainWorker: '' },
  }, new duck.VoidLogger(), duck.NODE_RUNTIME);
  await db.instantiate();
  db.open({ query: { queryPollingInterval: 4 } });
  await lockDown(db, { parquet: false });
  return db;
}

function node(db: DuckBindings, manifest: ManifestEntry[], extra: ConstructorParameters<typeof DuckDatabaseNode>[2] = {}) {
  const frames: LocalFrame[] = [], stats: ExecStats[] = [];
  const n = new DuckDatabaseNode(db, f => frames.push(f), {
    manifest: async () => manifest, dataUrl: p => join(publicDir, p), fetchBytes: async p => new Uint8Array(readFileSync(p)),
    extensions: ['json'], onExecStats: s => stats.push(s), ...extra,
  });
  const run = async (sql: string, request: number, context: number) => {
    const before = stats.length;
    n.handle({ ...header(Kind.EXEC, { request, epoch: 1, context, revision: request }), stamps: [], payload: text(sql) });
    for (let i = 0; i < 5000 && stats.length === before; i++) await new Promise(r => setTimeout(r, 2));
    const rows = frames.filter(f => f.kind === Kind.BATCH && f.request === request).reduce((s, f) => s + (f.payload as RecordBatch).numRows, 0);
    return { stats: stats[stats.length - 1], rows };
  };
  return { node: n, frames, run };
}

describe('manifest fixtures', () => {
  let db: DuckBindings;
  beforeAll(async () => { db = await bindings(); }, 120_000);

  it('loads a manifest entry from its table files when there is no prebuilt file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-manifest-'));
    writeFileSync(join(dir, 'm.csv'), 'ts,v\n2026-09-01 00:00:00,1\n2026-09-01 00:01:00,2\n');
    const { node: n } = node(db, [{ name: 'tiny', description: 'tiny test', tables: [{ name: 'measurements', url: join(dir, 'm.csv') }], prebuilt: join(dir, 'missing.duckdb') }],
      { dataUrl: p => p });
    const context = await n.open({ kind: 'fixture', name: 'tiny' }, 3);
    expect(context).toMatchObject({ id: 3, name: 'tiny', description: 'tiny test', tables: [{ name: 'measurements', rows: 2 }] });
    n.dispose();
  }, 120_000);

  it.skipIf(!existsSync(prebuiltFile))('opens the prebuilt vessels database with its context and rollups, nothing computed', async () => {
    const manifest = JSON.parse(readFileSync(join(publicDir, 'data/datasets.json'), 'utf8')) as ManifestEntry[];
    const opens: Array<{ statisticsMs: number }> = [];
    const { node: n, run } = node(db, manifest, { onOpenStats: s => opens.push(s) });
    const t0 = performance.now();
    const context = await n.open({ kind: 'fixture', name: 'vessels' }, 5);
    console.log(`[engine-prebuilt] open ${(performance.now() - t0).toFixed(0)} ms (Node)`);
    expect(opens[0].statisticsMs).toBe(0);
    expect(context.tables[0]).toMatchObject({ name: 'telemetry', rows: 1_209_600 });
    expect(context.tables[0].columns.find(c => c.name === 'vessel')?.values).toHaveLength(6);
    expect(n.rollups.flatMap(r => r.grains.map(g => g.grain.name))).toEqual(['minute', 'hour', 'day']);
    const hourly = await run("SELECT date_trunc('hour', ts) AS hour, vessel, avg(speed) AS speed FROM telemetry GROUP BY 1, 2 ORDER BY 1, 2", 1, 5);
    expect(hourly.stats).toMatchObject({ outcome: 'done', source: 'rollup' });
    expect(hourly.rows).toBe(14 * 24 * 6);
    const raw = await run('SELECT count(*) AS n, max(wind) AS w FROM telemetry WHERE wind > 30', 2, 5);
    expect(raw.stats.outcome).toBe('done');
    // Back to an in-memory dataset: the prebuilt catalog is detached.
    const again = await n.open({ kind: 'file', name: 'm', file: new File(['a\n1\n'], 'm.csv') }, 6);
    expect(again.tables.map(t => t.name)).toEqual(['m']);
    n.dispose();
  }, 300_000);
});
