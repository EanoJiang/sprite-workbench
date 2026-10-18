import { describe, expect, it } from 'vitest';
import type { Frame, MediaSource } from '../types';
import { defaultOptions } from '../types';
import { extractionTaskInfo, importedTaskInfo, restoreTaskInfo } from './taskInfo';

const source: MediaSource = { kind: 'video', name: 'walk.mp4', url: 'blob:source', width: 1280, height: 720, duration: 2, fps: 24, totalFrames: 48 };
const frame: Frame = { id: '1', name: 'frame.png', url: 'blob:frame', width: 640, height: 360, time: 0, sourceIndex: 1, selected: true };

describe('processing task properties', () => {
  it('records the real browser sampler and inclusive frame range instead of claiming FFmpeg/GPU extraction', () => {
    const task = extractionTaskInfo(source, 7, 30, 2, { ...defaultOptions, padding: 0 }, [frame]);
    expect(task).toMatchObject({ sampling: '浏览器视频解码 / Canvas', engine: 'Chroma', scale: '50%', stride: '每 2 帧保留一张', inputRange: '0.25s - 1.25s', keyColor: defaultOptions.keyColor });
    expect(task.id).toMatch(/^\d{8}-\d{6}-[\da-f]{4}$/);
  });
  it('accounts for square canvases and does not invent extraction details for imported material', () => {
    expect(extractionTaskInfo(source, 1, 24, 1, { ...defaultOptions, layout: 'square', padding: 0 }, [{ ...frame, width: 360 }]).scale).toBe('28.1%');
    expect(importedTaskInfo('import')).toMatchObject({ sampling: '图片序列导入', engine: '已处理帧 / 未记录', keyColor: null });
    expect(restoreTaskInfo(importedTaskInfo('example'))?.sampling).toBe('内置示例');
    expect(restoreTaskInfo({ id: 'incomplete' })).toBeUndefined();
  });
});
