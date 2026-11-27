import type { TourDefinition } from '@/data/onboarding-tours';

export const EXPLORE_TOUR_DEFINITION: TourDefinition = {
  pageId: 'explore',
  title: '知乎探索',
  shortDesc: '风格定制、知乎检索与 AI 提取发音、三态声道对比、声学图谱与刘看山伴读',
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
      title: '知乎检索、个人偏好与 AI 提取文中发音',
      body: '左栏可按关键词或粘贴知乎链接检索回答与文章（支持「随机」抽取主题与多回答翻页），右上可配置答主/关键词偏好及 Access Secret 读取授权正文。配置好模型 API 后可点击「AI 提取文中发音」，文内高亮出的音标芯片一点即可试听并联动右侧声道。',
      tip: '公开检索通过本机知乎 CLI 运行；个人 Secret 仅保存在当前会话内存。',
      placement: 'right',
      padding: 10,
    },
    {
      id: 'explore-stage',
      selector: '[data-tour="explore-stage"]',
      title: '内置专题、三态双音对比与实时声学图',
      body: '中央顶栏可切换「主题」（含算/swan 神经 Vox2Tract-Lite 与物理 VTL 2.4 双重建对照）、开启「声学图」（H(f) 共振谱 / A(x) 面积函数 / F1–F2 元音图），并在「单音探索」与「双音对比」（左右 / 上下 / 重叠半透明对比）间切换；底部悬浮岛支持单次/持续发声、神经/物理声源切换与变形或发音进度滑块。',
      tip: '在重叠对比模式下可随时切换彩色实线音 A / 音 B 并开关「头部外廓」。',
      placement: 'bottom',
      padding: 10,
    },
    {
      id: 'explore-right',
      selector: '[data-tour="explore-right"]',
      title: '快捷发音卡导出、使用说明与刘看山伴读',
      body: '右栏上方集成快捷发音卡导出及全量排版工坊入口，顶栏「使用说明」可随时展开详尽图文手册；下方刘看山 AI 伴读助手会读取当前声道与主题快照，给出实时声学解读与答疑。',
      placement: 'left',
      padding: 10,
    },
    {
      id: 'explore-topbar',
      selector: '[data-tour="topbar-tools"]',
      title: '外观搭配保存、发音卡、AI 助手与重播指引',
      body: '顶栏右侧汇集撤销重做、明暗切换、外观快捷面板（支持保存日间与夜间多套个人搭配）、全屏、设置、帮助菜单（随时重播指引或打开系统说明）、发音卡工坊与 AI 助手。',
      placement: 'bottom',
      padding: 8,
    },
  ],
};
