/**
 * Remote database placement (src/engine/remote-database.ts) against a fake link: the same
 * DatabaseNode contract as the in-browser node, Arrow IPC frames decoded into objects whose
 * buffers are views into the received message, fencing, reconnects and placement switching.
 * The Arrow bytes are real ClickHouse output (crates/database-server/tests/fixtures).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Message, RecordBatch, Schema } from 'apache-arrow';
import type { DatabaseNode, DatasetContext, Link, LocalFrame } from '../src/engine/contracts';
import { createPlacedDatabase, RemoteDatabaseNode, type RemoteDatasetSource } from '../src/engine/remote-database';
import { decode, encode, header, json, Kind, readJson, Stage, text, type Frame } from '../src/protocol/frame';

const SMALL = new Uint8Array(readFileSync(new URL('../crates/database-server/tests/fixtures/small.arrows', import.meta.url)));

/** Split an Arrow IPC stream into encapsulated messages (what the server forwards). */
function messages(stream: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  let at = 0;
  while (at < stream.length) {
    const metaLen = view.getInt32(at + 4, true);
    if (metaLen === 0) break;
    const message = Message.decode(stream.subarray(at + 8, at + 8 + metaLen));
    const end = at + 8 + metaLen + Number(message.bodyLength);
    out.push(stream.subarray(at, end));
    at = end;
  }
  return out;
}

class FakeLink implements Link {
  readonly id = 'database' as const;
  readonly placement = 'remote' as const;
  sent: Frame[] = [];
  closed = false;
  private onFrame?: (frame: LocalFrame) => void;
  private onClose?: (reason: string) => void;
  constructor(readonly hello: Frame) {}
  send(frame: LocalFrame): void { this.sent.push(frame as Frame); }
  listen(onFrame: (frame: LocalFrame) => void, onClose?: (reason: string) => void): void { this.onFrame = onFrame; this.onClose = onClose; }
  close(): void { this.closed = true; }
  /** Deliver a frame the way a WebSocket does: encoded, in its own ArrayBuffer. Returns that buffer. */
  deliver(frame: Frame): ArrayBuffer {
    const bytes = encode(frame);
    this.onFrame!(decode(new Uint8Array(bytes.buffer)));
    return bytes.buffer as ArrayBuffer;
  }
  drop(reason: string): void { this.onClose!(reason); }
}

const SOURCE: RemoteDatasetSource = { kind: 'remote', name: 'vessels', endpoint: 'ws://db.test/session' };
const contextFor = (id: number): DatasetContext => ({
  id, name: 'vessels', dialect: 'clickhouse',
  tables: [{ name: 'telemetry', rows: 1209600, columns: [{ name: 'ts', type: "DateTime64(6, 'UTC')" }] }],
});

async function opened(options: { reconnectDelays?: number[] } = {}) {
  const links: FakeLink[] = [];
  const emitted: LocalFrame[] = [];
  const node = new RemoteDatabaseNode(frame => emitted.push(frame), {
    connect: (_endpoint, hello) => { const link = new FakeLink(hello); links.push(link); return link; },
    ...options,
  });
  const opening = node.open(SOURCE as never, 7);
  const link = links[0];
  expect(readJson<{ context: number; node: string }>(link.hello.payload)).toMatchObject({ context: 7, node: 'coordinator' });
  link.deliver({ ...header(Kind.READY, {}), stamps: [], payload: json({ node: 'database' }) });
  link.deliver({ ...header(Kind.CONTEXT, { context: 7 }), stamps: [], payload: json(contextFor(7)) });
  const context = await opening;
  return { node, links, link, emitted, context };
}

const exec = (request: number, fields: Partial<Frame> = {}): Frame =>
  ({ ...header(Kind.EXEC, { request, epoch: 1, revision: 3, context: 7, ...fields }), stamps: [], payload: text('SELECT 1') });
const reply = (kind: number, request: number, payload: Uint8Array, fields: Partial<Frame> = {}): Frame =>
  ({ ...header(kind as Frame['kind'], { request, epoch: 1, revision: 3, context: 7, ...fields }), stamps: [], payload });
const done = (rows: number): Uint8Array => { const p = new Uint8Array(16); new DataView(p.buffer).setBigUint64(0, BigInt(rows), true); return p; };
const kinds = (frames: LocalFrame[]) => frames.filter(f => f.kind !== Kind.STATUS).map(f => f.kind);

describe('RemoteDatabaseNode', () => {
  it('opens with the host context id and reports STATUS', async () => {
    const { context, emitted } = await opened();
    expect(context.id).toBe(7);
    expect(context.dialect).toBe('clickhouse');
    const states = emitted.filter(f => f.kind === Kind.STATUS).map(f => readJson<{ state: string }>(f.payload as Uint8Array).state);
    expect(states).toEqual(['loading', 'ready']);
  });

  it('forwards EXEC and turns IPC frames into Arrow objects viewing the received message', async () => {
    const { node, link, emitted } = await opened();
    node.handle(exec(1));
    expect(link.sent.at(-1)!.kind).toBe(Kind.EXEC);
    const [schemaMsg, ...batchMsgs] = messages(SMALL);
    link.deliver({ ...reply(Kind.RESULT_SCHEMA, 1, schemaMsg), stamps: [{ stage: Stage.EXEC_RECEIVED, node: 4, at: 1 }] });
    const buffers = batchMsgs.map(m => link.deliver(reply(Kind.BATCH, 1, m)));
    link.deliver(reply(Kind.DONE, 1, done(10)));

    expect(kinds(emitted)).toEqual([Kind.RESULT_SCHEMA, Kind.BATCH, Kind.BATCH, Kind.BATCH, Kind.DONE]);
    const frames = emitted.filter(f => f.kind !== Kind.STATUS);
    const schema = frames[0].payload as Schema;
    expect(schema).toBeInstanceOf(Schema);
    expect(schema.fields.map(f => f.name)).toEqual(['n', 's', 't', 'dt']);
    expect(frames[0].stamps[0].stage).toBe(Stage.EXEC_RECEIVED);
    expect(frames[0]).toMatchObject({ request: 1, epoch: 1, revision: 3, context: 7 });
    const batches = frames.slice(1, 4).map(f => f.payload as RecordBatch);
    expect(batches.every(b => b instanceof RecordBatch)).toBe(true);
    expect(batches.map(b => b.numRows)).toEqual([4, 4, 2]);
    expect(batches.flatMap(b => Array.from(b.getChild('n')!.toArray() as BigUint64Array, Number))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(batches[0].getChild('s')!.get(3)).toBe('3');
    // Zero copy: every column buffer is a view into the WebSocket message's ArrayBuffer.
    batches.forEach((batch, i) => {
      for (const column of batch.schema.fields.map(f => batch.getChild(f.name)!)) {
        expect(column.data[0].values.buffer).toBe(buffers[i]);
      }
    });
  });

  it('drops frames of cancelled requests, older epochs and other contexts', async () => {
    const { node, link, emitted } = await opened();
    const [schemaMsg, batchMsg] = messages(SMALL);
    node.handle(exec(1));
    node.handle(exec(2));
    node.handle({ ...header(Kind.CANCEL, { request: 1, epoch: 1 }), stamps: [], payload: new Uint8Array(0) });
    expect(link.sent.at(-1)).toMatchObject({ kind: Kind.CANCEL, request: 1 });
    // Already on the wire for request 1: dropped, including its DONE.
    link.deliver(reply(Kind.RESULT_SCHEMA, 1, schemaMsg));
    link.deliver(reply(Kind.BATCH, 1, batchMsg));
    link.deliver(reply(Kind.DONE, 1, done(4)));
    link.deliver(reply(Kind.RESULT_SCHEMA, 2, schemaMsg));
    link.deliver(reply(Kind.DONE, 2, done(0)));
    expect(kinds(emitted)).toEqual([Kind.RESULT_SCHEMA, Kind.DONE]);
    expect(emitted.filter(f => f.kind !== Kind.STATUS).every(f => f.request === 2)).toBe(true);

    // Full CANCEL raises the epoch: older replies and older EXECs are dropped.
    node.handle(exec(3));
    node.handle({ ...header(Kind.CANCEL, { request: 0, epoch: 2 }), stamps: [], payload: new Uint8Array(0) });
    link.deliver(reply(Kind.DONE, 3, done(1)));
    const sent = link.sent.length;
    node.handle(exec(4, { epoch: 1 }));
    node.handle(exec(5, { context: 8, epoch: 2 }));
    expect(link.sent.length).toBe(sent);
    expect(kinds(emitted)).toEqual([Kind.RESULT_SCHEMA, Kind.DONE]);
    expect(node.dropped).toBeGreaterThanOrEqual(5);
  });

  it('fails in-flight requests when the link drops, then reconnects and restores the epoch', async () => {
    vi.useFakeTimers();
    try {
      const { node, links, link, emitted } = await opened({ reconnectDelays: [10] });
      node.handle({ ...header(Kind.CANCEL, { request: 0, epoch: 4 }), stamps: [], payload: new Uint8Array(0) });
      node.handle(exec(9, { epoch: 4 }));
      link.drop('network');
      const error = emitted.find(f => f.kind === Kind.ERROR)!;
      expect(error).toMatchObject({ request: 9, epoch: 4, context: 7 });
      expect(readJson<{ code: string }>(error.payload as Uint8Array).code).toBe('unavailable');
      // While down, EXEC fails fast instead of hanging.
      node.handle(exec(10, { epoch: 4 }));
      expect(emitted.filter(f => f.kind === Kind.ERROR).map(f => f.request)).toEqual([9, 10]);
      await vi.advanceTimersByTimeAsync(10);
      expect(links.length).toBe(2);
      const again = links[1];
      expect(readJson<{ context: number }>(again.hello.payload).context).toBe(7);
      again.deliver({ ...header(Kind.CONTEXT, { context: 7 }), stamps: [], payload: json(contextFor(7)) });
      expect(again.sent[0]).toMatchObject({ kind: Kind.CANCEL, request: 0, epoch: 4 });
      node.handle(exec(11, { epoch: 4 }));
      expect(again.sent.at(-1)).toMatchObject({ kind: Kind.EXEC, request: 11 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects open when the server answers another context or an error', async () => {
    const links: FakeLink[] = [];
    const node = new RemoteDatabaseNode(() => {}, { connect: (_e, hello) => { const l = new FakeLink(hello); links.push(l); return l; } });
    const first = node.open(SOURCE as never, 3);
    links[0].deliver({ ...header(Kind.ERROR, {}), stamps: [], payload: json({ code: 'dataset', message: 'database has no tables' }) });
    await expect(first).rejects.toThrow('database has no tables');
    expect(links[0].closed).toBe(true);
    const second = node.open(SOURCE as never, 4);
    links[1].deliver({ ...header(Kind.CONTEXT, { context: 9 }), stamps: [], payload: json(contextFor(9)) });
    await expect(second).rejects.toThrow('context 9');
  });
});

describe('createPlacedDatabase', () => {
  it('boots the local engine only for local sources and routes frames to the active node', async () => {
    const local: DatabaseNode & { frames: Frame[] } = {
      frames: [],
      open: vi.fn(async (_s, id) => contextFor(id)),
      handle(frame) { this.frames.push(frame); },
      dispose: vi.fn(),
    };
    const createLocal = vi.fn(async () => local);
    const links: FakeLink[] = [];
    const node = await createPlacedDatabase(createLocal, {
      connect: (_e, hello) => { const l = new FakeLink(hello); links.push(l); return l; },
    })(() => {});

    const remoteOpen = node.open(SOURCE as never, 1);
    links[0].deliver({ ...header(Kind.CONTEXT, { context: 1 }), stamps: [], payload: json(contextFor(1)) });
    await remoteOpen;
    expect(createLocal).not.toHaveBeenCalled();
    node.handle(exec(1, { context: 1 }));
    expect(links[0].sent.at(-1)).toMatchObject({ kind: Kind.EXEC, request: 1 });

    await node.open({ kind: 'fixture', name: 'vessels' }, 2);
    expect(createLocal).toHaveBeenCalledTimes(1);
    // Switching away cancels the remote node's work (closes nothing: it may be reopened).
    expect(links[0].sent.at(-1)).toMatchObject({ kind: Kind.CANCEL, request: 0 });
    node.handle(exec(2, { context: 2 }));
    expect(local.frames.map(f => f.request)).toEqual([2]);
    node.handle({ ...header(Kind.CANCEL, { request: 0, epoch: 3 }), stamps: [], payload: new Uint8Array(0) });
    expect(local.frames.at(-1)!.kind).toBe(Kind.CANCEL);
    expect(links[0].sent.at(-1)).toMatchObject({ kind: Kind.CANCEL, epoch: 3 });
    node.dispose();
    expect(local.dispose).toHaveBeenCalled();
    expect(links[0].closed).toBe(true);
  });
});
