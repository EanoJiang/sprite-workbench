import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, CircleAlert, ExternalLink, Film, FolderOpen, Frame as FrameIcon, Github, Layers3, LoaderCircle, Maximize2, Minimize2, RefreshCw, ShieldCheck, SlidersHorizontal, Sparkles } from 'lucide-react';
import type { Frame } from './types';
import { getTunerStatus, localTunerUrl, sendFramesToTuner, sourceCanvasForFrames, startTuner } from './lib/tuner';
import type { TunerProgress, TunerStatus } from './lib/tuner';
import './tuner.css';

interface Props {
  active: boolean;
  frames: Frame[];
  animationName: string;
  fps: number;
  onNotify: (message: string) => void;
  onReturnFrames: (files: File[], fps: number, animationName: string) => Promise<void> | void;
  importRequest: number;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}

interface EditorSession { id: string; url: string; label: string; frameCount: number; fps: number; loaded: boolean; }
interface ReturnFrame { index: number; data: string; width: number; height: number; sourceFrameIndex: number; durationMs: number; }

export default function TunerPanel({ active, frames, animationName, fps, onNotify, onReturnFrames, importRequest, onBusyChange, disabled = false }: Props) {
  const [service, setService] = useState<TunerStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [, setProgress] = useState<TunerProgress | null>(null);
  const [error, setError] = useState('');
  const [sessions, setSessions] = useState<EditorSession[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [returning, setReturning] = useState(false);
  const [returnProgress, setReturnProgress] = useState({ done: 0, total: 0 });
  const editorRef = useRef<HTMLDivElement>(null);
  const startPromise = useRef<Promise<TunerStatus> | null>(null);
  const attemptedStart = useRef(false);
  const transferLock = useRef(false);
  const handledRequest = useRef(0);
  const transferAbort = useRef<AbortController | null>(null);
  const iframeRefs = useRef<Record<string, HTMLIFrameElement | null>>({});
  const returnRequest = useRef<{ id: string; sessionId: string; frames: ReturnFrame[] } | null>(null);
  const current = sessions.find(session => session.id === sessionId);
  const busy = starting || transferring || returning;

  const ensureStarted = useCallback(async (): Promise<TunerStatus> => {
    if (startPromise.current) return startPromise.current;
    setStarting(true); setError('');
    const pending = (async () => {
      let status = await getTunerStatus();
      if (!status.running) status = await startTuner();
      if (!status.running || !status.url) throw new Error(status.error || '调参服务尚未就绪，请稍后重试。');
      const url = localTunerUrl(status.url);
      setService(status);
      setSessions(previous => previous.length ? previous : [{ id: 'library', url, label: '调参素材库', frameCount: 0, fps: 0, loaded: false }]);
      setSessionId(previous => previous || 'library');
      return status;
    })();
    startPromise.current = pending;
    try { return await pending; }
    finally { startPromise.current = null; setStarting(false); }
  }, []);

  useEffect(() => {
    if (!active || attemptedStart.current) return;
    attemptedStart.current = true;
    void ensureStarted().catch(reason => setError(reason instanceof Error ? reason.message : '无法启动调参服务。'));
  }, [active, ensureStarted]);

  // The parent workbench must remain unlocked for the returned PNGs to enter
  // step 05. The tuner surface still disables its own controls while a return
  // is in flight via `busy` below.
  useEffect(() => { onBusyChange?.(starting || transferring); }, [starting, transferring, onBusyChange]);
  useEffect(() => {
    const dataUrlFile = async (data: string, name: string): Promise<File> => {
      const response = await fetch(data);
      if (!response.ok) throw new Error('无法读取 XSXB 返回的精调帧。');
      return new File([await response.blob()], name, { type: 'image/png' });
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || !String(data.type || '').startsWith('framecraft-')) return;
      const session = sessions.find(item => {
        const iframe = iframeRefs.current[item.id];
        if (!iframe || event.source !== iframe.contentWindow) return false;
        try { return event.origin === new URL(item.url).origin; } catch { return false; }
      });
      if (!session) return;
      if (data.type === 'framecraft-tuner-state') {
        setSessions(previous => previous.map(item => item.id === session.id ? {
          ...item,
          loaded: true,
          label: item.id === 'library' && data.animationId ? String(data.animationId) : item.label,
          frameCount: Math.max(0, Number(data.frameCount) || item.frameCount),
          fps: Number(data.fps) > 0 ? Number(data.fps) : item.fps,
        } : item));
        return;
      }
      if (!data.type.startsWith('framecraft-return-')) return;
      const pending = returnRequest.current;
      if (!pending || data.requestId !== pending.id || pending.sessionId !== session.id) return;
      const iframe = iframeRefs.current[pending.sessionId];
      if (!iframe) return;
      try {
        if (data.type === 'framecraft-return-start') {
          setReturnProgress({ done: 0, total: Math.max(0, Number(data.total) || 0) });
          return;
        }
        if (data.type === 'framecraft-return-frame') {
          pending.frames[Number(data.index) || 0] = {
            index: Number(data.index) || 0,
            data: String(data.data || ''),
            width: Number(data.width) || 0,
            height: Number(data.height) || 0,
            sourceFrameIndex: Number(data.sourceFrameIndex) || Number(data.index) || 0,
            durationMs: Number(data.durationMs) || 0,
          };
          setReturnProgress(previous => ({ ...previous, done: previous.done + 1 }));
          return;
        }
        if (data.type === 'framecraft-return-error') {
          throw new Error(String(data.message || 'XSXB 无法返回精调结果。'));
        }
        if (data.type !== 'framecraft-return-complete') return;
        const returned = pending.frames.filter(Boolean).sort((a, b) => a.index - b.index);
        if (!returned.length) throw new Error('XSXB 没有返回可用的精调帧。');
        returnRequest.current = null;
        void Promise.all(returned.map((frame, index) => dataUrlFile(frame.data, `${session.label || 'animation'}_frame_${String(index + 1).padStart(4, '0')}.png`)))
          .then(files => onReturnFrames(files, Number(data.fps) || session.fps || fps, session.label || animationName))
          .then(() => onNotify(`已保存并返回 ${returned.length} 帧精调结果，正在打开第 5 步动画预览。`))
          .catch(error => onNotify(error instanceof Error ? error.message : '导入精调结果失败。'))
          .finally(() => { setReturning(false); setReturnProgress({ done: 0, total: 0 }); });
      } catch (error) {
        returnRequest.current = null;
        setReturning(false);
        setReturnProgress({ done: 0, total: 0 });
        onNotify(error instanceof Error ? error.message : '无法返回精调结果。');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [animationName, fps, onNotify, onReturnFrames, sessions]);
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === editorRef.current);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  const transfer = useCallback(async () => {
    if (transferLock.current) return;
    if (disabled) { onNotify('素材仍在处理中，请完成当前操作后再发送。'); return; }
    if (!frames.length) { onNotify('请先在抽帧工作台勾选动画帧。'); return; }
    transferLock.current = true; setTransferring(true); setError('');
    const snapshot = [...frames]; const name = animationName.trim() || 'animation';
    const controller = new AbortController(); transferAbort.current = controller;
    try {
      await ensureStarted();
      const result = await sendFramesToTuner(snapshot, name, fps, setProgress, controller.signal);
      const id = `${result.project}/${result.animation}`;
      const session: EditorSession = { id, url: result.editorUrl || result.url, label: name, frameCount: result.frameCount || snapshot.length, fps, loaded: false };
      setSessions(previous => [...previous, session]); setSessionId(id);
      onNotify(`已发送 ${session.frameCount} 帧，已打开「${name}」独立调参项目。`);
    } catch (reason) {
      if (controller.signal.aborted) return;
      const message = reason instanceof Error ? reason.message : '发送动画帧失败，请重试。'; setError(message); onNotify(message);
    } finally { transferLock.current = false; transferAbort.current = null; setTransferring(false); setProgress(null); }
  }, [animationName, disabled, ensureStarted, fps, frames, onNotify]);

  const returnTunedFrames = useCallback(() => {
    if (!current || busy || returning || disabled) return;
    const iframe = iframeRefs.current[current.id];
    if (!current.loaded || !iframe?.contentWindow) { onNotify('调参编辑器尚未加载完成，请稍后重试。'); return; }
    const requestId = `framecraft-return-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    returnRequest.current = { id: requestId, sessionId: current.id, frames: [] };
    setReturning(true);
    setReturnProgress({ done: 0, total: 0 });
    const origin = new URL(current.url).origin;
    const sourceCanvas = sourceCanvasForFrames(frames);
    iframe.contentWindow.postMessage({ type: 'framecraft-save-and-return', requestId, fps, canvas: sourceCanvas }, origin);
  }, [busy, current, disabled, fps, frames, onNotify, returning]);

  useEffect(() => {
    if (!active || importRequest <= handledRequest.current) return;
    handledRequest.current = importRequest;
    void transfer();
  }, [active, importRequest, transfer]);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await editorRef.current?.requestFullscreen();
    } catch { onNotify('当前窗口不支持全屏，可以在新标签页打开调参工具。'); }
  }

  return <section className="tuner-workspace" hidden={!active} aria-label="XSXB 动画调参工作台">
    <div className="tuner-heading"><div><div className="eyebrow">FRAME TUNING · 动画后期工作台</div><h1>让每一帧，<span>恰到好处。</span></h1><p>调整位移、节奏与拖尾，打包可以直接使用的动画素材。</p></div><a className="tuner-source-link" href="https://github.com/sparklecatta-lang/XSXB-Frame-Tuner" target="_blank" rel="noreferrer"><Github size={15} /> XSXB Frame Tuner <ExternalLink size={12} /></a></div>

      <div className="card tuner-transfer-bar"><span className="tuner-transfer-icon"><Layers3 size={22} /></span><div className="tuner-source-summary"><strong>{frames.length ? animationName || '未命名动画' : '从抽帧工作台，接着做下去'}</strong><p>{frames.length ? <><b>{frames.length}</b> 帧已选 <span>·</span> {fps} FPS <span>·</span> 保留透明通道与播放顺序</> : '先勾选动画帧，或在下方编辑器中打开已有项目。'}</p></div><div className="tuner-transfer-actions"><button className="button primary tuner-send-button" disabled={!current || current.frameCount < 1 || !current.loaded || busy || disabled} onClick={returnTunedFrames}>{returning ? `正在保存并返回 ${returnProgress.total ? `${returnProgress.done} / ${returnProgress.total}` : '…'}` : '保存精调结果返回 05 动画帧选取与预览'}{!returning && <ArrowRight size={14} />}</button></div></div>
    <div className="tuner-persistence-note"><ShieldCheck size={12} /><span>每次发送创建独立调参项目，已有改动会保留。完成精调后点击上方按钮，会先保存再把结果带回第 05 步。</span></div>

    {error && <div className="tuner-error" role="alert"><CircleAlert size={18} /><div><strong>暂时无法完成操作</strong><p>{error}</p></div><button className="button secondary small" disabled={busy} onClick={() => void ensureStarted().catch(reason => setError(reason instanceof Error ? reason.message : '启动失败，请重试。'))}><RefreshCw size={13} /> 重试连接</button></div>}

    <div className={`card tuner-editor-card ${fullscreen ? 'is-fullscreen' : ''}`} ref={editorRef}>
      <div className="tuner-editor-toolbar"><div className="tuner-editor-title"><span className="tuner-tool-mark"><SlidersHorizontal size={16} /></span><strong>动画调参</strong><span className="badge">LITE</span><span className={`tuner-service-pill ${service?.running ? 'ready' : ''}`}><span className="status-dot" />{starting ? '正在启动本地服务' : service?.running ? '本地服务已连接' : '等待连接'}</span></div><div className="tuner-editor-actions">{current && <a className="button ghost small" href={current.url} target="_blank" rel="noreferrer"><ExternalLink size={13} /><span>新标签页打开</span></a>}<button className="icon-button" aria-label={fullscreen ? '退出调参工具全屏' : '全屏打开调参工具'} title={fullscreen ? '退出全屏' : '全屏编辑'} disabled={!current} onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button></div></div>

      {sessions.length > 1 && <div className="tuner-session-tabs" role="tablist" aria-label="已打开的调参项目">{sessions.map(session => <button key={session.id} role="tab" aria-selected={session.id === sessionId} aria-controls={`tuner-session-${session.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`} className={session.id === sessionId ? 'active' : ''} onClick={() => setSessionId(session.id)}>{session.frameCount ? <Film size={12} /> : <FolderOpen size={12} />}<span>{session.label}</span>{session.frameCount > 0 && <small>{session.frameCount} 帧</small>}{session.id === sessionId && <Check size={11} />}</button>)}</div>}

      <div className="tuner-editor-surface">{sessions.map(session => <div key={session.id} className="tuner-editor-session" hidden={session.id !== sessionId} id={`tuner-session-${session.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`} role="tabpanel" aria-label={session.label}>
        <iframe ref={element => { iframeRefs.current[session.id] = element; }} className="tuner-iframe" src={session.url} title={`XSXB 动画调参：${session.label}`} allow="fullscreen" allowFullScreen onLoad={() => setSessions(previous => previous.map(item => item.id === session.id ? { ...item, loaded: true } : item))} />
        {!session.loaded && <div className="tuner-frame-loading" role="status"><LoaderCircle size={23} className="tuner-loader" /><strong>正在打开动画编辑器</strong><p>加载角色、帧序列与调参面板…</p></div>}
      </div>)}{!sessions.length && <div className="tuner-launch-state" role="status"><span className={`tuner-launch-icon ${starting ? 'loading' : ''}`}>{starting ? <LoaderCircle size={29} /> : <SlidersHorizontal size={29} />}</span><h2>{starting ? '正在准备你的调参空间' : error ? '连接本地编辑器后，继续创作' : '独立的动画后期空间'}</h2><p>{starting ? '启动 XSXB Frame Tuner Lite，第一次打开需要稍等片刻。' : '逐帧对齐、时间微调、附加图层与拖尾编辑，都在这里。'}</p>{!starting && <button className="button secondary" onClick={() => void ensureStarted().catch(reason => setError(reason instanceof Error ? reason.message : '无法启动编辑器。'))}><RefreshCw size={14} /> 启动调参工具</button>}<div className="tuner-feature-chips"><span><FrameIcon size={13} /> 逐帧调节</span><span><Sparkles size={13} /> 拖尾与附加图层</span><span><Layers3 size={13} /> PNG / Sheet 导出</span></div></div>}</div>

      <div className="tuner-editor-footer"><span><ShieldCheck size={12} /> 编辑与保存均在本机完成</span><span>XSXB Frame Tuner Lite <span className="tuner-footer-dot">·</span> 项目保存在本地{service?.source_revision && <code>{service.source_revision.slice(0, 7)}</code>}</span></div>
    </div>
    <div className="tuner-bottom-note"><SlidersHorizontal size={13} /><p>在下方编辑器中完成逐帧调整、时长和拖尾设置，再点击上方按钮保存并回传 PNG 序列。当前调参项目会继续保留。</p></div>
  </section>;
}
