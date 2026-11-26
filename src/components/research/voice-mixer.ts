import { parseTextGrid, type TextGridDocument, type TextGridInterval } from '@vocalcut/core';
import type { CurveAlignInterval, MorphKnot } from '@/vendor/m27-voice-morph/curve-editor.js';

export interface MixerPreset {
  id: string;
  label: string;
  desc: string;
  f0_shift_semitones: number;
  f0_target_hz?: number | null;
  default_f0_coupling?: boolean;
  is_voiceless_target: boolean;
  builtin: boolean;
  source9_phys?: number[];
}

export interface DisabledMixerPresetNotice {
  badge: string;
  title: string;
  message: string;
  suggestion: string;
}

export const DISABLED_BUILTIN_MIXER_PRESETS: Readonly<Record<string, DisabledMixerPresetNotice>> = {
  creaky: {
    badge: '调校中',
    title: '嘎裂声还在悄悄打磨中 (｡•́︿•̀｡)',
    message: '目前的嘎裂颗粒感还不够理想，测试版先暂时收起来啦～等参数调校顺耳了就会重新开放哦 (ง •̀_•́)ง',
    suggestion: '先试试气声、紧声、假声、耳语，或提取自定义预设吧 (oﾟvﾟ)ノ',
  },
  whispery: {
    badge: '调校中',
    title: '耳语声还在认真区分中 (´･ω･`)',
    message: '目前听起来和气声太像双胞胎啦，测试版先暂时锁住～正在把它的气噪与弱周期特征调得更分明哦 (•̀ᴗ•́)و',
    suggestion: '当前可以先体验气声或耳语，也可以保存自定义预设 (oﾟvﾟ)ノ',
  },
  voiceless: {
    badge: '调校中',
    title: '清化效果还在调校中 (´• ω •`)',
    message: '现在听起来和耳语还分不太清，测试版先暂缓开放啦～等调出更干净自然的清化效果再放出来哦 (ง •̀_•́)ง',
    suggestion: '当前可以先体验耳语或其他发声类型预设 (oﾟvﾟ)ノ',
  },
};

export function getDisabledMixerPresetNotice(
  preset: Pick<MixerPreset, 'id' | 'builtin'> | null | undefined,
): DisabledMixerPresetNotice | null {
  if (!preset?.builtin) return null;
  return DISABLED_BUILTIN_MIXER_PRESETS[preset.id] ?? null;
}

export function isMixerPresetDisabled(
  preset: Pick<MixerPreset, 'id' | 'builtin'> | null | undefined,
): boolean {
  return Boolean(getDisabledMixerPresetNotice(preset));
}

export interface PresetGlottisSpec {
  key: string;
  label: string;
  value: string;
  unit: string;
}

/**
 * Canonical VoQS (2016 中英双语版) preset names & steady-state calibrated 9-dim source defaults
 * [PR(dPa), XB(cm), XT(cm), CA(cm²), LAG(rad), RA, PS, FL(%), SHIM(%)].
 * Mirrors `presets.py` so UI always displays VoQS naming + 8-dim glottis details immediately.
 */
export const VOQS_BUILTIN_PRESET_DEFAULTS: Record<
  string,
  {
    label: string;
    desc: string;
    source9_phys: number[];
    f0_shift_semitones: number;
    default_f0_coupling: boolean;
  }
> = {
  modal: {
    label: '常态浊声 (Modal · V)',
    desc: '自然均衡的常态浊声',
    source9_phys: [8200.0, 0.034, 0.039, 0.013, 1.38, 0.86, 0.47, 19.7, 6.7],
    f0_shift_semitones: 0.0,
    default_f0_coupling: false,
  },
  breathy: {
    label: '气声 (Breathy · V̤)',
    desc: '声门略开、伴随柔和气噪与低振幅振动',
    source9_phys: [8800.0, 0.075, 0.056, 0.072, 1.48, 0.38, -0.18, 46.0, 36.0],
    f0_shift_semitones: -0.5,
    default_f0_coupling: false,
  },
  pressed: {
    label: '挤喉发声/紧声 (Pressed · V͈)',
    desc: '高肺压、声带收紧内收，高频谐波集中',
    source9_phys: [11200.0, 0.015, 0.018, 0.006, 1.62, 0.88, 0.58, 18.8, 6.4],
    f0_shift_semitones: 1.5,
    default_f0_coupling: false,
  },
  creaky: {
    label: '嘎裂声 (Creaky · V̰)',
    desc: '负 CA 收紧与高 FL/SHIM，典型低频颗粒感',
    source9_phys: [7400.0, 0.028, 0.046, -0.019, 1.94, 0.64, 0.34, 61.0, 66.5],
    f0_shift_semitones: -5.0,
    default_f0_coupling: false,
  },
  falsetto: {
    label: '假声 (Falsetto · F)',
    desc: '低 LAG 边缘振动，默认同步抬高基频',
    source9_phys: [6400.0, 0.012, 0.035, 0.036, 0.58, 0.18, -0.04, 22.0, 12.0],
    f0_shift_semitones: 10.0,
    default_f0_coupling: true,
  },
  whispery: {
    label: '耳语声 (Whispery · Ṿ)',
    desc: '保留弱周期振动（低 RA）叠加后部气噪',
    source9_phys: [9200.0, 0.058, 0.048, 0.088, 1.32, 0.24, 0.06, 42.0, 26.0],
    f0_shift_semitones: 0.0,
    default_f0_coupling: false,
  },
  whisper: {
    label: '耳语 (Whisper · W)',
    desc: '关闭周期振动（RA=0），声门湍流气噪驱动',
    source9_phys: [8600.0, 0.084, 0.048, 0.082, 1.84, 0.0, 0.0, 50.0, 32.0],
    f0_shift_semitones: 0.0,
    default_f0_coupling: false,
  },
  voiceless: {
    label: '清化 (Voiceless)',
    desc: '声门大开无振动，用于清化连续统实验',
    source9_phys: [8000.0, 0.18, 0.18, 0.02, 1.22, 0.0, 0.5, 0.0, 0.0],
    f0_shift_semitones: 0.0,
    default_f0_coupling: false,
  },
};

export function normalizeMixerPreset(preset: MixerPreset): MixerPreset {
  const fb = preset.builtin ? VOQS_BUILTIN_PRESET_DEFAULTS[preset.id] : undefined;
  if (!fb) return preset;
  return {
    ...preset,
    label: fb.label,
    desc: fb.desc,
    source9_phys: preset.source9_phys?.length === 9 ? preset.source9_phys : fb.source9_phys,
    f0_shift_semitones:
      preset.id === 'falsetto' && [5, 6].includes(preset.f0_shift_semitones)
        ? fb.f0_shift_semitones
        : preset.f0_shift_semitones,
    default_f0_coupling: preset.default_f0_coupling ?? fb.default_f0_coupling,
  };
}

export function formatGlottis9Specs(source9: readonly number[] | undefined): PresetGlottisSpec[] {
  if (!source9 || source9.length < 9) return [];
  const [prDpa, xb, xt, ca, lag, ra, ps, fl, shim] = source9;
  return [
    { key: 'PR', label: '肺下压', value: String(Math.round(prDpa / 10)), unit: 'Pa' },
    { key: 'XB', label: '下缘开度', value: xb.toFixed(3), unit: 'cm' },
    { key: 'XT', label: '上缘开度', value: xt.toFixed(3), unit: 'cm' },
    { key: 'CA', label: '后部隙', value: ca.toFixed(3), unit: 'cm²' },
    { key: 'LAG', label: '相位滞后', value: lag.toFixed(2), unit: 'rad' },
    { key: 'RA', label: '相对振幅', value: ra.toFixed(2), unit: '' },
    { key: 'PS', label: '脉冲形状', value: ps.toFixed(2), unit: '' },
    { key: 'FL', label: '微扰 FL', value: fl.toFixed(0), unit: '%' },
    { key: 'SHIM', label: '振幅抖动', value: shim.toFixed(0), unit: '%' },
  ];
}

export interface MixerGroup {
  id: string;
  label: string;
  desc: string;
  recommended_delta: boolean;
  coupling_note?: string;
  is_speaker?: boolean;
  is_timing?: boolean;
  requires_alignment?: boolean;
}

export const TIMING_PROSODY_GROUP: MixerGroup = {
  id: 'timing',
  label: '时长与韵律 (标注对齐)',
  desc: '逐音节/音素迁移时长与停顿节律（需 A、B 完成文字或音节标注对齐）',
  recommended_delta: false,
  is_timing: true,
  requires_alignment: true,
  coupling_note: '需双人文字或音节标注对齐：0% 保持 A 的节律时长，100% 迁移 B 的时长与停顿韵律',
};

export type MixerSynth = 'neural' | 'physical';
export type MixerDevice = 'cpu' | 'cuda';

export interface MixerMeta {
  model_source: 'project_bundle';
  cuda_available: boolean;
  presets: MixerPreset[];
  groups: MixerGroup[];
  synthesizers: { id: MixerSynth; label: string }[];
}

export interface MixerAnalysis {
  clip_id: string;
  dur_sec: number;
  n_frames: number;
  invert_ms?: number;
  device_effective: MixerDevice;
  waveform_peaks: number[];
  voiced_gate: number[];
  speech_gate: number[];
  f0_hz?: number[];
  pr_norm?: number[];
}

export interface MixerAudio {
  name: string;
  url: string;
  file: Blob;
  duration: number;
  analysis?: MixerAnalysis;
}

export interface MixerAlignInfo {
  mode?: string;
  mean_cost?: number;
  num_anchors?: number;
  frames_a?: number;
  frames_b?: number;
  dur_ratio?: number;
}

export interface MixerRender {
  audio_base64: string;
  rate_hz: number;
  baseline_audio_base64?: string;
  baseline_rate_hz?: number;
  label: string;
  device_effective: MixerDevice;
  synth_ms?: number;
  out_dur_sec?: number;
  applied_curves: Record<string, number[]>;
  f0_shift_st: number;
  f0_target_hz?: number;
  align_mode?: 'textgrid' | 'dtw';
  align_info?: MixerAlignInfo;
}

export const mixerDeviceLabel = (device: MixerDevice) => (device === 'cuda' ? '本地 GPU' : '本地 CPU');

const API = '/api/models/voice-morph';

export async function mixerRequest<T>(body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(
    API,
    body
      ? {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : { signal },
  );
  const data = await response.json().catch(() => null);
  if (response.status === 404) throw new Error('当前运行的工作台引擎尚未加载发声调音台接口，请重启本地引擎。');
  if (!response.ok || !data?.ok) {
    throw new Error(data?.hint ?? data?.error?.hint ?? `发声调音台未能连接本地引擎（${response.status}）`);
  }
  return data as T;
}

export const MIXER_DEMOS = [
  { url: 'prewarm/suan_mandarin.mp3', label: '普通话 · suan' },
  { url: 'prewarm/swan_english.mp3', label: '英语 · swan' },
] as const;

export function parsePresetTitle(label: string): { zh: string; en: string } {
  const match = label.match(/^(.+?)\s*[（(]([^)）]+)[)）]\s*$/);
  if (!match) return { zh: label.trim(), en: '' };
  return { zh: match[1].trim(), en: match[2].trim() };
}

export function formatSemitoneShift(st: number): string {
  if (!Number.isFinite(st) || Math.abs(st) < 1e-4) return '0 st';
  const clean = Number(st.toFixed(1));
  return `${clean > 0 ? '+' : ''}${clean} st`;
}

export function isCurveEngaged(knots: readonly MorphKnot[] | undefined): boolean {
  return Boolean(knots?.some((k) => Number(k.v) > 0.005));
}

export function evalCurveAt(knots: readonly MorphKnot[], t: number, interpMode: 'smoothstep' | 'linear'): number {
  if (!knots.length) return 0;
  if (t <= knots[0].t) return knots[0].v;
  if (t >= knots[knots.length - 1].t) return knots[knots.length - 1].v;
  for (let i = 0; i < knots.length - 1; i++) {
    const a = knots[i];
    const b = knots[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = Math.max(1e-6, b.t - a.t);
      let u = (t - a.t) / span;
      if (interpMode !== 'linear') u = 0.5 - 0.5 * Math.cos(Math.PI * u);
      return a.v + (b.v - a.v) * u;
    }
  }
  return knots[knots.length - 1].v;
}

export function curveSparklinePath(
  knots: readonly MorphKnot[] | undefined,
  interpMode: 'smoothstep' | 'linear' = 'smoothstep',
  width = 44,
  height = 14,
): string {
  const safe = knots?.length ? knots : [{ t: 0, v: 0 }, { t: 1, v: 0 }];
  const steps = 16;
  const padY = 1.5;
  const innerH = Math.max(2, height - padY * 2);
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const val = Math.max(0, Math.min(1, evalCurveAt(safe, u, interpMode)));
    const x = (u * width).toFixed(1);
    const y = (padY + (1 - val) * innerH).toFixed(1);
    parts.push(`${i === 0 ? 'M' : 'L'}${x} ${y}`);
  }
  return parts.join(' ');
}

export function formatAudioTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0.00 s';
  if (sec < 60) return `${sec.toFixed(2)} s`;
  const total = Math.floor(sec);
  const mins = Math.floor(total / 60);
  const rem = total % 60;
  return `${mins}:${rem.toString().padStart(2, '0')}`;
}

export function parseTextGridContent(raw: string): TextGridDocument {
  const parsed = parseTextGrid(raw);
  if (!parsed.ok) throw new Error(parsed.error.hint);
  if (!parsed.value.tiers.some((tier) => tier.kind === 'IntervalTier' && tier.intervals.some((iv) => iv.text.trim()))) {
    throw new Error('TextGrid 中没有可用的区间标注');
  }
  return parsed.value;
}

export function extractAlignedIntervals(grid: TextGridDocument | null | undefined): CurveAlignInterval[] {
  if (!grid) return [];
  const tiers = grid.tiers.filter((tier) => tier.kind === 'IntervalTier');
  const preferred =
    tiers.find((tier) => /phone|phoneme|segment|\bseg\b|ipa|音素|音标/i.test(tier.name)) ??
    tiers.find((tier) => /syl|word|音节|词/i.test(tier.name)) ??
    tiers[0];
  if (!preferred || preferred.kind !== 'IntervalTier') return [];
  return preferred.intervals.map((iv) => ({ xmin: iv.xmin, xmax: iv.xmax, text: iv.text.trim() }));
}

export interface MixerAnchor {
  t_a: number;
  t_b: number;
}

export function mixerAnchors(a: TextGridDocument, b: TextGridDocument, durationA: number, durationB: number): MixerAnchor[] {
  const tiersA = a.tiers.filter((tier) => tier.kind === 'IntervalTier');
  const tiersB = b.tiers.filter((tier) => tier.kind === 'IntervalTier');
  const named = (name: string) => name.trim().normalize('NFC');
  const pairs = tiersA
    .flatMap((tierA) =>
      tiersB.map((tierB) => ({
        a: tierA.intervals.filter((interval) => interval.text.trim()),
        b: tierB.intervals.filter((interval) => interval.text.trim()),
        sameName: named(tierA.name).toLowerCase() === named(tierB.name).toLowerCase(),
      })),
    )
    .sort((left, right) => Number(right.sameName) - Number(left.sameName) || right.a.length - left.a.length);
  const inRange = (interval: TextGridInterval, duration: number) =>
    interval.xmin >= 0 && interval.xmin < interval.xmax && interval.xmax <= duration + 0.02;
  const pair = pairs.find(
    ({ a: x, b: y }) =>
      x.length &&
      x.length === y.length &&
      x.every((interval, i) => named(interval.text) === named(y[i].text) && inRange(interval, durationA) && inRange(y[i], durationB)),
  );
  if (!pair) throw new Error('两份 TextGrid 需要有标签序列一致的区间层，且时间须对应各自的录音。');

  const anchors: MixerAnchor[] = [];
  for (const [i, interval] of pair.a.entries()) {
    for (const edge of ['xmin', 'xmax'] as const) {
      const t_a = interval[edge];
      const t_b = pair.b[i][edge];
      // The engine supplies the start and end anchors on the 50 Hz analysis grid.
      if (t_a <= 0 || t_b <= 0 || t_a >= durationA - 0.02 || t_b >= durationB - 0.02) continue;
      const last = anchors.at(-1);
      if (!last || (t_a > last.t_a && t_b > last.t_b)) anchors.push({ t_a, t_b });
    }
  }
  if (!anchors.length) throw new Error('匹配的 TextGrid 区间层没有可用的内部边界。');
  if (anchors.length > 300) throw new Error('匹配的 TextGrid 区间层超过 300 个内部边界。');
  return anchors;
}
