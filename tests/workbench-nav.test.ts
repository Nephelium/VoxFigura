import { describe, expect, it } from 'vitest';
import {
  WORKBENCH_NAV_ITEMS,
  isWorkbenchNavActive,
  selectWorkbenchNav,
} from '../src/data/workbench-nav';
import { useWorkbenchStore } from '../src/stores/workbench';

describe('unified workbench navigation', () => {
  it('places arranger above clip immediately below dialect with updated labels and clip icon', () => {
    const ids = WORKBENCH_NAV_ITEMS.map((item) => item.id);
    const labels = WORKBENCH_NAV_ITEMS.map((item) => item.label);
    const clipItem = WORKBENCH_NAV_ITEMS.find((item) => item.id === 'stage');
    expect(ids).toEqual(['home', 'main', 'ipa', 'm27', 'mixer', 'continuum', 'dialect', 'arranger', 'stage']);
    expect(labels).toEqual([
      '首页',
      '语音合成',
      '国际音标表 Plus',
      '声道动态重建',
      '发声调音台',
      '声道连续统',
      '发音字典管理',
      '编曲',
      '剪辑',
    ]);
    expect(clipItem?.artwork).toBe('studio');
  });

  it('switches workspace tabs and overlay cleanly while preserving underlying store state', () => {
    const store = useWorkbenchStore();
    const home = WORKBENCH_NAV_ITEMS.find((i) => i.id === 'home')!;
    const arranger = WORKBENCH_NAV_ITEMS.find((i) => i.id === 'arranger')!;
    const stage = WORKBENCH_NAV_ITEMS.find((i) => i.id === 'stage')!;
    const dialect = WORKBENCH_NAV_ITEMS.find((i) => i.id === 'dialect')!;

    expect(isWorkbenchNavActive(store, home)).toBe(true);

    selectWorkbenchNav(store, arranger);
    expect(store.activeWorkspace.value).toBe('studio');
    expect(store.studioTab.value).toBe('arranger');
    expect(isWorkbenchNavActive(store, arranger)).toBe(true);
    expect(isWorkbenchNavActive(store, stage)).toBe(false);

    selectWorkbenchNav(store, dialect);
    expect(store.activeWorkspace.value).toBe('research');
    expect(store.researchTab.value).toBe('dialect');
    expect(isWorkbenchNavActive(store, dialect)).toBe(true);
    expect(isWorkbenchNavActive(store, arranger)).toBe(false);

    store.openOverlay('settings');
    expect(isWorkbenchNavActive(store, dialect)).toBe(false);

    selectWorkbenchNav(store, stage);
    expect(store.activeOverlay.value).toBe('none');
    expect(store.activeWorkspace.value).toBe('studio');
    expect(store.studioTab.value).toBe('stage');
    expect(isWorkbenchNavActive(store, stage)).toBe(true);
    selectWorkbenchNav(store, home);
    expect(isWorkbenchNavActive(store, home)).toBe(true);
  });

  it('defaults navPlacement to left and toggles cleanly to top and back', () => {
    const store = useWorkbenchStore();
    expect(store.navPlacement.value).toBe('left');
    store.setLayoutPrefs({ navPlacement: 'top' });
    expect(store.navPlacement.value).toBe('top');
    store.setLayoutPrefs({ navPlacement: 'left' });
    expect(store.navPlacement.value).toBe('left');
  });
});
