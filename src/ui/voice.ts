/**
 * Voice input: speech → DRAFT frames as words arrive, the final transcript → COMMIT.
 *
 * Uses the Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`) with
 * `continuous` and `interimResults`. Every result event whose transcript changed becomes one
 * DRAFT through the same encoder as typing, with KEY_INPUT = the speech event's `timeStamp`
 * (a "speech event", not a keystroke: the moment the recognizer delivered the words, which is
 * after the words were spoken by the recognizer's own latency). A final result becomes a COMMIT.
 * Within one listening session the transcript accumulates (finals + current interim), so a pause
 * followed by "…by vessel" refines the question instead of starting a new one; a new session
 * starts from an empty question.
 *
 * Availability: Chrome/Edge ship `webkitSpeechRecognition`, which streams audio to the vendor's
 * speech service (needs the network; error `network` offline). Firefox has none. Headless
 * Chromium exposes the constructor but has no speech backend. The recognizer is injectable so
 * tests drive this class with a fake.
 */

/** The subset of SpeechRecognition used here. */
export interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string; message?: string; timeStamp: number }) => void) | null;
  onend: ((event: { timeStamp: number }) => void) | null;
  onstart: ((event: { timeStamp: number }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export interface RecognitionResultEvent {
  /** Index of the first result that changed. */
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
  /** ms since timeOrigin, like any DOM event. */
  timeStamp: number;
}
export type RecognitionFactory = () => RecognitionLike;

/** The browser's recognizer constructor, or null when the API is missing. */
export function browserRecognition(scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): RecognitionFactory | null {
  const Ctor = (scope.SpeechRecognition ?? scope.webkitSpeechRecognition) as (new () => RecognitionLike) | undefined;
  return typeof Ctor === 'function' ? () => new Ctor() : null;
}

export type VoiceState = 'unsupported' | 'idle' | 'starting' | 'listening' | 'error';

export interface VoiceSink {
  /** Interim transcript: send a DRAFT (the input event path, minus the keyboard). */
  draft(text: string, eventTimeStamp: number): void;
  /** Final transcript: send a COMMIT. */
  commit(text: string, eventTimeStamp: number): void;
  status(state: VoiceState, detail?: string): void;
}

export interface VoiceOptions { lang?: string }

const ERRORS: Record<string, string> = {
  network: 'Speech service unreachable (Chrome sends audio to its speech service)',
  'not-allowed': 'Microphone permission denied',
  'service-not-allowed': 'Speech recognition is disabled in this browser',
  'audio-capture': 'No microphone found',
  'no-speech': 'No speech heard',
  'language-not-supported': 'Language not supported by the speech service',
};

export class VoiceInput {
  state: VoiceState;
  /** Frames this session produced, for diagnostics and tests. */
  drafts = 0;
  commits = 0;
  private recognition: RecognitionLike | null = null;
  private finals = '';
  private sent = '';
  private committed = '';

  constructor(private readonly factory: RecognitionFactory | null, private readonly sink: VoiceSink, private readonly options: VoiceOptions = {}) {
    this.state = factory ? 'idle' : 'unsupported';
    sink.status(this.state, factory ? undefined : 'Voice input is not available in this browser');
  }

  get supported(): boolean { return this.factory !== null; }
  get active(): boolean { return this.state === 'starting' || this.state === 'listening'; }

  start(): void {
    if (!this.factory || this.active) return;
    let r: RecognitionLike;
    try { r = this.factory(); } catch (error) { this.set('error', `Voice input failed to start: ${String(error)}`); return; }
    r.continuous = true;
    r.interimResults = true;
    r.lang = this.options.lang ?? (globalThis.navigator?.language || 'en-US');
    r.onstart = () => { if (this.recognition === r) this.set('listening'); };
    r.onresult = event => { if (this.recognition === r) this.result(event); };
    r.onerror = event => {
      if (this.recognition !== r) return;
      // `aborted` follows our own abort(); `no-speech` is not worth an error state.
      if (event.error === 'aborted') return;
      this.set(event.error === 'no-speech' ? 'idle' : 'error', ERRORS[event.error] ?? `Speech recognition error: ${event.error}`);
    };
    r.onend = event => {
      if (this.recognition !== r) return;
      this.recognition = null;
      this.flush(event.timeStamp);
      if (this.state !== 'error') this.set('idle');
    };
    this.recognition = r;
    this.finals = ''; this.sent = ''; this.committed = '';
    this.set('starting');
    try { r.start(); } catch (error) { this.recognition = null; this.set('error', `Voice input failed to start: ${String(error)}`); }
  }

  /** Stop listening; the recognizer delivers its last final result, then `end`. */
  stop(): void { this.recognition?.stop(); }

  toggle(): void { if (this.active) this.stop(); else this.start(); }

  /** Drop the session without committing (Escape). */
  abort(): void {
    const r = this.recognition;
    this.recognition = null;
    r?.abort();
    if (r) this.set('idle');
  }

  private result(event: RecognitionResultEvent): void {
    // Rebuild from every result of the session (robust to re-delivered or revised results).
    let interim = '', finals = '', anyFinal = false;
    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0]?.transcript ?? '';
      if (result.isFinal) { finals = join(finals, text); if (i >= event.resultIndex) anyFinal = true; } else interim = join(interim, text);
    }
    this.finals = finals;
    const transcript = join(finals, interim);
    if (transcript && transcript !== this.sent) {
      this.sent = transcript;
      this.drafts++;
      this.sink.draft(transcript, event.timeStamp);
    }
    if (anyFinal && !interim && finals && finals !== this.committed) {
      this.committed = finals;
      this.commits++;
      this.sink.commit(finals, event.timeStamp);
    }
  }

  /** On end: a transcript that never became final is committed as heard. */
  private flush(timeStamp: number): void {
    if (this.sent && this.sent !== this.committed) {
      this.committed = this.sent;
      this.commits++;
      this.sink.commit(this.sent, timeStamp);
    }
  }

  private set(state: VoiceState, detail?: string): void {
    this.state = state;
    this.sink.status(state, detail);
  }
}

const join = (a: string, b: string): string => {
  const x = a.trim(), y = b.trim();
  return x && y ? `${x} ${y}` : x || y;
};
