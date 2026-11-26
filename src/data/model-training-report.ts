/**
 * Comprehensive Model Training Technical Report, Corpus Inventory, Tensor Contracts & Verified Benchmarks.
 * Single source of truth for `ModelReportView.vue`, `AboutView.vue`, and `SettingsView.vue`.
 *
 * All metrics, step counts, corpus statistics, and tensor shapes are verified directly against
 * training run logs and `engine/model_registry_runtime.py`.
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
}

export const LOCAL_MODEL_SPECS: readonly LocalModelSpec[] = [
  {
    name: 'Vox2Tract-Lite',
    paramsM: 7.64,
    sizeMb: 14.75,
    precision: 'ONNX',
    role: '16 kHz 语音反演为 50 Hz 27 维声道与声门动态轨迹',
    pipelineStage: '声学反演主干',
    cpuLatencyMs: 80.2,
    trainSteps: '55,000 步（132.3 min）',
    bestMetric: '自然 T17 PCC 0.9102 · R21 L24 0.8235',
  },
  {
    name: 'Vox2Align-Lite v2',
    paramsM: 4.33,
    sizeMb: 8.37,
    precision: 'ONNX',
    role: '按参考文本或识别结果精准定位音节与音素边界及静音门控',
    pipelineStage: '双语强制对齐',
    cpuLatencyMs: 41.4,
    trainSteps: '20,000 步（66.9 min）',
    bestMetric: '中/英 ≤20ms 边界 93.7% / 95.5% · Mask F1 0.989',
  },
  {
    name: 'IPA2Tract-Lite',
    paramsM: 4.23,
    sizeMb: 8.18,
    precision: 'ONNX',
    role: '音标关键帧之间的连续协同发音构音轨迹残差规划',
    pipelineStage: '协同构音规划',
    cpuLatencyMs: 64.4,
    trainSteps: '合成预热 15k + 自然扩展 30k',
    bestMetric: '较基线降误差 35.9% · EMA LD 0.6956',
  },
  {
    name: 'Tract2Vox-Lite',
    paramsM: 3.72,
    sizeMb: 7.19,
    precision: 'ONNX',
    role: '27 维声道轨迹与 512 维声纹联合驱动的高保真神经声码器',
    pipelineStage: '神经声码器',
    cpuLatencyMs: 149.0,
    trainSteps: '21,000 步 / best @17,000（45.3 min）',
    bestMetric: 'val_score 0.0626 · 8 句 L24 0.8478 / Spk 0.8533',
  },
  {
    name: 'Vox2Spk-Lite',
    paramsM: 2.90,
    sizeMb: 5.57,
    precision: 'ONNX',
    role: '从参考录音提取跨语种解耦的 512 维说话人声纹表征',
    pipelineStage: '音色声纹编码',
    cpuLatencyMs: 12.3,
    trainSteps: '30,000 步（12.4 min）',
    bestMetric: 'Teacher Cos 0.9172 · 类间间隙 0.3546',
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
    bestMetric: '48 kHz 高解析实时流式降噪',
  },
  {
    name: 'Text2Prosody-Lite',
    paramsM: 1.98,
    sizeMb: 3.88,
    precision: 'ONNX',
    role: '普通话与英语文本的音素时长、相对半音 F0 轮廓及停顿预测',
    pipelineStage: '文本韵律预测',
    cpuLatencyMs: 18.5,
    trainSteps: '18,000 步 / best @7,500（19.3 min）',
    bestMetric: '中/英时长 MAE 22.9 / 17.4 ms · F0 MAE 1.20 st',
  },
  {
    name: 'Tract2Area-Proxy',
    paramsM: 0.23,
    sizeMb: 0.88,
    precision: 'ONNX',
    role: '关键帧规划阶段的可微 6 维声道关键区面积代理（全口腔、双唇、舌冠、舌背、咽腔最小截面积与腭咽口面积）',
    pipelineStage: '可微物理守卫',
    cpuLatencyMs: 1.8,
    trainSteps: '25 epochs / 300k 帧',
    bestMetric: '6 维关键区面积 MAE 0.0478 cm²',
  },
  {
    name: 'SwiftF0',
    paramsM: 0.03,
    sizeMb: 0.13,
    precision: 'ONNX',
    role: '超轻量低延迟实测基频轨迹提取（40–600 Hz）与清浊音判别',
    pipelineStage: '基频提取前端',
    cpuLatencyMs: 4.2,
    trainSteps: '预训练开源 ONNX 0.3.0',
    bestMetric: '50 Hz 严格对齐 · 超轻 29.9K 参数',
  },
] as const;

export const LOCAL_MODEL_TOTALS = {
  count: LOCAL_MODEL_SPECS.length,
  totalParamsText: '27.64 M',
  totalSizeText: '58.96 MiB',
} as const;

export const MODEL_TRAINING_REPORT_META = {
  version: '技术报告 · 2026-11-25',
  suiteName: 'VoxFigura Core 物理—神经模型体系（旗舰教师链 + 9 项端侧纯 ONNX 矩阵）',
  flagshipLineage:
    '旗舰教师基座：Vox2Tract-Large (22.62M) · Vox2Tract-PR (3.21M) · Tract2Feat-Proxy (14.88M) · Tract2Vox-Large (14.36M)',
  geometryStandard:
    'VocalTractLab 2.4（原生 R21 声管管线）/ JD2 成年男声 3D 解剖几何（65 截面面积函数 / 200 Hz 物理管段 / 50 Hz 神经控制 / 48 kHz 整数采样输出；Tract2Area-Proxy 输出 6 个关键区汇总面积）',
  hardwareEnv:
    '单卡 NVIDIA GeForce RTX 5090 Laptop GPU (24 GB VRAM) · Python 3.11.9 · PyTorch 2.7.1+cu128 · 推理端纯 ONNX Runtime 1.32.0（零 PyTorch 运行时依赖）',
  cpuBenchmarkProtocol:
    '端到端评测折线（Vox2Tract-Lite 80.2 ms、Tract2Vox-Lite 149.0 ms 等）取自 8 段评测音频（2.22–5.00 s，均值 3.06 s，CPU 4 线程含前端特征提取与解码）的算术均值，其中 DPDFNet (18.0 ms) 按 48 kHz 流式逐帧 STFT 增强实测，SwiftF0 (4.2 ms) 为评测切片平均耗时。纯 ONNX Runtime 1.32.0（CPUExecutionProvider，intra_op=4 / inter_op=1，统一固定 3.0 s / 150 帧输入，预热 5 次取 20 次均值）算子图前向实测为：Vox2Tract-Lite 22.5 ms、Vox2Align-Lite v2 13.5 ms、IPA2Tract-Lite 15.0 ms、Tract2Vox-Lite 126.9 ms、Vox2Spk-Lite 6.0 ms、Text2Prosody-Lite 1.1 ms、Tract2Area-Proxy 0.41 ms、SwiftF0 9.7 ms。',
  updatedNote:
    '本文档收录 14 项关联模型（4 项旗舰教师与代理 + 7 项自研端侧 ONNX + 2 项开源前端 ONNX + 1 项 22 维历史归档）的架构演进、语料清单、实测收敛曲线、训练复盘、二次训练方法以及本地 ONNX 热插拔契约。',
} as const;

export interface ModelZooRow {
  name: string;
  tier: '旗舰教师' | '训练代理' | '端侧 ONNX' | '前端开源' | '历史基线';
  arch: string;
  params: string;
  weightSize: string;
  schedule: string;
  status: '已验证上线' | '旗舰教师' | '历史归档';
  metrics: string;
}

export const FULL_MODEL_ZOO: readonly ModelZooRow[] = [
  {
    name: 'Vox2Tract-Large',
    tier: '旗舰教师',
    arch: '双分支 Conformer + BiLSTM（声道 17 维 / 声门 8 维解耦）',
    params: '22.62 M',
    weightSize: '86.50 MB (FP32)',
    schedule: '合成预热 45k → 锚定微调 32k（best @26.5k）',
    status: '旗舰教师',
    metrics: 'T17 PCC 0.8200 · G8 PCC 0.9040 · VTL 物理重合成 L24 0.8707',
  },
  {
    name: 'Vox2Tract-PR',
    tier: '旗舰教师',
    arch: '25 层加权 WavLM + 3 VQ + 8×ConvNeXt + BiLSTM 肺压编码器',
    params: '3.21 M',
    weightSize: '12.28 MB (FP32)',
    schedule: '30,000 步（best @26.5k）',
    status: '旗舰教师',
    metrics: 'val_loss 0.009636 · PR PCC 0.9811',
  },
  {
    name: 'Tract2Feat-Proxy',
    tier: '训练代理',
    arch: '8 层 Conformer-256 双头声学代理（预测 L24 + L6）',
    params: '14.88 M',
    weightSize: '56.88 MB (FP32)',
    schedule: '50,000 步（best @43.5k，270h 联合）',
    status: '旗舰教师',
    metrics: 'Cos24 0.8809 · Cos6 0.8408（作为感知蒸馏教师）',
  },
  {
    name: 'Tract2Vox-Large',
    tier: '旗舰教师',
    arch: 'Glottis-NSF v3 神经声码器（ch=512，12 谐波 + 0.5F0 次谐波）',
    params: '14.36 M (G) + 22.61 M (D)',
    weightSize: '54.87 MB (FP32 G)',
    schedule: '主训 28k + 低 LR 余弦精调 4k（best @29k）',
    status: '旗舰教师',
    metrics: 'mel_l1 0.7176 · L24 0.8895 · L6 0.7918 · Spk 0.8855',
  },
  {
    name: 'Vox2Tract-Lite',
    tier: '端侧 ONNX',
    arch: '167 维纯声学前端 + 6 层 Conformer-192 + 三路解耦头',
    params: '7.64 M',
    weightSize: '14.75 MB (ONNX) / 7.56 MB (INT8)',
    schedule: '55,000 步 / 132.3 min（65% 蒸馏 + 35% 180h）',
    status: '已验证上线',
    metrics: '未见自然 T17 0.9102 / G8 0.8420 · 8 句端到端均值 80.2 ms (RTF 0.029) · ORT 3s 22.5 ms',
  },
  {
    name: 'Vox2Align-Lite v2',
    tier: '端侧 ONNX',
    arch: '4 层 Conformer-192 + BiGRU-144（输入 163 维 80-Mel+Δ+能量，图内拼 80-ΔΔ 为 243 维 + 7 输出头）',
    params: '4.33 M',
    weightSize: '8.37 MB (ONNX) / 4.31 MB (INT8)',
    schedule: '20,000 步 / 66.9 min（70,000+ 双语朗读与歌唱）',
    status: '已验证上线',
    metrics: '中/英 ≤20ms 边界 93.66% / 95.47% · 中文音节准 90.71% · 全链路 41.4 ms (ORT 3s 13.5 ms)',
  },
  {
    name: 'IPA2Tract-Lite',
    tier: '端侧 ONNX',
    arch: '111 维条件 + 4 层 Conformer-192 + BiGRU + 零初始化双残差',
    params: '4.23 M',
    weightSize: '8.18 MB (ONNX) / 4.17 MB (INT8)',
    schedule: '合成预热 15k → 自然扩展 30k（best @15k）',
    status: '已验证上线',
    metrics: 'val_loss 0.2420 · 零泄漏 0.0 · EMA LD 0.6956 / TTX 0.6743 · 全链路 64.4 ms (ORT 3s 15.0 ms)',
  },
  {
    name: 'Tract2Vox-Lite',
    tier: '端侧 ONNX',
    arch: '轻量 Glottis-NSF v3 神经声码器（ch=256，cond=128，去 weight_norm）',
    params: '3.72 M',
    weightSize: '7.19 MB (ONNX) / 3.65 MB (INT8)',
    schedule: '21,000 步 / 45.3 min（best @17,000，含教师 Mel 蒸馏）',
    status: '已验证上线',
    metrics: 'val_score 0.0626 · 8 句 Lite L24 0.8478 / Spk 0.8533 · 8 句均值 149 ms (ORT 3s 126.9 ms)',
  },
  {
    name: 'Vox2Spk-Lite',
    tier: '端侧 ONNX',
    arch: '80-Mel CMN + 3×ECAPA SE-Res2Block + ASP → 512 维声纹编码器',
    params: '2.90 M',
    weightSize: '5.57 MB (ONNX) / 2.91 MB (INT8)',
    schedule: '30,000 步 / 12.4 min（PK 采样 32×4，全内存缓存）',
    status: '已验证上线',
    metrics: 'Teacher Cos 0.9172 · 同人 0.9394 / 异人 0.5848 · 全链路 12.3 ms (ORT 3s 6.0 ms)',
  },
  {
    name: 'Text2Prosody-Lite',
    tier: '端侧 ONNX',
    arch: '4 层 Conformer-128 + BiGRU（22 维音素特征 + 10 维结构位置 + 4 离散嵌入）',
    params: '1.98 M',
    weightSize: '3.88 MB (ONNX) / 2.00 MB (INT8)',
    schedule: '18,000 步 / 19.3 min（best @7,500，中英混排拼接增强）',
    status: '已验证上线',
    metrics: '中/英时长 MAE 22.94 / 17.37 ms · F0 PCC 0.774 / 0.678 · 全链路 18.5 ms (ORT 1.1 ms)',
  },
  {
    name: 'Tract2Area-Proxy',
    tier: '端侧 ONNX',
    arch: '3 层 ResMLP-192（输出全口腔/双唇/舌冠/舌背/咽腔最小面积与腭咽口面积共 6 维）',
    params: '0.23 M',
    weightSize: '0.88 MB (ONNX FP32)',
    schedule: '25 epochs / 300,000 JD2 采样帧',
    status: '已验证上线',
    metrics: '6 维关键区面积 val_mae 0.04776 cm²（可微闭塞与开口物理守卫 · ORT 3s 0.41 ms）',
  },
  {
    name: 'DPDFNet',
    tier: '前端开源',
    arch: '48 kHz 高解析流式频谱增强网络（有状态逐帧 STFT 滤波）',
    params: '2.58 M',
    weightSize: '10.01 MB (ONNX)',
    schedule: '预训练开源权重',
    status: '已验证上线',
    metrics: '保持 48 kHz 采样率实时去底噪，保护高频擦音纹理',
  },
  {
    name: 'SwiftF0',
    tier: '前端开源',
    arch: '超轻量单帧卷积基频与置信度估计器（0.3.0）',
    params: '0.03 M',
    weightSize: '0.13 MB (ONNX)',
    schedule: '预训练开源权重',
    status: '已验证上线',
    metrics: '40–600 Hz 全域覆盖，与 50 Hz 反演网格严格锁相',
  },
  {
    name: 'Vox2Tract-Legacy (22D)',
    tier: '历史基线',
    arch: '早期 22 维反演基线（9.01M）+ 轻量版（7.02M）',
    params: '9.01 M / 7.02 M',
    weightSize: '13.55 MB (FP16 轻量归档)',
    schedule: '合成 60k → 自然 26k（流式 242,556 条 / 278h）',
    status: '历史归档',
    metrics: '验证冻结解码器感知蒸馏将 L24 从 0.7642 拉升至 0.7976',
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
  { idx: 17, code: 'F0', group: '基频与肺压', min: '40.0', max: '600.0', unit: 'Hz', norm: '对数 ln(F0) [-1,1]', meaning: '声带振动基频（推理由 SwiftF0 给定，编辑范围 60–600 Hz）' },
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
    usedBy: '全部合成生成脚本',
    notes: '8,000 次随机探索多轮凸包剥离与 JD2 原型合并构建，可完全本地再生',
  },
  {
    name: 'synth_full_glottis_180h',
    category: '本地物理合成',
    scale: '170,550 条（3,411 分片，20.94 GB）',
    durationOrSpk: '179.89 小时（VTL JD2 200Hz/48kHz）',
    usedBy: '教师全链 / 端侧 Lite / IPA2Tract 预热',
    notes: '覆盖 7 种单发声态（70%）与 50,756 条句内多态渐变（30%），引擎异常剔除率 2.46%',
  },
  {
    name: 'synth_100h（早期 22 维升格）',
    category: '本地物理合成',
    scale: '85,300 条（853 分片，10.34 GB）',
    durationOrSpk: '90.16 小时（零失败率 0.00%）',
    usedBy: '22 维历史基线 / 声学代理与反演预热（带声门掩码）',
    notes: '升格至 27 维后仅在 XB/CA/RA 提供 0.25 权重，阻断固定常数污染声门分支',
  },
  {
    name: 'tube_proxy_samples.npz',
    category: '本地物理合成',
    scale: '300,000 帧（22.39 MB）',
    durationOrSpk: '65% 轨迹抖动 + 20% 状态扰动 + 15% 全盒采样',
    usedBy: 'Tract2Area-Proxy',
    notes: '直接调用 VTL 2.4 (R21) prepare_tube() 获取 6 区精确最小截面积真值',
  },
  {
    name: 'AISHELL-3（普通话多人）',
    category: '公开朗读/方言',
    scale: '训 74,328 条 / 测 13,707 条',
    durationOrSpk: '训 174 人 / 测 44 人（说话人严格隔离）',
    usedBy: '反演 / 声码器 / Lite 缓存 / IPA2Tract / Prosody / Align v2',
    notes: '流式读取未压缩 .tar 字节偏移，零解压落盘；Prosody 与 Align v2 使用过滤后 MFA 对齐（17,534 条）',
  },
  {
    name: 'LibriSpeech（clean-100 / dev-clean）',
    category: '公开朗读/方言',
    scale: '多人索引 3,012 训 / 160 测 + 流式全集',
    durationOrSpk: '训 251 人 / 测 40 人（百小时级流式）',
    usedBy: '反演 / 声码器 / Lite 缓存 / Prosody (4,326) / Align v2 (7,500)',
    notes: 'GPU WavLM-CTC 生成 7.5 ms 精度英语对齐边界',
  },
  {
    name: 'KeSpeech（普通话与方言）',
    category: '公开朗读/方言',
    scale: '分卷 aa..ai 跨卷流式',
    durationOrSpk: '1,000+ 小时级多方言',
    usedBy: '早期 22 维流式基线 & 端到端测试句',
    notes: '自研 MultiPartRawStream 内存级跨卷流式解压读取',
  },
  {
    name: 'TIMIT（英语人工金标）',
    category: '授权朗读语料',
    scale: '6,300 条（训 4,620 / 测 1,680）',
    durationOrSpk: '人工音素边界（含 *cl 塞音闭塞段）',
    usedBy: 'IPA2Tract-Lite / Text2Prosody-Lite / Vox2Align-Lite v2',
    notes: '核心塞音闭塞与爆破边界金标，用于评测毫秒级边界误差',
  },
  {
    name: 'ESD（中英多情感）',
    category: '公开情感/表现',
    scale: '35,000 条',
    durationOrSpk: '29.07 小时（16 kHz 多情绪朗读）',
    usedBy: '反演微调 / 声码器 / Lite 缓存 / IPA2Tract-Lite',
    notes: '增强大动态基频、紧嗓/叹气等情绪发声覆盖',
  },
  {
    name: 'Expresso（高表现力英语）',
    category: '公开情感/表现',
    scale: '11,615 条',
    durationOrSpk: '10.93 小时（耳语/朗读/笑语/强调）',
    usedBy: '反演微调 / 声码器 / Lite / IPA2Tract / Prosody (7,518) / Align v2 (7,716)',
    notes: '提供耳语、气声与极富表现力的会话韵律样本',
  },
  {
    name: 'GTSinger ZH/EN（精细声乐技巧）',
    category: '公开干声歌唱',
    scale: '17,080 条（含 15,000 人工对齐标注）',
    durationOrSpk: '36.20 小时（真假声/咽音/滑音/气声）',
    usedBy: '反演微调 / 声码器 / Lite / IPA2Tract (23,885) / Align v2 (15k)',
    notes: '自动过滤 P95(F0) > 550 Hz 极端女高音；Align v2 屏蔽歌唱音高声调头以防干扰说话声调',
  },
  {
    name: 'M4Singer + OpenCpop',
    category: '公开干声歌唱',
    scale: '23,697 条',
    durationOrSpk: '34.61 小时（中文干声歌唱）',
    usedBy: '反演微调 / 声码器 / Lite 缓存',
    notes: '扩展宽音域连贯元音动程与歌唱肺压支撑',
  },
  {
    name: 'VocalSet（声乐发声技巧）',
    category: '公开干声歌唱',
    scale: '3,613 条',
    durationOrSpk: '8.79 小时（气声/颤音/直声/歌剧等）',
    usedBy: '反演微调 / 声码器 / Lite / IPA2Tract-Lite',
    notes: '强化非模态声门参数与大跨度基频泛化',
  },
  {
    name: 'USC-TIMIT EMA（真人电磁发音仪）',
    category: '真人传感盲测',
    scale: '276 条（仅盲测，0 条进训练）',
    durationOrSpk: '20 份独立测试文件同步唇/舌/颌传感器',
    usedBy: 'IPA2Tract-Lite 物理传感独立检验',
    notes: '用于客观检验预测舌位与真实人类口腔器官位移的相关性',
  },
  {
    name: 'distill_m27_v1（共享教师蒸馏缓存）',
    category: '派生任务缓存',
    scale: '60,010 条（120 分片，7.48 GB）',
    durationOrSpk: '63.61 小时（495 人训 / 84 未见人测）',
    usedBy: 'Vox2Tract-Lite / Vox2Spk-Lite / Tract2Vox-Lite',
    notes: '由 Vox2Tract-Large 提前推理封装，训练期全量预载主机内存实现 100% RAM 命中',
  },
  {
    name: 'prosody_zh_en & vox2align_v2',
    category: '派生任务缓存',
    scale: 'Prosody 52,339 条 · Align v2 70,000+ 条',
    durationOrSpk: '含中英朗读、歌唱、单字锚点（webedit / ong_iong）',
    usedBy: 'Text2Prosody-Lite / Vox2Align-Lite v2',
    notes: 'Prosody 经过 7 项 MFA 质量门控剔除 4,466 条漂移样本；训练期在线执行 15–18% 中英混排拼接',
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

/** Real training logs sampled directly from F:/TensorTract3_Train/runs/ */
export const TRAINING_CURVES = {
  /** Vox2Tract-Large Anchored (Pass 2) vs Unanchored drift */
  inverterAnchoredSteps: [0, 2000, 3500, 5500, 7500, 9000, 11000, 14500, 18000, 20000, 23000, 26500, 30000, 32000],
  inverterAnchoredTract: [0.6293, 0.7309, 0.7496, 0.7711, 0.7760, 0.7892, 0.7953, 0.7962, 0.7964, 0.8029, 0.8166, 0.8200, 0.8221, 0.8144],
  inverterAnchoredGlottis: [0.8940, 0.9050, 0.9038, 0.9018, 0.9039, 0.9034, 0.9031, 0.9058, 0.9013, 0.9021, 0.9038, 0.9040, 0.9045, 0.9013],
  inverterUnanchoredSteps: [0, 2500, 3000, 3500, 4000, 4500, 5000, 5500],
  inverterUnanchoredTract: [0.6299, 0.4374, 0.4248, 0.4258, 0.4145, 0.4092, 0.4068, 0.4076],
  inverterUnanchoredGlottis: [0.8905, 0.6908, 0.6497, 0.6397, 0.5902, 0.6083, 0.5979, 0.5435],

  /** Tract2Vox-Large (0 -> 32k, 28k->32k low-LR cosine refinement) */
  vocoderLargeSteps: [2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000, 20000, 22000, 24000, 26000, 28000, 29000, 30000, 31000, 32000],
  vocoderLargeScore: [0.1790, 0.1580, 0.1443, 0.0953, 0.1289, 0.1131, 0.0586, 0.0725, 0.0434, 0.0651, 0.0670, 0.1165, 0.0681, 0.0531, 0.0353, 0.0369, 0.0358, 0.0361],
  vocoderLargeL24: [0.7501, 0.8032, 0.8413, 0.8594, 0.8480, 0.8574, 0.8660, 0.8680, 0.8750, 0.8756, 0.8775, 0.8780, 0.8741, 0.8871, 0.8895, 0.8885, 0.8888, 0.8912],
  vocoderLargeSpk: [0.7670, 0.8320, 0.8465, 0.8589, 0.8701, 0.8789, 0.8829, 0.8838, 0.8869, 0.8876, 0.8795, 0.8779, 0.8807, 0.8876, 0.8855, 0.8834, 0.8834, 0.8852],

  /** Tract2Vox-Lite (2.5k -> 21k, best @17k) */
  vocoderLiteSteps: [2500, 5000, 7500, 10000, 12500, 15000, 16000, 17000, 18000, 19000, 20000, 21000],
  vocoderLiteScore: [0.3318, 0.1291, 0.1518, 0.0921, 0.0783, 0.0652, 0.0732, 0.0626, 0.0712, 0.0806, 0.0776, 0.0736],
  vocoderLiteL24: [0.6993, 0.8170, 0.8296, 0.8545, 0.8568, 0.8602, 0.8582, 0.8588, 0.8633, 0.8665, 0.8679, 0.8654],
  vocoderLiteE2eSpk: [0.7750, 0.8264, 0.8478, 0.8597, 0.8674, 0.8695, 0.8754, 0.8736, 0.8763, 0.8756, 0.8766, 0.8726],

  /** Vocoder generation comparison */
  vocoderGen: [
    { name: 'v1 纯 HiFi-GAN (14.9M)', melL1: 0.8220, l24: 0.7743, spk: 0.8390, score: 0.4348 },
    { name: 'v2 7 谐波 NSF (14.3M)', melL1: 0.7495, l24: 0.8277, spk: 0.8580, score: 0.3357 },
    { name: 'v3 Large @29k (14.4M)', melL1: 0.7176, l24: 0.8895, spk: 0.8855, score: 0.0353 },
    { name: 'Lite @17k (3.72M ONNX)', melL1: 0.7231, l24: 0.8588, spk: 0.8828, score: 0.0626 },
  ],

  /** Per-dimension PCC of Vox2Tract-Large best @26.5k */
  perDimPcc: [
    { dim: 'XT', val: 0.9663, group: '声门' },
    { dim: 'XB', val: 0.9645, group: '声门' },
    { dim: 'TCX', val: 0.9512, group: '声道' },
    { dim: 'RA', val: 0.9496, group: '声门' },
    { dim: 'VO', val: 0.9429, group: '声道' },
    { dim: 'SHIM', val: 0.9293, group: '声门' },
    { dim: 'TCY', val: 0.9055, group: '声道' },
    { dim: 'HY', val: 0.8964, group: '声道' },
    { dim: 'LAG', val: 0.8953, group: '声门' },
    { dim: 'TTY', val: 0.8734, group: '声道' },
    { dim: 'CA', val: 0.8728, group: '声门' },
    { dim: 'PS', val: 0.8616, group: '声门' },
    { dim: 'TTX', val: 0.8421, group: '声道' },
    { dim: 'LP', val: 0.8324, group: '声道' },
    { dim: 'TS2', val: 0.8249, group: '声道' },
    { dim: 'HX', val: 0.8182, group: '声道' },
    { dim: 'TS3', val: 0.7940, group: '声道' },
    { dim: 'FL', val: 0.7924, group: '声门' },
    { dim: 'LD', val: 0.7899, group: '声道' },
    { dim: 'TBY', val: 0.7892, group: '声道' },
    { dim: 'JA', val: 0.7884, group: '声道' },
    { dim: 'JX', val: 0.7631, group: '声道' },
    { dim: 'VS', val: 0.7520, group: '声道' },
    { dim: 'TBX', val: 0.7514, group: '声道' },
    { dim: 'TS1', val: 0.6257, group: '声道' },
  ],

  /** USC-TIMIT human EMA sensor validation (20 unseen test files) */
  emaRadar: [
    { axis: '唇开口 LD', pcc: 0.6956 },
    { axis: '舌尖前后 TTX', pcc: 0.6743 },
    { axis: '舌体高低 TCY', pcc: 0.5958 },
    { axis: '舌尖高低 TTY', pcc: 0.5159 },
    { axis: '舌体前后 TCX', pcc: 0.3583 },
    { axis: '下颌开口 JA', pcc: 0.3335 },
    { axis: '唇突度 LP', pcc: 0.3035 },
  ],

  /** Vox2Align-Lite v2 convergence (2k -> 20k) */
  alignV2Steps: [2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000, 20000],
  alignV2ZhSyl: [77.42, 83.62, 84.97, 85.55, 86.01, 88.52, 88.59, 89.79, 90.21, 90.02],
  alignV2ZhFrame: [82.21, 85.22, 85.79, 86.34, 86.99, 87.81, 87.85, 88.20, 88.50, 88.49],
  alignV2EnFrame: [76.34, 78.53, 80.43, 81.27, 81.93, 82.45, 82.66, 82.76, 82.97, 83.04],
  alignV2ZhBnd20: [90.71, 91.79, 90.76, 92.59, 92.90, 93.39, 93.46, 93.75, 93.69, 93.67],
  alignV2EnBnd20: [92.69, 93.93, 94.22, 94.61, 95.05, 94.82, 95.17, 95.19, 95.29, 95.46],
  alignV2MaskF1: [98.55, 98.77, 98.81, 98.86, 98.88, 98.85, 98.91, 98.91, 98.94, 98.94],

  /** Text2Prosody-Lite best @7.5k across 4 domains */
  prosodyDomains: [
    { domain: '普通话朗读 (ZH)', durMaeMs: 22.94, f0MaeSt: 1.198, f0Pcc: 0.7743 },
    { domain: '英语朗读 (EN)', durMaeMs: 17.37, f0MaeSt: 1.203, f0Pcc: 0.6781 },
    { domain: '中英混排 (CS)', durMaeMs: 23.27, f0MaeSt: 1.581, f0Pcc: 0.6357 },
    { domain: '孤立单字 (ISO)', durMaeMs: 38.59, f0MaeSt: 1.158, f0Pcc: 0.5592 },
  ],

  /** 8-clip end-to-end audition benchmark (Teacher vs Tract2Vox-Lite vs Full Lite E2E) */
  audition8Clips: [
    { label: '四声连读', teacherL24: 0.8728, liteL24: 0.8541, e2eL24: 0.8223, e2eSpk: 0.7481 },
    { label: '普通话自然', teacherL24: 0.8860, liteL24: 0.8801, e2eL24: 0.8474, e2eSpk: 0.8716 },
    { label: '英语自然', teacherL24: 0.9073, liteL24: 0.9011, e2eL24: 0.8526, e2eSpk: 0.9187 },
    { label: '气声', teacherL24: 0.8346, liteL24: 0.8288, e2eL24: 0.7455, e2eSpk: 0.9411 },
    { label: '紧嗓', teacherL24: 0.8425, liteL24: 0.8374, e2eL24: 0.8157, e2eSpk: 0.7368 },
    { label: '嘎裂', teacherL24: 0.8386, liteL24: 0.8097, e2eL24: 0.7813, e2eSpk: 0.8334 },
    { label: '假声', teacherL24: 0.8461, liteL24: 0.8222, e2eL24: 0.7651, e2eSpk: 0.8446 },
    { label: '五态渐变', teacherL24: 0.8209, liteL24: 0.8491, e2eL24: 0.8115, e2eSpk: 0.8815 },
  ],
} as const;

export interface OnnxSlotContractRow {
  name: string;
  slug: string;
  inputs: string;
  outputs: string;
  patterns: string;
  fallback: string;
}

export const ONNX_SLOT_CONTRACTS: readonly OnnxSlotContractRow[] = [
  {
    name: 'Vox2Tract-Lite',
    slug: 'vox2tract_lite',
    inputs: 'mel_feats (B,T,163) float32 + vq_cues (B,T,3) float32 + f0_norm (B,T) float32',
    outputs: 'tract17 (B,T,17), pr1 (B,T,1), glot8 (B,T,8), h_backbone (B,T,192)',
    patterns: 'vox2tract / inverter / m27_invert',
    fallback: '卸载后声道重建接口返回 503 model_unloaded',
  },
  {
    name: 'Vox2Align-Lite v2',
    slug: 'vox2align_lite_v2',
    inputs: 'mel_feats (B,T,163) float32 + h_backbone (B,T,192) float32 + m27_norm (B,T,27) float32',
    outputs: 'zh_syl_ctc_logits (B,T,415), phone_frame_logits (B,T,65), phone_ctc_logits (B,T,65), boundary_logits (B,T,2), speech_mask_logit (B,T), tone_logits (B,T,8), lang_logits (B,T,3)',
    patterns: 'vox2align / align_v2 / aligner',
    fallback: '卸载后强制对齐与静音门控停用',
  },
  {
    name: 'IPA2Tract-Lite',
    slug: 'ipa2tract_lite',
    inputs: 'cond (B,T,111) float32 + x_base (B,T,26) float32 + alpha (1,) float32',
    outputs: 'x_hat (B,T,26) float32（输出裁剪至 [-1, 1]）',
    patterns: 'ipa2tract / kf2tract / keyframe_tract',
    fallback: '卸载后协同构音自动退回异步 3 阶 qTA 物理基线',
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
    name: 'DPDFNet',
    slug: 'dpdfnet',
    inputs: 'spec (1,1,481,2) float32 + state_in (56436,) float32（校验器检验 1D 浮点张量）',
    outputs: 'spec_e (1,1,481,2) float32 + state_out (56436,) float32',
    patterns: 'dpdfnet / denoise',
    fallback: '卸载后跳过实录前端宽带降噪',
  },
  {
    name: 'Text2Prosody-Lite',
    slug: 'text2prosody_lite',
    inputs: 'phon_feat (B,L,22) + pos_struct (B,L,10) float32 + lang_id, tone_stress_id, punct_id, role_id (B,L) int64',
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
];

export interface TrainingLessonItem {
  id: string;
  category: string;
  title: string;
  finding: string;
  remedy: string;
}

export const TRAINING_EXPERIENCE_HIGHLIGHTS: readonly TrainingLessonItem[] = [
  {
    id: 'les-wavlm-ln',
    category: '底座数值尺度',
    title: 'WavLM 第 24 层未过最终 LayerNorm 引发百万级梯度爆炸',
    finding:
      'transformers 的 outputs.hidden_states[-1] 位于最终 LayerNorm 之前，实测标准差高达 ~43，而 last_hidden_state 仅 ~0.23，导致初版反演损失升至 1,849,684。',
    remedy:
      '用 last_hidden_state 替换末尾层，对全部 25 层先做无参 LayerNorm 再 Softmax 加权，并将第 6 层显式缩放 0.25 与第 24 层对齐，验证损失回到正常量级。',
  },
  {
    id: 'les-inverter-anchor',
    category: '物理锚定防漂移',
    title: 'Vox2Tract-Large 脱离合成锚定在 5,500 步内出现物理坍塌',
    finding:
      '仅靠真实语音加冻结声学代理续训时，验证声学损失表面下降（0.0385 → 0.0357），但模型会利用代理盲区偏离解剖空间，tract17_pcc 从 0.6299 跌至 0.4076，glottis8_pcc 跌至 0.5435。',
    remedy:
      '每步增加 Pass 2（混合一批 180 小时纯合成物理真值，权重 0.045）执行参数域与声学双锚定，逆转漂移并将 tract17_pcc 提升至 0.8200、glottis8_pcc 提升至 0.9040。',
  },
  {
    id: 'les-gan-cosine',
    category: '声码器调度',
    title: '慢指数衰减引发晚期振荡，4,000 步低 LR 余弦精调收敛稳定',
    finding:
      '传统 HiFi-GAN 衰减率 0.999^(1/500) 跑至 28,000 步时学习率仍停留在 1.89e-4，导致 val_mel_l1 在 0.714–0.790 间锯齿震荡。',
    remedy:
      '在 28,000 步切入低学习率余弦精调（5e-5 → 1e-5 仅 4,000 步），在 1,000 步内 val_score 从 0.05310 降至 0.03534，L24 升至 0.8895。',
  },
  {
    id: 'les-perceptual-distill',
    category: '端侧感知蒸馏',
    title: '纯 L1 参数蒸馏会出现参数接近但听感发糊的现象',
    finding:
      '对 27 维物理参数等权回归时，双唇闭塞 LD、鼻咽开度 VO 等窄缝敏感维度的微小误差会引发共振峰偏移，纯 L1 蒸馏版物理重合成 L24 仅 0.7642。',
    remedy:
      '复用冻结的 Tract2Feat-Proxy 双头解码器作为感知教师（8×L24 + 6×L6），约束 7.64M 学生在声学流形对齐，8 句物理重合成均值升至 0.8235（8 句均值 3.06 s PyTorch CPU FP16 4 线程评测耗时 80.2 ms；导出 ONNX Runtime 3.0 s 前向均值 22.5 ms）。',
  },
  {
    id: 'les-legacy-detach',
    category: '多代语料融合',
    title: '旧版固定声门语料回传梯度会干扰 8 维发声态分化',
    finding:
      '早期 90h 22 维语料将 XT/LAG/PS/FL/SHIM 固定为常数，直接与 180h 联合送入声学解码器会诱导声门分支学会平庸均值。',
    remedy:
      '对旧语料声门损失施加选择性掩码 [0.25, 0, 0.25, 0, 0.25, 0, 0, 0]，并在送入冻结解码器前对旧语料预测的声门向量执行 .detach() 阻断梯度回传。',
  },
  {
    id: 'les-bn-freeze',
    category: '冻结分支保护',
    title: '冻结分支的 BatchNorm 滑动统计量会在 train() 下发生漂移',
    finding:
      'ConformerConvModule 含 BatchNorm1d，对混合模型调用 .train() 会把已冻结子分支切回训练态并持续覆盖 running_mean / running_var。',
    remedy:
      '覆写模型的 train() 方法锁定冻结分支处于 eval() 状态；同时在消融实验证实冻声道专训声门为负收益后于 3,550 步及时止损。',
  },
  {
    id: 'les-ja-clamp',
    category: '协同构音防扁平',
    title: '限制下颌张度残差上界防止舌体代偿压扁开口度',
    finding:
      '由于下颌与舌体存在多对一补偿效应，教师反演模型偏爱保守的下颌波动，直接照搬会使合成开口偏小。',
    remedy:
      '在 IPA2Tract-Lite 零初始化残差头中将下颌张度 JA 最大残差单独限幅在 0.35（其余维度 0.85），保留协同柔顺度的同时守住标准开合幅度。',
  },
  {
    id: 'les-static-pcc',
    category: '评测指标陷阱',
    title: '极低方差静态持续音会导致皮尔逊相关系数 PCC 假性偏低',
    finding:
      '五态连续渐变长元音 /a/ 的物理重合成声学 L24 达 0.8643、L6 达 0.8429，但固定舌位导致教师轨迹方差近零，tract17_pcc 账面仅 0.1638。',
    remedy:
      '对静止或准静止测试片段不可单凭帧间线性相关下结论，需联合核验物理 RMSE、物理/神经重合成声学余弦与听感评测。',
  },
  {
    id: 'les-high-f0',
    category: '声乐极高音边界',
    title: '女高音花腔越过 600 Hz 物理上界引发截断与相位外推失真',
    finding:
      'GTSinger、M4Singer 与 VocalSet 中存在大量 550–800+ Hz 哨音切片，直接送入 27 维物理契约会产生基频饱和截断。',
    remedy:
      '在流式采样池、共享缓存与神经声码器训练中统一滤除 P95(F0) > 550 Hz 的切片（跳过 3,604 / 1,328 条），同时在科研工作台用独立高音试听接口承载 550–800 Hz 移调。',
  },
  {
    id: 'les-render-flow',
    category: '物理渲染与防爆音',
    title: '梯形累计流积分防止气流倒流，软门控避免清辅音误带声',
    finding:
      '直接用瞬时声门压乘时间计算粒子位置在句末肺压骤降时会出现视觉气流倒流；节点突变与无门控调制会引起清擦音带声或咔嗒瞬态。',
    remedy:
      '改用单调递增梯形累计流函数驱动气流粒子；调音台默认开启清浊音软门控与 25 ms 高斯平滑，双人器官移植中舌颌与喉位采用相对中位偏移移植。',
  },
];

export interface RetrainingRecipe {
  id: string;
  scenario: string;
  difficulty: '推荐入门 · 小时级' | '进阶扩展 · 半天级' | '全流程复现 · 多日级';
  targetModels: string;
  corpusReq: string;
  steps: string[];
  commands: string;
}

export const RETRAINING_RECIPES: readonly RetrainingRecipe[] = [
  {
    id: 'rec-align-prosody',
    scenario: '场景 A · 扩展新方言、新语种或专业朗读风格（对齐与韵律微调）',
    difficulty: '推荐入门 · 小时级',
    targetModels: 'Text2Prosody-Lite (1.98M) + Vox2Align-Lite v2 (4.33M)',
    corpusReq: '16 kHz 单声道 WAV + 对应 Praat TextGrid（音素与音节层），建议 3–20 小时，单卡 8–16 GB VRAM 即可。',
    steps: [
      '将新语料的音素映射至 65 维统一双语/扩展 IPA 词表（或按需扩充映射表），并用 SwiftF0 提取 50 Hz 基频。',
      '执行质量门控过滤漂移标注（剔除元音无声段漂移、异常语速与过短塌缩音段），保持约 15% 跨语种拼接与 45% 首尾底噪增广。',
      '以现有权重热启动微调（学习率 1e-4 余弦退火，5,000–10,000 步），完成后运行 scripts/export_onnx_models.py 导出动态轴 ONNX。',
      '在设置页「本地轻量化模型矩阵」点击对应卡片的「换模」，系统自动核验张量契约并即时生效。',
    ],
    commands: `# 1. 构建/追加双语对齐与韵律数据索引\npython -B scripts/prepare_vox2align_v2_dataset.py\npython -B scripts/filter_mfa_and_build_prosody.py\n\n# 2. 微调 Text2Prosody-Lite 与 Vox2Align-Lite v2（支持 --resume）\npython -B scripts/train_text2prosody.py --steps 12000 --batch-size 64 --resume\npython -B scripts/train_vox2align_v2.py --steps 20000 --batch-size 48 --resume\n\n# 3. 导出纯 ONNX 并自检数值精度（可先用 --mode benchmark 对比耗时）\npython -B scripts/export_onnx_models.py --mode finalize`,
  },
  {
    id: 'rec-lite-distill',
    scenario: '场景 B · 用更多歌唱/方言/特殊发声态语料扩训反演器与神经声码器',
    difficulty: '进阶扩展 · 半天级',
    targetModels: 'Vox2Tract-Lite (7.64M) + Vox2Spk-Lite (2.90M) + Tract2Vox-Lite (3.72M)',
    corpusReq: '16 kHz 干声语料（自动过滤 P95(F0) > 550 Hz），强烈建议保留 ≥12%（声码器）至 35%（反演器）的 VTL 180h 合成真值作为物理锚定！',
    steps: [
      '使用 Vox2Tract-Large + Vox2Tract-PR 离线为新语料生成共享 50 Hz 27 维伪标签与 512 维声纹分片缓存（避免训练期加载 1.2 GB WavLM）。',
      '在 Vox2Tract-Lite 蒸馏中保留冻结 Tract2Feat-Proxy 感知损失（8×L24 + 6×L6）与 35% 物理合成锚定，防止反演器遗忘物理几何。',
      '在 Tract2Vox-Lite 训练后期（约 15k–20k 步后）切入低学习率余弦精调（5e-5 → 1e-5），并在导出前执行 remove_weight_norm() 与噪声外置化。',
      '导出后的 vox2tract_lite.onnx / vox2spk_lite.onnx / tract2vox_lite.onnx 放入同一目录，点击界面「从文件夹装载」即可整套热切换。',
    ],
    commands: `# 1. 一键更新共享教师缓存并串行蒸馏端侧三件套\npowershell -ExecutionPolicy Bypass -File .\\run_browser_m27_overnight.ps1 \`\n  -NatShards 120 -Stage4Steps 55000 -SpkSteps 30000 -Stage5Steps 25000 -Resume\n\n# 2. 若需单独微调声码器并执行基准对比与最终导出\npython -B scripts/train_browser_m27_stage5.py --steps 25000 --resume\npython -B scripts/export_onnx_models.py --mode benchmark\npython -B scripts/export_onnx_models.py --mode finalize`,
  },
  {
    id: 'rec-full-scratch',
    scenario: '场景 C · 从零构建 VTL 物理语料与教师大模型体系',
    difficulty: '全流程复现 · 多日级',
    targetModels: '关联体系（原型状态库 → 180h 合成 → 教师链 4 模 → 端侧 7 模）',
    corpusReq: '24 GB VRAM GPU（如 RTX 4090 / 5090）+ 64 GB 系统内存 + 100 GB 可用磁盘；第三方公开语料按原协议自行下载。',
    steps: [
      '运行 build_states.py 生成 459 个 JD2 R21 声道原型，并用 generate_synth_m27.py 20 进程生成 180 小时 8 发声态全原生 27 维合成语料。',
      '依次完成 Vox2Tract-PR 肺压编码器（30k）→ Tract2Feat-Proxy 双头声学代理（50k）→ Vox2Tract-Large 合成预热（45k）。',
      '执行 Vox2Tract-Large 双通物理锚定微调（32k）与 Tract2Vox-Large Glottis-NSF v3 声码器（28k 主训 + 4k 低 LR 余弦精调），再用 train_tube_proxy.py 与 run_train_kf.ps1 完成协同动腔规划链路。',
    ],
    commands: `# 1. 构造状态库与 180h 多发声态物理合成库\npython -B scripts/build_states.py --out data/states/states_jd2_r21.npz\npowershell -ExecutionPolicy Bypass -File .\\run_generate_m27.ps1 -Hours 180 -Workers 20 -TubeHz 100\n\n# 2. 教师五阶段主链路（肺压 -> 声学代理 -> 合成预热 -> 双通锚定 -> 神经声码器）\npython -B scripts/train_m27_pipeline.py --stage pr --batch-size 64 --pr-steps 30000\npython -B scripts/train_m27_pipeline.py --stage decoder --batch-size 64 --decoder-steps 50000\npython -B scripts/train_m27_pipeline.py --stage motor-synth --batch-size 64 --motor-steps 45000\n# Vox2Tract-Large 双通锚定微调与 Tract2Vox-Large 低学习率余弦精调\npowershell -ExecutionPolicy Bypass -File .\\run_train_m27.ps1 -Stage motor-natural -NaturalSteps 32000 -ResetNaturalSchedule\npowershell -ExecutionPolicy Bypass -File .\\run_train_m27_neural_synth.ps1 -MaxSteps 32000 -Lr 5e-5 -OverrideLr\n\n# 3. 管面积代理与 IPA2Tract-Lite 协同动腔规划\npython -B scripts/train_tube_proxy.py --num-samples 300000 --workers 16\npowershell -ExecutionPolicy Bypass -File .\\run_train_kf.ps1 -Step k1 -K1Steps 15000\npowershell -ExecutionPolicy Bypass -File .\\run_expand_k2_v2.ps1`,
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
    purpose: '查询全部 9 个 ONNX 模型槽位状态、参数量、内存驻留与外置来源',
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
    payload: '{ "name": "Tract2Vox-Lite" } 或 { "all": true }',
  },
  {
    method: 'POST',
    path: '/api/models/local/mount',
    purpose: '按本机磁盘路径挂载单个 .onnx 或递归扫描目录（最大深度 2）批量匹配装载（上限 256 MiB）',
    payload: '单文件：{ "path": "D:\\\\m.onnx", "name"?: "slot" }；目录：{ "folder": "D:\\\\models", "mount": true }',
  },
  {
    method: 'POST',
    path: '/api/models/local/mount-binary',
    purpose: '接收浏览器上传的 .onnx 二进制流，自动校验契约并暂存至 .cache/custom-models/（受 HTTP 代理包体限制）',
    payload: 'Query: ?filename=custom.onnx&name=<slot>（name 可选，缺省按契约自动匹配），Body: octet-stream（1 KB – 64 MiB）',
  },
  {
    method: 'POST',
    path: '/api/models/local/reset',
    purpose: '解除外置覆盖，恢复对应槽位或全部 9 槽位为随包内置默认 ONNX 权重',
    payload: '{ "name": "Vox2Tract-Lite" } 或 { "all": true }',
  },
];

export function buildTrainingReportMarkdown(): string {
  const lines: string[] = [
    `# ${APP_BRAND_NAME} · 模型训练与技术报告`,
    '',
    `> 文档版本：${MODEL_TRAINING_REPORT_META.version}`,
    `> 模型体系：${MODEL_TRAINING_REPORT_META.suiteName}`,
    `> ${MODEL_TRAINING_REPORT_META.flagshipLineage}`,
    `> 统一解剖基准：${MODEL_TRAINING_REPORT_META.geometryStandard}`,
    `> 计算与推理环境：${MODEL_TRAINING_REPORT_META.hardwareEnv}`,
    '',
    '## 1. 关联模型总表（Model Zoo · 14 项）',
    '',
    '| 官方模型名 | 层级 | 核心架构 | 参数量 | 权重体积 | 训练步数与周期 | 核心实测指标 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...FULL_MODEL_ZOO.map(
      (m) => `| ${m.name} | ${m.tier} | ${m.arch} | ${m.params} | ${m.weightSize} | ${m.schedule} | ${m.metrics} |`,
    ),
    '',
    `> 本地纯 ONNX 运行时矩阵共 ${LOCAL_MODEL_TOTALS.count} 个模型，合计 **${LOCAL_MODEL_TOTALS.totalParamsText}** 参数（ONNX initializer 实测 27.62 M）、**${LOCAL_MODEL_TOTALS.totalSizeText}**（十进制约 61.82 MB），无 PyTorch 运行时依赖。`,
    `> 延迟测量口径：${MODEL_TRAINING_REPORT_META.cpuBenchmarkProtocol}`,
    '',
    '## 2. 27 维声道—声门物理控制空间契约（Native 27D v1）',
    '',
    '| 下标 | 参数 | 分组 | 下界 | 上界 | 单位 | 归一化 | 生理与声学意义 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...M27_PARAMETER_SPECS.map(
      (p) => `| ${p.idx} | ${p.code} | ${p.group} | ${p.min} | ${p.max} | ${p.unit} | ${p.norm} | ${p.meaning} |`,
    ),
    '',
    '## 3. 全量训练数据集清单',
    '',
    '| 语料/数据集 | 类别 | 规模 | 时长 / 构成 | 使用模型 | 说明 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...FULL_CORPUS_INVENTORY.map(
      (c) => `| ${c.name} | ${c.category} | ${c.scale} | ${c.durationOrSpk} | ${c.usedBy} | ${c.notes} |`,
    ),
    '',
    '## 4. 关键训练经验与工程复盘（10 项记录）',
    '',
    ...TRAINING_EXPERIENCE_HIGHLIGHTS.map(
      (item, idx) =>
        `${idx + 1}. **【${item.category}】${item.title}**\n   - 现象与根因：${item.finding}\n   - 解决策略：${item.remedy}`,
    ),
    '',
    '## 5. 9 个 ONNX 槽位输入输出张量契约',
    '',
    '| 槽位名称 | 输入张量契约 | 输出张量契约 | 文件名匹配关键词 | 卸载降级行为 |',
    '| --- | --- | --- | --- | --- |',
    ...ONNX_SLOT_CONTRACTS.map(
      (c) => `| ${c.name} | \`${c.inputs}\` | \`${c.outputs}\` | \`${c.patterns}\` | ${c.fallback} |`,
    ),
    '',
    '## 6. 使用更多语料二次训练与自定义换模指南',
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
    '## 7. 生成引擎与本地 ONNX 热插拔装载接口',
    '',
    '| 方法 | 端点 | 用途 | 请求/响应说明 |',
    '| --- | --- | --- | --- |',
    ...ENGINE_LOADING_ENDPOINTS.map(
      (e) => `| \`${e.method}\` | \`${e.path}\` | ${e.purpose} | ${e.payload} |`,
    ),
  ];
  return lines.join('\n');
}
