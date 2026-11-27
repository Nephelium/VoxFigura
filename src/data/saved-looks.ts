import type { AppearanceConfig } from '@/styles/skin-registry';
import type { ColorMode } from '@/styles/themes';

export const MAX_SAVED_LOOKS_PER_MODE = 5;

export interface SavedLookLayout {
  density: 'compact' | 'standard' | 'spacious';
  navPlacement: 'left' | 'top';
  trackScale: 'compact' | 'standard' | 'tall';
  aiDockMode: 'docked' | 'overlay';
  defaultTractViewMode: '2d' | '3d';
  showSplitters: boolean;
  pageScale: number;
  autoPageScale: boolean;
}

export interface SavedLookSnapshot {
  appearance: AppearanceConfig;
  customBackgroundId: string | null;
  layout: SavedLookLayout;
}

export interface SavedLookPreset {
  id: string;
  name: string;
  mode: ColorMode;
  createdAt: number;
  updatedAt: number;
  appearance: AppearanceConfig;
  customBackgroundId: string | null;
  layout: SavedLookLayout;
}

export interface SavedLooksState {
  light: SavedLookPreset[];
  dark: SavedLookPreset[];
  defaultIds: {
    light: string | null;
    dark: string | null;
  };
}

export type SaveLookResult =
  | { ok: true; state: SavedLooksState; preset: SavedLookPreset }
  | { ok: false; code: 'limit_reached'; max: number };

export function emptySavedLooksState(): SavedLooksState {
  return {
    light: [],
    dark: [],
    defaultIds: { light: null, dark: null },
  };
}

function cloneSnapshot(snapshot: SavedLookSnapshot): SavedLookSnapshot {
  return {
    appearance: {
      ...snapshot.appearance,
      backdropCustomColors: [...snapshot.appearance.backdropCustomColors],
      overrides: { ...(snapshot.appearance.overrides ?? {}) },
      fonts: snapshot.appearance.fonts ? { ...snapshot.appearance.fonts } : undefined,
      anatomy: snapshot.appearance.anatomy ? { ...snapshot.appearance.anatomy } : undefined,
      surfaceOpacity: snapshot.appearance.surfaceOpacity
        ? Object.fromEntries(
            Object.entries(snapshot.appearance.surfaceOpacity).map(([k, v]) => [k, { ...v }]),
          )
        : undefined,
    },
    customBackgroundId: snapshot.customBackgroundId ?? null,
    layout: { ...snapshot.layout },
  };
}

function normalizeLayout(raw: unknown): SavedLookLayout {
  const src = raw && typeof raw === 'object' ? (raw as Partial<SavedLookLayout>) : {};
  const density =
    src.density === 'compact' || src.density === 'spacious' ? src.density : 'standard';
  const navPlacement = src.navPlacement === 'top' ? 'top' : 'left';
  const trackScale =
    src.trackScale === 'compact' || src.trackScale === 'tall' ? src.trackScale : 'standard';
  const aiDockMode = src.aiDockMode === 'docked' ? 'docked' : 'overlay';
  const defaultTractViewMode = src.defaultTractViewMode === '3d' ? '3d' : '2d';
  const rawScale = Number(src.pageScale);
  const pageScale =
    Number.isFinite(rawScale) && rawScale >= 0.25 && rawScale <= 1.3 ? rawScale : 1;
  return {
    density,
    navPlacement,
    trackScale,
    aiDockMode,
    defaultTractViewMode,
    showSplitters: src.showSplitters !== false,
    pageScale,
    autoPageScale: src.autoPageScale !== false,
  };
}

function normalizePreset(raw: unknown, mode: ColorMode): SavedLookPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Partial<SavedLookPreset>;
  if (typeof item.id !== 'string' || !item.id.trim()) return null;
  if (!item.appearance || typeof item.appearance !== 'object') return null;
  const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 28) : '未命名搭配';
  const createdAt = typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : Date.now();
  const updatedAt = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : createdAt;
  const cloned = cloneSnapshot({
    appearance: {
      ...(item.appearance as AppearanceConfig),
      themeMode: mode,
    },
    customBackgroundId: typeof item.customBackgroundId === 'string' ? item.customBackgroundId : null,
    layout: normalizeLayout(item.layout),
  });
  return {
    id: item.id.trim(),
    name,
    mode,
    createdAt,
    updatedAt,
    appearance: cloned.appearance,
    customBackgroundId: cloned.customBackgroundId,
    layout: cloned.layout,
  };
}

export function normalizeSavedLooksState(raw: unknown): SavedLooksState {
  if (!raw || typeof raw !== 'object') return emptySavedLooksState();
  const src = raw as Partial<SavedLooksState>;
  const light = Array.isArray(src.light)
    ? src.light
        .map((item) => normalizePreset(item, 'light'))
        .filter((item): item is SavedLookPreset => Boolean(item))
        .slice(0, MAX_SAVED_LOOKS_PER_MODE)
    : [];
  const dark = Array.isArray(src.dark)
    ? src.dark
        .map((item) => normalizePreset(item, 'dark'))
        .filter((item): item is SavedLookPreset => Boolean(item))
        .slice(0, MAX_SAVED_LOOKS_PER_MODE)
    : [];
  const rawDefaultLight = typeof src.defaultIds?.light === 'string' ? src.defaultIds.light : null;
  const rawDefaultDark = typeof src.defaultIds?.dark === 'string' ? src.defaultIds.dark : null;
  return {
    light,
    dark,
    defaultIds: {
      light: rawDefaultLight && light.some((item) => item.id === rawDefaultLight) ? rawDefaultLight : null,
      dark: rawDefaultDark && dark.some((item) => item.id === rawDefaultDark) ? rawDefaultDark : null,
    },
  };
}

export function saveLookPreset(
  state: SavedLooksState,
  mode: ColorMode,
  rawName: string,
  snapshot: SavedLookSnapshot,
  now = Date.now(),
): SaveLookResult {
  const list = state[mode];
  if (list.length >= MAX_SAVED_LOOKS_PER_MODE) {
    return { ok: false, code: 'limit_reached', max: MAX_SAVED_LOOKS_PER_MODE };
  }
  const cleanName = rawName.trim().slice(0, 28) || `${mode === 'dark' ? '夜间' : '日间'}搭配 ${list.length + 1}`;
  const cloned = cloneSnapshot({
    ...snapshot,
    appearance: {
      ...snapshot.appearance,
      themeMode: mode,
    },
  });
  const preset: SavedLookPreset = {
    id: `look_${mode}_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: cleanName,
    mode,
    createdAt: now,
    updatedAt: now,
    appearance: cloned.appearance,
    customBackgroundId: cloned.customBackgroundId,
    layout: cloned.layout,
  };
  const nextList = [...list, preset];
  const nextDefaultId = state.defaultIds[mode] ?? preset.id;
  return {
    ok: true,
    preset,
    state: {
      ...state,
      [mode]: nextList,
      defaultIds: {
        ...state.defaultIds,
        [mode]: nextDefaultId,
      },
    },
  };
}

export function updateLookPreset(
  state: SavedLooksState,
  mode: ColorMode,
  id: string,
  snapshot: SavedLookSnapshot,
  nextName?: string,
  now = Date.now(),
): SavedLooksState {
  const list = state[mode];
  if (!list.some((item) => item.id === id)) return state;
  const cloned = cloneSnapshot({
    ...snapshot,
    appearance: {
      ...snapshot.appearance,
      themeMode: mode,
    },
  });
  return {
    ...state,
    [mode]: list.map((item) =>
      item.id === id
        ? {
            ...item,
            name: nextName && nextName.trim() ? nextName.trim().slice(0, 28) : item.name,
            updatedAt: now,
            appearance: cloned.appearance,
            customBackgroundId: cloned.customBackgroundId,
            layout: cloned.layout,
          }
        : item,
    ),
  };
}

export function deleteLookPreset(
  state: SavedLooksState,
  mode: ColorMode,
  id: string,
): SavedLooksState {
  const nextList = state[mode].filter((item) => item.id !== id);
  const nextDefault = state.defaultIds[mode] === id ? null : state.defaultIds[mode];
  return {
    ...state,
    [mode]: nextList,
    defaultIds: {
      ...state.defaultIds,
      [mode]: nextDefault,
    },
  };
}

export function setDefaultLookPreset(
  state: SavedLooksState,
  mode: ColorMode,
  id: string | null,
): SavedLooksState {
  const validId = id && state[mode].some((item) => item.id === id) ? id : null;
  return {
    ...state,
    defaultIds: {
      ...state.defaultIds,
      [mode]: validId,
    },
  };
}
