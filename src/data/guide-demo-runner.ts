/**
 * Real-Time Local Computation & Synthesis Runner for Interactive Guide Demos.
 *
 * Every demonstration runs directly on the user's machine through VoxFigura's
 * real production pipelines (`@vocalcut/core`, `buildAnnotationSynthesis`,
 * `parseVoqsScopedText`, `applyDialectSandhi`, `buildContinuum2D`,
 * `readMidiParts`, `renderInstrumentTimeline`, `detectBeatGridFromPcm`,
 * `/api/models/ipa-references/*`, `/api/models/voice-morph`, `/api/m27/*`,
 * `/api/vtl/*`) using real bundled human recordings, reference library assets,
 * and built-in scores — zero synthetic fallback data or fake sine-wave tongues.
 *
 * Never mutates global project state; persists outputs into `guide-demo-cache.ts`.
 */

import {
  CANTONESE_DIALECT_PACK,
  DEFAULT_BASE_PRESSURE_PA,
  DYNAMIC_STEP_PA,
  MANDARIN_DIALECT_PACK,
  PHONATION_M27_ANCHORS,
  PRESSURE_LIMIT_PA,
  SAMPLE_RATE_HZ,
  applyDialectSandhi,
  assertInRange,
  buildContinuum2D,
  evalF0,
  isValidF0Hz,
  msToSamples,
  samplesToMs,
  type Clip,
  type ContinuumLandmark,
  type DialectTonePack,
  type PhonationRegime,
  type SandhiSyllableInput,
  type Syllable,
} from '@vocalcut/core';
import { defaultM27Adapter, defaultVtlTransport, type M27TrajectoryAnim } from '@vocalcut/model-adapters';
import { preloadPtbIpaPresets, resolvePtbIpaPose } from '@/data/ptb-ipa-presets';
import {
  CONTINUUM_REAL_PAIR_SAMPLES,
  ONBOARDING_AUDIO_SLOTS,
  fetchOnboardingAudioFile,
} from '@/data/onboarding-samples';
import {
  fetchIpaReferenceTrajectory,
  fetchIpaReferences,
  findTargetInterval,
  ipaReferenceUrl,
  matchingIpaReferences,
} from '@/data/ipa-reference-library';
import { loadRecordedVowelFormants, vowelSymbolKey } from '@/data/ipa-vowel-measurements';
import { DIALECT_PACKS } from '@/data/dialect-packs';
import { coreDialect } from '@/data/dialect-user-library';
import { buildSyllableQtaTargets } from '@/data/ipa-segments';
import { connectedRuleDurationScale, speechPhoneDurations } from '@/data/speech-timing';
import {
  buildPhonationAnchorsFromVoqsSyllables,
  materializeVoqsAnchorShape,
  parseVoqsScopedText,
} from '@/data/voqs-parser';
import { saveDemoCache, type CachedGuideDemo } from '@/data/guide-demo-cache';
import type { GuideDemoKind } from '@/data/guide-types';
import type { WorkspaceAudio } from '@/data/workspace-transfer';
import { encodeWavFromAudioBuffer } from '@/components/modals/download';
import { detectBeatGridFromPcm } from '@/components/studio/stage-beat-sync';
import { readMidiParts } from '@/components/studio/midi-score';
import { renderInstrumentTimeline } from '@/components/studio/piano';
import type { InstrumentCue } from '@/components/studio/instrument-voices';
import { analyzeLyrics, midiHz, readingStandard } from '@/components/studio/arranger-edit';
import { parseScoreToEvents } from '@/components/studio/arranger-notation-sync';
import { compileArrangement } from '@/components/studio/arranger-compile';
import { everlastingRegretExample } from '@/components/studio/arranger-examples';
import { buildAnnotationSynthesis } from '@/components/research/annotation-audio';
import { evaluateControlPitch } from '@/components/research/control-pitch';
import {
  alignEndpointTimings,
  interpolatePose,
  resolveContinuumFramePitch,
  sourceControls,
  sourceTrajectory,
  timeWarp,
} from '@/components/research/continuum-media';
import { splitM27TractParts } from '@/components/research/m27-hd-renderers';
import { buildSegmentsForSyllable, estimateSyllableNaturalDurationMs } from '@/components/research/research-utils';
import {
  VOQS_BUILTIN_PRESET_DEFAULTS,
  isMixerPresetDisabled,
  mixerRequest,
  normalizeMixerPreset,
  type MixerAnalysis,
  type MixerMeta,
  type MixerRender,
  type MixerSynth,
} from '@/components/research/voice-mixer';
import { createInitialProject, defaultTractParams, tractRecordToArray19 } from '@/stores/workbench';

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
  voqsSymbol: string;
  sourceId: string;
  regime: PhonationRegime;
  glottisNote: string;
  xbCm: number;
  caCm2: number;
  raPct: number;
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
  refId: string;
  refTitle: string;
  coreSec: number;
  hasRecordedAudio: boolean;
  hasReconAudio: boolean;
  /** Real Praat Burg formants measured on the human reference recording */
  recordedF1Hz: number | null;
  recordedF2Hz: number | null;
  recordedF3Hz: number | null;
  /** VTL 65-section H(f) transfer peaks evaluated on the inverted steady-state frame */
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
  presetId: string;
  regime: string;
  label: string;
  prPa: number;
  xbCm: number;
  caCm2: number;
  raPct: number;
  shimPct: number;
  lagRad: number;
  f0ShiftSt: number;
  synthMs: number;
  note: string;
}

export interface MixerPhonationDemoPayload {
  kind: 'mixer-phonation';
  sourceWord: string;
  synthLabel: string;
  durationSec: number;
  invertMs: number;
  hasBaseline: boolean;
  timesSec: number[];
  voicedGate: number[];
  effectiveWeight: number[];
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
  equalizedDurationSec: number;
  endpointALabel: string;
  endpointBLabel: string;
  hasEndpointRecordings: boolean;
  steps: ContinuumStepItem[];
}

export interface DialectSandhiCase {
  id: string;
  packName: string;
  title: string;
  phrase: string;
  ruleSummary: string;
  rawTones: string[];
  sandhiTones: string[];
  rewrittenTraces: string[];
  durScales: number[];
  checkedFlags: boolean[];
  timesMs: number[];
  rawF0Hz: number[];
  sandhiF0Hz: number[];
}

export interface DialectSandhiDemoPayload {
  kind: 'dialect-sandhi';
  cases: DialectSandhiCase[];
}

export interface ArrangerDemoPhoneSeg {
  ipa: string;
  role: 'onset' | 'nucleus' | 'coda' | 'aspiration' | 'rest';
  voiced: boolean;
  startMs: number;
  endMs: number;
}

export interface ArrangerDemoSyllableItem {
  char: string;
  ipa: string;
  token: string;
  policy: 'nucleus_on_beat' | 'speech_timing';
  leadMs: number;
  beatStartMs: number;
  startMs: number;
  nucleusStartMs: number;
  endMs: number;
  segments: ArrangerDemoPhoneSeg[];
}

export interface ArrangerDemoNoteBlock {
  rowIdx: number;
  char: string;
  midi: number;
  hz: number;
  startMs: number;
  endMs: number;
  isContinuation: boolean;
}

export interface ArrangerDemoModeVariant {
  leadEnabled: boolean;
  syllables: ArrangerDemoSyllableItem[];
  f0Curve: Array<{ tMs: number; hz: number }>;
  totalSec: number;
  hasAudio: boolean;
}

export interface ArrangerPrebeatDemoPayload {
  kind: 'arranger-prebeat';
  songTitle: string;
  credit: string;
  tonic: string;
  bpm: number;
  scoreText: string;
  lyrics: string;
  minMidi: number;
  maxMidi: number;
  beatTimesMs: number[];
  notes: ArrangerDemoNoteBlock[];
  leadOn: ArrangerDemoModeVariant;
  leadOff: ArrangerDemoModeVariant;
  audioStatusNote?: string;
}

export interface StageCinemaDemoPayload {
  kind: 'stage-cinema';
  sourceTitle: string;
  scoreBpm: number;
  bpm: number;
  t0Sec: number;
  confidence: number;
  beatTimesSec: number[];
  strongHitSec: number[];
  envelopeTimesSec: number[];
  envelopeValues: number[];
  durationSec: number;
  hasAudio: boolean;
  tractFrames: TractAnimFrame[];
  lyricText: string;
  ipaText: string;
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
  | StageCinemaDemoPayload
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

/** Detect audio MIME type from binary magic bytes so both WAV and MP3 buffers play cleanly. */
export function detectAudioMimeType(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf, 0, Math.min(12, buf.byteLength));
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41) {
    return 'audio/wav';
  }
  if (b.length >= 4 && b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) {
    return 'audio/flac';
  }
  if (b.length >= 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) {
    return 'audio/ogg';
  }
  if ((b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) {
    return 'audio/mpeg';
  }
  return 'audio/wav';
}

function interpolateVec(a: readonly number[], b: readonly number[], t: number): number[] {
  const u = Math.max(0, Math.min(1, t));
  return a.map((v, i) => v + ((b[i] ?? v) - v) * u);
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
  const res = await defaultVtlTransport.requestPoseRaw(
    {
      speaker: 'JD2',
      section_count: 65,
      params: params19,
      lip_width: extras.lip_width ?? 1.0,
      larynx_height: extras.larynx_height ?? 0.0,
      manual_root: extras.manual_root ?? false,
      tongue_shape: extras.tongue_shape ?? [0, 0, 0, 0],
      lip_shape: extras.lip_shape ?? [0, 0, 0, 0],
    },
    { signal, timeoutMs: 12_000 },
  );
  if (!res.ok) {
    throw new Error(res.error.hint || '本地声道几何接口不可用');
  }
  return res.value as VtlPoseApiResponse;
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
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<VtlSynthApiResponse> {
  const res = await defaultVtlTransport.requestSynthesizeRaw(
    {
      speaker: 'JD2',
      synth_mode: 'physical',
      step_hz: 200,
      fps: 25,
      include_geometry: true,
      audio_gain: 'peak',
      ...payload,
    },
    { signal, timeoutMs: 45_000 },
  );
  if (!res.ok || res.value.kind !== 'json') {
    throw new Error(!res.ok ? res.error.hint : '本地 VTL 2.4 引擎未返回音频');
  }
  const data = res.value.data as VtlSynthApiResponse;
  if (!data.wav_base64) {
    throw new Error(data.error?.hint ?? '本地 VTL 2.4 引擎未返回音频');
  }
  return data;
}

interface PrewarmFrame {
  t_s: number;
  params: number[];
  contours?: ContourDict;
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
    throw new Error(`未能加载轨迹文件 ${relativePath}（HTTP ${res.status}）`);
  }
  const data = (await res.json()) as PrewarmJson;
  if (!Array.isArray(data.geometry_frames) || data.geometry_frames.length < 2) {
    throw new Error(`轨迹文件 ${relativePath} 缺少有效构音帧`);
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

function mapGeometryFrames(
  rawFrames: VtlSynthApiResponse['geometry_frames'],
  fallbackF0 = 135,
  fallbackPr = 800,
): TractAnimFrame[] {
  const out: TractAnimFrame[] = [];
  for (const f of rawFrames ?? []) {
    if (!f.contours || !Object.keys(f.contours).length) continue;
    out.push({
      t: Number(f.t_s.toFixed(2)),
      contours: f.contours,
      f0: Math.round(f.f0_hz ?? fallbackF0),
      prPa: Math.round(f.pressure_pa ?? fallbackPr),
    });
  }
  return out;
}

function m27RowToTract19(row: readonly number[]): number[] {
  return [...row.slice(0, 14), 0, 0, row[14] ?? 0, row[15] ?? 0, row[16] ?? 0];
}

/* ----------------------------------------------------------------------------
 * 1. ResearchMainView: Real VoQS Parser + VoQS Recording Anchors +
 *    buildAnnotationSynthesis + VTL 2.4 Synthesis
 * ---------------------------------------------------------------------------- */

async function runMainVoqsDemo(signal?: AbortSignal): Promise<{
  payload: MainVoqsDemoPayload;
  audios: Record<string, ArrayBuffer>;
  engineLabel: string;
}> {
  await preloadPtbIpaPresets('JD2');
  const poseM = resolvePtbIpaPose('m', 'JD2').params19;
  const poseA = resolvePtbIpaPose('a', 'JD2').params19;
  const neutralTract = tractRecordToArray19(defaultTractParams());

  const specs: Array<{
    id: string;
    label: string;
    charText: string;
    notation: string;
    tone: string;
  }> = [
    {
      id: 'modal',
      label: '阴平 · 常态浊声 (V)',
      charText: '妈',
      notation: '[ma˥˥]',
      tone: '55',
    },
    {
      id: 'breathy',
      label: '阳平 · 3 度气声 (3V̤)',
      charText: '麻',
      notation: '{3V̤ [ma˧˥] 3V̤}',
      tone: '35',
    },
    {
      id: 'pressed',
      label: '去声 · 3 度紧声 (3V͈)',
      charText: '骂',
      notation: '{3V͈ [ma˥˩] 3V͈}',
      tone: '51',
    },
    {
      id: 'whisper',
      label: '阴平 · 3 度耳语 (3W)',
      charText: '妈',
      notation: '{3W [ma˥˥] 3W}',
      tone: '55',
    },
  ];

  const clips: MainVoqsClipResult[] = [];
  const audios: Record<string, ArrayBuffer> = {};
  const phonemes = ['m', 'a'];
  const phoneMs = speechPhoneDurations(phonemes);
  const totalMs = estimateSyllableNaturalDurationMs(phonemes, connectedRuleDurationScale(phonemes, 1.0, 'zh'), 1.0, phoneMs);
  const totalSec = totalMs / 1000;
  const totalSmp = msToSamples(totalMs);

  for (const sp of specs) {
    // Parse real VoQS brace syntax via production recursive-descent parser
    const parsedVoqs = parseVoqsScopedText(sp.notation);
    const activeChunk = parsedVoqs.chunks.find((c) => c.text.trim().length > 0);
    const activeState = activeChunk?.state ?? null;
    const anchorShape = materializeVoqsAnchorShape(activeState);

    const project = createInitialProject();
    const voiceId = project.voice_order[0];
    const refHz = project.voices[voiceId]?.f0_ref_hz ?? 165;
    const sylId = `guide_voqs_syl_${sp.id}`;
    const segments = buildSegmentsForSyllable(sylId, phonemes, 0, totalSmp, 'JD2', undefined, {
      speechPhoneMs: phoneMs,
    });
    segments[0].params = [...poseM];
    segments[1].params = [...poseA];
    const targets = buildSyllableQtaTargets(sylId, 0, totalSmp, {
      effectiveTone: sp.tone,
      fRefHz: refHz,
      voiced: true,
    });

    const syllable: Syllable = {
      id: sylId,
      text: sp.charText,
      ipa: phonemes,
      start_smp: 0,
      end_smp: totalSmp,
      nucleus_index: 1,
      anchor: { policy: 'speech_timing', lead_ms: 0, bias_ms: 0 },
      segments,
      targets,
      overrides: {
        poses: [],
        f0_resid: [],
        pressure: [
          { u: 0, pressure_pa: 640 },
          { u: 0.35, pressure_pa: 840 },
          { u: 0.85, pressure_pa: 760 },
          { u: 1, pressure_pa: 500 },
        ],
        glottis: [{ u0: 0, u1: 1, preset: 'modal', blend: 1 }],
      },
    };
    const clip: Clip = {
      id: `guide_voqs_clip_${sp.id}`,
      kind: 'phrase',
      voice_id: voiceId,
      start_smp: 0,
      end_smp: totalSmp,
      syllable_order: [sylId],
      syllables: { [sylId]: syllable },
    };

    const anchors = buildPhonationAnchorsFromVoqsSyllables([
      { syllableId: sylId, startSmp: 0, endSmp: totalSmp, state: activeState },
    ]);

    const plan = buildAnnotationSynthesis(
      project,
      clip,
      anchors,
      0,
      totalSmp,
      {
        f0Hz: refHz,
        tract: neutralTract,
        releaseTract: neutralTract,
        lipWidth: 1,
        larynxHeight: 0,
      },
    );
    if (!plan.ok) {
      throw new Error(plan.error.hint || `VoQS 生产编译失败（${sp.notation}）`);
    }

    const res = await synthesizeViaEngine(
      {
        ...plan.value,
        sample_count: totalSmp,
        fps: 24,
        include_geometry: true,
      },
      signal,
    );
    audios[sp.id] = base64ToArrayBuffer(res.wav_base64!);
    const frames = mapGeometryFrames(res.geometry_frames, plan.value.f0_hz[0], plan.value.pressure_pa[Math.floor(plan.value.pressure_pa.length / 2)]);
    if (!frames.length) {
      throw new Error(`本地 VTL 2.4 引擎未返回 ${sp.label} 的真实声道轮廓帧`);
    }

    const g = anchorShape.glottis ?? PHONATION_M27_ANCHORS[anchorShape.regime];
    const voqsSymbol = anchorShape.voqs?.symbol ?? 'V';
    const sourceId = anchorShape.voqs?.source_id ?? 'modal-anchor';
    const xbCm = Number(g.xb_cm.toFixed(3));
    const caCm2 = Number(g.ca_cm2.toFixed(3));
    const raPct = Math.round(g.ra * 100);
    const shimPct = Math.round(g.shim);
    const glottisNote = `标定来源 ${sourceId} · XB ${xbCm} cm · CA ${caCm2} cm² · RA ${raPct}% · SHIM ${shimPct}%`;

    clips.push({
      id: sp.id,
      label: sp.label,
      notation: sp.notation,
      voqsSymbol,
      sourceId,
      regime: anchorShape.regime,
      glottisNote,
      xbCm,
      caCm2,
      raPct,
      shimPct,
      f0RangeHz: [Math.round(Math.min(...plan.value.f0_hz)), Math.round(Math.max(...plan.value.f0_hz))],
      durationSec: Number((res.duration_s ?? totalSec).toFixed(2)),
      frames,
    });
  }

  return {
    payload: { kind: 'main-voqs', clips },
    audios,
    engineLabel: 'parseVoqsScopedText + buildAnnotationSynthesis + voqs-recordings 实录标定 + VTL 2.4',
  };
}

/* ----------------------------------------------------------------------------
 * 2. IpaPlusView & 9. ExploreLabView: Real IPA Reference Library Recordings
 *    (/i/ main-T221, /y/ main-T222, /u/ main-T226) + Real Praat Formants +
 *    Real Inverted Steady-State Frame -> 65-Section VTL H(f) & Reconstruction
 * ---------------------------------------------------------------------------- */

async function solveRealIpaReferenceVowel(
  symbol: string,
  label: string,
  references: Awaited<ReturnType<typeof fetchIpaReferences>>,
  recordedFormants: Awaited<ReturnType<typeof loadRecordedVowelFormants>>,
  signal?: AbortSignal,
): Promise<{ item: IpaVowelComparisonItem; recordedAudio?: ArrayBuffer; reconAudio?: ArrayBuffer }> {
  const matches = matchingIpaReferences(references, [symbol], false);
  const ref = matches.find((r) => r.exists && r.animation) ?? matches[0];
  if (!ref) {
    throw new Error(`本地参考录音库未找到音标 /${symbol}/ 的真人实录与反演轨迹`);
  }

  const [traj, recAudioRes, reconAudioRes] = await Promise.all([
    fetchIpaReferenceTrajectory(ref),
    fetch(ipaReferenceUrl(ref.id, 'audio', 'peak'), { signal: makeSignal(signal, 15_000) }).catch(() => null),
    fetch(ipaReferenceUrl(ref.id, 'reconstruction', 'peak'), { signal: makeSignal(signal, 25_000) }).catch(() => null),
  ]);

  const rows = traj.m27_50hz_pa;
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error(`参考录音 ${ref.id} 缺少 50 Hz 声道反演轨迹`);
  }

  const targetIv = findTargetInterval(ref, true);
  const coreSec = targetIv
    ? (targetIv.start_s + targetIv.end_s) * 0.5
    : (rows.length / 50) * 0.5;
  const coreFrameIdx = Math.max(0, Math.min(rows.length - 1, Math.round(coreSec * 50)));
  const coreRow = rows[coreFrameIdx];
  const vec19 = m27RowToTract19(coreRow);

  // Solve real 65-section transfer function H(f), area function A(x), and contours on the inverted steady-state frame
  const snap = await poseViaEngine(vec19, {}, signal);
  if (!snap.contours || !Object.keys(snap.contours).length) {
    throw new Error(`VTL 几何接口未能解析 ${ref.id} (/${symbol}/) 的真实声道轮廓`);
  }

  const recordedAudio = recAudioRes?.ok ? await recAudioRes.arrayBuffer() : undefined;
  let reconAudio = reconAudioRes?.ok ? await reconAudioRes.arrayBuffer() : undefined;
  if (!reconAudio) {
    // If pre-rendered reconstruction endpoint wasn't returned, synthesize directly from the real inverted trajectory without clamping
    const n = Math.min(rows.length, 60);
    const startIdx = Math.max(0, coreFrameIdx - Math.floor(n / 2));
    const slice = rows.slice(startIdx, startIdx + n);
    const voicedVals = slice.map((r) => r[17]).filter((hz) => isValidF0Hz(hz));
    const fallbackF0 = voicedVals.length ? voicedVals[Math.floor(voicedVals.length / 2)] : 130;
    const f0Series = slice.map((r) => {
      const hz = r[17];
      return isValidF0Hz(hz) ? hz : fallbackF0;
    });
    const prSeries = slice.map((r, idx) => {
      const pr = r[18] ?? 0;
      const checked = assertInRange(`trajectory[${idx}].pressure_pa`, pr, PRESSURE_LIMIT_PA.min, PRESSURE_LIMIT_PA.max, 'Pa');
      if (!checked.ok) {
        throw new Error(checked.error.hint || `轨迹帧 ${idx} 气压 ${pr} Pa 超出 [0, 1600] Pa`);
      }
      return pr;
    });
    const synth = await synthesizeViaEngine(
      {
        step_hz: 50,
        f0_hz: f0Series,
        pressure_pa: prSeries,
        tract_frames: slice.map(m27RowToTract19),
        glottis_frames: slice.map((r) => r.slice(19, 27)),
        include_geometry: false,
      },
      signal,
    );
    reconAudio = base64ToArrayBuffer(synth.wav_base64!);
  }

  const key = vowelSymbolKey(symbol);
  const measured = recordedFormants.find((r) => r.id === ref.id)
    ?? recordedFormants.find((r) => vowelSymbolKey(r.symbol) === key);
  const resHz = snap.resonances ?? [];

  return {
    item: {
      symbol,
      label,
      refId: ref.id,
      refTitle: ref.title,
      coreSec: Number(coreSec.toFixed(2)),
      hasRecordedAudio: Boolean(recordedAudio),
      hasReconAudio: Boolean(reconAudio),
      recordedF1Hz: measured ? Math.round(measured.f1) : null,
      recordedF2Hz: measured ? Math.round(measured.f2) : null,
      recordedF3Hz: measured?.f3 ? Math.round(measured.f3) : null,
      f1Hz: Math.round(resHz[0] ?? 0),
      f2Hz: Math.round(resHz[1] ?? 0),
      f3Hz: Math.round(resHz[2] ?? 0),
      aminCm2: Number((snap.oral_min_area ?? 0).toFixed(3)),
      lp: Number((vec19[4] ?? 0).toFixed(2)),
      tcx: Number((vec19[8] ?? 0).toFixed(2)),
      contours: snap.contours,
      areaFn: buildAreaFnFromPose(snap),
      transferFn: buildTransferFromPose(snap),
    },
    recordedAudio,
    reconAudio,
  };
}

async function runIpaRoundingDemo(signal?: AbortSignal): Promise<{
  payload: IpaRoundingDemoPayload;
  audios: Record<string, ArrayBuffer>;
  engineLabel: string;
}> {
  const [references, recordedFormants] = await Promise.all([
    fetchIpaReferences(),
    loadRecordedVowelFormants().catch(() => []),
  ]);

  const targets: Array<[string, string]> = [
    ['i', '/i/ 前高不圆唇'],
    ['y', '/y/ 前高圆唇'],
    ['u', '/u/ 后高圆唇'],
  ];
  const items: IpaVowelComparisonItem[] = [];
  const audios: Record<string, ArrayBuffer> = {};
  for (const [sym, label] of targets) {
    const solved = await solveRealIpaReferenceVowel(sym, label, references, recordedFormants, signal);
    items.push(solved.item);
    if (solved.recordedAudio) audios[`${sym}_rec`] = solved.recordedAudio;
    if (solved.reconAudio) audios[`${sym}_recon`] = solved.reconAudio;
  }

  return {
    payload: { kind: 'ipa-rounding', items },
    audios,
    engineLabel: '参考录音库真人实录（main-T221/T222/T226）+ Praat 实测共振峰 + VTL 65 截面求解',
  };
}

/* ----------------------------------------------------------------------------
 * 3. M27ReconstructView: Real Human `demo_zh_spkA.mp3` (Zero Synthetic Fallback)
 * ---------------------------------------------------------------------------- */

interface M27ReconstructApiResponse {
  ok?: boolean;
  dur_sec?: number;
  m27_50hz_pa?: number[][];
  tract_glottis_anim?: M27TrajectoryAnim;
  vtl_48k_wav_base64?: string;
  neural_16k_wav_base64?: string;
  alignment?: { phones?: Array<{ ipa: string; start_s: number; end_s: number; is_sil: boolean }> };
  error?: { code?: string; hint?: string };
}

async function postM27Reconstruct(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; data: M27ReconstructApiResponse }> {
  const { status, data, result } = await defaultM27Adapter.reconstructRaw<M27ReconstructApiResponse & Record<string, unknown>>(
    body,
    { signal, timeoutMs: 90_000 },
  );
  if (data) return { status, data };
  return { status, data: { ok: false, error: !result.ok ? result.error : undefined } };
}

async function runM27RoundtripDemo(signal?: AbortSignal): Promise<{
  payload: M27RoundtripDemoPayload;
  audios: Record<string, ArrayBuffer>;
  engineLabel: string;
}> {
  const sourceText = ONBOARDING_AUDIO_SLOTS.zh_spk_a.transcript;
  const sourceTitle = `真人原声「${sourceText}」`;

  const sampleRes = await fetchOnboardingAudioFile(
    ONBOARDING_AUDIO_SLOTS.zh_spk_a.relativeUrl,
    ONBOARDING_AUDIO_SLOTS.zh_spk_a.filename,
    signal,
  );
  if (!sampleRes.ok) {
    throw new Error(`未能载入内置真人原声 ${ONBOARDING_AUDIO_SLOTS.zh_spk_a.relativeUrl}（${sampleRes.reason}），不启用合成伪造回退`);
  }

  const decoder = new OfflineAudioContext(1, 1, SAMPLE_RATE_HZ);
  const decoded = await decoder.decodeAudioData(await sampleRes.file.arrayBuffer());
  const wave = encodeWavFromAudioBuffer(decoded);
  const sourceWavB64 = arrayBufferToBase64(await wave.arrayBuffer());
  const sourceFilename = sampleRes.file.name.replace(/\.[^./]+$/, '.wav');

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

  // Automatic downgrade only when built-in alignment fails due to missing optional/unloaded weights
  if (
    (status >= 400 || recon.ok === false) &&
    (recon.error?.code === 'model_unloaded' || (recon.error?.hint ?? '').includes('Vox2Align-Lite') || (recon.error?.hint ?? '').includes('对齐'))
  ) {
    alignmentNote = '当前对齐权重未就绪，已自动降级为无对齐纯声道反演；默认由 Vox2Tract-Lite 内置中英联合对齐，也可在设置中挂载自定义 Vox2Align-Lite v2。';
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

  // Reuse `tract_glottis_anim` returned directly by `/api/m27/reconstruct` (fallback to poseViaEngine only if omitted)
  const anim = recon.tract_glottis_anim;
  const sampledFrames: TractAnimFrame[] = [];
  if (anim?.frames?.length && Array.isArray(anim.parts) && Array.isArray(anim.part_sizes)) {
    const sampleCount = Math.min(16, anim.frames.length);
    for (let k = 0; k < sampleCount; k++) {
      const ai = Math.round((k / Math.max(1, sampleCount - 1)) * (anim.frames.length - 1));
      const af = anim.frames[ai];
      const contours = splitM27TractParts(af.pts, anim.parts, anim.part_sizes);
      if (!Object.keys(contours).length) continue;
      const fi = Math.max(0, Math.min(rows.length - 1, Math.round(af.t * 50 - 0.5)));
      sampledFrames.push({
        t: Number(af.t.toFixed(2)),
        contours,
        f0: Math.round(af.f0 ?? f0Out[fi] ?? 0),
        prPa: Math.round(af.pr_pa ?? prPa[fi] ?? 0),
        ca: Number((ca[fi] ?? 0).toFixed(3)),
      });
    }
  }
  if (!sampledFrames.length) {
    const sampleCount = Math.min(16, rows.length);
    for (let k = 0; k < sampleCount; k++) {
      const fi = Math.round((k / Math.max(1, sampleCount - 1)) * (rows.length - 1));
      const r = rows[fi];
      const snap = await poseViaEngine(m27RowToTract19(r), {}, signal);
      if (!snap.contours || !Object.keys(snap.contours).length) continue;
      sampledFrames.push({
        t: timesSec[fi],
        contours: snap.contours,
        f0: Math.round(f0Out[fi]),
        prPa: Math.round(prPa[fi]),
        ca: Number(ca[fi].toFixed(3)),
      });
    }
  }
  if (!sampledFrames.length) {
    throw new Error('本地声道反演未返回任何有效矢状面轮廓帧');
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
      isRealHuman: true,
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
      : 'Vox2Tract-Lite（内置中英联合对齐）+ VTL 2.4 / Tract2Vox-Lite',
  };
}

/* ----------------------------------------------------------------------------
 * 4. VoiceMixerView: Real `/api/models/voice-morph` Pipeline on Real Human
 *    Recording `demo_zh_spkA.mp3` (First Clause 「春江潮水连海平」)
 * ---------------------------------------------------------------------------- */

function trimAudioBufferToClause(decoded: AudioBuffer, maxSec: number): AudioBuffer {
  const sr = decoded.sampleRate;
  const targetLen = Math.min(decoded.length, Math.max(1, Math.round(maxSec * sr)));
  const ctx = new OfflineAudioContext(1, targetLen, sr);
  const out = ctx.createBuffer(1, targetLen, sr);
  const src = decoded.getChannelData(0);
  const dst = out.getChannelData(0);
  const fadeSamples = Math.min(Math.round(0.03 * sr), Math.floor(targetLen / 6));
  for (let i = 0; i < targetLen; i++) {
    let gain = 1;
    if (i >= targetLen - fadeSamples) {
      gain = (targetLen - 1 - i) / Math.max(1, fadeSamples);
    }
    dst[i] = (src[i] ?? 0) * gain;
  }
  return out;
}

async function runMixerPhonationDemo(signal?: AbortSignal): Promise<{
  payload: MixerPhonationDemoPayload;
  audios: Record<string, ArrayBuffer>;
  engineLabel: string;
}> {
  const sampleRes = await fetchOnboardingAudioFile(
    ONBOARDING_AUDIO_SLOTS.zh_spk_a.relativeUrl,
    ONBOARDING_AUDIO_SLOTS.zh_spk_a.filename,
    signal,
  );
  if (!sampleRes.ok) {
    throw new Error(`未能载入内置真人原声 ${ONBOARDING_AUDIO_SLOTS.zh_spk_a.relativeUrl}`);
  }

  const decoder = new OfflineAudioContext(1, 1, SAMPLE_RATE_HZ);
  const decoded = await decoder.decodeAudioData(await sampleRes.file.arrayBuffer());
  // Extract the clean first poetic clause 「春江潮水连海平」 (~2.45 s) for responsive real-time 5-preset rendering
  const clauseBuf = trimAudioBufferToClause(decoded, 2.45);
  const clauseWav = await encodeWavFromAudioBuffer(clauseBuf).arrayBuffer();
  const clauseB64 = arrayBufferToBase64(clauseWav);

  const meta = await mixerRequest<MixerMeta>(undefined, signal);
  const preferredSynth: MixerSynth = meta.synthesizers.some((s) => s.id === 'neural') ? 'neural' : 'physical';
  const synthLabel = meta.synthesizers.find((s) => s.id === preferredSynth)?.label ?? 'Tract2Vox-Lite / VTL 2.4';

  const analysis = await mixerRequest<MixerAnalysis>(
    {
      action: 'analyze',
      wav_base64: clauseB64,
      device: 'cpu',
    },
    signal,
  );

  // Representative 5 presets from active VoiceMixerView presets (all 14 main presets active)
  const activePresetIds = ['modal', 'breathy', 'pressed', 'falsetto', 'whisper'] as const;
  const availablePresets = meta.presets
    .map(normalizeMixerPreset)
    .filter((p) => !isMixerPresetDisabled(p));

  const targetPresets = activePresetIds
    .map((id) => availablePresets.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

  if (!targetPresets.length) {
    throw new Error('本地发声调音台未返回可用的内置发声类型预设');
  }

  // Real time-varying envelope: gentle onset ramp -> sustained peak sculpt -> smooth clause release
  const morphKnots = [
    { t: 0.0, v: 0.1 },
    { t: 0.22, v: 0.95 },
    { t: 0.78, v: 0.95 },
    { t: 1.0, v: 0.2 },
  ];

  const audios: Record<string, ArrayBuffer> = {
    orig: clauseWav,
  };
  const regimes: MixerRegimeEntry[] = [];
  let hasBaseline = false;
  let representativeEffectiveCurve: number[] = [];

  for (let idx = 0; idx < targetPresets.length; idx++) {
    const preset = targetPresets[idx];
    const renderRes = await mixerRequest<MixerRender>(
      {
        action: 'render_preset',
        clip_id: analysis.clip_id,
        preset_id: preset.id,
        knots: morphKnots,
        interp_mode: 'smoothstep',
        smooth_ms: 25,
        voicing_gate: true,
        f0_coupling: Boolean(preset.default_f0_coupling),
        f0_shift_semitones: null,
        creak_irregularity: preset.default_creak_irregularity ?? (preset.id.includes('creak') ? 0.3 : 0),
        synth: preferredSynth,
        device: 'cpu',
        audio_gain: 'peak',
        include_baseline: idx === 0,
      },
      signal,
    );

    audios[preset.id] = base64ToArrayBuffer(renderRes.audio_base64);
    if (idx === 0 && renderRes.baseline_audio_base64) {
      audios.baseline = base64ToArrayBuffer(renderRes.baseline_audio_base64);
      hasBaseline = true;
    }

    const appliedValues = Object.values(renderRes.applied_curves ?? {})[0];
    if ((!representativeEffectiveCurve.length || preset.id === 'breathy') && Array.isArray(appliedValues) && appliedValues.length) {
      representativeEffectiveCurve = appliedValues.map((v) => Number(v.toFixed(3)));
    }

    const s9 = preset.source9_phys_pa ?? VOQS_BUILTIN_PRESET_DEFAULTS[preset.id]?.source9_phys_pa ?? [820, 0.034, 0.039, 0.013, 1.38, 0.86, 0.47, 19.7, 6.7];
    regimes.push({
      presetId: preset.id,
      regime: preset.id,
      label: preset.label,
      prPa: Math.round(s9[0]),
      xbCm: Number(s9[1].toFixed(3)),
      caCm2: Number(s9[3].toFixed(3)),
      lagRad: Number(s9[4].toFixed(2)),
      raPct: Math.round(s9[5] * 100),
      shimPct: Math.round(s9[8]),
      f0ShiftSt: Number((renderRes.f0_shift_st ?? 0).toFixed(1)),
      synthMs: Math.round(renderRes.synth_ms ?? 0),
      note: preset.desc,
    });
  }

  const nFrames = analysis.voiced_gate.length;
  const timesSec = Array.from({ length: nFrames }, (_, i) => Number(((i + 0.5) / 50).toFixed(2)));
  const voicedGate = analysis.voiced_gate.map((v) => Number(v.toFixed(3)));
  const effectiveWeight = representativeEffectiveCurve.length === nFrames
    ? representativeEffectiveCurve
    : voicedGate;

  return {
    payload: {
      kind: 'mixer-phonation',
      sourceWord: '真人原声「春江潮水连海平」（2.45 s 实录片段）',
      synthLabel,
      durationSec: Number(analysis.dur_sec.toFixed(2)),
      invertMs: Math.round(analysis.invert_ms ?? 0),
      hasBaseline,
      timesSec,
      voicedGate,
      effectiveWeight,
      regimes,
    },
    audios,
    engineLabel: `/api/models/voice-morph 真实发声调音管线（${synthLabel}）`,
  };
}

/* ----------------------------------------------------------------------------
 * 5. ContinuumView: Real `buildContinuum2D()` + Real Endpoint Pair
 *    Mandarin 「算」[swan⁵¹] <-> English 「swan」[swɒn]
 * ---------------------------------------------------------------------------- */

async function runContinuumSuanSwanDemo(signal?: AbortSignal): Promise<{
  payload: ContinuumSuanSwanPayload;
  audios: Record<string, ArrayBuffer>;
  engineLabel: string;
}> {
  const [suan, swan, recA, recB] = await Promise.all([
    fetchPrewarmJson('prewarm/suan_mandarin.json', signal),
    fetchPrewarmJson('prewarm/swan_english.json', signal),
    fetchOnboardingAudioFile(CONTINUUM_REAL_PAIR_SAMPLES.sideA.relativeUrl, CONTINUUM_REAL_PAIR_SAMPLES.sideA.filename, signal),
    fetchOnboardingAudioFile(CONTINUUM_REAL_PAIR_SAMPLES.sideB.relativeUrl, CONTINUUM_REAL_PAIR_SAMPLES.sideB.filename, signal),
  ]);

  const audios: Record<string, ArrayBuffer> = {};
  if (recA.ok) audios.endpointA = await recA.file.arrayBuffer();
  if (recB.ok) audios.endpointB = await recB.file.arrayBuffer();

  const fileToWavB64 = async (file: File): Promise<{ b64: string; name: string }> => {
    const decoder = new OfflineAudioContext(1, 1, SAMPLE_RATE_HZ);
    const decoded = await decoder.decodeAudioData(await file.arrayBuffer());
    const wave = encodeWavFromAudioBuffer(decoded);
    return {
      b64: arrayBufferToBase64(await wave.arrayBuffer()),
      name: file.name.replace(/\.[^./]+$/, '.wav'),
    };
  };

  // Match ContinuumView onboarding tour: invert both real recordings via Vox2Tract-Lite when available
  let reconRowsA: number[][] | null = null;
  let reconRowsB: number[][] | null = null;
  let spkRefB64: string | undefined;
  let spkRefName: string | undefined;
  if (recA.ok && recB.ok) {
    try {
      const [wavA, wavB] = await Promise.all([fileToWavB64(recA.file), fileToWavB64(recB.file)]);
      spkRefB64 = wavA.b64;
      spkRefName = wavA.name;
      const [rA, rB] = await Promise.all([
        postM27Reconstruct(
          {
            wav_base64: wavA.b64,
            filename: wavA.name,
            text: '',
            lang: 'zh',
            alignment_mode: 'none',
            synth_mode: 'neural',
            audio_gain: 'original',
            device: 'cpu',
            fps: 25,
          },
          signal,
        ),
        postM27Reconstruct(
          {
            wav_base64: wavB.b64,
            filename: wavB.name,
            text: '',
            lang: 'en',
            alignment_mode: 'none',
            synth_mode: 'neural',
            audio_gain: 'original',
            device: 'cpu',
            fps: 25,
          },
          signal,
        ),
      ]);
      if (rA.status < 400 && rA.data.ok !== false && Array.isArray(rA.data.m27_50hz_pa) && rA.data.m27_50hz_pa.length >= 4) {
        reconRowsA = rA.data.m27_50hz_pa;
      }
      if (rB.status < 400 && rB.data.ok !== false && Array.isArray(rB.data.m27_50hz_pa) && rB.data.m27_50hz_pa.length >= 4) {
        reconRowsB = rB.data.m27_50hz_pa;
      }
    } catch {
      // Fall back to prewarm trajectories if local neural reconstruction is unavailable
    }
  }

  const m27RowToPose19 = (row: readonly number[]): number[] => [
    ...row.slice(0, 14),
    0,
    0,
    row[14] ?? 0,
    row[15] ?? 0,
    row[16] ?? 0,
  ];

  const durA = reconRowsA ? reconRowsA.length / 50 : Number(suan.duration_s || 0.85);
  const durB = reconRowsB ? reconRowsB.length / 50 : Number(swan.duration_s || 0.85);
  const buildEndpointWorkspace = (
    id: string,
    durSec: number,
    frames: readonly PrewarmFrame[],
    nucIpa: string,
    recRes: Awaited<ReturnType<typeof fetchOnboardingAudioFile>>,
    m27Override: number[][] | null,
  ): WorkspaceAudio => {
    const endSmp = msToSamples(durSec * 1000);
    const bounds = [0, 0.2, 0.4, 0.65, 1].map((u) => Math.round(u * endSmp));
    const samplePoseAtU = (u: number): number[] => {
      if (m27Override && m27Override.length) {
        const idx = Math.max(0, Math.min(m27Override.length - 1, Math.round(u * (m27Override.length - 1))));
        return m27RowToPose19(m27Override[idx]);
      }
      return samplePrewarmAtTime(frames, durSec * u).params19;
    };
    const segSpecs = [
      { ipa: 's', role: 'onset' as const, voiced: false, pose: samplePoseAtU(0.12) },
      { ipa: 'w', role: 'onset' as const, voiced: true, pose: samplePoseAtU(0.3) },
      { ipa: nucIpa, role: 'nucleus' as const, voiced: true, pose: samplePoseAtU(0.54) },
      { ipa: 'n', role: 'coda' as const, voiced: true, pose: samplePoseAtU(0.82) },
    ];
    const sylId = `${id}_syl`;
    const m27RowsPa =
      m27Override && m27Override.length
        ? m27Override.map((r) => [...r])
        : Array.from({ length: Math.max(2, Math.round(durSec * 50)) }, (_, i) => {
            const s = samplePrewarmAtTime(frames, (i + 0.5) / 50);
            return [
              ...s.params19.slice(0, 14),
              s.params19[16] ?? 0,
              s.params19[17] ?? 0,
              s.params19[18] ?? 0,
              s.f0,
              s.pr,
              ...s.glottis,
            ];
          });
    const normFrames =
      m27Override && m27Override.length
        ? m27Override.map((row, i) => ({
            u: m27Override.length > 1 ? i / (m27Override.length - 1) : 0,
            params: m27RowToPose19(row),
          }))
        : frames.map((f) => ({
            u: Math.max(0, Math.min(1, f.t_s / Math.max(1e-4, durSec))),
            params: [...f.params],
          }));
    const clip: Clip = {
      id: `${id}_clip`,
      kind: 'phrase',
      voice_id: 'JD2',
      start_smp: 0,
      end_smp: endSmp,
      syllable_order: [sylId],
      syllables: {
        [sylId]: {
          id: sylId,
          text: id,
          ipa: segSpecs.map((s) => s.ipa),
          start_smp: 0,
          end_smp: endSmp,
          nucleus_index: 2,
          anchor: { policy: 'speech_timing', lead_ms: 0, bias_ms: 0 },
          segments: segSpecs.map((seg, i) => ({
            id: `${sylId}_seg_${i}`,
            ipa: seg.ipa,
            role: seg.role,
            elastic: seg.role === 'nucleus',
            voiced: seg.voiced,
            start_smp: bounds[i],
            end_smp: bounds[i + 1],
            params: [...seg.pose],
          })),
          targets: [],
          overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
        },
      },
    };
    return {
      file: recRes.ok ? recRes.file : new File([], `${id}.mp3`, { type: 'audio/mpeg' }),
      clip,
      frames: normFrames,
      m27RowsPa,
      sourceKind: 'audio-reconstruct',
    };
  };

  const sourceA = buildEndpointWorkspace('suan', durA, suan.geometry_frames, 'a', recA, reconRowsA);
  const sourceB = buildEndpointWorkspace('swan', durB, swan.geometry_frames, 'ɒ', recB, reconRowsB);
  const alignment = alignEndpointTimings(sourceA, sourceB, true);
  const trajA = sourceTrajectory(sourceA, durA);
  const trajB = sourceTrajectory(sourceB, durB);

  const toLandmarks = (frames: readonly PrewarmFrame[], durSec: number, nucIpa: string): ContinuumLandmark[] => [
    {
      slot_id: 'onset_s',
      role: 'frication_end_voicing_onset',
      ipa: 's',
      manner: 'fricative',
      articulator: 'coronal',
      t_ms: Math.round(durSec * 150),
      params: samplePrewarmAtTime(frames, durSec * 0.15).params19,
    },
    {
      slot_id: 'medial_w',
      role: 'medial',
      ipa: 'w',
      manner: 'approximant',
      articulator: 'labial',
      t_ms: Math.round(durSec * 340),
      params: samplePrewarmAtTime(frames, durSec * 0.34).params19,
    },
    {
      slot_id: 'nucleus',
      role: 'nucleus',
      ipa: nucIpa,
      manner: 'vowel',
      articulator: 'vowel',
      t_ms: Math.round(durSec * 540),
      params: samplePrewarmAtTime(frames, durSec * 0.54).params19,
    },
    {
      slot_id: 'coda_n',
      role: 'coda',
      ipa: 'n',
      manner: 'nasal',
      articulator: 'coronal',
      t_ms: Math.round(durSec * 820),
      params: samplePrewarmAtTime(frames, durSec * 0.82).params19,
    },
  ];

  const count = 8;
  const specRes = buildContinuum2D({
    id: 'guide_continuum_suan_swan_8',
    label_a: CONTINUUM_REAL_PAIR_SAMPLES.sideA.label,
    label_b: CONTINUUM_REAL_PAIR_SAMPLES.sideB.label,
    landmarks_a: toLandmarks(suan.geometry_frames, durA, 'a'),
    landmarks_b: toLandmarks(swan.geometry_frames, durB, 'ɒ'),
    steps_a: count,
    steps_b: 1,
    equalize_duration: true,
    dim2: { kind: 'phonation', regime_a: 'modal', regime_b: 'modal' },
  });
  if (!specRes.ok) {
    throw new Error(specRes.error.hint || 'buildContinuum2D 生成连续统规格失败');
  }

  const totalSec = Math.max(durA, durB);
  const STEP_HZ = 100; // Matches ContinuumView.vue STEP_HZ = 100 (subsampled stride=2 -> 50 Hz for neural)
  const n = Math.max(20, Math.round((totalSec * STEP_HZ) / 2) * 2);
  const endpointF0A = sourceControls(sourceA, durA, 0.54)?.[17] ?? 135;
  const endpointF0B = sourceControls(sourceB, durB, 0.54)?.[17] ?? 135;
  const nucFrameIdx = Math.min(n - 1, Math.round(0.54 * n));

  const steps: ContinuumStepItem[] = [];
  let usedNeural = false;

  for (let s = 0; s < specRes.value.cells.length; s++) {
    const cell = specRes.value.cells[s];
    const u = cell.alpha_a;
    const warp = timeWarp(alignment, u);
    const tract: number[][] = [];
    const f0: number[] = [];
    const pr: number[] = [];
    const glottis: number[][] = [];

    for (let i = 0; i < n; i++) {
      const [ua, ub] = warp((i + 0.5) / n);
      const poseA = interpolatePose(trajA, ua);
      const poseB = interpolatePose(trajB, ub);
      const ctrlA = sourceControls(sourceA, durA, ua);
      const ctrlB = sourceControls(sourceB, durB, ub);
      const sampleA = samplePrewarmAtTime(suan.geometry_frames, ua * durA);
      const sampleB = samplePrewarmAtTime(swan.geometry_frames, ub * durB);

      tract.push(interpolateVec(poseA, poseB, u));
      const f0Res = resolveContinuumFramePitch({
        leftF0Hz: ctrlA?.[17],
        rightF0Hz: ctrlB?.[17],
        leftEndpointF0Hz: endpointF0A,
        rightEndpointF0Hz: endpointF0B,
        alpha: u,
        axisOverrideHz: null,
        frameIndex: i,
      });
      if (!f0Res.ok) {
        throw new Error(f0Res.error.hint || `连续统 S${s} 第 ${i} 帧 F0 越界`);
      }
      f0.push(Number(f0Res.value.toFixed(2)));

      const rawPr = (ctrlA?.[18] ?? sampleA.pr) + ((ctrlB?.[18] ?? sampleB.pr) - (ctrlA?.[18] ?? sampleA.pr)) * u;
      const prCheck = assertInRange(`S${s}[${i}].pressure_pa`, rawPr, PRESSURE_LIMIT_PA.min, PRESSURE_LIMIT_PA.max, 'Pa');
      if (!prCheck.ok) {
        throw new Error(prCheck.error.hint || `连续统 S${s} 第 ${i} 帧气压越界`);
      }
      pr.push(Number(rawPr.toFixed(1)));
      glottis.push(interpolateVec(ctrlA ? ctrlA.slice(19, 27) : sampleA.glottis, ctrlB ? ctrlB.slice(19, 27) : sampleB.glottis, u));
    }

    const rowsData50Hz = tract.flatMap((pose, i) =>
      i % 2 ? [] : [[...pose.slice(0, 14), ...pose.slice(16), f0[i], pr[i], ...glottis[i]]],
    );

    const [snap, neuralRes] = await Promise.all([
      poseViaEngine(tract[nucFrameIdx], {}, signal),
      defaultM27Adapter
        .resynthesize({
          m27_50hz_pa: rowsData50Hz,
          synth_mode: 'neural',
          audio_gain: 'original',
          speaker_ref_wav_base64: spkRefB64,
          speaker_ref_filename: spkRefName,
          signal,
        })
        .catch(() => null),
    ]);

    const resHz = snap.resonances ?? [];
    let frames: TractAnimFrame[] = [];
    let wavBuf: ArrayBuffer | null = null;
    let stepDurSec = totalSec;

    if (neuralRes && neuralRes.ok && neuralRes.value.neural_16k_wav_base64) {
      usedNeural = true;
      wavBuf = base64ToArrayBuffer(neuralRes.value.neural_16k_wav_base64);
      stepDurSec = rowsData50Hz.length / 50;
      const anim = neuralRes.value.tract_glottis_anim;
      if (anim?.frames?.length && Array.isArray(anim.parts) && Array.isArray(anim.part_sizes)) {
        const sampleCount = Math.min(18, anim.frames.length);
        for (let k = 0; k < sampleCount; k++) {
          const ai = Math.round((k / Math.max(1, sampleCount - 1)) * (anim.frames.length - 1));
          const af = anim.frames[ai];
          const contours = splitM27TractParts(af.pts, anim.parts, anim.part_sizes);
          if (!Object.keys(contours).length) continue;
          const fi = Math.max(0, Math.min(rowsData50Hz.length - 1, Math.round(af.t * 50 - 0.5)));
          frames.push({
            t: Number(af.t.toFixed(2)),
            contours,
            f0: Math.round(af.f0 ?? rowsData50Hz[fi][17] ?? 0),
            prPa: Math.round(af.pr_pa ?? rowsData50Hz[fi][18] ?? 0),
          });
        }
      }
    }

    if (!wavBuf || !frames.length) {
      const synth = await synthesizeViaEngine(
        {
          step_hz: STEP_HZ,
          f0_hz: f0,
          pressure_pa: pr,
          tract_frames: tract,
          glottis_frames: glottis,
          per_frame_shimmer: true,
          fps: 18,
          include_geometry: true,
        },
        signal,
      );
      if (!frames.length) {
        frames = mapGeometryFrames(synth.geometry_frames, f0[nucFrameIdx], 800);
      }
      if (!wavBuf && synth.wav_base64) {
        wavBuf = base64ToArrayBuffer(synth.wav_base64);
        stepDurSec = synth.duration_s ?? totalSec;
      }
    }

    if (!frames.length || !wavBuf) {
      throw new Error(`引擎未能返回连续统第 S${s} 格的真实声道几何帧或音频`);
    }
    steps.push({
      index: s,
      u: Number(u.toFixed(2)),
      label: s === 0 ? '汉语「算」' : s === count - 1 ? '英语「swan」' : `融合 ${Math.round(u * 100)}%`,
      f1Hz: Math.round(resHz[0] ?? 0),
      f2Hz: Math.round(resHz[1] ?? 0),
      f3Hz: Math.round(resHz[2] ?? 0),
      aminCm2: Number((snap.oral_min_area ?? 0).toFixed(3)),
      durationSec: Number(stepDurSec.toFixed(2)),
      frames,
    });
    audios[`s${s}`] = wavBuf;
  }

  return {
    payload: {
      kind: 'continuum-suan-swan',
      equalizedDurationSec: Number(totalSec.toFixed(2)),
      endpointALabel: CONTINUUM_REAL_PAIR_SAMPLES.sideA.label,
      endpointBLabel: CONTINUUM_REAL_PAIR_SAMPLES.sideB.label,
      hasEndpointRecordings: Boolean(audios.endpointA && audios.endpointB),
      steps,
    },
    audios,
    engineLabel: usedNeural
      ? 'Vox2Tract-Lite + alignEndpointTimings + timeWarp + Tract2Vox-Lite (神经重合成)'
      : 'alignEndpointTimings + timeWarp + sourceTrajectory + resolveContinuumFramePitch + VTL 2.4',
  };
}

/* ----------------------------------------------------------------------------
 * 6. DialectView: Real `applyDialectSandhi()` + Built-in Packs + qTA `evalF0()`
 * ---------------------------------------------------------------------------- */

function buildSuzhouWuDialectPack(): DialectTonePack {
  const uiPack = DIALECT_PACKS.wuu;
  return coreDialect({
    id: 'wuu',
    name: uiPack.name,
    base: 'wuu',
    tones: uiPack.tones,
    sandhi: uiPack.sandhi,
  });
}

function chaoDigitsToPts(digits: string): number[] {
  const nums = digits
    .split('')
    .map((d) => Number(d))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
  const yForLevel = (lv: number) => 102 - ((lv - 1) / 4) * 80;
  if (nums.length === 0) return [62, 62, 62];
  if (nums.length === 1) {
    const y = yForLevel(nums[0]);
    return [y, y, y];
  }
  if (nums.length === 2) {
    const y0 = yForLevel(nums[0]);
    const y2 = yForLevel(nums[1]);
    return [y0, (y0 + y2) * 0.5, y2];
  }
  return [yForLevel(nums[0]), yForLevel(nums[1]), yForLevel(nums[nums.length - 1])];
}

/** Matches DialectStudioView.vue PCHIP + default 115–300 Hz Chao register before evalF0(). */
function chaoYToHzDefault(y: number): number {
  const norm = Math.max(0, Math.min(1, 1 - (y - 22) / 80));
  return Math.round(115 + norm * 185);
}

function evalToneContourWithDurations(
  tones: readonly string[],
  durScales: readonly number[],
  baseSylDurSec: number,
  fRefHz = 165,
): { timesMs: number[]; f0Hz: number[]; totalSec: number } {
  const durations = tones.map((_, i) => baseSylDurSec * (durScales[i] ?? 1));
  const totalSec = durations.reduce((sum, d) => sum + d, 0);
  const totalSmp = Math.round(totalSec * SAMPLE_RATE_HZ);
  let cursorSmp = 0;
  const spans = tones.flatMap((digits, sIdx) => {
    const durS = durations[sIdx];
    const sStart = cursorSmp;
    const sEnd = sIdx === tones.length - 1 ? totalSmp : Math.min(totalSmp, sStart + Math.round(durS * SAMPLE_RATE_HZ));
    cursorSmp = sEnd;
    return buildSyllableQtaTargets(`s${sIdx}`, sStart, sEnd, {
      effectiveTone: digits,
      fRefHz,
      voiced: true,
    });
  });

  // Also sample DialectStudioView PCHIP curves (115–300 Hz) as F0 pin guide so contours match DialectStudioView
  cursorSmp = 0;
  const pins = tones.map((digits, sIdx) => {
    const durS = durations[sIdx];
    const sStart = cursorSmp;
    const sEnd = sIdx === tones.length - 1 ? totalSmp : Math.min(totalSmp, sStart + Math.round(durS * SAMPLE_RATE_HZ));
    cursorSmp = sEnd;
    const [p0, p1, p2] = chaoDigitsToPts(digits);
    const clampY = (y: number) => Math.max(22, Math.min(102, y));
    const y0 = clampY(p0);
    const y1 = clampY(p1);
    const y2 = clampY(p2);
    const d0 = y1 - y0;
    const d1 = y2 - y1;
    const m1 = d0 * d1 <= 0 ? 0 : (2 * d0 * d1) / (d0 + d1);
    let m0 = 0.5 * (3 * d0 - m1);
    if (m0 * d0 <= 0) m0 = 0;
    else if (Math.abs(m0) > 3 * Math.abs(d0)) m0 = 3 * d0;
    let m2 = 0.5 * (3 * d1 - m1);
    if (m2 * d1 <= 0) m2 = 0;
    else if (Math.abs(m2) > 3 * Math.abs(d1)) m2 = 3 * d1;
    const c1y = clampY(y0 + m0 / 3);
    const c2y = clampY(y1 - m1 / 3);
    const c3y = clampY(y1 + m1 / 3);
    const c4y = clampY(y2 - m2 / 3);
    const points: Array<{ t_smp: number; f0_hz: number }> = [];
    for (let k = 0; k <= 8; k++) {
      const u = k / 8;
      let y: number;
      if (u <= 0.5) {
        const t = u * 2;
        const v = 1 - t;
        y = v * v * v * y0 + 3 * v * v * t * c1y + 3 * v * t * t * c2y + t * t * t * y1;
      } else {
        const t = (u - 0.5) * 2;
        const v = 1 - t;
        y = v * v * v * y1 + 3 * v * v * t * c3y + 3 * v * t * t * c4y + t * t * t * y2;
      }
      points.push({
        t_smp: Math.round(sStart + u * (sEnd - sStart)),
        f0_hz: chaoYToHzDefault(y),
      });
    }
    return {
      id: `dialect_${sIdx}`,
      start_smp: sStart,
      end_smp: sEnd,
      transition_ms: 30,
      exit_fit_ms: 30,
      points,
    };
  });

  const res = evalF0({ spans, pins, total_smp: totalSmp, step_smp: 480, f_ref_hz: fRefHz, context: 'speech' });
  const timesMs = res.ok ? res.value.times_smp.map((s) => Math.round((s / SAMPLE_RATE_HZ) * 1000)) : [];
  const f0Hz = res.ok ? res.value.f0_hz.map((f) => Number(f.toFixed(1))) : [];
  return { timesMs, f0Hz, totalSec };
}

/**
 * Pure deterministic helper executing the real `applyDialectSandhi()` engine
 * across built-in Mandarin, Suzhou Wu, and Cantonese dialect packs.
 */
export function computeDialectSandhiCases(): DialectSandhiCase[] {
  const suzhouPack = buildSuzhouWuDialectPack();
  const specs: Array<{
    id: string;
    title: string;
    phrase: string;
    pack: DialectTonePack;
    syllables: SandhiSyllableInput[];
    compareDurationBaseline?: boolean;
  }> = [
    {
      id: 'cmn-t3-pair',
      title: '普通话 · 上声连读 pair 规则',
      phrase: '你好 [ni + xau]',
      pack: MANDARIN_DIALECT_PACK,
      syllables: [
        { text: '你', tone_id: 'T3', domain_id: 'w1' },
        { text: '好', tone_id: 'T3', domain_id: 'w1', is_prepausal: true },
      ],
    },
    {
      id: 'cmn-lexical',
      title: '普通话 · 一/不 lexical 最高优先规则',
      phrase: '一个不错 [i + kɤ + pu + tsʰwo]',
      pack: MANDARIN_DIALECT_PACK,
      syllables: [
        { text: '一', tone_id: 'T1', domain_id: 'w1' },
        { text: '个', tone_id: 'T4', domain_id: 'w1' },
        { text: '不', tone_id: 'T4', domain_id: 'w2' },
        { text: '错', tone_id: 'T4', domain_id: 'w2', is_prepausal: true },
      ],
    },
    {
      id: 'wuu-word-pattern',
      title: '苏州吴语 · word_pattern 广用式连读',
      phrase: '苏州话 [səu + tsøʏ + ɦo]',
      pack: suzhouPack,
      syllables: [
        { text: '苏', tone_id: 'T1', domain_id: 'w1' },
        { text: '州', tone_id: 'T2', domain_id: 'w1' },
        { text: '话', tone_id: 'T2', domain_id: 'w1', is_prepausal: true },
      ],
    },
    {
      id: 'yue-checked',
      title: '粤语九声 · 入声 dur_scale=0.5 与不除阻',
      phrase: '一杯白水 [jɐt̚ + pui + paːk̚ + sɵy]',
      pack: CANTONESE_DIALECT_PACK,
      syllables: [
        { text: '一', tone_id: 'T7', domain_id: 'w1' },
        { text: '杯', tone_id: 'T1', domain_id: 'w1' },
        { text: '白', tone_id: 'T9', domain_id: 'w2' },
        { text: '水', tone_id: 'T2', domain_id: 'w2', is_prepausal: true },
      ],
      compareDurationBaseline: true,
    },
  ];

  const baseSylDurSec = 0.34;
  return specs.map((sp) => {
    const sandhiRes = applyDialectSandhi(sp.pack, sp.syllables);
    if (!sandhiRes.ok) {
      throw new Error(sandhiRes.error.hint || `方言变调规则执行失败：${sp.title}`);
    }
    const catMap = new Map(sp.pack.categories.map((c) => [c.id, c]));
    const rawTones = sp.syllables.map((s) => {
      const cat = catMap.get(s.tone_id)!;
      const prep = s.is_prepausal ? cat.variants?.find((v) => v.when === 'prepausal') : undefined;
      return prep ? prep.levels : cat.levels;
    });
    const outputs = sandhiRes.value;
    const sandhiTones = outputs.map((o) => o.levels);
    const durScales = outputs.map((o) => o.dur_scale);
    const checkedFlags = outputs.map((o) => o.checked);
    const rewrittenTraces = outputs.map((o) =>
      o.rewritten_by
        ? `${o.text}: ${o.rewritten_by}`
        : o.checked
          ? `${o.text}: checked(dur×${o.dur_scale}, ${o.coda_release ?? 'unreleased'})`
          : `${o.text}: 保留本调 ${o.levels}`,
    );

    const ruleSummary = sp.compareDurationBaseline
      ? `实算结果（${sp.pack.name}）：入声「一」「白」由包定义触发 checked=true / dur_scale=0.5 / coda_release=unreleased，与未缩短等长基线（1.0×）对比真实时程压缩`
      : `applyDialectSandhi(${sp.pack.id}) 实算：${rawTones.join(' + ')} → ${sandhiTones.join(' + ')}（命中：${outputs.filter((o) => o.rewritten_by).map((o) => o.rewritten_by).join('；') || '无改写'}）`;

    const rawEval = evalToneContourWithDurations(
      rawTones,
      sp.compareDurationBaseline ? rawTones.map(() => 1.0) : durScales,
      baseSylDurSec,
      165,
    );
    const sanEval = evalToneContourWithDurations(sandhiTones, durScales, baseSylDurSec, 165);

    // Align lengths cleanly on the longer time grid so both curves compare cleanly in ECharts
    const maxLen = Math.max(rawEval.timesMs.length, sanEval.timesMs.length);
    const timesMs = rawEval.timesMs.length >= sanEval.timesMs.length ? rawEval.timesMs : sanEval.timesMs;
    const padTail = (arr: number[]) =>
      Array.from({ length: maxLen }, (_, i) => (i < arr.length ? arr[i] : Number.NaN));

    return {
      id: sp.id,
      packName: sp.pack.name,
      title: sp.title,
      phrase: sp.phrase,
      ruleSummary,
      rawTones,
      sandhiTones,
      rewrittenTraces,
      durScales,
      checkedFlags,
      timesMs,
      rawF0Hz: padTail(rawEval.f0Hz),
      sandhiF0Hz: padTail(sanEval.f0Hz),
    };
  });
}

async function runDialectSandhiDemo(): Promise<{
  payload: DialectSandhiDemoPayload;
  engineLabel: string;
}> {
  const cases = computeDialectSandhiCases();
  return {
    payload: { kind: 'dialect-sandhi', cases },
    engineLabel: 'applyDialectSandhi() 真实规则引擎 + 3 阶 qTA evalF0()（零引擎依赖）',
  };
}

/* ----------------------------------------------------------------------------
 * 7. ArrangerView: Real Built-in 「长恨歌」 Production Pipeline (B2, 84 BPM, JE)
 *    Runs actual analyzeLyrics -> parseScoreToEvents -> compileArrangement
 *    (leadEnabled true/false, inspired by CHIMERA) -> evalF0 -> VTL 2.4 audio
 * ---------------------------------------------------------------------------- */

async function synthesizeCompiledClipWav(
  clip: import('@vocalcut/core').Clip,
  signal?: AbortSignal,
): Promise<{ wav?: ArrayBuffer; errorHint?: string }> {
  const demoProject = createInitialProject();
  const voiceId = demoProject.voice_order[0];
  const refHz = demoProject.voices[voiceId]?.f0_ref_hz ?? 165;
  const neutralTract = tractRecordToArray19(defaultTractParams());
  const plan = buildAnnotationSynthesis(
    { ...demoProject, f0_pins: clip.annotation_controls?.f0_pins },
    clip,
    [],
    0,
    clip.end_smp,
    {
      f0Hz: refHz,
      tract: neutralTract,
      releaseTract: neutralTract,
      lipWidth: 1,
      larynxHeight: 0,
    },
  );
  if (!plan.ok) return { errorHint: plan.error.hint };
  const res = await defaultVtlTransport.requestSynthesizeRaw(
    {
      ...plan.value,
      sample_count: clip.end_smp,
      synth_mode: 'physical',
      device: 'cpu',
      audio_gain: 'peak',
    },
    { signal: makeSignal(signal, 45_000), timeoutMs: 45_000 },
  );
  if (!res.ok) return { errorHint: res.error.hint || '本地 VTL 2.4 引擎未连接' };
  if (res.value.kind === 'audio') return { wav: res.value.buffer };
  const data = res.value.data as VtlSynthApiResponse;
  if (data.wav_base64) return { wav: base64ToArrayBuffer(data.wav_base64) };
  return { errorHint: data.error?.hint || '本地 VTL 2.4 引擎未返回音频' };
}

async function runArrangerPrebeatDemo(signal?: AbortSignal): Promise<{
  payload: ArrangerPrebeatDemoPayload;
  audios: Record<string, ArrayBuffer>;
  engineLabel: string;
}> {
  const songTitle = `《${everlastingRegretExample.title}》「杨家有女初长成」`;
  const credit = everlastingRegretExample.credit ?? '内置示范曲谱';
  const tonic = everlastingRegretExample.tonic;
  const bpm = everlastingRegretExample.bpm;
  const lyrics = '杨家有女初长成';
  const scoreText = '《6》 《5/ 6/》 《[1]》 《[2]》 | 《[3]/// [2]/// [3]/.》 《[1]/// 6:0.875》 《5 -》';
  const tokens = [
    '《6》',
    '《5/ 6/》',
    '《[1]》',
    '《[2]》',
    '《[3]/// [2]/// [3]/.》',
    '《[1]/// 6:0.875》',
    '《5 -》',
  ];

  await preloadPtbIpaPresets('JD2');
  const standard = readingStandard();
  const rows = await analyzeLyrics(lyrics, standard, 'JD2', false);
  const leadingSmp = msToSamples(105);
  const parsed = parseScoreToEvents(scoreText, rows, tonic, bpm, everlastingRegretExample.notation, leadingSmp);
  if (!parsed.ok) throw new Error(parsed.message);

  const rowIdxById = new Map(rows.map((r, i) => [r.id, i]));
  const noteCountByRow = new Map<number, number>();
  const rollNotes: Array<{ rowIdx: number; hz: number; midi: number; startSmp: number; endSmp: number; dynamic: number; pressurePa: number; isContinuation: boolean }> = [];
  for (const ev of parsed.events) {
    const rowIdx = ev.lyricId ? (rowIdxById.get(ev.lyricId) ?? -1) : -1;
    if (rowIdx < 0) continue;
    const prevCount = noteCountByRow.get(rowIdx) ?? 0;
    noteCountByRow.set(rowIdx, prevCount + 1);
    const dynamic = Math.max(-3, Math.min(3, (ev.velocity - 86) / 14));
    rollNotes.push({
      rowIdx,
      midi: ev.midi,
      hz: midiHz(ev.midi),
      startSmp: ev.startSmp,
      endSmp: ev.endSmp,
      dynamic,
      pressurePa: DEFAULT_BASE_PRESSURE_PA + DYNAMIC_STEP_PA * dynamic,
      isContinuation: prevCount > 0,
    });
  }
  const endSmp = rollNotes.reduce((max, n) => Math.max(max, n.endSmp), leadingSmp);
  const rollInput = {
    ok: true,
    issueMsg: '',
    voice: {
      rows: rows.map((row) => ({ ...row, readingChoices: row.choices })),
      lyricsText: lyrics,
      fullScoreStr: scoreText,
    },
    notes: rollNotes,
    endSmp,
  };

  const baseProject = createInitialProject();
  const speakerId = baseProject.voice_order[0];
  const refHz = baseProject.voices[speakerId]?.f0_ref_hz ?? 165;
  const compileOpts = {
    clipId: 'guide-arranger-demo',
    speakerId,
    speaker: 'JD2',
    bpm,
    tonic,
    notation: everlastingRegretExample.notation,
    language: 'cmn' as const,
    readingStandard: standard,
    referenceHz: refHz,
    leadMs: 75,
    biasMs: 0,
    dampingRate: 32,
    vibrato: true,
    vibratoCents: 25,
  };

  const compiledOn = compileArrangement(rollInput, { ...compileOpts, leadEnabled: true });
  if (!compiledOn.clip) throw new Error(compiledOn.issue || '开启抢拍编译失败');
  const compiledOff = compileArrangement(rollInput, { ...compileOpts, leadEnabled: false });
  if (!compiledOff.clip) throw new Error(compiledOff.issue || '关闭抢拍编译失败');

  const evalVariantF0 = (clip: Clip): Array<{ tMs: number; hz: number }> => {
    const syls = clip.syllable_order.map((id) => clip.syllables[id]);
    const evaluated = evaluateControlPitch(
      {
        ...baseProject,
        f0_pins: clip.annotation_controls?.f0_pins,
        vibrato: {
          enabled: true,
          rate_hz: baseProject.vibrato?.rate_hz ?? 5.5,
          depth_cents: 25,
          delay_ms: baseProject.vibrato?.delay_ms ?? 150,
          fade_in_ms: baseProject.vibrato?.fade_in_ms ?? 180,
          fade_out_ms: baseProject.vibrato?.fade_out_ms ?? 120,
          min_hold_ms: baseProject.vibrato?.min_hold_ms ?? 180,
        },
      },
      syls,
      clip.end_smp,
      refHz,
      true,
      true,
    );
    const curve: Array<{ tMs: number; hz: number }> = [];
    if (evaluated.ok) {
      for (let i = 0; i < evaluated.value.times_smp.length; i += 3) {
        curve.push({
          tMs: Number(samplesToMs(evaluated.value.times_smp[i]).toFixed(1)),
          hz: evaluated.value.voiced_mask[i] ? Number(evaluated.value.f0_hz[i].toFixed(1)) : 0,
        });
      }
    }
    return curve;
  };

  const mapVariant = (clip: Clip, leadEnabled: boolean, hasAudio: boolean): ArrangerDemoModeVariant => {
    const f0Curve = evalVariantF0(clip);
    const syllables: ArrangerDemoSyllableItem[] = clip.syllable_order.map((id, idx) => {
      const syl = clip.syllables[id];
      const firstNote = rollNotes.find((n) => n.rowIdx === idx);
      const beatSmp = firstNote?.startSmp ?? syl.start_smp;
      const nucSeg = syl.segments[syl.nucleus_index] ?? syl.segments[0];
      const prebeatMs = Math.max(0, Math.round(samplesToMs(beatSmp - syl.start_smp)));
      return {
        char: syl.text,
        ipa: syl.ipa.join(''),
        token: tokens[idx] ?? '',
        policy: syl.anchor.policy === 'nucleus_on_beat' ? 'nucleus_on_beat' : 'speech_timing',
        leadMs: prebeatMs,
        beatStartMs: Math.round(samplesToMs(beatSmp)),
        startMs: Math.round(samplesToMs(syl.start_smp)),
        nucleusStartMs: Math.round(samplesToMs(nucSeg?.start_smp ?? syl.start_smp)),
        endMs: Math.round(samplesToMs(syl.end_smp)),
        segments: syl.segments.map((seg) => ({
          ipa: seg.ipa,
          role: seg.role,
          voiced: seg.voiced,
          startMs: Math.round(samplesToMs(seg.start_smp)),
          endMs: Math.round(samplesToMs(seg.end_smp)),
        })),
      };
    });
    return {
      leadEnabled,
      syllables,
      f0Curve,
      totalSec: Number((clip.end_smp / SAMPLE_RATE_HZ).toFixed(2)),
      hasAudio,
    };
  };

  const audios: Record<string, ArrayBuffer> = {};
  let audioStatusNote: string | undefined;
  let hasOnAudio = false;
  let hasOffAudio = false;
  try {
    const synthOn = await synthesizeCompiledClipWav(compiledOn.clip, signal);
    if (synthOn.wav) {
      audios.leadOn = synthOn.wav;
      hasOnAudio = true;
    } else if (synthOn.errorHint) {
      audioStatusNote = `本地 VTL 2.4 引擎未返回音频（${synthOn.errorHint}）。当前图表仍为编曲真实编译管线输出，启动引擎后点「重新计算」即可生成 A/B 试唱对比音频。`;
    }
    if (hasOnAudio) {
      const synthOff = await synthesizeCompiledClipWav(compiledOff.clip, signal);
      if (synthOff.wav) {
        audios.leadOff = synthOff.wav;
        hasOffAudio = true;
      }
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    const hint = err instanceof Error ? err.message : '本地引擎不可用';
    audioStatusNote = `本地 VTL 2.4 引擎未连接（${hint}）。当前展示为编曲真实编译管线输出的音素边界与 qTA 基频，启动引擎后点「重新计算」即可生成 A/B 试唱音频。`;
  }

  const minMidi = Math.min(...rollNotes.map((n) => n.midi)) - 1;
  const maxMidi = Math.max(...rollNotes.map((n) => n.midi)) + 1;
  const beatDurMs = 60_000 / bpm;
  const beatTimesMs: number[] = [];
  for (let b = 0; b <= 8; b++) {
    beatTimesMs.push(Math.round(samplesToMs(leadingSmp) + b * beatDurMs));
  }

  const notes: ArrangerDemoNoteBlock[] = rollNotes.map((n) => ({
    rowIdx: n.rowIdx,
    char: rows[n.rowIdx]?.char ?? '',
    midi: n.midi,
    hz: Number(n.hz.toFixed(1)),
    startMs: Math.round(samplesToMs(n.startSmp)),
    endMs: Math.round(samplesToMs(n.endSmp)),
    isContinuation: n.isContinuation,
  }));

  return {
    payload: {
      kind: 'arranger-prebeat',
      songTitle,
      credit,
      tonic,
      bpm,
      scoreText,
      lyrics,
      minMidi,
      maxMidi,
      beatTimesMs,
      notes,
      leadOn: mapVariant(compiledOn.clip, true, hasOnAudio),
      leadOff: mapVariant(compiledOff.clip, false, hasOffAudio),
      audioStatusNote,
    },
    audios,
    engineLabel: hasOnAudio && hasOffAudio
      ? '真实编曲编译管线 + VTL 2.4 A/B 双版试唱（CHIMERA 辅音抢拍对照）'
      : '真实编曲编译管线（analyzeLyrics + compileArrangement + qTA F0）',
  };
}

/* ----------------------------------------------------------------------------
 * 7b. StudioStageView: Real Built-in 《长恨歌.mid》 Salamander Grand Piano Render
 *     + Real Beat-Grid Fit + Real VTL Sagittal Tract Contours (Zero Fake Data)
 * ---------------------------------------------------------------------------- */

async function runStageCinemaDemo(signal?: AbortSignal): Promise<{
  payload: StageCinemaDemoPayload;
  audios: Record<string, ArrayBuffer>;
  engineLabel: string;
}> {
  const base = (import.meta.env?.BASE_URL ?? '/').replace(/\/?$/, '/');
  const [midiRes, tractJson] = await Promise.all([
    fetch(`${base}${encodeURI('examples/长恨歌.mid')}`, { signal: makeSignal(signal, 15_000) }),
    fetchPrewarmJson('prewarm/suan_mandarin.json', signal),
  ]);
  if (!midiRes.ok) {
    throw new Error(`未能加载内置真实曲谱 examples/长恨歌.mid（HTTP ${midiRes.status}）`);
  }

  const midiBytes = new Uint8Array(await midiRes.arrayBuffer());
  const parsedMidi = readMidiParts(midiBytes);
  const scoreBpm = Math.round(parsedMidi.bpm);
  const beatSec = 60 / Math.max(40, parsedMidi.bpm);
  const clipDurationSec = Number((beatSec * 8).toFixed(2)); // Exact 2 bars (8 beats @ 84 BPM ≈ 5.71 s)
  const durationSmp = Math.round(clipDurationSec * SAMPLE_RATE_HZ);

  // Extract real opening melody + bass-octave piano cues from 《长恨歌.mid》
  const cues: InstrumentCue[] = [];
  for (const part of parsedMidi.parts) {
    for (const note of part.notes) {
      const startSec = note.startSmp / SAMPLE_RATE_HZ;
      if (startSec >= clipDurationSec - 0.04) continue;
      const endSec = Math.min(clipDurationSec, note.endSmp / SAMPLE_RATE_HZ);
      const dur = Math.max(0.08, endSec - startSec);
      const vel = Math.max(0.28, Math.min(0.95, note.velocity / 127));
      cues.push({
        at: startSec,
        duration: dur,
        hz: midiHz(note.midi),
        volume: part.instrument === 'xiao' ? 0.42 : 0.62,
        velocity: vel,
        instrument: part.instrument,
        lane: part.name,
      });
    }
  }

  // Add real octave-down grand piano bass accompaniment directly anchored to the score's bar/beat roots
  const leadNotes = parsedMidi.parts[0]?.notes ?? [];
  for (let b = 0; b < 8; b++) {
    const tBeat = b * beatSec;
    const hitSmp = Math.round(tBeat * SAMPLE_RATE_HZ);
    const activeNote = leadNotes.find((n) => n.startSmp <= hitSmp + 4800 && n.endSmp > hitSmp)
      ?? leadNotes.find((n) => n.startSmp >= hitSmp)
      ?? leadNotes[0];
    if (!activeNote) continue;
    const bassMidi = Math.max(36, activeNote.midi - 12);
    cues.push({
      at: tBeat,
      duration: Math.min(beatSec * 0.88, clipDurationSec - tBeat),
      hz: midiHz(bassMidi),
      volume: b % 4 === 0 ? 0.78 : 0.56,
      velocity: b % 4 === 0 ? 0.86 : 0.66,
      instrument: 'piano',
      lane: 'piano_bass',
    });
  }

  const renderAbort = new AbortController();
  const onParentAbort = () => renderAbort.abort();
  signal?.addEventListener('abort', onParentAbort, { once: true });
  let renderedBuf: AudioBuffer;
  try {
    renderedBuf = await renderInstrumentTimeline('piano', cues, durationSmp, SAMPLE_RATE_HZ, renderAbort.signal);
  } finally {
    signal?.removeEventListener('abort', onParentAbort);
  }

  // Mix rendered stereo piano+xiao master down to mono PCM for real beat-grid detection
  const left = renderedBuf.getChannelData(0);
  const right = renderedBuf.numberOfChannels > 1 ? renderedBuf.getChannelData(1) : left;
  const monoPcm = new Float32Array(renderedBuf.length);
  for (let i = 0; i < monoPcm.length; i++) {
    monoPcm[i] = 0.5 * ((left[i] ?? 0) + (right[i] ?? 0));
  }

  const grid = detectBeatGridFromPcm(monoPcm, SAMPLE_RATE_HZ, {
    sourceLabel: `《长恨歌.mid》实录级钢琴与洞箫渲染 (${scoreBpm} BPM)`,
  });

  // Compute 25 ms RMS envelope on the real rendered audio for visualization
  const hopSmp = Math.round(SAMPLE_RATE_HZ * 0.025);
  const nBins = Math.floor(monoPcm.length / hopSmp);
  const envelopeTimesSec: number[] = [];
  const rawEnv: number[] = [];
  let maxEnv = 1e-6;
  for (let b = 0; b < nBins; b++) {
    let sumSq = 0;
    const off = b * hopSmp;
    for (let i = 0; i < hopSmp; i += 4) {
      const s = monoPcm[off + i] ?? 0;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / (hopSmp / 4));
    if (rms > maxEnv) maxEnv = rms;
    envelopeTimesSec.push(Number(((b * hopSmp) / SAMPLE_RATE_HZ).toFixed(2)));
    rawEnv.push(rms);
  }
  const envelopeValues = rawEnv.map((v) => Number((v / maxEnv).toFixed(3)));

  // Extract real VTL 65-section sagittal contours (all 9 anatomical parts) from bundled prewarm geometry
  const tractFrames: TractAnimFrame[] = [];
  for (const fr of tractJson.geometry_frames) {
    if (!fr.contours || !Object.keys(fr.contours).length) continue;
    tractFrames.push({
      t: Number(fr.t_s.toFixed(3)),
      contours: fr.contours,
      f0: Math.round(fr.f0_hz ?? 150),
      prPa: Math.round(fr.pressure_pa ?? 780),
    });
  }
  if (!tractFrames.length) {
    throw new Error('预载声道轨迹缺少真实矢状面解剖轮廓');
  }

  const bgmWav = await encodeWavFromAudioBuffer(renderedBuf).arrayBuffer();

  return {
    payload: {
      kind: 'stage-cinema',
      sourceTitle: `《长恨歌.mid》2 小节伴奏 + 「算」预载 VTL 声道序列（${scoreBpm} BPM）`,
      scoreBpm,
      bpm: grid.bpm,
      t0Sec: Number(grid.t0Sec.toFixed(3)),
      confidence: grid.confidence,
      beatTimesSec: grid.beatsSmp.map((s) => Number((s / SAMPLE_RATE_HZ).toFixed(3))),
      strongHitSec: grid.strongHitsSmp.map((s) => Number((s / SAMPLE_RATE_HZ).toFixed(3))),
      envelopeTimesSec,
      envelopeValues,
      durationSec: clipDurationSec,
      hasAudio: true,
      tractFrames,
      lyricText: '算 · 预载声道示教',
      ipaText: '[swan⁵¹]',
    },
    audios: { bgm: bgmWav },
    engineLabel: '《长恨歌.mid》钢琴/洞箫渲染 + 「算」[swan⁵¹] 实算声道轮廓 + 最小二乘节拍拟合（零后端依赖）',
  };
}

/* ----------------------------------------------------------------------------
 * 8. ExploreLabView: Real Dual Reference Comparison (/i/ main-T221 vs /y/ main-T222)
 * ---------------------------------------------------------------------------- */

async function runExploreCompareDemo(signal?: AbortSignal): Promise<{
  payload: ExploreCompareDemoPayload;
  audios: Record<string, ArrayBuffer>;
  engineLabel: string;
}> {
  const [references, recordedFormants] = await Promise.all([
    fetchIpaReferences(),
    loadRecordedVowelFormants().catch(() => []),
  ]);
  const [a, b] = await Promise.all([
    solveRealIpaReferenceVowel('i', '/i/ 前高不圆唇', references, recordedFormants, signal),
    solveRealIpaReferenceVowel('y', '/y/ 前高圆唇', references, recordedFormants, signal),
  ]);
  const audios: Record<string, ArrayBuffer> = {};
  if (a.recordedAudio) audios.left_rec = a.recordedAudio;
  if (a.reconAudio) audios.left_recon = a.reconAudio;
  if (b.recordedAudio) audios.right_rec = b.recordedAudio;
  if (b.reconAudio) audios.right_recon = b.reconAudio;

  return {
    payload: { kind: 'explore-compare', left: a.item, right: b.item },
    audios,
    engineLabel: '参考录音库真人实录（main-T221 /i/ vs main-T222 /y/）+ VTL 65 截面求解',
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
    case 'stage-cinema': {
      const r = await runStageCinemaDemo(signal);
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
