import { describe, expect, it, vi } from 'vitest';
import { Kind, readText, Stage } from '../src/protocol/frame';
import { UiController } from '../src/ui/controller';
import { browserRecognition, VoiceInput, type RecognitionLike, type RecognitionResultEvent, type VoiceState } from '../src/ui/voice';
import { FakeEngine, FakeHost, FakeRail, fakeClock } from './ui-fake-engine';

/** A scripted SpeechRecognition: tests push result lists as the browser would. */
class FakeRecognition implements RecognitionLike {
  continuous = false; interimResults = false; lang = '';
  onresult: RecognitionLike['onresult'] = null;
  onerror: RecognitionLike['onerror'] = null;
  onend: RecognitionLike['onend'] = null;
  onstart: RecognitionLike['onstart'] = null;
  started = false; stopped = false; aborted = false;
  private results: Array<{ text: string; final: boolean }> = [];
  start() { this.started = true; this.onstart?.({ timeStamp: 0 }); }
  stop() { this.stopped = true; }
  abort() { this.aborted = true; }
  /** Replace the current (last) interim result, or append a new one. */
  hear(text: string, final: boolean, timeStamp: number) {
    const last = this.results.at(-1);
    const resultIndex = last && !last.final ? this.results.length - 1 : this.results.length;
    this.results[resultIndex] = { text, final };
    const results = this.results.map(r => Object.assign([{ transcript: r.text }], { isFinal: r.final }));
    this.onresult?.({ resultIndex, results, timeStamp } as RecognitionResultEvent);
  }
  end(timeStamp: number) { this.onend?.({ timeStamp }); }
}

function harness() {
  const engine = new FakeEngine(), clock = fakeClock();
  const ui = new UiController(engine, new FakeHost(), new FakeRail(), { clock });
  ui.boot({ kind: 'webgpu', model: 'qwen-1.5b' }, { kind: 'fixture', name: 'vessels' });
  ui.receive({ type: 'context', context: { id: 3, name: 'vessels', dialect: 'duckdb', tables: [] } });
  engine.clear();
  let rec!: FakeRecognition;
  const states: Array<[VoiceState, string | undefined]> = [];
  let box = '';
  const voice = new VoiceInput(() => (rec = new FakeRecognition()), {
    draft: (text, t) => { box = text; ui.input(text, false, t); },
    commit: (text, t) => { box = text; ui.commit(text, t); },
    status: (state, detail) => states.push([state, detail]),
  }, { lang: 'en-GB' });
  return { engine, ui, voice, states, get rec() { return rec; }, get box() { return box; } };
}

describe('voice → DRAFT / COMMIT', () => {
  it('sends a DRAFT per changed interim transcript with KEY_INPUT = the speech event time, then a COMMIT on the final result', () => {
    const h = harness();
    h.voice.start();
    expect(h.rec).toMatchObject({ continuous: true, interimResults: true, lang: 'en-GB', started: true });
    expect(h.voice.state).toBe('listening');
    h.rec.hear('average', false, 100);
    h.rec.hear('average speed', false, 180);
    h.rec.hear('average speed', false, 200); // unchanged: no frame
    h.rec.hear('average speed per hour', false, 260);
    h.rec.hear('average speed per hour', true, 400);
    const frames = h.engine.frames;
    expect(frames.map(f => [f.kind, readText(f.payload), f.revision, f.context])).toEqual([
      [Kind.DRAFT, 'average', 1, 3], [Kind.DRAFT, 'average speed', 2, 3], [Kind.DRAFT, 'average speed per hour', 3, 3],
      [Kind.COMMIT, 'average speed per hour', 3, 3],
    ]);
    // KEY_INPUT is the recognizer event's timeStamp on the page clock (origin + timeStamp).
    expect(frames.map(f => f.stamps.find(s => s.stage === Stage.KEY_INPUT)!.at)).toEqual([1_000_100, 1_000_180, 1_000_260, 1_000_400]);
    expect(h.box).toBe('average speed per hour');
  });

  it('accumulates phrases within one session: a pause and "by vessel" refines the question', () => {
    const h = harness();
    h.voice.start();
    h.rec.hear('max wind', true, 100);
    h.rec.hear('by', false, 900);
    h.rec.hear('by vessel', true, 1000);
    expect(h.engine.frames.map(f => [f.kind, readText(f.payload)])).toEqual([
      [Kind.DRAFT, 'max wind'], [Kind.COMMIT, 'max wind'], [Kind.DRAFT, 'max wind by'], [Kind.DRAFT, 'max wind by vessel'], [Kind.COMMIT, 'max wind by vessel'],
    ]);
    // A new session starts from an empty question.
    h.rec.end(1100);
    h.voice.start();
    h.rec.hear('wave height', false, 2000);
    expect(readText(h.engine.frames.at(-1)!.payload)).toBe('wave height');
  });

  it('commits an interim transcript that never became final when the session ends', () => {
    const h = harness();
    h.voice.start();
    h.rec.hear('speed per vessel', false, 100);
    h.voice.stop();
    expect(h.rec.stopped).toBe(true);
    h.rec.end(150);
    const last = h.engine.frames.at(-1)!;
    expect([last.kind, readText(last.payload), last.stamps[0].at]).toEqual([Kind.COMMIT, 'speed per vessel', 1_000_150]);
    expect(h.voice.state).toBe('idle');
  });

  it('abort drops the session without a COMMIT; errors become a status, not frames', () => {
    const h = harness();
    h.voice.start();
    h.rec.hear('speed', false, 100);
    h.voice.abort();
    h.rec.end(120); // ignored: the session was dropped
    expect(h.engine.frames.map(f => f.kind)).toEqual([Kind.DRAFT]);
    h.voice.start();
    h.rec.onerror?.({ error: 'network', timeStamp: 5 });
    expect(h.voice.state).toBe('error');
    expect(h.states.at(-1)![1]).toMatch(/speech service/);
  });

  it('reports an error when the recognizer never starts (headless Chromium: API present, no backend)', () => {
    vi.useFakeTimers();
    try {
      const states: VoiceState[] = [];
      let rec!: FakeRecognition;
      const voice = new VoiceInput(() => { rec = new FakeRecognition(); rec.start = () => {}; return rec; }, { draft() {}, commit() {}, status: s => states.push(s) }, { startTimeoutMs: 100 });
      voice.start();
      expect(voice.state).toBe('starting');
      vi.advanceTimersByTime(100);
      expect([voice.state, voice.active]).toEqual(['error', false]);
      expect(states).toEqual(['idle', 'starting', 'error']);
    } finally { vi.useRealTimers(); }
  });

  it('reports unsupported browsers and finds the prefixed constructor', () => {
    const states: VoiceState[] = [];
    const voice = new VoiceInput(null, { draft() {}, commit() {}, status: s => states.push(s) });
    voice.start();
    expect([voice.supported, states]).toEqual([false, ['unsupported']]);
    expect(browserRecognition({})).toBeNull();
    class Webkit { continuous = false }
    expect(browserRecognition({ webkitSpeechRecognition: Webkit })!()).toBeInstanceOf(Webkit);
  });
});
