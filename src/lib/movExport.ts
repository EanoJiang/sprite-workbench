import JSZip from 'jszip';
import type { FrameCanvasAnchor } from '../types';
import type { CompressionExportFrame } from './compressionExport';
import { downloadBlob, safeName } from './export';

export interface MovExportFrame extends CompressionExportFrame { anchor?: FrameCanvasAnchor }
const MAX_FRAMES = 400;
const MAX_ARCHIVE = 256 * 1024 * 1024;
const MAX_UNPACKED = 512 * 1024 * 1024;
const MAX_FRAME = 64 * 1024 * 1024;
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError'); };

export function validateMovFrames(frames: readonly MovExportFrame[], fps: number): void {
  if (!frames.length || frames.length > MAX_FRAMES) throw new Error('透明 MOV 需要 1 到 400 帧。');
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error('播放帧率需要在 1–120 FPS 之间。');
  if (frames.some(frame => !Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.width > 8192 || frame.height > 8192)) throw new Error('透明 MOV 的单帧尺寸无效或超过 8192 像素。');
  const canvasPixels = Math.max(...frames.map(frame => frame.width)) * Math.max(...frames.map(frame => frame.height));
  if (canvasPixels > 32_000_000 || canvasPixels * frames.length > 120_000_000) throw new Error('透明 MOV 画布或总像素过大，请降低尺寸或减少帧数。');
}

/** Pass PNG bytes through unchanged; convert other imported formats once. */
export async function readExportPng(frame: CompressionExportFrame, signal?: AbortSignal): Promise<Blob> {
  checkAbort(signal);
  let blob = frame.blob;
  if (!blob) {
    if (!frame.url) throw new Error(`「${frame.name}」没有可导出的图片。`);
    const response = await fetch(frame.url, { signal });
    if (!response.ok) throw new Error(`无法读取「${frame.name}」，请重新导入后重试。`);
    blob = await response.blob();
  }
  checkAbort(signal);
  const header = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
  const png = header.length === 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte) && String.fromCharCode(...header.subarray(12, 16)) === 'IHDR';
  if (png) {
    const dimensions = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (dimensions.getUint32(16) !== frame.width || dimensions.getUint32(20) !== frame.height) throw new Error(`「${frame.name}」的 PNG 尺寸与帧信息不一致。`);
    checkAbort(signal); return blob;
  }
  const bitmap = await createImageBitmap(blob);
  try {
    checkAbort(signal);
    if (bitmap.width !== frame.width || bitmap.height !== frame.height) throw new Error(`「${frame.name}」的图片尺寸与帧信息不一致。`);
    const canvas = document.createElement('canvas'); canvas.width = frame.width; canvas.height = frame.height;
    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器无法创建导出画布。');
      context.drawImage(bitmap, 0, 0);
      const result = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('无法将导入帧编码为 PNG。')), 'image/png'));
      checkAbort(signal); return result;
    } finally { canvas.width = 0; canvas.height = 0; }
  } finally { bitmap.close(); }
}

export async function buildMovArchive(frames: readonly MovExportFrame[], name: string, fps: number, signal?: AbortSignal): Promise<Blob> {
  checkAbort(signal); validateMovFrames(frames, fps);
  const snapshot = frames.map(frame => ({ ...frame }));
  const zip = new JSZip();
  const entries: { filename: string; width: number; height: number; anchor?: FrameCanvasAnchor }[] = [];
  let total = 0;
  for (const [index, frame] of snapshot.entries()) {
    const png = await readExportPng(frame, signal); checkAbort(signal);
    if (png.size > MAX_FRAME) throw new Error(`「${frame.name}」超过透明 MOV 的单帧 64 MB 限制。`);
    total += png.size;
    if (total > MAX_UNPACKED - 2 * 1024 * 1024) throw new Error('透明 MOV 素材超过 512 MB，请减少帧数或降低尺寸。');
    const filename = `frame_${String(index + 1).padStart(3, '0')}.png`;
    zip.file(filename, await png.arrayBuffer());
    entries.push({ filename, width: frame.width, height: frame.height, ...(frame.anchor ? { anchor: frame.anchor } : {}) });
  }
  zip.file('manifest.json', JSON.stringify({ format: 'framecraft-mov-v1', name: safeName(name), fps, frames: entries }));
  const archive = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } });
  checkAbort(signal);
  if (archive.size > MAX_ARCHIVE) throw new Error('透明 MOV 素材压缩包超过 256 MB，请减少帧数或降低尺寸。');
  return archive;
}

export async function exportMov(frames: readonly MovExportFrame[], name: string, fps: number, signal?: AbortSignal): Promise<void> {
  const archive = await buildMovArchive(frames, name, fps, signal); checkAbort(signal);
  const form = new FormData(); form.set('archive', archive, `${safeName(name)}.zip`);
  let response: Response;
  try { response = await fetch('/api/exports/mov', { method: 'POST', body: form, signal }); }
  catch (reason) { if (signal?.aborted) throw reason; throw new Error('无法连接本地 MOV 导出服务，请运行 start.ps1 后重试。'); }
  if (!response.ok) {
    let message = `透明 MOV 导出失败 (${response.status})。`;
    try { const data = await response.json(); if (typeof data.detail === 'string') message = data.detail; } catch { /* Retain status. */ }
    throw new Error(message);
  }
  const movie = await response.blob(); checkAbort(signal);
  if (!movie.size) throw new Error('本地服务未返回有效的 MOV 文件。');
  downloadBlob(movie, `${safeName(name)}.mov`);
}
