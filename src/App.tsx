import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCheck, ChevronLeft, ChevronRight, Download, Film, FolderOpen, Frame as FrameIcon, GripVertical, ImagePlus, Layers3, LoaderCircle, Maximize2, Minimize2, Minus, MousePointer2, Pause, Play, RefreshCw, RotateCcw, Save, Scissors, ShieldCheck, SlidersHorizontal, Sparkles, Square, Upload, WandSparkles, X, ZoomIn } from 'lucide-react';
import type { Frame, MediaSource, ProcessOptions } from './types';
import { defaultOptions } from './types';
import { canvasToBlob, captureFrame, estimateFrames, extractFrames, loadMedia, releaseMedia } from './lib/media';
import { loadBuiltInExample } from './lib/builtInExample';
import { downloadBlob } from './lib/export';
import { getBackendHealth, prepareModels, processFrame } from './lib/ai';
import type { BackendHealth } from './lib/ai';
import AiControls, { BackgroundCleanupControls, WatermarkRemovalControl } from './AiControls';
import TunerPanel from './TunerPanel';
import CompressionPanel from './CompressionPanel';
import AnimationNameDialog from './AnimationNameDialog';
import SourceHeader from './SourceHeader';
import TaskSummary from './TaskSummary';
import SheetLayoutControls from './SheetLayoutControls';
import FittedFrameGrid from './FittedFrameGrid';
import ReviewFrameCard from './ReviewFrameCard';
import ReviewProgress from './ReviewProgress';
import SmoothingPanel from './SmoothingPanel';
import { smoothingFrameSignature, smoothingSettingsKey } from './lib/smoothing';
import { extractionTaskInfo, importedTaskInfo } from './lib/taskInfo';
import type { ProcessingTaskInfo } from './lib/taskInfo';
import ProjectLibrary from './ProjectLibrary';
import { browseProjectDirectory, loadProject, releaseLoadedProject, restoreProcessOptions, saveProject } from './lib/projects';
import type { ProjectSnapshot } from './lib/projects';
import type { CompressionProjectHandle, CompressionProjectState, SmoothingProjectHandle, SmoothingProjectState } from './lib/projectPanelState';
import { defaultCompressionSettings } from './lib/compression';
import { moveFrame, syncSequenceInputs } from './lib/frameSequence';
import { createMattingStage, extractionOptions, frameMattingOptions, mattingInputKey, resolveMattingStage } from './lib/framePipeline';
import type { MattingStage } from './lib/framePipeline';
import { editSheetLayout, resolveSheetLayout } from './lib/sheetLayout';
import './workspace-tabs.css';
import './review-layout.css';

type Background = 'checker' | 'dark' | 'white' | 'rose';
type AnimationImportOptions = { targetStep?: number; fps?: number; name?: string; newProject?: boolean; append?: boolean; processed?: boolean };
const steps = [
  { title: '预览与截取', subtitle: '选定精彩区间', icon: Scissors },
  { title: '抽帧设置', subtitle: '控制密度与尺寸', icon: Film },
  { title: '检查与布局', subtitle: '挑选每一帧', icon: CheckCheck },
  { title: '精细抠图', subtitle: '留下干净的主体', icon: WandSparkles },
  { title: '动画预览', subtitle: '让帧序列动起来', icon: Play },
  { title: 'Real-ESRGAN 平滑', subtitle: '放大再缩回，修整画面', icon: WandSparkles },
  { title: '精度压缩', subtitle: '缩小体积，保留细节', icon: Minimize2 },
];
const pad = (n: number, count = 3) => String(n).padStart(count, '0');
const time = (seconds: number) => `${pad(Math.floor(seconds / 60), 2)}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
const frameTime = (frame: number, fps: number) => (frame - 1) / fps;
// Chromium rounds media timestamps to microseconds; tolerate that rounding at frame boundaries.
const frameAtTime = (seconds: number, fps: number) => Math.floor(seconds * fps + 1e-3) + 1;

function transferFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.files.length) return Array.from(data.files);
  return Array.from(data.items).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => file !== null);
}

function isFileTransfer(data: DataTransfer | null): boolean {
  return !!data && (Array.from(data.types).includes('Files') || Array.from(data.items).some(item => item.kind === 'file'));
}

function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(file.name);
}

function SectionHeading({ number, title, children, actions }: { number: number; title: string; children: ReactNode; actions?: ReactNode }) {
  return <div className="section-heading"><span className="section-number">{pad(number, 2)}</span><div className="section-title"><h2>{title}</h2><p>{children}</p></div><div className="section-actions">{actions}</div></div>;
}

function PreviewPane({ title, url, background = 'checker', children }: { title: string; url: string; background?: Background; children?: ReactNode }) {
  const [zoom, setZoom] = useState(100);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  return <div className="comparison-pane"><div className="pane-heading"><span>{title}</span>{children}</div><div className={`image-viewport ${background}`} style={{ cursor: zoom > 100 ? 'grab' : 'default', touchAction: 'none' }} onPointerDown={event => { if (zoom <= 100) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; }} onPointerMove={event => { if (drag.current) setPan({ x: drag.current.panX + event.clientX - drag.current.x, y: drag.current.panY + event.clientY - drag.current.y }); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
    {url ? <img key={`${title}-${url}`} className="image-content" src={url} alt={title} draggable={false} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})` }} /> : <div className="empty-state"><WandSparkles size={28} /><p>点击「预览当前帧」查看效果</p></div>}
    <span className="viewport-label">{title === '原始帧' ? 'SOURCE' : 'ALPHA PREVIEW'}</span>
  </div><div className="zoom-controls"><button className="icon-button" aria-label={`${title}缩小`} onClick={() => setZoom(value => Math.max(25, value - 25))}><Minus size={14} /></button><input aria-label={`${title}缩放`} type="range" min="25" max="400" step="25" value={zoom} onChange={e => setZoom(+e.target.value)} /><span>{zoom}%</span><button className="button ghost small" onClick={() => { setZoom(100); setPan({ x: 0, y: 0 }); }}><Maximize2 size={13} /> 适应</button></div></div>;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'workbench' | 'tuner'>(() => window.location.hash === '#tuner' ? 'tuner' : 'workbench');
  const [tunerImportRequest, setTunerImportRequest] = useState(0);
  const [tunerBusy, setTunerBusy] = useState(false);
  const [compressionBusy, setCompressionBusy] = useState(false);
  const [smoothingBusy, setSmoothingBusy] = useState(false);
  const [smoothingEnabled, setSmoothingEnabled] = useState(false);
  const [smoothedSequence, setSmoothedSequence] = useState<{ frames: Frame[]; key: string } | null>(null);
  const [taskInfo, setTaskInfo] = useState<ProcessingTaskInfo | null>(null);
  const [source, setSource] = useState<MediaSource | null>(null);
  const [sequenceMode, setSequenceMode] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [projectDirectory, setProjectDirectory] = useState(() => {
    try { return localStorage.getItem('framecraft-project-directory') || 'FrameAnimProjectList'; } catch { return 'FrameAnimProjectList'; }
  });
  const [projectBusy, setProjectBusy] = useState<'save' | 'open' | 'browse' | null>(null);
  const [projectRefresh, setProjectRefresh] = useState(0);
  const [lastSavedProject, setLastSavedProject] = useState('');
  const [panelRestore, setPanelRestore] = useState<{ key: number; compression: CompressionProjectState | null; smoothing: SmoothingProjectState | null } | null>(null);
  const [start, setStart] = useState(1);
  const [end, setEnd] = useState(48);
  const [cursor, setCursor] = useState(1);
  const [stride, setStride] = useState(4);
  const [options, setOptions] = useState<ProcessOptions>(() => {
    try { return restoreProcessOptions(JSON.parse(localStorage.getItem('framecraft-options') || '{}')); } catch { return defaultOptions; }
  });
  const [frames, setFrames] = useState<Frame[]>([]);
  const [mattingStage, setMattingStage] = useState<MattingStage | null>(null);
  const [rawPreview, setRawPreview] = useState('');
  const [cleanPreview, setCleanPreview] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [backend, setBackend] = useState<BackendHealth | null>(null);
  const [preparingModel, setPreparingModel] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [importing, setImporting] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [background, setBackground] = useState<Background>('checker');
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [animIndex, setAnimIndex] = useState(0);
  const [animFps, setAnimFps] = useState(12);
  const [loopMode, setLoopMode] = useState<'loop' | 'pingpong' | 'once'>('loop');
  const [animationName, setAnimationName] = useState('character_idle');
  const [pendingClipName, setPendingClipName] = useState<{ initialName: string; sourceName: string; newProject?: boolean } | null>(null);
  const [frameImportDropActive, setFrameImportDropActive] = useState(false);
  // Older projects can still request automatic columns until manually edited.
  const [sheetColumns, setSheetColumns] = useState<number | 'auto'>('auto');
  const [sheetRows, setSheetRows] = useState<number | undefined>();
  const [toast, setToast] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [importDropActive, setImportDropActive] = useState(false);
  const [draggedFrame, setDraggedFrame] = useState<string | null>(null);
  const draggedFrameRef = useRef<string | null>(null);
  const [dropTargetFrame, setDropTargetFrame] = useState<string | null>(null);
  const [inspectedFrame, setInspectedFrame] = useState<Frame | null>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const frameInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bootstrapAbort = useRef<AbortController | null>(null);
  const sourceRef = useRef<MediaSource | null>(null);
  const framesRef = useRef<Frame[]>([]);
  const mattingStageRef = useRef<MattingStage | null>(null);
  const sequenceInputsRef = useRef<Frame[]>([]);
  const previewUrls = useRef<string[]>([]);
  const manualPreviewAbort = useRef<AbortController | null>(null);
  const directionRef = useRef(1);
  const importInFlight = useRef(false);
  const projectOperation = useRef(false);
  const projectAbort = useRef<AbortController | null>(null);
  const projectRestoreKey = useRef(0);
  const compressionProjectRef = useRef<CompressionProjectHandle | null>(null);
  const smoothingProjectRef = useRef<SmoothingProjectHandle | null>(null);
  const selectedFrames = useMemo(() => frames.filter(frame => frame.selected), [frames]);
  const mattingOutput = useMemo(() => resolveMattingStage(frames, options, mattingStage), [frames, options, mattingStage]);
  const animationFrames = mattingOutput.frames;
  const smoothingInputKey = `${smoothingFrameSignature(animationFrames)}|${smoothingSettingsKey(options)}`;
  const smoothingInputKeyRef = useRef(smoothingInputKey);
  smoothingInputKeyRef.current = smoothingInputKey;
  const smoothingReady = smoothingEnabled && smoothedSequence?.key === smoothingInputKey;
  const outputFrames = smoothingReady ? smoothedSequence.frames : animationFrames;
  const displayFrames = frames;
  const reviewLayout = resolveSheetLayout(displayFrames.length, sheetColumns, sheetRows);
  // Keep the visual review compact when the export layout reserves empty rows.
  // Export still uses reviewLayout.rows; this only controls the on-screen card fit.
  const reviewDisplayRows = Math.max(1, Math.ceil(displayFrames.length / reviewLayout.columns));
  const reviewCellWidth = Math.max(1, ...displayFrames.map(frame => frame.width));
  const reviewCellHeight = Math.max(1, ...displayFrames.map(frame => frame.height));
  const smoothingPending = smoothingEnabled && animationFrames.length > 0 && !smoothingReady;
  const derivedExportBlocked = mattingOutput.pending || smoothingBusy || smoothingPending;
  const currentAnimationFrame = animationFrames[Math.min(animIndex, Math.max(0, animationFrames.length - 1))];
  const currentReviewFrame = selectedFrames[Math.min(animIndex, Math.max(0, selectedFrames.length - 1))];
  const totalFrames = source?.totalFrames ?? 1;
  const selectedCount = sequenceMode ? sequenceInputsRef.current.filter(frame => frame.selected).length : end - start + 1;
  const outputCount = sequenceMode ? estimateFrames(1, selectedCount, stride) : estimateFrames(start, end, stride);
  const isAi = options.engine && options.engine !== 'chroma' && options.engine !== 'luma';
  const mediaImportLocked = !!projectBusy || !!pendingClipName || processing || importing || tunerBusy || compressionBusy || smoothingBusy;
  const rangeCaptureDisabled = !source || source.kind === 'image' || mediaImportLocked;

  const notify = useCallback((message: string) => setToast(message), []);
  const replaceMattingStage = useCallback((next: MattingStage | null) => {
    const retained = new Set(next?.ownedUrls ?? []);
    mattingStageRef.current?.ownedUrls.forEach(url => { if (!retained.has(url)) URL.revokeObjectURL(url); });
    mattingStageRef.current = next; setMattingStage(next);
  }, []);
  useEffect(() => {
    if (mattingStage && mattingStage.inputKey !== mattingInputKey(frames)) replaceMattingStage(null);
  }, [frames, mattingStage, replaceMattingStage]);
  const onSmoothingResult = useCallback((next: Frame[] | null) => {
    setInspectedFrame(null);
    setSmoothedSequence(next ? { frames: next, key: smoothingInputKeyRef.current } : null);
  }, []);
  const updateOption = <K extends keyof ProcessOptions>(key: K, value: ProcessOptions[K]) => { manualPreviewAbort.current?.abort(); setOptions(previous => ({ ...previous, [key]: value })); };
  const goTo = useCallback((index: number) => {
    setActiveTab('workbench');
    window.history.replaceState(null, '', '#workbench');
    setActiveStep(index);
    const scrollWhenVisible = () => {
      const target = document.getElementById(`step-${index + 1}`);
      if (!target) return;
      if (target.closest('[hidden]')) { requestAnimationFrame(scrollWhenVisible); return; }
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    requestAnimationFrame(scrollWhenVisible);
  }, []);
  const changeTab = useCallback((tab: 'workbench' | 'tuner') => {
    setActiveTab(tab);
    window.history.replaceState(null, '', tab === 'tuner' ? '#tuner' : '#workbench');
    if (tab === 'tuner') { setPreviewPlaying(false); setPlaying(false); }
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);
  const sendToTuner = () => {
    if (!outputFrames.length || mediaImportLocked || derivedExportBlocked) return;
    setTunerImportRequest(value => value + 1);
    changeTab('tuner');
  };

  useEffect(() => {
    const onHashChange = () => {
      if (window.location.hash === '#tuner') { setActiveTab('tuner'); setPreviewPlaying(false); setPlaying(false); }
      else if (window.location.hash === '#workbench') setActiveTab('workbench');
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => { sourceRef.current = source; }, [source]);
  useEffect(() => () => { manualPreviewAbort.current?.abort(); }, [source, cursor]);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    void getBackendHealth(controller.signal).then(setBackend).catch(() => setBackend(null)).finally(() => clearTimeout(timeout));
    return () => { controller.abort(); clearTimeout(timeout); };
  }, []);
  useEffect(() => { framesRef.current = frames; }, [frames]);
  useEffect(() => { try { localStorage.setItem('framecraft-project-directory', projectDirectory); } catch { /* Storage may be disabled. */ } }, [projectDirectory]);
  useEffect(() => { try { localStorage.setItem('framecraft-options', JSON.stringify(options)); } catch { /* Private browsing may disable storage. */ } }, [options]);
  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToast(''), 4500); return () => window.clearTimeout(timeout); }, [toast]);
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    bootstrapAbort.current = controller;
    (async () => {
      try {
        const example = await loadBuiltInExample(controller.signal);
        if (disposed || controller.signal.aborted) {
          releaseMedia(example.source); URL.revokeObjectURL(example.source.url);
          return;
        }
        setSource(example.source); setStart(1); setEnd(example.source.totalFrames); setCursor(1);
        setAnimationName(example.animationName); setAnimFps(example.fps);
        setFrames(example.frames);
        replaceMattingStage(createMattingStage(example.frames, options, example.frames));
        setTaskInfo(importedTaskInfo('example'));
      } catch (error) { if (!disposed && !controller.signal.aborted) notify(error instanceof Error ? error.message : '内置示例加载失败，请导入自己的素材。'); }
      finally { if (!disposed) setBootstrapping(false); }
    })();
    return () => { disposed = true; controller.abort(); };
  }, [notify]);
  useEffect(() => () => {
    abortRef.current?.abort();
    projectAbort.current?.abort();
    framesRef.current.forEach(frame => URL.revokeObjectURL(frame.url));
    mattingStageRef.current?.ownedUrls.forEach(url => URL.revokeObjectURL(url));
    sequenceInputsRef.current.forEach(frame => URL.revokeObjectURL(frame.url));
    previewUrls.current.forEach(url => URL.revokeObjectURL(url));
    if (sourceRef.current) { releaseMedia(sourceRef.current); if (sourceRef.current.url.startsWith('blob:')) URL.revokeObjectURL(sourceRef.current.url); }
  }, []);
  useEffect(() => {
    const sections = Array.from(document.querySelectorAll('.workspace-section'));
    const observer = new IntersectionObserver(() => {
      // Entries contain only changed intersections; choose from all visible steps.
      const visible = sections.filter(section => {
        const bounds = section.getBoundingClientRect();
        return bounds.bottom > 150 && bounds.top < window.innerHeight * .55;
      });
      if (visible[0]) setActiveStep(Number(visible[0].id.slice(-1)) - 1);
    }, { rootMargin: '-150px 0px -45% 0px', threshold: [0, .15, .4] });
    sections.forEach(section => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  const refreshPreview = useCallback(async (media: MediaSource, index: number, settings: ProcessOptions, signal?: AbortSignal, rawOnly = false) => {
    const canvas = await captureFrame(media, index, signal);
    if (signal?.aborted) return;
    const processed = rawOnly ? null : await processFrame(canvas, settings, signal, true);
    const [raw, clean] = await Promise.all([canvasToBlob(canvas), processed ? canvasToBlob(processed) : Promise.resolve(null)]);
    if (signal?.aborted) return;
    const urls = [URL.createObjectURL(raw), ...(clean ? [URL.createObjectURL(clean)] : [])];
    previewUrls.current.forEach(url => URL.revokeObjectURL(url));
    previewUrls.current = urls;
    setRawPreview(urls[0]); setCleanPreview(urls[1] || '');
  }, []);
  const previewSequenceFrame = currentReviewFrame;
  const capturePreviewFrame = useCallback((media: MediaSource, index: number, signal?: AbortSignal) => {
    if (!previewSequenceFrame) return captureFrame(media, index, signal);
    const frame = previewSequenceFrame;
    return captureFrame({ kind: 'image', name: frame.name, url: frame.url, width: frame.width, height: frame.height, fps: animFps, duration: 1 / animFps, totalFrames: 1 }, 1, signal);
  }, [sequenceMode, previewSequenceFrame, animFps]);
  const previewSource = previewSequenceFrame ? { kind: 'image' as const, name: previewSequenceFrame.name, url: previewSequenceFrame.url, width: previewSequenceFrame.width, height: previewSequenceFrame.height, fps: animFps, duration: 1 / animFps, totalFrames: 1 } : null;
  useEffect(() => {
    setCleanPreview('');
    return () => { manualPreviewAbort.current?.abort(); };
  }, [previewSequenceFrame?.url, options]);
  useEffect(() => {
    if (!previewSource || processing || previewPlaying || playing || (isAi && options.removeBackground)) { setPreviewBusy(false); return; }
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setPreviewBusy(true);
      try { await refreshPreview(previewSource, 1, frameMattingOptions(previewSource, options), controller.signal, !!isAi && options.removeBackground); }
      catch (error) { if (!controller.signal.aborted) notify(error instanceof Error ? error.message : '无法预览当前帧'); }
      finally { if (!controller.signal.aborted) setPreviewBusy(false); }
    }, 220);
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, [source, previewSequenceFrame, sequenceMode, playing, cursor, options, processing, previewPlaying, refreshPreview, notify, isAi]);
  useEffect(() => {
    if (!previewPlaying || !source || source.kind === 'video') return;
    const timer = window.setInterval(() => setCursor(value => value >= end ? start : value + 1), 1000 / source.fps);
    return () => window.clearInterval(timer);
  }, [previewPlaying, source, start, end]);
  useEffect(() => { if (source?.kind !== 'video') return; const video = videoRef.current; if (!video) return; if (previewPlaying) void video.play().catch(() => setPreviewPlaying(false)); else video.pause(); }, [previewPlaying, source]);
  useEffect(() => {
    if (!previewPlaying || source?.kind !== 'video') return;
    let request = 0;
    const enforceRange = () => {
      const video = videoRef.current;
      if (video && !video.seeking && (video.currentTime >= end / source.fps - 0.0005 || video.currentTime < frameTime(start, source.fps))) video.currentTime = frameTime(start, source.fps);
      request = requestAnimationFrame(enforceRange);
    };
    request = requestAnimationFrame(enforceRange);
    return () => cancelAnimationFrame(request);
  }, [previewPlaying, source, start, end]);
  useEffect(() => {
    directionRef.current = 1;
    setAnimIndex(value => Math.min(value, Math.max(0, selectedFrames.length - 1)));
  }, [selectedFrames.length, loopMode]);
  useEffect(() => {
    if (!playing || selectedFrames.length < 2) return;
    const timer = window.setInterval(() => setAnimIndex(previous => {
      if (loopMode === 'pingpong') { if (previous >= selectedFrames.length - 1) directionRef.current = -1; if (previous <= 0) directionRef.current = 1; return previous + directionRef.current; }
      if (previous >= selectedFrames.length - 1) { if (loopMode === 'once') { setPlaying(false); return previous; } return 0; }
      return previous + 1;
    }), 1000 / animFps);
    return () => window.clearInterval(timer);
  }, [playing, selectedFrames.length, animFps, loopMode]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (activeTab !== 'workbench' || pendingClipName) return;
      if (event.key === 'Escape') { setHelpOpen(false); setInspectedFrame(null); }
      if ((event.target as HTMLElement).closest('input,select,textarea,button') || helpOpen || inspectedFrame) return;
      if (event.code === 'Space') { event.preventDefault(); if (!playing && loopMode === 'once' && animIndex >= selectedFrames.length - 1) setAnimIndex(0); setPlaying(value => !value); }
      if (event.key === 'ArrowRight') { setPlaying(false); setAnimIndex(value => Math.min(selectedFrames.length - 1, value + 1)); }
      if (event.key === 'ArrowLeft') { setPlaying(false); setAnimIndex(value => Math.max(0, value - 1)); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [selectedFrames.length, helpOpen, inspectedFrame, pendingClipName, playing, loopMode, animIndex, activeTab]);

  const replaceFrames = useCallback((next: Frame[]) => {
    const retained = new Set([...sequenceInputsRef.current, ...next].map(frame => frame.url));
    framesRef.current.forEach(frame => { if (!retained.has(frame.url)) { releaseMedia({ kind: 'image', name: frame.name, url: frame.url, width: frame.width, height: frame.height, fps: 12, duration: 1 / 12, totalFrames: 1 }); URL.revokeObjectURL(frame.url); } });
    framesRef.current = next; setFrames(next); setAnimIndex(0);
  }, []);

  const replaceSequenceInputs = (next: Frame[]) => {
    const retained = new Set([...framesRef.current, ...next].map(frame => frame.url));
    sequenceInputsRef.current.forEach(frame => { if (!retained.has(frame.url)) URL.revokeObjectURL(frame.url); });
    sequenceInputsRef.current = next;
  };
  const updateFrames = (edit: (previous: Frame[]) => Frame[]) => {
    const next = edit(framesRef.current);
    if (sequenceMode) sequenceInputsRef.current = syncSequenceInputs(sequenceInputsRef.current, next);
    framesRef.current = next; setFrames(next);
  };

  const chooseProjectDirectory = async () => {
    if (projectOperation.current || mediaImportLocked) return;
    projectOperation.current = true; setProjectBusy('browse');
    try {
      const directory = await browseProjectDirectory(projectDirectory);
      if (directory) { setProjectDirectory(directory); setLastSavedProject(''); setProjectRefresh(value => value + 1); }
    } catch (error) { notify(error instanceof Error ? error.message : '无法选择目录，也可以在页面顶部直接输入路径。'); }
    finally { projectOperation.current = false; setProjectBusy(null); }
  };

  const addProject = async () => {
    if (projectOperation.current || mediaImportLocked || bootstrapping) return;
    projectOperation.current = true; setProjectBusy('save');
    const controller = new AbortController(); projectAbort.current = controller;
    const snapshot: ProjectSnapshot = {
      name: animationName.trim() || 'animation', fps: animFps, source, frames: frames.map(frame => ({ ...frame })),
      sequenceInputs: sequenceMode ? sequenceInputsRef.current.map(frame => ({ ...frame })) : undefined,
      workspace: { options: { ...options }, start, end, cursor, stride, loopMode, sheetColumns: reviewLayout.columns, sheetRows: reviewLayout.rows, background, sequenceMode, taskInfo: taskInfo ?? undefined },
      compression: compressionProjectRef.current?.getSnapshot() ?? null,
      smoothing: smoothingProjectRef.current?.getSnapshot() ?? null,
      matting: { options: mattingStage?.options ?? { ...options }, frames: mattingOutput.pending ? null : mattingStage?.frames ?? null },
    };
    try {
      const saved = await saveProject(projectDirectory, snapshot, controller.signal);
      if (controller.signal.aborted) return;
      setLastSavedProject(saved.path); setProjectRefresh(value => value + 1);
      notify(`已将「${snapshot.name}」添加到帧动画项目列表。`);
    } catch (error) { if (!controller.signal.aborted) notify(error instanceof Error ? error.message : '保存项目失败，请检查目录是否可写。'); }
    finally { if (projectAbort.current === controller) projectAbort.current = null; projectOperation.current = false; setProjectBusy(null); }
  };

  const openSavedProject = async (id: string) => {
    if (projectOperation.current || mediaImportLocked || bootstrapping) return;
    projectOperation.current = true; setProjectBusy('open');
    bootstrapAbort.current?.abort(); manualPreviewAbort.current?.abort();
    setPreviewPlaying(false); setPlaying(false);
    const controller = new AbortController(); projectAbort.current = controller;
    let loaded: ProjectSnapshot | null = null;
    try {
      loaded = await loadProject(projectDirectory, id, controller.signal);
      if (controller.signal.aborted) { releaseLoadedProject(loaded); return; }
      const oldSource = sourceRef.current;
      if (oldSource) { releaseMedia(oldSource); if (oldSource.url.startsWith('blob:')) URL.revokeObjectURL(oldSource.url); }
      previewUrls.current.forEach(url => URL.revokeObjectURL(url)); previewUrls.current = [];
      setRawPreview(''); setCleanPreview(''); setInspectedFrame(null); setSmoothedSequence(null);
      replaceSequenceInputs(loaded.sequenceInputs ?? (loaded.workspace.sequenceMode ? loaded.frames : []));
      sourceRef.current = loaded.source; setSource(loaded.source); replaceFrames(loaded.frames);
      replaceMattingStage(loaded.matting ? loaded.matting.frames ? createMattingStage(loaded.frames, loaded.matting.options, loaded.matting.frames) : null : createMattingStage(loaded.frames, loaded.workspace.options, loaded.frames));
      setSequenceMode(loaded.workspace.sequenceMode === true);
      setAnimationName(loaded.name); setAnimFps(loaded.fps);
      setTaskInfo(loaded.workspace.taskInfo ?? importedTaskInfo('restored'));
      const sourceFrames = loaded.source?.totalFrames ?? 1;
      const rangeStart = Math.min(sourceFrames, Math.max(1, loaded.workspace.start));
      const rangeEnd = Math.min(sourceFrames, Math.max(rangeStart, loaded.workspace.end));
      setOptions(loaded.workspace.options); setStart(rangeStart); setEnd(rangeEnd);
      setCursor(Math.min(rangeEnd, Math.max(rangeStart, loaded.workspace.cursor))); setStride(loaded.workspace.stride);
      setLoopMode(loaded.workspace.loopMode); setSheetColumns(loaded.workspace.sheetColumns); setSheetRows(loaded.workspace.sheetRows);
      setBackground(loaded.workspace.background ?? 'checker');
      // Saved smoothing may contain replacement pixels from the removed correction step.
      const discardSmoothing = !!(loaded.loopCorrection?.enabled && loaded.smoothing?.frames?.length);
      const smoothing = discardSmoothing && loaded.smoothing ? { ...loaded.smoothing, enabled: false, frames: null } : loaded.smoothing;
      // Legacy correction assets are no longer used by the workspace or its panels.
      const retainedUrls = new Set([...loaded.frames, ...(loaded.sequenceInputs ?? []), ...(loaded.matting?.frames ?? []), ...(smoothing?.frames ?? []), ...(loaded.compression?.sources ?? []), ...(loaded.compression?.results ?? [])].map(frame => frame.url));
      const discardedFrames = [...(loaded.loopCorrection?.frames ?? []), ...(discardSmoothing ? loaded.smoothing?.frames ?? [] : [])];
      for (const url of new Set(discardedFrames.map(frame => frame.url))) {
        if (url.startsWith('blob:') && !retainedUrls.has(url)) URL.revokeObjectURL(url);
      }
      setSmoothingEnabled(smoothing?.enabled ?? false);
      setPanelRestore({ key: ++projectRestoreKey.current, compression: loaded.compression ?? {
        settings: { ...defaultCompressionSettings }, lastSettings: null, sourceLabel: '', fps: loaded.fps, sources: [], results: [],
      }, smoothing: smoothing ?? { enabled: false, options: loaded.workspace.options, frames: null } });
      // Ownership of the loaded media and frame URLs now belongs to the workspace and panels.
      loaded = null; setLastSavedProject(''); setPlaying(true);
      notify(discardSmoothing ? '工程已载入。旧平滑结果包含已移除的首尾修正，已恢复原始帧；如需平滑，请重新启用并处理。' : '工程已载入，可以继续编辑并导出。'); goTo(0);
    } catch (error) { if (loaded) releaseLoadedProject(loaded); if (!controller.signal.aborted) notify(error instanceof Error ? error.message : '工程加载失败。'); }
    finally { if (projectAbort.current === controller) projectAbort.current = null; projectOperation.current = false; setProjectBusy(null); }
  };

  const clearWorkspace = () => {
    if (mediaImportLocked || bootstrapping) return;
    bootstrapAbort.current?.abort(); manualPreviewAbort.current?.abort();
    const previous = sourceRef.current;
    if (previous) { releaseMedia(previous); if (previous.url.startsWith('blob:')) URL.revokeObjectURL(previous.url); }
    sourceRef.current = null; setSource(null); setSequenceMode(false); replaceSequenceInputs([]); replaceFrames([]);
    previewUrls.current.forEach(url => URL.revokeObjectURL(url)); previewUrls.current = [];
    setRawPreview(''); setCleanPreview(''); setInspectedFrame(null); setTaskInfo(null);
    setStart(1); setEnd(1); setCursor(1); setPreviewPlaying(false); setAnimationName('character_idle');
    setSmoothingEnabled(false); setSmoothedSequence(null);
    setPanelRestore({ key: ++projectRestoreKey.current,
      smoothing: { enabled: false, options: { ...options }, frames: null },
      compression: { settings: { ...defaultCompressionSettings }, lastSettings: null, sourceLabel: '', fps: animFps, sources: [], results: [] },
    });
    notify('已清空当前素材和帧列表，已保存的工程仍可从项目列表打开。');
  };
  const setRangeStart = (value: number) => {
    const next = Math.max(1, Math.min(end, Number.isFinite(value) ? Math.round(value) : 1));
    setStart(next); setCursor(next); seekVideo(next);
  };
  const setRangeEnd = (value: number) => { const next = Math.min(totalFrames, Math.max(start, Number.isFinite(value) ? Math.round(value) : totalFrames)); setEnd(next); if (cursor > next) { setCursor(next); seekVideo(next); } };
  const seekVideo = (frame: number) => { if (source?.kind === 'video' && videoRef.current) videoRef.current.currentTime = frameTime(frame, source.fps); };
  const seek = (value: number) => { setCursor(value); seekVideo(value); };
  const setBoundaryFromPreview = (boundary: 'start' | 'end') => {
    if (rangeCaptureDisabled || !source) return;
    const video = source.kind === 'video' ? videoRef.current : null;
    const current = Math.min(end, Math.max(start, previewPlaying && video && !video.seeking ? frameAtTime(video.currentTime, source.fps) : cursor));
    video?.pause(); setPreviewPlaying(false);
    if (boundary === 'start') setRangeStart(current);
    else { setRangeEnd(current); setCursor(current); seekVideo(current); }
    notify(`已将预览第 ${current} 帧设为${boundary === 'start' ? '起始帧' : '结束帧'}。`);
  };

  const importMedia = useCallback(async (file?: File, newProject = false) => {
    if (!file || importInFlight.current || mediaImportLocked) return;
    importInFlight.current = true;
    bootstrapAbort.current?.abort();
    manualPreviewAbort.current?.abort();
    setImporting(true); setPreviewPlaying(false);
    try {
      const media = await loadMedia(file);
      if (sourceRef.current) { releaseMedia(sourceRef.current); if (sourceRef.current.url.startsWith('blob:')) URL.revokeObjectURL(sourceRef.current.url); }
      sourceRef.current = media; setSource(media); setSequenceMode(false); setStart(1); setEnd(media.totalFrames); setCursor(1); setRawPreview(''); setCleanPreview('');
      const nextName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_') || 'animation';
      replaceSequenceInputs([]); replaceFrames([]);
      setTaskInfo(null);
      setAnimationName(nextName);
      setPendingClipName(newProject || media.kind === 'video' ? { initialName: nextName.slice(0, 80), sourceName: file.name, newProject } : null);
      if (newProject) {
        setSheetColumns('auto'); setSheetRows(undefined); setLoopMode('loop');
        setLastSavedProject(''); setSmoothingEnabled(false); setSmoothedSequence(null);
        setPanelRestore({ key: ++projectRestoreKey.current, smoothing: { enabled: false, options: { ...options }, frames: null }, compression: { settings: { ...defaultCompressionSettings }, lastSettings: null, sourceLabel: '', fps: animFps, sources: [], results: [] } });
      }
      if (media.kind === 'image') setStride(1);
      notify(`已导入 ${file.name}`); goTo(0);
    } catch (error) { notify(error instanceof Error ? error.message : '素材导入失败'); }
    finally { importInFlight.current = false; setImporting(false); if (mediaInput.current) mediaInput.current.value = ''; }
  }, [mediaImportLocked, notify, goTo, replaceFrames, options, animFps]);

  const importAnimation = useCallback(async (files: FileList | File[] | null, importOptions: AnimationImportOptions = {}) => {
    if (!files?.length || importInFlight.current || mediaImportLocked) return;
    const imageFiles = Array.from(files).filter(file => /\.(png|webp|jpe?g|bmp|avif)$/i.test(file.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!imageFiles.length || (importOptions.append && imageFiles.length !== Array.from(files).length)) { notify('请选择 PNG、WebP 或 JPG 图片序列。'); return; }
    const existingCount = importOptions.append ? Math.max(framesRef.current.length, sequenceInputsRef.current.length) : 0;
    if (imageFiles.length + existingCount > 400) { notify('一组动画最多 400 帧，请减少新增图片数量。'); return; }
    importInFlight.current = true;
    bootstrapAbort.current?.abort();
    manualPreviewAbort.current?.abort();
    setImporting(true);
    const result: Frame[] = [];
    let totalPixels = importOptions.append ? sequenceInputsRef.current.reduce((sum, frame) => sum + frame.width * frame.height, 0) : 0;
    const importBatch = crypto.randomUUID();
    const sourceOffset = importOptions.append ? Math.max(0, ...framesRef.current.map(frame => frame.sourceIndex), ...sequenceInputsRef.current.map(frame => frame.sourceIndex)) : 0;
    try {
      for (const [index, file] of imageFiles.entries()) {
        const image = await loadMedia(file);
        totalPixels += image.width * image.height;
        if (image.width > 8192 || image.height > 8192 || totalPixels > 120_000_000) { releaseMedia(image); URL.revokeObjectURL(image.url); throw new Error('图片序列超出浏览器内存范围，请减少帧数或缩小图片后再导入。'); }
        const importFps = Math.max(1, Math.min(60, importOptions.fps ?? animFps));
        result.push({ id: `import-${importBatch}-${index}`, name: file.name, sourceIndex: sourceOffset + index + 1, time: (sourceOffset + index) / importFps, url: image.url, width: image.width, height: image.height, selected: true, anchor: 'bottom' });
        releaseMedia(image);
      }
      if (importOptions.append) {
        const originals = sequenceInputsRef.current.length ? sequenceInputsRef.current : framesRef.current;
        replaceSequenceInputs([...originals, ...result]);
        replaceFrames([...framesRef.current, ...result]);
        setEnd(sequenceInputsRef.current.length);
        setTaskInfo(importedTaskInfo('import')); setPlaying(true);
        notify(`已追加 ${result.length} 张图片到当前项目`);
        return;
      }
      if (importOptions.targetStep === 0) {
        const media = await loadMedia(imageFiles[0], importOptions.fps ?? animFps);
        if (sourceRef.current) { releaseMedia(sourceRef.current); if (sourceRef.current.url.startsWith('blob:')) URL.revokeObjectURL(sourceRef.current.url); }
        sourceRef.current = media; setSource(media); setSequenceMode(true);
        setStart(1); setEnd(result.length); setCursor(1); setStride(1);
        setPreviewPlaying(false); setRawPreview(''); setCleanPreview('');
        const nextName = imageFiles[0].name.replace(/\.[^.]+$/, '').replace(/[_-]?\d+$/, '') || 'animation';
        setAnimationName(nextName);
        if (importOptions.newProject) {
          setSheetColumns('auto'); setSheetRows(undefined); setLoopMode('loop');
          setPendingClipName({ initialName: nextName.slice(0, 80), sourceName: `${imageFiles[0].name} 等 ${result.length} 张图片`, newProject: true });
          setLastSavedProject(''); setSmoothingEnabled(false); setSmoothedSequence(null);
          setPanelRestore({ key: ++projectRestoreKey.current, smoothing: { enabled: false, options: { ...options }, frames: null }, compression: { settings: { ...defaultCompressionSettings }, lastSettings: null, sourceLabel: '', fps: animFps, sources: [], results: [] } });
        }
      }
      replaceSequenceInputs(importOptions.targetStep === 0 || sequenceMode ? result.map(frame => ({ ...frame })) : []);
      replaceFrames(result);
      setTaskInfo(importedTaskInfo('import'));
      if (importOptions.fps) setAnimFps(Math.max(1, Math.min(60, importOptions.fps)));
      if (importOptions.name) setAnimationName(importOptions.name);
      if (importOptions.processed) replaceMattingStage(createMattingStage(result, options, result));
      setPlaying(true); notify(`已按文件名顺序导入 ${result.length} 帧`); goTo(importOptions.targetStep ?? 2);
    } catch (error) { result.forEach(frame => URL.revokeObjectURL(frame.url)); notify(error instanceof Error ? error.message : '图片序列导入失败'); }
    finally { importInFlight.current = false; setImporting(false); if (frameInput.current) frameInput.current.value = ''; if (folderInput.current) folderInput.current.value = ''; }
  }, [mediaImportLocked, animFps, notify, goTo, replaceFrames, sequenceMode, options]);

  const importTunedFrames = useCallback(async (files: File[], fps: number, name: string) => {
    await importAnimation(files, { targetStep: 4, fps, name, processed: true });
  }, [importAnimation]);

  const importTransferredFiles = useCallback((files: File[], newProject = false) => {
    if (importInFlight.current || mediaImportLocked) { notify('正在处理素材，请完成后再导入。'); return; }
    const mediaFiles = files.filter(file => isVideoFile(file) || file.type.startsWith('image/') || /\.(png|jpe?g|webp|avif|bmp|gif)$/i.test(file.name));
    if (!mediaFiles.length) { notify('请拖入或粘贴视频、图片文件，例如 MP4、WebM、PNG、JPG。'); return; }
    if (mediaFiles.length > 1 && mediaFiles.some(isVideoFile)) { notify('请一次导入一个视频；多文件导入支持图片帧序列。'); return; }
    if (mediaFiles.length > 1) void importAnimation(mediaFiles, { targetStep: 0, newProject });
    else void importMedia(mediaFiles[0], newProject);
  }, [mediaImportLocked, importAnimation, importMedia, notify]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (activeTab !== 'workbench' || helpOpen || inspectedFrame || pendingClipName || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input,textarea,select,[role="textbox"]'))) return;
      const files = transferFiles(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      importTransferredFiles(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [activeTab, helpOpen, inspectedFrame, pendingClipName, importTransferredFiles]);

  useEffect(() => {
    // Ignore file drops outside the import zone, including the body's page margins.
    // Prevent the browser from navigating to an accidentally dropped local file.
    const rejectFileDrop = (event: globalThis.DragEvent) => {
      if (!isFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
      setImportDropActive(false);
    };
    document.addEventListener('dragover', rejectFileDrop);
    document.addEventListener('drop', rejectFileDrop);
    return () => {
      document.removeEventListener('dragover', rejectFileDrop);
      document.removeEventListener('drop', rejectFileDrop);
    };
  }, []);

  async function runExtraction() {
    if (!source || mediaImportLocked) return;
    bootstrapAbort.current?.abort();
    manualPreviewAbort.current?.abort();
    setProcessing(true); setPreviewPlaying(false); setProgress({ done: 0, total: outputCount });
    const controller = new AbortController(); abortRef.current = controller;
    try {
      const settings = extractionOptions(options);
      const result = sequenceMode ? await processSequence(settings, controller.signal) : await extractFrames(source, start, end, stride, settings, (done, total) => setProgress({ done, total }), controller.signal, processFrame);
      setTaskInfo(extractionTaskInfo(source, start, end, stride, settings, result));
      replaceMattingStage(null); replaceFrames(result); setPlaying(true); notify(`已抽取 ${result.length} 帧，请检查后进入第 04 步抠图。`); goTo(2);
    } catch (error) { if (controller.signal.aborted) notify('处理已取消，保留上一次结果。'); else notify(error instanceof Error ? error.message : '抽帧失败，请尝试降低输出尺寸。'); }
    finally { setProcessing(false); abortRef.current = null; }
  }

  async function processSequence(settings: ProcessOptions, signal: AbortSignal): Promise<Frame[]> {
    const input = sequenceInputsRef.current.filter(frame => frame.selected).filter((_, index) => index % stride === 0);
    if (!input.length) throw new Error('请至少勾选一帧后再处理。');
    const result: Frame[] = [];
    let pixels = 0;
    try {
      for (const [index, frame] of input.entries()) {
        const media: MediaSource = { kind: 'image', name: frame.name, url: frame.url, width: frame.width, height: frame.height, fps: animFps, duration: 1 / animFps, totalFrames: 1 };
        const raw = await captureFrame(media, 1, signal);
        releaseMedia(media);
        const processed = await processFrame(raw, settings, signal);
        pixels += processed.width * processed.height;
        if (pixels > 120_000_000) throw new Error('处理结果超过 1.2 亿像素，请减少帧数或降低目标高度。');
        const blob = await canvasToBlob(processed);
        if (signal.aborted) throw new DOMException('处理已取消', 'AbortError');
        result.push({ ...frame, url: URL.createObjectURL(blob), width: processed.width, height: processed.height, time: index / animFps, anchor: options.alignment, selected: true });
        setProgress({ done: index + 1, total: input.length });
      }
      return result;
    } catch (error) { result.forEach(frame => URL.revokeObjectURL(frame.url)); throw error; }
  }

  async function runMatting() {
    if (!selectedFrames.length || mediaImportLocked) return;
    manualPreviewAbort.current?.abort();
    const input = [...selectedFrames]; const settings = { ...options }; const upstream = [...frames];
    const controller = new AbortController(); abortRef.current = controller;
    const result: Frame[] = [];
    setProcessing(true); setPlaying(false); setProgress({ done: 0, total: input.length });
    try {
      for (const [index, frame] of input.entries()) {
        const media: MediaSource = { kind: 'image', name: frame.name, url: frame.url, width: frame.width, height: frame.height, fps: animFps, duration: 1 / animFps, totalFrames: 1 };
        const raw = await captureFrame(media, 1, controller.signal);
        releaseMedia(media);
        const processed = await processFrame(raw, frameMattingOptions(frame, settings), controller.signal, true);
        const blob = await canvasToBlob(processed);
        if (controller.signal.aborted) throw new DOMException('抠图已取消', 'AbortError');
        result.push({ ...frame, url: URL.createObjectURL(blob), width: processed.width, height: processed.height });
        setProgress({ done: index + 1, total: input.length });
      }
      replaceMattingStage(createMattingStage(upstream, settings, result));
      setPlaying(true); notify(`已完成 ${result.length} 帧抠图，结果已传入第 05 步动画预览。`); goTo(4);
    } catch (error) {
      result.forEach(frame => URL.revokeObjectURL(frame.url));
      notify(controller.signal.aborted ? '抠图已取消，保留上一次完成的结果。' : error instanceof Error ? error.message : '抠图失败，请重试。');
    } finally { setProcessing(false); abortRef.current = null; }
  }

  async function previewCurrentFrame() {
    if (!previewSource || processing || preparingModel) return;
    manualPreviewAbort.current?.abort();
    const controller = new AbortController(); manualPreviewAbort.current = controller;
    setPreviewBusy(true);
    setPlaying(false);
    try { await refreshPreview(previewSource, 1, frameMattingOptions(previewSource, options), controller.signal); if (isAi) void getBackendHealth().then(setBackend).catch(() => {}); }
    catch (error) { if (!controller.signal.aborted) notify(error instanceof Error ? error.message : 'AI 预览失败'); }
    finally { if (!controller.signal.aborted) setPreviewBusy(false); }
  }

  async function prepareAi() {
    setPreparingModel(true);
    try { await prepareModels(options); setBackend(await getBackendHealth()); notify('模型已就绪，可以预览与批量抠图。'); }
    catch (error) { notify(error instanceof Error ? error.message : '模型加载失败'); }
    finally { setPreparingModel(false); }
  }

  function changeSheetLayout(dimension: 'columns' | 'rows', value: number, baseline = reviewLayout) {
    if (mediaImportLocked) return;
    const next = editSheetLayout(displayFrames.length, dimension, value, baseline);
    setSheetColumns(next.columns); setSheetRows(next.rows);
  }

  function selectFrames(mode: 'all' | 'none' | 'odd' | 'even' | 'invert') {
    if (mediaImportLocked) return;
    if (sequenceMode && (mode === 'all' || mode === 'none')) sequenceInputsRef.current = sequenceInputsRef.current.map(frame => ({ ...frame, selected: mode === 'all' }));
    updateFrames(previous => previous.map((frame, index) => ({ ...frame, selected: mode === 'all' || (mode === 'odd' && index % 2 === 0) || (mode === 'even' && index % 2 === 1) || (mode === 'invert' && !frame.selected) })));
    setAnimIndex(0);
  }

  function endFrameDrag() {
    draggedFrameRef.current = null; setDraggedFrame(null); setDropTargetFrame(null);
  }

  function frameDragProps(frame: Frame) {
    return {
      draggable: !mediaImportLocked,
      'data-frame-id': frame.id,
      'data-dragging': draggedFrame === frame.id,
      'data-drop-target': dropTargetFrame === frame.id && draggedFrame !== frame.id,
      onDragStart: (event: DragEvent<HTMLElement>) => {
        if (mediaImportLocked || (event.target as HTMLElement).closest('input,label')) { event.preventDefault(); return; }
        event.stopPropagation();
        event.dataTransfer.clearData();
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-2dworkbench-frame', frame.id);
        draggedFrameRef.current = frame.id; setDraggedFrame(frame.id);
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!draggedFrameRef.current || mediaImportLocked) return;
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDropTargetFrame(frame.id);
      },
      onDragEnd: endFrameDrag,
      onDrop: (event: DragEvent<HTMLElement>) => {
        const moving = draggedFrameRef.current;
        if (!moving) return;
        event.preventDefault(); event.stopPropagation();
        if (!mediaImportLocked) { updateFrames(previous => moveFrame(previous, moving, frame.id)); setAnimIndex(0); }
        endFrameDrag();
      },
    };
  }

  function onDrop(event: DragEvent) {
    setImportDropActive(false);
    const files = transferFiles(event.dataTransfer);
    if (!files.length) return;
    event.preventDefault(); event.stopPropagation();
    if (activeTab !== 'workbench' || helpOpen || inspectedFrame || pendingClipName) return;
    importTransferredFiles(files, true);
  }

  function dragOverImport(event: DragEvent) {
    if (!isFileTransfer(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation();
    const accepted = activeTab === 'workbench' && !helpOpen && !inspectedFrame && !mediaImportLocked;
    event.dataTransfer.dropEffect = accepted ? 'copy' : 'none';
    setImportDropActive(accepted);
  }


  function frameListFileDropProps(allowAppend: boolean) {
    if (!allowAppend) return {};
    return {
      'data-append-drop-target': true,
      'data-file-dragover': frameImportDropActive,
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!isFileTransfer(event.dataTransfer)) return;
        event.preventDefault(); event.stopPropagation();
        event.dataTransfer.dropEffect = mediaImportLocked || !!inspectedFrame ? 'none' : 'copy';
        setFrameImportDropActive(!mediaImportLocked && !inspectedFrame);
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFrameImportDropActive(false);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!isFileTransfer(event.dataTransfer)) return;
        event.preventDefault(); event.stopPropagation(); setFrameImportDropActive(false);
        if (!mediaImportLocked && !inspectedFrame) void importAnimation(transferFiles(event.dataTransfer), { append: true });
      },
    };
  }

  function renderFrameReview(allowAppend = false) {
    return <div className="review-layout"><aside className="card animation-card"><div className="panel-heading"><h3>动画预览</h3><span className="badge">LIVE</span></div><p className="field-hint">只播放当前勾选的帧</p><div className={`animation-viewport ${background}`}>{currentReviewFrame ? <img src={currentReviewFrame.url} alt={`动画当前帧 ${currentReviewFrame.name}`} /> : <div className="empty-state"><Film size={30} /><p>勾选至少一帧<br />开始预览动画</p></div>}<span className="animation-frame-label">{currentReviewFrame ? `#${pad(animIndex + 1)}` : 'NO FRAMES'}</span></div><div className="animation-controls"><button className="icon-button" aria-label="动画上一帧" disabled={!selectedFrames.length} onClick={() => { setPlaying(false); setAnimIndex(value => (value - 1 + selectedFrames.length) % selectedFrames.length); }}><ChevronLeft size={16} /></button><button className="icon-button play-button" aria-label={playing ? '暂停动画' : '播放动画'} disabled={!selectedFrames.length} onClick={() => { if (!playing && loopMode === 'once' && animIndex >= selectedFrames.length - 1) setAnimIndex(0); setPlaying(value => !value); }}>{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button><button className="icon-button" aria-label="动画下一帧" disabled={!selectedFrames.length} onClick={() => { setPlaying(false); setAnimIndex(value => (value + 1) % selectedFrames.length); }}><ChevronRight size={16} /></button></div><ReviewProgress index={animIndex} count={selectedFrames.length} onPause={() => setPlaying(false)} onSeek={index => { setPlaying(false); setAnimIndex(index); }} /><label className="fps-control">播放速度 <input aria-label="动画预览帧率" type="number" min={1} max={60} value={animFps} onChange={event => setAnimFps(Math.min(60, Math.max(1, +event.target.value || 1)))} /><span>FPS</span></label><div className="review-sheet-layout"><h4 className="layout-label">精灵图布局</h4><SheetLayoutControls layout={reviewLayout} disabled={mediaImportLocked} onChange={changeSheetLayout} /><p className="field-hint">行列不足时自动补足，右侧完整缩放显示。</p></div><button className="button ghost small wide" onClick={() => goTo(3)}>进入精细抠图 <ArrowRight size={14} /></button></aside>
          <div className="card frame-list" {...frameListFileDropProps(allowAppend)}><div className="pane-heading"><h3>帧列表 <span className="muted">/ {pad(frames.length)} FRAMES</span></h3><span className="field-hint">{allowAppend ? '拖入图片追加 · 拖动排序 · 单击勾选/反选 · 双击放大' : '拖动排序 · 单击勾选/反选 · 双击放大'}</span></div>{frames.length ? <FittedFrameGrid columns={reviewLayout.columns} rows={reviewDisplayRows} cellWidth={reviewCellWidth} cellHeight={reviewCellHeight}>{displayFrames.map((frame, index) => <ReviewFrameCard key={frame.id} {...frameDragProps(frame)} disabled={mediaImportLocked} onToggle={() => { if (!mediaImportLocked) updateFrames(previous => previous.map(item => item.id === frame.id ? { ...item, selected: !item.selected } : item)); }} onInspect={() => setInspectedFrame(frame)} className={`frame-card ${frame.selected ? 'selected' : ''} ${currentReviewFrame?.id === frame.id ? 'playing' : ''}`}><label className="frame-checkbox"><input type="checkbox" disabled={mediaImportLocked} checked={frame.selected} aria-label={`选择第 ${index + 1} 帧 ${frame.name}`} onChange={() => { if (!mediaImportLocked) updateFrames(previous => previous.map(item => item.id === frame.id ? { ...item, selected: !item.selected } : item)); }} /><span><Check size={11} strokeWidth={3} /></span></label><button draggable={!mediaImportLocked} className="frame-thumb checker" style={{ aspectRatio: `${reviewCellWidth} / ${reviewCellHeight}` }} aria-label={`选择或反选第 ${index + 1} 帧，双击放大检查`} aria-pressed={frame.selected} title="单击勾选/反选，双击放大检查"><img src={frame.url} draggable={!mediaImportLocked} alt={frame.name} loading="lazy" style={{ width: `${frame.width / reviewCellWidth * 100}%`, height: `${frame.height / reviewCellHeight * 100}%` }} /><span className="frame-zoom"><ZoomIn size={16} /></span></button><div className="frame-meta"><strong>#{pad(index + 1)}</strong><span title={frame.name}>{frame.name}</span></div></ReviewFrameCard>)}</FittedFrameGrid> : <div className="empty-state frame-empty"><ImagePlus size={40} strokeWidth={1.3} /><h3>你的下一组动画，从这里开始</h3><p>处理上方的视频，或直接导入已经准备好的图片序列。</p><button className="button secondary" disabled={mediaImportLocked} onClick={() => frameInput.current?.click()}><Upload size={15} /> 导入动画帧</button></div>}</div></div>;
  }

  return <div className="app" onDragEnd={() => { setImportDropActive(false); setFrameImportDropActive(false); }}>
    <SourceHeader source={source} disabled={mediaImportLocked || bootstrapping} onClear={clearWorkspace} onHelp={() => setHelpOpen(true)} />
    <nav className="workspace-tab-bar" aria-label="工作区标签"><div className="workspace-tabs-inner" role="tablist"><button id="tab-workbench" className="workspace-tab" type="button" role="tab" aria-selected={activeTab === 'workbench'} aria-controls="workbench-panel" onClick={() => changeTab('workbench')}><Film size={16} />动画素材工作台</button><button id="tab-tuner" className="workspace-tab" type="button" role="tab" aria-selected={activeTab === 'tuner'} aria-controls="tuner-panel" onClick={() => changeTab('tuner')}><SlidersHorizontal size={16} />XSXB 帧调参<span className="tab-label">LITE</span></button><span className="workspace-tab-help"><ShieldCheck size={12} />抽帧与调参，一站完成</span></div></nav>
    <main className="workspace workbench-panel" id="workbench-panel" role="tabpanel" aria-labelledby="tab-workbench" hidden={activeTab !== 'workbench'}>
      <ProjectLibrary directory={projectDirectory} onDirectoryChange={directory => { setProjectDirectory(directory); setLastSavedProject(''); }} disabled={mediaImportLocked || bootstrapping} refreshKey={projectRefresh} onOpen={openSavedProject} onBrowse={chooseProjectDirectory} onNotify={notify} />
      <div className="hero"><div><div className="eyebrow"><span /> VIDEO TO SPRITE · 动画素材工作台</div><h1>好动画，从<span>每一帧</span>开始。</h1><p>截取、抽帧、抠图，再让角色动起来。你的素材，在这里一气呵成。</p></div><div className={`hero-actions media-import-zone ${importDropActive ? 'is-dragover' : ''}`} onDragEnter={dragOverImport} onDragOver={dragOverImport} onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setImportDropActive(false); }} onDrop={onDrop}><button id="media-import-trigger" className="button primary" disabled={mediaImportLocked} aria-describedby="media-import-hint" title="点击选择文件，或拖入文件、按 Ctrl+V 粘贴" onClick={() => mediaInput.current?.click()}>{importing ? <LoaderCircle className="spinner" size={17} /> : <Upload size={17} />}{importDropActive ? '松开即可导入素材' : '拖入或粘贴视频 / 图片'}</button><span id="media-import-hint" className="media-import-hint">点击选择 · 拖入文件 · <kbd>Ctrl+V</kbd> 粘贴</span><span>支持 MP4、WebM、MOV 及常见图片格式</span></div></div>
      <nav className="workflow-nav" aria-label="制作流程">{steps.map((step, index) => <button key={step.title} className={`step ${activeStep === index ? 'active' : ''} ${index === 2 && frames.length ? 'complete' : ''}`} onClick={() => goTo(index)} aria-current={activeStep === index ? 'step' : undefined}><span className="step-number">{pad(index + 1, 2)}</span><span className="step-copy"><strong>{step.title}</strong><span>{step.subtitle}</span></span>{index < steps.length - 1 && <ChevronRight className="step-arrow" size={15} />}</button>)}</nav>

      <section className="workspace-section" id="step-1"><SectionHeading number={1} title="预览与截取区间" actions={<span className="status-chip"><span className="status-dot" /> {source?.kind === 'demo' ? '演示素材已就绪' : source ? '素材已就绪' : '等待导入'}</span>}>找到动作的起点与终点，只留下需要的部分。</SectionHeading>
        {sequenceMode ? renderFrameReview(true) : <>
        <div className="card source-bar"><div className="file-icon"><Film size={22} /></div><div className="file-details"><strong>{source?.name ?? '正在载入内置示例…'}{source?.kind === 'demo' && <span className="badge">DEMO</span>}</strong><span>{source ? `${source.width} × ${source.height} · ${source.fps} FPS · ${source.totalFrames} 帧 · ${time(source.duration)}` : '也可以直接将视频或图片拖入工作区'}</span></div><div className="file-badges"><span className="badge sage">{source?.kind === 'image' ? '单帧模式' : '本地素材'}</span></div><button className="button ghost small" disabled={mediaImportLocked} onClick={() => mediaInput.current?.click()}><RefreshCw size={14} /> 更换素材</button></div>
        <div className="card preview-layout"><div className="preview-main"><div className="media-stage">
          {source?.kind === 'video' ? <video key={source.url} ref={videoRef} src={source.url} playsInline muted onLoadedMetadata={() => { if (videoRef.current) videoRef.current.currentTime = frameTime(cursor, source.fps); }} onTimeUpdate={event => { const video = event.currentTarget; if (video.seeking) return; if (video.currentTime >= end / source.fps || video.currentTime < frameTime(start, source.fps)) { video.currentTime = frameTime(start, source.fps); if (previewPlaying) void video.play().catch(() => setPreviewPlaying(false)); } setCursor(Math.min(end, Math.max(start, frameAtTime(video.currentTime, source.fps)))); }} onEnded={() => { if (videoRef.current && previewPlaying) { videoRef.current.currentTime = frameTime(start, source.fps); void videoRef.current.play(); } }} /> : source?.kind === 'image' || rawPreview ? <img key={source?.kind === 'image' ? source.url : rawPreview} src={source?.kind === 'image' ? source.url : rawPreview} alt="选定素材的原始帧预览" style={previewPlaying ? { transform: `rotate(${Math.sin((cursor - 1) / 24 * Math.PI) * 0.45}deg)` } : undefined} /> : <div className="loading-state"><LoaderCircle className="spinner" /> 加载预览</div>}
          <span className="stage-label"><span className="status-dot" /> SOURCE PREVIEW</span><span className="stage-hint">{source?.kind === 'demo' ? '参考角色 · 位移演示' : source?.kind === 'image' ? '静态图片' : '区间循环预览'}</span><span className="frame-counter">FRAME {pad(cursor)} / {pad(totalFrames)}</span>
        </div><div className="transport"><button className="icon-button play-button" disabled={!source || source.kind === 'image'} aria-label={previewPlaying ? '暂停视频预览' : '播放选定区间'} onClick={() => setPreviewPlaying(value => !value)}>{previewPlaying ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button><span className="timecode">{time(source ? frameTime(cursor, source.fps) : 0)} <span>/ {time(source?.duration ?? 0)}</span></span><input className="seek-slider" aria-label="视频播放位置" type="range" min={start} max={end} value={Math.max(start, Math.min(end, cursor))} onChange={event => seek(+event.target.value)} disabled={!source || source.kind === 'image'} /><span className="playback-rate">{source?.fps ?? 24} FPS</span><button className="icon-button" title="从区间起点重新播放" aria-label="回到区间起点" onClick={() => seek(start)}><RotateCcw size={16} /></button></div></div>
          <aside className="range-panel"><div className="panel-heading"><Scissors size={17} /><h3>截取区间</h3><span>按帧精确选择</span></div><div className="field"><div className="field-row"><label htmlFor="start-frame">起始帧</label><div className="number-with-unit"><input id="start-frame" type="number" min={1} max={end} value={start} onChange={event => setRangeStart(+event.target.value)} /><span>帧</span></div></div><input aria-label="起始帧滑块" type="range" min={1} max={totalFrames} value={start} onChange={event => setRangeStart(+event.target.value)} /><div className="range-frame-action-row"><span className="field-hint">{time(source ? frameTime(start, source.fps) : 0)}</span><button id="set-start-current-frame" type="button" className="button ghost small range-current-frame-button" aria-label="将当前预览帧设为起始帧" title="使用左侧预览进度条当前的帧" disabled={rangeCaptureDisabled} onClick={() => setBoundaryFromPreview('start')}><FrameIcon size={12} />使用当前帧</button></div></div><div className="field"><div className="field-row"><label htmlFor="end-frame">结束帧</label><div className="number-with-unit"><input id="end-frame" type="number" min={start} max={totalFrames} value={end} onChange={event => setRangeEnd(+event.target.value)} /><span>帧</span></div></div><input aria-label="结束帧滑块" type="range" min={1} max={totalFrames} value={end} onChange={event => setRangeEnd(+event.target.value)} /><div className="range-frame-action-row"><span className="field-hint">{time(source ? end / source.fps : 0)}</span><button id="set-end-current-frame" type="button" className="button ghost small range-current-frame-button" aria-label="将当前预览帧设为结束帧" title="使用左侧预览进度条当前的帧" disabled={rangeCaptureDisabled} onClick={() => setBoundaryFromPreview('end')}><FrameIcon size={12} />使用当前帧</button></div></div><div className="range-summary"><span>已选区间</span><strong>{selectedCount}<small> 帧</small></strong><div className="range-visual"><span style={{ left: `${(start - 1) / totalFrames * 100}%`, width: `${selectedCount / totalFrames * 100}%` }} /></div><div className="range-readout"><span>第 {start} 帧 → 第 {end} 帧</span><strong>{source ? (selectedCount / source.fps).toFixed(2) : '0.00'} s</strong></div></div><div className="hint"><MousePointer2 size={14} /><span>拖动滑块后，预览会自动跳转到新起点。</span></div>{source && source.kind !== 'image' && <label className="source-fps">源素材帧率 <input type="number" aria-label="源素材帧率" min={1} max={120} value={source.fps} disabled={mediaImportLocked} onChange={event => { const fps = Math.max(1, Math.min(120, +event.target.value || 24)); const total = Math.max(1, Math.floor(source.duration * fps)); setSource({ ...source, fps, totalFrames: total }); setStart(1); setEnd(total); setCursor(1); }} /><span>FPS · 可手动校准</span></label>}</aside></div>
        {source?.kind === 'demo' && <div className="demo-banner"><Sparkles size={14} /><span>当前为参考角色的静态位移演示。导入你的视频，即可提取真实动作帧。</span><button onClick={() => mediaInput.current?.click()}>导入我的素材 <ArrowRight size={13} /></button></div>}
        </>}
      </section>

      <section className="workspace-section" id="step-2"><SectionHeading number={2} title="抽帧设置" actions={<span className="badge">预计生成 <strong>{outputCount}</strong> 帧</span>}>平衡动作流畅度与素材体积，设定适合项目的输出尺寸。</SectionHeading>
        <div className="settings-grid"><div className="setting-card"><div className="setting-title"><Film size={16} /><label htmlFor="stride">采样间隔</label></div><div className="input-with-suffix"><span>每</span><input id="stride" type="number" min={1} max={400} value={stride} onChange={event => setStride(Math.max(1, Math.min(400, +event.target.value || 1)))} /><span>帧保留 1 帧</span></div><p className="field-hint">1 = 保留全部 · 2 = 隔帧抽取</p></div><div className="setting-card"><div className="setting-title"><Maximize2 size={16} /><label htmlFor="target-height">目标高度</label></div><div className="input-with-suffix"><input id="target-height" type="number" min={64} max={2160} step={16} value={options.targetHeight} onChange={event => updateOption('targetHeight', Math.max(64, Math.min(2160, +event.target.value || 64)))} /><span>px</span></div><p className="field-hint">等比缩放，保持每帧画布一致</p></div><div className="setting-card"><div className="setting-title"><FrameIcon size={16} /><label htmlFor="canvas-layout">画布布局</label></div><select id="canvas-layout" value={options.layout} onChange={event => updateOption('layout', event.target.value as ProcessOptions['layout'])}><option value="original">保持原始比例</option><option value="square">正方形画布</option></select><p className="field-hint">主体对齐 <button className={`inline-option ${options.alignment === 'center' ? 'active' : ''}`} onClick={() => updateOption('alignment', 'center')}>居中</button><span> / </span><button className={`inline-option ${options.alignment === 'bottom' ? 'active' : ''}`} onClick={() => updateOption('alignment', 'bottom')}>底部</button></p></div><div className="setting-card"><div className="setting-title"><Square size={16} /><label htmlFor="padding">画布边距</label></div><div className="input-with-suffix"><input id="padding" type="number" min={0} max={256} value={options.padding} onChange={event => updateOption('padding', Math.max(0, Math.min(256, +event.target.value || 0)))} /><span>px</span></div><p className="field-hint">为角色和动作边缘留出呼吸空间</p></div></div>
        <div className="card extraction-summary"><div className="extraction-flow"><span><Film size={15} />{selectedCount} 原始帧</span><ArrowRight size={15} /><span>每 {stride} 帧采样</span><ArrowRight size={15} /><strong>{outputCount} 张 PNG</strong></div><button className="button primary" disabled={!source || mediaImportLocked} onClick={() => void runExtraction()}>{processing ? <LoaderCircle className="spinner" size={14} /> : <Film size={14} />}{processing ? `正在处理 ${progress.done} / ${progress.total} 帧` : '开始抽帧并检查'}</button></div>
      </section>

      <section className="workspace-section" id="step-3"><SectionHeading number={3} title="检查帧与布局" actions={<span className="status-chip">{frames.length ? <><Check size={14} /> 已加载 {frames.length} 帧</> : '等待处理或导入'}</span>}>留下好帧，剔除多余。将当前勾选与排序后的帧传入第 04 步精细抠图。</SectionHeading>
        <TaskSummary task={taskInfo} frames={displayFrames} selected={selectedFrames.length} /><div className="card selection-toolbar"><div className="selection-actions">{([['all', '全选'], ['none', '全不选'], ['odd', '奇数帧'], ['even', '偶数帧'], ['invert', '反选']] as const).map(([mode, label]) => <button className="button ghost small" key={mode} disabled={!frames.length || mediaImportLocked} onClick={() => selectFrames(mode)}>{mode === 'all' && <CheckCheck size={14} />}{label}</button>)}</div><div className="selection-info"><span>已选 <strong>{selectedFrames.length}</strong> / {frames.length} 帧</span><span className="toolbar-divider" /><button className="button secondary small" disabled={mediaImportLocked} onClick={() => frameInput.current?.click()}><ImagePlus size={14} /> 导入动画帧</button><button className="button ghost small" disabled={mediaImportLocked} onClick={() => folderInput.current?.click()}><FolderOpen size={14} /> 导入文件夹</button><button className="icon-button" title="清空当前帧列表" aria-label="清空帧列表" disabled={!frames.length || mediaImportLocked} onClick={() => { replaceSequenceInputs([]); replaceFrames([]); notify('已清空帧列表，可以重新抽帧或导入。'); }}><X size={16} /></button></div></div>
        {renderFrameReview()}
        <>{smoothingPending && <div className="notice processing-export-pending" role="status"><WandSparkles size={16} /><p>第 6 步的平滑处理尚未完成。完成后预览、导出和压缩将使用平滑结果，也可关闭此步骤。</p><button className="button ghost small" onClick={() => goTo(5)}>查看平滑处理</button></div>}<div className="card review-actions" data-smoothed={smoothingReady}><div><strong>{selectedFrames.length} 帧已选</strong><p>在第 07 步选择导出模式，也可发送到 XSXB 继续精调。</p></div><button className="button secondary send-tuner-button" disabled={!outputFrames.length || mediaImportLocked || derivedExportBlocked} onClick={sendToTuner}><SlidersHorizontal size={16} />发送到 XSXB 调参<ArrowRight size={14} /></button></div></>
      </section>

      <section className="workspace-section" id="step-4"><SectionHeading number={4} title="精细抠图" actions={<button className="button ghost small" onClick={() => { setOptions(defaultOptions); notify('已恢复默认抠图与画布参数'); }}><RotateCcw size={14} /> 重置参数</button>}>去除纯色背景、修整边缘，实时检查透明效果。</SectionHeading>
        <AiControls options={options} backend={backend} busy={mediaImportLocked} preparing={preparingModel} previewBusy={previewBusy} update={updateOption} onPrepare={() => void prepareAi()} onCheck={() => void getBackendHealth().then(setBackend).catch(() => { setBackend(null); notify("AI service is offline. Please run start.ps1."); })} /><div className="cleanup-layout"><aside className="card cleanup-controls"><div className="panel-heading"><WandSparkles size={17} /><h3>背景与边缘</h3><span className="badge sage">{isAi ? 'AI MATTE' : options.engine === 'luma' ? 'LUMA KEY' : 'CHROMA KEY'}</span></div><label className="switch-field"><span><strong>{isAi ? 'AI 去除背景' : options.engine === 'luma' ? 'Luma 去除背景' : '去除纯色背景'}</strong><small>导出带 Alpha 通道的 PNG</small></span><input type="checkbox" role="switch" checked={options.removeBackground} onChange={event => updateOption('removeBackground', event.target.checked)} /></label><WatermarkRemovalControl options={options} update={updateOption} disabled={mediaImportLocked} /><div className="field"><label htmlFor="key-color">背景取色</label><div className="key-color-control"><input id="key-color" type="color" value={options.keyColor} onChange={event => updateOption('keyColor', event.target.value)} /><span>{options.keyColor.toUpperCase()}</span><button className="button ghost small" title="自动读取原始帧四角的平均背景色" onClick={async () => { if (!previewSource) return; try { const canvas = await capturePreviewFrame(previewSource, 1); const context = canvas.getContext('2d')!; const points = [[2, 2], [canvas.width - 3, 2], [2, canvas.height - 3], [canvas.width - 3, canvas.height - 3]]; const pixels = points.map(([x, y]) => context.getImageData(Math.max(0, x), Math.max(0, y), 1, 1).data); const rgb = [0, 1, 2].map(channel => Math.round(pixels.reduce((sum, pixel) => sum + pixel[channel], 0) / pixels.length)); updateOption('keyColor', `#${rgb.map(value => value.toString(16).padStart(2, '0')).join('')}`); notify('已从四角自动取色'); } catch { notify('取色失败，请使用颜色选择器。'); } }}><MousePointer2 size={13} /> 自动</button></div></div>
          <div className="field"><div className="field-row"><label htmlFor="tolerance">背景容差</label><span>{options.tolerance}%</span></div><input id="tolerance" type="range" min={0} max={100} value={options.tolerance} disabled={!options.removeBackground || !!isAi || options.engine === 'luma'} onChange={event => updateOption('tolerance', +event.target.value)} /><p className="field-hint">越高，去除的相近背景色越多</p></div><div className="field"><div className="field-row"><label htmlFor="softness">边缘柔化</label><span>{options.softness}%</span></div><input id="softness" type="range" min={0} max={100} value={options.softness} disabled={!options.removeBackground || !!isAi || options.engine === 'luma'} onChange={event => updateOption('softness', +event.target.value)} /></div><div className="field"><div className="field-row"><label htmlFor="spill">去色溢强度</label><span>{options.spill}%</span></div><input id="spill" type="range" min={0} max={100} value={options.spill} disabled={!options.removeBackground} onChange={event => updateOption('spill', +event.target.value)} /></div><div className="field"><div className="field-row"><label htmlFor="erosion">边缘收缩</label><span>{options.erosion} px</span></div><input id="erosion" type="range" min={0} max={4} value={options.erosion} disabled={!options.removeBackground} onChange={event => updateOption('erosion', +event.target.value)} /></div><BackgroundCleanupControls options={options} update={updateOption} disabled={mediaImportLocked} /><div className="notice"><ShieldCheck size={15} /><p>{isAi ? 'AI 帧仅发送到这台电脑上的本地服务。首次使用需要下载官方模型，批量处理前建议先预览一帧。' : options.engine === 'luma' ? 'Luma 亮度抠图在浏览器中运行。使用上方黑场、白场和 Gamma 调整黑白背景的透明度。' : '纯色背景抠图在浏览器中运行。复杂背景可以切换到上方的 BiRefNet AI 模式。'}</p></div></aside>
          <div className="card preview-comparison"><div className="preview-toolbar"><div><h3>单帧参数预览 <span className="badge">#{pad(animIndex + 1)}</span></h3><p>先看一帧效果，再批量处理整段。</p></div><div className="color-swatches" aria-label="透明效果预览底色">{(['checker', 'dark', 'white', 'rose'] as Background[]).map(bg => <button key={bg} className={`swatch ${bg} ${background === bg ? 'active' : ''}`} aria-label={`预览背景：${{ checker: '棋盘格', dark: '深色', white: '白色', rose: '粉色' }[bg]}`} title={{ checker: '棋盘格', dark: '深色', white: '白色', rose: '粉色' }[bg]} onClick={() => setBackground(bg)} />)}<span>预览底色</span></div></div><div className="comparison-grid"><PreviewPane title="原始帧" url={previewSequenceFrame?.url ?? ''} background="dark" /><PreviewPane title="抠图效果" url={cleanPreview} background={background}><span className="live-indicator">{previewBusy ? <LoaderCircle className="spinner" size={11} /> : <span className="status-dot" />} {previewBusy ? '更新中' : isAi ? '手动预览' : '实时预览'}</span></PreviewPane></div><div className="preview-bottom-bar"><button className="button secondary small" disabled={previewBusy || processing || preparingModel || !selectedFrames.length} onClick={() => void previewCurrentFrame()}>{previewBusy ? <LoaderCircle className="spinner" size={14} /> : <WandSparkles size={14} />}{previewBusy ? '正在预览…' : '预览当前帧'}</button><span><ZoomIn size={14} /> 放大后拖动图像，检查发丝与轮廓边缘</span><button className="button ghost small" disabled={!cleanPreview || previewBusy} onClick={async () => { try { const blob = await fetch(cleanPreview).then(response => response.blob()); downloadBlob(blob, `preview_${pad(cursor)}.png`); } catch { notify('预览图下载失败'); } }}><Download size={14} /> 下载预览图</button></div></div></div>
        <div className="card processing-bar"><div className="processing-copy"><span className="processing-icon"><WandSparkles size={22} /></span><div><strong>{processing ? `正在处理 ${progress.done} / ${progress.total} 帧` : '处理上一步已选帧，再进入动画预览'}</strong><p>{processing ? '正在处理第 03 步已选帧；AI 模式逐帧推理，请保留此页面。' : `第 03 步已选 ${selectedFrames.length} 帧 · 保持输入画布${options.removeBackground ? ' · 透明背景' : ''}`}</p></div></div>{processing ? <div className="processing-actions"><progress max={progress.total || 1} value={progress.done} /><button className="button secondary" onClick={() => abortRef.current?.abort()}><X size={15} /> 取消处理</button></div> : <button className="button primary" disabled={!selectedFrames.length || mediaImportLocked} onClick={() => void runMatting()}><WandSparkles size={17} /> 应用抠图并继续<span className="button-tag">{selectedFrames.length} 帧</span></button>}</div>
      </section>


      <section className="workspace-section" id="step-5"><SectionHeading number={5} title="动画帧选取与预览" actions={<span className="badge"><span className="keyboard-key">SPACE</span> 播放 / 暂停</span>}>调整顺序与节奏，确认它已经准备好进入游戏。</SectionHeading>
        <div className="notice" id="matting-status" role="status" data-state={mattingOutput.pending ? 'pending' : 'ready'}><WandSparkles size={16} /><p>{mattingOutput.pending ? '请应用当前抠图参数；完成后结果会自动进入第 05 步。' : '当前输出已同步到第 05 步；后续平滑与压缩依次使用此结果。'}</p></div>
        <div className="card animation-layout"><div className="animation-workspace"><div className={`large-animation-stage ${background}`}>{currentAnimationFrame ? <img className="animation-image" src={currentAnimationFrame.url} alt={`${animationName} 动画预览`} /> : <div className="empty-state"><Layers3 size={40} /><p>请先完成第 04 步抠图，或关闭抠图及后处理</p></div>}<span className="stage-label">ANIMATION PREVIEW</span><span className="animation-stage-stats">{animFps} FPS <span>·</span> {selectedFrames.length} FRAMES <span>·</span> {(selectedFrames.length / animFps).toFixed(2)} s</span><button className="stage-play-button" disabled={!selectedFrames.length} aria-label={playing ? '暂停大图动画预览' : '播放大图动画预览'} onClick={() => { if (loopMode === 'once' && animIndex === selectedFrames.length - 1) setAnimIndex(0); setPlaying(value => !value); }}>{playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button></div><div className="sequence-heading"><span><GripVertical size={14} /> 动画序列 <strong>{selectedFrames.length}</strong></span><span>拖动帧调整播放顺序</span></div><div className="sequence-strip">{animationFrames.length ? animationFrames.map((frame, index) => <button key={frame.id} {...frameDragProps(frame)} className={`sequence-frame ${animIndex === index ? 'active' : ''} ${background}`} onClick={() => { setPlaying(false); setAnimIndex(index); }} aria-label={`预览动画序列第 ${index + 1} 帧，可拖动排序`}><img src={frame.url} draggable={!mediaImportLocked} alt="" /><span>{pad(index + 1, 2)}</span></button>) : <span className="field-hint">勾选后的帧会出现在这里</span>}</div></div><aside className="animation-settings"><div className="panel-heading"><SlidersHorizontal size={17} /><h3>动画设置</h3></div><div className="field"><label htmlFor="animation-name">动画名称</label><input id="animation-name" value={animationName} maxLength={80} onChange={event => setAnimationName(event.target.value)} placeholder="character_idle" /></div><div className="field"><div className="field-row"><label htmlFor="animation-fps">播放帧率</label><span><strong>{animFps}</strong> FPS</span></div><input id="animation-fps" type="range" min={1} max={60} value={animFps} onChange={event => setAnimFps(+event.target.value)} /><div className="segmented">{[6, 12, 24, 30].map(fps => <button key={fps} className={animFps === fps ? 'active' : ''} onClick={() => setAnimFps(fps)}>{fps} FPS</button>)}</div></div><div className="field"><label htmlFor="loop-mode">播放方式</label><select id="loop-mode" value={loopMode} onChange={event => { setLoopMode(event.target.value as typeof loopMode); setAnimIndex(0); setPlaying(true); }}><option value="loop">循环播放</option><option value="pingpong">往返播放</option><option value="once">单次播放</option></select><p className="field-hint">播放方式用于预览；GIF 导出为循环播放。</p></div><div className="sequence-controls"><button className="button secondary small" disabled={selectedFrames.length < 2 || mediaImportLocked} onClick={() => { if (mediaImportLocked) return; updateFrames(previous => [...previous].reverse()); setAnimIndex(0); }}><ArrowLeft size={14} /> 反转顺序</button><button className="button ghost small" disabled={frames.length < 2 || mediaImportLocked} onClick={() => { if (mediaImportLocked) return; updateFrames(previous => [...previous].sort((a, b) => a.sourceIndex - b.sourceIndex)); setAnimIndex(0); }}><RotateCcw size={14} /> 恢复顺序</button></div><div className="notice"><Layers3 size={16} /><p>在第 03 步设置并预览精灵图布局；完成后到第 07 步选择导出格式。</p></div></aside></div>
      </section>
      <section className="workspace-section" id="step-6"><SectionHeading number={6} title="Real-ESRGAN 平滑处理" actions={<span className="badge">ESR ×4 → 原尺寸</span>}>修整当前动画帧的画面细节，平滑后继续导出或压缩。</SectionHeading><SmoothingPanel frames={animationFrames} fps={animFps} options={options} enabled={smoothingEnabled} onEnabledChange={setSmoothingEnabled} handleRef={smoothingProjectRef} restoreState={panelRestore?.smoothing ? { key: panelRestore.key, state: panelRestore.smoothing } : null} disabled={!!projectBusy || processing || importing || tunerBusy || compressionBusy || mattingOutput.pending} active={activeTab === 'workbench'} onBusyChange={setSmoothingBusy} onResultChange={onSmoothingResult} onNotify={notify} /></section>
      <section className="workspace-section" id="step-7"><SectionHeading number={7} title="动画帧精度压缩" actions={<span className="badge">LANCZOS · PNG</span>}>减小画布与文件体积，同步对比每一帧的轮廓、色彩和透明边缘。</SectionHeading><CompressionPanel handleRef={compressionProjectRef} restoreState={panelRestore?.compression ? { key: panelRestore.key, state: panelRestore.compression } : null} active={activeTab === 'workbench'} frames={outputFrames} fps={animFps} animationName={animationName} sheetColumns={reviewLayout.columns} sheetRows={reviewLayout.rows} disabled={!!projectBusy || processing || importing || tunerBusy || derivedExportBlocked} onBusyChange={setCompressionBusy} onNotify={notify} /></section>
      <section className="card project-save-panel" aria-labelledby="project-save-heading"><div><span className="eyebrow">SAVE YOUR ANIMATION</span><h2 id="project-save-heading">把当前动画留在项目列表</h2><p>保存素材、帧序列和编辑设置，下次从页面顶部打开工程继续。</p><span className="project-save-directory" title={projectDirectory}>保存目录：{projectDirectory || 'FrameAnimProjectList'}</span>{lastSavedProject && <span className="project-saved-path" role="status" title={lastSavedProject}>已保存至 {lastSavedProject}</span>}</div><div className="project-save-actions"><button className="button secondary" disabled={mediaImportLocked || bootstrapping} onClick={() => void chooseProjectDirectory()}><FolderOpen size={16} />选择保存目录</button><button className="button primary" id="save-animation-project" disabled={mediaImportLocked || bootstrapping} onClick={() => void addProject()}>{projectBusy === 'save' ? <LoaderCircle className="spinner" size={17} /> : <Save size={17} />}{projectBusy === 'save' ? '正在保存工程…' : '添加到帧动画项目列表'}</button></div></section>
      <footer className="app-footer"><span><span className="footer-logo">▦</span> Sprite 资产处理台</span><span><ShieldCheck size={13} /> 素材留在你的设备上 <span className="footer-dot">·</span> Made for your next animation</span></footer>
    </main>
      <section id="tuner-panel" className="tuner-tab-panel" role="tabpanel" aria-labelledby="tab-tuner" hidden={activeTab !== 'tuner'}><TunerPanel active={activeTab === 'tuner'} frames={outputFrames} animationName={animationName} fps={animFps} onNotify={notify} onReturnFrames={importTunedFrames} importRequest={tunerImportRequest} onBusyChange={setTunerBusy} disabled={!!projectBusy || processing || importing || compressionBusy || derivedExportBlocked} /></section>
    <input id="workbench-media-input" type="file" ref={mediaInput} accept="video/*,image/png,image/jpeg,image/webp,image/bmp,image/avif" hidden onChange={event => void importMedia(event.target.files?.[0])} />
    <input id="workbench-frames-input" type="file" ref={frameInput} accept="image/png,image/webp,image/jpeg,image/bmp,image/avif" multiple hidden onChange={event => void importAnimation(event.target.files)} />
    <input id="workbench-folder-input" type="file" ref={folderInput} {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)} multiple hidden onChange={event => void importAnimation(event.target.files)} />
    {pendingClipName && <AnimationNameDialog initialName={pendingClipName.initialName} sourceName={pendingClipName.sourceName} newProject={pendingClipName.newProject} onConfirm={name => { setAnimationName(name); setPendingClipName(null); }} onKeepOriginal={() => setPendingClipName(null)} />}
    {toast && <div className="toast" role="status"><Check size={17} /><span>{toast}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast('')}><X size={15} /></button></div>}
    {helpOpen && <div className="modal-backdrop" onClick={() => setHelpOpen(false)}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={event => event.stopPropagation()}><div className="modal-heading"><h2 id="help-title">七步，做出你的动画素材</h2><button className="icon-button" autoFocus aria-label="关闭使用指南" onClick={() => setHelpOpen(false)}><X size={20} /></button></div><div className="modal-body"><ol className="help-steps"><li><strong>导入与截取</strong><p>点击、拖入或粘贴本地视频或图片，视频用起止帧限制动作区间，多图导入显示动画预览与可拖动排序的帧列表。浏览器读取不到源视频帧率时，手动校准 FPS。</p></li><li><strong>设置抽帧</strong><p>选择采样间隔与画布尺寸，点击“开始抽帧并检查”，把未抠图的帧传到第 03 步。</p></li><li><strong>检查与布局</strong><p>勾选要保留的帧，也可导入图片序列。左侧播放动画，手动输入精灵图行列数，右侧帧列表会自动缩放到可见区域。棋盘格用于检查透明区域，播放时高亮当前帧。导出统一放在第 07 步。</p></li><li><strong>修整背景</strong><p>使用绿色、蓝色或其他纯色背景。调整容差、柔化与去色溢，在棋盘格或纯色底上检查边缘。处理第 03 步保留的帧，点击“应用抠图并继续”传入第 05 步。在 AI 模式先加载本地模型，再预览一帧。</p></li><li><strong>调整动画</strong><p>拖动序列中的帧调整顺序，设定帧率并检查循环。空格播放或暂停，左右方向键逐帧检查。</p></li><li><strong>Real-ESRGAN 平滑</strong><p>可选的 ×4 放大并缩回原尺寸；透明帧保留原轮廓，全不透明帧按当前设置抠图。完成后导出和精度压缩使用平滑结果。</p></li><li><strong>精度压缩</strong><p>使用选中帧，或导入图片序列与文件夹。设置输出倍率、透明清理、锐化和减色，生成原图与压缩结果的同步对比；在原始帧或压缩帧下点击“导出”，选择 Frames、Sprite Sheet、透明 MOV 或 GIF；精灵图遵循第 03 步布局。</p></li></ol><div className="notice"><ShieldCheck size={16} /><p>色度抠图在浏览器完成；AI 模式只把帧发送到本机 Python 服务，不上传到外部服务器。刷新页面会清除素材，参数会在本地保存。单次最多处理 400 帧；长视频建议分段处理。</p></div></div><div className="modal-footer"><button className="button primary" onClick={() => setHelpOpen(false)}>开始制作 <ArrowRight size={15} /></button></div></div></div>}
    {inspectedFrame && <div className="modal-backdrop" onClick={() => setInspectedFrame(null)}><div className="modal inspect-modal" role="dialog" aria-modal="true" aria-labelledby="inspect-title" onClick={event => event.stopPropagation()}><div className="modal-heading"><div><h2 id="inspect-title">{inspectedFrame.name}</h2><p className="field-hint">{inspectedFrame.width} × {inspectedFrame.height} px · 源帧 #{inspectedFrame.sourceIndex}</p></div><button className="icon-button" autoFocus aria-label="关闭帧检查" onClick={() => setInspectedFrame(null)}><X size={20} /></button></div><PreviewPane title="帧细节" url={inspectedFrame.url} background={background} /><div className="modal-footer"><button className="button secondary" disabled={mediaImportLocked} onClick={() => { if (mediaImportLocked) return; updateFrames(previous => previous.map(frame => frame.id === inspectedFrame.id ? { ...frame, selected: !frame.selected } : frame)); setInspectedFrame(previous => previous && { ...previous, selected: !previous.selected }); }}>{inspectedFrame.selected ? <X size={15} /> : <Check size={15} />}{inspectedFrame.selected ? '取消选择此帧' : '选择此帧'}</button></div></div></div>}
  </div>;
}
