import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, Download, LoaderCircle } from 'lucide-react';
import type { PreviewExportMode } from './lib/previewExport';
import './export-modes.css';

interface Props {
  id?: string;
  label: string;
  status: ReactNode;
  disabled?: boolean;
  busy?: boolean;
  onExport: (mode: PreviewExportMode) => void;
}

const modes: { mode: PreviewExportMode; label: string }[] = [
  { mode: 'frames', label: 'Frames' }, { mode: 'sprite_sheet', label: 'Sprite Sheet' },
  { mode: 'mov', label: '透明 MOV' }, { mode: 'gif', label: 'GIF' },
];

export default function ExportModes({ id, label, status, disabled = false, busy = false, onExport }: Props) {
  const generatedId = useId();
  const panelId = id ?? `export-modes-${generatedId}`;
  const [open, setOpen] = useState(false);
  return <div className="preview-export" aria-label={`${label}导出`}>
    <div className="preview-export-summary"><span>{status}</span><button className="button ghost small preview-export-toggle" type="button" aria-label={`${label}导出`} aria-expanded={open} aria-controls={panelId} disabled={disabled || busy} onClick={() => setOpen(value => !value)}>{busy ? <LoaderCircle className="spinner" size={13} /> : <Download size={13} />}导出<ChevronDown size={12} className={open ? 'is-open' : ''} /></button></div>
    <div className="preview-export-options" id={panelId} hidden={!open} aria-label={`${label}导出模式`}>
      {modes.map(({ mode, label: modeLabel }) => <button className="button secondary small" key={mode} type="button" data-export-mode={mode} disabled={disabled || busy} onClick={() => onExport(mode)}>{modeLabel}</button>)}
    </div>
  </div>;
}
