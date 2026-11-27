/**
 * Unified Documentation Source for VoxFigura (`GuideView.vue`, `ModuleGuideModal.vue`,
 * and shared `SHORTCUT_GROUPS` for `SettingsView.vue`).
 *
 * Combines 7 phonetics-first modules, 2 creative/production modules, optional edition-specific
 * module (`@vocalcut/edition`), system architecture overview, IPA/VoQS syntax, ONNX hot-plug
 * guide, scientific redlines, and global shortcuts.
 */

import { editionGuideModule } from '@vocalcut/edition';
import type { GuideModuleId } from '@/stores/workbench';
import type { GuideAppendixSection, GuideModuleDoc } from './guide-types';
import { PHONETICS_GUIDE_MODULES } from './guide-modules-phonetics';
import { CREATIVE_GUIDE_MODULES } from './guide-modules-creative';

export type {
  GuideAppendixSection,
  GuideCodeBlock,
  GuideDemoKind,
  GuideDemoSpec,
  GuideDiagramKey,
  GuideModuleDoc,
  GuidePitfall,
  GuideSyntaxTable,
  GuideWorkflowStep,
} from './guide-types';

export const VOQS_14_LIST: ReadonlyArray<{
  sym: string;
  name: string;
  group: string;
  physics: string;
}> = [
  { sym: 'V͈', name: '紧声（Pressed）', group: '声门压紧与漏气', physics: 'XB 负移、接触相增宽、声门脉冲突陡' },
  { sym: 'V', name: '常态浊声（Modal）', group: '声门压紧与漏气', physics: '默认基线，声带对称周期振动' },
  { sym: 'V̤', name: '气声（Breathy）', group: '声门压紧与漏气', physics: 'XB/XT 正移、后裂隙 CA 增大、吸气宽带噪声增强' },
  { sym: 'Ṿ', name: '耳语声（Whispery Voice）', group: '声门压紧与漏气', physics: '弱周期声带振动叠加显著裂隙湍流' },
  { sym: 'W', name: '耳语（Whisper）', group: '声门压紧与漏气', physics: 'RA ≤ 0 熄灭周期激励，纯声门裂隙宽带气流' },
  { sym: 'V̰', name: '嘎裂声（Creaky Voice）', group: '不规则振动与嘎裂', physics: '低基频 + 次谐波 + 高 SHIM 振幅微扰' },
  { sym: 'C', name: '嘎裂（Creak）', group: '不规则振动与嘎裂', physics: '极强振幅微扰与不规则声门脉冲间隔' },
  { sym: 'V̰̣', name: '耳语嘎裂声（Whispery Creak）', group: '不规则振动与嘎裂', physics: '裂隙漏气与低频嘎裂脉冲复合态' },
  { sym: 'F', name: '假声（Falsetto）', group: '假声及复合发声', physics: '低黏膜波相位滞后 LAG、窄接触相与高频谐波衰减' },
  { sym: 'F̣', name: '耳语假声（Whispery Falsetto）', group: '假声及复合发声', physics: '假声构形叠加显著后裂隙气流漏气' },
  { sym: 'F̰', name: '嘎裂假声（Creaky Falsetto）', group: '假声及复合发声', physics: '高基频假声态叠加速度/振幅周期抖动' },
  { sym: 'F̰̣', name: '耳语嘎裂假声', group: '假声及复合发声', physics: '假声、裂隙漏气与微扰三态复合' },
  { sym: 'L̝', name: '喉位偏高声（Raised Larynx）', group: '喉位录音参照', physics: 'HY 喉高正偏移（+0.20 / +0.50 / +0.80 cm），整体共振峰上移' },
  { sym: 'L̞', name: '喉位偏低声（Lowered Larynx）', group: '喉位录音参照', physics: 'HY 喉高负偏移（-0.20 / -0.50 / -0.80 cm），声道变长音色偏暗' },
];

export const SHORTCUT_GROUPS: ReadonlyArray<{ title: string; rows: ReadonlyArray<[string, string]> }> = [
  {
    title: '全局工作区',
    rows: [
      ['撤销上一步命令', 'Ctrl + Z'],
      ['重做命令', 'Ctrl + Shift + Z / Ctrl + Y'],
      ['开关 AI 助手抽屉', 'Alt + /'],
      ['打开设置中心', 'Alt + ,'],
      ['关闭当前浮层或弹窗', 'Esc'],
      ['打开风格实验室浮窗', 'Alt + Shift + S'],
      ['桌面窗口切换全屏', 'F11'],
    ],
  },
  {
    title: '声道标注、音标表、调音台、连续统与重建',
    rows: [
      ['播放 / 暂停（局部选区、整句、音标实录、调音台或连续统选中格）', 'P / Space'],
      ['发声调音台无缝轮切 原声 / 0% 基线 / 调音成品（或 A / B / 混合）', 'B'],
      ['发声调音台曲线节点微调 / 撤销重做 / 删点', '↑↓←→ · Ctrl+Z/Y · Del / 右键'],
      ['时间轴以光标为焦点横向缩放 / 步进缩放', 'Ctrl + 滚轮 · + / -'],
      ['语音合成 F0 基频轨纵轴缩放', 'Alt + 滚轮'],
      ['语音合成定位播放头 / 删除选中音素、静音段或选区', 'Home · Delete / Backspace'],
      ['语音合成复制、剪切、粘贴、原地复制与全选音素', 'Ctrl + C / X / V / D / A'],
      ['聚焦国际音标表 655 条目检索框', 'Ctrl + F'],
      ['复制当前选中音标字符 / 语音合成快捷板仅复制', 'Ctrl + C · 双击符号 · Ctrl + 单击'],
      ['国际音标表波形区逐帧微移 / 起终点 · 声道视口撤销重做', '← / → · Home / End · Ctrl+Z/Y'],
      ['选中 / 编辑音节、音标或 VoQS 标签', '单击选中 · 双击编辑'],
      ['框选连续分析与试听区间', '鼠标拖拽选区'],
      ['声道连续统切换当前选中格（单双轴矩阵）', '← / → / ↑ / ↓'],
      ['声道连续统试听格与同步缩放平移轮廓', '双击格 / 滚轮缩放 + 左键拖拽'],
      ['声道动态重建剪切选中音频 / 撤销剪切（最多 8 步）', 'Ctrl + X / Ctrl + Z'],
      ['声道动态重建微调对齐边界 1 ms / 10 ms', '← / → · Shift + ← / →'],
    ],
  },
  {
    title: '声乐编曲 · 钢琴卷帘',
    rows: [
      ['播放或暂停合奏 / 当前轨试听', 'Space'],
      ['试听当前选中的单字音节', 'Shift + Space'],
      ['卷帘空白处快速添加音符', '双击空白网格'],
      ['选中音符升 / 降半音', '↑ / ↓'],
      ['调整音符起止时值', '拖音块左 / 右缘'],
      ['为待定音歌词定音或试听琴键', '点击左侧琴键'],
      ['框选时段 / 拖动空白网格框选', '拖动空白网格 · Shift + 拖动'],
      ['删除当前选区或单个聚焦音符', 'Delete（仅单音符聚焦可用 Backspace）'],
      ['横向 / 纵向缩放卷帘', 'Ctrl / Alt + 滚轮'],
      ['重命名轨道 / 取消选区或画笔', 'F2 / Esc'],
    ],
  },
  {
    title: '剪辑 · 播放与定位',
    rows: [
      ['播放或暂停剪辑时间线', 'Space'],
      ['前后微移 1 帧 / 快移 5 帧', '← / → · Shift + ← / →'],
      ['跳至时间轴起点 / 终点', 'Home / End'],
      ['时间轴横向放大 / 缩小', 'Ctrl + 滚轮 · = / -'],
      ['时间轴横向移动', 'Shift + 滚轮'],
      ['一键适配完整时间轴宽度', '\\'],
    ],
  },
  {
    title: '剪辑 · 片段编辑与卡点',
    rows: [
      ['开关时间轴对齐吸附至帧', 'S'],
      ['在播放头位置分割选中片段', 'B'],
      ['弹出片段右键快捷菜单', '片段上右键点击'],
      ['复制 / 粘贴 / 向后生成副本（聚焦时间线/舞台）', 'Ctrl + C / V / D'],
      ['删除当前聚焦项（时间线片段或素材）', 'Delete'],
      ['画布拖拽约束水平或垂直方向', 'Shift + 画布拖动'],
    ],
  },
  {
    title: '发音卡排版与导出工坊',
    rows: [
      ['撤销 / 重做工坊内排版、拆格与样式改动（独立历史栈）', 'Ctrl + Z · Ctrl + Shift + Z / Ctrl + Y'],
      ['播停当前发音卡声画预览（非输入框聚焦时）', 'Space'],
      ['悬停声道剖面格无级缩放视野（50%–320%）', '鼠标滚轮'],
      ['复位声道构图偏移 / 一键均分全卡分栏长宽', '双击声道格 · 双击分栏间隙'],
      ['整卡拖拽重排（四边 24% 嵌套分栏 / 中央 52% 互换或填槽）', '按住模块拖动 (> 5 px)'],
      ['关闭发音卡工坊（说明书打开时优先关闭说明书）', 'Esc'],
    ],
  },
];

export const ALL_GUIDE_MODULES: readonly GuideModuleDoc[] = [
  ...PHONETICS_GUIDE_MODULES,
  ...CREATIVE_GUIDE_MODULES,
  ...(editionGuideModule ? [editionGuideModule] : []),
];

const MODULE_MAP = new Map<GuideModuleId, GuideModuleDoc>(
  ALL_GUIDE_MODULES.map((mod) => [mod.id, mod]),
);

export function getGuideModuleById(id: GuideModuleId | null | undefined): GuideModuleDoc | undefined {
  if (!id) return undefined;
  return MODULE_MAP.get(id);
}

export const GUIDE_SYSTEM_OVERVIEW: GuideAppendixSection = {
  id: 'guideOverview',
  icon: 'stage',
  nav: '系统架构与工程流转',
  code: 'SYS-00 · WORKSPACE MAP',
  title: '工作台架构与一体化 48 kHz 工程流转',
  lead: '工作台将实验语音学标注、三维物理声道仿真、实录语音反演、发声类型调制、感知连续统、方言变调与多记谱法声乐编曲及非线性剪辑统一在同一 48,000 Hz 整数采样工程（.vcproj）内，数据可在各视图间直接传递。',
  bullets: [
    {
      head: '两条科研与创作起点',
      body: '可以从文本或国际音标出发（语音合成以顶栏直载与按需语料抽屉、全高音素替换板、2D/3D 声道剖面与方案 A 19 维精调侧栏、默认全展开四联声学分析及 100% 通栏多轨时间轴为核心，支持中英日/IPA/VoQS 编译、插入/删除/平移音素、F0 语调与平调切换及送编曲定音、个人词典、录音降噪与内联声道重建并对齐 → 国际音标表 Plus 查阅 655 条目、派生构型方案并精修 308 项实录目标帧 → 发音字典管理维护三层词典、音节胶囊连编、双画布方言调型与非递归变调规则 → 连续统 / 编曲 / 剪辑），也可以从实录音频或乐谱出发（声道动态重建完成波形弹窗裁剪与降噪、本地/在线转写对齐、50 Hz 27 维反演、9 轨全 27 维参数巡检、无损同步剪切、实时音色与发声预设热切换或三维透视人头重建 → 发声调音台执行单人时变 VoQS 调制、双人 9 轨器官/韵律/音色移植与 12 项声学参数对比，或将真人轨迹及 MIDI / VSQX / SVP 与五种简谱导入编曲台改音高演唱与配词，再送入剪辑做声音迁移、按文字切分与成片导出）。',
    },
    {
      head: '双通道声源、多记谱法与跨页发音卡制图协同',
      body: '所有合成与重建页面均支持在 VTL 2.4 物理声管合成（48 kHz）与 Tract2Vox-Lite 神经声码器（512 维声纹）间即时对听；编曲台内置 JE 谱及 4 种开源简谱 DSL，统一采用《...》单字包裹与带字内联写法，与 AI 助手 compile_score 工具无缝互通；任意页面产生的声道、声门、共振峰、语谱、重建、调音、连续统、方言、编曲与剪辑实时快照均可一键汇入发音卡排版与导出工坊，自由嵌套拼排导出高清图或音画卡片。',
    },
    {
      head: '零大图负担、纯矢量图示与实时交互沙盒',
      body: '本说明书完全摒弃高体积截图与静态图片，全部图示均以纯矢量 SVG、ECharts 参数曲线、结构蓝图代码框或复用真实渲染内核的交互沙盒呈现；本机实时演算与沙盒结果自动写入浏览器 IndexedDB 缓存，既保持安装包精巧，也可随时免重算复看。',
    },
  ],
};

export const GUIDE_SHARED_APPENDICES: readonly GuideAppendixSection[] = [
  {
    id: 'guideIpaVoqs',
    icon: 'book',
    nav: 'IPA、声调与 VoQS 语法',
    code: 'REF-01 · PHONETIC SYNTAX',
    title: '国际音标切分、声调三体系与 VoQS 大括号嵌套全量速查',
    lead: '语音合成标注栏、国际音标表 Plus、G2P 文本转换与方言词条共享同一国际音标与发声语法体系：既可在国际音标表 Plus 查阅、复制、试听 655 项 IPA / extIPA / VoQS 条目并直接向主标注写入构型、叠加附加符号或声门锚点，也可手写语法一次驱动 19 维声道构型、qTA 基频轮廓与 10 维声门锚点（与编曲台五种简谱记谱法的《...》音节绑定语法各司其职、互不冲突）。',
    chartKey: 'voqsScale',
    showVoqsBadges: true,
    bullets: [
      {
        head: '空格、停顿标点、连写弧与双引号词保护',
        body: '常规空格用于分隔音节（例如 [pəi˨˩˦ fəŋ˥˥]）。在 [...] 国际音标语法内，空格会插入 175 ms 短停顿且不拆断 Text2Prosody-Lite 连续句调；词尾或独立句点 . 与中圆点 · 插入 350 ms 长停顿并触发句尾韵律收束；词内紧贴句点（如 [ˈnɔ.məl]）保持 0 ms 音节断点，‿ 保持 0 ms 连读。音节内保留连写塞擦音与双部位辅音弧（t̠͡s̟ʰ、k͜pʼ）及不成音节下加弧（aɪ̯）。在 VoQS 花括号内写英语原词时请用双引号包住，例如 [a {F "falsetto" F}]。',
      },
      {
        head: '声调三套写法完全互通',
        body: '同时支持右上上标数字（ma⁵⁵ / ma³⁵ / ma²¹⁴ / ma⁵¹）、国际音标五度折线调号（˥ ˦ ˧ ˨ ˩ 组合如 ˧˥、˨˩˦）与方言左干变调调号，自动换算为音节内平滑 qTA 基频靶位。',
      },
      {
        head: 'VoQS 大括号嵌套规范（Ball, Esling & Dickson 2018）',
        body: '成对花括号加首尾标签包裹任意词句，如 {3V̤ pʰa˥˩ 3V̤} 表示 3 度强气声；支持喉高与发声态多层嵌套如 {L̝ 1V͈ ta˥˥ {2V̰ ta˨˩ 2V̰} 1V͈ L̝}。前标 1/2/3（省略默认为 2）对应 35%/70%/100% 声门混合度及 ±0.20/±0.50/±0.80 cm 喉高偏移，出括号自动平滑恢复常态浊声。在编曲简谱中花括号留给各记谱法自身语法，单字音节改用《...》包裹。',
      },
    ],
    tables: [
      {
        caption: '国际音标与 VoQS 常用书写范例速查',
        tag: 'IPA / VoQS Examples',
        headers: ['语法类型', '合法输入示例', '解析与合成行为说明'],
        rows: [
          ['中英日混排 + 内联 IPA', '今天天气真好 [tɕin˥˥ tʰjɛn˥˥] hello', '中文走内置 10 套注音方案之一，英语查 CMUdict，方括号内直走 IPA 解析'],
          ['五度调号 / 上标数字', '[ma˥˥ ma˧˥ ma˨˩˦ ma˥˩] 或 ma⁵⁵ ma²¹⁴', '按五度制音域折算为相对半音/Hz 基频目标曲线，支持半三声 ˨˩'],
          ['VoQS 单层标量度', '{1V̤ 轻度气声 1V̤} / {3V̰ 强嘎裂 3V̰}', '1 = 35% 混合，2 = 70%（省略数字默认），3 = 100% 完全切换至实录声门锚点'],
          ['VoQS 喉位 + 发声多层嵌套', '{L̝ 1V͈ 抬喉紧声 {3F 切假声 3F} 1V͈ L̝}', '支持任意深度栈式嵌套，内层优先覆盖发声态，出内层自动还原外层状态'],
          ['[IPA] 停顿与连读', '[ˈnɔ.məl ˈvɔɪs. ˈfɑːr‿əˈweɪ]', '词内紧贴 . 与 ‿ 为 0 ms，空格为 175 ms 不断句短停顿，词尾或独立 . / · 为 350 ms 长停顿'],
          ['VoQS 内嵌英语原词', '[a {F "falsetto" F}]', '花括号内的英文词汇加英文双引号，防止被拆解为 VoQS 符号或喉音字母'],
          ['独立附加符号无损叠加', '在国际音标表 Plus 选中 ʷ / ʲ / ̃ / ˤ / ̥ / ̚ 等', '点击「叠加到当前时间轴音素」直接向选中非休止音素合并字符并叠加安全声道增量'],
          ['未实录 VoQS 安全剥离', '{V! 文本 V!} 或 {ꟿ 文本 ꟿ}', '未完成实录标定的 VoQS 符号自动无损剥离标签并提示，绝不破坏音素切分'],
        ],
      },
    ],
  },
  {
    id: 'guideModelPlug',
    icon: 'cpu',
    nav: '本地 ONNX 装载与换模',
    code: 'REF-02 · ONNX HOT-PLUG',
    title: '本地轻量化模型矩阵（8 项核心 ONNX + 1 项可选方言对齐）热插拔与外置换模',
    lead: '默认 8 个核心本地推理模型运行于纯 ONNX Runtime（零 PyTorch 运行时依赖，合计 37.44 M 参数 / 77.61 MiB；Vox2Tract-Lite 已内置中英联合对齐），可在「设置 → 声学引擎与模型」页面实时控制装载、卸载、目录扫描与自定义权重热替换。',
    actionButton: { label: '直接打开「声学引擎与模型」矩阵', overlay: 'settings', settingsTab: 'engine' },
    bullets: [
      {
        head: '单模装载 / 卸载与内存即时回收',
        body: '点击任意模型卡片左下角的「装载 / 卸载」按钮，即可按需将 ONNX 会话载入内存或释放内存；右上角工具栏提供「全部装载」「全部卸载」「从文件夹装载」与「核验权重」一键批处理。',
      },
      {
        head: '单槽「换模」、目录扫描与方言对齐扩展',
        body: '点击卡片上的「换模」按钮可上传自训 .onnx 文件（网页上传上限 64 MiB；「从文件夹装载」支持本地路径或目录选择，最高支持 256 MiB）。如需针对其他语种或方言自行训练独立对齐模型，可在矩阵底部展开可选的「Vox2Align-Lite v2」兼容槽位挂载。',
      },
      {
        head: '一键恢复内置与优雅降级',
        body: '外置模型卡片提供「恢复内置」按钮。卸载可选模块时系统自动平滑降级：卸载 Text2Prosody-Lite 退回规则韵律，卸载 IPA2Tract-Lite 退回基础 qTA 轨迹，卸载 Tract2Area-Proxy 跳过局部面积检查；声道动态重建的本地自动转文字模型（SenseVoice-Small int8 ONNX，约 228 MB）按需下载至用户缓存并单独校验卸载，不占用 8 项内置核心槽位。',
      },
    ],
  },
  {
    id: 'guideRedlines',
    icon: 'shield',
    nav: '科研红线与全局快捷键',
    code: 'REF-03 · INTEGRITY & KEYS',
    title: '科研可信度红线、标准导出产物与全局快捷键总览',
    lead: '为确保所有音频、标注与物理参数可直接用于实验语音学论文分析与复现，系统在采样网格、物理量纲与声学口径上执行严格守卫。',
    showShortcutGroups: true,
    bullets: [
      {
        head: '48,000 Hz 整数采样与越界即拒绝',
        body: '全仓时间统一使用 48,000 Hz 整数采样点与左闭右开区间 [start_smp, end_smp)。对基频 F0（须为正有限值 > 0 Hz，其中 VTL 2.4 物理声门保留 40–600 Hz 硬件边界，神经合成不设固定上下限）、声门下压 PR（0–1600 Pa）及塞音刚性下限（闭塞 ≥ 10 ms、释放 ≥ 1 ms），越界参数一律返回 out_of_range 错误，绝不静默截断。',
      },
      {
        head: '六组声学口径严格区分',
        body: '① 控制基频 F0_ctl ≠ 实测输出音频基频；② 声管传递函数 H(f) 极点 ≠ 音频 LPC 共振峰；③ 声道重建候选解 ≠ 真人实测舌位；④ 60 fps 视觉插值帧 ≠ 原生求解帧；⑤ VTL 物理管段音频 ≠ Tract2Vox-Lite 神经音频；⑥ 局部试听 ≠ 整句定稿渲染。',
      },
      {
        head: '工程、乐谱、词典、音频、卡片、字幕与成片的导出格式',
        body: '语音合成与编曲右上角「导出」支持 .vcproj 工程、多轨标准 .mid / VOCALOID .vsqx / Synthesizer V .svp（编曲）、合奏或分轨 WAV/MP3、Praat .TextGrid、Praat .PitchTier，以及 50 Hz 时间序列、音段等分和单帧 CSV；编曲亦支持双向导入 .mid/.midi、.vsqx 与 .svp。声道动态重建支持导出校正后的 Praat .TextGrid、将播放头线性插值 19 维构型写入可编辑国际音标方案，以及将音频与 50 Hz 27 维轨迹直传标注、调音台、编曲、剪辑与连续统。发声调音台支持无损 WAV、选区 12 项发声声学指标（H1*−H2* / CPP / HNR / 谱倾斜）UTF-8 CSV 与裁剪同步 Praat .TextGrid 导出。发音字典管理支持 CSV/TSV UTF-8 词表映射导入与个人字典 / 方言字典 JSON（vocalcut.dialect/1，含自定义 19 维构型套装）整包交换。国际音标表 Plus 支持单条与全库参考录音 ZIP 导出（含按人工 TextGrid 对齐的原录音 WAV、TextGrid、重建音 WAV、50 Hz 轨迹 JSON、manifest.json 与可选声带频闪 MP4）。声道连续统支持一键导出完整感知刺激包 ZIP（全部 WAV + manifest.json + UTF-8 BOM acoustic_table.csv）、0.22 s 间隔拼接序列 WAV、单格 WAV、跟随视口的 WebM 声道动画视频及纯参数 JSON。发音卡排版与导出工坊支持 360–3840 px 自定义与 6 档常用比例、递归嵌套分栏与所见即所得留白保留、浏览器端高清 PNG 下载与一键复制至剪贴板，以及通过本地代理分批编码导出 MP4（H.264 24/30 fps，偶像素对齐，可选 48 kHz AAC 同步音轨，450 帧/15 s 上限）和 GIF（12/15/20 fps 无声两遍调色板动图），且支持本机常用方案持久化与实机样片零重复保存。剪辑导出支持 MP4（H.264 30/60 fps）与 WebM 成片视频、48 kHz 序列总混音（WAV / FLAC / MP3 / M4A）、媒体库单音频多格式转码导出及多轨 SRT / ASS 双行歌词音标字幕。',
      },
    ],
  },
];
