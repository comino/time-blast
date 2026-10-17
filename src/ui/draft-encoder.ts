/** The main thread's hot path: keystroke → one tb1 frame in a fresh, transferable
 * ArrayBuffer. Writes the header, two stamps and the UTF-8 text directly; no Frame
 * objects, no stamp arrays, no DataView. Byte-identical to `encode()` in
 * src/protocol/frame.ts (tested). */
import { Flag, HEADER_LEN, Kind, Node, STAMP_LEN, Stage, VERSION, json } from '../protocol/frame';

/** Receives each encoded frame; the caller transfers the buffer. */
export type PostFrame = (bytes: ArrayBuffer) => void;
export interface Clock { origin: number; now(): number }

const REVISION_RING = 64;
const utf8 = new TextEncoder();
// f64 → bytes without a DataView per frame.
const f64 = new Float64Array(1), f64Bytes = new Uint8Array(f64.buffer);
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function u32(out: Uint8Array, at: number, value: number): void {
  out[at] = value; out[at + 1] = value >>> 8; out[at + 2] = value >>> 16; out[at + 3] = value >>> 24;
}
function stamp(out: Uint8Array, at: number, stage: number, node: number, time: number): void {
  out[at] = stage; out[at + 1] = stage >>> 8; out[at + 2] = node; out[at + 3] = node >>> 8;
  // bytes 4..7 reserved = 0 (fresh buffer)
  f64[0] = time;
  if (littleEndian) out.set(f64Bytes, at + 8);
  else for (let i = 0; i < 8; i++) out[at + 8 + i] = f64Bytes[7 - i];
}

const browserClock: Clock = {
  get origin() { return performance.timeOrigin; },
  now: () => performance.timeOrigin + performance.now(),
};

export class DraftEncoder {
  /** Last revision assigned (monotonic per editor). */
  revision = 0;
  /** Current cancellation epoch; every frame carries it. */
  epoch = 0;
  /** Current dataset context id (0 until the engine reports one). */
  context = 0;
  /** Frames posted, for diagnostics. */
  sent = 0;
  private text = '';
  private composing = false;
  private scratch = new Uint8Array(1024);
  private readonly texts: string[] = new Array(REVISION_RING);
  private target?: { slot: number; generation: number };
  private fresh = false;

  constructor(private readonly post: PostFrame, private readonly clock: Clock = browserClock) {}

  /** Each target generation has an independent edit sequence. Resuming a saved
   * draft starts at its stored sequence; the next edit is always sent. */
  setTarget(target: { slot: number; generation: number } | undefined, sequence = 0, seededText?: string): void {
    this.target = target;
    this.revision = sequence;
    this.text = seededText ?? ''; this.composing = false; this.texts.fill(''); this.fresh = seededText === undefined;
    if (seededText !== undefined) this.texts[sequence % REVISION_RING] = seededText;
  }

  /** One input/composition event. Bumps the revision when the text changed and sends a
   * DRAFT; a pure composition-state change resends the same revision with the new flag.
   * `eventTimeStamp` is `event.timeStamp` (ms since timeOrigin). Returns whether a frame went out. */
  draft(value: string, composing: boolean, eventTimeStamp: number): boolean {
    const changed = this.fresh || value !== this.text;
    if (!changed && composing === this.composing) return false;
    if (changed) this.remember(value);
    this.composing = composing;
    this.send(Kind.DRAFT, composing ? Flag.COMPOSING : 0, value, this.clock.origin + eventTimeStamp);
    return true;
  }

  /** Enter: COMMIT with the full text. Reuses the current revision when the text is the one
   * already drafted, so the coordinator can KEEP the live result without new work. */
  commit(value: string, eventTimeStamp: number): void {
    if (this.fresh || value !== this.text) this.remember(value);
    this.composing = false;
    this.send(Kind.COMMIT, 0, value, this.clock.origin + eventTimeStamp);
  }

  /** Escape / Stop: CANCEL everything under a new epoch. Later frames carry the new epoch. */
  cancel(request = 0): number {
    this.epoch = (this.epoch + 1) >>> 0;
    const out = new Uint8Array(HEADER_LEN);
    this.header(out, Kind.CANCEL, 0, 0, 0, 0);
    u32(out, 12, request); u32(out, 16, 0); u32(out, 20, 0);
    this.sent++; this.post(out.buffer);
    return this.epoch;
  }

  /** CONFIG (cold path): JSON payload, no stamps. */
  config(value: object): void {
    const payload = json(value);
    const out = new Uint8Array(HEADER_LEN + payload.byteLength);
    this.header(out, Kind.CONFIG, 0, 0, payload.byteLength, 0);
    out.set(payload, HEADER_LEN);
    this.sent++; this.post(out.buffer);
  }

  /** Text of a recent revision (the last 64 are kept), for card titles. */
  textOf(revision: number): string | undefined {
    if (revision <= 0 || revision > this.revision || this.revision - revision >= REVISION_RING) return undefined;
    return this.texts[revision % REVISION_RING];
  }

  get currentText(): string { return this.text; }

  private remember(value: string): void {
    this.fresh = false;
    this.revision = (this.revision + 1) >>> 0;
    this.text = value;
    this.texts[this.revision % REVISION_RING] = value;
  }

  private header(out: Uint8Array, kind: number, flags: number, stamps: number, len: number, revision: number): void {
    out[0] = VERSION; out[1] = kind; out[2] = flags; out[3] = stamps;
    u32(out, 4, len); u32(out, 8, this.epoch); u32(out, 12, 0); u32(out, 16, revision); u32(out, 20, this.context);
  }

  private send(kind: number, flags: number, value: string, keyAt: number): void {
    // Worst case 3 bytes per UTF-16 unit; encode once into reusable scratch, then
    // allocate the exact frame (decoders reject trailing bytes).
    const worst = value.length * 3;
    if (worst > this.scratch.length) this.scratch = new Uint8Array(Math.max(worst, this.scratch.length * 2));
    const { written } = utf8.encodeInto(value, this.scratch);
    const payloadAt = HEADER_LEN + 2 * STAMP_LEN;
    const prefix = this.target ? 4 : 0;
    const out = new Uint8Array(payloadAt + prefix + written);
    this.header(out, kind, flags, 2, prefix + written, this.revision);
    if (this.target) { u32(out, 12, this.target.slot); u32(out, payloadAt, this.target.generation); }
    out.set(written === this.scratch.length ? this.scratch : this.scratch.subarray(0, written), payloadAt + prefix);
    stamp(out, HEADER_LEN, Stage.KEY_INPUT, Node.UI, keyAt);
    stamp(out, HEADER_LEN + STAMP_LEN, Stage.DRAFT_SENT, Node.UI, this.clock.now());
    this.sent++;
    this.post(out.buffer);
  }
}
