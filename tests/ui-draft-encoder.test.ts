import { describe, expect, it } from 'vitest';
import { decode, encode, Flag, header, json, Kind, Node, Stage, text } from '../src/protocol/frame';
import { DraftEncoder } from '../src/ui/draft-encoder';
import { fakeClock } from './ui-fake-engine';

function setup() {
  const clock = fakeClock();
  const sent: ArrayBuffer[] = [];
  const encoder = new DraftEncoder(bytes => sent.push(bytes), clock);
  const frames = () => sent.map(b => decode(new Uint8Array(b)));
  return { clock, sent, encoder, frames };
}

describe('DraftEncoder (keystroke hot path)', () => {
  it('sends one DRAFT per text change with increasing revisions and KEY_INPUT/DRAFT_SENT stamps', () => {
    const { clock, encoder, frames } = setup();
    encoder.context = 7;
    for (const [i, value] of ['s', 'sp', 'spe'].entries()) { clock.t = 100 + i * 10 + 0.25; encoder.draft(value, false, 100 + i * 10); }
    const out = frames();
    expect(out.map(f => [f.kind, f.revision, f.context, f.epoch, f.flags])).toEqual([
      [Kind.DRAFT, 1, 7, 0, 0], [Kind.DRAFT, 2, 7, 0, 0], [Kind.DRAFT, 3, 7, 0, 0],
    ]);
    expect(out.map(f => new TextDecoder().decode(f.payload))).toEqual(['s', 'sp', 'spe']);
    expect(out[2].stamps).toEqual([
      { stage: Stage.KEY_INPUT, node: Node.UI, at: 1_000_000 + 120 },
      { stage: Stage.DRAFT_SENT, node: Node.UI, at: 1_000_000 + 120.25 },
    ]);
  });

  it('is byte-identical to the reference codec, including non-ASCII text', () => {
    const { clock, encoder, sent } = setup();
    encoder.context = 3; encoder.epoch = 9;
    const value = 'Wellenhöhe pro Stunde 🌊 — größte Werte';
    clock.t = 55.5; encoder.draft(value, true, 50);
    const reference = encode({ ...header(Kind.DRAFT, { flags: Flag.COMPOSING, epoch: 9, revision: 1, context: 3 }),
      stamps: [{ stage: Stage.KEY_INPUT, node: Node.UI, at: 1_000_050 }, { stage: Stage.DRAFT_SENT, node: Node.UI, at: 1_000_055.5 }],
      payload: text(value) });
    expect(new Uint8Array(sent[0])).toEqual(reference);
  });

  it('skips unchanged events and resends the same revision when only composition state changes', () => {
    const { encoder, frames } = setup();
    expect(encoder.draft('ab', true, 1)).toBe(true);
    expect(encoder.draft('ab', true, 2)).toBe(false);
    expect(encoder.draft('ab', false, 3)).toBe(true);
    expect(frames().map(f => [f.revision, f.flags & Flag.COMPOSING])).toEqual([[1, Flag.COMPOSING], [1, 0]]);
  });

  it('grows the scratch buffer for long text', () => {
    const { encoder, frames } = setup();
    const long = 'x'.repeat(5000) + 'ü';
    encoder.draft(long, false, 1);
    expect(new TextDecoder().decode(frames()[0].payload)).toBe(long);
  });

  it('COMMIT carries the full text and reuses the drafted revision', () => {
    const { encoder, frames } = setup();
    encoder.draft('max wind', false, 1);
    encoder.commit('max wind', 2);
    encoder.commit('max wind by hour', 3);
    const out = frames();
    expect(out.map(f => [f.kind, f.revision])).toEqual([[Kind.DRAFT, 1], [Kind.COMMIT, 1], [Kind.COMMIT, 2]]);
    expect(new TextDecoder().decode(out[2].payload)).toBe('max wind by hour');
    expect(out[1].stamps.map(s => s.stage)).toEqual([Stage.KEY_INPUT, Stage.DRAFT_SENT]);
  });

  it('CANCEL carries a new epoch and later frames carry it too', () => {
    const { encoder, frames } = setup();
    encoder.draft('a', false, 1);
    expect(encoder.cancel()).toBe(1);
    encoder.draft('ab', false, 2);
    const out = frames();
    expect(out.map(f => [f.kind, f.epoch, f.request, f.payload.byteLength])).toEqual([[Kind.DRAFT, 0, 0, 1], [Kind.CANCEL, 1, 0, 0], [Kind.DRAFT, 1, 0, 2]]);
  });

  it('CONFIG encodes JSON without stamps', () => {
    const { encoder, sent } = setup();
    encoder.config({ live: true, freeSlots: [1, 2] });
    expect(new Uint8Array(sent[0])).toEqual(encode({ ...header(Kind.CONFIG), stamps: [], payload: json({ live: true, freeSlots: [1, 2] }) }));
  });

  it('remembers the text of the last 64 revisions', () => {
    const { encoder } = setup();
    for (let i = 1; i <= 70; i++) encoder.draft(`q${i}`, false, i);
    expect(encoder.textOf(70)).toBe('q70');
    expect(encoder.textOf(7)).toBe('q7');
    expect(encoder.textOf(6)).toBeUndefined();
    expect(encoder.textOf(71)).toBeUndefined();
  });

  it('posts a fresh buffer per frame so each can be transferred', () => {
    const { encoder, sent } = setup();
    encoder.draft('a', false, 1); encoder.draft('ab', false, 2);
    expect(sent[0]).not.toBe(sent[1]);
    expect(sent[0].byteLength).toBe(24 + 32 + 1);
  });
});
