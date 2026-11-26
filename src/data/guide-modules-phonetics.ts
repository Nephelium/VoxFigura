import type { GuideModuleDoc } from './guide-types';

/**
 * Phonetics-first module manuals covering the 7 speech science, articulatory analysis,
 * voice modulation, perception experiment, dialectology, and card-publishing modules.
 */
export const PHONETICS_GUIDE_MODULES: readonly GuideModuleDoc[] = [
  {
    id: 'main',
    sectionAnchor: 'mod-main',
    navTitle: '语音合成与标注',
    title: '语音合成 · 文本编译、声道协同控制与物理三联视口',
    code: 'MOD-01 · RESEARCH SYNTHESIS',
    icon: 'waveform',
    perspectiveBadge: '实验语音学视角',
    summary:
      '从汉字、英语、日语假名、内联国际音标 [ipa] 或 Praat .TextGrid 出发，在 48,000 Hz 整数采样时间轴上联调超音段韵律、音段靶位与发声态，并以 VTL 2.4 物理声管与 Tract2Vox-Lite 神经声码器双通道即时对听。',
    phoneticBasisTitle: '声学与协同发音原理',
    phoneticBasis: [
      '语音的声学输出由声门激励源与声道滤波器共同塑造。本模块在 200 Hz 物理控制网格（5 ms 帧长）上同步规划基频 F0（60–600 Hz）、声门下压 PR（0–1600 Pa）、8 维声门发声态与 19 维声道构形参数。',
      '时间轴上的单音微调修改的是音素目标靶位（Target Pose），音段边界之间的过渡动程仍由异步 3 阶临界阻尼 qTA 与 IPA2Tract-Lite 残差网络重新规划，从而自然保持共振峰弯头与前后协同发音惯性。',
      '普通话与英语的默认时长、停顿及相对半音轮廓可由本地 Text2Prosody-Lite 预测；若导入外部 Praat .TextGrid，系统原样保留文件内的音节与音素边界，供科研复现。',
    ],
    workflowSteps: [
      {
        title: '组织实验语料与文本输入',
        detail: '在左侧语料树按课题建文件夹管理录音与 TextGrid，或直接在上方编译栏输入中英日混合文本及 [ipa] 转写。可拖拽录音进轨并调用 DPDFNet 执行 48 kHz 宽带降噪。',
        uiHint: '左栏语料树 · 顶部文本编译栏',
      },
      {
        title: '校验声调与 VoQS 大括号标注',
        detail: '双击任意音节或音素区间即可修订音标、五度调值（如 55 / 35 / 214 / 51）及 {2V̤ ... 2V̤} 发声类型标签，系统实时重算 3 阶 qTA 连续基频轨与声门锚点。',
        uiHint: '中栏多轨时间轴',
      },
      {
        title: '协同微调单音靶位与塞音时序',
        detail: '选中目标音素后，在右栏拖拽 2D 矢状面控制器或调整 19 维滑块；遇到清/浊塞音时可微调闭塞段（下限 10 ms）与释放段（下限 1 ms）以及 VOT 边界。',
        uiHint: '右栏 2D/3D 解剖视口',
      },
      {
        title: '三联图核验与双声源对听',
        detail: '观察 65 截面面积函数 A(x) 的最窄收窄点 Amin 与传递函数 H(f) 极点峰值，在 VTL 2.4 物理声管与 Tract2Vox-Lite 神经通道之间一键切换试听，并选择原始电平或峰值归一化。',
        uiHint: '右下物理三联图 · 顶栏声源切换',
      },
    ],
    demoSpec: {
      id: 'demo-main-voqs',
      kind: 'main-voqs',
      title: '生动案例：普通话 /ma/ 三调叠加三种 VoQS 发声态物理对照',
      subtitle: '现场调用本地 VTL 2.4 实时合成 [ma˥˥]（常态）、{3V̤ [ma˧˥] 3V̤}（3 度气声）与 {3V̰ [ma˨˩˦] 3V̰}（3 度嘎裂）',
      requiresEngine: 'required',
      phoneticGoal: '在保持口腔双唇鼻音 /m/ 到低元音 /a/ 相同构音动程的前提下，观察声门后裂隙 CA、振幅微扰 SHIM 与基频轮廓如何独立决定音质与声调。',
      expectedObservation: '常态浊声谐波清晰；3 度气声因后软骨裂隙增大（CA = 0.085 cm²）呈现明显宽带气噪；3 度嘎裂以低基频叠加高振幅微扰（SHIM = 100%）形成脉冲颗粒感。',
      buttonLabel: '在本机实时合成三组发声对比',
    },
    tables: [
      {
        caption: '文本编译与电平对比常用设置',
        tag: 'Synthesis Controls',
        headers: ['控制项', '可选状态', '实验语音学意义'],
        rows: [
          ['合成通道', 'VTL 2.4 物理 / Tract2Vox-Lite 神经', '物理通道严格服从 65 截面管段声学方程，神经通道支持 512 维参考声纹迁移'],
          ['电平模式', '峰值归一化 / 原始引擎电平', '听主观音质选峰值归一化；比较不同肺压（Pa）或气声响度差时务必切回原始电平'],
          ['韵律来源', 'Text2Prosody-Lite / 规则韵律 / TextGrid', 'TextGrid 导入后锁定人工实测边界，不被神经网络覆写'],
        ],
      },
    ],
    pitfalls: [
      {
        title: '勿把局部试听混同整句定稿',
        detail: '框选单音试听会在区间起点重新初始化声管残余驻波，与整句连读时前音带入的协同残差存在细微差别。定稿数据导出前请播放或渲染完整句子。',
      },
      {
        title: '严禁把传递函数极点直接当作音频共振峰',
        detail: 'H(f) 是无声门耦合的纯声管频响极点；受辐射阻抗与声门零点影响，最终音频的 LPC 实测共振峰往往与极点存在偏移。',
      },
    ],
    shortcuts: [
      ['播放或暂停当前选区/整句', 'P / Space'],
      ['以光标为中心横向缩放时间轴', 'Ctrl + 滚轮'],
      ['编辑音节汉字、音标或 VoQS', '双击区间'],
      ['框选连续局部试听范围', '鼠标拖拽选区'],
    ],
    jumpAction: { label: '查看系统级 IPA/VoQS 语法表', overlay: 'guide', guideSection: 'guideIpaVoqs' },
  },
  {
    id: 'ipa',
    sectionAnchor: 'mod-ipa',
    navTitle: '国际音标表 Plus',
    title: '国际音标表 Plus · 655 项构型库、个人示范对照与派生方案',
    code: 'MOD-02 · IPA & ARTICULATION',
    icon: 'ipa',
    perspectiveBadge: '实验语音学视角',
    summary:
      '完整收录 655 项 IPA、extIPA 与 VoQS 符号，支持按发音部位、方法及附加符精准检索、查看个人与工厂实录对照、绘制元音 F1–F2 空间图，并可派生自定义构型方案供全工作台复用。',
    phoneticBasisTitle: '声学解耦与标准构型依据',
    phoneticBasis: [
      '辅音按主要发音器官（双唇、唇齿、齿/齿龈、卷舌、龈腭、硬腭、软腭、小舌、咽、声门）与成阻方式组织，元音按舌体高低（TCY）、前后（TCX）及圆唇度（LP/LD）连续张成。',
      '同一舌位下的圆唇对比（如前高不圆唇 /i/ 与前高圆唇 /y/）会延长唇腔有效声管长度并降低嘴唇辐射口面积，声学上显著压低 F2 与 F3，使耳听色彩向暗沉移动。',
      '每项扩展附加符号（如唇化 ʷ、腭化 ʲ、鼻化 ̃、咽化 ˤ、齿间化 ̪）均对应经 JD2 物理安全校验的增量构型规则，防止次要调音破坏闭塞音的双唇封口。',
    ],
    workflowSteps: [
      {
        title: '筛选体系与检索符号',
        detail: '使用顶栏体系切换（标准 IPA / extIPA / VoQS）与中文/英文/Unicode 检索，点击符号格即可在详情区展开解剖轮廓与发声条件。',
        uiHint: '顶栏筛选器与搜索框',
      },
      {
        title: '对照 266 份正式参考录音与实录自测',
        detail: '点开详情中的参考波形与 TextGrid 对齐片段，也可以现场用麦克风录制自己的发音，让系统对比测算元音 F1/F2 与传递函数分布。',
        uiHint: '右侧音标详情面板',
      },
      {
        title: '编辑单音靶位并派生构型方案',
        detail: '如需研究特定方言音值或临床构音偏误，新建一套自定义构型方案（Pose Set），在其中微调的符号锚点会独立保存，在语音合成页可直接切换调用。',
        uiHint: '方案下拉框 · 保存自定义构型',
      },
    ],
    demoSpec: {
      id: 'demo-ipa-rounding',
      kind: 'ipa-rounding',
      title: '生动案例：/i/ — /y/ — /u/ 舌位与圆唇度声学解耦实验',
      subtitle: '现场调用 VTL 2.4 求解三个高元音的真实 65 截面几何、传递函数 H(f) 与 48 kHz 物理持音',
      requiresEngine: 'required',
      phoneticGoal: '直观拆解高元音的两维独立控制：/i/→/y/ 保持前舌位不变仅施加圆唇，/y/→/u/ 保持圆唇并将舌体大幅后移。',
      expectedObservation: '圆唇化使 /y/ 相对 /i/ 的 F2、F3 明显下移；进一步后舌化至 /u/ 时，F2 急剧跌破 900 Hz，在 2D 矢状面叠影中可清楚看到嘴唇前突与舌背隆起后缩。',
      buttonLabel: '在本机求解并对比 /i, y, u/',
    },
    chartKey: 'coarticulation',
    pitfalls: [
      {
        title: '区分默认构型库与个人派生方案',
        detail: '修改自定义构型前请先确认当前选中的方案名称，避免把临时方言音值误写进主用实验方案。',
      },
      {
        title: '附加符叠加后的极窄面积检查',
        detail: '为元音叠加过强咽化或鼻化附加符时，请留意详情区输出的 Amin 与鼻咽门开度 VO，确认符合目标语言的生理合理范围。',
      },
    ],
    shortcuts: [
      ['聚焦音标搜索框', 'Ctrl + F'],
      ['试听当前选中音标', 'Space / P'],
    ],
  },
  {
    id: 'm27',
    sectionAnchor: 'mod-m27',
    navTitle: '声道动态重建',
    title: '声道动态重建 · 录音反演 27 维轨迹、三视图解剖与转写对齐',
    code: 'MOD-03 · ACOUSTIC-TO-ARTICULATORY',
    icon: 'reconstruct',
    perspectiveBadge: '实验语音学视角',
    summary:
      '输入麦克风现场录音或本地音频文件，由 Vox2Tract-Lite 反演 50 Hz 27 维声道与声门动力学轨迹，联动矢状面、喉镜俯视、Cover–Body 声带冠状面与 MediaPipe 实时三维透视人头同步呈现，并支持双语强制对齐与稳态帧提取。',
    phoneticBasisTitle: '声学反演逆问题与多视图同步机制',
    phoneticBasis: [
      '由语音声学特征反推声道形态属于典型的多对一逆问题（同一组共振峰可能对应唇舌代偿后的多种几何姿态）。Vox2Tract-Lite 在双通道物理锚定（Vox2Tract-Large 教师蒸馏 + 180 小时 VTL 真值）约束下，输出符合 JD2 解剖边界的平滑候选解。',
      '反演前端由 SwiftF0 在 40–600 Hz 追踪实测基频，再由 Vox2Align-Lite v2 结合参考文本或转写结果切分音节与音素边界；超过 9.6 秒的长句会自动在静音谷点分块推理并拼接。',
      '右栏同步渲染的粒子气流采用单调递增梯形累计流积分驱动，防止句末肺压骤降时发生视觉倒吸；喉镜与冠状面模型实时反映 XB、XT、CA、LAG 与振幅微扰 SHIM。',
    ],
    workflowSteps: [
      {
        title: '导入音频或现场录制样本',
        detail: '在左栏录音或导入 WAV/MP3；若使用摄像头实时联动，可开启三维透视人头-声道联合重建窗口，将面部关键点追踪与声道模型配准到同一空间。',
        uiHint: '左栏输入区 · 右栏透视切换',
      },
      {
        title: '补充文本或运行离线自动转写',
        detail: '可手动填写参考文本或通过自配 DeepSeek 接口转写，再执行重建，使 Vox2Align-Lite v2 按原文输出音素边界。',
        uiHint: '左栏参考文本与自动转写',
      },
      {
        title: '三路对听与局部波形裁剪',
        detail: '在中栏语谱图框选任意单音或音节，随时切换「原录音 / VTL 2.4 物理重合成 / Tract2Vox-Lite 神经重合成」三路声音，核对反演对音段特征的还原度。',
        uiHint: '中栏传输栏与 7 轨物理曲线',
      },
      {
        title: '提取稳态帧赋给音标或送往编曲/调音台',
        detail: '把播放头停在擦音成阻最窄帧或元音稳态中心，可将 19 维构型一键存入个人音标库；也能把整段动态轨迹直接送入发声调音台或编曲台做保留咬字的改音高演唱。',
        uiHint: '中栏提取赋音标 · 左栏流转按钮',
      },
    ],
    demoSpec: {
      id: 'demo-m27-roundtrip',
      kind: 'm27-roundtrip',
      title: '生动案例：真人原声「春江潮水连海平」反演重建三路对照',
      subtitle: '复用内置真人朗读样本（demo_zh_spkA.mp3）现场由 Vox2Tract-Lite 反演 27 维轨迹并重合成 VTL 物理与 Tract2Vox-Lite 神经音频',
      requiresEngine: 'required',
      phoneticGoal: '在同一段真实诗句录音上，直接对比真人原声、VTL 2.4 物理管段重建与 Tract2Vox-Lite 神经重建的音色和咬字动态差异；若已装载 Vox2Align-Lite v2，可同步查看音素边界。',
      expectedObservation: '50 Hz 轨迹中可随诗句朗读看到双唇开合（LD）、舌体高低前后（TCX/TCY）和声门裂隙起伏；拖动时间滑块或直接播放三路音频，均可同步驱动左侧矢状面轮廓运动。',
      buttonLabel: '在本机反演真人案例并三路对比',
    },
    pitfalls: [
      {
        title: '不可将反演轨迹直接当成 EMA 或 rtMRI 实测数据',
        detail: '论文撰写与汇报时须明确标明「模型声学反演候选构音轨迹」，不可等同于电磁发音仪或核磁共振直接测得的真实生理舌位。',
      },
      {
        title: '音频过长或含强背景音乐时先降噪或裁剪',
        detail: '伴奏混响会干扰基频与鼻咽开度估计，建议在语音合成或重建栏先裁剪纯净干声片段后再做精细参数分析。',
      },
    ],
    shortcuts: [
      ['播放或暂停重建三路音频', 'P / Space'],
      ['框选局部对比区间', '语谱图拖拽'],
    ],
  },
  {
    id: 'mixer',
    sectionAnchor: 'mod-mixer',
    navTitle: '发声调音台',
    title: '发声调音台 · 发声类型时变调制与双人多器官属性移植',
    code: 'MOD-04 · PHONATION & MORPH',
    icon: 'sliders',
    perspectiveBadge: '实验语音学视角',
    summary:
      '依托声门—声道—音色解耦表征，支持在单段音频上绘制气声、紧嗓、嘎裂、假声、耳语的时变过渡曲线，也支持在两段不同说话人录音之间按器官组（舌颌、唇、鼻化、喉位、声门、声纹）精细混合。',
    phoneticBasisTitle: '发声态解耦与声门门控机制',
    phoneticBasis: [
      '发声调音台分离了上声道构音器官（17 维形状）与喉部声门源（8 维声门几何、黏膜波相位滞后及微扰参数）。默认采用 25 ms 高斯时间窗平滑控制节点，避免离散跳变引起咔嗒瞬态。',
      '单人调制默认开启带声软门控，自动保护清擦音与清塞音（如 /s, tɕ, p, k/）不被强制灌入声带周期振动；当明确切入耳语或清化状态时切为全活动门控。',
      '双人器官迁移对解剖腔体差异大的舌颌与喉位默认采取相对中位偏移移植，避免直接套用另一说话人绝对坐标造成舌腭穿模或声道闭死。',
    ],
    workflowSteps: [
      {
        title: '选择单人调制或双人迁移模式',
        detail: '左上角切换工作模式，单人模式加载一段录音或从声道重建直传轨迹；双人模式分别加载源说话人与目标说话人音频。',
        uiHint: '左轨模式切换卡片',
      },
      {
        title: '绘制时变发声态曲线或配置器官权重',
        detail: '单人模式在主曲线区点击添加控制节点并绑定发声预设；双人模式先执行构音 DTW 或 TextGrid 对齐，再按舌颌、唇形、鼻化、喉位与 512 维音色向量球面插值（SLERP）调节比例。',
        uiHint: '右主区时变曲线编辑器 · 左轨器官滑块',
      },
      {
        title: '选区声学对比与渲染导出',
        detail: '渲染后切换波形与语谱视图，核查调制前后谐波结构与频谱倾斜度的变化，满意后可直接保存为素材或导出 WAV。',
        uiHint: '曲线头部波形/语谱切换 · 渲染按钮',
      },
    ],
    demoSpec: {
      id: 'demo-mixer-phonation',
      kind: 'mixer-phonation',
      title: '生动案例：汉语「算」[swan⁵¹] 动态构音叠加六档发声类型对照',
      subtitle: '沿用真实动态口腔轨迹 /s-w-a-n/（0.85s），自动保护句首清擦音 /s/ 并对浊音段分别施加紧嗓、常态、气声、耳语、嘎裂与假声',
      requiresEngine: 'required',
      phoneticGoal: '摆脱单一稳态元音的机械感，直观听辨同一动态汉语词在六种声门机制下的咬字保留与音质分化。',
      expectedObservation: '前置清擦音 /s/ 始终保持自然清音气流不被灌入声带振动；随后的 /wan/ 韵母随六档切换在后裂隙 CA、周期振幅 RA 与微扰 SHIM 上呈现清晰阶梯差异。',
      buttonLabel: '在本机合成「算」六态对比',
    },
    chartKey: 'voqsScale',
    pitfalls: [
      {
        title: '避免极高音与强嘎裂无保护叠用',
        detail: '假声高音调与强嘎裂具有相反的声带张力生理机制，双态极端权重同时拉满可能导致声门模型陷入非物理谐波失真。',
      },
      {
        title: '双人混合需先确认语速与音节对齐',
        detail: '若两段语料词句完全不同，请切回基于声学相似度的 DTW 构音对齐或缩短待混合片段，否则器官张合将错位。',
      },
    ],
    shortcuts: [
      ['播放或暂停调制前后对听', 'Space'],
      ['删除当前选中曲线节点', 'Delete'],
    ],
  },
  {
    id: 'continuum',
    sectionAnchor: 'mod-continuum',
    navTitle: '声道连续统',
    title: '声道连续统 · 20 格实验感知刺激矩阵与高音移调试听',
    code: 'MOD-05 · PERCEPTION CONTINUUM',
    icon: 'timeline',
    perspectiveBadge: '实验语音学视角',
    summary:
      '面向范畴感知实验与语音连续统制作，支持选取任意起止音段构形（单轴或双轴），按设定步数自动生成等间隔插值声道与发声态刺激矩阵，同步提供 550–800 Hz 超高音持续元音 TD-PSOLA 试听工具。',
    phoneticBasisTitle: '阻音保护插值与高频载波移调原理',
    phoneticBasis: [
      '单纯对起止参数做朴素线性平均很容易让擦音或塞音成阻在中间格意外断开。本内核在构造连续统时自动识别关键成阻器官：同部位同方法保持收窄护栏，跨部位切换采取对数面积与半程切换保护。',
      '针对需要研究女高音歌唱等超出 VTL 600 Hz 原生控制上限的持续元音场景，高音试听面板先自动寻优稳定物理载波，再用 TD-PSOLA 时域基音同步叠加移调至 550–800 Hz，同时保留原载波供科研核验。',
    ],
    workflowSteps: [
      {
        title: '选定起止构型与矩阵维度',
        detail: '在左侧栏分别选择起点音标/构形与终点构形（如 /i/–/u/、/s/–/ʂ/ 或不送气–送气 VOT），设置格数（默认 20 格，可切换单轴或 4 行双轴）及基频/发声条件。',
        uiHint: '左栏连续统配置面板',
      },
      {
        title: '生成网格与逐格听辨',
        detail: '点击合成全部刺激后，在右侧网格依次点击各步格子，对比矢状面轮廓叠影、最小截面积 Amin 与 F1–F3 共振峰连续漂移。',
        uiHint: '右栏连续统矩阵与解剖对比',
      },
      {
        title: '导出刺激包或单格送入工作台',
        detail: '可将整组连续统音频与逐格物理参数 CSV 打包下载直接用于 PsychoPy/E-Prime 感知实验，也可将关键过渡格送回语音合成或剪辑。',
        uiHint: '右上动作条下载全部',
      },
    ],
    demoSpec: {
      id: 'demo-continuum-suan-swan',
      kind: 'continuum-suan-swan',
      title: '生动案例：汉语「算」[swan⁵¹] ↔ 英语「swan」[swɒn] 跨语言连续统',
      subtitle: '沿用预录校准的两条真实动态轨迹（0.85s），在 19 维构型、基频与声压间等步插值 8 格并实时合成每格波形与动画',
      requiresEngine: 'required',
      phoneticGoal: '观察跨语言近音词对从汉语前低展唇 [a]（51 全降调）连续滑向英语后低圆唇 [ɒ]（平缓低降调）时，韵腹 F2 随舌背后缩与圆唇协同下跌的过程。',
      expectedObservation: '从 S0（汉语「算」）到 S7（英语「swan」），元音段 F2 由约 1350 Hz 连续滑落至 820 Hz 附近，矢状面清晰体现双唇前突收窄与舌体后缩；点击任意格可听音并查看动态构音。',
      buttonLabel: '在本机生成「算 ↔ swan」8 格连续统',
    },
    pitfalls: [
      {
        title: '跨音素连续统留意时长归一',
        detail: '进行感知边界测试时建议开启等时长模式，以免被试借助音段长短作为次要线索代替频谱判断。',
      },
      {
        title: '高音 TD-PSOLA 移调仅限持续稳态元音',
        detail: '550–800 Hz 移调算法专为持续元音设计，带瞬态爆破或清擦音的音节移调会产生不自然周期感。',
      },
    ],
    shortcuts: [
      ['试听当前选中连续统格', 'Space'],
    ],
  },
  {
    id: 'dialect',
    sectionAnchor: 'mod-dialect',
    navTitle: '发音字典管理',
    title: '发音字典管理 · 多语个人字典、方言五度调型与连读变调',
    code: 'MOD-06 · LEXICON & SANDHI',
    icon: 'dialect',
    perspectiveBadge: '实验语音学视角',
    summary:
      '集中维护个人多语发音词条（高于内置词典优先级）、10 套汉语注音标准与自定义方言声调包，支持手绘赵元任五度调型曲线、SwiftF0 实录声调采集，以及三类确定性非递归连读变调规则编写与试听。',
    phoneticBasisTitle: '五度制 qTA 映射与非递归变调原则',
    phoneticBasis: [
      '声调调值采用赵元任五度标记（1–5 度），由内核按说话人音域下限与跨度换算为相对半音目标，再交由 3 阶临界阻尼 qTA 平滑连接相邻音节边界，避免生硬折线拐点。',
      '为确保连读变调过程可预测且必然终止，规则引擎严格按「词条特例（lexical）→ 整词模式（word_pattern）→ 相邻两字组（pair）」顺序执行一次非递归改写，每个音节至多被改写一次。',
      '针对粤语、吴语、闽语等含入声韵尾的方言，调类支持勾选 checked（促声）与塞音无声除阻标记（unreleased / glottal）。',
    ],
    workflowSteps: [
      {
        title: '选择或新建方言与个人字典',
        detail: '第 1 列管理字典库（支持导入导出 JSON/TSV），第 2 列浏览并检索词条，第 3 列在通用词条与方言调类之间切换编辑。',
        uiHint: '第 1–3 列字典列表与编辑器',
      },
      {
        title: '配置词形→IPA 与手绘五度调型',
        detail: '为词条指定精确 IPA 与调号，或在方言调类面板手绘基频目标曲线；也可上传一段单字实录，调用 SwiftF0 自动提取 50 Hz 基频拟合调值。',
        uiHint: '第 3 列词条编辑 · 第 4 列调型工具',
      },
      {
        title: '编写三类变调规则并实时试听',
        detail: '在右侧字典工具添加词条特例、整词调型或两字连读规则，输入测试句即可即时对比变调前后的调值序列与合成听感。',
        uiHint: '第 4 列字典工具与合成测试',
      },
    ],
    demoSpec: {
      id: 'demo-dialect-sandhi',
      kind: 'dialect-sandhi',
      title: '生动案例：普通话上声连读与方言广用式变调 qTA 曲线演算',
      subtitle: '纯前端毫秒级运行 3 阶临界阻尼 qTA 与非递归变调规则，直接对照单字原调与连读变调基频走势',
      requiresEngine: 'none',
      phoneticGoal: '对比连续语音中“单字本调拼接”与“规则变调后连读”在基频目标曲线与音节边界过渡上的平滑差异。',
      expectedObservation: '上声双连读「老虎」（214+214 → 35+214）中，前字脱离低谷抬升为上升调，与后字低降起点形成自然折返；三连读「买好马」按非递归规则一次完成左分支改写；「天地」呈现前字 55 → 33 的中平化过渡。',
      buttonLabel: '在本机演算法则变调 F0 曲线',
    },
    pitfalls: [
      {
        title: '注意三类规则的优先级覆盖关系',
        detail: 'lexical 优先级最高，一旦命中即锁定该音节不被后续 word_pattern 或 pair 规则二次改写，编写特例词时不必重复写泛化规则。',
      },
      {
        title: '入声字调长缩放 dur_scale 需匹配语速',
        detail: '促声短调通常将 dur_scale 设为 0.55–0.75，并搭配闭塞释放策略，过高会失去短促听感。',
      },
    ],
    shortcuts: [
      ['新建词条', '点击列表栏新增按钮'],
      ['保存当前词条修订', 'Ctrl + S / 点击保存'],
    ],
  },
  {
    id: 'card',
    sectionAnchor: 'mod-card',
    navTitle: '发音卡排版工坊',
    title: '发音卡工坊 · 自由分栏网格、声学图表拼排与多格式导出',
    code: 'MOD-07 · PHONETIC CARD STUDIO',
    icon: 'image',
    perspectiveBadge: '科普与论文制图视角',
    summary:
      '将当前工作台的 2D 矢状面轮廓、面积/传递函数、元音共振峰分布、语谱与连续统网格模块自由拖入响应式分栏画布，在浏览器端直接排版导出高清 PNG，或通过本地代理调用 FFmpeg 合成 MP4/GIF 动态发音卡。',
    phoneticBasisTitle: '多维声学证据同框对照规范',
    phoneticBasis: [
      '一张优质的语音学演示卡片把“构音器官形态（矢状面/唇形）— 声道共振响应（传递函数/面积）— 声学结果（语谱/F1–F2）”并置对齐，使读者无需跨图翻页就能建立物理因果联系。',
      '发音卡自动适配 1:1 方卡、16:9 横卡、3:4/9:16 竖卡等画幅比例并重构分栏树；导出动态 MP4 或 GIF 时会自动将宽高对齐到偶数像素以满足视频编码器要求。',
    ],
    workflowSteps: [
      {
        title: '从当前工作台载入推荐模块',
        detail: '点击右上角「载入当前工作台推荐模块」一键带入当前语境模块，或从左侧模块库拖拽任意声学卡片插入画布边缘与分割线。',
        uiHint: '弹窗顶部栏 · 左侧模块库',
      },
      {
        title: '调节画幅比例、皮肤与音源绑定',
        detail: '切换方卡/横卡/竖卡比例及卡片配色皮肤；如导出动卡（MP4/GIF），选择同步绑定播放的音频源（物理合成、神经声码器或参考录音）。',
        uiHint: '画布比例栏 · 右侧外观与音源栏',
      },
      {
        title: '实时预览并导出 PNG / MP4 / GIF',
        detail: 'PNG 静态图直接在浏览器本地零延迟渲染下载；MP4/GIF 动卡通过本地代理与 FFmpeg 编码并在弹窗内即时预看。',
        uiHint: '右下导出格式与操作按钮',
      },
    ],
    pitfalls: [
      {
        title: 'MP4/GIF 导出需要本地代理与 FFmpeg 就绪',
        detail: '若仅需静态科研插图，推荐优先导出 PNG，不依赖代理转码且原生分辨率极高。',
      },
    ],
    shortcuts: [
      ['关闭发音卡工坊弹窗', 'Esc'],
    ],
  },
];
