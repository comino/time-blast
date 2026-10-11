/**
 * Shared engine-worker entry logic (the app's src/engine/engine.worker.ts and /measure.html's
 * src/measure/engine.worker.ts). Kept small on purpose: before the main part (engine-main.ts:
 * coordinator, DuckDB bindings, renderer, Arrow) is even fetched, it starts the DuckDB compile, the
 * dataset manifest and, as soon as the boot message names it, the dataset's prebuilt database
 * (src/engine/early.ts, docs/batch-3/cold-start.md). Messages that arrive meanwhile are kept and
 * replayed in order.
 */
import type { UiToEngine } from './contracts';
import { bootMark, setBootSink, type BootMark } from './boot-trace';
import { compileDuckDB, compileOwnWasm, loadManifest, prefetchExtensions, prefetchFixture } from './early';
import type { WorkerScope } from './engine-main';

export type StartEngine = (scope: WorkerScope, early: UiToEngine[]) => (message: UiToEngine) => void;

export function runEngineWorker(scope: WorkerScope, loadMain: () => Promise<StartEngine>): void {
  setBootSink((mark: BootMark) => scope.postMessage({ type: 'trace', marks: [mark] }, []));
  // Worker time origin = its creation; this runs once the entry chunk has loaded.
  bootMark('worker.entry', performance.timeOrigin);

  const early: UiToEngine[] = [];
  let deliver: ((message: UiToEngine) => void) | undefined;
  scope.addEventListener('message', event => {
    if (deliver) { deliver(event.data); return; }
    const message = event.data;
    if (message.type === 'boot' && message.dataset.kind === 'fixture') prefetchFixture(message.dataset.name);
    else if (message.type === 'dataset' && message.source.kind === 'fixture') prefetchFixture(message.source.name);
    early.push(message);
  });

  // The page names its boot fixture in the worker name (src/ui/boot.ts): fetch it right away.
  const hint = /#fixture=([\w.-]+)$/.exec((scope as { name?: string }).name ?? '');
  if (hint) prefetchFixture(hint[1]);
  void compileDuckDB().catch(() => { /* reported when the database boots */ });
  prefetchExtensions(['json']);
  void loadManifest().catch(() => { /* built-in fixtures */ });
  for (const name of ['tb-coordinator', 'tb-render'] as const) void compileOwnWasm(name).catch(() => { /* the node fetches it itself */ });

  void loadMain().then(start => { deliver = start(scope, early.splice(0)); });
}
