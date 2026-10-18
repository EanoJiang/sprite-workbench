import JSZip from 'jszip';
import type { Frame, FrameCanvasAnchor } from '../types';
import { canvasToBlob } from './media';

export interface TunerStatus {
  installed: boolean;
  running: boolean;
  url?: string | null;
  error?: string | null;
  source_revision?: string;
}

export interface TunerImportResult {
  project: string;
  profile: string;
  animation: string;
  frameCount: number;
  url: string;
  editorUrl?: string;
}

export interface TunerProgress { stage: 'packing' | 'uploading'; done: number; total: number; }
export interface TunerCanvas { width: number; height: number; originPixelX: number; originPixelY: number; }
const MAX_FRAMES = 400;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/**
 * Keep the editor's runtime origin on one shared canvas for every frame.
 * Extracted frames carry the workbench alignment; hand imported sequences
 * default to the Lite editor's bottom-center anchor for compatibility.
 */
export function sourceCanvasForFrames(frames: ReadonlyArray<Pick<Frame, 'width' | 'height' | 'anchor'>>): TunerCanvas | undefined {
  const valid = frames.filter(frame => Number.isFinite(frame.width) && Number.isFinite(frame.height) && frame.width > 0 && frame.height > 0);
  if (!valid.length) return undefined;
  const width = Math.max(...valid.map(frame => Math.round(frame.width)));
  const height = Math.max(...valid.map(frame => Math.round(frame.height)));
  const anchor: FrameCanvasAnchor = valid.some(frame => frame.anchor === 'center') ? 'center' : 'bottom';
  return { width, height, originPixelX: width * 0.5, originPixelY: anchor === 'center' ? height * 0.5 : height };
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('发送已取消', 'AbortError');
}

async function apiError(response: Response): Promise<Error> {
  try {
    const data = await response.json();
    return new Error(typeof data.detail === 'string' ? data.detail : typeof data.error === 'string' ? data.error : '调参服务暂时不可用，请重试。');
  } catch { return new Error(`调参服务返回错误 (${response.status})，请检查本地服务后重试。`); }
}

async function jsonRequest<T>(url: string, method: 'GET' | 'POST', signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(), 45000);
  try {
    checkAbort(signal);
    const response = await fetch(url, { method, signal: controller.signal });
    if (!response.ok) throw await apiError(response);
    return await response.json() as T;
  } catch (error) {
    if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
    if (error instanceof Error && error.name === 'AbortError') throw new Error('启动调参服务超时，请检查本地服务后重试。');
    if (error instanceof TypeError) throw new Error('无法连接本地服务，请运行项目中的 start.ps1 后重试。');
    throw error;
  } finally { window.clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}

export function getTunerStatus(signal?: AbortSignal): Promise<TunerStatus> {
  return jsonRequest('/api/tuner/status', 'GET', signal);
}

export function startTuner(signal?: AbortSignal): Promise<TunerStatus> {
  return jsonRequest('/api/tuner/start', 'POST', signal);
}

export function localTunerUrl(value: string): string {
  const url = new URL(value, window.location.origin);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('调参服务返回了无效的本地编辑器地址。');
  return url.href;
}

async function framePng(frame: Frame, signal?: AbortSignal): Promise<Blob> {
  checkAbort(signal);
  const response = await fetch(frame.url, { signal });
  if (!response.ok) throw new Error(`无法读取「${frame.name}」，请重新导入这组动画帧。`);
  const blob = await response.blob();
  const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (signature.length === 8 && signature.every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])) return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  try {
    checkAbort(signal);
    if (bitmap.width > 16384 || bitmap.height > 16384 || bitmap.width * bitmap.height > 64_000_000) throw new Error(`「${frame.name}」尺寸过大，请先缩小图片。`);
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法转换图片，请重新打开页面后重试。');
    context.drawImage(bitmap, 0, 0);
    return await canvasToBlob(canvas);
  } finally { bitmap.close(); canvas.width = 0; canvas.height = 0; }
}

export async function sendFramesToTuner(frames: Frame[], name: string, fps: number, onProgress?: (progress: TunerProgress) => void, signal?: AbortSignal): Promise<TunerImportResult> {
  if (!frames.length) throw new Error('请先在抽帧工作台勾选要发送的动画帧。');
  if (frames.length > MAX_FRAMES) throw new Error(`每次最多发送 ${MAX_FRAMES} 帧，请分批发送。`);
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error('播放帧率需要在 1–120 FPS 之间。');
  const snapshot = [...frames];
  const zip = new JSZip(); let bytes = 0;
  onProgress?.({ stage: 'packing', done: 0, total: snapshot.length });
  for (const [index, frame] of snapshot.entries()) {
    checkAbort(signal);
    const png = await framePng(frame, signal); bytes += png.size;
    if (bytes > MAX_ARCHIVE_BYTES) throw new Error('这组帧超过 256 MB，请降低尺寸或分批发送。');
    zip.file(`frame_${String(index + 1).padStart(4, '0')}.png`, png);
    onProgress?.({ stage: 'packing', done: index + 1, total: snapshot.length });
  }
  zip.file('manifest.json', JSON.stringify({ format: 'framecraft-tuner-v1', name: name.trim().slice(0, 120) || 'animation', fps, frameCount: snapshot.length, frames: snapshot.map((frame, index) => ({ filename: `frame_${String(index + 1).padStart(4, '0')}.png`, sourceName: frame.name, sourceFrame: frame.sourceIndex, sourceTimeSeconds: frame.time, width: frame.width, height: frame.height, anchor: frame.anchor || 'bottom' })) }));
  checkAbort(signal);
  const archive = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, () => checkAbort(signal));
  const form = new FormData(); form.set('archive', archive, 'frames.zip'); form.set('name', name.trim().slice(0, 120) || 'animation'); form.set('fps', String(fps));
  form.set('anchor', snapshot.some(frame => frame.anchor === 'center') ? 'center' : 'bottom');
  onProgress?.({ stage: 'uploading', done: snapshot.length, total: snapshot.length });
  let response: Response;
  try { response = await fetch('/api/tuner/import', { method: 'POST', body: form, signal }); }
  catch (error) { if (signal?.aborted) throw error; throw new Error('发送失败，请检查本地调参服务后重试。'); }
  if (!response.ok) throw await apiError(response);
  const result = await response.json() as TunerImportResult;
  const editor = new URL(localTunerUrl(result.editorUrl || result.url));
  if (result.project) editor.searchParams.set('project', result.project);
  if (result.profile) editor.searchParams.set('profile', result.profile);
  if (result.animation) editor.searchParams.set('group', result.animation);
  result.editorUrl = editor.href;
  return result;
}
