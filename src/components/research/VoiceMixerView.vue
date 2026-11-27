<script lang="ts">
import { ref as persistedRef, shallowRef as persistedShallowRef } from 'vue';
import type { TextGridDocument } from '@vocalcut/core';
import type { MorphKnot } from '@/vendor/m27-voice-morph/curve-editor.js';
import type {
  DiplophoniaMode,
  MixerAudio,
  MixerDevice,
  MixerMeta,
  MixerRender,
  MixerSynth,
} from './voice-mixer';

type Mode = 'preset' | 'dual';
type InputId = 'preset' | 'a' | 'b';
type AlignMode = 'dtw' | 'transcript' | 'textgrid';
type BgMode = 'waveform' | 'spectrogram';
type MixerOutputEntry = {
  url: string;
  blob: Blob;
  baselineBlob: Blob | null;
  baselineUrl: string | null;
  result: MixerRender;
};

const defaultFull = (): MorphKnot[] => [{ t: 0, v: 1 }, { t: 1, v: 1 }];
const zeroCurve = (): MorphKnot[] => [{ t: 0, v: 0 }, { t: 1, v: 0 }];

// Module-scoped session state so switching away from 发声调音台 and back preserves all audio, curves, alignments & renders.
const persistedMode = persistedRef<Mode>('preset');
const persistedMeta = persistedShallowRef<MixerMeta>();
const persistedRailWidth = persistedRef(384);
const persistedAudio = persistedShallowRef<Record<InputId, MixerAudio | null>>({ preset: null, a: null, b: null });
const persistedPresetTranscript = persistedRef('');
const persistedDualTranscript = persistedRef('');
const persistedDualTranscriptB = persistedRef('');
const persistedPresetGrid = persistedShallowRef<TextGridDocument | null>(null);
const persistedGrids = persistedShallowRef<Partial<Record<'a' | 'b', { name: string; grid: TextGridDocument }>>>({});
const persistedGridPasteOpen = persistedRef(false);
const persistedGridPasteText = persistedRef<Record<'a' | 'b', string>>({ a: '', b: '' });
const persistedAlign = persistedRef<AlignMode>('dtw');
const persistedCurveAlignTierIdx = persistedRef(0);
const persistedPresetId = persistedRef('breathy');
const persistedEnabled = persistedRef<string[]>(['glottis']);
const persistedDrawing = persistedRef('glottis');
const persistedDeltaGroups = persistedRef<string[]>(['tongue_jaw', 'larynx']);
const persistedCurves = persistedRef<Record<string, MorphKnot[]>>({
  preset: defaultFull(),
  glottis: defaultFull(),
  f0_pr: zeroCurve(),
  timing: zeroCurve(),
  tract_all: zeroCurve(),
  lips: zeroCurve(),
  velum: zeroCurve(),
  larynx: zeroCurve(),
  tongue_jaw: zeroCurve(),
  speaker: zeroCurve(),
});
const persistedSettings = persistedRef({
  preset: {
    interpolation: 'smoothstep' as 'smoothstep' | 'linear',
    smoothMs: 25,
    gate: true,
    f0: false,
    creakIrregularity: 30,
    diplophoniaMode: 'parallel' as DiplophoniaMode,
    diplophoniaRatio: 0.73,
  },
  dual: { interpolation: 'smoothstep' as 'smoothstep' | 'linear', smoothMs: 25, gate: true, f0: false },
});
const persistedShift = persistedRef<string>('');
const persistedBgMode = persistedRef<BgMode>('waveform');
const persistedSynth = persistedRef<MixerSynth>('neural');
const persistedDevice = persistedRef<MixerDevice>('cpu');
const persistedStatusNote = persistedRef('');
const persistedOutputs = persistedShallowRef<Partial<Record<Mode, MixerOutputEntry>>>({});
const persistedRawOrigins = persistedShallowRef<Partial<Record<InputId, Blob>>>({});
const persistedTransferredBaselines = persistedShallowRef<Partial<Record<InputId, Blob>>>({});
const persistedLocalBaselineCache = new Map<string, Blob>();
const persistedCompareExpanded = persistedRef(false);
const persistedAbActiveSlot = persistedRef<'orig' | 'recon' | 'out'>('out');
const persistedDualActiveSlot = persistedRef<'a' | 'b' | 'out'>('out');
let persistedF0SyncedOnce = false;
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, watchEffect } from 'vue';
import { publishPanelSnapshot } from '@/data/panel-snapshots';
import { SAMPLE_RATE_HZ } from '@vocalcut/core';
import CompactSlider from '@/components/common/CompactSlider.vue';
import CustomSelect from '@/components/common/CustomSelect.vue';
import IconSvg from '@/components/common/IconSvg.vue';
import ModuleGuideButton from '@/components/guide/ModuleGuideButton.vue';
import SplitPane from '@/components/common/SplitPane.vue';
import { clipFromTextGrid, readTextGridFile } from '@/data/textgrid-alignment';
import { synthesisGainMode, voiceRenderLabels, type VoiceRenderMode } from '@/data/voice-renderer';
import { sendWorkspaceAudio, takeWorkspaceAudio, type AudioDestination } from '@/data/workspace-transfer';
import { useWorkbenchStore } from '@/stores/workbench';
import { fetchOnboardingAudioFile, ONBOARDING_AUDIO_SLOTS } from '@/data/onboarding-samples';
import { M27CurveEditor } from '@/vendor/m27-voice-morph/curve-editor.js';
import MixerAlignPanel from './MixerAlignPanel.vue';
import MixerAudioInput from './MixerAudioInput.vue';
import MixerAudioPlayer from './MixerAudioPlayer.vue';
import MixerIntervalCompare from './MixerIntervalCompare.vue';
import MixerPrepModal, { type PrepSaveSlotResult, type PrepSlotId } from './MixerPrepModal.vue';
import MixerPresetHoverCard, { type HoverAnchorRect } from './MixerPresetHoverCard.vue';
import { buildSegmentPlateauKnots, countAnnotatedSegments, extractIntervalTiers } from './mixer-prep-utils';
import { MixerSpectrogramCache } from './mixer-spectrogram';
import {
  DIPLOPHONIA_MODE_OPTIONS,
  TIMING_PROSODY_GROUP,
  curveSparklinePath,
  formatSemitoneShift,
  getDisabledMixerPresetNotice,
  isCreakyMixerPreset,
  isCurveEngaged,
  isDiplophoniaMixerPreset,
  isMixerPresetDisabled,
  isMixerPresetExperimental,
  mixerAnchors,
  mixerDeviceLabel,
  mixerRequest,
  normalizeMixerPreset,
  parsePresetTitle,
  parseTextGridContent,
  type MixerGroup,
  type MixerPreset,
} from './voice-mixer';

const store = useWorkbenchStore();
const controller = new AbortController();
const spectrogramCache = new MixerSpectrogramCache();

const mode = persistedMode;
const meta = persistedMeta;
const metaBusy = ref(false);
const metaError = ref('');

const railWidth = persistedRailWidth;
const audio = persistedAudio;
const inputBusy = ref<Record<InputId, boolean>>({ preset: false, a: false, b: false });
const alignBusy = ref(false);
const presetInputRef = ref<InstanceType<typeof MixerAudioInput> | null>(null);
const dualAInputRef = ref<InstanceType<typeof MixerAudioInput> | null>(null);
const dualBInputRef = ref<InstanceType<typeof MixerAudioInput> | null>(null);

// Alignment, TextGrid & Prep Modal state
const presetTranscript = persistedPresetTranscript;
const dualTranscript = persistedDualTranscript;
const dualTranscriptB = persistedDualTranscriptB;
const presetGrid = persistedPresetGrid;
const grids = persistedGrids;
const gridInputs: Partial<Record<'a' | 'b', HTMLInputElement>> = {};
const gridPasteOpen = persistedGridPasteOpen;
const gridPasteText = persistedGridPasteText;
const gridBusy = ref(false);
const gridError = ref('');
const align = persistedAlign;
const prepOpen = ref(false);
const prepTarget = ref<PrepSlotId>('preset');
const curveAlignTierIdx = persistedCurveAlignTierIdx;

// Preset & Organ-Group state
const presetId = persistedPresetId;
const newLabel = ref('');
const deletingPresetId = ref('');
const enabled = persistedEnabled;
const drawing = persistedDrawing;
const deltaGroups = persistedDeltaGroups;

const curves = persistedCurves;

const settings = persistedSettings;
const setup = computed(() => settings.value[mode.value]);
const shift = persistedShift;
const shiftError = ref('');
const bgMode = persistedBgMode;
const spectrogramBusy = ref(false);
const currentSpectrogram = shallowRef<HTMLCanvasElement | null>(null);
let specSeq = 0;

// Default to Neural (Tract2Vox-Lite) on local ONNX CPU.
const synth = persistedSynth;
const device = persistedDevice;
const synthOptions = computed(() =>
  (meta.value?.synthesizers ?? []).map((item) => ({
    value: item.id,
    label: voiceRenderLabels[item.id as VoiceRenderMode] ?? item.label,
  })),
);

const working = ref<'render' | 'preset' | null>(null);
const error = ref('');
const statusNote = persistedStatusNote;
const outputs = persistedOutputs;
const output = computed(() => outputs.value[mode.value]);
const rawOrigins = persistedRawOrigins;
const transferredBaselines = persistedTransferredBaselines;
const localBaselineCache = persistedLocalBaselineCache;

// Curve editor & knot precision editing state
const canvas = ref<HTMLCanvasElement>();
const selected = ref(0);
const nodeTime = ref('0.00');
const nodeWeight = ref('0');
const nodeError = ref('');
const canUndoCurve = ref(false);
const canRedoCurve = ref(false);
const demoBusy = ref(false);
const compareExpanded = persistedCompareExpanded;
const compareDrawerRef = ref<HTMLElement | null>(null);
let editor: M27CurveEditor | undefined;

function toggleCompareExpanded() {
  compareExpanded.value = !compareExpanded.value;
  if (compareExpanded.value) {
    void nextTick(() => {
      compareDrawerRef.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }
}

// Comparison audio player refs for synchronized A/B/Baseline audition
const cmpOrigRef = ref<InstanceType<typeof MixerAudioPlayer> | null>(null);
const cmpReconPresetRef = ref<InstanceType<typeof MixerAudioPlayer> | null>(null);
const cmpOutPresetRef = ref<InstanceType<typeof MixerAudioPlayer> | null>(null);
const cmpARef = ref<InstanceType<typeof MixerAudioPlayer> | null>(null);
const cmpBRef = ref<InstanceType<typeof MixerAudioPlayer> | null>(null);
const cmpOutDualRef = ref<InstanceType<typeof MixerAudioPlayer> | null>(null);
const abActiveSlot = persistedAbActiveSlot;
const dualActiveSlot = persistedDualActiveSlot;

const interpolationOptions = [
  { value: 'smoothstep', label: '平滑过渡 (Smoothstep)' },
  { value: 'linear', label: '线性折线 (Linear)' },
];
const alignOptions = [
  { value: 'dtw', label: '自动构音特征 DTW 对齐（免标注）' },
  { value: 'transcript', label: '按原文对齐（Vox2Align-Lite v2）' },
  { value: 'textgrid', label: 'TextGrid 边界锚点对齐（MFA / Praat）' },
];
const presetShapes = [
  { id: 'ramp_up', label: '渐强 0→100%' },
  { id: 'ramp_down', label: '渐弱 100→0%' },
  { id: 'arch', label: '中段凸起' },
  { id: 'tail', label: '句尾过渡' },
  { id: 'const100', label: '全段 100%' },
  { id: 'zero', label: '归零' },
];
const dualShapes = [
  { id: 'ramp_up', label: '渐进变身 A→B' },
  { id: 'ramp_down', label: '渐进回退 B→A' },
  { id: 'const100', label: '全局 100%' },
  { id: 'arch', label: '中段替换' },
  { id: 'zero', label: '清零本轨' },
];

const activeShapes = computed(() => (mode.value === 'preset' ? presetShapes : dualShapes));
const allPresets = computed(() => (meta.value?.presets ?? []).map(normalizeMixerPreset));
const availablePresets = computed(() =>
  allPresets.value.filter((item) => !isMixerPresetDisabled(item) && !isMixerPresetExperimental(item)),
);
const experimentalPresets = computed(() =>
  allPresets.value.filter((item) => !isMixerPresetDisabled(item) && isMixerPresetExperimental(item)),
);
const disabledPresets = computed(() => allPresets.value.filter((item) => isMixerPresetDisabled(item)));
const preset = computed(() => allPresets.value.find((item) => item.id === presetId.value));
const isExperimentalSelected = computed(() => isMixerPresetExperimental(preset.value));
const f0Recommendation = computed(() => preset.value?.f0_target_hz
  ? `目标约 ${preset.value.f0_target_hz} Hz`
  : formatSemitoneShift(preset.value?.f0_shift_semitones ?? 0),
);
const f0ShiftPlaceholder = computed(() =>
  preset.value?.f0_target_hz
    ? `默认 ~${preset.value.f0_target_hz} Hz`
    : `默认 ${formatSemitoneShift(preset.value?.f0_shift_semitones ?? 0)}`,
);
const f0ControlHint = computed(() => {
  if (mode.value === 'dual') return '开启后随着声门或音色曲线把 A 的音域移向 B。';
  if (preset.value?.f0_target_hz) {
    if (preset.value.f0_target_hz < 100) {
      return `高权重带声段会自动压低至约 ${preset.value.f0_target_hz} Hz（男女声通用），幅度随曲线变化；手填半音偏移可覆盖自动值。`;
    }
    return `高权重带声段会自动抬升至至少 ${preset.value.f0_target_hz} Hz，若原声本就偏高（如女声 200–360 Hz）会自动按说话人音域继续上移；手填半音偏移可覆盖自动值。`;
  }
  return '开启后基频随调制权重变化，可手填半音偏移。';
});
const hoveredPreset = shallowRef<MixerPreset | null>(null);
const hoverAnchorRect = shallowRef<HoverAnchorRect | null>(null);
const customPresetCount = computed(() => allPresets.value.filter((item) => !item.builtin).length);
const dualGroups = computed<MixerGroup[]>(() => {
  const raw = meta.value?.groups ?? [];
  const normalized = raw.map((g) => {
    if (g.id === 'glottis') return { ...g, label: '声门发声类型 (8维)' };
    if (g.id === 'timing') return { ...TIMING_PROSODY_GROUP, ...g, is_timing: true, requires_alignment: true };
    return g;
  });
  if (normalized.length > 0 && !normalized.some((g) => g.id === 'timing')) {
    const f0Idx = normalized.findIndex((g) => g.id === 'f0_pr');
    const insertAt = f0Idx >= 0 ? f0Idx + 1 : 1;
    normalized.splice(insertAt, 0, TIMING_PROSODY_GROUP);
  }
  return normalized;
});
const baseSlot = computed(() => mode.value === 'preset' ? 'preset' : 'a');
const base = computed(() => audio.value[baseSlot.value]);
const source = computed(() => (mode.value === 'dual' ? audio.value.b : null));
const renderBaseline = computed(() => {
  const clipId = base.value?.analysis?.clip_id;
  return output.value?.baselineBlob ?? (clipId ? localBaselineCache.get(`${clipId}:${synth.value}:${synthesisGainMode.value}`) : undefined);
});
const comparisonBaseline = computed(() => renderBaseline.value ?? transferredBaselines.value[baseSlot.value] ?? null);
const baseDuration = computed(() => base.value?.analysis?.dur_sec ?? base.value?.duration ?? 3);
const activeCurve = computed(() => (mode.value === 'preset' ? 'preset' : drawing.value));
const nodes = computed(() => curves.value[activeCurve.value] ?? defaultFull());
const appliedCurve = computed(() => output.value?.result.applied_curves[activeCurve.value]);
const activeGroup = computed(() => dualGroups.value.find((group) => group.id === drawing.value));
const activeEnabled = computed(() =>
  enabled.value.filter((id) => (id !== 'speaker' || synth.value === 'neural') && isCurveEngaged(curves.value[id])),
);
const ghostCurves = computed(() => {
  if (mode.value !== 'dual') return [];
  return activeEnabled.value
    .filter((id) => id !== drawing.value)
    .map((id) => ({
      id,
      label: dualGroups.value.find((g) => g.id === id)?.label ?? id,
      knots: curves.value[id] ?? [],
    }));
});
const timingEnabled = computed(() => activeEnabled.value.includes('timing'));
const busyInput = computed(() =>
  mode.value === 'preset'
    ? inputBusy.value.preset || alignBusy.value
    : inputBusy.value.a || inputBusy.value.b || gridBusy.value || alignBusy.value,
);

const presetAnnotationCount = computed(() => countAnnotatedSegments(presetGrid.value));
const dualAAnnotationCount = computed(() => countAnnotatedSegments(grids.value.a?.grid));
const dualBAnnotationCount = computed(() => countAnnotatedSegments(grids.value.b?.grid));

const matchedAnchorCount = computed(() => {
  if (!audio.value.a || !audio.value.b || !grids.value.a || !grids.value.b) return 0;
  try {
    const durA = audio.value.a.analysis?.dur_sec ?? audio.value.a.duration;
    const durB = audio.value.b.analysis?.dur_sec ?? audio.value.b.duration;
    return mixerAnchors(grids.value.a.grid, grids.value.b.grid, durA, durB).length;
  } catch {
    return -1;
  }
});

const needsAlignedGrids = computed(() => align.value === 'textgrid' || align.value === 'transcript');
const dualBStatusBadge = computed(() => {
  if (!audio.value.b?.analysis) return { text: '待载入', tone: 'muted' as const };
  if (needsAlignedGrids.value || timingEnabled.value) {
    if (matchedAnchorCount.value > 0) return { text: `已对齐 · ${matchedAnchorCount.value} 锚点`, tone: 'good' as const };
    return { text: align.value === 'transcript' ? '待原文对齐' : '待标注对齐', tone: 'warn' as const };
  }
  return audio.value.a?.analysis ? { text: 'DTW 就绪', tone: 'good' as const } : { text: '待对齐', tone: 'warn' as const };
});

const activeAlignTiers = computed(() => extractIntervalTiers(mode.value === 'preset' ? presetGrid.value : grids.value.a?.grid));
const activeAlignIntervals = computed(() => {
  const tier = activeAlignTiers.value[curveAlignTierIdx.value] ?? activeAlignTiers.value[0];
  if (!tier) return [];
  return tier.intervals.map((iv) => ({ xmin: iv.xmin, xmax: iv.xmax, text: iv.text.trim() }));
});
const sculptableIntervals = computed(() => activeAlignIntervals.value.filter((iv) => iv.text.length > 0));

watch(activeAlignTiers, (tiers) => {
  if (!tiers.length || curveAlignTierIdx.value >= tiers.length) curveAlignTierIdx.value = 0;
});

function showPresetHover(item: MixerPreset | undefined, event: MouseEvent | FocusEvent) {
  if (!item) return;
  const target = event.currentTarget as HTMLElement | null;
  if (!target) return;
  const rect = target.getBoundingClientRect();
  hoveredPreset.value = item;
  hoverAnchorRect.value = { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
}

function clearPresetHover() {
  hoveredPreset.value = null;
  hoverAnchorRect.value = null;
}

function getFirstAvailablePresetId(presets: readonly MixerPreset[] = allPresets.value): string {
  return presets.find((item) => !isMixerPresetDisabled(item))?.id ?? presets[0]?.id ?? '';
}

function selectPreset(item: MixerPreset) {
  if (working.value || isMixerPresetDisabled(item)) return;
  presetId.value = item.id;
}

const canRender = computed(() =>
  Boolean(
    meta.value &&
      base.value?.analysis &&
      !working.value &&
      !busyInput.value &&
      !shiftError.value &&
      (mode.value === 'preset'
        ? preset.value && !isMixerPresetDisabled(preset.value)
        : source.value?.analysis &&
          activeEnabled.value.length > 0 &&
          (!timingEnabled.value || (grids.value.a && grids.value.b && matchedAnchorCount.value > 0)) &&
          (align.value === 'dtw' || (grids.value.a && grids.value.b && matchedAnchorCount.value > 0))),
  ),
);

const statusBanner = computed(() => {
  if (error.value) return { kind: 'err' as const, text: error.value };
  if (working.value === 'render') return { kind: 'warn' as const, text: '正在执行时变声道调制与合成…' };
  if (output.value) {
    const res = output.value.result;
    const parts = [res.label, mixerDeviceLabel(res.device_effective)];
    if (typeof res.synth_ms === 'number') parts.push(`${res.synth_ms.toFixed(0)} ms`);
    if (typeof res.out_dur_sec === 'number' && Math.abs(res.out_dur_sec - baseDuration.value) > 0.015) {
      parts.push(`输出 ${res.out_dur_sec.toFixed(2)} s`);
    }
    if (res.align_mode === 'dtw') parts.push('DTW 对齐');
    if (res.align_mode === 'textgrid') parts.push('边界锚点对齐');
    if (res.f0_target_hz) parts.push(`F0 目标约 ${res.f0_target_hz} Hz`);
    else parts.push(res.f0_shift_st ? `F0 联动 ${formatSemitoneShift(res.f0_shift_st)}` : 'F0 保持原样');
    return { kind: 'ok' as const, text: `合成完成：${parts.join(' · ')}` };
  }
  if (statusNote.value) return { kind: 'ok' as const, text: statusNote.value };
  if (mode.value === 'preset') {
    if (!audio.value.preset?.analysis) return { kind: 'warn' as const, text: '载入或录制原声后即可拖动曲线并实时合成。' };
    const a = audio.value.preset.analysis;
    return {
      kind: 'ok' as const,
      text: `已就绪：${audio.value.preset.name} · ${a.dur_sec.toFixed(2)} s (${a.n_frames} 帧)${typeof a.invert_ms === 'number' ? ` · 反演 ${a.invert_ms.toFixed(0)} ms` : ''}`,
    };
  }
  if (!audio.value.a?.analysis || !audio.value.b?.analysis) {
    return { kind: 'warn' as const, text: '请先加载说话人 A 与说话人 B 两段语音，再为目标器官组绘制混合曲线。' };
  }
  if (!activeEnabled.value.length) {
    return { kind: 'warn' as const, text: '请至少启用一条非零权重的器官或音色混合轨。' };
  }
  if (timingEnabled.value && (!grids.value.a || !grids.value.b || matchedAnchorCount.value <= 0)) {
    return { kind: 'warn' as const, text: '时长与韵律轨需说话人 A 与 B 完成匹配的文字或音节标注对齐，请点击「裁剪与标注」完成标注。' };
  }
  if (needsAlignedGrids.value && (!grids.value.a || !grids.value.b || matchedAnchorCount.value <= 0)) {
    return { kind: 'warn' as const, text: '当前选择了边界锚点对齐，请先在「裁剪与标注」弹窗中完成 A、B 标注匹配。' };
  }
  return {
    kind: 'ok' as const,
    text: `双人语音已就绪 · 已启用 ${activeEnabled.value.length} 条器官/韵律曲线`,
  };
});

async function loadMetadata() {
  metaBusy.value = true;
  metaError.value = '';
  try {
    const next = await mixerRequest<MixerMeta>(undefined, controller.signal);
    if (next.model_source !== 'project_bundle') throw new Error('请重启工作台引擎以加载项目内的模型包。');
    meta.value = next;
    device.value = 'cpu';
    if (!next.synthesizers.some((item) => item.id === synth.value)) {
      synth.value = next.synthesizers[0]?.id ?? 'physical';
    }
    let presetReset = false;
    if (!preset.value || isMixerPresetDisabled(preset.value)) {
      presetId.value = getFirstAvailablePresetId(next.presets.map(normalizeMixerPreset));
      presetReset = true;
    }
    if (!persistedF0SyncedOnce || presetReset) {
      syncPresetF0Coupling(presetId.value);
      persistedF0SyncedOnce = true;
    }
  } catch (cause) {
    if (!controller.signal.aborted) metaError.value = cause instanceof Error ? cause.message : '本地引擎未连接';
  } finally {
    metaBusy.value = false;
  }
}

const diplophoniaDefaultRatio = computed(() => {
  const opt = DIPLOPHONIA_MODE_OPTIONS.find((item) => item.id === settings.value.preset.diplophoniaMode);
  return opt?.defaultRatio ?? preset.value?.default_diplophonia_ratio ?? 0.73;
});

function selectDiplophoniaMode(nextMode: DiplophoniaMode) {
  if (working.value) return;
  settings.value.preset.diplophoniaMode = nextMode;
  const opt = DIPLOPHONIA_MODE_OPTIONS.find((item) => item.id === nextMode);
  if (opt) settings.value.preset.diplophoniaRatio = opt.defaultRatio;
  clearOutput('preset');
}

function syncPresetF0Coupling(nextId: string) {
  const item = allPresets.value.find((p) => p.id === nextId);
  if (!item) return;
  settings.value.preset.f0 = Boolean(item.default_f0_coupling);
  if (typeof item.default_creak_irregularity === 'number' && Number.isFinite(item.default_creak_irregularity)) {
    settings.value.preset.creakIrregularity = Math.round(
      Math.max(0, Math.min(1, item.default_creak_irregularity)) * 100,
    );
  } else if (isCreakyMixerPreset(item)) {
    settings.value.preset.creakIrregularity = 30;
  }
  if (isDiplophoniaMixerPreset(item)) {
    const validMode = DIPLOPHONIA_MODE_OPTIONS.some((m) => m.id === settings.value.preset.diplophoniaMode);
    if (!validMode) {
      settings.value.preset.diplophoniaMode = item.default_diplophonia_mode ?? 'parallel';
    }
    if (!Number.isFinite(settings.value.preset.diplophoniaRatio)) {
      settings.value.preset.diplophoniaRatio = item.default_diplophonia_ratio ?? 0.73;
    }
  }
  shift.value = '';
  shiftError.value = '';
}

watch(presetId, (nextId) => {
  syncPresetF0Coupling(nextId);
});

watch(
  () => store.engineStatus.value,
  (status) => {
    if (status === 'python-vtl' && !meta.value && !metaBusy.value) {
      void loadMetadata();
    }
  },
);

function setAudio(id: InputId, next: MixerAudio) {
  const previous = audio.value[id];
  if (previous?.url !== next.url && previous?.url) URL.revokeObjectURL(previous.url);
  if (previous?.url !== next.url) {
    if (id === 'preset') presetGrid.value = null;
    else grids.value = { ...grids.value, [id]: undefined };
    rawOrigins.value = { ...rawOrigins.value, [id]: next.file };
    transferredBaselines.value = { ...transferredBaselines.value, [id]: undefined };
  }
  audio.value = { ...audio.value, [id]: next };
  if (next.analysis && !meta.value && !metaBusy.value) {
    void loadMetadata();
  }
}

function swapSpeakers() {
  if (working.value || busyInput.value) return;
  const oldA = audio.value.a;
  const oldB = audio.value.b;
  if (!oldA && !oldB) return;
  pauseAllPlayers();
  audio.value = { ...audio.value, a: oldB, b: oldA };
  grids.value = { a: grids.value.b, b: grids.value.a };
  rawOrigins.value = { ...rawOrigins.value, a: rawOrigins.value.b, b: rawOrigins.value.a };
  transferredBaselines.value = {
    ...transferredBaselines.value,
    a: transferredBaselines.value.b,
    b: transferredBaselines.value.a,
  };
  const oldTA = dualTranscript.value;
  dualTranscript.value = dualTranscriptB.value;
  dualTranscriptB.value = oldTA;
  clearOutput('dual');
  statusNote.value = '已互换说话人 A 与说话人 B';
}

function openPrepModal(target: PrepSlotId) {
  if (working.value) return;
  prepTarget.value = target;
  prepOpen.value = true;
}

async function handlePrepSave(slots: Partial<Record<PrepSlotId, PrepSaveSlotResult>>) {
  prepOpen.value = false;
  const notes: string[] = [];
  let hadAnalyzeFailure = false;
  const applySlot = async (slotId: PrepSlotId, res: PrepSaveSlotResult | undefined) => {
    if (!res) return;
    if (slotId === 'preset') presetTranscript.value = res.transcript;
    else if (slotId === 'a') dualTranscript.value = res.transcript;
    else dualTranscriptB.value = res.transcript;

    const inputRef = slotId === 'preset' ? presetInputRef.value : slotId === 'a' ? dualAInputRef.value : dualBInputRef.value;
    if (res.audioChanged && res.file && inputRef) {
      const ok = await inputRef.loadExternalBlob(res.file, res.name);
      if (!ok) {
        hadAnalyzeFailure = true;
        return;
      }
      notes.push(`${slotId === 'preset' ? '原声' : `说话人 ${slotId.toUpperCase()}`}已应用裁剪`);
    }
    if (slotId === 'preset') {
      presetGrid.value = res.grid;
    } else {
      grids.value = {
        ...grids.value,
        [slotId]: res.grid ? { name: `标注精修 · ${slotId.toUpperCase()}`, grid: res.grid } : undefined,
      };
    }
    if (res.grid) {
      notes.push(`${slotId === 'preset' ? '原声' : `说话人 ${slotId.toUpperCase()}`}标注 ${countAnnotatedSegments(res.grid)} 段`);
    }
  };

  if (mode.value === 'preset') {
    await applySlot('preset', slots.preset);
  } else {
    await applySlot('a', slots.a);
    await applySlot('b', slots.b);
    if (grids.value.a && grids.value.b && matchedAnchorCount.value > 0) {
      if (align.value === 'dtw') align.value = 'textgrid';
      notes.push(`已匹配 ${matchedAnchorCount.value} 个对齐锚点`);
    }
  }
  if (hadAnalyzeFailure) {
    error.value = '裁剪后的音频重新反演失败，请检查本地引擎状态后重试。';
  } else if (notes.length) {
    statusNote.value = `裁剪与标注已保存：${notes.join(' · ')}`;
  }
}

function applySegmentSculpt(iv: { xmin: number; xmax: number; text: string }, event: MouseEvent) {
  if (working.value) return;
  const next = buildSegmentPlateauKnots(nodes.value, iv, baseDuration.value, {
    weight: 0.9,
    additive: event.shiftKey,
  });
  editor?.setKnots(next, false);
  statusNote.value = event.shiftKey
    ? `已叠加标注段「${iv.text}」局部塑形`
    : `已按标注段「${iv.text}」塑形当前曲线（Shift+单击可叠加多段）`;
}

async function setGridFile(id: 'a' | 'b', event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  gridError.value = '';
  gridBusy.value = true;
  try {
    const grid = await readTextGridFile(file);
    grids.value = { ...grids.value, [id]: { name: file.name, grid } };
  } catch (cause) {
    gridError.value = cause instanceof Error ? cause.message : 'TextGrid 读取失败';
  } finally {
    gridBusy.value = false;
  }
}

function applyPastedTextGrid(id: 'a' | 'b') {
  const raw = gridPasteText.value[id].trim();
  if (!raw) return;
  gridError.value = '';
  try {
    const grid = parseTextGridContent(raw);
    grids.value = { ...grids.value, [id]: { name: `粘贴的 TextGrid ${id.toUpperCase()}`, grid } };
  } catch (cause) {
    gridError.value = cause instanceof Error ? cause.message : 'TextGrid 文本解析失败';
  }
}

function onAlignedSingle(grid: TextGridDocument) {
  presetGrid.value = grid;
  statusNote.value = '已完成 Vox2Align-Lite v2 原文对齐，音素边界已标注在曲线画布顶部';
}

function onAlignedDual(payload: { a: TextGridDocument; b: TextGridDocument }) {
  grids.value = {
    a: { name: 'Vox2Align-Lite v2 · A', grid: payload.a },
    b: { name: 'Vox2Align-Lite v2 · B', grid: payload.b },
  };
  dualTranscriptB.value = dualTranscript.value;
  align.value = 'transcript';
  gridError.value = '';
  statusNote.value = '已完成双轨原文对齐，可直接按精确音素边界合成';
}

function clearOutput(target = mode.value) {
  const previous = outputs.value[target];
  if (previous) {
    URL.revokeObjectURL(previous.url);
    if (previous.baselineUrl) URL.revokeObjectURL(previous.baselineUrl);
    outputs.value = { ...outputs.value, [target]: undefined };
  }
  if (target === mode.value) error.value = '';
}

function validateShiftInput() {
  const raw = shift.value.trim();
  if (!raw) {
    shiftError.value = '';
    return;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < -12 || n > 12) {
    shiftError.value = '半音偏移须在 -12 至 +12 st 之间';
  } else {
    shiftError.value = '';
  }
}

watch(shift, validateShiftInput);
watch([() => audio.value.preset, presetId, shift, () => settings.value.preset], () => clearOutput('preset'), { deep: true });
watch([() => audio.value.a, () => audio.value.b, enabled, align, grids, deltaGroups, () => settings.value.dual], () => clearOutput('dual'), { deep: true });
watch([synth, synthesisGainMode], () => {
  clearOutput('preset');
  clearOutput('dual');
});
watch(mode, () => {
  clearPresetHover();
  error.value = '';
  statusNote.value = '';
  void nextTick(() => refreshPlot());
});
watch(synth, (value) => {
  if (value === 'physical' && drawing.value === 'speaker') drawing.value = 'glottis';
});

async function refreshSpectrogram() {
  const file = base.value?.file;
  if (bgMode.value !== 'spectrogram' || !file) {
    currentSpectrogram.value = null;
    spectrogramBusy.value = false;
    return;
  }
  const token = ++specSeq;
  spectrogramBusy.value = true;
  try {
    const isDark = store.resolvedColorMode.value === 'dark';
    const bitmap = await spectrogramCache.render(file, Math.max(480, canvas.value?.clientWidth || 720), isDark);
    if (token !== specSeq) return;
    currentSpectrogram.value = bitmap;
    refreshPlot();
  } catch {
    if (token === specSeq) currentSpectrogram.value = null;
  } finally {
    if (token === specSeq) spectrogramBusy.value = false;
  }
}

watch([() => base.value?.file, bgMode, () => store.resolvedColorMode.value], () => {
  void refreshSpectrogram();
});

function refreshPlot() {
  const analysis = base.value?.analysis;
  const gate =
    activeCurve.value === 'preset'
      ? preset.value?.is_voiceless_target
        ? analysis?.speech_gate
        : analysis?.voiced_gate
      : activeCurve.value === 'glottis'
        ? analysis?.voiced_gate
        : undefined;
  editor?.setVisualContext({
    durSec: baseDuration.value,
    waveformPeaks: analysis?.waveform_peaks ?? [],
    gateSeries: gate ?? [],
    appliedSeries: appliedCurve.value ?? [],
    frameCount: analysis?.n_frames,
    smoothMs: setup.value.smoothMs,
    enableGate: setup.value.gate && Boolean(gate?.length),
    interpMode: setup.value.interpolation === 'linear' ? 'linear' : 'smoothstep',
    bgMode: bgMode.value,
    spectrogramCanvas: currentSpectrogram.value,
    alignIntervals: activeAlignIntervals.value,
    ghostCurves: ghostCurves.value,
  });
}

function handlePlayhead(norm: number | null) {
  editor?.setPlayhead(norm);
}

function syncSelection(index: number, node: MorphKnot | null) {
  selected.value = index;
  if (!node) return;
  nodeTime.value = (node.t * baseDuration.value).toFixed(2);
  nodeWeight.value = String(Math.round(node.v * 100));
  nodeError.value = '';
}

function handleCurveChange(knots: MorphKnot[]) {
  const id = activeCurve.value;
  curves.value = { ...curves.value, [id]: knots };
  if (mode.value === 'dual') {
    const engaged = isCurveEngaged(knots);
    if (engaged && !enabled.value.includes(id)) {
      enabled.value = [...enabled.value, id];
    } else if (!engaged && enabled.value.includes(id)) {
      enabled.value = enabled.value.filter((item) => item !== id);
    }
  }
  clearOutput();
}

watch(
  canvas,
  (element) => {
    editor?.destroy();
    canUndoCurve.value = false;
    canRedoCurve.value = false;
    editor = element
      ? new M27CurveEditor(element, {
          onSelect: syncSelection,
          onChange: handleCurveChange,
          onHistoryChange: ({ canUndo, canRedo }) => {
            canUndoCurve.value = canUndo;
            canRedoCurve.value = canRedo;
          },
        })
      : undefined;
    editor?.setKnots(nodes.value, true);
    refreshPlot();
  },
  { flush: 'post' },
);

watch(activeCurve, () => {
  editor?.setKnots(nodes.value, true);
  editor?.selectKnot(0);
  refreshPlot();
});
watch(baseDuration, () => syncSelection(selected.value, nodes.value[selected.value] ?? null));
watch(
  [
    audio,
    setup,
    preset,
    activeCurve,
    output,
    bgMode,
    currentSpectrogram,
    activeAlignIntervals,
    ghostCurves,
    store.resolvedColorMode,
    store.surfaceStyle,
    store.paletteId,
    store.customAccentHex,
  ],
  refreshPlot,
  { deep: true, flush: 'post' },
);

function selectGroup(groupId: string) {
  if (working.value || (groupId === 'speaker' && synth.value === 'physical')) return;
  drawing.value = groupId;
}

function toggleGroupEnabled(groupId: string) {
  if (working.value || (groupId === 'speaker' && synth.value === 'physical')) return;
  const currentlyActive = enabled.value.includes(groupId) && isCurveEngaged(curves.value[groupId]);
  if (currentlyActive) {
    enabled.value = enabled.value.filter((item) => item !== groupId);
  } else {
    if (!isCurveEngaged(curves.value[groupId])) {
      const full: MorphKnot[] = defaultFull();
      curves.value = { ...curves.value, [groupId]: full };
      if (drawing.value === groupId) editor?.setKnots(full, true);
    }
    if (!enabled.value.includes(groupId)) enabled.value = [...enabled.value, groupId];
  }
  clearOutput('dual');
}

function isGroupEngaged(groupId: string): boolean {
  return enabled.value.includes(groupId) && isCurveEngaged(curves.value[groupId]) && (groupId !== 'speaker' || synth.value === 'neural');
}

function toggleDeltaGroup(groupId: string, checked: boolean) {
  if (checked && !deltaGroups.value.includes(groupId)) {
    deltaGroups.value = [...deltaGroups.value, groupId];
  } else if (!checked) {
    deltaGroups.value = deltaGroups.value.filter((item) => item !== groupId);
  }
}

function clearAllDualTracks() {
  if (working.value) return;
  const next: Record<string, MorphKnot[]> = { ...curves.value };
  for (const group of dualGroups.value) {
    next[group.id] = zeroCurve();
  }
  curves.value = next;
  enabled.value = [];
  editor?.setKnots(zeroCurve(), true);
  clearOutput('dual');
}

function applyKnotFields() {
  const seconds = Number(nodeTime.value);
  const percent = Number(nodeWeight.value);
  if (
    !nodeTime.value.trim() ||
    !nodeWeight.value.trim() ||
    !Number.isFinite(seconds) ||
    !Number.isFinite(percent) ||
    seconds < 0 ||
    seconds > baseDuration.value + 0.005 ||
    percent < 0 ||
    percent > 100
  ) {
    nodeError.value = `参数越界：时间须在 0–${baseDuration.value.toFixed(2)} s 内，权重须在 0–100% 内。`;
    return;
  }
  nodeError.value = '';
  editor?.updateSelectedKnot(Math.min(1, seconds / baseDuration.value), percent / 100);
}

function addManualKnot() {
  const dur = Math.max(0.05, baseDuration.value);
  const ks = nodes.value;
  const sel = selected.value;
  let tNorm = 0.5;
  let vNorm = 0.5;
  if (ks.length >= 2) {
    const neighbor = sel < ks.length - 1 ? sel + 1 : sel - 1;
    tNorm = 0.5 * (ks[sel].t + ks[neighbor].t);
    vNorm = 0.5 * (ks[sel].v + ks[neighbor].v);
  }
  const typedT = Number(nodeTime.value);
  const typedV = Number(nodeWeight.value);
  if (Number.isFinite(typedT) && Number.isFinite(typedV)) {
    if (typedT < 0 || typedT > dur + 0.005 || typedV < 0 || typedV > 100) {
      nodeError.value = `参数越界：时间须在 0–${dur.toFixed(2)} s 内，权重须在 0–100% 内。`;
      return;
    }
    const ratio = typedT / dur;
    const tooClose = ks.some((k) => Math.abs(k.t - ratio) < 0.012);
    if (!tooClose && ratio > 0.004 && ratio < 0.996) {
      tNorm = ratio;
      vNorm = typedV / 100;
    }
  }
  nodeError.value = '';
  if (!editor?.addKnotAt(tNorm, vNorm)) {
    nodeError.value = '曲线最多支持 50 个控制点。';
  }
}

async function extractPreset() {
  if (!audio.value.preset?.analysis || !newLabel.value.trim() || !meta.value || working.value || busyInput.value) return;
  working.value = 'preset';
  error.value = '';
  try {
    const result = await mixerRequest<{ preset: MixerPreset }>(
      {
        action: 'extract_preset',
        clip_id: audio.value.preset.analysis.clip_id,
        label: newLabel.value.trim(),
      },
      controller.signal,
    );
    meta.value = { ...meta.value, presets: [...meta.value.presets, result.preset] };
    presetId.value = result.preset.id;
    newLabel.value = '';
    statusNote.value = `已保存自定义发声类型预设：${result.preset.label}`;
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '保存预设失败';
  } finally {
    working.value = null;
  }
}

async function removeCustomPreset(id: string) {
  if (!meta.value || working.value || deletingPresetId.value) return;
  deletingPresetId.value = id;
  error.value = '';
  try {
    await mixerRequest<{ deleted_id: string }>({ action: 'delete_preset', preset_id: id }, controller.signal);
    const nextPresets = meta.value.presets.filter((item) => item.id !== id);
    meta.value = { ...meta.value, presets: nextPresets };
    if (presetId.value === id) presetId.value = getFirstAvailablePresetId(nextPresets.map(normalizeMixerPreset));
    statusNote.value = '已删除自定义发声类型预设';
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '删除预设失败';
  } finally {
    deletingPresetId.value = '';
  }
}

async function render() {
  if (!canRender.value || !base.value?.analysis) return;
  validateShiftInput();
  if (shiftError.value) return;
  clearOutput();
  working.value = 'render';
  try {
    const target = mode.value;
    const options = {
      clip_id: base.value.analysis.clip_id,
      interp_mode: setup.value.interpolation,
      smooth_ms: setup.value.smoothMs,
      voicing_gate: setup.value.gate,
      f0_coupling: setup.value.f0,
      synth: synth.value,
      device: device.value,
      audio_gain: synthesisGainMode.value,
      include_baseline: true,
    };
    const effectiveShift =
      shift.value.trim() !== ''
        ? Number(shift.value)
        : setup.value.f0 && preset.value?.default_f0_coupling && !preset.value.f0_target_hz
          ? preset.value.f0_shift_semitones
          : null;
    const useDualAnchors = Boolean(
      (needsAlignedGrids.value || timingEnabled.value) && grids.value.a && grids.value.b && matchedAnchorCount.value > 0,
    );
    const payload =
      mode.value === 'preset'
        ? {
            action: 'render_preset',
            preset_id: presetId.value,
            knots: nodes.value,
            f0_shift_semitones: effectiveShift,
            creak_irregularity: Number((settings.value.preset.creakIrregularity / 100).toFixed(2)),
            ...(isDiplophoniaMixerPreset(preset.value)
              ? {
                  diplophonia_mode: settings.value.preset.diplophoniaMode,
                  diplophonia_ratio: Number(settings.value.preset.diplophoniaRatio.toFixed(2)),
                }
              : {}),
          }
        : {
            action: 'render_dual',
            source_id: source.value?.analysis?.clip_id,
            anchors: useDualAnchors
              ? mixerAnchors(
                  grids.value.a!.grid,
                  grids.value.b!.grid,
                  base.value.analysis.dur_sec,
                  source.value!.analysis!.dur_sec,
                )
              : [],
            curves: Object.fromEntries(activeEnabled.value.map((id) => [id, curves.value[id] ?? defaultFull()])),
            delta_groups: deltaGroups.value.filter(
              (id) => id !== 'speaker' && id !== 'timing' && activeEnabled.value.includes(id),
            ),
          };
    const result = await mixerRequest<MixerRender>({ ...options, ...payload }, controller.signal);
    if (controller.signal.aborted || options.audio_gain !== synthesisGainMode.value) return;
    const pcm = Uint8Array.from(atob(result.audio_base64), (character) => character.charCodeAt(0));
    const blob = new Blob([pcm], { type: 'audio/wav' });
    const cacheKey = `${options.clip_id}:${options.synth}:${options.audio_gain}`;
    let baselineBlob: Blob | null = localBaselineCache.get(cacheKey) ?? null;
    if (result.baseline_audio_base64) {
      const basePcm = Uint8Array.from(atob(result.baseline_audio_base64), (c) => c.charCodeAt(0));
      baselineBlob = new Blob([basePcm], { type: 'audio/wav' });
      localBaselineCache.set(cacheKey, baselineBlob);
    } else if (!baselineBlob) {
      try {
        const fallbackPresetId = getFirstAvailablePresetId() || 'modal';
        const fbRes = await mixerRequest<MixerRender>(
          {
            clip_id: options.clip_id,
            action: 'render_preset',
            preset_id: fallbackPresetId,
            knots: [
              { t: 0, v: 0 },
              { t: 1, v: 0 },
            ],
            interp_mode: 'linear',
            smooth_ms: 0,
            voicing_gate: false,
            f0_coupling: false,
            synth: options.synth,
            device: options.device,
            audio_gain: options.audio_gain,
          },
          controller.signal,
        );
        if (!controller.signal.aborted && fbRes.audio_base64) {
          const fbPcm = Uint8Array.from(atob(fbRes.audio_base64), (c) => c.charCodeAt(0));
          baselineBlob = new Blob([fbPcm], { type: 'audio/wav' });
          localBaselineCache.set(cacheKey, baselineBlob);
        }
      } catch {
        // Transferred baseline or raw audio comparison remains available
      }
    }
    const baselineUrl = baselineBlob ? URL.createObjectURL(baselineBlob) : null;
    outputs.value = {
      ...outputs.value,
      [target]: { url: URL.createObjectURL(blob), blob, baselineBlob, baselineUrl, result },
    };
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '生成音频失败';
  } finally {
    working.value = null;
  }
}

type MixerPlayerKey = 'orig' | 'recon' | 'out' | 'a' | 'b' | 'dualOut' | 'inputA' | 'inputB';

function getPlayerEntries(): Array<{ key: MixerPlayerKey; pause: () => void }> {
  return [
    { key: 'orig', pause: () => cmpOrigRef.value?.pause() },
    { key: 'recon', pause: () => cmpReconPresetRef.value?.pause() },
    { key: 'out', pause: () => cmpOutPresetRef.value?.pause() },
    { key: 'a', pause: () => cmpARef.value?.pause() },
    { key: 'b', pause: () => cmpBRef.value?.pause() },
    { key: 'dualOut', pause: () => cmpOutDualRef.value?.pause() },
    { key: 'inputA', pause: () => dualAInputRef.value?.pausePlayer() },
    { key: 'inputB', pause: () => dualBInputRef.value?.pausePlayer() },
  ];
}

function pauseAllPlayers(except?: MixerPlayerKey) {
  for (const item of getPlayerEntries()) {
    if (item.key !== except) item.pause();
  }
}

function handlePlayerPlaying(key: MixerPlayerKey, active: boolean) {
  if (!active) return;
  pauseAllPlayers(key);
  if (key === 'orig' || key === 'recon' || key === 'out') {
    abActiveSlot.value = key;
  } else if (key === 'a' || key === 'b') {
    dualActiveSlot.value = key;
  } else if (key === 'dualOut') {
    dualActiveSlot.value = 'out';
  }
}

function toggleComparePresetAB() {
  const players = [
    { key: 'orig' as const, ref: cmpOrigRef.value, ok: Boolean(audio.value.preset?.url) },
    { key: 'recon' as const, ref: cmpReconPresetRef.value, ok: Boolean(output.value?.baselineUrl) },
    { key: 'out' as const, ref: cmpOutPresetRef.value, ok: Boolean(output.value?.url) },
  ].filter((p) => p.ok && p.ref);
  if (players.length < 2) return;
  const activeIdx = players.findIndex((p) => p.ref!.isPlaying());
  const nextIdx = activeIdx >= 0 ? (activeIdx + 1) % players.length : players.length - 1;
  const t = activeIdx >= 0 ? players[activeIdx].ref!.getTime() : 0;
  pauseAllPlayers();
  abActiveSlot.value = players[nextIdx].key;
  void players[nextIdx].ref!.playAt(t);
}

function cycleCompareDual() {
  const players = [
    { key: 'a' as const, ref: cmpARef.value, ok: Boolean(audio.value.a?.url) },
    { key: 'b' as const, ref: cmpBRef.value, ok: Boolean(audio.value.b?.url) },
    { key: 'out' as const, ref: cmpOutDualRef.value, ok: Boolean(output.value?.url) },
  ].filter((p) => p.ok && p.ref);
  if (!players.length) return;
  const activeIdx = players.findIndex((p) => p.ref!.isPlaying());
  const nextIdx = activeIdx >= 0 ? (activeIdx + 1) % players.length : players.length - 1;
  const t = activeIdx >= 0 ? players[activeIdx].ref!.getTime() : 0;
  pauseAllPlayers();
  dualActiveSlot.value = players[nextIdx].key;
  void players[nextIdx].ref!.playAt(t);
}

async function loadDemoSample(target: 'preset' | 'a' | 'b') {
  if (demoBusy.value || working.value || busyInput.value) return;
  demoBusy.value = true;
  try {
    const slot = target === 'b' ? ONBOARDING_AUDIO_SLOTS.zh_spk_b : ONBOARDING_AUDIO_SLOTS.zh_spk_a;
    const res = await fetchOnboardingAudioFile(slot.relativeUrl, slot.filename, controller.signal);
    if (controller.signal.aborted) return;
    if (!res.ok) {
      store.pushToast(
        res.reason === 'missing'
          ? `未找到内置示例音频（public/${slot.relativeUrl}），可直接拖入或上传本地 WAV/FLAC`
          : '载入示例音频失败，可直接拖入或上传本地 WAV/FLAC',
        'info',
        3200,
      );
      return;
    }
    const inputRef = target === 'preset' ? presetInputRef.value : target === 'a' ? dualAInputRef.value : dualBInputRef.value;
    const ok = await inputRef?.loadExternalBlob(res.file, slot.label);
    if (!ok) return;
    if (slot.transcript.trim()) {
      if (target === 'preset') presetTranscript.value = slot.transcript;
      else if (target === 'a') dualTranscript.value = slot.transcript;
      else dualTranscriptB.value = slot.transcript;
    }
    statusNote.value = `已载入示例音频：${slot.label}`;
  } finally {
    demoBusy.value = false;
  }
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function handleWindowKeydown(ev: KeyboardEvent) {
  if (store.researchTab.value !== 'mixer' || prepOpen.value || isEditableElement(ev.target)) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.code === 'Space' && !(ev.target instanceof HTMLButtonElement)) {
    const candidates =
      mode.value === 'preset'
        ? [cmpOutPresetRef.value, cmpReconPresetRef.value, cmpOrigRef.value]
        : [cmpOutDualRef.value, cmpARef.value, cmpBRef.value];
    const playingRef = candidates.find((p) => p?.isPlaying());
    if (playingRef) {
      ev.preventDefault();
      playingRef.pause();
      return;
    }
    const preferred =
      mode.value === 'preset'
        ? (abActiveSlot.value === 'orig' ? cmpOrigRef.value : abActiveSlot.value === 'recon' ? cmpReconPresetRef.value : cmpOutPresetRef.value) ??
          cmpOutPresetRef.value ??
          cmpOrigRef.value
        : (dualActiveSlot.value === 'a' ? cmpARef.value : dualActiveSlot.value === 'b' ? cmpBRef.value : cmpOutDualRef.value) ??
          cmpOutDualRef.value ??
          cmpARef.value;
    if (preferred && ((mode.value === 'preset' && (output.value?.url || audio.value.preset?.url)) || (mode.value === 'dual' && (output.value?.url || audio.value.a?.url || audio.value.b?.url)))) {
      ev.preventDefault();
      void preferred.playAt(0);
    }
  } else if (ev.key.toLowerCase() === 'b') {
    if (mode.value === 'preset' && audio.value.preset?.url && output.value?.url) {
      ev.preventDefault();
      toggleComparePresetAB();
    } else if (mode.value === 'dual' && output.value?.url && (audio.value.a?.url || audio.value.b?.url)) {
      ev.preventDefault();
      cycleCompareDual();
    }
  }
}

const handoffBlob = computed(() => output.value?.blob ?? base.value?.file ?? null);
const handoffSourceName = computed(() => {
  const baseName = (base.value?.name ?? '发声调音台音频').replace(/\.[^.]+$/, '');
  if (output.value) {
    return mode.value === 'preset'
      ? `${baseName} · ${parsePresetTitle(preset.value?.label ?? '发声类型调制').zh}.wav`
      : `${baseName} · 双人器官混合.wav`;
  }
  return base.value?.name ?? '发声调音台音频.wav';
});

function sendToWorkspace(target: AudioDestination) {
  const blob = handoffBlob.value;
  if (!blob) return;
  const name = handoffSourceName.value;
  const file = new File([blob], name.endsWith('.wav') ? name : `${name}.wav`, { type: blob.type || 'audio/wav' });
  const grid = mode.value === 'preset' ? presetGrid.value : grids.value.a?.grid ?? null;
  const durSmp = Math.max(1, Math.ceil(Math.max(baseDuration.value, grid?.xmax ?? 0, 0.04) * SAMPLE_RATE_HZ));
  const clip = grid ? clipFromTextGrid(grid, durSmp, store.activeClipId.value, store.activeVoiceId.value) : undefined;
  const transcript = (mode.value === 'preset' ? presetTranscript.value : dualTranscript.value).trim() || undefined;
  sendWorkspaceAudio(target, {
    file,
    label: name.replace(/\.wav$/i, ''),
    textGrid: grid ?? undefined,
    clip,
    alignmentText: transcript,
    sourceKind: 'audio-reconstruct',
  });
}

function consumeIncomingMixerAudio() {
  const incoming = takeWorkspaceAudio('mixer');
  if (!incoming?.file) return;
  const label = incoming.label || incoming.file.name || '来自工作区.wav';
  const targetSlot: InputId = mode.value === 'preset' ? 'preset' : 'a';
  if (mode.value === 'preset') {
    if (incoming.alignmentText) presetTranscript.value = incoming.alignmentText;
    void presetInputRef.value?.loadExternalBlob(incoming.file, label).then(() => {
      if (incoming.rawSourceFile) rawOrigins.value = { ...rawOrigins.value, [targetSlot]: incoming.rawSourceFile };
      if (incoming.reconstructedFile) transferredBaselines.value = { ...transferredBaselines.value, [targetSlot]: incoming.reconstructedFile };
      if (incoming.textGrid) presetGrid.value = incoming.textGrid;
    });
  } else {
    if (incoming.alignmentText) dualTranscript.value = incoming.alignmentText;
    void dualAInputRef.value?.loadExternalBlob(incoming.file, label).then(() => {
      if (incoming.rawSourceFile) rawOrigins.value = { ...rawOrigins.value, [targetSlot]: incoming.rawSourceFile };
      if (incoming.reconstructedFile) transferredBaselines.value = { ...transferredBaselines.value, [targetSlot]: incoming.reconstructedFile };
      if (incoming.textGrid) {
        grids.value = { ...grids.value, a: { name: '来自工作区 · A', grid: incoming.textGrid } };
      }
    });
  }
  statusNote.value = `已从工作区接收音频：${label}`;
}

watch(
  () => store.researchTab.value,
  (tab) => {
    if (tab === 'mixer') consumeIncomingMixerAudio();
  },
);

onMounted(() => {
  void loadMetadata();
  consumeIncomingMixerAudio();
  syncSelection(0, nodes.value[0] ?? null);
  if (bgMode.value === 'spectrogram' && base.value?.file) {
    void refreshSpectrogram();
  }
  window.addEventListener('vocalcut:tour-action', handleMixerTourAction);
  window.addEventListener('keydown', handleWindowKeydown);
});

let mixerTourAbort: AbortController | null = null;
async function handleMixerTourAction(e: Event): Promise<void> {
  const detail = (e as CustomEvent<{ actionId?: string; done?: (ok?: boolean) => void }>).detail;
  if (detail?.actionId !== 'mixer-load-demo') return;
  mixerTourAbort?.abort();
  mixerTourAbort = new AbortController();
  const signal = mixerTourAbort.signal;

  if (mode.value === 'preset') {
    const slot = ONBOARDING_AUDIO_SLOTS.zh_spk_a;
    const res = await fetchOnboardingAudioFile(slot.relativeUrl, slot.filename, signal);
    if (signal.aborted) return;
    if (!res.ok) {
      if (res.reason === 'missing') {
        store.pushToast(
          `尚未放置试用音频（public/${slot.relativeUrl}），可直接点击下方上传音频或现场录音`,
          'info',
          3600,
        );
      } else {
        store.pushToast('载入案例音频失败，可直接上传 WAV/FLAC 或现场录音', 'warning', 2800);
      }
      detail?.done?.(false);
      return;
    }
    await presetInputRef.value?.loadExternalBlob(res.file, slot.label);
    if (slot.transcript.trim()) presetTranscript.value = slot.transcript;
    store.pushToast(`已载入「${slot.label}」到发声调音台`, 'success', 2600);
    detail?.done?.(true);
    return;
  }

  const slotA = ONBOARDING_AUDIO_SLOTS.zh_spk_a;
  const slotB = ONBOARDING_AUDIO_SLOTS.zh_spk_b;
  const [resA, resB] = await Promise.all([
    fetchOnboardingAudioFile(slotA.relativeUrl, slotA.filename, signal),
    fetchOnboardingAudioFile(slotB.relativeUrl, slotB.filename, signal),
  ]);
  if (signal.aborted) return;
  if (!resA.ok && !resB.ok) {
    store.pushToast(
      `尚未放置双人对比音频（public/${slotA.relativeUrl} 与 ${slotB.filename}），可点击上传音频或现场录音体验`,
      'info',
      3800,
    );
    detail?.done?.(false);
    return;
  }
  if (resA.ok) {
    await dualAInputRef.value?.loadExternalBlob(resA.file, slotA.label);
    if (slotA.transcript.trim()) dualTranscript.value = slotA.transcript;
  }
  if (resB.ok) {
    await dualBInputRef.value?.loadExternalBlob(resB.file, slotB.label);
    if (slotB.transcript.trim()) dualTranscriptB.value = slotB.transcript;
  }
  store.pushToast('已载入双人案例音频，可开启器官混合通道并拖动强度曲线', 'success', 2800);
  detail?.done?.(true);
}

watchEffect(() => {
  const m = mode.value;
  const activePreset = preset.value;
  const srcAudio = m === 'preset' ? audio.value.preset : audio.value.a;
  const outEntry = outputs.value[m];
  const curveCopy: Record<string, Array<{ t: number; v: number }>> = {};
  for (const [k, knots] of Object.entries(curves.value)) {
    curveCopy[k] = knots.map((pt) => ({ t: pt.t, v: pt.v }));
  }
  publishPanelSnapshot('mixer', {
    mode: m,
    presetId: presetId.value,
    presetLabel: activePreset?.label ?? presetId.value,
    presetDesc: activePreset?.desc ?? '',
    source9Phys: activePreset?.source9_phys_pa ? [...activePreset.source9_phys_pa] : undefined,
    f0ShiftSt:
      outEntry?.result.f0_shift_st ??
      (setup.value.f0 ? (Number(shift.value) || activePreset?.f0_shift_semitones || 0) : 0),
    interpolation: setup.value.interpolation,
    curves: curveCopy,
    enabledGroups: [...enabled.value],
    inputName: srcAudio?.name,
    inputDuration_s: srcAudio?.duration ?? outEntry?.result.out_dur_sec ?? 0,
    inputBlob: srcAudio?.file ?? null,
    waveformPeaks: srcAudio?.analysis?.waveform_peaks,
    gateSeries: srcAudio?.analysis?.voiced_gate,
    alignIntervals: activeAlignIntervals.value.length ? activeAlignIntervals.value.slice(0, 64) : undefined,
    outputBlob: outEntry?.blob ?? null,
    outputDuration_s: outEntry?.result.out_dur_sec,
    appliedCurves: outEntry?.result.applied_curves,
  });
});

onBeforeUnmount(() => {
  pauseAllPlayers();
  window.removeEventListener('vocalcut:tour-action', handleMixerTourAction);
  window.removeEventListener('keydown', handleWindowKeydown);
  mixerTourAbort?.abort();
  mixerTourAbort = null;
  controller.abort();
  spectrogramCache.destroy();
  editor?.destroy();
  // Keep persisted audio & output Blob URLs alive across tab switches; they are revoked when replaced/cleared.
});
</script>

<template>
  <div class="mx-shell">
    <div v-if="metaError" class="panel mx-offline-banner" role="status">
      <div class="mx-offline-text">
        <span class="dot-err" aria-hidden="true" />
        <span>发声调音台暂未连接本地引擎：{{ metaError }}</span>
      </div>
      <button type="button" class="btn sm" :disabled="metaBusy" @click="loadMetadata">
        <IconSvg name="refresh" :size="12" />
        <span>重新连接</span>
      </button>
    </div>

    <!-- MAIN 2-COLUMN WORKSTATION BODY (Aligned flush to top, matching VocalCut Studio) -->
    <div class="mx-workspace" :style="{ '--mx-rail-w': `${railWidth}px` }">
      <!-- LEFT CONTROL RAIL -->
      <aside class="mx-rail">
        <!-- Compact Mode + Device + Model Control Card -->
        <section class="panel mx-card mx-ctrl-card" data-tour="mixer-mode" aria-label="发声调音台模式与推理配置">
          <div class="seg control-seg sm mx-modes" role="tablist" aria-label="调音模式">
            <button
              type="button"
              role="tab"
              :class="{ active: mode === 'preset' }"
              :aria-selected="mode === 'preset'"
              :disabled="!!working || busyInput"
              @click="mode = 'preset'"
            >
              发声类型调制
            </button>
            <button
              type="button"
              role="tab"
              :class="{ active: mode === 'dual' }"
              :aria-selected="mode === 'dual'"
              :disabled="!!working || busyInput"
              @click="mode = 'dual'"
            >
              双人器官混合
            </button>
          </div>

          <div class="mx-engine-grid">
            <CustomSelect
              :model-value="synth"
              aria-label="合成模型"
              placeholder="合成模型"
              size="sm"
              :disabled="!!working || !meta"
              :options="synthOptions"
              @update:model-value="synth = $event as MixerSynth"
            />
          </div>
        </section>
        <!-- MODE 1 LEFT RAIL: Audio Input + Optional Text Alignment + Target Phonation Presets -->
        <template v-if="mode === 'preset'">
          <section class="panel mx-card" data-tour="mixer-input">
            <header class="p-head">
              <span>1 · 加载或录制原声</span>
              <span class="tree-tag">免对齐</span>
            </header>
            <div class="p-body mx-stack">
              <MixerAudioInput
                ref="presetInputRef"
                label=""
                :audio="audio.preset"
                :device="device"
                :disabled="!!working || alignBusy"
                :show-prep-button="true"
                :annotation-count="presetAnnotationCount"
                :hide-player="true"
                :show-demo-button="true"
                :demo-busy="demoBusy"
                @change="setAudio('preset', $event)"
                @busy="inputBusy.preset = $event"
                @playhead="handlePlayhead"
                @open-prep="openPrepModal('preset')"
                @load-demo="loadDemoSample('preset')"
              />

              <details class="adv-box mx-align-details">
                <summary>
                  <span>自动识别文本与原文对齐（可选）</span>
                  <span v-if="presetGrid" class="tree-tag">已对齐 {{ sculptableIntervals.length }} 段</span>
                </summary>
                <div class="mx-align-details-body">
                  <MixerAlignPanel
                    v-model="presetTranscript"
                    mode="preset"
                    :primary-audio="audio.preset"
                    :device="device"
                    :disabled="!!working || inputBusy.preset"
                    @aligned-single="onAlignedSingle"
                    @busy="alignBusy = $event"
                  />
                </div>
              </details>
            </div>
          </section>

          <section class="panel mx-card mx-grow" data-tour="mixer-presets">
            <header class="p-head">
              <span>2 · 选择目标发声类型预设</span>
              <span class="muted mono mx-head-meta">
                {{ customPresetCount ? `含 ${customPresetCount} 自定义 · 悬停看曲线` : '悬停查看 VoQS 曲线' }}
              </span>
            </header>
            <div class="p-body mx-preset-body">
              <template v-if="meta">
                <div class="mx-preset-grid" role="radiogroup" aria-label="目标发声类型预设">
                  <div
                    v-for="item in availablePresets"
                    :key="item.id"
                    class="mx-preset-card"
                    :class="{
                      active: item.id === presetId,
                      disabled: !!working,
                    }"
                    role="radio"
                    tabindex="0"
                    :aria-checked="item.id === presetId"
                    :aria-disabled="!!working"
                    @click="selectPreset(item)"
                    @mouseenter="showPresetHover(item, $event)"
                    @mouseleave="clearPresetHover"
                    @focus="showPresetHover(item, $event)"
                    @blur="clearPresetHover"
                    @keydown.enter.prevent="selectPreset(item)"
                    @keydown.space.prevent="selectPreset(item)"
                  >
                    <div class="mx-preset-top">
                      <div class="mx-preset-names">
                        <strong>{{ parsePresetTitle(item.label).zh }}</strong>
                        <span v-if="parsePresetTitle(item.label).en" class="mx-preset-en">
                          {{ parsePresetTitle(item.label).en }}
                        </span>
                      </div>
                      <div class="mx-preset-badges">
                        <span
                          class="mx-f0-tag mono"
                          :class="{
                            custom: !item.builtin,
                            'auto-f0': item.default_f0_coupling,
                            exp: Boolean(item.larynx_hy_delta_cm || isDiplophoniaMixerPreset(item)),
                          }"
                          :title="
                            isDiplophoniaMixerPreset(item)
                              ? '同声道双声源叠加，可在曲线下方切换耦合机制并调节频率比 f₂/f₁'
                              : item.larynx_hy_delta_cm
                                ? '随调制曲线同步施加喉位高度偏移'
                                : item.default_f0_coupling
                                  ? '切换到该预设时自动开启基频联动'
                                  : '可选 F0 联动参考偏移'
                          "
                        >
                          {{
                            !item.builtin
                              ? '自定义'
                              : isDiplophoniaMixerPreset(item)
                                ? `双频 ${(item.id === presetId ? settings.preset.diplophoniaRatio : (item.default_diplophonia_ratio ?? 0.73)).toFixed(2)}×`
                                : item.larynx_hy_delta_cm
                                  ? `HY ${item.larynx_hy_delta_cm > 0 ? '+' : ''}${item.larynx_hy_delta_cm.toFixed(1)}`
                                  : item.f0_target_hz
                                    ? `约 ${item.f0_target_hz} Hz`
                                    : item.default_f0_coupling
                                      ? `${formatSemitoneShift(item.f0_shift_semitones)} ${item.f0_shift_semitones < 0 ? '降调' : '升调'}`
                                      : formatSemitoneShift(item.f0_shift_semitones)
                          }}
                        </span>
                        <button
                          v-if="!item.builtin"
                          type="button"
                          class="mx-preset-del"
                          title="删除自定义发声类型预设"
                          aria-label="删除自定义预设"
                          :disabled="!!working || deletingPresetId === item.id"
                          @click.stop="removeCustomPreset(item.id)"
                        >
                          <IconSvg name="close" :size="10" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <details
                  v-if="experimentalPresets.length || disabledPresets.length"
                  class="mx-unavailable-group"
                  :open="isExperimentalSelected"
                >
                  <summary>
                    <span>
                      实验调校中（{{ experimentalPresets.length }} 项灰度试听{{ disabledPresets.length ? ` · ${disabledPresets.length} 项锁定` : '' }}）
                    </span>
                    <span v-if="isExperimentalSelected" class="tree-tag">当前已选</span>
                  </summary>
                  <div v-if="experimentalPresets.length" class="mx-exp-grid" role="radiogroup" aria-label="实验调校中发声类型预设">
                    <div
                      v-for="item in experimentalPresets"
                      :key="item.id"
                      class="mx-preset-card mx-exp-card"
                      :class="{
                        active: item.id === presetId,
                        disabled: !!working,
                      }"
                      role="radio"
                      tabindex="0"
                      :aria-checked="item.id === presetId"
                      :aria-disabled="!!working"
                      @click="selectPreset(item)"
                      @mouseenter="showPresetHover(item, $event)"
                      @mouseleave="clearPresetHover"
                      @focus="showPresetHover(item, $event)"
                      @blur="clearPresetHover"
                      @keydown.enter.prevent="selectPreset(item)"
                      @keydown.space.prevent="selectPreset(item)"
                    >
                      <div class="mx-preset-top">
                        <div class="mx-preset-names">
                          <strong>{{ parsePresetTitle(item.label).zh }}</strong>
                          <span v-if="parsePresetTitle(item.label).en" class="mx-preset-en">
                            {{ parsePresetTitle(item.label).en }}
                          </span>
                        </div>
                        <span
                          class="mx-f0-tag mono"
                          :class="{
                            'auto-f0': item.default_f0_coupling,
                            exp: !item.default_f0_coupling,
                          }"
                          :title="
                            item.default_f0_coupling
                              ? '切换到该预设时自动开启基频联动'
                              : item.larynx_hy_delta_cm
                                ? '随调制曲线同步施加喉位高度偏移'
                                : '可选 F0 联动参考偏移'
                          "
                        >
                          {{
                            item.larynx_hy_delta_cm
                              ? `HY ${item.larynx_hy_delta_cm > 0 ? '+' : ''}${item.larynx_hy_delta_cm.toFixed(1)}`
                              : item.f0_target_hz
                                ? `约 ${item.f0_target_hz} Hz`
                                : formatSemitoneShift(item.f0_shift_semitones)
                          }}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div v-if="disabledPresets.length" class="mx-unavailable-list">
                    <div
                      v-for="item in disabledPresets"
                      :key="item.id"
                      class="mx-unavailable-chip"
                      tabindex="0"
                      aria-disabled="true"
                      @mouseenter="showPresetHover(item, $event)"
                      @mouseleave="clearPresetHover"
                      @focus="showPresetHover(item, $event)"
                      @blur="clearPresetHover"
                    >
                      <span>{{ parsePresetTitle(item.label).zh }}</span>
                      <span class="mx-f0-tag unavailable mono">{{ getDisabledMixerPresetNotice(item)?.badge }}</span>
                    </div>
                  </div>
                </details>
              </template>
              <div v-else class="mx-stack">
                <p class="muted">连接本地引擎后即可载入内置及自定义发声类型预设。</p>
                <button type="button" class="btn sm" :disabled="metaBusy" @click="loadMetadata">
                  <IconSvg name="refresh" :size="12" />
                  <span>{{ metaBusy ? '正在载入预设…' : '重新载入预设' }}</span>
                </button>
              </div>

              <form class="mx-extract-box" @submit.prevent="extractPreset">
                <div class="mx-extract-head">
                  <label
                    class="mx-extract-label"
                    for="mx-custom-preset"
                    title="录一段自己的特殊发声（如气声、紧声或方言嗓音），提取其中间 40% 稳态帧的声门特征存成预设；之后换其他录音时点击该预设即可把这段嗓音套用过去"
                  >
                    <span>复刻当前录音为新预设</span>
                    <IconSvg name="info" :size="12" />
                  </label>
                  <span class="mx-extract-hint mono">取中间 40% 稳态帧</span>
                </div>
                <div class="mx-extract-row">
                  <input
                    id="mx-custom-preset"
                    v-model="newLabel"
                    class="inp"
                    maxlength="40"
                    placeholder="起个名称，如「我的气声」套用到别的录音"
                    title="提取当前录音有效语音段中间 40% 稳态帧的 9 维声门参数中位数，保存为可复用的个人发声预设"
                    :disabled="!!working"
                  />
                  <button
                    type="submit"
                    class="btn sm"
                    :disabled="!audio.preset?.analysis || !newLabel.trim() || !meta || !!working || busyInput"
                  >
                    {{ working === 'preset' ? '保存中…' : '存为预设' }}
                  </button>
                </div>
              </form>
            </div>
          </section>
        </template>

        <!-- MODE 2 LEFT RAIL: Organ / Timing / Speaker Groups + Time Alignment -->
        <template v-else>
          <section class="panel mx-card mx-grow" data-tour="mixer-dual-groups">
            <header class="p-head">
              <span>器官 / 维度混合轨</span>
              <span class="mx-head-meta">
                <i class="mx-dot-legend" aria-hidden="true" />已启用 {{ activeEnabled.length }}/{{ dualGroups.length || 9 }}
              </span>
            </header>
            <div class="p-body mx-group-list">
              <div
                v-for="group in dualGroups"
                :key="group.id"
                class="mx-group-card"
                :class="{
                  active: drawing === group.id,
                  engaged: isGroupEngaged(group.id),
                  disabled: !!working || (group.id === 'speaker' && synth === 'physical'),
                }"
                role="button"
                tabindex="0"
                :aria-pressed="drawing === group.id"
                @click="selectGroup(group.id)"
                @keydown.enter.prevent="selectGroup(group.id)"
              >
                <div class="mx-group-top">
                  <div class="mx-group-title-wrap">
                    <strong>{{ group.label }}</strong>
                    <span
                      v-if="group.requires_alignment"
                      class="mx-req-chip"
                      :class="{ ready: matchedAnchorCount > 0 }"
                    >
                      {{ matchedAnchorCount > 0 ? `已对齐 ${matchedAnchorCount} 锚点` : '需双轨标注' }}
                    </span>
                    <span
                      v-else-if="!group.is_speaker && deltaGroups.includes(group.id)"
                      class="mx-delta-chip"
                    >
                      相对偏移
                    </span>
                  </div>
                  <div class="mx-group-right">
                    <svg class="mx-spark" viewBox="0 0 44 14" aria-hidden="true">
                      <path
                        :d="curveSparklinePath(curves[group.id], setup.interpolation)"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.6"
                        stroke-linecap="round"
                      />
                    </svg>
                    <button
                      type="button"
                      role="switch"
                      class="mx-track-switch"
                      :class="{ on: isGroupEngaged(group.id) }"
                      :aria-checked="isGroupEngaged(group.id)"
                      :title="isGroupEngaged(group.id) ? '已启用混合曲线（点击停用）' : '点击启用该混合轨'"
                      :aria-label="`${isGroupEngaged(group.id) ? '停用' : '启用'}${group.label}`"
                      :disabled="!!working || (group.id === 'speaker' && synth === 'physical')"
                      @click.stop="toggleGroupEnabled(group.id)"
                    >
                      <span class="mx-track-thumb" aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <p class="mx-group-desc">
                  {{
                    group.id === 'speaker' && synth === 'physical'
                      ? '需切换合成模型为 Tract2Vox-Lite 才可进行句内音色过渡。'
                      : group.coupling_note || group.desc
                  }}
                </p>
              </div>
            </div>
          </section>

          <section class="panel mx-card">
            <header class="p-head">
              <span>时间对齐方式</span>
              <span class="tree-tag">
                {{ align === 'dtw' ? '免标注 DTW' : align === 'transcript' ? 'Vox2Align-Lite v2' : 'TextGrid 锚点' }}
              </span>
            </header>
            <div class="p-body mx-stack">
              <button
                type="button"
                class="btn sm mx-prep-launch-btn"
                :disabled="!!working || (!audio.a && !audio.b)"
                @click="openPrepModal(audio.a ? 'a' : 'b')"
              >
                <IconSvg name="scissors" :size="12" />
                <span>打开可视化裁剪与双轨标注对齐弹窗</span>
              </button>

              <CustomSelect
                v-model="align"
                aria-label="时间对齐方式"
                size="sm"
                :options="alignOptions"
                :disabled="!!working || gridBusy || alignBusy"
              />

              <p v-if="align === 'dtw'" class="mx-help">
                DTW 在 17 维声道构音 + 肺压上计算单调弯曲路径，将说话人 B 的轨迹平滑重采样到 A 的时间网格。
              </p>

              <template v-else-if="align === 'transcript'">
                <MixerAlignPanel
                  v-model="dualTranscript"
                  mode="dual"
                  compact
                  :primary-audio="audio.a"
                  :secondary-audio="audio.b"
                  :device="device"
                  :disabled="!!working || inputBusy.a || inputBusy.b"
                  @aligned-dual="onAlignedDual"
                  @busy="alignBusy = $event"
                />
                <div v-if="grids.a && grids.b" class="mx-anchor-summary" :class="{ failed: matchedAnchorCount < 0 }">
                  {{
                    matchedAnchorCount > 0
                      ? `已匹配 ${matchedAnchorCount} 个音素/音节共享边界锚点`
                      : '两段对齐结果的区间标签尚未完全匹配，请确认 A 与 B 朗读同一句原文'
                  }}
                </div>
              </template>

              <div v-else class="mx-tg-box">
                <div v-for="id in (['a', 'b'] as const)" :key="id" class="mx-tg-row">
                  <span class="mx-tg-name" :title="grids[id]?.name">
                    {{ grids[id]?.name ?? `说话人 ${id.toUpperCase()} 的 TextGrid` }}
                  </span>
                  <input
                    :ref="(el) => { gridInputs[id] = el as HTMLInputElement | undefined; }"
                    type="file"
                    accept=".TextGrid,.txt"
                    hidden
                    @change="setGridFile(id, $event)"
                  />
                  <button
                    type="button"
                    class="btn xs"
                    :disabled="!!working || gridBusy || !audio[id] || inputBusy[id]"
                    @click="gridInputs[id]?.click()"
                  >
                    <IconSvg name="upload" :size="11" />
                    <span>导入</span>
                  </button>
                </div>

                <button type="button" class="mx-link-btn-inline" @click="gridPasteOpen = !gridPasteOpen">
                  {{ gridPasteOpen ? '收起文本粘贴区' : '或直接粘贴 Praat TextGrid 文本' }}
                </button>

                <div v-if="gridPasteOpen" class="mx-tg-paste">
                  <div v-for="id in (['a', 'b'] as const)" :key="id" class="mx-tg-paste-slot">
                    <textarea
                      v-model="gridPasteText[id]"
                      class="inp mono"
                      rows="2"
                      :placeholder="`粘贴说话人 ${id.toUpperCase()} 的 TextGrid 文本…`"
                    />
                    <button type="button" class="btn xs" :disabled="!gridPasteText[id].trim()" @click="applyPastedTextGrid(id)">
                      解析 {{ id.toUpperCase() }}
                    </button>
                  </div>
                </div>

                <p v-if="gridError" class="mx-err-text" role="status">{{ gridError }}</p>
                <p v-else-if="grids.a && grids.b && matchedAnchorCount > 0" class="mx-ok-text">
                  已匹配 {{ matchedAnchorCount }} 个共享边界锚点。
                </p>
                <p v-else class="mx-help">两份 TextGrid 须包含标签序列一致的区间层，且时间范围与各自音频匹配。</p>
              </div>
            </div>
          </section>
        </template>
      </aside>

      <SplitPane
        v-model="railWidth"
        direction="vertical"
        :min="310"
        :max="480"
        :default-value="384"
        storage-key="research-mixer-rail"
        title="拖拽调整左栏宽度（双击恢复默认）"
      />

      <!-- RIGHT MAIN STAGE -->
      <main class="mx-stage" data-tour="mixer-stage">
        <!-- MODE 2 TOP DOCK: Side-by-Side Speaker A & Speaker B aligned flush at top of stage -->
        <section v-show="mode === 'dual'" class="mx-dual-dock" data-tour="mixer-dual-input" aria-label="双人音频输入">
          <article class="panel mx-speaker-card">
            <header class="p-head">
              <span>说话人 A（基准时间轴 · 0%）</span>
              <span class="tree-tag">基准 0%</span>
            </header>
            <div class="p-body">
              <MixerAudioInput
                ref="dualAInputRef"
                label="说话人 A"
                compact
                :audio="audio.a"
                :device="device"
                :disabled="!!working || inputBusy.b || gridBusy || alignBusy"
                :show-prep-button="true"
                :annotation-count="dualAAnnotationCount"
                :show-demo-button="true"
                :demo-busy="demoBusy"
                @change="setAudio('a', $event)"
                @busy="inputBusy.a = $event"
                @playhead="handlePlayhead"
                @playing="handlePlayerPlaying('inputA', $event)"
                @open-prep="openPrepModal('a')"
                @load-demo="loadDemoSample('a')"
              />
            </div>
          </article>

          <button
            type="button"
            class="btn icon-only mx-swap-btn"
            title="互换说话人 A 与说话人 B"
            aria-label="互换说话人 A 与说话人 B"
            :disabled="!!working || busyInput || (!audio.a && !audio.b)"
            @click="swapSpeakers"
          >
            <IconSvg name="shuffle" :size="14" />
          </button>

          <article class="panel mx-speaker-card">
            <header class="p-head">
              <span>说话人 B（目标移植源 · 100%）</span>
              <span class="mx-head-pill" :class="`tone-${dualBStatusBadge.tone}`">{{ dualBStatusBadge.text }}</span>
            </header>
            <div class="p-body">
              <MixerAudioInput
                ref="dualBInputRef"
                label="说话人 B"
                compact
                :audio="audio.b"
                :device="device"
                :disabled="!!working || inputBusy.a || gridBusy || alignBusy"
                :show-prep-button="true"
                :annotation-count="dualBAnnotationCount"
                :show-demo-button="true"
                :demo-busy="demoBusy"
                @change="setAudio('b', $event)"
                @busy="inputBusy.b = $event"
                @playing="handlePlayerPlaying('inputB', $event)"
                @open-prep="openPrepModal('b')"
                @load-demo="loadDemoSample('b')"
              />
            </div>
          </article>
        </section>

        <!-- Curve Editor & Acoustic Guard Panel -->
        <section class="panel mx-curve-panel">
          <header class="p-head mx-curve-head">
            <div class="mx-curve-title-group">
              <span>
                {{
                  mode === 'preset'
                    ? '3 · 拖动时变调制曲线 w(t)'
                    : `当前编辑轨：${activeGroup?.label ?? '混合权重曲线'}`
                }}
              </span>
              <span
                v-if="mode === 'preset' && preset"
                class="tree-tag mx-hover-trigger"
                @mouseenter="showPresetHover(preset, $event)"
                @mouseleave="clearPresetHover"
              >
                <IconSvg name="info" :size="11" />
                <span>当前：{{ parsePresetTitle(preset.label).zh }}</span>
              </span>
              <span v-else-if="mode === 'dual'" class="tree-tag">
                已启用 {{ activeEnabled.length }} 条曲线
              </span>
            </div>

            <div class="mx-curve-head-tools">
              <div class="seg control-seg xs" role="group" aria-label="背景图切换">
                <button
                  type="button"
                  :class="{ active: bgMode === 'waveform' }"
                  :aria-pressed="bgMode === 'waveform'"
                  @click="bgMode = 'waveform'"
                >
                  波形图
                </button>
                <button
                  type="button"
                  :class="{ active: bgMode === 'spectrogram' }"
                  :aria-pressed="bgMode === 'spectrogram'"
                  @click="bgMode = 'spectrogram'"
                >
                  语谱图
                </button>
              </div>
              <CustomSelect
                v-model="setup.interpolation"
                aria-label="曲线插值方式"
                size="xs"
                :options="interpolationOptions"
                :disabled="!!working"
              />
              <ModuleGuideButton module-id="mixer" size="xs" />
            </div>
          </header>

          <div class="p-body mx-curve-body" :inert="!!working">
            <div class="mx-toolbar-row" data-tour="mixer-toolbar">
              <div class="mx-shapes-wrap">
                <span class="mx-toolbar-label">快捷曲线</span>
                <button
                  v-for="shape in activeShapes"
                  :key="shape.id"
                  type="button"
                  class="btn xs"
                  @click="editor?.applyPresetShape(shape.id)"
                >
                  {{ shape.label }}
                </button>
                <span class="mx-toolbar-sep" aria-hidden="true" />
                <button
                  type="button"
                  class="btn xs icon-only"
                  title="撤销曲线修改 (Ctrl+Z)"
                  aria-label="撤销曲线修改"
                  :disabled="!canUndoCurve"
                  @click="editor?.undo()"
                >
                  <IconSvg name="undo" :size="11" />
                </button>
                <button
                  type="button"
                  class="btn xs icon-only"
                  title="重做曲线修改 (Ctrl+Y)"
                  aria-label="重做曲线修改"
                  :disabled="!canRedoCurve"
                  @click="editor?.redo()"
                >
                  <IconSvg name="redo" :size="11" />
                </button>
              </div>

              <label
                v-if="mode === 'dual' && activeGroup && !activeGroup.is_speaker && !activeGroup.is_timing"
                class="mx-delta-toggle"
                :title="activeGroup.recommended_delta ? '推荐开启：保留说话人 A 的解剖基准，仅移植 B 的动态位移' : '保留 A 的中位基准，仅移植 B 的相对动态变化'"
              >
                <input
                  type="checkbox"
                  :checked="deltaGroups.includes(drawing)"
                  @change="toggleDeltaGroup(drawing, ($event.target as HTMLInputElement).checked)"
                />
                <span>本组用相对偏移移植</span>
                <span v-if="activeGroup.recommended_delta" class="mx-rec-pill">推荐</span>
              </label>

              <span v-else class="mx-toolbar-sub">
                {{
                  mode === 'preset'
                    ? '0% 保留原发声 · 100% 目标预设（单击加点 · 拖拽调节 · 双击/右键删点）'
                    : `${activeGroup?.desc ?? ''}（0% = A，100% = B）`
                }}
              </span>
            </div>

            <p v-if="mode === 'dual' && activeGroup && !activeGroup.is_speaker && !activeGroup.is_timing" class="mx-track-desc-line">
              {{ activeGroup.desc }}（0% = 完全保留说话人 A，100% = 完全切换为说话人 B）
            </p>

            <!-- Mode 2: Timing Alignment Callout when timing track selected without matched annotations -->
            <div v-if="mode === 'dual' && drawing === 'timing' && matchedAnchorCount <= 0" class="mx-timing-callout">
              <span>
                「时长与韵律」需说话人 A 与 B 均具备一致的文字或音节标注序列，才能逐段平滑迁移音长与停顿节奏。
              </span>
              <button
                type="button"
                class="btn xs primary"
                :disabled="!audio.a && !audio.b"
                @click="openPrepModal(audio.a ? 'a' : 'b')"
              >
                <IconSvg name="scissors" :size="11" />
                <span>打开裁剪与标注对齐</span>
              </button>
            </div>

            <!-- Annotation-Guided Curve Sculpting Strip (works for all presets & organ/timing tracks) -->
            <div v-if="sculptableIntervals.length" class="mx-align-sculpt-bar">
              <div class="mx-sculpt-head">
                <span class="mx-toolbar-label">参考标注塑形</span>
                <div v-if="activeAlignTiers.length > 1" class="mx-sculpt-tiers" role="group" aria-label="标注层切换">
                  <button
                    v-for="(tier, idx) in activeAlignTiers"
                    :key="`${tier.name}-${idx}`"
                    type="button"
                    class="mx-tier-pill"
                    :class="{ active: curveAlignTierIdx === idx }"
                    @click="curveAlignTierIdx = idx"
                  >
                    {{ tier.name }}
                  </button>
                </div>
                <span class="muted mx-sculpt-hint">单击音节/音素快速局部塑形 · Shift+单击叠加 · 拖拽节点自动吸附边界（Alt 取消）</span>
              </div>
              <div class="mx-sculpt-chips">
                <button
                  v-for="(iv, idx) in sculptableIntervals"
                  :key="`${iv.xmin}-${idx}`"
                  type="button"
                  class="mx-sculpt-chip"
                  :title="`${iv.text}（${iv.xmin.toFixed(2)}–${iv.xmax.toFixed(2)} s）· 单击局部拉高该段权重，Shift+单击叠加`"
                  @click="applySegmentSculpt(iv, $event)"
                >
                  <span>{{ iv.text }}</span>
                  <small class="mono">{{ (iv.xmax - iv.xmin).toFixed(2) }}s</small>
                </button>
              </div>
            </div>

            <!-- Opaque Scientific Canvas Stage -->
            <div class="mx-plot-frame sci-plane" data-tour="mixer-plot">
              <div class="mx-canvas-host">
                <canvas
                  ref="canvas"
                  aria-label="时变曲线编辑器。单击添加节点，拖拽或方向键微调，双击删除中间节点。"
                />
                <div v-if="!base?.analysis" class="mx-canvas-empty" aria-hidden="true">
                  <span>载入或录制音频后自动显示{{ bgMode === 'spectrogram' ? '语谱图' : '波形底图' }}与保护区 · 当前可先预绘调制曲线</span>
                </div>
                <div v-else-if="spectrogramBusy && bgMode === 'spectrogram'" class="mx-canvas-badge">
                  正在计算 STFT 语谱图…
                </div>
              </div>

              <div class="mx-plot-footer">
                <div class="mx-legend-row">
                  <div class="mx-legend-items">
                    <span class="mx-lg smooth">平滑后目标曲线</span>
                    <span class="mx-lg effective">{{ appliedCurve ? '门控后实际生效曲线' : '门控后生效预览' }}</span>
                    <span
                      v-if="base?.analysis && setup.gate && (activeCurve === 'preset' || activeCurve === 'glottis')"
                      class="mx-lg gate"
                    >
                      {{ mode === 'dual' ? 'A 的静音/清音保护区' : '静音/清辅音保护区' }}
                    </span>
                    <span v-if="activeAlignIntervals.length" class="mx-lg align">对齐音素边界</span>
                    <span v-if="ghostCurves.length" class="mx-lg ghost">其余已启用轨道 ({{ ghostCurves.length }})</span>
                  </div>
                  <span class="mx-kbd-hint">聚焦画布后可用方向键微调（Shift 5×）· Ctrl+Z 撤销</span>
                </div>

                <div class="mx-curve-controls" role="group" aria-label="曲线节点编辑">
                  <div class="mx-knot-bar">
                    <strong class="mx-knot-tag mono" :title="`选中点 #${selected + 1}`">#{{ selected + 1 }}</strong>
                    <label class="mx-knot-field">
                      <span>时间 (s)</span>
                      <input
                        v-model="nodeTime"
                        type="text"
                        inputmode="decimal"
                        class="inp mono"
                        :disabled="selected === 0 || selected === nodes.length - 1"
                        @change="applyKnotFields"
                        @keydown.enter.prevent="applyKnotFields"
                      />
                    </label>
                    <label class="mx-knot-field">
                      <span>权重 (%)</span>
                      <input
                        v-model="nodeWeight"
                        type="text"
                        inputmode="decimal"
                        class="inp mono"
                        @change="applyKnotFields"
                        @keydown.enter.prevent="applyKnotFields"
                      />
                    </label>
                    <button type="button" class="btn xs" @click="addManualKnot">
                      <IconSvg name="plus" :size="11" />
                      <span>打点</span>
                    </button>
                    <button
                      type="button"
                      class="btn xs"
                      :disabled="selected === 0 || selected === nodes.length - 1 || nodes.length <= 2"
                      @click="editor?.deleteSelectedKnot()"
                    >
                      <IconSvg name="trash" :size="11" />
                      <span>删点</span>
                    </button>
                  </div>

                  <div class="mx-knot-pills" role="group" aria-label="全部控制点">
                    <button
                      v-for="(node, idx) in nodes"
                      :key="idx"
                      type="button"
                      class="mx-knot-pill mono"
                      :class="{ selected: selected === idx }"
                      :aria-pressed="selected === idx"
                      @click="editor?.selectKnot(idx); canvas?.focus()"
                    >
                      #{{ idx + 1 }} {{ (node.t * baseDuration).toFixed(2) }}s / {{ Math.round(node.v * 100) }}%
                    </button>
                  </div>
                </div>

                <div class="mx-acoustic-row" data-tour="mixer-acoustic" role="group" aria-label="声学调制参数">
                  <label
                    class="mx-acoustic-toggle"
                    :title="mode === 'preset'
                      ? '保护静音与清辅音。耳语或清化使用语音活动门控。'
                      : '保护说话人 A 的静音与清辅音。'"
                  >
                    <input v-model="setup.gate" type="checkbox" />
                    <span>软门控</span>
                  </label>
                  <div class="mx-smooth-slider" title="对权重曲线做高斯平滑，减轻相位突变（双击重置 25 ms）">
                    <CompactSlider
                      v-model="setup.smoothMs"
                      label="平滑"
                      :min="0"
                      :max="80"
                      :step="5"
                      :decimals="0"
                      unit="ms"
                      :default-value="25"
                      :disabled="!!working"
                    />
                  </div>
                  <div
                    v-if="mode === 'preset' && isCreakyMixerPreset(preset)"
                    class="mx-smooth-slider"
                    title="调节脉冲/粗糙抖动的不规则度：0% 为规则周期脉冲，100% 为强不规则基频与振幅抖动（双击重置本预设默认值）"
                  >
                    <CompactSlider
                      v-model="settings.preset.creakIrregularity"
                      label="脉冲不规则"
                      :min="0"
                      :max="100"
                      :step="5"
                      :decimals="0"
                      unit="%"
                      :default-value="Math.round((preset?.default_creak_irregularity ?? 0.3) * 100)"
                      :disabled="!!working"
                    />
                  </div>
                  <template v-if="mode === 'preset' && isDiplophoniaMixerPreset(preset)">
                    <div class="seg control-seg xs" role="radiogroup" aria-label="双音调耦合机制">
                      <button
                        v-for="opt in DIPLOPHONIA_MODE_OPTIONS"
                        :key="opt.id"
                        type="button"
                        role="radio"
                        :class="{ active: settings.preset.diplophoniaMode === opt.id }"
                        :aria-checked="settings.preset.diplophoniaMode === opt.id"
                        :title="opt.hint"
                        :disabled="!!working"
                        @click="selectDiplophoniaMode(opt.id)"
                      >
                        {{ opt.label }}
                      </button>
                    </div>
                    <div
                      class="mx-smooth-slider"
                      title="调节双声源振动频率比 f₂/f₁（避开 0.5 / 1.0 / 1.5 等整数倍双音调感更明显；双击重置当前机制默认值）"
                    >
                      <CompactSlider
                        v-model="settings.preset.diplophoniaRatio"
                        label="频率比 f₂/f₁"
                        :min="0.4"
                        :max="1.8"
                        :step="0.01"
                        :decimals="2"
                        unit="×"
                        :default-value="diplophoniaDefaultRatio"
                        :disabled="!!working"
                      />
                    </div>
                  </template>
                  <div class="mx-f0-control" :title="f0ControlHint">
                    <label class="mx-acoustic-toggle">
                      <input v-model="setup.f0" type="checkbox" />
                      <span>F0 联动</span>
                    </label>
                    <template v-if="mode === 'preset'">
                      <input
                        v-model="shift"
                        type="text"
                        inputmode="decimal"
                        class="inp mono mx-f0-inp"
                        aria-label="半音偏移"
                        :aria-invalid="!!shiftError"
                        :disabled="!setup.f0"
                        :placeholder="f0ShiftPlaceholder"
                      />
                      <span v-if="setup.f0 && !shift.trim()" class="mono muted mx-f0-active-hint">{{ f0Recommendation }}</span>
                    </template>
                  </div>
                </div>
                <p v-if="nodeError || (mode === 'preset' && shiftError)" class="mx-err-text" role="status">
                  {{ [nodeError, mode === 'preset' ? shiftError : ''].filter(Boolean).join(' · ') }}
                </p>
              </div>
            </div>
          </div>

          <!-- Pinned Action & Status Footer (Always visible, never clipped) -->
          <footer class="mx-action-bar" data-tour="mixer-footer">
            <div class="mx-status-pill" :class="`is-${statusBanner.kind}`" role="status" aria-live="polite">
              <span :class="`dot-${statusBanner.kind}`" aria-hidden="true" />
              <span>{{ statusBanner.text }}</span>
            </div>
            <div class="mx-action-btns">
              <button
                v-if="mode === 'dual'"
                type="button"
                class="btn sm"
                :disabled="!!working || !activeEnabled.length"
                @click="clearAllDualTracks"
              >
                清零全部轨道
              </button>
              <button type="button" class="btn primary" :disabled="!canRender" @click="render">
                <IconSvg name="sparkles" :size="13" />
                <span>
                  {{
                    working === 'render'
                      ? '正在合成…'
                      : mode === 'preset'
                        ? '生成时变调制音频'
                        : '生成双人时变混合音频'
                  }}
                </span>
              </button>
            </div>
          </footer>
        </section>

        <!-- Bottom Comparison, Export & Workspace Handoff Dock -->
        <section class="panel mx-compare-panel" data-tour="mixer-compare">
          <header class="p-head">
            <div class="mx-curve-title-group">
              <span>{{ mode === 'preset' ? '4 · 试听对比与导出' : '三轨试听对比与导出' }}</span>
              <span v-if="output" class="metric-chip mono">
                {{ output.result.label }} · {{ mixerDeviceLabel(output.result.device_effective) }}
                <template v-if="typeof output.result.synth_ms === 'number'">
                  · {{ output.result.synth_ms.toFixed(0)}}{{ ' ms' }}
                </template>
              </span>
            </div>

            <div class="mx-compare-head-actions">
              <button
                v-if="base?.file && (comparisonBaseline || output?.blob)"
                type="button"
                class="btn xs"
                :class="{ active: compareExpanded }"
                :aria-expanded="compareExpanded"
                title="展开或收起选区语谱图叠印、功率谱与 12 项发声声学参数对比"
                @click="toggleCompareExpanded"
              >
                <IconSvg name="waveform" :size="11" />
                <span>{{ compareExpanded ? '收起频谱对比' : '频谱与声学对比' }}</span>
              </button>

              <button
                v-if="mode === 'preset'"
                type="button"
                class="btn xs"
                :disabled="!audio.preset?.url || !output?.url"
                title="在当前播放时刻无缝轮切试听原声、声道重建合成与发声调音结果（快捷键 B，空格播停）"
                @click="toggleComparePresetAB"
              >
                <IconSvg name="shuffle" :size="11" />
                <span>{{ output?.baselineUrl ? '轮切 原声 / 重建 / 调音 (B)' : 'A/B 切换试听 (B)' }}</span>
              </button>
              <button
                v-else
                type="button"
                class="btn xs"
                :disabled="!output?.url || (!audio.a?.url && !audio.b?.url)"
                title="在当前播放时刻快速轮切说话人 A、B 与混合结果（快捷键 B，空格播停）"
                @click="cycleCompareDual"
              >
                <IconSvg name="shuffle" :size="11" />
                <span>轮切 A / B / 混合 (B)</span>
              </button>

              <a
                v-if="output"
                class="btn xs primary"
                :href="output.url"
                :download="handoffSourceName"
              >
                <IconSvg name="download" :size="11" />
                <span>下载 WAV</span>
              </a>
            </div>
          </header>

          <div class="p-body mx-compare-body">
            <!-- Mode 1: Original / Reconstructed Baseline / Modulated Result -->
            <div v-if="mode === 'preset'" class="mx-compare-grid" :class="output?.baselineUrl ? 'cols-3' : 'cols-2'">
              <div class="mx-cmp-slot" :class="{ highlight: abActiveSlot === 'orig' && cmpOrigRef?.isPlaying() }">
                <div class="mx-cmp-label">原声参考 (原始录音)</div>
                <MixerAudioPlayer
                  ref="cmpOrigRef"
                  :src="audio.preset?.url ?? null"
                  label="原声参考"
                  :duration-hint="audio.preset?.analysis?.dur_sec ?? audio.preset?.duration ?? 0"
                  :peaks="audio.preset?.analysis?.waveform_peaks ?? []"
                  placeholder="载入原声后可在此对照试听"
                  @playhead="handlePlayhead"
                  @playing="handlePlayerPlaying('orig', $event)"
                />
              </div>

              <div
                v-if="output?.baselineUrl"
                class="mx-cmp-slot"
                :class="{ highlight: abActiveSlot === 'recon' && cmpReconPresetRef?.isPlaying() }"
              >
                <div class="mx-cmp-label">声道重建合成 (0% 未调音基线)</div>
                <MixerAudioPlayer
                  ref="cmpReconPresetRef"
                  :src="output.baselineUrl"
                  label="声道重建合成"
                  :duration-hint="audio.preset?.analysis?.dur_sec ?? audio.preset?.duration ?? 0"
                  placeholder="声道重建基线音频"
                  @playhead="handlePlayhead"
                  @playing="handlePlayerPlaying('recon', $event)"
                />
              </div>

              <div class="mx-cmp-slot" :class="{ highlight: abActiveSlot === 'out' && cmpOutPresetRef?.isPlaying() }">
                <div class="mx-cmp-label">发声调音结果 (After)</div>
                <MixerAudioPlayer
                  ref="cmpOutPresetRef"
                  :src="output?.url ?? null"
                  label="发声调音结果"
                  :duration-hint="audio.preset?.analysis?.dur_sec ?? audio.preset?.duration ?? 0"
                  :download-name="output ? handoffSourceName : ''"
                  placeholder="点击「生成时变调制音频」后试听与导出"
                  @playhead="handlePlayhead"
                  @playing="handlePlayerPlaying('out', $event)"
                />
              </div>
            </div>

            <!-- Mode 2: 3-Track A / B / Result -->
            <div v-else class="mx-compare-grid cols-3">
              <div class="mx-cmp-slot" :class="{ highlight: dualActiveSlot === 'a' && cmpARef?.isPlaying() }">
                <div class="mx-cmp-label">说话人 A 原声</div>
                <MixerAudioPlayer
                  ref="cmpARef"
                  :src="audio.a?.url ?? null"
                  label="说话人 A 原声"
                  :duration-hint="audio.a?.analysis?.dur_sec ?? audio.a?.duration ?? 0"
                  :peaks="audio.a?.analysis?.waveform_peaks ?? []"
                  placeholder="尚未载入说话人 A"
                  @playhead="handlePlayhead"
                  @playing="handlePlayerPlaying('a', $event)"
                />
              </div>

              <div class="mx-cmp-slot" :class="{ highlight: dualActiveSlot === 'b' && cmpBRef?.isPlaying() }">
                <div class="mx-cmp-label">说话人 B 原声</div>
                <MixerAudioPlayer
                  ref="cmpBRef"
                  :src="audio.b?.url ?? null"
                  label="说话人 B 原声"
                  :duration-hint="audio.b?.analysis?.dur_sec ?? audio.b?.duration ?? 0"
                  :peaks="audio.b?.analysis?.waveform_peaks ?? []"
                  placeholder="尚未载入说话人 B"
                  @playing="handlePlayerPlaying('b', $event)"
                />
              </div>

              <div class="mx-cmp-slot" :class="{ highlight: dualActiveSlot === 'out' && cmpOutDualRef?.isPlaying() }">
                <div class="mx-cmp-label">时变混合结果 (A → B)</div>
                <MixerAudioPlayer
                  ref="cmpOutDualRef"
                  :src="output?.url ?? null"
                  label="时变混合结果"
                  :duration-hint="output?.result.out_dur_sec ?? audio.a?.analysis?.dur_sec ?? audio.a?.duration ?? 0"
                  :download-name="output ? handoffSourceName : ''"
                  placeholder="点击「生成双人时变混合音频」后试听"
                  @playhead="handlePlayhead"
                  @playing="handlePlayerPlaying('dualOut', $event)"
                />
              </div>
            </div>

            <!-- Collapsible Selected-Interval Overlaid Spectrogram & Voice Quality Acoustic Comparison -->
            <div v-if="base?.file && (comparisonBaseline || output?.blob)" ref="compareDrawerRef" class="mx-compare-drawer">
              <button
                type="button"
                class="btn mx-compare-toggle"
                :class="{ active: compareExpanded }"
                :aria-expanded="compareExpanded"
                @click="toggleCompareExpanded"
              >
                <span class="mx-compare-icon" aria-hidden="true">
                  <IconSvg name="waveform" :size="14" />
                </span>
                <span class="mx-compare-copy">
                  <strong>选区语谱图叠印与 12 项发声声学参数对比</strong>
                  <span class="mx-compare-sub">窄/宽带语谱图 · 谱差 ΔdB · H1−H2* / CPP / HNR / 谱倾斜 · 支持 CSV 导出</span>
                </span>
                <span class="mx-compare-cta">
                  <span>{{ compareExpanded ? '收起频谱图' : '展开查看频谱图' }}</span>
                  <IconSvg :name="compareExpanded ? 'chevron-up' : 'chevron-down'" :size="13" />
                </span>
              </button>
              <MixerIntervalCompare
                v-if="compareExpanded"
                :raw-blob="rawOrigins[baseSlot] ?? base.file"
                :reconstructed-blob="comparisonBaseline"
                :after-blob="output?.blob ?? null"
                :raw-label="mode === 'preset' ? '原声 (原始录音)' : '原声 (说话人 A 原始录音)'"
                :reconstructed-label="renderBaseline ? `声道重建合成 (${voiceRenderLabels[synth]} · 0% 基线)` : '声道重建合成 (来自声道重建工作区)'"
                :after-label="mode === 'preset' ? `发声调音后 (${parsePresetTitle(preset?.label ?? '调制结果').zh})` : '发声调音后 (A → B 混合)'"
                :applied-curve="appliedCurve ?? []"
                :voiced-gate="base.analysis?.voiced_gate ?? []"
                :align-intervals="activeAlignIntervals"
                :dark-mode="store.resolvedColorMode.value === 'dark'"
              />
            </div>

            <!-- Unified One-Click Workspace Handoff Strip -->
            <div class="mx-handoff-strip" data-tour="mixer-handoff">
              <div class="mx-handoff-title">
                <strong>一键流转至工作区</strong>
                <span class="muted" :class="{ 'mx-handoff-warn': !output && !!base }">
                  {{
                    output
                      ? '当前发送：调音成品'
                      : base
                        ? '当前发送：未调制原声（点击上方「生成」后将发送调音成品）'
                        : '载入或生成音频后可流转'
                  }}
                </span>
              </div>
              <div class="mx-handoff-btns">
                <button
                  type="button"
                  class="btn xs"
                  :disabled="!handoffBlob"
                  title="将当前音频送入声道重建页进行三视图解剖与边界精修"
                  @click="sendToWorkspace('m27Align')"
                >
                  <IconSvg name="reconstruct" :size="12" />
                  <span>送入声道重建</span>
                </button>
                <button
                  type="button"
                  class="btn xs"
                  :disabled="!handoffBlob"
                  title="将当前音频及对齐边界送入语音标注页"
                  @click="sendToWorkspace('annotation')"
                >
                  <IconSvg name="timeline" :size="12" />
                  <span>送入标注页</span>
                </button>
                <button
                  type="button"
                  class="btn xs"
                  :disabled="!handoffBlob"
                  title="将当前音频送入编曲工作台修改音高旋律"
                  @click="sendToWorkspace('arranger')"
                >
                  <IconSvg name="piano" :size="12" />
                  <span>送入编曲改音高</span>
                </button>
                <button
                  type="button"
                  class="btn xs"
                  :disabled="!handoffBlob"
                  title="将当前音频发送到剪辑"
                  @click="sendToWorkspace('studio')"
                >
                  <IconSvg name="stage" :size="12" />
                  <span>发送到剪辑</span>
                </button>
                <button
                  type="button"
                  class="btn xs"
                  :disabled="!handoffBlob"
                  title="送入语音连续统实验室端点 A"
                  @click="sendToWorkspace('continuumA')"
                >
                  <IconSvg name="sliders" :size="12" />
                  <span>连续统 A</span>
                </button>
                <button
                  type="button"
                  class="btn xs"
                  :disabled="!handoffBlob"
                  title="送入语音连续统实验室端点 B"
                  @click="sendToWorkspace('continuumB')"
                >
                  <IconSvg name="sliders" :size="12" />
                  <span>连续统 B</span>
                </button>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>

    <MixerPresetHoverCard :preset="hoveredPreset" :anchor-rect="hoverAnchorRect" />

    <MixerPrepModal
      :open="prepOpen"
      :mode="mode"
      :initial-target="prepTarget"
      :audio-preset="audio.preset"
      :audio-a="audio.a"
      :audio-b="audio.b"
      :grid-preset="presetGrid"
      :grid-a="grids.a?.grid ?? null"
      :grid-b="grids.b?.grid ?? null"
      :transcript-preset="presetTranscript"
      :transcript-a="dualTranscript"
      :transcript-b="dualTranscriptB"
      :device="device"
      @close="prepOpen = false"
      @save="handlePrepSave"
    />
  </div>
</template>

<style scoped>
.mx-shell {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-layout, 9px);
  padding: var(--pad-shell, 9px);
  overflow: auto;
  scrollbar-width: thin;
}

/* Left-rail Mode & Engine Card */
.mx-ctrl-card {
  padding: 6px 8px;
  gap: 5px;
  overflow: visible;
}

.mx-modes {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.mx-modes button {
  width: 100%;
  padding: 0 8px;
  font-weight: 600;
}

.mx-engine-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 6px;
}

.mx-engine-grid :deep(.vc-sel) {
  width: 100%;
  min-width: 0;
}

.mx-offline-banner {
  flex: none;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  border-color: color-mix(in srgb, var(--danger) 48%, var(--panel-border));
}

.mx-offline-text {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--danger);
}

/* Mode 2 Top Dual-Speaker Dock */
.mx-dual-dock {
  flex: none;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: stretch;
  gap: var(--gap-layout, 9px);
}

.mx-speaker-card .p-body {
  padding: 8px 10px;
  overflow: visible;
}

.mx-swap-btn {
  align-self: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
}

.mx-head-pill {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 600;
  white-space: nowrap;
}

.mx-head-pill.tone-good {
  background: color-mix(in srgb, var(--success) 16%, transparent);
  color: var(--success);
}

.mx-head-pill.tone-warn {
  background: color-mix(in srgb, var(--warning) 16%, transparent);
  color: var(--warning);
}

.mx-head-pill.tone-muted {
  background: color-mix(in srgb, var(--muted) 14%, transparent);
  color: var(--muted);
}

/* 2-Column Workstation Layout */
.mx-workspace {
  flex: 1 0 auto;
  min-width: 920px;
  min-height: 0;
  display: grid;
  grid-template-columns: clamp(310px, var(--mx-rail-w, 384px), 480px) 6px minmax(0, 1fr);
  gap: var(--gap-layout, 9px);
  align-items: stretch;
}

.mx-rail,
.mx-stage {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--gap-layout, 9px);
}

.mx-card {
  flex: none;
}

.mx-card.mx-grow {
  flex: 1 0 auto;
  min-height: 0;
}

.mx-card > .p-body {
  overflow: visible;
}

.mx-rail .mx-card > .p-body {
  padding: 7px 9px;
}

.mx-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mx-help {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.45;
  color: var(--muted);
}

.mx-head-meta {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.82rem;
  color: var(--muted);
  white-space: nowrap;
}

.mx-dot-legend {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--success);
  display: inline-block;
}

/* Mode 1 Alignment Details */
.mx-align-details {
  margin-top: 0;
}

.mx-align-details summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.mx-align-details-body {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, var(--panel-border) 64%, transparent);
}

/* Mode 1 Compact 2-Col Phonation Presets */
.mx-preset-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mx-preset-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
}

.mx-preset-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 7px;
  border-radius: var(--r-ctrl);
  border: var(--border-w, 1px) solid var(--ctrl-border, var(--panel-border));
  background: var(--ctrl-bg);
  box-shadow: var(--ctrl-shadow);
  cursor: pointer;
  transition: border-color var(--dur-fast, 165ms) ease, background-color var(--dur-fast, 165ms) ease, transform var(--dur-fast, 165ms) ease;
}

.mx-preset-card:hover:not(.disabled) {
  border-color: color-mix(in srgb, var(--accent) 56%, var(--panel-border));
  background: color-mix(in srgb, var(--selected) 52%, var(--panel));
  transform: translateY(-0.5px);
}

.mx-preset-card.active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--selected) 88%, var(--panel));
  box-shadow: var(--ctrl-inset), 0 0 0 1px color-mix(in srgb, var(--accent) 32%, transparent);
}

.mx-preset-card.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.mx-preset-card.unavailable {
  opacity: 0.48;
  filter: grayscale(0.85);
  border-style: dashed;
  background: color-mix(in srgb, var(--app) 54%, var(--ctrl-bg));
  box-shadow: none;
  cursor: not-allowed;
}

.mx-preset-card.unavailable:hover {
  border-color: color-mix(in srgb, var(--muted) 56%, var(--panel-border));
}

.mx-preset-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

.mx-preset-names {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  min-width: 0;
  overflow: hidden;
}

.mx-preset-names strong {
  font-size: 0.86rem;
  line-height: 1.2;
  color: var(--text);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mx-preset-en {
  font-size: 0.72rem;
  line-height: 1.15;
  color: var(--muted);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mx-unavailable-group {
  border-radius: var(--r-ctrl);
  border: 1px dashed color-mix(in srgb, var(--panel-border) 88%, transparent);
  background: color-mix(in srgb, var(--app) 45%, transparent);
  padding: 5px 7px;
}

.mx-unavailable-group summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}

.mx-exp-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
  margin-top: 5px;
}

.mx-exp-card {
  border-style: dashed;
  padding: 4px 6px;
}

.mx-exp-card.active {
  border-style: solid;
}

.mx-f0-tag.exp {
  background: color-mix(in srgb, var(--violet) 16%, transparent);
  color: var(--violet);
}

.mx-unavailable-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 6px;
}

.mx-unavailable-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: var(--r-ctrl);
  border: 1px dashed color-mix(in srgb, var(--muted) 42%, var(--panel-border));
  background: color-mix(in srgb, var(--panel) 72%, transparent);
  color: var(--muted);
  font-size: 0.78rem;
  cursor: help;
}

.mx-preset-badges {
  display: flex;
  align-items: center;
  gap: 3px;
  flex: none;
}

.mx-f0-tag {
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.72rem;
  font-weight: 600;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  white-space: nowrap;
}

.mx-f0-tag.custom {
  background: var(--teal-bg);
  color: var(--teal);
}

.mx-f0-tag.unavailable {
  background: color-mix(in srgb, var(--muted) 16%, transparent);
  color: var(--muted);
}

.mx-preset-del {
  width: 17px;
  height: 17px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  display: grid;
  place-items: center;
  cursor: pointer;
}

.mx-preset-del:hover {
  background: color-mix(in srgb, var(--danger) 18%, transparent);
  color: var(--danger);
}

.mx-extract-box {
  margin-top: auto;
  padding-top: 7px;
  border-top: 1px solid color-mix(in srgb, var(--panel-border) 76%, transparent);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mx-extract-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.mx-extract-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: help;
}

.mx-extract-hint {
  font-size: 0.72rem;
  color: var(--muted);
  white-space: nowrap;
}

.mx-extract-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mx-extract-row .inp {
  flex: 1;
  min-width: 0;
}

/* Mode 2 Organ Groups List */
.mx-group-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mx-group-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 9px;
  border-radius: var(--r-ctrl);
  border: var(--border-w, 1px) solid var(--ctrl-border, var(--panel-border));
  background: var(--ctrl-bg);
  box-shadow: var(--ctrl-shadow);
  cursor: pointer;
  transition: border-color var(--dur-fast, 165ms) ease, background-color var(--dur-fast, 165ms) ease;
}

.mx-group-card:hover:not(.disabled) {
  border-color: color-mix(in srgb, var(--accent) 52%, var(--panel-border));
}

.mx-group-card.active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--selected) 88%, var(--panel));
  box-shadow: var(--ctrl-inset);
}

.mx-group-card.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mx-group-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mx-group-title-wrap {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}

.mx-group-title-wrap strong {
  font-size: 0.92rem;
}

.mx-delta-chip {
  padding: 0 5px;
  border-radius: 4px;
  font-size: 0.74rem;
  font-weight: 600;
  background: var(--violet-bg);
  color: var(--violet);
}

.mx-group-right {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: none;
}

.mx-spark {
  width: 44px;
  height: 14px;
  color: var(--muted);
  opacity: 0.5;
}

.mx-group-card.engaged .mx-spark {
  color: var(--accent);
  opacity: 1;
}

.mx-track-switch {
  position: relative;
  width: 28px;
  height: 16px;
  padding: 0;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--muted) 48%, var(--panel-border));
  background: color-mix(in srgb, var(--app) 76%, var(--panel));
  cursor: pointer;
  flex: none;
  transition: background-color var(--dur-fast) ease, border-color var(--dur-fast) ease;
}

.mx-track-switch .mx-track-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--muted);
  transition: transform var(--dur-fast) var(--ease-out-expo), background-color var(--dur-fast) ease;
}

.mx-track-switch.on {
  border-color: var(--success);
  background: color-mix(in srgb, var(--success) 24%, var(--panel));
}

.mx-track-switch.on .mx-track-thumb {
  transform: translateX(12px);
  background: var(--success);
}

.mx-track-switch:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.mx-group-desc {
  margin: 0;
  font-size: 0.79rem;
  line-height: 1.38;
  color: var(--muted);
}

/* TextGrid & Anchor Alignment */
.mx-tg-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mx-tg-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 5px 7px;
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--app) 62%, transparent);
  border: 1px solid var(--ctrl-border, var(--panel-border));
}

.mx-tg-name {
  min-width: 0;
  flex: 1;
  font-size: 0.84rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mx-link-btn-inline {
  align-self: flex-start;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--accent);
  font-size: 0.82rem;
  cursor: pointer;
}

.mx-link-btn-inline:hover {
  text-decoration: underline;
}

.mx-tg-paste {
  display: grid;
  gap: 6px;
}

.mx-tg-paste-slot {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: start;
  gap: 6px;
}

.mx-tg-paste-slot textarea {
  font-size: 0.8rem;
  resize: vertical;
}

.mx-anchor-summary {
  padding: 5px 8px;
  border-radius: var(--r-ctrl);
  font-size: 0.82rem;
  background: color-mix(in srgb, var(--success) 12%, transparent);
  color: var(--success);
}

.mx-anchor-summary.failed {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
}

/* Right Main Stage: Curve Panel */
.mx-curve-panel {
  flex: 1 0 auto;
  min-height: 0;
}

.mx-curve-head {
  gap: 10px;
}

.mx-curve-title-group {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.mx-curve-title-group > span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mx-curve-head-tools {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: none;
}

.mx-curve-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: visible;
}

.mx-toolbar-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 10px;
}

.mx-shapes-wrap {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}

.mx-toolbar-sep {
  width: 1px;
  height: 14px;
  margin: 0 2px;
  background: var(--panel-border);
}

.mx-toolbar-label {
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--muted);
  margin-right: 2px;
}

.mx-toolbar-sub,
.mx-track-desc-line {
  margin: 0;
  font-size: 0.83rem;
  color: var(--muted);
}

.mx-delta-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--ctrl-border, var(--panel-border));
  background: var(--ctrl-bg);
  font-size: 0.84rem;
  font-weight: 600;
  cursor: pointer;
}

.mx-delta-toggle input {
  margin: 0;
  accent-color: var(--accent);
}

.mx-rec-pill {
  padding: 0 5px;
  border-radius: 4px;
  font-size: 0.74rem;
  background: var(--selected);
  color: var(--accent);
}

/* Curve Plot Frame */
.mx-plot-frame {
  flex: 1 0 auto;
  min-height: 0;
  height: auto;
  display: flex;
  flex-direction: column;
  border: var(--border-w, 1px) solid var(--ctrl-border, var(--panel-border));
  border-radius: var(--r-ctrl);
  overflow: visible;
}

.mx-canvas-host {
  position: relative;
  flex: 1 0 auto;
  height: clamp(190px, 24vh, 275px);
  min-height: 180px;
  width: 100%;
  overflow: hidden;
  border-radius: calc(var(--r-ctrl) - 1px) calc(var(--r-ctrl) - 1px) 0 0;
}

.mx-canvas-host canvas {
  --vm-grid-line: color-mix(in srgb, var(--muted) 20%, transparent);
  --vm-muted: var(--muted);
  --vm-wave-color: color-mix(in srgb, var(--text) 20%, transparent);
  --vm-gate-block: color-mix(in srgb, var(--danger) 17%, transparent);
  --vm-curve-raw: color-mix(in srgb, var(--violet) 78%, transparent);
  --vm-curve-eff: var(--accent);
  --vm-curve-fill: color-mix(in srgb, var(--accent) 16%, transparent);
  --vm-knot-fill: var(--panel);
  --vm-knot-stroke: var(--accent);
  --vm-knot-active: var(--warning);
  --vm-tooltip-bg: var(--popover-bg);
  --vm-tooltip-fg: var(--text);
  --vm-tooltip-border: var(--panel-border);
  --vm-playhead: var(--warning);
  --vm-spec-scrim: color-mix(in srgb, var(--panel) 14%, transparent);
  --vm-align-strip-bg: color-mix(in srgb, var(--sidebar) 76%, transparent);
  --vm-align-bound: color-mix(in srgb, var(--teal) 44%, transparent);
  --vm-align-text: var(--text);
  --vm-ghost-curve: color-mix(in srgb, var(--muted) 70%, var(--accent));
  width: 100%;
  height: 100%;
  display: block;
  cursor: crosshair;
  touch-action: none;
}

.mx-canvas-empty,
.mx-canvas-badge {
  position: absolute;
  pointer-events: none;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 0.82rem;
  color: var(--muted);
  background: color-mix(in srgb, var(--panel) 84%, transparent);
  border: 1px solid var(--panel-border);
}

.mx-canvas-empty {
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  white-space: nowrap;
}

.mx-canvas-badge {
  right: 12px;
  top: 10px;
}

.mx-plot-footer {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 7px 10px;
  background: color-mix(in srgb, var(--sidebar) 56%, var(--panel));
  border-top: 1px solid color-mix(in srgb, var(--panel-border) 78%, transparent);
  border-radius: 0 0 calc(var(--r-ctrl) - 1px) calc(var(--r-ctrl) - 1px);
}

.mx-legend-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 12px;
  font-size: 0.82rem;
  color: var(--muted);
}

.mx-legend-items {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 14px;
}

.mx-lg::before {
  content: '';
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 2.5px;
  margin-right: 5px;
  vertical-align: -0.5px;
  background: var(--lg-c);
}

.mx-lg.smooth { --lg-c: var(--violet); }
.mx-lg.effective { --lg-c: var(--accent); }
.mx-lg.gate { --lg-c: color-mix(in srgb, var(--danger) 42%, transparent); }
.mx-lg.align { --lg-c: var(--teal); }
.mx-lg.ghost { --lg-c: color-mix(in srgb, var(--muted) 70%, var(--accent)); }

.mx-kbd-hint {
  font-size: 0.8rem;
  color: var(--muted);
}

.mx-curve-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 1px 2px;
  min-width: 0;
  white-space: nowrap;
  border-top: 1px solid color-mix(in srgb, var(--panel-border) 62%, transparent);
}

.mx-acoustic-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding: 6px 1px 1px;
  font-size: 0.84rem;
  border-top: 1px dashed color-mix(in srgb, var(--panel-border) 55%, transparent);
}

.mx-knot-bar,
.mx-acoustic-toggle,
.mx-f0-control {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
}

.mx-smooth-slider {
  width: 162px;
  flex: none;
}

.mx-smooth-slider :deep(.p-row) {
  gap: 1px;
  margin: 0;
}

.mx-smooth-slider :deep(.p-row-top) {
  font-size: 0.78rem;
  line-height: 1.15;
}

.mx-knot-tag {
  font-size: 0.86rem;
  color: var(--text);
}

.mx-knot-field {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.84rem;
  color: var(--muted);
}

.mx-knot-field .inp {
  width: 56px;
  height: 23px;
  padding: 0 6px;
  font-size: 0.86rem;
}

.mx-knot-pills {
  display: flex;
  flex: 1 1 auto;
  gap: 5px;
  min-width: 0;
  padding: 2px 1px;
  overflow-x: auto;
  scrollbar-width: thin;
}

.mx-knot-pill {
  flex: none;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--ctrl-border, var(--panel-border));
  background: var(--ctrl-bg);
  color: var(--muted);
  font-size: 0.8rem;
  cursor: pointer;
  transition: border-color 120ms ease, color 120ms ease, background-color 120ms ease;
}

.mx-knot-pill:hover {
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 52%, var(--panel-border));
}

.mx-knot-pill.selected {
  border-color: var(--warning);
  background: color-mix(in srgb, var(--warning) 16%, var(--panel));
  color: var(--text);
  font-weight: 700;
}

.mx-acoustic-toggle {
  cursor: pointer;
}

.mx-acoustic-toggle input {
  width: 15px;
  height: 15px;
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}

.mx-f0-inp {
  width: 114px;
  height: 22px;
  padding: 0 6px;
  font-size: 0.82rem;
}

.mx-f0-active-hint {
  font-size: 0.8rem;
}

/* Action & Status Footer */
.mx-action-bar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 11px;
  border-top: 1px solid color-mix(in srgb, var(--panel-border) 76%, transparent);
  background: color-mix(in srgb, var(--sidebar) 40%, transparent);
}

.mx-status-pill {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--app) 64%, var(--panel));
  border: 1px solid var(--ctrl-border, var(--panel-border));
  font-size: 0.86rem;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mx-status-pill.is-ok {
  border-color: color-mix(in srgb, var(--success) 42%, var(--panel-border));
  color: var(--text);
}

.mx-status-pill.is-err {
  border-color: color-mix(in srgb, var(--danger) 55%, var(--panel-border));
  color: var(--danger);
  white-space: normal;
}

.mx-action-btns {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

/* Comparison & Workspace Handoff Panel */
.mx-compare-panel {
  flex: none;
}

.mx-compare-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

.mx-compare-body {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.mx-compare-grid {
  display: grid;
  gap: 9px;
}

.mx-compare-grid.cols-2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.mx-compare-grid.cols-3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.mx-cmp-slot {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px 9px;
  border-radius: var(--r-ctrl);
  background: var(--ctrl-bg);
  border: var(--border-w, 1px) solid var(--ctrl-border, var(--panel-border));
  min-width: 0;
  transition: border-color 140ms ease;
}

.mx-cmp-slot.highlight {
  border-color: var(--accent);
}

.mx-cmp-label {
  font-size: 0.86rem;
  font-weight: 600;
  color: var(--text);
}

/* One-Click Workspace Handoff */
.mx-handoff-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--panel-border) 72%, transparent);
}

.mx-handoff-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.88rem;
}

.mx-handoff-title span {
  font-size: 0.82rem;
}

.mx-handoff-btns {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}

.mx-err-text {
  margin: 0;
  font-size: 0.82rem;
  color: var(--danger);
}

.mx-ok-text {
  margin: 0;
  font-size: 0.82rem;
  color: var(--success);
}

.mx-f0-tag.auto-f0 {
  background: color-mix(in srgb, var(--success) 18%, transparent);
  color: var(--success);
}

.mx-compare-drawer {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mx-compare-toggle {
  width: 100%;
  height: auto;
  min-height: 44px;
  padding: 7px 10px;
  justify-content: flex-start;
  align-items: center;
  gap: 10px;
  text-align: left;
  border-color: color-mix(in srgb, var(--accent) 46%, var(--panel-border));
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--accent) 12%, var(--ctrl-bg)),
    color-mix(in srgb, var(--teal) 7%, var(--ctrl-bg))
  );
  box-shadow: var(--ctrl-shadow);
  transition: border-color var(--dur-fast) ease, background-color var(--dur-fast) ease, transform var(--dur-fast) ease;
}

.mx-compare-toggle:hover {
  border-color: var(--accent);
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--accent) 18%, var(--ctrl-bg)),
    color-mix(in srgb, var(--teal) 11%, var(--ctrl-bg))
  );
  transform: translateY(-0.5px);
}

.mx-compare-toggle.active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--selected) 84%, var(--panel));
  box-shadow: var(--ctrl-inset);
}

.mx-compare-icon {
  width: 28px;
  height: 28px;
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--accent) 16%, var(--panel));
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 34%, transparent);
  display: grid;
  place-items: center;
  flex: none;
}

.mx-compare-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.mx-compare-copy strong {
  font-size: 0.88rem;
  font-weight: 700;
  color: var(--text);
  line-height: 1.25;
}

.mx-compare-sub {
  font-size: 0.77rem;
  color: var(--muted);
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mx-compare-cta {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
  background: var(--accent);
  color: var(--on-accent);
  white-space: nowrap;
}

.mx-compare-toggle.active .mx-compare-cta {
  background: color-mix(in srgb, var(--accent) 16%, var(--panel));
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 44%, transparent);
}

.mx-handoff-warn {
  color: var(--warning);
}

.mx-hover-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: help;
}

.mx-req-chip {
  padding: 0 5px;
  border-radius: 4px;
  font-size: 0.72rem;
  font-weight: 600;
  background: color-mix(in srgb, var(--warning) 16%, transparent);
  color: var(--warning);
}

.mx-req-chip.ready {
  background: color-mix(in srgb, var(--success) 16%, transparent);
  color: var(--success);
}

.mx-prep-launch-btn {
  width: 100%;
  justify-content: center;
}

.mx-timing-callout {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 9px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--warning) 44%, var(--panel-border));
  background: color-mix(in srgb, var(--warning) 10%, var(--panel));
  font-size: 0.82rem;
  color: var(--text);
}

.mx-align-sculpt-bar {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 6px 8px;
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--teal-bg, color-mix(in srgb, var(--teal) 10%, transparent)) 55%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--teal) 30%, var(--panel-border));
}

.mx-sculpt-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
}

.mx-sculpt-tiers {
  display: inline-flex;
  gap: 4px;
}

.mx-tier-pill {
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--ctrl-border, var(--panel-border));
  background: var(--ctrl-bg);
  color: var(--muted);
  font-size: 0.74rem;
  cursor: pointer;
}

.mx-tier-pill.active {
  border-color: var(--teal);
  color: var(--teal);
  background: color-mix(in srgb, var(--teal) 14%, var(--panel));
  font-weight: 600;
}

.mx-sculpt-hint {
  font-size: 0.76rem;
}

.mx-sculpt-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 62px;
  overflow: auto;
  scrollbar-width: thin;
}

.mx-sculpt-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--teal) 38%, var(--panel-border));
  background: var(--ctrl-bg);
  color: var(--text);
  font-size: 0.8rem;
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease;
}

.mx-sculpt-chip:hover {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--selected) 72%, var(--panel));
}

.mx-sculpt-chip small {
  font-size: 0.7rem;
  color: var(--muted);
}

@container desktop (max-width: 1180px) {
  .mx-compare-grid.cols-3 {
    grid-template-columns: 1fr;
  }
}
</style>
