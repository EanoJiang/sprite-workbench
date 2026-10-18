import type { Frame, ProcessOptions } from '../types';
import { processFrame } from './ai';
import { canvasToBlob } from './media';
import { loopFrameSignature } from './loopCorrection';

export const SMOOTHING_PIPELINE_VERSION = 2;

export interface SmoothingStatus {
  ready: boolean;
  available?: boolean;
  model?: string;
  implementation?: string;
  scale?: number;
  busy?: boolean;
  message?: string;
  error?: string;
}
export interface SmoothingResult { frames: Frame[]; ownedUrls: string[] }
export interface SmoothingIO {
  read: (frame: Frame, signal?: AbortSignal) => Promise<Blob>;
  enhance: (blob: Blob, name: string, signal?: AbortSignal) => Promise<Blob>;
  matte: (enhanced: Blob, original: Blob, options: ProcessOptions, signal?: AbortSignal) => Promise<{ blob: Blob; width: number; height: number }>;
  createUrl: (blob: Blob) => string;
  revokeUrl: (url: string) => void;
}
interface SmoothingRunOptions { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; io?: SmoothingIO }

const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('平滑处理已取消', 'AbortError'); };
export const smoothingFrameSignature = loopFrameSignature;
export function smoothingSettingsKey(options: ProcessOptions): string {
  return JSON.stringify(Object.entries(options).sort(([a], [b]) => a.localeCompare(b)));
}
async function request(url: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try { response = await fetch(url, init); }
  catch (reason) {
    if (init?.signal?.aborted) throw reason;
    throw new Error('无法连接本地平滑服务，请运行 start.ps1 后重试。');
  }
  if (!response.ok) {
    let message = `平滑服务返回错误 (${response.status})。`;
    try { const body = await response.json(); if (typeof body.detail === 'string') message = body.detail; } catch { /* Retain the status. */ }
    throw new Error(message);
  }
  return response;
}
export async function getSmoothingStatus(signal?: AbortSignal): Promise<SmoothingStatus> {
  return (await request('/api/smoothing/status', { signal })).json();
}
export async function prepareSmoothing(signal?: AbortSignal): Promise<SmoothingStatus> {
  return (await request('/api/smoothing/prepare', { method: 'POST', signal })).json();
}
export async function enhanceSmoothingFrame(blob: Blob, name: string, signal?: AbortSignal): Promise<Blob> {
  checkAbort(signal);
  const form = new FormData(); form.set('image', blob, name.split(/[\\/]/).at(-1) || 'frame.png');
  const response = await request('/api/smoothing/frame', { method: 'POST', body: form, signal });
  const output = await response.blob(); checkAbort(signal);
  if (!output.size) throw new Error('平滑服务未返回有效的 PNG。');
  return output;
}

/** Matte processing may remove more alpha, but cannot regrow previously clear pixels. */
export function limitSmoothingAlpha(output: Uint8ClampedArray, original: Uint8ClampedArray): void {
  if (output.length !== original.length || output.length % 4) throw new Error('平滑前后像素尺寸不一致。');
  for (let index = 0; index < output.length; index += 4) {
    output[index + 3] = Math.min(output[index + 3], original[index + 3]);
    if (output[index + 3] === 0) output[index] = output[index + 1] = output[index + 2] = 0;
  }
}
function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element = document.createElement('canvas'); element.width = width; element.height = height;
  const context = element.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法创建平滑处理画布。');
  return [element, context];
}
async function matteSmoothingFrame(enhanced: Blob, original: Blob, options: ProcessOptions, signal?: AbortSignal): Promise<{ blob: Blob; width: number; height: number }> {
  checkAbort(signal);
  const originalBitmap = await createImageBitmap(original);
  try {
    const enhancedBitmap = await createImageBitmap(enhanced);
    try {
      checkAbort(signal);
      const { width, height } = originalBitmap;
      if (width !== enhancedBitmap.width || height !== enhancedBitmap.height) throw new Error('平滑结果尺寸异常，请检查本地平滑服务。');
      const [originalCanvas, originalContext] = canvas(width, height);
      originalContext.drawImage(originalBitmap, 0, 0);
      const originalPixels = originalContext.getImageData(0, 0, width, height);
      // These frames already have a matte. The backend preserves that exact
      // alpha, so re-keying/eroding here would damage translucent edges twice.
      if (originalPixels.data.some((value, index) => index % 4 === 3 && value < 255)) {
        checkAbort(signal);
        return { blob: enhanced, width, height };
      }
      const [enhancedCanvas, enhancedContext] = canvas(width, height);
      enhancedContext.drawImage(enhancedBitmap, 0, 0);
      // Opaque inputs still need the current matte, without another layout pass.
      const processed = await processFrame(enhancedCanvas, { ...options, targetHeight: height, padding: 0, layout: 'original' }, signal);
      checkAbort(signal);
      const [output, outputContext] = canvas(originalCanvas.width, originalCanvas.height);
      outputContext.drawImage(processed, 0, 0, width, height);
      const outputPixels = outputContext.getImageData(0, 0, width, height);
      limitSmoothingAlpha(outputPixels.data, originalPixels.data);
      outputContext.putImageData(outputPixels, 0, 0);
      const blob = await canvasToBlob(output); checkAbort(signal);
      return { blob, width, height };
    } finally { enhancedBitmap.close(); }
  } finally { originalBitmap.close(); }
}
const browserIO: SmoothingIO = {
  async read(frame, signal) {
    checkAbort(signal);
    const response = await fetch(frame.url, { signal });
    if (!response.ok) throw new Error(`无法读取动画帧：${frame.name}`);
    const blob = await response.blob(); checkAbort(signal); return blob;
  },
  enhance: enhanceSmoothingFrame,
  matte: matteSmoothingFrame,
  createUrl: blob => URL.createObjectURL(blob),
  revokeUrl: url => URL.revokeObjectURL(url),
};

export function releaseSmoothing(result: Pick<SmoothingResult, 'ownedUrls'> | null, revoke: (url: string) => void = browserIO.revokeUrl): void {
  if (result) new Set(result.ownedUrls).forEach(url => revoke(url));
}
export async function smoothFrames(input: Frame[], settings: ProcessOptions, run: SmoothingRunOptions = {}): Promise<SmoothingResult> {
  const { io = browserIO, signal, onProgress } = run;
  checkAbort(signal);
  if (!input.length || input.length > 400) throw new Error('请选择 1 到 400 帧后再进行平滑处理。');
  const frames = input.map(frame => ({ ...frame }));
  if (frames.some(frame => frame.width < 1 || frame.height < 1 || frame.width > 8192 || frame.height > 8192) || frames.reduce((sum, frame) => sum + frame.width * frame.height, 0) > 120_000_000) throw new Error('这组帧尺寸过大，请减少帧数或降低画布尺寸。');
  const options = structuredClone(settings);
  const ownedUrls: string[] = [];
  try {
    onProgress?.(0, frames.length);
    for (const [index, frame] of frames.entries()) {
      checkAbort(signal);
      const original = await io.read(frame, signal); checkAbort(signal);
      const enhanced = await io.enhance(original, frame.name, signal); checkAbort(signal);
      const result = await io.matte(enhanced, original, options, signal); checkAbort(signal);
      if (result.width !== frame.width || result.height !== frame.height) throw new Error(`「${frame.name}」平滑后的画布尺寸与原帧不同。`);
      const url = io.createUrl(result.blob); ownedUrls.push(url);
      frames[index] = { ...frame, url, width: result.width, height: result.height };
      onProgress?.(index + 1, frames.length);
    }
    checkAbort(signal); return { frames, ownedUrls };
  } catch (reason) { releaseSmoothing({ ownedUrls }, io.revokeUrl); throw reason; }
}
