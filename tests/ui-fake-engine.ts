/** Test helper (not a test file): a fake engine worker end for the UI controller. It decodes
 * every frame the UI posts and lets tests script engine → UI frames. */
import { decode, encode, header, json, type Frame, type Kind, type Stamp } from '../src/protocol/frame';
import type { AxisTicks, SlotSize, UiToEngine, ViewName } from '../src/engine/contracts';
import type { CardHandlers, EnginePort, ErrorInfo, RailView, ResultInfo, SlotCard, SlotHost, StatusInfo } from '../src/ui/controller';
import type { InferStats, RollingSummary, TimingBreakdown } from '../src/ui/timing';

export interface Posted { message: UiToEngine; transfer: Transferable[] }

export class FakeEngine implements EnginePort {
  readonly posted: Posted[] = [];
  postMessage(message: UiToEngine, transfer: Transferable[] = []): void {
    if (message.type === 'frame' && !transfer.includes(message.bytes)) throw new Error('frame buffer was not transferred');
    this.posted.push({ message, transfer });
  }
  /** Decoded frames the UI sent, in order. */
  get frames(): Frame[] {
    return this.posted.filter(p => p.message.type === 'frame').map(p => decode(new Uint8Array((p.message as { bytes: ArrayBuffer }).bytes)));
  }
  messages<T extends UiToEngine['type']>(type: T): Extract<UiToEngine, { type: T }>[] {
    return this.posted.map(p => p.message).filter((m): m is Extract<UiToEngine, { type: T }> => m.type === type);
  }
  clear(): void { this.posted.length = 0; }
}

export const slotPayload = (slot: number): Uint8Array => new Uint8Array(new Uint32Array([slot]).buffer);

/** Encode an engine → UI frame as the engine worker would post it. */
export function engineFrame(kind: Kind, fields: { request?: number; revision?: number; flags?: number } = {}, payload: Uint8Array = new Uint8Array(0), stamps: Stamp[] = []): { type: 'frame'; bytes: ArrayBuffer } {
  const bytes = encode({ ...header(kind, fields), stamps, payload });
  return { type: 'frame', bytes: bytes.buffer as ArrayBuffer };
}
export const jsonPayload = json;

export class FakeCard implements SlotCard {
  visible = false; kept = false; destroyed = false;
  titleText = ''; titleRevision = 0;
  lastResult?: { info: ResultInfo; request: number };
  lastViews?: { available: ViewName[]; chosen: ViewName };
  lastAxes?: AxisTicks;
  lastTable?: { columns: string[]; rows: string[][]; total: number };
  lastTiming?: TimingBreakdown;
  lastStats?: InferStats;
  errors: ErrorInfo[] = [];
  constructor(readonly slot: number, readonly handlers: CardHandlers) {}
  showLive(): void { this.visible = true; }
  hide(): void { this.visible = false; }
  keep(): void { this.kept = true; this.visible = true; }
  title(text: string, revision: number): void { this.titleText = text; this.titleRevision = revision; }
  result(info: ResultInfo, request: number): void { this.lastResult = { info, request }; }
  views(available: ViewName[], chosen: ViewName): void { this.lastViews = { available, chosen }; }
  axes(ticks: AxisTicks): void { this.lastAxes = ticks; }
  table(columns: string[], rows: string[][], total: number): void { this.lastTable = { columns, rows, total }; }
  timing(t: TimingBreakdown): void { this.lastTiming = t; }
  inferStats(s: InferStats): void { this.lastStats = s; }
  error(e: ErrorInfo): void { this.errors.push(e); }
  destroy(): void { this.destroyed = true; this.visible = false; }
}

export class FakeHost implements SlotHost {
  readonly cards = new Map<number, FakeCard>();
  readonly downloads: Array<{ blob: Blob; filename: string }> = [];
  create(slot: number, handlers: CardHandlers): { card: SlotCard; canvas: OffscreenCanvas; size: SlotSize } {
    const card = new FakeCard(slot, handlers);
    this.cards.set(slot, card);
    return { card, canvas: { fakeCanvas: slot } as unknown as OffscreenCanvas, size: { width: 500, height: 300, devicePixelRatio: 2 } };
  }
  download(blob: Blob, filename: string): void { this.downloads.push({ blob, filename }); }
}

export class FakeRail implements RailView {
  statuses: StatusInfo[] = [];
  contexts: unknown[] = [];
  timings: Array<{ t: TimingBreakdown; summary: RollingSummary; stats?: InferStats }> = [];
  stats: Array<{ request: number; s: InferStats; total: number }> = [];
  errors: Array<{ e: ErrorInfo; request: number }> = [];
  lives: Array<[number | null, number]> = [];
  keptSlots: Array<[number, string]> = [];
  kept(slot: number, title: string): void { this.keptSlots.push([slot, title]); }
  status(s: StatusInfo): void { this.statuses.push(s); }
  context(c: unknown): void { this.contexts.push(c); }
  timing(t: TimingBreakdown, summary: RollingSummary, stats: InferStats | undefined): void { this.timings.push({ t, summary, stats }); }
  inferStats(request: number, s: InferStats, total: number): void { this.stats.push({ request, s, total }); }
  error(e: ErrorInfo, request: number): void { this.errors.push({ e, request }); }
  live(slot: number | null, revision: number): void { this.lives.push([slot, revision]); }
}

/** A deterministic clock: timeOrigin 1_000_000, now() = origin + t. */
export function fakeClock(start = 0) {
  const clock = { origin: 1_000_000, t: start, now: () => clock.origin + clock.t };
  return clock;
}
