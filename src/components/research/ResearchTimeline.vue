<script setup lang="ts">
import { phoneTraits, stripDottedCirclePlaceholders } from "@/data/ipa-segments";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import {
  PRESSURE_LIMIT_PA,
  SAMPLE_RATE_HZ,
  hzToSt,
  isValidF0Hz,
  msToSamples,
  retime,
  samplesToMs,
  stToHz,
  type F0PinSegment,
  type PhonationAnchor,
  type QtaTargetSpan,
  type RetimeResult,
  type SegmentAnchor,
  type Syllable,
} from '@vocalcut/core';
import {
  defaultTractParams,
  tractArray19ToRecord,
  tractRecordToArray19,
  useWorkbenchStore,
} from '@/stores/workbench';
import { getCurrentPageScale } from '@/styles/skin-registry';
import IconSvg from '@/components/common/IconSvg.vue';
import { sendWorkspaceAudio } from '@/data/workspace-transfer';
import { textPoseSource } from '@/data/ipa-pose-source';
import { evaluateControlPitch, setUnmarkedIpaPitchMode, unmarkedIpaPitchMode } from './control-pitch';
import { isSegmentVoicedAt } from '@/data/speech-timing';
import { buildF0CurvePaths, type F0CurvePoint } from './f0-curve-paths';
import { SYNTHESIS_VOQS_PROFILES, voqsAnchorLabel, voqsAnchorPatch, voqsLane, voqsProfile, voqsSynthesisLaneIndex } from '@/data/voqs-library';
import { writeRecordedVoqs } from './voqs-actions';
import {
  copyAnnotationSelection,
  deleteAnnotationSegments,
  getPhoneSlideBounds,
  getSyllableSlideBounds,
  insertAnnotationSegment,
  pasteAnnotationClipboard,
  resizeAnnotationSilenceGap,
  slideAnnotationPhones,
  slideAnnotationSyllables,
  spliceAnnotationPcm,
  splitAnnotationPhone,
  stopPhaseBoundaries,
  syncSyllableTextFromSegments,
  type AnnotationClipboardPayload,
} from './annotation-edit';
import KeyframePopover from './KeyframePopover.vue';
import PhonationEditor from './PhonationEditor.vue';
import {
  CORPUS_DRAG_MIME,
  buildSegmentsForSyllable,
  corpusDragFileRegistry,
  extractToneLevels,
  formatTimecode,
  replaceSegmentIpa,
  splitIpaToPhonemes,
  toneTarget,
} from './research-utils';

const store = useWorkbenchStore();
const props = defineProps<{ recordingActive?: boolean }>();

// Horizontal zoom & scroll container
const hZoom = ref(1);
const laneWidth = ref(960);
const laneScrollX = ref(0);
const headerRef = ref<HTMLDivElement | null>(null);
let widthObserver: ResizeObserver | undefined;
const lanesScrollRef = ref<HTMLDivElement | null>(null);
const zoomMin = 0.2;
const zoomMax = 5;

// Per-track vertical heights (every track has an independent bottom-edge vertical drag handle!)
const TRACK_HEIGHT_BASE = {
  textgrid: 66,
  art: 34,
  phon: 56,
  f0: 56,
  ps: 44,
  wave: 46,
} as const;
const TRACK_SCALE_FACTOR = {
  compact: 0.84,
  standard: 1,
  tall: 1.22,
} as const;

function scaledTrackHeight(base: number): number {
  const factor = TRACK_SCALE_FACTOR[store.timelineTrackScale.value] ?? 1;
  return Math.max(24, Math.round(base * factor));
}

const hTextgrid = ref(scaledTrackHeight(TRACK_HEIGHT_BASE.textgrid));
const hArt = ref(scaledTrackHeight(TRACK_HEIGHT_BASE.art));
const hPhon = ref(scaledTrackHeight(TRACK_HEIGHT_BASE.phon));
const hF0 = ref(scaledTrackHeight(TRACK_HEIGHT_BASE.f0));
const hPs = ref(scaledTrackHeight(TRACK_HEIGHT_BASE.ps));
const hWave = ref(scaledTrackHeight(TRACK_HEIGHT_BASE.wave));

const phonExpanded = ref(false);
const phonEditorOpen = ref(false);
const f0Expanded = ref(false);
const psExpanded = ref(false);
const collapsedSpecialHeights = ref<{ phon: number; f0: number; ps: number }>({
  phon: scaledTrackHeight(TRACK_HEIGHT_BASE.phon),
  f0: scaledTrackHeight(TRACK_HEIGHT_BASE.f0),
  ps: scaledTrackHeight(TRACK_HEIGHT_BASE.ps),
});

watch(
  () => store.timelineTrackScale.value,
  () => {
    hTextgrid.value = scaledTrackHeight(TRACK_HEIGHT_BASE.textgrid);
    hArt.value = scaledTrackHeight(TRACK_HEIGHT_BASE.art);
    hWave.value = scaledTrackHeight(TRACK_HEIGHT_BASE.wave);
    const nextPhon = scaledTrackHeight(TRACK_HEIGHT_BASE.phon);
    const nextF0 = scaledTrackHeight(TRACK_HEIGHT_BASE.f0);
    const nextPs = scaledTrackHeight(TRACK_HEIGHT_BASE.ps);
    collapsedSpecialHeights.value = { phon: nextPhon, f0: nextF0, ps: nextPs };
    if (!phonExpanded.value) hPhon.value = nextPhon;
    if (!f0Expanded.value) hF0.value = nextF0;
    if (!psExpanded.value) hPs.value = nextPs;
  },
);
const phonExpandedMin = 28 + SYNTHESIS_VOQS_PROFILES.length * 22;

const effPhonHeight = computed(() => (phonExpanded.value ? Math.max(phonExpandedMin, hPhon.value) : hPhon.value));
const effF0Height = computed(() => (f0Expanded.value ? Math.max(148, hF0.value) : hF0.value));
const effPsHeight = computed(() => (psExpanded.value ? Math.max(148, hPs.value) : hPs.value));

function toggleSpecialTrack(track: 'phon' | 'f0' | 'ps'): void {
  if (track === 'phon') {
    if (phonExpanded.value) {
      phonExpanded.value = false;
      hPhon.value = collapsedSpecialHeights.value.phon;
    } else {
      collapsedSpecialHeights.value.phon = Math.min(96, hPhon.value);
      phonExpanded.value = true;
      hPhon.value = Math.max(phonExpandedMin, hPhon.value);
    }
    return;
  }
  if (track === 'f0') {
    if (f0Expanded.value) {
      f0Expanded.value = false;
      hF0.value = collapsedSpecialHeights.value.f0;
    } else {
      collapsedSpecialHeights.value.f0 = Math.min(96, hF0.value);
      f0Expanded.value = true;
      hF0.value = Math.max(148, hF0.value);
    }
    return;
  }
  if (psExpanded.value) {
    psExpanded.value = false;
    hPs.value = collapsedSpecialHeights.value.ps;
  } else {
    collapsedSpecialHeights.value.ps = Math.min(96, hPs.value);
    psExpanded.value = true;
    hPs.value = Math.max(148, hPs.value);
  }
}

function spanWidthPx(startSmp: number, endSmp: number): number {
  return Math.max(2, smpToX(endSmp) - smpToX(startSmp));
}

// F0 Track Header Capsules (strictly 靶点 / 钉住 / 颤音 / 微扰 + 手绘 + 放大 — NO redundant 残差!)
const showF0Targets = ref(true);
const showF0Pins = ref(true);
const f0DrawMode = ref(false);
const psDrawMode = ref(false);

// Waveform non-destructive switches
const waveBoost3db = ref(false);

const activeClip = computed(() => store.project.value.clips[store.activeClipId.value]);
const boundaryPreview = shallowRef<RetimeResult | null>(null);
const drawingClip = computed(() => boundaryPreview.value?.clip ?? activeClip.value);
const activeVoice = computed(() => store.project.value.voices[store.activeVoiceId.value]);
const fRefHz = computed(() => activeVoice.value?.f0_ref_hz ?? 220);

const syllables = computed<Syllable[]>(() => {
  const clip = drawingClip.value;
  if (!clip) return [];
  return clip.syllable_order.map((id) => clip.syllables[id]).filter((s): s is Syllable => Boolean(s));
});

interface FlatPhoneItem {
  idx: number;
  syl: Syllable;
  seg: SegmentAnchor;
}

const flatPhones = computed<FlatPhoneItem[]>(() => {
  const list: FlatPhoneItem[] = [];
  let idx = 0;
  for (const syl of syllables.value) {
    for (const seg of syl.segments) {
      list.push({ idx: idx++, syl, seg });
    }
  }
  return list;
});

const totalDurationSmp = computed(() => {
  const audio = store.annotationAudioBuffer.value;
  const audioEnd = audio ? store.annotationAudioOffsetSmp.value + Math.round(audio.duration * SAMPLE_RATE_HZ) : 0;
  return Math.max(msToSamples(100), drawingClip.value?.end_smp ?? 0, audioEnd);
});

const totalDurationSec = computed(() => totalDurationSmp.value / SAMPLE_RATE_HZ);

// Guarantee minimum readable phoneme width (never squashed into single screen!)
const minPxPerSec = computed(() => {
  const count = Math.max(1, flatPhones.value.length);
  const avgSegSec = Math.max(0.08, totalDurationSec.value / count);
  return Math.max(240, 56 / avgSegSec);
});

const pxPerSec = computed(() => Math.max(minPxPerSec.value, (laneWidth.value - 32) / totalDurationSec.value) * hZoom.value);

const timelineWidthPx = computed(() =>
  Math.max(laneWidth.value, Math.round(totalDurationSec.value * pxPerSec.value) + 32),
);

function smpToX(smp: number): number {
  return (smp / SAMPLE_RATE_HZ) * pxPerSec.value;
}

function xToSmp(x: number): number {
  const clampedX = Math.max(0, Math.min(timelineWidthPx.value, x));
  return Math.max(0, Math.min(totalDurationSmp.value, Math.round((clampedX / pxPerSec.value) * SAMPLE_RATE_HZ)));
}

const viewScroll = computed(() => Math.min(laneScrollX.value, Math.max(0, timelineWidthPx.value - laneWidth.value)));
const viewLeft = computed(() => Math.max(0, viewScroll.value - 160));
const viewRight = computed(() => Math.min(timelineWidthPx.value, viewScroll.value + laneWidth.value + 160));
const viewSvgWidth = computed(() => Math.max(1, viewRight.value - viewLeft.value));
const viewStartSmp = computed(() => xToSmp(viewLeft.value));
const viewEndSmp = computed(() => xToSmp(viewRight.value));
function viewSvg(height: number): string {
  return `${viewLeft.value} 0 ${viewSvgWidth.value} ${height}`;
}
function inView(startSmp: number, endSmp: number): boolean {
  return endSmp >= viewStartSmp.value && startSmp <= viewEndSmp.value;
}
const visiblePhones = computed(() => flatPhones.value.filter(({ seg }) => inView(seg.start_smp, seg.end_smp)));
const visibleSyllables = computed(() => syllables.value.filter((syl) => inView(syl.start_smp, syl.end_smp)));
interface SilenceGapItem {
  id: string;
  startSmp: number;
  endSmp: number;
  kind: 'leading' | 'between' | 'trailing';
}
const silenceGaps = computed<SilenceGapItem[]>(() => {
  const clip = drawingClip.value;
  if (!clip || !syllables.value.length) return [];
  const minGapSmp = msToSamples(10);
  const ordered = [...syllables.value].sort((a, b) => a.start_smp - b.start_smp);
  const gaps: SilenceGapItem[] = [];
  const clipStart = clip.start_smp ?? 0;
  if (ordered[0].start_smp - clipStart >= minGapSmp) {
    gaps.push({ id: `gap_lead_${clipStart}_${ordered[0].start_smp}`, startSmp: clipStart, endSmp: ordered[0].start_smp, kind: 'leading' });
  }
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = ordered[i].end_smp;
    const b = ordered[i + 1].start_smp;
    if (b - a >= minGapSmp) {
      gaps.push({ id: `gap_mid_${ordered[i].id}_${ordered[i + 1].id}`, startSmp: a, endSmp: b, kind: 'between' });
    }
  }
  const lastEnd = ordered[ordered.length - 1].end_smp;
  if (clip.end_smp - lastEnd >= minGapSmp) {
    gaps.push({ id: `gap_tail_${lastEnd}_${clip.end_smp}`, startSmp: lastEnd, endSmp: clip.end_smp, kind: 'trailing' });
  }
  return gaps;
});
const visibleSilenceGaps = computed(() => silenceGaps.value.filter((g) => inView(g.startSmp, g.endSmp)));
const selectedPhoneSet = computed(() => new Set(store.selectedPhonemeIds.value));
const singlePhone = computed(() => selectedPhoneSet.value.size === 1
  ? flatPhones.value.find(({ seg }) => selectedPhoneSet.value.has(seg.id)) ?? null : null);
const isSelectedStop = computed(() => {
  const phone = singlePhone.value?.seg;
  return Boolean(phone && (phone.stop_timing || phoneTraits(phone.ipa).stop));
});
const splitInsidePhone = computed(() => {
  const segment = singlePhone.value?.seg;
  const cursor = store.playheadSmp.value;
  return Boolean(segment && cursor > segment.start_smp && cursor < segment.end_smp);
});

const rulerTicks = computed(() => {
  const stepSec = pxPerSec.value >= 420 ? 0.1 : pxPerSec.value >= 240 ? 0.2 : 0.5;
  const ticks: Array<{ sec: number; x: number; major: boolean; label: string }> = [];
  const maxSec = Math.min(totalDurationSec.value, viewRight.value / pxPerSec.value) + 0.1;
  for (let i = Math.max(0, Math.floor(viewLeft.value / (pxPerSec.value * stepSec))); i * stepSec <= maxSec; i++) {
    const sec = Number((i * stepSec).toFixed(2));
    const major = Math.abs(sec - Math.round(sec)) < 0.001 || (stepSec <= 0.2 && i % 5 === 0);
    ticks.push({
      sec,
      x: sec * pxPerSec.value,
      major,
      label: `${sec.toFixed(1)}s`,
    });
  }
  return ticks;
});

// ===== Vibrato, Perturbation & Unmarked IPA Pitch bindings =====
const vibratoEnabled = computed(() => Boolean(store.project.value.vibrato?.enabled));
const perturbEnabled = computed(() => (store.project.value.perturbation?.flutter ?? 0) > 0);
const naturalIpaPitch = computed(() => unmarkedIpaPitchMode.value === 'natural');

function toggleUnmarkedIpaPitch(): void {
  setUnmarkedIpaPitchMode(naturalIpaPitch.value ? 'flat' : 'natural');
  invalidateSynthesisBufferIfNeeded();
}

function invalidateSynthesisBufferIfNeeded(): void {
  if (!props.recordingActive) {
    store.annotationAudioBuffer.value = null;
    store.lastAudioBuffer.value = null;
  }
}

function toggleVibrato(): void {
  const nextProject = JSON.parse(JSON.stringify(store.project.value));
  const nextOn = !vibratoEnabled.value;
  const prevHold = nextProject.vibrato?.min_hold_ms;
  const useSpeechDefaults = prevHold === undefined || prevHold > 200;
  nextProject.vibrato = {
    enabled: nextOn,
    rate_hz: nextProject.vibrato?.rate_hz ?? 5.5,
    depth_cents: nextProject.vibrato?.depth_cents ?? 26,
    delay_ms: useSpeechDefaults ? 60 : (nextProject.vibrato?.delay_ms ?? 60),
    fade_in_ms: useSpeechDefaults ? 55 : (nextProject.vibrato?.fade_in_ms ?? 55),
    fade_out_ms: useSpeechDefaults ? 45 : (nextProject.vibrato?.fade_out_ms ?? 45),
    min_hold_ms: useSpeechDefaults ? 140 : (prevHold ?? 140),
  };
  const res = store.executeCommand({
    type: 'project.replace',
    label: nextProject.vibrato.enabled ? '开启颤音 (L4 · 单字可见)' : '关闭颤音 (L4)',
    payload: { project: nextProject },
  });
  if (res.ok) invalidateSynthesisBufferIfNeeded();
}

function togglePerturb(): void {
  const nextProject = JSON.parse(JSON.stringify(store.project.value));
  const nextOn = !perturbEnabled.value;
  nextProject.perturbation = {
    flutter: nextOn ? 20 : 0,
    shimmer: nextOn ? 8 : 0,
    seed: nextProject.perturbation?.seed ?? 20261122,
  };
  const res = store.executeCommand({
    type: 'project.replace',
    label: nextOn ? '开启声源微扰 (Flutter)' : '关闭声源微扰',
    payload: { project: nextProject },
  });
  if (res.ok) invalidateSynthesisBufferIfNeeded();
}

// ===== Keyframe Popover State =====
const openKfId = ref<string | null>(null);
const emit = defineEmits<{
  'send-pitch': [points: { t_smp: number; f0_hz: number }[]];
  'keyframe-open': [open: boolean];
  'corpus-drop': [payload: { files: File[]; corpusIds: string[] }];
  'play-selection': [payload: { startSmp?: number; endSmp?: number; gain: number }];
  'cut-range': [payload: { startSmp: number; endSmp: number }];
  'trim-silence': [];
  'save-dictionary': [];
  'playhead-scrub': [smp: number];
  'phoneme-focus': [];
}>();
const openKfIdx = computed(() => {
  const index = flatPhones.value.findIndex(({ seg }) => seg.id === openKfId.value);
  return index < 0 ? null : index;
});
watch(() => openKfIdx.value !== null || phonEditorOpen.value, open => emit('keyframe-open', open));
const activeKfItem = computed(() =>
  openKfIdx.value !== null ? flatPhones.value[openKfIdx.value] ?? null : null,
);
const activeKfPrevParams = computed(() => {
  if (openKfIdx.value === null || openKfIdx.value <= 0) return null;
  const p = flatPhones.value[openKfIdx.value - 1]?.seg.params;
  return p ? tractArray19ToRecord(p) : null;
});
const activeKfNextParams = computed(() => {
  if (openKfIdx.value === null || openKfIdx.value >= flatPhones.value.length - 1) return null;
  const p = flatPhones.value[openKfIdx.value + 1]?.seg.params;
  return p ? tractArray19ToRecord(p) : null;
});

function openKeyframePopover(item: FlatPhoneItem): void {
  cutSelectionSmp.value = null;
  store.selectedSyllableId.value = item.syl.id;
  store.selectedPhonemeIds.value = [item.seg.id];
  store.playheadSmp.value = item.seg.start_smp;
  openKfId.value = openKfId.value === item.seg.id ? null : item.seg.id;
  emit('phoneme-focus');
}

// ===== Polyphone Corner Triangle Reading Switcher (STRICT: only triangle triggers!) =====
const readingMenuSyl = ref<Syllable | null>(null);
const readingMenuStyle = ref<Record<string, string>>({});
const readingMenuRef = ref<HTMLDivElement | null>(null);
const selectedSyllableIds = ref<string[]>([]);
const selectedSyllableSet = computed(() => new Set(selectedSyllableIds.value));
const focusedSyllableId = computed(() => selectedSyllableIds.value[0]
  ?? (selectedPhoneSet.value.size === 0 ? store.selectedSyllableId.value : ''));
const focusedPhoneId = computed(() => store.selectedPhonemeIds.value[0]);
let phoneRangeAnchor = '';

function selectSyllableBodyOnly(syl: Syllable): void {
  if (suppressNextPhoneClick) return;
  cutSelectionSmp.value = null;
  readingMenuSyl.value = null;
  selectedSyllableIds.value = [syl.id];
  store.selectedSyllableId.value = syl.id;
  store.selectedPhonemeIds.value = [];
  store.playheadSmp.value = syl.start_smp;
  emit('phoneme-focus');
}

function openPolyphoneMenu(syl: Syllable, e: MouseEvent): void {
  e.stopPropagation();
  if (readingMenuSyl.value?.id === syl.id) {
    readingMenuSyl.value = null;
    return;
  }
  store.selectedSyllableId.value = syl.id;
  const btn = e.currentTarget as HTMLElement | null;
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const scale = Math.max(0.5, getCurrentPageScale());
  const menuW = 192;
  const vw = window.innerWidth / scale;
  const vh = window.innerHeight / scale;
  let left = rect.right / scale - menuW;
  left = Math.max(8, Math.min(vw - menuW - 8, left));
  let top = rect.bottom / scale + 4;
  if (top + 148 > vh) top = Math.max(8, rect.top / scale - 138);
  readingMenuStyle.value = {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    minWidth: `${menuW}px`,
    maxHeight: `${Math.max(120, Math.round(vh - 24))}px`,
  };
  readingMenuSyl.value = syl;
}

function isActiveReadingCandidate(syl: Syllable, candidate: string): boolean {
  const ipaMatch = /\[([^\]]+)\]/.exec(candidate);
  const rawIpa = ipaMatch ? ipaMatch[1] : candidate;
  const toneDigits = extractToneLevels(rawIpa) ?? '';
  const phonemes = splitIpaToPhonemes(rawIpa);
  const samePhones =
    phonemes.length === syl.ipa.length && phonemes.every((p, idx) => p === syl.ipa[idx]);
  if (!samePhones) return false;
  if (toneDigits && (syl.tone_levels ?? '') !== toneDigits) return false;
  return true;
}

function applyReadingCandidate(syl: Syllable, candidate: string): void {
  const ipaMatch = /\[([^\]]+)\]/.exec(candidate);
  const rawIpa = ipaMatch ? ipaMatch[1] : candidate;
  const toneDigits = extractToneLevels(rawIpa);
  const phonemes = splitIpaToPhonemes(rawIpa);
  const clip = activeClip.value;
  if (!clip) return;
  const nextProject = JSON.parse(JSON.stringify(store.project.value));
  const nextClip = nextProject.clips[clip.id];
  const row = nextClip?.syllables[syl.id];
  if (!nextClip || !row) return;
  const segments = buildSegmentsForSyllable(syl.id, phonemes, syl.start_smp, syl.end_smp, activeVoice.value?.speaker);
  if (segments.some((segment) => segment.end_smp <= segment.start_smp || (segment.stop_timing
    && samplesToMs(segment.end_smp - segment.start_smp) < 11))) {
    store.pushToast('音节时长不足，无法容纳此读音', 'warning');
    return;
  }
  row.ipa = phonemes;
  row.segments = segments;
  row.nucleus_index = Math.max(0, segments.findIndex((segment) => segment.role === 'nucleus'));
  if (row.overrides?.poses) row.overrides.poses = [];
  if (toneDigits) {
    setSyllableTone(row, toneDigits);
    if (nextProject.f0_pins?.length) {
      nextProject.f0_pins = stripPinsOverlappingRange(nextProject.f0_pins, row.start_smp, row.end_smp);
    }
  }
  const res = store.executeCommand({
    type: 'project.replace',
    label: `切换多音字「${syl.text}」读音为 ${candidate}`,
    payload: { project: nextProject },
  });
  if (res.ok) {
    invalidateSynthesisBufferIfNeeded();
    selectSyllableBodyOnly(row);
  }
  readingMenuSyl.value = null;
}

function setSyllableTone(syllable: Syllable, tone: string): void {
  if ((syllable.tone_levels ?? '') === tone) return;
  syllable.tone_levels = tone;
  if (!tone) {
    if (syllable.targets[0]?.candidates?.user) {
      delete syllable.targets[0].candidates.user;
    }
    return;
  }
  const target = syllable.targets[0] ?? {
    id: `${syllable.id}_t0`, span_id: syllable.id,
    start_smp: syllable.start_smp, end_smp: syllable.end_smp,
    voiced: true, candidates: {},
  };
  syllable.targets[0] = {
    ...target,
    candidates: { ...target.candidates, user: { ...toneTarget(tone), source: 'user' } },
  };
}

const editDialog = ref<HTMLDialogElement | null>(null);
const editing = ref<{
  syllableId: string;
  phoneId?: string;
  gap?: { startSmp: number; endSmp: number };
  text: string;
  tone: string;
  durationMs: number;
  origDurationMs: number;
} | null>(null);
const editError = ref('');

async function openAnnotationEdit(syllable: Syllable, segment?: SegmentAnchor): Promise<void> {
  editError.value = '';
  const origMs = Math.round(samplesToMs((segment?.end_smp ?? syllable.end_smp) - (segment?.start_smp ?? syllable.start_smp)));
  editing.value = {
    syllableId: syllable.id,
    phoneId: segment?.id,
    text: segment?.ipa ?? syllable.text,
    tone: syllable.tone_levels ?? '',
    durationMs: origMs,
    origDurationMs: origMs,
  };
  await nextTick();
  if (!editDialog.value?.open) editDialog.value?.showModal();
}

async function openSilenceGapEdit(gap: SilenceGapItem): Promise<void> {
  if (activeClip.value?.source?.score) return;
  editError.value = '';
  const origMs = Math.round(samplesToMs(gap.endSmp - gap.startSmp));
  editing.value = {
    syllableId: '',
    gap: { startSmp: gap.startSmp, endSmp: gap.endSmp },
    text: 'sil',
    tone: '',
    durationMs: origMs,
    origDurationMs: origMs,
  };
  await nextTick();
  if (!editDialog.value?.open) editDialog.value?.showModal();
}

function applyAnnotationEdit(): void {
  const draft = editing.value;
  const clip = activeClip.value;
  if (!draft || !clip) return;

  if (draft.gap) {
    const requestedMs = Math.round(Number(draft.durationMs));
    if (!Number.isFinite(requestedMs) || requestedMs < 0 || requestedMs > 60000) {
      editError.value = '无声段时长须在 0–60000 ms 之间（设为 0 可消除停顿）';
      return;
    }
    const retimed = resizeAnnotationSilenceGap(
      clip,
      draft.gap.startSmp,
      draft.gap.endSmp,
      msToSamples(requestedMs),
      store.project.value,
    );
    const res = store.executeCommand({
      type: 'clip.edit',
      label: requestedMs === 0 ? '消除无声段停顿' : `调整无声段时长至 ${requestedMs} ms`,
      payload: { clip: retimed.clip, retimed },
    });
    if (res.ok) {
      invalidateSynthesisBufferIfNeeded();
      editDialog.value?.close();
    } else if (res.error) {
      editError.value = res.error.hint;
    }
    return;
  }

  const text = draft.text.trim();
  if (!text) {
    editError.value = draft.phoneId ? '请输入音素符号' : '请输入音节文字';
    return;
  }
  const nextProject = JSON.parse(JSON.stringify(store.project.value));
  let nextClip = nextProject.clips[clip.id] as typeof clip | undefined;
  const syllable = nextClip?.syllables[draft.syllableId];
  if (!nextClip || !syllable) return;

  const requestedDurMs = Math.round(Number(draft.durationMs));
  const durChanged = Number.isFinite(requestedDurMs) && requestedDurMs !== draft.origDurationMs;

  if (draft.phoneId) {
    const index = syllable.segments.findIndex((segment) => segment.id === draft.phoneId);
    if (index < 0) return;
    const phone = syllable.segments[index];
    const symbol = text.replace(/^\[|\]$/g, '');
    if (!symbol || /\s/.test(symbol)) {
      editError.value = '请输入单个音素，可包含附加符号';
      return;
    }
    const effectiveDurMs = durChanged ? requestedDurMs : samplesToMs(phone.end_smp - phone.start_smp);
    if (!Number.isFinite(effectiveDurMs) || effectiveDurMs < (phoneTraits(symbol).stop ? 11 : 15) || effectiveDurMs > 60000) {
      editError.value = phoneTraits(symbol).stop
        ? '塞音时长须在 11–60000 ms 之间（闭塞 ≥10 ms、释放 ≥1 ms）'
        : '音素时长须在 15–60000 ms 之间';
      return;
    }
    const prevIpa = syllable.segments.map((s) => s.ipa);
    syllable.segments[index] = replaceSegmentIpa(phone, symbol, activeVoice.value?.speaker ?? 'JD2');
    syllable.ipa[index] = symbol;
    if (syllable.overrides?.poses?.length) {
      syllable.overrides.poses = syllable.overrides.poses.filter(
        (pose) => pose.seg_index !== index && pose.seg_id !== phone.id,
      );
    }
    const nucIdx = syllable.segments.findIndex((s) => s.role === 'nucleus');
    if (nucIdx >= 0) syllable.nucleus_index = nucIdx;
    syncSyllableTextFromSegments(syllable, prevIpa);
    if (durChanged) {
      const rt = retime(
        nextClip,
        {
          clip_id: nextClip.id,
          syllable_id: syllable.id,
          segment_id: phone.id,
          new_end_smp: phone.start_smp + msToSamples(requestedDurMs),
        },
        nextProject.phonation_anchors,
        nextProject.f0_pins ?? [],
      );
      if (!rt.ok) {
        editError.value = rt.error.hint;
        return;
      }
      nextClip = rt.value.clip;
      nextProject.clips[clip.id] = nextClip;
      nextProject.phonation_anchors = rt.value.phonation_anchors;
      nextProject.f0_pins = rt.value.f0_pins;
    }
  } else {
    if (!/^[1-5]{0,5}$/.test(draft.tone.trim())) {
      editError.value = '调值使用 1–5 的数字，可留空';
      return;
    }
    const prevTone = syllable.tone_levels ?? '';
    const nextTone = draft.tone.trim();
    syllable.text = text;
    setSyllableTone(syllable, nextTone);
    if (nextTone !== prevTone && nextProject.f0_pins?.length) {
      nextProject.f0_pins = stripPinsOverlappingRange(nextProject.f0_pins, syllable.start_smp, syllable.end_smp);
    }
    if (durChanged) {
      if (!Number.isFinite(requestedDurMs) || requestedDurMs < 20 || requestedDurMs > 60000) {
        editError.value = '音节时长须在 20–60000 ms 之间';
        return;
      }
      const rt = retime(
        nextClip,
        {
          clip_id: nextClip.id,
          syllable_id: syllable.id,
          new_start_smp: syllable.start_smp,
          new_end_smp: syllable.start_smp + msToSamples(requestedDurMs),
        },
        nextProject.phonation_anchors,
        nextProject.f0_pins ?? [],
      );
      if (!rt.ok) {
        editError.value = rt.error.hint;
        return;
      }
      nextClip = rt.value.clip;
      const lastSid = nextClip.syllable_order.at(-1);
      const lastEnd = lastSid ? nextClip.syllables[lastSid]?.end_smp ?? nextClip.end_smp : nextClip.end_smp;
      nextClip.end_smp = Math.max(msToSamples(60), lastEnd);
      nextProject.clips[clip.id] = nextClip;
      nextProject.phonation_anchors = rt.value.phonation_anchors;
      nextProject.f0_pins = rt.value.f0_pins;
    }
  }
  const result = store.executeCommand({
    type: 'project.replace',
    label: draft.phoneId ? '编辑音素' : '编辑音节与声调',
    payload: { project: nextProject },
  });
  if (result.ok) {
    invalidateSynthesisBufferIfNeeded();
    editDialog.value?.close();
  }
}

// ===== Enhanced Phoneme Edit Popover (T-15) =====
const phoneEditMenuOpen = ref(false);
const phoneEditBtnRef = ref<HTMLButtonElement | null>(null);
const insertPhoneBtnRef = ref<HTMLButtonElement | null>(null);
const phoneEditMenuRef = ref<HTMLDivElement | null>(null);
const insertIpaInputRef = ref<HTMLInputElement | null>(null);
const phoneEditMenuStyle = ref<Record<string, string>>({});
const phoneContextMenuRef = ref<HTMLDivElement | null>(null);
const phoneContextMenu = ref<{
  syl: Syllable;
  seg: SegmentAnchor;
  style: Record<string, string>;
} | null>(null);
const quickEditIpa = ref('');
const quickDurationMs = ref(80);
const insertIpa = ref('');
const insertIpaMs = ref(80);
const insertSilenceMs = ref(120);
const votDraftMs = ref(0);
const insertionSyllable = computed(() => singlePhone.value?.syl
  ?? syllables.value.find((syl) => syl.id === store.selectedSyllableId.value)
  ?? syllables.value.at(-1));
const canInsertIpa = computed(() => Boolean(
  !activeClip.value?.source?.score && insertionSyllable.value
  && store.selectedPhonemeIds.value.length <= 1,
));
const canDeleteSelectedPhones = computed(() => Boolean(
  !activeClip.value?.source?.score && store.selectedPhonemeIds.value.length > 0,
));

watch(
  () => [
    singlePhone.value?.seg.id,
    singlePhone.value?.seg.ipa,
    singlePhone.value?.seg.start_smp,
    singlePhone.value?.seg.end_smp,
    singlePhone.value?.seg.stop_timing?.vot_ms,
  ] as const,
  () => {
    const seg = singlePhone.value?.seg;
    quickEditIpa.value = seg?.ipa ?? '';
    quickDurationMs.value = seg ? Math.round(samplesToMs(seg.end_smp - seg.start_smp)) : 80;
    votDraftMs.value = Math.round(seg?.stop_timing?.vot_ms ?? 0);
  },
  { immediate: true },
);

function openPhoneEditPopoverAt(anchor: HTMLElement | null, focusInsert = false): void {
  phoneContextMenu.value = null;
  const btn = anchor ?? phoneEditBtnRef.value;
  if (btn) {
    const rect = btn.getBoundingClientRect();
    const scale = Math.max(0.5, getCurrentPageScale());
    const vw = window.innerWidth / scale;
    const vh = window.innerHeight / scale;
    const menuW = 290;
    let left = rect.left / scale;
    left = Math.max(8, Math.min(vw - menuW - 8, left));
    phoneEditMenuStyle.value = {
      left: `${Math.round(left)}px`,
      top: '8px',
      width: `${menuW}px`,
      maxHeight: `${Math.max(180, Math.round(vh - 16))}px`,
    };
    void nextTick(() => {
      const menu = phoneEditMenuRef.value;
      if (menu) {
        const below = rect.bottom / scale + 6;
        const top = below + menu.offsetHeight <= vh - 8
          ? below : Math.max(8, rect.top / scale - menu.offsetHeight - 6);
        phoneEditMenuStyle.value = { ...phoneEditMenuStyle.value, top: `${Math.round(top)}px` };
      }
      if (focusInsert) {
        insertIpaInputRef.value?.focus();
        insertIpaInputRef.value?.select();
      }
    });
  }
  phoneEditMenuOpen.value = true;
}

function togglePhoneEditMenu(): void {
  if (phoneEditMenuOpen.value) {
    phoneEditMenuOpen.value = false;
    return;
  }
  openPhoneEditPopoverAt(phoneEditBtnRef.value, false);
}

function openPhoneInsertPopover(): void {
  openPhoneEditPopoverAt(insertPhoneBtnRef.value ?? phoneEditBtnRef.value, true);
}

function openPhoneContextMenu(item: { syl: Syllable; seg: SegmentAnchor }, e: MouseEvent): void {
  phoneEditMenuOpen.value = false;
  if (!selectedPhoneSet.value.has(item.seg.id)) {
    store.selectedSyllableId.value = item.syl.id;
    store.selectedPhonemeIds.value = [item.seg.id];
    selectedSyllableIds.value = [];
    phoneRangeAnchor = item.seg.id;
  }
  const scale = Math.max(0.5, getCurrentPageScale());
  const vw = window.innerWidth / scale;
  const vh = window.innerHeight / scale;
  const menuW = 196;
  const estH = 224;
  const left = Math.max(8, Math.min(vw - menuW - 8, e.clientX / scale));
  const rawTop = e.clientY / scale;
  const top = rawTop + estH <= vh - 8 ? rawTop : Math.max(8, rawTop - estH);
  phoneContextMenu.value = {
    syl: item.syl,
    seg: item.seg,
    style: { left: `${Math.round(left)}px`, top: `${Math.round(top)}px`, minWidth: `${menuW}px` },
  };
}

function commitQuickSegmentDuration(): void {
  const item = singlePhone.value;
  const clip = activeClip.value;
  if (!item || !clip) return;
  const requestedMs = Math.round(Number(quickDurationMs.value));
  const minMs = item.seg.stop_timing ? 11 : 15;
  if (!Number.isFinite(requestedMs) || requestedMs < minMs || requestedMs > 60000) {
    store.pushToast(`音素时长须在 ${minMs}–60000 ms 之间`, 'danger', 3400);
    return;
  }
  const rt = retime(
    clip,
    {
      clip_id: clip.id,
      syllable_id: item.syl.id,
      segment_id: item.seg.id,
      new_end_smp: item.seg.start_smp + msToSamples(requestedMs),
    },
    store.project.value.phonation_anchors,
    store.project.value.f0_pins ?? [],
  );
  if (!rt.ok) {
    store.pushToast(rt.error.hint, 'danger', 3600);
    quickDurationMs.value = Math.round(samplesToMs(item.seg.end_smp - item.seg.start_smp));
    return;
  }
  const res = store.executeCommand({
    type: 'clip.edit',
    label: `调整音素 [${item.seg.ipa}] 时长至 ${requestedMs} ms`,
    payload: { clip: rt.value.clip, retimed: rt.value },
  });
  if (res.ok) {
    invalidateSynthesisBufferIfNeeded();
    store.pushToast(`已调整 [${item.seg.ipa}] 时长至 ${requestedMs} ms`, 'success', 2000);
  }
}

const canSplitMidpoint = computed(() => {
  const seg = singlePhone.value?.seg;
  if (!seg || isSelectedStop.value) return false;
  return seg.end_smp - seg.start_smp >= msToSamples(30);
});

const singlePhoneSegIndex = computed(() => {
  const item = singlePhone.value;
  if (!item) return -1;
  return item.syl.segments.findIndex((s) => s.id === item.seg.id);
});

const canMergePrevPhone = computed(() => singlePhoneSegIndex.value > 0);
const canMergeNextPhone = computed(() => {
  const item = singlePhone.value;
  const idx = singlePhoneSegIndex.value;
  return Boolean(item && idx >= 0 && idx + 1 < item.syl.segments.length);
});

function applyQuickIpaEdit(): void {
  const item = singlePhone.value;
  const clip = activeClip.value;
  if (!item || !clip) return;
  const symbol = stripDottedCirclePlaceholders(quickEditIpa.value.trim().replace(/^\[|\]$/g, ''));
  if (!symbol || /\s/u.test(symbol)) {
    store.pushToast('请输入单个音素符号（可含附加符号）', 'warning');
    return;
  }
  if (phoneTraits(symbol).stop && samplesToMs(item.seg.end_smp - item.seg.start_smp) < 11) {
    store.pushToast('塞音至少需要闭塞 10 ms 与释放 1 ms', 'warning');
    return;
  }
  const idx = singlePhoneSegIndex.value;
  if (idx < 0) return;
  const next = JSON.parse(JSON.stringify(clip)) as typeof clip;
  const syl = next.syllables[item.syl.id];
  if (!syl) return;
  const prevIpa = syl.segments.map((s) => s.ipa);
  syl.segments[idx] = replaceSegmentIpa(syl.segments[idx], symbol, activeVoice.value?.speaker ?? 'JD2');
  syl.ipa[idx] = symbol;
  if (syl.overrides?.poses?.length) {
    syl.overrides.poses = syl.overrides.poses.filter(
      (pose) => pose.seg_index !== idx && pose.seg_id !== item.seg.id,
    );
  }
  const nucIdx = syl.segments.findIndex((s) => s.role === 'nucleus');
  if (nucIdx >= 0) syl.nucleus_index = nucIdx;
  syncSyllableTextFromSegments(syl, prevIpa);
  const res = store.executeCommand({
    type: 'clip.edit',
    label: `修改音素为 [${symbol}]`,
    payload: { clip: next },
  });
  if (res.ok) {
    invalidateSynthesisBufferIfNeeded();
    store.pushToast(`已更新音素为 [${symbol}]`, 'success', 2000);
  }
}

function splitSelectedPhone(mode: 'playhead' | 'midpoint' = 'playhead'): void {
  const item = singlePhone.value;
  const clip = activeClip.value;
  if (!item || !clip || isSelectedStop.value) return;
  const splitSmp =
    mode === 'midpoint'
      ? Math.round((item.seg.start_smp + item.seg.end_smp) * 0.5)
      : Math.round(store.playheadSmp.value);
  const index = item.syl.segments.findIndex((segment) => segment.id === item.seg.id);
  const rightId = `seg_${crypto.randomUUID()}`;
  const updated = splitAnnotationPhone(item.syl, index, splitSmp, rightId);
  if (!updated) {
    store.pushToast(
      mode === 'midpoint' ? '当前音素过短，无法对半拆分' : '请先选中普通音素，并将播放头移到音素内部',
      'warning',
    );
    return;
  }
  const next = { ...clip, syllables: { ...clip.syllables, [updated.id]: updated } };
  const result = store.executeCommand({
    type: 'clip.edit',
    label: `${mode === 'midpoint' ? '从中点' : '从播放头'}拆分 [${item.seg.ipa}]`,
    payload: { clip: next },
  });
  if (result.ok) {
    store.selectedPhonemeIds.value = [rightId];
    store.playheadSmp.value = splitSmp;
    store.pushToast('已拆分为两段音素，可直接修改音标。', 'success');
  }
}

function mergeSelectedPhone(direction: 'prev' | 'next'): void {
  const item = singlePhone.value;
  const clip = activeClip.value;
  const idx = singlePhoneSegIndex.value;
  if (!item || !clip || idx < 0) return;
  const targetIdx = direction === 'prev' ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= item.syl.segments.length) return;

  const next = JSON.parse(JSON.stringify(clip)) as typeof clip;
  const syl = next.syllables[item.syl.id];
  if (!syl) return;
  const keepIdx = Math.min(idx, targetIdx);
  const dropIdx = Math.max(idx, targetIdx);
  const kept = syl.segments[keepIdx];
  const dropped = syl.segments[dropIdx];
  kept.end_smp = dropped.end_smp;
  if (kept.stop_timing) {
    const durMs = samplesToMs(kept.end_smp - kept.start_smp);
    kept.stop_timing.closure_ms = Math.max(10, Math.round(durMs * 0.58));
    kept.stop_timing.release_ms = Math.max(1, Math.min(kept.stop_timing.release_ms, Math.floor(durMs - kept.stop_timing.closure_ms)));
  }
  const prevIpa = syl.segments.map((s) => s.ipa);
  syl.segments.splice(dropIdx, 1);
  syl.ipa = syl.segments.map((s) => s.ipa);
  syl.nucleus_index = Math.max(
    0,
    Math.min(
      syl.segments.length - 1,
      syl.segments.findIndex((s) => s.role === 'nucleus') >= 0
        ? syl.segments.findIndex((s) => s.role === 'nucleus')
        : 0,
    ),
  );
  syl.overrides.poses = (syl.overrides.poses ?? [])
    .filter((p) => p.seg_index !== dropIdx && p.seg_id !== dropped.id)
    .map((p) => (p.seg_index > dropIdx ? { ...p, seg_index: p.seg_index - 1 } : p));
  syncSyllableTextFromSegments(syl, prevIpa);

  const res = store.executeCommand({
    type: 'clip.edit',
    label: `合并音素 [${kept.ipa}] + [${dropped.ipa}]`,
    payload: { clip: next },
  });
  if (res.ok) {
    store.selectedPhonemeIds.value = [kept.id];
    store.pushToast(`已合并为 [${kept.ipa}]`, 'success', 2000);
  }
}

function insertAtSelection(direction: 'before' | 'after', silence = false): void {
  const clip = activeClip.value;
  if (!clip || activeClip.value?.source?.score || (!silence && !canInsertIpa.value)) return;
  const rawMs = Number(silence ? insertSilenceMs.value : insertIpaMs.value);
  if (!Number.isFinite(rawMs) || rawMs < 20 || rawMs > 2000) {
    store.pushToast('插入时长须在 20–2000 ms 之间', 'warning');
    return;
  }
  const item = singlePhone.value;
  const target = insertionSyllable.value ?? (silence ? syllables.value.at(-1) : undefined);
  const syl = target && clip.syllables[target.id];
  if (!syl) {
    store.pushToast('请先选中一个音素或音节', 'warning');
    return;
  }
  const symbol = silence
    ? 'sil'
    : stripDottedCirclePlaceholders(insertIpa.value.trim().replace(/^\[|\]$/gu, '').trim());
  const splitParts = silence ? ['sil'] : splitIpaToPhonemes(symbol);
  if (!silence && (!symbol || splitParts.length !== 1 || splitParts[0] !== symbol)) {
    store.pushToast('请输入单个 IPA 音素，可带附加符号', 'warning');
    return;
  }
  const before = direction === 'before';
  const phoneIndex = item ? syl.segments.findIndex((phone) => phone.id === item.seg.id) : -1;
  const index = phoneIndex < 0 ? (before ? 0 : syl.segments.length) : phoneIndex + (before ? 0 : 1);
  const at = before ? (syl.segments[index]?.start_smp ?? syl.start_smp) : (syl.segments[index - 1]?.end_smp ?? syl.end_smp);
  const end = at + msToSamples(Math.round(rawMs));
  const segment = silence
    ? { ipa: 'sil', start_smp: at, end_smp: end, role: 'rest' as const, elastic: true, voiced: false,
        params: tractRecordToArray19(defaultTractParams()) }
    : { ...buildSegmentsForSyllable(syl.id, [symbol], at, end, activeVoice.value?.speaker)[0],
        role: syl.segments.length === 0 ? 'nucleus' as const : (index <= syl.nucleus_index ? 'onset' as const : 'coda' as const) };
  const id = `seg_${crypto.randomUUID()}`;
  const retimed = insertAnnotationSegment(clip, syl.id, index, { ...segment, id }, store.project.value);
  const label = `插入 ${Math.round(rawMs)} ms ${silence ? '静音段' : '音素'} [${symbol}]`;
  const res = store.executeCommand({
    type: 'clip.edit',
    label,
    payload: { clip: retimed.clip, retimed },
  });
  if (res.ok) {
    store.stopPlayback();
    store.selectedPhonemeIds.value = [id];
    phoneRangeAnchor = id;
    store.selectedSyllableId.value = syl.id;
    selectedSyllableIds.value = [];
    store.playheadSmp.value = at;
    invalidateSynthesisBufferIfNeeded();
    store.pushToast(`已${label}`, 'success', 2200);
  }
}

function deleteSelectedPhones(targetIds?: readonly string[]): void {
  const clip = activeClip.value;
  if (!clip || clip.source?.score) return;
  const ids = targetIds?.length ? [...targetIds] : [...store.selectedPhonemeIds.value];
  if (!ids.length) {
    store.pushToast('请先在时间轴选中要删除的音素', 'warning', 2000);
    return;
  }
  const retimed = deleteAnnotationSegments(clip, ids, store.project.value);
  if (!retimed) {
    store.pushToast('至少需保留 1 个音素，无法全部删除', 'warning', 2400);
    return;
  }
  const label = retimed.deletedCount === 1 ? '删除 1 个音素' : `删除 ${retimed.deletedCount} 个音素`;
  const res = store.executeCommand({
    type: 'clip.edit',
    label,
    payload: { clip: retimed.clip, retimed },
  });
  if (res.ok) {
    store.stopPlayback();
    phoneContextMenu.value = null;
    store.selectedPhonemeIds.value = retimed.nextFocusPhoneId ? [retimed.nextFocusPhoneId] : [];
    phoneRangeAnchor = retimed.nextFocusPhoneId ?? '';
    store.selectedSyllableId.value = retimed.nextFocusSyllableId ?? retimed.clip.syllable_order[0] ?? '';
    selectedSyllableIds.value = [];
    invalidateSynthesisBufferIfNeeded();
    store.pushToast(`已${label}（可 Ctrl+Z 撤销）`, 'success', 2200);
  }
}

function commitStopVot(): void {
  const item = singlePhone.value;
  const clip = activeClip.value;
  if (!item || !clip || !isSelectedStop.value) return;
  const seg = item.seg;
  const totalMs = samplesToMs(seg.end_smp - seg.start_smp);
  if (totalMs < 11) {
    store.pushToast('塞音总长不足 11 ms（闭塞 ≥10 ms，释放 ≥1 ms）', 'warning');
    return;
  }
  const requestedVot = Number(votDraftMs.value);
  const maxPosVot = Math.max(1, Math.floor(totalMs - 10));
  const minNegVot = -Math.floor(totalMs - 1);
  if (!Number.isFinite(requestedVot) || requestedVot < minNegVot || requestedVot > maxPosVot) {
    store.pushToast(
      `VOT (${requestedVot} ms) 超出当前塞音允许范围 [${minNegVot}, ${maxPosVot}] ms（需保留 ≥10 ms 闭塞与 ≥1 ms 释放）`,
      'danger',
    );
    return;
  }

  const prior = seg.stop_timing ?? {
    closure_ms: Math.max(10, Math.floor(totalMs * 0.6)),
    release_ms: 1,
    aspiration_ms: 0,
    vot_ms: 0,
  };
  let closureMs = prior.closure_ms;
  let releaseMs = Math.max(1, prior.release_ms);
  let aspirationMs = prior.aspiration_ms;

  if (requestedVot >= 0) {
    const neededPostRelease = Math.max(releaseMs, requestedVot);
    closureMs = Math.max(10, Number((totalMs - neededPostRelease).toFixed(1)));
    const postBudget = Math.max(1, Number((totalMs - closureMs).toFixed(1)));
    releaseMs = Math.min(postBudget, Math.max(1, Math.min(releaseMs, 6)));
    aspirationMs = Math.max(0, Number((postBudget - releaseMs).toFixed(1)));
  } else {
    // Negative VOT (pre-voiced stop): ensure closure is at least |vot| and >= 10 ms
    closureMs = Math.max(10, Math.min(Number((totalMs - 1).toFixed(1)), Math.max(closureMs, Math.abs(requestedVot))));
    const postBudget = Math.max(1, Number((totalMs - closureMs).toFixed(1)));
    releaseMs = Math.min(postBudget, Math.max(1, releaseMs));
    aspirationMs = 0;
  }

  const next = JSON.parse(JSON.stringify(clip)) as typeof clip;
  const targetSyl = next.syllables[item.syl.id];
  const idx = targetSyl?.segments.findIndex((s) => s.id === seg.id) ?? -1;
  if (!targetSyl || idx < 0) return;
  targetSyl.segments[idx].stop_timing = {
    closure_ms: closureMs,
    release_ms: releaseMs,
    aspiration_ms: aspirationMs,
    vot_ms: requestedVot,
    auto_generated: false,
  };
  targetSyl.segments[idx].voiced = requestedVot < 0 ? true : phoneTraits(seg.ipa).voiced;
  const res = store.executeCommand({
    type: 'clip.edit',
    label: `调节 [${seg.ipa}] VOT 至 ${requestedVot} ms`,
    payload: { clip: next },
  });
  if (res.ok) {
    invalidateSynthesisBufferIfNeeded();
    store.pushToast(`已设置 [${seg.ipa}] VOT = ${requestedVot} ms`, 'success', 2000);
  }
}

function markStopRelease(): void {
  const item = singlePhone.value;
  const clip = activeClip.value;
  if (!item || !clip || !isSelectedStop.value) return;
  const timing = item.seg.stop_timing ?? {
    closure_ms: 10, release_ms: 1, aspiration_ms: 0, vot_ms: 0,
  };
  const closureSmp = store.playheadSmp.value - item.seg.start_smp;
  const closureMs = samplesToMs(closureSmp);
  const remainingMs = samplesToMs(item.seg.end_smp - store.playheadSmp.value);
  if (closureSmp < msToSamples(10) || remainingMs < 1) {
    store.pushToast('持阻至少 10 ms，除阻至少 1 ms', 'warning');
    return;
  }
  const releaseMs = Math.min(timing.release_ms, remainingMs);
  const aspirationMs = Math.min(timing.aspiration_ms, Math.max(0, remainingMs - releaseMs));
  const segments = item.syl.segments.map((segment) => segment.id === item.seg.id ? {
    ...segment,
    stop_timing: {
      ...timing, closure_ms: closureMs, release_ms: releaseMs, aspiration_ms: aspirationMs, auto_generated: false,
      vot_ms: Math.max(-closureMs, Math.min(releaseMs + aspirationMs, timing.vot_ms)),
    },
  } : segment);
  const next = { ...clip, syllables: { ...clip.syllables, [item.syl.id]: { ...item.syl, segments } } };
  store.executeCommand({ type: 'clip.edit', label: `标记 [${item.seg.ipa}] 除阻起点`, payload: { clip: next } });
}

const canSynthesizeSelected = computed(() => {
  const audio = store.annotationAudioBuffer.value;
  const phone = singlePhone.value?.seg;
  const offset = store.annotationAudioOffsetSmp.value;
  return Boolean(props.recordingActive && audio && phone && phone.start_smp >= offset
    && Math.round((phone.end_smp - offset) * audio.sampleRate / SAMPLE_RATE_HZ) <= audio.length && !store.isSynthesizing.value);
});

async function resampleReplacement(audio: AudioBuffer, sampleRate: number, sampleCount: number): Promise<Float32Array> {
  if (audio.sampleRate === sampleRate) return audio.getChannelData(0);
  const ctx = new OfflineAudioContext(1, sampleCount, sampleRate);
  const source = ctx.createBufferSource();
  source.buffer = audio;
  source.connect(ctx.destination);
  source.start();
  return (await ctx.startRendering()).getChannelData(0);
}

async function synthesizeSelectedPhone(): Promise<void> {
  const item = singlePhone.value;
  const audio = store.annotationAudioBuffer.value;
  const clip = activeClip.value;
  const revision = store.project.value.revision;
  const offset = store.annotationAudioOffsetSmp.value;
  if (!canSynthesizeSelected.value || !item || !audio || !clip) return;
  const start = Math.round((item.seg.start_smp - offset) * audio.sampleRate / SAMPLE_RATE_HZ);
  const end = Math.round((item.seg.end_smp - offset) * audio.sampleRate / SAMPLE_RATE_HZ);
  const generated = await store.synthesizeRange({
    annotation: true, startSmp: item.seg.start_smp, endSmp: item.seg.end_smp, cacheWaveform: false,
    ipaPoseSource: textPoseSource.value,
  });
  if (!generated || revision !== store.project.value.revision || clip !== activeClip.value
    || audio !== store.annotationAudioBuffer.value) return;
  try {
    const mono = await resampleReplacement(generated, audio.sampleRate, end - start);
    if (revision !== store.project.value.revision || audio !== store.annotationAudioBuffer.value) return;
    const patch = new AudioBuffer({
      sampleRate: audio.sampleRate, length: audio.length, numberOfChannels: audio.numberOfChannels,
    });
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      patch.getChannelData(channel).set(spliceAnnotationPcm(audio.getChannelData(channel), mono, start, end, audio.sampleRate));
    }
    store.commitAnnotationAudio(patch, `局部重合成 [${item.seg.ipa}]`);
    store.pushToast(`已更新 [${item.seg.ipa}] 的录音区间`, 'success');
  } catch (error) {
    store.pushToast(error instanceof Error ? error.message : '局部重合成失败', 'warning');
  }
}

function stopPhaseStyle(seg: SegmentAnchor) {
  const phases = stopPhaseBoundaries(seg);
  if (!phases) return undefined;
  const span = Math.max(1, seg.end_smp - seg.start_smp);
  return {
    left: `${100 * (phases.releaseStart - seg.start_smp) / span}%`,
    width: `${100 * (phases.releaseEnd - phases.releaseStart) / span}%`,
  };
}

// ===== Phone Marquee Drag Multi-Selection & Boundary Handle Retiming =====
const marqueeState = ref<{ tier: 'words' | 'phones'; startX: number; curX: number } | null>(null);
const rigidGuardMsg = ref('');
let suppressNextPhoneClick = false;
let suppressNextPhonClick = false;
let suppressPhoneClickTimer = 0;
let suppressPhonClickTimer = 0;
let rigidGuardTimer = 0;
const activeDragCleanups = new Set<() => void>();

function registerDragCleanup(fn: () => void): () => void {
  const wrapped = () => {
    activeDragCleanups.delete(wrapped);
    fn();
  };
  activeDragCleanups.add(wrapped);
  return wrapped;
}

function localXFromPointer(e: PointerEvent, el: HTMLElement): number {
  const rect = el.getBoundingClientRect();
  const scale = getCurrentPageScale();
  return (e.clientX - rect.left) / scale;
}

function onAnnotationLanePointerDown(tier: 'words' | 'phones', e: PointerEvent): void {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest('.seg-edge-handle, .syl-edge-handle, .poly-tri-btn')) return;
  const lane = e.currentTarget as HTMLElement;
  const pointerId = e.pointerId;
  const startX = localXFromPointer(e, lane);
  let didMarqueeDrag = false;
  let captured = false;

  const onMove = (ev: PointerEvent) => {
    const curX = localXFromPointer(ev, lane);
    const minX = Math.min(startX, curX);
    const maxX = Math.max(startX, curX);
    if (!didMarqueeDrag) {
      if (maxX - minX < 4) return;
      didMarqueeDrag = true;
      marqueeState.value = { tier, startX, curX };
      try {
        lane.setPointerCapture?.(pointerId);
        captured = true;
      } catch {
        captured = false;
      }
    } else if (marqueeState.value) {
      marqueeState.value.curX = curX;
    }

    const s0 = xToSmp(minX);
    const s1 = xToSmp(maxX);
    if (tier === 'words') {
      const picked = syllables.value.filter((syl) => syl.end_smp > s0 && syl.start_smp < s1);
      selectedSyllableIds.value = picked.map((syl) => syl.id);
      store.selectedPhonemeIds.value = [];
      if (picked[0]) {
        cutSelectionSmp.value = null;
        store.selectedSyllableId.value = picked[0].id;
      } else if (s1 > s0) {
        cutSelectionSmp.value = { startSmp: s0, endSmp: s1 };
        const curSmp = xToSmp(curX);
        store.playheadSmp.value = curSmp;
        emit('playhead-scrub', curSmp);
      }
    } else {
      const picked = flatPhones.value.filter(({ seg }) => seg.end_smp > s0 && seg.start_smp < s1);
      selectedSyllableIds.value = [];
      store.selectedPhonemeIds.value = picked.map(({ seg }) => seg.id);
      phoneRangeAnchor = picked[0]?.seg.id ?? '';
      if (picked[0]) {
        cutSelectionSmp.value = null;
        store.selectedSyllableId.value = picked[0].syl.id;
      } else if (s1 > s0) {
        cutSelectionSmp.value = { startSmp: s0, endSmp: s1 };
        const curSmp = xToSmp(curX);
        store.playheadSmp.value = curSmp;
        emit('playhead-scrub', curSmp);
      }
    }
  };

  const cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', cleanup);
    window.removeEventListener('pointercancel', cleanup);
    if (captured) {
      try {
        if (lane.hasPointerCapture?.(pointerId)) {
          lane.releasePointerCapture(pointerId);
        }
      } catch {
        // ignore if already released
      }
      captured = false;
    }
    if (didMarqueeDrag) {
      suppressNextPhoneClick = true;
      window.setTimeout(() => {
        suppressNextPhoneClick = false;
      }, 0);
    }
    marqueeState.value = null;
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', cleanup);
  window.addEventListener('pointercancel', cleanup);
}

function onSelectSinglePhone(item: FlatPhoneItem, e: MouseEvent): void {
  if (suppressNextPhoneClick) {
    suppressNextPhoneClick = false;
    return;
  }
  if ((e.target as HTMLElement | null)?.closest('.seg-edge-handle')) return;
  cutSelectionSmp.value = null;
  selectedSyllableIds.value = [];
  if (e.shiftKey && store.selectedPhonemeIds.value.length > 0) {
    const firstId = selectedPhoneSet.value.has(phoneRangeAnchor) ? phoneRangeAnchor : store.selectedPhonemeIds.value[0];
    const idxA = flatPhones.value.findIndex((p) => p.seg.id === firstId);
    const idxB = item.idx;
    if (idxA >= 0) {
      const lo = Math.min(idxA, idxB);
      const hi = Math.max(idxA, idxB);
      const included = flatPhones.value.slice(lo, hi + 1).map((p) => p.seg.id).filter(id => id !== item.seg.id);
      store.selectedPhonemeIds.value = [item.seg.id, ...included];
      phoneRangeAnchor = firstId;
      store.selectedSyllableId.value = item.syl.id;
      store.playheadSmp.value = item.seg.start_smp;
      emit('phoneme-focus');
      return;
    }
  }
  store.selectedSyllableId.value = item.syl.id;
  store.selectedPhonemeIds.value = [item.seg.id];
  phoneRangeAnchor = item.seg.id;
  store.playheadSmp.value = item.seg.start_smp;
  emit('phoneme-focus');
}

function canSlideSyllable(syl: Syllable): boolean {
  const clip = activeClip.value;
  if (!clip || clip.source?.score) return false;
  const isSelected = selectedSyllableSet.value.has(syl.id) || focusedSyllableId.value === syl.id;
  if (!isSelected) return false;
  const ids = selectedSyllableSet.value.has(syl.id) && selectedSyllableIds.value.length > 0
    ? selectedSyllableIds.value
    : [syl.id];
  return Boolean(getSyllableSlideBounds(clip, ids));
}

function canSlidePhone(seg: SegmentAnchor): boolean {
  const clip = activeClip.value;
  if (!clip || clip.source?.score || !selectedPhoneSet.value.has(seg.id)) return false;
  return Boolean(getPhoneSlideBounds(clip, store.selectedPhonemeIds.value));
}

function startSyllableSlideDrag(syl: Syllable, e: PointerEvent): void {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest('.syl-edge-handle, .poly-tri-btn')) return;
  const baseClip = activeClip.value;
  if (!baseClip || baseClip.source?.score || !canSlideSyllable(syl)) return;
  const slideIds = selectedSyllableSet.value.has(syl.id) && selectedSyllableIds.value.length > 0
    ? [...selectedSyllableIds.value]
    : [syl.id];
  const bounds = getSyllableSlideBounds(baseClip, slideIds);
  if (!bounds) return;

  e.stopPropagation();
  const origClipSnapshot = JSON.parse(JSON.stringify(baseClip)) as typeof baseClip;
  const origAnchorsSnapshot = JSON.parse(JSON.stringify(store.project.value.phonation_anchors));
  const origPinsSnapshot = JSON.parse(JSON.stringify(store.project.value.f0_pins ?? []));
  const startClientX = e.clientX;
  const originalScale = pxPerSec.value;
  const pageScale = getCurrentPageScale();
  let moved = false;
  let previewFrame = 0;
  let clientX = startClientX;
  let lastDelta = 0;

  const updatePreview = () => {
    previewFrame = 0;
    const dxPx = (clientX - startClientX) / pageScale;
    const rawDelta = Math.round((dxPx / originalScale) * SAMPLE_RATE_HZ);
    const clamped = Math.max(bounds.minDelta, Math.min(bounds.maxDelta, rawDelta));
    lastDelta = clamped;
    if (clamped === 0) {
      boundaryPreview.value = null;
      return;
    }
    boundaryPreview.value = slideAnnotationSyllables(
      origClipSnapshot,
      slideIds,
      clamped,
      { phonation_anchors: origAnchorsSnapshot, f0_pins: origPinsSnapshot },
    );
  };

  const onMove = (ev: PointerEvent) => {
    if (!moved) {
      if (Math.abs(ev.clientX - startClientX) < 4) return;
      moved = true;
    }
    clientX = ev.clientX;
    if (!previewFrame) previewFrame = requestAnimationFrame(updatePreview);
  };

  const cleanup = registerDragCleanup(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cleanup);
    if (previewFrame) cancelAnimationFrame(previewFrame);
    boundaryPreview.value = null;
  });

  const onUp = (ev: PointerEvent) => {
    if (moved && previewFrame) {
      cancelAnimationFrame(previewFrame);
      clientX = ev.clientX;
      updatePreview();
    } else if (moved) {
      clientX = ev.clientX;
      updatePreview();
    }
    const retimed = boundaryPreview.value;
    const committedDelta = lastDelta;
    cleanup();
    if (moved) {
      suppressNextPhoneClick = true;
      window.clearTimeout(suppressPhoneClickTimer);
      suppressPhoneClickTimer = window.setTimeout(() => {
        suppressNextPhoneClick = false;
      }, 0);
    }
    if (retimed && committedDelta !== 0 && baseClip === activeClip.value) {
      const ms = Math.round(samplesToMs(committedDelta));
      const sign = ms > 0 ? '+' : '';
      const label = slideIds.length === 1
        ? `平移音节「${syl.text}」${sign}${ms} ms`
        : `平移 ${slideIds.length} 个音节 ${sign}${ms} ms`;
      const res = store.executeCommand({
        type: 'clip.edit',
        label,
        payload: { clip: retimed.clip, retimed },
      });
      if (res.ok) {
        invalidateSynthesisBufferIfNeeded();
        store.pushToast(`已${label}`, 'success', 1800);
      }
    }
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', cleanup);
}

function startPhoneSlideDrag(item: FlatPhoneItem, e: PointerEvent): void {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest('.seg-edge-handle')) return;
  const baseClip = activeClip.value;
  if (!baseClip || baseClip.source?.score || !canSlidePhone(item.seg)) return;
  const slideIds = [...store.selectedPhonemeIds.value];
  const bounds = getPhoneSlideBounds(baseClip, slideIds);
  if (!bounds) return;

  e.stopPropagation();
  const origClipSnapshot = JSON.parse(JSON.stringify(baseClip)) as typeof baseClip;
  const origAnchorsSnapshot = JSON.parse(JSON.stringify(store.project.value.phonation_anchors));
  const origPinsSnapshot = JSON.parse(JSON.stringify(store.project.value.f0_pins ?? []));
  const startClientX = e.clientX;
  const originalScale = pxPerSec.value;
  const pageScale = getCurrentPageScale();
  let moved = false;
  let previewFrame = 0;
  let clientX = startClientX;
  let lastDelta = 0;

  const updatePreview = () => {
    previewFrame = 0;
    const dxPx = (clientX - startClientX) / pageScale;
    const rawDelta = Math.round((dxPx / originalScale) * SAMPLE_RATE_HZ);
    const clamped = Math.max(bounds.minDelta, Math.min(bounds.maxDelta, rawDelta));
    lastDelta = clamped;
    if (clamped === 0) {
      boundaryPreview.value = null;
      return;
    }
    boundaryPreview.value = slideAnnotationPhones(
      origClipSnapshot,
      slideIds,
      clamped,
      { phonation_anchors: origAnchorsSnapshot, f0_pins: origPinsSnapshot },
    );
  };

  const onMove = (ev: PointerEvent) => {
    if (!moved) {
      if (Math.abs(ev.clientX - startClientX) < 4) return;
      moved = true;
    }
    clientX = ev.clientX;
    if (!previewFrame) previewFrame = requestAnimationFrame(updatePreview);
  };

  const cleanup = registerDragCleanup(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cleanup);
    if (previewFrame) cancelAnimationFrame(previewFrame);
    boundaryPreview.value = null;
  });

  const onUp = (ev: PointerEvent) => {
    if (moved && previewFrame) {
      cancelAnimationFrame(previewFrame);
      clientX = ev.clientX;
      updatePreview();
    } else if (moved) {
      clientX = ev.clientX;
      updatePreview();
    }
    const retimed = boundaryPreview.value;
    const committedDelta = lastDelta;
    cleanup();
    if (moved) {
      suppressNextPhoneClick = true;
      window.clearTimeout(suppressPhoneClickTimer);
      suppressPhoneClickTimer = window.setTimeout(() => {
        suppressNextPhoneClick = false;
      }, 0);
    }
    if (retimed && committedDelta !== 0 && baseClip === activeClip.value) {
      const ms = Math.round(samplesToMs(committedDelta));
      const sign = ms > 0 ? '+' : '';
      const label = slideIds.length === 1
        ? `平移音素 [${item.seg.ipa}] ${sign}${ms} ms`
        : `平移 ${slideIds.length} 个音素 ${sign}${ms} ms`;
      const res = store.executeCommand({
        type: 'clip.edit',
        label,
        payload: { clip: retimed.clip, retimed },
      });
      if (res.ok) {
        invalidateSynthesisBufferIfNeeded();
        store.pushToast(`已${label}`, 'success', 1800);
      }
    }
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', cleanup);
}

function startSilenceGapDrag(gap: SilenceGapItem, e: PointerEvent): void {
  e.preventDefault();
  e.stopPropagation();
  const baseClip = activeClip.value;
  if (!baseClip || baseClip.source?.score) return;
  const origClipSnapshot = JSON.parse(JSON.stringify(baseClip)) as typeof baseClip;
  const origAnchorsSnapshot = JSON.parse(JSON.stringify(store.project.value.phonation_anchors));
  const origPinsSnapshot = JSON.parse(JSON.stringify(store.project.value.f0_pins ?? []));
  const startClientX = e.clientX;
  const origDurSmp = gap.endSmp - gap.startSmp;
  const originalScale = pxPerSec.value;
  const pageScale = getCurrentPageScale();
  const maxDurSmp = msToSamples(60000);
  let previewFrame = 0;
  let clientX = startClientX;

  const computeTargetDur = () => {
    const dxPx = (clientX - startClientX) / pageScale;
    const dSmp = Math.round((dxPx / originalScale) * SAMPLE_RATE_HZ);
    return Math.max(0, Math.min(maxDurSmp, origDurSmp + dSmp));
  };

  const updatePreview = () => {
    previewFrame = 0;
    const targetDur = computeTargetDur();
    if (targetDur === origDurSmp) {
      boundaryPreview.value = null;
      return;
    }
    boundaryPreview.value = resizeAnnotationSilenceGap(
      origClipSnapshot,
      gap.startSmp,
      gap.endSmp,
      targetDur,
      { phonation_anchors: origAnchorsSnapshot, f0_pins: origPinsSnapshot },
    );
  };

  const onMove = (ev: PointerEvent) => {
    clientX = ev.clientX;
    if (!previewFrame) previewFrame = requestAnimationFrame(updatePreview);
  };
  const cleanup = registerDragCleanup(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cleanup);
    if (previewFrame) cancelAnimationFrame(previewFrame);
    boundaryPreview.value = null;
  });
  const onUp = (ev: PointerEvent) => {
    clientX = ev.clientX;
    const targetDur = computeTargetDur();
    cleanup();
    if (targetDur === origDurSmp) return;
    const retimed = resizeAnnotationSilenceGap(
      origClipSnapshot,
      gap.startSmp,
      gap.endSmp,
      targetDur,
      { phonation_anchors: origAnchorsSnapshot, f0_pins: origPinsSnapshot },
    );
    const ms = Math.round(samplesToMs(targetDur));
    const res = store.executeCommand({
      type: 'clip.edit',
      label: ms === 0 ? '消除无声段停顿' : `调整无声段时长至 ${ms} ms`,
      payload: { clip: retimed.clip, retimed },
    });
    if (res.ok) invalidateSynthesisBufferIfNeeded();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', cleanup);
}

function startBoundaryDrag(item: FlatPhoneItem, e: PointerEvent): void {
  e.preventDefault();
  e.stopPropagation();
  const baseClip = activeClip.value;
  if (!baseClip) return;
  const origClipSnapshot = JSON.parse(JSON.stringify(baseClip));
  const origAnchorsSnapshot = JSON.parse(JSON.stringify(store.project.value.phonation_anchors));
  const origPinsSnapshot = JSON.parse(JSON.stringify(store.project.value.f0_pins ?? []));
  const startClientX = e.clientX;
  const origEndSmp = item.seg.end_smp;
  const originalScale = pxPerSec.value;
  const pageScale = getCurrentPageScale();
  let previewFrame = 0;
  let clientX = startClientX;
  let blockedReason = '';

  const updatePreview = () => {
    previewFrame = 0;
    const dxPx = (clientX - startClientX) / pageScale;
    const dSmp = Math.round((dxPx / originalScale) * SAMPLE_RATE_HZ);
    if (!dSmp) {
      boundaryPreview.value = null;
      return;
    }
    const res = retime(
      origClipSnapshot,
      {
        clip_id: origClipSnapshot.id,
        syllable_id: item.syl.id,
        segment_id: item.seg.id,
        new_end_smp: origEndSmp + dSmp,
      },
      origAnchorsSnapshot,
      origPinsSnapshot,
    );
    if (!res.ok) {
      blockedReason = res.error.hint;
      rigidGuardMsg.value = res.error.hint;
      boundaryPreview.value = null;
      return;
    }
    blockedReason = '';
    rigidGuardMsg.value = '';
    boundaryPreview.value = res.value;
  };

  const onMove = (ev: PointerEvent) => {
    clientX = ev.clientX;
    if (!previewFrame) previewFrame = requestAnimationFrame(updatePreview);
  };
  const cleanup = registerDragCleanup(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cleanup);
    if (previewFrame) cancelAnimationFrame(previewFrame);
    boundaryPreview.value = null;
  });
  const onUp = (ev: PointerEvent) => {
    if (previewFrame) {
      cancelAnimationFrame(previewFrame);
      clientX = ev.clientX;
      updatePreview();
    }
    const retimed = boundaryPreview.value;
    cleanup();
    if (blockedReason) {
      store.pushToast(blockedReason, 'warning', 3800);
    }
    if (retimed && baseClip === activeClip.value) {
      store.executeCommand({
        type: 'clip.edit',
        label: `拖拽音素 [${item.seg.ipa}] 边界重定时`,
        payload: { clip: retimed.clip, retimed },
      });
    }
    window.clearTimeout(rigidGuardTimer);
    rigidGuardTimer = window.setTimeout(() => {
      rigidGuardMsg.value = '';
    }, 2600);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', cleanup);
}

// ===== Whole-Syllable Left/Right Boundary Drag (including single & final syllable, T-46) =====
function startSyllableBoundaryDrag(syl: Syllable, side: 'left' | 'right', e: PointerEvent): void {
  e.preventDefault();
  e.stopPropagation();
  const baseClip = activeClip.value;
  if (!baseClip) return;
  const origClipSnapshot = JSON.parse(JSON.stringify(baseClip)) as typeof baseClip;
  const origAnchorsSnapshot = JSON.parse(JSON.stringify(store.project.value.phonation_anchors));
  const origPinsSnapshot = JSON.parse(JSON.stringify(store.project.value.f0_pins ?? []));
  const startClientX = e.clientX;
  const origStartSmp = syl.start_smp;
  const origEndSmp = syl.end_smp;
  const syllOrderIdx = origClipSnapshot.syllable_order.indexOf(syl.id);
  const originalScale = pxPerSec.value;
  const pageScale = getCurrentPageScale();
  let previewFrame = 0;
  let clientX = startClientX;
  let blockedReason = '';
  let committedStart = origStartSmp;
  let committedEnd = origEndSmp;

  const updatePreview = () => {
    previewFrame = 0;
    const dxPx = (clientX - startClientX) / pageScale;
    const dSmp = Math.round((dxPx / originalScale) * SAMPLE_RATE_HZ);
    if (!dSmp) {
      boundaryPreview.value = null;
      return;
    }

    if (side === 'right') {
      const targetEnd = origEndSmp + dSmp;
      const res = retime(
        origClipSnapshot,
        {
          clip_id: origClipSnapshot.id,
          syllable_id: syl.id,
          new_start_smp: origStartSmp,
          new_end_smp: targetEnd,
        },
        origAnchorsSnapshot,
        origPinsSnapshot,
      );
      if (!res.ok) {
        blockedReason = res.error.hint;
        rigidGuardMsg.value = res.error.hint;
        boundaryPreview.value = null;
        return;
      }
      blockedReason = '';
      rigidGuardMsg.value = '';
      const lastSid = res.value.clip.syllable_order.at(-1);
      const lastEnd = lastSid ? res.value.clip.syllables[lastSid]?.end_smp ?? targetEnd : targetEnd;
      committedStart = origStartSmp;
      committedEnd = targetEnd;
      boundaryPreview.value = {
        ...res.value,
        clip: { ...res.value.clip, end_smp: Math.max(msToSamples(60), lastEnd) },
      };
    } else {
      const targetStart = Math.max(0, origStartSmp + dSmp);
      const prevSid = syllOrderIdx > 0 ? origClipSnapshot.syllable_order[syllOrderIdx - 1] : undefined;
      const prevSyl = prevSid ? origClipSnapshot.syllables[prevSid] : undefined;
      if (prevSyl && targetStart < prevSyl.end_smp) {
        const prevRes = retime(
          origClipSnapshot,
          { clip_id: origClipSnapshot.id, syllable_id: prevSyl.id, new_end_smp: targetStart },
          origAnchorsSnapshot,
          origPinsSnapshot,
        );
        if (!prevRes.ok) {
          blockedReason = prevRes.error.hint;
          rigidGuardMsg.value = prevRes.error.hint;
          boundaryPreview.value = null;
          return;
        }
        const curRes = retime(
          prevRes.value.clip,
          { clip_id: origClipSnapshot.id, syllable_id: syl.id, new_start_smp: targetStart, new_end_smp: origEndSmp },
          prevRes.value.phonation_anchors,
          prevRes.value.f0_pins,
        );
        if (!curRes.ok) {
          blockedReason = curRes.error.hint;
          rigidGuardMsg.value = curRes.error.hint;
          boundaryPreview.value = null;
          return;
        }
        blockedReason = '';
        rigidGuardMsg.value = '';
        const lastSid = curRes.value.clip.syllable_order.at(-1);
        const lastEnd = lastSid ? curRes.value.clip.syllables[lastSid]?.end_smp ?? curRes.value.clip.end_smp : curRes.value.clip.end_smp;
        committedStart = targetStart;
        committedEnd = origEndSmp;
        boundaryPreview.value = {
          ...curRes.value,
          clip: { ...curRes.value.clip, end_smp: Math.max(msToSamples(60), lastEnd) },
        };
      } else {
        const res = retime(
          origClipSnapshot,
          {
            clip_id: origClipSnapshot.id,
            syllable_id: syl.id,
            new_start_smp: targetStart,
            new_end_smp: origEndSmp,
          },
          origAnchorsSnapshot,
          origPinsSnapshot,
        );
        if (!res.ok) {
          blockedReason = res.error.hint;
          rigidGuardMsg.value = res.error.hint;
          boundaryPreview.value = null;
          return;
        }
        blockedReason = '';
        rigidGuardMsg.value = '';
        const lastSid = res.value.clip.syllable_order.at(-1);
        const lastEnd = lastSid ? res.value.clip.syllables[lastSid]?.end_smp ?? origEndSmp : origEndSmp;
        committedStart = targetStart;
        committedEnd = origEndSmp;
        boundaryPreview.value = {
          ...res.value,
          clip: { ...res.value.clip, end_smp: Math.max(msToSamples(60), lastEnd) },
        };
      }
    }
  };

  const onMove = (ev: PointerEvent) => {
    clientX = ev.clientX;
    if (!previewFrame) previewFrame = requestAnimationFrame(updatePreview);
  };
  const cleanup = registerDragCleanup(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cleanup);
    if (previewFrame) cancelAnimationFrame(previewFrame);
    boundaryPreview.value = null;
  });
  const onUp = (ev: PointerEvent) => {
    if (previewFrame) {
      cancelAnimationFrame(previewFrame);
      clientX = ev.clientX;
      updatePreview();
    }
    const hadPreview = Boolean(boundaryPreview.value);
    cleanup();
    if (blockedReason) {
      store.pushToast(blockedReason, 'warning', 3800);
    }
    if (hadPreview && baseClip === activeClip.value) {
      store.executeCommand({
        type: 'textgrid.set_boundary',
        label: `拖拽音节「${syl.text}」边界调整宽度`,
        payload: {
          clip_id: baseClip.id,
          syllable_id: syl.id,
          ...(side === 'left'
            ? { start_smp: committedStart, end_smp: committedEnd, keep_end: true }
            : { end_smp: committedEnd }),
        },
      });
    }
    window.clearTimeout(rigidGuardTimer);
    rigidGuardTimer = window.setTimeout(() => {
      rigidGuardMsg.value = '';
    }, 2600);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', cleanup);
}

// ===== Drag & Drop: TextGrid Tier Direct to M27 Reconstruct (T-04) vs Timeline Track Load (T-02) =====
const tgDropActive = ref(false);
const shellDropActive = ref(false);
const AUDIO_EXT_RE = /\.(wav|mp3|ogg|flac|m4a|aac|webm)$/i;

function isAudioFile(file: File): boolean {
  return AUDIO_EXT_RE.test(file.name) || file.type.startsWith('audio/');
}

function extractDroppedPayload(dt: DataTransfer | null): { files: File[]; corpusIds: string[] } {
  if (!dt) return { files: [], corpusIds: [] };
  const rawCorpus = dt.getData(CORPUS_DRAG_MIME);
  const corpusIds = rawCorpus ? rawCorpus.split(',').filter(Boolean) : [];
  const corpusFiles = corpusIds
    .map((id) => corpusDragFileRegistry.get(id))
    .filter((f): f is File => Boolean(f));
  const osFiles = Array.from(dt.files ?? []);
  return {
    files: corpusFiles.length > 0 ? corpusFiles : osFiles,
    corpusIds,
  };
}

function hasDragPayload(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  const types = Array.from(dt.types ?? []);
  return types.includes('Files') || types.includes(CORPUS_DRAG_MIME);
}

function onTgDragOver(e: DragEvent): void {
  if (!hasDragPayload(e.dataTransfer)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  tgDropActive.value = true;
  shellDropActive.value = false;
}

function onTgDragLeave(e: DragEvent): void {
  const cur = e.currentTarget as HTMLElement | null;
  const rel = e.relatedTarget as Node | null;
  if (cur && rel && cur.contains(rel)) return;
  tgDropActive.value = false;
}

function onTgDrop(e: DragEvent): void {
  e.preventDefault();
  e.stopPropagation();
  tgDropActive.value = false;
  shellDropActive.value = false;
  const { files, corpusIds } = extractDroppedPayload(e.dataTransfer);
  const audioFile = files.find(isAudioFile);
  if (audioFile) {
    // T-04: Dragging audio directly onto the TextGrid alignment tier jumps straight to M27 Reconstruction!
    sendWorkspaceAudio('m27Align', {
      file: audioFile,
      label: audioFile.name,
      sourceKind: 'audio-reconstruct',
    });
    return;
  }
  if (files.length > 0 || corpusIds.length > 0) {
    emit('corpus-drop', { files, corpusIds });
  }
}

function onShellDragOver(e: DragEvent): void {
  if (!hasDragPayload(e.dataTransfer)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  shellDropActive.value = true;
}

function onShellDragLeave(e: DragEvent): void {
  const cur = e.currentTarget as HTMLElement | null;
  const rel = e.relatedTarget as Node | null;
  if (cur && rel && cur.contains(rel)) return;
  shellDropActive.value = false;
}

function onShellDrop(e: DragEvent): void {
  e.preventDefault();
  shellDropActive.value = false;
  tgDropActive.value = false;
  const { files, corpusIds } = extractDroppedPayload(e.dataTransfer);
  if (files.length > 0 || corpusIds.length > 0) {
    emit('corpus-drop', { files, corpusIds });
  }
}

// ===== PHON Discrete 5-Lane Anchors Track =====
function phonLaneGeometry(trackH: number): { topPad: number; usable: number } {
  // Align expanded lanes with `.rt-phon-legend` directly below `.rt-hdr-top` (~28 px); keep 10 px pad collapsed so 16 px pills never clip.
  const topPad = phonExpanded.value ? 30 : 10;
  const bottomPad = 10;
  return { topPad, usable: Math.max(16, trackH - topPad - bottomPad) };
}

function phonLaneY(target: Pick<PhonationAnchor, 'regime' | 'voqs'> | string, trackH: number): number {
  const { topPad, usable } = phonLaneGeometry(trackH);
  const idx = voqsSynthesisLaneIndex(target);
  return topPad + (idx / Math.max(1, SYNTHESIS_VOQS_PROFILES.length - 1)) * usable;
}

const phonDraft = ref<PhonationAnchor | null>(null);
const displayPhonation = computed(() => {
  const draft = phonDraft.value;
  if (boundaryPreview.value) return Object.values(boundaryPreview.value.phonation_anchors).sort((a, b) => a.t_smp - b.t_smp);
  const anchors = store.phonationAnchors.value;
  return draft ? anchors.map((a) => a.id === draft.id ? draft : a).sort((a, b) => a.t_smp - b.t_smp) : anchors;
});
const visiblePhonation = computed(() => displayPhonation.value.filter((a) => inView(a.t_smp, a.t_smp)));
const phonPolylinePoints = computed(() => {
  const h = effPhonHeight.value;
  const anchors = displayPhonation.value;
  let y = phonLaneY('V', h);
  const points = [`0,${y}`];
  for (const anchor of anchors) {
    const x = smpToX(anchor.t_smp).toFixed(1);
    points.push(`${x},${y}`);
    y = phonLaneY(anchor, h);
    points.push(`${x},${y}`);
  }
  points.push(`${smpToX(totalDurationSmp.value)},${y}`);
  return points.join(' ');
});

function addPhonationAnchorAt(tSmp: number, symbol = 'V'): void {
  const profile = voqsProfile(symbol);
  if (!profile) return;
  const sample = Math.max(0, Math.min(totalDurationSmp.value, Math.round(tSmp)));
  writeRecordedVoqs(store, profile, profile.takes[0], sample);
}

function removeSelectedPhonationAnchor(): void {
  const id = store.selectedPhonationAnchorId.value;
  if (!id) return;
  const nextList = store.phonationAnchors.value.filter((a) => a.id !== id);
  const res = store.executeCommand({
    type: 'phonation.set_anchors',
    label: '删除发声类型锚点',
    payload: { anchors: nextList },
  });
  if (res.ok) store.selectedPhonationAnchorId.value = nextList[0]?.id ?? null;
}

function onPhonLanePointerDown(e: PointerEvent): void {
  if (e.button !== 0 || phonExpanded.value) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest('.phon-node, .rt-row-resizer')) return;
  startTimeRangeDrag(e, e.currentTarget as HTMLElement, () => {
    suppressNextPhonClick = true;
    window.clearTimeout(suppressPhonClickTimer);
    suppressPhonClickTimer = window.setTimeout(() => {
      suppressNextPhonClick = false;
    }, 0);
  });
}

function onPhonLaneClick(e: MouseEvent): void {
  if (suppressNextPhonClick) {
    suppressNextPhonClick = false;
    return;
  }
  if ((e.target as HTMLElement).closest('.phon-node')) return;
  const el = e.currentTarget as HTMLElement;
  const rect = el.getBoundingClientRect();
  const scale = getCurrentPageScale();
  const lx = (e.clientX - rect.left) / scale;
  const smp = xToSmp(lx);
  store.playheadSmp.value = smp;
  emit('playhead-scrub', smp);
  // Collapsed click only seeks playhead (double-click or header toggle expands track).
  if (!phonExpanded.value) return;
  const ly = (e.clientY - rect.top) / scale;
  const { topPad, usable } = phonLaneGeometry(effPhonHeight.value);
  const laneFrac = Math.max(0, Math.min(1, (ly - topPad) / usable));
  const profile = SYNTHESIS_VOQS_PROFILES[Math.round(laneFrac * (SYNTHESIS_VOQS_PROFILES.length - 1))];
  if (profile) addPhonationAnchorAt(smp, profile.symbol);
}

function startPhonDrag(anchor: PhonationAnchor, e: PointerEvent): void {
  e.preventDefault();
  e.stopPropagation();
  store.selectedPhonationAnchorId.value = anchor.id;
  const laneEl = (e.currentTarget as HTMLElement).closest('.phon-lane-canvas') as HTMLElement | null;
  if (!laneEl) return;
  const startY = e.clientY;
  let draftT = anchor.t_smp;
  const originalSymbol = voqsLane(anchor);
  const isInFiveLanes = SYNTHESIS_VOQS_PROFILES.some((p) => p.symbol === originalSymbol);
  let moved = false;

  const onMove = (ev: PointerEvent) => {
    moved = true;
    const rect = laneEl.getBoundingClientRect();
    const scale = getCurrentPageScale();
    const lx = (ev.clientX - rect.left) / scale;
    const ly = (ev.clientY - rect.top) / scale;
    draftT = xToSmp(lx);
    const dyPx = Math.abs(ev.clientY - startY) / scale;
    const allowLaneSwitch = (phonExpanded.value || isInFiveLanes) && dyPx >= 8;
    let change: Partial<PhonationAnchor> = {};
    if (allowLaneSwitch) {
      const { topPad, usable } = phonLaneGeometry(effPhonHeight.value);
      const laneFrac = Math.max(0, Math.min(1, (ly - topPad) / usable));
      const profile = SYNTHESIS_VOQS_PROFILES[Math.round(laneFrac * (SYNTHESIS_VOQS_PROFILES.length - 1))];
      if (profile && profile.symbol !== originalSymbol) {
        change = voqsAnchorPatch(profile);
      }
    }
    phonDraft.value = { ...anchor, ...change, t_smp: draftT };
  };

  const cleanup = registerDragCleanup(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cleanup);
    phonDraft.value = null;
  });

  const onUp = () => {
    const draft = phonDraft.value;
    cleanup();
    if (moved) {
      suppressNextPhonClick = true;
      window.clearTimeout(suppressPhonClickTimer);
      suppressPhonClickTimer = window.setTimeout(() => {
        suppressNextPhonClick = false;
      }, 0);
    }
    if (!draft || (draft.t_smp === anchor.t_smp && voqsLane(draft) === originalSymbol)) return;
    const updated = [...store.phonationAnchors.value.filter((a) => a.id !== anchor.id && a.t_smp !== draftT), draft];
    store.executeCommand({
      type: 'phonation.set_anchors',
      label: `移动发声类型锚点至 ${voqsAnchorLabel(draft)}`,
      payload: { anchors: updated },
    });
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', cleanup);
}

// ===== F0 Control Track (Adaptive Y-Axis Scaling + Manual Range Controls, T-65) =====
const f0AutoScale = ref(true);
const f0ManualMinHz = ref(90);
const f0ManualMaxHz = ref(320);

const f0AutoBounds = computed<{ min: number; max: number }>(() => {
  let lo = Infinity;
  let hi = -Infinity;
  const pushHz = (hz: number) => {
    if (isValidF0Hz(hz)) {
      if (hz < lo) lo = hz;
      if (hz > hi) hi = hz;
    }
  };

  // 1. Sample voiced frames of evaluated pitch contour across entire clip
  const ev = f0Eval.value;
  const phones = flatPhones.value;
  if (ev && ev.times_smp.length > 0) {
    let pIdx = 0;
    for (let i = 0; i < ev.times_smp.length; i++) {
      const smp = ev.times_smp[i];
      while (pIdx < phones.length && phones[pIdx].seg.end_smp <= smp) pIdx++;
      const ph = phones[pIdx]?.seg;
      const isVoiced = ph && ph.start_smp <= smp ? isSegmentVoicedAt(ph, smp) : false;
      if (isVoiced || phones.length === 0) {
        pushHz(ev.f0_hz[i]);
      }
    }
  }

  // 2. Include qTA targets of voiced syllables
  for (const syl of syllables.value) {
    if (!syl.segments.some((s) => isSegmentVoicedAt(s, s.end_smp - 1))) continue;
    for (const span of syl.targets) {
      const cand = span.candidates.user ?? span.candidates.default;
      if (!cand) continue;
      const durS = Math.max(0.03, ((span.end_smp ?? syl.end_smp) - (span.start_smp ?? syl.start_smp)) / SAMPLE_RATE_HZ);
      const startSt = cand.b_end_st - cand.m_st_per_s * durS;
      pushHz(stToHz(startSt, fRefHz.value));
      pushHz(stToHz(cand.b_end_st, fRefHz.value));
    }
  }

  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = Math.max(10, fRefHz.value * 0.72);
    hi = Math.max(lo + 30, fRefHz.value * 1.42);
  }

  const center = 0.5 * (lo + hi);
  const rawSpan = Math.max(48, (hi - lo) * 1.36);
  const minHz = Math.max(5, Math.floor((center - rawSpan * 0.5) / 5) * 5);
  const maxHz = Math.ceil((center + rawSpan * 0.5) / 5) * 5;
  return {
    min: minHz,
    max: Math.max(minHz + 30, maxHz),
  };
});

const f0ViewMinHz = computed(() => (f0AutoScale.value ? f0AutoBounds.value.min : f0ManualMinHz.value));
const f0ViewMaxHz = computed(() => (f0AutoScale.value ? f0AutoBounds.value.max : f0ManualMaxHz.value));

const f0AxisTicks = computed<number[]>(() => {
  const lo = f0ViewMinHz.value;
  const hi = f0ViewMaxHz.value;
  const mid = Math.round(Math.sqrt(lo * hi) / 5) * 5;
  return [Math.round(lo), mid, Math.round(hi)];
});

function toggleF0AutoScale(): void {
  if (!f0AutoScale.value) {
    f0AutoScale.value = true;
    return;
  }
  f0ManualMinHz.value = f0AutoBounds.value.min;
  f0ManualMaxHz.value = f0AutoBounds.value.max;
  f0AutoScale.value = false;
}

function zoomF0VerticalRange(factor: number): void {
  const curLo = f0ViewMinHz.value;
  const curHi = f0ViewMaxHz.value;
  const center = Math.sqrt(curLo * curHi);
  const halfRatio = Math.pow(curHi / Math.max(1, curLo), 0.5 * factor);
  let nextLo = Math.round((center / halfRatio) / 5) * 5;
  let nextHi = Math.round((center * halfRatio) / 5) * 5;
  nextLo = Math.max(5, nextLo);
  nextHi = Math.max(nextLo + 15, nextHi);
  f0ManualMinHz.value = nextLo;
  f0ManualMaxHz.value = nextHi;
  f0AutoScale.value = false;
}

function onF0LaneWheel(e: WheelEvent): void {
  if (!e.altKey) return;
  e.preventDefault();
  e.stopPropagation();
  zoomF0VerticalRange(e.deltaY > 0 ? 1.18 : 1 / 1.18);
}

function hzToF0Y(hz: number, h: number): number {
  const pad = 6;
  const vMin = f0ViewMinHz.value;
  const vMax = Math.max(vMin + 10, f0ViewMaxHz.value);
  const clamped = Math.max(vMin, Math.min(vMax, hz));
  const norm = Math.log2(clamped / vMin) / Math.max(1e-6, Math.log2(vMax / vMin));
  return pad + (1 - norm) * Math.max(12, h - pad * 2);
}

function f0YToHz(y: number, h: number): number {
  const pad = 6;
  const vMin = f0ViewMinHz.value;
  const vMax = Math.max(vMin + 10, f0ViewMaxHz.value);
  const norm = Math.max(0, Math.min(1, 1 - (y - pad) / Math.max(12, h - pad * 2)));
  const hz = vMin * Math.pow(vMax / vMin, norm);
  return Math.round(Math.max(1, hz) * 10) / 10;
}

/** Strip or trim `f0_pins` segments that cover `[startSmp, endSmp]` so qTA target edits immediately drive synthesis F0 (T-14). */
function stripPinsOverlappingRange(
  pins: readonly F0PinSegment[],
  startSmp: number,
  endSmp: number,
): F0PinSegment[] {
  const out: F0PinSegment[] = [];
  for (const pin of pins) {
    if (pin.end_smp <= startSmp || pin.start_smp >= endSmp) {
      out.push(pin);
      continue;
    }
    const leftPts = pin.points.filter((pt) => pt.t_smp < startSmp);
    const rightPts = pin.points.filter((pt) => pt.t_smp > endSmp);
    if (leftPts.length >= 2) {
      out.push({
        ...pin,
        id: `${pin.id}_L`,
        start_smp: leftPts[0].t_smp,
        end_smp: leftPts[leftPts.length - 1].t_smp,
        points: leftPts,
      });
    }
    if (rightPts.length >= 2) {
      out.push({
        ...pin,
        id: `${pin.id}_R`,
        start_smp: rightPts[0].t_smp,
        end_smp: rightPts[rightPts.length - 1].t_smp,
        points: rightPts,
      });
    }
  }
  return out;
}

const f0TargetDragPreview = shallowRef<{
  sylId: string;
  targets: QtaTargetSpan[];
  strippedPins: F0PinSegment[];
} | null>(null);

const effectiveSyllablesForF0 = computed(() => {
  const drag = f0TargetDragPreview.value;
  if (!drag) return syllables.value;
  return syllables.value.map((s) => (s.id === drag.sylId ? { ...s, targets: drag.targets } : s));
});

// The displayed curve always uses the same pins as synthesis (annotation-audio.ts),
// so what is drawn is what is heard. With the “钉住” capsule off, the unpinned
// qTA rule curve is added as a faint comparison line (f0RulePath).
const f0RuleEval = computed(() => {
  if (showF0Pins.value || !(store.project.value.f0_pins?.length)) return null;
  const result = evaluateControlPitch(store.project.value, effectiveSyllablesForF0.value, totalDurationSmp.value, fRefHz.value, false);
  return result.ok ? result.value : null;
});

const f0Eval = computed(() => {
  const drag = f0TargetDragPreview.value;
  const project = drag
    ? { ...store.project.value, f0_pins: drag.strippedPins }
    : boundaryPreview.value
      ? { ...store.project.value, f0_pins: boundaryPreview.value.f0_pins }
      : store.project.value;
  const result = evaluateControlPitch(project, effectiveSyllablesForF0.value, totalDurationSmp.value, fRefHz.value, true);
  return result.ok ? result.value : null;
});

function sendPitchToPiano() {
  const ev = f0Eval.value;
  if (!ev) return;
  const segments = flatPhones.value;
  const points: { t_smp: number; f0_hz: number }[] = [];
  let index = 0;
  for (let i = 0; i < ev.times_smp.length; i++) {
    const time = ev.times_smp[i];
    while (index < segments.length && segments[index].seg.end_smp <= time) index++;
    const seg = segments[index]?.seg;
    if (seg && seg.start_smp <= time && isSegmentVoicedAt(seg, time) && ev.f0_hz[i] > 0) points.push({ t_smp: time, f0_hz: ev.f0_hz[i] });
  }
  if (points.length) emit('send-pitch', points);
  else store.pushToast('当前基频轨没有可定音的有声帧', 'info');
}

const f0Curves = computed(() => {
  const ev = f0Eval.value;
  if (!ev) return { voicedPaths: [] as string[], unvoicedPaths: [] as string[], perturbBandPaths: [] as string[] };
  const h = effF0Height.value;
  const phones = visiblePhones.value;
  const points: F0CurvePoint[] = [];
  const voicedRuns: Array<Array<{ x: number; hz: number; sample: number }>> = [];
  let currentRun: Array<{ x: number; hz: number; sample: number }> = [];
  let phoneIndex = 0;
  const first = Math.max(0, Math.floor(viewStartSmp.value / 480) - 1);
  const last = Math.min(ev.times_smp.length, Math.ceil(viewEndSmp.value / 480) + 2);
  for (let i = first; i < last; i++) {
    const sample = ev.times_smp[i];
    while (phoneIndex < phones.length && phones[phoneIndex].seg.end_smp <= sample) phoneIndex++;
    const phone = phones[phoneIndex]?.seg;
    const voiced = phone && phone.start_smp <= sample
      ? isSegmentVoicedAt(phone, sample)
      : flatPhones.value.length === 0;
    const x = smpToX(sample);
    points.push({ x, y: hzToF0Y(ev.f0_hz[i], h), voiced });
    if (voiced) {
      currentRun.push({ x, hz: ev.f0_hz[i], sample });
    } else if (currentRun.length > 0) {
      if (currentRun.length >= 2) voicedRuns.push(currentRun);
      currentRun = [];
    }
  }
  if (currentRun.length >= 2) voicedRuns.push(currentRun);

  // Build subtle flutter perturbation envelope band when Perturbation is active (T-14)
  const perturbBandPaths: string[] = [];
  if (perturbEnabled.value) {
    const flutterAmt = Math.max(8, store.project.value.perturbation?.flutter ?? 20);
    const semiSpan = 0.22 + (flutterAmt / 100) * 0.45;
    for (const run of voicedRuns) {
      const upper = run.map((pt, idx) => {
        const micro = 1 + 0.35 * Math.sin(pt.sample * 0.0085 + idx * 1.7);
        const hiHz = pt.hz * Math.pow(2, (semiSpan * micro) / 12);
        return `${pt.x.toFixed(1)},${hzToF0Y(hiHz, h).toFixed(1)}`;
      });
      const lower = [...run].reverse().map((pt, idx) => {
        const micro = 1 + 0.35 * Math.cos(pt.sample * 0.0092 + idx * 1.5);
        const loHz = pt.hz * Math.pow(2, (-semiSpan * micro) / 12);
        return `${pt.x.toFixed(1)},${hzToF0Y(loHz, h).toFixed(1)}`;
      });
      perturbBandPaths.push(`M ${upper.join(' L ')} L ${lower.join(' L ')} Z`);
    }
  }

  // Voiced and unvoiced paths share boundary points: one continuous curve.
  return { ...buildF0CurvePaths(points), perturbBandPaths };
});

const f0RulePath = computed(() => {
  const ev = f0RuleEval.value;
  if (!ev) return '';
  const h = effF0Height.value;
  const first = Math.max(0, Math.floor(viewStartSmp.value / 480) - 1);
  const last = Math.min(ev.times_smp.length, Math.ceil(viewEndSmp.value / 480) + 2);
  const points: F0CurvePoint[] = [];
  for (let i = first; i < last; i++) points.push({ x: smpToX(ev.times_smp[i]), y: hzToF0Y(ev.f0_hz[i], h), voiced: true });
  return buildF0CurvePaths(points).voicedPaths.join(' ');
});

const f0TargetLines = computed(() => {
  const h = effF0Height.value;
  const drag = f0TargetDragPreview.value;
  return visibleSyllables.value.flatMap((rawSyl) => {
    const syl = drag && drag.sylId === rawSyl.id ? { ...rawSyl, targets: drag.targets } : rawSyl;
    const spans = syl.targets.length > 0
      ? syl.targets
      : [
          {
            id: `${syl.id}_auto`,
            span_id: syl.id,
            start_smp: syl.start_smp,
            end_smp: syl.end_smp,
            voiced: true,
            candidates: { default: { m_st_per_s: 0, b_end_st: 0, lambda_per_s: 32, source: 'default' as const } },
          },
        ];
    return spans.map((span, targetIdx) => {
      const cand = span.candidates.user ?? span.candidates.default ?? { m_st_per_s: 0, b_end_st: 0, lambda_per_s: 32 };
      const s0 = span.start_smp ?? syl.start_smp;
      const s1 = span.end_smp ?? syl.end_smp;
      const durS = Math.max(0.03, (s1 - s0) / SAMPLE_RATE_HZ);
      const startSt = cand.b_end_st - cand.m_st_per_s * durS;
      const hz0 = stToHz(startSt, fRefHz.value);
      const hz1 = stToHz(cand.b_end_st, fRefHz.value);
      return {
        key: `${syl.id}_${targetIdx}`,
        syl,
        targetIdx,
        x1: smpToX(s0),
        y1: hzToF0Y(hz0, h),
        x2: smpToX(s1),
        y2: hzToF0Y(hz1, h),
        hzEnd: Math.round(hz1),
      };
    });
  });
});

// Hand-draw F0 brush stroke
const f0DraftPts = ref<Array<{ t_smp: number; f0_hz: number }>>([]);
const f0DraftPath = computed(() => {
  if (f0DraftPts.value.length < 2) return '';
  const h = effF0Height.value;
  return f0DraftPts.value
    .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${smpToX(pt.t_smp).toFixed(1)},${hzToF0Y(pt.f0_hz, h).toFixed(1)}`)
    .join(' ');
});

function upsertMonotonicStrokePoint<T extends { t_smp: number }>(
  list: T[],
  nextPt: T,
  prevT: number | null,
  minStepSmp: number,
): T[] {
  if (list.length === 0) return [nextPt];
  if (prevT !== null && Math.abs(nextPt.t_smp - prevT) < minStepSmp) {
    return list;
  }
  const lo = prevT !== null ? Math.min(prevT, nextPt.t_smp) : nextPt.t_smp;
  const hi = prevT !== null ? Math.max(prevT, nextPt.t_smp) : nextPt.t_smp;
  // Overwrite any points inside the swept time interval so backtracking redraws smoothly without zigzags.
  const kept = list.filter((pt) => pt.t_smp < lo || pt.t_smp > hi);
  if (prevT !== null) {
    const anchor = list.find((pt) => pt.t_smp === prevT);
    if (anchor && !kept.some((pt) => pt.t_smp === anchor.t_smp)) kept.push(anchor);
  }
  kept.push(nextPt);
  kept.sort((a, b) => a.t_smp - b.t_smp);
  return kept;
}

function onF0PointerDown(e: PointerEvent): void {
  const el = e.currentTarget as HTMLElement;
  if (!f0DrawMode.value) {
    startTimeRangeDrag(e, el);
    return;
  }
  e.preventDefault();
  el.setPointerCapture?.(e.pointerId);
  let lastPointerT: number | null = null;
  const addPoint = (ev: PointerEvent) => {
    const rect = el.getBoundingClientRect();
    const scale = getCurrentPageScale();
    const lx = (ev.clientX - rect.left) / scale;
    const ly = (ev.clientY - rect.top) / scale;
    const tSmp = xToSmp(lx);
    const hz = f0YToHz(ly, effF0Height.value);
    const next = upsertMonotonicStrokePoint(f0DraftPts.value, { t_smp: tSmp, f0_hz: hz }, lastPointerT, 480);
    if (next !== f0DraftPts.value) {
      f0DraftPts.value = next;
      lastPointerT = tSmp;
    }
  };
  f0DraftPts.value = [];
  addPoint(e);

  const onMove = (ev: PointerEvent) => addPoint(ev);
  const cleanup = registerDragCleanup(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cleanup);
    f0DraftPts.value = [];
  });
  const onUp = () => {
    const sorted = [...f0DraftPts.value];
    cleanup();
    if (sorted.length >= 2 && sorted[sorted.length - 1].t_smp > sorted[0].t_smp) {
      showF0Pins.value = true;
      const startSmp = sorted[0].t_smp;
      const endSmp = sorted[sorted.length - 1].t_smp;
      const origPins = store.project.value.f0_pins ?? [];
      const hasOverlap = origPins.some((p) => p.end_smp > startSmp && p.start_smp < endSmp);
      if (hasOverlap) {
        const nextProject = JSON.parse(JSON.stringify(store.project.value));
        const trimmed = stripPinsOverlappingRange(origPins, startSmp, endSmp);
        trimmed.push({
          id: `pin_${crypto.randomUUID()}`,
          start_smp: startSmp,
          end_smp: endSmp,
          points: sorted,
          transition_ms: 30,
          exit_fit_ms: 35,
        });
        nextProject.f0_pins = trimmed;
        const res = store.executeCommand({
          type: 'project.replace',
          label: `手绘 F0 曲线 (${sorted.length} 点)`,
          payload: { project: nextProject },
        });
        if (res.ok) invalidateSynthesisBufferIfNeeded();
      } else {
        const res = store.executeCommand({
          type: 'f0.draw',
          label: `手绘 F0 曲线 (${sorted.length} 点)`,
          payload: { points: sorted },
        });
        if (res.ok) invalidateSynthesisBufferIfNeeded();
      }
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', cleanup);
}

function startF0TargetDrag(syl: Syllable, targetIdx: number, e: PointerEvent): void {
  if (f0DrawMode.value) return;
  e.preventDefault();
  e.stopPropagation();
  const laneEl = (e.currentTarget as HTMLElement).closest('.f0-lane-canvas') as HTMLElement | null;
  if (!laneEl) return;
  const origPins = store.project.value.f0_pins ?? [];
  const strippedPins = stripPinsOverlappingRange(origPins, syl.start_smp, syl.end_smp);
  const baseTargets: QtaTargetSpan[] =
    syl.targets.length > 0
      ? JSON.parse(JSON.stringify(syl.targets))
      : [
          {
            id: `${syl.id}_t0`,
            span_id: syl.id,
            start_smp: syl.start_smp,
            end_smp: syl.end_smp,
            voiced: true,
            candidates: { default: { m_st_per_s: 0, b_end_st: 0, lambda_per_s: 32, source: 'default' } },
          },
        ];

  let lastHz = fRefHz.value;
  let moved = false;

  const onMove = (ev: PointerEvent) => {
    moved = true;
    const rect = laneEl.getBoundingClientRect();
    const scale = getCurrentPageScale();
    const ly = (ev.clientY - rect.top) / scale;
    lastHz = f0YToHz(ly, effF0Height.value);
    const nextTargets = JSON.parse(JSON.stringify(baseTargets)) as QtaTargetSpan[];
    const targetSpan = nextTargets[targetIdx] ?? nextTargets[0];
    if (targetSpan) {
      const prev = targetSpan.candidates.user ?? targetSpan.candidates.default;
      targetSpan.candidates.user = {
        m_st_per_s: prev?.m_st_per_s ?? 0,
        b_end_st: Number(hzToSt(lastHz, fRefHz.value).toFixed(2)),
        lambda_per_s: prev?.lambda_per_s ?? 32,
        source: 'user',
      };
    }
    f0TargetDragPreview.value = { sylId: syl.id, targets: nextTargets, strippedPins };
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    const preview = f0TargetDragPreview.value;
    f0TargetDragPreview.value = null;
    if (!moved || !preview) return;

    const pinsHadOverlap = origPins.some((p) => p.end_smp > syl.start_smp && p.start_smp < syl.end_smp);
    if (pinsHadOverlap || targetIdx > 0) {
      const nextProject = JSON.parse(JSON.stringify(store.project.value));
      nextProject.f0_pins = preview.strippedPins;
      const nextClip = nextProject.clips[store.activeClipId.value];
      if (nextClip?.syllables[syl.id]) {
        nextClip.syllables[syl.id].targets = preview.targets;
      }
      const res = store.executeCommand({
        type: 'project.replace',
        label: `调整 ${syl.text} qTA 靶点 ${Math.round(lastHz)} Hz（自动解除覆盖钉住段）`,
        payload: { project: nextProject },
      });
      if (res.ok) invalidateSynthesisBufferIfNeeded();
      return;
    }

    const res = store.executeCommand({
      type: 'f0.set_targets',
      label: `调整 ${syl.text} qTA 靶点 ${Math.round(lastHz)} Hz`,
      payload: {
        clip_id: store.activeClipId.value,
        syllable_id: syl.id,
        f0_hz: lastHz,
        b_end_st: Number(hzToSt(lastHz, fRefHz.value).toFixed(2)),
      },
    });
    if (res.ok) invalidateSynthesisBufferIfNeeded();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// ===== PS Subglottal Pressure Track (0-1600 Pa, unlimited dense hand-draw) =====
function paToPsY(pa: number, h: number): number {
  const pad = 5;
  const clamped = Math.max(PRESSURE_LIMIT_PA.min, Math.min(PRESSURE_LIMIT_PA.max, pa));
  const norm = clamped / PRESSURE_LIMIT_PA.max;
  return pad + (1 - norm) * Math.max(10, h - pad * 2);
}

function psYToPa(y: number, h: number): number {
  const pad = 5;
  const norm = Math.max(0, Math.min(1, 1 - (y - pad) / Math.max(10, h - pad * 2)));
  return Math.round(norm * PRESSURE_LIMIT_PA.max);
}

const psPaths = computed<{ linePaths: string[]; areaPaths: string[] }>(() => {
  const h = effPsHeight.value;
  const linePaths: string[] = [];
  const areaPaths: string[] = [];
  for (const syl of visibleSyllables.value) {
    if (syl.segments.length > 0 && syl.segments.every((s) => s.role === 'rest' || s.ipa === 'sil')) continue;
    const arr = syl.overrides.pressure?.length
      ? syl.overrides.pressure
      : [
          { u: 0, pressure_pa: 640 },
          { u: 0.4, pressure_pa: 820 },
          { u: 1, pressure_pa: 520 },
        ];
    const span = Math.max(1, syl.end_smp - syl.start_smp);
    const coords = arr.map((pt) => {
      const x = smpToX(syl.start_smp + pt.u * span);
      const y = paToPsY(pt.pressure_pa, h);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    if (coords.length < 2) continue;
    const firstX = coords[0].split(',')[0];
    const lastX = coords[coords.length - 1].split(',')[0];
    linePaths.push(`M ${coords.join(' L ')}`);
    areaPaths.push(`M ${firstX},${h} L ${coords.join(' L ')} L ${lastX},${h} Z`);
  }
  return { linePaths, areaPaths };
});

const psDraftPts = ref<Array<{ t_smp: number; pressure_pa: number }>>([]);
const psDraftPath = computed(() => {
  if (psDraftPts.value.length < 2) return '';
  const h = effPsHeight.value;
  return psDraftPts.value
    .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${smpToX(pt.t_smp).toFixed(1)},${paToPsY(pt.pressure_pa, h).toFixed(1)}`)
    .join(' ');
});

function onPsPointerDown(e: PointerEvent): void {
  const el = e.currentTarget as HTMLElement;
  if (!psDrawMode.value) {
    startTimeRangeDrag(e, el);
    return;
  }
  e.preventDefault();
  el.setPointerCapture?.(e.pointerId);
  let lastPointerT: number | null = null;
  const addPoint = (ev: PointerEvent) => {
    const rect = el.getBoundingClientRect();
    const scale = getCurrentPageScale();
    const lx = (ev.clientX - rect.left) / scale;
    const ly = (ev.clientY - rect.top) / scale;
    const tSmp = xToSmp(lx);
    const pa = psYToPa(ly, effPsHeight.value);
    const next = upsertMonotonicStrokePoint(psDraftPts.value, { t_smp: tSmp, pressure_pa: pa }, lastPointerT, 240);
    if (next !== psDraftPts.value) {
      psDraftPts.value = next;
      lastPointerT = tSmp;
    }
  };
  psDraftPts.value = [];
  addPoint(e);

  const onMove = (ev: PointerEvent) => addPoint(ev);
  const cleanup = registerDragCleanup(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cleanup);
    psDraftPts.value = [];
  });
  const onUp = () => {
    const pts = [...psDraftPts.value];
    cleanup();
    const clip = activeClip.value;
    if (!clip || pts.length < 2) return;
    const cloned = JSON.parse(JSON.stringify(clip));
    let avgPa = 0;
    for (const p of pts) avgPa += p.pressure_pa;
    avgPa = Math.round(avgPa / pts.length);

    let updatedCount = 0;
    for (const sid of cloned.syllable_order) {
      const syl = cloned.syllables[sid];
      if (!syl) continue;
      const inRange = pts.filter((p) => p.t_smp >= syl.start_smp && p.t_smp <= syl.end_smp);
      if (inRange.length >= 2) {
        const span = Math.max(1, syl.end_smp - syl.start_smp);
        syl.overrides.pressure = inRange.map((p) => ({
          u: Number(Math.max(0, Math.min(1, (p.t_smp - syl.start_smp) / span)).toFixed(4)),
          pressure_pa: p.pressure_pa,
        }));
        updatedCount++;
      }
    }
    if (updatedCount === 0) {
      store.pushToast('请在包含音节的区间内手绘声门下压曲线', 'info', 2400);
      return;
    }
    const res = store.executeCommand({
      type: 'batch',
      label: `手绘 PS 声门下压曲线 (${pts.length} 点, 均值 ${avgPa} Pa)`,
      payload: {
        commands: [
          { type: 'clip.edit', payload: { clip: cloned } },
          { type: 'voice.set_pressure', payload: { pressure_pa: avgPa } },
        ],
      },
    });
    if (res.ok) invalidateSynthesisBufferIfNeeded();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', cleanup);
}

// Draw decoded samples on the same time axis as the annotation tracks.
const waveformBars = computed(() => {
  const buf = store.annotationAudioBuffer.value;
  if (!buf || !buf.length) return [];
  const ch = buf.getChannelData(0);
  const barStep = 4;
  const from = smpToX(store.annotationAudioOffsetSmp.value);
  const extent = Math.min(viewRight.value, from + pxPerSec.value * buf.duration);
  const samplesPerPixel = buf.sampleRate / pxPerSec.value;
  const gain = waveBoost3db.value ? 10 ** (3 / 20) : 1;
  const bars: Array<{ x: number; amp: number }> = [];
  for (let x = from + Math.max(0, Math.floor((viewLeft.value - from) / barStep) * barStep); x < extent; x += barStep) {
    let peak = 0;
    const start = Math.max(0, Math.floor((x - from) * samplesPerPixel));
    const end = Math.min(ch.length, Math.ceil((x - from + barStep) * samplesPerPixel));
    const stride = Math.max(1, Math.floor((end - start) / 48));
    for (let j = start; j < end; j += stride) peak = Math.max(peak, Math.abs(ch[j]));
    bars.push({ x, amp: Math.min(1, peak * gain) });
  }
  return bars;
});

// ===== Independent Per-Track Bottom-Edge Vertical Height Resizing =====
const plainTrackHeights = { tg: hTextgrid, art: hArt, wave: hWave };
const collapsedPlainHeights = ref<Partial<Record<keyof typeof plainTrackHeights, number>>>({});
function togglePlainTrack(track: keyof typeof plainTrackHeights) {
  const height = plainTrackHeights[track];
  const previous = collapsedPlainHeights.value[track];
  if (previous !== undefined) {
    height.value = previous;
    delete collapsedPlainHeights.value[track];
  } else {
    collapsedPlainHeights.value[track] = height.value;
    height.value = Math.min(240, height.value + 64);
  }
}

function startTrackResize(trackKey: 'tg' | 'art' | 'phon' | 'f0' | 'ps' | 'wave', e: PointerEvent): void {
  e.preventDefault();
  e.stopPropagation();
  const targetRef = {
    tg: hTextgrid,
    art: hArt,
    phon: hPhon,
    f0: hF0,
    ps: hPs,
    wave: hWave,
  }[trackKey];
  const minH = { tg: 50, art: 26, phon: 40, f0: 46, ps: 32, wave: 34 }[trackKey];
  const maxH = 240;
  const startY = e.clientY;
  const startH =
    trackKey === 'phon' ? effPhonHeight.value : trackKey === 'f0' ? effF0Height.value
      : trackKey === 'ps' ? effPsHeight.value : targetRef.value;

  const onMove = (ev: PointerEvent) => {
    const scale = getCurrentPageScale();
    const dy = (ev.clientY - startY) / scale;
    const next = Math.round(Math.max(minH, Math.min(maxH, startH + dy)));
    targetRef.value = next;
    if (trackKey === 'phon') {
      phonExpanded.value = next >= 120;
      if (!phonExpanded.value) collapsedSpecialHeights.value.phon = next;
    }
    if (trackKey === 'f0') {
      f0Expanded.value = next >= 140;
      if (!f0Expanded.value) collapsedSpecialHeights.value.f0 = next;
    }
    if (trackKey === 'ps') {
      psExpanded.value = next >= 140;
      if (!psExpanded.value) collapsedSpecialHeights.value.ps = next;
    }
  };
  const onUp = registerDragCleanup(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  });
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

// ===== Ctrl + Wheel Horizontal Zoom =====
function changeZoom(delta: number, originX = laneWidth.value / 2): void {
  const scroller = lanesScrollRef.value;
  const sample = xToSmp((scroller?.scrollLeft ?? 0) + originX);
  hZoom.value = Math.max(zoomMin, Math.min(zoomMax, Number((hZoom.value * delta).toFixed(2))));
  void nextTick(() => {
    if (scroller) scroller.scrollLeft = Math.max(0, smpToX(sample) - originX);
  });
}

function setZoomAnchored(nextZoom: number): void {
  if (!Number.isFinite(nextZoom) || nextZoom <= 0) return;
  const clamped = Math.max(zoomMin, Math.min(zoomMax, Number(nextZoom.toFixed(2))));
  if (Math.abs(clamped - hZoom.value) < 1e-4) return;
  const scroller = lanesScrollRef.value;
  const originX = laneWidth.value * 0.5;
  const sample = xToSmp((scroller?.scrollLeft ?? 0) + originX);
  hZoom.value = clamped;
  void nextTick(() => {
    if (scroller) scroller.scrollLeft = Math.max(0, smpToX(sample) - originX);
  });
}

function onTimelineWheel(e: WheelEvent): void {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const left = lanesScrollRef.value?.getBoundingClientRect().left ?? 0;
  const origin = Math.max(0, (e.clientX - left) / getCurrentPageScale() - (headerRef.value?.offsetWidth ?? 0));
  changeZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, origin);
}

// ===== Interactive Time Range Selection & Cut / Silence Trim (T-63) =====
const cutSelectionSmp = ref<{ startSmp: number; endSmp: number } | null>(null);

const effectiveCutRangeSmp = computed<{ startSmp: number; endSmp: number; source: 'range' | 'selection' } | null>(() => {
  if (cutSelectionSmp.value && cutSelectionSmp.value.endSmp - cutSelectionSmp.value.startSmp >= msToSamples(15)) {
    return { ...cutSelectionSmp.value, source: 'range' };
  }
  const phones = flatPhones.value.filter(({ seg }) => selectedPhoneSet.value.has(seg.id)).map(({ seg }) => seg);
  if (phones.length > 0) {
    const startSmp = phones[0].start_smp;
    const endSmp = phones[phones.length - 1].end_smp;
    if (endSmp - startSmp >= msToSamples(15)) return { startSmp, endSmp, source: 'selection' };
  }
  const words = syllables.value.filter((syl) => selectedSyllableSet.value.has(syl.id));
  if (words.length > 0) {
    const startSmp = words[0].start_smp;
    const endSmp = words[words.length - 1].end_smp;
    if (endSmp - startSmp >= msToSamples(15)) return { startSmp, endSmp, source: 'selection' };
  }
  if (store.selectedSyllableId.value) {
    const singleSyl = syllables.value.find((s) => s.id === store.selectedSyllableId.value);
    if (singleSyl && singleSyl.end_smp - singleSyl.start_smp >= msToSamples(15)) {
      return { startSmp: singleSyl.start_smp, endSmp: singleSyl.end_smp, source: 'selection' };
    }
  }
  return null;
});

function triggerCutSelectedRange(): void {
  const target = effectiveCutRangeSmp.value;
  if (!target) {
    store.pushToast('请在波形轨拖拽框选区间，或先选中需要剪切的静音段/音素/音节', 'info');
    return;
  }
  emit('cut-range', { startSmp: target.startSmp, endSmp: target.endSmp });
  cutSelectionSmp.value = null;
}

function startTimeRangeDrag(
  e: PointerEvent,
  el: HTMLElement,
  onDragged?: () => void,
): void {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest('.rt-row-resizer, .kf-dot, .f0-target-dot, .phon-node, .rt-playhead-handle')) return;
  const startClientX = e.clientX;
  const startSmp = xToSmp(localXFromPointer(e, el));
  let dragged = false;
  try {
    el.setPointerCapture?.(e.pointerId);
  } catch {
    // ignore
  }
  const onMove = (ev: PointerEvent) => {
    if (!dragged && Math.abs(ev.clientX - startClientX) < 4) return;
    if (!dragged) {
      dragged = true;
      onDragged?.();
    }
    const curSmp = xToSmp(localXFromPointer(ev, el));
    if (curSmp !== startSmp) {
      cutSelectionSmp.value = {
        startSmp: Math.min(startSmp, curSmp),
        endSmp: Math.max(startSmp, curSmp),
      };
    } else {
      cutSelectionSmp.value = null;
    }
    store.playheadSmp.value = curSmp;
    emit('playhead-scrub', curSmp);
  };
  const cleanup = registerDragCleanup(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', cleanup);
    try {
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  });
  const onUp = (ev: PointerEvent) => {
    cleanup();
    const endSmp = xToSmp(localXFromPointer(ev, el));
    if (!dragged) {
      cutSelectionSmp.value = null;
      store.playheadSmp.value = endSmp;
      emit('playhead-scrub', endSmp);
    } else if (endSmp !== startSmp) {
      cutSelectionSmp.value = {
        startSmp: Math.min(startSmp, endSmp),
        endSmp: Math.max(startSmp, endSmp),
      };
      store.playheadSmp.value = endSmp;
      emit('playhead-scrub', endSmp);
    } else {
      cutSelectionSmp.value = null;
      store.playheadSmp.value = endSmp;
      emit('playhead-scrub', endSmp);
    }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', cleanup);
}

function startPlayheadScrub(e: PointerEvent): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const rulerEl = (e.currentTarget as HTMLElement).closest('.rt-ruler') as HTMLElement | null;
  if (!rulerEl) return;
  const update = (ev: PointerEvent) => {
    const smp = xToSmp(localXFromPointer(ev, rulerEl));
    store.playheadSmp.value = smp;
    emit('playhead-scrub', smp);
  };
  update(e);
  const onMove = (ev: PointerEvent) => update(ev);
  const cleanup = registerDragCleanup(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', cleanup);
    window.removeEventListener('pointercancel', cleanup);
  });
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', cleanup);
  window.addEventListener('pointercancel', cleanup);
}

function onWavePointerDown(e: PointerEvent): void {
  startTimeRangeDrag(e, e.currentTarget as HTMLElement);
}

function onArtPointerDown(e: PointerEvent): void {
  startTimeRangeDrag(e, e.currentTarget as HTMLElement);
}

const timelineClipboard = shallowRef<AnnotationClipboardPayload | null>(null);

function editContextMenuPhone(): void {
  const target = phoneContextMenu.value;
  phoneContextMenu.value = null;
  if (target) void openAnnotationEdit(target.syl, target.seg);
}

function activeSyllableSelectionIds(): string[] {
  if (selectedSyllableIds.value.length) return [...selectedSyllableIds.value];
  if (store.selectedPhonemeIds.value.length === 0 && store.selectedSyllableId.value) {
    return [store.selectedSyllableId.value];
  }
  return [];
}

function copyTimelineSelection(): boolean {
  const clip = activeClip.value;
  if (!clip) return false;
  const payload = copyAnnotationSelection(
    clip,
    {
      range: cutSelectionSmp.value,
      phoneIds: store.selectedPhonemeIds.value,
      syllableIds: activeSyllableSelectionIds(),
    },
    store.project.value,
  );
  if (!payload) return false;
  timelineClipboard.value = payload;
  const plain = payload.kind === 'syllables'
    ? payload.syllables.map((s) => s.text).join(' ')
    : payload.segments.map((s) => s.ipa).join('');
  if (plain && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(plain).catch(() => {});
  }
  store.pushToast(`已复制 ${payload.summary}（Ctrl+V 粘贴）`, 'success', 2000);
  return true;
}

function pasteTimelineClipboard(explicitPayload?: AnnotationClipboardPayload): boolean {
  const clip = activeClip.value;
  const payload = explicitPayload ?? timelineClipboard.value;
  if (!clip || clip.source?.score || !payload) {
    if (!explicitPayload && !payload) {
      store.pushToast('剪贴板为空，请先选中音素或音节按 Ctrl+C 复制', 'info', 2200);
    }
    return false;
  }
  const lastPhoneId = store.selectedPhonemeIds.value.length > 0
    ? flatPhones.value.filter(({ seg }) => selectedPhoneSet.value.has(seg.id)).at(-1)?.seg.id
    : undefined;
  const sylIds = activeSyllableSelectionIds();
  const lastSylId = sylIds.length > 0
    ? syllables.value.filter((s) => sylIds.includes(s.id)).at(-1)?.id
    : undefined;

  const pasted = pasteAnnotationClipboard(
    clip,
    payload,
    {
      playheadSmp: store.playheadSmp.value,
      afterPhoneId: payload.kind === 'phones' ? lastPhoneId : undefined,
      afterSyllableId: payload.kind === 'syllables' && !cutSelectionSmp.value ? lastSylId : undefined,
    },
    store.project.value,
  );
  if (!pasted) return false;
  const label = `粘贴 ${payload.summary}`;
  const res = store.executeCommand({
    type: 'clip.edit',
    label,
    payload: { clip: pasted.clip, retimed: pasted },
  });
  if (res.ok) {
    store.stopPlayback();
    cutSelectionSmp.value = null;
    if (payload.kind === 'phones' && pasted.pastedPhoneIds.length) {
      store.selectedPhonemeIds.value = [...pasted.pastedPhoneIds];
      phoneRangeAnchor = pasted.pastedPhoneIds[0];
      store.selectedSyllableId.value = pasted.pastedSyllableIds[0] ?? store.selectedSyllableId.value;
      selectedSyllableIds.value = [];
    } else if (pasted.pastedSyllableIds.length) {
      selectedSyllableIds.value = [...pasted.pastedSyllableIds];
      store.selectedSyllableId.value = pasted.pastedSyllableIds[0];
      store.selectedPhonemeIds.value = [];
    }
    store.playheadSmp.value = pasted.pasteEndSmp;
    invalidateSynthesisBufferIfNeeded();
    store.pushToast(`已${label}（可 Ctrl+Z 撤销）`, 'success', 2000);
    return true;
  }
  return false;
}

function cutTimelineSelection(): boolean {
  const clip = activeClip.value;
  if (!clip || clip.source?.score) return false;
  // Save to clipboard before deleting/cutting
  const snapshot = copyAnnotationSelection(
    clip,
    {
      range: cutSelectionSmp.value,
      phoneIds: store.selectedPhonemeIds.value,
      syllableIds: activeSyllableSelectionIds(),
    },
    store.project.value,
  );
  if (snapshot) timelineClipboard.value = snapshot;

  if (cutSelectionSmp.value || singlePhone.value?.seg.role === 'rest') {
    triggerCutSelectedRange();
    return true;
  }
  if (canDeleteSelectedPhones.value) {
    deleteSelectedPhones();
    return true;
  }
  const sylIds = activeSyllableSelectionIds();
  if (sylIds.length) {
    const phoneIds = sylIds.flatMap((id) => clip.syllables[id]?.segments.map((s) => s.id) ?? []);
    if (phoneIds.length) {
      deleteSelectedPhones(phoneIds);
      return true;
    }
  }
  return false;
}

function duplicateTimelineSelection(): boolean {
  const clip = activeClip.value;
  if (!clip || clip.source?.score) return false;
  const payload = copyAnnotationSelection(
    clip,
    {
      range: cutSelectionSmp.value,
      phoneIds: store.selectedPhonemeIds.value,
      syllableIds: activeSyllableSelectionIds(),
    },
    store.project.value,
  );
  if (!payload) return false;
  timelineClipboard.value = payload;
  return pasteTimelineClipboard(payload);
}

function selectAllTimelinePhones(): void {
  const ids = flatPhones.value.map(({ seg }) => seg.id);
  if (!ids.length) return;
  cutSelectionSmp.value = null;
  selectedSyllableIds.value = [];
  store.selectedPhonemeIds.value = ids;
  phoneRangeAnchor = ids[0];
  store.selectedSyllableId.value = flatPhones.value[0].syl.id;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el) return false;
  return Boolean(el.closest('input, select, textarea, [contenteditable="true"], [contenteditable=""]'));
}

function hasTextSelection(): boolean {
  return Boolean(window.getSelection?.()?.toString().trim());
}

function onTimelineGlobalKeys(e: KeyboardEvent): void {
  if (isEditableKeyboardTarget(e.target)) return;
  if (editDialog.value?.open || phonEditorOpen.value || openKfId.value) return;
  if (document.querySelector('.export-modal-mask, dialog[open]')) return;

  const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
  const k = e.key.toLowerCase();

  if (mod && k === 'c') {
    if (hasTextSelection()) return;
    if (copyTimelineSelection()) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }
  if (mod && k === 'x') {
    if (hasTextSelection()) return;
    if (cutTimelineSelection()) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }
  if (mod && k === 'v') {
    if (timelineClipboard.value && pasteTimelineClipboard()) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }
  if (mod && k === 'd') {
    if (duplicateTimelineSelection()) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }
  if (mod && k === 'a') {
    const activeEl = document.activeElement as Element | null;
    if (activeEl && activeEl.closest('.rt-shell')) {
      e.preventDefault();
      selectAllTimelinePhones();
    }
    return;
  }
  if (!mod && !e.altKey && (e.key === 'Delete' || e.key === 'Backspace')) {
    if (cutSelectionSmp.value || singlePhone.value?.seg.role === 'rest') {
      e.preventDefault();
      triggerCutSelectedRange();
    } else if (canDeleteSelectedPhones.value) {
      e.preventDefault();
      deleteSelectedPhones();
    } else if (activeSyllableSelectionIds().length && activeClip.value && !activeClip.value.source?.score) {
      const sylIds = activeSyllableSelectionIds();
      const phoneIds = sylIds.flatMap((id) => activeClip.value?.syllables[id]?.segments.map((s) => s.id) ?? []);
      if (phoneIds.length) {
        e.preventDefault();
        deleteSelectedPhones(phoneIds);
      }
    } else if (store.selectedPhonationAnchorId.value) {
      e.preventDefault();
      removeSelectedPhonationAnchor();
    }
  }
}

function onTimelineKeys(e: KeyboardEvent): void {
  if (isEditableKeyboardTarget(e.target)) return;
  if (!e.ctrlKey && !e.metaKey && !e.altKey && ['+', '=', '-'].includes(e.key)) {
    e.preventDefault();
    changeZoom(e.key === '-' ? 1 / 1.15 : 1.15);
  } else if (e.key === 'Home') {
    e.preventDefault();
    centerPlayhead();
  } else if (e.key === 'Escape') {
    cutSelectionSmp.value = null;
    selectedSyllableIds.value = [];
    store.selectedPhonemeIds.value = [];
    store.selectedSyllableId.value = '';
    phoneEditMenuOpen.value = false;
    phoneContextMenu.value = null;
    readingMenuSyl.value = null;
    openKfId.value = null;
    f0DrawMode.value = false;
    psDrawMode.value = false;
  }
}

function onRulerPointerDown(e: PointerEvent): void {
  startTimeRangeDrag(e, e.currentTarget as HTMLElement);
}

const playheadFlash = ref(false);
let playheadFlashTimer = 0;
function triggerPlayheadFlash(): void {
  window.clearTimeout(playheadFlashTimer);
  playheadFlash.value = false;
  requestAnimationFrame(() => {
    playheadFlash.value = true;
    playheadFlashTimer = window.setTimeout(() => {
      playheadFlash.value = false;
    }, 720);
  });
}

function centerPlayhead(): void {
  const scroller = lanesScrollRef.value;
  const firstPhoneId = store.selectedPhonemeIds.value[0];
  const matchedPhone = firstPhoneId ? flatPhones.value.find(({ seg }) => seg.id === firstPhoneId) : undefined;
  const firstSylId = selectedSyllableIds.value[0] || store.selectedSyllableId.value;
  const matchedSyl = firstSylId ? syllables.value.find((s) => s.id === firstSylId) : undefined;

  if (matchedPhone) {
    store.playheadSmp.value = matchedPhone.seg.start_smp;
  } else if (matchedSyl) {
    store.playheadSmp.value = matchedSyl.start_smp;
  } else {
    store.playheadSmp.value = 0;
  }
  triggerPlayheadFlash();
  if (!scroller) return;
  const x = smpToX(store.playheadSmp.value);
  const targetLeft =
    store.playheadSmp.value === 0 ? 0 : Math.max(0, x - laneWidth.value * 0.5);
  scroller.scrollTo({ left: targetLeft, behavior: 'smooth' });
}

function onLanesScroll(e: Event): void {
  laneScrollX.value = (e.currentTarget as HTMLElement).scrollLeft;
  if (readingMenuSyl.value) readingMenuSyl.value = null;
}

async function playSelection(): Promise<void> {
  const phones = flatPhones.value.filter(({ seg }) => selectedPhoneSet.value.has(seg.id)).map(({ seg }) => seg);
  const words = syllables.value.filter((syl) => selectedSyllableSet.value.has(syl.id));
  const picked = phones.length ? phones : words;
  const rangeStart = cutSelectionSmp.value?.startSmp ?? picked[0]?.start_smp;
  const rangeEnd = cutSelectionSmp.value?.endSmp ?? picked.at(-1)?.end_smp;
  const gain = waveBoost3db.value ? 10 ** (3 / 20) : 1;
  const source = store.annotationAudioBuffer.value;
  if (props.recordingActive && source) {
    const audioOffset = store.annotationAudioOffsetSmp.value;
    const startSmp = Math.max(audioOffset, rangeStart ?? audioOffset);
    const endSmp = rangeEnd ?? (audioOffset + Math.round(source.duration * SAMPLE_RATE_HZ));
    const offsetSeconds = Math.max(0, (startSmp - audioOffset) / SAMPLE_RATE_HZ);
    const durationSeconds = Math.min(source.duration, Math.max(0, (endSmp - audioOffset) / SAMPLE_RATE_HZ)) - offsetSeconds;
    if (durationSeconds > 0) {
      await store.playAudioBuffer(source, { gain, offsetSeconds, durationSeconds, playheadStartSmp: startSmp });
    }
    return;
  }
  emit('play-selection', { startSmp: rangeStart, endSmp: rangeEnd, gain });
}

function onDocDown(e: PointerEvent): void {
  const t = e.target as HTMLElement | null;
  if (readingMenuSyl.value) {
    if (!readingMenuRef.value?.contains(t) && !t?.closest('.poly-tri-btn')) {
      readingMenuSyl.value = null;
    }
  }
  if (phoneEditMenuOpen.value) {
    if (
      !phoneEditMenuRef.value?.contains(t) &&
      !phoneEditBtnRef.value?.contains(t) &&
      !insertPhoneBtnRef.value?.contains(t)
    ) {
      phoneEditMenuOpen.value = false;
    }
  }
  if (phoneContextMenu.value) {
    if (!phoneContextMenuRef.value?.contains(t)) {
      phoneContextMenu.value = null;
    }
  }
}

onMounted(() => {
  if (lanesScrollRef.value) {
    widthObserver = new ResizeObserver(([entry]) => {
      laneWidth.value = Math.max(100, entry.contentRect.width - (headerRef.value?.offsetWidth ?? 0));
    });
    widthObserver.observe(lanesScrollRef.value);
  }
  document.addEventListener('pointerdown', onDocDown, true);
  window.addEventListener('keydown', onTimelineGlobalKeys);
});

watch([() => activeClip.value?.source?.lyrics, store.annotationResetVersion], () => {
  cutSelectionSmp.value = null;
  selectedSyllableIds.value = [];
  openKfId.value = null;
  readingMenuSyl.value = null;
  editDialog.value?.close();
  if (lanesScrollRef.value) lanesScrollRef.value.scrollLeft = 0;
});

watch(flatPhones, (phones) => {
  const selected = store.selectedPhonemeIds.value;
  if (!selected.length || selected.every((id) => phones.some(({ seg }) => seg.id === id))) return;
  const current = phones.find(({ seg }) => seg.start_smp <= store.playheadSmp.value && store.playheadSmp.value < seg.end_smp);
  store.selectedPhonemeIds.value = current ? [current.seg.id] : [];
  if (current) store.selectedSyllableId.value = current.syl.id;
});

onBeforeUnmount(() => {
  window.clearTimeout(playheadFlashTimer);
  window.clearTimeout(suppressPhoneClickTimer);
  window.clearTimeout(suppressPhonClickTimer);
  window.clearTimeout(rigidGuardTimer);
  for (const fn of Array.from(activeDragCleanups)) fn();
  activeDragCleanups.clear();
  widthObserver?.disconnect();
  document.removeEventListener('pointerdown', onDocDown, true);
  window.removeEventListener('keydown', onTimelineGlobalKeys);
});
</script>

<template>
  <div
    class="panel rt-shell"
    :class="{ 'rt-drop-active': shellDropActive }"
    @wheel="onTimelineWheel"
    @keydown="onTimelineKeys"
    @dragover="onShellDragOver"
    @dragleave="onShellDragLeave"
    @drop="onShellDrop"
  >
    <!-- Timeline Toolbar -->
    <div class="rt-toolbar" data-tour="main-timeline-tools">
      <div class="rt-tb-left">
        <span class="rt-title">
          <IconSvg name="timeline" :size="13" />
          多轨联动时间轴
        </span>
        <span class="mono metric-chip">
          {{ formatTimecode(store.playheadSmp.value) }} / {{ formatTimecode(totalDurationSmp) }}
        </span>
        <span v-if="cutSelectionSmp" class="mono rt-range-chip" title="当前框选的时间区间（点击 × 或按 Esc 取消）">
          选区 {{ (cutSelectionSmp.startSmp / SAMPLE_RATE_HZ).toFixed(2) }}–{{ (cutSelectionSmp.endSmp / SAMPLE_RATE_HZ).toFixed(2) }}s
          ({{ Math.round(samplesToMs(cutSelectionSmp.endSmp - cutSelectionSmp.startSmp)) }}ms)
          <button type="button" class="rt-range-clear" title="清除时间选区 (Esc)" aria-label="清除时间选区" @click="cutSelectionSmp = null">×</button>
        </span>
        <span v-else-if="selectedSyllableIds.length || store.selectedPhonemeIds.value.length" class="mono muted rt-hint-xs">
          <template v-if="selectedSyllableIds.length">已选 {{ selectedSyllableIds.length }} 音节</template>
          <template v-else>已选 {{ store.selectedPhonemeIds.value.length }} 音素</template>
        </span>
        <span v-else class="muted rt-hint-xs rt-drop-formats"
          title="音频可拖到工具栏或波形轨试听。TextGrid 可载入标注，.vcproj 可打开工程。">
          <IconSvg name="upload" :size="11" />拖入音频、TextGrid 或 .vcproj
        </span>
        <span v-if="rigidGuardMsg" class="rt-rigid-badge">
          <IconSvg name="warn" :size="11" />
          {{ rigidGuardMsg }}
        </span>
      </div>

      <div class="rt-tb-right">
        <button type="button" class="btn xs rt-phon-editor-button" title="近全屏选择发声类型并编辑锚点"
          aria-haspopup="dialog" @click="phonEditorOpen = true">放大发声类型</button>
        <button type="button" class="btn xs" title="试听选中音段或框选时间区间" @click="playSelection">
          <IconSvg name="play" :size="11" />
          <span>试听选区</span>
        </button>
        <button
          type="button"
          class="btn xs"
          title="一键自动检测并切除音频与时间轴前后的冗余静音段（支持 Ctrl+Z 撤销）"
          @click="emit('trim-silence')"
        >
          <IconSvg name="trim" :size="11" />
          <span>裁剪静音</span>
        </button>
        <button
          type="button"
          class="btn xs"
          :disabled="!effectiveCutRangeSmp"
          :title="effectiveCutRangeSmp
            ? `剪切删除已选 ${(samplesToMs(effectiveCutRangeSmp.endSmp - effectiveCutRangeSmp.startSmp) / 1000).toFixed(2)}s 区间并使后方左移衔接（可在波形轨拖拽框选任意区间）`
            : '在下方波形轨拖拽框选区间（或选中音素/静音段）后点击剪切删除'"
          @click="triggerCutSelectedRange"
        >
          <IconSvg name="scissors" :size="11" />
          <span>剪切选区</span>
        </button>
        <button type="button" class="btn xs" title="移至选中音素/音节起点并居中视口（无选中时归零并闪烁高亮播放头）" @click="centerPlayhead">
          <span>定位播放头</span>
        </button>
        <button
          type="button"
          class="btn xs"
          :disabled="!store.selectedSyllableId.value && !selectedSyllableIds.length"
          title="将当前选中字/音节的读音存入个人词典"
          @click="emit('save-dictionary')"
        >
          <IconSvg name="book" :size="11" />
          <span>存词典</span>
        </button>
        <button
          ref="insertPhoneBtnRef"
          type="button"
          class="btn xs"
          :disabled="!canInsertIpa"
          title="在当前选中音素前方或后方插入新 IPA 音素（也可右键音素块操作）"
          @click="openPhoneInsertPopover"
        >
          <IconSvg name="plus" :size="11" />
          <span>插入音素</span>
        </button>
        <button
          type="button"
          class="btn xs"
          :disabled="!canDeleteSelectedPhones"
          title="删除当前选中的音素并自动左移衔接与同步音节标注（快捷键 Delete / Backspace）"
          @click="deleteSelectedPhones()"
        >
          <IconSvg name="trash" :size="11" />
          <span>删除音素</span>
        </button>
        <button
          ref="phoneEditBtnRef"
          type="button"
          class="btn xs"
          :class="{ active: phoneEditMenuOpen }"
          aria-haspopup="dialog"
          :aria-expanded="phoneEditMenuOpen"
          @click="togglePhoneEditMenu"
        >
          <span>编辑音素</span>
        </button>
        <label class="rt-zoom-box" title="横向缩放（Ctrl + 滚轮，或聚焦时间线后按 + / −）">
          <span class="muted">缩放</span>
          <input
            :value="hZoom"
            type="range"
            :min="zoomMin"
            :max="zoomMax"
            step="0.05"
            class="rt-zoom-slider"
            :style="{ '--fill': `${(((hZoom - zoomMin) / (zoomMax - zoomMin)) * 100).toFixed(1)}%` }"
            @input="setZoomAnchored(Number(($event.target as HTMLInputElement).value))"
          />
          <span class="mono">{{ Math.round(hZoom * 100) }}%</span>
        </label>
        <details class="rt-help">
          <summary class="btn xs">快捷键</summary>
          <dl>
            <dt>Space / P</dt><dd>播放或停止</dd>
            <dt>Ctrl + 滚轮 / + / −</dt><dd>横向缩放</dd>
            <dt>Home</dt><dd>定位播放头</dd>
            <dt>Ctrl + Z / Ctrl + Shift + Z</dt><dd>撤销 / 重做</dd>
            <dt>Ctrl + C / X / V</dt><dd>复制 / 剪切 / 粘贴音素、音节或选区</dd>
            <dt>Ctrl + D / Ctrl + A</dt><dd>原地复制一份 / 全选音素</dd>
            <dt>拖选</dt><dd>连续选取字或音素（空白区可框选时间区间）</dd>
            <dt>拖拽标尺 / 轨道</dt><dd>框选时间区间并保持高亮（可试听或剪切）</dd>
            <dt>拖拽播放头三角</dt><dd>逐帧移动播放头并实时显示当前舌位</dd>
            <dt>拖动已选音节 / 音素</dt><dd>在相邻无声段内左右平移（不改时长）</dd>
            <dt>双击块 / 无声段</dt><dd>编辑文字、调值、音素或无声段时长</dd>
            <dt>右键音素</dt><dd>插入、拆分、合并或删除音素</dd>
            <dt>Delete / Backspace</dt><dd>删除选中音素、静音段或选区</dd>
          </dl>
        </details>
      </div>
    </div>

    <!-- Scrollable Multi-Track Body: Fixed Track Headers + Synchronized Horizontal Scroll Lanes -->
    <div ref="lanesScrollRef" class="rt-body-scroll" tabindex="0" aria-label="时间线轨道"
      @scroll="onLanesScroll">
      <!-- Left Fixed Track Headers Column -->
      <div ref="headerRef" class="rt-headers-col">
        <div class="rt-hdr-ruler mono muted">48 kHz · s</div>

        <!-- 1. TextGrid Header -->
        <div class="rt-hdr-row rt-hdr-annotation" :style="{ height: `${hTextgrid}px` }">
          <div class="rt-hdr-top">
            <button type="button" class="rt-hdr-name rt-hdr-toggle" :aria-expanded="collapsedPlainHeights.tg !== undefined"
              @click="togglePlainTrack('tg')">音节 <span aria-hidden="true">{{ collapsedPlainHeights.tg !== undefined ? '▾' : '▸' }}</span></button>
            <span class="muted">TextGrid</span>
          </div>
          <div class="rt-hdr-sub">音素</div>
          <div class="rt-row-resizer" title="拖拽调整 TextGrid 轨高" @pointerdown="startTrackResize('tg', $event)" />
        </div>

        <!-- 2. ART Keyframes Header -->
        <div class="rt-hdr-row rt-hdr-art" :style="{ height: `${hArt}px` }">
          <div class="rt-hdr-top">
            <button type="button" class="rt-hdr-name rt-hdr-toggle" :aria-expanded="collapsedPlainHeights.art !== undefined"
              @click="togglePlainTrack('art')">构型关键帧 <span aria-hidden="true">{{ collapsedPlainHeights.art !== undefined ? '▾' : '▸' }}</span></button>
          </div>
          <div class="rt-row-resizer" title="拖拽调整 ART 轨高" @pointerdown="startTrackResize('art', $event)" />
        </div>

        <!-- 3. Real VoQS anchors -->
        <div class="rt-hdr-row rt-hdr-phon" :style="{ height: `${effPhonHeight}px` }">
          <div class="rt-hdr-top">
            <button type="button" class="rt-hdr-name rt-hdr-toggle" :aria-expanded="phonExpanded"
              @click="toggleSpecialTrack('phon')">发声类型 <span aria-hidden="true">{{ phonExpanded ? '▾' : '▸' }}</span></button>
            <div class="rt-pills">
              <button
                type="button"
                class="btn xs"
                title="在播放头新增发声类型锚点"
                @click="addPhonationAnchorAt(store.playheadSmp.value)"
              >
                + 加点
              </button>
              <button
                type="button"
                class="btn xs"
                title="删除选中锚点"
                @click="removeSelectedPhonationAnchor"
              >
                删点
              </button>
            </div>
          </div>
          <div v-if="phonExpanded" class="rt-phon-legend">
            <span v-for="lane in SYNTHESIS_VOQS_PROFILES" :key="lane.symbol" class="rt-lane-lbl notranslate" translate="no" :title="lane.group_label">
              {{ lane.symbol }} {{ lane.label }}
            </span>
          </div>
          <div class="rt-row-resizer" title="拖拽调整 PHON 轨高" @pointerdown="startTrackResize('phon', $event)" />
        </div>

        <!-- 4. F0 Control Pitch (qTA / Hand-draw) Header -->
        <div class="rt-hdr-row rt-hdr-f0" :style="{ height: `${effF0Height}px` }">
          <div class="rt-hdr-top">
            <button type="button" class="rt-hdr-name rt-hdr-toggle" :aria-expanded="f0Expanded"
              @click="toggleSpecialTrack('f0')">F0 基频 <span aria-hidden="true">{{ f0Expanded ? '▾' : '▸' }}</span></button>
            <div class="rt-pills">
              <button
                type="button"
                class="rt-cap"
                :class="{ active: f0AutoScale }"
                :title="`纵轴当前范围 ${f0ViewMinHz}–${f0ViewMaxHz} Hz · 点击切换自动贴合上下限（F0 轨内 Alt + 滚轮可自由缩放纵轴）`"
                @click="toggleF0AutoScale"
              >
                自适应
              </button>
              <button
                type="button"
                class="rt-cap mono"
                title="放大基频纵轴细节（收紧显示跨度）"
                @click="zoomF0VerticalRange(1 / 1.25)"
              >
                +
              </button>
              <button
                type="button"
                class="rt-cap mono"
                title="缩小基频纵轴（扩大显示跨度）"
                @click="zoomF0VerticalRange(1.25)"
              >
                −
              </button>
              <button type="button" class="rt-cap" :disabled="!f0Eval" title="把当前有声 F0 曲线送到编曲钢琴卷帘定音" @click="sendPitchToPiano">定音</button>
            </div>
          </div>
          <!-- Strict single-row capsules: 靶点 / 钉住 / 颤音 / 微扰 + 手绘 + 放大 (NO 残差!) -->
          <div class="rt-f0-capsules">
            <button type="button" class="rt-cap" :class="{ active: showF0Targets }" @click="showF0Targets = !showF0Targets">
              靶点
            </button>
            <button type="button" class="rt-cap" :class="{ active: showF0Pins }" title="基频曲线始终与合成一致；关闭时另以虚线显示未钉住的 qTA 规则曲线作对照" @click="showF0Pins = !showF0Pins">
              钉住
            </button>
            <button type="button" class="rt-cap" :class="{ active: vibratoEnabled }" @click="toggleVibrato">
              颤音
            </button>
            <button type="button" class="rt-cap" :class="{ active: perturbEnabled }" @click="togglePerturb">
              微扰
            </button>
            <button
              type="button"
              class="rt-cap"
              :class="{ active: naturalIpaPitch }"
              :title="naturalIpaPitch
                ? '当前：未标调 IPA 自动叠加轻微自然语调（微拱与句末缓降），点击切回严格平基频'
                : '当前：未标调 IPA 保持严格平基频（便于科研对照），点击切换为轻微自然语调'"
              @click="toggleUnmarkedIpaPitch"
            >
              {{ naturalIpaPitch ? '语调' : '平调' }}
            </button>
            <button
              type="button"
              class="rt-cap accent"
              :class="{ active: f0DrawMode }"
              title="开启后鼠标直接在 F0 轨内描画连续基频曲线"
              @click="f0DrawMode = !f0DrawMode"
            >
              手绘
            </button>
          </div>
          <div class="rt-row-resizer" title="拖拽调整 F0 轨高" @pointerdown="startTrackResize('f0', $event)" />
        </div>

        <!-- 5. PS Subglottal Pressure (0-1600 Pa) Header -->
        <div class="rt-hdr-row rt-hdr-ps" :style="{ height: `${effPsHeight}px` }">
          <div class="rt-hdr-top">
            <button type="button" class="rt-hdr-name rt-hdr-toggle" :aria-expanded="psExpanded"
              @click="toggleSpecialTrack('ps')">声门下压 <span aria-hidden="true">{{ psExpanded ? '▾' : '▸' }}</span></button>
            <div class="rt-pills">
              <span class="mono muted">0–1600 Pa</span>
              <button
                type="button"
                class="rt-cap accent"
                :class="{ active: psDrawMode }"
                title="开启后鼠标直接手绘连续音强包络（突破 201 点上限）"
                @click="psDrawMode = !psDrawMode"
              >
                手绘
              </button>
            </div>
          </div>
          <div class="rt-row-resizer" title="拖拽调整 PS 轨高" @pointerdown="startTrackResize('ps', $event)" />
        </div>

        <!-- 6. Synthesized Waveform Header -->
        <div class="rt-hdr-row rt-hdr-wave" :style="{ height: `${hWave}px` }">
          <div class="rt-hdr-top">
            <button type="button" class="rt-hdr-name rt-hdr-toggle" :aria-expanded="collapsedPlainHeights.wave !== undefined"
              @click="togglePlainTrack('wave')">试听波形 <span aria-hidden="true">{{ collapsedPlainHeights.wave !== undefined ? '▾' : '▸' }}</span></button>
            <div class="rt-pills">
              <button type="button" class="rt-cap" :class="{ active: waveBoost3db }" @click="waveBoost3db = !waveBoost3db">
                +3dB
              </button>
            </div>
          </div>
          <div class="rt-row-resizer" title="拖拽调整波形轨高" @pointerdown="startTrackResize('wave', $event)" />
        </div>
      </div>

      <!-- Right Synchronized Horizontal-Scroll Track Lanes -->
        <div class="rt-lanes-canvas" :style="{ width: `${timelineWidthPx}px`, '--view-left': `${viewLeft}px` }">
          <div class="rt-playhead" :class="{ flash: playheadFlash }" :style="{ left: `${smpToX(store.playheadSmp.value)}px` }" />
          <div
            v-if="cutSelectionSmp"
            class="rt-range-overlay"
            :style="{
              left: `${smpToX(cutSelectionSmp.startSmp)}px`,
              width: `${Math.max(2, smpToX(cutSelectionSmp.endSmp) - smpToX(cutSelectionSmp.startSmp))}px`,
            }"
          >
            <span class="mono rt-range-overlay-tag">
              {{ (cutSelectionSmp.startSmp / SAMPLE_RATE_HZ).toFixed(2) }}–{{ (cutSelectionSmp.endSmp / SAMPLE_RATE_HZ).toFixed(2) }}s
              ({{ Math.round(samplesToMs(cutSelectionSmp.endSmp - cutSelectionSmp.startSmp)) }}ms)
            </span>
          </div>

          <!-- Time Ruler -->
          <div class="rt-ruler" title="点击定位播放头并显示该帧舌位 · 横向拖拽框选时间区间（松手保持高亮，可试听或剪切）" @pointerdown="onRulerPointerDown">
            <button
              type="button"
              class="rt-playhead-handle"
              :style="{ left: `${smpToX(store.playheadSmp.value)}px` }"
              title="拖拽播放头逐帧查看当前时刻舌位与声学特征"
              aria-label="拖拽播放头"
              @pointerdown="startPlayheadScrub"
              @click.stop
            />
            <div
              v-for="tk in rulerTicks"
              :key="tk.sec"
              class="rt-tick"
              :class="{ major: tk.major }"
              :style="{ left: `${tk.x}px` }"
            >
              <span v-if="tk.major" class="mono">{{ tk.label }}</span>
            </div>
          </div>

          <!-- 1. TextGrid Tier (Syllable top half + Phone bottom half; Audio drop jumps straight to M27 Reconstruct, T-04) -->
          <div
            class="rt-lane rt-lane-tg"
            :class="{ 'tg-drop-active': tgDropActive }"
            :style="{ height: `${hTextgrid}px` }"
            @dragover="onTgDragOver"
            @dragleave="onTgDragLeave"
            @drop="onTgDrop"
          >
            <div v-if="tgDropActive || !syllables.length" class="tg-import-hint" :style="{ left: `${viewScroll + 10}px` }">
              <IconSvg name="upload" :size="13" />
              <div>
                <strong>{{ tgDropActive ? '松开即可导入' : '拖入 TextGrid 加载标注' }}</strong>
                <span class="muted">音频拖到此处会进入声道重建</span>
              </div>
            </div>
            <div class="tg-tier tg-syllables" @pointerdown="onAnnotationLanePointerDown('words', $event)">
              <div v-if="marqueeState?.tier === 'words'" class="tg-marquee" :style="{
                left: `${Math.min(marqueeState.startX, marqueeState.curX)}px`,
                width: `${Math.abs(marqueeState.curX - marqueeState.startX)}px`,
              }" />
              <div
                v-for="syl in visibleSyllables"
                :key="syl.id"
                class="tg-syl-blk notranslate"
                translate="no"
                :class="{
                  selected: selectedSyllableSet.has(syl.id) || focusedSyllableId === syl.id,
                  'selection-focus': focusedSyllableId === syl.id,
                  'selection-group': selectedSyllableSet.size > 1 && selectedSyllableSet.has(syl.id),
                  'can-slide': canSlideSyllable(syl),
                  'has-poly': Boolean(syl.reading_candidates && syl.reading_candidates.length > 1),
                  'is-narrow': spanWidthPx(syl.start_smp, syl.end_smp) < 48,
                  'is-tiny': spanWidthPx(syl.start_smp, syl.end_smp) < 18,
                }"
                :style="{
                  left: `${smpToX(syl.start_smp)}px`,
                  width: `${spanWidthPx(syl.start_smp, syl.end_smp)}px`,
                }"
                :title="`${syl.text}${syl.tone_levels ? ' ' + syl.tone_levels : ''} · ${Math.round(samplesToMs(syl.end_smp - syl.start_smp))} ms · ${canSlideSyllable(syl) ? '可左右拖动平移至相邻无声段 · ' : ''}拖拽左右边缘调宽 · 双击编辑文字、调值与时长`"
                role="button"
                :aria-pressed="selectedSyllableSet.has(syl.id) || focusedSyllableId === syl.id"
                tabindex="0"
                @pointerdown="startSyllableSlideDrag(syl, $event)"
                @click="selectSyllableBodyOnly(syl)"
                @dblclick="openAnnotationEdit(syl)"
                @keydown.enter="selectSyllableBodyOnly(syl)"
                @keydown.f2.prevent="openAnnotationEdit(syl)"
              >
                <div
                  class="syl-edge-handle left"
                  title="拖拽音节左边界调整起点与宽度"
                  @pointerdown="startSyllableBoundaryDrag(syl, 'left', $event)"
                  @click.stop
                  @dblclick.stop
                />
                <span v-if="spanWidthPx(syl.start_smp, syl.end_smp) >= 18" class="tg-syl-txt notranslate" translate="no">{{ syl.text }}</span>
                <span v-if="syl.tone_levels && spanWidthPx(syl.start_smp, syl.end_smp) >= 48" class="mono tg-tone-tag notranslate" translate="no">{{ syl.tone_levels }}</span>
                <button
                  v-if="syl.reading_candidates && syl.reading_candidates.length > 1"
                  type="button"
                  class="poly-tri-btn"
                  title="多音字：仅点击此右下角三角切换读音"
                  @click.stop="openPolyphoneMenu(syl, $event)"
                  @dblclick.stop
                  @keydown.enter.stop
                  aria-label="切换多音字读音"
                >
                  ◢
                </button>
                <div
                  class="syl-edge-handle right"
                  title="拖拽音节右边界弹性伸缩整音节时长（含单音节与末音节）"
                  @pointerdown="startSyllableBoundaryDrag(syl, 'right', $event)"
                  @click.stop
                  @dblclick.stop
                />
              </div>
              <div
                v-for="gap in visibleSilenceGaps"
                :key="gap.id"
                class="tg-gap-blk"
                :class="{ 'is-narrow': spanWidthPx(gap.startSmp, gap.endSmp) < 38 }"
                :style="{
                  left: `${smpToX(gap.startSmp)}px`,
                  width: `${spanWidthPx(gap.startSmp, gap.endSmp)}px`,
                }"
                :title="`无声段 ${Math.round(samplesToMs(gap.endSmp - gap.startSmp))} ms · 拖拽右边缘或双击直接调整时长（前后音节长度不变）`"
                role="button"
                tabindex="0"
                @pointerdown.stop
                @click.stop
                @dblclick.stop="openSilenceGapEdit(gap)"
                @keydown.enter.stop="openSilenceGapEdit(gap)"
              >
                <span v-if="spanWidthPx(gap.startSmp, gap.endSmp) >= 38" class="mono tg-gap-ms">
                  {{ Math.round(samplesToMs(gap.endSmp - gap.startSmp)) }}ms
                </span>
                <div
                  v-if="!activeClip?.source?.score"
                  class="gap-edge-handle"
                  title="拖拽调整无声段时长（整体平移后方音节，不改变前后音节长度）"
                  @pointerdown="startSilenceGapDrag(gap, $event)"
                  @click.stop
                  @dblclick.stop
                />
              </div>
            </div>

            <div class="tg-tier tg-phones" @pointerdown="onAnnotationLanePointerDown('phones', $event)">
              <div
                v-if="marqueeState?.tier === 'phones'"
                class="tg-marquee"
                :style="{
                  left: `${Math.min(marqueeState.startX, marqueeState.curX)}px`,
                  width: `${Math.abs(marqueeState.curX - marqueeState.startX)}px`,
                }"
              />
              <div
                v-for="item in visiblePhones"
                :key="item.seg.id"
                class="tg-phone-blk notranslate"
                translate="no"
                :class="{
                  selected: selectedPhoneSet.has(item.seg.id),
                  'selection-focus': focusedPhoneId === item.seg.id,
                  'selection-group': selectedPhoneSet.size > 1 && selectedPhoneSet.has(item.seg.id),
                  'can-slide': canSlidePhone(item.seg),
                  voiceless: !item.seg.voiced,
                  stop: Boolean(item.seg.stop_timing),
                  'is-compact': spanWidthPx(item.seg.start_smp, item.seg.end_smp) < 42,
                  'is-tiny': spanWidthPx(item.seg.start_smp, item.seg.end_smp) < 18,
                }"
                :style="{
                  left: `${smpToX(item.seg.start_smp)}px`,
                  width: `${spanWidthPx(item.seg.start_smp, item.seg.end_smp)}px`,
                }"
                :title="`音素 [${item.seg.ipa}] · ${Math.round(samplesToMs(item.seg.end_smp - item.seg.start_smp))} ms · ${canSlidePhone(item.seg) ? '可左右拖动平移至相邻无声段 · ' : ''}双击编辑 · 右键插入/删除 · Delete 删除`"
                role="button"
                :aria-pressed="selectedPhoneSet.has(item.seg.id)"
                tabindex="0"
                @pointerdown="startPhoneSlideDrag(item, $event)"
                @click="onSelectSinglePhone(item, $event)"
                @dblclick="openAnnotationEdit(item.syl, item.seg)"
                @contextmenu.prevent="openPhoneContextMenu(item, $event)"
                @keydown.enter="store.selectedSyllableId.value = item.syl.id; store.selectedPhonemeIds.value = [item.seg.id]; selectedSyllableIds = []"
                @keydown.f2.prevent="openAnnotationEdit(item.syl, item.seg)"
              >
                <span v-if="spanWidthPx(item.seg.start_smp, item.seg.end_smp) >= 18" class="ipa tg-phone-sym notranslate" translate="no">{{ item.seg.ipa }}</span>
                <span v-if="spanWidthPx(item.seg.start_smp, item.seg.end_smp) >= 42" class="mono tg-phone-ms">{{ Math.round(samplesToMs(item.seg.end_smp - item.seg.start_smp)) }}</span>
                <span v-if="item.seg.stop_timing" class="tg-stop-release"
                  :style="stopPhaseStyle(item.seg)"
                  :title="`持阻 ${item.seg.stop_timing.closure_ms.toFixed(1)} ms · 除阻 ${item.seg.stop_timing.release_ms.toFixed(1)} ms · VOT ${item.seg.stop_timing.vot_ms} ms`" />
                <div
                  class="seg-edge-handle"
                  title="拖拽右边界重定时（受塞音闭塞 10ms / 释放 1ms 刚性下限保护）"
                  @pointerdown="startBoundaryDrag(item, $event)"
                />
              </div>
            </div>
            <div class="rt-row-resizer" @pointerdown="startTrackResize('tg', $event)" />
          </div>

          <!-- 2. ART Keyframes 1:1 Aligned with Phones -->
          <div class="rt-lane rt-lane-art" :style="{ height: `${hArt}px` }" @pointerdown="onArtPointerDown">
            <div class="art-guide-line" />
            <button
              v-for="item in visiblePhones"
              :key="`kf_${item.seg.id}`"
              type="button"
              class="kf-dot"
              :data-idx="item.idx"
              :class="{
                active: openKfIdx === item.idx,
                selected: selectedPhoneSet.has(item.seg.id),
              }"
              :style="{
                left: `${smpToX((item.seg.start_smp + item.seg.end_smp) * 0.5)}px`,
              }"
              :title="`关键帧 #${item.idx + 1} [${item.seg.ipa}] · 点击弹出悬浮构型窗`"
              @click.stop="openKeyframePopover(item)"
            >
              <span class="kf-diamond" />
            </button>
            <div class="rt-row-resizer" @pointerdown="startTrackResize('art', $event)" />
          </div>

          <!-- 3. Real VoQS anchor track -->
          <div
            class="rt-lane rt-lane-phon phon-lane-canvas sci-plane"
            :style="{ height: `${effPhonHeight}px` }"
            title="单击定位播放头 · 折叠态拖拽可框选时间区间 · 双击或点轨头展开 5 泳道"
            @pointerdown="onPhonLanePointerDown"
            @click="onPhonLaneClick"
            @dblclick="toggleSpecialTrack('phon')"
          >
            <svg class="lane-svg" :width="viewSvgWidth" :height="effPhonHeight" :viewBox="viewSvg(effPhonHeight)">
              <line
                v-for="lane in SYNTHESIS_VOQS_PROFILES"
                :key="lane.symbol"
                x1="0"
                :x2="timelineWidthPx"
                :y1="phonLaneY(lane.symbol, effPhonHeight)"
                :y2="phonLaneY(lane.symbol, effPhonHeight)"
                stroke="var(--border)"
                stroke-opacity="0.42"
                stroke-dasharray="3 4"
                stroke-width="1"
              />
              <polyline
                :points="phonPolylinePoints"
                fill="none"
                stroke="var(--violet)"
                stroke-width="1.8"
                stroke-linejoin="round"
              />
            </svg>
            <button
              v-for="anc in visiblePhonation"
              :key="anc.id"
              type="button"
              class="phon-node"
              :class="{ selected: store.selectedPhonationAnchorId.value === anc.id }"
              :style="{
                left: `${smpToX(anc.t_smp)}px`,
                top: `${phonLaneY(anc, effPhonHeight)}px`,
              }"
              :title="`${voqsAnchorLabel(anc)} (${(anc.t_smp / SAMPLE_RATE_HZ).toFixed(2)}s) · 拖拽吸附泳道`"
              @pointerdown="startPhonDrag(anc, $event)"
            >
              <span class="phon-node-lbl ipa notranslate" translate="no">{{ voqsLane(anc) }}</span>
            </button>
            <div class="rt-row-resizer" @pointerdown="startTrackResize('phon', $event)" />
          </div>

          <!-- 4. F0 Control Pitch Track -->
          <div
            class="rt-lane rt-lane-f0 f0-lane-canvas sci-plane"
            :class="{ 'is-drawing': f0DrawMode }"
            :style="{ height: `${effF0Height}px` }"
            @pointerdown="onF0PointerDown"
            @wheel="onF0LaneWheel"
            @dblclick="f0AutoScale = true"
          >
            <div v-if="f0Expanded" class="f0-legend-pill" :style="{ left: `${viewScroll + 56}px` }">
              <span>{{ f0ViewMinHz }}–{{ f0ViewMaxHz }}Hz ({{ f0AutoScale ? '自适应' : '手动 · 双击复位' }}) · 实线：合成基频 · 圆点：qTA 靶标</span>
              <span v-if="perturbEnabled" class="f0-perturb-badge">微扰包络已开启</span>
            </div>
            <svg class="lane-svg" :width="viewSvgWidth" :height="effF0Height" :viewBox="viewSvg(effF0Height)">
              <g v-for="hz in f0AxisTicks" :key="hz">
                <line
                  x1="0"
                  :x2="timelineWidthPx"
                  :y1="hzToF0Y(hz, effF0Height)"
                  :y2="hzToF0Y(hz, effF0Height)"
                  stroke="var(--border)"
                  stroke-opacity="0.34"
                  stroke-width="0.8"
                />
                <text :x="viewScroll + 6" :y="Math.max(9, Math.min(effF0Height - 3, hzToF0Y(hz, effF0Height) - 2))" class="lane-axis-txt mono">{{ hz }}Hz</text>
              </g>

              <g v-if="showF0Targets">
                <line
                  v-for="tg in f0TargetLines"
                  :key="`tg_${tg.key}`"
                  :x1="tg.x1"
                  :y1="tg.y1"
                  :x2="tg.x2"
                  :y2="tg.y2"
                  stroke="var(--accent)"
                  stroke-opacity="0.62"
                  stroke-width="1.45"
                  stroke-dasharray="4 3"
                />
              </g>

              <path
                v-if="f0RulePath"
                :d="f0RulePath"
                fill="none"
                stroke="var(--muted)"
                stroke-opacity="0.5"
                stroke-width="1.1"
                stroke-dasharray="2 3"
              ><title>qTA 规则曲线（未钉住，仅作对照；合成使用钉住曲线）</title></path>

              <!-- Perturbation Flutter/Shimmer Jitter Envelope Band (T-14) -->
              <path
                v-for="(bandD, bIdx) in f0Curves.perturbBandPaths"
                :key="`pb_${bIdx}`"
                :d="bandD"
                fill="var(--warning)"
                fill-opacity="0.18"
                stroke="var(--warning)"
                stroke-opacity="0.35"
                stroke-width="0.7"
                stroke-dasharray="2 2"
              />

              <path
                v-for="(d, idx) in f0Curves.unvoicedPaths"
                :key="`uv_${idx}`"
                :d="d"
                fill="none"
                stroke="var(--warning)"
                stroke-opacity="0.55"
                stroke-width="1.35"
                stroke-dasharray="3 3"
              />

              <path
                v-for="(d, idx) in f0Curves.voicedPaths"
                :key="`v_${idx}`"
                :d="d"
                fill="none"
                stroke="var(--warning)"
                stroke-width="1.75"
                stroke-linecap="round"
                stroke-linejoin="round"
              />

              <path
                v-if="f0DraftPath"
                :d="f0DraftPath"
                fill="none"
                stroke="var(--accent)"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>

            <template v-if="showF0Targets && !f0DrawMode">
              <button
                v-for="tg in f0TargetLines"
                :key="`tgh_${tg.key}`"
                type="button"
                class="f0-target-dot"
                :style="{ left: `${tg.x2 - 5}px`, top: `${tg.y2}px` }"
                :title="`${tg.syl.text} 靶点 ${tg.hzEnd} Hz · 上下拖拽调整 qTA 靶高（自动解除覆盖钉住段）`"
                @pointerdown="startF0TargetDrag(tg.syl, tg.targetIdx, $event)"
              />
            </template>
            <div class="rt-row-resizer" @pointerdown="startTrackResize('f0', $event)" />
          </div>

          <!-- 5. PS Subglottal Pressure Track (0-1600 Pa, freehand drawable) -->
          <div
            class="rt-lane rt-lane-ps sci-plane"
            :class="{ 'is-drawing': psDrawMode }"
            :style="{ height: `${effPsHeight}px` }"
            @pointerdown="onPsPointerDown"
          >
            <svg class="lane-svg" :width="viewSvgWidth" :height="effPsHeight" :viewBox="viewSvg(effPsHeight)">
              <line
                x1="0"
                :x2="timelineWidthPx"
                :y1="paToPsY(800, effPsHeight)"
                :y2="paToPsY(800, effPsHeight)"
                stroke="var(--border)"
                stroke-opacity="0.38"
                stroke-dasharray="3 4"
              />
              <text :x="viewScroll + 6" :y="paToPsY(800, effPsHeight) - 2" class="lane-axis-txt mono">800 Pa</text>
              <path v-for="(areaD, aIdx) in psPaths.areaPaths" :key="`psa_${aIdx}`" :d="areaD" fill="var(--teal-bg)" />
              <path
                v-for="(lineD, lIdx) in psPaths.linePaths"
                :key="`psl_${lIdx}`"
                :d="lineD"
                fill="none"
                stroke="var(--track-color)"
                stroke-width="1.6"
                stroke-linejoin="round"
                stroke-linecap="round"
              />
              <path
                v-if="psDraftPath"
                :d="psDraftPath"
                fill="none"
                stroke="var(--accent)"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
            <div class="rt-row-resizer" @pointerdown="startTrackResize('ps', $event)" />
          </div>

          <!-- 6. Synthesized Waveform Track (supports drag range selection for T-63 cutting) -->
          <div
            class="rt-lane rt-lane-wave sci-plane"
            :style="{ height: `${hWave}px` }"
            title="拖拽框选时间区间（松手保持高亮，可试听或剪切）· 点击定位播放头并显示该帧舌位"
            @pointerdown="onWavePointerDown"
          >
            <svg class="lane-svg" :width="viewSvgWidth" :height="hWave" :viewBox="viewSvg(hWave)">
              <line
                x1="0"
                :x2="timelineWidthPx"
                :y1="hWave / 2"
                :y2="hWave / 2"
                stroke="var(--border)"
                stroke-opacity="0.4"
              />
              <text v-if="!store.annotationAudioBuffer.value" :x="viewScroll + 10" :y="hWave / 2 + 4" fill="var(--muted)" font-size="0.916667rem">拖入音频或试听时间线后显示波形</text>
              <rect
                v-for="bar in waveformBars"
                :key="bar.x"
                :x="bar.x"
                :y="(hWave / 2) - (bar.amp * hWave * 0.44)"
                width="2.2"
                :height="Math.max(1.5, bar.amp * hWave * 0.88)"
                rx="1"
                fill="var(--track-color)"
                fill-opacity="0.82"
              />
            </svg>
            <div class="rt-row-resizer" @pointerdown="startTrackResize('wave', $event)" />
          </div>
        </div>
    </div>

    <PhonationEditor
      v-if="phonEditorOpen"
      :duration-smp="totalDurationSmp"
      :audio-buffer="store.annotationAudioBuffer.value"
      :audio-offset-smp="store.annotationAudioOffsetSmp.value"
      :clip="drawingClip"
      @close="phonEditorOpen = false"
      @remove="removeSelectedPhonationAnchor"
    />
    <!-- Floating Polyphone Reading Switcher & Enhanced Phoneme Edit Popover -->
    <Teleport to="body">
      <div
        v-if="phoneEditMenuOpen"
        ref="phoneEditMenuRef"
        class="rt-phone-popover panel"
        :style="phoneEditMenuStyle"
        role="dialog"
        aria-label="编辑音素工具面板"
      >
        <div class="rt-pop-head">
          <strong>编辑音素</strong>
          <span v-if="singlePhone" class="ipa mono tree-tag notranslate" translate="no">[{{ singlePhone.seg.ipa }}]</span>
          <span v-else class="muted">请单选音素</span>
        </div>

        <div class="rt-pop-sec">
          <label class="rt-pop-lbl">直接修改音标与时长</label>
          <div class="rt-pop-row">
            <input
              v-model="quickEditIpa"
              type="text"
              class="inp ipa notranslate"
              translate="no"
              :disabled="!singlePhone"
              placeholder="如 pʰ, tʲ, ã"
              @keydown.enter.prevent="applyQuickIpaEdit"
            />
            <button type="button" class="btn xs primary" :disabled="!singlePhone" @click="applyQuickIpaEdit">
              应用
            </button>
          </div>
          <div v-if="singlePhone" class="rt-pop-row">
            <span class="muted rt-pop-unit">音段时长</span>
            <input
              v-model.number="quickDurationMs"
              type="number"
              :min="isSelectedStop ? 11 : 15"
              max="60000"
              step="1"
              class="inp mono rt-insert-duration"
              aria-label="当前音段时长（毫秒）"
              @keydown.enter.prevent="commitQuickSegmentDuration"
            />
            <span class="muted">ms</span>
            <button type="button" class="btn xs" @click="commitQuickSegmentDuration">应用时长</button>
          </div>
        </div>

        <div class="rt-pop-sec">
          <span class="rt-pop-lbl">拆分与合并</span>
          <div class="rt-pop-grid2">
            <button
              type="button"
              class="btn xs"
              :disabled="!canSplitMidpoint"
              title="将当前选中音素从时间中点一键拆为两段"
              @click="splitSelectedPhone('midpoint')"
            >
              中点拆分为两段
            </button>
            <button
              type="button"
              class="btn xs"
              :disabled="!splitInsidePhone || isSelectedStop"
              title="将播放头移入音素内部，从播放头处拆分"
              @click="splitSelectedPhone('playhead')"
            >
              播放头处拆分
            </button>
            <button
              type="button"
              class="btn xs"
              :disabled="!canMergePrevPhone"
              title="将当前音素并入同一音节的前一音素"
              @click="mergeSelectedPhone('prev')"
            >
              与前一音素合并
            </button>
            <button
              type="button"
              class="btn xs"
              :disabled="!canMergeNextPhone"
              title="将同一音节的后一音素并入当前音素"
              @click="mergeSelectedPhone('next')"
            >
              与后一音素合并
            </button>
          </div>
          <button
            type="button"
            class="btn xs danger"
            style="width: 100%"
            :disabled="!canDeleteSelectedPhones"
            title="删除当前选中的音素并自动衔接后方与同步音节标注（快捷键 Delete）"
            @click="deleteSelectedPhones()"
          >
            <IconSvg name="trash" :size="11" />
            <span>{{ store.selectedPhonemeIds.value.length > 1 ? `删除已选 ${store.selectedPhonemeIds.value.length} 个音素` : '删除选中音素' }}</span>
          </button>
        </div>

        <div v-if="!activeClip?.source?.score" class="rt-pop-sec">
          <span class="rt-pop-lbl">插入音素</span>
          <div class="rt-pop-row">
            <input ref="insertIpaInputRef" v-model="insertIpa" type="text" class="inp ipa notranslate" translate="no"
              aria-label="要插入的 IPA 音素" placeholder="如 ʃ 或 a" :disabled="!canInsertIpa"
              @keydown.enter.prevent="insertAtSelection('after')" />
            <input v-model.number="insertIpaMs" type="number" class="inp mono rt-insert-duration"
              min="20" max="2000" aria-label="插入音素时长（毫秒）" :disabled="!canInsertIpa" />
            <span class="muted">ms</span>
          </div>
          <div class="rt-pop-grid2">
            <button type="button" class="btn xs" :disabled="!canInsertIpa" @click="insertAtSelection('before')">插到选区前</button>
            <button type="button" class="btn xs primary" :disabled="!canInsertIpa" @click="insertAtSelection('after')">插到选区后</button>
          </div>
        </div>

        <div v-if="!props.recordingActive" class="rt-pop-sec">
          <label class="rt-pop-lbl">在后方插入静音休止段 (ms)</label>
          <div class="rt-pop-row">
            <input
              v-model.number="insertSilenceMs"
              type="number"
              min="20"
              max="2000"
              step="1"
              class="inp mono"
              style="width: 84px"
              @keydown.enter.prevent="insertAtSelection('after', true)"
            />
            <button
              type="button"
              class="btn xs"
              :disabled="!singlePhone && !syllables.length"
              @click="insertAtSelection('after', true)"
            >
              插入静音段 [sil]
            </button>
          </div>
        </div>

        <div v-if="isSelectedStop && singlePhone" class="rt-pop-sec">
          <label class="rt-pop-lbl">
            塞音保护与 VOT (ms)
          </label>
          <div v-if="singlePhone.seg.stop_timing" class="rt-stop-summary mono">
            <span>闭塞 {{ Math.round(singlePhone.seg.stop_timing.closure_ms) }}ms (≥10)</span>
            <span>除阻 {{ Math.round(singlePhone.seg.stop_timing.release_ms) }}ms (≥1)</span>
            <span>VOT {{ Math.round(singlePhone.seg.stop_timing.vot_ms) }}ms</span>
          </div>
          <div class="rt-pop-row">
            <input
              v-model.number="votDraftMs"
              type="number"
              step="1"
              class="inp mono"
              style="width: 84px"
              @keydown.enter.prevent="commitStopVot"
            />
            <button type="button" class="btn xs primary" @click="commitStopVot">设定 VOT</button>
            <button
              type="button"
              class="btn xs"
              :disabled="!splitInsidePhone"
              title="按播放头位置设定持阻结束/除阻起点"
              @click="markStopRelease"
            >
              标记除阻
            </button>
          </div>
        </div>

        <div v-if="canSynthesizeSelected" class="rt-pop-sec">
          <button
            type="button"
            class="btn xs"
            style="width: 100%"
            title="用当前构型重合成选中的一个音素并写回录音区间"
            @click="synthesizeSelectedPhone"
          >
            局部重合成写回录音
          </button>
        </div>
      </div>

      <div
        v-if="phoneContextMenu"
        ref="phoneContextMenuRef"
        class="rt-phone-ctx panel"
        :style="phoneContextMenu.style"
        role="menu"
        aria-label="音素快捷操作菜单"
      >
        <button
          type="button"
          class="rt-ctx-item"
          @click="editContextMenuPhone()"
        >
          <span>编辑音标与时长…</span>
        </button>
        <button
          type="button"
          class="rt-ctx-item"
          @click="phoneContextMenu = null; copyTimelineSelection()"
        >
          <span>复制 (Ctrl+C)</span>
        </button>
        <button
          type="button"
          class="rt-ctx-item"
          :disabled="Boolean(activeClip?.source?.score)"
          @click="phoneContextMenu = null; cutTimelineSelection()"
        >
          <span>剪切 (Ctrl+X)</span>
        </button>
        <button
          v-if="timelineClipboard"
          type="button"
          class="rt-ctx-item"
          :disabled="Boolean(activeClip?.source?.score)"
          @click="phoneContextMenu = null; pasteTimelineClipboard()"
        >
          <span>粘贴 (Ctrl+V)</span>
        </button>
        <button
          v-if="canInsertIpa"
          type="button"
          class="rt-ctx-item"
          @click="openPhoneInsertPopover()"
        >
          <IconSvg name="plus" :size="12" />
          <span>在前方 / 后方插入音素…</span>
        </button>
        <button
          type="button"
          class="rt-ctx-item"
          :disabled="!canSplitMidpoint"
          @click="phoneContextMenu = null; splitSelectedPhone('midpoint')"
        >
          <span>中点拆分为两段</span>
        </button>
        <button
          type="button"
          class="rt-ctx-item"
          :disabled="!canMergePrevPhone"
          @click="phoneContextMenu = null; mergeSelectedPhone('prev')"
        >
          <span>与前一音素合并</span>
        </button>
        <button
          type="button"
          class="rt-ctx-item"
          :disabled="!canMergeNextPhone"
          @click="phoneContextMenu = null; mergeSelectedPhone('next')"
        >
          <span>与后一音素合并</span>
        </button>
        <button
          type="button"
          class="rt-ctx-item danger"
          :disabled="!canDeleteSelectedPhones"
          @click="deleteSelectedPhones()"
        >
          <IconSvg name="trash" :size="12" />
          <span>{{ store.selectedPhonemeIds.value.length > 1 ? `删除已选 ${store.selectedPhonemeIds.value.length} 个音素` : '删除此音素 (Delete)' }}</span>
        </button>
      </div>

      <dialog ref="editDialog" class="rt-edit-dialog" @close="editing = null" aria-labelledby="rt-edit-title">
        <form v-if="editing" class="rt-edit-form" novalidate @submit.prevent="applyAnnotationEdit">
          <strong id="rt-edit-title">{{ editing.gap ? '编辑无声段' : editing.phoneId ? '编辑音素' : '编辑音节' }}</strong>
          <label v-if="!editing.gap">{{ editing.phoneId ? 'IPA 符号' : '文字' }}
            <input v-model="editing.text" class="inp ipa notranslate" translate="no" autofocus />
          </label>
          <label v-if="!editing.gap && !editing.phoneId">调值
            <input v-model="editing.tone" class="inp mono" inputmode="numeric" placeholder="如 55 或 214（留空恢复默认）" />
          </label>
          <label>{{ editing.gap ? '无声段时长 (ms)' : editing.phoneId ? '音素时长 (ms)' : '音节时长 (ms)' }}
            <input
              v-model.number="editing.durationMs"
              type="number"
              :min="editing.gap ? 0 : 11"
              max="60000"
              step="1"
              class="inp mono"
              :autofocus="Boolean(editing.gap)"
            />
          </label>
          <p v-if="editing.gap" class="muted rt-gap-hint">
            调整无声段时前后音节时长保持不变，设为 0 可消除停顿。
          </p>
          <p v-if="editError" class="rt-edit-error" role="alert">{{ editError }}</p>
          <div class="rt-edit-actions">
            <button type="button" class="btn" @click="editDialog?.close()">取消</button>
            <button type="submit" class="btn primary">保存</button>
          </div>
        </form>
      </dialog>
      <div
        v-if="readingMenuSyl"
        id="tgReadingMenu"
        ref="readingMenuRef"
        class="vc-sel-menu rt-reading-menu"
        :style="readingMenuStyle"
        role="menu"
      >
        <div class="poly-menu-hdr">
          <span>多音字「{{ readingMenuSyl.text }}」读音切换</span>
        </div>
        <button
          v-for="cand in readingMenuSyl.reading_candidates"
          :key="cand"
          type="button"
          class="vc-sel-opt"
          :class="{ active: isActiveReadingCandidate(readingMenuSyl, cand) }"
          @click="applyReadingCandidate(readingMenuSyl, cand)"
        >
          <span class="ipa notranslate" translate="no">{{ cand }}</span>
          <IconSvg v-if="isActiveReadingCandidate(readingMenuSyl, cand)" name="check" :size="12" />
        </button>
      </div>
    </Teleport>

    <!-- ART Keyframe Floating Configuration Popover -->
    <KeyframePopover
      :open="openKfIdx !== null"
      :dot-idx="openKfIdx"
      :syllable="activeKfItem?.syl ?? null"
      :segment="activeKfItem?.seg ?? null"
      :prev-params="activeKfPrevParams"
      :next-params="activeKfNextParams"
      @close="openKfId = null"
    />
  </div>
</template>

<style scoped>
.rt-shell {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.rt-toolbar {
  height: 30px;
  flex: none;
  padding: 0 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--panel-border) 72%, transparent);
  background: color-mix(in srgb, var(--panel) 44%, transparent);
  font-size: 0.916667rem;
}

.rt-tb-left,
.rt-tb-right {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.rt-tb-right { flex: 1; justify-content: flex-end; }

.rt-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 700;
  white-space: nowrap;
}

.rt-hint-xs {
  font-size: 0.833333rem;
  white-space: nowrap;
}
.rt-drop-formats {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.rt-rigid-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.833333rem;
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--danger) 14%, var(--panel));
  color: var(--danger);
  border: 1px solid color-mix(in srgb, var(--danger) 42%, transparent);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rt-zoom-box {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.833333rem;
  white-space: nowrap;
  flex: 1;
  max-width: 350px;
}

.rt-zoom-slider {
  width: 100% !important;
  min-width: 60px;
  height: 14px !important;
}
.rt-zoom-box > .mono { min-width: 3.7ch; }
.rt-help { position: relative; flex: none; z-index: 20; }
.rt-help summary { list-style: none; }
.rt-help dl {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  margin: 0;
  min-width: max-content;
  display: grid;
  grid-template-columns: auto auto;
  gap: 6px 14px;
  padding: 10px 12px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: var(--r-ctrl);
  box-shadow: var(--popover-shadow);
}
.rt-help dt { color: var(--accent); }
.rt-help dd { margin: 0; }
.rt-edit-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: max-content;
  display: grid;
  gap: 4px;
  padding: 6px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: var(--r-ctrl);
  box-shadow: var(--popover-shadow);
}
.tg-stop-release {
  position: absolute;
  bottom: 0;
  height: 4px;
  min-width: 2px;
  border-left: 1px solid var(--on-accent);
  background: var(--warning);
  z-index: 2;
}

.rt-body-scroll {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: flex-start;
  overflow: auto;
  scrollbar-width: thin;
}

.rt-headers-col {
  position: sticky;
  left: 0;
  z-index: 14;
  width: 212px;
  flex: none;
  border-right: var(--border-w, 1px) solid var(--panel-border);
  background: var(--panel);
  display: flex;
  flex-direction: column;
}

.rt-hdr-ruler {
  height: 22px;
  flex: none;
  padding: 0 8px;
  display: flex;
  align-items: center;
  font-size: 0.816667rem;
  border-bottom: 1px solid var(--panel-border);
}

.rt-hdr-row {
  position: relative;
  flex: none;
  padding: 4px 8px 6px;
  border-bottom: 1px solid color-mix(in srgb, var(--panel-border) 72%, transparent);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  min-width: 0;
}

.rt-hdr-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  min-width: 0;
}
.rt-hdr-annotation {
  display: grid;
  grid-template-rows: 1fr 1fr;
  align-items: stretch;
  gap: 0;
  padding-block: 0;
}
.rt-hdr-annotation .rt-hdr-sub {
  display: flex;
  align-items: center;
  font-size: 0.9rem;
  font-weight: 700;
}

.rt-hdr-name {
  font-size: 0.9rem;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rt-hdr-sub {
  font-size: 0.791667rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rt-hdr-toggle {
  border: 0;
  background: none;
  color: inherit;
  padding: 0;
  text-align: left;
  cursor: pointer;
}
.rt-hdr-toggle:hover { color: var(--accent); }

.rt-pills {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
}

.rt-f0-capsules {
  display: flex;
  align-items: center;
  gap: 3px;
  flex-wrap: nowrap;
  overflow-x: auto;
  scrollbar-width: none;
}

.rt-cap {
  height: 18px;
  padding: 0 5px;
  border: 1px solid var(--ctrl-border, var(--panel-border));
  border-radius: 999px;
  background: var(--ctrl-bg);
  color: var(--muted);
  font-size: 0.783333rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  flex: none;
  transition: border-color 0.12s, background-color 0.12s, color 0.12s;
}

.rt-cap:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--accent);
}

.rt-cap:disabled {
  opacity: 0.46;
  cursor: not-allowed;
}

.rt-cap.active {
  background: var(--selected);
  border-color: var(--accent);
  color: var(--accent);
}

.rt-cap.accent.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.rt-phon-legend {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  flex: 1;
  font-size: 0.75rem;
  color: var(--muted);
  padding: 2px 0;
}

.rt-lane-lbl {
  line-height: 1.1;
}

.rt-lanes-canvas {
  flex: none;
  min-width: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}

.rt-playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1.5px;
  background: var(--danger);
  z-index: 12;
  pointer-events: none;
}

.rt-playhead::before {
  content: "";
  position: absolute;
  top: 0;
  left: -4px;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 7px solid var(--danger);
}

.rt-ruler {
  height: 22px;
  flex: none;
  position: relative;
  border-bottom: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 70%, transparent);
  cursor: crosshair;
  user-select: none;
  touch-action: none;
}

.rt-playhead-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 14px;
  transform: translateX(-50%);
  padding: 0;
  border: 0;
  background: transparent;
  cursor: ew-resize;
  z-index: calc(var(--z-base) + 13);
}

.rt-playhead-handle::after {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 8px solid var(--danger);
}

.rt-playhead-handle:hover::after {
  border-left-width: 6px;
  border-right-width: 6px;
  border-top-width: 9px;
}

.rt-range-overlay {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: calc(var(--z-base) + 5);
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  border-left: 1.5px solid var(--accent);
  border-right: 1.5px solid var(--accent);
  pointer-events: none;
}

.rt-range-overlay-tag {
  position: absolute;
  top: 2px;
  left: 4px;
  padding: 0 5px;
  border-radius: var(--r-ctrl);
  font-size: 0.72rem;
  line-height: 1.35;
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  color: var(--accent);
  white-space: nowrap;
}

.rt-range-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 6px;
  border-radius: var(--r-pill);
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 12%, var(--panel));
  color: var(--accent);
  font-size: 0.78rem;
  white-space: nowrap;
}

.rt-range-clear {
  border: 0;
  padding: 0 2px;
  background: transparent;
  color: inherit;
  font-size: 0.9rem;
  line-height: 1;
  cursor: pointer;
}

.rt-range-clear:hover {
  color: var(--danger);
}

.tg-syl-blk.can-slide,
.tg-phone-blk.can-slide {
  cursor: grab;
}

.tg-syl-blk.can-slide:active,
.tg-phone-blk.can-slide:active {
  cursor: grabbing;
}

.rt-tick {
  position: absolute;
  bottom: 0;
  height: 5px;
  border-left: 1px solid var(--border);
  pointer-events: none;
}

.rt-tick.major {
  height: 10px;
  border-left-color: var(--muted);
}

.rt-tick span {
  position: absolute;
  top: -11px;
  left: 3px;
  font-size: 0.75rem;
  color: var(--muted);
  white-space: nowrap;
}

.rt-lane {
  position: relative;
  flex: none;
  border-bottom: 1px solid color-mix(in srgb, var(--panel-border) 72%, transparent);
  border-radius: 0;
  overflow: hidden;
}

.rt-lane.is-drawing {
  cursor: crosshair;
}

.rt-row-resizer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 5px;
  cursor: row-resize;
  z-index: 10;
}

.rt-row-resizer:hover {
  background: color-mix(in srgb, var(--accent) 35%, transparent);
}

.rt-lane-tg {
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--app) 46%, var(--panel));
}

.tg-tier {
  position: relative;
  flex: 1;
  min-height: 22px;
  user-select: none;
  touch-action: pan-y;
}

.tg-syllables {
  border-bottom: 1px dashed color-mix(in srgb, var(--border) 75%, transparent);
}

.tg-syl-blk {
  position: absolute;
  top: 2px;
  bottom: 2px;
  border-radius: max(3px, calc(var(--r-ctrl) - 2px));
  border: 1px solid color-mix(in srgb, var(--accent) 50%, var(--panel));
  background: color-mix(in srgb, var(--accent) 19%, var(--panel));
  padding: 0 5px;
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  overflow: hidden;
  transition: border-color 0.12s, background-color 0.12s;
}

.tg-syl-blk.has-poly {
  padding-right: 14px;
}

.tg-syl-blk.is-narrow {
  padding: 0 3px;
  justify-content: center;
}

.tg-syl-blk.is-narrow.has-poly {
  padding-right: 12px;
}

.tg-syl-blk.is-tiny {
  padding: 0;
}

.tg-syl-blk:hover {
  border-color: var(--accent);
}

.tg-syl-txt {
  font-size: 0.958333rem;
  flex: 1 0 auto;
  min-width: 0;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tg-tone-tag {
  font-size: 0.75rem;
  color: var(--muted);
  flex: 0 1 auto;
}

.poly-tri-btn {
  position: absolute;
  right: 1px;
  bottom: 0;
  width: 15px;
  height: 15px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--warning);
  font-size: 0.833333rem;
  line-height: 1;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  cursor: pointer;
  z-index: 3;
}

.poly-tri-btn:hover {
  color: var(--danger);
  transform: scale(1.18);
}

.poly-menu-hdr {
  padding: 4px 8px;
  font-size: 0.833333rem;
  font-weight: 700;
  color: var(--muted);
  border-bottom: 1px solid var(--panel-border);
}

.tg-marquee {
  position: absolute;
  top: 0;
  bottom: 0;
  background: var(--selection);
  border: 1px dashed var(--accent);
  pointer-events: none;
  z-index: 6;
}

.tg-phone-blk {
  position: absolute;
  top: 2px;
  bottom: 3px;
  border-radius: max(2px, calc(var(--r-ctrl) - 3px));
  border: 1px solid color-mix(in srgb, var(--teal) 42%, var(--border));
  background: color-mix(in srgb, var(--teal) 24%, var(--panel));
  padding: 0 5px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 3px;
  cursor: pointer;
  overflow: hidden;
}

.tg-phone-blk.is-compact {
  padding: 0 2px;
  justify-content: center;
}

.tg-phone-blk.is-tiny {
  padding: 0;
}

.tg-phone-blk.voiceless {
  border-color: color-mix(in srgb, var(--muted) 55%, var(--border));
  background: repeating-linear-gradient(120deg, transparent 0 6px, color-mix(in srgb, var(--teal) 10%, transparent) 6px 8px),
    color-mix(in srgb, var(--teal) 8%, var(--panel));
}

.tg-phone-blk.stop {
  border-style: dashed;
}

.tg-tier .selected {
  background: color-mix(in srgb, var(--accent) 35%, var(--panel));
  border-color: var(--accent);
  color: var(--text);
  font-weight: 700;
  transition: none;
}
.tg-tier .selection-group:not(.selection-focus)::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--accent);
  pointer-events: none;
}
.tg-tier .selected.selection-focus {
  z-index: 2;
  background: var(--accent);
  border: 1px solid var(--accent);
  color: var(--on-accent);
  box-shadow: inset 0 0 0 1px var(--on-accent);
}
.tg-tier .selection-focus :is(.tg-tone-tag, .tg-phone-ms, .tg-phone-sym) {
  color: inherit;
}

.tg-phone-sym {
  font-size: 1.041667rem;
  font-weight: 600;
  color: var(--text);
}

.tg-phone-ms {
  font-size: 0.733333rem;
  color: var(--muted);
}

.seg-edge-handle {
  position: absolute;
  top: 0;
  right: -2px;
  bottom: 0;
  width: 7px;
  cursor: col-resize;
  z-index: 5;
}

.seg-edge-handle:hover {
  background: color-mix(in srgb, var(--accent) 48%, transparent);
}

/* A narrow rail connects each fixed header to its scrollable track. */
.rt-hdr-annotation, .rt-lane-tg { --track-color: var(--accent); }
.rt-hdr-art, .rt-lane-art { --track-color: color-mix(in srgb, var(--danger) 72%, var(--violet)); }
.rt-hdr-phon, .rt-lane-phon { --track-color: var(--violet); }
.rt-hdr-f0, .rt-lane-f0 { --track-color: var(--warning); }
.rt-hdr-ps, .rt-lane-ps { --track-color: var(--teal); }
.rt-hdr-wave, .rt-lane-wave { --track-color: var(--success); }
.rt-lane { background-color: color-mix(in srgb, var(--track-color) 9%, var(--panel)); }
.rt-hdr-row {
  box-shadow: inset 3px 0 var(--track-color);
  background: linear-gradient(90deg, color-mix(in srgb, var(--track-color) 16%, transparent), transparent);
  padding-inline-start: 11px;
}
.rt-hdr-annotation {
  box-shadow: none;
}
.rt-hdr-annotation::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: linear-gradient(var(--accent) 50%, var(--teal) 50%);
}
.rt-lane-art { background-color: color-mix(in srgb, var(--track-color) 10%, var(--panel)); }
.rt-lane-art .kf-diamond { border-color: var(--track-color); }
.rt-lane-art .kf-dot.active .kf-diamond { background: var(--track-color); }
.rt-lane-art .art-guide-line { background: color-mix(in srgb, var(--track-color) 40%, transparent); }

.art-guide-line {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 1px;
  background: color-mix(in srgb, var(--border) 75%, transparent);
}

.kf-dot {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  background: transparent;
  display: grid;
  place-items: center;
  cursor: pointer;
  z-index: 4;
}

.kf-diamond {
  width: 9px;
  height: 9px;
  transform: rotate(45deg);
  border-radius: 1.5px;
  background: var(--panel);
  border: 1.8px solid var(--accent);
  transition: transform 0.12s, background-color 0.12s;
}

.kf-dot:hover .kf-diamond,
.kf-dot.selected .kf-diamond {
  background: var(--selected);
  transform: rotate(45deg) scale(1.2);
}

.kf-dot.active .kf-diamond {
  background: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--selection);
}

.lane-svg {
  position: absolute;
  left: var(--view-left);
  display: block;
  pointer-events: none;
}

.rt-edit-dialog {
  width: min(360px, calc(100vw - 32px));
  padding: 16px;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: var(--r-panel);
  box-shadow: var(--popover-shadow);
}
.rt-edit-dialog::backdrop { background: var(--overlay); }
.rt-edit-form { display: grid; gap: 12px; }
.rt-edit-form label { display: grid; gap: 4px; }
.rt-edit-error { color: var(--danger); margin: 0; }
.rt-edit-actions { display: flex; justify-content: flex-end; gap: 8px; }

.lane-axis-txt {
  font-size: 0.708333rem;
  fill: var(--muted);
  opacity: 0.85;
}

.phon-node {
  position: absolute;
  transform: translate(-50%, -50%);
  height: 16px;
  padding: 0 5px;
  border-radius: 999px;
  border: 1.5px solid var(--violet);
  background: var(--panel);
  color: var(--violet);
  font-size: 0.75rem;
  font-weight: 700;
  cursor: grab;
  z-index: 5;
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
}

.phon-node:active {
  cursor: grabbing;
}

.phon-node.selected {
  background: var(--violet);
  color: var(--on-accent);
  box-shadow: 0 0 0 3px var(--violet-bg);
}

.phon-node-lbl {
  line-height: 1;
}

.f0-target-dot {
  position: absolute;
  transform: translate(-50%, -50%);
  width: 9px;
  height: 9px;
  padding: 0;
  border-radius: 50%;
  border: 1.6px solid var(--accent);
  background: var(--panel);
  cursor: ns-resize;
  z-index: 5;
}

.f0-target-dot:hover {
  background: var(--accent);
  transform: translate(-50%, -50%) scale(1.25);
}

.rt-shell.rt-drop-active {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 2px var(--selection);
}

.rt-lane-tg.tg-drop-active {
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
  background: color-mix(in srgb, var(--accent) 16%, var(--panel));
}

.tg-import-hint {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 9;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 8px;
  border-radius: var(--r-ctrl);
  background: var(--panel);
  font-size: 0.916667rem;
  line-height: 1.35;
  pointer-events: none;
}
.tg-import-hint > .vc-icon { color: var(--accent); }
.tg-import-hint span { display: block; }
.tg-drop-active .tg-import-hint { color: var(--accent); }

.syl-edge-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 4;
}
.syl-edge-handle.left {
  left: 0;
  border-left: 2px solid transparent;
}
.syl-edge-handle.right {
  right: 0;
  border-right: 2px solid color-mix(in srgb, var(--accent) 45%, transparent);
}
.syl-edge-handle:hover {
  background: color-mix(in srgb, var(--accent) 42%, transparent);
}

.rt-playhead.flash {
  width: 3px;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--danger) 35%, transparent), 0 0 12px var(--danger);
  animation: rt-playhead-pulse 0.7s ease-out;
}
@keyframes rt-playhead-pulse {
  0% { opacity: 1; transform: scaleX(1.8); }
  50% { opacity: 0.45; transform: scaleX(1); }
  100% { opacity: 1; transform: scaleX(1); }
}

.f0-legend-pill {
  position: absolute;
  top: 3px;
  z-index: 4;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 0.766667rem;
  color: var(--muted);
  background: color-mix(in srgb, var(--panel) 84%, transparent);
  border: 1px solid color-mix(in srgb, var(--panel-border) 65%, transparent);
  pointer-events: none;
  white-space: nowrap;
}
.f0-perturb-badge {
  color: var(--warning);
  font-weight: 700;
}

.rt-phone-popover {
  position: fixed;
  z-index: var(--z-popover);
  zoom: var(--page-scale);
  padding: 10px 11px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  gap: 8px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: var(--r-panel);
  box-shadow: var(--popover-shadow);
  font-size: 0.916667rem;
}
.rt-reading-menu {
  zoom: var(--page-scale);
  overflow-y: auto;
}
.rt-pop-unit {
  font-size: 0.816667rem;
  white-space: nowrap;
}
.rt-stop-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  padding: 4px 6px;
  border-radius: var(--r-ctrl);
  background: var(--teal-bg);
  color: var(--teal);
  font-size: 0.783333rem;
}
.rt-pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding-bottom: 5px;
  border-bottom: 1px solid var(--panel-border);
}
.rt-pop-sec {
  display: grid;
  gap: 4px;
}
.rt-pop-lbl {
  font-size: 0.833333rem;
  font-weight: 600;
  color: var(--muted);
}
.rt-pop-row {
  display: flex;
  align-items: center;
  gap: 5px;
}
.rt-pop-row .inp {
  flex: 1;
  min-width: 0;
  height: 25px;
}
.rt-pop-row .rt-insert-duration { flex: 0 0 75px; }
.rt-pop-grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
}
.rt-lane-wave {
  cursor: crosshair;
  user-select: none;
}
.rt-cut-range-band {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 7;
  background: color-mix(in srgb, var(--danger) 20%, transparent);
  border-left: 1.5px dashed var(--danger);
  border-right: 1.5px dashed var(--danger);
  pointer-events: none;
}
.rt-cut-range-tag {
  position: absolute;
  top: 2px;
  left: 4px;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 0.75rem;
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  color: var(--danger);
  white-space: nowrap;
}
.rt-phone-ctx {
  position: fixed;
  z-index: var(--z-popover);
  zoom: var(--page-scale);
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: var(--r-panel);
  box-shadow: var(--popover-shadow);
}
.rt-ctx-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 9px;
  border: none;
  border-radius: var(--r-ctrl);
  background: transparent;
  color: var(--text);
  font-size: 0.86rem;
  text-align: left;
  cursor: pointer;
}
.rt-ctx-item:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent);
}
.rt-ctx-item.danger {
  color: var(--danger);
}
.rt-ctx-item.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: var(--danger);
}
.rt-ctx-item:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}
.tg-gap-blk {
  position: absolute;
  top: 3px;
  bottom: 3px;
  border-radius: var(--r-ctrl);
  border: 1px dashed color-mix(in srgb, var(--muted) 38%, transparent);
  background: color-mix(in srgb, var(--muted) 8%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background var(--dur-fast) ease, border-color var(--dur-fast) ease;
}
.tg-gap-blk:hover {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
}
.tg-gap-ms {
  font-size: 0.72rem;
  color: var(--muted);
  pointer-events: none;
  user-select: none;
}
.tg-gap-blk:hover .tg-gap-ms {
  color: var(--accent);
}
.gap-edge-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  right: -3px;
  width: 7px;
  cursor: ew-resize;
}
.gap-edge-handle::after {
  content: '';
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 3px;
  width: 2px;
  border-radius: 1px;
  background: transparent;
  transition: background var(--dur-fast) ease;
}
.tg-gap-blk:hover .gap-edge-handle::after,
.gap-edge-handle:hover::after {
  background: var(--accent);
}
.rt-gap-hint {
  margin: 0;
  font-size: 0.8rem;
}
</style>
