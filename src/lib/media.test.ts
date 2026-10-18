import { describe, expect, it } from 'vitest';
import { chromaKeyPixels, estimateFrames } from './media';
import { defaultOptions } from '../types';

function key(rgba: number[], overrides: Partial<typeof defaultOptions> = {}): number[] {
  return Array.from(chromaKeyPixels(new Uint8ClampedArray(rgba), { ...defaultOptions, ...overrides }));
}

describe('chroma key matte', () => {
  it('removes the chosen green and the darker green visible in the supplied screenshot', () => {
    expect(key([71, 202, 48, 255, 57, 164, 41, 255]).filter((_, index) => index % 4 === 3)).toEqual([0, 0]);
  });

  it('preserves black clothing, grey armor, white hair, and a red blade', () => {
    const foreground = [8, 9, 10, 255, 65, 64, 67, 255, 215, 217, 219, 255, 181, 34, 24, 255];
    expect(key(foreground)).toEqual(foreground);
  });

  it('keeps dark neutral pixels even with a high color tolerance', () => {
    expect(key([4, 6, 4, 255], { tolerance: 80 })).toEqual([4, 6, 4, 255]);
  });

  it('preserves existing foreground transparency and fully transparent pixels', () => {
    expect(key([150, 32, 25, 96, 20, 20, 20, 0])).toEqual([150, 32, 25, 96, 20, 20, 20, 0]);
  });

  it('produces a soft matte and reduces green spill only on partially keyed edges', () => {
    const original = [30, 70, 25, 255];
    const uncorrected = key(original, { spill: 0 });
    const corrected = key(original, { spill: 100 });
    expect(uncorrected[3]).toBeGreaterThan(0);
    expect(uncorrected[3]).toBeLessThan(255);
    expect(corrected[3]).toBe(uncorrected[3]);
    expect(corrected[1]).toBeLessThan(uncorrected[1]);
    expect(corrected[0]).toBe(uncorrected[0]);
    expect(corrected[2]).toBe(uncorrected[2]);
  });

  it('multiplies the source alpha instead of replacing it with the new matte', () => {
    const opaque = key([30, 70, 25, 255], { spill: 0 });
    const translucent = key([30, 70, 25, 128], { spill: 0 });
    expect(translucent[3]).toBeCloseTo(opaque[3] * 128 / 255, 0);
  });

  it('supports blue-screen keying while retaining green and red foreground', () => {
    expect(key([35, 50, 210, 255], { keyColor: '#2332d2' })[3]).toBe(0);
    expect(key([35, 180, 40, 255, 190, 30, 25, 255], { keyColor: '#2332d2' })).toEqual([35, 180, 40, 255, 190, 30, 25, 255]);
  });

  it('supports neutral picked colors using brightness-sensitive distance', () => {
    expect(key([200, 200, 200, 255, 0, 0, 0, 255], { keyColor: '#c8c8c8' })).toEqual([200, 200, 200, 0, 0, 0, 0, 255]);
  });

  it('applies alpha-preserving dark edge cleanup and opaque edge cleanup distinctly', () => {
    const edge = [30, 70, 25, 255];
    const soft = key(edge);
    expect(key(edge, { cleanup: 'dark' })).toEqual([0, 0, 0, soft[3]]);
    expect(key(edge, { cleanup: 'opaque' })[3]).toBe(255);
    expect(key([71, 202, 48, 255], { cleanup: 'opaque' })[3]).toBe(0);
  });

  it('leaves every pixel unchanged when background removal is disabled', () => {
    const pixels = [71, 202, 48, 255, 30, 100, 25, 128];
    expect(key(pixels, { removeBackground: false, cleanup: 'opaque' })).toEqual(pixels);
  });

  it('accepts short hex colors and reports malformed input', () => {
    expect(key([0, 255, 0, 255], { keyColor: '#0f0' })[3]).toBe(0);
    expect(() => key([0, 255, 0, 255], { keyColor: 'invalid' })).toThrow('颜色无效');
    expect(() => key([0, 255, 0])).toThrow('RGBA');
  });
});

describe('frame interval estimation', () => {
  it('uses one-based inclusive frame intervals and keeps the start frame', () => {
    expect(estimateFrames(1, 48, 4)).toBe(12);
    expect(estimateFrames(1, 195, 4)).toBe(49);
    expect(estimateFrames(3, 3, 4)).toBe(1);
    expect(estimateFrames(1, 1, 1)).toBe(1);
  });

  it('rejects reversed, non-finite, zero-based, and invalid stride intervals', () => {
    for (const [start, end, stride] of [[8, 2, 1], [0, 5, 1], [1, 5, 0], [1, 5, -2], [1, Infinity, 1], [NaN, 8, 1]]) {
      expect(estimateFrames(start, end, stride)).toBe(0);
    }
  });
});
