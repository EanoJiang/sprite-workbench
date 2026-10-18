import JSZip from 'jszip';
import { downloadBlob } from './export';
import { resolveSheetLayout } from './sheetLayout';

/** Structural type: works with processed Blob frames and the workbench Frame. */
export interface CompressionExportFrame {
  name: string;
  width: number;
  height: number;
  sourceIndex: number;
  time: number;
  blob?: Blob;
  url?: string;
}

export interface TarEntry { name: string; data: Uint8Array; }
export type CompressionMetadata = Record<string, unknown>;
const BLOCK = 512;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const encoder = new TextEncoder();

function exportName(value: string): string {
  return value.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+|\.+$/g, '').trim().slice(0, 100) || 'animation';
}

function pngFilename(index: number): string { return `frame_${String(index + 1).padStart(3, '0')}.png`; }

function headerText(header: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new Error('TAR 文件名超出 USTAR 格式限制。');
  header.set(bytes, offset);
}

function headerOctal(header: Uint8Array, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('TAR 文件大小无效。');
  const octal = value.toString(8);
  if (octal.length > length - 1) throw new Error('TAR 文件大小超出 USTAR 格式限制。');
  headerText(header, offset, length, `${octal.padStart(length - 1, '0')}\0`);
}

/** Deterministic regular-file USTAR: 512-byte blocks, unsigned checksum, mtime 0. */
export function buildTar(entries: readonly TarEntry[]): Uint8Array<ArrayBuffer> {
  let length = BLOCK * 2;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.name || entry.name === '.' || entry.name === '..' || /[\\/\u0000-\u001f]/.test(entry.name) || encoder.encode(entry.name).length > 100) throw new Error('TAR 条目必须为安全的文件名。');
    if (seen.has(entry.name)) throw new Error('TAR 中存在重复文件名。');
    seen.add(entry.name);
    length += BLOCK + Math.ceil(entry.data.byteLength / BLOCK) * BLOCK;
    if (!Number.isSafeInteger(length) || length > MAX_ARCHIVE_BYTES) throw new Error('导出文件过大，请减少帧数或降低尺寸。');
  }
  const archive = new Uint8Array(length);
  let offset = 0;
  for (const entry of entries) {
    const header = archive.subarray(offset, offset + BLOCK);
    headerText(header, 0, 100, entry.name);
    headerOctal(header, 100, 8, 0o644);
    headerOctal(header, 108, 8, 0);
    headerOctal(header, 116, 8, 0);
    headerOctal(header, 124, 12, entry.data.byteLength);
    headerOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48; // regular file
    headerText(header, 257, 6, 'ustar\0');
    headerText(header, 263, 2, '00');
    headerText(header, 265, 32, 'framecraft');
    headerText(header, 297, 32, 'framecraft');
    headerOctal(header, 329, 8, 0);
    headerOctal(header, 337, 8, 0);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    headerText(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
    archive.set(entry.data, offset + BLOCK);
    offset += BLOCK + Math.ceil(entry.data.byteLength / BLOCK) * BLOCK;
  }
  return archive;
}

async function processedPng(frame: CompressionExportFrame): Promise<{ blob: Blob; data: Uint8Array<ArrayBuffer> }> {
  let blob = frame.blob;
  if (!blob) {
    if (!frame.url) throw new Error(`「${frame.name}」没有可导出的压缩结果。`);
    const response = await fetch(frame.url);
    if (!response.ok) throw new Error(`无法读取「${frame.name}」，请重新执行压缩。`);
    blob = await response.blob();
  }
  const data = new Uint8Array(await blob.arrayBuffer());
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (data.length < 24 || !signature.every((byte, index) => data[index] === byte) || String.fromCharCode(...data.subarray(12, 16)) !== 'IHDR') throw new Error('处理结果不是有效的 PNG，请先执行压缩。');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(16) !== frame.width || view.getUint32(20) !== frame.height) throw new Error(`「${frame.name}」的 PNG 尺寸与结果信息不一致，请重新执行压缩。`);
  return { blob, data };
}

type ProcessedImage = HTMLImageElement | ImageBitmap;

async function loadProcessedImage(blob: Blob): Promise<ProcessedImage> {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob); }
    catch { /* Fall back to an object URL for browsers without PNG bitmap decoding. */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('无法读取压缩结果，请重新执行压缩。'));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG 编码失败，请降低导出尺寸后重试。')), 'image/png');
  });
}

export function buildCompressionManifest(
  frames: readonly (CompressionExportFrame & { bytes: number })[], name: string, fps: number,
  metadata: CompressionMetadata = {},
) {
  if (!frames.length) throw new Error('请先生成至少一帧压缩结果。');
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error('播放帧率需要在 1–120 FPS 之间。');
  if (frames.some(frame => !Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) || frame.width < 1 || frame.height < 1 || !Number.isSafeInteger(frame.bytes) || frame.bytes < 1)) throw new Error('压缩帧的尺寸或文件大小无效。');
  const inputBytes = typeof metadata.inputBytes === 'number' && Number.isFinite(metadata.inputBytes) && metadata.inputBytes >= 0 ? metadata.inputBytes : null;
  const outputBytes = frames.reduce((sum, frame) => sum + frame.bytes, 0);
  return {
    format: 'framecraft-compression-v1',
    name: exportName(name),
    fps,
    loop: true,
    frameCount: frames.length,
    durationMs: frames.length * 1000 / fps,
    inputBytes,
    outputBytes,
    savingsPercent: inputBytes ? (1 - outputBytes / inputBytes) * 100 : null,
    settings: metadata.settings && typeof metadata.settings === 'object' ? metadata.settings : {},
    metadata,
    frames: frames.map((frame, index) => ({
      index,
      filename: pngFilename(index),
      sourceName: frame.name,
      sourceFrame: frame.sourceIndex,
      sourceTimeSeconds: frame.time,
      width: frame.width,
      height: frame.height,
      bytes: frame.bytes,
      durationMs: 1000 / fps,
    })),
  };
}

export async function exportCompressedFrames(
  frames: readonly CompressionExportFrame[], name: string, fps: number, format: 'zip' | 'tar',
  metadata: CompressionMetadata = {},
): Promise<void> {
  // Validate before fetching hundreds of Blob URLs.
  buildCompressionManifest(frames.map(frame => ({ ...frame, bytes: 1 })), name, fps, metadata);
  if (format !== 'zip' && format !== 'tar') throw new Error('不支持的压缩包格式。');
  const entries: TarEntry[] = [];
  const measured: (CompressionExportFrame & { bytes: number })[] = [];
  let total = 0;
  for (const [index, frame] of frames.entries()) {
    const { data } = await processedPng(frame);
    total += data.byteLength;
    if (total > MAX_ARCHIVE_BYTES - 1024 * 1024) throw new Error('导出文件过大，请减少帧数或降低尺寸。');
    entries.push({ name: pngFilename(index), data });
    measured.push({ ...frame, bytes: data.byteLength });
  }
  const manifest = buildCompressionManifest(measured, name, fps, metadata);
  entries.push({ name: 'manifest.json', data: encoder.encode(JSON.stringify(manifest, null, 2)) });
  let blob: Blob;
  if (format === 'tar') blob = new Blob([buildTar(entries)], { type: 'application/x-tar' });
  else {
    const zip = new JSZip();
    for (const entry of entries) zip.file(entry.name, entry.data);
    blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  }
  downloadBlob(blob, `${exportName(name)}.${format}`);
}

export function exportCompressionZip(frames: readonly CompressionExportFrame[], name: string, fps: number, metadata: CompressionMetadata = {}): Promise<void> {
  return exportCompressedFrames(frames, name, fps, 'zip', metadata);
}

/**
 * Export compressed frames using the same grid layout as the workbench
 * sprite-sheet export. The ZIP contains only the named sprite image plus
 * atlas and animation metadata, so every frame is described by one layout.
 */
export async function exportCompressionSpriteSheet(
  frames: readonly CompressionExportFrame[], name: string, fps: number,
  metadata: CompressionMetadata = {}, columns: number | 'auto' = 'auto', rows?: number,
): Promise<void> {
  // Validate the sequence before reading any Blob URLs.  We measure bytes as
  // we read them so manifest.outputBytes reflects the actual exported data.
  buildCompressionManifest(frames.map(frame => ({ ...frame, bytes: 1 })), name, fps, metadata);
  const processed: { frame: CompressionExportFrame; blob: Blob; data: Uint8Array<ArrayBuffer> }[] = [];
  let total = 0;
  for (const frame of frames) {
    const result = await processedPng(frame);
    total += result.data.byteLength;
    if (total > MAX_ARCHIVE_BYTES - 1024 * 1024) throw new Error('导出文件过大，请减少帧数或降低尺寸。');
    processed.push({ frame, ...result });
  }

  const measured = processed.map(({ frame, data }) => ({ ...frame, bytes: data.byteLength }));
  const manifest = buildCompressionManifest(measured, name, fps, metadata);
  const requestedColumns = columns === 'auto' ? measured.length : columns;
  if (!Number.isFinite(requestedColumns) || requestedColumns < 1 || !Number.isInteger(requestedColumns)) throw new Error('精灵图列数必须为正整数。');
  const { columns: sheetColumns, rows: sheetRows } = resolveSheetLayout(measured.length, rows === undefined ? Math.min(requestedColumns, measured.length) : columns, rows);
  const cellWidth = Math.max(...measured.map(frame => frame.width));
  const cellHeight = Math.max(...measured.map(frame => frame.height));
  const width = sheetColumns * cellWidth;
  const height = sheetRows * cellHeight;
  if (width > 16_384 || height > 16_384 || width * height > 64_000_000) {
    throw new Error('导出画布过大，请减少帧数或降低压缩尺寸。单边上限为 16384 px，总像素上限为 6400 万。');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法创建绘图画布。');

  // Keep the same bottom-center alignment used by the main workbench export.
  // This preserves a stable feet line when compressed frames have differing
  // dimensions while keeping transparent padding around each cell.
  for (let index = 0; index < processed.length; index++) {
    const { frame, blob } = processed[index];
    const image = await loadProcessedImage(blob);
    const x = (index % sheetColumns) * cellWidth + Math.floor((cellWidth - frame.width) / 2);
    const y = Math.floor(index / sheetColumns) * cellHeight + cellHeight - frame.height;
    context.drawImage(image, x, y, frame.width, frame.height);
    if ('close' in image && typeof image.close === 'function') image.close();
  }

  const sprite = await canvasPng(canvas);
  canvas.width = 0;
  canvas.height = 0;

  const atlas = {
    frames: Object.fromEntries(measured.map((frame, index) => [pngFilename(index), {
      frame: {
        x: (index % sheetColumns) * cellWidth + Math.floor((cellWidth - frame.width) / 2),
        y: Math.floor(index / sheetColumns) * cellHeight + cellHeight - frame.height,
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
      image: `${exportName(name)}.png`,
      format: 'RGBA8888',
      size: { w: width, h: height },
      scale: '1',
      fps,
      columns: sheetColumns,
      rows: sheetRows,
      cellSize: { w: cellWidth, h: cellHeight },
      alignment: 'bottom-center',
    },
  };

  const zip = new JSZip();
  zip.file(`${exportName(name)}.png`, sprite);
  zip.file('atlas.json', JSON.stringify(atlas, null, 2));
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const archive = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  downloadBlob(archive, `${exportName(name)}.zip`);
}

export function exportCompressionTar(frames: readonly CompressionExportFrame[], name: string, fps: number, metadata: CompressionMetadata = {}): Promise<void> {
  return exportCompressedFrames(frames, name, fps, 'tar', metadata);
}

export async function exportCurrentCompressedFrame(frame: CompressionExportFrame): Promise<void> {
  const { blob } = await processedPng(frame);
  downloadBlob(blob, `${exportName(frame.name)}.png`);
}

export function downloadCompressionFrame(frame: CompressionExportFrame, index?: number): Promise<void> {
  return exportCurrentCompressedFrame(frame.name ? frame : { ...frame, name: pngFilename(index ?? 0) });
}
