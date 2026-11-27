import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_TOUR_DEFINITIONS,
  getAvailableTourList,
  TOUR_DEFINITIONS,
  type TourPageId,
} from '../src/data/onboarding-tours';
import { EXPLORE_TOUR_DEFINITION } from '../src/editions/hackathon/tour-explore';
import { isLikelyAudioBuffer } from '../src/data/onboarding-samples';
import { resetOnboardingStoreForTests, useOnboardingStore } from '../src/stores/onboarding';
import { cardDemoNoticeOpen, cardStudioOpen } from '../src/components/phonetic-card/session';
import { colorModeByLocalTime } from '../src/styles/themes';

function makeLocalStorageMock() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => {
      map.clear();
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe('onboarding spotlight tour definitions', () => {
  it('covers all 11 workspaces & card studio with valid steps and clean naming', () => {
    const allDefs = {
      ...BASE_TOUR_DEFINITIONS,
      explore: EXPLORE_TOUR_DEFINITION,
    };
    const allIds = Object.keys(allDefs) as TourPageId[];
    expect(allIds).toHaveLength(11);

    const forbiddenLegacyNames = /\b(Stage\s*4|Stage\s*5|KF2Tract)\b/i;
    const uiEmojiPattern = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

    for (const id of allIds) {
      const def = allDefs[id];
      expect(def.steps.length).toBeGreaterThanOrEqual(3);
      for (const step of def.steps) {
        expect(step.title.trim().length).toBeGreaterThan(0);
        expect(step.body.trim().length).toBeGreaterThan(0);
        expect(step.title).not.toMatch(forbiddenLegacyNames);
        expect(step.body).not.toMatch(forbiddenLegacyNames);
        expect(step.title).not.toMatch(uiEmojiPattern);
        expect(step.body).not.toMatch(uiEmojiPattern);
      }
    }
  });

  it('separates public/friends home vs hackathon explore lists and isolates edition text', () => {
    const publicIds = getAvailableTourList(false).map((t) => t.pageId);
    expect(publicIds).toContain('home');
    expect(publicIds).toContain('card');
    expect(publicIds).not.toContain('explore');
    expect(publicIds).toHaveLength(10);
    expect(TOUR_DEFINITIONS.explore).toBeUndefined();
  });

  it('starts home & explore with style picker and covers rich module steps', () => {
    expect(BASE_TOUR_DEFINITIONS.home.steps[0]?.widget).toBe('appearance-picker');
    expect(EXPLORE_TOUR_DEFINITION.steps[0]?.widget).toBe('appearance-picker');
    const homeIds = BASE_TOUR_DEFINITIONS.home.steps.map((s) => s.id);
    expect(homeIds).toContain('home-synth-speaker');
    expect(homeIds).toContain('home-synth-pose');
    expect(homeIds).toContain('home-synth-render');

    const m27Ids = BASE_TOUR_DEFINITIONS.m27.steps.map((s) => s.id);
    expect(m27Ids).toContain('m27-align');
    expect(m27Ids).toContain('m27-run');
    expect(m27Ids).toContain('m27-transport');
    expect(m27Ids).toContain('m27-transport-tools');
    expect(m27Ids).toContain('m27-glottis');
    expect(m27Ids).toContain('m27-realtime');
    expect(m27Ids).toContain('m27-handoff');
    expect(m27Ids).toContain('m27-guide-btn');
    expect(BASE_TOUR_DEFINITIONS.m27.steps.find((s) => s.id === 'm27-align')?.action?.id).toBe('m27-align-demo');
    expect(BASE_TOUR_DEFINITIONS.m27.steps.find((s) => s.id === 'm27-run')?.action?.id).toBe('m27-run-demo');
    expect(BASE_TOUR_DEFINITIONS.m27.steps.find((s) => s.id === 'm27-transport')?.action?.id).toBe('m27-play-neural');
    expect(BASE_TOUR_DEFINITIONS.m27.steps.find((s) => s.id === 'm27-right')?.action?.id).toBe('m27-toggle-labels');
    expect(BASE_TOUR_DEFINITIONS.m27.steps.length).toBeGreaterThanOrEqual(12);

    const mainIds = BASE_TOUR_DEFINITIONS.main.steps.map((s) => s.id);
    expect(mainIds).toContain('main-files');
    expect(mainIds).toContain('main-g2p-demo');
    expect(mainIds).toContain('main-dict-tools');
    expect(mainIds).toContain('main-trio');
    expect(mainIds).toContain('main-inspector');
    expect(mainIds).toContain('main-timeline-tools');
    expect(mainIds).toContain('main-guide-btn');
    const mainDemoStep = BASE_TOUR_DEFINITIONS.main.steps.find((s) => s.id === 'main-g2p-demo');
    expect(mainDemoStep?.action?.id).toBe('main-compile-voqs-demo');
    expect(mainDemoStep?.body).toContain('今天天气真好。What a gorgeous day! 今日はいい天気ですね。 [ˈnɔ˞məl ˈvɔɪs. {F fɔlˈsɛtʰoʊ F}. {W ˈwɪspʰəɹʷi W}]');
    expect(BASE_TOUR_DEFINITIONS.main.steps.find((s) => s.id === 'main-files')?.action?.id).toBe('main-toggle-corpus-drawer');
    expect(BASE_TOUR_DEFINITIONS.main.steps.find((s) => s.id === 'main-inspector')?.action?.id).toBe('main-toggle-tract-params');
    expect(BASE_TOUR_DEFINITIONS.main.steps.length).toBeGreaterThanOrEqual(11);

    const ipaSteps = BASE_TOUR_DEFINITIONS.ipa.steps;
    const ipaIds = ipaSteps.map((s) => s.id);
    expect(ipaSteps.length).toBeGreaterThanOrEqual(10);
    expect(ipaIds).toContain('ipa-system-tabs');
    expect(ipaIds).toContain('ipa-pose-set');
    expect(ipaIds).toContain('ipa-vowels');
    expect(ipaIds).toContain('ipa-timeline');
    expect(ipaIds).toContain('ipa-tract-viewport');
    expect(ipaIds).toContain('ipa-downloads');
    expect(ipaSteps.find((s) => s.id === 'ipa-vowels')?.action?.id).toBe('ipa-tour-select-y');
    expect(ipaSteps.find((s) => s.id === 'ipa-timeline')?.action?.id).toBe('ipa-tour-play-current');
    expect(ipaSteps.find((s) => s.id === 'ipa-downloads')?.action?.id).toBe('ipa-tour-preview-voqs');
    for (const step of ipaSteps) {
      expect(step.body).not.toContain('655 入口');
      expect(step.body).not.toContain('JD2 / W02');
    }

    const mixerIds = BASE_TOUR_DEFINITIONS.mixer.steps.map((s) => s.id);
    expect(BASE_TOUR_DEFINITIONS.mixer.steps.length).toBeGreaterThanOrEqual(9);
    expect(mixerIds).toContain('mixer-acoustic');
    expect(mixerIds).toContain('mixer-compare');
    expect(mixerIds).toContain('mixer-handoff');
    expect(BASE_TOUR_DEFINITIONS.mixer.steps.find((s) => s.id === 'mixer-input')?.action?.id).toBe('mixer-load-demo');
    expect(BASE_TOUR_DEFINITIONS.continuum.steps.map((s) => s.id)).toContain('continuum-locks');
    const dialectIds = BASE_TOUR_DEFINITIONS.dialect.steps.map((s) => s.id);
    expect(BASE_TOUR_DEFINITIONS.dialect.steps.length).toBeGreaterThanOrEqual(9);
    expect(dialectIds).toContain('dialect-library');
    expect(dialectIds).toContain('dialect-import-export');
    expect(dialectIds).toContain('dialect-list');
    expect(dialectIds).toContain('dialect-editor');
    expect(dialectIds).toContain('dialect-batch');
    expect(dialectIds).toContain('dialect-sandhi-tab');
    expect(dialectIds).toContain('dialect-tools');
    expect(dialectIds).toContain('dialect-tone-board');
    expect(dialectIds).toContain('dialect-guide');
    expect(BASE_TOUR_DEFINITIONS.arranger.steps.length).toBeGreaterThanOrEqual(8);
    const arrangerIds = BASE_TOUR_DEFINITIONS.arranger.steps.map((s) => s.id);
    expect(arrangerIds).toContain('arranger-notation');
    expect(arrangerIds).toContain('arranger-tracks');
    expect(arrangerIds).toContain('arranger-footer');
    expect(BASE_TOUR_DEFINITIONS.arranger.steps.find((s) => s.id === 'arranger-tracks')?.action?.id).toBe('arranger-load-demo');
    expect(BASE_TOUR_DEFINITIONS.stage.steps.length).toBeGreaterThanOrEqual(10);
    const stageIds = BASE_TOUR_DEFINITIONS.stage.steps.map((s) => s.id);
    expect(stageIds).toContain('stage-directory');
    expect(stageIds).toContain('stage-cinema');
    expect(stageIds).toContain('stage-keyframes');
    expect(stageIds).toContain('stage-subtitles');
    expect(stageIds).toContain('stage-beat-sync');
    expect(stageIds).toContain('stage-guide-btn');
    expect(BASE_TOUR_DEFINITIONS.stage.steps.find((s) => s.id === 'stage-media')?.action?.id).toBe('stage-load-demo');
    expect(BASE_TOUR_DEFINITIONS.stage.steps.find((s) => s.id === 'stage-cinema')?.action?.id).toBe('stage-preview-cinema');
    expect(BASE_TOUR_DEFINITIONS.stage.steps.find((s) => s.id === 'stage-keyframes')?.action?.id).toBe('stage-focus-v1');
    expect(BASE_TOUR_DEFINITIONS.stage.steps.find((s) => s.id === 'stage-subtitles')?.action?.id).toBe('stage-focus-v3');

    const cardSteps = BASE_TOUR_DEFINITIONS.card.steps;
    const cardIds = cardSteps.map((s) => s.id);
    expect(cardSteps.length).toBeGreaterThanOrEqual(11);
    expect(cardIds).toContain('card-header');
    expect(cardIds).toContain('card-gallery');
    expect(cardIds).toContain('card-canvas-drag');
    expect(cardIds).toContain('card-stage-toolbar');
    expect(cardIds).toContain('card-timeline');
    expect(cardIds).toContain('card-layout-section');
    expect(cardIds).toContain('card-tree-designer');
    expect(cardIds).toContain('card-inspector-style');
    expect(cardIds).toContain('card-inspector-module');
    expect(cardIds).toContain('card-export-footer');
    expect(cardIds).toContain('card-guide-btn');
    expect(cardSteps.find((s) => s.id === 'card-tree-designer')?.action?.id).toBe('card-demo-split-col');
    expect(cardSteps.find((s) => s.id === 'card-inspector-style')?.action?.id).toBe('card-demo-toggle-header');
    const cardTourText = JSON.stringify(BASE_TOUR_DEFINITIONS.card);
    expect(cardTourText).not.toMatch(/知乎|刘看山|kanshan|zhida[-_]|\bzhihu\b/i);
  });
});

describe('local-time adaptive color mode', () => {
  it('picks light during daytime (06:00-18:59) and dark at night', () => {
    expect(colorModeByLocalTime(new Date(2026, 10, 25, 6, 0, 0))).toBe('light');
    expect(colorModeByLocalTime(new Date(2026, 10, 25, 13, 30, 0))).toBe('light');
    expect(colorModeByLocalTime(new Date(2026, 10, 25, 18, 59, 59))).toBe('light');
    expect(colorModeByLocalTime(new Date(2026, 10, 25, 19, 0, 0))).toBe('dark');
    expect(colorModeByLocalTime(new Date(2026, 10, 25, 23, 30, 0))).toBe('dark');
    expect(colorModeByLocalTime(new Date(2026, 10, 25, 5, 59, 59))).toBe('dark');
  });
});

describe('onboarding audio binary guard', () => {
  it('accepts RIFF/WAVE headers and rejects HTML fallback bytes', () => {
    const wav = new Uint8Array(64);
    wav.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    wav.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
    expect(isLikelyAudioBuffer(wav.buffer)).toBe(true);

    const htmlText = '<!doctype html><html><body>SPA</body></html>';
    const htmlBytes = new TextEncoder().encode(htmlText);
    expect(isLikelyAudioBuffer(htmlBytes.buffer)).toBe(false);

    const tiny = new Uint8Array(12);
    expect(isLikelyAudioBuffer(tiny.buffer)).toBe(false);
  });
});

describe('onboarding store lifecycle & persistence', () => {
  beforeEach(() => {
    resetOnboardingStoreForTests();
    vi.stubGlobal('window', {
      localStorage: makeLocalStorageMock(),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      },
    });
  });

  afterEach(() => {
    resetOnboardingStoreForTests();
    vi.unstubAllGlobals();
  });

  it('triggers only once on first visit and remembers completion', () => {
    const store = useOnboardingStore();
    expect(store.maybeAutoStart('main')).toBe(true);
    expect(store.isActive.value).toBe(true);
    expect(store.activePageId.value).toBe('main');
    expect(store.activeStepIndex.value).toBe(0);

    // Next visit blocked while completed
    const stepCount = store.currentTour.value?.steps.length ?? 0;
    for (let i = 0; i < stepCount; i++) {
      store.nextStep();
    }
    expect(store.isActive.value).toBe(false);
    expect(store.completedPages.value.main).toBe(true);
    expect(store.maybeAutoStart('main')).toBe(false);

    // Reloading store from localStorage still remembers completion
    resetOnboardingStoreForTests();
    const reloaded = useOnboardingStore();
    expect(reloaded.completedPages.value.main).toBe(true);
    expect(reloaded.maybeAutoStart('main')).toBe(false);
  });

  it('supports skip, disable-auto, single-page reset, and full reset', () => {
    const store = useOnboardingStore();
    expect(store.maybeAutoStart('continuum')).toBe(true);
    store.goToStep(99);
    expect(store.activeStepIndex.value).toBe((store.currentTour.value?.steps.length ?? 1) - 1);
    store.prevStep();
    expect(store.activeStepIndex.value).toBe((store.currentTour.value?.steps.length ?? 2) - 2);

    store.skipTour();
    expect(store.isActive.value).toBe(false);
    expect(store.completedPages.value.continuum).toBe(true);

    store.resetPage('continuum');
    expect(store.completedPages.value.continuum).toBeUndefined();
    expect(store.maybeAutoStart('continuum')).toBe(true);

    store.disableAutoAndClose();
    expect(store.autoEnabled.value).toBe(false);
    expect(store.isActive.value).toBe(false);
    expect(store.maybeAutoStart('ipa')).toBe(false);

    store.resetAllTours();
    expect(store.autoEnabled.value).toBe(true);
    expect(store.completedPages.value).toEqual({});
    expect(store.maybeAutoStart('ipa')).toBe(true);
  });

  it('auto-triggers phonetic card tour once on first open and tracks completion', () => {
    const store = useOnboardingStore();
    expect(store.maybeAutoStart('card')).toBe(true);
    expect(store.activePageId.value).toBe('card');
    expect(store.currentTour.value?.steps.length).toBeGreaterThanOrEqual(11);

    // Pausing without completing does not mark card tour completed
    store.pauseWithoutCompleting();
    expect(store.isActive.value).toBe(false);
    expect(store.completedPages.value.card).toBeUndefined();
    expect(store.maybeAutoStart('card')).toBe(true);

    // Finishing marks card tour completed and persists
    store.finishTour();
    expect(store.completedPages.value.card).toBe(true);
    expect(store.maybeAutoStart('card')).toBe(false);
  });

  it('defers card spotlight tour while demo preview notice dialog is open and resumes once dismissed', () => {
    const store = useOnboardingStore();
    const fakeWb = {
      activeWorkspace: { value: 'home' },
      researchTab: { value: 'main' },
      studioTab: { value: 'arranger' },
      activeOverlay: { value: 'none' },
      activeModuleGuide: { value: null },
      exportModalWorkspace: { value: null },
      referencesModalOpen: { value: false },
      styleLabOpen: { value: false },
    };
    try {
      cardStudioOpen.value = true;
      cardDemoNoticeOpen.value = true;
      expect(store.resolvePageIdFromWorkbench(fakeWb as never)).toBeNull();

      cardDemoNoticeOpen.value = false;
      expect(store.resolvePageIdFromWorkbench(fakeWb as never)).toBe('card');
    } finally {
      cardDemoNoticeOpen.value = false;
      cardStudioOpen.value = false;
    }
  });
});
