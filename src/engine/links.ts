/**
 * tb1 links (docs/protocol-v1.md "Nodes and links"). Three transports, one `Link` shape:
 *
 * - in-process: frames pass as objects (RESULT_SCHEMA/BATCH may carry live Arrow objects).
 *   Nothing is encoded. Delivery is synchronous by default. Measured send → listener entry
 *   (tests/engine-links.test.ts, Node 23, this host): sync p50 0.20 µs / p99 ~2 µs, microtask
 *   p50 0.6–0.7 µs / p99 3–6 µs. Microtask batching has better bulk throughput (0.17 vs 0.33
 *   µs/frame) but a microtask only runs once the producer's synchronous section ends, so a
 *   first batch would wait for the database loop to yield. Sends made from inside a listener
 *   are queued on the pair's shared pump and delivered after it returns: no listener runs
 *   inside another, and send order is preserved.
 * - MessagePort / Worker: one encoded frame per message, the frame's ArrayBuffer is
 *   transferred (never cloned). Decoded payloads are views into that buffer.
 * - WebSocket: subprotocol `tb1`, binaryType 'arraybuffer', one frame per binary message.
 *   HELLO goes first; text messages are a protocol error; close → onClose.
 */
import type { Link, LinkId, LocalFrame } from './contracts';
import { decode, encode, SUBPROTOCOL, type Frame } from '../protocol/frame';

type OnFrame = (frame: LocalFrame) => void;
type OnClose = (reason: string) => void;

/** Shared listener bookkeeping: exactly one listener per link end. */
class Endpoint {
  onFrame?: OnFrame;
  onClose?: OnClose;
  closed = false;
  listen(onFrame: OnFrame, onClose?: OnClose): void {
    if (this.onFrame) throw new Error('link already has a listener');
    this.onFrame = onFrame; this.onClose = onClose;
  }
  fireClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(reason);
  }
}

/** Frames that cross a thread or host boundary must carry bytes. */
function bytesOf(frame: LocalFrame): Frame<Uint8Array> {
  if (!(frame.payload instanceof Uint8Array)) {
    throw new TypeError(`kind 0x${frame.kind.toString(16)} carries an object payload; only in-process links may carry Arrow objects`);
  }
  return frame as Frame<Uint8Array>;
}

// ───────────────────────── in-process ─────────────────────────

export type InProcessDelivery = 'sync' | 'microtask';

/** One delivery queue per pair: no listener of a pair ever runs inside another listener of
 * the same pair, in either direction, and frames are delivered in send order. */
class Pump {
  private readonly queue: Array<InProcessEnd | LocalFrame> = [];
  private head = 0;
  private delivering = false;
  private scheduled = false;
  constructor(private readonly delivery: InProcessDelivery, private readonly maxBacklog: number) {}

  enqueue(to: InProcessEnd, frame: LocalFrame): void {
    if ((this.queue.length - this.head) >> 1 >= this.maxBacklog) throw new Error(`link ${to.id} backlog full`);
    this.queue.push(to, frame);
    if (this.delivering) return;
    if (this.delivery === 'sync') { this.run(); return; }
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.run(); });
  }
  private run(): void {
    this.delivering = true;
    try {
      // Head index instead of shift(): O(1) per frame. Frames sent by a listener during
      // delivery are appended and picked up by this same loop.
      while (this.head < this.queue.length) {
        const to = this.queue[this.head] as InProcessEnd, frame = this.queue[this.head + 1] as LocalFrame;
        this.queue[this.head] = this.queue[this.head + 1] = undefined as unknown as LocalFrame;
        this.head += 2;
        to.deliver(frame);
      }
    } finally {
      this.delivering = false;
      if (this.head >= this.queue.length) { this.queue.length = 0; this.head = 0; }
    }
  }
}

class InProcessEnd implements Link {
  readonly placement = 'in-process' as const;
  peer!: InProcessEnd;
  private readonly end = new Endpoint();
  /** Frames that arrived before this end had a listener (bounded). */
  private backlog: LocalFrame[] = [];
  constructor(readonly id: LinkId, private readonly pump: Pump, private readonly maxBacklog: number) {}

  send(frame: LocalFrame): void {
    if (this.end.closed) throw new Error(`link ${this.id} is closed`);
    this.peer.receive(frame);
  }
  listen(onFrame: OnFrame, onClose?: OnClose): void {
    this.end.listen(onFrame, onClose);
    const held = this.backlog;
    this.backlog = [];
    for (const frame of held) this.pump.enqueue(this, frame);
  }
  close(): void {
    if (this.end.closed) return;
    this.end.closed = true;
    this.backlog = [];
    this.peer.end.fireClose('peer closed');
  }
  deliver(frame: LocalFrame): void {
    if (!this.end.closed) this.end.onFrame!(frame);
  }
  private receive(frame: LocalFrame): void {
    if (this.end.closed) return;
    if (this.end.onFrame) { this.pump.enqueue(this, frame); return; }
    if (this.backlog.length >= this.maxBacklog) throw new Error(`link ${this.id} backlog full`);
    this.backlog.push(frame);
  }
}

/** Two connected ends inside one thread. `a.send` is received by `b`'s listener and vice
 * versa. `ids` name each end from its owner's point of view (the link it talks over). */
export function createInProcessPair(ids: [LinkId, LinkId], { delivery = 'sync', maxBacklog = 4096 }:
  { delivery?: InProcessDelivery; maxBacklog?: number } = {}): [Link, Link] {
  const pump = new Pump(delivery, maxBacklog);
  const a = new InProcessEnd(ids[0], pump, maxBacklog), b = new InProcessEnd(ids[1], pump, maxBacklog);
  a.peer = b; b.peer = a;
  return [a, b];
}

// ───────────────────────── MessagePort / Worker ─────────────────────────

/** The parts of MessagePort, Worker and DedicatedWorkerGlobalScope a port link needs. */
export interface PortLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  start?(): void;
  close?(): void;
  terminate?(): void;
}

export interface PortLinkOptions {
  /** Called with the encoded frame before it is posted; the default posts the raw ArrayBuffer. */
  wrap?: (bytes: ArrayBuffer) => unknown;
  /** Extract the frame ArrayBuffer from an incoming message; return undefined to ignore it. */
  unwrap?: (data: unknown) => ArrayBuffer | undefined;
  /** Frame to send before anything else (e.g. HELLO). */
  hello?: Frame<Uint8Array>;
}

class PortLink implements Link {
  readonly placement = 'worker' as const;
  private readonly end = new Endpoint();
  private readonly wrap: (bytes: ArrayBuffer) => unknown;
  private readonly unwrap: (data: unknown) => ArrayBuffer | undefined;
  private readonly onMessage = (event: MessageEvent): void => {
    if (this.end.closed) return;
    const buffer = this.unwrap(event.data);
    if (!buffer) return;
    let frame: Frame<Uint8Array>;
    try {
      frame = decode(new Uint8Array(buffer));
    } catch (error) {
      this.fail(`protocol error: ${(error as Error).message}`);
      return;
    }
    this.end.onFrame?.(frame);
  };
  private readonly onError = (): void => this.fail('worker error');

  constructor(readonly id: LinkId, private readonly port: PortLike, options: PortLinkOptions) {
    this.wrap = options.wrap ?? (bytes => bytes);
    this.unwrap = options.unwrap ?? (data => data instanceof ArrayBuffer ? data : undefined);
    port.addEventListener('message', this.onMessage);
    (port as unknown as EventTarget).addEventListener?.('messageerror', this.onError);
    port.start?.();
    if (options.hello) this.send(options.hello);
  }
  send(frame: LocalFrame): void {
    if (this.end.closed) throw new Error(`link ${this.id} is closed`);
    const bytes = encode(bytesOf(frame));
    // encode() returns a fresh, exactly-sized buffer: transfer it, never clone.
    this.port.postMessage(this.wrap(bytes.buffer as ArrayBuffer), [bytes.buffer as ArrayBuffer]);
  }
  listen(onFrame: OnFrame, onClose?: OnClose): void { this.end.listen(onFrame, onClose); }
  close(): void { this.shutdown('closed'); }
  private fail(reason: string): void { this.shutdown(reason); }
  private shutdown(reason: string): void {
    if (this.end.closed) return;
    this.port.removeEventListener('message', this.onMessage);
    // A Worker we own is terminated and a MessagePort closed. A worker's own global scope
    // also has close(), which would end the worker: leave it alone.
    if (this.port.terminate) this.port.terminate();
    else if (typeof MessagePort !== 'undefined' && this.port instanceof MessagePort) this.port.close();
    this.end.fireClose(reason);
  }
}

/** A link over a MessagePort, a Worker (from its owner) or a worker's global scope. Each
 * message is one encoded frame in a transferred ArrayBuffer (optionally wrapped). */
export function createPortLink(id: LinkId, port: PortLike, options: PortLinkOptions = {}): Link {
  return new PortLink(id, port, options);
}

// ───────────────────────── WebSocket ─────────────────────────

export interface WebSocketLinkOptions {
  /** Sent first, as soon as the socket opens. Required by protocol-v1 "Remote links". */
  hello: Frame<Uint8Array>;
  /** Frames queued while connecting (default 256); overflow closes the link. */
  maxPending?: number;
  /** For tests: a WebSocket constructor. */
  WebSocketImpl?: typeof WebSocket;
}

class WebSocketLink implements Link {
  readonly placement = 'remote' as const;
  private readonly end = new Endpoint();
  private readonly socket: WebSocket;
  private pending: Uint8Array[] | null = [];
  private readonly maxPending: number;

  constructor(readonly id: LinkId, url: string, options: WebSocketLinkOptions) {
    const Impl = options.WebSocketImpl ?? WebSocket;
    this.maxPending = options.maxPending ?? 256;
    const socket = this.socket = new Impl(url, SUBPROTOCOL);
    socket.binaryType = 'arraybuffer';
    const hello = encode(options.hello);
    socket.onopen = () => {
      if (socket.protocol && socket.protocol !== SUBPROTOCOL) { this.fail(`server chose subprotocol ${socket.protocol}`); return; }
      socket.send(hello);
      const queued = this.pending ?? [];
      this.pending = null;
      for (const bytes of queued) socket.send(bytes);
    };
    socket.onmessage = event => {
      if (this.end.closed) return;
      if (!(event.data instanceof ArrayBuffer)) { this.fail('protocol error: text message', 1002); return; }
      let frame: Frame<Uint8Array>;
      try {
        frame = decode(new Uint8Array(event.data));
      } catch (error) {
        this.fail(`protocol error: ${(error as Error).message}`, 1002);
        return;
      }
      this.end.onFrame?.(frame);
    };
    socket.onclose = event => this.end.fireClose(event.reason || `closed (${event.code})`);
    socket.onerror = () => { /* onclose follows with the reason */ };
  }
  send(frame: LocalFrame): void {
    if (this.end.closed) throw new Error(`link ${this.id} is closed`);
    const bytes = encode(bytesOf(frame));
    if (this.pending) {
      if (this.pending.length >= this.maxPending) { this.fail('send queue overflow while connecting'); return; }
      this.pending.push(bytes);
    } else {
      this.socket.send(bytes);
    }
  }
  listen(onFrame: OnFrame, onClose?: OnClose): void { this.end.listen(onFrame, onClose); }
  close(): void { this.fail('closed', 1000); }
  private fail(reason: string, code = 1000): void {
    if (this.end.closed) return;
    try { this.socket.close(code, reason.slice(0, 120)); } catch { /* already closing */ }
    this.end.fireClose(reason);
  }
}

export function createWebSocketLink(id: LinkId, url: string, options: WebSocketLinkOptions): Link {
  return new WebSocketLink(id, url, options);
}
