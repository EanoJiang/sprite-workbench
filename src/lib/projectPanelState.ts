import type { Frame, ProcessOptions } from '../types';
import type { CompressedFrame, CompressionSettings, CompressionSourceFrame } from './compression';
import type { LoopCorrectionResult, LoopCorrectionSettings, LoopDifference } from './loopCorrection';

export interface LoopCorrectionProjectState {
  enabled: boolean;
  settings: LoopCorrectionSettings;
  frames: Frame[] | null;
  originalDifference?: LoopDifference;
  changedCount?: number;
}

export interface CompressionProjectState {
  settings: CompressionSettings;
  lastSettings: CompressionSettings | null;
  sourceLabel: string;
  sourceMode?: 'workbench' | 'local';
  fps: number;
  sources: CompressionSourceFrame[];
  results: CompressedFrame[];
}

export interface LoopCorrectionProjectHandle { getSnapshot(): LoopCorrectionProjectState }
export interface CompressionProjectHandle { getSnapshot(): CompressionProjectState }

export interface SmoothingProjectState {
  enabled: boolean;
  pipelineVersion?: number;
  options: ProcessOptions;
  frames: Frame[] | null;
}

export interface MattingProjectState {
  options: ProcessOptions;
  frames: Frame[] | null;
}
export interface SmoothingProjectHandle { getSnapshot(): SmoothingProjectState }

/** Restored original-frame URLs remain borrowed even when they are object URLs. */
export function restoreLoopCorrectionResult(saved: LoopCorrectionProjectState, sources: Frame[]): LoopCorrectionResult | null {
  if (!saved.frames?.length) return null;
  const frames = saved.frames.map(frame => ({ ...frame }));
  const borrowedUrls = new Set(sources.map(frame => frame.url));
  const ownedUrls = [...new Set(frames.map(frame => frame.url))].filter(url => url.startsWith('blob:') && !borrowedUrls.has(url));
  const totalPixels = frames[0].width * frames[0].height;
  const sameDimensions = sources[0]?.width === sources.at(-1)?.width && sources[0]?.height === sources.at(-1)?.height;
  const identicalDifference: LoopDifference = { sameDimensions: true, identical: true, changedPixels: 0, totalPixels, differencePercent: 0 };
  return {
    frames, ownedUrls,
    changedCount: saved.changedCount ?? (saved.settings.mode === 'blend' ? Math.max(1, Math.min(frames.length - 1, Math.round(saved.settings.transitionFrames) || 1)) : 1),
    // The panel hides the percentage when an older project lacks these measurements.
    originalDifference: saved.originalDifference ? { ...saved.originalDifference } : { ...identicalDifference, sameDimensions, identical: false },
    finalDifference: identicalDifference,
  };
}
