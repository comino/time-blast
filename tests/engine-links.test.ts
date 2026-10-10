import { describe, expect, it, vi } from 'vitest';
import { createInProcessPair, createPortLink, createWebSocketLink } from '../src/engine/links';
import type { LocalFrame } from '../src/engine/contracts';
import { decode, encode, header, json, Kind, readJson, readText, SUBPROTOCOL, text, type Frame } from '../src/protocol/frame';

const frame = (kind: number, payload: Uint8Array = new Uint8Array(0), fields = {}): Frame =>
  ({ ...header(kind as never, fields), stamps: [], payload });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('in-process link', () => {
  it('delivers objects synchronously, in order, by identity', () => {
    const [a, b] = createInProcessPair(['database', 'renderer']);
    const seen: LocalFrame[] = [];
    b.listen(f => seen.push(f));
    const live = { ...frame(Kind.BATCH), payload: { numRows: 3 } } as unknown as LocalFrame;
    a.send(frame(Kind.RESULT_SCHEMA)); a.send(live);
    expect(seen.map(f => f.kind)).toEqual([Kind.RESULT_SCHEMA, Kind.BATCH]);
    expect(seen[1]).toBe(live);
  });

  it('never recurses: a reply sent from inside a listener is delivered after the listener returns', () => {
    const [a, b] = createInProcessPair(['renderer', 'database']);
    const log: string[] = [];
    let depth = 0;
    b.listen(f => {
      depth++;
      log.push(`b${f.request}@${depth}`);
      if (f.request < 3) b.send(frame(Kind.DRAWN, undefined, { request: f.request }));
      if (f.request === 1) a.send(frame(Kind.BATCH, undefined, { request: 2 }));
      depth--;
    });
    a.listen(f => {
      depth++;
      log.push(`a${f.request}@${depth}`);
      if (f.request === 2) a.send(frame(Kind.BATCH, undefined, { request: 3 }));
      depth--;
    });
    a.send(frame(Kind.BATCH, undefined, { request: 1 }));
    // b1 runs; its reply to a is delivered synchronously (a is idle) at depth 2 is not allowed:
    // every listener invocation must see depth 1.
    expect(log.every(entry => entry.endsWith('@1'))).toBe(true);
    expect(log).toContain('b3@1');
  });

  it('buffers frames until a listener exists, bounded', () => {
    const [a, b] = createInProcessPair(['coordinator' as never, 'database'], { maxBacklog: 2 });
    a.send(frame(Kind.EXEC, undefined, { request: 1 }));
    a.send(frame(Kind.EXEC, undefined, { request: 2 }));
    expect(() => a.send(frame(Kind.EXEC, undefined, { request: 3 }))).toThrow(/backlog/);
    const seen: number[] = [];
    b.listen(f => seen.push(f.request));
    expect(seen).toEqual([1, 2]);
  });

  it('closing one end notifies the other and stops delivery', () => {
    const [a, b] = createInProcessPair(['database', 'renderer']);
    const closed = vi.fn();
    a.listen(() => {}, closed);
    b.listen(() => {});
    b.close();
    expect(closed).toHaveBeenCalledWith('peer closed');
    expect(() => b.send(frame(Kind.DONE))).toThrow(/closed/);
  });

  it('microtask delivery defers to the end of the current task', async () => {
    const [a, b] = createInProcessPair(['database', 'renderer'], { delivery: 'microtask' });
    const seen: number[] = [];
    b.listen(f => seen.push(f.request));
    a.send(frame(Kind.BATCH, undefined, { request: 1 }));
    a.send(frame(Kind.BATCH, undefined, { request: 2 }));
    expect(seen).toEqual([]);
    await Promise.resolve();
    expect(seen).toEqual([1, 2]);
  });

  it('measures sync vs microtask delivery: single-frame latency and bulk throughput', async () => {
    const n = 100_000;
    const out: string[] = [];
    for (const delivery of ['sync', 'microtask'] as const) {
      const [a, b] = createInProcessPair(['database', 'renderer'], { delivery, maxBacklog: n + 1 });
      let entered = 0, count = 0;
      b.listen(() => { entered = performance.now(); count++; });
      const f = frame(Kind.BATCH);
      // Latency: one frame at a time, send → listener entry (what a first batch sees).
      const latencies: number[] = [];
      for (let i = 0; i < 20_000; i++) {
        const t0 = performance.now();
        a.send(f);
        if (delivery === 'microtask') await Promise.resolve();
        latencies.push(entered - t0);
      }
      latencies.sort((x, y) => x - y);
      // Throughput: many sends in one task.
      count = 0;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) a.send(f);
      if (delivery === 'microtask') await Promise.resolve();
      const bulk = (performance.now() - t0) * 1000 / n;
      expect(count).toBe(n);
      const p = (q: number) => (latencies[Math.floor(q * latencies.length)] * 1000).toFixed(2);
      out.push(`${delivery}: latency p50 ${p(0.5)} µs p99 ${p(0.99)} µs; bulk ${bulk.toFixed(3)} µs/frame`);
    }
    console.log(`[engine-links] in-process ${out.join(' | ')}`);
  });
});

describe('MessagePort link', () => {
  it('encodes, transfers and decodes one frame per message; payloads are views', async () => {
    const channel = new MessageChannel();
    const post = vi.spyOn(channel.port1, 'postMessage');
    const left = createPortLink('inference', channel.port1);
    const right = createPortLink('inference', channel.port2);
    const got: Frame[] = [];
    right.listen(f => got.push(f as Frame));
    left.send({ ...frame(Kind.SQL, text('SELECT 1'), { request: 7, epoch: 2 }), stamps: [{ stage: 9, node: 3, at: 1234.5 }] });
    await tick();
    expect(got).toHaveLength(1);
    expect(readText(got[0].payload)).toBe('SELECT 1');
    expect(got[0]).toMatchObject({ kind: Kind.SQL, request: 7, epoch: 2, stamps: [{ stage: 9, node: 3, at: 1234.5 }] });
    // Payload is a view into the received frame buffer, not a copy.
    expect(got[0].payload.buffer.byteLength).toBe(24 + 16 + 8);
    // The buffer was transferred, not cloned.
    const [message, transfer] = post.mock.calls[0] as [ArrayBuffer, Transferable[]];
    expect(transfer).toEqual([message]);
    expect(message.byteLength).toBe(0); // detached after transfer
    left.close(); right.close();
  });

  it('refuses object payloads (they only exist on in-process links)', () => {
    const channel = new MessageChannel();
    const link = createPortLink('inference', channel.port1);
    expect(() => link.send({ ...frame(Kind.BATCH), payload: {} } as unknown as LocalFrame)).toThrow(TypeError);
    link.close(); channel.port2.close();
  });

  it('sends HELLO first and supports wrapped messages', async () => {
    const channel = new MessageChannel();
    const seen: unknown[] = [];
    channel.port2.onmessage = event => seen.push(event.data);
    const link = createPortLink('ui', channel.port1, {
      hello: frame(Kind.HELLO, json({ node: 'coordinator', model: 'm' })),
      wrap: bytes => ({ type: 'frame', bytes }),
      unwrap: data => (data as { type?: string }).type === 'frame' ? (data as { bytes: ArrayBuffer }).bytes : undefined,
    });
    link.send(frame(Kind.CONFIG, json({ live: true })));
    await tick();
    const kinds = seen.map(m => decode(new Uint8Array((m as { bytes: ArrayBuffer }).bytes)).kind);
    expect(kinds).toEqual([Kind.HELLO, Kind.CONFIG]);
    expect(readJson(decode(new Uint8Array((seen[0] as { bytes: ArrayBuffer }).bytes)).payload)).toEqual({ node: 'coordinator', model: 'm' });
    link.close(); channel.port2.close();
  });

  it('closes with a reason on undecodable input', async () => {
    const channel = new MessageChannel();
    const link = createPortLink('inference', channel.port1);
    const closed = vi.fn();
    link.listen(() => {}, closed);
    channel.port2.postMessage(new Uint8Array([9, 9, 9]).buffer);
    await tick();
    expect(closed).toHaveBeenCalledWith(expect.stringMatching(/protocol error/));
    channel.port2.close();
  });
});

/** Minimal WebSocket stand-in for Node tests. */
class FakeSocket {
  static last: FakeSocket;
  binaryType = 'blob';
  protocol = '';
  sent: Uint8Array[] = [];
  closed?: { code: number; reason: string };
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onclose?: (event: { code: number; reason: string }) => void;
  onerror?: () => void;
  constructor(readonly url: string, readonly protocols: string) { FakeSocket.last = this; }
  send(bytes: Uint8Array) { this.sent.push(bytes); }
  close(code: number, reason: string) { this.closed = { code, reason }; this.onclose?.({ code, reason }); }
  open(protocol = SUBPROTOCOL) { this.protocol = protocol; this.onopen?.(); }
}

describe('WebSocket link', () => {
  const make = () => createWebSocketLink('inference', 'wss://example.test/tb1', {
    hello: frame(Kind.HELLO, json({ node: 'coordinator', name: 'engine', version: 1 })),
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
  });

  it('negotiates tb1, sends HELLO first, then frames queued while connecting', () => {
    const link = make();
    const socket = FakeSocket.last;
    expect(socket.protocols).toBe(SUBPROTOCOL);
    expect(socket.binaryType).toBe('arraybuffer');
    link.send(frame(Kind.INFER, text('speed by vessel'), { request: 1 }));
    expect(socket.sent).toHaveLength(0);
    socket.open();
    expect(socket.sent.map(b => decode(b).kind)).toEqual([Kind.HELLO, Kind.INFER]);
    link.send(frame(Kind.CANCEL, undefined, { epoch: 2 }));
    expect(decode(socket.sent[2]).kind).toBe(Kind.CANCEL);
  });

  it('decodes one frame per binary message', () => {
    const link = make();
    const got: Frame[] = [];
    link.listen(f => got.push(f as Frame));
    FakeSocket.last.open();
    const bytes = encode(frame(Kind.SQL_DELTA, text('SEL'), { request: 4 }));
    FakeSocket.last.onmessage?.({ data: bytes.buffer });
    expect(got.map(f => [f.kind, f.request, readText(f.payload)])).toEqual([[Kind.SQL_DELTA, 4, 'SEL']]);
  });

  it('treats text messages as a protocol error and closes', () => {
    const link = make();
    const closed = vi.fn();
    link.listen(() => {}, closed);
    FakeSocket.last.open();
    FakeSocket.last.onmessage?.({ data: 'hello' });
    expect(FakeSocket.last.closed?.code).toBe(1002);
    expect(closed).toHaveBeenCalledWith('protocol error: text message');
    expect(() => link.send(frame(Kind.CANCEL))).toThrow(/closed/);
  });

  it('reports remote close and rejects a server that ignores the subprotocol', () => {
    const link = make();
    const closed = vi.fn();
    link.listen(() => {}, closed);
    FakeSocket.last.open('other');
    expect(closed).toHaveBeenCalledWith(expect.stringMatching(/subprotocol other/));

    const second = make();
    const closed2 = vi.fn();
    second.listen(() => {}, closed2);
    FakeSocket.last.open();
    FakeSocket.last.onclose?.({ code: 1011, reason: 'server restart' });
    expect(closed2).toHaveBeenCalledWith('server restart');
  });
});
