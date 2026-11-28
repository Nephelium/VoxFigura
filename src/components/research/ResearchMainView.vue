<script lang="ts">
import { shallowRef as rememberFiles } from 'vue';

interface LocalWorkspaceFile {
  id: string;
  name: string;
  relativePath: string;
  ext: string;
  sizeKb: number;
  file?: File;
}
const annotationSource = rememberFiles<{
  projectId: string;
  baseline: import('@vocalcut/core').Clip;
  controls: string;
  origin?: import('@/data/workspace-transfer').WorkspaceAudio['stageOrigin'];
  target?: import('@/data/workspace-transfer').WorkspaceAudio['stageAudioTrack'];
  rows?: number[][];
  speakerWavBase64?: string;
} | null>(null);
const localFiles = rememberFiles<LocalWorkspaceFile[]>([]);
const loadedAnnotationRecording = rememberFiles<{
  raw: File;
  rawAudio: AudioBuffer;
  cleanAudio?: AudioBuffer;
  denoised: boolean;
  uploadedTextGrid?: import('@vocalcut/core').TextGridDocument | null;
  uploadedTextGridName?: string;
} | null>(null);
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, watchEffect } from 'vue';
import ModuleGuideButton from '@/components/guide/ModuleGuideButton.vue';
import { publishPanelSnapshot } from '@/data/panel-snapshots';
import {
  getSavedCorpusDirectory, pickCorpusDirectory, readCorpusDirectory, saveCorpusDirectory,
  supportsCorpusDirectoryPicker, type CorpusDirectoryHandle, type CorpusFile,
} from './corpus-directory';
import {
  PRESSURE_LIMIT_PA,
  SAMPLE_RATE_HZ,
  isValidF0Hz,
  msToSamples,
  parseTextGrid,
  samplesToMs,
  type Clip,
  type F0PinPoint,
  type PhonationAnchor,
  type SegmentAnchor,
  type Syllable,
  type TextGridDocument,
  type TractDelta,
  type TractParamName,
} from '@vocalcut/core';
import {
  IPA_LONG_PAUSE_MS,
  japaneseKanjiReadingsFor,
  loadCmu,
  reviewText, japaneseReadingsFor, type KanaLexicon,
  mappingStandards,
  type Lexicon,
  type MappingStandard,
  type ReadingRow,
} from '@vocalcut/g2p';
import { M27Adapter } from '@vocalcut/model-adapters';
import { interpM27AnimState } from '@/vendor/m27-tract-studio/tract-renderer.js';
import {
  VTL_PARAM_META,
  defaultTractParams,
  tractArray19ToRecord,
  tractRecordToArray19,
  useWorkbenchStore,
  type WorkbenchCommand,
  type SynthesisInfo,
} from '@/stores/workbench';
import {
  cloneTractExtras,
  DEFAULT_TRACT_EXTRAS,
  preloadPtbIpaPresets,
  ptbPresetsVersion,
  type TractPoseExtras,
} from '@/data/ptb-ipa-presets';
import { getCurrentPageScale } from '@/styles/skin-registry';
import type { SelectOption } from '@/components/common/CustomSelect.vue';
import VocalTractViewport from '@/components/common/VocalTractViewport.vue';
import CustomSelect from '@/components/common/CustomSelect.vue';
import { applyPeakAudioGain, synthesisGainMode, voiceRenderLabels, voiceRenderMode, type VoiceRenderMode } from '@/data/voice-renderer';
import SplitPane from '@/components/common/SplitPane.vue';
import CompactSlider from '@/components/common/CompactSlider.vue';
import IconSvg from '@/components/common/IconSvg.vue';
import SpeakerReferenceSelect from '@/components/common/SpeakerReferenceSelect.vue';
import { DEFAULT_SPEAKER_REFERENCE_NAME, effectiveSpeakerBaseF0Hz, speakerReferenceId } from '@/data/synthesis-speaker';
import { textPoseOptions, textPoseSource } from '@/data/ipa-pose-source';
import { resolveSyllablePoseSource } from './annotation-audio';
import { needsKanaReading, resolveKanaPhones } from './japanese-annotation';
import ResearchTimeline from './ResearchTimeline.vue';
import {
  syncSyllableTextFromSegments,
  trackFrameAt,
  waveSampleRate,
  withImportedTractFrames,
  type AnnotationTractFrame,
} from './annotation-edit';
import {
  detectLeadingTrailingSilence,
  exciseAudioBufferRange,
  exciseClipAndControlsRange,
  exciseM27TrajectoryRange,
  exciseTextGridRange,
} from './audio-cut';
import { metricsFromVtlSnapshot, readRealPeaks } from '@/data/vtl-acoustic';
import { changedAudioSpans, currentAnnotationControls, replaceRenderedSpans } from './annotation-return';
import { audioBufferFile, pendingPianoPitch, arrangerSource, arrangerStageOrigin, arrangerStageTarget, sendWorkspaceAudio, takeWorkspaceAudio, type AudioDestination } from '@/data/workspace-transfer';
import { denoiseFile } from '@/data/denoise';
import { clipFromTextGrid, readTextGridFile } from '@/data/textgrid-alignment';
import {
  buildJapaneseAccentClipData,
  extractMixedProsodyRuns,
  mapProsodyRunDurationsMs,
  mapProsodyRunPitchToTimeline,
  predictSpeechProsody,
  textProsodyEnabled,
} from '@/data/prosody-model';
import { splitTextIntoSentences, type SentenceLanguage } from '@/data/sentence-compiler';
import { synthesizeClipBySentences } from './sentence-synthesis';
import { RECORDED_IPA_SET_ID, ipaPoseSetRevision, ipaPoseSets, loadDefaultIpaPoses, loadModelDefaultIpaPoses, selectedIpaPoseSetId } from '@/data/ipa-pose-sets';
import {
  formatVowelChartLabel,
  isRoundedVowelSymbol,
  loadVowelMeasurements,
  measureSavedVowelPoses,
  vowelSymbolKey,
  type VowelReferenceMode,
} from '@/data/ipa-vowel-measurements';
import { buildSyllableQtaTargets, combineIpaDiacritic, nasalPoseIpa, parseIpaSuprasegmentals, phoneTraits, usesTrialReferenceTrajectory } from '@/data/ipa-segments';
import { copyTextToClipboard } from '@/components/common/clipboard';
import { unmarkedIpaPitchMode } from './control-pitch';
import {
  connectedRuleDurationScale,
  isSegmentVoicedAt,
  rescaleClipForSpeechRate,
  speechDurationScale,
  speechPhoneDurations,
  speechStopTiming,
  type SpeechRate,
} from '@/data/speech-timing';
import { buildPhonationAnchorsFromVoqsSyllables, parseVoqsScopedText, type ActiveVoqsState } from '@/data/voqs-parser';
import {
  activeUserEntryCount,
  activeUserLexiconBook,
  buildPersonalG2pMap,
  createUserLexiconBook,
  dictionaryPrefs,
  exportUserLexiconJson,
  importUserLexiconJson,
  lookupUserLexiconEntry,
  lookupUserLexiconReading,
  saveSyllableToUserLexicon,
  updateDictionaryPrefs,
  userLexiconBooks,
} from '@/data/user-lexicon';
import { fetchIpaReferences, ipaReferenceUrl } from '@/data/ipa-reference-library';
import { planDialect, savedDialects, tokenizeDialect } from '@/data/dialect-user-library';
import { mandarinDictionaryOptions } from '@/data/pronunciation-dictionaries';
import { speechLexiconSelection } from './speech-lexicon';
import { buildQuickIpaClip, buildQuickIpaGroups, canSynthesizeQuickIpa, findQuickIpaTake, quickIpaKey, type QuickIpaCatalog, type QuickIpaGroup } from './quick-ipa';
import {
  CORPUS_DRAG_MIME,
  QUICK_IPA_ITEMS,
  SPEAKER_OPTIONS,
  blobToBase64,
  buildSegmentsForSyllable,
  corpusDragFileRegistry,
  downloadTextFile,
  encodeMonoWavBase64,
  estimateSyllableNaturalDurationMs,
  extractSegmentExtras,
  getFullPoseForIpa,
  ipaFavorites,
  customIpaPoses,
  poseOverridesForSet,
  replaceSegmentIpa,
  splitIpaToPhonemes,
  type QuickIpaItem,
} from './research-utils';
import {
  buildPtbLipFrontData,
  clientXToSectionIndex,
  computeAreaReadouts,
  drawPtbAreaChart,
  drawPtbSectionChart, sectionView,
  drawPtbSpectrumChart,
  drawPtbVowelSpace,
  invalidateChartThemeCache,
  isSnapshotNasalCoupled,
  panVowelSpaceAxes,
  readPeaks,
  zoomVowelSpaceAxes,
  type PtbPoseSnapshot,
  type VowelCoordinateScale,
  type VowelReferencePoint,
  type VowelSpaceAxes,
  type VowelTrailPoint,
} from './ptb-physics-charts';
import {
  getCachedVtlPose,
  isVtlPosePendingOrCached,
  prefetchVtlPoseBatch,
  resolveVtlPose,
  type PoseRequest,
} from '@/data/vtl-pose-client';

const store = useWorkbenchStore();

// Resizable layout dimensions (SplitPane persisted)
const leftW = ref(252);
const dockHeight = ref(382);
const upperRightPairRef = ref<HTMLElement | null>(null);
const upperPairWidth = ref(1200);
const tractSplitRatio = ref(0.44);
try {
  const savedTractRatio = Number(localStorage.getItem('vocalcut.researchTractRatio'));
  if (savedTractRatio >= 0.25 && savedTractRatio <= 0.72) tractSplitRatio.value = savedTractRatio;
} catch {
  // retain default split
}
const tractPaneW = computed({
  get: () => {
    const avail = Math.max(640, upperPairWidth.value - 6);
    const minW = Math.min(340, Math.round(avail * 0.3));
    const maxW = Math.max(minW, avail - Math.min(440, Math.round(avail * 0.36)));
    return Math.max(minW, Math.min(maxW, Math.round(avail * tractSplitRatio.value)));
  },
  set: (px: number) => {
    const avail = Math.max(640, upperPairWidth.value - 6);
    const ratio = Math.max(0.25, Math.min(0.72, px / avail));
    tractSplitRatio.value = ratio;
    try {
      localStorage.setItem('vocalcut.researchTractRatio', ratio.toFixed(4));
    } catch {
      // ignore storage errors
    }
  },
});
const corpusDrawerOpen = ref(false);
const corpusDragging = ref(false);
const tractParamsOpen = ref(false);

// Select options replacing native select elements (AGENTS.md §5.3)
const vowelSourceOptions: ReadonlyArray<SelectOption<VowelReferenceMode>> = [
  { value: 'recorded', label: '原音' },
  { value: 'transfer', label: '构型' },
];
const vowelScaleOptions: ReadonlyArray<SelectOption<VowelCoordinateScale>> = [
  { value: 'logarithmic', label: '对数' },
  { value: 'linear', label: '线性' },
];
const enDictModeOptions: ReadonlyArray<SelectOption<'cmudict-personal' | 'cmudict-only'>> = [
  { value: 'cmudict-personal', label: 'CMUdict + 个人英语词典优先（支持多音节切分）' },
  { value: 'cmudict-only', label: '仅使用内置 CMUdict' },
];
const jaDictModeOptions: ReadonlyArray<SelectOption<'standard-personal' | 'standard-only'>> = [
  { value: 'standard-personal', label: '日语标准假名词典 + 个人日语词典优先' },
  { value: 'standard-only', label: '仅使用内置日语标准词典' },
];
const reconstructLangOptions: ReadonlyArray<SelectOption<'auto' | 'zh' | 'en'>> = [
  { value: 'auto', label: '自动识别语言' },
  { value: 'zh', label: '普通话 (中文)' },
  { value: 'en', label: '英语 (English)' },
];
const dialectPackOptions = computed<SelectOption<string>[]>(() => [
  { value: '', label: '不启用独立方言包（使用中/英/日混排规则）' },
  ...savedDialects.value.map((pack) => ({ value: pack.id, label: pack.name })),
]);
const userLexiconBookOptions = computed<SelectOption<string>[]>(() =>
  userLexiconBooks.value.map((book) => ({
    value: book.id,
    label: `${book.name} (${Object.keys(book.entries).length})`,
  })),
);
const mandarinStandardSelectOptions = computed<SelectOption<MappingStandard>[]>(() =>
  mandarinStandardOptions.map((opt) => ({ value: opt.value as MappingStandard, label: opt.label })),
);

// Top G2P & Multi-Language Dictionary Controls (T-45)
const g2pText = ref(store.project.value.clips[store.activeClipId.value]?.source?.lyrics ?? '');
const mandarinStandards = mappingStandards;
const preferredMapping = store.project.value.clips[store.activeClipId.value]?.source?.transcription ?? '';
const g2pStandard = ref<string>(
  savedDialects.value.some((pack) => pack.id === preferredMapping)
    ? preferredMapping
    : mandarinStandards.some((item) => item === preferredMapping)
      ? preferredMapping
      : dictionaryPrefs.value.zhStandard,
);
if (mandarinStandards.some((item) => item === g2pStandard.value)) {
  updateDictionaryPrefs({ zhStandard: g2pStandard.value as MappingStandard });
}
const mandarinStandardOptions = mandarinDictionaryOptions;
const selectedDictionary = computed(() => savedDialects.value.find(pack => pack.id === g2pStandard.value));
const activeDictButtonLabel = computed(() => {
  if (selectedDictionary.value) return `方言 · ${selectedDictionary.value.name}`;
  const effectiveStd = mandarinStandards.some((item) => item === g2pStandard.value)
    ? g2pStandard.value
    : dictionaryPrefs.value.zhStandard;
  const zhLbl = effectiveStd === 'Standard Chinese (Beijing)'
    ? '北京官话宽'
    : effectiveStd === 'Standard Chinese (Beijing)严'
      ? '北京官话严'
      : effectiveStd;
  return `词典 · ${zhLbl}`;
});
function selectMandarinStandard(std: MappingStandard): void {
  g2pStandard.value = std;
  updateDictionaryPrefs({ zhStandard: std });
  runG2pReview();
}
function selectDialectPack(packId: string): void {
  g2pStandard.value = packId || dictionaryPrefs.value.zhStandard;
  runG2pReview();
}
const dialectTokens = computed(() => selectedDictionary.value ? tokenizeDialect(g2pText.value.trim(), selectedDictionary.value.lexicon) : []);
const dialectChoices = ref<Record<string, number>>({});
watch([g2pText, g2pStandard], () => { dialectChoices.value = {}; });
const cmuLexicon = ref<Lexicon>(new Map());
const reviewRows = ref<ReadingRow[]>([]);

const activeVoice = computed(() => store.project.value.voices[store.activeVoiceId.value]);
const speakerModel = computed<string>({
  get: () => activeVoice.value?.speaker ?? 'JD2',
  set: (val) => {
    store.executeCommand({
      type: 'project.set_speaker',
      label: `切换说话人 ${val}`,
      payload: { voice_id: store.activeVoiceId.value, speaker: val },
    });
    void preloadPtbIpaPresets(val);
    void store.requestVtlPose(store.currentTractParams.value, val, store.currentTractExtras.value);
  },
});

// Upper Deck Vocal Tract & Physics Trio controls
const showLabels = ref(true);
const showTractGrid = ref(true);
const showHead = ref(true);
const hfMaxHz = ref<5000 | 8000>(5000);

// Top Bar File Open + Slide-Over Corpus Directory Drawer & Global Synthesis Mode (T-07, T-25)
const dropActive = ref(false);
const openFileInputRef = ref<HTMLInputElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const dirInputRef = ref<HTMLInputElement | null>(null);
const lexiconImportInputRef = ref<HTMLInputElement | null>(null);
const isDenoising = ref(false);
const annotationPlaybackSource = ref<'recording' | 'edited' | 'synthesis'>(loadedAnnotationRecording.value ? 'recording' : 'synthesis');
// T-07: Bind directly to global `voiceRenderMode` (deprecated localStorage['vocalcut.annotation.synth-mode.v1'])
const annotationRenderMode = voiceRenderMode;
const annotationModes: SelectOption<VoiceRenderMode>[] = [
  { value: 'neural', label: voiceRenderLabels.neural },
  { value: 'physical', label: voiceRenderLabels.physical },
];

async function decodeRecording(file: File): Promise<AudioBuffer> {
  const bytes = await file.arrayBuffer();
  const rate = waveSampleRate(bytes) ?? SAMPLE_RATE_HZ;
  const ctx = new OfflineAudioContext(1, 1, rate >= 8000 && rate <= 192000 ? rate : SAMPLE_RATE_HZ);
  const decoded = await ctx.decodeAudioData(bytes);
  if (synthesisGainMode.value === 'peak') applyPeakAudioGain(decoded);
  return decoded;
}

function showRecordingVersion(denoised: boolean): void {
  const recording = loadedAnnotationRecording.value;
  if (!recording || (denoised && !recording.cleanAudio)) return;
  const buffer = denoised ? recording.cleanAudio! : recording.rawAudio;
  annotationPlaybackIntent++;
  store.stopPlayback();
  annotationPlaybackSource.value = 'recording';
  loadedAnnotationRecording.value = { ...recording, denoised };
  store.annotationAudioBuffer.value = buffer;
  store.annotationAudioOffsetSmp.value = 0;
  store.lastAudioBuffer.value = buffer;
}

async function denoiseAnnotationRecording(): Promise<void> {
  const recording = loadedAnnotationRecording.value;
  if (!recording || isDenoising.value) return;
  if (recording.cleanAudio) {
    showRecordingVersion(true);
    return;
  }
  isDenoising.value = true;
  try {
    const clean = await denoiseFile(recording.raw);
    const cleanAudio = await decodeRecording(clean);
    if (loadedAnnotationRecording.value !== recording) return;
    loadedAnnotationRecording.value = { ...recording, cleanAudio };
    showRecordingVersion(true);
  } catch (error) {
    if (loadedAnnotationRecording.value === recording) {
      store.pushToast(error instanceof Error ? error.message : '录音降噪失败', 'warning');
    }
  } finally {
    isDenoising.value = false;
  }
}

watch(store.annotationResetVersion, () => {
  if (!store.annotationAudioBuffer.value) {
    loadedAnnotationRecording.value = null;
    annotationPlaybackSource.value = 'synthesis';
  }
});

const isEditedRecordingActive = computed(() => Boolean(store.editedAnnotationAudio.value
  && store.annotationAudioBuffer.value === store.editedAnnotationAudio.value));

function showEditedRecording(): void {
  const edited = store.editedAnnotationAudio.value;
  if (!edited) return;
  annotationPlaybackIntent++;
  store.stopPlayback();
  annotationPlaybackSource.value = 'edited';
  store.annotationAudioBuffer.value = edited;
  store.annotationAudioOffsetSmp.value = 0;
  store.lastAudioBuffer.value = edited;
}

watch(store.editedAnnotationAudio, (edited, previous) => {
  if (!loadedAnnotationRecording.value) return;
  if (edited) showEditedRecording();
  else if (store.annotationAudioBuffer.value === previous) {
    showRecordingVersion(loadedAnnotationRecording.value.denoised);
  }
});

// Compact Permanent Quick-Replace IPA Grid
const quickTab = ref<QuickIpaItem['category'] | 'favorites'>('vowel');
const focusedQuickIpa = ref<QuickIpaItem>(QUICK_IPA_ITEMS[0]);
const focusedQuickDiacritic = ref<QuickIpaItem>();
const catalogGroups = shallowRef<QuickIpaGroup[]>([]);
function buildFallbackQuickIpaGroups(): QuickIpaGroup[] {
  const byCategory: Record<QuickIpaItem['category'], QuickIpaItem[]> = {
    vowel: [],
    consonant: [],
    diacritic: [],
  };
  for (const item of QUICK_IPA_ITEMS) byCategory[item.category].push(item);
  const groups: QuickIpaGroup[] = [
    { label: '单元音', category: 'vowel', items: byCategory.vowel },
    { label: '常用辅音', category: 'consonant', items: byCategory.consonant },
    { label: '附加符号', category: 'diacritic', items: byCategory.diacritic },
  ];
  return groups.filter((g) => g.items.length > 0);
}

onMounted(async () => {
  try {
    const base = (import.meta.env?.BASE_URL ?? '/').replace(/\/?$/, '/');
    const res = await fetch(`${base}data/ipa-plus-catalog.json`);
    if (!res.ok) throw new Error();
    catalogGroups.value = buildQuickIpaGroups(await res.json() as QuickIpaCatalog);
  } catch {
    catalogGroups.value = buildFallbackQuickIpaGroups();
    store.pushToast('完整音标表载入失败，已切换至内置快捷音标表', 'warning');
  }
});
const catalogQuickIpa = computed(() => new Map(
  catalogGroups.value.filter(group => group.category !== 'diacritic')
    .flatMap(group => group.items.map(item => [quickIpaKey(item.symbol), item] as const)),
));
const quickGroups = computed(() => quickTab.value === 'favorites'
  ? [{ label: '常用音标', items: [...new Set(ipaFavorites.value.map(item => quickIpaKey(item.symbol)))]
    .flatMap(key => {
      const cat = catalogQuickIpa.value.get(key);
      if (cat) return [cat];
      const fav = ipaFavorites.value.find(item => quickIpaKey(item.symbol) === key);
      return fav ? [fav] : [];
    }) }]
  : catalogGroups.value.filter(group => group.category === quickTab.value));
const filteredQuickIpa = computed(() => quickGroups.value.flatMap(group=>group.items));

let upperPairObserver: ResizeObserver | undefined;
onMounted(() => {
  if (!upperRightPairRef.value || typeof ResizeObserver === 'undefined') return;
  upperPairObserver = new ResizeObserver(([entry]) => {
    if (entry.contentRect.width > 120) upperPairWidth.value = entry.contentRect.width;
  });
  upperPairObserver.observe(upperRightPairRef.value);
});
onBeforeUnmount(() => upperPairObserver?.disconnect());

// Selected Syllable & Phoneme(s)
const activeClip = computed(() => store.project.value.clips[store.activeClipId.value]);
const speechRate = ref<SpeechRate>('medium');
let suppressSpeechRateWatch = false;
const speechRateOptions = [
  { value: 'slow', label: '语速 · 慢速' },
  { value: 'medium', label: '语速 · 中速' },
  { value: 'fast', label: '语速 · 快速' },
];
const speechRateLabelMap: Record<SpeechRate, string> = {
  slow: '语速 · 慢速',
  medium: '语速 · 中速',
  fast: '语速 · 快速',
};

watch(speechRate, (next, prev) => {
  if (suppressSpeechRateWatch || !prev || next === prev) return;
  const clip = activeClip.value;
  if (!clip || !clip.syllable_order.length || loadedAnnotationRecording.value) {
    store.pushToast(`已切换为${speechRateLabelMap[next]}，将在下次编译入轨时生效`, 'info', 2200);
    return;
  }
  const factor = speechDurationScale[next] / speechDurationScale[prev];
  const rescaled = rescaleClipForSpeechRate(
    clip,
    {
      phonation_anchors: store.project.value.phonation_anchors,
      f0_pins: store.project.value.f0_pins ?? [],
    },
    factor,
  );
  const res = store.executeCommand(
    {
      type: 'clip.edit',
      label: `调整${speechRateLabelMap[next]}`,
      payload: {
        clip: rescaled.clip,
        retimed: rescaled.retimed,
      },
    },
    {
      localEdit: {
        undo: () => {
          suppressSpeechRateWatch = true;
          speechRate.value = prev;
          void nextTick(() => {
            suppressSpeechRateWatch = false;
          });
        },
        redo: () => {
          suppressSpeechRateWatch = true;
          speechRate.value = next;
          void nextTick(() => {
            suppressSpeechRateWatch = false;
          });
        },
      },
    },
  );
  if (res.ok) {
    store.clearAnnotationAudio();
    store.playheadSmp.value = Math.min(store.playheadSmp.value, Math.max(0, rescaled.clip.end_smp - 1));
    store.pushToast(
      `已切换为${speechRateLabelMap[next]}（时长 ${(rescaled.clip.end_smp / SAMPLE_RATE_HZ).toFixed(2)} s）`,
      'success',
      2200,
    );
  }
});
interface AnnotationRender {
  key: string;
  buffer: AudioBuffer;
  start: number;
  provenance?: SynthesisInfo;
}
const displayedAnnotationRender = shallowRef<AnnotationRender>();
const annotationRenderKey = computed(() => {
  const project = store.project.value, clip = activeClip.value;
  const source = annotationSource.value?.projectId === project.id && annotationSource.value.baseline.id === clip?.id
    ? annotationSource.value
    : null;
  const spkTag = store.customSpeakerAudioBase64.value
    ? `custom:${speakerReferenceId.value}:${effectiveSpeakerBaseF0Hz.value}`
    : source?.speakerWavBase64
      ? `input:${source.speakerWavBase64.slice(0, 24)}`
      : 'default';
  return JSON.stringify([project.id, project.revision, clip?.id, clip?.start_smp, clip?.end_smp,
    store.annotationResetVersion.value, annotationRenderMode.value, synthesisGainMode.value, unmarkedIpaPitchMode.value,
    source ? null : textPoseSource.value,
    source ? null : ipaPoseSetRevision.value,
    annotationRenderMode.value === 'neural' ? `${store.computeDevice.value}:${spkTag}` : 'cpu']);
});
const hasSynthesizedRecording = computed(() => displayedAnnotationRender.value?.key === annotationRenderKey.value);
const synthStatusState = computed<'synthesizing' | 'ready' | 'pending' | 'empty'>(() => {
  if (annotationSynthesizing.value) return 'synthesizing';
  if (annotationPlaybackSource.value === 'recording' && loadedAnnotationRecording.value) return 'ready';
  if (annotationPlaybackSource.value === 'edited' && store.editedAnnotationAudio.value) return 'ready';
  if (hasSynthesizedRecording.value) return 'ready';
  if (canSynthesizeAnnotation.value) return 'pending';
  return 'empty';
});
const synthStatusText = computed(() => {
  switch (synthStatusState.value) {
    case 'synthesizing':
      return '合成中…';
    case 'ready':
      return '已就绪';
    case 'pending':
      return '待合成';
    default:
      return '待输入';
  }
});
const streamingTractFrames = shallowRef<AnnotationTractFrame[] | null>(null);
const followingSynthesis = computed(() =>
  annotationPlaybackSource.value === 'synthesis'
  && (hasSynthesizedRecording.value || Boolean(streamingTractFrames.value?.length)),
);
const displayedTractFrames = computed(() =>
  followingSynthesis.value
    ? (hasSynthesizedRecording.value
        ? displayedAnnotationRender.value?.provenance?.tractFrames
        : streamingTractFrames.value ?? undefined)
    : store.annotationTractFrames.value,
);
const followImportedTract = ref(false);
const playheadScrubActive = ref(false);
const followingPlayheadTrajectory = computed(() =>
  followImportedTract.value || playheadScrubActive.value || (followingSynthesis.value && store.isPlaying.value),
);
const activeTrajectoryIndex = computed<number>(() => {
  const clip = activeClip.value;
  const frames = displayedTractFrames.value;
  if (!followingPlayheadTrajectory.value || !clip || !frames?.length) return -1;
  const duration = Math.max(1, clip.end_smp - clip.start_smp);
  const u = (store.playheadSmp.value - clip.start_smp) / duration;
  const frame = trackFrameAt(frames, u);
  return frame ? frames.indexOf(frame) : -1;
});
const activeTrajectoryFrame = computed<AnnotationTractFrame | null>(() => {
  const idx = activeTrajectoryIndex.value;
  const frames = displayedTractFrames.value;
  if (idx < 0 || !frames || idx >= frames.length) return null;
  return frames[idx];
});
const importedTractParams = computed(() => {
  const frame = activeTrajectoryFrame.value;
  return frame ? tractArray19ToRecord(frame.params) : null;
});

function onTimelinePlayheadScrub(): void {
  playheadScrubActive.value = true;
}

function onTimelinePhonemeFocus(): void {
  playheadScrubActive.value = false;
}

const selectedSyllable = computed<Syllable | null>(() => {
  const clip = activeClip.value;
  if (!clip || !store.selectedSyllableId.value) return null;
  return clip.syllables[store.selectedSyllableId.value] ?? null;
});

const allSegmentsFlat = computed<Array<{ syl: Syllable; seg: SegmentAnchor }>>(() => {
  const clip = activeClip.value;
  if (!clip) return [];
  const arr: Array<{ syl: Syllable; seg: SegmentAnchor }> = [];
  for (const sid of clip.syllable_order) {
    const syl = clip.syllables[sid];
    if (!syl) continue;
    for (const seg of syl.segments) {
      arr.push({ syl, seg });
    }
  }
  return arr;
});

const playheadSegmentEntry = computed(() => {
  const t = store.playheadSmp.value;
  return allSegmentsFlat.value.find(({ seg }) => t >= seg.start_smp && t < seg.end_smp)
    ?? allSegmentsFlat.value.find(({ seg }) => t === seg.end_smp)
    ?? null;
});

const scrubFallbackParams = computed<Record<TractParamName, number> | null>(() => {
  if (!playheadScrubActive.value || importedTractParams.value) return null;
  const clip = activeClip.value;
  const list = allSegmentsFlat.value;
  if (!clip || !list.length) return null;
  const spk = speakerModel.value;
  const t = store.playheadSmp.value;
  const schwaVec = getFullPoseForIpa('ə', undefined, spk).params19;
  const vecFor = (seg: SegmentAnchor): number[] => {
    if (seg.role === 'rest' || seg.ipa === 'sil') return schwaVec;
    return seg.params && seg.params.length >= 19 && !isDefaultTractVec(seg.params)
      ? seg.params
      : getFullPoseForIpa(seg.ipa, undefined, spk).params19;
  };
  const idx = list.findIndex(({ seg }) => t >= seg.start_smp && t <= seg.end_smp);
  if (idx < 0) return tractArray19ToRecord(schwaVec);
  const seg = list[idx].seg;
  const curVec = vecFor(seg);
  if (seg.role === 'rest' || seg.ipa === 'sil') return tractArray19ToRecord(schwaVec);
  const span = Math.max(1, seg.end_smp - seg.start_smp);
  const u = (t - seg.start_smp) / span;
  const prev = idx > 0 ? list[idx - 1].seg : undefined;
  const next = idx + 1 < list.length ? list[idx + 1].seg : undefined;
  if (u < 0.25 && prev && prev.end_smp === seg.start_smp && prev.role !== 'rest' && prev.ipa !== 'sil') {
    const prevVec = vecFor(prev);
    const alpha = 0.5 + 0.5 * (u / 0.25);
    return tractArray19ToRecord(curVec.map((v, i) => prevVec[i] + (v - prevVec[i]) * alpha));
  }
  if (u > 0.75 && next && next.start_smp === seg.end_smp && next.role !== 'rest' && next.ipa !== 'sil') {
    const nextVec = vecFor(next);
    const alpha = 0.5 * ((u - 0.75) / 0.25);
    return tractArray19ToRecord(curVec.map((v, i) => v + (nextVec[i] - v) * alpha));
  }
  return tractArray19ToRecord(curVec);
});

const activeScrubTractParams = computed(() => importedTractParams.value ?? scrubFallbackParams.value);

const primarySelectedEntry = computed(() => {
  const firstId = store.selectedPhonemeIds.value[0];
  if (firstId) {
    const found = allSegmentsFlat.value.find((x) => x.seg.id === firstId);
    if (found) return found;
  }
  if (selectedSyllable.value?.segments[0]) {
    return { syl: selectedSyllable.value, seg: selectedSyllable.value.segments[0] };
  }
  return null;
});

// Keep tract params & quick IPA grid highlight synced when selected phoneme changes
const hoveredQuickIpa = ref<QuickIpaItem | null>(null);
const displayQuickIpa = computed(() => hoveredQuickIpa.value ?? (quickTab.value === 'diacritic'
  ? focusedQuickDiacritic.value ?? filteredQuickIpa.value[0] ?? focusedQuickIpa.value
  : focusedQuickIpa.value));
const quickSelectedKey = computed(() => quickIpaKey(primarySelectedEntry.value?.seg.ipa));
const quickAudition = shallowRef<{ key: string; source: '实录' | 'VTL 合成' } | null>(null);
const quickAuditionBusy = ref(false);
const displayedQuickSource = computed(() => quickAudition.value?.key === quickIpaKey(displayQuickIpa.value.symbol)
  ? quickAudition.value.source : null);
let quickAuditionRequest: AbortController | undefined;
let quickReferenceList: ReturnType<typeof fetchIpaReferences> | undefined;

const DEFAULT_TRACT_VEC19 = tractRecordToArray19(defaultTractParams());
const LEGACY_PLACEHOLDER_TRACT_VEC19: readonly number[] = [
  0.55, -4.75, -0.1, -2.1, 0.28, 0.62, 0.5, 0.0,
  0.55, 0.15, 3.65, 0.35, 2.15, 0.45, -0.75, -1.85,
  0.12, 0.08, 0.05,
];
function matchesTractVec(arr: readonly number[], refVec: readonly number[]): boolean {
  for (let i = 0; i < 19; i++) {
    if (Math.abs((arr[i] ?? 0) - refVec[i]) > 1e-4) return false;
  }
  return true;
}
function isDefaultTractVec(arr?: number[]): boolean {
  if (!arr || arr.length < 19) return true;
  return matchesTractVec(arr, DEFAULT_TRACT_VEC19) || matchesTractVec(arr, LEGACY_PLACEHOLDER_TRACT_VEC19);
}

const idlePoseTouched = ref(false);

watch(
  () => [
    primarySelectedEntry.value?.seg.id,
    primarySelectedEntry.value?.seg.ipa,
    ptbPresetsVersion.value,
    speakerModel.value,
    selectedIpaPoseSetId.value,
    ipaPoseSets.value,
    ipaPoseSetRevision.value,
    store.engineStatus.value,
  ] as const,
  ([, , , spk, , , , eng]) => {
    playheadScrubActive.value = false;
    if (eng === 'python-vtl' && !Object.keys(ipaPoseSets.value[0]?.poses ?? {}).length) {
      void loadDefaultIpaPoses();
    }
    const seg = primarySelectedEntry.value?.seg;
    if (seg) {
      idlePoseTouched.value = false;
      const hasCalibratedParams = Boolean(seg.params && seg.params.length >= 19 && !isDefaultTractVec(seg.params));
      let nextParams: Record<TractParamName, number>;
      let nextExtras: TractPoseExtras;
      if (hasCalibratedParams) {
        nextParams = tractArray19ToRecord(seg.params!);
        nextExtras = extractSegmentExtras(seg, spk);
      } else {
        const poseIpa = seg.role === 'rest' || seg.ipa === 'sil' ? 'ə' : seg.ipa;
        const full = getFullPoseForIpa(poseIpa, undefined, spk);
        nextParams = full.params;
        nextExtras = extractSegmentExtras(seg, spk);
      }
      store.currentTractParams.value = { ...nextParams };
      store.currentTractExtras.value = cloneTractExtras(nextExtras);
      void store.requestVtlPose(nextParams, spk, nextExtras);
    } else if (!idlePoseTouched.value) {
      const schwa = getFullPoseForIpa('ə', undefined, spk);
      store.currentTractParams.value = { ...schwa.params };
      store.currentTractExtras.value = cloneTractExtras(schwa.extras);
      void store.requestVtlPose(schwa.params, spk, schwa.extras);
    }
  },
  { immediate: true },
);
watch([quickSelectedKey, catalogQuickIpa], ([key, options]) => {
  const hit = options.get(key);
  if (hit && hit.category !== 'diacritic' && quickTab.value !== 'favorites' && quickTab.value !== 'diacritic') {
    focusedQuickIpa.value = hit;
    quickTab.value = hit.category;
  }
}, { immediate: true });

// ===== G2P Review & Full-Grammar Compile into Timeline (T-43..T-48, T-33) =====
let kanaWords: KanaLexicon | undefined;
let kanaText = '';
function runG2pReview(): void {
  if (selectedDictionary.value) { reviewRows.value = []; return; }
  const activeZhStd = (mandarinStandards.some((s) => s === g2pStandard.value) ? g2pStandard.value : dictionaryPrefs.value.zhStandard) as MappingStandard;
  const personalMap = buildPersonalG2pMap(activeZhStd);
  try {
    const { plainText } = parseVoqsScopedText(g2pText.value);
    reviewRows.value = reviewText(plainText, activeZhStd, cmuLexicon.value, personalMap, kanaText === plainText ? kanaWords : undefined);
  } catch { reviewRows.value = []; }
}

watch(
  [dictionaryPrefs, userLexiconBooks],
  () => {
    if (!selectedDictionary.value && g2pStandard.value !== dictionaryPrefs.value.zhStandard) {
      g2pStandard.value = dictionaryPrefs.value.zhStandard;
    }
    runG2pReview();
  },
  { deep: true },
);

const compilingText = ref(false);
let compileSequence = 0;

async function applyModelIpaPoses(clip: Clip, stillCurrent: () => boolean): Promise<boolean> {
  if (textPoseSource.value === 'current') return stillCurrent();
  try {
    const segments = clip.syllable_order.flatMap((id) => {
      const syllable = clip.syllables[id];
      return syllable && resolveSyllablePoseSource(textPoseSource.value, syllable) === 'model'
        ? syllable.segments
        : [];
    });
    if (!segments.length) return stillCurrent();
    if (!['JD2', 'JD2-2D'].includes(speakerModel.value))
      throw new Error('模型默认构型适用于 JD2。其他解剖请选择当前 IPA 构型。');
    const phones = new Map<string, { ipa: string; closure: boolean }>();
    const keys = segments.map(segment => {
      const phone = { ipa: nasalPoseIpa(segment.ipa), closure: Boolean(segment.stop_timing) };
      const key = JSON.stringify(phone);
      phones.set(key, phone);
      return key;
    });
    if (!keys.length) return stillCurrent();
    const poses = await loadModelDefaultIpaPoses([...phones.values()]);
    if (!stillCurrent()) return false;
    const byKey = new Map([...phones.keys()].map((key, index) => [key, poses[index]]));
    segments.forEach((segment, index) => {
      segment.params = [...byKey.get(keys[index])!];
      segment.lip_width = DEFAULT_TRACT_EXTRAS.lip_width;
      segment.larynx_height_cm = DEFAULT_TRACT_EXTRAS.larynx_height;
      segment.manual_root = DEFAULT_TRACT_EXTRAS.manual_root;
      segment.tongue_shape = [...DEFAULT_TRACT_EXTRAS.tongue_shape];
      segment.lip_shape = [...DEFAULT_TRACT_EXTRAS.lip_shape];
    });
    return true;
  } catch (error) {
    if (!stillCurrent()) return false;
    const hint = error instanceof Error ? error.message : '无法读取模型默认构型';
    store.pushToast(`${hint}，已回退至当前 IPA 构型完成编译`, 'warning', 3800);
    return true;
  }
}

interface CompiledSentenceData {
  syllableOrder: string[];
  syllables: Record<string, Syllable>;
  totalSmp: number;
  f0Pins: Array<{ id: string; points: F0PinPoint[] }>;
  voqsAnchors: PhonationAnchor[];
  badge: string;
  appliedMixedProsodyRuns: number;
  skippedVoqsSymbols: string[];
}

function prefixCompiledSentence(data: CompiledSentenceData, prefix: string): CompiledSentenceData {
  const syllableOrder: string[] = [];
  const syllables: Record<string, Syllable> = {};
  for (const oldId of data.syllableOrder) {
    const syl = data.syllables[oldId];
    if (!syl) continue;
    const newId = `${prefix}${oldId}`;
    syllableOrder.push(newId);
    syllables[newId] = {
      ...syl,
      id: newId,
      segments: syl.segments.map((seg) => ({
        ...seg,
        id: `${prefix}${seg.id}`,
      })),
      targets: syl.targets.map((tgt) => ({
        ...tgt,
        id: `${prefix}${tgt.id}`,
        span_id: tgt.span_id === oldId ? newId : `${prefix}${tgt.span_id}`,
      })),
    };
  }
  return {
    ...data,
    syllableOrder,
    syllables,
    f0Pins: data.f0Pins.map((pin) => ({ ...pin, id: `${prefix}${pin.id}` })),
    voqsAnchors: data.voqsAnchors.map((anchor) => ({
      ...anchor,
      id: `${prefix}${anchor.id}`,
      syllable_id: anchor.syllable_id ? `${prefix}${anchor.syllable_id}` : undefined,
    })),
  };
}

function shiftCompiledSentence(data: CompiledSentenceData, shiftSmp: number): CompiledSentenceData {
  if (shiftSmp === 0) return data;
  const syllables: Record<string, Syllable> = {};
  for (const id of data.syllableOrder) {
    const syl = data.syllables[id];
    if (!syl) continue;
    syllables[id] = {
      ...syl,
      start_smp: syl.start_smp + shiftSmp,
      end_smp: syl.end_smp + shiftSmp,
      segments: syl.segments.map((seg) => ({
        ...seg,
        start_smp: seg.start_smp + shiftSmp,
        end_smp: seg.end_smp + shiftSmp,
      })),
      targets: syl.targets.map((tgt) => ({
        ...tgt,
        start_smp: tgt.start_smp + shiftSmp,
        end_smp: tgt.end_smp + shiftSmp,
      })),
    };
  }
  return {
    ...data,
    syllables,
    totalSmp: data.totalSmp + shiftSmp,
    f0Pins: data.f0Pins.map((pin) => ({
      ...pin,
      points: pin.points.map((pt) => ({ ...pt, t_smp: pt.t_smp + shiftSmp })),
    })),
    voqsAnchors: data.voqsAnchors.map((anchor) => ({
      ...anchor,
      t_smp: anchor.t_smp + shiftSmp,
    })),
  };
}

function sentenceHasUserOverrideConflict(
  sentenceText: string,
  activeZhStd: MappingStandard,
  personalMap: Lexicon,
  activeKana?: KanaLexicon,
): boolean {
  const rows = reviewText(sentenceText, activeZhStd, cmuLexicon.value, personalMap, activeKana);
  return rows.some((reading) => {
    if (reading.language === 'ipa') return true;
    const entry = lookupUserLexiconReading(reading, activeZhStd);
    if (entry?.toneLevels !== undefined) return true;
    return (entry?.ipaPhones.length ? entry.ipaPhones : splitIpaToPhonemes(reading.ipa)).some(usesTrialReferenceTrajectory);
  });
}

const SENTENCE_LANG_LABELS: Record<SentenceLanguage, string> = {
  zh: '汉语',
  en: '英语',
  ja: '日语',
  zh_en: '中英',
  rule: '音标/规则',
};

async function compileG2pToTrack(): Promise<void> {
  const text = g2pText.value.trim();
  const standard = g2pStandard.value;
  const projectId = store.project.value.id;
  const clipId = store.activeClipId.value;
  const voiceId = store.activeVoiceId.value;
  const sequence = ++compileSequence;
  const poseSource = textPoseSource.value;
  const rate = speechRate.value;
  const speaker = speakerModel.value;
  const stillCurrent = () => sequence === compileSequence && text === g2pText.value.trim()
    && standard === g2pStandard.value && projectId === store.project.value.id
    && clipId === store.activeClipId.value && voiceId === store.activeVoiceId.value
    && poseSource === textPoseSource.value && rate === speechRate.value && speaker === speakerModel.value;
  compilingText.value = true;
  try {
    if (poseSource !== 'model') await loadDefaultIpaPoses();
    if (!stillCurrent()) return;
    if (selectedDictionary.value) {
      await compileDialectToTrack(stillCurrent);
      return;
    }

    const sentences = splitTextIntoSentences(text);
    if (sentences.length === 0) {
      store.pushToast('请输入需要编译的中/英/日、[IPA] 或 {VoQS} 文本', 'warning');
      return;
    }

    const activeZhStd = (mandarinStandards.some((s) => s === standard) ? standard : dictionaryPrefs.value.zhStandard) as MappingStandard;
    const personalMap = buildPersonalG2pMap(activeZhStd);
    const plainAll = parseVoqsScopedText(text).plainText;
    if (/[ぁ-ゖァ-ヶーｦ-ﾟ]/u.test(plainAll)) {
      const lexicon = await japaneseReadingsFor(plainAll);
      if (!stillCurrent()) return;
      kanaText = plainAll;
      kanaWords = lexicon;
    }
    const activeKana = kanaText === plainAll ? kanaWords : undefined;
    runG2pReview();

    const rateScale = speechDurationScale[rate];
    const fRef = store.project.value.voices[voiceId]?.f0_ref_hz ?? 165;
    const compiledSentences: CompiledSentenceData[] = [];
    const compiledLangs: SentenceLanguage[] = [];
    const skippedVoqsAll = new Set<string>();
    const warningsList: string[] = [];
    let prosodyFallbackNotified = false;

    for (let sIdx = 0; sIdx < sentences.length; sIdx++) {
      const sentence = sentences[sIdx];
      let compiled: CompiledSentenceData | null = null;
      let resolvedLang: SentenceLanguage = sentence.language;

      const isMandarinOrEn = sentence.language === 'zh' || sentence.language === 'en' || sentence.language === 'zh_en';
      const allowNeuralProsody =
        isMandarinOrEn &&
        textProsodyEnabled.value &&
        !sentenceHasUserOverrideConflict(sentence.text, activeZhStd, personalMap, activeKana);

      if (allowNeuralProsody) {
        const reqLang: 'auto' | 'zh' | 'en' =
          sentence.language === 'zh' ? 'zh' : sentence.language === 'en' ? 'en' : 'auto';
        try {
          const prosody = await predictSpeechProsody(sentence.text, speaker, rateScale, reqLang);
          if (!stillCurrent()) return;
          applyDictionaryTranscription(prosody.syllableOrder.map((id) => prosody.syllables[id]), sentence.text);
          const firstSmp = prosody.syllables[prosody.syllableOrder[0]]?.start_smp ?? 0;
          const lastSmp = prosody.syllables[prosody.syllableOrder[prosody.syllableOrder.length - 1]]?.end_smp ?? prosody.totalSmp;
          const clampedPitch = sentences.length > 1
            ? clampF0PinPointsToSpan(prosody.pitch, firstSmp, lastSmp)
            : prosody.pitch;
          compiled = {
            syllableOrder: prosody.syllableOrder,
            syllables: prosody.syllables,
            totalSmp: prosody.totalSmp,
            f0Pins: clampedPitch.length >= 2 ? [{ id: `prosody-${clipId}`, points: clampedPitch }] : [],
            voqsAnchors: [],
            badge: `Text2Prosody-Lite · ${prosody.syllableOrder.length} 个音节`,
            appliedMixedProsodyRuns: 0,
            skippedVoqsSymbols: [],
          };
        } catch (error) {
          if (!stillCurrent()) return;
          const hint = error instanceof Error ? error.message : '模型未返回可用结果';
          const isSegmentationFallback = hint.includes('分段不同');
          if (!isSegmentationFallback && !prosodyFallbackNotified) {
            store.pushToast(`韵律模型：${hint}，已切回全语法编译`, 'warning', 3800);
            prosodyFallbackNotified = true;
          }
        }
      }

      if (!compiled && sentence.language === 'ja') {
        try {
          const jaProsody = await buildJapaneseAccentClipData(
            sentence.text,
            speaker,
            rateScale,
            fRef,
            selectedIpaPoseSetId.value,
          );
          if (!stillCurrent()) return;
          const firstSmp = jaProsody.syllables[jaProsody.syllableOrder[0]]?.start_smp ?? 0;
          const lastSmp = jaProsody.syllables[jaProsody.syllableOrder[jaProsody.syllableOrder.length - 1]]?.end_smp ?? jaProsody.totalSmp;
          const clampedPitch = sentences.length > 1
            ? clampF0PinPointsToSpan(jaProsody.pitch, firstSmp, lastSmp)
            : jaProsody.pitch;
          compiled = {
            syllableOrder: jaProsody.syllableOrder,
            syllables: jaProsody.syllables,
            totalSmp: jaProsody.totalSmp,
            f0Pins: clampedPitch.length >= 2 ? [{ id: `prosody-${clipId}`, points: clampedPitch }] : [],
            voqsAnchors: [],
            badge: `日语精简声调词典 · ${jaProsody.syllableOrder.length} 拍`,
            appliedMixedProsodyRuns: 0,
            skippedVoqsSymbols: [],
          };
          if (jaProsody.warnings.length > 0) warningsList.push(jaProsody.warnings[0]);
        } catch (error) {
          if (!stillCurrent()) return;
          const hint = error instanceof Error ? error.message : '日语声调词典不可用';
          store.pushToast(`日语声调词典：${hint}，已切回纯假名规则编译`, 'warning', 3800);
        }
      }

      if (!compiled) {
        if (!isMandarinOrEn && sentence.language !== 'ja') resolvedLang = 'rule';
        compiled = await compileRuleSentence(sentence.text, {
          activeZhStd,
          personalMap,
          activeKana,
          speaker,
          rateScale,
          fRef,
          poseSetId: selectedIpaPoseSetId.value,
          clipId,
          useTextProsody: textProsodyEnabled.value,
          stillCurrent,
        });
        if (!stillCurrent()) return;
        if (!compiled) continue;
      }

      compiled.skippedVoqsSymbols.forEach((sym) => skippedVoqsAll.add(sym));
      if (sentences.length > 1) {
        compiled = prefixCompiledSentence(compiled, `s${sIdx + 1}_`);
      }
      compiledSentences.push(compiled);
      compiledLangs.push(resolvedLang);
    }

    if (skippedVoqsAll.size > 0) {
      store.pushToast(
        `标签 ${[...skippedVoqsAll].join('、')} 尚未收录实录参数，已跳过该音质修饰`,
        'warning',
        4200,
      );
    }

    const mergedOrder: string[] = [];
    const mergedSyllables: Record<string, Syllable> = {};
    const mergedF0Pins: Array<{ id: string; points: F0PinPoint[] }> = [];
    const mergedVoqsAnchors: PhonationAnchor[] = [];
    let prevLastSylEndGlobal = 0;
    let totalEndSmp = 0;
    let totalMixedRuns = 0;

    compiledSentences.forEach((part, idx) => {
      const firstSylStart = part.syllableOrder.length
        ? (part.syllables[part.syllableOrder[0]]?.start_smp ?? 0)
        : 0;
      const desiredGapSmp = idx > 0 ? msToSamples(Math.round(sentences[idx - 1].trailingPauseMs * rateScale)) : 0;
      const shiftSmp = idx === 0
        ? 0
        : Math.max(prevLastSylEndGlobal, prevLastSylEndGlobal + desiredGapSmp - firstSylStart);
      const shifted = shiftCompiledSentence(part, shiftSmp);

      for (const sid of shifted.syllableOrder) {
        mergedOrder.push(sid);
        mergedSyllables[sid] = shifted.syllables[sid];
      }
      const lastSid = shifted.syllableOrder[shifted.syllableOrder.length - 1];
      prevLastSylEndGlobal = lastSid ? shifted.syllables[lastSid].end_smp : shifted.totalSmp;
      totalEndSmp = Math.max(totalEndSmp, shifted.totalSmp, prevLastSylEndGlobal);
      mergedF0Pins.push(...shifted.f0Pins);
      mergedVoqsAnchors.push(...shifted.voqsAnchors);
      totalMixedRuns += shifted.appliedMixedProsodyRuns;
    });

    if (mergedOrder.length === 0) {
      store.pushToast('请输入需要编译的中/英/日、[IPA] 或 {VoQS} 文本', 'warning');
      return;
    }

    const uniqueLangs = [...new Set(compiledLangs)];
    const clipLang: 'cmn' | 'en' | 'ja' | 'mixed' =
      uniqueLangs.length === 1
        ? uniqueLangs[0] === 'zh'
          ? 'cmn'
          : uniqueLangs[0] === 'en' || uniqueLangs[0] === 'ja'
            ? uniqueLangs[0]
            : 'mixed'
        : 'mixed';

    const existing = activeClip.value;
    const clip: Clip = {
      id: clipId,
      kind: 'phrase',
      voice_id: voiceId,
      start_smp: 0,
      end_smp: totalEndSmp,
      variants: ['synth'],
      active_variant: 'synth',
      source: {
        lyrics: text,
        score: existing?.source?.lyrics === text ? existing.source.score : undefined,
        lang: clipLang,
        transcription: standard,
      },
      syllable_order: mergedOrder,
      syllables: mergedSyllables,
    };

    if (!await applyModelIpaPoses(clip, stillCurrent)) return;

    const commands: WorkbenchCommand[] = [
      { type: 'clip.edit', payload: { clip, resetAnnotation: true } },
      ...mergedF0Pins.map((pin) => ({
        type: 'f0.draw' as const,
        payload: { id: pin.id, points: pin.points },
      })),
      ...(mergedVoqsAnchors.length > 0
        ? [{ type: 'phonation.set_anchors' as const, payload: { anchors: mergedVoqsAnchors } }]
        : []),
    ];

    const res = store.applyProposal(
      commands,
      sentences.length > 1
        ? `分句编译入轨 (${sentences.length} 句 · ${mergedOrder.length} 音节)`
        : `编译入轨 (${mergedOrder.length} 音节 · ${standard})`,
    );
    if (res.ok) {
      let summaryToast: string;
      if (sentences.length === 1) {
        if (compiledSentences[0].badge) {
          summaryToast = compiledSentences[0].badge;
        } else {
          const prosodyBadge = totalMixedRuns > 0 ? ' · Text2Prosody-Lite 混排韵律' : '';
          const voqsBadge = mergedVoqsAnchors.length > 0 ? ` · ${mergedVoqsAnchors.length} 个 VoQS 锚点` : '';
          summaryToast = `已将 ${mergedOrder.length} 个音节编译入多轨时间轴${prosodyBadge}${voqsBadge}`;
        }
      } else {
        const langSummary = uniqueLangs.map((l) => SENTENCE_LANG_LABELS[l]).join('/');
        const voqsBadge = mergedVoqsAnchors.length > 0 ? ` · ${mergedVoqsAnchors.length} 个 VoQS 锚点` : '';
        summaryToast = `已按句号拆分为 ${sentences.length} 句（${langSummary}），共 ${mergedOrder.length} 个音节编入时间轴${voqsBadge}`;
      }
      completeTextCompile(clip, summaryToast);
      if (warningsList.length > 0) {
        store.pushToast(warningsList[0], 'warning', 3600);
      }
    }
  } catch (error) {
    if (stillCurrent()) store.pushToast(error instanceof Error ? error.message : '文本编译失败', 'warning');
  } finally {
    if (sequence === compileSequence) compilingText.value = false;
  }
}

onBeforeUnmount(() => { compileSequence++; });

function normalizeSyllableToken(text: string): string {
  const cleaned = text.normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
  return cleaned || text.normalize('NFC').trim().toLowerCase();
}

function clampF0PinPointsToSpan(points: readonly F0PinPoint[], minSmp: number, maxSmp: number): F0PinPoint[] {
  if (!points.length || maxSmp <= minSmp) return [];
  const sorted = [...points].sort((a, b) => a.t_smp - b.t_smp);
  const clamped: F0PinPoint[] = [];
  for (const pt of sorted) {
    if (pt.t_smp < minSmp || pt.t_smp > maxSmp) continue;
    const prev = clamped[clamped.length - 1];
    if (prev && prev.t_smp === pt.t_smp) prev.f0_hz = pt.f0_hz;
    else clamped.push({ t_smp: pt.t_smp, f0_hz: pt.f0_hz });
  }
  if (!clamped.length) {
    const firstHz = sorted[0].f0_hz;
    return [
      { t_smp: minSmp, f0_hz: firstHz },
      { t_smp: maxSmp, f0_hz: sorted[sorted.length - 1].f0_hz },
    ];
  }
  const out: F0PinPoint[] = [
    ...(clamped[0].t_smp > minSmp ? [{ t_smp: minSmp, f0_hz: clamped[0].f0_hz }] : []),
    ...clamped,
    ...(clamped[clamped.length - 1].t_smp < maxSmp ? [{ t_smp: maxSmp, f0_hz: clamped[clamped.length - 1].f0_hz }] : []),
  ];
  return out.length >= 2 ? out : [];
}

function applyDictionaryTranscription(syllables: Syllable[], sourceText?: string) {
  const activeZhStd = (mandarinStandards.some((s) => s === g2pStandard.value) ? g2pStandard.value : dictionaryPrefs.value.zhStandard) as MappingStandard;
  const personalMap = buildPersonalG2pMap(activeZhStd);
  const plainAll = parseVoqsScopedText(g2pText.value.trim()).plainText;
  const activeKana = kanaText === plainAll ? kanaWords : undefined;
  const rowsMatchSyllables = (candidateRows: readonly ReadingRow[]) =>
    candidateRows.length === syllables.length &&
    !syllables.some((s, i) => normalizeSyllableToken(s.text) !== normalizeSyllableToken(candidateRows[i].word));

  const splitRows = (
    sourceText !== undefined
      ? reviewText(sourceText, activeZhStd, cmuLexicon.value, personalMap, activeKana)
      : (runG2pReview(), reviewRows.value)
  ).filter((row) => !!row.word.trim());

  let readings = splitRows;
  if (!rowsMatchSyllables(readings)) {
    const fallbackText = sourceText ?? g2pText.value.trim();
    const unsplitRows = reviewText(
      fallbackText,
      activeZhStd,
      cmuLexicon.value,
      personalMap,
      activeKana,
      { splitEnglishSyllables: false },
    ).filter((row) => !!row.word.trim());
    if (rowsMatchSyllables(unsplitRows)) {
      readings = unsplitRows;
    } else {
      throw new Error('模型与所选转写方案的分段不同');
    }
  }
  for (const [index, syllable] of syllables.entries()) {
    const reading = readings[index];
    if (!reading.ipa) throw new Error(`所选转写方案未解析「${reading.word}」`);
    const userEntry = lookupUserLexiconReading(reading, g2pStandard.value);
    const phones = userEntry?.ipaPhones?.length ? [...userEntry.ipaPhones] : splitIpaToPhonemes(reading.ipa);
    const segments = buildSegmentsForSyllable(
      syllable.id,
      phones,
      syllable.start_smp,
      syllable.end_smp,
      speakerModel.value,
      userEntry?.poseSetId ?? selectedIpaPoseSetId.value,
      {
        segmentRatios: userEntry?.segmentRatios,
        segmentPoses: userEntry?.segmentPoses,
      },
    );
    if (!userEntry?.segmentRatios && segments.length === syllable.segments.length) {
      for (const [i, segment] of segments.entries()) {
        const prior = syllable.segments[i];
        segment.start_smp = prior.start_smp;
        segment.end_smp = prior.end_smp;
        if (segment.stop_timing && prior.stop_timing) {
          const priorAspirated = prior.stop_timing.aspiration_ms > 0;
          const curTraits = phoneTraits(segment.ipa);
          const segDurMs = samplesToMs(segment.end_smp - segment.start_smp);
          if (
            priorAspirated === curTraits.aspirated &&
            prior.stop_timing.closure_ms + prior.stop_timing.release_ms <= Math.max(11, Math.round(segDurMs))
          ) {
            segment.stop_timing = prior.stop_timing;
          } else {
            segment.stop_timing = speechStopTiming(segment.ipa, segDurMs);
          }
        }
      }
    } else if (!userEntry?.segmentRatios && syllable.segments.length >= 2 && segments.length >= 2 && segments[0].role === 'onset' && syllable.segments[0].role === 'onset') {
      // Preserve predicted consonant/rime split while redistributing mismatched rime/coda segments proportionally.
      const minOnset = segments[0].stop_timing ? msToSamples(segments[0].stop_timing.closure_ms + segments[0].stop_timing.release_ms) : msToSamples(20);
      const minTail = msToSamples(20) * (segments.length - 1);
      const splitSmp = Math.max(syllable.start_smp + minOnset, Math.min(syllable.end_smp - minTail, syllable.segments[0].end_smp));
      if (splitSmp > syllable.start_smp && splitSmp < syllable.end_smp) {
        segments[0].start_smp = syllable.start_smp;
        segments[0].end_smp = splitSmp;
        if (segments[0].stop_timing && syllable.segments[0].stop_timing && splitSmp - syllable.start_smp >= minOnset) {
          const priorAspirated = syllable.segments[0].stop_timing.aspiration_ms > 0;
          const curTraits = phoneTraits(segments[0].ipa);
          const segDurMs = samplesToMs(splitSmp - syllable.start_smp);
          segments[0].stop_timing = priorAspirated === curTraits.aspirated
            ? syllable.segments[0].stop_timing
            : speechStopTiming(segments[0].ipa, segDurMs);
        }
        const rem = buildSegmentsForSyllable(syllable.id, phones.slice(1), splitSmp, syllable.end_smp, speakerModel.value);
        for (let i = 1; i < segments.length; i++) {
          segments[i].start_smp = rem[i - 1].start_smp;
          segments[i].end_smp = rem[i - 1].end_smp;
        }
      }
    }
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg.stop_timing) continue;
      const minSmp = msToSamples(seg.stop_timing.closure_ms + seg.stop_timing.release_ms);
      const deficit = minSmp - (seg.end_smp - seg.start_smp);
      if (deficit <= 0) continue;
      if (i + 1 < segments.length && segments[i + 1].end_smp - segments[i + 1].start_smp - msToSamples(20) >= deficit) {
        seg.end_smp += deficit;
        segments[i + 1].start_smp += deficit;
      } else if (i > 0 && segments[i - 1].end_smp - segments[i - 1].start_smp - msToSamples(20) >= deficit) {
        segments[i - 1].end_smp -= deficit;
        seg.start_smp -= deficit;
      }
    }
    if (segments.some(seg => seg.stop_timing && seg.end_smp - seg.start_smp < msToSamples(seg.stop_timing.closure_ms + seg.stop_timing.release_ms))) {
      throw new Error(`预测时长使「${reading.word}」低于塞音闭塞和释放下限`);
    }
    syllable.ipa = phones;
    syllable.segments = segments;
    syllable.nucleus_index = Math.max(0, segments.findIndex(segment => segment.role === 'nucleus'));
    syllable.reading_candidates = reading.choices.length > 1 ? reading.choices.map(choice => `[${choice}]`) : undefined;
  }
}

async function compileDialectToTrack(stillCurrent: () => boolean) {
  const dictionary = selectedDictionary.value;
  if (!dictionary) return;
  try {
    const plan = planDialect(dictionary, dialectTokens.value, dialectChoices.value);
    if (!plan.length) throw new Error('请输入需要编译的方言文本');
    let cursor = 0;
    const fRef = store.project.value.voices[store.activeVoiceId.value]?.f0_ref_hz ?? 165;
    const voice = store.activeVoiceId.value;
    const clip: Clip = {
      id: store.activeClipId.value, kind: 'phrase', voice_id: voice, start_smp: 0, end_smp: 0,
      variants: ['synth'], active_variant: 'synth', source: { lyrics: g2pText.value, transcription: dictionary.id, lang: 'mixed' },
      syllable_order: [], syllables: {},
    };
    const commands: WorkbenchCommand[] = [{ type: 'clip.edit', payload: { clip, resetAnnotation: true } }];
    const rateScale = speechDurationScale[speechRate.value];
    const userEntries = plan.map(row => lookupUserLexiconEntry(row.word, 'zh', { standard: dictionary.id }));
    const phoneRows = plan.map((row, index) => {
      const phones = userEntries[index]?.ipaPhones ?? splitIpaToPhonemes(row.ipa);
      return phones.length ? phones : ['ə'];
    });
    for (const [index, row] of plan.entries()) {
      const id = `dialect-syl-${index + 1}`;
      const userEntry = userEntries[index];
      const ipa = phoneRows[index];
      const phoneDurations = speechPhoneDurations(
        ipa, plan[index - 1]?.pause === 0 ? phoneRows[index - 1].at(-1) : undefined,
        row.pause === 0 ? phoneRows[index + 1]?.[0] : undefined,
      );
      const durMs = userEntry?.preferredDurationMs
        ? Math.max(55, Math.round(userEntry.preferredDurationMs * rateScale))
        : estimateSyllableNaturalDurationMs(ipa, row.durScale, rateScale, phoneDurations);
      const durSmp = msToSamples(durMs);
      const end = cursor + durSmp;
      const segments = buildSegmentsForSyllable(id, ipa, cursor, end, speakerModel.value,
        userEntry?.poseSetId ?? dictionary.poseSetId ?? RECORDED_IPA_SET_ID, {
          speechPhoneMs: phoneDurations, segmentRatios: userEntry?.segmentRatios, segmentPoses: userEntry?.segmentPoses,
        });
      if (row.checked && segments.at(-1)?.role === 'coda' && segments.at(-1)?.stop_timing) {
        const timing = segments.at(-1)!.stop_timing!;
        timing.release_ms = 1;
        timing.aspiration_ms = 0;
        if (timing.vot_ms > 1) timing.vot_ms = 1;
      }
      const toneLevels = userEntry?.toneLevels ?? row.levels;
      const levels = [...toneLevels].map(Number);
      const hzFor = (level: number) => level ? 115 + (level - 1) / 4 * 185 : fRef;
      const tonePoints = toneLevels === row.levels && row.f0?.length ? row.f0 : levels.map((level, i) => ({ u: levels.length > 1 ? i / (levels.length - 1) : .5, hz: hzFor(level) }));
      if (tonePoints.some(p => !isValidF0Hz(p.hz) || p.u < 0 || p.u > 1)) {
        throw new Error(`「${row.word}」的调类曲线包含无效基频`);
      }
      if (tonePoints.length >= 2) {
        const points = tonePoints.map(pt => ({ f0_hz: pt.hz, t_smp: cursor + Math.round(pt.u * (durSmp - 1)) }));
        commands.push({ type: 'f0.draw', payload: { id: `${id}-f0`, points } });
      }
      clip.syllable_order.push(id);
      clip.syllables[id] = { id, text: row.word, ipa, start_smp: cursor, end_smp: end,
        nucleus_index: Math.max(0, segments.findIndex(segment => segment.role === 'nucleus')), tone_levels: toneLevels || undefined,
        anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 }, segments,
        targets: buildSyllableQtaTargets(id, cursor, end, { effectiveTone: toneLevels || undefined, fRefHz: fRef, voiced: segments.some(s => isSegmentVoicedAt(s, s.end_smp - 1)) }),
        overrides: {
          poses: [],
          pressure: [
            { u: 0, pressure_pa: 640 },
            { u: 0.35, pressure_pa: 840 },
            { u: 0.85, pressure_pa: 760 },
            { u: 1, pressure_pa: 500 },
          ],
          f0_resid: [],
          glottis: [],
        },
      };
      cursor = end + msToSamples(row.pause * rateScale);
    }
    clip.end_smp = cursor;
    if (!await applyModelIpaPoses(clip, stillCurrent)) return;
    if (store.applyProposal(commands, `编译方言 ${dictionary.name}`).ok) completeTextCompile(clip, `${dictionary.name} · ${plan.length} 个音节`);
  } catch (error) { store.pushToast(error instanceof Error ? error.message : String(error), 'warning'); }
}

function completeTextCompile(clip: Clip, message: string): void {
  const first = clip.syllable_order[0];
  if (!first) return;
  store.clearAnnotationAudio();
  annotationSource.value = null;
  store.playheadSmp.value = 0;
  store.selectedSyllableId.value = first;
  const segment = clip.syllables[first]?.segments[0];
  store.selectedPhonemeIds.value = segment ? [segment.id] : [];
  if (segment?.params && segment.params.length === 19) {
    store.currentTractParams.value = tractArray19ToRecord(segment.params);
  } else {
    const fallback = getFullPoseForIpa(segment?.ipa ?? 'ə', undefined, speakerModel.value);
    store.currentTractParams.value = { ...fallback.params };
    store.currentTractExtras.value = cloneTractExtras(fallback.extras);
  }
  store.pushToast(message, 'success', 2600);
}

interface CompileRuleSentenceOptions {
  activeZhStd: MappingStandard;
  personalMap: Lexicon;
  activeKana?: KanaLexicon;
  speaker: string;
  rateScale: number;
  fRef: number;
  poseSetId: string;
  clipId: string;
  useTextProsody: boolean;
  stillCurrent: () => boolean;
}

async function compileRuleSentence(
  sentenceText: string,
  opts: CompileRuleSentenceOptions,
): Promise<CompiledSentenceData | null> {
  const voqsParsed = parseVoqsScopedText(sentenceText);
  const scopedRows: Array<{ row: ReadingRow; voqsState: ActiveVoqsState | null }> = [];
  for (const chunk of voqsParsed.chunks) {
    if (!chunk.text.trim()) {
      continue;
    }
    const hasKanaAndHan =
      !/^\s*[\[［]/u.test(chunk.text) &&
      /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(chunk.text) &&
      /\p{Script=Han}/u.test(chunk.text);
    const chunkJaKanji = hasKanaAndHan ? await japaneseKanjiReadingsFor(chunk.text).catch(() => undefined) : undefined;
    const chunkRows = reviewText(
      chunk.text,
      opts.activeZhStd,
      cmuLexicon.value,
      opts.personalMap,
      opts.activeKana,
      chunkJaKanji?.size ? { primaryLang: 'ja', jaKanji: chunkJaKanji } : undefined,
    );
    const valid = chunkRows.filter((r) => r.word.trim().length > 0);
    if (valid.length === 0) {
      if (/[,，、：:;；.·!?。！？…|‖]/u.test(chunk.text) && scopedRows.length > 0) {
        const prev = scopedRows[scopedRows.length - 1].row;
        if (!prev.linkedToNext) {
          const pMs = /[.·!?。！？…‖]/u.test(chunk.text) ? IPA_LONG_PAUSE_MS : 180;
          prev.pause = Math.max(prev.pause, pMs);
          prev.phraseEnd = true;
        }
      }
      continue;
    }
    const prevRow = scopedRows.at(-1)?.row;
    if (prevRow && !prevRow.linkedToNext && valid[0].leadingPause) {
      prevRow.pause = Math.max(prevRow.pause, valid[0].leadingPause);
      prevRow.phraseEnd = true;
    }
    for (const r of valid) {
      scopedRows.push({ row: r, voqsState: chunk.state });
    }
  }

  if (scopedRows.length === 0) {
    return null;
  }

  let curSmp = 0;
  let cumulativeStepOffsetSt = 0;
  const syllableOrder: string[] = [];
  const syllables: Record<string, Syllable> = {};
  const voqsSyllableItems: Array<{
    syllableId: string;
    startSmp: number;
    endSmp: number;
    state: ActiveVoqsState | null;
  }> = [];

  const speechRows = scopedRows.map(({ row, voqsState }, idx) => {
    const userEntry = lookupUserLexiconReading(row, opts.activeZhStd);
    const rawIpa = userEntry?.ipaJoined || row.ipa || 'ə';
    const isUnstressedEn = row.language === 'en' && !/[ˈˌ]/u.test(rawIpa);
    const supraseg = parseIpaSuprasegmentals(rawIpa, { isUnstressedEnglish: isUnstressedEn });
    const phonemes = userEntry?.ipaPhones?.length ? [...userEntry.ipaPhones] : splitIpaToPhonemes(rawIpa);
    const gapMs = row.linkedToNext || supraseg.linkedAfter ? 0 : Math.min(350, row.pause);
    return { idx, row, voqsState, userEntry, supraseg, phonemes: phonemes.length ? phonemes : ['ə'], gapMs };
  });

  const phoneDurationsList = speechRows.map(({ phonemes, gapMs }, idx) => {
    const left = speechRows[idx - 1];
    return speechPhoneDurations(
      phonemes,
      left?.gapMs === 0 ? left.phonemes.at(-1) : undefined,
      gapMs === 0 ? speechRows[idx + 1]?.phonemes[0] : undefined,
    );
  });
  const speechLangOf = (lang: ReadingRow['language']): 'zh' | 'en' | 'ja' | 'ipa' | undefined =>
    lang === 'zh' || lang === 'en' || lang === 'ja' || lang === 'ipa' ? lang : (lang ? 'ipa' : undefined);
  const naturalDurationWeightsMs = speechRows.map(({ row, supraseg, phonemes }, idx) => {
    const effectiveScale = connectedRuleDurationScale(phonemes, supraseg.durationScale, speechLangOf(row.language));
    return estimateSyllableNaturalDurationMs(
      phonemes,
      effectiveScale,
      opts.rateScale,
      phoneDurationsList[idx],
    );
  });

  type MixedProsodyPrediction = Awaited<ReturnType<typeof predictSpeechProsody>>;
  const mixedProsodyByRun: Array<{
    run: { startIndex: number; endIndex: number; text: string };
    prediction: MixedProsodyPrediction;
  }> = [];
  const predictedDurMsByRow = new Map<number, number>();
  if (opts.useTextProsody) {
    const runs = extractMixedProsodyRuns(
      speechRows.map(({ row, voqsState, userEntry, supraseg, phonemes }) => ({
        word: row.word,
        language: speechLangOf(row.language),
        ipaPhones: row.language === 'ipa' ? phonemes : undefined,
        sourceWord: row.sourceWord,
        syllableIndex: row.syllableIndex,
        syllableCount: row.syllableCount,
        pause: row.pause,
        phraseEnd: row.phraseEnd,
        linkedToNext: row.linkedToNext,
        eligible:
          (row.language === 'zh' || row.language === 'en' || row.language === 'ipa') &&
          supraseg.effectiveTone === undefined &&
          userEntry?.toneLevels === undefined &&
          !/[⁰¹²³⁴⁵˥˦˧˨˩꜒꜓꜔꜕꜖‿ꜛꜜ]/u.test(row.word) &&
          !phonemes.some(usesTrialReferenceTrajectory) &&
          phonemes.length > 0,
        groupKey: voqsState ? `${voqsState.phonation?.symbol ?? ''}:${voqsState.larynxHeightCm ?? ''}` : 'plain',
      })),
    );
    if (runs.length > 0) {
      const settled = await Promise.allSettled(
        runs.map((run) => {
          if (run.text.includes('[')) {
            return predictSpeechProsody(run.text, opts.speaker, opts.rateScale, 'auto');
          }
          const runHasHan = /\p{Script=Han}/u.test(run.text);
          const runHasLatin = /\p{Script=Latin}/u.test(run.text);
          const runLang: 'auto' | 'zh' | 'en' =
            runHasHan && !runHasLatin ? 'zh' : runHasLatin && !runHasHan ? 'en' : 'auto';
          return predictSpeechProsody(run.text, opts.speaker, opts.rateScale, runLang);
        }),
      );
      if (!opts.stillCurrent()) return null;
      settled.forEach((result, runIdx) => {
        if (result.status !== 'fulfilled') return;
        const run = runs[runIdx];
        const prediction = result.value;
        const runSlice = speechRows.slice(run.startIndex, run.endIndex).map((s) => s.row);
        const mappedDurs = mapProsodyRunDurationsMs(
          runSlice,
          prediction,
          naturalDurationWeightsMs.slice(run.startIndex, run.endIndex),
        );
        if (mappedDurs) {
          mappedDurs.forEach((ms, offset) => {
            predictedDurMsByRow.set(run.startIndex + offset, ms);
          });
        }
        mixedProsodyByRun.push({ run, prediction });
      });
    }
  }

  speechRows.forEach(({ row, voqsState, userEntry, supraseg, phonemes, gapMs }, idx) => {
    const sid = `syl_${String(idx + 1).padStart(2, '0')}`;
    cumulativeStepOffsetSt += supraseg.stepOffsetSt;
    const phoneDurations = phoneDurationsList[idx];
    const predictedMs = predictedDurMsByRow.get(idx);
    const floorMs = phonemes.reduce((sum, sym) => sum + (phoneTraits(sym).stop ? 12 : 15), 0);
    const durMs = userEntry?.preferredDurationMs
      ? Math.max(55, Math.round(userEntry.preferredDurationMs * opts.rateScale))
      : predictedMs !== undefined
        ? Math.max(floorMs, predictedMs)
        : naturalDurationWeightsMs[idx];
    const durSmp = msToSamples(durMs);
    const startSmp = curSmp;
    const endSmp = curSmp + durSmp;

    const segments = buildSegmentsForSyllable(
      sid,
      phonemes,
      startSmp,
      endSmp,
      opts.speaker,
      userEntry?.poseSetId ?? opts.poseSetId,
      {
        speechPhoneMs: phoneDurations,
        segmentRatios: userEntry?.segmentRatios,
        segmentPoses: userEntry?.segmentPoses,
        larynxHeightOverrideCm: voqsState?.larynxHeightCm,
      },
    );

    if (supraseg.checked && segments.at(-1)?.stop_timing) {
      const st = segments.at(-1)!.stop_timing!;
      st.release_ms = 1;
      st.aspiration_ms = 0;
      if (st.vot_ms > 1) st.vot_ms = 1;
    }

    const nucIdx = Math.max(0, segments.findIndex((s) => s.role === 'nucleus'));
    const effectiveTone = supraseg.effectiveTone ?? userEntry?.toneLevels;
    const hasVoicedSeg = segments.some((s) => isSegmentVoicedAt(s, s.end_smp - 1));
    const targets = buildSyllableQtaTargets(sid, startSmp, endSmp, {
      effectiveTone,
      stress: supraseg.stress,
      stepOffsetSt: cumulativeStepOffsetSt,
      fRefHz: opts.fRef,
      voiced: hasVoicedSeg,
    });

    const clampPa = (v: number) => Math.max(PRESSURE_LIMIT_PA.min, Math.min(PRESSURE_LIMIT_PA.max, Math.round(v)));
    const pDelta = supraseg.pressureDeltaPa;
    const pressureEnv =
      pDelta !== 0
        ? [
            { u: 0, pressure_pa: clampPa(640 + pDelta * 0.5) },
            { u: 0.35, pressure_pa: clampPa(840 + pDelta) },
            { u: 0.85, pressure_pa: clampPa(760 + pDelta * 0.8) },
            { u: 1, pressure_pa: clampPa(500 + pDelta * 0.4) },
          ]
        : [
            { u: 0, pressure_pa: 640 },
            { u: 0.35, pressure_pa: 840 },
            { u: 0.85, pressure_pa: 760 },
            { u: 1, pressure_pa: 500 },
          ];

    syllableOrder.push(sid);
    syllables[sid] = {
      id: sid,
      text: row.word,
      ipa: phonemes,
      nucleus_index: nucIdx,
      start_smp: startSmp,
      end_smp: endSmp,
      tone_levels: effectiveTone,
      reading_candidates: row.choices.length > 1 ? row.choices.map((c) => `[${c}]`) : undefined,
      anchor: { policy: 'nucleus_on_beat', lead_ms: nucIdx > 0 ? 70 : 0, bias_ms: 0 },
      segments,
      targets,
      overrides: {
        poses: [],
        f0_resid: [],
        pressure: pressureEnv,
        glottis: [{ u0: 0, u1: 1, preset: 'modal', blend: 1 }],
      },
    };

    voqsSyllableItems.push({
      syllableId: sid,
      startSmp,
      endSmp,
      state: voqsState,
    });

    curSmp = endSmp + msToSamples(gapMs * opts.rateScale);
    if (row.phraseEnd) cumulativeStepOffsetSt = 0;
  });

  const voqsAnchors = buildPhonationAnchorsFromVoqsSyllables(voqsSyllableItems);
  const f0Pins: Array<{ id: string; points: F0PinPoint[] }> = [];
  let appliedMixedProsodyRuns = 0;
  mixedProsodyByRun.forEach(({ run, prediction }, runIdx) => {
    const targetSyls = syllableOrder
      .slice(run.startIndex, run.endIndex)
      .map((id) => syllables[id])
      .filter((s): s is Syllable => Boolean(s));
    const points = mapProsodyRunPitchToTimeline(prediction, targetSyls);
    if (points.length >= 2) {
      f0Pins.push({ id: `prosody-${opts.clipId}-run-${runIdx + 1}`, points });
      appliedMixedProsodyRuns++;
    }
  });

  return {
    syllableOrder,
    syllables,
    totalSmp: curSmp,
    f0Pins,
    voqsAnchors,
    badge: '',
    appliedMixedProsodyRuns,
    skippedVoqsSymbols: voqsParsed.skippedSymbols,
  };
}

// ===== Corpus Multi-Level Tree & Drag-to-Timeline Loading (T-01, T-02, T-03) =====
const corpusSearch = ref('');
const expandedFolders = ref<Set<string>>(new Set());
const selectedCorpusId = ref('');
const savedCorpusDirectory = shallowRef<CorpusDirectoryHandle>();
const corpusDirectoryNeedsPermission = ref(false);
const corpusDirectoryLoading = ref(false);
let corpusDirectoryTask: AbortController | undefined;

interface CorpusTreeRow {
  key: string;
  kind: 'folder' | 'file';
  name: string;
  path: string;
  depth: number;
  expanded?: boolean;
  childCount?: number;
  item?: LocalWorkspaceFile;
}

function toggleCorpusFolder(folderPath: string): void {
  const next = new Set(expandedFolders.value);
  if (next.has(folderPath)) next.delete(folderPath);
  else next.add(folderPath);
  expandedFolders.value = next;
}

const visibleCorpusRows = computed<CorpusTreeRow[]>(() => {
  const q = corpusSearch.value.trim().toLowerCase();
  const matchedFiles = q
    ? localFiles.value.filter(
        (f) => f.relativePath.toLowerCase().includes(q) || f.name.toLowerCase().includes(q),
      )
    : localFiles.value;

  interface FolderNode {
    name: string;
    path: string;
    folders: Map<string, FolderNode>;
    files: LocalWorkspaceFile[];
    totalFiles: number;
  }
  const root: FolderNode = { name: '', path: '', folders: new Map(), files: [], totalFiles: 0 };

  for (const item of matchedFiles) {
    if (item.file) corpusDragFileRegistry.set(item.id, item.file);
    const parts = item.relativePath.split('/').filter(Boolean);
    let cur = root;
    cur.totalFiles++;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const subPath = parts.slice(0, i + 1).join('/');
      let child = cur.folders.get(seg);
      if (!child) {
        child = { name: seg, path: subPath, folders: new Map(), files: [], totalFiles: 0 };
        cur.folders.set(seg, child);
      }
      child.totalFiles++;
      cur = child;
    }
    cur.files.push(item);
  }

  const rows: CorpusTreeRow[] = [];
  function flatten(node: FolderNode, depth: number): void {
    const sortedFolders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const folder of sortedFolders) {
      const isExpanded = Boolean(q) || expandedFolders.value.has(folder.path);
      rows.push({
        key: `dir:${folder.path}`,
        kind: 'folder',
        name: folder.name,
        path: folder.path,
        depth,
        expanded: isExpanded,
        childCount: folder.totalFiles,
      });
      if (isExpanded) flatten(folder, depth + 1);
    }
    const sortedFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const f of sortedFiles) {
      rows.push({
        key: `file:${f.id}`,
        kind: 'file',
        name: f.name,
        path: f.relativePath,
        depth,
        item: f,
      });
    }
  }
  flatten(root, 0);
  return rows;
});

function clearCorpusList(): void {
  corpusDirectoryTask?.abort();
  corpusDirectoryTask = undefined;
  corpusDirectoryLoading.value = false;
  savedCorpusDirectory.value = undefined;
  corpusDirectoryNeedsPermission.value = false;
  if (supportsCorpusDirectoryPicker()) {
    void saveCorpusDirectory().catch(() => store.pushToast('无法清除上次目录的记录', 'warning'));
  }
  localFiles.value = [];
  corpusDragFileRegistry.clear();
  expandedFolders.value = new Set();
  selectedCorpusId.value = '';
}

const SUPPORTED_CORPUS_RE = /\.(wav|mp3|ogg|flac|m4a|aac|webm|textgrid|vcproj|json)$/i;

function ingestCorpusFiles(files: CorpusFile[], notify = true): void {
  const byPath = new Map(localFiles.value.map((item) => [item.relativePath, item]));
  const newlyExpanded = new Set(expandedFolders.value);
  let addedCount = 0;

  for (const { file, relativePath } of files) {
    const lower = file.name.toLowerCase();
    if (!SUPPORTED_CORPUS_RE.test(lower) && !file.type.startsWith('audio/')) continue;
    const ext = file.name.includes('.') ? (file.name.split('.').pop() ?? '').toLowerCase() : '';
    const topFolder = relativePath.includes('/') ? relativePath.split('/')[0] : '';
    if (topFolder) newlyExpanded.add(topFolder);

    const existing = byPath.get(relativePath);
    const id = existing?.id ?? `f_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const entry: LocalWorkspaceFile = {
      id,
      name: file.name,
      relativePath,
      ext,
      sizeKb: Math.max(1, Math.round(file.size / 1024)),
      file,
    };
    corpusDragFileRegistry.set(id, file);
    byPath.set(relativePath, entry);
    addedCount++;
  }

  expandedFolders.value = newlyExpanded;
  localFiles.value = [...byPath.values()];
  if (notify && addedCount > 0) {
    store.pushToast(
      `已收入 ${addedCount} 个语料文件，将其拖入右侧时间轴即可解码上轨`,
      'info',
      3000,
    );
  }
}

async function ingestFiles(
  fileList: FileList | File[],
  opts?: { fromDropOnCorpus?: boolean; autoLoadDirect?: boolean },
): Promise<void> {
  const rawList = Array.from(fileList);
  const files = rawList.map((file) => ({
    file,
    relativePath: (file.webkitRelativePath || file.name).replace(/\\/g, '/').replace(/^\/+/, ''),
  }));
  ingestCorpusFiles(files, !opts?.autoLoadDirect);

  if (opts?.autoLoadDirect) {
    await loadFilesOntoTimeline(rawList);
    return;
  }

  const allVcproj = rawList.length > 0 && rawList.every((f) => f.name.toLowerCase().endsWith('.vcproj'));
  if (!opts?.fromDropOnCorpus && !allVcproj) return;
  for (const { file } of files) {
    if (!file.name.toLowerCase().endsWith('.vcproj')) continue;
    const res = store.importProjectJson(await file.text());
    if (res.ok) {
      g2pText.value = store.project.value.clips[store.activeClipId.value]?.source?.lyrics ?? g2pText.value;
    }
  }
}

async function loadCorpusDirectory(action: 'restore' | 'pick' | 'authorize'): Promise<void> {
  if (!supportsCorpusDirectoryPicker()) {
    if (action === 'pick') dirInputRef.value?.click();
    return;
  }
  if (corpusDirectoryLoading.value) return;
  const task = new AbortController();
  corpusDirectoryTask = task;
  corpusDirectoryLoading.value = true;
  try {
    const directory = action === 'pick' ? await pickCorpusDirectory(savedCorpusDirectory.value)
      : action === 'restore' ? await getSavedCorpusDirectory() : savedCorpusDirectory.value;
    if (!directory || task.signal.aborted) return;
    const permission = action === 'authorize' ? await directory.requestPermission({ mode: 'read' })
      : action === 'restore' ? await directory.queryPermission({ mode: 'read' }) : 'granted';
    if (task.signal.aborted) return;
    if (permission !== 'granted') {
      savedCorpusDirectory.value = directory;
      corpusDirectoryNeedsPermission.value = true;
      if (action === 'authorize') store.pushToast('语料目录访问未获允许，可点击「目录」重新选择', 'warning');
      return;
    }

    const files = await readCorpusDirectory(directory, task.signal);
    task.signal.throwIfAborted();
    ingestCorpusFiles(files, action === 'pick');
    savedCorpusDirectory.value = directory;
    corpusDirectoryNeedsPermission.value = false;
    if (action === 'pick') {
      try { await saveCorpusDirectory(directory); }
      catch { if (!task.signal.aborted) store.pushToast('已加载目录，下次打开需重新选择', 'warning'); }
    }
  } catch (error) {
    if (task.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
    store.pushToast(action === 'pick' ? '无法加载语料目录' : '无法恢复上次的语料目录，请重新选择', 'warning');
  } finally {
    if (corpusDirectoryTask === task) {
      corpusDirectoryTask = undefined;
      corpusDirectoryLoading.value = false;
    }
  }
}

function onCorpusDragOver(e: DragEvent): void {
  const transfer = e.dataTransfer;
  if (!transfer?.types.includes('Files')) return;
  e.preventDefault();
  transfer.dropEffect = 'copy';
  dropActive.value = true;
}

function onCorpusDragLeave(e: DragEvent): void {
  const panel = e.currentTarget as HTMLElement;
  if (e.relatedTarget instanceof Node && panel.contains(e.relatedTarget)) return;
  dropActive.value = false;
}

function onFileDrop(e: DragEvent): void {
  dropActive.value = false;
  if (e.dataTransfer?.files?.length) {
    void ingestFiles(e.dataTransfer.files, { fromDropOnCorpus: true });
  }
}

function onCorpusItemDragStart(item: LocalWorkspaceFile, e: DragEvent): void {
  selectedCorpusId.value = item.id;
  if (item.file) corpusDragFileRegistry.set(item.id, item.file);
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(CORPUS_DRAG_MIME, item.id);
    e.dataTransfer.setData('text/plain', item.name);
  }
}

function findSiblingTextGridInCorpus(audioItem?: LocalWorkspaceFile, rawFile?: File): File | undefined {
  const rel = audioItem?.relativePath ?? rawFile?.name ?? '';
  if (!rel) return undefined;
  const stem = rel.replace(/\.[^./]+$/, '').toLowerCase();
  const match = localFiles.value.find(
    (item) =>
      item.file &&
      item.ext.toLowerCase() === 'textgrid' &&
      item.relativePath.replace(/\.[^./]+$/, '').toLowerCase() === stem,
  );
  return match?.file;
}

async function applyTextGridFileToTimeline(
  gridFile: File,
  knownAudioDurationSec?: number,
): Promise<TextGridDocument | null> {
  try {
    const grid = await readTextGridFile(gridFile);
    const durSec = knownAudioDurationSec ?? loadedAnnotationRecording.value?.rawAudio.duration ?? grid.xmax;
    const durationSmp = Math.max(msToSamples(60), Math.round(durSec * SAMPLE_RATE_HZ));
    const imported = clipFromTextGrid(grid, durationSmp, store.activeClipId.value, store.activeVoiceId.value);
    if (!imported) {
      store.pushToast(`TextGrid ${gridFile.name} 中未解析出有效标注区间`, 'warning');
      return null;
    }
    const clip = withImportedTractFrames(imported, store.annotationTractFrames.value);
    store.executeCommand({
      type: 'clip.edit',
      label: `导入 TextGrid (${gridFile.name})`,
      payload: { clip, resetAnnotation: !loadedAnnotationRecording.value },
    });
    store.selectedSyllableId.value = clip.syllable_order[0] ?? '';
    const firstPhone = clip.syllables[store.selectedSyllableId.value]?.segments[0];
    store.selectedPhonemeIds.value = firstPhone ? [firstPhone.id] : [];
    store.playheadSmp.value = 0;
    if (loadedAnnotationRecording.value) {
      loadedAnnotationRecording.value = {
        ...loadedAnnotationRecording.value,
        uploadedTextGrid: grid,
        uploadedTextGridName: gridFile.name,
      };
    }
    return grid;
  } catch (error) {
    store.pushToast(error instanceof Error ? error.message : '无法读取 TextGrid', 'warning');
    return null;
  }
}

let timelineLoadSeq = 0;

async function isVcProjectFile(file: File): Promise<{ isProject: boolean; text?: string }> {
  if (/\.vcproj$/i.test(file.name)) {
    return { isProject: true, text: await file.text() };
  }
  if (/\.json$/i.test(file.name)) {
    const text = await file.text();
    try {
      const parsed = JSON.parse(text) as { schema?: unknown };
      if (parsed && parsed.schema === 'vocalcut/project') {
        return { isProject: true, text };
      }
    } catch {
      return { isProject: false };
    }
  }
  return { isProject: false };
}

async function loadFilesOntoTimeline(files: File[], corpusIds: string[] = []): Promise<void> {
  if (!files.length) return;
  const loadSeq = ++timelineLoadSeq;

  const projectCandidate = files.find((f) => /\.(vcproj|json)$/i.test(f.name));
  if (projectCandidate) {
    const checked = await isVcProjectFile(projectCandidate);
    if (loadSeq !== timelineLoadSeq) return;
    if (checked.isProject && checked.text) {
      store.stopPlayback();
      annotationPlaybackIntent++;
      loadedAnnotationRecording.value = null;
      annotationSource.value = null;
      store.editedAnnotationAudio.value = null;
      store.annotationTractFrames.value = [];
      followImportedTract.value = false;
      playheadScrubActive.value = false;
      annotationPlaybackSource.value = 'synthesis';
      const res = store.importProjectJson(checked.text);
      if (res.ok) {
        g2pText.value = store.project.value.clips[store.activeClipId.value]?.source?.lyrics ?? g2pText.value;
        corpusDrawerOpen.value = false;
      }
      return;
    }
  }

  const audioFile = files.find((f) => /\.(wav|mp3|ogg|flac|m4a|aac|webm)$/i.test(f.name) || f.type.startsWith('audio/'));
  let gridFile = files.find((f) => /\.textgrid$/i.test(f.name));

  // Ensure externally dropped files are also registered in the corpus tree
  for (const f of files) {
    const rel = f.name;
    if (!localFiles.value.some((x) => x.relativePath === rel)) {
      const id = `f_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const ext = f.name.includes('.') ? (f.name.split('.').pop() ?? '').toLowerCase() : '';
      corpusDragFileRegistry.set(id, f);
      localFiles.value = [...localFiles.value, { id, name: f.name, relativePath: rel, ext, sizeKb: Math.max(1, Math.round(f.size / 1024)), file: f }];
    }
  }

  if (audioFile) {
    const corpusEntry = corpusIds.length
      ? localFiles.value.find((x) => corpusIds.includes(x.id))
      : localFiles.value.find((x) => x.file === audioFile || x.name === audioFile.name);
    const autoPairedGrid = !gridFile ? findSiblingTextGridInCorpus(corpusEntry, audioFile) : undefined;
    if (autoPairedGrid) gridFile = autoPairedGrid;

    try {
      const decoded = await decodeRecording(audioFile);
      if (loadSeq !== timelineLoadSeq) return;
      store.stopPlayback();
      annotationPlaybackIntent++;
      store.editedAnnotationAudio.value = null;
      store.annotationTractFrames.value = [];
      annotationSource.value = null;
      followImportedTract.value = false;
      playheadScrubActive.value = false;
      store.playheadSmp.value = 0;
      loadedAnnotationRecording.value = {
        raw: audioFile,
        rawAudio: decoded,
        denoised: false,
        uploadedTextGrid: null,
        uploadedTextGridName: undefined,
      };
      showRecordingVersion(false);
      corpusDrawerOpen.value = false;
      if (gridFile) {
        const parsedGrid = await applyTextGridFileToTimeline(gridFile, decoded.duration);
        if (loadSeq !== timelineLoadSeq) return;
        if (parsedGrid) {
          store.pushToast(
            `已上轨音频 ${audioFile.name} (${decoded.duration.toFixed(2)}s)${autoPairedGrid ? `，已顺带选配同名 ${gridFile.name}` : ` 与 ${gridFile.name}`}`,
            'success',
            3400,
          );
          return;
        }
      }
      store.pushToast(
        `已上轨音频 ${audioFile.name} (${decoded.duration.toFixed(2)}s)，可点击下方「声道重建并对齐」提取轨迹`,
        'success',
        3400,
      );
    } catch {
      if (loadSeq === timelineLoadSeq) {
        store.pushToast(`音频 ${audioFile.name} 解码失败`, 'danger');
      }
    }
    return;
  }

  if (gridFile) {
    const parsedGrid = await applyTextGridFileToTimeline(gridFile);
    if (loadSeq === timelineLoadSeq && parsedGrid) {
      corpusDrawerOpen.value = false;
      store.pushToast(`已加载 TextGrid ${gridFile.name} 至时间轴`, 'success');
    }
  }
}

function onTimelineCorpusDrop(payload: { files: File[]; corpusIds: string[] }): void {
  void loadFilesOntoTimeline(payload.files, payload.corpusIds);
}

function onCorpusRowClick(item: LocalWorkspaceFile): void {
  selectedCorpusId.value = item.id;
}

function onCorpusRowDblClick(item: LocalWorkspaceFile): void {
  selectedCorpusId.value = item.id;
  if (item.file) {
    void loadFilesOntoTimeline([item.file], [item.id]);
  }
}

// ===== T-03: Inline M27 Vocal-Tract Reconstruction & Alignment onto Current Timeline =====
const reconstructModalOpen = ref(false);
const reconstructConfirmOpen = ref(false);
const reconstructDialogRef = ref<HTMLDialogElement | null>(null);
const reconstructTextDraft = ref('');
const reconstructLangDraft = ref<'auto' | 'zh' | 'en'>('auto');
const reconstructingTimeline = ref(false);

function extractValidM27F0Points(rows: readonly number[][], totalSmp: number): F0PinPoint[] {
  const pts: F0PinPoint[] = [];
  for (let i = 0; i < rows.length; i++) {
    const hz = rows[i]?.[17];
    if (typeof hz !== 'number' || !isValidF0Hz(hz)) continue;
    pts.push({
      t_smp: Math.min(totalSmp, Math.round((i * SAMPLE_RATE_HZ) / 50)),
      f0_hz: Number(hz.toFixed(1)),
    });
  }
  return pts.length >= 2 && pts[pts.length - 1].t_smp > pts[0].t_smp ? pts : [];
}

function m27RowToTract19(row: readonly number[], lm?: readonly number[]): number[] {
  const params = defaultTractParams();
  const names = ['HX', 'HY', 'JX', 'JA', 'LP', 'LD', 'VS', 'VO', 'TCX', 'TCY', 'TTX', 'TTY', 'TBX', 'TBY', 'TS1', 'TS2', 'TS3'] as const;
  names.forEach((key, idx) => {
    if (!Number.isFinite(row[idx])) return;
    let val = row[idx];
    // Guard legacy silent rest frames that carried negative TS1/TS2 from older alignment caches (T-64)
    if ((key === 'TS1' || key === 'TS2') && val < 0 && (row[18] ?? 0) < 5) {
      val = key === 'TS1' ? 0.15 : 0.05;
    }
    params[key] = val;
  });
  if (lm && lm.length >= 8 && Number.isFinite(lm[6]) && Number.isFinite(lm[7])) {
    params.TRX = Math.max(-4, Math.min(2, lm[6]));
    params.TRY = Math.max(-6, Math.min(0, lm[7]));
  }
  return tractRecordToArray19(params);
}

async function proceedReconstructAndAlign(): Promise<void> {
  const rec = loadedAnnotationRecording.value;
  if (!rec || reconstructingTimeline.value) return;
  if (rec.uploadedTextGrid) {
    await runInlineReconstructAndAlign({ useUploadedGrid: true });
    return;
  }
  reconstructTextDraft.value = g2pText.value.trim();
  reconstructModalOpen.value = true;
  await nextTick();
  if (reconstructDialogRef.value && !reconstructDialogRef.value.open) {
    reconstructDialogRef.value.showModal();
  }
}

async function onClickReconstructAndAlign(): Promise<void> {
  const rec = loadedAnnotationRecording.value;
  if (!rec || reconstructingTimeline.value) return;
  if (hasEditedReconstructedSource.value) {
    reconstructConfirmOpen.value = true;
    return;
  }
  await proceedReconstructAndAlign();
}

async function confirmOverwriteReconstruct(): Promise<void> {
  reconstructConfirmOpen.value = false;
  await proceedReconstructAndAlign();
}

function closeReconstructModal(): void {
  reconstructDialogRef.value?.close();
  reconstructModalOpen.value = false;
}

async function confirmReconstructModal(): Promise<void> {
  const text = reconstructTextDraft.value.trim();
  const lang = reconstructLangDraft.value;
  closeReconstructModal();
  await runInlineReconstructAndAlign({ text, lang, useUploadedGrid: false });
}

async function runInlineReconstructAndAlign(opts: {
  text?: string;
  lang?: 'auto' | 'zh' | 'en';
  useUploadedGrid: boolean;
}): Promise<void> {
  const rec = loadedAnnotationRecording.value;
  if (!rec || reconstructingTimeline.value) return;
  const clipIdAtStart = store.activeClipId.value;
  const projectIdAtStart = store.project.value.id;
  reconstructingTimeline.value = true;
  try {
    const activeAudio = rec.denoised && rec.cleanAudio ? rec.cleanAudio : rec.rawAudio;
    let wavB64: string;
    if (rec.denoised && rec.cleanAudio) {
      const nCh = rec.cleanAudio.numberOfChannels;
      const mono = nCh <= 1
        ? rec.cleanAudio.getChannelData(0)
        : (() => {
            const mixed = new Float32Array(rec.cleanAudio.length);
            for (let c = 0; c < nCh; c++) {
              const ch = rec.cleanAudio.getChannelData(c);
              for (let i = 0; i < mixed.length; i++) mixed[i] += ch[i] / nCh;
            }
            return mixed;
          })();
      wavB64 = encodeMonoWavBase64(mono, rec.cleanAudio.sampleRate);
    } else {
      wavB64 = await blobToBase64(rec.raw);
    }
    const guideText = !opts.useUploadedGrid && opts.text ? opts.text : undefined;
    const adapter = new M27Adapter();
    const res = await adapter.reconstruct({
      wav_base64: wavB64,
      filename: rec.denoised && rec.cleanAudio ? `${rec.raw.name.replace(/\.[^.]+$/, '')}-denoised.wav` : rec.raw.name,
      text: guideText,
      lang: opts.lang ?? 'auto',
      alignment_mode: guideText ? 'guided' : 'none',
      synth_mode: annotationRenderMode.value === 'neural' ? 'neural' : 'vtl',
      audio_gain: synthesisGainMode.value,
      compute_device: store.computeDevice.value,
      fps: 25,
    });
    if (
      loadedAnnotationRecording.value?.raw !== rec.raw ||
      store.activeClipId.value !== clipIdAtStart ||
      store.project.value.id !== projectIdAtStart
    ) {
      return;
    }
    if (!res.ok) {
      store.pushToast(res.error.hint, 'danger', 4200);
      return;
    }
    const data = res.value;
    const rows = data.m27_50hz_pa;
    if (!Array.isArray(rows) || !rows.length) {
      store.pushToast('声道重建服务未返回有效的 50 Hz 轨迹', 'warning');
      return;
    }

    const frames: AnnotationTractFrame[] = rows.map((row, i) => ({
      u: i / Math.max(1, rows.length - 1),
      params: m27RowToTract19(row, interpM27AnimState(data.tract_glottis_anim, i / 50)?.lm),
    }));
    const totalSmp = Math.max(msToSamples(60), Math.round(activeAudio.duration * SAMPLE_RATE_HZ));
    let resolvedGrid: TextGridDocument | null = opts.useUploadedGrid ? (rec.uploadedTextGrid ?? null) : null;

    if (!resolvedGrid && data.alignment?.textgrid) {
      const parsed = parseTextGrid(data.alignment.textgrid);
      if (parsed.ok) resolvedGrid = parsed.value;
    } else if (!opts.useUploadedGrid && guideText && data.alignment_error?.hint) {
      store.pushToast(`对齐提示：${data.alignment_error.hint}`, 'warning', 3800);
    }

    let baseClip = resolvedGrid
      ? clipFromTextGrid(resolvedGrid, totalSmp, store.activeClipId.value, store.activeVoiceId.value)
      : undefined;

    if (!baseClip) {
      // Fallback single-span clip when user leaves reference text blank
      const midPose = frames[Math.floor(frames.length / 2)]?.params ?? tractRecordToArray19(defaultTractParams());
      baseClip = {
        id: store.activeClipId.value,
        kind: 'phrase',
        voice_id: store.activeVoiceId.value,
        start_smp: 0,
        end_smp: totalSmp,
        variants: ['original', 'synth'],
        active_variant: 'original',
        source: { lyrics: guideText || rec.raw.name.replace(/\.[^.]+$/, ''), lang: 'mixed' },
        syllable_order: ['m27_span_1'],
        syllables: {
          m27_span_1: {
            id: 'm27_span_1',
            text: guideText || rec.raw.name.replace(/\.[^.]+$/, ''),
            ipa: ['ə'],
            nucleus_index: 0,
            start_smp: 0,
            end_smp: totalSmp,
            anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
            segments: [
              {
                id: 'm27_seg_0',
                ipa: 'ə',
                start_smp: 0,
                end_smp: totalSmp,
                role: 'nucleus',
                elastic: true,
                voiced: true,
                params: [...midPose],
              },
            ],
            targets: [],
            overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
          },
        },
      };
    }

    const enrichedClip = withImportedTractFrames(baseClip, frames);
    const cmds: WorkbenchCommand[] = [
      { type: 'clip.edit', payload: { clip: enrichedClip, resetAnnotation: false } },
    ];
    const validF0Pts = extractValidM27F0Points(rows, totalSmp);
    if (validF0Pts.length >= 2) {
      cmds.push({
        type: 'f0.draw',
        payload: {
          id: `m27-${enrichedClip.id}`,
          points: validF0Pts,
        },
      });
    }

    const applied = store.applyProposal(cmds, `声道重建并对齐 (${rec.raw.name})`);
    if (applied.ok) {
      store.annotationTractFrames.value = frames;
      followImportedTract.value = true;
      annotationSource.value = {
        projectId: store.project.value.id,
        baseline: JSON.parse(JSON.stringify(enrichedClip)),
        controls: JSON.stringify(currentAnnotationControls(store.project.value)),
        rows,
        speakerWavBase64: wavB64,
      };
      showRecordingVersion(rec.denoised);
      store.selectedSyllableId.value = enrichedClip.syllable_order[0] ?? '';
      const firstSeg = enrichedClip.syllables[store.selectedSyllableId.value]?.segments[0];
      store.selectedPhonemeIds.value = firstSeg ? [firstSeg.id] : [];
      if (guideText) g2pText.value = guideText;
      store.pushToast(
        resolvedGrid
          ? `声道重建完成 · 已写入 ${enrichedClip.syllable_order.length} 个对齐音节与 ${rows.length} 帧轨迹`
          : `声道重建完成 · 已写入 ${rows.length} 帧 50 Hz 声道轨迹`,
        'success',
        3600,
      );
    }
  } catch (err) {
    store.pushToast(err instanceof Error ? err.message : '声道重建请求失败', 'danger');
  } finally {
    reconstructingTimeline.value = false;
  }
}

// ===== Compact Permanent IPA Quick-Replace Grid + Clipboard Copy (T-08) =====
function quickIpaTitle(item: QuickIpaItem): string {
  const segment = primarySelectedEntry.value?.seg;
  if (segment) {
    const action = item.category === 'diacritic' ? `叠加到 [${segment.ipa}]` : `替换选中 [${segment.ipa}]`;
    return `${item.display ?? item.symbol} · ${item.nameZh}（点击${action}并复制；Ctrl+点击仅复制）`;
  }
  return `${item.display ?? item.symbol} · ${item.nameZh}（点击复制符号）`;
}

function replaceSelectedWithIpa(item: QuickIpaItem, e?: MouseEvent): void {
  const isMark = item.category === 'diacritic';
  if (isMark) focusedQuickDiacritic.value = item;
  else focusedQuickIpa.value = item;

  const clip = activeClip.value;
  const selected = new Set(store.selectedPhonemeIds.value);
  const copyOnly = Boolean(e && (e.ctrlKey || e.metaKey)) || !clip || !selected.size;

  if (copyOnly) {
    void copyTextToClipboard(item.symbol).then((copied) => {
      store.pushToast(
        copied ? `已复制 [${item.display ?? item.symbol}]` : '无法写入剪贴板',
        copied ? 'info' : 'warning',
        2000,
      );
    });
    return;
  }

  const targets = new Map<string, string>();
  for (const { seg } of allSegmentsFlat.value) {
    if (!selected.has(seg.id) || (isMark && (seg.role === 'rest' || seg.ipa === 'sil' || !seg.ipa.trim()))) continue;
    const symbol = isMark ? combineIpaDiacritic(seg.ipa, item.symbol) : item.symbol;
    if (isMark && symbol === seg.ipa.normalize('NFC')) continue;
    if (phoneTraits(symbol).stop && seg.end_smp - seg.start_smp < msToSamples(11)) {
      store.pushToast(`当前选中段不足 11 ms 塞音下限，未${isMark ? '叠加' : '替换'}`, 'warning', 2400);
      return;
    }
    targets.set(seg.id, symbol);
  }
  if (!targets.size) {
    void copyTextToClipboard(item.symbol).then((copied) => {
      store.pushToast(
        copied ? `已复制 [${item.display ?? item.symbol}]` : '无法写入剪贴板',
        copied ? 'info' : 'warning',
        2000,
      );
    });
    return;
  }

  const cloned = JSON.parse(JSON.stringify(clip)) as Clip;
  for (const sid of cloned.syllable_order) {
    const syl = cloned.syllables[sid];
    if (!syl) continue;
    let sylTouched = false;
    const replacedIdx = new Set<number>();
    const replacedIds = new Set<string>();
    const prevIpa = syl.segments.map((s) => s.ipa);
    syl.segments.forEach((seg, idx) => {
      const symbol = targets.get(seg.id);
      if (symbol === undefined) return;
      const updated = replaceSegmentIpa(seg, symbol, speakerModel.value, isMark ? undefined : item.entryId);
      syl.segments[idx] = updated;
      syl.ipa[idx] = updated.ipa;
      replacedIdx.add(idx);
      replacedIds.add(seg.id);
      sylTouched = true;
    });
    if (sylTouched) {
      if (syl.overrides?.poses?.length) {
        syl.overrides.poses = syl.overrides.poses.filter(
          (pose) => !replacedIdx.has(pose.seg_index) && (!pose.seg_id || !replacedIds.has(pose.seg_id)),
        );
      }
      const nucIdx = syl.segments.findIndex((s) => s.role === 'nucleus');
      if (nucIdx >= 0) syl.nucleus_index = nucIdx;
      syncSyllableTextFromSegments(syl, prevIpa);
    }
  }

  const res = store.executeCommand({
    type: 'clip.edit',
    label: isMark
      ? `为 ${targets.size} 个音素叠加 [${item.display ?? item.symbol}]`
      : `替换 ${targets.size} 个音素为 [${item.symbol}]`,
    payload: { clip: cloned },
  });
  if (res.ok) {
    void copyTextToClipboard(item.symbol);
    store.pushToast(
      isMark
        ? `已为 ${targets.size} 个选中音素叠加 [${item.display ?? item.symbol}] 并复制`
        : `已将 ${targets.size} 个选中音素替换为 [${item.display ?? item.symbol}] 并复制`,
      'success',
      2000,
    );
  }
}

async function auditionQuickIpa(item: QuickIpaItem): Promise<void> {
  focusedQuickIpa.value = item;
  quickAuditionRequest?.abort();
  const request = new AbortController();
  quickAuditionRequest = request;
  quickAuditionBusy.value = true;
  quickAudition.value = null;
  annotationPlaybackIntent++;
  store.stopPlayback();
  const label = item.category === 'vowel' ? item.symbol : `a${item.symbol}a`;
  try {
    quickReferenceList ??= fetchIpaReferences().then(references => {
      if (!references.length) quickReferenceList = undefined;
      return references;
    }).catch(() => {
      quickReferenceList = undefined;
      return [];
    });
    const take = findQuickIpaTake(await quickReferenceList, item);
    if (request.signal.aborted) return;
    if (take) {
      try {
        const response = await fetch(ipaReferenceUrl(take.reference.id, 'audio', synthesisGainMode.value), {
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
        });
        if (response.ok) {
          const buffer = await decodeRecording(new File([await response.blob()], 'ipa.wav'));
          if (request.signal.aborted) return;
          if (take.end <= buffer.duration + 1 / buffer.sampleRate) {
            await store.playAudioBuffer(buffer, {
              offsetSeconds: take.start,
              durationSeconds: take.end - take.start,
              voiceAutoGain: synthesisGainMode.value === 'peak',
            });
            quickAudition.value = { key: quickIpaKey(item.symbol), source: '实录' };
            return;
          }
        }
      } catch {
        if (request.signal.aborted) return;
      }
    }
    if (!canSynthesizeQuickIpa(item.symbol)) {
      store.pushToast(`暂无 [${label}] 的实录可供试听`, 'warning');
      return;
    }
    const speaker = speakerModel.value;
    await Promise.all([preloadPtbIpaPresets(speaker), loadDefaultIpaPoses()]);
    if (request.signal.aborted) return;
    const buffer = await store.synthesizeRange({
      annotation: true,
      phrase: buildQuickIpaClip(item, speaker, store.activeVoiceId.value),
      f0Hz: store.currentGlottisParams.value.f0_hz,
      mode: 'physical',
      cacheWaveform: false,
      signal: request.signal,
    });
    if (!buffer || request.signal.aborted) return;
    await store.playAudioBuffer(buffer, { voiceAutoGain: synthesisGainMode.value === 'peak' });
    quickAudition.value = { key: quickIpaKey(item.symbol), source: 'VTL 合成' };
  } finally {
    if (quickAuditionRequest === request) quickAuditionBusy.value = false;
  }
}

// ===== Vocal Tract Direct Drag & On-Demand 19-D Parameter Drawer (Plan A) =====
const core6Meta = VTL_PARAM_META.filter((m) => m.core6);
const extra13Meta = VTL_PARAM_META.filter((m) => !m.core6);

const pendingPose = shallowRef<TractDelta>({});
const pendingExtras = shallowRef<TractPoseExtras | null>(null);
const inspectorParams = computed(() => ({ ...store.currentTractParams.value, ...pendingPose.value }));
let sliderPoseFrameId = 0;

function onViewportTractUpdate(delta: TractDelta): void {
  if (playheadScrubActive.value) {
    const cur = playheadSegmentEntry.value;
    if (cur) {
      store.selectedSyllableId.value = cur.syl.id;
      store.selectedPhonemeIds.value = [cur.seg.id];
    }
    playheadScrubActive.value = false;
  }
  if (!primarySelectedEntry.value) idlePoseTouched.value = true;
  pendingPose.value = delta;
}

function onViewportExtrasUpdate(ex: TractPoseExtras): void {
  if (!primarySelectedEntry.value) idlePoseTouched.value = true;
  pendingExtras.value = cloneTractExtras(ex);
}

function commitPose(delta: TractDelta, label: string) {
  const entry = primarySelectedEntry.value;
  const clip = activeClip.value;
  if (!entry || !clip) {
    idlePoseTouched.value = true;
    const merged = { ...store.currentTractParams.value, ...delta };
    const ex = pendingExtras.value;
    const result = store.executeCommand({
      type: 'artic.set_pose',
      label,
      payload: { params: merged },
    });
    if (result.ok && ex) store.currentTractExtras.value = ex;
    pendingPose.value = {};
    pendingExtras.value = null;
    return store.requestVtlPose(merged, speakerModel.value, ex ?? store.currentTractExtras.value);
  }
  const index = entry.syl.segments.findIndex(s => s.id === entry.seg.id);
  const articulation = { type: 'artic.set_pose' as const, payload: {
    clip_id: clip.id, syllable_id: entry.syl.id, seg_index: index, params: delta,
  } };
  const ex = pendingExtras.value;
  const edited = JSON.parse(JSON.stringify(clip)) as typeof clip;
  const targetSyl = edited.syllables[entry.syl.id];
  if (targetSyl && index >= 0) {
    // Record pose override so annotation-audio.ts applies smooth raised-cosine coarticulatory blend (T-21)
    const priorPoses = (targetSyl.overrides.poses ?? []).filter(p => p.seg_id !== entry.seg.id && p.seg_index !== index);
    targetSyl.overrides.poses = [...priorPoses, { seg_index: index, seg_id: entry.seg.id, delta }];
    if (ex) {
      Object.assign(targetSyl.segments[index], {
        lip_width: ex.lip_width, larynx_height_cm: ex.larynx_height,
        manual_root: ex.manual_root,
        tongue_shape: [...ex.tongue_shape], lip_shape: [...ex.lip_shape],
      });
    }
  }
  const result = store.executeCommand({ type: 'batch', label, payload: {
    commands: [{ type: 'clip.edit', payload: { clip: edited } }, articulation],
  } });
  if (result.ok && ex) store.currentTractExtras.value = ex;
  pendingPose.value = {};
  pendingExtras.value = null;
  return store.requestVtlPose();
}

function onViewportDragEnd(delta: TractDelta): void {
  commitPose(delta, '拖动声道控制点');
}

function onSliderTractInput(key: TractParamName, value: number): void {
  if (followImportedTract.value || store.isPlaying.value) return;
  if (playheadScrubActive.value) {
    const cur = playheadSegmentEntry.value;
    if (cur) {
      store.selectedSyllableId.value = cur.syl.id;
      store.selectedPhonemeIds.value = [cur.seg.id];
    }
    playheadScrubActive.value = false;
  }
  if (!primarySelectedEntry.value) idlePoseTouched.value = true;
  pendingPose.value = { ...pendingPose.value, [key]: value };
  if (!sliderPoseFrameId) {
    sliderPoseFrameId = window.requestAnimationFrame(() => {
      sliderPoseFrameId = 0;
      if (!followImportedTract.value && !playheadScrubActive.value && !store.isPlaying.value) {
        void store.requestVtlPose(
          inspectorParams.value,
          speakerModel.value,
          pendingExtras.value ?? store.currentTractExtras.value,
          true,
        );
      }
    });
  }
}

function onSliderTractCommit(key: TractParamName, value: number): void {
  if (followImportedTract.value || store.isPlaying.value) return;
  if (playheadScrubActive.value) {
    const cur = playheadSegmentEntry.value;
    if (cur) {
      store.selectedSyllableId.value = cur.syl.id;
      store.selectedPhonemeIds.value = [cur.seg.id];
    }
    playheadScrubActive.value = false;
  }
  if (sliderPoseFrameId) {
    window.cancelAnimationFrame(sliderPoseFrameId);
    sliderPoseFrameId = 0;
  }
  commitPose({ ...pendingPose.value, [key]: value }, `调节 ${key} = ${value.toFixed(2)}`);
}

function resetSelectedPhonemePose(): void {
  if (followImportedTract.value || store.isPlaying.value) {
    store.pushToast('当前正在跟随轨迹预览，关闭轨迹跟随即可复位构型', 'info', 2400);
    return;
  }
  playheadScrubActive.value = false;
  const entry = primarySelectedEntry.value;
  const clip = activeClip.value;
  pendingPose.value = {};
  pendingExtras.value = null;
  if (!entry || !clip) {
    idlePoseTouched.value = false;
    const schwa = getFullPoseForIpa('ə', undefined, speakerModel.value);
    const res = store.executeCommand({
      type: 'artic.set_pose',
      label: '复位 [ə] 标准 IPA 构型',
      payload: { params: schwa.params },
    });
    if (res.ok) {
      store.currentTractExtras.value = cloneTractExtras(schwa.extras);
      void store.requestVtlPose(schwa.params, speakerModel.value, schwa.extras);
      store.pushToast('已恢复 [ə] 标准 IPA 构型', 'success', 2000);
    }
    return;
  }
  const segIndex = entry.syl.segments.findIndex((s) => s.id === entry.seg.id);
  if (segIndex < 0) return;
  const full = getFullPoseForIpa(nasalPoseIpa(entry.seg.ipa), undefined, speakerModel.value);
  const edited = JSON.parse(JSON.stringify(clip)) as typeof clip;
  const targetSyl = edited.syllables[entry.syl.id];
  if (targetSyl) {
    targetSyl.overrides.poses = (targetSyl.overrides.poses ?? []).filter(
      (p) => p.seg_id !== entry.seg.id && p.seg_index !== segIndex,
    );
    Object.assign(targetSyl.segments[segIndex], {
      params: [...full.params19],
      lip_width: full.extras.lip_width,
      larynx_height_cm: full.extras.larynx_height,
      manual_root: full.extras.manual_root,
      tongue_shape: [...full.extras.tongue_shape],
      lip_shape: [...full.extras.lip_shape],
    });
  }
  const res = store.executeCommand({
    type: 'batch',
    label: `复位 [${entry.seg.ipa}] 标准 IPA 构型`,
    payload: {
      commands: [
        { type: 'clip.edit', payload: { clip: edited } },
        {
          type: 'artic.set_pose',
          payload: {
            clip_id: clip.id,
            syllable_id: entry.syl.id,
            seg_index: segIndex,
            params: full.params,
          },
        },
      ],
    },
  });
  if (res.ok) {
    store.currentTractExtras.value = cloneTractExtras(full.extras);
    void store.requestVtlPose(full.params, speakerModel.value, full.extras);
    store.pushToast(`已恢复 [${entry.seg.ipa}] 标准 IPA 构型`, 'success', 2000);
  }
}

const speechLexiconStandard = computed(() => {
  const source = activeClip.value?.source;
  const standard = source?.reading_standard ?? source?.transcription;
  return standard && (mandarinStandards.some(item => item === standard) || standard.startsWith('dialect:'))
    ? standard : g2pStandard.value;
});
const speechLexiconReadings = computed(() => {
  const lyrics = activeClip.value?.source?.lyrics;
  const standard = speechLexiconStandard.value;
  if (!lyrics || standard.startsWith('dialect:')) return [];
  try {
    const parsed = parseVoqsScopedText(lyrics);
    const personal = buildPersonalG2pMap(standard);
    return parsed.chunks.flatMap(chunk => reviewText(chunk.text, standard as MappingStandard, cmuLexicon.value,
      personal, kanaText === parsed.plainText ? kanaWords : undefined));
  } catch {
    return [];
  }
});
const currentLexiconSelection = computed(() => {
  const clip = activeClip.value;
  const syllable = primarySelectedEntry.value?.syl;
  return clip && syllable ? speechLexiconSelection(clip, syllable, speechLexiconReadings.value, speechLexiconStandard.value) : null;
});
const currentLexiconDictionaryLabel = computed(() => {
  const selection = currentLexiconSelection.value;
  if (!selection) return '';
  if (selection.language === 'en') return '英语';
  if (selection.language === 'ja') return '日语';
  if (selection.language === 'ipa') return 'IPA';
  return savedDialects.value.find(pack => pack.id === selection.standard)?.name
    ?? mandarinStandardOptions.find(option => option.value === selection.standard)?.label
    ?? '汉语';
});

function saveCurrentSyllableToPersonalLexicon(): void {
  const selection = currentLexiconSelection.value;
  const syl = primarySelectedEntry.value?.syl;
  if (!selection || !syl) return;
  const spk = speakerModel.value;
  const saved = saveSyllableToUserLexicon({
    ...selection,
    segmentDurationsSmp: selection.segments.map(s => s.end_smp - s.start_smp),
    preferredDurationMs: Math.round(samplesToMs(syl.end_smp - syl.start_smp)),
    poseSetId: selectedIpaPoseSetId.value,
    segmentPoses: selection.segments
      .map((s) => ({
        ipa: s.ipa,
        params19: s.params && s.params.length === 19 ? [...s.params] : getFullPoseForIpa(s.ipa, undefined, spk).params19,
        extras: extractSegmentExtras(s, spk),
      })),
  });
  if (!saved) {
    store.pushToast('个人词典写入失败，请检查浏览器本地存储', 'warning');
    return;
  }
  const unit = saved.syllableIndex === undefined ? '' : ` · 第 ${saved.syllableIndex + 1} 音节`;
  store.pushToast(`已将「${saved.word}」${unit} [${saved.ipaJoined}] 存入「${activeUserLexiconBook.value.name}」· ${currentLexiconDictionaryLabel.value}`, 'success', 3200);
}

function handleExportPersonalLexicon(): void {
  const json = exportUserLexiconJson();
  const safeName = activeUserLexiconBook.value.name.replace(/[\\/:*?"<>|]/g, '_') || 'user-lexicon';
  downloadTextFile(`${safeName}.json`, json);
  store.pushToast(`已导出个人词典「${activeUserLexiconBook.value.name}」`, 'success', 2200);
}

async function handleImportPersonalLexicon(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const raw = await file.text();
    const book = importUserLexiconJson(raw);
    if (!book) {
      store.pushToast('无效的个人词典 JSON 格式', 'warning');
      return;
    }
    runG2pReview();
    store.pushToast(`已导入个人词典「${book.name}」（${Object.keys(book.entries).length} 条）`, 'success', 2800);
  } catch {
    store.pushToast('读取个人词典 JSON 失败', 'warning');
  }
}

const newBookNameDraft = ref('');
function handleCreateLexiconBook(): void {
  const id = createUserLexiconBook(newBookNameDraft.value);
  if (!id) {
    store.pushToast('请输入唯一的新词典簿名称', 'warning');
    return;
  }
  newBookNameDraft.value = '';
  store.pushToast('已创建并切换到新个人词典簿', 'success', 2000);
}

// ===== 2x2 PTB Scientific Physics & Acoustic Vowel Space Quad =====
const importedDisplayedPose = shallowRef<Record<string, unknown> | null>(null);
let trajectoryPrefetchAbort: AbortController | null = null;
let trajectoryPrefetchBusy = false;
let trajectoryDirectSeq = 0;

function buildTrajectoryPoseRequest(frame: AnnotationTractFrame, spk = speakerModel.value): PoseRequest {
  const ex = pendingExtras.value ?? store.currentTractExtras.value;
  return {
    speaker: spk,
    section_count: 65,
    params: frame.params,
    ...cloneTractExtras(ex),
  };
}

function applyResolvedTrajectoryPose(state: Record<string, unknown>): void {
  const snap = state as unknown as PtbPoseSnapshot;
  if (snap?.centerline?.length && !userPinnedSection.value) {
    const summary = computeAreaReadouts(snap);
    if (summary) activeSectionIdx.value = summary.aminIdx;
  }
  importedDisplayedPose.value = state;
}

function triggerTrajectoryPrefetch(startIndex: number): void {
  const frames = displayedTractFrames.value;
  if (!frames?.length || store.engineStatus.value !== 'python-vtl') return;
  const safeStart = Math.max(0, Math.min(frames.length - 1, startIndex));
  const spk = speakerModel.value;
  const winStart = store.isPlaying.value ? safeStart : Math.max(0, safeStart - 8);
  const winEnd = Math.min(frames.length, store.isPlaying.value ? safeStart + 44 : safeStart + 16);
  const uncached: PoseRequest[] = [];
  for (let i = winStart; i < winEnd; i++) {
    const req = buildTrajectoryPoseRequest(frames[i], spk);
    if (!isVtlPosePendingOrCached(req)) uncached.push(req);
  }
  if (!uncached.length || trajectoryPrefetchBusy) return;
  if (!trajectoryPrefetchAbort || trajectoryPrefetchAbort.signal.aborted) {
    trajectoryPrefetchAbort = new AbortController();
  }
  const signal = trajectoryPrefetchAbort.signal;
  const batchLimit = annotationSynthesizing.value ? 8 : 24;
  const batch = uncached.slice(0, batchLimit);
  trajectoryPrefetchBusy = true;
  void prefetchVtlPoseBatch(batch, { signal, maxBatchSize: batchLimit })
    .finally(() => {
      trajectoryPrefetchBusy = false;
      if (signal.aborted) return;
      // Refresh active frame immediately if it just landed in cache
      const curIdx = activeTrajectoryIndex.value;
      const curFrames = displayedTractFrames.value;
      if (curIdx >= 0 && curFrames?.[curIdx]) {
        const curHit = getCachedVtlPose(buildTrajectoryPoseRequest(curFrames[curIdx]));
        if (curHit) {
          const resolved = (curHit.state as Record<string, unknown>) ?? curHit;
          if (resolved !== importedDisplayedPose.value) {
            applyResolvedTrajectoryPose(resolved);
          }
        }
        // Keep sliding window topped up during playback
        if (store.isPlaying.value) {
          const nextUnfilled = curFrames.findIndex(
            (f, idx) => idx >= curIdx && idx < Math.min(curFrames.length, curIdx + 36) && !isVtlPosePendingOrCached(buildTrajectoryPoseRequest(f)),
          );
          if (nextUnfilled >= 0) triggerTrajectoryPrefetch(nextUnfilled);
        }
      }
    });
}

// Warm-prefetch the opening 24 frames as soon as a trajectory is available
watch(
  [displayedTractFrames, speakerModel, () => store.engineStatus.value],
  ([frames, , eng], prev) => {
    if (prev && (frames !== prev[0] || speakerModel.value !== prev[1])) {
      trajectoryPrefetchAbort?.abort();
      trajectoryPrefetchAbort = null;
      trajectoryPrefetchBusy = false;
    }
    if (frames?.length && eng === 'python-vtl') {
      const idx = activeTrajectoryIndex.value >= 0 ? activeTrajectoryIndex.value : 0;
      triggerTrajectoryPrefetch(idx);
    }
  },
);

// Deliver cached trajectory or pre-synthesis scrub frames synchronously (0 ms cache hit)
watch(
  [activeTrajectoryIndex, scrubFallbackParams, displayedTractFrames, speakerModel, () => store.engineStatus.value],
  ([idx, fallback, frames, spk, eng]) => {
    if (idx >= 0 && frames?.[idx]) {
      if (eng !== 'python-vtl') return;
      const req = buildTrajectoryPoseRequest(frames[idx], spk);
      const cached = getCachedVtlPose(req);
      if (cached) {
        const resolved = (cached.state as Record<string, unknown>) ?? cached;
        if (resolved !== importedDisplayedPose.value) {
          applyResolvedTrajectoryPose(resolved);
        }
        if (store.isPlaying.value) {
          triggerTrajectoryPrefetch(idx + 1);
        }
        return;
      }
      // Cache miss (cold start or sudden scrub): fetch current frame + kick lookahead batch
      const seq = ++trajectoryDirectSeq;
      triggerTrajectoryPrefetch(idx);
      void resolveVtlPose(req).then((ans) => {
        if (!ans || seq !== trajectoryDirectSeq || activeTrajectoryIndex.value !== idx) return;
        applyResolvedTrajectoryPose((ans.state as Record<string, unknown>) ?? ans);
      });
      return;
    }
    if (fallback && eng === 'python-vtl') {
      const ex = pendingExtras.value ?? store.currentTractExtras.value;
      const req: PoseRequest = {
        speaker: spk,
        section_count: 65,
        params: tractRecordToArray19(fallback),
        ...cloneTractExtras(ex),
      };
      const cached = getCachedVtlPose(req);
      if (cached) {
        const resolved = (cached.state as Record<string, unknown>) ?? cached;
        if (resolved !== importedDisplayedPose.value) applyResolvedTrajectoryPose(resolved);
        return;
      }
      const seq = ++trajectoryDirectSeq;
      void resolveVtlPose(req).then((ans) => {
        if (!ans || seq !== trajectoryDirectSeq || !scrubFallbackParams.value) return;
        applyResolvedTrajectoryPose((ans.state as Record<string, unknown>) ?? ans);
      });
      return;
    }
    importedDisplayedPose.value = null;
  },
  { flush: 'sync' },
);

function acceptViewportPose(state: Record<string, unknown>) {
  if (activeScrubTractParams.value) applyResolvedTrajectoryPose(state);
}
const metrics = computed(() => {
  if (importedDisplayedPose.value && activeScrubTractParams.value) {
    return metricsFromVtlSnapshot(importedDisplayedPose.value,store.currentMetrics.value);
  }
  return store.currentMetrics.value;
});
const liveSnapshot = computed<PtbPoseSnapshot | null>(() => {
  const raw = activeScrubTractParams.value ? importedDisplayedPose.value : store.currentTractState.value;
  if (raw && typeof raw === 'object') return raw as unknown as PtbPoseSnapshot;

  return null;
});

const acousticCards = [
  { id: 'area', label: '面积 A(x)', title: '声道面积函数' },
  { id: 'transfer', label: '传递 H(f)', title: '声道传递函数' },
  { id: 'section', label: '横截面 / 唇形', title: '声道横截面与正面唇形' },
  { id: 'vowel', label: '元音图', title: '声学元音图' },
] as const;
type AcousticCardId = (typeof acousticCards)[number]['id'];
const openAcousticCards = ref(new Set<AcousticCardId>(acousticCards.map(card => card.id)));
const acousticFontScale = computed(() => openAcousticCards.value.size === acousticCards.length ? 0.92 : 1);

function toggleAcousticCard(id: AcousticCardId) {
  const next = new Set(openAcousticCards.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  openAcousticCards.value = next;
}

function openAllAcousticCards() {
  openAcousticCards.value = new Set(acousticCards.map(card => card.id));
}

const areaCanvasRef = ref<HTMLCanvasElement | null>(null);
const spectrumCanvasRef = ref<HTMLCanvasElement | null>(null);
const sectionCanvasRef = ref<HTMLCanvasElement | null>(null);
const vowelCanvasRef = ref<HTMLCanvasElement | null>(null);

const activeSectionIdx = ref(36);
const userPinnedSection = ref(false);
const spectrumReadout = ref<{ prefix: 'F' | 'P'; peaks: number[]; zeros: number[] }>({ prefix: 'F', peaks: [], zeros: [] });
const sectionStatus = ref({ open: false, areaCm2: 0, midlineClosed: false, available: false });

const areaSummary = computed(() => computeAreaReadouts(liveSnapshot.value, activeSectionIdx.value));
const lipFront = computed(() => buildPtbLipFrontData(liveSnapshot.value, activeScrubTractParams.value ?? store.currentTractParams.value));
const crossGripDragging=ref(false);
const keyframeModalOpen=ref(false);
let crossPointerCleanup:(()=>void)|null=null;
let crossGesture=0;

const sideHandles = shallowRef<{x:number,y:number,key:TractParamName}[]>([]);
function refreshSideHandles() {
  const snap = liveSnapshot.value;
  const canvas = sectionCanvasRef.value;
  const row = snap?.airway_sections?.[activeSectionIdx.value];
  const center = snap?.centerline?.[activeSectionIdx.value];
  const mesh = snap?.meshes?.find(m=>m.name==='tongue');
  if (!canvas || !row || !mesh || !center) { sideHandles.value=[]; return; }
  const indices = row.lower.flatMap((height,i)=>height===null||row.upper[i]===null?[]:[i]);
  if(indices.length<3){sideHandles.value=[];return;}
  const ribs = (store.currentTractState.value?.tongue_side_ribs as number[]|undefined) ?? [11,21,30];
  const distances = ribs.map(r=>{
    const clampedRib = Math.max(0, Math.min(mesh.ribs - 1, Math.round(r)));
    const k=(clampedRib*mesh.points+mesh.points-1)*3;
    if (k + 1 >= mesh.vertices.length) return Number.POSITIVE_INFINITY;
    return Math.hypot(mesh.vertices[k]-center[0],mesh.vertices[k+1]-center[1]);
  });
  const key = ('TS'+(1+distances.indexOf(Math.min(...distances)))) as TractParamName;
  const view=sectionView(canvas.clientWidth,canvas.clientHeight);
  if (view.scale <= 0) { sideHandles.value = []; return; }
  sideHandles.value=[.15,.85].map(f=>{
    const i=indices[Math.round(f*(indices.length-1))];
    return { x:view.x(i), y:view.y(row.lower[i]!),key };
  });
}
function dragCrossHandle(e:PointerEvent,key:TractParamName|'lip_width',direction=1) {
  if(e.button!==0||!e.isPrimary||importedTractParams.value||!primarySelectedEntry.value)return;
  e.preventDefault();
  crossPointerCleanup?.();
  const gesture=++crossGesture;
  const target=e.currentTarget as Element;
  const horizontal=key==='lip_width';
  const ex=cloneTractExtras(store.currentTractExtras.value);
  const base=horizontal?ex.lip_width:store.currentTractParams.value[key as TractParamName];
  const parameters=store.engineMeta.value?.parameters as {name:string;min:number;max:number}[]|undefined;
  const meta=parameters?.find(m=>m.name===key) ?? VTL_PARAM_META.find(m=>m.key===key);
  const min=meta?.min??.55,max=meta?.max??1.6;
  const unit=(horizontal?Math.max(10,(target.closest('svg')?.getBoundingClientRect().width ?? 0)*.30):
    (sectionCanvasRef.value ? sectionView(sectionCanvasRef.value.clientWidth,sectionCanvasRef.value.clientHeight).scale*getCurrentPageScale() : 0));
  if (!Number.isFinite(unit) || unit <= 1e-4) return;
  let value=base;
  let changed=false;
  let pending=0;
  crossGripDragging.value=true;
  const update=(ev:PointerEvent)=>{
    if(ev.pointerId!==e.pointerId)return;
    const d=horizontal?(ev.clientX-e.clientX)*direction:e.clientY-ev.clientY;
    const next=Math.max(min,Math.min(max,base+d/unit*(horizontal?base:key==='TS1'?1.2:.35)));
    if(next===value)return;
    value=next;
    changed=true;
    if(horizontal)pendingExtras.value={...ex,lip_width:value};
    else pendingPose.value={ [key]:value };
    if(!pending)pending=requestAnimationFrame(()=>{pending=0;void store.requestVtlPose(pendingPose.value,undefined,pendingExtras.value,true);});
  };
  const cleanup=()=>{
    if(pending)cancelAnimationFrame(pending);
    window.removeEventListener('pointermove',update);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);
    crossPointerCleanup=null;
  };
  const end=async(ev:PointerEvent)=>{
    if(ev.pointerId!==e.pointerId)return;
    if(ev.type==='pointerup')update(ev);
    cleanup();
    if(ev.type==='pointerup'&&value!==base){
      await commitPose(horizontal?{}:{[key]:value},horizontal?'调节唇宽':'调节舌侧缘 '+key);
    }else{
      pendingPose.value={};pendingExtras.value=null;
      if(changed)await store.requestVtlPose();
    }
    await nextTick();
    if(gesture===crossGesture)crossGripDragging.value=false;
  };
  crossPointerCleanup=cleanup;
  window.addEventListener('pointermove',update);window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);
}

const activeSectionPosCm = computed(() => {
  if (areaSummary.value?.selected) return areaSummary.value.selected.position;
  return null;
});

const effectiveAminCm2 = computed(() => {
  if (areaSummary.value) return areaSummary.value.aminCm2;
  return null;
});

const vowelReferences = ref<VowelReferencePoint[]>([]);
const vowelReferenceMode = ref<VowelReferenceMode>('recorded');
const vowelCoordinateScale = ref<VowelCoordinateScale>('logarithmic');
const vowelReferenceLoading = ref(false);
const vowelReferenceError = ref('');
const emptyVowelOmissions = () => ({ annotation: 0, track: 0, peaks: 0, invalid: 0, unlinked: 0 });
const vowelOmissions = ref(emptyVowelOmissions());
const measuredVowelCount = computed(() => vowelReferences.value.filter(point => point.source === 'recorded').length);
const transferVowelCount = computed(() => vowelReferences.value.filter(point => point.source === 'transfer').length);
const savedPoseVowelCount = computed(() => vowelReferences.value.filter(point => point.source === 'pose').length);
const nasalVowelCount = computed(() => vowelReferences.value.filter(point => point.nasal).length);
const vowelHover = ref<VowelReferencePoint | null>(null);
const manualVowelAxes = ref<VowelSpaceAxes | null>(null);
const vowelHistory = ref<VowelTrailPoint[]>([]);
const vowelCurrentInView = ref(false);
let lastVowelCurrent: { f1: number; f2: number; nasal: boolean; time: number } | null = null;
let lastVowelDrawLayout: ReturnType<typeof drawPtbVowelSpace> = null;
let vowelTrailTimer = 0;
let vowelDragCleanup: (() => void) | null = null;
let vowelRequest: AbortController | null = null;

const currentVowelPeak = computed<{ f1: number; f2: number; nasal: boolean } | null>(() => {
  const snap = liveSnapshot.value;
  if (!snap || (snap.speaker && snap.speaker !== speakerModel.value)) return null;
  const pair = readPeaks(readRealPeaks(snap as unknown as Record<string, unknown>));
  const nasal = metrics.value.nasal_coupled ?? isSnapshotNasalCoupled(snap);
  return pair ? { ...pair, nasal } : null;
});

async function loadSpeakerVowelReferences(speaker: string): Promise<void> {
  vowelRequest?.abort();
  const request = new AbortController();
  vowelRequest = request;
  const mode = vowelReferenceMode.value;
  vowelReferenceLoading.value = true;
  vowelReferenceError.value = '';
  vowelReferences.value = [];
  vowelHover.value = null;
  vowelOmissions.value = emptyVowelOmissions();
  drawVowelCanvasOnly();
  try {
    const measured = await loadVowelMeasurements(mode, speaker);
    if (request.signal.aborted) return;
    const setId = selectedIpaPoseSetId.value;
    if (setId !== RECORDED_IPA_SET_ID) await loadDefaultIpaPoses();
    if (request.signal.aborted) return;
    const sets = ipaPoseSets.value;
    const baseline = sets.find(set => set.id === RECORDED_IPA_SET_ID)?.poses ?? {};
    const selected = sets.find(set => set.id === setId)?.poses ?? {};
    const overrides = new Map(poseOverridesForSet(setId).filter(pose => pose.system !== 'voqs' && phoneTraits(pose.symbol).vowel)
      .map(pose => [vowelSymbolKey(pose.symbol), pose]));
    const modified = new Map([...overrides.values()].map(pose => [vowelSymbolKey(pose.symbol), pose.symbol]));
    if (setId !== RECORDED_IPA_SET_ID) {
      for (const [symbol, params] of Object.entries(selected)) {
        if (phoneTraits(symbol).vowel && (!baseline[symbol] || params.some((value, index) => value !== baseline[symbol][index]))) {
          modified.set(vowelSymbolKey(symbol), symbol);
        }
      }
    }
    const bySymbol = new Map<string, typeof measured.records[number]>();
    for (const point of measured.records) {
      const key = vowelSymbolKey(point.symbol);
      const linked = overrides.get(key)?.referenceRecordingId;
      if (mode === 'transfer' && modified.has(key) && point.id !== linked) continue;
      if (linked && point.id === linked) {
        bySymbol.set(key, point);
        continue;
      }
      if (!bySymbol.has(key)) bySymbol.set(key, point);
    }
    vowelReferences.value = [...bySymbol.values()].map(point => ({
      symbol: point.symbol,
      source: mode, f1: point.f1, f2: point.f2,
      nasal: mode === 'transfer' ? point.nasal === true : point.symbol.normalize('NFD').includes('̃'),
      name: (mode === 'transfer' ? speaker + ' · 65 截面 · '
        + (measured.anatomy_adaptation === 'native_landmarks' ? 'JD2 反演轨经解剖适配 · ' : '') : '')
        + point.id + ' · 标注核心 ' + point.core_start_s.toFixed(2) + '–' + point.core_end_s.toFixed(2) + ' s · ' + point.frames + ' 帧',
    }));
    vowelOmissions.value = {
      annotation: measured.omitted.filter(point => point.code === 'missing_annotation' || point.reason?.includes('标注')).length,
      track: measured.omitted.filter(point => point.code === 'missing_track').length,
      peaks: measured.omitted.filter(point => point.code === 'missing_peaks'
        || (mode === 'recorded' && point.reason?.includes('帧'))).length,
      invalid: 0,
      unlinked: 0,
    };
    if (mode === 'transfer') {
      const entries = [...modified].filter(([key]) => !bySymbol.has(key));
      if (!entries.length) return;
      const bySet = sets.find(set => set.id === setId)?.name ?? '';
      await preloadPtbIpaPresets(speaker);
      if (request.signal.aborted) return;
      for (let index = 0; index < entries.length; index += 40) {
        const poses = entries.slice(index, index + 40).map(([key, symbol]) => {
          const pose = getFullPoseForIpa(symbol, overrides.get(key)?.id, speaker, setId);
          return { symbol, params: pose.params19, ...pose.extras };
        });
        const result = await measureSavedVowelPoses(speaker, poses, request.signal);
        if (request.signal.aborted) return;
        vowelReferences.value = [...vowelReferences.value, ...result.records.map(point => ({ ...point, source: 'pose' as const,
          name: speaker + ' · 65 截面 · ' + bySet }))];
        vowelOmissions.value.peaks += result.omitted.filter(point => point.code === 'missing_peaks').length;
        vowelOmissions.value.invalid += result.omitted.filter(point => point.code === 'invalid_pose').length;
      }
    }
  } catch (error) {
    if (!request.signal.aborted) vowelReferenceError.value = error instanceof Error ? error.message : '无法读取元音参考数据';
  } finally {
    if (!request.signal.aborted) {
      vowelReferenceLoading.value = false;
      drawVowelCanvasOnly();
    }
  }
}

function drawVowelCanvasOnly(): void {
  window.clearTimeout(vowelTrailTimer);
  vowelTrailTimer = 0;
  if (!vowelCanvasRef.value) {
    lastVowelDrawLayout = null;
    vowelCurrentInView.value = false;
    return;
  }
  const now = performance.now();
  vowelHistory.value = vowelHistory.value.filter((p) => now - p.time < 10000);
  if (vowelHistory.value.length > 0 && !store.isPlaying.value) {
    const oldest = vowelHistory.value[0].time;
    vowelTrailTimer = window.setTimeout(
      () => drawVowelCanvasOnly(),
      Math.min(180, Math.max(60, 10000 - (now - oldest))),
    );
  }
  lastVowelDrawLayout = drawPtbVowelSpace(vowelCanvasRef.value, {
    references: vowelReferences.value,
    current: currentVowelPeak.value,
    history: vowelHistory.value,
    manualAxes: manualVowelAxes.value,
    scale: vowelCoordinateScale.value,
    fontScale: acousticFontScale.value,
    now,
  });
  vowelCurrentInView.value = lastVowelDrawLayout?.currentInView ?? false;
}

function drawAllPhysicsQuadCharts(): void {
  const snap = liveSnapshot.value;
  if (snap?.centerline?.length && !userPinnedSection.value) {
    const summary = computeAreaReadouts(snap);
    if (summary && activeSectionIdx.value !== summary.aminIdx) activeSectionIdx.value = summary.aminIdx;
  }
  drawSelectedSection();
  spectrumReadout.value = drawPtbSpectrumChart(
    spectrumCanvasRef.value,
    snap,
    hfMaxHz.value,
    metrics.value.antiformants,
    metrics.value.nasal_coupled,
    acousticFontScale.value,
  );
  drawVowelCanvasOnly();
}
let sectionFrameId=0;
function drawSelectedSection() {
  const snap=liveSnapshot.value;
  drawPtbAreaChart(areaCanvasRef.value,snap,activeSectionIdx.value,undefined,acousticFontScale.value);
  if (!importedTractParams.value) refreshSideHandles();
  sectionStatus.value=drawPtbSectionChart(sectionCanvasRef.value,snap,activeSectionIdx.value,acousticFontScale.value);
}

// Area Chart interactive cursor scrub (updates both Area cursor & Cross-Section slice!)
function onAreaPointerDown(e: PointerEvent): void {
  const canvas = areaCanvasRef.value;
  if (e.button!==0 || !e.isPrimary || !canvas || !liveSnapshot.value?.centerline?.length) return;
  e.preventDefault();
  userPinnedSection.value = true;
  const update = (ev: PointerEvent) => {
    if(ev.pointerId!==e.pointerId)return;
    const snap=liveSnapshot.value;
    if(!snap?.centerline?.length)return;
    const rect = canvas.getBoundingClientRect();
    const width=canvas.clientWidth;
    const next=clientXToSectionIndex(snap,width,(ev.clientX-rect.left)*width/rect.width);
    if(next===activeSectionIdx.value)return;
    activeSectionIdx.value=next;
    if(!sectionFrameId)sectionFrameId=requestAnimationFrame(()=>{sectionFrameId=0;drawSelectedSection();});
  };
  update(e);
  const onUp=(ev:PointerEvent)=>{
    if(ev.pointerId!==e.pointerId)return;
    if(ev.type==='pointerup')update(ev);
    canvas.removeEventListener('pointermove',update);
    canvas.removeEventListener('pointerup',onUp);
    canvas.removeEventListener('pointercancel',onUp);
    canvas.removeEventListener('lostpointercapture',onUp);
  };
  canvas.setPointerCapture(e.pointerId);
  canvas.addEventListener('pointermove',update);
  canvas.addEventListener('pointerup',onUp);
  canvas.addEventListener('pointercancel',onUp);
  canvas.addEventListener('lostpointercapture',onUp);
}

// Acoustic Vowel Space interactive wheel zoom, left-drag pan & double-click reset
function onVowelWheel(e: WheelEvent): void {
  const canvas = vowelCanvasRef.value;
  if (!canvas || !lastVowelDrawLayout || !e.deltaY) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const { pad, w, h, axes, plotW, plotH, scale } = lastVowelDrawLayout;
  const lx = (e.clientX - rect.left) * w / rect.width;
  const ly = (e.clientY - rect.top) * h / rect.height;
  const anchorF1 = (ly - pad.t) / plotH;
  const anchorF2 = 1 - (lx - pad.l) / plotW;
  const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? h : 1);
  vowelHover.value = null;
  manualVowelAxes.value = zoomVowelSpaceAxes(axes, anchorF1, anchorF2, delta, scale);
  drawVowelCanvasOnly();
}

function onVowelPointerDown(e: PointerEvent): void {
  if (e.button !== 0 || !e.isPrimary || !lastVowelDrawLayout) return;
  e.preventDefault();
  vowelDragCleanup?.();
  const { axes, plotW, plotH, scale: coordinateScale } = lastVowelDrawLayout;
  const pointerId = e.pointerId;
  const startX = e.clientX;
  const startY = e.clientY;

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    const scale = getCurrentPageScale();
    const dx = (ev.clientX - startX) / scale;
    const dy = (ev.clientY - startY) / scale;
    if (Math.hypot(dx, dy) < 2.5) return;
    vowelHover.value = null;
    manualVowelAxes.value = panVowelSpaceAxes(axes, dx, dy, plotW, plotH, coordinateScale);
    drawVowelCanvasOnly();
  };
  const cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    vowelDragCleanup = null;
  };
  const onUp = (ev: PointerEvent) => { if (ev.pointerId === pointerId) cleanup(); };
  vowelDragCleanup = cleanup;
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

function onVowelHover(event: PointerEvent) {
  const canvas = vowelCanvasRef.value;
  const layout = lastVowelDrawLayout;
  if (!canvas || !layout || event.buttons) return;
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * layout.w / rect.width;
  const y = (event.clientY - rect.top) * layout.h / rect.height;
  let nearest: VowelReferencePoint | null = null;
  let best = 12;
  for (const mark of layout.marks) {
    const distance = Math.hypot(mark.x - x, mark.y - y);
    if (distance < best) { best = distance; nearest = mark.point; }
  }
  vowelHover.value = nearest;
}

function resetVowelView(): void {
  vowelDragCleanup?.();
  vowelHover.value = null;
  manualVowelAxes.value = null;
  drawVowelCanvasOnly();
}

// Observe live formant peaks for 10s vowel-space trail
let quadFrameId = 0;
function schedulePhysicsCharts(): void {
  if (quadFrameId) return;
  quadFrameId = window.requestAnimationFrame(() => {
    quadFrameId = 0;
    drawAllPhysicsQuadCharts();
  });
}

watch(vowelCoordinateScale, resetVowelView, { flush: 'post' });
watch(
  [openAcousticCards, areaCanvasRef, spectrumCanvasRef, sectionCanvasRef, vowelCanvasRef],
  ([open, ...canvases], _, cleanup) => {
    if (!open.has('vowel')) {
      vowelDragCleanup?.();
      vowelHover.value = null;
    }
    schedulePhysicsCharts();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(schedulePhysicsCharts);
    for (const canvas of canvases) if (canvas) observer.observe(canvas);
    cleanup(() => observer.disconnect());
  },
  { flush: 'post' },
);

watch(
  currentVowelPeak,
  (pair) => {
    const now = performance.now();
    if (
      lastVowelCurrent &&
      (!pair || Math.abs(pair.f1 - lastVowelCurrent.f1) > 2 || Math.abs(pair.f2 - lastVowelCurrent.f2) > 4) &&
      now - lastVowelCurrent.time < 10000
    ) {
      vowelHistory.value.push({
        f1: lastVowelCurrent.f1,
        f2: lastVowelCurrent.f2,
        nasal: lastVowelCurrent.nasal,
        time: lastVowelCurrent.time,
        breakAfter: !pair,
      });
      if (vowelHistory.value.length > 180) {
        vowelHistory.value = vowelHistory.value.slice(-180);
      }
    }
    lastVowelCurrent = pair ? { ...pair, time: now } : null;
    schedulePhysicsCharts();
  },
);

watch(
  () => store.isPlaying.value,
  (playing) => {
    if (!playing && vowelHistory.value.length > 0) {
      schedulePhysicsCharts();
    }
  },
);

watch(
  [
    liveSnapshot,
    metrics,
    hfMaxHz,
    () => store.resolvedColorMode.value,
    () => store.paletteId.value,
    () => store.surfaceStyle.value,
    () => store.customAccentHex.value,
    () => store.anatomyAppearance.value,
  ],
  (_next, prev) => {
    if (
      prev &&
      (prev[3] !== store.resolvedColorMode.value ||
        prev[4] !== store.paletteId.value ||
        prev[5] !== store.surfaceStyle.value ||
        prev[6] !== store.customAccentHex.value ||
        prev[7] !== store.anatomyAppearance.value)
    ) {
      invalidateChartThemeCache();
    }
    schedulePhysicsCharts();
  },
);

watch(
  [speakerModel, vowelReferenceMode, selectedIpaPoseSetId, customIpaPoses, ipaPoseSets],
  ([spk, mode], [prevSpk, prevMode]) => {
    if (spk !== prevSpk || mode !== prevMode) {
      vowelHistory.value = [];
      lastVowelCurrent = null;
      manualVowelAxes.value = null;
    }
    void loadSpeakerVowelReferences(spk);
  },
);

const annotationRenderCache = new Map<string, AnnotationRender>();
const pendingAnnotationRenders = new Map<string, Promise<AnnotationRender | null>>();
const pendingAnnotationKey = ref('');
const annotationSynthesizing = computed(() => pendingAnnotationKey.value === annotationRenderKey.value);
const canSynthesizeAnnotation = computed(() => Boolean(activeClip.value?.syllable_order.some(id => activeClip.value?.syllables[id].segments.length)));
const annotationSynthesisLabel = computed(() => voiceRenderLabels[annotationRenderMode.value]);
const annotationAudioLabel = computed(() => {
  if (annotationPlaybackSource.value === 'edited') return '录音剪辑';
  if (annotationPlaybackSource.value === 'recording') {
    const recording = loadedAnnotationRecording.value;
    if (recording?.denoised) return '降噪录音';
    return '原始音频';
  }
  const result = hasSynthesizedRecording.value ? displayedAnnotationRender.value?.provenance : undefined;
  const hardware = result?.device === 'cuda' ? 'GPU' : result?.device === 'cpu' ? 'CPU' : '';
  const renderMode = result?.mode ?? annotationRenderMode.value;
  const speakerBadge =
    renderMode === 'neural' && store.customSpeakerAudioBase64.value
      ? store.customSpeakerName.value
      : renderMode === 'neural' && returnSource.value?.speakerWavBase64
        ? '沿用原录音音色'
        : result?.voiceProfile === 'jingjing-lecture'
          ? DEFAULT_SPEAKER_REFERENCE_NAME
          : '';
  const references = [...new Set(result?.recordedArticulation?.map(span =>
    '[' + span.ipa + '] ' + (span.reference_position === 'intervocalic' ? '元音间' : span.reference_position === 'onset' ? '起首' : '单音')))];
  return [result?.sourceBadge ?? annotationSynthesisLabel.value, hardware,
    speakerBadge, references.length ? '动态参考 ' + references.join(' / ') : '',
    result?.protectedIpaPoses?.length ? '已保护 ' + result.protectedIpaPoses.map(ipa => '[' + ipa + ']').join(' / ') : '',
    result?.articulationModel ?? (result?.articulationSource === 'reference' ? '分段时域规整轨迹' : ''),
    result?.ignoredGeometryFields?.length ? '未使用唇宽/舌面等附加构型' : '',
    !hasSynthesizedRecording.value ? '待合成' : '']
    .filter(Boolean).join(' · ');
});
let annotationPlaybackIntent = 0;

function applyAnnotationRender(render: AnnotationRender): void {
  annotationPlaybackSource.value = 'synthesis';
  displayedAnnotationRender.value = render;
  store.annotationAudioBuffer.value = render.buffer;
  store.annotationAudioOffsetSmp.value = render.start;
  store.lastAudioBuffer.value = render.buffer;
}

const returnSource = computed(() => {
  const source = annotationSource.value;
  return source?.projectId === store.project.value.id && source.baseline.id === activeClip.value?.id ? source : null;
});

// T-62: Detect when user edits phoneme/syllable duration, F0, phonation, or pose on a reconstructed clip
const hasEditedReconstructedSource = computed(() => {
  const source = returnSource.value;
  const clip = activeClip.value;
  if (!source || !clip) return false;
  const controls = currentAnnotationControls(store.project.value);
  const spans = changedAudioSpans(source.baseline, clip, source.controls !== JSON.stringify(controls));
  return spans === 'whole' || spans.length > 0;
});

watch(
  () => [store.project.value.revision, hasEditedReconstructedSource.value] as const,
  ([, edited], prev) => {
    if (!prev) return;
    const [prevRev] = prev;
    // When user performs a timeline edit (duration/boundary/F0/pose) on a loaded recording/reconstructed clip,
    // automatically switch playback source to 'synthesis' so clicking Play immediately synthesizes the modified timing!
    if (store.project.value.revision !== prevRev && edited && annotationPlaybackSource.value !== 'synthesis') {
      annotationPlaybackSource.value = 'synthesis';
    }
  },
);

watch(annotationRenderKey, key => {
  annotationPlaybackIntent++;
  if (annotationPlaybackSource.value !== 'synthesis') return;
  store.stopPlayback();
  const cached = annotationRenderCache.get(key);
  if (cached) applyAnnotationRender(cached);
  else if (displayedAnnotationRender.value) {
    if (store.annotationAudioBuffer.value === displayedAnnotationRender.value.buffer) store.annotationAudioBuffer.value = null;
    if (store.lastAudioBuffer.value === displayedAnnotationRender.value.buffer) store.lastAudioBuffer.value = null;
  }
});

function collectEditedReferencePhoneIds(clip: Clip, baseline?: Clip): string[] {
  if (!baseline) return [];
  const baselinePhones = new Map(
    baseline.syllable_order.flatMap((id) =>
      (baseline.syllables[id]?.segments ?? []).map((phone) => [phone.id, phone] as const),
    ),
  );
  const edited: string[] = [];
  for (const sid of clip.syllable_order) {
    const syl = clip.syllables[sid];
    if (!syl) continue;
    const poseOverrideIds = new Set(
      (syl.overrides?.poses ?? []).map((p) => p.seg_id ?? syl.segments[p.seg_index]?.id).filter(Boolean),
    );
    for (const phone of syl.segments) {
      if (phone.role === 'rest') continue;
      const orig = baselinePhones.get(phone.id);
      const isNewOrChanged =
        !orig ||
        orig.ipa !== phone.ipa ||
        orig.voiced !== phone.voiced ||
        JSON.stringify(orig.params) !== JSON.stringify(phone.params) ||
        JSON.stringify(orig.stop_timing) !== JSON.stringify(phone.stop_timing) ||
        poseOverrideIds.has(phone.id);
      if (isNewOrChanged) edited.push(phone.id);
    }
  }
  return edited;
}

async function renderCurrentAnnotation(streamPlay?: { playheadStartSmp?: number; gain?: number; voiceAutoGain?: boolean }): Promise<AnnotationRender | null> {
  const clip = activeClip.value, key = annotationRenderKey.value;
  if (!clip || !canSynthesizeAnnotation.value) {
    store.pushToast('请先编译文本或载入带音素的标注。', 'info');
    return null;
  }
  const cached = annotationRenderCache.get(key);
  if (cached) return cached;
  const pending = pendingAnnotationRenders.get(key);
  if (pending) return pending;
  const mode = annotationRenderMode.value;
  pendingAnnotationKey.value = key;
  const job = (async () => {
    const source = returnSource.value;
    const editedPhoneIds = collectEditedReferencePhoneIds(clip, source?.baseline);
    const effectiveSpkWav = store.customSpeakerAudioBase64.value ?? source?.speakerWavBase64 ?? undefined;
    const buffer = await synthesizeClipBySentences(
      store,
      clip,
      {
        annotation: true,
        mode,
        clipId: clip.id,
        cacheWaveform: false,
        returnControlTrack: true,
        speakerWavBase64: effectiveSpkWav,
        ipaPoseSource: textPoseSource.value,
        streamPlay,
        onStreamTractFrames: streamPlay
          ? (frames) => {
              if (annotationRenderKey.value === key) {
                streamingTractFrames.value = frames;
              }
            }
          : undefined,
        referenceTrack: source
          ? {
              frames: store.annotationTractFrames.value,
              m27RowsPa: source.rows,
              editedPhoneIds,
              sourceClip: source.baseline,
              durationSmp: source.baseline.end_smp - source.baseline.start_smp,
            }
          : undefined,
      },
      () => annotationRenderKey.value === key,
    );
    if (!buffer || annotationRenderKey.value !== key) return null;
    const result = { key, buffer, start: clip.start_smp, provenance: store.synthesisInfo(buffer) };
    annotationRenderCache.set(key, result);
    if (annotationRenderCache.size > 4) {
      const oldest = annotationRenderCache.keys().next().value;
      if (oldest) annotationRenderCache.delete(oldest);
    }
    return result;
  })().finally(() => {
    pendingAnnotationRenders.delete(key);
    if (pendingAnnotationKey.value === key) {
      pendingAnnotationKey.value = '';
      streamingTractFrames.value = null;
    }
  });
  pendingAnnotationRenders.set(key, job);
  return job;
}

function showSynthesizedRecording(): void {
  annotationPlaybackIntent++;
  store.stopPlayback();
  const cached = annotationRenderCache.get(annotationRenderKey.value);
  if (cached) applyAnnotationRender(cached);
  else annotationPlaybackSource.value = 'synthesis';
}

async function toggleTransportPlay(): Promise<void> {
  const intent = ++annotationPlaybackIntent;
  if (store.isPlaying.value) {
    store.stopPlayback();
    return;
  }
  if (annotationPlaybackSource.value === 'synthesis') {
    const clip = activeClip.value;
    const playFromStart = !clip || store.playheadSmp.value <= clip.start_smp + msToSamples(40) || store.playheadSmp.value >= clip.end_smp - msToSamples(40);
    const rendered = await renderCurrentAnnotation(
      playFromStart && clip ? { playheadStartSmp: clip.start_smp, voiceAutoGain: synthesisGainMode.value === 'peak' } : undefined,
    );
    if (!rendered || intent !== annotationPlaybackIntent || rendered.key !== annotationRenderKey.value) return;
    applyAnnotationRender(rendered);
    if (store.consumeStreamPlayed(rendered.buffer)) return;
  }
  const buffer = store.annotationAudioBuffer.value;
  if (!buffer) return;
  const start = store.annotationAudioOffsetSmp.value;
  const end = start + Math.round(buffer.duration * SAMPLE_RATE_HZ);
  const current = store.playheadSmp.value;
  const sample = current >= start && current < end - msToSamples(12) ? current : start;
  await store.playAudioBuffer(buffer, {
    playheadStartSmp: sample,
    offsetSeconds: (sample - start) / SAMPLE_RATE_HZ,
    voiceAutoGain: synthesisGainMode.value === 'peak',
  });
}

const sendingAudio = ref(false);
// T-05 & T-45: Teleport floating popovers (Send Audio menu & Multi-Language Dictionary menu)
const sendMenuOpen = ref(false);
const sendMenuBtnRef = ref<HTMLButtonElement | null>(null);
const sendMenuFloatingRef = ref<HTMLDivElement | null>(null);
const sendMenuStyle = ref<Record<string, string>>({});

const dictMenuOpen = ref(false);
const dictMenuBtnRef = ref<HTMLButtonElement | null>(null);
const dictMenuFloatingRef = ref<HTMLDivElement | null>(null);
const dictMenuStyle = ref<Record<string, string>>({});

function toggleSendAudioMenu(): void {
  if (sendMenuOpen.value) {
    sendMenuOpen.value = false;
    return;
  }
  dictMenuOpen.value = false;
  const btn = sendMenuBtnRef.value;
  if (btn) {
    const rect = btn.getBoundingClientRect();
    const scale = Math.max(0.5, getCurrentPageScale());
    const vw = window.innerWidth / scale;
    const vh = window.innerHeight / scale;
    const menuW = 196;
    const left = Math.max(8, Math.min(vw - menuW - 8, rect.right / scale - menuW));
    let top = rect.bottom / scale + 6;
    if (top + 214 > vh) top = Math.max(8, rect.top / scale - 220);
    sendMenuStyle.value = {
      left: `${Math.round(left)}px`,
      top: `${Math.round(top)}px`,
      minWidth: `${menuW}px`,
      maxHeight: `${Math.max(140, Math.round(vh - 16))}px`,
    };
  }
  sendMenuOpen.value = true;
}

function toggleDictMenu(): void {
  if (dictMenuOpen.value) {
    dictMenuOpen.value = false;
    return;
  }
  sendMenuOpen.value = false;
  const btn = dictMenuBtnRef.value;
  if (btn) {
    const rect = btn.getBoundingClientRect();
    const scale = Math.max(0.5, getCurrentPageScale());
    const vw = window.innerWidth / scale;
    const vh = window.innerHeight / scale;
    const menuW = 360;
    const left = Math.max(8, Math.min(vw - menuW - 8, rect.left / scale));
    const estH = 540;
    let top = rect.bottom / scale + 6;
    if (top + estH > vh) {
      top = Math.max(8, rect.top / scale - Math.min(estH, vh - 24) - 6);
    }
    dictMenuStyle.value = {
      left: `${Math.round(left)}px`,
      top: `${Math.round(top)}px`,
      width: `${menuW}px`,
      maxHeight: `${Math.max(220, Math.round(vh - 16))}px`,
    };
  }
  dictMenuOpen.value = true;
}

function onGlobalPopoverDown(e: PointerEvent): void {
  const t = e.target as HTMLElement | null;
  if (t?.closest('#vcSelectMenu')) return;
  if (sendMenuOpen.value) {
    if (!sendMenuFloatingRef.value?.contains(t) && !sendMenuBtnRef.value?.contains(t)) {
      sendMenuOpen.value = false;
    }
  }
  if (dictMenuOpen.value) {
    if (!dictMenuFloatingRef.value?.contains(t) && !dictMenuBtnRef.value?.contains(t)) {
      dictMenuOpen.value = false;
    }
  }
}

function onSynthesisPageKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (reconstructConfirmOpen.value) {
    reconstructConfirmOpen.value = false;
    e.preventDefault();
    return;
  }
  if (sendMenuOpen.value || dictMenuOpen.value) {
    sendMenuOpen.value = false;
    dictMenuOpen.value = false;
    e.preventDefault();
    return;
  }
  if (corpusDrawerOpen.value) {
    corpusDrawerOpen.value = false;
    corpusDragging.value = false;
    e.preventDefault();
  }
}

function blurToolbarButtonOnMouseClick(e: MouseEvent): void {
  if (e.detail <= 0) return;
  const btn = (e.target as HTMLElement | null)?.closest('button');
  if (btn && !btn.closest('.vc-sel, [role="dialog"], [role="menu"], dialog, .rt-phone-popover, .rt-poly-menu')) {
    btn.blur();
  }
}

// T-62: Play timeline selection using cached full buffer when ready, or referenceTrack + original speaker timbre
async function playTimelineSelection(range: { startSmp?: number; endSmp?: number; gain: number }): Promise<void> {
  const clip = activeClip.value;
  if (!clip) return;
  const intent = ++annotationPlaybackIntent;
  store.stopPlayback();

  const cachedRender = displayedAnnotationRender.value;
  if (hasSynthesizedRecording.value && cachedRender) {
    const startSmp = Math.max(cachedRender.start, range.startSmp ?? cachedRender.start);
    const endSmp = range.endSmp ?? (cachedRender.start + Math.round(cachedRender.buffer.duration * SAMPLE_RATE_HZ));
    const offsetSeconds = Math.max(0, (startSmp - cachedRender.start) / SAMPLE_RATE_HZ);
    const durationSeconds = Math.min(cachedRender.buffer.duration, Math.max(0, (endSmp - cachedRender.start) / SAMPLE_RATE_HZ)) - offsetSeconds;
    if (durationSeconds > 0.005) {
      await store.playAudioBuffer(cachedRender.buffer, {
        gain: range.gain,
        offsetSeconds,
        durationSeconds,
        playheadStartSmp: startSmp,
        voiceAutoGain: synthesisGainMode.value === 'peak',
      });
      return;
    }
  }

  const source = returnSource.value;
  const editedPhoneIds = collectEditedReferencePhoneIds(clip, source?.baseline);
  const effectiveSpkWav = store.customSpeakerAudioBase64.value ?? source?.speakerWavBase64 ?? undefined;
  const buf = await synthesizeClipBySentences(
    store,
    clip,
    {
      annotation: true,
      mode: annotationRenderMode.value,
      startSmp: range.startSmp,
      endSmp: range.endSmp,
      cacheWaveform: false,
      speakerWavBase64: effectiveSpkWav,
      ipaPoseSource: textPoseSource.value,
      streamPlay: {
        gain: range.gain,
        playheadStartSmp: range.startSmp ?? 0,
        voiceAutoGain: synthesisGainMode.value === 'peak',
        shouldStreamPlay: () => intent === annotationPlaybackIntent,
      },
      referenceTrack: source
        ? {
            frames: store.annotationTractFrames.value,
            m27RowsPa: source.rows,
            editedPhoneIds,
            sourceClip: source.baseline,
            durationSmp: source.baseline.end_smp - source.baseline.start_smp,
          }
        : undefined,
    },
    () => intent === annotationPlaybackIntent && activeClip.value?.id === clip.id,
  );
  if (buf && intent === annotationPlaybackIntent && !store.consumeStreamPlayed(buf)) {
    await store.playAudioBuffer(buf, {
      gain: range.gain,
      playheadStartSmp: range.startSmp ?? 0,
      voiceAutoGain: synthesisGainMode.value === 'peak',
    });
  }
}

// T-63: Synchronized audio/trajectory cut & leading/trailing silence trim with atomic localEdit Ctrl+Z undo/redo
interface CutAuxSnapshot {
  recording: typeof loadedAnnotationRecording.value;
  source: typeof annotationSource.value;
  tractFrames: AnnotationTractFrame[];
  playbackSource: 'recording' | 'edited' | 'synthesis';
  audioBuffer: AudioBuffer | null;
  editedAudio: AudioBuffer | null;
}

function captureCutAuxSnapshot(): CutAuxSnapshot {
  return {
    recording: loadedAnnotationRecording.value
      ? {
          ...loadedAnnotationRecording.value,
          uploadedTextGrid: loadedAnnotationRecording.value.uploadedTextGrid
            ? JSON.parse(JSON.stringify(loadedAnnotationRecording.value.uploadedTextGrid))
            : null,
        }
      : null,
    source: annotationSource.value ? JSON.parse(JSON.stringify(annotationSource.value)) : null,
    tractFrames: store.annotationTractFrames.value.map((f) => ({ u: f.u, params: [...f.params] })),
    playbackSource: annotationPlaybackSource.value,
    audioBuffer: store.annotationAudioBuffer.value,
    editedAudio: store.editedAnnotationAudio.value,
  };
}

function applyCutAuxSnapshot(snap: CutAuxSnapshot): void {
  annotationPlaybackIntent++;
  store.stopPlayback();
  loadedAnnotationRecording.value = snap.recording;
  annotationSource.value = snap.source;
  store.annotationTractFrames.value = snap.tractFrames;
  store.editedAnnotationAudio.value = snap.editedAudio;
  annotationPlaybackSource.value = snap.playbackSource;
  store.annotationAudioBuffer.value = snap.audioBuffer;
  store.lastAudioBuffer.value = snap.audioBuffer;
  store.annotationAudioOffsetSmp.value = 0;
}

function performExciseSmpRange(cutStartSmp: number, cutEndSmp: number, label: string): boolean {
  const clip = activeClip.value;
  if (!clip) return false;
  const c0 = Math.max(0, Math.round(cutStartSmp));
  const c1 = Math.max(c0, Math.round(cutEndSmp));
  if (c1 - c0 < msToSamples(15)) {
    store.pushToast('剪切区间至少需 15 ms', 'info');
    return false;
  }
  annotationPlaybackIntent++;
  store.stopPlayback();
  const beforeAux = captureCutAuxSnapshot();

  const excised = exciseClipAndControlsRange(
    store.project.value,
    clip.id,
    c0,
    c1,
    store.annotationTractFrames.value,
  );
  if (!excised) return false;

  const cutStartSec = c0 / SAMPLE_RATE_HZ;
  const cutEndSec = c1 / SAMPLE_RATE_HZ;

  let nextRecording = loadedAnnotationRecording.value;
  let nextActiveAudio: AudioBuffer | null = store.annotationAudioBuffer.value;

  if (nextRecording) {
    const nextRawAudio = exciseAudioBufferRange(nextRecording.rawAudio, cutStartSec, cutEndSec);
    const nextCleanAudio = nextRecording.cleanAudio
      ? exciseAudioBufferRange(nextRecording.cleanAudio, cutStartSec, cutEndSec)
      : undefined;
    if (synthesisGainMode.value === 'peak') {
      applyPeakAudioGain(nextRawAudio);
      if (nextCleanAudio) applyPeakAudioGain(nextCleanAudio);
    }
    const nextFile = audioBufferFile(nextRawAudio, nextRecording.raw.name.replace(/\.[^.]+$/, ''));
    const nextGrid = nextRecording.uploadedTextGrid
      ? exciseTextGridRange(nextRecording.uploadedTextGrid, cutStartSec, cutEndSec)
      : null;
    nextRecording = {
      ...nextRecording,
      raw: nextFile,
      rawAudio: nextRawAudio,
      cleanAudio: nextCleanAudio,
      uploadedTextGrid: nextGrid,
    };
    nextActiveAudio = nextRecording.denoised && nextCleanAudio ? nextCleanAudio : nextRawAudio;
  } else if (nextActiveAudio) {
    nextActiveAudio = exciseAudioBufferRange(nextActiveAudio, cutStartSec, cutEndSec);
    if (synthesisGainMode.value === 'peak') applyPeakAudioGain(nextActiveAudio);
  }

  let nextSource = annotationSource.value;
  if (nextSource && nextSource.projectId === store.project.value.id && nextSource.baseline.id === clip.id) {
    const { rows: slicedRows } = exciseM27TrajectoryRange(nextSource.rows ?? [], null, cutStartSec, cutEndSec);
    nextSource = {
      ...nextSource,
      baseline: JSON.parse(JSON.stringify(excised.nextClip)),
      controls: JSON.stringify(currentAnnotationControls(excised.nextProject)),
      rows: slicedRows.length ? slicedRows : nextSource.rows,
    };
  }

  const afterAux: CutAuxSnapshot = {
    recording: nextRecording,
    source: nextSource,
    tractFrames: excised.nextTractFrames,
    playbackSource: nextRecording ? 'recording' : annotationPlaybackSource.value,
    audioBuffer: nextActiveAudio,
    editedAudio: null,
  };

  const res = store.executeCommand(
    {
      type: 'project.replace',
      label,
      payload: { project: excised.nextProject },
    },
    {
      localEdit: {
        undo: () => applyCutAuxSnapshot(beforeAux),
        redo: () => applyCutAuxSnapshot(afterAux),
      },
    },
  );
  if (!res.ok) return false;

  applyCutAuxSnapshot(afterAux);
  store.playheadSmp.value = Math.min(excised.nextClip.end_smp, c0);
  const firstSid = excised.nextClip.syllable_order[0] ?? '';
  store.selectedSyllableId.value = firstSid;
  const firstSeg = excised.nextClip.syllables[firstSid]?.segments[0];
  store.selectedPhonemeIds.value = firstSeg ? [firstSeg.id] : [];
  return true;
}

function onTimelineCutRange(payload: { startSmp: number; endSmp: number }): void {
  const ms = Math.round(samplesToMs(payload.endSmp - payload.startSmp));
  if (performExciseSmpRange(payload.startSmp, payload.endSmp, `剪切区间 (${ms} ms)`)) {
    store.pushToast(`已剪切删除 ${ms} ms 区间（可按 Ctrl+Z 撤销）`, 'success', 2600);
  }
}

function onTimelineTrimSilence(): void {
  const clip = activeClip.value;
  const audio = loadedAnnotationRecording.value
    ? (loadedAnnotationRecording.value.denoised && loadedAnnotationRecording.value.cleanAudio
        ? loadedAnnotationRecording.value.cleanAudio
        : loadedAnnotationRecording.value.rawAudio)
    : store.annotationAudioBuffer.value;
  const bounds = detectLeadingTrailingSilence({
    audioBuffer: audio,
    clip,
    grid: loadedAnnotationRecording.value?.uploadedTextGrid ?? null,
  });
  if (!bounds) {
    store.pushToast('未检测到超过 45 ms 的首尾可裁剪静音段', 'info', 2400);
    return;
  }
  annotationPlaybackIntent++;
  store.stopPlayback();
  const beforeAux = captureCutAuxSnapshot();
  let workingProject = store.project.value;
  let workingFrames = store.annotationTractFrames.value;
  let workingRawAudio = loadedAnnotationRecording.value?.rawAudio ?? null;
  let workingCleanAudio = loadedAnnotationRecording.value?.cleanAudio;
  let workingActiveAudio = store.annotationAudioBuffer.value;
  let workingGrid = loadedAnnotationRecording.value?.uploadedTextGrid ?? null;
  let workingRows = annotationSource.value?.rows ?? [];

  if (bounds.trailRemovedMs > 0 && clip) {
    const trailStartSec = bounds.keepEndSmp / SAMPLE_RATE_HZ;
    const trailEndSec = bounds.totalSmp / SAMPLE_RATE_HZ;
    const step1 = exciseClipAndControlsRange(workingProject, clip.id, bounds.keepEndSmp, bounds.totalSmp, workingFrames);
    if (step1) {
      workingProject = step1.nextProject;
      workingFrames = step1.nextTractFrames;
    }
    if (workingRawAudio) workingRawAudio = exciseAudioBufferRange(workingRawAudio, trailStartSec, trailEndSec);
    if (workingCleanAudio) workingCleanAudio = exciseAudioBufferRange(workingCleanAudio, trailStartSec, trailEndSec);
    if (!loadedAnnotationRecording.value && workingActiveAudio) {
      workingActiveAudio = exciseAudioBufferRange(workingActiveAudio, trailStartSec, trailEndSec);
    }
    if (workingGrid) workingGrid = exciseTextGridRange(workingGrid, trailStartSec, trailEndSec);
    if (workingRows.length) {
      workingRows = exciseM27TrajectoryRange(workingRows, null, trailStartSec, trailEndSec).rows;
    }
  }

  if (bounds.leadRemovedMs > 0 && clip) {
    const leadEndSec = bounds.keepStartSmp / SAMPLE_RATE_HZ;
    const step2 = exciseClipAndControlsRange(workingProject, clip.id, 0, bounds.keepStartSmp, workingFrames);
    if (step2) {
      workingProject = step2.nextProject;
      workingFrames = step2.nextTractFrames;
    }
    if (workingRawAudio) workingRawAudio = exciseAudioBufferRange(workingRawAudio, 0, leadEndSec);
    if (workingCleanAudio) workingCleanAudio = exciseAudioBufferRange(workingCleanAudio, 0, leadEndSec);
    if (!loadedAnnotationRecording.value && workingActiveAudio) {
      workingActiveAudio = exciseAudioBufferRange(workingActiveAudio, 0, leadEndSec);
    }
    if (workingGrid) workingGrid = exciseTextGridRange(workingGrid, 0, leadEndSec);
    if (workingRows.length) {
      workingRows = exciseM27TrajectoryRange(workingRows, null, 0, leadEndSec).rows;
    }
  }

  let nextRecording = loadedAnnotationRecording.value;
  if (nextRecording && workingRawAudio) {
    if (synthesisGainMode.value === 'peak') {
      applyPeakAudioGain(workingRawAudio);
      if (workingCleanAudio) applyPeakAudioGain(workingCleanAudio);
    }
    const nextFile = audioBufferFile(workingRawAudio, nextRecording.raw.name.replace(/\.[^.]+$/, ''));
    nextRecording = {
      ...nextRecording,
      raw: nextFile,
      rawAudio: workingRawAudio,
      cleanAudio: workingCleanAudio,
      uploadedTextGrid: workingGrid,
    };
    workingActiveAudio = nextRecording.denoised && workingCleanAudio ? workingCleanAudio : workingRawAudio;
  } else if (workingActiveAudio && synthesisGainMode.value === 'peak') {
    applyPeakAudioGain(workingActiveAudio);
  }

  let nextSource = annotationSource.value;
  if (nextSource && clip && nextSource.projectId === store.project.value.id && nextSource.baseline.id === clip.id) {
    const finalClip = workingProject.clips[clip.id];
    nextSource = {
      ...nextSource,
      baseline: JSON.parse(JSON.stringify(finalClip)),
      controls: JSON.stringify(currentAnnotationControls(workingProject)),
      rows: workingRows.length ? workingRows : nextSource.rows,
    };
  }

  const afterAux: CutAuxSnapshot = {
    recording: nextRecording,
    source: nextSource,
    tractFrames: workingFrames,
    playbackSource: nextRecording ? 'recording' : annotationPlaybackSource.value,
    audioBuffer: workingActiveAudio,
    editedAudio: null,
  };

  const label = `裁剪首尾静音 (首 ${bounds.leadRemovedMs} ms / 尾 ${bounds.trailRemovedMs} ms)`;
  const res = store.executeCommand(
    {
      type: 'project.replace',
      label,
      payload: { project: workingProject },
    },
    {
      localEdit: {
        undo: () => applyCutAuxSnapshot(beforeAux),
        redo: () => applyCutAuxSnapshot(afterAux),
      },
    },
  );
  if (!res.ok) return;

  applyCutAuxSnapshot(afterAux);
  store.playheadSmp.value = 0;
  store.pushToast(
    `已裁剪首部 ${bounds.leadRemovedMs} ms、尾部 ${bounds.trailRemovedMs} ms 静音（Ctrl+Z 可撤销）`,
    'success',
    2800,
  );
}

function openAnnotationInArranger(points?: { t_smp: number; f0_hz: number }[]): void {
  const clip = activeClip.value;
  if (!clip?.syllable_order.length) {
    store.pushToast('请先载入音节标注或编译文字', 'info');
    return;
  }
  const earlier = pendingPianoPitch.value;
  const projectId = store.project.value.id;
  if (!points) {
    pendingPianoPitch.value = null;
  } else {
    const samePitch = earlier && earlier.projectId === projectId && earlier.clipId === clip.id
      && earlier.startSmp === clip.start_smp && earlier.endSmp === clip.end_smp && earlier.points.length === points.length
      && points.every(({ t_smp, f0_hz }, i) => t_smp === earlier.points[i].t_smp && f0_hz === earlier.points[i].f0_hz);
    if (!samePitch) pendingPianoPitch.value = { projectId, clipId: clip.id, startSmp: clip.start_smp, endSmp: clip.end_smp, points };
  }
  arrangerSource.value = clip.id;
  arrangerStageOrigin.value = returnSource.value?.origin ?? null;
  arrangerStageTarget.value = returnSource.value?.target ?? null;
  store.studioTab.value = 'arranger';
  store.setWorkspace('studio');
}

function buildClipTextGridForHandoff(clip: Clip, durationSmp: number): TextGridDocument | undefined {
  if (!clip.syllable_order.length) return undefined;
  const clipStart = clip.start_smp ?? 0;
  const xmax = Math.max(0.02, Math.max(durationSmp, clip.end_smp - clipStart) / SAMPLE_RATE_HZ);
  const toSec = (smp: number) => Math.max(0, Math.min(xmax, (smp - clipStart) / SAMPLE_RATE_HZ));
  const buildIntervals = (spans: Array<{ xmin: number; xmax: number; text: string }>) => {
    const out: Array<{ xmin: number; xmax: number; text: string }> = [];
    let cursor = 0;
    for (const sp of spans) {
      const a = Math.max(cursor, sp.xmin);
      const b = Math.max(a, sp.xmax);
      if (a > cursor + 1e-5) out.push({ xmin: cursor, xmax: a, text: '' });
      if (b > a + 1e-5) {
        out.push({ xmin: a, xmax: b, text: sp.text });
        cursor = b;
      }
    }
    if (xmax > cursor + 1e-5) out.push({ xmin: cursor, xmax, text: '' });
    return out;
  };
  const sylSpans: Array<{ xmin: number; xmax: number; text: string }> = [];
  const phoneSpans: Array<{ xmin: number; xmax: number; text: string }> = [];
  for (const sid of clip.syllable_order) {
    const syl = clip.syllables[sid];
    if (!syl) continue;
    sylSpans.push({ xmin: toSec(syl.start_smp), xmax: toSec(syl.end_smp), text: syl.text || syl.ipa.join('') });
    for (const seg of syl.segments) {
      phoneSpans.push({ xmin: toSec(seg.start_smp), xmax: toSec(seg.end_smp), text: seg.ipa === 'sil' ? '' : seg.ipa });
    }
  }
  return {
    xmin: 0,
    xmax,
    tiers: [
      { kind: 'IntervalTier', name: 'syllables', xmin: 0, xmax, intervals: buildIntervals(sylSpans) },
      { kind: 'IntervalTier', name: 'phones', xmin: 0, xmax, intervals: buildIntervals(phoneSpans) },
    ],
  };
}

async function sendAnnotationAudio(target: AudioDestination): Promise<void> {
  const clip = activeClip.value;
  if (!clip || sendingAudio.value) return;
  const source = returnSource.value;
  const controls = currentAnnotationControls(store.project.value);
  const spans = source ? changedAudioSpans(source.baseline, clip, source.controls !== JSON.stringify(controls)) : 'whole';
  sendingAudio.value = true;
  try {
    const recording = loadedAnnotationRecording.value;
    const original = recording?.denoised ? recording.cleanAudio : recording?.rawAudio;
    const changed = spans === 'whole' || spans.length > 0;
    const chosenEdited = annotationPlaybackSource.value === 'edited' && Boolean(store.editedAnnotationAudio.value);
    const chosenRecording = annotationPlaybackSource.value === 'recording' && Boolean(original);
    const chosenSynthesis = annotationPlaybackSource.value === 'synthesis';
    const preserveRecording = (chosenEdited || chosenRecording) && Boolean(source) && !changed;
    let buffer: AudioBuffer | null = chosenEdited
      ? store.editedAnnotationAudio.value
      : chosenRecording
        ? (original ?? null)
        : null;
    let synthesis: SynthesisInfo | undefined;
    if (!buffer && original && !source && !chosenSynthesis) buffer = store.editedAnnotationAudio.value ?? original;
    if (!buffer) {
      const rendered = await renderCurrentAnnotation();
      if (!rendered || clip !== activeClip.value) return;
      if (original && spans !== 'whole' && !chosenSynthesis) {
        buffer = await replaceRenderedSpans(original, rendered.buffer, spans, clip.start_smp);
        if (synthesisGainMode.value === 'peak') applyPeakAudioGain(buffer);
      } else {
        buffer = rendered.buffer;
        synthesis = rendered.provenance;
      }
    }
    if (clip !== activeClip.value) return;
    const duration = Math.round(buffer.duration * SAMPLE_RATE_HZ);
    const sourceFrames = store.annotationTractFrames.value;
    const phones = allSegmentsFlat.value.map(({ seg }) => seg);
    const renderedFrames = phones.filter(seg => seg.params?.length === 19)
      .map(seg => ({ u: (seg.start_smp - clip.start_smp) / duration, params: [...seg.params!] }));
    const editedIds = new Set(collectEditedReferencePhoneIds(clip, source?.baseline));
    const changedPhones = phones.filter(phone => phone.params && editedIds.has(phone.id));
    const frames = synthesis?.tractFrames ?? (sourceFrames.length ? sourceFrames.map(frame => {
      const sample = clip.start_smp + Math.floor(frame.u * duration);
      const phone = changedPhones.find(seg => sample >= seg.start_smp && sample < seg.end_smp);
      return phone?.params ? { ...frame, params: [...phone.params] } : frame;
    }) : renderedFrames);
    const label = clip.source?.lyrics?.slice(0, 25) || recording?.raw.name.replace(/\.wav$/i,'') || '标注音频';
    const textGridForTarget = target === 'mixer'
      ? (recording?.uploadedTextGrid ?? buildClipTextGridForHandoff(clip, duration))
      : undefined;
    const alignmentTextForTarget = target === 'mixer'
      ? (g2pText.value.trim() || clip.source?.lyrics?.trim() || undefined)
      : undefined;
    sendWorkspaceAudio(target, {
      file: audioBufferFile(buffer, label),
      label,
      clip: { ...clip, annotation_controls: controls },
      frames,
      textGrid: textGridForTarget,
      alignmentText: alignmentTextForTarget,
      m27RowsPa: synthesis?.m27RowsPa ?? (preserveRecording ? source?.rows : undefined),
      sourceKind: chosenSynthesis ? 'ipa-synth' : 'audio-reconstruct',
      stageOrigin: target === 'studio' ? source?.origin : undefined,
      stageAudioTrack: target === 'studio' ? source?.target : undefined,
    });
  } catch (error) {
    store.pushToast(error instanceof Error ? error.message : '无法发送标注音频', 'warning');
  } finally {
    sendingAudio.value = false;
  }
}

const hasKanaPlaceholders = computed(() => Object.values(activeClip.value?.syllables ?? {}).some(needsKanaReading));
async function convertLegacyKana() {
  const clip = activeClip.value;
  if (!clip) return;
  try {
    const result = await resolveKanaPhones(clip, speakerModel.value);
    if (clip !== activeClip.value || result === clip) return;
    store.executeCommand({ type: 'clip.edit', label: '日语假名转 IPA', payload: { clip: result } });
    const selected = result.syllables[store.selectedSyllableId.value]?.segments[0];
    store.selectedPhonemeIds.value = selected ? [selected.id] : [];
  } catch (error) { store.pushToast(error instanceof Error ? error.message : '日语读音解析失败', 'warning'); }
}

async function receiveAnnotationAudio(): Promise<void> {
  const incoming = takeWorkspaceAudio('annotation');
  if (!incoming) return;
  const active = activeClip.value;
  try {
    const decoded = await decodeRecording(incoming.file);
    if (active !== activeClip.value) return;
    const clip: Clip = incoming.clip ? await resolveKanaPhones(incoming.clip, speakerModel.value) : {
      kind: 'audio' as const,
      id: store.activeClipId.value,
      start_smp: 0,
      end_smp: Math.round(decoded.duration * SAMPLE_RATE_HZ),
      syllable_order: [],
      syllables: {},
    };
    if (active !== activeClip.value) return;
    const track = (incoming.frames ?? []).filter((frame) => Number.isFinite(frame.u)
      && frame.params.length === 19 && frame.params.every(Number.isFinite)).sort((a, b) => a.u - b.u);
    const next: Clip = {
      ...(incoming.stageOrigin && incoming.clip ? clip : withImportedTractFrames(clip, track)),
      id: incoming.stageOrigin ? 'annotation_' + crypto.randomUUID() : store.activeClipId.value,
      voice_id: clip.voice_id ?? store.activeVoiceId.value,
      variants: ['original', 'synth'],
      active_variant: 'original',
    };
    const cmds: WorkbenchCommand[] = [
      {
        type: 'clip.edit',
        label: `载入 ${incoming.label ?? incoming.file.name}`,
        payload: { clip: next, resetAnnotation: !incoming.stageOrigin, switchAnnotation: !!incoming.stageOrigin },
      },
    ];
    if (!incoming.stageOrigin && incoming.m27RowsPa && incoming.m27RowsPa.length >= 2) {
      const maxSmp = Math.max(msToSamples(60), next.end_smp);
      const validF0Pts = extractValidM27F0Points(incoming.m27RowsPa, maxSmp);
      if (validF0Pts.length >= 2) {
        cmds.push({
          type: 'f0.draw',
          payload: {
            id: `m27-${next.id}`,
            points: validF0Pts,
          },
        });
      }
    }
    const result = store.executeCommand(
      cmds.length === 1
        ? cmds[0]
        : { type: 'batch', label: `载入 ${incoming.label ?? incoming.file.name}`, payload: { commands: cmds } },
    );
    if (!result.ok) return;
    store.activeClipId.value = next.id;
    let resolvedSpkB64 = incoming.speakerWavBase64;
    if (!resolvedSpkB64 && incoming.sourceKind === 'audio-reconstruct') {
      try {
        resolvedSpkB64 = await blobToBase64(incoming.file);
      } catch {
        resolvedSpkB64 = undefined;
      }
    }
    annotationSource.value = {
      projectId: store.project.value.id, baseline: JSON.parse(JSON.stringify(next)),
      controls: JSON.stringify(currentAnnotationControls(store.project.value)),
      origin: incoming.stageOrigin, target: incoming.stageAudioTrack, rows: incoming.m27RowsPa,
      speakerWavBase64: resolvedSpkB64,
    };
    store.clearAnnotationAudio();
    store.annotationTractFrames.value = track;
    loadedAnnotationRecording.value = {
      raw: incoming.file,
      rawAudio: decoded,
      denoised: false,
      uploadedTextGrid: incoming.textGrid ?? null,
      uploadedTextGridName: incoming.textGrid ? `${incoming.label ?? incoming.file.name}.TextGrid` : undefined,
    };
    showRecordingVersion(false);
    const focus = Math.max(0, Math.min(next.end_smp - 1, incoming.annotationFocusSmp ?? 0));
    const syllableId = next.syllable_order.find(id => {
      const syllable = next.syllables[id];
      return syllable.start_smp <= focus && focus < syllable.end_smp;
    }) ?? next.syllable_order[0] ?? '';
    store.selectedSyllableId.value = syllableId;
    const segments = next.syllables[syllableId]?.segments ?? [];
    const segment = segments.find(item => item.start_smp <= focus && focus < item.end_smp) ?? segments[0];
    store.selectedPhonemeIds.value = segment ? [segment.id] : [];
    store.playheadSmp.value = focus;
    g2pText.value = incoming.clip?.source?.lyrics ?? clip.syllable_order.map(id => clip.syllables[id].text).join('');
    const transferId = `transfer_${Date.now()}`;
    corpusDragFileRegistry.set(transferId, incoming.file);
    localFiles.value = [{
      id: transferId, name: incoming.file.name, relativePath: incoming.file.name, ext: 'wav',
      sizeKb: Math.max(1, Math.round(incoming.file.size / 1024)), file: incoming.file,
    }, ...localFiles.value.filter(f => f.relativePath !== incoming.file.name)];
    store.pushToast(`已载入 ${incoming.label ?? incoming.file.name}`, 'success');
  } catch {
    store.pushToast('无法解码发送到标注工作台的音频', 'warning');
  }
}

const MAIN_TOUR_VOQS_DEMO = '今天天气真好。What a gorgeous day! 今日はいい天気ですね。 [ˈnɔ˞məl ˈvɔɪs. {F fɔlˈsɛtʰoʊ F}. {W ˈwɪspʰəɹʷi W}]';
let mainTourUnmounted = false;

async function handleMainTourAction(e: Event): Promise<void> {
  const detail = (e as CustomEvent<{ actionId?: string; done?: (ok?: boolean) => void }>).detail;
  if (detail?.actionId === 'main-toggle-corpus-drawer') {
    corpusDrawerOpen.value = !corpusDrawerOpen.value;
    if (!corpusDrawerOpen.value) corpusDragging.value = false;
    detail?.done?.(true);
    return;
  }
  if (detail?.actionId === 'main-toggle-tract-params') {
    corpusDrawerOpen.value = false;
    tractParamsOpen.value = !tractParamsOpen.value;
    detail?.done?.(true);
    return;
  }
  if (detail?.actionId !== 'main-compile-voqs-demo') return;
  try {
    if (store.isPlaying.value) store.stopPlayback();
    if (selectedDictionary.value) {
      g2pStandard.value = dictionaryPrefs.value.zhStandard;
    }
    g2pText.value = MAIN_TOUR_VOQS_DEMO;
    annotationPlaybackSource.value = 'synthesis';
    await nextTick();
    await compileG2pToTrack();
    if (mainTourUnmounted) {
      detail?.done?.(false);
      return;
    }
    store.playheadSmp.value = activeClip.value?.start_smp ?? 0;
    await nextTick();
    await toggleTransportPlay();
    store.pushToast('已填入中英日与 IPA/VoQS 示例并开始分句合成试听', 'success', 3200);
    detail?.done?.(true);
  } catch (err) {
    if (!mainTourUnmounted) {
      store.pushToast(err instanceof Error ? err.message : '编译或合成示例失败，请确认本地引擎已就绪', 'warning', 3200);
    }
    detail?.done?.(false);
  }
}

onMounted(() => {
  mainTourUnmounted = false;
  document.addEventListener('pointerdown', onGlobalPopoverDown, true);
  window.addEventListener('keydown', onSynthesisPageKeyDown);
  window.addEventListener('vocalcut:annotation-play', toggleTransportPlay);
  window.addEventListener('vocalcut:tour-action', handleMainTourAction);
  void loadCorpusDirectory('restore');
  void receiveAnnotationAudio();
  void loadCmu()
    .then((lex) => {
      cmuLexicon.value = lex;
      runG2pReview();
    })
    .catch(() => {
      runG2pReview();
    });
  void preloadPtbIpaPresets(speakerModel.value);
  void loadDefaultIpaPoses();
  void loadSpeakerVowelReferences(speakerModel.value);
  if (!store.currentTractState.value) {
    void store.requestVtlPose();
  }
  schedulePhysicsCharts();
});

watchEffect(() => {
  const clip = activeClip.value ?? null;
  const recording = annotationPlaybackSource.value === 'recording' ? loadedAnnotationRecording.value : null;
  const edited = annotationPlaybackSource.value === 'edited' ? store.editedAnnotationAudio.value : null;
  const render = followingSynthesis.value ? displayedAnnotationRender.value : undefined;
  const audioBuffer =
    edited ?? (recording?.denoised ? recording.cleanAudio : undefined) ?? recording?.rawAudio ?? render?.buffer ?? null;
  publishPanelSnapshot('synthesis', {
    lyrics: g2pText.value,
    standardLabel: activeDictButtonLabel.value,
    clip,
    audioBuffer,
    startSmp: edited || recording ? store.annotationAudioOffsetSmp.value : render?.start ?? clip?.start_smp ?? 0,
    tractFrames: displayedTractFrames.value ?? [],
    m27RowsPa: render?.provenance?.m27RowsPa ?? returnSource.value?.rows,
  });
});

onBeforeUnmount(() => {
  mainTourUnmounted = true;
  document.removeEventListener('pointerdown', onGlobalPopoverDown, true);
  window.removeEventListener('keydown', onSynthesisPageKeyDown);
  corpusDirectoryTask?.abort();
  quickAuditionRequest?.abort();
  vowelRequest?.abort();
  trajectoryPrefetchAbort?.abort();
  vowelDragCleanup?.();
  crossPointerCleanup?.();
  window.cancelAnimationFrame(sectionFrameId);
  window.cancelAnimationFrame(sliderPoseFrameId);
  window.removeEventListener('vocalcut:annotation-play', toggleTransportPlay);
  window.removeEventListener('vocalcut:tour-action', handleMainTourAction);
  window.cancelAnimationFrame(quadFrameId);
  window.clearTimeout(vowelTrailTimer);
});
</script>

<template>
  <div class="rm-shell" @click="blurToolbarButtonOnMouseClick">
    <!-- Always-mounted hidden file pickers for top-bar Open File & Corpus Drawer -->
    <input
      ref="openFileInputRef"
      type="file"
      multiple
      accept=".wav,.mp3,.ogg,.flac,.m4a,.aac,.webm,.TextGrid,.textgrid,.vcproj,.json"
      class="hidden"
      @change="(e) => { const el = e.target as HTMLInputElement; if (el.files) void ingestFiles(el.files, { autoLoadDirect: true }); el.value = ''; }"
    />
    <input
      ref="fileInputRef"
      type="file"
      multiple
      accept=".wav,.mp3,.ogg,.flac,.m4a,.aac,.webm,.TextGrid,.textgrid,.vcproj,.json"
      class="hidden"
      @change="(e) => { const el = e.target as HTMLInputElement; if (el.files) void ingestFiles(el.files); el.value = ''; }"
    />
    <input
      ref="dirInputRef"
      type="file"
      webkitdirectory
      multiple
      class="hidden"
      @change="(e) => { const el = e.target as HTMLInputElement; if (el.files) void ingestFiles(el.files); el.value = ''; }"
    />

    <!-- Compact Global Workstation Subbar -->
    <div class="subbar rm-global-bar" data-tour="main-topbar">
      <div class="subbar-group rm-proj-summary">
        <div class="rm-file-tools" data-tour="main-file-tools">
          <button
            type="button"
            class="btn sm"
            title="选择本地音频、TextGrid 或 .vcproj 工程并直接载入时间轴"
            @click="openFileInputRef?.click()"
          >
            <IconSvg name="upload" :size="12" />
            <span>打开文件</span>
          </button>

          <button
            type="button"
            class="btn sm"
            data-tour="main-files"
            :class="{ active: corpusDrawerOpen }"
            :aria-expanded="corpusDrawerOpen"
            aria-controls="rm-corpus-drawer"
            title="展开或收起左侧语料目录抽屉（支持多级文件夹、检索、双击或拖拽上轨）"
            @click="corpusDrawerOpen = !corpusDrawerOpen"
          >
            <IconSvg name="folder-open" :size="12" />
            <span>语料目录</span>
            <span v-if="localFiles.length" class="mono rm-corpus-badge">{{ localFiles.length }}</span>
            <i
              v-if="corpusDirectoryNeedsPermission"
              class="rm-corpus-perm-dot"
              title="上次语料目录待授权恢复"
              aria-hidden="true"
            />
          </button>
        </div>

        <span class="tree-tag mono">{{ speakerModel }}</span>
        <span class="muted">{{ activeClip?.syllable_order.length ?? 0 }} 个音节</span>
        <span v-if="playheadScrubActive && activeClip" class="metric-chip" title="正在按时间轴播放头实时显示该帧舌位与声学特征（点击音素块或直接拖动声道控制点可切回编辑模式）">
          播放头 <strong class="mono">{{ (store.playheadSmp.value / SAMPLE_RATE_HZ).toFixed(2) }}s</strong>
          <strong v-if="playheadSegmentEntry && playheadSegmentEntry.seg.role !== 'rest' && playheadSegmentEntry.seg.ipa !== 'sil'" class="ipa notranslate" translate="no">[{{ playheadSegmentEntry.seg.ipa }}]</strong>
          <span v-else class="muted">静音</span>
        </span>
        <span v-else-if="primarySelectedEntry" class="metric-chip">
          当前音素 <strong class="ipa notranslate" translate="no">[{{ primarySelectedEntry.seg.ipa }}]</strong>
        </span>
      </div>

      <div style="margin-left: auto" class="subbar-group">
        <CustomSelect v-model="annotationRenderMode" :options="annotationModes" size="sm"
          aria-label="标注合成音源" class="rm-synth-sel"
          title="全局合成音源（与声道重建及工作室同步）：神经合成使用 JD2 几何，VTL 运行物理声管。" />
        <SpeakerReferenceSelect v-if="annotationRenderMode === 'neural'" class="rm-speaker-reference" />
        <span v-else class="muted" title="VTL 物理声管运行在本机 CPU">CPU</span>

        <button
          ref="sendMenuBtnRef"
          type="button"
          class="btn sm"
          :class="{ active: sendMenuOpen }"
          :disabled="sendingAudio"
          aria-haspopup="menu"
          :aria-expanded="sendMenuOpen"
          @click="toggleSendAudioMenu"
        >
          <IconSvg name="send" :size="12" />
          <span>{{ sendingAudio ? '发送中…' : '发送音频' }}</span>
          <IconSvg name="chevron-down" :size="11" />
        </button>

        <button
          type="button"
          class="btn sm"
          title="查看导出格式与说明"
          @click="store.openExportModal('research')"
        >
          <IconSvg name="download" :size="12" />
          <span>导出</span>
        </button>

        <ModuleGuideButton module-id="main" size="sm" data-tour="main-guide-btn" />
      </div>
    </div>

    <!-- Main Workspace: 3-Column Bottom-Aligned Upper Deck + 100% Full-Width Lower Timeline -->
    <div class="rm-workspace-body">
      <!-- On-Demand Slide-Over Corpus Directory Drawer -->
      <div
        v-if="corpusDrawerOpen"
        class="rm-corpus-drawer-mask"
        :class="{ dragging: corpusDragging }"
        aria-hidden="true"
        @click="corpusDrawerOpen = false; corpusDragging = false"
      />
      <aside
        v-if="corpusDrawerOpen"
        id="rm-corpus-drawer"
        class="panel rm-corpus-drawer"
        :class="{ 'drop-active': dropActive }"
        role="region"
        aria-label="语料目录"
        @dragover="onCorpusDragOver"
        @dragleave="onCorpusDragLeave"
        @drop.prevent="onFileDrop"
      >
        <div class="p-head">
          <span>语料目录 <small v-if="localFiles.length" class="muted mono">({{ localFiles.length }})</small></span>
          <div class="rm-head-acts">
            <button type="button" class="btn xs" title="添加本地音频 / TextGrid / .vcproj 至语料目录" @click="fileInputRef?.click()">
              <IconSvg name="upload" :size="11" />
              <span>文件</span>
            </button>
            <button type="button" class="btn xs" title="添加多级语料文件夹至目录树"
              :disabled="corpusDirectoryLoading" @click="loadCorpusDirectory('pick')">
              <IconSvg name="folder" :size="11" />
              <span>目录</span>
            </button>
            <button v-if="localFiles.length || savedCorpusDirectory" type="button" class="btn xs icon-only"
              aria-label="清空语料目录" title="清空语料列表并忘记上次目录" @click="clearCorpusList">
              <IconSvg name="trash" :size="11" />
            </button>
            <button type="button" class="btn xs icon-only" aria-label="收起语料目录" title="收起语料目录 (Esc)"
              @click="corpusDrawerOpen = false; corpusDragging = false">
              <IconSvg name="close" :size="11" />
            </button>
          </div>
        </div>
        <div v-if="localFiles.length > 0" class="rm-corpus-search">
          <IconSvg name="search" :size="11" class="muted" />
          <input
            v-model="corpusSearch"
            type="text"
            class="inp rm-corpus-search-inp"
            placeholder="搜索文件名或子目录…"
            aria-label="搜索语料目录文件"
          />
          <button v-if="corpusSearch" type="button" class="btn xs icon-only" aria-label="清除搜索" @click="corpusSearch = ''">
            <IconSvg name="close" :size="10" />
          </button>
        </div>
        <div class="p-body rm-file-list">
          <div v-if="corpusDirectoryLoading" class="rm-drop-hint muted" role="status">正在读取语料目录…</div>
          <div v-else-if="corpusDirectoryNeedsPermission" class="rm-drop-hint">
            <p class="muted">允许访问「{{ savedCorpusDirectory?.name }}」后即可恢复上次的语料目录。</p>
            <button type="button" class="btn xs" @click="loadCorpusDirectory('authorize')">恢复上次目录</button>
          </div>
          <div v-else-if="!localFiles.length" class="rm-corpus-empty">
            <IconSvg name="folder-open" :size="28" />
            <strong>{{ dropActive ? '松开即可导入' : '拖放文件或文件夹到这里' }}</strong>
            <p class="muted">音频、TextGrid 或 .vcproj 工程</p>
            <div class="rm-corpus-empty-acts">
              <button type="button" class="btn sm" @click="fileInputRef?.click()">
                <IconSvg name="upload" :size="12" />添加文件
              </button>
              <button type="button" class="btn sm" :disabled="corpusDirectoryLoading" @click="loadCorpusDirectory('pick')">
                <IconSvg name="folder" :size="12" />打开目录
              </button>
            </div>
          </div>
          <div v-else class="rm-drop-hint muted">
            拖到下方时间轴或双击文件即可载入
          </div>
          <template v-for="row in visibleCorpusRows" :key="row.key">
            <button
              v-if="row.kind === 'folder'"
              type="button"
              class="rm-tree-folder"
              :style="{ paddingLeft: `${6 + row.depth * 13}px` }"
              @click="toggleCorpusFolder(row.path)"
            >
              <IconSvg :name="row.expanded ? 'chevron-down' : 'chevron-right'" :size="11" />
              <IconSvg name="folder" :size="13" />
              <span class="rm-file-name">{{ row.name }}</span>
              <span class="mono tree-tag">{{ row.childCount }}</span>
            </button>
            <div
              v-else-if="row.item"
              class="rm-file-row"
              :class="{ active: selectedCorpusId === row.item.id }"
              :style="{ paddingLeft: `${8 + row.depth * 13}px` }"
              draggable="true"
              role="button"
              tabindex="0"
              :title="`${row.item.relativePath} (${row.item.sizeKb} KB) · 拖拽至下方时间轴解码上轨（双击也可直接上轨）`"
              @dragstart="corpusDragging = true; onCorpusItemDragStart(row.item, $event)"
              @dragend="corpusDragging = false"
              @click="onCorpusRowClick(row.item)"
              @dblclick="onCorpusRowDblClick(row.item)"
              @keydown.enter="onCorpusRowDblClick(row.item)"
            >
              <IconSvg :name="row.item.ext === 'textgrid' ? 'layers' : row.item.ext === 'vcproj' ? 'file' : 'waveform'" :size="13" />
              <span class="rm-file-name">{{ row.item.name }}</span>
              <span class="mono tree-tag">{{ row.item.ext || 'file' }}</span>
            </div>
          </template>
        </div>
      </aside>

      <!-- Upper 3-Column Row (Strictly Bottom-Aligned: IPA Quick-Replace | Vocal Tract | 4-Panel Acoustics) -->
      <div class="rm-upper-row">
        <!-- Column 1: Full-Height IPA Quick-Replace Panel -->
        <aside class="panel rm-ipa-quick" data-tour="main-ipa-quick" :style="{ width: `${leftW}px` }">
          <div class="p-head">
            <span>音素替换</span>
            <button
              type="button"
              class="btn xs"
              title="展开 655 条目国际音标表 Plus"
              @click="store.researchTab.value = 'ipa'"
            >
              <span>完整音标表</span>
            </button>
          </div>
          <div class="rm-ipa-tabs">
            <div class="seg" role="group" aria-label="音素替换分类">
              <button
                type="button"
                :class="{ active: quickTab === 'vowel' }"
                :aria-pressed="quickTab === 'vowel'"
                @click="quickTab = 'vowel'"
              >
                元音
              </button>
              <button
                type="button"
                :class="{ active: quickTab === 'consonant' }"
                :aria-pressed="quickTab === 'consonant'"
                @click="quickTab = 'consonant'"
              >
                辅音
              </button>
              <button
                type="button"
                :class="{ active: quickTab === 'diacritic' }"
                :aria-pressed="quickTab === 'diacritic'"
                @click="quickTab = 'diacritic'"
              >
                附加符号
              </button>
              <button
                type="button"
                :class="{ active: quickTab === 'favorites' }"
                :aria-pressed="quickTab === 'favorites'"
                @click="quickTab = 'favorites'"
              >
                收藏
              </button>
            </div>
          </div>
          <div class="rm-ipa-grid" @mouseleave="hoveredQuickIpa = null">
            <span v-if="quickTab === 'favorites' && !filteredQuickIpa.length" class="rm-ipa-empty muted">可在完整音标表收藏此处支持的音标</span>
            <template v-for="group in quickGroups" :key="group.label">
              <div v-if="quickTab === 'consonant'" class="rm-manner">{{ group.label }}</div>
              <button
                v-for="it in group.items"
                :key="it.entryId ?? it.symbol"
                type="button"
                class="rm-ipa-cell ipa notranslate"
                translate="no"
                :class="{
                  active: quickSelectedKey === quickIpaKey(it.symbol),
                  preview: hoveredQuickIpa?.symbol === it.symbol && quickSelectedKey !== quickIpaKey(it.symbol),
                }"
                :title="quickIpaTitle(it)"
                @mouseenter="hoveredQuickIpa = it"
                @focus="hoveredQuickIpa = it"
                @blur="hoveredQuickIpa = null"
                @click="replaceSelectedWithIpa(it, $event)"
              >
                {{ it.display ?? it.symbol }}
              </button>
            </template>
          </div>
          <div class="rm-ipa-foot">
            <span
              class="rm-ipa-mode-tag"
              :class="{
                replace: !!hoveredQuickIpa,
                current: !hoveredQuickIpa && quickSelectedKey === quickIpaKey(displayQuickIpa.symbol),
              }"
            >
              {{
                displayQuickIpa.category === 'diacritic'
                  ? (primarySelectedEntry ? '叠加符号' : '复制符号')
                  : hoveredQuickIpa
                    ? (primarySelectedEntry ? '点击替换' : '复制符号')
                    : quickSelectedKey === quickIpaKey(displayQuickIpa.symbol)
                      ? '当前音素'
                      : '快速预览'
              }}
            </span>
            <span
              class="rm-ipa-desc"
              :title="quickIpaTitle(displayQuickIpa)"
            >
              <strong class="ipa notranslate" translate="no">[{{ displayQuickIpa.display ?? displayQuickIpa.symbol }}]</strong>
              {{ displayQuickIpa.nameZh }}
            </span>
            <button
              v-if="displayQuickIpa.category !== 'diacritic'"
              type="button"
              class="btn xs"
              :title="displayQuickIpa.category === 'vowel'
                ? `试听单元音 [${displayQuickIpa.symbol}]`
                : `试听 [a${displayQuickIpa.symbol}a]`"
              :aria-busy="quickAuditionBusy"
              :disabled="quickAuditionBusy"
              @click="auditionQuickIpa(displayQuickIpa)"
            >
              <IconSvg name="volume" :size="11" />
              <span>{{ displayQuickIpa.category === 'vowel' ? '/V/' : '/aCa/' }}</span>
            </button>
            <span v-if="displayedQuickSource" class="rm-ipa-source muted" role="status">{{ displayedQuickSource }}</span>
          </div>
        </aside>

        <SplitPane
          v-model="leftW"
          direction="vertical"
          :min="200"
          :max="360"
          :default-value="248"
          storage-key="research-left"
        />

        <!-- Columns 2 & 3 Pair: Vocal Tract Viewport (+ Plan A 19-D Side Drawer) | 4-Panel Acoustics -->
        <div ref="upperRightPairRef" class="rm-upper-right-pair">
          <!-- Column 2: 2D/3D Interactive Vocal Tract Viewport + On-Demand 19-D Parameters Drawer -->
          <div class="panel rm-tract-panel" data-tour="main-tract" :style="{ width: `${tractPaneW}px` }">
            <div class="p-head">
              <span>声道剖面</span>
              <div class="rm-head-acts">
                <button v-if="displayedTractFrames?.length" type="button" class="btn xs"
                  :class="{ active: followImportedTract }" :aria-pressed="followImportedTract"
                  title="按播放头查看当前音源的声道轨迹"
                  @click="followImportedTract = !followImportedTract">{{ followingSynthesis ? '合成轨迹' : '录音轨迹' }}</button>
                <span v-if="SPEAKER_OPTIONS.length <= 1" class="tree-tag mono" title="VTL 说话人解剖模型">
                  {{ speakerModel }}
                </span>
                <CustomSelect
                  v-else
                  v-model="speakerModel"
                  :options="SPEAKER_OPTIONS"
                  size="xs"
                  title="VTL 说话人解剖模型"
                  class="rm-spk-sel"
                />
                <button type="button" class="btn xs" :class="{ active: showLabels }" @click="showLabels = !showLabels">
                  器官标注
                </button>
                <button type="button" class="btn xs" :class="{ active: showTractGrid }" @click="showTractGrid = !showTractGrid">
                  网格
                </button>
                <button type="button" class="btn xs" :disabled="!store.currentTractState.value" :class="{ active: showHead && store.currentTractState.value }" @click="showHead = !showHead">
                  头部
                </button>
                <button
                  type="button"
                  class="btn xs"
                  data-tour="main-inspector"
                  :class="{ active: tractParamsOpen }"
                  :aria-expanded="tractParamsOpen"
                  title="展开或收起 19 维声道解剖精调滑杆（支持实时预览）"
                  @click="tractParamsOpen = !tractParamsOpen"
                >
                  <IconSvg name="sliders" :size="11" />
                  <span>精调参数</span>
                </button>
                <button
                  type="button"
                  class="btn xs"
                  :disabled="followImportedTract || store.isPlaying.value"
                  :title="primarySelectedEntry ? `恢复 [${primarySelectedEntry.seg.ipa}] 的标准 IPA 声道构型` : '恢复默认 [ə] 标准 IPA 声道构型'"
                  @click="playheadScrubActive = false; resetSelectedPhonemePose()"
                >
                  复位
                </button>
              </div>
            </div>

            <div class="rm-tract-stage">
              <div class="rm-tract-wrap">
                <VocalTractViewport
                  :section-index="activeSectionIdx"
                  :pose-preview="crossGripDragging"
                  :playing="store.isPlaying.value"
                  :pause-updates="keyframeModalOpen"
                  :params="activeScrubTractParams ?? inspectorParams"
                  :state="activeScrubTractParams ? importedDisplayedPose : null"
                  :extras="pendingExtras ?? store.currentTractExtras.value"
                  :interactive="!followImportedTract && !store.isPlaying.value"
                  :show-labels="showLabels"
                  :show-grid="showTractGrid"
                  :show-head="showHead"
                  @update:params="onViewportTractUpdate"
                  @update:extras="onViewportExtrasUpdate"
                  @drag-end="onViewportDragEnd"
                  @pose-resolved="acceptViewportPose"
                />
              </div>

              <!-- Plan A: On-Demand 19-D Articulatory Parameter Drawer inside Vocal Tract Card -->
              <aside v-if="tractParamsOpen" class="rm-tract-params-drawer" aria-label="声道 19 维精调参数">
                <div class="rm-tract-params-head">
                  <span class="rm-tract-params-title">
                    构型精调
                    <small v-if="primarySelectedEntry" class="mono ipa notranslate" translate="no">
                      [{{ primarySelectedEntry.seg.ipa }}]
                    </small>
                  </span>
                  <button
                    type="button"
                    class="btn xs icon-only"
                    aria-label="收起精调参数"
                    title="收起精调参数"
                    @click="tractParamsOpen = false"
                  >
                    <IconSvg name="close" :size="11" />
                  </button>
                </div>

                <div class="rm-tract-params-body">
                  <div v-if="followImportedTract" class="rm-tract-readonly-note">
                    当前正在跟随轨迹预览，关闭上方「{{ followingSynthesis ? '合成轨迹' : '录音轨迹' }}」后可手动微调构型。
                  </div>
                  <fieldset class="rm-tract-fieldset" :disabled="followImportedTract || store.isPlaying.value">
                    <div class="param-grid-2">
                      <CompactSlider
                        v-for="meta in core6Meta"
                        :key="meta.key"
                        :label="meta.label"
                        :model-value="inspectorParams[meta.key]"
                        :min="meta.min"
                        :max="meta.max"
                        :step="meta.step"
                        :default-value="meta.defaultVal"
                        @update:model-value="(v) => onSliderTractInput(meta.key, v)"
                        @change="(v) => onSliderTractCommit(meta.key, v)"
                      />
                    </div>

                    <details class="adv-box">
                      <summary>其余 13 维精细解剖参数 (HX–TS3)</summary>
                      <div class="param-grid-2" style="margin-top: 6px">
                        <CompactSlider
                          v-for="meta in extra13Meta"
                          :key="meta.key"
                          :label="meta.label"
                          :model-value="inspectorParams[meta.key]"
                          :min="meta.min"
                          :max="meta.max"
                          :step="meta.step"
                          :default-value="meta.defaultVal"
                          @update:model-value="(v) => onSliderTractInput(meta.key, v)"
                          @change="(v) => onSliderTractCommit(meta.key, v)"
                        />
                      </div>
                    </details>
                  </fieldset>
                </div>

                <div class="rm-tract-params-foot">
                  <button
                    type="button"
                    class="btn xs"
                    style="width: 100%"
                    :disabled="Boolean(importedTractParams)"
                    @click="resetSelectedPhonemePose"
                  >
                    <IconSvg name="refresh" :size="11" />
                    <span>{{ primarySelectedEntry ? `恢复 [${primarySelectedEntry.seg.ipa}] 标准构型` : '恢复默认 [ə] 标准构型' }}</span>
                  </button>
                </div>
              </aside>
            </div>
          </div>

          <SplitPane
            v-model="tractPaneW"
            direction="vertical"
            :min="Math.min(340, Math.round(Math.max(640, upperPairWidth - 6) * 0.3))"
            :max="Math.max(340, Math.max(640, upperPairWidth - 6) - Math.min(440, Math.round(Math.max(640, upperPairWidth - 6) * 0.36)))"
            :default-value="Math.round(Math.max(640, upperPairWidth - 6) * 0.44)"
            title="拖动调整声道剖面与声学分析宽度，双击恢复默认比例"
          />

          <!-- Column 3: 2x2 PTB Scientific Physics & Acoustic Vowel Space Quad (All 4 Expanded by Default) -->
          <div class="panel rm-trio-panel" data-tour="main-trio">
            <div class="p-head">
              <span>声学分析 <small class="rm-source">{{ liveSnapshot ? importedTractParams ? followingSynthesis ? '合成构型' : '反演构型' : store.currentTractState.value ? '实时构型' : 'W02 参考样本' : '等待构型' }}</small></span>
              <div class="rm-head-acts">
                <span class="mono metric-chip">
                  {{ spectrumReadout.peaks.slice(0, 3).map((hz, i) => spectrumReadout.prefix + (i + 1) + ' ' + Math.round(hz)).join(' · ') || '暂无峰值' }}{{ spectrumReadout.peaks.length ? ' Hz' : '' }}
                </span>
                <button
                  type="button"
                  class="btn xs mono"
                  title="切换传递函数高频上限 (5 kHz / 8 kHz)"
                  @click="hfMaxHz = hfMaxHz === 5000 ? 8000 : 5000"
                >
                  {{ hfMaxHz / 1000 }} kHz
                </button>
              </div>
            </div>

            <div class="acoustic-card-switches" role="group" aria-label="声学分析卡片">
              <button
                v-for="card in acousticCards"
                :key="card.id"
                type="button"
                class="btn xs"
                :class="{ active: openAcousticCards.has(card.id) }"
                :aria-pressed="openAcousticCards.has(card.id)"
                :aria-controls="'acoustic-' + card.id"
                :title="card.title"
                @click="toggleAcousticCard(card.id)"
              >{{ card.label }}</button>
              <button
                type="button"
                class="btn xs acoustic-open-all"
                :disabled="openAcousticCards.size === acousticCards.length"
                @click="openAllAcousticCards"
              >全部展开</button>
            </div>
            <div class="rm-trio-grid" :data-open-count="openAcousticCards.size" :style="{ '--acoustic-font-scale': acousticFontScale }">
              <p v-if="!openAcousticCards.size" class="acoustic-empty muted">从上方选择要展开的卡片</p>
              <!-- Quad 1 (Top-Left): PTB A(x) Vocal Tract Area Function -->
              <div v-if="openAcousticCards.has('area')" id="acoustic-area" class="trio-card sci-plane acoustic-plot">
                <div class="trio-hdr">
                  <span class="trio-lbl">A(x) 声道面积函数</span>
                  <span v-if="effectiveAminCm2 !== null && activeSectionPosCm !== null" class="mono trio-val" :class="{ danger: effectiveAminCm2 < 0.16 }">
                    Amin {{ effectiveAminCm2.toFixed(2) }} cm² · @{{ activeSectionPosCm.toFixed(1) }}cm
                  </span>
                </div>
                <div class="quad-stage">
                  <canvas
                    ref="areaCanvasRef"
                    class="quad-canvas quad-area-canvas"
                    title="点击或拖拽可实时扫描声道截面位置 · 双击恢复自动追踪 Amin（实线=几何面积 · 虚线=声学修正管）"
                    @pointerdown="onAreaPointerDown"
                    @dblclick="userPinnedSection = false; drawAllPhysicsQuadCharts()"
                  />
                </div>
                <div v-if="areaSummary" class="quad-legend">
                  <span><i class="key-line" />几何面积</span>
                  <span><i class="key-line dashed" />声学管</span>
                </div>
              </div>

              <!-- Quad 2 (Top-Right): PTB H(f) Model Transfer Function -->
              <div v-if="openAcousticCards.has('transfer')" id="acoustic-transfer" class="trio-card sci-plane acoustic-plot">
                <div class="trio-hdr">
                  <span class="trio-lbl">H(f) 声道传递函数</span>
                  <span class="trio-legend-tag">
                    {{ lipFront.nasalOpen ? '鼻腔耦合' : '模型传递函数' }}
                  </span>
                </div>
                <div class="quad-stage">
                  <canvas ref="spectrumCanvasRef" class="quad-canvas" aria-label="声道传递函数" />
                </div>
                <div class="quad-legend" aria-label="声道传递函数图例">
                  <span title="软腭闭合时的口腔声道共振峰 (F1, F2…)"><i class="key-line dashed key-formant" />F 共振峰</span>
                  <span title="口鼻耦合时的声道传递谱峰 (P1, P2…)"><i class="key-line dashed key-nasal-peak" />P 鼻耦合峰</span>
                  <span title="鼻腔或旁支声腔耦合引入的反共振零点 (Z1, Z2…)"><i class="key-line dashed key-zero" />Z 反共振峰</span>
                </div>
              </div>

              <!-- Quad 3 (Bottom-Left): PTB Transverse Cross-Section & Real Frontal Lip Contour -->
              <div v-if="openAcousticCards.has('section')" id="acoustic-section" class="trio-card sci-plane acoustic-plot">
                <div class="trio-hdr">
                  <span class="trio-lbl">横截面 &amp; 正面唇形</span>
                  <span v-if="liveSnapshot?.nasal" class="quad-nasal-pill" :class="{ open: lipFront.nasalOpen }">
                    {{ lipFront.nasalOpen ? `鼻腔连通 ${lipFront.portAreaCm2.toFixed(2)} cm²` : '软腭闭塞' }}
                  </span>
                </div>
                <div v-if="liveSnapshot?.airway_sections?.length || lipFront.isRealMesh" class="quad-sec-lip-grid">
                  <div class="quad-sec-box">
                    <canvas ref="sectionCanvasRef" class="quad-canvas" aria-label="模型声道横截面" />
                    <template v-if="!importedTractParams">
                      <button v-for="(handle,n) in sideHandles" :key="n" type="button" class="side-grip" :style="{left:handle.x+'px',top:handle.y+'px'}" :aria-label="'拖动舌侧缘 '+handle.key" :title="handle.key+' · 上下拖动舌侧缘'" @pointerdown="dragCrossHandle($event,handle.key)" />
                    </template>
                    <span v-if="sectionStatus.available && sectionStatus.open" class="quad-mini-tag mono">
                      {{ sectionStatus.areaCm2.toFixed(2) }} cm²
                    </span>
                  </div>
                  <div class="quad-lip-box">
                    <svg v-if="lipFront.isRealMesh" class="quad-lip-svg" role="img" aria-label="模型正面唇形" :viewBox="lipFront.viewBox" preserveAspectRatio="xMidYMid meet">
                      <path
                        :d="lipFront.outerPath"
                        fill="color-mix(in srgb, var(--anatomy-lip) 58%, var(--chart-panel))"
                        stroke="var(--anatomy-lip)"
                        stroke-width="0.11"
                      />
                      <path
                        :d="lipFront.aperturePath"
                        fill="var(--app)"
                        stroke="var(--anatomy-lip)"
                        stroke-width="0.15"
                      />
                      <template v-if="!importedTractParams">
                        <g v-for="side in [-1,1]" :key="side" class="lip-grip" :aria-label="side===-1?'调整左唇角宽度':'调整右唇角宽度'"
                          @pointerdown="dragCrossHandle($event,'lip_width',side)">
                          <circle :cx="side*lipFront.cornerZ" cy="0" r="0.28" fill="transparent" aria-hidden="true" />
                          <circle :cx="side*lipFront.cornerZ" cy="0" r="0.11" fill="var(--panel)" stroke="var(--teal)" stroke-width="0.05" />
                        </g>
                      </template>
                    </svg>
                    <span v-else class="rm-no-section">暂无唇形网格</span>
                    <span v-if="lipFront.isRealMesh" class="quad-mini-tag mono">
                      唇宽 {{ (liveSnapshot?.lip_width ?? store.currentTractExtras.value.lip_width).toFixed(2) }}×
                    </span>
                  </div>
                </div>
                <div v-else class="rm-no-section">暂无横截面或正面唇形数据</div>
              </div>

              <!-- Quad 4 (Bottom-Right): PTB Acoustic Vowel Space -->
              <div v-if="openAcousticCards.has('vowel')" id="acoustic-vowel" class="trio-card sci-plane acoustic-plot">
                <div class="trio-hdr vowel-card-header">
                  <span class="trio-lbl">声学元音图</span>
                  <div class="rm-head-acts vowel-card-controls">
                    <CustomSelect
                      v-model="vowelReferenceMode"
                      :options="vowelSourceOptions"
                      size="xs"
                      aria-label="元音图参考来源"
                      title="原音实测使用 Praat Burg，构型 H(f) 使用 TextGrid 核心区逐帧声道传递函数"
                      class="vowel-source-sel"
                    />
                    <CustomSelect
                      v-model="vowelCoordinateScale"
                      :options="vowelScaleOptions"
                      size="xs"
                      aria-label="元音图坐标刻度"
                      title="F1 与 F2 的间距，可在线性和对数之间切换"
                      class="vowel-scale-sel"
                    />
                    <button
                      v-if="manualVowelAxes"
                      type="button"
                      class="btn xs icon-only quad-reset"
                      aria-label="复位声学元音图坐标范围"
                      title="复位声学元音图坐标范围"
                      @click="resetVowelView"
                    >
                      <IconSvg name="refresh" :size="10" />
                    </button>
                  </div>
                </div>
                <div class="quad-stage">
                  <canvas
                    ref="vowelCanvasRef"
                    class="quad-canvas quad-vowel-canvas"
                    :aria-label="(vowelReferenceMode === 'transfer' ? '当前解剖模型的逐帧声道传递峰' : '原音实测元音') + (vowelCoordinateScale === 'logarithmic' ? '，对数坐标' : '，线性坐标')"
                    :title="vowelHover ? vowelHover.name : '悬停查看数据来源 · 滚轮缩放 · 拖动平移 · 双击复位'"
                    @wheel.prevent="onVowelWheel"
                    @pointerdown="onVowelPointerDown"
                    @pointermove="onVowelHover"
                    @pointerleave="vowelHover = null"
                    @dblclick="resetVowelView"
                  />
                  <div v-if="vowelHover" class="vowel-point-info" role="status">
                    <strong class="ipa notranslate" translate="no">
                      {{ formatVowelChartLabel(vowelHover.symbol) }}
                      <small class="vowel-lip-tag" :class="isRoundedVowelSymbol(vowelHover.symbol) ? 'rounded' : 'unrounded'">
                        {{ isRoundedVowelSymbol(vowelHover.symbol) ? '圆唇' : '非圆唇' }}
                      </small>
                    </strong>
                    <span class="mono">F1 · F2 {{ Math.round(vowelHover.f1) }} / {{ Math.round(vowelHover.f2) }} Hz</span>
                    <span>{{ vowelHover.source === 'recorded' ? 'Praat Burg 实测' : vowelHover.source === 'transfer'
                      ? 'VTL H(f) 核心区中位数' : '套装单帧构型 H(f)' }} · {{ vowelHover.name }}</span>
                  </div>
                </div>
                <div class="quad-legend vowel-legend" :data-measured="measuredVowelCount" :data-transfer="transferVowelCount"
                  :data-nasal="nasalVowelCount" :data-pose="savedPoseVowelCount"
                  :data-speaker="vowelReferenceMode === 'transfer' ? speakerModel : undefined">
                  <span v-if="vowelReferenceLoading">正在读取元音参考…</span>
                  <span v-else-if="vowelReferenceError">{{ vowelReferenceError }}</span>
                  <template v-else>
                    <span v-if="vowelReferences.length" title="非圆唇元音高斯峰值"><i class="key-gauss unrounded" />非圆唇</span>
                    <span v-if="vowelReferences.length" title="圆唇元音高斯峰值"><i class="key-gauss rounded" />圆唇</span>
                    <span v-if="transferVowelCount" title="各元音核心区的第一、第二稳定传递峰中位数">
                      {{ speakerModel }} · 65 截面 · {{ transferVowelCount }}
                    </span>
                    <span v-if="measuredVowelCount">原音 Burg {{ measuredVowelCount }}</span>
                    <span v-if="savedPoseVowelCount">套装构型 {{ savedPoseVowelCount }}</span>
                    <span v-if="vowelOmissions.annotation" :title="'缺可用 TextGrid 元音边界'">缺标注 {{ vowelOmissions.annotation }}</span>
                    <span v-if="vowelOmissions.track">缺轨 {{ vowelOmissions.track }}</span>
                    <span v-if="vowelOmissions.peaks">缺稳定峰 {{ vowelOmissions.peaks }}</span>
                    <span v-if="vowelOmissions.invalid">构型无效 {{ vowelOmissions.invalid }}</span>
                    <span v-if="vowelOmissions.unlinked">无关联原音 {{ vowelOmissions.unlinked }}</span>
                    <span v-if="!vowelReferences.length && !Object.values(vowelOmissions).some(Boolean)">暂无参考元音</span>
                    <span v-if="vowelCurrentInView"><i class="key-live" />当前构型</span>
                  </template>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <SplitPane
        v-model="dockHeight"
        direction="horizontal"
        invert
        :min="225"
        :max="550"
        :default-value="382"
        storage-key="research-timeline-height"
      />

      <!-- Lower Deck: 100% Full-Width G2P Compile Bar & Multi-Track Timeline -->
      <section class="rm-dock" data-tour="main-timeline" :style="{ height: `${dockHeight}px` }" aria-label="多轨标注">
        <div class="panel rm-timeline-g2p-bar" data-tour="main-g2p-bar">
          <div class="rm-timeline-transport" role="group" aria-label="时间轴状态与播放">
            <span
              class="rm-synth-status-badge"
              :class="synthStatusState"
              role="status"
              :title="annotationAudioLabel"
            >
              <i v-if="synthStatusState === 'synthesizing'" class="rm-spin-ring" aria-hidden="true" />
              <i v-else class="rm-status-dot" aria-hidden="true" />
              <span>{{ synthStatusText }}</span>
            </span>

            <button type="button" class="btn xs primary" :aria-label="store.isPlaying.value ? '停止时间轴播放' : '播放标注时间轴'"
              :title="'点击自动合成（若待合成）并播放 · ' + annotationAudioLabel" :disabled="annotationSynthesizing && !store.isPlaying.value"
              @click="toggleTransportPlay">
              <IconSvg :name="store.isPlaying.value ? 'stop' : 'play'" :size="12" />
              <span>{{ store.isPlaying.value ? '停止' : '播放' }}</span>
            </button>

            <!-- Consolidated Recording Source Switcher (raw / denoised / edited / resynthesis) -->
            <div
              v-if="loadedAnnotationRecording"
              class="seg rm-playback-src-seg"
              role="group"
              aria-label="录音与重合成音源切换"
              title="切换原始录音、DPDFNet 降噪录音、编辑音频或分段规整重合成语音"
            >
              <button
                type="button"
                :class="{ active: annotationPlaybackSource === 'recording' && !loadedAnnotationRecording.denoised }"
                :aria-pressed="annotationPlaybackSource === 'recording' && !loadedAnnotationRecording.denoised"
                @click="showRecordingVersion(false)"
              >
                原音
              </button>
              <button
                type="button"
                :class="{ active: annotationPlaybackSource === 'recording' && loadedAnnotationRecording.denoised }"
                :aria-pressed="annotationPlaybackSource === 'recording' && loadedAnnotationRecording.denoised"
                :disabled="isDenoising"
                @click="denoiseAnnotationRecording"
              >
                {{ isDenoising ? '降噪中…' : 'DPDFNet 降噪' }}
              </button>
              <button
                v-if="store.editedAnnotationAudio.value"
                type="button"
                :class="{ active: isEditedRecordingActive }"
                :aria-pressed="isEditedRecordingActive"
                @click="showEditedRecording"
              >
                编辑音频
              </button>
              <button
                type="button"
                :class="{ active: annotationPlaybackSource === 'synthesis' }"
                :aria-pressed="annotationPlaybackSource === 'synthesis'"
                @click="showSynthesizedRecording"
              >
                重合成{{ hasEditedReconstructedSource && !hasSynthesizedRecording ? ' *' : '' }}
              </button>
            </div>

            <button
              v-if="loadedAnnotationRecording"
              type="button"
              class="btn xs rm-reconstruct-action"
              :disabled="reconstructingTimeline"
              :title="loadedAnnotationRecording.uploadedTextGrid
                ? `沿用已上传的 ${loadedAnnotationRecording.uploadedTextGridName ?? 'TextGrid'} 边界直接提取 50Hz 声道重建轨迹`
                : '提取 50Hz 声道重建轨迹并执行参考文本音素对齐'"
              @click="onClickReconstructAndAlign"
            >
              <IconSvg name="reconstruct" :size="12" />
              <span>{{ reconstructingTimeline ? '重建对齐中…' : '声道重建并对齐' }}</span>
            </button>
          </div>

          <div class="rm-g2p-input-wrap">
            <IconSvg name="type" :size="12" class="muted" />
            <input
              v-model="g2pText"
              type="text"
              class="inp rm-g2p-inp notranslate"
              translate="no"
              placeholder="输入中/英/日、[IPA¹²³ / ˥˩]（国际音标须加方括号，已支持多数附加符号、少部分待适配）或 {3V̤ ... 3V̤}"
              title='国际音标必须放在方括号 [...] 中（目前已支持大多数附加符号，尚有少部分待适配）；VoQS 内若要输入中/英/日原词而非国际音标，可用英文双引号包住，例如 [a {F "falsetto" F}]、[a {F "你好" F}]、[a {F "こんにちは" F}]'
              @keydown.enter="compileG2pToTrack"
            />
          </div>

          <button
            ref="dictMenuBtnRef"
            type="button"
            class="btn xs rm-dict-trigger"
            data-tour="main-dict-btn"
            :class="{ active: dictMenuOpen }"
            aria-haspopup="dialog"
            :aria-expanded="dictMenuOpen"
            title="分语种配置汉字、英语 CMUdict、日语、方言包与个人发音词典"
            @click="toggleDictMenu"
          >
            <IconSvg name="book" :size="11" />
            <span class="rm-dict-lbl">{{ activeDictButtonLabel }}</span>
            <span v-if="activeUserEntryCount > 0" class="mono rm-dict-cnt">{{ activeUserEntryCount }}</span>
            <IconSvg name="chevron-down" :size="10" />
          </button>

          <CustomSelect v-model="textPoseSource" :options="textPoseOptions" size="xs"
            aria-label="文本合成构型" title="自动切换（推荐）：中英日等文本使用模型默认构型，[IPA] 使用当前 IPA 构型，混排自动按段切换；也可手动固定为模型默认构型或当前 IPA 构型" />
          <CustomSelect v-model="speechRate" :options="speechRateOptions" size="xs"
            aria-label="合成语速" title="切换语速后立即缩放当前合成轨时长，并在编译入轨时作用于中英文韵律与规则合成" />
          <button v-if="hasKanaPlaceholders" type="button" class="btn xs" @click="convertLegacyKana">假名转 IPA</button>
          <button type="button" class="btn xs primary" :disabled="compilingText" @click="compileG2pToTrack">
            <IconSvg name="send" :size="11" />
            <span>{{ compilingText ? '编译中…' : '编译入轨' }}</span>
          </button>
        </div>

        <div v-if="selectedDictionary && dialectTokens.some(token => token.readings.length !== 1)" class="rm-dialect-review">
          <template v-for="token in dialectTokens" :key="token.key">
            <label v-if="token.readings.length > 1" class="rm-dialect-token">
              <span>{{ token.text }}</span>
              <CustomSelect
                size="xs"
                class="notranslate rm-dialect-sel"
                translate="no"
                :model-value="dialectChoices[token.key] ?? 0"
                :options="token.readings.map((r, i) => ({ value: i, label: r.ipa + (r.tone ? ' · ' + r.tone : '') }))"
                @update:model-value="(v) => { dialectChoices[token.key] = Number(v); }"
              />
            </label>
            <span v-else-if="!token.readings.length" class="muted">未收录 {{ token.text }}</span>
          </template>
        </div>

        <div class="rm-lower-timeline">
          <ResearchTimeline
            :recording-active="annotationPlaybackSource !== 'synthesis' && Boolean(loadedAnnotationRecording)"
            @send-pitch="openAnnotationInArranger"
            @keyframe-open="keyframeModalOpen = $event"
            @corpus-drop="onTimelineCorpusDrop"
            @play-selection="playTimelineSelection"
            @cut-range="onTimelineCutRange"
            @trim-silence="onTimelineTrimSilence"
            @save-dictionary="saveCurrentSyllableToPersonalLexicon"
            @playhead-scrub="onTimelinePlayheadScrub"
            @phoneme-focus="onTimelinePhonemeFocus"
          />
        </div>
      </section>
    </div>

    <!-- Teleported Floating Menus & Modals -->
    <Teleport to="body">
      <!-- Send Audio Floating Menu -->
      <div
        v-if="sendMenuOpen"
        ref="sendMenuFloatingRef"
        class="rm-teleport-menu panel"
        :style="sendMenuStyle"
        role="menu"
        aria-label="发送音频目标菜单"
      >
        <button
          type="button"
          class="rm-menu-item"
          :disabled="sendingAudio || compilingText"
          @click="sendMenuOpen = false; void sendAnnotationAudio('studio')"
        >
          <IconSvg name="stage" :size="13" />
          <span>{{ returnSource?.origin ? '送回剪辑原片段' : '发送到剪辑' }}</span>
        </button>
        <button
          type="button"
          class="rm-menu-item"
          :disabled="sendingAudio || compilingText"
          @click="sendMenuOpen = false; void sendAnnotationAudio('mixer')"
        >
          <IconSvg name="sliders" :size="13" />
          <span>发送到发声调音台</span>
        </button>
        <button
          type="button"
          class="rm-menu-item"
          :disabled="compilingText || sendingAudio"
          @click="sendMenuOpen = false; openAnnotationInArranger()"
        >
          <IconSvg name="piano" :size="13" />
          <span>发送到编曲工作台</span>
        </button>
        <button
          type="button"
          class="rm-menu-item"
          :disabled="sendingAudio || compilingText"
          @click="sendMenuOpen = false; void sendAnnotationAudio('continuumA')"
        >
          <IconSvg name="sliders" :size="13" />
          <span>发送到连续统端点 A</span>
        </button>
        <button
          type="button"
          class="rm-menu-item"
          :disabled="sendingAudio || compilingText"
          @click="sendMenuOpen = false; void sendAnnotationAudio('continuumB')"
        >
          <IconSvg name="sliders" :size="13" />
          <span>发送到连续统端点 B</span>
        </button>
      </div>

      <!-- Multi-Language Dictionary & Personal Lexicon Popover -->
      <div
        v-if="dictMenuOpen"
        ref="dictMenuFloatingRef"
        class="rm-dict-popover panel"
        :style="dictMenuStyle"
        role="dialog"
        aria-label="词典与转写规则设置"
      >
        <div class="rm-dict-pop-head">
          <strong>词典与多语转写规则</strong>
          <button type="button" class="btn xs icon-only" aria-label="关闭词典设置" @click="dictMenuOpen = false">
            <IconSvg name="close" :size="11" />
          </button>
        </div>

        <!-- Relocated Personal Lexicon Save Section -->
        <div class="rm-dict-sec rm-dict-save-box">
          <div class="rm-dict-sec-title">
            <span>存入当前选中音节</span>
            <span v-if="currentLexiconSelection" class="muted">
              {{ currentLexiconDictionaryLabel }} · {{ activeUserLexiconBook.name }}
            </span>
          </div>
          <div v-if="currentLexiconSelection" class="rm-lexicon-save-preview">
            <strong class="notranslate" translate="no">{{ primarySelectedEntry?.syl.text }}</strong>
            <span class="ipa notranslate" translate="no">[{{ currentLexiconSelection.ipa }}]</span>
          </div>
          <div v-else class="muted">请先在时间轴选中一个音节</div>
          <div class="rm-lexicon-save-row">
            <button
              type="button"
              class="btn xs primary"
              style="flex: 1"
              :disabled="!currentLexiconSelection"
              title="保存时间轴上当前音节的 IPA、音素时长比例与声道构型"
              @click="saveCurrentSyllableToPersonalLexicon"
            >
              <IconSvg name="book" :size="11" />
              <span>将当前字/音节存入个人词典</span>
            </button>
            <button
              type="button"
              class="btn xs icon-only"
              aria-label="导出个人词典 JSON"
              title="导出个人词典 JSON"
              @click="handleExportPersonalLexicon"
            >
              <IconSvg name="download" :size="11" />
            </button>
          </div>
        </div>

        <div class="rm-dict-sec">
          <div class="rm-dict-sec-title">
            <span>1. 汉字转写词典</span>
            <label class="rm-dict-chk">
              <input
                type="checkbox"
                :checked="dictionaryPrefs.zhUsePersonal"
                @change="updateDictionaryPrefs({ zhUsePersonal: ($event.target as HTMLInputElement).checked })"
              />
              <span>个人汉字词典优先</span>
            </label>
          </div>
          <CustomSelect
            size="xs"
            :model-value="dictionaryPrefs.zhStandard"
            :options="mandarinStandardSelectOptions"
            :disabled="Boolean(selectedDictionary)"
            aria-label="汉字转写词典"
            @update:model-value="(v) => selectMandarinStandard(v as MappingStandard)"
          />
        </div>

        <div class="rm-dict-sec">
          <div class="rm-dict-sec-title"><span>2. 英语词典</span></div>
          <CustomSelect
            size="xs"
            :model-value="dictionaryPrefs.enMode"
            :options="enDictModeOptions"
            aria-label="英语词典"
            @update:model-value="(v) => updateDictionaryPrefs({ enMode: v as 'cmudict-personal' | 'cmudict-only' })"
          />
        </div>

        <div class="rm-dict-sec">
          <div class="rm-dict-sec-title"><span>3. 日语词典</span></div>
          <CustomSelect
            size="xs"
            :model-value="dictionaryPrefs.jaMode"
            :options="jaDictModeOptions"
            aria-label="日语词典"
            @update:model-value="(v) => updateDictionaryPrefs({ jaMode: v as 'standard-personal' | 'standard-only' })"
          />
        </div>

        <div class="rm-dict-sec">
          <div class="rm-dict-sec-title"><span>4. 方言包选择</span></div>
          <CustomSelect
            size="xs"
            :model-value="selectedDictionary ? selectedDictionary.id : ''"
            :options="dialectPackOptions"
            aria-label="方言包选择"
            @update:model-value="(v) => selectDialectPack(String(v))"
          />
        </div>

        <div class="rm-dict-sec">
          <div class="rm-dict-sec-title">
            <span>个人发音词典簿</span>
            <span class="mono muted">{{ activeUserEntryCount }} 词条</span>
          </div>
          <div class="rm-dict-row">
            <CustomSelect
              size="xs"
              style="flex: 1"
              :model-value="activeUserLexiconBook.id"
              :options="userLexiconBookOptions"
              aria-label="个人发音词典簿"
              @update:model-value="(v) => updateDictionaryPrefs({ activeBookId: String(v) })"
            />
            <button type="button" class="btn xs" title="导出个人词典 JSON" @click="handleExportPersonalLexicon">
              导出
            </button>
            <button type="button" class="btn xs" title="导入个人词典 JSON" @click="lexiconImportInputRef?.click()">
              导入
            </button>
            <input
              ref="lexiconImportInputRef"
              type="file"
              accept=".json,application/json"
              class="hidden"
              @change="handleImportPersonalLexicon"
            />
          </div>
          <div class="rm-dict-row">
            <input
              v-model="newBookNameDraft"
              type="text"
              class="inp"
              placeholder="新建个人词典簿名称…"
              @keydown.enter.prevent="handleCreateLexiconBook"
            />
            <button type="button" class="btn xs" :disabled="!newBookNameDraft.trim()" @click="handleCreateLexiconBook">
              新建
            </button>
          </div>
        </div>

        <div class="rm-dict-note">
          <IconSvg name="info" :size="12" />
          <span>国际音标 <code>[...]</code> 与 <code>{VoQS ...}</code> 原样直通解析，不受中英日词典干扰。</span>
        </div>
      </div>

      <!-- Lightweight Reference Text Modal for Inline M27 Reconstruction & Alignment -->
      <dialog
        v-if="reconstructModalOpen"
        ref="reconstructDialogRef"
        class="rm-reconstruct-dialog panel"
        aria-labelledby="rm-recon-title"
        @close="reconstructModalOpen = false"
      >
        <form class="rm-recon-form" @submit.prevent="confirmReconstructModal">
          <div class="rm-recon-head">
            <strong id="rm-recon-title">声道重建并对齐</strong>
            <span class="mono muted">{{ loadedAnnotationRecording?.raw.name }}</span>
          </div>
          <p class="rm-recon-hint">
            输入与录音一致的文本可显著提升音素对齐效果（可留空，留空则仅执行 50 Hz 声道轨迹重建）。
          </p>
          <label class="rm-recon-field">
            <span>参考文本（可选）</span>
            <textarea
              v-model="reconstructTextDraft"
              rows="2"
              class="inp"
              placeholder="例如：春江潮水连海平 或 Hello world"
              autofocus
            />
          </label>
          <div class="rm-recon-field rm-recon-lang">
            <span>文本语言</span>
            <CustomSelect
              v-model="reconstructLangDraft"
              :options="reconstructLangOptions"
              size="sm"
              aria-label="文本语言"
            />
          </div>
          <div class="rm-recon-actions">
            <button type="button" class="btn sm" @click="closeReconstructModal">取消</button>
            <button type="submit" class="btn sm primary">
              <IconSvg name="reconstruct" :size="12" />
              <span>开始重建并写回时间轴</span>
            </button>
          </div>
        </form>
      </dialog>

      <!-- In-App Overwrite Confirmation Modal (Replaces blocking window.confirm) -->
      <div
        v-if="reconstructConfirmOpen"
        class="export-modal-mask"
        role="presentation"
        @click.self="reconstructConfirmOpen = false"
      >
        <div
          class="export-modal-card rm-confirm-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rm-recon-confirm-title"
        >
          <div class="p-head">
            <strong id="rm-recon-confirm-title">确认重新声道重建</strong>
            <button type="button" class="btn xs icon-only" aria-label="关闭确认框" @click="reconstructConfirmOpen = false">
              <IconSvg name="close" :size="11" />
            </button>
          </div>
          <div class="p-body rm-confirm-body">
            <p>重新执行声道重建并对齐会覆盖当前时间轴上已修改的音素边界、构型与基频曲线。确认继续吗？</p>
            <div class="rm-recon-actions">
              <button type="button" class="btn sm" @click="reconstructConfirmOpen = false">取消</button>
              <button type="button" class="btn sm danger" @click="confirmOverwriteReconstruct">确认覆盖并重建</button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.trio-card.acoustic-plot {
  background: var(--chart-panel);
  border-color: var(--chart-outline);
  border-radius: var(--chart-corner);
}

.rm-shell {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.rm-global-bar {
  gap: 8px;
}

.rm-proj-summary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 0.916667rem;
  white-space: nowrap;
  min-width: 0;
}

.rm-file-tools {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

.rm-corpus-badge {
  padding: 0 5px;
  border-radius: var(--r-pill);
  background: var(--selected);
  color: var(--accent);
  font-size: 0.791667rem;
  line-height: 1.4;
}

.rm-corpus-perm-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warning);
  flex: none;
}

.rm-workspace-body {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: var(--pad-shell);
  gap: 2px;
  overflow: hidden;
}

/* On-Demand Left Slide-Over Corpus Directory Drawer */
.rm-corpus-drawer-mask {
  position: absolute;
  inset: 0;
  z-index: var(--z-drawer);
  background: var(--overlay);
  transition: opacity var(--dur-fast) var(--ease-out-expo);
}

.rm-corpus-drawer-mask.dragging {
  opacity: 0;
  pointer-events: none;
}

.rm-corpus-drawer {
  position: absolute;
  top: var(--pad-shell);
  bottom: var(--pad-shell);
  left: var(--pad-shell);
  width: min(324px, calc(100% - 20px));
  z-index: var(--z-drawer);
  background: var(--popover-bg);
  box-shadow: var(--popover-shadow);
  backdrop-filter: var(--glass-backdrop);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.rm-corpus-drawer.drop-active {
  border-color: var(--accent);
  box-shadow: var(--popover-shadow), 0 0 0 2px var(--selection);
}

.rm-corpus-empty-acts {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 4px;
}

/* Upper 3-Column Strictly Bottom-Aligned Row */
.rm-upper-row {
  flex: 1;
  min-width: 0;
  min-height: 220px;
  display: flex;
  gap: 2px;
  overflow: hidden;
}

.rm-upper-right-pair {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  gap: 2px;
  overflow: hidden;
}

.rm-ipa-quick {
  flex: none;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.rm-tract-panel {
  flex: none;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.rm-trio-panel {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/* Vocal Tract Viewport + Plan A 19-D Side Parameter Drawer */
.rm-tract-stage {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: hidden;
  background: var(--panel);
}

.rm-tract-wrap {
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: 0;
  background: var(--panel);
}

.rm-tract-params-drawer {
  width: min(256px, 50%);
  flex: none;
  min-width: 196px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: var(--border-w) solid var(--panel-border);
  background: color-mix(in srgb, var(--panel) 88%, var(--app));
  overflow: hidden;
}

.rm-tract-params-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--panel-border);
  font-size: 0.916667rem;
  font-weight: 600;
}

.rm-tract-params-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rm-tract-params-title small {
  color: var(--teal);
  font-weight: 700;
}

.rm-tract-params-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  scrollbar-width: thin;
}

.rm-tract-readonly-note {
  padding: 6px 8px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
  background: color-mix(in srgb, var(--warning) 12%, var(--panel));
  color: var(--warning);
  font-size: 0.833333rem;
  line-height: 1.4;
}

.rm-tract-fieldset {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rm-tract-fieldset:disabled {
  opacity: 0.56;
  pointer-events: none;
}

.rm-tract-params-foot {
  flex: none;
  padding: 6px 8px;
  border-top: 1px solid var(--panel-border);
}

/* Timeline Bar & Full-Width Lower Dock */
.rm-dock {
  flex: none;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-height: 0;
  max-height: 58%;
}

.rm-timeline-g2p-bar {
  flex: none;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  min-height: 36px;
  overflow: visible;
}

.rm-timeline-transport {
  display: inline-flex;
  flex: none;
  gap: 5px;
  align-items: center;
  padding-inline-end: 7px;
  border-inline-end: 1px solid var(--panel-border);
}

.rm-timeline-transport .btn {
  min-height: 25px;
  white-space: nowrap;
}

.rm-dialect-review {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  font-size: 0.916667rem;
}

.rm-dialect-token {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.rm-dialect-sel {
  min-width: 84px;
}

.rm-g2p-input-wrap {
  flex: 1 1 220px;
  min-width: 140px;
  display: flex;
  align-items: center;
  gap: 5px;
}

.rm-g2p-inp {
  width: 100%;
  height: 24px;
}

.rm-synth-sel {
  flex: none;
  min-width: 134px;
}

.rm-spk-sel {
  width: 118px;
  flex: none;
}

.rm-speaker-reference {
  width: 132px;
}

.rm-head-acts {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.rm-file-list {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 4px;
  padding: 7px 8px;
}

.rm-corpus-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: none;
  gap: 6px;
  margin: auto;
  padding: 10px 4px;
  text-align: center;
}

.rm-corpus-empty > .vc-icon {
  color: var(--accent);
  margin-bottom: 3px;
}

.rm-corpus-empty > p {
  margin: 0;
  font-size: 0.916667rem;
}

.rm-drop-hint {
  font-size: 0.833333rem;
  padding: 5px 7px;
  border-radius: var(--r-ctrl);
  border: 1px dashed var(--border);
  background: color-mix(in srgb, var(--app) 58%, transparent);
  text-align: center;
}

.rm-corpus-search {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px 2px;
  flex: none;
}

.rm-corpus-search-inp {
  flex: 1;
  min-width: 0;
  height: 22px;
  font-size: 0.875rem;
}

.rm-tree-folder {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-height: 25px;
  padding: 3px 7px;
  border: 0;
  border-radius: var(--r-ctrl);
  background: transparent;
  color: var(--text);
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
}

.rm-tree-folder:hover {
  background: color-mix(in srgb, var(--selected) 68%, transparent);
}

.rm-tree-folder > .tree-tag {
  margin-left: auto;
}

.rm-file-row {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  width: 100%;
  min-height: 30px;
  padding: 4px 7px;
  border: 1px solid transparent;
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--app) 50%, transparent);
  cursor: grab;
  user-select: none;
  font-size: 0.9rem;
  text-align: left;
}

.rm-file-row:active {
  cursor: grabbing;
}

.rm-file-row:hover,
.rm-file-row.active {
  border-color: var(--accent);
  background: var(--selected);
}

.rm-file-row > .tree-tag {
  margin-left: auto;
}

.rm-file-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Quick IPA Panel */
.rm-ipa-empty {
  grid-column: 1 / -1;
  padding: 7px 0;
  font-size: 0.916667rem;
}

.rm-ipa-tabs {
  padding: 6px 8px 4px;
  flex: none;
}

.rm-ipa-tabs .seg {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr)) minmax(max-content, 1.3fr) minmax(0, 1fr);
}

.rm-ipa-tabs .seg button {
  padding-inline: 4px;
}

.rm-ipa-grid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 8px 6px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
  gap: 4px;
  align-content: start;
  scrollbar-width: thin;
}

.rm-manner {
  grid-column: 1 / -1;
  color: var(--muted);
  font-size: 0.916667rem;
  padding: 6px 0 2px;
}

.rm-ipa-cell {
  height: 27px;
  border: 1px solid var(--ctrl-border);
  border-radius: max(3px, calc(var(--r-ctrl) - 2px));
  background: var(--ctrl-bg);
  color: var(--text);
  font-size: 1.125rem;
  cursor: pointer;
  display: grid;
  place-items: center;
  padding: 0 2px;
  transition: border-color var(--dur-fast) var(--ease-out-expo), background-color var(--dur-fast) var(--ease-out-expo);
}

.rm-ipa-cell:hover,
.rm-ipa-cell.preview {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--selected) 72%, var(--panel));
  color: var(--accent);
}

.rm-ipa-cell.active {
  border-color: var(--teal);
  background: var(--teal-bg);
  color: var(--teal);
  font-weight: 700;
}

.rm-ipa-foot {
  flex: none;
  padding: 5px 8px;
  border-top: 1px solid color-mix(in srgb, var(--panel-border) 68%, transparent);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 5px;
  font-size: 0.875rem;
}

.rm-ipa-source {
  flex: none;
  white-space: nowrap;
  font-size: 0.791667rem;
}

.rm-ipa-mode-tag {
  flex: none;
  font-size: 0.75rem;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--muted) 16%, transparent);
  color: var(--muted);
  white-space: nowrap;
}

.rm-ipa-mode-tag.current {
  background: var(--teal-bg);
  color: var(--teal);
}

.rm-ipa-mode-tag.replace {
  background: var(--selected);
  color: var(--accent);
}

.rm-ipa-desc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 2x2 Acoustic Analysis Quad */
.acoustic-card-switches {
  display: flex;
  flex: none;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px 6px;
  border-bottom: 1px solid var(--border);
}

.acoustic-card-switches .btn {
  white-space: nowrap;
}

.acoustic-open-all {
  margin-inline-start: auto;
}

.rm-trio-grid {
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: 6px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: minmax(0, 1fr);
  gap: 6px;
}

.rm-trio-grid[data-open-count="0"],
.rm-trio-grid[data-open-count="1"] {
  grid-template-columns: minmax(0, 1fr);
}

.rm-trio-grid[data-open-count="3"],
.rm-trio-grid[data-open-count="4"] {
  grid-template-rows: repeat(2, minmax(0, 1fr));
}

.rm-trio-grid[data-open-count="3"] > .trio-card:last-child {
  grid-column: 1 / -1;
}

.acoustic-empty {
  place-self: center;
  margin: 0;
  font-size: 0.875rem;
}

.trio-card {
  border: 1px solid color-mix(in srgb, var(--border) 68%, transparent);
  border-radius: max(4px, calc(var(--r-panel) - 4px));
  padding: 4px 6px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.trio-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  font-size: calc(0.875rem * var(--acoustic-font-scale));
  flex: none;
  min-width: 0;
}

.trio-lbl {
  font-weight: 700;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.trio-val {
  font-size: calc(0.766667rem * var(--acoustic-font-scale));
  color: var(--teal);
  white-space: nowrap;
  flex: none;
}

.trio-val.danger {
  color: var(--danger);
  font-weight: 700;
}

.quad-legend {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  gap: 2px 9px;
  align-items: center;
  font-size: calc(0.75rem * var(--acoustic-font-scale));
  line-height: 1.25;
  color: var(--muted);
}

.quad-legend span {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  white-space: nowrap;
}

.quad-legend i {
  display: inline-block;
  flex: none;
  color: var(--chart-series);
}

.key-line {
  width: 11px;
  border-top: 2px solid currentColor;
}

.key-line.dashed {
  border-top-style: dashed;
  color: var(--anatomy-wall);
}

.quad-legend .key-line.key-formant {
  color: var(--chart-peer);
}

.quad-legend .key-line.key-nasal-peak {
  color: var(--warning);
}

.quad-legend .key-line.key-zero {
  color: var(--danger);
}

.quad-legend .key-live {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1px solid var(--chart-peer);
  box-shadow: inset 0 0 0 1.5px var(--chart-panel);
  background: var(--chart-peer);
}

.vowel-card-header {
  justify-content: space-between;
  gap: 6px;
}

.vowel-card-header .trio-lbl {
  flex: none;
}

.vowel-card-controls {
  gap: 4px;
  flex: none;
  margin-inline-start: auto;
}

.vowel-source-sel,
.vowel-scale-sel {
  min-width: 58px;
  flex: none;
}

.vowel-legend {
  gap: 3px 7px;
}

.quad-legend .key-gauss {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.quad-legend .key-gauss.unrounded {
  background: radial-gradient(circle, var(--vowel-unrounded) 0%, color-mix(in srgb, var(--vowel-unrounded) 38%, transparent) 55%, transparent 100%);
}

.quad-legend .key-gauss.rounded {
  background: radial-gradient(circle, var(--vowel-rounded) 0%, color-mix(in srgb, var(--vowel-rounded) 38%, transparent) 55%, transparent 100%);
}

.vowel-lip-tag {
  margin-left: 4px;
  padding: 0 4px;
  border-radius: var(--r-pill);
  font-family: var(--font-ui);
  font-size: calc(0.68rem * var(--acoustic-font-scale));
  font-weight: 600;
  vertical-align: middle;
}

.vowel-lip-tag.unrounded {
  color: var(--vowel-unrounded-text);
  background: color-mix(in srgb, var(--vowel-unrounded) 16%, transparent);
}

.vowel-lip-tag.rounded {
  color: var(--vowel-rounded-text);
  background: color-mix(in srgb, var(--vowel-rounded) 16%, transparent);
}

.vowel-point-info {
  position: absolute;
  inset: auto 4px 3px auto;
  z-index: var(--z-base);
  max-width: 100%;
  display: grid;
  gap: 2px;
  padding: 4px 6px;
  border: 1px solid var(--chart-outline);
  border-radius: var(--r-ctrl);
  background: var(--panel);
  color: var(--text);
  font-size: calc(0.75rem * var(--acoustic-font-scale));
  line-height: 1.3;
  box-shadow: var(--popover-shadow);
  pointer-events: none;
}

.vowel-point-info strong {
  font-size: calc(1.083333rem * var(--acoustic-font-scale));
}

.trio-legend-tag {
  flex: none;
  font-size: calc(0.75rem * var(--acoustic-font-scale));
  padding: 0 5px;
  border-radius: var(--r-pill);
  background: var(--selected);
  color: var(--accent);
  font-weight: 600;
  white-space: nowrap;
}

.quad-stage {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  width: 100%;
  display: flex;
  overflow: hidden;
}

.quad-canvas {
  display: block;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.quad-area-canvas {
  cursor: ew-resize;
  touch-action: none;
}

.quad-vowel-canvas {
  cursor: grab;
  touch-action: none;
}

.quad-vowel-canvas:active {
  cursor: grabbing;
}

.quad-sec-lip-grid {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
  gap: 4px;
}

.quad-sec-box,
.quad-lip-box {
  position: relative;
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: max(3px, calc(var(--r-ctrl) - 2px));
  background: color-mix(in srgb, var(--app) 42%, transparent);
  border: 1px solid color-mix(in srgb, var(--border) 42%, transparent);
  overflow: hidden;
}

.quad-lip-svg {
  width: 100%;
  height: 100%;
  display: block;
  padding: 3px 3px 13px;
}

.quad-mini-tag {
  position: absolute;
  bottom: 2px;
  right: 4px;
  font-size: calc(0.716667rem * var(--acoustic-font-scale));
  line-height: 1.2;
  padding: 0 4px;
  border-radius: 3px;
  color: var(--muted);
  background: color-mix(in srgb, var(--panel) 84%, transparent);
  pointer-events: none;
  white-space: nowrap;
}

.quad-nasal-pill {
  flex: none;
  font-size: calc(0.733333rem * var(--acoustic-font-scale));
  line-height: 1.25;
  padding: 0 5px;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--muted) 15%, transparent);
  color: var(--muted);
  font-weight: 600;
  white-space: nowrap;
}

.quad-nasal-pill.open {
  background: var(--teal-bg);
  color: var(--teal);
}

.quad-reset {
  flex: none;
}

.rm-lower-timeline {
  flex: 1;
  min-width: 0;
  min-height: 165px;
}

.rm-source {
  margin-left: 6px;
  font-size: 0.833333rem;
  color: var(--muted);
  font-weight: 400;
}

.rm-no-section {
  margin: auto;
  padding: 14px;
  font-size: 0.916667rem;
  color: var(--muted);
}

.side-grip {
  position: absolute;
  transform: translate(-50%, -50%);
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--teal);
  background: var(--panel);
  cursor: ns-resize;
  padding: 0;
  touch-action: none;
}

.lip-grip {
  cursor: ew-resize;
  touch-action: none;
  stroke-width: 0.09;
}

/* Status & Transport Actions */
.rm-synth-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  border-radius: var(--r-pill);
  font-size: 0.875rem;
  font-weight: 600;
  background: color-mix(in srgb, var(--app) 68%, var(--panel));
  border: 1px solid var(--panel-border);
  color: var(--muted);
  user-select: none;
  white-space: nowrap;
}

.rm-synth-status-badge .rm-status-dot {
  width: 6.5px;
  height: 6.5px;
  border-radius: 50%;
  background: var(--muted);
  flex: none;
}

.rm-synth-status-badge.pending {
  color: var(--warning);
  border-color: color-mix(in srgb, var(--warning) 42%, var(--panel-border));
  background: color-mix(in srgb, var(--warning) 10%, var(--panel));
}

.rm-synth-status-badge.pending .rm-status-dot {
  background: var(--warning);
}

.rm-synth-status-badge.ready {
  color: var(--teal);
  border-color: color-mix(in srgb, var(--teal) 42%, var(--panel-border));
  background: color-mix(in srgb, var(--teal) 10%, var(--panel));
}

.rm-synth-status-badge.ready .rm-status-dot {
  background: var(--teal);
}

.rm-synth-status-badge.synthesizing {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--panel-border));
}

.rm-spin-ring {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.6px solid color-mix(in srgb, var(--accent) 30%, transparent);
  border-top-color: var(--accent);
  animation: rm-spin 0.75s linear infinite;
  flex: none;
}

@keyframes rm-spin {
  to {
    transform: rotate(360deg);
  }
}

.rm-reconstruct-action {
  border-color: var(--accent);
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, var(--panel));
  font-weight: 600;
}

.rm-reconstruct-action:hover:not(:disabled) {
  background: var(--accent);
  color: var(--on-accent);
}

.rm-dict-trigger {
  flex: none;
  max-width: 190px;
  gap: 4px;
}

.rm-dict-lbl {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rm-dict-cnt {
  padding: 0 4px;
  border-radius: var(--r-pill);
  background: var(--selected);
  color: var(--accent);
  font-size: 0.791667rem;
}

/* Teleported Floating Menus & Popovers */
.rm-teleport-menu {
  position: fixed;
  z-index: var(--z-popover);
  zoom: var(--page-scale);
  overflow-y: auto;
  padding: 6px;
  display: grid;
  gap: 3px;
  background: var(--popover-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--r-ctrl);
  box-shadow: var(--popover-shadow);
}

.rm-menu-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  border-radius: max(3px, calc(var(--r-ctrl) - 2px));
  background: transparent;
  color: var(--text);
  font-size: 0.958333rem;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
}

.rm-menu-item:hover:not(:disabled) {
  background: var(--selected);
  color: var(--accent);
}

.rm-menu-item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.rm-dict-popover {
  position: fixed;
  z-index: var(--z-popover);
  zoom: var(--page-scale);
  overflow-y: auto;
  padding: 11px 12px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  background: var(--popover-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--r-panel);
  box-shadow: var(--popover-shadow);
  font-size: 0.916667rem;
  scrollbar-width: thin;
}

.rm-dict-pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--panel-border);
}

.rm-dict-save-box {
  padding: 8px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--panel-border));
  background: color-mix(in srgb, var(--selected) 45%, var(--panel));
}

.rm-lexicon-save-preview {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  font-size: 0.92em;
}

.rm-lexicon-save-row {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 2px;
}

.rm-dict-sec {
  display: grid;
  gap: 4px;
}

.rm-dict-sec-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text);
}

.rm-dict-chk {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
}

.rm-dict-row {
  display: flex;
  align-items: center;
  gap: 5px;
}

.rm-dict-row .inp {
  min-width: 0;
  height: 25px;
}

.rm-dict-note {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--selected) 60%, transparent);
  color: var(--muted);
  font-size: 0.833333rem;
  line-height: 1.4;
}

.rm-reconstruct-dialog {
  width: min(440px, calc(100vw - 32px));
  padding: 16px;
  margin: auto;
  border: 1px solid var(--panel-border);
  border-radius: var(--r-panel);
  background: var(--popover-bg);
  color: var(--text);
  box-shadow: var(--popover-shadow);
}

.rm-reconstruct-dialog::backdrop {
  background: var(--overlay);
}

.rm-recon-form {
  display: grid;
  gap: 11px;
}

.rm-recon-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.rm-recon-hint {
  margin: 0;
  font-size: 0.958333rem;
  line-height: 1.5;
  color: var(--muted);
}

.rm-recon-field {
  display: grid;
  gap: 4px;
  font-size: 0.916667rem;
}

.rm-recon-field textarea {
  width: 100%;
  resize: vertical;
}

.rm-recon-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}

.rm-confirm-card {
  width: min(420px, 94vw);
}

.rm-confirm-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 14px;
}

.rm-confirm-body p {
  margin: 0;
  line-height: 1.55;
  color: var(--text);
}
</style>
