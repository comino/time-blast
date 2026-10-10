// Page side of the engine smoke (tests/engine_smoke.py): checks isolation, probes CORS for
// cross-origin assets under COEP, runs the database worker and exposes the result.
const smoke = window as unknown as { __engineSmoke?: unknown };

async function probe(url: string): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(url, { method: 'HEAD', mode: 'cors' });
    return { url, ok: response.ok, status: response.status };
  } catch (error) {
    return { url, ok: false, error: String(error) };
  }
}

async function main() {
  const page = {
    crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    timerResolutionUs: (() => {
      let min = Infinity, last = performance.now();
      for (let i = 0; i < 200000 && min > 0.001; i++) { const t = performance.now(); if (t !== last) { min = Math.min(min, t - last); last = t; } }
      return +(min * 1000).toFixed(2);
    })(),
    cors: await Promise.all([
      probe('https://huggingface.co/mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC/resolve/main/mlc-chat-config.json'),
      probe('https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/README.md'),
      probe('https://extensions.duckdb.org/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm'),
    ]),
  };
  const worker = new Worker(new URL('./engine-smoke.worker.ts', import.meta.url), { type: 'module' });
  const result = await new Promise(resolve => { worker.onmessage = event => resolve(event.data); worker.onerror = event => resolve({ ok: false, error: event.message }); worker.postMessage('run'); });
  worker.terminate();
  smoke.__engineSmoke = { page, worker: result };
}

void main();
