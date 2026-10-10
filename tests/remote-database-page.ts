// Page side of tests/remote_database.py: starts the worker with the database endpoint from
// the query string (?db=ws://…/session&warm=20) and exposes its result.
const page = window as unknown as { __remoteDatabase?: unknown };
const params = new URLSearchParams(location.search);
const worker = new Worker(new URL('./remote-database.worker.ts', import.meta.url), { type: 'module' });
worker.onmessage = event => { page.__remoteDatabase = event.data; worker.terminate(); };
worker.onerror = event => { page.__remoteDatabase = { ok: false, error: event.message }; };
worker.postMessage({ endpoint: params.get('db'), warm: Number(params.get('warm') ?? 20) });
