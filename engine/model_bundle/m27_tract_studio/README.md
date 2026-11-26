# `m27-tract-studio` — PhonoTract Studio 声道与声门动态重构模块

`PhonoTract Studio · IPA · Glottis · Vocal Tract` 的独立可打包声道动态重构模块（Python SDK + CORS REST API + 零构建前端换肤组件），搭载自研模型家族 `PhonoTract Core` 中的 **`Vox2Tract-Large`** 与 **`Tract2Vox-Large`**，面向黑客松与多模型串联集成场景，默认纯 CPU 安全运行。

## 核心能力

- **音频上传、拖拽与现场录音**：支持 `wav / mp3 / flac / ogg / m4a / aac / webm / mp4` 上传或浏览器麦克风 16 kHz PCM16 现场录制。
- **语音学友好音频降噪 (`denoise.py`)**：内置零相位 4 阶高通滤波与 Ephraim-Malah MMSE-LSA 谱减降噪（`light / standard / strong` 三档预设），一键对比试听原声与降噪版、查看底噪抑制与 SNR 提升指标，并支持重构前自动降噪。
- **完整 M27 27 维声道轨迹重构与双端重合成 (`engine.py`)**：内置调用 **`Vox2Tract-Large`**（原 Stage 4 `DualBranchMotor27` 声道反演）+ **`Vox2Tract-PR`**（肺压感知）+ **`Tract2Vox-Large`**（原 Stage 5 `Glottis-NSF v3` 真人声道声码器 / 神经赋声）与原生 VTL JD2 声管引擎（支持 `tract2vox_large` / `vox2tract_large` 与旧版 `neural_best` / `motor_natural` 等别名）；同时输出 50 Hz 物理控制轨迹 `controls_m27.npz (T, 27)`、神经赋声 `neural_16k.wav`（支持跨说话人音色参考）与 48 kHz R21 物理重合成 `m27_48k.wav`。模型统一命名详见 `../docs/MODEL_NAMING_SPEC.md`。
- **原位同源动态可视化 (`tract-renderer.js`)**：M10 正中矢状面声道 SVG（含平滑舌底与残影/标注控制）+ 超拟真解剖声带 Canvas（俯视 + 冠状面黏膜波/声门下气流，支持频闪慢放与真实频率曝光残影）+ 7 轨物理曲线 Canvas（全部 7 轨 / 口腔 3 轨 / 声门 4 轨切换 + 曲线点击拖拽跳转）+ 历史记录、一键批量重合成、平铺全部历史播放器。
- **统一可一键批量换肤前端 (`theme.css`)**：所有视觉样式完全受 CSS 变量控制，零构建工具依赖，改一处变量即可与黑客松项目以及兄弟模块 `m27-voice-morph` 批量统一皮肤。

## 目录结构

```text
m27_tract_studio/
  pyproject.toml
  start_tract_studio.ps1
  src/m27_tract_studio/
    __init__.py
    config.py
    denoise.py
    engine.py
    server.py
  web/
    index.html
    theme.css
    tract-studio.css
    tract-renderer.js
    tract-studio.js
  tests/
    test_tract_studio.py
```

## 快速启动（独立预览服务）

```powershell
powershell -ExecutionPolicy Bypass -File F:\TensorTract3_Train\m27_tract_studio\start_tract_studio.ps1
```

默认监听 `http://127.0.0.1:18799/`（自动接入已有 `runs\m27_v1\web_infer` 历史记录；如需隔离独立目录，可传 `-WorkDir C:\path\to\workspace`）。

## 打包安装与 Python SDK（供其他模型直接调用）

### 1. 复制与安装

将整个 `m27_tract_studio/` 目录复制到目标项目，执行：

```powershell
pip install --no-deps -e ./m27_tract_studio
```

也可以设置环境变量覆盖路径（跨机器/黑客松目录移动时非常实用）：

- `M27_TRACT_TRAIN_ROOT`：含 `src/tt3` 与 `runs/m27_v1` 的模型目录（默认 `F:\TensorTract3_Train`）
- `M27_TRACT_RUN_ROOT`：模型检查点目录（默认 `<train_root>/runs/m27_v1`）
- `M27_TRACT_WORK_DIR`：任务输出目录（未指定时，若存在 `web_infer` 则沿用，否则在模块下自动新建 `workspace/jobs`）
- `M27_TRACT_PTB_ROOT`：原生 VTL 与 SwiftF0 资源目录（默认 `d:\PhoneticToolbox\PhoneticToolbox_v3`）

### 2. Python SDK 示例

```python
from pathlib import Path
from m27_tract_studio import TractReconstructionEngine, TractStudioConfig

engine = TractReconstructionEngine(
    TractStudioConfig(
        train_root=Path(r"F:\TensorTract3_Train"),
        work_dir=Path("./hackathon_jobs"),
        default_device="cpu",
    )
)

# 1) 单独调用语音学友好降噪
dn = engine.denoise_audio(Path("noisy.wav"), preset="standard")
print(dn["metrics"])  # {'snr_before_db': ..., 'snr_after_db': ..., 'noise_reduction_db': ...}

# 2) 端到端：降噪 + 27 维声道反演 + VTL 48k + Stage 5 重合成
job = engine.reconstruct_audio(
    Path("input.wav"),
    checkpoint="neural_best",
    denoise=True,
    denoise_preset="standard",
)

# 3) 读取完整 50 Hz (T, 27) 物理控制矩阵与 25 fps 矢状面动画数据给下游模型使用
controls = engine.get_job_controls(job["job_id"])       # controls["m27_50hz"]: np.ndarray (T, 27)
anim = engine.extract_animation(controls["m27_50hz"], fps=25)
```

## HTTP REST API 一览

- `GET /api/health`：配置路径、可用检查点与模型常驻缓存诊断
- `GET /api/meta`：可用模型清单、降噪预设、主题清单与限制参数
- `GET /api/state`：后台运行状态与历史重构任务列表
- `POST /api/denoise?preset=standard`：上传音频并立即返回原声/降噪 16k 对比试听 URL 与 SNR 指标
- `POST /api/reconstruct?checkpoint=neural_best&device=cpu&denoise=1`：提交异步声道重构与合成任务
- `POST /api/resynth?checkpoint=neural_best&job_id=...`：单条或一键全部重合成历史记录
- `GET /api/jobs/{job_id}/anim?fps=25`：获取 JD2 矢状面轮廓 + 声门动画 JSON (`m27_anim_v3`)
- `GET /api/jobs/{job_id}/controls?format=json|npz`：获取 50 Hz 27 维物理轨迹数组
- `GET /api/jobs/{job_id}/audio/{file}`：WAV 音频流（完整支持 HTTP `Range 206` 拖动进度与 `?download=1`）

## 嵌入黑客松网页并一键批量更换风格

### 1. 前端页面接入

```html
<link rel="stylesheet" href="/tract_web/theme.css" />
<link rel="stylesheet" href="/tract_web/tract-studio.css" />

<div id="hackathon-tract-slot"></div>

<script src="/tract_web/tract-renderer.js"></script>
<script src="/tract_web/tract-studio.js"></script>
<script>
  const studio = window.M27TractStudio.mount("#hackathon-tract-slot", {
    apiBase: "http://127.0.0.1:18799",
    theme: "ivory",        // 可选: "ivory" | "midnight" | "slate" | "rose"
    showHeader: true,
    showThemePicker: true,
    showHistory: true
  });
</script>
```

### 2. 一键批量更改整站风格

本模块样式令牌 `--ts-*` 已自动优先读取宿主 `--hackathon-*` 与兄弟模块 `m27-voice-morph` 的 `--vm-*` 变量。因此在黑客松全站主样式里统一声明一次变量（或调用 JS API），就能一键把所有页面风格统一起来：

```css
/* 方法一：CSS 令牌一处覆盖，m27-tract-studio 与 m27-voice-morph 同时生效 */
:root {
  --hackathon-bg: #0f172a;
  --hackathon-surface: #1e293b;
  --hackathon-border: #334155;
  --hackathon-text: #f8fafc;
  --hackathon-accent: #38bdf8;
  --hackathon-radius: 14px;
}
```

```js
// 方法二：JS 运行时一键切换全页已挂载实例主题
window.M27TractStudio.setGlobalTheme("midnight");
window.M27TractStudio.applyGlobalTokens({
  "--ts-accent": "#2563eb",
  "--ts-radius": "16px"
});
```
