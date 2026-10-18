import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { defaultOptions } from '../types';
import type { Frame } from '../types';
import type { ProjectSnapshot } from './projects';
import { deleteProject, listProjects, loadProject, releaseLoadedProject, restoreProcessOptions, saveProject } from './projects';
import { defaultCompressionSettings } from './compression';
import { loadMedia, releaseMedia } from './media';

vi.mock('./media', () => ({ loadMedia: vi.fn(), releaseMedia: vi.fn() }));
const frame = (changes: Partial<Frame> = {}): Frame => ({ id: 'a', name: 'step.png', sourceIndex: 7, time: .5, width: 64, height: 80, selected: true, url: 'blob:raw', ...changes });
const workspace = { options: defaultOptions, start: 3, end: 18, cursor: 9, stride: 2, loopMode: 'pingpong' as const, sheetColumns: 4, background: 'dark' as const };
function snapshot(): ProjectSnapshot { return { name: '步行动画', fps: 12, source: null, frames: [frame({ selected: false }), frame({ id: 'b', name: 'walk.png', url: 'blob:second', sourceIndex: 4, time: .25 })], workspace }; }
function manifest() {
  return { format: 'framecraft-project-v1', name: '步行动画', fps: 12, source: null, workspace, frames: [{ id: 'b', name: 'walk.png', sourceIndex: 4, time: .25, selected: false, width: 64, height: 80, file: 'frames/0001.png' }] };
}

describe('persistent animation projects', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

  it('saves an independent archive with exact assets, frame order, selections, and panel settings', async () => {
    const rawBytes = new Uint8Array([1, 2, 3]);
    const secondBytes = new Uint8Array([4, 5, 6]);
    const compressedBytes = new Uint8Array([9, 8, 7]);
    const project = snapshot();
    project.workspace = { ...project.workspace, sheetColumns: 3, sheetRows: 5 };
    project.source = { kind: 'video', name: 'walk.webm', url: 'blob:video', fps: 24, width: 100, height: 100, duration: 2, totalFrames: 48 };
    const compressed = { ...frame({ id: 'c' }), blob: new Blob([compressedBytes], { type: 'image/png' }) };
    project.compression = { settings: defaultCompressionSettings, lastSettings: null, sourceLabel: '独立帧', fps: 16, sources: [compressed], results: [] };
    project.loopCorrection = { enabled: true, settings: { mode: 'match', transitionFrames: 3 }, frames: [frame()], changedCount: 1, originalDifference: { sameDimensions: true, identical: false, changedPixels: 2, totalPixels: 10, differencePercent: 20 } };
    project.smoothing = { enabled: true, pipelineVersion: 2, options: { ...defaultOptions, engine: 'luma', watermarkRemoval: true, backgroundDesaturate: true }, frames: [frame({ url: 'blob:smoothed' })] };
    let archive: JSZip | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/projects?')) {
        const blob = (init!.body as FormData).get('archive') as Blob;
        archive = await JSZip.loadAsync(await blob.arrayBuffer());
        return Response.json({ id: 'new-id', directory: 'E:/Projects', path: 'E:/Projects/new-id', project: {} });
      }
      const bytes = url === 'blob:second' ? secondBytes : rawBytes;
      return new Response(new Blob([bytes], { type: url === 'blob:video' ? 'video/webm' : 'image/png' }));
    }));
    const saved = await saveProject('E:/Projects', project);
    expect(saved.id).toBe('new-id');
    const stored = JSON.parse(await archive!.file('project.json')!.async('string'));
    expect(stored.format).toBe('framecraft-project-v1');
    expect(stored.frames.map((item: Frame) => [item.id, item.sourceIndex, item.selected])).toEqual([['a', 7, false], ['b', 4, true]]);
    expect(stored.workspace).toEqual(project.workspace);
    expect(stored.source).toMatchObject({ name: 'walk.webm', type: 'video/webm', file: 'source/original.webm' });
    expect(stored.loopCorrection.originalDifference.differencePercent).toBe(20);
    expect(stored.compression).toMatchObject({ fps: 16, sourceLabel: '独立帧', results: [] });
    expect(stored.smoothing).toMatchObject({ enabled: true, pipelineVersion: 2, options: { engine: 'luma', watermarkRemoval: true, backgroundDesaturate: true }, frames: [{ file: 'smoothing/0001.png', id: 'a' }] });
    expect(await archive!.file('smoothing/0001.png')!.async('uint8array')).toEqual(rawBytes);
    expect(await archive!.file('frames/0001.png')!.async('uint8array')).toEqual(rawBytes);
    expect(await archive!.file('frames/0002.png')!.async('uint8array')).toEqual(secondBytes);
    expect(await archive!.file('compression/sources/0001.png')!.async('uint8array')).toEqual(compressedBytes);
    expect(await archive!.file('source/original.webm')!.async('uint8array')).toEqual(rawBytes);
    expect(stored.frames[0].url).toBeUndefined();
    expect(stored.compression.sources[0].blob).toBeUndefined();
  });

  it('restores Luma, independent cleanup flags, smoothing output and hard palette scaling together', async () => {
    const data = { ...manifest(), workspace: { ...workspace, options: { ...defaultOptions, engine: 'luma', lumaBlack: 40, lumaWhite: 150, lumaGamma: 1.3, lumaStrength: 0, lumaPolarity: 'dark', watermarkRemoval: true, backgroundToBlack: true, backgroundDesaturate: true, semitransparentToOpaque: true } },
      smoothing: { enabled: true, options: { ...defaultOptions, engine: 'luma', watermarkRemoval: true }, frames: [{ ...manifest().frames[0], file: 'smoothing/0001.png' }] },
      compression: { settings: { ...defaultCompressionSettings, algorithm: 'palette', resizeMode: 'hard' }, lastSettings: null, fps: 18, sourceLabel: '', sources: [], results: [] },
    };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
    const restored = await loadProject('FrameAnimProjectList', 'saved');
    expect(restored.workspace.options).toMatchObject({ engine: 'luma', lumaBlack: 40, lumaWhite: 150, lumaGamma: 1.3, lumaStrength: 0, lumaPolarity: 'dark', watermarkRemoval: true, backgroundToBlack: true, backgroundDesaturate: true, semitransparentToOpaque: true });
    expect(restored.smoothing).toMatchObject({ enabled: true, options: { engine: 'luma', watermarkRemoval: true }, frames: [{ id: 'b', url: '/api/projects/saved/files/smoothing/0001.png?directory=FrameAnimProjectList' }] });
    expect(restored.smoothing?.pipelineVersion).toBeUndefined();
    expect(restored.compression?.settings).toMatchObject({ algorithm: 'palette', resizeMode: 'hard' });
  });

  it.each([undefined, 2])('round trips smoothing pipeline version %s without stamping older results', async pipelineVersion => {
    const project = snapshot();
    project.smoothing = { enabled: true, ...(pipelineVersion === undefined ? {} : { pipelineVersion }), options: defaultOptions, frames: [frame({ url: 'blob:smoothed' })] };
    let stored: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/projects?')) {
        const blob = (init!.body as FormData).get('archive') as Blob;
        const archive = await JSZip.loadAsync(await blob.arrayBuffer());
        stored = JSON.parse(await archive.file('project.json')!.async('string')) as Record<string, unknown>;
        return Response.json({ id: 'saved', directory: 'FrameAnimProjectList', project: {} });
      }
      if (url.startsWith('/api/projects/saved?')) return Response.json(stored);
      return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
    }));
    await saveProject('FrameAnimProjectList', project);
    const restored = await loadProject('FrameAnimProjectList', 'saved');
    expect((stored!.smoothing as { pipelineVersion?: number }).pipelineVersion).toBe(pipelineVersion);
    expect(restored.smoothing?.pipelineVersion).toBe(pipelineVersion);
    expect(restored.smoothing?.enabled).toBe(true);
    expect(restored.smoothing?.frames).toMatchObject([{ id: 'a', url: '/api/projects/saved/files/smoothing/0001.png?directory=FrameAnimProjectList' }]);
    if (pipelineVersion === undefined) expect(stored!.smoothing).not.toHaveProperty('pipelineVersion');
  });

  it('migrates former edge cleanup and keeps Luma white above its black level', () => {
    expect(restoreProcessOptions({ cleanup: 'dark' })).toMatchObject({ cleanup: 'none', semitransparentToBlack: true, backgroundToBlack: false });
    expect(restoreProcessOptions({ cleanup: 'opaque' })).toMatchObject({ cleanup: 'none', semitransparentToOpaque: true });
    expect(restoreProcessOptions({ lumaBlack: 254 })).toMatchObject({ lumaBlack: 254, lumaWhite: 255 });
  });

  it.each([[5, 5], [-3, 1], [9999, 400], [3.8, 3]])('restores explicit sheet rows %s as %s', async (sheetRows, expected) => {
    const data = { ...manifest(), workspace: { ...workspace, sheetColumns: 3, sheetRows } };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
    const loaded = await loadProject('FrameAnimProjectList', 'saved');
    expect(loaded.workspace.sheetColumns).toBe(3);
    expect(loaded.workspace.sheetRows).toBe(expected);
  });

  it('restores static frames and editable source media with safe workspace defaults', async () => {
    const data = { ...manifest(), workspace: { options: { targetHeight: -30, keyColor: 'invalid', alignment: 'bottom', removeBackground: false }, start: 'bad', end: 18, cursor: 9999, stride: 0, loopMode: 'bad', sheetColumns: -9, background: 'white' }, source: { kind: 'video', file: 'source/original.webm', name: 'walk.webm', type: 'video/webm', fps: 24 } };
    const loadedMedia = { kind: 'video' as const, name: 'walk.webm', url: 'blob:loaded-video', width: 100, height: 100, duration: 2, fps: 24, totalFrames: 48 };
    vi.mocked(loadMedia).mockResolvedValue(loadedMedia);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/files/') ? new Response(new Blob([new Uint8Array([1])])) : Response.json(data)));
    const loaded = await loadProject('E:/工程 库', 'my-project');
    expect(loaded.frames[0]).toMatchObject({ id: 'b', selected: false, sourceIndex: 4, time: .25 });
    expect(loaded.frames[0].url).toBe('/api/projects/my-project/files/frames/0001.png?directory=E%3A%2F%E5%B7%A5%E7%A8%8B+%E5%BA%93');
    expect(loaded.workspace).toMatchObject({ start: 1, end: 18, stride: 1, loopMode: 'loop', sheetColumns: 1, background: 'white' });
    expect(loaded.workspace.sheetRows).toBeUndefined();
    expect(loaded.workspace.options).toMatchObject({ ...defaultOptions, targetHeight: 16, alignment: 'bottom', removeBackground: false });
    expect(loadMedia).toHaveBeenCalledOnce();
    expect(loaded.source).toBe(loadedMedia);
  });

  it('cleans up restored compression object URLs when a later asset fails', async () => {
    const compressed = { ...manifest().frames[0], file: 'compression/sources/0001.png' };
    const data = { ...manifest(), compression: { settings: defaultCompressionSettings, lastSettings: null, fps: 12, sourceLabel: '输入', sources: [compressed], results: [{ ...compressed, file: 'compression/results/0001.png' }] } };
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:restored');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/results/') ? new Response('', { status: 404 }) : url.includes('/files/') ? new Response(new Blob([new Uint8Array([1])])) : Response.json(data)));
    await expect(loadProject('FrameAnimProjectList', 'broken')).rejects.toThrow('素材');
    expect(revoke).toHaveBeenCalledWith('blob:restored');
  });

  it('rejects traversal asset references before requesting files', async () => {
    const data = manifest(); data.frames[0].file = '../other.png';
    const fetch = vi.fn(async () => Response.json(data)); vi.stubGlobal('fetch', fetch);
    await expect(loadProject('FrameAnimProjectList', 'broken')).rejects.toThrow('素材路径');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not send a save after cancellation and releases owned URLs on discard', async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(saveProject('FrameAnimProjectList', snapshot(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const discarded = snapshot(); discarded.source = { kind: 'video', name: 'walk.mp4', url: 'blob:video', width: 1, height: 1, duration: 1, fps: 12, totalFrames: 12 };
    releaseLoadedProject(discarded);
    expect(releaseMedia).toHaveBeenCalledWith(discarded.source);
    expect(new Set(revoke.mock.calls.flat())).toEqual(new Set(['blob:video', 'blob:raw', 'blob:second']));
  });

  it('resolves thumbnail assets against the canonical directory returned by the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ directory: 'E:/工作/FrameAnimProjectList', exists: true, projects: [{ id: 'one', name: 'Walk', fps: 12, frameCount: 1, selectedFrameCount: 1, updatedAt: '2026-10-18', thumbnail: 'frames/0001.png' }] })));
    const listed = await listProjects('FrameAnimProjectList');
    expect(listed.projects[0].thumbnail).toContain('/api/projects/one/files/frames/0001.png?directory=E%3A%2F');
    expect(listed.directory).toBe('E:/工作/FrameAnimProjectList');
  });

  it('deletes only the specified project with an encoded directory and ID', async () => {
    const result = { id: '步行 /#?', directory: 'E:/工程 库 &备份', deleted: true };
    const fetch = vi.fn(async () => Response.json(result)); vi.stubGlobal('fetch', fetch);
    await expect(deleteProject('  E:/工程 库 &备份  ', result.id)).resolves.toEqual(result);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/projects/%E6%AD%A5%E8%A1%8C%20%2F%23%3F?directory=E%3A%2F%E5%B7%A5%E7%A8%8B+%E5%BA%93+%26%E5%A4%87%E4%BB%BD');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it.each([404, 409])('preserves the server deletion error for HTTP %s', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ detail: '无法删除：项目正在使用或不存在。' }, { status })));
    await expect(deleteProject('FrameAnimProjectList', 'saved')).rejects.toThrow('无法删除：项目正在使用或不存在。');
  });

  it('does not send deletion after cancellation and passes a live cancellation signal', async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ id: 'saved', directory: 'FrameAnimProjectList', deleted: true })); vi.stubGlobal('fetch', fetch);
    await expect(deleteProject('FrameAnimProjectList', 'saved', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
    const active = new AbortController();
    await deleteProject('FrameAnimProjectList', 'saved', active.signal);
    expect(fetch.mock.calls[0][1]?.signal).toBe(active.signal);
  });
});
