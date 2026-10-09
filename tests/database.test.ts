import { afterEach, describe, expect, it, vi } from 'vitest';
import { Float64, Int32, makeData, makeVector, Schema, Table, tableFromArrays, tableToIPC, vectorFromArray } from 'apache-arrow';
import { accountRetainedBytes, QueryGate, retainArrowBatch, validateArrowSchema } from '../src/adapters/arrow';
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

  it('accounts full sliced allocations once while preserving logical byte counts', () => {
    const source = fixture().batches[0];
    const first = retainArrowBatch(source.slice(0, 1), 2);
    const second = retainArrowBatch(source.slice(1, 2), 2);
    const seen = new WeakSet<ArrayBufferLike>();
    const fullBytes = first.retainedBuffers!.reduce((sum, buffer) => sum + buffer.byteLength, 0);
    expect(first.byteLength).toBe(36);
    expect(fullBytes).toBeGreaterThan(first.byteLength);
    expect(accountRetainedBytes(first, seen)).toBe(fullBytes);
    expect(accountRetainedBytes(second, seen)).toBe(0);
    expect(second.x.buffer).toBe(first.x.buffer);
  });

  it('rejects uncontracted columns before retaining their hidden allocations', () => {
    const source = tableFromArrays({ x: new Float64Array([1000]), y: new Float64Array([1]),
      series: new Int32Array([0]), unused: ['x'.repeat(1024 * 1024)] });
    expect(() => retainArrowBatch(source.batches[0], 1)).toThrow('unsupported columns');
    const schema = fixture().schema;
    expect(() => validateArrowSchema(new Schema([...schema.fields, schema.fields[0]]))).toThrow('duplicate');
  });

  it('includes validity allocations retained by an all-valid Arrow owner', () => {
    const bitmap = new Uint8Array(128).fill(255);
    const x = makeVector(makeData({ type: new Float64(), length: 1, nullCount: 0,
      data: new Float64Array([1000]), nullBitmap: bitmap }));
    const table = new Table({ x, y: vectorFromArray([1], new Float64()), series: vectorFromArray([0], new Int32()) });
    const batch = retainArrowBatch(table.batches[0], 1);
    expect(batch.retainedBuffers).toContain(bitmap.buffer);
    expect(new Set(batch.retainedBuffers).size).toBe(batch.retainedBuffers!.length);
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
    const bytes = tableToIPC(fixture(), 'stream');
    const first = bytes.subarray(0, bytes.length - 8);
    const source = new VerifiedArrowSource(byteStream([first, eos.subarray(0, 3), eos.subarray(3)]), new AbortController().signal);
    expect((await source.next()).value).toBe(first);
    await source.finish(); await source.cancel();
  });

  it('rejects truncation and errors appended after an Arrow terminator', async () => {
    const bytes = tableToIPC(fixture(), 'stream');
    for (const chunks of [[bytes.subarray(0, bytes.length - 1)], [bytes, new TextEncoder().encode('late database error')]]) {
      const source = new VerifiedArrowSource(byteStream(chunks), new AbortController().signal);
      await expect(source.finish()).rejects.toThrow('success terminator');
      await source.cancel();
    }
  });

  it('accepts a stream fragmented at every byte, including metadata and body boundaries', async () => {
    const bytes = tableToIPC(fixture(), 'stream');
    const chunks = Array.from(bytes, (_, i) => bytes.subarray(i, i + 1));
    const source = new VerifiedArrowSource(byteStream(chunks), new AbortController().signal);
    await source.finish(); await source.cancel();
  });

  it('accepts an empty result with schema and explicit EOS', async () => {
    const bytes = tableToIPC(fixture().slice(0, 0), 'stream');
    const source = new VerifiedArrowSource(byteStream([bytes]), new AbortController().signal);
    await source.finish(); await source.cancel();
  });

  it('rejects a second schema even if the first stream omitted EOS', async () => {
    const bytes = tableToIPC(fixture(), 'stream');
    const source = new VerifiedArrowSource(byteStream([bytes.subarray(0, bytes.length - 8), bytes]), new AbortController().signal);
    await expect(source.finish()).rejects.toThrow('exactly one Arrow schema'); await source.cancel();
  });

  it('does not accept an EOS-only response or a truncated body followed by EOS', async () => {
    const bytes = tableToIPC(fixture(), 'stream');
    for (const chunks of [[eos], [bytes.subarray(0, bytes.length - 32), eos]]) {
      const source = new VerifiedArrowSource(byteStream(chunks), new AbortController().signal);
      await expect(source.finish()).rejects.toThrow('success terminator'); await source.cancel();
    }
  });

  it('requires EOS at a parsed message boundary, even if the body ends with EOS bytes', async () => {
    const bytes = tableToIPC(fixture(), 'stream').slice(0, -8);
    bytes.set(eos, bytes.length - 8);
    const source = new VerifiedArrowSource(byteStream([bytes]), new AbortController().signal);
    await expect(source.finish()).rejects.toThrow('success terminator'); await source.cancel();
  });

  it('rejects malformed lengths without allocating the advertised metadata', async () => {
    const header = new Uint8Array([255, 255, 255, 255, 0, 0, 16, 0]);
    const source = new VerifiedArrowSource(byteStream([header]), new AbortController().signal);
    await expect(source.next()).rejects.toThrow('metadata length');
    // A decoder consuming a source error must not erase it before finish().
    await expect(source.finish()).rejects.toThrow('metadata length'); await source.cancel();
  });

  it('cancels a stalled read promptly and releases its lock once', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    const source = new VerifiedArrowSource(stream, controller.signal);
    const reading = source.next();
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await source.cancel(); await source.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
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
    expect(received[0].retainedBuffers).toContain(received[0].x.buffer);
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe('https://example.invalid/db/query');
    await adapter.dispose();
  });

  it.each(['same chunk', 'separate chunks', 'error plus EOS'])(
    'rejects bytes after the first EOS: %s', async arrangement => {
      const bytes = tableToIPC(fixture(), 'stream');
      const chunks = arrangement === 'same chunk' ? [new Uint8Array([...bytes, ...bytes])]
        : arrangement === 'separate chunks' ? [bytes, bytes]
        : [bytes, new TextEncoder().encode('late failure'), eos];
      vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/context')
        ? new Response(JSON.stringify(context))
        : new Response(byteStream(chunks), { headers: {
          'Content-Type': 'application/vnd.apache.arrow.stream', 'X-Time-Blast-Completion': 'arrow-eos-v1',
        } })));
      const adapter = new RemoteDatabaseAdapter('https://example.invalid/db');
      await expect((async () => { for await (const _batch of adapter.execute(request())) { /* consume */ } })())
        .rejects.toThrow('trailing bytes');
      await adapter.dispose();
    },
  );

  it('rejects an extra large column through the real IPC decoder path', async () => {
    const table = tableFromArrays({ x: new Float64Array([1000]), y: new Float64Array([1]),
      series: new Int32Array([0]), unused: ['x'.repeat(1024 * 1024)] });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/context')
      ? new Response(JSON.stringify(context)) : new Response(byteStream([tableToIPC(table, 'stream')]), { headers: {
        'Content-Type': 'application/vnd.apache.arrow.stream', 'X-Time-Blast-Completion': 'arrow-eos-v1',
      } })));
    const adapter = new RemoteDatabaseAdapter('https://example.invalid/db');
    await expect((async () => { for await (const _batch of adapter.execute(request())) { /* consume */ } })())
      .rejects.toThrow('unsupported columns');
    await adapter.dispose();
  });

  it('requires clean HTTP completion after rows and a valid EOS', async () => {
    const bytes = tableToIPC(fixture(), 'stream'); let sent = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (!sent) { sent = true; controller.enqueue(bytes); }
      else controller.error(new Error('transport reset'));
    } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/context')
      ? new Response(JSON.stringify(context)) : new Response(stream, { headers: {
        'Content-Type': 'application/vnd.apache.arrow.stream', 'X-Time-Blast-Completion': 'arrow-eos-v1',
      } })));
    const adapter = new RemoteDatabaseAdapter('https://example.invalid/db');
    let rows = 0;
    await expect((async () => { for await (const batch of adapter.execute(request())) rows += batch.length; })())
      .rejects.toThrow('transport reset');
    expect(rows).toBe(3);
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
