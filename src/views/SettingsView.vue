<script setup lang="ts">
import ReferencesModal from '@/components/modals/ReferencesModal.vue';
import {
  fetchLocalModels,
  liveLocalModels,
  loadAllLocalModels,
  loadLocalModel,
  localModelsSummary,
  mountExternalFolderPath,
  mountExternalOnnxBinary,
  resetAllLocalModels,
  resetLocalModel,
  unloadAllLocalModels,
  unloadLocalModel,
  type LiveLocalModelInfo,
} from '@/data/local-models';
import { APP_BRAND_NAME, APP_VERSION } from '@/data/app-branding';
import { hasUpdate, latestRelease, openUpdateModal } from '@/data/app-update';
import { openStartupSplashPreview } from '@/data/startup-splash';
import {
  activeWorkspaceBackground,
  activeWorkspaceIcon,
  addWorkspaceBackground,
  savedWorkspaceIcon,
  selectWorkspaceBackground,
  setCustomWorkspaceIconEnabled,
  uploadWorkspaceIcon,
  workspaceBackgrounds,
  workspaceIconUrl,
} from '@/data/workspace-images';
import { LOCAL_MODEL_SPECS, LOCAL_MODEL_TOTALS } from '@/data/model-training-report';
import { SHORTCUT_GROUPS } from '@/data/guide-content';
import SpeakerReferenceControls from '@/components/common/SpeakerReferenceControls.vue';
import { textPoseOptions, textPoseSource } from '@/data/ipa-pose-source';
import { synthesisGainMode } from '@/data/voice-renderer';
import NavArtwork from '@/components/common/NavArtwork.vue';
import VoiceRenderSelect from '@/components/common/VoiceRenderSelect.vue';
import PortableCachePanel from '@/components/settings/PortableCachePanel.vue';
import { computed, onMounted, ref, watch } from 'vue';
import { listBackdrops, listSkins, palettes } from '@/styles/skin-registry';
import { BACKDROP_COLOR_PRESETS, paletteDisplayName } from '@/styles/themes';
import { CHINESE_FONTS, LATIN_FONTS, type InterfaceFonts } from '@/styles/interface-fonts';
import { ANATOMY_PALETTE_OPTIONS, DEFAULT_ANATOMY_APPEARANCE, type AnatomyPaletteId } from '@/styles/anatomy-appearance';
import {
  useWorkbenchStore,
  type AiDrawerDockMode,
  type LayoutDensity,
  type NavPlacement,
  type SettingsTabId,
  type TimelineTrackScale,
} from '@/stores/workbench';
import { exploreLabel } from '@vocalcut/edition';
import {
  SPLITTER_GROUPS,
  getConfiguredSplitterDefault,
  isSplitterCustomized,
  type SplitterSpec,
} from '@/data/splitter-layout';
import CompactSlider from '@/components/common/CompactSlider.vue';
import CustomSelect, { type SelectOption } from '@/components/common/CustomSelect.vue';
import IconSvg from '@/components/common/IconSvg.vue';
import { useOnboardingStore } from '@/stores/onboarding';

type SettingViewTabId = 'appearance' | 'layout' | 'shortcuts' | 'engine' | 'credits';

const store = useWorkbenchStore();
const onboarding = useOnboardingStore();

function onToggleAutoOnboarding(e: Event): void {
  const checked = (e.target as HTMLInputElement).checked;
  onboarding.setAutoEnabled(checked);
  store.pushToast(
    checked ? '已开启首次进入页面自动弹出聚光灯指引' : '已关闭首次进入自动指引，仍可随时在此重播',
    'info',
    2400,
  );
}

function onResetAllOnboarding(): void {
  onboarding.resetAllTours();
  store.pushToast('已重置全部页面的首次指引状态，下次进入各工作区将重新引导', 'success', 2800);
}

function mapStoreTabToView(tab: SettingsTabId): SettingViewTabId {
  if (tab === 'style-lab') return 'appearance';
  if (tab === 'layout' || tab === 'engine' || tab === 'shortcuts') return tab;
  return 'appearance';
}

const activeTab = ref<SettingViewTabId>(mapStoreTabToView(store.settingsTab.value));

watch(
  () => store.settingsTab.value,
  (next) => {
    if (next === 'style-lab') {
      activeTab.value = 'appearance';
      store.styleLabOpen.value = true;
      return;
    }
    activeTab.value = mapStoreTabToView(next);
  },
);

function selectTab(id: SettingViewTabId): void {
  activeTab.value = id;
  if (id === 'appearance' || id === 'layout' || id === 'shortcuts' || id === 'engine') {
    store.settingsTab.value = id;
  }
}

const modelMessage = ref('随包内置 9 个 ONNX 本地模型');
const checkingModels = ref(false);
const busyModelName = ref<string | null>(null);
const batchModelBusy = ref(false);
const folderPanelOpen = ref(false);
const externalFolderInput = ref('');
const mountingFolder = ref(false);
const singleOnnxInputRef = ref<HTMLInputElement | null>(null);
const folderOnnxInputRef = ref<HTMLInputElement | null>(null);
const pendingMountSlotName = ref<string | null>(null);

async function checkLocalModels(): Promise<void> {
  checkingModels.value = true;
  modelMessage.value = '正在核验本地 ONNX 引擎与模型状态…';
  try {
    const result = await fetchLocalModels();
    const loadedCount = result.loaded_count ?? result.models.filter((m) => m.loaded).length;
    const inMemCount = result.in_memory_count ?? result.models.filter((m) => m.in_memory).length;
    const extCount = result.external_count ?? result.models.filter((m) => m.source === 'external').length;
    modelMessage.value =
      `ONNX Runtime 已核验 · 已装载 ${loadedCount}/${result.models.length}` +
      (inMemCount > 0 ? `（${inMemCount} 项驻留内存）` : '') +
      (extCount > 0 ? ` · 外置 ${extCount} 项` : '');
  } catch {
    modelMessage.value = '本地引擎离线 · 当前展示内置 ONNX 规格清单';
  } finally {
    checkingModels.value = false;
  }
}

async function toggleModelHotPlug(model: { name: string; loaded: boolean; available: boolean | null }): Promise<void> {
  if (busyModelName.value || batchModelBusy.value) return;
  if (!localModelsSummary.value.online) {
    store.pushToast('请先启动本地推理引擎后再装载或卸载模型', 'warning', 2600);
    return;
  }
  busyModelName.value = model.name;
  try {
    if (model.loaded) {
      await unloadLocalModel(model.name);
      store.pushToast(`已卸载 ${model.name} 并释放内存会话`, 'info', 2200);
    } else {
      const updated = await loadLocalModel(model.name, 'cpu');
      const msNote = updated.load_ms != null ? `（${updated.load_ms} ms）` : '';
      store.pushToast(`已装载 ${model.name}${msNote}`, 'success', 2200);
    }
    await checkLocalModels();
  } catch (err) {
    store.pushToast(err instanceof Error ? err.message : `切换 ${model.name} 状态失败`, 'danger', 3400);
  } finally {
    busyModelName.value = null;
  }
}

async function onLoadAllModels(): Promise<void> {
  if (batchModelBusy.value || busyModelName.value) return;
  batchModelBusy.value = true;
  try {
    const res = await loadAllLocalModels('cpu');
    const errCount = res.errors?.length ?? 0;
    if (errCount > 0) {
      store.pushToast(`批量装载完成，其中 ${errCount} 项失败：${res.errors?.[0]?.hint ?? ''}`, 'warning', 3800);
    } else {
      store.pushToast('已将全部 9 项 ONNX 模型装载入内存', 'success', 2400);
    }
    await checkLocalModels();
  } catch (err) {
    store.pushToast(err instanceof Error ? err.message : '批量装载失败', 'danger', 3200);
  } finally {
    batchModelBusy.value = false;
  }
}

async function onUnloadAllModels(): Promise<void> {
  if (batchModelBusy.value || busyModelName.value) return;
  batchModelBusy.value = true;
  try {
    await unloadAllLocalModels();
    store.pushToast('已卸载全部本地模型并释放推理会话内存', 'info', 2400);
    await checkLocalModels();
  } catch (err) {
    store.pushToast(err instanceof Error ? err.message : '批量卸载失败', 'danger', 3200);
  } finally {
    batchModelBusy.value = false;
  }
}

function triggerSingleModelMount(slotName: string): void {
  if (!localModelsSummary.value.online) {
    store.pushToast('请先启动本地推理引擎后再装载外部模型', 'warning', 2600);
    return;
  }
  pendingMountSlotName.value = slotName;
  singleOnnxInputRef.value?.click();
}

async function onSingleOnnxPicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  const slotName = pendingMountSlotName.value;
  pendingMountSlotName.value = null;
  if (!file || !slotName) return;
  busyModelName.value = slotName;
  try {
    const updated = await mountExternalOnnxBinary(file, slotName);
    store.pushToast(`已为 ${slotName} 装载外置模型「${updated.external_label ?? file.name}」`, 'success', 3200);
    await checkLocalModels();
  } catch (err) {
    store.pushToast(err instanceof Error ? err.message : '装载外置 ONNX 模型失败', 'danger', 4500);
  } finally {
    busyModelName.value = null;
  }
}

async function onMountExternalFolderByPath(): Promise<void> {
  const dir = externalFolderInput.value.trim();
  if (!dir) {
    store.pushToast('请先输入包含 .onnx 模型的本地文件夹路径', 'warning', 2400);
    return;
  }
  mountingFolder.value = true;
  try {
    const res = await mountExternalFolderPath(dir);
    const nOk = res.mounted_count ?? 0;
    const nSkip = res.unmatched?.length ?? 0;
    if (nOk > 0) {
      store.pushToast(
        `已从目录装载 ${nOk} 个外部 ONNX 模型` + (nSkip > 0 ? `（另有 ${nSkip} 个未匹配文件已跳过）` : ''),
        'success',
        3600,
      );
    } else {
      const reason = res.unmatched?.[0]?.reason ?? '未发现符合槽位契约的 .onnx 文件';
      store.pushToast(`未挂载任何模型：${reason}`, 'warning', 4200);
    }
    await checkLocalModels();
  } catch (err) {
    store.pushToast(err instanceof Error ? err.message : '扫描外部文件夹失败', 'danger', 4000);
  } finally {
    mountingFolder.value = false;
  }
}

async function onBrowserFolderPicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const allFiles = Array.from(input.files ?? []);
  input.value = '';
  const onnxFiles = allFiles.filter((f) => f.name.toLowerCase().endsWith('.onnx'));
  if (!onnxFiles.length) {
    store.pushToast('所选文件夹中未找到 .onnx 模型文件', 'warning', 2800);
    return;
  }
  mountingFolder.value = true;
  let mounted = 0;
  const failed: string[] = [];
  try {
    for (const file of onnxFiles) {
      try {
        await mountExternalOnnxBinary(file);
        mounted += 1;
      } catch (err) {
        failed.push(`${file.name}: ${err instanceof Error ? err.message : '契约不匹配'}`);
      }
    }
    if (mounted > 0) {
      store.pushToast(
        `已从文件夹自动匹配装载 ${mounted} 个 ONNX 模型` + (failed.length ? `（${failed.length} 个未匹配）` : ''),
        'success',
        3800,
      );
    } else {
      store.pushToast(`未匹配到兼容的槽位：${failed[0] ?? ''}`, 'warning', 4500);
    }
    await checkLocalModels();
  } finally {
    mountingFolder.value = false;
  }
}

async function onResetSingleModel(name: string): Promise<void> {
  if (busyModelName.value || batchModelBusy.value) return;
  busyModelName.value = name;
  try {
    await resetLocalModel(name);
    store.pushToast(`已将 ${name} 恢复为随包内置 ONNX 权重`, 'info', 2400);
    await checkLocalModels();
  } catch (err) {
    store.pushToast(err instanceof Error ? err.message : `恢复 ${name} 失败`, 'danger', 3200);
  } finally {
    busyModelName.value = null;
  }
}

async function onResetAllModels(): Promise<void> {
  if (batchModelBusy.value || busyModelName.value) return;
  batchModelBusy.value = true;
  try {
    await resetAllLocalModels();
    store.pushToast('已将全部模型槽位恢复为内置 ONNX 默认权重', 'info', 2600);
    await checkLocalModels();
  } catch (err) {
    store.pushToast(err instanceof Error ? err.message : '恢复默认模型失败', 'danger', 3200);
  } finally {
    batchModelBusy.value = false;
  }
}

watch(
  activeTab,
  (tab) => {
    if (tab === 'engine') void checkLocalModels();
  },
  { immediate: true },
);

onMounted(() => {
  if (store.settingsTab.value === 'style-lab') {
    store.styleLabOpen.value = true;
  }
});

const mergedModelCards = computed(() => {
  const liveMap = new Map<string, LiveLocalModelInfo>(liveLocalModels.value.map((m) => [m.name, m]));
  return LOCAL_MODEL_SPECS.map((spec) => {
    const live = liveMap.get(spec.name);
    return {
      ...spec,
      liveChecked: Boolean(live),
      available: live ? live.available : null,
      loaded: live ? live.loaded : true,
      enabled: live ? live.enabled : true,
      inMemory: live ? live.in_memory : false,
      source: live?.source ?? 'builtin',
      externalLabel: live?.external_label ?? null,
      externalPath: live?.external_path ?? null,
      sizeMb: live ? live.size_mb : spec.sizeMb,
      paramsM: live ? live.params_m : spec.paramsM,
      dtypeLabel: live?.dtype_detail ?? spec.precision,
      loadMs: live?.load_ms ?? null,
      optionalFallbackHint: live?.optional_fallback_hint ?? '',
      contractSummary: live?.contract_summary ?? '',
    };
  });
});

const displayTotalParamsText = computed(() =>
  localModelsSummary.value.totalParamsM != null
    ? `${localModelsSummary.value.totalParamsM.toFixed(2)} M`
    : LOCAL_MODEL_TOTALS.totalParamsText,
);

const displayTotalSizeText = computed(() =>
  localModelsSummary.value.totalSizeMb != null
    ? `${localModelsSummary.value.totalSizeMb.toFixed(2)} MB`
    : LOCAL_MODEL_TOTALS.totalSizeText,
);


const skins = computed(() => {
  void store.customSkinCounter.value;
  return listSkins();
});
const backdrops = listBackdrops();
const backgroundInput = ref<HTMLInputElement | null>(null);
const iconInput = ref<HTMLInputElement | null>(null);
const savingBackground = ref(false);
const savingIcon = ref(false);

async function uploadAppearanceImage(event: Event, kind: 'background' | 'icon'): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const pending = kind === 'background' ? savingBackground : savingIcon;
  pending.value = true;
  try {
    if (kind === 'background') await addWorkspaceBackground(file);
    else await uploadWorkspaceIcon(file);
  } catch (error) {
    store.pushToast(error instanceof Error ? error.message : '图片保存失败。', 'danger');
  } finally {
    pending.value = false;
  }
}

const chineseFontOptions: SelectOption[] = CHINESE_FONTS.map((f) => ({
  value: f.id,
  label: f.label,
}));

const latinFontOptions: SelectOption[] = LATIN_FONTS.map((f) => ({
  value: f.id,
  label: f.label,
}));

const FONT_SIZE_PRESETS = [
  { label: '紧凑 11', value: 11 },
  { label: '标准 12', value: 12 },
  { label: '舒适 13.5', value: 13.5 },
  { label: '大字 15', value: 15 },
] as const;

const fontSizeFill = computed(() => {
  const pct = ((store.interfaceFonts.value.fontSizePx - 11) / 5) * 100;
  return `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
});

const waveformModeOptions: SelectOption[] = [
  { value: 'theme', label: '跟随当前主题强调色' },
  { value: 'blue', label: '经典语音学蓝 (#2463eb)' },
  { value: 'custom', label: '自定义十六进制色' },
];

const tabs: ReadonlyArray<{ id: SettingViewTabId; artKey: string; name: string }> = [
  { id: 'appearance', artKey: 'appearance', name: '外观与排版' },
  { id: 'layout', artKey: 'layout', name: '布局与分栏' },
  { id: 'engine', artKey: 'engine', name: '声学引擎与模型' },
  { id: 'shortcuts', artKey: 'shortcuts', name: '快捷键' },
  { id: 'credits', artKey: 'credits', name: '引用与致谢' },
];

const splitterGroups = computed(() => {
  const hasExplore = Boolean(exploreLabel);
  return SPLITTER_GROUPS.map((group) => ({
    id: group.id,
    title: !hasExplore && group.publicTitle ? group.publicTitle : group.title,
    desc: !hasExplore && group.publicDesc ? group.publicDesc : group.desc,
    items: group.items.filter((item) => hasExplore || item.editionOnly !== 'explore'),
  })).filter((group) => group.items.length > 0);
});

const splitterDrafts = ref<Record<string, string>>({});

function syncSplitterDrafts(): void {
  const next: Record<string, string> = {};
  for (const grp of splitterGroups.value) {
    for (const item of grp.items) {
      next[item.storageKey] = String(getConfiguredSplitterDefault(item.storageKey, item.factoryDefault));
    }
  }
  splitterDrafts.value = next;
}

watch(
  [() => store.splitterLayoutVersion.value, activeTab],
  () => {
    syncSplitterDrafts();
  },
  { immediate: true },
);

function isSplitterModified(storageKey: string): boolean {
  void store.splitterLayoutVersion.value;
  return isSplitterCustomized(storageKey);
}

function isGroupModified(items: readonly SplitterSpec[]): boolean {
  void store.splitterLayoutVersion.value;
  return items.some((item) => isSplitterCustomized(item.storageKey));
}

function onSplitterDraftInput(storageKey: string, event: Event): void {
  const el = event.target as HTMLInputElement | null;
  if (!el) return;
  splitterDrafts.value = { ...splitterDrafts.value, [storageKey]: el.value };
}

function commitSplitterDefault(item: SplitterSpec): void {
  const raw = (splitterDrafts.value[item.storageKey] ?? '').trim();
  const parsed = raw === '' ? Number.NaN : Number(raw);
  const current = getConfiguredSplitterDefault(item.storageKey, item.factoryDefault);
  if (Number.isFinite(parsed) && Math.round(parsed) === current) {
    splitterDrafts.value = { ...splitterDrafts.value, [item.storageKey]: String(current) };
    return;
  }
  const res = store.setSplitterDefault(item.storageKey, parsed);
  if (!res.ok) {
    splitterDrafts.value = { ...splitterDrafts.value, [item.storageKey]: String(current) };
    return;
  }
  splitterDrafts.value = { ...splitterDrafts.value, [item.storageKey]: String(res.value) };
  store.pushToast(`已将「${item.label}」默认尺寸设为 ${res.value} ${item.unit}`, 'success', 1800);
}

function resetSplitterGroup(items: readonly SplitterSpec[], title: string): void {
  store.resetSplitterGroup(items.map((item) => item.storageKey), title);
}

const shortcutGroups = SHORTCUT_GROUPS;

const activeSpeaker = computed(
  () => store.project.value.voices[store.activeVoiceId.value]?.speaker ?? 'JD2',
);

const zoomPercent = computed(() => Math.round(store.pageScale.value * 100));

function ensureJd2Speaker(): void {
  if (activeSpeaker.value !== 'JD2') {
    store.executeCommand({
      type: 'project.set_speaker',
      label: '统一解剖几何为 JD2',
      payload: { speaker: 'JD2' },
    });
  }
}

function onToggleShowSplitters(e: Event): void {
  const checked = (e.target as HTMLInputElement).checked;
  store.showSplitters.value = checked;
  document.body.classList.toggle('hide-splitters', !checked);
}

function updateBackdropColor(idx: 0 | 1 | 2, hex: string): void {
  const next: [string, string, string] = [...store.backdropCustomColors.value];
  next[idx] = hex;
  store.setBackdropCustomColors(next);
}
</script>

<template>
  <div class="settings-view">
    <aside class="set-nav">
      <h2 class="settings-title">设置中心</h2>
      <button
        type="button"
        class="btn primary"
        style="margin-bottom: 8px; justify-content: flex-start"
        @click="store.closeOverlay()"
      >
        <IconSvg name="arrow-left" :size="13" />
        <span>返回工作台 (Esc)</span>
      </button>
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        class="btn nav-item"
        :aria-current="activeTab === tab.id ? 'page' : undefined"
        :class="{ active: activeTab === tab.id }"
        @click="selectTab(tab.id)"
      >
        <NavArtwork :item="tab.artKey" />
        <span>{{ tab.name }}</span>
      </button>

      <div style="margin-top: auto; padding-top: 10px; border-top: 1px solid var(--panel-border)">
        <button
          type="button"
          class="btn nav-item"
          :class="{ primary: hasUpdate }"
          style="width: 100%; justify-content: space-between"
          @click="openUpdateModal(true)"
        >
          <span style="display: inline-flex; align-items: center; gap: 8px">
            <IconSvg :name="hasUpdate ? 'sparkles' : 'download'" :size="14" />
            <span>{{ hasUpdate && latestRelease ? `发现新版本 v${latestRelease.version}` : '检查更新' }}</span>
          </span>
          <span class="mono muted" style="font-size: 0.78rem">v{{ APP_VERSION }}</span>
        </button>
      </div>
    </aside>

    <section class="set-content">
      <h2 class="section-heading">{{ tabs.find((t) => t.id === activeTab)?.name }}</h2>

      <!-- 1. APPEARANCE & TYPOGRAPHY -->
      <div v-if="activeTab === 'appearance'" class="set-full-pane appearance-pane">
        <div class="appearance-column">
          <div class="panel">
            <div class="p-head">
              <span>表面风格与字体排印</span>
              <button type="button" class="btn xs" @click="store.styleLabOpen.value = true">
                <IconSvg name="sliders" :size="11" />
                <span>打开风格实验室</span>
              </button>
            </div>
            <div class="p-body appearance-panel-body">
              <div class="style-cards">
                <button
                  v-for="skin in skins"
                  :key="skin.id"
                  type="button"
                  class="style-card"
                  :class="{
                    active: store.surfaceStyle.value === skin.id,
                    flagship: skin.id === 'neumorphism' || skin.id === 'minimal',
                  }"
                  :aria-pressed="store.surfaceStyle.value === skin.id"
                  @click="store.setSurfaceStyle(skin.id)"
                >
                  <span class="skin-preview" :data-preview="skin.id" aria-hidden="true">
                    <span class="preview-toolbar"><i></i><i></i><i></i><b></b></span>
                    <span class="preview-sidebar"><i></i><i></i><i></i></span>
                    <span class="preview-workspace">
                      <span class="preview-chart">
                        <svg viewBox="0 0 52 22" preserveAspectRatio="none" fill="none">
                          <path class="preview-chart-grid" d="M0 7h52M0 15h52M13 0v22M26 0v22M39 0v22" />
                          <path class="preview-chart-trace" d="M0 13 5 13 9 16 14 5 19 18 24 3 29 14 33 11 38 15 44 7 48 11 52 11" />
                        </svg>
                      </span>
                      <span class="preview-controls"><i></i><i></i><b></b></span>
                    </span>
                  </span>
                  <div class="skin-card-meta">
                    <div class="skin-card-title-row">
                      <strong>{{ skin.shortName }}</strong>
                    </div>
                    <span class="skin-card-desc muted">{{ skin.desc }}</span>
                  </div>
                </button>
              </div>

              <!-- Upgraded Font Selectors & Global Font Size Slider (T-34, T-35) -->
              <fieldset class="interface-fonts">
                <legend>界面字体与全局字号</legend>
                <div class="font-select-grid">
                  <div class="font-field">
                    <span class="font-lbl">中文字体（7 款）</span>
                    <CustomSelect
                      size="sm"
                      style="width: 100%"
                      aria-label="中文字体"
                      :min-menu-width="230"
                      :model-value="store.interfaceFonts.value.chinese"
                      :options="chineseFontOptions"
                      @update:model-value="(v) => store.setInterfaceFonts({ chinese: v as InterfaceFonts['chinese'] })"
                    />
                  </div>
                  <div class="font-field">
                    <span class="font-lbl">西文字体（7 款）</span>
                    <CustomSelect
                      size="sm"
                      style="width: 100%"
                      aria-label="西文字体"
                      :min-menu-width="230"
                      :disabled="store.interfaceFonts.value.unified"
                      :model-value="store.interfaceFonts.value.latin"
                      :options="latinFontOptions"
                      @update:model-value="(v) => store.setInterfaceFonts({ latin: v as InterfaceFonts['latin'] })"
                    />
                  </div>
                  <div class="font-field font-size-field">
                    <div class="font-size-top">
                      <span class="font-lbl">界面基准字号（11px – 16px）</span>
                      <span class="mono font-size-badge">{{ store.interfaceFonts.value.fontSizePx }} px</span>
                    </div>
                    <div class="font-size-bar">
                      <input
                        type="range"
                        min="11"
                        max="16"
                        step="0.5"
                        :value="store.interfaceFonts.value.fontSizePx"
                        :style="{ flex: '1', '--fill': fontSizeFill }"
                        aria-label="界面基准字号"
                        @input="store.setInterfaceFonts({ fontSizePx: Number(($event.target as HTMLInputElement).value) })"
                      />
                      <div class="seg">
                        <button
                          v-for="preset in FONT_SIZE_PRESETS"
                          :key="preset.value"
                          type="button"
                          :class="{ active: store.interfaceFonts.value.fontSizePx === preset.value }"
                          @click="store.setInterfaceFonts({ fontSizePx: preset.value })"
                        >
                          {{ preset.label }}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="font-bottom-row">
                  <label class="inline-ctrl">
                    <input
                      type="checkbox"
                      :checked="store.interfaceFonts.value.unified"
                      @change="store.setInterfaceFonts({ unified: ($event.target as HTMLInputElement).checked })"
                    />
                    <span>中西文共用所选中文字体栈</span>
                  </label>
                  <span class="font-specimen">
                    <span>北风与太阳</span> · <span>国际音标与声道动力学</span>
                    <span class="ipa">[pəi˨˩˦ fəŋ˥˥]</span>
                  </span>
                </div>
              </fieldset>
            </div>
          </div>

          <div class="panel">
            <div class="p-head"><span>声道解剖视口着色</span></div>
            <div class="p-body set-section-body" style="display: flex; flex-direction: column; gap: 10px">
              <div class="setting-row">
                <div>
                  <div class="setting-k">解剖模型配色方案</div>
                  <div class="setting-desc">同步作用于全站 2D 矢状面与 3D 空间声道视口</div>
                </div>
                <CustomSelect
                  aria-label="解剖模型配色"
                  size="sm"
                  style="width: 210px"
                  :model-value="store.anatomyAppearance.value.palette"
                  :options="ANATOMY_PALETTE_OPTIONS"
                  @update:model-value="(v) => store.setAnatomyAppearance({ palette: v as AnatomyPaletteId })"
                />
              </div>
              <div class="knob-grid">
                <CompactSlider label="二维头部组织不透明度" :model-value="store.anatomyAppearance.value.head2d" :min="0" :max="100" :step="1" :decimals="0" unit="%" :default-value="DEFAULT_ANATOMY_APPEARANCE.head2d" @update:model-value="(head2d) => store.setAnatomyAppearance({ head2d })" />
                <CompactSlider label="三维头部组织不透明度" :model-value="store.anatomyAppearance.value.head3d" :min="0" :max="100" :step="1" :decimals="0" unit="%" :default-value="DEFAULT_ANATOMY_APPEARANCE.head3d" @update:model-value="(head3d) => store.setAnatomyAppearance({ head3d })" />
              </div>
            </div>
          </div>
        </div>
        <div class="appearance-column">
          <div class="panel">
            <div class="p-head"><span>背景与材质</span></div>
            <div class="p-body appearance-panel-body">
              <div class="material-settings">
                <div class="material-field">
                  <div class="material-caption">
                    <div class="setting-k">背景样式</div>
                    <div class="setting-desc">工作区背景底纹</div>
                  </div>
                  <div class="material-picker" role="group" aria-label="背景样式">
                    <button
                      v-for="b in backdrops"
                      :key="b.id"
                      type="button"
                      :class="{ active: !activeWorkspaceBackground && store.backdropId.value === b.id }"
                      :aria-pressed="!activeWorkspaceBackground && store.backdropId.value === b.id"
                      @click="store.setBackdrop(b.id)"
                    >
                      <span class="material-surface" :data-material="b.id" aria-hidden="true"></span>{{ b.label }}
                    </button>
                    <button
                      v-for="image in workspaceBackgrounds"
                      :key="image.id"
                      type="button"
                      :class="{ active: activeWorkspaceBackground?.id === image.id }"
                      :aria-pressed="activeWorkspaceBackground?.id === image.id"
                      :title="image.name"
                      @click="selectWorkspaceBackground(image.id)"
                    >
                      <img class="background-thumb" :src="image.url" alt="" />
                      <span class="background-name">{{ image.name }}</span>
                    </button>
                    <button type="button" class="background-upload" :disabled="savingBackground" @click="backgroundInput?.click()">
                      {{ savingBackground ? '正在保存…' : '上传背景图' }}
                    </button>
                    <input ref="backgroundInput" type="file" accept="image/*" aria-label="选择背景图" hidden @change="uploadAppearanceImage($event, 'background')" />
                  </div>
                </div>

                <div class="material-field">
                  <div class="material-caption">
                    <div class="setting-k">应用图标</div>
                    <div class="setting-desc">窗口左上角和浏览器标签页</div>
                  </div>
                  <div class="material-controls" role="group" aria-label="应用图标">
                    <img class="application-icon-preview" :src="workspaceIconUrl" alt="当前应用图标" />
                    <button type="button" class="btn xs" :disabled="savingIcon" @click="iconInput?.click()">
                      {{ savingIcon ? '正在保存…' : '上传图标' }}
                    </button>
                    <button v-if="savedWorkspaceIcon" type="button" class="btn xs" @click="setCustomWorkspaceIconEnabled(!activeWorkspaceIcon)">
                      {{ activeWorkspaceIcon ? '使用默认图标' : '使用已上传图标' }}
                    </button>
                    <button type="button" class="btn xs" @click="openStartupSplashPreview()">
                      预览启动界面
                    </button>
                    <input ref="iconInput" type="file" accept="image/*,.ico" aria-label="选择图标图片" hidden @change="uploadAppearanceImage($event, 'icon')" />
                  </div>
                </div>

                <div class="material-field material-colors">
                  <div class="material-caption">
                    <div class="setting-k">材质配色</div>
                    <div class="setting-desc">三通道叠印光色</div>
                  </div>
                  <div class="material-controls">
                    <div class="material-swatches" role="group" aria-label="材质颜色">
                      <input
                        v-for="idx in ([0, 1, 2] as const)"
                        :key="idx"
                        type="color"
                        :value="store.backdropCustomColors.value[idx]"
                        :aria-label="'光色 ' + (idx + 1)"
                        :title="'光色 ' + (idx + 1)"
                        @input="updateBackdropColor(idx, ($event.target as HTMLInputElement).value)"
                      />
                    </div>
                    <div class="material-schemes" role="group" aria-label="材质配色方案">
                      <button
                        v-for="preset in BACKDROP_COLOR_PRESETS"
                        :key="preset.id"
                        type="button"
                        class="btn xs"
                        :class="{ active: store.backdropColorScheme.value === preset.id }"
                        :aria-pressed="store.backdropColorScheme.value === preset.id"
                        @click="store.setBackdropColorScheme(preset.id)"
                      >
                        {{ preset.label }}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div class="knob-grid">
                <CompactSlider label="背景色彩饱和度" :model-value="store.bgSat.value" :min="20" :max="200" :step="5" :decimals="0" unit="%" :default-value="128" @update:model-value="store.setBgSat" />
                <CompactSlider label="叠色浓度" :model-value="store.bgCov.value" :min="0.4" :max="1.9" :step="0.05" :decimals="2" unit="×" :default-value="1.18" @update:model-value="store.setBgCov" />
                <CompactSlider label="卡片与控件不透明度" :model-value="store.cardAlpha.value" :min="15" :max="100" :step="1" :decimals="0" unit="%" :default-value="64" @update:model-value="store.setCardAlpha" />
                <CompactSlider label="面板底色不透明度" :model-value="store.glassAlpha.value" :min="32" :max="96" :step="2" :decimals="0" unit="%" :default-value="66" @update:model-value="store.setGlassAlpha" />
                <CompactSlider label="毛玻璃模糊半径" :model-value="store.glassBlur.value" :min="0" :max="22" :step="1" :decimals="0" unit="px" :default-value="7" @update:model-value="store.setGlassBlur" />
              </div>
            </div>
          </div>

          <div class="panel">
            <div class="p-head">
              <span>30 套 WCAG 校验主题色板</span>
              <span class="mono muted" style="font-size: 0.875rem">{{ paletteDisplayName(store.paletteId.value) }}</span>
            </div>
            <div class="p-body" style="padding: 12px">
              <div class="theme-ctrl-bar">
                <div class="seg">
                  <button type="button" :class="{ active: store.themeMode.value === 'light' }" @click="store.setThemeMode('light', $event)">日间浅色</button>
                  <button type="button" :class="{ active: store.themeMode.value === 'dark' }" @click="store.setThemeMode('dark', $event)">夜间深色</button>
                  <button type="button" :class="{ active: store.themeMode.value === 'system' }" @click="store.setThemeMode('system', $event)">跟随系统</button>
                </div>
                <label class="inline-ctrl">
                  <span>自定义主色</span>
                  <input type="color" :value="store.customAccentHex.value" @input="store.setCustomAccent(($event.target as HTMLInputElement).value)" />
                </label>
                <label class="inline-ctrl">
                  <span>波形着色</span>
                  <CustomSelect
                    size="sm"
                    style="width: 164px"
                    :model-value="store.waveformColorMode.value"
                    :options="waveformModeOptions"
                    @update:model-value="(v) => store.setWaveformAppearance(v as 'theme' | 'blue' | 'custom')"
                  />
                </label>
                <label class="inline-ctrl">
                  <span>全局缩放</span>
                  <input
                    type="range"
                    min="70"
                    max="130"
                    step="2"
                    :value="zoomPercent"
                    :style="{ width: '104px', '--fill': `${((zoomPercent - 70) / 60) * 100}%` }"
                    @input="store.setPageScale(Number(($event.target as HTMLInputElement).value) / 100, true)"
                  />
                  <span class="mono" style="min-width: 38px">{{ zoomPercent }}%</span>
                  <button type="button" class="btn xs" :class="{ active: store.autoPageScale.value }" @click="store.resetAutoPageScale()">自动</button>
                </label>
              </div>

              <div class="palette-grid">
                <button
                  v-for="pal in palettes"
                  :key="pal.id"
                  type="button"
                  class="pal-card"
                  :class="{ active: store.paletteId.value === pal.id }"
                  :title="paletteDisplayName(pal.id)"
                  @click="store.setPalette(pal.id)"
                >
                  <span class="pal-name-txt">{{ paletteDisplayName(pal.id).split(' · ')[0] }}</span>
                  <span class="swatches">
                    <i :style="{ background: pal[store.resolvedColorMode.value][0] }" />
                    <i :style="{ background: pal[store.resolvedColorMode.value][1] }" />
                    <i :style="{ background: pal[store.resolvedColorMode.value][2] }" />
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. LAYOUT & SPLITTERS (T-36) -->
      <div v-else-if="activeTab === 'layout'" class="set-full-pane">
        <div class="panel">
          <div class="p-head">
            <span>工作区密度、默认视口与抽屉停靠偏好</span>
            <span class="mono muted" style="font-size: 0.875rem">2560 × 1600 桌面基准 · ≥16:10 完整适配</span>
          </div>
          <div class="p-body" style="padding: 12px">
            <div class="settings-grid-2">
              <div class="setting-row">
                <div>
                  <div class="setting-k">工作区信息密度档位</div>
                  <div class="setting-desc">调节外框留白、面板间距与标题栏高度</div>
                </div>
                <div class="seg">
                  <button
                    type="button"
                    :class="{ active: store.layoutDensity.value === 'compact' }"
                    @click="store.setLayoutPrefs({ density: 'compact' as LayoutDensity })"
                  >
                    紧凑
                  </button>
                  <button
                    type="button"
                    :class="{ active: store.layoutDensity.value === 'standard' }"
                    @click="store.setLayoutPrefs({ density: 'standard' as LayoutDensity })"
                  >
                    标准
                  </button>
                  <button
                    type="button"
                    :class="{ active: store.layoutDensity.value === 'spacious' }"
                    @click="store.setLayoutPrefs({ density: 'spacious' as LayoutDensity })"
                  >
                    舒展
                  </button>
                </div>
              </div>

              <div class="setting-row">
                <div>
                  <div class="setting-k">声道视口默认几何模式</div>
                  <div class="setting-desc">新建或首次进入声道视口时的初始渲染维度</div>
                </div>
                <div class="seg">
                  <button
                    type="button"
                    :class="{ active: store.defaultTractViewMode.value === '2d' }"
                    @click="store.setLayoutPrefs({ tractViewMode: '2d' })"
                  >
                    2D 矢状面
                  </button>
                  <button
                    type="button"
                    :class="{ active: store.defaultTractViewMode.value === '3d' }"
                    @click="store.setLayoutPrefs({ tractViewMode: '3d' })"
                  >
                    3D 空间模型
                  </button>
                </div>
              </div>

              <div class="setting-row">
                <div>
                  <div class="setting-k">时间轴轨道高度预设</div>
                  <div class="setting-desc">标注时间轴与剪辑多轨行高基准比例</div>
                </div>
                <div class="seg">
                  <button
                    type="button"
                    :class="{ active: store.timelineTrackScale.value === 'compact' }"
                    @click="store.setLayoutPrefs({ trackScale: 'compact' as TimelineTrackScale })"
                  >
                    紧凑
                  </button>
                  <button
                    type="button"
                    :class="{ active: store.timelineTrackScale.value === 'standard' }"
                    @click="store.setLayoutPrefs({ trackScale: 'standard' as TimelineTrackScale })"
                  >
                    标准
                  </button>
                  <button
                    type="button"
                    :class="{ active: store.timelineTrackScale.value === 'tall' }"
                    @click="store.setLayoutPrefs({ trackScale: 'tall' as TimelineTrackScale })"
                  >
                    加高
                  </button>
                </div>
              </div>

              <div class="setting-row">
                <div>
                  <div class="setting-k">工作台导航栏位置</div>
                  <div class="setting-desc">左侧竖排为默认布局；切换至顶部后按一行排开，下方工作区占满全宽</div>
                </div>
                <div class="seg">
                  <button
                    type="button"
                    :class="{ active: store.navPlacement.value === 'left' }"
                    @click="store.setLayoutPrefs({ navPlacement: 'left' as NavPlacement })"
                  >
                    左侧
                  </button>
                  <button
                    type="button"
                    :class="{ active: store.navPlacement.value === 'top' }"
                    @click="store.setLayoutPrefs({ navPlacement: 'top' as NavPlacement })"
                  >
                    顶部
                  </button>
                </div>
              </div>

              <div class="setting-row">
                <div>
                  <div class="setting-k">AI 助手抽屉停靠模式</div>
                  <div class="setting-desc">并列挤压保留双栏视野；悬浮覆盖不改变主画布列宽</div>
                </div>
                <div class="seg">
                  <button
                    type="button"
                    :class="{ active: store.aiDrawerDockMode.value === 'docked' }"
                    @click="store.setLayoutPrefs({ aiDockMode: 'docked' as AiDrawerDockMode })"
                  >
                    并列挤压
                  </button>
                  <button
                    type="button"
                    :class="{ active: store.aiDrawerDockMode.value === 'overlay' }"
                    @click="store.setLayoutPrefs({ aiDockMode: 'overlay' as AiDrawerDockMode })"
                  >
                    悬浮覆盖
                  </button>
                </div>
              </div>

              <div class="setting-row">
                <div>
                  <div class="setting-k">分栏拖拽手柄引导线</div>
                  <div class="setting-desc">悬停可拖拽边界时高亮强调色导轨（双击任意分隔条可就地复位）</div>
                </div>
                <label class="inline-ctrl">
                  <input type="checkbox" :checked="store.showSplitters.value" @change="onToggleShowSplitters" />
                  <span>显示引导槽</span>
                </label>
              </div>

              <div class="setting-row">
                <div>
                  <div class="setting-k">显示器自适应缩放</div>
                  <div class="setting-desc">按屏幕物理分辨率计算工作台基准比例</div>
                </div>
                <div style="display: flex; align-items: center; gap: 6px">
                  <span class="mono">{{ zoomPercent }}% ({{ store.autoPageScale.value ? '自动' : '手动' }})</span>
                  <button type="button" class="btn sm" @click="store.resetAutoPageScale()">恢复自动</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="p-head">
            <span>各工作台分栏默认尺寸与复位</span>
            <button type="button" class="btn primary xs" @click="store.resetAllSplitters()">
              <IconSvg name="refresh" :size="11" />
              <span>全部恢复出厂默认</span>
            </button>
          </div>
          <div class="p-body" style="padding: 12px; display: flex; flex-direction: column; gap: 10px">
            <div class="setting-desc">
              设定各工作台每次启动时的固定默认宽度或占比。工作区内手动拖拽仅在当前会话生效，双击分隔条即可回到你设定的默认值。
            </div>
            <div class="settings-grid-2">
              <div v-for="grp in splitterGroups" :key="grp.id" class="editorial-card splitter-group-card">
                <div class="splitter-grp-head">
                  <div>
                    <strong style="font-size: 1rem">{{ grp.title }}</strong>
                    <div class="setting-desc">{{ grp.desc }}</div>
                  </div>
                  <button
                    type="button"
                    class="btn xs"
                    :disabled="!isGroupModified(grp.items)"
                    @click="resetSplitterGroup(grp.items, grp.title)"
                  >
                    恢复本组
                  </button>
                </div>
                <div class="splitter-item-list">
                  <div v-for="item in grp.items" :key="item.storageKey" class="splitter-item-row">
                    <div class="splitter-item-label">
                      <span>{{ item.label }}</span>
                      <span class="splitter-item-meta mono">
                        出厂 {{ item.factoryDefault }}{{ item.unit }} · {{ item.min }}–{{ item.max }}
                      </span>
                    </div>
                    <div class="splitter-item-ctrl">
                      <div class="splitter-input-wrap">
                        <input
                          type="number"
                          class="inp splitter-num-inp mono"
                          :min="item.min"
                          :max="item.max"
                          :step="item.unit === '%' ? 1 : 4"
                          :value="splitterDrafts[item.storageKey] ?? String(item.factoryDefault)"
                          :aria-label="`${item.label} 默认值（${item.unit}）`"
                          @input="onSplitterDraftInput(item.storageKey, $event)"
                          @change="commitSplitterDefault(item)"
                          @blur="commitSplitterDefault(item)"
                          @keydown.enter.prevent="commitSplitterDefault(item)"
                        />
                        <span class="splitter-unit mono">{{ item.unit }}</span>
                      </div>
                      <button
                        type="button"
                        class="btn xs"
                        :disabled="!isSplitterModified(item.storageKey)"
                        :title="isSplitterModified(item.storageKey) ? `恢复出厂默认 ${item.factoryDefault}${item.unit}` : '已为出厂默认'"
                        @click="store.resetSingleSplitter(item.storageKey)"
                      >
                        复位
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="p-head">
            <span>首次进入操作指引（聚光灯引导）</span>
            <div style="display: inline-flex; align-items: center; gap: 8px">
              <span class="mono muted" style="font-size: 0.875rem">
                已引导 {{ onboarding.completedCount.value }} / {{ onboarding.availableTours.value.length }} 页
              </span>
              <button type="button" class="btn xs" @click="onResetAllOnboarding">
                <IconSvg name="refresh" :size="11" />
                <span>重置全部指引</span>
              </button>
            </div>
          </div>
          <div class="p-body" style="padding: 12px; display: flex; flex-direction: column; gap: 10px">
            <div class="setting-row">
              <div>
                <div class="setting-k">首次进入工作区时自动显示聚光灯指引</div>
                <div class="setting-desc">
                  每个模块仅在初次访问时高亮讲解核心操作区，完成后自动记忆；也可随时在下方点击任意模块立即重播。
                </div>
              </div>
              <label class="inline-ctrl">
                <input
                  type="checkbox"
                  :checked="onboarding.autoEnabled.value"
                  @change="onToggleAutoOnboarding"
                />
                <span>{{ onboarding.autoEnabled.value ? '已开启' : '已关闭' }}</span>
              </label>
            </div>

            <div class="onboarding-tour-grid">
              <div
                v-for="tour in onboarding.availableTours.value"
                :key="tour.pageId"
                class="editorial-card onboarding-tour-card"
              >
                <div class="onboarding-tour-head">
                  <div class="onboarding-tour-title">
                    <IconSvg :name="tour.icon" :size="14" />
                    <strong>{{ tour.title }}</strong>
                  </div>
                  <span
                    class="model-status-pill"
                    :class="onboarding.completedPages.value[tour.pageId] ? 'ok' : 'neutral'"
                  >
                    {{ onboarding.completedPages.value[tour.pageId] ? '已引导' : '待引导' }}
                  </span>
                </div>
                <div class="setting-desc">{{ tour.shortDesc }}</div>
                <div class="onboarding-tour-actions">
                  <span class="mono muted" style="font-size: 0.8rem">{{ tour.steps.length }} 步指引</span>
                  <div style="display: inline-flex; align-items: center; gap: 6px">
                    <button
                      v-if="onboarding.completedPages.value[tour.pageId]"
                      type="button"
                      class="btn xs"
                      @click="onboarding.resetPage(tour.pageId)"
                    >
                      重置
                    </button>
                    <button
                      type="button"
                      class="btn xs primary"
                      @click="onboarding.openTourAndNavigate(store, tour.pageId)"
                    >
                      <IconSvg name="compass" :size="11" />
                      <span>立即重播</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 3. SHORTCUTS -->
      <div v-else-if="activeTab === 'shortcuts'" class="set-full-pane">
        <div class="shortcut-groups">
          <article v-for="group in shortcutGroups" :key="group.title" class="panel">
            <h3 class="p-head">{{ group.title }}</h3>
            <div v-for="row in group.rows" :key="row[0]" class="shortcut-line">
              <span>{{ row[0] }}</span>
              <span><kbd v-for="key in row[1].split(' + ')" :key="key">{{ key }}</kbd></span>
            </div>
          </article>
        </div>
      </div>

      <!-- 4. ACOUSTIC ENGINE & LOCAL MODELS (T-38) -->
      <div v-else-if="activeTab === 'engine'" class="set-full-pane">
        <PortableCachePanel />
        <div class="panel">
          <div class="p-head">
            <span>声学求解内核、默认合成声源与参考声纹</span>
            <button type="button" class="btn xs" @click="store.probeEngine()">
              <IconSvg name="refresh" :size="11" />
              <span>刷新引擎连接</span>
            </button>
          </div>
          <div class="p-body" style="padding: 12px; display: flex; flex-direction: column; gap: 12px">
            <div class="settings-grid-2">
              <div class="setting-row">
                <div>
                  <div class="setting-k">统一声道三维解剖几何基准</div>
                  <div class="setting-desc">全站物理求解与神经构音空间统一锚定成年男声 65 截面模型</div>
                </div>
                <div style="display: flex; align-items: center; gap: 6px">
                  <span class="metric-chip mono" style="color: var(--accent); font-weight: 600">
                    JD2 · 成年男声 3D 几何模型
                  </span>
                  <button v-if="activeSpeaker !== 'JD2'" type="button" class="btn xs primary" @click="ensureJd2Speaker">
                    切回 JD2
                  </button>
                </div>
              </div>

              <div class="setting-row">
                <div>
                  <div class="setting-k">默认合成声源模型</div>
                  <div class="setting-desc">与声道标注页顶栏实时双向同步，适用于新建与重合成片段</div>
                </div>
                <VoiceRenderSelect size="sm" wide />
              </div>

              <div class="setting-row">
                <div>
                  <div class="setting-k">音标转声道</div>
                  <div class="setting-desc">指定语音合成编译入轨时使用的 IPA 构型来源</div>
                </div>
                <CustomSelect v-model="textPoseSource" :options="textPoseOptions" size="sm" style="width: 224px"
                  aria-label="音标转声道构型来源" />
              </div>

              <div class="setting-row">
                <div>
                  <div class="setting-k">播放与导出音量</div>
                  <div class="setting-desc">整段合成按同一倍率放缩至约 0.8 峰值。实时重建的合成音量随近期有效电平缓慢调整，试听与保存的合成音频使用相同增益。</div>
                </div>
                <CustomSelect v-model="synthesisGainMode" aria-label="播放与导出音量" size="sm" style="width: 224px"
                  :options="[{ value: 'peak', label: '自动增益' }, { value: 'original', label: '原始电平' }]" />
              </div>

              <div class="setting-row">
                <div>
                  <div class="setting-k">推理计算设备</div>
                  <div class="setting-desc">全链路已锁定纯 ONNX Runtime 本地 CPU 自适应多线程推理（长音频自动分段缓存与流式先播）</div>
                </div>
                <span
                  class="tree-tag mono"
                  style="padding: 5px 10px; opacity: 0.9; cursor: not-allowed; user-select: none"
                  title="后端接口保持完整兼容，前端推理设备当前固定为本地 CPU"
                >
                  {{
                    localModelsSummary.online && localModelsSummary.adaptiveThreadsHeavy
                      ? `本地 CPU · ${localModelsSummary.adaptiveThreadsHeavy} 线程${localModelsSummary.parallelChunkWorkers && localModelsSummary.parallelChunkWorkers > 1 ? ` / ${localModelsSummary.parallelChunkWorkers} 路并行` : ''}（已锁定）`
                      : '本地 CPU · 自适应多线程（已锁定）'
                  }}
                </span>
              </div>

              <div class="setting-row">
                <div>
                  <div class="setting-k">VTL 2.4 物理求解器状态</div>
                  <div class="setting-desc">65 截面管段声学求解 · 48,000 Hz 整数采样</div>
                </div>
                <span
                  class="mono"
                  :style="{
                    color: store.engineStatus.value === 'prewarm-fallback' ? 'var(--warning)' : 'var(--success)',
                    fontWeight: 600,
                  }"
                >
                  {{
                    store.engineStatus.value === 'python-vtl'
                      ? '本地 Python VTL 2.4 已连接'
                      : store.engineStatus.value === 'wasm-vtl'
                        ? '浏览器 WASM 已就绪'
                        : '离线 / 预渲染参考模式'
                  }}
                </span>
              </div>
            </div>

            <div class="editorial-card spk-ref-card">
              <div>
                <div class="setting-k">神经合成参考音色</div>
                <div class="setting-desc">上传 2–15 秒清晰单人 WAV，经 Vox2Spk-Lite 提取声纹后用于 Tract2Vox-Lite 神经合成。默认声纹来自《PhoneticToolbox 教程【16 音系归纳篇】》。</div>
              </div>
              <SpeakerReferenceControls />
            </div>
          </div>
        </div>

        <!-- Complete 9 Local ONNX Models Hot-Plug & External Mount Matrix -->
        <div class="panel">
          <div class="p-head model-matrix-head">
            <span>本地轻量化模型矩阵（9 项 ONNX 热插拔）</span>
            <div class="model-matrix-toolbar">
              <span class="mono muted" style="font-size: 0.85rem">{{ modelMessage }}</span>
              <button
                type="button"
                class="btn xs"
                :class="{ active: folderPanelOpen }"
                :disabled="!localModelsSummary.online"
                @click="folderPanelOpen = !folderPanelOpen"
              >
                <IconSvg name="folder-open" :size="11" />
                <span>从文件夹装载</span>
              </button>
              <button
                type="button"
                class="btn xs"
                :disabled="batchModelBusy || !localModelsSummary.online"
                @click="onLoadAllModels"
              >
                <span>全部装载</span>
              </button>
              <button
                type="button"
                class="btn xs"
                :disabled="batchModelBusy || !localModelsSummary.online"
                @click="onUnloadAllModels"
              >
                <span>全部卸载</span>
              </button>
              <button type="button" class="btn xs" :disabled="checkingModels" @click="checkLocalModels">
                <IconSvg name="refresh" :size="11" />
                <span>核验权重</span>
              </button>
            </div>
          </div>
          <div class="p-body" style="padding: 12px; display: flex; flex-direction: column; gap: 10px">
            <input
              ref="singleOnnxInputRef"
              type="file"
              accept=".onnx"
              hidden
              @change="onSingleOnnxPicked"
            />
            <input
              ref="folderOnnxInputRef"
              type="file"
              webkitdirectory
              directory
              multiple
              hidden
              @change="onBrowserFolderPicked"
            />

            <!-- External Folder Mount Drawer -->
            <div v-if="folderPanelOpen" class="editorial-card model-folder-drawer">
              <div class="model-folder-row">
                <input
                  v-model="externalFolderInput"
                  type="text"
                  class="model-folder-input mono"
                  placeholder="输入外部 ONNX 模型目录路径（例如 D:\models\custom-onnx），自动按契约匹配 9 个槽位"
                  :disabled="mountingFolder"
                  @keydown.enter="onMountExternalFolderByPath"
                />
                <button
                  type="button"
                  class="btn sm primary"
                  :disabled="mountingFolder || !externalFolderInput.trim()"
                  @click="onMountExternalFolderByPath"
                >
                  <IconSvg name="folder" :size="13" />
                  <span>{{ mountingFolder ? '扫描挂载中…' : '扫描路径并装载' }}</span>
                </button>
                <button
                  type="button"
                  class="btn sm"
                  :disabled="mountingFolder"
                  @click="folderOnnxInputRef?.click()"
                >
                  <IconSvg name="upload" :size="13" />
                  <span>选择本地文件夹</span>
                </button>
                <button
                  v-if="localModelsSummary.externalCount > 0"
                  type="button"
                  class="btn sm"
                  :disabled="batchModelBusy || mountingFolder"
                  @click="onResetAllModels"
                >
                  <IconSvg name="undo" :size="12" />
                  <span>全部恢复内置</span>
                </button>
              </div>
              <div class="muted" style="font-size: 0.85rem">
                支持装载他人训练并导出的标准 ONNX 权重：自动校验输入输出张量名与维度契约，不匹配时拒绝装载并保留当前可用模型。
              </div>
            </div>

            <div class="model-spec-grid">
              <div
                v-for="m in mergedModelCards"
                :key="m.name"
                class="editorial-card model-spec-card"
                :class="{
                  'is-loaded': m.loaded && m.available !== false,
                  'is-unloaded': !m.loaded,
                  'is-external': m.source === 'external',
                  'is-busy': busyModelName === m.name,
                }"
                role="button"
                tabindex="0"
                :aria-pressed="m.loaded"
                :title="m.loaded ? `点击卸载 ${m.name}` : `点击装载 ${m.name}`"
                @click="toggleModelHotPlug(m)"
                @keydown.enter.prevent="toggleModelHotPlug(m)"
                @keydown.space.prevent="toggleModelHotPlug(m)"
              >
                <div class="model-spec-head">
                  <div class="model-spec-title-wrap">
                    <strong class="mono model-spec-name">{{ m.name }}</strong>
                    <span v-if="m.source === 'external'" class="model-ext-tag mono" :title="m.externalPath || m.externalLabel || ''">外置</span>
                  </div>
                  <span
                    class="model-status-pill mono"
                    :class="
                      busyModelName === m.name
                        ? 'neutral'
                        : m.available === false
                          ? 'warn'
                          : m.loaded
                            ? 'ok'
                            : 'muted-pill'
                    "
                  >
                    {{
                      busyModelName === m.name
                        ? '切换中…'
                        : m.available === false
                          ? '缺少权重'
                          : m.loaded
                            ? (m.inMemory ? '已装载 · 内存中' : '已装载')
                            : '未装载'
                    }}
                  </span>
                </div>
                <div class="mono model-spec-nums">
                  <span>{{ m.paramsM.toFixed(2) }} M</span>
                  <span>·</span>
                  <span>{{ m.sizeMb.toFixed(2) }} MB</span>
                  <span>·</span>
                  <span>{{ m.dtypeLabel }}</span>
                  <span v-if="m.loadMs != null && m.inMemory" class="muted" style="font-weight: 400">· {{ m.loadMs }} ms</span>
                </div>
                <div class="muted model-spec-role">
                  {{ !m.loaded && m.optionalFallbackHint ? m.optionalFallbackHint : m.role }}
                </div>
                <div v-if="m.source === 'external' && m.externalLabel" class="mono model-ext-file" :title="m.externalPath || m.externalLabel">
                  外部权重：{{ m.externalLabel }}
                </div>
                <div class="model-card-actions" @click.stop>
                  <button
                    type="button"
                    class="btn xs"
                    :class="m.loaded ? '' : 'primary'"
                    :disabled="busyModelName === m.name || batchModelBusy || !localModelsSummary.online"
                    @click="toggleModelHotPlug(m)"
                  >
                    <span>{{ m.loaded ? '卸载' : '装载' }}</span>
                  </button>
                  <button
                    type="button"
                    class="btn xs"
                    :disabled="busyModelName === m.name || batchModelBusy || !localModelsSummary.online"
                    @click="triggerSingleModelMount(m.name)"
                  >
                    <IconSvg name="file" :size="11" />
                    <span>换模</span>
                  </button>
                  <button
                    v-if="m.source === 'external'"
                    type="button"
                    class="btn xs"
                    :disabled="busyModelName === m.name || batchModelBusy"
                    @click="onResetSingleModel(m.name)"
                  >
                    <span>恢复内置</span>
                  </button>
                </div>
              </div>
            </div>

            <div class="model-total-bar">
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                <IconSvg name="cpu" :size="15" />
                <strong>本地 ONNX 模型包汇总（共 {{ LOCAL_MODEL_TOTALS.count }} 个模型）</strong>
                <span class="muted">全链路纯 ONNX Runtime 离线推理 · 零 PyTorch 运行时依赖 · 点击卡片即可热插拔</span>
              </div>
              <span class="mono model-total-Readout">
                {{ displayTotalParamsText }} 参数 · {{ displayTotalSizeText }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="activeTab === 'credits'" class="set-full-pane">
        <div class="panel">
          <div class="p-head">
            <span>{{ APP_BRAND_NAME }} · 上游开源软件、模型与字体许可</span>
            <span class="mono muted" style="font-size: 0.833333rem">GPL-3.0-or-later</span>
          </div>
          <div class="p-body" style="padding: 12px; display: flex; flex-direction: column; gap: 10px">
            <div class="settings-grid-2">
              <div class="setting-row">
                <div>
                  <div class="setting-k">VocalTractLab 2.4 &amp; VoxFigura Core</div>
                  <div class="setting-desc">三维声道构音物理模型、65 截面面积函数与本地轻量化声道—声码器模型群</div>
                </div>
                <span class="mono">GPL-3.0</span>
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-k">PhoneticToolbox v3</div>
                  <div class="setting-desc">零耦合 2D/3D 声道可视化组件、国际音标表 Plus (655 入口) 与多语注音方案</div>
                </div>
                <span class="mono">GPL-3.0</span>
              </div>
              <div class="setting-row">
                <div>
                  <div class="setting-k">PTBIPAPlus / Doulos SIL / Inter / JetBrains Mono / CMUdict</div>
                  <div class="setting-desc">随包专业国际音标字体、现代界面与等宽数字字体及英语发音词典</div>
                </div>
                <span class="mono">OFL / BSD</span>
              </div>
            </div>

            <div style="display: flex; gap: 8px; flex-wrap: wrap">
              <button type="button" class="btn primary sm" @click="store.openOverlay('model-report')">
                <IconSvg name="cpu" :size="13" />
                <span>查看模型训练与技术报告</span>
              </button>
              <button type="button" class="btn sm" @click="store.openOverlay('guide')">
                <IconSvg name="book" :size="13" />
                <span>打开软件使用说明</span>
              </button>
            </div>
          </div>
        </div>
        <ReferencesModal inline />
      </div>
    </section>
  </div>
</template>

<style scoped>
.interface-fonts {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--panel-border);
  border-radius: var(--r-panel);
  background: color-mix(in srgb, var(--app) 54%, transparent);
  min-width: 0;
}

.interface-fonts legend {
  padding: 0 6px;
  font-weight: 600;
  font-size: 0.958333rem;
}

.font-select-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  align-items: end;
}

.font-size-field {
  grid-column: 1 / -1;
}

.font-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.font-lbl {
  font-size: 0.916667rem;
  color: var(--muted);
  font-weight: 500;
}

.font-size-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.font-size-badge {
  font-size: 0.916667rem;
  font-weight: 700;
  color: var(--accent);
}

.font-size-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.font-size-bar input[type="range"] {
  min-width: 100px;
}

.font-bottom-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, var(--panel-border) 60%, transparent);
}

.font-specimen {
  font-size: 1.08em;
  padding: 4px 10px;
  border-radius: var(--r-ctrl);
  background: var(--ctrl-bg);
  border: 1px solid var(--panel-border);
}

.section-heading {
  max-width: 1450px;
  margin: 2px auto 14px;
  font-size: 1.416667rem;
  font-weight: 650;
}

.nav-item {
  justify-content: flex-start;
  gap: 10px;
  min-height: 33px;
}

.style-card {
  position: relative;
  flex-direction: row;
  align-items: center;
  gap: 12px;
  min-height: 74px;
}

.style-card.flagship {
  border-color: color-mix(in srgb, var(--accent) 34%, var(--panel-border));
}

.skin-card-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.skin-card-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 1rem;
}

.skin-card-desc {
  font-size: 0.875rem;
  line-height: 1.35;
}

.skin-preview {
  --preview-frame: #d3dfe8;
  --preview-panel: #eaf1f7;
  --preview-toolbar: #e5eff7;
  --preview-border: #8ca5b8;
  --preview-ink: #516d84;
  --preview-accent: #236499;
  --preview-secondary: #a3bfd6;
  --preview-radius: 4px;
  --preview-depth: inset 0 1px 1px #fff, 0 1px 2px #122d5033;
  overflow: hidden;
  width: 88px;
  height: 52px;
  border: 1px solid var(--preview-border);
  border-radius: calc(var(--preview-radius) + 2px);
  background: var(--preview-frame);
  box-shadow: var(--preview-depth);
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  grid-template-rows: 9px minmax(0, 1fr);
  gap: 3px;
  padding: 4px;
  box-sizing: border-box;
  flex: none;
}
.preview-toolbar,
.preview-sidebar,
.preview-chart {
  border: 1px solid var(--preview-border);
  border-radius: var(--preview-radius);
  background: var(--preview-panel);
}
.preview-toolbar {
  grid-column: span 2;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 4px;
  background: var(--preview-toolbar);
}
.preview-toolbar i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--preview-ink);
}
.preview-toolbar b,
.preview-controls b {
  margin-left: auto;
  width: 12px;
  height: 4px;
  border-radius: var(--preview-radius);
  background: var(--preview-accent);
}
.preview-sidebar {
  display: grid;
  align-content: space-evenly;
  justify-items: center;
}
.preview-sidebar i {
  width: 7px;
  height: 3px;
  border-radius: var(--preview-radius);
  background: var(--preview-secondary);
}
.preview-sidebar i:first-child {
  background: var(--preview-accent);
}
.preview-workspace {
  display: grid;
  grid-template-rows: minmax(0, 1fr) 6px;
  gap: 3px;
}
.preview-chart {
  overflow: hidden;
  padding: 2px 3px;
}
.preview-chart svg {
  display: block;
  width: 100%;
  height: 100%;
}
.preview-chart-grid {
  stroke: var(--preview-ink);
  stroke-width: 0.6;
  opacity: 0.28;
}
.preview-chart-trace {
  stroke: var(--preview-accent);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.preview-controls {
  display: flex;
  align-items: center;
  gap: 3px;
}
.preview-controls i {
  width: 12px;
  height: 4px;
  border-radius: var(--preview-radius);
  background: var(--preview-secondary);
}

[data-preview="clay"] {
  --preview-frame: #dccaea;
  --preview-panel: #fae2d5;
  --preview-toolbar: #eadcf4;
  --preview-border: #b696c8;
  --preview-ink: #6a4a85;
  --preview-accent: #70499b;
  --preview-secondary: #bc8fae;
  --preview-radius: 8px;
  --preview-depth: inset 1px 1px 2px #fff9, inset -2px -2px 4px #78539470, 0 2px 2px #2b183e40;
}
[data-preview="glass"] {
  --preview-frame: linear-gradient(135deg, #e5f9f5, #91c5c9 48%, #407c8d);
  --preview-panel: #e4faf3c9;
  --preview-toolbar: #ecfffacc;
  --preview-border: #4d939a;
  --preview-ink: #1c5e6b;
  --preview-accent: #006665;
  --preview-secondary: #6da5ad;
  --preview-depth: inset 0 1px 2px #fff, 0 2px 3px #153d4b44;
}
[data-preview="minimal"] {
  --preview-frame: #dae2e9;
  --preview-panel: #f9fcff;
  --preview-toolbar: #eef2f6;
  --preview-border: #8397aa;
  --preview-ink: #32495f;
  --preview-accent: #16334d;
  --preview-secondary: #9babb9;
  --preview-radius: 1px;
  --preview-depth: none;
  border-top: 2px solid var(--preview-accent);
}
[data-preview="material"] {
  --preview-frame: #aaa9d7;
  --preview-panel: #f2efff;
  --preview-toolbar: #d8d6fb;
  --preview-border: #807cb2;
  --preview-ink: #433e84;
  --preview-accent: #116969;
  --preview-secondary: #9a88cc;
  --preview-radius: 5px;
  --preview-depth: 0 2px 3px #251c5f66;
}
[data-preview="swiss"] {
  --preview-frame: #f7e8d2;
  --preview-panel: #fff4e2;
  --preview-toolbar: #fff4e2;
  --preview-border: #5a4e44;
  --preview-ink: #30241f;
  --preview-accent: #ad1928;
  --preview-secondary: #786d65;
  --preview-radius: 0px;
  --preview-depth: none;
  border-radius: 0;
}
[data-preview="bauhaus"] {
  --preview-frame: #f0bc3f;
  --preview-panel: #fff1c2;
  --preview-toolbar: #ffd76c;
  --preview-border: #302617;
  --preview-ink: #4d371a;
  --preview-accent: #1341aa;
  --preview-secondary: #c63127;
  --preview-radius: 0px;
  --preview-depth: 2px 2px #241c12;
  border-radius: 0;
}
[data-preview="brutal"] {
  --preview-frame: #85b4ff;
  --preview-panel: #fcfdff;
  --preview-toolbar: #e0ecff;
  --preview-border: #141820;
  --preview-ink: #253555;
  --preview-accent: #164eaf;
  --preview-secondary: #77a5f8;
  --preview-radius: 2px;
  --preview-depth: 2px 2px #141820;
  border-width: 2px;
  border-radius: 2px;
}

.settings-title {
  margin: 0 0 8px;
  padding: 2px 8px;
  font-size: 1.25rem;
  letter-spacing: 0.03em;
}
.set-content {
  container: settings / inline-size;
  scrollbar-gutter: stable;
}
.set-full-pane {
  max-width: 1450px;
  margin: 0 auto;
}
.appearance-pane {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
}
.appearance-column,
.appearance-panel-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.appearance-panel-body { padding: 12px; }
.appearance-pane .style-cards {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.appearance-pane .skin-preview { width: clamp(48px, 5.5cqw, 88px); }
.appearance-pane .skin-card-title-row { flex-wrap: wrap; justify-content: flex-start; }
@container settings (max-width: 790px) {
  .appearance-pane { grid-template-columns: minmax(0, 1fr); }
}
.connection-body {
  padding: 20px;
}
.set-nav .btn:not(.primary):not(.active) {
  box-shadow: none;
  background: transparent;
  border-color: transparent;
}

.knob-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
  padding: 10px;
  border: var(--border-w, 1px) solid var(--panel-border);
  border-radius: var(--r-panel);
  background: color-mix(in srgb, var(--app) 58%, transparent);
}

.theme-ctrl-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.inline-ctrl {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.916667rem;
  cursor: pointer;
}

.pal-name-txt {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.material-settings {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.material-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 7px;
}
.material-caption {
  min-width: 0;
}
.material-picker {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 94px), 1fr));
  gap: 7px;
  min-width: 0;
}
.material-picker button {
  display: grid;
  gap: 4px;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--r-ctrl);
  padding: 4px 4px 5px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
  font-size: 0.916667rem;
  cursor: pointer;
}
.material-picker button.active {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

.background-thumb { display: block; width: 100%; object-fit: cover; }
.background-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.application-icon-preview { width: 32px; height: 32px; object-fit: contain; border-radius: 6px; }
.material-picker .background-thumb,
.material-picker .material-surface {
  height: 52px;
  border-radius: max(2px, calc(var(--r-ctrl) - 2px));
}
.material-picker .background-upload {
  place-items: center;
}
.material-controls,
.material-swatches,
.material-schemes {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
}
.material-controls {
  gap: 6px 12px;
}
.material-swatches,
.material-schemes {
  gap: 6px;
}
.material-swatches input[type="color"] {
  width: 30px;
  height: 25px;
  padding: 2px;
  box-sizing: border-box;
  cursor: pointer;
}
/* Splitter Default Size & Reset Groups */
.splitter-group-card {
  gap: 8px;
}
.splitter-grp-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid color-mix(in srgb, var(--panel-border) 65%, transparent);
}
.splitter-item-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.splitter-item-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 0.916667rem;
  color: var(--text);
}
.splitter-item-label {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.splitter-item-meta {
  font-size: 0.791667rem;
  color: var(--muted);
}
.splitter-item-ctrl {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.splitter-input-wrap {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.splitter-num-inp {
  width: 72px;
  height: 26px;
  padding: 2px 6px;
  text-align: right;
  font-size: 0.875rem;
}
.splitter-unit {
  width: 18px;
  font-size: 0.833333rem;
  color: var(--muted);
}

/* Shortcuts */
.shortcut-groups {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr));
  gap: 12px;
  align-items: start;
}
.shortcut-groups h3 {
  margin: 0;
  font-size: 1.041667rem;
}
.shortcut-line {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 36px;
  margin: 0 14px;
  border-bottom: 1px solid var(--panel-border);
  font-size: 0.958333rem;
}
.shortcut-line:last-child {
  border: 0;
}
.shortcut-line kbd {
  display: inline-block;
  padding: 2px 6px;
  margin-left: 3px;
  color: var(--text);
  background: var(--rail);
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 0.875rem;
}

/* Speaker Reference & Local 9-Model Matrix */
.spk-ref-card {
  gap: 9px;
}
.model-matrix-head {
  flex-wrap: wrap;
  gap: 8px;
}
.model-matrix-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.model-folder-drawer {
  gap: 7px;
  padding: 10px 12px;
  box-shadow: none;
  border-color: color-mix(in srgb, var(--accent) 40%, var(--panel-border));
  background: color-mix(in srgb, var(--selected) 36%, var(--panel));
}
.model-folder-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.model-folder-input {
  flex: 1 1 280px;
  min-width: 200px;
  height: 30px;
  padding: 0 10px;
  border-radius: var(--r-btn, 6px);
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 0.875rem;
}
.model-spec-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
}
@container desktop (max-width: 1180px) {
  .model-spec-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.model-spec-card {
  gap: 5px;
  padding: 10px 12px;
  box-shadow: none;
  cursor: pointer;
  user-select: none;
  transition: border-color 140ms ease, opacity 140ms ease, background-color 140ms ease, transform 120ms ease;
}
.model-spec-card:hover {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--panel-border));
}
.model-spec-card.is-unloaded {
  opacity: 0.68;
  border-style: dashed;
}
.model-spec-card.is-unloaded:hover {
  opacity: 0.92;
}
.model-spec-card.is-external {
  border-color: color-mix(in srgb, var(--accent) 62%, var(--panel-border));
}
.model-spec-card.is-busy {
  opacity: 0.78;
  pointer-events: none;
}
.model-spec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.model-spec-title-wrap {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.model-spec-name {
  font-size: 1rem;
  color: var(--text);
}
.model-ext-tag {
  padding: 0 5px;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.model-status-pill {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 0.8125rem;
  font-weight: 600;
  white-space: nowrap;
}
.model-status-pill.ok {
  background: color-mix(in srgb, var(--success) 16%, transparent);
  color: var(--success);
}
.model-status-pill.warn {
  background: color-mix(in srgb, var(--warning) 18%, transparent);
  color: var(--warning);
}
.model-status-pill.neutral {
  background: var(--selected);
  color: var(--accent);
}
.model-status-pill.muted-pill {
  background: color-mix(in srgb, var(--muted) 16%, transparent);
  color: var(--muted);
}
.model-spec-nums {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  font-size: 0.895rem;
  font-weight: 600;
  color: var(--accent);
}
.model-spec-role {
  font-size: 0.875rem;
  line-height: 1.45;
  flex: 1;
}
.model-ext-file {
  font-size: 0.8rem;
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, var(--panel-border) 65%, transparent);
}
.model-total-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border-radius: var(--r-panel);
  border: 1px solid color-mix(in srgb, var(--accent) 36%, var(--panel-border));
  background: color-mix(in srgb, var(--selected) 52%, var(--panel));
  font-size: 0.958333rem;
}
.model-total-Readout {
  font-size: 1.041667rem;
  font-weight: 700;
  color: var(--accent);
}
.onboarding-tour-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 8px;
}
.onboarding-tour-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 11px;
}
.onboarding-tour-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.onboarding-tour-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.94rem;
}
.onboarding-tour-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
  padding-top: 4px;
  border-top: 1px solid color-mix(in srgb, var(--panel-border) 65%, transparent);
}
</style>
