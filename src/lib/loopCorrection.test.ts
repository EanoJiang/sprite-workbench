import { describe, expect, it, vi } from 'vitest';
import type { Frame } from '../types';
import { blendLoopPixels, compareLoopPixels, correctLoopFrames, loopFrameSignature, releaseLoopCorrection, type LoopCorrectionIO, type LoopImage, type LoopPixels } from './loopCorrection';

const pngBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), value => value.charCodeAt(0));
const png = new Blob([pngBytes], { type: 'image/png' });
const pixels = (data: number[], width = 1): LoopPixels => ({ width, height: data.length / width / 4, data: new Uint8ClampedArray(data) });
const frame = (index: number, changes: Partial<Frame> = {}): Frame => ({ id: `id-${index}`, name: `source-${index}.png`, sourceIndex: index * 3, time: index / 12, selected: true, url: `parent:${index}`, width: 1, height: 1, ...changes });
function runtime(images: Record<string, LoopImage>) {
  const created = new Map<string, Blob>();
  const revoked: string[] = [];
  const io: LoopCorrectionIO = {
    read: vi.fn(async value => { if (!images[value.url]) throw new Error('missing image'); return images[value.url]; }),
    encode: vi.fn(async image => new Blob([pngBytes, image.data], { type: 'image/png' })),
    createUrl: vi.fn(blob => { const url = `generated:${created.size}`; created.set(url, blob); return url; }),
    revokeUrl: vi.fn(url => revoked.push(url)),
  };
  return { io, created, revoked };
}
const image = (data: number[], changes: Partial<LoopImage> = {}): LoopImage => ({ ...pixels(data, changes.width ?? 1), blob: png, ...changes });

describe('loop endpoint correction', () => {
  it('copies endpoint alignment as well as pixels so export cannot offset the tail', async () => {
    const { io } = runtime({ 'parent:0': image([40, 60, 80, 255]), 'parent:1': image([80, 60, 40, 255]) });
    const result = await correctLoopFrames([frame(0, { anchor: 'center' }), frame(1, { anchor: 'bottom' })], undefined, { io });
    expect(result.frames[1].anchor).toBe('center');
    expect(result.frames[1].id).toBe('id-1');
  });
  it('copies exact first PNG bytes to the last endpoint while preserving order and source identities', async () => {
    const input = [frame(0), frame(1), frame(2, { name: 'tail.png', width: 2, selected: false })];
    const { io, created } = runtime({ 'parent:0': image([200, 40, 10, 128]), 'parent:2': image([0, 0, 0, 0, 255, 255, 255, 255], { width: 2 }) });
    const result = await correctLoopFrames(input, { mode: 'match', transitionFrames: 4 }, { io });
    expect(result.frames.map(value => value.id)).toEqual(input.map(value => value.id));
    expect(result.frames.slice(0, 2)).toEqual(input.slice(0, 2));
    expect(result.frames[2]).toMatchObject({ id: 'id-2', name: 'tail.png', sourceIndex: 6, time: 2 / 12, selected: false, width: 1, height: 1 });
    expect(new Uint8Array(await created.get(result.frames[2].url)!.arrayBuffer())).toEqual(pngBytes);
    expect(result.originalDifference.sameDimensions).toBe(false);
    expect(result.finalDifference).toMatchObject({ identical: true, changedPixels: 0, differencePercent: 0 });
    expect(io.encode).not.toHaveBeenCalled();
    expect(input[2].url).toBe('parent:2');
    expect(result.ownedUrls).toEqual([result.frames[2].url]);
  });

  it('encodes a non-PNG first frame once and gives both endpoints the exact generated PNG bytes', async () => {
    const { io, created } = runtime({ 'parent:0': image([40, 60, 80, 255], { blob: new Blob(['JPEG'], { type: 'image/jpeg' }) }), 'parent:1': image([10, 20, 30, 255]) });
    const result = await correctLoopFrames([frame(0), frame(1)], { mode: 'match', transitionFrames: 1 }, { io });
    expect(io.encode).toHaveBeenCalledTimes(1);
    expect(result.frames[0].url).not.toBe('parent:0');
    const first = created.get(result.frames[0].url)!;
    const last = created.get(result.frames[1].url)!;
    expect(first.type).toBe('image/png');
    expect(await first.arrayBuffer()).toEqual(await last.arrayBuffer());
    expect(result.frames.map(value => value.id)).toEqual(['id-0', 'id-1']);
  });

  it('blends only requested tail frames and still copies the exact first PNG to the final frame', async () => {
    const frames = [frame(0), frame(1), frame(2), frame(3)];
    const { io, created } = runtime({ 'parent:0': image([255, 0, 0, 255]), 'parent:2': image([0, 0, 255, 255]), 'parent:3': image([0, 255, 0, 255]) });
    const progress = vi.fn();
    const result = await correctLoopFrames(frames, { mode: 'blend', transitionFrames: 2 }, { io, onProgress: progress });
    expect(result.frames[0].url).toBe('parent:0');
    expect(result.frames[1].url).toBe('parent:1');
    expect(io.encode).toHaveBeenCalledTimes(1);
    expect(Array.from(vi.mocked(io.encode).mock.calls[0][0].data)).toEqual([128, 0, 128, 255]);
    expect(new Uint8Array(await created.get(result.frames[3].url)!.arrayBuffer())).toEqual(pngBytes);
    expect(progress).toHaveBeenLastCalledWith(2, 2);
    expect(result.changedCount).toBe(2);
  });

  it('uses premultiplied alpha instead of mixing invisible RGB into a fading edge', () => {
    expect(Array.from(blendLoopPixels(pixels([0, 0, 255, 0]), pixels([255, 0, 0, 255]), 0.5).data)).toEqual([255, 0, 0, 128]);
    expect(Array.from(blendLoopPixels(pixels([44, 55, 66, 0]), pixels([77, 88, 99, 0]), 0.5).data)).toEqual([0, 0, 0, 0]);
    const semi = blendLoopPixels(pixels([255, 0, 0, 128]), pixels([0, 255, 0, 255]), 0.5);
    expect(Array.from(semi.data)).toEqual([85, 170, 0, 192]);
  });

  it('detects alpha and visible color differences while ignoring fully transparent RGB', () => {
    expect(compareLoopPixels(pixels([255, 0, 0, 0]), pixels([0, 255, 0, 0])).identical).toBe(true);
    expect(compareLoopPixels(pixels([0, 0, 0, 0]), pixels([0, 0, 0, 255]))).toMatchObject({ identical: false, changedPixels: 1, differencePercent: 25 });
    expect(compareLoopPixels(pixels([255, 0, 0, 255]), pixels([0, 0, 255, 255])).differencePercent).toBe(50);
  });

  it('rejects dimension changes in a blended tail and leaves parent URLs untouched', async () => {
    const { io, revoked } = runtime({ 'parent:0': image([0, 0, 0, 255]), 'parent:1': image([0, 0, 0, 255, 255, 255, 255, 255], { width: 2 }), 'parent:2': image([255, 255, 255, 255]) });
    await expect(correctLoopFrames([frame(0), frame(1), frame(2)], { mode: 'blend', transitionFrames: 2 }, { io })).rejects.toThrow('尺寸一致');
    expect(revoked).toEqual([]);
  });

  it('releases partial generated output when cancellation arrives during progress', async () => {
    const controller = new AbortController();
    const { io, created, revoked } = runtime({ 'parent:0': image([255, 0, 0, 255]), 'parent:1': image([0, 0, 255, 255]), 'parent:2': image([0, 255, 0, 255]) });
    await expect(correctLoopFrames([frame(0), frame(1), frame(2)], { mode: 'blend', transitionFrames: 2 }, { io, signal: controller.signal, onProgress: done => { if (done === 1) controller.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(created.size).toBe(1);
    expect(revoked).toEqual(['generated:0']);
    expect(revoked.every(url => !url.startsWith('parent:'))).toBe(true);
  });

  it('releases previous intermediates when a later encode fails', async () => {
    const { io, revoked } = runtime({ 'parent:0': image([255, 0, 0, 255]), 'parent:1': image([0, 0, 255, 255]), 'parent:2': image([0, 0, 255, 255]), 'parent:3': image([0, 255, 0, 255]) });
    vi.mocked(io.encode).mockRejectedValueOnce(new Error('encode failed'));
    await expect(correctLoopFrames([frame(0), frame(1), frame(2), frame(3)], { mode: 'blend', transitionFrames: 3 }, { io })).rejects.toThrow('encode failed');
    expect(revoked).toEqual([]);
    vi.mocked(io.encode).mockResolvedValueOnce(png).mockRejectedValueOnce(new Error('second failed'));
    await expect(correctLoopFrames([frame(0), frame(1), frame(2), frame(3)], { mode: 'blend', transitionFrames: 3 }, { io })).rejects.toThrow('second failed');
    expect(revoked).toEqual(['generated:0']);
  });

  it('does not begin reading aborted or insufficient sequences and deduplicates URL cleanup', async () => {
    const { io } = runtime({});
    const controller = new AbortController(); controller.abort();
    await expect(correctLoopFrames([frame(0), frame(1)], { mode: 'match', transitionFrames: 1 }, { io, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(correctLoopFrames([frame(0)], { mode: 'match', transitionFrames: 1 }, { io })).rejects.toThrow('至少');
    expect(io.read).not.toHaveBeenCalled();
    releaseLoopCorrection({ ownedUrls: ['own:1', 'own:1', 'own:2'] }, io.revokeUrl);
    expect(vi.mocked(io.revokeUrl).mock.calls.map(call => call[0])).toEqual(['own:1', 'own:2']);
  });

  it('invalidates source keys when order, selection, edited content, or dimensions change', () => {
    const frames = [frame(0), frame(1)];
    const original = loopFrameSignature(frames);
    expect(loopFrameSignature(frames.map(value => ({ ...value })))).toBe(original);
    expect(loopFrameSignature([...frames].reverse())).not.toBe(original);
    for (const changes of [{ url: 'edited:url' }, { selected: false }, { width: 2 }, { time: 9 }]) expect(loopFrameSignature([frames[0], { ...frames[1], ...changes }])).not.toBe(original);
  });
});
