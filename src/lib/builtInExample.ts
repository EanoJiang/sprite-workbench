import type { Frame, MediaSource } from '../types';
import { loadMedia, releaseMedia } from './media';

interface ExampleManifest {
  version: 1;
  animationName: string;
  fps: number;
  source?: { name: string; type: string; fps: number; file: string };
  frames: (Omit<Frame, 'url'> & { file: string })[];
}

/** Load the checked-in snapshot, independently of the browser's recent imports. */
export async function loadBuiltInExample(signal?: AbortSignal): Promise<{
  animationName: string;
  fps: number;
  source: MediaSource;
  frames: Frame[];
}> {
  const manifestUrl = new URL('built-in-example/manifest.json', document.baseURI);
  const response = await fetch(manifestUrl, { signal });
  if (!response.ok) throw new Error('内置示例清单加载失败，请导入自己的素材。');
  const manifest: ExampleManifest = await response.json();
  if (manifest.version !== 1 || !manifest.frames?.length) throw new Error('内置示例缺少动画帧。');

  const frames = manifest.frames.map(({ file, ...frame }) => ({ ...frame, url: new URL(file, manifestUrl).href }));
  // A frame-only snapshot uses its first PNG as the source preview.
  const sourceInfo = manifest.source ?? { name: frames[0].name, type: 'image/png', fps: manifest.fps, file: manifest.frames[0].file };
  const sourceResponse = await fetch(new URL(sourceInfo.file, manifestUrl), { signal });
  if (!sourceResponse.ok) throw new Error('内置示例素材加载失败，请导入自己的素材。');
  const file = new File([await sourceResponse.blob()], sourceInfo.name, { type: sourceInfo.type });
  signal?.throwIfAborted();
  const source = await loadMedia(file, sourceInfo.fps);
  if (signal?.aborted) {
    releaseMedia(source); URL.revokeObjectURL(source.url);
    signal.throwIfAborted();
  }
  source.name = `内置示例 · ${source.name}`;
  return { animationName: manifest.animationName, fps: manifest.fps, source, frames };
}
