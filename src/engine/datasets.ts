/**
 * Dataset manifest (`public/data/datasets.json`, contract in docs/plan-batch-3.md) and prebuilt
 * databases (docs/batch-3/cold-start.md). Cold path only.
 *
 * A fixture opens, in order of preference, from
 *   1. `prebuilt`: a DuckDB database file with the tables, the dataset context (statistics) and
 *      the time rollups already built (scripts/build-datasets.mjs). Attached read-only; nothing is
 *      computed in the browser.
 *   2. `tables[].url`: Parquet/CSV files, loaded like dropped files (statistics + rollups in the
 *      browser).
 *   3. a built-in generator (`vessels` only): the synthetic telemetry SQL, so a checkout without
 *      built datasets still runs.
 *
 * Prebuilt files persist across visits in the Cache API, keyed by URL and validated by the
 * server's ETag (one conditional request; a changed file has a new ETag and is refetched).
 */
import type { DatasetContext } from './contracts';

export interface ManifestTable { name: string; url: string; rows?: number }
export interface ManifestEntry {
  name: string;
  title?: string;
  description?: string;
  tables: ManifestTable[];
  /** DuckDB database file with tables, context and rollups (optional). */
  prebuilt?: string;
  license?: string;
  source?: string;
}

/** Prebuilt file metadata table (inside the prebuilt database). One row, one JSON column. */
export const META_TABLE = '__tb_meta';
/** Version of the prebuilt layout this code reads (META_TABLE `format`). */
export const PREBUILT_FORMAT = 1;

/** What scripts/build-datasets.mjs stores in META_TABLE. */
export interface PrebuiltMeta {
  format: number;
  /** DuckDB version that wrote the file (storage compatibility). */
  duckdb: string;
  /** Context without `id` (the browser assigns it per open). */
  context: Omit<DatasetContext, 'id'>;
  /** Rollups present in the file, per table: the grains built, which measures had NULLs, and the
   * spec shape they were built for (database-node.ts specShape). */
  rollups: Array<{ table: string; nulls: Record<string, boolean>; spec?: unknown; grains: Array<{ name: string; rows: number; ms: number }> }>;
  /** The rewrite's function catalog for this DuckDB build with these extensions loaded
   * (`duckdb_functions()` costs 0.2–1.5 s cold in the browser). Used only on a version match. */
  catalog?: { extensions: string[]; aggregates: string[]; forbidden: string[]; volatile: string[] };
  built: string;
}

export function parseManifest(value: unknown): ManifestEntry[] {
  if (!Array.isArray(value)) throw new Error('datasets.json is not a list');
  return value.filter((e): e is ManifestEntry => !!e && typeof e === 'object' && typeof (e as ManifestEntry).name === 'string'
    && Array.isArray((e as ManifestEntry).tables));
}

// ───────────────────────── browser fetching ─────────────────────────

const CACHE_NAME = 'time-blast-datasets-v1';
const ETAG_HEADER = 'x-time-blast-etag';

export interface FetchedBytes { bytes: Uint8Array; source: 'network' | 'cache' | 'revalidated'; ms: number }

/** Fetch a large immutable-until-replaced file once and keep it in the Cache API. A repeat visit
 * sends one conditional request (If-None-Match with the stored ETag): 304 → the stored copy,
 * 200 → the new file replaces it. Without the Cache API (Node, opaque origins) or on any cache
 * error this is a plain fetch. */
export async function fetchPersisted(url: string, fetchImpl: typeof fetch = fetch): Promise<FetchedBytes> {
  const t0 = performance.now();
  let cache: Cache | undefined;
  try { cache = typeof caches === 'undefined' ? undefined : await caches.open(CACHE_NAME); } catch { cache = undefined; }
  const stored = await cache?.match(url).catch(() => undefined);
  const etag = stored?.headers.get(ETAG_HEADER);
  const response = await fetchImpl(url, etag ? { cache: 'no-store', headers: { 'If-None-Match': etag } } : { cache: 'no-store' });
  if (response.status === 304 && stored) {
    return { bytes: new Uint8Array(await stored.arrayBuffer()), source: 'cache', ms: performance.now() - t0 };
  }
  if (!response.ok) throw new Error(`fetch ${url} failed (${response.status})`);
  const buffer = await response.arrayBuffer();
  const tag = response.headers.get('etag');
  if (cache && tag) {
    // Store a copy; the caller's bytes stay usable (registerFileBuffer copies them anyway).
    const headers = new Headers({ 'content-type': 'application/octet-stream', [ETAG_HEADER]: tag });
    void cache.put(url, new Response(buffer.slice(0), { headers })).catch(() => { /* quota: next visit refetches */ });
  }
  return { bytes: new Uint8Array(buffer), source: stored ? 'revalidated' : 'network', ms: performance.now() - t0 };
}
