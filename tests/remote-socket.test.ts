import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterStatus, DatasetContext, Draft, InferenceAdapter, QueryPlan } from '../src/core/types';
import { createInferenceAdapter, RemoteInferenceAdapter } from '../src/inference';
import { INFERENCE_SOCKET_PROTOCOL, RemoteSocketInferenceAdapter } from '../src/inference/remote-socket';

const context: DatasetContext = { id: 'fleet-v1', label: 'Fleet', rowCount: 1000,
  start: Date.UTC(2026, 8, 1), end: Date.UTC(2026, 8, 15), vessels: ['Aurora', 'Borealis'], description: 'Fixture' };
const plan: QueryPlan = { metric: 'speed', aggregate: 'avg', bucketMinutes: 60, windowHours: 24, splitByVessel: false, vessel: null, view: 'line' };
const draft = (text = 'Average speed by hour', revision = 1): Draft => ({ text, revision, contextId: context.id, sentAt: 0 });

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  messages: any[] = [];
  close = vi.fn(() => { this.readyState = 3; });
  send = vi.fn((text: string) => { this.messages.push(JSON.parse(text)); });
  constructor(readonly url: string, public protocol: string) { FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  ready() { this.open(); this.receive({ type: 'READY', version: 1, model: 'backend-model' }); }
  reply(id: string, result: unknown = { plan, model: 'backend-model' }) { this.receive({ type: 'RESULT', id, result }); }
  requests() { return this.messages.filter(message => message.type === 'INFER'); }
}
const adapters: InferenceAdapter[] = [];
function create(onStatus?: (status: AdapterStatus) => void) {
  const adapter = createInferenceAdapter('remote', { endpoint: 'wss://inference.test/inference',
    wsImpl: FakeSocket as unknown as typeof WebSocket, onStatus });
  adapters.push(adapter); return adapter;
}
async function ready(adapter = create()) {
  const preparation = adapter.prepare(context), socket = FakeSocket.instances.at(-1)!;
  socket.ready(); await preparation; return { adapter, socket };
}
beforeEach(() => { vi.useFakeTimers(); FakeSocket.instances = []; });
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.dispose(); vi.useRealTimers(); });

describe('persistent remote inference', () => {
  it('passes cache settings through HTTP and preserves a structured backend error', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ message: 'Unsupported request', model: 'backend-model',
      diagnostics: { generationMs: 45, attempts: 2 }, response: { text: '{"error":"unsupported_request"}', truncated: false } }), { status: 422 }));
    const adapter = createInferenceAdapter('remote', { endpoint: 'https://inference.test/infer', fetchImpl: fetcher });
    adapters.push(adapter); await adapter.prepare(context); adapter.setPlanCacheEnabled!(false);
    await expect(adapter.resolve(draft(), new AbortController().signal)).rejects.toMatchObject({ message: 'Unsupported request',
      details: { model: 'backend-model', diagnostics: { generationMs: 45, attempts: 2 }, response: { text: '{"error":"unsupported_request"}', truncated: false } } });
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(call[1].body as string).cachePlans).toBe(false);
  });

  it('keeps HTTP compatibility and selects a socket only for ws(s) endpoints', () => {
    const http = createInferenceAdapter('remote', { endpoint: 'https://inference.test/infer' });
    expect(http).toBeInstanceOf(RemoteInferenceAdapter); http.dispose();
    expect(create()).toBeInstanceOf(RemoteSocketInferenceAdapter);
  });

  it('negotiates a versioned context session before submitting inference', async () => {
    const statuses: AdapterStatus[] = [], adapter = create(status => statuses.push(status));
    const preparation = adapter.prepare(context), socket = FakeSocket.instances[0];
    const request = adapter.resolve(draft(), new AbortController().signal);
    expect(socket.messages).toEqual([]);
    socket.open();
    expect(socket.url).toBe('wss://inference.test/inference');
    expect(socket.protocol).toBe(INFERENCE_SOCKET_PROTOCOL);
    expect(socket.messages).toEqual([{ type: 'HELLO', version: 1, context, cachePlans: true }]);
    socket.receive({ type: 'READY', version: 1, model: 'backend-model' }); await preparation;
    const message = socket.requests()[0];
    expect(message).toEqual({ type: 'INFER', id: expect.any(String), draft: draft(), cachePlans: true });
    socket.reply(message.id, { plan, model: 'backend-model', tokens: 40, diagnostics: { generationMs: 12, queueMs: -1, attempts: 1 } });
    await expect(request).resolves.toEqual({ source: 'remote', plan, model: 'backend-model', tokens: 40,
      diagnostics: { generationMs: 12, attempts: 1 } });
    expect(statuses.at(-1)?.detail).toContain('provider model warmup is independent');
  });

  it('coalesces typing to one latest draft and never starts generation itself', async () => {
    const { adapter, socket } = await ready();
    for (let i = 1; i <= 100; i++) adapter.observeDraft(draft(`Question revision ${i}`, i));
    vi.advanceTimersByTime(24); expect(socket.messages).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(socket.messages.slice(1)).toEqual([{ type: 'DRAFT', draft: draft('Question revision 100', 100) }]);
    expect(socket.requests()).toHaveLength(0);
  });

  it('retains only the newest pre-handshake draft', async () => {
    const adapter = create(), preparation = adapter.prepare(context), socket = FakeSocket.instances[0];
    for (let i = 0; i < 100; i++) { adapter.observeDraft(draft(`Question ${i}`, i)); vi.advanceTimersByTime(25); }
    expect(socket.messages).toHaveLength(0);
    socket.ready(); await preparation;
    expect(socket.messages.at(-1)).toEqual({ type: 'DRAFT', draft: draft('Question 99', 99) });
  });

  it('drops over-limit hints and drafts from another context', async () => {
    const { adapter, socket } = await ready();
    adapter.observeDraft({ ...draft(), contextId: 'old-context' }); vi.advanceTimersByTime(25);
    adapter.observeDraft(draft('x'.repeat(4097))); vi.advanceTimersByTime(25);
    expect(socket.messages).toHaveLength(1);
  });

  it('does not queue draft writes behind a busy socket', async () => {
    const { adapter, socket } = await ready(); socket.bufferedAmount = 1;
    adapter.observeDraft(draft('Older draft')); vi.advanceTimersByTime(25);
    expect(socket.messages).toHaveLength(1);
    socket.bufferedAmount = 0;
    adapter.observeDraft(draft('Newer draft', 2)); vi.advanceTimersByTime(25);
    expect(socket.messages.at(-1).draft.text).toBe('Newer draft');
  });

  it('sends cancellation only for its matching request and ignores late results', async () => {
    const { adapter, socket } = await ready(), firstController = new AbortController();
    const first = adapter.resolve(draft(), firstController.signal), second = adapter.resolve(draft('Maximum wind', 2), new AbortController().signal);
    const [a, b] = socket.requests(); firstController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(socket.messages.at(-1)).toEqual({ type: 'CANCEL', id: a.id });
    socket.reply(a.id, { plan: { ...plan, metric: 'water_temp' } });
    socket.reply(b.id, { plan: { ...plan, metric: 'wind' }, model: 'backend-model' });
    await expect(second).resolves.toMatchObject({ plan: { metric: 'wind' } });
  });

  it('cancels repeated handshake waiters without retaining or submitting them', async () => {
    const adapter = create(), preparation = adapter.prepare(context), socket = FakeSocket.instances[0];
    for (let i = 0; i < 100; i++) {
      const controller = new AbortController(), request = adapter.resolve(draft(`Question ${i}`, i), controller.signal);
      controller.abort(); await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    }
    const request = adapter.resolve(draft('Final question', 100), new AbortController().signal);
    socket.ready(); await preparation;
    expect(socket.requests()).toHaveLength(1);
    expect(socket.messages.filter(message => message.type === 'CANCEL')).toHaveLength(0);
    socket.reply(socket.requests()[0].id); await request;
  });

  it('bounds concurrent requests at two without disturbing admitted work', async () => {
    const { adapter, socket } = await ready();
    const a = adapter.resolve(draft(), new AbortController().signal), b = adapter.resolve(draft('Maximum wind', 2), new AbortController().signal);
    await expect(adapter.resolve(draft('Wave height', 3), new AbortController().signal)).rejects.toThrow('queue is full');
    for (const message of socket.requests()) socket.reply(message.id);
    await Promise.all([a, b]);
  });

  it('applies the cache toggle per request without reconnecting', async () => {
    const { adapter, socket } = await ready(); adapter.setPlanCacheEnabled!(false);
    const request = adapter.resolve(draft(), new AbortController().signal);
    expect(socket.requests()[0].cachePlans).toBe(false);
    socket.reply(socket.requests()[0].id); await request;
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('transmits both cache policy transitions immediately without canceling active inference', async () => {
    const { adapter, socket } = await ready(), request = adapter.resolve(draft(), new AbortController().signal);
    adapter.setPlanCacheEnabled!(false); adapter.setPlanCacheEnabled!(true);
    expect(socket.messages.slice(-2)).toEqual([{ type: 'CACHE_POLICY', cachePlans: false }, { type: 'CACHE_POLICY', cachePlans: true }]);
    expect(socket.messages.some(message => message.type === 'CANCEL')).toBe(false);
    socket.reply(socket.requests()[0].id); await request;
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('updates a changed handshake cache policy before admitting queued inference', async () => {
    const adapter = create(), preparation = adapter.prepare(context), socket = FakeSocket.instances[0];
    socket.open(); adapter.setPlanCacheEnabled!(false);
    const request = adapter.resolve(draft(), new AbortController().signal);
    socket.receive({ type: 'READY', version: 1 }); await preparation;
    expect(socket.messages.slice(1).map(message => message.type)).toEqual(['CACHE_POLICY', 'INFER']);
    expect(socket.requests()[0].cachePlans).toBe(false);
    socket.reply(socket.requests()[0].id); await request;
  });

  it('preserves measured failures and rejects invalid plans without disconnecting', async () => {
    const { adapter, socket } = await ready();
    const request = adapter.resolve(draft(), new AbortController().signal);
    socket.reply(socket.requests()[0].id, { plan: { ...plan, sql: 'SELECT secret' }, model: 'backend-model', diagnostics: { generationMs: 31 } });
    await expect(request).rejects.toMatchObject({ details: { source: 'remote', model: 'backend-model', diagnostics: { generationMs: 31 } } });
    expect(socket.close).not.toHaveBeenCalled();
    const retry = adapter.resolve(draft(), new AbortController().signal);
    socket.receive({ type: 'ERROR', id: socket.requests()[1].id, message: 'Unsupported request', model: 'backend-model',
      diagnostics: { attempts: 2, repairMs: 12 }, response: { text: '{"error":"unsupported_request"}', truncated: false } });
    await expect(retry).rejects.toMatchObject({ message: 'Unsupported request', details: { source: 'remote', diagnostics: { attempts: 2, repairMs: 12 },
      response: { text: '{"error":"unsupported_request"}', truncated: false } } });
  });

  it('replaces context and fences events from the old connection', async () => {
    const { adapter, socket } = await ready();
    const request = adapter.resolve(draft(), new AbortController().signal), oldReceive = socket.onmessage!;
    const nextContext = { ...context, id: 'fleet-v2', vessels: ['Other vessel'] }, preparation = adapter.prepare(nextContext);
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(socket.close).toHaveBeenCalledTimes(1);
    const next = FakeSocket.instances.at(-1)!; next.ready(); await preparation;
    const result = adapter.resolve({ ...draft(), contextId: nextContext.id }, new AbortController().signal);
    oldReceive({ data: JSON.stringify({ type: 'ERROR', message: 'Stale global error' }) });
    expect(next.close).not.toHaveBeenCalled();
    expect(next.messages[0].context).toEqual(nextContext);
    next.reply(next.requests()[0].id); await result;
  });

  it('preparing an unchanged context reuses the session', async () => {
    const { adapter } = await ready(); await adapter.prepare({ ...context, vessels: [...context.vessels] });
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('closes and rejects all pending work on disposal', async () => {
    const adapter = create(), preparation = adapter.prepare(context), socket = FakeSocket.instances[0];
    const request = adapter.resolve(draft(), new AbortController().signal);
    adapter.observeDraft(draft()); adapter.dispose();
    await expect(preparation).rejects.toMatchObject({ name: 'AbortError' });
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    vi.advanceTimersByTime(40_000);
    expect(socket.messages).toHaveLength(0); expect(socket.close).toHaveBeenCalledTimes(1);
    await expect(adapter.resolve(draft(), new AbortController().signal)).rejects.toThrow('disposed');
  });

  it('rejects all pending requests on socket loss and reconnects for the next request', async () => {
    const { adapter, socket } = await ready();
    const request = adapter.resolve(draft(), new AbortController().signal);
    socket.onclose?.(); await expect(request).rejects.toThrow('socket closed');
    const retry = adapter.resolve(draft(), new AbortController().signal), next = FakeSocket.instances.at(-1)!;
    next.ready(); next.reply(next.requests()[0].id); await retry;
    expect(FakeSocket.instances).toHaveLength(2);
    expect(next.requests()[0].id).not.toBe(socket.requests()[0].id);
  });

  it('bounds a stalled handshake and rejects queued requests', async () => {
    const adapter = create(), preparation = adapter.prepare(context);
    const request = adapter.resolve(draft(), new AbortController().signal);
    vi.advanceTimersByTime(10_000);
    await expect(preparation).rejects.toThrow('handshake timed out');
    await expect(request).rejects.toThrow('handshake timed out');
    expect(FakeSocket.instances[0].close).toHaveBeenCalledTimes(1);
  });

  it('bounds inference duration and explicitly cancels timed-out work', async () => {
    const { adapter, socket } = await ready(), request = adapter.resolve(draft(), new AbortController().signal);
    vi.advanceTimersByTime(35_000); await expect(request).rejects.toThrow('timed out');
    expect(socket.messages.at(-1)).toEqual({ type: 'CANCEL', id: socket.requests()[0].id });
    expect(socket.close).not.toHaveBeenCalled();
  });

  it.each(['wrong-protocol', 'wrong-version'] as const)('rejects %s during handshake', async invalid => {
    const adapter = create(), preparation = adapter.prepare(context), socket = FakeSocket.instances[0];
    if (invalid === 'wrong-protocol') socket.protocol = '';
    socket.open();
    if (invalid === 'wrong-version') socket.receive({ type: 'READY', version: 2 });
    await expect(preparation).rejects.toThrow(/protocol|readiness/);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it('retains structured connection errors before READY', async () => {
    const adapter = create(), preparation = adapter.prepare(context), socket = FakeSocket.instances[0];
    socket.open(); socket.receive({ type: 'ERROR', message: 'No provider configured', model: 'backend-model' });
    await expect(preparation).rejects.toMatchObject({ message: 'No provider configured', details: { model: 'backend-model' } });
  });

  it.each(['x'.repeat(65_537), 'é'.repeat(32_769), new ArrayBuffer(10), '{bad json'])('rejects invalid/overlarge frames', async data => {
    const { adapter, socket } = await ready(), request = adapter.resolve(draft(), new AbortController().signal);
    socket.onmessage?.({ data }); await expect(request).rejects.toBeInstanceOf(Error);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it('bounds the write buffer before committing another frame', async () => {
    const { adapter, socket } = await ready(); socket.bufferedAmount = 65_536;
    await expect(adapter.resolve(draft(), new AbortController().signal)).rejects.toThrow('send buffer is full');
    expect(socket.requests()).toHaveLength(0); expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it('rejects overlarge contexts before sending HELLO', async () => {
    const adapter = create(), preparation = adapter.prepare({ ...context, description: 'x'.repeat(65_536) }), socket = FakeSocket.instances[0];
    socket.open(); await expect(preparation).rejects.toThrow('exceeds 64 KiB');
    expect(socket.messages).toHaveLength(0);
  });
});
