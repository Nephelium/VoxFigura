# 开源基线复用与创新披露表（DISCLOSURE）

本文件按照知乎黑客松 S3 参赛规则（“核心功能与主要创新必须由团队独立形成，并如实披露参考和引用情况”）及 GPL-3.0-or-later 开源合规要求，逐项登记本项目沿用、移植、改造及全新独立开发的内容。

## 1. 严禁修改约定

- `D:\PhoneticToolbox\PhoneticToolbox_v3` 与 `F:\TensorTract3_Train` 为独立外部基线仓库，本工程严禁对其目录内任何文件执行写入或修改操作，仅以只读方式复制必要静态资产、纯函数模块及参考推理权重。

## 2. 已复制并登记的外部资产与代码清单

| 序号 | 原路径 | 本仓库新路径 | 原许可 | 是否改动 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | `assets/kanshan/刘看山动态/*.gif`、`看山三视图/*.jpg` | `src/editions/hackathon/assets/{idle,greet,sway,computer,sleepy,dribble}.gif`、`sheet-{1,2,3}.jpg`、`manifest.json` | 知乎黑客松 S3 官方赛题授权（非商用参赛展示） | 仅重命名为稳定 ASCII 文件名，图像内容未改 | 仅参赛构建提供探索实验室伴读与立绘素材 |
| 2 | `D:\PhoneticToolbox\PhoneticToolbox_v3\frontend\src\assets\{DoulosSIL-Regular.ttf,Doulos-OFL.txt,JetBrainsMono-Regular.woff2,JetBrainsMono-OFL.txt}` | `public/fonts/` | SIL OFL 1.1 | 否 | IPA 音标与等宽数字字体 |
| 3 | `D:\PhoneticToolbox\PhoneticToolbox_v3\frontend\src\assets\ipa-plus\{PTBIPAPlus-Regular.ttf,OFL-PTBIPAPlus.txt}` | `public/fonts/` | SIL OFL 1.1 | 否 | IPA Plus / extIPA / VoQS 专用字体 |
| 4 | `D:\PhoneticToolbox\PhoneticToolbox_v3\frontend\public\vocal-tract\{embed.mjs,embed.css,scene.js,anatomy.mjs,head-model.mjs,face-model.mjs,geometry.mjs,jd2-jaw.mjs,airway-mesh.mjs,controls.mjs,stage-reference.mjs,model-pinch.mjs,floor-contact.mjs,rigid-contact.mjs,surface-contact.mjs,theme.js,i18n.mjs,locales/*,vendor/*,assets/head.json,assets/nasal.json,assets/nasal-section.mjs,factory/{JD2,JD2-2D,W02,W02-2D}/*,default-presets.json,presentation-metadata.json}` | `public/vocal-tract/` 与 `packages/vocal-tract-view/` | GPL-3.0-or-later（`vendor/three*` 为 MIT） | `public/vocal-tract/` 原样复制；`packages/vocal-tract-view/` 附加 `manifest.json`、`README.md`、`demo.html` | 零框架耦合 2D/3D 声道几何可视化独立组件包 |
| 5 | `D:\PhoneticToolbox\PhoneticToolbox_v3\frontend\public\vocal-tract\assets\{cmudict.dict,ja-mfa-v3/*}` | `public/vocal-tract/assets/` | BSD-2-Clause (CMUdict) / CC BY 4.0（Japanese MFA dictionary v3.0.0 数据） | 否 | 英语与日语假名离线 G2P 词典；日语词典按假名筛选并分片，许可和源版本见本地 manifest 与上游 model card |
| 6 | `D:\PhoneticToolbox\PhoneticToolbox_v3\frontend\src\modules\mandarin-ipa\{ipa-data.json,unt-rules.json,reading-repairs.json,reading-repairs.ts,state.ts,unt.ts,tones.ts,custom-tables.ts}` | `packages/g2p-ts/src/` | GPL-3.0-or-later | 是（移除原工程 `../../i18n` 与 `../../design/fonts` 等耦合，替换为本包 `shims.ts` 并补 `index.ts`） | 10 套汉语注音标准与自定义字表纯函数内核 |
| 7 | `D:\PhoneticToolbox\PhoneticToolbox_v3\frontend\src\modules\vocal-tract\{numbered-score.ts,text-readings.ts,text-tokens.ts,text-prosody.ts,text-sandhi.ts,kana-readings.ts,japanese-dictionary.ts}` | `packages/g2p-ts/src/` | GPL-3.0-or-later | 是（移除 `../../i18n` 依赖，在 `text-readings.ts` 与 `japanese-dictionary.ts` 增加 Node/Vitest 文件系统回退加载路径） | 简谱解析（含 `p-fff` 与 `(1p23)ff`）、中英日混排与 IPA 分词 |
| 8 | `D:\PhoneticToolbox\PhoneticToolbox_v3\frontend\src\modules\ipa-plus\data\*` 与 `frontend\src\i18n\locales\{zh-CN,en}\ipa-plus-*.json` | `public/data/ipa-plus-catalog.json` | GPL-3.0-or-later / CC BY-SA 4.0 数据溯源 | 是（合并生成单一标准化 JSON，保留全部 655 条音标、`system` 分类、中英释义、Unicode 码位与来源链接） | 科研工作台音标表 Plus 完整目录 |
| 9 | `D:\PhoneticToolbox\PhoneticToolbox_v3\packages\phonetic_core\src\phonetic_core\vocal_tract` 与 `resources\vocal_tract\native\*` | `engine/vtl_native/`（由 Stage 2 引擎任务落盘） | GPL-3.0-or-later | 只读复制/桥接封装 | VTL 2.4 原生几何与声学合成后端 |
| 10 | `F:\TensorTract3_Train\models\` 与本地 `src/tt3`、`packages/kf_ipa_synth`、`m27_voice_morph`、`m27_tract_studio` | `engine/model_bundle/` | 研究原型内部只读分发集成 | 仅调整模型、词典与原生库查找路径，模型张量与训练端一致 | 集成 `Vox2Tract-Lite`、`Vox2Align-Lite v2`、`Tract2Vox-Lite`、`Vox2Spk-Lite`、`IPA2Tract-Lite`、`Tract2Area-Proxy` 与 `Text2Prosody-Lite`（详细哈希与步骤见 `engine/model_bundle/models/manifest.json`） |
| 11 | `D:\PhoneticToolbox\PhoneticToolbox_v3\frontend\public\vocal-tract\{app.js,area-view.mjs,section-view.mjs}` 与 `vowel-space.mjs` | `src/components/research/ptb-physics-charts.ts`、`src/components/research/ResearchMainView.vue` | GPL-3.0-or-later | 是（只读参考并移植适配为 TypeScript/Canvas/SVG 瞬时物理与声学四联图，原目录零写入） | 声管截面积函数 $A(x)$、传递函数 $H(f)$、纵截面与元音声学空间图 |
| 12 | `D:\PhoneticToolbox\PhoneticToolbox_v3\frontend\public\vocal-tract\{default-presets.json,factory/{JD2,W02,JD2-2D,W02-2D}/{ipa.json,pinyin.json}}` | `public/vocal-tract/` 与 `src/data/ptb-ipa-presets.ts` | GPL-3.0-or-later | 是（静态预设原样落盘，新增 `ptb-ipa-presets.ts` 统一加载并全链路透传 5 项 `TractPoseExtras`） | 校准音标/拼音构型预设与 `lip_width`/`larynx_height`/`manual_root`/`tongue_shape`/`lip_shape` 精细参数 |
| 13 | `D:\PhoneticToolbox\PhoneticToolbox_v3\frontend\public\vocal-tract\scene.js` | `public/vocal-tract/scene.js` 与 `packages/vocal-tract-view/scene.js` | GPL-3.0-or-later | 是（新增窄容器横向解剖跨度保底缩放与视口安全边界标注夹紧） | 2D/3D 声道视口窄容器防裁切显示增强 |
| 14 | `F:\TensorTract3_Train\scripts\serve_m27_dashboard.py`（只读移植） | `src/components/research/m27-hd-renderers.ts`、`M27ReconstructView.vue`、`ContinuumView.vue` 与 `engine/{m27_bridge.py,dense_channel.py,server.py}` | 研究原型内部只读移植 | 是（提取适配为支持亮/暗双主题的高清矢量 + 医学图谱渲染库及 `/m27/extract-anim`、`/vtl/batch-contours` 接口） | M10 无外人头高清矢状面、喉镜俯视与 Cover–Body 冠状面声带图谱、7 轨 50 Hz `Pa` 物理曲线与 20 格连续统真实轮廓 |
| 15 | `F:\TensorTract3_Train\m27_tract_studio\web\tract-renderer.js` | `src/vendor/m27-tract-studio/tract-renderer.js`、`src/data/reference-geometry.ts` | 项目自有研究模块 | 转为 ES 模块，复用矢状面、声门与声带图谱、控制轨绘制，适配 Pa 和工作台主题 | 使用真实 VTL 轮廓与 M27 轨迹，按音频采样时刻选帧。 |
| 16 | PhoneticToolbox 声道组件 `embed.mjs` | `public/vocal-tract/embed.mjs` 与 `packages/vocal-tract-view/embed.mjs` | GPL-3.0-or-later | 扩展可选的手势提交回调 | 完成一次声道拖拽时将最终构型交给工程编辑器。 |
| 17 | `F:\TensorTract3_Train\src\tt3\prosody_infer.py`、`models\Text2Prosody-Lite\{text2prosody_lite_fp16.pt,INFERENCE_DEFAULTS.json}` | `engine/prosody_bridge.py`、`src/data/prosody-model.ts` | 项目自有研究模块 | 模块和权重运行时只读调用 | 普通话与英语时长、F0 和停顿预测。 |
| 18 | `F:\TensorTract3_Train\m27_voice_morph\{src/m27_voice_morph/,web/curve-editor.js}` | `engine/voice_morph_bridge.py`、`engine/model_bundle/m27_voice_morph/`、`src/vendor/m27-voice-morph/`、`src/components/research/VoiceMixerView.vue` | 项目自有研究模块 | 复用时变调制、双人对齐和声音属性混合。曲线预览与引擎统一插值，双人混合使用对齐后的带声状态。 | 剪辑台的属性迁移支持保存素材。调音台支持发声态预设、逐轨混合、试听和 WAV 导出，示例沿用项目现有音频。 |
| 19 | 已登记的 VTL 头部与鼻腔网格、注册与颜面拟合代码 | `scripts/generate-anatomy-registrations.mjs`、`src/vendor/m27-tract-studio/registered-head.json` | GPL-3.0-or-later | 从注册后的剖面生成显示遮罩 | 预渲染矢状面以同一头部配色和透明度显示，遮罩仅影响图层。 |
| 20 | `D:\PhoneticToolbox\PhoneticToolbox_v3\frontend\public\m05\mediapipe-0.10.14\{face_landmarker.task,vision_bundle.classic.js,wasm/vision_wasm_internal.{js,wasm}}` 及 `resources\m05\metric-spec.json`、`frontend\src\modules\lip-extraction\{stabilizer.ts,metrics.ts}` | `public/mediapipe-0.10.14/`、`src/components/research/face-landmarks.ts`、`src/components/research/LiveHead3DStage.vue` | Apache-2.0（`@mediapipe/tasks-vision@0.10.14`；Face Mesh V2 模型卡）/ GPL-3.0-or-later（PTB 拓扑与防抖规范）；完整 task 模型包许可范围待核实 | 是（裁剪冗余非 SIMD 与 CJS/ESM 副本，扩展 Worker 输出 3D 姿态矩阵与表情系数，新增与 VTL 3D 声道同坐标系的透视人头外貌微调与联合重建视口） | 实时声道重建页面的摄像头面部特征点追踪与三维透视人头-声道联合重建 |
| 21 | [MediaPipe v0.10.14 标准面部网格](https://github.com/google-ai-edge/mediapipe/blob/v0.10.14/mediapipe/modules/face_geometry/data/canonical_face_model.obj) | `public/mediapipe-0.10.14/canonical_face_model.obj` | Apache-2.0 | 原样复制，附上游许可 | 用于实时三维人头的 468 点贴面网格与变形迁移 |
| 22 | `F:\TensorTract3_Train\.venv\Lib\site-packages\pyopenjtalk\dictionary\{sys.dic,COPYING}`（只读提取） | `public/vocal-tract/assets/ja-accent-v1/*`、`public/licenses/naist-jdic.txt`、`packages/g2p-ts/src/japanese-accent.ts`、`scripts/build_ja_accent_dict.py` | Modified BSD License (NAIST-JDIC / Open JTalk) | 是（只读提取表层词、平假名读音、音调核与助词标记，过滤生僻词并压缩为 16 个 `.tsv.gz` 分片，共 2.34 MB） | 前端纯离线日语东京高低音调标注与 F0 轮廓生成，不打包 `pyopenjtalk` 原生运行时 |
| 23 | [Vincentwei1021/video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft)（`assets/lib/helpers/{motion,shake,rand}.ts`、`demos/_fixtures/{Look,Polish}.tsx`、镜头/转场/节拍算法及 `references/music-beat-sync.md`） | `src/components/studio/{stage-motion,stage-fx,stage-transitions,stage-beat-sync}.ts`、`stage-caption.ts`、`stage-scene.ts` | Apache-2.0（单向兼容本项目 GPL-3.0-or-later） | 是（纯 TypeScript 与 Canvas 2D 原生重写；不引入 React/Remotion 运行时，不复制其 `assets/audio` 与 Mixkit 第三方音频） | 剪辑台关键帧电影缓动、6 种全局运镜、9 种镜头转场、8 套舞台调色与暗角/颗粒/晕染后处理、纯前端频带包络与最小二乘节拍网格检测、卡拉 OK 柔边随读字幕及蒙太奇片尾收尾 |

> 注：全部 7 个核心自研模型（`Vox2Tract-Lite`、`Tract2Vox-Lite`、`IPA2Tract-Lite`、`Tract2Area-Proxy`、`Vox2Spk-Lite`、`Text2Prosody-Lite`、`Vox2Align-Lite v2`）及 `DPDFNet2`、`SwiftF0` 共 9 个 ONNX 槽位已正式随本地推理引擎接入；早期预留的 `501` 扩展空槽（`browser-light-m27` 与自定义 `speaker` 微调槽及 `packages/model-adapters/src/reserved-slots.ts`）已于 2026-11-26 清理移除。

## 3. 本项目独立新创部分

1. **路线 B 三工作区产品架构**：知乎发音探索实验室（首屏双声道对比 + 连续滑块 + 自定义像素尺寸发音卡片导出）与科研工作台、剪辑工作室共享同一 `.vcproj` 底座。
2. **48 kHz 整数采样与统一内核（`packages/core-ts/`）**：Prom-on et al. (2009) 3 阶临界阻尼 qTA 基频层（统一 `b_end`、歌唱重置、零声母预滑）、韵核踩拍辅音抢拍调度器、VoQS 实录锚点与 10 维声门参数、锚点联动重定时 `retime()`、RFC 6902 正逆补丁命令总线与单步撤销、TextGrid 双向读写、生理连续统与非递归方言变调引擎。
3. **本地代理与助手**。公开和参赛入口均接受用户选择的助手服务，通过命令总线执行工作台编辑。参赛入口单独挂载知乎搜索及创作内容接口。
4. **工作台外观**。八种表面风格、日夜背景与配色共用一组变量。切换风格时可以延续当前设置，或应用按原有风格示意卡取色的配色与材质初值。头部解剖外观独立配置。七组日夜工作台壁纸由 Codex 内置 ImageGen 生成，运行资源位于 `public/workspace-art/`，生成提示词见 [工作台壁纸生成记录](./docs/WORKSPACE_WALLPAPERS.md)。

### 本地录音处理和声道交互
- DPDFNet 使用 PhoneticToolbox 的 `packages/phonetic_core/src/phonetic_core/acoustic/neural.py` 和其清单指定的 DPDFNet2 48 kHz HR ONNX。运行时只读本地已安装权重，CPU 分声道推理。模型授权参考 PhoneticToolbox 的 DPDFNet Apache-2.0 文件。
- 方言录音使用 TensorTract3 的 `src/tt3/pitch.py` 及 PhoneticToolbox 的 SwiftF0 0.3.0 ONNX，保留有声掩码。截面交互参考 PhoneticToolbox 的 `frontend/public/vocal-tract/app.js` 区域侧缘控制与剖面采样。

### IPA 附加符号

JD2 的单项几何差量由本仓库的 `scripts/build-ipa-modifiers.py` 从只读的 `F:/TensorTract3_Train/packages/kf_ipa_synth/kf_ipa_synth/phonetics.py` 及本地 PTB JD2 工厂预设生成。17 个模型坐标按 M27 契约映射至网页的 19 个声道坐标。表中数值属于既有模型的近似，语音学释义和逐项限制见《IPA 附加符号与构型审校》。原训练代码及录音未因此变更。

## 项目内推理模块与声音素材

本地引擎从 `engine/model_bundle` 加载 TensorTract3 的 Vox2Tract-Lite、Vox2Align-Lite、Vox2Spk-Lite、IPA2Tract-Lite、Tract2Vox-Lite、Text2Prosody-Lite 及六区面积代理。来源为井井提供的 TensorTract3 发布目录。原权重摘要与变体见 `engine/model_bundle/models/manifest.json`。本地复制了相关 tt3、M27 Voice Morph、M27 Tract Studio 和关键帧合成包源代码，调整模型、词典及原生库查找路径。反演和对齐共用主干；动画使用原包调用的 JD2 几何提取函数。模型产生的器官轨迹属于声学反演估计。

DPDFNet 和 SwiftF0 使用 PhoneticToolbox v3 的 ONNX 和推理函数。普通话映射词表取自 PTB 与 MFA 普通话词典（CC BY 4.0），英语辅助词典使用开源 CMUdict（BSD-2-Clause）；仓库与发行包不分发 TIMIT 语料及词典文件。个人录音和反演构型位于项目本地参考库 `engine/reference_library`，浏览器通过模型接口读取。前端公开构建不复制模型、研究试听工程和个人录音。引擎支持项目虚拟环境和 `VOCALCUT_PYTHON`；在本工作站可复用训练环境已安装的 Python/CUDA 依赖。

Vox2Align-Lite v2 使用井井提供的正式 FP16 导出（20,000 步，8,805,004 字节），权重 SHA-256 与上游正式清单一致。SDK 复用 TensorTract3 的 v2 推理、模型定义及 UntPhesoca 宽式普通话映射。本地适配使用已有的 PTB 北京普通话表、MFA 词典及 CMUdict 等词表。模型与词表哈希登记于引擎清单。对齐通过本地原文引导生成普通话或英语音节、音素及语音活动层，边界是模型估计。缺少原文时，引擎仍可重建声道并计算静音门控。上游模型目录未附单独的公开分发许可证，此次授权范围为项目本地集成。

导入录音的离线转写使用 [faster-whisper 1.2.1](https://pypi.org/project/faster-whisper/1.2.1/)、[CTranslate2 4.6.0](https://pypi.org/project/ctranslate2/4.6.0/) 和 [PyAV 15.1.0](https://pypi.org/project/av/15.1.0/)。可选权重沿用 faster-whisper 项目登记的多语言转换版本，包括 [Whisper tiny](https://huggingface.co/Systran/faster-whisper-tiny/tree/d90ca5fe260221311c53c58e660288d3deb8d356)、[Whisper large-v3-turbo](https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo/tree/0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf) 和 [Whisper large-v3](https://huggingface.co/Systran/faster-whisper-large-v3/tree/edaa852ec7e145841d8ffdb056a99866b5f0a478)，兼容已有的 [Whisper base 缓存](https://huggingface.co/Systran/faster-whisper-base/tree/ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66)。安装脚本固定模型版本并核对 SHA-256，运行库及模型文件存于项目缓存。转写以本地 CPU INT8 运行，结果供 Vox2Align-Lite v2 作引导文本。

个人音色使用原项目的 Vox2Spk-Lite 编码器，从井井提供的《14.音系归纳（已剪辑）》取 14 段各 7 秒的自然讲解。按段提取、归一化并求质心，保存在引擎的 `speakers/jingjing-lecture.spk.json`。片段时间见同目录 `jingjing-lecture.sources.json`。此前 42 条常态 IPA 录音生成的声纹另存为 `jingjing.spk.json`。个人参考音和声纹均留在本地。普通神经合成使用讲解声纹，指定参考录音或原音重建时使用相应参考声纹。

按授权随本地研究工作台提供本人录音的 266 份正式 TextGrid。来源为桌面「国际音标」主表与增补。项目资源中的边界取最近原始 WAV 采样；C148 已在原始 WAV 和正式 TextGrid 中移去开头 146632 个采样。

声带 MP4 的俯视开度和冠状面沿用项目内 M27 声带图谱的对应参数和显示公式，离屏绘图使用 [PyPI 官方 Pillow 12.1.1](https://pypi.org/project/pillow/12.1.1/#pillow-12.1.1-cp311-cp311-win_amd64.whl)。Windows CPython 3.11 x86-64 的依赖位于 `engine/vendor/python-cp311-win_amd64`，原 wheel SHA-256 为 `fbfa2a7c10cc2623f412753cddf391c7f971c52ca40a3f65dc5039b2939e8563`，附原许可。音轨来自所选实录，画面使用降速频闪展示 M27 模拟声带。
