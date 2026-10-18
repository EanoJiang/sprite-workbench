import type { Frame } from '../types';
import { exportGif } from './export';
import { exportCompressionSpriteSheet, exportCompressionZip } from './compressionExport';
import type { CompressionMetadata } from './compressionExport';
import { exportMov, readExportPng } from './movExport';
import type { MovExportFrame } from './movExport';

export type PreviewExportMode = 'frames' | 'sprite_sheet' | 'mov' | 'gif';
export interface PreviewExportFrame extends MovExportFrame { id?: string; selected?: boolean }
interface Options { columns?: number | 'auto'; rows?: number; metadata?: CompressionMetadata; signal?: AbortSignal }
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError'); };

/** Export precisely the selected preview's frozen input, never another variant. */
export async function exportPreviewFrames(input: readonly PreviewExportFrame[], mode: PreviewExportMode, name: string, fps: number, options: Options = {}): Promise<void> {
  const { signal, columns = 'auto', rows, metadata = {} } = options;
  checkAbort(signal);
  const frames = input.map(frame => ({ ...frame }));
  if (!frames.length) throw new Error('请先载入至少一帧。');
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error('播放帧率需要在 1–120 FPS 之间。');
  if (mode === 'mov') { await exportMov(frames, name, fps, signal); return; }
  if (mode === 'gif') {
    const ownedUrls: string[] = [];
    try {
      const animation = frames.map((frame, index): Frame => {
        let url = frame.url;
        if (!url) {
          if (!frame.blob) throw new Error(`「${frame.name}」没有可导出的图片。`);
          url = URL.createObjectURL(frame.blob); ownedUrls.push(url);
        }
        return { ...frame, url, id: frame.id ?? `export-${index}`, selected: frame.selected ?? true };
      });
      checkAbort(signal); await exportGif(animation, name, fps);
    } finally { ownedUrls.forEach(url => URL.revokeObjectURL(url)); }
    return;
  }
  if (mode !== 'frames' && mode !== 'sprite_sheet') throw new Error('不支持的导出模式。');
  const prepared: PreviewExportFrame[] = [];
  for (const frame of frames) { prepared.push({ ...frame, blob: await readExportPng(frame, signal) }); checkAbort(signal); }
  if (mode === 'frames') await exportCompressionZip(prepared, name, fps, metadata);
  else await exportCompressionSpriteSheet(prepared, name, fps, metadata, columns, rows);
}
