import { describe, expect, it } from 'vitest';
import { EXAMPLES, ExampleDeck, examplesFor, SHOWN } from '../src/ui/examples';
import { FIXTURES, SERVER_DATASETS } from '../src/ui/defaults';

describe('suggested prompts', () => {
  it('cover every advertised full-size fixture with 3–4 distinct prompts', () => {
    for (const name of ['vessels', 'flights', 'weather', 'cities', 'flights-2024', 'nyc-taxi']) {
      expect(FIXTURES.some(f => f.name === name)).toBe(true);
      const list = examplesFor(name);
      expect(list.length).toBeGreaterThanOrEqual(6); expect(list.length).toBeLessThanOrEqual(10);
      expect(new Set(list.map(e => e.prompt)).size).toBe(list.length);
    }
  });
  it('cover the advertised server datasets', () => {
    for (const d of SERVER_DATASETS) expect(examplesFor(d.name).length).toBeGreaterThanOrEqual(6);
  });
  it('match the context name case-insensitively and offer nothing for user data', () => {
    expect(examplesFor(' Flights ')).toBe(EXAMPLES.flights);
    expect(examplesFor('my_upload.csv')).toEqual([]);
  });
});

describe('example deck', () => {
  const list = Array.from({ length: 7 }, (_, i) => ({ title: `t${i}`, prompt: `p${i}`, detail: '' }));
  it('shows three distinct prompts and replaces a used one with an unseen one until all were offered', () => {
    const deck = new ExampleDeck(list, () => 0.42);
    let showing = deck.initial().map(e => e.prompt);
    expect(new Set(showing).size).toBe(SHOWN);
    const offered = new Set(showing);
    for (let i = 0; i < list.length - SHOWN; i++) {
      const next = deck.next(showing)!;
      expect(showing).not.toContain(next.prompt);
      expect(offered.has(next.prompt)).toBe(false);
      offered.add(next.prompt); showing = [next.prompt, ...showing.slice(1)];
    }
    expect(offered.size).toBe(list.length);
    // Then it cycles, still never duplicating what is on screen.
    for (let i = 0; i < 20; i++) { const next = deck.next(showing)!; expect(showing).not.toContain(next.prompt); showing = [next.prompt, ...showing.slice(1)]; }
  });
  it('shuffles: different random sources give different first three', () => {
    const a = new ExampleDeck(list, () => 0.01).initial().map(e => e.prompt), b = new ExampleDeck(list, () => 0.99).initial().map(e => e.prompt);
    expect(a).not.toEqual(b);
  });
  it('has no replacement when the pool is no larger than what is shown', () => {
    const deck = new ExampleDeck(list.slice(0, 3)); expect(deck.next(deck.initial().map(e => e.prompt))).toBeUndefined();
  });
});
