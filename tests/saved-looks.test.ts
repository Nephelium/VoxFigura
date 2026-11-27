import { describe, expect, it } from 'vitest';
import {
  MAX_SAVED_LOOKS_PER_MODE,
  deleteLookPreset,
  emptySavedLooksState,
  normalizeSavedLooksState,
  saveLookPreset,
  setDefaultLookPreset,
  updateLookPreset,
  type SavedLookSnapshot,
} from '../src/data/saved-looks';
import { defaultAppearance } from '../src/styles/skin-registry';

function makeSnapshot(overrides?: Partial<SavedLookSnapshot>): SavedLookSnapshot {
  return {
    appearance: {
      ...defaultAppearance(),
      surfaceStyle: 'neumorphism',
      paletteId: 'codex',
      backdropId: 'aurora',
    },
    customBackgroundId: null,
    layout: {
      density: 'standard',
      navPlacement: 'left',
      trackScale: 'standard',
      aiDockMode: 'overlay',
      defaultTractViewMode: '2d',
      showSplitters: true,
      pageScale: 1,
      autoPageScale: true,
    },
    ...overrides,
  };
}

describe('saved day/night look presets', () => {
  it('stores up to 5 light and 5 dark presets independently and rejects a 6th per mode', () => {
    let state = emptySavedLooksState();
    for (let i = 1; i <= MAX_SAVED_LOOKS_PER_MODE; i += 1) {
      const res = saveLookPreset(state, 'light', `日间 ${i}`, makeSnapshot(), 1000 + i);
      expect(res.ok).toBe(true);
      if (res.ok) state = res.state;
    }
    const sixthLight = saveLookPreset(state, 'light', '日间 6', makeSnapshot(), 2000);
    expect(sixthLight).toEqual({ ok: false, code: 'limit_reached', max: 5 });
    expect(state.light).toHaveLength(5);

    for (let i = 1; i <= MAX_SAVED_LOOKS_PER_MODE; i += 1) {
      const res = saveLookPreset(state, 'dark', `夜间 ${i}`, makeSnapshot(), 3000 + i);
      expect(res.ok).toBe(true);
      if (res.ok) state = res.state;
    }
    const sixthDark = saveLookPreset(state, 'dark', '夜间 6', makeSnapshot(), 4000);
    expect(sixthDark).toEqual({ ok: false, code: 'limit_reached', max: 5 });
    expect(state.dark).toHaveLength(5);
  });

  it('auto-selects the first saved preset per mode as default and manages switching, updating, and deletion', () => {
    let state = emptySavedLooksState();
    const first = saveLookPreset(state, 'dark', '纯黑仪器', makeSnapshot(), 100);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    state = first.state;
    expect(state.defaultIds.dark).toBe(first.preset.id);
    expect(state.defaultIds.light).toBeNull();

    const second = saveLookPreset(
      state,
      'dark',
      '夜幕磨砂',
      makeSnapshot({ layout: { ...makeSnapshot().layout, navPlacement: 'top' } }),
      200,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    state = second.state;
    expect(state.defaultIds.dark).toBe(first.preset.id);

    state = setDefaultLookPreset(state, 'dark', second.preset.id);
    expect(state.defaultIds.dark).toBe(second.preset.id);

    state = updateLookPreset(
      state,
      'dark',
      second.preset.id,
      makeSnapshot({
        appearance: { ...defaultAppearance(), surfaceStyle: 'glass', paletteId: 'night-owl' },
      }),
      '夜幕极透',
      300,
    );
    const updated = state.dark.find((item) => item.id === second.preset.id);
    expect(updated?.name).toBe('夜幕极透');
    expect(updated?.appearance.surfaceStyle).toBe('glass');
    expect(updated?.appearance.themeMode).toBe('dark');

    state = deleteLookPreset(state, 'dark', second.preset.id);
    expect(state.dark).toHaveLength(1);
    expect(state.defaultIds.dark).toBeNull();
  });

  it('normalizes malformed persisted payloads and trims excess items safely', () => {
    const raw = {
      light: Array.from({ length: 7 }, (_, i) => ({
        id: `l-${i}`,
        name: `方案 ${i}`,
        mode: 'light',
        appearance: defaultAppearance(),
        layout: { navPlacement: 'top' },
      })),
      dark: [{ id: '', name: 'bad' }],
      defaultIds: { light: 'l-6', dark: 'missing' },
    };
    const norm = normalizeSavedLooksState(raw);
    expect(norm.light).toHaveLength(5);
    expect(norm.dark).toHaveLength(0);
    expect(norm.defaultIds.light).toBeNull();
    expect(norm.defaultIds.dark).toBeNull();
  });
});
