<script setup lang="ts">
import '@/styles/acoustic-charts.css';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { SAMPLE_RATE_HZ, parseTextGrid, type TextGridDocument } from '@vocalcut/core';
import { M27Adapter, type M27AnimFrame, type M27TrajectoryAnim } from '@vocalcut/model-adapters';
import { defaultTractParams, tractRecordToArray19, useWorkbenchStore } from '@/stores/workbench';
import {
  drawM27GlottisCanvas,
  getM27GlottisVisHz,
  interpM27AnimState,
  readThemePalette,
  renderM27TractSvg,
} from '@/vendor/m27-tract-studio/tract-renderer.js';
import CustomSelect, { type SelectOption } from '@/components/common/CustomSelect.vue';
import CompactSlider from '@/components/common/CompactSlider.vue';
import { getActiveSplitterValue } from '@/data/splitter-layout';
import VoiceRenderSelect from '@/components/common/VoiceRenderSelect.vue';
import { applyPeakAudioGain, normalizeAudioFile, synthesisGainMode, voiceRenderLabels, voiceRenderMode } from '@/data/voice-renderer';
import IconSvg from '@/components/common/IconSvg.vue';
import ModuleGuideButton from '@/components/guide/ModuleGuideButton.vue';
import SplitPane from '@/components/common/SplitPane.vue';
import { audioBufferFile, sendWorkspaceAudio, takeWorkspaceAudio, type AudioDestination } from '@/data/workspace-transfer';
import { denoiseFile } from '@/data/denoise';
import { clipFromTextGrid, readTextGridFile } from '@/data/textgrid-alignment';
import { fetchOnboardingAudioFile, ONBOARDING_AUDIO_SLOTS } from '@/data/onboarding-samples';
import { isDeepSeekApiBase } from '@/data/deepseek';
import ReconstructionAlignment from './ReconstructionAlignment.vue';
import ReconstructionMicControl from './ReconstructionMicControl.vue';
import ReconstructionTranscriptionActions from './ReconstructionTranscriptionActions.vue';
import AudioRecordPrepModal, { type AudioRecordPrepResult } from './AudioRecordPrepModal.vue';
import { fallbackAlignmentGrid } from './alignment-boundaries';
import {
  prepareReconstructionCut,
  type ReconstructionCutMedia,
  type ReconstructionCutSnapshot,
} from './reconstruction-cut';
import { useReconstructionMicMonitor } from './reconstruction-mic-monitor';
import { requestTranscription } from './reconstruction-transcription';
import { useLocalAsrSetup } from './reconstruction-asr-setup';
import {
  DEFAULT_REALTIME_DELAY_MS,
  M27RealtimeController,
  REALTIME_DELAY_TARGETS_MS,
  decodeTract3DFrame,
  encodeFloat32ToWavFile,
  prepareRealtimeSpeakerReference,
  warmUpRealtimeModels,
  type DecodedTract3DFrame,
  type RealtimeDelayTargetMs,
  type RealtimeMetrics,
  type RealtimeStepPayload,
} from './m27-realtime';
import LiveHead3DStage from './LiveHead3DStage.vue';
import {
  VOQS_BUILTIN_PRESET_DEFAULTS,
  isCreakyMixerPreset,
  isMixerPresetExperimental,
  mixerRequest,
  normalizeMixerPreset,
  type MixerMeta,
  type MixerPreset,
} from './voice-mixer';
import {
  loadReconstructionVoices,
  reconstructionVoices,
  saveReconstructionVoice,
} from '@/data/reconstruction-voices';
import {
  listReconstructionHistory,
  saveReconstructionHistory,
  type ReconstructionHistoryEntry,
  type ReconstructionVersion as Version,
} from '@/data/reconstruction-history';
import {
  RECORDED_IPA_SET_ID,
  duplicateActiveIpaPoseSet,
  ipaPoseSets,
  loadDefaultIpaPoses,
  saveIpaPoseToSet,
  selectIpaPoseSet,
  selectedIpaPoseSetId,
} from '@/data/ipa-pose-sets';
import {
  blobToBase64,
  encodeMonoWavBase64,
  m27ImportedEndpointA,
  m27ImportedEndpointB,
} from './research-utils';
import {
  M27_AXIS_WIDTH_PX,
  M27_MAX_ZOOM,
  M27_MIN_ZOOM,
  M27_WINDOW_MS_OPTIONS,
  M27_ZOOMS,
  MODAL_STATIC_GLOTTIS_STATE,
  cleanTextGridWordLabels,
  clearM27Outputs,
  m27Session,
  neutralJd2Anim,
  replaceM27Url,
  resetM27SessionSource,
  stripRedundantPinyin,
  updateLegacyReconstructionRest,
  type AuditionWindowMs,
} from './m27-session';

const store = useWorkbenchStore();
const adapter = new M27Adapter();

// Bind persistent module-level session refs (T-55)
const {
  sourceFile,
  originalSource,
  originalSourceUrl,
  sourceName,
  speakerFile,
  originalSpeaker,
  speakerChoice,
  voiceName,
  sourceReference,
  sourceTextGrid,
  sourceTextGridName,
  alignmentText,
  alignmentLang,
  alignmentMessage,
  historyId,
  historyStatus,
  rows,
  anim,
  currentDevice,
  outputs,
  urls,
  version,
  playheadSec,
  mediaDuration,
  speed,
  zoom,
  viewStartSec,
  selectionSec,
  cutUndo,
  auditionWindowMs,
  showLabels,
  vibMode,
  curveMode,
  status,
} = m27Session;

// DOM refs
const audio = ref<HTMLAudioElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const textGridInput = ref<HTMLInputElement | null>(null);
const speakerInput = ref<HTMLInputElement | null>(null);
const tractSvg = ref<SVGSVGElement | null>(null);
const atlas = ref<HTMLCanvasElement | null>(null);
const tracksCanvas = ref<HTMLCanvasElement | null>(null);
const tracksPlotWrap = ref<HTMLElement | null>(null);
const rightColEl = ref<HTMLElement | null>(null);

// Resizable 3-column layout backed by central splitter-layout defaults + session drag state
const leftColWidth = ref(getActiveSplitterValue('m27Cols.left', 284));
const rightColWidth = ref(getActiveSplitterValue('m27Cols.right', 380));
const rightAnatomyShare = ref(getActiveSplitterValue('m27Cols.anatomySplit', 52));

// Local transient UI states
const cleaningSource = ref(false);
const cleaningSpeaker = ref(false);
const normalizingSource = ref(false);
const aligning = ref(false);
const transcribing = ref(false);
const savingVoice = ref(false);
const working = ref(false);
const workingAction = ref<'reconstruct' | 'resynthesize' | 'arranger' | null>(null);
const acquiringMic = ref(false);
const recording = ref(false);
const micMonitor = useReconstructionMicMonitor();
const { elapsed: micElapsed, bars: micBars, quiet: micQuiet } = micMonitor;

// Reference speaker recording + unified post-record prep modal
const acquiringSpeakerMic = ref(false);
const recordingSpeaker = ref(false);
const speakerMicMonitor = useReconstructionMicMonitor();
const { elapsed: speakerMicElapsed, bars: speakerMicBars, quiet: speakerMicQuiet } = speakerMicMonitor;
let speakerRecorder: MediaRecorder | null = null;
let speakerMicGen = 0;

interface M27RecordPrepDraft {
  target: 'source' | 'speaker';
  file: File;
  originalFile: File;
  text: string;
  lang: 'auto' | 'zh' | 'en';
  grid: TextGridDocument | null;
  fromExisting: boolean;
}
const recordPrepDraft = shallowRef<M27RecordPrepDraft | null>(null);
const playing = ref(false);
const auditioningWindow = ref(false);
const cutting = ref(false);

// Realtime live vocal-tract reconstruction & neural voice synthesis state
const liveActive = ref(false);
const liveStarting = ref(false);
const liveTractGeometry = ref(true);
const liveHead3D = ref(false);
const liveCameraEnabled = ref(true);
const liveCameraId = ref('');
const liveUseTimbreModel = ref(true);
const liveSynthAudio = ref(true);
const liveDelayStorageKey = 'vocalcut.reconstruction.liveDelayTargetMs';
function readLiveDelayTarget(): RealtimeDelayTargetMs {
  try {
    const stored = Number(localStorage.getItem(liveDelayStorageKey));
    return REALTIME_DELAY_TARGETS_MS.find((target) => target === stored) ?? DEFAULT_REALTIME_DELAY_MS;
  } catch {
    return DEFAULT_REALTIME_DELAY_MS;
  }
}
const liveDelayTargetMs = ref(readLiveDelayTarget());
const liveKeepRecording = ref(false);
const liveSpeakerKey = ref('');
const liveSpeakerMedianF0Hz = ref<number | null>(null);
const liveSpeakerPitchMatch = ref(true);
const livePreparingSpeaker = ref(false);
const liveStaleEngineWarning = ref(false);
const liveError = ref('');

const DEFAULT_CREAK_IRREG_BY_ID: Readonly<Record<string, number>> = {
  creaky: 0.30,
  creak: 0.30,
  whispery_creaky: 0.30,
  creaky_falsetto: 0.30,
  whispery_creaky_falsetto: 0.30,
};

function buildFallbackPhonationPresets(): MixerPreset[] {
  return Object.entries(VOQS_BUILTIN_PRESET_DEFAULTS).map(([id, item]) => ({
    id,
    label: item.label,
    desc: item.desc,
    f0_shift_semitones: item.f0_shift_semitones,
    default_f0_coupling: item.default_f0_coupling,
    is_voiceless_target: id === 'whisper' || id === 'voiceless',
    supports_creak_irregularity: isCreakyMixerPreset({ id }),
    default_creak_irregularity: DEFAULT_CREAK_IRREG_BY_ID[id] ?? null,
    experimental: isMixerPresetExperimental({ id, builtin: true }),
    builtin: true,
    source9_phys_pa: item.source9_phys_pa,
  }));
}

const livePhonationPresets = shallowRef<MixerPreset[]>(buildFallbackPhonationPresets());
const livePhonationPresetId = ref<string>('none');
const livePhonationStrengthPct = ref<number>(85);
const livePhonationF0Coupling = ref<boolean>(false);
const livePhonationCreakIrregPct = ref<number>(30);

const liveMetrics = ref<RealtimeMetrics>({
  computeMs: 0,
  roundTripMs: 0,
  playbackDelayMs: null,
  playbackRestarts: 0,
  skippedInputMs: 0,
  f0Hz: 0,
  prPa: 0,
  voiced: false,
  silent: true,
  timbreStatus: 'idle',
  phonationPreset: 'none',
  engineSupportsPhonation: true,
  speakerF0Ratio: 1,
  speakerTargetF0Hz: null,
  levelRms: 0,
  elapsedSec: 0,
});
const liveMonitorCanvas = ref<HTMLCanvasElement | null>(null);
const liveMonitorPlotWrap = ref<HTMLElement | null>(null);
const liveMinF0 = ref(40);
const liveMaxF0 = ref(320);
const liveMaxPR = ref(1200);
const liveStateSnapshot = shallowRef<ReturnType<typeof interpM27AnimState>>(null);
const liveAnimSnapshot = shallowRef<M27TrajectoryAnim | null>(null);
const liveTract3DSnapshot = shallowRef<DecodedTract3DFrame | null>(null);
const liveLatestM27Row = shallowRef<number[] | null>(null);
let liveController: M27RealtimeController | null = null;
let liveStartAbort: AbortController | null = null;
let finishLiveHeadPreparation: (() => void) | null = null;
let liveAnimQueue: Array<{ anim: M27TrajectoryAnim; startedAt: number; durSec: number }> = [];
let liveAnimRaf = 0;
let liveTraceHistory: number[][] = []; // rolling last 250 frames (5s @ 50Hz) of 27-dim Pa rows
let liveSpeakerPrepToken = 0;

const liveTimbreStatusText = computed(() => {
  if (!liveUseTimbreModel.value) return '默认讲解声纹（未加载音色模型）';
  if (livePreparingSpeaker.value) return '正在提取参考声纹…';
  const st = liveMetrics.value.timbreStatus;
  if (st === 'reference-cached') return `目标参考声纹 · ${speakerLabel.value}`;
  if (st === 'live-input-locked') return '已锁定输入说话人声纹';
  if (st === 'lecture-default' || st === 'builtin-default') return '默认讲解声纹';
  if (st === 'warming-input') return '正在采集输入声纹…';
  return speakerFile.value ? `目标参考声纹 · ${speakerLabel.value}` : '待采集声纹';
});

const activeLivePhonationPreset = computed<MixerPreset | null>(() =>
  livePhonationPresetId.value === 'none'
    ? null
    : livePhonationPresets.value.find((item) => item.id === livePhonationPresetId.value) ?? null,
);

function formatLivePhonationOption(preset: MixerPreset, group: string): SelectOption<string> {
  const badgeMatch = preset.label.match(/\s*·\s*([^)）]+)[)）]\s*$/);
  const badge = badgeMatch?.[1]?.trim() || (!preset.builtin ? '自定' : preset.id === 'voiceless' ? '清' : undefined);
  const compactLabel = badgeMatch
    ? preset.label.replace(/\s*·\s*[^)）]+([)）])\s*$/, '$1').trim()
    : preset.label;
  return {
    value: preset.id,
    label: compactLabel,
    badge,
    group,
  };
}

const livePhonationOptions = computed<SelectOption<string>[]>(() => {
  const core: SelectOption<string>[] = [];
  const experimental: SelectOption<string>[] = [];
  const custom: SelectOption<string>[] = [];
  for (const preset of livePhonationPresets.value) {
    if (preset.supports_diplophonia || preset.id === 'diplophonia') continue;
    if (!preset.builtin) {
      custom.push(formatLivePhonationOption(preset, '自定义发声预设'));
    } else if (isMixerPresetExperimental(preset)) {
      experimental.push(formatLivePhonationOption(preset, '扩展 VoQS（实验）'));
    } else {
      core.push(formatLivePhonationOption(preset, '核心发声类型'));
    }
  }
  return [
    { value: 'none', label: '沿用原声发声', badge: '默认' },
    ...core,
    ...experimental,
    ...custom,
  ];
});

const activeLivePhonationShortLabel = computed(() => {
  const preset = activeLivePhonationPreset.value;
  if (!preset) return '原声';
  const shortName = preset.label.replace(/\s*[（(][^()（）]*[）)]\s*$/, '').trim() || preset.label;
  return `${shortName} ${Math.round(livePhonationStrengthPct.value)}%`;
});

const livePhonationIsCreaky = computed(() => isCreakyMixerPreset(activeLivePhonationPreset.value));

const livePhonationHasF0Option = computed(() => {
  const preset = activeLivePhonationPreset.value;
  if (!preset) return false;
  return Boolean(
    preset.default_f0_coupling ||
    (typeof preset.f0_target_hz === 'number' && preset.f0_target_hz > 0) ||
    Math.abs(preset.f0_shift_semitones) > 0.05,
  );
});

const livePhonationDefaultIrregPct = computed(() => {
  const preset = activeLivePhonationPreset.value;
  if (!preset) return 30;
  const raw = preset.default_creak_irregularity ?? DEFAULT_CREAK_IRREG_BY_ID[preset.id] ?? 0.30;
  return Math.round(Math.max(0, Math.min(1, raw)) * 100);
});

const showLiveSpeakerPitchMatch = computed(() =>
  !liveUseTimbreModel.value || getLiveSpeakerMode() !== 'input',
);

const liveTargetSpeakerF0Display = computed<number | null>(() => {
  if (!showLiveSpeakerPitchMatch.value) return null;
  if (!liveUseTimbreModel.value || getLiveSpeakerMode() === 'lecture') return 165;
  return liveSpeakerMedianF0Hz.value ?? liveMetrics.value.speakerTargetF0Hz;
});

function selectLivePhonationPreset(value: string | number) {
  const id = String(value);
  livePhonationPresetId.value = id;
  if (id === 'none') {
    livePhonationF0Coupling.value = false;
    liveStaleEngineWarning.value = false;
    return;
  }
  const preset = livePhonationPresets.value.find((item) => item.id === id);
  livePhonationF0Coupling.value = Boolean(preset?.default_f0_coupling);
  const rawIrreg = preset?.default_creak_irregularity ?? DEFAULT_CREAK_IRREG_BY_ID[id];
  if (typeof rawIrreg === 'number' && Number.isFinite(rawIrreg)) {
    livePhonationCreakIrregPct.value = Math.round(Math.max(0, Math.min(1, rawIrreg)) * 100);
  } else {
    livePhonationCreakIrregPct.value = 30;
  }
}

function selectLiveSpeaker(key: string | number) {
  if (!liveUseTimbreModel.value) {
    liveUseTimbreModel.value = true;
  }
  chooseSpeakerReference(key);
}

function triggerLiveSpeakerUpload() {
  if (!liveUseTimbreModel.value) {
    liveUseTimbreModel.value = true;
  }
  speakerInput.value?.click();
}

const audioEditBlocked = computed(() =>
  working.value || aligning.value || transcribing.value || cleaningSource.value ||
  cleaningSpeaker.value || normalizingSource.value || acquiringMic.value || recording.value ||
  liveActive.value || liveStarting.value,
);
const canEditAudio = computed(() => !!sourceFile.value && !cutting.value && !audioEditBlocked.value);
const CUT_UNDO_LIMIT = 8;

// T-04 Incoming m27Align dialog state
const incomingDialogOpen = ref(false);

// T-49 Assign current frame to IPA modal state
const assignModalOpen = ref(false);
const assignSymbol = ref('');
const assignSetId = ref(selectedIpaPoseSetId.value);
const newSchemeName = ref('声道重建提取构型');

const history = shallowRef<ReconstructionHistoryEntry[]>([]);
let historyWrites = Promise.resolve();
let unmounted = false;

const lectureVoice = 'jingjing-lecture';
const inputVoice = 'input';
const uploadedVoice = '__uploaded__';
const lectureLabel = '井井讲解音色';

const alignLangOptions = [
  { value: 'auto', label: '自动识别语种' },
  { value: 'zh', label: '普通话' },
  { value: 'en', label: '英语' },
] as const;

const liveDelayOptions = REALTIME_DELAY_TARGETS_MS.map((delay) => ({
  value: delay,
  label: `${(delay / 1000).toFixed(1)} 秒`,
}));

const auditionWindowOptions = M27_WINDOW_MS_OPTIONS.map((ms) => ({
  value: ms,
  label: `±${ms} ms`,
}));

// T-11: 'input' ("沿用输入音色") is strictly the first & default choice
const speakerOptions = computed(() => {
  const saved = reconstructionVoices.value.map((item) => ({ value: item.id, label: item.name }));
  const hasSavedChoice = saved.some((item) => item.value === speakerChoice.value);
  const uploaded = speakerFile.value && !hasSavedChoice
    ? [{ value: uploadedVoice, label: `临时参考音 · ${speakerFile.value.name}` }]
    : [];
  return [
    { value: inputVoice, label: '沿用输入音色' },
    { value: lectureVoice, label: lectureLabel },
    ...saved,
    ...uploaded,
  ];
});

const speakerLabel = computed(() => {
  if (speakerFile.value) return speakerFile.value.name;
  if (speakerChoice.value === lectureVoice) return lectureLabel;
  return '沿用输入音色';
});

const voiceRenderHint = computed(
  () => `适用于声道重建与轨迹重合成。神经重合成将使用上方所选目标音色「${speakerLabel.value}」。`,
);

const fixedTextGrid = computed(
  () => !!sourceTextGrid.value && !sourceTextGridName.value.startsWith('模型对齐'),
);

const chosenName: Record<Version, string> = {
  source: '输入原音',
  neural: '神经重合成',
  physical: '物理重合成',
};
const versions: Version[] = ['source', 'neural', 'physical'];
const selectedUrl = computed(() => urls.value[version.value]);

const hasResult = computed(() => rows.value.length > 0);
const decodedDur = ref(0);
const duration = computed(() =>
  Math.max(0, mediaDuration.value || decodedDur.value || anim.value?.duration_sec || rows.value.length / 50),
);
const totalTimelineSec = computed(() =>
  Math.max(0.05, duration.value, sourceTextGrid.value?.xmax ?? 0),
);

const clampedZoom = computed(() => Math.max(M27_MIN_ZOOM, Math.min(M27_MAX_ZOOM, zoom.value || 1)));
const viewSpanSec = computed(() => totalTimelineSec.value / clampedZoom.value);
const maxViewStartSec = computed(() => Math.max(0, totalTimelineSec.value - viewSpanSec.value));
const clampedViewStartSec = computed(() =>
  Math.max(0, Math.min(maxViewStartSec.value, viewStartSec.value || 0)),
);
const viewEndSec = computed(() => clampedViewStartSec.value + viewSpanSec.value);

const state = computed(() => interpM27AnimState(anim.value, playheadSec.value));
const activeRow = computed(() =>
  rows.value.length
    ? rows.value[Math.max(0, Math.min(rows.value.length - 1, Math.floor(playheadSec.value * 50)))]
    : undefined,
);
const interpolatedActiveRow = computed(() => {
  const list = rows.value;
  if (!list.length) return undefined;
  const pos = Math.max(0, Math.min(list.length - 1, playheadSec.value * 50));
  const lo = Math.floor(pos);
  const hi = Math.min(list.length - 1, lo + 1);
  const alpha = pos - lo;
  if (lo === hi || alpha < 1e-6) return list[lo];
  const r0 = list[lo];
  const r1 = list[hi];
  return r0.map((v, i) => v + ((r1[i] ?? v) - v) * alpha);
});

const phoneBoundaries = computed(() => {
  if (sourceTextGrid.value) {
    const tier = sourceTextGrid.value.tiers.find(
      (entry) =>
        entry.kind === 'IntervalTier' &&
        /phone|phoneme|segment|\bseg\b|ipa|音素|音标/i.test(entry.name),
    );
    return (tier?.kind === 'IntervalTier' ? tier.intervals : []).filter((entry) => entry.text.trim());
  }
  return (
    sourceReference.value?.phones.map((phone) => ({
      xmin: phone.start_s,
      xmax: phone.end_s,
      text: phone.label,
    })) ?? []
  );
});

const currentPhoneAtPlayhead = computed(() => {
  const t = playheadSec.value;
  const list = phoneBoundaries.value;
  const halfOpenHit = list.find(
    (iv) => t >= iv.xmin && t < iv.xmax && iv.text.trim() && iv.text.trim() !== 'sil',
  );
  if (halfOpenHit) return halfOpenHit.text.trim();
  const last = list.at(-1);
  if (last && Math.abs(t - last.xmax) <= 1e-6 && last.text.trim() && last.text.trim() !== 'sil') {
    return last.text.trim();
  }
  return '';
});

const uniqueAlignedPhones = computed(() => {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const iv of phoneBoundaries.value) {
    const sym = iv.text.trim();
    if (sym && sym !== 'sil' && sym !== 'sp' && !seen.has(sym)) {
      seen.add(sym);
      list.push(sym);
    }
  }
  return list.slice(0, 18);
});

// Full 27-dim parameter lanes (5 tract lanes = 17D, 4 glottis lanes = 10D) directly backed by 50 Hz `rows` (T-53)
type ChartColorToken = 'teal' | 'accent' | 'violet' | 'warning' | 'danger' | 'success';

interface ParamSeriesSpec {
  label: string;
  col: number;
  colorToken: ChartColorToken;
  min: number;
  max: number;
  dec: number;
  unit: string;
  dash?: number[];
  fillToken?: 'violet-bg' | 'teal-bg';
  fallback?: number;
}

interface ParamLaneSpec {
  id: string;
  group: 'tract' | 'glottis';
  name: string;
  unitLabel: string;
  topTick: string;
  botTick: string;
  hint: string;
  zeroVal?: number;
  zeroRange?: [number, number];
  series: ParamSeriesSpec[];
}

const LANE_HEIGHT_PX = 50;

function readSemanticChartColors(el: HTMLElement): Record<ChartColorToken | 'violet-bg' | 'teal-bg' | 'playhead', string> {
  const cs = getComputedStyle(el);
  const pick = (name: string) => cs.getPropertyValue(name).trim();
  const text = pick('--text');
  return {
    teal: pick('--teal') || text,
    accent: pick('--accent') || text,
    violet: pick('--violet') || text,
    warning: pick('--warning') || text,
    danger: pick('--danger') || text,
    success: pick('--success') || text,
    'violet-bg': pick('--violet-bg') || 'transparent',
    'teal-bg': pick('--teal-bg') || 'transparent',
    playhead: pick('--danger') || pick('--accent') || text,
  };
}

function buildParamLanes(
  minF0: number,
  maxF0: number,
  maxPR: number,
  mode: typeof curveMode.value,
): ParamLaneSpec[] {
  const all: ParamLaneSpec[] = [
    {
      id: 'hyoid-jaw',
      group: 'tract',
      name: '喉颌',
      unitLabel: '%',
      topTick: '100%',
      botTick: '0%',
      hint: '按各参数合法物理上下限归一化：HY (-6.0..-3.5 cm) · HX (0..1) · JA (-7..0°) · JX (-0.5..0 cm)',
      series: [
        { label: 'HY', col: 1, colorToken: 'teal', min: -6.0, max: -3.5, dec: 2, unit: 'cm', fallback: -4.75 },
        { label: 'HX', col: 0, colorToken: 'success', min: 0.0, max: 1.0, dec: 2, unit: '', dash: [4, 2], fallback: 0.55 },
        { label: 'JA', col: 3, colorToken: 'accent', min: -7.0, max: 0.0, dec: 2, unit: '°', fallback: -2.0 },
        { label: 'JX', col: 2, colorToken: 'violet', min: -0.5, max: 0.0, dec: 2, unit: 'cm', dash: [4, 2], fallback: -0.1 },
      ],
    },
    {
      id: 'lip-velum',
      group: 'tract',
      name: '唇腭',
      unitLabel: '%',
      topTick: '100%',
      botTick: '0%',
      hint: '按各参数合法物理上下限归一化：LD (-2..4 cm) · LP (-1..1) · VO (-0.1..1.5) · VS (0..1)',
      series: [
        { label: 'LD', col: 5, colorToken: 'accent', min: -2.0, max: 4.0, dec: 2, unit: 'cm', fallback: 0.55 },
        { label: 'LP', col: 4, colorToken: 'violet', min: -1.0, max: 1.0, dec: 2, unit: '', dash: [4, 2], fallback: 0 },
        { label: 'VO', col: 7, colorToken: 'teal', min: -0.1, max: 1.5, dec: 2, unit: '', fallback: -0.1 },
        { label: 'VS', col: 6, colorToken: 'warning', min: 0.0, max: 1.0, dec: 2, unit: '', dash: [4, 2], fallback: 0.5 },
      ],
    },
    {
      id: 'tongue-body',
      group: 'tract',
      name: 'TC/TB',
      unitLabel: 'cm',
      topTick: '+6.5',
      botTick: '-3.0',
      hint: '舌体与舌叶坐标共享物理刻度 (-3.0..+6.5 cm)：TCX · TCY · TBX · TBY',
      zeroVal: 0,
      zeroRange: [-3.0, 6.5],
      series: [
        { label: 'TCX', col: 8, colorToken: 'warning', min: -3.0, max: 6.5, dec: 2, unit: 'cm' },
        { label: 'TCY', col: 9, colorToken: 'danger', min: -3.0, max: 6.5, dec: 2, unit: 'cm' },
        { label: 'TBX', col: 12, colorToken: 'success', min: -3.0, max: 6.5, dec: 2, unit: 'cm', dash: [4, 2] },
        { label: 'TBY', col: 13, colorToken: 'accent', min: -3.0, max: 6.5, dec: 2, unit: 'cm', dash: [4, 2] },
      ],
    },
    {
      id: 'tongue-tip',
      group: 'tract',
      name: '舌尖',
      unitLabel: 'cm',
      topTick: '+7.5',
      botTick: '-3.0',
      hint: '舌尖前后与高低共享物理刻度 (-3.0..+7.5 cm)：TTX · TTY',
      zeroVal: 0,
      zeroRange: [-3.0, 7.5],
      series: [
        { label: 'TTX', col: 10, colorToken: 'danger', min: -3.0, max: 7.5, dec: 2, unit: 'cm', fallback: 3.5 },
        { label: 'TTY', col: 11, colorToken: 'violet', min: -3.0, max: 7.5, dec: 2, unit: 'cm' },
      ],
    },
    {
      id: 'tongue-side',
      group: 'tract',
      name: '舌侧',
      unitLabel: '比',
      topTick: '+1.0',
      botTick: '-1.0',
      hint: '三段舌侧形变共享比值刻度 (-1.0..+1.0)：TS1 (0..1) · TS2 (0..1) · TS3 (-1..1)',
      zeroVal: 0,
      zeroRange: [-1.0, 1.0],
      series: [
        { label: 'TS1', col: 14, colorToken: 'teal', min: -1.0, max: 1.0, dec: 2, unit: '' },
        { label: 'TS2', col: 15, colorToken: 'accent', min: -1.0, max: 1.0, dec: 2, unit: '', dash: [4, 2] },
        { label: 'TS3', col: 16, colorToken: 'warning', min: -1.0, max: 1.0, dec: 2, unit: '' },
      ],
    },
    {
      id: 'f0',
      group: 'glottis',
      name: 'F0',
      unitLabel: 'Hz',
      topTick: `${maxF0}`,
      botTick: `${minF0}`,
      hint: `基频真实刻度 (${minF0}..${maxF0} Hz)`,
      series: [
        { label: 'F0', col: 17, colorToken: 'warning', min: minF0, max: maxF0, dec: 0, unit: 'Hz', fallback: 120 },
      ],
    },
    {
      id: 'pr',
      group: 'glottis',
      name: 'PR',
      unitLabel: 'Pa',
      topTick: `${maxPR}`,
      botTick: '0',
      hint: `声门下肺压真实刻度 (0..${maxPR} Pa)`,
      series: [
        { label: 'PR', col: 18, colorToken: 'violet', min: 0, max: maxPR, dec: 0, unit: 'Pa', fillToken: 'violet-bg', fallback: 0 },
      ],
    },
    {
      id: 'glottis-geom',
      group: 'glottis',
      name: '声门',
      unitLabel: '%',
      topTick: '100%',
      botTick: '0%',
      hint: '按各参数合法物理上下限归一化：XB (-0.05..0.30 cm) · XT (-0.05..0.30 cm) · CA (-0.25..0.25 cm²) · LAG (0..3.14 rad)',
      series: [
        { label: 'XB', col: 19, colorToken: 'success', min: -0.05, max: 0.3, dec: 3, unit: 'cm' },
        { label: 'XT', col: 20, colorToken: 'accent', min: -0.05, max: 0.3, dec: 3, unit: 'cm' },
        { label: 'CA', col: 21, colorToken: 'violet', min: -0.25, max: 0.25, dec: 3, unit: 'cm²', dash: [4, 2] },
        { label: 'LAG', col: 22, colorToken: 'warning', min: 0.0, max: 3.1415, dec: 2, unit: 'rad', dash: [4, 2], fallback: 1.22 },
      ],
    },
    {
      id: 'glottis-dyn',
      group: 'glottis',
      name: '激励',
      unitLabel: '%',
      topTick: '100%',
      botTick: '0%',
      hint: '按各参数合法物理上下限归一化：RA (-1..1) · PS (-1..1) · FL (0..100%) · SHIM (0..100%)',
      series: [
        { label: 'RA', col: 23, colorToken: 'danger', min: -1.0, max: 1.0, dec: 2, unit: '' },
        { label: 'PS', col: 24, colorToken: 'teal', min: -1.0, max: 1.0, dec: 2, unit: '' },
        { label: 'FL', col: 25, colorToken: 'accent', min: 0.0, max: 100.0, dec: 0, unit: '%', dash: [4, 2], fallback: 25 },
        { label: 'SHIM', col: 26, colorToken: 'violet', min: 0.0, max: 100.0, dec: 0, unit: '%', dash: [4, 2], fallback: 0 },
      ],
    },
  ];

  if (mode === 'tract') return all.filter((l) => l.group === 'tract');
  if (mode === 'glottis') return all.filter((l) => l.group === 'glottis');
  return all;
}

const paramLanes = computed<ParamLaneSpec[]>(() => {
  const dataRows = rows.value;
  let minF0 = 40;
  let maxF0 = 320;
  let maxPR = 1200;
  for (let i = 0; i < dataRows.length; i++) {
    const f0 = dataRows[i][17];
    const pr = dataRows[i][18];
    if (Number.isFinite(f0) && f0 > 0 && f0 < minF0) minF0 = f0;
    if (Number.isFinite(f0) && f0 > maxF0) maxF0 = f0;
    if (Number.isFinite(pr) && pr > maxPR) maxPR = pr;
  }
  minF0 = minF0 < 40 ? Math.max(0, Math.floor(minF0 / 10) * 10) : 40;
  maxF0 = Math.ceil(maxF0 / 50) * 50;
  maxPR = Math.min(1600, Math.ceil(maxPR / 200) * 200);
  return buildParamLanes(minF0, maxF0, maxPR, curveMode.value);
});

const liveParamLanes = computed<ParamLaneSpec[]>(() =>
  buildParamLanes(liveMinF0.value, liveMaxF0.value, liveMaxPR.value, curveMode.value),
);

let alignmentRun = 0;
let speakerGeneration = 0;
let sourceGeneration = 0;
let requestGeneration = 0;
let captureGeneration = 0;
let cutGeneration = 0;
let auditionGeneration = 0;
let switchingVersionSeek: number | null = null;
let pendingSourceNormalization: Promise<void> | null = null;
let recorder: MediaRecorder | null = null;
let speechRec: { stop: () => void } | null = null;
let transcriptionRequest: AbortController | null = null;
let frameLoop = 0;
let observer: ResizeObserver | null = null;

// Dedicated Web Audio context & decoded cache for local ±windowMs audition (T-49)
let auditionCtx: AudioContext | null = null;
let auditionNode: AudioBufferSourceNode | null = null;
const decodedBlobCache = new WeakMap<Blob, Promise<AudioBuffer>>();

const safeReason = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function waitForSourceNormalization(): Promise<void> {
  if (pendingSourceNormalization) {
    try {
      await pendingSourceNormalization;
    } catch {
      // ignore normalization errors
    }
  }
}

function stopAuditionWindow() {
  auditionGeneration++;
  if (auditionNode) {
    try {
      auditionNode.onended = null;
      auditionNode.stop();
      auditionNode.disconnect();
    } catch {
      // ignore stopped node
    }
    auditionNode = null;
  }
  auditioningWindow.value = false;
}

function stopPlayback() {
  stopAuditionWindow();
  audio.value?.pause();
  playing.value = false;
  cancelAnimationFrame(frameLoop);
}

function clearOutputsLocal() {
  requestGeneration++;
  working.value = false;
  workingAction.value = null;
  stopPlayback();
  clearM27Outputs();
}

function stopSpeechRecognition() {
  if (speechRec) {
    try {
      speechRec.stop();
    } catch {
      // ignore
    }
    speechRec = null;
  }
}

function discardCapture() {
  captureGeneration++;
  acquiringMic.value = false;
  recording.value = false;
  micMonitor.stop();
  stopSpeechRecognition();
  if (recorder) {
    recorder.onstop = null;
    if (recorder.state !== 'inactive') recorder.stop();
    recorder.stream.getTracks().forEach((t) => t.stop());
    recorder = null;
  }
}

function resetSource(name: string) {
  discardCapture();
  stopPlayback();
  switchingVersionSeek = null;
  pendingSourceNormalization = null;
  normalizingSource.value = false;
  alignmentRun++;
  aligning.value = false;
  cancelTranscription();
  cleaningSource.value = false;
  cutGeneration++;
  cutting.value = false;
  decodedDur.value = 0;
  resetM27SessionSource(name);
  return ++sourceGeneration;
}

function rememberSource(newEntry = false) {
  if (!sourceFile.value || !originalSource.value) return;
  if (newEntry || !historyId.value) historyId.value = crypto.randomUUID();
  const item: ReconstructionHistoryEntry = {
    id: historyId.value,
    updated: Date.now(),
    name: sourceName.value,
    source: sourceFile.value,
    original: originalSource.value,
    version: version.value,
    speaker: speakerFile.value,
    originalSpeaker: originalSpeaker.value,
    speakerProfile: speakerChoice.value === lectureVoice ? lectureVoice : undefined,
    speakerChoiceId: speakerChoice.value,
    reference: sourceReference.value,
    textGrid: sourceTextGrid.value,
    textGridName: sourceTextGridName.value,
    alignmentText: alignmentText.value,
    alignmentLang: alignmentLang.value,
    rows: rows.value,
    animation: anim.value,
    device: currentDevice.value,
    ...outputs.value,
  };
  historyWrites = historyWrites.then(async () => {
    try {
      await saveReconstructionHistory(item);
      if (!unmounted) {
        history.value = [item, ...history.value.filter((entry) => entry.id !== item.id)];
      }
    } catch {
      if (!unmounted) historyStatus.value = '本地历史保存失败，请检查浏览器存储空间';
    }
  });
}

function openHistory(id: string) {
  const item = history.value.find((entry) => entry.id === id);
  if (!item) return;
  resetSource(item.name);
  historyId.value = item.id;
  sourceFile.value = item.source;
  originalSource.value = item.original;
  sourceReference.value = item.reference;
  sourceTextGrid.value = item.textGrid ? cleanTextGridWordLabels(item.textGrid) : null;
  sourceTextGridName.value = item.textGridName;
  alignmentText.value = item.alignmentText ?? '';
  alignmentLang.value = item.alignmentLang ?? 'auto';
  const savedVoice = item.speakerChoiceId
    ? reconstructionVoices.value.find((voice) => voice.id === item.speakerChoiceId)
    : undefined;
  const restoredChoice =
    item.speakerProfile ??
    (savedVoice ? savedVoice.id : item.speaker ? uploadedVoice : inputVoice);
  setSpeaker(item.speaker, restoredChoice);
  if (savedVoice) voiceName.value = savedVoice.name;
  originalSpeaker.value = item.originalSpeaker;
  const restored = updateLegacyReconstructionRest(item.rows, item.animation);
  rows.value = restored.rows;
  anim.value = restored.animation;
  currentDevice.value = item.device;
  outputs.value = { neural: item.neural, physical: item.physical };
  replaceM27Url('source', URL.createObjectURL(item.source));
  if (item.neural) replaceM27Url('neural', URL.createObjectURL(item.neural));
  if (item.physical) replaceM27Url('physical', URL.createObjectURL(item.physical));
  version.value = urls.value[item.version] ? item.version : 'source';
  status.value = '已恢复此条历史记录';
}

function chooseFile(file: File, normalizedAlready = false) {
  const token = resetSource(file.name);
  originalSource.value = sourceFile.value = file;
  replaceM27Url('source', URL.createObjectURL(file));
  rememberSource();
  if (!normalizedAlready && synthesisGainMode.value === 'peak') {
    normalizingSource.value = true;
    const task = normalizeAudioFile(file, file.name, 'peak')
      .then((normalized) => {
        if (
          unmounted
          || token !== sourceGeneration
          || working.value
          || cleaningSource.value
          || cutting.value
          || aligning.value
          || transcribing.value
          || playing.value
          || auditioningWindow.value
          || normalized === file
        ) {
          return;
        }
        originalSource.value = sourceFile.value = normalized;
        replaceM27Url('source', URL.createObjectURL(normalized));
        m27Session.decodedBuffer.value = null;
        m27Session.spectrogramCache.value = {
          sourceBlob: null,
          durationSec: 0,
          pcm: null,
          sampleRate: 16000,
          bitmap: null,
        };
        rememberSource();
      })
      .finally(() => {
        if (token === sourceGeneration) {
          normalizingSource.value = false;
          if (pendingSourceNormalization === task) pendingSourceNormalization = null;
        }
      });
    pendingSourceNormalization = task;
  }
}

function onFileChange(e: Event, speaker = false) {
  const el = e.target as HTMLInputElement;
  const file = el.files?.[0];
  el.value = '';
  if (!file) return;
  if (speaker) setSpeaker(file);
  else chooseFile(file);
}

function safeEndSmp(grid?: TextGridDocument | null): number {
  const maxSec = Math.max(duration.value, grid?.xmax ?? 0, 0.02);
  return Math.max(1, Math.ceil(maxSec * SAMPLE_RATE_HZ));
}

async function attachTextGrid(event: Event) {
  const el = event.target as HTMLInputElement;
  const file = el.files?.[0];
  el.value = '';
  if (!file || !sourceFile.value || cutting.value) return;
  const token = sourceGeneration;
  try {
    const rawGrid = await readTextGridFile(file);
    if (token !== sourceGeneration || cutting.value) return;
    const grid = cleanTextGridWordLabels(rawGrid);
    clipFromTextGrid(grid, safeEndSmp(grid), store.activeClipId.value, store.activeVoiceId.value);
    sourceTextGrid.value = grid;
    sourceTextGridName.value = file.name;
    status.value = 'TextGrid 已关联，可随重建结果发送';
    rememberSource();
  } catch (error) {
    if (token === sourceGeneration) status.value = safeReason(error);
  }
}

function saveEditedAlignment(rawGrid: TextGridDocument) {
  if (cutting.value) return;
  try {
    const grid = cleanTextGridWordLabels(rawGrid);
    clipFromTextGrid(grid, safeEndSmp(grid), store.activeClipId.value, store.activeVoiceId.value);
    sourceTextGrid.value = grid;
    if (!sourceTextGridName.value.startsWith('已校正 · ')) {
      sourceTextGridName.value =
        '已校正 · ' + (sourceTextGridName.value || sourceName.value.replace(/\.[^./]+$/, '') + '.TextGrid');
    }
    alignmentMessage.value = '已保存校正后的边界与音标';
    status.value = '已保存对齐修改';
    rememberSource();
  } catch (error) {
    status.value = safeReason(error);
  }
}

// T-11: Default fallback choice is strictly `inputVoice` ('input')
function setSpeaker(file: File | null, choice = file ? uploadedVoice : inputVoice) {
  speakerGeneration++;
  cleaningSpeaker.value = false;
  requestGeneration++;
  working.value = false;
  workingAction.value = null;
  if (version.value === 'neural') {
    stopPlayback();
    version.value = 'source';
  }
  originalSpeaker.value = speakerFile.value = file;
  speakerChoice.value = choice;
  voiceName.value = '';
  replaceM27Url('neural');
  outputs.value = { ...outputs.value, neural: null };
  if (!liveActive.value) status.value = '';
}

function clearSourceAudioCaches() {
  decodedDur.value = 0;
  mediaDuration.value = 0;
  playheadSec.value = 0;
  selectionSec.value = null;
  m27Session.decodedBuffer.value = null;
  m27Session.spectrogramCache.value = {
    sourceBlob: null,
    durationSec: 0,
    pcm: null,
    sampleRate: 16000,
    bitmap: null,
  };
}

async function processSource() {
  await waitForSourceNormalization();
  const original = originalSource.value;
  const token = sourceGeneration;
  if (!original || working.value || transcribing.value || cleaningSource.value || cutting.value) return;
  cleaningSource.value = true;
  try {
    const result = await denoiseFile(original, sourceName.value);
    if (token !== sourceGeneration) return;
    clearOutputsLocal();
    clearSourceAudioCaches();
    sourceFile.value = result;
    replaceM27Url('source', URL.createObjectURL(result));
    status.value = '已切换到降噪输入';
    rememberSource(false);
  } catch (error) {
    if (token === sourceGeneration) status.value = safeReason(error);
  } finally {
    if (token === sourceGeneration) cleaningSource.value = false;
  }
}

function restoreSourceAudio() {
  const original = originalSource.value;
  if (!original || working.value || cleaningSource.value || cutting.value) return;
  if (transcribing.value) {
    cancelTranscription();
    alignmentMessage.value = '';
  }
  clearOutputsLocal();
  clearSourceAudioCaches();
  sourceFile.value = original;
  replaceM27Url('source', URL.createObjectURL(original));
  status.value = '已恢复原音';
  rememberSource(false);
}

function applyCutMedia(
  media: ReconstructionCutMedia,
  nextVersion: Version,
  nextPlayheadSec: number,
) {
  stopPlayback();
  sourceGeneration++;
  requestGeneration++;
  alignmentRun++;
  sourceFile.value = media.source;
  originalSource.value = media.original;
  originalSourceUrl.value = '';
  sourceTextGrid.value = media.grid;
  rows.value = media.rows;
  anim.value = media.anim;
  outputs.value = media.outputs;
  replaceM27Url('source', URL.createObjectURL(media.source));
  for (const mode of ['neural', 'physical'] as const) {
    const output = media.outputs[mode];
    replaceM27Url(mode, output ? URL.createObjectURL(output) : '');
  }
  version.value = urls.value[nextVersion] ? nextVersion : 'source';
  m27Session.decodedBuffer.value = null;
  decodedDur.value = mediaDuration.value = 0;
  playheadSec.value = nextPlayheadSec;
  void nextTick(paintAll);
}

async function cutSourceAudio(mode: 'silence' | 'selection') {
  await waitForSourceNormalization();
  const source = sourceFile.value;
  const selection = mode === 'selection' ? selectionSec.value : null;
  if (!canEditAudio.value || !source || (mode === 'selection' && !selection)) return;

  const before: ReconstructionCutSnapshot = {
    source,
    original: originalSource.value,
    grid: sourceTextGrid.value,
    gridName: sourceTextGridName.value,
    rows: rows.value,
    anim: anim.value,
    outputs: outputs.value,
    version: version.value,
    device: currentDevice.value,
    playheadSec: playheadSec.value,
    viewStartSec: viewStartSec.value,
    selectionSec: selectionSec.value,
    speaker: speakerFile.value,
    speakerChoice: speakerChoice.value,
  };
  const token = ++cutGeneration;
  cutting.value = true;
  try {
    const next = await prepareReconstructionCut(
      { ...before, grid: before.grid ?? fallbackAlignmentGrid(decodedDur.value || duration.value, phoneBoundaries.value) },
      sourceName.value,
      selection,
      decodeBlobCached,
    );
    if (token !== cutGeneration) return;
    if (audioEditBlocked.value || before.outputs !== outputs.value || before.grid !== sourceTextGrid.value) {
      status.value = '音频或对齐已更新，请重新执行剪切';
      return;
    }
    if (!next) {
      status.value = '未检测到可裁剪的首尾静音';
      return;
    }
    applyCutMedia(next, version.value, next.playheadSec);
    if (next.grid && !before.grid) sourceTextGridName.value = '已剪切 · 音素区间';
    cutUndo.value = [...cutUndo.value, before].slice(-CUT_UNDO_LIMIT);
    selectionSec.value = null;
    viewStartSec.value = Math.min(viewStartSec.value, next.playheadSec);
    status.value = mode === 'silence' ? '已裁剪首尾静音' : '已剪切选区';
    rememberSource();
  } catch (error) {
    if (token === cutGeneration) status.value = '剪切失败 · ' + safeReason(error);
  } finally {
    if (token === cutGeneration) cutting.value = false;
  }
}

function undoSourceCut() {
  const before = cutUndo.value.at(-1);
  if (!before || !canEditAudio.value) return;
  const sameSpeaker = before.speaker === speakerFile.value && before.speakerChoice === speakerChoice.value;
  const restored = sameSpeaker ? before : { ...before, outputs: { ...before.outputs, neural: null } };
  applyCutMedia(restored, before.version, before.playheadSec);
  cutUndo.value = cutUndo.value.slice(0, -1);
  selectionSec.value = before.selectionSec;
  sourceTextGridName.value = before.gridName;
  currentDevice.value = before.device;
  viewStartSec.value = before.viewStartSec;
  status.value = '已撤销剪切';
  rememberSource();
}

function applySpeakerAudio(file: File) {
  if (version.value === 'neural') {
    stopPlayback();
    version.value = 'source';
  }
  speakerFile.value = file;
  replaceM27Url('neural');
  outputs.value = { ...outputs.value, neural: null };
  requestGeneration++;
  working.value = false;
  workingAction.value = null;
}

async function processSpeaker() {
  const original = originalSpeaker.value;
  const token = speakerGeneration;
  if (!original || working.value || cleaningSpeaker.value) return;
  cleaningSpeaker.value = true;
  try {
    const result = await denoiseFile(original);
    if (token !== speakerGeneration) return;
    applySpeakerAudio(result);
    status.value = '音色参考已降噪';
  } catch (error) {
    if (token === speakerGeneration) status.value = safeReason(error);
  } finally {
    if (token === speakerGeneration) cleaningSpeaker.value = false;
  }
}

function restoreSpeakerAudio() {
  if (!originalSpeaker.value || working.value || cleaningSpeaker.value) return;
  applySpeakerAudio(originalSpeaker.value);
  status.value = '已恢复原音色参考';
}

function chooseSpeakerReference(key: string | number) {
  const choice = String(key);
  if (choice === uploadedVoice) return;
  if (choice === lectureVoice || choice === inputVoice) {
    setSpeaker(null, choice);
    return;
  }
  const saved = reconstructionVoices.value.find((item) => item.id === choice);
  if (saved) {
    setSpeaker(saved.file, choice);
    voiceName.value = saved.name;
  }
}

async function saveVoice() {
  const name = voiceName.value.trim();
  const file = speakerFile.value;
  if (!file || !name || savingVoice.value || cleaningSpeaker.value) return;
  savingVoice.value = true;
  const id =
    reconstructionVoices.value.find((item) => item.name === name && item.file.name === file.name)?.id ??
    crypto.randomUUID();
  try {
    await saveReconstructionVoice({ id, name, file });
    if (file === speakerFile.value) speakerChoice.value = id;
    status.value = '音色参考已保存到本地浏览器';
  } catch {
    status.value = '当前浏览器无法保存音色参考';
  } finally {
    savingVoice.value = false;
  }
}

function tryStartMicSpeechRecognition(onTranscript: (text: string) => void) {
  const win = window as unknown as {
    SpeechRecognition?: new () => {
      lang: string;
      continuous: boolean;
      interimResults: boolean;
      onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
      onerror: (() => void) | null;
      start: () => void;
      stop: () => void;
    };
    webkitSpeechRecognition?: new () => {
      lang: string;
      continuous: boolean;
      interimResults: boolean;
      onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
      onerror: (() => void) | null;
      start: () => void;
      stop: () => void;
    };
  };
  const Ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
  if (!Ctor) return;
  try {
    const rec = new Ctor();
    rec.lang = alignmentLang.value === 'en' ? 'en-US' : 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => {
      let transcript = '';
      for (let i = 0; i < ev.results.length; i++) {
        transcript += ev.results[i][0]?.transcript ?? '';
      }
      if (transcript.trim()) {
        onTranscript(transcript.trim());
      }
    };
    rec.onerror = () => undefined;
    rec.start();
    speechRec = rec;
  } catch {
    // ignore speech recognition errors
  }
}

async function toggleRecording() {
  if (recorder?.state === 'recording') {
    stopSpeechRecognition();
    recorder.stop();
    micMonitor.stop();
    return;
  }
  if (recorder || acquiringMic.value || cutting.value) return;
  if (transcribing.value) {
    cancelTranscription();
    alignmentMessage.value = '';
  }
  const generation = ++captureGeneration;
  acquiringMic.value = true;
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { noiseSuppression: false, echoCancellation: false, autoGainControl: false },
    });
    if (captureGeneration !== generation) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const presetText = alignmentText.value.trim();
    const presetLang = alignmentLang.value;
    let liveRecognizedText = '';
    const mic = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder = mic;
    mic.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    mic.onerror = () => {
      if (generation !== captureGeneration) return;
      discardCapture();
      status.value = '录音中断，请检查麦克风输入';
    };
    mic.onstop = async () => {
      stopSpeechRecognition();
      micMonitor.stop();
      const recognizedDuringMic = liveRecognizedText;
      mic.stream.getTracks().forEach((t) => t.stop());
      recording.value = false;
      recorder = null;
      let ctx: AudioContext | undefined;
      try {
        const recorded = new Blob(chunks, { type: mic.mimeType });
        ctx = new AudioContext({ sampleRate: 16000 });
        const decoded = await ctx.decodeAudioData(await recorded.arrayBuffer());
        if (synthesisGainMode.value === 'peak') applyPeakAudioGain(decoded);
        const bytes = Uint8Array.from(
          atob(encodeMonoWavBase64(decoded.getChannelData(0), decoded.sampleRate)),
          (c) => c.charCodeAt(0),
        );
        if (generation === captureGeneration) {
          const recordedFile = new File([bytes], '录音.wav', { type: 'audio/wav' });
          const nextText = presetText || recognizedDuringMic.trim();
          recordPrepDraft.value = {
            target: 'source',
            file: recordedFile,
            originalFile: recordedFile,
            text: nextText,
            lang: presetLang,
            grid: null,
            fromExisting: false,
          };
        }
      } catch (e) {
        if (generation === captureGeneration) status.value = '录音解码失败 · ' + safeReason(e);
      } finally {
        if (ctx) void ctx.close();
      }
    };
    stopPlayback();
    mic.start();
    micMonitor.start(stream);
    if (!presetText) {
      tryStartMicSpeechRecognition((text) => {
        liveRecognizedText = text;
        alignmentText.value = text;
        alignmentMessage.value = '已实时识别录音文本，可按需微调';
      });
    }
    recording.value = true;
  } catch {
    if (generation === captureGeneration) {
      discardCapture();
      status.value = '麦克风不可用，请检查浏览器录音权限';
    }
    stream?.getTracks().forEach((t) => t.stop());
  } finally {
    if (generation === captureGeneration) acquiringMic.value = false;
  }
}

function discardSpeakerCapture() {
  speakerMicGen++;
  acquiringSpeakerMic.value = false;
  recordingSpeaker.value = false;
  speakerMicMonitor.stop();
  if (speakerRecorder) {
    const mic = speakerRecorder;
    speakerRecorder = null;
    mic.onstop = null;
    mic.onerror = null;
    try {
      if (mic.state !== 'inactive') mic.stop();
    } catch {
      // ignore
    }
    mic.stream.getTracks().forEach((t) => t.stop());
  }
}

async function toggleSpeakerRecording() {
  if (speakerRecorder?.state === 'recording') {
    speakerRecorder.stop();
    speakerMicMonitor.stop();
    return;
  }
  if (speakerRecorder || acquiringSpeakerMic.value || recording.value || acquiringMic.value || working.value) return;
  stopPlayback();
  const gen = ++speakerMicGen;
  acquiringSpeakerMic.value = true;
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, noiseSuppression: false, echoCancellation: false, autoGainControl: false },
    });
    if (gen !== speakerMicGen) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const mic = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    speakerRecorder = mic;
    mic.ondataavailable = (ev) => {
      if (ev.data.size) chunks.push(ev.data);
    };
    mic.onerror = () => {
      if (gen !== speakerMicGen) return;
      discardSpeakerCapture();
      status.value = '参考音录制中断，请检查麦克风输入';
    };
    mic.onstop = async () => {
      speakerMicMonitor.stop();
      mic.stream.getTracks().forEach((t) => t.stop());
      recordingSpeaker.value = false;
      speakerRecorder = null;
      let ctx: AudioContext | undefined;
      try {
        const recorded = new Blob(chunks, { type: mic.mimeType });
        ctx = new AudioContext({ sampleRate: 16000 });
        const decoded = await ctx.decodeAudioData(await recorded.arrayBuffer());
        if (synthesisGainMode.value === 'peak') applyPeakAudioGain(decoded);
        const bytes = Uint8Array.from(
          atob(encodeMonoWavBase64(decoded.getChannelData(0), decoded.sampleRate)),
          (c) => c.charCodeAt(0),
        );
        if (gen !== speakerMicGen) return;
        const file = new File([bytes], '参考音色录音.wav', { type: 'audio/wav' });
        recordPrepDraft.value = {
          target: 'speaker',
          file,
          originalFile: file,
          text: '',
          lang: 'auto',
          grid: null,
          fromExisting: false,
        };
      } catch (err) {
        if (gen === speakerMicGen) status.value = '参考音解码失败 · ' + safeReason(err);
      } finally {
        if (ctx) void ctx.close();
      }
    };
    mic.start();
    speakerMicMonitor.start(stream);
    recordingSpeaker.value = true;
  } catch {
    if (gen === speakerMicGen) {
      discardSpeakerCapture();
      status.value = '麦克风不可用，请检查浏览器录音权限';
    }
    stream?.getTracks().forEach((t) => t.stop());
  } finally {
    if (gen === speakerMicGen) acquiringSpeakerMic.value = false;
  }
}

function ensureAudioFile(blob: Blob, fallbackName: string): File {
  return blob instanceof File ? blob : new File([blob], fallbackName || '录音.wav', { type: blob.type || 'audio/wav' });
}

function openSourceAudioEditor() {
  if (!sourceFile.value || audioEditBlocked.value) return;
  const curFile = ensureAudioFile(sourceFile.value, sourceName.value || '录音.wav');
  const origFile = originalSource.value ? ensureAudioFile(originalSource.value, sourceName.value || '录音.wav') : curFile;
  recordPrepDraft.value = {
    target: 'source',
    file: curFile,
    originalFile: origFile,
    text: alignmentText.value,
    lang: alignmentLang.value,
    grid: sourceTextGrid.value,
    fromExisting: true,
  };
}

function openSpeakerAudioEditor() {
  if (!speakerFile.value || working.value || cleaningSpeaker.value) return;
  recordPrepDraft.value = {
    target: 'speaker',
    file: speakerFile.value,
    originalFile: originalSpeaker.value ?? speakerFile.value,
    text: '',
    lang: 'auto',
    grid: null,
    fromExisting: true,
  };
}

function confirmRecordPrep(result: AudioRecordPrepResult) {
  const draft = recordPrepDraft.value;
  if (!draft) return;
  recordPrepDraft.value = null;

  if (draft.target === 'speaker') {
    setSpeaker(result.file, uploadedVoice);
    if (result.denoised) {
      originalSpeaker.value = result.originalFile;
    }
    rememberSource();
    status.value = result.denoised ? '已载入降噪后的参考音色录音' : '已载入自定义参考音色录音';
    return;
  }

  const keepExistingMedia = draft.fromExisting && !result.audioChanged && sourceFile.value === result.file;
  if (!keepExistingMedia) {
    chooseFile(result.file, true);
    if (result.denoised) {
      originalSource.value = result.originalFile;
    }
  }
  alignmentLang.value = result.lang;
  alignmentText.value = result.text;
  if (result.grid) {
    sourceTextGrid.value = result.grid;
    sourceTextGridName.value = '';
    alignmentMessage.value = '已应用录音编辑弹窗中的 Vox2Align-Lite v2 音素边界对齐';
  } else if (result.text) {
    alignmentMessage.value = '已填入参考文本，点击「按原文对齐」或「开始声道重建」生效';
  }
  rememberSource();
  status.value = result.denoised ? '已载入裁剪/降噪后的录音' : '已载入录音，可直接试听或开始声道重建';
}

function wavBlob(data?: string) {
  if (!data) return null;
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: 'audio/wav' });
}

function acceptAlignmentGrid(alignment: {
  textgrid: string;
  mode?: string;
  model?: string;
  syllables?: Array<{ label?: string; word?: string; is_sil?: boolean }>;
  phones?: Array<{ ipa?: string; is_sil?: boolean }>;
}) {
  if (fixedTextGrid.value) return;
  const parsed = parseTextGrid(alignment.textgrid);
  if (
    !parsed.ok ||
    !parsed.value.tiers.some(
      (tier) =>
        tier.kind === 'IntervalTier' &&
        /phone|音素/i.test(tier.name) &&
        tier.intervals.some((interval) => interval.text.trim()),
    )
  ) {
    throw new Error('对齐结果缺少有效音素区间');
  }
  const cleaned = cleanTextGridWordLabels(parsed.value);
  sourceTextGrid.value = cleaned;
  sourceTextGridName.value = '模型对齐 · ' + (alignment.model ?? 'Vox2Align-Lite v2');

  // If text was left blank, backfill recognized syllables/words if available (T-52)
  if (!alignmentText.value.trim() && Array.isArray(alignment.syllables) && alignment.syllables.length) {
    const words = alignment.syllables
      .filter((s) => !s.is_sil)
      .map((s) => stripRedundantPinyin(s.word || s.label || ''))
      .filter(Boolean);
    if (words.length) {
      const joined = words.every((w) => /^[A-Za-z'’-]+$/.test(w)) ? words.join(' ') : words.join('');
      if (joined) alignmentText.value = joined;
    }
  }
  alignmentMessage.value =
    alignment.mode === 'guided'
      ? '已按参考文本生成 Vox2Align-Lite v2 对齐边界'
      : '已生成 Vox2Align-Lite v2 声学音素边界';
}

function invalidateModelGrid() {
  alignmentRun++;
  aligning.value = false;
  if (!fixedTextGrid.value) {
    sourceTextGrid.value = null;
    sourceTextGridName.value = '';
  }
  alignmentMessage.value = '';
}

function cancelTranscription() {
  transcriptionRequest?.abort();
  transcriptionRequest = null;
  transcribing.value = false;
}

function editReferenceText() {
  cancelTranscription();
  invalidateModelGrid();
}

const transcriptionBlocked = computed(() =>
  working.value || aligning.value || transcribing.value || cleaningSource.value || cutting.value ||
  recording.value || acquiringMic.value,
);
const deepSeekAsrKey = computed(() => store.deepSeekAsrEnabled.value && isDeepSeekApiBase(store.aiToolsBaseUrl.value)
  ? store.aiToolsApiKey.value : '');
const transcribingMode = ref<'local' | 'cloud' | null>(null);
const localAsr = useLocalAsrSetup(
  computed(() => !!sourceFile.value),
  store.localWhisperModel, store.setLocalWhisperModel,
);
const { status: localAsrStatus, message: localAsrMessage, pendingModel: localAsrPending } = localAsr;
watch(deepSeekAsrKey, () => {
  if (!transcribing.value || transcribingMode.value !== 'cloud') return;
  cancelTranscription();
  alignmentMessage.value = '';
});

function formatTranscribedLang(lang?: string): string {
  const labels: Record<string, string> = { zh: '普通话', en: '英语', ja: '日语', ko: '韩语', yue: '粤语' };
  return (lang && labels[lang]) || '语音';
}

async function transcribeReferenceText(mode: 'local' | 'cloud' = 'local') {
  await waitForSourceNormalization();
  const file = sourceFile.value;
  if (!file || transcriptionBlocked.value) return;
  const key = mode === 'cloud' ? deepSeekAsrKey.value : '';
  const request = new AbortController();
  transcriptionRequest = request;
  transcribing.value = true;
  transcribingMode.value = mode;
  alignmentMessage.value = mode === 'cloud' ? '正在使用 DeepSeek API 识别录音…' : '正在使用本地 SenseVoice-Small 识别录音…';

  try {
    const result = await requestTranscription(file, alignmentLang.value, request.signal, {
      mode,
      deepSeekKey: key,
      model: store.localWhisperModel.value,
    });
    if (transcriptionRequest !== request || sourceFile.value !== file) return;
    if (alignmentText.value.trim() !== result.text) invalidateModelGrid();
    alignmentText.value = result.text;
    const source = mode === 'cloud'
      ? 'DeepSeek API 已转写录音'
      : `SenseVoice-Small 已转写${formatTranscribedLang(result.lang)}录音`;
    alignmentMessage.value = `${source}，可校对文本后按原文对齐或开始重建`;
    rememberSource();
  } catch (error) {
    if (transcriptionRequest === request && sourceFile.value === file) {
      alignmentMessage.value = '自动识别未完成：' + safeReason(error);
      if (mode === 'local') void localAsr.refresh();
    }
  } finally {
    if (transcriptionRequest === request) {
      transcribingMode.value = null;
      cancelTranscription();
    }
  }
}

async function alignTranscript() {
  await waitForSourceNormalization();
  const file = sourceFile.value;
  const text = alignmentText.value.trim();
  if (!file || !text || aligning.value || transcribing.value || working.value || cutting.value || fixedTextGrid.value) return;
  const generation = ++alignmentRun;
  const lang = alignmentLang.value;
  aligning.value = true;
  alignmentMessage.value = '正在使用 Vox2Align-Lite v2 按原文对齐…';
  try {
    const wav = await blobToBase64(file);
    if (generation !== alignmentRun) return;
    const result = await adapter.align({
      wav_base64: wav,
      filename: sourceName.value,
      text,
      lang,
      alignment_mode: 'guided',
      compute_device: store.computeDevice.value,
    });
    if (generation !== alignmentRun || sourceFile.value !== file) return;
    if (!result.ok) throw new Error(result.error.hint);
    acceptAlignmentGrid(result.value.alignment);
    rememberSource();
  } catch (error) {
    if (generation === alignmentRun) alignmentMessage.value = safeReason(error);
  } finally {
    if (generation === alignmentRun) aligning.value = false;
  }
}

async function run(action: 'reconstruct' | 'resynthesize', trigger: 'reconstruct' | 'resynthesize' | 'arranger' = action) {
  await waitForSourceNormalization();
  if (
    working.value ||
    aligning.value ||
    transcribing.value ||
    cleaningSource.value ||
    cleaningSpeaker.value ||
    cutting.value ||
    !sourceFile.value ||
    (action === 'resynthesize' && !hasResult.value)
  ) {
    return;
  }
  stopPlayback();
  const renderMode = voiceRenderMode.value;
  if (action === 'reconstruct') {
    clearOutputsLocal();
  } else {
    version.value = 'source';
    replaceM27Url(renderMode);
  }

  const token = ++requestGeneration;
  const text = alignmentText.value.trim();
  const guide = !!text && !fixedTextGrid.value;
  const guideRun = alignmentRun;
  const speakerProfile: typeof lectureVoice | undefined =
    speakerChoice.value === lectureVoice ? lectureVoice : undefined;

  working.value = true;
  workingAction.value = trigger;
  status.value = action === 'reconstruct' ? '正在执行 Vox2Tract-Lite 声道重建…' : '正在重合成音频…';

  try {
    const [speaker, source] = await Promise.all([
      renderMode !== 'neural'
        ? undefined
        : speakerFile.value
          ? blobToBase64(speakerFile.value)
          : !speakerProfile && action === 'resynthesize'
            ? blobToBase64(sourceFile.value)
            : undefined,
      action === 'reconstruct' ? blobToBase64(sourceFile.value) : undefined,
    ]);
    if (token !== requestGeneration) return;

    const synthMode = renderMode === 'neural' ? ('both' as const) : ('vtl' as const);
    const shared = {
      speaker_ref_wav_base64: speaker,
      audio_gain: synthesisGainMode.value,
      speaker_ref_filename: speakerFile.value?.name,
      speaker_profile: renderMode === 'neural' ? speakerProfile : undefined,
      compute_device: store.computeDevice.value,
      synth_mode: action === 'reconstruct' ? synthMode : renderMode === 'neural' ? ('neural' as const) : ('vtl' as const),
    };

    let result = source
      ? await adapter.reconstruct({
          ...shared,
          filename: sourceName.value,
          wav_base64: source,
          fps: 25,
          text: guide ? text : undefined,
          lang: alignmentLang.value,
          alignment_mode: guide ? 'guided' : undefined,
        })
      : await adapter.resynthesize({ ...shared, m27_50hz_pa: rows.value });

    // If Vox2Align-Lite v2 is currently unloaded in Settings, fall back gracefully to alignment_mode='none'
    // so tract reconstruction and neural/physical resynthesis still complete cleanly.
    if (
      source &&
      guide &&
      !result.ok &&
      (String(result.error.code) === 'model_unloaded' || result.error.hint.includes('Vox2Align-Lite'))
    ) {
      alignmentMessage.value = 'Vox2Align-Lite v2 当前未装载，已自动切换无对齐声道重建（需要音素切分时可在设置中装载）';
      result = await adapter.reconstruct({
        ...shared,
        filename: sourceName.value,
        wav_base64: source,
        fps: 25,
        alignment_mode: 'none',
      });
    }

    if (token !== requestGeneration) return;
    if (!result.ok) throw new Error(result.error.hint);
    const data = result.value;

    if (renderMode === 'neural' && speakerProfile && data.voice_profile !== speakerProfile) {
      throw new Error('本地引擎未确认讲解声纹，请更新引擎后重试');
    }

    if ('m27_50hz_pa' in data) {
      const frames = data.m27_50hz_pa;
      if (
        !Array.isArray(frames) ||
        !frames.length ||
        !frames.every((r) => Array.isArray(r) && r.length === 27 && r.every(Number.isFinite))
      ) {
        throw new Error('服务返回的轨迹缺少有效的 27 维数据');
      }
      const reconstructed = updateLegacyReconstructionRest(frames, data.tract_glottis_anim);
      rows.value = reconstructed.rows;
      anim.value = reconstructed.animation;
    } else if (data.tract_glottis_anim?.frames?.length) {
      anim.value = data.tract_glottis_anim;
    }

    if (action === 'reconstruct' && !fixedTextGrid.value && guideRun === alignmentRun) {
      if ('alignment' in data && data.alignment?.textgrid) {
        try {
          acceptAlignmentGrid(data.alignment);
        } catch (error) {
          alignmentMessage.value = safeReason(error);
        }
      } else if (guide) {
        alignmentMessage.value =
          ('alignment_error' in data && data.alignment_error?.hint) || '未获得与参考文本匹配的音素区间';
      }
    }

    currentDevice.value = data.device_effective;
    const physical = wavBlob(data.vtl_48k_wav_base64);
    const neural = wavBlob(data.neural_16k_wav_base64);
    outputs.value = {
      physical: physical ?? outputs.value.physical,
      neural: neural ?? outputs.value.neural,
    };
    if (physical) replaceM27Url('physical', URL.createObjectURL(physical));
    if (neural) replaceM27Url('neural', URL.createObjectURL(neural));
    if (urls.value[renderMode]) version.value = renderMode;

    playheadSec.value = 0;
    if (audio.value) audio.value.currentTime = 0;
    status.value =
      (action === 'reconstruct' ? '声道重建完成' : '重合成完成') +
      (urls.value[renderMode] ? ' · ' + voiceRenderLabels[renderMode] : '') +
      (data.voice_profile === lectureVoice ? ' · ' + lectureLabel : '');
    rememberSource(true);
  } catch (e) {
    if (token === requestGeneration) status.value = safeReason(e);
  } finally {
    if (token === requestGeneration) {
      working.value = false;
      workingAction.value = null;
    }
  }
}

// T-49: Local window audition (`playheadSec ± windowMs` with 12 ms fade-in & fade-out)
function activeBlobForAudition(): Blob | null {
  if (version.value === 'source') return sourceFile.value;
  return outputs.value[version.value];
}

function decodeBlobCached(blob: Blob): Promise<AudioBuffer> {
  let pending = decodedBlobCache.get(blob);
  if (!pending) {
    pending = (async () => {
      const offline = new OfflineAudioContext(1, 1, 48000);
      return offline.decodeAudioData(await blob.arrayBuffer());
    })().catch((err) => {
      decodedBlobCache.delete(blob);
      throw err;
    });
    decodedBlobCache.set(blob, pending);
  }
  return pending;
}

async function auditionWindowAtPlayhead() {
  if (liveActive.value || liveStarting.value || recording.value) return;
  const blob = activeBlobForAudition();
  if (!blob) return;
  if (auditioningWindow.value) {
    stopAuditionWindow();
    return;
  }
  stopPlayback();
  const gen = ++auditionGeneration;
  auditioningWindow.value = true;
  try {
    const decoded = await decodeBlobCached(blob);
    if (unmounted || gen !== auditionGeneration) return;
    const halfSec = auditionWindowMs.value / 1000;
    const center = Math.max(0, Math.min(decoded.duration, playheadSec.value));
    const t0 = Math.max(0, center - halfSec);
    const t1 = Math.min(decoded.duration, center + halfSec);
    const sr = decoded.sampleRate;
    const s0 = Math.max(0, Math.floor(t0 * sr));
    const s1 = Math.min(decoded.length, Math.ceil(t1 * sr));
    const frameLen = Math.max(1, s1 - s0);

    const ctx = (auditionCtx ??= new AudioContext());
    if (ctx.state === 'suspended') await ctx.resume();
    if (unmounted || gen !== auditionGeneration) return;

    const windowed = ctx.createBuffer(decoded.numberOfChannels, frameLen, sr);
    const fadeSamples = Math.min(Math.floor(frameLen / 2), Math.max(1, Math.round(0.012 * sr)));

    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const src = decoded.getChannelData(ch);
      const dst = windowed.getChannelData(ch);
      for (let i = 0; i < frameLen; i++) {
        let env = 1;
        if (i < fadeSamples) {
          env = 0.5 * (1 - Math.cos((Math.PI * i) / fadeSamples));
        } else if (i >= frameLen - fadeSamples) {
          const rem = frameLen - 1 - i;
          env = 0.5 * (1 - Math.cos((Math.PI * rem) / fadeSamples));
        }
        dst[i] = src[s0 + i] * env;
      }
    }

    const node = ctx.createBufferSource();
    node.buffer = windowed;
    node.playbackRate.value = speed.value;
    node.connect(ctx.destination);
    auditionNode = node;
    node.onended = () => {
      if (auditionNode === node) {
        auditionNode = null;
        auditioningWindow.value = false;
      }
    };
    node.start();
  } catch (err) {
    if (gen === auditionGeneration) {
      auditioningWindow.value = false;
      status.value = '局部窗口试听失败 · ' + safeReason(err);
    }
  }
}

// T-49: Assign current playhead frame's 19-D vocal tract parameters to target IPA symbol
function openAssignIpaModal() {
  if (!activeRow.value) return;
  void loadDefaultIpaPoses();
  assignSetId.value = selectedIpaPoseSetId.value;
  if (currentPhoneAtPlayhead.value) {
    assignSymbol.value = currentPhoneAtPlayhead.value;
  } else if (!assignSymbol.value.trim() && uniqueAlignedPhones.value.length) {
    assignSymbol.value = uniqueAlignedPhones.value[0];
  }
  assignModalOpen.value = true;
}

async function createWritableSchemeInline() {
  await loadDefaultIpaPoses();
  let candidate = newSchemeName.value.trim() || '声道重建提取构型';
  let suffix = 1;
  while (ipaPoseSets.value.some((s) => s.name === candidate)) {
    candidate = `${newSchemeName.value.trim() || '声道重建提取构型'} ${++suffix}`;
  }
  const createdId = duplicateActiveIpaPoseSet(candidate, assignSetId.value);
  if (createdId) {
    assignSetId.value = createdId;
    store.pushToast(`已基于当前库新建构型方案「${candidate}」`, 'success');
  }
}

function confirmAssignIpa() {
  const row = interpolatedActiveRow.value ?? activeRow.value;
  const sym = assignSymbol.value.trim();
  if (!row || !sym) return;
  if (assignSetId.value === RECORDED_IPA_SET_ID) {
    store.pushToast('默认实录构型库为只读，请先点击上方按钮新建一套构型方案', 'warning');
    return;
  }
  const params19 = tractRecordToArray19(tractParameters(row, state.value?.lm));
  if (saveIpaPoseToSet(sym, params19, assignSetId.value)) {
    selectIpaPoseSet(assignSetId.value);
    const schemeName = ipaPoseSets.value.find((s) => s.id === assignSetId.value)?.name ?? '自定义构型方案';
    assignModalOpen.value = false;
    status.value = `已将 ${playheadSec.value.toFixed(3)} s 帧赋给 [${sym}]（${schemeName}）`;
    store.pushToast(`已将 ${playheadSec.value.toFixed(2)} s 的 19 维声道构型赋给 [${sym}]`, 'success');
  } else {
    store.pushToast('保存失败，请检查音标符号与目标构型方案', 'warning');
  }
}

// Enlarged oral-focused mid-sagittal framing for Reconstruction right viewport
const RECONSTRUCTION_TRACT_VIEWBOX = { x: -4.25, y: -2.85, w: 12.1, h: 9.85 } as const;

// Rendering: Right column dual anatomy viewports (T-12) + Center aligned curves (T-53)
function paintAnatomy() {
  const svg = tractSvg.value;
  const useLive = liveActive.value && liveTractGeometry.value && liveAnimSnapshot.value && liveStateSnapshot.value;
  const current = useLive ? liveStateSnapshot.value : state.value;
  const timeline = useLive ? liveAnimSnapshot.value : anim.value;

  if (svg) {
    const theme = readThemePalette(svg);
    if (timeline && current && Object.keys(current.parts).length) {
      renderM27TractSvg(svg, timeline, current, {
        showGhost: false,
        showLabels: showLabels.value,
        viewBox: RECONSTRUCTION_TRACT_VIEWBOX,
        theme,
      });
    } else {
      const neutralState = interpM27AnimState(neutralJd2Anim, 0);
      if (neutralState) {
        renderM27TractSvg(svg, neutralJd2Anim, neutralState, {
          showGhost: false,
          showLabels: showLabels.value,
          viewBox: RECONSTRUCTION_TRACT_VIEWBOX,
          theme,
        });
      }
    }
  }

  // T-12: Bottom-right glottis canvas is ALWAYS mounted; renders modal static anatomy before reconstruction
  if (atlas.value) {
    const glottis = current ?? MODAL_STATIC_GLOTTIS_STATE;
    const tSec = useLive ? performance.now() / 1000 : playheadSec.value;
    const phase = current
      ? tSec * 2 * Math.PI * getM27GlottisVisHz(current, vibMode.value)
      : 0;
    drawM27GlottisCanvas(atlas.value, glottis, phase, {
      vibMode: vibMode.value,
      showLabels: showLabels.value,
      theme: readThemePalette(atlas.value),
    });
  }
}

function paintLiveMonitor() {
  const canvas = liveMonitorCanvas.value;
  const wrap = liveMonitorPlotWrap.value ?? canvas?.parentElement;
  const lanes = liveParamLanes.value;
  if (!canvas || !wrap || !lanes.length) return;

  const w = Math.max(160, Math.round(wrap.clientWidth));
  const h = Math.round(wrap.clientHeight);
  if (!h) return;
  const laneHeight = h / lanes.length;
  const dpr = Math.min(2.25, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const pal = readThemePalette(canvas);
  const sem = readSemanticChartColors(canvas);
  ctx.fillStyle = pal.curvesBg;
  ctx.fillRect(0, 0, w, h);

  const maxPts = 250; // 5 s @ 50 Hz
  const hist = liveTraceHistory;
  const latestRow = hist.length ? hist[hist.length - 1] : null;
  const readCell = (row: readonly number[] | null, col: number, fallback = 0) => {
    const v = row?.[col];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };

  // Subtle 1-second vertical gridlines across the 5 s rolling window
  ctx.save();
  ctx.globalAlpha = 0.42;
  ctx.strokeStyle = pal.zeroLine;
  ctx.lineWidth = 1;
  for (let sec = 1; sec < 5; sec++) {
    const gx = (sec / 5) * w;
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, h);
    ctx.stroke();
  }
  ctx.restore();

  const offset = maxPts - hist.length;
  const xAtIdx = (i: number) => ((offset + i) / (maxPts - 1)) * w;

  lanes.forEach((lane, li) => {
    const top = li * laneHeight;
    const bot = top + laneHeight;
    const plotT = top + 14;
    const plotB = bot - 4;
    const plotH = Math.max(12, plotB - plotT);

    if (li % 2 === 1) {
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = pal.laneBg;
      ctx.fillRect(0, top, w, laneHeight);
      ctx.restore();
    }
    ctx.strokeStyle = pal.laneBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, bot - 0.5);
    ctx.lineTo(w, bot - 0.5);
    ctx.stroke();

    const yAt = (val: number, vmin: number, vmax: number) => {
      const u = Math.max(0, Math.min(1, (val - vmin) / Math.max(1e-6, vmax - vmin)));
      return plotB - u * plotH;
    };

    if (lane.zeroVal !== undefined && lane.zeroRange) {
      const zy = yAt(lane.zeroVal, lane.zeroRange[0], lane.zeroRange[1]);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = pal.zeroLine;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(0, zy);
      ctx.lineTo(w, zy);
      ctx.stroke();
      ctx.restore();
    }

    for (const ser of lane.series) {
      const serColor = sem[ser.colorToken];
      const serFill = ser.fillToken ? sem[ser.fillToken] : '';
      if (serFill && hist.length > 1) {
        ctx.save();
        ctx.beginPath();
        const firstX = xAtIdx(0);
        ctx.moveTo(firstX, plotB);
        let lastX = firstX;
        for (let i = 0; i < hist.length; i++) {
          const x = xAtIdx(i);
          const y = yAt(readCell(hist[i], ser.col, ser.fallback), ser.min, ser.max);
          ctx.lineTo(x, y);
          lastX = x;
        }
        ctx.lineTo(lastX, plotB);
        ctx.closePath();
        ctx.fillStyle = serFill;
        ctx.fill();
        ctx.restore();
      }

      if (hist.length > 1) {
        ctx.save();
        if (ser.dash) ctx.setLineDash(ser.dash);
        ctx.strokeStyle = serColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < hist.length; i++) {
          const x = xAtIdx(i);
          const y = yAt(readCell(hist[i], ser.col, ser.fallback), ser.min, ser.max);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
      }
    }

    let rx = 8;
    ctx.font = '600 9.5px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    for (const ser of lane.series) {
      const serColor = sem[ser.colorToken];
      const curVal = readCell(latestRow, ser.col, ser.fallback);
      if (latestRow) {
        const cy = yAt(curVal, ser.min, ser.max);
        ctx.fillStyle = serColor;
        ctx.beginPath();
        ctx.arc(Math.max(3, w - 3), cy, 2.7, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = pal.dotStroke;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      const suffix = ser.unit ? (ser.unit === '°' || ser.unit === '%' ? ser.unit : ` ${ser.unit}`) : '';
      const txt = latestRow ? `${ser.label} ${curVal.toFixed(ser.dec)}${suffix}` : `${ser.label} —`;
      ctx.fillStyle = serColor;
      ctx.fillText(txt, rx, top + 8);
      rx += ctx.measureText(txt).width + 10;
    }
  });
}

function getLiveSpeakerMode(): 'input' | 'lecture' | 'reference' {
  if (speakerFile.value) return 'reference';
  if (speakerChoice.value === lectureVoice) return 'lecture';
  return 'input';
}

async function syncLiveSpeakerReference(): Promise<string> {
  const token = ++liveSpeakerPrepToken;
  if (!liveUseTimbreModel.value || !speakerFile.value) {
    livePreparingSpeaker.value = false;
    liveSpeakerKey.value = '';
    liveSpeakerMedianF0Hz.value = !liveUseTimbreModel.value || speakerChoice.value === lectureVoice ? 165 : null;
    return '';
  }
  livePreparingSpeaker.value = true;
  try {
    const b64 = await blobToBase64(speakerFile.value);
    if (token !== liveSpeakerPrepToken) return liveSpeakerKey.value;
    const res = await prepareRealtimeSpeakerReference(b64);
    if (token !== liveSpeakerPrepToken) return liveSpeakerKey.value;
    liveSpeakerKey.value = res.speakerKey;
    liveSpeakerMedianF0Hz.value = res.medianF0Hz ?? null;
    return res.speakerKey;
  } catch (err) {
    if (token === liveSpeakerPrepToken) {
      liveError.value = err instanceof Error ? err.message : '参考音色准备失败';
    }
    return '';
  } finally {
    if (token === liveSpeakerPrepToken) {
      livePreparingSpeaker.value = false;
    }
  }
}

function runLiveAnimLoop() {
  if (!liveActive.value) {
    liveAnimRaf = 0;
    return;
  }
  const now = performance.now();
  while (liveAnimQueue.length > 1) {
    const head = liveAnimQueue[0];
    const elapsed = (now - head.startedAt) / 1000;
    if (elapsed >= head.durSec || liveAnimQueue.length > 3) {
      liveAnimQueue.shift();
      if (liveAnimQueue.length) liveAnimQueue[0].startedAt = now;
    } else {
      break;
    }
  }
  if (liveAnimQueue.length && liveTractGeometry.value) {
    const cur = liveAnimQueue[0];
    const t = Math.min(cur.durSec, Math.max(0, (now - cur.startedAt) / 1000));
    const st = interpM27AnimState(cur.anim, t);
    if (st) {
      liveAnimSnapshot.value = cur.anim;
      liveStateSnapshot.value = st;
    }
  }
  paintAnatomy();
  paintLiveMonitor();
  liveAnimRaf = requestAnimationFrame(runLiveAnimLoop);
}

async function startRealtimeMode() {
  if (liveActive.value || liveStarting.value || working.value || recording.value) return;
  stopPlayback();
  liveError.value = '';
  liveStarting.value = true;
  const startup = new AbortController();
  liveStartAbort = startup;
  const headPreparation = liveHead3D.value && liveSynthAudio.value
    ? new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timeout);
          startup.signal.removeEventListener('abort', finish);
          finishLiveHeadPreparation = null;
          resolve();
        };
        // A pending camera permission prompt must not block microphone capture.
        const timeout = setTimeout(finish, 2500);
        finishLiveHeadPreparation = finish;
        startup.signal.addEventListener('abort', finish, { once: true });
      })
    : Promise.resolve();
  try {
    const spkKey = await syncLiveSpeakerReference();
    if (startup.signal.aborted) return;
    liveTraceHistory = [];
    liveMinF0.value = 40;
    liveMaxF0.value = 320;
    liveMaxPR.value = 1200;
    liveAnimQueue = [];
    liveStateSnapshot.value = null;
    liveAnimSnapshot.value = null;
    liveTract3DSnapshot.value = null;
    liveLatestM27Row.value = null;

    liveError.value = '';
    liveStaleEngineWarning.value = false;
    const options = {
      includeTractGeometry: liveTractGeometry.value,
      includeTract3D: liveHead3D.value,
      useTimbreModel: liveUseTimbreModel.value,
      synthesizeAudio: liveSynthAudio.value,
      delayTargetMs: liveDelayTargetMs.value,
      autoGain: synthesisGainMode.value === 'peak',
      keepRecording: liveKeepRecording.value,
      speakerMode: getLiveSpeakerMode(),
      speakerKey: spkKey,
      speakerPitchMatch: liveSpeakerPitchMatch.value,
      phonationPreset: livePhonationPresetId.value,
      phonationStrength: livePhonationStrengthPct.value / 100,
      phonationF0Coupling: livePhonationPresetId.value !== 'none' ? livePhonationF0Coupling.value : null,
      phonationCreakIrregularity: livePhonationIsCreaky.value ? livePhonationCreakIrregPct.value / 100 : null,
    };
    await Promise.all([warmUpRealtimeModels(options, startup.signal), headPreparation]);
    if (startup.signal.aborted) return;

    const ctrl = new M27RealtimeController(
      options,
      {
        onStep: (data: RealtimeStepPayload, metrics: RealtimeMetrics) => {
          liveMetrics.value = metrics;
          if (!metrics.engineSupportsPhonation && (livePhonationPresetId.value !== 'none' || (showLiveSpeakerPitchMatch.value && liveSpeakerPitchMatch.value))) {
            liveStaleEngineWarning.value = true;
          } else if (metrics.engineSupportsPhonation) {
            liveStaleEngineWarning.value = false;
          }
          if (Array.isArray(data.m27_50hz_pa) && data.m27_50hz_pa.length) {
            for (const row of data.m27_50hz_pa) {
              liveTraceHistory.push(row);
              const f0 = row[17];
              const pr = row[18];
              if (Number.isFinite(f0) && f0 > 0) {
                if (f0 < liveMinF0.value) liveMinF0.value = Math.max(0, Math.floor(f0 / 10) * 10);
                if (f0 > liveMaxF0.value) liveMaxF0.value = Math.ceil(f0 / 50) * 50;
              }
              if (Number.isFinite(pr) && pr > liveMaxPR.value) {
                liveMaxPR.value = Math.min(1600, Math.ceil(pr / 200) * 200);
              }
            }
            if (liveTraceHistory.length > 250) {
              liveTraceHistory = liveTraceHistory.slice(-250);
            }
            liveLatestM27Row.value = data.m27_50hz_pa[data.m27_50hz_pa.length - 1];
          }
          if (liveHead3D.value && data.tract_3d && ctrl.cachedTopology3D.length) {
            const decoded3d = decodeTract3DFrame(data.tract_3d, ctrl.cachedTopology3D);
            if (decoded3d) liveTract3DSnapshot.value = decoded3d;
          }
          if (liveTractGeometry.value && data.tract_glottis_anim?.frames?.length) {
            const animChunk = data.tract_glottis_anim;
            liveAnimQueue.push({
              anim: animChunk,
              startedAt: performance.now(),
              durSec: Math.max(0.06, animChunk.duration_sec || animChunk.frames.length * 0.04),
            });
            if (liveAnimQueue.length > 4) {
              liveAnimQueue = liveAnimQueue.slice(-2);
            }
          }
        },
        onError: (msg: string) => {
          liveError.value = msg;
          status.value = msg;
        },
      },
    );

    try {
      await ctrl.start();
    } catch (error) {
      ctrl.stop();
      throw error;
    }
    if (startup.signal.aborted) {
      ctrl.stop();
      return;
    }
    liveController = ctrl;
    liveActive.value = true;
    status.value = liveHead3D.value
      ? '实时三维人头与声道联合重建已启动，请对着麦克风说话'
      : '实时声道重建已启动，请对着麦克风说话';
    cancelAnimationFrame(liveAnimRaf);
    liveAnimRaf = requestAnimationFrame(runLiveAnimLoop);
  } catch (err) {
    if (startup.signal.aborted) return;
    const msg = err instanceof Error ? err.message : '无法开启麦克风实时合成';
    liveError.value = msg;
    status.value = msg;
    store.pushToast(msg, 'warning', 3600);
  } finally {
    startup.abort();
    liveStartAbort = null;
    liveStarting.value = false;
  }
}

function stopRealtimeMode(preserveCapture = liveKeepRecording.value) {
  liveStartAbort?.abort();
  cancelAnimationFrame(liveAnimRaf);
  liveAnimRaf = 0;
  const ctrl = liveController;
  liveController = null;
  liveActive.value = false;
  liveAnimQueue = [];
  if (!ctrl) return;

  const captured = ctrl.stop();
  if (!preserveCapture || captured.durationSec < 0.35) {
    status.value = preserveCapture
      ? '已停止实时声道重建（片段过短未保留录音）'
      : '已停止实时声道重建（按设置未保留录音）';
    paintAll();
    return;
  }

  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  const micFile = encodeFloat32ToWavFile(captured.micPcm16k, 16000, `实时录音_${stamp}.wav`);
  chooseFile(micFile, true);
  if (captured.synthPcm16k.length >= 1600) {
    const synthFile = encodeFloat32ToWavFile(captured.synthPcm16k, 16000, `实时合成_${stamp}.wav`);
    replaceM27Url('neural', URL.createObjectURL(synthFile));
    outputs.value = { ...outputs.value, neural: synthFile };
  }
  status.value = `实时会话已结束并载入 ${captured.durationSec.toFixed(1)} s 录音，可在弹窗中裁剪、降噪或填写原文对齐`;
  store.pushToast(`已保存 ${captured.durationSec.toFixed(1)} s 实时录音，可按需裁剪与降噪`, 'success', 2800);
  recordPrepDraft.value = {
    target: 'source',
    file: micFile,
    originalFile: micFile,
    text: alignmentText.value,
    lang: alignmentLang.value,
    grid: null,
    fromExisting: true,
  };
  void nextTick(paintAll);
}

function toggleRealtimeMode() {
  if (liveActive.value) stopRealtimeMode(liveKeepRecording.value);
  else void startRealtimeMode();
}

watch(liveHead3D, (enabled) => {
  if (enabled && !liveTractGeometry.value) {
    liveTractGeometry.value = true;
  }
  void nextTick(paintAnatomy);
});

watch(vibMode, () => {
  paintAnatomy();
});

watch(liveActive, () => {
  void nextTick(paintAnatomy);
});

watch(synthesisGainMode, (mode) => {
  liveController?.updateOptions({ autoGain: mode === 'peak' });
});

watch(liveDelayTargetMs, (delayMs) => {
  liveController?.updateOptions({ delayTargetMs: delayMs });
  try { localStorage.setItem(liveDelayStorageKey, String(delayMs)); } catch { /* Keep the session selection. */ }
});

watch(
  [liveTractGeometry, liveHead3D, liveUseTimbreModel, liveSynthAudio, liveKeepRecording, speakerChoice, speakerFile],
  async () => {
    if (!liveActive.value || !liveController) return;
    const spkKey = await syncLiveSpeakerReference();
    liveController?.updateOptions({
      includeTractGeometry: liveTractGeometry.value,
      includeTract3D: liveHead3D.value,
      useTimbreModel: liveUseTimbreModel.value,
      synthesizeAudio: liveSynthAudio.value,
      keepRecording: liveKeepRecording.value,
      speakerMode: getLiveSpeakerMode(),
      speakerKey: spkKey,
    });
  },
);

watch(
  [liveSpeakerPitchMatch, livePhonationPresetId, livePhonationStrengthPct, livePhonationF0Coupling, livePhonationCreakIrregPct],
  () => {
    if (!liveActive.value || !liveController) return;
    liveController.updateOptions({
      speakerPitchMatch: liveSpeakerPitchMatch.value,
      phonationPreset: livePhonationPresetId.value,
      phonationStrength: livePhonationStrengthPct.value / 100,
      phonationF0Coupling: livePhonationPresetId.value !== 'none' ? livePhonationF0Coupling.value : null,
      phonationCreakIrregularity: livePhonationIsCreaky.value ? livePhonationCreakIrregPct.value / 100 : null,
    });
  },
);

function paintAlignedCurves() {
  const canvas = tracksCanvas.value;
  const wrap = tracksPlotWrap.value;
  const dataRows = rows.value;
  const curRow = interpolatedActiveRow.value;
  const lanes = paramLanes.value;
  if (!canvas || !wrap || !dataRows.length || !curRow || !lanes.length) return;

  const w = Math.max(160, Math.round(wrap.clientWidth));
  const h = wrap.clientHeight;
  if (!h) return;
  const laneHeight = h / lanes.length;
  const dpr = Math.min(2.25, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const pal = readThemePalette(canvas);
  const sem = readSemanticChartColors(canvas);
  ctx.fillStyle = pal.curvesBg;
  ctx.fillRect(0, 0, w, h);

  const vStart = clampedViewStartSec.value;
  const vSpan = Math.max(0.0001, viewSpanSec.value);
  const vEnd = vStart + vSpan;
  const xAt = (t: number) => ((t - vStart) / vSpan) * w;

  // Compute time gridlines identical to ReconstructionAlignment ticks
  const rawStep = vSpan / 6;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const step = ([1, 2, 5, 10].find((v) => v >= rawStep / mag) ?? 10) * mag;
  const fromTick = Math.ceil((vStart - 1e-8) / step);
  const toTick = Math.floor((vEnd + 1e-8) / step);

  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.strokeStyle = pal.zeroLine;
  ctx.lineWidth = 1;
  for (let ti = fromTick; ti <= toTick; ti++) {
    const tx = xAt(ti * step);
    if (tx >= 0 && tx <= w) {
      ctx.beginPath();
      ctx.moveTo(tx, 0);
      ctx.lineTo(tx, h);
      ctx.stroke();
    }
  }
  // Phoneme interval vertical guides
  ctx.setLineDash([2, 3]);
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = pal.anatomyMuted;
  for (const iv of phoneBoundaries.value) {
    const bx = xAt(iv.xmin);
    if (bx > 0 && bx < w) {
      ctx.beginPath();
      ctx.moveTo(bx, 0);
      ctx.lineTo(bx, h);
      ctx.stroke();
    }
  }
  ctx.restore();

  const readCell = (row: readonly number[], col: number, fallback = 0) => {
    const v = row[col];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  const iMin = Math.max(0, Math.floor((vStart - 0.08) * 50));
  const iMax = Math.min(dataRows.length - 1, Math.ceil((vEnd + 0.08) * 50));

  lanes.forEach((lane, li) => {
    const top = li * laneHeight;
    const bot = top + laneHeight;
    const plotT = top + 14;
    const plotB = bot - 4;
    const plotH = Math.max(12, plotB - plotT);

    // Subtle alternating row stripe + bottom divider
    if (li % 2 === 1) {
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = pal.laneBg;
      ctx.fillRect(0, top, w, laneHeight);
      ctx.restore();
    }
    ctx.strokeStyle = pal.laneBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, bot - 0.5);
    ctx.lineTo(w, bot - 0.5);
    ctx.stroke();

    const yAt = (val: number, vmin: number, vmax: number) => {
      const u = Math.max(0, Math.min(1, (val - vmin) / Math.max(1e-6, vmax - vmin)));
      return plotB - u * plotH;
    };

    if (lane.zeroVal !== undefined && lane.zeroRange) {
      const zy = yAt(lane.zeroVal, lane.zeroRange[0], lane.zeroRange[1]);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = pal.zeroLine;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(0, zy);
      ctx.lineTo(w, zy);
      ctx.stroke();
      ctx.restore();
    }

    for (const ser of lane.series) {
      const serColor = sem[ser.colorToken];
      const serFill = ser.fillToken ? sem[ser.fillToken] : '';
      if (serFill) {
        ctx.save();
        ctx.beginPath();
        let started = false;
        let firstX = 0;
        let lastX = 0;
        for (let i = iMin; i <= iMax; i++) {
          const x = xAt(i / 50);
          const y = yAt(readCell(dataRows[i], ser.col, ser.fallback), ser.min, ser.max);
          if (!started) {
            firstX = x;
            ctx.moveTo(x, plotB);
            started = true;
          }
          ctx.lineTo(x, y);
          lastX = x;
        }
        if (started) {
          ctx.lineTo(lastX, plotB);
          ctx.lineTo(firstX, plotB);
          ctx.closePath();
          ctx.fillStyle = serFill;
          ctx.fill();
        }
        ctx.restore();
      }

      ctx.save();
      if (ser.dash) ctx.setLineDash(ser.dash);
      ctx.strokeStyle = serColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (let i = iMin; i <= iMax; i++) {
        const x = xAt(i / 50);
        const y = yAt(readCell(dataRows[i], ser.col, ser.fallback), ser.min, ser.max);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      if (started) ctx.stroke();
      ctx.restore();
    }

    // Current frame readout pills in top-left of lane plot
    let rx = 8;
    ctx.font = '600 9.5px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const pxHead = xAt(playheadSec.value);

    for (const ser of lane.series) {
      const serColor = sem[ser.colorToken];
      const curVal = readCell(curRow, ser.col, ser.fallback);
      if (pxHead >= 0 && pxHead <= w) {
        const cy = yAt(curVal, ser.min, ser.max);
        ctx.fillStyle = serColor;
        ctx.beginPath();
        ctx.arc(pxHead, cy, 2.7, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = pal.dotStroke;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      const suffix = ser.unit ? (ser.unit === '°' || ser.unit === '%' ? ser.unit : ` ${ser.unit}`) : '';
      const txt = `${ser.label} ${curVal.toFixed(ser.dec)}${suffix}`;
      ctx.fillStyle = serColor;
      ctx.fillText(txt, rx, top + 8);
      rx += ctx.measureText(txt).width + 10;
    }
  });

  // Synchronized playhead line
  const headX = xAt(playheadSec.value);
  if (headX >= 0 && headX <= w) {
    ctx.save();
    ctx.strokeStyle = sem.playhead;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(headX, 0);
    ctx.lineTo(headX, h);
    ctx.stroke();
    ctx.restore();
  }
}

function paintAll() {
  paintAnatomy();
  paintAlignedCurves();
  if (liveActive.value && !liveHead3D.value) paintLiveMonitor();
}

const SCROLL_STEPS = 1000;
const scrollPosition = computed(() => maxViewStartSec.value > 0
  ? Math.round(SCROLL_STEPS * clampedViewStartSec.value / maxViewStartSec.value)
  : 0);

function setZoomAnchored(nextZoomRaw: number, anchorSec?: number, ratioInView = 0.5) {
  const nextZoom = Number(
    Math.max(M27_MIN_ZOOM, Math.min(M27_MAX_ZOOM, nextZoomRaw)).toFixed(2),
  );
  const pivot =
    anchorSec ??
    (playheadSec.value >= clampedViewStartSec.value && playheadSec.value <= viewEndSec.value
      ? playheadSec.value
      : clampedViewStartSec.value + 0.5 * viewSpanSec.value);
  const nextSpan = totalTimelineSec.value / nextZoom;
  const nextMax = Math.max(0, totalTimelineSec.value - nextSpan);
  zoom.value = nextZoom;
  viewStartSec.value = Math.max(0, Math.min(nextMax, pivot - ratioInView * nextSpan));
}

function stepZoom(dir: -1 | 1) {
  const cur = clampedZoom.value;
  if (dir > 0) {
    const next = M27_ZOOMS.find((z) => z > cur + 0.05) ?? M27_MAX_ZOOM;
    setZoomAnchored(next);
  } else {
    const prev = [...M27_ZOOMS].reverse().find((z) => z < cur - 0.05) ?? M27_MIN_ZOOM;
    setZoomAnchored(prev);
  }
}

function onCurvesWheel(event: WheelEvent) {
  const wrap = tracksPlotWrap.value;
  if (!wrap || totalTimelineSec.value <= 0) return;
  const rect = wrap.getBoundingClientRect();
  if (rect.width <= 0) return;

  if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey) {
    if (clampedZoom.value <= 1) return;
    event.preventDefault();
    const pxDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const tDelta = (pxDelta / rect.width) * viewSpanSec.value;
    viewStartSec.value = Math.max(0, Math.min(maxViewStartSec.value, clampedViewStartSec.value + tDelta));
    return;
  }

  event.preventDefault();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  const anchor = clampedViewStartSec.value + ratio * viewSpanSec.value;
  const factor = event.deltaY < 0 ? 1.22 : 1 / 1.22;
  setZoomAnchored(clampedZoom.value * factor, anchor, ratio);
}

function scrubCurves(e: PointerEvent) {
  if (!e.isPrimary || (e.type !== 'pointerdown' && !e.buttons)) return;
  const wrap = tracksPlotWrap.value;
  if (!wrap) return;
  if (e.type === 'pointerdown') {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  const rect = wrap.getBoundingClientRect();
  if (rect.width <= 0) return;
  const u = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  seek(clampedViewStartSec.value + u * viewSpanSec.value);
}

function updateClock() {
  if (!audio.value || audio.value.paused) return;
  playheadSec.value = audio.value.currentTime;
  frameLoop = requestAnimationFrame(updateClock);
}

async function play() {
  if (liveActive.value || liveStarting.value || recording.value || incomingDialogOpen.value || assignModalOpen.value) {
    return;
  }
  stopAuditionWindow();
  const el = audio.value;
  if (!el || !selectedUrl.value) return;
  if (!el.paused) {
    stopPlayback();
    return;
  }
  if (el.ended) {
    el.currentTime = 0;
    playheadSec.value = 0;
  } else if (Math.abs(el.currentTime - playheadSec.value) > 0.03) {
    el.currentTime = playheadSec.value;
  }
  const requestedUrl = selectedUrl.value;
  try {
    el.playbackRate = speed.value;
    await el.play();
  } catch {
    if (requestedUrl === selectedUrl.value) {
      status.value = '当前音频未能播放，请检查音频格式';
    }
  }
}

function onPlaying() {
  switchingVersionSeek = null;
  playing.value = true;
  cancelAnimationFrame(frameLoop);
  updateClock();
}

function onAudioPause() {
  playing.value = false;
  cancelAnimationFrame(frameLoop);
}

function onAudioLoadedMetadata() {
  const el = audio.value;
  mediaDuration.value = Number.isFinite(el?.duration) ? el!.duration : 0;
  const target = switchingVersionSeek ?? playheadSec.value;
  switchingVersionSeek = null;
  if (el && target > 0 && mediaDuration.value > 0) {
    const clamped = Math.min(target, mediaDuration.value);
    el.currentTime = clamped;
    playheadSec.value = clamped;
  }
}

function onAudioTimeUpdate() {
  if (!playing.value || switchingVersionSeek !== null) return;
  playheadSec.value = audio.value?.currentTime || 0;
}

function selectAudioVersion(next: Version) {
  if (version.value === next) return;
  const keepPlayhead = playheadSec.value;
  stopPlayback();
  switchingVersionSeek = keepPlayhead;
  version.value = next;
  playheadSec.value = keepPlayhead;
  void nextTick(() => {
    if (audio.value && audio.value.readyState >= 1) {
      const clamped = Math.min(audio.value.duration || keepPlayhead, keepPlayhead);
      audio.value.currentTime = clamped;
      playheadSec.value = clamped;
      switchingVersionSeek = null;
    }
  });
  if (historyId.value) rememberSource();
}

function seek(t: number) {
  if (!Number.isFinite(t)) return;
  playheadSec.value = Math.max(0, Math.min(totalTimelineSec.value, t));
  if (audio.value && audio.value.readyState >= 1) {
    audio.value.currentTime = Math.min(audio.value.duration || playheadSec.value, playheadSec.value);
  }
}

watch(playheadSec, (time) => {
  if (playing.value && clampedZoom.value > 1 && (time < clampedViewStartSec.value || time > viewEndSec.value)) {
    viewStartSec.value = Math.max(0, Math.min(maxViewStartSec.value, time - 0.15 * viewSpanSec.value));
  }
});

watch([zoom, viewStartSec], () => void nextTick(paintAlignedCurves));

watch(speed, (n) => {
  if (audio.value) audio.value.playbackRate = n;
});

watch(
  [
    playheadSec,
    anim,
    rows,
    showLabels,
    vibMode,
    curveMode,
    liveActive,
    liveHead3D,
    rightAnatomyShare,
    store.resolvedColorMode,
    store.paletteId,
    store.customAccentHex,
    store.surfaceStyle,
    store.anatomyAppearance,
  ],
  () => nextTick(paintAll),
  { flush: 'post' },
);

function tractParameters(row: number[], lm: number[] | undefined) {
  const params = defaultTractParams();
  const names = [
    'HX', 'HY', 'JX', 'JA', 'LP', 'LD', 'VS', 'VO',
    'TCX', 'TCY', 'TTX', 'TTY', 'TBX', 'TBY', 'TS1', 'TS2', 'TS3',
  ] as const;
  names.forEach((key, i) => {
    params[key] = row[i];
  });
  if (lm?.length === 8) {
    params.TRX = lm[6];
    params.TRY = lm[7];
  }
  return params;
}

async function sendAudio(target: AudioDestination) {
  await waitForSourceNormalization();
  if (target === 'arranger' && !hasResult.value) {
    const sourceToken = sourceGeneration;
    if (!sourceFile.value || working.value) return;
    await run('reconstruct', 'arranger');
    if (unmounted || sourceToken !== sourceGeneration) return;
    if (!hasResult.value) {
      status.value = '未能送入编曲 · ' + (status.value || '请等当前操作结束后重试声道重建');
      return;
    }
  }
  const chosen = version.value;
  const url = selectedUrl.value;
  if (!url) return;
  const source = sourceReference.value;
  const speakerInputBlob = sourceFile.value;
  const token = sourceGeneration;
  const timeline = anim.value;
  try {
    const blob = chosen === 'source' ? sourceFile.value : outputs.value[chosen];
    if (!blob) throw new Error('没有可传输的音频');
    const speakerWavBase64 = target === 'annotation' && speakerInputBlob
      ? await blobToBase64(
          /^audio\/(?:x-)?wav(?:e)?$/i.test(speakerInputBlob.type)
            ? speakerInputBlob
            : audioBufferFile(await decodeBlobCached(speakerInputBlob), '输入音色'),
        )
      : undefined;
    if (token !== sourceGeneration || url !== urls.value[chosen]) return;
    const name =
      chosen === 'source'
        ? sourceFile.value instanceof File
          ? sourceFile.value.name
          : sourceName.value || '音频.wav'
        : `${(sourceName.value || '音频').replace(/\.[^.]*$/, '')} · ${chosenName[chosen]}.wav`;
    const label = source?.title ?? name;
    const file = new File([blob], name, { type: blob.type || 'audio/wav' });
    const cleanedGrid = sourceTextGrid.value ? cleanTextGridWordLabels(sourceTextGrid.value) : null;
    const clip = clipFromTextGrid(
      cleanedGrid,
      safeEndSmp(cleanedGrid),
      store.activeClipId.value,
      store.activeVoiceId.value,
      source?.phones,
    );
    const frames = rows.value.length
      ? rows.value.map((row, i) => ({
          u: i / Math.max(1, rows.value.length - 1),
          params: tractRecordToArray19(
            tractParameters(row, interpM27AnimState(timeline, i / 50)?.lm),
          ),
        }))
      : undefined;

    const continuumRow = interpolatedActiveRow.value ?? activeRow.value;
    if ((target === 'continuumA' || target === 'continuumB') && continuumRow) {
      const endpoint = {
        label: sourceName.value || label,
        timeSec: playheadSec.value,
        params: tractParameters(continuumRow, state.value?.lm),
        f0Hz: continuumRow[17],
        prPa: continuumRow[18],
      };
      (target === 'continuumA' ? m27ImportedEndpointA : m27ImportedEndpointB).value = endpoint;
    }

    const rawSourceForMixer =
      target === 'mixer' && speakerInputBlob
        ? speakerInputBlob instanceof File
          ? speakerInputBlob
          : new File([speakerInputBlob], sourceName.value || '原声录音.wav', {
              type: speakerInputBlob.type || 'audio/wav',
            })
        : undefined;
    const reconBlobForMixer =
      target === 'mixer'
        ? chosen !== 'source'
          ? outputs.value[chosen]
          : (outputs.value.neural ?? outputs.value.physical)
        : null;
    const reconstructedForMixer = reconBlobForMixer
      ? new File([reconBlobForMixer], `${(sourceName.value || '音频').replace(/\.[^.]*$/, '')} · 声道重建合成.wav`, {
          type: reconBlobForMixer.type || 'audio/wav',
        })
      : undefined;

    sendWorkspaceAudio(target, {
      file: target === 'mixer' && rawSourceForMixer ? rawSourceForMixer : file,
      analysisFile: (target === 'continuumA' || target === 'continuumB') && speakerInputBlob instanceof File
        ? speakerInputBlob : undefined,
      rawSourceFile: rawSourceForMixer,
      reconstructedFile: reconstructedForMixer,
      label,
      clip,
      frames,
      m27RowsPa: rows.value.length ? rows.value : undefined,
      textGrid: cleanedGrid ?? undefined,
      alignmentText: alignmentText.value.trim() || undefined,
      speakerWavBase64,
      sourceKind: 'audio-reconstruct',
    });
  } catch (error) {
    if (token === sourceGeneration) status.value = safeReason(error);
  }
}

// T-04: Check incoming audio sent from ResearchMainView / VoiceMixerView (`m27Align`)
function consumeIncomingM27Align() {
  const incoming = takeWorkspaceAudio('m27Align');
  if (!incoming?.file) return;
  chooseFile(incoming.file);
  setSpeaker(null, inputVoice);
  if (incoming.alignmentText?.trim()) {
    alignmentText.value = incoming.alignmentText.trim();
  } else if (incoming.clip) {
    const sylText = incoming.clip.syllable_order
      .map((sid) => incoming.clip?.syllables[sid]?.text?.trim() ?? '')
      .filter(Boolean)
      .join('');
    if (sylText && /[\u4e00-\u9fffA-Za-z]/.test(sylText)) {
      alignmentText.value = sylText;
    }
  }
  if (incoming.textGrid) {
    sourceTextGrid.value = cleanTextGridWordLabels(incoming.textGrid);
    sourceTextGridName.value = '来自工作区 · 对齐边界';
  }
  incomingDialogOpen.value = true;
}

function confirmIncomingAndRun() {
  incomingDialogOpen.value = false;
  void run('reconstruct');
}

watch(
  () => store.researchTab.value,
  (tab) => {
    if (tab === 'm27') {
      consumeIncomingM27Align();
      void nextTick(paintAll);
    }
  },
);

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function handleReconstructionKeydown(ev: KeyboardEvent) {
  if (ev.defaultPrevented) return;
  if (ev.key === 'Escape') {
    if (assignModalOpen.value) {
      ev.preventDefault();
      assignModalOpen.value = false;
      return;
    }
    if (incomingDialogOpen.value) {
      ev.preventDefault();
      incomingDialogOpen.value = false;
      return;
    }
  }
  if (isEditableShortcutTarget(ev.target)) return;
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey) {
    const k = ev.key.toLowerCase();
    if (k === 'x' && canEditAudio.value && sourceFile.value && selectionSec.value) {
      ev.preventDefault();
      void cutSourceAudio('selection');
      return;
    }
    if (k === 'z' && canEditAudio.value && cutUndo.value.length) {
      ev.preventDefault();
      undoSourceCut();
      return;
    }
  }
}

let statusProbeAbort: AbortController | null = null;
onMounted(() => {
  unmounted = false;
  void listReconstructionHistory()
    .then((entries) => {
      if (!unmounted) {
        const current = history.value;
        history.value = [
          ...current,
          ...entries.filter(
            (entry) =>
              !entry.sampleId && !entry.reference && !current.some((item) => item.id === entry.id),
          ),
        ];
      }
    })
    .catch(() => {
      if (!unmounted) historyStatus.value = '本地历史无法读取';
    });
  void loadReconstructionVoices().catch(() => undefined);
  void mixerRequest<MixerMeta>()
    .then((meta) => {
      if (!unmounted && Array.isArray(meta?.presets) && meta.presets.length) {
        livePhonationPresets.value = meta.presets.map(normalizeMixerPreset);
      }
    })
    .catch(() => undefined);

  consumeIncomingM27Align();

  observer = new ResizeObserver(() => void nextTick(paintAll));
  if (rightColEl.value) observer.observe(rightColEl.value);
  if (tracksPlotWrap.value) observer.observe(tracksPlotWrap.value);

  void nextTick(() => {
    if (audio.value && playheadSec.value > 0 && selectedUrl.value) {
      audio.value.currentTime = playheadSec.value;
    }
    paintAll();
  });

  window.addEventListener('vocalcut:m27-play', play);
  window.addEventListener('keydown', handleReconstructionKeydown, true);
  window.addEventListener('vocalcut:tour-action', handleM27TourAction);
});

let tourActionAbort: AbortController | null = null;
async function loadTourDemoClip(): Promise<boolean> {
  const slot = ONBOARDING_AUDIO_SLOTS.zh_spk_a;
  tourActionAbort?.abort();
  tourActionAbort = new AbortController();
  const res = await fetchOnboardingAudioFile(slot.relativeUrl, slot.filename, tourActionAbort.signal);
  if (unmounted) return false;
  if (!res.ok) {
    if (res.reason === 'missing') {
      store.pushToast(
        `尚未放置试用音频（public/${slot.relativeUrl}），可直接拖入 WAV 或点击麦克风体验`,
        'info',
        3600,
      );
    } else if (res.reason !== 'aborted') {
      store.pushToast('读取案例音频失败，可直接导入本地录音体验', 'warning', 2800);
    }
    return false;
  }
  chooseFile(res.file);
  if (slot.transcript.trim()) {
    alignmentText.value = slot.transcript;
    alignmentLang.value = slot.lang;
    editReferenceText();
    rememberSource();
  }
  return true;
}

async function handleM27TourAction(e: Event): Promise<void> {
  const detail = (e as CustomEvent<{ actionId?: string; done?: (ok?: boolean) => void }>).detail;
  const actionId = detail?.actionId;
  if (
    actionId !== 'm27-load-demo' &&
    actionId !== 'm27-align-demo' &&
    actionId !== 'm27-run-demo' &&
    actionId !== 'm27-play-neural' &&
    actionId !== 'm27-toggle-labels'
  ) {
    return;
  }

  if (actionId === 'm27-toggle-labels') {
    showLabels.value = true;
    await nextTick();
    paintAnatomy();
    detail?.done?.(true);
    return;
  }

  if (actionId === 'm27-load-demo') {
    const ok = await loadTourDemoClip();
    if (ok) {
      store.pushToast(
        `已载入案例音频「${ONBOARDING_AUDIO_SLOTS.zh_spk_a.label}」，请依次点击「按原文对齐」和「开始声道重建」`,
        'success',
        3000,
      );
    }
    detail?.done?.(ok);
    return;
  }

  if (actionId === 'm27-align-demo') {
    const ready = sourceFile.value ? true : await loadTourDemoClip();
    if (!ready || unmounted) {
      detail?.done?.(false);
      return;
    }
    if (!alignmentText.value.trim()) {
      alignmentText.value = ONBOARDING_AUDIO_SLOTS.zh_spk_a.transcript;
      alignmentLang.value = ONBOARDING_AUDIO_SLOTS.zh_spk_a.lang;
      editReferenceText();
    }
    await nextTick();
    await alignTranscript();
    detail?.done?.(!unmounted);
    return;
  }

  if (actionId === 'm27-run-demo') {
    const ready = sourceFile.value ? true : await loadTourDemoClip();
    if (!ready || unmounted) {
      detail?.done?.(false);
      return;
    }
    voiceRenderMode.value = 'neural';
    await run('reconstruct');
    if (unmounted) return;
    if (urls.value.neural) {
      selectAudioVersion('neural');
    }
    detail?.done?.(hasResult.value);
    return;
  }

  if (actionId === 'm27-play-neural') {
    if (!hasResult.value || !urls.value.neural) {
      const ready = sourceFile.value ? true : await loadTourDemoClip();
      if (!ready || unmounted) {
        detail?.done?.(false);
        return;
      }
      voiceRenderMode.value = 'neural';
      await run('reconstruct');
      if (unmounted) return;
    }
    const targetVer: Version = urls.value.neural ? 'neural' : urls.value.physical ? 'physical' : 'source';
    stopPlayback();
    selectAudioVersion(targetVer);
    playheadSec.value = 0;
    await nextTick();
    await play();
    detail?.done?.(Boolean(urls.value[targetVer]));
  }
}

watch(tracksPlotWrap, (el, prev) => {
  if (prev) observer?.unobserve(prev);
  if (el) observer?.observe(el);
});

watch(liveMonitorPlotWrap, (el, prev) => {
  if (prev) observer?.unobserve(prev);
  if (el) observer?.observe(el);
});

onBeforeUnmount(() => {
  unmounted = true;
  statusProbeAbort?.abort();
  statusProbeAbort = null;
  sourceGeneration++;
  cutGeneration++;
  cancelTranscription();
  // T-55: Stop active playback/mic ONLY — preserve all reconstructed data, URLs, and boundaries in m27Session!
  stopRealtimeMode(false);
  stopPlayback();
  discardCapture();
  discardSpeakerCapture();
  observer?.disconnect();
  void auditionCtx?.close().catch(() => undefined);
  auditionCtx = null;
  window.removeEventListener('vocalcut:m27-play', play);
  window.removeEventListener('keydown', handleReconstructionKeydown, true);
  window.removeEventListener('vocalcut:tour-action', handleM27TourAction);
  tourActionAbort?.abort();
  tourActionAbort = null;
});
</script>

<template>
  <div
    class="reconstruction"
    :style="{
      '--m27-left-w': `${leftColWidth}px`,
      '--m27-right-w': `${rightColWidth}px`,
      '--m27-axis-w': `${M27_AXIS_WIDTH_PX}px`,
    }"
  >
    <audio
      ref="audio"
      :src="selectedUrl || undefined"
      preload="auto"
      @loadedmetadata="onAudioLoadedMetadata"
      @timeupdate="onAudioTimeUpdate"
      @playing="onPlaying"
      @pause="onAudioPause"
      @ended="stopPlayback"
      @error="selectedUrl && (status = '此音频无法播放，请检查文件完整性或浏览器编码支持')"
    />

    <!-- LEFT COLUMN: Control & Handoff Column (T-09, T-10, T-11, T-52) -->
    <aside class="panel m27-left-col">
      <header class="p-head">
        <strong>重建控制与流转</strong>
        <ModuleGuideButton module-id="m27" size="xs" data-tour="m27-guide-btn" />
      </header>

      <div class="inspector-scroll">
        <section v-if="history.length || historyStatus">
          <h3>本地重建历史</h3>
          <CustomSelect
            v-if="history.length"
            size="sm"
            aria-label="本地重建历史"
            placeholder="恢复历史重建记录"
            :model-value="historyId"
            :options="
              history.map((item) => ({
                value: item.id,
                label: `${item.neural || item.physical ? '已重建' : '原录音'} · ${item.name} · ${new Date(item.updated).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
              }))
            "
            @update:model-value="(v) => openHistory(String(v))"
          />
          <small v-if="historyStatus" role="status">{{ historyStatus }}</small>
        </section>

        <section data-tour="m27-input">
          <h3>输入音频</h3>
          <div
            class="source-box"
            @dragover.prevent
            @drop.prevent="
              (e) => {
                const f = e.dataTransfer?.files[0];
                if (f) chooseFile(f);
              }
            "
          >
            <div class="file-line">
              <IconSvg name="waveform" :size="16" />
              <span :title="sourceName">{{ sourceName || '拖入或导入待重建录音' }}</span>
            </div>
            <ReconstructionMicControl
              :acquiring="acquiringMic || cutting"
              :recording="recording"
              :elapsed="micElapsed"
              :bars="micBars"
              :quiet="micQuiet"
              announce-quiet
              @toggle="toggleRecording"
            >
              <button type="button" class="btn sm" @click="input?.click()">
                <IconSvg name="upload" :size="12" />
                <span>导入音频</span>
              </button>
            </ReconstructionMicControl>
          </div>
          <input ref="input" type="file" hidden accept="audio/*" @change="onFileChange($event)" />

          <div v-if="sourceFile" class="button-row">
            <button
              type="button"
              class="btn xs"
              :disabled="audioEditBlocked"
              title="打开波形裁剪、去首尾静音、降噪与原文自动音素对齐弹窗"
              @click="openSourceAudioEditor"
            >
              <IconSvg name="trim" :size="11" />
              <span>编辑录音</span>
            </button>
            <button
              type="button"
              class="btn xs"
              :disabled="working || recording || transcribing || cleaningSource || cutting || sourceFile !== originalSource"
              @click="processSource"
            >
              {{ cleaningSource ? '降噪中…' : '降噪输入' }}
            </button>
            <button
              v-if="sourceFile !== originalSource"
              type="button"
              class="btn xs"
              :disabled="working || cutting"
              @click="restoreSourceAudio"
            >
              恢复原音
            </button>
            <button type="button" class="btn xs" :disabled="cutting" @click="textGridInput?.click()">
              导入 TextGrid
            </button>
          </div>
          <input ref="textGridInput" type="file" hidden accept=".TextGrid,.txt" @change="attachTextGrid" />
          <small v-if="sourceTextGridName" class="reference-name" :title="sourceTextGridName">
            当前标注：{{ sourceTextGridName }}
          </small>

          <div v-if="sourceFile" class="align-editor" data-tour="m27-align">
            <div class="align-label-row">
              <span>对齐参考文本</span>
              <ReconstructionTranscriptionActions
                :cloud="!!deepSeekAsrKey"
                :blocked="transcriptionBlocked"
                :transcribing="transcribing"
                :transcribing-mode="transcribingMode"
                :install="localAsrStatus"
                :install-message="localAsrMessage"
                :pending-model="localAsrPending"
                @transcribe="transcribeReferenceText"
                @choose="localAsr.choose"
                @remove="localAsr.remove"
                @refresh="localAsr.refresh"
              />
            </div>
            <small v-if="localAsrMessage" role="status">{{ localAsrMessage }}</small>
            <textarea
              v-model="alignmentText"
              class="inp"
              maxlength="4000"
              rows="2"
              placeholder="输入录音对应的中文或英文（可留空直接重建）"
              :disabled="working"
              @input="editReferenceText"
              @change="rememberSource()"
            />
            <div class="button-row">
              <CustomSelect
                size="xs"
                class="align-lang-select"
                aria-label="对齐语言"
                :title="deepSeekAsrKey ? 'DeepSeek 自动检测录音语种，此处设置用于原文对齐' : undefined"
                :disabled="working"
                :model-value="alignmentLang"
                :options="alignLangOptions"
                @update:model-value="
                  (v) => {
                    alignmentLang = String(v) as 'auto' | 'zh' | 'en';
                    editReferenceText();
                    rememberSource();
                  }
                "
              />
              <button
                type="button"
                class="btn xs"
                :disabled="transcriptionBlocked || !alignmentText.trim() || fixedTextGrid"
                @click="alignTranscript"
              >
                {{ aligning ? '对齐中…' : '按原文对齐' }}
              </button>
            </div>
            <small role="status">
              {{
                alignmentMessage ||
                (fixedTextGrid
                  ? '已采用导入的 TextGrid 边界。'
                  : '提供准确原文可提升 Vox2Align-Lite v2 边界精度；留空亦可直接重建。')
              }}
            </small>
          </div>
        </section>

        <section data-tour="m27-engine">
          <h3>目标音色 <small>神经重合成</small></h3>
          <div class="speaker-select-row">
            <CustomSelect
              aria-label="目标音色选择"
              size="sm"
              class="speaker-select-grow"
              placeholder="选择目标音色"
              :model-value="speakerChoice"
              :options="speakerOptions"
              @update:model-value="chooseSpeakerReference"
            />
            <button type="button" class="btn xs" :disabled="recordingSpeaker" @click="speakerInput?.click()">上传参考音</button>
          </div>
          <ReconstructionMicControl
            size="xs"
            idle-label="录参考音"
            active-label="停止录音"
            :acquiring="acquiringSpeakerMic"
            :recording="recordingSpeaker"
            :elapsed="speakerMicElapsed"
            :bars="speakerMicBars"
            :quiet="speakerMicQuiet"
            :disabled="working || recording || acquiringMic || liveActive"
            @toggle="toggleSpeakerRecording"
          />
          <div v-if="speakerFile" class="field-row">
            <span class="reference-name muted" :title="speakerLabel">{{ speakerLabel }}</span>
            <button
              type="button"
              class="btn xs icon-only"
              title="清除自定义参考音，恢复沿用输入音色"
              @click="setSpeaker(null, inputVoice)"
            >
              <IconSvg name="close" :size="11" />
            </button>
          </div>
          <input ref="speakerInput" type="file" hidden accept="audio/*" @change="onFileChange($event, true)" />
          <div v-if="speakerFile" class="button-row">
            <button
              type="button"
              class="btn xs"
              :disabled="working || cleaningSpeaker || recordingSpeaker"
              @click="openSpeakerAudioEditor"
            >
              <IconSvg name="trim" :size="11" />
              <span>编辑参考音</span>
            </button>
            <button
              type="button"
              class="btn xs"
              :disabled="working || cleaningSpeaker || speakerFile !== originalSpeaker"
              @click="processSpeaker"
            >
              {{ cleaningSpeaker ? '降噪中…' : '降噪参考音' }}
            </button>
            <button
              v-if="speakerFile !== originalSpeaker"
              type="button"
              class="btn xs"
              :disabled="working"
              @click="restoreSpeakerAudio"
            >
              恢复原音
            </button>
          </div>
          <div v-if="speakerFile" class="field-row">
            <input
              v-model="voiceName"
              class="inp"
              placeholder="保存此音色名称"
              aria-label="音色名称"
              maxlength="80"
            />
            <button
              type="button"
              class="btn xs"
              :disabled="!voiceName.trim() || savingVoice || cleaningSpeaker"
              @click="saveVoice"
            >
              保存音色
            </button>
          </div>
        </section>

        <section data-tour="m27-run">
          <h3>声道反演与重合成</h3>
          <div class="engine-select-grid">
            <label class="engine-select-field">
              <span>合成模型</span>
              <VoiceRenderSelect size="sm" :custom-title="voiceRenderHint" />
            </label>
          </div>
          <div class="button-row main-run-row">
            <button
              type="button"
              class="btn primary sm"
              :disabled="!sourceFile || transcriptionBlocked || cleaningSpeaker"
              @click="run('reconstruct')"
            >
              <IconSvg name="reconstruct" :size="13" />
              <span>{{ workingAction === 'reconstruct' ? '重建中…' : '开始声道重建' }}</span>
            </button>
            <button
              type="button"
              class="btn sm"
              :disabled="!hasResult || transcriptionBlocked || cleaningSpeaker"
              @click="run('resynthesize')"
            >
              <IconSvg name="refresh" :size="12" />
              <span>{{ workingAction === 'resynthesize' ? '重合成中…' : '轨迹重合成' }}</span>
            </button>
          </div>
          <p v-if="status" class="status-line" role="status">{{ status }}</p>
        </section>

        <section class="live-rt-section" data-tour="m27-realtime">
          <div class="live-rt-head">
            <h3>实时声道重建与合成</h3>
            <span v-if="liveActive" class="live-rt-badge mono">LIVE · {{ liveMetrics.computeMs.toFixed(0) }} ms</span>
          </div>
          <div class="live-rt-options">
            <label class="live-rt-check" title="开启后实时求解 JD2 正中矢状面轮廓与声门动画，关闭可进一步降低延迟">
              <input v-model="liveTractGeometry" type="checkbox" :disabled="liveStarting" />
              <span>实时声道构型</span>
            </label>
            <label class="live-rt-check" title="开启后在中间栏呈现透视三维人头、绑定到头模的摄像头特征点与内部声道联合重建，并根据面部特征微调人头外貌">
              <input v-model="liveHead3D" type="checkbox" :disabled="liveStarting" />
              <span>实时三维人头重建（摄像头）</span>
            </label>
            <label class="live-rt-check" title="开启后通过 Vox2Spk-Lite 一次性提取上方所选目标音色；关闭则直用默认讲解声纹">
              <input v-model="liveUseTimbreModel" type="checkbox" :disabled="liveStarting" />
              <span>加载音色模型</span>
            </label>
            <label class="live-rt-check" title="开启后实时播放 Tract2Vox-Lite 神经合成音频（建议佩戴耳机防回声）">
              <input v-model="liveSynthAudio" type="checkbox" :disabled="liveStarting" />
              <span>实时合成音频</span>
            </label>
            <label class="live-rt-check" title="默认不保留录音以免污染语谱图；勾选后在停止实时合成时将本段录音与合成音载入工作区">
              <input v-model="liveKeepRecording" type="checkbox" :disabled="liveStarting" />
              <span>保留实时录音</span>
            </label>
          </div>
          <div class="live-rt-options live-rt-voice-box">
            <div class="live-rt-field">
              <div class="live-rt-field-head">
                <span>实时音色</span>
                <small class="muted">{{ liveUseTimbreModel ? '运行中可随时切换' : '已关模型 · 默认声纹' }}</small>
              </div>
              <div class="speaker-select-row">
                <CustomSelect
                  size="xs"
                  class="speaker-select-grow"
                  aria-label="实时合成音色"
                  placeholder="选择实时音色"
                  :min-menu-width="210"
                  :disabled="liveStarting || cleaningSpeaker"
                  :model-value="speakerChoice"
                  :options="speakerOptions"
                  @update:model-value="selectLiveSpeaker"
                />
                <button
                  type="button"
                  class="btn xs"
                  :disabled="liveStarting || cleaningSpeaker"
                  title="上传自定义参考音作为实时合成目标音色"
                  @click="triggerLiveSpeakerUpload"
                >
                  上传参考音
                </button>
              </div>
              <label
                v-if="showLiveSpeakerPitchMatch"
                class="live-rt-check"
                title="开启后按目标发音人的参考中位基频比例自动平移实时基频（与语音合成页一致），关闭则保留您自己的原始音域"
              >
                <input v-model="liveSpeakerPitchMatch" type="checkbox" :disabled="liveStarting" />
                <span>
                  匹配目标音色基频<template v-if="liveTargetSpeakerF0Display !== null">（约 {{ Math.round(liveTargetSpeakerF0Display) }} Hz）</template>
                </span>
              </label>
            </div>
            <div class="live-rt-field">
              <div class="live-rt-field-head">
                <span>发声类型</span>
                <small class="muted">{{ activeLivePhonationPreset ? '复用发声调音台' : '保持原声' }}</small>
              </div>
              <CustomSelect
                size="xs"
                aria-label="实时发声类型"
                placeholder="选择发声类型"
                :min-menu-width="230"
                :disabled="liveStarting"
                :model-value="livePhonationPresetId"
                :options="livePhonationOptions"
                @update:model-value="selectLivePhonationPreset"
              />
            </div>
            <template v-if="activeLivePhonationPreset">
              <small class="live-rt-desc muted">{{ activeLivePhonationPreset.desc }}</small>
              <CompactSlider
                v-model="livePhonationStrengthPct"
                label="调制强度"
                :min="0"
                :max="100"
                :step="5"
                :decimals="0"
                unit="%"
                :default-value="85"
                :disabled="liveStarting"
              />
              <CompactSlider
                v-if="livePhonationIsCreaky"
                v-model="livePhonationCreakIrregPct"
                label="脉冲不规则"
                :min="0"
                :max="100"
                :step="5"
                :decimals="0"
                unit="%"
                :default-value="livePhonationDefaultIrregPct"
                :disabled="liveStarting"
              />
              <label
                v-if="livePhonationHasF0Option"
                class="live-rt-check"
                title="开启后同步按所选发声类型的典型音域平移基频（如假声抬高、嘎裂压低）"
              >
                <input v-model="livePhonationF0Coupling" type="checkbox" :disabled="liveStarting" />
                <span>同步音域基频联动</span>
              </label>
            </template>
          </div>
          <div v-if="liveActive && liveSynthAudio" class="live-rt-options">
            <label class="live-rt-delay">
              <span>监听延迟</span>
              <CustomSelect
                size="xs"
                aria-label="监听延迟"
                :model-value="liveDelayTargetMs"
                :options="liveDelayOptions"
                @update:model-value="(v) => (liveDelayTargetMs = Number(v) as RealtimeDelayTargetMs)"
              />
            </label>
            <small id="m27-live-delay-tip" class="live-rt-tip muted">默认 0.7 秒。合成效果不理想时，可试试 1.0 秒。</small>
          </div>
          <button
            type="button"
            class="btn sm live-rt-action"
            :class="liveActive ? 'danger' : 'primary'"
            :disabled="liveStarting || working || recording || cutting"
            @click="toggleRealtimeMode"
          >
            <IconSvg :name="liveActive ? 'stop' : 'mic'" :size="13" />
            <span>{{ liveStarting ? '正在准备实时重建…' : liveActive ? '停止实时合成' : '开始实时合成' }}</span>
          </button>
          <div v-if="liveActive" class="live-rt-telemetry mono">
            <div class="live-meter-track" aria-hidden="true">
              <div class="live-meter-fill" :style="{ width: `${Math.min(100, Math.round(liveMetrics.levelRms * 520))}%` }" />
            </div>
            <span>
              {{ liveMetrics.elapsedSec.toFixed(1) }} s ·
              {{ liveMetrics.voiced ? `F0 ${liveMetrics.f0Hz.toFixed(0)} Hz` : '静音/清音' }} ·
              PR {{ liveMetrics.prPa.toFixed(0) }} Pa
            </span>
            <span class="muted">{{ liveTimbreStatusText }}</span>
            <span v-if="showLiveSpeakerPitchMatch && liveSpeakerPitchMatch && Math.abs(liveMetrics.speakerF0Ratio - 1) > 0.02" class="muted">
              音色基频 ×{{ liveMetrics.speakerF0Ratio.toFixed(2) }}<template v-if="liveMetrics.speakerTargetF0Hz">（参考 {{ Math.round(liveMetrics.speakerTargetF0Hz) }} Hz）</template>
            </span>
            <span v-if="activeLivePhonationPreset" class="muted">
              发声调制 · {{ activeLivePhonationShortLabel }}
            </span>
            <span v-if="liveStaleEngineWarning" class="live-rt-err" role="status">
              检测到本地 Python 引擎尚未重启加载新模块，请重启引擎后发声调制与音色基频偏移即可生效。
            </span>
            <span v-if="liveMetrics.playbackDelayMs !== null" class="muted" title="从麦克风音频进入处理线程到安排播放的估计时差，不含设备缓冲">
              监听延迟约 {{ liveMetrics.playbackDelayMs }} ms
            </span>
            <span v-if="liveMetrics.playbackRestarts || liveMetrics.skippedInputMs" class="muted">
              播放重缓冲 {{ liveMetrics.playbackRestarts }} 次 · 跳过输入 {{ liveMetrics.skippedInputMs }} ms
            </span>
          </div>
          <small v-else class="live-rt-tip muted">
            纯 ONNX 本地滑窗推理；开启实时音频建议佩戴耳机防回声。默认停止后不留存录音，需要载入语谱图时请勾选「保留实时录音」。
          </small>
          <small v-if="liveError" class="live-rt-err" role="alert">{{ liveError }}</small>
        </section>

        <section class="handoff-section" data-tour="m27-handoff">
          <h3>一键流转至工作区</h3>
          <button
            type="button"
            class="btn primary sm handoff-primary"
            :disabled="!selectedUrl"
            title="将当前音频、50 Hz 27 维声道轨迹及校正后的音节/音素边界完整送回标注时间轴"
            @click="sendAudio('annotation')"
          >
            <IconSvg name="timeline" :size="14" />
            <span>送回标注页</span>
          </button>
          <div class="handoff-grid">
            <button
              type="button"
              class="btn xs handoff-span-2"
              :disabled="!selectedUrl"
              title="将当前音频与对齐文本/边界送入发声调音台进行发声类型调制或双人混合"
              @click="sendAudio('mixer')"
            >
              <IconSvg name="sliders" :size="12" />
              <span>送入发声调音台</span>
            </button>
            <button
              type="button"
              class="btn xs"
              :disabled="!selectedUrl || working || aligning || transcribing || cleaningSource || cleaningSpeaker || cutting"
              title="将录音与声道轨迹送入编曲修改音高和节奏，尚无轨迹时先自动重建"
              @click="sendAudio('arranger')"
            >
              <IconSvg name="piano" :size="12" />
              <span>{{ workingAction === 'arranger' ? '正在重建…' : '送入编曲改音高' }}</span>
            </button>
            <button
              type="button"
              class="btn xs"
              :disabled="!selectedUrl"
              title="将当前所选音频与声道轨迹发送到剪辑"
              @click="sendAudio('studio')"
            >
              <IconSvg name="stage" :size="12" />
              <span>发送到剪辑</span>
            </button>
            <button
              type="button"
              class="btn xs"
              :disabled="!selectedUrl"
              title="送入语音连续统实验室端点 A"
              @click="sendAudio('continuumA')"
            >
              <IconSvg name="sliders" :size="12" />
              <span>连续统 A</span>
            </button>
            <button
              type="button"
              class="btn xs"
              :disabled="!selectedUrl"
              title="送入语音连续统实验室端点 B"
              @click="sendAudio('continuumB')"
            >
              <IconSvg name="sliders" :size="12" />
              <span>连续统 B</span>
            </button>
          </div>
        </section>
      </div>
    </aside>

    <SplitPane
      v-model="leftColWidth"
      direction="vertical"
      :min="232"
      :max="420"
      :default-value="284"
      storage-key="m27Cols.left"
      title="拖拽调整左栏宽度（双击恢复默认）"
    />

    <!-- CENTER COLUMN: Transport + Pixel-Aligned Spectrogram/Alignment/Parameter Tracks (T-09, T-49, T-53, T-54) -->
    <main class="m27-center-col" data-tour="m27-center">
      <!-- Top Playback & Instant Audition / Assign IPA / Selection Cut Bar (Strict 2-Row Layout) -->
      <section class="panel transport-bar" data-tour="m27-transport">
        <div class="transport-row transport-left" data-tour="m27-transport-play">
          <button
            type="button"
            class="btn primary sm"
            :disabled="!selectedUrl"
            :aria-label="playing ? '暂停试听' : '播放所选音频'"
            @click="play"
          >
            <IconSvg :name="playing ? 'stop' : 'play'" :size="12" />
            <span>{{ playing ? '暂停' : '播放' }}</span>
          </button>

          <div class="seg control-seg sm" aria-label="音频版本切换">
            <button
              v-for="v in versions"
              :key="v"
              type="button"
              :class="{ active: version === v }"
              :disabled="!urls[v]"
              @click="selectAudioVersion(v)"
            >
              {{ chosenName[v] }}
            </button>
          </div>

          <span class="mono readout">{{ playheadSec.toFixed(3) }} / {{ duration.toFixed(3) }} s</span>

          <CustomSelect
            size="sm"
            aria-label="播放倍速"
            :model-value="speed"
            :options="[0.5, 0.75, 1].map((n) => ({ value: n, label: n + '×' }))"
            @update:model-value="(v) => (speed = Number(v))"
          />
        </div>

        <div class="transport-row transport-right" data-tour="m27-transport-tools">
          <!-- T-49: Local window audition (±80 / ±120 / ±200 ms with 12 ms fade) -->
          <div class="window-audition-group" title="在当前播放头前后截取短窗并施加 12 ms 淡入淡出，精准听辨瞬时音色">
            <button
              type="button"
              class="btn xs"
              :class="{ active: auditioningWindow }"
              :disabled="!selectedUrl || liveActive || liveStarting || recording"
              @click="auditionWindowAtPlayhead"
            >
              <IconSvg :name="auditioningWindow ? 'stop' : 'volume'" :size="12" />
              <span>试听当前位置</span>
            </button>
            <CustomSelect
              size="xs"
              class="window-ms-select"
              aria-label="局部试听窗口半宽"
              :model-value="auditionWindowMs"
              :options="auditionWindowOptions"
              @update:model-value="(v) => (auditionWindowMs = Number(v) as AuditionWindowMs)"
            />
          </div>

          <!-- T-49: Assign current frame 19-D pose to an IPA symbol -->
          <button
            type="button"
            class="btn xs"
            :disabled="!activeRow"
            title="将当前播放头帧的 19 维声道参数保存至指定构型方案中的国际音标"
            @click="openAssignIpaModal"
          >
            <IconSvg name="ipa" :size="12" />
            <span>赋给国际音标…</span>
          </button>

          <div v-if="sourceFile" class="transport-cuts" role="group" aria-label="音频剪切">
            <button
              type="button"
              class="btn xs"
              :disabled="!canEditAudio"
              title="自动检测并裁去录音首尾静音，同时同步移动对齐边界与重建轨迹"
              @click="cutSourceAudio('silence')"
            >
              <IconSvg name="scissors" :size="12" />
              <span>裁剪静音</span>
            </button>
            <button
              type="button"
              class="btn xs"
              :disabled="!canEditAudio || !selectionSec"
              title="在语谱图拖拽，或点击静音段以选中要剪切的区间（快捷键 Ctrl+X）"
              @click="cutSourceAudio('selection')"
            >
              <IconSvg name="scissors" :size="12" />
              <span>剪切选区 (Ctrl+X)</span>
            </button>
            <button type="button" class="btn xs" :disabled="!canEditAudio || !cutUndo.length" title="撤销上一次音频剪切（快捷键 Ctrl+Z）" @click="undoSourceCut">
              <IconSvg name="undo" :size="12" />
              <span>撤销剪切</span>
            </button>
            <span v-if="cutting" class="muted readout" role="status">正在剪切…</span>
            <span v-else-if="selectionSec" class="mono muted readout">
              {{ selectionSec[0].toFixed(3) }}–{{ selectionSec[1].toFixed(3) }} s
            </span>
          </div>
        </div>
      </section>

      <!-- Center Main Scientific Timeline Card -->
      <section class="panel center-timeline-card acoustic-plot m27-acoustics">
        <header class="p-head timeline-head">
          <div class="tl-head-left">
            <strong>{{ liveActive && liveHead3D ? '实时三维透视人头与声道联合重建' : '语谱对齐与声道声门轨迹' }}</strong>
            <div v-if="liveActive" class="seg">
              <button
                type="button"
                :class="{ active: !liveHead3D }"
                @click="liveHead3D = false"
              >
                参数轨迹监视
              </button>
              <button
                type="button"
                :class="{ active: liveHead3D }"
                @click="liveHead3D = true"
              >
                三维透视人头
              </button>
            </div>
            <div v-if="(liveActive && !liveHead3D) || (!liveActive && hasResult)" class="seg">
              <button
                v-for="mode in (['all', 'tract', 'glottis'] as const)"
                :key="mode"
                type="button"
                :class="{ active: curveMode === mode }"
                @click="curveMode = mode"
              >
                {{ { all: '全部 27 维', tract: '声道 17 维', glottis: '声门 10 维' }[mode] }}
              </button>
            </div>
          </div>

          <div v-if="!liveActive && (sourceFile || hasResult)" class="tl-zoom-bar">
            <span class="mono muted tl-span-text">
              {{ clampedViewStartSec.toFixed(2) }}–{{ viewEndSec.toFixed(2) }} s
            </span>
            <button
              type="button"
              class="btn xs icon-only"
              aria-label="缩小时间轴"
              :disabled="clampedZoom <= M27_MIN_ZOOM"
              @click="stepZoom(-1)"
            >
              <IconSvg name="minus" :size="11" />
            </button>
            <span class="mono zoom-badge">{{ Number(clampedZoom.toFixed(1)) }}×</span>
            <button
              type="button"
              class="btn xs icon-only"
              aria-label="放大时间轴"
              :disabled="clampedZoom >= M27_MAX_ZOOM"
              @click="stepZoom(1)"
            >
              <IconSvg name="plus" :size="11" />
            </button>
            <button
              v-if="clampedZoom > 1"
              type="button"
              class="btn xs"
              @click="setZoomAnchored(1, 0, 0)"
            >
              1× 全部
            </button>
          </div>
        </header>

        <!-- Live 3D Translucent Head + Face Landmarks + Vocal Tract + 3D Vocal Folds Stage -->
        <LiveHead3DStage
          v-if="liveHead3D && (liveActive || (liveStarting && liveSynthAudio))"
          v-model:camera-enabled="liveCameraEnabled"
          v-model:selected-camera-id="liveCameraId"
          :active="liveActive || liveStarting"
          :tract3d="liveTract3DSnapshot"
          :latest-m27-row="liveLatestM27Row"
          :glottis-state="liveStateSnapshot"
          :vib-mode="vibMode"
          :metrics="liveMetrics"
          :timbre-status-text="liveTimbreStatusText"
          @ready="finishLiveHeadPreparation?.()"
        />

        <!-- Live Realtime Monitor State when realtime synthesis is running (2D multi-lane trace) -->
        <div v-else-if="liveActive" class="live-monitor-stage">
          <div class="live-monitor-bar">
            <div class="live-monitor-chips mono">
              <span class="live-dot-badge">实时监听中</span>
              <span>{{ liveMetrics.voiced ? `F0 ${liveMetrics.f0Hz.toFixed(1)} Hz` : '清音 / 静音' }}</span>
              <span>PR {{ liveMetrics.prPa.toFixed(0) }} Pa</span>
              <span>计算 {{ liveMetrics.computeMs.toFixed(1) }} ms / 往返 {{ liveMetrics.roundTripMs }} ms</span>
              <span>{{ liveTimbreStatusText }}</span>
            </div>
            <div class="live-monitor-flags">
              <span class="tree-tag" :class="{ active: liveTractGeometry }">声道构型 {{ liveTractGeometry ? '开' : '关' }}</span>
              <span class="tree-tag" :class="{ active: liveUseTimbreModel }">音色模型 {{ liveUseTimbreModel ? '开' : '关' }}</span>
              <span class="tree-tag" :class="{ active: liveSynthAudio }">实时音频 {{ liveSynthAudio ? '开' : '关' }}</span>
              <span class="tree-tag" :class="{ active: livePhonationPresetId !== 'none' }">发声 {{ activeLivePhonationShortLabel }}</span>
              <span class="tree-tag" :class="{ active: liveKeepRecording }">保留录音 {{ liveKeepRecording ? '开' : '关' }}</span>
            </div>
          </div>
          <div class="live-monitor-grid-wrap">
            <div
              class="aligned-curves-grid live-curves-grid"
              :style="{ minHeight: `${liveParamLanes.length * LANE_HEIGHT_PX}px` }"
            >
              <div class="curves-axis-col">
                <div
                  v-for="lane in liveParamLanes"
                  :key="lane.id"
                  class="curve-axis-cell"
                  :title="lane.hint"
                >
                  <span class="axis-top mono">{{ lane.topTick }}</span>
                  <div class="axis-mid">
                    <strong>{{ lane.name }}</strong>
                    <small>({{ lane.unitLabel }})</small>
                  </div>
                  <span class="axis-bot mono">{{ lane.botTick }}</span>
                </div>
              </div>
              <div ref="liveMonitorPlotWrap" class="curves-plot-col live-plot-col">
                <canvas ref="liveMonitorCanvas" aria-label="实时 9 轨 27 维声道与声门参数监视器" />
              </div>
            </div>
          </div>
        </div>

        <!-- Empty Guide State when no audio is loaded yet (T-12) -->
        <div v-else-if="!sourceFile && !hasResult" class="center-empty-guide">
          <div class="empty-guide-box">
            <IconSvg name="reconstruct" :size="28" />
            <h4>等待载入语音信号</h4>
            <p>
              导入音频、使用麦克风录音，或直接开启左栏「实时声道重建与合成」边说边看右侧声道与声门动态；也可运行
              <code>Vox2Tract-Lite</code> 与 <code>Vox2Align-Lite v2</code> 做精细离线对齐。
            </p>
            <ReconstructionMicControl
              :acquiring="acquiringMic"
              :recording="recording"
              :elapsed="micElapsed"
              :bars="micBars"
              :quiet="micQuiet"
              @toggle="toggleRecording"
            >
              <button type="button" class="btn primary sm" @click="input?.click()">
                <IconSvg name="upload" :size="12" />
                <span>导入音频文件</span>
              </button>
              <button
                type="button"
                class="btn sm"
                :disabled="liveStarting || working || recording"
                @click="toggleRealtimeMode"
              >
                <IconSvg name="waveform" :size="12" />
                <span>开始实时合成</span>
              </button>
              <button
                type="button"
                class="btn sm"
                :disabled="liveStarting || working || recording"
                @click="liveHead3D = true; toggleRealtimeMode()"
              >
                <IconSvg name="video" :size="12" />
                <span>三维人头重建</span>
              </button>
            </ReconstructionMicControl>
          </div>
        </div>

        <!-- Loaded State: Shared Zero-Origin Scrollbar + Spectrogram/Alignment + Multi-Track Curves -->
        <div v-else class="timeline-scroll-stack">
          <ReconstructionMicControl
            v-if="recording"
            class="timeline-mic-control"
            :acquiring="acquiringMic"
            :recording="recording"
            :elapsed="micElapsed"
            :bars="micBars"
            :quiet="micQuiet"
            @toggle="toggleRecording"
          />
          <div class="shared-hscroll-row">
            <div class="hscroll-axis-cell mono muted">横向视口</div>
            <input
              type="range"
              class="m27-hscroll"
              aria-label="横向视口"
              :aria-valuetext="`${clampedViewStartSec.toFixed(2)}–${viewEndSec.toFixed(2)} 秒`"
              :min="0"
              :max="SCROLL_STEPS"
              :value="scrollPosition"
              :disabled="maxViewStartSec === 0"
              :style="{ '--m27-thumb-width': `${100 / clampedZoom}%` }"
              @input="viewStartSec = (($event.target as HTMLInputElement).valueAsNumber / SCROLL_STEPS) * maxViewStartSec"
            />
          </div>

          <div class="timeline-vertical-scroll">
            <ReconstructionAlignment
              v-if="sourceFile && !normalizingSource"
              class="alignment-timeline"
              :source="sourceFile"
              :duration="duration"
              :grid="sourceTextGrid"
              :fallback-phones="phoneBoundaries"
              :name="sourceName"
              :playhead="playheadSec"
              :playing="playing"
              :zoom="clampedZoom"
              :view-start-sec="clampedViewStartSec"
              :total-duration="totalTimelineSec"
              :selection-sec="selectionSec"
              @seek="seek"
              @play="play"
              @edit-start="stopPlayback"
              @update:grid="saveEditedAlignment"
              @update:selection-sec="(range) => (selectionSec = range)"
              @update:zoom="(z) => (zoom = z)"
              @update:view-start-sec="(s) => (viewStartSec = s)"
              @decoded-duration="(d) => (decodedDur = d)"
            />

            <!-- Pixel-Aligned Multi-Track Parameter Curves (84px Left Axis + Synchronized Right Plot) -->
            <div
              v-if="hasResult"
              class="aligned-curves-grid"
              :style="{ minHeight: `${paramLanes.length * LANE_HEIGHT_PX}px` }"
              @wheel="onCurvesWheel"
            >
              <div class="curves-axis-col">
                <div
                  v-for="lane in paramLanes"
                  :key="lane.id"
                  class="curve-axis-cell"
                  :title="lane.hint"
                >
                  <span class="axis-top mono">{{ lane.topTick }}</span>
                  <div class="axis-mid">
                    <strong>{{ lane.name }}</strong>
                    <small>({{ lane.unitLabel }})</small>
                  </div>
                  <span class="axis-bot mono">{{ lane.botTick }}</span>
                </div>
              </div>

              <div
                ref="tracksPlotWrap"
                class="curves-plot-col"
                @pointerdown="scrubCurves"
                @pointermove="scrubCurves"
              >
                <canvas ref="tracksCanvas" aria-label="声道与声门多轨参数曲线" />
              </div>
            </div>

            <div v-else class="awaiting-reconstruct-strip">
              <IconSvg name="info" :size="14" />
              <span>音频语谱已就绪。点击左栏「开始声道重建」即可在此处生成严格对齐的 27 维声道与声门参数曲线。</span>
            </div>
          </div>
        </div>

        <footer class="timeline-footer">
          <span>
            {{
              liveActive
                ? liveHead3D
                  ? '实时三维透视人头与内部声道联合重建；摄像头仅在本地运行，可切换四视角与半剖透视。'
                  : '实时 5 秒滚动 9 轨完整 27 维监视（50 Hz 滑窗）；悬停左轴可查看各轨参数与量程。'
                : hasResult
                  ? '拖拽对齐条竖线可微调音素边界，双击区间可修改音标；滚轮缩放时语谱与参数曲线严格同步。'
                  : '右侧已预载 JD2 中性声道与常态声门参考图谱。'
            }}
          </span>
          <span v-if="liveActive" class="mono">
            LIVE · 5 s @ 50 Hz
          </span>
          <span v-else-if="hasResult" class="mono">
            {{ currentDevice.toUpperCase() }} · {{ rows.length }} 帧 @ 50 Hz
          </span>
        </footer>
      </section>
    </main>

    <SplitPane
      v-model="rightColWidth"
      direction="vertical"
      invert
      :min="280"
      :max="620"
      :default-value="380"
      storage-key="m27Cols.right"
      title="拖拽调整右侧解剖视口栏宽度（双击恢复默认）"
    />

    <!-- RIGHT COLUMN: Stacked Mid-Sagittal Tract + Glottis/Vocal Folds (in 3D Head mode, only Glottis/Vocal Folds is shown) -->
    <aside ref="rightColEl" class="m27-right-col" data-tour="m27-right">
      <section
        v-show="!(liveActive && liveHead3D)"
        class="panel plot-panel right-tract-panel"
        data-tour="m27-tract-panel"
        :style="{ flex: `${rightAnatomyShare} 1 0%` }"
      >
        <header class="p-head">
          <strong>声道正中矢状面</strong>
          <div class="head-actions">
            <span class="mono muted">{{ liveActive && liveTractGeometry ? '实时构型' : state ? '声道重建' : 'JD2 中性参考' }}</span>
            <button
              type="button"
              class="btn xs"
              :class="{ active: showLabels }"
              @click="showLabels = !showLabels"
            >
              器官标注
            </button>
          </div>
        </header>
        <div class="plot-body tract-host">
          <svg
            ref="tractSvg"
            role="img"
            aria-label="声道正中矢状轮廓"
            preserveAspectRatio="xMidYMax meet"
          />
        </div>
      </section>

      <SplitPane
        v-show="!(liveActive && liveHead3D)"
        v-model="rightAnatomyShare"
        direction="horizontal"
        percentage
        :min="30"
        :max="70"
        :default-value="52"
        storage-key="m27Cols.anatomySplit"
        title="拖拽调整声道矢状面与声门视口高度比例（双击恢复默认）"
      />

      <section
        class="panel plot-panel right-glottis-panel"
        data-tour="m27-glottis-panel"
        :style="{ flex: liveActive && liveHead3D ? '1 1 100%' : `${100 - rightAnatomyShare} 1 0%` }"
      >
        <header class="p-head">
          <strong>声门与声带</strong>
          <div class="head-actions">
            <span v-if="!state && !liveActive" class="mono muted">常态声门 (Modal)</span>
            <button
              v-if="liveActive && liveHead3D"
              type="button"
              class="btn xs"
              :class="{ active: showLabels }"
              @click="showLabels = !showLabels"
            >
              器官标注
            </button>
            <div class="seg control-seg xs">
              <button
                type="button"
                :class="{ active: vibMode === 'strobe' }"
                @click="vibMode = 'strobe'"
              >
                频闪
              </button>
              <button
                type="button"
                :class="{ active: vibMode === 'realtime' }"
                @click="vibMode = 'realtime'"
              >
                实频
              </button>
            </div>
          </div>
        </header>
        <div class="plot-body acoustic-plot m27-acoustics">
          <canvas ref="atlas" aria-label="声门俯视与冠状面解剖图" />
        </div>
      </section>
    </aside>

    <!-- T-04 Modal: Incoming Audio from Annotation Alignment Bar -->
    <Teleport to="body">
      <div v-if="incomingDialogOpen" class="export-modal-mask" @click.self="incomingDialogOpen = false">
        <div class="export-modal-card m27-dialog-card" role="dialog" aria-modal="true" aria-label="补充对齐参考文本">
          <header class="p-head">
            <strong>声道重建与音素对齐</strong>
            <button type="button" class="btn xs icon-only" aria-label="关闭" @click="incomingDialogOpen = false">
              <IconSvg name="close" :size="12" />
            </button>
          </header>
          <div class="m27-modal-body">
            <div class="file-line">
              <IconSvg name="waveform" :size="15" />
              <span>{{ sourceName }}</span>
              <span class="tree-tag">沿用输入音色</span>
            </div>
            <p class="muted">
              输入录音中的实际文本可显著提升 <code>Vox2Align-Lite v2</code> 音素边界对齐精度；您也可以点击「自动识别文本」，或直接留空开始重建。
            </p>
            <div class="align-label-row">
              <span>对齐参考文本（可选）</span>
              <ReconstructionTranscriptionActions
                :cloud="!!deepSeekAsrKey"
                :blocked="transcriptionBlocked"
                :transcribing="transcribing"
                :transcribing-mode="transcribingMode"
                :install="localAsrStatus"
                :install-message="localAsrMessage"
                :pending-model="localAsrPending"
                @transcribe="transcribeReferenceText"
                @choose="localAsr.choose"
                @remove="localAsr.remove"
                @refresh="localAsr.refresh"
              />
            </div>
            <small v-if="localAsrMessage" class="muted" role="status">{{ localAsrMessage }}</small>
            <textarea
              v-model="alignmentText"
              class="inp"
              maxlength="4000"
              rows="3"
              placeholder="例如：春眠不觉晓 / Hello world（留空则直接重建）"
              @input="editReferenceText"
              @change="rememberSource()"
            />
            <small v-if="alignmentMessage" class="muted" role="status">{{ alignmentMessage }}</small>
          </div>
          <footer class="m27-modal-foot">
            <button type="button" class="btn sm" @click="incomingDialogOpen = false">稍后手动运行</button>
            <button type="button" class="btn primary sm" :disabled="transcriptionBlocked" @click="confirmIncomingAndRun">
              <IconSvg name="reconstruct" :size="12" />
              <span>确认并开始声道重建</span>
            </button>
          </footer>
        </div>
      </div>
    </Teleport>

    <!-- T-49 Modal: Assign Current Playhead Frame 19-D Pose to Target IPA Symbol -->
    <Teleport to="body">
      <div v-if="assignModalOpen" class="export-modal-mask" @click.self="assignModalOpen = false">
        <div class="export-modal-card m27-dialog-card" role="dialog" aria-modal="true" aria-label="赋给国际音标构型">
          <header class="p-head">
            <strong>将当前帧构型赋给国际音标</strong>
            <button type="button" class="btn xs icon-only" aria-label="关闭" @click="assignModalOpen = false">
              <IconSvg name="close" :size="12" />
            </button>
          </header>
          <div class="m27-modal-body">
            <div class="assign-meta-strip">
              <span class="mono">定位时刻：{{ playheadSec.toFixed(3) }} s</span>
              <span v-if="currentPhoneAtPlayhead" class="ipa tree-tag" translate="no">
                当前区间 [{{ currentPhoneAtPlayhead }}]
              </span>
            </div>

            <label class="modal-field">
              <span>目标构型方案</span>
              <CustomSelect
                size="sm"
                aria-label="目标构型方案"
                :model-value="assignSetId"
                :options="ipaPoseSets.map((item) => ({ value: item.id, label: item.name }))"
                @update:model-value="(v) => (assignSetId = String(v))"
              />
            </label>

            <div v-if="assignSetId === RECORDED_IPA_SET_ID" class="readonly-scheme-callout">
              <small>默认实录反演构型库为只读，可一键基于当前库建立可编辑方案：</small>
              <div class="button-row">
                <input
                  v-model="newSchemeName"
                  type="text"
                  class="inp"
                  maxlength="60"
                  placeholder="新构型方案名称"
                />
                <button type="button" class="btn xs primary" @click="createWritableSchemeInline">
                  基于当前库新建构型方案
                </button>
              </div>
            </div>

            <label class="modal-field">
              <span>目标国际音标符号</span>
              <input
                v-model="assignSymbol"
                type="text"
                class="inp ipa"
                translate="no"
                maxlength="24"
                placeholder="输入音标，如 i、ɑ、ʂ、tɕ"
                @keydown.enter.prevent="confirmAssignIpa"
              />
            </label>

            <div v-if="uniqueAlignedPhones.length" class="quick-phone-chips" translate="no">
              <small class="muted">本段音素快捷选定：</small>
              <div class="chip-list">
                <button
                  v-for="ph in uniqueAlignedPhones"
                  :key="ph"
                  type="button"
                  class="btn xs ipa"
                  :class="{ active: assignSymbol.trim() === ph }"
                  translate="no"
                  @click="assignSymbol = ph"
                >
                  {{ ph }}
                </button>
              </div>
            </div>
          </div>
          <footer class="m27-modal-foot">
            <button type="button" class="btn sm" @click="assignModalOpen = false">取消</button>
            <button
              type="button"
              class="btn primary sm"
              :disabled="!assignSymbol.trim() || assignSetId === RECORDED_IPA_SET_ID"
              @click="confirmAssignIpa"
            >
              <IconSvg name="check" :size="12" />
              <span>确认赋给音标</span>
            </button>
          </footer>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <AudioRecordPrepModal
        :open="Boolean(recordPrepDraft)"
        :title="recordPrepDraft?.target === 'speaker' ? '参考音色录音编辑' : '录音裁剪、降噪与原文对齐'"
        :hint="
          recordPrepDraft?.target === 'speaker'
            ? '可先去首尾静音、框选干净语音段并降噪，再作为神经重合成的目标参考音色。'
            : '录完可在此框选裁剪、一键去首尾静音、降噪，并填写录音原文调用 Vox2Align-Lite v2 自动对齐音素。'
        "
        :initial-file="recordPrepDraft?.file ?? null"
        :initial-original-file="recordPrepDraft?.originalFile ?? null"
        :initial-text="recordPrepDraft?.text ?? ''"
        :initial-lang="recordPrepDraft?.lang ?? 'auto'"
        :initial-grid="recordPrepDraft?.grid ?? null"
        :device="store.computeDevice.value"
        :show-alignment="recordPrepDraft?.target !== 'speaker'"
        allow-re-record
        :confirm-label="recordPrepDraft?.target === 'speaker' ? '设为参考音色' : '确认载入工作区'"
        @close="recordPrepDraft = null"
        @confirm="confirmRecordPrep"
      />
    </Teleport>
  </div>
</template>

<style scoped>
.m27-acoustics {
  border-radius: var(--chart-corner);
  background: var(--chart-panel);
}

.reconstruction {
  flex: 1;
  display: grid;
  grid-template-columns:
    min(var(--m27-left-w, 284px), 30%)
    5px
    minmax(420px, 1fr)
    5px
    min(var(--m27-right-w, 380px), 36%);
  gap: var(--gap-layout, 8px);
  min-width: 0;
  min-height: 0;
  padding: var(--pad-shell, 8px);
  color: var(--text);
  --ts-anatomy-bg: var(--panel);
  --ts-anatomy-muted: var(--muted);
  --ts-anatomy-divider: var(--border);
  --ts-curves-bg: var(--panel);
  --ts-lane-bg: var(--selected);
  --ts-lane-border: var(--border);
  --ts-lane-title: var(--text);
  --ts-zero-line: var(--border);
  --ts-playhead: var(--danger);
  --ts-dot-stroke: var(--panel);
}

.reconstruction audio {
  display: none;
}

.m27-left-col,
.m27-center-col,
.m27-right-col,
.plot-panel {
  min-width: 0;
  min-height: 0;
}

.m27-left-col {
  display: flex;
  flex-direction: column;
}

.inspector-scroll {
  overflow: auto;
  min-height: 0;
  padding: 0 12px 10px;
}

.inspector-scroll section {
  padding: 10px 0;
  display: grid;
  gap: 7px;
  border-bottom: 1px solid var(--border);
}

.inspector-scroll section:last-child {
  border-bottom: 0;
}

.inspector-scroll h3 {
  font-size: 1rem;
  margin: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.reconstruction small,
.inspector-scroll p,
.timeline-footer {
  color: var(--muted);
  font-size: 0.875rem;
  font-weight: normal;
}

.inspector-scroll p {
  margin: 0;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.source-box {
  display: grid;
  gap: 8px;
  padding: 9px 10px;
  background: var(--selected);
  border: 1px dashed color-mix(in srgb, var(--accent) 42%, var(--border));
  border-radius: var(--r-ctrl);
}

.file-line,
.field-row,
.button-row,
.align-label-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.file-line {
  color: var(--accent);
  font-weight: 600;
  font-size: 0.958333rem;
}

.file-line span,
.reference-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.field-row,
.align-label-row {
  justify-content: space-between;
}

.align-label-row > span {
  font-size: 0.916667rem;
  font-weight: 600;
}

.button-row {
  flex-wrap: wrap;
}

.main-run-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px;
}

.status-line {
  color: var(--text) !important;
  font-size: 0.916667rem !important;
}

.align-editor {
  display: grid;
  gap: 6px;
}

.align-editor .inp {
  min-width: 0;
}

.align-editor textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  resize: vertical;
}

.engine-select-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 6px;
}

.engine-select-field {
  display: grid;
  gap: 4px;
  min-width: 0;
  font-size: 0.86rem;
  font-weight: 600;
  color: var(--muted);
}

.engine-select-field :deep(.vc-sel),
.engine-select-field :deep(.voice-render-select) {
  width: 100%;
}

.speaker-select-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.speaker-select-grow {
  flex: 1 1 auto;
  min-width: 0;
}

.align-lang-select {
  min-width: 112px;
}

.handoff-primary {
  width: 100%;
  justify-content: center;
}

.handoff-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.handoff-grid .btn {
  justify-content: center;
}

.handoff-span-2 {
  grid-column: 1 / -1;
}

/* CENTER COLUMN */
.m27-center-col {
  display: flex;
  flex-direction: column;
  gap: var(--gap-layout, 8px);
  overflow: hidden;
}

.transport-bar {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 10px;
}

.transport-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px 8px;
  flex-wrap: wrap;
  max-width: 100%;
}

.transport-left,
.transport-right,
.transport-cuts,
.window-audition-group {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: none;
}

.transport-cuts {
  padding-left: 6px;
  border-left: 1px solid var(--border);
}

.timeline-mic-control {
  flex: none;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.transport-bar .readout {
  font-size: 0.916667rem;
  white-space: nowrap;
}

.window-audition-group {
  padding-left: 0;
  border-left: 0;
}

.window-ms-select {
  width: auto;
}

.center-timeline-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.timeline-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.tl-head-left,
.tl-zoom-bar,
.head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.zoom-badge {
  min-width: 34px;
  text-align: center;
  font-size: 0.916667rem;
}

.tl-span-text {
  font-size: 0.833333rem;
}

.center-empty-guide {
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--panel);
}

.empty-guide-box {
  max-width: 440px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 10px;
  color: var(--muted);
}

.empty-guide-box h4 {
  margin: 0;
  font-size: 1.166667rem;
  color: var(--text);
}

.empty-guide-box p {
  margin: 0;
  font-size: 0.958333rem;
  line-height: 1.6;
}

.timeline-scroll-stack {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--panel);
}

.shared-hscroll-row {
  flex: none;
  display: grid;
  grid-template-columns: var(--m27-axis-w, 84px) minmax(0, 1fr);
  align-items: center;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--sidebar, var(--panel)) 60%, var(--panel));
}

.hscroll-axis-cell {
  padding: 2px 6px;
  font-size: 0.791667rem;
  border-right: 1px solid var(--border);
  white-space: nowrap;
}

input.m27-hscroll {
  height: 14px;
}

input.m27-hscroll::-webkit-slider-runnable-track {
  height: 10px;
  background: var(--border);
  box-shadow: none;
}

input.m27-hscroll::-webkit-slider-thumb {
  width: max(18px, var(--m27-thumb-width));
  height: 10px;
  margin-top: 0;
  border: 0;
  border-radius: 999px;
  background: var(--muted);
  box-shadow: none;
  transform: none;
}

input.m27-hscroll::-moz-range-track {
  height: 10px;
  border-radius: 999px;
  background: var(--border);
}

input.m27-hscroll::-moz-range-thumb {
  width: max(18px, var(--m27-thumb-width));
  height: 10px;
  border: 0;
  border-radius: 999px;
  background: var(--muted);
}

input.m27-hscroll:disabled {
  cursor: default;
}

.timeline-vertical-scroll {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden;
}

.alignment-timeline {
  flex: none;
}

.aligned-curves-grid {
  flex: 1 0 auto;
  display: grid;
  grid-template-columns: var(--m27-axis-w, 84px) minmax(0, 1fr);
  min-width: 0;
}

.curves-axis-col {
  display: grid;
  grid-auto-rows: minmax(0, 1fr);
  border-right: 1px solid var(--border);
  background: color-mix(in srgb, var(--sidebar, var(--panel)) 72%, var(--panel));
}

.curve-axis-cell {
  box-sizing: border-box;
  padding: 2px 6px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  overflow: hidden;
}

.axis-top,
.axis-bot {
  font-size: 0.733333rem;
  color: var(--muted);
  text-align: right;
  line-height: 1.1;
  white-space: nowrap;
}

.axis-mid {
  display: flex;
  align-items: baseline;
  gap: 3px;
  line-height: 1.1;
  white-space: nowrap;
}

.axis-mid strong {
  font-size: 0.833333rem;
  color: var(--text);
}

.axis-mid small {
  font-size: 0.733333rem;
  color: var(--muted);
}

.curves-plot-col {
  position: relative;
  min-width: 0;
  cursor: ew-resize;
  touch-action: none;
}

.curves-plot-col canvas {
  display: block;
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.awaiting-reconstruct-strip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 26px 16px;
  color: var(--muted);
  font-size: 0.958333rem;
}

.timeline-footer {
  flex: none;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-top: 1px solid var(--border);
}

/* RIGHT COLUMN: Dual Stacked Anatomy Viewports */
.m27-right-col {
  display: flex;
  flex-direction: column;
  gap: var(--gap-layout, 8px);
  overflow: hidden;
}

.plot-panel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 140px;
}

.plot-body {
  flex: 1;
  position: relative;
  min-width: 0;
  min-height: 0;
  background: var(--panel);
}

.plot-body > canvas,
.plot-body > svg {
  display: block;
  width: 100%;
  height: 100%;
}

.tract-host {
  background-color: var(--anatomy-bg, var(--panel));
}

/* Modals (T-04 & T-49) — extends shared .export-modal-mask / .export-modal-card */
.m27-dialog-card {
  width: min(460px, 100%);
}

.m27-modal-body {
  padding: 12px 14px;
  display: grid;
  gap: 10px;
  font-size: 1rem;
}

.m27-modal-body p {
  margin: 0;
  line-height: 1.55;
  font-size: 0.958333rem;
}

.m27-modal-foot {
  padding: 8px 14px;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.assign-meta-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 9px;
  border-radius: var(--r-ctrl);
  background: var(--selected);
  font-size: 0.958333rem;
}

.modal-field {
  display: grid;
  gap: 5px;
  font-size: 0.958333rem;
  font-weight: 600;
}

.readonly-scheme-callout {
  display: grid;
  gap: 6px;
  padding: 8px 10px;
  border-radius: var(--r-ctrl);
  border: 1px dashed color-mix(in srgb, var(--accent) 48%, var(--border));
  background: color-mix(in srgb, var(--selected) 72%, transparent);
}

.readonly-scheme-callout .inp {
  flex: 1;
  min-width: 120px;
}

.quick-phone-chips {
  display: grid;
  gap: 5px;
}

.chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

/* Realtime vocal-tract reconstruction & live synthesis panel */
.live-rt-section {
  display: grid;
  gap: 7px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}

.live-rt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.live-rt-badge {
  font-size: 0.78rem;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: var(--r-pill);
  color: var(--on-accent);
  background: var(--danger);
}

.live-rt-options {
  display: grid;
  gap: 5px;
  padding: 6px 8px;
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--sidebar) 72%, var(--panel));
  border: 1px solid var(--border);
}

.live-rt-check {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 0.9rem;
  cursor: pointer;
  user-select: none;
}

.live-rt-check input[type='checkbox'] {
  accent-color: var(--accent);
  width: 14px;
  height: 14px;
  cursor: pointer;
}

.live-rt-delay {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 7px;
  font-size: 0.9rem;
}

.live-rt-voice-box {
  gap: 7px;
}

.live-rt-field {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.live-rt-field-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  font-size: 0.88rem;
  font-weight: 600;
}

.live-rt-field-head small {
  font-size: 0.76rem;
  font-weight: 400;
  white-space: nowrap;
}

.live-rt-desc {
  font-size: 0.78rem;
  line-height: 1.4;
}

.live-rt-action {
  width: 100%;
  justify-content: center;
}

.live-rt-telemetry {
  display: grid;
  gap: 4px;
  font-size: 0.82rem;
  line-height: 1.4;
}

.live-meter-track {
  height: 5px;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--border) 75%, transparent);
  overflow: hidden;
}

.live-meter-fill {
  height: 100%;
  border-radius: var(--r-pill);
  background: linear-gradient(90deg, var(--teal), var(--accent), var(--warning));
  transition: width 80ms linear;
}

.live-rt-tip {
  font-size: 0.8rem;
  line-height: 1.45;
}

.live-rt-err {
  font-size: 0.82rem;
  color: var(--danger);
}

.live-monitor-stage {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
}

.live-monitor-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--sidebar) 75%, var(--panel));
}

.live-monitor-chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 0.85rem;
}

.live-dot-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 700;
  color: var(--danger);
}

.live-dot-badge::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.live-monitor-flags {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.live-monitor-flags .tree-tag.active {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  color: var(--accent);
}

.live-monitor-grid-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

.live-curves-grid .curve-axis-cell:last-child {
  border-bottom: 0;
}

.live-plot-col {
  cursor: default;
}
</style>
