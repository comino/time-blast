/** Stable vessel slots keep same-timestamp bars separate as batches arrive. */
export function barLayout(bucketPixels: number, slot: number, count: number) {
  const slots = Math.max(1, count);
  const groupWidth = Math.min(20 * slots, Math.max(0, bucketPixels) * 0.72);
  const slotWidth = groupWidth / slots;
  return { width: slotWidth * 0.88, offset: (slot - (slots - 1) / 2) * slotWidth };
}
