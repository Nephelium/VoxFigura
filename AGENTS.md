# VoxFigura 工程规范

> 配套详细文档：[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)（系统架构与数据流）· [docs/CODING_STANDARDS.md](./docs/CODING_STANDARDS.md)（编码与合规规范）· [docs/MODEL_INTERFACE_SPEC.md](./docs/MODEL_INTERFACE_SPEC.md)（模型接口契约）

## 1. 仓库结构

- `packages/core-ts/`：纯函数声学与编曲内核（48 kHz 整数采样、半开区间 `[start_smp, end_smp)`、qTA、抢拍调度、6 档发声态直连插值、命令总线、TextGrid、连续统、方言变调）。
- `packages/g2p-ts/`：无框架耦合的多语文本转 IPA、CMUdict、日文假名与简谱解析纯函数包。
- `packages/vocal-tract-view/`：零框架耦合的 2D/3D 声道几何可视化独立组件包（`embed.mjs` 镜像，含 `demo.html` 与 `manifest.json`）。
- `packages/model-adapters/`：标准化模型适配器层（VTL 双传输、`Vox2Tract-Lite` / `Tract2Vox-Lite` 适配器及未训模型插槽）。
- `server/index.mjs`、`server/hackathon.mjs`、`server/friends.mjs` 共用本地引擎转发、自配 API Key 助手和发音卡编码。参赛入口单独挂载知乎内容接口。公共代理实现位于 `server/proxy.mjs`。
- `engine/`：Python 3.11 本地 VTL 2.4 + VoxFigura Core 推理服务（监听 `127.0.0.1:8765`，只读使用 `F:/TensorTract3_Train/.venv/Scripts/python.exe` `-B` 启动），含统一校验器 `engine/validation.py` 与引擎租借池 `engine/dense_channel.py`。
- `src/` 包含公共科研与剪辑工作台、共享外观及模型设置。`@vocalcut/edition` 在构建时选择 `src/editions/public.ts`、`src/editions/hackathon/index.ts` 或 `src/editions/friends.ts`。
- `src/components/phonetic-card/` 持有三版共用的发音卡，`src/editions/hackathon/` 持有探索页、专题、知乎凭据与内容显示、刘看山及带品牌的卡片选项。公开入口独立于赛事目录。
- `schema/` 维护工程格式（`project.schema.json` 以 `packages/core-ts/src/types.ts` 为真源）和工具登记。`public/` 存放两版共享字体、声道资源、IPA 数据与预渲染几何和音频。`.cache/` 仅存运行时缓存，不留存历史构建备份或临时脚本。

## 2. 常用命令

| 版本 | 开发前端 | 本地代理 | 构建产物 |
| --- | --- | --- | --- |
| 公开版 | `npm run dev`，端口 5173 | `npm run server`，端口 3001 | `npm run build` → `dist-public/` |
| 参赛版 | `npm run dev:hackathon`，端口 5174 | `npm run server:hackathon`，端口 3002 | `npm run build:hackathon` → `dist-hackathon/` |
| 群友版 | `npm run dev:friends`，端口 5175 | `npm run server:friends`，端口 3003 | `npm run build:friends` → `dist-friends/` |

各列命令在不同终端运行，各版本可并行。前端默认连接同一行的代理。自定义代理端口时，通过进程环境 `PORT` 和 `VOCALCUT_PROXY_URL` 分别设置代理监听端口与前端目标。预览构建可使用 `npm run preview`（4173）、`npm run preview:hackathon`（4174）或 `npm run preview:friends`（4175）。

- `npm run engine` 启动共享 Python 引擎（8765）。
- `npm run typecheck` 执行全量类型检查，`npm test` 运行单元测试（含 Schema 校验）。
- `& 'F:/TensorTract3_Train/.venv/Scripts/python.exe' -B -m unittest discover -s engine/tests` 运行 Python 引擎单测。

## 3. 核心工程铁律

1. **禁止修改外部基线目录**：严禁写入 `D:\PhoneticToolbox\PhoneticToolbox_v3` 或 `F:\TensorTract3_Train`，仅可只读引用或复制并在 `DISCLOSURE.md` 登记。
2. **密钥隔离**：严禁读取、打印、日志记录或提交 `.env.local` 中的任何密钥或用户 BYOK 请求头。
3. **单位与区间约定**：时间统一使用 48 kHz 整数采样与半开区间 `[start_smp, end_smp)`；字段名带单位后缀（`_smp`, `_ms`, `_st`, `_hz`, `_pa`, `_cm`）。UI 与适配器层气压统一用 `Pa`（`0..1600 Pa`），仅在 Python `engine/` 与原生边界做 `dPa = pa * 10` 换算。
4. **越界即拒绝**：严禁对 F0（`60..600 Hz`）、气压（`0..1600 Pa`）、声道 17/19 维、声门 8 维与塞音刚性下限（闭塞 10 ms、释放 1 ms）等参数静默夹紧，必须返回 `{ ok: false, error: { code: 'out_of_range', allowed, hint } }`。
5. **界面与术语规范**：禁用 Element Plus / Ant Design Vue / Naive UI，全仓库禁止 UI Emoji，术语统一为 `声道重建`、`刘看山`、`VoQS`、`extIPA`、`轻新拟态`。
6. **显示与模型边界**：以 2560×1600 全屏桌面为设计基准。可用窗口宽高比 ≥16:10 时完整显示，窄于 16:10 时允许横向滚动。普通话与英语文本韵律使用可关闭的本地 `Text2Prosody-Lite` 模型，导入的 TextGrid 保留原有区间。
7. **模型官方命名规范**：全仓文档、代码注释、界面与报错提示统一使用最新官方名称：**`Vox2Tract-Lite`**、**`Tract2Vox-Lite`**、**`IPA2Tract-Lite`**、**`Tract2Area-Proxy`**、**`Vox2Spk-Lite`**、**`Text2Prosody-Lite`**、**`Vox2Align-Lite v2`**（旗舰版为 `Vox2Tract-Large`、`Vox2Tract-PR`、`Tract2Feat-Proxy`、`Tract2Vox-Large`），禁止再用 `Stage 4` / `Stage 5` / `KF2Tract` 称呼它们。

## 4. Windows 打包强制规范

1. **先选版本和目标**。公开、参赛、群友构建彼此独立。Windows 免安装版默认 x64、CPU、Tauri 2 独立桌面窗口（WebView2，默认隐藏后端终端）。公开版、群友版分别运行 `npm run portable:public`、`npm run portable:friends`。包装前端必须重新构建并通过对应版本的 `check-edition.mjs`。后续安装器复用同一套已验收运行文件与依赖清单。
2. **新目录按允许清单组包，使用单文件 EXE 交付**。`scripts/portable/build.py` 持有运行时、原生库、九个 ONNX 槽位、VTL、词表、静态资源与正式参考库的入包规则，由 `src-tauri/` 编译 Tauri 2 原生启动壳（内嵌 `scripts/portable/VoxFigura.ico` 图标）并拼装 7zr 与 LZMA2 应用归档为单文件 EXE。外部输入由 `scripts/portable/inputs.lock.json` 逐项锁定来源和 SHA-256。每份包须附逐文件长度、SHA-256 和外部输入信息，并单独记录成品 EXE SHA-256。用户双击 EXE 即可直接以独立桌面窗口启动，运行文件自动准备到当前用户缓存，关闭桌面窗口时自动停止本地代理与引擎。禁止用旧包、旧前端产物、全仓拷贝、全量虚拟环境或训练目录作为打包输入。
3. **本地核心功能启动后即用**。包括 VTL、九个 ONNX 模型、参考库、声道动画和本地音视频导出。录音原文由用户填写或通过配置的在线 API 转写，原文引导对齐继续使用本地 Vox2Align-Lite v2。免安装和后续安装包禁止装入任何本地转写权重、下载入口、CTranslate2、faster-whisper 或专用 PyAV 解码依赖。包内 IPA/VoQS 实录使用 192 kbps MP3，逐条核对解码后的采样率、声道和样本数，仓库保存源 WAV。禁止随包交付 PyTorch、CUDA/cuDNN、GPU Provider、训练权重、开发依赖、密钥、用户配置与存量缓存。
4. **体积以最终文件实测**。分别记录交付 EXE 大小、用户运行缓存占用，并按网页、原生推理、模型、参考库和媒体编码统计。对新增大文件或体积增长，记录用途、来源、压缩前后字节及对应验收。裁切前查明动态导入、惰性加载、旧工程兼容和导出路径。权重量化、转码、删字库和模型降级必须单独审查其功能影响。
5. **验收到实际产物**。每次执行类型检查、前端与引擎测试、版本隔离检查、EXE 校验，以及从含中文与空格的全新用户缓存首次自动展开和启动的端到端冒烟。发包前还要在干净的 Windows x64 实体机或虚拟机上，用标准账户断网逐项核对本地功能和进程退出，记录在线功能的实测条件。失败时修复或如实留在本地验收阶段。
6. **分发有独立门槛**。本地验收包使用 `-local` 标记。公开发布和群内转发均须核对模型、词表、实录、声纹、原生库、媒体编码器和字体的分发权限、许可证和对应源代码义务，并获得井井对目标和渠道的授权。详细步骤与验收矩阵见 [Windows 打包规范](./docs/PACKAGING_WINDOWS.md)。
7. **内置播放示例使用 192 kbps MP3**。导览、预热音频、发音卡示例和颤音参考逐条检查声道与解码时长。源 WAV 存在研发目录。用户上传、运行时音频协议与 WAV 导出按各自接口处理。
