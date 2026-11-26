/**
 * Real-Time Local Computation & Synthesis Runner for Interactive Guide Demos.
 *
 * Computes demonstrations directly on the user's machine using pure TypeScript
 * phonetic/scheduling kernels (`@vocalcut/core`), prewarmed calibrators under
 * `public/prewarm/` & `public/onboarding/`, and the local Python VTL 2.4 + ONNX
 * engine (`/api/vtl/*`, `/api/m27/*`).
 * Never mutates global project state; persists outputs into `guide-demo-cache.ts`.
 */

import {
  SAMPLE_RATE_HZ,
  evalF0,
  getPhonationAnchorParams,
  parseNumberedScore,
  schedule,
  toneLevelsToQtaTargets,
  type PhonationRegime,
  type ScheduleSyllableInput,
} from '@vocalcut/core';
import { preloadPtbIpaPresets, resolvePtbIpaPose } from '@/data/ptb-ipa-presets';
import { fetchOnboardingAudioFile, ONBOARDING_AUDIO_SLOTS } from '@/data/onboarding-samples';
import { saveDemoCache, type CachedGuideDemo } from '@/data/guide-demo-cache';
import type { GuideDemoKind } from '@/data/guide-types';
import { encodeWavFromAudioBuffer } from '@/components/modals/download';

export type ContourDict = Record<string, Array<[number, number]>>;

export interface TractAnimFrame {
  t: number;
  contours: ContourDict;
  f0: number;
  prPa: number;
  ca?: number;
}

export interface MainVoqsClipResult {
  id: string;
  label: string;
  notation: string;
  regime: PhonationRegime;
  glottisNote: string;
  caCm2: number;
  shimPct: number;
  f0RangeHz: [number, number];
  durationSec: number;
  frames: TractAnimFrame[];
}

export interface MainVoqsDemoPayload {
  kind: 'main-voqs';
  clips: MainVoqsClipResult[];
}

export interface IpaVowelComparisonItem {
  symbol: string;
  label: string;
  f1Hz: number;
  f2Hz: number;
  f3Hz: number;
  aminCm2: number;
  lp: number;
  tcx: number;
  contours: ContourDict;
  areaFn: Array<{ x_cm: number; area_cm2: number }>;
  transferFn: Array<{ f_hz: number; db: number }>;
}

export interface IpaRoundingDemoPayload {
  kind: 'ipa-rounding';
  items: IpaVowelComparisonItem[];
}

export interface M27RoundtripDemoPayload {
  kind: 'm27-roundtrip';
  durationSec: number;
  sourceTitle: string;
  isRealHuman: boolean;
  neuralAvailable: boolean;
  alignmentNote?: string;
  timesSec: number[];
  tcx: number[];
  tcy: number[];
  ld: number[];
  ca: number[];
  f0: number[];
  prPa: number[];
  alignedPhones: Array<{ ipa: string; startSec: number; endSec: number; isSil: boolean }>;
  frames: TractAnimFrame[];
}

export interface MixerRegimeEntry {
  regime: PhonationRegime;
  label: string;
  f0Hz: number;
  xbCm: number;
  caCm2: number;
  raPct: number;
  shimPct: number;
  lagRad: number;
  note: string;
}

export interface MixerPhonationDemoPayload {
  kind: 'mixer-phonation';
  sourceWord: string;
  durationSec: number;
  regimes: MixerRegimeEntry[];
}

export interface ContinuumStepItem {
  index: number;
  u: number;
  label: string;
  f1Hz: number;
  f2Hz: number;
  f3Hz: number;
  aminCm2: number;
  durationSec: number;
  frames: TractAnimFrame[];
}

export interface ContinuumSuanSwanPayload {
  kind: 'continuum-suan-swan';
  steps: ContinuumStepItem[];
}

export interface DialectSandhiCase {
  id: string;
  title: string;
  phrase: string;
  ruleSummary: string;
  rawTones: string[];
  sandhiTones: string[];
  timesMs: number[];
  rawF0Hz: number[];
  sandhiF0Hz: number[];
}

export interface DialectSandhiDemoPayload {
  kind: 'dialect-sandhi';
  cases: DialectSandhiCase[];
}

export interface ArrangerNoteItem {
  syllable: string;
  ipa: string;
  token: string;
  midi: number;
  noteHz: number;
  beatStartMs: number;
  onsetStartMs: number;
  nucleusStartMs: number;
  endMs: number;
  leadMs: number;
  pressurePa: number;
}

export interface ArrangerPrebeatDemoPayload {
  kind: 'arranger-prebeat';
  songTitle: string;
  tonic: string;
  bpm: number;
  scoreText: string;
  lyrics: string;
  totalSec: number;
  notes: ArrangerNoteItem[];
  hasAudio: boolean;
}

export interface ExploreCompareDemoPayload {
  kind: 'explore-compare';
  left: IpaVowelComparisonItem;
  right: IpaVowelComparisonItem;
}

export type AnyGuideDemoPayload =
  | MainVoqsDemoPayload
  | IpaRoundingDemoPayload
  | M27RoundtripDemoPayload
  | MixerPhonationDemoPayload
  | ContinuumSuanSwanPayload
  | DialectSandhiDemoPayload
  | ArrangerPrebeatDemoPayload
  | ExploreCompareDemoPayload;

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function interpolateVec(a: readonly number[], b: readonly number[], t: number): number[] {
  const u = Math.max(0, Math.min(1, t));
  return a.map((v, i) => v + ((b[i] ?? v) - v) * u);
}

function cosineEase(u: number): number {
  const c = Math.max(0, Math.min(1, u));
  return 0.5 * (1 - Math.cos(Math.PI * c));
}

function buildTimedTract200Hz(
  keyframes: Array<{ atSec: number; vec19: readonly number[] }>,
  totalSec: number,
  stepHz = 200,
): number[][] {
  const n = Math.max(1, Math.round(totalSec * stepHz));
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / stepHz;
    if (t <= keyframes[0].atSec) {
      out.push([...keyframes[0].vec19]);
      continue;
    }
    const last = keyframes[keyframes.length - 1];
    if (t >= last.atSec) {
      out.push([...last.vec19]);
      continue;
    }
    let idx = 0;
    while (idx < keyframes.length - 2 && keyframes[idx + 1].atSec < t) idx++;
    const k0 = keyframes[idx];
    const k1 = keyframes[idx + 1];
    const frac = cosineEase((t - k0.atSec) / Math.max(1e-4, k1.atSec - k0.atSec));
    out.push(interpolateVec(k0.vec19, k1.vec19, frac));
  }
  return out;
}

function makeSignal(callerSignal?: AbortSignal, timeoutMs = 45_000): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, t]) : t;
}

interface VtlPoseApiResponse {
  ok?: boolean;
  contours?: ContourDict;
  tube_areas?: number[];
  tube_lengths?: number[];
  oral_min_area?: number;
  frequency?: number[];
  transfer_db?: number[];
  resonances?: number[];
  error?: { hint?: string };
}

async function poseViaEngine(
  params19: readonly number[],
  extras: { lip_width?: number; larynx_height?: number; manual_root?: boolean; tongue_shape?: number[]; lip_shape?: number[] } = {},
  signal?: AbortSignal,
): Promise<VtlPoseApiResponse> {
  const res = await fetch('/api/vtl/pose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: makeSignal(signal, 12_000),
    body: JSON.stringify({
      speaker: 'JD2',
      section_count: 65,
      params: params19,
      lip_width: extras.lip_width ?? 1.0,
      larynx_height: extras.larynx_height ?? 0.0,
      manual_root: extras.manual_root ?? false,
      tongue_shape: extras.tongue_shape ?? [0, 0, 0, 0],
      lip_shape: extras.lip_shape ?? [0, 0, 0, 0],
    }),
  });
  const data = (await res.json()) as VtlPoseApiResponse;
  if (!res.ok || data.ok === false) {
    throw new Error(data.error?.hint ?? `本地声道几何接口不可用（HTTP ${res.status}）`);
  }
  return data;
}

interface VtlSynthApiResponse {
  ok?: boolean;
  wav_base64?: string;
  duration_s?: number;
  geometry_frames?: Array<{
    t_s: number;
    contours?: ContourDict;
    f0_hz?: number;
    pressure_pa?: number;
    resonances_hz?: number[];
  }>;
  error?: { hint?: string };
}

async function synthesizeViaEngine(
  payload: {
    f0_hz: number[];
    pressure_pa: number[];
    tract_frames: number[][];
    glottis_frames?: number[][];
    per_frame_shimmer?: boolean;
    fps?: number;
    include_geometry?: boolean;
  },
  signal?: AbortSignal,
): Promise<VtlSynthApiResponse> {
  const res = await fetch('/api/vtl/synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: makeSignal(signal, 45_000),
    body: JSON.stringify({
      speaker: 'JD2',
      synth_mode: 'physical',
      step_hz: 200,
      fps: payload.fps ?? 25,
      include_geometry: payload.include_geometry ?? true,
      audio_gain: 'peak',
      ...payload,
    }),
  });
  const data = (await res.json()) as VtlSynthApiResponse;
  if (!res.ok || data.ok === false || !data.wav_base64) {
    throw new Error(data.error?.hint ?? `本地 VTL 2.4 引擎不可用（HTTP ${res.status}）`);
  }
  return data;
}

interface PrewarmFrame {
  t_s: number;
  params: number[];
  f0_hz?: number;
  pressure_pa?: number;
  glottis?: number[];
}

interface PrewarmJson {
  duration_s: number;
  geometry_frames: PrewarmFrame[];
}

async function fetchPrewarmJson(relativePath: string, signal?: AbortSignal): Promise<PrewarmJson> {
  const base = (import.meta.env?.BASE_URL ?? '/').replace(/\/?$/, '/');
  const url = `${base}${relativePath.replace(/^\/+/, '')}`;
  const res = await fetch(url, { signal: makeSignal(signal, 15_000) });
  if (!res.ok) {
    throw new Error(`未能加载预录轨迹文件 ${relativePath}（HTTP ${res.status}）`);
  }
  const data = (await res.json()) as PrewarmJson;
  if (!Array.isArray(data.geometry_frames) || data.geometry_frames.length < 2) {
    throw new Error(`预录轨迹文件 ${relativePath} 缺少有效构音帧`);
  }
  return data;
}

function samplePrewarmAtTime(frames: readonly PrewarmFrame[], tSec: number): {
  params19: number[];
  f0: number;
  pr: number;
  glottis: number[];
} {
  const defaultGlottis = [0.02, 0.02, 0.03, 1.22, 1.0, 0.0, 25.0, 0.0];
  if (tSec <= frames[0].t_s) {
    return {
      params19: [...frames[0].params],
      f0: frames[0].f0_hz ?? 140,
      pr: frames[0].pressure_pa ?? 0,
      glottis: [...(frames[0].glottis ?? defaultGlottis)],
    };
  }
  const last = frames[frames.length - 1];
  if (tSec >= last.t_s) {
    return {
      params19: [...last.params],
      f0: last.f0_hz ?? 115,
      pr: last.pressure_pa ?? 300,
      glottis: [...(last.glottis ?? defaultGlottis)],
    };
  }
  let idx = 0;
  while (idx < frames.length - 2 && frames[idx + 1].t_s < tSec) idx++;
  const a = frames[idx];
  const b = frames[idx + 1];
  const u = Math.max(0, Math.min(1, (tSec - a.t_s) / Math.max(1e-4, b.t_s - a.t_s)));
  const ga = a.glottis ?? defaultGlottis;
  const gb = b.glottis ?? defaultGlottis;
  return {
    params19: interpolateVec(a.params, b.params, u),
    f0: (a.f0_hz ?? 140) + ((b.f0_hz ?? 140) - (a.f0_hz ?? 140)) * u,
    pr: (a.pressure_pa ?? 800) + ((b.pressure_pa ?? 800) - (a.pressure_pa ?? 800)) * u,
    glottis: interpolateVec(ga, gb, u),
  };
}

function buildAreaFnFromPose(snap: VtlPoseApiResponse): Array<{ x_cm: number; area_cm2: number }> {
  const areas = snap.tube_areas ?? [];
  const lens = snap.tube_lengths ?? [];
  const out: Array<{ x_cm: number; area_cm2: number }> = [];
  let x = 0;
  for (let i = 0; i < Math.min(areas.length, lens.length); i++) {
    out.push({ x_cm: Number((x + lens[i] * 0.5).toFixed(2)), area_cm2: Number(areas[i].toFixed(3)) });
    x += lens[i];
  }
  return out;
}

function buildTransferFromPose(snap: VtlPoseApiResponse): Array<{ f_hz: number; db: number }> {
  const freq = snap.frequency ?? [];
  const db = snap.transfer_db ?? [];
  const out: Array<{ f_hz: number; db: number }> = [];
  const step = Math.max(1, Math.floor(freq.length / 180));
  for (let i = 0; i < Math.min(freq.length, db.length); i += step) {
    if (freq[i] >= 0 && freq[i] <= 5500) {
      out.push({ f_hz: Math.round(freq[i]), db: Number(db[i].toFixed(2)) });
    }
  }
  return out;
}

function buildAnalyticalContourFallback(tcx = 0.5, tcy = -1.2, lp = 0.0, ja = -4.0): ContourDict {
  const tonguePts: Array<[number, number]> = [];
  for (let i = 0; i <= 14; i++) {
    const u = i / 14;
    const x = -2.8 + u * 6.4 + tcx * 0.35 * Math.sin(Math.PI * u);
    const y = -2.4 + Math.sin(Math.PI * u) * (1.8 + tcy * 0.55);
    tonguePts.push([Number(x.toFixed(3)), Number(y.toFixed(3))]);
  }
  const jawY = -2.9 + ja * 0.22;
  const lipX = 4.2 + lp * 0.55;
  return {
    tongue: tonguePts,
    palate: [[-3.1, 1.4], [-1.5, 2.25], [0.6, 2.45], [2.4, 2.1], [3.7, 1.2], [4.0, 0.45]],
    pharynx_back: [[-3.5, -4.6], [-3.4, -2.5], [-3.3, -0.5], [-3.1, 1.4]],
    jaw: [[-2.0, jawY - 0.8], [1.4, jawY - 0.5], [3.6, jawY], [4.0, jawY + 0.55]],
    upper_lip: [[3.7, 1.2], [lipX, 0.85], [lipX + 0.25, 0.45], [3.95, 0.4]],
    lower_lip: [[3.6, jawY], [lipX, jawY + 0.15], [lipX + 0.2, jawY + 0.55], [3.9, jawY + 0.55]],
  };
}

function mapGeometryFrames(
  rawFrames: VtlSynthApiResponse['geometry_frames'],
  fallbackF0 = 135,
  fallbackPr = 800,
): TractAnimFrame[] {
  return (rawFrames ?? []).map((f) => ({
    t: Number(f.t_s.toFixed(2)),
    contours: f.contours ?? buildAnalyticalContourFallback(),
    f0: Math.round(f.f0_hz ?? fallbackF0),
    prPa: Math.round(f.pressure_pa ?? fallbackPr),
  }));
}

/* ----------------------------------------------------------------------------
 * 1. ResearchMainView: VoQS 3-way comparison with full dynamic contour frames
 * ---------------------------------------------------------------------------- */

function buildSynthSyllableMa(
  poseM: readonly number[],
  poseA: readonly number[],
  toneLevels: string,
  regime: PhonationRegime,
  fRefHz = 132,
): {
  f0: number[];
  pr: number[];
  tract: number[][];
  glottis: number[][];
  durationSec: number;
  caCm2: number;
  shimPct: number;
} {
  const totalSec = 0.68;
  const stepHz = 200;
  const n = Math.round(totalSec * stepHz);
  const totalSmp = Math.round(totalSec * SAMPLE_RATE_HZ);
  const anchor = getPhonationAnchorParams(regime);
  const targets = toneLevelsToQtaTargets(toneLevels, 0.56, [-6, 4]);
  const baseSpanStart = Math.round(0.06 * SAMPLE_RATE_HZ);
  const baseSpanEnd = Math.round(0.62 * SAMPLE_RATE_HZ);
  const spans = targets.map((tg, idx) => ({
    id: `tg_${idx}`,
    span_id: `tg_${idx}`,
    start_smp: Math.round(baseSpanStart + tg.fracStart * (baseSpanEnd - baseSpanStart)),
    end_smp: Math.round(baseSpanStart + tg.fracEnd * (baseSpanEnd - baseSpanStart)),
    voiced: true,
    candidates: { default: tg.candidate },
  }));
  const f0Res = evalF0({
    spans,
    total_smp: totalSmp,
    step_smp: 240,
    f_ref_hz: fRefHz,
    context: 'speech',
  });
  const f0Raw = f0Res.ok ? f0Res.value.f0_hz : new Array<number>(n).fill(fRefHz);
  const f0 = Array.from({ length: n }, (_, i) => {
    const raw = f0Raw[i] ?? fRefHz;
    const shifted = regime === 'creaky' ? raw * 0.72 : raw;
    return Number(Math.max(62, Math.min(580, shifted)).toFixed(2));
  });
  const pr = Array.from({ length: n }, (_, i) => {
    const t = (i + 0.5) / stepHz;
    if (t < 0.04) return Number((anchor.pr_pa * (t / 0.04)).toFixed(1));
    if (t > 0.60) return Number((anchor.pr_pa * Math.max(0, (totalSec - t) / 0.08)).toFixed(1));
    return anchor.pr_pa;
  });
  const tract = buildTimedTract200Hz(
    [
      { atSec: 0.0, vec19: poseM },
      { atSec: 0.22, vec19: poseM },
      { atSec: 0.34, vec19: poseA },
      { atSec: totalSec, vec19: poseA },
    ],
    totalSec,
    stepHz,
  );
  const glottisRow = [
    anchor.xb_cm,
    anchor.xt_cm,
    anchor.ca_cm2,
    anchor.lag_rad,
    anchor.ra,
    anchor.ps,
    anchor.fl,
    anchor.shim,
  ];
  const glottis = Array.from({ length: n }, () => [...glottisRow]);
  return {
    f0,
    pr,
    tract,
    glottis,
    durationSec: totalSec,
    caCm2: Number(anchor.ca_cm2.toFixed(3)),
    shimPct: Number(anchor.shim.toFixed(0)),
  };
}

async function runMainVoqsDemo(signal?: AbortSignal): Promise<{
  payload: MainVoqsDemoPayload;
  audios: Record<string, ArrayBuffer>;
  engineLabel: string;
}> {
  await preloadPtbIpaPresets('JD2');
  const poseM = resolvePtbIpaPose('m', 'JD2').params19;
  const poseA = resolvePtbIpaPose('a', 'JD2').params19;

  const specs: Array<{
    id: string;
    label: string;
    notation: string;
    tone: string;
    regime: PhonationRegime;
    glottisNote: string;
  }> = [
    {
      id: 'modal',
      label: '阴平 · 常态浊声',
      notation: '[ma˥˥]',
      tone: '55',
      regime: 'modal',
      glottisNote: 'XB/XT = 0.04 cm，CA = 0.020 cm²，周期脉冲平稳',
    },
    {
      id: 'breathy',
      label: '阳平 · 3 度气声',
      notation: '{3V̤ [ma˧˥] 3V̤}',
      tone: '35',
      regime: 'breathy',
      glottisNote: '后软骨裂隙 CA = 0.085 cm²，叠加宽带吸气噪声',
    },
    {
      id: 'creaky',
      label: '上声 · 3 度嘎裂',
      notation: '{3V̰ [ma˨˩˦] 3V̰}',
      tone: '214',
      regime: 'creaky',
      glottisNote: '低基频叠加 SHIM = 100% 振幅微扰，呈颗粒脉冲感',
    },
  ];

  const clips: MainVoqsClipResult[] = [];
  const audios: Record<string, ArrayBuffer> = {};

  for (const sp of specs) {
    const built = buildSynthSyllableMa(poseM, poseA, sp.tone, sp.regime);
    const res = await synthesizeViaEngine(
      {
        f0_hz: built.f0,
        pressure_pa: built.pr,
        tract_frames: built.tract,
        glottis_frames: built.glottis,
        per_frame_shimmer: true,
        fps: 24,
        include_geometry: true,
      },
      signal,
    );
    audios[sp.id] = base64ToArrayBuffer(res.wav_base64!);
    const frames = mapGeometryFrames(res.geometry_frames, built.f0[0], built.pr[Math.floor(built.pr.length / 2)]);
    clips.push({
      id: sp.id,
      label: sp.label,
      notation: sp.notation,
      regime: sp.regime,
      glottisNote: sp.glottisNote,
      caCm2: built.caCm2,
      shimPct: built.shimPct,
      f0RangeHz: [Math.round(Math.min(...built.f0)), Math.round(Math.max(...built.f0))],
      durationSec: Number((res.duration_s ?? built.durationSec).toFixed(2)),
      frames: frames.length ? frames : [{ t: 0, contours: buildAnalyticalContourFallback(), f0: built.f0[0], prPa: 800 }],
    });
  }

  return {
    payload: { kind: 'main-voqs', clips },
    audios,
    engineLabel: 'VTL 2.4 本地物理引擎 (48 kHz)',
  };
}

/* ----------------------------------------------------------------------------
 * 2. IpaPlusView & 10. ExploreLabView: /i, y, u/
 * ---------------------------------------------------------------------------- */

async function solveVowelItem(
  symbol: string,
  label: string,
  signal?: AbortSignal,
): Promise<{ item: IpaVowelComparisonItem; wav: ArrayBuffer }> {
  const pose = resolvePtbIpaPose(symbol, 'JD2');
  const snap = await poseViaEngine(pose.params19, pose.extras, signal);
  const n = 90;
  const f0 = Array.from({ length: n }, () => 130);
  const pr = Array.from({ length: n }, (_, i) => {
    const t = (i + 0.5) / 200;
    if (t < 0.04) return Number((800 * (t / 0.04)).toFixed(1));
    if (t > 0.39) return Number((800 * Math.max(0, (0.45 - t) / 0.06)).toFixed(1));
    return 800;
  });
  const tract = Array.from({ length: n }, () => [...pose.params19]);
  const synth = await synthesizeViaEngine({ f0_hz: f0, pressure_pa: pr, tract_frames: tract, include_geometry: false }, signal);
  const resHz = snap.resonances ?? [];
  return {
    item: {
      symbol,
      label,
      f1Hz: Math.round(resHz[0] ?? 0),
      f2Hz: Math.round(resHz[1] ?? 0),
      f3Hz: Math.round(resHz[2] ?? 0),
      aminCm2: Number((snap.oral_min_area ?? 0).toFixed(3)),
      lp: Number((pose.params.LP ?? 0).toFixed(2)),
      tcx: Number((pose.params.TCX ?? 0).toFixed(2)),
      contours: snap.contours ?? buildAnalyticalContourFallback(pose.params.TCX, pose.params.TCY, pose.params.LP),
      areaFn: buildAreaFnFromPose(snap),
      transferFn: buildTransferFromPose(snap),
    },
    wav: base64ToArrayBuffer(synth.wav_base64!),
  };
}

async function runIpaRoundingDemo(signal?: AbortSignal): Promise<{
  payload: IpaRoundingDemoPayload;
  audios: Record<string, ArrayBuffer>;
  engineLabel: string;
}> {
  await preloadPtbIpaPresets('JD2');
  const targets: Array<[string, string]> = [
    ['i', '/i/ 前高不圆唇'],
    ['y', '/y/ 前高圆唇'],
    ['u', '/u/ 后高圆唇'],
  ];
  const items: IpaVowelComparisonItem[] = [];
  const audios: Record<string, ArrayBuffer> = {};
  for (const [sym, label] of targets) {
    const { item, wav } = await solveVowelItem(sym, label, signal);
    items.push(item);
    audios[sym] = wav;
  }
  return {
    payload: { kind: 'ipa-rounding', items },
    audios,
    engineLabel: 'VTL 2.4 65截面管段求解',
  };
}

/* ----------------------------------------------------------------------------
 * 3. M27ReconstructView: Real Human `demo_zh_spkA.mp3` + auto align fallback
 * ---------------------------------------------------------------------------- */

interface M27ReconstructApiResponse {
  ok?: boolean;
  dur_sec?: number;
  m27_50hz_pa?: number[][];
  vtl_48k_wav_base64?: string;
  neural_16k_wav_base64?: string;
  alignment?: { phones?: Array<{ ipa: string; start_s: number; end_s: number; is_sil: boolean }> };
  error?: { code?: string; hint?: string };
}

async function postM27Reconstruct(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; data: M27ReconstructApiResponse }> {
  const res = await fetch('/api/m27/reconstruct', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: makeSignal(signal, 90_000),
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as M27ReconstructApiResponse;
  return { status: res.status, data };
}

async function runM27RoundtripDemo(signal?: AbortSignal): Promise<{
  payload: M27RoundtripDemoPayload;
  audios: Record<string, ArrayBuffer>;
  engineLabel: string;
}> {
  let sourceWavB64: string;
  let sourceFilename: string;
  let sourceText = ONBOARDING_AUDIO_SLOTS.zh_spk_a.transcript;
  let sourceTitle = `真人原声「${ONBOARDING_AUDIO_SLOTS.zh_spk_a.transcript}」`;
  let isRealHuman = true;

  const sampleRes = await fetchOnboardingAudioFile(
    ONBOARDING_AUDIO_SLOTS.zh_spk_a.relativeUrl,
    ONBOARDING_AUDIO_SLOTS.zh_spk_a.filename,
    signal,
  );
  if (sampleRes.ok) {
    const decoder = new OfflineAudioContext(1, 1, SAMPLE_RATE_HZ);
    const decoded = await decoder.decodeAudioData(await sampleRes.file.arrayBuffer());
    const wave = encodeWavFromAudioBuffer(decoded);
    sourceWavB64 = arrayBufferToBase64(await wave.arrayBuffer());
    sourceFilename = sampleRes.file.name.replace(/\.[^./]+$/, '.wav');
  } else {
    isRealHuman = false;
    sourceFilename = 'guide_demo_mai.wav';
    sourceText = '买';
    sourceTitle = 'VTL 2.4 实时合成 /mai/';
    await preloadPtbIpaPresets('JD2');
    const poseM = resolvePtbIpaPose('m', 'JD2').params19;
    const poseA = resolvePtbIpaPose('a', 'JD2').params19;
    const poseI = resolvePtbIpaPose('i', 'JD2').params19;
    const totalSec = 1.05;
    const n = Math.round(totalSec * 200);
    const tract = buildTimedTract200Hz(
      [
        { atSec: 0.0, vec19: poseM },
        { atSec: 0.20, vec19: poseM },
        { atSec: 0.30, vec19: poseA },
        { atSec: 0.56, vec19: poseA },
        { atSec: 0.72, vec19: poseI },
        { atSec: totalSec, vec19: poseI },
      ],
      totalSec,
      200,
    );
    const f0 = Array.from({ length: n }, (_, i) => {
      const u = i / Math.max(1, n - 1);
      return Number((138 - 32 * Math.sin(Math.PI * u) + 38 * Math.max(0, u - 0.55)).toFixed(1));
    });
    const pr = Array.from({ length: n }, (_, i) => {
      const t = (i + 0.5) / 200;
      if (t < 0.05) return Number((820 * (t / 0.05)).toFixed(1));
      if (t > 0.96) return Number((820 * Math.max(0, (totalSec - t) / 0.09)).toFixed(1));
      return 820;
    });
    const srcSynth = await synthesizeViaEngine({ f0_hz: f0, pressure_pa: pr, tract_frames: tract, include_geometry: false }, signal);
    sourceWavB64 = srcSynth.wav_base64!;
  }

  let alignmentNote: string | undefined;
  let { status, data: recon } = await postM27Reconstruct(
    {
      wav_base64: sourceWavB64,
      filename: sourceFilename,
      text: sourceText,
      lang: 'zh',
      alignment_mode: 'guided',
      synth_mode: 'both',
      audio_gain: 'peak',
      device: 'cpu',
      fps: 25,
    },
    signal,
  );

  // Automatic fallback if Vox2Align-Lite v2 is currently unloaded in Settings
  if (
    (status >= 400 || recon.ok === false) &&
    (recon.error?.code === 'model_unloaded' || (recon.error?.hint ?? '').includes('Vox2Align-Lite'))
  ) {
    alignmentNote = 'Vox2Align-Lite v2 当前未装载，已自动降级为无对齐纯声道反演；如需音素时间切分，可在「设置 → 声学引擎与模型」装载该模型。';
    const retry = await postM27Reconstruct(
      {
        wav_base64: sourceWavB64,
        filename: sourceFilename,
        text: '',
        lang: 'auto',
        alignment_mode: 'none',
        synth_mode: 'both',
        audio_gain: 'peak',
        device: 'cpu',
        fps: 25,
      },
      signal,
    );
    status = retry.status;
    recon = retry.data;
  }

  if (status >= 400 || recon.ok === false || !Array.isArray(recon.m27_50hz_pa)) {
    throw new Error(recon.error?.hint ?? `Vox2Tract-Lite 反演服务不可用（HTTP ${status}）`);
  }

  const rows = recon.m27_50hz_pa;
  const timesSec = rows.map((_, i) => Number(((i + 0.5) / 50).toFixed(2)));
  const tcx = rows.map((r) => Number((r[8] ?? 0).toFixed(3)));
  const tcy = rows.map((r) => Number((r[9] ?? 0).toFixed(3)));
  const ld = rows.map((r) => Number((r[5] ?? 0).toFixed(3)));
  const f0Out = rows.map((r) => Number((r[17] ?? 0).toFixed(1)));
  const prPa = rows.map((r) => Number((r[18] ?? 0).toFixed(1)));
  const ca = rows.map((r) => Number((r[21] ?? 0).toFixed(3)));

  // Sample 16 evenly spaced frames across full utterance for smooth audio-synced playback & scrubbing
  const sampleCount = Math.min(16, rows.length);
  const sampledFrames: TractAnimFrame[] = [];
  for (let k = 0; k < sampleCount; k++) {
    const fi = Math.round((k / Math.max(1, sampleCount - 1)) * (rows.length - 1));
    const r = rows[fi];
    const vec19 = [...r.slice(0, 14), 0, 0, r[14] ?? 0, r[15] ?? 0, r[16] ?? 0];
    let contours: ContourDict;
    try {
      const snap = await poseViaEngine(vec19, {}, signal);
      contours = snap.contours ?? buildAnalyticalContourFallback(r[8], r[9], r[4]);
    } catch {
      contours = buildAnalyticalContourFallback(r[8], r[9], r[4]);
    }
    sampledFrames.push({
      t: timesSec[fi],
      contours,
      f0: Math.round(f0Out[fi]),
      prPa: Math.round(prPa[fi]),
      ca: Number(ca[fi].toFixed(3)),
    });
  }

  const audios: Record<string, ArrayBuffer> = {
    source: base64ToArrayBuffer(sourceWavB64),
  };
  if (recon.vtl_48k_wav_base64) audios.vtl = base64ToArrayBuffer(recon.vtl_48k_wav_base64);
  if (recon.neural_16k_wav_base64) audios.neural = base64ToArrayBuffer(recon.neural_16k_wav_base64);

  return {
    payload: {
      kind: 'm27-roundtrip',
      durationSec: Number((recon.dur_sec ?? timesSec[timesSec.length - 1] ?? 1.0).toFixed(2)),
      sourceTitle,
      isRealHuman,
      neuralAvailable: Boolean(recon.neural_16k_wav_base64),
      alignmentNote,
      timesSec,
      tcx,
      tcy,
      ld,
      ca,
      f0: f0Out,
      prPa,
      alignedPhones: (recon.alignment?.phones ?? []).map((p) => ({
        ipa: p.ipa,
        startSec: Number(p.start_s.toFixed(2)),
        endSec: Number(p.end_s.toFixed(2)),
        isSil: Boolean(p.is_sil),
      })),
      frames: sampledFrames,
    },
    audios,
    engineLabel: alignmentNote
      ? 'Vox2Tract-Lite + VTL 2.4 / Tract2Vox-Lite（无对齐模式）'
      : 'Vox2Tract-Lite + Vox2Align-Lite v2 + VTL 2.4',
  };
}

/* ----------------------------------------------------------------------------
 * 4. VoiceMixerView: Dynamic Mandarin 「算」[swan⁵¹] 6 Phonation Regimes
 * ---------------------------------------------------------------------------- */

async function runMixerPhonationDemo(signal?: AbortSignal): Promise<{
  payload: MixerPhonationDemoPayload;
  audios: Record<string, ArrayBuffer>;
  engineLabel: string;
}> {
  const suan = await fetchPrewarmJson('prewarm/suan_mandarin.json', signal);
  const totalSec = Number(suan.duration_s || 0.85);
  const stepHz = 200;
  const n = Math.max(20, Math.round(totalSec * stepHz));
  const fricEndSec = 0.21;
  const xfadeSec = 0.06;

  const regimeSpecs: Array<{ regime: PhonationRegime; label: string; f0Mul: number; note: string }> = [
    { regime: 'pressed', label: '紧嗓 Pressed', f0Mul: 1.02, note: '声带紧缩接触相增大' },
    { regime: 'modal', label: '常态 Modal', f0Mul: 1.0, note: '标准周期发声基线' },
    { regime: 'breathy', label: '气声 Breathy', f0Mul: 0.96, note: '后软骨裂隙增大含气感' },
    { regime: 'whisper', label: '耳语 Whisper', f0Mul: 1.0, note: '周期振幅归零仅留气隙噪声' },
    { regime: 'creaky', label: '嘎裂 Creaky', f0Mul: 0.72, note: '低基频叠加高振幅微扰' },
    { regime: 'falsetto', label: '假声 Falsetto', f0Mul: 1.85, note: '高基频低粘膜波相位滞后' },
  ];

  const baseSamples = Array.from({ length: n }, (_, i) => samplePrewarmAtTime(suan.geometry_frames, (i + 0.5) / stepHz));
  const tract = baseSamples.map((s) => s.params19);
  const prArr = baseSamples.map((s) => Number(Math.max(0, Math.min(1600, s.pr)).toFixed(1)));

  const audios: Record<string, ArrayBuffer> = {};
  const regimeEntries: MixerRegimeEntry[] = [];

  for (const sp of regimeSpecs) {
    const anchor = getPhonationAnchorParams(sp.regime);
    const targetGlottis = [
      anchor.xb_cm,
      anchor.xt_cm,
      anchor.ca_cm2,
      anchor.lag_rad,
      anchor.ra,
      anchor.ps,
      anchor.fl,
      anchor.shim,
    ];
    const f0Arr: number[] = [];
    const glottisArr: number[][] = [];

    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / stepHz;
      const base = baseSamples[i];
      // Voiceless fricative protection on onset /s/ before t = 0.21s
      const w = t <= fricEndSec ? 0 : t >= fricEndSec + xfadeSec ? 1 : cosineEase((t - fricEndSec) / xfadeSec);
      const scaledF0 = base.f0 * (1 + (sp.f0Mul - 1) * w);
      f0Arr.push(Number(Math.max(62, Math.min(580, scaledF0)).toFixed(2)));
      glottisArr.push(interpolateVec(base.glottis, targetGlottis, w));
    }

    const synth = await synthesizeViaEngine(
      {
        f0_hz: f0Arr,
        pressure_pa: prArr,
        tract_frames: tract,
        glottis_frames: glottisArr,
        per_frame_shimmer: true,
        include_geometry: false,
      },
      signal,
    );
    audios[sp.regime] = base64ToArrayBuffer(synth.wav_base64!);
    regimeEntries.push({
      regime: sp.regime,
      label: sp.label,
      f0Hz: Math.round(anchor.f0_hz),
      xbCm: Number(anchor.xb_cm.toFixed(3)),
      caCm2: Number(anchor.ca_cm2.toFixed(3)),
      raPct: Math.round(anchor.ra * 100),
      shimPct: Math.round(anchor.shim),
      lagRad: Number(anchor.lag_rad.toFixed(2)),
      note: sp.note,
    });
  }

  return {
    payload: {
      kind: 'mixer-phonation',
      sourceWord: '汉语「算」[swan⁵¹]',
      durationSec: Number(totalSec.toFixed(2)),
      regimes: regimeEntries,
    },
    audios,
    engineLabel: 'VTL 2.4 动态「算」[swan] 发声态变调合成',
  };
}

/* ----------------------------------------------------------------------------
 * 5. ContinuumView: Mandarin 「算」[swan⁵¹] <-> English 「swan」[swɒn]
 * ---------------------------------------------------------------------------- */

async function runContinuumSuanSwanDemo(signal?: AbortSignal): Promise<{
  payload: ContinuumSuanSwanPayload;
  audios: Record<string, ArrayBuffer>;
  engineLabel: string;
}> {
  const [suan, swan] = await Promise.all([
    fetchPrewarmJson('prewarm/suan_mandarin.json', signal),
    fetchPrewarmJson('prewarm/swan_english.json', signal),
  ]);
  const totalSec = Number(Math.min(suan.duration_s || 0.85, swan.duration_s || 0.85));
  const stepHz = 200;
  const n = Math.max(20, Math.round(totalSec * stepHz));
  const suanGrid = Array.from({ length: n }, (_, i) => samplePrewarmAtTime(suan.geometry_frames, (i + 0.5) / stepHz));
  const swanGrid = Array.from({ length: n }, (_, i) => samplePrewarmAtTime(swan.geometry_frames, (i + 0.5) / stepHz));
  const nucFrameIdx = Math.min(n - 1, Math.round(0.48 * stepHz));

  const count = 8;
  const steps: ContinuumStepItem[] = [];
  const audios: Record<string, ArrayBuffer> = {};

  for (let s = 0; s < count; s++) {
    const u = s / (count - 1);
    const tract: number[][] = [];
    const f0: number[] = [];
    const pr: number[] = [];
    const glottis: number[][] = [];

    for (let i = 0; i < n; i++) {
      const a = suanGrid[i];
      const b = swanGrid[i];
      tract.push(interpolateVec(a.params19, b.params19, u));
      f0.push(Number(Math.max(62, Math.min(580, a.f0 + (b.f0 - a.f0) * u)).toFixed(2)));
      pr.push(Number(Math.max(0, Math.min(1600, a.pr + (b.pr - a.pr) * u)).toFixed(1)));
      glottis.push(interpolateVec(a.glottis, b.glottis, u));
    }

    const [snap, synth] = await Promise.all([
      poseViaEngine(tract[nucFrameIdx], {}, signal),
      synthesizeViaEngine(
        {
          f0_hz: f0,
          pressure_pa: pr,
          tract_frames: tract,
          glottis_frames: glottis,
          per_frame_shimmer: true,
          fps: 18,
          include_geometry: true,
        },
        signal,
      ),
    ]);
    const resHz = snap.resonances ?? [];
    const frames = mapGeometryFrames(synth.geometry_frames, f0[nucFrameIdx], 800);
    steps.push({
      index: s,
      u: Number(u.toFixed(2)),
      label: s === 0 ? '汉语「算」' : s === count - 1 ? '英语「swan」' : `融合 ${Math.round(u * 100)}%`,
      f1Hz: Math.round(resHz[0] ?? 0),
      f2Hz: Math.round(resHz[1] ?? 0),
      f3Hz: Math.round(resHz[2] ?? 0),
      aminCm2: Number((snap.oral_min_area ?? 0).toFixed(3)),
      durationSec: Number((synth.duration_s ?? totalSec).toFixed(2)),
      frames: frames.length ? frames : [{ t: 0, contours: snap.contours ?? buildAnalyticalContourFallback(), f0: Math.round(f0[nucFrameIdx]), prPa: 800 }],
    });
    audios[`s${s}`] = base64ToArrayBuffer(synth.wav_base64!);
  }

  return {
    payload: { kind: 'continuum-suan-swan', steps },
    audios,
    engineLabel: 'VTL 2.4「算 ↔ swan」8 格动态连续统求解',
  };
}

/* ----------------------------------------------------------------------------
 * 6. DialectView: Pure-frontend qTA Sandhi Evaluation (No Synthesized Audio)
 * ---------------------------------------------------------------------------- */

function evalToneContourHz(tones: string[], sylDurSec: number, fRefHz = 135): { timesMs: number[]; f0Hz: number[] } {
  const totalSec = tones.length * sylDurSec;
  const totalSmp = Math.round(totalSec * SAMPLE_RATE_HZ);
  const spans = tones.flatMap((digits, sIdx) => {
    const sStart = Math.round(sIdx * sylDurSec * SAMPLE_RATE_HZ);
    const sEnd = Math.round((sIdx + 1) * sylDurSec * SAMPLE_RATE_HZ);
    return toneLevelsToQtaTargets(digits, sylDurSec, [-6, 4]).map((tg, tIdx) => ({
      id: `s${sIdx}_${tIdx}`,
      span_id: `s${sIdx}_${tIdx}`,
      start_smp: Math.round(sStart + tg.fracStart * (sEnd - sStart)),
      end_smp: Math.round(sStart + tg.fracEnd * (sEnd - sStart)),
      voiced: true,
      candidates: { default: tg.candidate },
    }));
  });
  const res = evalF0({ spans, total_smp: totalSmp, step_smp: 480, f_ref_hz: fRefHz, context: 'speech' });
  const timesMs = res.ok ? res.value.times_smp.map((s) => Math.round((s / SAMPLE_RATE_HZ) * 1000)) : [];
  const f0Hz = res.ok ? res.value.f0_hz.map((f) => Number(f.toFixed(1))) : [];
  return { timesMs, f0Hz };
}

async function runDialectSandhiDemo(): Promise<{
  payload: DialectSandhiDemoPayload;
  engineLabel: string;
}> {
  const rawCases = [
    {
      id: 't3-pair',
      title: '双上声前字变阳平（普通话）',
      phrase: '老虎 [lau + xu]',
      ruleSummary: 'pair: 214 + 214 → 35 + 214（前字受后字低谷抑制升为阳平）',
      rawTones: ['214', '214'],
      sandhiTones: ['35', '214'],
    },
    {
      id: 't3-triple',
      title: '三上声左分支连读（普通话）',
      phrase: '买好马 [mai + xau + ma]',
      ruleSummary: 'word_pattern: [214+214]+214 → 35 + 35 + 214（非递归一次重写）',
      rawTones: ['214', '214', '214'],
      sandhiTones: ['35', '35', '214'],
    },
    {
      id: 'dialect-broad',
      title: '方言广用式前字变调示例',
      phrase: '天地 [tʰiɛn + ti]',
      ruleSummary: 'pair(word): 阴平 55 + 阴去 51 → 33 + 51（首字中平化）',
      rawTones: ['55', '51'],
      sandhiTones: ['33', '51'],
    },
  ];

  const cases: DialectSandhiCase[] = rawCases.map((rc) => {
    const durEach = 0.34;
    const rawEval = evalToneContourHz(rc.rawTones, durEach, 138);
    const sanEval = evalToneContourHz(rc.sandhiTones, durEach, 138);
    return {
      id: rc.id,
      title: rc.title,
      phrase: rc.phrase,
      ruleSummary: rc.ruleSummary,
      rawTones: rc.rawTones,
      sandhiTones: rc.sandhiTones,
      timesMs: rawEval.timesMs,
      rawF0Hz: rawEval.f0Hz,
      sandhiF0Hz: sanEval.f0Hz,
    };
  });

  return {
    payload: { kind: 'dialect-sandhi', cases },
    engineLabel: 'qTA 纯前端实时计算（零音频负担）',
  };
}

/* ----------------------------------------------------------------------------
 * 7. ArrangerView: Built-in 「长恨歌」 Opening Line (7 Syllables, G3, 84 BPM)
 * ---------------------------------------------------------------------------- */

async function runArrangerPrebeatDemo(signal?: AbortSignal): Promise<{
  payload: ArrangerPrebeatDemoPayload;
  audios: Record<string, ArrayBuffer>;
  engineLabel: string;
}> {
  const songTitle = '长恨歌（第一句）';
  const tonic = 'G3' as const;
  const bpm = 84;
  const scoreText = "(3'_ 2'_) (1'_ 6_) (1'_ 2'_) (3'___ 2'___ 3'_.) | (2'_ 3'_) (1'_ 6_) (2'___ 1'___ 2':1.75)";
  const lyrics = '汉皇重色思倾国';
  const tokens = [
    "(3'_ 2'_)",
    "(1'_ 6_)",
    "(1'_ 2'_)",
    "(3'___ 2'___ 3'_.)",
    "(2'_ 3'_)",
    "(1'_ 6_)",
    "(2'___ 1'___ 2':1.75)",
  ];
  const chars = ['汉', '皇', '重', '色', '思', '倾', '国'];
  const phonePairs: Array<{ onset: string; nucleus: string[]; labelIpa: string; onsetMs: number }> = [
    { onset: 'x', nucleus: ['a'], labelIpa: 'xan', onsetMs: 75 },
    { onset: 'x', nucleus: ['u', 'ɑ'], labelIpa: 'xwɑŋ', onsetMs: 70 },
    { onset: 'ʈʂ', nucleus: ['u', 'o'], labelIpa: 'ʈʂuŋ', onsetMs: 85 },
    { onset: 's', nucleus: ['ɤ'], labelIpa: 'sɤ', onsetMs: 90 },
    { onset: 's', nucleus: ['ɨ'], labelIpa: 'sɨ', onsetMs: 90 },
    { onset: 'tɕʰ', nucleus: ['i'], labelIpa: 'tɕʰiŋ', onsetMs: 95 },
    { onset: 'k', nucleus: ['u', 'o'], labelIpa: 'kwo', onsetMs: 70 },
  ];

  // Spaces in arranger notation separate rhythmic groups rather than adding 1-beat rests.
  const normalizedScore = scoreText.trim().replace(/\s+/gu, '|');
  const parsed = parseNumberedScore(normalizedScore, tonic, bpm, true, chars.length);
  if (!parsed.ok) {
    throw new Error(parsed.issue.message);
  }

  const syllables: ScheduleSyllableInput[] = chars.map((ch, idx) => ({
    id: `syl_${idx}`,
    text: ch,
    lead_policy: 'nucleus_on_beat',
    segments: [
      {
        id: `seg_${idx}_on`,
        ipa: phonePairs[idx].onset,
        role: 'onset',
        voiced: false,
        preferred_ms: phonePairs[idx].onsetMs,
        min_ms: 45,
      },
      {
        id: `seg_${idx}_nuc`,
        ipa: phonePairs[idx].nucleus[0],
        role: 'nucleus',
        voiced: true,
        preferred_ms: 340,
        min_ms: 90,
      },
    ],
  }));

  const schedRes = schedule({
    syllables,
    score: parsed.score,
    bpm,
    f_ref_hz: 220,
    leading_reserve_ms: 140,
    base_pressure_pa: 820,
  });

  if (!schedRes.ok) {
    throw new Error(schedRes.error.hint);
  }

  const out = schedRes.value;
  // Recover syllable start pitch from first non-carry note per group
  const leadMidis = parsed.score.notes.filter((n) => n.midi !== null && !n.carry).map((n) => n.midi!);
  const notes: ArrangerNoteItem[] = out.syllables.map((s, idx) => {
    const midi = leadMidis[idx] ?? 64;
    return {
      syllable: s.text,
      ipa: phonePairs[idx].labelIpa,
      token: tokens[idx] ?? '1',
      midi,
      noteHz: Number((440 * Math.pow(2, (midi - 69) / 12)).toFixed(1)),
      beatStartMs: Math.round((s.beat_smp / SAMPLE_RATE_HZ) * 1000),
      onsetStartMs: Math.round((s.start_smp / SAMPLE_RATE_HZ) * 1000),
      nucleusStartMs: Math.round((s.nucleus_start_smp / SAMPLE_RATE_HZ) * 1000),
      endMs: Math.round((s.end_smp / SAMPLE_RATE_HZ) * 1000),
      leadMs: Math.round(s.lead_ms),
      pressurePa: Math.round(s.pressure_pa),
    };
  });

  const audios: Record<string, ArrayBuffer> = {};
  let hasAudio = false;
  try {
    await preloadPtbIpaPresets('JD2');
    const stepHz = 200;
    const nFrames = out.f0_hz.length;
    const tractFrames: number[][] = [];
    for (let i = 0; i < nFrames; i++) {
      const smp = Math.round(((i + 0.5) / stepHz) * SAMPLE_RATE_HZ);
      const seg = out.segments.find((sg) => smp >= sg.start_smp && smp < sg.end_smp) ?? out.segments[out.segments.length - 1];
      const sylIdx = out.syllables.findIndex((sy) => smp >= sy.start_smp && smp < sy.end_smp);
      let pose: number[];
      if (seg?.role === 'nucleus' && sylIdx >= 0 && phonePairs[sylIdx].nucleus.length > 1) {
        const nucPhones = phonePairs[sylIdx].nucleus;
        const frac = Math.max(0, Math.min(1, (smp - seg.start_smp) / Math.max(1, seg.end_smp - seg.start_smp)));
        const p0 = resolvePtbIpaPose(nucPhones[0], 'JD2').params19;
        const p1 = resolvePtbIpaPose(nucPhones[1], 'JD2').params19;
        pose = interpolateVec(p0, p1, frac);
      } else {
        pose = resolvePtbIpaPose(seg?.ipa ?? 'a', 'JD2').params19;
      }
      tractFrames.push(pose);
    }
    const f0Clamped = out.f0_hz.map((v) => Math.max(62, Math.min(580, v)));
    const synth = await synthesizeViaEngine(
      {
        f0_hz: f0Clamped,
        pressure_pa: out.pressure_pa,
        tract_frames: tractFrames,
        include_geometry: false,
      },
      signal,
    );
    audios.song = base64ToArrayBuffer(synth.wav_base64!);
    hasAudio = true;
  } catch {
    hasAudio = false;
  }

  return {
    payload: {
      kind: 'arranger-prebeat',
      songTitle,
      tonic,
      bpm,
      scoreText,
      lyrics,
      totalSec: Number((out.total_smp / SAMPLE_RATE_HZ).toFixed(2)),
      notes,
      hasAudio,
    },
    audios,
    engineLabel: hasAudio ? '简谱调度内核 + VTL 2.4 实时试唱《长恨歌》' : '简谱抢拍内核纯前端计算（离线模式）',
  };
}

/* ----------------------------------------------------------------------------
 * 8. ExploreLabView: Dual comparison
 * ---------------------------------------------------------------------------- */

async function runExploreCompareDemo(signal?: AbortSignal): Promise<{
  payload: ExploreCompareDemoPayload;
  audios: Record<string, ArrayBuffer>;
  engineLabel: string;
}> {
  await preloadPtbIpaPresets('JD2');
  const [a, b] = await Promise.all([
    solveVowelItem('i', '/i/ 前高不圆唇', signal),
    solveVowelItem('y', '/y/ 前高圆唇', signal),
  ]);
  return {
    payload: { kind: 'explore-compare', left: a.item, right: b.item },
    audios: { left: a.wav, right: b.wav },
    engineLabel: 'VTL 2.4 双音对比求解',
  };
}

export async function executeAndCacheGuideDemo(
  demoId: string,
  kind: GuideDemoKind,
  signal?: AbortSignal,
): Promise<CachedGuideDemo<AnyGuideDemoPayload>> {
  const t0 = performance.now();
  let payload: AnyGuideDemoPayload;
  let audios: Record<string, ArrayBuffer> | undefined;
  let engineLabel = '本机实时计算';

  switch (kind) {
    case 'main-voqs': {
      const r = await runMainVoqsDemo(signal);
      payload = r.payload;
      audios = r.audios;
      engineLabel = r.engineLabel;
      break;
    }
    case 'ipa-rounding': {
      const r = await runIpaRoundingDemo(signal);
      payload = r.payload;
      audios = r.audios;
      engineLabel = r.engineLabel;
      break;
    }
    case 'm27-roundtrip': {
      const r = await runM27RoundtripDemo(signal);
      payload = r.payload;
      audios = r.audios;
      engineLabel = r.engineLabel;
      break;
    }
    case 'mixer-phonation': {
      const r = await runMixerPhonationDemo(signal);
      payload = r.payload;
      audios = r.audios;
      engineLabel = r.engineLabel;
      break;
    }
    case 'continuum-suan-swan': {
      const r = await runContinuumSuanSwanDemo(signal);
      payload = r.payload;
      audios = r.audios;
      engineLabel = r.engineLabel;
      break;
    }
    case 'dialect-sandhi': {
      const r = await runDialectSandhiDemo();
      payload = r.payload;
      engineLabel = r.engineLabel;
      break;
    }
    case 'arranger-prebeat': {
      const r = await runArrangerPrebeatDemo(signal);
      payload = r.payload;
      audios = r.audios;
      engineLabel = r.engineLabel;
      break;
    }
    case 'explore-compare': {
      const r = await runExploreCompareDemo(signal);
      payload = r.payload;
      audios = r.audios;
      engineLabel = r.engineLabel;
      break;
    }
  }

  const computeMs = Math.round(performance.now() - t0);
  return saveDemoCache<AnyGuideDemoPayload>({
    demoId,
    createdAt: Date.now(),
    engineLabel,
    computeMs,
    payload,
    audios,
  });
}
