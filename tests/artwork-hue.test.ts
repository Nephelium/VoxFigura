import { describe, expect, it } from 'vitest';
import { artworkHueShift, colorHue, dominantImageHue } from '../src/styles/artwork-hue';

describe('navigation artwork hue', () => {
  it('uses the short path across red and leaves achromatic colors unassigned', () => {
    expect(colorHue('#f00')).toBe(0);
    expect(colorHue('#222')).toBeUndefined();
    expect(artworkHueShift('swiss', 351, undefined, 1)).toBe(-5);
  });

  it('uses the selected background and keeps the correction bounded', () => {
    expect(artworkHueShift('neumorphism', 209, 120, 1)).toBeLessThan(0);
    expect(artworkHueShift('neumorphism', 209, 120, 0)).toBe(0);
    expect(artworkHueShift('neumorphism', 20, undefined, 1)).toBe(34);
    expect(artworkHueShift('bauhaus', 220, undefined, 1)).toBe(18);
    expect(artworkHueShift('constructor', 211, undefined, 1)).toBe(0);
  });

  it('samples meaningful color while ignoring gray and transparent pixels', () => {
    const gray = [120, 120, 120, 255];
    const red = [255, 0, 0, 0];
    const green = [40, 200, 50, 255];
    expect(dominantImageHue(new Uint8ClampedArray([...gray, ...red]))).toBeUndefined();
    expect(dominantImageHue(new Uint8ClampedArray([...gray, ...red, ...green]))).toBeCloseTo(127.5);
  });
});
