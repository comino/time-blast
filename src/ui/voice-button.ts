/**
 * Push-to-talk DOM glue for src/ui/voice.ts.
 * - Mic button: press and hold to talk; a short click (< 300 ms) toggles hands-free listening.
 * - Keyboard: hold Ctrl+Space (or Ctrl+M) to talk; a short tap toggles. Escape stops and drops.
 */
import { VoiceInput, type RecognitionFactory, type VoiceSink, type VoiceState } from './voice';

const MIC = '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';
const HOLD_MS = 300;

export interface VoiceMount { voice: VoiceInput; button: HTMLButtonElement; label: HTMLElement }

export function mountVoice(footer: Element, factory: RecognitionFactory | null, sink: Omit<VoiceSink, 'status'>): VoiceMount {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'voice-button';
  button.dataset.el = 'voice';
  button.innerHTML = MIC;
  const label = document.createElement('span');
  label.className = 'voice-status';
  label.dataset.el = 'voice-status';
  footer.prepend(button);
  button.after(label);

  const voice = new VoiceInput(factory, {
    ...sink,
    status(state: VoiceState, detail?: string) {
      button.dataset.state = state;
      button.disabled = state === 'unsupported';
      button.setAttribute('aria-pressed', String(state === 'listening' || state === 'starting'));
      button.title = state === 'unsupported' ? (detail ?? 'Voice input unavailable') : 'Hold to talk (Ctrl+Space); click to toggle';
      button.setAttribute('aria-label', button.title);
      label.textContent = state === 'listening' ? 'Listening…' : state === 'starting' ? 'Starting mic…' : state === 'unsupported' ? 'No voice in this browser' : (detail ?? '');
      label.dataset.state = state;
    },
  });

  let downAt = 0, held = false;
  const press = () => { held = !voice.active; downAt = performance.now(); if (held) voice.start(); };
  const release = () => {
    if (!downAt) return;
    const long = performance.now() - downAt >= HOLD_MS;
    downAt = 0;
    // Held long: push-to-talk ends. Short tap that started listening: stay on (hands-free).
    // Short tap while already listening: toggle off.
    if (held ? long : true) voice.stop();
  };
  button.addEventListener('pointerdown', event => { event.preventDefault(); button.setPointerCapture?.(event.pointerId); press(); });
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  const isShortcut = (e: KeyboardEvent) => e.ctrlKey && !e.altKey && !e.metaKey && (e.code === 'Space' || e.key === 'm' || e.key === 'M');
  addEventListener('keydown', event => {
    if (isShortcut(event)) { event.preventDefault(); if (!event.repeat && !downAt) press(); }
    else if (event.key === 'Escape' && voice.active) voice.abort();
  }, true);
  addEventListener('keyup', event => {
    if (downAt && (event.code === 'Space' || event.key === 'Control' || event.key === 'm' || event.key === 'M')) release();
  }, true);
  return { voice, button, label };
}
