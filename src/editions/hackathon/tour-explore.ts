import type { TourDefinition } from '@/data/onboarding-tours';

export const EXPLORE_TOUR_DEFINITION: TourDefinition = {
  pageId: 'explore',
  title: '知乎探索',
  shortDesc: '风格定制、语音学专题检索、声道重叠对比与伴读解说',
  icon: 'compass',
  navId: 'explore',
  steps: [
    {
      id: 'explore-style-picker',
      title: '先挑一套喜欢的界面风格',
      body: '首次进入已根据当前本机时间自动适配日间浅色或夜间深色。点选下方设计风格、主题色板与底纹可实时预览整站效果，满意后继续。',
      placement: 'center',
      widget: 'appearance-picker',
      nextLabel: '选好了，继续导览',
    },
    {
      id: 'explore-cases',
      selector: '[data-tour="explore-cases"]',
      title: '专题案例与内容检索',
      body: '左侧汇聚跨语言发音对比、呼麦共振与粤语入声等专题案例，也支持按关键词检索知乎问答与阅读材料并与声道演示联动。',
      placement: 'right',
      padding: 10,
    },
    {
      id: 'explore-stage',
      selector: '[data-tour="explore-stage"]',
      title: '2D / 3D 声道重叠对比舞台',
      body: '在舞台中央可以同步试听音 A 与音 B，拖动过渡进度条观察舌位、唇形与声学传递函数 H(f) 的实时差异。',
      placement: 'bottom',
      padding: 10,
    },
    {
      id: 'explore-right',
      selector: '[data-tour="explore-right"]',
      title: '刘看山伴读与声学提示',
      body: '右侧伴读面板会随你当前选中的案例与构音变化给出实时要点提示，帮助快速抓准关键声学对照。',
      placement: 'left',
      padding: 10,
    },
    {
      id: 'explore-topbar',
      selector: '[data-tour="topbar-tools"]',
      title: '生成发音卡与重播指引',
      body: '可将当前对比画面导出为高清发音卡，也可从右上角帮助菜单随时重播本页操作指引或查看完整使用说明。',
      placement: 'bottom',
      padding: 8,
    },
  ],
};
