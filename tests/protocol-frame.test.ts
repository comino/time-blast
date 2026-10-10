import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decode, decodePrefix, DecodeError, encode, header, Kind, text } from '../src/protocol/frame';

const vectors = JSON.parse(readFileSync(new URL('../crates/tb-protocol/vectors/frames.json', import.meta.url), 'utf8'));
const cases = (list: any[]): Array<[string, any]> => list.map(v => [v.name, v]);
const hex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], byte => parseInt(byte, 16));
const toHex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

describe('tb1 frame codec', () => {
  it.each(cases(vectors.valid))('round-trips golden vector %s', (_name, v: any) => {
    const frame = decode(hex(v.hex));
    expect({ ...frame, payload: toHex(frame.payload) }).toEqual({
      kind: v.kind, flags: v.flags, epoch: v.epoch, request: v.request, revision: v.revision,
      context: v.context, stamps: v.stamps, payload: v.payload_hex,
    });
    expect(toHex(encode({ ...frame, payload: hex(v.payload_hex) }))).toBe(v.hex);
  });

  it.each(cases(vectors.invalid))('rejects invalid vector %s', (_name, v: any) => {
    expect(() => decode(hex(v.hex))).toThrowError(DecodeError);
    try { decode(hex(v.hex)); } catch (error) { expect((error as DecodeError).code).toBe(v.error); }
  });

  it('decodes payloads as views without copying', () => {
    const bytes = encode({ ...header(Kind.DRAFT, { revision: 1 }), stamps: [], payload: text('hello') });
    expect(decode(bytes).payload.buffer).toBe(bytes.buffer);
  });

  it('reads concatenated frames', () => {
    const a = encode({ ...header(Kind.DRAFT), stamps: [], payload: text('one') });
    const b = encode({ ...header(Kind.COMMIT), stamps: [], payload: text('two') });
    const joined = new Uint8Array([...a, ...b]);
    const [first, used] = decodePrefix(joined);
    expect(first.kind).toBe(Kind.DRAFT);
    expect(decode(joined.subarray(used)).kind).toBe(Kind.COMMIT);
  });
});
