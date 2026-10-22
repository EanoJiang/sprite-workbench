import type { Frame } from '../types';

export type CompressionAlgorithm = 'lanczos' | 'palette' | 'nearest';
export type CompressionResizeMode = 'hard' | 'soft';
export interface CompressionSettings { scale: number; algorithm: CompressionAlgorithm; resizeMode?: CompressionResizeMode; alphaThreshold: number; sharpen: number; colors: number; }
export interface CompressionSourceFrame { id: string; name: string; sourceIndex: number; time: number; url: string; blob: Blob; width: number; height: number; }
export interface CompressedFrame { id: string; name: string; sourceIndex: number; time: number; url: string; blob: Blob; width: number; height: number; }
export const defaultCompressionSettings: CompressionSettings = { scale: .5, algorithm: 'lanczos', resizeMode: 'soft', alphaThreshold: 8, sharpen: 80, colors: 128 };
const MAX_FRAMES = 400;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PIXELS = 120_000_000;
const acceptedImage = /\.(png|jpe?g|webp|bmp|avif)$/i;

function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError'); }

export function releaseCompressionFrames(frames: { url: string }[]): void { frames.forEach(frame => URL.revokeObjectURL(frame.url)); }

/** Saved snapshots must match pixels as well as metadata before reusing their results. */
export async function compressionSourcesMatch(current: CompressionSourceFrame[], saved: CompressionSourceFrame[], signal?: AbortSignal): Promise<boolean> {
  aborted(signal);
  if (current.length !== saved.length) return false;
  for (const [index, frame] of current.entries()) {
    const previous = saved[index];
    if (frame.name !== previous.name || frame.sourceIndex !== previous.sourceIndex || frame.time !== previous.time || frame.width !== previous.width || frame.height !== previous.height || frame.blob.size !== previous.blob.size) return false;
    const [a, b] = await Promise.all([frame.blob.arrayBuffer(), previous.blob.arrayBuffer()]);
    aborted(signal);
    const bytes = new Uint8Array(a); const savedBytes = new Uint8Array(b);
    if (bytes.some((value, offset) => value !== savedBytes[offset])) return false;
  }
  return true;
}

async function sourceFrame(blob: Blob, name: string, sourceIndex: number, time: number, signal?: AbortSignal): Promise<CompressionSourceFrame> {
  aborted(signal);
  if (blob.size > MAX_FILE_BYTES) throw new Error(`「${name}」超过 16 MB，请先缩小图片。`);
  const image = await createImageBitmap(blob);
  try {
    aborted(signal);
    if (image.width > 8192 || image.height > 8192 || image.width * image.height > 32_000_000) throw new Error(`「${name}」画布过大，请先缩小到 8192 像素以内。`);
    return { id: `compression-source-${crypto.randomUUID()}`, name, sourceIndex, time, width: image.width, height: image.height, url: URL.createObjectURL(blob), blob };
  } finally { image.close(); }
}

function validateCount(count: number): void {
  if (!count) throw new Error('请选择 PNG、JPG、WebP、BMP 或 AVIF 动画帧。');
  if (count > MAX_FRAMES) throw new Error(`单次最多导入 ${MAX_FRAMES} 帧，请分批选择。`);
}

export async function importCompressionFiles(files: FileList | File[], fps: number, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<CompressionSourceFrame[]> {
  const images = Array.from(files).filter(file => acceptedImage.test(file.name)).sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true }));
  validateCount(images.length);
  const result: CompressionSourceFrame[] = []; let pixels = 0;
  try {
    for (const [index, file] of images.entries()) {
      const frame = await sourceFrame(file, file.webkitRelativePath || file.name, index + 1, index / fps, signal); result.push(frame);
      pixels += frame.width * frame.height;
      if (pixels > MAX_PIXELS) throw new Error('这组帧超过 1.2 亿像素，请减少帧数或降低图片尺寸。');
      onProgress?.(index + 1, images.length);
    }
    return result;
  } catch (error) { releaseCompressionFrames(result); throw error; }
}

export async function snapshotCompressionFrames(frames: Frame[], onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<CompressionSourceFrame[]> {
  const snapshot = [...frames]; validateCount(snapshot.length);
  const result: CompressionSourceFrame[] = []; let pixels = 0;
  try {
    for (const [index, item] of snapshot.entries()) {
      aborted(signal);
      const response = await fetch(item.url, { signal });
      if (!response.ok) throw new Error(`无法读取「${item.name}」，请重新导入或生成这组帧。`);
      const frame = await sourceFrame(await response.blob(), item.name, item.sourceIndex, item.time, signal); result.push(frame);
      pixels += frame.width * frame.height;
      if (pixels > MAX_PIXELS) throw new Error('这组帧超过 1.2 亿像素，请减少帧数或降低图片尺寸。');
      onProgress?.(index + 1, snapshot.length);
    }
    return result;
  } catch (error) { releaseCompressionFrames(result); throw error; }
}

export async function compressFrame(source: CompressionSourceFrame, settings: CompressionSettings, signal?: AbortSignal): Promise<CompressedFrame> {
  aborted(signal);
  const form = new FormData(); form.set('image', source.blob, source.name.split(/[\\/]/).at(-1) || 'frame.png');
  form.set('scale', String(settings.scale)); form.set('algorithm', settings.algorithm); form.set('alpha_threshold', String(settings.alphaThreshold)); form.set('sharpen', String(settings.sharpen)); form.set('colors', String(settings.colors));
  form.set('resize_mode', compressionResizeMode(settings));
  let response: Response;
  try { response = await fetch('/api/compression/frame', { method: 'POST', body: form, signal }); }
  catch (error) { if (signal?.aborted) throw error; throw new Error('无法连接本地压缩服务，请运行 start.ps1 后重试。'); }
  if (!response.ok) {
    let message = `压缩服务返回错误 (${response.status})。`;
    try { const data = await response.json(); if (typeof data.detail === 'string') message = data.detail; } catch { /* Keep the HTTP error. */ }
    throw new Error(message);
  }
  const blob = await response.blob(); aborted(signal);
  const image = await createImageBitmap(blob);
  try {
    aborted(signal);
    return { id: `compressed-${crypto.randomUUID()}`, name: source.name, sourceIndex: source.sourceIndex, time: source.time, width: image.width, height: image.height, blob, url: URL.createObjectURL(blob) };
  } finally { image.close(); }
}

export function compressionSettingsKey(settings: CompressionSettings): string {
  return JSON.stringify({ scale: settings.scale, algorithm: settings.algorithm === 'palette' ? 'palette' : 'rgba', resizeMode: compressionResizeMode(settings), alphaThreshold: settings.alphaThreshold, sharpen: settings.sharpen, colors: settings.algorithm === 'palette' ? settings.colors : 0 });
}

/** Older projects selected nearest through the algorithm field. */
export function compressionResizeMode(settings: CompressionSettings): CompressionResizeMode {
  return settings.resizeMode ?? (settings.algorithm === 'nearest' ? 'hard' : 'soft');
}

export function formatCompressionBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
