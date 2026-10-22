import { useState } from 'react';

type Props = { index: number; count: number; onPause: () => void; onSeek: (index: number) => void };

export default function ReviewProgress({ index, count, onPause, onSeek }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const current = count ? Math.min(index + 1, count) : 0;
  const seek = (value: number) => {
    if (!count || !Number.isFinite(value)) return;
    onSeek(Math.min(count, Math.max(1, Math.trunc(value))) - 1);
  };
  return <div className="review-progress">
    <input type="range" aria-label="动画预览进度" min={count ? 1 : 0} max={count || 1} step={1} value={current} disabled={!count}
      onChange={event => seek(+event.target.value)} />
    <label className="review-progress-counter">
      <input type="number" aria-label="动画预览当前帧" min={count ? 1 : 0} max={count || 1} step={1} disabled={!count}
        value={count ? draft ?? current : 0}
        onFocus={() => { onPause(); setDraft(String(current)); }}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => { if (draft?.trim()) seek(Number(draft)); setDraft(null); }}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === 'Escape') { event.preventDefault(); setDraft(null); }
        }} />
      <span>/ {String(count).padStart(3, '0')}</span>
    </label>
  </div>;
}
