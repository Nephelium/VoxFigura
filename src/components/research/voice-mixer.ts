import { parseTextGrid, type TextGridDocument, type TextGridInterval } from '@vocalcut/core';
import type { CurveAlignInterval, MorphKnot } from '@/vendor/m27-voice-morph/curve-editor.js';

export interface PresetSourceParams {
  pr_pa: number;
  xb_cm: number;
  xt_cm: number;
  ca_cm2: number;
  lag_rad: number;
  ra: number;
  ps: number;
  fl_pct: number;
  shim_pct: number;
}

export type DiplophoniaMode = 'parallel' | 'ventricular' | 'vertical';

export interface DiplophoniaModeOption {
  id: DiplophoniaMode;
  label: string;
  defaultRatio: number;
  hint: string;
}

export const DIPLOPHONIA_MODE_OPTIONS: readonly DiplophoniaModeOption[] = [
  {
    id: 'parallel',
    label: '左右声带',
    defaultRatio: 0.73,
    hint: '左右声带并联不对称振动（纯线性叠加两套独立谐波族，默认频率比 0.73×）',
  },
  {
    id: 'ventricular',
    label: '声带+室襞',
    defaultRatio: 0.58,
    hint: '真声带与室襞（假声带）串联耦合振动（叠加 28% 周期调幅生成 f₁±f₂ 组合音边带，默认频率比 0.58×）',
  },
  {
    id: 'vertical',
    label: '声带上下段',
    defaultRatio: 1.37,
    hint: '声带上下段纵向异频轻度耦合振动（轻薄副声源叠加 16% 纵耦调幅，默认频率比 1.37×）',
  },
];

export interface MixerPreset {
  id: string;
  label: string;
  desc: string;
  f0_shift_semitones: number;
  f0_target_hz?: number | null;
  default_f0_coupling?: boolean;
  is_voiceless_target: boolean;
  larynx_hy_delta_cm?: number | null;
  supports_creak_irregularity?: boolean;
  default_creak_irregularity?: number | null;
  supports_diplophonia?: boolean;
  default_diplophonia_mode?: DiplophoniaMode | null;
  default_diplophonia_ratio?: number | null;
  experimental?: boolean;
  builtin: boolean;
  /** 9-dim source vector with PR strictly in Pa (0..1600 Pa): [pr_pa, xb_cm, xt_cm, ca_cm2, lag_rad, ra, ps, fl_pct, shim_pct] */
  source9_phys_pa?: number[];
  source_params?: PresetSourceParams;
}

export interface DisabledMixerPresetNotice {
  badge: string;
  title: string;
  message: string;
  suggestion: string;
}

/**
 * Permanently locked presets (currently empty after re-enabling creaky / whispery / voiceless for new model validation).
 */
export const DISABLED_BUILTIN_MIXER_PRESETS: Readonly<Record<string, DisabledMixerPresetNotice>> = {};

/**
 * Experimental VoQS presets grouped in the collapsible "实验调校中（灰度试听）" drawer.
 * Whispery falsetto, creaky falsetto, and whispery creaky falsetto remain in beta audition; all other VoQS presets are promoted.
 */
export const EXPERIMENTAL_BUILTIN_MIXER_PRESET_IDS: ReadonlySet<string> = new Set([
  'whispery_falsetto',
  'creaky_falsetto',
  'whispery_creaky_falsetto',
]);

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

export function isMixerPresetExperimental(
  preset: Pick<MixerPreset, 'id' | 'builtin' | 'experimental'> | null | undefined,
): boolean {
  if (!preset?.builtin) return false;
  return Boolean(preset.experimental || EXPERIMENTAL_BUILTIN_MIXER_PRESET_IDS.has(preset.id));
}

const CREAKY_PRESET_IDS: ReadonlySet<string> = new Set([
  'creaky',
  'creak',
  'whispery_creaky',
  'creaky_falsetto',
  'whispery_creaky_falsetto',
]);

export function isCreakyMixerPreset(
  preset: Pick<MixerPreset, 'id' | 'supports_creak_irregularity'> | null | undefined,
): boolean {
  if (!preset) return false;
  return Boolean(preset.supports_creak_irregularity || CREAKY_PRESET_IDS.has(preset.id));
}

export function isDiplophoniaMixerPreset(
  preset: Pick<MixerPreset, 'id' | 'supports_diplophonia'> | null | undefined,
): boolean {
  if (!preset) return false;
  return Boolean(preset.supports_diplophonia || preset.id === 'diplophonia');
}

export interface PresetGlottisSpec {
  key: string;
  label: string;
  value: string;
  unit: string;
}

/**
 * Canonical VoQS (2016 中英双语版) preset names & steady-state calibrated 9-dim source defaults
 * [PR(Pa), XB(cm), XT(cm), CA(cm²), LAG(rad), RA, PS, FL(%), SHIM(%)].
 * Mirrors `presets.py` / `voice_morph_bridge.py` with PR strictly in Pa (0..1600 Pa).
 */
export const VOQS_BUILTIN_PRESET_DEFAULTS: Record<
  string,
  {
    label: string;
    desc: string;
    source9_phys_pa: number[];
    f0_shift_semitones: number;
    default_f0_coupling: boolean;
  }
> = {
  modal: {
    label: '常态浊声 (Modal · V)',
    desc: '自然均衡的常态浊声',
    source9_phys_pa: [820.0, 0.034, 0.039, 0.013, 1.38, 0.86, 0.47, 19.7, 6.7],
    f0_shift_semitones: 0.0,
    default_f0_coupling: false,
  },
  breathy: {
    label: '气声 (Breathy · V̤)',
    desc: '声门略开、伴随柔和气噪与低振幅振动',
    source9_phys_pa: [880.0, 0.075, 0.056, 0.072, 1.48, 0.38, -0.18, 46.0, 36.0],
    f0_shift_semitones: -0.5,
    default_f0_coupling: false,
  },
  pressed: {
    label: '挤喉发声/紧声 (Pressed · V͈)',
    desc: '高肺压、声带内收挤压（负 XB/XT）、高相位滞后与锐利闭合脉冲',
    source9_phys_pa: [1150.0, -0.015, -0.018, 0.0, 1.9, 1.0, 0.85, 12.0, 0.0],
    f0_shift_semitones: 1.5,
    default_f0_coupling: false,
  },
  creaky: {
    label: '嘎裂声 (Creaky · V̰)',
    desc: '声门收紧、强基频与振幅抖动，默认自动压低基频至约 60 Hz',
    source9_phys_pa: [740.0, 0.012, 0.024, -0.025, 2.05, 0.68, 0.56, 82.0, 86.0],
    f0_shift_semitones: -12.0,
    default_f0_coupling: true,
  },
  falsetto: {
    label: '假声 (Falsetto · F)',
    desc: '纯净放松的轻假声（约 400 Hz / 女声至少 +8 st），低肺压柔化胸声高频泛音、不挤嗓不费力',
    source9_phys_pa: [420.0, 0.044, 0.056, 0.036, 0.25, 0.48, -0.66, 12.0, 7.0],
    f0_shift_semitones: 10.0,
    default_f0_coupling: true,
  },
  whispery: {
    label: '耳语声 (Whispery · Ṿ)',
    desc: '保留弱周期振动（低 RA）叠加后部气噪',
    source9_phys_pa: [920.0, 0.058, 0.048, 0.088, 1.32, 0.24, 0.06, 42.0, 26.0],
    f0_shift_semitones: 0.0,
    default_f0_coupling: false,
  },
  whisper: {
    label: '耳语 (Whisper · W)',
    desc: '关闭周期振动（RA=0），高肺压狭缝气噪擦感更强',
    source9_phys_pa: [1080.0, 0.068, 0.045, 0.145, 1.84, 0.0, 0.0, 55.0, 35.0],
    f0_shift_semitones: 0.0,
    default_f0_coupling: false,
  },
  voiceless: {
    label: '清化 (Voiceless)',
    desc: '声门大开且低肺压（RA=0），轻柔气感且擦噪明显弱于耳语',
    source9_phys_pa: [520.0, 0.22, 0.22, 0.14, 1.22, 0.0, 0.5, 0.0, 0.0],
    f0_shift_semitones: 0.0,
    default_f0_coupling: false,
  },
  creak: {
    label: '嘎裂 (Creak · C)',
    desc: '清晰低频脉冲波与强基频/振幅抖动，默认自动压低基频至约 30 Hz',
    source9_phys_pa: [880.0, 0.002, 0.01, -0.045, 2.3, 0.72, 0.78, 92.0, 96.0],
    f0_shift_semitones: -12.0,
    default_f0_coupling: true,
  },
  whispery_creaky: {
    label: '耳语嘎裂声 (Whispery Creaky · V̰̣)',
    desc: '60 Hz 清晰嘎裂脉冲叠加轻度后部裂隙漏气，不盖过嘎裂质感',
    source9_phys_pa: [820.0, 0.026, 0.034, 0.032, 2.05, 0.68, 0.42, 84.0, 88.0],
    f0_shift_semitones: -12.0,
    default_f0_coupling: true,
  },
  whispery_falsetto: {
    label: '耳语假声 (Whispery Falsetto · F̣)',
    desc: '清晰假声边缘振动叠加轻度裂隙漏气，自适应抬高基频（≥320 Hz / +7 st）',
    source9_phys_pa: [740.0, 0.036, 0.044, 0.052, 0.5, 0.42, -0.15, 28.0, 16.0],
    f0_shift_semitones: 8.0,
    default_f0_coupling: true,
  },
  creaky_falsetto: {
    label: '嘎裂假声 (Creaky Falsetto · F̰)',
    desc: '单声源假声（约 310 Hz / 女声至少 +6 st）叠加 F0 锁定三/四连波尖锐亚谐波交替脉冲',
    source9_phys_pa: [640.0, 0.032, 0.046, -0.006, 0.9, 0.48, 0.32, 34.0, 28.0],
    f0_shift_semitones: 7.0,
    default_f0_coupling: true,
  },
  whispery_creaky_falsetto: {
    label: '耳语嘎裂假声 (Whispery Creaky Falsetto · F̰̣)',
    desc: '假声（约 305 Hz / 女声至少 +6 st）叠加三/四连波尖锐亚谐波脉冲与 22% 持续后部裂隙耳语气流',
    source9_phys_pa: [640.0, 0.034, 0.048, 0.022, 0.9, 0.42, 0.32, 34.0, 26.0],
    f0_shift_semitones: 6.5,
    default_f0_coupling: true,
  },
  raised_larynx: {
    label: '喉位偏高声 (Raised Larynx · L̝)',
    desc: '大幅抬高喉位（HY +1.20 cm）缩短声道，共振峰显著上移明亮',
    source9_phys_pa: [1252.9, 0.031, 0.034, 0.016, 1.26, 0.78, 0.53, 20.1, 7.4],
    f0_shift_semitones: 1.5,
    default_f0_coupling: false,
  },
  lowered_larynx: {
    label: '喉位偏低声 (Lowered Larynx · L̞)',
    desc: '大幅压低喉位（HY −1.20 cm）拉长声道，共振峰显著下移浑厚',
    source9_phys_pa: [1273.5, 0.052, 0.056, -0.053, 1.48, 0.58, 0.05, 40.7, 35.3],
    f0_shift_semitones: -1.5,
    default_f0_coupling: false,
  },
  diplophonia: {
    label: '双音调嗓音 (Diplophonia · V‼)',
    desc: '同声道双声源叠加模拟左右声带、声带与室襞或声带上下段以非整数倍频率振动，支持调节频率比 f₂/f₁',
    source9_phys_pa: [920.0, -0.008, -0.010, -0.015, 1.85, 0.85, 0.75, 22.0, 18.0],
    f0_shift_semitones: 0.0,
    default_f0_coupling: false,
  },
};

export function resolvePresetSource9Pa(preset: Pick<MixerPreset, 'source9_phys_pa' | 'source_params'> | null | undefined): number[] | undefined {
  if (!preset) return undefined;
  if (preset.source9_phys_pa?.length === 9) return preset.source9_phys_pa;
  const p = preset.source_params;
  if (p) {
    return [p.pr_pa, p.xb_cm, p.xt_cm, p.ca_cm2, p.lag_rad, p.ra, p.ps, p.fl_pct, p.shim_pct];
  }
  return undefined;
}

export function normalizeMixerPreset(preset: MixerPreset): MixerPreset {
  const fb = preset.builtin ? VOQS_BUILTIN_PRESET_DEFAULTS[preset.id] : undefined;
  const resolved = resolvePresetSource9Pa(preset);
  if (!fb) {
    return resolved ? { ...preset, source9_phys_pa: resolved } : preset;
  }
  return {
    ...preset,
    label: fb.label,
    desc: fb.desc,
    source9_phys_pa: resolved ?? fb.source9_phys_pa,
    f0_shift_semitones:
      preset.id === 'falsetto' && [5, 6].includes(preset.f0_shift_semitones)
        ? fb.f0_shift_semitones
        : preset.f0_shift_semitones,
    default_f0_coupling: preset.default_f0_coupling ?? fb.default_f0_coupling,
  };
}

export function formatGlottis9Specs(source9Pa: readonly number[] | undefined): PresetGlottisSpec[] {
  if (!source9Pa || source9Pa.length < 9) return [];
  const [prPa, xb, xt, ca, lag, ra, ps, fl, shim] = source9Pa;
  return [
    { key: 'PR', label: '肺下压', value: String(Math.round(prPa)), unit: 'Pa' },
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
