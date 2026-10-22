import type { Frame, MediaSource, ProcessOptions } from '../types';

type Asset = HTMLImageElement | HTMLVideoElement;
const assets = new Map<string, Asset>();
const captures = new Map<string, Promise<void>>();
const MAX_FRAMES = 400;
const MAX_PIXELS = 120_000_000;
const MAX_CANVAS_PIXELS = 16_000_000;

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('处理已取消', 'AbortError');
}

function bounded(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('浏览器无法创建画布，请使用支持 Canvas 的浏览器。');
  return ctx;
}

function canvas(width: number, height: number): HTMLCanvasElement {
  if (width > 16384 || height > 16384 || width * height > 64_000_000) {
    throw new Error('原始画面尺寸过大，请先缩小到 8000 像素以内再导入。');
  }
  const result = document.createElement('canvas');
  result.width = Math.max(1, Math.round(width));
  result.height = Math.max(1, Math.round(height));
  return result;
}

function mediaError(asset: Asset): Error {
  const detail = asset instanceof HTMLVideoElement ? asset.error?.message : '';
  return new Error(`无法读取素材，请检查格式或改用 PNG、JPG、WebP、MP4、WebM。${detail ? `（${detail}）` : ''}`);
}

function waitEvent(asset: Asset, event: string, signal?: AbortSignal, timeout = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const clear = () => {
      clearTimeout(timer);
      asset.removeEventListener(event, success);
      asset.removeEventListener('error', failure);
      signal?.removeEventListener('abort', cancel);
    };
    const success = () => { clear(); resolve(); };
    const failure = () => { clear(); reject(mediaError(asset)); };
    const cancel = () => { clear(); reject(new DOMException('处理已取消', 'AbortError')); };
    asset.addEventListener(event, success, { once: true });
    asset.addEventListener('error', failure, { once: true });
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => {
      clear();
      reject(new Error('读取素材超时。请重试，或转换为常见的 MP4 / PNG 格式。'));
    }, timeout);
    if (signal?.aborted) cancel();
  });
}

async function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = 'async';
  const loaded = waitEvent(image, 'load', signal);
  image.src = url;
  await loaded;
  if (!image.naturalWidth || !image.naturalHeight) throw mediaError(image);
  return image;
}

async function loadVideo(url: string, signal?: AbortSignal): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  const loaded = waitEvent(video, 'loadedmetadata', signal);
  video.src = url;
  video.load();
  try {
    await loaded;
    if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error('视频没有可用的时长或画面信息，请转换为 MP4 或 WebM 后重试。');
    }
    return video;
  } catch (error) {
    video.removeAttribute('src');
    video.load();
    throw error;
  }
}

/** The returned URL belongs to the caller; releaseMedia detaches decoded elements. */
export async function loadMedia(file: File, fps = 30): Promise<MediaSource> {
  const image = file.type.startsWith('image/') || /\.(png|jpe?g|webp|avif|bmp|gif)$/i.test(file.name);
  const video = file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(file.name);
  if (!image && !video) throw new Error('请选择视频或图片文件（MP4、WebM、PNG、JPG、WebP）。');
  const url = URL.createObjectURL(file);
  const rate = bounded(fps, 1, 120);
  try {
    if (image) {
      const asset = await loadImage(url);
      assets.set(url, asset);
      return { kind: 'image', name: file.name, url, width: asset.naturalWidth, height: asset.naturalHeight, fps: rate, duration: 1 / rate, totalFrames: 1 };
    }
    const asset = await loadVideo(url);
    assets.set(url, asset);
    return { kind: 'video', name: file.name, url, width: asset.videoWidth, height: asset.videoHeight, fps: rate, duration: asset.duration, totalFrames: Math.max(1, Math.floor(asset.duration * rate)) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** A screenshot with synthesized motion, deliberately labelled as a demonstration. */
export async function createDemoSource(): Promise<MediaSource> {
  const url = new URL('demo-reference.png', document.baseURI).href;
  const asset = await loadImage(url);
  assets.set(url, asset);
  return { kind: 'demo', name: '示例角色 · 合成摆动演示', url, width: 477, height: 475, fps: 24, duration: 5, totalFrames: 120 };
}

export function releaseMedia(source: MediaSource): void {
  const asset = assets.get(source.url);
  if (asset instanceof HTMLVideoElement) {
    asset.pause();
    asset.removeAttribute('src');
    asset.load();
  }
  assets.delete(source.url);
  captures.delete(source.url);
}

async function getAsset(source: MediaSource, signal?: AbortSignal): Promise<Asset> {
  const cached = assets.get(source.url);
  if (cached) return cached;
  const asset = source.kind === 'video' ? await loadVideo(source.url, signal) : await loadImage(source.url, signal);
  assets.set(source.url, asset);
  return asset;
}

async function drawFrame(source: MediaSource, frameIndex: number, signal?: AbortSignal): Promise<HTMLCanvasElement> {
  aborted(signal);
  const asset = await getAsset(source, signal);
  aborted(signal);
  const frame = bounded(Math.round(frameIndex), 1, source.totalFrames);
  if (asset instanceof HTMLVideoElement) {
    const time = Math.min((frame - 1) / source.fps, Math.max(0, source.duration - 0.001));
    if (Math.abs(asset.currentTime - time) > 0.00001 || asset.seeking) {
      const seeked = waitEvent(asset, 'seeked', signal, 15_000);
      asset.currentTime = time;
      await seeked;
    }
    if (asset.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await waitEvent(asset, 'loadeddata', signal);
  }
  aborted(signal);
  const output = canvas(source.width, source.height);
  const ctx = context(output);
  if (source.kind === 'demo') {
    // Keep the green screenshot crop full-bleed, then gently sway around the feet.
    ctx.drawImage(asset, 125, 100, 477, 475, 0, 0, 477, 475);
    const phase = (frame - 1) / source.fps * Math.PI * 2 / 2;
    ctx.save();
    ctx.translate(238.5, 435);
    ctx.rotate(Math.sin(phase) * 0.008);
    ctx.translate(-238.5 + Math.sin(phase) * 1.5, -435);
    ctx.drawImage(asset, 125, 100, 477, 475, 0, 0, 477, 475);
    ctx.restore();
  } else {
    ctx.drawImage(asset, 0, 0, output.width, output.height);
  }
  return output;
}

/** Serialize seeks to the same video, including when callers clone a source to edit FPS. */
export async function captureFrame(source: MediaSource, frameIndex: number, signal?: AbortSignal): Promise<HTMLCanvasElement> {
  const previous = captures.get(source.url) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(() => drawFrame(source, frameIndex, signal));
  const settled = operation.then(() => {}, () => {});
  captures.set(source.url, settled);
  try { return await operation; }
  finally { if (captures.get(source.url) === settled) captures.delete(source.url); }
}

type KeyOptions = Pick<ProcessOptions, 'removeBackground' | 'keyColor' | 'tolerance' | 'softness' | 'spill' | 'cleanup'>;

function color(hex: string): [number, number, number] {
  let value = hex.replace('#', '');
  if (/^[\da-f]{3}$/i.test(value)) value = [...value].map((char) => char + char).join('');
  if (!/^[\da-f]{6}$/i.test(value)) throw new Error('抠图颜色无效，请选择有效的背景色。');
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

/** Pure in-place chroma matte, preserving input alpha and low-saturation dark clothing. */
export function chromaKeyPixels(pixels: Uint8ClampedArray, options: KeyOptions): Uint8ClampedArray {
  if (pixels.length % 4) throw new Error('RGBA 像素数据长度必须是 4 的倍数。');
  if (!options.removeBackground) return pixels;
  const key = color(options.keyColor);
  const dominant = key.indexOf(Math.max(...key));
  const other = [0, 1, 2].filter((channel) => channel !== dominant);
  const keyDominance = key[dominant] - Math.max(key[other[0]], key[other[1]]);
  const isChromatic = Math.max(...key) - Math.min(...key) > 24;
  const threshold = bounded(options.tolerance, 0, 100) * 1.65;
  const softness = bounded(options.softness, 0, 100) * 1.5;
  const spill = bounded(options.spill, 0, 100) / 100;
  for (let i = 0; i < pixels.length; i += 4) {
    const oldAlpha = pixels[i + 3];
    if (!oldAlpha) continue;
    const dr = pixels[i] - key[0];
    const dg = pixels[i + 1] - key[1];
    const db = pixels[i + 2] - key[2];
    const mean = isChromatic ? (dr + dg + db) / 3 : 0;
    const distance = Math.hypot(dr - mean, dg - mean, db - mean);
    let matte = distance <= threshold ? 0 : softness ? bounded((distance - threshold) / softness, 0, 1) : 1;
    // Grey/black/white details share no green-screen chroma even at high tolerances.
    if (isChromatic && keyDominance > 24 && pixels[i + dominant] <= Math.max(pixels[i + other[0]], pixels[i + other[1]]) + 8) matte = 1;
    pixels[i + 3] = oldAlpha * matte;
    if (matte > 0 && matte < 1 && spill > 0 && keyDominance > 24) {
      const neutral = Math.max(pixels[i + other[0]], pixels[i + other[1]]);
      const excess = Math.max(0, pixels[i + dominant] - neutral);
      pixels[i + dominant] -= excess * spill * (1 - matte);
    }
    if (pixels[i + 3] > 0 && pixels[i + 3] < 255) {
      if (options.cleanup === 'dark') pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
      if (options.cleanup === 'opaque') pixels[i + 3] = 255;
    }
  }
  return pixels;
}

type LumaOptions = Pick<ProcessOptions, 'removeBackground' | 'keyColor' | 'spill' | 'lumaBlack' | 'lumaWhite' | 'lumaGamma' | 'lumaStrength' | 'lumaPolarity'>;
const linearChannels = Array.from({ length: 256 }, (_, channel) => {
  const value = channel / 255;
  return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
});
function srgb(value: number): number {
  const limited = bounded(value, 0, 1);
  return Math.round((limited <= .0031308 ? limited * 12.92 : 1.055 * limited ** (1 / 2.4) - .055) * 255);
}

/** Luminance matte, following the reference's polarity, curve and key suppression. */
export function lumaKeyPixels(pixels: Uint8ClampedArray, options: LumaOptions): Uint8ClampedArray {
  if (pixels.length % 4) throw new Error('RGBA 像素数据长度必须是 4 的倍数。');
  if (!options.removeBackground) return pixels;
  const key = color(options.keyColor);
  const black = bounded(options.lumaBlack ?? 0, 0, 254);
  const white = bounded(options.lumaWhite ?? 85, black + 1, 255);
  const gamma = bounded(options.lumaGamma ?? .55, .05, 4);
  const strength = bounded(options.lumaStrength ?? 1.7, 0, 2);
  const keepDark = options.lumaPolarity === 'dark' || (options.lumaPolarity !== 'bright' && .2126 * key[0] + .7152 * key[1] + .0722 * key[2] >= 128);
  const dominant = key.indexOf(Math.max(...key));
  const other = [0, 1, 2].filter(channel => channel !== dominant);
  const coloredKey = key[dominant] - Math.max(key[other[0]], key[other[1]]) >= 24;
  const despill = bounded(options.spill, 0, 100) / 100;
  for (let index = 0; index < pixels.length; index += 4) {
    const originalAlpha = pixels[index + 3];
    if (!originalAlpha) continue;
    const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
    const luminance = Math.floor(.2126 * r + .7152 * g + .0722 * b + 1e-8);
    let normalized = bounded((luminance - black) / (white - black), 0, 1);
    if (keepDark) normalized = 1 - normalized;
    const closeness = 1 - Math.min(Math.hypot(r - key[0], g - key[1], b - key[2]) / 180, 1);
    const alpha = bounded(normalized ** gamma * strength, 0, 1) * (1 - closeness ** 2 * .95);
    pixels[index + 3] = Math.round(originalAlpha * alpha);
    if (!pixels[index + 3]) { pixels[index] = pixels[index + 1] = pixels[index + 2] = 0; continue; }
    // Recover foreground RGB in linear light, preserving the authored matte.
    if (alpha >= 254 / 255 || !despill) continue;
    const rgb = [r, g, b];
    let confidence = bounded((alpha - .035) / .16, 0, 1) * despill;
    if (coloredKey) confidence *= bounded((rgb[dominant] - Math.max(rgb[other[0]], rgb[other[1]]) + 8) / 24, 0, 1);
    const cleaned = rgb.map((channel, channelIndex) => {
      const observed = linearChannels[channel];
      const recovered = bounded((observed - (1 - alpha) * linearChannels[key[channelIndex]]) / Math.max(alpha, .055), 0, 1);
      return srgb(observed * (1 - confidence) + recovered * confidence);
    });
    if (coloredKey) {
      const spill = Math.max(0, cleaned[dominant] - Math.max(cleaned[other[0]], cleaned[other[1]]));
      cleaned[dominant] = Math.max(0, cleaned[dominant] - Math.round(spill * (1 - alpha) ** .6 * .78 * despill));
    }
    pixels[index] = cleaned[0]; pixels[index + 1] = cleaned[1]; pixels[index + 2] = cleaned[2];
  }
  return pixels;
}

type CleanupOptions = Pick<ProcessOptions, 'keyColor' | 'cleanup' | 'backgroundToBlack' | 'backgroundDesaturate' | 'semitransparentToBlack' | 'semitransparentToOpaque'>;
function hue(rgb: number[]): number {
  const maximum = Math.max(...rgb), minimum = Math.min(...rgb), chroma = maximum - minimum;
  if (!chroma) return 0;
  const value = maximum === rgb[0] ? (rgb[1] - rgb[2]) / chroma : maximum === rgb[1] ? (rgb[2] - rgb[0]) / chroma + 2 : (rgb[0] - rgb[1]) / chroma + 4;
  return ((value / 6) % 1 + 1) % 1;
}
function backgroundResidue(rgb: number[], alpha: number, key: number[]): boolean {
  if (alpha <= 0 || alpha >= 255) return false;
  const keyChroma = Math.max(...key) - Math.min(...key);
  const straight = rgb.map(channel => Math.min(255, Math.round(channel * 255 / alpha)));
  const matches = (candidate: number[]): boolean => {
    const chroma = Math.max(...candidate) - Math.min(...candidate);
    if (keyChroma >= 24) {
      if (Math.max(...candidate) < 42 || chroma < 24) return false;
      const difference = Math.abs(hue(key) - hue(candidate));
      return Math.min(difference, 1 - difference) <= .125;
    }
    return chroma <= 24 && Math.abs(Math.round(candidate.reduce((sum, value) => sum + value, 0) / 3) - Math.round(key.reduce((sum, value) => sum + value, 0) / 3)) <= 42;
  };
  if (keyChroma < 24 && (Math.max(...rgb) - Math.min(...rgb) > 24 || Math.max(...straight) - Math.min(...straight) > 24)) return false;
  return matches(rgb) || matches(straight);
}
/** Radius-two max filter of zero-alpha pixels, using two linear passes. */
function backgroundEdgeMask(pixels: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const horizontal = new Uint8Array(width * height), result = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0; x < Math.min(2, width); x++) if (!pixels[(y * width + x) * 4 + 3]) count++;
    for (let x = 0; x < width; x++) {
      if (x + 2 < width && !pixels[(y * width + x + 2) * 4 + 3]) count++;
      if (x - 3 >= 0 && !pixels[(y * width + x - 3) * 4 + 3]) count--;
      horizontal[y * width + x] = count > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(2, height); y++) count += horizontal[y * width + x];
    for (let y = 0; y < height; y++) {
      if (y + 2 < height) count += horizontal[(y + 2) * width + x];
      if (y - 3 >= 0) count -= horizontal[(y - 3) * width + x];
      result[y * width + x] = count > 0 ? 1 : 0;
    }
  }
  return result;
}

/** Independent cleanup operations run after resizing, in the reference order. */
export function postprocessPixels(pixels: Uint8ClampedArray, width: number, height: number, options: CleanupOptions): Uint8ClampedArray {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || pixels.length !== width * height * 4) throw new Error('后处理的 RGBA 尺寸不匹配。');
  const background = options.backgroundToBlack || options.backgroundDesaturate;
  const edges = background ? backgroundEdgeMask(pixels, width, height) : null;
  const key = background ? color(options.keyColor) : null;
  const semiBlack = options.semitransparentToBlack || options.cleanup === 'dark';
  const semiOpaque = options.semitransparentToOpaque || options.cleanup === 'opaque';
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (!alpha || alpha >= 255) continue;
    if (edges?.[index / 4] && key && backgroundResidue([pixels[index], pixels[index + 1], pixels[index + 2]], alpha, key)) {
      const gray = options.backgroundToBlack ? 0 : Math.round(.299 * pixels[index] + .587 * pixels[index + 1] + .114 * pixels[index + 2]);
      pixels[index] = pixels[index + 1] = pixels[index + 2] = gray;
    }
    if (semiBlack) pixels[index] = pixels[index + 1] = pixels[index + 2] = 0;
    if (semiOpaque) pixels[index + 3] = 255;
  }
  return pixels;
}

export type WatermarkCorner = 'top_left' | 'bottom_right';
const watermarkBoxes: Record<WatermarkCorner, [number, number, number, number]> = { top_left: [.04, .02, .20, .13], bottom_right: [.84, .88, 1, 1] };
function watermarkBox(corner: WatermarkCorner, width: number, height: number): number[] {
  return watermarkBoxes[corner].map((fraction, index) => Math.round(fraction * (index % 2 ? height : width)));
}
/** Detect the reference's two corner regions against each region's dominant colour. */
export function detectWatermarkCorner(pixels: Uint8ClampedArray, width: number, height: number): WatermarkCorner | null {
  if (pixels.length !== width * height * 4) throw new Error('水印检测的 RGBA 尺寸不匹配。');
  let best: WatermarkCorner | null = null, bestScore = -1;
  for (const corner of Object.keys(watermarkBoxes) as WatermarkCorner[]) {
    const [left, top, right, bottom] = watermarkBox(corner, width, height);
    const buckets = new Map<number, [number, number, number, number]>();
    let dominant: [number, number, number, number] = [0, 0, 0, 0];
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const index = (y * width + x) * 4, r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
      const bucketId = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
      const bucket = buckets.get(bucketId) ?? [0, 0, 0, 0];
      bucket[0]++; bucket[1] += r; bucket[2] += g; bucket[3] += b; buckets.set(bucketId, bucket);
    }
    for (const bucket of buckets.values()) if (bucket[0] > dominant[0]) dominant = bucket;
    if (!dominant[0]) continue;
    const background = dominant.slice(1).map(channel => Math.round(channel / dominant[0]));
    let score = 0;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const index = (y * width + x) * 4;
      if (Math.abs(pixels[index] - background[0]) + Math.abs(pixels[index + 1] - background[1]) + Math.abs(pixels[index + 2] - background[2]) >= 72) score++;
    }
    if (score > bestScore) { bestScore = score; best = corner; }
  }
  if (!best) return null;
  const [left, top, right, bottom] = watermarkBox(best, width, height);
  return bestScore >= Math.max(16, Math.round((right - left) * (bottom - top) * .01)) ? best : null;
}

export function removeWatermarkPixels(pixels: Uint8ClampedArray, width: number, height: number, corner: WatermarkCorner | null): Uint8ClampedArray {
  if (pixels.length !== width * height * 4) throw new Error('水印移除的 RGBA 尺寸不匹配。');
  if (!corner) return pixels;
  const [left, top, right, bottom] = watermarkBox(corner, width, height);
  for (let y = top; y < bottom; y++) pixels.fill(0, (y * width + left) * 4, (y * width + right) * 4);
  return pixels;
}

function erode(pixels: Uint8ClampedArray, width: number, height: number, amount: number): void {
  const radius = bounded(amount, 0, 8);
  if (!radius) return;
  let alpha = new Uint8ClampedArray(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3];
  for (let pass = 0; pass < Math.ceil(radius); pass++) {
    const next = new Uint8ClampedArray(alpha.length);
    const strength = Math.min(1, radius - pass);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let minimum = 255;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        minimum = Math.min(minimum, nx < 0 || nx >= width || ny < 0 || ny >= height ? 0 : alpha[ny * width + nx]);
      }
      const index = y * width + x;
      next[index] = alpha[index] + (minimum - alpha[index]) * strength;
    }
    alpha = next;
  }
  for (let i = 0; i < alpha.length; i++) pixels[i * 4 + 3] = alpha[i];
}

function outputSize(input: { width: number; height: number }, options: ProcessOptions): { width: number; height: number; contentWidth: number; contentHeight: number; padding: number } {
  const height = Math.round(bounded(options.targetHeight || input.height, 16, 4096));
  const padding = Math.round(bounded(options.padding, 0, (height - 2) / 2));
  const available = height - padding * 2;
  const scale = options.layout === 'square' ? available / Math.max(input.width, input.height) : available / input.height;
  const contentWidth = Math.max(1, Math.round(input.width * scale));
  const contentHeight = Math.max(1, Math.round(input.height * scale));
  const width = options.layout === 'square' ? height : contentWidth + padding * 2;
  if (width > 8192 || width * height > MAX_CANVAS_PIXELS) throw new Error('输出画布过大，请降低目标高度或使用方形画布。');
  return { width, height, contentWidth, contentHeight, padding };
}

function layoutCanvas(input: HTMLCanvasElement, options: ProcessOptions, preserveCanvas = false): HTMLCanvasElement {
  const size = preserveCanvas ? { width: input.width, height: input.height, contentWidth: input.width, contentHeight: input.height, padding: 0 } : outputSize(input, options);
  const output = canvas(size.width, size.height);
  const ctx = context(output);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const x = Math.round((size.width - size.contentWidth) / 2);
  const y = options.alignment === 'bottom' ? size.height - size.padding - size.contentHeight : Math.round((size.height - size.contentHeight) / 2);
  ctx.drawImage(input, x, y, size.contentWidth, size.contentHeight);
  if (options.backgroundToBlack || options.backgroundDesaturate || options.semitransparentToBlack || options.semitransparentToOpaque || options.cleanup !== 'none') {
    const data = ctx.getImageData(0, 0, output.width, output.height);
    postprocessPixels(data.data, output.width, output.height, options);
    ctx.putImageData(data, 0, 0);
  }
  return output;
}

function prepareMatteCanvas(input: HTMLCanvasElement, options: ProcessOptions, alreadyMatted: boolean, rawInput: HTMLCanvasElement): HTMLCanvasElement {
  const output = canvas(input.width, input.height), ctx = context(output);
  ctx.drawImage(input, 0, 0);
  const data = ctx.getImageData(0, 0, output.width, output.height);
  if (options.removeBackground) {
    if (!alreadyMatted) {
      if (options.engine === 'luma') lumaKeyPixels(data.data, options);
      else chromaKeyPixels(data.data, { ...options, cleanup: 'none' });
    }
    erode(data.data, output.width, output.height, options.erosion);
  }
  // Detect on the original frame, then erase on the matte before any padding/resize.
  if (options.watermarkRemoval) {
    const raw = context(rawInput).getImageData(0, 0, rawInput.width, rawInput.height);
    const corner = detectWatermarkCorner(raw.data, rawInput.width, rawInput.height);
    removeWatermarkPixels(data.data, output.width, output.height, corner);
  }
  ctx.putImageData(data, 0, 0);
  return output;
}

export function processCanvas(input: HTMLCanvasElement, options: ProcessOptions, preserveCanvas = false): HTMLCanvasElement {
  const matte = options.removeBackground || options.watermarkRemoval ? prepareMatteCanvas(input, options, false, input) : input;
  return layoutCanvas(matte, options, preserveCanvas);
}

/** Finish an AI matte: source-based watermark detection, then resize and cleanup. */
export function finalizeMatteCanvas(input: HTMLCanvasElement, options: ProcessOptions, rawInput = input, preserveCanvas = false): HTMLCanvasElement {
  return layoutCanvas(prepareMatteCanvas(input, options, true, rawInput), options, preserveCanvas);
}

export function canvasToBlob(input: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => input.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法编码 PNG，画布可能超出浏览器限制。')), 'image/png'));
}

export function estimateFrames(start: number, end: number, stride: number): number {
  if (![start, end, stride].every(Number.isFinite) || start < 1 || end < start || stride < 1) return 0;
  const span = Math.floor(end) - Math.ceil(start);
  const step = Math.max(1, Math.floor(stride));
  if (span < 0) return 0;
  return Math.floor(span / step) + 1;
}

export async function extractFrames(
  source: MediaSource, start: number, end: number, stride: number, options: ProcessOptions,
  onProgress: (done: number, total: number) => void, signal?: AbortSignal,
  processor?: (raw: HTMLCanvasElement, options: ProcessOptions, signal?: AbortSignal) => Promise<HTMLCanvasElement>,
): Promise<Frame[]> {
  aborted(signal);
  const first = Math.round(bounded(start, 1, source.totalFrames));
  const last = Math.round(bounded(end, 1, source.totalFrames));
  const step = Number.isFinite(stride) ? Math.max(1, Math.floor(stride)) : 0;
  const total = estimateFrames(first, last, step);
  if (!total) throw new Error('抽帧区间无效，请检查起始帧与结束帧。');
  const size = outputSize(source, options);
  if (total > MAX_FRAMES || total * size.width * size.height > MAX_PIXELS) {
    throw new Error(`本批次预计生成 ${total} 帧，超出浏览器内存保护范围（最多 ${MAX_FRAMES} 帧 / 1.2 亿像素）。请缩短区间、增大抽帧间隔或降低目标高度。`);
  }
  const frames: Frame[] = [];
  const batch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  onProgress(0, total);
  try {
    for (let index = first; index <= last; index += step) {
      aborted(signal);
      const raw = await captureFrame(source, index, signal);
      const processed = processor ? await processor(raw, options, signal) : processCanvas(raw, options);
      // Yield before each expensive encode so the Cancel button can receive input.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      aborted(signal);
      const blob = await canvasToBlob(processed);
      aborted(signal);
      frames.push({ id: `${batch}-${index}`, name: `frame_${String(frames.length + 1).padStart(3, '0')}.png`, sourceIndex: index, time: (index - 1) / source.fps, url: URL.createObjectURL(blob), width: processed.width, height: processed.height, selected: true, anchor: options.alignment === 'bottom' ? 'bottom' : 'center' });
      onProgress(frames.length, total);
    }
    return frames;
  } catch (error) {
    frames.forEach((frame) => URL.revokeObjectURL(frame.url));
    throw error;
  }
}
