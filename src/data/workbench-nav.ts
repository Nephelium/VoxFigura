import { exploreLabel } from '@vocalcut/edition';
import { recordRecentTool } from '@/data/recent-tools';
import type { ResearchTabId, StudioTabId, WorkbenchStore, WorkspaceId } from '@/stores/workbench';

export interface WorkbenchNavItem {
  id: string;
  workspace: WorkspaceId;
  researchTab?: ResearchTabId;
  studioTab?: StudioTabId;
  label: string;
  shortLabel?: string;
  sidebarLines?: readonly string[];
  artwork: string;
  title: string;
}

export const WORKBENCH_NAV_ITEMS: readonly WorkbenchNavItem[] = [
  ...(exploreLabel
    ? [
        {
          id: 'explore',
          workspace: 'explore' as const,
          label: exploreLabel,
          artwork: 'assistant',
          title: exploreLabel,
        },
      ]
    : [
        { id: 'home', workspace: 'home' as const, label: '首页', artwork: 'home', title: '首页' },
      ]),
  {
    id: 'main',
    workspace: 'research',
    researchTab: 'main',
    label: '语音合成',
    artwork: 'main',
    title: '语音合成 · 多轨联动时间轴与瞬时物理三联图',
  },
  {
    id: 'ipa',
    workspace: 'research',
    researchTab: 'ipa',
    label: '国际音标表 Plus',
    sidebarLines: ['国际音标表', 'Plus'],
    artwork: 'ipa',
    title: '国际音标表 Plus（IPA / extIPA / VoQS）',
  },
  {
    id: 'm27',
    workspace: 'research',
    researchTab: 'm27',
    label: '声道动态重建',
    sidebarLines: ['声道动态', '重建'],
    artwork: 'm27',
    title: 'VoxFigura 声道动态重建与三视图解剖',
  },
  {
    id: 'mixer',
    workspace: 'research',
    researchTab: 'mixer',
    label: '发声调音台',
    sidebarLines: ['发声', '调音台'],
    artwork: 'mixer',
    title: '发声调音台 · 发声类型时变调制与双人声音属性混合',
  },
  {
    id: 'continuum',
    workspace: 'research',
    researchTab: 'continuum',
    label: '声道连续统',
    artwork: 'continuum',
    title: '20 格生理连续统实验刺激矩阵',
  },
  {
    id: 'dialect',
    workspace: 'research',
    researchTab: 'dialect',
    label: '发音字典管理',
    artwork: 'dialect',
    title: '方言调型手绘与三类非递归连读变调工作室',
  },
  {
    id: 'arranger',
    workspace: 'studio',
    studioTab: 'arranger',
    label: '编曲',
    artwork: 'arranger',
    title: '逐字简谱、钢琴卷帘与键盘预听',
  },
  {
    id: 'stage',
    workspace: 'studio',
    studioTab: 'stage',
    label: '剪辑',
    artwork: 'studio',
    title: '多轨剪辑与节目监看',
  },
];

export function isWorkbenchNavActive(store: WorkbenchStore, item: WorkbenchNavItem): boolean {
  if (store.activeOverlay.value !== 'none') return false;
  if (store.activeWorkspace.value !== item.workspace) return false;
  if (item.workspace === 'research') return store.researchTab.value === item.researchTab;
  if (item.workspace === 'studio') return store.studioTab.value === item.studioTab;
  return true;
}

export function selectWorkbenchNav(store: WorkbenchStore, item: WorkbenchNavItem): void {
  if (item.researchTab) store.researchTab.value = item.researchTab;
  if (item.studioTab) store.studioTab.value = item.studioTab;
  recordRecentTool(item.id);
  store.setWorkspace(item.workspace);
}
