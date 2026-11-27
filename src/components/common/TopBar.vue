<script setup lang="ts">
import NavArtwork from '@/components/common/NavArtwork.vue';
import CustomSelect, { type SelectOption } from '@/components/common/CustomSelect.vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { APP_BRAND_NAME, APP_REPO_SLUG, APP_REPO_URL } from '@/data/app-branding';
import { hasUpdate, latestRelease, openUpdateModal } from '@/data/app-update';
import { activeWorkspaceBackground, workspaceIconUrl } from '@/data/workspace-images';
import { EditionCardHeaderAction, exploreLabel } from '@vocalcut/edition';
import {
  WORKBENCH_NAV_ITEMS,
  isWorkbenchNavActive,
  selectWorkbenchNav,
} from '@/data/workbench-nav';
import { useOnboardingStore } from '@/stores/onboarding';
import { useWorkbenchStore } from '@/stores/workbench';
import { cardStudioOpen } from '@/components/phonetic-card/session';
import { BUILTIN_BACKDROPS, BUILTIN_SKINS, isPhotoBackdrop, palettes } from '@/styles/skin-registry';
import { CHINESE_FONTS, type InterfaceFonts } from '@/styles/interface-fonts';
import { paletteShortName, type ColorMode } from '@/styles/themes';
import { MAX_SAVED_LOOKS_PER_MODE } from '@/data/saved-looks';
import {
  closeDesktopWindow,
  getDesktopWindowFullscreen,
  getDesktopWindowMaximized,
  isDesktopWindow,
  minimizeDesktopWindow,
  setDesktopWindowFullscreen,
  toggleMaximizeDesktopWindow,
} from '@/utils/desktop-window';
import IconSvg from './IconSvg.vue';
import SkinPreviewThumb from './SkinPreviewThumb.vue';

const store = useWorkbenchStore();
const onboarding = useOnboardingStore();
const menu = ref<'appearance' | 'help' | null>(null);

function replayCurrentPageTour(): void {
  menu.value = null;
  if (cardStudioOpen.value || store.exportModalWorkspace.value === 'explore') {
    onboarding.startTour('card');
    return;
  }
  const pageId = onboarding.resolveCurrentWorkspacePageId(store);
  if (store.activeOverlay.value !== 'none') {
    onboarding.openTourAndNavigate(store, pageId);
    return;
  }
  onboarding.startTour(pageId);
}
const tools = ref<HTMLElement>();
const desktopShell = isDesktopWindow();
const isMaximized = ref(false);
const fullscreen = ref(false);
let resizeSyncRaf = 0;

const syncFullscreen = () => {
  if (!desktopShell) {
    fullscreen.value = Boolean(document.fullscreenElement);
  }
};

async function syncDesktopWindowState(): Promise<void> {
  if (!desktopShell) return;
  const [maxState, fullState] = await Promise.all([
    getDesktopWindowMaximized(),
    getDesktopWindowFullscreen(),
  ]);
  isMaximized.value = maxState;
  fullscreen.value = fullState;
}

function scheduleDesktopWindowSync(): void {
  if (!desktopShell || resizeSyncRaf) return;
  resizeSyncRaf = window.requestAnimationFrame(() => {
    resizeSyncRaf = 0;
    void syncDesktopWindowState();
  });
}

async function toggleFullscreen() {
  if (desktopShell) {
    try {
      fullscreen.value = await setDesktopWindowFullscreen(!fullscreen.value);
      return;
    } catch {
      // Fall through to browser fullscreen API
    }
  }
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    store.pushToast('浏览器未允许全屏，可使用 F11。', 'info');
  }
}

async function onMinimizeWindow(): Promise<void> {
  menu.value = null;
  await minimizeDesktopWindow();
}

async function onToggleMaximizeWindow(): Promise<void> {
  menu.value = null;
  if (fullscreen.value) {
    try {
      fullscreen.value = await setDesktopWindowFullscreen(false);
    } catch {
      // Continue with maximize toggle
    }
    isMaximized.value = await getDesktopWindowMaximized();
    return;
  }
  isMaximized.value = await toggleMaximizeDesktopWindow();
}

async function onCloseWindow(): Promise<void> {
  menu.value = null;
  await closeDesktopWindow();
}

const isTopNav = computed(() => store.navPlacement.value === 'top');
const isDarkMode = computed(() => store.resolvedColorMode.value === 'dark');
const colorModeActionLabel = computed(() => isDarkMode.value ? '切换为浅色模式' : '切换为深色模式');
const brandHomeTitle = computed(() =>
  store.activeOverlay.value !== 'none'
    ? '返回工作台'
    : exploreLabel
      ? `返回${exploreLabel}`
      : '返回首页',
);

function onBrandHomeClick(): void {
  menu.value = null;
  if (store.activeOverlay.value !== 'none') {
    store.closeOverlay();
    return;
  }
  store.setWorkspace(exploreLabel ? 'explore' : 'home');
}

function toggleSettingsOverlay(): void {
  menu.value = null;
  if (store.activeOverlay.value === 'settings') store.closeOverlay();
  else store.openOverlay('settings');
}

const ambientBackdrops = BUILTIN_BACKDROPS.filter((b) => !isPhotoBackdrop(b.id));
const photoBackdrops = BUILTIN_BACKDROPS.filter((b) => isPhotoBackdrop(b.id));
const isMinimalSkin = computed(() => store.surfaceStyle.value === 'minimal');
const savedLookTab = ref<ColorMode>(store.resolvedColorMode.value);
watch(
  () => store.resolvedColorMode.value,
  (mode) => {
    savedLookTab.value = mode;
  },
);
const activeSavedLookList = computed(() => store.savedLooks.value[savedLookTab.value]);
const activeSavedDefaultId = computed(() => store.savedLooks.value.defaultIds[savedLookTab.value]);

const chineseFontOptions: SelectOption[] = CHINESE_FONTS.map((f) => ({
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

function dismiss(e: PointerEvent) {
  const target = e.target as Node | null;
  if (!target) return;
  if (tools.value?.contains(target)) return;
  // Do not close look-menu when interacting with teleported CustomSelect dropdown (#vcSelectMenu)
  const portalMenu = document.getElementById('vcSelectMenu');
  if (portalMenu?.contains(target)) return;
  menu.value = null;
}

function escape(e: KeyboardEvent) {
  if (e.key === 'Escape' && menu.value) {
    menu.value = null;
    e.stopPropagation();
    return;
  }
  if (desktopShell && e.key === 'F11' && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    void toggleFullscreen();
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', dismiss);
  document.addEventListener('keydown', escape, true);
  document.addEventListener('fullscreenchange', syncFullscreen);
  if (desktopShell) {
    window.addEventListener('resize', scheduleDesktopWindowSync);
    void syncDesktopWindowState();
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', dismiss);
  document.removeEventListener('keydown', escape, true);
  document.removeEventListener('fullscreenchange', syncFullscreen);
  if (desktopShell) {
    window.removeEventListener('resize', scheduleDesktopWindowSync);
  }
  if (resizeSyncRaf) {
    window.cancelAnimationFrame(resizeSyncRaf);
    resizeSyncRaf = 0;
  }
});
</script>

<template>
  <header
    class="work-header"
    :class="{ 'has-top-nav': isTopNav, 'is-desktop-shell': desktopShell }"
    :data-tauri-drag-region="desktopShell ? 'deep' : undefined"
  >
    <!-- Left Brand & Project Context -->
    <div class="work-brand">
      <button
        type="button"
        class="brand-home"
        :title="brandHomeTitle"
        @click="onBrandHomeClick"
      >
        <img :src="workspaceIconUrl" width="29" height="29" class="brand-glyph" alt="" />
        <strong class="brand-title">{{ APP_BRAND_NAME }}</strong>
      </button>
      <span class="brand-file mono" :title="store.project.value.name">
        {{ store.project.value.name }}
      </span>
    </div>

    <!-- Center Unified Workspace Navigation (visible when docked to top) -->
    <nav v-if="isTopNav" class="workspace-tabs" data-tour="nav-top" aria-label="工作台导航">
      <div class="workspace-tabs-scroll">
        <button
          v-for="item in WORKBENCH_NAV_ITEMS"
          :key="item.id"
          type="button"
          :aria-current="isWorkbenchNavActive(store, item) ? 'page' : undefined"
          :title="item.title"
          @click="selectWorkbenchNav(store, item)"
        >
          <NavArtwork :item="item.artwork" toolbar />
          <span>{{ item.shortLabel ?? item.label }}</span>
        </button>
      </div>
      <a
        class="nav-github-link"
        :href="APP_REPO_URL"
        target="_blank"
        rel="noopener noreferrer"
        :title="`GitHub 开源仓库 · ${APP_REPO_URL}`"
        :aria-label="`GitHub 开源仓库 ${APP_REPO_SLUG}`"
      >
        <NavArtwork item="github" toolbar theme-tint />
        <span class="nav-github-label">GitHub</span>
      </a>
      <button
        type="button"
        class="nav-dock-toggle"
        title="将导航按钮移回左侧"
        aria-label="将导航按钮移回左侧"
        @click="store.setLayoutPrefs({ navPlacement: 'left' })"
      >
        <NavArtwork item="dock-toggle" toolbar />
      </button>
    </nav>

    <!-- Right action bar -->
    <div ref="tools" class="header-tools" data-tour="topbar-tools">
      <button
        type="button"
        class="hdr-icon-btn"
        title="撤销 Ctrl+Z"
        aria-label="撤销"
        :disabled="!store.canUndo.value"
        @click="store.undo()"
      >
        <NavArtwork item="history-undo" toolbar />
      </button>
      <button
        type="button"
        class="hdr-icon-btn"
        title="重做 Ctrl+Shift+Z"
        aria-label="重做"
        :disabled="!store.canRedo.value"
        @click="store.redo()"
      >
        <NavArtwork item="history-redo" toolbar />
      </button>

      <i class="header-rule" />

      <button
        type="button"
        class="hdr-icon-btn"
        :title="colorModeActionLabel"
        :aria-label="colorModeActionLabel"
        @click="store.toggleColorMode($event)"
      >
        <NavArtwork :item="isDarkMode ? 'moon' : 'sun'" toolbar />
      </button>

      <div class="hdr-menu-anchor">
        <button
          type="button"
          class="hdr-icon-btn"
          aria-label="外观与字号快捷面板"
          title="外观与字号快捷面板"
          :aria-expanded="menu === 'appearance'"
          @click="menu = menu === 'appearance' ? null : 'appearance'"
        >
          <NavArtwork item="quick-appearance" toolbar />
        </button>

        <!-- Rich Quick Appearance & Typography Menu (T-37) -->
        <Transition name="pop-menu">
          <div
            v-if="menu === 'appearance'"
            class="look-menu"
            role="dialog"
            aria-label="快速外观设置"
            data-tauri-drag-region="false"
          >
            <div class="menu-heading">
              <div class="menu-title-group">
                <strong>外观与排版</strong>
                <span class="mono look-palette-pill">{{ paletteShortName(store.paletteId.value) }}</span>
              </div>
              <div class="seg mode-seg">
                <button
                  type="button"
                  :class="{ active: store.themeMode.value === 'light' }"
                  @click="store.setThemeMode('light', $event)"
                >
                  浅色
                </button>
                <button
                  type="button"
                  :class="{ active: store.themeMode.value === 'dark' }"
                  @click="store.setThemeMode('dark', $event)"
                >
                  深色
                </button>
                <button
                  type="button"
                  :class="{ active: store.themeMode.value === 'system' }"
                  @click="store.setThemeMode('system', $event)"
                >
                  跟随系统
                </button>
              </div>
            </div>

            <!-- Saved Day / Night Personal Default Looks (up to 5 each) -->
            <div class="look-saved-box">
              <div class="look-saved-head">
                <div class="seg look-color-seg" role="tablist" aria-label="日间与夜间个人搭配">
                  <button
                    type="button"
                    role="tab"
                    :aria-selected="savedLookTab === 'light'"
                    :class="{ active: savedLookTab === 'light' }"
                    @click="savedLookTab = 'light'"
                  >
                    日间 {{ store.savedLooks.value.light.length }}/{{ MAX_SAVED_LOOKS_PER_MODE }}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    :aria-selected="savedLookTab === 'dark'"
                    :class="{ active: savedLookTab === 'dark' }"
                    @click="savedLookTab = 'dark'"
                  >
                    夜间 {{ store.savedLooks.value.dark.length }}/{{ MAX_SAVED_LOOKS_PER_MODE }}
                  </button>
                </div>
                <button
                  type="button"
                  class="btn xs look-save-now"
                  :disabled="activeSavedLookList.length >= MAX_SAVED_LOOKS_PER_MODE"
                  :title="`保存当前布局、字号、配色与背景为${savedLookTab === 'dark' ? '夜间' : '日间'}搭配（最多 ${MAX_SAVED_LOOKS_PER_MODE} 份）`"
                  @click="store.saveCurrentLook(savedLookTab)"
                >
                  <IconSvg name="plus" :size="11" />
                  <span>保存当前</span>
                </button>
              </div>
              <div v-if="activeSavedLookList.length" class="look-saved-list">
                <div
                  v-for="look in activeSavedLookList"
                  :key="look.id"
                  class="look-saved-pill"
                  :class="{
                    active: store.activeSavedLookId.value === look.id,
                    'is-default': activeSavedDefaultId === look.id,
                  }"
                >
                  <button
                    type="button"
                    class="look-saved-apply"
                    :title="`切换至「${look.name}」（含布局、字号、配色与背景）`"
                    @click="store.applySavedLook(savedLookTab, look.id, $event)"
                  >
                    <span class="look-saved-name">{{ look.name }}</span>
                  </button>
                  <button
                    type="button"
                    class="look-saved-icon"
                    :class="{ active: activeSavedDefaultId === look.id }"
                    :title="activeSavedDefaultId === look.id ? `当前为${savedLookTab === 'dark' ? '夜间' : '日间'}默认（点击取消）` : `设为${savedLookTab === 'dark' ? '夜间' : '日间'}默认，切换明暗时自动生效`"
                    @click.stop="store.toggleDefaultSavedLook(savedLookTab, look.id)"
                  >
                    <IconSvg name="sparkles" :size="11" />
                  </button>
                  <button
                    type="button"
                    class="look-saved-icon look-saved-del"
                    title="删除该搭配"
                    @click.stop="store.deleteSavedLook(savedLookTab, look.id)"
                  >
                    <IconSvg name="close" :size="10" />
                  </button>
                </div>
              </div>
              <p v-else class="look-saved-empty">
                暂无{{ savedLookTab === 'dark' ? '夜间' : '日间' }}个人搭配，点击「保存当前」可存最多 {{ MAX_SAVED_LOOKS_PER_MODE }} 份并设为明暗切换默认
              </p>
            </div>

            <!-- Surface Skins (Flagships Highlighted) -->
            <div class="look-sec-lbl">
              <span>表面风格</span>
              <div class="seg look-color-seg" role="group" aria-label="切换风格时的配色策略">
                <button
                  type="button"
                  :class="{ active: store.styleColorMode.value === 'current' }"
                  :aria-pressed="store.styleColorMode.value === 'current'"
                  title="切换风格时保留当前色板、背景与材质"
                  @click="store.setStyleColorMode('current')"
                >
                  当前配色
                </button>
                <button
                  type="button"
                  :class="{ active: store.styleColorMode.value === 'original' }"
                  :aria-pressed="store.styleColorMode.value === 'original'"
                  title="切换风格时恢复该风格的原始配色"
                  @click="store.setStyleColorMode('original')"
                >
                  原始配色
                </button>
              </div>
            </div>
            <div class="look-grid">
              <button
                v-for="skin in BUILTIN_SKINS"
                :key="skin.id"
                type="button"
                class="look-choice"
                :class="{ flagship: skin.id === 'neumorphism' || skin.id === 'minimal' }"
                :data-skin="skin.id"
                :aria-pressed="store.surfaceStyle.value === skin.id"
                @click="store.setSurfaceStyle(skin.id)"
              >
                <span v-if="skin.id === 'neumorphism'" class="skin-flag">默认</span>
                <SkinPreviewThumb
                  :skin-id="skin.id"
                  :color-mode="store.styleColorMode.value"
                  :theme-mode="store.resolvedColorMode.value"
                />
                <span class="skin-name-row">
                  <span>{{ skin.shortName }}</span>
                  <IconSvg v-if="store.surfaceStyle.value === skin.id" name="check" :size="11" />
                </span>
              </button>
            </div>

            <!-- Full 30 Palettes Quick Picker -->
            <div class="look-sec-lbl">
              <span>主题色板（{{ palettes.length }} 套）</span>
              <label class="custom-dot-lbl" title="自定义强调色">
                <span>自定义主色</span>
                <input
                  type="color"
                  :value="store.accentPickerColor.value"
                  @input="store.setCustomAccent(($event.target as HTMLInputElement).value)"
                />
              </label>
            </div>
            <div class="quick-palette-grid" role="group" aria-label="主题色板">
              <button
                v-for="pal in palettes"
                :key="pal.id"
                type="button"
                class="quick-pal-card"
                :class="{ active: store.paletteId.value === pal.id }"
                :title="paletteShortName(pal.id)"
                :aria-pressed="store.paletteId.value === pal.id"
                @click="store.setPalette(pal.id)"
              >
                <span class="quick-pal-name">{{ paletteShortName(pal.id) }}</span>
                <span class="quick-pal-swatches" aria-hidden="true">
                  <i :style="{ background: pal[store.resolvedColorMode.value][0] }" />
                  <i :style="{ background: pal[store.resolvedColorMode.value][1] }" />
                  <i :style="{ background: pal[store.resolvedColorMode.value][2] }" />
                </span>
              </button>
            </div>

            <!-- Backdrop Presets -->
            <div class="look-sec-lbl">
              <span>工作区背景</span>
              <span v-if="isMinimalSkin" class="muted">极简仪器采用纯网格底面</span>
              <span v-else class="muted">静谧底纹与柔雾壁纸</span>
            </div>
            <div class="look-bg-group">
              <span class="look-bg-sub">静谧底纹</span>
              <div class="quick-backdrop-pills">
                <button
                  v-for="b in ambientBackdrops"
                  :key="b.id"
                  type="button"
                  class="btn xs"
                  :class="{ active: !activeWorkspaceBackground && store.backdropId.value === b.id }"
                  :aria-pressed="!activeWorkspaceBackground && store.backdropId.value === b.id"
                  @click="store.setBackdrop(b.id)"
                >
                  {{ b.label }}
                </button>
              </div>
              <span class="look-bg-sub">柔雾壁纸</span>
              <div class="quick-backdrop-pills">
                <button
                  v-for="b in photoBackdrops"
                  :key="b.id"
                  type="button"
                  class="btn xs"
                  :class="{ active: !activeWorkspaceBackground && store.backdropId.value === b.id }"
                  :aria-pressed="!activeWorkspaceBackground && store.backdropId.value === b.id"
                  @click="store.setBackdrop(b.id)"
                >
                  {{ b.label }}
                </button>
              </div>
            </div>

            <!-- Quick Font & Font Size Controls -->
            <div class="look-font-box">
              <div class="look-font-row">
                <span class="look-k">中文字体</span>
                <CustomSelect
                  size="xs"
                  style="flex: 1"
                  :min-menu-width="196"
                  :model-value="store.interfaceFonts.value.chinese"
                  :options="chineseFontOptions"
                  @update:model-value="(v) => store.setInterfaceFonts({ chinese: v as InterfaceFonts['chinese'] })"
                />
              </div>
              <div class="look-font-row">
                <span class="look-k">界面字号</span>
                <input
                  type="range"
                  min="11"
                  max="16"
                  step="0.5"
                  :value="store.interfaceFonts.value.fontSizePx"
                  :style="{ flex: '1', '--fill': fontSizeFill }"
                  aria-label="界面字号"
                  @input="store.setInterfaceFonts({ fontSizePx: Number(($event.target as HTMLInputElement).value) })"
                />
                <span class="mono look-size-val">{{ store.interfaceFonts.value.fontSizePx }}px</span>
              </div>
              <div class="look-size-presets">
                <button
                  v-for="preset in FONT_SIZE_PRESETS"
                  :key="preset.value"
                  type="button"
                  class="btn xs"
                  :class="{ active: store.interfaceFonts.value.fontSizePx === preset.value }"
                  @click="store.setInterfaceFonts({ fontSizePx: preset.value })"
                >
                  {{ preset.label }}
                </button>
              </div>
            </div>

            <div class="look-footer-actions">
              <button
                type="button"
                class="more-looks"
                @click="store.openOverlay('settings', 'appearance'); menu = null"
              >
                <span>全部外观与色彩设置</span>
                <IconSvg name="chevron-right" :size="13" />
              </button>
              <button
                type="button"
                class="btn sm look-lab-trigger"
                title="打开风格实验室 (Alt+Shift+S)"
                @click="store.styleLabOpen.value = !store.styleLabOpen.value; menu = null"
              >
                <IconSvg name="sliders" :size="12" />
                <span>实验室</span>
              </button>
            </div>
          </div>
        </Transition>
      </div>

      <button
        type="button"
        class="hdr-icon-btn"
        :title="fullscreen ? '退出全屏' : '进入全屏'"
        :aria-label="fullscreen ? '退出全屏' : '进入全屏'"
        @click="toggleFullscreen"
      >
        <NavArtwork item="fullscreen" toolbar />
      </button>

      <button
        type="button"
        class="hdr-icon-btn"
        :class="{ active: store.activeOverlay.value === 'settings' }"
        title="设置 Alt+,"
        aria-label="设置"
        @click="toggleSettingsOverlay"
      >
        <NavArtwork item="settings" toolbar />
      </button>

      <div class="hdr-menu-anchor">
        <button
          type="button"
          class="hdr-icon-btn hdr-help-btn"
          aria-label="帮助与关于"
          :title="hasUpdate && latestRelease ? `帮助与关于（发现新版本 v${latestRelease.version}）` : '帮助与关于'"
          :aria-expanded="menu === 'help'"
          @click="menu = menu === 'help' ? null : 'help'"
        >
          <NavArtwork item="help" toolbar />
          <i v-if="hasUpdate" class="hdr-update-dot" aria-hidden="true" />
        </button>

        <!-- Help & About Menu -->
        <Transition name="pop-menu">
          <div
            v-if="menu === 'help'"
            class="help-menu"
            role="menu"
            data-tauri-drag-region="false"
          >
            <button type="button" @click="replayCurrentPageTour">
              <NavArtwork item="getting-started" toolbar />
              <span>重播本页操作指引</span>
            </button>
            <button type="button" @click="store.openOverlay('guide'); menu = null">
              <NavArtwork item="user-guide" toolbar />
              <span>使用说明与语法速查</span>
            </button>
            <button type="button" @click="store.openOverlay('model-report'); menu = null">
              <NavArtwork item="technical-report" toolbar />
              <span>模型训练与技术报告</span>
            </button>
            <button type="button" @click="menu = null; openUpdateModal(true)">
              <NavArtwork item="check-updates" toolbar />
              <span>检查更新</span>
              <span v-if="hasUpdate && latestRelease" class="help-upd-pill mono">v{{ latestRelease.version }}</span>
            </button>
            <button type="button" @click="store.openOverlay('about'); menu = null">
              <NavArtwork item="about" toolbar />
              <span>关于{{ APP_BRAND_NAME }}</span>
            </button>
          </div>
        </Transition>
      </div>

      <button
        v-if="hasUpdate && latestRelease"
        type="button"
        class="hdr-text-btn hdr-update-trigger"
        :title="`查看新版本 v${latestRelease.version} 更新说明与下载`"
        :aria-label="`发现新版本 v${latestRelease.version}，点击查看更新`"
        @click="menu = null; openUpdateModal(false)"
      >
        <IconSvg name="sparkles" :size="13" />
        <span class="mono">v{{ latestRelease.version }}</span>
      </button>

      <component :is="EditionCardHeaderAction" v-if="EditionCardHeaderAction" @click="menu = null" />

      <button
        type="button"
        class="assistant-trigger hdr-text-btn"
        :aria-expanded="store.aiDrawerOpen.value"
        @click="store.aiDrawerOpen.value = !store.aiDrawerOpen.value; menu = null"
      >
        <NavArtwork item="ai-assistant" toolbar />
        <span>AI 助手</span>
      </button>

      <template v-if="desktopShell">
        <i class="header-rule win-rule" aria-hidden="true" />
        <button
          type="button"
          class="win-ctrl"
          title="最小化"
          aria-label="最小化窗口"
          @click="onMinimizeWindow"
        >
          <IconSvg name="window-minimize" :size="13" :stroke-width="1.65" />
        </button>
        <button
          type="button"
          class="win-ctrl"
          :title="fullscreen ? '退出全屏' : isMaximized ? '向下还原' : '最大化'"
          :aria-label="fullscreen ? '退出全屏' : isMaximized ? '向下还原窗口' : '最大化窗口'"
          @click="onToggleMaximizeWindow"
        >
          <IconSvg :name="isMaximized || fullscreen ? 'window-restore' : 'window-maximize'" :size="12" :stroke-width="1.6" />
        </button>
        <button
          type="button"
          class="win-ctrl win-close"
          title="关闭"
          aria-label="关闭窗口"
          @click="onCloseWindow"
        >
          <IconSvg name="window-close" :size="13" :stroke-width="1.65" />
        </button>
      </template>
    </div>
  </header>
</template>

<style scoped>
.brand-home {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px 2px 0;
  border: 0;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}

.brand-title {
  font-size: 1.166667rem;
  font-weight: 700;
  letter-spacing: -0.25px;
  white-space: nowrap;
}

.brand-file {
  max-width: 170px;
}

.workspace-tabs {
  overflow: hidden;
}

.workspace-tabs-scroll {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  overflow-x: auto;
  scrollbar-width: none;
}

.workspace-tabs-scroll::-webkit-scrollbar {
  display: none;
}

.workspace-tabs button {
  transition:
    color var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    background-color var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1));
}

.workspace-tabs button::after {
  content: "";
  position: absolute;
  bottom: 0;
  left: 8px;
  right: 8px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--accent);
  transform: scaleX(0);
  transform-origin: center;
  transition: transform var(--dur-med, 210ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1));
}

.workspace-tabs button[aria-current]::after {
  transform: scaleX(1);
}

.workspace-tabs .nav-github-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 28px;
  padding: 0 8px;
  margin-left: 4px;
  border-radius: var(--r-ctrl);
  color: var(--muted);
  text-decoration: none;
  font-size: 0.916667rem;
  white-space: nowrap;
  flex: none;
  opacity: 0.84;
  transition:
    color var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    background-color var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    opacity var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1));
}

.workspace-tabs .nav-github-link:hover {
  opacity: 1;
  color: var(--accent);
  background: var(--header-selected-bg);
}

.workspace-tabs .nav-github-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.workspace-tabs .nav-github-link > .nav-art {
  width: 18px;
  height: 18px;
}

@container desktop (max-width: 1620px) {
  .workspace-tabs .nav-github-link {
    width: 28px;
    padding: 0;
  }

  .workspace-tabs .nav-github-label {
    display: none;
  }
}

.workspace-tabs .nav-dock-toggle {
  height: 28px;
  width: 28px;
  padding: 0;
  margin-left: 4px;
  justify-content: center;
  border-radius: var(--r-ctrl);
  opacity: 0.78;
}

.workspace-tabs .nav-dock-toggle:hover {
  opacity: 1;
}

.workspace-tabs .nav-dock-toggle::after {
  display: none;
}

.workspace-tabs .nav-dock-toggle > .nav-art {
  width: 18px;
  height: 18px;
}

:is(.header-tools, .hdr-menu-anchor) > .hdr-icon-btn {
  width: var(--header-action-size);
  padding: 0;
  transition:
    color var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    background-color var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    border-color var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    transform var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1));
}

:is(.header-tools, .hdr-menu-anchor) > .hdr-icon-btn.active {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--selected);
}

.header-tools > .assistant-trigger {
  border-radius: var(--r-ctrl);
  transition:
    background-color var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    border-color var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    transform var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1));
}

.header-tools > .hdr-update-trigger {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 13%, var(--ctrl-bg));
  border: var(--border-w, 1px) solid color-mix(in srgb, var(--accent) 42%, var(--panel-border));
  border-radius: var(--r-ctrl);
}

.header-tools > .hdr-update-trigger:hover {
  background: color-mix(in srgb, var(--accent) 20%, var(--ctrl-bg));
  border-color: var(--accent);
}

.work-header.is-desktop-shell {
  user-select: none;
}

.header-tools > .win-rule {
  margin-inline: 5px;
}

.header-tools > button.win-ctrl {
  width: var(--header-action-size);
  padding: 0;
  transition:
    color var(--dur-fast) var(--ease-out-expo),
    background-color var(--dur-fast) var(--ease-out-expo),
    border-color var(--dur-fast) var(--ease-out-expo);
}

.header-tools > button.win-close:not(:disabled):hover,
.header-tools > button.win-close:not(:disabled):focus-visible {
  color: var(--on-accent);
  background: var(--danger);
  border-color: var(--danger);
}

.header-tools .look-menu {
  --look-stroke: color-mix(in srgb, var(--border) 88%, transparent);
  --look-surface: color-mix(in srgb, var(--panel) 84%, var(--app));
  width: 428px;
  max-width: calc((100vw - 24px) / var(--page-scale, 1));
  max-height: min(86vh, calc((100vh - 64px) / var(--page-scale, 1)));
  overflow-y: auto;
  top: 40px;
  padding: 12px 13px;
  background: var(--popover-bg);
  border: 1px solid var(--look-stroke);
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: var(--z-overlay);
}

.menu-title-group {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.look-palette-pill {
  font-size: 0.78rem;
  padding: 1px 6px;
  border-radius: 999px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, var(--ctrl-bg));
  border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--panel-border));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 124px;
}

.mode-seg button,
.look-color-seg button {
  height: auto;
  min-height: 22px;
  padding: 2px 7px;
  font-size: 0.85rem;
  background: transparent;
  color: var(--muted);
}

.header-tools .mode-seg button.active,
.header-tools .mode-seg button.active:hover,
.header-tools .look-color-seg button.active,
.header-tools .look-color-seg button.active:hover {
  color: var(--on-accent);
  background: var(--accent);
  font-weight: 600;
}

.look-saved-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 7px 8px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--look-stroke);
  background: color-mix(in srgb, var(--app) 62%, var(--panel));
}

.look-saved-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.header-tools .look-save-now {
  height: auto;
  min-height: 22px;
  padding: 2px 7px;
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--look-stroke));
  background: color-mix(in srgb, var(--accent) 12%, var(--look-surface));
  color: var(--accent);
  font-weight: 600;
}

.header-tools .look-save-now:hover:not(:disabled) {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.look-saved-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.look-saved-pill {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--look-stroke);
  background: var(--look-surface);
  overflow: hidden;
}

.look-saved-pill.is-default {
  border-color: color-mix(in srgb, var(--accent) 62%, var(--look-stroke));
}

.look-saved-pill.active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, var(--panel));
  box-shadow: inset 0 0 0 1px var(--accent);
}

.header-tools .look-saved-apply {
  height: auto;
  min-height: 23px;
  padding: 2px 7px;
  color: var(--text);
  font-size: 0.82rem;
  max-width: 138px;
  background: transparent;
}

.header-tools .look-saved-apply:hover {
  color: var(--accent);
}

.look-saved-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-tools .look-saved-icon {
  height: 23px;
  width: 21px;
  padding: 0;
  justify-content: center;
  color: var(--muted);
  background: transparent;
  border-left: 1px solid color-mix(in srgb, var(--look-stroke) 65%, transparent);
  border-radius: 0;
}

.header-tools .look-saved-icon.active {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.header-tools .look-saved-icon:hover {
  color: var(--accent);
  background: color-mix(in srgb, var(--selected) 72%, transparent);
}

.header-tools .look-saved-del:hover {
  color: var(--danger);
}

.look-saved-empty {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.45;
  color: var(--muted);
}

.look-sec-lbl {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text);
  padding-top: 2px;
}

.look-sec-lbl .muted {
  font-weight: 400;
  font-size: 0.833333rem;
}

.header-tools .look-choice {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 4px 5px;
  min-height: 70px;
  background: var(--look-surface);
  border: 1px solid var(--look-stroke);
  color: var(--text);
  transition:
    border-color 150ms var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    background-color 150ms var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    box-shadow 150ms var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    transform 150ms var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1));
}

.header-tools .look-choice.flagship {
  border-color: color-mix(in srgb, var(--accent) 34%, var(--look-stroke));
}

.header-tools .look-choice[aria-pressed="true"] {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 18%, var(--panel));
  box-shadow: inset 0 0 0 1px var(--accent);
  color: var(--text);
  font-weight: 600;
}

.header-tools .look-choice[aria-pressed="true"] .skin-name-row {
  color: var(--accent);
}

.skin-flag {
  position: absolute;
  top: 2px;
  left: 3px;
  z-index: var(--z-base);
  padding: 0 4px;
  border-radius: 3px;
  font-size: 0.68rem;
  line-height: 1.35;
  font-weight: 600;
  background: color-mix(in srgb, var(--popover-bg) 88%, var(--accent));
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--look-stroke));
  color: var(--accent);
}

.skin-name-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  width: 100%;
  font-size: 0.88rem;
}

.custom-dot-lbl {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.833333rem;
  color: var(--muted);
  cursor: pointer;
}

.custom-dot-lbl input[type="color"] {
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 50%;
}

.quick-palette-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
  max-height: 154px;
  overflow-y: auto;
  padding: 2px;
  margin: -2px;
  scrollbar-width: thin;
}

.header-tools .quick-pal-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  min-width: 0;
  height: auto;
  min-height: 26px;
  padding: 3px 6px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--look-stroke);
  background: var(--look-surface);
  color: var(--text);
  font-size: 0.82rem;
  cursor: pointer;
}

.header-tools .quick-pal-card.active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 18%, var(--panel));
  box-shadow: inset 0 0 0 1px var(--accent);
  color: var(--accent);
  font-weight: 600;
}

.quick-pal-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quick-pal-swatches {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
}

.quick-pal-swatches i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--text) 24%, transparent);
  display: block;
}

.look-bg-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.look-bg-sub {
  font-size: 0.78rem;
  color: var(--muted);
  line-height: 1.2;
}

.quick-backdrop-pills {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
}

.look-font-box {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 8px 9px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--look-stroke);
  background: color-mix(in srgb, var(--app) 68%, var(--panel));
}

.look-font-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.look-k {
  font-size: 0.9rem;
  color: var(--muted);
  white-space: nowrap;
  min-width: 48px;
}

.look-size-val {
  font-size: 0.9rem;
  min-width: 36px;
  text-align: right;
  color: var(--accent);
  font-weight: 600;
}

.look-size-presets {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 5px;
}

.header-tools :is(.quick-backdrop-pills, .look-size-presets) > .btn.xs {
  height: auto;
  min-height: 25px;
  padding: 3px 6px;
}

.header-tools :is(.quick-backdrop-pills, .look-size-presets) > .btn:not(.active) {
  background: var(--look-surface);
  border-color: var(--look-stroke);
  color: var(--text);
}

.header-tools :is(.quick-backdrop-pills, .look-size-presets) > .btn.active,
.header-tools :is(.quick-backdrop-pills, .look-size-presets) > .btn.active:hover {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
  box-shadow: none;
}

.header-tools :is(.look-choice, .quick-pal-card):not([aria-pressed="true"]):is(:hover, :focus-visible),
.header-tools :is(.quick-backdrop-pills, .look-size-presets) > .btn:not(.active):is(:hover, :focus-visible) {
  background: color-mix(in srgb, var(--selected) 74%, var(--panel));
  border-color: color-mix(in srgb, var(--accent) 60%, var(--panel-border));
}

.look-footer-actions {
  display: flex;
  align-items: stretch;
  gap: 6px;
  margin-top: 2px;
}

.header-tools .more-looks {
  flex: 1;
  margin-top: 0;
  padding: 7px 9px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--panel-border));
  background: color-mix(in srgb, var(--selected) 62%, var(--panel));
  color: var(--accent);
  font-weight: 600;
}

.header-tools .more-looks:hover,
.header-tools .more-looks:focus-visible {
  background: color-mix(in srgb, var(--accent) 18%, var(--panel));
  border-color: var(--accent);
}

.header-tools .look-lab-trigger {
  flex: none;
  height: auto;
  padding: 0 9px;
  border: 1px solid var(--look-stroke);
  background: var(--look-surface);
  color: var(--text);
}

.help-menu {
  top: 40px;
  min-width: 198px;
  padding: 5px;
  background: var(--popover-bg);
  border: 1px solid var(--panel-border);
  z-index: var(--z-overlay);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.help-menu button {
  width: 100%;
  justify-content: flex-start;
  gap: 8px;
  padding: 7px 9px;
  border-radius: var(--r-ctrl);
  font-size: 0.958333rem;
  color: var(--text);
}

.help-menu button:hover,
.help-menu button:focus-visible {
  background: color-mix(in srgb, var(--selected) 78%, var(--panel));
  color: var(--accent);
}

.hdr-help-btn {
  position: relative;
}

.hdr-update-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 2px var(--panel);
}

.help-upd-pill {
  margin-left: auto;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 0.74rem;
  font-weight: 700;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.pop-menu-enter-active,
.pop-menu-leave-active {
  transition:
    opacity var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    transform var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1));
}

.pop-menu-enter-from,
.pop-menu-leave-to {
  opacity: 0;
  transform: translateY(-5px) scale(0.985);
}

@container desktop (max-width: 1280px) {
  .brand-file {
    display: none;
  }
}
</style>
