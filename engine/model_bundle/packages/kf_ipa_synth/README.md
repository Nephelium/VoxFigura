# kf_ipa_synth

`kf_ipa_synth` 是从 KF2Tract27 实验中抽离出来的独立、可打包 IPA 语音合成模块，包含四大核心部分：

1. **零外部耦合 Python 推理核心**：支持中/英/日/内联 `[IPA]` 转写、IPA 2020 附加符号合法性校验、常驻内存 `KF2Tract27` 动态声道预测、1 KB 轻量声纹档案库 (`SpkLite`)、Stage 5 零底座神经声码器 (`Stage5Lite`) 及可选 VTL R21 物理合成后端。
2. **框架无关 HTTP / FastAPI 接口**：既可用内置零依赖服务直接启动，也可五行代码挂载到黑客松的 FastAPI 或任意后端框架。
3. **统一设计风格与一键批量换肤前端**：所有样式严格限定在 `.kfs-root` 作用域内，通过 `--kfs-*` Design Token 和 `KFSTheme` 实现一键切换预设或批量覆写品牌色，全部 Canvas 视图同步重绘。
4. **关键帧 ↔ 声道双向联动接口 (`TractKeyframeBridge`)**：时间轴关键帧与任意 2D/3D 声道编辑器解耦通信，支持通过声道界面微调关键帧的 27 维构型并自动钉住对应器官掩码。

完整集成与接口协议说明请阅读 [docs/INTEGRATION_AND_TRACT_BRIDGE.md](docs/INTEGRATION_AND_TRACT_BRIDGE.md)。

---

## 一、一分钟复制到黑客松项目

直接将整个 `kf_ipa_synth/` 文件夹复制到你的黑客松工程目录，然后任选一种方式引入：

```bash
# 方式 A：标准可编辑安装（推荐，其他模块直接 import kf_ipa_synth）
pip install -e ./kf_ipa_synth

# 若需要英文 CMUdict / 日语重音 / 汉语 pypinyin 增强词典
pip install -e "./kf_ipa_synth[lexicon]"

# 方式 B：免安装，直接把文件夹加入 PYTHONPATH / sys.path
```

### 目录结构

```text
kf_ipa_synth/
├── pyproject.toml                       # 标准 PEP 621 打包配置
├── README.md                            # 本快速上手说明
├── docs/
│   └── INTEGRATION_AND_TRACT_BRIDGE.md  # 完整 SDK、换肤与声道联动接口规范
├── assets/                              # 自动发现的轻量权重与原型库（随包复制即用）
│   ├── canonical_ipa_poses.json         # 72 个标准 IPA + 16 个持阻原型
│   ├── jd2_starter_fallback_poses.json  # 257 个预烘焙回退原型（无 DLL 环境可用）
│   ├── kf2tract27_k2_fp16.pt            # KF2Tract27 K2 v2 FP16（8.1 MB）
│   ├── kf2tract27_k2_int8.pt            # KF2Tract27 K2 v2 INT8（4.2 MB）
│   ├── browser_spk_enc_fp16.pt          # SpkLite 2.9M 零底座声纹编码器（5.7 MB）
│   └── speakers/*.spk.json              # 1 KB 级发音人声纹档案
├── kf_ipa_synth/                        # Python 核心包
├── web/                                 # 统一风格可嵌入前端 + 一键换肤 + 声道联动桥接
└── tests/
    └── test_smoke.py                    # 纯 CPU 端到端冒烟测试
```

> 当 `Stage5Lite`（3.73M 零底座神经声码器）训练导出完成后，只需将 `browser_m27_stage5_fp16.pt`（或 `int8.pt`）放入 `assets/` 目录，模块会自动发现并解锁零底座 16 kHz 真人音色合成，无需修改任何代码。

---

## 二、Python 核心 SDK 极简用法（供其他模型直接调用）

```python
from kf_ipa_synth import IPASynthEngine

# 1. 初始化常驻内存引擎（自动加载 assets/ 下的模型与原型库）
engine = IPASynthEngine()

# 2. 文本转多轨时间轴（支持 zh / en / ja / auto 混排与内联 [IPA]）
tl = engine.text_to_timeline("好一朵美丽的茉莉花", lang="zh", bpm=96, base_f0=155)

# 3. 可选：通过声道构型接口微调第 2 个关键帧（自动将对应器官权重钉到 1.0）
tl["keyframes"][1]["pose_overrides"] = {"LP": 0.65, "TTX": 5.30}

# 4. 合成 50 Hz 物理轨迹 + 矢状面动画 + 可选 VTL R21 / Stage5 音频
out = engine.synthesize({
    "keyframes": tl["keyframes"],
    "f0_points": tl["f0_points"],
    "alpha": 1.0,
    "use_neural_vocoder": False,      # 放入 Stage5Lite 权重后改为 True 即可出真人音色
    "speaker_profile": "demo_mandarin",
})

m27_50hz = out["m27_model"]           # shape: (T, 27), 物理单位
summary = out["summary"]
print(summary["duration_sec"], summary["wall_sec"], m27_50hz.shape)
```

### 提取并保存 1 KB 发音人声纹档案

```python
profile = engine.speaker_store.enroll_from_audio(
    name="井井测试声纹",
    audio_input="sample_3s.wav",
    profile_id="jingjing_v1",
)
print(profile["size_bytes"])  # 约 1.5 KB，之后传 speaker_profile="jingjing_v1" 复用
```

---

## 三、启动独立演示网页或挂载到 FastAPI

### 独立零依赖启动

```bash
python -m kf_ipa_synth.server --host 127.0.0.1 --port 18798
```

打开浏览器访问 http://127.0.0.1:18798 即可体验：

- 顶部一键批量换肤栏（4 套内置主题 + 主强调色实时联动 + 导出主题 CSS）
- 完整多轨 TextGrid 时间轴与 IPA 合成工作台
- 底部基于 `TractKeyframeBridge` 构建的声道微调联动示例面板

### 挂载到黑客松 FastAPI 项目

```python
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from kf_ipa_synth import IPASynthEngine, create_fastapi_router

app = FastAPI()
engine = IPASynthEngine()
app.include_router(create_fastapi_router(engine), prefix="/ipa")
app.mount("/ipa-web", StaticFiles(directory="kf_ipa_synth/web", html=True), name="ipa-web")
```

---

## 四、运行冒烟测试

```bash
python kf_ipa_synth/tests/test_smoke.py
```
