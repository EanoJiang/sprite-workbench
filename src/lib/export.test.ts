import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Frame } from '../types';
import { buildAnimationManifest, buildAtlasMetadata, exportCurrentFrame, exportGif } from './export';

function frame(overrides: Partial<Frame> = {}): Frame {
  return { id: 'one', name: 'source.png', sourceIndex: 3, time: 0.1, url: 'blob:frame', width: 64, height: 80, selected: true, ...overrides };
}

describe('animation exports', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('retains selection order and source timing in the PNG manifest', () => {
    const manifest = buildAnimationManifest([frame({ sourceIndex: 9 }), frame({ sourceIndex: 2, time: 0.5 })], '../walk.png', 20);
    expect(manifest.name).toBe('_walk');
    expect(manifest.frames.map(item => item.filename)).toEqual(['frame_001.png', 'frame_002.png']);
    expect(manifest.frames.map(item => item.sourceFrame)).toEqual([9, 2]);
    expect(manifest.frames[1].sourceTimeSeconds).toBe(0.5);
    expect(manifest.durationMs).toBe(100);
    expect(manifest.loop).toBe(true);
  });

  it('places unequal frames in bottom-centered cells and includes animation durations', () => {
    const atlas = buildAtlasMetadata([frame(), frame({ width: 30, height: 40 }), frame({ width: 50, height: 70 })], 'walk', 10, 2);
    expect(atlas.meta.size).toEqual({ w: 128, h: 160 });
    expect(atlas.frames['frame_002.png'].frame).toEqual({ x: 81, y: 40, w: 30, h: 40 });
    expect(atlas.frames['frame_003.png'].frame).toEqual({ x: 7, y: 90, w: 50, h: 70 });
    expect(atlas.frames['frame_003.png'].duration).toBe(100);
    expect(atlas.animations.walk).toEqual(['frame_001.png', 'frame_002.png', 'frame_003.png']);
  });

  it('rejects empty sequences, invalid playback rates, invalid columns, and oversize sheets', () => {
    expect(() => buildAnimationManifest([], 'walk', 12)).toThrow('至少一帧');
    expect(() => buildAnimationManifest([frame()], 'walk', Number.NaN)).toThrow('帧率');
    expect(() => buildAtlasMetadata([frame()], 'walk', 12, 0)).toThrow('正整数');
    expect(() => buildAtlasMetadata([frame({ width: 16_385 })], 'walk', 12, 1)).toThrow('画布过大');
    expect(() => buildAtlasMetadata([frame({ width: 10_000, height: 10_000 })], 'walk', 12, 1)).toThrow('画布过大');
  });

  it('retains explicit columns, empty rows and matching atlas dimensions', () => {
    const atlas = buildAtlasMetadata([frame(), frame({ width: 30, height: 40 })], 'walk', 12, 3, 4);
    expect(atlas.meta).toMatchObject({ columns: 3, rows: 4, size: { w: 192, h: 320 } });
    expect(atlas.frames['frame_002.png'].frame).toEqual({ x: 81, y: 40, w: 30, h: 40 });
    expect(Object.keys(atlas.frames)).toHaveLength(2);
  });

  it('expands insufficient explicit rows and keeps the former column clamp when rows are omitted', () => {
    const frames = Array.from({ length: 10 }, (_, index) => frame({ id: String(index) }));
    const expanded = buildAtlasMetadata(frames, 'walk', 12, 3, 1);
    expect(expanded.meta).toMatchObject({ columns: 3, rows: 4, size: { w: 192, h: 320 } });
    expect(expanded.frames['frame_010.png'].frame).toEqual({ x: 0, y: 240, w: 64, h: 80 });
    expect(buildAtlasMetadata([frame(), frame()], 'walk', 12, 10).meta).toMatchObject({ columns: 2, rows: 1, size: { w: 128, h: 80 } });
  });

  it('preserves the exact indexed PNG and transparency bytes when exporting an adopted compressed frame', async () => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABAQMAAADO7O3JAAAABlBMVEX/AAAAAABBoxIDAAAAAnRSTlP/AOW3MEoAAAAKSURBVHicY3AAAABCAEEpN/TvAAAAAElFTkSuQmCC'), char => char.charCodeAt(0));
    const original = new Blob([bytes], { type: 'image/png' });
    let downloaded: Blob | undefined;
    const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
    const createElement = vi.fn((tag: string) => { if (tag !== 'a') throw new Error('A PNG passthrough must not create a canvas'); return anchor; });
    vi.stubGlobal('document', { createElement, body: { appendChild: vi.fn() } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(original)));
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { downloaded = blob as Blob; return 'blob:download'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await exportCurrentFrame(frame({ width: 2, height: 1 }));
    expect(new Uint8Array(await downloaded!.arrayBuffer())).toEqual(bytes);
    expect(bytes[25]).toBe(3); // PNG indexed color, including the original tRNS chunk.
    expect(anchor.download).toBe('source.png');
    expect(createElement).toHaveBeenCalledOnce();
  });

  it('encodes a real looping GIF with transparent, non-trailing frames', async () => {
    let downloaded: Blob | undefined;
    let filename = '';
    const imageData = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0]);
    const context = { clearRect: vi.fn(), drawImage: vi.fn(), getImageData: () => ({ data: imageData }) };
    const anchor = { href: '', download: '', click() { filename = this.download; }, remove: vi.fn() };
    vi.stubGlobal('document', {
      createElement: (tag: string) => tag === 'a' ? anchor : { width: 0, height: 0, getContext: () => context },
      body: { appendChild: vi.fn() },
    });
    vi.stubGlobal('Image', class { onload?: () => void; set src(_value: string) { queueMicrotask(() => this.onload?.()); } });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { downloaded = blob as Blob; return 'blob:download'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await exportGif([frame({ width: 2, height: 1 }), frame({ width: 2, height: 1 })], 'idle', 12);
    expect(filename).toBe('idle.gif');
    expect(downloaded?.type).toBe('image/gif');
    const bytes = new Uint8Array(await downloaded!.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    expect(text.slice(0, 6)).toBe('GIF89a');
    expect(text).toContain('NETSCAPE2.0');
    expect(bytes.at(-1)).toBe(0x3b);
    const controls: number[][] = [];
    for (let index = 0; index < bytes.length - 7; index++) {
      if (bytes[index] === 0x21 && bytes[index + 1] === 0xf9 && bytes[index + 2] === 4) controls.push(Array.from(bytes.slice(index, index + 8)));
    }
    expect(controls).toHaveLength(2);
    // Packed control 9 = disposal-to-background (2) plus transparency (1).
    expect(controls.map(control => control[3])).toEqual([9, 9]);
    expect(controls.map(control => control[4])).toEqual([8, 9]);
    expect(context.clearRect).toHaveBeenCalledTimes(2);
  });
});
