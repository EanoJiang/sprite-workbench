import type { ProcessOptions } from '../types';
import { canvasToBlob, finalizeMatteCanvas, processCanvas } from './media';

export interface ModelHealth { loaded?: boolean; downloaded?: boolean; error?: string | null; state?: string; [key: string]: unknown; }
export interface BackendHealth { status: string; cuda?: boolean; gpu?: string | null; device?: string; busy?: boolean; models?: { birefnet?: ModelHealth; corridorkey?: ModelHealth }; }

async function apiError(response: Response): Promise<Error> {
  try { const data = await response.json(); return new Error(typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail ?? data)); }
  catch { return new Error(`本地 AI 服务返回错误 (${response.status})。请查看后端窗口。`); }
}

export async function getBackendHealth(signal?: AbortSignal): Promise<BackendHealth> {
  const response = await fetch('/api/health', { signal });
  if (!response.ok) throw await apiError(response);
  return response.json();
}

export async function prepareModels(options: ProcessOptions): Promise<BackendHealth> {
  if (!options.engine || options.engine === 'chroma' || options.engine === 'luma') return { status: 'local', busy: false };
  let response: Response;
  try { response = await fetch('/api/models/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: options.engine, device: options.aiDevice ?? 'auto', resolution: options.aiResolution ?? 768, birefnet_variant: options.birefnetVariant ?? 'standard' }) }); }
  catch { throw new Error('无法连接本地 AI 服务，请运行项目中的 start.ps1。'); }
  if (!response.ok) throw await apiError(response);
  return response.json();
}

export async function processFrame(input: HTMLCanvasElement, options: ProcessOptions, signal?: AbortSignal): Promise<HTMLCanvasElement> {
  if (!options.removeBackground || !options.engine || options.engine === 'chroma' || options.engine === 'luma') return processCanvas(input, options);
  const form = new FormData();
  form.set('image', await canvasToBlob(input), 'frame.png');
  form.set('mode', options.engine);
  form.set('device', options.aiDevice ?? 'auto');
  form.set('resolution', String(options.aiResolution ?? 768));
  form.set('birefnet_variant', options.birefnetVariant ?? 'standard');
  form.set('key_color', options.keyColor);
  form.set('spill', String(options.spill / 100));
  let response: Response;
  try { response = await fetch('/api/matte', { method: 'POST', body: form, signal }); }
  catch (error) { if (signal?.aborted) throw error; throw new Error('无法连接本地 AI 服务，请运行 start.ps1，并检查服务状态。'); }
  if (!response.ok) throw await apiError(response);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    if (signal?.aborted) throw new DOMException('处理已取消', 'AbortError');
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 AI 结果画布');
    context.drawImage(bitmap, 0, 0);
    return finalizeMatteCanvas(canvas, options, input);
  } finally { bitmap.close(); }
}
