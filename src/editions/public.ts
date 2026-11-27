import { defineAsyncComponent, type Component } from 'vue';
import type { MethodReference } from '@/data/references';
import type { CardOptions } from '@/components/phonetic-card/card-options';
import type { GuideModuleDoc } from '@/data/guide-types';
import type { TourDefinition } from '@/data/onboarding-tours';
import type { WorkspaceId } from '@/stores/workbench';

export const initialWorkspace: WorkspaceId = 'home';
export const exploreLabel: string = '';
export const ExploreWorkspace: Component | null = null;
export const editionGuideModule: GuideModuleDoc | null = null;
export const editionTourDefinition: TourDefinition | null = null;
export const editionDisplayLabel = '开源标准版（科研与通用创作 · 含卡片署名）';
export const editionIsolationNote = '同一套前端与内核代码通过构建时别名 @vocalcut/edition 输出两个管理版本：开源标准版（默认进入首页，面向通用科研创作并保留本地作者卡片署名）以及独立构建挂载的专题探索版本（含探索首屏与互动伴读展示）。';
export const editionCorpusBoundary = '第三方公开语料严格遵循原协议，不随仓再分发原始音频与非授权模型权重，详见 DISCLOSURE.md。';
export const EditionCardModal = defineAsyncComponent(() => import('@/components/phonetic-card/CardStudioModal.vue'));
export const EditionCardHeaderAction = defineAsyncComponent(() => import('@/components/phonetic-card/CardHeaderButton.vue'));
export { brandedCard as cardOptions } from './hackathon/branded-card';
export const editionReferences: MethodReference[] = [];

export const exploreMark = '';
