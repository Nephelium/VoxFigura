# VoxFigura 老旧死代码与冗余资源独立二次复核报告（待井井审批）

> 复核日期：2026-11-26 · 方式：全程只读复核，**零删除、零源码修改**
> 基准文件：[DEAD_CODE_CANDIDATES.md](./DEAD_CODE_CANDIDATES.md)（原初审保留未改）
> 代码基线：同伴 1（后端/引擎/打包加固）与同伴 2（前端/内核/适配器修复）全部落盘并通过全量验证后的最新代码树（Python 94/94、Vitest 40/40 文件 234/234 用例、`npm run typecheck` 通过、`cargo check --locked` 通过）

## 0. 核心复核结论摘要

1. **三项状态发生实质变化（相对原 `DEAD_CODE_CANDIDATES.md`）**：
   - **S1（`packages/model-adapters/src/engine-transport.ts`）已复活，正式移出死代码清单**：D-15 收敛后，`defaultVtlTransport` 已被 `src/` 中 9 个生产文件（12 处 `/api/vtl/*` 调用）直接消费，全仓 `src/` 裸 `fetch('/api/(m27|vtl)/')` 清零并受回归测试守卫。
   - **C2 拆分降级**：`packages/core-ts/src/phonation.ts` 中 `evaluatePhonationTrackDense`（L305）在 A-16 修复后固化为密集连续发声态插值 API 并接入单测 `tests/review-2026-11-26-fixes.test.ts:14,598`，从确定无用**降级为疑似/建议保留（S4 组）**；同文件 `M27_GLOTTIS_DIM_NAMES`（L62）与 `VOQS_NOTE`（L389）仍为确定无用（C2 缩减为 2 项）。
   - **H1（`packages/model-adapters/src/reserved-slots.ts` 与 `engine/server.py` 501 空槽）已有明确业务倾向**：井井已确认全部 7 个核心自研模型及 `DPDFNet2`、`SwiftF0` 共 9 个 ONNX 槽位已正式上线，`/models/browser-light-m27` 与 `/models/speaker` 仅是早期预留的 501 扩展空槽，当前前端生产路径零调用且暂无单独训练计划，**用户已倾向评估后整体清理**（本轮未删除，列入待审批清理项）。
2. **两项边界条件与事实勘误**：
   - **C7 新增单测联动点**：`scripts/portable/build.py` 的 `asr_build_wheels` 过滤逻辑因打包加固移至 **L492**，且新单测 `engine/tests/test_security_and_packaging_hardening.py:282` 含有临时断言 `self.assertIn("asr_build_wheels", lock)`。审批删除 C7 时必须同步更新该测试断言。
   - **C8 文件数勘误**：`.cache/voice-morph/` 除 Pillow wheel 外的实际清理对象共 **66 个文件**（顶层 59 个加 `playwright/` 子目录 7 个），总字节 `19,695,753 B` 与初审一致。
   - **H5 状态改善**：P-02 与 P-11 已将 vendored Pillow 全部 114 个运行文件逐项锁定至 `scripts/portable/inputs.lock.json` 并排除 `direct_url.json`，`.cache/voice-morph/pillow-12.1.1-cp311-cp311-win_amd64.whl`（7,031,448 B）不再承担唯一来源记录职责，确认无需离线重装后可优先回收。
   - **H2 风险收敛**：P-09 已将开发态本地 ASR 改为默认关闭（须显式 `VOCALCUT_ENABLE_LOCAL_ASR=1` 启用），`.cache/asr/` 仍占用 `302,950,288 B`（324 文件），待决策去留。
3. **补扫初审未覆盖范围（Python `engine/` 内部函数/方法、`engine/model_bundle/`、`packages/g2p-ts/`）的新发现**：
   - **新增确定无用 3 项**：
     - **PY-1**：`engine/model_registry_runtime.py:534` `LocalModelManager.is_in_memory`（全仓 0 引用，4 行）；
     - **PY-2**：`engine/trills.py:94-105` `trill_intervals`（生产与测试 0 引用，12 行；`engine/vtl_native/` 引用的是同包独立副本）；
     - **NEW-1**：`packages/g2p-ts/src/reading-repairs.ts:3` `readingRepairVersion`（全仓 0 引用，连同包 `index.ts` 也未再导出，1 行）。
   - **新增疑似/设计取舍 2 组（S6 扩展）**：
     - **PY-S1**：`engine/model_bundle/src/tt3/` 下 6 个零运行时引用且不在 `scripts/export_onnx_models.py` 传递依赖链中的旧 PyTorch 推理/训练孤岛模块（`align_v2_infer.py`、`align_infer.py`、`streaming_corpora.py`、`inference.py`、`vtl_synth.py`、`playback.py`，合计 `111,346 B`）；
     - **PY-S2**：`engine/model_bundle/m27_tract_studio/` 整个独立子包（5 个 `.py` 及配套文件，合计 `103,428 B`；全仓生产、测试与 ONNX 导出零导入，前端渲染器已独立存放于 `src/vendor/m27-tract-studio/`）。
   - **明确排除误判项**：Python 引擎 4 个缓存测试钩子（`clear_synthesis_caches`、`get_synthesis_cache_stats`、`clear_vtl_caches`、`get_vtl_cache_stats`）、`packages/g2p-ts/` 与上游 `PhoneticToolbox_v3` 同步的完整包导出、根目录 `.sd` 与 `.stabledge/`（`stabledge` 工具元数据）均**非死代码，必须保留**。

---

## 1. 复核方法与新增覆盖维度

- **交叉验证范围**：覆盖 `src/`、`packages/`（补齐 `g2p-ts`）、`server/`、`scripts/`、`engine/`（补齐全部 32 个顶层 `.py` 的 AST 函数/类/方法调用图可达性及 `model_bundle/` 全部 62 个 `.py`）、`tests/`（含新增未跟踪测试 `tests/review-2026-11-26-fixes.test.ts`、`tests/security-cache-proxy.test.ts`、`engine/tests/test_security_and_packaging_hardening.py`）、`src-tauri/`、`public/`、`.cache/` 与根配置。
- **动态导入复核**：确认全仓零非字面量 `import.meta.glob` / 变量动态导入。已核实全部字面量动态导入（`App.vue:36-38`、`editions/public.ts:16-17`、`editions/hackathon/index.ts:13`、`ExploreLabView.vue:259-260`、`VocalTractViewport.vue:60`、`card-renderer.ts:92`、`LiveHead3DStage.vue:74-78`、`packages/vocal-tract-view/locales/loaders.mjs:3-4`、`server/portable.mjs:131-132` 及 Node 仅测试用 `fs/path/zlib` 懒加载），均不涉及任何确定无用候选模块。
- **磁盘实测口径**：全部体积均在 2026-11-26 最新工作区独立重新统计，以精确字节数记录。

---

## 2. 原清单 C1–C9（确定无用组）逐项二次复核

| 编号 | 对象与最新位置 | 原结论 | 二次复核状态 | 最新实证与变动说明 | 实测体积 | 审批建议 |
| --- | --- | --- | --- | --- | --- | --- |
| **C1** | `packages/core-ts/src/qta.ts:921` `fitHanddrawnToQtaTarget`（原 L887） | 确定无用 | **维持确定无用** | 全仓仅定义 1 处，prod=1（仅自身）、test=0，三入口 0/0/0 | 单函数 | 批准删除 |
| **C2** | `packages/core-ts/src/phonation.ts`：`M27_GLOTTIS_DIM_NAMES`（L62）、`VOQS_NOTE`（L389）、`evaluatePhonationTrackDense`（L305） | 确定无用 | **拆分变更**：前 2 项维持确定无用；`evaluatePhonationTrackDense` **降级为疑似（仅测试引用）** | `M27_GLOTTIS_DIM_NAMES` 与 `VOQS_NOTE` 仍为全仓 0 引用；`evaluatePhonationTrackDense` 在 A-16 固化双语义后已被 `tests/review-2026-11-26-fixes.test.ts:14,598` 覆盖测试 | 约 10 行（仅 C2a 2 项） | 仅删 `M27_GLOTTIS_DIM_NAMES` 与 `VOQS_NOTE`；保留 `evaluatePhonationTrackDense` |
| **C3** | `packages/core-ts/src/types.ts:12` `SAMPLES_PER_FRAME_60FPS`、`:133` `SampleInterval`、`:143` `Tract17ParamName`；`textgrid.ts:466` `exportIntensityTier`；`tool-registry.ts:434` `exportOpenAiToolsSchema` | 确定无用 | **维持确定无用** | 全部 5 项均仅命中定义 1 处，test=0，不在工程 Schema 字段中 | 约 45 行 | 批准删除（若计划支持 Praat IntensityTier 导出可单留 `exportIntensityTier`） |
| **C4** | `src/` 中 12 个零引用导出：`card-renderer.ts:37,323,577,621`；`m27-hd-renderers.ts:86,942`；`research-utils.ts:39,503`；`prosody-model.ts:49,368`；`ptb-ipa-presets.ts:42,83` | 确定无用 | **维持确定无用** | 12 项均仅命中定义 1 处，test=0（`drawM27CurvesCanvas` 另 4 处属 `src/vendor/m27-tract-studio/` 独立副本，互不导入） | 约 120 行 | 批准删除 |
| **C5** | `package.json:28` 依赖 `dotenv` | 确定无用 | **维持确定无用** | 全仓源码 import 仍为 0；`THIRD_PARTY.md:9` 已注明待审核移除 | `node_modules/dotenv` 76,591 B（12 文件） | 批准 `npm uninstall dotenv` 并同步更新 `package-lock.json` 与 `THIRD_PARTY.md` |
| **C6** | `scripts/portable/Launcher.cs` | 确定无用 | **维持确定无用** | 全仓 0 引用；`docs/PACKAGING_WINDOWS.md:85` 已切换为 Tauri 2 与 WebView2 | 6,640 B | 批准删除 |
| **C7** | `scripts/portable/build_asr_cpu.py`、`scripts/portable/inputs.lock.json:79-95` `asr_build_wheels`、`scripts/portable/build.py:492` 过滤条件 | 确定无用 | **维持确定无用（新增单测联动点）** | 与 `AGENTS.md §4.3` 禁入 CTranslate2 规则直接冲突；**联动更新**：`build.py` 过滤行已移至 L492，且 `engine/tests/test_security_and_packaging_hardening.py:282` 含临时守卫 `assertIn("asr_build_wheels", lock)` | 5,792 B 加 lock 17 行 | 批准三处联动删除，并同步将新单测 L282 改为 `assertNotIn` |
| **C8** | `.cache/voice-morph/` 除 Pillow wheel 外的全部临时脚本与 QA 媒体产物 | 确定无用 | **维持确定无用（修正文件计数）** | 实测共 **66 个文件**（顶层 59 个加 `playwright/` 子目录 7 个，原初审漏计子目录 7 文件）；运行时仅需 `presets.json`（当前不存在，按需创建）；违反 `AGENTS.md §1` `.cache/` 规定 | 19,695,753 B | 批准清理（保留目录或仅删这 66 个文件） |
| **C9** | `.cache/ipa-library-materials/f79902ea6dea4db4a9a014e8133e43b1.part.zip`；`.playwright-cli/`；`dist-public/`、`dist-hackathon/`、`dist-friends/` | 确定无用 | **维持确定无用（可再生成）** | `.part.zip` 为 0 B 残片；`.playwright-cli` 215 文件；`dist-friends/assets` 仍堆积 37 个历史 `index-*.js`（`dist-public` 77,243,483 B + `dist-hackathon` 279,691,167 B + `dist-friends` 320,763,007 B） | `.part.zip` 0 B；`.playwright-cli` 5,089,343 B；`dist-*` 677,697,657 B | 批准清理（清理 `dist-*` 后执行三版 `npm run build*` 重建干净产物） |

---

## 3. 原清单 S1–S10（疑似组）逐项二次复核

| 编号 | 对象与最新位置 | 原结论 | 二次复核状态 | 最新实证与变动说明 | 实测体积 | 审批建议 |
| --- | --- | --- | --- | --- | --- | --- |
| **S1** | `packages/model-adapters/src/engine-transport.ts`（`VocalEngineTransport`、`defaultVtlTransport` 及配套类型） | 疑似 | **已复活（移出死代码）** | D-15 收敛后导出单例 `defaultVtlTransport` 已被 `src/` 中 **9 个生产文件**（12 处 `/api/vtl/*`）直接消费，并受 `tests/review-2026-11-26-fixes.test.ts` 回归测试保护 | — | **保留，严禁删除** |
| **S2** | `packages/core-ts/src/command-bus.ts`（`CommandBus`、`UndoRedoStack`、`applySemanticCommand`、`applyJsonPatch`、`diffJsonPatch`） | 疑似 | **维持疑似（仅测试引用）** | `src/stores/workbench.ts:1154` 仅为注释引用，生产代码仍未导入；同伴 2 已按 D-06 修复其单调 `revision` 与 `oplog` 截断并补充单测 | 40,246 B（整文件） | 暂缓删除；待后续中期规划决定是将 `workbench.ts` 接入 `CommandBus` 还是正式退役 |
| **S3** | `packages/core-ts/src/tool-registry.ts`（`AI_TOOL_REGISTRY`、`getToolDefinition`、`DIAGNOSIS_TABLE`、`getRulesByTopic`、`parseChannelAProposalBlocks`） | 疑似 | **维持疑似（仅测试引用）** | `src/` 生产引用仍为 0，前端 AI 工具独立使用 `src/components/ai/{editor,project}-tools.ts` | 22,785 B（整文件） | 待确认 `schema/tool-registry.json` 与未来 CLI/MCP 出口是否仍依赖本模块，再决定去留 |
| **S4** | `packages/core-ts/` 仅测试引用导出：`qta.ts:883` `calibrateMonosyllableTone`；`dialect.ts:267,292` `MANDARIN_DIALECT_PACK` / `CANTONESE_DIALECT_PACK`；`textgrid.ts:445,521,582,586` `parsePitchTier` / `exportSubtitles` / `serializeVcProject` / `parseVcProject`；`continuum.ts:134` `alignContinuumLandmarks`；**新增转入 `phonation.ts:305` `evaluatePhonationTrackDense`** | 疑似 | **维持疑似（含 C2 转入项）** | 均仅被 `tests/core.test.ts` 或 `tests/review-2026-11-26-fixes.test.ts` 引用，属内核工具函数与规划能力 | 约 180 行 | 建议保留（属 Headless Core 完整 API 与测试覆盖范围） |
| **S5** | `src/components/research/ipa-playback-gain.ts`（整文件）；`control-pitch.ts:42` `setPianoNote`；`voice-mixer.ts:298` `MIXER_DEMOS` | 疑似 | **维持疑似（仅测试引用）** | 生产代码与三入口均为 0；分别仅被 `tests/ipa-playback-gain.test.ts:2`、`tests/core.test.ts:42,396`、`tests/app-update.test.ts:13,129-131` 引用 | 1,336 B 加若干行 | 可由井井按需批准与对应单测一并清理 |
| **S6** | `engine/model_bundle/src/tt3/` 原 11 个训练侧模块（`kf_dataset`、`kf_text2ipa`、`losses`、`m27_dataset`、`prosody_infer`、`selfplay_generator`、`speaker_dataset`、`state_bank`、`synth_dataset`、`synth_generator`、`train_utils`） | 疑似 | **维持疑似（并扩展见 §5 PY-S1/PY-S2）** | 运行时、`export_onnx_models.py` 与 `build.py` `SDK_MODULES` 均为 0 引用；属 `DISCLOSURE.md:22` 登记的上游只读分发包副本 | 263,805 B | 若追求精简仓体积，可与 PY-S1/PY-S2 一并审批裁剪并同步更新 `DISCLOSURE.md`；若保留与上游同步完整性则维持现状 |
| **S7** | `scripts/package_ipa_textgrids.py`（2,654 B）、`scripts/measure_ipa_vowel_transfer.py`（758 B）、`scripts/ipa_voice_comparisons.py`（7,601 B） | 疑似 | **维持疑似** | 全仓代码与文档引用均为 0；属参考库数据制作/核查工具脚本 | 11,013 B | 建议保留作参考库再生工具，或由井井确认不再再生后归档移除 |
| **S8** | `engine/generate_prewarm.py`（13,920 B）、`engine/generate_explore_recordings.py`（6,575 B） | 疑似 | **维持疑似** | 全仓无调用方，不在 `ENGINE_FILES` 中；属预热与探索素材再生入口 | 20,495 B | 建议保留作素材再生入口 |
| **S9** | 仅在定义文件内使用的多余 `export` 修饰符（约 270+ 处） | 疑似（非死代码） | **维持排除（非死代码）** | 文件内部正常使用，仅可按需收窄可见性，绝不可删除实现体 | — | 不需清理 |
| **S10** | `public/favicon.svg` | 疑似 | **维持疑似** | `index.html:6` 实际使用 `/app-icon.png`，代码中 0 处引用；浏览器或外部爬虫仍可能按约定请求 `/favicon.svg` | 426 B | 体积可忽略，保留或删除均可 |

---

## 4. 原清单 H1–H6（需人工确认组）逐项二次复核

| 编号 | 对象与最新位置 | 原结论 | 二次复核状态 | 最新实证与决策背景 | 实测体积 | 审批建议 |
| --- | --- | --- | --- | --- | --- | --- |
| **H1** | `packages/model-adapters/src/reserved-slots.ts`（现含 `IPA2TractSlot` / `Vox2TractBrowserSlot` / `SpeakerModelSlot` 及 `@deprecated` 旧别名）与 `engine/server.py` `RESERVED_MODEL_CONTRACTS`（`/models/browser-light-m27`、`/models/speaker`） | 需人工确认 | **维持需人工确认（用户已倾向清理）** | D-08 已修复 4xx 透传与官方命名，但 `src/` 生产引用仍为 **0**。**井井已确认**：全部 7 个核心自研模型及 `DPDFNet2`、`SwiftF0` 共 9 个 ONNX 槽位已正式上线，这两个 501 空槽暂无单独训练计划。 | `reserved-slots.ts` 15,826 B（更新后）加 `server.py` 约 35 行 | **建议批准整链清理**：删除 `reserved-slots.ts`、`packages/model-adapters/src/index.ts` 导出、`engine/server.py` 501 契约与对应单测，并同步清理 `docs/MODEL_INTERFACE_SPEC.md` §6（保留 `/models/kf2tract` 兼容路由，因它是 `IPA2Tract-Lite` 真实接口） |
| **H2** | 开发态本地 ASR 链路：`package.json:23` `setup:asr`、`scripts/start-engine.mjs:14-16`、`scripts/setup-asr.py`、`engine/{asr_install,asr_models,speech_to_text}.py`、`src/components/research/reconstruction-asr-setup.ts` 及 `.cache/asr/` | 需人工确认 | **维持需人工确认（默认已关闭）** | 本次 P-09 修复已使引擎默认关闭本地 ASR（须显式 `VOCALCUT_ENABLE_LOCAL_ASR=1` 启用），安全风险大幅下降；但 `.cache/asr/` 本地缓存仍占 302.95 MB | 代码约 22 KB；`.cache/asr` 302,950,288 B（324 文件） | 请井井决定：选项 A 保留开发态按需入口并可单独清空 `.cache/asr/` 回收 303 MB；选项 B 彻底移除本地 ASR 链路（完全走手动原文与 DeepSeek BYOK） |
| **H3** | `docs/试听/` | 需人工确认 | **维持需人工确认** | 被 `.gitignore:10` 忽略，仅存在于本机（删除无法从 git 恢复）；`docs/工作台改版验收清单.md:8,15,19,156` 仍链接其中对照样本 | 521,372,920 B（27 文件） | 验收完全结束后移至仓库外归档，不建议直接删除 |
| **H4** | `.cache/onnx-export-tools/` | 需人工确认 | **维持需人工确认** | 供 `scripts/export_onnx_models.py` 导出 ONNX 时作 `PYTHONPATH` 使用，但属工具安装目录，不符合 `.cache/` 定位 | 85,083,940 B（3,403 文件） | 建议迁移至仓库外目录或确认近期不再重新导出 ONNX 后清理 |
| **H5** | `.cache/voice-morph/pillow-12.1.1-cp311-cp311-win_amd64.whl` | 需人工确认 | **状态改善（可优先批准回收）** | 本次 P-02 与 P-11 修复已在 `scripts/portable/inputs.lock.json` 中逐文件锁定 vendored Pillow 全部 114 个文件的 SHA-256 并从产物排除 `direct_url.json`，本 wheel 副本不再承担唯一来源记录职责 | 7,031,448 B | 确认近期无需离线重装 Pillow wheel 后可批准删除 |
| **H6** | `packages/core-ts/src/textgrid.ts:613` `importPtbVocalJson` | 需人工确认 | **维持需人工确认** | `src/` 0 引用，仅被 `tests/core.test.ts`、`tests/fixes-regression.test.ts`、`tests/project-schema.test.ts` 覆盖测试；属 `.ptb-vocal.json` 旧工程格式兼容代码 | 单函数 | 若仍需支持旧版 PhoneticToolbox 声道工程导入则保留并考虑开放 UI 入口；否则可与对应测试一并移除 |

---

## 5. 新增补扫发现（Python `engine/` 内部与其余子包）

原 `DEAD_CODE_CANDIDATES.md` 第 1 节明确标注未覆盖 Python 引擎内部函数级死代码，且未扫描 `packages/g2p-ts/`。本次基于最终稳定代码树完成了全量 AST 调用图可达性与跨文件引用补扫，结果单列如下：

### 5.1 新增确定无用候选项（PY-1 / PY-2 / NEW-1）

| 编号 | 路径与符号 | 类型 | 实证依据（AST + 全仓检索） | 删除影响与风险 | 规模 |
| --- | --- | --- | --- | --- | --- |
| **PY-1** | `engine/model_registry_runtime.py:534` `LocalModelManager.is_in_memory` | Python 类方法 | 全仓（`engine/`、`scripts/`、`tests/`、`src/`）检索仅命中 L534 定义本身，prod=0、test=0；外部全部读取 `list_status()` 中的 `in_memory` 布尔键 | 删除后运行 Python unittest 确认无影响，风险极低 | 4 行 |
| **PY-2** | `engine/trills.py:94-105` `trill_intervals` | Python 顶级函数 | 运行时 `engine/*.py`、脚本与测试中均为 0 引用，AST 可达性检查确认属文件内不可达孤岛；`engine/vtl_native/phonetic_core/vocal_tract/animation.py:12,64` 引用的是 `vtl_native` 包内同名副本 `vtl_native/.../trills.py:26` | 删除后运行 Python unittest 确认无影响，风险极低 | 12 行 |
| **NEW-1** | `packages/g2p-ts/src/reading-repairs.ts:3` `readingRepairVersion` | TS 导出常量 | 全仓仅 L3 定义 1 处，连同包 `packages/g2p-ts/src/index.ts` 也未再导出，prod=0、test=0 | 删除后跑 `npm run typecheck` 与 `npm test`，风险极低 | 1 行 |

### 5.2 新增疑似/设计取舍候选项（PY-S1 / PY-S2 / NEW-2）

| 编号 | 路径与对象 | 类别 | 实证依据 | 实测体积 | 处置建议 |
| --- | --- | --- | --- | --- | --- |
| **PY-S1** | `engine/model_bundle/src/tt3/` 增补 6 个孤岛/旧 PyTorch 推理模块：`align_v2_infer.py`（34,907 B）、`align_infer.py`（25,590 B）、`streaming_corpora.py`（20,457 B）、`inference.py`（25,233 B）、`vtl_synth.py`（4,420 B）、`playback.py`（739 B） | 未用 Python 模块（S6 扩展） | 追踪 `engine/*.py` 运行时与 `scripts/export_onnx_models.py` 全部传递依赖链（`align_v2_models`、`browser_m27_models`、`kf_models`、`neural_synth_models`、`prosody_models`、`m27_contract`、`align_models`、`distill_models`、`m27_models`、`kf_baseline`、`kf_phonetics`）后确认：上述 6 个模块均不在运行时、ONNX 导出链或 `build.py` `SDK_MODULES` 中；其中 `streaming_corpora.py` 仅被原 S6 训练模块引用，`align_v2_infer.py` 已被纯 ONNX `engine/onnx_inference.py` 替代 | 111,346 B | 与原 S6（263,805 B）合并决策；删除须同步更新 `DISCLOSURE.md:22` |
| **PY-S2** | `engine/model_bundle/m27_tract_studio/` 整个独立子包（5 个 `.py` 及 `pyproject.toml`、`README.md`） | 未用 Python 子包（S6 扩展） | 全仓 `engine/*.py`、`scripts/`、测试及 ONNX 导出零导入（前端渲染器已独立存放于 `src/vendor/m27-tract-studio/`）；仅在 `DISCLOSURE.md:22,27` 与文档作为上游集成记录 | 103,428 B | 同上，按是否保持上游分发包完整性由井井决策 |
| **NEW-2** | `packages/g2p-ts/src/` 中 `custom-tables.ts`、`state.ts` 等约 25 个仅通过 `packages/g2p-ts/src/index.ts` 再导出、当前前端未直接消费的导出 | 上游独立包完整 API | 属从 `PhoneticToolbox_v3` 整体迁入的零框架耦合多语 G2P 独立包接口，不构成局部残片 | — | **建议保留**，以便后续与上游 `PhoneticToolbox_v3` 保持同步 |

### 5.3 独立复核明确排除项（非死代码，严禁误删）

| 对象 | 实证排除理由 |
| --- | --- |
| `engine/chunked_synthesis.py:116,121` `clear_synthesis_caches` / `get_synthesis_cache_stats`；`engine/dense_channel.py:153,158` `clear_vtl_caches` / `get_vtl_cache_stats` | 专为 `engine/tests/test_chunked_streaming.py` 与 `test_vtl_lossless_accel.py` 设计的缓存隔离与命中观测测试钩子 |
| `packages/model-adapters/src/engine-transport.ts`（原 S1） | 已由 D-15 全面接入生产代码（`defaultVtlTransport` 被 9 个生产文件调用） |
| 根目录 `.sd`（68 B，git 跟踪）与 `.stabledge/`（633,862 B） | `stabledge` 版本工具元数据（commit `95843e7`），非业务冗余 |
| `scripts/portable/VoxFigura.cmd`（188 B）与 `README.txt`（1,153 B） | 仍被 `scripts/portable/build.py:230` 打包引用 |
| `public/` 下其余 239 个文件（含被 `.gitignore` 忽略的 `public/onboarding/`，总计 240 文件 / 63,179,382 B） | 逐一核实路径或运行时动态拼接规则，唯一无直接引用项仍仅 `public/favicon.svg`（S10） |
| 磁盘信息提示（非死代码，仅供空间规划参考）：`build/`（7,858,493,317 B，含离线复现所需 `build/portable-inputs/` 与历史打包输出）、`src-tauri/target/`（2,098,898,121 B，Rust 编译缓存）、`refs/`（39,721,514 B，被 `.gitignore` 忽略的 VTL 2.4 手册与参考归档） | 属构建缓存与本地研发参考资料；若需清理 `build/`，务必保留 `build/portable-inputs/` 以免破坏 `--offline` 离线复现打包 |

---

## 6. 待井井审批的分批清理建议清单

本清单严守只审不删原则，以下分批方案仅在获得井井明确审批后执行：

1. **第一批（零代码风险 · 本地可回收约 709.5 MB）**：
   - **C8**：清理 `.cache/voice-morph/` 除 wheel 外的 66 个临时脚本与 QA 文件（19.70 MB）；
   - **C9**：清理 `.cache/ipa-library-materials/*.part.zip`（0 B）、`.playwright-cli/`（5.09 MB）及 `dist-public/` / `dist-hackathon/` / `dist-friends/`（677.70 MB，清理后重跑三版 `npm run build*` 验证干净重建）；
   - **H5**（可选并入第一批）：清理 `.cache/voice-morph/pillow-12.1.1-cp311-cp311-win_amd64.whl`（7.03 MB，vendor 已逐文件锁定）。
2. **第二批（确定无用源码、依赖与残留打包脚本 · 极低风险）**：
   - **C1、C2a（仅 `M27_GLOTTIS_DIM_NAMES`、`VOQS_NOTE`）、C3、C4、PY-1、PY-2、NEW-1**：清理 20 个零引用 TS 导出与 2 个零引用 Python 引擎函数/方法；
   - **C5**：`npm uninstall dotenv` 并同步更新 `package-lock.json` 与 `THIRD_PARTY.md:9`；
   - **C6、C7**：删除 `scripts/portable/Launcher.cs`、`scripts/portable/build_asr_cpu.py`、移除 `inputs.lock.json` 的 `asr_build_wheels` 与 `build.py:492` 过滤条件，并同步将 `engine/tests/test_security_and_packaging_hardening.py:282` 改为 `assertNotIn`。
   - 验证基线：`npm run typecheck`、`npm test`、Python `unittest`、三版 `npm run build*`（过 `check-edition.mjs`）及 `npm run portable:public -- --stage-only`。
3. **第三批（业务/架构决策项 · 按井井勾选执行）**：
   - **H1**（用户已倾向清理）：整体清理早期 501 空槽（`reserved-slots.ts`、`engine/server.py` `RESERVED_MODEL_CONTRACTS` 及对应单测/文档，保留 `/models/kf2tract` 真实路由）；
   - **H2**（开发态本地 ASR 与 `.cache/asr/` 302.95 MB）、**H3**（`docs/试听/` 521.37 MB 归档）、**H4**（`.cache/onnx-export-tools/` 85.08 MB 迁移）、**H6**（`importPtbVocalJson`）；
   - **S2 / S3 / S5 / S6 + PY-S1 + PY-S2 / S10** 按架构取舍逐项确认。

---

## 7. 合规声明

本次独立二次复核阶段全程只读；经井井正式书面授权后，具体源码、依赖与缓存清理由同伴 1（后端/引擎/打包）与同伴 2（前端/`packages/`）分域执行，本文件与配套指导文档仅做事实同步记录。全程未读取 `.env.local`，未写入 `F:\TensorTract3_Train` 或 `D:\PhoneticToolbox\PhoneticToolbox_v3`，未触碰用户未提交的 `docs/plans/2026-11-26-VoxFigura研究者向宣传片分镜与剧本.md`，亦未留下任何临时脚本文件。

---

## 8. 清理执行记录（已删除 vs 刻意保留）

> 执行日期：2026-11-26 · 授权依据：井井正式批准清理确定无用死代码、早期 501 空槽（H1）、Pillow wheel（H5）与前端废弃测试孤岛（S5），并明确指定保留范围。

### 8.1 已执行清理清单

| 类别 / 编号 | 执行清理明细 | 执行方 | 实测清理规模 / 回收体积 |
| --- | --- | --- | --- |
| **C1** | 删除 `packages/core-ts/src/qta.ts` 的 `fitHanddrawnToQtaTarget` | 同伴 2 | 单函数 |
| **C2a** | 删除 `packages/core-ts/src/phonation.ts` 的 `M27_GLOTTIS_DIM_NAMES` 与 `VOQS_NOTE`（保留 `evaluatePhonationTrackDense`、`M27_GLOTTIS_BOUNDS`、`evaluatePhonationAnchorsAt`） | 同伴 2 | 2 项导出 |
| **C3** | 删除 `types.ts` 的 `SAMPLES_PER_FRAME_60FPS`、`SampleInterval`、`Tract17ParamName`；删除 `textgrid.ts` 的 `exportIntensityTier`；删除 `tool-registry.ts` 的 `exportOpenAiToolsSchema` | 同伴 2 | 5 项导出 |
| **C4** | 删除 `card-renderer.ts` 4 项及 2 个变孤立类型导入；删除 `m27-hd-renderers.ts` 2 项及孤立私有辅助；删除 `research-utils.ts` 2 项、`prosody-model.ts` 2 项、`ptb-ipa-presets.ts` 2 项 | 同伴 2 | 12 项导出加孤立私有辅助 |
| **NEW-1** | 删除 `packages/g2p-ts/src/reading-repairs.ts` 的 `readingRepairVersion` | 同伴 2 | 1 项导出 |
| **C5** | 执行 `npm uninstall dotenv`，同步更新 `package.json`、`package-lock.json` 与 `THIRD_PARTY.md` | 同伴 2 / 文档同步 | `node_modules/dotenv` 76,591 B（12 文件） |
| **PY-1 / PY-2** | 删除 `engine/model_registry_runtime.py` 的 `LocalModelManager.is_in_memory`；删除 `engine/trills.py` 的 `trill_intervals` 及冗余 `Iterable` 导入（`engine/vtl_native/` 同名在用副本未改动） | 同伴 1 | 2 处 Python 死函数/方法 |
| **C6** | 删除 `scripts/portable/Launcher.cs` | 同伴 1 | 6,640 B（1 文件） |
| **C7** | 删除 `scripts/portable/build_asr_cpu.py`；从 `scripts/portable/inputs.lock.json` 移除 `asr_build_wheels`；移除 `scripts/portable/build.py` 对应过滤；`engine/tests/test_security_and_packaging_hardening.py` 改为 `assertNotIn("asr_build_wheels", lock)` | 同伴 1 | 5,792 B（1 文件）加 lock 3 项配置 |
| **H1（整链）** | 删除 `packages/model-adapters/src/reserved-slots.ts`、移除 `packages/model-adapters/src/index.ts` 对应再导出及 `tests/core.test.ts`、`tests/review-2026-11-26-fixes.test.ts` 槽位用例；从 `engine/server.py` 移除 `RESERVED_MODEL_CONTRACTS` 与 `/models/browser-light-m27`、`/models/speaker` 501 分支（完整保留 `/models/kf2tract` 真实 `IPA2Tract-Lite` 兼容路由）；同步更新 `AGENTS.md`、`docs/MODEL_INTERFACE_SPEC.md`、`docs/OPEN_QUESTIONS.md`、`docs/PROGRESS.md`、`DISCLOSURE.md` | 同伴 1 / 同伴 2 / 文档同步 | 前端 1 文件（15,826 B）加后端 501 分支 |
| **S5** | 删除 `src/components/research/ipa-playback-gain.ts` 与 `tests/ipa-playback-gain.test.ts`；删除 `control-pitch.ts` 的 `setPianoNote` 与 `voice-mixer.ts` 的 `MIXER_DEMOS` 及对应孤立单测 | 同伴 2 | 2 文件加 2 项导出及孤立用例 |
| **C8 + H5** | 清空 `.cache/voice-morph/` 全部 67 文件（含 66 个临时脚本/QA 产物/playwright 日志与 `pillow-12.1.1-cp311-cp311-win_amd64.whl` 7,031,448 B）；删除 `.cache/ipa-library-materials/f79902ea6dea4db4a9a014e8133e43b1.part.zip`（0 B）；删除 `.playwright-cli/`（215 文件） | 同伴 1 | 283 文件，回收 **31,816,544 B**（30.34 MiB） |
| **C9** | 删除历史堆积构建目录 `dist-public/`（280 文件，84,329,717 B）、`dist-hackathon/`（650 文件，287,632,242 B）、`dist-friends/`（644 文件，327,850,534 B） | 同伴 1 | 1,574 文件，回收 **699,812,493 B**（667.39 MiB） |

- **本地磁盘总回收（不含已删少量源码文本差量）**：后端/缓存侧共计清理 **1,859 文件**、回收 **731,641,469 B**（约 **697.75 MiB**），外加卸载 `node_modules/dotenv` 回收 **76,591 B**。

### 8.2 刻意保留清单与理由

| 编号 / 对象 | 保留理由 | 现状复核 |
| --- | --- | --- |
| **S1** `packages/model-adapters/src/engine-transport.ts` | 已由 D-15 复活并全面接入 `src/`（9 个生产文件、12 处调用） | 完好保留，受回归守卫保护 |
| **C2b** `packages/core-ts/src/phonation.ts` `evaluatePhonationTrackDense` | 已固化为密集连续发声态 10 维线性插值公开 API 并有单测覆盖 | 完好保留 |
| **H2** 开发态本地 ASR 链路与 `.cache/asr/`（302.95 MB） | 保留研发态按需启用能力（P-09 已默认关闭，且严禁进入 Windows 发包） | 完好保留 |
| **H3** `docs/试听/`（521.37 MB） | 仅存在于本机、不在 Git 历史中，删除不可恢复，仍为验收试听对照样本 | 完好保留 |
| **H4** `.cache/onnx-export-tools/`（85.08 MB） | 即将用于导出新模型 ONNX，保留免重复安装 | 完好保留 |
| **H6** `packages/core-ts/src/textgrid.ts` `importPtbVocalJson` | 旧版 `.ptb-vocal.json` 工程格式兼容能力，已有 3 份单测覆盖 | 完好保留 |
| **S2 / S3 / S4** `command-bus.ts`、`tool-registry.ts`、core-ts 工具函数 | Headless Core 完整架构 API，为后续撤销统一与 CLI/MCP 出口保留 | 完好保留 |
| **S6 + PY-S1 + PY-S2** `engine/model_bundle/` 上游分发模块 | 保持与上游 `TensorTract3` 只读分发集成的完整性与 `DISCLOSURE.md` 一致性 | 完好保留 |
| **S7 / S8** 参考库与预热素材再生脚本 | 保留用于离线重新生成参考库、预热资产与探索样例 | 完好保留 |
| **S10** `public/favicon.svg`（426 B） | 浏览器或外部工具按约定路径请求的轻量兜底图标 | 完好保留 |
| **排除项** `.sd`、`.stabledge/`、Python 引擎 4 个缓存测试钩子、`build/`、`src-tauri/target/`、`packages/g2p-ts/` 其余上游完整包 API | 非死代码或本地构建缓存，均按规范保留 | 完好保留 |

### 8.3 清理后全量回归验证结果

| 检查项 | 实测结果 |
| --- | --- |
| Python 引擎单测（`& 'F:/TensorTract3_Train/.venv/Scripts/python.exe' -B -m unittest discover -s engine/tests`） | **94/94 OK**（53.23 s） |
| 前端 TypeScript 类型检查（`npm run typecheck` / `vue-tsc --noEmit`） | **EXIT=0** |
| 前端与代理单元测试（`npm test` / `vitest run`，含 `tests/security-cache-proxy.test.ts` 10/10） | **39/39 文件、226/226 用例全部通过** |
| Tauri 桌面启动壳锁定编译检查（`cargo check --manifest-path src-tauri/Cargo.toml --locked`） | **EXIT=0** |
| 全仓已删符号悬挂引用检查（前后端与测试） | **0 残留命中** |
| 文档相对链接、品牌/官方命名与 `AGENTS.md` 字节预算验收 | 全部通过（0 断链、0 `file:///` 路径，`AGENTS.md` 远低于 24,000 B 上限） |
