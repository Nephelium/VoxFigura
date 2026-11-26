<script setup lang="ts">
import NavArtwork from '@/components/common/NavArtwork.vue';
import CustomSelect, { type SelectOption } from '@/components/common/CustomSelect.vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { APP_BRAND_NAME } from '@/data/app-branding';
import { hasUpdate, latestRelease, openUpdateModal } from '@/data/app-update';
import { workspaceIconUrl } from '@/data/workspace-images';
import { EditionCardHeaderAction } from '@vocalcut/edition';
import {
  WORKBENCH_NAV_ITEMS,
  isWorkbenchNavActive,
  selectWorkbenchNav,
} from '@/data/workbench-nav';
import { useOnboardingStore } from '@/stores/onboarding';
import { useWorkbenchStore } from '@/stores/workbench';
import { BUILTIN_BACKDROPS, BUILTIN_SKINS, palettes } from '@/styles/skin-registry';
import { CHINESE_FONTS, type InterfaceFonts } from '@/styles/interface-fonts';
import { paletteShortName } from '@/styles/themes';
import IconSvg from './IconSvg.vue';

const store = useWorkbenchStore();
const onboarding = useOnboardingStore();
const menu = ref<'appearance' | 'help' | null>(null);

function replayCurrentPageTour(): void {
  menu.value = null;
  const pageId = onboarding.resolveCurrentWorkspacePageId(store);
  if (store.activeOverlay.value !== 'none') {
    onboarding.openTourAndNavigate(store, pageId);
    return;
  }
  onboarding.startTour(pageId);
}
const tools = ref<HTMLElement>();
const fullscreen = ref(false);
const syncFullscreen = () => {
  fullscreen.value = Boolean(document.fullscreenElement);
};

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    store.pushToast('浏览器未允许全屏，可使用 F11。', 'info');
  }
}

const isTopNav = computed(() => store.navPlacement.value === 'top');
const isDarkMode = computed(() => store.resolvedColorMode.value === 'dark');
const colorModeActionLabel = computed(() => isDarkMode.value ? '切换为浅色模式' : '切换为深色模式');

const FEATURED_PALETTE_IDS = [
  'codex',
  'github',
  'linear',
  'catppuccin',
  'nord',
  'rose-pine',
  'everforest',
  'ayu',
  'solarized',
  'tokyo-night',
] as const;

const featuredPalettes = computed(() =>
  FEATURED_PALETTE_IDS.map((id) => palettes.find((p) => p.id === id)).filter(
    (p): p is NonNullable<typeof p> => Boolean(p),
  ),
);

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
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', dismiss);
  document.addEventListener('keydown', escape, true);
  document.addEventListener('fullscreenchange', syncFullscreen);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', dismiss);
  document.removeEventListener('keydown', escape, true);
  document.removeEventListener('fullscreenchange', syncFullscreen);
});
</script>

<template>
  <header class="work-header" :class="{ 'has-top-nav': isTopNav }">
    <!-- Left Brand & Project Context -->
    <div class="work-brand">
      <button
        type="button"
        class="brand-home"
        :title="APP_BRAND_NAME"
        @click="store.closeOverlay()"
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
      <button
        v-for="item in WORKBENCH_NAV_ITEMS"
        :key="item.id"
        type="button"
        :aria-current="isWorkbenchNavActive(store, item) ? 'page' : undefined"
        :title="item.title"
        @click="selectWorkbenchNav(store, item)"
      >
        <NavArtwork :item="item.artwork" />
        <span>{{ item.shortLabel ?? item.label }}</span>
      </button>
      <button
        type="button"
        class="nav-dock-toggle"
        title="将导航按钮移回左侧"
        aria-label="将导航按钮移回左侧"
        @click="store.setLayoutPrefs({ navPlacement: 'left' })"
      >
        <NavArtwork item="dock-toggle" />
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
        <NavArtwork item="history-undo" />
      </button>
      <button
        type="button"
        class="hdr-icon-btn"
        title="重做 Ctrl+Shift+Z"
        aria-label="重做"
        :disabled="!store.canRedo.value"
        @click="store.redo()"
      >
        <NavArtwork item="history-redo" />
      </button>

      <i class="header-rule" />

      <button
        type="button"
        class="hdr-icon-btn"
        :title="colorModeActionLabel"
        :aria-label="colorModeActionLabel"
        @click="store.toggleColorMode($event)"
      >
        <IconSvg :name="isDarkMode ? 'moon' : 'sun'" :size="18" :stroke-width="1.8" />
      </button>

      <button
        type="button"
        class="hdr-icon-btn"
        aria-label="外观与字号快捷面板"
        title="外观与字号快捷面板"
        :aria-expanded="menu === 'appearance'"
        @click="menu = menu === 'appearance' ? null : 'appearance'"
      >
        <NavArtwork item="quick-appearance" />
      </button>

      <button
        type="button"
        class="hdr-icon-btn"
        :title="fullscreen ? '退出全屏' : '进入全屏'"
        :aria-label="fullscreen ? '退出全屏' : '进入全屏'"
        @click="toggleFullscreen"
      >
        <NavArtwork item="fullscreen" />
      </button>

      <button
        type="button"
        class="hdr-icon-btn"
        :class="{ active: store.activeOverlay.value === 'settings' }"
        title="设置 Alt+,"
        aria-label="设置"
        @click="store.openOverlay('settings'); menu = null"
      >
        <NavArtwork item="settings" />
      </button>

      <button
        type="button"
        class="hdr-icon-btn hdr-help-btn"
        aria-label="帮助与关于"
        :title="hasUpdate && latestRelease ? `帮助与关于（发现新版本 v${latestRelease.version}）` : '帮助与关于'"
        :aria-expanded="menu === 'help'"
        @click="menu = menu === 'help' ? null : 'help'"
      >
        <NavArtwork item="help" />
        <i v-if="hasUpdate" class="hdr-update-dot" aria-hidden="true" />
      </button>

      <component :is="EditionCardHeaderAction" v-if="EditionCardHeaderAction" @click="menu = null" />

      <button
        type="button"
        class="assistant-trigger hdr-text-btn"
        :aria-expanded="store.aiDrawerOpen.value"
        @click="store.aiDrawerOpen.value = !store.aiDrawerOpen.value; menu = null"
      >
        <NavArtwork item="ai-assistant" />
        <span>AI 助手</span>
      </button>

      <!-- Rich Quick Appearance & Typography Menu (T-37) -->
      <Transition name="pop-menu">
        <div v-if="menu === 'appearance'" class="look-menu" role="dialog" aria-label="快速外观设置">
          <div class="menu-heading">
            <div class="menu-title-group">
              <strong>外观与排版</strong>
              <span class="mono muted" style="font-size: 0.833333rem">{{ paletteShortName(store.paletteId.value) }}</span>
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

          <!-- Surface Skins (Flagships Highlighted) -->
          <div class="look-sec-lbl">
            <span>表面风格</span>
            <span class="muted">推荐「轻新拟态」与「极简仪器」</span>
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
              <NavArtwork item="appearance" :skin="skin.id" class="skin-emblem" />
              <span class="skin-name-row">
                <span>{{ skin.shortName }}</span>
                <IconSvg v-if="store.surfaceStyle.value === skin.id" name="check" :size="11" />
              </span>
            </button>
          </div>

          <!-- Curated Theme Accent Dots -->
          <div class="look-sec-lbl">
            <span>主题色板</span>
            <label class="custom-dot-lbl" title="自定义强调色">
              <span>自选</span>
              <input
                type="color"
                :value="store.customAccentHex.value"
                @input="store.setCustomAccent(($event.target as HTMLInputElement).value)"
              />
            </label>
          </div>
          <div class="quick-palette-dots" role="group" aria-label="主题色">
            <button
              v-for="pal in featuredPalettes"
              :key="pal.id"
              type="button"
              class="pal-dot-btn"
              :class="{ active: store.paletteId.value === pal.id }"
              :title="paletteShortName(pal.id)"
              :aria-label="paletteShortName(pal.id)"
              @click="store.setPalette(pal.id)"
            >
              <span
                class="pal-dot-core"
                :style="{
                  background: pal[store.resolvedColorMode.value][2],
                  borderColor: pal[store.resolvedColorMode.value][0],
                }"
              />
            </button>
          </div>

          <!-- Backdrop Presets -->
          <div class="look-sec-lbl"><span>工作区底纹</span></div>
          <div class="quick-backdrop-pills">
            <button
              v-for="b in BUILTIN_BACKDROPS"
              :key="b.id"
              type="button"
              class="btn xs"
              :class="{ active: store.backdropId.value === b.id }"
              @click="store.setBackdrop(b.id)"
            >
              {{ b.label }}
            </button>
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

          <button
            type="button"
            class="more-looks"
            @click="store.openOverlay('settings', 'appearance'); menu = null"
          >
            <span>全部外观与色彩设置</span>
            <IconSvg name="chevron-right" :size="13" />
          </button>
        </div>
      </Transition>

      <!-- Help & About Menu -->
      <Transition name="pop-menu">
        <div v-if="menu === 'help'" class="help-menu" role="menu">
          <button type="button" @click="replayCurrentPageTour">
            <NavArtwork item="getting-started" />
            <span>重播本页操作指引</span>
          </button>
          <button type="button" @click="store.openOverlay('guide'); menu = null">
            <NavArtwork item="user-guide" />
            <span>使用说明与语法速查</span>
          </button>
          <button type="button" @click="store.openOverlay('model-report'); menu = null">
            <NavArtwork item="technical-report" />
            <span>模型训练与技术报告</span>
          </button>
          <button type="button" @click="menu = null; openUpdateModal(true)">
            <NavArtwork item="check-updates" />
            <span>检查更新</span>
            <span v-if="hasUpdate && latestRelease" class="help-upd-pill mono">v{{ latestRelease.version }}</span>
          </button>
          <button type="button" @click="store.openOverlay('about'); menu = null">
            <NavArtwork item="about" />
            <span>关于{{ APP_BRAND_NAME }}</span>
          </button>
        </div>
      </Transition>
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

.header-tools > .hdr-icon-btn {
  width: var(--header-action-size);
  padding: 0;
  transition:
    color var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    background-color var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    border-color var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    transform var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1));
}

.header-tools > .hdr-icon-btn.active {
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

.header-tools .look-menu {
  width: 396px;
  top: 40px;
  padding: 12px 13px;
  background: var(--popover-bg);
  border: 1px solid var(--panel-border);
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 80;
}

.menu-title-group {
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.mode-seg button {
  height: 20px;
  padding: 0 7px;
  font-size: 0.875rem;
}

.look-sec-lbl {
  display: flex;
  align-items: center;
  justify-content: space-between;
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
  padding: 6px 4px 5px;
  min-height: 64px;
  transition:
    border-color 150ms var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    background-color 150ms var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    transform 150ms var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1));
}

.header-tools .look-choice.flagship {
  border-color: color-mix(in srgb, var(--accent) 34%, var(--border));
}

.header-tools .look-choice[aria-pressed="true"] {
  border-color: var(--accent);
  background: var(--selected);
  color: var(--accent);
  font-weight: 600;
}

.skin-flag {
  position: absolute;
  top: 3px;
  right: 3px;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 0.791667rem;
  line-height: 1.4;
  font-weight: 600;
  background: color-mix(in srgb, var(--accent) 16%, var(--panel));
  color: var(--accent);
}

.skin-name-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  width: 100%;
  font-size: 0.9rem;
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

.quick-palette-dots {
  display: grid;
  grid-template-columns: repeat(10, minmax(0, 1fr));
  gap: 5px;
}

.pal-dot-btn {
  height: 24px;
  padding: 0;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--ctrl-border);
  background: var(--ctrl-bg);
  display: grid;
  place-items: center;
  cursor: pointer;
}

.pal-dot-btn.active {
  border-color: var(--accent);
  background: var(--selected);
  box-shadow: 0 0 0 1.5px var(--selection);
}

.pal-dot-core {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 1.5px solid transparent;
  display: block;
}

.quick-backdrop-pills {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}

.look-font-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 7px 8px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 62%, transparent);
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
  gap: 4px;
}

.header-tools .more-looks {
  margin-top: 2px;
  padding: 7px 8px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--panel-border));
  background: color-mix(in srgb, var(--selected) 55%, transparent);
  color: var(--accent);
  font-weight: 600;
}

.help-menu {
  top: 40px;
  min-width: 198px;
  padding: 5px;
  background: var(--popover-bg);
  border: 1px solid var(--panel-border);
  z-index: 80;
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
