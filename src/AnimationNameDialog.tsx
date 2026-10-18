import { useEffect, useId, useRef, useState } from 'react';
import { Film, X } from 'lucide-react';
import { safeName } from './lib/export';
import './animation-name-dialog.css';

interface Props {
  initialName: string;
  sourceName: string;
  onConfirm: (name: string) => void;
  onKeepOriginal: () => void;
}

export default function AnimationNameDialog({ initialName, sourceName, onConfirm, onKeepOriginal }: Props) {
  const [name, setName] = useState(initialName);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const inputId = useId();
  const previewId = useId();
  const valid = name.trim().length > 0;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  return <dialog
    ref={dialogRef}
    className="animation-name-dialog"
    aria-labelledby={titleId}
    aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); onKeepOriginal(); }}
    onKeyDown={event => event.stopPropagation()}
    onPaste={event => event.stopPropagation()}
    onDragOver={event => { event.preventDefault(); event.stopPropagation(); }}
    onDrop={event => { event.preventDefault(); event.stopPropagation(); }}
  >
    <button type="button" className="animation-name-close" aria-label="关闭命名窗口，使用原文件名" onClick={onKeepOriginal}><X size={18} /></button>
    <div className="animation-name-icon"><Film size={22} /></div>
    <h2 id={titleId}>为动画片段命名</h2>
    <p id={descriptionId} className="animation-name-description">这个名字将用于导出的压缩包。</p>
    <p className="animation-name-source" title={sourceName}>原视频：{sourceName}</p>
    <form onSubmit={event => {
      event.preventDefault();
      event.stopPropagation();
      if (!valid) { inputRef.current?.focus(); return; }
      onConfirm(name.trim());
    }}>
      <label htmlFor={inputId}>动画片段名</label>
      <input ref={inputRef} id={inputId} value={name} onChange={event => setName(event.target.value)} maxLength={80} required aria-describedby={previewId} placeholder="例如：角色_奔跑" autoComplete="off" />
      <div id={previewId} className="animation-name-preview"><span>导出文件</span><strong>{safeName(name.trim())}.zip</strong></div>
      <div className="animation-name-actions">
        <button type="button" className="button secondary" onClick={onKeepOriginal}>使用原文件名</button>
        <button type="submit" className="button primary" disabled={!valid}>确认名称</button>
      </div>
    </form>
  </dialog>;
}
