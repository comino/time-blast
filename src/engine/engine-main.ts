/**
 * The engine worker's main part: coordinator, database and renderer in one thread, plus the
 * inference link. Loaded by the worker entry (src/engine/engine.worker.ts) after it has started
 * the cold-start work (src/engine/early.ts), and driven by UiToEngine messages
 * (src/engine/contracts.ts). The UI may post at any time; messages arriving before the nodes are
 * ready are queued. Typical start:
 *   attach (one per slot) … → boot {inference, dataset} → frame {CONFIG} → frame {DRAFT} …
 * Routing and queuing live in src/engine/host.ts.
 */
import type { InferencePlacement, Link, PostToUi, UiToEngine } from './contracts';
import type { CreateDatabase } from './contracts';
import { loadCoordinator } from './coordinator';
import { createRenderer } from './render/index';
import { compileOwnWasm } from './early';
import { EngineHost } from './host';
import { createPortLink, createWebSocketLink } from './links';
// Remote database placement (docs/batch-1/remote-database.md): a `{kind: 'remote', endpoint}`
// dataset source opens the ClickHouse node over a tb1 WebSocket; other sources use DuckDB-Wasm,
// which now boots on the first local open instead of at worker start.
import { createPlacedDatabase } from './remote-database';
import { header, json, Kind } from '../protocol/frame';
import { bootMark } from './boot-trace';

const RENDERER_HEAD_START_MS = 1500;

/** DuckDB's JS glue (~1 MB) is its own chunk: coordinator and renderer start without waiting for it. */
const lazyDatabase: CreateDatabase = async emit => (await import('./database')).createDatabase(emit);

export interface WorkerScope {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<UiToEngine>) => void): void;
}

const hello = (body: Record<string, unknown>) => ({ ...header(Kind.HELLO, {}), stamps: [], payload: json({ node: 'coordinator', name: 'time-blast-engine', version: 1, ...body }) });

export function connectInference(placement: InferencePlacement): Link {
  if (placement.kind === 'remote') return createWebSocketLink('inference', placement.endpoint, { hello: hello({}) });
  const worker = new Worker(new URL('../inference-node/webllm.worker.ts', import.meta.url), { type: 'module', name: 'inference' });
  return createPortLink('inference', worker as unknown as Parameters<typeof createPortLink>[1], { hello: hello({ model: placement.model }) });
}

/** The engine host with the standard nodes: Wasm coordinator, DuckDB (or a remote database by
 * dataset source), Wasm renderer. Shared by the app's worker and /measure.html's worker, which
 * differ only in how they open the inference link. */
export function createEngineHost(deps: { postToUi: PostToUi; connectInference: (placement: InferencePlacement) => Link }): EngineHost {
  // Wasm modules the worker entry started compiling (src/engine/early.ts); a failed early compile
  // falls back to the node's own fetch.
  const own = (name: 'tb-coordinator' | 'tb-render') => compileOwnWasm(name).catch(() => undefined);
  // DuckDB's instantiation holds this thread for seconds. Let the renderer get its GPU device and
  // queue its pipeline compiles first (they then finish in the GPU process meanwhile), bounded by
  // RENDERER_HEAD_START_MS; the DuckDB module keeps compiling off-thread during the wait.
  let rendererStarted: Promise<unknown> = Promise.resolve();
  const headStart = () => Promise.race([rendererStarted.catch(() => undefined), new Promise(r => setTimeout(r, RENDERER_HEAD_START_MS))]);
  return new EngineHost({
    createCoordinator: async () => loadCoordinator(await own('tb-coordinator')),
    createRenderer: (emit, ui) => (rendererStarted = (async () => { const wasm = await own('tb-render'); return createRenderer(emit, ui, wasm ? { wasm } : {}); })()) as ReturnType<typeof createRenderer>,
    createDatabase: createPlacedDatabase(async emit => { await headStart(); return lazyDatabase(emit); }),
    ...deps,
  });
}

/** Start the host and replay the messages the entry received while this module loaded. */
export function startEngine(scope: WorkerScope, early: UiToEngine[], connect: (placement: InferencePlacement) => Link = connectInference): (message: UiToEngine) => void {
  const postToUi: PostToUi = (message, transfer) => scope.postMessage(message, transfer ?? []);
  bootMark('worker.main');
  const host = createEngineHost({ postToUi, connectInference: connect });
  for (const message of early) host.onMessage(message);
  return message => host.onMessage(message);
}
