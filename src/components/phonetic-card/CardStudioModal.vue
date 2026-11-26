<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue';
import { cardOptions } from '@vocalcut/edition';
import {
  tractRecordToArray19,
  useWorkbenchStore,
  type TractParamName,
  type TractPoseExtras,
} from '@/stores/workbench';
import { panelSnapshots } from '@/data/panel-snapshots';
import { resolveVtlPose, vtlPoseKey } from '@/data/vtl-pose-client';
import type { PtbPoseSnapshot } from '@/components/research/ptb-physics-charts';
import CompactSlider from '@/components/common/CompactSlider.vue';
import CustomSelect, { type SelectOption } from '@/components/common/CustomSelect.vue';
import IconSvg from '@/components/common/IconSvg.vue';
import ModuleGuideButton from '@/components/guide/ModuleGuideButton.vue';
import { triggerDownload } from '@/components/modals/download';
import {
  createOffscreenVtlRenderer,
  parseMetricsFromSnapshot,
  rasterReference,
  type OffscreenVtlRenderer,
} from './card-renderer';
import { samplePair } from './samples';
import * as session from './session';
import CardModuleGallery from './card/CardModuleGallery.vue';
import {
  CARD_MODULES,
  CARD_MODULE_MAP,
  adaptTreeToAspect,
  assignModuleToLeaf,
  buildAutoLayoutTree,
  detectDropZone,
  dockModuleOntoLeaf,
  equalizeLayoutTreeRatios,
  extractRowGrid,
  insertModuleIntoTree,
  listTreeModules,
  removeModuleFromTree,
  resizeSplitAtGutter,
  setGridCellWidthRatio,
  setGridRowColCount,
  setGridRowCount,
  setGridRowHeightRatio,
  stripEmptyLeaves,
  type CardDockZone,
  type CardGutter,
  type CardLayoutNode,
  type CardModuleBox,
  type CardModuleId,
} from './card/layout-tree';
import {
  CARD_COLOR_OPTIONS,
  CARD_SKIN_OPTIONS,
  type CardColorPresetId,
  type CardSkinChoice,
} from './card/card-themes';
import {
  composeCardToCanvas,
  type CardDesignOptions,
  type ComposeCardGeometry,
} from './card/card-composer';
import { CARD_FONT_OPTIONS, type CardFontId } from './card/draw-primitives';
import {
  encodeAudioBufferToWavBlob,
  evaluateDynamicCardState,
  listAvailablePlaybackSources,
  resolveAutoPlaybackSource,
  resolvePlaybackAudioBuffer,
  type CardPlaybackSourceId,
} from './card/playback-sources';
import { getCachedVowelRefs, prefetchSpeakerVowelRefs } from './card/vowel-ref-data';
import {
  resolveContinuumCardAsset,
  resolveIpaRichAsset,
  type ResolvedContinuumAsset,
  type ResolvedIpaRichAsset,
} from './card/real-module-assets';
import { prefetchExploreCaseClips } from './card/explore-case-media';
import type { RasterCardImage, SubPaneDirection } from './card/blocks/acoustic-blocks';

const wb = useWorkbenchStore();
const isOpen = computed(() => session.cardStudioOpen.value || wb.exportModalWorkspace.value === 'explore');
const { signature, stickers } = cardOptions;
const cardTitle = `${cardOptions.titlePrefix ?? ''}发音卡排版与导出工坊`;

function closeModal(): void {
  if (exporting.value) return;
  stopRealtimePreview();
  revokeEncodedPreview();
  session.closeCardStudio();
  if (wb.exportModalWorkspace.value === 'explore') {
    wb.closeExportModal();
  }
}

// 1. Canvas Dimensions & Aspect Ratio Management (1:1 single default, 16:9 compare default)
type RatioPreset = 'auto' | '1080x1080' | '1920x1080' | '1440x1080' | '1080x1440' | '1080x1920' | 'custom';
const ratioPreset = ref<RatioPreset>('auto');

const ratioChips: ReadonlyArray<{ id: RatioPreset; label: string }> = [
  { id: 'auto', label: '自动默认' },
  { id: '1080x1080', label: '1:1 方卡' },
  { id: '1920x1080', label: '16:9 横卡' },
  { id: '1440x1080', label: '4:3 横卡' },
  { id: '1080x1440', label: '3:4 竖卡' },
  { id: '1080x1920', label: '9:16 竖卡' },
];

function sanitizeDim(val: number, fallback: number, forceEven: boolean): number {
  const clamped = Math.min(3840, Math.max(360, Math.round(Number.isFinite(val) ? val : fallback)));
  return forceEven && clamped % 2 !== 0 ? clamped + 1 : clamped;
}

const cardDims = computed<[number, number]>(() => {
  const even = session.exploreCardFormat.value === 'MP4';
  return [
    sanitizeDim(session.exploreCardWidth.value, 1080, even),
    sanitizeDim(session.exploreCardHeight.value, 1080, even),
  ];
});

const currentAspect = computed(() => cardDims.value[0] / Math.max(1, cardDims.value[1]));

function selectRatioPreset(preset: RatioPreset): void {
  const prevAsp = currentAspect.value;
  ratioPreset.value = preset;
  if (preset === 'auto') {
    session.exploreCardAutoRatio.value = true;
    if (session.exploreMode.value === 'compare') {
      session.exploreCardWidth.value = 1920;
      session.exploreCardHeight.value = 1080;
    } else {
      session.exploreCardWidth.value = 1080;
      session.exploreCardHeight.value = 1080;
    }
  } else if (preset !== 'custom') {
    session.exploreCardAutoRatio.value = false;
    const [w, h] = preset.split('x').map(Number);
    if (w && h) {
      session.exploreCardWidth.value = w;
      session.exploreCardHeight.value = h;
    }
  }
  const nextAsp = session.exploreCardWidth.value / Math.max(1, session.exploreCardHeight.value);
  layoutTree.value = adaptTreeToAspect(layoutTree.value, prevAsp, nextAsp);
}

function updateCustomDim(axis: 'w' | 'h', rawVal: number): void {
  if (!Number.isFinite(rawVal)) return;
  const prevAsp = currentAspect.value;
  session.exploreCardAutoRatio.value = false;
  ratioPreset.value = 'custom';
  const clamped = Math.min(3840, Math.max(360, Math.round(rawVal)));
  if (axis === 'w') session.exploreCardWidth.value = clamped;
  else session.exploreCardHeight.value = clamped;
  const nextAsp = session.exploreCardWidth.value / Math.max(1, session.exploreCardHeight.value);
  layoutTree.value = adaptTreeToAspect(layoutTree.value, prevAsp, nextAsp);
}

function swapCardOrientation(): void {
  const prevAsp = currentAspect.value;
  session.exploreCardAutoRatio.value = false;
  ratioPreset.value = 'custom';
  const [w, h] = [session.exploreCardWidth.value, session.exploreCardHeight.value];
  session.exploreCardWidth.value = h;
  session.exploreCardHeight.value = w;
  const nextAsp = h / Math.max(1, w);
  layoutTree.value = adaptTreeToAspect(layoutTree.value, prevAsp, nextAsp);
}

// 2. Split-Tree Module Selection & Context Initialization
function defaultModulesForContext(ctx: string): CardModuleId[] {
  switch (ctx) {
    case 'main':
      return ['tract-profile', 'synth-timeline', 'vowel-space', 'transfer-fn'];
    case 'ipa':
      return ['ipa-wave-spec', 'ipa-lexicon'];
    case 'm27':
      return ['tract-profile', 'm27-reconstruct', 'artic-metrics'];
    case 'mixer':
      return ['continuum-grid', 'voice-mixer', 'artic-metrics'];
    case 'continuum':
      return ['continuum-grid', 'voice-mixer', 'artic-metrics'];
    case 'dialect':
      return ['dialect-sandhi', 'synth-timeline'];
    case 'arranger':
      return ['arranger-roll', 'tract-profile', 'transfer-fn'];
    case 'stage':
      return ['stage-nle', 'tract-profile', 'synth-timeline'];
    default:
      return ['tract-profile', 'cross-lip', 'transfer-fn', 'vowel-space'];
  }
}

const layoutTree = shallowRef<CardLayoutNode | null>(
  buildAutoLayoutTree(['tract-profile', 'cross-lip', 'transfer-fn', 'vowel-space'], 1),
);
const layoutVariant = ref(0);
const selectedLeafId = ref<string | null>(null);
const selectedModuleId = ref<CardModuleId | null>('tract-profile');
const userCustomizedModules = ref(false);
const selectedModuleIds = computed<CardModuleId[]>(() => listTreeModules(layoutTree.value));
const rowGrid = computed(() => extractRowGrid(layoutTree.value));
const hasTractModule = computed(() => selectedModuleIds.value.includes('tract-profile'));
const hasCrossLipModule = computed(() => selectedModuleIds.value.includes('cross-lip'));
const hasContinuumModule = computed(() => selectedModuleIds.value.includes('continuum-grid'));
const hasGlottisModule = computed(() => selectedModuleIds.value.includes('glottis-model'));
const hasSynthModule = computed(() => selectedModuleIds.value.includes('synth-timeline'));
const hasReconModule = computed(() => selectedModuleIds.value.includes('m27-reconstruct'));
const hasVowelModule = computed(() => selectedModuleIds.value.includes('vowel-space'));

const selectedCellInfo = computed(() => {
  const rows = rowGrid.value;
  if (!rows.length) return null;
  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const row = rows[rIdx];
    for (let cIdx = 0; cIdx < row.cells.length; cIdx++) {
      const cell = row.cells[cIdx];
      if (selectedLeafId.value && cell.leafId === selectedLeafId.value) {
        return { rowIndex: rIdx, colIndex: cIdx, row, cell };
      }
    }
  }
  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const row = rows[rIdx];
    for (let cIdx = 0; cIdx < row.cells.length; cIdx++) {
      const cell = row.cells[cIdx];
      if (selectedModuleId.value && cell.moduleId === selectedModuleId.value) {
        return { rowIndex: rIdx, colIndex: cIdx, row, cell };
      }
    }
  }
  return { rowIndex: 0, colIndex: 0, row: rows[0], cell: rows[0].cells[0] };
});

const slotModuleOptions: SelectOption<string>[] = [
  { value: '', label: '空槽位（待填入模块）' },
  ...CARD_MODULES.map((m) => ({ value: m.id, label: `${m.shortTitle} · ${m.sourcePage}` })),
];

const subPaneDirOptions: ReadonlyArray<{ id: SubPaneDirection; label: string }> = [
  { id: 'auto', label: '自动适配' },
  { id: 'row', label: '横向排列' },
  { id: 'col', label: '纵向排列' },
];

function selectGridCell(leafId: string, moduleId: CardModuleId | null): void {
  selectedLeafId.value = leafId;
  selectedModuleId.value = moduleId;
}

function onChangeRowCount(rows: number): void {
  userCustomizedModules.value = true;
  layoutTree.value = setGridRowCount(layoutTree.value, rows);
}

function onChangeRowCols(rowIndex: number, cols: number): void {
  userCustomizedModules.value = true;
  layoutTree.value = setGridRowColCount(layoutTree.value, rowIndex, cols);
}

function onChangeRowHeightPct(rowIndex: number, pct: number): void {
  userCustomizedModules.value = true;
  layoutTree.value = setGridRowHeightRatio(layoutTree.value, rowIndex, pct / 100);
}

function onChangeCellWidthPct(rowIndex: number, colIndex: number, pct: number): void {
  userCustomizedModules.value = true;
  layoutTree.value = setGridCellWidthRatio(layoutTree.value, rowIndex, colIndex, pct / 100);
}

function onAssignSelectedCellModule(rawMod: string): void {
  const info = selectedCellInfo.value;
  if (!info) return;
  userCustomizedModules.value = true;
  const nextMod = rawMod ? (rawMod as CardModuleId) : null;
  layoutTree.value = assignModuleToLeaf(layoutTree.value, info.cell.leafId, nextMod);
  selectedModuleId.value = nextMod;
}

function toggleModule(id: CardModuleId): void {
  userCustomizedModules.value = true;
  if (selectedModuleIds.value.includes(id)) {
    layoutTree.value = removeModuleFromTree(layoutTree.value, id);
    if (selectedModuleId.value === id) {
      selectedModuleId.value = listTreeModules(layoutTree.value)[0] ?? null;
    }
  } else {
    layoutTree.value = insertModuleIntoTree(layoutTree.value, id, currentAspect.value, selectedLeafId.value);
    selectedModuleId.value = id;
    const placed = extractRowGrid(layoutTree.value).flatMap((r) => r.cells).find((c) => c.moduleId === id);
    if (placed) selectedLeafId.value = placed.leafId;
  }
}

function applyModulePreset(ids: CardModuleId[], source?: CardPlaybackSourceId): void {
  if (source) playbackSource.value = source;
  userCustomizedModules.value = true;
  layoutVariant.value = 0;
  layoutTree.value = buildAutoLayoutTree(ids, currentAspect.value, 0);
  selectedLeafId.value = null;
  selectedModuleId.value = ids[0] ?? null;
}

function autoReflowModules(): void {
  layoutVariant.value = (layoutVariant.value + 1) % 3;
  layoutTree.value = buildAutoLayoutTree(selectedModuleIds.value, currentAspect.value, layoutVariant.value);
  selectedLeafId.value = null;
}

function equalizeGridRatios(): void {
  layoutTree.value = equalizeLayoutTreeRatios(layoutTree.value);
}

function matchCurrentWorkspaceModules(): void {
  const ws = wb.activeWorkspace.value;
  const ctx = ws === 'explore' ? 'explore' : ws === 'home' ? 'main' : ws === 'research' ? wb.researchTab.value : wb.studioTab.value;
  userCustomizedModules.value = true;
  layoutVariant.value = 0;
  const nextMods = defaultModulesForContext(ctx);
  layoutTree.value = buildAutoLayoutTree(nextMods, currentAspect.value, 0);
  selectedLeafId.value = null;
  selectedModuleId.value = nextMods[0] ?? null;
  playbackSource.value = 'auto';
  syncDurationToSource();
}

// 3. Card Design, Site Colorful Theme Default & Mascot Options
const titleOverride = ref('');
const mascotEnabled = ref(false);
const mascotStickerId = ref(stickers?.items[0]?.id ?? '');
const mascotUseAnimated = ref(true);

const visibleStickers = computed(() => {
  const items = stickers?.items ?? [];
  return isAnimatedFormat.value && mascotUseAnimated.value ? items.filter((item) => item.isGif) : items;
});

function setMascotMotionMode(animated: boolean): void {
  mascotUseAnimated.value = animated;
  if (animated && stickers && !stickers.items.some((item) => item.id === mascotStickerId.value && item.isGif)) {
    mascotStickerId.value = stickers.items.find((item) => item.isGif)?.id ?? '';
  }
}

const design = reactive<CardDesignOptions>({
  colorPreset: 'site',
  skinChoice: 'follow-site',
  font: 'noto-sans',
  tractView: 'sagittal',
  tractZoom: 1,
  showFullHead: false,
  showOrientationCompass: true,
  showVowelReferenceCloud: true,
  showReconGlottis: true,
  crossLipDirection: 'auto',
  continuumGridLayout: null,
  glottisDirection: 'auto',
  synthTracks: {
    syllables: true,
    phones: true,
    phonation: true,
    f0: true,
    pressure: true,
    waveform: false,
  },
  showHeader: true,
  showTechFootnote: true,
  titleScale: 1,
  textScale: 1,
  offsetA: { x: 0, y: 0 },
  offsetB: { x: 0, y: 0 },
  mascotScale: 1,
});

const fontOptions: SelectOption<CardFontId>[] = CARD_FONT_OPTIONS.map((f) => ({
  value: f.value,
  label: f.label,
}));

const tractViewOptions: SelectOption<'sagittal' | 'model'>[] = [
  { value: 'sagittal', label: '2D 矢状面剖面' },
  { value: 'model', label: '3D 空间声道网格' },
];

// 4. Playback Source, Range Trimming, Duration & Realtime Audio-Visual Sync
const playbackSource = ref<CardPlaybackSourceId>('auto');
const rangeStart_s = ref(0);
const duration_s = ref(2.4);
const mp4Fps = ref<24 | 30>(24);
const gifFps = ref<12 | 15 | 20>(15);
const includeAudioInMp4 = ref(true);

const availableSources = computed(() => listAvailablePlaybackSources(wb));
const playbackSourceOptions = computed<SelectOption<CardPlaybackSourceId>[]>(() => [
  { value: 'auto', label: '自动匹配所选模块' },
  ...availableSources.value.map((s) => ({
    value: s.id,
    label: s.label,
  })),
]);

const resolvedPlaybackId = computed(() =>
  resolveAutoPlaybackSource(playbackSource.value, selectedModuleIds.value, session.cardStudioContextSource.value),
);

const activeSourceMeta = computed(
  () => availableSources.value.find((s) => s.id === resolvedPlaybackId.value) ?? availableSources.value[0],
);

const maxTrimEnd_s = computed(() => {
  if (resolvedPlaybackId.value === 'ipa' && cachedIpaAsset.value?.recordingDuration_s) {
    return Math.max(1, cachedIpaAsset.value.recordingDuration_s);
  }
  return Math.max(1, activeSourceMeta.value?.naturalDuration_s ?? 4);
});

function syncDurationToSource(): void {
  const info = activeSourceMeta.value;
  if (!info) return;
  rangeStart_s.value = 0;
  const ipaDur = resolvedPlaybackId.value === 'ipa' ? cachedIpaAsset.value?.recordingDuration_s : undefined;
  const natDur = ipaDur && ipaDur > 0.2 ? ipaDur : info.naturalDuration_s;
  duration_s.value = Number(Math.min(12, Math.max(0.6, natDur)).toFixed(2));
}

watch(resolvedPlaybackId, () => {
  stopRealtimePreview();
  previewTime_s.value = 0;
  syncDurationToSource();
});

const isAnimatedFormat = computed(() => session.exploreCardFormat.value !== 'PNG');
const previewTime_s = ref(0);
const isPlayingPreview = ref(false);
const loopPreview = ref(true);

let previewRafId = 0;
let previewAudioCtx: AudioContext | null = null;
let previewAudioNode: AudioBufferSourceNode | null = null;
let previewStartStamp = 0;
let previewStartOffset_s = 0;
let previewPlayToken = 0;

// Cached real assets from IpaPlusView & ContinuumView (reused across frames, zero fake placeholders)
const cachedIpaAsset = shallowRef<ResolvedIpaRichAsset | null>(null);
const cachedContinuumAsset = shallowRef<ResolvedContinuumAsset | null>(null);
const continuumCellCount = computed(() => panelSnapshots.continuum.value?.cells.length ?? cachedContinuumAsset.value?.cells.length ?? 5);
const continuumLayoutOptions = [
  { id: 'auto', label: '自动' },
  { id: 'rows', label: '按行数' },
  { id: 'columns', label: '按列数' },
] as const;
const continuumLayoutCount = computed(() => Math.min(continuumCellCount.value, design.continuumGridLayout?.count ?? 1));

function setContinuumLayout(axis: typeof continuumLayoutOptions[number]['id']): void {
  if (axis === 'auto') {
    design.continuumGridLayout = null;
  } else if (design.continuumGridLayout?.axis !== axis) {
    const snap = panelSnapshots.continuum.value;
    const count = snap?.dualAxis ? (axis === 'rows' ? snap.rows : snap.columns) : (axis === 'rows' ? 2 : 5);
    design.continuumGridLayout = { axis, count: Math.min(continuumCellCount.value, count) };
  }
}

function setContinuumLayoutCount(event: Event): void {
  const input = event.target as HTMLInputElement;
  const layout = design.continuumGridLayout;
  if (!layout) return;
  if (input.validity.valid) layout.count = input.valueAsNumber;
  input.value = String(continuumLayoutCount.value);
}

let lastIpaAssetKey = '';
let lastContinuumAssetKey = '';
let lastIpaSnapRef: unknown = null;
let lastContSnapRef: unknown = null;

async function ensureRealModuleAssets(speaker: string): Promise<{
  ipaAsset: ResolvedIpaRichAsset | null;
  continuumAsset: ResolvedContinuumAsset | null;
}> {
  const mods = selectedModuleIds.value;
  const src = resolvedPlaybackId.value;
  const needIpa =
    mods.includes('ipa-wave-spec')
    || mods.includes('ipa-lexicon')
    || mods.includes('m27-reconstruct')
    || src === 'ipa';
  const needCont = mods.includes('continuum-grid') || src === 'continuum';

  if (src === 'explore' && !session.exploreUsesSourcePose.value) {
    await prefetchExploreCaseClips(session.exploreActiveCaseId.value);
  }

  let ipaAsset = cachedIpaAsset.value;
  if (needIpa) {
    const ipaSnap = panelSnapshots.ipa.value;
    const fallbackSym = session.exploreIpaLabel.value.replace(/^\[|\]$/g, '').trim() || 'i';
    const ipaKey = `${speaker}|${ipaSnap?.symbol ?? fallbackSym}|${ipaSnap?.referenceId ?? ''}|${ipaSnap?.m27RowsPa?.length ?? 0}`;
    if (!ipaAsset || lastIpaAssetKey !== ipaKey || lastIpaSnapRef !== ipaSnap) {
      ipaAsset = await resolveIpaRichAsset(fallbackSym, speaker, wb.currentTractParams.value);
      cachedIpaAsset.value = ipaAsset;
      lastIpaAssetKey = ipaKey;
      lastIpaSnapRef = ipaSnap;
      if (src === 'ipa' && ipaAsset.recordingDuration_s && ipaAsset.recordingDuration_s > 0.2 && !isPlayingPreview.value) {
        duration_s.value = Number(Math.min(12, Math.max(1, ipaAsset.recordingDuration_s)).toFixed(2));
      }
    }
  } else {
    ipaAsset = null;
  }

  let continuumAsset = cachedContinuumAsset.value;
  if (needCont) {
    const contSnap = panelSnapshots.continuum.value;
    const themeSig = JSON.stringify([wb.resolvedColorMode.value, wb.paletteId.value, wb.customAccentHex.value, wb.anatomyAppearance.value]);
    const contKey = `${speaker}|${contSnap?.cells.length ?? 0}|${wb.engineStatus.value}|${themeSig}|${session.exploreIpaLabel.value}|${session.exploreCompareIpaB.value}`;
    if (!continuumAsset || lastContinuumAssetKey !== contKey || lastContSnapRef !== contSnap) {
      continuumAsset = await resolveContinuumCardAsset({
        speaker,
        paramsA: wb.currentTractParams.value,
        paramsB: session.exploreComparePoseB.value,
        extrasA: wb.currentTractExtras.value,
        extrasB: session.exploreCompareExtrasB.value,
        labelA: session.exploreWordLabel.value || '构型 A',
        ipaA: session.exploreIpaLabel.value || 'i',
        labelB: session.exploreCompareLabelB.value || '构型 B',
        ipaB: session.exploreCompareIpaB.value || 'u',
        f0Hz: wb.currentGlottisParams.value.f0_hz,
        themeSig,
        engineOnline: wb.engineStatus.value === 'python-vtl',
      });
      if (!unmounted && panelSnapshots.continuum.value === contSnap) {
        cachedContinuumAsset.value = continuumAsset;
        lastContinuumAssetKey = contKey;
        lastContSnapRef = contSnap;
      }
    }
  } else {
    continuumAsset = null;
  }

  return { ipaAsset, continuumAsset };
}

// Encoded real video/GIF preview blob inside modal
const encodedPreviewUrl = ref('');
const encodedPreviewMime = ref<'video/mp4' | 'image/gif' | ''>('');
const encodedPreviewSizeKb = ref(0);

function revokeEncodedPreview(): void {
  if (encodedPreviewUrl.value) {
    URL.revokeObjectURL(encodedPreviewUrl.value);
    encodedPreviewUrl.value = '';
    encodedPreviewMime.value = '';
    encodedPreviewSizeKb.value = 0;
  }
}

function stopRealtimePreview(): void {
  previewPlayToken++;
  isPlayingPreview.value = false;
  if (previewRafId) {
    cancelAnimationFrame(previewRafId);
    previewRafId = 0;
  }
  if (previewAudioNode) {
    try {
      previewAudioNode.onended = null;
      previewAudioNode.stop();
      previewAudioNode.disconnect();
    } catch {
      // ignore stopped node
    }
    previewAudioNode = null;
  }
}

function startPreviewAudioNode(
  ctx: AudioContext,
  clip: AudioBuffer,
  offsetSec: number,
  loop: boolean,
  token: number,
): void {
  if (previewAudioNode) {
    try {
      previewAudioNode.onended = null;
      previewAudioNode.stop();
      previewAudioNode.disconnect();
    } catch {
      // ignore stopped node
    }
    previewAudioNode = null;
  }
  const safeOffset = offsetSec >= clip.duration - 0.03 ? 0 : Math.max(0, offsetSec);
  const src = ctx.createBufferSource();
  src.buffer = clip;
  src.loop = loop && Math.abs(clip.duration - duration_s.value) <= 0.12;
  if (src.loop) {
    src.loopStart = 0;
    src.loopEnd = Math.min(duration_s.value, clip.duration);
  }
  src.connect(ctx.destination);
  previewStartStamp = ctx.currentTime - safeOffset;
  src.start(0, safeOffset);
  previewAudioNode = src;
  src.onended = () => {
    if (token === previewPlayToken && !loopPreview.value && previewAudioNode === src) {
      previewAudioNode = null;
    }
  };
}

async function toggleRealtimePreview(): Promise<void> {
  revokeEncodedPreview();
  if (isPlayingPreview.value) {
    stopRealtimePreview();
    return;
  }
  const token = ++previewPlayToken;
  isPlayingPreview.value = true;
  feedbackText.value = '';
  if (previewTime_s.value >= duration_s.value - 0.05) {
    previewTime_s.value = 0;
  }
  previewStartOffset_s = previewTime_s.value;

  const wantSound = session.exploreCardFormat.value === 'PNG'
    || (session.exploreCardFormat.value === 'MP4' && includeAudioInMp4.value);
  if (wantSound) {
    // Synchronously unlock AudioContext inside user gesture before any await
    try {
      previewAudioCtx ??= new AudioContext();
      void previewAudioCtx.resume();
    } catch {
      // fallback to visual-only preview if Web Audio fails
    }
  }

  let audioDriven = false;
  let activeClip: AudioBuffer | null = null;
  if (wantSound) {
    progressText.value = '正在准备同步预览音轨…';
    try {
      const speaker = wb.project.value.voices[wb.activeVoiceId.value]?.speaker ?? 'JD2';
      const { ipaAsset, continuumAsset } = await ensureRealModuleAssets(speaker);
      if (token !== previewPlayToken) return;
      if (previewAudioCtx && previewAudioCtx.state === 'suspended') {
        await previewAudioCtx.resume();
      }
      const fullClip = await resolvePlaybackAudioBuffer({
        source: resolvedPlaybackId.value,
        rangeStart_s: rangeStart_s.value,
        rangeDuration_s: duration_s.value,
        store: wb,
        ipaAsset,
        continuumAsset,
      });
      if (token !== previewPlayToken) return;
      if (fullClip && previewAudioCtx) {
        activeClip = fullClip;
        if (previewStartOffset_s >= fullClip.duration - 0.05) {
          previewStartOffset_s = 0;
          previewTime_s.value = 0;
        }
        startPreviewAudioNode(previewAudioCtx, fullClip, previewStartOffset_s, loopPreview.value, token);
        audioDriven = true;
      } else {
        feedbackText.value = '当前源暂无可播放音轨（请确认本地语音引擎已启动），仅预览画面动态';
      }
    } catch {
      audioDriven = false;
      feedbackText.value = '预览音轨准备失败，已切换为仅画面动态预览';
    } finally {
      if (token === previewPlayToken) {
        progressText.value = '';
      }
    }
  }

  if (token !== previewPlayToken || !isPlayingPreview.value) return;

  if (!audioDriven) {
    previewStartStamp = performance.now() / 1000 - previewStartOffset_s;
  }

  const step = () => {
    if (token !== previewPlayToken || !isPlayingPreview.value) return;
    const elapsed = audioDriven && previewAudioCtx
      ? previewAudioCtx.currentTime - previewStartStamp
      : performance.now() / 1000 - previewStartStamp;
    if (elapsed >= duration_s.value) {
      if (loopPreview.value) {
        previewTime_s.value = 0;
        if (audioDriven && previewAudioCtx && activeClip) {
          if (!previewAudioNode?.loop) {
            startPreviewAudioNode(previewAudioCtx, activeClip, 0, true, token);
          } else {
            previewStartStamp = previewAudioCtx.currentTime;
          }
        } else {
          previewStartStamp = performance.now() / 1000;
        }
      } else {
        stopRealtimePreview();
        previewTime_s.value = duration_s.value;
        scheduleCanvasPaint();
        return;
      }
    } else {
      previewTime_s.value = Math.max(0, elapsed);
    }
    scheduleCanvasPaint();
    previewRafId = requestAnimationFrame(step);
  };
  previewRafId = requestAnimationFrame(step);
}

// 5. Offscreen VTL Geometry & Canvas Rendering Pipeline
const previewCanvas = ref<HTMLCanvasElement | null>(null);
const renderedGeometry = shallowRef<ComposeCardGeometry | undefined>(undefined);
const previewBusy = ref(false);
const exporting = ref(false);
const progressText = ref('');
const feedbackText = ref('');

let offscreenRenderer: OffscreenVtlRenderer | null = null;
let offscreenRendererKey = '';
const poseCache = new Map<string, Promise<Record<string, unknown> | null>>();
let renderSeq = 0;
let paintRafId = 0;
let paintInFlight = false;
let paintQueued = false;
let unmounted = false;

function fetchPoseCached(
  speaker: string,
  params: Record<TractParamName, number>,
  extras: TractPoseExtras,
): Promise<Record<string, unknown> | null> {
  if (unmounted || wb.engineStatus.value !== 'python-vtl') return Promise.resolve(null);
  const input = { speaker, section_count: 65, params: tractRecordToArray19(params), ...extras };
  const key = vtlPoseKey(input);
  const hit = poseCache.get(key);
  if (hit) return hit;
  const req = resolveVtlPose(input).then((state) => {
    if (!state && poseCache.get(key) === req) poseCache.delete(key);
    return state;
  });
  poseCache.set(key, req);
  if (poseCache.size > 32) {
    const oldest = poseCache.keys().next().value;
    if (oldest) poseCache.delete(oldest);
  }
  return req;
}

async function ensureOffscreenRenderer(
  view: 'sagittal' | 'model',
  showFullHead: boolean,
  widthPx: number,
): Promise<OffscreenVtlRenderer | null> {
  if (!wb.engineMeta.value) return null;
  const nextKey = `${view}|${showFullHead ? 'head' : 'oral'}`;
  if (offscreenRenderer && offscreenRendererKey === nextKey) return offscreenRenderer;
  offscreenRenderer?.destroy();
  const resolvedW = Math.min(1100, Math.max(460, widthPx));
  offscreenRenderer = await createOffscreenVtlRenderer(wb.engineMeta.value, {
    width: resolvedW,
    ...(view === 'model' ? { height: Math.round(resolvedW * 0.86) } : {}),
    labels: false,
    focused: !showFullHead,
    oralFocus: false,
    head: showFullHead,
    view,
  });
  offscreenRendererKey = nextKey;
  return offscreenRenderer;
}

async function renderCardFrameToCanvas(
  targetCanvas: HTMLCanvasElement,
  w: number,
  h: number,
  localTime_s: number,
  animated: boolean,
  highQualityPose = false,
): Promise<ComposeCardGeometry | undefined> {
  const speaker = wb.project.value.voices[wb.activeVoiceId.value]?.speaker ?? 'JD2';
  const compare = session.exploreMode.value === 'compare' && resolvedPlaybackId.value === 'explore';
  const { ipaAsset, continuumAsset } = await ensureRealModuleAssets(speaker);
  const dyn = evaluateDynamicCardState({
    source: resolvedPlaybackId.value,
    localTime_s,
    rangeStart_s: rangeStart_s.value,
    rangeDuration_s: duration_s.value,
    store: wb,
    ipaAsset,
    continuumAsset,
  });

  const needTract = hasTractModule.value || selectedModuleIds.value.includes('ipa-lexicon');
  let stateA: Record<string, unknown> | null =
    compare ? session.exploreCompareStateA.value : wb.currentTractState.value;
  let stateB: Record<string, unknown> | null = compare ? session.exploreCompareStateB.value : null;

  const needLiveFetch =
    wb.engineStatus.value === 'python-vtl'
    && (hasCrossLipModule.value || highQualityPose || animated || !stateA || (compare && !stateB) || resolvedPlaybackId.value !== 'explore');
  if (needLiveFetch) {
    const [fetchedA, fetchedB] = await Promise.all([
      fetchPoseCached(speaker, dyn.paramsA, dyn.extrasA),
      compare ? fetchPoseCached(speaker, dyn.paramsB, dyn.extrasB) : Promise.resolve(null),
    ]);
    if (fetchedA) stateA = fetchedA;
    if (fetchedB) stateB = fetchedB;
  }

  let vtlImageA: RasterCardImage | null = null;
  let vtlImageB: RasterCardImage | null = null;

  if (needTract) {
    const vtl = stateA ? await ensureOffscreenRenderer(design.tractView, design.showFullHead, Math.round(w * 0.65)) : null;
    if (vtl && stateA) {
      vtlImageA = await vtl.renderState(stateA);
      if (compare && stateB) vtlImageB = await vtl.renderState(stateB);
    }
    if (!vtlImageA && design.tractView === 'sagittal' && !session.exploreUsesSourcePose.value) {
      const pair = samplePair(session.exploreActiveCaseId.value);
      vtlImageA = await rasterReference(pair.a, dyn.clipProgress01, design.showFullHead);
      if (compare && !vtlImageB) vtlImageB = await rasterReference(pair.b, dyn.clipProgress01, design.showFullHead);
    }
  }

  const mascotImg = stickers && mascotEnabled.value
    ? await stickers.resolveFrame(
        mascotStickerId.value,
        localTime_s,
        mascotUseAnimated.value && (isAnimatedFormat.value || animated),
      )
    : null;
  const metricsA = dyn.metricsOverrideA ?? parseMetricsFromSnapshot(stateA, dyn.paramsA);
  const metricsB = compare ? (dyn.metricsOverrideB ?? parseMetricsFromSnapshot(stateB, dyn.paramsB)) : null;

  // Blank main title by default unless explicitly typed by user
  const explicitTitle = titleOverride.value.trim();
  const isExploreSource = resolvedPlaybackId.value === 'explore';
  const ipaHeader = compare
    ? [session.exploreIpaLabel.value, session.exploreCompareIpaB.value].filter(Boolean).join('  /  ')
    : dyn.utteranceIpa || (dyn.activeSymbol ? `[${dyn.activeSymbol}]` : '');
  const synthesis = dyn.resolvedSource === 'synthesis' ? panelSnapshots.synthesis.value : null;
  const labelClip = synthesis?.clip ?? wb.project.value.clips[wb.activeClipId.value];
  const primaryLabel = isExploreSource
    ? session.exploreWordLabel.value
    : labelClip?.source?.lyrics?.trim() || synthesis?.lyrics.trim() || activeSourceMeta.value?.label || '';
  const primaryIpa = isExploreSource
    ? session.exploreIpaLabel.value
    : dyn.utteranceIpa || (dyn.activeSymbol ? `[${dyn.activeSymbol}]` : '');

  const geometryNote =
    design.tractView === 'model'
      ? 'VTL 2.4 3D'
      : stateA
        ? 'VTL 2.4'
        : '解析几何';

  return composeCardToCanvas({
    canvas: targetCanvas,
    canvasWidth: w,
    canvasHeight: h,
    layoutTree: highQualityPose ? stripEmptyLeaves(layoutTree.value) : layoutTree.value,
    design,
    compare,
    title: explicitTitle,
    ipaHeader,
    activeSymbol: dyn.activeSymbol,
    vowelSymbolA: dyn.vowelSymbolA,
    vowelSymbolB: dyn.vowelSymbolB,
    labelA: primaryLabel,
    ipaA: primaryIpa,
    labelB: session.exploreCompareLabelB.value,
    ipaB: session.exploreCompareIpaB.value,
    authorSignature: signature?.formatted.value ?? '',
    geometryNote,
    metricsA,
    metricsB,
    paramsA: dyn.paramsA,
    paramsB: dyn.paramsB,
    extrasA: dyn.extrasA,
    glottis: dyn.glottis,
    snapshotA: (stateA as PtbPoseSnapshot | null) ?? null,
    vtlImageA,
    vtlImageB,
    mascotImage: mascotImg,
    vowelRefs: getCachedVowelRefs(speaker),
    project: wb.project.value,
    activeClipId: wb.activeClipId.value,
    activeVoiceId: wb.activeVoiceId.value,
    animated,
    clipProgress01: dyn.clipProgress01,
    time_s: dyn.time_s,
    trailPoints: dyn.trailPoints,
    ipaAsset,
    continuumAsset,
    continuumCellIndex: dyn.continuumCellIndex,
  });
}

const previewSize = computed<[number, number]>(() => {
  const [w, h] = cardDims.value;
  const scale = Math.min(1280 / w, 1280 / h, 1);
  return [Math.round(w * scale), Math.round(h * scale)];
});

function scheduleCanvasPaint(): void {
  if (!isOpen.value || unmounted) return;
  if (paintInFlight) {
    paintQueued = true;
    return;
  }
  if (paintRafId) return;
  paintRafId = requestAnimationFrame(() => {
    paintRafId = 0;
    void runCanvasPaint();
  });
}

async function runCanvasPaint(): Promise<void> {
  const canvas = previewCanvas.value;
  if (!canvas || !isOpen.value || unmounted) return;
  paintInFlight = true;
  paintQueued = false;
  const seq = ++renderSeq;
  const [pw, ph] = previewSize.value;
  try {
    const selectedFontMeta = CARD_FONT_OPTIONS.find((f) => f.value === design.font);
    if (selectedFontMeta?.preloadFamily && document.fonts?.load) {
      await Promise.allSettled([
        document.fonts.load(`400 16px "${selectedFontMeta.preloadFamily}"`),
        document.fonts.load(`700 16px "${selectedFontMeta.preloadFamily}"`),
      ]);
    }
    await document.fonts?.ready;
    const geom = await renderCardFrameToCanvas(
      canvas,
      pw,
      ph,
      previewTime_s.value,
      isAnimatedFormat.value || isPlayingPreview.value || previewTime_s.value > 0.001,
      false,
    );
    if (seq === renderSeq && !unmounted) {
      renderedGeometry.value = geom;
      if (!isPlayingPreview.value && feedbackText.value.startsWith('预览渲染异常')) {
        feedbackText.value = '';
      }
    }
  } catch (err) {
    if (seq === renderSeq && !unmounted) {
      feedbackText.value = err instanceof Error ? `预览渲染异常：${err.message}` : '预览渲染异常';
    }
  } finally {
    paintInFlight = false;
    if (paintQueued && !unmounted) scheduleCanvasPaint();
  }
}

// 6. Snap-to-Slot Module Dragging & Split-Tree Gutter Dragging
const draggingModuleId = ref<CardModuleId | null>(null);
const hoverDropTarget = ref<{
  leafId: string;
  moduleId: CardModuleId | null;
  zone: CardDockZone;
  box: CardModuleBox;
} | null>(null);

function pctStyle(box: { x: number; y: number; w: number; h: number }): Record<string, string> {
  const [pw, ph] = previewSize.value;
  return {
    left: `${(box.x / Math.max(1, pw)) * 100}%`,
    top: `${(box.y / Math.max(1, ph)) * 100}%`,
    width: `${(box.w / Math.max(1, pw)) * 100}%`,
    height: `${(box.h / Math.max(1, ph)) * 100}%`,
  };
}

const dropPreviewRectStyle = computed<Record<string, string> | null>(() => {
  const target = hoverDropTarget.value;
  if (!target) return null;
  const { x, y, w, h } = target.box;
  let rx = x;
  let ry = y;
  let rw = w;
  let rh = h;
  if (target.zone === 'left') rw = w * 0.5;
  else if (target.zone === 'right') {
    rx = x + w * 0.5;
    rw = w * 0.5;
  } else if (target.zone === 'top') rh = h * 0.5;
  else if (target.zone === 'bottom') {
    ry = y + h * 0.5;
    rh = h * 0.5;
  }
  return pctStyle({ x: rx, y: ry, w: rw, h: rh });
});

const dropZoneLabel = computed(() => {
  const target = hoverDropTarget.value;
  if (!target) return '';
  if (target.zone === 'swap') return target.moduleId ? '松手互换模块槽位' : '松手填入该空槽位';
  if (target.zone === 'left') return '吸附至左侧分栏';
  if (target.zone === 'right') return '吸附至右侧分栏';
  if (target.zone === 'top') return '插入至上方分行';
  return '插入至下方分行';
});

function startSlotPointerDrag(mb: CardModuleBox, ev: PointerEvent): void {
  const moduleId = mb.moduleId;
  if (!moduleId || ev.button !== 0 || exporting.value) return;
  ev.preventDefault();
  ev.stopPropagation();
  selectGridCell(mb.leafId, moduleId);
  draggingModuleId.value = moduleId;
  hoverDropTarget.value = null;

  const onMove = (moveEv: PointerEvent) => {
    const canvas = previewCanvas.value;
    const geom = renderedGeometry.value;
    if (!canvas || !geom) return;
    const rect = canvas.getBoundingClientRect();
    const cx = ((moveEv.clientX - rect.left) / Math.max(1, rect.width)) * previewSize.value[0];
    const cy = ((moveEv.clientY - rect.top) / Math.max(1, rect.height)) * previewSize.value[1];
    const hit = geom.moduleBoxes.find(
      (b) => b.leafId !== mb.leafId && cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h,
    );
    if (hit) {
      const relX = (cx - hit.x) / Math.max(1, hit.w);
      const relY = (cy - hit.y) / Math.max(1, hit.h);
      hoverDropTarget.value = {
        leafId: hit.leafId,
        moduleId: hit.moduleId,
        zone: detectDropZone(relX, relY),
        box: hit,
      };
    } else {
      hoverDropTarget.value = null;
    }
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    if (draggingModuleId.value && hoverDropTarget.value) {
      userCustomizedModules.value = true;
      layoutTree.value = dockModuleOntoLeaf(
        layoutTree.value,
        draggingModuleId.value,
        hoverDropTarget.value.leafId,
        hoverDropTarget.value.zone,
      );
    }
    draggingModuleId.value = null;
    hoverDropTarget.value = null;
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

// Support dragging a module directly from left CardModuleGallery onto the canvas
function onGalleryDragStart(id: CardModuleId): void {
  draggingModuleId.value = id;
}

function onStageDragOver(ev: DragEvent): void {
  const srcId = draggingModuleId.value;
  const canvas = previewCanvas.value;
  const geom = renderedGeometry.value;
  if (!srcId || !canvas || !geom) return;
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const cx = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * previewSize.value[0];
  const cy = ((ev.clientY - rect.top) / Math.max(1, rect.height)) * previewSize.value[1];
  const hit = geom.moduleBoxes.find(
    (b) => b.moduleId !== srcId && cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h,
  );
  if (hit) {
    hoverDropTarget.value = {
      leafId: hit.leafId,
      moduleId: hit.moduleId,
      zone: detectDropZone((cx - hit.x) / Math.max(1, hit.w), (cy - hit.y) / Math.max(1, hit.h)),
      box: hit,
    };
  } else {
    hoverDropTarget.value = null;
  }
}

function onStageDrop(ev: DragEvent): void {
  ev.preventDefault();
  const srcId = draggingModuleId.value;
  const target = hoverDropTarget.value;
  draggingModuleId.value = null;
  hoverDropTarget.value = null;
  if (!srcId) return;
  userCustomizedModules.value = true;
  if (target) {
    layoutTree.value = dockModuleOntoLeaf(layoutTree.value, srcId, target.leafId, target.zone);
  } else if (!selectedModuleIds.value.includes(srcId)) {
    layoutTree.value = insertModuleIntoTree(layoutTree.value, srcId, currentAspect.value, selectedLeafId.value);
  }
}

// Split-Tree Gutter Dragging (left/right & up/down resizing between cards)
const activeGutterId = ref<string | null>(null);

function startGutterDrag(gutter: CardGutter, ev: PointerEvent): void {
  if (ev.button !== 0 || exporting.value) return;
  ev.preventDefault();
  ev.stopPropagation();
  const canvas = previewCanvas.value;
  if (!canvas) return;
  const startTree = layoutTree.value;
  if (!startTree) return;

  activeGutterId.value = gutter.id;
  const startX = ev.clientX;
  const startY = ev.clientY;
  const rect = canvas.getBoundingClientRect();
  const pxScaleX = rect.width / Math.max(1, previewSize.value[0]);
  const pxScaleY = rect.height / Math.max(1, previewSize.value[1]);
  const spanScreenPx = Math.max(24, gutter.totalSpanPx * (gutter.dir === 'row' ? pxScaleX : pxScaleY));

  const onMove = (moveEv: PointerEvent) => {
    const deltaPx = gutter.dir === 'row' ? moveEv.clientX - startX : moveEv.clientY - startY;
    const deltaFrac = deltaPx / spanScreenPx;
    layoutTree.value = resizeSplitAtGutter(startTree, gutter.splitId, gutter.index, deltaFrac);
  };

  const onUp = () => {
    activeGutterId.value = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

// Fine pan mode for vocal tract / mascot inside their slot
type FineLayer = 'none' | 'a' | 'b' | 'mascot';
const fineLayer = ref<FineLayer>('none');

function resetFineLayer(): void {
  design.tractZoom = 1;
  design.offsetA = { x: 0, y: 0 };
  design.offsetB = { x: 0, y: 0 };
  delete design.mascotX;
  delete design.mascotY;
}

function resetTractFraming(): void {
  design.tractZoom = 1;
  design.offsetA = { x: 0, y: 0 };
  design.offsetB = { x: 0, y: 0 };
}

function onSlotWheel(mb: CardModuleBox, ev: WheelEvent): void {
  if (mb.moduleId !== 'tract-profile' || exporting.value) return;
  ev.preventDefault();
  selectedModuleId.value = 'tract-profile';
  const step = ev.deltaY < 0 ? 0.08 : -0.08;
  design.tractZoom = Math.max(0.5, Math.min(3.2, Number((design.tractZoom + step).toFixed(2))));
}

function onSlotBodyPointerDown(mb: CardModuleBox, ev: PointerEvent): void {
  if (ev.button !== 0 || exporting.value) return;
  selectGridCell(mb.leafId, mb.moduleId);
  if (mb.moduleId !== 'tract-profile') return;
  const canvas = previewCanvas.value;
  if (!canvas) return;
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const cx = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * previewSize.value[0];
  const cy = ((ev.clientY - rect.top) / Math.max(1, rect.height)) * previewSize.value[1];
  const boxB = renderedGeometry.value?.tractBoxes?.b;
  const isSideB = Boolean(boxB && cx >= boxB.x && cx <= boxB.x + boxB.w && cy >= boxB.y && cy <= boxB.y + boxB.h);
  const targetKey = isSideB ? 'offsetB' : 'offsetA';
  const initX = design[targetKey].x;
  const initY = design[targetKey].y;
  const sx = ev.clientX;
  const sy = ev.clientY;
  const slotW = Math.max(40, (mb.w / Math.max(1, previewSize.value[0])) * rect.width);
  const slotH = Math.max(40, (mb.h / Math.max(1, previewSize.value[1])) * rect.height);

  const onMove = (me: PointerEvent) => {
    const dx = (me.clientX - sx) / slotW;
    const dy = (me.clientY - sy) / slotH;
    design[targetKey] = {
      x: Math.max(-0.55, Math.min(0.55, initX + dx)),
      y: Math.max(-0.55, Math.min(0.55, initY + dy)),
    };
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

function startFinePan(ev: PointerEvent): void {
  if (fineLayer.value === 'none' || ev.button !== 0 || exporting.value) return;
  const canvas = previewCanvas.value;
  if (!canvas) return;
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const sx = ev.clientX;
  const sy = ev.clientY;
  const initX =
    fineLayer.value === 'mascot'
      ? (design.mascotX ?? 0.88)
      : fineLayer.value === 'b'
        ? design.offsetB.x
        : design.offsetA.x;
  const initY =
    fineLayer.value === 'mascot'
      ? (design.mascotY ?? 0.82)
      : fineLayer.value === 'b'
        ? design.offsetB.y
        : design.offsetA.y;

  const onMove = (me: PointerEvent) => {
    const dx = (me.clientX - sx) / Math.max(1, rect.width);
    const dy = (me.clientY - sy) / Math.max(1, rect.height);
    if (fineLayer.value === 'mascot') {
      design.mascotX = Math.max(0.05, Math.min(0.95, initX + dx));
      design.mascotY = Math.max(0.05, Math.min(0.95, initY + dy));
    } else {
      const target = fineLayer.value === 'b' ? 'offsetB' : 'offsetA';
      design[target] = {
        x: Math.max(-0.45, Math.min(0.45, initX + dx)),
        y: Math.max(-0.45, Math.min(0.45, initY + dy)),
      };
    }
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// 7. Full-Resolution Export & Encoded Video/GIF Generation
function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('浏览器无法生成 PNG 帧。'))), 'image/png'),
  );
}

async function generateCardMediaBlob(fmt: session.ExploreCardFormat): Promise<Blob> {
  const [w, h] = cardDims.value;
  const outCanvas = document.createElement('canvas');

  if (fmt === 'PNG') {
    progressText.value = '正在渲染当前帧高清静态发音卡…';
    await renderCardFrameToCanvas(outCanvas, w, h, previewTime_s.value, previewTime_s.value > 0.001, true);
    return await canvasToPngBlob(outCanvas);
  }

  const fmtLower = fmt === 'MP4' ? 'mp4' : 'gif';
  const fps = fmt === 'MP4' ? mp4Fps.value : gifFps.value;
  const totalFrames = Math.max(6, Math.min(450, Math.round(duration_s.value * fps)));

  progressText.value = '正在初始化动态卡片编码会话…';
  const initResp = await fetch(`/api/explore/card-job?format=${fmtLower}&fps=${fps}`, { method: 'POST' });
  if (!initResp.ok) {
    const err = (await initResp.json().catch(() => ({}))) as { hint?: string };
    throw new Error(err.hint || '动态编码需要启动参赛版本地代理服务（端口 3002）。');
  }
  const { id } = (await initResp.json()) as { id: string };
  const jobBase = `/api/explore/card-job/${encodeURIComponent(id)}`;

  try {
    let wavBlob: Blob | undefined;
    if (fmt === 'MP4' && includeAudioInMp4.value) {
      progressText.value = '正在准备模块同步发声音轨…';
      const speaker = wb.project.value.voices[wb.activeVoiceId.value]?.speaker ?? 'JD2';
      const { ipaAsset, continuumAsset } = await ensureRealModuleAssets(speaker);
      const audioBuf = await resolvePlaybackAudioBuffer({
        source: resolvedPlaybackId.value,
        rangeStart_s: rangeStart_s.value,
        rangeDuration_s: duration_s.value,
        store: wb,
        ipaAsset,
        continuumAsset,
      });
      if (audioBuf) {
        wavBlob = encodeAudioBufferToWavBlob(audioBuf);
      }
    }

    const batchSize = 8;
    for (let start = 0; start < totalFrames; start += batchSize) {
      const batchBlobs: Blob[] = [];
      const end = Math.min(totalFrames, start + batchSize);
      for (let i = start; i < end; i++) {
        progressText.value = `正在渲染动态画面帧 ${i + 1} / ${totalFrames}…`;
        const t = (i / totalFrames) * duration_s.value;
        await renderCardFrameToCanvas(outCanvas, w, h, t, true, true);
        batchBlobs.push(await canvasToPngBlob(outCanvas));
      }
      const batchResp = await fetch(`${jobBase}/frames`, {
        method: 'POST',
        body: new Blob(batchBlobs, { type: 'application/octet-stream' }),
      });
      if (!batchResp.ok) {
        const err = (await batchResp.json().catch(() => ({}))) as { hint?: string };
        throw new Error(err.hint || '上传动态帧批次失败。');
      }
    }

    progressText.value = `正在封装 ${fmt} 成片…`;
    const finishResp = await fetch(`${jobBase}/finish?sound=${wavBlob ? '1' : '0'}`, {
      method: 'POST',
      body: wavBlob,
    });
    const expectedMime = fmt === 'MP4' ? 'video/mp4' : 'image/gif';
    if (!finishResp.ok || !finishResp.headers.get('content-type')?.startsWith(expectedMime)) {
      const err = (await finishResp.json().catch(() => ({}))) as { hint?: string };
      throw new Error(err.hint || `${fmt} 编码未完成，请确认本机已安装 FFmpeg。`);
    }
    return await finishResp.blob();
  } catch (err) {
    void fetch(jobBase, { method: 'DELETE' }).catch(() => {});
    throw err;
  }
}

async function runExportDownload(): Promise<void> {
  if (exporting.value) return;
  if (selectedModuleIds.value.length === 0) {
    feedbackText.value = '请至少从左侧添加 1 个模块后再导出。';
    return;
  }
  stopRealtimePreview();
  exporting.value = true;
  feedbackText.value = '';
  const fmt = session.exploreCardFormat.value;
  const [w, h] = cardDims.value;
  try {
    const blob = await generateCardMediaBlob(fmt);
    const ext = fmt.toLowerCase();
    triggerDownload(blob, `${cardOptions.filePrefix ?? ''}phonetic_card_${w}x${h}.${ext}`);
    wb.pushToast(`已导出 ${fmt} ${cardOptions.titlePrefix ?? ''}发音卡 (${w}×${h})`, 'success');
  } catch (err) {
    feedbackText.value = err instanceof Error ? err.message : '导出失败，请重试。';
  } finally {
    exporting.value = false;
    progressText.value = '';
  }
}

async function buildEncodedSamplePreview(): Promise<void> {
  if (exporting.value || !isAnimatedFormat.value) return;
  if (selectedModuleIds.value.length === 0) {
    feedbackText.value = '请至少选择 1 个模块。';
    return;
  }
  stopRealtimePreview();
  revokeEncodedPreview();
  exporting.value = true;
  feedbackText.value = '';
  const fmt = session.exploreCardFormat.value;
  try {
    const blob = await generateCardMediaBlob(fmt);
    encodedPreviewUrl.value = URL.createObjectURL(blob);
    encodedPreviewMime.value = fmt === 'MP4' ? 'video/mp4' : 'image/gif';
    encodedPreviewSizeKb.value = Math.max(1, Math.round(blob.size / 1024));
  } catch (err) {
    feedbackText.value = err instanceof Error ? err.message : '生成样片预览失败。';
  } finally {
    exporting.value = false;
    progressText.value = '';
  }
}

// Sync initial context & repaint triggers when opened or modified
watch(isOpen, (open) => {
  if (open) {
    previewBusy.value = true;
    if (cachedContinuumAsset.value?.cells.some((cell) => !cell.tractImage)) cachedContinuumAsset.value = null;
    const spk = wb.project.value.voices[wb.activeVoiceId.value]?.speaker ?? 'JD2';
    void prefetchSpeakerVowelRefs(spk).then(() => {
      if (isOpen.value) scheduleCanvasPaint();
    });
    if (!userCustomizedModules.value) {
      const ctx = session.cardStudioContextSource.value;
      if (ctx && ctx !== 'explore') {
        const nextMods = defaultModulesForContext(ctx);
        layoutTree.value = buildAutoLayoutTree(nextMods, currentAspect.value, 0);
        selectedModuleId.value = nextMods[0] ?? null;
      } else {
        layoutTree.value = adaptTreeToAspect(layoutTree.value, 1, currentAspect.value)
          ?? buildAutoLayoutTree(defaultModulesForContext('explore'), currentAspect.value, 0);
      }
    }
    syncDurationToSource();
    void nextTick(async () => {
      await runCanvasPaint();
      previewBusy.value = false;
    });
  } else {
    stopRealtimePreview();
    revokeEncodedPreview();
  }
});

watch(
  [
    layoutTree,
    () => JSON.stringify(design),
    titleOverride,
    mascotEnabled,
    mascotStickerId,
    mascotUseAnimated,
    () => signature?.formatted.value,
    cardDims,
    () => session.exploreCardFormat.value,
    () => session.exploreMode.value,
    () => session.exploreActiveCaseId.value,
    () => session.exploreWordLabel.value,
    () => session.exploreIpaLabel.value,
    previewTime_s,
    resolvedPlaybackId,
    rangeStart_s,
    duration_s,
    wb.resolvedColorMode,
    wb.paletteId,
    wb.customAccentHex,
    wb.anatomyAppearance,
    wb.surfaceStyle,
    wb.engineStatus,
    panelSnapshots.ipa,
    panelSnapshots.continuum,
    panelSnapshots.mixer,
    panelSnapshots.arranger,
    panelSnapshots.synthesis,
  ],
  () => {
    revokeEncodedPreview();
    if (isOpen.value) scheduleCanvasPaint();
  },
);

watch(
  () => session.exploreActiveCaseId.value,
  () => {
    titleOverride.value = '';
  },
);

onBeforeUnmount(() => {
  unmounted = true;
  stopRealtimePreview();
  revokeEncodedPreview();
  void previewAudioCtx?.close();
  if (paintRafId) cancelAnimationFrame(paintRafId);
  offscreenRenderer?.destroy();
  poseCache.clear();
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="isOpen"
      class="export-modal-mask"
      role="dialog"
      aria-modal="true"
      :aria-label="cardTitle"
      @click.self="closeModal"
    >
      <div class="export-modal-card phonetic-card-studio">
        <!-- Header -->
        <header class="p-head studio-head">
          <div class="head-left">
            <strong>{{ cardTitle }}</strong>
            <span class="mono muted dim-pill">{{ cardDims[0] }} × {{ cardDims[1] }} px</span>
            <span class="muted head-tip">拖拽模块互换/分栏自动重排 · 拖拽模块间隙微调长宽</span>
          </div>
          <div class="head-actions">
            <button type="button" class="btn sm" @click="matchCurrentWorkspaceModules">
              载入当前工作台推荐模块
            </button>
            <ModuleGuideButton module-id="card" size="sm" />
            <button type="button" class="btn sm icon-only" aria-label="关闭" :disabled="exporting" @click="closeModal">
              <IconSvg name="close" :size="14" />
            </button>
          </div>
        </header>

        <!-- 3-Column Studio Body -->
        <div class="studio-body-grid">
          <!-- LEFT: Visual Module Gallery -->
          <CardModuleGallery
            :selected-ids="selectedModuleIds"
            @toggle="toggleModule"
            @apply-preset="applyModulePreset"
            @drag-module-start="onGalleryDragStart"
          />

          <!-- CENTER: Interactive Split-Tree Canvas & Realtime Dynamic Player -->
          <section class="canvas-workspace">
            <div class="stage-toolbar">
              <div class="toolbar-left">
                <button type="button" class="btn xs" :disabled="!selectedModuleIds.length" @click="autoReflowModules">
                  <IconSvg name="grid" :size="12" />
                  <span>智能重排</span>
                </button>
                <button type="button" class="btn xs" :disabled="selectedModuleIds.length < 2" @click="equalizeGridRatios">
                  <span>均分长宽</span>
                </button>
              </div>

              <div v-if="hasTractModule || mascotEnabled" class="toolbar-right">
                <span class="muted" style="font-size: 0.8125rem">内层微移</span>
                <button
                  type="button"
                  class="btn xs"
                  :class="{ active: fineLayer === 'none' }"
                  @click="fineLayer = 'none'"
                >
                  分格布局
                </button>
                <button
                  v-if="hasTractModule"
                  type="button"
                  class="btn xs"
                  :class="{ active: fineLayer === 'a' }"
                  @click="fineLayer = 'a'"
                >
                  {{ session.exploreMode.value === 'compare' ? '声道 A' : '声道' }}
                </button>
                <button
                  v-if="hasTractModule && session.exploreMode.value === 'compare'"
                  type="button"
                  class="btn xs"
                  :class="{ active: fineLayer === 'b' }"
                  @click="fineLayer = 'b'"
                >
                  声道 B
                </button>
                <button
                  v-if="stickers && mascotEnabled"
                  type="button"
                  class="btn xs"
                  :class="{ active: fineLayer === 'mascot' }"
                  @click="fineLayer = 'mascot'"
                >
                  {{ stickers.name }}
                </button>
                <button
                  v-if="fineLayer !== 'none'"
                  type="button"
                  class="btn xs"
                  @click="resetFineLayer"
                >
                  复位
                </button>
              </div>
            </div>

            <!-- Main Stage Viewport -->
            <div
              class="stage-viewport"
              @dragover="onStageDragOver"
              @drop="onStageDrop"
            >
              <!-- Real Encoded Sample Preview Mode -->
              <div v-if="encodedPreviewUrl" class="encoded-sample-wrap">
                <div class="encoded-banner">
                  <span>实机编码成片预览 · {{ encodedPreviewSizeKb }} KB</span>
                  <button type="button" class="btn xs" @click="revokeEncodedPreview">返回交互画布</button>
                </div>
                <video
                  v-if="encodedPreviewMime === 'video/mp4'"
                  :src="encodedPreviewUrl"
                  controls
                  autoplay
                  loop
                  class="encoded-media"
                />
                <img v-else :src="encodedPreviewUrl" alt="GIF 动态预览" class="encoded-media" />
              </div>

              <!-- Live Interactive Canvas + Split-Tree Overlay -->
              <div
                v-else
                class="canvas-frame"
                :style="{ aspectRatio: `${cardDims[0]} / ${cardDims[1]}` }"
              >
                <canvas
                  ref="previewCanvas"
                  class="live-card-canvas"
                  :class="{ 'fine-pan-cursor': fineLayer !== 'none' }"
                  @pointerdown="startFinePan"
                />

                <!-- Interactive Slot Handles & Resizable Gutters Overlay -->
                <div
                  v-if="renderedGeometry && fineLayer === 'none'"
                  class="interactive-overlay"
                >
                  <!-- Module Slot Drag Handles & Remove Buttons -->
                  <div
                    v-for="mb in renderedGeometry.moduleBoxes"
                    :key="mb.leafId"
                    class="slot-box"
                    :class="{
                      'is-dragging': mb.moduleId !== null && draggingModuleId === mb.moduleId,
                      'is-selected': selectedCellInfo?.cell.leafId === mb.leafId,
                      'is-tract-zoomable': mb.moduleId === 'tract-profile',
                      'is-empty-slot': mb.moduleId === null,
                    }"
                    :style="pctStyle(mb)"
                    :title="
                      mb.moduleId === 'tract-profile'
                        ? '点击选中 · 滚轮缩放声道 · 拖拽平移构图 · 双击复位'
                        : mb.moduleId
                          ? '点击选中并在右侧调整小图占比与细节'
                          : '点击选中空槽位并在右侧或左侧填入模块'
                    "
                    @pointerdown="onSlotBodyPointerDown(mb, $event)"
                    @wheel="onSlotWheel(mb, $event)"
                    @dblclick="mb.moduleId === 'tract-profile' && resetTractFraming()"
                  >
                    <div
                      v-if="mb.moduleId"
                      class="slot-grip-bar"
                      title="按住拖拽至其他槽位互换位置或吸附分栏"
                      @pointerdown.stop="startSlotPointerDrag(mb, $event)"
                    >
                      <span class="grip-dots" aria-hidden="true">⋮⋮</span>
                      <span class="slot-grip-name">{{ CARD_MODULE_MAP.get(mb.moduleId)?.shortTitle }}</span>
                      <button
                        type="button"
                        class="slot-remove-btn"
                        title="从卡片移除该模块"
                        aria-label="移除模块"
                        @pointerdown.stop
                        @click.stop="toggleModule(mb.moduleId)"
                      >
                        <IconSvg name="close" :size="10" />
                      </button>
                    </div>
                    <div v-else class="slot-empty-pill">
                      第{{ mb.rowIndex + 1 }}行·第{{ mb.colIndex + 1 }}列
                    </div>
                  </div>

                  <!-- Resizable Horizontal & Vertical Split Gutters -->
                  <div
                    v-for="g in renderedGeometry.gutters"
                    :key="g.id"
                    class="card-gutter"
                    :class="[g.dir === 'row' ? 'is-col-resize' : 'is-row-resize', { active: activeGutterId === g.id }]"
                    :style="pctStyle(g)"
                    :title="g.dir === 'row' ? '左右拖拽微调相邻卡片宽度（双击均分）' : '上下拖拽微调相邻卡片高度（双击均分）'"
                    @pointerdown="startGutterDrag(g, $event)"
                    @dblclick.stop="equalizeGridRatios"
                  >
                    <i class="gutter-pill" />
                  </div>

                  <!-- Snap-to-Slot Highlight Indicator -->
                  <div
                    v-if="dropPreviewRectStyle"
                    class="snap-zone-indicator"
                    :style="dropPreviewRectStyle"
                  >
                    <span>{{ dropZoneLabel }}</span>
                  </div>
                </div>

                <div v-if="previewBusy" class="stage-busy-mask" role="status">正在渲染卡面…</div>
              </div>
            </div>

            <!-- Dynamic Timeline Preview & Duration Trimmer (Visible when MP4 / GIF or playing) -->
            <div class="dynamic-bar">
              <div class="dyn-top-row">
                <button
                  type="button"
                  class="btn sm"
                  :class="{ primary: isAnimatedFormat }"
                  :disabled="exporting || selectedModuleIds.length === 0"
                  @click="toggleRealtimePreview"
                >
                  <IconSvg :name="isPlayingPreview ? 'pause' : 'play'" :size="12" />
                  <span>{{ isPlayingPreview ? '暂停预览' : '声画同步预览' }}</span>
                </button>

                <input
                  type="range"
                  class="dyn-scrubber"
                  min="0"
                  :max="duration_s"
                  step="0.02"
                  :value="previewTime_s"
                  aria-label="预览时间进度"
                  @input="stopRealtimePreview(); previewTime_s = Number(($event.target as HTMLInputElement).value)"
                />
                <span class="mono muted dyn-clock">{{ previewTime_s.toFixed(2) }}s / {{ duration_s.toFixed(2) }}s</span>

                <label class="dyn-chk">
                  <input v-model="loopPreview" type="checkbox" />
                  <span>循环</span>
                </label>

                <button
                  v-if="isAnimatedFormat"
                  type="button"
                  class="btn xs"
                  :disabled="exporting || selectedModuleIds.length === 0"
                  title="调用本地编码器生成真实 MP4/GIF 样片查看画质与体积"
                  @click="buildEncodedSamplePreview"
                >
                  实机样片预览
                </button>
              </div>

              <div class="dyn-source-row">
                <label class="dyn-inline-field" style="min-width: 205px">
                  <span>动态源</span>
                  <CustomSelect
                    size="xs"
                    style="flex: 1"
                    :model-value="playbackSource"
                    :options="playbackSourceOptions"
                    @update:model-value="(v) => (playbackSource = v as CardPlaybackSourceId)"
                  />
                </label>

                <template v-if="activeSourceMeta?.fixedTimeline">
                  <label class="dyn-inline-field">
                    <span>起点(s)</span>
                    <input
                      v-model.number="rangeStart_s"
                      type="number"
                      class="inp mono xs-num"
                      min="0"
                      :max="Math.max(0, maxTrimEnd_s - 0.3)"
                      step="0.1"
                    />
                  </label>
                </template>

                <label class="dyn-inline-field">
                  <span>持续时长(s)</span>
                  <input
                    v-model.number="duration_s"
                    type="number"
                    class="inp mono xs-num"
                    min="0.6"
                    max="15"
                    step="0.1"
                  />
                </label>

                <div class="dur-presets">
                  <button
                    v-for="sec in [2, 3, 4, 6]"
                    :key="sec"
                    type="button"
                    class="dur-chip mono"
                    :class="{ active: Math.abs(duration_s - sec) < 0.05 }"
                    @click="duration_s = sec"
                  >
                    {{ sec }}s
                  </button>
                  <button
                    v-if="activeSourceMeta?.fixedTimeline"
                    type="button"
                    class="dur-chip"
                    @click="syncDurationToSource"
                  >
                    整段({{ activeSourceMeta.naturalDuration_s }}s)
                  </button>
                </div>
              </div>
            </div>
          </section>

          <!-- RIGHT: Dimensions, Monochrome/Site Design Style, Author Signature & Export -->
          <aside class="inspector-pane">
            <div class="inspector-scroll">
              <!-- 1. Aspect Ratio & Pixel Size -->
              <fieldset>
                <legend>画幅比例与长宽</legend>
                <div class="ratio-grid">
                  <button
                    v-for="rc in ratioChips"
                    :key="rc.id"
                    type="button"
                    class="ratio-btn"
                    :class="{ active: ratioPreset === rc.id }"
                    @click="selectRatioPreset(rc.id)"
                  >
                    {{ rc.label }}
                  </button>
                </div>
                <div class="dim-inputs-row">
                  <label class="dim-box">
                    <span>宽</span>
                    <input
                      :value="cardDims[0]"
                      type="number"
                      class="inp mono"
                      min="360"
                      max="3840"
                      step="10"
                      @change="updateCustomDim('w', Number(($event.target as HTMLInputElement).value))"
                    />
                  </label>
                  <button
                    type="button"
                    class="btn xs icon-only"
                    title="互换横竖宽高"
                    aria-label="互换横竖宽高"
                    @click="swapCardOrientation"
                  >
                    <IconSvg name="refresh" :size="12" />
                  </button>
                  <label class="dim-box">
                    <span>高</span>
                    <input
                      :value="cardDims[1]"
                      type="number"
                      class="inp mono"
                      min="360"
                      max="3840"
                      step="10"
                      @change="updateCustomDim('h', Number(($event.target as HTMLInputElement).value))"
                    />
                  </label>
                </div>
                <small class="muted hint-line">
                  单音探索默认 1:1 方卡，双音对比默认 16:9 横卡；竖卡自动竖向排列。
                </small>
              </fieldset>

              <!-- 1b. Explicit Row x Per-Row Column Grid & Sub-Chart Ratios -->
              <fieldset class="grid-designer">
                <legend>行列网格与小图长宽占比</legend>
                <div class="grid-top-bar">
                  <span class="muted">总行数</span>
                  <div class="seg grid-count-seg" role="radiogroup" aria-label="卡片总行数">
                    <button
                      v-for="rCount in [1, 2, 3, 4, 5]"
                      :key="rCount"
                      type="button"
                      :class="{ active: rowGrid.length === rCount }"
                      @click="onChangeRowCount(rCount)"
                    >
                      {{ rCount }}行
                    </button>
                  </div>
                  <button type="button" class="btn xs" title="恢复所有行列均分占比" @click="equalizeGridRatios">
                    均分
                  </button>
                </div>

                <div class="grid-rows-list">
                  <div v-for="(row, rIdx) in rowGrid" :key="row.rowId" class="grid-row-card">
                    <div class="grid-row-head">
                      <span class="grid-row-title">
                        第 {{ rIdx + 1 }} 行
                        <small v-if="rowGrid.length >= 2" class="mono muted">
                          · 高 {{ Math.round(row.rowRatio * 100) }}%
                        </small>
                      </span>
                      <div class="grid-col-pills" role="radiogroup" :aria-label="`第 ${rIdx + 1} 行列数`">
                        <button
                          v-for="cCount in (row.cells.length > 4 ? [1, 2, 3, 4, row.cells.length] : [1, 2, 3, 4])"
                          :key="cCount"
                          type="button"
                          :class="{ active: row.cells.length === cCount }"
                          @click="onChangeRowCols(rIdx, cCount)"
                        >
                          {{ cCount }}列
                        </button>
                      </div>
                    </div>

                    <div class="grid-cell-chips">
                      <button
                        v-for="(cell, cIdx) in row.cells"
                        :key="cell.leafId"
                        type="button"
                        class="grid-cell-chip"
                        :class="{
                          active: selectedCellInfo?.cell.leafId === cell.leafId,
                          empty: cell.moduleId === null,
                        }"
                        @click="selectGridCell(cell.leafId, cell.moduleId)"
                      >
                        <span class="cell-name">
                          {{ cell.moduleId ? CARD_MODULE_MAP.get(cell.moduleId)?.shortTitle : '空槽位' }}
                        </span>
                        <span v-if="row.cells.length >= 2" class="mono cell-pct">
                          {{ Math.round(cell.colRatio * 100) }}%
                        </span>
                      </button>
                    </div>
                  </div>
                </div>

                <div v-if="selectedCellInfo" class="grid-selected-editor">
                  <div class="sel-head">
                    <strong>
                      第 {{ selectedCellInfo.rowIndex + 1 }} 行 · 第 {{ selectedCellInfo.colIndex + 1 }} 列小图
                    </strong>
                  </div>
                  <label>
                    <span>槽位展示模块</span>
                    <CustomSelect
                      size="xs"
                      :model-value="selectedCellInfo.cell.moduleId ?? ''"
                      :options="slotModuleOptions"
                      @update:model-value="(v) => onAssignSelectedCellModule(String(v))"
                    />
                  </label>
                  <CompactSlider
                    v-if="selectedCellInfo.row.cells.length >= 2"
                    label="该小图列宽占比"
                    :model-value="Math.round(selectedCellInfo.cell.colRatio * 100)"
                    :min="12"
                    :max="88"
                    :step="1"
                    :decimals="0"
                    unit="%"
                    :default-value="Math.round(100 / selectedCellInfo.row.cells.length)"
                    @update:model-value="
                      (v) => onChangeCellWidthPct(selectedCellInfo!.rowIndex, selectedCellInfo!.colIndex, v)
                    "
                  />
                  <CompactSlider
                    v-if="rowGrid.length >= 2"
                    label="所在行高占比"
                    :model-value="Math.round(selectedCellInfo.row.rowRatio * 100)"
                    :min="12"
                    :max="88"
                    :step="1"
                    :decimals="0"
                    unit="%"
                    :default-value="Math.round(100 / rowGrid.length)"
                    @update:model-value="(v) => onChangeRowHeightPct(selectedCellInfo!.rowIndex, v)"
                  />
                </div>
              </fieldset>

              <!-- 2. Monochrome Palette & Site Design Style -->
              <fieldset>
                <legend>配色与设计风格</legend>
                <label>
                  <span>卡片配色</span>
                  <CustomSelect
                    size="sm"
                    :model-value="design.colorPreset"
                    :options="CARD_COLOR_OPTIONS"
                    @update:model-value="(v) => (design.colorPreset = v as CardColorPresetId)"
                  />
                </label>
                <label>
                  <span>卡片设计风格（可独立覆盖）</span>
                  <CustomSelect
                    size="sm"
                    :model-value="design.skinChoice"
                    :options="CARD_SKIN_OPTIONS"
                    @update:model-value="(v) => (design.skinChoice = v as CardSkinChoice)"
                  />
                </label>
                <div class="two-cols">
                  <label>
                    <span>正文字体</span>
                    <CustomSelect
                      size="sm"
                      :model-value="design.font"
                      :options="fontOptions"
                      @update:model-value="(v) => (design.font = v as CardFontId)"
                    />
                  </label>
                  <label class="inline-chk" style="align-self: end; padding-bottom: 6px">
                    <input v-model="design.showHeader" type="checkbox" />
                    <span>显示顶部标题栏</span>
                  </label>
                </div>
                <label v-if="design.showHeader">
                  <span>卡片主标题</span>
                  <input
                    v-model="titleOverride"
                    class="inp"
                    maxlength="84"
                    placeholder="默认留空不显示，输入后展示主标题栏"
                  />
                </label>
                <CompactSlider
                  v-if="design.showHeader"
                  label="标题字号比例"
                  :model-value="Math.round(design.titleScale * 100)"
                  :min="72"
                  :max="150"
                  :step="2"
                  :decimals="0"
                  unit="%"
                  :default-value="100"
                  @update:model-value="(v) => (design.titleScale = Number((v / 100).toFixed(2)))"
                />
                <CompactSlider
                  label="模块内文字比例"
                  :model-value="Math.round(design.textScale * 100)"
                  :min="68"
                  :max="148"
                  :step="2"
                  :decimals="0"
                  unit="%"
                  :default-value="100"
                  @update:model-value="(v) => (design.textScale = Number((v / 100).toFixed(2)))"
                />
              </fieldset>

              <!-- 3. Vocal Tract Module Specific Controls -->
              <fieldset v-if="hasTractModule" :class="{ 'focused-sec': selectedModuleId === 'tract-profile' }">
                <legend>声道剖面细节</legend>
                <label>
                  <span>几何视图</span>
                  <CustomSelect
                    size="sm"
                    :model-value="design.tractView"
                    :options="tractViewOptions"
                    @update:model-value="(v) => (design.tractView = v as 'sagittal' | 'model')"
                  />
                </label>
                <CompactSlider
                  label="声道构图缩放"
                  :model-value="Math.round(design.tractZoom * 100)"
                  :min="50"
                  :max="320"
                  :step="4"
                  :decimals="0"
                  unit="%"
                  :default-value="100"
                  @update:model-value="(v) => (design.tractZoom = Number((v / 100).toFixed(2)))"
                />
                <label class="inline-chk">
                  <input v-model="design.showFullHead" type="checkbox" />
                  <span>显示完整头部外廓（取消则聚焦口腔与声带）</span>
                </label>
                <label class="inline-chk">
                  <input v-model="design.showOrientationCompass" type="checkbox" />
                  <span>显示解剖方位标（上/下/后—前）</span>
                </label>
                <small class="muted hint-line">鼠标点击声道卡片后可直接滚轮缩放、拖拽微移、双击复位。</small>
              </fieldset>

              <!-- 3b. Speech Synthesis Timeline Secondary Track Selection -->
              <fieldset v-if="hasSynthModule" :class="{ 'focused-sec': selectedModuleId === 'synth-timeline' }">
                <legend>语音合成轨道勾选</legend>
                <div class="two-cols">
                  <label class="inline-chk">
                    <input v-model="design.synthTracks.syllables" type="checkbox" />
                    <span>词条音节行</span>
                  </label>
                  <label class="inline-chk">
                    <input v-model="design.synthTracks.phones" type="checkbox" />
                    <span>IPA 音素行</span>
                  </label>
                  <label class="inline-chk">
                    <input v-model="design.synthTracks.phonation" type="checkbox" />
                    <span>发声类型 VoQS</span>
                  </label>
                  <label class="inline-chk">
                    <input v-model="design.synthTracks.f0" type="checkbox" />
                    <span>基频曲线 F0</span>
                  </label>
                  <label class="inline-chk">
                    <input v-model="design.synthTracks.pressure" type="checkbox" />
                    <span>声门下压 Pa</span>
                  </label>
                  <label class="inline-chk">
                    <input v-model="design.synthTracks.waveform" type="checkbox" />
                    <span>合成语音波形</span>
                  </label>
                </div>
              </fieldset>

              <!-- 3c. Sub-Pane Internal Orientation & Secondary Module Options -->
              <fieldset
                v-if="hasCrossLipModule || hasGlottisModule || hasReconModule || hasVowelModule || hasContinuumModule"
                :class="{
                  'focused-sec':
                    selectedModuleId === 'cross-lip' ||
                    selectedModuleId === 'continuum-grid' ||
                    selectedModuleId === 'glottis-model' ||
                    selectedModuleId === 'm27-reconstruct' ||
                    selectedModuleId === 'vowel-space',
                }"
              >
                <legend>子模块内部排列与选项</legend>

                <div v-if="hasContinuumModule" class="sub-dir-field">
                  <span>声道连续统内部排列 · {{ continuumCellCount }} 格</span>
                  <div class="seg sub-dir-seg" role="group" aria-label="声道连续统内部排列">
                    <button
                      v-for="opt in continuumLayoutOptions"
                      :key="opt.id"
                      type="button"
                      :class="{ active: (design.continuumGridLayout?.axis ?? 'auto') === opt.id }"
                      :aria-pressed="(design.continuumGridLayout?.axis ?? 'auto') === opt.id"
                      @click="setContinuumLayout(opt.id)"
                    >{{ opt.label }}</button>
                  </div>
                  <label v-if="design.continuumGridLayout" class="continuum-dimension">
                    <span>{{ design.continuumGridLayout.axis === 'rows' ? '行数' : '列数' }}</span>
                    <input type="number" class="inp mono" min="1" :max="continuumCellCount" step="1" required
                      :value="continuumLayoutCount" @change="setContinuumLayoutCount" />
                  </label>
                </div>

                <div v-if="hasCrossLipModule" class="sub-dir-field">
                  <span>截面与唇形小窗内部排列</span>
                  <div class="seg sub-dir-seg" role="radiogroup" aria-label="截面与唇形小窗内部排列">
                    <button
                      v-for="opt in subPaneDirOptions"
                      :key="opt.id"
                      type="button"
                      :class="{ active: design.crossLipDirection === opt.id }"
                      @click="design.crossLipDirection = opt.id"
                    >
                      {{ opt.label }}
                    </button>
                  </div>
                </div>

                <div
                  v-if="hasGlottisModule || (hasReconModule && design.showReconGlottis)"
                  class="sub-dir-field"
                >
                  <span>声门与声带小窗内部排列</span>
                  <div class="seg sub-dir-seg" role="radiogroup" aria-label="声门与声带小窗内部排列">
                    <button
                      v-for="opt in subPaneDirOptions"
                      :key="opt.id"
                      type="button"
                      :class="{ active: design.glottisDirection === opt.id }"
                      @click="design.glottisDirection = opt.id"
                    >
                      {{ opt.label }}
                    </button>
                  </div>
                </div>

                <label v-if="hasReconModule" class="inline-chk">
                  <input v-model="design.showReconGlottis" type="checkbox" />
                  <span>声道动态重建包含声门与声带模型</span>
                </label>
                <label v-if="hasVowelModule" class="inline-chk">
                  <input v-model="design.showVowelReferenceCloud" type="checkbox" />
                  <span>声学元音图叠加全元音半透明底层参考点</span>
                </label>
              </fieldset>

              <!-- 4. Author Credit & Persistent Nickname -->
              <fieldset>
                <legend>{{ signature ? signature.heading + (stickers ? '与贴纸' : '') : '导出注脚' }}</legend>
                <label v-if="signature" class="inline-chk">
                  <input v-model="signature.enabled.value" type="checkbox" />
                  <span>启用作者署名（自动记住昵称）</span>
                </label>
                <label v-if="signature?.enabled.value">
                  <span>作者昵称（印制格式：{{ signature.prefix }}昵称）</span>
                  <div class="card-nick-group">
                    <span class="nick-prefix mono">{{ signature.prefix }}</span>
                    <input
                      v-model="signature.nickname.value"
                      type="text"
                      class="inp"
                      maxlength="48"
                      placeholder="填写一次自动保存，留空不显示"
                    />
                  </div>
                </label>
                <label class="inline-chk">
                  <input v-model="design.showTechFootnote" type="checkbox" />
                  <span>保留左下角引擎参数注脚</span>
                </label>
                <label v-if="stickers" class="inline-chk">
                  <input
                    v-model="mascotEnabled"
                    type="checkbox"
                    @change="!mascotEnabled && fineLayer === 'mascot' && (fineLayer = 'none')"
                  />
                  <span>添加{{ stickers.name }}角标贴纸</span>
                </label>
                <div v-if="stickers && mascotEnabled" class="sticker-picker-box">
                  <div v-if="isAnimatedFormat" class="seg sticker-mode-seg" role="radiogroup" aria-label="贴纸动静模式">
                    <button
                      type="button"
                      :class="{ active: mascotUseAnimated }"
                      @click="setMascotMotionMode(true)"
                    >
                      动态 GIF (6)
                    </button>
                    <button
                      type="button"
                      :class="{ active: !mascotUseAnimated }"
                      @click="setMascotMotionMode(false)"
                    >
                      静态贴纸 (9)
                    </button>
                  </div>
                  <div class="sticker-thumb-grid" role="radiogroup" aria-label="选择贴纸形象">
                    <button
                      v-for="st in visibleStickers"
                      :key="st.id"
                      type="button"
                      class="sticker-thumb-btn"
                      :class="{ active: mascotStickerId === st.id }"
                      :title="st.label"
                      @click="mascotStickerId = st.id"
                    >
                      <img :src="st.url" :alt="st.label" loading="lazy" />
                      <span>{{ st.label }}</span>
                    </button>
                  </div>
                  <CompactSlider
                    :label="`${stickers.name}尺寸`"
                    :model-value="Math.round(design.mascotScale * 100)"
                    :min="40"
                    :max="220"
                    :step="5"
                    :decimals="0"
                    unit="%"
                    :default-value="100"
                    @update:model-value="(v) => (design.mascotScale = Number((v / 100).toFixed(2)))"
                  />
                </div>
              </fieldset>
            </div>

            <!-- Unified Export Footer (PNG / MP4 / GIF all inside the studio) -->
            <footer class="export-footer">
              <div class="seg fmt-seg" role="radiogroup" aria-label="导出格式">
                <button
                  v-for="fmt in (['PNG', 'MP4', 'GIF'] as const)"
                  :key="fmt"
                  type="button"
                  :class="{ active: session.exploreCardFormat.value === fmt }"
                  @click="session.exploreCardFormat.value = fmt"
                >
                  {{ fmt === 'PNG' ? 'PNG 静态卡' : fmt === 'MP4' ? 'MP4 视频' : 'GIF 动图' }}
                </button>
              </div>

              <div v-if="session.exploreCardFormat.value === 'MP4'" class="fmt-extra-row">
                <label class="inline-chk">
                  <input v-model="includeAudioInMp4" type="checkbox" />
                  <span>同步导出发声音频</span>
                </label>
                <div class="fps-pills mono">
                  <button type="button" :class="{ active: mp4Fps === 24 }" @click="mp4Fps = 24">24fps</button>
                  <button type="button" :class="{ active: mp4Fps === 30 }" @click="mp4Fps = 30">30fps</button>
                </div>
              </div>

              <div v-else-if="session.exploreCardFormat.value === 'GIF'" class="fmt-extra-row">
                <span class="muted" style="font-size: 0.8125rem">循环动图帧率</span>
                <div class="fps-pills mono">
                  <button type="button" :class="{ active: gifFps === 12 }" @click="gifFps = 12">12fps</button>
                  <button type="button" :class="{ active: gifFps === 15 }" @click="gifFps = 15">15fps</button>
                  <button type="button" :class="{ active: gifFps === 20 }" @click="gifFps = 20">20fps</button>
                </div>
              </div>

              <button
                type="button"
                class="btn primary export-main-btn"
                :disabled="exporting || previewBusy || selectedModuleIds.length === 0"
                @click="runExportDownload"
              >
                <IconSvg name="download" :size="14" />
                <span>
                  {{
                    exporting
                      ? '正在导出…'
                      : session.exploreCardFormat.value === 'PNG' && previewTime_s > 0.001
                        ? `导出 PNG (${cardDims[0]}×${cardDims[1]} · ${previewTime_s.toFixed(2)}s 帧)`
                        : `导出 ${session.exploreCardFormat.value} (${cardDims[0]}×${cardDims[1]})`
                  }}
                </span>
              </button>

              <p v-if="progressText || feedbackText" class="export-status muted" role="status">
                {{ progressText || feedbackText }}
              </p>
            </footer>
          </aside>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.phonetic-card-studio {
  width: 1380px;
  height: 880px;
  max-width: min(1420px, calc((100vw - 24px) / var(--page-scale, 1)));
  max-height: min(900px, calc((100dvh - 24px) / var(--page-scale, 1)));
  background: var(--popover-bg);
  display: flex;
  flex-direction: column;
}

.studio-head {
  height: 42px;
  padding: 0 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex: none;
}

.head-left,
.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.dim-pill {
  font-size: 0.833333rem;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--ctrl-bg);
  border: 1px solid var(--panel-border);
}

.head-tip {
  font-size: 0.8125rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.studio-body-grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 282px minmax(0, 1fr) 318px;
}

/* Center Workspace */
.canvas-workspace {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 8px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--app) 88%, var(--panel));
}

.stage-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.stage-viewport {
  position: relative;
  min-width: 0;
  min-height: 0;
  container-type: size;
  display: grid;
  place-items: center;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  background:
    radial-gradient(circle at 50% 45%, color-mix(in srgb, var(--text) 4%, transparent), transparent 70%),
    color-mix(in srgb, var(--sidebar) 90%, var(--app));
  overflow: hidden;
}

.canvas-frame {
  position: relative;
  width: auto;
  height: auto;
  max-width: calc(100cqw - 20px);
  max-height: calc(100cqh - 20px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.24);
  border-radius: 6px;
  overflow: hidden;
}

.live-card-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.live-card-canvas.fine-pan-cursor {
  cursor: grab;
  touch-action: none;
}
.live-card-canvas.fine-pan-cursor:active {
  cursor: grabbing;
}

.interactive-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.slot-box {
  position: absolute;
  z-index: 2;
  border-radius: 6px;
  pointer-events: auto;
  cursor: pointer;
  transition: outline-color 120ms ease;
}

.slot-box.is-tract-zoomable {
  cursor: grab;
  touch-action: none;
}

.slot-box.is-tract-zoomable:active {
  cursor: grabbing;
}

.slot-box:hover {
  outline: 1.5px dashed color-mix(in srgb, var(--accent) 75%, transparent);
  outline-offset: -1px;
}

.slot-box.is-selected {
  outline: 1.8px solid color-mix(in srgb, var(--accent) 82%, transparent);
  outline-offset: -1.5px;
}

.slot-box.is-dragging {
  opacity: 0.45;
}

.slot-grip-bar {
  pointer-events: auto;
  position: absolute;
  top: 3px;
  left: 50%;
  transform: translateX(-50%);
  max-width: calc(100% - 10px);
  height: 20px;
  padding: 0 4px 0 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  border: 1px solid var(--panel-border);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.75rem;
  color: var(--text);
  cursor: grab;
  opacity: 0;
  transition: opacity 140ms ease;
  touch-action: none;
  white-space: nowrap;
}

.slot-box:hover .slot-grip-bar,
.slot-box.is-selected .slot-grip-bar {
  opacity: 0.96;
}

.slot-empty-pill {
  position: absolute;
  top: 4px;
  right: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 0.7rem;
  color: var(--muted);
  background: color-mix(in srgb, var(--panel) 84%, transparent);
  border: 1px dashed var(--panel-border);
  pointer-events: none;
}

.slot-grip-bar:hover {
  opacity: 1 !important;
  border-color: var(--accent);
}

.slot-grip-bar:active {
  cursor: grabbing;
}

.grip-dots {
  color: var(--muted);
  font-weight: 700;
  letter-spacing: -1px;
}

.slot-grip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 600;
}

.slot-remove-btn {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 0;
  background: transparent;
  color: var(--muted);
  display: grid;
  place-items: center;
  cursor: pointer;
  padding: 0;
}
.slot-remove-btn:hover {
  background: var(--danger, #d93025);
  color: #ffffff;
}

/* Split-Tree Gutters */
.card-gutter {
  position: absolute;
  pointer-events: auto;
  display: grid;
  place-items: center;
  touch-action: none;
  z-index: 4;
}

.card-gutter.is-col-resize {
  cursor: col-resize;
}

.card-gutter.is-row-resize {
  cursor: row-resize;
}

.gutter-pill {
  display: block;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 75%, var(--text));
  opacity: 0;
  transition: opacity 130ms ease, transform 130ms ease;
}

.card-gutter.is-col-resize .gutter-pill {
  width: 3px;
  height: min(34px, 55%);
}

.card-gutter.is-row-resize .gutter-pill {
  height: 3px;
  width: min(34px, 55%);
}

.card-gutter:hover .gutter-pill,
.card-gutter.active .gutter-pill {
  opacity: 0.95;
}

.snap-zone-indicator {
  position: absolute;
  z-index: 6;
  border-radius: 8px;
  border: 2px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  display: grid;
  place-items: center;
  pointer-events: none;
}

.snap-zone-indicator span {
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--accent);
  font-size: 0.8125rem;
  font-weight: 700;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.22);
}

.stage-busy-mask {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--panel) 72%, transparent);
  font-size: 0.916667rem;
}

.encoded-sample-wrap {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px;
}

.encoded-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.85rem;
}

.encoded-media {
  max-width: calc(100cqw - 24px);
  max-height: calc(100cqh - 52px);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.26);
}

/* Dynamic Timeline Bar */
.dynamic-bar {
  padding: 8px 10px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  background: var(--panel);
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.dyn-top-row,
.dyn-source-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dyn-scrubber {
  flex: 1;
  min-width: 110px;
}

.dyn-clock {
  font-size: 0.8125rem;
  white-space: nowrap;
}

.dyn-chk {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.833333rem;
  color: var(--text);
  cursor: pointer;
}

.dyn-inline-field {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.8125rem;
  color: var(--muted);
}

.xs-num {
  width: 62px;
  height: 23px;
  padding: 0 5px;
}

.dur-presets {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.dur-chip {
  height: 22px;
  padding: 0 7px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  color: var(--text);
  font-size: 0.78rem;
  cursor: pointer;
}
.dur-chip:hover,
.dur-chip.active {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--selected);
}

/* Right Inspector */
.inspector-pane {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--panel-border);
  background: var(--panel);
}

.inspector-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 13px;
  scrollbar-width: thin;
}

.inspector-pane fieldset {
  margin: 0 0 13px;
  padding: 0 0 12px;
  border: 0;
  border-bottom: 1px solid var(--panel-border);
  display: grid;
  gap: 8px;
  min-width: 0;
}

.inspector-pane fieldset:last-child {
  margin: 0;
  border-bottom: 0;
}

.inspector-pane legend {
  padding: 0 0 4px;
  font-size: 0.9375rem;
  font-weight: 700;
  color: var(--text);
}

.inspector-pane label {
  display: grid;
  gap: 4px;
  font-size: 0.833333rem;
  color: var(--muted);
  min-width: 0;
}

.inspector-pane .inline-chk {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
  cursor: pointer;
}

.ratio-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
}

.ratio-btn {
  height: 25px;
  padding: 0 5px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  color: var(--text);
  font-size: 0.8rem;
  cursor: pointer;
  white-space: nowrap;
}
.ratio-btn:hover {
  border-color: var(--accent);
}
.ratio-btn.active {
  background: var(--selected);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

.dim-inputs-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 6px;
}

.dim-box {
  display: flex !important;
  align-items: center;
  gap: 5px;
}

.dim-box input {
  width: 100%;
  min-width: 0;
  height: 26px;
}

.hint-line {
  font-size: 0.78rem;
  line-height: 1.4;
}

.grid-top-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.8125rem;
}

.grid-count-seg {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
}

.grid-rows-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.grid-row-card {
  padding: 6px 7px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 58%, var(--panel));
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.grid-row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.grid-row-title {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text);
}

.grid-col-pills {
  display: inline-flex;
  gap: 3px;
}

.grid-col-pills button {
  height: 20px;
  padding: 0 5px;
  border-radius: 4px;
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  color: var(--muted);
  font-size: 0.74rem;
  cursor: pointer;
}

.grid-col-pills button.active {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--selected);
  font-weight: 600;
}

.grid-cell-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.grid-cell-chip {
  flex: 1 1 0;
  min-width: 58px;
  height: 23px;
  padding: 0 6px;
  border-radius: 5px;
  border: 1px solid var(--panel-border);
  background: var(--panel);
  color: var(--text);
  font-size: 0.76rem;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  cursor: pointer;
}

.grid-cell-chip.empty {
  border-style: dashed;
  color: var(--muted);
}

.grid-cell-chip.active {
  border-color: var(--accent);
  background: var(--selected);
  color: var(--accent);
  font-weight: 600;
}

.cell-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-pct {
  font-size: 0.7rem;
  opacity: 0.82;
  flex: none;
}

.grid-selected-editor {
  padding: 7px 8px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--panel-border));
  background: color-mix(in srgb, var(--selected) 36%, var(--panel));
  display: grid;
  gap: 6px;
}

.sel-head {
  font-size: 0.8rem;
  color: var(--accent);
}

.sub-dir-field {
  display: grid;
  gap: 4px;
  font-size: 0.833333rem;
  color: var(--muted);
}

.sub-dir-seg {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.continuum-dimension {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.continuum-dimension input { width: 6em; }

.two-cols {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.card-nick-group {
  display: flex;
  align-items: center;
  border: 1px solid var(--panel-border);
  border-radius: var(--r-ctrl);
  background: var(--ctrl-bg);
  overflow: hidden;
}

.nick-prefix {
  padding: 0 7px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  background: color-mix(in srgb, var(--sidebar) 80%, transparent);
  border-right: 1px solid var(--panel-border);
  color: var(--text);
  font-size: 0.8125rem;
  font-weight: 600;
  flex: none;
}

.card-nick-group .inp {
  border: 0 !important;
  box-shadow: none !important;
  background: transparent !important;
  flex: 1;
  min-width: 0;
}

.sticker-picker-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 2px;
}

.sticker-mode-seg {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
}

.sticker-thumb-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.sticker-thumb-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 5px 4px;
  border-radius: 7px;
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  color: var(--muted);
  cursor: pointer;
  transition: border-color 0.14s ease, background 0.14s ease, color 0.14s ease;
}

.sticker-thumb-btn img {
  width: 44px;
  height: 44px;
  object-fit: contain;
  border-radius: 5px;
  background: color-mix(in srgb, var(--panel) 65%, transparent);
}

.sticker-thumb-btn span {
  font-size: 0.72rem;
  line-height: 1.15;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.sticker-thumb-btn.active {
  border-color: var(--accent);
  background: var(--selected);
  color: var(--accent);
  font-weight: 600;
}

/* Export Footer */
.export-footer {
  padding: 10px 13px;
  border-top: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--sidebar) 52%, transparent);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fmt-seg {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
}

.fmt-extra-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.fps-pills {
  display: inline-flex;
  gap: 4px;
}

.fps-pills button {
  height: 21px;
  padding: 0 6px;
  border-radius: 4px;
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  color: var(--muted);
  font-size: 0.76rem;
  cursor: pointer;
}
.fps-pills button.active {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--selected);
  font-weight: 600;
}

.export-main-btn {
  width: 100%;
  height: 32px;
  justify-content: center;
}

.export-status {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.4;
}

@media (max-width: 1020px) {
  .studio-body-grid {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }
  .canvas-workspace {
    min-height: 460px;
  }
}
</style>
