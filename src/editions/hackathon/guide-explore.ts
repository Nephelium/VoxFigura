import type { GuideModuleDoc } from '@/data/guide-types';

export const EXPLORE_GUIDE_MODULE: GuideModuleDoc = {
  id: 'explore',
  sectionAnchor: 'mod-explore',
  navTitle: '知乎探索实验室',
  title: '知乎探索 · 双声道对比、知乎伴读检索与刘看山互动展示',
  code: 'MOD-10 · ZHIHU EXPLORE',
  icon: 'compass',
  perspectiveBadge: '科普探索与对比视角',
  summary:
    '知乎黑客松参赛版专属首屏探索工作区，集成了知乎话题内容检索、2D/3D 双声道同屏对比、连续滑块调控、刘看山动态伴读以及一键生成带知乎品牌与刘看山贴纸的发音卡。',
  phoneticBasisTitle: '同屏对比与可视化科普机制',
  phoneticBasis: [
    '将两个易混音标或对比发音（如前高不圆唇 /i/ 与前高圆唇 /y/、清擦音 /s/ 与卷舌擦音 /ʂ/）同屏并置，通过 2D/3D 声道模型、传递函数 H(f) 与面积函数 A(x) 实时叠影揭示声学差异的生理成因。',
    '所有对比参数均经由与研究工作台同一套 VTL 2.4 与 VoxFigura Core 管线求解，既能即时科普试听，也能在左下或右栏一键送入工作台继续精修。',
  ],
  workflowSteps: [
    {
      title: '切换单音探索或双音对比',
      detail: '在中央舞台右上角切换单音与双音对比模式，可调整并排或上下叠排布局。',
      uiHint: '舞台顶部模式切换',
    },
    {
      title: '拖拽声道滑块或选取知乎词条伴读',
      detail: '在左栏检索知乎问答或切换专题词条，调节舞台下方的构音滑块即时监听共振峰与音色演变。',
      uiHint: '左栏知乎检索 · 中栏控制滑块',
    },
    {
      title: '导出刘看山品牌发音卡',
      detail: '在右栏选用刘看山主题贴纸与配色，直接弹出排版工坊生成 1:1 或 16:9 科普分享图与短视频。',
      uiHint: '右栏发音卡与刘看山面板',
    },
  ],
  demoSpec: {
    id: 'demo-explore-compare',
    kind: 'explore-compare',
    title: '生动案例：/i/ 与 /y/ 同屏双声道对照求解',
    subtitle: '现场调用 VTL 2.4 求解 /i/ 与 /y/ 的真实共振峰、传递函数叠加曲线与双音试听波形',
    requiresEngine: 'required',
    phoneticGoal: '体会双音对比视图下，圆唇化如何把前高元音的第二、第三共振峰整体向下拉低。',
    expectedObservation: '传递函数叠加图直观标出 /y/ 的 F2、F3 峰值相对 /i/ 左移，双音试听条可快速来回切换听辨圆唇色彩差异。',
    buttonLabel: '在本机求解双音对比演示',
  },
  pitfalls: [
    {
      title: '知乎内容凭据与非商用授权边界',
      detail: '刘看山立绘与贴纸仅限知乎黑客松 S3 参赛展示；若配置知乎个人凭据，相关内容仅在本地代理转发，不上传第三方。',
    },
  ],
  shortcuts: [
    ['打开全量发音卡工坊', '点击右栏生成发音卡'],
  ],
};
