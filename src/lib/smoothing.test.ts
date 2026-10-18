import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Frame, ProcessOptions } from '../types';
import { defaultOptions } from '../types';
import { processFrame } from './ai';
import { enhanceSmoothingFrame, limitSmoothingAlpha, releaseSmoothing, smoothFrames, smoothingSettingsKey, type SmoothingIO } from './smoothing';

vi.mock('./ai', () => ({ processFrame: vi.fn() }));

const frame = (index: number): Frame => ({ id: `frame-${index}`, name: `walk/frame-${index}.png`, sourceIndex: index * 3, time: index / 12, url: `parent:${index}`, width: 16, height: 20, selected: index !== 1, anchor: 'bottom' });
function runtime() {
  const read = vi.fn(async (item: Frame) => new Blob([item.url], { type: 'image/png' }));
  const enhance = vi.fn(async (blob: Blob) => new Blob([blob, '-enhanced'], { type: 'image/png' }));
  const matte = vi.fn(async (blob: Blob, _original: Blob, _options: ProcessOptions, _signal?: AbortSignal) => ({ blob: new Blob([blob, '-matte'], { type: 'image/png' }), width: 16, height: 20 }));
  const created: Blob[] = [], revoked: string[] = [];
  const io: SmoothingIO = { read, enhance, matte, createUrl: blob => { created.push(blob); return `generated:${created.length}`; }, revokeUrl: url => revoked.push(url) };
  return { io, read, enhance, matte, created, revoked };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('selected-frame smoothing pipeline', () => {
  it('enhances then mattes each current frame and preserves order, identities, alpha-ready PNGs and selection', async () => {
    const input = [frame(3), frame(1), frame(2)];
    const sourceCopy = input.map(item => ({ ...item }));
    const { io, read, enhance, matte, created, revoked } = runtime();
    const progress = vi.fn();
    const result = await smoothFrames(input, defaultOptions, { io, onProgress: (done, total) => { progress(done, total); if (done === 1) input.pop(); } });
    expect(result.frames).toEqual(sourceCopy.map((item, index) => ({ ...item, url: `generated:${index + 1}` })));
    expect(read.mock.calls.map(([item]) => item.url)).toEqual(sourceCopy.map(item => item.url));
    expect(enhance.mock.calls).toHaveLength(3);
    expect(await created[0].text()).toBe('parent:3-enhanced-matte');
    expect(matte.mock.calls[0][2]).toEqual(defaultOptions);
    expect(matte.mock.calls[0][2]).not.toBe(defaultOptions);
    expect(progress.mock.calls).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);
    releaseSmoothing(result, io.revokeUrl);
    expect(revoked).toEqual(['generated:1', 'generated:2', 'generated:3']);
    expect(revoked.some(url => url.startsWith('parent:'))).toBe(false);
  });

  it('releases partial output on cancellation, failed matte, or dimension mismatch', async () => {
    const cancelled = runtime(); const controller = new AbortController();
    await expect(smoothFrames([frame(0), frame(1)], defaultOptions, { io: cancelled.io, signal: controller.signal, onProgress: done => { if (done === 1) controller.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled.revoked).toEqual(['generated:1']);
    const failed = runtime(); failed.matte.mockRejectedValueOnce(new Error('matte failed'));
    await expect(smoothFrames([frame(0)], defaultOptions, { io: failed.io })).rejects.toThrow('matte failed');
    expect(failed.created).toHaveLength(0);
    const mismatched = runtime(); mismatched.matte.mockResolvedValueOnce({ blob: new Blob(['png']), width: 64, height: 80 });
    await expect(smoothFrames([frame(0)], defaultOptions, { io: mismatched.io })).rejects.toThrow('尺寸与原帧不同');
    expect(mismatched.created).toHaveLength(0);
  });

  it('does not start work on empty, excessive, or already-aborted inputs', async () => {
    const { io, read } = runtime();
    await expect(smoothFrames([], defaultOptions, { io })).rejects.toThrow('1 到 400');
    await expect(smoothFrames(Array.from({ length: 401 }, (_, index) => frame(index)), defaultOptions, { io })).rejects.toThrow('1 到 400');
    const controller = new AbortController(); controller.abort();
    await expect(smoothFrames([frame(0)], defaultOptions, { io, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });

  it('preserves original alpha ceilings while accepting further matte removal and clears invisible RGB', () => {
    const original = new Uint8ClampedArray([10, 20, 30, 0, 10, 20, 30, 70, 10, 20, 30, 255]);
    const output = new Uint8ClampedArray([90, 80, 70, 255, 90, 80, 70, 200, 90, 80, 70, 20]);
    limitSmoothingAlpha(output, original);
    expect([...output]).toEqual([0, 0, 0, 0, 90, 80, 70, 70, 90, 80, 70, 20]);
    expect([...original]).toEqual([10, 20, 30, 0, 10, 20, 30, 70, 10, 20, 30, 255]);
    expect(() => limitSmoothingAlpha(output, original.slice(4))).toThrow('尺寸不一致');
  });

  it('uses a property-order-independent settings signature for restored projects', () => {
    expect(smoothingSettingsKey(defaultOptions)).toBe(smoothingSettingsKey(Object.fromEntries(Object.entries(defaultOptions).reverse()) as typeof defaultOptions));
    expect(smoothingSettingsKey({ ...defaultOptions, removeBackground: !defaultOptions.removeBackground })).not.toBe(smoothingSettingsKey(defaultOptions));
  });
});

describe('real smoothing API transport', () => {
  it.each([0, 1, 128, 254])('keeps an already-transparent frame (alpha %i) without a second matte, erosion or cleanup', async alpha => {
    const original = new Blob(['original PNG']);
    const enhanced = new Blob(['actual enhanced PNG']);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(original)).mockResolvedValueOnce(new Response(enhanced)));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 16, height: 20, close: vi.fn() })));
    const pixels = new Uint8ClampedArray(16 * 20 * 4).fill(255); pixels[3] = alpha;
    const canvasContext = { drawImage: vi.fn(), getImageData: vi.fn(() => ({ data: pixels })) };
    vi.stubGlobal('document', { createElement: vi.fn(() => ({ getContext: () => canvasContext })) });
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:smoothed');
    vi.mocked(processFrame).mockClear();
    const result = await smoothFrames([frame(0)], { ...defaultOptions, engine: 'luma', erosion: 3, semitransparentToBlack: true });
    expect(processFrame).not.toHaveBeenCalled();
    expect(await (createUrl.mock.calls[0][0] as Blob).text()).toBe('actual enhanced PNG');
    expect(result.frames[0].url).toBe('blob:smoothed');
  });

  it('still applies the configured matte to a fully opaque frame on its original canvas', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('original PNG')).mockResolvedValueOnce(new Response('enhanced PNG')));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 16, height: 20, close: vi.fn() })));
    const pixels = new Uint8ClampedArray(16 * 20 * 4).fill(255);
    const canvasContext = { drawImage: vi.fn(), getImageData: vi.fn(() => ({ data: pixels.slice() })), putImageData: vi.fn() };
    const makeCanvas = () => ({ getContext: () => canvasContext, toBlob: (done: (blob: Blob) => void) => done(new Blob(['matted PNG'])) });
    vi.stubGlobal('document', { createElement: vi.fn(makeCanvas) });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:smoothed');
    vi.mocked(processFrame).mockClear().mockResolvedValueOnce(makeCanvas() as unknown as HTMLCanvasElement);
    await smoothFrames([frame(0)], { ...defaultOptions, engine: 'luma', erosion: 2 });
    expect(processFrame).toHaveBeenCalledOnce();
    expect(vi.mocked(processFrame).mock.calls[0][1]).toMatchObject({ engine: 'luma', erosion: 2, targetHeight: 20, padding: 0, layout: 'original' });
  });

  it('uploads actual current PNG bytes and propagates backend errors without fabricating output', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response(new Blob(['real enhanced PNG'], { type: 'image/png' }))).mockResolvedValueOnce(new Response(JSON.stringify({ detail: '缺少 Real-ESRGAN 模型' }), { status: 503 }));
    vi.stubGlobal('fetch', request);
    expect(await (await enhanceSmoothingFrame(new Blob(['current frame']), 'walk/frame.png')).text()).toBe('real enhanced PNG');
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('/api/smoothing/frame');
    expect(init.method).toBe('POST');
    const image = init.body.get('image') as File;
    expect(image.name).toBe('frame.png'); expect(await image.text()).toBe('current frame');
    await expect(enhanceSmoothingFrame(new Blob(['png']), 'frame.png')).rejects.toThrow('缺少 Real-ESRGAN 模型');
  });
});
