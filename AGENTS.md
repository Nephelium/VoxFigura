# VoxFigura 工程规范

> 配套详细文档：[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)（系统架构与数据流）· [docs/CODING_STANDARDS.md](./docs/CODING_STANDARDS.md)（编码与合规规范）· [docs/MODEL_INTERFACE_SPEC.md](./docs/MODEL_INTERFACE_SPEC.md)（模型接口契约）· [docs/PACKAGING_WINDOWS.md](./docs/PACKAGING_WINDOWS.md)（Windows 打包规范）· [docs/specs/02-ui-spec.md](./docs/specs/02-ui-spec.md)（UI 视觉与组件规范）· [docs/STYLE_EXTENSION_GUIDE.md](./docs/STYLE_EXTENSION_GUIDE.md)（视觉风格与扩展指南）

## 1. 仓库结构

- `packages/core-ts/`：纯函数声学与编曲内核（48 kHz 整数采样、半开区间 `[start_smp, end_smp)`、qTA、抢拍调度、6 档发声态直连插值、命令总线、TextGrid、连续统、方言变调）。
- `packages/g2p-ts/`：无框架耦合的多语文本转 IPA、CMUdict、日文假名与简谱解析纯函数包。
- `packages/vocal-tract-view/`：零框架耦合的 2D/3D 声道几何可视化独立组件包（`embed.mjs` 镜像，含 `demo.html` 与 `manifest.json`）。
- `packages/model-adapters/`：标准化模型适配器层（VTL 双传输 `VocalEngineTransport` 与 `Vox2Tract-Lite` / `Tract2Vox-Lite` 适配器 `M27Adapter`）。
- `server/index.mjs`、`server/hackathon.mjs` 共用本地引擎转发、自配 API Key 助手和发音卡编码；参赛入口单独挂载知乎内容接口（`server/contest-routes.mjs`）。公共代理实现位于 `server/proxy.mjs`，发音卡与剪辑编码分别位于 `server/card-encoding.mjs`、`server/studio-encoding.mjs`；免安装版专用入口为 `server/portable.mjs`（开源版 26751，自动设置 `ENGINE_PORT=0` 与 `VOCALCUT_DISABLE_LOCAL_ASR=1`），便携缓存管理位于 `server/portable-cache.mjs`。
- `engine/`：Python 3.11 本地 VTL 2.4 + VoxFigura Core 推理服务（默认监听 `127.0.0.1:8765`；`npm run engine` 依次选用 `VOCALCUT_PYTHON`、仓库 `.venv`、`F:/TensorTract3_Train/.venv`（仅 Windows、只读）、系统 `python`，均以 `-B` 启动），含统一校验器 `engine/validation.py` 与引擎租借池 `engine/dense_channel.py`。
- `src/` 包含公共科研与剪辑工作台、共享外观及模型设置。`@vocalcut/edition` 在构建时选择 `src/editions/public.ts` 或 `src/editions/hackathon/index.ts`（原群友版已并入 `public.ts` 作为唯一开源版，不再单设独立构建；`src/editions/friends.ts` 仅作重导出兼容）。
- `src/components/phonetic-card/` 持有两版共用的发音卡，`src/editions/hackathon/` 持有探索页、专题、知乎凭据与内容显示、刘看山及卡片署名/本地示例配置。公开入口通过 `scripts/check-edition.mjs` 白名单仅允许导入 `./hackathon/branded-card`。
- `schema/` 维护工程格式（`project.schema.json` 以 `packages/core-ts/src/types.ts` 为真源）和工具登记。`public/` 存放两版共享字体、声道资源、IPA 数据与预渲染几何和音频。`.cache/` 仅存运行时缓存，不留存历史构建备份或临时脚本。

## 2. 常用命令

| 版本 | 开发前端 | 本地代理 | 构建产物 |
| --- | --- | --- | --- |
| 开源版 | `npm run dev`，端口 5173 | `npm run server`，端口 3001 | `npm run build` → `dist-public/` |
| 参赛版 | `npm run dev:hackathon`，端口 5174 | `npm run server:hackathon`，端口 3002 | `npm run build:hackathon` → `dist-hackathon/` |

各列命令在不同终端运行，两版可并行。前端默认连接同一行的代理。自定义代理端口时，通过进程环境 `PORT` 和 `VOCALCUT_PROXY_URL` 分别设置代理监听端口与前端目标。预览构建可使用 `npm run preview`（4173）或 `npm run preview:hackathon`（4174）。

- `npm run engine` 启动共享 Python 引擎（8765）。
- `npm run typecheck` 执行全量类型检查，`npm test` 运行单元测试（含 Schema 校验）。
- `& 'F:/TensorTract3_Train/.venv/Scripts/python.exe' -B -m unittest discover -s engine/tests` 运行 Python 引擎单测。

## 3. 核心工程铁律

1. **禁止修改外部基线目录**：严禁写入 `D:\PhoneticToolbox\PhoneticToolbox_v3` 或 `F:\TensorTract3_Train`，仅可只读引用或复制并在 `DISCLOSURE.md` 登记。
2. **密钥隔离**：严禁读取、打印、日志记录或提交 `.env.local` 中的任何密钥或用户 BYOK 请求头。
3. **单位与区间约定**：时间统一使用 48 kHz 整数采样与半开区间 `[start_smp, end_smp)`；字段名带单位后缀（`_smp`, `_ms`, `_st`, `_hz`, `_pa`, `_cm`）。UI 与适配器层气压统一用 `Pa`（`0..1600 Pa`），仅在 Python `engine/` 与原生边界做 `dPa = pa * 10` 换算。
4. **越界即拒绝**：严禁对 F0（须为正有限值 `> 0 Hz`，其中 VTL 2.4 物理声门保留原生硬件边界 `40..600 Hz`，神经合成不设固定上下限）、气压（`0..1600 Pa`）、声道 17/19 维、声门 8 维与塞音刚性下限（闭塞 10 ms、释放 1 ms）等参数静默夹紧，必须返回 `{ ok: false, error: { code: 'out_of_range', allowed, hint } }`（完整字段 `field / value / allowed{min,max,unit}` 与 HTTP 400 契约见 [CODING_STANDARDS.md §3.3](./docs/CODING_STANDARDS.md)）。
5. **界面、术语与品牌代号边界**：禁用 Element Plus / Ant Design Vue / Naive UI，全仓库禁止 UI Emoji，术语统一为 `声道重建`、`刘看山`、`VoQS`、`extIPA`、`轻新拟态`。`VocalCut` 为内部代号，保留于包名/别名（`@vocalcut/*`）、事件名（`vocalcut:*`）、环境变量（`VOCALCUT_*`）与代理服务标识（`vocalcut-node-proxy`）；用户界面与正式文档标题统一使用 `VoxFigura`。
6. **显示与模型边界**：以 2560×1600 全屏桌面为设计基准。可用窗口宽高比 ≥16:10 时完整显示，窄于 16:10 时允许横向滚动。普通话与英语文本韵律使用可关闭的本地 `Text2Prosody-Lite` 模型，导入的 TextGrid 保留原有区间。
7. **模型官方命名规范**：全仓文档、代码注释、界面与报错提示统一使用最新官方名称：**`Vox2Tract-Lite`**、**`Tract2Vox-Lite`**、**`IPA2Tract-Lite`**、**`Tract2Area-Proxy`**、**`Vox2Spk-Lite`**、**`Text2Prosody-Lite`**、**`Vox2Align-Lite v2`**（旗舰版为 `Vox2Tract-Large`、`Vox2Tract-PR`、`Tract2Feat-Proxy`、`Tract2Vox-Large`），禁止再用 `Stage 4` / `Stage 5` / `KF2Tract` 称呼它们。

## 4. Windows 打包强制规范

1. **先选版本和目标**。仓库仅维护开源版（`public`，合并原群友版）与参赛版（`hackathon`）两个管理版本。Windows 免安装版默认 x64、CPU、Tauri 2 独立桌面窗口（WebView2，默认隐藏后端终端），运行 `npm run portable:public` 生成交付包。包装前端必须重新构建并通过对应版本的 `check-edition.mjs`。后续安装器复用同一套已验收运行文件与依赖清单。
2. **新目录按允许清单组包，使用单文件 EXE 交付**。`scripts/portable/build.py` 持有运行时、原生库、八个核心 Batch-2 ONNX 槽位（含窄标构型库 `canonical_ipa_poses_narrow.json`）、VTL、词表、静态资源与正式参考库的入包规则，由 `src-tauri/` 编译 Tauri 2 原生启动壳（默认内嵌蓝色款 `scripts/portable/VoxFigura.ico` 图标，运行时经 `core:window:allow-set-icon` 随应用配色动态同步任务栏与窗口图标）并拼装 7zr 与 LZMA2 应用归档为单文件 EXE。外部输入由 `scripts/portable/inputs.lock.json` 逐项锁定来源和 SHA-256。每份包须附逐文件长度、SHA-256 和外部输入信息，并单独记录成品 EXE SHA-256。用户双击 EXE 即可直接以独立桌面窗口启动，运行文件自动准备到当前用户缓存，关闭桌面窗口时自动停止本地代理与引擎。禁止用旧包、旧前端产物、全仓拷贝、全量虚拟环境、被新训练版本替代的旧权重或训练目录作为打包输入。
3. **本地核心功能启动后即用**。包括 VTL、八个 Batch-2 核心 ONNX 模型（`Vox2Tract-Lite` 联合 `Vox2TractAlign v4`、`Tract2Vox-Lite`、`Vox2Spk-Lite`、`IPA2Tract-Lite`、`Text2Prosody-Lite`、`Tract2Area-Proxy`、`DPDFNet`、`SwiftF0`；独立 `Vox2Align-Lite v2` 已并入前者且旧版权重不入包，仅保留运行时可选自训兼容槽位）、参考库、声道动画和本地音视频导出。录音原文支持手动填写、通过配置的在线 API 转写，或在界面按需一键下载本地 `SenseVoice-Small`（int8 ONNX，复用包内现有 `onnxruntime`，按公网出口自动切换国内镜像/ModelScope 与 Hugging Face，权重存于用户持久缓存目录，不随包内置）；普通话与英语引导对齐直接由 `Vox2Tract-Lite`（`Vox2TractAlign v4`）完成，亦支持用户外置挂载 `Vox2Align-Lite v2` 扩展其他语种或方言。免安装和后续安装包禁止随包内置任何本地转写权重，亦禁止装入 CTranslate2、faster-whisper 或专用 PyAV 解码依赖。包内 IPA/VoQS 实录使用 192 kbps MP3，逐条核对解码后的采样率、声道和样本数，仓库保存源 WAV。禁止随包交付 PyTorch、CUDA/cuDNN、GPU Provider、训练权重、被新版本替代的旧权重、开发依赖、密钥、用户配置与存量缓存。
4. **体积以最终文件实测**。分别记录交付 EXE 大小、用户运行缓存占用，并按网页、原生推理、模型、参考库和媒体编码统计。对新增大文件或体积增长，记录用途、来源、压缩前后字节及对应验收。裁切前查明动态导入、惰性加载、旧工程兼容和导出路径。权重量化、转码、删字库和模型降级必须单独审查其功能影响。
5. **验收到实际产物**。每次执行类型检查、前端与引擎测试、版本隔离检查、EXE 校验，以及从含中文与空格的全新用户缓存首次自动展开和启动的端到端冒烟。打包为 Tauri 桌面窗口时，还须在实机窗口内人工点击核对顶栏各弹出菜单与悬浮提示（如外观菜单、帮助菜单、AI 助手与窗控按钮区域），确认不会因额外追加最小化、最大化、关闭按钮而发生定位偏移或遮挡。发包前还要在干净的 Windows x64 实体机或虚拟机上，用标准账户断网逐项核对本地功能和进程退出，记录在线功能的实测条件。失败时修复或如实留在本地验收阶段。
6. **分发有独立门槛**。本地验收包使用 `-local` 标记。公开发布和群内转发均须核对模型、词表、实录、声纹、原生库、媒体编码器和字体的分发权限、许可证和对应源代码义务，并获得井井对目标和渠道的授权。详细步骤与验收矩阵见 [Windows 打包规范](./docs/PACKAGING_WINDOWS.md)。
7. **内置播放示例使用 192 kbps MP3**。导览、预热音频、发音卡示例和颤音参考逐条检查声道与解码时长。源 WAV 存在研发目录。用户上传、运行时音频协议与 WAV 导出按各自接口处理。

## 5. UI 一致性（新增或修改任何界面前必读）

1. **真源顺序**：`src/styles/tokens.css`（token 值）> `src/styles/base.css`（共享类）> `src/components/common/`（共享组件）> `docs/specs/02-ui-spec.md`、`docs/STYLE_EXTENSION_GUIDE.md`（视觉意图与皮肤扩展）。文档规范与代码 token 冲突时以 `tokens.css` 为准，并在交付说明中指出差异。
2. **动手前先搜**：先检索 `src/components/common/`、`src/styles/base.css`、`src/styles/tokens.css`，能复用就不新建。确需新建通用组件时，放入 `src/components/common/` 并说明理由。
3. **必须复用**：
   - 图标：`IconSvg`，禁止内联 SVG 路径和图标字体。
   - 下拉：`CustomSelect` 或 `.vc-sel` / `.vc-sel-btn` / `.vc-sel-opt`（浮层 `#vcSelectMenu`），禁止新增原生 `<select>`。
   - 数值滑杆用 `CompactSlider`，分栏拖拽用 `SplitPane`。
   - 按钮：`.btn` 及变体 `primary / success / danger / active / icon-only / sm / xs`。禁止新建 `*-btn` 视觉类，仅允许添加布局类。
   - 分段切换用 `.seg` 或 `.seg.control-seg`；输入框用 `.inp`；面板用 `.panel` + `.p-head` + `.p-body`；数据展示用 `.mini-tbl`、`.metric-chip`。
   - 模态弹窗：`.export-modal-mask` + `.export-modal-card`，遮罩色用 `var(--overlay)`，层级用 `var(--z-modal)`。
4. **颜色与尺寸只用 token**：
   - 新增或修改的样式中禁止出现 `#hex`、`rgb()`、`rgba()`、`hsl()` 字面量，一律写 `var(--token)`。需要透明度时使用 `color-mix(in srgb, var(--accent) 20%, transparent)`。
   - 禁止新增 `var(--x, #fallback)` 形式的硬编码回退色。
   - 圆角用 `--r-panel / --r-ctrl / --r-seg / --r-pill`，阴影用 `--panel-shadow / --ctrl-shadow / --ctrl-inset`，动效用 `--dur-fast / --dur-med / --ease-out-expo`，层级用 `--z-base / --z-sticky / --z-drawer / --z-popover / --z-overlay / --z-modal`。
   - 禁止在组件内重定义 `--text`、`--accent` 等全局 token。
5. **皮肤兼容**：默认皮肤为 `轻新拟态`（`neumorphism`），另有 7 种皮肤（`clay / glass / minimal / material / swiss / bauhaus / brutal`）和 6 种背景（`aurora / spectrum / radar / topo / nebula / plain`），由 `data-style` / `data-bg` / `data-theme` 切换。新样式不得写死单一皮肤外观，须在默认、`glass`、`brutal` 三种皮肤及明暗双主题下复核。
6. **布局基准**：按 §3.6 的 `2560×1600` 全屏桌面基准设计；`1920×1080` 仅作为 `--page-scale` 缩放档位，不作为设计基准。
7. **无 Emoji、无第三方 UI 库**：功能图标统一使用 `IconSvg`；乐理升降号 `♯` `♭` 属于文本记号，允许使用。
8. **交付前自检**（在仓库根用 PowerShell 执行，只检查本次改动；新增命中须清零或逐条说明理由）：
   - 查新增硬编码颜色：`git diff -U0 -- src | Select-String '^\+' | Select-String '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\('`
   - 查新增原生下拉与数字层级：`git diff -U0 -- src | Select-String '^\+' | Select-String '<select\b|z-index:\s*\d'`
   - 查新增局部按钮类：`git diff -U0 -- src | Select-String '^\+' | Select-String 'class="[^"]*-btn\b'`
   - 跑类型检查与单测：`npm run typecheck`、`npm test`
9. **存量偏离不顺手大改**：旧文件中的硬编码颜色、原生 `<select>`、平行模态等存量问题不在本次任务中顺手大改；触及相关文件时，只迁移本次改动的区块。
10. **桌面壳顶栏与浮层锚定**：免安装桌面版通过 `desktopShell`（`.work-header.is-desktop-shell`）在顶栏右侧追加最小化、最大化、关闭按钮（`.win-ctrl`）。顶栏与工具区内的弹出菜单、下拉面板和提示气泡必须锚定到各自触发按钮的包裹容器（或按触发元素坐标定位），严禁挂靠整条顶栏工具容器（如 `.header-tools`）右边缘，防止打包进入桌面壳后因右侧多出三个窗口控制按钮而整体偏右。修改顶栏或发包前，须在网页模式与 Tauri 桌面壳模式下分别实测展开对齐、无遮挡且不被裁切。

## 6. 国际音标与神经语音合成冻结基线（严禁随意改动）

> 2026-11-27 经井井听感验收锁定。以下 6 条为当前国际音标（IPA）、VoQS 发声态与自定义音色神经合成的**冻结形态**；未经井井明确授权，任何会话与自动化重构**严禁**擅自改动其参数、权重配对或管线顺序。

1. **外置 Batch-2 模型与窄标构型库必须成对一致**（位于 `.cache/custom-models/batch2_v4/`，由 `.cache/local-model-registry.json` 挂载）：
   - `IPA2Tract-Lite`：`ipa2tract_lite_v4_32d_fp16s.onnx`（`4.23M / 121ch / 32d`，SHA-256 `5E535D89E2BC`），**必须**与同目录 `canonical_ipa_poses_narrow.json`（293 键，`ECA3BE86E9C1`）及 32 维特征解析配套使用。严禁破坏 `engine/keyframe_lite.py` 中 `_resolve_canonical_poses_path()` 与 `active_ipa2tract_cond_dim() == 121` 的自动配对逻辑，防止退回旧 78 键构型导致 `/ɹ/` 卷舌化或 `[l]` 爆破化。
   - `Text2Prosody-Lite`：`text2prosody_lite_v4_32d_fp16s.onnx`（`1.98M / 32d`，支持 `LANG_IPA=3`，`12B8244A0991`）。
   - `Tract2Vox-Lite`：`tract2vox_large_v2_1_web_fp16s.onnx`（`14.39M`，`3C9A34C3A3DA`；同目录保留 `tract2vox_large_v2_web_fp16s.onnx` `AA40E43639D6`）。
   - `Vox2Spk-Lite`：`vox2spk_v2_1_web_fp16s.onnx`（`4.60M`，区分度强化版，`3519D292A9B9`；同目录保留 `vox2spk_v2_web_fp16s.onnx` `D7A090757D40`）。
   - `Vox2Tract-Lite`：`vox2tract_align_v4_flywheel_fp16s.onnx`（`9.40M`，11 输出单次前向联合声道+对齐，`503899FE94EA`；同目录保留 `vox2tract_align_v3_fp16s.onnx` `DB28E185EFBB`）。独立槽位 `Vox2Align-Lite v2` 默认在设置矩阵中隐藏且不装载，仅保留供用户针对其他语种或方言自行训练并挂载扩展。
2. **构型来源分工**：神经合成模式推荐并依赖「模型默认构型」（`poseSource: 'model'`），保持在 `IPA2Tract-Lite v4` + 窄标流形内推理；严禁在 `model` 模式下把 VTL 2.4 静态 `JD2` 构型强行覆写到普通音素上，以免把 `Tract2Vox` 拉离训练流形导致声音发闷。
3. **无标调 `[IPA]` 走神经自然韵律与停顿语法**：`src/data/prosody-model.ts`（`extractMixedProsodyRuns`）与 `src/components/research/ResearchMainView.vue`（`compileRuleSentence`）必须保留对无显式声调记号 `[IPA]` 片段的自动分块（按 VoQS 作用域切分、送 `Text2Prosody-Lite v4` `LANG_IPA=3` 预测时长与基频），禁止退回平直机械音高。经井井拍板，`[...]` 国际音标语法内：空格对应 `175 ms` 短停顿（`phraseEnd=false`，不拆断 `Text2Prosody` 连续句调）；词尾/独立 `.` 与中圆点 `·` 对应 `350 ms` 长停顿（`phraseEnd=true`）；词内紧贴 `.`（如 `[ˈnɔ.məl]`）保持 `0 ms` 音节断点，`‿` 保持 `0 ms` 连读。
4. **VoQS 发声态基频抬升不与多句自动韵律冲突**：`src/components/research/control-pitch.ts` 中 `isAutomaticProsodyPin` 必须同时匹配单句 `prosody-*` 与多句前缀 `/^s\d+_prosody(?:-|$)/`，保证 `applyVoqsRegister` 在自动韵律上正常生效（`{F ... F}` 假声抬升、`{C ... C}` 嘎裂压低），仅在用户手绘 F0 锚点处让位。
5. **参考音色自动匹配中位基频（且不污染歌唱与物理轨）**：`engine/realtime_m27.py` 的 `prepare_speaker` 须同步返回 `SwiftF0` 估算的 `median_f0_hz`；前端经 `synthesis-speaker.ts` → `workbench.ts` → `annotation-audio.ts` → `control-pitch.ts` 的 `speechRegisterRatio` 在 `applyVoqsRegister` 之前做一次性比例平移。严禁对歌唱轨（`isArrangedNote` / 绝对音高音符）、实录反演参考轨（`useReference`）与 VTL 物理模式启用该缩放，亦禁止在编译与合成两处重复缩放。
6. **语音合成页播放增益透传**：`ResearchMainView.vue` 所有合成试听与流式播放入口必须继续透传 `voiceAutoGain: synthesisGainMode.value === 'peak'`，保证「自动增益」与「原始电平」模式语义独立。
7. **变更审批与必跑回归**：确需修改上述任意一环时，必须先向井井说明改动理由与回滚方案并获得同意；完成后必须全部通过：
   - `npm run typecheck`
   - `npx vitest run tests/synthesis-page-fixes.test.ts src/data/prosody-model.test.ts`
   - `& 'F:/TensorTract3_Train/.venv/Scripts/python.exe' -B -m unittest engine.tests.test_ipa_articulation engine.tests.test_onnx_hotplug engine.tests.test_realtime_m27`
   - 使用标准听感样句 `['nɔməl 'vɔɪs. {F fɔl'sɛtoʊ F}. {W 'wɪspəɹi W}]`（配默认声纹与至少一个自定义音色，选「模型默认构型」）实听确认音质、自然韵律、假声、耳语、`/ɹ/` 与音色基频均无回退。
