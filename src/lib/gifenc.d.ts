declare module 'gifenc' {
  type Palette = number[][];
  export interface GifEncoder {
    writeFrame(pixels: Uint8Array, width: number, height: number, options: {
      palette: Palette;
      transparent?: boolean;
      transparentIndex?: number;
      dispose?: number;
      repeat?: number;
      delay?: number;
    }): void;
    finish(): void;
    bytes(): Uint8Array<ArrayBuffer>;
  }
  export function GIFEncoder(): GifEncoder;
  export function quantize(data: Uint8Array | Uint8ClampedArray, maxColors: number, options?: { format?: 'rgb565' | 'rgb444' | 'rgba4444' }): Palette;
  export function applyPalette(data: Uint8Array | Uint8ClampedArray, palette: Palette, format?: 'rgb565' | 'rgb444' | 'rgba4444'): Uint8Array;
}
