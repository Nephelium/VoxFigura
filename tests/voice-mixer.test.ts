import { describe, expect, it } from 'vitest';
import type { TextGridDocument, TextGridInterval } from '@vocalcut/core';
import {
  DIPLOPHONIA_MODE_OPTIONS,
  VOQS_BUILTIN_PRESET_DEFAULTS,
  curveSparklinePath,
  extractAlignedIntervals,
  formatAudioTime,
  formatSemitoneShift,
  getDisabledMixerPresetNotice,
  isCreakyMixerPreset,
  isCurveEngaged,
  isDiplophoniaMixerPreset,
  isMixerPresetDisabled,
  isMixerPresetExperimental,
  mixerAnchors,
  normalizeMixerPreset,
  parsePresetTitle,
} from '../src/components/research/voice-mixer';
import { VOQS_PRESET_CURVES } from '../src/data/voqs-preset-curves';

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

  it('正式开放 13 项内置预设（含双音调嗓音）并将耳语假声与两项嘎裂假声归入实验灰度试听区', () => {
    for (const id of [
      'modal',
      'breathy',
      'pressed',
      'creaky',
      'falsetto',
      'whispery',
      'whisper',
      'voiceless',
      'creak',
      'whispery_creaky',
      'raised_larynx',
      'lowered_larynx',
      'diplophonia',
    ]) {
      expect(isMixerPresetDisabled({ id, builtin: true })).toBe(false);
      expect(isMixerPresetExperimental({ id, builtin: true })).toBe(false);
      expect(getDisabledMixerPresetNotice({ id, builtin: true })).toBeNull();
    }

    for (const id of ['whispery_falsetto', 'creaky_falsetto', 'whispery_creaky_falsetto']) {
      expect(isMixerPresetDisabled({ id, builtin: true })).toBe(false);
      expect(isMixerPresetExperimental({ id, builtin: true })).toBe(true);
    }

    expect(isMixerPresetExperimental({ id: 'whispery_falsetto', builtin: false })).toBe(false);
    expect(getDisabledMixerPresetNotice({ id: 'whispery', builtin: false })).toBeNull();
    expect(isDiplophoniaMixerPreset({ id: 'diplophonia' })).toBe(true);
    expect(isDiplophoniaMixerPreset({ id: 'creaky' })).toBe(false);
    expect(DIPLOPHONIA_MODE_OPTIONS.map((m) => m.id)).toEqual(['parallel', 'ventricular', 'vertical']);
  });

  it('为 14 项内置 VoQS 预设全部提供实录 8 维曲线并启用嘎裂/假声自动 F0 联动', () => {
    const voqsIds = [
      'modal', 'breathy', 'pressed', 'creaky', 'falsetto', 'whispery', 'whisper',
      'creak', 'whispery_creaky', 'whispery_falsetto', 'creaky_falsetto',
      'whispery_creaky_falsetto', 'raised_larynx', 'lowered_larynx',
    ];
    for (const id of voqsIds) {
      const snap = VOQS_PRESET_CURVES[id];
      expect(snap, `缺少 ${id} 曲线快照`).toBeDefined();
      expect(snap.glottis8).toHaveLength(8);
      for (const dim of snap.glottis8) {
        expect(dim.length).toBeGreaterThanOrEqual(48);
      }
    }
    for (const id of ['creaky', 'creak', 'whispery_creaky', 'falsetto', 'whispery_falsetto', 'creaky_falsetto', 'whispery_creaky_falsetto']) {
      expect(VOQS_BUILTIN_PRESET_DEFAULTS[id].default_f0_coupling).toBe(true);
    }
    for (const id of ['creaky', 'creak', 'whispery_creaky', 'creaky_falsetto', 'whispery_creaky_falsetto']) {
      expect(isCreakyMixerPreset({ id })).toBe(true);
    }
    expect(isCreakyMixerPreset({ id: 'falsetto' })).toBe(false);
    expect(isCreakyMixerPreset({ id: 'pressed' })).toBe(false);
  });
});
