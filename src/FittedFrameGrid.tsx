import { Children, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { FIT_FRAME_GAP, FIT_FRAME_OUTLINE, fitFrameGrid } from './lib/fittedFrameGrid';
import './fitted-frame-grid.css';

interface Props {
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  children: ReactNode;
}

export default function FittedFrameGrid({ columns, rows, cellWidth, cellHeight, children }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const cards = Children.toArray(children);
  const layout = fitFrameGrid({ columns, rows, cellWidth, cellHeight, count: cards.length, viewportWidth: size.width, viewportHeight: size.height });
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth, height = element.clientHeight;
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure); observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const gridStyle: CSSProperties & Record<string, string | number> = {
    '--fit-card-height': `${layout.cardHeight}px`, '--fit-thumb-height': `${layout.thumbHeight}px`,
    width: layout.width, height: layout.height, padding: FIT_FRAME_OUTLINE,
    gridTemplateColumns: `repeat(${layout.columns}, ${layout.cardWidth}px)`,
    gridTemplateRows: `repeat(${layout.rows}, ${layout.cardHeight}px)`, gap: FIT_FRAME_GAP,
    transform: `scale(${layout.scale})`,
  };
  return <div ref={viewportRef} className="frame-grid-fit" role="group" aria-label="按精灵图布局排列的帧列表" data-columns={layout.columns} data-rows={layout.rows} data-scale={layout.scale} data-count={cards.length} data-ready={layout.scale > 0} data-cell-width={layout.cardWidth} data-cell-height={layout.cardHeight}>
    <div className="frame-grid-fit-bounds" style={{ left: layout.left, top: layout.top, width: layout.displayWidth, height: layout.displayHeight, visibility: layout.scale > 0 ? 'visible' : 'hidden' }}>
      <div className="frame-grid fitted-frame-grid" data-columns={layout.columns} data-rows={layout.rows} data-scale={layout.scale} style={gridStyle}>{cards}</div>
    </div>
  </div>;
}
