import { afterEach, describe, expect, it, vi } from 'vitest';
import { Float64, Int32, Table, tableFromArrays, tableToIPC, vectorFromArray } from 'apache-arrow';
import { QueryGate, retainArrowBatch } from '../src/adapters/arrow';
import { RemoteDatabaseAdapter, VerifiedArrowSource, parseDatasetContext } from '../src/adapters/remote-database';
import type { DatasetContext, QueryRequest } from '../src/core/types';

const context: DatasetContext = {
  id: 'fixture-v1', label: 'Test data', rowCount: 3, start: 0, end: 60_000,
  vessels: ['A', 'B'], description: 'Synthetic test fixture',
};
const fixture = () => tableFromArrays({
  x: new Float64Array([1000, 2000, 3000]), y: new Float64Array([4, 5, 6]),
  series: new Int32Array([0, 1, 0]), lat: new Float64Array([40, 41, 42]), lon: new Float64Array([-50, -51, -52]),
});
const request = (signal = new AbortController().signal): QueryRequest => ({
  id: 'query-test', sql: 'SELECT x, y, series FROM test', context, signal, priority: 'committed',
  plan: { metric: 'speed', aggregate: 'avg', bucketMinutes: 1, windowHours: 1, splitByVessel: true, vessel: null, view: 'line' },
});
const eos = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]);
function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('retained numeric Arrow batches', () => {
  it('retains producer buffers and sliced offsets without row materialization', () => {
    const source = fixture().batches[0];
    const sliced = source.slice(1, 3);
    const batch = retainArrowBatch(sliced, 2);
    expect(batch.length).toBe(2);
    expect([...batch.x]).toEqual([2000, 3000]);
    expect([...batch.y]).toEqual([5, 6]);
    expect(batch.x.buffer).toBe(source.getChild('x')!.data[0].values.buffer);
    expect(batch.x.byteOffset).toBe(source.getChild('x')!.data[0].values.byteOffset + 8);
    expect(batch.series.buffer).toBe(source.getChild('series')!.data[0].values.buffer);
    expect(batch.owner).toBe(sliced);
    expect(batch.byteLength).toBe(2 * (8 + 8 + 4 + 8 + 8));
  });

  it('fails closed on nulls instead of converting them to zero', () => {
    const table = new Table({ x: vectorFromArray([1000, 2000], new Float64()),
      y: vectorFromArray([2, null], new Float64()), series: vectorFromArray([0, 0], new Int32()) });
    expect(() => retainArrowBatch(table.batches[0])).toThrow('contains nulls');
  });

  it('rejects lossy/incorrect numeric types, identities, and nonfinite values', () => {
    expect(() => retainArrowBatch(tableFromArrays({ x: new Float32Array([1000]), y: new Float64Array([2]), series: new Int32Array([0]) }).batches[0])).toThrow('Float64');
    expect(() => retainArrowBatch(tableFromArrays({ x: new Float64Array([1000]), y: new Float64Array([NaN]), series: new Int32Array([0]) }).batches[0])).toThrow('invalid timestamp or value');
    expect(() => retainArrowBatch(fixture().batches[0], 1)).toThrow('invalid vessel identity');
  });
});

describe('single-query admission', () => {
  it('bounds the queue and isolates a canceled waiter from active work', async () => {
    const gate = new QueryGate();
    const active = await gate.acquire(new AbortController().signal);
    const abort = new AbortController();
    const waiting = gate.acquire(abort.signal);
    const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(gate.acquire(new AbortController().signal)).rejects.toThrow('queue is full');
    abort.abort(); await rejected;
    const replacement = gate.acquire(new AbortController().signal);
    active(); active(); // A stale double release must not release the next request.
    const nextRelease = await replacement;
    const last = gate.acquire(new AbortController().signal);
    await expect(gate.acquire(new AbortController().signal)).rejects.toThrow('queue is full');
    nextRelease(); (await last)();
  });
});

describe('remote terminal verification', () => {
  it('passes chunks through unchanged and validates an EOS split across reads', async () => {
    const first = new Uint8Array([1, 2, 3]);
    const source = new VerifiedArrowSource(byteStream([first, eos.subarray(0, 3), eos.subarray(3)]), new AbortController().signal);
    expect((await source.next()).value).toBe(first);
    await source.finish(); await source.cancel();
  });

  it('rejects truncation and errors appended after an Arrow terminator', async () => {
    for (const chunks of [[eos.subarray(0, 7)], [eos, new TextEncoder().encode('late database error')]]) {
      const source = new VerifiedArrowSource(byteStream(chunks), new AbortController().signal);
      await expect(source.finish()).rejects.toThrow('success terminator');
      await source.cancel();
    }
  });

  it('enforces the encoded-byte cap before giving the over-budget chunk to Arrow', async () => {
    const source = new VerifiedArrowSource(byteStream([new Uint8Array(9)]), new AbortController().signal, 8);
    await expect(source.next()).rejects.toThrow('byte budget'); await source.cancel();
  });

  it('streams real IPC batches and completes only with the declared contract', async () => {
    const bytes = tableToIPC(fixture(), 'stream');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/context')
      ? new Response(JSON.stringify(context))
      : new Response(byteStream([bytes.subarray(0, 23), bytes.subarray(23, bytes.length - 3), bytes.subarray(bytes.length - 3)]), {
        headers: { 'Content-Type': 'application/vnd.apache.arrow.stream', 'X-Time-Blast-Completion': 'arrow-eos-v1' },
      })));
    const adapter = new RemoteDatabaseAdapter('https://example.invalid/db');
    const received = [];
    for await (const batch of adapter.execute(request())) received.push(batch);
    expect(received.flatMap(batch => [...batch.y])).toEqual([4, 5, 6]);
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe('https://example.invalid/db/query');
    await adapter.dispose();
  });

  it('does not silently complete when valid rows arrive followed by a missing EOS', async () => {
    const bytes = tableToIPC(fixture(), 'stream');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/context')
      ? new Response(JSON.stringify(context))
      : new Response(byteStream([bytes.subarray(0, bytes.length - 8)]), {
        headers: { 'Content-Type': 'application/vnd.apache.arrow.stream', 'X-Time-Blast-Completion': 'arrow-eos-v1' },
      })));
    const adapter = new RemoteDatabaseAdapter('https://example.invalid/db');
    await expect((async () => { for await (const _batch of adapter.execute(request())) { /* consume */ } })()).rejects.toThrow('success terminator');
    await adapter.dispose();
  });

  it('rejects a plain Arrow endpoint with no end-to-end success contract', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/context')
      ? new Response(JSON.stringify(context))
      : new Response(byteStream([tableToIPC(fixture(), 'stream')]), { headers: { 'Content-Type': 'application/vnd.apache.arrow.stream' } })));
    const adapter = new RemoteDatabaseAdapter('https://example.invalid/db');
    await expect((async () => { for await (const _batch of adapter.execute(request())) { /* consume */ } })()).rejects.toThrow('completion contract');
    await adapter.dispose();
  });

  it('validates and freezes dataset semantics before executing', () => {
    expect(Object.isFrozen(parseDatasetContext(context))).toBe(true);
    expect(() => parseDatasetContext({ ...context, end: context.start })).toThrow('Invalid database context');
    expect(() => parseDatasetContext({ ...context, vessels: [] })).toThrow('Invalid database context');
  });
});
