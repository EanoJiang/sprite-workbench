import { Check, Contrast, Download, Layers3, LoaderCircle, RefreshCw, Scissors, ShieldCheck, Sparkles, WandSparkles } from 'lucide-react';
import type { ProcessOptions } from './types';
import type { BackendHealth } from './lib/ai';
import './ai-controls.css';

interface Props { options: ProcessOptions; backend: BackendHealth | null; busy: boolean; preparing: boolean; previewBusy: boolean; update: <K extends keyof ProcessOptions>(key: K, value: ProcessOptions[K]) => void; onPrepare: () => void; onCheck: () => void; }

export default function AiControls({ options, backend, busy, preparing, previewBusy, update, onPrepare, onCheck }: Props) {
  const isAi = options.engine && options.engine !== 'chroma' && options.engine !== 'luma';
  const lumaBlack = options.lumaBlack ?? 0;
  const lumaWhite = Math.max(lumaBlack + 1, options.lumaWhite ?? 85);
  return <div className="card ai-model-panel">
    <div className="ai-panel-heading"><div><Sparkles size={18} /><strong>选择抠图引擎</strong><span>本地处理 · 纯色 / 亮度 / AI</span></div><button className={`button ghost small ${backend ? 'connected' : ''}`} onClick={onCheck}><span className="status-dot" />{backend ? `${backend.gpu || (backend.cuda ? 'CUDA' : 'CPU')} · 已连接` : 'AI 服务未连接 · 点击检查'}<RefreshCw size={12} /></button></div>
    <div className="engine-options">{([
      ['chroma', '纯色抠图', '即时处理 · 无需模型', Scissors],
      ['luma', 'Luma 亮度抠图', '黑白背景 · 无需模型', Contrast],
      ['birefnet', 'BiRefNet', '主体分割 · 复杂背景', WandSparkles],
      ['corridorkey', 'CorridorKey', '绿幕抠图 · 保留细节', Layers3],
      ['hybrid', 'BiRefNet + CorridorKey', '主体提示 + 精细抠图', Sparkles],
    ] as const).map(([engine, title, description, Icon]) => <button key={engine} disabled={busy || preparing} className={`engine-option ${(options.engine ?? 'chroma') === engine ? 'active' : ''}`} onClick={() => update('engine', engine)}><Icon size={19} /><span><strong>{title}</strong><small>{description}</small></span><span className="engine-radio">{(options.engine ?? 'chroma') === engine && <Check size={11} />}</span></button>)}</div>
    {options.engine === 'luma' && <div className="luma-settings"><label><span>Luma 背景</span><select aria-label="Luma 背景" value={options.lumaPolarity ?? 'auto'} disabled={busy || preparing} onChange={event => update('lumaPolarity', event.target.value as ProcessOptions['lumaPolarity'])}><option value="auto">自动判断</option><option value="bright">抠除黑色背景</option><option value="dark">抠除白色背景</option></select></label>
      <label><span>黑场 <strong>{lumaBlack}</strong></span><input aria-label="Luma 黑场" type="range" min={0} max={254} value={lumaBlack} disabled={busy || preparing} onChange={event => { const next = +event.target.value; update('lumaBlack', next); if ((options.lumaWhite ?? 85) <= next) update('lumaWhite', next + 1); }} /></label>
      <label><span>白场 <strong>{lumaWhite}</strong></span><input aria-label="Luma 白场" type="range" min={lumaBlack + 1} max={255} value={lumaWhite} disabled={busy || preparing} onChange={event => update('lumaWhite', +event.target.value)} /></label>
      <label><span>Gamma <strong>{(options.lumaGamma ?? .55).toFixed(2)}</strong></span><input aria-label="Luma Gamma" type="range" min={.05} max={4} step={.05} value={options.lumaGamma ?? .55} disabled={busy || preparing} onChange={event => update('lumaGamma', +event.target.value)} /></label>
      <label><span>强度 <strong>{(options.lumaStrength ?? 1.7).toFixed(2)}</strong></span><input aria-label="Luma 强度" type="range" min={0} max={2} step={.05} value={options.lumaStrength ?? 1.7} disabled={busy || preparing} onChange={event => update('lumaStrength', +event.target.value)} /></label>
      <p>按亮度生成透明蒙版，适合黑底光效或白底素材。自动判断依据左侧背景取色；在浏览器内处理，无需下载模型。</p></div>}
    {isAi && <div className="ai-settings"><label>推理设备<select aria-label="AI 推理设备" value={options.aiDevice ?? 'auto'} disabled={busy || preparing} onChange={event => update('aiDevice', event.target.value as ProcessOptions['aiDevice'])}><option value="auto">自动选择</option><option value="cuda">NVIDIA CUDA</option><option value="cpu">CPU</option></select></label><label>AI 推理分辨率<select aria-label="AI 推理分辨率" value={options.aiResolution ?? 768} disabled={busy || preparing} onChange={event => update('aiResolution', +event.target.value)}>{[512, 768, 1024, 1312, 2048].map(size => <option key={size} value={size}>{size} px{size === 768 ? ' · 低显存推荐' : size === 2048 ? ' · 高显存' : ''}</option>)}</select></label><label>BiRefNet 模型<select aria-label="BiRefNet 模型" value={options.birefnetVariant ?? 'standard'} disabled={options.engine === 'corridorkey' || busy || preparing} onChange={event => update('birefnetVariant', event.target.value as ProcessOptions['birefnetVariant'])}><option value="standard">通用版 · BiRefNet</option><option value="hr-matting">精细边缘 · HR-matting</option><option value="lite">轻量版 · BiRefNet_lite</option></select></label><button className="button primary" disabled={preparing || busy || previewBusy} onClick={onPrepare}>{preparing ? <LoaderCircle className="spinner" size={15} /> : <Download size={15} />}{preparing ? '下载 / 加载模型中…' : '加载 / 下载模型'}</button><p className="ai-settings-hint"><ShieldCheck size={13} />首次使用从官方仓库下载权重到本机。{options.engine === 'hybrid' ? '串联模式会分阶段释放模型，减少显存占用。' : options.engine === 'corridorkey' ? '适合绿幕素材，使用色度粗蒙版作为 Alpha 提示。' : '支持任意背景，输出主体透明蒙版。'}<a href={options.engine === 'corridorkey' ? 'https://github.com/nikopueringer/CorridorKey' : 'https://github.com/ZhengPeng7/BiRefNet'} target="_blank" rel="noreferrer">官方项目 ↗</a></p></div>}
  </div>;
}

type LocalControlProps = Pick<Props, 'options' | 'update'> & { disabled?: boolean };

export function WatermarkRemovalControl({ options, update, disabled = false }: LocalControlProps) {
  return <label className="switch-field watermark-removal-control"><span><strong>去水印</strong><small>自动检测左上 / 右下角，透明移除水印区域</small></span><input aria-label="去水印" type="checkbox" role="switch" checked={options.watermarkRemoval ?? false} disabled={disabled} onChange={event => update('watermarkRemoval', event.target.checked)} /></label>;
}

export function BackgroundCleanupControls({ options, update, disabled = false }: LocalControlProps) {
  const change = (key: 'backgroundToBlack' | 'backgroundDesaturate' | 'semitransparentToBlack' | 'semitransparentToOpaque', enabled: boolean) => {
    if (options.cleanup === 'dark') update('semitransparentToBlack', true);
    if (options.cleanup === 'opaque') update('semitransparentToOpaque', true);
    update('cleanup', 'none'); update(key, enabled);
  };
  return <fieldset className="background-cleanup-controls" disabled={disabled}><legend>后处理</legend><div className="background-cleanup-checks">{([
    ['backgroundToBlack', '背景残留转黑'],
    ['backgroundDesaturate', '背景残留饱和度归零'],
    ['semitransparentToBlack', '半透明像素转黑'],
    ['semitransparentToOpaque', '半透明像素转不透明'],
  ] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={!!options[key] || (key === 'semitransparentToBlack' && options.cleanup === 'dark') || (key === 'semitransparentToOpaque' && options.cleanup === 'opaque')} onChange={event => change(key, event.target.checked)} /><span>{label}</span></label>)}</div><p className="field-hint">可同时勾选。背景残留仅处理透明边缘附近的背景色；完全透明像素始终保持透明。</p></fieldset>;
}
