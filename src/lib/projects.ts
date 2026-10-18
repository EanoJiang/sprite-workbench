import JSZip from 'jszip';
import type { Frame, MediaSource, ProcessOptions } from '../types';
import { defaultOptions } from '../types';
import { loadMedia, releaseMedia } from './media';
import { defaultCompressionSettings } from './compression';
import type { CompressionSettings, CompressionSourceFrame } from './compression';
import type { CompressionProjectState, LoopCorrectionProjectState, SmoothingProjectState } from './projectPanelState';
import { restoreTaskInfo } from './taskInfo';
import type { ProcessingTaskInfo } from './taskInfo';
import type { LoopDifference } from './loopCorrection';
import { normalizeSheetDimension } from './sheetLayout';

export interface ProjectWorkspace {
  options: ProcessOptions;
  start: number;
  end: number;
  cursor: number;
  stride: number;
  loopMode: 'loop' | 'pingpong' | 'once';
  sheetColumns: number | 'auto';
  sheetRows?: number;
  background?: 'checker' | 'dark' | 'white' | 'rose';
  taskInfo?: ProcessingTaskInfo;
}
export interface ProjectSnapshot {
  name: string;
  fps: number;
  frames: Frame[];
  source: MediaSource | null;
  workspace: ProjectWorkspace;
  loopCorrection?: LoopCorrectionProjectState | null;
  compression?: CompressionProjectState | null;
  smoothing?: SmoothingProjectState | null;
}
export interface ProjectSummary {
  id: string;
  name: string;
  fps: number;
  frameCount: number;
  selectedFrameCount: number;
  updatedAt: string;
  thumbnail?: string;
}
export interface ProjectListResponse { directory: string; exists: boolean; projects: ProjectSummary[] }
export interface SaveProjectResponse { id: string; directory: string; path: string; project: ProjectSummary }
export interface DeleteProjectResponse { id: string; directory: string; deleted: true }
type StoredFrame = Omit<Frame, 'url' | 'selected'> & { selected?: boolean; file: string };
interface ProjectManifest {
  format: 'framecraft-project-v1';
  name: string;
  fps: number;
  frames: StoredFrame[];
  source: (Omit<MediaSource, 'url'> & { file: string; type: string }) | null;
  workspace: ProjectWorkspace;
  loopCorrection?: (Omit<LoopCorrectionProjectState, 'frames'> & { frames: StoredFrame[] | null }) | null;
  compression?: (Omit<CompressionProjectState, 'sources' | 'results'> & { sources: StoredFrame[]; results: StoredFrame[] }) | null;
  smoothing?: (Omit<SmoothingProjectState, 'frames'> & { frames: StoredFrame[] | null }) | null;
}

const abortError = () => new DOMException('读取项目已取消', 'AbortError');
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw abortError(); }
function query(directory: string): string { return `?${new URLSearchParams({ directory: directory.trim() })}`; }
function apiProject(directory: string, id: string): string { return `/api/projects/${encodeURIComponent(id)}${query(directory)}`; }
function assetUrl(directory: string, id: string, file: string): string {
  if (!file || file.startsWith('/') || file.includes('\\') || file.split('/').some(part => part === '..' || !part) || /^[a-z]+:/i.test(file)) throw new Error('工程包含无效的素材路径。');
  return `/api/projects/${encodeURIComponent(id)}/files/${file.split('/').map(encodeURIComponent).join('/')}${query(directory)}`;
}
async function request(url: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try { response = await fetch(url, init); }
  catch (reason) {
    if (init?.signal?.aborted || (reason instanceof Error && reason.name === 'AbortError')) throw reason;
    throw new Error('无法连接本地项目服务，请确认 start.ps1 已运行后重试。');
  }
  if (!response.ok) {
    let detail = `项目服务返回错误（${response.status}）。`;
    try { const data = await response.json(); if (typeof data.detail === 'string') detail = data.detail; } catch { /* Retain the HTTP status. */ }
    throw new Error(detail);
  }
  return response;
}
export async function listProjects(directory: string, signal?: AbortSignal): Promise<ProjectListResponse> {
  const data = await (await request(`/api/projects${query(directory)}`, { signal })).json() as ProjectListResponse;
  return { ...data, projects: data.projects.map(project => ({ ...project, thumbnail: project.thumbnail ? assetUrl(data.directory, project.id, project.thumbnail) : undefined })) };
}
export async function deleteProject(directory: string, id: string, signal?: AbortSignal): Promise<DeleteProjectResponse> {
  checkAbort(signal);
  return (await request(apiProject(directory, id), { method: 'DELETE', signal })).json() as Promise<DeleteProjectResponse>;
}
export async function browseProjectDirectory(directory: string): Promise<string | null> {
  const response = await request('/api/projects/browse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory }) });
  return (await response.json() as { directory: string | null }).directory;
}

async function readBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('无法读取工程素材，请重新导入后再保存。');
  return response.blob();
}
function extension(name: string, type: string, kind: MediaSource['kind']): string {
  const suffix = name.match(/\.([a-z\d]{1,8})$/i)?.[0];
  return suffix || ({ 'video/webm': '.webm', 'video/quicktime': '.mov', 'image/webp': '.webp', 'image/jpeg': '.jpg' }[type] ?? (kind === 'video' ? '.mp4' : '.png'));
}

/** Each save contains all assets and creates a separate project on disk. */
export async function saveProject(directory: string, snapshot: ProjectSnapshot, signal?: AbortSignal): Promise<SaveProjectResponse> {
  checkAbort(signal);
  if (!snapshot.source && !snapshot.frames.length && !snapshot.compression?.sources.length && !snapshot.compression?.results.length) throw new Error('请先导入素材或生成动画帧，再添加到项目列表。');
  const zip = new JSZip();
  async function storeFrames(frames: (Frame | CompressionSourceFrame)[], folder: string): Promise<StoredFrame[]> {
    const result: StoredFrame[] = [];
    for (const [index, frame] of frames.entries()) {
      checkAbort(signal);
      const file = `${folder}/${String(index + 1).padStart(4, '0')}.png`;
      const blob = 'blob' in frame ? frame.blob : await readBlob(frame.url, signal);
      zip.file(file, await blob.arrayBuffer());
      result.push({ id: frame.id, name: frame.name, sourceIndex: frame.sourceIndex, time: frame.time, width: frame.width, height: frame.height, ...('anchor' in frame && frame.anchor ? { anchor: frame.anchor } : {}), ...('selected' in frame ? { selected: frame.selected } : {}), file });
    }
    return result;
  }
  const manifest: ProjectManifest = { format: 'framecraft-project-v1', name: snapshot.name.trim() || '未命名动画', fps: snapshot.fps, workspace: snapshot.workspace, source: null, frames: await storeFrames(snapshot.frames, 'frames') };
  if (snapshot.source) {
    const { url, ...metadata } = snapshot.source;
    const blob = await readBlob(url, signal);
    const type = blob.type || (metadata.kind === 'video' ? 'video/mp4' : 'image/png');
    const file = `source/original${extension(metadata.name, type, metadata.kind)}`;
    zip.file(file, await blob.arrayBuffer());
    manifest.source = { ...metadata, file, type };
  }
  if (snapshot.loopCorrection) manifest.loopCorrection = { ...snapshot.loopCorrection, frames: snapshot.loopCorrection.frames ? await storeFrames(snapshot.loopCorrection.frames, 'loop') : null };
  if (snapshot.compression) manifest.compression = { ...snapshot.compression, sources: await storeFrames(snapshot.compression.sources, 'compression/sources'), results: await storeFrames(snapshot.compression.results, 'compression/results') };
  if (snapshot.smoothing) manifest.smoothing = { ...snapshot.smoothing, frames: snapshot.smoothing.frames ? await storeFrames(snapshot.smoothing.frames, 'smoothing') : null };
  zip.file('project.json', JSON.stringify(manifest));
  const archive = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  checkAbort(signal);
  const body = new FormData(); body.set('archive', archive, 'animation-project.zip');
  return (await request(`/api/projects${query(directory)}`, { method: 'POST', body, signal })).json() as Promise<SaveProjectResponse>;
}

function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function number(value: unknown, fallback: number, min: number, max: number, round = false): number {
  const result = typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  return round ? Math.round(result) : result;
}
export function restoreProcessOptions(value: unknown): ProcessOptions {
  const data = object(value); const result = { ...defaultOptions };
  for (const key of ['removeBackground'] as const) if (typeof data[key] === 'boolean') result[key] = data[key];
  if (typeof data.keyColor === 'string' && /^#[a-f\d]{6}$/i.test(data.keyColor)) result.keyColor = data.keyColor;
  for (const key of ['tolerance', 'softness', 'spill'] as const) result[key] = number(data[key], result[key], 0, 100);
  result.erosion = number(data.erosion, result.erosion, 0, 8);
  result.targetHeight = number(data.targetHeight, result.targetHeight, 16, 4096, true);
  result.padding = number(data.padding, result.padding, 0, 2047, true);
  if (data.layout === 'original' || data.layout === 'square') result.layout = data.layout;
  if (data.alignment === 'center' || data.alignment === 'bottom') result.alignment = data.alignment;
  result.cleanup = 'none';
  for (const key of ['watermarkRemoval', 'backgroundToBlack', 'backgroundDesaturate', 'semitransparentToBlack', 'semitransparentToOpaque'] as const) {
    result[key] = typeof data[key] === 'boolean' ? data[key] : key === 'semitransparentToBlack' && data.cleanup === 'dark' || key === 'semitransparentToOpaque' && data.cleanup === 'opaque';
  }
  if (data.engine === 'chroma' || data.engine === 'luma' || data.engine === 'birefnet' || data.engine === 'corridorkey' || data.engine === 'hybrid') result.engine = data.engine;
  result.lumaBlack = number(data.lumaBlack, 0, 0, 254, true);
  result.lumaWhite = Math.max(result.lumaBlack + 1, number(data.lumaWhite, 85, result.lumaBlack + 1, 255, true));
  result.lumaGamma = number(data.lumaGamma, .55, .05, 4);
  result.lumaStrength = number(data.lumaStrength, 1.7, 0, 2);
  result.lumaPolarity = data.lumaPolarity === 'bright' || data.lumaPolarity === 'dark' ? data.lumaPolarity : 'auto';
  if (data.aiDevice === 'auto' || data.aiDevice === 'cuda' || data.aiDevice === 'cpu') result.aiDevice = data.aiDevice;
  if (data.birefnetVariant === 'standard' || data.birefnetVariant === 'hr-matting' || data.birefnetVariant === 'lite') result.birefnetVariant = data.birefnetVariant;
  result.aiResolution = number(data.aiResolution, result.aiResolution ?? 768, 256, 4096, true);
  return result;
}
function workspace(value: unknown): ProjectWorkspace {
  const data = object(value);
  return {
    options: restoreProcessOptions(data.options), start: number(data.start, 1, 1, 100_000_000, true),
    end: number(data.end, 1, 1, 100_000_000, true), cursor: number(data.cursor, 1, 1, 100_000_000, true),
    stride: number(data.stride, 1, 1, 120, true), loopMode: data.loopMode === 'pingpong' || data.loopMode === 'once' ? data.loopMode : 'loop',
    sheetColumns: data.sheetColumns === 'auto' || data.sheetColumns === undefined ? 'auto' : number(data.sheetColumns, 1, 1, 400, true),
    ...(typeof data.sheetRows === 'number' ? { sheetRows: normalizeSheetDimension(data.sheetRows) } : {}),
    ...(data.background === 'checker' || data.background === 'dark' || data.background === 'white' || data.background === 'rose' ? { background: data.background } : {}),
    ...(restoreTaskInfo(data.taskInfo) ? { taskInfo: restoreTaskInfo(data.taskInfo) } : {}),
  };
}
function compressionSettings(value: unknown): CompressionSettings {
  const data = object(value);
  return { resizeMode: data.resizeMode === 'hard' ? 'hard' : data.resizeMode === 'soft' ? 'soft' : data.algorithm === 'nearest' ? 'hard' : 'soft', scale: number(data.scale, defaultCompressionSettings.scale, .01, 1), algorithm: data.algorithm === 'palette' || data.algorithm === 'nearest' ? data.algorithm : 'lanczos', alphaThreshold: number(data.alphaThreshold, defaultCompressionSettings.alphaThreshold, 0, 255, true), sharpen: number(data.sharpen, defaultCompressionSettings.sharpen, 0, 200), colors: number(data.colors, defaultCompressionSettings.colors, 2, 256, true) };
}
function loopDifference(value: unknown): LoopDifference | undefined {
  const data = object(value);
  if (typeof data.sameDimensions !== 'boolean' || typeof data.identical !== 'boolean' || typeof data.changedPixels !== 'number' || !Number.isInteger(data.changedPixels) || data.changedPixels < 0 || typeof data.totalPixels !== 'number' || !Number.isInteger(data.totalPixels) || data.totalPixels < 1 || typeof data.differencePercent !== 'number' || !Number.isFinite(data.differencePercent) || data.differencePercent < 0 || data.differencePercent > 100) return undefined;
  return { sameDimensions: data.sameDimensions, identical: data.identical, changedPixels: data.changedPixels, totalPixels: data.totalPixels, differencePercent: data.differencePercent };
}
function storedFrames(value: unknown): StoredFrame[] {
  if (!Array.isArray(value) || value.length > 400) throw new Error('工程帧列表无效或超过 400 帧。');
  for (const frame of value) {
    if (!frame || typeof frame.id !== 'string' || typeof frame.name !== 'string' || typeof frame.file !== 'string' || !Number.isInteger(frame.width) || frame.width < 1 || !Number.isInteger(frame.height) || frame.height < 1 || !Number.isInteger(frame.sourceIndex) || frame.sourceIndex < 0 || !Number.isFinite(frame.time) || frame.time < 0 || (frame.anchor !== undefined && frame.anchor !== 'center' && frame.anchor !== 'bottom')) throw new Error('工程帧信息不完整，请检查项目文件。');
  }
  return value as StoredFrame[];
}

export async function loadProject(directory: string, id: string, signal?: AbortSignal): Promise<ProjectSnapshot> {
  const manifest = await (await request(apiProject(directory, id), { signal })).json() as ProjectManifest;
  checkAbort(signal);
  if (manifest.format !== 'framecraft-project-v1') throw new Error('此文件夹不是受支持的帧动画工程。');
  const loaded: ProjectSnapshot = { name: typeof manifest.name === 'string' ? manifest.name : '未命名动画', fps: number(manifest.fps, 12, 1, 240), frames: [], source: null, workspace: workspace(manifest.workspace) };
  const restoreFrames = (value: unknown): Frame[] => storedFrames(value).map(({ file, ...frame }) => ({ ...frame, selected: frame.selected !== false, url: assetUrl(directory, id, file) }));
  async function restoreCompression(value: unknown): Promise<CompressionSourceFrame[]> {
    const restored: CompressionSourceFrame[] = [];
    try {
      for (const { file, selected: _selected, ...frame } of storedFrames(value)) {
        checkAbort(signal);
        const blob = await readBlob(assetUrl(directory, id, file), signal); checkAbort(signal);
        restored.push({ ...frame, blob, url: URL.createObjectURL(blob) });
      }
      return restored;
    } catch (reason) { restored.forEach(frame => URL.revokeObjectURL(frame.url)); throw reason; }
  }
  try {
    loaded.frames = restoreFrames(manifest.frames);
    if (manifest.source) {
      const source = manifest.source;
      const blob = await readBlob(assetUrl(directory, id, source.file), signal); checkAbort(signal);
      loaded.source = await loadMedia(new File([blob], source.name || `original${extension('', source.type, source.kind)}`, { type: source.type || blob.type }), number(source.fps, loaded.fps, 1, 120));
      checkAbort(signal);
      if (source.kind === 'demo') loaded.source.kind = 'demo';
    }
    if (manifest.loopCorrection) {
      const loop = manifest.loopCorrection;
      const settings = object(loop.settings);
      loaded.loopCorrection = { enabled: loop.enabled === true, settings: { mode: settings.mode === 'blend' ? 'blend' : 'match', transitionFrames: number(settings.transitionFrames, 4, 1, 400, true) }, frames: loop.frames ? restoreFrames(loop.frames) : null, originalDifference: loopDifference(loop.originalDifference), ...(loop.changedCount !== undefined ? { changedCount: number(loop.changedCount, 0, 0, 400, true) } : {}) };
    }
    if (manifest.compression) {
      const compression = manifest.compression;
      loaded.compression = { settings: compressionSettings(compression.settings), lastSettings: compression.lastSettings ? compressionSettings(compression.lastSettings) : null, sourceLabel: typeof compression.sourceLabel === 'string' ? compression.sourceLabel : '', fps: number(compression.fps, loaded.fps, 1, 60), sources: [], results: [] };
      loaded.compression.sources = await restoreCompression(compression.sources);
      loaded.compression.results = await restoreCompression(compression.results);
    }
    if (manifest.smoothing) {
      const smoothing = manifest.smoothing;
      loaded.smoothing = {
        enabled: smoothing.enabled === true,
        ...(typeof smoothing.pipelineVersion === 'number' && Number.isSafeInteger(smoothing.pipelineVersion) && smoothing.pipelineVersion > 0 ? { pipelineVersion: smoothing.pipelineVersion } : {}),
        options: restoreProcessOptions(smoothing.options), frames: smoothing.frames ? restoreFrames(smoothing.frames) : null,
      };
    }
    checkAbort(signal);
    return loaded;
  } catch (reason) { releaseLoadedProject(loaded); throw reason; }
}

/** Use only when a loaded snapshot was not handed to the workspace and panels. */
export function releaseLoadedProject(snapshot: ProjectSnapshot): void {
  if (snapshot.source) releaseMedia(snapshot.source);
  const urls = new Set([snapshot.source?.url, ...snapshot.frames.map(frame => frame.url), ...(snapshot.loopCorrection?.frames ?? []).map(frame => frame.url), ...(snapshot.compression?.sources ?? []).map(frame => frame.url), ...(snapshot.compression?.results ?? []).map(frame => frame.url), ...(snapshot.smoothing?.frames ?? []).map(frame => frame.url)]);
  for (const url of urls) if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}
