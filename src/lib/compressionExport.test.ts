import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { downloadBlob } from './export';
import {
  buildCompressionManifest, buildTar, exportCompressedFrames, exportCurrentCompressedFrame, exportCompressionSpriteSheet,
  type CompressionExportFrame,
} from './compressionExport';

vi.mock('./export', () => ({ downloadBlob: vi.fn() }));
const decoder = new TextDecoder();
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), character => character.charCodeAt(0));
const frame = (changes: Partial<CompressionExportFrame> = {}): CompressionExportFrame => ({ name: 'input.png', width: 1, height: 1, sourceIndex: 9, time: 0.75, blob: new Blob([png], { type: 'image/png' }), ...changes });

/** Tiny pixel canvas: inspect layout and transparency before the PNG encoder. */
function installPixelCanvas(): void {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })));
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`Unexpected element: ${tag}`);
      let width = 0, height = 0, pixels = new Uint8ClampedArray();
      const context = {
        drawImage: (_image: unknown, x: number, y: number, imageWidth: number, imageHeight: number) => {
          for (let row = y; row < y + imageHeight; row++) for (let column = x; column < x + imageWidth; column++) {
            pixels.set([80, 100, 120, 255], (row * width + column) * 4);
          }
        },
      };
      return {
        get width() { return width; }, set width(value: number) { width = value; pixels = new Uint8ClampedArray(width * height * 4); },
        get height() { return height; }, set height(value: number) { height = value; pixels = new Uint8ClampedArray(width * height * 4); },
        getContext: () => context,
        toBlob: (callback: (blob: Blob) => void) => callback(new Blob([JSON.stringify({ width, height, pixels: Array.from(pixels) })], { type: 'image/png' })),
      };
    },
  });
}

async function downloadedSheet() {
  const [blob] = vi.mocked(downloadBlob).mock.calls[0];
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  return {
    atlas: JSON.parse(await zip.file('walk.png')!.async('string')) as { width: number; height: number; pixels: number[] },
    metadata: JSON.parse(await zip.file('atlas.json')!.async('string')),
    manifest: JSON.parse(await zip.file('manifest.json')!.async('string')),
  };
}

/** Test-side USTAR reader: validates checksum, padding, bounds and terminators. */
function readTar(archive: Uint8Array) {
  const entries = new Map<string, Uint8Array>();
  let cursor = 0;
  while (archive.subarray(cursor, cursor + 512).some(byte => byte !== 0)) {
    const header = archive.subarray(cursor, cursor + 512);
    const name = decoder.decode(header.subarray(0, 100)).split('\0')[0];
    const size = parseInt(decoder.decode(header.subarray(124, 136)).replace(/\0/g, '').trim(), 8);
    const storedChecksum = parseInt(decoder.decode(header.subarray(148, 156)).replace(/\0/g, '').trim(), 8);
    const calculatedChecksum = Array.from(header).reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    expect(storedChecksum).toBe(calculatedChecksum);
    expect(decoder.decode(header.subarray(257, 263))).toBe('ustar\0');
    expect(decoder.decode(header.subarray(263, 265))).toBe('00');
    expect(parseInt(decoder.decode(header.subarray(100, 108)), 8)).toBe(0o644);
    expect(parseInt(decoder.decode(header.subarray(136, 148)), 8)).toBe(0);
    expect(header[156]).toBe(48);
    const end = cursor + 512 + size;
    expect(end).toBeLessThanOrEqual(archive.length - 1024);
    entries.set(name, archive.slice(cursor + 512, end));
    cursor += 512 + Math.ceil(size / 512) * 512;
    expect(archive.subarray(end, cursor).every(byte => byte === 0)).toBe(true);
  }
  expect(archive.length - cursor).toBe(1024);
  expect(archive.subarray(cursor).every(byte => byte === 0)).toBe(true);
  return entries;
}

describe('compressed PNG exports', () => {
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it('creates deterministic USTAR entries across empty and 512-byte block boundaries', () => {
    const entries = [
      { name: 'empty.txt', data: new Uint8Array() },
      { name: 'frame_001.png', data: new Uint8Array(512).fill(127) },
      { name: '帧.png', data: new Uint8Array(513).fill(255) },
    ];
    const archive = buildTar(entries);
    expect(archive.byteLength).toBe(4096);
    expect(buildTar(entries)).toEqual(archive);
    const read = readTar(archive);
    for (const entry of entries) expect(read.get(entry.name)).toEqual(entry.data);
  });

  it('rejects unsafe, duplicate and overlong TAR names', () => {
    for (const name of ['../frame.png', 'folder/frame.png', 'folder\\frame.png', '..', 'a\0.png', 'x'.repeat(101)]) {
      expect(() => buildTar([{ name, data: png }])).toThrow('安全');
    }
    expect(() => buildTar([{ name: 'same.png', data: png }, { name: 'same.png', data: png }])).toThrow('重复');
  });

  it('reports real byte totals, exact frame order and settings even when savings are negative', () => {
    const manifest = buildCompressionManifest([
      { ...frame({ sourceIndex: 9 }), bytes: 80 },
      { ...frame({ sourceIndex: 2, name: 'later.png', time: 1.25 }), bytes: 90 },
    ], 'walk', 20, { settings: { scale: 0.5, colors: 128 }, inputBytes: 100 });
    expect(manifest.frameCount).toBe(2);
    expect(manifest.frames.map(item => item.sourceFrame)).toEqual([9, 2]);
    expect(manifest.frames[1]).toMatchObject({ filename: 'frame_002.png', sourceName: 'later.png', sourceTimeSeconds: 1.25, bytes: 90, width: 1, height: 1, durationMs: 50 });
    expect(manifest.inputBytes).toBe(100);
    expect(manifest.outputBytes).toBe(170);
    expect(manifest.savingsPercent).toBe(-70);
    expect(manifest.settings).toEqual({ scale: 0.5, colors: 128 });
    expect(manifest.durationMs).toBe(100);
  });

  it.each(['zip', 'tar'] as const)('exports original PNG bytes and matching animation metadata to %s', async format => {
    await exportCompressedFrames([frame(), frame({ name: 'second.png', sourceIndex: 13 })], 'walk', 18, format, { settings: { algorithm: 'palette', colors: 128 }, inputBytes: 300 });
    const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0];
    expect(filename).toBe(`walk.${format}`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const tar = format === 'tar' ? readTar(bytes) : undefined;
    const zip = format === 'zip' ? await JSZip.loadAsync(bytes) : undefined;
    const read = async (name: string) => tar ? tar.get(name)! : await zip!.file(name)!.async('uint8array');
    expect(await read('frame_001.png')).toEqual(png);
    expect(await read('frame_002.png')).toEqual(png);
    const manifest = JSON.parse(decoder.decode(await read('manifest.json')));
    expect(manifest.fps).toBe(18);
    expect(manifest.frameCount).toBe(2);
    expect(manifest.frames.map((item: { sourceFrame: number }) => item.sourceFrame)).toEqual([9, 13]);
    expect(manifest.frames.map((item: { bytes: number }) => item.bytes)).toEqual([png.length, png.length]);
    expect(manifest.outputBytes).toBe(png.length * 2);
    expect(manifest.settings).toEqual({ algorithm: 'palette', colors: 128 });
  });

  it('downloads a processed palette PNG without routing it through canvas or re-encoding', async () => {
    await exportCurrentCompressedFrame(frame({ name: '../result.webp' }));
    const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0];
    expect(filename).toBe('_result.png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png);
  });

  it('supports an existing workbench Blob URL and rejects invalid PNG dimensions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(png, { headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchMock);
    await exportCurrentCompressedFrame(frame({ blob: undefined, url: 'blob:processed' }));
    expect(fetchMock).toHaveBeenCalledWith('blob:processed');
    await expect(exportCurrentCompressedFrame(frame({ width: 2 }))).rejects.toThrow('尺寸');
    await expect(exportCurrentCompressedFrame(frame({ blob: new Blob(['not PNG']) }))).rejects.toThrow('有效的 PNG');
  });

  it('rejects invalid sequences before reading any Blob URLs', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(exportCompressedFrames([], 'walk', 12, 'zip')).rejects.toThrow('至少一帧');
    await expect(exportCompressedFrames([frame()], 'walk', 0, 'tar')).rejects.toThrow('帧率');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('exports a 3 by 4 canvas with transparent empty cells and matching frame positions', async () => {
    installPixelCanvas();
    await exportCompressionSpriteSheet(Array.from({ length: 5 }, (_, sourceIndex) => frame({ sourceIndex })), 'walk', 12, {}, 3, 4);
    const { atlas, metadata, manifest } = await downloadedSheet();
    expect([atlas.width, atlas.height]).toEqual([3, 4]);
    expect(atlas.pixels.filter((_, index) => index % 4 === 3)).toEqual([255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0]);
    expect(metadata.meta).toMatchObject({ columns: 3, rows: 4, size: { w: 3, h: 4 } });
    expect(metadata.frames['frame_004.png'].frame).toEqual({ x: 0, y: 1, w: 1, h: 1 });
    expect(metadata.frames['frame_005.png'].frame).toEqual({ x: 1, y: 1, w: 1, h: 1 });
    expect(Object.keys(metadata.frames)).toHaveLength(5);
    expect(manifest.frameCount).toBe(5);
  });

  it('keeps explicit surplus columns and auto-expands insufficient rows', async () => {
    installPixelCanvas();
    await exportCompressionSpriteSheet([frame(), frame()], 'walk', 12, {}, 3, 4);
    expect((await downloadedSheet()).metadata.meta).toMatchObject({ columns: 3, rows: 4, size: { w: 3, h: 4 } });
    vi.mocked(downloadBlob).mockClear();
    await exportCompressionSpriteSheet(Array.from({ length: 7 }, () => frame()), 'walk', 12, {}, 3, 1);
    const { atlas, metadata } = await downloadedSheet();
    expect([atlas.width, atlas.height]).toEqual([3, 3]);
    expect(metadata.meta.rows).toBe(3);
    expect(metadata.frames['frame_007.png'].frame).toEqual({ x: 0, y: 2, w: 1, h: 1 });
    expect(atlas.pixels.filter((_, index) => index % 4 === 3)).toEqual([255, 255, 255, 255, 255, 255, 255, 0, 0]);
  });

  it('preserves the old clamp to frame count when explicit rows are absent', async () => {
    installPixelCanvas();
    await exportCompressionSpriteSheet([frame(), frame()], 'walk', 12, {}, 8);
    const { atlas, metadata } = await downloadedSheet();
    expect([atlas.width, atlas.height]).toEqual([2, 1]);
    expect(metadata.meta).toMatchObject({ columns: 2, rows: 1, size: { w: 2, h: 1 } });
  });
});
