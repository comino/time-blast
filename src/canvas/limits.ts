/** Shared authoring/import limits; invalid input must fail before a durable mutation. */
export const CANVAS_LIMITS = { title: 1024, question: 16384, sql: 1024 * 1024 } as const;
export function boundedText(value: string, max: number, name: string): void {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${name} exceeds the ${max.toLocaleString('en')} character limit`);
}
