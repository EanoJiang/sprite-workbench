export const FIT_FRAME_CARD_WIDTH = 180;
export const FIT_FRAME_CARD_INSET = 8;
export const FIT_FRAME_META_HEIGHT = 32;
export const FIT_FRAME_GAP = 12;
export const FIT_FRAME_OUTLINE = 8;

interface Input {
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  count: number;
  viewportWidth: number;
  viewportHeight: number;
}
export interface FittedFrameGridLayout {
  columns: number;
  rows: number;
  cardWidth: number;
  cardHeight: number;
  thumbHeight: number;
  width: number;
  height: number;
  scale: number;
  displayWidth: number;
  displayHeight: number;
  left: number;
  top: number;
}

const tracks = (value: number) => Number.isFinite(value) ? Math.max(1, Math.min(400, Math.floor(value))) : 1;
const viewport = (value: number) => Number.isFinite(value) && value > 0 ? value : 0;

/** Fit the entire card grid, including metadata, gaps and outline space. */
export function fitFrameGrid(input: Input): FittedFrameGridLayout {
  const columns = tracks(input.columns);
  const count = Number.isFinite(input.count) ? Math.max(0, Math.min(400, Math.ceil(input.count))) : 0;
  const rows = Math.max(tracks(input.rows), Math.ceil(count / columns));
  const validAspect = Number.isFinite(input.cellWidth) && input.cellWidth > 0 && Number.isFinite(input.cellHeight) && input.cellHeight > 0;
  // Bound pathological aspect ratios so CSS never receives unbounded track sizes.
  const aspect = validAspect ? Math.max(.01, Math.min(100, input.cellWidth / input.cellHeight)) : 1;
  const cardWidth = FIT_FRAME_CARD_WIDTH;
  const thumbHeight = (cardWidth - FIT_FRAME_CARD_INSET * 2) / aspect;
  const cardHeight = thumbHeight + FIT_FRAME_CARD_INSET * 2 + FIT_FRAME_META_HEIGHT;
  const width = columns * cardWidth + (columns - 1) * FIT_FRAME_GAP + FIT_FRAME_OUTLINE * 2;
  const height = rows * cardHeight + (rows - 1) * FIT_FRAME_GAP + FIT_FRAME_OUTLINE * 2;
  const viewportWidth = viewport(input.viewportWidth), viewportHeight = viewport(input.viewportHeight);
  // A one-pixel inset also absorbs fractional device-pixel rounding at the edge.
  const scale = Math.max(0, Math.min(Math.max(0, viewportWidth - 2) / width, Math.max(0, viewportHeight - 2) / height));
  const displayWidth = width * scale, displayHeight = height * scale;
  return { columns, rows, cardWidth, cardHeight, thumbHeight, width, height, scale, displayWidth, displayHeight, left: (viewportWidth - displayWidth) / 2, top: (viewportHeight - displayHeight) / 2 };
}
