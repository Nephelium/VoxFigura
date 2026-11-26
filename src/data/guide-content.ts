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
  GuideDemoKind,
  GuideDemoSpec,
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
    ],
  },
  {
    title: '声道标注与重建',
    rows: [
      ['播放 / 暂停（局部选区或整句）', 'P / Space'],
      ['时间轴以光标为焦点横向缩放', 'Ctrl + 滚轮'],
      ['选中音节或音素区间', '单击区间'],
      ['编辑汉字、音标或 VoQS 标签', '双击区间'],
      ['框选连续分析与试听区间', '鼠标拖拽选区'],
    ],
  },
  {
    title: '声乐编曲 · 钢琴卷帘',
    rows: [
      ['选中音块升降半音', '↑ / ↓'],
      ['上下拖动改变目标音高', '拖动音块'],
      ['将选中音块定到对应琴键音高', '点击左侧琴键'],
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
    title: '剪辑 · 片段编辑',
    rows: [
      ['开关吸附对齐（磁吸）', 'S'],
      ['在播放头位置分割片段', 'B'],
      ['复制 / 粘贴 / 就地复制片段', 'Ctrl + C / V / D'],
      ['删除当前选中片段', 'Delete / Backspace'],
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
  lead: '工作台将实验语音学标注、三维物理声道仿真、实录语音反演、发声类型调制、感知连续统、方言变调与视听声乐编曲统一在同一 48,000 Hz 整数采样工程（.vcproj）内，数据可在各视图间直接传递。',
  bullets: [
    {
      head: '两条科研与创作起点',
      body: '可以从文本或国际音标出发（语音合成 → 国际音标表 Plus → 连续统/发音字典管理 → 编曲/剪辑），也可以从实录音频出发（声道动态重建 → 发声调音台调制与器官移植 → 赋给目标音标或导入编曲台改音高演唱）。',
    },
    {
      head: '双通道声源随时对听',
      body: '所有合成与重建页面均支持在 VTL 2.4 物理声管合成（48 kHz，严格服从声学管段传递函数）与 Tract2Vox-Lite 神经声码器（支持 512 维音色迁移）之间即时切换对比。',
    },
    {
      head: '本地实时演示与零负担缓存',
      body: '本说明书内嵌的所有生动演示案例均由你的本机引擎与前端内核现场计算生成，结果自动保留在浏览器 IndexedDB 缓存中，既避免软件安装包体积膨胀，也能在下次打开时直接回放。',
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
    lead: '语音合成标注栏、G2P 文本转换与方言词条共享同一形式语法解析器，一次书写即可同步驱动 19 维声道构型、qTA 基频轮廓与 10 维声门发声类型锚点。',
    chartKey: 'voqsScale',
    showVoqsBadges: true,
    bullets: [
      {
        head: '空格分音节与连写弧保护',
        body: '音节间以空格分隔（例如 [pəi˨˩˦ fəŋ˥˥]）。音节内自动拆分普通复元音动程，同时严格保护连写塞擦音与双部位辅音弧（t̠͡s̟ʰ、k͜pʼ）以及显式不成音节下加弧（aɪ̯）。',
      },
      {
        head: '声调三套写法完全互通',
        body: '同时支持右上上标数字（ma⁵⁵ / ma³⁵ / ma²¹⁴ / ma⁵¹）、国际音标五度折线调号（˥ ˦ ˧ ˨ ˩ 组合如 ˧˥、˨˩˦）与方言左干变调调号，自动换算为音节内平滑 qTA 基频靶位。',
      },
      {
        head: 'VoQS 大括号嵌套规范（Ball, Esling & Dickson 2018）',
        body: '成对花括号加首尾标签包裹任意词句，如 {3V̤ pʰa˥˩ 3V̤} 表示 3 度强气声；支持喉高与发声态多层嵌套如 {L̝ 1V͈ ta˥˥ {2V̰ ta˨˩ 2V̰} 1V͈ L̝}。前标 1/2/3（省略默认为 2）对应 35%/70%/100% 声门混合度及 ±0.20/±0.50/±0.80 cm 喉高偏移，出括号自动平滑恢复常态浊声。',
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
    title: '本地轻量化模型矩阵（9 项 ONNX）热插拔装载与外置换模操作',
    lead: '全部 9 个本地推理模型运行于纯 ONNX Runtime（零 PyTorch 运行时依赖，共 58.96 MiB），可在「设置 → 声学引擎与模型」页面实时控制装载、卸载与自定义权重热替换。',
    actionButton: { label: '直接打开「声学引擎与模型」矩阵', overlay: 'settings', settingsTab: 'engine' },
    bullets: [
      {
        head: '单模装载 / 卸载与内存即时回收',
        body: '点击任意模型卡片左下角的「装载 / 卸载」按钮，即可按需将 ONNX 会话载入内存或释放内存；右上角工具栏提供「全部装载」「全部卸载」与「核验权重」一键批处理。',
      },
      {
        head: '单槽「换模」与整目录扫描装载',
        body: '点击卡片上的「换模」按钮可上传自训 .onnx 文件（网页上传上限 64 MiB；本地路径/目录挂载支持至 256 MiB）。引擎严格校验输入输出张量契约，通过后生效并标注「外置」徽章。',
      },
      {
        head: '一键恢复内置与优雅降级',
        body: '外置模型卡片提供「恢复内置」按钮。卸载可选模块时系统自动平滑降级：卸载 Text2Prosody-Lite 退回规则韵律，卸载 IPA2Tract-Lite 退回基础 qTA 轨迹，卸载 Tract2Area-Proxy 跳过局部面积检查。',
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
        body: '全仓时间统一使用 48,000 Hz 整数采样点与左闭右开区间 [start_smp, end_smp)。对编辑基频 F0（60–600 Hz）、声门下压 PR（0–1600 Pa）及塞音刚性下限（闭塞 ≥ 10 ms、释放 ≥ 1 ms），越界参数一律返回 out_of_range 错误，绝不静默截断。',
      },
      {
        head: '六组声学口径严格区分',
        body: '① 控制基频 F0_ctl ≠ 实测输出音频基频；② 声管传递函数 H(f) 极点 ≠ 音频 LPC 共振峰；③ 声道重建候选解 ≠ 真人实测舌位；④ 60 fps 视觉插值帧 ≠ 原生求解帧；⑤ VTL 物理管段音频 ≠ Tract2Vox-Lite 神经音频；⑥ 局部试听 ≠ 整句定稿渲染。',
      },
      {
        head: '工程、音频和成片的导出格式',
        body: '语音合成和编曲右上角的「导出」支持 .vcproj 工程、试听 WAV、Praat .TextGrid、Praat .PitchTier，以及 50 Hz 时间序列、音段等分和单帧 CSV。剪辑导出支持 WebM / MP4 成片视频与多格式混音音频。',
      },
    ],
  },
];
