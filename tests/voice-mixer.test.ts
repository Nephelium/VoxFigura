import { describe, expect, it } from 'vitest';
import type { TextGridDocument, TextGridInterval } from '@vocalcut/core';
import {
  curveSparklinePath,
  extractAlignedIntervals,
  formatAudioTime,
  formatSemitoneShift,
  getDisabledMixerPresetNotice,
  isCurveEngaged,
  isMixerPresetDisabled,
  mixerAnchors,
  normalizeMixerPreset,
  parsePresetTitle,
} from '../src/components/research/voice-mixer';

function grid(intervals: TextGridInterval[]): TextGridDocument {
  return { xmin: 0, xmax: intervals[intervals.length - 1].xmax, tiers: [{
    kind: 'IntervalTier', name: 'phones', xmin: 0, xmax: intervals[intervals.length - 1].xmax, intervals,
  }] };
}

describe('调音台 TextGrid 对齐', () => {
  const a = grid([{ xmin: 0, xmax: 0.3, text: 's' }, { xmin: 0.3, xmax: 1, text: 'wan' }]);
  const b = grid([{ xmin: 0, xmax: 0.5, text: 's' }, { xmin: 0.5, xmax: 1.5, text: 'wan' }]);

  it('对齐不同长度的录音并合并共享边界', () => {
    expect(mixerAnchors(a, b, 1, 1.5)).toEqual([{ t_a: 0.3, t_b: 0.5 }]);
  });

  it('拒绝标签数相同但内容不同的区间层', () => {
    const unrelated = grid([{ xmin: 0, xmax: 0.5, text: 'S' }, { xmin: 0.5, xmax: 1.5, text: 'wan' }]);
    expect(() => mixerAnchors(a, unrelated, 1, 1.5)).toThrow('标签序列一致');
  });

  it('提取用于曲线画布标注的音素区间', () => {
    expect(extractAlignedIntervals(a)).toEqual([
      { xmin: 0, xmax: 0.3, text: 's' },
      { xmin: 0.3, xmax: 1, text: 'wan' },
    ]);
  });
});

describe('调音台界面纯函数工具', () => {
  it.each([5, 6])('将运行中的旧引擎假声预设 +%i st 更新为 +10 st', (shift) => {
    const preset = {
      id: 'falsetto', label: '假声', desc: '', f0_shift_semitones: shift,
      is_voiceless_target: false, builtin: true,
    };
    expect(normalizeMixerPreset(preset).f0_shift_semitones).toBe(10);
    expect(normalizeMixerPreset({ ...preset, builtin: false }).f0_shift_semitones).toBe(shift);
  });

  it('解析预设中英文标题与半音偏移格式', () => {
    expect(parsePresetTitle('气声 (Breathy)')).toEqual({ zh: '气声', en: 'Breathy' });
    expect(parsePresetTitle('我的自定义预设')).toEqual({ zh: '我的自定义预设', en: '' });
    expect(formatSemitoneShift(1.5)).toBe('+1.5 st');
    expect(formatSemitoneShift(-0.5)).toBe('-0.5 st');
    expect(formatSemitoneShift(0)).toBe('0 st');
  });

  it('判断混合轨启用状态并生成迷你曲线路径', () => {
    expect(isCurveEngaged([{ t: 0, v: 0 }, { t: 1, v: 0 }])).toBe(false);
    expect(isCurveEngaged([{ t: 0, v: 0 }, { t: 1, v: 0.85 }])).toBe(true);
    const path = curveSparklinePath([{ t: 0, v: 0 }, { t: 1, v: 1 }], 'linear', 40, 14);
    expect(path.startsWith('M0.0 12.5')).toBe(true);
    expect(path.endsWith('L40.0 1.5')).toBe(true);
    expect(formatAudioTime(65.4)).toBe('1:05');
  });

  it('在测试版禁用效果未达预期的内置发声类型预设并保留其他预设', () => {
    for (const id of ['creaky', 'whispery', 'voiceless']) {
      const preset = { id, builtin: true };
      expect(isMixerPresetDisabled(preset)).toBe(true);
      const notice = getDisabledMixerPresetNotice(preset);
      expect(notice?.badge).toBeTruthy();
      expect(notice?.title).toBeTruthy();
      expect(notice?.message).toBeTruthy();
      expect(notice?.suggestion).toBeTruthy();
    }

    for (const id of ['modal', 'breathy', 'pressed', 'falsetto', 'whisper']) {
      expect(isMixerPresetDisabled({ id, builtin: true })).toBe(false);
      expect(getDisabledMixerPresetNotice({ id, builtin: true })).toBeNull();
    }

    expect(isMixerPresetDisabled({ id: 'creaky', builtin: false })).toBe(false);
    expect(getDisabledMixerPresetNotice({ id: 'whispery', builtin: false })).toBeNull();
  });
});
