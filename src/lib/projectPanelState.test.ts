import { describe, expect, it, vi } from 'vitest';
import type { Frame } from '../types';
import { releaseLoopCorrection } from './loopCorrection';
import { restoreLoopCorrectionResult, type LoopCorrectionProjectState } from './projectPanelState';

const frame = (index: number, url: string): Frame => ({
  id: `frame-${index}`, name: `${index}.png`, sourceIndex: index, time: index / 12,
  url, width: 32, height: 48, selected: true,
});
const settings = { mode: 'match' as const, transitionFrames: 4 };

describe('saved loop result restoration', () => {
  it('retains original frames as borrowed URLs and owns only independent restored object URLs', () => {
    const sources = [frame(0, 'blob:parent-first'), frame(1, '/api/projects/saved-middle.png'), frame(2, 'blob:parent-last')];
    const saved: LoopCorrectionProjectState = {
      enabled: true, settings,
      frames: [sources[0], sources[1], { ...sources[2], url: 'blob:restored-tail' }],
      changedCount: 1,
      originalDifference: { sameDimensions: true, identical: false, changedPixels: 11, totalPixels: 1536, differencePercent: 12.34 },
    };
    const restored = restoreLoopCorrectionResult(saved, sources)!;
    expect(restored.frames).toEqual(saved.frames);
    expect(restored.frames).not.toBe(saved.frames);
    expect(restored.frames[0]).not.toBe(saved.frames![0]);
    expect(restored.originalDifference).toEqual(saved.originalDifference);
    expect(restored.originalDifference).not.toBe(saved.originalDifference);
    expect(restored.changedCount).toBe(1);
    expect(restored.finalDifference).toMatchObject({ identical: true, differencePercent: 0 });
    const revoke = vi.fn();
    releaseLoopCorrection(restored, revoke);
    expect(revoke.mock.calls.map(([url]) => url)).toEqual(['blob:restored-tail']);
    expect(sources[2].url).toBe('blob:parent-last');
  });

  it('keeps static project assets readable and releases each shared restored object URL only once', () => {
    const sources = [frame(0, '/project/raw-first.png'), frame(1, '/project/raw-middle.png'), frame(2, '/project/raw-last.png')];
    const restored = restoreLoopCorrectionResult({ enabled: false, settings, frames: [
      frame(0, 'blob:restored-endpoints'), frame(1, '/project/saved-middle.png'), frame(2, 'blob:restored-endpoints'),
    ] }, sources)!;
    expect(restored.ownedUrls).toEqual(['blob:restored-endpoints']);
    expect(restored.frames[0].url).toBe(restored.frames[2].url);
  });

  it('keeps disabled saved results and restores blend metadata without running correction again', () => {
    const sources = [frame(0, 'source:0'), frame(1, 'source:1'), frame(2, 'source:2')];
    const saved = { enabled: false, settings: { mode: 'blend' as const, transitionFrames: 8 }, frames: sources };
    const restored = restoreLoopCorrectionResult(saved, sources)!;
    expect(restored.frames).toEqual(sources);
    expect(restored.changedCount).toBe(2);
    expect(saved.enabled).toBe(false);
    expect(saved.settings.transitionFrames).toBe(8);
    expect(restoreLoopCorrectionResult({ ...saved, frames: null }, sources)).toBeNull();
  });
});
