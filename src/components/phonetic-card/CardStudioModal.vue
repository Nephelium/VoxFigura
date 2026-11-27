<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { cardOptions } from '@vocalcut/edition';
import {
  tractRecordToArray19,
  useWorkbenchStore,
  type TractParamName,
  type TractPoseExtras,
} from '@/stores/workbench';
import { useOnboardingStore } from '@/stores/onboarding';
import { panelSnapshots } from '@/data/panel-snapshots';
import { m27Session } from '@/components/research/m27-session';
import { resolveVtlPose, vtlPoseKey } from '@/data/vtl-pose-client';
import type { PtbPoseSnapshot } from '@/components/research/ptb-physics-charts';
import CompactSlider from '@/components/common/CompactSlider.vue';
import CustomSelect, { type SelectOption } from '@/components/common/CustomSelect.vue';
import IconSvg from '@/components/common/IconSvg.vue';
import SplitPane from '@/components/common/SplitPane.vue';
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
import CardLayoutTreeMap from './card/CardLayoutTreeMap.vue';
import {
  CARD_MODULES,
  CARD_MODULE_MAP,
  adaptTreeToAspect,
  assignModuleToLeaf,
  buildAutoLayoutTree,
  cloneLayoutTree,
  detectDropZone,
  dockModuleOntoLeaf,
  equalizeLayoutTreeRatios,
  extractRowGrid,
  findLeafSplitContext,
  hasAnyEmptyLeaf,
  insertModuleIntoTree,
  isNestedLayoutTree,
  listTreeModules,
  removeLeafFromTree,
  removeModuleFromTree,
  resizeSplitAtGutter,
  setGridRowColCount,
  setGridRowCount,
  setSplitChildRatio,
  splitLeafInTree,
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
  resolveCardTheme,
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
  hasAnyRealExperimentData,
  listAvailablePlaybackSources,
  resolveAutoPlaybackSource,
  resolvePlaybackAudioBuffer,
  type CardPlaybackSourceId,
} from './card/playback-sources';
import { selectWorkbenchNav, WORKBENCH_NAV_ITEMS } from '@/data/workbench-nav';
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
const onboarding = useOnboardingStore();
const isOpen = computed(() => session.cardStudioOpen.value || wb.exportModalWorkspace.value === 'explore');
const hasRealExperimentData = computed(() =>
  hasAnyRealExperimentData(wb, session.cardStudioContextSource.value),
);
const isDemoPreviewOnly = computed(() => !hasRealExperimentData.value);
const { signature, stickers } = cardOptions;
const cardTitle = `${cardOptions.titlePrefix ?? ''}发音卡排版与导出工坊`;

const EXPERIMENT_SHORTCUTS: ReadonlyArray<{ id: 'main' | 'ipa' | 'm27'; label: string; desc: string }> = [
  { id: 'main', label: '前往语音合成', desc: '输入词句或音标生成真实 48 kHz 音频与韵律轨' },
  { id: 'ipa', label: '前往国际音标表', desc: '点选音标加载官方实录、语谱图与声道构型' },
  { id: 'm27', label: '前往声道动态重建', desc: '导入或录制语音反演 50 Hz 动态声道轨迹' },
];

function dismissDemoNotice(): void {
  session.cardDemoNoticeOpen.value = false;
}

function reopenDemoNotice(): void {
  session.cardDemoNoticeOpen.value = true;
}

function navigateToExperiment(targetId: 'main' | 'ipa' | 'm27'): void {
  if (exporting.value) return;
  closeModal();
  const navItem = WORKBENCH_NAV_ITEMS.find((item) => item.id === targetId);
  if (navItem) {
    selectWorkbenchNav(wb, navItem);
  }
}

// Resizable studio sidebars
const galleryWidth = ref(294);
const inspectorWidth = ref(346);
type InspectorTabId = 'layout' | 'style' | 'module';
const inspectorTab = ref<InspectorTabId>('layout');

function closeModal(): void {
  if (exporting.value) return;
  stopRealtimePreview();
  revokeEncodedPreview();
  session.closeCardStudio();
  if (wb.exportModalWorkspace.value === 'explore') {
    wb.closeExportModal();
  }
}

// 1. Canvas Dimensions & Aspect Ratio Management
type RatioPreset = 'auto' | '1080x1080' | '1920x1080' | '1440x1080' | '1080x1440' | '1080x1920' | 'custom';
const ratioPreset = ref<RatioPreset>('auto');
const pendingAspectReflow = ref(false);

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
  return forceEven && clamped % 2 !== 0 ? Math.min(3840, clamped + 1) : clamped;
}

const cardDims = computed<[number, number]>(() => {
  const even = session.exploreCardFormat.value === 'MP4';
  return [
    sanitizeDim(session.exploreCardWidth.value, 1080, even),
    sanitizeDim(session.exploreCardHeight.value, 1080, even),
  ];
});

const currentAspect = computed(() => cardDims.value[0] / Math.max(1, cardDims.value[1]));

function aspectBucket(asp: number): 'portrait' | 'square' | 'wide' {
  return asp < 0.85 ? 'portrait' : asp >= 1.25 ? 'wide' : 'square';
}

function handleAspectChange(prevAsp: number, nextAsp: number): void {
  if (aspectBucket(prevAsp) === aspectBucket(nextAsp)) {
    pendingAspectReflow.value = false;
    return;
  }
  if (userCustomizedModules.value) {
    pendingAspectReflow.value = true;
  } else {
    layoutTree.value = adaptTreeToAspect(layoutTree.value, prevAsp, nextAsp);
    pendingAspectReflow.value = false;
  }
}

function applyAspectReflowNow(): void {
  pushHistorySnapshot('适配新画幅重排');
  const mods = listTreeModules(layoutTree.value);
  if (mods.length > 0) {
    layoutTree.value = buildAutoLayoutTree(mods, currentAspect.value, 0);
  }
  pendingAspectReflow.value = false;
}

function selectRatioPreset(preset: RatioPreset): void {
  pushHistorySnapshot('切换画幅比例');
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
  handleAspectChange(prevAsp, nextAsp);
}

function updateCustomDim(axis: 'w' | 'h', rawVal: number): void {
  if (!Number.isFinite(rawVal)) return;
  pushHistorySnapshot('调整自定义画幅');
  const prevAsp = currentAspect.value;
  session.exploreCardAutoRatio.value = false;
  ratioPreset.value = 'custom';
  const clamped = sanitizeDim(rawVal, 1080, session.exploreCardFormat.value === 'MP4');
  if (axis === 'w') session.exploreCardWidth.value = clamped;
  else session.exploreCardHeight.value = clamped;
  const nextAsp = session.exploreCardWidth.value / Math.max(1, session.exploreCardHeight.value);
  handleAspectChange(prevAsp, nextAsp);
}

function swapCardOrientation(): void {
  pushHistorySnapshot('互换画幅宽高');
  const prevAsp = currentAspect.value;
  session.exploreCardAutoRatio.value = false;
  ratioPreset.value = 'custom';
  const [w, h] = [session.exploreCardWidth.value, session.exploreCardHeight.value];
  session.exploreCardWidth.value = h;
  session.exploreCardHeight.value = w;
  const nextAsp = h / Math.max(1, w);
  handleAspectChange(prevAsp, nextAsp);
}

// 2. Split-Tree Module Selection, Nested Structure Awareness & Context Init
function hasSynthesisData(): boolean {
  const syn = panelSnapshots.synthesis.value;
  const clip = syn?.clip ?? wb.project.value.clips[wb.activeClipId.value];
  return Boolean(syn?.audioBuffer || clip?.syllable_order.length);
}

function defaultModulesForContext(ctx: string): CardModuleId[] {
  switch (ctx) {
    case 'main':
      return hasSynthesisData()
        ? ['tract-profile', 'synth-timeline', 'vowel-space', 'transfer-fn']
        : ['tract-profile', 'cross-lip', 'transfer-fn', 'vowel-space'];
    case 'ipa':
      return ['ipa-wave-spec', 'ipa-lexicon'];
    case 'm27':
      return ['tract-profile', 'm27-reconstruct', 'artic-metrics'];
    case 'mixer':
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
const isNestedTree = computed(() => isNestedLayoutTree(layoutTree.value));
const hasEmptySlots = computed(() => hasAnyEmptyLeaf(layoutTree.value));
const hasAnySlots = computed(() => Boolean(layoutTree.value));

const hasTractModule = computed(() => selectedModuleIds.value.includes('tract-profile'));
const hasCrossLipModule = computed(() => selectedModuleIds.value.includes('cross-lip'));
const hasContinuumModule = computed(() => selectedModuleIds.value.includes('continuum-grid'));
const hasGlottisModule = computed(() => selectedModuleIds.value.includes('glottis-model'));
const hasSynthModule = computed(() => selectedModuleIds.value.includes('synth-timeline'));
const hasReconModule = computed(() => selectedModuleIds.value.includes('m27-reconstruct'));
const hasVowelModule = computed(() => selectedModuleIds.value.includes('vowel-space'));
const hasAnyModuleOptions = computed(
  () =>
    hasTractModule.value
    || hasSynthModule.value
    || hasCrossLipModule.value
    || hasGlottisModule.value
    || hasReconModule.value
    || hasVowelModule.value
    || hasContinuumModule.value,
);

function findFirstLeaf(node: CardLayoutNode | null): { leafId: string; moduleId: CardModuleId | null } | null {
  if (!node) return null;
  if (node.kind === 'leaf') return { leafId: node.id, moduleId: node.moduleId };
  for (const ch of node.children) {
    const hit = findFirstLeaf(ch);
    if (hit) return hit;
  }
  return null;
}

const activeLeafContext = computed(() => {
  const tree = layoutTree.value;
  if (!tree) return null;
  if (selectedLeafId.value) {
    const byId = findLeafSplitContext(tree, selectedLeafId.value);
    if (byId) return byId;
  }
  if (selectedModuleId.value) {
    const allCells = rowGrid.value.flatMap((r) => r.cells);
    const byMod = allCells.find((c) => c.moduleId === selectedModuleId.value);
    if (byMod) {
      const ctx = findLeafSplitContext(tree, byMod.leafId);
      if (ctx) return ctx;
    }
  }
  const first = findFirstLeaf(tree);
  return first ? findLeafSplitContext(tree, first.leafId) : null;
});

const activeLeafId = computed(() => activeLeafContext.value?.leafId ?? null);

const slotModuleOptions: SelectOption<string>[] = [
  { value: '', label: '留白空槽（导出时保留留白）' },
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
  pushHistorySnapshot('调整总行数');
  userCustomizedModules.value = true;
  pendingAspectReflow.value = false;
  layoutTree.value = setGridRowCount(layoutTree.value, rows);
}

function onChangeRowCols(rowIndex: number, cols: number): void {
  pushHistorySnapshot('调整行列数');
  userCustomizedModules.value = true;
  pendingAspectReflow.value = false;
  layoutTree.value = setGridRowColCount(layoutTree.value, rowIndex, cols);
}

function onChangeActiveSplitRatio(dir: 'row' | 'col', pct: number): void {
  const ctx = activeLeafContext.value;
  const targetSplit = dir === 'row' ? ctx?.rowSplit : ctx?.colSplit;
  if (!targetSplit) return;
  pushHistoryDebounced('调整分栏占比');
  userCustomizedModules.value = true;
  layoutTree.value = setSplitChildRatio(layoutTree.value, targetSplit.splitId, targetSplit.childIndex, pct / 100);
}

function onSplitActiveLeaf(dir: 'row' | 'col'): void {
  const leafId = activeLeafId.value;
  if (!leafId) return;
  pushHistorySnapshot(dir === 'row' ? '左右拆分槽位' : '上下拆分槽位');
  userCustomizedModules.value = true;
  const res = splitLeafInTree(layoutTree.value, leafId, dir);
  layoutTree.value = res.tree;
  if (res.newLeafId) {
    selectedLeafId.value = res.newLeafId;
    selectedModuleId.value = null;
  }
}

function onRemoveLeafSlot(leafId: string): void {
  pushHistorySnapshot('移除槽位');
  userCustomizedModules.value = true;
  layoutTree.value = removeLeafFromTree(layoutTree.value, leafId);
  if (selectedLeafId.value === leafId) {
    const first = findFirstLeaf(layoutTree.value);
    selectedLeafId.value = first?.leafId ?? null;
    selectedModuleId.value = first?.moduleId ?? null;
  }
}

function onStripAllEmptySlots(): void {
  if (!hasEmptySlots.value) return;
  pushHistorySnapshot('清除全部留白空槽');
  userCustomizedModules.value = true;
  layoutTree.value = stripEmptyLeaves(layoutTree.value);
}

function onAssignSelectedCellModule(rawMod: string): void {
  const leafId = activeLeafId.value;
  if (!leafId) return;
  pushHistorySnapshot('更换槽位模块');
  userCustomizedModules.value = true;
  const nextMod = rawMod ? (rawMod as CardModuleId) : null;
  layoutTree.value = assignModuleToLeaf(layoutTree.value, leafId, nextMod);
  selectedModuleId.value = nextMod;
}

function toggleModule(id: CardModuleId): void {
  pushHistorySnapshot('增删模块');
  userCustomizedModules.value = true;
  pendingAspectReflow.value = false;
  if (selectedModuleIds.value.includes(id)) {
    layoutTree.value = removeModuleFromTree(layoutTree.value, id);
    if (selectedModuleId.value === id) {
      const first = findFirstLeaf(layoutTree.value);
      selectedLeafId.value = first?.leafId ?? null;
      selectedModuleId.value = first?.moduleId ?? null;
    }
  } else {
    layoutTree.value = insertModuleIntoTree(layoutTree.value, id, currentAspect.value, activeLeafId.value);
    selectedModuleId.value = id;
    const placed = extractRowGrid(layoutTree.value).flatMap((r) => r.cells).find((c) => c.moduleId === id);
    if (placed) selectedLeafId.value = placed.leafId;
  }
}

function applyModulePreset(ids: CardModuleId[], source?: CardPlaybackSourceId): void {
  pushHistorySnapshot(ids.length ? '应用推荐组合' : '清空画布');
  if (source) playbackSource.value = source;
  userCustomizedModules.value = true;
  pendingAspectReflow.value = false;
  layoutVariant.value = 0;
  layoutTree.value = buildAutoLayoutTree(ids, currentAspect.value, 0);
  const first = findFirstLeaf(layoutTree.value);
  selectedLeafId.value = first?.leafId ?? null;
  selectedModuleId.value = first?.moduleId ?? null;
}

function autoReflowModules(): void {
  pushHistorySnapshot('智能重排');
  pendingAspectReflow.value = false;
  layoutVariant.value = (layoutVariant.value + 1) % 3;
  layoutTree.value = buildAutoLayoutTree(selectedModuleIds.value, currentAspect.value, layoutVariant.value);
  const first = findFirstLeaf(layoutTree.value);
  selectedLeafId.value = first?.leafId ?? null;
  selectedModuleId.value = first?.moduleId ?? null;
}

function equalizeGridRatios(): void {
  pushHistorySnapshot('均分长宽');
  layoutTree.value = equalizeLayoutTreeRatios(layoutTree.value);
}

function matchCurrentWorkspaceModules(): void {
  pushHistorySnapshot('载入当前工作台推荐模块');
  const ws = wb.activeWorkspace.value;
  const ctx = ws === 'explore' ? 'explore' : ws === 'home' ? 'main' : ws === 'research' ? wb.researchTab.value : wb.studioTab.value;
  userCustomizedModules.value = false;
  pendingAspectReflow.value = false;
  layoutVariant.value = 0;
  const nextMods = defaultModulesForContext(ctx);
  layoutTree.value = buildAutoLayoutTree(nextMods, currentAspect.value, 0);
  const first = findFirstLeaf(layoutTree.value);
  selectedLeafId.value = first?.leafId ?? null;
  selectedModuleId.value = first?.moduleId ?? null;
  playbackSource.value = 'auto';
  syncDurationToSource();
}

// 3. Card Design, Header Default-Off Auto-Fill & Mascot Options
const titleOverride = ref('');
const mascotEnabled = ref(false);
const mascotStickerId = ref(stickers?.items[0]?.id ?? '');
const mascotUseAnimated = ref(true);

const gifStickerCount = computed(() => stickers?.items.filter((i) => i.isGif).length ?? 0);
const allStickerCount = computed(() => stickers?.items.length ?? 0);
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
  showHeader: false,
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

const colorPreviewSwatches = computed(() => {
  const th = resolveCardTheme(design.colorPreset, design.skinChoice);
  return [th.cardSurface, th.moduleSurface, th.text, th.primaryInk, th.secondaryInk];
});

function computeSuggestedTitle(): string {
  const src = resolvedPlaybackId.value;
  if (src === 'explore') {
    if (session.exploreMode.value === 'compare') {
      const a = session.exploreWordLabel.value.trim();
      const b = session.exploreCompareLabelB.value.trim();
      return [a, b].filter(Boolean).join(' vs ') || '双音构型对比';
    }
    return session.exploreWordLabel.value.trim() || '单音构型解析';
  }
  if (src === 'synthesis') {
    const syn = panelSnapshots.synthesis.value;
    const clip = syn?.clip ?? wb.project.value.clips[wb.activeClipId.value];
    return clip?.source?.lyrics?.trim() || syn?.lyrics?.trim() || '语音合成与韵律标注';
  }
  if (src === 'ipa') {
    const ipa = cachedIpaAsset.value ?? panelSnapshots.ipa.value;
    return ipa ? `[${ipa.symbol}] ${ipa.nameZh}` : '国际音标物理构型';
  }
  if (src === 'reconstruct') {
    return m27Session.sourceName.value?.trim() || '声道动态重建轨迹';
  }
  if (src === 'continuum') {
    const cont = panelSnapshots.continuum.value ?? cachedContinuumAsset.value;
    return cont ? `${cont.labelA} → ${cont.labelB} 连续统` : '声道连续统过渡';
  }
  if (src === 'mixer') {
    return panelSnapshots.mixer.value?.presetLabel || '发声态时变调制';
  }
  if (src === 'arranger') {
    return panelSnapshots.arranger.value?.partName || '简谱与钢琴卷帘';
  }
  return activeSourceMeta.value?.label || 'VoxFigura 发音卡';
}

function onToggleShowHeader(checked: boolean): void {
  pushHistorySnapshot(checked ? '开启顶部标题栏' : '关闭顶部标题栏');
  design.showHeader = checked;
  if (checked && !titleOverride.value.trim()) {
    titleOverride.value = computeSuggestedTitle();
  }
}

function fillSuggestedTitle(): void {
  pushHistorySnapshot('填入当前词条标题');
  design.showHeader = true;
  titleOverride.value = computeSuggestedTitle();
}

// Keep at least 1 synthesis track checked so UI always matches rendered canvas
const enabledSynthTrackCount = computed(() =>
  Object.values(design.synthTracks).filter(Boolean).length,
);

function toggleSynthTrack(key: keyof CardDesignOptions['synthTracks'], next: boolean): void {
  if (!next && enabledSynthTrackCount.value <= 1 && design.synthTracks[key]) {
    wb.pushToast('语音合成时间轴至少保留 1 条轨道', 'info');
    return;
  }
  pushHistorySnapshot('调整合成展示轨道');
  design.synthTracks[key] = next;
}

// Personal Saved Studio Preset (localStorage)
const SAVED_STYLE_KEY = 'vocalcut.cardStudio.savedPreset.v1';
const hasSavedUserPreset = ref<boolean>(
  typeof localStorage !== 'undefined' && Boolean(localStorage.getItem(SAVED_STYLE_KEY)),
);

function saveUserCardPreset(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const payload = {
      ratioPreset: ratioPreset.value,
      width: session.exploreCardWidth.value,
      height: session.exploreCardHeight.value,
      colorPreset: design.colorPreset,
      skinChoice: design.skinChoice,
      font: design.font,
      showHeader: design.showHeader,
      showTechFootnote: design.showTechFootnote,
      titleScale: design.titleScale,
      textScale: design.textScale,
      tractView: design.tractView,
      showFullHead: design.showFullHead,
      showOrientationCompass: design.showOrientationCompass,
      showVowelReferenceCloud: design.showVowelReferenceCloud,
      modules: selectedModuleIds.value,
    };
    localStorage.setItem(SAVED_STYLE_KEY, JSON.stringify(payload));
    hasSavedUserPreset.value = true;
    wb.pushToast('已保存当前排版与风格为常用预设', 'success');
  } catch {
    wb.pushToast('无法保存预设到本地存储', 'warning');
  }
}

function loadUserCardPreset(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(SAVED_STYLE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Record<string, unknown>;
    pushHistorySnapshot('载入我的常用预设');
    if (typeof saved.width === 'number' && typeof saved.height === 'number') {
      session.exploreCardWidth.value = sanitizeDim(saved.width, 1080, false);
      session.exploreCardHeight.value = sanitizeDim(saved.height, 1080, false);
    }
    if (typeof saved.ratioPreset === 'string') {
      ratioPreset.value = saved.ratioPreset as RatioPreset;
      session.exploreCardAutoRatio.value = saved.ratioPreset === 'auto';
    }
    if (typeof saved.colorPreset === 'string') design.colorPreset = saved.colorPreset as CardColorPresetId;
    if (typeof saved.skinChoice === 'string') design.skinChoice = saved.skinChoice as CardSkinChoice;
    if (typeof saved.font === 'string') design.font = saved.font as CardFontId;
    if (typeof saved.showHeader === 'boolean') {
      design.showHeader = saved.showHeader;
      if (saved.showHeader && !titleOverride.value.trim()) {
        titleOverride.value = computeSuggestedTitle();
      }
    }
    if (typeof saved.showTechFootnote === 'boolean') design.showTechFootnote = saved.showTechFootnote;
    if (typeof saved.titleScale === 'number') design.titleScale = saved.titleScale;
    if (typeof saved.textScale === 'number') design.textScale = saved.textScale;
    if (saved.tractView === 'sagittal' || saved.tractView === 'model') design.tractView = saved.tractView;
    if (typeof saved.showFullHead === 'boolean') design.showFullHead = saved.showFullHead;
    if (typeof saved.showOrientationCompass === 'boolean') design.showOrientationCompass = saved.showOrientationCompass;
    if (typeof saved.showVowelReferenceCloud === 'boolean') design.showVowelReferenceCloud = saved.showVowelReferenceCloud;
    if (Array.isArray(saved.modules) && saved.modules.length > 0) {
      const validIds = saved.modules.filter((m): m is CardModuleId => typeof m === 'string' && CARD_MODULE_MAP.has(m as CardModuleId));
      if (validIds.length > 0) {
        userCustomizedModules.value = true;
        layoutTree.value = buildAutoLayoutTree(validIds, currentAspect.value, 0);
      }
    }
    wb.pushToast('已载入常用预设', 'success');
  } catch {
    wb.pushToast('常用预设读取失败', 'warning');
  }
}

// 4. Undo / Redo History Stack inside Card Studio
interface StudioHistorySnapshot {
  label: string;
  layoutTree: CardLayoutNode | null;
  designJson: string;
  titleOverride: string;
  width: number;
  height: number;
  ratioPreset: RatioPreset;
  autoRatio: boolean;
}

const undoStack = shallowRef<StudioHistorySnapshot[]>([]);
const redoStack = shallowRef<StudioHistorySnapshot[]>([]);
let lastDebouncedPushAt = 0;
let lastDebouncedLabel = '';

function captureHistorySnapshot(label: string): StudioHistorySnapshot {
  return {
    label,
    layoutTree: cloneLayoutTree(layoutTree.value),
    designJson: JSON.stringify(design),
    titleOverride: titleOverride.value,
    width: session.exploreCardWidth.value,
    height: session.exploreCardHeight.value,
    ratioPreset: ratioPreset.value,
    autoRatio: session.exploreCardAutoRatio.value,
  };
}

function restoreHistorySnapshot(snap: StudioHistorySnapshot): void {
  layoutTree.value = cloneLayoutTree(snap.layoutTree);
  const parsed = JSON.parse(snap.designJson) as CardDesignOptions;
  Object.assign(design, parsed);
  titleOverride.value = snap.titleOverride;
  session.exploreCardWidth.value = snap.width;
  session.exploreCardHeight.value = snap.height;
  ratioPreset.value = snap.ratioPreset;
  session.exploreCardAutoRatio.value = snap.autoRatio;
  pendingAspectReflow.value = false;
}

function pushHistorySnapshot(label: string): void {
  const next = [...undoStack.value, captureHistorySnapshot(label)];
  undoStack.value = next.length > 40 ? next.slice(next.length - 40) : next;
  redoStack.value = [];
  lastDebouncedPushAt = 0;
  lastDebouncedLabel = '';
}

function pushHistoryDebounced(label: string): void {
  const now = performance.now();
  if (label === lastDebouncedLabel && now - lastDebouncedPushAt < 500) {
    lastDebouncedPushAt = now;
    return;
  }
  pushHistorySnapshot(label);
  lastDebouncedPushAt = now;
  lastDebouncedLabel = label;
}

function undoStudio(): void {
  if (!undoStack.value.length || exporting.value) return;
  const list = [...undoStack.value];
  const prev = list.pop()!;
  undoStack.value = list;
  redoStack.value = [...redoStack.value, captureHistorySnapshot(prev.label)];
  restoreHistorySnapshot(prev);
}

function redoStudio(): void {
  if (!redoStack.value.length || exporting.value) return;
  const list = [...redoStack.value];
  const next = list.pop()!;
  redoStack.value = list;
  undoStack.value = [...undoStack.value, captureHistorySnapshot(next.label)];
  restoreHistorySnapshot(next);
}

// 5. Playback Source, Safe Duration & Range Trimming, Realtime Audio-Visual Sync
const playbackSource = ref<CardPlaybackSourceId>('auto');
const rangeStart_s = ref(0);
const duration_s = ref(2.4);
const mp4Fps = ref<24 | 30>(24);
const gifFps = ref<12 | 15 | 20>(15);
const includeAudioInMp4 = ref(true);

const isAnimatedFormat = computed(() => session.exploreCardFormat.value !== 'PNG');
const activeExportFps = computed(() => (session.exploreCardFormat.value === 'MP4' ? mp4Fps.value : gifFps.value));

// Guarantee totalFrames <= 450 so exported video duration always matches audio duration 1:1
const maxAllowedDuration_s = computed(() => {
  if (!isAnimatedFormat.value) return 15;
  return Number(Math.min(15, Math.floor((450 / activeExportFps.value) * 10) / 10).toFixed(1));
});

const safeDuration_s = computed(() => {
  const raw = Number(duration_s.value);
  const maxD = maxAllowedDuration_s.value;
  if (!Number.isFinite(raw)) return Math.min(maxD, 2.4);
  return Number(Math.max(0.6, Math.min(maxD, raw)).toFixed(2));
});

const safeRangeStart_s = computed(() => {
  const raw = Number(rangeStart_s.value);
  const maxStart = Math.max(0, maxTrimEnd_s.value - 0.3);
  if (!Number.isFinite(raw)) return 0;
  return Number(Math.max(0, Math.min(maxStart, raw)).toFixed(2));
});

function commitDuration(raw: string): void {
  const n = Number(raw);
  const maxD = maxAllowedDuration_s.value;
  const clamped = Number.isFinite(n) ? Math.max(0.6, Math.min(maxD, n)) : 2.4;
  duration_s.value = Number(clamped.toFixed(2));
  if (previewTime_s.value > duration_s.value) previewTime_s.value = duration_s.value;
}

function commitRangeStart(raw: string): void {
  const n = Number(raw);
  const maxStart = Math.max(0, maxTrimEnd_s.value - 0.3);
  const clamped = Number.isFinite(n) ? Math.max(0, Math.min(maxStart, n)) : 0;
  rangeStart_s.value = Number(clamped.toFixed(2));
}

watch(maxAllowedDuration_s, (limit) => {
  if (Number(duration_s.value) > limit) {
    duration_s.value = limit;
    if (previewTime_s.value > limit) previewTime_s.value = limit;
  }
});

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
  duration_s.value = Number(Math.min(maxAllowedDuration_s.value, Math.max(0.6, natDur)).toFixed(2));
}

watch(resolvedPlaybackId, () => {
  stopRealtimePreview();
  previewTime_s.value = 0;
  syncDurationToSource();
});

const previewTime_s = ref(0);
const isPlayingPreview = ref(false);
const loopPreview = ref(true);

const scrubberFillPct = computed(() => {
  const max = Math.max(0.01, safeDuration_s.value);
  const pct = Math.max(0, Math.min(100, (previewTime_s.value / max) * 100));
  return `${pct.toFixed(2)}%`;
});

const playBtnLabel = computed(() => {
  if (isPlayingPreview.value) return '暂停预览';
  if (session.exploreCardFormat.value === 'GIF') return '动态预览（无声）';
  if (session.exploreCardFormat.value === 'MP4' && !includeAudioInMp4.value) return '静音动态预览';
  return '声画同步预览';
});

let previewRafId = 0;
let previewAudioCtx: AudioContext | null = null;
let previewAudioNode: AudioBufferSourceNode | null = null;
let previewStartStamp = 0;
let previewStartOffset_s = 0;
let previewPlayToken = 0;

// Cached real assets from IpaPlusView & ContinuumView
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
  pushHistorySnapshot('调整连续统内部排列');
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
        duration_s.value = Number(Math.min(maxAllowedDuration_s.value, Math.max(1, ipaAsset.recordingDuration_s)).toFixed(2));
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

// Encoded real video/GIF preview blob inside modal (reusable for instant save!)
const encodedPreviewUrl = ref('');
const encodedPreviewBlob = shallowRef<Blob | null>(null);
const encodedPreviewFormat = ref<session.ExploreCardFormat | ''>('');
const encodedPreviewMime = ref<'video/mp4' | 'image/gif' | ''>('');
const encodedPreviewSizeKb = ref(0);

function revokeEncodedPreview(): void {
  if (encodedPreviewUrl.value) {
    URL.revokeObjectURL(encodedPreviewUrl.value);
    encodedPreviewUrl.value = '';
    encodedPreviewBlob.value = null;
    encodedPreviewFormat.value = '';
    encodedPreviewMime.value = '';
    encodedPreviewSizeKb.value = 0;
  }
}

function saveEncodedPreviewDirectly(): void {
  const blob = encodedPreviewBlob.value;
  const fmt = encodedPreviewFormat.value;
  if (!blob || !fmt) return;
  const [w, h] = cardDims.value;
  triggerDownload(blob, `${cardOptions.filePrefix ?? ''}phonetic_card_${w}x${h}.${fmt.toLowerCase()}`);
  wb.pushToast(`已保存 ${fmt} ${cardOptions.titlePrefix ?? ''}发音卡 (${w}×${h})`, 'success');
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
  const dur = safeDuration_s.value;
  const safeOffset = offsetSec >= clip.duration - 0.03 ? 0 : Math.max(0, offsetSec);
  const src = ctx.createBufferSource();
  src.buffer = clip;
  src.loop = loop && Math.abs(clip.duration - dur) <= 0.12;
  if (src.loop) {
    src.loopStart = 0;
    src.loopEnd = Math.min(dur, clip.duration);
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
  const dur = safeDuration_s.value;
  const token = ++previewPlayToken;
  isPlayingPreview.value = true;
  feedbackText.value = '';
  if (previewTime_s.value >= dur - 0.05) {
    previewTime_s.value = 0;
  }
  previewStartOffset_s = previewTime_s.value;

  const wantSound = session.exploreCardFormat.value === 'PNG'
    || (session.exploreCardFormat.value === 'MP4' && includeAudioInMp4.value);
  if (wantSound) {
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
        rangeStart_s: safeRangeStart_s.value,
        rangeDuration_s: dur,
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
    const curDur = safeDuration_s.value;
    const elapsed = audioDriven && previewAudioCtx
      ? previewAudioCtx.currentTime - previewStartStamp
      : performance.now() / 1000 - previewStartStamp;
    if (elapsed >= curDur) {
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
        previewTime_s.value = curDur;
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

// 6. Offscreen VTL Geometry & Canvas Rendering Pipeline (Theme & Resolution Aware)
const previewCanvas = ref<HTMLCanvasElement | null>(null);
const renderedGeometry = shallowRef<ComposeCardGeometry | undefined>(undefined);
const previewBusy = ref(false);
const exporting = ref(false);
const exportProgress01 = ref(0);
const progressText = ref('');
const feedbackText = ref('');
let activeExportAbort: AbortController | null = null;

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
  speaker: string,
  surfaceColor: string,
): Promise<OffscreenVtlRenderer | null> {
  if (!wb.engineMeta.value) return null;
  const resolvedW = Math.min(1800, Math.max(460, Math.round(widthPx / 64) * 64));
  const siteThemeSig = `${wb.resolvedColorMode.value}|${wb.paletteId.value}|${wb.anatomyAppearance.value}`;
  const nextKey = `${view}|${showFullHead ? 'head' : 'oral'}|${resolvedW}|${speaker}|${siteThemeSig}`;
  if (offscreenRenderer && offscreenRendererKey === nextKey) return offscreenRenderer;
  offscreenRenderer?.destroy();
  offscreenRenderer = await createOffscreenVtlRenderer(wb.engineMeta.value, {
    width: resolvedW,
    ...(view === 'model' ? { height: Math.round(resolvedW * 0.86) } : {}),
    labels: false,
    focused: !showFullHead,
    oralFocus: false,
    head: showFullHead,
    surfaceColor,
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
  isFinalExport = false,
): Promise<ComposeCardGeometry | undefined> {
  const speaker = wb.project.value.voices[wb.activeVoiceId.value]?.speaker ?? 'JD2';
  const compare = session.exploreMode.value === 'compare' && resolvedPlaybackId.value === 'explore';
  const resolvedCardTheme = resolveCardTheme(design.colorPreset, design.skinChoice);
  const { ipaAsset, continuumAsset } = await ensureRealModuleAssets(speaker);
  const dyn = evaluateDynamicCardState({
    source: resolvedPlaybackId.value,
    localTime_s,
    rangeStart_s: safeRangeStart_s.value,
    rangeDuration_s: safeDuration_s.value,
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
    && (hasCrossLipModule.value || isFinalExport || animated || !stateA || (compare && !stateB) || resolvedPlaybackId.value !== 'explore');
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
    const targetTractW = Math.round(w * (isFinalExport ? 0.72 : 0.65));
    const vtl = stateA
      ? await ensureOffscreenRenderer(
          design.tractView,
          design.showFullHead,
          targetTractW,
          speaker,
          resolvedCardTheme.cardSurface,
        )
      : null;
    if (vtl && stateA) {
      vtlImageA = await vtl.renderState(stateA, { surfaceColor: resolvedCardTheme.cardSurface });
      if (compare && stateB) {
        vtlImageB = await vtl.renderState(stateB, { surfaceColor: resolvedCardTheme.cardSurface });
      }
    }
    if (!vtlImageA && design.tractView === 'sagittal' && !session.exploreUsesSourcePose.value) {
      const pair = samplePair(session.exploreActiveCaseId.value);
      vtlImageA = await rasterReference(pair.a, dyn.clipProgress01, design.showFullHead, resolvedCardTheme.cardSurface);
      if (compare && !vtlImageB) {
        vtlImageB = await rasterReference(pair.b, dyn.clipProgress01, design.showFullHead, resolvedCardTheme.cardSurface);
      }
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

  // Preserve WYSIWYG whitespace on export: keep layoutTree intact and hide empty dashed guides
  return composeCardToCanvas({
    canvas: targetCanvas,
    canvasWidth: w,
    canvasHeight: h,
    layoutTree: layoutTree.value,
    hideEmptyPlaceholders: isFinalExport,
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

// 7. Direct Whole-Card Drag-to-Dock & Split-Tree Gutter Dragging
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
  if (target.zone === 'swap') return target.moduleId ? '松手互换模块槽位' : '松手填入留白空槽';
  if (target.zone === 'left') return '吸附至左侧分栏';
  if (target.zone === 'right') return '吸附至右侧分栏';
  if (target.zone === 'top') return '插入至上方分行';
  return '插入至下方分行';
});

function onSlotBodyPointerDown(mb: CardModuleBox, ev: PointerEvent): void {
  if (ev.button !== 0 || exporting.value) return;
  selectGridCell(mb.leafId, mb.moduleId);
  const moduleId = mb.moduleId;
  if (!moduleId) return;

  ev.preventDefault();
  const startX = ev.clientX;
  const startY = ev.clientY;
  let dragStarted = false;

  const onMove = (moveEv: PointerEvent) => {
    if (!dragStarted) {
      if (Math.hypot(moveEv.clientX - startX, moveEv.clientY - startY) < 5) return;
      dragStarted = true;
      draggingModuleId.value = moduleId;
      hoverDropTarget.value = null;
    }
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
    if (dragStarted && draggingModuleId.value && hoverDropTarget.value) {
      pushHistorySnapshot('拖拽重排模块');
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

// Support dragging a module from left CardModuleGallery onto the canvas (with cancel cleanup)
function onGalleryDragStart(id: CardModuleId): void {
  draggingModuleId.value = id;
}

function onGalleryDragEnd(): void {
  draggingModuleId.value = null;
  hoverDropTarget.value = null;
}

function onStageDragLeave(ev: DragEvent): void {
  const cur = ev.currentTarget as HTMLElement | null;
  const rel = ev.relatedTarget as Node | null;
  if (cur && rel && cur.contains(rel)) return;
  hoverDropTarget.value = null;
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
  pushHistorySnapshot('拖入模块');
  userCustomizedModules.value = true;
  if (target) {
    layoutTree.value = dockModuleOntoLeaf(layoutTree.value, srcId, target.leafId, target.zone);
  } else if (!selectedModuleIds.value.includes(srcId)) {
    layoutTree.value = insertModuleIntoTree(layoutTree.value, srcId, currentAspect.value, activeLeafId.value);
  }
}

// Split-Tree Gutter Dragging
const activeGutterId = ref<string | null>(null);

function startGutterDrag(gutter: CardGutter, ev: PointerEvent): void {
  if (ev.button !== 0 || exporting.value) return;
  ev.preventDefault();
  ev.stopPropagation();
  const canvas = previewCanvas.value;
  if (!canvas) return;
  const startTree = layoutTree.value;
  if (!startTree) return;

  pushHistorySnapshot('拖拽调整分栏尺寸');
  userCustomizedModules.value = true;
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

// Canvas Mode: Layout Drag vs Vocal-Tract Framing Pan vs Mascot Pan (auto-guards against deadlock!)
type FineLayer = 'none' | 'a' | 'b' | 'mascot';
const fineLayer = ref<FineLayer>('none');

watch(
  [hasTractModule, mascotEnabled, () => session.exploreMode.value],
  ([hasTract, hasMascot, mode]) => {
    if ((fineLayer.value === 'a' || fineLayer.value === 'b') && !hasTract) {
      fineLayer.value = 'none';
    } else if (fineLayer.value === 'b' && mode !== 'compare') {
      fineLayer.value = hasTract ? 'a' : 'none';
    } else if (fineLayer.value === 'mascot' && !hasMascot) {
      fineLayer.value = 'none';
    }
  },
);

function resetFineLayer(): void {
  pushHistorySnapshot('复位画布构图偏移');
  design.tractZoom = 1;
  design.offsetA = { x: 0, y: 0 };
  design.offsetB = { x: 0, y: 0 };
  delete design.mascotX;
  delete design.mascotY;
}

function resetTractFraming(): void {
  pushHistorySnapshot('复位声道构图');
  design.tractZoom = 1;
  design.offsetA = { x: 0, y: 0 };
  design.offsetB = { x: 0, y: 0 };
}

function onSlotWheel(mb: CardModuleBox, ev: WheelEvent): void {
  if (mb.moduleId !== 'tract-profile' || exporting.value) return;
  ev.preventDefault();
  selectGridCell(mb.leafId, 'tract-profile');
  const step = ev.deltaY < 0 ? 0.08 : -0.08;
  design.tractZoom = Math.max(0.5, Math.min(3.2, Number((design.tractZoom + step).toFixed(2))));
}

function startFinePan(ev: PointerEvent): void {
  if (fineLayer.value === 'none' || ev.button !== 0 || exporting.value) return;
  const canvas = previewCanvas.value;
  if (!canvas) return;
  ev.preventDefault();
  pushHistoryDebounced('微移构图位置');
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

  const tractBox =
    fineLayer.value === 'b'
      ? renderedGeometry.value?.tractBoxes?.b
      : renderedGeometry.value?.tractBoxes?.a;
  const denomW =
    fineLayer.value === 'mascot' || !tractBox
      ? Math.max(40, rect.width)
      : Math.max(40, (tractBox.w / Math.max(1, previewSize.value[0])) * rect.width);
  const denomH =
    fineLayer.value === 'mascot' || !tractBox
      ? Math.max(40, rect.height)
      : Math.max(40, (tractBox.h / Math.max(1, previewSize.value[1])) * rect.height);

  const onMove = (me: PointerEvent) => {
    const dx = (me.clientX - sx) / denomW;
    const dy = (me.clientY - sy) / denomH;
    if (fineLayer.value === 'mascot') {
      design.mascotX = Math.max(0.05, Math.min(0.95, initX + dx));
      design.mascotY = Math.max(0.05, Math.min(0.95, initY + dy));
    } else {
      const target = fineLayer.value === 'b' ? 'offsetB' : 'offsetA';
      design[target] = {
        x: Math.max(-0.55, Math.min(0.55, initX + dx)),
        y: Math.max(-0.55, Math.min(0.55, initY + dy)),
      };
    }
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

// 8. Full-Resolution Export, Clipboard Copy, Cancellation & Sample Reuse
function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('浏览器无法生成 PNG 帧。'))), 'image/png'),
  );
}

function cancelActiveExport(): void {
  if (!exporting.value || !activeExportAbort) return;
  activeExportAbort.abort();
}

async function generateCardMediaBlob(fmt: session.ExploreCardFormat, signal: AbortSignal): Promise<Blob> {
  const [w, h] = cardDims.value;
  const outCanvas = document.createElement('canvas');
  exportProgress01.value = 0;

  if (fmt === 'PNG') {
    progressText.value = '正在渲染当前帧高清静态发音卡…';
    exportProgress01.value = 0.5;
    await renderCardFrameToCanvas(outCanvas, w, h, previewTime_s.value, previewTime_s.value > 0.001, true);
    if (signal.aborted) throw new DOMException('已取消导出', 'AbortError');
    exportProgress01.value = 1;
    return await canvasToPngBlob(outCanvas);
  }

  const fmtLower = fmt === 'MP4' ? 'mp4' : 'gif';
  const fps = fmt === 'MP4' ? mp4Fps.value : gifFps.value;
  const dur = safeDuration_s.value;
  const totalFrames = Math.max(6, Math.min(450, Math.round(dur * fps)));

  progressText.value = '正在初始化动态卡片编码会话…';
  const initResp = await fetch(`/api/explore/card-job?format=${fmtLower}&fps=${fps}`, {
    method: 'POST',
    signal,
  });
  if (!initResp.ok) {
    const err = (await initResp.json().catch(() => ({}))) as { hint?: string };
    throw new Error(err.hint || '动态编码需要本地服务运行并可用 FFmpeg，请确认服务已启动后重试。');
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
        rangeStart_s: safeRangeStart_s.value,
        rangeDuration_s: dur,
        store: wb,
        ipaAsset,
        continuumAsset,
        signal,
      });
      if (signal.aborted) throw new DOMException('已取消导出', 'AbortError');
      if (audioBuf) {
        wavBlob = encodeAudioBufferToWavBlob(audioBuf);
      }
    }

    const batchSize = 8;
    for (let start = 0; start < totalFrames; start += batchSize) {
      const batchBlobs: Blob[] = [];
      const end = Math.min(totalFrames, start + batchSize);
      for (let i = start; i < end; i++) {
        if (signal.aborted) throw new DOMException('已取消导出', 'AbortError');
        progressText.value = `正在渲染动态画面帧 ${i + 1} / ${totalFrames}…`;
        exportProgress01.value = ((i + 1) / totalFrames) * 0.85;
        const t = (i / totalFrames) * dur;
        await renderCardFrameToCanvas(outCanvas, w, h, t, true, true);
        batchBlobs.push(await canvasToPngBlob(outCanvas));
      }
      const batchResp = await fetch(`${jobBase}/frames`, {
        method: 'POST',
        body: new Blob(batchBlobs, { type: 'application/octet-stream' }),
        signal,
      });
      if (!batchResp.ok) {
        const err = (await batchResp.json().catch(() => ({}))) as { hint?: string };
        throw new Error(err.hint || '上传动态帧批次失败。');
      }
    }

    progressText.value = `正在封装 ${fmt} 成片…`;
    exportProgress01.value = 0.92;
    const finishResp = await fetch(`${jobBase}/finish?sound=${wavBlob ? '1' : '0'}`, {
      method: 'POST',
      body: wavBlob,
      signal,
    });
    const expectedMime = fmt === 'MP4' ? 'video/mp4' : 'image/gif';
    if (!finishResp.ok || !finishResp.headers.get('content-type')?.startsWith(expectedMime)) {
      const err = (await finishResp.json().catch(() => ({}))) as { hint?: string };
      throw new Error(err.hint || `${fmt} 编码未完成，请确认本机已安装 FFmpeg。`);
    }
    exportProgress01.value = 1;
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
  const fmt = session.exploreCardFormat.value;
  // Reuse already encoded preview blob if matching format & unmodified
  if (encodedPreviewBlob.value && encodedPreviewFormat.value === fmt) {
    saveEncodedPreviewDirectly();
    return;
  }

  stopRealtimePreview();
  exporting.value = true;
  exportProgress01.value = 0;
  feedbackText.value = '';
  const controller = new AbortController();
  activeExportAbort = controller;
  const [w, h] = cardDims.value;
  try {
    const blob = await generateCardMediaBlob(fmt, controller.signal);
    const ext = fmt.toLowerCase();
    triggerDownload(blob, `${cardOptions.filePrefix ?? ''}phonetic_card_${w}x${h}.${ext}`);
    wb.pushToast(`已导出 ${fmt} ${cardOptions.titlePrefix ?? ''}发音卡 (${w}×${h})`, 'success');
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      feedbackText.value = '已取消本次导出。';
    } else {
      feedbackText.value = err instanceof Error ? err.message : '导出失败，请重试。';
    }
  } finally {
    activeExportAbort = null;
    exporting.value = false;
    exportProgress01.value = 0;
    progressText.value = '';
  }
}

async function copyPngToClipboard(): Promise<void> {
  if (exporting.value) return;
  if (selectedModuleIds.value.length === 0) {
    feedbackText.value = '请至少从左侧添加 1 个模块后再复制。';
    return;
  }
  if (typeof navigator === 'undefined' || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    feedbackText.value = '当前浏览器环境不支持直接复制图片，请点击导出 PNG。';
    return;
  }
  stopRealtimePreview();
  exporting.value = true;
  exportProgress01.value = 0;
  feedbackText.value = '';
  const controller = new AbortController();
  activeExportAbort = controller;
  try {
    const blob = await generateCardMediaBlob('PNG', controller.signal);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    wb.pushToast(`已复制高清 PNG (${cardDims.value[0]}×${cardDims.value[1]}) 到剪贴板`, 'success');
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      feedbackText.value = err instanceof Error ? `复制失败：${err.message}` : '复制图片失败，请尝试导出 PNG。';
    }
  } finally {
    activeExportAbort = null;
    exporting.value = false;
    exportProgress01.value = 0;
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
  exportProgress01.value = 0;
  feedbackText.value = '';
  const controller = new AbortController();
  activeExportAbort = controller;
  const fmt = session.exploreCardFormat.value;
  try {
    const blob = await generateCardMediaBlob(fmt, controller.signal);
    encodedPreviewBlob.value = blob;
    encodedPreviewFormat.value = fmt;
    encodedPreviewUrl.value = URL.createObjectURL(blob);
    encodedPreviewMime.value = fmt === 'MP4' ? 'video/mp4' : 'image/gif';
    encodedPreviewSizeKb.value = Math.max(1, Math.round(blob.size / 1024));
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      feedbackText.value = '已取消样片编码。';
    } else {
      feedbackText.value = err instanceof Error ? err.message : '生成样片预览失败。';
    }
  } finally {
    activeExportAbort = null;
    exporting.value = false;
    exportProgress01.value = 0;
    progressText.value = '';
  }
}

// 9. Keyboard & Global Modal Coordination
function isTextInputEl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['range', 'checkbox', 'radio', 'button'].includes(type);
  }
  return false;
}

function onModalKeyDown(ev: KeyboardEvent): void {
  if (!isOpen.value || wb.activeModuleGuide.value || onboarding.isActive.value || session.cardDemoNoticeOpen.value) return;
  const mod = ev.ctrlKey || ev.metaKey;
  const key = ev.key.toLowerCase();
  if (mod && !ev.altKey && !isTextInputEl(ev.target)) {
    if (key === 'z' && !ev.shiftKey) {
      ev.preventDefault();
      undoStudio();
      return;
    }
    if ((key === 'z' && ev.shiftKey) || key === 'y') {
      ev.preventDefault();
      redoStudio();
      return;
    }
  }
  if (!mod && !ev.altKey && ev.code === 'Space' && !isTextInputEl(ev.target) && !(ev.target instanceof HTMLButtonElement)) {
    ev.preventDefault();
    void toggleRealtimePreview();
  }
}

function onCardTourAction(ev: Event): void {
  const detail = (ev as CustomEvent<{
    actionId?: string;
    pageId?: string;
    done?: (ok?: boolean) => void;
  }>).detail;
  if (!detail || detail.pageId !== 'card' || !isOpen.value) return;

  if (detail.actionId === 'card-demo-split-col') {
    inspectorTab.value = 'layout';
    if (!activeLeafContext.value && layoutTree.value) {
      const first = findFirstLeaf(layoutTree.value);
      if (first) selectGridCell(first.leafId, first.moduleId);
    }
    if (activeLeafContext.value) {
      onSplitActiveLeaf('col');
      wb.pushToast('已对选中槽位执行上下拆格，随时可按 Ctrl+Z 撤销还原。', 'info');
    }
    void nextTick(() => {
      window.dispatchEvent(new Event('resize'));
      detail.done?.(true);
    });
    return;
  }

  if (detail.actionId === 'card-demo-toggle-header') {
    inspectorTab.value = 'style';
    const nextState = !design.showHeader;
    onToggleShowHeader(nextState);
    wb.pushToast(
      nextState ? '已勾选顶部标题栏并自动带出当前词条，随时可按 Ctrl+Z 还原。' : '已收起顶部标题栏。',
      'info',
    );
    void nextTick(() => {
      window.dispatchEvent(new Event('resize'));
      detail.done?.(true);
    });
  }
}

watch(
  () => [isOpen.value, onboarding.activePageId.value, onboarding.currentStep.value?.id] as const,
  ([open, pageId, stepId]) => {
    if (!open || pageId !== 'card' || !stepId) return;
    let nextTab: InspectorTabId | null = null;
    if (stepId === 'card-layout-section' || stepId === 'card-tree-designer') nextTab = 'layout';
    else if (stepId === 'card-inspector-style') nextTab = 'style';
    else if (stepId === 'card-inspector-module') nextTab = 'module';
    if (nextTab && inspectorTab.value !== nextTab) {
      inspectorTab.value = nextTab;
      void nextTick(() => {
        window.dispatchEvent(new Event('resize'));
      });
    }
  },
);

function onExternalRequestClose(): void {
  if (session.cardDemoNoticeOpen.value) {
    dismissDemoNotice();
    return;
  }
  if (isOpen.value) closeModal();
}

// Automatically yield when user navigates from ModuleGuideModal into full-screen GuideView overlay
watch(
  () => wb.activeOverlay.value,
  (ov) => {
    if (ov !== 'none' && isOpen.value && !exporting.value) {
      closeModal();
    }
  },
);

onMounted(() => {
  window.addEventListener('vocalcut:request-close-card-studio', onExternalRequestClose);
  window.addEventListener('vocalcut:request-close-export', onExternalRequestClose);
  window.addEventListener('vocalcut:tour-action', onCardTourAction);
  window.addEventListener('keydown', onModalKeyDown);
});

// Sync initial context & repaint triggers when opened or modified
watch(isOpen, (open) => {
  if (open) {
    const suppressNotice = session.consumeSuppressDemoNotice();
    session.cardDemoNoticeOpen.value = !suppressNotice && isDemoPreviewOnly.value;
    previewBusy.value = true;
    pendingAspectReflow.value = false;
    if (cachedContinuumAsset.value?.cells.some((cell) => !cell.tractImage)) cachedContinuumAsset.value = null;
    const spk = wb.project.value.voices[wb.activeVoiceId.value]?.speaker ?? 'JD2';
    void prefetchSpeakerVowelRefs(spk).then(() => {
      if (isOpen.value) scheduleCanvasPaint();
    });
    if (!userCustomizedModules.value) {
      const ctx = session.cardStudioContextSource.value;
      const nextMods = defaultModulesForContext(ctx || 'explore');
      layoutTree.value = buildAutoLayoutTree(nextMods, currentAspect.value, 0);
      const first = findFirstLeaf(layoutTree.value);
      selectedLeafId.value = first?.leafId ?? null;
      selectedModuleId.value = first?.moduleId ?? null;
    }
    syncDurationToSource();
    void nextTick(async () => {
      await runCanvasPaint();
      previewBusy.value = false;
    });
  } else {
    session.cardDemoNoticeOpen.value = false;
    stopRealtimePreview();
    revokeEncodedPreview();
    draggingModuleId.value = null;
    hoverDropTarget.value = null;
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
    safeRangeStart_s,
    safeDuration_s,
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
    panelSnapshots.dialect,
    m27Session.rows,
    m27Session.spectrogramCache,
  ],
  () => {
    revokeEncodedPreview();
    if (isOpen.value) scheduleCanvasPaint();
  },
);

watch(
  () => session.exploreActiveCaseId.value,
  () => {
    if (design.showHeader) {
      titleOverride.value = computeSuggestedTitle();
    } else {
      titleOverride.value = '';
    }
  },
);

onBeforeUnmount(() => {
  unmounted = true;
  activeExportAbort?.abort();
  window.removeEventListener('vocalcut:request-close-card-studio', onExternalRequestClose);
  window.removeEventListener('vocalcut:request-close-export', onExternalRequestClose);
  window.removeEventListener('vocalcut:tour-action', onCardTourAction);
  window.removeEventListener('keydown', onModalKeyDown);
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
        <header class="p-head studio-head" data-tour="card-header">
          <div class="head-left">
            <strong>{{ cardTitle }}</strong>
            <span class="mono muted dim-pill">{{ cardDims[0] }} × {{ cardDims[1] }} px</span>
            <span class="muted head-tip">直接拖拽模块换位或吸附分栏 · 拖动间隙微调长宽 · 导出保留留白空槽</span>
          </div>
          <div class="head-actions">
            <button
              type="button"
              class="btn sm icon-only"
              title="撤销上次排版或样式改动 (Ctrl+Z)"
              aria-label="撤销"
              :disabled="!undoStack.length || exporting"
              @click="undoStudio"
            >
              <IconSvg name="undo" :size="13" />
            </button>
            <button
              type="button"
              class="btn sm icon-only"
              title="重做 (Ctrl+Shift+Z)"
              aria-label="重做"
              :disabled="!redoStack.length || exporting"
              @click="redoStudio"
            >
              <IconSvg name="redo" :size="13" />
            </button>
            <button type="button" class="btn sm" :disabled="exporting" @click="matchCurrentWorkspaceModules">
              载入当前工作台推荐模块
            </button>
            <span data-tour="card-guide-btn">
              <ModuleGuideButton module-id="card" size="sm" />
            </span>
            <button type="button" class="btn sm icon-only" aria-label="关闭" :disabled="exporting" @click="closeModal">
              <IconSvg name="close" :size="14" />
            </button>
          </div>
        </header>

        <!-- 3-Column Resizable Studio Body -->
        <div class="studio-body-flex">
          <!-- LEFT: Visual Module Gallery -->
          <div class="gallery-col" data-tour="card-gallery" :style="{ width: `${galleryWidth}px` }">
            <CardModuleGallery
              :selected-ids="selectedModuleIds"
              :has-any-slots="hasAnySlots"
              @toggle="toggleModule"
              @apply-preset="applyModulePreset"
              @drag-module-start="onGalleryDragStart"
              @drag-module-end="onGalleryDragEnd"
            />
          </div>

          <SplitPane
            v-model="galleryWidth"
            direction="vertical"
            :min="240"
            :max="420"
            :default-value="294"
            title="拖拽调整左侧模块库宽度（双击复位）"
          />

          <!-- CENTER: Interactive Split-Tree Canvas & Adaptive Timeline Player -->
          <section class="canvas-workspace">
            <div v-if="isDemoPreviewOnly" class="demo-preview-banner" role="status">
              <div class="demo-banner-main">
                <IconSvg name="info" :size="14" />
                <span>
                  演示预览态：尚未检测到真实实验数据，画布与播放仅为内置示例，各模块参数并非同一真实音频测定值，请先实验再导出正式发音卡。
                </span>
              </div>
              <button type="button" class="btn xs" @click="reopenDemoNotice">
                前往实验
              </button>
            </div>

            <div class="stage-toolbar" data-tour="card-stage-toolbar">
              <div class="toolbar-left">
                <button type="button" class="btn xs" :disabled="!selectedModuleIds.length" @click="autoReflowModules">
                  <IconSvg name="grid" :size="12" />
                  <span>智能重排</span>
                </button>
                <button type="button" class="btn xs" :disabled="!hasAnySlots" @click="equalizeGridRatios">
                  <span>均分长宽</span>
                </button>
                <button
                  v-if="hasEmptySlots"
                  type="button"
                  class="btn xs"
                  title="移除所有虚线留白槽位并自动展开其余模块"
                  @click="onStripAllEmptySlots"
                >
                  <span>收拢空槽</span>
                </button>
              </div>

              <div v-if="hasTractModule || mascotEnabled" class="toolbar-right">
                <span class="muted toolbar-mode-label">画布操作</span>
                <div class="seg mode-seg" role="radiogroup" aria-label="画布鼠标操作模式">
                  <button
                    type="button"
                    :class="{ active: fineLayer === 'none' }"
                    title="直接拖拽任意模块互换或吸附分栏"
                    @click="fineLayer = 'none'"
                  >
                    排版拖拽
                  </button>
                  <button
                    v-if="hasTractModule"
                    type="button"
                    :class="{ active: fineLayer === 'a' }"
                    title="拖拽平移声道剖面在格内的构图位置"
                    @click="fineLayer = 'a'"
                  >
                    {{ session.exploreMode.value === 'compare' ? '微移声道 A' : '微移声道' }}
                  </button>
                  <button
                    v-if="hasTractModule && session.exploreMode.value === 'compare'"
                    type="button"
                    :class="{ active: fineLayer === 'b' }"
                    title="拖拽平移声道 B 在格内的构图位置"
                    @click="fineLayer = 'b'"
                  >
                    微移声道 B
                  </button>
                  <button
                    v-if="stickers && mascotEnabled"
                    type="button"
                    :class="{ active: fineLayer === 'mascot' }"
                    title="拖拽调整角标贴纸位置"
                    @click="fineLayer = 'mascot'"
                  >
                    {{ stickers.name }}位置
                  </button>
                </div>
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
              data-tour="card-canvas"
              @dragover="onStageDragOver"
              @dragleave="onStageDragLeave"
              @drop="onStageDrop"
            >
              <!-- Real Encoded Sample Preview Mode -->
              <div v-if="encodedPreviewUrl" class="encoded-sample-wrap">
                <div class="encoded-banner">
                  <span>实机编码成片预览 · {{ encodedPreviewSizeKb }} KB</span>
                  <button type="button" class="btn xs primary" @click="saveEncodedPreviewDirectly">
                    <IconSvg name="download" :size="12" />
                    <span>直接保存样片</span>
                  </button>
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

              <!-- Live Interactive Canvas + Non-Obstructing Split-Tree Overlay -->
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

                <!-- Interactive Slot Selection, Whole-Card Drag & Resizable Gutters -->
                <div
                  v-if="renderedGeometry && fineLayer === 'none'"
                  class="interactive-overlay"
                >
                  <div
                    v-for="mb in renderedGeometry.moduleBoxes"
                    :key="mb.leafId"
                    class="slot-box"
                    :class="{
                      'is-dragging': mb.moduleId !== null && draggingModuleId === mb.moduleId,
                      'is-selected': activeLeafId === mb.leafId,
                      'is-empty-slot': mb.moduleId === null,
                    }"
                    :style="pctStyle(mb)"
                    :title="
                      mb.moduleId === 'tract-profile'
                        ? '按住拖动换位/吸附分栏 · 滚轮缩放声道 · 双击复位构图'
                        : mb.moduleId
                          ? '点击选中 · 按住拖动可互换槽位或吸附分栏'
                          : '点击选中留白空槽，可在右侧填入模块或保留留白'
                    "
                    @pointerdown="onSlotBodyPointerDown(mb, $event)"
                    @wheel="onSlotWheel(mb, $event)"
                    @dblclick="mb.moduleId === 'tract-profile' && resetTractFraming()"
                  >
                    <!-- Bottom-right compact floating action (never obscures module titles or badges!) -->
                    <div class="slot-corner-actions">
                      <button
                        v-if="mb.moduleId"
                        type="button"
                        class="btn xs icon-only slot-action-chip"
                        title="从卡片移除该模块"
                        aria-label="移除模块"
                        @pointerdown.stop
                        @click.stop="toggleModule(mb.moduleId)"
                      >
                        <IconSvg name="close" :size="11" />
                      </button>
                      <button
                        v-else
                        type="button"
                        class="btn xs icon-only slot-action-chip"
                        title="删除此留白空槽"
                        aria-label="删除空槽"
                        @pointerdown.stop
                        @click.stop="onRemoveLeafSlot(mb.leafId)"
                      >
                        <IconSvg name="trash" :size="11" />
                      </button>
                    </div>
                  </div>

                  <!-- Resizable Horizontal & Vertical Split Gutters (DOM-ordered above slot-box) -->
                  <div
                    v-for="g in renderedGeometry.gutters"
                    :key="g.id"
                    class="card-gutter"
                    :class="[g.dir === 'row' ? 'is-col-resize' : 'is-row-resize', { active: activeGutterId === g.id }]"
                    :style="pctStyle(g)"
                    :title="g.dir === 'row' ? '左右拖拽微调相邻分栏宽度（双击均分）' : '上下拖拽微调相邻分栏高度（双击均分）'"
                    @pointerdown="startGutterDrag(g, $event)"
                    @dblclick.stop="equalizeGridRatios"
                  >
                    <i class="gutter-pill" />
                  </div>

                  <!-- Snap-to-Slot Highlight Indicator (DOM-ordered on top) -->
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

            <!-- Adaptive Timeline & Frame Picker Bar -->
            <div class="dynamic-bar" data-tour="card-timeline">
              <div class="dyn-top-row">
                <button
                  type="button"
                  class="btn sm"
                  :class="{ primary: isAnimatedFormat }"
                  :disabled="exporting || selectedModuleIds.length === 0"
                  @click="toggleRealtimePreview"
                >
                  <IconSvg :name="isPlayingPreview ? 'pause' : 'play'" :size="12" />
                  <span>{{ playBtnLabel }}</span>
                </button>

                <input
                  type="range"
                  class="dyn-scrubber"
                  min="0"
                  :max="safeDuration_s"
                  step="0.02"
                  :value="Math.min(previewTime_s, safeDuration_s)"
                  :style="{ '--fill': scrubberFillPct }"
                  aria-label="预览时间进度"
                  @input="stopRealtimePreview(); previewTime_s = Number(($event.target as HTMLInputElement).value)"
                />
                <span class="mono muted dyn-clock">
                  {{ previewTime_s.toFixed(2) }}s / {{ safeDuration_s.toFixed(2) }}s
                </span>

                <label v-if="isAnimatedFormat" class="dyn-chk">
                  <input v-model="loopPreview" type="checkbox" />
                  <span>循环</span>
                </label>

                <button
                  v-if="isAnimatedFormat"
                  type="button"
                  class="btn xs"
                  :disabled="exporting || selectedModuleIds.length === 0"
                  title="调用本地编码器生成真实 MP4/GIF 样片查看画质与体积，满意后可直接保存"
                  @click="buildEncodedSamplePreview"
                >
                  <IconSvg name="eye" :size="12" />
                  <span>实机样片预览</span>
                </button>
              </div>

              <div class="dyn-source-row">
                <label class="dyn-inline-field dyn-source-select">
                  <span>动态源</span>
                  <CustomSelect
                    size="xs"
                    style="flex: 1"
                    :model-value="playbackSource"
                    :options="playbackSourceOptions"
                    @update:model-value="(v) => (playbackSource = v as CardPlaybackSourceId)"
                  />
                </label>

                <span v-if="!isAnimatedFormat" class="muted static-frame-hint">
                  静态卡模式：拖动进度条可挑选要定格导出的瞬间帧
                </span>

                <template v-else>
                  <label v-if="activeSourceMeta?.fixedTimeline" class="dyn-inline-field">
                    <span>起点(s)</span>
                    <input
                      :value="safeRangeStart_s"
                      type="number"
                      class="inp mono xs-num"
                      min="0"
                      :max="Math.max(0, maxTrimEnd_s - 0.3)"
                      step="0.1"
                      @change="commitRangeStart(($event.target as HTMLInputElement).value)"
                    />
                  </label>

                  <label class="dyn-inline-field">
                    <span>时长(s)</span>
                    <input
                      :value="safeDuration_s"
                      type="number"
                      class="inp mono xs-num"
                      min="0.6"
                      :max="maxAllowedDuration_s"
                      step="0.1"
                      @change="commitDuration(($event.target as HTMLInputElement).value)"
                    />
                  </label>

                  <div class="dur-presets">
                    <button
                      v-for="sec in [2, 3, 4, 6]"
                      :key="sec"
                      type="button"
                      class="btn xs mono dur-chip"
                      :class="{ active: Math.abs(safeDuration_s - sec) < 0.05 }"
                      @click="commitDuration(String(sec))"
                    >
                      {{ sec }}s
                    </button>
                    <button
                      v-if="activeSourceMeta?.fixedTimeline"
                      type="button"
                      class="btn xs dur-chip"
                      @click="syncDurationToSource"
                    >
                      整段({{ activeSourceMeta.naturalDuration_s }}s)
                    </button>
                  </div>
                </template>
              </div>
            </div>
          </section>

          <SplitPane
            v-model="inspectorWidth"
            direction="vertical"
            :invert="true"
            :min="292"
            :max="480"
            :default-value="346"
            title="拖拽调整右侧属性栏宽度（双击复位）"
          />

          <!-- RIGHT: 3-Tab Structured Inspector + Fixed Export Footer -->
          <aside class="inspector-pane" data-tour="card-inspector-panel" :style="{ width: `${inspectorWidth}px` }">
            <div class="inspector-tabs-bar">
              <div class="seg inspector-seg" role="tablist" aria-label="属性检查器分区">
                <button
                  type="button"
                  role="tab"
                  :class="{ active: inspectorTab === 'layout' }"
                  :aria-selected="inspectorTab === 'layout'"
                  @click="inspectorTab = 'layout'"
                >
                  <IconSvg name="layout" :size="12" />
                  <span>画幅与排版</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  :class="{ active: inspectorTab === 'style' }"
                  :aria-selected="inspectorTab === 'style'"
                  @click="inspectorTab = 'style'"
                >
                  <IconSvg name="palette" :size="12" />
                  <span>样式与标题</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  :class="{ active: inspectorTab === 'module' }"
                  :aria-selected="inspectorTab === 'module'"
                  @click="inspectorTab = 'module'"
                >
                  <IconSvg name="sliders" :size="12" />
                  <span>模块细节</span>
                </button>
              </div>
            </div>

            <div
              class="inspector-scroll"
              :data-tour="
                inspectorTab === 'style'
                  ? 'card-style-section'
                  : inspectorTab === 'module'
                    ? 'card-module-section'
                    : undefined
              "
            >
              <!-- TAB 1: Aspect Ratio & Nested Split-Tree Designer -->
              <template v-if="inspectorTab === 'layout'">
                <fieldset data-tour="card-layout-section">
                  <legend>画幅比例与长宽</legend>
                  <div class="ratio-grid">
                    <button
                      v-for="rc in ratioChips"
                      :key="rc.id"
                      type="button"
                      class="btn xs ratio-choice"
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
                  <div v-if="pendingAspectReflow" class="aspect-reflow-banner">
                    <span>画幅方向已变更，已保留你的自定义排版。</span>
                    <button type="button" class="btn xs primary" @click="applyAspectReflowNow">一键适配重排</button>
                  </div>
                  <small class="muted hint-line">
                    单音默认 1:1 方卡，双音对比默认 16:9 横卡；支持 360–3840 px 自定义。
                  </small>
                </fieldset>

                <fieldset class="grid-designer" data-tour="card-tree-designer">
                  <legend class="legend-with-badge">
                    <span>分栏结构与小图占比</span>
                    <span class="structure-tag" :class="{ nested: isNestedTree }">
                      {{ isNestedTree ? '嵌套分栏' : '规整网格' }}
                    </span>
                  </legend>

                  <!-- 1:1 Interactive Nested Tree Miniature Map -->
                  <div v-if="layoutTree" class="tree-map-frame">
                    <CardLayoutTreeMap
                      :node="layoutTree"
                      :selected-leaf-id="activeLeafId"
                      @select="selectGridCell"
                    />
                  </div>
                  <div v-else class="tree-map-empty muted">画布为空，点击下方行数或从左侧点选模块添加</div>

                  <!-- Quick Row Count / Equalize -->
                  <div class="grid-top-bar">
                    <span class="muted">规整行数</span>
                    <div class="seg grid-count-seg" role="radiogroup" aria-label="快捷设为规整行数">
                      <button
                        v-for="rCount in [1, 2, 3, 4, 5]"
                        :key="rCount"
                        type="button"
                        :class="{ active: !isNestedTree && rowGrid.length === rCount }"
                        @click="onChangeRowCount(rCount)"
                      >
                        {{ rCount }}行
                      </button>
                    </div>
                    <button type="button" class="btn xs" title="恢复所有分栏均分占比" @click="equalizeGridRatios">
                      均分
                    </button>
                  </div>

                  <!-- Standard 2D Grid Per-Row Col Quick Controls (hidden in nested mode so nested structure is never flattened!) -->
                  <div v-if="!isNestedTree && rowGrid.length > 0" class="grid-rows-compact">
                    <div v-for="(row, rIdx) in rowGrid" :key="row.rowId" class="grid-row-line">
                      <span class="grid-row-title">
                        第 {{ rIdx + 1 }} 行
                        <small v-if="rowGrid.length >= 2" class="mono muted">
                          · {{ Math.round(row.rowRatio * 100) }}%
                        </small>
                      </span>
                      <div class="grid-col-pills" role="radiogroup" :aria-label="`第 ${rIdx + 1} 行列数`">
                        <button
                          v-for="cCount in (row.cells.length > 4 ? [1, 2, 3, 4, row.cells.length] : [1, 2, 3, 4])"
                          :key="cCount"
                          type="button"
                          class="btn xs"
                          :class="{ active: row.cells.length === cCount }"
                          @click="onChangeRowCols(rIdx, cCount)"
                        >
                          {{ cCount }}列
                        </button>
                      </div>
                    </div>
                  </div>
                  <small v-else-if="isNestedTree" class="muted hint-line">
                    当前为嵌套分栏，可在上方结构图点选任意槽位直接拆分或调节宽高占比，无需拍平。
                  </small>

                  <!-- Active Slot Nested-Safe Inspector -->
                  <div v-if="activeLeafContext" class="grid-selected-editor">
                    <div class="sel-head-row">
                      <strong>
                        {{
                          activeLeafContext.moduleId
                            ? CARD_MODULE_MAP.get(activeLeafContext.moduleId)?.shortTitle
                            : '留白空槽'
                        }}
                      </strong>
                      <div class="sel-split-actions">
                        <button
                          type="button"
                          class="btn xs"
                          title="将当前槽位左右一分为二，右侧新增留白空槽"
                          @click="onSplitActiveLeaf('row')"
                        >
                          左右拆格
                        </button>
                        <button
                          type="button"
                          class="btn xs"
                          title="将当前槽位上下一分为二，下方新增留白空槽"
                          @click="onSplitActiveLeaf('col')"
                        >
                          上下拆格
                        </button>
                        <button
                          type="button"
                          class="btn xs icon-only"
                          title="移除当前槽位"
                          aria-label="移除当前槽位"
                          @click="onRemoveLeafSlot(activeLeafContext.leafId)"
                        >
                          <IconSvg name="trash" :size="11" />
                        </button>
                      </div>
                    </div>

                    <label>
                      <span>槽位展示模块</span>
                      <CustomSelect
                        size="xs"
                        :model-value="activeLeafContext.moduleId ?? ''"
                        :options="slotModuleOptions"
                        @update:model-value="(v) => onAssignSelectedCellModule(String(v))"
                      />
                    </label>

                    <CompactSlider
                      v-if="activeLeafContext.rowSplit && activeLeafContext.rowSplit.siblingCount >= 2"
                      label="所在水平分栏宽占比"
                      :model-value="Math.round(activeLeafContext.rowSplit.ratio * 100)"
                      :min="12"
                      :max="88"
                      :step="1"
                      :decimals="0"
                      unit="%"
                      :default-value="Math.round(100 / activeLeafContext.rowSplit.siblingCount)"
                      @update:model-value="(v) => onChangeActiveSplitRatio('row', v)"
                    />
                    <CompactSlider
                      v-if="activeLeafContext.colSplit && activeLeafContext.colSplit.siblingCount >= 2"
                      label="所在垂直分栏高占比"
                      :model-value="Math.round(activeLeafContext.colSplit.ratio * 100)"
                      :min="12"
                      :max="88"
                      :step="1"
                      :decimals="0"
                      unit="%"
                      :default-value="Math.round(100 / activeLeafContext.colSplit.siblingCount)"
                      @update:model-value="(v) => onChangeActiveSplitRatio('col', v)"
                    />
                  </div>
                </fieldset>

                <fieldset>
                  <legend>我的常用方案</legend>
                  <div class="two-cols">
                    <button type="button" class="btn sm" @click="saveUserCardPreset">保存当前方案</button>
                    <button type="button" class="btn sm" :disabled="!hasSavedUserPreset" @click="loadUserCardPreset">
                      载入常用方案
                    </button>
                  </div>
                  <small class="muted hint-line">保存画幅、配色、字体与当前模块组合，刷新后可一键复用。</small>
                </fieldset>
              </template>

              <!-- TAB 2: Palette, Skin, Typography, Title & Signature/Stickers -->
              <template v-else-if="inspectorTab === 'style'">
                <fieldset>
                  <legend>配色、风格与字体</legend>
                  <label>
                    <span>卡片配色</span>
                    <CustomSelect
                      size="sm"
                      :model-value="design.colorPreset"
                      :options="CARD_COLOR_OPTIONS"
                      @update:model-value="(v) => { pushHistorySnapshot('切换卡片配色'); design.colorPreset = v as CardColorPresetId; }"
                    />
                  </label>
                  <div class="swatch-preview-strip" aria-hidden="true">
                    <span
                      v-for="(col, idx) in colorPreviewSwatches"
                      :key="idx"
                      class="swatch-dot"
                      :style="{ background: col }"
                    />
                    <small class="muted">色板实时联动 2D/3D 声道与语谱图底色</small>
                  </div>
                  <label>
                    <span>卡片设计风格（可独立覆盖）</span>
                    <CustomSelect
                      size="sm"
                      :model-value="design.skinChoice"
                      :options="CARD_SKIN_OPTIONS"
                      @update:model-value="(v) => { pushHistorySnapshot('切换卡片风格'); design.skinChoice = v as CardSkinChoice; }"
                    />
                  </label>
                  <label>
                    <span>正文字体</span>
                    <CustomSelect
                      size="sm"
                      :model-value="design.font"
                      :options="fontOptions"
                      @update:model-value="(v) => { pushHistorySnapshot('切换正文字体'); design.font = v as CardFontId; }"
                    />
                  </label>
                  <CompactSlider
                    label="模块内文字比例"
                    :model-value="Math.round(design.textScale * 100)"
                    :min="68"
                    :max="148"
                    :step="2"
                    :decimals="0"
                    unit="%"
                    :default-value="100"
                    @update:model-value="(v) => { pushHistoryDebounced('调整文字比例'); design.textScale = Number((v / 100).toFixed(2)); }"
                  />
                </fieldset>

                <fieldset>
                  <legend>顶部标题栏</legend>
                  <label class="inline-chk">
                    <input
                      :checked="design.showHeader"
                      type="checkbox"
                      @change="onToggleShowHeader(($event.target as HTMLInputElement).checked)"
                    />
                    <span>显示顶部标题栏（勾选自动带入当前词条）</span>
                  </label>
                  <template v-if="design.showHeader">
                    <div class="title-input-row">
                      <input
                        v-model="titleOverride"
                        class="inp"
                        maxlength="84"
                        placeholder="输入卡片主标题"
                      />
                      <button
                        type="button"
                        class="btn xs"
                        title="填入当前工作台词条"
                        @click="fillSuggestedTitle"
                      >
                        带入词条
                      </button>
                    </div>
                    <CompactSlider
                      label="标题字号比例"
                      :model-value="Math.round(design.titleScale * 100)"
                      :min="72"
                      :max="150"
                      :step="2"
                      :decimals="0"
                      unit="%"
                      :default-value="100"
                      :disabled="!titleOverride.trim()"
                      @update:model-value="(v) => { pushHistoryDebounced('调整标题字号'); design.titleScale = Number((v / 100).toFixed(2)); }"
                    />
                  </template>
                </fieldset>

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
                    <input v-model="mascotEnabled" type="checkbox" />
                    <span>添加{{ stickers.name }}角标贴纸</span>
                  </label>
                  <div v-if="stickers && mascotEnabled" class="sticker-picker-box">
                    <div v-if="isAnimatedFormat" class="seg sticker-mode-seg" role="radiogroup" aria-label="贴纸动静模式">
                      <button
                        type="button"
                        :class="{ active: mascotUseAnimated }"
                        @click="setMascotMotionMode(true)"
                      >
                        动态 GIF ({{ gifStickerCount }})
                      </button>
                      <button
                        type="button"
                        :class="{ active: !mascotUseAnimated }"
                        @click="setMascotMotionMode(false)"
                      >
                        全部静态帧 ({{ allStickerCount }})
                      </button>
                    </div>
                    <div class="sticker-thumb-grid" role="radiogroup" aria-label="选择贴纸形象">
                      <button
                        v-for="st in visibleStickers"
                        :key="st.id"
                        type="button"
                        class="sticker-tile"
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
              </template>

              <!-- TAB 3: Selected Module Specific Options -->
              <template v-else>
                <div v-if="!hasAnyModuleOptions" class="module-empty-tip muted">
                  当前画布上已选的模块均为自动排版展示，无须额外细项配置。添加声道剖面、语音合成、元音图、连续统或截面/声门模块后，可在此精细调节。
                </div>

                <fieldset v-if="hasTractModule" :class="{ 'focused-sec': selectedModuleId === 'tract-profile' }">
                  <legend>声道剖面细节</legend>
                  <label>
                    <span>几何视图</span>
                    <CustomSelect
                      size="sm"
                      :model-value="design.tractView"
                      :options="tractViewOptions"
                      @update:model-value="(v) => { pushHistorySnapshot('切换声道视图'); design.tractView = v as 'sagittal' | 'model'; }"
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
                    @update:model-value="(v) => { pushHistoryDebounced('调整声道缩放'); design.tractZoom = Number((v / 100).toFixed(2)); }"
                  />
                  <label class="inline-chk">
                    <input v-model="design.showFullHead" type="checkbox" />
                    <span>显示完整头部外廓（取消则聚焦口腔与声带）</span>
                  </label>
                  <label class="inline-chk">
                    <input v-model="design.showOrientationCompass" type="checkbox" />
                    <span>显示解剖方位标（上/下/后—前）</span>
                  </label>
                  <div class="two-cols">
                    <button type="button" class="btn xs" @click="fineLayer = fineLayer === 'a' ? 'none' : 'a'">
                      {{ fineLayer === 'a' ? '结束微移声道' : '在画布微移声道' }}
                    </button>
                    <button type="button" class="btn xs" @click="resetTractFraming">复位缩放与偏移</button>
                  </div>
                </fieldset>

                <fieldset v-if="hasSynthModule" :class="{ 'focused-sec': selectedModuleId === 'synth-timeline' }">
                  <legend>语音合成轨道勾选</legend>
                  <div class="two-cols">
                    <label class="inline-chk">
                      <input
                        :checked="design.synthTracks.syllables"
                        type="checkbox"
                        @change="toggleSynthTrack('syllables', ($event.target as HTMLInputElement).checked)"
                      />
                      <span>词条音节行</span>
                    </label>
                    <label class="inline-chk">
                      <input
                        :checked="design.synthTracks.phones"
                        type="checkbox"
                        @change="toggleSynthTrack('phones', ($event.target as HTMLInputElement).checked)"
                      />
                      <span>IPA 音素行</span>
                    </label>
                    <label class="inline-chk">
                      <input
                        :checked="design.synthTracks.phonation"
                        type="checkbox"
                        @change="toggleSynthTrack('phonation', ($event.target as HTMLInputElement).checked)"
                      />
                      <span>发声类型 VoQS</span>
                    </label>
                    <label class="inline-chk">
                      <input
                        :checked="design.synthTracks.f0"
                        type="checkbox"
                        @change="toggleSynthTrack('f0', ($event.target as HTMLInputElement).checked)"
                      />
                      <span>基频曲线 F0</span>
                    </label>
                    <label class="inline-chk">
                      <input
                        :checked="design.synthTracks.pressure"
                        type="checkbox"
                        @change="toggleSynthTrack('pressure', ($event.target as HTMLInputElement).checked)"
                      />
                      <span>声门下压 Pa</span>
                    </label>
                    <label class="inline-chk">
                      <input
                        :checked="design.synthTracks.waveform"
                        type="checkbox"
                        @change="toggleSynthTrack('waveform', ($event.target as HTMLInputElement).checked)"
                      />
                      <span>合成语音波形</span>
                    </label>
                  </div>
                </fieldset>

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
                      <input
                        type="number"
                        class="inp mono"
                        min="1"
                        :max="continuumCellCount"
                        step="1"
                        required
                        :value="continuumLayoutCount"
                        @change="setContinuumLayoutCount"
                      />
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
              </template>
            </div>

            <!-- Unified Export Footer -->
            <footer class="export-footer" data-tour="card-export-footer">
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
                  <button type="button" class="btn xs" :class="{ active: mp4Fps === 24 }" @click="mp4Fps = 24">24fps</button>
                  <button type="button" class="btn xs" :class="{ active: mp4Fps === 30 }" @click="mp4Fps = 30">30fps</button>
                </div>
              </div>

              <div v-else-if="session.exploreCardFormat.value === 'GIF'" class="fmt-extra-row">
                <span class="muted fmt-sub-lbl">循环动图帧率（无音轨）</span>
                <div class="fps-pills mono">
                  <button type="button" class="btn xs" :class="{ active: gifFps === 12 }" @click="gifFps = 12">12fps</button>
                  <button type="button" class="btn xs" :class="{ active: gifFps === 15 }" @click="gifFps = 15">15fps</button>
                  <button type="button" class="btn xs" :class="{ active: gifFps === 20 }" @click="gifFps = 20">20fps</button>
                </div>
              </div>

              <div class="export-cta-row">
                <button
                  v-if="session.exploreCardFormat.value === 'PNG' && !exporting"
                  type="button"
                  class="btn export-copy-action"
                  :disabled="previewBusy || selectedModuleIds.length === 0"
                  title="将当前高清 PNG 发音卡复制到系统剪贴板，可直接粘贴至文档或编辑器"
                  @click="copyPngToClipboard"
                >
                  <IconSvg name="copy" :size="13" />
                  <span>复制图片</span>
                </button>

                <button
                  v-if="!exporting"
                  type="button"
                  class="btn primary export-submit"
                  :disabled="previewBusy || selectedModuleIds.length === 0"
                  @click="runExportDownload"
                >
                  <IconSvg name="download" :size="14" />
                  <span>
                    {{
                      session.exploreCardFormat.value === 'PNG' && previewTime_s > 0.001
                        ? `导出 PNG (${cardDims[0]}×${cardDims[1]} · ${previewTime_s.toFixed(2)}s)`
                        : encodedPreviewBlob && encodedPreviewFormat === session.exploreCardFormat.value
                          ? `保存已生成 ${session.exploreCardFormat.value} (${encodedPreviewSizeKb} KB)`
                          : `导出 ${session.exploreCardFormat.value} (${cardDims[0]}×${cardDims[1]})`
                    }}
                  </span>
                </button>

                <button
                  v-else
                  type="button"
                  class="btn danger export-submit"
                  @click="cancelActiveExport"
                >
                  <IconSvg name="stop" :size="13" />
                  <span>取消导出 ({{ Math.round(exportProgress01 * 100) }}%)</span>
                </button>
              </div>

              <div v-if="exporting" class="export-progress-track" aria-hidden="true">
                <div class="export-progress-fill" :style="{ width: `${Math.round(exportProgress01 * 100)}%` }" />
              </div>

              <p v-if="progressText || feedbackText" class="export-status muted" role="status">
                {{ progressText || feedbackText }}
              </p>
            </footer>
          </aside>
        </div>
      </div>
    </div>

    <!-- Demo Preview Notice Dialog when opened without any completed experiment -->
    <div
      v-if="isOpen && session.cardDemoNoticeOpen.value"
      class="export-modal-mask demo-notice-mask"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cardDemoNoticeTitle"
      @click.self="dismissDemoNotice"
    >
      <div class="export-modal-card demo-notice-card">
        <header class="p-head demo-notice-head">
          <div class="demo-notice-title-wrap">
            <span class="demo-notice-badge">
              <IconSvg name="info" :size="15" />
            </span>
            <strong id="cardDemoNoticeTitle">当前画面仅为演示预览</strong>
          </div>
          <button
            type="button"
            class="btn xs icon-only"
            aria-label="关闭提醒并继续浏览"
            @click="dismissDemoNotice"
          >
            <IconSvg name="close" :size="13" />
          </button>
        </header>

        <div class="p-body demo-notice-body">
          <p class="demo-notice-lead">
            尚未检测到你在各工作区完成的真实实验数据。此时画布中各子模块展示的内容与试听音频均来自内置默认构型或示例样本，<strong>各模块参数并不对应同一段真实实验音频</strong>。
          </p>
          <p class="muted demo-notice-sub">
            建议先在下方任一实验工作区完成语音合成、音标实录查阅、声道重建或发声调制，再回到发音卡工坊排版并导出正式发音卡；你也可以关闭本提示，先自由浏览与试用各个子模块。
          </p>

          <div class="demo-shortcut-grid">
            <button
              v-for="item in EXPERIMENT_SHORTCUTS"
              :key="item.id"
              type="button"
              class="btn demo-shortcut-item"
              @click="navigateToExperiment(item.id)"
            >
              <strong>{{ item.label }}</strong>
              <small class="muted">{{ item.desc }}</small>
            </button>
          </div>
        </div>

        <footer class="demo-notice-foot">
          <button type="button" class="btn primary" @click="dismissDemoNotice">
            知道了，继续浏览演示
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.phonetic-card-studio {
  width: min(1760px, calc((100vw - 24px) / var(--page-scale, 1)));
  height: min(1020px, calc((100dvh - 24px) / var(--page-scale, 1)));
  max-width: min(1920px, calc((100vw - 24px) / var(--page-scale, 1)));
  max-height: min(1120px, calc((100dvh - 24px) / var(--page-scale, 1)));
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
  gap: 7px;
  min-width: 0;
}

.dim-pill {
  font-size: 0.833333rem;
  padding: 1px 6px;
  border-radius: var(--r-ctrl);
  background: var(--ctrl-bg);
  border: 1px solid var(--panel-border);
  white-space: nowrap;
}

.head-tip {
  font-size: 0.8125rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.studio-body-flex {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
}

.gallery-col {
  flex: none;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.gallery-col > :deep(.module-gallery) {
  flex: 1;
  min-height: 0;
}

/* Center Workspace */
.canvas-workspace {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--app) 88%, var(--panel));
}

.stage-toolbar {
  flex: none;
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

.toolbar-mode-label {
  font-size: 0.8rem;
}

.mode-seg {
  display: inline-flex;
}

.stage-viewport {
  flex: 1 1 0;
  width: 100%;
  position: relative;
  min-width: 0;
  min-height: 0;
  container-type: size;
  display: grid;
  place-items: center;
  border-radius: var(--r-panel);
  border: var(--border-w, 1px) solid var(--panel-border);
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
  box-shadow: 0 10px 30px color-mix(in srgb, var(--shadow-ink) 26%, transparent);
  border-radius: var(--r-ctrl);
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
  border-radius: var(--r-ctrl);
  pointer-events: auto;
  cursor: grab;
  touch-action: none;
  transition: outline-color var(--dur-fast) var(--ease-out-expo);
}

.slot-box:active {
  cursor: grabbing;
}

.slot-box.is-empty-slot {
  cursor: pointer;
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
  opacity: 0.42;
}

/* Non-obstructing bottom-right hover action */
.slot-corner-actions {
  position: absolute;
  right: 5px;
  bottom: 5px;
  display: inline-flex;
  gap: 3px;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-fast) var(--ease-out-expo);
}

.slot-box:hover .slot-corner-actions {
  opacity: 1;
  pointer-events: auto;
}

.slot-action-chip {
  background: color-mix(in srgb, var(--panel) 94%, transparent);
  border-color: var(--panel-border);
  box-shadow: var(--ctrl-shadow);
}

.slot-action-chip:hover {
  border-color: var(--danger);
  background: var(--danger);
  color: var(--on-accent);
}

/* Split-Tree Gutters (softly visible by default so users discover resizing immediately) */
.card-gutter {
  position: absolute;
  pointer-events: auto;
  display: grid;
  place-items: center;
  touch-action: none;
}

.card-gutter.is-col-resize {
  cursor: col-resize;
}

.card-gutter.is-row-resize {
  cursor: row-resize;
}

.gutter-pill {
  display: block;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--accent) 76%, var(--text));
  opacity: 0.28;
  transition: opacity var(--dur-fast) var(--ease-out-expo), transform var(--dur-fast) var(--ease-out-expo);
}

.card-gutter.is-col-resize .gutter-pill {
  width: 3px;
  height: min(36px, 50%);
}

.card-gutter.is-row-resize .gutter-pill {
  height: 3px;
  width: min(36px, 50%);
}

.card-gutter:hover .gutter-pill,
.card-gutter.active .gutter-pill {
  opacity: 1;
  transform: scale(1.18);
}

.snap-zone-indicator {
  position: absolute;
  border-radius: var(--r-panel);
  border: 2px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  display: grid;
  place-items: center;
  pointer-events: none;
}

.snap-zone-indicator span {
  padding: 3px 10px;
  border-radius: var(--r-pill);
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--accent);
  font-size: 0.8125rem;
  font-weight: 700;
  box-shadow: var(--popover-shadow);
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
  flex-wrap: wrap;
  gap: 8px;
  font-size: 0.85rem;
}

.encoded-media {
  max-width: calc(100cqw - 24px);
  max-height: calc(100cqh - 52px);
  border-radius: var(--r-ctrl);
  box-shadow: var(--popover-shadow);
}

/* Dynamic Timeline Bar */
.dynamic-bar {
  flex: none;
  padding: 8px 10px;
  border-radius: var(--r-panel);
  border: var(--border-w, 1px) solid var(--panel-border);
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

.dyn-source-select {
  min-width: 210px;
}

.static-frame-hint {
  font-size: 0.78rem;
  margin-left: auto;
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
  padding: 0 7px;
}

/* Right Inspector */
.inspector-pane {
  flex: none;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: var(--border-w, 1px) solid var(--panel-border);
  background: var(--panel);
}

.inspector-tabs-bar {
  padding: 8px 12px;
  border-bottom: var(--border-w, 1px) solid var(--panel-border);
  background: color-mix(in srgb, var(--sidebar) 46%, var(--panel));
  flex: none;
}

.inspector-seg {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.inspector-seg button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  white-space: nowrap;
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

.inspector-pane fieldset.focused-sec {
  padding: 8px 9px 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--panel-border));
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--selected) 26%, var(--panel));
}

.inspector-pane fieldset:last-child {
  margin: 0;
  border-bottom: 0;
}

.inspector-pane legend {
  padding: 0 0 4px;
  font-size: 0.916667rem;
  font-weight: 700;
  color: var(--text);
}

.legend-with-badge {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.structure-tag {
  font-size: 0.72rem;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: var(--r-pill);
  border: 1px solid var(--panel-border);
  color: var(--muted);
  background: var(--ctrl-bg);
}

.structure-tag.nested {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--panel-border));
  color: var(--accent);
  background: var(--selected);
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

.ratio-choice {
  justify-content: center;
  white-space: nowrap;
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

.aspect-reflow-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--panel-border));
  background: color-mix(in srgb, var(--selected) 52%, var(--panel));
  font-size: 0.78rem;
  color: var(--text);
}

.hint-line {
  font-size: 0.78rem;
  line-height: 1.4;
}

.tree-map-frame {
  height: 122px;
  padding: 6px;
  border-radius: var(--r-ctrl);
  border: var(--border-w, 1px) solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 68%, var(--panel));
}

.tree-map-empty {
  padding: 18px 10px;
  text-align: center;
  border-radius: var(--r-ctrl);
  border: 1px dashed var(--panel-border);
  font-size: 0.8rem;
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

.grid-rows-compact {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.grid-row-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 4px 7px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 54%, var(--panel));
}

.grid-row-title {
  font-size: 0.79rem;
  font-weight: 600;
  color: var(--text);
}

.grid-col-pills {
  display: inline-flex;
  gap: 3px;
}

.grid-selected-editor {
  padding: 8px 9px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--panel-border));
  background: color-mix(in srgb, var(--selected) 34%, var(--panel));
  display: grid;
  gap: 7px;
}

.sel-head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 0.8125rem;
  color: var(--accent);
}

.sel-split-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.swatch-preview-strip {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 6px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 62%, var(--panel));
}

.swatch-dot {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 1px solid var(--border);
  flex: none;
}

.title-input-row {
  display: flex;
  align-items: center;
  gap: 5px;
}

.title-input-row .inp {
  flex: 1;
  min-width: 0;
}

.module-empty-tip {
  padding: 18px 8px;
  font-size: 0.82rem;
  line-height: 1.55;
  text-align: center;
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
  border: var(--border-w, 1px) solid var(--ctrl-border, var(--panel-border));
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

.sticker-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 5px 4px;
  border-radius: var(--r-ctrl);
  border: var(--border-w, 1px) solid var(--ctrl-border, var(--panel-border));
  background: var(--ctrl-bg);
  box-shadow: var(--ctrl-shadow);
  color: var(--muted);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out-expo), background-color var(--dur-fast) var(--ease-out-expo), color var(--dur-fast) var(--ease-out-expo);
}

.sticker-tile img {
  width: 44px;
  height: 44px;
  object-fit: contain;
  border-radius: max(2px, calc(var(--r-ctrl) - 2px));
  background: color-mix(in srgb, var(--panel) 65%, transparent);
}

.sticker-tile span {
  font-size: 0.72rem;
  line-height: 1.15;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.sticker-tile.active {
  border-color: var(--accent);
  background: var(--selected);
  color: var(--accent);
  font-weight: 600;
}

/* Export Footer */
.export-footer {
  padding: 10px 13px;
  border-top: var(--border-w, 1px) solid var(--panel-border);
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

.fmt-sub-lbl {
  font-size: 0.8125rem;
}

.fps-pills {
  display: inline-flex;
  gap: 4px;
}

.export-cta-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.export-copy-action {
  flex: none;
  height: 32px;
  padding: 0 10px;
}

.export-submit {
  flex: 1;
  min-width: 0;
  height: 32px;
  justify-content: center;
}

.export-progress-track {
  width: 100%;
  height: 4px;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--border) 60%, var(--app));
  overflow: hidden;
}

.export-progress-fill {
  height: 100%;
  border-radius: var(--r-pill);
  background: var(--accent);
  transition: width var(--dur-fast) var(--ease-out-expo);
}

.export-status {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.4;
}

/* Demo Preview Warning Strip & Modal */
.demo-preview-banner {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 10px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--warning) 44%, var(--panel-border));
  background: color-mix(in srgb, var(--warning) 12%, var(--panel));
  color: var(--text);
  font-size: 0.8125rem;
  line-height: 1.42;
}

.demo-banner-main {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.demo-banner-main :deep(svg) {
  flex: none;
  color: var(--warning);
}

.demo-notice-mask {
  background: var(--overlay);
  z-index: var(--z-modal);
}

.demo-notice-card {
  width: min(560px, calc(100vw - 32px));
  max-width: 100%;
  background: var(--popover-bg);
  display: flex;
  flex-direction: column;
}

.demo-notice-head {
  height: 42px;
  padding: 0 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.demo-notice-title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.demo-notice-badge {
  width: 24px;
  height: 24px;
  border-radius: var(--r-pill);
  border: 1px solid color-mix(in srgb, var(--warning) 46%, var(--panel-border));
  background: color-mix(in srgb, var(--warning) 16%, var(--panel));
  color: var(--warning);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.demo-notice-body {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.demo-notice-lead {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.56;
  color: var(--text);
}

.demo-notice-sub {
  margin: 0;
  font-size: 0.83rem;
  line-height: 1.52;
}

.demo-shortcut-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 2px;
}

.demo-shortcut-item {
  height: auto;
  padding: 9px 10px;
  flex-direction: column;
  align-items: flex-start;
  text-align: left;
  gap: 4px;
  white-space: normal;
}

.demo-shortcut-item strong {
  font-size: 0.84rem;
}

.demo-shortcut-item small {
  font-size: 0.76rem;
  line-height: 1.38;
  font-weight: 400;
}

.demo-notice-foot {
  padding: 10px 16px 14px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px solid color-mix(in srgb, var(--panel-border) 75%, transparent);
}

@media (max-width: 640px) {
  .demo-shortcut-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 1060px) {
  .studio-body-flex {
    flex-direction: column;
    overflow-y: auto;
  }
  .gallery-col,
  .inspector-pane {
    width: 100% !important;
  }
  .canvas-workspace {
    min-height: 460px;
  }
}
</style>
