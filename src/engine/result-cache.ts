/**
 * Exact result reuse across keystrokes: completed results of recent SQL, replayed when the same
 * statement is executed again on the same dataset. Per-keystroke translation often returns to an
 * earlier SQL (typing on after a detour, backspacing, a commit of text shown earlier in another
 * slot); the coordinator only dedups against the request bound to the live slot.
 *
 * Exactness: the data is immutable between dataset opens (`clear()` on every open), the key is
 * the statement text, and statements whose result can change between executions (wall clock,
 * random, sequences) are never stored. Entries hold the decoded Arrow objects the first
 * execution emitted (views into DuckDB's message copies, which nothing mutates); a hit replays
 * them without touching DuckDB. Bounded by bytes and entries, least recently used evicted.
 */
import type { RecordBatch, Schema } from 'apache-arrow';

export interface CachedResult { schema: Schema; batches: RecordBatch[]; rows: number; bytes: number }

export interface ResultCacheOptions { maxBytes: number; maxEntryBytes: number; maxEntries: number }
export const DEFAULT_RESULT_CACHE: ResultCacheOptions = Object.freeze({ maxBytes: 24 * 1024 * 1024, maxEntryBytes: 8 * 1024 * 1024, maxEntries: 64 });

/** Functions whose value is not a function of the data: such statements are never cached.
 * Lower-case; matched as words in the statement text (conservative: a column of that name also
 * disables caching). Extended at runtime from duckdb_functions() stability. */
export const NON_DETERMINISTIC = new Set([
  'now', 'current_timestamp', 'current_date', 'current_time', 'localtime', 'localtimestamp', 'today',
  'get_current_timestamp', 'get_current_time', 'transaction_timestamp', 'random', 'setseed', 'uuid', 'gen_random_uuid',
  'uuidv4', 'uuidv7', 'nextval', 'currval', 'current_query', 'current_query_id', 'current_transaction_id', 'current_connection_id',
]);

/** Cache key: the statement without leading comments (e.g. a `-- view:` hint) and outer whitespace. */
export function cacheKey(sql: string): string {
  let s = sql;
  for (;;) {
    const t = s.trimStart();
    if (t.startsWith('--')) { const nl = t.indexOf('\n'); s = nl < 0 ? '' : t.slice(nl + 1); continue; }
    if (t.startsWith('/*')) { const end = t.indexOf('*/'); if (end < 0) return sql.trim(); s = t.slice(end + 2); continue; }
    return t.trimEnd();
  }
}

export class ResultCache {
  private readonly entries = new Map<string, CachedResult>();
  private bytes = 0;
  hits = 0;
  misses = 0;
  constructor(readonly options: ResultCacheOptions = DEFAULT_RESULT_CACHE, readonly volatile: Set<string> = new Set(NON_DETERMINISTIC)) {}

  /** Whether a statement may be cached at all. */
  cacheable(key: string): boolean {
    for (const word of key.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []) if (this.volatile.has(word)) return false;
    return true;
  }

  get(key: string): CachedResult | undefined {
    const entry = this.entries.get(key);
    if (!entry) { this.misses++; return undefined; }
    this.entries.delete(key); this.entries.set(key, entry); // most recent last
    this.hits++;
    return entry;
  }

  /** Store a completed result. Returns false if it was too large or not cacheable. */
  set(key: string, result: CachedResult): boolean {
    if (result.bytes > this.options.maxEntryBytes || !this.cacheable(key)) return false;
    const old = this.entries.get(key);
    if (old) { this.bytes -= old.bytes; this.entries.delete(key); }
    this.entries.set(key, result);
    this.bytes += result.bytes;
    for (const [k, v] of this.entries) {
      if (this.bytes <= this.options.maxBytes && this.entries.size <= this.options.maxEntries) break;
      this.entries.delete(k); this.bytes -= v.bytes;
    }
    return true;
  }

  clear(): void { this.entries.clear(); this.bytes = 0; }
  get size(): { entries: number; bytes: number } { return { entries: this.entries.size, bytes: this.bytes }; }
}
