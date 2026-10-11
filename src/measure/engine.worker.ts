/**
 * The engine worker of /measure.html: exactly the app's engine and boot (src/engine/worker-entry.ts,
 * src/engine/engine-main.ts createEngineHost), with one more inference placement
 * (src/measure/inference-link.ts): a remote endpoint `fake:?latency=<ms>&mode=<plain|echo|vary>`
 * opens the in-page fake inference node on its own worker.
 */
import type { WorkerScope } from '../engine/engine-main';
import { runEngineWorker } from '../engine/worker-entry';

runEngineWorker(self as unknown as WorkerScope, async () => {
  const [engine, link] = await Promise.all([import('../engine/engine-main'), import('./inference-link')]);
  return (scope, early) => engine.startEngine(scope, early, link.connectInference);
});
void import('../engine/database').catch(() => { /* loaded again when the database boots */ });
