/** tb1 frame codec. Mirrors crates/tb-protocol; both are tested against
 * crates/tb-protocol/vectors/frames.json. See docs/protocol-v1.md. */
export const VERSION = 1;
export const HEADER_LEN = 24;
export const STAMP_LEN = 16;
export const MAX_PAYLOAD = 16 << 20;
export const SUBPROTOCOL = 'tb1';

export const Kind = {
  HELLO: 0x01, READY: 0x02, CONTEXT: 0x03, STATUS: 0x04, ERROR: 0x05, CONFIG: 0x06,
  DRAFT: 0x10, COMMIT: 0x11, CANCEL: 0x12,
  INFER: 0x18, SQL_DELTA: 0x19, SQL: 0x1a, INFER_STATS: 0x1b, PRIME: 0x1c,
  EXEC: 0x20, RESULT_SCHEMA: 0x21, BATCH: 0x22, DONE: 0x23,
  BIND: 0x30, UNBIND: 0x31, DRAWN: 0x32, RESULT: 0x33, TIMING: 0x34, KEEP: 0x35,
} as const;
export type Kind = typeof Kind[keyof typeof Kind];
const KINDS = new Set<number>(Object.values(Kind));

export const Flag = {
  COMPOSING: 0x01, CACHED: 0x01, SPECULATIVE: 0x01, HEADER_ONLY: 0x80,
  /** SQL_DELTA: discard earlier deltas of this request (a repair restarted the SQL). */
  RESET: 0x02,
  /** DONE: served from a pre-aggregated rollup / replayed from the result cache. */
  ROLLUP: 0x01, RESULT_CACHE: 0x02,
  /** EXEC: warm the database node's result cache: run and cache, stream nothing; the sender
   * gets only DONE (with DONE_WARM) or ERROR. */
  WARM: 0x02,
  /** DONE: answers a WARM EXEC. */
  DONE_WARM: 0x04,
} as const;
/** Request ids a UI assigns itself (WARM EXECs) carry this bit; coordinator ids stay below it. */
export const SENDER_REQUEST_BIT = 0x8000_0000;
export const Node = { UI: 1, COORDINATOR: 2, INFERENCE: 3, DATABASE: 4, RENDERER: 5, PROVIDER: 6 } as const;
export const Stage = {
  KEY_INPUT: 1, DRAFT_SENT: 2, COORD_RECEIVED: 3, INFER_SENT: 4, INFER_RECEIVED: 5,
  PROVIDER_REQUEST: 6, FIRST_TOKEN: 7, SQL_FIRST_DELTA: 8, SQL_COMPLETE: 9, SQL_RECEIVED: 10,
  EXEC_SENT: 11, EXEC_RECEIVED: 12, DB_FIRST_BATCH: 13, DB_DONE: 14, RENDER_FIRST_BATCH: 15,
  FIRST_DRAW_SUBMITTED: 16, FIRST_PRESENTED: 17, CACHE_HIT: 18,
} as const;

export interface Stamp { stage: number; node: number; /** Unix epoch ms. */ at: number }
export interface Header {
  kind: Kind; flags: number; epoch: number; request: number; revision: number; context: number;
}
/** A frame. On in-process links `body` may be a live object (e.g. an Arrow RecordBatch)
 * instead of bytes; it is encoded only when crossing a thread or host boundary. */
export interface Frame<B = Uint8Array> extends Header { stamps: Stamp[]; payload: B }

export class DecodeError extends Error {
  constructor(readonly code: 'Truncated' | 'Version' | 'Kind' | 'PayloadTooLarge' | 'TrailingBytes' | 'ReservedStamp' | 'HeaderOnlyPayload', detail = '') {
    super(`tb1 ${code}${detail ? `: ${detail}` : ''}`);
  }
}

/** Unix-epoch milliseconds on the clock shared by every thread of this page. */
export const now = (): number => performance.timeOrigin + performance.now();

export function header(kind: Kind, fields: Partial<Omit<Header, 'kind'>> = {}): Header {
  return { kind, flags: 0, epoch: 0, request: 0, revision: 0, context: 0, ...fields };
}

export function encodedLength(stamps: number, payload: number): number {
  return HEADER_LEN + stamps * STAMP_LEN + payload;
}

/** Encode into a fresh ArrayBuffer that can be transferred. */
export function encode(frame: Frame): Uint8Array {
  const { stamps, payload } = frame;
  if (stamps.length > 255) throw new RangeError('too many stamps');
  if (payload.byteLength > MAX_PAYLOAD) throw new RangeError('payload too large');
  if (frame.flags & Flag.HEADER_ONLY && payload.byteLength) throw new RangeError('HEADER_ONLY with payload');
  const bytes = new Uint8Array(encodedLength(stamps.length, payload.byteLength));
  const view = new DataView(bytes.buffer);
  bytes[0] = VERSION; bytes[1] = frame.kind; bytes[2] = frame.flags; bytes[3] = stamps.length;
  view.setUint32(4, payload.byteLength, true);
  view.setUint32(8, frame.epoch, true); view.setUint32(12, frame.request, true);
  view.setUint32(16, frame.revision, true); view.setUint32(20, frame.context, true);
  let at = HEADER_LEN;
  for (const stamp of stamps) {
    view.setUint16(at, stamp.stage, true); view.setUint16(at + 2, stamp.node, true);
    view.setFloat64(at + 8, stamp.at, true); at += STAMP_LEN;
  }
  bytes.set(payload, at);
  return bytes;
}

/** Decode exactly one frame. The payload is a view into `bytes`, not a copy. */
export function decode(bytes: Uint8Array): Frame {
  const [frame, used] = decodePrefix(bytes);
  if (used !== bytes.byteLength) throw new DecodeError('TrailingBytes');
  return frame;
}

export function decodePrefix(bytes: Uint8Array): [Frame, number] {
  if (bytes.byteLength < HEADER_LEN) throw new DecodeError('Truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== VERSION) throw new DecodeError('Version', String(bytes[0]));
  if (!KINDS.has(bytes[1])) throw new DecodeError('Kind', `0x${bytes[1].toString(16)}`);
  const flags = bytes[2], count = bytes[3], len = view.getUint32(4, true);
  if (len > MAX_PAYLOAD) throw new DecodeError('PayloadTooLarge', String(len));
  if (flags & Flag.HEADER_ONLY && len) throw new DecodeError('HeaderOnlyPayload');
  const stampsEnd = HEADER_LEN + count * STAMP_LEN, end = stampsEnd + len;
  if (bytes.byteLength < end) throw new DecodeError('Truncated');
  const stamps: Stamp[] = [];
  for (let at = HEADER_LEN; at < stampsEnd; at += STAMP_LEN) {
    if (view.getUint32(at + 4, true) !== 0) throw new DecodeError('ReservedStamp');
    stamps.push({ stage: view.getUint16(at, true), node: view.getUint16(at + 2, true), at: view.getFloat64(at + 8, true) });
  }
  return [{
    kind: bytes[1] as Kind, flags, epoch: view.getUint32(8, true), request: view.getUint32(12, true),
    revision: view.getUint32(16, true), context: view.getUint32(20, true), stamps,
    payload: bytes.subarray(stampsEnd, end),
  }, end];
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true });
export const text = (value: string): Uint8Array => utf8.encode(value);
export const readText = (payload: Uint8Array): string => fromUtf8.decode(payload);
export const json = (value: unknown): Uint8Array => utf8.encode(JSON.stringify(value));
export const readJson = <T>(payload: Uint8Array): T => JSON.parse(fromUtf8.decode(payload)) as T;
