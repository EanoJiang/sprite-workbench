import type { Frame, MediaSource, ProcessOptions } from '../types';

export interface ProcessingTaskInfo {
  id: string;
  sampling: string;
  engine: string;
  scale: string;
  layout: string;
  stride: string;
  inputRange: string;
  keyColor: string | null;
}

function identifier(): string {
  const now = new Date();
  const stamp = [now.getFullYear(), ...[now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()].map(value => String(value).padStart(2, '0'))].join('');
  return `${stamp.slice(0, 8)}-${stamp.slice(8)}-${crypto.randomUUID().slice(0, 4)}`;
}

export function extractionTaskInfo(source: MediaSource, start: number, end: number, stride: number, options: ProcessOptions, output: Frame[]): ProcessingTaskInfo {
  const engines: Record<string, string> = { chroma: 'Chroma', luma: 'Luma', birefnet: 'BiRefNet', corridorkey: 'CorridorKey', hybrid: 'BiRefNet + CorridorKey' };
  const contentHeight = Math.max(1, (output[0]?.height ?? options.targetHeight) - 2 * options.padding);
  return {
    id: identifier(), sampling: source.kind === 'video' ? '浏览器视频解码 / Canvas' : '浏览器图片 / Canvas',
    engine: options.removeBackground ? engines[options.engine ?? 'chroma'] ?? 'Chroma' : '保留背景',
    scale: `${Number((contentHeight / (options.layout === 'square' ? Math.max(source.width, source.height) : source.height) * 100).toFixed(1))}%`,
    layout: `${options.layout === 'square' ? '正方形画布' : '保持原始比例'} / ${options.alignment === 'bottom' ? '底部对齐' : '居中'}`,
    stride: `每 ${stride} 帧保留一张`, inputRange: `${((start - 1) / source.fps).toFixed(2)}s - ${(end / source.fps).toFixed(2)}s`,
    keyColor: options.removeBackground ? options.keyColor : null,
  };
}

export function importedTaskInfo(kind: 'import' | 'example' | 'restored'): ProcessingTaskInfo {
  const label = { import: '图片序列导入', example: '内置示例', restored: '工程恢复' }[kind];
  return { id: identifier(), sampling: label, engine: '已处理帧 / 未记录', scale: '100%', layout: '保留导入画布', stride: '保留全部导入帧', inputRange: '原帧序列', keyColor: null };
}

export function restoreTaskInfo(value: unknown): ProcessingTaskInfo | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Partial<ProcessingTaskInfo>;
  const fields = ['id', 'sampling', 'engine', 'scale', 'layout', 'stride', 'inputRange'] as const;
  if (fields.some(key => typeof data[key] !== 'string' || data[key]!.length > 300)) return undefined;
  if (data.keyColor !== null && (typeof data.keyColor !== 'string' || !/^#[a-f\d]{6}$/i.test(data.keyColor))) return undefined;
  return data as ProcessingTaskInfo;
}
