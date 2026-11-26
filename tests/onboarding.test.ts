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
  it('covers all 10 workspaces with valid steps and clean naming', () => {
    const allDefs = {
      ...BASE_TOUR_DEFINITIONS,
      explore: EXPLORE_TOUR_DEFINITION,
    };
    const allIds = Object.keys(allDefs) as TourPageId[];
    expect(allIds).toHaveLength(10);

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
    expect(publicIds).not.toContain('explore');
    expect(publicIds).toHaveLength(9);
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
    expect(m27Ids).toContain('m27-realtime');
    expect(m27Ids).toContain('m27-handoff');
    expect(BASE_TOUR_DEFINITIONS.m27.steps.find((s) => s.id === 'm27-align')?.action?.id).toBe('m27-align-demo');
    expect(BASE_TOUR_DEFINITIONS.m27.steps.find((s) => s.id === 'm27-run')?.action?.id).toBe('m27-run-demo');
    expect(BASE_TOUR_DEFINITIONS.m27.steps.find((s) => s.id === 'm27-transport')?.action?.id).toBe('m27-play-neural');
    expect(BASE_TOUR_DEFINITIONS.m27.steps.length).toBeGreaterThanOrEqual(9);

    const mainIds = BASE_TOUR_DEFINITIONS.main.steps.map((s) => s.id);
    expect(mainIds).toContain('main-g2p-demo');
    expect(mainIds).toContain('main-trio');
    expect(mainIds).toContain('main-inspector');
    const mainDemoStep = BASE_TOUR_DEFINITIONS.main.steps.find((s) => s.id === 'main-g2p-demo');
    expect(mainDemoStep?.action?.id).toBe('main-compile-voqs-demo');
    expect(mainDemoStep?.body).toContain('今天天气真好。What a gorgeous day! 今日はいい天気ですね。 [ˈnɔ˞məl ˈvɔɪs. {F fɔlˈsɛtʰoʊ F}. {W ˈwɪspʰəɹʷi W}]');
    expect(BASE_TOUR_DEFINITIONS.main.steps.length).toBeGreaterThanOrEqual(8);

    expect(BASE_TOUR_DEFINITIONS.mixer.steps.length).toBeGreaterThanOrEqual(6);
    expect(BASE_TOUR_DEFINITIONS.continuum.steps.map((s) => s.id)).toContain('continuum-locks');
    expect(BASE_TOUR_DEFINITIONS.arranger.steps.length).toBeGreaterThanOrEqual(6);
    expect(BASE_TOUR_DEFINITIONS.stage.steps.length).toBeGreaterThanOrEqual(6);
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
});
