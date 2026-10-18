import type { Frame } from './types';
import type { ProcessingTaskInfo } from './lib/taskInfo';
import './task-summary.css';

export default function TaskSummary({ task, frames, selected }: { task: ProcessingTaskInfo | null; frames: Frame[]; selected: number }) {
  const first = frames[0];
  const mixed = frames.some(frame => frame.width !== first?.width || frame.height !== first?.height);
  const properties = [
    ['任务 ID', task?.id ?? '等待处理'],
    ['输出帧数', `${frames.length} 帧${selected !== frames.length ? ` / 已选 ${selected} 帧` : ''}`],
    ['取样方式', task?.sampling ?? '—'], ['抠图模式', task?.engine ?? '—'],
    ['输出倍数', task?.scale ?? '—'], ['输出画布', first ? `${first.width} × ${first.height}${mixed ? ' 等多种尺寸' : ''}` : '—'],
    ['画布布局', task?.layout ?? '—'], ['抽帧间隔', task?.stride ?? '—'], ['输入区间', task?.inputRange ?? '—'],
  ];
  return <dl className="task-summary" aria-label="当前帧动画处理属性">
    {properties.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    <div><dt>识别/选用背景色</dt><dd className="task-background-color">{task?.keyColor ? <><span style={{ background: task.keyColor }} />{task.keyColor.toUpperCase()}</> : '未记录'}</dd></div>
  </dl>;
}
