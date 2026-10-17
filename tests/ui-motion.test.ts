import { describe, expect, it } from 'vitest';
import { cameraAt, defaultMotion, easeOut, sanitizeMotion } from '../src/ui/motion';
import { loadSettings } from '../src/ui/defaults';

describe('motion settings', () => {
  it('defaults on, and off when the OS asks for reduced motion', () => {
    expect(defaultMotion(false)).toEqual({ grow: true, camera: true });
    expect(defaultMotion(true)).toEqual({ grow: false, camera: false });
  });
  it('sanitizes stored values field by field', () => {
    expect(sanitizeMotion({ grow: false, camera: 'yes' })).toEqual({ grow: false, camera: defaultMotion().camera });
    expect(sanitizeMotion(null)).toBeUndefined();
    expect(sanitizeMotion(7)).toBeUndefined();
  });
  it('persists only an explicit choice', () => {
    const storage = (value: unknown) => ({ getItem: () => JSON.stringify(value) });
    expect(loadSettings(storage({ motion: { grow: false, camera: true } }))).toEqual({ motion: { grow: false, camera: true } });
    expect(loadSettings(storage({}))).toEqual({});
  });
  it('restores focus mode only from a boolean', () => {
    const storage = (value: unknown) => ({ getItem: () => JSON.stringify(value) });
    expect(loadSettings(storage({ focus: true }))).toEqual({ focus: true });
    expect(loadSettings(storage({ focus: 'yes' }))).toEqual({});
  });
});

describe('camera glide', () => {
  const viewport = { width: 1000, height: 600 };
  const from = { x: 0, y: 0, scale: 1 }, to = { x: 180, y: -40, scale: .5 };
  it('starts at the current camera and lands exactly on the target', () => {
    expect(cameraAt(from, to, 0, viewport)).toEqual(from);
    expect(cameraAt(from, to, 1, viewport)).toEqual(to);
    expect(cameraAt(from, to, 3, viewport)).toEqual(to);
  });
  it('eases out and zooms geometrically', () => {
    expect(easeOut(.5)).toBeCloseTo(.875);
    expect(cameraAt(from, { ...from, scale: .25 }, .5, viewport).scale).toBeCloseTo(.25 ** .875);
  });
  it('moves the world point under the viewport centre in a straight line', () => {
    const centre = (c: typeof from) => [(500 - c.x) / c.scale, (300 - c.y) / c.scale];
    const [a, b, m] = [centre(from), centre(to), centre(cameraAt(from, to, .5, viewport))];
    const k = easeOut(.5);
    expect(m[0]).toBeCloseTo(a[0] + (b[0] - a[0]) * k);
    expect(m[1]).toBeCloseTo(a[1] + (b[1] - a[1]) * k);
  });
});
