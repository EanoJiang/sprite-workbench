export interface SheetLayout {
  columns: number;
  rows: number;
}

/** Normalize a manually edited row or column count. */
export function normalizeSheetDimension(value: number): number {
  if (!Number.isFinite(value)) return value === Infinity ? 400 : 1;
  return Math.min(400, Math.max(1, Math.trunc(value)));
}

function normalizedFrameCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Keep explicit empty cells while adding enough rows for every current frame. */
export function resolveSheetLayout(frameCount: number, columns: number | 'auto', rows?: number): SheetLayout {
  const count = normalizedFrameCount(frameCount);
  const resolvedColumns = columns === 'auto' ? Math.max(1, count) : normalizeSheetDimension(columns);
  return {
    columns: resolvedColumns,
    rows: Math.max(rows === undefined ? 1 : normalizeSheetDimension(rows), Math.ceil(count / resolvedColumns)),
  };
}

/** Preserve the edited axis and any existing space on the other axis. */
export function editSheetLayout(frameCount: number, dimension: 'columns' | 'rows', value: number, current?: SheetLayout): SheetLayout {
  const edited = normalizeSheetDimension(value);
  const fitted = Math.max(1, Math.ceil(normalizedFrameCount(frameCount) / edited));
  const other = current ? Math.max(fitted, normalizeSheetDimension(dimension === 'columns' ? current.rows : current.columns)) : fitted;
  return dimension === 'columns' ? { columns: edited, rows: other } : { columns: other, rows: edited };
}
