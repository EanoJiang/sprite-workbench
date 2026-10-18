import { describe, expect, it } from 'vitest';
import { editSheetLayout, normalizeSheetDimension, resolveSheetLayout } from './sheetLayout';

describe('normalizeSheetDimension', () => {
  it.each([
    [1, 1], [400, 400], [3.9, 3], [0, 1], [-8, 1], [9999, 400],
    [Number.NaN, 1], [Infinity, 400], [-Infinity, 1], [Number.MAX_VALUE, 400],
  ])('normalizes %s to the allowed integer %s', (value, expected) => {
    expect(normalizeSheetDimension(value)).toBe(expected);
  });
});

describe('editSheetLayout', () => {
  it('keeps the edited column count and automatically fits rows', () => {
    expect(editSheetLayout(10, 'columns', 6)).toEqual({ columns: 6, rows: 2 });
  });

  it('keeps the edited row count, including an intentionally empty last row', () => {
    expect(editSheetLayout(10, 'rows', 3)).toEqual({ columns: 4, rows: 3 });
    expect(editSheetLayout(10, 'rows', 6)).toEqual({ columns: 2, rows: 6 });
  });

  it('normalizes invalid manual input before fitting the other axis', () => {
    expect(editSheetLayout(10, 'columns', Number.NaN)).toEqual({ columns: 1, rows: 10 });
    expect(editSheetLayout(10, 'rows', -3)).toEqual({ columns: 10, rows: 1 });
    expect(editSheetLayout(10, 'columns', Infinity)).toEqual({ columns: 400, rows: 1 });
  });

  it('keeps both axes positive for an empty sequence without discarding the edited value', () => {
    expect(editSheetLayout(0, 'columns', 6)).toEqual({ columns: 6, rows: 1 });
    expect(editSheetLayout(0, 'rows', 3)).toEqual({ columns: 1, rows: 3 });
  });

  it('retains the other manually chosen axis whenever the current capacity is enough', () => {
    expect(editSheetLayout(10, 'rows', 5, { columns: 3, rows: 4 })).toEqual({ columns: 3, rows: 5 });
    expect(editSheetLayout(10, 'columns', 3, { columns: 2, rows: 6 })).toEqual({ columns: 3, rows: 6 });
  });

  it('expands the other axis only when the newly edited capacity cannot hold every frame', () => {
    expect(editSheetLayout(10, 'rows', 2, { columns: 3, rows: 4 })).toEqual({ columns: 5, rows: 2 });
    expect(editSheetLayout(10, 'columns', 2, { columns: 3, rows: 4 })).toEqual({ columns: 2, rows: 5 });
  });
});

describe('resolveSheetLayout', () => {
  it('keeps manual columns and rows larger than the number of frames', () => {
    expect(resolveSheetLayout(2, 3, 4)).toEqual({ columns: 3, rows: 4 });
  });

  it('preserves saved empty tail rows and adds rows when the sequence grows', () => {
    expect(resolveSheetLayout(10, 2, 6)).toEqual({ columns: 2, rows: 6 });
    expect(resolveSheetLayout(13, 2, 6)).toEqual({ columns: 2, rows: 7 });
    expect(resolveSheetLayout(10, 3, 1)).toEqual({ columns: 3, rows: 4 });
  });

  it('uses a single row for automatic columns and at least a 1 by 1 empty layout', () => {
    expect(resolveSheetLayout(10, 'auto')).toEqual({ columns: 10, rows: 1 });
    expect(resolveSheetLayout(0, 'auto')).toEqual({ columns: 1, rows: 1 });
    expect(resolveSheetLayout(-10, 'auto')).toEqual({ columns: 1, rows: 1 });
    expect(resolveSheetLayout(Number.NaN, 'auto')).toEqual({ columns: 1, rows: 1 });
  });

  it('normalizes restored invalid dimensions while keeping all frames visible', () => {
    expect(resolveSheetLayout(10, Number.NaN, -5)).toEqual({ columns: 1, rows: 10 });
    expect(resolveSheetLayout(10, -5, Infinity)).toEqual({ columns: 1, rows: 400 });
    expect(resolveSheetLayout(10, 9000, Number.NaN)).toEqual({ columns: 400, rows: 1 });
  });
});
