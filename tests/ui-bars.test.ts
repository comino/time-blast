import { describe, expect, it } from 'vitest';
import { barLayout } from '../src/ui/bar-layout';

describe('grouped bars', () => {
  it.each([1, 4, 25, 400])('keeps six vessel slots separate at a %s-pixel bucket width', pixels => {
    const bars = Array.from({ length: 6 }, (_, slot) => barLayout(pixels, slot, 6));
    for (let index = 1; index < bars.length; index++) {
      expect(bars[index - 1].offset + bars[index - 1].width / 2).toBeLessThan(bars[index].offset - bars[index].width / 2);
    }
    expect(bars[0].offset).toBe(-bars[5].offset);
    expect(bars[0].offset - bars[0].width / 2).toBeGreaterThan(-pixels / 2);
    expect(bars[5].offset + bars[5].width / 2).toBeLessThan(pixels / 2);
  });
  it('centers a fleet aggregate or a single filtered vessel', () => {
    expect(barLayout(30, 0, 1).offset).toBe(0);
    expect(barLayout(30, 0, 1).width).toBeGreaterThan(0);
  });
});
