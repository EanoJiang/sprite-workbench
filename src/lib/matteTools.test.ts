import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultOptions } from '../types';
import { detectWatermarkCorner, finalizeMatteCanvas, lumaKeyPixels, postprocessPixels, removeWatermarkPixels } from './media';
import { prepareModels, processFrame } from './ai';

const pixel = (pixels: Uint8ClampedArray, width: number, x: number, y = 0) => Array.from(pixels.slice((y * width + x) * 4, (y * width + x + 1) * 4));
function filled(width: number, height: number, rgba = [71, 202, 48, 255]): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) pixels.set(rgba, index);
  return pixels;
}
function mark(pixels: Uint8ClampedArray, width: number, x: number, y: number, w: number, h: number): void {
  for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) pixels.set([255, 255, 255, 255], (row * width + col) * 4);
}

describe('local luminance matte', () => {
  it('removes black or white backgrounds with the requested polarity and preserves source alpha', () => {
    const options = { ...defaultOptions, lumaBlack: 0, lumaWhite: 255, lumaGamma: 1, lumaStrength: 1, spill: 0, keyColor: '#000000', lumaPolarity: 'bright' as const };
    expect(Array.from(lumaKeyPixels(new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 128]), options))).toEqual([0, 0, 0, 0, 255, 255, 255, 255, 128, 128, 128, 64]);
    expect(Array.from(lumaKeyPixels(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), { ...options, keyColor: '#ffffff', lumaPolarity: 'dark' }))).toEqual([0, 0, 0, 0, 0, 0, 0, 255]);
  });

  it('uses the sampled key for automatic polarity and honours curve, strength, and existing transparency', () => {
    const source = [40, 40, 40, 255];
    const options = { ...defaultOptions, keyColor: '#000000', lumaPolarity: 'auto' as const, spill: 0, lumaBlack: 0, lumaWhite: 255, lumaGamma: 1, lumaStrength: 1 };
    const ordinary = lumaKeyPixels(new Uint8ClampedArray(source), options)[3];
    const stronger = lumaKeyPixels(new Uint8ClampedArray(source), { ...options, lumaStrength: 2 })[3];
    const softer = lumaKeyPixels(new Uint8ClampedArray(source), { ...options, lumaGamma: .5 })[3];
    expect(stronger).toBeGreaterThan(ordinary); expect(softer).toBeGreaterThan(ordinary);
    expect(lumaKeyPixels(new Uint8ClampedArray([0, 0, 0, 255]), { ...options, keyColor: '#ffffff' })[3]).toBe(255);
    expect(lumaKeyPixels(new Uint8ClampedArray([255, 255, 255, 0]), options)[3]).toBe(0);
    expect(lumaKeyPixels(new Uint8ClampedArray(source), { ...options, lumaStrength: 0 })[3]).toBe(0);
  });
});

describe('independent matte postprocessing', () => {
  it('limits background cleanup to matching translucent pixels within two pixels of transparency', () => {
    const data = filled(7, 5, [40, 200, 40, 255]);
    data.set([0, 0, 0, 0], 0);
    data.set([40, 200, 40, 128], (2 * 7 + 2) * 4);
    data.set([40, 200, 40, 128], (2 * 7 + 3) * 4);
    data.set([200, 30, 30, 128], 4);
    postprocessPixels(data, 7, 5, { ...defaultOptions, keyColor: '#00ff00', backgroundToBlack: true });
    expect(pixel(data, 7, 2, 2)).toEqual([0, 0, 0, 128]);
    expect(pixel(data, 7, 3, 2)).toEqual([40, 200, 40, 128]);
    expect(pixel(data, 7, 1, 0)).toEqual([200, 30, 30, 128]);
    expect(pixel(data, 7, 1, 1)).toEqual([40, 200, 40, 255]);
  });

  it('desaturates matching edge spill without changing alpha or nonmatching subject colours', () => {
    const data = new Uint8ClampedArray([0, 0, 0, 0, 40, 200, 40, 128, 200, 30, 30, 128]);
    postprocessPixels(data, 3, 1, { ...defaultOptions, keyColor: '#00ff00', backgroundDesaturate: true });
    expect(pixel(data, 3, 1)).toEqual([134, 134, 134, 128]);
    expect(pixel(data, 3, 2)).toEqual([200, 30, 30, 128]);
  });

  it('combines all cleanup switches while preserving opaque pixels and fully transparent holes', () => {
    const data = new Uint8ClampedArray([7, 8, 9, 0, 40, 200, 40, 128, 200, 30, 30, 64, 1, 2, 3, 255]);
    postprocessPixels(data, 4, 1, { ...defaultOptions, backgroundToBlack: true, backgroundDesaturate: true, semitransparentToBlack: true, semitransparentToOpaque: true });
    expect(Array.from(data)).toEqual([7, 8, 9, 0, 0, 0, 0, 255, 0, 0, 0, 255, 1, 2, 3, 255]);
    const legacy = new Uint8ClampedArray([20, 30, 40, 80]);
    expect(Array.from(postprocessPixels(legacy, 1, 1, { ...defaultOptions, cleanup: 'dark' }))).toEqual([0, 0, 0, 80]);
  });
});

describe('reference corner watermark removal', () => {
  it('keeps uniform frames untouched and selects the strongest detected corner for each frame', () => {
    const data = filled(200, 200);
    expect(detectWatermarkCorner(data, 200, 200)).toBeNull();
    mark(data, 200, 10, 8, 10, 3);
    expect(detectWatermarkCorner(data, 200, 200)).toBe('top_left');
    mark(data, 200, 180, 180, 10, 5);
    expect(detectWatermarkCorner(data, 200, 200)).toBe('bottom_right');
    removeWatermarkPixels(data, 200, 200, 'bottom_right');
    expect(pixel(data, 200, 185, 182)).toEqual([0, 0, 0, 0]);
    expect(pixel(data, 200, 15, 9)).toEqual([255, 255, 255, 255]);
    expect(pixel(data, 200, 100, 100)).toEqual([71, 202, 48, 255]);
  });
});

/** Small pixel-backed canvas for testing ordering without browser/model dependencies. */
class PixelCanvas {
  width = 0;
  height = 0;
  pixels = new Uint8ClampedArray();
  constructor(width = 0, height = 0, pixels?: Uint8ClampedArray) { this.width = width; this.height = height; if (pixels) this.pixels = pixels; }
  getContext() {
    const owner = this;
    return {
      imageSmoothingEnabled: false, imageSmoothingQuality: 'high',
      drawImage(source: PixelCanvas, dx: number, dy: number, dw = source.width, dh = source.height) {
        if (owner.pixels.length !== owner.width * owner.height * 4) owner.pixels = new Uint8ClampedArray(owner.width * owner.height * 4);
        for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
          const sx = Math.floor(x / dw * source.width), sy = Math.floor(y / dh * source.height);
          owner.pixels.set(source.pixels.slice((sy * source.width + sx) * 4, (sy * source.width + sx + 1) * 4), ((y + dy) * owner.width + x + dx) * 4);
        }
      },
      getImageData(_x: number, _y: number, width: number, height: number) { return { data: new Uint8ClampedArray(owner.pixels), width, height }; },
      putImageData(image: { data: Uint8ClampedArray }) { owner.pixels = new Uint8ClampedArray(image.data); },
    };
  }
}

describe('matte pipeline integration', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it('processes Luma entirely locally and never sends model preparation or matte requests', async () => {
    vi.stubGlobal('document', { createElement: () => new PixelCanvas() });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const input = new PixelCanvas(16, 16, filled(16, 16, [0, 0, 0, 255]));
    input.pixels.set([255, 255, 255, 255], (8 * 16 + 8) * 4);
    const options = { ...defaultOptions, engine: 'luma' as const, keyColor: '#000000', targetHeight: 16, padding: 0, spill: 0 };
    const output = await processFrame(input as unknown as HTMLCanvasElement, options) as unknown as PixelCanvas;
    expect(pixel(output.pixels, output.width, 0, 0)[3]).toBe(0);
    expect(pixel(output.pixels, output.width, 8, 8)[3]).toBe(255);
    await expect(prepareModels(options)).resolves.toMatchObject({ status: 'local' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('detects on original pixels, clears the matte before padding, and keeps removed regions transparent after opaque cleanup', () => {
    vi.stubGlobal('document', { createElement: () => new PixelCanvas() });
    const raw = new PixelCanvas(200, 200, filled(200, 200)); mark(raw.pixels, 200, 10, 8, 10, 4);
    const matte = new PixelCanvas(200, 200, filled(200, 200, [200, 40, 20, 128]));
    const output = finalizeMatteCanvas(matte as unknown as HTMLCanvasElement, { ...defaultOptions, targetHeight: 100, padding: 10, layout: 'square', watermarkRemoval: true, semitransparentToOpaque: true }, raw as unknown as HTMLCanvasElement) as unknown as PixelCanvas;
    expect(output.width).toBe(100);
    expect(pixel(output.pixels, 100, 16, 14)[3]).toBe(0);
    expect(pixel(output.pixels, 100, 50, 50)).toEqual([200, 40, 20, 255]);
    expect(pixel(output.pixels, 100, 1, 1)[3]).toBe(0);
  });
});
