import JSZip from 'jszip';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import type { Frame } from '../types';
import { resolveSheetLayout } from './sheetLayout';

const MAX_DIMENSION = 16_384;
const MAX_CANVAS_PIXELS = 64_000_000;

export function safeName(value: string): string {
  return value.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+|\.+$/g, '').trim().slice(0, 120) || 'animation';
}

function validateFrames(frames: Frame[], fps: number): void {
  if (!frames.length) throw new Error('请先选择至少一帧。');
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error('播放帧率需要在 1–120 FPS 之间。');
  for (const frame of frames) {
    if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) || frame.width < 1 || frame.height < 1) {
      throw new Error(`帧「${frame.name}」的尺寸无效。`);
    }
  }
}

function checkCanvasSize(width: number, height: number): void {
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_CANVAS_PIXELS) {
    throw new Error('导出画布过大，请减少帧数、调整列数或降低目标高度。单边上限为 16384 px，总像素上限为 6400 万。');
  }
}

function frameFilename(index: number): string {
  return `frame_${String(index + 1).padStart(3, '0')}.png`;
}

export function buildAnimationManifest(frames: Frame[], name: string, fps: number) {
  validateFrames(frames, fps);
  const duration = 1000 / fps;
  return {
    format: 'sprite-workbench-v1',
    name: safeName(name),
    fps,
    loop: true,
    frameCount: frames.length,
    durationMs: duration * frames.length,
    frames: frames.map((frame, index) => ({
      index,
      filename: frameFilename(index),
      sourceName: frame.name,
      sourceFrame: frame.sourceIndex,
      sourceTimeSeconds: frame.time,
      width: frame.width,
      height: frame.height,
      durationMs: duration,
    })),
  };
}

export function buildAtlasMetadata(frames: Frame[], name: string, fps: number, columns: number, rows?: number) {
  const manifest = buildAnimationManifest(frames, name, fps);
  if (!Number.isFinite(columns) || columns < 1 || !Number.isInteger(columns)) throw new Error('精灵图列数必须为正整数。');
  const { columns: cols, rows: actualRows } = resolveSheetLayout(frames.length, rows === undefined ? Math.min(columns, frames.length) : columns, rows);
  const cellWidth = Math.max(...frames.map(frame => frame.width));
  const cellHeight = Math.max(...frames.map(frame => frame.height));
  const width = cols * cellWidth;
  const height = actualRows * cellHeight;
  checkCanvasSize(width, height);
  return {
    frames: Object.fromEntries(frames.map((frame, index) => [frameFilename(index), {
      frame: {
        x: (index % cols) * cellWidth + Math.floor((cellWidth - frame.width) / 2),
        y: Math.floor(index / cols) * cellHeight + cellHeight - frame.height,
        w: frame.width,
        h: frame.height,
      },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: frame.width, h: frame.height },
      sourceSize: { w: frame.width, h: frame.height },
      pivot: { x: 0.5, y: 1 },
      duration: manifest.frames[index].durationMs,
    }])),
    animations: { [manifest.name]: manifest.frames.map(frame => frame.filename) },
    meta: {
      app: 'Sprite Workbench',
      version: '1.0',
      image: `${safeName(name)}.png`,
      format: 'RGBA8888',
      size: { w: width, h: height },
      scale: '1',
      fps,
      columns: cols,
      rows: actualRows,
      cellSize: { w: cellWidth, h: cellHeight },
      alignment: 'bottom-center',
    },
  };
}

function createCanvas(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  checkCanvasSize(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法创建绘图画布。');
  return { canvas, context };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法读取动画帧，请重新导入该图片后重试。'));
    image.src = url;
  });
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG 编码失败，请降低导出尺寸后重试。')), 'image/png');
  });
}

async function framePng(frame: Frame): Promise<Blob> {
  // Keep indexed palettes and optimized PNG bytes intact after compression.
  const response = await fetch(frame.url);
  if (!response.ok) throw new Error(`无法读取「${frame.name}」，请重新导入该图片后重试。`);
  const source = await response.blob();
  const header = new Uint8Array(await source.slice(0, 24).arrayBuffer());
  if (header.length === 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte)
    && String.fromCharCode(...header.subarray(12, 16)) === 'IHDR') {
    const dimensions = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (dimensions.getUint32(16) === frame.width && dimensions.getUint32(20) === frame.height) return source;
  }
  const { canvas, context } = createCanvas(frame.width, frame.height);
  context.drawImage(await loadImage(frame.url), 0, 0, frame.width, frame.height);
  const blob = await canvasPng(canvas);
  canvas.width = 0;
  canvas.height = 0;
  return blob;
}

async function horizontalStripPng(frames: Frame[]): Promise<Blob> {
  validateFrames(frames, 12);
  const cellWidth = Math.max(...frames.map(frame => frame.width));
  const cellHeight = Math.max(...frames.map(frame => frame.height));
  const { canvas, context } = createCanvas(frames.length * cellWidth, cellHeight);
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    const x = index * cellWidth + Math.floor((cellWidth - frame.width) / 2);
    const y = cellHeight - frame.height;
    context.drawImage(await loadImage(frame.url), x, y, frame.width, frame.height);
  }
  const blob = await canvasPng(canvas);
  canvas.width = 0;
  canvas.height = 0;
  return blob;
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Allow the browser to start reading the object URL before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function exportCurrentFrame(frame: Frame): Promise<void> {
  validateFrames([frame], 12);
  downloadBlob(await framePng(frame), `${safeName(frame.name)}.png`);
}

export async function exportZip(frames: Frame[], name: string, fps: number): Promise<void> {
  const manifest = buildAnimationManifest(frames, name, fps);
  const atlas = buildAtlasMetadata(frames, name, fps, frames.length);
  const zip = new JSZip();
  for (let index = 0; index < frames.length; index++) {
    zip.file(frameFilename(index), await framePng(frames[index]));
  }
  const spriteName = `${safeName(name)}.png`;
  zip.file(spriteName, await horizontalStripPng(frames));
  zip.file('atlas.json', JSON.stringify(atlas, null, 2));
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  downloadBlob(await zip.generateAsync({ type: 'blob', compression: 'STORE' }), `${safeName(name)}.zip`);
}

export async function exportSpriteSheet(frames: Frame[], name: string, fps: number, columns: number, rows?: number): Promise<void> {
  const atlas = buildAtlasMetadata(frames, name, fps, columns, rows);
  const { canvas, context } = createCanvas(atlas.meta.size.w, atlas.meta.size.h);
  for (let index = 0; index < frames.length; index++) {
    const rect = atlas.frames[frameFilename(index)].frame;
    context.drawImage(await loadImage(frames[index].url), rect.x, rect.y, rect.w, rect.h);
  }
  const zip = new JSZip();
  const spriteName = `${safeName(name)}.png`;
  zip.file(spriteName, await canvasPng(canvas));
  canvas.width = 0;
  canvas.height = 0;
  zip.file('atlas.json', JSON.stringify(atlas, null, 2));
  zip.file('manifest.json', JSON.stringify(buildAnimationManifest(frames, name, fps), null, 2));
  downloadBlob(await zip.generateAsync({ type: 'blob', compression: 'STORE' }), `${safeName(name)}.zip`);
}

export async function exportGif(frames: Frame[], name: string, fps: number): Promise<void> {
  validateFrames(frames, fps);
  if (fps > 100) throw new Error('GIF 的时间精度为 10 毫秒，请使用不高于 100 FPS 的播放帧率。');
  const width = Math.max(...frames.map(frame => frame.width));
  const height = Math.max(...frames.map(frame => frame.height));
  const { canvas, context } = createCanvas(width, height);
  const gif = GIFEncoder();
  // GIF timing is stored in hundredths of a second. Error diffusion keeps
  // rates such as 12 and 24 FPS accurate over the complete animation.
  let elapsedTicks = 0;
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    context.clearRect(0, 0, width, height);
    context.drawImage(await loadImage(frame.url), Math.floor((width - frame.width) / 2), height - frame.height, frame.width, frame.height);
    const data = context.getImageData(0, 0, width, height).data;
    const colors = quantize(data, 255, { format: 'rgb565' });
    const pixels = applyPalette(data, colors, 'rgb565');
    // Reserve index zero explicitly: opaque black must remain opaque even
    // when its RGB values equal those of fully transparent pixels.
    for (let pixel = 0; pixel < pixels.length; pixel++) pixels[pixel] = data[pixel * 4 + 3] < 128 ? 0 : pixels[pixel] + 1;
    const targetTicks = Math.round((index + 1) * 100 / fps);
    const delayTicks = Math.max(1, targetTicks - elapsedTicks);
    elapsedTicks += delayTicks;
    gif.writeFrame(pixels, width, height, {
      palette: [[0, 0, 0], ...colors],
      transparent: true,
      transparentIndex: 0,
      dispose: 2,
      repeat: 0,
      delay: delayTicks * 10,
    });
    // Yield between frames so export status and user input can repaint.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  gif.finish();
  canvas.width = 0;
  canvas.height = 0;
  const bytes = gif.bytes();
  downloadBlob(new Blob([bytes], { type: 'image/gif' }), `${safeName(name)}.gif`);
}
