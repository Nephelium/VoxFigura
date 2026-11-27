import { metricsFromVtlSnapshot } from '@/data/vtl-acoustic';
import { resolveVtlPose, vtlPoseKey, type PoseRequest, type TongueRootGesture } from '@/data/vtl-pose-client';
import { stageLayer } from '@/components/studio/nle-timeline';
import {
  buildAnnotationSynthesis,
  type AnnotationControlReference,
  type AnnotationIpaPoseSource,
} from '@/components/research/annotation-audio';
import type { AnnotationTractFrame } from '@/components/research/annotation-edit';
import { applyPeakAudioGain, defaultVoiceRenderMode, synthesisGainMode, voiceRenderLabels, voiceRenderMode, type VoiceRenderMode } from '@/data/voice-renderer';
import { effectiveSpeakerBaseF0Hz, speakerReferenceAudio, speakerReferenceName } from '@/data/synthesis-speaker';
import { createVoicePlaybackBus, measureVoicePlaybackGain, voicePlaybackGain } from '@/data/voice-playback-gain';
import { syncLocalModelsSilently } from '@/data/local-models';
import {
  resetAllSplittersToFactory,
  resetSplitterGroupToFactory,
  resetSplitterToFactory,
  setConfiguredSplitterDefault,
  type SetSplitterDefaultResult,
} from '@/data/splitter-layout';
import { defaultVtlTransport, type SynthesisGainMode } from '@vocalcut/model-adapters';
import { normalizeInterfaceFonts, type InterfaceFonts } from '@/styles/interface-fonts';
import { normalizeAnatomyAppearance, type AnatomyAppearance } from '@/styles/anatomy-appearance';
import { isWhisperModelId, type WhisperModelId } from '@/data/whisper-models';
import { initialWorkspace, exploreLabel } from '@vocalcut/edition';
import { activeWorkspaceBackground, selectWorkspaceBackground } from '@/data/workspace-images';
import { computed, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue';
import {
  PRESSURE_LIMIT_PA,
  SAMPLE_RATE_HZ,
  assertInRange,
  assertValidF0Hz,
  msToSamples,
  type ComputeDevice,
  type Clip,
  type CoreErrorDetail,
  type GlottisM27Params,
  type PhonationAnchor,
  type PhonationRegime,
  type Syllable,
  type TractDelta,
  type TractParamName,
  type VcProject,
} from '../../packages/core-ts/src/types';
import {
  PHONATION_REGIMES,
  activePhonationAnchorAt,
  getPhonationAnchorParams,
  validateVoqsAnchor,
  heldPhonationAt,
  validateGlottisM27,
} from '../../packages/core-ts/src/phonation';
import { retime, type RetimeResult } from '../../packages/core-ts/src/retime';
import {
  applyAppearanceToRoot,
  applyPageScaleToRoot,
  BACKDROP_BLUR_MAX_PX,
  BACKDROP_VEIL_MAX_PCT,
  backdropTreatmentDefaults,
  backdropVeilDefault,
  computeAutoPageScale,
  defaultAppearance,
  getSkin,
  listBackdrops,
  listSkins,
  mountStyleBackdoor,
  normalizeBackdropId,
  normalizeMode,
  normalizePalette,
  normalizeSkinId,
  palettes,
  parseStyleUrlParams,
  registerSkin,
  runThemeViewTransition,
  type AppearanceConfig,
  type BackdropId,
  type BackdropTreatment,
  type StyleColorMode,
  type StyleOverrides,
} from '@/styles/skin-registry';
import {
  BACKDROP_COLOR_PRESETS,
  colorModeByLocalTime,
  normalizeHex,
  originalSurfacePaletteId,
  paletteShortName,
  paletteTokens,
  resolveColorMode,
  themeBackdropColors,
  type ColorMode,
  type ThemeMode,
  type WaveformColorMode,
} from '@/styles/themes';
import {
  deleteLookPreset,
  normalizeSavedLooksState,
  saveLookPreset,
  setDefaultLookPreset,
  updateLookPreset,
  type SavedLookPreset,
  type SavedLookSnapshot,
  type SavedLooksState,
} from '@/data/saved-looks';
import {
  DEFAULT_TRACT_EXTRAS,
  cloneTractExtras,
  resolvePtbIpaPose,
  type ResolvedPtbIpaPose,
  type TractPoseExtras,
} from '@/data/ptb-ipa-presets';

export type WorkspaceId = 'home' | 'explore' | 'research' | 'studio';

interface ArrangerExportSource {
  exportMidi?: () => Blob;
  exportVsqx?: () => Blob;
  exportSvp?: () => Blob;
  renderVoice?: (format: 'wav' | 'mp3', signal: AbortSignal) => Promise<Blob>;
  originalGrid?: import('@vocalcut/core').TextGridDocument;
  renderAudio?: (format: 'wav' | 'mp3', separate: boolean, signal: AbortSignal) => Promise<Blob>;
  clip?: Clip;
  audio?: AudioBuffer;
}
export type ResearchTabId = 'main' | 'ipa' | 'm27' | 'mixer' | 'continuum' | 'dialect';
export type StudioTabId = 'stage' | 'arranger';
export type OverlayViewId = 'none' | 'settings' | 'guide' | 'about' | 'model-report';
export type GuideModuleId =
  | 'main'
  | 'ipa'
  | 'm27'
  | 'mixer'
  | 'continuum'
  | 'dialect'
  | 'arranger'
  | 'stage'
  | 'card'
  | 'explore';
export type SettingsTabId = 'appearance' | 'style-lab' | 'layout' | 'engine' | 'shortcuts' | 'credits';
export type LayoutDensity = 'compact' | 'standard' | 'spacious';
export type TimelineTrackScale = 'compact' | 'standard' | 'tall';
export type AiDrawerDockMode = 'docked' | 'overlay';
export type NavPlacement = 'left' | 'top';
export type ToastKind = 'info' | 'success' | 'warning' | 'danger';
export type ShortcutPresetId = 'default' | 'pr' | 'capcut';
export type EngineStatus = 'checking' | 'python-vtl' | 'wasm-vtl' | 'prewarm-fallback';

export interface ToastItem {
  id: string;
  message: string;
  kind: ToastKind;
  createdAt: number;
}

export interface TractMetrics {
  amin_cm2: number;
  amin_x_cm: number;
  f1_hz: number;
  f2_hz: number;
  f3_hz: number;
  area_fn: Array<{ x_cm: number; area_cm2: number }>;
  transfer_fn: Array<{ f_hz: number; db: number }>;
  source: 'vtl-engine' | 'analytical-preview';
  peaks_hz?: number[];
  antiformants?: Array<{ f_hz: number; db: number }>;
  nasal_coupled?: boolean;
  nasal_port_cm2?: number;
}

export interface WorkbenchCommand {
  type:
    | 'artic.set_pose'
    | 'f0.set_targets'
    | 'f0.draw'
    | 'voice.set_glottis'
    | 'voice.set_pressure'
    | 'phonation.set_anchors'
    | 'textgrid.set_boundary'
    | 'lyrics.set_reading'
    | 'score.apply'
    | 'clip.edit'
    | 'sing.set_lead'
    | 'visual.set_keys'
    | 'subtitle.style'
    | 'project.set_bpm'
    | 'project.set_speaker'
    | 'project.replace'
    | 'batch';
  payload: Record<string, unknown>;
  label?: string;
}

export interface CommandExecResult {
  ok: boolean;
  revision: number;
  label?: string;
  error?: CoreErrorDetail;
}

export interface StreamPlaybackChain {
  totalSamples: number;
  windowOffsetSmp: number;
  windowOverlapSmp?: number;
  finalWindow: boolean;
  activeSeq: number;
  streamStartTime: number;
  started: boolean;
  prevGainNode: GainNode | null;
  lastScheduledNode: AudioBufferSourceNode | null;
  finished: boolean;
}

export interface SynthesizeRangeOptions {
  signal?: AbortSignal;
  startSmp?: number;
  endSmp?: number;
  speaker?: string;
  tractParams?: Partial<Record<TractParamName, number>>;
  tractExtras?: TractPoseExtras;
  glottis?: Partial<GlottisM27Params>;
  durationMs?: number;
  f0Hz?: number;
  pitchAt?: (progress: number) => number;
  slowRate?: number;
  prewarmAudioUrl?: string;
  annotation?: boolean;
  clipId?: string;
  phrase?: Clip;
  cacheWaveform?: boolean;
  mode?: VoiceRenderMode;
  audioGain?: SynthesisGainMode;
  computeDevice?: ComputeDevice;
  returnControlTrack?: boolean;
  referenceTrack?: AnnotationControlReference;
  ipaPoseSource?: AnnotationIpaPoseSource;
  speakerWavBase64?: string | null;
  /** When set on long (>4 s) neural or physical synthesis, streams first chunk into Web Audio immediately while remaining chunks finish in parallel. */
  streamPlay?: PlayAudioOptions;
  /** Optional callback notified as soon as streaming synthesis metadata delivers the 50 Hz tract trajectory. */
  onStreamTractFrames?: (frames: AnnotationTractFrame[]) => void;
  /** Optional shared timeline state for multi-window gapless streaming (e.g. >60 s songs). */
  streamChain?: StreamPlaybackChain;
}

interface RecordedArticulationSpan {
  ipa: string;
  reference_id: string;
  position: 'onset' | 'intervocalic';
  reference_position: 'onset' | 'intervocalic' | 'other';
  start_smp: number;
  end_smp: number;
  source_start_s: number;
  source_end_s: number;
}

export interface SynthesisInfo {
  recordedArticulation?: RecordedArticulationSpan[];
  protectedIpaPoses?: string[];
  mode: VoiceRenderMode;
  sourceBadge: string;
  device?: 'cpu' | 'cuda';
  voiceProfile?: string;
  modelMs?: number;
  articulationModel?: string;
  articulationFrames50Hz?: number;
  articulationSource?: 'reference' | 'annotation';
  /** Geometry extras the 27-dim M27 control cannot carry; Tract2Vox-Lite ignored them on the IPA2Tract path. */
  ignoredGeometryFields?: string[];
  m27RowsPa?: number[][];
  tractFrames?: AnnotationTractFrame[];
  chunkStats?: {
    total_chunks: number;
    cache_hits: number;
    parallel_workers: number;
    wall_ms?: number;
  };
}

function synthesisTractFrames(
  tract: number[][] | undefined, rows: number[][] | undefined, durationSmp: number,
): AnnotationTractFrame[] | undefined {
  const poses = tract ?? rows?.map(row => [...row.slice(0, 14), 0, 0, ...row.slice(14, 17)]);
  return poses?.map((params, i) => ({
    params, u: Math.min(durationSmp - 1, (i + .5) * (SAMPLE_RATE_HZ / 50)) / durationSmp,
  }));
}

export interface PlayAudioOptions {
  playbackRate?: number;
  gain?: number;
  voiceAutoGain?: boolean;
  shouldStreamPlay?: () => boolean;
  offsetSeconds?: number;
  durationSeconds?: number;
  playheadStartSmp?: number;
  onEnded?: () => void;
}

export const VTL_PARAM_META: ReadonlyArray<{
  key: TractParamName;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultVal: number;
  core6?: boolean;
}> = [
  { key: 'LP', label: '唇突 LP', min: -1, max: 1, step: 0.02, defaultVal: -0.013, core6: true },
  { key: 'LD', label: '唇开 LD', min: -2, max: 4, step: 0.02, defaultVal: 0.875, core6: true },
  { key: 'JA', label: '下颌 JA', min: -7, max: 0, step: 0.05, defaultVal: -4.507, core6: true },
  { key: 'TCX', label: '舌背 TCX', min: -3, max: 4, step: 0.05, defaultVal: 0.098, core6: true },
  { key: 'TCY', label: '舌背 TCY', min: -3, max: 1, step: 0.05, defaultVal: -1.73, core6: true },
  { key: 'VO', label: '鼻化 VO', min: -0.1, max: 1.5, step: 0.02, defaultVal: -0.1, core6: true },
  { key: 'HX', label: '舌骨 HX', min: 0, max: 1, step: 0.02, defaultVal: 0.51 },
  { key: 'HY', label: '喉高 HY', min: -6, max: -3.5, step: 0.05, defaultVal: -4.699 },
  { key: 'JX', label: '下颌前移 JX', min: -0.5, max: 0, step: 0.02, defaultVal: -0.119 },
  { key: 'VS', label: '软腭形状 VS', min: 0, max: 1, step: 0.02, defaultVal: 0.35 },
  { key: 'TTX', label: '舌尖 TTX', min: 1.5, max: 7.5, step: 0.05, defaultVal: 4.753 },
  { key: 'TTY', label: '舌尖 TTY', min: -3, max: 2.5, step: 0.05, defaultVal: -0.972 },
  { key: 'TBX', label: '舌叶 TBX', min: -3, max: 6.5, step: 0.05, defaultVal: 2.621 },
  { key: 'TBY', label: '舌叶 TBY', min: -3, max: 5, step: 0.05, defaultVal: -0.974 },
  { key: 'TRX', label: '舌根 TRX', min: -4, max: 2, step: 0.05, defaultVal: -2.24 },
  { key: 'TRY', label: '舌根 TRY', min: -6, max: 0, step: 0.05, defaultVal: -2.95 },
  { key: 'TS1', label: '舌侧 TS1', min: 0, max: 1, step: 0.02, defaultVal: 0.3 },
  { key: 'TS2', label: '舌侧 TS2', min: 0, max: 1, step: 0.02, defaultVal: 0.198 },
  { key: 'TS3', label: '舌侧 TS3', min: -1, max: 1, step: 0.05, defaultVal: 0.28 },
];

export const VTL_PARAM_ORDER: readonly TractParamName[] = [
  'HX', 'HY', 'JX', 'JA', 'LP', 'LD', 'VS', 'VO',
  'TCX', 'TCY', 'TTX', 'TTY', 'TBX', 'TBY', 'TRX', 'TRY',
  'TS1', 'TS2', 'TS3',
] as const;

export function defaultTractParams(): Record<TractParamName, number> {
  const out = {} as Record<TractParamName, number>;
  for (const item of VTL_PARAM_META) out[item.key] = item.defaultVal;
  return out;
}

export function tractRecordToArray19(rec: Record<TractParamName, number>): number[] {
  return VTL_PARAM_ORDER.map((k) => rec[k] ?? 0);
}

export function tractArray19ToRecord(arr: number[]): Record<TractParamName, number> {
  const base = defaultTractParams();
  VTL_PARAM_ORDER.forEach((k, idx) => {
    if (typeof arr[idx] === 'number' && Number.isFinite(arr[idx])) {
      base[k] = arr[idx];
    }
  });
  return base;
}

/**
 * Analytical acoustic preview fallback (explicitly marked `source: 'analytical-preview'`),
 * replaced automatically by real VTL 2.4 engine response when `/api/vtl/pose` returns.
 */
export function computeAnalyticalMetrics(params: Record<TractParamName, number>): TractMetrics {
  const jawOpen = Math.max(0, Math.min(1, (-params.JA) / 7));
  const frontness = Math.max(0, Math.min(1, (params.TCX + 3) / 7));
  const height = Math.max(0, Math.min(1, (params.TCY + 3) / 4));
  const rounding = Math.max(0, Math.min(1, (params.LP + 1) / 2));
  const tipClose = Math.max(0, Math.min(1, (params.TTY + 1.5) / 3.8));

  const f1 = Math.round(260 + (1 - height) * 440 + jawOpen * 160 - rounding * 45);
  const f2 = Math.round(780 + frontness * 1420 - rounding * 380);
  const f3 = Math.round(2300 + frontness * 460 - rounding * 220);

  const area_fn: Array<{ x_cm: number; area_cm2: number }> = [];
  let amin = 99;
  let aminX = 11.5;
  const constrictionX = 10.5 + frontness * 3.8;
  const constrictionArea = Math.max(0.08, 1.85 - height * 1.25 - tipClose * 0.42 + jawOpen * 0.45);
  const lipArea = Math.max(0.18, 0.4 + Math.max(0, params.LD) * 0.85 - rounding * 0.35);

  for (let i = 0; i <= 34; i++) {
    const x = (i / 34) * 17.0;
    const phar = 1.6 + 0.55 * Math.sin((x / 17) * Math.PI);
    const dip = Math.exp(-Math.pow((x - constrictionX) / 2.2, 2)) * (phar - constrictionArea);
    const lipBlend = x > 14.2 ? ((x - 14.2) / 2.8) : 0;
    const area = Math.max(0.06, (phar - dip) * (1 - lipBlend) + lipArea * lipBlend);
    area_fn.push({ x_cm: Number(x.toFixed(2)), area_cm2: Number(area.toFixed(2)) });
    if (x >= 3 && area < amin) {
      amin = area;
      aminX = x;
    }
  }

  const transfer_fn: Array<{ f_hz: number; db: number }> = [];
  const bw1 = 75;
  const bw2 = 110;
  const bw3 = 155;
  for (let f = 50; f <= 5000; f += 50) {
    const p1 = 22 / (1 + Math.pow((f - f1) / bw1, 2));
    const p2 = 17 / (1 + Math.pow((f - f2) / bw2, 2));
    const p3 = 12 / (1 + Math.pow((f - f3) / bw3, 2));
    const tilt = -0.0022 * f;
    const nasalDip = params.VO > 0.25 ? -7 * params.VO / (1 + Math.pow((f - 1450) / 180, 2)) : 0;
    transfer_fn.push({ f_hz: f, db: Number((-18 + p1 + p2 + p3 + tilt + nasalDip).toFixed(2)) });
  }

  return {
    amin_cm2: Number(amin.toFixed(2)),
    amin_x_cm: Number(aminX.toFixed(1)),
    f1_hz: Math.max(180, Math.min(1000, f1)),
    f2_hz: Math.max(550, Math.min(2900, f2)),
    f3_hz: Math.max(1700, Math.min(3600, f3)),
    area_fn,
    transfer_fn,
    source: 'analytical-preview',
  };
}

export function createInitialProject(): VcProject {
  return {
    schema: 'vocalcut/project',
    schema_version: 1,
    revision: 1,
    id: 'proj_untitled',
    name: '未命名工程',
    settings: {
      sample_rate_hz: SAMPLE_RATE_HZ,
      fps: 60,
      size_px: [1920, 1080],
      tempo_map: [{ tick: 0, bpm: 92 }],
      ppq: 480,
      time_signature: [4, 4],
      default_lead_policy: 'nucleus_on_beat',
      compute_device: 'wasm-cpu',
    },
    voice_order: ['voice_lead'],
    voices: {
      voice_lead: {
        id: 'voice_lead',
        speaker: 'JD2',
        dimension: '3d',
        geometry: 'm10/r21',
        sections: 65,
        preset_pack: { id: 'factory-jd2-r21', sha256: 'factory' },
        f0_ref_hz: 165,
        range_st: [-14, 16],
        seed: 20261122,
      },
    },
    asset_order: [],
    assets: {},
    track_order: ['trk_tg', 'trk_art', 'trk_phon', 'trk_f0', 'trk_ps', 'trk_audio', 'trk_v0', 'trk_v1', 'trk_v2', 'trk_v3'],
    tracks: {
      trk_tg: { id: 'trk_tg', kind: 'textgrid', voice_id: 'voice_lead', tiers: ['syllable', 'phone'], clip_order: ['clip_phrase_1'], height_px: 48 },
      trk_art: { id: 'trk_art', kind: 'articulation', voice_id: 'voice_lead', height_px: 28 },
      trk_phon: { id: 'trk_phon', kind: 'phonation', voice_id: 'voice_lead', height_px: 46, expanded: false },
      trk_f0: { id: 'trk_f0', kind: 'f0', voice_id: 'voice_lead', height_px: 56, expanded: false },
      trk_ps: { id: 'trk_ps', kind: 'pressure', voice_id: 'voice_lead', height_px: 34 },
      trk_audio: { id: 'trk_audio', kind: 'audio', voice_id: 'voice_lead', gain_db: 0, height_px: 38 },
      trk_v0: { id: 'trk_v0', kind: 'visual', layer_order: ['layer_v0_bg'], height_px: 28 },
      trk_v1: { id: 'trk_v1', kind: 'visual', layer_order: ['layer_v1_tract'], height_px: 28 },
      trk_v2: { id: 'trk_v2', kind: 'visual', layer_order: ['layer_v2_sprite'], height_px: 28 },
      trk_v3: { id: 'trk_v3', kind: 'subtitle', layer_order: ['layer_v3_sub'], height_px: 28 },
    },
    clip_order: ['clip_phrase_1', 'clip_arranger_1'],
    clips: {
      clip_phrase_1: {
        id: 'clip_phrase_1',
        kind: 'phrase',
        voice_id: 'voice_lead',
        start_smp: 0,
        end_smp: 0,
        variants: ['synth'],
        active_variant: 'synth',
        syllable_order: [],
        syllables: {},
      },
      clip_arranger_1: {
        id: 'clip_arranger_1',
        kind: 'phrase',
        voice_id: 'voice_lead',
        start_smp: 0,
        end_smp: 0,
        variants: ['synth'],
        active_variant: 'synth',
        syllable_order: [],
        syllables: {},
      },
    },
    layer_order: ['layer_v0_bg', 'layer_v1_tract', 'layer_v2_sprite', 'layer_v3_sub'],
    layers: {
      layer_v0_bg: { id: 'layer_v0_bg', kind: 'background', z_index: 0, visible: true },
      layer_v1_tract: {
        id: 'layer_v1_tract',
        kind: 'tract',
        z_index: 10,
        visible: true,
        keys: { transform: [{ t_smp: 0, x: 50, y: 46, scale: 1, opacity: 1 }] },
      },
      layer_v2_sprite: {
        id: 'layer_v2_sprite',
        kind: 'sprite',
        z_index: 20,
        visible: true,
        keys: { transform: [{ t_smp: 0, x: 84, y: 74, scale: 0.9, opacity: 1 }] },
      },
      layer_v3_sub: {
        id: 'layer_v3_sub',
        kind: 'subtitle',
        z_index: 30,
        visible: true,
        style: {
          font_family: 'PTBIPAPlus',
          font_size_px: 34,
          tilt_deg: 0,
          reveal_mode: 'char_by_char',
          text_color: '#eef2ff',
          highlight_color: '#79aaff',
          show_ipa: true,
          show_translation: false,
          safe_margin_px: [96, 54],
        },
      },
    },
    phonation_anchor_order: [],
    phonation_anchors: {},
    f0_pins: [],
    render: {
      container: 'webm',
      video: 'vp9',
      audio: 'opus',
      safe_margin_px: [96, 54],
      max_width_px: 1920,
      max_height_px: 1080,
    },
  };
}

interface HistorySnapshot {
  label: string;
  projectJson: string;
  assetIds: string[];
  activeClipId: string;
  activeVoiceId: string;
  tractParams: Record<TractParamName, number>;
  tractExtras: TractPoseExtras;
  glottisParams: GlottisM27Params;
  /** Reference ID into the bounded edited-audio cache (never stores raw AudioBuffer in snapshots) */
  editedAnnotationAudioId: string | null;
  localEdit?: { undo: () => void; redo: () => void };
}

const STORAGE_APPEARANCE_KEY = 'vocalcut.appearance.v1';
const STORAGE_SAVED_LOOKS_KEY = 'vocalcut.savedLooks.v1';
const STORAGE_ZOOM_KEY = 'vocalcut.zoom.v1';
const STORAGE_PREFS_KEY = 'vocalcut.prefs.v1';

function safeReadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function safeWriteJson(key: string, val: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    // Ignore storage quota errors in restricted browsing contexts
  }
}

function safeReadSession(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function safeWriteSession(key: string, val: string): void {
  try {
    if (!val) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, val);
  } catch {
    // Ignore sessionStorage restrictions
  }
}

export interface WorkbenchStore {
  // Project & Core
  project: Ref<VcProject>;
  revision: ComputedRef<number>;
  activeVoiceId: Ref<string>;
  activeClipId: Ref<string>;
  activeArrangerClipId: Ref<string>;

  // Workspace & Overlays
  activeWorkspace: Ref<WorkspaceId>;
  researchTab: Ref<ResearchTabId>;
  studioTab: Ref<StudioTabId>;
  activeOverlay: Ref<OverlayViewId>;
  activeModuleGuide: Ref<GuideModuleId | null>;
  guideTargetSection: Ref<string | null>;
  settingsTab: Ref<SettingsTabId>;
  aiDrawerOpen: Ref<boolean>;
  styleLabOpen: Ref<boolean>;
  referencesModalOpen: Ref<boolean>;
  exportModalWorkspace: Ref<WorkspaceId | null>;
  arrangerExportSource: Readonly<Ref<ArrangerExportSource | undefined>>;

  // Global Compute Device & Layout Preferences
  computeDevice: Ref<ComputeDevice>;
  videoCodecMode: Ref<'hw-webcodecs' | 'sw-wasm'>;
  shortcutPreset: Ref<ShortcutPresetId>;
  layoutDensity: Ref<LayoutDensity>;
  defaultTractViewMode: Ref<'2d' | '3d'>;
  timelineTrackScale: Ref<TimelineTrackScale>;
  aiDrawerDockMode: Ref<AiDrawerDockMode>;
  navPlacement: Ref<NavPlacement>;
  customSpeakerAudioBase64: Readonly<Ref<string | null>>;
  customSpeakerName: Readonly<Ref<string>>;

  // Appearance & Multi-Style Architecture
  themeMode: Ref<ThemeMode>;
  resolvedColorMode: Ref<ColorMode>;
  paletteId: Ref<string>;
  customAccentHex: Ref<string>;
  activePalette: Readonly<Ref<Record<string, string>>>;
  accentPickerColor: Readonly<Ref<string>>;
  surfaceStyle: Ref<string>;
  styleColorMode: Ref<StyleColorMode>;
  backdropId: Ref<BackdropId>;
  backdropColorScheme: Ref<string>;
  backdropCustomColors: Ref<[string, string, string]>;
  backdropActiveColors: Readonly<Ref<readonly [string, string, string]>>;
  glassBlur: Ref<number>;
  glassAlpha: Ref<number>;
  cardAlpha: Ref<number>;
  interfaceFonts: Ref<InterfaceFonts>;
  anatomyAppearance: Ref<AnatomyAppearance>;
  backdropTreatment: Readonly<Ref<BackdropTreatment>>;
  backdropVeilPct: Readonly<Ref<number>>;
  backdropTreatmentAutomatic: Readonly<Ref<boolean>>;
  savedLooks: Readonly<Ref<SavedLooksState>>;
  activeSavedLookId: Readonly<Ref<string | null>>;
  bgCov: Ref<number>;
  waveformColorMode: Ref<WaveformColorMode>;
  waveformCustomHex: Ref<string>;
  styleOverrides: Ref<StyleOverrides>;
  customSkinCounter: Ref<number>;

  // Responsive Scale & Splitters
  pageScale: Ref<number>;
  autoPageScale: Ref<boolean>;
  viewportWidth: Ref<number>;
  showSplitters: Ref<boolean>;
  splitterLayoutVersion: Ref<number>;

  // Selection & Transport
  selectedSyllableId: Ref<string>;
  selectedPhonemeIds: Ref<string[]>;
  playheadSmp: Ref<number>;
  isPlaying: Ref<boolean>;
  durationSmp: ComputedRef<number>;
  phonationAnchors: ComputedRef<PhonationAnchor[]>;
  selectedPhonationAnchorId: Ref<string | null>;

  // Acoustic Engine & Real-time VTL State
  engineStatus: Ref<EngineStatus>;
  engineMeta: Ref<Record<string, unknown> | null>;
  currentTractState: Ref<Record<string, unknown> | null>;
  currentTractParams: Ref<Record<TractParamName, number>>;
  currentTractExtras: Ref<TractPoseExtras>;
  currentGlottisParams: Ref<GlottisM27Params>;
  currentMetrics: Ref<TractMetrics>;
  lastAudioUrl: Ref<string | null>;
  lastAudioBuffer: Ref<AudioBuffer | null>;
  annotationAudioBuffer: Ref<AudioBuffer | null>;
  annotationAudioOffsetSmp: Ref<number>;
  annotationResetVersion: Ref<number>;
  editedAnnotationAudio: Ref<AudioBuffer | null>;
  annotationTractFrames: Ref<AnnotationTractFrame[]>;
  commitAnnotationAudio: (buffer: AudioBuffer, label: string) => void;
  clearAnnotationAudio: () => void;
  abVersion: Ref<'physical' | 'neural' | 'reference'>;
  isSynthesizing: Ref<boolean>;

  // Explore Lab Shared Context (for ExportModal / AiDrawer)

  // AI service preferences. The key is kept in memory.
  aiToolsModel: Ref<string>;
  aiToolsBaseUrl: Ref<string>;
  aiToolsApiKey: Ref<string>;
  deepSeekAsrEnabled: Ref<boolean>;
  localWhisperModel: Ref<WhisperModelId | null>;

  // Toasts
  toasts: Ref<ToastItem[]>;

  // Command Bus & Undo/Redo
  canUndo: ComputedRef<boolean>;
  canRedo: ComputedRef<boolean>;
  undoCount: ComputedRef<number>;
  redoCount: ComputedRef<number>;
  executeCommand: (cmd: WorkbenchCommand, options?: { localEdit?: HistorySnapshot['localEdit'] }) => CommandExecResult;
  checkpointHistory: (label: string, localEdit?: HistorySnapshot['localEdit']) => void;
  getRestorableAssetIds: () => Set<string>;
  undo: () => boolean;
  redo: () => boolean;
  previewProposal: (commands: WorkbenchCommand[]) => {
    ok: boolean;
    error?: CoreErrorDetail;
    changes: Array<{ field: string; before: string; after: string }>;
    draft?: VcProject;
  };
  applyProposal: (commands: WorkbenchCommand[], label?: string) => CommandExecResult;

  // Appearance Actions
  syncAppearance: () => void;
  setThemeMode: (mode: ThemeMode, originEvent?: MouseEvent) => void;
  toggleColorMode: (originEvent?: MouseEvent) => void;
  setPalette: (id: string) => void;
  setCustomAccent: (hex: string) => void;
  setSurfaceStyle: (id: string) => void;
  setStyleColorMode: (mode: StyleColorMode) => void;
  setBackdrop: (id: BackdropId) => void;
  setBackdropColorScheme: (schemeId: string) => void;
  setBackdropCustomColors: (colors: [string, string, string]) => void;
  setGlassBlur: (px: number) => void;
  setGlassAlpha: (pct: number) => void;
  setCardAlpha: (pct: number) => void;
  setInterfaceFonts: (patch: Partial<InterfaceFonts>) => void;
  setAnatomyAppearance: (patch: Partial<AnatomyAppearance>) => void;
  setBgSat: (pct: number) => void;
  setBackdropBlur: (px: number) => void;
  setBackdropVeil: (pct: number) => void;
  resetBackdropTreatment: () => void;
  setBgCov: (val: number) => void;
  setStyleOverrides: (patch: StyleOverrides) => void;
  setWaveformAppearance: (mode: WaveformColorMode, customHex?: string) => void;
  exportAppearanceJson: () => string;
  importAppearanceJson: (raw: string) => boolean;
  resetAppearance: () => void;
  saveCurrentLook: (mode?: ColorMode, name?: string) => boolean;
  applySavedLook: (mode: ColorMode, id: string, originEvent?: MouseEvent) => boolean;
  updateSavedLookFromCurrent: (mode: ColorMode, id: string, nextName?: string) => boolean;
  deleteSavedLook: (mode: ColorMode, id: string) => void;
  toggleDefaultSavedLook: (mode: ColorMode, id: string) => void;

  // Layout & Zoom Actions
  setPageScale: (scale: number, manual?: boolean) => void;
  resetAutoPageScale: () => void;
  setSplitterDefault: (storageKey: string, value: number) => SetSplitterDefaultResult;
  resetAllSplitters: () => void;
  resetSingleSplitter: (storageKey: string) => void;
  resetSplitterGroup: (storageKeys: readonly string[], title?: string) => void;
  setLayoutPrefs: (patch: Partial<{
    density: LayoutDensity;
    tractViewMode: '2d' | '3d';
    trackScale: TimelineTrackScale;
    aiDockMode: AiDrawerDockMode;
    navPlacement: NavPlacement;
    showSplitters: boolean;
  }>) => void;
  setComputeDevice: (device: ComputeDevice) => void;

  // Credentials & Quota
  setAiToolsCredentials: (baseUrl: string, apiKey: string, model?: string, deepSeekAsr?: boolean) => void;
  setLocalWhisperModel: (model: WhisperModelId) => void;

  // Acoustic Engine & Audio Playback
  probeEngine: () => Promise<EngineStatus>;
  requestVtlPose: (
    params?: Partial<Record<TractParamName, number>>,
    speaker?: string,
    extras?: Partial<TractPoseExtras> | null,
    preview?: boolean,
    rootGesture?:TongueRootGesture,
  ) => Promise<Record<string, unknown> | null>;
  applyIpaPose: (symbol: string, speaker?: string) => Promise<ResolvedPtbIpaPose>;
  synthesizeRange: (opts?: SynthesizeRangeOptions) => Promise<AudioBuffer | null>;
  synthesisInfo: (buffer: AudioBuffer) => SynthesisInfo | undefined;
  registerCombinedAudio: (
    buffer: AudioBuffer,
    info: SynthesisInfo,
    opts?: {
      mode?: VoiceRenderMode;
      audioGain?: SynthesisGainMode;
      streamPlayed?: boolean;
      applyPeakGain?: boolean;
    },
  ) => void;
  wasStreamPlayed: (buffer: AudioBuffer) => boolean;
  consumeStreamPlayed: (buffer: AudioBuffer) => boolean;
  markStreamPlayed: (buffer: AudioBuffer) => void;
  playAudioBuffer: (buf?: AudioBuffer | null, opts?: PlayAudioOptions) => Promise<void>;
  stopPlayback: () => void;

  // Navigation & UI Helpers
  setWorkspace: (ws: WorkspaceId) => void;
  openOverlay: (overlay: OverlayViewId, subTab?: SettingsTabId) => void;
  closeOverlay: () => void;
  openModuleGuide: (moduleId: GuideModuleId) => void;
  closeModuleGuide: () => void;
  openGuideSection: (sectionId?: string) => void;
  openExportModal: (ws: WorkspaceId, arrangement?: ArrangerExportSource) => void;
  closeExportModal: () => void;
  pushToast: (message: string, kind?: ToastKind, durationMs?: number) => void;
  dismissToast: (id: string) => void;
  exportProjectJson: () => string;
  importProjectJson: (raw: string) => CommandExecResult;
}

let singletonStore: WorkbenchStore | null = null;
let audioCtx: AudioContext | null = null;
let activeSourceNode: AudioBufferSourceNode | null = null;
let playbackFrame = 0;

function ensureAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctx) audioCtx = new Ctx({ sampleRate: SAMPLE_RATE_HZ });
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    void audioCtx.resume();
  }
  return audioCtx;
}

function createWorkbenchStore(): WorkbenchStore {
  const initialProject = createInitialProject();
  const project = ref<VcProject>(initialProject);
  const revision = computed(() => project.value.revision);
  const activeVoiceId = ref<string>(initialProject.voice_order[0] ?? 'voice_lead');
  const activeClipId = ref<string>(initialProject.clip_order[0] ?? 'clip_phrase_1');
  const activeArrangerClipId = ref<string>('clip_arranger_1');

  // Workspaces & overlays
  const activeWorkspace = ref<WorkspaceId>(initialWorkspace);
  watch([activeWorkspace, () => project.value.voices[activeVoiceId.value]?.speaker], () => {
    defaultVoiceRenderMode.value = 'neural';
  }, { immediate: true });
  const researchTab = ref<ResearchTabId>('main');
  const studioTab = ref<StudioTabId>('stage');
  const activeOverlay = ref<OverlayViewId>('none');
  const activeModuleGuide = ref<GuideModuleId | null>(null);
  const guideTargetSection = ref<string | null>(null);
  const settingsTab = ref<SettingsTabId>('appearance');
  const aiDrawerOpen = ref<boolean>(false);
  const styleLabOpen = ref<boolean>(false);
  const referencesModalOpen = ref<boolean>(false);
  const exportModalWorkspace = ref<WorkspaceId | null>(null);
  const arrangerExportSource = shallowRef<ArrangerExportSource>();

  // Preferences
  const savedPrefs = safeReadJson<{
    computeDevice?: ComputeDevice;
    videoCodecMode?: 'hw-webcodecs' | 'sw-wasm';
    shortcutPreset?: ShortcutPresetId;
    layoutDensity?: LayoutDensity;
    defaultTractViewMode?: '2d' | '3d';
    timelineTrackScale?: TimelineTrackScale;
    aiDrawerDockMode?: AiDrawerDockMode;
    navPlacement?: NavPlacement;
    showSplitters?: boolean;
    aiToolsModel?: string;
    aiToolsBaseUrl?: string;
    deepSeekAsrEnabled?: boolean;
    localWhisperModel?: WhisperModelId;
  }>(STORAGE_PREFS_KEY);

  // Keep ComputeDevice API contract intact while locking active inference device to local CPU.
  const computeDevice = ref<ComputeDevice>('wasm-cpu');
  project.value.settings.compute_device = computeDevice.value;
  const videoCodecMode = ref<'hw-webcodecs' | 'sw-wasm'>(savedPrefs?.videoCodecMode ?? 'hw-webcodecs');
  const shortcutPreset = ref<ShortcutPresetId>(savedPrefs?.shortcutPreset ?? 'default');
  const layoutDensity = ref<LayoutDensity>(
    savedPrefs?.layoutDensity === 'compact' || savedPrefs?.layoutDensity === 'spacious'
      ? savedPrefs.layoutDensity
      : 'standard',
  );
  const defaultTractViewMode = ref<'2d' | '3d'>(savedPrefs?.defaultTractViewMode === '3d' ? '3d' : '2d');
  const timelineTrackScale = ref<TimelineTrackScale>(
    savedPrefs?.timelineTrackScale === 'compact' || savedPrefs?.timelineTrackScale === 'tall'
      ? savedPrefs.timelineTrackScale
      : 'standard',
  );
  const aiDrawerDockMode = ref<AiDrawerDockMode>(savedPrefs?.aiDrawerDockMode === 'overlay' ? 'overlay' : 'docked');
  const navPlacement = ref<NavPlacement>(savedPrefs?.navPlacement === 'top' ? 'top' : 'left');
  const customSpeakerAudioBase64 = speakerReferenceAudio;
  const customSpeakerName = speakerReferenceName;

  // Appearance (saved + URL params)
  const savedApp = safeReadJson<Partial<AppearanceConfig>>(STORAGE_APPEARANCE_KEY);
  const baseApp = defaultAppearance();
  const urlParams = parseStyleUrlParams();

  const initialThemeMode: ThemeMode = urlParams.theme ?? savedApp?.themeMode ?? colorModeByLocalTime();
  const themeMode = ref<ThemeMode>(normalizeMode(initialThemeMode));
  const resolvedColorMode = ref<ColorMode>(resolveColorMode(themeMode.value));
  const paletteId = ref<string>(normalizePalette(urlParams.palette ?? savedApp?.paletteId ?? baseApp.paletteId));
  const customAccentHex = ref<string>(savedApp?.customAccentHex ?? baseApp.customAccentHex);
  const activePalette = computed(() => paletteTokens(paletteId.value, resolvedColorMode.value, customAccentHex.value));
  const accentPickerColor = computed(() => (
    paletteId.value === 'custom' ? normalizeHex(customAccentHex.value) : undefined
  ) ?? activePalette.value['--accent']);
  const surfaceStyle = ref<string>(normalizeSkinId(urlParams.style ?? savedApp?.surfaceStyle ?? baseApp.surfaceStyle));
  const styleColorMode = ref<StyleColorMode>(savedApp?.styleColorMode === 'original' ? 'original' : 'current');
  const backdropId = ref<BackdropId>(normalizeBackdropId(urlParams.bg ?? savedApp?.backdropId ?? baseApp.backdropId));
  const backdropColorScheme = ref<string>(savedApp?.backdropColorScheme ?? baseApp.backdropColorScheme);
  const backdropCustomColors = ref<[string, string, string]>(
    Array.isArray(savedApp?.backdropCustomColors) && savedApp.backdropCustomColors.length === 3
      ? [savedApp.backdropCustomColors[0], savedApp.backdropCustomColors[1], savedApp.backdropCustomColors[2]]
      : [...baseApp.backdropCustomColors],
  );
  const backdropActiveColors = computed(() => backdropColorScheme.value === 'theme'
    ? themeBackdropColors(activePalette.value)
    : backdropCustomColors.value);
  const glassBlur = ref<number>(urlParams.blur ?? savedApp?.glassBlur ?? baseApp.glassBlur);
  const surfaceOpacity = ref<NonNullable<AppearanceConfig['surfaceOpacity']>>(savedApp?.surfaceOpacity || {});
  const defaultsForStyle = (style: string) => {
    const values: Record<string, [number,number]> = {neumorphism:[67,64], clay:[73,72], glass:[30,32], minimal:[76,62],
      material:[77,72], swiss:[82,75], bauhaus:[83,78], brutal:[84,78]};
    const [panel,card] = values[style] ?? [66,64];
    return {panel,card};
  };
  const defaultsForCurrentStyle = defaultsForStyle(surfaceStyle.value);
  const currentOpacity = surfaceOpacity.value[surfaceStyle.value];
  const glassAlpha = ref<number>(currentOpacity?.panel ?? savedApp?.overrides?.glassAlpha ?? savedApp?.glassAlpha ?? defaultsForCurrentStyle.panel);
  const cardAlpha = ref<number>(currentOpacity?.card ?? savedApp?.cardAlpha ?? defaultsForCurrentStyle.card);
  const initialFontsInput =
    (savedApp?.fontDefaultVersion ?? 0) < 2
    && savedApp?.fonts?.chinese === 'system'
    && savedApp?.fonts?.latin === 'system'
    && savedApp?.fonts?.unified === false
      ? { fontSizePx: savedApp.fonts.fontSizePx }
      : savedApp?.fonts;
  const interfaceFonts = ref(normalizeInterfaceFonts(initialFontsInput));
  const anatomyAppearance = ref(normalizeAnatomyAppearance(savedApp?.anatomy));
  const savedBlur = savedApp?.bgBlur;
  const bgBlur = ref<number | null>(typeof savedBlur === 'number' && Number.isFinite(savedBlur) ? savedBlur : null);
  const savedVeil = savedApp?.bgVeil;
  const bgVeil = ref<number | null>(typeof savedVeil === 'number' && Number.isFinite(savedVeil) ? savedVeil : null);
  const bgSat = ref<number>(savedApp?.bgSat ?? baseApp.bgSat);
  const bgSatAuto = ref(savedApp?.bgSatAuto ?? (bgSat.value === baseApp.bgSat));
  const bgCov = ref<number>(savedApp?.bgCov ?? baseApp.bgCov);
  const waveformColorMode = ref<WaveformColorMode>(savedApp?.waveformColorMode ?? baseApp.waveformColorMode);
  const waveformCustomHex = ref<string>(savedApp?.waveformCustomHex ?? baseApp.waveformCustomHex);
  const styleOverrides = ref<StyleOverrides>({ ...(savedApp?.overrides ?? {}) });
  const backdropTreatment = computed<BackdropTreatment>(() => {
    const defaults = backdropTreatmentDefaults(activeWorkspaceBackground.value ? null : backdropId.value);
    const blur = bgBlur.value ?? defaults.blurPx;
    const saturation = styleOverrides.value.bgSat ?? (bgSatAuto.value ? defaults.saturationPct : bgSat.value);
    return {
      blurPx: Math.max(0, Math.min(BACKDROP_BLUR_MAX_PX, blur)),
      saturationPct: Math.max(20, Math.min(220, saturation)),
    };
  });
  const backdropVeilPct = computed<number>(() => {
    const customImage = Boolean(activeWorkspaceBackground.value);
    const fallback = backdropVeilDefault(customImage ? null : backdropId.value, resolvedColorMode.value, customImage);
    const raw = bgVeil.value ?? fallback;
    return Math.max(0, Math.min(BACKDROP_VEIL_MAX_PCT, Math.round(raw)));
  });
  const backdropTreatmentAutomatic = computed(() =>
    bgBlur.value === null && bgVeil.value === null && bgSatAuto.value && styleOverrides.value.bgSat === undefined,
  );
  const savedLooks = ref<SavedLooksState>(
    normalizeSavedLooksState(safeReadJson<unknown>(STORAGE_SAVED_LOOKS_KEY)),
  );
  const activeSavedLookId = ref<string | null>(null);
  const customSkinCounter = ref<number>(0);

  if (urlParams.openLab) {
    styleLabOpen.value = true;
  }

  // Page Zoom & Responsive
  const savedZoom = safeReadJson<{ scale?: number; auto?: boolean }>(STORAGE_ZOOM_KEY);
  const autoPageScale = ref<boolean>(savedZoom?.auto ?? true);
  const pageScale = ref<number>(
    autoPageScale.value ? computeAutoPageScale() : (savedZoom?.scale ?? computeAutoPageScale()),
  );
  const viewportWidth = ref<number>(typeof window !== 'undefined' ? window.innerWidth : 1920);
  const showSplitters = ref<boolean>(savedPrefs?.showSplitters !== false);
  const splitterLayoutVersion = ref<number>(0);

  // Selection & Transport
  const selectedSyllableId = ref<string>('');
  const selectedPhonemeIds = ref<string[]>([]);
  const playheadSmp = ref<number>(msToSamples(1150));
  const isPlaying = ref<boolean>(false);

  const durationSmp = computed(() => {
    let maxEnd = msToSamples(4400);
    for (const cid of project.value.clip_order) {
      const c = project.value.clips[cid];
      if (c && c.end_smp > maxEnd) maxEnd = c.end_smp;
    }
    return maxEnd;
  });

  const phonationAnchors = computed<PhonationAnchor[]>(() => {
    const list = project.value.phonation_anchor_order
      .map((id) => project.value.phonation_anchors[id])
      .filter((a): a is PhonationAnchor => Boolean(a));
    return [...list].sort((a, b) => a.t_smp - b.t_smp);
  });

  const selectedPhonationAnchorId = ref<string | null>(
    initialProject.phonation_anchor_order[1] ?? initialProject.phonation_anchor_order[0] ?? null,
  );

  // Engine & Tract State
  const engineStatus = ref<EngineStatus>('checking');
  const engineMeta = shallowRef<Record<string, unknown> | null>(null);
  const currentTractState = shallowRef<Record<string, unknown> | null>(null);
  const currentTractParams = ref<Record<TractParamName, number>>(defaultTractParams());
  const currentTractExtras = ref<TractPoseExtras>(cloneTractExtras(DEFAULT_TRACT_EXTRAS));
  const currentGlottisParams = ref<GlottisM27Params>(getPhonationAnchorParams('modal'));
  const currentMetrics = ref<TractMetrics>(computeAnalyticalMetrics(currentTractParams.value));
  const lastAudioUrl = ref<string | null>(null);
  const lastAudioBuffer = ref<AudioBuffer | null>(null);
  const annotationAudioBuffer = ref<AudioBuffer | null>(null);
  const annotationAudioOffsetSmp = ref(0);
  const annotationResetVersion = ref(0);
  const editedAnnotationAudio = ref<AudioBuffer | null>(null);
  const annotationTractFrames = ref<AnnotationTractFrame[]>([]);
  const generatedVoiceModes = new WeakMap<AudioBuffer,VoiceRenderMode>();
  const generatedGainModes = new WeakMap<AudioBuffer, SynthesisGainMode>();
  const renderedSynthesisInfo = new WeakMap<AudioBuffer, SynthesisInfo>();
  let streamPlayedBuffers = new WeakSet<AudioBuffer>();
  let activeStreamNodes: AudioBufferSourceNode[] = [];
  let activeVoiceGainBus: (ReturnType<typeof createVoicePlaybackBus> & { measured: boolean }) | undefined;

  function releaseVoiceGainBus(tail = false) {
    const bus = activeVoiceGainBus;
    activeVoiceGainBus = undefined;
    if (tail && bus) window.setTimeout(bus.dispose, 32);
    else bus?.dispose();
  }
  watch(voiceRenderMode, mode => {
    const stale = (audio:AudioBuffer|null) => audio && generatedVoiceModes.has(audio) && generatedVoiceModes.get(audio) !== mode;
    if (stale(annotationAudioBuffer.value)) annotationAudioBuffer.value = null;
    if (stale(lastAudioBuffer.value)) lastAudioBuffer.value = null;
  });
  watch(synthesisGainMode, mode => {
    const stale = (audio: AudioBuffer | null) => audio && generatedGainModes.has(audio) && generatedGainModes.get(audio) !== mode;
    if (stale(annotationAudioBuffer.value)) annotationAudioBuffer.value = null;
    if (stale(lastAudioBuffer.value)) lastAudioBuffer.value = null;
  });
  watch([customSpeakerAudioBase64, effectiveSpeakerBaseF0Hz], () => {
    const stale = (audio: AudioBuffer | null) => audio && renderedSynthesisInfo.get(audio)?.mode === 'neural';
    if (stale(annotationAudioBuffer.value)) annotationAudioBuffer.value = null;
    if (stale(lastAudioBuffer.value)) lastAudioBuffer.value = null;
  });
  let audioGeneration = 0;
  const playingPhonation = computed(() => activePhonationAnchorAt(phonationAnchors.value, playheadSmp.value));
  watch(() => JSON.stringify(playingPhonation.value ?? null), () => {
    const anchor = playingPhonation.value;
    currentGlottisParams.value = heldPhonationAt(anchor ? [anchor] : [], playheadSmp.value);
  });
  const abVersion = ref<'physical' | 'neural' | 'reference'>('physical');
  const isSynthesizing = ref<boolean>(false);
  let pendingSynthesisCount = 0;

  // Explore Lab Shared Context

  // AI & BYOK (session-only secret)
  const aiToolsModel = ref<string>(savedPrefs?.aiToolsModel ?? 'gpt-4o-mini');
  const aiToolsBaseUrl = ref<string>(savedPrefs?.aiToolsBaseUrl || 'https://api.openai.com/v1');
  const aiToolsApiKey = ref<string>('');
  const deepSeekAsrEnabled = ref(savedPrefs?.deepSeekAsrEnabled === true);
  const localWhisperModel = ref<WhisperModelId | null>(
    isWhisperModelId(savedPrefs?.localWhisperModel) ? savedPrefs.localWhisperModel : null,
  );

  // Toasts
  const toasts = ref<ToastItem[]>([]);
  const pushToast = (message: string, kind: ToastKind = 'info', durationMs = 3400): void => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    toasts.value = [...toasts.value.slice(-4), { id, message, kind, createdAt: Date.now() }];
    if (durationMs > 0) {
      globalThis.setTimeout(() => dismissToast(id), durationMs);
    }
  };

  const dismissToast = (id: string): void => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  };

  // Undo / Redo Stack
  const undoStack = ref<HistorySnapshot[]>([]);
  const redoStack = ref<HistorySnapshot[]>([]);
  const editedAudioCache = new Map<string, AudioBuffer>();
  const editedAudioIds = new WeakMap<AudioBuffer, string>();
  let editedAudioSeq = 0;

  const registerEditedAudioId = (buf: AudioBuffer | null): string | null => {
    if (!buf) return null;
    let id = editedAudioIds.get(buf);
    if (!id) {
      id = `edited_audio_${++editedAudioSeq}`;
      editedAudioIds.set(buf, id);
    }
    editedAudioCache.set(id, buf);
    return id;
  };

  const pruneEditedAudioCache = (): void => {
    const liveIds = new Set<string>();
    if (editedAnnotationAudio.value) {
      const curId = editedAudioIds.get(editedAnnotationAudio.value);
      if (curId) liveIds.add(curId);
    }
    for (const snap of [...undoStack.value, ...redoStack.value]) {
      if (snap.editedAnnotationAudioId) liveIds.add(snap.editedAnnotationAudioId);
    }
    for (const id of Array.from(editedAudioCache.keys())) {
      if (!liveIds.has(id)) editedAudioCache.delete(id);
    }
  };

  const canUndo = computed(() => undoStack.value.length > 0);
  const canRedo = computed(() => redoStack.value.length > 0);
  const undoCount = computed(() => undoStack.value.length);
  const redoCount = computed(() => redoStack.value.length);

  const captureSnapshot = (label: string): HistorySnapshot => ({
    label,
    activeClipId: activeClipId.value,
    activeVoiceId: activeVoiceId.value,
    projectJson: JSON.stringify(project.value),
    assetIds: Object.keys(project.value.assets),
    tractParams: { ...currentTractParams.value },
    tractExtras: cloneTractExtras(currentTractExtras.value),
    glottisParams: { ...currentGlottisParams.value },
    editedAnnotationAudioId: registerEditedAudioId(editedAnnotationAudio.value),
  });

  const getRestorableAssetIds = (): Set<string> => {
    const ids = new Set(Object.keys(project.value.assets));
    for (const snapshot of [...undoStack.value, ...redoStack.value]) {
      for (const id of snapshot.assetIds) ids.add(id);
    }
    return ids;
  };

  const restoreSnapshot = (snap: HistorySnapshot): void => {
    // Keep revision strictly monotonic across undo/redo to prevent ABA proposal conflicts
    const nextRevision = project.value.revision + 1;
    const restored = JSON.parse(snap.projectJson) as VcProject;
    restored.revision = nextRevision;
    project.value = restored;
    activeClipId.value = snap.activeClipId;
    if (snap.activeVoiceId && restored.voices[snap.activeVoiceId]) {
      activeVoiceId.value = snap.activeVoiceId;
    } else if (restored.voice_order[0]) {
      activeVoiceId.value = restored.voice_order[0];
    }
    currentTractParams.value = { ...snap.tractParams };
    currentTractExtras.value = cloneTractExtras(snap.tractExtras);
    currentGlottisParams.value = { ...snap.glottisParams };
    editedAnnotationAudio.value = snap.editedAnnotationAudioId
      ? (editedAudioCache.get(snap.editedAnnotationAudioId) ?? null)
      : null;
    currentMetrics.value = computeAnalyticalMetrics(currentTractParams.value);
    pruneEditedAudioCache();
  };

  const checkpointHistory = (label: string, localEdit?: HistorySnapshot['localEdit']): void => {
    undoStack.value = [...undoStack.value.slice(-99), { ...captureSnapshot(label), localEdit }];
    redoStack.value = [];
    pruneEditedAudioCache();
  };

  /**
   * Apply a single command directly onto target state (project + tract + glottis).
   * Rejects invalid keys/NaN with `validation_error` and out-of-range inputs with `out_of_range`.
   */
  const applySingleCommandToState = (
    targetProject: VcProject,
    targetTract: Record<TractParamName, number>,
    targetGlottis: GlottisM27Params,
    cmd: WorkbenchCommand,
  ): { ok: true; changes: Array<{ field: string; before: string; after: string }> } | { ok: false; error: CoreErrorDetail } => {
    const changes: Array<{ field: string; before: string; after: string }> = [];
    const p = cmd.payload;

    switch (cmd.type) {
      case 'artic.set_pose': {
        const metaByKey = new Map(VTL_PARAM_META.map((m) => [m.key as string, m]));
        const invalidFields: string[] = [];
        const resolvedUpdates: Array<{ meta: (typeof VTL_PARAM_META)[number]; nextVal: number }> = [];

        // 1. Absolute `params` payload: supports 19-dim array or Partial<Record<TractParamName, number>>
        if (p.params !== undefined) {
          if (Array.isArray(p.params)) {
            if (p.params.length !== VTL_PARAM_ORDER.length) {
              return {
                ok: false,
                error: {
                  code: 'validation_error',
                  field: 'params',
                  value: p.params.length,
                  hint: `params 数组必须为 ${VTL_PARAM_ORDER.length} 维声道参数`,
                },
              };
            }
            for (let i = 0; i < VTL_PARAM_ORDER.length; i++) {
              const key = VTL_PARAM_ORDER[i];
              const meta = metaByKey.get(key)!;
              const rawVal = p.params[i];
              if (typeof rawVal !== 'number' || !Number.isFinite(rawVal)) {
                invalidFields.push(`params[${key}]`);
                continue;
              }
              resolvedUpdates.push({ meta, nextVal: rawVal });
            }
          } else if (p.params && typeof p.params === 'object') {
            for (const [k, rawVal] of Object.entries(p.params as Record<string, unknown>)) {
              if (rawVal === undefined) continue;
              const meta = metaByKey.get(k);
              if (!meta || typeof rawVal !== 'number' || !Number.isFinite(rawVal)) {
                invalidFields.push(`params.${k}`);
                continue;
              }
              resolvedUpdates.push({ meta, nextVal: rawVal });
            }
          } else {
            return {
              ok: false,
              error: {
                code: 'validation_error',
                field: 'params',
                value: p.params,
                hint: 'params 必须为 19 维数值数组或声道参数键值对象',
              },
            };
          }
        }

        // 2. Relative `delta` payload: matches core CommandBus relative-offset semantics
        if (p.delta !== undefined) {
          if (!p.delta || typeof p.delta !== 'object' || Array.isArray(p.delta)) {
            return {
              ok: false,
              error: {
                code: 'validation_error',
                field: 'delta',
                value: p.delta,
                hint: 'delta 必须为声道参数相对增量键值对象',
              },
            };
          }
          for (const [k, rawDelta] of Object.entries(p.delta as Record<string, unknown>)) {
            if (rawDelta === undefined) continue;
            const meta = metaByKey.get(k);
            if (!meta || typeof rawDelta !== 'number' || !Number.isFinite(rawDelta)) {
              invalidFields.push(`delta.${k}`);
              continue;
            }
            const baseVal = targetTract[meta.key];
            resolvedUpdates.push({ meta, nextVal: Number((baseVal + rawDelta).toFixed(6)) });
          }
        }

        if (invalidFields.length > 0) {
          return {
            ok: false,
            error: {
              code: 'validation_error',
              field: invalidFields[0],
              value: invalidFields,
              allowed: [...VTL_PARAM_ORDER],
              hint: `声道参数包含非法键或非有限数值: ${invalidFields.join(', ')}`,
            },
          };
        }

        // Validate bounds before mutating any state (atomic all-or-nothing)
        for (const { meta, nextVal } of resolvedUpdates) {
          if (nextVal < meta.min - 1e-6 || nextVal > meta.max + 1e-6) {
            return {
              ok: false,
              error: {
                code: 'out_of_range',
                field: `tract.${meta.key}`,
                value: nextVal,
                allowed: { min: meta.min, max: meta.max, unit: 'vtl' },
                hint: `声道参数 ${meta.key} (${nextVal}) 超出解剖边界 [${meta.min}, ${meta.max}]`,
              },
            };
          }
        }

        for (const { meta, nextVal } of resolvedUpdates) {
          const prev = targetTract[meta.key];
          targetTract[meta.key] = nextVal;
          changes.push({ field: meta.label, before: prev.toFixed(2), after: nextVal.toFixed(2) });
        }

        // Also update selected phoneme segment params if syllable_id / segment_id provided
        const clip = targetProject.clips[String(p.clip_id ?? activeClipId.value)];
        const syllId = String(p.syllable_id ?? selectedSyllableId.value);
        if (clip && clip.syllables[syllId]) {
          const syll = clip.syllables[syllId];
          const segIdx = typeof p.seg_index === 'number' ? p.seg_index : syll.nucleus_index;
          if (syll.segments[segIdx]) {
            syll.segments[segIdx].params = tractRecordToArray19(targetTract);
          }
        }
        return { ok: true, changes };
      }

      case 'voice.set_glottis': {
        const next: GlottisM27Params = { ...targetGlottis };
        const patch = p as Partial<GlottisM27Params>;
        for (const key of Object.keys(next) as Array<keyof GlottisM27Params>) {
          if (patch[key] !== undefined) {
            const val = Number(patch[key]);
            const prev = next[key];
            next[key] = val;
            changes.push({ field: `glottis.${key}`, before: String(prev), after: String(val) });
          }
        }
        const validated = validateGlottisM27(next);
        if (!validated.ok) return { ok: false, error: validated.error };
        Object.assign(targetGlottis, validated.value);
        return { ok: true, changes };
      }

      case 'voice.set_pressure': {
        const pressurePa = Number(p.pressure_pa);
        if (!Number.isFinite(pressurePa) || pressurePa < PRESSURE_LIMIT_PA.min || pressurePa > PRESSURE_LIMIT_PA.max) {
          return {
            ok: false,
            error: {
              code: 'out_of_range',
              field: 'pressure_pa',
              value: pressurePa,
              allowed: { min: PRESSURE_LIMIT_PA.min, max: PRESSURE_LIMIT_PA.max, unit: 'Pa' },
              hint: `声门下压 (${pressurePa} Pa) 超出合法区间 [0, 1600] Pa`,
            },
          };
        }
        const prev = targetGlottis.pr_pa;
        targetGlottis.pr_pa = pressurePa;
        changes.push({ field: '声门下压 PR (Pa)', before: `${prev} Pa`, after: `${pressurePa} Pa` });

        const clip = targetProject.clips[String(p.clip_id ?? activeClipId.value)];
        const syllId = String(p.syllable_id ?? selectedSyllableId.value);
        if (clip && clip.syllables[syllId] && Array.isArray(p.points)) {
          clip.syllables[syllId].overrides.pressure = p.points as Array<{ u: number; pressure_pa: number }>;
        }
        return { ok: true, changes };
      }

      case 'f0.set_targets': {
        const f0Hz = p.f0_hz !== undefined ? Number(p.f0_hz) : undefined;
        if (f0Hz !== undefined) {
          const f0Chk = assertValidF0Hz('f0_hz', f0Hz);
          if (!f0Chk.ok) {
            return {
              ok: false,
              error: f0Chk.error,
            };
          }
          const prev = targetGlottis.f0_hz;
          targetGlottis.f0_hz = f0Hz;
          changes.push({ field: '控制基频 F0', before: `${prev} Hz`, after: `${f0Hz} Hz` });
        }
        const clip = targetProject.clips[String(p.clip_id ?? activeClipId.value)];
        const syllId = String(p.syllable_id ?? selectedSyllableId.value);
        if (clip && clip.syllables[syllId]) {
          const syll = clip.syllables[syllId];
          const bEndSt = typeof p.b_end_st === 'number' ? p.b_end_st : undefined;
          const mStPerS = typeof p.m_st_per_s === 'number' ? p.m_st_per_s : undefined;
          if (bEndSt !== undefined || mStPerS !== undefined) {
            let span = syll.targets[0];
            if (!span) {
              span = {
                id: `${syll.id}_t0`,
                span_id: syll.id,
                start_smp: syll.start_smp,
                end_smp: syll.end_smp,
                voiced: true,
                candidates: {
                  default: {
                    m_st_per_s: 0,
                    b_end_st: 0,
                    lambda_per_s: 28,
                    source: 'default',
                  },
                },
              };
              syll.targets.push(span);
            }
            const prevCand = span.candidates.user ?? span.candidates.default;
            span.candidates.user = {
              m_st_per_s: mStPerS ?? prevCand?.m_st_per_s ?? 0,
              b_end_st: bEndSt ?? prevCand?.b_end_st ?? 0,
              lambda_per_s: typeof p.lambda_per_s === 'number' ? p.lambda_per_s : (prevCand?.lambda_per_s ?? 28),
              source: 'user',
            };
            changes.push({
              field: `${syll.text} qTA 靶点`,
              before: `${(prevCand?.b_end_st ?? 0).toFixed(1)} st`,
              after: `${span.candidates.user.b_end_st.toFixed(1)} st`,
            });
          }
        }
        return { ok: true, changes };
      }

      case 'f0.draw': {
        const points = (p.points ?? []) as Array<{ t_smp: number; f0_hz: number }>;
        for (const pt of points) {
          const ptChk = assertValidF0Hz('f0.draw.f0_hz', pt.f0_hz);
          if (!ptChk.ok) {
            return {
              ok: false,
              error: ptChk.error,
            };
          }
        }
        if (points.length >= 2) {
          const seg = {
            id: String(p.id ?? `f0pin_${Date.now()}`),
            start_smp: points[0].t_smp,
            end_smp: points[points.length - 1].t_smp,
            points,
            transition_ms: 30,
            exit_fit_ms: 35,
          };
          targetProject.f0_pins = [...(targetProject.f0_pins ?? []).filter((s) => s.id !== seg.id), seg];
          changes.push({ field: '手绘 F0 曲线', before: 'qTA 自动', after: `${points.length} 锚点` });
        }
        return { ok: true, changes };
      }

      case 'phonation.set_anchors': {
        const anchors = (p.anchors ?? []) as PhonationAnchor[];
        if (!Array.isArray(anchors)) {
          return {
            ok: false,
            error: {
              code: 'validation_error',
              field: 'anchors',
              hint: '请输入发声类型锚点序列',
            },
          };
        }
        for (const a of anchors) {
          if (!(PHONATION_REGIMES as readonly string[]).includes(a.regime)) {
            return {
              ok: false,
              error: {
                code: 'validation_error',
                field: 'phonation.regime',
                value: a.regime,
                allowed: [...PHONATION_REGIMES],
                hint: `未知的兼容发声类型 ${String(a.regime)}`,
              },
            };
          }
          const voice = validateVoqsAnchor(a);
          if (!voice.ok) return voice;
        }
        const sorted = [...anchors].sort((a, b) => a.t_smp - b.t_smp);
        const prevSummary = targetProject.phonation_anchor_order
          .map((id) => targetProject.phonation_anchors[id]?.voqs?.symbol ?? targetProject.phonation_anchors[id]?.regime)
          .filter(Boolean)
          .join(' → ');
        targetProject.phonation_anchor_order = sorted.map((a) => a.id);
        targetProject.phonation_anchors = {};
        for (const a of sorted) {
          targetProject.phonation_anchors[a.id] = {
            ...a,
            glottis: a.glottis ? { ...a.glottis } : undefined,
            voqs: a.voqs ? { ...a.voqs } : undefined,
          };
        }
        const nextSummary = sorted.map((a) => a.voqs?.symbol ?? a.regime).join(' → ');
        const span = p.editSpan as { start_smp: number; end_smp: number; before: string; after: string; target: string } | undefined;
        if (span) {
          changes.push({
            field: `发声类型 · ${span.target} · ${(span.start_smp / 48).toFixed(1)}–${(span.end_smp / 48).toFixed(1)} ms`,
            before: span.before, after: span.after,
          });
        } else {
          changes.push({ field: 'PHON 发声类型锚点', before: prevSummary || '无', after: nextSummary });
        }
        const sampled = heldPhonationAt(sorted, playheadSmp.value);
        Object.assign(targetGlottis, sampled);
        return { ok: true, changes };
      }

      case 'textgrid.set_boundary': {
        const clip = targetProject.clips[String(p.clip_id ?? activeClipId.value)];
        const syllId = String(p.syllable_id ?? selectedSyllableId.value);
        const segId = p.segment_id ? String(p.segment_id) : '';
        const newEndSmp = Math.round(Number(p.end_smp));
        const rawStartSmp = p.start_smp !== undefined ? Math.round(Number(p.start_smp)) : undefined;
        if (!clip || !clip.syllables[syllId]) {
          return { ok: false, error: { code: 'not_found', hint: `未找到音节 ${syllId}` } };
        }
        const syll = clip.syllables[syllId];

        // Whole-syllable retiming (including single-syllable & final-syllable clips, T-46)
        if (!segId) {
          const targetStart = rawStartSmp !== undefined ? Math.max(0, rawStartSmp) : syll.start_smp;
          const prevDurMs = Math.round(((syll.end_smp - syll.start_smp) / SAMPLE_RATE_HZ) * 1000);
          const syllOrderIdx = clip.syllable_order.indexOf(syllId);

          // If dragging left edge of a non-initial syllable that directly abuts the previous syllable,
          // ensure targetStart does not overlap previous syllable's rigid floor
          if (rawStartSmp !== undefined && syllOrderIdx > 0) {
            const prevSid = clip.syllable_order[syllOrderIdx - 1];
            const prevSyl = clip.syllables[prevSid];
            if (prevSyl && targetStart < prevSyl.end_smp) {
              const prevRetime = retime(
                clip,
                { clip_id: clip.id, syllable_id: prevSid, new_end_smp: targetStart },
                targetProject.phonation_anchors,
                targetProject.f0_pins ?? [],
              );
              if (!prevRetime.ok) return { ok: false, error: prevRetime.error };
              // Preserve right-edge drag or keep current syllable end fixed while trading boundary
              const tradedClip = prevRetime.value.clip;
              const shiftedSyl = tradedClip.syllables[syllId];
              const desiredEnd = p.keep_end === true ? syll.end_smp : newEndSmp + (shiftedSyl.start_smp - targetStart);
              const curRetime = retime(
                tradedClip,
                { clip_id: clip.id, syllable_id: syllId, new_start_smp: targetStart, new_end_smp: desiredEnd },
                prevRetime.value.phonation_anchors,
                prevRetime.value.f0_pins,
              );
              if (!curRetime.ok) return { ok: false, error: curRetime.error };
              const lastSid = curRetime.value.clip.syllable_order.at(-1);
              const lastEnd = lastSid ? curRetime.value.clip.syllables[lastSid]?.end_smp ?? curRetime.value.clip.end_smp : curRetime.value.clip.end_smp;
              targetProject.clips[clip.id] = { ...curRetime.value.clip, end_smp: Math.max(msToSamples(60), lastEnd) };
              targetProject.phonation_anchors = curRetime.value.phonation_anchors;
              targetProject.f0_pins = curRetime.value.f0_pins;
              const nextDurMs = Math.round(((desiredEnd - targetStart) / SAMPLE_RATE_HZ) * 1000);
              changes.push({ field: `音节「${syll.text}」时长`, before: `${prevDurMs} ms`, after: `${nextDurMs} ms` });
              return { ok: true, changes };
            }
          }

          const res = retime(
            clip,
            {
              clip_id: clip.id,
              syllable_id: syllId,
              new_start_smp: targetStart,
              new_end_smp: newEndSmp,
            },
            targetProject.phonation_anchors,
            targetProject.f0_pins ?? [],
          );
          if (!res.ok) return { ok: false, error: res.error };
          const retimedClip = res.value.clip;
          const lastSid = retimedClip.syllable_order.at(-1);
          const lastEnd = lastSid ? retimedClip.syllables[lastSid]?.end_smp ?? newEndSmp : newEndSmp;
          targetProject.clips[clip.id] = {
            ...retimedClip,
            end_smp: Math.max(msToSamples(60), lastEnd),
          };
          targetProject.phonation_anchors = res.value.phonation_anchors;
          targetProject.f0_pins = res.value.f0_pins;
          const nextDurMs = Math.round(((newEndSmp - targetStart) / SAMPLE_RATE_HZ) * 1000);
          changes.push({ field: `音节「${syll.text}」时长`, before: `${prevDurMs} ms`, after: `${nextDurMs} ms` });
          return { ok: true, changes };
        }

        const idx = syll.segments.findIndex((s) => s.id === segId);
        if (idx < 0) {
          return { ok: false, error: { code: 'not_found', hint: `未找到音素 ${segId}` } };
        }
        const seg = syll.segments[idx];
        const minLenSmp = msToSamples(seg.stop_timing ? Math.max(11, seg.stop_timing.closure_ms + seg.stop_timing.release_ms) : 15);
        if (newEndSmp - seg.start_smp < minLenSmp) {
          return {
            ok: false,
            error: {
              code: 'rigid_floor',
              field: 'end_smp',
              value: newEndSmp,
              hint: `触及刚性时长下限 (${Math.round((minLenSmp / SAMPLE_RATE_HZ) * 1000)} ms)，阻挡过度压缩`,
            },
          };
        }
        const deltaSmp = newEndSmp - seg.end_smp;
        const prevMs = Math.round(((seg.end_smp - seg.start_smp) / SAMPLE_RATE_HZ) * 1000);
        seg.end_smp = newEndSmp;
        for (let i = idx + 1; i < syll.segments.length; i++) {
          syll.segments[i].start_smp += deltaSmp;
          syll.segments[i].end_smp += deltaSmp;
        }
        syll.end_smp += deltaSmp;
        const syllIdx = clip.syllable_order.indexOf(syllId);
        for (let s = syllIdx + 1; s < clip.syllable_order.length; s++) {
          const downstream = clip.syllables[clip.syllable_order[s]];
          if (!downstream) continue;
          downstream.start_smp += deltaSmp;
          downstream.end_smp += deltaSmp;
          for (const ds of downstream.segments) {
            ds.start_smp += deltaSmp;
            ds.end_smp += deltaSmp;
          }
          for (const t of downstream.targets) {
            t.start_smp += deltaSmp;
            t.end_smp += deltaSmp;
          }
        }
        const lastSid = clip.syllable_order.at(-1);
        const lastEnd = lastSid ? clip.syllables[lastSid]?.end_smp ?? clip.end_smp + deltaSmp : clip.end_smp + deltaSmp;
        clip.end_smp = Math.max(msToSamples(60), lastEnd);
        const nextMs = Math.round(((seg.end_smp - seg.start_smp) / SAMPLE_RATE_HZ) * 1000);
        changes.push({ field: `音素 [${seg.ipa}] 时长`, before: `${prevMs} ms`, after: `${nextMs} ms` });
        return { ok: true, changes };
      }

      case 'lyrics.set_reading': {
        const clip = targetProject.clips[String(p.clip_id ?? activeClipId.value)];
        const syllId = String(p.syllable_id ?? selectedSyllableId.value);
        const ipaList = (p.ipa ?? []) as string[];
        if (!clip || !clip.syllables[syllId] || ipaList.length === 0) {
          return { ok: false, error: { code: 'validation_error', hint: '多音字切音参数缺失' } };
        }
        const syll = clip.syllables[syllId];
        const prevIpa = syll.ipa.join('');
        syll.ipa = [...ipaList];
        const totalSmp = Math.max(2400, syll.end_smp - syll.start_smp);
        const spk = targetProject.voices[activeVoiceId.value]?.speaker ?? 'JD2';
        syll.segments = ipaList.map((sym, idx) => {
          const resolved = resolvePtbIpaPose(sym, spk);
          return {
            id: `${syll.id}_seg_${idx}`,
            ipa: sym,
            start_smp: syll.start_smp + Math.round((totalSmp * idx) / ipaList.length),
            end_smp:
              idx === ipaList.length - 1
                ? syll.end_smp
                : syll.start_smp + Math.round((totalSmp * (idx + 1)) / ipaList.length),
            role: idx === 0 && ipaList.length > 1 ? 'onset' : idx === 1 || ipaList.length === 1 ? 'nucleus' : 'coda',
            elastic: idx === 1 || ipaList.length === 1,
            voiced: !['x', 't', 'tɕ', 's', 'p', 'k', 'f', 'ɕ'].includes(sym),
            params: [...resolved.params19],
            lip_width: resolved.extras.lip_width,
            larynx_height_cm: resolved.extras.larynx_height,
            tongue_shape: [...resolved.extras.tongue_shape],
            lip_shape: [...resolved.extras.lip_shape],
          };
        });
        if (typeof p.tone_levels === 'string') syll.tone_levels = p.tone_levels;
        changes.push({ field: `音节「${syll.text}」读音`, before: `[${prevIpa}]`, after: `[${ipaList.join('')}]` });
        return { ok: true, changes };
      }

      case 'project.set_bpm': {
        const bpm = Number(p.bpm);
        if (!Number.isFinite(bpm) || bpm < 30 || bpm > 260) {
          return {
            ok: false,
            error: {
              code: 'out_of_range',
              field: 'bpm',
              value: bpm,
              allowed: { min: 30, max: 260, unit: 'BPM' },
              hint: `BPM (${bpm}) 超出合法区间 [30, 260]`,
            },
          };
        }
        const prev = targetProject.settings.tempo_map[0]?.bpm ?? 92;
        if (targetProject.settings.tempo_map.length === 0) {
          targetProject.settings.tempo_map.push({ tick: 0, bpm });
        } else {
          targetProject.settings.tempo_map[0].bpm = bpm;
        }
        changes.push({ field: '工程速度 BPM', before: `${prev}`, after: `${bpm}` });
        return { ok: true, changes };
      }

      case 'project.set_speaker': {
        const speaker = String(p.speaker) as 'JD2' | 'W02' | 'M01' | 'JD2-2D' | 'W02-2D';
        const voice = targetProject.voices[String(p.voice_id ?? activeVoiceId.value)];
        if (!voice) return { ok: false, error: { code: 'not_found', hint: '未找到活动声部' } };
        const prev = voice.speaker;
        voice.speaker = speaker;
        changes.push({ field: '说话人模型', before: prev, after: speaker });
        return { ok: true, changes };
      }

      case 'sing.set_lead': {
        const clip = targetProject.clips[String(p.clip_id ?? activeClipId.value)];
        const syllId = String(p.syllable_id ?? selectedSyllableId.value);
        const leadMs = Number(p.lead_ms);
        if (!Number.isFinite(leadMs) || leadMs < 0 || leadMs > 280) {
          return {
            ok: false,
            error: {
              code: 'out_of_range',
              field: 'lead_ms',
              value: leadMs,
              allowed: { min: 0, max: 280, unit: 'ms' },
              hint: `辅音抢拍前导量 (${leadMs} ms) 超出 [0, 280] ms`,
            },
          };
        }
        if (clip && clip.syllables[syllId]) {
          const prev = clip.syllables[syllId].anchor.lead_ms ?? 0;
          clip.syllables[syllId].anchor.lead_ms = leadMs;
          changes.push({ field: '辅音抢拍 lead_ms', before: `${prev} ms`, after: `${leadMs} ms` });
        }
        return { ok: true, changes };
      }

      case 'visual.set_keys': {
        const layerId = String(p.layer_id ?? 'layer_v1_tract');
        const layer = targetProject.layers[layerId];
        if (!layer) return { ok: false, error: { code: 'not_found', hint: `未找到视觉图层 ${layerId}` } };
        if (typeof p.visible === 'boolean') {
          changes.push({ field: `图层 ${layerId}`, before: layer.visible ? '显示' : '隐藏', after: p.visible ? '显示' : '隐藏' });
          layer.visible = p.visible;
        }
        if (p.keys && typeof p.keys === 'object') {
          const placement = p.placement as { label: string; track: string; start_smp: number; end_smp: number } | undefined;
          if (placement) {
            changes.push({
              field: `剪辑 ${placement.track.toUpperCase()} · ${placement.label}`, before: '待排入',
              after: `${(placement.start_smp / SAMPLE_RATE_HZ).toFixed(3)}–${(placement.end_smp / SAMPLE_RATE_HZ).toFixed(3)} s`,
            });
          } else if ('nle_meta' in p.keys) {
            const updated = p.keys.nle_meta;
            changes.push({ field: '剪辑时间线片段数', before: String(layer.keys?.nle_meta?.length ?? 0),
              after: String(Array.isArray(updated) ? updated.length : 0) });
          } else {
            const previous = Object.fromEntries(Object.keys(p.keys).map(key => [key, layer.keys?.[key]]));
            changes.push({ field: `图层 ${layerId} 关键帧`, before: JSON.stringify(previous), after: JSON.stringify(p.keys) });
          }
          layer.keys = { ...(layer.keys ?? {}), ...(p.keys as Record<string, never[]>) };
        }
        return { ok: true, changes };
      }

      case 'subtitle.style': {
        const layer = stageLayer(targetProject, 'v3');
        if (!layer?.style) return { ok: false, error: { code: 'not_found', hint: '工程没有可编辑的字幕图层' } };
        if (p.font_size_px !== undefined) {
          const check = assertInRange('font_size_px', Number(p.font_size_px), 8, 240, 'px', '字幕字号须在 8–240 px 之间');
          if (!check.ok) return check;
        }
        if (p.tilt_deg !== undefined) {
          const check = assertInRange('tilt_deg', Number(p.tilt_deg), -180, 180, '°', '字幕倾斜角须在 -180° 至 180° 之间');
          if (!check.ok) return check;
        }
        if (p.size_jitter && typeof p.size_jitter === 'object') {
          const j = p.size_jitter as { min_pct?: unknown; max_pct?: unknown; seed?: unknown };
          const cMin = assertInRange('size_jitter.min_pct', Number(j.min_pct), 20, 300, '%', '抖动下限须在 20%–300%');
          if (!cMin.ok) return cMin;
          const cMax = assertInRange('size_jitter.max_pct', Number(j.max_pct), 20, 300, '%', '抖动上限须在 20%–300%');
          if (!cMax.ok) return cMax;
          if (cMin.value > cMax.value) {
            return { ok: false, error: { code: 'validation_error', hint: '字幕字号抖动下限不能大于上限' } };
          }
          if (!Number.isSafeInteger(j.seed)) {
            return { ok: false, error: { code: 'validation_error', hint: '字幕字号抖动种子须为整数' } };
          }
        }
        if (p.angle_jitter && typeof p.angle_jitter === 'object') {
          const j = p.angle_jitter as { min_deg?: unknown; max_deg?: unknown; seed?: unknown };
          const cMin = assertInRange('angle_jitter.min_deg', Number(j.min_deg), -90, 90, '°', '角度抖动下限须在 -90° 至 90°');
          if (!cMin.ok) return cMin;
          const cMax = assertInRange('angle_jitter.max_deg', Number(j.max_deg), -90, 90, '°', '角度抖动上限须在 -90° 至 90°');
          if (!cMax.ok) return cMax;
          if (cMin.value > cMax.value) {
            return { ok: false, error: { code: 'validation_error', hint: '字幕角度抖动下限不能大于上限' } };
          }
          if (!Number.isSafeInteger(j.seed)) {
            return { ok: false, error: { code: 'validation_error', hint: '字幕角度抖动种子须为整数' } };
          }
        }
        const prevMode = layer.style.reveal_mode;
        Object.assign(layer.style, p);
        changes.push({ field: '字幕样式', before: prevMode, after: layer.style.reveal_mode });
        return { ok: true, changes };
      }

      case 'score.apply':
      case 'clip.edit': {
        if (p.clip && typeof p.clip === 'object') {
          const nextClip = p.clip as VcProject['clips'][string];
          const previousClip = targetProject.clips[nextClip.id];
          const editing = targetProject.clips[activeClipId.value];
          if (p.switchAnnotation === true && editing && editing.id !== nextClip.id) {
            editing.annotation_controls = {
              phonation_anchor_order: targetProject.phonation_anchor_order, phonation_anchors: targetProject.phonation_anchors,
              f0_pins: targetProject.f0_pins, vibrato: targetProject.vibrato, perturbation: targetProject.perturbation,
            };
            const controls = nextClip.annotation_controls;
            targetProject.phonation_anchor_order = controls?.phonation_anchor_order ?? [];
            targetProject.phonation_anchors = controls?.phonation_anchors ?? {};
            targetProject.f0_pins = controls?.f0_pins ?? [];
            targetProject.vibrato = controls?.vibrato;
            targetProject.perturbation = controls?.perturbation;
          }
          targetProject.clips[nextClip.id] = nextClip;
          const timing = p.retimed as RetimeResult | undefined;
          if (timing) {
            targetProject.phonation_anchors = timing.phonation_anchors;
            targetProject.f0_pins = timing.f0_pins;
          }
          if (p.resetAnnotation === true) {
            targetProject.phonation_anchor_order = [];
            targetProject.phonation_anchors = {};
            targetProject.f0_pins = [];
            delete targetProject.vibrato;
            delete targetProject.perturbation;
          }
          if (!targetProject.clip_order.includes(nextClip.id)) {
            targetProject.clip_order.push(nextClip.id);
          }
          if (cmd.type === 'score.apply') {
            changes.push({
              field: `编曲 · ${nextClip.source?.lyrics ?? nextClip.id}`,
              before: previousClip?.source?.score ?? '无简谱',
              after: `${nextClip.source?.score ?? ''} · 1 = ${nextClip.source?.score_tonic ?? 'C3'}`,
            });
          } else {
            changes.push({ field: `片段 ${nextClip.id}`, before: '原片段', after: '已更新' });
          }
        }
        return { ok: true, changes };
      }

      case 'project.replace': {
        const incoming = p.project as VcProject | undefined;
        if (!incoming || incoming.schema !== 'vocalcut/project' || typeof incoming.clips !== 'object' ||
            typeof incoming.layers !== 'object' || typeof incoming.settings !== 'object') {
          return {
            ok: false,
            error: { code: 'validation_error', hint: '无效的 .vcproj 文件格式（缺少 vocalcut/project schema 或核心工程字段）' },
          };
        }
        const prevName = targetProject.name;
        const cloned = JSON.parse(JSON.stringify(incoming)) as VcProject;
        for (const key of ['arrangements', 'f0_pins', 'vibrato', 'perturbation'] as const) {
          if (!(key in cloned) || cloned[key] === undefined) {
            delete targetProject[key];
          }
        }
        Object.assign(targetProject, cloned);
        changes.push({ field: '工程载入', before: prevName, after: incoming.name });
        return { ok: true, changes };
      }

      case 'batch': {
        const list = (p.commands ?? []) as WorkbenchCommand[];
        for (const sub of list) {
          const res = applySingleCommandToState(targetProject, targetTract, targetGlottis, sub);
          if (!res.ok) return res;
          changes.push(...res.changes);
        }
        return { ok: true, changes };
      }
    }
  };

  const executeCommand = (
    cmd: WorkbenchCommand,
    options?: { localEdit?: HistorySnapshot['localEdit'] },
  ): CommandExecResult => {
    const clonedProject = JSON.parse(JSON.stringify(project.value)) as VcProject;
    const clonedTract = { ...currentTractParams.value };
    const clonedGlottis = { ...currentGlottisParams.value };

    const res = applySingleCommandToState(clonedProject, clonedTract, clonedGlottis, cmd);
    if (!res.ok) {
      pushToast(res.error.hint, 'danger', 4500);
      return { ok: false, revision: project.value.revision, error: res.error };
    }

    checkpointHistory(cmd.label ?? cmd.type, options?.localEdit);

    clonedProject.revision = project.value.revision + 1;
    project.value = clonedProject;
    currentTractParams.value = clonedTract;
    currentGlottisParams.value = clonedGlottis;
    if (currentMetrics.value.source !== 'vtl-engine') currentMetrics.value = computeAnalyticalMetrics(clonedTract);

    return { ok: true, revision: clonedProject.revision, label: cmd.label ?? cmd.type };
  };

  const undo = (): boolean => {
    const prev = undoStack.value[undoStack.value.length - 1];
    if (!prev) return false;
    redoStack.value = [...redoStack.value, { ...captureSnapshot(prev.label), localEdit: prev.localEdit }];
    undoStack.value = undoStack.value.slice(0, -1);
    restoreSnapshot(prev);
    prev.localEdit?.undo();
    pushToast(`已撤销：${prev.label}`, 'info', 2000);
    return true;
  };

  const commitAnnotationAudio = (buffer: AudioBuffer, label: string): void => {
    checkpointHistory(label);
    project.value.revision += 1;
    editedAnnotationAudio.value = buffer;
    annotationAudioBuffer.value = buffer;
    annotationAudioOffsetSmp.value = 0;
    lastAudioBuffer.value = buffer;
  };

  const redo = (): boolean => {
    const next = redoStack.value[redoStack.value.length - 1];
    if (!next) return false;
    undoStack.value = [...undoStack.value, { ...captureSnapshot(next.label), localEdit: next.localEdit }];
    redoStack.value = redoStack.value.slice(0, -1);
    restoreSnapshot(next);
    next.localEdit?.redo();
    pushToast(`已重做：${next.label}`, 'info', 2000);
    return true;
  };

  const previewProposal = (commands: WorkbenchCommand[]) => {
    const clonedProject = JSON.parse(JSON.stringify(project.value)) as VcProject;
    const clonedTract = { ...currentTractParams.value };
    const clonedGlottis = { ...currentGlottisParams.value };
    const res = applySingleCommandToState(clonedProject, clonedTract, clonedGlottis, {
      type: 'batch',
      payload: { commands },
    });
    if (!res.ok) return { ok: false, error: res.error, changes: [] };
    return { ok: true, changes: res.changes, draft: clonedProject };
  };

  const applyProposal = (commands: WorkbenchCommand[], label = '接受 AI 提案'): CommandExecResult => {
    return executeCommand({
      type: 'batch',
      label,
      payload: { commands },
    });
  };

  // Appearance Persistence & Sync
  const buildAppearanceConfig = (): AppearanceConfig => ({
    paletteId: paletteId.value,
    customAccentHex: customAccentHex.value,
    themeMode: themeMode.value,
    surfaceStyle: surfaceStyle.value,
    styleColorMode: styleColorMode.value,
    backdropId: backdropId.value,
    backdropColorScheme: backdropColorScheme.value,
    backdropCustomColors: [...backdropCustomColors.value],
    glassBlur: glassBlur.value,
    glassAlpha: glassAlpha.value,
    cardAlpha: cardAlpha.value,
    fonts: { ...interfaceFonts.value },
    fontDefaultVersion: 2,
    anatomy: { ...anatomyAppearance.value },
    surfaceOpacity: { ...surfaceOpacity.value, [surfaceStyle.value]: { panel: glassAlpha.value, card: cardAlpha.value } },
    bgBlur: bgBlur.value,
    bgVeil: bgVeil.value,
    bgSat: bgSat.value,
    bgSatAuto: bgSatAuto.value,
    bgCov: bgCov.value,
    waveformColorMode: waveformColorMode.value,
    waveformCustomHex: waveformCustomHex.value,
    overrides: { ...styleOverrides.value },
  });

  const applyLayoutAttributes = (): void => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.density = layoutDensity.value;
    document.documentElement.dataset.trackScale = timelineTrackScale.value;
    document.documentElement.dataset.aiDock = aiDrawerDockMode.value;
    document.documentElement.dataset.navPlacement = navPlacement.value;
    document.body?.classList.toggle('hide-splitters', !showSplitters.value);
  };

  const syncAppearance = (): void => {
    const cfg = buildAppearanceConfig();
    resolvedColorMode.value = applyAppearanceToRoot(cfg);
    applyLayoutAttributes();
    safeWriteJson(STORAGE_APPEARANCE_KEY, cfg);
  };

  const persistPrefs = (): void => {
    safeWriteJson(STORAGE_PREFS_KEY, {
      computeDevice: computeDevice.value,
      videoCodecMode: videoCodecMode.value,
      shortcutPreset: shortcutPreset.value,
      layoutDensity: layoutDensity.value,
      defaultTractViewMode: defaultTractViewMode.value,
      timelineTrackScale: timelineTrackScale.value,
      aiDrawerDockMode: aiDrawerDockMode.value,
      navPlacement: navPlacement.value,
      showSplitters: showSplitters.value,
      aiToolsModel: aiToolsModel.value,
      aiToolsBaseUrl: aiToolsBaseUrl.value,
      deepSeekAsrEnabled: deepSeekAsrEnabled.value,
      localWhisperModel: localWhisperModel.value,
    });
  };

  const persistSavedLooks = (next: SavedLooksState): void => {
    savedLooks.value = next;
    safeWriteJson(STORAGE_SAVED_LOOKS_KEY, next);
  };

  const captureCurrentLookSnapshot = (): SavedLookSnapshot => ({
    appearance: buildAppearanceConfig(),
    customBackgroundId: activeWorkspaceBackground.value?.id ?? null,
    layout: {
      density: layoutDensity.value,
      navPlacement: navPlacement.value,
      trackScale: timelineTrackScale.value,
      aiDockMode: aiDrawerDockMode.value,
      defaultTractViewMode: defaultTractViewMode.value,
      showSplitters: showSplitters.value,
      pageScale: pageScale.value,
      autoPageScale: autoPageScale.value,
    },
  });

  const applySavedLookSnapshot = (preset: SavedLookPreset, nextThemeMode?: ThemeMode): void => {
    const a = preset.appearance;
    const prevNav = navPlacement.value;
    themeMode.value = nextThemeMode ?? preset.mode;
    paletteId.value = normalizePalette(a.paletteId);
    if (typeof a.customAccentHex === 'string') customAccentHex.value = a.customAccentHex;
    surfaceStyle.value = normalizeSkinId(a.surfaceStyle);
    styleColorMode.value = a.styleColorMode === 'original' ? 'original' : 'current';
    backdropId.value = normalizeBackdropId(a.backdropId);
    if (typeof a.backdropColorScheme === 'string') backdropColorScheme.value = a.backdropColorScheme;
    if (Array.isArray(a.backdropCustomColors) && a.backdropCustomColors.length === 3) {
      backdropCustomColors.value = [a.backdropCustomColors[0], a.backdropCustomColors[1], a.backdropCustomColors[2]];
    }
    if (typeof a.glassBlur === 'number') glassBlur.value = a.glassBlur;
    surfaceOpacity.value = a.surfaceOpacity ? { ...a.surfaceOpacity } : {};
    cardAlpha.value = Number.isFinite(a.cardAlpha)
      ? Math.min(100, Math.max(15, a.cardAlpha!))
      : defaultsForStyle(surfaceStyle.value).card;
    glassAlpha.value = Number.isFinite(a.glassAlpha)
      ? Math.min(98, Math.max(16, a.glassAlpha))
      : defaultsForStyle(surfaceStyle.value).panel;
    interfaceFonts.value = normalizeInterfaceFonts(a.fonts);
    anatomyAppearance.value = normalizeAnatomyAppearance(a.anatomy);
    bgBlur.value = a.bgBlur === null || (typeof a.bgBlur === 'number' && Number.isFinite(a.bgBlur)) ? a.bgBlur : null;
    bgVeil.value = a.bgVeil === null || (typeof a.bgVeil === 'number' && Number.isFinite(a.bgVeil)) ? a.bgVeil : null;
    if (typeof a.bgSat === 'number' && Number.isFinite(a.bgSat)) bgSat.value = a.bgSat;
    bgSatAuto.value = a.bgSatAuto !== false;
    if (typeof a.bgCov === 'number' && Number.isFinite(a.bgCov)) bgCov.value = a.bgCov;
    if (a.waveformColorMode === 'theme' || a.waveformColorMode === 'blue' || a.waveformColorMode === 'custom') {
      waveformColorMode.value = a.waveformColorMode;
    }
    if (typeof a.waveformCustomHex === 'string') waveformCustomHex.value = a.waveformCustomHex;
    styleOverrides.value = a.overrides && typeof a.overrides === 'object' ? { ...a.overrides } : {};
    selectWorkspaceBackground(preset.customBackgroundId ?? null);

    layoutDensity.value = preset.layout.density;
    navPlacement.value = preset.layout.navPlacement;
    timelineTrackScale.value = preset.layout.trackScale;
    aiDrawerDockMode.value = preset.layout.aiDockMode;
    defaultTractViewMode.value = preset.layout.defaultTractViewMode;
    showSplitters.value = preset.layout.showSplitters;
    autoPageScale.value = preset.layout.autoPageScale;
    pageScale.value = applyPageScaleToRoot(
      preset.layout.autoPageScale ? computeAutoPageScale() : preset.layout.pageScale,
    );
    safeWriteJson(STORAGE_ZOOM_KEY, { scale: pageScale.value, auto: autoPageScale.value });

    activeSavedLookId.value = preset.id;
    syncAppearance();
    persistPrefs();
    if (prevNav !== navPlacement.value && typeof window !== 'undefined') {
      window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    }
  };

  const setThemeMode = (mode: ThemeMode, originEvent?: MouseEvent): void => {
    const next = normalizeMode(mode);
    if (next === themeMode.value) return;
    const nextResolved = resolveColorMode(next);
    const switchingPolarity = nextResolved !== resolvedColorMode.value;
    const defaultId = switchingPolarity ? savedLooks.value.defaultIds[nextResolved] : null;
    const defaultPreset = defaultId
      ? savedLooks.value[nextResolved].find((item) => item.id === defaultId) ?? null
      : null;
    runThemeViewTransition(() => {
      if (defaultPreset) {
        applySavedLookSnapshot(defaultPreset, next);
      } else {
        themeMode.value = next;
        syncAppearance();
      }
    }, originEvent);
  };

  const toggleColorMode = (originEvent?: MouseEvent): void => {
    const next: ColorMode = resolvedColorMode.value === 'dark' ? 'light' : 'dark';
    const defaultId = savedLooks.value.defaultIds[next];
    const defaultPreset = defaultId
      ? savedLooks.value[next].find((item) => item.id === defaultId) ?? null
      : null;
    runThemeViewTransition(() => {
      if (defaultPreset) {
        applySavedLookSnapshot(defaultPreset, next);
      } else {
        themeMode.value = next;
        syncAppearance();
      }
    }, originEvent);
  };

  const saveCurrentLook = (mode?: ColorMode, name?: string): boolean => {
    const targetMode: ColorMode = mode ?? resolvedColorMode.value;
    const skinName = getSkin(surfaceStyle.value)?.shortName ?? surfaceStyle.value;
    const palName = paletteShortName(paletteId.value);
    const autoName = name && name.trim() ? name.trim() : `${skinName} · ${palName}`;
    const result = saveLookPreset(
      savedLooks.value,
      targetMode,
      autoName,
      captureCurrentLookSnapshot(),
    );
    if (!result.ok) {
      pushToast(
        `${targetMode === 'dark' ? '夜间' : '日间'}默认搭配最多保存 ${result.max} 份，请先删除或覆盖已有方案`,
        'warning',
        2600,
      );
      return false;
    }
    persistSavedLooks(result.state);
    activeSavedLookId.value = result.preset.id;
    pushToast(`已保存${targetMode === 'dark' ? '夜间' : '日间'}搭配「${result.preset.name}」`, 'success', 2200);
    return true;
  };

  const applySavedLook = (mode: ColorMode, id: string, originEvent?: MouseEvent): boolean => {
    const preset = savedLooks.value[mode].find((item) => item.id === id);
    if (!preset) return false;
    runThemeViewTransition(() => {
      applySavedLookSnapshot(preset, mode);
    }, originEvent);
    pushToast(`已切换至「${preset.name}」`, 'info', 1800);
    return true;
  };

  const updateSavedLookFromCurrent = (mode: ColorMode, id: string, nextName?: string): boolean => {
    const exists = savedLooks.value[mode].find((item) => item.id === id);
    if (!exists) return false;
    const next = updateLookPreset(
      savedLooks.value,
      mode,
      id,
      captureCurrentLookSnapshot(),
      nextName,
    );
    persistSavedLooks(next);
    activeSavedLookId.value = id;
    pushToast(`已用当前布局与外观更新「${nextName?.trim() || exists.name}」`, 'success', 2000);
    return true;
  };

  const deleteSavedLook = (mode: ColorMode, id: string): void => {
    const target = savedLooks.value[mode].find((item) => item.id === id);
    if (!target) return;
    persistSavedLooks(deleteLookPreset(savedLooks.value, mode, id));
    if (activeSavedLookId.value === id) activeSavedLookId.value = null;
    pushToast(`已删除搭配「${target.name}」`, 'info', 1800);
  };

  const toggleDefaultSavedLook = (mode: ColorMode, id: string): void => {
    const target = savedLooks.value[mode].find((item) => item.id === id);
    if (!target) return;
    const isCurrentDefault = savedLooks.value.defaultIds[mode] === id;
    const next = setDefaultLookPreset(savedLooks.value, mode, isCurrentDefault ? null : id);
    persistSavedLooks(next);
    const label = mode === 'dark' ? '夜间' : '日间';
    pushToast(
      isCurrentDefault
        ? `已取消「${target.name}」的${label}默认身份`
        : `已将「${target.name}」设为${label}默认，切换明暗时自动生效`,
      'success',
      2400,
    );
  };

  const setPalette = (id: string): void => {
    paletteId.value = normalizePalette(id);
    syncAppearance();
  };

  const setCustomAccent = (hex: string): void => {
    customAccentHex.value = hex;
    paletteId.value = 'custom';
    syncAppearance();
  };

  const setStyleColorMode = (mode: StyleColorMode): void => {
    styleColorMode.value = mode;
    syncAppearance();
  };

  const setSurfaceStyle = (id: string): void => {
    surfaceOpacity.value = { ...surfaceOpacity.value, [surfaceStyle.value]: { panel: glassAlpha.value, card: cardAlpha.value } };
    surfaceStyle.value = normalizeSkinId(id);
    const originalPalette = originalSurfacePaletteId(surfaceStyle.value);
    if (styleColorMode.value === 'original' && originalPalette) {
      const opacity = defaultsForStyle(surfaceStyle.value);
      selectWorkspaceBackground(null);
      paletteId.value = originalPalette;
      backdropId.value = baseApp.backdropId;
      backdropColorScheme.value = baseApp.backdropColorScheme;
      backdropCustomColors.value = [...baseApp.backdropCustomColors];
      glassBlur.value = surfaceStyle.value === 'glass' ? 10 : baseApp.glassBlur;
      glassAlpha.value = opacity.panel;
      cardAlpha.value = opacity.card;
      bgBlur.value = null;
      bgVeil.value = null;
      bgSat.value = baseApp.bgSat;
      bgSatAuto.value = true;
      bgCov.value = baseApp.bgCov;
      styleOverrides.value = {};
    } else {
      const opacity = surfaceOpacity.value[surfaceStyle.value] ?? defaultsForStyle(surfaceStyle.value);
      glassAlpha.value = opacity.panel;
      cardAlpha.value = opacity.card;
      if (surfaceStyle.value === 'glass' && glassBlur.value < 10) {
        glassBlur.value = 10;
      }
    }
    syncAppearance();
  };

  const setBackdrop = (id: BackdropId): void => {
    selectWorkspaceBackground(null);
    backdropId.value = normalizeBackdropId(id);
    syncAppearance();
  };

  const setBackdropColorScheme = (schemeId: string): void => {
    backdropColorScheme.value = schemeId;
    const preset = BACKDROP_COLOR_PRESETS.find((p) => p.id === schemeId);
    if (preset && preset.colors) {
      backdropCustomColors.value = [preset.colors[0], preset.colors[1], preset.colors[2]];
    }
    syncAppearance();
  };

  const setBackdropCustomColors = (colors: [string, string, string]): void => {
    backdropColorScheme.value = 'custom';
    backdropCustomColors.value = [...colors];
    syncAppearance();
  };

  const setGlassBlur = (px: number): void => {
    glassBlur.value = Math.max(0, Math.min(22, Math.round(px)));
    if (styleOverrides.value.glassBlur !== undefined) {
      styleOverrides.value = { ...styleOverrides.value, glassBlur: glassBlur.value };
    }
    syncAppearance();
  };

  const setCardAlpha = (pct: number): void => {
    if (!Number.isFinite(pct)) return;
    cardAlpha.value = Math.max(15, Math.min(100, Math.round(pct)));
    syncAppearance();
  };

  const setInterfaceFonts = (patch: Partial<InterfaceFonts>): void => {
    interfaceFonts.value = normalizeInterfaceFonts({ ...interfaceFonts.value, ...patch });
    syncAppearance();
  };

  const setAnatomyAppearance = (patch: Partial<AnatomyAppearance>): void => {
    anatomyAppearance.value = normalizeAnatomyAppearance({ ...anatomyAppearance.value, ...patch });
    syncAppearance();
  };

  const setGlassAlpha = (pct: number): void => {
    glassAlpha.value = Math.max(16, Math.min(98, Math.round(pct)));
    if (styleOverrides.value.glassAlpha !== undefined) {
      styleOverrides.value = { ...styleOverrides.value, glassAlpha: glassAlpha.value };
    }
    syncAppearance();
  };

  const setBgSat = (pct: number): void => {
    if (!Number.isFinite(pct)) return;
    bgSat.value = Math.max(20, Math.min(220, Math.round(pct)));
    bgSatAuto.value = false;
    if (styleOverrides.value.bgSat !== undefined) {
      styleOverrides.value = { ...styleOverrides.value, bgSat: bgSat.value };
    }
    syncAppearance();
  };

  const setBackdropBlur = (px: number): void => {
    if (!Number.isFinite(px)) return;
    bgBlur.value = Math.max(0, Math.min(BACKDROP_BLUR_MAX_PX, Math.round(px)));
    syncAppearance();
  };

  const setBackdropVeil = (pct: number): void => {
    if (!Number.isFinite(pct)) return;
    bgVeil.value = Math.max(0, Math.min(BACKDROP_VEIL_MAX_PCT, Math.round(pct)));
    syncAppearance();
  };

  const resetBackdropTreatment = (): void => {
    bgBlur.value = null;
    bgVeil.value = null;
    bgSat.value = baseApp.bgSat;
    bgSatAuto.value = true;
    if (styleOverrides.value.bgSat !== undefined) {
      const overrides = { ...styleOverrides.value };
      delete overrides.bgSat;
      styleOverrides.value = overrides;
    }
    syncAppearance();
  };

  const setBgCov = (val: number): void => {
    bgCov.value = Math.max(0.35, Math.min(2.0, Number(val)));
    syncAppearance();
  };

  const setStyleOverrides = (patch: StyleOverrides): void => {
    styleOverrides.value = { ...styleOverrides.value, ...patch };
    syncAppearance();
  };

  const setWaveformAppearance = (mode: WaveformColorMode, customHex?: string): void => {
    waveformColorMode.value = mode;
    if (customHex) waveformCustomHex.value = customHex;
    syncAppearance();
  };

  const exportAppearanceJson = (): string => {
    return JSON.stringify(
      {
        schema: 'vocalcut/style-preset',
        version: 1,
        config: buildAppearanceConfig(),
      },
      null,
      2,
    );
  };

  const importAppearanceJson = (raw: string): boolean => {
    try {
      const parsed = JSON.parse(raw) as { config?: Partial<AppearanceConfig> } & Partial<AppearanceConfig>;
      const c = parsed.config ?? parsed;
      if (c.paletteId) paletteId.value = normalizePalette(c.paletteId);
      if (c.customAccentHex) customAccentHex.value = c.customAccentHex;
      if (c.themeMode) themeMode.value = normalizeMode(c.themeMode);
      if (c.surfaceStyle) surfaceStyle.value = normalizeSkinId(c.surfaceStyle);
      if (c.styleColorMode === 'current' || c.styleColorMode === 'original') styleColorMode.value = c.styleColorMode;
      if (c.backdropId) backdropId.value = normalizeBackdropId(c.backdropId);
      if (c.backdropColorScheme) backdropColorScheme.value = c.backdropColorScheme;
      if (Array.isArray(c.backdropCustomColors) && c.backdropCustomColors.length === 3) {
        backdropCustomColors.value = [c.backdropCustomColors[0], c.backdropCustomColors[1], c.backdropCustomColors[2]];
      }
      if (typeof c.glassBlur === 'number') glassBlur.value = c.glassBlur;
      if (c.surfaceOpacity) surfaceOpacity.value = Object.fromEntries(Object.entries(c.surfaceOpacity).filter(([,v]) =>
        v && Number.isFinite(v.panel) && v.panel >= 25 && v.panel <= 98 && Number.isFinite(v.card) && v.card >= 15 && v.card <= 100));
      cardAlpha.value = Number.isFinite(c.cardAlpha) ? Math.min(100, Math.max(15,c.cardAlpha!)) : defaultsForStyle(surfaceStyle.value).card;
      if (typeof c.glassAlpha === 'number') glassAlpha.value = c.glassAlpha;
      if (c.fonts) interfaceFonts.value = normalizeInterfaceFonts(c.fonts);
      if (c.anatomy) anatomyAppearance.value = normalizeAnatomyAppearance(c.anatomy);
      if (c.bgBlur === null || (typeof c.bgBlur === 'number' && Number.isFinite(c.bgBlur))) bgBlur.value = c.bgBlur;
      if (c.bgVeil === null || (typeof c.bgVeil === 'number' && Number.isFinite(c.bgVeil))) bgVeil.value = c.bgVeil;
      if (typeof c.bgSat === 'number' && Number.isFinite(c.bgSat)) {
        bgSat.value = c.bgSat;
        bgSatAuto.value = c.bgSatAuto ?? (c.bgSat === baseApp.bgSat);
      } else if (typeof c.bgSatAuto === 'boolean') {
        bgSatAuto.value = c.bgSatAuto;
      }
      if (typeof c.bgCov === 'number') bgCov.value = c.bgCov;
      if (c.waveformColorMode === 'theme' || c.waveformColorMode === 'blue' || c.waveformColorMode === 'custom') {
        waveformColorMode.value = c.waveformColorMode;
      }
      if (typeof c.waveformCustomHex === 'string') waveformCustomHex.value = c.waveformCustomHex;
      if (c.overrides && typeof c.overrides === 'object') styleOverrides.value = { ...c.overrides };
      syncAppearance();
      return true;
    } catch {
      return false;
    }
  };

  const resetAppearance = (): void => {
    selectWorkspaceBackground(null);
    const def = defaultAppearance();
    paletteId.value = def.paletteId;
    customAccentHex.value = def.customAccentHex;
    themeMode.value = def.themeMode;
    surfaceStyle.value = def.surfaceStyle;
    styleColorMode.value = 'current';
    backdropId.value = def.backdropId;
    backdropColorScheme.value = def.backdropColorScheme;
    backdropCustomColors.value = [...def.backdropCustomColors];
    glassBlur.value = def.glassBlur;
    surfaceOpacity.value = {};
    cardAlpha.value = defaultsForStyle(def.surfaceStyle).card;
    glassAlpha.value = defaultsForStyle(def.surfaceStyle).panel;
    interfaceFonts.value = normalizeInterfaceFonts();
    anatomyAppearance.value = normalizeAnatomyAppearance();
    bgBlur.value = null;
    bgVeil.value = null;
    bgSat.value = def.bgSat;
    bgSatAuto.value = true;
    bgCov.value = def.bgCov;
    waveformColorMode.value = def.waveformColorMode;
    waveformCustomHex.value = def.waveformCustomHex;
    styleOverrides.value = {};
    syncAppearance();
  };

  // Page Scale & Splitters
  const setPageScale = (scale: number, manual = true): void => {
    autoPageScale.value = !manual;
    pageScale.value = applyPageScaleToRoot(scale);
    safeWriteJson(STORAGE_ZOOM_KEY, { scale: pageScale.value, auto: autoPageScale.value });
  };

  const resetAutoPageScale = (): void => {
    autoPageScale.value = true;
    pageScale.value = applyPageScaleToRoot(computeAutoPageScale());
    safeWriteJson(STORAGE_ZOOM_KEY, { scale: pageScale.value, auto: true });
  };

  const setSplitterDefault = (storageKey: string, value: number): SetSplitterDefaultResult => {
    const result = setConfiguredSplitterDefault(storageKey, value);
    if (!result.ok) {
      pushToast(result.hint, 'warning', 2600);
      return result;
    }
    splitterLayoutVersion.value += 1;
    return result;
  };

  const resetAllSplitters = (): void => {
    resetAllSplittersToFactory();
    splitterLayoutVersion.value += 1;
    pushToast('已将全部工作区分栏恢复为出厂默认值', 'success', 2200);
  };

  const resetSingleSplitter = (storageKey: string): void => {
    resetSplitterToFactory(storageKey);
    splitterLayoutVersion.value += 1;
    pushToast('已将该分栏恢复为出厂默认值', 'info', 1800);
  };

  const resetSplitterGroup = (storageKeys: readonly string[], title?: string): void => {
    resetSplitterGroupToFactory(storageKeys);
    splitterLayoutVersion.value += 1;
    pushToast(title ? `已将「${title}」恢复为出厂默认值` : '已将该组分栏恢复为出厂默认值', 'success', 1800);
  };

  const setLayoutPrefs = (patch: Partial<{
    density: LayoutDensity;
    tractViewMode: '2d' | '3d';
    trackScale: TimelineTrackScale;
    aiDockMode: AiDrawerDockMode;
    navPlacement: NavPlacement;
    showSplitters: boolean;
  }>): void => {
    const placementChanged = patch.navPlacement !== undefined && patch.navPlacement !== navPlacement.value;
    if (patch.density) layoutDensity.value = patch.density;
    if (patch.tractViewMode) defaultTractViewMode.value = patch.tractViewMode;
    if (patch.trackScale) timelineTrackScale.value = patch.trackScale;
    if (patch.aiDockMode) aiDrawerDockMode.value = patch.aiDockMode;
    if (patch.navPlacement) navPlacement.value = patch.navPlacement;
    if (typeof patch.showSplitters === 'boolean') showSplitters.value = patch.showSplitters;
    applyLayoutAttributes();
    persistPrefs();
    if (placementChanged && typeof window !== 'undefined') {
      window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    }
  };

  const setComputeDevice = (_device: ComputeDevice): void => {
    computeDevice.value = 'wasm-cpu';
    project.value.settings.compute_device = 'wasm-cpu';
    persistPrefs();
  };

  // Credentials & Quota
  const setAiToolsCredentials = (baseUrl: string, apiKey: string, model?: string, deepSeekAsr?: boolean): void => {
    aiToolsBaseUrl.value = baseUrl.trim();
    aiToolsApiKey.value = apiKey.trim();
    if (model !== undefined) aiToolsModel.value = model.trim() || 'gpt-4o-mini';
    if (deepSeekAsr !== undefined) deepSeekAsrEnabled.value = deepSeekAsr;
    persistPrefs();
  };
  const setLocalWhisperModel = (model: WhisperModelId): void => {
    localWhisperModel.value = model;
    persistPrefs();
  };

  // Acoustic Engine & Playback
  let activeProbePromise: Promise<EngineStatus> | null = null;
  let activeMainSynthController: AbortController | null = null;
  let playbackSeq = 0;

  const probeEngine = (): Promise<EngineStatus> => {
    if (activeProbePromise) return activeProbePromise;
    engineStatus.value = 'checking';
    activeProbePromise = (async () => {
      const metaRes = await defaultVtlTransport.fetchMetaRaw(undefined, { timeoutMs: 4000 });
      if (metaRes.ok) {
        const meta = metaRes.value;
        engineMeta.value = (meta.metadata as Record<string, unknown>) ?? meta;
        engineStatus.value = 'python-vtl';
        void syncLocalModelsSilently();
        await requestVtlPose(currentTractParams.value);
        return 'python-vtl';
      }
      engineStatus.value = 'prewarm-fallback';
      return 'prewarm-fallback';
    })().finally(() => {
      activeProbePromise = null;
    });
    return activeProbePromise;
  };

  type PoseFetch = {
    input:PoseRequest;
    key:string;
    params: Record<TractParamName, number>;
    promise:Promise<Record<string,unknown>|null>;
    settle: (state: Record<string, unknown> | null) => void;
  };
  let activePoseFetch:PoseFetch|null=null;
  let pendingPoseFetch: PoseFetch | null = null;
  const mayPublishPose = (speaker: string) => !pendingPoseFetch || pendingPoseFetch.input.speaker === speaker;

  async function drainPoseFetches(): Promise<void> {
    try {
      while (pendingPoseFetch) {
        const job: PoseFetch = pendingPoseFetch;
        pendingPoseFetch = null;
        activePoseFetch=job;
        let state: Record<string, unknown> | null = null;
        const json = await resolveVtlPose(job.input);
        if (json) {
          state = (json.state as Record<string,unknown>) ?? json;
          if (mayPublishPose(job.input.speaker) && state !== currentTractState.value) {
            if (json.metadata && typeof json.metadata==='object') engineMeta.value=json.metadata as Record<string,unknown>;
            currentTractState.value=state;
            currentMetrics.value=metricsFromVtlSnapshot(state===json?state:{...json,...state},computeAnalyticalMetrics(job.params));
          }
        }
        job.settle(state);
      }
    } finally {
      activePoseFetch=null;
    }
  }

  const requestVtlPose = (
    params?: Partial<Record<TractParamName, number>>,
    speaker?: string,
    extras?: Partial<TractPoseExtras> | null,
    preview = false,
    rootGesture?:TongueRootGesture,
  ): Promise<Record<string, unknown> | null> => {
    const merged = { ...currentTractParams.value, ...params };
    const effExtras = cloneTractExtras({ ...currentTractExtras.value, ...extras });
    if (extras && !preview) currentTractExtras.value = effExtras;
    if (currentMetrics.value.source !== 'vtl-engine' || engineStatus.value === 'prewarm-fallback') {
      currentMetrics.value = computeAnalyticalMetrics(merged);
    }
    if (engineStatus.value === 'prewarm-fallback') return Promise.resolve(null);

    const activeVoice = project.value.voices[activeVoiceId.value];
    const input={ speaker:speaker??activeVoice?.speaker??'JD2',section_count:65,params:tractRecordToArray19(merged),...effExtras,tongue_root_drag:rootGesture };
    const key=vtlPoseKey(input);
    if(pendingPoseFetch?.key===key)return pendingPoseFetch.promise;
    pendingPoseFetch?.settle(null);
    pendingPoseFetch=null;
    if(activePoseFetch?.key===key)return activePoseFetch.promise;
    let settle!:PoseFetch['settle'];
    const promise=new Promise<Record<string,unknown>|null>(resolve=>{settle=resolve;});
    pendingPoseFetch={ input,key,params:merged,promise,settle };
    if(!activePoseFetch)void drainPoseFetches();
    return promise;
  };

  const applyIpaPose = async (symbol: string, speaker?: string): Promise<ResolvedPtbIpaPose> => {
    const activeVoice = project.value.voices[activeVoiceId.value];
    const spk = speaker ?? activeVoice?.speaker ?? 'JD2';
    const resolved = resolvePtbIpaPose(symbol, spk);
    currentTractParams.value = { ...resolved.params };
    currentTractExtras.value = cloneTractExtras(resolved.extras);
    await requestVtlPose(resolved.params, spk, resolved.extras);
    return resolved;
  };

  const synthesizeRange = async (opts: SynthesizeRangeOptions = {}): Promise<AudioBuffer | null> => {
    if (opts.signal?.aborted) return null;
    const isMainTrack = opts.cacheWaveform !== false;
    const generation = isMainTrack ? ++audioGeneration : audioGeneration;
    const mode = opts.mode ?? voiceRenderMode.value;
    const audioGain = opts.audioGain ?? synthesisGainMode.value;
    const ctx = ensureAudioContext();
    if (!ctx) return null;
    const synthController = new AbortController();
    const abortSynthesis = () => synthController.abort();
    opts.signal?.addEventListener('abort', abortSynthesis, { once: true });
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      synthController.abort();
    }, 90_000);
    if (isMainTrack) {
      activeMainSynthController?.abort();
      activeMainSynthController = synthController;
    }
    pendingSynthesisCount++;
    isSynthesizing.value = true;

    const mergedTract: Record<TractParamName, number> = {
      ...currentTractParams.value,
      ...(opts.tractParams ?? {}),
    };
    const mergedGlottis: GlottisM27Params = {
      ...currentGlottisParams.value,
      ...(opts.glottis ?? {}),
      ...(opts.f0Hz !== undefined ? { f0_hz: opts.f0Hz } : {}),
    };
    const tractExtras = opts.tractExtras ?? currentTractExtras.value;

    try {
      if (engineStatus.value === 'prewarm-fallback' || engineStatus.value === 'checking') await probeEngine();
      // Render through the selected local adapter.
      if (engineStatus.value === 'python-vtl') {
        const activeVoice = project.value.voices[activeVoiceId.value];
        const durationSec = (opts.durationMs ?? 620) / 1000;
        const stepHz = 50; // 48000 % 50 === 0 exact; matches 50 Hz frame rate
        const frames = Math.max(8, Math.round(durationSec * stepHz));
        const tractVec = tractRecordToArray19(mergedTract);
        const dropHz = Math.min(.06 * mergedGlottis.f0_hz, Math.max(0, mergedGlottis.f0_hz - 60));
        const f0Arr = Array.from({ length: frames }, (_, i) => opts.pitchAt ? opts.pitchAt(i / (frames - 1)) : Number((mergedGlottis.f0_hz - dropHz * i / frames).toFixed(2)));
        const prArr = Array.from({ length: frames }, (_, i) => {
          const u = i / Math.max(1, frames - 1);
          const env = u < 0.08 ? u / 0.08 : u > 0.88 ? (1 - u) / 0.12 : 1;
          return Number((mergedGlottis.pr_pa * Math.max(0.15, env)).toFixed(1));
        });
        const glottisRow = [
          mergedGlottis.xb_cm,
          mergedGlottis.xt_cm,
          mergedGlottis.ca_cm2,
          mergedGlottis.lag_rad,
          mergedGlottis.ra,
          mergedGlottis.ps,
          mergedGlottis.fl,
          mergedGlottis.shim,
        ];

        let body: Record<string,unknown> = {
            speaker: opts.speaker ?? activeVoice?.speaker ?? 'JD2',
            step_hz: stepHz,
            include_geometry:false,
            f0_hz: f0Arr,
            pressure_pa: prArr,
            tract_frames: Array.from({ length: frames }, () => tractVec),
            glottis_frames: Array.from({ length: frames }, () => glottisRow),
            lip_width_frames: Array.from({ length: frames }, () => tractExtras.lip_width),
            larynx_height_frames: Array.from({ length: frames }, () => tractExtras.larynx_height),
            manual_root: tractExtras.manual_root,
            tongue_shape: tractExtras.tongue_shape,
            lip_shape: tractExtras.lip_shape,
            shimmer: mergedGlottis.shim,
            flutter: mergedGlottis.fl,
            glottis: mergedGlottis,
        };
        const clip = opts.phrase ?? project.value.clips[opts.clipId ?? activeClipId.value];
        const startSmp = opts.annotation && clip ? Math.max(clip.start_smp, opts.startSmp ?? clip.start_smp) : 0;
        if (opts.annotation && clip) {
          const endSmp = Math.min(clip.end_smp, opts.endSmp ?? clip.end_smp);
          if (endSmp <= startSmp) return null;
          const sharedTimeline = !opts.phrase && clip.id === activeClipId.value;
          const controls = clip.annotation_controls;
          const sourceProject = sharedTimeline ? project.value : { ...project.value, f0_pins: controls?.f0_pins ?? [], vibrato: controls?.vibrato, perturbation: controls?.perturbation };
          const sourceAnchors = sharedTimeline ? phonationAnchors.value : Object.values(controls?.phonation_anchors ?? {}).sort((a,b) => a.t_smp - b.t_smp);
          const neutralFallbackTract = tractRecordToArray19(defaultTractParams());
          const plan = buildAnnotationSynthesis(sourceProject, clip, sourceAnchors, startSmp, endSmp, {
            f0Hz: mergedGlottis.f0_hz,
            tract: neutralFallbackTract,
            releaseTract: neutralFallbackTract,
            lipWidth: DEFAULT_TRACT_EXTRAS.lip_width,
            larynxHeight: DEFAULT_TRACT_EXTRAS.larynx_height,
          }, opts.referenceTrack, opts.ipaPoseSource, mode === 'neural' ? effectiveSpeakerBaseF0Hz.value : undefined);
          if (!plan.ok) {
            pushToast(plan.error.hint, 'warning');
            return null;
          }
          body = { ...plan.value, sample_count: endSmp - startSmp, return_control_track: opts.returnControlTrack ?? false };
        }
        body.synth_mode = mode;
        body.device = 'cpu';
        const spkWav = opts.speakerWavBase64 === undefined ? customSpeakerAudioBase64.value : opts.speakerWavBase64;
        if (mode === 'neural' && spkWav) {
          body.speaker_wav_base64 = spkWav;
        }

        // Streaming first-chunk playback for long (>4 s) neural or physical VTL synthesis
        const chain = opts.streamChain;
        const wantStream = Boolean(
          opts.streamPlay
          && (mode === 'neural' || mode === 'physical')
          && typeof body.sample_count === 'number'
          && (body.sample_count > 4 * SAMPLE_RATE_HZ || Boolean(chain)),
        );
        if (wantStream && opts.streamPlay) {
          const streamResp = await defaultVtlTransport.requestSynthesizeStream(
            { ...body, audio_gain: audioGain },
            { signal: synthController.signal },
          );
          if (generation !== audioGeneration || synthController.signal.aborted) return null;
          const streamCt = (streamResp.headers.get('content-type') ?? '').toLowerCase();
          if (streamResp.ok && streamCt.includes('application/x-ndjson') && streamResp.body) {
            let activeSeq: number;
            if (chain && chain.activeSeq !== 0) {
              activeSeq = chain.activeSeq;
            } else if (opts.streamPlay.shouldStreamPlay?.() === false) {
              activeSeq = -1;
              if (chain) chain.activeSeq = activeSeq;
            } else {
              stopPlayback();
              activeSeq = ++playbackSeq;
              if (chain) chain.activeSeq = activeSeq;
            }
            if (ctx.state === 'suspended') {
              try { await ctx.resume(); } catch { /* continue decoding */ }
            }
            const reader = streamResp.body.getReader();
            const decoder = new TextDecoder();
            let lineBuf = '';
            let totalSamples = Number(body.sample_count);
            let sampleRate: number = SAMPLE_RATE_HZ;
            let fullPcm: Float32Array<ArrayBuffer> | null = null;
            let details: SynthesisInfo = { mode, sourceBadge: voiceRenderLabels[mode], device: 'cpu' };
            let streamStartTime = chain ? chain.streamStartTime : 0;
            let startedAudio = chain ? chain.started : false;
            let prevGainNode: GainNode | null = chain ? chain.prevGainNode : null;
            let lastScheduledNode: AudioBufferSourceNode | null = chain ? chain.lastScheduledNode : null;
            let streamFinished = false;
            const windowOffsetSmp = chain ? chain.windowOffsetSmp : 0;
            let pendingWindowOverlap = chain?.windowOverlapSmp ?? 0;
            const streamOpts = opts.streamPlay;
            const baseGain = streamOpts.gain ?? 1;

            const processEvent = (evt: Record<string, unknown>): void => {
              if (generation !== audioGeneration || synthController.signal.aborted) return;
              const etype = evt.type;
              if (etype === 'meta') {
                totalSamples = typeof evt.total_samples === 'number' ? evt.total_samples : totalSamples;
                sampleRate = typeof evt.sample_rate_hz === 'number' ? evt.sample_rate_hz : SAMPLE_RATE_HZ;
                fullPcm = new Float32Array(Math.max(1, totalSamples));
                const m27Rows = Array.isArray(evt.m27_control_50hz_pa) ? (evt.m27_control_50hz_pa as number[][]) : undefined;
                const tractRows = Array.isArray(evt.tract_control_50hz) ? (evt.tract_control_50hz as number[][]) : undefined;
                const resolvedMode: VoiceRenderMode = evt.synth_mode === 'physical' ? 'physical' : mode;
                details = {
                  mode: resolvedMode,
                  sourceBadge: typeof evt.source_badge === 'string' ? evt.source_badge : details.sourceBadge,
                  recordedArticulation: evt.recorded_articulation as RecordedArticulationSpan[] | undefined,
                  protectedIpaPoses: evt.protected_ipa_poses as string[] | undefined,
                  device: 'cpu',
                  voiceProfile: typeof evt.voice_profile === 'string' ? evt.voice_profile : undefined,
                  articulationModel: typeof evt.articulation_model === 'string' ? evt.articulation_model : undefined,
                  articulationFrames50Hz: typeof evt.articulation_frames_50hz === 'number' ? evt.articulation_frames_50hz : undefined,
                  ignoredGeometryFields: Array.isArray(evt.ignored_geometry_fields) ? (evt.ignored_geometry_fields as string[]) : undefined,
                  articulationSource: body.articulation_source === 'reference' ? 'reference' : opts.annotation ? 'annotation' : undefined,
                  m27RowsPa: m27Rows,
                  tractFrames: synthesisTractFrames(tractRows, m27Rows, totalSamples),
                };
                if (details.tractFrames?.length) {
                  opts.onStreamTractFrames?.(details.tractFrames);
                }
                const missingArt = evt.missing_recorded_articulation as string[] | undefined;
                if (missingArt?.length) {
                  const symbols = missingArt.map((ipa) => '[' + ipa + ']').join('、');
                  pushToast(symbols + ' 暂无适用的动态参考，已按标注合成', 'warning', 4500);
                }
                return;
              }
              if (etype === 'chunk' && typeof evt.pcm_i16_b64 === 'string') {
                if (!fullPcm) fullPcm = new Float32Array(Math.max(1, totalSamples));
                const bin = atob(evt.pcm_i16_b64);
                const rawBytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) rawBytes[i] = bin.charCodeAt(i);
                const i16 = new Int16Array(rawBytes.buffer);
                const floats = new Float32Array(i16.length);
                for (let i = 0; i < i16.length; i++) floats[i] = i16[i] / 32768;

                const startSmpChunk = typeof evt.start_sample === 'number' ? evt.start_sample : 0;
                const overlapL = typeof evt.overlap_left_samples === 'number' ? evt.overlap_left_samples : 0;

                // Assemble into full buffer with cosine crossfade across overlap zone
                const copyLen = Math.min(floats.length, Math.max(0, fullPcm.length - startSmpChunk));
                if (overlapL > 0 && overlapL <= copyLen) {
                  for (let k = 0; k < overlapL; k++) {
                    const w = 0.5 * (1 - Math.cos((Math.PI * (k + 0.5)) / overlapL));
                    fullPcm[startSmpChunk + k] = fullPcm[startSmpChunk + k] * (1 - w) + floats[k] * w;
                  }
                  fullPcm.set(floats.subarray(overlapL, copyLen), startSmpChunk + overlapL);
                } else if (copyLen > 0) {
                  fullPcm.set(floats.subarray(0, copyLen), startSmpChunk);
                }

                // Schedule sample-accurate gapless Web Audio playback immediately if not stopped
                if (activeSeq === playbackSeq && streamOpts.shouldStreamPlay?.() !== false && floats.length > 0) {
                  const chunkBuf = ctx.createBuffer(1, floats.length, sampleRate);
                  chunkBuf.copyToChannel(floats, 0);
                  const src = ctx.createBufferSource();
                  src.buffer = chunkBuf;
                  const gNode = ctx.createGain();
                  src.connect(gNode);
                  if (streamOpts.voiceAutoGain) {
                    const bus = activeVoiceGainBus ??= { ...createVoicePlaybackBus(ctx), measured: false };
                    if (!bus.measured) {
                      const gain = measureVoicePlaybackGain([floats], sampleRate);
                      if (gain !== undefined) {
                        bus.input.gain.value = gain;
                        bus.measured = true;
                      }
                    }
                    gNode.connect(bus.input);
                  } else gNode.connect(ctx.destination);

                  if (!startedAudio) {
                    startedAudio = true;
                    streamStartTime = ctx.currentTime + 0.025;
                    if (chain) {
                      chain.started = true;
                      chain.streamStartTime = streamStartTime;
                    }
                    isPlaying.value = true;
                    const phStart = streamOpts.playheadStartSmp;
                    const totalDurSec = (chain ? chain.totalSamples : totalSamples) / sampleRate;
                    if (phStart !== undefined) {
                      playheadSmp.value = phStart;
                      const advance = () => {
                        if (activeSeq !== playbackSeq || !isPlaying.value) return;
                        const elapsed = Math.max(0, ctx.currentTime - streamStartTime);
                        playheadSmp.value = phStart + Math.round(Math.min(totalDurSec, elapsed) * SAMPLE_RATE_HZ);
                        if (elapsed < totalDurSec) {
                          playbackFrame = requestAnimationFrame(advance);
                        }
                      };
                      playbackFrame = requestAnimationFrame(advance);
                    }
                  }

                  const effectiveOverlap = overlapL > 0 ? overlapL : pendingWindowOverlap;
                  pendingWindowOverlap = 0;
                  const idealWhen = streamStartTime + (windowOffsetSmp + startSmpChunk) / sampleRate;
                  const when = Math.max(ctx.currentTime + 0.005, idealWhen);
                  if (effectiveOverlap > 0 && prevGainNode) {
                    const ovSec = effectiveOverlap / sampleRate;
                    prevGainNode.gain.setValueAtTime(baseGain, when);
                    prevGainNode.gain.linearRampToValueAtTime(0, when + ovSec);
                    gNode.gain.setValueAtTime(0, when);
                    gNode.gain.linearRampToValueAtTime(baseGain, when + ovSec);
                  } else {
                    gNode.gain.setValueAtTime(baseGain, when);
                  }
                  prevGainNode = gNode;
                  lastScheduledNode = src;
                  if (chain) {
                    chain.prevGainNode = gNode;
                    chain.lastScheduledNode = src;
                  }
                  activeStreamNodes.push(src);
                  src.onended = () => {
                    src.disconnect();
                    gNode.disconnect();
                    activeStreamNodes = activeStreamNodes.filter((n) => n !== src);
                    const doneNow = chain ? chain.finished : streamFinished;
                    const lastNodeNow = chain ? chain.lastScheduledNode : lastScheduledNode;
                    if (doneNow && activeSeq === playbackSeq && lastNodeNow === src) {
                      if (playbackFrame) cancelAnimationFrame(playbackFrame);
                      playbackFrame = 0;
                      isPlaying.value = false;
                      releaseVoiceGainBus(true);
                      streamOpts.onEnded?.();
                    }
                  };
                  src.start(when);
                }
                return;
              }
              if (etype === 'done') {
                if (!chain || chain.finalWindow) {
                  streamFinished = true;
                  if (chain) chain.finished = true;
                }
                details.modelMs = typeof evt.model_ms === 'number' ? evt.model_ms : details.modelMs;
                details.chunkStats = {
                  total_chunks: typeof evt.total_chunks === 'number' ? evt.total_chunks : 1,
                  cache_hits: typeof evt.cache_hits === 'number' ? evt.cache_hits : 0,
                  parallel_workers: typeof evt.parallel_workers === 'number' ? evt.parallel_workers : 1,
                  wall_ms: details.modelMs,
                };
                const doneNow = chain ? chain.finished : streamFinished;
                if (doneNow && activeSeq === playbackSeq && activeStreamNodes.length === 0 && isPlaying.value) {
                  if (playbackFrame) cancelAnimationFrame(playbackFrame);
                  playbackFrame = 0;
                  isPlaying.value = false;
                  releaseVoiceGainBus(true);
                  streamOpts.onEnded?.();
                }
              }
            };

            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              lineBuf += decoder.decode(value, { stream: true });
              let nl = lineBuf.indexOf('\n');
              while (nl >= 0) {
                const rawLine = lineBuf.slice(0, nl).trim();
                lineBuf = lineBuf.slice(nl + 1);
                if (rawLine) {
                  try {
                    processEvent(JSON.parse(rawLine) as Record<string, unknown>);
                  } catch {
                    // Ignore malformed partial line
                  }
                }
                nl = lineBuf.indexOf('\n');
              }
            }
            const tailLine = (lineBuf + decoder.decode()).trim();
            if (tailLine) {
              try {
                processEvent(JSON.parse(tailLine) as Record<string, unknown>);
              } catch {
                // Ignore trailing fragment
              }
            }
            if (!chain || chain.finalWindow) {
              streamFinished = true;
              if (chain) chain.finished = true;
            }
            const finalPcm = fullPcm as Float32Array<ArrayBuffer> | null;
            if (finalPcm && generation === audioGeneration) {
              const assembled = ctx.createBuffer(1, finalPcm.length, sampleRate);
              assembled.copyToChannel(finalPcm, 0);
              if (audioGain === 'peak') applyPeakAudioGain(assembled);
              generatedVoiceModes.set(assembled, mode);
              generatedGainModes.set(assembled, audioGain);
              renderedSynthesisInfo.set(assembled, details);
              if (startedAudio && activeSeq === playbackSeq) streamPlayedBuffers.add(assembled);
              if (opts.cacheWaveform !== false) {
                lastAudioBuffer.value = assembled;
                if (opts.annotation) {
                  annotationAudioOffsetSmp.value = startSmp;
                  annotationAudioBuffer.value = assembled;
                }
              }
              return assembled;
            }
            return null;
          }
          if (!streamResp.ok && streamResp.status !== 404) {
            const result = await streamResp.json().catch(() => null) as { hint?: string; error?: { hint?: string } } | null;
            pushToast(result?.error?.hint ?? result?.hint ?? (voiceRenderLabels[mode] + '未返回可播放的音频'), 'warning');
            return null;
          }
        }

        const synthRes = await defaultVtlTransport.requestSynthesizeRaw(
          { ...body, audio_gain: audioGain },
          { signal: synthController.signal },
        );
        if (generation !== audioGeneration) return null;
        if (synthRes.ok) {
          let arrayBuf: ArrayBuffer | null = null;
          let details: SynthesisInfo = { mode, sourceBadge: voiceRenderLabels[mode], device: mode === 'physical' ? 'cpu' : undefined };
          if (synthRes.value.kind === 'audio') {
            arrayBuf = synthRes.value.buffer;
          } else {
            const json = synthRes.value.data as { wav_base64?: string; state?: Record<string, unknown>;
              synth_mode?: VoiceRenderMode; source_badge?: string; device_effective?: string; voice_profile?: string; model_ms?: number;
              articulation_model?: string; articulation_frames_50hz?: number; ignored_geometry_fields?: string[];
              recorded_articulation?: RecordedArticulationSpan[]; missing_recorded_articulation?: string[];
              protected_ipa_poses?: string[];
              chunk_stats?: { total_chunks: number; cache_hits: number; parallel_workers: number; wall_ms?: number };
              m27_control_50hz_pa?: number[][]; tract_control_50hz?: number[][] };
            if (json.synth_mode && json.synth_mode !== mode) {
              pushToast('本地引擎返回的合成音源与选择不同，请核对引擎版本。', 'warning');
              return null;
            }
            details = {
              mode: json.synth_mode ?? mode, sourceBadge: json.source_badge ?? details.sourceBadge,
              recordedArticulation: json.recorded_articulation,
              protectedIpaPoses: json.protected_ipa_poses,
              device: json.device_effective === 'cuda' ? 'cuda' : json.device_effective === 'cpu' ? 'cpu' : details.device,
              voiceProfile: json.voice_profile, modelMs: json.model_ms,
              articulationModel: json.articulation_model,
              articulationFrames50Hz: json.articulation_frames_50hz,
              ignoredGeometryFields: json.ignored_geometry_fields,
              articulationSource: body.articulation_source === 'reference' ? 'reference' : opts.annotation ? 'annotation' : undefined,
              m27RowsPa: json.m27_control_50hz_pa,
              tractFrames: typeof body.sample_count === 'number'
                ? synthesisTractFrames(json.tract_control_50hz, json.m27_control_50hz_pa, body.sample_count) : undefined,
              chunkStats: json.chunk_stats,
            };
            if (json.missing_recorded_articulation?.length) {
              const symbols = json.missing_recorded_articulation.map(ipa => '[' + ipa + ']').join('、');
              pushToast(symbols + ' 暂无适用的动态参考，已按标注合成', 'warning', 4500);
            }
            if (json.state && generation === audioGeneration) currentTractState.value = json.state;
            if (json.wav_base64) {
              const bin = atob(json.wav_base64);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              arrayBuf = bytes.buffer;
            }
          }
          if (arrayBuf) {
            const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
            if (generation !== audioGeneration || (!opts.mode && mode !== voiceRenderMode.value)
              || (!opts.audioGain && audioGain !== synthesisGainMode.value)) return null;
            generatedVoiceModes.set(decoded, mode);
            generatedGainModes.set(decoded, audioGain);
            renderedSynthesisInfo.set(decoded, details);
            if (opts.cacheWaveform === false) return decoded;
            lastAudioBuffer.value = decoded;
            if (opts.annotation) {
              annotationAudioOffsetSmp.value = startSmp;
              annotationAudioBuffer.value = decoded;
            }
            return decoded;
          }
        } else {
          if (mode === 'neural' || !opts.prewarmAudioUrl) {
            pushToast(synthRes.error.hint || (voiceRenderLabels[mode]+'未返回可播放的音频'), 'warning');
            return null;
          }
        }
      }

      // 2. Try prewarm real VTL WAV if provided
      if (mode === 'physical' && opts.prewarmAudioUrl) {
        try {
          const resp = await fetch(opts.prewarmAudioUrl, { signal: synthController.signal });
          if (resp.ok) {
            const ab = await resp.arrayBuffer();
            const decoded = await ctx.decodeAudioData(ab);
            if (generation !== audioGeneration || (!opts.audioGain && audioGain !== synthesisGainMode.value)) return null;
            if (audioGain === 'peak') applyPeakAudioGain(decoded);
            generatedGainModes.set(decoded, audioGain);
            if (opts.cacheWaveform === false) return decoded;
            lastAudioBuffer.value = decoded;
            pushToast('正在试听预渲染参考样本', 'info');
            return decoded;
          }
        } catch {
          // No matching cached audio.
        }
      }

      if (generation !== audioGeneration || (synthController.signal.aborted && !timedOut)) return null;
      pushToast(voiceRenderLabels[mode]+'未连接到本地引擎（8765）。引擎启动后再次点击试听即可重连。', 'warning');
      return null;
    } catch (err) {
      if (generation !== audioGeneration) return null;
      if (timedOut) {
        pushToast(voiceRenderLabels[mode] + '合成请求超时（>90 秒），请缩减选区或切换设备后重试。', 'warning');
        return null;
      }
      if (synthController.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return null;
      pushToast('无法读取'+voiceRenderLabels[mode]+'结果，请检查本地引擎连接。', 'warning');
      return null;
    } finally {
      window.clearTimeout(timeoutId);
      opts.signal?.removeEventListener('abort', abortSynthesis);
      if (activeMainSynthController === synthController) activeMainSynthController = null;
      isSynthesizing.value = --pendingSynthesisCount > 0;
    }
  };

  const stopPlayback = (): void => {
    playbackSeq++;
    streamPlayedBuffers = new WeakSet<AudioBuffer>();
    releaseVoiceGainBus();
    if (playbackFrame) cancelAnimationFrame(playbackFrame);
    playbackFrame = 0;
    if (activeSourceNode) {
      try {
        activeSourceNode.stop();
        activeSourceNode.disconnect();
      } catch {
        // already stopped
      }
      activeSourceNode = null;
    }
    if (activeStreamNodes.length) {
      const nodes = activeStreamNodes;
      activeStreamNodes = [];
      for (const node of nodes) {
        try {
          node.stop();
          node.disconnect();
        } catch {
          // already stopped
        }
      }
    }
    isPlaying.value = false;
  };

  const clearAnnotationAudio = (): void => {
    ++audioGeneration;
    activeMainSynthController?.abort();
    activeMainSynthController = null;
    ++annotationResetVersion.value;
    stopPlayback();
    lastAudioBuffer.value = null;
    annotationAudioBuffer.value = null;
    editedAnnotationAudio.value = null;
    annotationTractFrames.value = [];
    annotationAudioOffsetSmp.value = 0;
    lastAudioUrl.value = null;
    selectedPhonationAnchorId.value = null;
  };

  const playAudioBuffer = async (buf?: AudioBuffer | null, opts: PlayAudioOptions = {}): Promise<void> => {
    const seq = ++playbackSeq;
    const target = buf ?? lastAudioBuffer.value ?? (await synthesizeRange());
    if (seq !== playbackSeq) return;
    const ctx = ensureAudioContext();
    if (!target || !ctx) return;

    stopPlayback();
    const activeSeq = ++playbackSeq;
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        return;
      }
    }
    if (activeSeq !== playbackSeq) return;

    const src = ctx.createBufferSource();
    src.buffer = target;
    src.playbackRate.value = opts.playbackRate ?? 1.0;

    const gainNode = ctx.createGain();
    gainNode.gain.value = opts.gain ?? 1;

    src.connect(gainNode);
    if (opts.voiceAutoGain) {
      const bus = activeVoiceGainBus = { ...createVoicePlaybackBus(ctx), measured: true };
      bus.input.gain.value = voicePlaybackGain(target);
      gainNode.connect(bus.input);
    } else gainNode.connect(ctx.destination);
    activeSourceNode = src;
    isPlaying.value = true;
    const playheadStart = opts.playheadStartSmp;
    const playbackStartTime = ctx.currentTime;
    const duration = Math.min(opts.durationSeconds ?? target.duration, target.duration - (opts.offsetSeconds ?? 0));
    if (playheadStart !== undefined) {
      playheadSmp.value = playheadStart;
      const advance = () => {
        if (activeSourceNode !== src) return;
        const elapsed = (ctx.currentTime - playbackStartTime) * src.playbackRate.value;
        playheadSmp.value = playheadStart + Math.round(Math.min(duration, elapsed) * SAMPLE_RATE_HZ);
        playbackFrame = requestAnimationFrame(advance);
      };
      playbackFrame = requestAnimationFrame(advance);
    }

    src.onended = () => {
      src.disconnect();
      gainNode.disconnect();
      if (activeSourceNode === src) {
        if (playbackFrame) cancelAnimationFrame(playbackFrame);
        playbackFrame = 0;
        activeSourceNode = null;
        isPlaying.value = false;
        releaseVoiceGainBus(true);
        opts.onEnded?.();
      }
    };
    if (opts.durationSeconds !== undefined) {
      src.start(0, opts.offsetSeconds ?? 0, opts.durationSeconds);
    } else {
      src.start(0, opts.offsetSeconds ?? 0);
    }
  };

  // Navigation & Project I/O
  const setWorkspace = (ws: WorkspaceId): void => {
    activeWorkspace.value = ws === 'explore' && !exploreLabel ? initialWorkspace : ws;
    activeOverlay.value = 'none';
    activeModuleGuide.value = null;
  };

  const openOverlay = (overlay: OverlayViewId, subTab?: SettingsTabId): void => {
    activeModuleGuide.value = null;
    if (subTab) settingsTab.value = subTab;
    activeOverlay.value = overlay;
  };

  const closeOverlay = (): void => {
    activeOverlay.value = 'none';
  };

  const openModuleGuide = (moduleId: GuideModuleId): void => {
    activeModuleGuide.value = moduleId;
  };

  const closeModuleGuide = (): void => {
    activeModuleGuide.value = null;
  };

  const openGuideSection = (sectionId?: string): void => {
    activeModuleGuide.value = null;
    activeOverlay.value = 'guide';
    guideTargetSection.value = sectionId ?? null;
  };

  const openExportModal = (ws: WorkspaceId, arrangement?: ArrangerExportSource): void => {
    arrangerExportSource.value = arrangement;
    exportModalWorkspace.value = ws;
  };

  const closeExportModal = (): void => {
    exportModalWorkspace.value = null;
    arrangerExportSource.value = undefined;
  };

  const exportProjectJson = (): string => JSON.stringify(project.value, null, 2);

  const importProjectJson = (raw: string): CommandExecResult => {
    try {
      const parsed = JSON.parse(raw) as VcProject;
      const res = executeCommand({
        type: 'project.replace',
        label: `导入工程 ${parsed.name ?? ''}`,
        payload: { project: parsed },
      });
      if (res.ok) {
        stopPlayback();
        playheadSmp.value = 0;
        selectedSyllableId.value = '';
        selectedPhonemeIds.value = [];
        activeClipId.value = project.value.clip_order[0] ?? activeClipId.value;
        activeVoiceId.value = project.value.voice_order[0] ?? activeVoiceId.value;
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('vocalcut:project-imported'));
        pushToast(`已导入工程：${project.value.name}`, 'success');
      }
      return res;
    } catch {
      const err: CoreErrorDetail = { code: 'validation_error', hint: 'JSON 解析失败，请检查 .vcproj 文件' };
      pushToast(err.hint, 'danger');
      return { ok: false, revision: project.value.revision, error: err };
    }
  };

  // Initial sync + window resize / Ctrl+Wheel guard + Style Lab global backdoor
  syncAppearance();
  pageScale.value = applyPageScaleToRoot(pageScale.value);

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
      viewportWidth.value = window.innerWidth;
      if (autoPageScale.value) {
        pageScale.value = applyPageScaleToRoot(computeAutoPageScale());
      }
    });

    // Guard Ctrl+Wheel page zoom (reserve for timeline / plot zoom per 02-ui-spec §3.3)
    window.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey) e.preventDefault();
      },
      { passive: false, capture: true },
    );

    // Watch OS color scheme when themeMode === 'system'
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (themeMode.value === 'system') syncAppearance();
    });

    // Mount window.__VC_STYLE__ backdoor API
    mountStyleBackdoor({
      listSkins,
      listBackdrops,
      listPalettes: () => palettes.map((p) => ({ id: p.id, name: p.name })),
      setStyle: (id) => setSurfaceStyle(id),
      setBackdrop: (id) => setBackdrop(id),
      setPalette: (id) => setPalette(id),
      setTheme: (mode) => setThemeMode(mode),
      setBlur: (px) => setGlassBlur(px),
      setOverrides: (ov) => setStyleOverrides(ov),
      registerSkin: (id, label, vars, desc, darkVars) => {
        const def = registerSkin(id, label, vars, desc, darkVars);
        customSkinCounter.value += 1;
        return def;
      },
      exportJson: exportAppearanceJson,
      importJson: importAppearanceJson,
      openLab: (open = true) => {
        styleLabOpen.value = open;
      },
      reset: resetAppearance,
    });
  }

  return {
    project,
    revision,
    activeVoiceId,
    activeClipId,
    activeArrangerClipId,
    activeWorkspace,
    researchTab,
    studioTab,
    activeOverlay,
    activeModuleGuide,
    guideTargetSection,
    settingsTab,
    aiDrawerOpen,
    styleLabOpen,
    referencesModalOpen,
    exportModalWorkspace,
    arrangerExportSource,
    computeDevice,
    videoCodecMode,
    shortcutPreset,
    layoutDensity,
    defaultTractViewMode,
    timelineTrackScale,
    aiDrawerDockMode,
    navPlacement,
    customSpeakerAudioBase64,
    customSpeakerName,
    themeMode,
    resolvedColorMode,
    paletteId,
    customAccentHex,
    activePalette,
    accentPickerColor,
    surfaceStyle,
    styleColorMode,
    backdropId,
    backdropColorScheme,
    backdropCustomColors,
    backdropActiveColors,
    glassBlur,
    glassAlpha,
    cardAlpha,
    interfaceFonts,
    anatomyAppearance,
    backdropTreatment,
    backdropVeilPct,
    backdropTreatmentAutomatic,
    savedLooks,
    activeSavedLookId,
    bgCov,
    waveformColorMode,
    waveformCustomHex,
    styleOverrides,
    customSkinCounter,
    pageScale,
    autoPageScale,
    viewportWidth,
    showSplitters,
    splitterLayoutVersion,
    selectedSyllableId,
    selectedPhonemeIds,
    playheadSmp,
    isPlaying,
    durationSmp,
    phonationAnchors,
    selectedPhonationAnchorId,
    engineStatus,
    engineMeta,
    currentTractState,
    currentTractParams,
    currentTractExtras,
    currentGlottisParams,
    currentMetrics,
    lastAudioUrl,
    lastAudioBuffer,
    annotationAudioBuffer,
    annotationAudioOffsetSmp,
    annotationResetVersion,
    editedAnnotationAudio,
    annotationTractFrames,
    commitAnnotationAudio,
    clearAnnotationAudio,
    abVersion,
    isSynthesizing,
    aiToolsModel,
    aiToolsBaseUrl,
    aiToolsApiKey,
    deepSeekAsrEnabled,
    localWhisperModel,
    toasts,
    canUndo,
    canRedo,
    undoCount,
    redoCount,
    executeCommand,
    checkpointHistory,
    getRestorableAssetIds,
    undo,
    redo,
    previewProposal,
    applyProposal,
    syncAppearance,
    setThemeMode,
    toggleColorMode,
    setPalette,
    setCustomAccent,
    setSurfaceStyle,
    setStyleColorMode,
    setBackdrop,
    setBackdropColorScheme,
    setBackdropCustomColors,
    setGlassBlur,
    setGlassAlpha,
    setCardAlpha,
    setInterfaceFonts,
    setAnatomyAppearance,
    setBgSat,
    setBackdropBlur,
    setBackdropVeil,
    resetBackdropTreatment,
    setBgCov,
    setStyleOverrides,
    setWaveformAppearance,
    exportAppearanceJson,
    importAppearanceJson,
    resetAppearance,
    saveCurrentLook,
    applySavedLook,
    updateSavedLookFromCurrent,
    deleteSavedLook,
    toggleDefaultSavedLook,
    setPageScale,
    resetAutoPageScale,
    setSplitterDefault,
    resetAllSplitters,
    resetSingleSplitter,
    resetSplitterGroup,
    setLayoutPrefs,
    setComputeDevice,
    setAiToolsCredentials,
    setLocalWhisperModel,
    probeEngine,
    requestVtlPose,
    applyIpaPose,
    synthesizeRange,
    synthesisInfo: buffer => renderedSynthesisInfo.get(buffer),
    registerCombinedAudio: (buffer, info, regOpts) => {
      if (regOpts?.applyPeakGain) applyPeakAudioGain(buffer);
      if (regOpts?.mode) generatedVoiceModes.set(buffer, regOpts.mode);
      if (regOpts?.audioGain) generatedGainModes.set(buffer, regOpts.audioGain);
      renderedSynthesisInfo.set(buffer, info);
      if (regOpts?.streamPlayed) streamPlayedBuffers.add(buffer);
    },
    wasStreamPlayed: buffer => streamPlayedBuffers.has(buffer),
    consumeStreamPlayed: buffer => {
      if (!streamPlayedBuffers.has(buffer)) return false;
      streamPlayedBuffers.delete(buffer);
      return true;
    },
    markStreamPlayed: buffer => { streamPlayedBuffers.add(buffer); },
    playAudioBuffer,
    stopPlayback,
    setWorkspace,
    openOverlay,
    closeOverlay,
    openModuleGuide,
    closeModuleGuide,
    openGuideSection,
    openExportModal,
    closeExportModal,
    pushToast,
    dismissToast,
    exportProjectJson,
    importProjectJson,
  };
}

export function useWorkbenchStore(): WorkbenchStore {
  if (!singletonStore) {
    singletonStore = createWorkbenchStore();
  }
  return singletonStore;
}

export { DEFAULT_TRACT_EXTRAS, SAMPLE_RATE_HZ, cloneTractExtras };

export type {
  ComputeDevice,
  GlottisM27Params,
  PhonationAnchor,
  PhonationRegime,
  ResolvedPtbIpaPose,
  TractDelta,
  TractParamName,
  TractPoseExtras,
  VcProject,
};
