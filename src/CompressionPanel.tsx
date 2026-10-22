import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, PointerEvent, RefObject } from 'react';
import { ArrowDown, ArrowRight, Check, ChevronLeft, ChevronRight, CircleHelp, FolderOpen, ImagePlus, Layers3, LoaderCircle, Maximize2, Minus, Pause, Play, Plus, Scaling, ShieldCheck, SlidersHorizontal, Sparkles, X, ZoomIn } from 'lucide-react';
import type { Frame } from './types';
import { compressFrame, compressionResizeMode, compressionSettingsKey, compressionSourcesMatch, defaultCompressionSettings, formatCompressionBytes, importCompressionFiles, releaseCompressionFrames, snapshotCompressionFrames } from './lib/compression';
import type { CompressedFrame, CompressionAlgorithm, CompressionSettings, CompressionSourceFrame } from './lib/compression';
import ExportModes from './ExportModes';
import { exportPreviewFrames } from './lib/previewExport';
import type { PreviewExportMode } from './lib/previewExport';
import type { CompressionProjectHandle, CompressionProjectState } from './lib/projectPanelState';
import './compression.css';

interface Props {
  active: boolean;
  frames: Frame[];
  fps: number;
  animationName: string;
  /** Same sprite-sheet column selection used by the step 03 preview. */
  sheetColumns: number | 'auto';
  sheetRows?: number;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onNotify: (message: string) => void;
  handleRef?: RefObject<CompressionProjectHandle | null>;
  restoreState?: { key: number; state: CompressionProjectState } | null;
}
type Job = { kind: 'import' | 'generate' | 'export'; done: number; total: number; label: string };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
const algorithms = { lanczos: '保真 PNG', palette: '调色板量化', nearest: '保真 PNG' };

export default function CompressionPanel({ active, frames, fps, animationName, sheetColumns, sheetRows, disabled = false, onBusyChange, onNotify, handleRef, restoreState }: Props) {
  const [sources, setSources] = useState<CompressionSourceFrame[]>([]);
  const [results, setResults] = useState<CompressedFrame[]>([]);
  const [settings, setSettings] = useState<CompressionSettings>(defaultCompressionSettings);
  const [lastSettings, setLastSettings] = useState<CompressionSettings | null>(null);
  const [sourceLabel, setSourceLabel] = useState('');
  const [sourceMode, setSourceMode] = useState<'workbench' | 'local'>('workbench');
  const [frameRate, setFrameRate] = useState(clamp(fps, 1, 60));
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [zoom, setZoom] = useState(100);
  const [viewMode, setViewMode] = useState<'fit' | 'pixels'>('fit');
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [exportingSide, setExportingSide] = useState<'original' | 'processed' | null>(null);
  const inputsRef = useRef<CompressionSourceFrame[]>([]);
  const outputsRef = useRef<CompressedFrame[]>([]);
  const jobRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const jobVersionRef = useRef(0);
  const restoredKeyRef = useRef<number | null>(null);
  const restoredAtFpsRef = useRef<number | null>(null);
  const autoAttemptKeyRef = useRef<string | null>(null);
  const restoredWorkspaceRef = useRef<CompressionSourceFrame[] | null>(null);
  const mountedRef = useRef(true);
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const busy = !!job;
  const blocked = busy || disabled;
  const workspaceKey = useMemo(() => JSON.stringify(frames.map(frame => [frame.id, frame.url, frame.name, frame.sourceIndex, frame.time, frame.width, frame.height])), [frames]);
  const pendingRestore = !!restoreState && restoredKeyRef.current !== restoreState.key;
  const previewSources = sources.length ? sources : frames;
  const currentIndex = Math.min(index, Math.max(0, previewSources.length - 1));
  const original = previewSources[currentIndex];
  const processed = results[currentIndex];
  const inputBytes = sources.reduce((sum, frame) => sum + frame.blob.size, 0);
  const outputBytes = results.reduce((sum, frame) => sum + frame.blob.size, 0);
  const savings = inputBytes ? (1 - outputBytes / inputBytes) * 100 : 0;
  const dirty = results.length > 0 && !!lastSettings && compressionSettingsKey(lastSettings) !== compressionSettingsKey(settings);
  const mixedInputSizes = previewSources.some(frame => frame.width !== previewSources[0]?.width || frame.height !== previewSources[0]?.height);
  const mixedOutputSizes = results.some(frame => frame.width !== results[0]?.width || frame.height !== results[0]?.height);

  useImperativeHandle(handleRef, () => ({
    getSnapshot: () => ({
      settings: { ...settings }, lastSettings: lastSettings ? { ...lastSettings } : null,
      sourceLabel, sourceMode, fps: frameRate,
      sources: inputsRef.current.map(frame => ({ ...frame })),
      results: outputsRef.current.map(frame => ({ ...frame })),
    }),
  }), [settings, lastSettings, sourceLabel, sourceMode, frameRate]);

  useEffect(() => {
    if (!restoreState || restoredKeyRef.current === restoreState.key) return;
    restoredKeyRef.current = restoreState.key;
    restoredAtFpsRef.current = fps;
    // A restored project supersedes any in-flight import or CPU comparison.
    jobVersionRef.current++; abortRef.current?.abort(); abortRef.current = null; jobRef.current = false;
    setJob(null); setExportingSide(null); onBusyChange?.(false);
    const saved = restoreState.state;
    const mode = saved.sourceMode ?? (saved.sources.length && !saved.sourceLabel.startsWith('工作台') ? 'local' : 'workbench');
    setSourceMode(mode);
    autoAttemptKeyRef.current = null;
    const nextSources = saved.sources.map(frame => ({ ...frame }));
    // Validate against the final workspace frames after upstream restoration finishes.
    restoredWorkspaceRef.current = mode === 'workbench' && nextSources.length ? nextSources : null;
    const nextResults = saved.results.map(frame => ({ ...frame }));
    const retainedUrls = new Set([...nextSources, ...nextResults].map(frame => frame.url));
    releaseCompressionFrames([...inputsRef.current, ...outputsRef.current].filter(frame => !retainedUrls.has(frame.url)));
    inputsRef.current = nextSources; outputsRef.current = nextResults;
    setSources(nextSources); setResults(nextResults);
    setSettings({ ...saved.settings }); setLastSettings(saved.lastSettings ? { ...saved.lastSettings } : null);
    setSourceLabel(saved.sourceLabel); setFrameRate(clamp(saved.fps, 1, 60));
    setIndex(0); setPan({ x: 0, y: 0 }); setError('');
  }, [restoreState, onBusyChange, fps, frames, workspaceKey]);

  useEffect(() => {
    if (restoredAtFpsRef.current === fps) return;
    restoredAtFpsRef.current = null;
    if (sourceMode === 'workbench' || inputsRef.current.length === 0) setFrameRate(clamp(fps, 1, 60));
  }, [fps, sourceMode]);

  useEffect(() => {
    if (!active || !playing || previewSources.length < 2) return;
    const timer = window.setInterval(() => setIndex(value => (value + 1) % previewSources.length), 1000 / frameRate);
    return () => window.clearInterval(timer);
  }, [active, playing, previewSources.length, frameRate]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false; jobVersionRef.current++; abortRef.current?.abort(); jobRef.current = false;
      autoAttemptKeyRef.current = null;
      // Keep restored URLs alive when StrictMode replays effect setup and cleanup.
      queueMicrotask(() => {
        if (mountedRef.current) return;
        releaseCompressionFrames(inputsRef.current); releaseCompressionFrames(outputsRef.current);
        inputsRef.current = []; outputsRef.current = [];
      });
    };
  }, []);

  const update = <K extends keyof CompressionSettings>(key: K, value: CompressionSettings[K]) => setSettings(previous => ({ ...previous, [key]: value }));

  const runJob = useCallback(async (kind: Job['kind'], label: string, operation: (controller: AbortController) => Promise<void>) => {
    if (jobRef.current || disabled) return;
    jobRef.current = true; onBusyChange?.(true); setError(''); setJob({ kind, label, done: 0, total: 0 });
    const version = ++jobVersionRef.current;
    const controller = new AbortController(); abortRef.current = controller;
    try { await operation(controller); }
    catch (reason) {
      if (version !== jobVersionRef.current) return;
      if (controller.signal.aborted || (reason instanceof Error && reason.name === 'AbortError')) onNotify('已取消，保留上一次完成的对比结果。');
      else { const message = reason instanceof Error ? reason.message : '处理失败，请重试。'; setError(message); onNotify(message); }
    } finally {
      if (version === jobVersionRef.current) { abortRef.current = null; jobRef.current = false; setJob(null); setExportingSide(null); onBusyChange?.(false); }
    }
  }, [disabled, onBusyChange, onNotify]);

  useEffect(() => {
    if (!active || disabled || busy || pendingRestore || sourceMode !== 'workbench' || autoAttemptKeyRef.current === workspaceKey) return;
    autoAttemptKeyRef.current = workspaceKey;
    if (!frames.length) { restoredWorkspaceRef.current = null; replaceSources([], '工作台已选帧'); return; }
    const snapshot = [...frames];
    void runJob('import', '正在自动载入已选帧', async controller => {
      const restored = restoredWorkspaceRef.current;
      if (!restored) replaceSources([], '工作台已选帧');
      let next: CompressionSourceFrame[] | null = null;
      try {
        next = await snapshotCompressionFrames(snapshot, (done, total) => { if (!controller.signal.aborted) setJob({ kind: 'import', label: '正在自动载入已选帧', done, total }); }, controller.signal);
        const sameInputs = restored ? await compressionSourcesMatch(next, restored, controller.signal) : false;
        if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
        if (sameInputs) releaseCompressionFrames(next);
        else replaceSources(next, '工作台已选帧');
        next = null; restoredWorkspaceRef.current = null;
        setFrameRate(clamp(fps, 1, 60));
      } catch (reason) {
        if (next) releaseCompressionFrames(next);
        if (mountedRef.current && restored && inputsRef.current === restored) {
          restoredWorkspaceRef.current = null; replaceSources([], '工作台已选帧');
        }
        throw reason;
      }
    });
  }, [active, disabled, busy, pendingRestore, sourceMode, workspaceKey, frames, fps, runJob]);

  function replaceSources(next: CompressionSourceFrame[], label: string) {
    releaseCompressionFrames(inputsRef.current); releaseCompressionFrames(outputsRef.current);
    inputsRef.current = next; outputsRef.current = [];
    setSources(next); setResults([]); setLastSettings(null); setSourceLabel(label); setIndex(0); setPan({ x: 0, y: 0 });
  }

  async function useSelectedFrames() {
    if (!frames.length || jobRef.current || disabled) return;
    setSourceMode('workbench'); autoAttemptKeyRef.current = workspaceKey;
    restoredWorkspaceRef.current = null;
    const snapshot = [...frames];
    await runJob('import', '正在读取工作台帧', async controller => {
      const next = await snapshotCompressionFrames(snapshot, (done, total) => { if (!controller.signal.aborted) setJob({ kind: 'import', label: '正在读取工作台帧', done, total }); }, controller.signal);
      if (controller.signal.aborted) { releaseCompressionFrames(next); return; }
      replaceSources(next, '工作台已选帧'); setFrameRate(clamp(fps, 1, 60));
      onNotify(`已同步 ${next.length} 帧，后续选择会自动更新。`);
    });
  }

  async function importLocal(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []); event.target.value = '';
    if (!files.length) return;
    await runJob('import', '正在读取本地帧', async controller => {
      const next = await importCompressionFiles(files, frameRate, (done, total) => { if (!controller.signal.aborted) setJob({ kind: 'import', label: '正在读取本地帧', done, total }); }, controller.signal);
      if (controller.signal.aborted) { releaseCompressionFrames(next); return; }
      setSourceMode('local');
      restoredWorkspaceRef.current = null;
      replaceSources(next, files[0].webkitRelativePath ? files[0].webkitRelativePath.split('/')[0] : '本地动画帧');
      onNotify(`已按文件名顺序载入 ${next.length} 帧。`);
    });
  }

  async function generate() {
    if (!inputsRef.current.length && !frames.length) return;
    const requestedSettings = { ...settings };
    const parentSnapshot = [...frames];
    await runJob('generate', '正在生成精度对比', async controller => {
      let candidates: CompressionSourceFrame[] | null = null;
      const next: CompressedFrame[] = [];
      try {
        let input = inputsRef.current;
        if (!input.length) {
          candidates = await snapshotCompressionFrames(parentSnapshot, (done, total) => { if (!controller.signal.aborted) setJob({ kind: 'generate', label: '正在读取工作台帧', done, total }); }, controller.signal);
          input = candidates;
        }
        for (const [frameIndex, source] of input.entries()) {
          if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
          setJob({ kind: 'generate', label: '正在压缩动画帧', done: frameIndex, total: input.length });
          next.push(await compressFrame(source, requestedSettings, controller.signal));
        }
        if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
        if (candidates) { inputsRef.current = candidates; setSources(candidates); setSourceLabel('工作台已选帧'); candidates = null; }
        releaseCompressionFrames(outputsRef.current); outputsRef.current = next;
        setResults(next); setLastSettings(requestedSettings); setIndex(value => Math.min(value, next.length - 1));
        onNotify(`对比已生成，${next.length} 帧压缩结果可以检查与导出。`);
      } catch (reason) { releaseCompressionFrames(next); if (candidates) releaseCompressionFrames(candidates); throw reason; }
    });
  }

  async function exportResult(side: 'original' | 'processed', mode: PreviewExportMode) {
    const input = side === 'original' ? inputsRef.current.length ? inputsRef.current : frames : outputsRef.current;
    if (!input.length || jobRef.current || disabled) return;
    const snapshot = input.map(frame => ({ ...frame }));
    const labels = { frames: 'PNG 序列 ZIP', sprite_sheet: '精灵图与元数据 ZIP', mov: '透明 MOV', gif: 'GIF' };
    await runJob('export', `正在导出${side === 'original' ? '原始帧' : '压缩帧'} ${labels[mode]}`, async controller => {
      setExportingSide(side);
      const metadata = { variant: side === 'original' ? 'original' : 'compressed', settings: side === 'processed' ? lastSettings : null, inputBytes, inputFrames: inputsRef.current.map(frame => ({ name: frame.name, bytes: frame.blob.size, width: frame.width, height: frame.height })) };
      await exportPreviewFrames(snapshot, mode, animationName || 'animation', frameRate, { metadata, columns: sheetColumns, rows: sheetRows, signal: controller.signal });
      if (!controller.signal.aborted) onNotify(`${side === 'original' ? '原始帧' : '压缩帧'} ${labels[mode]} 已下载。`);
    });
  }

  const resetView = (mode: 'fit' | 'pixels' = viewMode) => { setViewMode(mode); setZoom(100); setPan({ x: 0, y: 0 }); };
  const dragStart = (event: PointerEvent<HTMLDivElement>) => { if (!previewSources.length) return; event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; };
  const dragMove = (event: PointerEvent<HTMLDivElement>) => { if (dragRef.current) setPan({ x: dragRef.current.panX + event.clientX - dragRef.current.x, y: dragRef.current.panY + event.clientY - dragRef.current.y }); };
  function imageStyle(width: number, height: number): CSSProperties {
    return viewMode === 'pixels' ? { width, height, maxWidth: 'none', transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoom / 100})`, left: '50%', top: '50%' } : { width: '100%', height: '100%', left: 0, top: 0, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})` };
  }

  return <div className="compression-panel" aria-label="动画帧精度压缩">
    <div className="card compression-source-bar"><span className="compression-source-icon"><Scaling size={20} /></span><div className="compression-source-copy"><strong>{sources.length ? `${sources.length} 帧已载入` : '把动画缩得更轻，细节留得更多'}</strong><p>{sources.length ? <>{sourceLabel}<span>·</span><span title={original?.name}>{original?.name}</span></> : <>选择工作台的帧，或导入一组本地动画帧。所有对比均使用真实输出。</>}</p></div><div className="compression-source-actions"><button className="button secondary small" disabled={blocked || !frames.length} onClick={() => void useSelectedFrames()}><Layers3 size={14} /> 使用已选帧 <span className="compression-count">{frames.length}</span></button><button className="button ghost small" disabled={blocked} onClick={() => filesRef.current?.click()}><ImagePlus size={14} /> 选择本地帧</button><button className="button ghost small" disabled={blocked} onClick={() => folderRef.current?.click()}><FolderOpen size={14} /> 选择文件夹</button></div></div>

    <div className="compression-layout"><aside className="card compression-settings"><div className="compression-panel-heading"><SlidersHorizontal size={15} /><h3>压缩参数</h3><span>QUALITY CONTROL</span></div>
      <div className="compression-field"><label htmlFor="compression-fps">播放帧率 <small>仅影响动画节奏</small></label><div className="compression-input-suffix"><input id="compression-fps" type="number" min={1} max={60} value={frameRate} disabled={blocked} onChange={event => setFrameRate(clamp(Math.round(+event.target.value || 1), 1, 60))} /><span>FPS</span></div></div>
      <div className="compression-field"><label htmlFor="compression-algorithm">PNG 编码</label><select id="compression-algorithm" value={settings.algorithm === 'palette' ? 'palette' : 'lanczos'} disabled={blocked} onChange={event => setSettings(previous => ({ ...previous, algorithm: event.target.value as CompressionAlgorithm, resizeMode: compressionResizeMode(previous) }))}><option value="lanczos">保真 PNG</option><option value="palette">调色板量化</option></select><p className="compression-field-hint">{settings.algorithm === 'palette' ? '真实 PNG 调色板量化，可独立搭配硬缩放或软缩放。' : '保留完整色彩与透明通道，缩放方式在下方选择。'}</p></div>
      <div className="compression-field"><div className="compression-field-row"><label htmlFor="compression-scale">缩放比例</label><div className="compression-scale-value"><input id="compression-scale-value" aria-label="缩放比例数值" type="number" min={.05} max={1} step={.05} value={settings.scale} disabled={blocked} onChange={event => update('scale', clamp(+event.target.value, .05, 1))} /><span>×</span></div></div><input id="compression-scale" aria-label="缩放比例" type="range" min={.05} max={1} step={.05} value={settings.scale} disabled={blocked} onChange={event => update('scale', +event.target.value)} /><div className="segmented compression-scale-presets">{[.25, .5, .75, 1].map(scale => <button key={scale} disabled={blocked} className={settings.scale === scale ? 'active' : ''} onClick={() => update('scale', scale)}>{scale === 1 ? '原尺寸' : `${scale * 100}%`}</button>)}</div></div>
      <div className="compression-field"><label id="compression-resize-label">缩放方式（二选一）</label><div className="segmented" role="group" aria-labelledby="compression-resize-label"><button className={compressionResizeMode(settings) === 'hard' ? 'active' : ''} aria-pressed={compressionResizeMode(settings) === 'hard'} disabled={blocked} onClick={() => update('resizeMode', 'hard')}>硬 · 最近邻</button><button className={compressionResizeMode(settings) === 'soft' ? 'active' : ''} aria-pressed={compressionResizeMode(settings) === 'soft'} disabled={blocked} onClick={() => update('resizeMode', 'soft')}>软 · Lanczos</button></div><p className="compression-field-hint">硬缩放保留像素边界；软缩放平滑轮廓与透明边缘。</p></div>
      <div className="compression-field"><div className="compression-field-row"><label htmlFor="compression-alpha">透明边缘阈值</label><span>{settings.alphaThreshold}</span></div><input id="compression-alpha" type="range" min={0} max={64} value={settings.alphaThreshold} disabled={blocked} onChange={event => update('alphaThreshold', +event.target.value)} /><p className="compression-field-hint">清理接近透明的像素，减少边缘杂点。</p></div>
      <div className="compression-field"><div className="compression-field-row"><label htmlFor="compression-sharpen">细节锐化</label><span>{settings.sharpen}%</span></div><input id="compression-sharpen" type="range" min={0} max={200} step={5} value={settings.sharpen} disabled={blocked} onChange={event => update('sharpen', +event.target.value)} /></div>
      <div className={`compression-field ${settings.algorithm !== 'palette' ? 'compression-field-disabled' : ''}`}><div className="compression-field-row"><label htmlFor="compression-colors">调色板颜色数</label><span>{settings.colors} 色</span></div><input id="compression-colors" type="range" min={2} max={256} value={settings.colors} disabled={blocked || settings.algorithm !== 'palette'} onChange={event => update('colors', +event.target.value)} /><p className="compression-field-hint">仅调色板量化生效，颜色越少，体积通常越小。</p></div>
      <button className="button primary wide compression-generate" disabled={blocked || (!sources.length && !frames.length)} onClick={() => void generate()}>{job?.kind === 'generate' ? <LoaderCircle className="spinner" size={15} /> : <Sparkles size={15} />}{job?.kind === 'generate' ? '正在生成对比…' : '生成对比'}{!job && <ArrowRight size={13} />}</button>
      <div className="compression-local-note"><ShieldCheck size={12} /><p>本机 CPU 处理，无需下载 AI 模型。修改参数后，点击生成更新结果。</p></div>
    </aside>

    <div className="compression-comparison"><div className="card compression-metrics" data-input-bytes={inputBytes} data-output-bytes={outputBytes} data-frame-count={previewSources.length}><div><span>动画帧数</span><strong>{previewSources.length || '—'}<small>{previewSources.length ? '帧' : ''}</small></strong></div><div><span>原始文件总体积</span><strong>{sources.length ? formatCompressionBytes(inputBytes) : '—'}</strong></div><div><span>压缩 PNG 总体积</span><strong className={results.length ? 'teal' : ''}>{results.length ? formatCompressionBytes(outputBytes) : '—'}</strong></div><div><span>{results.length && savings < 0 ? '体积增加' : '体积节省'}</span><strong className={results.length ? savings >= 0 ? 'teal' : 'amber' : ''}>{results.length ? `${Math.abs(savings).toFixed(1)}%` : '—'}{results.length > 0 && <ArrowDown size={12} style={savings < 0 ? { transform: 'rotate(180deg)' } : undefined} />}</strong></div></div>

      <div className="card compression-preview-card"><div className="compression-preview-toolbar"><div><h3>细节对比{dirty && <span className="compression-dirty">结果待更新</span>}{results.length > 0 && !dirty && <span className="compression-ready"><Check size={10} /> 已生成</span>}</h3><p>相同帧、同步缩放，放大检查轮廓与半透明边缘。</p></div><button className="button ghost small" onClick={() => setHelpOpen(value => !value)} aria-expanded={helpOpen}><CircleHelp size={13} /> 如何对比</button></div>
      {helpOpen && <div className="compression-help"><ZoomIn size={14} /><p>「同尺寸对比」会把两张图放到相同大小，方便比较细节；「1:1 像素」按真实像素显示。拖动任一画面会同步平移两侧，双击回到初始位置。</p></div>}
      <div className="compression-view-controls"><div className="segmented"><button className={viewMode === 'fit' ? 'active' : ''} aria-pressed={viewMode === 'fit'} onClick={() => resetView('fit')}>同尺寸对比</button><button className={viewMode === 'pixels' ? 'active' : ''} aria-pressed={viewMode === 'pixels'} onClick={() => resetView('pixels')}>1:1 像素</button></div><div className="compression-zoom-controls"><button className="icon-button" aria-label="对比图缩小" onClick={() => setZoom(value => clamp(value - 25, 25, 400))}><Minus size={12} /></button><input type="range" aria-label="对比缩放" min={25} max={400} step={25} value={zoom} onChange={event => setZoom(+event.target.value)} /><span>{zoom}%</span><button className="icon-button" aria-label="对比图放大" onClick={() => setZoom(value => clamp(value + 25, 25, 400))}><Plus size={12} /></button><button className="button ghost small" onClick={() => resetView()}><Maximize2 size={12} /> 归位</button></div></div>
      <div className="compression-preview-grid">{([{ type: 'original', title: '原始帧', subtitle: 'ORIGINAL', frame: original }, { type: 'processed', title: '压缩帧', subtitle: 'COMPRESSED', frame: processed }] as const).map(pane => {
        const bytes = pane.frame && 'blob' in pane.frame ? pane.frame.blob.size : undefined;
        return <div className="compression-preview-pane" data-kind={pane.type} key={pane.type}>
          <div className="compression-pane-heading"><span><i />{pane.title}<small>{pane.subtitle}</small></span><span>{pane.frame ? <>{pane.frame.width} × {pane.frame.height}{bytes !== undefined && <><span className="compression-heading-dot">·</span>{formatCompressionBytes(bytes)}</>}</> : '等待生成'}</span></div>
          <div className="compression-image-stage checker" data-frame-index={currentIndex} onPointerDown={dragStart} onPointerMove={dragMove} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }} onDoubleClick={() => resetView()}>{pane.frame ? <img className={pane.type === 'processed' ? 'compression-output-image' : 'compression-original-image'} src={pane.frame.url} alt={`${pane.title}：${pane.frame.name}`} draggable={false} data-bytes={bytes} style={imageStyle(pane.frame.width, pane.frame.height)} /> : <div className="compression-preview-empty"><Scaling size={29} strokeWidth={1.3} /><strong>{pane.type === 'original' ? '先载入一组动画帧' : '准备好，让细节说话'}</strong><p>{pane.type === 'original' ? '使用已选帧，或选择本地帧序列。' : '调整左侧参数，点击「生成对比」。'}</p></div>}<span className="compression-stage-label">{pane.subtitle}</span></div>
          <ExportModes id={`compression-${pane.type}-exports`} label={pane.title} status={pane.type === 'original' ? previewSources.length ? `${previewSources.length} 帧 · 原尺寸 · ${sources.length ? '已载入快照' : '工作台已选帧'}` : '尚未载入原始帧' : results.length ? `${results.length} 帧 · ${formatCompressionBytes(outputBytes)}${dirty ? ' · 上次结果，参数待更新' : ' · 已生成'}` : '生成压缩结果后可导出'} disabled={blocked || (pane.type === 'original' ? !previewSources.length : !results.length)} busy={job?.kind === 'export' && exportingSide === pane.type} onExport={mode => void exportResult(pane.type, mode)} />
        </div>;
      })}</div>
      <div className="compression-dimensions"><span><Scaling size={12} />{sources.length ? <>{sources[0].width} × {sources[0].height}{mixedInputSizes ? ' 等多种尺寸' : ''}<ArrowRight size={11} />{results.length ? <>{results[0].width} × {results[0].height}{mixedOutputSizes ? ' 等多种尺寸' : ''}</> : '等待生成'}</> : '载入后显示真实画布尺寸'}</span><span>{lastSettings && results.length ? <>{algorithms[lastSettings.algorithm]}<span className="compression-heading-dot">·</span>{compressionResizeMode(lastSettings) === 'hard' ? '硬缩放' : '软缩放'}<span className="compression-heading-dot">·</span>{Math.round(lastSettings.scale * 100)}%{lastSettings.algorithm === 'palette' ? ` · ${lastSettings.colors} 色` : ''}</> : '同步播放 · 同步缩放'}</span></div>
      <div className="compression-transport"><div className="compression-playback-buttons"><button className="icon-button" aria-label="压缩对比上一帧" disabled={!previewSources.length} onClick={() => { setPlaying(false); setIndex(value => (value - 1 + previewSources.length) % previewSources.length); }}><ChevronLeft size={14} /></button><button className="icon-button compression-play" aria-label={playing ? '暂停压缩对比动画' : '播放压缩对比动画'} disabled={previewSources.length < 2} onClick={() => setPlaying(value => !value)}>{playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}</button><button className="icon-button" aria-label="压缩对比下一帧" disabled={!previewSources.length} onClick={() => { setPlaying(false); setIndex(value => (value + 1) % previewSources.length); }}><ChevronRight size={14} /></button></div><span className="compression-frame-position">{previewSources.length ? String(currentIndex + 1).padStart(3, '0') : '000'}<small> / {String(previewSources.length).padStart(3, '0')}</small></span><input className="compression-frame-seek" type="range" aria-label="压缩对比当前帧" min={0} max={Math.max(1, previewSources.length - 1)} value={currentIndex} disabled={!previewSources.length} onChange={event => { setPlaying(false); setIndex(+event.target.value); }} /><span className="compression-fps-label">{frameRate} FPS</span></div>
      {previewSources.length > 0 && <div className="compression-filmstrip" aria-label="压缩对比帧序列">{previewSources.map((frame, frameIndex) => <button key={frame.id} className={`compression-thumbnail ${frameIndex === currentIndex ? 'active' : ''}`} aria-label={`查看第 ${frameIndex + 1} 帧 ${frame.name}`} title={frame.name} onClick={() => { setPlaying(false); setIndex(frameIndex); }}><img src={frame.url} alt="" loading="lazy" /><span>{String(frameIndex + 1).padStart(3, '0')}</span></button>)}</div>}
      </div>
    </div></div>

    {job && <div className="compression-job" role="status"><LoaderCircle className="compression-spinner" size={16} /><span>{job.label}{job.total > 0 && <strong>{job.done} / {job.total}</strong>}</span>{job.total > 0 && <progress max={job.total} value={job.done} />}{['import', 'generate'].includes(job.kind) && <button className="button ghost small" onClick={() => abortRef.current?.abort()}><X size={12} /> 取消</button>}</div>}
    {error && <div className="compression-error" role="alert"><CircleHelp size={14} /><p>{error}</p><button className="icon-button" aria-label="关闭压缩错误提示" onClick={() => setError('')}><X size={12} /></button></div>}

    <input ref={filesRef} className="compression-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/bmp,image/avif" multiple hidden onChange={event => void importLocal(event)} />
    <input ref={folderRef} className="compression-folder-input" type="file" {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)} multiple hidden onChange={event => void importLocal(event)} />
  </div>;
}
