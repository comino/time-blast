/** First module the page evaluates (imported first by src/ui/app.ts): spawns the engine worker
 * before the UI is built, so the worker's downloads and the DuckDB compile overlap with page
 * setup (docs/batch-3/cold-start.md). */
import { bootMark } from '../engine/boot-trace';
import { DEFAULT_DATASET } from './defaults';

bootMark('page.modules');
// The worker name carries the boot fixture so the worker fetches it before the boot message.
const hint = DEFAULT_DATASET.kind === 'fixture' ? `#fixture=${DEFAULT_DATASET.name}` : '';
export const engineWorker = new Worker(new URL('../engine/engine.worker.ts', import.meta.url), { type: 'module', name: `engine${hint}` });
bootMark('page.worker');
