/**
 * Inference placement of /measure.html's engine worker. A remote endpoint
 * `fake:?latency=<ms>&mode=<plain|echo|vary>` opens the in-page fake inference node
 * (src/measure/fake-inference.worker.ts) on its own worker over a MessagePort link, the WebLLM
 * node's placement; any other endpoint is the real tb1 WebSocket.
 */
import type { InferencePlacement, Link } from '../engine/contracts';
import { createPortLink, createWebSocketLink } from '../engine/links';
import { header, json, Kind } from '../protocol/frame';

const hello = (body: Record<string, unknown>) => ({ ...header(Kind.HELLO, {}), stamps: [], payload: json({ node: 'coordinator', name: 'time-blast-measure', version: 1, ...body }) });

export function connectInference(placement: InferencePlacement): Link {
  if (placement.kind === 'remote' && placement.endpoint.startsWith('fake:')) {
    const params = new URLSearchParams(placement.endpoint.slice(placement.endpoint.indexOf('?') + 1));
    const worker = new Worker(new URL('./fake-inference.worker.ts', import.meta.url), { type: 'module', name: 'fake-inference' });
    return createPortLink('inference', worker as unknown as Parameters<typeof createPortLink>[1],
      { hello: hello({ fake: { latencyMs: Number(params.get('latency') ?? 0), mode: params.get('mode') ?? 'echo' } }) });
  }
  if (placement.kind === 'remote') return createWebSocketLink('inference', placement.endpoint, { hello: hello({}) });
  throw new Error('measure page: WebGPU inference is not offered here');
}
