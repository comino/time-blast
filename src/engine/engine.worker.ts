/**
 * The engine worker: coordinator, database and renderer in one thread, plus the inference
 * link. Spawned by the UI as
 *   new Worker(new URL('./engine/engine.worker.ts', import.meta.url), { type: 'module' })
 * and driven by UiToEngine messages (src/engine/contracts.ts). The UI may post at any time;
 * messages arriving before the nodes are ready are queued. Typical start:
 *   attach (one per slot) … → boot {inference, dataset} → frame {CONFIG} → frame {DRAFT} …
 * Routing and queuing live in src/engine/host.ts.
 */
import type { InferencePlacement, Link, PostToUi, UiToEngine } from './contracts';
import { createCoordinator } from './coordinator';
import { createDatabase } from './database';
import { createRenderer } from './render/index';
import { EngineHost } from './host';
import { createPortLink, createWebSocketLink } from './links';
// Remote database placement (docs/batch-1/remote-database.md): a `{kind: 'remote', endpoint}`
// dataset source opens the ClickHouse node over a tb1 WebSocket; other sources use DuckDB-Wasm,
// which now boots on the first local open instead of at worker start.
import { createPlacedDatabase } from './remote-database';
import { header, json, Kind } from '../protocol/frame';

interface WorkerScope {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<UiToEngine>) => void): void;
}
const scope = self as unknown as WorkerScope;

const hello = (body: Record<string, unknown>) => ({ ...header(Kind.HELLO, {}), stamps: [], payload: json({ node: 'coordinator', name: 'time-blast-engine', version: 1, ...body }) });

export function connectInference(placement: InferencePlacement): Link {
  if (placement.kind === 'remote') return createWebSocketLink('inference', placement.endpoint, { hello: hello({}) });
  const worker = new Worker(new URL('../inference-node/webllm.worker.ts', import.meta.url), { type: 'module', name: 'inference' });
  return createPortLink('inference', worker as unknown as Parameters<typeof createPortLink>[1], { hello: hello({ model: placement.model }) });
}

const postToUi: PostToUi = (message, transfer) => scope.postMessage(message, transfer ?? []);
const host = new EngineHost({ createCoordinator, createRenderer, createDatabase: createPlacedDatabase(createDatabase), postToUi, connectInference });
scope.addEventListener('message', event => host.onMessage(event.data));
