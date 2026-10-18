import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportGif } from './export';
import { exportCompressionSpriteSheet, exportCompressionZip } from './compressionExport';
import { exportMov, readExportPng } from './movExport';
import { exportPreviewFrames, type PreviewExportFrame } from './previewExport';

vi.mock('./export', () => ({ exportGif: vi.fn() }));
vi.mock('./compressionExport', () => ({ exportCompressionZip: vi.fn(), exportCompressionSpriteSheet: vi.fn() }));
vi.mock('./movExport', () => ({ exportMov: vi.fn(), readExportPng: vi.fn(async frame => frame.blob) }));
const frame = (variant: string, changes: Partial<PreviewExportFrame> = {}): PreviewExportFrame => ({ id: variant, name: `${variant}.png`, width: 2, height: 1, sourceIndex: 9, time: .75, blob: new Blob([variant], { type: 'image/png' }), url: `blob:${variant}`, ...changes });
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('per-preview export selection', () => {
  it('keeps original and compressed Frames exports bound to their own exact blobs', async () => {
    const original = frame('original'), compressed = frame('compressed', { width: 1 });
    await exportPreviewFrames([original], 'frames', 'idle', 18, { metadata: { variant: 'original' } });
    await exportPreviewFrames([compressed], 'frames', 'idle', 18, { metadata: { variant: 'compressed' } });
    const originalCall = vi.mocked(exportCompressionZip).mock.calls[0];
    const compressedCall = vi.mocked(exportCompressionZip).mock.calls[1];
    expect(originalCall[0][0].blob).toBe(original.blob);
    expect(compressedCall[0][0].blob).toBe(compressed.blob);
    expect(await originalCall[0][0].blob!.text()).toBe('original');
    expect(await compressedCall[0][0].blob!.text()).toBe('compressed');
    expect(originalCall.slice(1)).toEqual(['idle', 18, { variant: 'original' }]);
    expect(compressedCall.slice(1)).toEqual(['idle', 18, { variant: 'compressed' }]);
    expect(exportMov).not.toHaveBeenCalled(); expect(exportGif).not.toHaveBeenCalled();
  });

  it('respects the current sprite-sheet column selection and the provided snapshot order', async () => {
    const input = [frame('later'), frame('earlier')];
    await exportPreviewFrames(input, 'sprite_sheet', 'idle', 24, { columns: 2 });
    const [exported, name, fps, metadata, columns] = vi.mocked(exportCompressionSpriteSheet).mock.calls[0];
    expect(exported.map(item => item.name)).toEqual(['later.png', 'earlier.png']);
    expect([name, fps, metadata, columns]).toEqual(['idle', 24, {}, 2]);
    expect(exportCompressionZip).not.toHaveBeenCalled();
  });

  it('passes explicit empty sheet rows through to the sprite-sheet exporter', async () => {
    await exportPreviewFrames([frame('first')], 'sprite_sheet', 'idle', 24, { columns: 3, rows: 5 });
    const call = vi.mocked(exportCompressionSpriteSheet).mock.calls[0];
    expect(call.slice(1)).toEqual(['idle', 24, {}, 3, 5]);
    expect(exportCompressionZip).not.toHaveBeenCalled();
  });

  it('routes transparent MOV with original FPS and cancellation signal without PNG ZIP fallback', async () => {
    const controller = new AbortController(); const input = [frame('compressed')];
    await exportPreviewFrames(input, 'mov', 'idle', 59.94, { signal: controller.signal });
    expect(exportMov).toHaveBeenCalledWith(input, 'idle', 59.94, controller.signal);
    expect(readExportPng).not.toHaveBeenCalled(); expect(exportCompressionZip).not.toHaveBeenCalled();
  });

  it('reuses the GIF encoder and retains its snapshot URLs, selection and order', async () => {
    const input = [frame('second', { selected: false }), frame('first')];
    await exportPreviewFrames(input, 'gif', 'idle', 12);
    const [exported, name, fps] = vi.mocked(exportGif).mock.calls[0];
    expect(exported.map(item => item.url)).toEqual(['blob:second', 'blob:first']);
    expect(exported[0].selected).toBe(false); expect([name, fps]).toEqual(['idle', 12]);
    expect(readExportPng).not.toHaveBeenCalled(); expect(exportMov).not.toHaveBeenCalled();
  });

  it('releases temporary GIF URLs on encoder failure without revoking any preview URL', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:temporary-gif');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.mocked(exportGif).mockRejectedValueOnce(new Error('GIF failed'));
    await expect(exportPreviewFrames([frame('no-url', { url: undefined }), frame('borrowed')], 'gif', 'idle', 12)).rejects.toThrow('GIF failed');
    expect(create).toHaveBeenCalledOnce(); expect(revoke.mock.calls).toEqual([['blob:temporary-gif']]);
  });

  it('rejects empty, invalid FPS and cancelled exports before invoking any encoder', async () => {
    await expect(exportPreviewFrames([], 'frames', 'idle', 12)).rejects.toThrow('至少一帧');
    await expect(exportPreviewFrames([frame('source')], 'gif', 'idle', 0)).rejects.toThrow('帧率');
    const controller = new AbortController(); controller.abort();
    await expect(exportPreviewFrames([frame('source')], 'mov', 'idle', 12, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(exportGif).not.toHaveBeenCalled(); expect(exportCompressionZip).not.toHaveBeenCalled(); expect(exportMov).not.toHaveBeenCalled();
  });
});
