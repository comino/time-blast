import { afterEach, describe, expect, it, vi } from 'vitest';
import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { DuckDatabaseNode, type DuckBindings } from '../src/engine/database-node';
import { VESSELS_SQL } from '../src/engine/dataset';
import type { DatasetContext } from '../src/engine/contracts';

const eventLoop = vi.hoisted(() => ({ pending: [] as Array<() => void> }));
vi.mock('../src/engine/yield', () => ({
  yieldToEventLoop: () => new Promise<void>(resolve => { eventLoop.pending.push(resolve); }),
}));

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const step = async () => { expect(eventLoop.pending.length).toBeGreaterThan(0); eventLoop.pending.shift()!(); await flush(); };
const previous: DatasetContext = { id: 1, name: 'previous', dialect: 'duckdb',
  tables: [{ name: 'previous_table', rows: 10, columns: [{ name: 'value', type: 'DOUBLE' }] }] };
const isWarm = (sql: string) => sql.startsWith('SELECT count(*), min(');

interface PendingQuery { conn: number; sql: string; pending: boolean; cancelled: boolean }
/** Deterministic connection ownership model. A new query replaces the connection's
 * pending query, so a late cancel would cancel that new query, as in DuckDB. */
class PendingBindings implements DuckBindings {
  readonly queries: PendingQuery[] = [];
  readonly cancellations: string[] = [];
  readonly overlaps: Array<[string, string]> = [];
  private nextConnection = 0;
  private readonly active = new Map<number, PendingQuery>();
  private readonly schema: Uint8Array;
  constructor() {
    const stream = tableToIPC(tableFromArrays({ empty: new Float64Array() }), 'stream');
    this.schema = stream.subarray(0, 8 + new DataView(stream.buffer, stream.byteOffset).getInt32(4, true));
  }
  connect() {
    const conn = ++this.nextConnection;
    return { useUnsafe: <T>(callback: (bindings: never, id: number) => T) => callback(undefined as never, conn), close() {} };
  }
  tokenize() { return { offsets: [0], types: [4] }; }
  registerFileBuffer() {}
  dropFile() {}
  startPendingQuery(conn: number, sql: string): Uint8Array | null {
    const old = this.active.get(conn);
    if (old?.pending && !old.cancelled) this.overlaps.push([old.sql, sql]);
    const query = { conn, sql, pending: isWarm(sql) || sql === VESSELS_SQL, cancelled: false };
    this.queries.push(query); this.active.set(conn, query);
    return query.pending ? null : this.schema;
  }
  pollPendingQuery(conn: number): Uint8Array {
    const query = this.active.get(conn)!;
    if (query.cancelled) throw new Error('query was canceled');
    query.pending = false; return this.schema;
  }
  cancelPendingQuery(conn: number): boolean {
    const query = this.active.get(conn);
    if (!query) return false;
    query.cancelled = true; this.cancellations.push(query.sql); return true;
  }
  fetchQueryResults(): Uint8Array { return new Uint8Array(); }
}

type Lifecycle = { current?: DatasetContext; contextId: number; startLockdown(): void };
const lifecycle = (node: DuckDatabaseNode) => node as unknown as Lifecycle;
afterEach(() => { vi.useRealTimers(); eventLoop.pending.length = 0; });

describe('database load connection lifecycle', () => {
  it('joins the previous warm-up before starting a new source load', async () => {
    vi.useFakeTimers();
    const db = new PendingBindings(), node = new DuckDatabaseNode(db, () => {}, {
      compressed: false, rollups: false, resultCache: false, freshInstance: true, lockdown: async () => {},
    });
    lifecycle(node).current = previous; lifecycle(node).contextId = previous.id;
    lifecycle(node).startLockdown(); await vi.runOnlyPendingTimersAsync(); await flush();
    expect(db.queries.some(q => isWarm(q.sql) && q.pending)).toBe(true);
    const opening = node.open({ kind: 'fixture', name: 'vessels' }, 2);
    await flush();
    try {
      expect(db.queries.some(q => q.sql === VESSELS_SQL)).toBe(false);
      await step(); // The old warm-up observes its invalid token and cancels itself.
      expect(db.cancellations).toHaveLength(1); expect(isWarm(db.cancellations[0])).toBe(true);
      expect(db.queries.some(q => q.sql === VESSELS_SQL)).toBe(true);
      await step(); // The new load is now the sole owner of the load connection.
      await expect(opening).resolves.toMatchObject({ id: 2, name: 'vessels' });
      expect(db.overlaps).toEqual([]);
      expect(db.cancellations.some(sql => sql === VESSELS_SQL)).toBe(false);
    } finally { node.dispose(); void opening.catch(() => {}); }
  });

  it('does not start an old-source warm-up when deferred lockdown finishes during a new load', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const lockdown = new Promise<void>(resolve => { release = resolve; });
    const db = new PendingBindings(), node = new DuckDatabaseNode(db, () => {}, {
      compressed: false, rollups: false, resultCache: false, freshInstance: true, lockdown: () => lockdown,
    });
    lifecycle(node).current = previous; lifecycle(node).contextId = previous.id;
    lifecycle(node).startLockdown(); await vi.runOnlyPendingTimersAsync();
    const opening = node.open({ kind: 'fixture', name: 'vessels' }, 2); await flush();
    try {
      expect(db.queries.some(q => q.sql === VESSELS_SQL && q.pending)).toBe(true);
      release(); await flush();
      expect(db.queries.filter(q => isWarm(q.sql))).toHaveLength(0);
      await step();
      await expect(opening).resolves.toMatchObject({ id: 2, name: 'vessels' });
      expect(db.overlaps).toEqual([]); expect(db.cancellations).toEqual([]);
    } finally { release(); node.dispose(); void opening.catch(() => {}); }
  });
});
