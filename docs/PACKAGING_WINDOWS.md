# VoxFigura Windows 打包规范

适用于公开版、群友版的 Windows x64 CPU 免安装包。以后增加安装器时沿用此规范中的运行文件、版本隔离、依赖锁定和验收门槛。

## 1. 确认可交付范围

| 项目 | 免安装包约定 |
| --- | --- |
| 目标平台 | Windows x64，普通用户，可写的解压目录和系统自带 Microsoft Edge WebView2 运行时。最低支持版本及普通 CPU 性能以干净机实测记录为准。 |
| 公开版 | 构建模式 `public`，端口 26751。标准工作台和发音卡。 |
| 群友版 | 构建模式 `friends`，端口 26752。标准工作台和群友版发音卡署名。 |
| 本地默认 | VTL 物理声道、九个 ONNX 模型、正式 IPA/VoQS 参考库含 TextGrid、词表、工作台工程、原文引导对齐、发音卡和常用音视频导出。 |
| 转写 | 由用户填写原文，或配置 DeepSeek API 在线转写。Windows 发包不含本地转写模型、依赖或下载入口。 |
| 联网能力 | 在线 AI/BYOK 需要网络、有效服务配置及用户自备凭据。外置 ONNX 继续走输入输出契约校验。 |

交付物为单个 Tauri 2 桌面 EXE。首次启动核对内嵌 7z 数据并自动展开到当前用户 `%LOCALAPPDATA%/VoxFigura/Portable`，同一成品此后复用已准备的运行目录。启动器以隐藏后端终端的方式（`CREATE_NO_WINDOW`）拉起包内 Node 启动脚本，由其启动包内 Python 引擎并等待就绪，随后直接在独立 Tauri 2（WebView2）桌面窗口加载工作台与该版本代理。Python 使用动态端口和进程内随机凭证。桌面窗口只连固定的工作台回环端口，固定端口保留同源本地存储。运行目录按成品内容区分，模型覆盖和引擎缓存随该目录保存。遇到端口冲突须在窗口内清楚提示。关闭桌面窗口后自动结束本实例的本地代理与 Python 引擎。

## 2. 允许纳入的文件

| 文件组 | 来源和用途 |
| --- | --- |
| 网页 | 当次目标版本的 Vite 输出。保留生成的 JS/CSS、字体、词典分片（含 `cmudict.dict`、`ja-mfa-v3/*` 与精简日语声调词典 `ja-accent-v1/*`）、三维声道、MediaPipe、预渲染与其他正常网页资源。生产 source map 走单独内部调试流程。 |
| Node 与代理 | 固定官方 Windows x64 Node 二进制及许可。只装入本机启动器、共用代理、发音卡编码、剪辑编码。 |
| Python | 官方嵌入式 CPython x64 及受控的 `._pth`。只装入锁定的 wheel 闭包、Pillow 运行文件和原生 ABI 依赖。`._pth` 与启动器禁止从宿主用户 site-packages、外部虚拟环境或 `PYTHONPATH` 加载。 |
| 声道与语音模型 | 注册表的 9 个 ONNX 文件，模型与来源清单，必需的 NumPy SDK 子集、构型、声纹、VTL DLL、speaker、factory、词表。范围变更须联动核对 `engine/model_registry_runtime.py`、延迟导入和测试。 |
| 单文件启动器 | 由 `src-tauri/` 编译 Tauri 2 桌面启动壳（内嵌 `scripts/portable/VoxFigura.ico` 应用图标），尾部拼装锁定的 7zr、LZMA2 应用归档和用于核对的哈希。目标机使用 Windows 自带的 Microsoft Edge WebView2 运行时，后端代理与 Python 引擎默认无控制台窗口静默运行。 |
| 参考库 | `engine/reference_library/index.json` 对应可用录音、构型和 TextGrid，以及各类正式测量与颤音样例。IPA/VoQS 实录从源 WAV 构建为 192 kbps MP3，并逐条用包内解码器核对采样率、声道和解码样本数。保留原始 TextGrid、构型和 MP3 格式的颤音合成示例。 |
| 内置示例音频 | 导览朗读、`public/prewarm`、发音卡配套录音和颤音样例使用固定码率 192 kbps MP3。新增或重新生成后逐条核对声道和精确解码时长。16 kHz 的颤音示例升为 32 kHz 以支持该码率。导览和预热的源 WAV 保存在 `assets/source-audio/`。生产包拒绝从网页或参考库目录装入示例 WAV。 |
| 媒体导出 | 单个锁定 FFmpeg CLI，剪辑导出固定 CPU `libx264`，保留 AAC、FLAC、MP3、WAV、PNG/JPEG 读取、GIF 调色板等实际编码链。 |
| 许可及清单 | 项目许可、第三方披露、依赖许可证、上游版本与 SHA-256、逐文件清单。 |

禁止装入 `.env*`、凭据、`node_modules`、旧 `dist-*`、开发与研究缓存、测试夹具、调试符号、整套训练 SDK、`.pt/.pth` 权重、CUDA/cuDNN、onnxruntime-gpu、PyTorch、知乎作者私参和其他版本专属内容。禁止装入本地转写模型和专用运行库，包括 Whisper、CTranslate2、faster-whisper 及转写用 PyAV，亦禁止装入 `pyopenjtalk` 运行时及百兆级 MeCab 二进制词典（日语声调仅通过前端精简静态分片 `ja-accent-v1` 离线提供）。构建时关闭本地转写入口，包内引擎禁用本地转写接口。

每次纳入、升级或裁切大文件，要记录功能、提供者、版本、哈希、许可证、压缩体积差以及对应运行实测。不能通过部件外移、关闭功能或让用户自行装依赖来达到主包的体积目标。仓库源 WAV 用于保留原始采样值。包内试听和资料导出兼容 WAV 接口，导出清单会注明录音取自 MP3。涉及模型精度、音频参数或资产授权变化时，先取得相应的产品和授权决定。

### 近期新增静态资产记录

- **日语精简声调词典（`public/vocal-tract/assets/ja-accent-v1/*`）**：用于纯前端离线日语汉字/假名分词、重音短语合并与东京高低音调 F0 轮廓生成。通过 `scripts/build_ja_accent_dict.py` 只读提取自 Open JTalk / NAIST-JDIC（源 `sys.dic` SHA-256 `23287ce5d518164b8b97683b1d9534df095556e446f3470a6c52bd737be74527`），许可为 Modified BSD License（原始文本随包附于 `public/licenses/naist-jdic.txt` 与 `licenses/NAIST-JDIC-COPYING.txt`）。共 408,422 条词条、16 个 `.tsv.gz` 分片加 `manifest.json`，总占 **2,449,061 字节（2.34 MB）**（替代 107.9 MB 的 `pyopenjtalk-plus` 运行时），由 `packages/g2p-ts/src/g2p.test.ts` 与 `scripts/portable/build.py` 逐分片 SHA-256 核验。

## 3. 构建步骤

构建机需有 Node、按 `package-lock.json` 准备好的 npm 依赖、CPython 3.11 x64、Visual Studio C++ Build Tools (MSVC) 与 Rust (`stable-x86_64-pc-windows-msvc`) 工具链。工具链只用于构建，产物只带运行文件。

```powershell
npm run typecheck
npm test
& 'F:/TensorTract3_Train/.venv/Scripts/python.exe' -B -m unittest discover -s engine/tests
npm run portable:public -- --stage-only
npm run portable:friends
```

- 包装脚本只读取锁定输入，下载及核验缓存位于 `build/portable-inputs/`。`--offline` 要求缓存已完整。`--stage-only` 仅组装目录。历史 ASR 编译脚本及其构建输入与当前组包流程隔离。
- EXE 与 `.exe.sha256` 位于 `build/portable/<edition>-<唯一编号>/`，用户只接收 EXE。每次使用新目录，失败中间产物不得交付。保留实际日志、EXE 校验、版本、大小和端到端验证记录。
- 依赖升级时从官方发布源更新锁文件，并重跑干净机验收。微软原生运行时应有可审计出处，分发时检查适用的 REDIST 列表与许可。FFmpeg 构建的具体启用项以对应二进制、wheel 和上游构建为准。

## 4. 成品验收矩阵

```powershell
py -3.11 -B -X utf8 scripts/portable/verify.py "<成品 EXE 或仅组装的目录>" --zh-speech "<普通话 WAV>" --zh-text "<普通话原文>" --en-speech "<英语 WAV>" --en-text "<英语原文>" --full-library
```

两条语音夹具应为经授权、有人声且文本已知的普通话与英语录音，分别提供原文。验收时仅使用包内运行时，隔离开发 PATH。自动测试会核对 EXE SHA-256，通过 EXE 将应用自动展开至含中文与空格的新用户缓存，核对每个文件并用 EXE 启动本地服务。直接验证组装目录时使用临时副本，避免将验收缓存写回构建产物。保留实际退出码和具体失败证据。

| 阶段 | 必验内容与通过条件 |
| --- | --- |
| 单文件 EXE | 指定版本、x64、CPU、哈希命中。逐文件清单一致。版本隔离脚本通过，公开及群友代理无赛题限定的知乎搜索或仓库阅读入口。 |
| 启停 | 双击 EXE 自动准备运行文件，不弹黑色终端窗口，直接在独立桌面窗口打开所属端口。再次启动复用运行目录。从不同当前目录启动。另一实例占端口时清楚报错。关闭桌面窗口后代理与自有 Python 引擎自动退出。 |
| 本地推理 | 9 个 ONNX 槽位有文件，真实 CPU 装载并过推理回归。测试 VTL、声道重建、普通话和英语引导对齐、合成、韵律、说话人、连续统、降噪、F0 和模型挂载/卸载。 |
| 素材 | 三维视图、模型和字体加载。逐条核对录音编码清单。检查 MP3 来源的 IPA、VoQS 实录，颤音样例、TextGrid、轨迹、参考音及包含声带视频的导出。另验全库归档的流式下载。 |
| 转写和原文对齐 | 本地转写安装和推理接口均不可用，界面没有下载入口。无网络时手动输入普通话、英语原文均可按原文对齐。有授权的在线测试 Key 时验证 DeepSeek 转写。 |
| 音视频 | 发音卡 GIF/MP4、剪辑 MP4、WAV/FLAC/MP3/M4A 实际导出并检查媒体头、时长和音轨。窄路径、中文路径和新浏览器用户数据分别验证。 |
| 浏览器 | 干净浏览器用户目录，断网打开首页、研究页、剪辑台和卡片，检查控制台、录音权限、WebGL、模型设置、词表（含日语离线声调词典 `ja-accent-v1` 的高低音调曲线生成）和项目导入导出。在线 AI 使用单独的授权测试凭据验证正常请求与错误返回。 |
| 干净机 | 普通用户账户，无开发工具、GPU SDK、额外 VC runtime 和开发目录。断网复查本地清单，再接网验证已约定的联网功能。保留 Windows 版本、浏览器、CPU 信息和实测记录。 |

本机隔离解压和干净机分别记证据。任何未运行的项标为未验证。验收记录应包含组包版本、实际 SHA-256、压缩和解压字节数、主要模块体积、测试样本条件、失败和未覆盖项。

## 5. 分发前检查

本地验收 EXE 会保留运行所需的本地研究资源，文件名和内部清单标记 `local`。转发群友和上传任何发布渠道都属于对外分发，须先确认以下具体范围。

- 逐项记录授权依据和允许受众，尤其是个人 IPA/VoQS 音频、声纹、TextGrid、VoxFigura Core 权重及词表。文档记录本地集成授权的权重，须确认受众授权后才可随包转发。
- 核对 Python、Node、MSVC 应用本地运行时、7zr、FFmpeg、字体及各依赖的分发条款。包内许可与真实二进制匹配，并提供所需对应源码、构建信息、版权声明或适用的提供方式。具体以各项目当次版本许可为准。
- 审核 `bundle-manifest.json` 中的实际文件及来源，复查命名、用途、大小和端口，确认干净机验收完成并依井井明确指定的渠道操作。

上游资料：[CPython](https://www.python.org/downloads/release/python-3119/) · [Node](https://nodejs.org/en/blog/release/v24.13.0) · [7-Zip](https://www.7-zip.org/download.html) · [Windows 内置 .NET Framework](https://learn.microsoft.com/en-us/dotnet/framework/install/on-windows-and-server) · [Microsoft VC++ 本地部署](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files)。
