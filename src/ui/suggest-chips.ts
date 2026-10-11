/** DOM for follow-up chips under the input (logic: suggest-controller.ts). */
import type { Chip, SuggestView } from './suggest-controller';

export class SuggestChipsView implements SuggestView {
  readonly element: HTMLElement;
  private chips: Chip[] = [];

  constructor(after: Element, private readonly onPick: (chip: Chip, event: MouseEvent) => void) {
    this.element = document.createElement('div');
    this.element.className = 'suggest-chips';
    this.element.dataset.el = 'suggest-chips';
    this.element.setAttribute('aria-label', 'Likely next questions');
    this.element.hidden = true;
    after.after(this.element);
    this.element.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-chip]');
      if (!button) return;
      const chip = this.chips.find(c => String(c.id) === button.dataset.chip);
      if (chip) onPick(chip, event);
    });
    // Keep focus in the textarea: a chip click must not blur the input.
    this.element.addEventListener('mousedown', event => event.preventDefault());
  }

  show(chips: Chip[]): void {
    this.chips = chips;
    this.element.hidden = chips.length === 0;
    this.element.replaceChildren(...chips.map(chip => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.chip = String(chip.id);
      b.dataset.kind = chip.suggestion.kind;
      b.dataset.status = chip.status;
      b.textContent = chip.suggestion.label;
      b.title = `${chip.suggestion.question}\n\n${chip.suggestion.sql}${chip.status === 'ready' ? `\n\nPrepared: ${chip.rows} rows in ${chip.warmMs?.toFixed(1)} ms (${chip.source})` : '\n\nPreparing…'}`;
      return b;
    }));
  }
}
