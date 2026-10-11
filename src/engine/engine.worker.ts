/**
 * The engine worker's entry, spawned by the page (src/ui/boot.ts, before the UI bundle loads) as
 *   new Worker(new URL('../engine/engine.worker.ts', import.meta.url), { type: 'module' })
 * Cold-start work begins here (src/engine/worker-entry.ts); the engine itself lives in
 * src/engine/engine-main.ts, a separate chunk loaded right after.
 */
import type { WorkerScope } from './engine-main';
import { runEngineWorker } from './worker-entry';

runEngineWorker(self as unknown as WorkerScope, async () => (await import('./engine-main')).startEngine);
// DuckDB's JS glue (its own chunk, ~1.3 MB): fetch and parse it alongside the main part.
void import('./database').catch(() => { /* loaded again (and reported) when the database boots */ });
