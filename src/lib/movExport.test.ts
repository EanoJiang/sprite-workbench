import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { downloadBlob } from './export';
import { buildMovArchive, exportMov, readExportPng, validateMovFrames, type MovExportFrame } from './movExport';

vi.mock('./export', async original => ({ ...await original<typeof import('./export')>(), downloadBlob: vi.fn() }));
const palettePng = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABAQMAAADO7O3JAAAABlBMVEX/AAAAAABBoxIDAAAAAnRSTlP/AOW3MEoAAAAKSURBVHicY3AAAABCAEEpN/TvAAAAAElFTkSuQmCC'), value => value.charCodeAt(0));
const frame = (changes: Partial<MovExportFrame> = {}): MovExportFrame => ({ name: 'walk/source-009.png', width: 2, height: 1, time: .75, sourceIndex: 9, blob: new Blob([palettePng], { type: 'image/png' }), ...changes });
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('transparent MOV archive contract', () => {
  it('preserves exact palette PNG bytes, input order, frame placement and fractional FPS in a root-only ZIP', async () => {
    const input = [frame({ anchor: 'center' }), frame({ name: 'different-source.png', sourceIndex: 2, anchor: 'bottom' })];
    const archive = await buildMovArchive(input, '../walk.zip', 59.94);
    const zip = await JSZip.loadAsync(await archive.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(['frame_001.png', 'frame_002.png', 'manifest.json']);
    expect(await zip.file('frame_001.png')!.async('uint8array')).toEqual(palettePng);
    expect(await zip.file('frame_002.png')!.async('uint8array')).toEqual(palettePng);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest).toEqual({ format: 'framecraft-mov-v1', name: '_walk', fps: 59.94, frames: [
      { filename: 'frame_001.png', width: 2, height: 1, anchor: 'center' },
      { filename: 'frame_002.png', width: 2, height: 1, anchor: 'bottom' },
    ] });
    expect(input[0].name).toBe('walk/source-009.png');
    expect(palettePng[25]).toBe(3); // Indexed PNG and its original tRNS chunk pass through intact.
  });

  it('freezes caller sequence before asynchronously reading original URLs', async () => {
    const input = [frame({ blob: undefined, url: 'blob:first' }), frame({ blob: undefined, url: 'blob:second' })];
    const fetchMock = vi.fn(async () => { input.pop(); return new Response(palettePng); });
    vi.stubGlobal('fetch', fetchMock);
    const archive = await buildMovArchive(input, 'walk', 23.976);
    expect(fetchMock.mock.calls).toHaveLength(2);
    const zip = await JSZip.loadAsync(await archive.arrayBuffer());
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.frames).toHaveLength(2);
    expect(manifest.fps).toBe(23.976);
  });

  it('converts an imported non-PNG frame once, closes its bitmap and clears the temporary canvas', async () => {
    const bitmap = { width: 2, height: 1, close: vi.fn() };
    const drawImage = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob: (callback: BlobCallback, type: string) => { expect(type).toBe('image/png'); callback(new Blob([palettePng], { type })); } };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
    const output = await readExportPng(frame({ blob: new Blob(['WEBP bytes'], { type: 'image/webp' }) }));
    expect(new Uint8Array(await output.arrayBuffer())).toEqual(palettePng);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(0); expect(canvas.height).toBe(0);
  });

  it('rejects missing frames, excessive dimensions, total canvas size and mismatched PNG metadata before upload', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    expect(() => validateMovFrames([], 12)).toThrow('1 到 400');
    expect(() => validateMovFrames([frame()], 0)).toThrow('帧率');
    expect(() => validateMovFrames([frame({ width: 8193 })], 12)).toThrow('8192');
    expect(() => validateMovFrames(Array.from({ length: 4 }, () => frame({ width: 8000, height: 4000 })), 12)).toThrow('总像素');
    await expect(exportMov([frame({ width: 3 })], 'bad', 12)).rejects.toThrow('尺寸与帧信息不一致');
    expect(fetchMock).not.toHaveBeenCalled(); expect(downloadBlob).not.toHaveBeenCalled();
  });
});

describe('transparent MOV download', () => {
  it('uploads the agreed multipart archive and downloads the actual returned movie bytes', async () => {
    const movie = new Blob(['real qtrle movie bytes'], { type: 'video/quicktime' });
    const fetchMock = vi.fn(async () => new Response(movie)); vi.stubGlobal('fetch', fetchMock);
    await exportMov([frame()], 'current_clip.zip', 12);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/exports/mov'); expect(init.method).toBe('POST');
    const archive = (init.body as FormData).get('archive') as File;
    expect(archive.name).toBe('current_clip.zip');
    const zip = await JSZip.loadAsync(await archive.arrayBuffer());
    expect(await zip.file('frame_001.png')!.async('uint8array')).toEqual(palettePng);
    const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0];
    expect(filename).toBe('current_clip.mov'); expect(await blob.text()).toBe('real qtrle movie bytes');
  });

  it('surfaces backend failures and cancellation without downloading a fabricated movie', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'MOV 编码器不可用' }), { status: 503 })); vi.stubGlobal('fetch', fetchMock);
    await expect(exportMov([frame()], 'walk', 12)).rejects.toThrow('MOV 编码器不可用');
    expect(downloadBlob).not.toHaveBeenCalled();
    fetchMock.mockClear(); const controller = new AbortController(); controller.abort();
    await expect(exportMov([frame()], 'walk', 12, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled(); expect(downloadBlob).not.toHaveBeenCalled();
  });
});
