# VoxFigura 模型接入与接口规范（MODEL_INTERFACE_SPEC）

> 版本 1.1 · 2026-11-24
> 适用范围：`packages/model-adapters/`、`engine/`、`server/index.mjs` 及 VoxFigura Core 本地推理

## 0. 全局单位、时间网格与物理边界约定

| 量纲 / 概念 | 前端 & TS Adapter 层 | Python `engine/` & 原生边界 |
| --- | --- | --- |
| 声门下压 `PR` | **`Pa`**（`0.0 .. 1600.0 Pa`，越界拒绝不夹紧） | **`dPa`**（`0.0 .. 16000.0 dPa`，`dPa = Pa * 10`） |
| 基频 `F0` | **`Hz`**（调度/编辑合法范围 `60.0 .. 600.0 Hz`；声道反演与原生底层契约 `40.0 .. 600.0 Hz`） | **`Hz`**（`normalize_f0_m27` 使用对数归一化 `ln(F0)` 映射到 `[-1, 1]`） |
| 音频采样率与时间 | `48000 Hz` 整数采样 `_smp`，半开区间 `[start_smp, end_smp)` | VTL 合成输出 `48000 Hz`；`Vox2Tract-Lite` / `Vox2Align-Lite v2` / `Tract2Vox-Lite` 内部特征与生成 `16000 Hz`（密轨合成路径升频至 `48000 Hz`） |
| 控制帧率 | 自由手绘/调度密数组（不受 201 点限制） | `Vox2Tract-Lite` / `Tract2Vox-Lite` / `IPA2Tract-Lite` / `Vox2Align-Lite v2` 统一 **`50 Hz`**（hop `320 @ 16k` = `960 @ 48k` = `20 ms/frame`）；VTL 原生管段步长 `200 Hz` / `5 ms` |
| `m27` 27 维向量 canonical 顺序 | 统一按物理单位对象或 `Float32Array` 传递 | `[0..16]` 17 维声道 `HX, HY, JX, JA, LP, LD, VS, VO, TCX, TCY, TTX, TTY, TBX, TBY, TS1, TS2, TS3`；`[17]` `F0`；`[18]` `PR (dPa)`；`[19..26]` 8 维声门/微扰 `XB, XT, CA, LAG, RA, PS, FL, SHIM` |

**JD2 19 维与 17 维声道映射**：JD2 原生声道参数共 19 维，其中 `TRX`（下标 14）与 `TRY`（下标 15）在非 `manual_root` 模式下由引擎自动计算；`TRACT_17_TO_19_IDX = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,16,17,18]`。

合成和重合成请求可加 `audio_gain`。应用使用 `peak` 时，在边界淡入淡出和静音处理完成后，整条波形使用同一倍率达到 0.8 的绝对峰值。静音保持原电平。`original` 保留处理后的引擎电平。省略该字段时沿用原 API 行为。音量模式独立于构型与控制轨。

---

## 1. VTL 2.4 物理声道引擎（已就绪）

### 1.1 双传输路由优先级
`VocalEngineTransport` 按以下优先级自动切换（界面与上层业务无感知）：
1. **浏览器本地 Wasm Worker**（预留优先）：探测 `/vocal-wasm/manifest.json`；若存在则加载 Pyodide + Emscripten 编译的 VTL 2.4 模块。
2. **本地 Python 原生 DLL 服务**（当前主通道）：探测 `GET /api/vtl/meta`（由 Node 代理转发至 `http://127.0.0.1:8765/vtl/meta`），基于 `VocalTractLabApi.dll`、`VocalTractLabAnalysis.dll`、`geometry_p2.dll` 与 `JD2/W02/M01.speaker`。
3. **预热缓存兜底**：当上述两者均不可用时，读取 `/prewarm/*.json` 与 `.wav` 真实 VTL 预渲染结果，并在状态栏标明当前为预热只读兜底。

### 1.2 HTTP JSON Schema（`engine/server.py`）

- `GET /vtl/meta` -> 返回说话人列表、默认几何版本、65 截面配置与 19/27 维参数范围（`PR` 返回字段以 `pressure_pa` 标明）。
- `POST /vtl/pose`：
  - **请求**：`{ "speaker": "JD2" | "W02" | "JD2-2D" | "W02-2D", "params": number[19], "tongue_shape"?: number[4], "lip_shape"?: number[4], "larynx_height"?: number, "manual_root"?: boolean, "lip_width"?: number, "glottis"?: Record<string, number> }`
  - **响应**：`{ "ok": true, "state": { /* embed.mjs 兼容完整轮廓/网格 state */ }, "area_cm2": number[65], "oral_min_area_cm2": number, "transfer_db": number[], "formants_hz": [number, number, number] }`
- `POST /vtl/synthesize`（绕开 `trajectory.py` 201 点上限的密集控制序列通道，支持 `synth_mode: "physical" | "neural"`）：
  - **请求**：`speaker`、`step_hz`（或 `frame_step_ms`）、`f0_hz`、`pressure_pa`、`tract_frames`、`glottis_frames`、`predict_articulation`、`articulation_spans`、`synth_mode`、`device`。
  - **边界校验**：`f0_hz`、`pressure_pa`、`tract_frames`、`glottis_frames`、`lip_width_frames`、`larynx_height_frames`、`shimmer`、`flutter`、`fps` 任何维度越界、出现 `NaN/Inf` 或布尔误传，均直接返回 `400` `{ "ok": false, "error": { "code": "out_of_range" | "validation_error", "allowed": ..., "hint": ... } }`，严禁静默夹紧。
  - **响应**：返回 `48000 Hz` `wav_base64`、`duration_s`、`sample_rate_hz: 48000`、`synth_mode`、`source_badge` 及可选 `geometry_frames` / `m27_control_50hz_pa` / `tract_control_50hz`。
- `POST /vtl/high-pitch-preview` 提供持续元音高音试听后端接口（前端独立试听面板已撤下，后端路由与单测继续保留）。
  - **请求**为 `vowel`（`a`、`i`、`u`）、`target_f0_hz`（550–800 Hz）和 `duration_ms`（300–3000 的整数）。使用 JD2 定姿元音和 800 Pa 声门下压。引擎从目标基频与原生上限的较低值开始，随后尝试更低的 10 Hz 档位，并核查稳态区间的基频与周期性。
  - **响应**包括 48 kHz 单声道 `wav_base64`、`sample_count`、物理载波的指令与实测基频、输出实测基频，以及 `method`（`vtl` 或 `td-psola`）。移调时另返回等长的原始 `carrier_wav_base64` 供对听。
  - **移调方法**在时域移动按基音周期提取的波形片段，保持时长，尽量保留原频率轴上的谱包络。高基频下谐波间隔变大，同一谱包络也可能呈现不同的谐波幅度。该接口用于持续元音，编曲和声道轨迹仍使用原有 60–600 Hz 物理参数范围。[Moulines 与 Charpentier（1990）](https://doi.org/10.1016/0167-6393(90)90021-Z)

---

## 2. `Vox2Tract-Lite` 与 `Vox2Align-Lite v2`（声道反演与引导对齐，已就绪）

### 2.1 来源与零 PyTorch 懒加载隔离
- 模型权重（纯 ONNX Runtime）：`engine/model_bundle/models/Vox2Tract-Lite/vox2tract_lite.onnx` 与 `models/Vox2Align-Lite/vox2align_lite_v2.onnx`（原始 `.pt` 权重文件仅作离线备份保留，运行时零 PyTorch 导入）。
- 声学前端：`engine/onnx_frontends.py` 提供纯 NumPy/SciPy 的 `PureLogMel50Hz`（16 kHz，Slaney 80-Mel，`n_fft=1024`，`win=640`，`hop=320`，逐句归一化 + 一阶差分 + 3 维能量 + 3 维发声态线索）+ `SwiftF0` ONNX（40..600 Hz）。超过 `9.6 s` 的音频经 `plan_silence_chunks` 按静音分块推理拼接，再送 `Vox2Align-Lite v2` 完成音素/音节强制对齐与静音门控。
- **懒加载与热插拔隔离**：全套 9 个模型由 `engine/model_registry_runtime.py`（`LocalModelManager`）统一按需创建和释放 `onnxruntime.InferenceSession`；首次调用 `/vtl/*`（未触发神经模块）不加载 ONNX 会话。卸载中的模型被调用时返回 `503` `{ "ok": false, "error": { "code": "model_unloaded", "model": "...", "hint": "..." } }`。

### 2.2 HTTP JSON Schema
- `POST /m27/reconstruct`：传入 `wav_base64`、`text?`、`lang?`、`alignment_mode?`、`synth_mode`、`device`，返回 50 Hz `m27_50hz_pa`（`PR` 已换算为 `Pa`）、`tract_glottis_anim`、`vtl_48k_wav_base64`、`neural_16k_wav_base64` 与 `alignment`。
- `POST /m27/align`：传入 `wav_base64` 与原文 `text`，返回 `alignment`（TextGrid 与音素/音节区间）。
- `POST /m27/transcribe`：传入 `wav_base64`（可解码的录音容器，80 ms–60 s）、`lang?: "auto" | "zh" | "en"`、`model?: "tiny" | "large-v3-turbo" | "large-v3" | "base"`、`device?: "cpu"`。未指定模型时使用已安装缓存。`VOCALCUT_ASR_MODEL_DIR` 指定的模型优先。本地 faster-whisper 返回 `{ ok, text, lang, model, device_effective, duration_s }`。工作台将 `text` 填入参考文本框，供校对后提交到原文对齐或重建。缺少本地运行时或权重时返回 `503 model_unavailable`，录音无语音时返回 `400 no_speech`。
- `POST /api/ai/deepseek-asr`：Node 代理接收 `audio/wav` 与本页 AI 助手的 DeepSeek BYOK 请求头，调用 [DeepSeek 语音识别接口](https://api-docs.deepseek.com/zh-cn/guides/asr/) 并返回 `{ ok, text }`。在设置中启用后，点击「自动识别文本」发送当前录音的 16 kHz 单声道 PCM WAV。DeepSeek 自动判断语种，单次上限为 120 秒、8 MiB。

### 2.3 安装本地语音识别

本地识别可以在「下载 Whisper」或「Whisper 模型」中查看下载量、安装并切换模型。选择保存在当前浏览器的偏好设置中。`POST /m27/asr-install` 接收 `{ model }` 并在当前引擎进程启动后台安装。`GET /m27/asr-install?model=...` 返回 `{ state, model, models, installing_model?, hint? }`。状态为 `missing`、`installing`、`ready` 或 `failed`。命令行可执行 `npm run setup:asr` 下载 tiny，或以 `npm run setup:asr -- --model large-v3-turbo` 指定模型。

安装器根据公网出口的国家或地区选择首选下载源。中国大陆优先 HF-Mirror，其他地区和无法判定时优先 Hugging Face。首选源失败会尝试备用源。可下载的多语言模型为 tiny（约 78 MB）、large-v3-turbo（约 1.62 GB）和 large-v3（约 3.09 GB）。权重按固定版本下载并校验 SHA-256，存入 `.cache/asr/faster-whisper-<model>/`。运行库存入 `.cache/asr/python/`。已有的 Whisper base 缓存可继续使用。`VOCALCUT_ASR_DOWNLOAD_HOST` 可指定同一固定版本的下载源，`VOCALCUT_ASR_MODEL_DIR` 可指定自备的 CTranslate2 多语言权重。引擎从本地文件加载模型并以 CPU INT8 运行，`GET /health` 的 `speech_to_text` 字段提供运行时状态。

---

## 3. `Tract2Vox-Lite` 与 `Vox2Spk-Lite`（真人声道声码器 / 神经赋声，已就绪）

### 3.1 模型组件与精确张量形状
- **`Vox2Spk-Lite`**（`BrowserLightSpeakerEncoder`）：80 维 CMN log-mel → `e_spk: (B, 512)` L2 归一化音色向量；默认讲解声纹位于 `engine/model_bundle/speakers/jingjing-lecture.spk.json`。
- **`Tract2Vox-Lite`**（`ConditionalHiFiGenerator27`）：
  - 输入：`m27_norm: (B, T, 27)` in `[-1, 1]`（`PR` 先由 `Pa * 10` 恢复为 `dPa` 再经 `normalize_m27`）与 `e_spk: (B, 512)`。
  - 上采样倍率：`(8, 5, 4, 2)`，总步幅 `hop_samples = 320`（`50 Hz -> 16 kHz`），内置 `Glottis-NSF v3` 声源模块。
  - 输出：`16000 Hz` 波形（`/m27/reconstruct`、`/m27/resynthesize`、`/m27/hold-preview` 返回 16 kHz；`/vtl/synthesize` 密轨神经合成经 `resample_poly(3, 1)` 交付 48 kHz）。

### 3.2 HTTP JSON Schema
- `POST /m27/resynthesize`：接收 50 Hz `m27_50hz_pa`（全 27 维严格校验、禁止静默夹紧）、`synth_mode: "vtl" | "neural" | "both"`、`tube_hz: 50 | 100 | 200`、`speaker_ref_wav_base64?`、`device`，返回 `device_effective`、动画帧与音频。
- `POST /m27/hold-preview`：接收 27 维常量与 `25..150` 帧数，校验全部 27 维物理范围并补齐高通与斜坡，返回 `16 kHz` 持音试听 WAV。

---

## 4. `IPA2Tract-Lite` 与 `Tract2Area-Proxy`（协同动腔规划，已就绪）

### 4.1 架构与物理护栏对齐
- 模型权重（ONNX）：`models/IPA2Tract-Lite/ipa2tract_lite.onnx` 与 `models/IPA2Tract-Lite/tract2area_proxy.onnx`。
- **输入张量**：
  - `cond_111: (B, T, 111)` float32 @ 50 Hz（含 26 维 3 阶 qTA 异步基线 `x_base_26`、掩码目标 `g_masked`、26 维器官锁 `w_mask`、对数 `f0_norm`、5 维相位含显式 `is_sil`、4 维阻塞事件、22 维通用音标构音特征 `PHON_FEAT_DIM = 22`、`has_phon`）。
  - `x_base_26: (B, T, 26)` float32（`M27` 剔除只读 `F0` 列 17）与协同强度 `alpha`（`0..1`）。
- **`Tract2Area-Proxy`**：输入 `tract17_norm: (..., 17)`，输出 `log1p(area_cm2)` 6 区预测。
- **链路 B 调用约定**：`/vtl/synthesize`（开启 `predict_articulation`）和 `/models/ipa-default-poses` 使用同一 `PoseBank`。采用当前 IPA 构型的片段通过 `pose_source: "custom"` 和 `articulation_spans[].pose_target_19` 传入编辑器保存的 19 维目标。引擎在音段中心对主要发音器官应用余弦过渡，对塞音优先使用实录闭塞及释放相位，并用 `Tract2Area-Proxy` 检查局部收窄。模型默认值和显式编辑分别沿用默认相位目标及手动约束。`/models/kf2tract` 直接暴露 111 维条件推理和管腔截面积代理结果。

---

## 5. `Text2Prosody-Lite`（中英自然韵律预测，已就绪）

- 权重（ONNX）：`models/Text2Prosody-Lite/text2prosody_lite.onnx`。
- `POST /models/text-prosody`：接收中英混排文本及可选参数 `lang`、`base_f0`、`speed_scale`、`pitch_scale`、`f0_min_hz`，直接返回 `syllables`、`keyframes`（含显式 `sil`）与 `f0_knots`。

---

## 5.5 本地 ONNX 模型热插拔与外置权重装载接口

- `GET /models/local`：返回 9 个内置模型槽位的体积、参数量、装载状态（`loaded`、`in_memory`）、外置来源标记（`is_external`、`external_label`）及 ONNX Runtime 运行时信息。
- `POST /models/local/load`：接收 `{ "name": string, "eager"?: boolean, "device"?: "cpu" | "cuda" }` 或 `{ "all": true }`，启用并按需立即载入 `InferenceSession`。
- `POST /models/local/unload`：接收 `{ "name": string }` 或 `{ "all": true }`，立即释放内存中的 `InferenceSession` 并停用该槽位。
- `POST /models/local/mount`：接收 `{ "name"?: string, "path"?: string, "folder_path"?: string, "eager"?: boolean }`，校验目标 `.onnx` 张量输入输出契约后挂载单个外置文件或批量扫描整个文件夹。
- `POST /models/local/mount-binary`：接收原始 `.onnx` 二进制请求体（查询参数 `name`、`filename`、`eager`），校验契约并持久化至 `.cache/custom-models/` 后热切换。
- `POST /models/local/reset`：接收 `{ "name": string }` 或 `{ "all": true }`，恢复默认内置 ONNX 模型。

---

## 6. 预留模型插槽（返回 501 契约 JSON）

1. **网页极轻蒸馏反演（`BrowserLightM27Slot` · `GET/POST /models/browser-light-m27`）**：
   - 预留未来浏览器端 `onnxruntime-web`（WebGPU / WASM）本地反演插槽；当前默认回落 `/api/m27/reconstruct`（`Vox2Tract-Lite`）。
2. **自定义发音人微调权重（`SpeakerModelSlot` · `GET/POST /models/speaker`）**：
   - 当前零样本音色转换已由 `Vox2Spk-Lite` + `Tract2Vox-Lite` 在 `/m27/reconstruct` 与 `/m27/resynthesize` 就绪；专属说话人微调权重接口保持 501 预留。
