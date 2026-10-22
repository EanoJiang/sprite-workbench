import { describe, expect, it } from 'vitest';
import type { Frame } from '../types';
import { moveFrame, matchLoopEndpoints, syncSequenceInputs } from './frameSequence';

const frames: Frame[] = ['a', 'b', 'c', 'd'].map((id, index) => ({
  id, name: `${id}.png`, sourceIndex: index + 1, time: index / 12,
  url: `blob:${id}`, width: 32 + index, height: 48 + index, selected: id !== 'b', anchor: 'bottom',
}));

describe('shared frame sequence', () => {
  it('keeps unsampled originals and syncs visible edits without baking processed pixels', () => {
    const edited = [{ ...frames[2], url: 'processed:c', selected: false }, { ...frames[0], url: 'processed:a' }];
    const input = syncSequenceInputs(frames, edited);
    expect(input.map(frame => frame.id)).toEqual(['c', 'b', 'a', 'd']);
    expect(input.map(frame => frame.url)).toEqual(['blob:c', 'blob:b', 'blob:a', 'blob:d']);
    expect(input[0].selected).toBe(false);
    expect(input[2].width).toBe(32);
  });
  it('moves forward and backward without losing deselected frames or source identity', () => {
    const forward = moveFrame(frames, 'a', 'd');
    expect(forward.map(frame => frame.id)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveFrame(forward, 'a', 'b').map(frame => frame.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(forward[0]).toBe(frames[1]);
    expect(forward[0].selected).toBe(false);
    expect(frames.map(frame => frame.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ignores invalid IDs and dropping onto the same frame', () => {
    expect(moveFrame(frames, 'missing', 'a')).toBe(frames);
    expect(moveFrame(frames, 'a', 'missing')).toBe(frames);
    expect(moveFrame(frames, 'a', 'a')).toBe(frames);
  });

  it('keeps final output endpoints identical even after a downstream processor changes the tail', () => {
    const result = matchLoopEndpoints(frames);
    expect(result.map(frame => frame.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(result[3]).toEqual({ ...frames[3], url: 'blob:a', width: 32, height: 48, anchor: 'bottom' });
    expect(result[0]).toBe(frames[0]);
    expect(result[1]).toBe(frames[1]);
    expect(frames[3].url).toBe('blob:d');
    expect(matchLoopEndpoints([])).toEqual([]);
    expect(matchLoopEndpoints([frames[0]])).toEqual([frames[0]]);
  });
});
