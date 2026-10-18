import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ArrowRight, Check, CircleHelp, Eye, LoaderCircle, Pause, Play, RefreshCw, Repeat2, ShieldCheck, X } from 'lucide-react';
import type { Frame } from './types';
import { correctLoopFrames, defaultLoopCorrectionSettings, loopFrameSignature, releaseLoopCorrection } from './lib/loopCorrection';
import type { LoopCorrectionResult, LoopCorrectionSettings } from './lib/loopCorrection';
import type { LoopCorrectionProjectHandle, LoopCorrectionProjectState } from './lib/projectPanelState';
import { restoreLoopCorrectionResult } from './lib/projectPanelState';
import './loop-correction.css';

interface Props {
  frames: Frame[];
  fps: number;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  disabled?: boolean;
  active?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onResultChange: (frames: Frame[] | null) => void;
  onNotify: (message: string) => void;
  handleRef?: RefObject<LoopCorrectionProjectHandle | null>;
  restoreState?: { key: number; state: LoopCorrectionProjectState } | null;
}
interface Completed { result: LoopCorrectionResult; sourceKey: string; settingsKey: string; originalDifferenceKnown?: boolean }

export default function LoopCorrectionPanel({ frames, fps, enabled, onEnabledChange, disabled = false, active = true, onBusyChange, onResultChange, onNotify, handleRef, restoreState }: Props) {
  const [settings, setSettings] = useState<LoopCorrectionSettings>(defaultLoopCorrectionSettings);
  const [completed, setCompleted] = useState<Completed | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 1 });
  const [error, setError] = useState('');
  const [overlay, setOverlay] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [seamIndex, setSeamIndex] = useState(0);
  const sourceKey = loopFrameSignature(frames);
  const settingsKey = JSON.stringify(settings);
  const completedRef = useRef<Completed | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const generationRef = useRef(0);
  const restoredKeyRef = useRef<number | null>(null);
  const pendingRestore = !!restoreState && restoredKeyRef.current !== restoreState.key;
  const automaticAttemptRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const publishedRef = useRef<Frame[] | null>(null);
  const callbacksRef = useRef({ onBusyChange, onResultChange, onNotify });
  callbacksRef.current = { onBusyChange, onResultChange, onNotify };
  const currentRef = useRef({ frames, sourceKey, settings, settingsKey, enabled, disabled });
  currentRef.current = { frames, sourceKey, settings, settingsKey, enabled, disabled };
  const valid = !!completed && completed.sourceKey === sourceKey && completed.settingsKey === settingsKey;
  const stale = !!completed && !valid;
  const result = completed?.sourceKey === sourceKey ? completed.result : null;
  const first = frames[0];
  const last = frames[frames.length - 1];
  const correctedLast = result?.frames[result.frames.length - 1];
  const tailCount = Math.min(3, Math.ceil(frames.length / 2));
  const headCount = Math.min(3, frames.length - tailCount);
  const seamIndices = frames.length > 1 ? [...Array.from({ length: tailCount }, (_, index) => frames.length - tailCount + index), ...Array.from({ length: headCount }, (_, index) => index)] : [];
  const previewFrames = enabled && valid && result ? result.frames : frames;
  const shownSeamIndex = seamIndices[Math.min(seamIndex, Math.max(0, seamIndices.length - 1))];
  const previewFrame = previewFrames[shownSeamIndex];

  useImperativeHandle(handleRef, () => ({
    getSnapshot: () => {
      const current = currentRef.current;
      const previous = completedRef.current;
      const saved = previous?.sourceKey === current.sourceKey && previous.settingsKey === current.settingsKey ? previous : null;
      return {
        enabled: current.enabled, settings: { ...current.settings },
        frames: saved ? saved.result.frames.map(frame => ({ ...frame })) : null,
        ...(saved && saved.originalDifferenceKnown !== false ? { originalDifference: { ...saved.result.originalDifference } } : {}),
        ...(saved ? { changedCount: saved.result.changedCount } : {}),
      };
    },
  }), []);

  const publish = useCallback((next: Frame[] | null) => {
    if (publishedRef.current === next) return;
    publishedRef.current = next;
    callbacksRef.current.onResultChange(next);
  }, []);

  const changeSettings = (next: LoopCorrectionSettings) => {
    if (JSON.stringify(next) === currentRef.current.settingsKey) return;
    // Invalidate downstream exports in the same event that edits the settings.
    publish(null); setError(''); setSettings(next);
  };

  const generate = useCallback(async () => {
    const requested = currentRef.current;
    if (!requested.enabled || requested.disabled || busyRef.current || requested.frames.length < 2) return;
    const snapshot = requested.frames.map(frame => ({ ...frame }));
    const controller = new AbortController();
    const generation = ++generationRef.current;
    abortRef.current = controller; busyRef.current = true;
    setBusy(true); setProgress({ done: 0, total: 1 }); setError('');
    callbacksRef.current.onBusyChange?.(true);
    try {
      const next = await correctLoopFrames(snapshot, requested.settings, {
        signal: controller.signal,
        onProgress: (done, total) => { if (mountedRef.current && generation === generationRef.current) setProgress({ done, total }); },
      });
      const current = currentRef.current;
      if (!mountedRef.current || generation !== generationRef.current || controller.signal.aborted || current.sourceKey !== requested.sourceKey || current.settingsKey !== requested.settingsKey) {
        releaseLoopCorrection(next); return;
      }
      const previous = completedRef.current;
      const replacement = { result: next, sourceKey: requested.sourceKey, settingsKey: requested.settingsKey };
      // Consumers drop borrowed URLs before old generated URLs are released.
      publish(null);
      completedRef.current = replacement; setCompleted(replacement); setSeamIndex(0);
      if (current.enabled) publish(next.frames);
      releaseLoopCorrection(previous?.result ?? null);
      callbacksRef.current.onNotify(`已修正 ${next.changedCount} 帧，首尾画面与透明通道一致，预览和导出已同步。`);
    } catch (reason) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      if (controller.signal.aborted || (reason instanceof Error && reason.name === 'AbortError')) callbacksRef.current.onNotify('首尾修正已取消，保留上一次完成的结果。');
      else {
        const message = reason instanceof Error ? reason.message : '首尾修正失败，请重试。';
        setError(message); callbacksRef.current.onNotify(message);
      }
    } finally {
      if (generation === generationRef.current) {
        if (abortRef.current === controller) abortRef.current = null;
        busyRef.current = false;
        callbacksRef.current.onBusyChange?.(false);
        if (mountedRef.current) setBusy(false);
      }
    }
  }, [publish]);

  useEffect(() => {
    if (!restoreState || restoredKeyRef.current === restoreState.key) return;
    restoredKeyRef.current = restoreState.key;
    generationRef.current++; abortRef.current?.abort(); abortRef.current = null; busyRef.current = false;
    setBusy(false); callbacksRef.current.onBusyChange?.(false);
    const saved = restoreState.state;
    const restoredSettings = { ...saved.settings };
    const restoredSettingsKey = JSON.stringify(restoredSettings);
    const restoredResult = restoreLoopCorrectionResult(saved, frames);
    const replacement: Completed | null = restoredResult ? {
      sourceKey, settingsKey: restoredSettingsKey, originalDifferenceKnown: !!saved.originalDifference,
      result: restoredResult,
    } : null;
    const previous = completedRef.current;
    publish(null); completedRef.current = replacement; setCompleted(replacement);
    setSettings(restoredSettings); setError(''); setSeamIndex(0);
    currentRef.current = { frames, sourceKey, settings: restoredSettings, settingsKey: restoredSettingsKey, enabled: saved.enabled, disabled };
    automaticAttemptRef.current = replacement ? sourceKey : null;
    if (enabled !== saved.enabled) onEnabledChange(saved.enabled);
    if (saved.enabled && replacement) publish(replacement.result.frames);
    // Parent frames remain borrowed; only restored object URLs belong to this panel.
    const retainedUrls = new Set(restoredResult?.ownedUrls ?? []);
    if (previous) releaseLoopCorrection({ ownedUrls: previous.result.ownedUrls.filter(url => !retainedUrls.has(url)) });
  }, [restoreState, frames, sourceKey, enabled, disabled, onEnabledChange, publish]);

  useEffect(() => {
    if (pendingRestore) return;
    const previous = completedRef.current;
    if (previous && previous.sourceKey !== sourceKey) {
      publish(null); completedRef.current = null; setCompleted(null);
      releaseLoopCorrection(previous.result);
    }
    abortRef.current?.abort(); setError(''); setSeamIndex(0);
  }, [sourceKey, publish, pendingRestore]);

  useEffect(() => {
    if (pendingRestore) return;
    const previous = completedRef.current;
    publish(enabled && previous?.sourceKey === sourceKey && previous.settingsKey === settingsKey ? previous.result.frames : null);
    if (!enabled) abortRef.current?.abort();
  }, [enabled, sourceKey, settingsKey, publish, pendingRestore]);

  // Enabling the feature or choosing a new sequence creates a current result automatically.
  // Parameter edits keep the previous comparison visible until the user generates again.
  useEffect(() => {
    if (pendingRestore) return;
    if (!enabled) { automaticAttemptRef.current = null; return; }
    if (!disabled && frames.length >= 2 && !busyRef.current && automaticAttemptRef.current !== sourceKey && (!completedRef.current || completedRef.current.sourceKey !== sourceKey)) {
      automaticAttemptRef.current = sourceKey; void generate();
    }
  }, [enabled, disabled, sourceKey, frames.length, busy, generate, pendingRestore]);

  useEffect(() => {
    if (!active || !enabled || !playing || seamIndices.length < 2) return;
    const timer = window.setInterval(() => setSeamIndex(value => (value + 1) % seamIndices.length), 1000 / Math.max(1, Math.min(60, fps)));
    return () => window.clearInterval(timer);
  }, [active, playing, fps, seamIndices.length]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false; generationRef.current++; abortRef.current?.abort(); abortRef.current = null;
      busyRef.current = false; automaticAttemptRef.current = null;
      // React may replay effects during development without unmounting this panel.
      queueMicrotask(() => {
        if (mountedRef.current) return;
        publish(null); releaseLoopCorrection(completedRef.current?.result ?? null); completedRef.current = null;
      });
    };
  }, [publish]);

  const blocked = disabled || busy;
  const status = busy ? 'generating' : !enabled ? 'disabled' : error ? 'error' : valid ? 'ready' : 'pending';
  const statusText = busy ? '正在修正首尾帧…' : !enabled ? '未启用 · 使用原始帧' : error ? '修正失败，请重试' : valid ? '首尾已一致 · 预览与导出已同步' : frames.length < 2 ? '至少选择 2 帧后自动修正' : '参数已修改，生成后用于预览和导出';

  return <div className="loop-correction-panel" data-enabled={enabled}>
    <div className="card loop-correction-controls">
      <div className="loop-correction-toggle-row">
        <label className="loop-correction-toggle" htmlFor="loop-correction-enabled"><input id="loop-correction-enabled" type="checkbox" checked={enabled} disabled={blocked} onChange={event => onEnabledChange(event.target.checked)} /><span><strong>启用首尾帧修正</strong><small>建议循环动画启用首尾修正。修正后，检查、预览和导出统一使用结果。</small></span></label>
        <span className="loop-correction-recommendation"><Repeat2 size={13} />可选步骤 · 保留帧数与顺序</span>
      </div>
      <div className="loop-correction-settings">
        <label><span>修正方式</span><select aria-label="首尾修正方式" value={settings.mode} disabled={blocked || !enabled} onChange={event => changeSettings({ ...settings, mode: event.target.value as LoopCorrectionSettings['mode'] })}><option value="match">末帧匹配首帧</option><option value="blend">平滑尾部过渡</option></select></label>
        <label><span>过渡帧数</span><input aria-label="首尾过渡帧数" type="number" min={1} max={Math.max(1, frames.length - 1)} value={Math.min(settings.transitionFrames, Math.max(1, frames.length - 1))} disabled={blocked || !enabled || settings.mode !== 'blend'} onChange={event => changeSettings({ ...settings, transitionFrames: Math.max(1, Math.min(Math.max(1, frames.length - 1), Number(event.target.value) || 1)) })} /></label>
        <div className="loop-correction-mode-help"><ShieldCheck size={15} /><p>{settings.mode === 'match' ? '将首帧完整 PNG 复制到末帧，保证尺寸、色彩与透明通道一致。' : '将尾部数帧逐步混合到首帧，最后一帧精确匹配。姿势差异较大时可能出现重影。'}</p></div>
        <button className="button primary" id="loop-correction-generate" disabled={blocked || !enabled || frames.length < 2} onClick={() => void generate()}>{busy ? <LoaderCircle className="loop-correction-spin" /> : <RefreshCw />}{busy ? '正在修正…' : valid ? '重新修正首尾帧' : '修正首尾帧'}</button>
      </div>
      <div className={`loop-correction-status ${valid && enabled ? 'ready' : ''}`} id="loop-correction-status" data-state={status} role="status" aria-live="polite">{busy ? <LoaderCircle className="loop-correction-spin" size={15} /> : valid && enabled ? <Check size={15} /> : <CircleHelp size={15} />}<span>{statusText}</span>{busy && <><progress max={progress.total} value={progress.done} /><button className="button ghost small" onClick={() => abortRef.current?.abort()}><X size={13} />取消修正</button></>}{stale && <span className="loop-correction-stale">下方为上次结果</span>}</div>
      {error && <p className="loop-correction-error" role="alert">{error}</p>}
    </div>

    {enabled && <div className="card loop-correction-comparison">
      <div className="loop-correction-comparison-heading"><div><h3>循环接缝预览</h3><p>先放大检查末尾到开头的动作衔接，再对照下方首尾画面。</p></div><span className={`loop-correction-preview-mode ${enabled && valid ? 'corrected' : ''}`}>{enabled && valid ? '修正后' : '原始序列'}</span></div>
      <div className="loop-correction-seam" aria-label="循环接缝主预览">
        <div className="loop-correction-seam-image checker" data-frame-index={shownSeamIndex ?? -1}>
          {previewFrame ? <img src={previewFrame.url} alt={`接缝预览第 ${shownSeamIndex + 1} 帧`} draggable={false} /> : <div className="loop-correction-seam-empty"><Repeat2 size={32} /><strong>循环接缝主预览</strong><p>抽取或导入动画帧后，在这里检查循环衔接。</p></div>}
        </div>
        <div className="loop-correction-seam-toolbar">
          <div className="loop-correction-seam-caption"><strong>末尾 {tailCount} 帧 <ArrowRight size={12} /> 开头 {headCount} 帧</strong><span>{fps} FPS · {frames.length} 帧{previewFrame ? ` · ${previewFrame.width} × ${previewFrame.height}` : ''}</span></div>
          <div className="loop-correction-playback"><button className="icon-button" aria-label={playing ? '暂停循环接缝预览' : '播放循环接缝预览'} disabled={frames.length < 2} onClick={() => setPlaying(value => !value)}>{playing ? <Pause size={15} /> : <Play size={15} />}</button><input type="range" aria-label="循环接缝预览帧" min={0} max={Math.max(1, seamIndices.length - 1)} value={Math.min(seamIndex, Math.max(0, seamIndices.length - 1))} disabled={frames.length < 2} onChange={event => { setPlaying(false); setSeamIndex(Number(event.target.value)); }} /><small>{previewFrame ? `${shownSeamIndex + 1} / ${frames.length}` : '—'}</small></div>
        </div>
      </div>
      <div className="loop-correction-comparison-heading loop-correction-static-heading"><div><h3>首尾帧对比</h3><p>并排比较首帧、原始末帧与修正末帧。</p></div><button className={`button ghost small ${overlay ? 'is-active' : ''}`} disabled={!frames.length} aria-pressed={overlay} onClick={() => setOverlay(value => !value)}><Eye size={14} />原始首尾叠加</button></div>
      <div className="loop-correction-preview-grid">
        {[{ key: 'first', title: '首帧', frame: first, subtitle: first ? `第 1 帧 · ${first.width} × ${first.height}` : '等待载入' }, { key: 'original-last', title: '原始末帧', frame: last, subtitle: last ? `第 ${frames.length} 帧 · ${last.width} × ${last.height}` : '等待载入' }, { key: 'corrected-last', title: '修正末帧', frame: correctedLast, subtitle: correctedLast ? `${correctedLast.width} × ${correctedLast.height}${stale ? ' · 上次结果' : ' · 精确匹配首帧'}` : '启用后自动生成' }].map(pane => <div className="loop-correction-preview" data-kind={pane.key} key={pane.key}><div><strong>{pane.title}</strong><span>{pane.subtitle}</span></div><div className="loop-correction-image checker">{pane.frame ? <img src={pane.frame.url} alt={`${pane.title}：${pane.frame.name}`} className={pane.key === 'original-last' && overlay ? 'loop-correction-underlay' : ''} /> : <span><Repeat2 size={26} />{pane.key === 'corrected-last' ? '等待首尾修正' : '先在上方抽取动画帧'}</span>}{pane.key === 'original-last' && overlay && first && <img className="loop-correction-overlay" src={first.url} alt="首帧半透明叠加" />}</div></div>)}
      </div>
      <div className="loop-correction-bottom"><div className="loop-correction-analysis">{result ? <><span><ShieldCheck size={14} />{completed?.originalDifferenceKnown === false ? '已恢复保存的首尾修正结果' : result.originalDifference.sameDimensions ? `原始首尾差异 ${result.originalDifference.differencePercent.toFixed(2)}%` : '原始首尾尺寸不同'}</span><span className={valid ? 'loop-correction-verified' : ''}><Check size={14} />{stale ? '上次结果首尾一致' : '修正首尾差异 0% · 包含透明通道'}</span><small>{frames.length} 帧 · {fps} FPS · 帧数与时长保持不变</small></> : <><span><Repeat2 size={14} />首尾修正仅影响当前已选序列</span><small>关闭后恢复使用原始帧。首尾一致后，仍可播放检查动作衔接。</small></>}</div></div>
    </div>}
  </div>;
}
