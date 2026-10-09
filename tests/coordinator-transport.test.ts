import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserCoordinator, LocalCoordinatorClient, type CoordinatorOptions } from '../src/core/coordinator';
import { RemoteCoordinatorClient } from '../src/core/remote-coordinator';
import type { AdapterStatus, ColumnBatch, DatabaseAdapter, DatasetContext, Draft, InferenceAdapter,
  InferenceResult, PipelineEvent, QueryCompiler, QueryPlan, QueryRequest } from '../src/core/types';

const context: DatasetContext = { id: 'transport-fixture-v1', label: 'Fixture', rowCount: 2,
  start: 0, end: 86_400_000, vessels: ['A'], description: 'Synthetic transport fixture' };
const plan: QueryPlan = { metric: 'speed', aggregate: 'avg', bucketMinutes: 60,
  windowHours: 24, splitByVessel: false, vessel: null, view: 'line' };
const batch: ColumnBatch = { x: new Float64Array([0, 3_600_000]), y: new Float64Array([12, 14]),
  series: new Int32Array([0, 0]), length: 2, byteLength: 40 };
type Placement = 'browser' | 'remote';
type Message = Record<string, any>;

/** Explicit delivery reproduces cancel between postMessage and the receiving task. */
class QueuedMessageChannel {
  static instances: QueuedMessageChannel[] = [];
  private pending: unknown[] = [];
  private closed = false;
  port1 = {
    postMessage: (data: unknown) => { this.pending.push(structuredClone(data)); },
    close: () => { this.closed = true; },
  };
  port2 = {
    onmessage: null as ((event: { data: any }) => void) | null,
    close: () => { this.closed = true; },
  };
  constructor() { QueuedMessageChannel.instances.push(this); }
  deliver(): void {
    while (this.pending.length) {
      const data = this.pending.shift();
      if (!this.closed) this.port2.onmessage?.({ data });
    }
  }
}

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: Message[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: () => void;
  constructor(readonly url: URL, readonly protocol: string) { FakeSocket.instances.push(this); }
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  send(value: string): void { this.sent.push(JSON.parse(value)); }
  receive(value: Message): void { this.onmessage?.({ data: JSON.stringify(value) }); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  last(type: string): Message {
    const message = this.sent.filter(item => item.type === type).at(-1);
    if (!message) throw new Error(`No ${type} was sent`);
    return message;
  }
}

const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  QueuedMessageChannel.instances = [];
  FakeSocket.instances = [];
  vi.stubGlobal('MessageChannel', QueuedMessageChannel);
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', new URL('https://time-blast.test/'));
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function harness(inferencePlacement: Placement = 'browser', databasePlacement: Placement = 'browser',
  overrides: { inference?: InferenceAdapter; database?: DatabaseAdapter; speculation?: boolean } = {}) {
  const events: PipelineEvent[] = [];
  const inference: InferenceAdapter = overrides.inference ?? {
    id: `inference-${inferencePlacement}`, placement: inferencePlacement,
    prepare: vi.fn(async () => {}), observeDraft: vi.fn(), dispose: vi.fn(),
    resolve: vi.fn(async () => ({ plan, source: inferencePlacement === 'remote' ? 'remote' as const : 'template' as const })),
  };
  const database: DatabaseAdapter = overrides.database ?? {
    id: `database-${databasePlacement}`, placement: databasePlacement, prepare: vi.fn(async () => context),
    execute: vi.fn(async function* (_request: QueryRequest) { yield batch; }), dispose: vi.fn(async () => {}),
  };
  const compiler: QueryCompiler = { kind: 'rust-wasm', prepare: vi.fn(async () => {}), compile: vi.fn(() => 'VALIDATED SQL') };
  const options: CoordinatorOptions = { database, inference, compiler, context, emit: event => events.push(event),
    speculation: overrides.speculation ?? true, debounceMs: 0 };
  return { events, inference, database, compiler, options };
}

function remote(h = harness(), ready = true) {
  const statuses: AdapterStatus[] = [];
  const client = new RemoteCoordinatorClient('wss://time-blast.test/coordinator', h.options, status => statuses.push(status));
  cleanup.push(() => client.dispose());
  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  if (ready) socket.receive({ type: 'READY', version: 1 });
  return { ...h, client, socket, statuses };
}

it('ignores queued socket replies after disposal and stops after a service error',async()=>{
  const old=remote();old.client.dispose();const previous=old.statuses.length;
  old.socket.receive({type:'READY',version:1});
  old.socket.receive({type:'ERROR',message:'Late old connection error'});
  expect(old.statuses).toHaveLength(previous);
  expect(old.events.some(event=>event.type==='error')).toBe(false);
  const current=remote();current.client.commit('Average speed by hour');
  const commit=current.socket.last('COMMIT');
  current.socket.receive({type:'ERROR',message:'Service failed'});
  current.socket.receive({type:'ACCEPT',epoch:commit.epoch,commitId:commit.commitId,revision:commit.draft.revision,contextId:context.id});
  await vi.advanceTimersByTimeAsync(10);
  expect(current.inference.resolve).not.toHaveBeenCalled();
  expect(current.events.some(event=>event.type==='error'&&event.message==='Service failed')).toBe(true);
});

function prepareReply(message: Message): Message {
  return { type: 'PREPARE', epoch: message.epoch, revision: message.draft.revision, contextId: message.draft.contextId };
}
function acceptReply(message: Message): Message {
  return { type: 'ACCEPT', epoch: message.epoch, commitId: message.commitId,
    revision: message.draft.revision, contextId: message.draft.contextId };
}
const settle = () => vi.advanceTimersByTimeAsync(1);

describe('local coordinator transport cancellation', () => {
  it('fences both queued drafts and commits while admitting a later same-text commit', async () => {
    const h = harness();
    const coordinator = new BrowserCoordinator(h.options);
    const client = new LocalCoordinatorClient(coordinator, context.id);
    cleanup.push(() => client.dispose());
    const channel = QueuedMessageChannel.instances.at(-1)!;
    client.draft('Average speed by hour');
    client.commit('Average speed by hour');
    client.cancel();
    channel.deliver();
    await settle();
    expect(h.inference.observeDraft).not.toHaveBeenCalled();
    expect(h.inference.resolve).not.toHaveBeenCalled();
    expect(h.database.execute).not.toHaveBeenCalled();

    client.commit('Average speed by hour');
    channel.deliver();
    await settle();
    expect(h.inference.resolve).toHaveBeenCalledTimes(1);
    expect(h.events.filter(event => event.type === 'batch')).toHaveLength(1);
  });

  it('aborts already delivered work immediately and drops queued replacement work', async () => {
    let activeSignal: AbortSignal | undefined;
    let finish!: (value: InferenceResult) => void;
    const h = harness();
    h.inference.resolve = vi.fn((_draft: Draft, signal: AbortSignal) => {
      activeSignal = signal;
      return new Promise<InferenceResult>(resolve => { finish = resolve; });
    });
    const client = new LocalCoordinatorClient(new BrowserCoordinator(h.options), context.id);
    cleanup.push(() => client.dispose());
    const channel = QueuedMessageChannel.instances.at(-1)!;
    client.commit('Average speed by hour'); channel.deliver();
    client.commit('Maximum wind by hour'); client.cancel();
    expect(activeSignal?.aborted).toBe(true);
    channel.deliver(); finish({ plan, source: 'template' });
    await settle();
    expect(h.inference.resolve).toHaveBeenCalledTimes(1);
    expect(h.database.execute).not.toHaveBeenCalled();
    expect(h.events.some(event => event.type === 'start')).toBe(false);
  });
});

describe('remote coordinator reply binding', () => {
  it('ignores PREPARE from a canceled epoch, including after an identical draft is resubmitted', async () => {
    const h = remote();
    h.client.draft('Average speed by hour');
    const old = h.socket.last('DRAFT');
    h.client.cancel();
    h.socket.receive(prepareReply(old));
    await settle();
    expect(h.inference.resolve).not.toHaveBeenCalled();
    h.client.draft('Average speed by hour');
    const current = h.socket.last('DRAFT');
    expect(current.draft.revision).toBe(old.draft.revision);
    expect(current.epoch).not.toBe(old.epoch);
    h.socket.receive(prepareReply(old));
    await settle();
    expect(h.inference.resolve).not.toHaveBeenCalled();
    h.socket.receive(prepareReply(current));
    await settle();
    expect(h.inference.resolve).toHaveBeenCalledTimes(1);
  });

  it('requires the exact current epoch, commitId, revision, and context on ACCEPT', async () => {
    const h = remote();
    h.client.commit('Average speed by hour');
    const old = h.socket.last('COMMIT');
    h.client.cancel();
    h.client.commit('Average speed by hour');
    const current = h.socket.last('COMMIT');
    const valid = acceptReply(current);
    const invalid = [acceptReply(old), { ...valid, epoch: old.epoch }, { ...valid, commitId: old.commitId },
      { ...valid, epoch: String(current.epoch) }, { ...valid, commitId: String(current.commitId) },
      { ...valid, revision: current.draft.revision + 1 }, { ...valid, contextId: 'different-snapshot' }];
    for (const reply of invalid) h.socket.receive(reply);
    await settle();
    expect(h.inference.resolve).not.toHaveBeenCalled();
    h.socket.receive(valid); h.socket.receive(valid);
    await settle();
    expect(h.inference.resolve).toHaveBeenCalledTimes(1);
    expect(h.events.filter(event => event.type === 'complete')).toHaveLength(1);
  });

  it('distinguishes successive identical commits within one epoch', async () => {
    const h = remote();
    h.client.commit('Average speed by hour');
    const old = h.socket.last('COMMIT');
    h.client.commit('Average speed by hour');
    const current = h.socket.last('COMMIT');
    expect(current.epoch).toBe(old.epoch);
    expect(current.draft.revision).toBe(old.draft.revision);
    expect(current.commitId).not.toBe(old.commitId);
    h.socket.receive(acceptReply(old));
    await settle();
    expect(h.inference.resolve).not.toHaveBeenCalled();
    h.socket.receive(acceptReply(current));
    await settle();
    expect(h.database.execute).toHaveBeenCalledTimes(1);
  });

  it('invalidates speculative inference immediately on a newer local draft', async () => {
    const base = harness();
    let firstSignal: AbortSignal | undefined;
    let finishFirst!: (value: InferenceResult) => void;
    base.inference.resolve = vi.fn((draft: Draft, signal: AbortSignal) => {
      if (draft.text === 'Average speed by hour') {
        firstSignal = signal;
        return new Promise<InferenceResult>(resolve => { finishFirst = resolve; });
      }
      return Promise.resolve({ plan, source: 'template' as const });
    });
    const h = remote(base);
    h.client.draft('Average speed by hour');
    const old = h.socket.last('DRAFT');
    h.socket.receive(prepareReply(old)); await settle();
    expect(firstSignal?.aborted).toBe(false);
    h.client.draft('Maximum wind by hour');
    expect(firstSignal?.aborted).toBe(true);
    finishFirst({ plan, source: 'template' });
    h.socket.receive(prepareReply(old)); await settle();
    expect(h.inference.resolve).toHaveBeenCalledTimes(1);
    expect(h.database.execute).not.toHaveBeenCalled();
    h.socket.receive(prepareReply(h.socket.last('DRAFT'))); await settle();
    expect(h.inference.resolve).toHaveBeenCalledTimes(2);
    expect(h.database.execute).toHaveBeenCalledTimes(1);
    expect(h.events.some(event => event.type === 'batch')).toBe(false);
  });

  it('keeps committed work alive when a new local draft invalidates speculative work', async () => {
    let activeSignal: AbortSignal | undefined;
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const base = harness();
    base.database.execute = vi.fn(async function* (request: QueryRequest) {
      activeSignal = request.signal; yield batch; await held;
    });
    const h = remote(base);
    h.client.commit('Average speed by hour');
    h.socket.receive(acceptReply(h.socket.last('COMMIT'))); await settle();
    h.client.draft('Maximum wind by hour'); await settle();
    expect(activeSignal?.aborted).toBe(false);
    expect(h.database.execute).toHaveBeenCalledTimes(1);
    finish(); await settle();
    expect(h.events.filter(event => event.type === 'complete')).toHaveLength(1);
  });

  it('flushes only the current draft and commit after READY', async () => {
    const h = remote(harness(), false);
    h.client.draft('Old question'); h.client.commit('Old question'); h.client.cancel();
    h.client.draft('Average speed by hour'); h.client.commit('Average speed by hour');
    expect(h.socket.sent.map(message => message.type)).toEqual(['HELLO', 'CANCEL']);
    h.socket.receive({ type: 'READY', version: 1 });
    const draft = h.socket.last('DRAFT');
    const commit = h.socket.last('COMMIT');
    expect(draft.draft.text).toBe('Average speed by hour');
    expect(commit.draft.text).toBe(draft.draft.text);
    expect(commit.epoch).toBe(1);
    h.socket.receive(acceptReply(commit)); await settle();
    expect(h.database.execute).toHaveBeenCalledTimes(1);
  });

  it('does not honor a PREPARE while speculation is disabled', async () => {
    const h = remote(harness('browser', 'browser', { speculation: false }));
    h.client.draft('Average speed by hour');
    h.socket.receive(prepareReply(h.socket.last('DRAFT'))); await settle();
    expect(h.inference.resolve).not.toHaveBeenCalled();
    h.client.commit('Average speed by hour');
    h.socket.receive(acceptReply(h.socket.last('COMMIT'))); await settle();
    expect(h.database.execute).toHaveBeenCalledTimes(1);
  });
});

describe('remote control with independent data and inference placement', () => {
  it.each<[Placement, Placement]>([['browser', 'browser'], ['browser', 'remote'], ['remote', 'browser'], ['remote', 'remote']])(
    'promotes retained data once with %s inference and %s database', async (inferencePlacement, databasePlacement) => {
      const h = remote(harness(inferencePlacement, databasePlacement));
      const hello = h.socket.last('HELLO');
      expect(hello.inference.placement).toBe(inferencePlacement);
      expect(hello.database.placement).toBe(databasePlacement);
      expect(hello.dataPlane).toBe('direct-to-browser');
      h.client.draft('Average speed by hour'); await settle();
      expect(h.inference.resolve).not.toHaveBeenCalled();
      const prepared = prepareReply(h.socket.last('DRAFT'));
      h.socket.receive(prepared); h.socket.receive(prepared); await settle();
      expect(h.inference.resolve).toHaveBeenCalledTimes(1);
      expect(h.database.execute).toHaveBeenCalledTimes(1);
      expect(vi.mocked(h.database.execute).mock.calls[0][0].priority).toBe('speculative');
      expect(h.events.some(event => event.type === 'batch')).toBe(false);
      h.client.commit('Average speed by hour');
      h.socket.receive(acceptReply(h.socket.last('COMMIT'))); await settle();
      expect(h.inference.resolve).toHaveBeenCalledTimes(1);
      expect(h.database.execute).toHaveBeenCalledTimes(1);
      const delivered = h.events.filter(event => event.type === 'batch');
      expect(delivered).toHaveLength(1);
      expect(delivered[0].type === 'batch' && delivered[0].batch).toBe(batch);
      const completed = h.events.find(event => event.type === 'complete');
      expect(completed?.type === 'complete' && completed.timing.promoted).toBe(true);
      expect(h.socket.sent.every(message => ['HELLO', 'DRAFT', 'COMMIT'].includes(message.type))).toBe(true);
      expect(h.socket.sent.some(message => 'batch' in message || 'x' in message || 'y' in message)).toBe(false);
      h.socket.receive(prepared); await settle();
      expect(h.inference.resolve).toHaveBeenCalledTimes(1);
    },
  );
});
