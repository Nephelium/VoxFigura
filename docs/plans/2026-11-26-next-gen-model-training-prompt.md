# VoxFigura Core 下一代联合训练与微调提示词（新窗口可直接复制）

> 用途：直接复制下方代码块中的完整提示词到新的对话窗口，工作目录打开 `F:\TensorTract3_Train`，即可按阶段有序推进三项核心升级训练与微调，并在每阶段自动完成定量对比与盲测体检。

```markdown
你现在要在训练仓库 `F:\TensorTract3_Train` 中，为 **VoxFigura Core** 设计并执行下一代端侧模型的三阶段联合训练与升级微调。请先只读核查现有代码、检查点与数据，提出简洁可执行的实现方案并经我确认后再开工，严格按阶段推进、每阶段通过验证门禁后再进入下一阶段。

---

## 一、环境、目录与硬约束

1. **工作仓库与解释器**
   - 训练仓库：`F:\TensorTract3_Train`
   - Python 环境：`F:\TensorTract3_Train\.venv\Scripts\python.exe -B -X utf8`
   - 硬件与精度：单卡 `NVIDIA GeForce RTX 5090 Laptop GPU` (24 GB VRAM)，PyTorch 2.7.1+cu128；常规模型使用 `bf16`，声码器 `GlottisAwareSourceModule` 的相位累加 `cumsum` 必须强制保持 `float64`。
   - 离线缓存：`HF_HOME = F:\TensorTract3_Train\cache\hf`，设置 `HF_HUB_OFFLINE=1`；长任务统一用 `scripts/run_logged.py` 启动防止 Windows stderr 中断，且每个训练脚本必须支持 `--resume` 断点续跑。
2. **只读外部参考（严禁写入）**
   - 严禁写入 `D:\PhoneticToolbox\PhoneticToolbox_v3`。
   - 下游应用仓库 `c:\Users\13680\Desktop\project\【个人项目】\黑客松` 仅作只读参考（核对 `scripts/export_onnx_models.py` 的 ONNX 算子与张量契约，以及读取 `engine/reference_library` 中的 IPA 与 VoQS 实录作为**只读黄金盲测集**，绝不写入该仓库，也绝不把这些少量实录混入训练集）。
3. **保护既有基线权重**
   - 所有新实验必须写入全新 `runs/` 目录（如 `runs/vox2tract_align_v3/`、`runs/prosody_ipa_joint_v1/`、`runs/tract2vox_lite_v2/`），严禁直接覆盖 `F:\TensorTract3_Train\models\` 下的现有已验证权重，直到新模型指标全面胜出并经我验收后，再统一导出替换。
4. **物理契约与 ONNX 导出红线**
   - 严格保持 16 kHz / 50 Hz（`hop = 320`，帧心 `(k + 0.5) * 320`）与 M27 27 维物理边界（`src/tt3/m27_contract.py`）不变。
   - 所有需部署到 VoxFigura 端侧的模型必须保持纯净可导出动态 ONNX：禁止使用复数 STFT、禁止 `pack_padded_sequence`、禁止 `torch.Generator`。
   - 官方命名统一使用：`Vox2Tract-Lite`、`Vox2Align-Lite v2`、`Vox2Spk-Lite`、`Tract2Vox-Lite`、`IPA2Tract-Lite`、`Tract2Area-Proxy`、`Text2Prosody-Lite`。

---

## 二、现有资产清单（开工前请先核实）

- **已训练基线模型（`F:\TensorTract3_Train\models\`）**：
  - 端侧 7 模型：`Vox2Tract-Lite/vox2tract_lite_fp16.pt`（7.64M）、`Vox2Align-Lite/vox2align_lite_v2_fp16.pt`（4.33M）、`Vox2Spk-Lite/vox2spk_lite_fp16.pt`（2.90M）、`Tract2Vox-Lite/tract2vox_lite_fp16.pt`（3.72M）、`IPA2Tract-Lite/ipa2tract_lite_fp16.pt`（4.23M）、`IPA2Tract-Lite/tract2area_proxy.pt`（0.23M）、`Text2Prosody-Lite/text2prosody_lite_fp16.pt`（1.98M）
  - 旗舰教师与代理：`Vox2Tract-Large/{vox2tract_large.pt, vox2tract_pr.pt, tract2feat_proxy.pt}`、`Tract2Vox-Large/tract2vox_large.pt`（14.36M）
- **现有数据集（`F:\TensorTract3_Train\data\`）**：
  - `distill_m27_v1/`（63.61h 教师伪标签与声纹共享缓存）
  - `synth_full_glottis_180h/`（179.89h VTL 2.4 JD2 27 维全发声态物理合成库）
  - `vox2align_v2/`（70,000+ 条双语朗读与歌唱对齐库）
  - `prosody_zh_en/`（52,339 条中英混排韵律库）
  - `kf_dataset/`（91,545 条协同构音库 + USC-TIMIT 真人 EMA 盲测 276 条）
  - `speaker_index_m27.json`（495 训 / 84 未见测多说话人索引）
- **核心参考脚本（`F:\TensorTract3_Train\scripts\`）**：
  - `train_browser_m27_stage4.py`、`train_vox2align_v2.py`、`train_text2prosody.py`、`train_kf_trajectory.py`、`train_browser_m27_stage5.py`、`eval_m27_audition.py`、`eval_kf_trajectory.py`、`export_named_models.py`

---

## 三、三项核心训练任务（按顺序串行推进，每步验收后再进下一步）

### 阶段 1：`Vox2Tract-Lite` + `Vox2Align-Lite v2` 共享主干多任务联合训练
- **输出目录**：`runs/vox2tract_align_v3/`
- **核心目标**：用一套共享 Conformer 主干合并声道反演与对齐/静音门控，既减少 30% 左右重复算力，又让音素边界与静音监督反向拉升声道反演精度（重点提升 `LD`、`TBX`、`TS1` 等成阻维度与静音段防漂移）。
- **架构硬要求**：
  1. **前向传播绝对不依赖文本输入**：输入仅含音频特征（`PureLogMel50Hz` 163 维 + 内部图算 ΔΔ 或融合 + `VQ` 3 维 + `F0` 1 维），前向一次同时输出：
     - 反演分支：`tract17`、`pr1`、`glot8`、`h_backbone`
     - 对齐与门控分支：`speech_mask_logit`、`zh_syl_ctc_logits`、`phone_frame_logits`、`phone_ctc_logits`、`boundary_logits`、`tone_logits`、`lang_logits`
  2. **无文本照常运行**：没有文本时直接产出 27 维轨迹 + `speech_mask` 静音去抖（及可选盲解码 Mode A）；有文本时仅在推理后处理阶段调用 `viterbi_guided_align_v2`。
  3. 总参数控制在约 `8M–10M`，纯 CPU 3 秒耗时显著快于旧版两模型串联（旧版合计量 `22.5 + 13.5 = 36.0 ms`）。
- **联合训练设计**：
  - 多源任务掩码混训：`distill_m27_v1` 与 `synth_full_glottis_180h` 计算反演损失（位置/速度/加速度 L1 + 冻结 `Tract2Feat-Proxy` L24/L6 感知对齐 + 冻结 `Tract2Area-Proxy` 成阻/开口面积守卫）；`data/vox2align_v2/` 计算 7 头对齐与静音门控损失（歌唱样本继续屏蔽声调头），并且允许对齐梯度回传共享主干（支持先冻结反演头短预热、再联合解冻微调，防止灾难性遗忘）。
  - 优先考虑从现有 `Vox2Tract-Lite` 与 `Vox2Align-Lite v2` 权重热启动以加快收敛并稳住基线。
- **验收门禁（相对旧基线对比表）**：
  - 未见自然验证集 `T17 PCC`（基线 `0.9102`）、`G8 PCC`（`0.8420`）、`PR PCC`（`0.8798`）及 8 句 R21 `L24`（`0.8235`）不降反升，并单独报告 `LD`/`TBX`/`TS1` 改进；
  - 对齐中/英 `≤20ms` 边界精度（基线 `93.7% / 95.5%`）、中文合法音节准度（`90.7%`）、`Mask F1`（`0.989`）不降反升；
  - 实测纯 CPU 3 秒 ONNX 推理延迟与无文本/有文本双模式推理脚本冒烟通过。

---

### 阶段 2：`Text2Prosody-Lite` + `IPA2Tract-Lite` 弱耦合联合微调
- **输出目录**：`runs/prosody_ipa_joint_v1/`
- **核心目标**：改善「文本 → 韵律 → 协同构音」流水线的自然度，使 `IPA2Tract-Lite` 适应真实预测的时长与基频分布（体现轻读央化与重读超构音）。
- **架构硬要求**：
  - **必须保持两个独立可调用的模型权重与 ONNX 接口**，严禁合并成单一黑盒，确保工作台在导入 TextGrid、简谱或 MIDI 编曲时依然能够跳过 `Text2Prosody-Lite` 单独调用 `IPA2Tract-Lite`。
- **联合微调设计**：
  - 从 `models/Text2Prosody-Lite/text2prosody_lite_fp16.pt` 与 `models/IPA2Tract-Lite/ipa2tract_lite_fp16.pt` 热启动。
  - 在 `data/kf_dataset/` 与 `data/prosody_zh_en/` 上采用 Scheduled Sampling（例如 50% 真实对齐时长与 F0 + 50% `Text2Prosody-Lite` 预测时长与 F0，配合低学习率微调），保留 `IPA2Tract-Lite` 的零初始化残差结构、`JA` 残差上限约束与 `Tract2Area-Proxy` 闭塞/开口护栏。
- **验收门禁**：
  - 必须完整重跑 `scripts/eval_kf_trajectory.py` 四重科学检验：**脏上下文零泄漏 `max_abs_diff == 0.0`（硬红线）**、多发声态渐变、VCV 协同、USC-TIMIT 真人 EMA 传感器相关性（`LD 0.6956`、`TTX 0.6743`、`TCY 0.5958` 不退化）；
  - `Text2Prosody-Lite` 中/英/混排时长 MAE 与 F0 PCC 不退化；
  - 对比「微调前 vs 微调后」文本直出 27 维轨迹经声码器合成的主观试听页。

---

### 阶段 3：`Tract2Vox-Lite`（3.72M）三合一升级微调（闭环适配 + 物理去机械化 + 截面积消融 + 低 LR 精调）
- **输出目录**：`runs/tract2vox_lite_v2/`
- **背景与避坑硬约束**：
  - 现有 IPA 构型表含 AI 辅助调整项，且大量稀有 IPA 与附加符号在真人语料里几乎零出现，实录仅 200 余条 IPA 与十余条发声态，**严禁按音标符号强锚定、也严禁把这 200 条实录直接塞进训练集**。
  - 必须继续保持 `Vox2Spk-Lite` 独立解耦（严禁与 `Vox2Tract-Lite` 合并主干）。
- **四项核心升级**：
  1. **端到端学生轨迹与小声纹闭环适配（`Vox2Tract-Lite` + `Vox2Spk-Lite` + `Tract2Vox-Lite`）**：
     - 从现有 `runs/browser_m27_stage5` 最佳检查点（若保留了 G/D/Opt 状态则续接，否则从 `models/Tract2Vox-Lite/tract2vox_lite_fp16.pt` 热启 G 并热身 D）出发；
     - 在真人语音样本中，按比例（推荐渐进到 35%–50%）混入**阶段 1 新版 `Vox2Tract-Lite` 预测出的 27 维轨迹** + **`Vox2Spk-Lite` 声纹**，其余仍用 `Vox2Tract-Large` 教师轨迹，**目标波形始终锁死真人原声**，消除端到端暴露偏差（拉升全端侧 8 句 E2E L24，重点修复气声与假声掉分）。
  2. **180h 物理合成样本改用「WavLM L24 内容守恒 + 真人 GAN 去机械化」（彻底打通标准 IPA 构型与任意稀有发声态）**：
     - 将 `data/synth_full_glottis_180h/` 的采样比例提升至约 20%–30%，输入为**精确 VTL 物理 27 维轨迹 + 随机采样的真实人类 512 维声纹（由 `Vox2Spk-Lite` 提取）**；
     - **核心改动**：对该物理分支**移除逼迫生成波形模仿 VTL 机械音的 Mel-L1 损失**，替换为四项解耦损失：
       1. `WavLM L24` 帧级余弦内容守恒（对齐对应 VTL 物理音频 $y_{\text{vtl}}$ 的构音与音段内容，不依赖任何音标符号）；
       2. MPD/MRD LSGAN 判别器对抗损失（**判别器的 Real 池只放真人录音，绝不放 VTL 机械音**，强迫声码器输出自然真人质感）；
       3. 目标真人说话人声纹余弦损失（`Vox2Spk-Lite` / `WavLM-SV`）；
       4. `SwiftF0`（或基频/周期一致性）与相对 `WavLM L6` 发声态守恒损失，保住气声、嘎裂、假声、紧嗓与耳语的发声特征。
  3. **可选消融：`Tract2Area-Proxy` 6 维关键截面积条件输入（`--use-area-cond`）**：
     - 通过冻结的 `Tract2Area-Proxy`（0.23M）从 17 维声道确定性算出 6 维最小截面积，经零初始化轻量投影注入 `ConditionalHiFiGenerator27` 条件通道；
     - 先做小规模对比消融（开 vs 关），仅当对标准物理构型和盲测有稳定正收益且 CPU 延迟增加 < 5 ms 时才合入正式版。
  4. **补完低学习率余弦精调收尾**：
     - 复刻 `Tract2Vox-Large` 在 28k→32k 的收尾策略，末段执行 4,000–6,000 步低学习率余弦精调（`lr = 5e-5 -> 1e-5`），消除慢衰减振荡并把 `val_score` 压到极限。
- **验收门禁与只读黄金体检脚本**：
  - 96 对未见说话人验证集（`val_mel_l1`、`L24`、`L6`、`Spk Cos`、`lite_spk_e2e_cos`、`val_score` 对比旧基线 `0.0626`）；
  - 8 句试听评测（必须同时报告 Teacher 轨迹驱动与 **Full-Lite E2E** 端到端得分，重点看普通话、英语、气声、紧嗓、嘎裂、假声、五态渐变 8 项逐句对比）；
  - **新增只读黄金盲测与 IPA 构型体检脚本**（读取 `黑客松/engine/reference_library` 中约 200 条 IPA 实录与 VoQS 实录，严格只读绝不进训练）：
    1. 对比「真人实录 vs VTL 物理音 vs 旧 `Tract2Vox-Lite` vs 新 `Tract2Vox-Lite v2`」在稀有 IPA 和 6 档发声态上的客观分与可试听 HTML 对比页；
    2. 按每个 IPA 构型的「VTL 2.4 物理合成音 vs 真人 IPA 实录」的 `WavLM L24` 相似度从低到高排序，输出 **AI 构型偏差最大 Top 30 清单**，方便我精准人工复核最需要微调的那批音标。

---

## 四、执行纪律与汇报节点

1. **先规划后写代码**：先只读核对相关脚本与检查点，给出阶段 1–3 的代码改动清单、显存与耗时预估，等我确认后再编写脚本。
2. **先冒烟再长训**：每个阶段正式开训前，必须先跑 **300–500 步 smoke test**，验证：显存峰值 ≤ 22 GB、无 NaN/Inf、所有损失项梯度正常、checkpoint 保存与 `--resume` 断点续跑正常、CPU ONNX 导出数值误差 < `1e-3`。
3. **每阶段停下来汇报**：每完成一个阶段，输出「新模型 vs 基线」实测指标表、CPU 3 秒耗时、试听页面路径与任何异常发现，**等我确认后再启动下一阶段**，也绝不未经确认覆盖正式 `models/` 或下游 `黑客松` 仓库的 ONNX 文件。
```
