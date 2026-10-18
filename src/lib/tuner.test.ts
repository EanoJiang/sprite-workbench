import { describe, expect, it } from 'vitest';
import { sourceCanvasForFrames } from './tuner';

describe('sourceCanvasForFrames', () => {
  it('uses the shared maximum canvas and preserves centered extraction', () => {
    expect(sourceCanvasForFrames([
      { width: 640, height: 720, anchor: 'center' },
      { width: 648, height: 704, anchor: 'center' },
    ])).toEqual({ width: 648, height: 720, originPixelX: 324, originPixelY: 360 });
  });

  it('uses the bottom-center runtime anchor for imported sequences', () => {
    expect(sourceCanvasForFrames([
      { width: 128, height: 144 },
      { width: 96, height: 160, anchor: 'bottom' },
    ])).toEqual({ width: 128, height: 160, originPixelX: 64, originPixelY: 160 });
  });

  it('returns no canvas when dimensions are unavailable', () => {
    expect(sourceCanvasForFrames([{ width: 0, height: 0 }])).toBeUndefined();
  });
});
