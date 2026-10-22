import { useEffect, useRef } from 'react';
import type { HTMLAttributes } from 'react';

type Props = HTMLAttributes<HTMLDivElement> & {
  disabled: boolean;
  onToggle: () => void;
  onInspect: () => void;
};

export default function ReviewFrameCard({ disabled, onToggle, onInspect, children, ...props }: Props) {
  const pendingClick = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClick = () => {
    if (pendingClick.current !== null) clearTimeout(pendingClick.current);
    pendingClick.current = null;
  };
  useEffect(() => cancelClick, [disabled]);

  return <div {...props}
    onClick={event => {
      if (disabled || (event.target as HTMLElement).closest('input,label')) return;
      cancelClick();
      if (event.detail === 0) { onToggle(); return; }
      // Wait for the second click so inspection does not alter the selection.
      if (event.detail === 1) pendingClick.current = setTimeout(() => { pendingClick.current = null; onToggle(); }, 300);
    }}
    onDoubleClick={event => {
      if ((event.target as HTMLElement).closest('input,label')) return;
      cancelClick(); onInspect();
    }}
    onDragStart={event => { cancelClick(); props.onDragStart?.(event); }}
  >{children}</div>;
}
