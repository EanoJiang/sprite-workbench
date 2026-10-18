import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  compressFrame, compressionResizeMode, compressionSettingsKey, defaultCompressionSettings, importCompressionFiles,
  releaseCompressionFrames, snapshotCompressionFrames,
  type CompressionSourceFrame,
} from './compression';
import type { Frame } from '../types';

const bitmap = (width = 100, height = 80) => ({ width, height, close: vi.fn() });
let decodeBitmap: ReturnType<typeof vi.fn>;
let request: ReturnType<typeof vi.fn>;
let createUrl: MockInstance<typeof URL.createObjectURL>;
let revokeUrl: MockInstance<typeof URL.revokeObjectURL>;

beforeEach(() => {
  let serial = 0;
  decodeBitmap = vi.fn(async () => bitmap());
  request = vi.fn();
  vi.stubGlobal('createImageBitmap', decodeBitmap);
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++serial}` });
  createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:independent-${++serial}`);
  revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const file = (name: string, content = name) => new File([content], name, { type: 'image/png' });
const parentFrame = (index: number): Frame => ({ id: `parent-${index}`, name: `frame_${index}.png`, sourceIndex: index * 4, time: index / 12, url: `blob:parent-${index}`, width: 100, height: 80, selected: true });
const source = (): CompressionSourceFrame => ({ id: 'source', name: 'walk/frame_013.png', sourceIndex: 13, time: .5, url: 'blob:source', blob: new Blob(['original PNG bytes'], { type: 'image/png' }), width: 100, height: 80 });

describe('independent compression imports', () => {
  it('sorts numeric filenames, keeps original bytes and creates independent URLs', async () => {
    const input = [file('walk_10.png'), file('ignore.txt'), file('walk_2.png')];
    const progress = vi.fn();
    const result = await importCompressionFiles(input, 12, progress);
    expect(result.map(frame => frame.name)).toEqual(['walk_2.png', 'walk_10.png']);
    expect(result.map(frame => frame.sourceIndex)).toEqual([1, 2]);
    expect(result.map(frame => frame.time)).toEqual([0, 1 / 12]);
    expect(result[0].blob).toBe(input[2]);
    expect(await result[1].blob.text()).toBe('walk_10.png');
    expect(new Set(result.map(frame => frame.url)).size).toBe(2);
    expect(progress.mock.calls).toEqual([[1, 2], [2, 2]]);
    expect(decodeBitmap).toHaveBeenCalledTimes(2);
  });

  it('keeps folder-relative names for display and deterministic ordering', async () => {
    const first = file('same.png');
    const second = file('same.png');
    Object.defineProperty(first, 'webkitRelativePath', { value: 'walk_10/same.png' });
    Object.defineProperty(second, 'webkitRelativePath', { value: 'walk_2/same.png' });
    expect((await importCompressionFiles([first, second], 8)).map(frame => frame.name)).toEqual(['walk_2/same.png', 'walk_10/same.png']);
  });

  it('rejects excessive frame counts and individual byte sizes before allocating URLs', async () => {
    await expect(importCompressionFiles(Array.from({ length: 401 }, (_, index) => file(`${index}.png`)), 12)).rejects.toThrow('400');
    const oversized = new File([new Uint8Array(16 * 1024 * 1024 + 1)], 'large.png');
    await expect(importCompressionFiles([oversized], 12)).rejects.toThrow('16 MB');
    expect(decodeBitmap).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('closes rejected bitmaps and frees all previous frame URLs on image-size errors', async () => {
    const accepted = bitmap();
    const oversized = bitmap(8193, 10);
    decodeBitmap.mockResolvedValueOnce(accepted).mockResolvedValueOnce(oversized);
    await expect(importCompressionFiles([file('1.png'), file('2.png')], 12)).rejects.toThrow('画布过大');
    expect(accepted.close).toHaveBeenCalledOnce();
    expect(oversized.close).toHaveBeenCalledOnce();
    expect(createUrl).toHaveBeenCalledOnce();
    expect(revokeUrl).toHaveBeenCalledWith(createUrl.mock.results[0].value);
  });

  it('enforces the cumulative 120-million-pixel limit and frees even the last accepted URL', async () => {
    decodeBitmap.mockImplementation(async () => bitmap(8000, 4000));
    await expect(importCompressionFiles([1, 2, 3, 4].map(index => file(`${index}.png`)), 12)).rejects.toThrow('1.2 亿像素');
    expect(createUrl).toHaveBeenCalledTimes(4);
    expect(revokeUrl.mock.calls.map(call => call[0])).toEqual(createUrl.mock.results.map(result => result.value));
  });

  it('cleans previously decoded frames when cancellation occurs during a later decode', async () => {
    const controller = new AbortController();
    const first = bitmap(), cancelled = bitmap();
    decodeBitmap.mockResolvedValueOnce(first).mockImplementationOnce(async () => { controller.abort(); return cancelled; });
    await expect(importCompressionFiles([file('1.png'), file('2.png')], 12, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(first.close).toHaveBeenCalledOnce();
    expect(cancelled.close).toHaveBeenCalledOnce();
    expect(createUrl).toHaveBeenCalledOnce();
    expect(revokeUrl).toHaveBeenCalledOnce();
  });

  it('cleans all frame URLs if the caller progress callback fails', async () => {
    await expect(importCompressionFiles([file('1.png')], 12, () => { throw new Error('caller failed'); })).rejects.toThrow('caller failed');
    expect(revokeUrl).toHaveBeenCalledWith(createUrl.mock.results[0].value);
  });
});

describe('main-workflow snapshot ownership', () => {
  it('copies the initial selection order and metadata without revoking parent URLs', async () => {
    const frames = [parentFrame(3), parentFrame(1)];
    request.mockImplementation(async () => new Response(new Blob(['encoded PNG'], { type: 'image/png' })));
    const result = await snapshotCompressionFrames(frames, done => { if (done === 1) frames.splice(1); });
    expect(result.map(frame => frame.name)).toEqual(['frame_3.png', 'frame_1.png']);
    expect(result.map(frame => frame.sourceIndex)).toEqual([12, 4]);
    expect(result.map(frame => frame.time)).toEqual([3 / 12, 1 / 12]);
    expect(result[0].url).not.toBe('blob:parent-3');
    expect(await result[0].blob.text()).toBe('encoded PNG');
    expect(request.mock.calls.map(call => call[0])).toEqual(['blob:parent-3', 'blob:parent-1']);
    releaseCompressionFrames(result);
    expect(revokeUrl.mock.calls.map(call => call[0])).toEqual(result.map(frame => frame.url));
  });

  it('cleans partial snapshot URLs when a parent frame is unavailable', async () => {
    request.mockResolvedValueOnce(new Response('PNG')).mockResolvedValueOnce(new Response('gone', { status: 404 }));
    await expect(snapshotCompressionFrames([parentFrame(1), parentFrame(2)])).rejects.toThrow('无法读取');
    expect(revokeUrl).toHaveBeenCalledOnce();
    expect(revokeUrl).not.toHaveBeenCalledWith('blob:parent-1');
  });

  it('does not read or allocate anything for an already cancelled operation', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(snapshotCompressionFrames([parentFrame(1)], undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
  });
});

describe('compression API response ownership', () => {
  it('sends actual input bytes and options, then uses decoded output dimensions', async () => {
    const input = source();
    request.mockResolvedValue(new Response(new Blob(['compressed indexed PNG'], { type: 'image/png' })));
    const decoded = bitmap(50, 40); decodeBitmap.mockResolvedValue(decoded);
    const result = await compressFrame(input, { ...defaultCompressionSettings, algorithm: 'palette', scale: .5, colors: 16 });
    const [url, options] = request.mock.calls[0];
    expect(url).toBe('/api/compression/frame');
    expect(options.method).toBe('POST');
    const form = options.body as FormData;
    expect((form.get('image') as File).name).toBe('frame_013.png');
    expect(await (form.get('image') as File).text()).toBe('original PNG bytes');
    expect(['scale', 'algorithm', 'alpha_threshold', 'sharpen', 'colors'].map(key => form.get(key))).toEqual(['0.5', 'palette', '8', '80', '16']);
    expect(form.get('resize_mode')).toBe('soft');
    expect(result).toMatchObject({ name: input.name, sourceIndex: input.sourceIndex, time: input.time, width: 50, height: 40 });
    expect(await result.blob.text()).toBe('compressed indexed PNG');
    expect(decoded.close).toHaveBeenCalledOnce();
    expect(revokeUrl).not.toHaveBeenCalledWith(input.url);
  });

  it('sends hard resampling independently from palette encoding and preserves old nearest projects', async () => {
    request.mockResolvedValue(new Response(new Blob(['png'], { type: 'image/png' })));
    await compressFrame(source(), { ...defaultCompressionSettings, algorithm: 'palette', resizeMode: 'hard' });
    const form = request.mock.calls[0][1].body as FormData;
    expect(form.get('algorithm')).toBe('palette'); expect(form.get('resize_mode')).toBe('hard');
    expect(compressionResizeMode({ ...defaultCompressionSettings, algorithm: 'nearest', resizeMode: undefined })).toBe('hard');
    expect(compressionSettingsKey({ ...defaultCompressionSettings, resizeMode: 'hard' })).not.toBe(compressionSettingsKey(defaultCompressionSettings));
    expect(compressionSettingsKey({ ...defaultCompressionSettings, algorithm: 'nearest', resizeMode: undefined })).toBe(compressionSettingsKey({ ...defaultCompressionSettings, resizeMode: 'hard' }));
  });

  it('surfaces backend errors and never fabricates an output URL', async () => {
    request.mockResolvedValue(new Response(JSON.stringify({ detail: '图片尺寸超限' }), { status: 413, headers: { 'Content-Type': 'application/json' } }));
    await expect(compressFrame(source(), defaultCompressionSettings)).rejects.toThrow('图片尺寸超限');
    expect(decodeBitmap).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('reports local-service connection errors without replacing cancellation errors', async () => {
    request.mockRejectedValueOnce(new Error('connection refused'));
    await expect(compressFrame(source(), defaultCompressionSettings)).rejects.toThrow('start.ps1');
    const controller = new AbortController();
    const cancellation = new DOMException('fetch cancelled', 'AbortError');
    request.mockImplementationOnce(async () => { controller.abort(); throw cancellation; });
    await expect(compressFrame(source(), defaultCompressionSettings, controller.signal)).rejects.toBe(cancellation);
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('closes a decoded output if cancelled before its URL is allocated', async () => {
    const controller = new AbortController();
    const decoded = bitmap();
    request.mockResolvedValue(new Response('encoded PNG'));
    decodeBitmap.mockImplementation(async () => { controller.abort(); return decoded; });
    await expect(compressFrame(source(), defaultCompressionSettings, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(decoded.close).toHaveBeenCalledOnce();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('rejects undecodable success responses without leaking object URLs', async () => {
    request.mockResolvedValue(new Response('not actually an image'));
    decodeBitmap.mockRejectedValue(new Error('invalid PNG'));
    await expect(compressFrame(source(), defaultCompressionSettings)).rejects.toThrow('invalid PNG');
    expect(createUrl).not.toHaveBeenCalled();
  });
});
