// Page side of tests/render_engine.py: transfers four canvases to the worker and exposes the result.
const page = window as unknown as { __renderEngine?: unknown };
const size = { width: 480, height: 240, devicePixelRatio: devicePixelRatio || 1 };
const canvases = [...document.querySelectorAll('canvas')].map(c => c.transferControlToOffscreen());
const worker = new Worker(new URL('./render-engine.worker.ts', import.meta.url), { type: 'module' });
worker.onmessage = event => { page.__renderEngine = event.data; };
worker.onerror = event => { page.__renderEngine = { ok: false, error: event.message }; };
worker.postMessage({ canvases, size }, canvases);
