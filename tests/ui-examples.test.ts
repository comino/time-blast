import { describe, expect, it } from 'vitest';
import { EXAMPLES, examplesFor } from '../src/ui/examples';
import { FIXTURES } from '../src/ui/defaults';

describe('suggested prompts', () => {
  it('cover every advertised full-size fixture with 3–4 distinct prompts', () => {
    for (const name of ['vessels', 'flights', 'weather', 'cities']) {
      expect(FIXTURES.some(f => f.name === name)).toBe(true);
      const list = examplesFor(name);
      expect(list.length).toBeGreaterThanOrEqual(3); expect(list.length).toBeLessThanOrEqual(4);
      expect(new Set(list.map(e => e.prompt)).size).toBe(list.length);
    }
  });
  it('match the context name case-insensitively and offer nothing for user data', () => {
    expect(examplesFor(' Flights ')).toBe(EXAMPLES.flights);
    expect(examplesFor('my_upload.csv')).toEqual([]);
  });
});
