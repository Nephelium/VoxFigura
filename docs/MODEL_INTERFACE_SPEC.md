# VoxFigura 模型接入与接口规范（MODEL_INTERFACE_SPEC）

> 版本 1.2 · 更新于 2026-11-28
> 适用范围：`packages/model-adapters/`、`engine/`、公共代理 `server/proxy.mjs`、开源版及参赛版入口（`server/index.mjs`、`server/hackathon.mjs`）、便携入口 `server/portable.mjs` 与 VoxFigura Core 本地推理

## 0. 全局单位、时间网格、物理边界与安全契约

| 量纲 / 概念 | 前端 & TS Adapter 层 | Python `engine/` & 原生边界 |
| --- | --- | --- |
| 声门下压 `PR` | **`Pa`**（`0.0 .. 1600.0 Pa`，越界拒绝不夹紧） | **`dPa`**（`0.0 .. 16000.0 dPa`，`dPa = Pa * 10`） |
| 基频 `F0` | **`Hz`**（调度/编辑合法范围 `60.0 .. 600.0 Hz`；声道反演与原生底层契约 `40.0 .. 600.0 Hz`） | **`Hz`**（`normalize_f0_m27` 使用对数归一化 `ln(F0)` 映射到 `[-1, 1]`） |
| 音频采样率与时间 | `48000 Hz` 整数采样 `_smp`，半开区间 `[start_smp, end_smp)` | VTL 合成输出 `48000 Hz`；`Vox2Tract-Lite` / `Vox2Align-Lite v2` / `Tract2Vox-Lite` 内部特征与生成 `16000 Hz`（密轨合成路径升频至 `48000 Hz`） |
| 控制帧率 | 自由手绘/调度密数组（不受 201 点限制） | `Vox2Tract-Lite` / `Tract2Vox-Lite` / `IPA2Tract-Lite` / `Vox2Align-Lite v2` 统一 **`50 Hz`**（hop `320 @ 16k` = `960 @ 48k` = `20 ms/frame`）；VTL 原生管段步长 `200 Hz` / `5 ms` |
| `m27` 27 维向量 canonical 顺序 | 统一按物理单位对象或 `Float32Array` 传递 | `[0..16]` 17 维声道 `HX, HY, JX, JA, LP, LD, VS, VO, TCX, TCY, TTX, TTY, TBX, TBY, TS1, TS2, TS3`；`[17]` `F0`；`[18]` `PR (dPa)`；`[19..26]` 8 维声门/微扰 `XB, XT, CA, LAG, RA, PS, FL, SHIM` |

**JD2 19 维与 17 维声道映射**：JD2 原生声道参数共 19 维，其中 `TRX`（下标 14）与 `TRY`（下标 15）在非 `manual_root` 模式下由引擎自动计算；`TRACT_17_TO_19_IDX = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,16,17,18]`。

**声门帧维数与数值溢出校验（`engine/validation.py`）**：
- `glottis_frames` 标准契约为 **8 维** `[xb_cm, xt_cm, ca_cm2, lag_rad, ra, ps, fl, shim]`；为保持向后兼容，校验器与下游桥接层（`dense_channel` / `m27_bridge` / `keyframe_lite`）接受历史 **7 维输入**并统一按缺省 `shim = 0.0` 处理。
- 数值转换会拦截布尔值、`NaN/Inf` 以及超大 JSON 整数引发的 `OverflowError`，一律返回 HTTP `400` 标准 `out_of_range` 契约 JSON，不落入 500。

**音量增益、超时、引擎锁与跨站安全契约**：
- 合成和重合成请求可加 `audio_gain`（`peak` | `original`）。使用 `peak` 时在边界淡入淡出和静音处理完成后将整条波形按同一倍率归一至 `0.8` 绝对峰值（静音保持原电平）；`original` 保留引擎处理后电平；省略时沿用各路由默认值。
- **超时分级**：Node 代理默认转发超时 `120 s`，`/api/m27/reconstruct` 放宽至 `185 s`（匹配前端适配器 `180 s` 超时）；Python 引擎 HTTP socket 超时为 `200 s`。
- **说话人锁超时**：VTL 原生引擎按说话人加锁，默认等待 `VOCALCUT_ENGINE_LOCK_TIMEOUT_S = 30.0 s`；超时抛出 `EngineBusyError` 并返回 HTTP `503` `{ ok: false, error: { code: "engine_busy", field: "speaker", value: speaker, hint }, hint }`。并行分块（`_run_chunk` / `_exec_block`）与 `lease` 均在 `try/finally` 中复位 `section_count`、`perturbation` 与 `flutter`。
- **回环来源防护与引擎令牌**：`server/proxy.mjs` 默认仅绑定 `127.0.0.1`（非回环需显式 `VOCALCUT_ALLOW_NON_LOOPBACK=1`），代理与引擎均强制校验回环 `Host` 白名单、拒绝 `Sec-Fetch-Site: cross-site`、校验白名单 `Origin`（及非 GET 无 Origin 时的 `Referer`），拒绝 `text/plain` / `application/x-www-form-urlencoded` / `multipart/form-data`（HTTP `415`），JSON 写路由强制 `Content-Type: application/json`。开发态 `scripts/start-engine.mjs` 未显式设置 `VOCALCUT_ENGINE_TOKEN` 时自动生成 32 字节随机令牌写入 `.cache/local-engine.token`（权限 `0o600`，退出自动清理），代理按 `VOCALCUT_ENGINE_TOKEN` → `.cache/local-engine.token` 顺序读取并附带 `X-VoxFigura-Engine-Token` 请求头。
- **便携缓存与更新检查接口（代理侧）**：
  - `/api/portable/cache*` 仅在便携运行时（设置 `VOCALCUT_PORTABLE_ROOT`）开放，非便携态统一返回 HTTP `404`；清理严格走白名单（已知版本目录且含 `bundle-manifest.json`、`.u-*`、`*.incomplete-*`、已知版本 `.lock`），其余标为 `foreign` 永不删除，并跳过持锁（`locked: true`）实例；文件夹选择器通过环境变量 `VF_INIT_DIR` 传入 `-LiteralPath`，避免脚本拼接注入。
  - `GET /api/app/update-check` 仅使用 HTTPS 清单地址（默认 `https://www.phonetictoolbox.com/voxfigura/updates/latest.json`，无明文 HTTP 回落），并校验清单内 `download_url` / `page_url` 属于 HTTPS 白名单域名及 `sha256` 为 64 位十六进制。

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
  - **边界校验**：`f0_hz`、`pressure_pa`、`tract_frames`、`glottis_frames`、`lip_width_frames`、`larynx_height_frames`、`shimmer`、`flutter`、`fps` 任何维度越界、出现 `NaN/Inf`、超大整数溢出或布尔误传，均直接返回 `400` `{ "ok": false, "error": { "code": "out_of_range" | "validation_error", "allowed": ..., "hint": ... } }`，严禁静默夹紧。
  - **响应**：返回 `48000 Hz` `wav_base64`、`duration_s`、`sample_rate_hz: 48000`、`synth_mode`、`source_badge` 及可选 `geometry_frames` / `m27_control_50hz_pa` / `tract_control_50hz`。
- `POST /vtl/synthesize-stream`：低首字延迟流式分段合成通道，接收与 `/vtl/synthesize` 相同的请求体（支持 `synth_mode: "neural" | "physical"` 与 `predict_articulation`），以 `application/x-ndjson` 分块传输（依次推送 `meta` → `chunk 0..K-1` → `done`）；由 `server/proxy.mjs` 透明流式转发（`X-Accel-Buffering: no`）。
- `POST /vtl/live-pull`：在按说话人隔离的实时 VTL 2.4 会话上拉取连续 `1..12` 块（每块 960 采样 @ 48 kHz）实时声道音频。接收 `speaker`、`blocks`（1..12）、`reset`（布尔）、`params`（19 维）与声门控制；当 `rel_amp <= 0`（清音帧、无周期声带振动）时，内部 VTL 声门 `g[0]` 置为 `125.0 Hz` 作为中性占位，不影响清音声学输出。
- `POST /vtl/batch-contours`：批量提取 `1..64` 帧 19 维构型（`speaker`、`poses: number[][19]`）的真实 VTL 2.4 正中矢状面轮廓、`oral_min_area_cm2` 与 `F1/F2/F3`（用于连续统矩阵等批量视图）。
- `POST /vtl/high-pitch-preview` 提供持续元音高音试听后端接口（前端独立试听面板已撤下，后端路由与单测继续保留）。
  - **请求**为 `vowel`（`a`、`i`、`u`）、`target_f0_hz`（550–800 Hz）和 `duration_ms`（300–3000 的整数）。使用 JD2 定姿元音和 800 Pa 声门下压。引擎从目标基频与原生上限的较低值开始，随后尝试更低的 10 Hz 档位，并核查稳态区间的基频与周期性。
  - **响应**包括 48 kHz 单声道 `wav_base64`、`sample_count`、物理载波的指令与实测基频、输出实测基频，以及 `method`（`vtl` 或 `td-psola`）。移调时另返回等长的原始 `carrier_wav_base64` 供对听。
  - **移调方法**在时域移动按基音周期提取的波形片段，保持时长，尽量保留原频率轴上的谱包络。高基频下谐波间隔变大，同一谱包络也可能呈现不同的谐波幅度。该接口用于持续元音；编曲和神经声道轨迹支持任意正有限基频（`> 0 Hz`），VTL 2.4 物理引擎保留 `40..600 Hz` 原生硬件声门边界。[Moulines 与 Charpentier（1990）](https://doi.org/10.1016/0167-6393(90)90021-Z)

---

## 2. 声道反演、引导对齐与转写

### 2.1 来源与零 PyTorch 懒加载隔离
- 便携版将 Batch-2 联合权重组入 `engine/model_bundle/models/Vox2Tract-Lite/vox2tract_lite.onnx`，由 `Vox2TractAlign v4` 对齐头完成普通话、英语引导对齐。`Vox2Align-Lite v2` 为独立兼容槽位，允许挂载方言或其他语种的外置模型。权重使用 ONNX Runtime 推理。 [入包锁文件](../scripts/portable/inputs.lock.json)
- 声学前端：`engine/onnx_frontends.py` 提供纯 NumPy/SciPy 的 `PureLogMel50Hz`（16 kHz，Slaney 80-Mel，`n_fft=1024`，`win=640`，`hop=320`，逐句归一化 + 一阶差分 + 3 维能量 + 3 维发声态线索）+ `SwiftF0` ONNX（46.875..2093.75 Hz）。超过 `9.6 s` 的音频经 `plan_silence_chunks` 按静音分块，推理后拼接结果。联合权重在同一次前向中给出反演轨迹与对齐头，启用外置独立对齐模型时由外置槽位接管对齐。
- **懒加载与热插拔隔离**：8 个核心槽位和 1 个独立兼容槽位由 `engine/model_registry_runtime.py`（`LocalModelManager`）统一按需创建和释放 `onnxruntime.InferenceSession`；首次调用 `/vtl/*`（未触发神经模块）不加载 ONNX 会话。卸载中的模型被调用时返回 `503` `{ "ok": false, "error": { "code": "model_unloaded", "model": "...", "hint": "..." } }`。

### 2.2 HTTP JSON Schema
- `POST /m27/reconstruct`：传入 `wav_base64`、`text?`、`lang?`、`alignment_mode?`、`synth_mode`、`device`，返回 50 Hz `m27_50hz_pa`（`PR` 已换算为 `Pa`）、`tract_glottis_anim`、`vtl_48k_wav_base64`、`neural_16k_wav_base64` 与 `alignment`。
- `POST /m27/extract-anim`：传入 50 Hz `m27_50hz_pa`（1..3000 帧，`F0` 须为正有限值 `> 0 Hz`）与 `fps`（5..50，默认 25），严格校验并在引擎内换算 `dPa` 后返回 `{ ok: true, anim }` 矢状面与声门动画序列。
- `POST /m27/realtime-speaker`：传入 `speaker_wav_base64`（或 `speaker_ref_wav_base64`），基于 `Vox2Spk-Lite` 预提取并缓存 512 维音色嵌入，同时用 `SwiftF0` 估算参考音色的有效浊音中位基频，返回 `{ ok: true, speaker_key, cached, extract_ms, median_f0_hz }`（无法提取时 `median_f0_hz` 为 `null`）。
- `POST /m27/realtime-step`：低延迟滑窗实时声道反演与神经音色合成单步接口；接收滑窗 16 kHz PCM 音频、`session_id`、`speaker_key?`、`include_tract_geometry`、`use_timbre_model`、`synthesize_audio` 与可选预热标记 `warmup`（`warmup_window_frames` 12..100），输出 50 Hz 控制帧、可选 2D/3D 声道几何及带 15 ms 交叉淡入重叠加长的 16 kHz 音频块。
- `POST /m27/align`：传入 `wav_base64` 与原文 `text`，返回 `alignment`（TextGrid 与音素/音节区间）。
- `POST /m27/transcribe` 使用本地 SenseVoice-Small。请求含 `wav_base64`（80 ms–60 s）、可选 `lang`（`auto`、`zh`、`en`、`ja`、`ko`、`yue`）、`model`（`sensevoice-small`）及 `device`（`cpu`）。成功返回 `{ ok, text, lang, model, device_effective, duration_s }`。缺少运行库或权重时返回 `503 model_unavailable`，无语音时返回 `400 no_speech`，另有识别任务运行时返回 `409 asr_busy`。
- `POST /api/ai/deepseek-asr`：Node 代理接收 `audio/wav` 与本页 AI 助手的 DeepSeek BYOK 请求头，调用 [DeepSeek 语音识别接口](https://api-docs.deepseek.com/zh-cn/guides/asr/) 并返回 `{ ok, text }`。在设置中启用后，点击「自动识别文本」发送当前录音的 16 kHz 单声道 PCM WAV。DeepSeek 自动判断语种，单次上限为 120 秒、8 MiB。

### 2.3 按需安装本地语音识别

开发态和 Windows 便携版默认开放 SenseVoice-Small 下载与转写路由。开发时可在引擎环境设 `VOCALCUT_DISABLE_LOCAL_ASR=1` 关闭。便携版复用包内 NumPy 与 ONNX Runtime，模型及词表由用户按需下载。 [Windows 打包规范](./PACKAGING_WINDOWS.md)

- `GET /m27/asr-install?model=sensevoice-small` 返回模型列表及 `missing`、`installing`、`ready` 或 `failed` 状态，可附下载进度和提示。前端经 `/api/m27/asr-install` 调用，`GET /health` 的 `speech_to_text` 字段亦报告可用状态。
- `POST /m27/asr-install` 接收 `{ model?, action? }`，默认模型为 `sensevoice-small`，默认动作 `install`。后台下载返回 `202`，已经就绪返回 `200`。`action: "remove"` 移除缓存中的模型，下载期间返回 `409`。
- 下载器按地区在 HF-Mirror、ModelScope 与 Hugging Face 间切换，并校验文件大小和 SHA-256。权重与词表存到 `VOCALCUT_ASR_CACHE_DIR` 下的 `sensevoice-small/`，开发态默认为 `.cache/asr/`，便携版默认为 `%LOCALAPPDATA%/VoxFigura/ASR/`。研发可执行 `npm run setup:asr` 预下载，引擎支持 `VOCALCUT_ASR_DOWNLOAD_HOST` 与 `VOCALCUT_ASR_MODEL_DIR` 覆盖下载源和已有模型目录。

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
  - `cond` 为 float32 @ 50 Hz，Batch-2 v4 形状为 `(B, T, 121)`，旧版权重为 `(B, T, 111)`（含 26 维 3 阶 qTA 异步基线 `x_base_26`、掩码目标 `g_masked`、26 维器官锁 `w_mask`、对数 `f0_norm`、5 维相位含显式 `is_sil`、4 维阻塞事件、音标构音特征（v4 为 32 维，旧版为 22 维）、`has_phon`）。
  - `x_base_26: (B, T, 26)` float32（`M27` 剔除只读 `F0` 列 17）与协同强度 `alpha`（`0..1`）。
- **`Tract2Area-Proxy`**：输入 `tract17_norm: (..., 17)`，输出 `log1p(area_cm2)` 6 区预测。
- **链路 B 调用约定与兼容路由**：`/vtl/synthesize`（开启 `predict_articulation`）和 `POST /models/ipa-default-poses` 使用同一 `PoseBank`。采用当前 IPA 构型的片段通过 `pose_source: "custom"` 和 `articulation_spans[].pose_target_19` 传入编辑器保存的 19 维目标。引擎在音段中心对主要发音器官应用余弦过渡，对塞音优先使用实录闭塞及释放相位，并用 `Tract2Area-Proxy` 检查局部收窄。模型默认值和显式编辑分别沿用默认相位目标及手动约束。`GET /models/kf2tract`（探测权重就绪）与 `POST /models/kf2tract`（使用历史字段名 `cond_111`，接受 111 或 121 维条件帧，返回协同构音和 `Tract2Area-Proxy` 截面积结果）均为 **`IPA2Tract-Lite` 的历史兼容路由名**。

---

## 5. `Text2Prosody-Lite`、语音分析/迁移与参考库路由（已就绪）

### 5.1 `Text2Prosody-Lite`（中英自然韵律预测）

- 权重（ONNX）：`models/Text2Prosody-Lite/text2prosody_lite.onnx`。
- `POST /models/text-prosody`：接收中英混排文本及可选参数 `lang`、`base_f0`、`speed_scale`、`pitch_scale`、`f0_min_hz`（可选正值下界保护，默认不额外夹紧上限），返回 `syllables`、`keyframes`（含显式 `sil`）与 `f0_knots`。
- **模型输出后处理语义**：对模型原始预测仅保留正有限值护栏（不再对高于 600 Hz 或低于 60 Hz 的合法预测做硬截断），并通过响应字段 `f0_floor_hz` 与 `f0_adjusted_count` 显式回报可选下界调整。

### 5.2 声音调制/迁移、降噪、基频前端与参考库路由

- **时变发声态调制与双人声音迁移（`engine/voice_morph_bridge.py`）**：
  - `GET /models/voice-morph`：返回内置与用户自定义发声态预设元数据。出口预设在 Python 引擎边界统一完成 `dPa → Pa` 换算，返回 `source9_phys_pa`（长度 9，第 0 维 `pr_pa` 范围 `0..1600 Pa`）及具名对象 `source_params: { pr_pa, xb_cm, xt_cm, ca_cm2, lag_rad, ra, ps, fl_pct, shim_pct }`，不再对外暴露未带单位的 `dPa` 数组。
  - `POST /models/voice-morph`：分发时变发声态分析、曲线调制与预设保存/删除操作。
  - `POST /models/voice-transfer`：执行双人声道/声门/基频/音色多器官迁移渲染（`speaker`、`tract_all`、`glottis`、`f0_pr`）。
- **降噪与基频提取（ONNX CPU）**：
  - `POST /models/dpdfnet?audio_gain=peak|original`（请求体为原始 WAV 字节）：调用 `DPDFNet` 对 48 kHz 音频按声道降噪，返回 `audio/wav`。
  - `POST /models/swift-f0`（请求体 JSON `{ pcm16le: string }`，20 ms–120 s 的 16 kHz 单声道 PCM）：调用 `SwiftF0` ONNX 提取 50 Hz（`step_ms: 20`，原生范围 `46.875..2093.75 Hz`）基频轨迹，返回 `{ model: "SwiftF0", step_ms: 20, duration, hz }`。
- **IPA / VoQS 正式参考库、逐帧校正与全库打包导出**：
  - `GET /models/ipa-references/index`：返回全部已索引 IPA/VoQS 实录与时间原点元数据。
  - `GET /models/ipa-references/poses`：返回参考库已校构型列表；`GET /models/ipa-references/trill-demos` 返回颤音合成演示列表。
  - `GET /models/ipa-references/vowel-formants?source=recorded|transfer&speaker=JD2`：返回 28 个元音的实录 Burg 共振峰测量或当前 VTL 解剖模型传递函数测量；`POST /models/ipa-references/vowel-poses` 实时测算保存构型的传递函数共振峰。
  - `GET /models/ipa-references/<id>/(audio|animation|reconstruction|bundle|bundle-video)?audio_gain=peak|original`：读取指定实录的音频、反演动画、`Tract2Vox-Lite` 重建音或单音资料包（可选附声带视频）。
  - `GET /models/ipa-references/<id>/(voqs-track|voqs-reconstruction)?speaker=...&height_cm=...&audio_gain=peak|original`：读取 VoQS 50 Hz 声门反演轨或原生 VTL `[ə]` 管腔重合成音。
  - `GET /models/ipa-references/library-bundle`、`POST /models/ipa-references/library-bundle`、`GET /models/ipa-references/library-bundle/download`：查询、触发异步构建与流式下载全库 ZIP 资料包（支持 `video=0|1`、`audio_gain=peak|original`）。
  - `GET /models/ipa-recording-edits/limits`、`POST /models/ipa-recording-edits/render`：返回实录逐帧关键帧校正的 27 维边界（`F0 > 0 Hz`、`PR 0..1600 Pa`）并按关键帧局部混合后重渲染整轨。

---

## 5.5 本地 ONNX 模型热插拔与外置权重装载接口

- `GET /health`：返回引擎运行状态（`vtl`、`m27`、`speech_to_text` 与本地模型就绪信息）。
- `GET /models/local`：返回 9 个模型注册槽位的体积、参数量、装载状态（`loaded`、`in_memory`）、外置来源标记（`is_external`、`external_label`）及 ONNX Runtime 运行时信息。
- `POST /models/local/load`：接收 `{ "name": string, "eager"?: boolean, "device"?: "cpu" | "cuda" }` 或 `{ "all": true }`，启用并按需立即载入 `InferenceSession`。
- `POST /models/local/unload`：接收 `{ "name": string }` 或 `{ "all": true }`，立即释放内存中的 `InferenceSession` 并停用该槽位。
- `POST /models/local/mount`：接收 `{ "name"?: string, "path"?: string, "folder_path"?: string, "eager"?: boolean }`，校验目标 `.onnx` 张量输入输出契约后挂载单个外置文件或批量扫描整个文件夹。
- `POST /models/local/mount-binary`：接收原始 `.onnx` 二进制请求体（查询参数 `name`、`filename`、`eager`），校验契约并持久化至 `.cache/custom-models/` 后热切换。
- `POST /models/local/reset`：接收 `{ "name": string }` 或 `{ "all": true }`，恢复默认内置 ONNX 模型。

> 注册表维护 8 个核心 ONNX 槽位和独立 `Vox2Align-Lite v2` 兼容槽位。Windows 便携包只内置 8 个核心槽位的权重。早期 `501` 扩展空槽已清理，`/models/kf2tract` 保留为 `IPA2Tract-Lite` 的历史兼容路由名（见 §4.1）。

---

## 6. Batch-2 兼容扩展与国际音标神经合成冻结快照（2026-11-27）

为保护已验收的国际音标与神经语音合成听感形态，以下接口扩展与冻结约束与 [AGENTS.md §6](../AGENTS.md) 保持单一真源同步，未经授权禁止回退或破坏：

- **`Vox2Tract-Lite` 联合单次前向契约**：`engine/model_registry_runtime.py` 同时接受传统 4 输出与 Batch-2 联合 11 输出（在 `tract17 / pr1 / glot8 / h_backbone` 基础上附带 7 路对齐头）；使用联合权重时，`engine/onnx_inference.py` 可在单次前向中完成声道反演与对齐。旧四输出权重的引导对齐需要可用的独立槽位。联合输出的 `model_meta.version` 按文件名标记，含 `v4` 时为 `joint-v4`，否则为 `joint-v3`。包内文件名统一为 `vox2tract_lite.onnx`，核对实际权重版本时查 [入包锁文件](../scripts/portable/inputs.lock.json)。
- **`IPA2Tract-Lite` 121ch / 32d 与窄标构型库联动**：挂载 121 通道外置权重时，`engine/keyframe_lite.py` 自动加载同目录 `canonical_ipa_poses_narrow.json`（293 键）并启用 32 维特征，严禁与旧 78 键构型或 22 维特征混用。
- **`Text2Prosody-Lite` 32d 与无标调 `[IPA]` 韵律直通**：支持 `LANG_IPA=3`（32 维特征输入）及可选 `base_f0` 参数；前端将无显式声调记号的 `[IPA]` 片段按 VoQS 作用域切分送入自然韵律预测。
- **参考音色自动匹配基频与 VoQS 假声叠加顺序**：前端按 `speechRegisterRatio = effectiveSpeakerBaseF0Hz / referenceHz` 在 `evaluateControlPitch` 的 `applyVoqsRegister` 之前执行一次性平移，仅作用于神经语音合成（不对歌唱轨、实录反演参考轨与 VTL 物理合成生效）；`isAutomaticProsodyPin` 同时兼容单句与多句前缀 `s<n>_prosody`。
