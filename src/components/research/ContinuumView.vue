<script setup lang="ts">
import { renderM27TractSvg } from '@/vendor/m27-tract-studio/tract-renderer.js';
import { sendWorkspaceAudio, takeWorkspaceAudio } from '@/data/workspace-transfer';
import { denoiseFile } from '@/data/denoise';
import { VOQS_PROFILES, voqsProfile } from '@/data/voqs-library';
import { M27Adapter } from '@vocalcut/model-adapters';
import {
  alignEndpointTimings, buildOutputAnnotation, cellMovie, CONTINUUM_GAP_S, endpointDuration, endpointSelections, inspectWavHeader, interpolatePose, joinContinuumAudio,
  needsContinuumAnalysis, originalEndpointAudio, peakContinuumWav, received, referenceFramesFromM27, representativeContinuumPose, resolveContinuumSource,
  sourceControls, sourceTrajectory, timeWarp, validPose, type ContinuumEndpointSource, type RenderedCell, type WavHeaderSummary,
} from './continuum-media';
import { createContinuumPlayback, type ContinuumPlaybackPart } from './continuum-playback';
import { useContinuumViewport } from './continuum-viewport';
import { paintReferenceFrame } from '@/data/reference-geometry';
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
import IconSvg from '@/components/common/IconSvg.vue';
import SplitPane from '@/components/common/SplitPane.vue';
import {
  blobToBase64,
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
  {value:'audio',label:'标注或重建音段'},
];

const presetOptions: ReadonlyArray<SelectOption<string>> = PRESET_ENDPOINT_DEFS.map((p) => ({
  value: p.id,
  label: p.label,
}));

const phonemeOptions: ReadonlyArray<SelectOption<string>> = QUICK_IPA_ITEMS.map((q) => ({
  value: q.symbol,
  label: `[${q.symbol}] ${q.nameZh}`,
}));

type AxisKind = 'mix' | 'f0' | 'phonation' | 'duration' | 'pressure' | TractParamName;
const axisOptions: ReadonlyArray<SelectOption<AxisKind>> = [
  { value: 'mix', label: '端点 A → B 混合' },
  { value: 'f0', label: '基频 F0' },
  { value: 'phonation', label: '发声类型' },
  { value: 'duration', label: '时长' },
  { value: 'pressure', label: '声门下压' },
  ...VTL_PARAM_META.filter(param => param.key !== 'TRX' && param.key !== 'TRY').map(param => ({ value: param.key, label: param.label })),
];

const srcA = ref<EndpointSource>(endpointSelections.A);
const presetA = ref('i_high');
const phonemeA = ref('i');

const srcB = ref<EndpointSource>(endpointSelections.B);
const presetB = ref('u_back');
const phonemeB = ref('u');
watch([srcA, srcB], ([a, b]) => {
  endpointSelections.A = a;
  endpointSelections.B = b;
});
const audioA = computed(() => srcA.value === 'audio' ? received.A : null);
const audioB = computed(() => srcB.value === 'audio' ? received.B : null);
const alignment = computed(() => alignEndpointTimings(audioA.value, audioB.value));
const cleaningSide = ref<'A' | 'B' | null>(null);

function uploadEndpoint(side: 'A' | 'B', event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  received[side] = { file, label: file.name };
  if (side === 'A') srcA.value = 'audio';
  else srcB.value = 'audio';
}
async function toggleEndpointNoise(side: 'A' | 'B') {
  const source = received[side];
  if (!source || cleaningSide.value) return;
  const original = originalEndpointAudio.get(source.file);
  if (original) { received[side] = original; return; }
  cleaningSide.value = side;
  try {
    const file = await denoiseFile(source.file);
    if (received[side] === source) {
      originalEndpointAudio.set(file, source);
      received[side] = { file, label: file.name, clip: source.clip, textGrid: source.textGrid };
    }
  } catch (error) { store.pushToast(error instanceof Error ? error.message : String(error), 'warning'); }
  finally { cleaningSide.value = null; }
}

const horizontal = ref<AxisKind>('mix');
const vertical = ref<AxisKind>('f0');
const dualAxis = ref(false);
const sequenceSteps = ref(5);
const matrixColumns = ref(5);
const columns = computed(() => dualAxis.value ? matrixColumns.value : sequenceSteps.value);
const rows = computed(() => dualAxis.value ? 4 : 1);
const baseMix = ref(50);
const STEP_HZ = 100;
const synthesis = ref<'vtl' | 'neural'>('vtl');
type ContinuumSpeakerRefMode = 'endpoint_a' | 'endpoint_b' | 'builtin';
const speakerRefMode = ref<ContinuumSpeakerRefMode>('endpoint_a');
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
const regimeA = ref('V');
const regimeB = ref('V̤');
const regimeOptions: SelectOption<string>[] = VOQS_PROFILES.filter(profile => profile.group !== 'height')
  .map(profile => ({ value: profile.symbol, label: `${profile.symbol} · ${profile.label}` }));
const takeA = computed(() => voqsProfile(regimeA.value)?.takes[0]);
const takeB = computed(() => voqsProfile(regimeB.value)?.takes[0]);

function tractAxisSetting(meta: typeof VTL_PARAM_META[number]) {
  const min = ['TS1', 'TS2'].includes(meta.key) ? 0 : meta.key === 'TS3' ? -1 : meta.key === 'TBY' ? -3 : meta.min;
  const max = ['TCY', 'TS1', 'TS2', 'TS3'].includes(meta.key) ? 1 : meta.max;
  return [meta.key, { values: [min, max], min, max, unit: '', step: meta.step }];
}
const axisSettings = ref<Record<string, { values: number[]; min: number; max: number; unit: string; step?: number }>>({
  f0: { values: [120, 280], min: 60, max: 600, unit: 'Hz' },
  duration: { values: [250, 900], min: 80, max: 10000, unit: 'ms' },
  pressure: { values: [400, 1000], min: 0, max: 1600, unit: 'Pa' },
  ...Object.fromEntries(VTL_PARAM_META.map(tractAxisSetting)),
});
const axes = computed(() => {
  const first = { id: 'horizontal', label: dualAxis.value ? '横轴' : '变化参数', kind: horizontal.value,
    setting: axisSettings.value[horizontal.value], options: dualAxis.value ? axisOptions.filter(a => a.value !== vertical.value) : axisOptions };
  return !dualAxis.value ? [first] : [
    first,
    { id: 'vertical', label: '纵轴 · 4 格', kind: vertical.value, setting: axisSettings.value[vertical.value], options: axisOptions.filter(a => a.value !== horizontal.value) },
  ];
});
function setStepCount(event: Event) {
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
const axisError = computed(() => {
  const invalid = axes.value.find(axis => axis.setting && axis.setting.values.some(value => !Number.isFinite(value) || value < axis.setting.min || value > axis.setting.max));
  return invalid ? `${invalid.label}的端点须在 ${invalid.setting.min}–${invalid.setting.max} ${invalid.setting.unit} 内。` : '';
});
const mix = (a: number, b: number, alpha: number) => a + (b - a) * alpha;
const coefficient = (kind: AxisKind, x: number, y: number) => horizontal.value === kind ? x : dualAxis.value && vertical.value === kind ? y : null;
function valueForAxis(kind: AxisKind, alpha: number) {
  const range = axisSettings.value[kind];
  return range && !axisError.value ? mix(range.values[0], range.values[1], alpha) : null;
}
function axisValue(kind: AxisKind, x: number, y: number) {
  const alpha = coefficient(kind, x, y);
  return alpha === null ? null : valueForAxis(kind, alpha);
}
function setAxis(id: string, kind: AxisKind) {
  if (id === 'horizontal' && (!dualAxis.value || kind !== vertical.value)) horizontal.value = kind;
  if (id === 'vertical' && kind !== horizontal.value) vertical.value = kind;
}
function setDualAxis(enabled: boolean) {
  if (enabled && vertical.value === horizontal.value) vertical.value = horizontal.value === 'f0' ? 'mix' : 'f0';
  dualAxis.value = enabled;
  selectedCellKey.value = '1-1';
}
function applyParameterAxes(pose: Record<TractParamName, number>, x: number, y: number) {
  for (const axis of axes.value) {
    if (!VTL_PARAM_META.some(item => item.key === axis.kind)) continue;
    const key = axis.kind as TractParamName;
    const value = axisValue(key, x, y);
    if (value !== null) pose[key] = value;
  }
  return pose;
}
function axisBadge(kind: AxisKind, alpha: number) {
  if (kind === 'mix' || kind === 'phonation') return `${Math.round(alpha * 100)}%${kind === 'phonation' ? ' 发声类型 B' : ' B'}`;
  const value = valueForAxis(kind, alpha);
  if (value === null) return '—';
  const unit = axisSettings.value[kind].unit;
  return unit ? `${Math.round(value)} ${unit}` : `${kind} ${value.toFixed(2)}`;
};

// Parameter Locks
const lockLips = ref(false);
const lockTongueBody = ref(false);
const lockTongueTip = ref(false);
const lockVelum = ref(false);
const lockJaw = ref(false);
const equalizeDuration = ref(true);

const themeMode = computed<M27ThemeMode>(() => (store.resolvedColorMode.value === 'dark' ? 'dark' : 'light'));
const selectedCellKey = ref('1-1');
const sidebarWidth = ref(276);

// Real JD2 Batch Contours fetched via POST /api/vtl/batch-contours
interface BatchContourCellData {
  parts: TractPartsMap;
  partSizes: number[];
  nasal: number;
  lm: number[];
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
const recoveringEndpoints = computed(() => contoursSource.value === 'loading'
  && [audioA.value, audioB.value].some(source => source && needsContinuumAnalysis(source)));
const cellSvgRefs = new Map<string, SVGSVGElement>();
const view = useContinuumViewport();
const activePlaybackKey = ref('');
const playingSequence = ref(false);
let batchDebounceTimer = 0;
let batchReqSeq = 0;

function paintSingleRealHdCell(key: string, svgEl: SVGSVGElement): void {
  const hd = realContoursByKey.value[key];
  if (!hd) return;
  renderM27TractSvg(svgEl, {}, { parts: hd.parts, lm: hd.lm, nasal: hd.nasal },
    { showLabels: false, showGhost: false, theme: { anatomyBg: 'transparent' } });
  svgEl.setAttribute('viewBox', view.viewBox.value);
}

const playback = createContinuumPlayback((key, frame) => {
  const svg = cellSvgRefs.get(key);
  if (frame) {
    activePlaybackKey.value = key;
    if (svg) {
      paintReferenceFrame(svg, frame);
      svg.setAttribute('viewBox', view.viewBox.value);
    }
  } else {
    activePlaybackKey.value = '';
    if (svg) paintSingleRealHdCell(key, svg);
  }
}, () => { playingSequence.value = false; });

watch(view.viewBox, box => {
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
} {
  void ptbPresetsVersion.value;
  const spk = activeSpeaker.value;
  const incoming = src === 'audio' ? received[fallbackM27] : null;
  if (incoming) {
    const representative = representativeContinuumPose(incoming);
    return {
      label: incoming.label || incoming.file.name,
      ipa: incoming.clip?.source?.transcription ?? '',
      params: representative ? tractArray19ToRecord(representative.params) : defaultTractParams(),
      extras: cloneTractExtras(DEFAULT_TRACT_EXTRAS), f0Hz: representative?.f0Hz ?? 160,
    };
  }
  if (src === 'm27') {
    const imp = fallbackM27 === 'A' ? m27ImportedEndpointA.value : m27ImportedEndpointB.value;
    if (imp) {
      return {
        label: imp.label,
        ipa: `M27_${fallbackM27}`,
        params: { ...imp.params },
        extras: cloneTractExtras(DEFAULT_TRACT_EXTRAS),
        f0Hz: imp.f0Hz,
      };
    }
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
    };
  }
  const found = presetEndpoints.value.find((p) => p.id === presetId) ?? presetEndpoints.value[0];
  return {
    label: found.label,
    ipa: found.ipa,
    params: { ...found.pose },
    extras: cloneTractExtras(found.extras),
    f0Hz: found.f0Hz,
  };
}

const endpointA = computed(() => resolveEndpoint(srcA.value, presetA.value, phonemeA.value, 'A'));
const endpointB = computed(() => resolveEndpoint(srcB.value, presetB.value, phonemeB.value, 'B'));
const endpointPanels = [
  { side: 'A', source: srcA, preset: presetA, phoneme: phonemeA, pose: endpointA, audio: audioA, imported: m27ImportedEndpointA },
  { side: 'B', source: srcB, preset: presetB, phoneme: phonemeB, pose: endpointB, audio: audioB, imported: m27ImportedEndpointB },
] as const;
const audioInputs: Record<'A' | 'B', HTMLInputElement | null> = { A: null, B: null };

function applyLocks(a: Record<TractParamName, number>, interp: Record<TractParamName, number>): Record<TractParamName, number> {
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

const continuumManifest = computed(() => {
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
    dim2: { kind: 'phonation', regime_a: voqsProfile(regimeA.value)?.legacy ?? 'modal', regime_b: voqsProfile(regimeB.value)?.legacy ?? 'breathy' },
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
  hasRealHd: boolean;
}

const matrixCells = computed<GridCellView[]>(() => {
  const manifest = continuumManifest.value;
  if (!manifest) return [];
  const realMap = realContoursByKey.value;
  const cells: GridCellView[] = [];
  for (let ib = 1; ib <= manifest.steps_b; ib++) {
    for (let ia = 1; ia <= manifest.steps_a; ia++) {
      const raw = manifest.cells.find((c) => c.step_a === ia && c.step_b === ib);
      if (!raw) continue;
      const key = `${ia}-${ib}`;
      const blend = coefficient('mix', raw.alpha_a, raw.alpha_b) ?? baseMix.value / 100;
      const a = tractRecordToArray19(endpointA.value.params);
      const b = tractRecordToArray19(endpointB.value.params);
      const baseRec = tractArray19ToRecord(a.map((value, i) => mix(value, b[i], blend)));
      const lockedRec = applyParameterAxes(applyLocks(endpointA.value.params, baseRec), raw.alpha_a, raw.alpha_b);
      const cellExtras = interpolateExtras(endpointA.value.extras, endpointB.value.extras, blend);
      const real = realMap[key];
      const f0Hz = Math.round(axisValue('f0', raw.alpha_a, raw.alpha_b) ?? mix(endpointA.value.f0Hz, endpointB.value.f0Hz, blend));
      const millis = axisValue('duration', raw.alpha_a, raw.alpha_b);
      const durationS = millis === null ? null : millis / 1000;
      const pressurePa = axisValue('pressure', raw.alpha_a, raw.alpha_b);
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
        hasRealHd: Boolean(real),
      });
    }
  }
  return cells;
});

const selectedCell = computed(() => matrixCells.value.find((c) => c.key === selectedCellKey.value) ?? matrixCells.value[0] ?? null);
const measuredCell = computed(() => matrixCells.value.find(cell => cell.key === activePlaybackKey.value) ?? selectedCell.value);
const sameEndpointTrack = computed(() => {
  if (!audioA.value || !audioB.value || !axes.value.some(axis => axis.kind === 'mix')) return false;
  const a = sourceTrajectory(audioA.value), b = sourceTrajectory(audioB.value);
  return a.length > 0 && a.length === b.length && a.every((frame, i) => Math.abs(frame.u - b[i].u) < 1e-6
    && frame.params.every((value, j) => Math.abs(value - b[i].params[j]) < 1e-6));
});

function paintAllRealHdCells(): void {
  for(const [key,svg] of cellSvgRefs)paintSingleRealHdCell(key,svg);
}

let batchAbort: AbortController | null = null;
let cellAbort: AbortController | null = null;

async function fetchBatchHdContours(): Promise<void> {
  const seq = ++batchReqSeq;
  batchAbort?.abort();
  batchAbort = new AbortController();
  const signal = batchAbort.signal;
  try {
    const incoming = [['A', audioA.value], ['B', audioB.value]] as const;
    const pending = incoming.filter(([, source]) => source && needsContinuumAnalysis(source));
    if (pending.length) {
      const repaired = await Promise.all(pending.map(async ([side, source]) => ({
        side, source, updated: await resolveContinuumSource(source!, store.computeDevice.value),
      })));
      if (signal.aborted || seq !== batchReqSeq) return;
      for (const { side, source, updated } of repaired) if (received[side] === source) received[side] = updated;
      return;
    }
    const cells = matrixCells.value;
    if (!cells.length) return;
    const poses = cells.map((c) => tractRecordToArray19(c.params));
    const resp = await fetch('/api/vtl/batch-contours', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      body: JSON.stringify({
        speaker: normalizeFactorySpeaker(activeSpeaker.value),
        poses,
        lip_width_frames: cells.map((c) => c.extras.lip_width),
        larynx_height_frames: cells.map((c) => c.extras.larynx_height),
        tongue_shape_frames: cells.map((c) => c.extras.tongue_shape),
        lip_shape_frames: cells.map((c) => c.extras.lip_shape),
        manual_root_frames: cells.map((c) => c.extras.manual_root),
      }),
    });
    if (seq !== batchReqSeq) return;
    const data = (await resp.json()) as BatchContoursApiResponse;
    if (seq !== batchReqSeq) return;
    if (!resp.ok || !data.ok || !Array.isArray(data.parts) || !Array.isArray(data.part_sizes) || !Array.isArray(data.items)) {
      throw new Error(data.error?.hint ?? '未取得声道轮廓，请检查本地引擎连接。');
    }
    const nextMap: Record<string, BatchContourCellData> = {};
    cells.forEach((cell, idx) => {
      const item = data.items?.[idx];
      if (!item || !Array.isArray(item.pts)) return;
      nextMap[cell.key] = {
        parts: splitM27TractParts(item.pts, data.parts, data.part_sizes),
        partSizes: data.part_sizes!,
        nasal: item.nasal ?? 0,
        lm: item.lm ?? [],
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
    if (seq === batchReqSeq) {
      contoursSource.value = 'fallback';
      contoursError.value = error instanceof Error ? error.message : '未取得声道轮廓';
    }
  }
}

function scheduleBatchContoursFetch(): void {
  window.clearTimeout(batchDebounceTimer);
  batchReqSeq++;
  realContoursByKey.value = {};
  contoursSource.value = 'loading';
  contoursError.value = '';
  batchDebounceTimer = window.setTimeout(() => {
    void fetchBatchHdContours();
  }, 120);
}

watch(
  [
    srcA,
    presetA,
    phonemeA,
    srcB,
    presetB,
    phonemeB,
    horizontal,
    vertical,
    dualAxis,
    columns,
    axisSettings,
    baseMix,
    audioA,
    audioB,
    lockLips,
    lockTongueBody,
    lockTongueTip,
    lockVelum,
    lockJaw,
    equalizeDuration,
    m27ImportedEndpointA,
    m27ImportedEndpointB,
    ptbPresetsVersion,
    activeSpeaker,
  ],
  () => {
    scheduleBatchContoursFetch();
  },
  { deep: true },
);

watch(activeSpeaker, (spk) => {
  void preloadPtbIpaPresets(spk);
});
watch(store.computeDevice, scheduleBatchContoursFetch);
watch(store.engineStatus, (status) => {
  if (status === 'python-vtl' && contoursSource.value === 'fallback') scheduleBatchContoursFetch();
});

watch([themeMode, store.paletteId, store.customAccentHex, store.anatomyAppearance], () => {
  void nextTick(() => paintAllRealHdCells());
});

onMounted(() => {
  void preloadPtbIpaPresets(activeSpeaker.value);
  void fetchBatchHdContours();
});

onBeforeUnmount(() => {
  batchReqSeq++;
  batchAbort?.abort();
  renderVersion.value++;
  cellAbort?.abort();
  rendered.clear();
  window.clearTimeout(batchDebounceTimer);
});

const rendered = new Map<string, Promise<RenderedCell>>();
const renderedWavMeta = ref<Record<string, WavHeaderSummary & { filename: string }>>({});
const rendering = ref('');
const controlsBusy = computed(() => Boolean(rendering.value || recoveringEndpoints.value || axisError.value));
const renderVersion = ref(0);
const lastSequenceAudio = shallowRef<AudioBuffer | null>(null);
const lastSequenceParts = shallowRef<Array<{ key: string; start_s: number; end_s: number }> | undefined>(undefined);
watch([endpointA, endpointB, horizontal, vertical, dualAxis, columns, axisSettings, baseMix, synthesis, speakerRefMode, regimeA, regimeB, lockLips, lockTongueBody, lockTongueTip, lockVelum, lockJaw, equalizeDuration, activeSpeaker, store.computeDevice], () => {
  cellAbort?.abort();
  cellAbort = new AbortController();
  rendered.clear();
  renderedWavMeta.value = {};
  lastSequenceAudio.value = null;
  lastSequenceParts.value = undefined;
  renderVersion.value++;
  playback.stop();
}, { deep: true });

function checkEndpoint(mode: EndpointSource, data: typeof audioA.value, imp: typeof m27ImportedEndpointA.value, name: string) {
  if (mode === 'audio' && !data) throw new Error(`请提供端点 ${name} 的音频。`);
  if (mode === 'm27' && !imp) throw new Error(`请先从声道重建发送端点 ${name} 的当前帧。`);
}

async function prepareCell(cell: GridCellView): Promise<RenderedCell> {
  if (axisError.value) throw new Error(axisError.value);
  const existing = rendered.get(cell.key);
  if (existing) return existing;
  const a = audioA.value, b = audioB.value;
  const leftEndpoint = endpointA.value, rightEndpoint = endpointB.value;
  const synth = synthesis.value;
  const equalize = equalizeDuration.value;
  const speaker = activeSpeaker.value;
  const version = renderVersion.value;
  cellAbort ??= new AbortController();
  const signal = cellAbort.signal;
  const job = (async () => {
    checkEndpoint(srcA.value, a, m27ImportedEndpointA.value, 'A');
    checkEndpoint(srcB.value, b, m27ImportedEndpointB.value, 'B');
    const [resolvedA, resolvedB, wholeA, wholeB] = await Promise.all([
      a ? resolveContinuumSource(a, store.computeDevice.value) : null,
      b ? resolveContinuumSource(b, store.computeDevice.value) : null, endpointDuration(a), endpointDuration(b),
    ]);
    if (version !== renderVersion.value) throw new Error('端点配置已更新，请重新生成。');
    const selectedAlignment = alignEndpointTimings(resolvedA, resolvedB);
    const durationA = wholeA;
    const durationB = wholeB;
    const alpha = cell.blend;
    const duration = cell.durationS ?? (equalize ? Math.max(durationA, durationB) : mix(durationA, durationB, alpha));
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('端点时长无效。');
    if (duration > 10) throw new Error('请选用 10 秒以内的端点，或使用时长轴指定输出时长。');
    const stride = synth === 'neural' ? 2 : 1;
    const frameCount = Math.max(2, Math.round(duration * STEP_HZ / stride)) * stride;
    const p = resolvedA ? sourceTrajectory(resolvedA, wholeA) : [{ u: 0, params: tractRecordToArray19(leftEndpoint.params) }];
    const q = resolvedB ? sourceTrajectory(resolvedB, wholeB) : [{ u: 0, params: tractRecordToArray19(rightEndpoint.params) }];
    if (!p.length || !q.length) throw new Error('本地模型没有返回可用的端点轨迹。');
    const warp = timeWarp(selectedAlignment, alpha);
    const times = Array.from({ length: frameCount }, (_, i) => warp(i / frameCount));
    const poses = times.map(([atA, atB]) => {
      const left = interpolatePose(p, atA), right = interpolatePose(q, atB);
      const blended = tractArray19ToRecord(left.map((v, j) => mix(v, right[j], alpha)));
      return tractRecordToArray19(applyParameterAxes(applyLocks(tractArray19ToRecord(left), blended), cell.alphaA, cell.alphaB));
    });
    const phonation = coefficient('phonation', cell.alphaA, cell.alphaB);
    const modal = PHONATION_M27_ANCHORS.modal;
    const g = interpolateGlottis10D(phonation === null ? modal : takeA.value?.glottis ?? modal,
      takeB.value?.glottis ?? PHONATION_M27_ANCHORS.breathy, phonation ?? 0);
    if (!g.ok) throw new Error('发声类型参数无效。');
    const gl = g.value;
    const baseGlottis = [gl.xb_cm, gl.xt_cm, gl.ca_cm2, gl.lag_rad, gl.ra, gl.ps, gl.fl, gl.shim];
    const controls = times.map(([atA, atB]) => {
      const left = sourceControls(resolvedA, wholeA, atA);
      const right = sourceControls(resolvedB, wholeB, atB);
      const pitchA = left && left[17] >= 60 ? left[17] : leftEndpoint.f0Hz;
      const pitchB = right && right[17] >= 60 ? right[17] : rightEndpoint.f0Hz;
      const f0 = axisValue('f0', cell.alphaA, cell.alphaB) ?? mix(pitchA, pitchB, alpha);
      const pressure = cell.pressurePa ?? (phonation === null ? mix(left?.[18] ?? gl.pr_pa, right?.[18] ?? gl.pr_pa, alpha) : gl.pr_pa);
      const glottis = phonation !== null ? baseGlottis : baseGlottis.map((value, column) => mix(left?.[column + 19] ?? value, right?.[column + 19] ?? value, alpha));
      return { f0, pressure, glottis };
    });
    const trajectory = poses.map((params, i) => ({ u: i / frameCount, params }));
    trajectory.push({ u: 1, params: poses[poses.length - 1] });
    if (synth === 'neural') {
      const spkChoice = resolveUniformSpeakerRef(a, b, speakerRefMode.value);
      const speakerRef = spkChoice.file;
      const rows = poses.flatMap((pose, i) => i % 2 ? [] : [[...pose.slice(0, 14), ...pose.slice(16), controls[i].f0, controls[i].pressure, ...controls[i].glottis]]);
      const result = await new M27Adapter().resynthesize({ m27_50hz_pa: rows, synth_mode: 'neural', compute_device: store.computeDevice.value,
        audio_gain: 'original',
        speaker_ref_wav_base64: speakerRef ? await blobToBase64(speakerRef) : undefined, speaker_ref_filename: speakerRef?.name, signal });
      if (!result.ok) throw new Error(result.error.hint);
      if (version !== renderVersion.value) throw new Error('端点配置已更新，请重新生成。');
      const data = result.value;
      if (!data.neural_16k_wav_base64 || !data.tract_glottis_anim?.frames.length) throw new Error('神经声码器没有返回音频或构型帧。');
      const wavBytes = Uint8Array.from(atob(data.neural_16k_wav_base64), c => c.charCodeAt(0));
      const wav = new File([wavBytes], cell.filename, { type: 'audio/wav' });
      const header = inspectWavHeader(wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength));
      if (header) renderedWavMeta.value = { ...renderedWavMeta.value, [cell.key]: { ...header, filename: cell.filename } };
      const length = header?.durationS ?? rows.length / 50;
      return { wav, frames: referenceFramesFromM27(data.tract_glottis_anim, trajectory), duration: length, trajectory,
        clip: buildOutputAnnotation(selectedAlignment, alpha, Math.round(length * SAMPLE_RATE_HZ), trajectory) };
    }
    const response = await fetch('/api/vtl/synthesize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
      body: JSON.stringify({
        speaker, step_hz: STEP_HZ, fps: 25, tract_frames: poses, audio_gain: 'original',
        f0_hz: controls.map(frame => frame.f0), pressure_pa: controls.map(frame => frame.pressure),
        glottis_frames: controls.map(frame => frame.glottis), per_frame_shimmer: true,
        lip_width_frames: poses.map(() => cell.extras.lip_width),
        larynx_height_frames: poses.map(() => cell.extras.larynx_height),
        tongue_shape_frames: poses.map(() => cell.extras.tongue_shape),
        lip_shape_frames: poses.map(() => cell.extras.lip_shape),
        manual_root_frames: poses.map(() => cell.extras.manual_root),
        shimmer: gl.shim, flutter: gl.fl,
      }),
    });
    const result = await response.json();
    if (version !== renderVersion.value) throw new Error('端点配置已更新，请重新生成。');
    if (!response.ok || !result.ok || !result.wav_base64 || !result.geometry_frames?.length) {
      throw new Error(result.error?.hint ?? '声道引擎未生成音频和构型帧。');
    }
    const wavBytes = Uint8Array.from(atob(result.wav_base64), c => c.charCodeAt(0));
    const wav = new File([wavBytes], cell.filename, { type: 'audio/wav' });
    const header = inspectWavHeader(wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength));
    if (header) renderedWavMeta.value = { ...renderedWavMeta.value, [cell.key]: { ...header, filename: cell.filename } };
    const durationSmp = Math.round(result.duration_s * SAMPLE_RATE_HZ);
    return {
      wav, frames: result.geometry_frames, duration: result.duration_s, trajectory,
      clip: buildOutputAnnotation(selectedAlignment, alpha, durationSmp, trajectory),
    };
  })();
  rendered.set(cell.key, job);
  try {
    return await job;
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

onMounted(() => {
  window.addEventListener('vocalcut:tour-action', handleContinuumTourAction);
});

onBeforeUnmount(() => {
  mounted = false;
  window.removeEventListener('vocalcut:tour-action', handleContinuumTourAction);
  continuumTourAbort?.abort();
  continuumTourAbort = null;
  playback.stop();
});
async function cellAction(cell: GridCellView, dest: 'play' | 'studio' | 'annotation' | 'wav' | 'video') {
  if (controlsBusy.value) return;
  const version = renderVersion.value;
  const isCurrent = () => mounted && version === renderVersion.value && selectedCellKey.value === cell.key;
  selectedCellKey.value = cell.key;
  rendering.value = cell.key;
  const peak = synthesisGainMode.value === 'peak';
  try {
    const ctx = dest === 'play' ? studioAudioContext() : null;
    if (ctx) { playback.stop(); await ctx.resume(); }
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
        if (hdr) renderedWavMeta.value = { ...renderedWavMeta.value, [cell.key]: { ...hdr, filename: cell.filename } };
      }
      if (dest === 'studio' || dest === 'annotation') {
        sendWorkspaceAudio(dest, { file: wav, label: `连续统 ${cell.key}`, clip: result.clip, frames: result.trajectory });
        return;
      }
      const targetName = dest === 'wav' ? cell.filename : cell.filename.replace(/\.wav$/i, '.webm');
      const blob = dest === 'wav' ? wav : await cellMovie({ ...result, wav });
      if (isCurrent()) triggerDownload(blob, targetName);
    }
  } catch (error) {
    if (isCurrent()) store.pushToast(error instanceof Error ? error.message : String(error), 'warning');
  } finally {
    rendering.value = '';
  }
}
function auditionCell(cell: GridCellView) { void cellAction(cell, 'play'); }
async function renderSequence(play: boolean) {
  if (play && playingSequence.value) { playback.stop(); return; }
  if (controlsBusy.value || !matrixCells.value.length) return;
  const cells = [...matrixCells.value];
  const version = renderVersion.value;
  const current = () => mounted && version === renderVersion.value;
  const peak = synthesisGainMode.value === 'peak';
  rendering.value = `1 / ${cells.length}`;
  try {
    const ctx = play ? studioAudioContext() : null;
    if (ctx) { playback.stop(); await ctx.resume(); }
    const results: RenderedCell[] = [];
    for (const [index, cell] of cells.entries()) {
      if (!current()) return;
      rendering.value = `${index + 1} / ${cells.length}`;
      results.push(await prepareCell(cell));
    }
    if (!current()) return;
    if (ctx) {
      const buffers = await Promise.all(results.map(async ({ wav }) => ctx.decodeAudioData(await wav.arrayBuffer())));
      if (!current()) return;
      const buffer = joinContinuumAudio(ctx, buffers);
      if (peak) applyPeakAudioGain(buffer);
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
      lastSequenceParts.value = parts.map((p) => ({ key: p.key, start_s: p.startS, end_s: p.endS }));
      playback.start(ctx, buffer, parts);
      playingSequence.value = true;
    } else {
      store.pushToast(`已合成全部 ${cells.length} 格`, 'success');
    }
  } catch (error) {
    if (current()) store.pushToast(error instanceof Error ? error.message : String(error), 'warning');
  } finally {
    rendering.value = '';
  }
}
function exportStimulusPackage(): void {
  const manifest = continuumManifest.value;
  if (!manifest || axisError.value) return;
  const spkChoice = resolveUniformSpeakerRef(audioA.value, audioB.value, speakerRefMode.value);
  const bundle = {
    schema: 'vocalcut/continuum-stimulus-pack',
    generated_at: new Date().toISOString(),
    compute_device: store.computeDevice.value,
    geometry_source: contoursSource.value,
    project_timebase_hz: SAMPLE_RATE_HZ,
    stimulus_sample_rate_hz: stimulusSampleRateHz.value,
    axes: axes.value.map(axis => ({ dimension: axis.id, kind: axis.kind, values: axis.setting?.values, unit: axis.setting?.unit })),
    synthesis: synthesis.value,
    speaker_reference:
      synthesis.value === 'neural'
        ? {
            mode: speakerRefMode.value,
            effective_source: spkChoice.sourceSide,
            filename: spkChoice.file?.name ?? null,
          }
        : null,
    phonation: [{ symbol: regimeA.value, source: takeA.value?.id }, { symbol: regimeB.value, source: takeB.value?.id }],
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
      cells: manifest.cells.map(({ f0_target: _target, ...cell }) => {
        const view = matrixCells.value.find(item => item.stepA === cell.step_a && item.stepB === cell.step_b);
        return {
          ...cell,
          extras: view ? cloneTractExtras(view.extras) : undefined,
          landmarks: view
            ? cell.landmarks.map(landmark => ({ ...landmark, params: tractRecordToArray19(view.params) }))
            : cell.landmarks,
        };
      }),
    },
    acoustic_table: matrixCells.value.map((c) => {
      const actualWav = renderedWavMeta.value[c.key];
      const sr = actualWav?.sampleRateHz ?? stimulusSampleRateHz.value;
      const durMs = actualWav ? Math.round(actualWav.durationS * 1000) : c.durationS == null ? undefined : Math.round(c.durationS * 1000);
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
  downloadTextFile(`continuum_${manifest.cells.length}_${Date.now()}.json`, JSON.stringify(bundle, null, 2));
  store.pushToast(`已导出 ${manifest.cells.length} 格连续统实验参数`, 'success');
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
    <!-- Left Sidebar: Independent Endpoint A / B Sources + Parameter Locks + Compute Device -->
    <aside class="panel cont-left">
      <div class="p-head">
        <span>生理连续统配置</span>
        <div style="display: inline-flex; align-items: center; gap: 6px">
          <span class="tree-tag">{{ dualAxis ? `${columns} × 4 格` : `${columns} 格` }}</span>
          <ModuleGuideButton module-id="continuum" size="xs" />
        </div>
      </div>
      <div class="p-body cont-left-body">
        <div class="cont-endpoints-group" data-tour="continuum-endpoints">
          <section v-for="panel in endpointPanels" :key="panel.side" class="cont-endpoint" :aria-label="`端点 ${panel.side}`">
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
          <div v-else-if="panel.audio.value || (panel.source.value === 'm27' && panel.imported.value)"
            class="cont-endpoint-name" :title="panel.pose.value.label">
            {{ panel.pose.value.label }}
          </div>
          <small v-else class="muted">从标注或声道重建发送{{ panel.source.value === 'm27' ? '构型帧' : '音段' }}</small>
          <div class="cont-endpoint-actions">
            <button type="button" class="btn xs" :aria-label="`导入端点 ${panel.side} 音频`" @click="audioInputs[panel.side]?.click()">
              <IconSvg name="upload" :size="12" />导入音频
            </button>
            <button v-if="panel.audio.value" type="button" class="btn xs" :disabled="!!cleaningSide" @click="toggleEndpointNoise(panel.side)">
              {{ cleaningSide === panel.side ? '降噪中…' : originalEndpointAudio.has(panel.audio.value.file) ? '恢复原音' : '降噪' }}
            </button>
            <input :ref="(element) => audioInputs[panel.side] = element as HTMLInputElement | null"
              :aria-label="`端点 ${panel.side} 音频`" type="file" accept="audio/*" hidden @change="uploadEndpoint(panel.side, $event)" />
          </div>
        </section>
        </div>

        <div class="cont-config-section" data-tour="continuum-axes">
          <div class="cont-section-head">
            <strong>变化参数</strong>
            <label class="cont-check"><input type="checkbox" :checked="dualAxis" @change="setDualAxis(($event.target as HTMLInputElement).checked)" />启用第二维度</label>
          </div>
          <label class="cont-step-field">{{ dualAxis ? '横轴格数' : '序列格数' }}
            <input type="number" class="inp mono" aria-label="连续统格数" min="2" :max="dualAxis ? 16 : 51" step="1"
              :value="columns" @change="setStepCount" />
          </label>
          <div v-for="axis in axes" :key="axis.id" class="continuum-axis">
            <span v-if="dualAxis" class="muted">{{ axis.label }}</span>
            <CustomSelect :aria-label="axis.label" :model-value="axis.kind" :options="axis.options" size="sm" style="width: 100%" @update:model-value="value => setAxis(axis.id, value as AxisKind)" />
            <div v-if="axis.setting" class="axis-endpoints">
              <label>起点 <input v-model.number="axis.setting.values[0]" type="number" class="inp" :aria-label="axis.label + '起点'" :min="axis.setting.min" :max="axis.setting.max" :step="axis.setting.step ?? 1" /></label>
              <label>终点 <input v-model.number="axis.setting.values[1]" type="number" class="inp" :aria-label="axis.label + '终点'" :min="axis.setting.min" :max="axis.setting.max" :step="axis.setting.step ?? 1" /></label>
              <span>{{ axis.setting.unit }}</span>
            </div>
            <div v-else-if="axis.kind === 'phonation'" class="axis-endpoints">
              <label>起点 <CustomSelect v-model="regimeA" :options="regimeOptions" size="sm" /></label>
              <label>终点 <CustomSelect v-model="regimeB" :options="regimeOptions" size="sm" /></label>
            </div>
          </div>
          <label v-if="!axes.some(axis => axis.kind === 'mix')" class="cont-note">固定端点 B 权重 {{ baseMix }}% <input v-model.number="baseMix" type="range" min="0" max="100" /></label>
          <p v-if="axisError" class="cont-note" role="alert">{{ axisError }}</p>
        </div>

        <div class="cont-config-section" data-tour="continuum-locks">
          <div class="cont-section-head">
            <strong>构音参数锁定</strong>
            <span class="muted">保持端点 A</span>
          </div>
          <div class="cont-lock-list">
            <label class="cont-check" title="LP / LD"><input v-model="lockLips" type="checkbox" />唇部</label>
            <label class="cont-check" title="TCX / TCY"><input v-model="lockTongueBody" type="checkbox" />舌背</label>
            <label class="cont-check" title="TTX / TTY"><input v-model="lockTongueTip" type="checkbox" />舌尖</label>
            <label class="cont-check" title="VO / VS"><input v-model="lockVelum" type="checkbox" />软腭鼻化</label>
            <label class="cont-check" title="JA / JX"><input v-model="lockJaw" type="checkbox" />下颌开口</label>
          </div>
        </div>
        <div class="cont-config-section">
          <label class="cont-check"><input v-model="equalizeDuration" type="checkbox" />端点等时长对齐</label>
          <p class="cont-note">{{ alignment.message }}</p>
        </div>

        <div class="cont-config-section">
          <div class="cont-section-head"><strong>合成与导出</strong></div>
          <CustomSelect v-model="synthesis" aria-label="连续统合成方式" size="sm" style="width: 100%"
            :options="[{ value: 'neural', label: voiceRenderLabels.neural }, { value: 'vtl', label: voiceRenderLabels.physical }]" />
          <CustomSelect
            v-if="synthesis === 'neural' && (audioA || audioB)"
            v-model="speakerRefMode"
            aria-label="神经连续统参考声纹"
            size="sm"
            style="width: 100%"
            :options="speakerRefOptions"
          />
          <button type="button" class="btn sm primary" style="width: 100%" @click="exportStimulusPackage">
            <IconSvg name="download" :size="12" />
            <span>导出实验参数 JSON</span>
          </button>
        </div>
      </div>
    </aside>

    <SplitPane v-model="sidebarWidth" direction="vertical" :min="232" :max="520" :default-value="276" storage-key="research-continuum" />

    <section class="panel cont-main">
      <div class="p-head">
        <span class="cont-head-title">
          {{ matrixCells.length }} 格生理连续统（<span class="cont-ep-lbl notranslate" translate="no">{{ endpointA.label }}</span> → <span class="cont-ep-lbl notranslate" translate="no">{{ endpointB.label }}</span>）
        </span>
        <div v-if="selectedCell" class="cont-sel-info mono">
          <span class="tree-tag">{{ recoveringEndpoints ? '正在重新分析端点…' : contoursSource === 'vtl-hd' ? activeSpeaker + ' 真实声道轮廓' : contoursSource === 'loading' ? '轮廓加载中…' : '声道轮廓未就绪' }}</span>
          <span v-if="measuredCell" class="metric-chip">{{ dualAxis ? `格 A${measuredCell.stepA}·B${measuredCell.stepB}` : `第 ${measuredCell.stepA} 格` }}</span>
          <span class="metric-chip" title="代表构型的 VTL 传递函数峰">F1 {{ measuredCell?.metrics?.f1_hz || '—' }} · F2 {{ measuredCell?.metrics?.f2_hz || '—' }} Hz</span>
          <span class="metric-chip">Amin {{ measuredCell?.metrics?.amin_cm2.toFixed(2) ?? '—' }} cm²</span>
          <button type="button" class="btn xs primary" :disabled="controlsBusy" @click="auditionCell(selectedCell)">
            <IconSvg name="play" :size="11" />
            <span>试听当前格</span>
          </button>
        </div>
      </div>

      <div v-if="selectedCell" class="cont-actions" data-tour="continuum-actions">
        <button class="btn xs" :disabled="controlsBusy" @click="renderSequence(false)">合成全部</button>
        <button class="btn xs" :disabled="controlsBusy && !playingSequence" @click="renderSequence(true)">
          {{ playingSequence ? '停止序列' : '试听当前序列' }}
        </button>
        <button class="btn xs" :disabled="controlsBusy" @click="cellAction(selectedCell, 'annotation')">送到标注</button>
        <button class="btn xs" :disabled="controlsBusy" @click="cellAction(selectedCell, 'studio')">送到剪辑</button>
        <button class="btn xs" :disabled="controlsBusy" @click="cellAction(selectedCell, 'wav')">下载音频</button>
        <button class="btn xs" :disabled="controlsBusy" @click="cellAction(selectedCell, 'video')">下载声道视频</button>
        <span class="cont-view-tools">
          <button class="btn xs" aria-label="缩小格子声道" @click="view.zoomBy(1 / 1.15)">−</button>
          <button class="btn xs" aria-label="放大格子声道" @click="view.zoomBy(1.15)">+</button>
          <button class="btn xs" title="复位所有格子的缩放和平移" @click="view.reset()">复位视口</button>
        </span>
        <span v-if="rendering" role="status">正在处理 {{ rendering }}</span>
      </div>
      <div v-if="sameEndpointTrack" class="cont-actions muted">两端的声道轨迹相同。</div>
      <div v-if="contoursError" class="cont-actions" role="status">
        <span>{{ contoursError }}</span>
        <button type="button" class="btn xs" @click="scheduleBatchContoursFetch">重试轮廓</button>
      </div>
      <div class="p-body cont-matrix-body" data-tour="continuum-grid">
        <div class="cont-grid" :class="{ 'single-axis': !dualAxis }" :style="{ '--continuum-cols': dualAxis ? columns : Math.min(5, columns), '--continuum-rows': rows }">
          <button
            v-for="cell in matrixCells"
            :key="cell.key"
            type="button"
            class="cont-cell sci-plane"
            :class="{ active: selectedCellKey === cell.key, playing: activePlaybackKey === cell.key }"
            :title="dualAxis ? `合成试听第 ${cell.stepA} 列 · 第 ${cell.stepB} 行` : `合成试听第 ${cell.stepA} 格`"
            :disabled="controlsBusy"
            @click="!view.consumeDragClick() && auditionCell(cell)"
          >
            <div class="cc-top mono">
              <span>{{ dualAxis ? `${cell.stepA} · ${cell.stepB}` : cell.stepA }}</span>
              <span class="cc-dim2">{{ cell.axisBadge }}</span>
            </div>

            <!-- Real JD2 Tightly-Cropped Tract-Only HD Vector (NO outer head contour!) -->
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

            <!-- Offline Fallback Tract-Only Silhouette (only when /api/vtl/batch-contours is unreachable) -->
            <div v-else class="cc-placeholder">{{contoursSource==='loading'?'正在载入声道轮廓':'声道几何未就绪'}}</div>

            <div class="cc-foot mono muted">
              <span>F1 {{ cell.metrics?.f1_hz || '—' }}</span>
              <span>F2 {{ cell.metrics?.f2_hz || '—' }}</span>
            </div>
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.axis-endpoints { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)) auto; align-items: end; gap: 6px; font-size: 0.916667rem; }
.axis-endpoints label { display: grid; gap: 4px; min-width: 0; }
.axis-endpoints input { width: 100%; }
.continuum-axis { display: grid; gap: 4px; }
.cont-note { margin: 0; font-size: 0.916667rem; line-height: 1.5; color: var(--muted); }
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
  gap: 10px;
  min-width: 0;
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

.cont-endpoint-head .ipa { max-width: 62%; }
.cont-endpoint-name { font-size: 0.916667rem; color: var(--muted); }
.cont-endpoint-actions { flex-wrap: wrap; }

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

.cont-check input { margin: 0; }

.cont-step-field, .cont-view-tools {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.cont-step-field { justify-content: space-between; }
.cont-step-field input { width: 5em; }
.cont-view-tools { padding-left: 6px; border-left: 1px solid var(--border); }

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

.cont-matrix-body {
  padding: 8px;
  display: flex;
  flex-direction: column;
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
  grid-auto-rows: clamp(180px, 22vw, 320px);
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
  transition: border-color 0.12s, box-shadow 0.12s, transform 0.08s;
}

.cont-cell:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}

.cont-cell.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--selection);
}
.cont-cell.playing { border-color: var(--success); box-shadow: 0 0 0 2px var(--success); }

.cc-top,
.cc-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.791667rem;
  flex: none;
}

.cc-top {
  font-weight: 700;
  color: var(--text);
}

.cc-dim2 {
  color: var(--accent);
}

.cc-tract-svg {
  flex: 1;
  width: 100%;
  min-height: 64px;
  display: block;
  border-radius: 3px;
  touch-action: none;
  cursor: grab;
}
.cc-tract-svg.dragging { cursor: grabbing; }

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
.cc-placeholder{margin:auto;color:var(--muted);font-size:0.916667rem}.cont-actions{display:flex;align-items:center;gap:6px;padding:5px 10px;flex-wrap:wrap}
</style>
