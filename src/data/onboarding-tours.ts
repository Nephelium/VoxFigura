/**
 * Onboarding Spotlight Tour definitions for VoxFigura workspaces.
 *
 * Strictly uses official VoxFigura Core model names and zero UI Emoji.
 * Edition-specific exploration tour lives in `@vocalcut/edition` so the public
 * bundle remains cleanly isolated.
 */

import { editionTourDefinition, exploreLabel } from '@vocalcut/edition';

export type TourPageId =
  | 'home'
  | 'explore'
  | 'main'
  | 'ipa'
  | 'm27'
  | 'mixer'
  | 'continuum'
  | 'dialect'
  | 'arranger'
  | 'stage';

export type TourPlacement = 'auto' | 'top' | 'bottom' | 'left' | 'right' | 'center';

export interface TourStepAction {
  id: string;
  label: string;
  icon?: string;
}

export interface TourStep {
  id: string;
  selector?: string | readonly string[];
  title: string;
  body: string;
  tip?: string;
  placement?: TourPlacement;
  padding?: number;
  widget?: 'appearance-picker';
  nextLabel?: string;
  action?: TourStepAction;
}

export interface TourDefinition {
  pageId: TourPageId;
  title: string;
  shortDesc: string;
  icon: string;
  navId: string;
  steps: readonly TourStep[];
}

export const BASE_TOUR_DEFINITIONS: Record<Exclude<TourPageId, 'explore'>, TourDefinition> = {
  home: {
    pageId: 'home',
    title: '首页工作台概览',
    shortDesc: '风格定制、默认合成配置、9 大工具入口与本地引擎状态',
    icon: 'home',
    navId: 'home',
    steps: [
      {
        id: 'home-style-picker',
        title: '先挑一套喜欢的界面风格',
        body: '首次进入已根据当前本机时间自动适配日间浅色或夜间深色。点选下方设计风格、主题色板与底纹可实时预览整站换肤，选好后再继续导览。',
        placement: 'center',
        widget: 'appearance-picker',
        nextLabel: '选好了，继续导览',
      },
      {
        id: 'home-synth-speaker',
        selector: '[data-tour="home-synth-speaker"]',
        title: '全局设置 1 · 神经合成参考声纹',
        body: '决定所有新合成语音的默认说话人音色。既可选用内置默认讲解声纹，也可直接上传 2–15 秒 WAV 由 Vox2Spk-Lite 提取 512 维声纹。',
        placement: 'bottom',
        padding: 10,
      },
      {
        id: 'home-synth-pose',
        selector: '[data-tour="home-synth-pose"]',
        title: '全局设置 2 · 音标转声道构型',
        body: '设定文本或国际音标编译入轨时采用的默认构音姿态来源，可在当前 IPA 构型库与 IPA2Tract-Lite 协同动腔模型间切换。',
        placement: 'bottom',
        padding: 10,
      },
      {
        id: 'home-synth-render',
        selector: '[data-tour="home-synth-render"]',
        title: '全局设置 3 · 声道转语音渲染引擎',
        body: '用于切换全局默认的音频合成方式：Tract2Vox-Lite 神经声码器兼具高自然度与速度，VTL 2.4 物理求解则严格对应声学传递方程。',
        placement: 'bottom',
        padding: 10,
      },
      {
        id: 'home-catalog',
        selector: '[data-tour="home-catalog"]',
        title: '全部工具与工作区导航',
        body: '这里按「发音与重建」「调控与实验」「编曲与导出」分组陈列全部工作台入口；进入任意模块后，也可用左侧或顶部导航栏随时跨区切换。',
        placement: 'top',
        padding: 10,
      },
      {
        id: 'home-engine',
        selector: '[data-tour="home-engine"]',
        title: '本地引擎状态与随时重播指引',
        body: '此处实时显示 VTL 2.4 本地物理引擎连接状态。需要时点击右上角设置或帮助菜单，随时可重新开启或重置任意页面的操作指引。',
        placement: 'bottom',
        padding: 10,
      },
    ],
  },

  main: {
    pageId: 'main',
    title: '语音合成与多轨标注',
    shortDesc: '语料导入、快捷音标板、声道剖面、四联声学图与多轨编译',
    icon: 'waveform',
    navId: 'main',
    steps: [
      {
        id: 'main-topbar',
        selector: '[data-tour="main-topbar"]',
        title: '选择渲染引擎、参考声纹与流转菜单',
        body: '顶栏可切换 Tract2Vox-Lite 神经声码器或 VTL 2.4 物理声道合成，上传短录音迁移音色，并将当前结果送往编曲、剪辑或连续统。',
        placement: 'bottom',
        padding: 8,
      },
      {
        id: 'main-g2p-demo',
        selector: '[data-tour="main-g2p-bar"]',
        title: '填入中英日与 IPA/VoQS 混排示例并一键试听',
        body: '在底栏输入框填入 今天天气真好。What a gorgeous day! 今日はいい天気ですね。 [ˈnɔ˞məl ˈvɔɪs. {F fɔlˈsɛtʰoʊ F}. {W ˈwɪspʰəɹʷi W}] 后点右侧「编译入轨」再点「播放」（或直接点击下方按钮一键体验），即可一次听辨中文、英文、日语按句独立合成与常态浊声、假声 {F ... F}、耳语 {W ... W} 切换。',
        tip: '点击下方按钮会自动填入这段混排例句、按句分语种编译入轨并合成播放；播放时可配合观察上方声道与四联声学图。',
        placement: 'top',
        padding: 8,
        action: {
          id: 'main-compile-voqs-demo',
          label: '填入示例并编译合成试听',
          icon: 'play',
        },
      },
      {
        id: 'main-files',
        selector: '[data-tour="main-files"]',
        title: '语料列表与录音/TextGrid 载入',
        body: '左上方用于管理工作区语料，支持直接拖入 WAV 音频或 TextGrid 标注，也可把录音一键送入声道重建或发声调音台。',
        placement: 'right',
        padding: 8,
      },
      {
        id: 'main-ipa-quick',
        selector: '[data-tour="main-ipa-quick"]',
        title: '快捷 IPA / VoQS 音标面板',
        body: '点击元音、辅音、附加符或个人收藏中的音标，即可直接插入或替换时间轴选中音素，并同步更新声道构型。',
        placement: 'right',
        padding: 8,
      },
      {
        id: 'main-tract',
        selector: '[data-tour="main-tract"]',
        title: '2D / 3D 交互式声道剖面',
        body: '实时展示当前音素的声道解剖构型，可直接拖拽舌体、舌尖、双唇与下颌控制点微调构音，也支持切换说话人模型与解剖标注。',
        placement: 'left',
        padding: 8,
      },
      {
        id: 'main-trio',
        selector: '[data-tour="main-trio"]',
        title: '四联物理声学与元音空间分析',
        body: '并行求解声道截面积函数 A(x)、传递函数 H(f)、横截面唇形以及元音空间分布，鼠标扫描面积曲线即可定位最窄缩部位 Amin。',
        placement: 'left',
        padding: 8,
      },
      {
        id: 'main-inspector',
        selector: '[data-tour="main-inspector"]',
        title: '音段属性、19+8 维滑块与存入词典',
        body: '右侧精调当前选中音段时长、6 核心与 13 扩展构音参数、基频气压及 8 维声门参数，并支持将定制音节读音直接存入个人词典。',
        placement: 'left',
        padding: 8,
      },
      {
        id: 'main-timeline',
        selector: '[data-tour="main-timeline"]',
        title: '文本/音标编译条与多轨时间轴',
        body: '支持输入中英日文本、IPA 或 VoQS 大括号语法，选择语速与多语词典后编译入轨；拖拽时间轴选区可单独试听或重合成局部片段。',
        tip: '按 Space 或 P 播放，双击区间即可直接改字改音标。',
        placement: 'top',
        padding: 8,
      },
    ],
  },

  ipa: {
    pageId: 'ipa',
    title: '国际音标表 Plus',
    shortDesc: '655 入口查听、构型集切换、解剖对比与附加符号叠加',
    icon: 'book',
    navId: 'ipa',
    steps: [
      {
        id: 'ipa-topbar',
        selector: '[data-tour="ipa-topbar"]',
        title: '多表视图切换与精准检索',
        body: '顶栏可在标准 IPA、extIPA 扩展音标、VoQS 音质符号与元音/喉位对比间切换，输入符号、中文术语、英文名或 U+ 码位即可瞬间筛选。',
        placement: 'bottom',
        padding: 8,
      },
      {
        id: 'ipa-pose-set',
        selector: '[data-tour="ipa-pose-set"]',
        title: '说话人模型与构型参考集',
        body: '可切换 JD2/W02 说话人声道模型以及默认预设或录音参考构型集，观察不同来源下的构音差异与真实声道边界。',
        placement: 'bottom',
        padding: 6,
      },
      {
        id: 'ipa-matrix',
        selector: '[data-tour="ipa-matrix"]',
        title: '点击矩阵表即时听音与同步构型',
        body: '在肺部气流辅音、非肺部气流辅音与元音四边形上单击任意音标，即可试听发音、展开同部位对比并同步更新右侧声道视图。',
        placement: 'right',
        padding: 8,
      },
      {
        id: 'ipa-detail',
        selector: '[data-tour="ipa-detail"]',
        title: '交互式解剖视口与附加符号叠加',
        body: '右侧支持自由切换 2D 矢状面与 3D 模型、叠加鼻化/圆唇/腭化等附加符号，并可实时观察共振峰 F1–F3 与最小截面积读数。',
        placement: 'left',
        padding: 8,
      },
      {
        id: 'ipa-guide',
        selector: '[data-tour="ipa-guide-btn"]',
        title: '随时查阅模块详细语音学说明',
        body: '需要深入了解本模块的声学原理、附加符号规则与交互案例时，点击这里即可展开完整的语音学使用说明与本机实时演示。',
        placement: 'bottom',
        padding: 6,
      },
    ],
  },

  m27: {
    pageId: 'm27',
    title: '声道动态重建',
    shortDesc: '离线反演对齐、麦克风实时声道/3D人头重建与跨区流转',
    icon: 'reconstruct',
    navId: 'm27',
    steps: [
      {
        id: 'm27-input',
        selector: '[data-tour="m27-input"]',
        title: '导入录音、降噪与双语强制对齐',
        body: '支持拖入音频、点击麦克风现场录音、一键降噪或导入已有 TextGrid。填入原文后，Vox2Align-Lite v2 会自动切分精准的音素边界。',
        tip: '载入案例录音后，可依次体验下一步「按原文对齐」与第 4 步「开始声道重建」。',
        placement: 'right',
        padding: 8,
        action: {
          id: 'm27-load-demo',
          label: '载入案例音频试用',
          icon: 'waveform',
        },
      },
      {
        id: 'm27-align',
        selector: ['[data-tour="m27-align"]', '[data-tour="m27-input"]'],
        title: '点击「按原文对齐」切分音素边界',
        body: '案例音频已自动填入对应诗句原文。请点击左侧高亮区的「按原文对齐」按钮（或点下方快捷按钮），由 Vox2Align-Lite v2 在语谱图上生成精准的音节与音素边界。',
        tip: '如尚未装载 Vox2Align-Lite v2，可先到「设置 → 声学引擎与模型」开启，或直接跳至下一步执行声道重建。',
        placement: 'right',
        padding: 8,
        action: {
          id: 'm27-align-demo',
          label: '立即按原文对齐',
          icon: 'timeline',
        },
      },
      {
        id: 'm27-engine',
        selector: '[data-tour="m27-engine"]',
        title: '目标参考音色与声纹提取',
        body: '默认沿用原录音音色，也可上传另一位说话人的参考音频或选用已保存声纹，由 Vox2Spk-Lite 迁移重合成后的目标音色。',
        placement: 'right',
        padding: 8,
      },
      {
        id: 'm27-run',
        selector: '[data-tour="m27-run"]',
        title: '点击「开始声道重建」执行反演',
        body: '请点击左侧高亮区的「开始声道重建」按钮（也可直接点下方快捷按钮）发起本机反演：系统会提取 50 Hz 27 维声道与声门轨迹，同步合成物理与神经重合成音频，并自动将上方播放器切换至「神经重合成」。',
        tip: '若 Vox2Align-Lite v2 当前未装载，系统会自动先以无对齐模式完成声道重建，确保立即听到重合成音色。',
        placement: 'right',
        padding: 8,
        action: {
          id: 'm27-run-demo',
          label: '立即开始声道重建',
          icon: 'reconstruct',
        },
      },
      {
        id: 'm27-transport',
        selector: '[data-tour="m27-transport"]',
        title: '切换到「神经重合成」并播放对比',
        body: '重建完成后，顶栏音源会自动切换为「神经重合成」（不再停留于输入原音），点击「播放」即可试听效果；也可随时在「输入原音 / 神经重合成 / 物理重合成」三路之间切换对听。',
        tip: '快捷键 P 或 Space 可随时控制当前所选音源的播放与暂停。',
        placement: 'bottom',
        padding: 8,
        action: {
          id: 'm27-play-neural',
          label: '切到神经重合成并试听',
          icon: 'play',
        },
      },
      {
        id: 'm27-realtime',
        selector: '[data-tour="m27-realtime"]',
        title: '重点体验 · 实时声道重建与合成',
        body: '无需先录音等待！直接开启「开始实时合成」，即可一边对着麦克风说话一边看右侧 2D/3D 声道、声门实时联动，甚至可开启摄像头联合渲染实时三维人头与实时音频监听。',
        tip: '开启「实时合成音频」建议佩戴耳机防回声；若希望结束时将刚才的话保留到语谱图继续分析，勾选「保留实时录音」即可。',
        placement: 'right',
        padding: 8,
      },
      {
        id: 'm27-center',
        selector: '[data-tour="m27-center"]',
        title: '声谱对齐轨与 27 维参数曲线',
        body: '中央区域同步展示语谱图、音素边界与 50 Hz 构音/声门参数曲线，支持按帧拖动定位、框选试听以及与合成轨迹逐帧对照。',
        placement: 'left',
        padding: 8,
      },
      {
        id: 'm27-right',
        selector: '[data-tour="m27-right"]',
        title: '三视图动态解剖与声门状态监视',
        body: '右侧随时间轴指针同步演绎正中矢状面声道动画、声门开闭形态与共振峰读数，直观对照每一次闭塞、送气与发声态转变。',
        placement: 'left',
        padding: 8,
      },
      {
        id: 'm27-handoff',
        selector: '[data-tour="m27-handoff"]',
        title: '一键流转至其他工作区继续创作',
        body: '重建完成后，可把当前音频与 50 Hz 声道轨迹直接送回标注页做精细修改，或送入发声调音台、编曲改音高、剪辑视频及连续统端点。',
        placement: 'right',
        padding: 8,
      },
    ],
  },

  mixer: {
    pageId: 'mixer',
    title: '发声调音台',
    shortDesc: '发声类型时变调制、双人器官混合、音节塑形与 A/B 试听',
    icon: 'sliders',
    navId: 'mixer',
    steps: [
      {
        id: 'mixer-mode',
        selector: '[data-tour="mixer-mode"]',
        title: '切换「发声类型调制」与「双人器官混合」',
        body: '调制模式用于改变单段录音的发声态（如常态渐入气声或嘎裂声）；双人模式可将说话人 B 的声门、唇舌或音色按比例移植到 A 上。',
        placement: 'right',
        padding: 8,
      },
      {
        id: 'mixer-input',
        selector: ['[data-tour="mixer-input"]', '[data-tour="mixer-dual-input"]'],
        title: '加载、示例或现场录制源音频',
        body: '支持上传 WAV/FLAC、使用内置示例或麦克风录音，系统会自动由 Vox2Tract-Lite 反演声道与声门基础轨迹；也可展开下方原文对齐辅助局部塑形。',
        placement: 'right',
        padding: 8,
        action: {
          id: 'mixer-load-demo',
          label: '载入案例音频试用',
          icon: 'waveform',
        },
      },
      {
        id: 'mixer-presets',
        selector: ['[data-tour="mixer-presets"]', '[data-tour="mixer-dual-groups"]'],
        title: '挑选 VoQS 预设或提取自定义发声态',
        body: '在调制模式点击预设即可悬停预览 8 维声门参数与 VoQS 曲线，也能将当前录音提取保存为个人预设；在双人模式可勾选并切换多条器官混合轨道。',
        placement: 'right',
        padding: 8,
      },
      {
        id: 'mixer-toolbar',
        selector: '[data-tour="mixer-toolbar"]',
        title: '快捷曲线模板与音节局部塑形',
        body: '顶栏提供渐强、渐弱、拱形等快捷曲线模板；完成对齐后还会出现音节/音素徽章，单击即可只拉高该词段的调制权重。',
        placement: 'bottom',
        padding: 8,
      },
      {
        id: 'mixer-plot',
        selector: '[data-tour="mixer-plot"]',
        title: '绘制时变强度曲线与声门保护开关',
        body: '在画布单击加点、拖拽或用方向键微调权重，双击中间节点可删除；底部可开启静音/清音软门控、调节高斯平滑或联动 F0 半音偏移。',
        placement: 'top',
        padding: 8,
      },
      {
        id: 'mixer-footer',
        selector: '[data-tour="mixer-footer"]',
        title: '渲染合成与 A/B 对照听辨',
        body: '点击生成后可随时在「调制结果」与「未调制基线/原音」之间切换试听，也可直接把结果送往剪辑、标注或下载无损 WAV。',
        placement: 'top',
        padding: 8,
      },
    ],
  },

  continuum: {
    pageId: 'continuum',
    title: '声道连续统',
    shortDesc: '真实录音/预设端点、单双轴参数插值、构音锁定与刺激导出',
    icon: 'grid',
    navId: 'continuum',
    steps: [
      {
        id: 'continuum-endpoints',
        selector: '[data-tour="continuum-endpoints"]',
        title: '设置端点 A 与端点 B（支持真人录音）',
        body: '两端点均支持选择预设、自由音素或导入真实音频。系统会自动分析端点构型，实现从自然端点 A 到自然端点 B 的物理连续过渡。',
        tip: '点击下方按钮，可一键载入汉语「算」与英语「swan」真人录音对照体验。',
        placement: 'right',
        padding: 8,
        action: {
          id: 'continuum-load-suan-swan',
          label: '一键载入 算 ↔ swan 真人录音',
          icon: 'sparkles',
        },
      },
      {
        id: 'continuum-axes',
        selector: '[data-tour="continuum-axes"]',
        title: '配置单轴 / 二维矩阵与变化维度',
        body: '可设置格数，并开启第二维度生成如 5×4 的二维感知实验矩阵，自由组合构音混合比例、基频、时长、气压或发声态作为横纵轴。',
        placement: 'right',
        padding: 8,
      },
      {
        id: 'continuum-locks',
        selector: '[data-tour="continuum-locks"]',
        title: '构音参数锁定与等时长对齐',
        body: '做语音学单变量控制实验时，可在此锁定唇部、舌背、舌尖、软腭鼻化或下颌开口保持端点 A 不变，并选择是否对齐两端时长。',
        placement: 'right',
        padding: 8,
      },
      {
        id: 'continuum-grid',
        selector: '[data-tour="continuum-grid"]',
        title: '逐格声道轮廓矩阵与共振峰预览',
        body: '网格中每一格都会实时渲染 VTL 真实声道轮廓叠加对比；单击选中任意格，即可在上方标题栏读出精确 F1/F2 与最小截面积 Amin。',
        placement: 'left',
        padding: 8,
      },
      {
        id: 'continuum-actions',
        selector: '[data-tour="continuum-actions"]',
        title: '单格试听、连续序列播放与全套导出',
        body: '支持试听单格、按顺序连续播放整条连续统，也可下载单格 WAV、声道动画视频、完整刺激参数 JSON 或直接送往剪辑与标注。',
        placement: 'bottom',
        padding: 8,
      },
    ],
  },

  dialect: {
    pageId: 'dialect',
    title: '发音字典管理',
    shortDesc: '多方言词典维护、词条 IPA 编辑、连读变调规则与五度手绘',
    icon: 'book',
    navId: 'dialect',
    steps: [
      {
        id: 'dialect-library',
        selector: '[data-tour="dialect-library"]',
        title: '浏览、派生与检索发音词典库',
        body: '左栏管理内置方言/语种词包与个人词典，支持关键词筛选、导入导出词表，以及基于内置词典派生一份可编辑副本。',
        placement: 'right',
        padding: 8,
      },
      {
        id: 'dialect-editor',
        selector: '[data-tour="dialect-editor"]',
        title: '词条 IPA 编辑与三类连读变调规则',
        body: '中栏不仅能逐条维护词形、IPA 读音与调值，还可在顶部分段切换到「连读变调规则」配置前后字触发条件与非递归变调输出。',
        placement: 'right',
        padding: 8,
      },
      {
        id: 'dialect-tools',
        selector: '[data-tour="dialect-tools"]',
        title: '五度调型手绘板与实时合成试听',
        body: '右栏可直接用鼠标手绘五度方言调型曲线，输入连续词句检验变调规则命中结果，并立即用物理或神经声码器试听验证。',
        placement: 'left',
        padding: 8,
      },
      {
        id: 'dialect-guide',
        selector: '[data-tour="dialect-guide-btn"]',
        title: '查阅完整变调规则语法与说明',
        body: '编写复杂方言变调规则或自定义词典格式时，随时点击这里打开本模块详细说明与示例。',
        placement: 'bottom',
        padding: 6,
      },
    ],
  },

  arranger: {
    pageId: 'arranger',
    title: '声乐编曲',
    shortDesc: '调性速度、逐字简谱与歌词、卷帘滑音抢拍、选段配器与导出',
    icon: 'music',
    navId: 'arranger',
    steps: [
      {
        id: 'arranger-toolbar',
        selector: '[data-tour="arranger-toolbar"]',
        title: '曲目调性、速度与演唱音源设定',
        body: '顶栏可配置主调调号、BPM、拍号与合成引擎，默认载入《长恨歌》完整示例方便立刻点击播放感受效果并改写。',
        placement: 'bottom',
        padding: 8,
      },
      {
        id: 'arranger-lyrics',
        selector: '[data-tour="arranger-lyrics"]',
        title: '多声部切换、逐字歌词与通用简谱',
        body: '左栏支持管理多声部或重建导入声轨、输入逐字歌词与通用键盘简谱（支持八度、连奏括号与力度），还可打开多语词典检查读音。',
        placement: 'right',
        padding: 8,
      },
      {
        id: 'arranger-roll-tools',
        selector: '[data-tour="arranger-roll-tools"]',
        title: '音高画笔、滑音阻尼 λ 与辅音抢拍',
        body: '卷帘上方工具条可切换音块/手绘音高曲线工具，调节 qTA 滑音速度 λ 与辅音自然抢拍开关，并精细缩放时间与琴键行高。',
        placement: 'bottom',
        padding: 8,
      },
      {
        id: 'arranger-range',
        selector: '[data-tour="arranger-range"]',
        title: '选段移调与多乐器物理伴奏试听',
        body: '在时间标尺拖拽框选一段后，可整段升降八度，还能挑选内置物理乐器音色直接合成试听该选段的旋律效果。',
        placement: 'bottom',
        padding: 8,
      },
      {
        id: 'arranger-roll',
        selector: '[data-tour="arranger-roll"]',
        title: '钢琴卷帘与连续 qTA 基频曲线编辑',
        body: '直接上下拖动音块即可改变目标音高，单击左侧琴键可将选中音符定音，画笔模式下还能自由手绘细腻的颤音与滑音走势。',
        placement: 'left',
        padding: 8,
      },
      {
        id: 'arranger-send',
        selector: '[data-tour="arranger-send"]',
        title: '一键将声轨与声道动画送入剪辑',
        body: '编曲满意后，点击此处即可把人声演唱轨、同步歌词字幕与声道解剖视频一键发送到多轨剪辑工作台合成成片。',
        placement: 'bottom',
        padding: 8,
      },
    ],
  },

  stage: {
    pageId: 'stage',
    title: '多轨剪辑与监看',
    shortDesc: '本地目录浏览、媒体库入库、节目监视器直拖、时间线与成片导出',
    icon: 'stage',
    navId: 'stage',
    steps: [
      {
        id: 'stage-directory',
        selector: '[data-tour="stage-directory"]',
        title: '本地目录快速浏览',
        body: '最左侧可直接打开本机素材文件夹，像桌面剪辑软件一样把本地音频、视频、图片或工程文件直接拖入媒体库或时间线。',
        placement: 'right',
        padding: 8,
      },
      {
        id: 'stage-media',
        selector: '[data-tour="stage-media"]',
        title: '项目媒体库与案例素材导入',
        body: '所有导入素材、语音合成或编曲送来的声轨与声道片段都会集中在此管理，支持列表/缩略图视图切换与关键词搜索。',
        placement: 'right',
        padding: 8,
        action: {
          id: 'stage-load-demo',
          label: '载入案例音频入库',
          icon: 'music',
        },
      },
      {
        id: 'stage-monitor',
        selector: '[data-tour="stage-monitor"]',
        title: '16:9 节目监视器舞台交互',
        body: '中央实时合成背景画面、2D/3D 声道动画层、立绘与字幕；点击安全框可对照构图，直接在画面上拖拽和拉伸角标即可缩放定位。',
        placement: 'bottom',
        padding: 8,
      },
      {
        id: 'stage-inspector',
        selector: '[data-tour="stage-inspector"]',
        title: '右侧属性与声画检查器',
        body: '选中媒体库素材、舞台图层或时间线片段后，右侧会动态显示对应参数，可精确调整不透明度、位置缩放、音轨增益与字幕样式。',
        placement: 'left',
        padding: 8,
      },
      {
        id: 'stage-timeline',
        selector: '[data-tour="stage-timeline"]',
        title: '多轨非线性时间线剪辑',
        body: '将素材拖入视频、声道、音频或字幕轨，支持吸附对齐、B 键切分、复制粘贴与独立音轨波形查看，快捷键 Space 随时播放监看。',
        placement: 'top',
        padding: 8,
      },
      {
        id: 'stage-export',
        selector: '[data-tour="stage-export"]',
        title: '切换音频渲染器与导出成片',
        body: '顶部命令栏可统一切换声道轨的神经/物理合成音源，并打开导出面板输出高清 MP4 视频、多轨音频或项目工程包。',
        placement: 'bottom',
        padding: 8,
      },
    ],
  },
};

export const TOUR_DEFINITIONS: Partial<Record<TourPageId, TourDefinition>> = {
  ...BASE_TOUR_DEFINITIONS,
  ...(editionTourDefinition ? { explore: editionTourDefinition } : {}),
};

export const TOUR_ORDER_PUBLIC: readonly TourPageId[] = [
  'home',
  'main',
  'ipa',
  'm27',
  'mixer',
  'continuum',
  'dialect',
  'arranger',
  'stage',
];

export const TOUR_ORDER_HACKATHON: readonly TourPageId[] = [
  'explore',
  'main',
  'ipa',
  'm27',
  'mixer',
  'continuum',
  'dialect',
  'arranger',
  'stage',
];

export function getTourDefinition(pageId: TourPageId): TourDefinition | null {
  return TOUR_DEFINITIONS[pageId] ?? null;
}

export function getAvailableTourList(hasExplore = Boolean(exploreLabel)): TourDefinition[] {
  const order = hasExplore ? TOUR_ORDER_HACKATHON : TOUR_ORDER_PUBLIC;
  return order.map((id) => TOUR_DEFINITIONS[id]).filter((d): d is TourDefinition => Boolean(d));
}
