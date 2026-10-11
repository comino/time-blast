/**
 * The engine worker of /measure.html: exactly the app's engine (src/engine/engine.worker.ts —
 * same EngineHost, coordinator, database and renderer factories), with one more inference
 * placement. A remote endpoint `fake:?latency=<ms>&mode=<plain|echo|vary>` opens the in-page fake
 * inference node (src/measure/fake-inference.worker.ts) on its own worker over a MessagePort
 * link, the WebLLM node's placement; any other endpoint is the real tb1 WebSocket.
 * Keep the host construction in sync with src/engine/engine.worker.ts (importing that module
 * would start a second engine: it builds its host at module load).
 */
import type { InferencePlacement, Link, PostToUi, UiToEngine } from '../engine/contracts';
import { createCoordinator } from '../engine/coordinator';
import { createDatabase } from '../engine/database';
import { createRenderer } from '../engine/render/index';
import { EngineHost } from '../engine/host';
import { createPortLink, createWebSocketLink } from '../engine/links';
import { createPlacedDatabase } from '../engine/remote-database';
import { header, json, Kind } from '../protocol/frame';

interface WorkerScope {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<UiToEngine>) => void): void;
}
const scope = self as unknown as WorkerScope;
const hello = (body: Record<string, unknown>) => ({ ...header(Kind.HELLO, {}), stamps: [], payload: json({ node: 'coordinator', name: 'time-blast-measure', version: 1, ...body }) });

function connectInference(placement: InferencePlacement): Link {
  if (placement.kind === 'remote' && placement.endpoint.startsWith('fake:')) {
    const params = new URLSearchParams(placement.endpoint.slice(placement.endpoint.indexOf('?') + 1));
    const worker = new Worker(new URL('./fake-inference.worker.ts', import.meta.url), { type: 'module', name: 'fake-inference' });
    return createPortLink('inference', worker as unknown as Parameters<typeof createPortLink>[1],
      { hello: hello({ fake: { latencyMs: Number(params.get('latency') ?? 0), mode: params.get('mode') ?? 'echo' } }) });
  }
  if (placement.kind === 'remote') return createWebSocketLink('inference', placement.endpoint, { hello: hello({}) });
  throw new Error('measure page: WebGPU inference is not offered here');
}

const postToUi: PostToUi = (message, transfer) => scope.postMessage(message, transfer ?? []);
const host = new EngineHost({ createCoordinator, createRenderer, createDatabase: createPlacedDatabase(createDatabase), postToUi, connectInference });
scope.addEventListener('message', event => host.onMessage(event.data));
