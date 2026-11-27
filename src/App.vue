<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { backdropArtworkUrl, computeDesktopViewportSize, getSkin, listBackdrops } from '@/styles/skin-registry';
import { paletteShortName } from '@/styles/themes';
import { artworkHueShift, colorHue, sampleArtworkImage, toolbarArtworkTokens, type ArtworkImageColors } from '@/styles/artwork-hue';
import { APP_REPO_SLUG, APP_REPO_URL, APP_WINDOW_TITLE } from '@/data/app-branding';
import { describeEngineStatus } from '@/data/engine-status';
import { activeWorkspaceBackground, activeWorkspaceIcon, loadWorkspaceImages, workspaceIconUrl } from '@/data/workspace-images';
import { setDesktopWindowIcon } from '@/utils/desktop-window';
import { useWorkbenchStore } from '@/stores/workbench';
import { initializeSpeakerReferences } from '@/data/synthesis-speaker';
import TechBackdrop from '@/components/common/TechBackdrop.vue';
import TopBar from '@/components/common/TopBar.vue';
import NavArtwork from '@/components/common/NavArtwork.vue';
import StyleLabBackdoor from '@/components/common/StyleLabBackdoor.vue';
import StartupSplash from '@/components/common/StartupSplash.vue';
import SpotlightTourOverlay from '@/components/onboarding/SpotlightTourOverlay.vue';
import UpdateModal from '@/components/modals/UpdateModal.vue';
import ToastHost from '@/components/common/ToastHost.vue';
import TooltipHost from '@/components/common/TooltipHost.vue';
import { cancelUpdateCheck, checkForAppUpdate, closeUpdateModal, updateModalOpen } from '@/data/app-update';
import { startupBootCompleted } from '@/data/startup-splash';
import { useOnboardingStore } from '@/stores/onboarding';
import AiDrawer from '@/components/ai/AiDrawer.vue';
import ExportModal from '@/components/modals/ExportModal.vue';
import ReferencesModal from '@/components/modals/ReferencesModal.vue';
import { cardDemoNoticeOpen, cardStudioOpen } from '@/components/phonetic-card/session';
import { ExploreWorkspace, EditionCardModal } from '@vocalcut/edition';
import {
  WORKBENCH_NAV_ITEMS,
  isWorkbenchNavActive,
  selectWorkbenchNav,
} from '@/data/workbench-nav';
import ResearchWorkbenchView from '@/views/ResearchWorkbenchView.vue';
import StudioView from '@/views/StudioView.vue';
import SettingsView from '@/views/SettingsView.vue';
import AboutView from '@/views/AboutView.vue';
import HomeView from '@/views/HomeView.vue';

const GuideView = defineAsyncComponent(() => import('@/views/GuideView.vue'));
const ModelReportView = defineAsyncComponent(() => import('@/views/ModelReportView.vue'));
const ModuleGuideModal = defineAsyncComponent(() => import('@/components/guide/ModuleGuideModal.vue'));

const store = useWorkbenchStore();
const onboarding = useOnboardingStore();
const imageColors = ref<ArtworkImageColors>();
let autoTourTimer: number | undefined;
let autoUpdateTimer: number | undefined;
let startupUpdateChecked = false;

const backdropColorSource = computed(() => activeWorkspaceBackground.value?.url
  ?? backdropArtworkUrl(store.backdropId.value, store.resolvedColorMode.value, true));
watch(backdropColorSource, async (url, _, onCleanup) => {
  imageColors.value = undefined;
  if (!url) return;
  let active = true;
  onCleanup(() => { active = false; });
  const colors = await sampleArtworkImage(url);
  if (active) imageColors.value = colors;
}, { immediate: true });

const artworkHue = computed(() => {
  const accent = store.paletteId.value === 'custom'
    ? store.customAccentHex.value
    : store.activePalette.value['--accent'];
  const materialHue = store.backdropColorScheme.value === 'theme'
    ? undefined
    : store.backdropActiveColors.value.map(colorHue).find((hue) => hue !== undefined);
  const backgroundHue = activeWorkspaceBackground.value ? imageColors.value?.hue : materialHue;
  return artworkHueShift(
    store.surfaceStyle.value, colorHue(accent), backgroundHue, store.backdropTreatment.value.saturationPct / 100,
  );
});
const toolbarArt = computed(() => {
  const overrides = store.styleOverrides.value;
  return toolbarArtworkTokens(store.activePalette.value, {
    mode: store.resolvedColorMode.value,
    backdrop: store.backdropId.value,
    tintColors: store.backdropActiveColors.value,
    imageColor: imageColors.value?.average,
    customImage: !!activeWorkspaceBackground.value,
    saturation: store.backdropTreatment.value.saturationPct / 100,
    coverage: overrides.bgCov ?? store.bgCov.value,
    surfaceOpacity: (overrides.glassAlpha ?? store.glassAlpha.value) / 100,
  });
});

// A 16:10 or wider viewport fits completely without outer scrollbars; narrower viewports scroll horizontally.
const viewport = ref({ width: window.innerWidth, height: window.innerHeight });
const updateDesktop = () => {
  viewport.value = { width: window.innerWidth, height: window.innerHeight };
};
const desktop = computed(() =>
  computeDesktopViewportSize(
    viewport.value.width,
    viewport.value.height,
    store.pageScale.value,
    store.autoPageScale.value,
  ),
);
const shellSize = computed(() => ({
  width: `${desktop.value.width / store.pageScale.value}px`,
  height: `${desktop.value.height / store.pageScale.value}px`,
  '--nav-art-hue': artworkHue.value ? `hue-rotate(${artworkHue.value}deg)` : undefined,
  ...toolbarArt.value,
}));
const isCompactRailGithub = computed(() => (desktop.value.height / store.pageScale.value) < 780);
const isCompactStatusGithub = computed(() => (desktop.value.width / store.pageScale.value) < 1080);

const skinLabel = computed(() => getSkin(store.surfaceStyle.value)?.shortName ?? store.surfaceStyle.value);
const paletteLabel = computed(() => paletteShortName(store.paletteId.value));
const backdropLabel = computed(
  () => activeWorkspaceBackground.value ? '自定义背景' : listBackdrops().find((b) => b.id === store.backdropId.value)?.label ?? store.backdropId.value,
);
const isOverlayDock = computed(() => store.aiDrawerDockMode.value === 'overlay');

const engineStatusLabel = computed(() => describeEngineStatus(store.engineStatus.value).label);

function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

function onGlobalKeyDown(e: KeyboardEvent): void {
  // Strictly silence shortcuts during IME composition
  if (e.isComposing || e.keyCode === 229) return;

  if (e.defaultPrevented) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  // Alt+Shift+S -> Toggle Style Lab backdoor
  if (e.altKey && e.shiftKey && key === 's') {
    e.preventDefault();
    store.styleLabOpen.value = !store.styleLabOpen.value;
    return;
  }

  // Alt+/ -> Toggle AI Drawer
  if (e.altKey && e.key === '/') {
    e.preventDefault();
    store.aiDrawerOpen.value = !store.aiDrawerOpen.value;
    return;
  }

  // Alt+, -> Toggle Settings
  if (e.altKey && e.key === ',') {
    e.preventDefault();
    if (store.activeOverlay.value === 'settings') store.closeOverlay();
    else store.openOverlay('settings');
    return;
  }

  // Escape -> Close top-most modals / overlays cleanly (ordered by z-index)
  if (e.key === 'Escape') {
    if (updateModalOpen.value) {
      closeUpdateModal();
      return;
    }
    if (onboarding.isActive.value) {
      onboarding.skipTour();
      return;
    }
    if (store.activeModuleGuide.value) {
      store.closeModuleGuide();
      return;
    }
    if (cardStudioOpen.value) {
      window.dispatchEvent(new Event('vocalcut:request-close-card-studio'));
      return;
    }
    if (store.exportModalWorkspace.value) {
      window.dispatchEvent(new Event('vocalcut:request-close-export'));
      return;
    }
    if (store.referencesModalOpen.value) {
      store.referencesModalOpen.value = false;
      return;
    }
    if (store.styleLabOpen.value) {
      store.styleLabOpen.value = false;
      return;
    }
    if (store.activeOverlay.value !== 'none') {
      store.closeOverlay();
      return;
    }
    if (store.aiDrawerOpen.value) {
      store.aiDrawerOpen.value = false;
      return;
    }
  }

  // Undo / Redo (blocked while modals/overlays are open so exports cannot be aborted by stray Ctrl+Z)
  const modalBlockingUndo = Boolean(
    cardStudioOpen.value
    || store.exportModalWorkspace.value
    || store.activeOverlay.value !== 'none'
    || store.activeModuleGuide.value
    || store.referencesModalOpen.value
    || store.styleLabOpen.value
    || updateModalOpen.value,
  );
  if (!modalBlockingUndo && mod && !e.altKey && (!isEditingTarget(e.target) || (
    e.target instanceof HTMLInputElement && ['range', 'checkbox', 'radio'].includes(e.target.type)
  ))) {
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      store.undo();
      return;
    }
    if ((key === 'z' && e.shiftKey) || key === 'y') {
      e.preventDefault();
      store.redo();
      return;
    }
  }

  // Single-key transport shortcuts disabled inside inputs
  if (isEditingTarget(e.target) || mod || e.altKey) return;

  if (
    cardStudioOpen.value
    || store.activeOverlay.value !== 'none'
    || store.exportModalWorkspace.value
    || store.activeWorkspace.value === 'studio'
  ) return;
  if (
    store.activeWorkspace.value === 'research' &&
    store.researchTab.value === 'main' &&
    (key === 'p' || (e.code === 'Space' && !(e.target instanceof HTMLButtonElement)))
  ) {
    e.preventDefault();
    window.dispatchEvent(new Event('vocalcut:annotation-play'));
    return;
  }
  if (
    store.activeWorkspace.value === 'research' &&
    store.researchTab.value === 'm27' &&
    (key === 'p' || (e.code === 'Space' && !(e.target instanceof HTMLButtonElement)))
  ) {
    e.preventDefault();
    window.dispatchEvent(new Event('vocalcut:m27-play'));
    return;
  }
  if (e.code === 'Space' && !(e.target instanceof HTMLButtonElement)) {
    e.preventDefault();
    if (store.isPlaying.value) {
      store.stopPlayback();
    } else {
      void store.playAudioBuffer();
    }
  } else if (key === 'p') {
    e.preventDefault();
    void store.playAudioBuffer();
  }
}

const bootReadyTasks = ref<Promise<unknown>>();

onMounted(() => {
  document.title = APP_WINDOW_TITLE;
  const imagesReady = loadWorkspaceImages().catch(() => {});
  const speakerReady = initializeSpeakerReferences().catch(() => {
    store.pushToast('无法恢复本机声纹，已使用默认声纹', 'warning');
  });
  window.addEventListener('keydown', onGlobalKeyDown);
  const engineReady = store.probeEngine().catch(() => {});
  bootReadyTasks.value = Promise.all([imagesReady, speakerReady, engineReady]);
  window.addEventListener('resize', updateDesktop);
});

watch(workspaceIconUrl, (icon) => {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link) {
    if (activeWorkspaceIcon.value) link.removeAttribute('type');
    else link.type = 'image/png';
    link.href = icon;
  }
  void setDesktopWindowIcon(icon);
}, { immediate: true });

onBeforeUnmount(() => {
  window.clearTimeout(autoTourTimer);
  window.clearTimeout(autoUpdateTimer);
  cancelUpdateCheck();
  window.removeEventListener('keydown', onGlobalKeyDown);
  window.removeEventListener('resize', updateDesktop);
});

watch(
  startupBootCompleted,
  (booted) => {
    if (!booted || startupUpdateChecked) return;
    startupUpdateChecked = true;
    autoUpdateTimer = window.setTimeout(() => {
      void checkForAppUpdate({ silent: true });
    }, 2200);
  },
  { immediate: true },
);

watch(
  [
    startupBootCompleted,
    () => store.activeWorkspace.value,
    () => store.researchTab.value,
    () => store.studioTab.value,
    () => store.activeOverlay.value,
    () => store.activeModuleGuide.value,
    () => store.exportModalWorkspace.value,
    () => store.referencesModalOpen.value,
    () => store.styleLabOpen.value,
    () => cardStudioOpen.value,
    () => cardDemoNoticeOpen.value,
  ],
  ([booted]) => {
    window.clearTimeout(autoTourTimer);
    if (!booted) return;
    const pageId = onboarding.resolvePageIdFromWorkbench(store);
    if (!pageId) {
      if (onboarding.isActive.value) {
        onboarding.pauseWithoutCompleting();
      }
      return;
    }
    if (onboarding.isActive.value && onboarding.activePageId.value !== pageId) {
      onboarding.pauseWithoutCompleting();
    }
    autoTourTimer = window.setTimeout(() => {
      const latestPageId = onboarding.resolvePageIdFromWorkbench(store);
      if (latestPageId) {
        onboarding.maybeAutoStart(latestPageId);
      }
    }, 280);
  },
  { immediate: true },
);
</script>

<template>
  <div
    class="app-shell"
    :style="shellSize"
    :data-density="store.layoutDensity.value"
    :data-ai-dock="store.aiDrawerDockMode.value"
  >
    <!-- 6-Preset High-Clarity Tech Backdrop -->
    <TechBackdrop />

    <!-- Centered 3-Column Workstation Header -->
    <TopBar />

    <!-- Main Body Row (Active Workspace / Full-Viewport Overlay + Docked or Overlay AI Drawer) -->
    <div class="body-row" :class="{ 'ai-overlay-mode': isOverlayDock }">
      <!-- Full-Viewport Overlays -->
      <SettingsView v-if="store.activeOverlay.value === 'settings'" />
      <GuideView v-else-if="store.activeOverlay.value === 'guide'" />
      <ModelReportView v-else-if="store.activeOverlay.value === 'model-report'" />
      <AboutView v-else-if="store.activeOverlay.value === 'about'" />

      <!-- Interconnected Main Workspaces with Unified Navigation Bar -->
      <template v-else>
        <aside
          v-if="store.navPlacement.value === 'left'"
          class="actbar"
          data-tour="nav-rail"
          aria-label="工作台导航"
        >
          <button
            v-for="item in WORKBENCH_NAV_ITEMS"
            :key="item.id"
            type="button"
            class="act-btn"
            :class="{ active: isWorkbenchNavActive(store, item) }"
            :aria-current="isWorkbenchNavActive(store, item) ? 'page' : undefined"
            :title="item.title"
            @click="selectWorkbenchNav(store, item)"
          >
            <NavArtwork :item="item.artwork" toolbar />
            <span v-if="item.sidebarLines" class="act-label">
              <span v-for="(line, idx) in item.sidebarLines" :key="idx">{{ line }}</span>
            </span>
            <span v-else class="act-label">{{ item.shortLabel ?? item.label }}</span>
          </button>
          <div class="actbar-footer">
            <a
              class="act-github-link"
              :class="{ 'is-compact': isCompactRailGithub }"
              :href="APP_REPO_URL"
              target="_blank"
              rel="noopener noreferrer"
              :title="`GitHub 仓库 · ${APP_REPO_URL}`"
              :aria-label="`GitHub 开源仓库 ${APP_REPO_SLUG}`"
            >
              <NavArtwork item="github" toolbar theme-tint />
              <span v-if="!isCompactRailGithub" class="act-label">GitHub</span>
            </a>
            <button
              type="button"
              class="act-dock-toggle"
              title="将导航按钮移至顶部"
              aria-label="将导航按钮移至顶部"
              @click="store.setLayoutPrefs({ navPlacement: 'top' })"
            >
              <NavArtwork item="dock-toggle" toolbar />
            </button>
          </div>
        </aside>
        <component :is="ExploreWorkspace" v-if="ExploreWorkspace && store.activeWorkspace.value === 'explore'" />
        <HomeView v-else-if="store.activeWorkspace.value === 'home'" />
        <ResearchWorkbenchView v-else-if="store.activeWorkspace.value === 'research'" />
        <StudioView v-else />
      </template>

      <!-- Subtle Scrim when AI Drawer is in floating overlay mode -->
      <Transition name="ai-scrim">
        <div
          v-if="isOverlayDock && store.aiDrawerOpen.value"
          class="ai-drawer-scrim"
          aria-hidden="true"
          @click="store.aiDrawerOpen.value = false"
        />
      </Transition>

      <!-- Right-side AI Assistant Drawer (Docked squeeze or Floating overlay) -->
      <Transition name="ai-drawer">
        <AiDrawer v-if="store.aiDrawerOpen.value" :class="{ 'is-overlay': isOverlayDock }" />
      </Transition>
    </div>

    <!-- Compact Workstation Statusbar -->
    <footer class="statusbar">
      <div class="status-left">
        <span class="status-engine">
          <i
            :class="
              store.engineStatus.value === 'python-vtl' || store.engineStatus.value === 'wasm-vtl'
                ? 'dot-ok'
                : 'dot-warn'
            "
          />
          {{ engineStatusLabel }}
        </span>
        <span class="mono status-meta">
          48,000 Hz <span class="status-divider">/</span> 工程修订 {{ store.revision.value }}
        </span>
      </div>
      <div class="mono status-right">
        <span>{{ paletteLabel }} · {{ skinLabel }} · {{ backdropLabel }}</span>
        <span>{{ ['webgpu-high', 'cuda'].includes(store.computeDevice.value) ? '本地 GPU' : '本地 CPU' }}</span>
        <span>{{ store.interfaceFonts.value.fontSizePx }}px · {{ Math.round(store.pageScale.value * 100) }}%</span>
        <i class="status-sep" aria-hidden="true" />
        <a
          class="status-github-link"
          :class="{ 'is-compact': isCompactStatusGithub }"
          :href="APP_REPO_URL"
          target="_blank"
          rel="noopener noreferrer"
          :title="`GitHub 开源仓库 · ${APP_REPO_URL}`"
          :aria-label="`GitHub 开源仓库 ${APP_REPO_SLUG}`"
        >
          <NavArtwork item="github" toolbar theme-tint class="status-github-art" />
          <span v-if="!isCompactStatusGithub">GitHub</span>
        </a>
      </div>
    </footer>

    <!-- Floating Style Lab Backdoor, Modals & Toasts -->
    <StartupSplash :ready-tasks="bootReadyTasks" />
    <StyleLabBackdoor />
    <ReferencesModal />
    <ExportModal />
    <ModuleGuideModal />
    <SpotlightTourOverlay />
    <UpdateModal />
    <component :is="EditionCardModal" v-if="EditionCardModal" />
    <ToastHost />
    <TooltipHost />
  </div>
</template>

<style scoped>
.body-row {
  position: relative;
}

.ai-drawer-scrim {
  position: absolute;
  inset: 0;
  z-index: 28;
  background: rgba(8, 12, 22, 0.22);
  backdrop-filter: blur(1.5px);
}

:deep(.assistant-pane) {
  transition:
    transform var(--dur-med, 210ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    opacity var(--dur-med, 210ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1));
}

:deep(.assistant-pane.is-overlay) {
  position: absolute;
  top: 6px;
  right: 8px;
  bottom: 6px;
  width: 348px;
  max-width: calc(100% - 16px);
  z-index: 32;
  border: var(--border-w, 1px) solid var(--panel-border);
  border-radius: var(--r-panel);
  background: var(--popover-bg);
  backdrop-filter: var(--glass-backdrop);
  box-shadow: var(--popover-shadow);
}

.ai-drawer-enter-active,
.ai-drawer-leave-active {
  transition:
    transform var(--dur-med, 210ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1)),
    opacity var(--dur-fast, 165ms) var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1));
}

.ai-drawer-enter-from,
.ai-drawer-leave-to {
  transform: translateX(18px);
  opacity: 0;
}

.ai-scrim-enter-active,
.ai-scrim-leave-active {
  transition: opacity var(--dur-fast, 165ms) ease;
}

.ai-scrim-enter-from,
.ai-scrim-leave-to {
  opacity: 0;
}

.statusbar {
  background: color-mix(in srgb, var(--sidebar) var(--glass-alpha), transparent);
  backdrop-filter: var(--glass-backdrop);
  border-top: 1px solid var(--panel-border);
  font-size: 0.875rem;
  font-variant-numeric: tabular-nums;
}

.status-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  overflow: hidden;
}

.status-engine {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.status-meta {
  white-space: nowrap;
  flex: none;
}

.status-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  white-space: nowrap;
}

.actbar-footer {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 100%;
  flex: none;
}

.actbar-footer .act-dock-toggle {
  margin-top: 0;
}

.act-github-link {
  width: 60px;
  padding: 6px 3px;
  border: var(--border-w, 1px) solid transparent;
  border-radius: var(--r-ctrl);
  background: transparent;
  color: var(--muted);
  text-decoration: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  font-size: 0.78rem;
  font-weight: 500;
  transition:
    color var(--dur-fast, 165ms) var(--ease-out-expo, ease),
    background-color var(--dur-fast, 165ms) var(--ease-out-expo, ease),
    border-color var(--dur-fast, 165ms) var(--ease-out-expo, ease),
    box-shadow var(--dur-fast, 165ms) var(--ease-out-expo, ease);
}

.act-github-link .act-label {
  min-height: 1lh;
}

.act-github-link.is-compact {
  width: 34px;
  height: 28px;
  padding: 0;
}

.act-github-link:hover {
  color: var(--accent);
  background: color-mix(in srgb, var(--selected) 72%, transparent);
  border-color: color-mix(in srgb, var(--accent) 36%, var(--panel-border));
}

.status-sep {
  width: 1px;
  height: 12px;
  background: var(--panel-border);
  opacity: 0.7;
}

.status-github-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 19px;
  padding: 0 7px;
  border-radius: var(--r-pill);
  border: var(--border-w, 1px) solid color-mix(in srgb, var(--panel-border) 75%, transparent);
  background: color-mix(in srgb, var(--ctrl-bg) 55%, transparent);
  color: var(--muted);
  text-decoration: none;
  font-size: 0.79rem;
  line-height: 1;
  transition:
    color var(--dur-fast, 165ms) var(--ease-out-expo, ease),
    background-color var(--dur-fast, 165ms) var(--ease-out-expo, ease),
    border-color var(--dur-fast, 165ms) var(--ease-out-expo, ease);
}

.status-github-link.is-compact {
  width: 22px;
  padding: 0;
  justify-content: center;
}

.status-github-link:hover {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, var(--panel));
  border-color: color-mix(in srgb, var(--accent) 44%, var(--panel-border));
}

.status-github-art {
  width: 14px;
  height: 14px;
}

.act-github-link:focus-visible,
.status-github-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}
</style>
