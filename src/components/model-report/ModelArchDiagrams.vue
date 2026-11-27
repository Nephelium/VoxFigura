<script setup lang="ts">
import { computed, ref } from 'vue';
import IconSvg from '@/components/common/IconSvg.vue';

type NodeKind = 'io' | 'cnn' | 'attn' | 'rnn' | 'phys' | 'out';

interface ArchNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  lines: string[];
  kind: NodeKind;
  tag?: string;
}

interface ArchEdge {
  d: string;
  label?: string;
  lx?: number;
  ly?: number;
  dashed?: boolean;
  accent?: boolean;
}

interface ArchDiagramSpec {
  id: string;
  shortTitle: string;
  title: string;
  badge: string;
  summary: string;
  designNote: string;
  width: number;
  height: number;
  nodes: ArchNode[];
  edges: ArchEdge[];
}

const LEGEND_ITEMS: ReadonlyArray<{ kind: NodeKind; label: string }> = [
  { kind: 'io', label: '输入 / 条件特征' },
  { kind: 'cnn', label: 'CNN / ConvNeXt / Res2' },
  { kind: 'attn', label: 'Conformer / 注意力' },
  { kind: 'rnn', label: 'BiLSTM / BiGRU' },
  { kind: 'phys', label: '物理声源 / 声道守卫' },
  { kind: 'out', label: '融合 / 输出头' },
];

const DIAGRAMS: readonly ArchDiagramSpec[] = [
  {
    id: 'v4-joint',
    shortTitle: 'Vox2TractAlign v4',
    title: '阶段 1 · Vox2TractAlign v4（共享主干多任务联合反演 + 双语强制对齐）',
    badge: '9.40 M · Conformer + BiLSTM + ConvNeXt + BiGRU',
    summary:
      '将旧版声道反演与音素对齐合并为单共享主干，纯 CPU 3 秒音频 ONNX 延迟 24.3 ms；前向不输入文字，同时支持盲切与 Viterbi 有文字引导强制对齐。',
    designNote:
      'CNN 捕获毫秒级爆破瞬态，6 层 Conformer 捕获数百毫秒协同发音，尾部 BiLSTM/BiGRU 保帧间平滑；右侧 243 维高频 Mel 旁路避免平滑主干削钝 /f, s, ɕ/ 清擦音边界。',
    width: 980,
    height: 770,
    nodes: [
      {
        id: 'in_main',
        x: 40,
        y: 22,
        w: 360,
        h: 72,
        kind: 'io',
        tag: '50 Hz',
        title: '声学前端主输入 (167 维)',
        lines: ['80 Mel + 80 Δ + 3 能量 (163D)', '+ 3D 声质线索 VQ + 1D 宽域 F0 (20–1200 Hz)'],
      },
      {
        id: 'in_dd',
        x: 430,
        y: 22,
        w: 255,
        h: 72,
        kind: 'io',
        tag: '瞬态',
        title: '80 维 ΔΔ 二阶差分',
        lines: ['显式捕捉塞音爆破冲激', '与清擦音起止瞬态变化'],
      },
      {
        id: 'in_hf',
        x: 715,
        y: 22,
        w: 230,
        h: 72,
        kind: 'io',
        tag: '高频旁路',
        title: '243 维 Mel+Δ+ΔΔ',
        lines: ['直通对齐支路', '保护 /f, s, ɕ/ 边界锐利度'],
      },
      {
        id: 'stem_main',
        x: 75,
        y: 122,
        w: 290,
        h: 54,
        kind: 'cnn',
        title: '主干 Stem · 2× Conv1d',
        lines: ['k=5, k=3 → 192 维'],
      },
      {
        id: 'stem_dd',
        x: 430,
        y: 122,
        w: 255,
        h: 54,
        kind: 'cnn',
        title: '零初始化残差 Stem',
        lines: ['2× Conv1d (k=3→96, k=1→192)'],
      },
      {
        id: 'res_add',
        x: 195,
        y: 204,
        w: 360,
        h: 44,
        kind: 'out',
        title: '残差相加 + LayerNorm (192 维)',
        lines: ['零初值保障热启稳定性'],
      },
      {
        id: 'backbone',
        x: 145,
        y: 276,
        w: 460,
        h: 64,
        kind: 'attn',
        tag: '共享主干',
        title: '6× ConformerBlock (dim=192, heads=4)',
        lines: ['conv_k=31, ff_mult=4 · Macaron FFN + 相对位置自注意力 + 深度卷积'],
      },
      {
        id: 'pr_head',
        x: 270,
        y: 368,
        w: 220,
        h: 56,
        kind: 'cnn',
        tag: 'PR 1D',
        title: '肺压分支 PR Head',
        lines: ['3× Conv1d (k=5,3,1) + tanh'],
      },
      {
        id: 'tract_rnn',
        x: 36,
        y: 466,
        w: 224,
        h: 64,
        kind: 'rnn',
        tag: '声道支路',
        title: '1 层双向 BiLSTM',
        lines: ['hidden=192×2 → 384D', 'Conv1d(k=1) + tanh → T17'],
      },
      {
        id: 'glottis_blk',
        x: 288,
        y: 454,
        w: 320,
        h: 88,
        kind: 'rnn',
        tag: '声门支路',
        title: '声门条件拼接 → ConvNeXt + BiLSTM',
        lines: ['concat(h, F0, PR, VQ) → Conv1d(k=1→128)', '2× ConvNeXt1D(k=15, exp=3) + BiLSTM(128×2)', 'Conv1d(k=1) + tanh → 8D 声门 G8'],
      },
      {
        id: 'align_stem',
        x: 715,
        y: 466,
        w: 230,
        h: 64,
        kind: 'cnn',
        title: 'Align Mel Stem',
        lines: ['2× Conv1d (k=5, k=3 → 192D)', '保留高频瞬态能量'],
      },
      {
        id: 'prior_fuse',
        x: 260,
        y: 576,
        w: 390,
        h: 56,
        kind: 'phys',
        tag: '物理先验',
        title: '声道/声门先验门控融合',
        lines: ['Linear(192+27 → 192) + 可学习 Gate × Align Stem'],
      },
      {
        id: 'align_enc',
        x: 260,
        y: 660,
        w: 390,
        h: 54,
        kind: 'attn',
        title: '对齐编码器 · 1× Conformer + BiGRU(144×2)',
        lines: ['输出 288D 对齐表征'],
      },
      {
        id: 'out_m27',
        x: 36,
        y: 660,
        w: 196,
        h: 86,
        kind: 'out',
        tag: '输出 1',
        title: '27 维物理轨迹 M27',
        lines: ['17D 声道 T17', '+ 宽域 F0 + PR', '+ 8D 声门 G8'],
      },
      {
        id: 'out_align',
        x: 682,
        y: 660,
        w: 263,
        h: 86,
        kind: 'out',
        tag: '输出 2',
        title: '7 路对齐输出头',
        lines: ['中/英音素 CTC · 声母/韵母', '帧级边界概率 · 静音门控', '后接 Viterbi 强制对齐 / 盲切'],
      },
    ],
    edges: [
      { d: 'M 220 94 L 220 122' },
      { d: 'M 557 94 L 557 122' },
      { d: 'M 220 176 L 220 190 L 320 190 L 320 204' },
      { d: 'M 557 176 L 557 190 L 430 190 L 430 204' },
      { d: 'M 375 248 L 375 276' },
      // backbone to PR, Tract, Glottis
      { d: 'M 375 340 L 375 368' },
      { d: 'M 220 340 L 220 400 L 148 400 L 148 466' },
      { d: 'M 440 340 L 440 434 L 448 434 L 448 454' },
      // PR to Glottis
      { d: 'M 380 424 L 380 454', accent: true, label: 'PR', lx: 388, ly: 443 },
      // Tract & Glottis to M27 Output and Prior Fusion
      { d: 'M 110 530 L 110 660', accent: true },
      { d: 'M 176 530 L 176 558 L 350 558 L 350 576' },
      { d: 'M 448 542 L 448 576' },
      { d: 'M 330 542 L 330 604 L 160 604 L 160 660', dashed: true },
      // High-freq bypass
      { d: 'M 830 94 L 830 466', accent: true },
      { d: 'M 830 530 L 830 604 L 650 604', accent: true },
      // Prior fusion to align encoder to 7-head output
      { d: 'M 455 632 L 455 660' },
      { d: 'M 650 688 L 682 688', accent: true },
    ],
  },
  {
    id: 't2v-nsf',
    shortTitle: 'Tract2Vox-Large v2.1 / Lite v3',
    title: '阶段 3 · Tract2Vox-Large v2.1 (14.39 M) / Lite v3 (3.73 M · 声门感知 NSF 声码器)',
    badge: '纯 CNN + float64 物理声源 · 320× 四级上采样',
    summary:
      '全系统唯一完全无 RNN 与 Transformer 的纯 CNN + 物理声源混合架构，通过 4 级反卷积（8×5×4×2 = 320×）将 50 Hz 27 维控制流重建为 16 kHz 连续波形。',
    designNote:
      '物理声源以 float64 连续相位积分，保证 20 Hz 嘎裂与 1200 Hz 超高音零相位溢出、不生金属电音；音色 FiLM（前 2 级）与声门 FiLM（后 3 级）分级解耦互不干扰。',
    width: 980,
    height: 750,
    nodes: [
      {
        id: 'in_m27',
        x: 340,
        y: 22,
        w: 300,
        h: 64,
        kind: 'io',
        tag: '输入 1',
        title: '50 Hz 27 维控制流 M27',
        lines: ['17D 声道 + 宽域 F0 + PR + 8D 声门'],
      },
      {
        id: 'in_spk',
        x: 684,
        y: 22,
        w: 262,
        h: 64,
        kind: 'io',
        tag: '输入 2',
        title: '512 维音色声纹向量',
        lines: ['来自 Vox2Spk-v2.1 单位球面嵌入'],
      },
      {
        id: 'source_mod',
        x: 30,
        y: 126,
        w: 312,
        h: 146,
        kind: 'phys',
        tag: '物理激励',
        title: 'GlottisAwareSourceModule v4',
        lines: [
          '2× Conv1d(10→48) + 5 路物理激励控制头',
          'float64 连续相位积分 cumsum（绝不溢出）',
          '通道 0：12 阶谐波 + 1/2 & 1/3 亚谐波',
          '       + 相位锁定嘎裂脉冲 + FL/SHIM 抖动',
          '通道 1：宽带噪声 + 声门缝隙高通气噪',
        ],
      },
      {
        id: 'conv_pre',
        x: 378,
        y: 118,
        w: 264,
        h: 54,
        kind: 'cnn',
        title: 'conv_pre · Conv1d (k=7)',
        lines: ['27 → 512 (Large) / 256 (Lite)'],
      },
      {
        id: 'spk_proj',
        x: 684,
        y: 118,
        w: 262,
        h: 54,
        kind: 'out',
        title: 'spk_proj · 2× Linear + LN + SiLU',
        lines: ['512 → 128 → 128 静态音色条件'],
      },
      {
        id: 'cond_fuse',
        x: 378,
        y: 204,
        w: 294,
        h: 54,
        kind: 'cnn',
        title: 'cond_fuse · 拼接音色 + Conv1d(k=1)',
        lines: ['(512/256 + 128) → 512 / 256'],
      },
      {
        id: 'glottis_enc',
        x: 716,
        y: 296,
        w: 234,
        h: 68,
        kind: 'phys',
        tag: '逐帧调制',
        title: '声门编码器 glottis_enc',
        lines: ['2× Conv1d (10→64→64, k=3)', '提取逐帧发声态动态条件'],
      },
      {
        id: 'up0',
        x: 342,
        y: 296,
        w: 344,
        h: 68,
        kind: 'cnn',
        tag: '×8',
        title: '上采样级 0 · ConvTranspose1d (k=16)',
        lines: ['512→256 (Lite 256→128) + 声源注入 Conv1d', '+ 音色 FiLM (Linear) + MRF (k=3,7,11)'],
      },
      {
        id: 'up1',
        x: 342,
        y: 394,
        w: 344,
        h: 68,
        kind: 'cnn',
        tag: '×5',
        title: '上采样级 1 · ConvTranspose1d (k=11)',
        lines: ['256→128 (Lite 128→64) + 声源注入', '+ 音色 FiLM + 声门 FiLM (Conv1d) + MRF'],
      },
      {
        id: 'up2',
        x: 342,
        y: 492,
        w: 344,
        h: 62,
        kind: 'cnn',
        tag: '×4',
        title: '上采样级 2 · ConvTranspose1d (k=8)',
        lines: ['128→64 (Lite 64→32) + 声源 + 声门 FiLM + MRF'],
      },
      {
        id: 'up3',
        x: 342,
        y: 584,
        w: 344,
        h: 62,
        kind: 'cnn',
        tag: '×2',
        title: '上采样级 3 · ConvTranspose1d (k=4)',
        lines: ['64→32 (Lite 32→16) + 声源 + 声门 FiLM + MRF'],
      },
      {
        id: 'conv_post',
        x: 378,
        y: 676,
        w: 272,
        h: 54,
        kind: 'out',
        tag: '16 kHz',
        title: 'conv_post · Conv1d (k=7) + tanh',
        lines: ['输出 16 kHz 连续波形（密轨重采样 48 kHz）'],
      },
    ],
    edges: [
      // M27 splits into source_mod, conv_pre, and glottis_enc
      { d: 'M 490 86 L 490 118' },
      { d: 'M 390 86 L 390 102 L 186 102 L 186 126', accent: true },
      { d: 'M 595 86 L 595 102 L 664 102 L 664 274 L 833 274 L 833 296', dashed: true, label: '10D 发声态', lx: 730, ly: 267 },
      // spk_proj into cond_fuse and Stage 0/1 FiLM
      { d: 'M 815 86 L 815 118' },
      { d: 'M 815 172 L 815 231 L 672 231' },
      // conv_pre -> cond_fuse -> up0 -> up1 -> up2 -> up3 -> conv_post
      { d: 'M 510 172 L 510 204' },
      { d: 'M 514 258 L 514 296' },
      { d: 'M 514 364 L 514 394' },
      { d: 'M 514 462 L 514 492' },
      { d: 'M 514 554 L 514 584' },
      { d: 'M 514 646 L 514 676' },
      // Source injection bus into up0, up1, up2, up3
      { d: 'M 186 272 L 186 615 L 342 615', accent: true },
      { d: 'M 186 330 L 342 330', accent: true, label: '物理声源注入', lx: 204, ly: 322 },
      { d: 'M 186 428 L 342 428', accent: true },
      { d: 'M 186 523 L 342 523', accent: true },
      // Glottis FiLM bus into up1, up2, up3
      { d: 'M 833 364 L 833 615 L 686 615', accent: true },
      { d: 'M 833 428 L 686 428', accent: true, label: '声门 FiLM', lx: 722, ly: 420 },
      { d: 'M 833 523 L 686 523', accent: true },
    ],
  },
  {
    id: 'vox2spk',
    shortTitle: 'Vox2Spk-v2.1',
    title: '独立解耦 · Vox2Spk-v2.1（高区分度跨音域 ECAPA-TDNN 声纹编码器）',
    badge: '4.60 M · 纯 CNN + SE-Res2Block + ASP 统计池化',
    summary:
      '对齐 WavLM-SV 512 维单位球面嵌入空间，在逐样本蒸馏外引入关系矩阵 KD 与非对称负对排斥，同时兼顾常规人声辨识度与女高音歌唱音色稳定。',
    designNote:
      '输入 80 维 Slaney Log-Mel 仅做均值倒谱归一化（CMN）以保留共振峰包络差异；多尺度空洞卷积覆盖不同帧窗长，推理纯 CPU 仅需 4.3 ms。',
    width: 980,
    height: 490,
    nodes: [
      {
        id: 'mel_in',
        x: 34,
        y: 52,
        w: 224,
        h: 72,
        kind: 'io',
        tag: 'ONNX 输入',
        title: '50 Hz CMN 80-Mel',
        lines: ['16 kHz → Slaney Log-Mel (B, 80, T)', '仅均值归一化，保留共振峰能量'],
      },
      {
        id: 'tdnn_stem',
        x: 34,
        y: 158,
        w: 224,
        h: 60,
        kind: 'cnn',
        title: 'TDNN Stem · Conv1d',
        lines: ['80 → 512 (k=5) + ReLU + BN'],
      },
      {
        id: 'res2_1',
        x: 314,
        y: 34,
        w: 280,
        h: 64,
        kind: 'cnn',
        tag: 'Block 1',
        title: 'SE-Res2Block #1 (C=512)',
        lines: ['k=3, dilation=2, scale=4 + SE 通道注意力'],
      },
      {
        id: 'res2_2',
        x: 314,
        y: 132,
        w: 280,
        h: 64,
        kind: 'cnn',
        tag: 'Block 2',
        title: 'SE-Res2Block #2 (C=512)',
        lines: ['k=3, dilation=3, scale=4 + SE 通道注意力'],
      },
      {
        id: 'res2_3',
        x: 314,
        y: 230,
        w: 280,
        h: 64,
        kind: 'cnn',
        tag: 'Block 3',
        title: 'SE-Res2Block #3 (C=512)',
        lines: ['k=3, dilation=4, scale=4 + SE 通道注意力'],
      },
      {
        id: 'mfa',
        x: 660,
        y: 94,
        w: 284,
        h: 66,
        kind: 'cnn',
        tag: '多尺度聚合',
        title: 'MFA 多层特征聚合',
        lines: ['拼接 3 层输出 (1536D) → Conv1d(k=1 → 640D)'],
      },
      {
        id: 'asp',
        x: 660,
        y: 194,
        w: 284,
        h: 72,
        kind: 'attn',
        tag: '统计池化',
        title: 'ASP 注意力统计池化',
        lines: ['帧级注意力权重 → 加权均值 μ + 标准差 σ', '变长音频压缩为定长 1280 维向量'],
      },
      {
        id: 'proj_out',
        x: 660,
        y: 300,
        w: 284,
        h: 72,
        kind: 'out',
        tag: '512D 球面',
        title: 'Linear(1280→512) + BN + L2 Norm',
        lines: ['输出 512 维单位球面说话人声纹嵌入', '实时参考声纹 + 自动中位基频匹配'],
      },
      {
        id: 'distill_note',
        x: 34,
        y: 344,
        w: 560,
        h: 112,
        kind: 'phys',
        tag: 'v2.1 区分度目标',
        title: '关系矩阵蒸馏与非对称负对排斥（仅训练期）',
        lines: [
          '• 教师对齐：WavLM-Base-Plus-SV 512D 逐样本余弦蒸馏 (cos=0.9422)',
          '• 关系几何：Batch 相似度 Gram 矩阵 MSE，防止不同说话人向球面均值坍缩',
          '• 负对排斥：惩罚学生异人相似度超过教师边界 + 跨空间 S→T InfoNCE',
        ],
      },
    ],
    edges: [
      { d: 'M 146 124 L 146 158' },
      { d: 'M 258 188 L 286 188 L 286 66 L 314 66' },
      { d: 'M 454 98 L 454 132' },
      { d: 'M 454 196 L 454 230' },
      // Multi-scale skips into MFA
      { d: 'M 594 66 L 626 66 L 626 112 L 660 112', accent: true },
      { d: 'M 594 164 L 626 164 L 626 127 L 660 127', accent: true },
      { d: 'M 594 262 L 626 262 L 626 142 L 660 142', accent: true },
      // MFA -> ASP -> Output
      { d: 'M 802 160 L 802 194' },
      { d: 'M 802 266 L 802 300' },
      // Training loss dashed link
      { d: 'M 594 400 L 802 400 L 802 372', dashed: true, label: '训练期约束', lx: 648, ly: 392 },
    ],
  },
  {
    id: 'ipa2tract',
    shortTitle: 'IPA2Tract-Lite v4',
    title: '阶段 2B · IPA2Tract-Lite v4（32D 窄标协同构音规划 + 截面积守卫）',
    badge: '4.23 M · 零初始化残差 Conformer + BiGRU',
    summary:
      '在三阶临界阻尼目标逼近（qTA）物理基线之上预测自然协同发音残差，配套 293 键窄标构型库，支持通过协同强度 α 连续调节“字正腔圆”与“流利协同”。',
    designNote:
      '未约束器官通道严格置零保证零上下文泄漏（max_abs_diff = 0.0）；训练期挂载冻结的 Tract2Area-Proxy (0.23 M) 实时监控 6 区最小截面积，防止闭塞漏气与穿模。',
    width: 980,
    height: 580,
    nodes: [
      {
        id: 'cond_121',
        x: 34,
        y: 26,
        w: 584,
        h: 80,
        kind: 'io',
        tag: '121 维帧级条件',
        title: '窄标构音多源帧级条件拼接',
        lines: [
          'x_base(26) + g_masked(26) + w_mask(26) + F0(1) + 相位(5) + 阻塞(4)',
          '+ 32 维通用窄标 IPA 发音特征 + has_phon(1) · 配套 293 键窄标构型库',
        ],
      },
      {
        id: 'qta_base',
        x: 660,
        y: 26,
        w: 286,
        h: 80,
        kind: 'phys',
        tag: '物理基线',
        title: '三阶临界阻尼 qTA 基线',
        lines: ['由关键帧构型平滑生成 x_base (26D)', '保证无神经介入时仍具严谨物理下界'],
      },
      {
        id: 'in_proj',
        x: 106,
        y: 138,
        w: 440,
        h: 54,
        kind: 'cnn',
        title: '局部感受野前端 · Linear(121→192) + Conv1d(k=5)',
        lines: ['编码音素过渡窗内的邻近协同上下文'],
      },
      {
        id: 'conf4',
        x: 106,
        y: 222,
        w: 440,
        h: 60,
        kind: 'attn',
        tag: '主干',
        title: '4× ConformerBlock (dim=192, heads=4, conv_k=15)',
        lines: ['建模跨音节协同发音（如圆唇提前、鼻化蔓延）'],
      },
      {
        id: 'bigru',
        x: 106,
        y: 312,
        w: 440,
        h: 54,
        kind: 'rnn',
        title: '1 层双向 BiGRU (hidden=192×2 → 384D)',
        lines: ['保证声道关节连续平滑运动'],
      },
      {
        id: 'head_t',
        x: 44,
        y: 398,
        w: 260,
        h: 64,
        kind: 'out',
        tag: '零初始化',
        title: '声道残差头 (17D)',
        lines: ['常规限幅 ±0.85 · 下颌 JA 限幅 ±0.35'],
      },
      {
        id: 'head_s',
        x: 348,
        y: 398,
        w: 260,
        h: 64,
        kind: 'out',
        tag: '零初始化',
        title: '声源残差头 (9D)',
        lines: ['肺压 PR + 8 维声门协同动态残差'],
      },
      {
        id: 'res_out',
        x: 180,
        y: 496,
        w: 416,
        h: 62,
        kind: 'out',
        tag: '输出 26D',
        title: '物理残差合成 · clamp(x_base + α · Δ, -1, 1)',
        lines: ['α 为可调协同强度滑块，直接驱动 VTL 2.4 与 Tract2Vox'],
      },
      {
        id: 'area_proxy',
        x: 660,
        y: 468,
        w: 286,
        h: 90,
        kind: 'phys',
        tag: '0.23 M 物理守卫',
        title: 'Tract2Area-Proxy (冻结 MLP)',
        lines: [
          '17D 声道 → 6 区最小截面积实时代理',
          '（全口腔 / 双唇 / 舌冠 / 舌背 / 咽腔 / 唇口）',
          '约束闭塞成阻与声道防穿模',
        ],
      },
    ],
    edges: [
      { d: 'M 326 106 L 326 138' },
      { d: 'M 326 192 L 326 222' },
      { d: 'M 326 282 L 326 312' },
      { d: 'M 250 366 L 250 382 L 174 382 L 174 398' },
      { d: 'M 402 366 L 402 382 L 478 382 L 478 398' },
      { d: 'M 174 462 L 174 479 L 310 479 L 310 496' },
      { d: 'M 478 462 L 478 479 L 440 479 L 440 496' },
      // qTA bypass down right side into res_out
      { d: 'M 803 106 L 803 440 L 632 440 L 632 527 L 596 527', accent: true, label: 'qTA 物理基线 x_base', lx: 662, ly: 432 },
      // Tract2Area-Proxy dashed monitor
      { d: 'M 596 544 L 660 544', dashed: true, label: '面积守卫', lx: 604, ly: 537 },
    ],
  },
  {
    id: 'text2prosody',
    shortTitle: 'Text2Prosody-Lite v4',
    title: '阶段 2A · Text2Prosody-Lite v4（多语与任意 [IPA] 韵律预测模型）',
    badge: '1.98 M · Conformer + 残差 BiGRU · CPU 1.5 ms/句',
    summary:
      '零大语言模型依赖，将音素级 32 维国际音标特征与韵律位置映射为每音素时长、停顿门控与 3 点相对半音基频曲线，原生支持普通话、英语、中英混排及任意无标调 [IPA]。',
    designNote:
      'Head 1 预测的音素时长显式拼接回隐藏状态再送入停顿头与 F0 头，使音高轮廓随音节长短自然展开；输出相对半音天然解耦男女音域，可锚定任意参考音色中位基频。',
    width: 980,
    height: 600,
    nodes: [
      {
        id: 'phon_in',
        x: 110,
        y: 22,
        w: 760,
        h: 72,
        kind: 'io',
        tag: '每音素 1 步',
        title: '音素级多模态输入 (106 维拼接)',
        lines: [
          '32 维通用 IPA 发音特征 + 10 维位置韵律结构（音节/词/短语相对位置）',
          '+ 4 路 Embedding：语种(16，含 LANG_IPA=3) + 声调/重音(24) + 标点(16) + 角色(8)',
        ],
      },
      {
        id: 'proj',
        x: 245,
        y: 122,
        w: 490,
        h: 50,
        kind: 'cnn',
        title: '输入投影 · Linear(106→128) + LayerNorm + GELU',
        lines: ['将离散音韵符号与连续发音特征统一映射至 128 维'],
      },
      {
        id: 'conf4',
        x: 245,
        y: 200,
        w: 490,
        h: 58,
        kind: 'attn',
        tag: '句级语调',
        title: '4× ConformerBlock (dim=128, heads=4, conv_k=7)',
        lines: ['捕获全句语调下倾、轻重音对比与边界延长规律'],
      },
      {
        id: 'bigru_res',
        x: 245,
        y: 286,
        w: 490,
        h: 54,
        kind: 'rnn',
        title: '1 层双向 BiGRU (hidden=64×2 → 128) + 残差相加 + LN',
        lines: ['输出 128 维音素上下文韵律表征 h'],
      },
      {
        id: 'head1',
        x: 285,
        y: 370,
        w: 410,
        h: 56,
        kind: 'out',
        tag: 'Head 1 · 时长',
        title: '时长预测头 · 2× Linear (128→64→1)',
        lines: ['输出 log_dur（相对 80 ms 基准音素时长）'],
      },
      {
        id: 'concat_dur',
        x: 315,
        y: 454,
        w: 350,
        h: 44,
        kind: 'phys',
        title: '时长条件串联 · concat(h, log_dur) → 129 维',
        lines: ['让停顿与音高曲线感知音节长短'],
      },
      {
        id: 'head2',
        x: 110,
        y: 526,
        w: 346,
        h: 60,
        kind: 'out',
        tag: 'Head 2 · 停顿',
        title: '停顿预测头 · 2× Linear (129→64→2)',
        lines: ['输出句内停顿门控概率 + 停顿时长'],
      },
      {
        id: 'head3',
        x: 524,
        y: 526,
        w: 346,
        h: 60,
        kind: 'out',
        tag: 'Head 3 · 基频',
        title: '基频预测头 · 2× Linear (129→128→4)',
        lines: ['输出 3 点相对半音 [起, 中, 尾] + 浊音概率'],
      },
    ],
    edges: [
      { d: 'M 490 94 L 490 122' },
      { d: 'M 490 172 L 490 200' },
      { d: 'M 490 258 L 490 286' },
      { d: 'M 490 340 L 490 370' },
      { d: 'M 490 426 L 490 454', accent: true },
      // Skip h around Head 1 into concat_dur
      { d: 'M 245 313 L 196 313 L 196 476 L 315 476', dashed: true, label: 'h (128D)', lx: 132, ly: 398 },
      // Split into Head 2 & Head 3
      { d: 'M 420 498 L 420 512 L 283 512 L 283 526', accent: true },
      { d: 'M 560 498 L 560 512 L 697 512 L 697 526', accent: true },
    ],
  },
];

const activeDiagramId = ref<string>(DIAGRAMS[0].id);
const showAllDiagrams = ref<boolean>(false);

const visibleDiagrams = computed<readonly ArchDiagramSpec[]>(() => {
  if (showAllDiagrams.value) return DIAGRAMS;
  const found = DIAGRAMS.find((d) => d.id === activeDiagramId.value);
  return found ? [found] : [DIAGRAMS[0]];
});

function nodeTitleY(node: ArchNode): number {
  if (node.lines.length <= 1) return node.y + 22;
  if (node.lines.length === 2) return node.y + 22;
  return node.y + 21;
}

function nodeLineY(node: ArchNode, idx: number): number {
  const startY = node.lines.length >= 4 ? node.y + 42 : node.y + 41;
  const step = node.lines.length >= 4 ? 19 : 17;
  return startY + idx * step;
}
</script>

<template>
  <div class="arch-diagrams-wrap">
    <!-- Top toolbar: diagram switcher + expand-all toggle + legend -->
    <div class="arch-toolbar">
      <div class="arch-tab-row">
        <button
          v-for="d in DIAGRAMS"
          :key="d.id"
          type="button"
          class="btn xs"
          :class="{ primary: !showAllDiagrams && activeDiagramId === d.id }"
          @click="
            showAllDiagrams = false;
            activeDiagramId = d.id;
          "
        >
          {{ d.shortTitle }}
        </button>
      </div>
      <div class="arch-tool-right">
        <button
          type="button"
          class="btn xs"
          :class="{ active: showAllDiagrams }"
          @click="showAllDiagrams = !showAllDiagrams"
        >
          <IconSvg name="layers" :size="12" />
          <span>{{ showAllDiagrams ? '切回单图精览' : '全部展开 (5 图)' }}</span>
        </button>
      </div>
    </div>

    <div class="arch-legend">
      <span v-for="item in LEGEND_ITEMS" :key="item.kind" class="arch-legend-item">
        <i class="arch-dot" :class="`kind-${item.kind}`" />
        <span>{{ item.label }}</span>
      </span>
    </div>

    <div class="arch-list">
      <div v-for="diag in visibleDiagrams" :key="diag.id" class="editorial-card arch-diagram-card selectable">
        <div class="arch-card-head">
          <strong>{{ diag.title }}</strong>
          <span class="tree-tag mono">{{ diag.badge }}</span>
        </div>
        <p class="muted arch-summary">{{ diag.summary }}</p>

        <div class="arch-svg-frame">
          <svg
            :viewBox="`0 0 ${diag.width} ${diag.height}`"
            class="arch-svg"
            role="img"
            :aria-label="diag.title"
          >
            <defs>
              <marker
                :id="`arrow-${diag.id}`"
                viewBox="0 0 10 10"
                refX="8.5"
                refY="5"
                markerWidth="6.5"
                markerHeight="6.5"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.2 L 8.8 5 L 0 8.8 z" class="arch-marker" />
              </marker>
              <marker
                :id="`arrow-accent-${diag.id}`"
                viewBox="0 0 10 10"
                refX="8.5"
                refY="5"
                markerWidth="6.5"
                markerHeight="6.5"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.2 L 8.8 5 L 0 8.8 z" class="arch-marker-accent" />
              </marker>
            </defs>

            <!-- Connectors -->
            <g>
              <template v-for="(edge, eIdx) in diag.edges" :key="eIdx">
                <path
                  :d="edge.d"
                  fill="none"
                  class="arch-edge"
                  :class="{ dashed: edge.dashed, accent: edge.accent }"
                  :marker-end="edge.accent ? `url(#arrow-accent-${diag.id})` : `url(#arrow-${diag.id})`"
                />
                <text
                  v-if="edge.label && edge.lx != null && edge.ly != null"
                  :x="edge.lx"
                  :y="edge.ly"
                  class="arch-edge-label"
                >
                  {{ edge.label }}
                </text>
              </template>
            </g>

            <!-- Nodes -->
            <g v-for="node in diag.nodes" :key="node.id" :class="`arch-node kind-${node.kind}`">
              <rect
                :x="node.x"
                :y="node.y"
                :width="node.w"
                :height="node.h"
                rx="8"
                ry="8"
                class="arch-node-bg"
              />
              <rect
                :x="node.x"
                :y="node.y"
                width="4"
                :height="node.h"
                rx="2"
                class="arch-node-bar"
              />
              <text
                :x="node.x + 14"
                :y="nodeTitleY(node)"
                class="arch-node-title"
              >
                {{ node.title }}
              </text>
              <g v-if="node.tag">
                <text
                  :x="node.x + node.w - 10"
                  :y="nodeTitleY(node)"
                  text-anchor="end"
                  class="arch-node-tag"
                >
                  {{ node.tag }}
                </text>
              </g>
              <text
                v-for="(line, lIdx) in node.lines"
                :key="lIdx"
                :x="node.x + 14"
                :y="nodeLineY(node, lIdx)"
                class="arch-node-line"
              >
                {{ line }}
              </text>
            </g>
          </svg>
        </div>

        <div class="arch-design-note">
          <IconSvg name="info" :size="13" />
          <span>{{ diag.designNote }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.arch-diagrams-wrap {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.arch-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.arch-tab-row,
.arch-tool-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.arch-legend {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 0.82rem;
  color: var(--muted);
  padding: 6px 10px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 55%, var(--panel));
}

.arch-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.arch-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 2px;
}

.arch-dot.kind-io {
  background: #64748b;
}
.arch-dot.kind-cnn {
  background: #0ea5e9;
}
.arch-dot.kind-attn {
  background: var(--accent);
}
.arch-dot.kind-rnn {
  background: #a855f7;
}
.arch-dot.kind-phys {
  background: #10b981;
}
.arch-dot.kind-out {
  background: #f59e0b;
}

.arch-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.arch-diagram-card {
  box-shadow: none;
  gap: 10px;
}

.arch-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 0.96rem;
}

.arch-summary {
  margin: 0;
  font-size: 0.89rem;
  line-height: 1.58;
}

.arch-svg-frame {
  width: 100%;
  overflow-x: auto;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  background:
    radial-gradient(circle at 18% 12%, color-mix(in srgb, var(--accent) 5%, transparent), transparent 48%),
    color-mix(in srgb, var(--app) 76%, var(--panel));
  padding: 12px;
  box-sizing: border-box;
}

.arch-svg {
  display: block;
  width: 100%;
  min-width: 720px;
  max-width: 1060px;
  height: auto;
  margin: 0 auto;
  font-family: var(--font-sans, system-ui, sans-serif);
}

.arch-edge {
  stroke: color-mix(in srgb, var(--muted) 72%, var(--panel-border));
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.arch-edge.dashed {
  stroke-dasharray: 5 4;
}

.arch-edge.accent {
  stroke: color-mix(in srgb, var(--accent) 82%, var(--text));
  stroke-width: 2;
}

.arch-marker {
  fill: color-mix(in srgb, var(--muted) 78%, var(--panel-border));
}

.arch-marker-accent {
  fill: color-mix(in srgb, var(--accent) 88%, var(--text));
}

.arch-edge-label {
  font-size: 11px;
  font-weight: 600;
  fill: var(--muted);
  font-family: var(--font-mono, monospace);
}

.arch-node-bg {
  fill: color-mix(in srgb, var(--ctrl-bg) 88%, var(--panel));
  stroke: var(--panel-border);
  stroke-width: 1.25;
}

.arch-node.kind-io .arch-node-bar {
  fill: #64748b;
}
.arch-node.kind-io .arch-node-bg {
  stroke: color-mix(in srgb, #64748b 45%, var(--panel-border));
}

.arch-node.kind-cnn .arch-node-bar {
  fill: #0ea5e9;
}
.arch-node.kind-cnn .arch-node-bg {
  fill: color-mix(in srgb, #0ea5e9 7%, var(--ctrl-bg));
  stroke: color-mix(in srgb, #0ea5e9 42%, var(--panel-border));
}

.arch-node.kind-attn .arch-node-bar {
  fill: var(--accent);
}
.arch-node.kind-attn .arch-node-bg {
  fill: color-mix(in srgb, var(--accent) 10%, var(--ctrl-bg));
  stroke: color-mix(in srgb, var(--accent) 52%, var(--panel-border));
}

.arch-node.kind-rnn .arch-node-bar {
  fill: #a855f7;
}
.arch-node.kind-rnn .arch-node-bg {
  fill: color-mix(in srgb, #a855f7 8%, var(--ctrl-bg));
  stroke: color-mix(in srgb, #a855f7 44%, var(--panel-border));
}

.arch-node.kind-phys .arch-node-bar {
  fill: #10b981;
}
.arch-node.kind-phys .arch-node-bg {
  fill: color-mix(in srgb, #10b981 9%, var(--ctrl-bg));
  stroke: color-mix(in srgb, #10b981 46%, var(--panel-border));
}

.arch-node.kind-out .arch-node-bar {
  fill: #f59e0b;
}
.arch-node.kind-out .arch-node-bg {
  fill: color-mix(in srgb, #f59e0b 8%, var(--ctrl-bg));
  stroke: color-mix(in srgb, #f59e0b 46%, var(--panel-border));
}

.arch-node-title {
  font-size: 12.6px;
  font-weight: 700;
  fill: var(--text);
}

.arch-node-tag {
  font-size: 10.5px;
  font-weight: 700;
  fill: var(--accent);
  font-family: var(--font-mono, monospace);
}

.arch-node-line {
  font-size: 11.2px;
  fill: var(--muted);
  font-family: var(--font-mono, var(--font-sans, monospace));
}

.arch-design-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 7px 10px;
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--accent) 7%, var(--panel));
  border-left: 3px solid var(--accent);
  font-size: 0.86rem;
  line-height: 1.56;
  color: var(--text);
}

.arch-design-note :deep(svg) {
  flex: none;
  margin-top: 2px;
  color: var(--accent);
}
</style>
