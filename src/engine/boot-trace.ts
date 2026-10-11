/**
 * Boot trace (docs/batch-3/cold-start.md): named instants from navigation start to "first
 * question answerable" and "rollups ready", on both threads. A mark is one `performance.now()`
 * plus an array push; the engine worker forwards its marks to the page (`{type:'trace'}`), where
 * src/ui/boot-trace.ts lines them up against the navigation start.
 *
 * Times are absolute (Unix ms, `performance.timeOrigin + performance.now()`): each thread has its
 * own time origin, so relative values would not compare.
 */
export interface BootMark {
  name: string;
  /** Unix ms with sub-ms precision. */
  at: number;
  /** Optional start of the stage (Unix ms); `at` is its end. */
  from?: number;
  detail?: string;
}

const pending: BootMark[] = [];
let sink: ((mark: BootMark) => void) | undefined;
const MAX_PENDING = 256;

export const bootClock = (): number => performance.timeOrigin + performance.now();

/** Record a mark (stage end; `from` = its start when the stage was not just the previous gap). */
export function bootMark(name: string, from?: number, detail?: string): void {
  const mark: BootMark = { name, at: bootClock() };
  if (from !== undefined) mark.from = from;
  if (detail) mark.detail = detail;
  if (sink) { sink(mark); return; }
  if (pending.length < MAX_PENDING) pending.push(mark);
}

/** Deliver marks (earlier ones first) to `fn` from now on. */
export function setBootSink(fn: (mark: BootMark) => void): void {
  sink = fn;
  for (const mark of pending.splice(0)) fn(mark);
}
