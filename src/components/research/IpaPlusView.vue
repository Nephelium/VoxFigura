<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, watchEffect } from 'vue';
import ModuleGuideButton from '@/components/guide/ModuleGuideButton.vue';
import { publishPanelSnapshot } from '@/data/panel-snapshots';
import type { Clip, TractDelta, TractParamName } from '@vocalcut/core';
import type { M27TrajectoryAnim } from '@vocalcut/model-adapters';
import { findTargetInterval, fetchIpaReferences, fetchIpaReferenceTrajectory, ipaReferenceUrl,
  matchingIpaReferences, referenceTarget, type IpaReference } from '@/data/ipa-reference-library';
import {
  clearIpaPersonalRecordingsForSet,
  listIpaPersonalRecordings,
  removeIpaPersonalRecording,
  saveIpaPersonalRecording,
} from '@/data/ipa-personal-recordings';
import { interpM27AnimState, readThemePalette, renderM27TractSvg } from '@/vendor/m27-tract-studio/tract-renderer.js';
import {
  RECORDED_IPA_SET_ID,
  createIpaPoseSet,
  deleteIpaPoseSet,
  duplicateActiveIpaPoseSet,
  getProtectedIpaPose,
  getSelectedIpaPoseParams,
  ipaPoseSets,
  loadDefaultIpaPoses,
  renameIpaPoseSet,
  resetIpaPoseInSet,
  saveIpaPoseToSet,
  setIpaPoseProtected,
  selectIpaPoseSet,
  selectedIpaPoseSetId,
} from '@/data/ipa-pose-sets';
import {
  defaultTractParams,
  tractArray19ToRecord,
  tractRecordToArray19,
  useWorkbenchStore,
} from '@/stores/workbench';
import { combineIpaDiacritic } from '@/data/ipa-segments';
import { ipaFavorites, toggleIpaFavorite } from './research-utils';
import {
  DEFAULT_TRACT_EXTRAS,
  cloneTractExtras,
  preloadPtbIpaPresets,
  ptbPresetsVersion,
  type TractPoseExtras,
} from '@/data/ptb-ipa-presets';
import VocalTractViewport from '@/components/common/VocalTractViewport.vue';
import IconSvg from '@/components/common/IconSvg.vue';
import { copyTextToClipboard } from '@/components/common/clipboard';
import CustomSelect from '@/components/common/CustomSelect.vue';
import SplitPane from '@/components/common/SplitPane.vue';
import VoqsAnchorPicker from './VoqsAnchorPicker.vue';
import VoqsReferencePanel from './VoqsReferencePanel.vue';
import { voqsReconstructionUrl } from '@/data/voqs-reference-track';
import { defaultVoqsHeight } from '@/data/voqs-library';
import IpaRecordingTimeline from './IpaRecordingTimeline.vue';
import IpaReferenceRecorder from './IpaReferenceRecorder.vue';
import IpaRecordingKeyframes from './IpaRecordingKeyframes.vue';
import {
  bellSuperimposedRow,
  clearRecordingKeyframesForSet,
  expandBellKeyframesForRender,
  fetchRecordingLimits,
  IPA_RECORDING_HZ,
  loadRecordingKeyframes,
  recordingFrameAt,
  recordingTractParams,
  renderRecordingRevision,
  saveRecordingKeyframes,
  signatureForKeyframes,
  type RecordingKeyframe,
  type RecordingLimits,
  type RecordingRevision,
  type RecordingTrack,
} from '@/data/ipa-recording-edits';
import { getActiveSplitterValue } from '@/data/splitter-layout';
import { normalizeAudioFile, synthesisGainMode, voiceRenderLabels, type VoiceRenderMode } from '@/data/voice-renderer';
import IpaMaterialDownloads from './IpaMaterialDownloads.vue';
import IpaVowelComparison from './IpaVowelComparison.vue';
import { writeRecordedVoqs } from './voqs-actions';
import type { VoqsProfile, VoqsTake } from '@/data/voqs-library';
import { getCurrentPageScale } from '@/styles/skin-registry';
import { loadRecordedVowelFormants, vowelSymbolKey } from '@/data/ipa-vowel-measurements';
import {
  clearLinkedVowelRecordingsForSet,
  copyLinkedVowelRecordingsForSet,
  customIpaPoses,
  customPoseKey,
  deleteCustomIpaPose,
  getFullPoseForIpa,
  getLinkedVowelRecording,
  linkedVowelRecordings,
  poseOverridesForSet,
  replaceSegmentIpa,
  saveCustomIpaPose,
  setLinkedVowelRecording,
} from './research-utils';

interface CatalogExample {
  text: string;
  noteZh?: string;
}

interface CatalogSourceRef {
  sourceId: string;
  title?: string;
  url?: string;
  license?: string;
  locator: string;
  locatorZh?: string;
  locatorEn?: string;
}

interface CatalogSourceMeta {
  title: string;
  url?: string;
  version?: string;
  license?: string;
  provenance_version?: string;
}

interface CatalogEntry {
  id: string;
  system: 'ipa' | 'extipa' | 'voqs';
  section: string;
  display: string;
  insertText: string;
  insertionMode?: 'literal' | 'combining' | 'paired-span' | 'bridge';
  codePoints: string[];
  nameZh: string;
  nameEn: string;
  descriptionZh: string;
  usageZh?: string;
  contrastZh?: string;
  notesZh?: string;
  representation?: string;
  aliases?: string[];
  examples?: CatalogExample[];
  sourceRefs?: CatalogSourceRef[];
  isExample?: boolean;
  notationStatus?: 'combination' | 'historical';
}

interface MatrixCell {
  ids: string[];
  rows?: string[][];
  align?: 'left' | 'right' | 'center';
  split?: boolean;
  shaded?: boolean;
  rightHalfShaded?: boolean;
  span?: number;
}

interface MatrixChart {
  id: string;
  title: string;
  subtitle?: string;
  kind: 'matrix';
  columnGroups?: Array<{ label: string; span: number }>;
  columns: string[];
  rows: Array<{ label: string; cells: MatrixCell[] }>;
}

interface VowelChart {
  id: string;
  title: string;
  subtitle?: string;
  kind: 'vowels';
  ids: string[];
  points: Array<{ ids: string[]; x: number; y: number }>;
}

interface ListChart {
  id: string;
  title: string;
  subtitle?: string;
  kind: 'list';
  ids?: string[];
  groups?: Array<{ label: string; hint?: string; ids: string[] }>;
}

type AnyChart = MatrixChart | VowelChart | ListChart;

interface CatalogPayload {
  version: string;
  total: number;
  systems: { ipa: number; extipa: number; voqs: number };
  sources?: Record<string, CatalogSourceMeta>;
  voqsProvenance?: {
    title: string;
    author: string;
    source?: string;
    citation: string;
    license: string;
    licenseUrl?: string;
  };
  charts: {
    ipa: AnyChart[];
    extipa: AnyChart[];
    voqs: AnyChart[];
  };
  entries: CatalogEntry[];
}

interface ResolvedSourceRef {
  key: string;
  sourceId: string;
  locator: string;
  title: string;
  url?: string;
}

const store = useWorkbenchStore();

const catalog = ref<CatalogPayload | null>(null);
const loading = ref(true);
const loadErr = ref('');

const activeSystem = ref<'ipa' | 'extipa' | 'voqs'>('ipa');
const fontSizePx = ref(16);
const searchQuery = ref('');
const searchInputRef = ref<HTMLInputElement | null>(null);
const vowelsRowRef = ref<HTMLElement | null>(null);
const activeIpaSubSection = ref<'main' | 'diacritics'>('main');
const activeExtIpaSubSection = ref<'all' | 'matrix' | 'marks' | 'context'>('all');

const IPA_MAIN_DEFAULT_SPLIT_PCT = 70;
const ipaMainSplitPct = ref(getActiveSplitterValue('ipaMain', IPA_MAIN_DEFAULT_SPLIT_PCT));

const entryMap = computed(() => {
  const map = new Map<string, CatalogEntry>();
  if (catalog.value) {
    for (const e of catalog.value.entries) map.set(e.id, e);
  }
  return map;
});

const activeSpeaker = computed(() => store.project.value.voices[store.activeVoiceId.value]?.speaker ?? 'JD2');
const selectedEntry = ref<CatalogEntry | null>(null);
const favoriteEntry = computed(() => {
  const entry = selectedEntry.value;
  if (!entry || entry.system === 'voqs' || entry.insertionMode !== 'literal' || entry.isExample
    || ['tones', 'suprasegmentals', 'diacritics'].includes(entry.section) || /\s/.test(entry.insertText)) return null;
  return {
    entryId: entry.id,
    symbol: entry.insertText || entry.display,
    nameZh: entry.nameZh,
    category: entry.section === 'vowels' ? 'vowel' as const : 'consonant' as const,
  };
});
const isFavorite = computed(() => ipaFavorites.value.some((item) => item.entryId === favoriteEntry.value?.entryId));
const editorParams = ref<Record<TractParamName, number>>(defaultTractParams());
const editorExtras = ref<TractPoseExtras>(cloneTractExtras(DEFAULT_TRACT_EXTRAS));
const references = shallowRef<IpaReference[]>([]);
const referencesLoadFailed = ref(false);
const referencesLoading = ref(false);
const hasReferences = computed(() => references.value.some(item => item.exists));
const clickPlays = ref(false);
const draftEdited = ref(false);
let suppressKitReset = false;
const pendingUnsavedAction = ref<(() => void) | null>(null);
const unsavedGuardTitle = ref('');
const unsupportedRows = new Set(['内爆音','喷音','啧音']);
const unsupportedIds = computed(() => new Set(ipaConsonantMatrix.value?.rows.filter(r=>unsupportedRows.has(r.label))
  .flatMap(r=>r.cells.flatMap(c=>[...c.ids,...(c.rows?.flat() ?? [])]))));
const excludedPose = computed(() => Boolean(selectedEntry.value && (unsupportedIds.value.has(selectedEntry.value.id) || activeReference.value?.excluded)));
const trillDemos = shallowRef<{id:string; symbol:string; label:string}[]>([]);
const trillDemo = computed(() => trillDemos.value.find(x=>x.symbol.normalize('NFD')===selectedEntry.value?.display.normalize('NFD')));
const showReferenceLibrary = ref(false);
const referenceFilter = ref('');
const referenceMode = ref<'preset' | 'static' | 'motion'>('preset');
const poseSetOpen = ref(false);
const poseSetName = ref('');
const librarySelected = shallowRef<IpaReference | null>(null);
const baseReference = computed(() => librarySelected.value ?? (selectedEntry.value ? referencesForEntry(selectedEntry.value)[0] : undefined));
const personalRecordings = shallowRef(new Map<string, Blob>());
const personalRecordingsReady = ref(false);
const personalRecording = computed(() => baseReference.value ? personalRecordings.value.get(baseReference.value.id) : undefined);
const activeReference = computed(() => {
  const reference = baseReference.value;
  if (!reference || !personalRecording.value) return reference;
  return { ...reference, file: '个人录音.wav', exists: true, animation: false, has_textgrid: false, has_glottis: false, phones: [] };
});
watch(selectedIpaPoseSetId, async (setId, _, onCleanup) => {
  let active = true;
  onCleanup(() => { active = false; });
  personalRecordings.value = new Map();
  personalRecordingsReady.value = false;
  if (setId === RECORDED_IPA_SET_ID) return;
  try {
    const files = await listIpaPersonalRecordings(setId);
    if (active) {
      personalRecordings.value = files;
      personalRecordingsReady.value = true;
    }
  } catch {
    if (active) store.pushToast('无法读取此构型方案的个人录音', 'warning');
  }
}, { flush: 'sync', immediate: true });

async function changePersonalRecording(setId: string, referenceId: string, file?: Blob) {
  if (setId === RECORDED_IPA_SET_ID || !ipaPoseSets.value.some(set => set.id === setId)) throw new Error('构型方案已失效');
  if (file) await saveIpaPersonalRecording(setId, referenceId, file);
  else await removeIpaPersonalRecording(setId, referenceId);
  if (setId !== selectedIpaPoseSetId.value) return;
  const files = new Map(personalRecordings.value);
  if (file) files.set(referenceId, file);
  else files.delete(referenceId);
  personalRecordings.value = files;
}
const isVoqsDetail = computed(() => Boolean(activeReference.value?.voqs || selectedEntry.value?.system === 'voqs'));
const voqsChoices = computed(() => {
  if (!isVoqsDetail.value) return [];
  if (selectedEntry.value) return referencesForEntry(selectedEntry.value);
  return activeReference.value ? [activeReference.value] : [];
});
const voqsHeight = ref<number>();
watch(() => activeReference.value?.voqs_symbol, symbol => { voqsHeight.value = defaultVoqsHeight(symbol ?? ''); }, { immediate: true });
const referenceSvg = ref<SVGSVGElement | null>(null);
const referenceTrack = shallowRef<(RecordingTrack & { id: string }) | null>(null);
const referenceTime = ref(0);
const referenceStatus = ref('');
const recordingType = ref<'audio' | 'reconstruction' | 'revision'>('audio');
const recordingDemo = ref<{ id: string; title: string }>();
const recordingDuration = ref(0);
const recordingPlaying = ref(false);
const recordingStatus = ref('');
const recordingFile = shallowRef<Blob>();
const recordingLoading = ref(false);
const recordingQueued = ref(false);
const recordingRetry = ref(0);
const recordingLoudness = computed(() => synthesisGainMode.value === 'peak');
const canReconstructReference = computed(() => Boolean(activeReference.value?.animation && !excludedPose.value));
const canReconstructVoqs = computed(() => Boolean(activeReference.value?.voqs && activeReference.value.has_glottis));
const editTrack = computed(() => {
  const row = referenceTrack.value;
  return row && row.id === activeReference.value?.id && !isVoqsDetail.value && !recordingDemo.value ? row : null;
});
const hasFrameEditor = computed(() => Boolean(editTrack.value?.m27_50hz_pa.length));
const editOpen = ref(false);
const recordingLimits = shallowRef<RecordingLimits>();
const recordingKeys = shallowRef<RecordingKeyframe[]>([]);
const storedRecordingKeys = shallowRef<RecordingKeyframe[]>([]);
const editNotice = ref('');
const revisionBusy = ref(false);
const revisionMode = ref<VoiceRenderMode>('neural');
const recordingRevision = shallowRef<RecordingRevision>();
const revisionUrl = ref('');
const recordingTractHandles = ['tongue', 'blade', 'tip', 'hyoid', 'velum', 'jaw', 'side1', 'side2', 'side3'] as const;
const editedControlsMeta = computed(() => {
  const metadata = store.engineMeta.value;
  if (!metadata) return null;
  const bounds = new Map(recordingLimits.value?.fields.filter(field => field.index < 17).map(field => [field.key, field]));
  const parameters = Array.isArray(metadata.parameters) ? metadata.parameters.map(parameter => {
    const field = bounds.get(parameter.name);
    if (!field) return parameter;
    return { ...parameter, min: Math.max(parameter.min, field.min), max: field.max != null ? Math.min(parameter.max, field.max) : parameter.max };
  }) : metadata.parameters;
  return { ...metadata, parameters, speaker: 'JD2' };
});
let revisionAbort: AbortController | undefined;
const editSetName = computed(() => ipaPoseSets.value.find(item => item.id === selectedIpaPoseSetId.value)?.name ?? '');
const editClock = computed(() => recordingFrameAt(referenceTime.value, editTrack.value?.m27_50hz_pa.length ?? 0));
const steadyTargetFrame = computed(() => {
  const scope = editTrack.value;
  if (!scope?.m27_50hz_pa.length) return 0;
  const target = activeReference.value ? findTargetInterval(activeReference.value) : undefined;
  const centerSec = target ? 0.5 * (target.start_s + target.end_s) : 0.5 * scope.animation.duration_sec;
  return recordingFrameAt(centerSec, scope.m27_50hz_pa.length);
});
const defaultBellRadius = computed(() => {
  const scope = editTrack.value;
  const maxR = recordingLimits.value?.max_radius ?? 50;
  if (!scope?.m27_50hz_pa.length) return 12;
  const target = activeReference.value ? findTargetInterval(activeReference.value) : undefined;
  if (target) {
    return Math.max(6, Math.min(maxR, Math.round(0.5 * (target.end_s - target.start_s) * IPA_RECORDING_HZ)));
  }
  return Math.max(6, Math.min(maxR, Math.round(scope.m27_50hz_pa.length * 0.28)));
});

const editKey = computed(() => recordingKeys.value.find(item => item.frame === editClock.value));
const editSignature = computed(() => signatureForKeyframes(recordingKeys.value));
const editDirty = computed(() => editSignature.value !== signatureForKeyframes(storedRecordingKeys.value));
const hasRevisionChanges = computed(() => recordingKeys.value.some(item => Object.keys(item.values).length > 0));
const editControls = computed(() => {
  const rows = editTrack.value?.m27_50hz_pa;
  return rows?.length ? bellSuperimposedRow(rows, editClock.value, recordingKeys.value, recordingLimits.value?.fields ?? []) : [];
});
const hasEditedView = computed(() => editOpen.value && editControls.value.length > 0 && !recordingPlaying.value && !recordingQueued.value);
const editedViewParams = computed(() => recordingTractParams(editControls.value));
const referenceAnimation = computed<M27TrajectoryAnim | null>(() => recordingType.value === 'revision'
  ? recordingRevision.value?.animation ?? null : referenceTrack.value?.animation ?? null);
const recordingSource = computed(() => {
  const gain = synthesisGainMode.value;
  if (recordingDemo.value) return ipaReferenceUrl(recordingDemo.value.id, 'audio', gain);
  const item = activeReference.value;
  if (!item?.exists) return '';
  if (personalRecording.value) return personalRecording.value;
  if (recordingType.value === 'revision' && !isVoqsDetail.value) return revisionUrl.value;
  if (item.voqs && recordingType.value === 'reconstruction' && canReconstructVoqs.value) {
    return voqsReconstructionUrl(item.id, activeSpeaker.value, voqsHeight.value, gain);
  }
  return ipaReferenceUrl(
    item.id,
    recordingType.value === 'reconstruction' && canReconstructReference.value ? 'reconstruction' : 'audio',
    gain,
  );
});
const recordingTheme = computed(() => [store.resolvedColorMode.value, store.paletteId.value, store.surfaceStyle.value,
  store.customAccentHex.value].join('/'));
let referenceAudio: HTMLAudioElement | null = null;
let recordingObjectUrl = '';
let pendingReferenceTime: number | null = null;
let referenceEnd = Infinity;
let animationRequest = 0;
let referenceRaf = 0;
const visibleReferences = computed(() => {
  const q = referenceFilter.value.trim().toLowerCase();
  return references.value.filter(item => !q || `${item.id} ${item.title} ${item.group} ${item.prompt} ${item.file} ${item.issue}`.toLowerCase().includes(q));
});

function referencesForEntry(entry: CatalogEntry): IpaReference[] {
  return matchingIpaReferences(references.value, [entry.display, entry.insertText], entry.system === 'voqs',
    id => personalRecordings.value.has(id));
}

function restingReferenceMode(reference = activeReference.value): 'static' | 'preset' {
  return !draftEdited.value
    && Boolean(reference?.animation)
    && selectedIpaPoseSetId.value === RECORDED_IPA_SET_ID
    && !customIpaPoses.value[customPoseKey(selectedEntry.value?.id ?? '')]
    ? 'static' : 'preset';
}

watch(activeReference, reference => {
  recordingDemo.value = undefined;
  recordingType.value = 'audio';
  if (!draftEdited.value) referenceMode.value = restingReferenceMode(reference);
}, { flush: 'sync' });
const setOperation = ref<'copy' | 'rename'>('copy');
function editSet(mode: 'copy' | 'rename') {
  setOperation.value = mode;
  const name = ipaPoseSets.value.find(item => item.id === selectedIpaPoseSetId.value)?.name || '';
  poseSetName.value = mode === 'copy' ? name.replace('（只读）', '').trim() + ' 副本' : name;
  poseSetOpen.value = true;
}

async function ensureEditablePoseSet(): Promise<{ setId: string; createdName?: string } | null> {
  if (selectedIpaPoseSetId.value !== RECORDED_IPA_SET_ID) {
    return { setId: selectedIpaPoseSetId.value };
  }
  await loadDefaultIpaPoses();
  const edits = poseOverridesForSet(RECORDED_IPA_SET_ID);
  let name = '个人构型方案', suffix = 1;
  while (ipaPoseSets.value.some(set => set.name === name)) name = '个人构型方案 ' + ++suffix;
  const newId = createIpaPoseSet(name, ipaPoseSets.value[0]?.poses ?? {});
  if (!newId) return null;
  edits.forEach((ov) => {
    saveCustomIpaPose(ov);
    saveIpaPoseToSet(ov.symbol, tractRecordToArray19(ov.params), newId);
  });
  copyLinkedVowelRecordingsForSet(RECORDED_IPA_SET_ID, newId);
  return { setId: newId, createdName: name };
}

async function makeIpaSet() {
  const src = selectedIpaPoseSetId.value;
  if (setOperation.value === 'rename') {
    const ok = renameIpaPoseSet(src, poseSetName.value);
    if (ok) {
      poseSetOpen.value = false;
      poseSetName.value = '';
      store.pushToast('已更新构型方案名称', 'success');
    } else {
      store.pushToast('请填写唯一的构型方案名称', 'warning');
    }
    return;
  }
  await loadDefaultIpaPoses();
  const overrides = poseOverridesForSet(src);
  const newId = duplicateActiveIpaPoseSet(poseSetName.value, src);
  if (newId) {
    overrides.forEach((ov) => {
      saveCustomIpaPose({
        ...ov,
        params: { ...ov.params },
        extras: ov.extras ? cloneTractExtras(ov.extras) : undefined,
      });
      saveIpaPoseToSet(ov.symbol, tractRecordToArray19(ov.params), newId);
    });
    copyLinkedVowelRecordingsForSet(src, newId);
    poseSetOpen.value = false;
    poseSetName.value = '';
    store.pushToast('已基于当前构型建立副本，现在可自由微调各音标舌位', 'success');
  } else {
    store.pushToast('请填写不同的构型方案名称', 'warning');
  }
}
function removeActivePoseSet() {
  const targetId = selectedIpaPoseSetId.value;
  if (targetId === RECORDED_IPA_SET_ID) return;
  const targetName = ipaPoseSets.value.find((s) => s.id === targetId)?.name ?? '';
  const overrides = poseOverridesForSet(targetId);
  if (deleteIpaPoseSet(targetId)) {
    if (overrides.length) {
      const nextMap = { ...customIpaPoses.value };
      for (const ov of overrides) {
        delete nextMap[customPoseKey(ov.id, targetId)];
      }
      customIpaPoses.value = nextMap;
    }
    clearRecordingKeyframesForSet(targetId);
    clearLinkedVowelRecordingsForSet(targetId);
    void clearIpaPersonalRecordingsForSet(targetId).catch(() => undefined);
    poseSetOpen.value = false;
    store.pushToast(`已删除构型方案「${targetName}」`, 'info');
  }
}

watch(selectedIpaPoseSetId, () => {
  if (suppressKitReset) return;
  if (selectedEntry.value) setEntryPose(selectedEntry.value, true);
  referenceMode.value = 'preset';
});
watch(ipaPoseSets, () => {
  if (suppressKitReset) return;
  if (selectedEntry.value && !draftEdited.value) setEntryPose(selectedEntry.value, true);
});

function guardUnsavedChanges(action: () => void, label = '切换音标或构型方案'): void {
  if (!draftEdited.value && !editDirty.value) {
    action();
    return;
  }
  unsavedGuardTitle.value = label;
  pendingUnsavedAction.value = action;
}

async function confirmUnsavedSaveAndContinue(): Promise<void> {
  const next = pendingUnsavedAction.value;
  pendingUnsavedAction.value = null;
  if (draftEdited.value) await saveAsCustomPose();
  if (editDirty.value) await saveRecordingEdit();
  next?.();
}

function confirmUnsavedDiscardAndContinue(): void {
  const next = pendingUnsavedAction.value;
  pendingUnsavedAction.value = null;
  draftEdited.value = false;
  if (editDirty.value) {
    recordingKeys.value = storedRecordingKeys.value;
    editOpen.value = false;
    editNotice.value = '';
  }
  next?.();
}

function cancelUnsavedGuard(): void {
  pendingUnsavedAction.value = null;
}

function switchPoseSet(nextId: string): void {
  if (nextId === selectedIpaPoseSetId.value) return;
  guardUnsavedChanges(() => {
    selectIpaPoseSet(nextId);
  }, '切换构型方案');
}

function stopReferenceAudio() {
  recordingQueued.value = false;
  if (referenceAudio && !referenceAudio.paused) {
    referenceTime.value = referenceAudio.currentTime;
    referenceAudio.pause();
  }
  cancelAnimationFrame(referenceRaf);
  recordingPlaying.value = false;
}

function startPersonalRecording() {
  stopReferenceAudio();
}

function setRecordingLoudness(enabled: boolean) {
  synthesisGainMode.value = enabled ? 'peak' : 'original';
}

function disposeReferenceAudio() {
  stopReferenceAudio();
  if (referenceAudio) {
    referenceAudio.removeAttribute('src');
    referenceAudio.load();
    referenceAudio = null;
  }
}

function releaseRecordingFile() {
  disposeReferenceAudio();
  if (recordingObjectUrl) URL.revokeObjectURL(recordingObjectUrl);
  recordingObjectUrl = '';
  recordingFile.value = undefined;
}

function createReferenceAudio(url: string) {
  disposeReferenceAudio();
  if (!url) return;
  const player = new Audio();
  player.preload = 'metadata';
  referenceAudio = player;
  player.onloadedmetadata = () => {
    if (referenceAudio !== player) return;
    recordingDuration.value = Number.isFinite(player.duration) ? player.duration : 0;
    if (pendingReferenceTime !== null) {
      player.currentTime = Math.min(player.duration, pendingReferenceTime);
      pendingReferenceTime = null;
      referenceTime.value = player.currentTime;
    }
  };
  player.onseeked = () => {
    if (referenceAudio === player && pendingReferenceTime === null) {
      referenceTime.value = player.currentTime;
    }
  };
  player.onpause = () => {
    if (referenceAudio === player) {
      recordingPlaying.value = false;
      cancelAnimationFrame(referenceRaf);
    }
  };
  player.onended = () => {
    if (referenceAudio !== player) return;
    referenceTime.value = player.currentTime;
    referenceEnd = Infinity;
    stopReferenceAudio();
    if (!editOpen.value) {
      referenceMode.value = restingReferenceMode();
    }
  };
  player.onerror = () => { if (referenceAudio === player) recordingStatus.value = '所选录音暂时无法载入。'; };
  player.src = url;
  return player;
}

watch([recordingSource, recordingRetry, synthesisGainMode], async ([source, , gainMode], _, onCleanup) => {
  releaseRecordingFile();
  pendingReferenceTime = null;
  referenceEnd = Infinity;
  recordingStatus.value = '';
  recordingLoading.value = false;
  recordingDuration.value = 0;
  referenceTime.value = 0;
  if (!source) return;
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  recordingLoading.value = true;
  try {
    let file: Blob;
    if (typeof source === 'string') {
      const response = await fetch(source, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]) });
      if (!response.ok) throw new Error('Recording unavailable');
      file = await response.blob();
    } else {
      file = await normalizeAudioFile(source, 'personal.wav', gainMode);
    }
    if (controller.signal.aborted) return;
    const queued = recordingQueued.value;
    // One decoded recording supplies both the analysis and the seekable media player.
    recordingObjectUrl = URL.createObjectURL(file);
    createReferenceAudio(recordingObjectUrl);
    recordingFile.value = file;
    if (queued) void startRecording();
  } catch {
    if (!controller.signal.aborted) recordingStatus.value = '所选录音暂时无法载入。';
  } finally {
    if (!controller.signal.aborted) {
      recordingLoading.value = false;
      recordingQueued.value = false;
    }
  }
}, { flush: 'sync', immediate: true });

function chooseRecording(source: 'audio' | 'reconstruction' | 'revision') {
  if (source === 'revision' && !revisionUrl.value) return;
  if (source === 'reconstruction' && !canReconstructReference.value && !canReconstructVoqs.value) return;
  const at = recordingDemo.value ? 0 : referenceTime.value;
  recordingDemo.value = undefined;
  if (recordingType.value === source) return;
  recordingType.value = source;
  setRecordingTime(at);
}

function playRecordingSource(source: 'audio' | 'reconstruction' | 'revision') {
  if (source === 'revision' && !revisionUrl.value) return;
  if (source === 'reconstruction' && !canReconstructReference.value && !canReconstructVoqs.value) return;
  if (source === 'audio' && !recordingSource.value && !activeReference.value?.exists && !personalRecording.value) return;
  const sameSource = !recordingDemo.value && recordingType.value === source;
  if (sameSource) {
    if (recordingPlaying.value || recordingQueued.value) {
      stopReferenceAudio();
    } else {
      void startRecording();
    }
    return;
  }
  stopReferenceAudio();
  recordingDemo.value = undefined;
  recordingType.value = source;
  referenceEnd = Infinity;
  referenceTime.value = 0;
  void startRecording();
}

function showRecordingMotion() {
  if (!recordingDemo.value && canReconstructReference.value && selectedEntry.value?.system !== 'voqs') {
    referenceMode.value = 'motion';
  }
}

function setRecordingTime(time: number) {
  const player = referenceAudio;
  const at = Math.max(0, Math.min(recordingDuration.value || Infinity, time));
  referenceTime.value = at;
  if (player?.readyState) player.currentTime = at;
  else pendingReferenceTime = at;
}

function seekRecording(time: number) {
  referenceEnd = Infinity;
  showRecordingMotion();
  if (editOpen.value && editTrack.value) {
    stopReferenceAudio();
    setRecordingTime(recordingFrameAt(time, editTrack.value.m27_50hz_pa.length) / IPA_RECORDING_HZ);
  } else setRecordingTime(time);
}

function releaseRevision(restoreSound = true) {
  revisionAbort?.abort();
  revisionAbort = undefined;
  revisionBusy.value = false;
  if (restoreSound && recordingType.value === 'revision') {
    if (editTrack.value) chooseRecording('reconstruction');
    else recordingType.value = 'audio';
  }
  if (revisionUrl.value) URL.revokeObjectURL(revisionUrl.value);
  revisionUrl.value = '';
  recordingRevision.value = undefined;
}

watch([editTrack, selectedIpaPoseSetId], ([scope, kit]) => {
  if (suppressKitReset) return;
  releaseRevision();
  editOpen.value = false;
  editNotice.value = '';
  const loaded = scope ? loadRecordingKeyframes(kit, scope.id, scope.m27_50hz_pa.length) : [];
  storedRecordingKeys.value = loaded;
  recordingKeys.value = loaded;
}, { flush: 'sync' });

watch([editSignature, revisionMode], () => releaseRevision(), { flush: 'sync' });

async function openRecordingEditor() {
  if (!hasFrameEditor.value) return;
  const scope = editTrack.value, kit = selectedIpaPoseSetId.value;
  stopReferenceAudio();
  editOpen.value = true;
  referenceMode.value = 'motion';
  const initialFrame = referenceTime.value <= 0.001 ? steadyTargetFrame.value : editClock.value;
  seekRecording(initialFrame / IPA_RECORDING_HZ);
  if (!recordingLimits.value) {
    try { recordingLimits.value = await fetchRecordingLimits(); }
    catch (error) {
      if (scope === editTrack.value && kit === selectedIpaPoseSetId.value) {
        editNotice.value = error instanceof Error ? error.message : '关键帧参数范围暂不可用';
      }
    }
  }
}

function addRecordingFrame() {
  if (!editOpen.value || !editTrack.value || editKey.value || !recordingLimits.value) return;
  stopReferenceAudio();
  recordingKeys.value = [...recordingKeys.value, { frame: editClock.value, radius: defaultBellRadius.value, values: {} }]
    .sort((a, b) => a.frame - b.frame);
  editNotice.value = '';
}

function removeRecordingFrame() {
  if (!editKey.value) return;
  recordingKeys.value = recordingKeys.value.filter(item => item.frame !== editClock.value);
  editNotice.value = '';
}

function updateRecordingRadius(value: number) {
  const max = recordingLimits.value?.max_radius ?? 50;
  if (!Number.isInteger(value) || value < 0 || value > max) {
    editNotice.value = `余弦升窗半宽须为 0–${max} 帧`;
    return;
  }
  const current = editKey.value;
  if (current) {
    recordingKeys.value = recordingKeys.value.map(item => item === current ? { ...item, radius: value } : item);
  } else if (editTrack.value) {
    recordingKeys.value = [...recordingKeys.value, { frame: editClock.value, radius: value, values: {} }]
      .sort((a, b) => a.frame - b.frame);
  }
  editNotice.value = '';
}

function updateRecordingControls(delta: Record<string, number | undefined>) {
  if (!recordingLimits.value || !editTrack.value) return;
  stopReferenceAudio();
  const current = editKey.value;
  const values = { ...(current?.values ?? {}) };
  for (const [key, value] of Object.entries(delta)) {
    const field = recordingLimits.value.fields.find(item => item.key === key);
    if (!field) continue;
    const below = field.exclusiveMin ? (value !== undefined && value <= field.min) : (value !== undefined && value < field.min);
    const above = value !== undefined && field.max != null && value > field.max;
    if (value === undefined || !Number.isFinite(value) || below || above) {
      editNotice.value = field.max != null ? `${key} 须在 ${field.min}–${field.max} 之间` : `${key} 须大于 ${field.min}`;
      return;
    }
    values[key] = value;
  }
  if (current) {
    recordingKeys.value = recordingKeys.value.map(item => item === current ? { ...item, values } : item);
  } else {
    recordingKeys.value = [
      ...recordingKeys.value,
      { frame: editClock.value, radius: defaultBellRadius.value, values },
    ].sort((a, b) => a.frame - b.frame);
  }
  editNotice.value = '';
}

function updateRecordingPose(delta: TractDelta) {
  if (!recordingLimits.value || !editTrack.value) return;
  const current = editControls.value;
  const changed: Record<string, number> = {};
  for (const { key, index } of recordingLimits.value.fields) {
    if (index >= 17) continue;
    const value = delta[key as TractParamName];
    if (typeof value === 'number' && Math.abs(value - current[index]) > .0001) changed[key] = value;
  }
  if (Object.keys(changed).length) updateRecordingControls(changed);
}

async function saveRecordingEdit() {
  const scope = editTrack.value;
  if (!scope) return;
  const pendingKeys = recordingKeys.value.map((k) => ({ ...k, values: { ...k.values } }));
  let createdName: string | undefined;
  let targetSetId = selectedIpaPoseSetId.value;
  if (targetSetId === RECORDED_IPA_SET_ID) {
    suppressKitReset = true;
    try {
      const created = await ensureEditablePoseSet();
      if (!created) {
        editNotice.value = '未能自动创建可编辑的构型方案，请先手动新建方案后保存。';
        return;
      }
      targetSetId = created.setId;
      createdName = created.createdName;
    } finally {
      suppressKitReset = false;
    }
  }
  try {
    saveRecordingKeyframes(targetSetId, scope.id, scope.m27_50hz_pa.length, pendingKeys);
    recordingKeys.value = pendingKeys;
    storedRecordingKeys.value = pendingKeys;
    editNotice.value = createdName
      ? `默认方案为只读，已自动新建并切换至「${createdName}」并保存目标帧修订`
      : '已保存到当前录音与构型方案';
    if (createdName) {
      store.pushToast(`已自动新建并切换至「${createdName}」保存目标帧修订`, 'success');
    }
  } catch {
    editNotice.value = '本机浏览器未能保存关键帧，当前编辑仍可试听。';
  }
}

function cancelRecordingEdit() {
  recordingKeys.value = storedRecordingKeys.value;
  editOpen.value = false;
  editNotice.value = '';
}

async function previewRecordingEdit() {
  const scope = editTrack.value, kit = selectedIpaPoseSetId.value;
  if (!scope || !hasRevisionChanges.value || revisionBusy.value) return;
  releaseRevision();
  stopReferenceAudio();
  const controller = new AbortController();
  revisionAbort = controller;
  revisionBusy.value = true;
  editNotice.value = '';
  const matches = () => !controller.signal.aborted && revisionAbort === controller
    && editTrack.value === scope && selectedIpaPoseSetId.value === kit;
  try {
    const limits = recordingLimits.value ?? (await fetchRecordingLimits());
    recordingLimits.value = limits;
    const expandedRes = expandBellKeyframesForRender(scope.m27_50hz_pa, recordingKeys.value, limits.fields);
    if (!expandedRes.ok) {
      editNotice.value = expandedRes.error.hint;
      return;
    }
    const result = await renderRecordingRevision(scope.id, expandedRes.keyframes, revisionMode.value,
      store.computeDevice.value === 'cuda' ? 'cuda' : 'cpu', controller.signal);
    if (!matches()) return;
    recordingRevision.value = result;
    revisionUrl.value = URL.createObjectURL(result.audio);
    chooseRecording('revision');
    editNotice.value = `${voiceRenderLabels[result.mode]}已完成，正在保留前后协同动程试听修订音。`;
    await startRecording();
  } catch (error) {
    if (matches()) editNotice.value = error instanceof Error ? error.message : '修订重合成失败';
  } finally {
    if (matches()) {
      revisionBusy.value = false;
      revisionAbort = undefined;
    }
  }
}

/**
 * T-21: Apply edited static `editorParams` onto the selected target frame (default steady-state center `u ≈ 0.5`)
 * with a raised-cosine bell window and synthesize dynamic coarticulated audio.
 * Rejects out-of-range parameters explicitly rather than silently clamping.
 */
async function auditionBellDynamicFromPreset() {
  const scope = editTrack.value;
  if (!scope) return;
  await openRecordingEditor();
  if (!recordingLimits.value || editTrack.value !== scope) return;
  const targetFrame = referenceTime.value <= 0.001 ? steadyTargetFrame.value : editClock.value;
  seekRecording(targetFrame / IPA_RECORDING_HZ);
  const baseRow = scope.m27_50hz_pa[targetFrame];
  if (!baseRow) return;
  const delta: Record<string, number> = {};
  for (const field of recordingLimits.value.fields) {
    if (field.index >= 17) continue;
    const raw = editorParams.value[field.key as TractParamName];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    if (Math.abs(raw - baseRow[field.index]) <= 1e-4) continue;
    if (raw < field.min || (field.max != null && raw > field.max)) {
      editNotice.value = `${field.key} 当前值 ${Number(raw.toFixed(3))} 超出允许范围 [${field.min}, ${field.max}]，已拒绝静默截断，请先调整该器官位置`;
      store.pushToast(editNotice.value, 'warning');
      return;
    }
    delta[field.key] = raw;
  }
  if (!Object.keys(delta).length) {
    editNotice.value = '当前声道构型与目标帧基准一致，请先微调至少一个器官后再动态试听';
    return;
  }
  updateRecordingControls(delta);
  await previewRecordingEdit();
}

async function startRecording() {
  if (!recordingSource.value) return;
  if (!recordingObjectUrl && !recordingLoading.value) {
    const start = referenceTime.value, end = referenceEnd;
    recordingRetry.value++;
    pendingReferenceTime = start;
    referenceEnd = end;
  }
  if (recordingLoading.value && !recordingObjectUrl) {
    recordingQueued.value = true;
    showRecordingMotion();
    return;
  }
  let player = referenceAudio;
  if (!player || player.error) {
    player = createReferenceAudio(recordingObjectUrl) ?? null;
    if (player && referenceTime.value) setRecordingTime(referenceTime.value);
  }
  if (!player) return;
  if (pendingReferenceTime !== null && player.readyState < 1) {
    await new Promise<void>((resolve) => {
      const done = () => {
        player?.removeEventListener('loadedmetadata', done);
        player?.removeEventListener('error', done);
        resolve();
      };
      player!.addEventListener('loadedmetadata', done, { once: true });
      player!.addEventListener('error', done, { once: true });
    });
    if (referenceAudio !== player || player.error) return;
  }
  cancelAnimationFrame(referenceRaf);
  if (player.ended || (recordingDuration.value && referenceTime.value >= recordingDuration.value)) setRecordingTime(0);
  showRecordingMotion();
  recordingStatus.value = '';
  try {
    await player.play();
    if (referenceAudio !== player || player.paused) return;
    recordingPlaying.value = true;
    const tick = () => {
      if (referenceAudio !== player || player.paused) return;
      const time = player.currentTime;
      if (time >= referenceEnd) {
        setRecordingTime(referenceEnd);
        referenceEnd = Infinity;
        stopReferenceAudio();
      } else {
        referenceTime.value = time;
        referenceRaf = requestAnimationFrame(tick);
      }
    };
    tick();
  } catch (error) {
    if (referenceAudio === player && !(error instanceof DOMException && error.name === 'AbortError')) {
      recordingStatus.value = '参考录音无法播放。';
    }
  }
}

function toggleRecording() {
  if (recordingQueued.value || referenceAudio && !referenceAudio.paused) stopReferenceAudio();
  else void startRecording();
}

function chooseVoqsRecording(source: 'audio' | 'reconstruction') {
  if (recordingType.value === source) return;
  const time = referenceTime.value;
  const playing = recordingPlaying.value || recordingQueued.value;
  chooseRecording(source);
  setRecordingTime(time);
  if (playing) void startRecording();
}

function changeVoqsHeight(value: number) {
  if (voqsHeight.value === value) return;
  const time = referenceTime.value;
  const playing = recordingPlaying.value || recordingQueued.value;
  voqsHeight.value = value;
  if (recordingType.value === 'reconstruction') {
    setRecordingTime(time);
    if (playing) void startRecording();
  }
}

function applyLibraryReference(item: IpaReference) {
  stopReferenceAudio();
  librarySelected.value = item;
  const matches = catalog.value?.entries.filter(entry => referencesForEntry(entry).includes(item)) ?? [];
  const entry = matches.find(match => match.display === referenceTarget(item)) ?? matches[0];
  if (entry) {
    setEntryPose(entry);
  } else {
    draftEdited.value = false;
    selectedEntry.value = null;
  }
  if (item.animation) referenceMode.value = 'static';
  else referenceMode.value = 'preset';
}

function showLibraryReference(item: IpaReference) {
  if (librarySelected.value?.id === item.id) return;
  guardUnsavedChanges(() => applyLibraryReference(item), '切换参考录音');
}

function selectVoqsRecording(id: string) {
  const item = voqsChoices.value.find(recording => recording.id === id);
  if (item) showLibraryReference(item);
}

async function playReference(item: IpaReference, context: 'single' | 'medial' | 'full' = 'full'): Promise<void> {
  const personal = personalRecordings.value.has(item.id);
  if (!item.exists && !personal) return;
  stopReferenceAudio();
  if (activeReference.value?.id !== item.id) applyLibraryReference(item);
  chooseRecording('audio');
  const target = context === 'full' || personal ? undefined : findTargetInterval(item, context === 'medial');
  let start = target?.start_s ?? 0;
  let end = target?.end_s ?? Infinity;
  if (target && context === 'medial') {
    const i = item.phones.indexOf(target);
    const before = item.phones[i - 1], after = item.phones[i + 1];
    if (before?.label === 'a' && Math.abs(before.end_s - target.start_s) < .02) start = before.start_s;
    if (after?.label === 'a' && Math.abs(after.start_s - target.end_s) < .02) end = after.end_s;
  }
  referenceEnd = end;
  setRecordingTime(start);
  await startRecording();
}

watch([activeReference, canReconstructReference], ([reference, canReconstruct], _, onCleanup) => {
  const request = ++animationRequest;
  referenceTrack.value = null;
  referenceStatus.value = '';
  if (!canReconstruct || !reference?.exists) return;
  const timer = window.setTimeout(async () => {
    try {
      const data = await fetchIpaReferenceTrajectory(reference);
      if (request === animationRequest) referenceTrack.value = { ...data, id: reference.id };
    } catch (error) {
      if (request === animationRequest) referenceStatus.value = error instanceof Error ? error.message : '重建轨迹不可用';
    }
  }, 100);
  onCleanup(() => window.clearTimeout(timer));
}, { flush: 'sync' });

const displayedReferenceTime = computed(() => {
  const anim = referenceAnimation.value;
  if (!anim) return 0;
  if (referenceMode.value === 'motion') return Math.min(anim.duration_sec, referenceTime.value);
  const target = activeReference.value ? findTargetInterval(activeReference.value) : undefined;
  return target ? (target.start_s + target.end_s) / 2 : anim.duration_sec / 2;
});

const vowelMonitorTrack = computed(() => {
  if (selectedEntry.value?.section !== 'vowels' || personalRecording.value) return null;
  const track = recordingType.value === 'revision' ? recordingRevision.value : referenceTrack.value;
  if (!track?.m27_50hz_pa.length) return null;
  return {
    rows: track.m27_50hz_pa,
    key: `${activeReference.value?.id ?? selectedEntry.value.id}:${recordingType.value === 'revision' ? editSignature.value : 'base'}`,
  };
});

const vowelMonitorDynamic = computed(() =>
  selectedEntry.value?.section === 'vowels'
  && Boolean(vowelMonitorTrack.value)
  && !hasEditedView.value
  && (recordingPlaying.value || recordingQueued.value || referenceMode.value === 'motion'),
);

const vowelMonitorPose = computed(() => {
  if (selectedEntry.value?.section !== 'vowels') return null;
  if (hasEditedView.value) return { params: tractRecordToArray19(editedViewParams.value), ...DEFAULT_TRACT_EXTRAS };
  const track = recordingType.value === 'revision' ? recordingRevision.value : referenceTrack.value;
  if (referenceMode.value !== 'preset' && track?.m27_50hz_pa.length) {
    const anim = referenceAnimation.value;
    const target = activeReference.value ? findTargetInterval(activeReference.value) : undefined;
    const steadyTime = target ? (target.start_s + target.end_s) / 2 : (anim ? anim.duration_sec / 2 : 0);
    const row = track.m27_50hz_pa[recordingFrameAt(steadyTime, track.m27_50hz_pa.length)];
    return { params: tractRecordToArray19(recordingTractParams(row)), ...DEFAULT_TRACT_EXTRAS };
  }
  return { params: tractRecordToArray19(editorParams.value), ...editorExtras.value };
});
const vowelMonitorSpeaker = computed(() => hasEditedView.value || (referenceMode.value !== 'preset' && referenceTrack.value)
  ? 'JD2' : activeSpeaker.value);

watch([referenceSvg, referenceAnimation, referenceTime, referenceMode, store.resolvedColorMode,
  store.paletteId, store.surfaceStyle, store.customAccentHex, store.anatomyAppearance], () => {
  const svg = referenceSvg.value, anim = referenceAnimation.value;
  if (!svg) return;
  if (!anim) { svg.replaceChildren(); return; }
  const frame = interpM27AnimState(anim, displayedReferenceTime.value);
  if (frame) renderM27TractSvg(svg, anim, frame, { showGhost: false, showLabels: false, theme: readThemePalette(svg) });
}, { flush: 'post' });

// ===== Chart Partitioning (Aligned with PhoneticToolbox ChartView) =====
const ipaConsonantMatrix = computed(() =>
  catalog.value?.charts.ipa.find((c): c is MatrixChart => c.kind === 'matrix') ?? null,
);
const ipaVowelChart = computed(() =>
  catalog.value?.charts.ipa.find((c): c is VowelChart => c.kind === 'vowels') ?? null,
);
const ipaMarkCharts = computed(() =>
  (catalog.value?.charts.ipa.filter(
    (c): c is ListChart => c.kind === 'list',
  ) ?? []),
);

const extipaMatrix = computed(() =>
  catalog.value?.charts.extipa.find((c): c is MatrixChart => c.kind === 'matrix') ?? null,
);
const EXTIPA_MARK_IDS = new Set(['diacritics', 'voicing', 'articulatory']);
const EXTIPA_CONTEXT_IDS = new Set(['rhythm', 'uncertainty', 'other', 'combinations', 'historical']);
const extipaVisibleLists = computed(() => {
  const all = catalog.value?.charts.extipa.filter((c): c is ListChart => c.kind === 'list') ?? [];
  if (activeExtIpaSubSection.value === 'matrix') return [];
  if (activeExtIpaSubSection.value === 'marks') {
    return all.filter((c) => EXTIPA_MARK_IDS.has(c.id));
  }
  if (activeExtIpaSubSection.value === 'context') {
    return all.filter((c) => EXTIPA_CONTEXT_IDS.has(c.id));
  }
  const order = ['diacritics', 'voicing', 'articulatory', 'rhythm', 'uncertainty', 'other', 'combinations', 'historical'];
  return [...all].sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
});

const VOQS_ORDER = ['phonation', 'lingual', 'jaw', 'labial', 'airstream', 'velum', 'larynx', 'scope'];
const voqsOrderedLists = computed(() => {
  const lists = catalog.value?.charts.voqs.filter((c): c is ListChart => c.kind === 'list') ?? [];
  return [...lists].sort((a, b) => {
    const ia = VOQS_ORDER.indexOf(a.id);
    const ib = VOQS_ORDER.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
});
const voqsPhonationChart = computed(() =>
  voqsOrderedLists.value.find((c) => c.id === 'phonation') ?? null,
);
const voqsScopeChart = computed(() =>
  voqsOrderedLists.value.find((c) => c.id === 'scope') ?? null,
);
const voqsMiddleCharts = computed(() =>
  voqsOrderedLists.value.filter((c) => c.id !== 'phonation' && c.id !== 'scope'),
);

const searchMatches = computed<CatalogEntry[]>(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q || !catalog.value) return [];
  return catalog.value.entries
    .filter((e) => {
      if (e.display.toLowerCase().includes(q) || e.insertText.toLowerCase().includes(q)) return true;
      if (e.nameZh.toLowerCase().includes(q) || e.nameEn.toLowerCase().includes(q)) return true;
      if (e.codePoints.some((cp) => cp.toLowerCase().includes(q))) return true;
      if (e.aliases?.some((a) => a.toLowerCase().includes(q))) return true;
      return false;
    })
    .slice(0, 120);
});

const activeCustomPoseIds = computed(() =>
  new Set(poseOverridesForSet(selectedIpaPoseSetId.value).map((ov) => ov.id)),
);

const hasCustomPoseForSelected = computed(() =>
  selectedEntry.value ? activeCustomPoseIds.value.has(selectedEntry.value.id) : false,
);

const customSavedCount = computed(() => activeCustomPoseIds.value.size);

const isLongHeroExample = computed(() => {
  const entry = selectedEntry.value;
  if (!entry) return false;
  return Boolean(entry.isExample && Array.from(entry.display).length > 10);
});

const selectedSources = computed<ResolvedSourceRef[]>(() => {
  const entry = selectedEntry.value;
  if (!entry?.sourceRefs?.length) return [];
  const srcMap = catalog.value?.sources ?? {};
  return entry.sourceRefs.map((refItem, idx) => {
    const meta = srcMap[refItem.sourceId];
    return {
      key: `${refItem.sourceId}_${idx}`,
      sourceId: refItem.sourceId,
      locator: refItem.locatorZh || refItem.locator || '',
      title: refItem.title || meta?.title || refItem.sourceId,
      url: refItem.url || meta?.url,
    };
  });
});

function resolvedNotationStatus(entry: CatalogEntry): 'combination' | 'historical' | null {
  if (entry.notationStatus === 'combination' || entry.notationStatus === 'historical') {
    return entry.notationStatus;
  }
  if (entry.section === 'historical') return 'historical';
  if (entry.section === 'combinations') return 'combination';
  return null;
}

function notationStatusLabel(status: 'combination' | 'historical' | null): string {
  if (status === 'combination') return '组合输入示例 · 沿用既有字母与附加符号';
  if (status === 'historical') return '旧版文献记号 · 未列入当前2025基本表';
  return '';
}

function getGroupStarts(chart: MatrixChart): Set<number> {
  const starts = new Set<number>();
  if (!chart.columnGroups?.length) return starts;
  let offset = 0;
  for (let i = 0; i < chart.columnGroups.length; i++) {
    if (i > 0) starts.add(offset);
    offset += chart.columnGroups[i].span;
  }
  return starts;
}

function cellStartCol(cells: MatrixCell[], idx: number): number {
  let col = 0;
  for (let i = 0; i < idx; i++) col += cells[i].span ?? 1;
  return col;
}

function isColGroupStart(chart: MatrixChart, colIdx: number): boolean {
  return getGroupStarts(chart).has(colIdx);
}

function isCellGroupStart(chart: MatrixChart, cells: MatrixCell[], cellIdx: number): boolean {
  return getGroupStarts(chart).has(cellStartCol(cells, cellIdx));
}

function isStandaloneDiacriticEntry(entry: CatalogEntry | null): boolean {
  if (!entry || entry.system === 'voqs' || entry.isExample) return false;
  if (entry.insertionMode === 'bridge' || entry.insertionMode === 'paired-span') return false;
  return entry.insertionMode === 'combining' || entry.section === 'diacritics';
}

function entryPreviewSymbol(entry: CatalogEntry): string {
  if (isStandaloneDiacriticEntry(entry)) {
    const example = entry.examples?.[0]?.text?.trim();
    if (example) return example;
  }
  return entry.insertText || entry.display;
}

function setEntryPose(entry: CatalogEntry, refresh = false): void {
  if (!refresh && selectedEntry.value?.id === entry.id) return;
  draftEdited.value = false;
  selectedEntry.value = entry;
  if (entry.system === 'voqs' || unsupportedIds.value.has(entry.id)) return;
  const previewSym = entryPreviewSymbol(entry);
  const full = getFullPoseForIpa(previewSym, entry.id, activeSpeaker.value);
  editorParams.value = { ...full.params };
  editorExtras.value = cloneTractExtras(full.extras);
}

function writeVoqsToTimeline(profile: VoqsProfile, take: VoqsTake, height?: number) {
  const current = store.phonationAnchors.value.find(anchor => anchor.id === store.selectedPhonationAnchorId.value);
  writeRecordedVoqs(store, profile, take, store.playheadSmp.value, current, height);
}

function selectEntry(entry: CatalogEntry): void {
  stopReferenceAudio();
  hideHoverCard();
  librarySelected.value = null;
  setEntryPose(entry);
  const reference = referencesForEntry(entry)[0];
  if (clickPlays.value && reference) void playReference(reference, 'full');
}

async function copyEntrySymbol(entry: CatalogEntry): Promise<void> {
  if (await copyTextToClipboard(entry.insertText || entry.display)) {
    store.pushToast(`已复制 [${entry.display}]`, 'info', 1600);
  } else {
    store.pushToast('无法写入剪贴板，请检查浏览器权限', 'warning');
  }
}

function activateEntry(entry?: CatalogEntry): void {
  if (!entry) return;
  if (selectedEntry.value?.id === entry.id && !librarySelected.value) {
    if (clickPlays.value) {
      const reference = referencesForEntry(entry)[0];
      if (reference) void playReference(reference, 'full');
    }
    return;
  }
  guardUnsavedChanges(() => selectEntry(entry), `切换至 [${entry.display}]`);
}

function switchSystem(next: 'ipa' | 'extipa' | 'voqs') {
  showReferenceLibrary.value = false;
  hideHoverCard();
  if (next === 'voqs') {
    openVoqsCatalog();
    return;
  }
  activeSystem.value = next;
}

function openVoqsCatalog() {
  showReferenceLibrary.value = false;
  activeSystem.value = 'voqs';
  hideHoverCard();
  if (isVoqsDetail.value) return;
  const initial = voqsPhonationChart.value?.ids?.[0];
  const entry = initial ? getEntryById(initial) : undefined;
  if (entry) activateEntry(entry);
}

watch(searchQuery, (q) => {
  if (q.trim() && showReferenceLibrary.value) {
    showReferenceLibrary.value = false;
  }
});

function getEntryById(id: string): CatalogEntry | undefined {
  return entryMap.value.get(id);
}

// ===== Viewport-Adaptive Hover Card (#ipaHoverCard, calibrated with getCurrentPageScale()) =====
const hoverEntry = ref<CatalogEntry | null>(null);
const hoverCardRef = ref<HTMLElement | null>(null);
const hoverStyle = ref<Record<string, string>>({});
let lastHoverAnchor: HTMLElement | null = null;
let lastHoverPointer: { x: number; y: number } | null = null;

function updateHoverPosition(): void {
  if (!hoverEntry.value || !lastHoverAnchor) return;
  const scale = getCurrentPageScale();
  const rect = lastHoverAnchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = Math.round(10 * scale);
  const gap = Math.round(10 * scale);

  const unscaledW = Math.min(340, Math.max(240, Math.floor((vw - margin * 2) / scale)));
  const visualW = unscaledW * scale;
  const maxUnscaledH = Math.max(160, Math.floor((vh - margin * 2) / scale));
  const measuredUnscaledH = hoverCardRef.value
    ? Math.min(maxUnscaledH, hoverCardRef.value.offsetHeight)
    : 220;
  const visualH = measuredUnscaledH * scale;

  const rightSpace = vw - margin - (rect.right + gap);
  const leftSpace = rect.left - gap - margin;

  let left: number;
  let top: number;

  if (rightSpace >= visualW || leftSpace >= visualW) {
    const placeRight = rightSpace >= visualW || rightSpace >= leftSpace;
    left = placeRight ? rect.right + gap : rect.left - gap - visualW;
    const anchorY = lastHoverPointer ? lastHoverPointer.y - 22 * scale : rect.top - 8 * scale;
    top = Math.max(margin, Math.min(anchorY, vh - margin - visualH));
  } else {
    const belowSpace = vh - margin - (rect.bottom + gap);
    const aboveSpace = rect.top - gap - margin;
    const placeBelow = belowSpace >= visualH || belowSpace >= aboveSpace;
    top = placeBelow
      ? Math.min(rect.bottom + gap, Math.max(margin, vh - margin - visualH))
      : Math.max(margin, rect.top - gap - visualH);
    const anchorX = lastHoverPointer ? lastHoverPointer.x - 24 * scale : rect.left;
    left = Math.max(margin, Math.min(anchorX, vw - margin - visualW));
  }

  hoverStyle.value = {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    width: `${unscaledW}px`,
    maxHeight: `${maxUnscaledH}px`,
    transform: scale === 1 ? 'none' : `scale(${scale})`,
    transformOrigin: 'top left',
  };
}

function showHoverCard(entry: CatalogEntry, e: MouseEvent): void {
  hoverEntry.value = entry;
  lastHoverAnchor = e.currentTarget as HTMLElement | null;
  lastHoverPointer = { x: e.clientX, y: e.clientY };
  updateHoverPosition();
  void nextTick(() => updateHoverPosition());
}

async function playRendered(id:string, resource:'reconstruction' | 'audio') {
  stopReferenceAudio();
  if (resource === 'reconstruction') {
    if (activeReference.value?.id !== id || !canReconstructReference.value) return;
    chooseRecording('reconstruction');
  } else {
    const demo = trillDemos.value.find(item => item.id === id);
    if (!demo) return;
    recordingDemo.value = { id, title: demo.label };
    referenceMode.value = canReconstructReference.value ? 'static' : 'preset';
  }
  referenceEnd = Infinity;
  setRecordingTime(0);
  await startRecording();
}

function hideHoverCard(): void {
  hoverEntry.value = null;
  lastHoverAnchor = null;
  lastHoverPointer = null;
}

// ===== Right Panel Actions =====
function onTractUpdate(delta: TractDelta): void {
  draftEdited.value = true;
  editorParams.value = { ...editorParams.value, ...delta };
}

function onExtrasUpdate(ex: TractPoseExtras): void {
  draftEdited.value = true;
  editorExtras.value = cloneTractExtras(ex);
}

async function auditionSingle(): Promise<void> {
  if (activeReference.value?.exists) { await playReference(activeReference.value, 'single'); return; }
  if (!selectedEntry.value) return;
  store.currentTractExtras.value = cloneTractExtras(editorExtras.value);
  const buf = await store.synthesizeRange({
    speaker: activeSpeaker.value,
    tractParams: editorParams.value,
    durationMs: 480,
    f0Hz: store.currentGlottisParams.value.f0_hz,
  });
  if (buf) await store.playAudioBuffer(buf);
}

async function auditionAcaContext(): Promise<void> {
  if (activeReference.value) await playReference(activeReference.value, 'medial');
}

function writeToTimelinePhoneme(): void {
  const entry = selectedEntry.value;
  if (!entry) return;
  const combiningDiacritic = isStandaloneDiacriticEntry(entry);
  const ex = cloneTractExtras(editorExtras.value);
  store.currentTractExtras.value = ex;
  const clip = store.project.value.clips[store.activeClipId.value];
  const selIds = store.selectedPhonemeIds.value;
  if (!clip || selIds.length === 0) {
    store.pushToast(
      combiningDiacritic
        ? '请先在时间轴选中至少一个音素，再叠加附加符号'
        : '时间轴未选中音素，已先将当前构型载入全局预览',
      'info',
    );
    store.currentTractParams.value = { ...editorParams.value };
    void store.requestVtlPose(editorParams.value, activeSpeaker.value, ex);
    return;
  }
  const cloned = JSON.parse(JSON.stringify(clip)) as Clip;
  const vec19 = tractRecordToArray19(editorParams.value);
  const markText = entry.insertText || entry.display;
  let count = 0;
  let lastCombined: {
    ipa: string;
    params?: number[];
    lip_width?: number;
    larynx_height_cm?: number;
    manual_root?: boolean;
    tongue_shape?: number[];
    lip_shape?: number[];
  } | null = null;
  for (const sid of cloned.syllable_order) {
    const syl = cloned.syllables[sid];
    if (!syl) continue;
    for (let idx = 0; idx < syl.segments.length; idx++) {
      const seg = syl.segments[idx];
      if (!selIds.includes(seg.id)) continue;
      if (combiningDiacritic) {
        if (seg.role === 'rest' || seg.ipa === 'sil') continue;
        const combinedIpa = combineIpaDiacritic(seg.ipa, markText);
        if (!combinedIpa) continue;
        const updated = replaceSegmentIpa(seg, combinedIpa, activeSpeaker.value);
        syl.segments[idx] = updated;
        syl.ipa[idx] = updated.ipa;
        lastCombined = updated;
        count++;
        continue;
      }
      const updated = replaceSegmentIpa(seg, markText, activeSpeaker.value, entry.id);
      syl.segments[idx] = { ...updated, params: [...vec19], lip_width: ex.lip_width, larynx_height_cm: ex.larynx_height,
        tongue_shape: [...ex.tongue_shape], lip_shape: [...ex.lip_shape] };
      syl.ipa[idx] = updated.ipa;
      count++;
    }
  }
  if (!count) {
    if (combiningDiacritic) {
      store.pushToast('所选区间均为休止段，无法叠加附加符号', 'warning');
    }
    return;
  }
  const res = store.executeCommand({
    type: 'clip.edit',
    label: combiningDiacritic
      ? `叠加 [${entry.display}] 至时间轴 (${count} 音素)`
      : `写入 [${entry.display}] 至时间轴 (${count} 音素)`,
    payload: { clip: cloned },
  });
  if (!res.ok) return;
  if (combiningDiacritic && lastCombined?.params?.length === 19) {
    const combinedRec = tractArray19ToRecord(lastCombined.params);
    const combinedExtras = cloneTractExtras({
      lip_width: lastCombined.lip_width,
      larynx_height: lastCombined.larynx_height_cm,
      manual_root: lastCombined.manual_root,
      tongue_shape:
        Array.isArray(lastCombined.tongue_shape) && lastCombined.tongue_shape.length === 4
          ? (lastCombined.tongue_shape as [number, number, number, number])
          : undefined,
      lip_shape:
        Array.isArray(lastCombined.lip_shape) && lastCombined.lip_shape.length === 4
          ? (lastCombined.lip_shape as [number, number, number, number])
          : undefined,
    });
    store.currentTractParams.value = combinedRec;
    store.currentTractExtras.value = combinedExtras;
    void store.requestVtlPose(combinedRec, activeSpeaker.value, combinedExtras);
    store.pushToast(
      count === 1
        ? `已将附加符号 [${entry.display}] 叠加至 [${lastCombined.ipa}]`
        : `已将附加符号 [${entry.display}] 叠加至 ${count} 个音素（如 [${lastCombined.ipa}]）`,
      'success',
    );
    return;
  }
  void store.requestVtlPose(editorParams.value, activeSpeaker.value, ex);
  store.pushToast(`已将 [${entry.display}] (${entry.nameZh}) 写入当前时间轴音素`, 'success');
}

async function saveAsCustomPose(): Promise<void> {
  const entry = selectedEntry.value;
  if (!entry) return;
  const paramsSnapshot = { ...editorParams.value };
  const extrasSnapshot = cloneTractExtras(editorExtras.value);
  let createdName: string | undefined;
  let targetSetId = selectedIpaPoseSetId.value;
  if (targetSetId === RECORDED_IPA_SET_ID) {
    suppressKitReset = true;
    try {
      const created = await ensureEditablePoseSet();
      if (!created) {
        store.pushToast('未能自动创建可编辑的构型方案', 'warning');
        return;
      }
      targetSetId = created.setId;
      createdName = created.createdName;
    } finally {
      suppressKitReset = false;
    }
  }
  const sym = entry.insertText || entry.display;
  saveCustomIpaPose({
    id: entry.id,
    symbol: sym,
    nameZh: entry.nameZh,
    system: entry.system,
    params: paramsSnapshot,
    extras: extrasSnapshot,
    savedAt: Date.now(),
  });
  saveIpaPoseToSet(sym, tractRecordToArray19(paramsSnapshot), targetSetId);
  editorParams.value = paramsSnapshot;
  editorExtras.value = extrasSnapshot;
  draftEdited.value = false;
  store.pushToast(
    createdName
      ? `默认方案为只读，已自动新建并切换至「${createdName}」并保存 [${entry.display}] 构型`
      : `已保存 ${entry.system.toUpperCase()} 自定义构型 [${entry.display}] · ${entry.nameZh}`,
    'success',
  );
}

const poseIsProtected = computed(() => {
  const entry = selectedEntry.value;
  return Boolean(entry && getProtectedIpaPose(entry.insertText || entry.display));
});

async function togglePoseProtection(): Promise<void> {
  const entry = selectedEntry.value;
  if (!entry || selectedIpaPoseSetId.value === RECORDED_IPA_SET_ID) return;
  const symbol = entry.insertText || entry.display;
  const enabled = !poseIsProtected.value;
  if (enabled && !setIpaPoseProtected(symbol, true)) {
    await saveAsCustomPose();
  }
  if (Boolean(getProtectedIpaPose(symbol)) !== enabled && !setIpaPoseProtected(symbol, enabled)) {
    store.pushToast('无法保护当前构型，请先保存构型', 'warning');
    return;
  }
  store.pushToast(enabled ? '已保护 [' + entry.display + '] 的构型' : '已取消 [' + entry.display + '] 的构型保护', 'info');
}

const linkedVowelId = computed(() => {
  void linkedVowelRecordings.value;
  return selectedEntry.value ? getLinkedVowelRecording(selectedEntry.value.id) : undefined;
});
const canLinkVowelRecording = computed(() => !personalRecording.value && selectedIpaPoseSetId.value !== RECORDED_IPA_SET_ID &&
  selectedEntry.value?.section === 'vowels' && activeReference.value?.exists && !draftEdited.value);

function selectMeasuredVowel(id: string) {
  const item = references.value.find(recording => recording.id === id);
  if (item) showLibraryReference(item);
}

async function linkVowelRecording() {
  const entry = selectedEntry.value, recording = activeReference.value, setId = selectedIpaPoseSetId.value;
  if (!entry || !recording || !canLinkVowelRecording.value) return;
  const symbol = entry.insertText || entry.display;
  const measurements = await loadRecordedVowelFormants().catch(() => []);
  if (entry !== selectedEntry.value || recording !== activeReference.value || setId !== selectedIpaPoseSetId.value || draftEdited.value) return;
  if (!measurements.some(item => item.id === recording.id && vowelSymbolKey(item.symbol) === vowelSymbolKey(symbol))) {
    store.pushToast('该录音暂无有效的实测 F1/F2', 'info');
    return;
  }
  setLinkedVowelRecording(entry.id, recording.id, setId);
  store.pushToast(`[${entry.display}] 已关联实测 F1/F2`, 'success');
}

function removeCustomPose(): void {
  const entry = selectedEntry.value;
  if (!entry) return;
  const sym = entry.insertText || entry.display;
  deleteCustomIpaPose(entry.id);
  resetIpaPoseInSet(sym, selectedIpaPoseSetId.value);
  draftEdited.value = false;
  const full = getFullPoseForIpa(entryPreviewSymbol(entry), entry.id, activeSpeaker.value);
  editorParams.value = { ...full.params };
  editorExtras.value = cloneTractExtras(full.extras);
  store.pushToast(`已恢复 [${entry.display}] 默认构型`, 'info');
}

watch(
  [ptbPresetsVersion, activeSpeaker],
  ([, spk], [, prevSpk]) => {
    if (spk !== prevSpk) {
      void preloadPtbIpaPresets(spk);
    }
    const entry = selectedEntry.value;
    if (!entry || draftEdited.value || customIpaPoses.value[customPoseKey(entry.id)] || entry.system === 'voqs' || excludedPose.value) return;
    const full = getFullPoseForIpa(entryPreviewSymbol(entry), entry.id, spk);
    editorParams.value = { ...full.params };
    editorExtras.value = cloneTractExtras(full.extras);
  },
);

async function loadEngineAssets(force = false): Promise<void> {
  if (referencesLoading.value) return;
  if (!force && references.value.length > 0 && !referencesLoadFailed.value) return;
  referencesLoading.value = true;
  try {
    const [refsRes, trillsRes] = await Promise.allSettled([
      fetchIpaReferences(),
      fetch('/api/models/ipa-references/trill-demos', { signal: AbortSignal.timeout(10000) })
        .then(async (r) => (r.ok ? ((await r.json()).records ?? []) : [])),
      loadDefaultIpaPoses(),
    ]);
    if (refsRes.status === 'fulfilled') {
      references.value = refsRes.value;
      referencesLoadFailed.value = false;
    } else {
      referencesLoadFailed.value = true;
    }
    if (trillsRes.status === 'fulfilled' && Array.isArray(trillsRes.value)) {
      trillDemos.value = trillsRes.value;
    }
  } finally {
    referencesLoading.value = false;
  }
}

watch(
  () => store.engineStatus.value,
  (status) => {
    if (status === 'python-vtl' && (referencesLoadFailed.value || !references.value.length)) {
      void loadEngineAssets(true);
    }
  },
);

function onWindowKeyDown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null;
  const inEditable = Boolean(
    target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable),
  );
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    searchInputRef.value?.focus();
    searchInputRef.value?.select();
    return;
  }
  if (e.key === 'Escape') {
    if (pendingUnsavedAction.value) {
      e.preventDefault();
      cancelUnsavedGuard();
    } else if (poseSetOpen.value) {
      e.preventDefault();
      poseSetOpen.value = false;
    } else if (showReferenceLibrary.value) {
      e.preventDefault();
      showReferenceLibrary.value = false;
    } else if (searchQuery.value.trim()) {
      e.preventDefault();
      searchQuery.value = '';
    }
    return;
  }
  if (!inEditable && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === ' ' || e.key.toLowerCase() === 'p')) {
    if (target?.tagName === 'BUTTON' && e.key === ' ') return;
    if (recordingSource.value) {
      e.preventDefault();
      toggleRecording();
    } else if (selectedEntry.value && selectedEntry.value.system !== 'voqs' && !excludedPose.value) {
      e.preventDefault();
      void auditionSingle();
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c' && !inEditable) {
    const sel = window.getSelection()?.toString();
    if (!sel && selectedEntry.value) {
      e.preventDefault();
      void copyEntrySymbol(selectedEntry.value);
    }
  }
}

async function handleIpaTourAction(ev: Event): Promise<void> {
  const detail = (ev as CustomEvent<{
    actionId?: string;
    pageId?: string;
    done?: (ok?: boolean) => void;
  }>).detail;
  if (!detail || detail.pageId !== 'ipa') return;
  try {
    if (detail.actionId === 'ipa-tour-select-y') {
      showReferenceLibrary.value = false;
      searchQuery.value = '';
      activeSystem.value = 'ipa';
      activeIpaSubSection.value = 'main';
      const entryY = catalog.value?.entries.find((e) => e.display === 'y' && e.section === 'vowels');
      if (entryY) selectEntry(entryY);
      await nextTick();
      vowelsRowRef.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      store.pushToast('已切换至前高圆唇元音 [y]，可对比与 [i] 的圆唇 F2/F3 差异', 'success', 2800);
      detail.done?.(true);
      return;
    }
    if (detail.actionId === 'ipa-tour-play-current') {
      if (recordingSource.value) {
        if (activeReference.value?.animation) referenceMode.value = 'motion';
        await startRecording();
      } else if (selectedEntry.value && selectedEntry.value.system !== 'voqs' && !excludedPose.value) {
        await auditionSingle();
      } else {
        store.pushToast('当前音标暂无本地实录音频，请切换至含实录的音标后再试听', 'info', 2400);
      }
      detail.done?.(true);
      return;
    }
    if (detail.actionId === 'ipa-tour-preview-voqs') {
      showReferenceLibrary.value = false;
      searchQuery.value = '';
      activeSystem.value = 'voqs';
      const breathy =
        catalog.value?.entries.find((e) => e.system === 'voqs' && (e.display === 'V̤' || e.insertText === 'V̤'))
        ?? catalog.value?.entries.find((e) => e.system === 'voqs' && referencesForEntry(e).length > 0)
        ?? catalog.value?.entries.find((e) => e.system === 'voqs');
      if (breathy) selectEntry(breathy);
      store.pushToast('已切换至 VoQS 实录声门面板，右侧可查看 50 Hz 十维声门曲线', 'success', 2800);
      detail.done?.(true);
      return;
    }
  } catch {
    detail.done?.(false);
  }
}

onMounted(async () => {
  void loadEngineAssets(true);
  window.addEventListener('resize', hideHoverCard);
  window.addEventListener('keydown', onWindowKeyDown);
  window.addEventListener('vocalcut:tour-action', handleIpaTourAction);
  void preloadPtbIpaPresets(activeSpeaker.value);
  try {
    const resp = await fetch('/data/ipa-plus-catalog.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as CatalogPayload;
    catalog.value = data;
    const initial = data.entries.find((e) => e.display === 'i') ?? data.entries[0] ?? null;
    if (initial) setEntryPose(initial);
  } catch (err) {
    loadErr.value = `无法加载 655 条目国际音标目录: ${String(err)}`;
  } finally {
    loading.value = false;
  }
});

watchEffect(() => {
  const entry = selectedEntry.value;
  if (!entry) return;
  const refRec = activeReference.value;
  publishPanelSnapshot('ipa', {
    symbol: entry.display,
    system: entry.system,
    nameZh: entry.nameZh,
    nameEn: entry.nameEn,
    section: entry.section,
    codePoints: entry.codePoints ? [...entry.codePoints] : undefined,
    descriptionZh: entry.descriptionZh,
    usageZh: entry.usageZh,
    contrastZh: entry.contrastZh,
    notesZh: entry.notesZh,
    representation: entry.representation,
    aliases: entry.aliases ? [...entry.aliases] : undefined,
    examples: entry.examples,
    sourceRefs: selectedSources.value.map((s) => ({ title: s.title, locator: s.locator })),
    params: { ...editorParams.value },
    extras: cloneTractExtras(editorExtras.value),
    referenceId: refRec?.id,
    referenceTitle: refRec?.title,
    referenceHasAudio: Boolean(refRec?.exists),
    referenceHasAnimation: Boolean(refRec?.animation),
    referencePhones: refRec?.phones?.length ? refRec.phones.map((p) => ({ ...p })) : undefined,
    recordingBlob: recordingRevision.value?.audio ?? personalRecording.value ?? recordingFile.value ?? null,
    recordingDuration_s: recordingDuration.value,
    m27RowsPa: editTrack.value?.m27_50hz_pa,
  });
});

onBeforeUnmount(() => {
  releaseRevision(false);
  releaseRecordingFile();
  animationRequest++;
  window.removeEventListener('resize', hideHoverCard);
  window.removeEventListener('keydown', onWindowKeyDown);
  window.removeEventListener('vocalcut:tour-action', handleIpaTourAction);
});
</script>

<template>
  <!-- Translucent outer wrapper over the workspace backdrop -->
  <div class="ipa-overlay-shell" :style="{ '--ipa-fs': `${fontSizePx}px` }">
    <!-- Top Header Strip -->
    <div class="panel ipa-topbar" data-tour="ipa-topbar">
      <div class="ipa-tb-left" data-tour="ipa-system-tabs">
        <button type="button" class="btn sm" @click="guardUnsavedChanges(() => { store.researchTab.value = 'main'; }, '返回标注工作台')">
          <IconSvg name="arrow-left" :size="13" />
          <span>返回标注</span>
        </button>

        <div class="seg control-seg sm">
          <button
            type="button"
            :class="{ active: !showReferenceLibrary && activeSystem === 'ipa' }"
            @click="switchSystem('ipa')"
          >
            IPA ({{ catalog?.systems.ipa ?? 381 }})
          </button>
          <button
            type="button"
            :class="{ active: !showReferenceLibrary && activeSystem === 'extipa' }"
            @click="switchSystem('extipa')"
          >
            extIPA ({{ catalog?.systems.extipa ?? 209 }})
          </button>
          <button
            type="button"
            :class="{ active: !showReferenceLibrary && activeSystem === 'voqs' }"
            @click="switchSystem('voqs')"
          >
            VoQS ({{ catalog?.systems.voqs ?? 65 }})
          </button>
        </div>

        <div v-if="!showReferenceLibrary && activeSystem === 'ipa' && !searchQuery.trim()" class="seg control-seg sm">
          <button
            type="button"
            :class="{ active: activeIpaSubSection === 'main' }"
            @click="activeIpaSubSection = 'main'; hideHoverCard()"
          >
            辅音矩阵 + 元音图
          </button>
          <button
            type="button"
            :class="{ active: activeIpaSubSection === 'diacritics' }"
            @click="activeIpaSubSection = 'diacritics'; hideHoverCard()"
          >
            附加·超音段·声调
          </button>
        </div>

        <div v-else-if="!showReferenceLibrary && activeSystem === 'extipa' && !searchQuery.trim()" class="seg control-seg sm">
          <button
            type="button"
            :class="{ active: activeExtIpaSubSection === 'all' }"
            @click="activeExtIpaSubSection = 'all'; hideHoverCard()"
          >
            全部
          </button>
          <button
            type="button"
            :class="{ active: activeExtIpaSubSection === 'matrix' }"
            @click="activeExtIpaSubSection = 'matrix'; hideHoverCard()"
          >
            额外辅音
          </button>
          <button
            type="button"
            :class="{ active: activeExtIpaSubSection === 'marks' }"
            @click="activeExtIpaSubSection = 'marks'; hideHoverCard()"
          >
            附加与发声
          </button>
          <button
            type="button"
            :class="{ active: activeExtIpaSubSection === 'context' }"
            @click="activeExtIpaSubSection = 'context'; hideHoverCard()"
          >
            语境与组合
          </button>
        </div>
      </div>

      <div class="ipa-tb-right">
        <div class="ipa-pose-set-toolbar" data-tour="ipa-pose-set">
          <span class="muted">构型方案</span>
          <CustomSelect
            size="sm"
            aria-label="构型方案"
            :model-value="selectedIpaPoseSetId"
            :options="ipaPoseSets.map(item => ({ value: item.id, label: item.name }))"
            @update:model-value="v => switchPoseSet(String(v))"
          />
          <template v-if="!poseSetOpen">
            <button type="button" class="btn sm primary" @click="editSet('copy')">
              <IconSvg name="copy" :size="11" />
              <span>新建一套构型</span>
            </button>
            <button
              v-if="selectedIpaPoseSetId !== RECORDED_IPA_SET_ID"
              type="button"
              class="btn sm"
              @click="editSet('rename')"
            >
              重命名
            </button>
            <button
              v-if="selectedIpaPoseSetId !== RECORDED_IPA_SET_ID"
              type="button"
              class="btn sm icon-only"
              title="删除当前自定义构型方案"
              @click="removeActivePoseSet"
            >
              <IconSvg name="trash" :size="11" />
            </button>
          </template>
          <template v-else>
            <input
              v-model="poseSetName"
              class="inp"
              placeholder="输入新构型方案名称"
              aria-label="构型方案名称"
              maxlength="80"
              @keydown.enter.prevent="makeIpaSet"
              @keydown.escape.prevent="poseSetOpen = false"
            />
            <button type="button" class="btn sm primary" :disabled="!poseSetName.trim()" @click="makeIpaSet">
              确认
            </button>
            <button type="button" class="btn sm" @click="poseSetOpen = false">取消</button>
          </template>
        </div>
        <button v-if="references.length" type="button" class="btn sm" :class="{ active: showReferenceLibrary }" @click="showReferenceLibrary = !showReferenceLibrary; hideHoverCard()">参考录音库</button>
        <label v-if="hasReferences" class="ipa-reference-toggle"><input v-model="clickPlays" type="checkbox" /> 点击音标播放</label>
        <div class="ipa-search-wrap" data-tour="ipa-search">
          <IconSvg name="search" :size="13" class="muted" />
          <input
            ref="searchInputRef"
            v-model="searchQuery"
            type="text"
            class="inp ipa-search-inp"
            placeholder="检索 655 条目：符号 / 中文名 / 英文 / U+码位"
          />
          <button v-if="searchQuery" type="button" class="btn sm icon-only" aria-label="清空音标检索" @click="searchQuery = ''">
            <IconSvg name="close" :size="11" />
          </button>
        </div>

        <label class="ipa-size-ctrl" title="调节音标矩阵符号字号">
          <span class="muted">字号</span>
          <input
            v-model.number="fontSizePx"
            type="range"
            min="13"
            max="24"
            step="1"
            class="ipa-size-slider"
            :style="{ '--fill': `${(((fontSizePx - 13) / 11) * 100).toFixed(1)}%` }"
          />
          <span class="mono">{{ fontSizePx }}px</span>
        </label>

        <span v-if="customSavedCount > 0" class="tree-tag">当前方案自定义 {{ customSavedCount }}</span>
        <ModuleGuideButton data-tour="ipa-guide-btn" module-id="ipa" size="sm" />
      </div>
    </div>

    <!-- Loading / Error -->
    <div v-if="loading" class="panel ipa-loading">
      <span>正在载入国际音标表 Plus 655 条目目录...</span>
    </div>
    <div v-else-if="loadErr" class="panel ipa-loading">
      <IconSvg name="warn" :size="16" />
      <span>{{ loadErr }}</span>
    </div>

    <!-- Resizable Main Split Grid -->
    <div
      v-else
      class="ipa-64-grid"
      :style="{ '--ipa-left-fr': `${ipaMainSplitPct}fr`, '--ipa-right-fr': `${100 - ipaMainSplitPct}fr` }"
    >
      <!-- LEFT PANE: Compact PTB-Spec Charts (T-43: translate="no") -->
      <div class="panel ipa-left-pane" data-tour="ipa-matrix" translate="no">
        <div class="p-body ipa-scroll-body" @scroll="hideHoverCard">
          <template v-if="showReferenceLibrary">
            <input v-model="referenceFilter" class="inp" type="search" placeholder="检索音标、分组或录音编号" aria-label="检索参考录音库" />
            <div class="reference-library" role="list" aria-label="参考录音目录">
              <div v-for="item in visibleReferences" :key="item.id" class="reference-row" :class="{ active: librarySelected?.id === item.id }" role="listitem">
                <button type="button" class="btn xs reference-title" @click="showLibraryReference(item)">{{ item.prompt }}</button>
                <small v-if="personalRecordings.has(item.id)" class="muted">个人录音</small>
                <small v-else class="muted" :title="item.issue">{{ !item.exists ? '缺录音' : item.excluded ? '保留录音' : item.voqs ? 'VoQS 声门' : item.animation ? '已重建' : '待重建' }}{{ item.issue ? ' · 待核' : '' }}</small>
                <button type="button" class="btn xs" :disabled="!item.exists && !personalRecordings.has(item.id)"
                  :aria-label="'播放 ' + item.title" @click="showLibraryReference(item); playReference(item)"><IconSvg name="play" :size="11" /></button>
              </div>
            </div>
          </template>
          <!-- Search Results View -->
          <template v-else-if="searchQuery.trim()">
            <div class="param-sec-title">
              <span>全表检索结果 ({{ searchMatches.length }} 条匹配)</span>
              <span class="muted">覆盖 IPA / extIPA / VoQS 全 655 条目</span>
            </div>
            <div v-if="searchMatches.length" class="ipa-search-grid">
              <button
                v-for="entry in searchMatches"
                :key="entry.id"
                type="button"
                class="ipa-named-row"
                :class="{
                  active: selectedEntry?.id === entry.id,
                  custom: activeCustomPoseIds.has(entry.id),
                  'is-example': entry.isExample,
                }"
                @mouseenter="showHoverCard(entry, $event)"
                @mouseleave="hideHoverCard"
                @click="activateEntry(entry)"
                @dblclick="copyEntrySymbol(entry)"
              >
                <span class="ipa named-glyph">{{ entry.display }}</span>
                <span class="named-meta">
                  <span class="named-zh">{{ entry.nameZh }}</span>
                  <span class="named-en muted">{{ entry.nameEn }}</span>
                </span>
                <span class="mono muted named-sys">{{ entry.system.toUpperCase() }}</span>
              </button>
            </div>
            <div v-else class="ipa-empty-hint muted">未找到匹配的音标条目，请尝试符号、中文术语、英文名或 U+ 码位。</div>
          </template>

          <!-- SYSTEM 1: IPA -->
          <template v-else-if="activeSystem === 'ipa'">
            <template v-if="activeIpaSubSection === 'main'">
              <!-- 15 Places x 13 Manners Consonant Matrix (PTB Cell Spec) -->
              <section v-if="ipaConsonantMatrix" class="ipa-section-block">
                <div class="param-sec-title">
                  <span>{{ ipaConsonantMatrix.title }}（15 部位 × 13 方式 · 口腔 12 列 / 喉部 3 列分区）</span>
                  <span class="muted">PTBIPAPlus / Doulos SIL</span>
                </div>
                <div class="ipa-matrix-scroll" @scroll="hideHoverCard">
                  <table class="ipa-matrix-tbl">
                    <thead>
                      <tr v-if="ipaConsonantMatrix.columnGroups?.length" class="grp-hdr-row">
                        <th rowspan="2" class="sticky-col corner-th">方式 \ 部位</th>
                        <th
                          v-for="(cg, cgIdx) in ipaConsonantMatrix.columnGroups"
                          :key="cg.label"
                          :colspan="cg.span"
                          scope="colgroup"
                          class="col-group-th"
                          :class="{
                            'grp-oral': cgIdx === 0,
                            'grp-laryngeal': cgIdx > 0,
                            'group-start': cgIdx > 0,
                          }"
                        >
                          {{ cg.label }} ({{ cg.span }})
                        </th>
                      </tr>
                      <tr>
                        <th v-if="!ipaConsonantMatrix.columnGroups?.length" class="sticky-col corner-th">方式 \ 部位</th>
                        <th
                          v-for="(col, cIdx) in ipaConsonantMatrix.columns"
                          :key="col"
                          scope="col"
                          class="col-place-th"
                          :class="{ 'group-start': isColGroupStart(ipaConsonantMatrix, cIdx) }"
                        >
                          {{ col }}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="row in ipaConsonantMatrix.rows" :key="row.label" :class="{ 'unsupported-row': unsupportedRows.has(row.label) }">
                        <th scope="row" class="sticky-col row-lbl">{{ row.label }}<small v-if="unsupportedRows.has(row.label)">无声道重建</small></th>
                        <td
                          v-for="(cell, cIdx) in row.cells"
                          :key="`${row.label}_${cIdx}`"
                          :colspan="cell.span ?? 1"
                          :class="{
                            'group-start': isCellGroupStart(ipaConsonantMatrix, row.cells, cIdx),
                            'cell-shaded': cell.shaded,
                            'cell-half-shaded': cell.rightHalfShaded,
                            'cell-left': cell.align === 'left',
                            'cell-right': cell.align === 'right',
                            'cell-split': cell.split,
                          }"
                          :aria-label="
                            cell.shaded
                              ? '原表阴影：判定不可能的构音'
                              : cell.rightHalfShaded
                                ? '原表右半阴影：浊音判定不可能'
                                : undefined
                          "
                        >
                          <div v-if="cell.split" class="matrix-split-wrap">
                            <div class="matrix-split-left">
                              <button
                                v-for="id in cell.ids"
                                :key="id"
                                type="button"
                                class="matrix-sym-btn ipa"
                                :class="{
                                  active: selectedEntry?.id === id,
                                  custom: activeCustomPoseIds.has(id),
                                  'is-example': getEntryById(id)?.isExample,
                                }"
                                @mouseenter="getEntryById(id) && showHoverCard(getEntryById(id)!, $event)"
                                @mouseleave="hideHoverCard"
                                @click="activateEntry(getEntryById(id))"
                                @dblclick="getEntryById(id) && copyEntrySymbol(getEntryById(id)!)"
                              >
                                {{ getEntryById(id)?.display ?? '' }}
                              </button>
                            </div>
                            <div class="matrix-split-right" aria-hidden="true"></div>
                          </div>

                          <template v-else-if="cell.rows?.length">
                            <div
                              v-for="(subrow, srIdx) in cell.rows"
                              :key="srIdx"
                              class="matrix-cell-row"
                              :class="{
                                'row-left': cell.align === 'left',
                                'row-right': cell.align === 'right',
                              }"
                            >
                              <template v-for="(slot, slotIdx) in subrow" :key="slotIdx">
                                <button
                                  v-if="slot"
                                  type="button"
                                  class="matrix-sym-btn ipa"
                                  :class="{
                                    active: selectedEntry?.id === slot,
                                    custom: activeCustomPoseIds.has(slot),
                                    'is-example': getEntryById(slot)?.isExample,
                                  }"
                                  @mouseenter="getEntryById(slot) && showHoverCard(getEntryById(slot)!, $event)"
                                  @mouseleave="hideHoverCard"
                                  @click="activateEntry(getEntryById(slot))"
                                  @dblclick="getEntryById(slot) && copyEntrySymbol(getEntryById(slot)!)"
                                >
                                  {{ getEntryById(slot)?.display ?? '' }}
                                </button>
                                <span v-else class="matrix-cell-spacer" aria-hidden="true"></span>
                              </template>
                            </div>
                          </template>

                          <div
                            v-else-if="cell.ids.length"
                            class="matrix-cell-row"
                            :class="{
                              'row-left': cell.align === 'left',
                              'row-right': cell.align === 'right',
                              'row-half': cell.rightHalfShaded,
                            }"
                          >
                            <button
                              v-for="id in cell.ids"
                              :key="id"
                              type="button"
                              class="matrix-sym-btn ipa"
                              :class="{
                                active: selectedEntry?.id === id,
                                custom: activeCustomPoseIds.has(id),
                                'is-example': getEntryById(id)?.isExample,
                              }"
                              @mouseenter="getEntryById(id) && showHoverCard(getEntryById(id)!, $event)"
                              @mouseleave="hideHoverCard"
                              @click="activateEntry(getEntryById(id))"
                              @dblclick="getEntryById(id) && copyEntrySymbol(getEntryById(id)!)"
                            >
                              {{ getEntryById(id)?.display ?? '' }}
                            </button>
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>

              <!-- 16-Point Vowel Quadrilateral + Acoustic Vowel Chart (T-20: Unified Visual Cards) -->
              <div ref="vowelsRowRef" class="ipa-vowel-extras-row" data-tour="ipa-vowels">
                <section v-if="ipaVowelChart" class="ipa-vowel-quad-card" aria-label="16 点经典元音四边形">
                  <header class="vq-card-head">
                    <strong>16 点经典元音四边形</strong>
                    <span class="muted">左不圆唇 · 右圆唇 · 前 / 央 / 后</span>
                  </header>
                  <div class="vowel-quad-box">
                    <span class="vq-lbl side-1">闭</span>
                    <span class="vq-lbl side-2">半闭</span>
                    <span class="vq-lbl side-3">半开</span>
                    <span class="vq-lbl side-4">开</span>
                    <div class="vowel-quad-stage">
                      <span class="vq-lbl top-l">前</span>
                      <span class="vq-lbl top-c">央</span>
                      <span class="vq-lbl top-r">后</span>
                      <svg class="vowel-quad-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                        <polygon
                          points="20,9 83,9 83,91 42,91"
                          fill="color-mix(in srgb, var(--teal-bg) 24%, transparent)"
                          stroke="var(--chart-outline)"
                          stroke-width="0.8"
                          vector-effect="non-scaling-stroke"
                        />
                        <line x1="50" y1="9" x2="66" y2="91" stroke="var(--chart-grid)" stroke-width="0.8" vector-effect="non-scaling-stroke" />
                        <line x1="27" y1="37" x2="83" y2="37" stroke="var(--chart-grid)" stroke-width="0.8" vector-effect="non-scaling-stroke" />
                        <line x1="34" y1="65" x2="83" y2="65" stroke="var(--chart-grid)" stroke-width="0.8" vector-effect="non-scaling-stroke" />
                      </svg>
                      <div
                        v-for="(pt, pIdx) in ipaVowelChart.points"
                        :key="pIdx"
                        class="vq-point"
                        :style="{ left: `${pt.x}%`, top: `${pt.y}%` }"
                      >
                        <button
                          v-for="(id, iIdx) in pt.ids"
                          :key="id"
                          type="button"
                          class="vq-sym-btn ipa"
                          translate="no"
                          :class="{
                            active: selectedEntry?.id === id,
                            custom: activeCustomPoseIds.has(id),
                            rounded: iIdx === 1,
                          }"
                          @mouseenter="getEntryById(id) && showHoverCard(getEntryById(id)!, $event)"
                          @mouseleave="hideHoverCard"
                          @click="activateEntry(getEntryById(id))"
                          @dblclick="getEntryById(id) && copyEntrySymbol(getEntryById(id)!)"
                        >
                          {{ getEntryById(id)?.display ?? '' }}
                        </button>
                      </div>
                    </div>
                  </div>
                  <footer class="vq-card-foot mono">
                    <span class="muted">IPA 标准舌位拓扑坐标 · 点击符号同步右侧声学图</span>
                  </footer>
                </section>

                <IpaVowelComparison
                  :speaker="vowelMonitorSpeaker"
                  :recording="personalRecording ? undefined : (librarySelected?.id ?? linkedVowelId ?? activeReference?.id)"
                  :symbol="selectedEntry?.section === 'vowels' ? selectedEntry.display : ''"
                  :pose="vowelMonitorPose"
                  :track-rows="vowelMonitorTrack?.rows ?? null"
                  :track-key="vowelMonitorTrack?.key"
                  :playing="recordingPlaying || recordingQueued"
                  :playback-time="displayedReferenceTime"
                  :dynamic-active="vowelMonitorDynamic"
                  @select-recording="selectMeasuredVowel"
                />
              </div>
            </template>

            <!-- IPA Diacritics / Suprasegmentals / Tones (PTB Explained Groups) -->
            <template v-else>
              <section v-for="chart in ipaMarkCharts" :key="chart.id" class="chart-sec-card">
                <div class="chart-sec-head">
                  <span>{{ chart.title }}</span>
                  <span class="muted">{{ chart.subtitle }}</span>
                </div>
                <div v-if="chart.groups" class="explained-groups">
                  <div v-for="grp in chart.groups" :key="grp.label" class="explained-row">
                    <div class="explained-caption" :title="grp.hint">
                      <span>{{ grp.label }}</span>
                    </div>
                    <div class="explained-syms">
                      <button
                        v-for="id in grp.ids"
                        :key="id"
                        type="button"
                        class="matrix-sym-btn ipa"
                        :class="{
                          active: selectedEntry?.id === id,
                          custom: activeCustomPoseIds.has(id),
                          'is-example': getEntryById(id)?.isExample,
                        }"
                        @mouseenter="getEntryById(id) && showHoverCard(getEntryById(id)!, $event)"
                        @mouseleave="hideHoverCard"
                        @click="activateEntry(getEntryById(id))"
                        @dblclick="getEntryById(id) && copyEntrySymbol(getEntryById(id)!)"
                      >
                        {{ getEntryById(id)?.display ?? '' }}
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            </template>
          </template>

          <!-- SYSTEM 2: extIPA (209 entries — PTB Matrix + Compact Explained Groups) -->
          <template v-else-if="activeSystem === 'extipa'">
            <section
              v-if="extipaMatrix && (activeExtIpaSubSection === 'all' || activeExtIpaSubSection === 'matrix')"
              class="ipa-section-block"
            >
              <div class="param-sec-title">
                <span>extIPA · {{ extipaMatrix.title }}</span>
                <span class="muted">ICPLA 2025 临床语音学扩展音标</span>
              </div>
              <div class="ipa-matrix-scroll" @scroll="hideHoverCard">
                <table class="ipa-matrix-tbl">
                  <thead>
                    <tr v-if="extipaMatrix.columnGroups?.length" class="grp-hdr-row">
                      <th rowspan="2" class="sticky-col corner-th">方式 \ 部位</th>
                      <th
                        v-for="(cg, cgIdx) in extipaMatrix.columnGroups"
                        :key="cg.label"
                        :colspan="cg.span"
                        scope="colgroup"
                        class="col-group-th"
                        :class="{ 'group-start': cgIdx > 0 }"
                      >
                        {{ cg.label }}
                      </th>
                    </tr>
                    <tr>
                      <th v-if="!extipaMatrix.columnGroups?.length" class="sticky-col corner-th">方式 \ 部位</th>
                      <th
                        v-for="(col, cIdx) in extipaMatrix.columns"
                        :key="col"
                        scope="col"
                        class="col-place-th"
                        :class="{ 'group-start': isColGroupStart(extipaMatrix, cIdx) }"
                      >
                        {{ col }}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in extipaMatrix.rows" :key="row.label">
                      <th scope="row" class="sticky-col row-lbl">{{ row.label }}</th>
                      <td
                        v-for="(cell, cIdx) in row.cells"
                        :key="`${row.label}_${cIdx}`"
                        :colspan="cell.span ?? 1"
                        :class="{
                          'group-start': isCellGroupStart(extipaMatrix, row.cells, cIdx),
                          'cell-shaded': cell.shaded,
                          'cell-half-shaded': cell.rightHalfShaded,
                          'cell-left': cell.align === 'left',
                          'cell-right': cell.align === 'right',
                          'cell-split': cell.split,
                        }"
                        :aria-label="
                          cell.shaded
                            ? '原表阴影：判定不可能的构音'
                            : cell.rightHalfShaded
                              ? '原表右半阴影：浊音判定不可能'
                              : undefined
                        "
                      >
                        <div v-if="cell.split" class="matrix-split-wrap">
                          <div class="matrix-split-left">
                            <button
                              v-for="id in cell.ids"
                              :key="id"
                              type="button"
                              class="matrix-sym-btn ipa"
                              :class="{
                                active: selectedEntry?.id === id,
                                custom: activeCustomPoseIds.has(id),
                                'is-example': getEntryById(id)?.isExample,
                              }"
                              @mouseenter="getEntryById(id) && showHoverCard(getEntryById(id)!, $event)"
                              @mouseleave="hideHoverCard"
                              @click="activateEntry(getEntryById(id))"
                              @dblclick="getEntryById(id) && copyEntrySymbol(getEntryById(id)!)"
                            >
                              {{ getEntryById(id)?.display ?? '' }}
                            </button>
                          </div>
                          <div class="matrix-split-right" aria-hidden="true"></div>
                        </div>

                        <template v-else-if="cell.rows?.length">
                          <div
                            v-for="(subrow, srIdx) in cell.rows"
                            :key="srIdx"
                            class="matrix-cell-row"
                            :class="{
                              'row-left': cell.align === 'left',
                              'row-right': cell.align === 'right',
                            }"
                          >
                            <template v-for="(slot, slotIdx) in subrow" :key="slotIdx">
                              <button
                                v-if="slot"
                                type="button"
                                class="matrix-sym-btn ipa"
                                :class="{
                                  active: selectedEntry?.id === slot,
                                  custom: activeCustomPoseIds.has(slot),
                                  'is-example': getEntryById(slot)?.isExample,
                                }"
                                @mouseenter="getEntryById(slot) && showHoverCard(getEntryById(slot)!, $event)"
                                @mouseleave="hideHoverCard"
                                @click="activateEntry(getEntryById(slot))"
                                @dblclick="getEntryById(slot) && copyEntrySymbol(getEntryById(slot)!)"
                              >
                                {{ getEntryById(slot)?.display ?? '' }}
                              </button>
                              <span v-else class="matrix-cell-spacer" aria-hidden="true"></span>
                            </template>
                          </div>
                        </template>

                        <div
                          v-else-if="cell.ids.length"
                          class="matrix-cell-row"
                          :class="{
                            'row-left': cell.align === 'left',
                            'row-right': cell.align === 'right',
                            'row-half': cell.rightHalfShaded,
                          }"
                        >
                          <button
                            v-for="id in cell.ids"
                            :key="id"
                            type="button"
                            class="matrix-sym-btn ipa"
                            :class="{
                              active: selectedEntry?.id === id,
                              custom: activeCustomPoseIds.has(id),
                              'is-example': getEntryById(id)?.isExample,
                            }"
                            @mouseenter="getEntryById(id) && showHoverCard(getEntryById(id)!, $event)"
                            @mouseleave="hideHoverCard"
                            @click="activateEntry(getEntryById(id))"
                            @dblclick="getEntryById(id) && copyEntrySymbol(getEntryById(id)!)"
                          >
                            {{ getEntryById(id)?.display ?? '' }}
                          </button>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section
              v-for="chart in extipaVisibleLists"
              :key="chart.id"
              class="chart-sec-card"
              :class="{ 'is-historical': chart.id === 'historical' }"
            >
              <div class="chart-sec-head">
                <span>{{ chart.title }}</span>
                <span class="muted">{{ chart.subtitle }}</span>
              </div>
              <div
                v-if="chart.groups"
                class="explained-groups"
                :class="{
                  'is-combination': chart.id === 'combinations',
                  'is-wide': chart.id === 'rhythm' || chart.id === 'uncertainty',
                }"
              >
                <div v-for="grp in chart.groups" :key="grp.label" class="explained-row">
                  <div class="explained-caption" :title="grp.hint">
                    <span>{{ grp.label }}</span>
                  </div>
                  <div class="explained-syms">
                    <button
                      v-for="id in grp.ids"
                      :key="id"
                      type="button"
                      class="matrix-sym-btn ipa"
                      :class="{
                        active: selectedEntry?.id === id,
                        custom: activeCustomPoseIds.has(id),
                        'is-example': getEntryById(id)?.isExample,
                        'is-span-btn': chart.id === 'rhythm' || chart.id === 'uncertainty',
                      }"
                      @mouseenter="getEntryById(id) && showHoverCard(getEntryById(id)!, $event)"
                      @mouseleave="hideHoverCard"
                      @click="activateEntry(getEntryById(id))"
                      @dblclick="getEntryById(id) && copyEntrySymbol(getEntryById(id)!)"
                    >
                      {{ getEntryById(id)?.display ?? '' }}
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </template>

          <!-- SYSTEM 3: VoQS (65 entries — Compact PTB 2-Column Named Rows & Scope Flow) -->
          <div v-else class="voqs-catalog" aria-label="VoQS 65 项目录">
            <div v-if="catalog?.voqsProvenance" class="voqs-prov-strip">
              <div class="voqs-prov-main">
                <strong>{{ catalog.voqsProvenance.title }}</strong>
                <span class="muted">{{ catalog.voqsProvenance.citation }}</span>
              </div>
              <span class="tree-tag">{{ catalog.voqsProvenance.license }}</span>
            </div>

            <!-- Phonation (26 entries in dense multi-column named rows) -->
            <section v-if="voqsPhonationChart" class="chart-sec-card">
              <div class="chart-sec-head">
                <span>VoQS · {{ voqsPhonationChart.title }}</span>
                <span class="muted">{{ voqsPhonationChart.ids?.length ?? 0 }} 项 · {{ voqsPhonationChart.subtitle }}</span>
              </div>
              <div class="voqs-named-grid">
                <button
                  v-for="id in voqsPhonationChart.ids ?? []"
                  :key="id"
                  :data-voqs-id="id"
                  type="button"
                  class="ipa-named-row"
                  :class="{
                    active: selectedEntry?.id === id,
                    custom: activeCustomPoseIds.has(id),
                  }"
                  @mouseenter="getEntryById(id) && showHoverCard(getEntryById(id)!, $event)"
                  @mouseleave="hideHoverCard"
                  @click="activateEntry(getEntryById(id))"
                  @dblclick="getEntryById(id) && copyEntrySymbol(getEntryById(id)!)"
                >
                  <span class="ipa named-glyph">{{ getEntryById(id)?.display }}</span>
                  <span class="named-zh">{{ getEntryById(id)?.nameZh }}</span>
                </button>
              </div>
            </section>

            <!-- Compact 2-column grid for lingual / jaw / labial / airstream / velum / larynx -->
            <div class="voqs-compact-cols">
              <section v-for="chart in voqsMiddleCharts" :key="chart.id" class="chart-sec-card">
                <div class="chart-sec-head">
                  <span>{{ chart.title }}</span>
                  <span class="muted">{{ chart.ids?.length ?? 0 }} 项</span>
                </div>
                <div class="voqs-named-stack">
                  <button
                    v-for="id in chart.ids ?? []"
                    :key="id"
                    :data-voqs-id="id"
                    type="button"
                    class="ipa-named-row"
                    :class="{
                      active: selectedEntry?.id === id,
                      custom: activeCustomPoseIds.has(id),
                    }"
                    @mouseenter="getEntryById(id) && showHoverCard(getEntryById(id)!, $event)"
                    @mouseleave="hideHoverCard"
                    @click="activateEntry(getEntryById(id))"
                    @dblclick="getEntryById(id) && copyEntrySymbol(getEntryById(id)!)"
                  >
                    <span class="ipa named-glyph">{{ getEntryById(id)?.display }}</span>
                    <span class="named-zh">{{ getEntryById(id)?.nameZh }}</span>
                  </button>
                </div>
              </section>
            </div>

            <!-- Scope braces & examples -->
            <section v-if="voqsScopeChart" class="chart-sec-card">
              <div class="chart-sec-head">
                <span>VoQS · {{ voqsScopeChart.title }}</span>
                <span class="muted">{{ voqsScopeChart.subtitle }}</span>
              </div>
              <div class="voqs-scope-flow">
                <button
                  v-for="id in voqsScopeChart.ids ?? []"
                  :key="id"
                  :data-voqs-id="id"
                  type="button"
                  class="voqs-scope-chip"
                  :class="{
                    active: selectedEntry?.id === id,
                    custom: activeCustomPoseIds.has(id),
                    'is-example': getEntryById(id)?.isExample,
                  }"
                  @mouseenter="getEntryById(id) && showHoverCard(getEntryById(id)!, $event)"
                  @mouseleave="hideHoverCard"
                  @click="activateEntry(getEntryById(id))"
                  @dblclick="getEntryById(id) && copyEntrySymbol(getEntryById(id)!)"
                >
                  <span class="ipa scope-glyph">{{ getEntryById(id)?.display }}</span>
                  <span class="scope-name muted">{{ getEntryById(id)?.nameZh }}</span>
                </button>
              </div>
            </section>
          </div>
        </div>
        <IpaMaterialDownloads
          data-tour="ipa-downloads"
          :current="recordingDemo ? null : activeReference"
          :personal="recordingDemo ? undefined : personalRecording"
          :count="references.filter(item => item.exists).length"
          :can-reconstruct="canReconstructReference"
        />
        <IpaRecordingTimeline v-if="!isVoqsDetail && activeSystem !== 'voqs'"
          data-tour="ipa-timeline"
          :has-audio="Boolean(recordingSource)"
          :personal="!recordingDemo && Boolean(personalRecording)"
          :file="recordingFile"
          :media-loading="recordingLoading"
          :title="recordingDemo?.title ?? activeReference?.title"
          :duration="recordingDuration || editTrack?.animation.duration_sec || 0"
          :time="referenceTime"
          :playing="recordingPlaying || recordingQueued"
          :status="recordingStatus || (!recordingDemo && referenceStatus ? referenceStatus : (referencesLoadFailed && !recordingSource ? '实录索引暂未载入，请确认本地引擎就绪后点击右侧重试' : ''))"
          :has-trajectory="!recordingDemo && canReconstructReference"
          :can-reconstruct="canReconstructReference"
          :source="recordingDemo ? 'demo' : recordingType"
          :can-revision="Boolean(revisionUrl)"
          :frame-editing="editOpen"
          :keyframes="hasFrameEditor ? recordingKeys.map(item => item.frame) : []"
          :target="!recordingDemo && activeReference ? findTargetInterval(activeReference) : undefined"
          :theme-key="recordingTheme"
          :loudness="recordingLoudness"
          :can-retry-references="referencesLoadFailed"
          @toggle-play="toggleRecording"
          @seek="seekRecording"
          @source="playRecordingSource"
          @loudness="setRecordingLoudness"
          @retry-references="loadEngineAssets(true)"
        />
      </div>

      <SplitPane
        v-model="ipaMainSplitPct"
        direction="vertical"
        percentage
        :min="36"
        :max="74"
        :default-value="IPA_MAIN_DEFAULT_SPLIT_PCT"
        storage-key="ipaMain"
        :title="`拖拽调整左右分栏比例（双击恢复 ${IPA_MAIN_DEFAULT_SPLIT_PCT}:${100 - IPA_MAIN_DEFAULT_SPLIT_PCT}）`"
      />

      <!-- RIGHT PANE: Interactive VocalTractViewport + PTB Authoritative Details + Bottom-Pinned Actions -->
      <div class="panel ipa-right-pane" data-tour="ipa-detail">
        <div class="p-head">
          <span>{{ isVoqsDetail ? 'VoQS 实录声门与语音学阐释' : '音标物理构型与语音学阐释' }}</span>
          <span v-if="selectedEntry" class="mono tree-tag">
            {{ selectedEntry.system.toUpperCase() }}
            <template v-if="selectedEntry.codePoints.length <= 6">
              · {{ selectedEntry.codePoints.join(' ') }}
            </template>
          </span>
        </div>

        <IpaReferenceRecorder v-if="selectedIpaPoseSetId !== RECORDED_IPA_SET_ID && baseReference"
          :key="selectedIpaPoseSetId + ':' + baseReference.id"
          :set-id="selectedIpaPoseSetId" :reference-id="baseReference.id" :has-replacement="Boolean(personalRecording)"
          :ready="personalRecordingsReady" :save="changePersonalRecording" @start="startPersonalRecording" />

        <div v-if="selectedEntry" class="ipa-detail-body" :class="{ 'ipa-detail-voqs': isVoqsDetail }">
          <!-- Compact Selected Symbol Header -->
          <div class="ipa-sel-head" :class="{ 'is-long-example': isLongHeroExample }">
            <button type="button" class="ipa-hero-glyph ipa" translate="no" title="复制音标"
              :aria-label="`复制音标 ${selectedEntry.display}`" @click="copyEntrySymbol(selectedEntry)">{{ selectedEntry.display }}</button>
            <div class="ipa-hero-meta">
              <div class="ipa-hero-zh">
                <span>{{ selectedEntry.nameZh }}</span>
                <span v-if="hasCustomPoseForSelected" class="tree-tag">自定义构型</span>
              </div>
              <div class="muted ipa-hero-en">{{ selectedEntry.nameEn }}</div>
              <span
                v-if="resolvedNotationStatus(selectedEntry)"
                class="detail-status-pill"
                :class="resolvedNotationStatus(selectedEntry)"
              >
                {{ notationStatusLabel(resolvedNotationStatus(selectedEntry)) }}
              </span>
            </div>
            <button v-if="favoriteEntry && selectedEntry.system !== 'voqs'" type="button" class="btn xs" :aria-pressed="isFavorite"
              title="收藏后可在标注工作台的音素替换栏使用"
              @click="toggleIpaFavorite(favoriteEntry)">
              {{ isFavorite ? '取消收藏' : '收藏音标' }}
            </button>
          </div>

          <!-- Hero Draggable VocalTractViewport (Primary Visual Focus) -->
          <template v-if="selectedEntry.system === 'voqs'">
            <VoqsReferencePanel :reference="activeReference" :personal="Boolean(personalRecording)" :choices="voqsChoices" :duration="recordingDuration" :time="referenceTime"
              :playing="recordingPlaying || recordingQueued" :loading="recordingLoading" :status="recordingStatus"
              :source="recordingType === 'reconstruction' ? 'reconstruction' : 'audio'" :theme="recordingTheme"
              :speaker="activeSpeaker" :height="voqsHeight" @source="chooseVoqsRecording" @toggle="toggleRecording" @seek="seekRecording"
              @recording="selectVoqsRecording" @height="changeVoqsHeight" />
            <VoqsAnchorPicker v-if="activeReference && !personalRecording" :key="selectedEntry.id" :reference-id="activeReference.id" :render-height="voqsHeight"
              :symbol="selectedEntry.insertText || selectedEntry.display" media-owned @apply="writeVoqsToTimeline" />
          </template>
          <div v-if="selectedEntry.system !== 'voqs' && activeReference" class="reference-toolbar">
            <div v-if="activeReference.animation" class="seg control-seg xs" aria-label="声道构型来源">
              <button type="button" :class="{ active: referenceMode === 'preset' }" @click="editOpen = false; referenceMode = 'preset'">编辑方案构型</button>
              <button type="button" :class="{ active: referenceMode === 'static' }" @click="editOpen = false; referenceMode = 'static'">录音反演 · 静态</button>
              <button type="button" :class="{ active: referenceMode === 'motion' && !editOpen }" @click="editOpen = false; referenceMode = 'motion'; playReference(activeReference)">动态构型</button>
            </div>
            <button v-if="hasFrameEditor" class="btn xs" type="button" :aria-pressed="editOpen" :class="{ active: editOpen }"
              title="选定中间稳态目标帧 (u ≈ 0.5)，以余弦升窗微调舌位并保留起收自然动程"
              @click="editOpen ? (editOpen = false) : openRecordingEditor()">目标帧微调</button>
            <button type="button" class="btn xs" :disabled="!activeReference.exists" @click="playReference(activeReference)">
              <IconSvg name="play" :size="11" /> {{ personalRecording ? '个人录音' : '原录音' }}
            </button>
            <button v-if="activeReference.animation && !excludedPose" type="button" class="btn xs" @click="playRendered(activeReference.id,'reconstruction')">声道重建录音</button>
            <span class="muted reference-name" :title="activeReference.file" translate="no">{{ activeReference.title }}</span>
            <button v-if="canLinkVowelRecording" type="button" class="btn xs" :disabled="linkedVowelId === activeReference.id"
              @click="linkVowelRecording">
              {{ linkedVowelId === activeReference.id ? '已关联实测元音' : '用此录音实测点' }}
            </button>
          </div>
          <button v-if="trillDemo" class="btn xs" type="button" @click="playRendered(trillDemo.id,'audio')">颤音合成示范 · 井井音色</button>
          <p v-if="excludedPose" class="unsupported-note">当前声道模型不支持这一气流机制。可查看音标说明，有录音时可试听原音。</p>
          <div v-if="selectedEntry.system !== 'voqs' && !excludedPose" class="ipa-tract-box sci-plane" data-tour="ipa-tract-viewport">
            <VocalTractViewport
              v-if="hasEditedView" :params="editedViewParams" :extras="DEFAULT_TRACT_EXTRAS" :metadata="editedControlsMeta"
              :interactive="Boolean(recordingLimits)" :enabled-handles="recordingTractHandles" :reference-sample="''" :show-grid="true"
              :dock-hud="true"
              @drag-end="updateRecordingPose"
            >
              <template #hud-meta>
                <small v-if="referenceStatus" class="ipa-hud-state" role="status">{{ referenceStatus }}</small>
                <small v-else class="ipa-hud-state">目标帧声道微调</small>
              </template>
            </VocalTractViewport>
            <VocalTractViewport
              v-else-if="referenceMode === 'preset' || !activeReference?.animation"
              :params="editorParams"
              :extras="editorExtras"
              :show-grid="true"
              :dock-hud="true"
              @update:params="onTractUpdate"
              @update:extras="onExtrasUpdate"
            >
              <template #hud-meta>
                <small v-if="referenceStatus" class="ipa-hud-state" role="status">{{ referenceStatus }}</small>
                <small v-else-if="!hasCustomPoseForSelected && !getSelectedIpaPoseParams(entryPreviewSymbol(selectedEntry))" class="ipa-hud-state">PhoneticToolbox 参考构型</small>
                <small v-else class="ipa-hud-state">{{ hasCustomPoseForSelected ? '已保存的自定义构型' : '构型方案 · 录音反演或自定义' }}</small>
              </template>
            </VocalTractViewport>
            <div v-else class="reference-svg-stage">
              <div class="reference-svg-head">
                <span class="muted">{{ referenceMode === 'motion' ? '录音反演 · 动态构型' : '录音反演 · 静态构型' }}</span>
                <small v-if="referenceStatus" class="ipa-hud-state" role="status">{{ referenceStatus }}</small>
              </div>
              <svg ref="referenceSvg" class="reference-anatomy" role="img" aria-label="录音反演声道构型" />
            </div>
          </div>

          <!-- PTB-Grade Scrollable Phonetic Details Card -->
          <div class="ipa-details-scroll selectable">
            <IpaRecordingKeyframes v-if="editOpen && editTrack" :kit="editSetName"
              :readonly-kit="selectedIpaPoseSetId === RECORDED_IPA_SET_ID"
              :frame="editClock"
              :target-frame="steadyTargetFrame" :default-radius="defaultBellRadius"
              :size="editTrack.m27_50hz_pa.length" :keyframes="recordingKeys" :values="editControls" :limits="recordingLimits"
              :status="editNotice" :busy="revisionBusy" :dirty="editDirty" :has-changes="hasRevisionChanges"
              :synthesis="revisionMode" :playing="recordingPlaying || recordingQueued"
              @add="addRecordingFrame" @remove="removeRecordingFrame" @select="seekRecording($event / IPA_RECORDING_HZ)"
              @radius="updateRecordingRadius" @change="(key,value) => updateRecordingControls({ [key]:value })"
              @save="saveRecordingEdit" @cancel="cancelRecordingEdit" @render="previewRecordingEdit" @synthesis="revisionMode = $event" />
            <p v-if="selectedEntry.descriptionZh" class="det-para">
              {{ selectedEntry.descriptionZh }}
            </p>
            <p v-if="selectedEntry.usageZh" class="det-para">
              {{ selectedEntry.usageZh }}
            </p>
            <p v-if="selectedEntry.contrastZh" class="det-hint">
              {{ selectedEntry.contrastZh }}
            </p>
            <p v-if="selectedEntry.notesZh" class="det-para det-notes">
              {{ selectedEntry.notesZh }}
            </p>
            <p v-if="selectedEntry.representation" class="det-representation">
              {{ selectedEntry.representation }}
            </p>

            <!-- Actual Insert Text Hint (when display differs from insertText, e.g. combining diacritics) -->
            <div v-if="selectedEntry.display !== selectedEntry.insertText" class="det-kv-row">
              <span class="det-k muted">实际输入：</span>
              <span class="ipa det-example-glyph" translate="no">{{ selectedEntry.insertText }}</span>
            </div>

            <!-- Examples -->
            <div v-if="selectedEntry.examples?.length" class="det-kv-row">
              <span class="det-k muted">例示：</span>
              <div class="det-example-list" translate="no">
                <span
                  v-for="(ex, eIdx) in selectedEntry.examples"
                  :key="eIdx"
                  class="det-example-chip"
                  :title="ex.noteZh"
                >
                  <span class="ipa det-example-glyph" translate="no">{{ ex.text }}</span>
                  <span v-if="ex.noteZh && ex.noteZh !== '原表例示'" class="det-example-note muted">
                    {{ ex.noteZh }}
                  </span>
                </span>
              </div>
            </div>

            <!-- Unicode Code Points -->
            <div
              v-if="selectedEntry.codePoints.length > 0 && selectedEntry.codePoints.length <= 12"
              class="det-kv-row"
            >
              <span class="det-k muted">码位：</span>
              <code class="mono det-codepoints">{{ selectedEntry.codePoints.join(' ') }}</code>
            </div>

            <!-- Aliases -->
            <div v-if="selectedEntry.aliases?.length" class="det-kv-row">
              <span class="det-k muted">检索别名：</span>
              <span class="det-aliases muted">{{ selectedEntry.aliases.join(' · ') }}</span>
            </div>

            <!-- Source References -->
            <div v-if="selectedSources.length" class="det-sources">
              <div class="det-sources-title muted">权威文献与来源定位</div>
              <div v-for="src in selectedSources" :key="src.key" class="det-source-item">
                <div v-if="src.locator" class="det-source-loc">{{ src.locator }}</div>
                <a
                  v-if="src.url"
                  :href="src.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="det-source-link"
                >
                  <span>{{ src.title }}</span>
                  <IconSvg name="external-link" :size="11" />
                </a>
                <span v-else class="det-source-plain muted">{{ src.title }}</span>
              </div>
            </div>
          </div>

          <!-- Bottom-Pinned Action Footer -->
          <div v-if="selectedEntry.system !== 'voqs'" class="ipa-bottom-actions" data-tour="ipa-bottom-actions">
            <div class="ipa-actions-primary">
              <button type="button" class="btn sm" :disabled="store.isSynthesizing.value || (excludedPose && !activeReference?.exists)" @click="auditionSingle">
                <IconSvg name="play" :size="12" />
                <span>{{ personalRecording ? '试听个人录音' : activeReference?.exists ? '录音单音' : '合成试听' }}</span>
              </button>
              <button v-if="activeReference?.exists && activeReference.phones.length > 1" type="button" class="btn sm" @click="auditionAcaContext">
                <IconSvg name="volume" :size="12" />
                <span>/aCa/ 试听</span>
              </button>
              <button type="button" class="btn sm primary ipa-btn-write" :disabled="excludedPose" @click="writeToTimelinePhoneme">
                <IconSvg name="send" :size="12" />
                <span>{{ isStandaloneDiacriticEntry(selectedEntry) ? '叠加到当前时间轴音素' : '写入当前时间轴音素' }}</span>
              </button>
            </div>
            <div
              v-if="!excludedPose && referenceMode === 'preset'"
              class="ipa-actions-custom"
            >
              <button type="button" class="btn sm success" :disabled="!draftEdited" @click="saveAsCustomPose">
                <IconSvg name="check" :size="12" />
                <span>{{ selectedIpaPoseSetId === RECORDED_IPA_SET_ID ? '另存为新方案' : '保存构型' }}</span>
              </button>
              <button
                v-if="selectedIpaPoseSetId !== RECORDED_IPA_SET_ID"
                type="button"
                class="btn sm"
                :class="{ active: poseIsProtected }"
                :aria-pressed="poseIsProtected"
                :disabled="draftEdited && !poseIsProtected"
                :title="draftEdited && !poseIsProtected ? '先保存修改，再保护构型' : '保护当前方案中这个音素的构型'"
                @click="togglePoseProtection"
              >
                {{ poseIsProtected ? '取消保护' : '保护构型' }}
              </button>
              <button
                v-if="hasFrameEditor"
                type="button"
                class="btn sm"
                :disabled="revisionBusy"
                title="以余弦升窗将当前构型叠加至选定目标帧（默认 u≈0.5）并试听保留起收动程的动态合成"
                @click="auditionBellDynamicFromPreset"
              >
                <IconSvg name="waveform" :size="12" />
                <span>动态叠加试听</span>
              </button>
              <button type="button" class="btn sm" :disabled="!draftEdited" @click="setEntryPose(selectedEntry,true)">取消修改</button>
              <button
                type="button"
                class="btn sm"
                :disabled="!hasCustomPoseForSelected"
                @click="removeCustomPose"
              >
                <IconSvg name="refresh" :size="12" />
                <span>恢复默认</span>
              </button>
            </div>
          </div>
        </div>
        <div v-else-if="activeReference" class="ipa-detail-body" :class="{ 'ipa-detail-voqs': isVoqsDetail }">
          <div class="ipa-sel-head"><strong>{{ activeReference.title }}</strong></div>
          <template v-if="activeReference.voqs">
            <VoqsReferencePanel :reference="activeReference" :personal="Boolean(personalRecording)" :choices="voqsChoices" :duration="recordingDuration" :time="referenceTime"
              :playing="recordingPlaying || recordingQueued" :loading="recordingLoading" :status="recordingStatus"
              :source="recordingType === 'reconstruction' ? 'reconstruction' : 'audio'" :theme="recordingTheme"
              :speaker="activeSpeaker" :height="voqsHeight" @source="chooseVoqsRecording" @toggle="toggleRecording" @seek="seekRecording"
              @recording="selectVoqsRecording" @height="changeVoqsHeight" />
            <VoqsAnchorPicker v-if="activeReference.voqs_symbol && !personalRecording" :key="activeReference.id" :reference-id="activeReference.id"
              :symbol="activeReference.voqs_symbol" :render-height="voqsHeight" media-owned @apply="writeVoqsToTimeline" />
          </template>
          <div v-else class="reference-toolbar">
            <div v-if="activeReference.animation" class="seg control-seg xs" aria-label="声道构型来源">
              <button type="button" :class="{ active: referenceMode === 'static' }" @click="editOpen = false; referenceMode = 'static'">录音反演 · 静态</button>
              <button type="button" :class="{ active: referenceMode === 'motion' && !editOpen }" @click="editOpen = false; referenceMode = 'motion'; playReference(activeReference)">动态构型</button>
            </div>
            <button type="button" class="btn xs" :disabled="!activeReference.exists" @click="playReference(activeReference)">
              <IconSvg name="play" :size="11" /> {{ personalRecording ? '个人录音' : '原录音' }}
            </button>
            <button v-if="hasFrameEditor" class="btn xs" type="button" :aria-pressed="editOpen" :class="{ active: editOpen }"
              @click="editOpen ? (editOpen = false) : openRecordingEditor()">目标帧微调</button>
            <button v-if="activeReference.animation && !activeReference.excluded" type="button" class="btn xs" @click="playRendered(activeReference.id,'reconstruction')">声道重建录音</button>
          </div>
          <div v-if="activeReference.animation" class="ipa-tract-box sci-plane">
            <VocalTractViewport v-if="hasEditedView" :params="editedViewParams" :extras="DEFAULT_TRACT_EXTRAS" :metadata="editedControlsMeta"
              :interactive="Boolean(recordingLimits)" :enabled-handles="recordingTractHandles" :reference-sample="''" :show-grid="true"
              :dock-hud="true"
              @drag-end="updateRecordingPose">
              <template #hud-meta>
                <small v-if="referenceStatus" class="ipa-hud-state" role="status">{{ referenceStatus }}</small>
                <small v-else class="ipa-hud-state">目标帧声道微调</small>
              </template>
            </VocalTractViewport>
            <div v-else class="reference-svg-stage">
              <div class="reference-svg-head">
                <span class="muted">{{ referenceMode === 'motion' ? '录音反演 · 动态构型' : '录音反演 · 静态构型' }}</span>
                <small v-if="referenceStatus" class="ipa-hud-state" role="status">{{ referenceStatus }}</small>
              </div>
              <svg ref="referenceSvg" class="reference-anatomy" role="img" aria-label="录音反演声道构型" />
            </div>
          </div>
          <div v-if="editOpen && editTrack" class="ipa-details-scroll selectable">
            <IpaRecordingKeyframes :kit="editSetName"
              :readonly-kit="selectedIpaPoseSetId === RECORDED_IPA_SET_ID"
              :frame="editClock"
              :target-frame="steadyTargetFrame" :default-radius="defaultBellRadius"
              :size="editTrack.m27_50hz_pa.length"
              :keyframes="recordingKeys" :values="editControls" :limits="recordingLimits" :status="editNotice"
              :busy="revisionBusy" :dirty="editDirty" :has-changes="hasRevisionChanges" :synthesis="revisionMode"
              :playing="recordingPlaying || recordingQueued"
              @add="addRecordingFrame" @remove="removeRecordingFrame" @select="seekRecording($event / IPA_RECORDING_HZ)"
              @radius="updateRecordingRadius" @change="(key,value) => updateRecordingControls({ [key]:value })"
              @save="saveRecordingEdit" @cancel="cancelRecordingEdit" @render="previewRecordingEdit" @synthesis="revisionMode = $event" />
          </div>
          <p v-if="(!personalRecording && activeReference.issue) || referenceStatus" class="muted">
            {{ referenceStatus || activeReference.issue }}
          </p>
        </div>
      </div>
    </div>

    <!-- Viewport-Adaptive Hover Card (#ipaHoverCard, PTB SymbolDetails compact style) -->
    <Teleport to="body">
      <div
        v-if="hoverEntry"
        id="ipaHoverCard"
        ref="hoverCardRef"
        class="ipa-hover-card"
        :style="hoverStyle"
        role="tooltip"
      >
        <div class="ihc-top">
          <span class="ipa ihc-glyph" translate="no" :class="{ 'ihc-glyph-long': hoverEntry.isExample && Array.from(hoverEntry.display).length > 10 }">
            {{ hoverEntry.display }}
          </span>
          <div class="ihc-titles">
            <div class="ihc-zh">{{ hoverEntry.nameZh }}</div>
            <div class="ihc-en muted">{{ hoverEntry.nameEn }}</div>
          </div>
          <span class="mono tree-tag">{{ hoverEntry.system.toUpperCase() }}</span>
        </div>
        <span
          v-if="resolvedNotationStatus(hoverEntry)"
          class="detail-status-pill"
          :class="resolvedNotationStatus(hoverEntry)"
        >
          {{ notationStatusLabel(resolvedNotationStatus(hoverEntry)) }}
        </span>
        <p v-if="hoverEntry.descriptionZh" class="ihc-para">{{ hoverEntry.descriptionZh }}</p>
        <p v-if="hoverEntry.usageZh" class="ihc-para ihc-usage">{{ hoverEntry.usageZh }}</p>
        <p v-if="hoverEntry.contrastZh" class="ihc-contrast muted">{{ hoverEntry.contrastZh }}</p>
        <div class="ihc-foot mono muted">
          <code v-if="hoverEntry.codePoints.length > 0 && hoverEntry.codePoints.length <= 8">
            {{ hoverEntry.codePoints.join(' ') }}
          </code>
          <span v-else>{{ hoverEntry.section }}</span>
          <span>单击查看构型 · 双击复制符号</span>
        </div>
      </div>

      <div v-if="pendingUnsavedAction" class="export-modal-mask" role="dialog" aria-modal="true" aria-label="未保存构型确认" @click.self="cancelUnsavedGuard">
        <div class="export-modal-card ipa-unsaved-modal">
          <div class="p-head">
            <span>存在未保存修改</span>
            <button type="button" class="btn xs icon-only" aria-label="关闭确认弹窗" @click="cancelUnsavedGuard">
              <IconSvg name="close" :size="12" />
            </button>
          </div>
          <div class="p-body ipa-unsaved-body">
            <p class="det-para">
              当前{{ selectedEntry ? ` [${selectedEntry.display}] ` : '' }}有尚未保存的{{ draftEdited && editDirty ? '构型与目标帧修订' : draftEdited ? '声道构型修改' : '目标帧修订' }}，是否在{{ unsavedGuardTitle }}前保存？
            </p>
            <div class="ipa-unsaved-actions">
              <button type="button" class="btn sm primary" @click="confirmUnsavedSaveAndContinue">
                {{ selectedIpaPoseSetId === RECORDED_IPA_SET_ID ? '另存为新方案并继续' : '保存并继续' }}
              </button>
              <button type="button" class="btn sm danger" @click="confirmUnsavedDiscardAndContinue">放弃修改</button>
              <button type="button" class="btn sm" @click="cancelUnsavedGuard">留在此处</button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>

/* Translucent backdrop-exposing shell */
.ipa-overlay-shell {
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: var(--pad-shell);
  display: flex;
  flex-direction: column;
  gap: var(--gap-layout);
  background: transparent;
  overflow: hidden;
}

.ipa-topbar {
  flex: none;
  padding: 6px 10px;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.ipa-tb-left,
.ipa-tb-right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.ipa-search-wrap {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.ipa-search-inp {
  width: 240px;
}

.ipa-search-inp,
.ipa-pose-set-toolbar > .inp {
  height: var(--control-height-sm);
  font-size: var(--control-font-size-sm);
}

.ipa-size-ctrl {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.875rem;
}

.ipa-reference-toggle,.reference-toolbar,.ipa-pose-set-toolbar { display:flex; align-items:center; gap:6px; font-size:0.916667rem; }
.ipa-pose-set-toolbar { flex-wrap: wrap; }
.reference-toolbar { flex:none; flex-wrap:wrap; }
.reference-row { display:flex; align-items:center; gap:8px; border-bottom:1px solid var(--panel-border); padding:4px 0; }
.reference-row.active { background:var(--selected); }
.reference-title { flex:1; min-width:0; justify-content:flex-start; text-align:left; }
.reference-anatomy { display:block; flex:1; min-height:0; width:100%; height:100%; }
.reference-svg-stage { display:flex; flex-direction:column; width:100%; height:100%; min-height:0; }
.reference-svg-head { flex:none; display:flex; align-items:center; justify-content:space-between; gap:8px; padding:5px 8px; border-bottom:1px solid color-mix(in srgb, var(--panel-border) 72%, transparent); background:color-mix(in srgb, var(--sidebar) 64%, var(--panel)); font-size:0.833333rem; }
.ipa-hud-state { color:var(--muted); font-size:0.816667rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }

.ipa-size-slider {
  width: 72px;
  height: 14px;
}

.ipa-loading {
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 1.041667rem;
  color: var(--muted);
}

/* Resizable Split Layout (T-18) */
.ipa-64-grid {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(340px, var(--ipa-left-fr)) 5px minmax(300px, var(--ipa-right-fr));
  gap: var(--gap-layout);
}

.ipa-left-pane,
.ipa-right-pane {
  min-width: 0;
  min-height: 0;
}
.ipa-left-pane { display:flex; flex-direction:column; }

.ipa-scroll-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height:0;
  flex:1;
  overflow:auto;
  scrollbar-gutter: stable;
  overflow-anchor: none;
  container-type: inline-size;
  container-name: ipa-left;
}

.ipa-section-block {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.ipa-empty-hint {
  padding: 20px 10px;
  text-align: center;
  font-size: 0.958333rem;
}

/* ===== PTB-Spec Compact Consonant Matrix ===== */
.ipa-matrix-scroll {
  width: 100%;
  overflow-x: auto;
  scrollbar-width: thin;
  border: 1px solid var(--panel-border);
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--panel) 84%, transparent);
}

.ipa-matrix-tbl {
  width: 100%;
  min-width: max(840px, calc(var(--ipa-fs, 16px) * 42));
  border-collapse: collapse;
  table-layout: auto;
  font-size: 0.875rem;
}

.ipa-matrix-tbl th {
  border: 1px solid color-mix(in srgb, var(--border) 68%, transparent);
  padding: 2px 3px;
  text-align: center;
  vertical-align: middle;
}

.ipa-matrix-tbl td {
  border: 1px solid color-mix(in srgb, var(--border) 68%, transparent);
  padding: 1px;
  text-align: center;
  vertical-align: middle;
  white-space: nowrap;
  height: max(24px, calc(var(--ipa-fs, 16px) * 1.45));
}

.ipa-matrix-tbl thead th {
  background: color-mix(in srgb, var(--sidebar) 88%, transparent);
  color: var(--muted);
  font-weight: 600;
  line-height: 1.2;
  white-space: nowrap;
}

.col-group-th {
  font-size: 0.875rem;
  padding: 3px 4px !important;
}

.col-place-th {
  font-size: 0.833333rem;
  font-weight: 500 !important;
}

.grp-oral {
  color: var(--accent) !important;
}

.grp-laryngeal {
  color: var(--violet) !important;
}

.ipa-matrix-tbl .group-start {
  border-left: 2px solid color-mix(in srgb, var(--violet) 68%, var(--border)) !important;
}

.sticky-col {
  position: sticky;
  left: 0;
  z-index: 2;
  background: color-mix(in srgb, var(--sidebar) 94%, var(--panel)) !important;
  text-align: left !important;
  padding: 2px 6px !important;
  white-space: nowrap;
}

.corner-th {
  font-size: 0.833333rem;
}

.row-lbl {
  font-weight: 600;
  font-size: 0.875rem;
  color: var(--text);
}

.ipa-matrix-tbl td.cell-shaded {
  background: color-mix(in srgb, var(--border) 42%, var(--app));
}

.ipa-matrix-tbl td.cell-half-shaded {
  background: linear-gradient(
    to right,
    transparent 50%,
    color-mix(in srgb, var(--border) 42%, var(--app)) 50%
  );
}

.ipa-matrix-tbl td.cell-left {
  text-align: left;
  padding: 1px 2px 1px 3px;
}

.ipa-matrix-tbl td.cell-right {
  text-align: right;
  padding: 1px 3px 1px 2px;
}

.ipa-matrix-tbl td.cell-split {
  padding: 0;
  height: 1px;
}

.matrix-split-wrap {
  display: grid;
  grid-template-columns: 1fr 1fr;
  width: 100%;
  height: 100%;
  min-height: max(24px, calc(var(--ipa-fs, 16px) * 1.45));
  align-items: stretch;
}

.matrix-split-left {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1px;
  border-right: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
}

.matrix-split-right {
  background: color-mix(in srgb, var(--border) 16%, transparent);
}

.matrix-cell-row {
  display: flex;
  align-items: center;
  justify-content: space-evenly;
  flex-wrap: nowrap;
  gap: 1px;
  width: 100%;
}

.matrix-cell-row + .matrix-cell-row {
  margin-top: 1px;
}

.matrix-cell-row.row-left {
  justify-content: flex-start;
}

.matrix-cell-row.row-right {
  justify-content: flex-end;
}

.matrix-cell-row.row-half {
  width: 50%;
  justify-content: center;
}

.matrix-cell-spacer {
  display: inline-block;
  flex: 0 0 auto;
  min-width: max(18px, calc(var(--ipa-fs, 16px) * 1.05));
  min-height: max(22px, calc(var(--ipa-fs, 16px) * 1.25));
  pointer-events: none;
}

.matrix-sym-btn {
  min-width: 20px;
  min-height: 22px;
  padding: 1px 2px;
  line-height: 1.15;
  font-size: var(--ipa-fs, 16px);
  white-space: nowrap;
  flex: 0 0 auto;
  border: 1px solid transparent;
  border-radius: max(3px, calc(var(--r-ctrl) - 2px));
  background: transparent;
  color: var(--text);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.1s, border-color 0.1s, color 0.1s;
}

.matrix-sym-btn.is-example {
  color: var(--muted);
}

.matrix-sym-btn.is-span-btn {
  max-width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
  font-size: max(12px, calc(var(--ipa-fs, 16px) - 2px));
  line-height: 1.2;
}

.matrix-sym-btn:hover {
  background: var(--selected);
  border-color: var(--accent);
  color: var(--accent);
}

.matrix-sym-btn.active {
  background: var(--accent);
  color: var(--on-accent);
  border-color: var(--accent);
}

.matrix-sym-btn.custom {
  box-shadow: inset 0 -2px 0 var(--success);
}

/* ===== 16-Point Vowel Quadrilateral + Acoustic Vowel Chart (T-20 Unified Card Visuals) ===== */
.ipa-vowel-extras-row {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) minmax(290px, 1fr);
  gap: 10px;
  align-items: stretch;
}

@container ipa-left (max-width: 620px) {
  .ipa-vowel-extras-row {
    grid-template-columns: 1fr;
  }
}

.ipa-vowel-quad-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--chart-panel);
  border: 1px solid var(--chart-outline);
  border-radius: var(--r-ctrl);
  overflow: hidden;
}

.vq-card-head {
  min-height: 34px;
  box-sizing: border-box;
  padding: 4px 10px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 8px;
  border-bottom: 1px solid var(--chart-outline);
  background: color-mix(in srgb, var(--sidebar, var(--panel)) 68%, transparent);
}

.vq-card-head strong {
  font-size: 0.916667rem;
  font-weight: 700;
  color: var(--text);
}

.vq-card-head .muted {
  font-size: 0.833333rem;
}

.vowel-quad-box {
  position: relative;
  flex: 1;
  min-height: 214px;
  box-sizing: border-box;
  padding: 24px 18px 12px 38px;
  background: transparent;
}

.vq-card-foot {
  min-height: 28px;
  box-sizing: border-box;
  padding: 4px 10px;
  border-top: 1px solid var(--chart-outline);
  display: flex;
  align-items: center;
  font-size: 0.816667rem;
}

.vowel-quad-stage {
  position: relative;
  width: 100%;
  height: 100%;
}

.vowel-quad-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
}

.vq-lbl {
  position: absolute;
  font-size: 0.833333rem;
  font-weight: 700;
  color: var(--muted);
  pointer-events: none;
}

.vq-lbl.top-l { top: -18px; left: 20%; transform: translateX(-50%); }
.vq-lbl.top-c { top: -18px; left: 50%; transform: translateX(-50%); }
.vq-lbl.top-r { top: -18px; left: 83%; transform: translateX(-50%); }
.vq-lbl.side-1 { top: calc(24px + (100% - 38px) * 0.09); left: 8px; transform: translateY(-50%); }
.vq-lbl.side-2 { top: calc(24px + (100% - 38px) * 0.37); left: 6px; transform: translateY(-50%); }
.vq-lbl.side-3 { top: calc(24px + (100% - 38px) * 0.65); left: 6px; transform: translateY(-50%); }
.vq-lbl.side-4 { top: calc(24px + (100% - 38px) * 0.91); left: 8px; transform: translateY(-50%); }

.vq-point {
  position: absolute;
  transform: translate(-50%, -50%);
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 1px 3px;
  border-radius: max(3px, calc(var(--r-ctrl) - 2px));
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  border: 1px solid color-mix(in srgb, var(--border) 68%, transparent);
}

.vq-sym-btn {
  min-width: 20px;
  min-height: 22px;
  padding: 1px 3px;
  line-height: 1.15;
  font-size: var(--ipa-fs, 16px);
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}

.vq-sym-btn:hover {
  background: var(--selected);
  color: var(--accent);
}

.vq-sym-btn.active {
  background: var(--accent);
  color: var(--on-accent);
}

.vq-sym-btn.custom {
  box-shadow: inset 0 -2px 0 var(--success);
}

/* ===== PTB Explained Groups (IPA Marks / Extras / extIPA Lists) ===== */
.chart-sec-card {
  flex: none;
  border: 1px solid var(--panel-border);
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--panel) 82%, transparent);
  overflow: hidden;
}

.chart-sec-card.is-historical {
  border-style: dashed;
}

.chart-sec-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  background: color-mix(in srgb, var(--sidebar) 76%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--text);
}

.chart-sec-head > span:last-child {
  font-weight: 400;
  font-size: 0.833333rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.explained-groups {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 0 14px;
  padding: 2px 8px 4px;
}

.explained-groups.is-single-col {
  grid-template-columns: 1fr;
}

.explained-groups.is-wide {
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}

.explained-groups.is-combination {
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.explained-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 48%, transparent);
  min-width: 0;
}

.explained-groups.is-combination .explained-row {
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  gap: 3px;
  padding: 5px 0;
}

.explained-caption {
  flex: 1;
  min-width: 0;
  font-size: 0.916667rem;
  font-weight: 500;
  color: var(--text);
  line-height: 1.3;
  cursor: help;
}

.explained-syms {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 2px;
  max-width: 66%;
  flex-shrink: 0;
}

.explained-groups.is-combination .explained-syms {
  justify-content: flex-start;
  max-width: 100%;
}

.explained-groups.is-combination .matrix-sym-btn {
  border-color: color-mix(in srgb, var(--border) 72%, transparent);
  background: color-mix(in srgb, var(--app) 68%, transparent);
  padding: 2px 6px;
}

/* ===== Compact VoQS & Search Named Rows ===== */
.voqs-catalog { display: grid; align-content: start; gap: 10px; flex: 0 0 auto; min-width: 0; }
.voqs-prov-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 9px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 62%, transparent);
  font-size: 0.875rem;
}

.voqs-prov-main {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  min-width: 0;
}

.voqs-named-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
  gap: 2px 8px;
  padding: 4px 6px;
}

.voqs-compact-cols {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px;
  align-items: start;
}

.voqs-named-stack {
  display: flex;
  flex-direction: column;
  padding: 3px 6px;
  gap: 1px;
}

.ipa-search-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(215px, 1fr));
  gap: 4px 8px;
}

.ipa-named-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 26px;
  padding: 2px 5px;
  border: 1px solid transparent;
  border-bottom-color: color-mix(in srgb, var(--border) 42%, transparent);
  border-radius: max(3px, calc(var(--r-ctrl) - 2px));
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.1s, border-color 0.1s;
}

.ipa-named-row:hover {
  background: var(--selected);
  border-color: var(--accent);
}

.ipa-named-row.active {
  background: var(--selected);
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.ipa-named-row.custom {
  box-shadow: inset 0 -2px 0 var(--success);
}

.named-glyph {
  min-width: 36px;
  flex: none;
  text-align: center;
  font-size: max(14px, calc(var(--ipa-fs, 16px) - 1px));
  line-height: 1.2;
  color: var(--text);
}

.ipa-named-row.is-example .named-glyph {
  color: var(--muted);
}

.named-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.named-zh {
  font-size: 0.916667rem;
  line-height: 1.25;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.named-en {
  font-size: 0.816667rem;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.named-sys {
  font-size: 0.75rem;
  flex: none;
}

.voqs-scope-flow {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 5px 7px;
}

.voqs-scope-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  min-height: 26px;
  border: 1px solid color-mix(in srgb, var(--border) 68%, transparent);
  border-radius: max(3px, calc(var(--r-ctrl) - 2px));
  background: color-mix(in srgb, var(--app) 64%, transparent);
  color: var(--text);
  cursor: pointer;
  text-align: left;
  max-width: 100%;
}

.voqs-scope-chip.is-example {
  width: 100%;
  flex-wrap: wrap;
  justify-content: space-between;
}

.voqs-scope-chip:hover,
.voqs-scope-chip.active {
  background: var(--selected);
  border-color: var(--accent);
}

.voqs-scope-chip.custom {
  box-shadow: inset 0 -2px 0 var(--success);
}

.scope-glyph {
  font-size: max(13px, calc(var(--ipa-fs, 16px) - 2px));
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.voqs-scope-chip.is-example .scope-glyph {
  color: var(--muted);
}

.scope-name {
  font-size: 0.85rem;
}

/* ===== RIGHT PANEL: Hero Tract + PTB Details + Bottom-Pinned Actions ===== */
.ipa-detail-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: 9px 11px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
}
.ipa-detail-voqs { overflow: auto; }
.ipa-detail-voqs > * { flex-shrink: 0; }

.ipa-sel-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 9px;
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--app) 62%, transparent);
  border: 1px solid var(--panel-border);
}

.ipa-sel-head.is-long-example {
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
}

.ipa-hero-glyph {
  min-width: 46px;
  height: 46px;
  padding: 0 6px;
  flex: none;
  border-radius: var(--r-ctrl);
  background: var(--selected);
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  color: var(--accent);
  font-size: 2.166667rem;
  line-height: 1.15;
  display: grid;
  place-items: center;
  cursor: pointer;
}

.ipa-hero-glyph:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.ipa-sel-head.is-long-example .ipa-hero-glyph {
  width: 100%;
  height: auto;
  padding: 5px 8px;
  font-size: 1.416667rem;
  overflow-wrap: anywhere;
  text-align: left;
  justify-items: start;
}

.ipa-hero-meta {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ipa-hero-zh {
  font-size: 1.083333rem;
  font-weight: 700;
  color: var(--text);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.ipa-hero-en {
  font-size: 0.875rem;
  line-height: 1.25;
}

.detail-status-pill {
  align-self: flex-start;
  display: inline-block;
  margin-top: 2px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 0.816667rem;
  font-weight: 600;
  background: var(--violet-bg);
  color: var(--violet);
  border: 1px solid color-mix(in srgb, var(--violet) 32%, transparent);
}

.detail-status-pill.historical {
  background: color-mix(in srgb, var(--warning) 14%, transparent);
  color: var(--warning);
  border-color: color-mix(in srgb, var(--warning) 35%, transparent);
}

/* Primary visual focus: Enlarged draggable VocalTractViewport */
.ipa-tract-box {
  flex: 1 1 320px;
  min-height: 280px;
  border: 1px solid var(--panel-border);
}

/* Scrollable PTB-Grade Details Card */
.ipa-details-scroll {
  flex: 0.72 1 210px;
  min-height: 108px;
  overflow-y: auto;
  scrollbar-width: thin;
  padding: 8px 10px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 58%, transparent);
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.933333rem;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.det-para {
  margin: 0;
  color: var(--text);
}

.det-hint {
  margin: 0;
  padding: 4px 8px;
  border-left: 2px solid color-mix(in srgb, var(--accent) 55%, var(--border));
  background: color-mix(in srgb, var(--panel) 65%, transparent);
  border-radius: 0 4px 4px 0;
  color: var(--muted);
  font-size: 0.883333rem;
  line-height: 1.48;
}

.det-notes {
  white-space: pre-wrap;
}

.det-representation {
  margin: 0;
  color: var(--warning);
  font-size: 0.9rem;
}

.det-kv-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 6px;
  font-size: 0.883333rem;
}

.det-k {
  flex: none;
  font-weight: 600;
}

.det-example-list {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
}

.det-example-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 0 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--panel) 84%, transparent);
  border: 1px solid color-mix(in srgb, var(--border) 62%, transparent);
}

.det-example-glyph {
  font-size: 1.333333rem;
  line-height: 1.3;
  color: var(--text);
}

.det-example-note {
  font-size: 0.816667rem;
}

.det-codepoints {
  font-size: 0.85rem;
  color: var(--teal);
  background: var(--teal-bg);
  padding: 1px 6px;
  border-radius: 4px;
}

.det-aliases {
  font-size: 0.875rem;
}

.det-sources {
  margin-top: 2px;
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.det-sources-title {
  font-size: 0.833333rem;
  font-weight: 700;
  letter-spacing: 0.2px;
}

.det-source-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: 0.85rem;
  line-height: 1.4;
}

.det-source-loc {
  color: var(--text);
  font-weight: 500;
}

.det-source-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--accent);
  font-size: 0.833333rem;
  line-height: 1.35;
}

.det-source-plain {
  font-size: 0.833333rem;
}

/* Bottom-Pinned Action Footer */
.ipa-bottom-actions {
  margin-top: auto;
  flex: none;
  padding-top: 8px;
  border-top: 1px solid var(--panel-border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ipa-actions-primary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.ipa-actions-custom {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ipa-actions-custom > .btn:first-child {
  flex: 1 1 auto;
}

.ipa-btn-write {
  flex: 1 1 auto;
  min-width: 0;
}

.ipa-unsaved-modal {
  width: min(420px, calc(100vw - 32px));
}

.ipa-unsaved-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ipa-unsaved-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 6px;
}

/* ===== Viewport-Adaptive Hover Card (#ipaHoverCard, PTB Compact Style) ===== */
.ipa-hover-card {
  position: fixed;
  z-index: var(--z-popover);
  pointer-events: none;
  box-sizing: border-box;
  overflow: hidden;
  background: var(--popover-bg);
  backdrop-filter: blur(14px) saturate(150%);
  border: var(--border-w, 1px) solid var(--panel-border);
  border-radius: var(--r-panel);
  box-shadow: var(--popover-shadow);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--text);
}

.ihc-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ihc-glyph {
  font-size: 2.166667rem;
  line-height: 1.15;
  color: var(--accent);
  min-width: 32px;
  text-align: center;
  flex: none;
}

.ihc-glyph-long {
  font-size: 1.333333rem;
  max-width: 110px;
  overflow-wrap: anywhere;
  text-align: left;
}

.ihc-titles {
  flex: 1;
  min-width: 0;
}

.ihc-zh {
  font-size: 1.016667rem;
  font-weight: 700;
  line-height: 1.25;
}

.ihc-en {
  font-size: 0.85rem;
  line-height: 1.25;
}

.ihc-para {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.48;
  color: var(--text);
}

.ihc-usage {
  color: var(--text);
  opacity: 0.92;
}

.ihc-contrast {
  margin: 0;
  font-size: 0.85rem;
  line-height: 1.42;
  padding-left: 6px;
  border-left: 2px solid color-mix(in srgb, var(--accent) 45%, var(--border));
}

.ihc-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 0.816667rem;
  border-top: 1px solid var(--panel-border);
  padding-top: 5px;
}

.ihc-foot code {
  font-family: var(--font-mono);
  color: var(--teal);
  overflow-wrap: anywhere;
}
.unsupported-row td { background-image:repeating-linear-gradient(135deg,transparent 0 5px,color-mix(in srgb,var(--muted) 9%,transparent) 5px 6px); }
.unsupported-row th small { display:block; font-size:0.75rem; color:var(--muted); }
.unsupported-note { padding:10px; margin:0; border-left:3px solid var(--muted); background:var(--rail); line-height:1.6; }
</style>
