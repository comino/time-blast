import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchEngineWasm } from '../src/adapters/engine-asset';

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const gzip = new Uint8Array(gzipSync(wasm));
const url = 'https://time-blast.test/assets/duckdb.wasm.gz';
function response(body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers })));
}
afterEach(() => vi.unstubAllGlobals());

describe('production database engine assets', () => {
  it('decompresses a real gzip payload into an instantiable Wasm Blob', async () => {
    response(gzip);
    const blob = await fetchEngineWasm(url);
    expect(blob.type).toBe('application/wasm');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(wasm);
    await expect(WebAssembly.compile(await blob.arrayBuffer())).resolves.toBeInstanceOf(WebAssembly.Module);
    expect(fetch).toHaveBeenCalledWith(url, { signal: undefined, credentials: 'same-origin' });
  });

  it('does not decompress a Wasm body already decoded by HTTP Content-Encoding', async () => {
    response(wasm, { 'Content-Encoding': 'gzip', 'Content-Type': 'application/gzip' });
    const blob = await fetchEngineWasm(url);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(wasm);
  });

  it('accepts a gzip header split across streamed chunks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(gzip.subarray(0, 1)); controller.enqueue(gzip.subarray(1, 3));
        controller.enqueue(gzip.subarray(3)); controller.close();
      },
    }))));
    expect(new Uint8Array(await (await fetchEngineWasm(url)).arrayBuffer())).toEqual(wasm);
  });

  it('rejects an unsuccessful fetch before attempting to instantiate an error page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Missing asset', { status: 404 })));
    await expect(fetchEngineWasm(url)).rejects.toThrow('request failed (404)');
  });

  it('rejects truncated gzip, non-Wasm payloads, and gzip containing non-Wasm bytes', async () => {
    for (const body of [gzip.subarray(0, gzip.length - 5), new TextEncoder().encode('<html>error</html>'),
      new Uint8Array(gzipSync(new TextEncoder().encode('not a wasm module')))]) {
      response(body);
      await expect(fetchEngineWasm(url)).rejects.toThrow();
    }
  });

  it('bounds both encoded input and decompressed output', async () => {
    response(gzip);
    await expect(fetchEngineWasm(url, { maxBytes: 8 })).rejects.toThrow('byte limit');
    const expanded = new Uint8Array(256); expanded.set(wasm);
    const compressed = new Uint8Array(gzipSync(expanded));
    expect(compressed.byteLength).toBeLessThan(64);
    response(compressed);
    await expect(fetchEngineWasm(url, { maxBytes: 64 })).rejects.toThrow('byte limit');
  });

  it('cancels a blocked asset reader when startup is aborted', async () => {
    const cancel = vi.fn();
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      pull() { reading(); }, cancel,
    }))));
    const controller = new AbortController();
    const loading = fetchEngineWasm(url, { signal: controller.signal });
    const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    await started; controller.abort(); await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
