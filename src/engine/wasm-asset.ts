// The prototype's gzip engine loader (formerly src/adapters/engine-asset.ts).
/** Cold-start packaging only. Query results never pass through this Blob path. */
export const MAX_ENGINE_ASSET_BYTES = 64 * 1024 * 1024;
const WASM_HEADER = [0, 97, 115, 109, 1, 0, 0, 0];

function checkCanceled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Engine loading canceled', 'AbortError');
}

async function boundedBlob(stream: ReadableStream<Uint8Array>, maxBytes: number, signal?: AbortSignal): Promise<Blob> {
  const reader = stream.getReader();
  const parts: BlobPart[] = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      checkCanceled(signal);
      const result = await reader.read();
      checkCanceled(signal);
      if (result.done) return new Blob(parts, { type: 'application/wasm' });
      bytes += result.value.byteLength;
      if (bytes > maxBytes) throw new Error('Engine asset exceeded its byte limit');
      // Fetch and DecompressionStream return ordinary ArrayBuffer-backed chunks.
      parts.push(result.value as Uint8Array<ArrayBuffer>);
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Fetch a gzip-packaged Wasm engine, accepting already-decoded HTTP bodies too.
 * Both encoded and decoded bodies are bounded. Blob assembly is an explicit
 * cold-start allocation required by the static host's per-asset size limit.
 */
export async function fetchEngineWasm(url: string,
  { signal, maxBytes = MAX_ENGINE_ASSET_BYTES }: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<Blob> {
  checkCanceled(signal);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 8) throw new Error('Invalid engine asset byte limit');
  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Engine asset request failed (${response.status})`);
  }
  if (!response.body) throw new Error('Engine asset response was empty');
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    await response.body.cancel();
    throw new Error('Engine asset exceeded its byte limit');
  }
  let wasm = await boundedBlob(response.body, maxBytes, signal);
  let header = new Uint8Array(await wasm.slice(0, 8).arrayBuffer());
  if (header[0] === 0x1f && header[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser needs gzip DecompressionStream support to load the database engine');
    }
    wasm = await boundedBlob(wasm.stream().pipeThrough(new DecompressionStream('gzip')), maxBytes, signal);
    header = new Uint8Array(await wasm.slice(0, 8).arrayBuffer());
  }
  // Inspect actual bytes: Content-Encoding may describe a body fetch decoded.
  if (header.length !== 8 || !WASM_HEADER.every((byte, index) => header[index] === byte)) {
    throw new Error('Engine asset was neither valid Wasm nor gzip-compressed Wasm');
  }
  checkCanceled(signal);
  return wasm;
}
