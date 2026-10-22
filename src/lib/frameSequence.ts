import type { Frame } from '../types';

/** Move by stable identity so hidden/deselected frames retain their metadata. */
export function moveFrame(frames: Frame[], movingId: string, targetId: string): Frame[] {
  const from = frames.findIndex(frame => frame.id === movingId);
  const to = frames.findIndex(frame => frame.id === targetId);
  if (from < 0 || to < 0 || from === to) return frames;
  const reordered = [...frames];
  const [moving] = reordered.splice(from, 1);
  reordered.splice(to, 0, moving);
  return reordered;
}

/** Apply visible ordering/selection edits to originals; unsampled frames keep their slots. */
export function syncSequenceInputs(originals: Frame[], edited: Frame[]): Frame[] {
  const byId = new Map(originals.map(frame => [frame.id, frame]));
  const visible = edited.filter(frame => byId.has(frame.id));
  const visibleIds = new Set(visible.map(frame => frame.id));
  let index = 0;
  return originals.map(frame => {
    if (!visibleIds.has(frame.id)) return frame;
    const current = visible[index++];
    return { ...byId.get(current.id)!, selected: current.selected };
  });
}

/** Share the exact first asset at the tail, including its canvas and alignment. */
export function matchLoopEndpoints(frames: Frame[]): Frame[] {
  if (frames.length < 2) return frames;
  const first = frames[0];
  return frames.map((frame, index) => index === frames.length - 1
    ? { ...frame, url: first.url, width: first.width, height: first.height, anchor: first.anchor }
    : frame);
}
