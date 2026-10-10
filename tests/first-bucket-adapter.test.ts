import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tableFromArrays, type RecordBatch } from 'apache-arrow';
import { MAX_RESULT_BYTES, MAX_RESULT_ROWS } from '../src/adapters/arrow';
import type { QueryRequest } from '../src/core/types';

const mock = vi.hoisted(() => ({ connections: [] as any[], streams: [] as any[], failQuery: '' }));
vi.mock('@duckdb/duckdb-wasm', () => ({
  selectBundle: async () => ({ mainModule: 'test.wasm', mainWorker: 'test.worker' }),
  ConsoleLogger: class {}, LogLevel: { WARNING: 2 },
  AsyncDuckDB: class {
    instantiate = vi.fn(async () => {}); terminate = vi.fn(async () => {});
    async connect() {
      const connection = { query: vi.fn(async (sql: string) => { if (sql === mock.failQuery) throw new Error('transaction failed'); }), close: vi.fn(async () => {}),
        cancelSent: vi.fn(async () => true), send: vi.fn(async () => {
          const next = mock.streams.shift();
          if (next instanceof Error) throw next;
          return next;
        }) };
      mock.connections.push(connection); return connection;
    }
  },
}));
import { DuckDBAdapter } from '../src/adapters/duckdb';

function record(length = 1, xBuffer?: ArrayBuffer): RecordBatch {
  const x = xBuffer ? new Float64Array(xBuffer, 0, length) : new Float64Array(length);
  const y = new Float64Array(length).fill(1), series = new Int32Array(length);
  return tableFromArrays({ x, y, series }).batches[0];
}
function reader(records: RecordBatch[], failure?: Error) {
  return { cancel: vi.fn(async () => {}), async *[Symbol.asyncIterator]() {
    yield* records; if (failure) throw failure;
  } };
}
let adapter: DuckDBAdapter, request: QueryRequest;
beforeEach(async () => {
  mock.connections = []; mock.streams = []; mock.failQuery = '';
  vi.stubGlobal('Worker', class { terminate() {} });
  adapter = new DuckDBAdapter('large');
  const context = await adapter.prepare();
  request = { id: 'one-logical-query', sql: 'logical SQL', context, priority: 'committed', signal: new AbortController().signal,
    plan: { metric: 'speed', aggregate: 'avg', bucketMinutes: 1, windowHours: 168, splitByVessel: true, vessel: null, view: 'line' },
    firstBucket: { kind: 'first-complete-bucket', sql: 'logical SQL', firstSql: 'prefix SQL', remainderSql: 'remainder SQL',
      contextId: context.id, start: context.start, end: context.end } };
});
afterEach(async () => { await adapter.dispose(); vi.unstubAllGlobals(); });
const consume = async (input = request) => { const batches = []; for await (const batch of adapter.execute(input)) batches.push(batch); return batches; };

describe('one local request with a first complete bucket', () => {
  it('uses one connection and read-only snapshot, borrowing both producers without rewriting logical identity', async () => {
    const first = record(), rest = record(2), a = reader([first]), b = reader([rest]);
    mock.streams.push(a, b);
    const before = { ...request };
    const batches = await consume();
    expect(request).toEqual(before);
    expect(mock.connections).toHaveLength(2); // initialization, then one query
    const connection = mock.connections[1];
    expect(connection.query.mock.calls).toEqual([['BEGIN TRANSACTION READ ONLY'], ['COMMIT']]);
    expect(connection.send.mock.calls).toEqual([['prefix SQL', true], ['remainder SQL', true]]);
    expect(connection.cancelSent).not.toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalledOnce();
    expect(a.cancel).toHaveBeenCalledOnce(); expect(b.cancel).toHaveBeenCalledOnce();
    expect(batches.map(batch => batch.owner)).toEqual([first, rest]);
    expect(batches[0].x.buffer).toBe(first.getChild('x')!.data[0].values.buffer);
    expect(batches[1].y.buffer).toBe(rest.getChild('y')!.data[0].values.buffer);
  });
  it('continues after an empty prefix without inventing a point', async () => {
    mock.streams.push(reader([]), reader([record(2)]));
    expect((await consume()).map(batch => batch.length)).toEqual([2]);
    expect(mock.connections[1].send).toHaveBeenCalledTimes(2);
  });
  it('keeps baseline and one-bucket fallback to one statement without extra transaction calls', async () => {
    mock.streams.push(reader([record()]));
    await consume({ ...request, firstBucket: undefined });
    expect(mock.connections[1].query).not.toHaveBeenCalled();
    expect(mock.connections[1].send.mock.calls).toEqual([['logical SQL', true]]);
  });
  it('fails closed if a read-only transaction cannot start', async () => {
    mock.failQuery = 'BEGIN TRANSACTION READ ONLY';
    await expect(consume()).rejects.toThrow('transaction failed');
    expect(mock.connections[1].send).not.toHaveBeenCalled();
    expect(mock.connections[1].close).toHaveBeenCalledOnce();
  });
  it('does not report completion when the snapshot commit fails after both result streams', async () => {
    mock.failQuery = 'COMMIT'; mock.streams.push(reader([record()]), reader([record()]));
    await expect(consume()).rejects.toThrow('transaction failed');
    expect(mock.connections[1].query.mock.calls).toEqual([['BEGIN TRANSACTION READ ONLY'], ['COMMIT'], ['ROLLBACK']]);
    expect(mock.connections[1].close).toHaveBeenCalledOnce();
  });
  it.each(['sql', 'contextId', 'start', 'end'] as const)('rejects stale or mismatched metadata (%s) before opening a connection', async field => {
    const firstBucket = { ...request.firstBucket!, [field]: field === 'start' || field === 'end' ? 0 : 'changed' };
    await expect(consume({ ...request, firstBucket })).rejects.toThrow('does not match');
    expect(mock.connections).toHaveLength(1);
  });
  it('requires the complete owned context, not only a matching ID', async () => {
    for (const context of [{ ...request.context, rowCount: 1 }, { ...request.context, start: 0 },
      { ...request.context, vessels: [...request.context.vessels].reverse() }]) {
      await expect(consume({ ...request, context })).rejects.toThrow('does not match');
    }
    expect(mock.connections).toHaveLength(1);
  });
  it.each(['send', 'stream'])('reports a remainder %s failure after a partial prefix and rolls back', async phase => {
    const failure = new Error('remainder failed');
    mock.streams.push(reader([record()]), phase === 'send' ? failure : reader([], failure));
    const iterator = adapter.execute(request);
    expect((await iterator.next()).value?.length).toBe(1);
    await expect(iterator.next()).rejects.toThrow('remainder failed');
    const connection = mock.connections[1];
    expect(connection.query.mock.calls).toEqual([['BEGIN TRANSACTION READ ONLY'], ['ROLLBACK']]);
    expect(connection.cancelSent).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
  });
  it.each(['abort', 'return'] as const)('skips remainder on consumer %s and keeps cancellation scoped to the old connection', async kind => {
    const controller = new AbortController(); mock.streams.push(reader([record()]));
    const iterator = adapter.execute({ ...request, signal: controller.signal });
    await iterator.next();
    if (kind === 'abort') { controller.abort(); await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' }); }
    else await iterator.return(undefined);
    const old = mock.connections[1];
    expect(old.send).toHaveBeenCalledOnce(); expect(old.cancelSent).toHaveBeenCalledOnce();
    expect(old.query.mock.calls).toEqual([['BEGIN TRANSACTION READ ONLY'], ['ROLLBACK']]);
    mock.streams.push(reader([record()]));
    await consume({ ...request, firstBucket: undefined });
    controller.abort();
    expect(mock.connections[2].cancelSent).not.toHaveBeenCalled();
  });
  it('checks cancellation in the gap between exhausted prefix and the remainder', async () => {
    const controller = new AbortController(), prefix = reader([record()]);
    prefix.cancel.mockImplementation(async () => { controller.abort(); }); mock.streams.push(prefix);
    const iterator = adapter.execute({ ...request, signal: controller.signal });
    await iterator.next();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.connections[1].send).toHaveBeenCalledOnce();
  });
  it('keeps the admission gate until both phases finish', async () => {
    mock.streams.push(reader([record()]), reader([record()]), reader([record()]));
    const active = adapter.execute(request); await active.next();
    const queued = adapter.execute({ ...request, id: 'queued', firstBucket: undefined });
    const next = queued.next(); await Promise.resolve(); await Promise.resolve();
    expect(mock.connections).toHaveLength(2);
    await expect(consume({ ...request, id: 'third' })).rejects.toThrow('queue is full');
    await active.next(); await active.next();
    expect((await next).value?.length).toBe(1); await queued.next();
    expect(mock.connections).toHaveLength(3);
  });
  it('shares the row budget across both statements', async () => {
    const batch = record(Math.floor(MAX_RESULT_ROWS / 2) + 1);
    mock.streams.push(reader([batch]), reader([batch]));
    const iterator = adapter.execute(request); await iterator.next();
    await expect(iterator.next()).rejects.toThrow('result budget');
    expect(mock.connections[1].query).toHaveBeenLastCalledWith('ROLLBACK');
  });
  it.each([false, true])('counts retained allocations across statements once (same buffer: %s)', async shared => {
    const allocation = new ArrayBuffer(MAX_RESULT_BYTES / 2 + 8);
    const first = record(1, allocation), rest = record(1, shared ? allocation : new ArrayBuffer(allocation.byteLength));
    mock.streams.push(reader([first]), reader([rest]));
    if (shared) expect(await consume()).toHaveLength(2);
    else await expect(consume()).rejects.toThrow('result budget');
  });
});
