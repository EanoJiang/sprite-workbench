import { useEffect, useId, useRef, useState } from 'react';
import { normalizeSheetDimension } from './lib/sheetLayout';
import type { SheetLayout } from './lib/sheetLayout';
import './sheet-layout-controls.css';

type Dimension = 'columns' | 'rows';
interface Props {
  layout: SheetLayout;
  disabled?: boolean;
  onChange: (dimension: Dimension, value: number, baseline?: SheetLayout) => void;
}
function valid(value: string): boolean {
  const number = Number(value);
  return value.trim() !== '' && Number.isInteger(number) && number >= 1 && number <= 400;
}

export default function SheetLayoutControls({ layout, disabled = false, onChange }: Props) {
  const id = useId();
  const [drafts, setDrafts] = useState({ columns: String(layout.columns), rows: String(layout.rows) });
  const focused = useRef<Dimension | null>(null);
  const reported = useRef<Partial<Record<Dimension, number>>>({});
  const baseline = useRef<SheetLayout | null>(null);

  useEffect(() => {
    setDrafts(previous => ({
      columns: focused.current === 'columns' && reported.current.columns === layout.columns ? previous.columns : String(layout.columns),
      rows: focused.current === 'rows' && reported.current.rows === layout.rows ? previous.rows : String(layout.rows),
    }));
  }, [layout.columns, layout.rows]);

  useEffect(() => {
    if (disabled) {
      focused.current = null; reported.current = {}; baseline.current = null;
      setDrafts({ columns: String(layout.columns), rows: String(layout.rows) });
    }
  }, [disabled, layout.columns, layout.rows]);

  const edit = (dimension: Dimension, text: string) => {
    setDrafts(previous => ({ ...previous, [dimension]: text }));
    if (valid(text)) {
      const value = Number(text); reported.current[dimension] = value;
      if (value !== layout[dimension]) onChange(dimension, value, baseline.current ?? undefined);
    }
  };
  const commit = (dimension: Dimension) => {
    const value = normalizeSheetDimension(Number(drafts[dimension]));
    reported.current[dimension] = value;
    setDrafts(previous => ({ ...previous, [dimension]: String(value) }));
    if (value !== layout[dimension]) onChange(dimension, value, baseline.current ?? undefined);
  };

  return <div className="sheet-layout-controls" role="group" aria-label="精灵图行列设置" onKeyDown={event => event.stopPropagation()}>
    {([['columns', '列数'], ['rows', '行数']] as const).map(([dimension, label]) => <label key={dimension} htmlFor={`${id}-${dimension}`}><span>{label}</span><input id={`${id}-${dimension}`} type="number" inputMode="numeric" min={1} max={400} step={1} value={drafts[dimension]} disabled={disabled} onFocus={() => { focused.current = dimension; reported.current[dimension] = layout[dimension]; baseline.current = { ...layout }; }} onChange={event => edit(dimension, event.target.value)} onBlur={() => { commit(dimension); focused.current = null; baseline.current = null; }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} /></label>)}
  </div>;
}
