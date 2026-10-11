/** First module the page evaluates (imported first by src/ui/app.ts): spawns the engine worker
 * before the UI is built, so the worker's downloads and the DuckDB compile overlap with page
 * setup (docs/batch-3/cold-start.md). */
import { bootMark } from '../engine/boot-trace';

bootMark('page.modules');
export const engineWorker = new Worker(new URL('../engine/engine.worker.ts', import.meta.url), { type: 'module' });
bootMark('page.worker');
