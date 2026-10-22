import type { Frame, ProcessOptions } from '../types';

export interface MattingStage {
  inputKey: string;
  settingsKey: string;
  options: ProcessOptions;
  frames: Frame[];
  ownedUrls: string[];
}

export function extractionOptions(options: ProcessOptions): ProcessOptions {
  return { ...options, removeBackground: false, watermarkRemoval: false, cleanup: 'none', backgroundToBlack: false, backgroundDesaturate: false, semitransparentToBlack: false, semitransparentToOpaque: false };
}

/** Stage 02 already established the canvas; stage 04 must preserve it. */
export function frameMattingOptions(frame: Pick<Frame, 'height'>, options: ProcessOptions): ProcessOptions {
  return { ...options, targetHeight: frame.height, padding: 0, layout: 'original' };
}

export function mattingInputKey(frames: Frame[]): string {
  return JSON.stringify(frames.map(frame => [frame.id, frame.url, frame.width, frame.height]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

export function mattingSettingsKey(options: ProcessOptions): string {
  const { targetHeight: _height, padding: _padding, layout: _layout, alignment: _alignment, ...effects } = options;
  return JSON.stringify(effects);
}

export function createMattingStage(input: Frame[], options: ProcessOptions, frames: Frame[]): MattingStage {
  const borrowed = new Set(input.map(frame => frame.url));
  return { inputKey: mattingInputKey(input), settingsKey: mattingSettingsKey(options), options: { ...options }, frames, ownedUrls: [...new Set(frames.map(frame => frame.url))].filter(url => url.startsWith('blob:') && !borrowed.has(url)) };
}

export function resolveMattingStage(input: Frame[], options: ProcessOptions, stage: MattingStage | null): { frames: Frame[]; pending: boolean } {
  const selected = input.filter(frame => frame.selected);
  const effectsEnabled = options.removeBackground || options.watermarkRemoval || options.cleanup !== 'none' || options.backgroundToBlack || options.backgroundDesaturate || options.semitransparentToBlack || options.semitransparentToOpaque;
  if (!selected.length || !effectsEnabled) return { frames: selected, pending: false };
  const byId = new Map(stage?.frames.map(frame => [frame.id, frame]));
  const ready = stage?.inputKey === mattingInputKey(input) && stage.settingsKey === mattingSettingsKey(options) && selected.every(frame => byId.has(frame.id));
  return ready ? { frames: selected.map(frame => ({ ...byId.get(frame.id)!, selected: true })), pending: false } : { frames: [], pending: true };
}
