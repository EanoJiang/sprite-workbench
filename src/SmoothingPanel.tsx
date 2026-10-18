import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Check, CircleHelp, Download, LoaderCircle, Pause, Play, RefreshCw, Sparkles, X } from 'lucide-react';
import type { Frame, ProcessOptions } from './types';
import { getSmoothingStatus, prepareSmoothing, releaseSmoothing, SMOOTHING_PIPELINE_VERSION, smoothFrames, smoothingFrameSignature, smoothingSettingsKey } from './lib/smoothing';
import type { SmoothingResult, SmoothingStatus } from './lib/smoothing';
import type { SmoothingProjectHandle, SmoothingProjectState } from './lib/projectPanelState';
import './smoothing.css';

interface Props {
  frames: Frame[];
  fps: number;
  options: ProcessOptions;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  disabled?: boolean;
  active?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onResultChange: (frames: Frame[] | null) => void;
  onNotify: (message: string) => void;
  handleRef?: RefObject<SmoothingProjectHandle | null>;
  restoreState?: { key: number; state: SmoothingProjectState } | null;
}
interface Completed { result: SmoothingResult; sourceKey: string; settingsKey: string }
interface Job { kind: 'prepare' | 'process'; done: number; total: number }

export default function SmoothingPanel({ frames, fps, options, enabled, onEnabledChange, disabled = false, active = true, onBusyChange, onResultChange, onNotify, handleRef, restoreState }: Props) {
  const [completed, setCompleted] = useState<Completed | null>(null);
  const [status, setStatus] = useState<SmoothingStatus | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const [upgradeNoticeSource, setUpgradeNoticeSource] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const sourceKey = smoothingFrameSignature(frames);
  const settingsKey = smoothingSettingsKey(options);
  const completedRef = useRef<Completed | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const restoredKeyRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const publishedRef = useRef<Frame[] | null>(null);
  const callbacksRef = useRef({ onBusyChange, onResultChange, onNotify, onEnabledChange });
  callbacksRef.current = { onBusyChange, onResultChange, onNotify, onEnabledChange };
  const currentRef = useRef({ frames, options, enabled, disabled, sourceKey, settingsKey });
  currentRef.current = { frames, options, enabled, disabled, sourceKey, settingsKey };
  const pendingRestore = !!restoreState && restoreState.key !== restoredKeyRef.current;
  const valid = !!completed && completed.sourceKey === sourceKey && completed.settingsKey === settingsKey;
  const currentIndex = Math.min(index, Math.max(0, frames.length - 1));
  const original = frames[currentIndex];
  const processed = completed?.sourceKey === sourceKey ? completed.result.frames[currentIndex] : null;
  const blocked = disabled || !!job;

  const publish = useCallback((next: Frame[] | null) => {
    if (publishedRef.current === next) return;
    publishedRef.current = next; callbacksRef.current.onResultChange(next);
  }, []);
  useImperativeHandle(handleRef, () => ({
    getSnapshot: () => {
      const current = currentRef.current;
      const previous = completedRef.current;
      return {
        enabled: current.enabled, options: structuredClone(current.options), pipelineVersion: SMOOTHING_PIPELINE_VERSION,
        frames: previous?.sourceKey === current.sourceKey && previous.settingsKey === current.settingsKey ? previous.result.frames.map(frame => ({ ...frame })) : null,
      };
    },
  }), []);

  useEffect(() => {
    if (!restoreState || restoredKeyRef.current === restoreState.key) return;
    restoredKeyRef.current = restoreState.key;
    generationRef.current++; abortRef.current?.abort(); abortRef.current = null;
    setJob(null); setError(''); setIndex(0); callbacksRef.current.onBusyChange?.(false);
    const saved = restoreState.state;
    const outdatedResult = !!saved.frames?.length && saved.pipelineVersion !== SMOOTHING_PIPELINE_VERSION;
    setUpgradeNoticeSource(outdatedResult ? sourceKey : null);
    const restoredFrames = saved.pipelineVersion === SMOOTHING_PIPELINE_VERSION ? saved.frames?.map(frame => ({ ...frame })) ?? null : null;
    const borrowedUrls = new Set(frames.map(frame => frame.url));
    const result: SmoothingResult | null = restoredFrames?.length ? {
      frames: restoredFrames,
      ownedUrls: [...new Set(restoredFrames.map(frame => frame.url))].filter(url => url.startsWith('blob:') && !borrowedUrls.has(url)),
    } : null;
    const replacement = result ? { result, sourceKey, settingsKey: smoothingSettingsKey(saved.options) } : null;
    const previous = completedRef.current;
    publish(null); completedRef.current = replacement; setCompleted(replacement);
    if (saved.enabled !== enabled) callbacksRef.current.onEnabledChange(saved.enabled);
    if (saved.enabled && replacement?.settingsKey === settingsKey) publish(replacement.result.frames);
    const retained = new Set(result?.ownedUrls ?? []);
    if (previous) releaseSmoothing({ ownedUrls: previous.result.ownedUrls.filter(url => !retained.has(url)) });
  }, [restoreState, frames, sourceKey, settingsKey, enabled, publish]);

  useEffect(() => {
    if (pendingRestore) return;
    setUpgradeNoticeSource(previous => previous === sourceKey ? previous : null);
    const previous = completedRef.current;
    if (previous && previous.sourceKey !== sourceKey) {
      publish(null); completedRef.current = null; setCompleted(null); releaseSmoothing(previous.result);
    }
    abortRef.current?.abort(); setError(''); setIndex(0);
  }, [sourceKey, pendingRestore, publish]);
  useEffect(() => {
    if (pendingRestore) return;
    const previous = completedRef.current;
    publish(enabled && previous?.sourceKey === sourceKey && previous.settingsKey === settingsKey ? previous.result.frames : null);
    if (!enabled) abortRef.current?.abort();
  }, [enabled, sourceKey, settingsKey, pendingRestore, publish]);

  useEffect(() => {
    const controller = new AbortController();
    void getSmoothingStatus(controller.signal).then(next => { if (!controller.signal.aborted) setStatus(next); }).catch(reason => { if (!controller.signal.aborted) setStatus({ ready: false, message: reason instanceof Error ? reason.message : '无法读取平滑服务状态。' }); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!active || !enabled || !playing || frames.length < 2) return;
    const timer = window.setInterval(() => setIndex(value => (value + 1) % frames.length), 1000 / Math.max(1, Math.min(60, fps)));
    return () => window.clearInterval(timer);
  }, [active, enabled, playing, frames.length, fps]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false; generationRef.current++; abortRef.current?.abort(); abortRef.current = null;
      queueMicrotask(() => {
        if (mountedRef.current) return;
        publish(null); releaseSmoothing(completedRef.current?.result ?? null); completedRef.current = null;
      });
    };
  }, [publish]);

  async function run(kind: Job['kind']) {
    const requested = currentRef.current;
    if (requested.disabled || abortRef.current || (kind === 'process' && (!requested.enabled || !requested.frames.length))) return;
    const controller = new AbortController(); abortRef.current = controller;
    const generation = ++generationRef.current;
    setJob({ kind, done: 0, total: kind === 'process' ? requested.frames.length : 0 }); setError(''); callbacksRef.current.onBusyChange?.(true);
    try {
      if (kind === 'prepare') {
        const next = await prepareSmoothing(controller.signal);
        if (!mountedRef.current || controller.signal.aborted || generation !== generationRef.current) return;
        setStatus(next);
        if (!next.ready) throw new Error(next.error || next.message || '平滑模型尚未就绪。');
        callbacksRef.current.onNotify('平滑模型已就绪，可以处理当前帧。');
      } else {
        const result = await smoothFrames(requested.frames, requested.options, {
          signal: controller.signal,
          onProgress: (done, total) => { if (mountedRef.current && generation === generationRef.current) setJob({ kind, done, total }); },
        });
        const current = currentRef.current;
        if (!mountedRef.current || controller.signal.aborted || generation !== generationRef.current || current.sourceKey !== requested.sourceKey || current.settingsKey !== requested.settingsKey) { releaseSmoothing(result); return; }
        const previous = completedRef.current;
        const replacement = { result, sourceKey: requested.sourceKey, settingsKey: requested.settingsKey };
        publish(null); completedRef.current = replacement; setCompleted(replacement); setIndex(0); setUpgradeNoticeSource(null);
        if (current.enabled) publish(result.frames);
        releaseSmoothing(previous?.result ?? null);
        callbacksRef.current.onNotify(`已完成 ${result.frames.length} 帧平滑，后续导出和压缩已同步。`);
      }
    } catch (reason) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      if (controller.signal.aborted || (reason instanceof Error && reason.name === 'AbortError')) callbacksRef.current.onNotify('平滑处理已取消，保留上一次完成的结果。');
      else { const message = reason instanceof Error ? reason.message : '平滑处理失败，请重试。'; setError(message); callbacksRef.current.onNotify(message); }
    } finally {
      if (generation === generationRef.current) { abortRef.current = null; setJob(null); callbacksRef.current.onBusyChange?.(false); }
    }
  }

  return <div className="smoothing-panel">
    <div className="card smoothing-controls">
      <div className="smoothing-title-row"><label className="smoothing-toggle"><input type="checkbox" id="smoothing-enabled" checked={enabled} disabled={blocked} onChange={event => onEnabledChange(event.target.checked)} /><span><strong>启用平滑处理</strong><small>当前已选帧 → Real-ESRGAN ×4 → 原尺寸</small></span></label><span className="badge">可选步骤</span></div>
      <p className="smoothing-description">整理线条与细节，保持帧数、顺序和画布尺寸。透明帧保留原有透明度与轮廓，仅增强颜色；全不透明帧按当前设置抠图。完成后，导出与精度压缩使用平滑结果；关闭后使用上一步的帧。</p>
      <div className="smoothing-actions"><span className={`smoothing-runtime ${status?.ready ? 'ready' : ''}`} role="status">{status?.ready ? <Check size={14} /> : <CircleHelp size={14} />}<span>{status?.ready ? '官方 NCNN / realesrgan-x4plus-anime · ×4' : status?.message || '正在读取平滑模型状态…'} · <a href="https://github.com/xinntao/Real-ESRGAN#portable-executable-files-ncnn" target="_blank" rel="noopener noreferrer">官方项目</a></span></span><div>{!status?.ready && <button className="button secondary small" disabled={blocked} onClick={() => void run('prepare')}>{job?.kind === 'prepare' ? <LoaderCircle className="spinner" size={14} /> : <Download size={14} />}{job?.kind === 'prepare' ? '正在准备模型…' : '准备平滑模型'}</button>}<button id="smoothing-generate" className="button primary" disabled={blocked || !enabled || !frames.length || !status?.ready} onClick={() => void run('process')}>{job?.kind === 'process' ? <LoaderCircle className="spinner" size={15} /> : <Sparkles size={15} />}{job?.kind === 'process' ? '正在平滑…' : valid ? '重新平滑' : '开始平滑'}</button></div></div>
      <div id="smoothing-status" className={`smoothing-result-status ${valid && enabled ? 'ready' : ''}`} data-state={job ? 'processing' : !enabled ? 'disabled' : valid ? 'ready' : 'pending'} role="status">{job ? <><LoaderCircle className="spinner" size={14} /><span>{job.kind === 'prepare' ? '正在准备平滑模型' : `正在平滑 ${job.done} / ${job.total}`}</span>{job.kind === 'process' && <progress max={job.total} value={job.done} />}<button className="button ghost small" onClick={() => abortRef.current?.abort()}><X size={13} />取消</button></> : <><span>{!enabled ? '未启用 · 使用上一步的帧' : valid ? `${frames.length} 帧已完成 · 导出与压缩已同步` : !frames.length ? '先抽取或导入动画帧' : '点击“开始平滑”，完成后用于后续导出和压缩'}</span>{completed && !valid && <small>输入或处理参数已改变，请重新平滑。</small>}</>}</div>
      {upgradeNoticeSource === sourceKey && <p className="smoothing-error" role="status">平滑算法已更新，请重新处理以修正透明边缘。</p>}
      {error && <p className="smoothing-error" role="alert">{error}</p>}
    </div>
    {enabled && <div className="card smoothing-comparison"><div className="smoothing-preview-heading"><div><h3>平滑前后对比</h3><p>两侧同步播放同一帧。{completed && !valid ? '右侧为上次完成的结果。' : '透明网格用于检查轮廓与边缘。'}</p></div><span>{frames.length} 帧 · {fps} FPS</span></div><div className="smoothing-preview-grid">{[{ title: '当前帧', frame: original, kind: 'before' }, { title: '平滑后', frame: processed, kind: 'after' }].map(pane => <div className="smoothing-preview-pane" key={pane.kind} data-kind={pane.kind}><div><strong>{pane.title}</strong><span>{pane.frame ? `${pane.frame.width} × ${pane.frame.height}` : '等待处理'}</span></div><div className="smoothing-image checker">{pane.frame ? <img src={pane.frame.url} alt={`${pane.title}：${pane.frame.name}`} draggable={false} /> : <div className="smoothing-empty"><Sparkles size={27} /><span>{pane.kind === 'before' ? '先选择动画帧' : '处理完成后显示结果'}</span></div>}</div></div>)}</div><div className="smoothing-transport"><button className="icon-button" aria-label={playing ? '暂停平滑对比动画' : '播放平滑对比动画'} disabled={frames.length < 2} onClick={() => setPlaying(value => !value)}>{playing ? <Pause size={15} /> : <Play size={15} />}</button><input type="range" aria-label="平滑对比当前帧" min={0} max={Math.max(1, frames.length - 1)} value={currentIndex} disabled={!frames.length} onChange={event => { setPlaying(false); setIndex(Number(event.target.value)); }} /><span>{frames.length ? currentIndex + 1 : 0} / {frames.length}</span><button className="button ghost small" disabled={!frames.length} onClick={() => { setPlaying(false); setIndex(0); }}><RefreshCw size={12} />回到首帧</button></div></div>}
  </div>;
}
