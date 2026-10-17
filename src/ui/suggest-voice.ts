/**
 * Wires voice input and next-question chips into the page (one call from app.ts).
 * Switches for measurement: localStorage `time-blast.suggest` = JSON `{enabled, warm, prime}`
 * (all default true).
 */
import './suggest-voice.css';
import type { UiController } from './controller';
import { SuggestController, type Chip, type SuggestOptions } from './suggest-controller';
import { SuggestChipsView } from './suggest-chips';
import { browserRecognition } from './voice';
import { mountVoice } from './voice-button';

function suggestOptions(): SuggestOptions {
  try { return JSON.parse(localStorage.getItem('time-blast.suggest') ?? '{}') as SuggestOptions; } catch { return {}; }
}

export function mountInteractions(root: HTMLElement, input: HTMLTextAreaElement, controller: UiController, afterInput: () => void) {
  const composer = root.querySelector('[data-el="composer"]')!;
  const footer = composer.querySelector('.composer-footer')!;

  // The same path as a typed question: the box shows the text, the encoder sends the frame.
  const put = (text: string) => { input.value = text; };
  const commit = (text: string, timeStamp: number) => { put(text); controller.commit(text, timeStamp); input.select(); afterInput(); };

  const pick = (chip: Chip, event: MouseEvent) => {
    if (!controller.suggested(chip.suggestion.question, chip.from, event.timeStamp, chip.suggestion.sql, chip.suggestion.view)) return;
    suggestions.picked(chip);
    put(chip.suggestion.question);
    input.select(); afterInput();
    input.focus();
  };
  const view = new SuggestChipsView(composer, pick);
  const suggestions = new SuggestController({
    send: bytes => controller.sendFrame(bytes),
    epoch: () => controller.drafts.epoch,
    context: () => controller.context,
    textOf: (revision, request) => controller.questionFor(request ?? 0, revision),
    revision: () => controller.inputSequence,
    now: () => performance.now(),
  }, view, { ...suggestOptions(), ...(controller.primeSuggestions ? {} : { prime: false }) });
  controller.observer = frame => suggestions.observe(frame);

  const voice = mountVoice(footer, browserRecognition(), {
    draft(text, timeStamp) { put(text); controller.input(text, false, timeStamp); afterInput(); },
    commit,
  });
  return { suggestions, voice: voice.voice };
}
