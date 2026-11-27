# VoxFigura 死代码与冗余资源候选清单（待井井审核）

> 审阅日期：2026-11-26。本清单为只读审阅产物：**只列不删**，未改动任何源码、配置或文档。是否删除由井井逐项确认后另行执行。
> 产出方式：子代理 B（researcher）完成初盘；主代理用 git grep、自写扫描脚本和体积实测逐项复核，补扫 src/ 全部导出、public/ 全部资源和 package.json 全部依赖，裁决冲突（见第 9 节）。

## 0 概要

| 置信度 | 条目 | 可回收体积（实测字节） |
| --- | --- | --- |
| 确定无用 | 9 组（C1–C9）：21 个零引用导出、1 个 npm 依赖、2 组打包残留脚本与配置、`.cache` 违规留存、残留与可再生成产物 | 源码约 12 KB；`.cache/voice-morph` 19,695,753 B；`.playwright-cli` 5,089,343 B；`dist-*` 677,697,657 B（可再生成）；依赖 76,591 B |
| 疑似 | 10 组（S1–S10）：只被测试引用的生产代码、未入包的训练模块、无调用方的脚本、1 个 public 资源 | 源码约 360 KB（S2、S3 按整文件计，S1、S4 未计）；public 426 B |
| 需人工确认 | 6 组（H1–H6）：预留插槽、开发态本地转写、`docs/试听`、导出工具目录、Pillow wheel、旧格式导入 | 本地 916,438,596 B（`.cache/asr`、`docs/试听`、`.cache/onnx-export-tools`、Pillow wheel 合计） |

置信度定义：
- **确定无用**：同时排除以下五种可能：①静态引用（全仓含未跟踪文件，三个 edition 入口逐一计数）；②动态导入或惰性加载；③edition 构建时选择；④旧工程兼容；⑤导出路径或打包路径（barrel 再导出的外部消费方、打包允许清单、package.json scripts）。
- **疑似**：生产路径没有引用，但被测试、文档或架构描述引用，删除属于设计取舍；或是 public 资源（可能被浏览器或外部按约定 URL 请求）。
- **需人工确认**：涉及产品决策、外部素材或旧工程兼容，必须由井井决定。

## 1 覆盖范围（六类候选加 `.cache`）

| 候选类别 | 扫描方法 | 扫描规模 | 结论落点 |
| --- | --- | --- | --- |
| 未引用导出 | 脚本统计 `src/`、`packages/core-ts`、`packages/model-adapters` 中全部 `export` 声明，计数每个标识符在 `src`、`packages`、`server`、`scripts`、`tests`、根配置中的出现次数（`.vue` 模板也计入），再对零引用项逐个运行 `git grep --untracked -n -w` | 全部 export：其他位置零引用 21 个，只被测试引用 21 个，只在定义文件内使用 274 个 | C1–C4、S1–S5、S9、H6 |
| 文件 | 按 basename 统计 479 个目标（ts/vue/mjs/py/cs）在非测试、非文档文件中的引用 | 23 个无引用 | C6、C7、S5–S8；其余移入排除项 |
| 组件 | 81 个 `.vue` 逐一检索导入方 | 0 个孤立 | 第 8 节排除 |
| 脚本 | 文件名检索，加 `package.json` scripts 与 `build.py` 调用检查 | 见文件行 | C6、C7、S7、S8 |
| 依赖 | 脚本 `deps_scan.py` 扫描 366 个源文件中的 `from`/`import`/`import()`/`require()`（第 3 节；替换了早期 PowerShell 正则版本，那一版因引号被吞，所有依赖都报 files=0，结果作废） | 7 个 dependencies、7 个 devDependencies | C5；其余排除 |
| public 资源 | 脚本 `public_scan.py` 检查 235 个文件的相对路径、文件名、父目录是否被代码引用；对未命中的逐个查运行时 URL 拼接（第 7 节） | 62,850,970 B | S10；其余排除 |
| `.cache` 构建备份或临时脚本 | 一级目录体积实测，加各目录的代码引用检索 | 8 个一级目录 | C8、C9、H2、H4、H5 |

**未覆盖**：没有运行 `knip` 或 `ts-prune`（需要联网安装，违反只读约束）；没有检查 Python 引擎内部函数级的死代码。临时脚本统一放在 `.cache/review-tmp/`，执行后已删除，`Test-Path` 返回 False。

## 2 确定无用项的全仓检索证据

命令：`git grep --untracked -n -I -w <符号>`（非标识符用 `-F`），范围 `.`，排除 `docs/review`、`package-lock.json`。“代码命中”不含 `docs/`。“三入口”依次为 `src/editions/public.ts`、`src/editions/hackathon/index.ts`、`src/editions/friends.ts` 中的出现次数。

| 组 | 符号或关键字 | 代码命中（全部列出） | 文档命中 | 三入口 | vite.config.ts | build.py |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | `fitHanddrawnToQtaTarget` | 1：`packages/core-ts/src/qta.ts:887`（定义） | 0 | 0/0/0 | 0 | 0 |
| C2 | `M27_GLOTTIS_DIM_NAMES` | 1：`phonation.ts:54`（定义） | 1（旧审阅报告文字） | 0/0/0 | 0 | 0 |
| C2 | `evaluatePhonationTrackDense` | 1：`phonation.ts:263`（定义） | 0 | 0/0/0 | 0 | 0 |
| C2 | `VOQS_NOTE` | 1：`phonation.ts:326`（定义） | 0 | 0/0/0 | 0 | 0 |
| C3 | `SAMPLES_PER_FRAME_60FPS` | 1：`types.ts:12`（定义） | 0 | 0/0/0 | 0 | 0 |
| C3 | `SampleInterval` | 1：`types.ts:108`（定义） | 0 | 0/0/0 | 0 | 0 |
| C3 | `Tract17ParamName` | 1：`types.ts:118`（定义） | 0 | 0/0/0 | 0 | 0 |
| C3 | `exportIntensityTier` | 1：`textgrid.ts:466`（定义） | 0 | 0/0/0 | 0 | 0 |
| C3 | `exportOpenAiToolsSchema` | 1：`tool-registry.ts:434`（定义） | 0 | 0/0/0 | 0 | 0 |
| C4 | `CardHitRegions`、`readCardPalette`、`ExploreCardRenderOptions`、`InterpolatedExploreFrame` | 各 1：`card-renderer.ts:37`、`:323`、`:577`、`:621`（定义） | 0 | 0/0/0 | 0 | 0 |
| C4 | `M10RenderOptions` | 1：`m27-hd-renderers.ts:86`（定义） | 0 | 0/0/0 | 0 | 0 |
| C4 | `drawM27CurvesCanvas` | 5：`m27-hd-renderers.ts:942`（定义）；`src/vendor/m27-tract-studio/tract-renderer.d.ts:26`、`tract-renderer.js:8,2051,2210`（vendor 中同名的独立实现，不导入本文件） | 2 | 0/0/0 | 0 | 0 |
| C4 | `PHONATION_LANES`、`MiniTractPaths` | 各 1：`research-utils.ts:39`、`:503`（定义） | 10 / 0（旧计划文档） | 0/0/0 | 0 | 0 |
| C4 | `supportsJapaneseProsodyText`、`ENGLISH_RULE_SPEECH_SCALE` | 各 1：`prosody-model.ts:49`、`:368`（定义） | 0 | 0/0/0 | 0 | 0 |
| C4 | `PtbReferenceVowel`、`PTB_REFERENCE_VOWEL_SYMBOLS` | 各 1：`ptb-ipa-presets.ts:42`、`:83`（定义） | 0 | 0/0/0 | 0 | 0 |
| C5 | `dotenv` | 2：`package.json:28`（声明）、`THIRD_PARTY.md:9`（过时说明）；源码 import 0（第 3 节） | 1 | 0/0/0 | 0 | 0 |
| C6 | `Launcher.cs` / `Launcher` / `csc.exe` | 0 / 2：`scripts/portable/Launcher.cs:9`（自身）、`src-tauri/Cargo.toml:4`（Tauri 描述文字，无关） / 0 | 0 | 0/0/0 | 0 | 0 |
| C7 | `build_asr_cpu` | 0 | 0 | 0/0/0 | 0 | 0 |
| C7 | `asr_build_wheels` | 3：`build.py:333`（排除过滤）、`build_asr_cpu.py:68`（唯一消费者）、`inputs.lock.json:79`（定义） | 0 | 0/0/0 | 0 | 1（即 L333 过滤） |
| C8 | `stage-view-`、`jasmine-edited`、`ipa-quick-ala-native-payload`（voice-morph 遗留文件名特征） | 0 | 0 | 0/0/0 | 0 | 0 |
| C8 | `qa-` | 1：`engine/vtl_native/.../planar_reference.py:6426`（base85 数据串中的偶然子串，无关） | 0 | 0/0/0 | 0 | 0 |
| C9 | `.playwright-cli` | 1：`.gitignore:39`（忽略规则） | 0 | 0/0/0 | 0 | 0 |
| C9 | `f79902ea6dea4db4a9a014e8133e43b1`（`.part.zip`） | 0 | 0 | 0/0/0 | 0 | 0 |
| C9 | `dist-public`/`dist-hackathon`/`dist-friends` | `.gitignore:33-35`；`AGENTS.md:21-23`（构建输出说明）；`server/repo-knowledge.mjs:26-27`（检索排除名单）；构建与读取方不存在 | 若干 | 0/0/0 | 0（输出目录由 `` `dist-${edition.name}` `` 生成，L58） | 0 |

**动态导入与惰性加载的整体证据**：
- `git grep -E "import\.meta\.glob|import\(\s*\`|import\(\s*[a-zA-Z_]"`（`src`、`packages`、`server`）命中 0 条，即不存在非字面量的动态导入。
- 字面量 `import()` 只在 3 个文件中出现，共 6 处，目标全是 `.vue` 组件：`App.vue:36-38`（GuideView、ModelReportView、ModuleGuideModal）、`editions/hackathon/index.ts:13`（ExploreLabView）、`editions/public.ts:16-17`（CardStudioModal、CardHeaderButton）。这些组件对 C1–C4 宿主模块的依赖必须经过静态 import，已计入上表。
- 对 C1–C4 宿主模块（qta、phonation、types、textgrid、tool-registry、card-renderer、m27-hd-renderers、research-utils、prosody-model、ptb-ipa-presets）的惰性 `import()`：0 条。
- **导出路径**：`packages/core-ts`、`packages/model-adapters` 都没有 `package.json`，不对外发布；只通过 `vite.config.ts:53` 的 `@vocalcut/core` 别名和 `core-ts/src/index.ts:6-15` 的 `export *` 在仓库内消费。因此 barrel 再导出不存在外部消费方。

## 3 依赖导入扫描（以 deps_scan 输出为准）

| 依赖 | 类型 | import 命中 | 示例或其他使用方式 | 结论 |
| --- | --- | --- | --- | --- |
| dotenv | dependencies | **0** | 只出现在 `package.json:28`、`THIRD_PARTY.md:9`；`server/hackathon.mjs:5` 注释写的是 Node 原生 `--env-file` | **C5 确定无用** |
| echarts | dependencies | 9 | `src/components/charts/TechChart.vue:3` | 在用 |
| fflate | dependencies | 1 | `src/components/studio/arranger-export.ts:1` | 在用 |
| katex | dependencies | 2 | `src/editions/hackathon/explore-math.ts:1`（仅参赛版） | 在用，属于 edition 选择 |
| midi-file | dependencies | 2 | `src/components/studio/midi-score.ts:1` | 在用 |
| three | dependencies | 4 | `packages/vocal-tract-view/scene.js:4`、`LiveHead3DStage.vue:161` | 在用 |
| vue | dependencies | 111 | `src/App.vue:2` | 在用 |
| @vitejs/plugin-vue | devDependencies | 1 | `vite.config.ts:4` | 在用 |
| vite | devDependencies | 1 | `vite.config.ts:3`，以及 scripts 中的 `vite` | 在用 |
| vitest | devDependencies | 39 | 测试文件，以及 scripts 中的 `vitest` | 在用 |
| typescript、vue-tsc | devDependencies | 0 | `package.json` scripts 调用 `tsc`、`vue-tsc` | 在用（命令行） |
| @types/node | devDependencies | 0 | `tsconfig.json` 的 types 配置 | 在用（类型） |
| @types/three | devDependencies | 0 | 为 `three` 的 TS import 自动提供类型 | 在用（类型） |

## 4 确定无用（C1–C9）

“五项排除”对应第 0 节的定义：①静态引用 ②动态导入或惰性加载 ③edition 构建时选择 ④旧工程兼容 ⑤导出或打包路径。

| # | 路径:行 与符号 | 类别 | 五项排除 | 删除影响与风险 | 体积 |
| --- | --- | --- | --- | --- | --- |
| C1 | `packages/core-ts/src/qta.ts:887` `fitHanddrawnToQtaTarget` | 未引用导出 | ①仅命中定义（第 2 节）；②无非字面量导入，宿主模块无惰性导入；③三入口 0/0/0；④不是工程读写函数；⑤core-ts 不对外发布，barrel 无外部消费方 | 删除后要确认没有它独占的私有帮助函数；跑 typecheck 和 vitest。风险极低 | 单函数 |
| C2 | `packages/core-ts/src/phonation.ts:54` `M27_GLOTTIS_DIM_NAMES`、`:263` `evaluatePhonationTrackDense`、`:326` `VOQS_NOTE` | 未引用导出 | ①仅命中定义；②同 C1；③0/0/0；④不是工程字段；⑤同 C1 | 必须保留同文件的 `M27_GLOTTIS_BOUNDS` 和 `evaluatePhonationAnchorsAt`（后者被 tests/core.test.ts:15,352 使用）。代码审阅报告 A-16 建议统一发声态采样语义，可以一起处理 | 约 40 行 |
| C3 | `packages/core-ts/src/types.ts:12` `SAMPLES_PER_FRAME_60FPS`、`:108` `SampleInterval`、`:118` `Tract17ParamName`；`textgrid.ts:466` `exportIntensityTier`；`tool-registry.ts:434` `exportOpenAiToolsSchema` | 未引用导出 | ①仅命中定义；②同 C1；③0/0/0；④`schema/project.schema.json` 以 `types.ts` 为真源，但这三个类型或常量都不是工程字段；`ExportModal.vue:3` 只导入 `exportPitchTier`、`exportTextGrid`；⑤同 C1 | 如果产品计划导出 Praat IntensityTier，可保留 `exportIntensityTier`。风险极低 | 约 45 行 |
| C4 | src 中零引用导出 12 个：`src/components/phonetic-card/card-renderer.ts:37,323,577,621`；`src/components/research/m27-hd-renderers.ts:86,942`；`research-utils.ts:39,503`；`src/data/prosody-model.ts:49,368`；`src/data/ptb-ipa-presets.ts:42,83`（符号见第 2 节） | 未引用导出 | ①仅命中定义；`drawM27CurvesCanvas` 的另 4 条命中都在 vendor 同名实现中；②宿主模块无惰性导入；③0/0/0，`card-renderer.ts` 为三版共用的发音卡代码，入口不引用这些符号；④否；⑤src 不是库，没有导出路径 | 这些是旧清单（2026-11-25）删除部分符号后留下的孤儿。**所在文件都不在用户当前的未提交改动中**。删除后跑 typecheck | 约 120 行 |
| C5 | `package.json:28` 依赖 `dotenv` | 未用依赖 | ①源码 import 为 0（第 3 节）；②无 `require` 或 `import()`；③三入口 0；④否；⑤便携包只入包 `server/*.mjs`（`build.py:190-191`），运行时不加载它 | 要同步重新生成 `package-lock.json`（`build.py:337` 会把它的 SHA-256 写入清单，哈希变化属预期），并修改 `THIRD_PARTY.md:9` 中“dotenv 用于代理”的过时描述 | `node_modules/dotenv` 76,591 B |
| C6 | `scripts/portable/Launcher.cs` | 打包残留 | ①`Launcher.cs` 0 条，类名只出现在自身 L9；②不适用；③与 edition 无关；④否；⑤没有 scripts 或 `build.py` 调用 `csc`，启动壳已改为 `src-tauri/`（`build.py:241-268`） | 被 git 跟踪的旧 .NET 启动器。删除后，`docs/PACKAGING_WINDOWS.md:85` 中的“.NET Framework”上游链接也要删（见文档审阅报告） | 6,640 B |
| C7 | `scripts/portable/build_asr_cpu.py`；`inputs.lock.json:79-95` `asr_build_wheels`；`build.py:333` 的过滤条件 | 打包残留 | ①`build_asr_cpu` 0 条；`asr_build_wheels` 只在这三处互相引用；②不适用；③与 edition 无关；④否；⑤没有 package.json script，`build.py` 不调用它。该脚本为便携包编译 CTranslate2，**与 AGENTS.md §4.3“禁止装入 CTranslate2”直接冲突** | 三处一起删除，L333 改为直接写入 lock 原文。不影响开发态 ASR（见 H2） | 5,792 B 加 lock 中 17 行 |
| C8 | `.cache/voice-morph/` 中除 Pillow wheel 外的 59 个文件：17 个 `qa-*.py`、`*-patch.py`、`check-*.py`、`list-*.py` 临时脚本，QA 截图，`*.mp4`、`*.webm`、`*.wav`，`jasmine-edited.TextGrid`，`ipa-quick-ala-native-payload.json`，`playwright/*.log` 和 `*.yml` | `.cache` 违规留存（临时脚本与 QA 产物） | ①文件名特征命中 0（第 2 节）；②运行时只有 `engine/voice_morph_bridge.py:109-111` 使用 `presets.json`，**该文件当前不存在**，用时才创建；③不适用；④否；⑤被 `build.py:51-58` 的 `PRIVATE_PATH` 拦截，不入包。AGENTS.md §1 规定 `.cache/` 不留存临时脚本 | 无运行影响，已被 .gitignore 忽略 | 19,695,753 B |
| C9 | `.cache/ipa-library-materials/f79902ea….part.zip`；`.playwright-cli/`；`dist-public/`、`dist-hackathon/`、`dist-friends/` | 残留与可再生成产物 | ①见第 2 节，只有忽略规则和说明文字；②不适用；③`dist-*` 是三版构建输出，删除后可用对应命令重建；④否；⑤便携包使用临时目录 `work/web`（`build.py:324-326`），不读 `dist-*` | 删除后需要先重新 `npm run build*` 才能 `npm run preview*`。`vite.config.ts:58` 声明了 `emptyOutDir: true`，但 `dist-friends/assets` 中有 37 个 `index-*.js`，`index.html` 只引用 `index-iWXD13lB.js`；文件写入时间横跨 2026-09-09 到 2026-11-26，说明残留没有被清理，建议删除后重建再核对 | `.part.zip` 0 B；`.playwright-cli` 5,089,343 B；`dist-*` 677,697,657 B |

**本层不含任何 public 资源**：public 只有 `favicon.svg` 一项没有找到引用，因为浏览器可能按约定 URL 请求它，所以放在疑似 S10。

## 5 疑似（S1–S10）

| # | 路径:行 与符号 | 类别 | 判定依据 | 删除影响与风险 | 体积 |
| --- | --- | --- | --- | --- | --- |
| S1 | `packages/model-adapters/src/engine-transport.ts:142` `VocalEngineTransport`，以及 L49-133 的传输相关类型 | 仅测试引用 | 生产代码零引用，只被 tests/core.test.ts:39,656 使用。**同文件 L50 的 `SynthesisGainMode` 被 src 广泛使用，必须保留** | AGENTS.md §1 把“VTL 双传输”列为适配器层职责。若采纳代码审阅报告 D-15（前端统一经由适配器调用），应**复用而非删除** | 文件局部 |
| S2 | `packages/core-ts/src/command-bus.ts:904` `CommandBus`、`:295` `UndoRedoStack`、`:345` `applySemanticCommand`、`:113` `applyJsonPatch`、`:162` `diffJsonPatch` | 仅测试引用 | src 中 0 条，只有 tests/core.test.ts:4,415,489 和包内部互相调用 | AGENTS.md §1 把“命令总线”列为内核，前端 store 另有自己的实现（代码审阅报告 D-06）。**建议先决定接入还是废弃** | 40,246 B（整文件） |
| S3 | `packages/core-ts/src/tool-registry.ts`：`AI_TOOL_REGISTRY`、`getToolDefinition`、`DIAGNOSIS_TABLE`、`getRulesByTopic`、`parseChannelAProposalBlocks` | 仅测试引用 | src 中 0 条，只被 tests/core.test.ts:19,21,627,633-634 使用。前端 AI 工具实际走 `src/components/ai/editor-tools.ts`、`project-tools.ts` | 很可能是旧的并行实现。删除前要确认 `schema/tool-registry.json` 是否仍以它为真源 | 22,785 B（整文件） |
| S4 | core-ts 中仅测试引用的导出：`qta.ts:849` `calibrateMonosyllableTone`；`dialect.ts:267,292` 两个方言包；`textgrid.ts:445` `parsePitchTier`、`:521` `exportSubtitles`、`:582` `serializeVcProject`、`:586` `parseVcProject`；`continuum.ts:134` `alignContinuumLandmarks` | 仅测试引用 | src 中 0 条，只有 tests/core.test.ts 引用 | 方言包和字幕导出可能是计划中的功能，建议保留或标注“实验性”。删除时测试要一起删 | — |
| S5 | `src/components/research/ipa-playback-gain.ts`（整个文件，只被 tests/ipa-playback-gain.test.ts:2 引用）；`control-pitch.ts:42` `setPianoNote`；`voice-mixer.ts:271` `MIXER_DEMOS` | 仅测试引用 | 生产代码 0 条，三入口与惰性组件均不引用 | 删除时要同时删除对应测试 | 1,336 B 加若干行 |
| S6 | `engine/model_bundle/src/tt3/` 下 11 个训练侧模块：`kf_dataset`、`kf_text2ipa`、`losses`、`m27_dataset`、`prosody_infer`、`selfplay_generator`、`speaker_dataset`、`state_bank`、`synth_dataset`、`synth_generator`、`train_utils`（均为 `.py`） | 未用 Python 模块 | 用 `git grep -E "(import\|from)\s+[\w.]*\b<模块>\b"` 检索，0 条；用正例 `glottis27_generator`、`tract_anim` 确认检索模式有效。它们不在 `SDK_MODULES`（`build.py:44-45`，只含 6 个模块）中 | `DISCLOSURE.md:22` 把 `engine/model_bundle/` 登记为“只读分发集成”，删除需同步修改 DISCLOSURE。这些是复制品，删除不影响外部基线 | 263,805 B |
| S7 | `scripts/package_ipa_textgrids.py`、`scripts/measure_ipa_vowel_transfer.py`、`scripts/ipa_voice_comparisons.py` | 未用脚本 | 文件名全仓检索均为 0 条 | 可能是参考库素材的再生成脚本，旧清单 L41 把“参考库生成脚本”列为保留项 | 2,654 + 758 + 7,601 B |
| S8 | `engine/generate_prewarm.py`、`engine/generate_explore_recordings.py` | 未用脚本 | 0 条引用，不在 `ENGINE_FILES` 中 | 旧清单 L41 把它们列为素材再生成入口并保留 | 13,920 + 6,575 B |
| S9 | 274 个只在定义文件内使用的导出（例如 `command-bus.ts:41` `JsonPatchOp`、`qta.ts:139` `resolveTargetCandidate`） | 可去掉 `export` | 本文件外 0 条引用 | **不是死代码，不要删除**，只在需要收窄 API 时去掉 `export` | — |
| S10 | `public/favicon.svg` | public 资源 | `index.html:6` 现在用的是 `/app-icon.png`；代码中 `favicon.svg` 0 条，只在 `docs/PROGRESS.md:7`、`docs/devlog/2026-11-22-bootstrap.md:29` 有历史记录 | 浏览器或外部工具可能按约定 URL 请求，因此不列为确定无用；删除风险极低 | 426 B |

## 6 需人工确认（H1–H6）

| # | 路径与符号 | 判定依据（引用、入口、打包、旧兼容） | 删除影响与需要决策的问题 | 体积 |
| --- | --- | --- | --- | --- |
| H1 | `packages/model-adapters/src/reserved-slots.ts`（`KF2TractSlot`、`BrowserLightM27Slot`、`SpeakerModelSlot` 及常量），经 `index.ts:8` 的 `export *` 导出 | src 中 0 条，只被 tests/core.test.ts:37-38,640,650 引用；契约登记在 `docs/MODEL_INTERFACE_SPEC.md:115-117`、`DISCLOSURE.md:36`；引擎侧 `engine/server.py:81-98` 返回 501 | 是否保留未训模型插槽？保留的话按代码审阅报告 D-08 修复 4xx 被吞的问题，并把 `KF2TractSlot`、`fallback_stage4` 改名；删除的话，测试、规范和 `server.py` 契约要同步修改 | 9,772 B |
| H2 | 开发态本地 ASR 链路：`package.json:23` `setup:asr`、`scripts/start-engine.mjs:14-16`、`scripts/setup-asr.py`、`engine/{asr_install,asr_models,speech_to_text}.py`、`src/components/research/reconstruction-asr-setup.ts:8`；运行缓存 `.cache/asr/` | **仍在使用**：`server.py:50-55,244-249,545-561` 在 `LOCAL_ASR_ENABLED` 时提供接口；`verify.py:97-98,222-223` 断言它们不入包 | 开发态是否保留本地转写？若放弃，需整链删除，并修改 MODEL_INTERFACE_SPEC.md:62-64 和对应测试 | 代码约 20 KB；`.cache/asr` 302,950,288 B |
| H3 | `docs/试听/` | 被 `.gitignore:10` 忽略，代码和打包都不引用，**但 `docs/工作台改版验收清单.md:8,15,19,156` 链接了它** | 只存在于本机，删除后无法从 git 恢复。建议验收完成后归档到仓库外 | 521,372,920 B |
| H4 | `.cache/onnx-export-tools/` | `scripts/export_onnx_models.py:3-4,28` 把它当作 `PYTHONPATH`；它是开发工具安装目录，不符合 AGENTS.md §1 对 `.cache/` 的定义 | 是否迁移到仓库外？删除后，再次导出 ONNX 前需重装工具 | 85,083,940 B |
| H5 | `.cache/voice-morph/pillow-12.1.1-cp311-cp311-win_amd64.whl` | `build.py` 不读取它；唯一的引用是 vendor 中 `direct_url.json` 的来源记录（代码审阅报告 P-11） | 是否在 `inputs.lock.json` 中按 URL 和 SHA-256 锁定后删除本地副本？ | 7,031,448 B |
| H6 | `packages/core-ts/src/textgrid.ts:613` `importPtbVocalJson` | src 中 0 条，只被 tests/project-schema.test.ts:3,126,161、fixes-regression.test.ts:4 使用 | **属于旧工程兼容**（`.ptb-vocal.json`）。是否要在 UI 中开放导入入口？ | — |

## 7 public 资源扫描（含运行时 URL 拼接）

`public/` 共 235 个文件，62,850,970 B。按相对路径或文件名能直接命中的，算作在用；剩下 114 个逐一核对运行时拼接：

| 分组 | 数量 | 拼接证据 | 结论 |
| --- | --- | --- | --- |
| `public/nav-art/ui/*-{1,2,4}x.webp`（8 种皮肤 × 3 种密度） | 24 | `src/components/common/NavArtwork.vue:82-83`：`` `${BASE_URL}nav-art/${isAction ? 'actions' : 'ui'}/${artworkSkin}` `` 加 `` `-${density}x.webp` ``；皮肤 id 由 `BUILTIN_SKINS` 校验（L63-64） | 在用，排除 |
| `public/nav-art/actions/*`、`public/nav-art/*` | 33 | 同上（L75、L82） | 在用，排除 |
| `public/audio/salamander-piano/*` | 46 | `src/components/studio/piano.ts:7` `BANK_URL`，L147 按 `` `${root}-${layer}` `` 拼接文件名 | 在用，排除 |
| `public/mediapipe-0.10.14/wasm/vision_wasm_internal.js` | 1 | `public/mediapipe-0.10.14/face-worker.js:8` `FilesetResolver.forVisionTasks(base + 'wasm')`；worker 由 `face-landmarks.ts:791` 加载 | 在用，排除 |
| `public/fonts/*-OFL.txt` 等 | 7 | 字体许可证随字体分发（OFL 要求），字体本身被 CSS 引用 | 在用，排除 |
| `public/prewarm/*`、`public/vocal-tract/vendor/*` | 2 | `explore-case-media.ts:19-21` 引用 `/prewarm/*.mp3`；vendor 是 three 和 OrbitControls 及其许可证 | 在用，排除 |
| `public/favicon.svg` | 1 | 无拼接来源 | **S10 疑似** |

## 8 明确排除（看似无用，实际在用）

| 对象 | 理由与证据 |
| --- | --- |
| 全部 81 个 Vue 组件 | 都有导入方，例如 `ExploreLabView` 由 `hackathon/index.ts:13` 惰性加载，`CardStudioModal` 由 `public.ts:16` 惰性加载 |
| `src/editions/hackathon/` 中 `resolveKanshanStickerFrame`、`EXPLORE_GUIDE_MODULE`、`EXPLORE_TOUR_DEFINITION` | 扫描显示“只被 index 引用”，但 `hackathon/index.ts` 就是参赛版入口，属于 edition 构建时选择 |
| `src/editions/hackathon/assets/*`、`recordings/*.wav` | 由 `contestAssets` 用 readdir 整目录发出（`vite.config.ts:9-29`）；WAV 是 MP3 的源文件，AGENTS §4.3、§4.7 要求仓库保存 |
| `scripts/voqs_references.py` | 子代理初判为无调用方，**主代理纠正**：它被 `scripts/prepare_ipa_references.py:15` 导入 |
| `scripts/startup_splash.py`、`vowel_listening_server.py`、`build_ja_accent_dict.py`、`build-ipa-modifiers.py`、`generate-anatomy-registrations.mjs`、`export_onnx_models.py` | 有直接运行入口（例如 `startup_splash.py:6 --preview`），或在旧清单 L41、`DISCLOSURE.md`、`PACKAGING_WINDOWS.md` 中登记 |
| `scripts/setup-asr.py` | 被 `scripts/start-engine.mjs:15` 使用（归入 H2 整链决策） |
| 除 dotenv 外的全部依赖 | 见第 3 节 |
| `.cache/voqs-native/`、`ipa-references/`、`ipa-library-materials/`（`.part.zip` 除外）、`ipa-neural-lite/`、`local-engine.std{out,err}`、`local-model-registry.json` | 运行时缓存或日志，分别由 `voqs_reference.py`、`ipa_reference_library.py`、`ipa_library_bundle.py:18`、`model_registry_runtime.py` 读写 |
| `src/vendor/m27-tract-studio/tract-renderer.js` 中的 `drawM27CurvesCanvas` | 与 C4 同名，但属于 vendor 实现，本清单不涉及 |

## 9 主代理裁决记录

| 事项 | 子代理 B | 主代理裁决与依据 |
| --- | --- | --- |
| `Launcher.cs`、`build_asr_cpu.py` 及 `asr_build_wheels` | 疑似 | **改判为确定无用**（C6、C7）：全仓 0 调用方，不在入口或允许清单中，且 `build_asr_cpu.py` 违反 §4.3 |
| `scripts/voqs_references.py` | 疑似 | **移入排除**：被 `prepare_ipa_references.py:15` 导入 |
| `.cache/voice-morph/presets.json` | 要求保留 | 该文件当前不存在，用时才创建，因此 C8 可覆盖除 wheel 外的全部文件 |
| src 私有导出、tt3 训练模块、public 资源 | 未覆盖 | 主代理补扫，新增 C4、S5、S6、S9、S10 及第 7 节 |
| 依赖扫描 | 未实测 | 早期 PowerShell 正则版本因引号转义错误全部报 0，作废；以 `deps_scan.py` 的结果为准（第 3 节） |
| 体积 | 未实测 | 主代理已全部实测 |

## 10 建议的删除顺序与验证

1. 先删本地留存（C8、C9），不影响 git，可随时再生成。
2. 再把 C1–C7 放在一个提交里删除。删后依次执行：`npm run typecheck`、`npm test`、`& 'F:/TensorTract3_Train/.venv/Scripts/python.exe' -B -m unittest discover -s engine/tests`、`npm run build`、`npm run build:hackathon`、`npm run build:friends`（三版的 `check-edition` 都必须通过）。C7 改动了打包脚本，还要跑一次 `npm run portable:public`，并执行 `scripts/portable/verify.py`。
3. S 组和 H 组由井井决策后再单独提交，尤其是 S2、S3、H1、H2。
4. 避开用户当前的未提交文件（`ExportModal.vue`、`M27ReconstructView.vue`、`m27-realtime.ts`、`AlignedPianoRoll.vue`、`StudioArrangerView.vue`、`StudioStageView.vue`、`midi-score.ts`、`guide-modules-creative.ts`）。本清单的候选项都不在这些文件中。

## 11 合规声明

未读取 `.env.local`，未输出任何密钥或 BYOK 请求头，未写入 `F:\TensorTract3_Train` 或 `D:\PhoneticToolbox\PhoneticToolbox_v3`，未修改或删除任何候选文件。临时脚本放在 `.cache/review-tmp/`，已删除。`KF2TractSlot`、`fallback_stage4` 等旧称只作为代码标识符的证据引用。
