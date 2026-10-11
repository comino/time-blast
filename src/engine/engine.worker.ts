/**
 * The engine worker's entry, spawned by the page as
 *   new Worker(new URL('./engine/engine.worker.ts', import.meta.url), { type: 'module' })
 * (src/ui/boot.ts, before the UI bundle loads). Kept small on purpose: before the main part
 * (src/engine/engine-main.ts: coordinator, DuckDB bindings, renderer, Arrow) is even fetched, it
 * starts the DuckDB compile, the dataset manifest and, as soon as the boot message names it, the
 * dataset's prebuilt database (src/engine/early.ts, docs/batch-3/cold-start.md). Messages that
 * arrive meanwhile are kept and replayed in order.
 */
import type { UiToEngine } from './contracts';
import { bootMark, setBootSink, type BootMark } from './boot-trace';
import { compileDuckDB, loadManifest, prefetchFixture } from './early';
import type { WorkerScope } from './engine-main';

const scope = self as unknown as WorkerScope;
setBootSink((mark: BootMark) => scope.postMessage({ type: 'trace', marks: [mark] }, []));
// Worker time origin = its creation; this runs once the entry chunk has loaded.
bootMark('worker.entry', performance.timeOrigin);

const early: UiToEngine[] = [];
let deliver: ((message: UiToEngine) => void) | undefined;
const look = (message: UiToEngine) => {
  if (message.type === 'boot' && message.dataset.kind === 'fixture') prefetchFixture(message.dataset.name);
  else if (message.type === 'dataset' && message.source.kind === 'fixture') prefetchFixture(message.source.name);
};
scope.addEventListener('message', event => {
  if (deliver) { deliver(event.data); return; }
  look(event.data);
  early.push(event.data);
});

void compileDuckDB().catch(() => { /* reported when the database boots */ });
void loadManifest().catch(() => { /* built-in fixtures */ });

void import('./engine-main').then(main => {
  deliver = main.start(scope, early.splice(0));
});
