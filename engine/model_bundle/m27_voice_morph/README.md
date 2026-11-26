# `m27-voice-morph` — PhonoTract Studio 时变发声态与多器官移植模块

隶属 `PhonoTract Studio · IPA · Glottis · Vocal Tract`，搭载自研模型家族 `PhonoTract Core`（**`Vox2Tract`** / **`Tract2Vox`** / **`Vox2Spk`**）的独立可打包、CPU 安全（零 VRAM 占用，不干扰后台 GPU 训练）语音时变调制模块，包含 Python SDK、REST HTTP API 与基于 CSS 变量的统一可换肤前端（零前端构建步骤，可直接嵌入黑客松网页并一键改风格）。

## 两大核心玩法

1. **玩法一 · 免对齐发声态时变调制 (`apply_preset_phonation_morph`)**
   - 载入或现场录制任意语音，经 **`Vox2Tract-Lite`**（端侧零底座声道反演，或大模版 **`Vox2Tract-Large`**）反演为 50 Hz 物理 M27 轨迹；
   - 选择 7 种标定内置发声态预设（常态 / 气声 / 紧嗓 / 嘎裂 / 假声 / 耳语 / 清化）或直接从自己录音提取并持久化自定义发声态；
   - 拖动或精确打点编辑时变曲线 `w(t) ∈ [0, 1]`，逐帧控制每个时间点保留原发声态与切换至目标发声态的比例。
2. **玩法二 · 双人对齐多器官与音色时变移植 (`apply_dual_speaker_morph`)**
   - 载入同一句话的两位说话人录音（A 与 B），支持自动构音特征 Sakoe-Chiba DTW 对齐或 Praat / MFA TextGrid 边界锚点对齐；
   - 为 8 个解剖/声学控制组独立绘制时变曲线：`glottis`（声门 8 维）、`f0_pr`（音高与肺压）、`tract_all`（整套 17 维声道）、`lips`、`velum`、`larynx`、`tongue_jaw`（强耦合组默认支持相对偏移移植防止舌腭穿模）、`speaker`（经 **`Vox2Spk-Lite`** 提取 512 维音色向量逐帧球面插值 SLERP，免重训驱动 **`Tract2Vox-Large`** 真人声道声码器 / 神经赋声）。模型正式命名规范参见 `../docs/MODEL_NAMING_SPEC.md`。

## 内置声学保护与实验控制开关

- **带声与静音软门控 (`enable_voicing_gate=True`)**：保护清辅音（`/s/ /t/ /p/`）与静音段不被误加声门振动；当目标为耳语或清化时自动切换为语音活动软门控。
- **轻度防爆音时间平滑 (`smooth_ms=25.0`)**：对 50 Hz 曲线施加高斯平滑，消除曲线突变导致的相位咔哒声。
- **可选 F0 联动开关 (`enable_f0_coupling=False`)**：默认关闭以保证严格单一变量语音学实验；开启后按曲线对数平滑移动音高（玩法一采用预设推荐或自定义半音偏移，玩法二将 A 的中位音高平滑靠向 B 的音域同时保留 A 的局部声调轮廓）。
- **曲线节点选中与精确微调**：支持鼠标点击加点、拖拽、双击删点、点选任意控制点后直接输入精确时间（秒）与权重（%）、手动打点以及画布键盘方向键 `↑↓←→`（`Shift` 5 倍步进）微调。

## 快速启动（本机独立预览）

```powershell
powershell -ExecutionPolicy Bypass -File F:\TensorTract3_Train\m27_voice_morph\start_voice_morph.ps1
```

默认监听 `http://127.0.0.1:18798/`（纯 CPU 推理，不占用显卡显存）。

## 打包安装与 Python SDK 用法

```powershell
& 'F:\TensorTract3_Train\.venv\Scripts\pip.exe' install --no-deps -e F:\TensorTract3_Train\m27_voice_morph
```

```python
from pathlib import Path
from m27_voice_morph import VoiceMorphEngine, PresetMorphConfig, DualMorphConfig

engine = VoiceMorphEngine(train_root=Path(r"F:\TensorTract3_Train"), device="cpu")
clip = engine.analyze_audio(Path(r"F:\TensorTract3_Train\runs\eval_samples\zh_tones_01__ref.wav"))

res = engine.render_preset_morph(
    clip,
    PresetMorphConfig(
        preset_id="breathy",
        knots=[{"t": 0.0, "v": 0.0}, {"t": 1.0, "v": 0.9}],
        enable_voicing_gate=True,
        smooth_ms=25.0,
        enable_f0_coupling=False,
    ),
)
# res["wav"] 为 16 kHz / 48 kHz float32 音频，res["sr"] 为采样率
```

## 接入黑客松网页并自定义换肤

1. 引入 `web/theme.css`、`web/studio.css`、`web/curve-editor.js`、`web/studio.js`。
2. 在你的页面容器中挂载：

```html
<div id="hackathon-morph-slot"></div>
<script>
  window.M27VoiceMorphStudio.mount("#hackathon-morph-slot", {
    apiBase: "http://127.0.0.1:18798",
    theme: "dark" // 或 "light"
  });
</script>
```

3. **换肤方式**：无需修改任何业务 JS 或布局 CSS，只需在黑客松自己的 CSS 中覆盖 `theme.css` 里的 `--vm-*` 变量（如 `--vm-bg`、`--vm-surface`、`--vm-accent`、`--vm-curve-eff`、`--vm-radius`、`--vm-font`）即可瞬间统一成项目视觉风格。
