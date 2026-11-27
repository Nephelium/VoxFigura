<script setup lang="ts">
import { renderM27TractSvg } from '@/vendor/m27-tract-studio/tract-renderer.js';
import { audioBufferFile, sendWorkspaceAudio, takeWorkspaceAudio } from '@/data/workspace-transfer';
import { denoiseFile } from '@/data/denoise';
import { VOQS_PROFILES, voqsProfile } from '@/data/voqs-library';
import { M27Adapter, defaultVtlTransport } from '@vocalcut/model-adapters';
import {
  alignEndpointTimings,
  buildOutputAnnotation,
  buildStimulusCsv,
  buildStimulusZip,
  cellMovie,
  CONTINUUM_GAP_S,
  continuumPersisted,
  endpointDuration,
  endpointEffectiveDuration,
  endpointSelections,
  inspectWavHeader,
  interpolatePose,
  joinContinuumAudio,
  needsContinuumAnalysis,
  originalEndpointAudio,
  peakContinuumWav,
  received,
  referenceFramesFromM27,
  representativeContinuumPose,
  resolveContinuumFramePitch,
  resolveContinuumSource,
  sourceControls,
  sourceTrajectory,
  timeWarp,
  validPose,
  type ContinuumAxisKind,
  type ContinuumAxisRangeSetting,
  type ContinuumEndpointSource,
  type ContinuumGhostMode,
  type ContinuumSpeakerRefMode,
  type RenderedCell,
  type WavHeaderSummary,
} from './continuum-media';
import { createContinuumPlayback, type ContinuumPlaybackPart } from './continuum-playback';
import { useContinuumViewport } from './continuum-viewport';
import { paintReferenceFrame, type PaintableTractFrame } from '@/data/reference-geometry';
import { applyPeakAudioGain, synthesisGainMode, voiceRenderLabels } from '@/data/voice-renderer';
import { triggerDownload } from '@/components/modals/download';
import { studioAudioContext } from '@/components/studio/studio-media';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, watchEffect } from 'vue';
import ModuleGuideButton from '@/components/guide/ModuleGuideButton.vue';
import { CONTINUUM_REAL_PAIR_SAMPLES, fetchOnboardingAudioFile } from '@/data/onboarding-samples';
import { publishPanelSnapshot } from '@/data/panel-snapshots';
import {
  PHONATION_M27_ANCHORS,
  SAMPLE_RATE_HZ,
  buildContinuum2D,
  interpolateGlottis10D,
  type ContinuumLandmark,
  type TractParamName,
} from '@vocalcut/core';
import {
  defaultTractParams,
  tractArray19ToRecord,
  tractRecordToArray19,
  useWorkbenchStore,
  VTL_PARAM_META,
} from '@/stores/workbench';
import {
  DEFAULT_TRACT_EXTRAS,
  cloneTractExtras,
  normalizeFactorySpeaker,
  preloadPtbIpaPresets,
  ptbPresetsVersion,
  type TractPoseExtras,
} from '@/data/ptb-ipa-presets';
import type { SelectOption } from '@/components/common/CustomSelect.vue';
import CustomSelect from '@/components/common/CustomSelect.vue';
import CompactSlider from '@/components/common/CompactSlider.vue';
import IconSvg from '@/components/common/IconSvg.vue';
import SplitPane from '@/components/common/SplitPane.vue';
import ContinuumInspectorPanel, { type InspectorContourData } from './ContinuumInspectorPanel.vue';
import AudioRecordPrepModal, { type AudioRecordPrepResult } from './AudioRecordPrepModal.vue';
import ReconstructionMicControl from './ReconstructionMicControl.vue';
import { useReconstructionMicMonitor } from './reconstruction-mic-monitor';
import { clipFromTextGrid } from '@/data/textgrid-alignment';
import {
  blobToBase64,
  encodeMonoWavBase64,
  QUICK_IPA_ITEMS,
  downloadTextFile,
  getFullPoseForIpa,
  m27ImportedEndpointA,
  m27ImportedEndpointB,
} from './research-utils';
import { classifyContinuumPhone } from '@/data/ipa-segments';
import {
  splitM27TractParts,
  type M27ThemeMode,
  type TractPartsMap,
} from './m27-hd-renderers';

const store = useWorkbenchStore();
const activeSpeaker = computed(() => store.project.value.voices[store.activeVoiceId.value]?.speaker ?? 'JD2');

type EndpointSource = ContinuumEndpointSource;
type AxisKind = ContinuumAxisKind;

for (const side of ['A', 'B'] as const) {
  const transfer = takeWorkspaceAudio(side === 'A' ? 'continuumA' : 'continuumB');
  if (transfer) {
    received[side] = transfer;
    endpointSelections[side] = 'audio';
  }
}

interface PresetEndpointDef {
  id: string;
  label: string;
  ipa: string;
  f0Hz: number;
}

interface PresetEndpoint extends PresetEndpointDef {
  pose: Record<TractParamName, number>;
  extras: TractPoseExtras;
}

const PRESET_ENDPOINT_DEFS: readonly PresetEndpointDef[] = [
  { id: 'suan', label: '普通话“算”的韵腹 [a]', ipa: 'a', f0Hz: 175 },
  { id: 'swan', label: '英语“swan”的元音 [ɒ]', ipa: 'ɒ', f0Hz: 140 },
  { id: 'i_high', label: '前高元音 [i]', ipa: 'i', f0Hz: 210 },
  { id: 'u_back', label: '后高圆唇 [u]', ipa: 'u', f0Hz: 165 },
  { id: 's_alv', label: '平舌擦音 [s]', ipa: 's', f0Hz: 180 },
  { id: 'sh_ret', label: '翘舌卷舌 [ʂ]', ipa: 'ʂ', f0Hz: 180 },
  { id: 'nasal_a', label: '鼻化元音 [ã]', ipa: 'ã', f0Hz: 160 },
  { id: 'canton_t', label: '粤语不除阻 [t̚]', ipa: 't̚', f0Hz: 215 },
];

const presetEndpoints = computed<PresetEndpoint[]>(() => {
  void ptbPresetsVersion.value;
  const spk = activeSpeaker.value;
  return PRESET_ENDPOINT_DEFS.map((def) => {
    const full = getFullPoseForIpa(def.ipa, undefined, spk);
    return {
      ...def,
      pose: full.params,
      extras: full.extras,
    };
  });
});

const sourceOptions: ReadonlyArray<SelectOption<EndpointSource>> = [
  { value: 'preset', label: '预设实验端点' },
  { value: 'phoneme', label: '自由音素构型' },
  { value: 'm27', label: '声道重建导入帧' },
  { value: 'audio', label: '标注或重建音段' },
];

const presetOptions: ReadonlyArray<SelectOption<string>> = PRESET_ENDPOINT_DEFS.map((p) => ({
  value: p.id,
  label: p.label,
}));

const phonemeOptions: ReadonlyArray<SelectOption<string>> = QUICK_IPA_ITEMS.map((q) => ({
  value: q.symbol,
  label: `[${q.symbol}] ${q.nameZh}`,
}));

const axisOptions: ReadonlyArray<SelectOption<AxisKind>> = [
  { value: 'mix', label: '端点 A → B 混合' },
  { value: 'f0', label: '基频 F0' },
  { value: 'phonation', label: '发声类型' },
  { value: 'duration', label: '时长' },
  { value: 'pressure', label: '声门下压' },
  ...VTL_PARAM_META.filter((param) => param.key !== 'TRX' && param.key !== 'TRY').map((param) => ({
    value: param.key,
    label: param.label,
  })),
];

const TRACT_PARAM_KEYS = new Set<string>(VTL_PARAM_META.map((m) => m.key));

const srcA = ref<EndpointSource>(endpointSelections.A);
const presetA = ref(continuumPersisted.presetA);
const phonemeA = ref(continuumPersisted.phonemeA);

const srcB = ref<EndpointSource>(endpointSelections.B);
const presetB = ref(continuumPersisted.presetB);
const phonemeB = ref(continuumPersisted.phonemeB);

watch([srcA, srcB], ([a, b]) => {
  endpointSelections.A = a;
  endpointSelections.B = b;
});

const audioA = computed(() => (srcA.value === 'audio' ? received.A : null));
const audioB = computed(() => (srcB.value === 'audio' ? received.B : null));
const cleaningSide = ref<'A' | 'B' | null>(null);

// Endpoint microphone recording + post-record prep modal (shared workflow with M27ReconstructView)
const recordingSide = ref<'A' | 'B' | null>(null);
const acquiringMicSide = ref<'A' | 'B' | null>(null);
const micMonitor = useReconstructionMicMonitor();
const { elapsed: micElapsed, bars: micBars, quiet: micQuiet } = micMonitor;
let endpointRecorder: MediaRecorder | null = null;
let endpointMicGen = 0;

interface EndpointPrepDraft {
  side: 'A' | 'B';
  file: File;
  originalFile: File;
  label: string;
  text: string;
  lang: 'auto' | 'zh' | 'en';
  grid: import('@vocalcut/core').TextGridDocument | null;
  fromExisting: boolean;
}
const prepDraft = shallowRef<EndpointPrepDraft | null>(null);

function stopEndpointMic(): void {
  endpointMicGen++;
  acquiringMicSide.value = null;
  recordingSide.value = null;
  micMonitor.stop();
  if (endpointRecorder) {
    const mic = endpointRecorder;
    endpointRecorder = null;
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

async function toggleEndpointRecord(side: 'A' | 'B'): Promise<void> {
  if (endpointRecorder?.state === 'recording' && recordingSide.value === side) {
    endpointRecorder.stop();
    micMonitor.stop();
    return;
  }
  if (endpointRecorder || acquiringMicSide.value) return;
  playback.stop();
  const gen = ++endpointMicGen;
  acquiringMicSide.value = side;
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, noiseSuppression: false, echoCancellation: false, autoGainControl: false },
    });
    if (gen !== endpointMicGen) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const mic = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    endpointRecorder = mic;
    mic.ondataavailable = (ev) => {
      if (ev.data.size) chunks.push(ev.data);
    };
    mic.onerror = () => {
      if (gen !== endpointMicGen) return;
      stopEndpointMic();
      store.pushToast('录音中断，请检查麦克风输入', 'warning');
    };
    mic.onstop = async () => {
      micMonitor.stop();
      mic.stream.getTracks().forEach((t) => t.stop());
      recordingSide.value = null;
      endpointRecorder = null;
      let ctx: AudioContext | undefined;
      try {
        const blob = new Blob(chunks, { type: mic.mimeType });
        ctx = new AudioContext({ sampleRate: 16000 });
        const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
        if (synthesisGainMode.value === 'peak') applyPeakAudioGain(decoded);
        const bytes = Uint8Array.from(
          atob(encodeMonoWavBase64(decoded.getChannelData(0), decoded.sampleRate)),
          (c) => c.charCodeAt(0),
        );
        if (gen !== endpointMicGen) return;
        const file = new File([bytes], `端点${side}录音.wav`, { type: 'audio/wav' });
        prepDraft.value = {
          side,
          file,
          originalFile: file,
          label: `端点 ${side} 录音`,
          text: '',
          lang: 'auto',
          grid: null,
          fromExisting: false,
        };
      } catch (err) {
        if (gen === endpointMicGen) {
          store.pushToast(`录音解码失败：${err instanceof Error ? err.message : String(err)}`, 'warning');
        }
      } finally {
        if (ctx) void ctx.close();
      }
    };
    mic.start();
    micMonitor.start(stream);
    recordingSide.value = side;
  } catch {
    if (gen === endpointMicGen) {
      stopEndpointMic();
      store.pushToast('麦克风不可用，请检查浏览器录音权限', 'warning');
    }
    stream?.getTracks().forEach((t) => t.stop());
  } finally {
    if (gen === endpointMicGen) acquiringMicSide.value = null;
  }
}

function openEndpointAudioEditor(side: 'A' | 'B'): void {
  const source = received[side];
  if (!source || recordingSide.value || acquiringMicSide.value) return;
  const orig = originalEndpointAudio.get(source.file);
  prepDraft.value = {
    side,
    file: source.file,
    originalFile: orig?.file ?? source.file,
    label: source.label || source.file.name,
    text: source.alignmentText || source.clip?.source?.lyrics || '',
    lang: 'auto',
    grid: source.textGrid ?? null,
    fromExisting: true,
  };
}

async function confirmEndpointPrep(result: AudioRecordPrepResult): Promise<void> {
  const draft = prepDraft.value;
  if (!draft) return;
  const side = draft.side;
  const existing = draft.fromExisting ? received[side] : null;
  const keepTrack = Boolean(existing && !result.audioChanged && existing.file === result.file);
  let nextClip = keepTrack ? existing?.clip : undefined;
  if (result.grid) {
    try {
      const dur = await endpointDuration({ file: result.file });
      nextClip = clipFromTextGrid(result.grid, Math.round(dur * SAMPLE_RATE_HZ), crypto.randomUUID()) ?? nextClip;
    } catch {
      // Fallback to analysis clip
    }
  }
  const nextSource = {
    file: result.file,
    label: result.label || result.file.name,
    alignmentText: result.text || undefined,
    textGrid: result.grid ?? (keepTrack ? existing?.textGrid : undefined),
    clip: nextClip,
    ...(keepTrack && existing ? { m27RowsPa: existing.m27RowsPa, frames: existing.frames, sourceKind: existing.sourceKind } : {}),
  };
  if (result.denoised && result.originalFile !== result.file) {
    originalEndpointAudio.set(result.file, {
      file: result.originalFile,
      label: result.label || result.originalFile.name,
      alignmentText: result.text || undefined,
      textGrid: nextSource.textGrid,
      clip: nextClip,
    });
  }
  received[side] = nextSource;
  if (side === 'A') srcA.value = 'audio';
  else srcB.value = 'audio';
  prepDraft.value = null;
  store.pushToast(`已更新端点 ${side} 录音（${nextSource.label}）`, 'success', 2400);
}

const endpointReadyA = computed(() => {
  if (srcA.value === 'audio') return Boolean(received.A);
  if (srcA.value === 'm27') return Boolean(m27ImportedEndpointA.value);
  return true;
});
const endpointReadyB = computed(() => {
  if (srcB.value === 'audio') return Boolean(received.B);
  if (srcB.value === 'm27') return Boolean(m27ImportedEndpointB.value);
  return true;
});
const endpointsReady = computed(() => endpointReadyA.value && endpointReadyB.value);

function swapEndpoints(): void {
  const prevSrcA = srcA.value;
  srcA.value = srcB.value;
  srcB.value = prevSrcA;

  const prevPresetA = presetA.value;
  presetA.value = presetB.value;
  presetB.value = prevPresetA;

  const prevPhonemeA = phonemeA.value;
  phonemeA.value = phonemeB.value;
  phonemeB.value = prevPhonemeA;

  const prevRecA = received.A;
  received.A = received.B;
  received.B = prevRecA;

  const prevM27A = m27ImportedEndpointA.value;
  m27ImportedEndpointA.value = m27ImportedEndpointB.value;
  m27ImportedEndpointB.value = prevM27A;
}

function uploadEndpoint(side: 'A' | 'B', event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  received[side] = { file, label: file.name };
  if (side === 'A') srcA.value = 'audio';
  else srcB.value = 'audio';
}

async function toggleEndpointNoise(side: 'A' | 'B'): Promise<void> {
  const source = received[side];
  if (!source || cleaningSide.value) return;
  const original = originalEndpointAudio.get(source.file);
  if (original) {
    received[side] = original;
    return;
  }
  cleaningSide.value = side;
  try {
    const file = await denoiseFile(source.file);
    if (received[side] === source) {
      originalEndpointAudio.set(file, source);
      received[side] = { file, label: file.name, clip: source.clip, textGrid: source.textGrid };
    }
  } catch (error) {
    store.pushToast(error instanceof Error ? error.message : String(error), 'warning');
  } finally {
    cleaningSide.value = null;
  }
}

const horizontal = ref<AxisKind>(continuumPersisted.horizontal);
const vertical = ref<AxisKind>(continuumPersisted.vertical);
const dualAxis = ref(continuumPersisted.dualAxis);
const sequenceSteps = ref(continuumPersisted.sequenceSteps);
const matrixColumns = ref(continuumPersisted.matrixColumns);
const matrixRows = ref(continuumPersisted.matrixRows);
const columns = computed(() => (dualAxis.value ? matrixColumns.value : sequenceSteps.value));
const rows = computed(() => (dualAxis.value ? matrixRows.value : 1));
const baseMix = ref(continuumPersisted.baseMix);
const STEP_HZ = 100;
const synthesis = ref<'vtl' | 'neural'>(continuumPersisted.synthesis);
const speakerRefMode = ref<ContinuumSpeakerRefMode>(continuumPersisted.speakerRefMode);
const speakerRefOptions: ReadonlyArray<SelectOption<ContinuumSpeakerRefMode>> = [
  { value: 'endpoint_a', label: '固定端点 A 声纹（无则回退 B）' },
  { value: 'endpoint_b', label: '固定端点 B 声纹（无则回退 A）' },
  { value: 'builtin', label: '固定本机默认声纹' },
];

function resolveUniformSpeakerRef(
  a: typeof audioA.value,
  b: typeof audioB.value,
  mode: ContinuumSpeakerRefMode,
): { file?: File; sourceSide: 'A' | 'B' | 'builtin' } {
  if (mode === 'builtin') return { sourceSide: 'builtin' };
  if (mode === 'endpoint_b') {
    if (b?.file) return { file: b.file, sourceSide: 'B' };
    if (a?.file) return { file: a.file, sourceSide: 'A' };
    return { sourceSide: 'builtin' };
  }
  if (a?.file) return { file: a.file, sourceSide: 'A' };
  if (b?.file) return { file: b.file, sourceSide: 'B' };
  return { sourceSide: 'builtin' };
}

const regimeA = ref(continuumPersisted.regimeA);
const regimeB = ref(continuumPersisted.regimeB);
const regimeOptions: SelectOption<string>[] = VOQS_PROFILES.filter((profile) => profile.group !== 'height').map(
  (profile) => ({ value: profile.symbol, label: `${profile.symbol} · ${profile.label}` }),
);
const takeA = computed(() => voqsProfile(regimeA.value)?.takes[0]);
const takeB = computed(() => voqsProfile(regimeB.value)?.takes[0]);

function tractAxisSetting(meta: (typeof VTL_PARAM_META)[number]): [string, ContinuumAxisRangeSetting] {
  const min = ['TS1', 'TS2'].includes(meta.key) ? 0 : meta.key === 'TS3' ? -1 : meta.key === 'TBY' ? -3 : meta.min;
  const max = ['TCY', 'TS1', 'TS2', 'TS3'].includes(meta.key) ? 1 : meta.max;
  return [meta.key, { values: [min, max], min, max, unit: '', step: meta.step }];
}

function createDefaultAxisSettings(): Record<string, ContinuumAxisRangeSetting> {
  return {
    f0: { values: [120, 280], min: 10, max: 2000, unit: 'Hz' },
    duration: { values: [250, 900], min: 80, max: 10000, unit: 'ms' },
    pressure: { values: [400, 1000], min: 0, max: 1600, unit: 'Pa' },
    ...Object.fromEntries(VTL_PARAM_META.map(tractAxisSetting)),
  };
}

const axisSettings = ref<Record<string, ContinuumAxisRangeSetting>>(
  continuumPersisted.axisSettings ?? createDefaultAxisSettings(),
);

const axes = computed(() => {
  const first = {
    id: 'horizontal',
    label: dualAxis.value ? '横轴' : '变化参数',
    kind: horizontal.value,
    setting: axisSettings.value[horizontal.value],
    options: dualAxis.value ? axisOptions.filter((a) => a.value !== vertical.value) : axisOptions,
  };
  return !dualAxis.value
    ? [first]
    : [
        first,
        {
          id: 'vertical',
          label: `纵轴 · ${matrixRows.value} 格`,
          kind: vertical.value,
          setting: axisSettings.value[vertical.value],
          options: axisOptions.filter((a) => a.value !== horizontal.value),
        },
      ];
});

function setStepCount(event: Event): void {
  const input = event.target as HTMLInputElement;
  const steps = input.valueAsNumber;
  const max = dualAxis.value ? 16 : 51;
  if (!Number.isInteger(steps) || steps < 2 || steps > max) {
    input.value = String(columns.value);
    store.pushToast(`格数须为 2–${max} 之间的整数`, 'warning');
    return;
  }
  (dualAxis.value ? matrixColumns : sequenceSteps).value = steps;
  selectedCellKey.value = '1-1';
}

function setRowCount(event: Event): void {
  const input = event.target as HTMLInputElement;
  const count = input.valueAsNumber;
  if (!Number.isInteger(count) || count < 2 || count > 8) {
    input.value = String(matrixRows.value);
    store.pushToast('纵轴格数须为 2–8 之间的整数', 'warning');
    return;
  }
  matrixRows.value = count;
  selectedCellKey.value = '1-1';
}

const axisError = computed(() => {
  const invalid = axes.value.find(
    (axis) =>
      axis.setting &&
      axis.setting.values.some(
        (value) => typeof value !== 'number' || !Number.isFinite(value) || value < axis.setting.min || value > axis.setting.max,
      ),
  );
  return invalid
    ? `${invalid.label}的端点须在 ${invalid.setting.min}–${invalid.setting.max} ${invalid.setting.unit} 内。`
    : '';
});

const mix = (a: number, b: number, alpha: number) => a + (b - a) * alpha;
const coefficient = (kind: AxisKind, x: number, y: number) =>
  horizontal.value === kind ? x : dualAxis.value && vertical.value === kind ? y : null;

function valueForAxis(kind: AxisKind, alpha: number): number | null {
  const range = axisSettings.value[kind];
  return range && !axisError.value ? mix(range.values[0], range.values[1], alpha) : null;
}

function axisValue(kind: AxisKind, x: number, y: number): number | null {
  const alpha = coefficient(kind, x, y);
  return alpha === null ? null : valueForAxis(kind, alpha);
}

function setAxis(id: string, kind: AxisKind): void {
  if (id === 'horizontal' && (!dualAxis.value || kind !== vertical.value)) horizontal.value = kind;
  if (id === 'vertical' && kind !== horizontal.value) vertical.value = kind;
}

function setDualAxis(enabled: boolean): void {
  if (enabled && vertical.value === horizontal.value) vertical.value = horizontal.value === 'f0' ? 'mix' : 'f0';
  dualAxis.value = enabled;
  selectedCellKey.value = '1-1';
}

function applyParameterAxes(pose: Record<TractParamName, number>, x: number, y: number): Record<TractParamName, number> {
  for (const axis of axes.value) {
    if (!TRACT_PARAM_KEYS.has(axis.kind)) continue;
    const key = axis.kind as TractParamName;
    const value = axisValue(key, x, y);
    if (value !== null) pose[key] = value;
  }
  return pose;
}

function axisBadge(kind: AxisKind, alpha: number): string {
  if (kind === 'mix') {
    const pctB = Math.round(alpha * 100);
    if (pctB === 0) return '100% A';
    if (pctB === 100) return '100% B';
    return `${100 - pctB}:${pctB}`;
  }
  if (kind === 'phonation') {
    const pctB = Math.round(alpha * 100);
    if (pctB === 0) return regimeA.value;
    if (pctB === 100) return regimeB.value;
    return `${pctB}% ${regimeB.value}`;
  }
  const value = valueForAxis(kind, alpha);
  if (value === null) return '—';
  const unit = axisSettings.value[kind].unit;
  return unit ? `${Math.round(value)} ${unit}` : `${kind} ${value.toFixed(2)}`;
}

// Parameter Locks
const lockLips = ref(continuumPersisted.lockLips);
const lockTongueBody = ref(continuumPersisted.lockTongueBody);
const lockTongueTip = ref(continuumPersisted.lockTongueTip);
const lockVelum = ref(continuumPersisted.lockVelum);
const lockJaw = ref(continuumPersisted.lockJaw);
const equalizeDuration = ref(continuumPersisted.equalizeDuration);

const alignment = computed(() => alignEndpointTimings(audioA.value, audioB.value, equalizeDuration.value));

const lockAxisConflicts = computed<string[]>(() => {
  const activeKinds = new Set(axes.value.map((a) => a.kind));
  const out: string[] = [];
  if (lockLips.value && (activeKinds.has('LP') || activeKinds.has('LD'))) out.push('唇部 (LP/LD)');
  if (lockTongueBody.value && (activeKinds.has('TCX') || activeKinds.has('TCY'))) out.push('舌背 (TCX/TCY)');
  if (lockTongueTip.value && (activeKinds.has('TTX') || activeKinds.has('TTY'))) out.push('舌尖 (TTX/TTY)');
  if (lockVelum.value && (activeKinds.has('VO') || activeKinds.has('VS'))) out.push('软腭 (VO/VS)');
  if (lockJaw.value && (activeKinds.has('JA') || activeKinds.has('JX'))) out.push('下颌 (JA/JX)');
  return out;
});

const themeMode = computed<M27ThemeMode>(() => (store.resolvedColorMode.value === 'dark' ? 'dark' : 'light'));
const themeStamp = computed(
  () => `${themeMode.value}|${store.paletteId.value}|${store.customAccentHex.value}|${JSON.stringify(store.anatomyAppearance.value)}`,
);
const selectedCellKey = ref(continuumPersisted.selectedCellKey);
const sidebarWidth = ref(continuumPersisted.sidebarWidth);
const showInspector = ref(continuumPersisted.showInspector);
const ghostMode = ref<ContinuumGhostMode>(continuumPersisted.ghostMode);

// Persist UI config across tab switches
watchEffect(() => {
  continuumPersisted.presetA = presetA.value;
  continuumPersisted.phonemeA = phonemeA.value;
  continuumPersisted.presetB = presetB.value;
  continuumPersisted.phonemeB = phonemeB.value;
  continuumPersisted.horizontal = horizontal.value;
  continuumPersisted.vertical = vertical.value;
  continuumPersisted.dualAxis = dualAxis.value;
  continuumPersisted.sequenceSteps = sequenceSteps.value;
  continuumPersisted.matrixColumns = matrixColumns.value;
  continuumPersisted.matrixRows = matrixRows.value;
  continuumPersisted.baseMix = baseMix.value;
  continuumPersisted.synthesis = synthesis.value;
  continuumPersisted.speakerRefMode = speakerRefMode.value;
  continuumPersisted.regimeA = regimeA.value;
  continuumPersisted.regimeB = regimeB.value;
  continuumPersisted.axisSettings = axisSettings.value;
  continuumPersisted.lockLips = lockLips.value;
  continuumPersisted.lockTongueBody = lockTongueBody.value;
  continuumPersisted.lockTongueTip = lockTongueTip.value;
  continuumPersisted.lockVelum = lockVelum.value;
  continuumPersisted.lockJaw = lockJaw.value;
  continuumPersisted.equalizeDuration = equalizeDuration.value;
  continuumPersisted.selectedCellKey = selectedCellKey.value;
  continuumPersisted.sidebarWidth = sidebarWidth.value;
  continuumPersisted.showInspector = showInspector.value;
  continuumPersisted.ghostMode = ghostMode.value;
});

// Real JD2 Batch Contours fetched via POST /api/vtl/batch-contours
interface BatchContourCellData extends InspectorContourData {
  partSizes: number[];
  f1_hz: number;
  f2_hz: number;
  f3_hz: number;
  amin_cm2: number;
}

interface BatchContoursApiResponse {
  ok: boolean;
  error?: { hint?: string };
  parts?: string[];
  part_sizes?: number[];
  items?: Array<{
    pts: number[];
    nasal: number;
    lm: number[];
    amin_cm2: number;
    f1_hz: number;
    f2_hz: number;
    f3_hz: number;
  }>;
}

const realContoursByKey = ref<Record<string, BatchContourCellData>>({});
const contoursSource = ref<'loading' | 'vtl-hd' | 'fallback'>('loading');
const contoursError = ref('');
const recoveringEndpoints = computed(
  () =>
    contoursSource.value === 'loading' &&
    [audioA.value, audioB.value].some((source) => source && needsContinuumAnalysis(source)),
);
const cellSvgRefs = new Map<string, SVGSVGElement>();
const view = useContinuumViewport();
const activePlaybackKey = ref('');
const activePlaybackFrame = shallowRef<PaintableTractFrame | null>(null);
const playingSequence = ref(false);
let batchDebounceTimer = 0;
let batchReqSeq = 0;

function paintSingleRealHdCell(key: string, svgEl: SVGSVGElement): void {
  const hd = realContoursByKey.value[key];
  if (!hd) return;
  renderM27TractSvg(
    svgEl,
    {},
    { parts: hd.parts, lm: hd.lm, nasal: hd.nasal, ja: hd.ja, jx: hd.jx },
    { showLabels: false, showGhost: false, theme: { anatomyBg: 'transparent' } },
  );
  svgEl.setAttribute('viewBox', view.viewBox.value);
}

const playback = createContinuumPlayback(
  (key, frame) => {
    const svg = cellSvgRefs.get(key);
    if (frame) {
      activePlaybackKey.value = key;
      activePlaybackFrame.value = frame;
      if (svg) {
        paintReferenceFrame(svg, frame);
        svg.setAttribute('viewBox', view.viewBox.value);
      }
    } else {
      activePlaybackKey.value = '';
      activePlaybackFrame.value = null;
      if (svg) paintSingleRealHdCell(key, svg);
    }
  },
  () => {
    playingSequence.value = false;
  },
);

watch(view.viewBox, (box) => {
  for (const svg of cellSvgRefs.values()) svg.setAttribute('viewBox', box);
});

function registerCellSvgRef(key: string, el: unknown): void {
  if (el instanceof SVGSVGElement) {
    if (cellSvgRefs.get(key) !== el) {
      cellSvgRefs.set(key, el);
      paintSingleRealHdCell(key, el);
    }
  } else {
    cellSvgRefs.delete(key);
  }
}

function interpolateExtras(a: TractPoseExtras, b: TractPoseExtras, alpha: number): TractPoseExtras {
  const u = Math.max(0, Math.min(1, alpha));
  const lerp = (x: number, y: number) => Number((x + (y - x) * u).toFixed(4));
  return cloneTractExtras({
    lip_width: lerp(a.lip_width, b.lip_width),
    larynx_height: lerp(a.larynx_height, b.larynx_height),
    manual_root: u < 0.5 ? a.manual_root : b.manual_root,
    tongue_shape: [
      lerp(a.tongue_shape[0], b.tongue_shape[0]),
      lerp(a.tongue_shape[1], b.tongue_shape[1]),
      lerp(a.tongue_shape[2], b.tongue_shape[2]),
      lerp(a.tongue_shape[3], b.tongue_shape[3]),
    ],
    lip_shape: [
      lerp(a.lip_shape[0], b.lip_shape[0]),
      lerp(a.lip_shape[1], b.lip_shape[1]),
      lerp(a.lip_shape[2], b.lip_shape[2]),
      lerp(a.lip_shape[3], b.lip_shape[3]),
    ],
  });
}

function applyLocksExtras(a: TractPoseExtras, interp: TractPoseExtras): TractPoseExtras {
  const out = cloneTractExtras(interp);
  if (lockLips.value) {
    out.lip_width = a.lip_width;
    out.lip_shape = [...a.lip_shape];
  }
  if (lockTongueBody.value) {
    out.tongue_shape = [...a.tongue_shape];
  }
  return out;
}

function resolveEndpoint(
  src: EndpointSource,
  presetId: string,
  sym: string,
  fallbackM27: 'A' | 'B',
): {
  label: string;
  ipa: string;
  params: Record<TractParamName, number>;
  extras: TractPoseExtras;
  f0Hz: number;
  ready: boolean;
} {
  void ptbPresetsVersion.value;
  const spk = activeSpeaker.value;
  if (src === 'audio') {
    const incoming = received[fallbackM27];
    if (!incoming) {
      return {
        label: `未提供端点 ${fallbackM27} 音频`,
        ipa: '',
        params: defaultTractParams(),
        extras: cloneTractExtras(DEFAULT_TRACT_EXTRAS),
        f0Hz: 160,
        ready: false,
      };
    }
    const representative = representativeContinuumPose(incoming);
    return {
      label: incoming.label || incoming.file.name,
      ipa: incoming.clip?.source?.transcription ?? '',
      params: representative ? tractArray19ToRecord(representative.params) : defaultTractParams(),
      extras: cloneTractExtras(DEFAULT_TRACT_EXTRAS),
      f0Hz: representative?.f0Hz ?? 160,
      ready: true,
    };
  }
  if (src === 'm27') {
    const imp = fallbackM27 === 'A' ? m27ImportedEndpointA.value : m27ImportedEndpointB.value;
    if (!imp) {
      return {
        label: `未导入端点 ${fallbackM27} 构型帧`,
        ipa: '',
        params: defaultTractParams(),
        extras: cloneTractExtras(DEFAULT_TRACT_EXTRAS),
        f0Hz: 160,
        ready: false,
      };
    }
    return {
      label: imp.label,
      ipa: `M27_${fallbackM27}`,
      params: { ...imp.params },
      extras: cloneTractExtras(DEFAULT_TRACT_EXTRAS),
      f0Hz: imp.f0Hz,
      ready: true,
    };
  }
  if (src === 'phoneme') {
    const q = QUICK_IPA_ITEMS.find((x) => x.symbol === sym);
    const full = getFullPoseForIpa(sym, undefined, spk);
    return {
      label: q ? `[${q.symbol}] ${q.nameZh}` : `[${sym}]`,
      ipa: sym,
      params: full.params,
      extras: full.extras,
      f0Hz: fallbackM27 === 'A' ? 185 : 155,
      ready: true,
    };
  }
  const found = presetEndpoints.value.find((p) => p.id === presetId) ?? presetEndpoints.value[0];
  return {
    label: found.label,
    ipa: found.ipa,
    params: { ...found.pose },
    extras: cloneTractExtras(found.extras),
    f0Hz: found.f0Hz,
    ready: true,
  };
}

const endpointA = computed(() => resolveEndpoint(srcA.value, presetA.value, phonemeA.value, 'A'));
const endpointB = computed(() => resolveEndpoint(srcB.value, presetB.value, phonemeB.value, 'B'));
const endpointPanels = [
  { side: 'A', source: srcA, preset: presetA, phoneme: phonemeA, pose: endpointA, audio: audioA, imported: m27ImportedEndpointA },
  { side: 'B', source: srcB, preset: presetB, phoneme: phonemeB, pose: endpointB, audio: audioB, imported: m27ImportedEndpointB },
] as const;
const audioInputs: Record<'A' | 'B', HTMLInputElement | null> = { A: null, B: null };

function applyLocks(
  a: Record<TractParamName, number>,
  interp: Record<TractParamName, number>,
): Record<TractParamName, number> {
  const out = { ...interp };
  if (lockLips.value) {
    out.LP = a.LP;
    out.LD = a.LD;
  }
  if (lockTongueBody.value) {
    out.TCX = a.TCX;
    out.TCY = a.TCY;
  }
  if (lockTongueTip.value) {
    out.TTX = a.TTX;
    out.TTY = a.TTY;
  }
  if (lockVelum.value) {
    out.VO = a.VO;
    out.VS = a.VS;
  }
  if (lockJaw.value) {
    out.JA = a.JA;
    out.JX = a.JX;
  }
  return out;
}

function buildEndpointLandmarks(
  ep: ReturnType<typeof resolveEndpoint>,
  audioSrc: typeof audioA.value,
): ContinuumLandmark[] {
  const clip = audioSrc?.clip;
  if (clip && clip.end_smp > clip.start_smp && clip.syllable_order.length > 0) {
    const segs = clip.syllable_order.flatMap((sid) => clip.syllables[sid]?.segments ?? []);
    if (segs.length > 0) {
      const roleCounts = new Map<string, number>();
      return segs.map((seg) => {
        const cls = classifyContinuumPhone(seg.ipa);
        const idx = (roleCounts.get(cls.role) ?? 0) + 1;
        roleCounts.set(cls.role, idx);
        const midMs = (((seg.start_smp + seg.end_smp) * 0.5 - clip.start_smp) * 1000) / SAMPLE_RATE_HZ;
        return {
          slot_id: segs.length === 1 ? cls.role : `${cls.role}_${idx}`,
          role: cls.role,
          ipa: seg.ipa,
          manner: cls.manner,
          articulator: cls.articulator,
          t_ms: Math.round(midMs * 100) / 100,
          params: validPose(seg.params) ? [...seg.params] : tractRecordToArray19(ep.params),
        };
      });
    }
  }
  const cls = classifyContinuumPhone(ep.ipa);
  return [
    {
      slot_id: 'primary',
      role: cls.role,
      ipa: ep.ipa,
      manner: cls.manner,
      articulator: cls.articulator,
      params: tractRecordToArray19(ep.params),
    },
  ];
}

const stimulusSampleRateHz = computed(() => (synthesis.value === 'neural' ? 16000 : SAMPLE_RATE_HZ));
const hasPhonationAxis = computed(() => axes.value.some((a) => a.kind === 'phonation'));

const continuumManifest = computed(() => {
  if (!endpointsReady.value) return null;
  const lmA = buildEndpointLandmarks(endpointA.value, audioA.value);
  const lmB = buildEndpointLandmarks(endpointB.value, audioB.value);

  const res = buildContinuum2D({
    id: `vc_continuum_${columns.value * rows.value}`,
    label_a: endpointA.value.label,
    label_b: endpointB.value.label,
    landmarks_a: lmA,
    landmarks_b: lmB,
    steps_a: columns.value,
    steps_b: rows.value,
    equalize_duration: equalizeDuration.value,
    dim2: {
      kind: 'phonation',
      regime_a: voqsProfile(regimeA.value)?.legacy ?? 'modal',
      regime_b: voqsProfile(regimeB.value)?.legacy ?? 'breathy',
    },
    speaker: activeSpeaker.value === 'W02' || activeSpeaker.value === 'W02-2D' ? 'W02' : 'JD2',
    sample_rate_hz: stimulusSampleRateHz.value,
  });
  return res.ok ? res.value : null;
});

interface GridCellView {
  key: string;
  stepA: number;
  stepB: number;
  alphaA: number;
  alphaB: number;
  blend: number;
  filename: string;
  params: Record<TractParamName, number>;
  extras: TractPoseExtras;
  metrics?: { f1_hz: number; f2_hz: number; f3_hz: number; amin_cm2: number };
  f0Hz: number;
  durationS: number | null;
  pressurePa: number | null;
  axisBadge: string;
  secondaryMetric: string;
  hasRealHd: boolean;
}

const matrixCells = computed<GridCellView[]>(() => {
  const manifest = continuumManifest.value;
  if (!manifest) return [];
  const realMap = realContoursByKey.value;
  const aArr = tractRecordToArray19(endpointA.value.params);
  const bArr = tractRecordToArray19(endpointB.value.params);
  const useProtectedCore = !audioA.value && !audioB.value && horizontal.value === 'mix';
  const cells: GridCellView[] = [];
  for (let ib = 1; ib <= manifest.steps_b; ib++) {
    for (let ia = 1; ia <= manifest.steps_a; ia++) {
      const raw = manifest.cells.find((c) => c.step_a === ia && c.step_b === ib);
      if (!raw) continue;
      const key = `${ia}-${ib}`;
      const blend = coefficient('mix', raw.alpha_a, raw.alpha_b) ?? baseMix.value / 100;
      const baseArr =
        useProtectedCore && raw.landmarks.length === 1 && validPose(raw.landmarks[0].params)
          ? raw.landmarks[0].params
          : aArr.map((value, i) => mix(value, bArr[i], blend));
      const baseRec = tractArray19ToRecord(baseArr);
      const lockedRec = applyParameterAxes(applyLocks(endpointA.value.params, baseRec), raw.alpha_a, raw.alpha_b);
      const cellExtras = applyLocksExtras(
        endpointA.value.extras,
        interpolateExtras(endpointA.value.extras, endpointB.value.extras, blend),
      );
      const real = realMap[key];
      const f0Hz = Math.round(axisValue('f0', raw.alpha_a, raw.alpha_b) ?? mix(endpointA.value.f0Hz, endpointB.value.f0Hz, blend));
      const millis = axisValue('duration', raw.alpha_a, raw.alpha_b);
      const durationS = millis === null ? null : millis / 1000;
      const pressurePa = axisValue('pressure', raw.alpha_a, raw.alpha_b);
      const secondaryParts: string[] = [];
      if (coefficient('f0', raw.alpha_a, raw.alpha_b) !== null) secondaryParts.push(`F0 ${f0Hz} Hz`);
      if (durationS !== null) secondaryParts.push(`${Math.round(durationS * 1000)} ms`);
      if (pressurePa !== null) secondaryParts.push(`${Math.round(pressurePa)} Pa`);
      cells.push({
        key,
        stepA: ia,
        stepB: ib,
        alphaA: raw.alpha_a,
        alphaB: raw.alpha_b,
        blend,
        filename: raw.filename,
        params: lockedRec,
        extras: cellExtras,
        metrics: real
          ? {
              f1_hz: Math.round(real.f1_hz),
              f2_hz: Math.round(real.f2_hz),
              f3_hz: Math.round(real.f3_hz),
              amin_cm2: real.amin_cm2,
            }
          : undefined,
        f0Hz,
        durationS,
        pressurePa,
        axisBadge: [axisBadge(horizontal.value, raw.alpha_a), ...(dualAxis.value ? [axisBadge(vertical.value, raw.alpha_b)] : [])].join(' · '),
        secondaryMetric: secondaryParts.join(' · '),
        hasRealHd: Boolean(real),
      });
    }
  }
  return cells;
});

const selectedCell = computed(() => matrixCells.value.find((c) => c.key === selectedCellKey.value) ?? matrixCells.value[0] ?? null);
const measuredCell = computed(() => matrixCells.value.find((cell) => cell.key === activePlaybackKey.value) ?? selectedCell.value);

const endpointAContour = computed<InspectorContourData | undefined>(() => {
  const first = matrixCells.value[0];
  if (!first) return undefined;
  return realContoursByKey.value[first.key];
});
const endpointBContour = computed<InspectorContourData | undefined>(() => {
  const rowCells = selectedCell.value && dualAxis.value
    ? matrixCells.value.filter((c) => c.stepB === selectedCell.value!.stepB)
    : matrixCells.value;
  const last = rowCells[rowCells.length - 1];
  if (!last) return undefined;
  return realContoursByKey.value[last.key];
});

const sameEndpointTrack = computed(() => {
  if (!audioA.value || !audioB.value || !axes.value.some((axis) => axis.kind === 'mix')) return false;
  const a = sourceTrajectory(audioA.value);
  const b = sourceTrajectory(audioB.value);
  return (
    a.length > 0 &&
    a.length === b.length &&
    a.every(
      (frame, i) =>
        Math.abs(frame.u - b[i].u) < 1e-6 &&
        frame.params.every((value, j) => Math.abs(value - b[i].params[j]) < 1e-6),
    )
  );
});

function paintAllRealHdCells(): void {
  for (const [key, svg] of cellSvgRefs) paintSingleRealHdCell(key, svg);
}

let batchAbort: AbortController | null = null;
let cellAbort: AbortController | null = null;

async function fetchBatchHdContours(): Promise<void> {
  if (!endpointsReady.value || axisError.value) {
    contoursSource.value = 'fallback';
    contoursError.value = '';
    realContoursByKey.value = {};
    return;
  }
  const seq = ++batchReqSeq;
  batchAbort?.abort();
  batchAbort = new AbortController();
  const signal = batchAbort.signal;
  try {
    const incoming = [
      ['A', audioA.value],
      ['B', audioB.value],
    ] as const;
    const pending = incoming.filter(([, source]) => source && needsContinuumAnalysis(source));
    if (pending.length) {
      const repaired = await Promise.all(
        pending.map(async ([side, source]) => ({
          side,
          source,
          updated: await resolveContinuumSource(source!, store.computeDevice.value, signal),
        })),
      );
      if (signal.aborted || seq !== batchReqSeq) return;
      for (const { side, source, updated } of repaired) if (received[side] === source) received[side] = updated;
      return;
    }
    const cells = matrixCells.value;
    if (!cells.length) return;
    const poses = cells.map((c) => tractRecordToArray19(c.params));
    const batchRes = await defaultVtlTransport.requestBatchContours<BatchContoursApiResponse>(
      {
        speaker: normalizeFactorySpeaker(activeSpeaker.value),
        poses,
        lip_width_frames: cells.map((c) => c.extras.lip_width),
        larynx_height_frames: cells.map((c) => c.extras.larynx_height),
        tongue_shape_frames: cells.map((c) => c.extras.tongue_shape),
        lip_shape_frames: cells.map((c) => c.extras.lip_shape),
        manual_root_frames: cells.map((c) => c.extras.manual_root),
      },
      { signal, timeoutMs: 30_000 },
    );
    if (seq !== batchReqSeq || signal.aborted) return;
    if (!batchRes.ok) {
      throw new Error(batchRes.error.hint || '未取得声道轮廓，请检查本地引擎连接。');
    }
    const data = batchRes.value;
    if (!data.ok || !Array.isArray(data.parts) || !Array.isArray(data.part_sizes) || !Array.isArray(data.items)) {
      throw new Error(data.error?.hint ?? '未取得声道轮廓，请检查本地引擎连接。');
    }
    const nextMap: Record<string, BatchContourCellData> = {};
    cells.forEach((cell, idx) => {
      const item = data.items?.[idx];
      if (!item || !Array.isArray(item.pts)) return;
      nextMap[cell.key] = {
        parts: splitM27TractParts(item.pts, data.parts!, data.part_sizes!),
        partSizes: data.part_sizes!,
        nasal: item.nasal ?? 0,
        lm: item.lm ?? [],
        ja: cell.params.JA,
        jx: cell.params.JX,
        f1_hz: item.f1_hz,
        f2_hz: item.f2_hz,
        f3_hz: item.f3_hz,
        amin_cm2: item.amin_cm2,
      };
    });
    realContoursByKey.value = nextMap;
    contoursSource.value = 'vtl-hd';
    await nextTick();
    paintAllRealHdCells();
  } catch (error) {
    if (signal.aborted) return;
    if (seq === batchReqSeq) {
      contoursSource.value = 'fallback';
      contoursError.value = error instanceof Error ? error.message : '未取得声道轮廓';
    }
  }
}

function scheduleBatchContoursFetch(): void {
  window.clearTimeout(batchDebounceTimer);
  batchReqSeq++;
  if (!endpointsReady.value || axisError.value) {
    realContoursByKey.value = {};
    contoursSource.value = 'fallback';
    contoursError.value = '';
    return;
  }
  realContoursByKey.value = {};
  contoursSource.value = 'loading';
  contoursError.value = '';
  batchDebounceTimer = window.setTimeout(() => {
    void fetchBatchHdContours();
  }, 120);
}

// Precise geometry dependency key: changing F0/duration/pressure/phonation/equalizeDuration will NOT reload tract geometry
const geometryDepsKey = computed(() => {
  const tractAxesKey = axes.value
    .filter((a) => TRACT_PARAM_KEYS.has(a.kind))
    .map((a) => `${a.id}:${a.kind}:${a.setting?.values.join(',') ?? ''}`)
    .join('|');
  const mixAxesKey = axes.value
    .filter((a) => a.kind === 'mix')
    .map((a) => a.id)
    .join(',');
  return JSON.stringify({
    readyA: endpointReadyA.value,
    readyB: endpointReadyB.value,
    srcA: srcA.value,
    srcB: srcB.value,
    pA: endpointA.value.params,
    eA: endpointA.value.extras,
    pB: endpointB.value.params,
    eB: endpointB.value.extras,
    aFile: audioA.value ? `${audioA.value.file.name}:${audioA.value.file.size}:${audioA.value.frames?.length ?? 0}` : null,
    bFile: audioB.value ? `${audioB.value.file.name}:${audioB.value.file.size}:${audioB.value.frames?.length ?? 0}` : null,
    cols: columns.value,
    rows: rows.value,
    mixAxesKey,
    tractAxesKey,
    baseMix: mixAxesKey ? null : baseMix.value,
    locks: [lockLips.value, lockTongueBody.value, lockTongueTip.value, lockVelum.value, lockJaw.value],
    speaker: activeSpeaker.value,
    device: store.computeDevice.value,
    ptb: ptbPresetsVersion.value,
  });
});

watch(geometryDepsKey, () => {
  scheduleBatchContoursFetch();
});

watch(activeSpeaker, (spk) => {
  void preloadPtbIpaPresets(spk);
});

watch(store.engineStatus, (status) => {
  if (status === 'python-vtl' && contoursSource.value === 'fallback' && endpointsReady.value) {
    scheduleBatchContoursFetch();
  }
});

watch(themeStamp, () => {
  void nextTick(() => paintAllRealHdCells());
});

// Precise audio cache dependency key (persisted across tab switches)
const audioDepsKey = computed(() => {
  const activeAxisMeta = axes.value.map((a) => ({
    id: a.id,
    kind: a.kind,
    values: a.setting?.values ?? null,
    regimes: a.kind === 'phonation' ? [regimeA.value, regimeB.value] : null,
  }));
  return JSON.stringify({
    geom: geometryDepsKey.value,
    axes: activeAxisMeta,
    f0A: endpointA.value.f0Hz,
    f0B: endpointB.value.f0Hz,
    eq: equalizeDuration.value,
    synth: synthesis.value,
    spkRef: synthesis.value === 'neural' ? speakerRefMode.value : null,
  });
});

const rendered = continuumPersisted.rendered;
const cachedKeys = ref<Set<string>>(new Set(rendered.keys()));
const renderedWavMeta = ref<Record<string, WavHeaderSummary & { filename: string }>>(continuumPersisted.renderedWavMeta);
const rendering = ref('');
const controlsBusy = computed(() => Boolean(rendering.value || recoveringEndpoints.value || axisError.value || !endpointsReady.value));
const renderVersion = ref(0);
const lastSequenceAudio = shallowRef<AudioBuffer | null>(continuumPersisted.lastSequenceAudio);
const lastSequenceParts = shallowRef<Array<{ key: string; start_s: number; end_s: number }> | undefined>(
  continuumPersisted.lastSequenceParts,
);

function syncAudioCacheKey(nextKey: string): void {
  if (continuumPersisted.renderedCacheKey === nextKey) return;
  continuumPersisted.renderedCacheKey = nextKey;
  cellAbort?.abort();
  cellAbort = new AbortController();
  rendered.clear();
  cachedKeys.value = new Set();
  renderedWavMeta.value = {};
  continuumPersisted.renderedWavMeta = {};
  lastSequenceAudio.value = null;
  continuumPersisted.lastSequenceAudio = null;
  lastSequenceParts.value = undefined;
  continuumPersisted.lastSequenceParts = undefined;
  renderVersion.value++;
  playback.stop();
}

watch(audioDepsKey, (nextKey) => {
  syncAudioCacheKey(nextKey);
});

// Ensure persisted cache matches current key on initial mount
syncAudioCacheKey(audioDepsKey.value);

function cancelBatch(): void {
  cellAbort?.abort();
  cellAbort = new AbortController();
  playback.stop();
  rendering.value = '';
  store.pushToast('已取消当前批量处理', 'info', 2200);
}

function checkEndpoint(mode: EndpointSource, data: typeof audioA.value, imp: typeof m27ImportedEndpointA.value, name: string): void {
  if (mode === 'audio' && !data) throw new Error(`请提供端点 ${name} 的音频。`);
  if (mode === 'm27' && !imp) throw new Error(`请先从声道重建发送端点 ${name} 的当前帧。`);
}

async function prepareCell(cell: GridCellView): Promise<RenderedCell> {
  if (axisError.value) throw new Error(axisError.value);
  const existing = rendered.get(cell.key);
  if (existing) return existing;
  const a = audioA.value;
  const b = audioB.value;
  const leftEndpoint = endpointA.value;
  const rightEndpoint = endpointB.value;
  const synth = synthesis.value;
  const equalize = equalizeDuration.value;
  const speaker = normalizeFactorySpeaker(activeSpeaker.value);
  const version = renderVersion.value;
  cellAbort ??= new AbortController();
  const signal = cellAbort.signal;
  const job = (async () => {
    checkEndpoint(srcA.value, a, m27ImportedEndpointA.value, 'A');
    checkEndpoint(srcB.value, b, m27ImportedEndpointB.value, 'B');
    const [resolvedA, resolvedB, wholeA, wholeB] = await Promise.all([
      a ? resolveContinuumSource(a, store.computeDevice.value, signal) : null,
      b ? resolveContinuumSource(b, store.computeDevice.value, signal) : null,
      endpointDuration(a),
      endpointDuration(b),
    ]);
    if (signal.aborted) throw new DOMException('已取消合成', 'AbortError');
    if (version !== renderVersion.value) throw new Error('端点配置已更新，请重新生成。');
    const selectedAlignment = alignEndpointTimings(resolvedA, resolvedB, equalize);
    const durationA = endpointEffectiveDuration(resolvedA, wholeA);
    const durationB = endpointEffectiveDuration(resolvedB, wholeB);
    const alpha = cell.blend;
    const duration = cell.durationS ?? (equalize ? Math.max(durationA, durationB) : mix(durationA, durationB, alpha));
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('端点时长无效。');
    if (duration > 10) throw new Error('请选用 10 秒以内的端点，或使用时长轴指定输出时长。');
    const stride = synth === 'neural' ? 2 : 1;
    const frameCount = Math.max(2, Math.round((duration * STEP_HZ) / stride)) * stride;
    const p = resolvedA ? sourceTrajectory(resolvedA, wholeA) : [{ u: 0, params: tractRecordToArray19(leftEndpoint.params) }];
    const q = resolvedB ? sourceTrajectory(resolvedB, wholeB) : [{ u: 0, params: tractRecordToArray19(rightEndpoint.params) }];
    if (!p.length || !q.length) throw new Error('本地模型没有返回可用的端点轨迹。');
    const warp = timeWarp(selectedAlignment, alpha);
    const times = Array.from({ length: frameCount }, (_, i) => warp(i / frameCount));
    const staticPoseArr = !resolvedA && !resolvedB ? tractRecordToArray19(cell.params) : null;
    const poses = times.map(([atA, atB]) => {
      if (staticPoseArr) return [...staticPoseArr];
      const left = interpolatePose(p, atA);
      const right = interpolatePose(q, atB);
      const blended = tractArray19ToRecord(left.map((v, j) => mix(v, right[j], alpha)));
      return tractRecordToArray19(applyParameterAxes(applyLocks(tractArray19ToRecord(left), blended), cell.alphaA, cell.alphaB));
    });
    const phonation = coefficient('phonation', cell.alphaA, cell.alphaB);
    const modal = PHONATION_M27_ANCHORS.modal;
    const g = interpolateGlottis10D(
      phonation === null ? modal : takeA.value?.glottis ?? modal,
      takeB.value?.glottis ?? PHONATION_M27_ANCHORS.breathy,
      phonation ?? 0,
    );
    if (!g.ok) throw new Error('发声类型参数无效。');
    const gl = g.value;
    const baseGlottis = [gl.xb_cm, gl.xt_cm, gl.ca_cm2, gl.lag_rad, gl.ra, gl.ps, gl.fl, gl.shim];
    const controls = times.map(([atA, atB], frameIndex) => {
      const left = sourceControls(resolvedA, wholeA, atA);
      const right = sourceControls(resolvedB, wholeB, atB);
      const f0Res = resolveContinuumFramePitch({
        leftF0Hz: left ? left[17] : undefined,
        rightF0Hz: right ? right[17] : undefined,
        leftEndpointF0Hz: leftEndpoint.f0Hz,
        rightEndpointF0Hz: rightEndpoint.f0Hz,
        alpha,
        axisOverrideHz: axisValue('f0', cell.alphaA, cell.alphaB),
        frameIndex,
      });
      if (!f0Res.ok) {
        store.pushToast(f0Res.error.hint, 'warning', 4500);
        throw new Error(f0Res.error.hint);
      }
      const f0 = f0Res.value;
      const pressure = cell.pressurePa ?? (phonation === null ? mix(left?.[18] ?? gl.pr_pa, right?.[18] ?? gl.pr_pa, alpha) : gl.pr_pa);
      const glottis =
        phonation !== null
          ? baseGlottis
          : baseGlottis.map((value, column) => mix(left?.[column + 19] ?? value, right?.[column + 19] ?? value, alpha));
      return { f0, pressure, glottis };
    });
    const trajectory = poses.map((params, i) => ({ u: i / frameCount, params }));
    trajectory.push({ u: 1, params: poses[poses.length - 1] });
    if (synth === 'neural') {
      const spkChoice = resolveUniformSpeakerRef(a, b, speakerRefMode.value);
      const speakerRef = spkChoice.file;
      const rowsData = poses.flatMap((pose, i) =>
        i % 2 ? [] : [[...pose.slice(0, 14), ...pose.slice(16), controls[i].f0, controls[i].pressure, ...controls[i].glottis]],
      );
      const result = await new M27Adapter().resynthesize({
        m27_50hz_pa: rowsData,
        synth_mode: 'neural',
        compute_device: store.computeDevice.value,
        audio_gain: 'original',
        speaker_ref_wav_base64: speakerRef ? await blobToBase64(speakerRef) : undefined,
        speaker_ref_filename: speakerRef?.name,
        signal,
      });
      if (signal.aborted) throw new DOMException('已取消合成', 'AbortError');
      if (!result.ok) throw new Error(result.error.hint);
      if (version !== renderVersion.value) throw new Error('端点配置已更新，请重新生成。');
      const data = result.value;
      if (!data.neural_16k_wav_base64 || !data.tract_glottis_anim?.frames.length) {
        throw new Error('神经声码器没有返回音频或构型帧。');
      }
      const wavBytes = Uint8Array.from(atob(data.neural_16k_wav_base64), (c) => c.charCodeAt(0));
      const wav = new File([wavBytes], cell.filename, { type: 'audio/wav' });
      const header = inspectWavHeader(wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength));
      if (header) {
        renderedWavMeta.value = { ...renderedWavMeta.value, [cell.key]: { ...header, filename: cell.filename } };
        continuumPersisted.renderedWavMeta = renderedWavMeta.value;
      }
      const length = header?.durationS ?? rowsData.length / 50;
      return {
        wav,
        frames: referenceFramesFromM27(data.tract_glottis_anim, trajectory),
        duration: length,
        trajectory,
        clip: buildOutputAnnotation(selectedAlignment, alpha, Math.round(length * SAMPLE_RATE_HZ), trajectory),
      };
    }
    const synthRes = await defaultVtlTransport.requestSynthesizeRaw(
      {
        speaker,
        step_hz: STEP_HZ,
        fps: 25,
        tract_frames: poses,
        audio_gain: 'original',
        f0_hz: controls.map((frame) => frame.f0),
        pressure_pa: controls.map((frame) => frame.pressure),
        glottis_frames: controls.map((frame) => frame.glottis),
        per_frame_shimmer: true,
        lip_width_frames: poses.map(() => cell.extras.lip_width),
        larynx_height_frames: poses.map(() => cell.extras.larynx_height),
        tongue_shape_frames: poses.map(() => cell.extras.tongue_shape),
        lip_shape_frames: poses.map(() => cell.extras.lip_shape),
        manual_root_frames: poses.map(() => cell.extras.manual_root),
        shimmer: gl.shim,
        flutter: gl.fl,
      },
      { signal, timeoutMs: 90_000 },
    );
    if (signal.aborted) throw new DOMException('已取消合成', 'AbortError');
    if (version !== renderVersion.value) throw new Error('端点配置已更新，请重新生成。');
    if (!synthRes.ok || synthRes.value.kind !== 'json') {
      throw new Error(!synthRes.ok ? synthRes.error.hint : '声道引擎未生成音频和构型帧。');
    }
    const result = synthRes.value.data as {
      ok?: boolean;
      wav_base64?: string;
      duration_s: number;
      geometry_frames?: RenderedCell['frames'];
      error?: { hint?: string };
    };
    if (!result.wav_base64 || !result.geometry_frames?.length) {
      throw new Error(result.error?.hint ?? '声道引擎未生成音频和构型帧。');
    }
    const wavBytes = Uint8Array.from(atob(result.wav_base64), (c) => c.charCodeAt(0));
    const wav = new File([wavBytes], cell.filename, { type: 'audio/wav' });
    const header = inspectWavHeader(wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength));
    if (header) {
      renderedWavMeta.value = { ...renderedWavMeta.value, [cell.key]: { ...header, filename: cell.filename } };
      continuumPersisted.renderedWavMeta = renderedWavMeta.value;
    }
    const durationSmp = Math.round(result.duration_s * SAMPLE_RATE_HZ);
    return {
      wav,
      frames: result.geometry_frames,
      duration: result.duration_s,
      trajectory,
      clip: buildOutputAnnotation(selectedAlignment, alpha, durationSmp, trajectory),
    };
  })();
  rendered.set(cell.key, job);
  try {
    const out = await job;
    const nextSet = new Set(cachedKeys.value);
    nextSet.add(cell.key);
    cachedKeys.value = nextSet;
    return out;
  } catch (error) {
    if (rendered.get(cell.key) === job) rendered.delete(cell.key);
    throw error;
  }
}

let mounted = true;
let continuumTourAbort: AbortController | null = null;

async function handleContinuumTourAction(e: Event): Promise<void> {
  const detail = (e as CustomEvent<{ actionId?: string; done?: (ok?: boolean) => void }>).detail;
  if (detail?.actionId !== 'continuum-load-suan-swan') return;
  continuumTourAbort?.abort();
  continuumTourAbort = new AbortController();
  const signal = continuumTourAbort.signal;
  const [resA, resB] = await Promise.all([
    fetchOnboardingAudioFile(
      CONTINUUM_REAL_PAIR_SAMPLES.sideA.relativeUrl,
      CONTINUUM_REAL_PAIR_SAMPLES.sideA.filename,
      signal,
    ),
    fetchOnboardingAudioFile(
      CONTINUUM_REAL_PAIR_SAMPLES.sideB.relativeUrl,
      CONTINUUM_REAL_PAIR_SAMPLES.sideB.filename,
      signal,
    ),
  ]);
  if (!mounted || signal.aborted) return;
  if (!resA.ok || !resB.ok) {
    store.pushToast('未能读取内置「算 / swan」对比录音文件', 'warning', 2800);
    detail?.done?.(false);
    return;
  }
  received.A = { file: resA.file, label: CONTINUUM_REAL_PAIR_SAMPLES.sideA.label };
  received.B = { file: resB.file, label: CONTINUUM_REAL_PAIR_SAMPLES.sideB.label };
  srcA.value = 'audio';
  srcB.value = 'audio';
  store.pushToast('已载入真人对照端点：汉语「算」↔ 英语「swan」', 'success', 3000);
  detail?.done?.(true);
}

function handleKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  const cur = selectedCell.value;
  if (!cur || !matrixCells.value.length) return;
  if (event.code === 'Space') {
    event.preventDefault();
    if (!controlsBusy.value) auditionCell(cur);
    return;
  }
  let nextA = cur.stepA;
  let nextB = cur.stepB;
  if (event.key === 'ArrowLeft') nextA = Math.max(1, cur.stepA - 1);
  else if (event.key === 'ArrowRight') nextA = Math.min(columns.value, cur.stepA + 1);
  else if (event.key === 'ArrowUp' && dualAxis.value) nextB = Math.max(1, cur.stepB - 1);
  else if (event.key === 'ArrowDown' && dualAxis.value) nextB = Math.min(rows.value, cur.stepB + 1);
  else return;
  event.preventDefault();
  selectedCellKey.value = `${nextA}-${nextB}`;
}

onMounted(() => {
  void preloadPtbIpaPresets(activeSpeaker.value);
  if (endpointsReady.value && !axisError.value) void fetchBatchHdContours();
  window.addEventListener('vocalcut:tour-action', handleContinuumTourAction);
  window.addEventListener('keydown', handleKeydown);
});

onBeforeUnmount(() => {
  mounted = false;
  stopEndpointMic();
  window.removeEventListener('vocalcut:tour-action', handleContinuumTourAction);
  window.removeEventListener('keydown', handleKeydown);
  continuumTourAbort?.abort();
  continuumTourAbort = null;
  batchReqSeq++;
  batchAbort?.abort();
  window.clearTimeout(batchDebounceTimer);
  playback.stop();
});

function selectCell(key: string): void {
  selectedCellKey.value = key;
}

async function cellAction(cell: GridCellView, dest: 'play' | 'studio' | 'annotation' | 'wav' | 'video'): Promise<void> {
  if (controlsBusy.value) return;
  const version = renderVersion.value;
  const isCurrent = () => mounted && version === renderVersion.value && selectedCellKey.value === cell.key;
  selectedCellKey.value = cell.key;
  rendering.value = `第 ${cell.stepA}${dualAxis.value ? `·${cell.stepB}` : ''} 格`;
  const peak = synthesisGainMode.value === 'peak';
  try {
    const ctx = dest === 'play' ? studioAudioContext() : null;
    if (ctx) {
      playback.stop();
      await ctx.resume();
    }
    const result = await prepareCell(cell);
    if (!isCurrent()) return;
    if (ctx) {
      const buffer = await ctx.decodeAudioData(await result.wav.arrayBuffer());
      if (!isCurrent()) return;
      if (peak) applyPeakAudioGain(buffer);
      playback.start(ctx, buffer, [{ key: cell.key, startS: 0, endS: buffer.duration, frames: result.frames }]);
    } else {
      const wav = peak ? await peakContinuumWav(result.wav) : result.wav;
      if (!isCurrent()) return;
      if (dest === 'wav') {
        const hdr = inspectWavHeader(await wav.arrayBuffer());
        if (hdr) {
          renderedWavMeta.value = { ...renderedWavMeta.value, [cell.key]: { ...hdr, filename: cell.filename } };
          continuumPersisted.renderedWavMeta = renderedWavMeta.value;
        }
      }
      if (dest === 'studio' || dest === 'annotation') {
        sendWorkspaceAudio(dest, { file: wav, label: `连续统 ${cell.key}`, clip: result.clip, frames: result.trajectory });
        return;
      }
      const targetName = dest === 'wav' ? cell.filename : cell.filename.replace(/\.wav$/i, '.webm');
      const blob = dest === 'wav' ? wav : await cellMovie({ ...result, wav }, { viewBox: view.viewBoxObj.value });
      if (isCurrent()) triggerDownload(blob, targetName);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    if (isCurrent()) store.pushToast(error instanceof Error ? error.message : String(error), 'warning');
  } finally {
    rendering.value = '';
  }
}

function auditionCell(cell: GridCellView): void {
  void cellAction(cell, 'play');
}

async function renderSequence(mode: 'synth' | 'play' | 'download-seq' | 'zip'): Promise<void> {
  if (mode === 'play' && playingSequence.value) {
    playback.stop();
    return;
  }
  if (controlsBusy.value || !matrixCells.value.length) return;
  const cells = [...matrixCells.value];
  const version = renderVersion.value;
  const current = () => mounted && version === renderVersion.value;
  const peak = synthesisGainMode.value === 'peak';
  rendering.value = `1 / ${cells.length}`;
  try {
    const needsAudioCtx = mode === 'play' || mode === 'download-seq';
    const ctx = needsAudioCtx ? studioAudioContext() : null;
    if (ctx) {
      playback.stop();
      await ctx.resume();
    }
    const results: RenderedCell[] = [];
    for (const [index, cell] of cells.entries()) {
      if (!current()) return;
      rendering.value = `${index + 1} / ${cells.length}`;
      results.push(await prepareCell(cell));
    }
    if (!current()) return;
    if (mode === 'zip') {
      rendering.value = '打包 ZIP…';
      const wavFiles = await Promise.all(
        cells.map(async (cell, idx) => {
          const wav = peak ? await peakContinuumWav(results[idx].wav) : results[idx].wav;
          return { filename: cell.filename, wav };
        }),
      );
      if (!current()) return;
      const bundle = buildStimulusBundle();
      if (!bundle) return;
      const csvText = buildStimulusCsv(bundle.acoustic_table);
      const zipBlob = await buildStimulusZip({
        bundleJson: JSON.stringify(bundle, null, 2),
        csvText,
        wavFiles,
      });
      if (!current()) return;
      triggerDownload(zipBlob, `continuum_${cells.length}_${Date.now()}.zip`);
      store.pushToast(`已导出 ${cells.length} 格完整刺激包 (ZIP)`, 'success');
      return;
    }
    if (ctx) {
      const buffers = await Promise.all(results.map(async ({ wav }) => ctx.decodeAudioData(await wav.arrayBuffer())));
      if (!current()) return;
      const buffer = joinContinuumAudio(ctx, buffers);
      if (peak) applyPeakAudioGain(buffer);
      if (mode === 'download-seq') {
        const seqFile = audioBufferFile(buffer, `continuum_sequence_${cells.length}_${Date.now()}`);
        triggerDownload(seqFile, seqFile.name);
        store.pushToast(`已下载 ${cells.length} 格拼接序列音频`, 'success');
        return;
      }
      const gap = Math.round(ctx.sampleRate * CONTINUUM_GAP_S);
      let cursor = 0;
      const parts: ContinuumPlaybackPart[] = buffers.map((clip, index) => {
        const startS = cursor / ctx.sampleRate;
        cursor += clip.length;
        const endS = cursor / ctx.sampleRate;
        cursor += gap;
        return { key: cells[index].key, startS, endS, frames: results[index].frames };
      });
      lastSequenceAudio.value = buffer;
      continuumPersisted.lastSequenceAudio = buffer;
      lastSequenceParts.value = parts.map((p) => ({ key: p.key, start_s: p.startS, end_s: p.endS }));
      continuumPersisted.lastSequenceParts = lastSequenceParts.value;
      playback.start(ctx, buffer, parts);
      playingSequence.value = true;
    } else {
      store.pushToast(`已合成全部 ${cells.length} 格`, 'success');
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    if (current()) store.pushToast(error instanceof Error ? error.message : String(error), 'warning');
  } finally {
    rendering.value = '';
  }
}

function buildStimulusBundle() {
  const manifest = continuumManifest.value;
  if (!manifest || axisError.value) return null;
  const spkChoice = resolveUniformSpeakerRef(audioA.value, audioB.value, speakerRefMode.value);
  return {
    schema: 'vocalcut/continuum-stimulus-pack',
    generated_at: new Date().toISOString(),
    compute_device: store.computeDevice.value,
    geometry_source: contoursSource.value,
    project_timebase_hz: SAMPLE_RATE_HZ,
    stimulus_sample_rate_hz: stimulusSampleRateHz.value,
    axes: axes.value.map((axis) => ({
      dimension: axis.id,
      kind: axis.kind,
      values: axis.setting?.values,
      unit: axis.setting?.unit,
    })),
    synthesis: synthesis.value,
    speaker_reference:
      synthesis.value === 'neural'
        ? {
            mode: speakerRefMode.value,
            effective_source: spkChoice.sourceSide,
            filename: spkChoice.file?.name ?? null,
          }
        : null,
    phonation: hasPhonationAxis.value
      ? [
          { symbol: regimeA.value, source: takeA.value?.id },
          { symbol: regimeB.value, source: takeB.value?.id },
        ]
      : null,
    time_alignment: alignment.value.compatible ? 'phoneme-boundaries' : 'relative-duration',
    endpoint_a: endpointA.value.label,
    endpoint_b: endpointB.value.label,
    locks: {
      lips: lockLips.value,
      tongue_body: lockTongueBody.value,
      tongue_tip: lockTongueTip.value,
      velum: lockVelum.value,
      jaw: lockJaw.value,
      equalize_duration: equalizeDuration.value,
    },
    manifest: {
      ...manifest,
      sample_rate_hz: stimulusSampleRateHz.value,
      cells: manifest.cells.map(({ f0_target: _target, glottis, ...cell }) => {
        const viewCell = matrixCells.value.find((item) => item.stepA === cell.step_a && item.stepB === cell.step_b);
        return {
          ...cell,
          ...(hasPhonationAxis.value ? { glottis } : {}),
          extras: viewCell ? cloneTractExtras(viewCell.extras) : undefined,
          landmarks:
            viewCell && cell.landmarks.length === 1
              ? [{ ...cell.landmarks[0], params: tractRecordToArray19(viewCell.params) }]
              : cell.landmarks,
        };
      }),
    },
    acoustic_table: matrixCells.value.map((c) => {
      const actualWav = renderedWavMeta.value[c.key];
      const sr = actualWav?.sampleRateHz ?? stimulusSampleRateHz.value;
      const durMs = actualWav
        ? Math.round(actualWav.durationS * 1000)
        : c.durationS == null
          ? undefined
          : Math.round(c.durationS * 1000);
      return {
        step_a: c.stepA,
        step_b: c.stepB,
        filename: actualWav?.filename ?? c.filename,
        sample_rate_hz: sr,
        num_samples: actualWav?.numSamples,
        f0_hz: c.f0Hz,
        duration_ms: durMs,
        pressure_pa: c.pressurePa ?? undefined,
        lip_width: c.extras.lip_width,
        larynx_height_cm: c.extras.larynx_height,
        manual_root: c.extras.manual_root,
        f1_hz: c.metrics?.f1_hz || undefined,
        f2_hz: c.metrics?.f2_hz || undefined,
        f3_hz: c.metrics?.f3_hz || undefined,
        amin_cm2: c.metrics?.amin_cm2,
      };
    }),
  };
}

function exportStimulusPackage(): void {
  const bundle = buildStimulusBundle();
  if (!bundle) return;
  downloadTextFile(`continuum_${bundle.manifest.cells.length}_${Date.now()}.json`, JSON.stringify(bundle, null, 2));
  store.pushToast(`已导出 ${bundle.manifest.cells.length} 格连续统实验参数`, 'success');
}

watchEffect(() => {
  const realMap = realContoursByKey.value;
  publishPanelSnapshot('continuum', {
    dualAxis: dualAxis.value,
    horizontalAxis: horizontal.value,
    verticalAxis: vertical.value,
    columns: columns.value,
    rows: rows.value,
    labelA: endpointA.value.label,
    ipaA: endpointA.value.ipa,
    labelB: endpointB.value.label,
    ipaB: endpointB.value.ipa,
    viewBox: view.viewBox.value,
    cells: matrixCells.value.map((c) => {
      const hd = realMap[c.key];
      return {
        key: c.key,
        stepA: c.stepA,
        stepB: c.stepB,
        blend: c.blend,
        f0_hz: c.f0Hz,
        axisBadge: c.axisBadge,
        params: { ...c.params },
        extras: cloneTractExtras(c.extras),
        metrics: c.metrics ? { ...c.metrics } : undefined,
        hdContour: hd ? { parts: hd.parts, lm: hd.lm, nasal: hd.nasal } : undefined,
      };
    }),
    sequenceAudio: lastSequenceAudio.value,
    sequenceParts: lastSequenceParts.value,
  });
});
</script>

<template>
  <div class="cont-shell" :style="{ '--continuum-sidebar': sidebarWidth + 'px' }">
    <!-- Left Sidebar: Independent Endpoint A / B Sources + Parameter Locks + Synthesis -->
    <aside class="panel cont-left">
      <div class="p-head">
        <span>生理连续统配置</span>
        <div class="cont-head-right" data-tour="continuum-guide-btn">
          <span class="tree-tag">{{ dualAxis ? `${columns} × ${rows} 格` : `${columns} 格` }}</span>
          <ModuleGuideButton module-id="continuum" size="xs" />
        </div>
      </div>
      <div class="p-body cont-left-body">
        <div class="cont-endpoints-group" data-tour="continuum-endpoints">
          <template v-for="(panel, idx) in endpointPanels" :key="panel.side">
            <section class="cont-endpoint" :aria-label="`端点 ${panel.side}`">
              <div class="cont-endpoint-head">
                <strong>端点 {{ panel.side }}</strong>
                <span v-if="panel.pose.value.ipa" class="ipa muted notranslate" translate="no" :title="panel.pose.value.ipa">{{ panel.pose.value.ipa }}</span>
              </div>
              <CustomSelect v-model="panel.source.value" :aria-label="`端点 ${panel.side} 来源`" :options="sourceOptions" size="sm" style="width: 100%" />
              <CustomSelect
                v-if="panel.source.value === 'preset'"
                v-model="panel.preset.value"
                :aria-label="`端点 ${panel.side} 预设`"
                :options="presetOptions"
                size="sm"
                style="width: 100%"
              />
              <CustomSelect
                v-else-if="panel.source.value === 'phoneme'"
                v-model="panel.phoneme.value"
                :aria-label="`端点 ${panel.side} 音素`"
                :options="phonemeOptions"
                size="sm"
                style="width: 100%"
              />
              <div
                v-else-if="panel.audio.value || (panel.source.value === 'm27' && panel.imported.value)"
                class="cont-endpoint-name"
                :title="panel.pose.value.label"
              >
                {{ panel.pose.value.label }}
              </div>
              <small v-else class="cont-missing-hint">
                请从标注/声道重建发送{{ panel.source.value === 'm27' ? '构型帧' : '音段' }}，或点击下方导入音频
              </small>
              <div class="cont-endpoint-actions">
                <ReconstructionMicControl
                  size="xs"
                  idle-label="录音"
                  active-label="停止"
                  :acquiring="acquiringMicSide === panel.side"
                  :recording="recordingSide === panel.side"
                  :elapsed="micElapsed"
                  :bars="micBars"
                  :quiet="micQuiet"
                  :disabled="Boolean((recordingSide && recordingSide !== panel.side) || (acquiringMicSide && acquiringMicSide !== panel.side))"
                  @toggle="toggleEndpointRecord(panel.side)"
                >
                  <button
                    type="button"
                    class="btn xs"
                    :class="{ primary: panel.source.value === 'audio' && !panel.audio.value }"
                    :aria-label="`导入端点 ${panel.side} 音频`"
                    :disabled="Boolean(recordingSide)"
                    @click="audioInputs[panel.side]?.click()"
                  >
                    <IconSvg name="upload" :size="11" />{{ panel.source.value === 'audio' ? '导入' : '导入音频' }}
                  </button>
                  <button
                    v-if="panel.audio.value"
                    type="button"
                    class="btn xs"
                    :disabled="Boolean(recordingSide || cleaningSide)"
                    title="裁剪、去首尾静音、降噪或填写原文自动音素对齐"
                    @click="openEndpointAudioEditor(panel.side)"
                  >
                    <IconSvg name="trim" :size="11" />编辑
                  </button>
                  <button
                    v-if="panel.audio.value"
                    type="button"
                    class="btn xs"
                    :disabled="Boolean(cleaningSide || recordingSide)"
                    @click="toggleEndpointNoise(panel.side)"
                  >
                    {{ cleaningSide === panel.side ? '降噪中…' : originalEndpointAudio.has(panel.audio.value.file) ? '恢复原音' : '降噪' }}
                  </button>
                </ReconstructionMicControl>
                <input
                  :ref="(element) => (audioInputs[panel.side] = element as HTMLInputElement | null)"
                  :aria-label="`端点 ${panel.side} 音频`"
                  type="file"
                  accept="audio/*"
                  hidden
                  @change="uploadEndpoint(panel.side, $event)"
                />
              </div>
            </section>
            <div v-if="idx === 0" class="cont-swap-row">
              <button type="button" class="btn xs" title="互换端点 A 与端点 B" @click="swapEndpoints">
                <IconSvg name="shuffle" :size="12" />
                <span>互换 A ↔ B</span>
              </button>
            </div>
          </template>
        </div>

        <div class="cont-config-section" data-tour="continuum-axes">
          <div class="cont-section-head">
            <strong>变化参数</strong>
            <label class="cont-check">
              <input type="checkbox" :checked="dualAxis" @change="setDualAxis(($event.target as HTMLInputElement).checked)" />
              启用第二维度
            </label>
          </div>
          <label class="cont-step-field">
            {{ dualAxis ? '横轴格数' : '序列格数' }}
            <input
              type="number"
              class="inp mono"
              aria-label="连续统格数"
              min="2"
              :max="dualAxis ? 16 : 51"
              step="1"
              :value="columns"
              @change="setStepCount"
            />
          </label>
          <label v-if="dualAxis" class="cont-step-field">
            纵轴格数
            <input
              type="number"
              class="inp mono"
              aria-label="纵轴格数"
              min="2"
              max="8"
              step="1"
              :value="matrixRows"
              @change="setRowCount"
            />
          </label>
          <div v-for="axis in axes" :key="axis.id" class="continuum-axis">
            <span v-if="dualAxis" class="muted">{{ axis.label }}</span>
            <CustomSelect
              :aria-label="axis.label"
              :model-value="axis.kind"
              :options="axis.options"
              size="sm"
              style="width: 100%"
              @update:model-value="(value) => setAxis(axis.id, value as AxisKind)"
            />
            <div v-if="axis.setting" class="axis-endpoints" :class="{ 'no-unit': !axis.setting.unit }">
              <label>
                起点
                <input
                  v-model.number="axis.setting.values[0]"
                  type="number"
                  class="inp mono"
                  :aria-label="axis.label + '起点'"
                  :min="axis.setting.min"
                  :max="axis.setting.max"
                  :step="axis.setting.step ?? 1"
                />
              </label>
              <label>
                终点
                <input
                  v-model.number="axis.setting.values[1]"
                  type="number"
                  class="inp mono"
                  :aria-label="axis.label + '终点'"
                  :min="axis.setting.min"
                  :max="axis.setting.max"
                  :step="axis.setting.step ?? 1"
                />
              </label>
              <span v-if="axis.setting.unit" class="muted">{{ axis.setting.unit }}</span>
            </div>
            <div v-else-if="axis.kind === 'phonation'" class="axis-phonation">
              <label>
                <span class="muted">起点发声类型</span>
                <CustomSelect v-model="regimeA" :options="regimeOptions" size="sm" style="width: 100%" />
              </label>
              <label>
                <span class="muted">终点发声类型</span>
                <CustomSelect v-model="regimeB" :options="regimeOptions" size="sm" style="width: 100%" />
              </label>
            </div>
          </div>
          <CompactSlider
            v-if="!axes.some((axis) => axis.kind === 'mix')"
            v-model="baseMix"
            label="固定端点 B 权重"
            :min="0"
            :max="100"
            :step="1"
            :decimals="0"
            :default-value="50"
            unit="%"
          />
          <p v-if="axisError" class="cont-warn" role="alert">{{ axisError }}</p>
        </div>

        <div class="cont-config-section" data-tour="continuum-locks">
          <div class="cont-section-head">
            <strong>构音参数锁定</strong>
            <span class="muted">保持端点 A</span>
          </div>
          <div class="cont-lock-list">
            <label class="cont-check" title="LP / LD 与唇形"><input v-model="lockLips" type="checkbox" />唇部</label>
            <label class="cont-check" title="TCX / TCY 与舌形"><input v-model="lockTongueBody" type="checkbox" />舌背</label>
            <label class="cont-check" title="TTX / TTY"><input v-model="lockTongueTip" type="checkbox" />舌尖</label>
            <label class="cont-check" title="VO / VS"><input v-model="lockVelum" type="checkbox" />软腭鼻化</label>
            <label class="cont-check" title="JA / JX"><input v-model="lockJaw" type="checkbox" />下颌开口</label>
          </div>
          <p v-if="lockAxisConflicts.length" class="cont-warn">
            变化轴与锁定项重合（{{ lockAxisConflicts.join('、') }}），变化轴将优先覆盖锁定值。
          </p>
        </div>

        <div class="cont-config-section">
          <label class="cont-check"><input v-model="equalizeDuration" type="checkbox" />端点等时长对齐</label>
          <p class="cont-note">{{ alignment.message }}</p>
        </div>

        <div class="cont-config-section" data-tour="continuum-synth">
          <div class="cont-section-head"><strong>合成与元数据</strong></div>
          <CustomSelect
            v-model="synthesis"
            aria-label="连续统合成方式"
            size="sm"
            style="width: 100%"
            :options="[
              { value: 'neural', label: voiceRenderLabels.neural },
              { value: 'vtl', label: voiceRenderLabels.physical },
            ]"
          />
          <CustomSelect
            v-if="synthesis === 'neural' && (audioA || audioB)"
            v-model="speakerRefMode"
            aria-label="神经连续统参考声纹"
            size="sm"
            style="width: 100%"
            :options="speakerRefOptions"
          />
          <button
            type="button"
            class="btn sm"
            style="width: 100%"
            :disabled="!endpointsReady || !!axisError"
            @click="exportStimulusPackage"
          >
            <IconSvg name="file" :size="12" />
            <span>仅导出实验参数 JSON</span>
          </button>
        </div>
      </div>
    </aside>

    <SplitPane v-model="sidebarWidth" direction="vertical" :min="232" :max="520" :default-value="276" storage-key="research-continuum" />

    <section class="panel cont-main">
      <div class="p-head">
        <span class="cont-head-title">
          <template v-if="endpointsReady">
            {{ matrixCells.length }} 格生理连续统（<span class="cont-ep-lbl notranslate" translate="no">{{ endpointA.label }}</span> → <span class="cont-ep-lbl notranslate" translate="no">{{ endpointB.label }}</span>）
          </template>
          <template v-else>生理连续统 · 等待端点输入</template>
        </span>
        <div v-if="endpointsReady && selectedCell" class="cont-sel-info mono">
          <span class="tree-tag">
            {{
              recoveringEndpoints
                ? '正在重新分析端点…'
                : contoursSource === 'vtl-hd'
                  ? activeSpeaker + ' 真实声道轮廓'
                  : contoursSource === 'loading'
                    ? '轮廓加载中…'
                    : '声道轮廓未就绪'
            }}
          </span>
          <span v-if="measuredCell" class="metric-chip">{{ dualAxis ? `格 A${measuredCell.stepA}·B${measuredCell.stepB}` : `第 ${measuredCell.stepA} 格` }}</span>
          <span class="metric-chip" title="代表构型的 VTL 传递函数峰">F1 {{ measuredCell?.metrics?.f1_hz || '—' }} · F2 {{ measuredCell?.metrics?.f2_hz || '—' }} Hz</span>
          <span class="metric-chip">Amin {{ measuredCell?.metrics?.amin_cm2.toFixed(2) ?? '—' }} cm²</span>
          <button type="button" class="btn xs primary" :disabled="controlsBusy" @click="auditionCell(selectedCell)">
            <IconSvg name="play" :size="11" />
            <span>试听当前格</span>
          </button>
        </div>
      </div>

      <div v-if="endpointsReady && selectedCell" class="cont-actions" data-tour="continuum-actions">
        <div class="cont-action-group" role="group" aria-label="序列操作">
          <button type="button" class="btn xs primary" :disabled="controlsBusy && !playingSequence" @click="renderSequence('play')">
            <IconSvg :name="playingSequence ? 'stop' : 'play'" :size="11" />
            <span>{{ playingSequence ? '停止序列' : '试听序列' }}</span>
          </button>
          <button type="button" class="btn xs" :disabled="controlsBusy" @click="renderSequence('synth')">
            <IconSvg name="cpu" :size="12" />
            <span>合成全部</span>
          </button>
          <button type="button" class="btn xs" :disabled="controlsBusy" title="打包全部 WAV、CSV 表与 JSON 清单为 ZIP" @click="renderSequence('zip')">
            <IconSvg name="download" :size="12" />
            <span>导出刺激包 ZIP</span>
          </button>
          <button type="button" class="btn xs" :disabled="controlsBusy" title="将全部格子拼接为一条连续音频下载" @click="renderSequence('download-seq')">
            <IconSvg name="waveform" :size="12" />
            <span>下载序列音频</span>
          </button>
        </div>

        <div class="cont-action-group" role="group" aria-label="当前格操作">
          <button type="button" class="btn xs" :disabled="controlsBusy" @click="cellAction(selectedCell, 'annotation')">
            <IconSvg name="send" :size="11" />
            <span>送到标注</span>
          </button>
          <button type="button" class="btn xs" :disabled="controlsBusy" @click="cellAction(selectedCell, 'studio')">
            <IconSvg name="stage" :size="12" />
            <span>送到剪辑</span>
          </button>
          <button type="button" class="btn xs" :disabled="controlsBusy" @click="cellAction(selectedCell, 'wav')">
            <IconSvg name="music" :size="12" />
            <span>下载单格 WAV</span>
          </button>
          <button type="button" class="btn xs" :disabled="controlsBusy" @click="cellAction(selectedCell, 'video')">
            <IconSvg name="video" :size="12" />
            <span>下载声道视频</span>
          </button>
        </div>

        <div class="cont-action-group cont-view-tools" role="group" aria-label="视口与视图控制">
          <button type="button" class="btn xs" aria-label="缩小格子声道" @click="view.zoomBy(1 / 1.15)">
            <IconSvg name="minus" :size="11" />
          </button>
          <span class="cont-zoom-pct mono muted">{{ Math.round(view.zoom.value * 100) }}%</span>
          <button type="button" class="btn xs" aria-label="放大格子声道" @click="view.zoomBy(1.15)">
            <IconSvg name="plus" :size="11" />
          </button>
          <button type="button" class="btn xs" title="复位所有格子的缩放和平移" @click="view.reset()">复位</button>
          <button
            type="button"
            class="btn xs"
            :class="{ active: showInspector }"
            title="展开或收起下方声学与构音联合分析区"
            @click="showInspector = !showInspector"
          >
            <IconSvg name="layers" :size="11" />
            <span>{{ showInspector ? '收起分析' : '联合分析' }}</span>
          </button>
        </div>

        <div v-if="rendering" class="cont-progress" role="status">
          <span class="mono">正在处理 {{ rendering }}</span>
          <button type="button" class="btn xs danger" @click="cancelBatch">
            <IconSvg name="close" :size="11" />
            <span>取消</span>
          </button>
        </div>
      </div>

      <div v-if="sameEndpointTrack" class="cont-banner muted">两端的声道轨迹相同，混合轴上的中间格将保持一致。</div>
      <div v-if="contoursError && endpointsReady" class="cont-banner" role="status">
        <span>{{ contoursError }}</span>
        <button type="button" class="btn xs" @click="scheduleBatchContoursFetch">重试轮廓</button>
      </div>

      <div class="p-body cont-matrix-body" data-tour="continuum-grid">
        <div v-if="!endpointsReady" class="cont-empty-state">
          <IconSvg name="sliders" :size="28" />
          <strong>尚未就绪：请先提供两端输入</strong>
          <p class="muted">
            <span v-if="!endpointReadyA">端点 A 当前设为「{{ sourceOptions.find((o) => o.value === srcA)?.label }}」，尚未载入数据。</span>
            <span v-if="!endpointReadyB">端点 B 当前设为「{{ sourceOptions.find((o) => o.value === srcB)?.label }}」，尚未载入数据。</span>
          </p>
          <div class="cont-empty-actions">
            <button v-if="!endpointReadyA" type="button" class="btn sm primary" @click="audioInputs.A?.click()">
              <IconSvg name="upload" :size="12" />导入端点 A 音频
            </button>
            <button v-if="!endpointReadyA" type="button" class="btn sm" :disabled="Boolean(recordingSide)" @click="toggleEndpointRecord('A')">
              <IconSvg name="mic" :size="12" />录制端点 A
            </button>
            <button v-if="!endpointReadyB" type="button" class="btn sm primary" @click="audioInputs.B?.click()">
              <IconSvg name="upload" :size="12" />导入端点 B 音频
            </button>
            <button v-if="!endpointReadyB" type="button" class="btn sm" :disabled="Boolean(recordingSide)" @click="toggleEndpointRecord('B')">
              <IconSvg name="mic" :size="12" />录制端点 B
            </button>
            <button
              type="button"
              class="btn sm"
              @click="
                if (!endpointReadyA) srcA = 'preset';
                if (!endpointReadyB) srcB = 'preset';
              "
            >
              改用预设实验端点
            </button>
          </div>
        </div>

        <template v-else>
          <div
            class="cont-grid"
            :class="{ 'single-axis': !dualAxis, 'with-inspector': showInspector && !dualAxis }"
            :style="{ '--continuum-cols': dualAxis ? columns : Math.min(5, columns), '--continuum-rows': rows }"
          >
            <div
              v-for="cell in matrixCells"
              :key="cell.key"
              role="button"
              tabindex="0"
              class="cont-cell sci-plane"
              :class="{
                active: selectedCellKey === cell.key,
                playing: activePlaybackKey === cell.key,
                cached: cachedKeys.has(cell.key),
              }"
              :title="dualAxis ? `单击选中 · 双击试听第 ${cell.stepA} 列 · 第 ${cell.stepB} 行` : `单击选中 · 双击试听第 ${cell.stepA} 格`"
              @click="!view.consumeDragClick() && selectCell(cell.key)"
              @dblclick="!controlsBusy && auditionCell(cell)"
              @keydown.enter.prevent="!controlsBusy && auditionCell(cell)"
            >
              <div class="cc-top mono">
                <span class="cc-step-wrap">
                  <span v-if="cachedKeys.has(cell.key)" class="cc-cached-dot" title="已合成缓存，可即时播放" />
                  <span>{{ dualAxis ? `${cell.stepA} · ${cell.stepB}` : cell.stepA }}</span>
                </span>
                <span class="cc-top-right">
                  <span class="cc-dim2">{{ cell.axisBadge }}</span>
                  <button
                    type="button"
                    class="btn xs icon-only cc-play-trigger"
                    :disabled="controlsBusy"
                    :aria-label="`试听第 ${cell.stepA} 格`"
                    title="试听此格"
                    @click.stop="auditionCell(cell)"
                  >
                    <IconSvg name="play" :size="10" />
                  </button>
                </span>
              </div>

              <svg
                v-if="cell.hasRealHd || activePlaybackKey === cell.key"
                :ref="(el) => registerCellSvgRef(cell.key, el)"
                class="cc-tract-svg"
                :viewBox="view.viewBox.value"
                :class="{ dragging: view.dragging.value }"
                @wheel.prevent="view.wheel"
                @pointerdown="view.pointerDown"
                @pointermove="view.pointerMove"
                @pointerup="view.pointerEnd"
                @pointercancel="view.pointerEnd"
                preserveAspectRatio="xMidYMid meet"
                aria-hidden="true"
              />
              <div v-else class="cc-placeholder">{{ contoursSource === 'loading' ? '正在载入声道轮廓' : '声道几何未就绪' }}</div>

              <div class="cc-foot mono muted">
                <template v-if="cell.secondaryMetric">
                  <span class="cc-sec-metric">{{ cell.secondaryMetric }}</span>
                </template>
                <template v-else>
                  <span>F1 {{ cell.metrics?.f1_hz || '—' }}</span>
                  <span>F2 {{ cell.metrics?.f2_hz || '—' }}</span>
                </template>
              </div>
            </div>
          </div>

          <ContinuumInspectorPanel
            v-if="showInspector && selectedCell"
            data-tour="continuum-inspector"
            :cells="matrixCells"
            :selected-cell="selectedCell"
            :contours-by-key="realContoursByKey"
            :endpoint-a-params="endpointA.params"
            :endpoint-b-params="endpointB.params"
            :endpoint-a-label="endpointA.label"
            :endpoint-b-label="endpointB.label"
            :endpoint-a-contour="endpointAContour"
            :endpoint-b-contour="endpointBContour"
            :dual-axis="dualAxis"
            :view-box="view.viewBox.value"
            :view-box-obj="view.viewBoxObj.value"
            :ghost-mode="ghostMode"
            :active-playback-frame="activePlaybackFrame"
            :active-playback-key="activePlaybackKey"
            :theme-stamp="themeStamp"
            @update:ghost-mode="(m) => (ghostMode = m)"
            @select-cell="selectCell"
            @audition-selected="selectedCell && !controlsBusy && auditionCell(selectedCell)"
          />
        </template>
      </div>
    </section>

    <Teleport to="body">
      <AudioRecordPrepModal
        :open="Boolean(prepDraft)"
        :title="prepDraft ? `端点 ${prepDraft.side} 录音编辑与对齐` : '端点录音编辑'"
        hint="推荐录制单个音节以获得更干净的连续统插值，也支持保留多音节短语；可先去首尾静音、裁剪或降噪，并填写原文自动对齐音素。"
        :initial-file="prepDraft?.file ?? null"
        :initial-original-file="prepDraft?.originalFile ?? null"
        :initial-label="prepDraft?.label ?? ''"
        :initial-text="prepDraft?.text ?? ''"
        :initial-lang="prepDraft?.lang ?? 'auto'"
        :initial-grid="prepDraft?.grid ?? null"
        :device="store.computeDevice.value"
        show-label-field
        show-alignment
        recommend-single-syllable
        allow-re-record
        :confirm-label="prepDraft ? `应用到端点 ${prepDraft.side}` : '确认使用'"
        @close="prepDraft = null"
        @confirm="confirmEndpointPrep"
      />
    </Teleport>
  </div>
</template>

<style scoped>
.cont-head-right {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.axis-endpoints {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr)) auto;
  align-items: end;
  gap: 6px;
  font-size: 0.916667rem;
}

.axis-endpoints.no-unit {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.axis-endpoints label,
.axis-phonation label {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.axis-endpoints input {
  width: 100%;
}

.axis-phonation {
  display: grid;
  gap: 6px;
  font-size: 0.916667rem;
}

.continuum-axis {
  display: grid;
  gap: 5px;
}

.cont-note {
  margin: 0;
  font-size: 0.916667rem;
  line-height: 1.5;
  color: var(--muted);
}

.cont-warn {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.45;
  color: var(--warn);
}

.cont-missing-hint {
  font-size: 0.833333rem;
  line-height: 1.4;
  color: var(--warn);
}

.cont-shell {
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: var(--pad-shell);
  display: grid;
  grid-template-columns: var(--continuum-sidebar) 6px minmax(0, 1fr);
  gap: var(--gap-layout);
  overflow: hidden;
}

.cont-left,
.cont-main {
  min-width: 0;
  min-height: 0;
}

.cont-left-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  scrollbar-gutter: stable;
}

.cont-endpoints-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.cont-swap-row {
  display: flex;
  justify-content: center;
}

.cont-endpoint,
.cont-config-section {
  flex: none;
  display: grid;
  gap: 7px;
  min-width: 0;
}

.cont-endpoint {
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--panel) 80%, var(--app));
}

.cont-endpoint-head,
.cont-section-head,
.cont-endpoint-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cont-endpoint-head,
.cont-section-head {
  justify-content: space-between;
  flex-wrap: wrap;
}

.cont-endpoint-head .ipa,
.cont-endpoint-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cont-endpoint-head .ipa {
  max-width: 62%;
}

.cont-endpoint-name {
  font-size: 0.916667rem;
  color: var(--muted);
}

.cont-endpoint-actions {
  flex-wrap: wrap;
}

.cont-config-section {
  padding: 9px 0 0;
  border-top: 1px solid var(--border);
}

.cont-lock-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px 10px;
  font-size: 0.916667rem;
}

.cont-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.cont-check input {
  margin: 0;
}

.cont-step-field {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.cont-step-field input {
  width: 5em;
}

.cont-head-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cont-ep-lbl {
  font-family: "PTBIPAPlus", "PTB-Doulos", "Doulos SIL", var(--font-ui);
}

.cont-sel-info {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  flex: none;
}

.cont-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  flex-wrap: wrap;
  border-bottom: 1px solid color-mix(in srgb, var(--panel-border) 70%, transparent);
}

.cont-action-group {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.cont-action-group + .cont-action-group {
  padding-left: 8px;
  border-left: 1px solid var(--border);
}

.cont-zoom-pct {
  min-width: 3.2em;
  text-align: center;
  font-size: 0.833333rem;
}

.cont-progress {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  font-size: 0.875rem;
}

.cont-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  font-size: 0.875rem;
  border-bottom: 1px solid var(--border);
}

.cont-matrix-body {
  padding: 8px;
  display: flex;
  flex-direction: column;
}

.cont-empty-state {
  margin: auto;
  max-width: 440px;
  padding: 24px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 10px;
  border: 1px dashed var(--border);
  border-radius: var(--r-panel);
  background: color-mix(in srgb, var(--panel) 78%, var(--app));
}

.cont-empty-state p {
  margin: 0;
  line-height: 1.5;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cont-empty-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
}

.cont-grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(var(--continuum-cols), minmax(124px, 1fr));
  grid-template-rows: repeat(var(--continuum-rows), minmax(112px, 1fr));
  gap: 7px;
}

.cont-grid.single-axis {
  flex: none;
  grid-template-rows: none;
  grid-auto-rows: clamp(200px, 24vw, 340px);
}

.cont-grid.single-axis.with-inspector {
  grid-auto-rows: clamp(180px, 20vw, 270px);
}

.cont-cell {
  border: 1px solid var(--panel-border);
  padding: 4px 6px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  cursor: pointer;
  text-align: left;
  overflow: hidden;
  transition: border-color var(--dur-fast) var(--ease-out-expo), box-shadow var(--dur-fast) var(--ease-out-expo), transform var(--dur-fast) var(--ease-out-expo);
}

.cont-cell:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}

.cont-cell.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--selection);
}

.cont-cell.playing {
  border-color: var(--success);
  box-shadow: 0 0 0 2px var(--success);
}

.cc-top,
.cc-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  font-size: 0.791667rem;
  flex: none;
}

.cc-top {
  font-weight: 700;
  color: var(--text);
}

.cc-step-wrap,
.cc-top-right {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.cc-cached-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--r-pill);
  background: var(--success);
  flex: none;
}

.cc-dim2 {
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cc-play-trigger {
  opacity: 0.55;
  padding: 1px 3px;
  min-width: 18px;
  height: 18px;
}

.cont-cell:hover .cc-play-trigger,
.cont-cell.active .cc-play-trigger {
  opacity: 1;
}

.cc-sec-metric {
  color: var(--teal);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cc-tract-svg {
  flex: 1;
  width: 100%;
  min-height: 64px;
  display: block;
  border-radius: var(--r-ctrl);
  touch-action: none;
  cursor: grab;
}

.cc-tract-svg.dragging {
  cursor: grabbing;
}

.cc-placeholder {
  margin: auto;
  color: var(--muted);
  font-size: 0.916667rem;
}

@container desktop (max-width: 1360px) {
  .cont-shell {
    grid-template-columns: min(var(--continuum-sidebar), 248px) 6px minmax(0, 1fr);
  }
}

@container desktop (max-width: 1180px) {
  .cont-shell {
    grid-template-columns: 236px minmax(0, 1fr);
  }
  .cont-shell > :deep(.gutter-v),
  .cont-shell > :deep(.split-handle) {
    display: none;
  }
}

@media (max-width: 1180px) {
  .cont-shell {
    grid-template-columns: 236px minmax(0, 1fr);
  }
  .cont-shell > :deep(.gutter-v),
  .cont-shell > :deep(.split-handle) {
    display: none;
  }
}
</style>
