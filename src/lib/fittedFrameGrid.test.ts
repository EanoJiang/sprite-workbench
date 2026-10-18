import { describe, expect, it } from 'vitest';
import { FIT_FRAME_CARD_WIDTH, FIT_FRAME_GAP, FIT_FRAME_OUTLINE, fitFrameGrid } from './fittedFrameGrid';

const input = { columns: 4, rows: 3, cellWidth: 600, cellHeight: 720, count: 10, viewportWidth: 760, viewportHeight: 520 };

describe('complete frame-card grid fitting', () => {
  it('fits whole cards including metadata, gaps and highlight space inside both viewport axes', () => {
    const fit = fitFrameGrid(input);
    expect(fit.columns).toBe(4); expect(fit.rows).toBe(3);
    expect(fit.cardWidth).toBe(FIT_FRAME_CARD_WIDTH);
    expect(fit.thumbHeight).toBeCloseTo(164 * 720 / 600);
    expect(fit.cardHeight - fit.thumbHeight).toBe(48);
    expect(fit.width).toBe(4 * FIT_FRAME_CARD_WIDTH + 3 * FIT_FRAME_GAP + 2 * FIT_FRAME_OUTLINE);
    expect(fit.displayWidth).toBeLessThanOrEqual(input.viewportWidth - 2);
    expect(fit.displayHeight).toBeLessThanOrEqual(input.viewportHeight - 2);
    expect(fit.left * 2 + fit.displayWidth).toBeCloseTo(input.viewportWidth);
    expect(fit.top * 2 + fit.displayHeight).toBeCloseTo(input.viewportHeight);
  });

  it('preserves explicit empty rows and columns without adding placeholder nodes', () => {
    const fit = fitFrameGrid({ ...input, columns: 8, rows: 12, count: 2 });
    expect(fit.columns).toBe(8); expect(fit.rows).toBe(12);
    expect(fit.height).toBe(12 * fit.cardHeight + 11 * FIT_FRAME_GAP + 2 * FIT_FRAME_OUTLINE);
    const insufficient = fitFrameGrid({ ...input, columns: 2, rows: 1, count: 9 });
    expect(insufficient.rows).toBe(5);
  });

  it('allows enlargement and recalculates for mobile sizes and layout changes', () => {
    const single = fitFrameGrid({ ...input, columns: 1, rows: 1, count: 1 });
    expect(single.scale).toBeGreaterThan(1);
    const mobile = fitFrameGrid({ ...input, viewportWidth: 300, viewportHeight: 370 });
    const vertical = fitFrameGrid({ ...input, columns: 1, rows: 10, viewportWidth: 300, viewportHeight: 370 });
    expect(mobile.displayWidth).toBeLessThanOrEqual(298);
    expect(mobile.displayHeight).toBeLessThanOrEqual(368);
    expect(vertical.scale).not.toBe(mobile.scale);
    expect(vertical.displayHeight).toBeCloseTo(368);
  });

  it('keeps all calculations finite for malformed aspects, hidden viewports and maximum tracks', () => {
    for (const cellWidth of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e-300, 1e300]) {
      for (const cellHeight of [0, Number.NaN, 1e-300, 1e300]) {
        const fit = fitFrameGrid({ ...input, columns: 400, rows: 400, cellWidth, cellHeight });
        expect(Object.values(fit).every(Number.isFinite)).toBe(true);
        expect(fit.scale).toBeGreaterThan(0);
        expect(fit.displayWidth).toBeLessThanOrEqual(input.viewportWidth);
        expect(fit.displayHeight).toBeLessThanOrEqual(input.viewportHeight);
      }
    }
    const hidden = fitFrameGrid({ ...input, viewportWidth: 0, viewportHeight: 0, columns: Number.NaN, rows: -20 });
    expect(hidden.scale).toBe(0); expect(hidden.columns).toBe(1); expect(hidden.rows).toBe(10);
  });
});
