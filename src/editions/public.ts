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
export const editionDisplayLabel = '公开标准版（科研与通用创作）';
export const editionIsolationNote = '同一套前端与内核代码通过构建时别名 @vocalcut/edition 输出面向不同场景的构建产物：公开版（默认进入首页，面向通用科研与排版导出）、群友预览版（保留本地作者卡片署名）以及独立构建挂载的专题实验版本。';
export const editionCorpusBoundary = '第三方公开语料严格遵循原协议，不随仓再分发原始音频与非授权模型权重，详见 DISCLOSURE.md。';
export const EditionCardModal = defineAsyncComponent(() => import('@/components/phonetic-card/CardStudioModal.vue'));
export const EditionCardHeaderAction = defineAsyncComponent(() => import('@/components/phonetic-card/CardHeaderButton.vue'));
export const cardOptions: CardOptions = {};
export const editionReferences: MethodReference[] = [];

export const exploreMark = '';
