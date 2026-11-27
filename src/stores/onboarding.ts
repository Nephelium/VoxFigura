/**
 * Onboarding Spotlight Tour state store (persisted in localStorage under `vc.onboarding.v1`).
 * Tracks first-visit completion per workspace, global auto-prompt toggle, and active step state.
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { exploreLabel } from '@vocalcut/edition';
import {
  getAvailableTourList,
  getTourDefinition,
  type TourDefinition,
  type TourPageId,
  type TourStep,
} from '@/data/onboarding-tours';
import { selectWorkbenchNav, WORKBENCH_NAV_ITEMS } from '@/data/workbench-nav';
import {
  cardDemoNoticeOpen,
  cardStudioOpen,
  closeCardStudio,
  openCardStudio,
} from '@/components/phonetic-card/session';
import type { WorkbenchStore } from '@/stores/workbench';

const STORAGE_KEY = 'vc.onboarding.v1';

interface PersistedOnboardingState {
  autoEnabled: boolean;
  completedPages: Partial<Record<TourPageId, boolean>>;
}

function loadPersistedState(): PersistedOnboardingState {
  if (typeof window === 'undefined') {
    return { autoEnabled: true, completedPages: {} };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { autoEnabled: true, completedPages: {} };
    const parsed = JSON.parse(raw) as Partial<PersistedOnboardingState> | null;
    if (!parsed || typeof parsed !== 'object') {
      return { autoEnabled: true, completedPages: {} };
    }
    const autoEnabled = typeof parsed.autoEnabled === 'boolean' ? parsed.autoEnabled : true;
    const completedPages: Partial<Record<TourPageId, boolean>> = {};
    if (parsed.completedPages && typeof parsed.completedPages === 'object') {
      for (const [k, v] of Object.entries(parsed.completedPages)) {
        if (v === true) {
          completedPages[k as TourPageId] = true;
        }
      }
    }
    return { autoEnabled, completedPages };
  } catch {
    return { autoEnabled: true, completedPages: {} };
  }
}

function savePersistedState(state: PersistedOnboardingState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota or private browsing errors
  }
}

export interface OnboardingStore {
  autoEnabled: Ref<boolean>;
  completedPages: Ref<Partial<Record<TourPageId, boolean>>>;
  activePageId: Ref<TourPageId | null>;
  activeStepIndex: Ref<number>;
  actionBusy: Ref<boolean>;
  isActive: ComputedRef<boolean>;
  currentTour: ComputedRef<TourDefinition | null>;
  currentStep: ComputedRef<TourStep | null>;
  availableTours: ComputedRef<TourDefinition[]>;
  completedCount: ComputedRef<number>;
  resolvePageIdFromWorkbench: (store: WorkbenchStore) => TourPageId | null;
  resolveCurrentWorkspacePageId: (store: WorkbenchStore) => TourPageId;
  maybeAutoStart: (pageId: TourPageId) => boolean;
  startTour: (pageId: TourPageId) => void;
  pauseWithoutCompleting: () => void;
  openTourAndNavigate: (store: WorkbenchStore, pageId: TourPageId) => void;
  nextStep: () => void;
  prevStep: () => void;
  goToStep: (idx: number) => void;
  finishTour: () => void;
  skipTour: () => void;
  disableAutoAndClose: () => void;
  setAutoEnabled: (enabled: boolean) => void;
  resetPage: (pageId: TourPageId) => void;
  resetAllTours: () => void;
}

let singletonOnboardingStore: OnboardingStore | null = null;
let navTimer: number | undefined;

function createOnboardingStore(): OnboardingStore {
  const initial = loadPersistedState();
  const autoEnabled = ref<boolean>(initial.autoEnabled);
  const completedPages = ref<Partial<Record<TourPageId, boolean>>>(initial.completedPages);
  const activePageId = ref<TourPageId | null>(null);
  const activeStepIndex = ref<number>(0);
  const actionBusy = ref<boolean>(false);

  const isActive = computed(() => activePageId.value !== null);
  const currentTour = computed<TourDefinition | null>(() =>
    activePageId.value ? getTourDefinition(activePageId.value) : null,
  );
  const currentStep = computed<TourStep | null>(() => {
    const tour = currentTour.value;
    if (!tour) return null;
    const idx = Math.max(0, Math.min(activeStepIndex.value, tour.steps.length - 1));
    return tour.steps[idx] ?? null;
  });

  const availableTours = computed(() => getAvailableTourList(Boolean(exploreLabel)));
  const completedCount = computed(
    () => availableTours.value.filter((t) => Boolean(completedPages.value[t.pageId])).length,
  );

  function persist(): void {
    savePersistedState({
      autoEnabled: autoEnabled.value,
      completedPages: { ...completedPages.value },
    });
  }

  function resolveCurrentWorkspacePageId(store: WorkbenchStore): TourPageId {
    const ws = store.activeWorkspace.value;
    if (ws === 'explore') return 'explore';
    if (ws === 'home') return 'home';
    if (ws === 'research') {
      return store.researchTab.value;
    }
    return store.studioTab.value === 'arranger' ? 'arranger' : 'stage';
  }

  function resolvePageIdFromWorkbench(store: WorkbenchStore): TourPageId | null {
    if (
      store.activeOverlay.value !== 'none' ||
      store.activeModuleGuide.value !== null ||
      store.referencesModalOpen.value ||
      store.styleLabOpen.value ||
      cardDemoNoticeOpen.value
    ) {
      return null;
    }
    if (cardStudioOpen.value || store.exportModalWorkspace.value === 'explore') {
      return 'card';
    }
    if (store.exportModalWorkspace.value !== null) {
      return null;
    }
    return resolveCurrentWorkspacePageId(store);
  }

  function startTour(pageId: TourPageId): void {
    if (!getTourDefinition(pageId)) return;
    activePageId.value = pageId;
    activeStepIndex.value = 0;
    actionBusy.value = false;
  }

  function maybeAutoStart(pageId: TourPageId): boolean {
    if (!autoEnabled.value) return false;
    if (activePageId.value !== null) return false;
    if (completedPages.value[pageId]) return false;
    startTour(pageId);
    return true;
  }

  function pauseWithoutCompleting(): void {
    activePageId.value = null;
    activeStepIndex.value = 0;
    actionBusy.value = false;
  }

  function openTourAndNavigate(store: WorkbenchStore, pageId: TourPageId): void {
    if (navTimer !== undefined && typeof window !== 'undefined') {
      window.clearTimeout(navTimer);
      navTimer = undefined;
    }
    store.closeModuleGuide();
    store.closeOverlay();
    store.referencesModalOpen.value = false;
    store.styleLabOpen.value = false;

    if (pageId === 'card') {
      cardDemoNoticeOpen.value = false;
      if (store.exportModalWorkspace.value && store.exportModalWorkspace.value !== 'explore') {
        store.closeExportModal();
      }
      if (!cardStudioOpen.value && store.exportModalWorkspace.value !== 'explore') {
        openCardStudio(resolveCurrentWorkspacePageId(store), { suppressDemoNotice: true });
      }
    } else {
      closeCardStudio();
      if (store.exportModalWorkspace.value) {
        store.closeExportModal();
      }
      const navItem = WORKBENCH_NAV_ITEMS.find((item) => item.id === pageId);
      if (navItem) {
        selectWorkbenchNav(store, navItem);
      }
    }

    if (typeof window === 'undefined') {
      startTour(pageId);
      return;
    }
    const delayMs = pageId === 'card' ? 240 : 180;
    window.requestAnimationFrame(() => {
      navTimer = window.setTimeout(() => {
        navTimer = undefined;
        startTour(pageId);
      }, delayMs);
    });
  }

  function markCompletedAndClose(pageId: TourPageId | null): void {
    if (pageId) {
      completedPages.value = {
        ...completedPages.value,
        [pageId]: true,
      };
      persist();
    }
    activePageId.value = null;
    activeStepIndex.value = 0;
    actionBusy.value = false;
  }

  function finishTour(): void {
    markCompletedAndClose(activePageId.value);
  }

  function skipTour(): void {
    markCompletedAndClose(activePageId.value);
  }

  function nextStep(): void {
    const tour = currentTour.value;
    if (!tour) return;
    if (activeStepIndex.value >= tour.steps.length - 1) {
      finishTour();
      return;
    }
    activeStepIndex.value += 1;
  }

  function prevStep(): void {
    if (!currentTour.value) return;
    activeStepIndex.value = Math.max(0, activeStepIndex.value - 1);
  }

  function goToStep(idx: number): void {
    const tour = currentTour.value;
    if (!tour || !Number.isFinite(idx)) return;
    activeStepIndex.value = Math.max(0, Math.min(Math.trunc(idx), tour.steps.length - 1));
  }

  function disableAutoAndClose(): void {
    autoEnabled.value = false;
    markCompletedAndClose(activePageId.value);
  }

  function setAutoEnabled(enabled: boolean): void {
    autoEnabled.value = enabled;
    persist();
  }

  function resetPage(pageId: TourPageId): void {
    const next = { ...completedPages.value };
    delete next[pageId];
    completedPages.value = next;
    persist();
  }

  function resetAllTours(): void {
    completedPages.value = {};
    autoEnabled.value = true;
    persist();
  }

  return {
    autoEnabled,
    completedPages,
    activePageId,
    activeStepIndex,
    actionBusy,
    isActive,
    currentTour,
    currentStep,
    availableTours,
    completedCount,
    resolvePageIdFromWorkbench,
    resolveCurrentWorkspacePageId,
    maybeAutoStart,
    startTour,
    pauseWithoutCompleting,
    openTourAndNavigate,
    nextStep,
    prevStep,
    goToStep,
    finishTour,
    skipTour,
    disableAutoAndClose,
    setAutoEnabled,
    resetPage,
    resetAllTours,
  };
}

export function useOnboardingStore(): OnboardingStore {
  if (!singletonOnboardingStore) {
    singletonOnboardingStore = createOnboardingStore();
  }
  return singletonOnboardingStore;
}

export function resetOnboardingStoreForTests(): void {
  if (navTimer !== undefined && typeof window !== 'undefined') {
    window.clearTimeout(navTimer);
    navTimer = undefined;
  }
  singletonOnboardingStore = null;
}
