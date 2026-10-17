/** Purely visual motion: charts grow from a seed blob, the camera glides to fit new charts.
 * Off the data path by construction: CSS transforms on the main thread's DOM never delay a
 * frame, a query or a draw (the renderer draws into its OffscreenCanvas in the worker). */

export interface MotionSettings {
  /** A new chart appears as a breathing blob and grows into the card on its first result. */
  grow: boolean;
  /** Adding or removing a chart glides the camera to fit all charts; buttons glide too. */
  camera: boolean;
}

/** Card growth from seed to full size (CSS transition, ms). */
export const GROW_MS = 340;
/** Camera glide duration (ms). */
export const GLIDE_MS = 250;
/** A seed that never receives a result (stopped, unloaded, imported) grows after this long. */
export const SEED_MAX_MS = 2500;
/** Seed blob diameter in CSS px (before the board's camera scale). */
export const SEED_PX = 64;

export function defaultMotion(reduced = prefersReducedMotion()): MotionSettings {
  return { grow: !reduced, camera: !reduced };
}

export function sanitizeMotion(raw: unknown): MotionSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Partial<MotionSettings>, base = defaultMotion();
  return { grow: typeof m.grow === 'boolean' ? m.grow : base.grow, camera: typeof m.camera === 'boolean' ? m.camera : base.camera };
}

function prefersReducedMotion(): boolean {
  try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; } catch { return false; }
}

export interface Camera { x: number; y: number; scale: number }

/** Ease-out cubic: fast start, gentle landing. */
export const easeOut = (t: number): number => 1 - (1 - t) ** 3;

/** Camera at progress `t` (0..1) of a glide. Scale interpolates geometrically so zooming
 * feels uniform; translation follows the point under the viewport centre, so the content
 * does not swing sideways while the zoom changes. */
export function cameraAt(from: Camera, to: Camera, t: number, viewport: { width: number; height: number }): Camera {
  const k = easeOut(Math.min(1, Math.max(0, t)));
  if (k === 1) return { ...to };
  const scale = from.scale * (to.scale / from.scale) ** k;
  const cx = viewport.width / 2, cy = viewport.height / 2;
  // World point at the viewport centre, interpolated between both cameras.
  const wx0 = (cx - from.x) / from.scale, wy0 = (cy - from.y) / from.scale;
  const wx1 = (cx - to.x) / to.scale, wy1 = (cy - to.y) / to.scale;
  const wx = wx0 + (wx1 - wx0) * k, wy = wy0 + (wy1 - wy0) * k;
  return { x: cx - wx * scale, y: cy - wy * scale, scale };
}

export type GrowState = 'none' | 'seed' | 'grow';
