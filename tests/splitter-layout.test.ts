import { beforeEach, describe, expect, it } from 'vitest';
import {
  SPLITTER_DEFAULTS_KEY,
  clearSessionSplitterValue,
  getActiveSplitterValue,
  getConfiguredSplitterDefault,
  isSplitterCustomized,
  resetAllSplittersToFactory,
  resetSplitterToFactory,
  saveSessionSplitterValue,
  setConfiguredSplitterDefault,
} from '@/data/splitter-layout';

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

describe('splitter-layout persistent defaults and session overrides', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createMemoryStorage(),
      configurable: true,
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: createMemoryStorage(),
      configurable: true,
    });
  });

  it('persists configured startup defaults and rejects out-of-range inputs without silent clamping', () => {
    expect(getConfiguredSplitterDefault('m27Cols.right')).toBe(380);
    expect(isSplitterCustomized('m27Cols.right')).toBe(false);

    const bad = setConfiguredSplitterDefault('m27Cols.right', 900);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe('out_of_range');
      expect(bad.allowed).toEqual([280, 620]);
    }
    expect(getConfiguredSplitterDefault('m27Cols.right')).toBe(380);

    const ok = setConfiguredSplitterDefault('m27Cols.right', 440);
    expect(ok).toEqual({ ok: true, value: 440 });
    expect(getConfiguredSplitterDefault('m27Cols.right')).toBe(440);
    expect(getActiveSplitterValue('m27Cols.right')).toBe(440);
    expect(isSplitterCustomized('m27Cols.right')).toBe(true);
    expect(JSON.parse(localStorage.getItem(SPLITTER_DEFAULTS_KEY) ?? '{}')).toEqual({
      'm27Cols.right': 440,
    });
  });

  it('keeps temporary session drags separate from configured startup defaults and resets cleanly', () => {
    setConfiguredSplitterDefault('research-left', 268);
    saveSessionSplitterValue('research-left', 320);

    expect(getActiveSplitterValue('research-left')).toBe(320);
    expect(getConfiguredSplitterDefault('research-left')).toBe(268);

    // Clearing session (simulating new startup or double-clicking handle) returns configured default
    clearSessionSplitterValue('research-left');
    expect(getActiveSplitterValue('research-left')).toBe(268);

    // Factory reset restores original built-in default
    expect(resetSplitterToFactory('research-left')).toBe(248);
    expect(getConfiguredSplitterDefault('research-left')).toBe(248);
    expect(isSplitterCustomized('research-left')).toBe(false);

    // Global reset clears everything
    setConfiguredSplitterDefault('research-mixer-rail', 420);
    saveSessionSplitterValue('studio-left', 310);
    resetAllSplittersToFactory();
    expect(getConfiguredSplitterDefault('research-mixer-rail')).toBe(384);
    expect(getActiveSplitterValue('studio-left')).toBe(360);
  });

  it('uses responsive Explore defaults without overriding saved pixel widths', () => {
    expect(getActiveSplitterValue('explore-left', undefined, 684)).toBe(684);
    expect(getActiveSplitterValue('explore-right', undefined, 684)).toBe(684);
    setConfiguredSplitterDefault('explore-right', 460);
    saveSessionSplitterValue('explore-right', 710);
    expect(getActiveSplitterValue('explore-right', undefined, 512)).toBe(710);
    clearSessionSplitterValue('explore-right');
    expect(getActiveSplitterValue('explore-right', undefined, 512)).toBe(460);
    resetSplitterToFactory('explore-right');
    expect(getActiveSplitterValue('explore-right', undefined, 512)).toBe(512);
  });
});
