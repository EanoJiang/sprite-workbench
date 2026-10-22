import { describe, expect, it } from 'vitest';
import type { Frame } from '../types';
import { defaultOptions } from '../types';
import { createMattingStage, extractionOptions, frameMattingOptions, resolveMattingStage } from './framePipeline';

const frames: Frame[] = ['a', 'b', 'c'].map((id, i) => ({ id, name: `${id}.png`, url: `raw:${id}`, sourceIndex: i + 1, time: i / 12, width: 64, height: 80, selected: id !== 'b' }));

describe('ordered frame stages', () => {
  it('extracts layout without applying effects and mattes without adding another layout', () => {
    const options = { ...defaultOptions, targetHeight: 128, padding: 16, watermarkRemoval: true, semitransparentToBlack: true };
    expect(extractionOptions(options)).toMatchObject({ targetHeight: 128, padding: 16, removeBackground: false, watermarkRemoval: false, semitransparentToBlack: false });
    expect(frameMattingOptions(frames[0], options)).toMatchObject({ targetHeight: 80, padding: 0, layout: 'original', removeBackground: true, watermarkRemoval: true });
  });

  it('passes current selection and order through the matting output without modifying upstream frames', () => {
    const processed = frames.filter(frame => frame.selected).map(frame => ({ ...frame, url: `matte:${frame.id}` }));
    const stage = createMattingStage(frames, defaultOptions, processed);
    const next = resolveMattingStage([...frames].reverse(), defaultOptions, stage);
    expect(next.pending).toBe(false);
    expect(next.frames.map(frame => frame.url)).toEqual(['matte:c', 'matte:a']);
    expect(frames.map(frame => frame.url)).toEqual(['raw:a', 'raw:b', 'raw:c']);
    expect(resolveMattingStage(frames.map(frame => ({ ...frame, selected: frame.id === 'a' })), defaultOptions, stage).frames).toHaveLength(1);
  });

  it('blocks downstream output when pixels, effects or the newly selected input lack a current result', () => {
    const stage = createMattingStage(frames, defaultOptions, frames.filter(frame => frame.selected));
    expect(resolveMattingStage(frames.map(frame => ({ ...frame, selected: true })), defaultOptions, stage)).toMatchObject({ pending: true, frames: [] });
    expect(resolveMattingStage(frames.map(frame => ({ ...frame, url: `new:${frame.id}` })), defaultOptions, stage)).toMatchObject({ pending: true, frames: [] });
    expect(resolveMattingStage(frames, { ...defaultOptions, tolerance: 50 }, stage)).toMatchObject({ pending: true, frames: [] });
    expect(resolveMattingStage(frames, { ...defaultOptions, removeBackground: false }, null).frames.map(frame => frame.url)).toEqual(['raw:a', 'raw:c']);
    expect(resolveMattingStage(frames, { ...defaultOptions, removeBackground: false, semitransparentToOpaque: true }, null)).toMatchObject({ pending: true, frames: [] });
    expect(resolveMattingStage([], defaultOptions, null)).toMatchObject({ pending: false, frames: [] });
  });
});
