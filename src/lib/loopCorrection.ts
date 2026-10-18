import type { Frame } from '../types';

export type LoopCorrectionMode = 'match' | 'blend';
export interface LoopCorrectionSettings { mode: LoopCorrectionMode; transitionFrames: number }
export interface LoopPixels { width: number; height: number; data: Uint8ClampedArray }
export interface LoopImage extends LoopPixels { blob: Blob }
export interface LoopDifference {
  sameDimensions: boolean;
  identical: boolean;
  changedPixels: number;
  totalPixels: number;
  differencePercent: number;
}
export interface LoopCorrectionResult {
  frames: Frame[];
  ownedUrls: string[];
  changedCount: number;
  originalDifference: LoopDifference;
  finalDifference: LoopDifference;
}
export interface LoopCorrectionIO {
  read: (frame: Frame, signal?: AbortSignal) => Promise<LoopImage>;
  encode: (pixels: LoopPixels, signal?: AbortSignal) => Promise<Blob>;
  createUrl: (blob: Blob) => string;
  revokeUrl: (url: string) => void;
}
interface Options {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  io?: LoopCorrectionIO;
}

export const defaultLoopCorrectionSettings: LoopCorrectionSettings = { mode: 'match', transitionFrames: 4 };
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('首尾修正已取消', 'AbortError');
}

function validatePixels(pixels: LoopPixels): void {
  if (!Number.isInteger(pixels.width) || !Number.isInteger(pixels.height) || pixels.width < 1 || pixels.height < 1 || pixels.width * pixels.height > 16_000_000 || pixels.data.length !== pixels.width * pixels.height * 4) {
    throw new Error('帧尺寸无效或过大，请先将单帧缩小到 1600 万像素以内。');
  }
}

/** The key follows the displayed order, including edited frame content and metadata. */
export function loopFrameSignature(frames: Frame[]): string {
  return JSON.stringify(frames.map(({ id, url, width, height, sourceIndex, time, name, selected }) => [id, url, width, height, sourceIndex, time, name, selected]));
}

/** Compare visible premultiplied color and alpha; invisible RGB does not create false differences. */
export function compareLoopPixels(first: LoopPixels, last: LoopPixels): LoopDifference {
  validatePixels(first); validatePixels(last);
  const totalPixels = first.width * first.height;
  if (first.width !== last.width || first.height !== last.height) return { sameDimensions: false, identical: false, changedPixels: totalPixels, totalPixels, differencePercent: 100 };
  let changedPixels = 0;
  let difference = 0;
  for (let index = 0; index < first.data.length; index += 4) {
    const a = first.data[index + 3] / 255;
    const b = last.data[index + 3] / 255;
    let pixelDifference = Math.abs(first.data[index + 3] - last.data[index + 3]);
    for (let channel = 0; channel < 3; channel++) pixelDifference += Math.abs(first.data[index + channel] * a - last.data[index + channel] * b);
    if (pixelDifference > 0.000001) changedPixels++;
    difference += pixelDifference;
  }
  return { sameDimensions: true, identical: changedPixels === 0, changedPixels, totalPixels, differencePercent: difference / (totalPixels * 4 * 255) * 100 };
}

/** Crossfade in premultiplied alpha, preventing invisible source RGB from darkening edges. */
export function blendLoopPixels(source: LoopPixels, first: LoopPixels, amount: number): LoopPixels {
  validatePixels(source); validatePixels(first);
  if (source.width !== first.width || source.height !== first.height) throw new Error('平滑过渡要求参与帧尺寸一致，请使用“末帧匹配首帧”或先统一画布尺寸。');
  const weight = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : 0));
  if (weight === 0) return { ...source, data: new Uint8ClampedArray(source.data) };
  if (weight === 1) return { ...first, data: new Uint8ClampedArray(first.data) };
  const data = new Uint8ClampedArray(source.data.length);
  for (let index = 0; index < data.length; index += 4) {
    const sourceAlpha = source.data[index + 3] / 255;
    const firstAlpha = first.data[index + 3] / 255;
    const alpha = sourceAlpha * (1 - weight) + firstAlpha * weight;
    data[index + 3] = Math.round(alpha * 255);
    for (let channel = 0; channel < 3; channel++) {
      data[index + channel] = alpha > 0 ? Math.round((source.data[index + channel] * sourceAlpha * (1 - weight) + first.data[index + channel] * firstAlpha * weight) / alpha) : 0;
    }
  }
  return { width: first.width, height: first.height, data };
}

function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  if (width < 1 || height < 1 || width * height > 16_000_000) throw new Error('单帧过大，请先缩小到 1600 万像素以内。');
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法读取像素，请使用支持 Canvas 的浏览器。');
  return [canvas, context];
}

const browserIO: LoopCorrectionIO = {
  async read(frame, signal) {
    checkAbort(signal);
    const response = await fetch(frame.url, { signal });
    if (!response.ok) throw new Error(`无法读取动画帧：${frame.name}`);
    const blob = await response.blob(); checkAbort(signal);
    const bitmap = await createImageBitmap(blob);
    try {
      checkAbort(signal);
      const [, context] = makeCanvas(bitmap.width, bitmap.height);
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
      return { blob, width: bitmap.width, height: bitmap.height, data: pixels.data };
    } finally { bitmap.close(); }
  },
  async encode(pixels, signal) {
    checkAbort(signal); validatePixels(pixels);
    const [canvas, context] = makeCanvas(pixels.width, pixels.height);
    const data = new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
    context.putImageData(data, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('浏览器无法生成 PNG 帧。')), 'image/png'));
    checkAbort(signal); return blob;
  },
  createUrl: blob => URL.createObjectURL(blob),
  revokeUrl: url => URL.revokeObjectURL(url),
};

/** Releases generated URLs only. References borrowed from parent frames are never owned here. */
export function releaseLoopCorrection(result: Pick<LoopCorrectionResult, 'ownedUrls'> | null, revoke: (url: string) => void = browserIO.revokeUrl): void {
  if (result) new Set(result.ownedUrls).forEach(revoke);
}

export async function correctLoopFrames(input: Frame[], settings: LoopCorrectionSettings = defaultLoopCorrectionSettings, options: Options = {}): Promise<LoopCorrectionResult> {
  const { signal, onProgress, io = browserIO } = options;
  const frames = input.map(frame => ({ ...frame }));
  if (frames.length < 2) throw new Error('至少选择 2 帧后才能修正首尾帧。');
  if (frames.length > 400) throw new Error('一次最多修正 400 帧。');
  if (settings.mode !== 'match' && settings.mode !== 'blend') throw new Error('请选择有效的首尾修正方式。');
  const ownedUrls: string[] = [];
  const create = (blob: Blob) => { checkAbort(signal); const url = io.createUrl(blob); ownedUrls.push(url); return url; };
  try {
    checkAbort(signal);
    const first = await io.read(frames[0], signal); checkAbort(signal); validatePixels(first);
    const lastIndex = frames.length - 1;
    const last = await io.read(frames[lastIndex], signal); checkAbort(signal); validatePixels(last);
    const originalDifference = compareLoopPixels(first, last);
    // Keep true PNG bytes unchanged. Other image formats are encoded once, then shared by both endpoints.
    const header = new Uint8Array(await first.blob.slice(0, 8).arrayBuffer()); checkAbort(signal);
    const isPng = pngSignature.every((byte, index) => header[index] === byte);
    const firstPng = isPng ? new Blob([first.blob], { type: 'image/png' }) : await io.encode(first, signal);
    checkAbort(signal);
    frames[0] = { ...frames[0], url: isPng ? frames[0].url : create(firstPng), width: first.width, height: first.height };
    const transitionFrames = settings.mode === 'blend' ? Math.max(1, Math.min(lastIndex, Math.round(settings.transitionFrames) || 1)) : 1;
    const startIndex = frames.length - transitionFrames;
    onProgress?.(0, transitionFrames);
    for (let index = startIndex; index < lastIndex; index++) {
      checkAbort(signal);
      const source = await io.read(frames[index], signal); checkAbort(signal);
      const pixels = blendLoopPixels(source, first, (index - startIndex + 1) / transitionFrames);
      const blob = await io.encode(pixels, signal); checkAbort(signal);
      frames[index] = { ...frames[index], url: create(blob), width: first.width, height: first.height };
      onProgress?.(index - startIndex + 1, transitionFrames);
    }
    // An exact first-frame PNG copy is deliberate: blending alone cannot guarantee matching final pixels.
    frames[lastIndex] = { ...frames[lastIndex], url: create(firstPng), width: first.width, height: first.height };
    checkAbort(signal); onProgress?.(transitionFrames, transitionFrames); checkAbort(signal);
    return { frames, ownedUrls, changedCount: transitionFrames + (isPng ? 0 : 1), originalDifference, finalDifference: compareLoopPixels(first, first) };
  } catch (error) { releaseLoopCorrection({ ownedUrls }, io.revokeUrl); throw error; }
}
