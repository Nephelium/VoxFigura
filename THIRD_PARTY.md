# 第三方组件与素材声明（THIRD_PARTY）

| 名称 | 版本 / 来源 | 许可协议 | 用途 | 备注 |
| --- | --- | --- | --- | --- |
| VocalTractLab 2.4 (`VocalTractLabApi.dll`, `VocalTractLabAnalysis.dll`, `geometry_p2.dll`, `*.speaker`) | `vocaltractlab.de` / PhoneticToolbox v3 | GPL-3.0-or-later | 声道几何求解、面积函数与 48 kHz 物理声学合成 | 核心物理引擎 |
| Three.js & OrbitControls (`vendor/three.module.js`, `vendor/OrbitControls.js`) | Three.js (MIT) | MIT | 3D 声道模型渲染与交互相机 | 随 `vocal-tract-view` 独立打包 |
| MediaPipe Canonical Face Model | [MediaPipe v0.10.14](https://github.com/google-ai-edge/mediapipe/blob/v0.10.14/mediapipe/modules/face_geometry/data/canonical_face_model.obj) | [Apache-2.0](public/mediapipe-0.10.14/LICENSE) | 三维人头的标准脸几何与三角拓扑 | 原始 OBJ 随本地摄像头资源分发 |
| MediaPipe Tasks Vision / Face Landmarker | [SDK v0.10.14](https://github.com/google-ai-edge/mediapipe/tree/v0.10.14) / [float16/1 模型包](https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task) | SDK 为 Apache-2.0；[Face Mesh V2 模型卡](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf)标注 Apache-2.0，完整 task 包许可范围待核实 | 摄像头面部追踪 | 本地模型 SHA-256 为 `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff` |
| Vue 3 / Vite / TypeScript / Vitest / dotenv | npm 开源依赖 | MIT / BSD-2-Clause | 前端、代理及构建与测试 | Vue 用于前端运行，dotenv 用于代理；其余为开发构建或测试工具 |
| Apache ECharts | [上游工程](https://github.com/apache/echarts) | [Apache-2.0，含第三方声明](https://github.com/apache/echarts/blob/master/LICENSE) | 工作台图表 | 随前端构建使用 |
| faster-whisper / CTranslate2 | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) / [CTranslate2](https://github.com/OpenNMT/CTranslate2) | MIT；模型及其他依赖分别适用其上游条款 | 可选本地 Whisper 转写 | 按需安装，模型来源及固定版本见 `engine/asr_models.py` |
| DPDFNet2 | [上游工程](https://github.com/ceva-ip/DPDFNet) | Apache-2.0 | 可选本地语音降噪 | 通过 PhoneticToolbox 的推理接口和本地模型使用 |
| KaTeX | 0.19.1，[上游项目](https://github.com/KaTeX/KaTeX) | MIT | 知乎摘录与刘看山对话的公式排版 | 参赛版依赖 |
| Doulos SIL (`DoulosSIL-Regular.ttf`) | SIL International (`Doulos-OFL.txt`) | SIL OFL 1.1 | IPA 国际音标排版 | 保留 OFL 许可文件 |
| PTBIPAPlus (`PTBIPAPlus-Regular.ttf`) | PhoneticToolbox (`OFL-PTBIPAPlus.txt`) | SIL OFL 1.1 | IPA / extIPA / VoQS 扩展音标显示 | 保留 OFL 许可文件 |
| JetBrains Mono (`JetBrainsMono-Regular.woff2`) | JetBrains (`JetBrainsMono-OFL.txt`) | SIL OFL 1.1 | 时间码、采样号与参数等宽数字显示 | 保留 OFL 许可文件 |
| midi-file | 1.2.4，Carter Thaxton | MIT | 读取 Standard MIDI File | [源码与许可](https://github.com/carter-thaxton/midi-file) |
| fflate | 0.8.2，Arjun Barrett | MIT | 分轨音频 ZIP 导出 | [源码与许可](https://github.com/101arrowz/fflate) |
| CMUdict (`cmudict.dict`) | Carnegie Mellon University Speech Group | BSD-2-Clause | 英语音素转 IPA 词典 | 随 `public/vocal-tract/assets/` 分发 |
| Salamander Grand Piano v3 | Alexander Holm，[上游录音](https://github.com/sfzinstruments/SalamanderGrandPiano/tree/3382bf9496bba2486f5ab0de55a264d1dfc38404) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | Yamaha C5 钢琴试听 | 两层键击交叉混合、动态琴槌滤波、释键共鸣与立体声厅堂混响 |
| The Synthesis ToolKit in C++ | Perry R. Cook、Gary P. Scavone，[上游实现](https://github.com/thestk/stk/tree/6aacd357d76250bb7da2b1ddf675651828784bbc) | [STK 授权文本](public/licenses/stk.txt) | 笛子、洞箫、小提琴、二胡、古筝、琵琶、吉他 | TypeScript 重构三阶分数延迟波导、精确闭环相位补偿、竹笛非线性笛膜、二胡蟒皮模态、Cremona 提琴模态及交换双极化色散弦模型 |
| Japanese MFA Dictionary v3 (`ja-mfa-v3/*`) | PhoneticToolbox v3 打包子集 | 见上游 MFA 词典声明 | 日语假名切分与发音查询 | 纯假名分片 |
| Japanese Pitch-Accent Compact Dictionary (`ja-accent-v1/*`) | Open JTalk / NAIST-JDIC 只读精简抽取（408,422 词条） | [Modified BSD License](public/licenses/naist-jdic.txt) | 日语汉字/假名离线东京高低音调标注与 F0 轮廓生成 | 16 个 `.tsv.gz` 分片共 2.34 MB，源 `sys.dic` SHA-256 与各分片校验见 `public/vocal-tract/assets/ja-accent-v1/manifest.json` |
| Mandarin MFA pronunciation dictionaries | [中国普通话 v3.0.0](https://mfa-models.readthedocs.io/en/latest/dictionary/Mandarin/Mandarin%20(China)%20MFA%20dictionary%20v3_0_0.html) / [普通话 v2.0.0a](https://mfa-models.readthedocs.io/en/latest/dictionary/Mandarin/Mandarin%20MFA%20dictionary%20v2_0_0a.html) | CC BY 4.0 | 引擎普通话文字转音素与对齐 | 本地两个词典的 SHA-256 与相应上游发行文件一致 |
| TIMIT pronunciation dictionary | [TIMIT LDC93S1](https://catalog.ldc.upenn.edu/LDC93S1) | 具体使用、分发权限以实际取得的 LDC 协议为准 | 引擎英语词典及对齐辅助 | `engine/model_bundle/packages/kf_ipa_synth/assets/lexicon/TIMITDIC.TXT` 已在本地目录；授权记录及拟议分发范围待核实 |
| IPA / extIPA / VoQS 数据目录 | IPA Chart 2026 / extIPA 2025 / Ball et al. (2018) / Zenodo 10206204 | 按各来源分别标注：IPA 图表 CC BY-SA 4.0，extIPA 图表 CC BY-SA 3.0，VoQS 中文译表 CC BY 4.0；论文版权另计 | 655 入口音标目录与双语释义 | 详见 `public/data/ipa-plus-catalog.json` 内 `sources` 字段；上游原图是否随包分发以各来源说明为准 |
| 刘看山官方动态 GIF 与三视图 | 知乎黑客松 S3 官方素材包 | 赛事限定非商用展示许可 | 知乎发音探索实验室陪伴与舞台立绘 | 仅限参赛作品展示 |
| TensorTract3 (`F:\TensorTract3_Train`) | Krug et al. (2026) 架构衍生自训模型 | 仅作后端只读推理接口对接 | Stage 4 `m27` 反演与 Stage 5 神经重合成 | 不随仓库分发 1.18 GB WavLM 底座 |
| Vox2Align-Lite v2 | 井井提供的 TensorTract3 正式 FP16、20,000 步导出及 v2 SDK | 用户授权本地集成。上游未附模型单独的公开分发许可证 | 普通话和英语原文引导对齐 | 权重、SDK 来源和词表 SHA-256 见 `engine/model_bundle/models/manifest.json` |
| Pillow | 12.1.1，[PyPI CPython 3.11 Windows x86-64 wheel](https://pypi.org/project/pillow/12.1.1/#pillow-12.1.1-cp311-cp311-win_amd64.whl) | MIT-CMU | 国际音标资源包的声带视频离屏绘图 | 本地引擎依赖。保留 wheel 的原始许可及附带组件声明 |

界面可选 Noto Sans SC、Noto Serif SC、Inter 和 Lora，均来自 [Google Fonts](https://github.com/google/fonts/tree/main/ofl)，随包提供 WOFF2 格式及各字体原始 OFL 1.1 许可（public/fonts/*-OFL.txt）。
