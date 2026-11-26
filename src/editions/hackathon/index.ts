import { defineAsyncComponent } from 'vue';
import type { MethodReference } from '@/data/references';
import type { CardOptions } from '@/components/phonetic-card/card-options';
import { brandedCard } from './branded-card';
import { EXPLORE_GUIDE_MODULE } from './guide-explore';
import { EXPLORE_TOUR_DEFINITION } from './tour-explore';
import { KANSHAN_STICKER_CATALOG, resolveKanshanStickerFrame } from './card/kanshan-sticker';

export { EditionCardModal, EditionCardHeaderAction } from '../public';

export const initialWorkspace = 'explore' as const;
export const exploreLabel = '知乎探索';
export const ExploreWorkspace = defineAsyncComponent(() => import('./ExploreLabView.vue'));
export const editionGuideModule = EXPLORE_GUIDE_MODULE;
export const editionTourDefinition = EXPLORE_TOUR_DEFINITION;
export const editionDisplayLabel = '知乎黑客松参赛版（含探索实验室与赛事素材）';
export const editionIsolationNote = '同一套前端与内核代码通过构建时别名 @vocalcut/edition 输出面向不同场景的构建产物：公开版（通用科研与排版导出）、群友版（保留本地署名）与知乎黑客松参赛版（新增知乎探索首屏与刘看山互动展示），三版共享全部声学核心、发音卡工坊与本地引擎。';
export const editionCorpusBoundary = '第三方公开语料不随仓再分发原音频；知乎与刘看山素材仅限参赛版展示，登记于 DISCLOSURE.md。';
export const cardOptions: CardOptions = {
  ...brandedCard,
  stickers: { name: '刘看山', items: KANSHAN_STICKER_CATALOG, resolveFrame: resolveKanshanStickerFrame },
};
export const editionReferences: MethodReference[] = [
  {
    id: 'SRC-KATEX', title: 'KaTeX', modules: ['知乎探索'], importance: 72.5, acknowledgement_group: 'software',
    authors: 'KaTeX contributors', license: 'MIT', urls: { repository: 'https://github.com/KaTeX/KaTeX' },
    citation: 'KATEX CONTRIBUTORS. KaTeX[CP/OL]. https://github.com/KaTeX/KaTeX.',
    reference_note: '参赛版用于知乎内容与刘看山对话中的公式排版。',
  },
  {
    id: 'ASSET-ZHIHU-KANSHAN-S3',
    title: '知乎黑客松 S3「湾区共创季」刘看山官方动态立绘素材',
    modules: ['知乎探索', '发音卡工坊'],
    importance: 80,
    acknowledgement_group: 'software',
    authors: '知乎 / 知乎黑客松组委会',
    license: '黑客松 S3 参赛项目授权使用素材',
    urls: {},
    citation: '知乎黑客松 S3 竞赛官方提供之刘看山动态形象与三视图立绘素材。',
    reference_note: '仅用于参赛项目互动伴读与立绘展示。',
  },
];

export { default as exploreMark } from './assets/zhihu-mark.png';
