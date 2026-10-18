import { CircleHelp, Trash2 } from 'lucide-react';
import type { MediaSource } from './types';
import './source-header.css';

export default function SourceHeader({ source, disabled, onClear, onHelp }: {
  source: MediaSource | null;
  disabled: boolean;
  onClear: () => void;
  onHelp: () => void;
}) {
  const name = source?.name.replace(/^内置示例 · /, '') || '未导入';
  return <header className="source-header">
    <div className="source-header-brand">
      <a href="#" aria-label="帧间首页">
        <svg className="source-header-logo" viewBox="0 0 40 40" aria-hidden="true"><rect x="3" y="3" width="34" height="34" rx="7" fill="#fffef8" stroke="currentColor" strokeWidth="2.5" /><path d="M10 30 29 11" stroke="currentColor" strokeWidth="8" /><circle cx="12" cy="27" r="7" fill="#ff3554" /><circle cx="27" cy="12" r="6" fill="#168b65" /></svg>
        <span><small>SPRITE VIDEO LAB</small><strong>Sprite 资产处理台</strong></span>
      </a>
      <button className="source-header-clear" type="button" aria-label="清空当前素材" title="清空当前素材和帧列表；已保存工程保留" disabled={disabled || !source} onClick={onClear}><Trash2 size={17} /></button>
    </div>
    <dl className="source-header-strip" aria-label="当前素材状态">
      <div className="source-header-file"><dt>素材</dt><dd title={name}>{name}</dd></div>
      <div><dt>尺寸</dt><dd>{source ? `${source.width} × ${source.height}` : '—'}</dd></div>
      <div><dt>帧率</dt><dd>{source ? `${source.fps.toFixed(2)} fps` : '—'}</dd></div>
      <div><dt>时长</dt><dd>{source ? `${source.duration.toFixed(2)}s` : '—'}</dd></div>
    </dl>
    <button className="source-header-help" type="button" aria-label="使用指南" title="使用指南" onClick={onHelp}><CircleHelp size={18} /></button>
  </header>;
}
