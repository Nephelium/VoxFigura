/**
 * VoxFigura Core Batch-2 Model Training Technical Report, Architecture Specs,
 * 27D Physical Control Space, 32D IPA Feature System, Expanded Corpus Inventory & ONNX Contracts.
 * Single source of truth for `ModelReportView.vue`, `SettingsView.vue`, and `AboutView.vue`.
 *
 * All metrics, layer counts, corpus counts, and tensor contracts are verified directly against
 * Batch-2 training summaries (`F:/TensorTract3_Train/runs/`) and `engine/model_registry_runtime.py`.
 */

import { APP_BRAND_NAME } from './app-branding';

export interface LocalModelSpec {
  name: string;
  paramsM: number;
  sizeMb: number;
  precision: 'FP16' | 'FP32' | 'ONNX';
  role: string;
  pipelineStage: string;
  cpuLatencyMs: number;
  trainSteps: string;
  bestMetric: string;
  optionalSlot?: boolean;
}

/**
 * Default 8-model local pure-ONNX runtime matrix.
 * `Vox2Tract-Lite` now mounts the unified `Vox2TractAlign v4` (vocal tract + 7-head alignment),
 * so standalone `Vox2Align-Lite v2` is hidden & unloaded by default (kept in OPTIONAL_LOCAL_MODEL_SPECS
 * for users who train custom aligners for other languages or dialects).
 */
export const LOCAL_MODEL_SPECS: readonly LocalModelSpec[] = [
  {
    name: 'Vox2Tract-Lite',
    paramsM: 9.40,
    sizeMb: 18.15,
    precision: 'ONNX',
    role: '16 kHz 语音单次前向联合反演 50 Hz 27 维声道声门轨迹与中英双语音素对齐/静音门控',
    pipelineStage: '联合反演与对齐',
    cpuLatencyMs: 24.3,
    trainSteps: '飞轮精调 10,000 步 / best @8k（56.4 min）',
    bestMetric: 'T17 PCC 0.9108 · 中/英 ≤20ms 93.0% / 94.9% · Mask F1 0.989',
  },
  {
    name: 'Tract2Vox-Lite',
    paramsM: 14.39,
    sizeMb: 27.56,
    precision: 'ONNX',
    role: '27 维声道声门轨迹与 512 维声纹联合驱动的高保真神经声码器（默认 Large v2.1，可选 3.73M Lite v3）',
    pipelineStage: '神经声码器',
    cpuLatencyMs: 238.4,
    trainSteps: 'Large v2.1 13k+4k 飞轮精调（43.8 min）',
    bestMetric: 'L24 0.8926 · L6 0.7910 · S1 闭环 L24 0.8737（Lite v3 50 句 ASR 7.18%）',
  },
  {
    name: 'Vox2Spk-Lite',
    paramsM: 4.60,
    sizeMb: 8.82,
    precision: 'ONNX',
    role: '跨音域高区分度 512 维说话人声纹编码器（覆盖常规人声与女高音/戏剧独唱）',
    pipelineStage: '音色声纹编码',
    cpuLatencyMs: 4.3,
    trainSteps: 'v2 18k + v2.1 区分度精调 7k / best @4.2k（13.5 min）',
    bestMetric: '常规 Teacher Cos 0.9422 · 女声 Gap 0.3531 · 165 Hz 换声 Cos 0.8013',
  },
  {
    name: 'IPA2Tract-Lite',
    paramsM: 4.23,
    sizeMb: 8.18,
    precision: 'ONNX',
    role: '基于 32 维窄标 IPA 特征与 293 键构型库的连续协同发音动态声道残差规划',
    pipelineStage: '协同构音规划',
    cpuLatencyMs: 10.1,
    trainSteps: 'Stage-2 v4 32D 联合精调 8,000 步（35.4 min）',
    bestMetric: '较基线降误差 43.4%（宽域 50.7%）· EMA LD 0.7013 · 零泄漏 0.0',
  },
  {
    name: 'DPDFNet',
    paramsM: 2.58,
    sizeMb: 10.01,
    precision: 'ONNX',
    role: '实录语料前端 48 kHz 实时语音增强与宽带底噪抑制',
    pipelineStage: '音频前端降噪',
    cpuLatencyMs: 18.0,
    trainSteps: '预训练开源 ONNX',
    bestMetric: '48 kHz 高解析流式降噪，保护高频擦音细节',
  },
  {
    name: 'Text2Prosody-Lite',
    paramsM: 1.98,
    sizeMb: 3.88,
    precision: 'ONNX',
    role: '普通话、英语、中英混排与任意手写 [IPA] 的音素时长、相对半音 F0 轮廓及停顿预测',
    pipelineStage: '多语与 IPA 韵律',
    cpuLatencyMs: 1.5,
    trainSteps: 'Stage-2 v4 32D 联合精调 8,000 步 / best @2.4k',
    bestMetric: '中/英/IPA 时长 MAE 22.6 / 17.3 / 21.4 ms · F0 PCC 0.779',
  },
  {
    name: 'Tract2Area-Proxy',
    paramsM: 0.23,
    sizeMb: 0.88,
    precision: 'ONNX',
    role: '关键帧规划阶段的可微 6 维声道关键区面积代理（全口腔、双唇、舌冠、舌背、咽腔最小截面积与腭咽口面积）',
    pipelineStage: '可微物理守卫',
    cpuLatencyMs: 0.4,
    trainSteps: '25 epochs / 300k 帧',
    bestMetric: '6 维关键区面积 MAE 0.0478 cm²',
  },
  {
    name: 'SwiftF0',
    paramsM: 0.03,
    sizeMb: 0.13,
    precision: 'ONNX',
    role: '超轻量低延迟实测基频轨迹提取（46.875–2093.75 Hz）与清浊音判别',
    pipelineStage: '基频提取前端',
    cpuLatencyMs: 4.2,
    trainSteps: '预训练开源 ONNX 0.3.0',
    bestMetric: '50 Hz 锁相 · 29.9K 参数宽音域提取',
  },
] as const;

/** Optional standalone aligner kept hidden & unloaded by default when unified Vox2TractAlign v4 is active. */
export const OPTIONAL_LOCAL_MODEL_SPECS: readonly LocalModelSpec[] = [
  {
    name: 'Vox2Align-Lite v2',
    paramsM: 4.33,
    sizeMb: 8.37,
    precision: 'ONNX',
    role: '可选独立对齐槽位：常规中英已并入 Vox2Tract-Lite 联合模型，本槽位默认隐藏且不装载，保留供用户针对其他语种或方言自行训练并挂载独立对齐模型',
    pipelineStage: '方言/多语可选对齐',
    cpuLatencyMs: 13.5,
    trainSteps: '独立对齐兼容槽位（可自训微调）',
    bestMetric: '支持 65 类音素 + 415 音节 CTC，外置挂载后自动接管对齐',
    optionalSlot: true,
  },
] as const;

export const LOCAL_MODEL_TOTALS = {
  count: LOCAL_MODEL_SPECS.length,
  totalParamsText: '37.44 M',
  totalSizeText: '77.61 MiB',
} as const;

export const MODEL_TRAINING_REPORT_META = {
  version: '技术报告 · Batch-2 (2026-11-27)',
  suiteName: 'VoxFigura Core 第二代物理—神经模型体系（8 项端侧纯 ONNX 矩阵）',
  geometryStandard:
    'VocalTractLab 2.4（原生 R21 声管管线）/ JD2 成年男声 3D 解剖几何（65 截面面积函数 · 200 Hz 物理管段 · 50 Hz 神经控制 · 48 kHz 整数采样输出；宽域基频平滑外延至 20–1200 Hz）',
  hardwareEnv:
    '单卡 NVIDIA GeForce RTX 5090 Laptop GPU (24 GB VRAM) · Python 3.11 · PyTorch 2.7+cu128 · 推理端纯 ONNX Runtime（零 PyTorch 运行时依赖）',
  cpuBenchmarkProtocol:
    '纯 ONNX Runtime（CPUExecutionProvider，intra_op=4 / inter_op=1，统一 3.0 s / 150 帧或 40 音素输入）算子图前向实测：Vox2TractAlign v4 24.3 ms、Tract2Vox-Large v2.1 238.4 ms（轻量档 Lite v3 为 152.5 ms）、Vox2Spk-v2.1 4.3 ms、IPA2Tract-Lite v4 10.1 ms、Text2Prosody-Lite v4 1.5 ms、Tract2Area-Proxy 0.4 ms、SwiftF0 4.2 ms、DPDFNet 48 kHz 流式 18.0 ms。',
  updatedNote:
    '本报告聚焦第二代（Batch-2）最新训练成果：通过联合反演对齐架构将默认运行矩阵精简为 8 个纯 ONNX 模型，引入 32 维窄标 IPA 特征与 293 键构型库，大幅扩充情感、戏曲、歌唱与宽音域真实语料，并给出完整 CNN/Conformer/RNN 架构拆解与最新评测数据。',
} as const;

export interface ModelZooRow {
  name: string;
  tier: '核心 8 模' | '轻量替代' | '方言扩展' | '前端开源';
  arch: string;
  params: string;
  weightSize: string;
  schedule: string;
  metrics: string;
}

export const FULL_MODEL_ZOO: readonly ModelZooRow[] = [
  {
    name: 'Vox2TractAlign v4 (Vox2Tract-Lite)',
    tier: '核心 8 模',
    arch: '6×Conformer-192 + 声道 BiLSTM + 声门 2×ConvNeXt1D/BiLSTM + 高频 Mel 门控 + BiGRU 7 头对齐',
    params: '9.40 M',
    weightSize: '18.15 MiB (FP16s)',
    schedule: 'v3 35k → v4 飞轮 10k（56.4 min）',
    metrics: '自然 T17 PCC 0.9108 · 宽域 G8 0.9200 · 中/英 ≤20ms 93.0%/94.9% · Mask F1 0.989 · CPU 24.3 ms',
  },
  {
    name: 'Tract2Vox-Large v2.1 (Tract2Vox-Lite)',
    tier: '核心 8 模',
    arch: '纯 CNN Glottis-NSF v4（ch=512，float64 连续相位 12 谐波 + 1/2&1/3 亚谐波 + 嘎裂脉冲 + 分级 FiLM）',
    params: '14.39 M',
    weightSize: '27.56 MiB (FP16s)',
    schedule: 'v2 13k → v2.1 飞轮 4k（43.8 min）',
    metrics: 'L24 0.8926 · L6 0.7910 · S1 闭环 L24 0.8737 · Spk 0.8879 · CPU 238.4 ms',
  },
  {
    name: 'Vox2Spk-v2.1 (Vox2Spk-Lite)',
    tier: '核心 8 模',
    arch: '纯 CNN ECAPA-TDNN（C=512, mfa=640, 3×SE-Res2Block + MFA + ASP → 512D L2 声纹）',
    params: '4.60 M',
    weightSize: '8.82 MiB (FP16s)',
    schedule: 'v2 18k → v2.1 区分度 7k（13.5 min）',
    metrics: '常规 Cos 0.9422 · 女声 Gap 0.3531 / Top1 46.2% · 165 Hz 换声 Cos 0.8013 · CPU 4.3 ms',
  },
  {
    name: 'IPA2Tract-Lite v4 (32D)',
    tier: '核心 8 模',
    arch: '121D 窄标条件 + Conv1d + 4×Conformer-192 + BiGRU-384 + 零初始化双残差 + qTA 基线',
    params: '4.23 M',
    weightSize: '8.18 MiB (FP16s)',
    schedule: 'Stage-2 v4 联合 8k（35.4 min）',
    metrics: 'Clean 降误差 43.4% / 宽域 50.7% · Dec L24 0.9035 · EMA LD 0.7013 · 零泄漏 0.0 · CPU 10.1 ms',
  },
  {
    name: 'Text2Prosody-Lite v4 (32D)',
    tier: '核心 8 模',
    arch: '32D IPA 特征 + 10D 结构 + 4 嵌入 → 4×Conformer-128 + BiGRU-128 → 时长串联停顿/F0 头',
    params: '1.98 M',
    weightSize: '3.88 MiB (FP16s)',
    schedule: 'Stage-2 v4 联合 8k / best @2.4k',
    metrics: 'ZH 22.6 ms / EN 17.3 ms / CS 22.7 ms / 任意 [IPA] 21.4 ms · F0 PCC 0.779 · CPU 1.5 ms',
  },
  {
    name: 'Tract2Area-Proxy',
    tier: '核心 8 模',
    arch: '3 层残差 MLP（17D 声道 → 6 关键区截面积 cm²，8 层 Linear）',
    params: '0.23 M',
    weightSize: '0.88 MiB (FP32)',
    schedule: '25 epochs / 300k JD2 帧',
    metrics: '6 维关键区面积 MAE 0.0478 cm² · 闭塞/穿模物理守卫 · CPU 0.4 ms',
  },
  {
    name: 'DPDFNet',
    tier: '前端开源',
    arch: '48 kHz 有状态流式复数频谱增强网络',
    params: '2.58 M',
    weightSize: '10.01 MiB (FP32)',
    schedule: '预训练开源 ONNX',
    metrics: '48 kHz 实时宽带去噪，完整保留高频擦音与爆破瞬态',
  },
  {
    name: 'SwiftF0',
    tier: '前端开源',
    arch: '超轻量单帧卷积基频与置信度估计器（0.3.0）',
    params: '0.03 M',
    weightSize: '0.13 MiB (FP32)',
    schedule: '预训练开源 ONNX',
    metrics: '46.875–2093.75 Hz 宽音域实测基频，50 Hz 严格锁相 · CPU 4.2 ms',
  },
  {
    name: 'Tract2Vox-Lite v3（可选极速档）',
    tier: '轻量替代',
    arch: '纯 CNN Glottis-NSF v4（ch=256，由 Large v2 蒸馏 12k / best @6k）',
    params: '3.73 M',
    weightSize: '7.23 MiB (FP16s)',
    schedule: '12,000 步蒸馏 / best @6k（132.4 min）',
    metrics: '50 句 Whisper ASR 中英均值 7.18%（全场最低）· 236 条金标 L6 0.7598 · CPU 152.5 ms',
  },
  {
    name: 'Vox2Align-Lite v2（可选方言槽位）',
    tier: '方言扩展',
    arch: '243D Mel+Δ+ΔΔ → 4×Conformer-192 + BiGRU-144 → 7 路对齐头',
    params: '4.33 M',
    weightSize: '8.37 MiB (FP16s)',
    schedule: '默认隐藏不装载 · 保留自训兼容',
    metrics: '支持用户针对小语种或方言自行训练并挂载，外置生效后自动接管对齐',
  },
];

export interface ModelArchLayerRow {
  name: string;
  stage: string;
  params: string;
  family: string;
  cnn: string;
  rnn: string;
  attention: string;
  linear: string;
  highlight: string;
}

export const MODEL_ARCHITECTURE_LAYERS: readonly ModelArchLayerRow[] = [
  {
    name: 'Vox2TractAlign v4',
    stage: '阶段 1 · 反演+对齐',
    params: '9.40 M',
    family: 'Conformer + BiLSTM + ConvNeXt + BiGRU',
    cnn: '35 层 Conv1d',
    rnn: '2 层 BiLSTM + 1 层 BiGRU',
    attention: '7 层 ConformerBlock（6 共享 + 1 对齐）',
    linear: '54 层',
    highlight: '单次前向同时输出 27D 轨迹与 7 路对齐，高频 Mel 旁路护航清擦音边界',
  },
  {
    name: 'Tract2Vox-Large v2.1 / Lite v3',
    stage: '阶段 3 · 神经声码器',
    params: '14.39 M / 3.73 M',
    family: 'Glottis-NSF v4 + HiFi-GAN（纯 CNN）',
    cnn: '4 层 ConvTranspose1d + 90 层 Conv1d',
    rnn: '0（无 RNN）',
    attention: '0（无 Attention）',
    linear: '4 层',
    highlight: 'float64 连续相位物理声源 + 320× 四级上采样 MRF + 音色/声门分级 FiLM',
  },
  {
    name: 'Vox2Spk-v2.1',
    stage: '独立解耦 · 声纹',
    params: '4.60 M',
    family: 'ECAPA-TDNN（纯 CNN + 统计池化）',
    cnn: '25 层 Conv1d（C=512, mfa=640）',
    rnn: '0（无 RNN）',
    attention: '0（ASP 注意力统计池化）',
    linear: '1 层',
    highlight: '3×SE-Res2Block 多尺度空洞卷积 + 关系矩阵蒸馏与非对称负对排斥',
  },
  {
    name: 'IPA2Tract-Lite v4',
    stage: '阶段 2B · 协同构音',
    params: '4.23 M',
    family: '残差 Conformer + BiGRU',
    cnn: '13 层 Conv1d',
    rnn: '1 层 BiGRU',
    attention: '4 层 ConformerBlock',
    linear: '29 层',
    highlight: '121D 窄标条件 + 零初始化双残差头 + qTA 物理基线（可调协同强度 alpha）',
  },
  {
    name: 'Text2Prosody-Lite v4',
    stage: '阶段 2A · 韵律预测',
    params: '1.98 M',
    family: 'Conformer + BiGRU',
    cnn: '12 层 Conv1d',
    rnn: '1 层 BiGRU',
    attention: '4 层 ConformerBlock',
    linear: '31 层',
    highlight: '32D IPA 特征 + 时长预测串联停顿与 3 点相对半音 F0 头，支持 LANG_IPA=3',
  },
  {
    name: 'Tract2Area-Proxy',
    stage: '物理守卫 · 截面积',
    params: '0.23 M',
    family: '残差 MLP',
    cnn: '0',
    rnn: '0',
    attention: '0',
    linear: '8 层',
    highlight: '冻结可微代理：17D 声道实时映射 6 区最小截面积，防止闭塞漏气与穿模',
  },
];

export interface ModelArchCard {
  id: string;
  name: string;
  badge: string;
  summary: string;
  blocks: Array<{ label: string; detail: string; accent?: boolean }>;
  designNote: string;
}

export const MODEL_ARCHITECTURE_CARDS: readonly ModelArchCard[] = [
  {
    id: 'arch-v4',
    name: 'Vox2TractAlign v4（联合声道反演 + 双语对齐）',
    badge: '9.40 M · Conformer + BiLSTM + BiGRU',
    summary: '共享主干单次前向输出 27 维声道声门轨迹与 7 路对齐头，免去双模型重复计算，3 s CPU 延迟 24.3 ms。',
    blocks: [
      { label: '50 Hz 前端 + 瞬态残差 Stem', detail: '163D (80 Mel + 80 Δ + 3 能量) + 3D VQ + 1D 宽域 F0，叠加 80D ΔΔ 零初始化残差 Conv1d' },
      { label: '共享主干 · 6×ConformerBlock', detail: 'dim=192, heads=4, conv_k=31, ff_mult=4（Macaron FFN + 相对位置自注意力 + 门控深度卷积）', accent: true },
      { label: '三路解耦物理分支', detail: '肺压 3 层 Conv1d → 声道 BiLSTM(192×2) 输出 T17 → 声门 2×ConvNeXt1D(k=15) + BiLSTM(128×2) 输出 G8' },
      { label: '高频 Mel 旁路 + 对齐支路', detail: '243D Mel+Δ+ΔΔ 浅层 Conv1d 与声道先验门控融合 → 1×Conformer + BiGRU(144×2) → 7 路 Linear 对齐头' },
    ],
    designNote: 'CNN 抓毫秒级爆破瞬态，Conformer 抓数百毫秒协同发音，尾部 BiLSTM/BiGRU 保帧间平滑；高频 Mel 旁路避免平滑主干削钝 /f, s, ɕ/ 边界。',
  },
  {
    id: 'arch-t2v',
    name: 'Tract2Vox-Large v2.1 / Lite v3（声门感知 NSF 声码器）',
    badge: '14.39 M / 3.73 M · 纯 CNN + 物理声源',
    summary: '全系唯一无 RNN/无 Transformer 的纯 CNN + 物理激励混合声码器，4 级反卷积 320× 上采样至 16 kHz 波形。',
    blocks: [
      { label: 'GlottisAwareSourceModule v4', detail: 'float64 连续相位积分：12 阶动态谐波 + 1/2 与 1/3 亚谐波 + 相位锁定嘎裂脉冲 + 声门缝隙高通气噪', accent: true },
      { label: '双条件编码与投影', detail: 'conv_pre(27→512/256) 拼接 512D 声纹投影；独立 glottis_enc 编码 10D 动态发声态' },
      { label: '4 级上采样 + 多感受野 MRF', detail: 'ConvTranspose1d (×8, ×5, ×4, ×2) + 90 层 Conv1d MRF (k=3/7/11, d=1/3/5)，前两级音色 FiLM、后三级声门 FiLM' },
      { label: '波形重建输出', detail: 'conv_post (k=7) + tanh 输出 16 kHz 单声道波形（密轨模式重采样至 48 kHz）' },
    ],
    designNote: '物理声源保证 20 Hz 嘎裂与 1200 Hz 超高音相位稳定不生电音；静态音色 FiLM 与逐帧声门 FiLM 分级解耦，互不干扰。',
  },
  {
    id: 'arch-spk',
    name: 'Vox2Spk-v2.1（高区分度跨音域声纹编码器）',
    badge: '4.60 M · ECAPA-TDNN 纯 CNN',
    summary: '对齐 WavLM-SV 512 维单位球面空间，引入关系矩阵蒸馏与非对称负对排斥，兼顾常规人声辨识度与女高音歌唱音色。',
    blocks: [
      { label: 'CMN 80-Mel 前端', detail: '16 kHz → 80 维 50 Hz Slaney Log-Mel，仅做均值倒谱归一化保留共振峰包络' },
      { label: '3×SE-Res2Block 多尺度主干', detail: 'C=512, k=3, dilation=2/3/4, scale=4，分组残差卷积叠加 SE 通道注意力', accent: true },
      { label: 'MFA + ASP 注意力统计池化', detail: '拼接 3 层输出聚合至 640D → 帧级注意力加权均值与标准差（1280D）' },
      { label: '单位球面声纹投影', detail: 'Linear(1280→512) + BN + L2 归一化，输出 512 维说话人嵌入' },
    ],
    designNote: '在逐样本余弦对齐外叠加 Batch 相似度矩阵 MSE 与负对超额惩罚，防止不同说话人向球面均值坍缩。',
  },
  {
    id: 'arch-ipa',
    name: 'IPA2Tract-Lite v4（32D 窄标协同构音规划）',
    badge: '4.23 M · 零初始化残差 Conformer + BiGRU',
    summary: '在三阶临界阻尼目标逼近物理基线（qTA）之上预测自然协同发音残差，配套 293 键窄标构型库。',
    blocks: [
      { label: '121 维帧级条件输入', detail: 'x_base(26) + g_masked(26) + w_mask(26) + f0(1) + 相位(5) + 阻塞(4) + 32D IPA 特征 + has_phon(1)' },
      { label: '局部卷积 + 4×Conformer + BiGRU', detail: 'Linear(121→192) + Conv1d(k=5) → 4×Conformer(dim=192, k=15) → BiGRU(192×2)', accent: true },
      { label: '零初始化双残差头', detail: '声道头(17D) 与声源头(9D) 末层全零初始化；常规限幅 ±0.85，下颌 JA 限幅 ±0.35' },
      { label: '物理合成输出与面积护栏', detail: 'x_hat = clamp(x_base + alpha · delta, -1, 1)；训练期挂冻结 Tract2Area-Proxy(0.23M) 监控 6 区截面积' },
    ],
    designNote: '未约束器官通道严格置零保证零上下文泄漏（max_abs_diff = 0.0）；alpha 可直接作为字正腔圆与流利协同的连续滑块。',
  },
  {
    id: 'arch-pros',
    name: 'Text2Prosody-Lite v4（多语与任意 IPA 韵律模型）',
    badge: '1.98 M · Conformer + BiGRU',
    summary: '无 LLM 依赖，CPU 1.5 ms/句统一预测普通话、英语、中英混排与任意无标调 [IPA] 的时长、停顿与相对半音基频。',
    blocks: [
      { label: '音素级多模态输入', detail: '32D 通用 IPA 特征 + 10D 韵律结构位置 + 4 离散嵌入（语种含 LANG_IPA=3 / 声调重音 / 标点 / 角色）' },
      { label: '4×Conformer + 残差 BiGRU', detail: 'Linear(106→128) → 4×Conformer(dim=128, heads=4, k=7) → BiGRU(64×2) + 残差', accent: true },
      { label: 'Head 1 · 音素时长预测', detail: '2 层 Linear(128→64→1) 输出相对 80 ms 的对数时长 log_dur' },
      { label: '时长条件串联 Head 2 & Head 3', detail: '拼接预测时长(129D) → 停顿门控/时长头 + 3 点相对半音 [起,中,尾] 与浊音概率头' },
    ],
    designNote: '将预测时长作为条件喂给 F0 与停顿头，让音高曲线随音节长短自然展开；输出相对半音解耦男女高音，可锚定任意参考音色中位基频。',
  },
];

export interface M27ParamSpec {
  idx: number;
  code: string;
  group: '声道 17 维' | '基频与肺压' | '声门 8 维';
  min: string;
  max: string;
  unit: string;
  norm: string;
  meaning: string;
}

export const M27_PARAMETER_SPECS: readonly M27ParamSpec[] = [
  { idx: 0, code: 'HX', group: '声道 17 维', min: '0.0', max: '1.0', unit: '归一化', norm: '线性 [-1,1]', meaning: '舌骨水平位置' },
  { idx: 1, code: 'HY', group: '声道 17 维', min: '-6.0', max: '-3.5', unit: 'cm', norm: '线性 [-1,1]', meaning: '舌骨/喉头垂直高度' },
  { idx: 2, code: 'JX', group: '声道 17 维', min: '-0.5', max: '0.0', unit: 'cm', norm: '线性 [-1,1]', meaning: '下颌前伸位移' },
  { idx: 3, code: 'JA', group: '声道 17 维', min: '-7.0', max: '0.0', unit: '度', norm: '线性 [-1,1]', meaning: '下颌开口角度（负值为张口）' },
  { idx: 4, code: 'LP', group: '声道 17 维', min: '-1.0', max: '1.0', unit: '相对值', norm: '线性 [-1,1]', meaning: '唇突度/圆唇（-1 展唇，+1 圆唇）' },
  { idx: 5, code: 'LD', group: '声道 17 维', min: '-2.0', max: '4.0', unit: 'cm', norm: '线性 [-1,1]', meaning: '上下唇垂直间距（负值为双唇紧闭成阻）' },
  { idx: 6, code: 'VS', group: '声道 17 维', min: '0.0', max: '1.0', unit: '相对值', norm: '线性 [-1,1]', meaning: '软腭/悬雍垂轮廓形态' },
  { idx: 7, code: 'VO', group: '声道 17 维', min: '-0.1', max: '1.5', unit: 'cm²', norm: '线性 [-1,1]', meaning: '鼻咽门开度（> 0 产生鼻音与鼻化耦合）' },
  { idx: 8, code: 'TCX', group: '声道 17 维', min: '-3.0', max: '4.0', unit: 'cm', norm: '线性 [-1,1]', meaning: '舌体中心前后坐标（前元音正，后元音负）' },
  { idx: 9, code: 'TCY', group: '声道 17 维', min: '-3.0', max: '1.0', unit: 'cm', norm: '线性 [-1,1]', meaning: '舌体中心高低坐标（高元音正，低元音负）' },
  { idx: 10, code: 'TTX', group: '声道 17 维', min: '1.5', max: '7.5', unit: 'cm', norm: '线性 [-1,1]', meaning: '舌尖前后坐标（齿龈/卷舌成阻位置）' },
  { idx: 11, code: 'TTY', group: '声道 17 维', min: '-3.0', max: '2.5', unit: 'cm', norm: '线性 [-1,1]', meaning: '舌尖高低坐标' },
  { idx: 12, code: 'TBX', group: '声道 17 维', min: '-3.0', max: '6.5', unit: 'cm', norm: '线性 [-1,1]', meaning: '舌叶（Tongue Blade）前后坐标' },
  { idx: 13, code: 'TBY', group: '声道 17 维', min: '-3.0', max: '5.0', unit: 'cm', norm: '线性 [-1,1]', meaning: '舌叶高低坐标' },
  { idx: 14, code: 'TS1', group: '声道 17 维', min: '0.0', max: '1.0', unit: '相对值', norm: '线性 [-1,1]', meaning: '舌侧缘高度 1（控制边音与中央气流通道）' },
  { idx: 15, code: 'TS2', group: '声道 17 维', min: '0.0', max: '1.0', unit: '相对值', norm: '线性 [-1,1]', meaning: '舌侧缘高度 2' },
  { idx: 16, code: 'TS3', group: '声道 17 维', min: '-1.0', max: '1.0', unit: '相对值', norm: '线性 [-1,1]', meaning: '舌侧缘高度 3' },
  { idx: 17, code: 'F0', group: '基频与肺压', min: '20', max: '1200+', unit: 'Hz', norm: '对数 ln(F0) 仿射（40/600 锚点平滑外延）', meaning: '声带振动基频（神经链路支持 20 Hz 嘎裂至 1200 Hz 超高音；VTL 物理声门保留 40–600 Hz）' },
  { idx: 18, code: 'PR', group: '基频与肺压', min: '0.0', max: '1600.0', unit: 'Pa', norm: '线性 [-1,1]', meaning: '声门下肺压（UI 统一用 Pa，原生 VTL 边界换算 0–16000 dPa）' },
  { idx: 19, code: 'XB', group: '声门 8 维', min: '-0.05', max: '0.30', unit: 'cm', norm: '线性 [-1,1]', meaning: '声带下缘静止位移（紧嗓负值，气声正值）' },
  { idx: 20, code: 'XT', group: '声门 8 维', min: '-0.05', max: '0.30', unit: 'cm', norm: '线性 [-1,1]', meaning: '声带上缘静止位移（控制声门聚合/发散角）' },
  { idx: 21, code: 'CA', group: '声门 8 维', min: '-0.25', max: '0.25', unit: 'cm²', norm: '线性 [-1,1]', meaning: '后软骨部裂隙面积（气声漏气与耳语主导参数）' },
  { idx: 22, code: 'LAG', group: '声门 8 维', min: '0.0', max: '3.1415', unit: 'rad', norm: '线性 [-1,1]', meaning: '上下缘黏膜波相位滞后（假声偏小，紧嗓/嘎裂偏大）' },
  { idx: 23, code: 'RA', group: '声门 8 维', min: '-1.0', max: '1.0', unit: '相对值', norm: '线性 [-1,1]', meaning: '相对声带振幅（≤ 0 对应清音/耳语无周期湍流）' },
  { idx: 24, code: 'PS', group: '声门 8 维', min: '-1.0', max: '1.0', unit: '相对值', norm: '线性 [-1,1]', meaning: '声门脉冲形状与开商特征（气声偏负，挤压偏正）' },
  { idx: 25, code: 'FL', group: '声门 8 维', min: '0.0', max: '100.0', unit: '%', norm: '线性 [-1,1]', meaning: '基频周期性抖动/微颤幅度（Flutter / Jitter）' },
  { idx: 26, code: 'SHIM', group: '声门 8 维', min: '0.0', max: '100.0', unit: '%', norm: '线性 [-1,1]', meaning: '周期振幅微扰（Shimmer，嘎裂声可达 50–100）' },
];

export interface Ipa32FeatureSpec {
  idx: number;
  key: string;
  group: '基础类别 (3)' | '构音部位 (10)' | '构音方式 (8)' | '嗓音与元音 (5)' | '窄标扩展 (6)';
  range: string;
  examples: string;
  meaning: string;
}

/** Exact 32-dim PanPhon-enhanced IPA feature vector (`PHON_FEAT_NAMES_32` in `kf_ipa_synth/phonetics.py`). */
export const IPA32_FEATURE_SPECS: readonly Ipa32FeatureSpec[] = [
  { idx: 0, key: 'is_sil', group: '基础类别 (3)', range: '0 / 1', examples: 'sil, pau', meaning: '静音或停顿边界标记' },
  { idx: 1, key: 'is_vowel', group: '基础类别 (3)', range: '0..1', examples: '[i, a, u, ə, ɿ]', meaning: '元音与成音节响音核标记' },
  { idx: 2, key: 'is_consonant', group: '基础类别 (3)', range: '0 / 1', examples: '[p, s, m, l, ɹ]', meaning: '辅音音段标记' },
  { idx: 3, key: 'place_labial', group: '构音部位 (10)', range: '0..1', examples: '[p, b, m, f, w]', meaning: '双唇与唇齿等唇部构音' },
  { idx: 4, key: 'place_labiodent', group: '构音部位 (10)', range: '0 / 1', examples: '[f, v, ɱ, ʋ]', meaning: '下唇贴上齿的唇齿构音' },
  { idx: 5, key: 'place_coronal', group: '构音部位 (10)', range: '0..1', examples: '[t, s, n, l, ʃ]', meaning: '齿、齿龈、龈后与卷舌舌冠区' },
  { idx: 6, key: 'place_retroflex', group: '构音部位 (10)', range: '0..1', examples: '[ʈ, ʂ, ʐ, ɻ, ɚ]', meaning: '卷舌与龈后儿化舌尖后卷程度' },
  { idx: 7, key: 'place_palatal', group: '构音部位 (10)', range: '0..1', examples: '[tɕ, ɕ, c, ɲ, j]', meaning: '龈腭与硬腭舌面抬升部位' },
  { idx: 8, key: 'place_velar', group: '构音部位 (10)', range: '0..1', examples: '[k, ɡ, ŋ, x, ɫ]', meaning: '软腭与软腭化次要构音部位' },
  { idx: 9, key: 'place_glottal', group: '构音部位 (10)', range: '0..1', examples: '[ʔ, h, ɦ]', meaning: '声门与喉部构音部位' },
  { idx: 10, key: 'manner_stop', group: '构音方式 (8)', range: '0..1', examples: '[p, t, k, ʔ] (塞擦 0.5)', meaning: '完全闭塞的塞音方式' },
  { idx: 11, key: 'manner_fric', group: '构音方式 (8)', range: '0..1', examples: '[f, s, ʃ, x, ɬ]', meaning: '窄缝湍流擦音方式' },
  { idx: 12, key: 'manner_affric', group: '构音方式 (8)', range: '0 / 1', examples: '[ts, tʃ, tʂ, tɕ]', meaning: '闭塞接续同部位摩擦的塞擦音' },
  { idx: 13, key: 'manner_nasal', group: '构音方式 (8)', range: '0..1', examples: '[m, n, ŋ, ã]', meaning: '鼻音与鼻化元音（腭咽通道开启）' },
  { idx: 14, key: 'manner_lateral', group: '构音方式 (8)', range: '0 / 1', examples: '[l, ɫ, ɭ, ʎ, ɬ]', meaning: '舌侧气流通道（边音与边擦音）' },
  { idx: 15, key: 'manner_approx', group: '构音方式 (8)', range: '0..1', examples: '[ɹ, j, w, ʋ, ɰ]', meaning: '无湍流近音与半元音' },
  { idx: 16, key: 'manner_tap_trill', group: '构音方式 (8)', range: '0 / 1', examples: '[ɾ, ɽ, r, ʙ, ʀ]', meaning: '闪音、拍音与颤音周期拍击' },
  { idx: 17, key: 'voiced', group: '嗓音与元音 (5)', range: '0 / 1', examples: '[b, z, m, a] vs [p, s]', meaning: '声带清浊状态（支持清化 ◌̥ / 浊化 ◌̬ 修饰）' },
  { idx: 18, key: 'aspirated', group: '嗓音与元音 (5)', range: '0 / 1', examples: '[pʰ, tʰ, kʰ, t͡ʃʰ]', meaning: '送气特征（驱动长 VOT 释放段）' },
  { idx: 19, key: 'rounded', group: '嗓音与元音 (5)', range: '0..1', examples: '[u, o, y, ɔ, tʷ]', meaning: '圆唇度与唇化附加修饰' },
  { idx: 20, key: 'vowel_height', group: '嗓音与元音 (5)', range: '0..1', examples: '低 [a]=0 · 中 [ə]=0.5 · 高 [i/u]=1', meaning: '元音舌位高低连续坐标（响应 ◌̝/◌̞）' },
  { idx: 21, key: 'vowel_backness', group: '嗓音与元音 (5)', range: '0..1', examples: '前 [i/a]=0 · 央 [ə]=0.5 · 后 [u/ɑ]=1', meaning: '元音舌位前后连续坐标（响应 ◌̟/◌̠）' },
  { idx: 22, key: 'place_dental', group: '构音部位 (10)', range: '0 / 1', examples: '[θ, ð, t̪, d̪, n̪]', meaning: '新增窄标维：区分齿音与齿龈音' },
  { idx: 23, key: 'manner_sibilant', group: '构音方式 (8)', range: '0 / 1', examples: '[s, z, ʃ, ʂ, ɕ, ts]', meaning: '新增窄标维：区分有咝高频擦音与非咝擦音 [θ/f/ç]' },
  { idx: 24, key: 'place_uvular', group: '构音部位 (10)', range: '0 / 1', examples: '[q, ɢ, ɴ, ʀ, χ, ʁ]', meaning: '新增窄标维：将小舌音与软腭音解耦' },
  { idx: 25, key: 'place_pharyngeal', group: '构音部位 (10)', range: '0 / 1', examples: '[ħ, ʕ, ʜ, ʢ, ʡ, tˤ]', meaning: '新增窄标维：咽音、会厌音与咽化附加修饰' },
  { idx: 26, key: 'is_syllabic', group: '窄标扩展 (6)', range: '0 / 1', examples: '[n̩, l̩, m̩, ŋ̩, ɿ, ʅ]', meaning: '成音节辅音与舌尖元音标记' },
  { idx: 27, key: 'is_unreleased', group: '窄标扩展 (6)', range: '0 / 1', examples: '[p̚, t̚, k̚]', meaning: '唯闭音 / 入声塞音无除阻释放标记' },
  { idx: 28, key: 'phonation_breathy', group: '窄标扩展 (6)', range: '0..1', examples: '[ɦ, a̤, b̤]', meaning: '音段级气声发声态修饰' },
  { idx: 29, key: 'phonation_creaky', group: '窄标扩展 (6)', range: '0 / 1', examples: '[ʔ, ʡ, a̰]', meaning: '音段级嘎裂声 / 喉塞修饰' },
  { idx: 30, key: 'airstream_glottalic', group: '窄标扩展 (6)', range: '-1 / 0 / +1', examples: '内爆 [ɓ, ɗ, ɠ]=-1 · 喷音 [pʼ, tʼ]=+1', meaning: '声门气流机制（负值内爆，正值喷音）' },
  { idx: 31, key: 'airstream_velaric', group: '窄标扩展 (6)', range: '0 / 1', examples: '[ʘ, ǀ, ǃ, ǂ, ǁ]', meaning: '软腭吸气音（搭嘴音）气流机制' },
];

export interface CorpusRow {
  name: string;
  category: '本地物理合成' | '公开朗读/方言' | '授权朗读语料' | '公开情感/表现' | '公开干声歌唱' | '真人传感盲测' | '派生任务缓存';
  scale: string;
  durationOrSpk: string;
  usedBy: string;
  notes: string;
}

export const FULL_CORPUS_INVENTORY: readonly CorpusRow[] = [
  {
    name: 'states_jd2_r21.npz',
    category: '本地物理合成',
    scale: '459 个声道构形（435 kB）',
    durationOrSpk: '元音 131 · 闭塞 124 · 擦音 130 · 边音 67 · 近音 7',
    usedBy: '全部物理合成生成脚本',
    notes: '多轮凸包剥离与 JD2 原型合并构建，可完全本地复现',
  },
  {
    name: 'synth_full_glottis_180h',
    category: '本地物理合成',
    scale: '170,550 条（3,411 分片，20.94 GB）',
    durationOrSpk: '179.89 小时（VTL JD2 200Hz/48kHz）',
    usedBy: 'Vox2TractAlign v4 / Tract2Vox / IPA2Tract v4',
    notes: '覆盖 7 种单发声态（70.2%）与 50,756 条句内多态渐变（29.8%）',
  },
  {
    name: 'synth_wide_f0_16h（Batch-2 新增）',
    category: '本地物理合成',
    scale: '120 分片（719 MB，含 5,610 条 5.13 h 增量）',
    durationOrSpk: '20–1200 Hz 宽音域物理传递函数增广',
    usedBy: 'Vox2TractAlign v4 / IPA2Tract v4 / Tract2Vox v2/v3',
    notes: '补齐 20–45 Hz 深嘎裂与 550–1200 Hz 超高音的精确物理轨迹锚定',
  },
  {
    name: 'tube_proxy_samples.npz',
    category: '本地物理合成',
    scale: '300,000 帧（22.39 MB）',
    durationOrSpk: '65% 轨迹抖动 + 20% 状态扰动 + 15% 全盒采样',
    usedBy: 'Tract2Area-Proxy',
    notes: '调用 VTL 2.4 (R21) 直接获取 6 个声道关键区精确最小截面积真值',
  },
  {
    name: 'AISHELL-3（普通话多人）',
    category: '公开朗读/方言',
    scale: '训 74,328 条 / 测 13,707 条',
    durationOrSpk: '训 174 人 / 测 44 人（说话人严格隔离）',
    usedBy: '全链反演 / 声码器 / 声纹 / 韵律 / 动腔',
    notes: '零解压流式读取；MFA 过滤对齐 17,534 条并升级窄标映射',
  },
  {
    name: 'LibriSpeech（clean-100 / dev-clean）',
    category: '公开朗读/方言',
    scale: '多人索引 + 百小时级流式全集',
    durationOrSpk: '训 251 人 / 测 40 人（英语朗读）',
    usedBy: '全链反演 / 声码器 / 声纹 / 韵律 / 对齐',
    notes: '高质量英语朗读语料，同时用于 50 句离线 Whisper WER 门禁评测',
  },
  {
    name: 'TIMIT（英语人工金标）',
    category: '授权朗读语料',
    scale: '6,300 条（训 4,620 / 测 1,680）',
    durationOrSpk: '人工音素边界 + *cl 塞音闭塞段',
    usedBy: 'IPA2Tract v4 / Text2Prosody v4 / 联合对齐',
    notes: 'Batch-2 自动升格为窄标（送气 10,238、唯闭 10,087、暗 [ɫ] 2,984、鼻化元音 4,655）',
  },
  {
    name: 'ESD + Expresso（情感与表现性朗读）',
    category: '公开情感/表现',
    scale: '46,615 条（ESD 35,000 + Expresso 11,615）',
    durationOrSpk: '40.00 小时（多情绪 / 耳语 / 气声 / 强调）',
    usedBy: '全链反演 / 声码器 / 韵律 / 动腔',
    notes: '增强大动态基频起伏、耳语、气声与自然会话语调',
  },
  {
    name: 'EmotionTalk + CSEMOTIONS（Batch-2 新增）',
    category: '公开情感/表现',
    scale: '25,224 条（EmotionTalk 19,080 + CSEMOTIONS 6,144）',
    durationOrSpk: '32.52 小时（中文多情感对话与单人配音）',
    usedBy: 'Tract2Vox Large v2.1 / Lite v3 / Vox2Spk-v2.1',
    notes: '大幅扩充中文高表现力情绪语音（声纹训练严格隔离单人洁净集 CSEMOTIONS）',
  },
  {
    name: 'EmoV-DB + RAVDESS（Batch-2 新增）',
    category: '公开情感/表现',
    scale: '9,175 条（EmoV-DB 6,993 + RAVDESS 2,182）',
    durationOrSpk: '10.56 小时（英语情感朗读与情感歌唱）',
    usedBy: 'Tract2Vox Large v2.1 / Lite v3 / Vox2Spk-v2.1',
    notes: '补充强情绪爆发、困倦气声、怒吼紧嗓与情感演唱音色',
  },
  {
    name: 'GTSinger + M4Singer + OpenCpop + VocalSet',
    category: '公开干声歌唱',
    scale: '44,390 条（17,080 + 23,697 + 3,613）',
    durationOrSpk: '79.60 小时（中英干声歌唱与声乐发声技巧）',
    usedBy: '全链反演 / 声码器 / Vox2Spk-v2.1 / IPA2Tract v4',
    notes: '覆盖真假声、咽音、颤音、气声与 23 位纯净女高音/女中音独唱音色',
  },
  {
    name: 'JACRC 京剧独唱声乐库（Batch-2 新增）',
    category: '公开干声歌唱',
    scale: '7,604 条（Part 1–3 合计）',
    durationOrSpk: '10.45 小时（高音戏剧独唱干声）',
    usedBy: 'Tract2Vox Large v2.1 / Lite v3 / Vox2Spk-v2.1',
    notes: '强化高音区共鸣、假声与极高基频的音质透明度与声纹稳定性',
  },
  {
    name: 'EMVD / AVP / Beatbox / 呼麦与喉声库（Batch-2 新增）',
    category: '公开干声歌唱',
    scale: '3,053 条（EMVD 1,600 · AVP/Beatbox 1,216 · 呼麦/嘎裂/泛音 237）',
    durationOrSpk: '4.21 小时（图瓦呼麦 / 次谐波嘎裂 / 泛音 / B-box）',
    usedBy: 'Tract2Vox Large v2.1 / Lite v3',
    notes: '专项覆盖 1/2 与 1/3 亚谐波室带双音、深嘎裂颗粒与非言语气流瞬态',
  },
  {
    name: 'USC-TIMIT EMA（真人电磁发音仪）',
    category: '真人传感盲测',
    scale: '276 条（20 份独立文件，0 条进训练）',
    durationOrSpk: '同步真人唇/舌/颌传感器坐标',
    usedBy: 'IPA2Tract-Lite v4 客观构音检验',
    notes: '零训练泄漏盲测：验证预测舌唇轨迹与真实人类发音器官运动一致性',
  },
  {
    name: '236 条金标准 IPA / VoQS 实录集（Batch-2 新增）',
    category: '真人传感盲测',
    scale: '236 条（覆盖爆发音/鼻音/颤音/擦音/边音/元音/VoQS）',
    durationOrSpk: '高保真实验室实录（用于独立评测与构型标定）',
    usedBy: 'Tract2Vox 盲测门禁 / 窄标构型库校验',
    notes: '全面检验各类国际音标辅元音与非模态发声态的声学保真度',
  },
  {
    name: 'distill_m27_v1（共享教师蒸馏缓存）',
    category: '派生任务缓存',
    scale: '60,010 条（120 分片，7.48 GB）',
    durationOrSpk: '63.61 小时（495 人训 / 84 未见人测）',
    usedBy: 'Vox2TractAlign v4 / Vox2Spk-v2.1 / Tract2Vox',
    notes: '全量预载主机内存实现 100% RAM 命中，严格隔离 84 位未见验证说话人',
  },
  {
    name: 'kf_dataset_narrow_v2（Batch-2 窄标联合库）',
    category: '派生任务缓存',
    scale: '协同构音 63,154 条 · 双语/IPA 韵律 52,340 条',
    durationOrSpk: '配套 canonical_ipa_poses_narrow.json（293 键 / 66 闭塞相）',
    usedBy: 'IPA2Tract-Lite v4 (32D) / Text2Prosody-Lite v4 (32D)',
    notes: '融合窄标 TIMIT、AISHELL-3 MFA、213 条参考 IPA 与歌唱数据，支撑 32D 升级',
  },
  {
    name: 'flywheel_large_v2_12k（Batch-2 神经飞轮缓存）',
    category: '派生任务缓存',
    scale: '12,000 条（24 分片，993 MB）',
    durationOrSpk: '8.33 小时（180h 7,178 + 宽域 3,004 + 换声 1,818）',
    usedBy: 'Vox2TractAlign v4 / Tract2Vox-Large v2.1',
    notes: '以 Tract2Vox-Large v2 反向生成高保真闭环语料，消除真实语音与声道瓶颈分布差',
  },
];

export const SYNTH_180H_MODES: readonly { name: string; count: number; group: string }[] = [
  { name: '句内多态渐变 (Morph)', count: 50756, group: '动态过渡' },
  { name: '常态浊声 (Modal)', count: 32048, group: '单发声态' },
  { name: '假声 (Falsetto)', count: 20672, group: '单发声态' },
  { name: '嘎裂声 (Creaky)', count: 19645, group: '单发声态' },
  { name: '气声 (Breathy)', count: 19569, group: '单发声态' },
  { name: '紧嗓 (Pressed)', count: 15981, group: '单发声态' },
  { name: '耳语 (Whisper)', count: 6153, group: '单发声态' },
  { name: '全域探索 (Explore)', count: 5726, group: '单发声态' },
];

/** Verified Batch-2 final metrics & evaluation data (from F:/TensorTract3_Train/runs/). */
export const TRAINING_CURVES = {
  /** Vox2TractAlign v4 (9.40M) 25-dim per-parameter PCC on unseen natural val */
  v4PerDimPcc: [
    { dim: 'RA', val: 0.9691, group: '声门' },
    { dim: 'TCX', val: 0.9656, group: '声道' },
    { dim: 'LD', val: 0.9557, group: '声道' },
    { dim: 'VO', val: 0.9499, group: '声道' },
    { dim: 'TTX', val: 0.9483, group: '声道' },
    { dim: 'TBX', val: 0.9405, group: '声道' },
    { dim: 'TCY', val: 0.9399, group: '声道' },
    { dim: 'LP', val: 0.9386, group: '声道' },
    { dim: 'JA', val: 0.9354, group: '声道' },
    { dim: 'TBY', val: 0.9349, group: '声道' },
    { dim: 'TS3', val: 0.9344, group: '声道' },
    { dim: 'TTY', val: 0.9223, group: '声道' },
    { dim: 'HX', val: 0.9176, group: '声道' },
    { dim: 'CA', val: 0.9137, group: '声门' },
    { dim: 'HY', val: 0.9085, group: '声道' },
    { dim: 'XB', val: 0.9013, group: '声门' },
    { dim: 'TS1', val: 0.8655, group: '声道' },
    { dim: 'TS2', val: 0.8576, group: '声道' },
    { dim: 'LAG', val: 0.8164, group: '声门' },
    { dim: 'XT', val: 0.7991, group: '声门' },
    { dim: 'PS', val: 0.7967, group: '声门' },
    { dim: 'VS', val: 0.7903, group: '声道' },
    { dim: 'JX', val: 0.7790, group: '声道' },
    { dim: 'FL', val: 0.7775, group: '声门' },
    { dim: 'SHIM', val: 0.7406, group: '声门' },
  ],

  /** 50-sentence offline Whisper Large-v3-Turbo bilingual ASR intelligibility gate (25 ZH + 25 EN) */
  whisperAsrGate: [
    { name: '旧基线 Lite v1 (3.7M)', zhCer: 14.95, enWer: 4.20, meanErr: 9.58, l24: 0.8577, spk: 0.9063 },
    { name: '旧基线 Large v1 (14.4M)', zhCer: 13.52, enWer: 2.88, meanErr: 8.20, l24: 0.8732, spk: 0.9143 },
    { name: 'Batch-2 Large v2.1 (14.4M)', zhCer: 11.03, enWer: 5.75, meanErr: 8.39, l24: 0.8829, spk: 0.9171 },
    { name: 'Batch-2 Lite v2 (3.7M)', zhCer: 11.74, enWer: 3.76, meanErr: 7.75, l24: 0.8639, spk: 0.9083 },
    { name: 'Batch-2 Large v2 (14.4M)', zhCer: 9.96, enWer: 4.65, meanErr: 7.31, l24: 0.8815, spk: 0.9179 },
    { name: 'Batch-2 Lite v3 (3.7M 6k)', zhCer: 11.03, enWer: 3.32, meanErr: 7.18, l24: 0.8708, spk: 0.9126 },
  ],

  /** Text2Prosody-Lite v4 (32D) 5-domain accuracy including arbitrary [IPA] */
  prosodyV4Domains: [
    { domain: '普通话朗读 (ZH)', durMaeMs: 22.55, f0MaeSt: 1.185, f0Pcc: 0.7786 },
    { domain: '英语朗读 (EN)', durMaeMs: 17.33, f0MaeSt: 1.210, f0Pcc: 0.6728 },
    { domain: '中英混排 (CS)', durMaeMs: 22.70, f0MaeSt: 1.600, f0Pcc: 0.6202 },
    { domain: '任意国际音标 (IPA)', durMaeMs: 21.44, f0MaeSt: 1.651, f0Pcc: 0.5883 },
    { domain: '孤立单字 (ISO)', durMaeMs: 45.06, f0MaeSt: 1.177, f0Pcc: 0.5600 },
  ],

  /** IPA2Tract-Lite v4 (32D) USC-TIMIT human EMA 7-articulator blind test */
  emaRadarV4: [
    { axis: '唇开口 LD', pcc: 0.7013 },
    { axis: '舌尖前后 TTX', pcc: 0.6674 },
    { axis: '舌体高低 TCY', pcc: 0.5865 },
    { axis: '舌尖高低 TTY', pcc: 0.5025 },
    { axis: '舌体前后 TCX', pcc: 0.3577 },
    { axis: '下颌开口 JA', pcc: 0.3554 },
    { axis: '唇突度 LP', pcc: 0.3214 },
  ],

  /** Vox2Spk-v2.1 vs v2 vs v1 vs WavLM-SV teacher comparison */
  vox2spkCompare: [
    { name: '旧版 v1 (2.9M)', spCos: 0.9172, femGap: 0.2614, femTop1: 0.2573, tts165Cos: 0.7978, ttsMargin: 0.0503 },
    { name: 'Batch-2 v2 (4.6M)', spCos: 0.9423, femGap: 0.2965, femTop1: 0.4444, tts165Cos: 0.7925, ttsMargin: 0.0589 },
    { name: 'Batch-2 v2.1 (4.6M)', spCos: 0.9422, femGap: 0.3531, femTop1: 0.4620, tts165Cos: 0.8013, ttsMargin: 0.0649 },
    { name: 'WavLM-SV 教师', spCos: 1.0000, femGap: 0.2433, femTop1: 0.5000, tts165Cos: 0.8020, ttsMargin: 0.0722 },
  ],
} as const;

export interface OnnxSlotContractRow {
  name: string;
  slug: string;
  inputs: string;
  outputs: string;
  patterns: string;
  fallback: string;
  optionalNote?: string;
}

export const ONNX_SLOT_CONTRACTS: readonly OnnxSlotContractRow[] = [
  {
    name: 'Vox2Tract-Lite',
    slug: 'vox2tract_lite',
    inputs: 'mel_feats (B,T,163) + vq_cues (B,T,3) + f0_norm (B,T) float32',
    outputs: 'tract17 (B,T,17), pr1 (B,T,1), glot8 (B,T,8), h_backbone (B,T,192) [+ 联合版 7 路对齐头]',
    patterns: 'vox2tract / inverter / m27_invert',
    fallback: '卸载后声道重建接口返回 503 model_unloaded',
  },
  {
    name: 'Tract2Vox-Lite',
    slug: 'tract2vox_lite',
    inputs: 'm27_norm (B,T,27) + spk_seq (B,T,512) + env_rand (B,2,T_up) + n_wb (B,1,320*T) float32',
    outputs: 'wav_16k (B,320*T) float32（16 kHz 波形，密轨路径重采样至 48 kHz）',
    patterns: 'tract2vox / vocoder / hifigan',
    fallback: '卸载后仅保留 VTL 2.4 物理管段合成',
  },
  {
    name: 'Vox2Spk-Lite',
    slug: 'vox2spk_lite',
    inputs: 'log_mel (B,80,T) float32（逐句均值倒谱归一化 CMN）',
    outputs: 'spk_emb (B,512) float32（L2 归一化说话人嵌入）',
    patterns: 'vox2spk / spk_enc / speaker',
    fallback: '卸载后仅可使用内置 .spk.json 声纹档案',
  },
  {
    name: 'IPA2Tract-Lite',
    slug: 'ipa2tract_lite',
    inputs: 'cond (B,T,121 或 111) + x_base (B,T,26) + alpha (1,) float32',
    outputs: 'x_hat (B,T,26) float32（输出裁剪至 [-1, 1]）',
    patterns: 'ipa2tract / kf2tract / keyframe_tract',
    fallback: '卸载后协同构音自动退回异步 3 阶 qTA 物理基线',
  },
  {
    name: 'DPDFNet',
    slug: 'dpdfnet',
    inputs: 'spec (1,1,481,2) float32 + state_in (56436,) float32',
    outputs: 'spec_e (1,1,481,2) float32 + state_out (56436,) float32',
    patterns: 'dpdfnet / denoise',
    fallback: '卸载后跳过实录前端宽带降噪',
  },
  {
    name: 'Text2Prosody-Lite',
    slug: 'text2prosody_lite',
    inputs: 'phon_feat (B,L,32 或 22) + pos_struct (B,L,10) float32 + lang_id, tone_stress_id, punct_id, role_id (B,L) int64',
    outputs: 'log_dur (B,L), f0_st3 (B,L,3), voiced_logit (B,L), pause_logit (B,L), log_pause_dur (B,L)',
    patterns: 'text2prosody / prosody',
    fallback: '卸载后文本编译自动切换至规则时长与韵律',
  },
  {
    name: 'Tract2Area-Proxy',
    slug: 'tract2area_proxy',
    inputs: 'tract17_norm (B,T,17) float32',
    outputs: 'area_cm2 (B,T,6) float32（min_oral / labial / coronal / dorsal / pharynx / nasal_port）',
    patterns: 'tract2area / tube_proxy / area_proxy',
    fallback: '卸载后跳过局部收窄面积代理校验',
  },
  {
    name: 'SwiftF0',
    slug: 'swiftf0',
    inputs: 'audio (1,L) float32 + fmin scalar float32 + fmax scalar float32',
    outputs: 'pitch (1,T) float64/float32 + confidence (1,T) float32',
    patterns: 'swift-f0 / swift_f0 / swiftf0',
    fallback: '卸载后反演与方言提取无法自动测 F0',
  },
  {
    name: 'Vox2Align-Lite v2',
    slug: 'vox2align_lite_v2',
    inputs: 'mel_feats (B,T,163) + h_backbone (B,T,192) + m27_norm (B,T,27) float32',
    outputs: 'zh_syl_ctc_logits (B,T,415), phone_frame_logits (B,T,65), phone_ctc_logits (B,T,65), boundary_logits (B,T,2), speech_mask_logit (B,T), tone_logits (B,T,8), lang_logits (B,T,3)',
    patterns: 'vox2align / align_v2 / aligner',
    fallback: '默认隐藏不装载（由联合 Vox2Tract-Lite 内置对齐）；用户自训外置挂载后自动接管对齐',
    optionalNote: '可选方言/多语种自训兼容槽位',
  },
];

export interface RetrainingRecipe {
  id: string;
  scenario: string;
  difficulty: '推荐入门 · 小时级' | '进阶扩展 · 半天级';
  targetModels: string;
  corpusReq: string;
  steps: string[];
  commands: string;
}

export const RETRAINING_RECIPES: readonly RetrainingRecipe[] = [
  {
    id: 'rec-dialect-align',
    scenario: '场景 A · 针对其他语言或方言自行训练独立对齐与韵律模型',
    difficulty: '推荐入门 · 小时级',
    targetModels: 'Vox2Align-Lite v2 (4.33M 可选兼容槽位) + Text2Prosody-Lite v4 (1.98M)',
    corpusReq: '16 kHz 单声道 WAV + 对应 Praat TextGrid（3–20 小时），单卡 8–16 GB VRAM 即可微调。',
    steps: [
      '将目标方言或语种的音素映射到 32 维通用 IPA 特征（韵律）及对齐词表，并用 SwiftF0 提取 50 Hz 基频。',
      '以现有权重热启动微调并导出动态轴 ONNX（保持契约维度与张量名一致）。',
      '在设置页「本地轻量化模型矩阵」底部展开「独立对齐槽位 (Vox2Align-Lite v2)」并点击「换模」，外置权重生效后将自动优先接管该语种的对齐与静音门控。',
    ],
    commands: `# 1. 准备目标语种/方言对齐与 32D 韵律索引
python -B scripts/prepare_vox2align_v2_dataset.py
python -B scripts/train_stage2_prosody_ipa_joint.py --steps 8000 --resume

# 2. 若需独立方言对齐小模型（兼容 Vox2Align-Lite v2 槽位）
python -B scripts/train_vox2align_v2.py --steps 12000 --batch-size 48 --resume
python -B scripts/export_onnx_models.py --mode finalize`,
  },
  {
    id: 'rec-batch2-retrain',
    scenario: '场景 B · 扩展更多歌唱/发声态语料精调声纹与神经声码器',
    difficulty: '进阶扩展 · 半天级',
    targetModels: 'Vox2Spk-v2.1 (4.60M) + Tract2Vox-Large v2.1 (14.39M) / Lite v3 (3.73M)',
    corpusReq: '16 kHz 洁净单人干声（单人独唱/配音），单卡 16–24 GB VRAM；建议保留 12%–35% VTL 物理真值锚定。',
    steps: [
      '使用关系矩阵蒸馏与非对称负对排斥精调 Vox2Spk-v2.1，在对齐 WavLM-SV 空间的同时拉大不同说话人夹角。',
      '在 Tract2Vox 训练中联合 180h 合成、宽域 F0、多情感/戏曲/歌唱干声与飞轮闭环数据，按需导出 14.4M Large 档或 3.7M Lite 极速档。',
      '将导出的 .onnx 放入同一目录，在设置页点击「从文件夹装载」即可自动按契约热切换。',
    ],
    commands: `# 1. 区分度强化声纹微调（约 13 min）
python -B scripts/train_vox2spk_v2.py --steps 7000 --rel-weight 3.0 --neg-weight 10.0 --score-mode discriminative

# 2. 导出 Batch-2 全套纯 ONNX 并做双长度精度自检
python -B scripts/export_batch2_web_onnx.py`,
  },
];

export interface EngineEndpointSpec {
  method: 'GET' | 'POST';
  path: string;
  purpose: string;
  payload: string;
}

export const ENGINE_LOADING_ENDPOINTS: readonly EngineEndpointSpec[] = [
  {
    method: 'GET',
    path: '/api/models/local',
    purpose: '查询本地 ONNX 模型槽位状态、参数量、内存驻留与外置来源',
    payload: '返回 runtime_providers、cuda_available 与逐槽位 loaded/in_memory/load_ms',
  },
  {
    method: 'POST',
    path: '/api/models/local/load',
    purpose: '单个或批量将 ONNX 会话装载入内存（支持 CPU / CUDA 选择）',
    payload: '{ "name": "Vox2Tract-Lite", "device": "cpu" } 或 { "all": true }',
  },
  {
    method: 'POST',
    path: '/api/models/local/unload',
    purpose: '释放 InferenceSession 并立即触发 GC 回收内存，停用对应槽位',
    payload: '{ "name": "Vox2Align-Lite v2" } 或 { "all": true }',
  },
  {
    method: 'POST',
    path: '/api/models/local/mount',
    purpose: '按本机磁盘路径挂载单个 .onnx 或扫描目录（最大深度 2）批量匹配装载（上限 256 MiB）',
    payload: '单文件：{ "path": "D:\\\\m.onnx", "name"?: "slot" }；目录：{ "folder": "D:\\\\models", "mount": true }',
  },
  {
    method: 'POST',
    path: '/api/models/local/mount-binary',
    purpose: '接收浏览器上传的 .onnx 二进制流，自动校验契约并暂存至 .cache/custom-models/',
    payload: 'Query: ?filename=custom.onnx&name=<slot>，Body: octet-stream（1 KB – 64 MiB）',
  },
  {
    method: 'POST',
    path: '/api/models/local/reset',
    purpose: '解除外置覆盖，恢复对应槽位或全部槽位为随包内置默认 ONNX 权重',
    payload: '{ "name": "Vox2Spk-Lite" } 或 { "all": true }',
  },
];

export function buildTrainingReportMarkdown(): string {
  const lines: string[] = [
    `# ${APP_BRAND_NAME} · 模型训练与技术报告`,
    '',
    `> 文档版本：${MODEL_TRAINING_REPORT_META.version}`,
    `> 模型体系：${MODEL_TRAINING_REPORT_META.suiteName}`,
    `> 统一解剖基准：${MODEL_TRAINING_REPORT_META.geometryStandard}`,
    `> 计算与推理环境：${MODEL_TRAINING_REPORT_META.hardwareEnv}`,
    '',
    '## 1. 最新 8 模型核心体系与扩展档位',
    '',
    '| 模型名 | 定位 | 核心网络结构 | 参数量 | 权重体积 | 训练周期 | 核心实测指标 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...FULL_MODEL_ZOO.map(
      (m) => `| ${m.name} | ${m.tier} | ${m.arch} | ${m.params} | ${m.weightSize} | ${m.schedule} | ${m.metrics} |`,
    ),
    '',
    `> 默认运行矩阵共 ${LOCAL_MODEL_TOTALS.count} 个模型，合计 **${LOCAL_MODEL_TOTALS.totalParamsText}** 参数、**${LOCAL_MODEL_TOTALS.totalSizeText}**，零 PyTorch 运行时依赖；独立对齐槽位 \`Vox2Align-Lite v2\` 默认隐藏不装载，保留供用户针对其他语种/方言自行训练扩展。`,
    `> 延迟测量口径：${MODEL_TRAINING_REPORT_META.cpuBenchmarkProtocol}`,
    '',
    '## 2. 神经网络架构分层拆解（CNN / Conformer / RNN）',
    '',
    '| 模型 | 阶段 | 参数量 | 架构家族 | CNN 层 | RNN 层 | Attention / Conformer | Linear 层 | 核心特点 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...MODEL_ARCHITECTURE_LAYERS.map(
      (a) => `| ${a.name} | ${a.stage} | ${a.params} | ${a.family} | ${a.cnn} | ${a.rnn} | ${a.attention} | ${a.linear} | ${a.highlight} |`,
    ),
    '',
    '## 3. 27 维声道—声门物理控制空间契约（Native 27D）',
    '',
    '| 下标 | 参数 | 分组 | 下界 | 上界 | 单位 | 归一化 | 生理与声学意义 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...M27_PARAMETER_SPECS.map(
      (p) => `| ${p.idx} | ${p.code} | ${p.group} | ${p.min} | ${p.max} | ${p.unit} | ${p.norm} | ${p.meaning} |`,
    ),
    '',
    '## 4. 32 维通用国际音标发音特征体系（PHON_FEAT_NAMES_32）',
    '',
    '| 下标 | 特征名 | 分组 | 取值范围 | 代表音标 | 语音学意义 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...IPA32_FEATURE_SPECS.map(
      (f) => `| ${f.idx} | ${f.key} | ${f.group} | ${f.range} | ${f.examples} | ${f.meaning} |`,
    ),
    '',
    '## 5. 扩充后训练与评测语料清单（18 项数据源）',
    '',
    '| 语料/数据集 | 类别 | 规模 | 时长 / 构成 | 使用模型 | 说明 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...FULL_CORPUS_INVENTORY.map(
      (c) => `| ${c.name} | ${c.category} | ${c.scale} | ${c.durationOrSpk} | ${c.usedBy} | ${c.notes} |`,
    ),
    '',
    '## 6. ONNX 槽位输入输出张量契约与二次训练扩展',
    '',
    '| 槽位名称 | 输入张量契约 | 输出张量契约 | 文件名匹配关键词 | 卸载降级 / 扩展说明 |',
    '| --- | --- | --- | --- | --- |',
    ...ONNX_SLOT_CONTRACTS.map(
      (c) => `| ${c.name}${c.optionalNote ? ` (${c.optionalNote})` : ''} | \`${c.inputs}\` | \`${c.outputs}\` | \`${c.patterns}\` | ${c.fallback} |`,
    ),
    '',
    ...RETRAINING_RECIPES.flatMap((r) => [
      `### ${r.scenario}（${r.difficulty}）`,
      '',
      `- 目标模型：${r.targetModels}`,
      `- 语料与算力要求：${r.corpusReq}`,
      ...r.steps.map((s, i) => `${i + 1}. ${s}`),
      '',
      '```powershell',
      r.commands,
      '```',
      '',
    ]),
    '## 7. 热插拔与外置模型装载 HTTP API',
    '',
    '| 方法 | 端点 | 用途 | 请求/响应说明 |',
    '| --- | --- | --- | --- |',
    ...ENGINE_LOADING_ENDPOINTS.map(
      (e) => `| \`${e.method}\` | \`${e.path}\` | ${e.purpose} | ${e.payload} |`,
    ),
  ];
  return lines.join('\n');
}
