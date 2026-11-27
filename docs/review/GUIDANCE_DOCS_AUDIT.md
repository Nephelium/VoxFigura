# VoxFigura 指导文档与 AI 代理遵循度审阅

> 审阅日期：2026-11-26 · 方式：只读，不修改任何原文档、源码或规则文件
> 执行：子代理 C（researcher，deep）初审，主代理逐项抽查、修正并定稿
> 范围：`AGENTS.md`、`CLAUDE.md`（不存在）、`docs/ARCHITECTURE.md`、`docs/CODING_STANDARDS.md`、`docs/MODEL_INTERFACE_SPEC.md`、`docs/PACKAGING_WINDOWS.md`、`docs/STYLE_EXTENSION_GUIDE.md`、`docs/specs/*`、`DISCLOSURE.md`、`THIRD_PARTY.md`、`docs/OPEN_QUESTIONS.md`、`docs/OPEN_SOURCE_REPRODUCIBILITY_GUIDE.md`、`docs/PROGRESS.md`
> 配套报告：[CODE_REVIEW_REPORT.md](./CODE_REVIEW_REPORT.md) · [DEAD_CODE_CANDIDATES.md](./DEAD_CODE_CANDIDATES.md)

## 0. 结论摘要

1. **Codex（GPT 6.2 Astra）写出的 UI 与现有元素不一致，主要原因在规则入口。** Codex 只自动注入 `AGENTS.md` 链上的文件（见 §3.1）。根 `AGENTS.md` 中与 UI 相关的规则只有 §3.5 一条：禁三个组件库、禁 Emoji、统一术语（`AGENTS.md:37`）。里面没有可复用组件清单，没有 token 引用规则，也没有新增 UI 前的检查步骤，而且没有链接任何 UI 规范：
   - `docs/specs/01-design-spec.md`、`docs/specs/02-ui-spec.md`、`docs/specs/ui-preview.html`
   - `docs/STYLE_EXTENSION_GUIDE.md`
   - `src/styles/tokens.css`、`src/styles/base.css`
   - `src/components/common/`

   `AGENTS.md:3` 只链接了 ARCHITECTURE、CODING_STANDARDS、MODEL_INTERFACE_SPEC 三份文档，这三份同样不含上述内容。`STYLE_EXTENSION_GUIDE.md` 只被 `docs/PROGRESS.md` 和 `docs/devlog/` 引用。
2. **规范与代码已经漂移，模型即使读到规范也会被误导。**
   - `02-ui-spec.md` 自相矛盾：头部写 2560×1600 基准（`:5`），§3.2 写 1920×1080（`:116`）。
   - 规范里 `--r-seg` 是 8px（`:128`），代码是 7px（`src/styles/tokens.css:96`）。字体、动效、玻璃参数、背景名称也与代码不同。
   - 规范列出的 `SegmentedControl`、`FloatingPopover`、`DataTable` 组件原语在代码中不存在。
3. **存量代码已经大量分叉，模型会就近模仿。**
   - 硬编码颜色：`<style>` 和 `.css` 中有 497 处，其中 `tokens.css` 和 `skins.css` 共 174 处属于定义。
   - 层级：直接写数字的 `z-index` 有 121 处，使用 `var(--z-*)` 的只有 1 处。
   - 原生 `<select>` 有 41 处。
   - 至少 6 套平行实现的模态框，各自写死遮罩色。
   - `src/components/common/` 里没有通用的 Button、Modal、Switch 组件。
4. **Antigravity 的规则加载机制未证实。** 官网 `antigravity.google/docs` 在主代理和子代理两侧都访问失败。第三方资料称它读取 `AGENTS.md`、`GEMINI.md` 和 `.agents/rules/`，但没有官方确认（见 §3.3）。仓库里不存在 `GEMINI.md`、`.agent/`、`.agents/`。
5. **建议：**
   - 在根 `AGENTS.md` 正文中直接写入约 40 行的“UI 一致性”节，草案见 §6.1。必须走 rule_proposal，并经井井批准。
   - 同步修订 `02-ui-spec.md`，声明 `tokens.css` 为真源。
   - 按需新增一份指针式 `GEMINI.md`。
   - 规则修改后重启 Codex 会话。
   - 另有 26 条文档与代码不一致，见 §2。

### 0.1 严重度定义

| 级别 | 含义 |
|---|---|
| 高 | 直接导致代理违规或产出不一致的实现 |
| 中 | 误导实现、验收或排障；文档事实错误 |
| 低 | 表述、命名或链接问题 |
| 信息 | 不违规，仅提示 |

## 1. 规则入口与指导文档现状

主代理用 `.cache/review-tmp/guide_check.py`（只读，已删除）实测：

| 文件 | 是否存在 | 字节 | 被 `AGENTS.md` 链接 | 说明 |
|---|---|---|---|---|
| `AGENTS.md` | 是 | 8,574 | — | 仓库唯一的代理规则文件，没有嵌套副本 |
| `AGENTS.override.md` | 否 | — | — | |
| `CLAUDE.md` / `GEMINI.md` | 否 | — | — | |
| `.agent/`、`.agents/`、`.codex/`、`.gemini/`、`.cursor/`、`.cursorrules`、`.windsurfrules`、`.github/copilot-instructions.md` | 否 | — | — | |
| `README.md` | 否 | — | — | 仓库根没有 README |
| `docs/ARCHITECTURE.md` | 是 | 7,810 | 是（`:3`） | |
| `docs/CODING_STANDARDS.md` | 是 | 5,989 | 是（`:3`） | |
| `docs/MODEL_INTERFACE_SPEC.md` | 是 | 14,347 | 是（`:3`） | |
| `docs/PACKAGING_WINDOWS.md` | 是 | 11,595 | 是（§4.6） | |
| `docs/STYLE_EXTENSION_GUIDE.md` | 是 | 4,011 | 否 | 皮肤、背景、配色三维体系说明 |
| `docs/specs/02-ui-spec.md` 等 | 是 | — | 否 | UI 视觉与组件规范 |

`AGENTS.md` §1 列出的 24 个路径全部存在。各版本的端口与命令也一致：
- 前端与预览：5173–5175、4173–4175（`vite.config.ts`）；
- 代理：3001–3003（`vite.config.ts`、`server/hackathon.mjs`、`server/friends.mjs`、`server/proxy.mjs`）；
- 引擎：8765（`server/proxy.mjs`、`engine/server.py:862`）；
- 构建产物 `dist-public/`、`dist-hackathon/`、`dist-friends/` 与 `package.json` scripts 相符；
- `package.json` 未引入 element-plus、ant-design-vue、naive-ui、vuetify、quasar、primevue。

## 2. 文档与代码不一致问题表

| # | 严重度 | 位置 | 证据 | 建议修订 |
|---|---|---|---|---|
| G-01 | 高 | `AGENTS.md:3`、`:37` | 配套文档行只有三份文档；§3.5 只有禁止项。UI 规范、`tokens.css`、`base.css`、`src/components/common/` 都没有入口 | 正文新增“UI 一致性”节（§6.1）；配套文档行加入 `docs/specs/02-ui-spec.md`、`docs/STYLE_EXTENSION_GUIDE.md`、`docs/PACKAGING_WINDOWS.md` |
| G-02 | 高 | `docs/CODING_STANDARDS.md:48-50` | §6 界面守则只有禁 Emoji、禁组件库，没有组件复用、token、硬编码颜色的规定 | 新增“界面实现”小节，与 §6.1 草案保持一致（§6.3） |
| G-03 | 中 | `docs/specs/02-ui-spec.md:116` 对比 `:5`、`AGENTS.md:38` | §3.2 写“基准分辨率为 1920×1080 全屏”；头部和 AGENTS 都写 2560×1600 | 改为 2560×1600；1920×1080 只作为 `--page-scale: 0.86` 的适配档位保留（`:135`） |
| G-04 | 中 | `docs/specs/02-ui-spec.md:128` 等 | 规范写 `--r-seg: 8px`、面板内边距 8px；代码 `tokens.css:96` 为 `--r-seg: 7px`。字体、动效时长与缓动、玻璃参数、背景中文名也不一致（子代理逐项比对，见 §4.4） | 开头声明“token 值以 `src/styles/tokens.css` 为准”，再同步表格数值 |
| G-05 | 中 | `docs/specs/02-ui-spec.md` §6.2 | 列出的 `SegmentedControl`、`FloatingPopover`、`DataTable` 在 `src/components/` 中不存在 | 标注“规划中”，并给出现行替代：`.seg`、`.vc-sel` 加 `#vcSelectMenu` 浮层、`.mini-tbl` |
| G-06 | 中 | `AGENTS.md:12` | 写“只读使用 `F:/TensorTract3_Train/.venv/Scripts/python.exe` `-B` 启动”。实际 `scripts/start-engine.mjs:10-12` 的优先级是 `VOCALCUT_PYTHON`，然后仓库 `.venv`，然后 F: 共享环境（仅 Windows），最后 `python` | 改为“`npm run engine` 依次选用 `VOCALCUT_PYTHON`、仓库 `.venv`、`F:/TensorTract3_Train/.venv`（只读）、系统 `python`，均以 `-B` 启动” |
| G-07 | 中 | `AGENTS.md:11`、`docs/ARCHITECTURE.md` | 没有列出免安装入口 `server/portable.mjs`。它的端口是 public 26751、friends 26752（`:61`），并设置 `ENGINE_PORT: '0'`（`:71`）和 `VOCALCUT_DISABLE_LOCAL_ASR: '1'`（`:73`）。另外 `card-encoding.mjs`、`studio-encoding.mjs` 以及环境变量 `TENSORTRACT_API_URL`、`ENGINE_PORT`、`HOST` 均无文档 | AGENTS §1 补一行免安装入口；ARCHITECTURE 增加环境变量表 |
| G-08 | 中 | `docs/CODING_STANDARDS.md:52` | 只要求 `npm run build` 和 `npm run build:hackathon`，漏了群友版；`docs/ARCHITECTURE.md:83` 已经写了三版 | 改为三版构建，并要求各自通过 `check-edition.mjs` |
| G-09 | 中 | `docs/PACKAGING_WINDOWS.md:85` | 上游资料仍列“Windows 内置 .NET Framework”。启动壳已改为 Tauri 2（`src-tauri/`、`scripts/portable/build.py`），`scripts/portable/Launcher.cs` 零引用（见 DEAD_CODE C6） | 换成 Tauri 2 与 WebView2 Runtime 的官方链接 |
| G-10 | 中 | `docs/MODEL_INTERFACE_SPEC.md:57-64` | 描述“下载 Whisper”、`POST /m27/asr-install`，没有说明门控。实际 `engine/server.py:48` 在开发态默认启用本地 ASR，免安装包由 `server/portable.mjs:73` 置 `VOCALCUT_DISABLE_LOCAL_ASR=1` 关闭；包内禁止装入 ASR 见 `AGENTS.md` §4.3 | 标注“仅开发态可用；免安装与安装包通过 `VOCALCUT_DISABLE_LOCAL_ASR=1` 关闭，且不含权重与依赖” |
| G-11 | 中 | `docs/MODEL_INTERFACE_SPEC.md:4`、`:91` | 适用范围只写 `server/index.mjs`，实际代理实现在 `server/proxy.mjs`。下列 10 条路由在 `engine/server.py` 中存在，规范中命中 0 次：`/vtl/live-pull`、`/vtl/synthesize-stream`、`/m27/realtime-speaker`、`/m27/realtime-step`、`/m27/extract-anim`、`/models/voice-morph`、`/models/voice-transfer`、`/models/dpdfnet`、`/models/swift-f0`、`/models/ipa-references/*` | 范围改为 `server/proxy.mjs` 加三版入口；补全路由表；注明 `/models/kf2tract` 是 `IPA2Tract-Lite` 的兼容路由名 |
| G-12 | 中 | `docs/OPEN_QUESTIONS.md:14`、`:16` | 标题和正文用“Stage 4/5”“KF2Tract27” | 改为 `Vox2Tract-Lite`、`Tract2Vox-Lite`、`IPA2Tract-Lite`、`Vox2Spk-Lite` |
| G-13 | 中 | `docs/OPEN_QUESTIONS.md:17` | 称 `/models/kf2tract` 等返回 501。`DISCLOSURE.md:36` 已说明 `IPA2Tract-Lite` 正式接入，只有 `browser-light-m27` 和 `speaker` 仍为预留 | 把 IPA2Tract 部分改为已解决，保留另外两项 |
| G-14 | 低 | `docs/OPEN_QUESTIONS.md:31-32` | `LICENSE`、`DISCLOSURE.md` 链接是本机绝对 `file:///` 路径，会暴露本机用户目录，换机即失效 | 改为相对链接 |
| G-15 | 中 | `docs/OPEN_SOURCE_REPRODUCIBILITY_GUIDE.md` 全文 | `git grep -c`：`Stage ?[45]` 40 行，`KF2Tract` 10 行 | 整体换为官方名，只在首次出现处注“旧称 Stage 4（历史）” |
| G-16 | 中 | `docs/OPEN_SOURCE_REPRODUCIBILITY_GUIDE.md:467`、`:564` | 链接 `MODEL_NAMING_SPEC.md` 和 `KF2Tract27_Frontend_and_Diacritics_Spec.md`，`git ls-files` 中都不存在 | 删除链接，或改指 `docs/CODING_STANDARDS.md` §1 |
| G-17 | 中 | `THIRD_PARTY.md:9` | 写“dotenv 用于代理”。全仓 `dotenv` 只出现在 `package.json:28`、`THIRD_PARTY.md:9` 和历史 devlog 中，没有任何 import（DEAD_CODE C5） | 移除依赖后同步删去；若保留，写明真实用途 |
| G-18 | 中 | `THIRD_PARTY.md:11`、`:28` | `:11` faster-whisper 没有标注“仅开发态、不入包”；`:28` 写“Stage 4 `m27` 反演与 Stage 5 神经重合成” | `:11` 补入包边界；`:28` 改为 `Vox2Tract-Lite` 反演与 `Tract2Vox-Lite` 神经重合成 |
| G-19 | 低 | `docs/PROGRESS.md`、`docs/工作台改版验收清单.md` | 旧称命中：PROGRESS 中 Stage 2 行、KF2Tract 2 行；验收清单中 Stage 2 行 | 改为官方名 |
| G-20 | 低 | `docs/specs/02-ui-spec.md:233` | “Stage5 神经重合成” | 改为 `Tract2Vox-Lite` 神经重合成 |
| G-21 | 低 | 品牌混用 | 面向读者的标题仍是 “VocalCut Studio”：`02-ui-spec.md:1`、`:40`，`01-design-spec.md`（10 处），`ui-preview.html`（20 处），`docs/PROGRESS.md:1`，以及文件名 `docs/specs/VocalCut_Studio_产品与技术设计方案.md`。代码中的 `@vocalcut/*` 别名、`vocalcut:*` 事件名、`VOCALCUT_*` 环境变量、`server/proxy.mjs:343` 服务名 `vocalcut-node-proxy` 都是标识符，不面向用户 | 在 ARCHITECTURE 或 AGENTS 中声明：“VocalCut 是内部代号，保留于包名、别名、事件、环境变量与服务名；文档标题与界面统一用 VoxFigura” |
| G-22 | 低 | `AGENTS.md:15` | “`public/` 存放两版共享字体”，实际是三版 | 改为“三版共享” |
| G-23 | 低 | `AGENTS.md:36` 对比 `docs/CODING_STANDARDS.md:30` | AGENTS 只列 `allowed`、`hint`；CODING_STANDARDS 还要求 `field`、`value`、`allowed{min,max,unit}` 和 HTTP 400 | AGENTS 加注“完整字段见 CODING_STANDARDS §3.3” |
| G-24 | 低 | `docs/STYLE_EXTENSION_GUIDE.md` | 只被 `docs/PROGRESS.md` 和 devlog 引用，属于孤立文档；它是皮肤扩展的唯一说明 | 从 AGENTS 配套文档行和 UI 节链接 |
| G-25 | 低 | `docs/specs/ui-preview.html` | 内含 token 副本（如 `--success`），未逐项比对 | 标注“示意稿，非真源” |
| G-26 | 信息 | `src/data/model-training-report.ts:623`、`:814`，`engine/tests/test_stage5_geometry.py`，`packages/model-adapters/src/reserved-slots.ts:5,13,41,51,64,97,170,226` | `:623` 的 `kf2tract` 是权重文件名匹配模式；`:814` 的 `-Stage4Steps` 是训练脚本参数；测试文件名属历史标识符，都在 `CODING_STANDARDS.md:16` 的豁免范围内。但 `KF2TractSlot`、`KF2TractRequest`、`fallback_stage4` 是本仓库自定的类型和状态值，不属于上游固有名 | 前两类不必改。插槽是否改名，与 DEAD_CODE H1（是否保留插槽）、CODE_REVIEW D-08 一并决策 |

说明：`02-ui-spec.md:27-28` 引用的 `03-engineering-spec.md`、`04-agent-and-compliance.md` 已标注“（待编）”，不算断链，不列为问题。

## 3. Codex 与 Antigravity 的规则加载分析

### 3.1 Codex（已按官方文档核实）

来源：https://developers.openai.com/codex/guides/agents-md（2026-11-26 抓取，已重定向至 https://learn.chatgpt.com/docs/agent-configuration/agents-md）

- **全局层**：读取 `~/.codex`（或 `CODEX_HOME`）下的 `AGENTS.override.md`；它不存在时读 `AGENTS.md`。只取第一个非空文件。
- **项目层**：从项目根（通常是 Git 根）逐级走到当前工作目录。每一级按 `AGENTS.override.md`、`AGENTS.md`、`project_doc_fallback_filenames` 的顺序查找，每级最多取一个文件。
- **合并**：从根到 cwd 依次用空行拼接，越靠近 cwd 的文件排在越后面，起覆盖作用。合并总量达到 `project_doc_max_bytes`（**默认 32 KiB**）后停止追加，空文件跳过。
- **时机**：每次运行构建一次指令链，TUI 中通常每个会话构建一次。修改规则后必须重启会话才会生效。
- **链接**：官方文档只描述按文件名发现与拼接，没有说会跟随 Markdown 链接。据此推断：`AGENTS.md` 里链接的 docs 不会自动注入，只有模型自己决定打开时才会读到。这一条是推断，见 §8。
- **自查**：`codex --ask-for-approval never "Summarize the current instructions."`；或 `codex -c log_dir=./.codex-log` 后查看 `codex-tui.log`。

### 3.2 对本仓库的影响

| 项 | 结论 | 依据 |
|---|---|---|
| 根 `AGENTS.md` 能否完整加载 | 能。8,574 B，远低于 32 KiB；加上 §6.1 约 2.5 KB 的 UI 节后约 11 KB，仍然足够 | §1 实测字节 |
| 链接文档是否会被读到 | 不保证。四份配套文档加 AGENTS 共 48,315 B，即使自动注入也会超限，何况它们本来不会被注入 | §1 字节合计 |
| UI 规则应放在哪里 | 根 `AGENTS.md` 正文，不能只放一个链接 | 同上 |
| 嵌套 `src/AGENTS.md` 是否可靠 | 不可靠。只有 cwd 位于 `src/` 或其下级时才会加载，而 Codex 通常从仓库根启动 | 官方发现规则 |
| 用户全局 `~/.codex/AGENTS*.md` 和 `config.toml` | 未核实。若全局文件很大，会挤占 32 KiB 预算 | §8 |
| 修改途径 | `AGENTS.md`、`AGENTS.override.md` 只能通过 rule_proposal 修改，需井井批准 | 宿主保护规则 |

### 3.3 Antigravity（未证实）

- 官方页面 `https://antigravity.google/docs/rules-workflows`、`/docs/rules` 在本次审阅中由主代理两次 `fetch_page` 请求均失败，子代理也失败，Google 搜索返回验证页。
- 第三方二手来源 https://www.cnblogs.com/Sereneoned/p/23746563（原文 https://sereneoned.github.io/Serene/posts/antigravity-guide-tips/）给出的说法如下：
  - Rules 可来自 `AGENTS.md`、`GEMINI.md`、`.agents/rules/*.md`，从 cwd 向上发现到 Git 根并去重；
  - 单个规则文件上限 24,000 B，全部常驻 Rules 共享约 20,000 tokens 预算，超出预算的部分只注入路径；
  - Skills 放在 `.agents/skills/<name>/SKILL.md`，Workflows 和 Hooks 另有目录。
- **以上均未经官方确认**。目录名是 `.agents/` 还是 `.agent/`，也待官方文档确认。
- 若上述说法属实，根 `AGENTS.md`（8.6 KB，小于 24 KB）已经能被 Antigravity 读取；在 AGENTS 里补上 UI 节，就能同时作用于两个工具。
- **验证方法**：在 Antigravity 中打开本仓库，询问“列出你加载的规则文件及其来源”，或在设置的 Rules 面板中查看。

### 3.4 遵循度判断

| 工具 | 能读到的规则 | 能遵循的部分 | 无法遵循的部分 |
|---|---|---|---|
| Codex | 根 `AGENTS.md`（确定） | 目录、命令、端口、单位、越界拒绝、术语、打包门槛 | UI 组件复用、token、皮肤兼容，因为入口中没有这些规则；G-06、G-07 的错误事实也会被它照搬 |
| Antigravity | 未证实；可能包括 `AGENTS.md` | 若读得到 `AGENTS.md`，同 Codex | 同 Codex；若读不到 `AGENTS.md`，则仓库里没有任何规则 |

## 4. 现有设计系统盘点

### 4.1 Token（`src/styles/tokens.css`）

- `tokens.css` 中定义了 108 个自定义属性（脚本按 `--name:` 去重计数）。`src/` 全部 `.vue`、`.css`、`.ts` 中共定义 164 个不同的自定义属性，`var()` 使用 3,622 次。
- 使用最多的 token：`--accent` 551、`--panel-border` 307、`--muted` 305、`--panel` 294、`--text` 228、`--border` 207、`--r-ctrl` 170、`--selected` 123。
- 轻新拟态几何与阴影：
  - 圆角：`--r-panel` 9px、`--r-ctrl` 6px、`--r-seg` 7px、`--r-pill` 12px；
  - 阴影：`--neu-hi`、`--neu-lo`、`--panel-shadow`、`--ctrl-shadow`、`--ctrl-inset`、`--popover-shadow`；
  - 玻璃：`--glass-blur` 7px、`--glass-backdrop`；
  - 控件底色：`--ctrl-bg`。
- 动效：`--dur-fast`、`--dur-med`、`--ease-out-expo`。层级：`--z-base` 到 `--z-modal: 90`（`tokens.css:146-149`）。
- `02-ui-spec.md` 引用的 46 个 token 在 `src/` 中全部有定义（主代理逐个 `git grep`），差异只在数值，见 §4.4。
- 运行时覆盖：`themes.ts` 的 `paletteTokens()` 覆盖调色板；`--green` 是 `--accent` 的别名，名称容易误导（子代理发现）。

### 4.2 共享 CSS 类（`src/styles/base.css`，128 条规则）

| 用途 | 类 |
|---|---|
| 按钮 | `.btn`，变体 `primary`、`active`、`success`、`danger`、`icon-only`、`sm`、`xs`。原生 `<button>` 上 `btn` 类出现 450 次 |
| 下拉 | `.vc-sel`、`.vc-sel-btn`、`.vc-sel-opt`，浮层挂在 `#vcSelectMenu` |
| 输入 | `.inp`；滑块为 `input[type=range]` |
| 分段切换 | `.seg`、`.seg.control-seg` |
| 面板 | `.panel`、`.p-head`、`.p-body`、`.p-row-top` |
| 模态 | `.export-modal-mask`、`.export-modal-card` |
| 数据展示 | `.mini-tbl`、`.metric-chip`、`.dot-ok`、`.dot-warn`、`.dot-err` |

`src/styles/workstation.css`（63 条规则）承担工作台外壳：`.app-shell`、`.work-header`、`.workspace-tabs`、`.statusbar`。

### 4.3 共享组件（`src/components/common/`，15 个文件）

| 组件 | 关键 props 或作用 |
|---|---|
| `IconSvg` | `name`、`size=15`、`strokeWidth=1.6`；全站唯一图标入口 |
| `CustomSelect` | `modelValue`、`options{value,label,badge,disabled}`、`size md/sm/xs`、`placeholder`、`disabled`、`minMenuWidth`，菜单 teleport 到 `#vcSelectMenu` |
| `CompactSlider` | `label`、`modelValue`、`min`、`max`、`step`、`unit`、`decimals`、`defaultValue` |
| `SplitPane` | `direction`、`modelValue`、`min`、`max`、`storageKey` |
| `VoiceRenderSelect`、`SpeakerReferenceSelect`、`SpeakerReferenceControls` | 声码器与发音人选择 |
| `NavArtwork` | 导航插画，随 `data-style` 切换雪碧图 |
| `TopBar`、`ToastHost`、`StartupSplash`、`TechBackdrop`、`StyleLabBackdoor`、`VocalTractViewport` | 外壳、提示、启动、背景、风格实验室、声道视口 |
| `clipboard.ts` | 剪贴板工具 |

**缺口**：没有共享的 Button、Modal、Switch/Toggle、SegmentedControl 组件，只能依赖 CSS 类约定。这正是模型最容易各写各的地方。

**皮肤**：`BUILTIN_SKINS` 有 8 种表面风格，默认 `neumorphism`（轻新拟态），另有 clay、glass、minimal、material、swiss、bauhaus、brutal；背景 6 种。`applyAppearanceToRoot` 写入 `data-theme`、`data-style`、`data-bg`。与 `DISCLOSURE.md:43` 的“八种表面风格”一致。

### 4.4 `02-ui-spec.md` 与代码的差异（子代理比对，主代理抽查了标 ✔ 的项）

| 项 | 规范 | 代码 |
|---|---|---|
| 基准分辨率 ✔ | `:116` 写 1920×1080 | `AGENTS.md:38` 和规范 `:5` 写 2560×1600 |
| `--r-seg` ✔ | 8px（`:128`） | 7px（`tokens.css:96`） |
| `--font-ui` | Segoe UI … sans-serif | 以 “VC Noto Serif SC” 打头 |
| 紧凑控件高 | 23px | 24px |
| 动效 | 100–160 ms，`cubic-bezier(0.2,0,0,1)` | 165 ms 与 210 ms，`(0.22,1,0.36,1)` |
| 玻璃 | 58% / 52%，saturate 175% | 68% / 64%，saturate 142% |
| 背景名称 | 极光网格、流光光谱等（`:17`） | 代码中的中文名已更换 |
| 组件原语 ✔ | SegmentedControl、FloatingPopover、DataTable | 不存在 |

### 4.5 偏离统计（主代理用 `.cache/review-tmp/ui_check.py` 和 `git grep` 实测，脚本已删除；“局部 `*-btn` 类”“开关写法”“回退值”三项来自子代理统计，主代理只复核了其中示例）

| 指标 | 数值 | 说明 |
|---|---|---|
| 硬编码 hex 或 rgb 字面量（`<style>` 与 `.css`） | 497 | `skins.css` 102、`tokens.css` 72 是定义；组件中最多的是 `SettingsView.vue` 68、`StartupSplash.vue` 54、`StudioStageView.vue` 33、`AlignedPianoRoll.vue` 29。子代理按匹配行计数：`.vue` 363 行，`.css` 194 行 |
| `z-index` 数字字面量 vs `var(--z-*)` | 121 : 1 | 层级 token 几乎没被使用 |
| `border-radius` 写 px vs `var(--r-*)` | 184 : 230 | |
| `font-size` 写 px vs `var(--fs-*)` | 17 : 7 | |
| 原生 `<select>`（不含 vendor） | 41 行 | 违反 `02-ui-spec.md:17` “以 `.vc-sel` 替换原生 `<select>`” |
| 原生 `<button>` | 817 个 | 大多数带 `.btn`；另有 34 个局部 `*-btn` 视觉类。`.nav-sub-btn` 在 `AboutView.vue:432` 与 `ModelReportView.vue:1389` 重复定义 |
| 平行模态 | ≥6 套 | `M27ReconstructView` 的 `.m27-modal-*`、`UpdateModal` 的 `.vc-upd-dialog`、`ModuleGuideModal` 的 `.mg-dialog`、`MixerPrepModal`、`ResearchMainView`、`ResearchTimeline`。遮罩色写死，如 `ModuleGuideModal.vue:63` `rgba(8, 12, 22, 0.56)`、`UpdateModal.vue:214` `0.54`，没有用 `var(--overlay)` |
| 开关写法 | ≥6 种 | `tool-switch`、`tf-toggle`、`ipa-reference-toggle`、`mx-acoustic-toggle`、`mx-delta-toggle`、`head3d-toggles` |
| `var(--danger, #…)` 回退值 | 不一致 | 回退值有 `#d93025`、`#e11d48`，token 是 `#b33448` |
| UI Emoji | 0 | 正则命中 9 处，均为乐理符号 ♯ ♭：`AlignedPianoRoll.vue:124`、`arranger-edit.ts:98`、`guide-modules-creative.ts:63`，属于文本，不违规 |
| 禁用组件库 | 0 | `package.json` 未引入 |

## 5. UI 不一致的根因

1. **入口缺规则**（G-01、G-02）：Codex 能确定读到的只有 `AGENTS.md`，而其中没有任何“复用什么、用哪个 token、动手前查哪里”的规定。
2. **真源不明**：token 值在 `tokens.css`、`02-ui-spec.md`、`ui-preview.html`、`STYLE_EXTENSION_GUIDE.md` 四处都有，彼此不一致（G-03 至 G-05、G-25），也没有声明以哪一处为准。
3. **缺共享组件**：没有 Button、Modal、Switch 组件，只有 CSS 类约定。模型不知道这些约定，就会新造组件。
4. **存量反例多**：模型修改某个大文件时，会模仿同文件里的硬编码颜色、局部按钮类和私有模态（§4.5）。
5. **没有可执行的自检**：现有规则没有提供检查命令，模型交付前无法自我纠偏，审阅者也难以快速发现偏离。

## 6. 规则改进草案（只给草案，不修改原文件）

> 修改 `AGENTS.md` 或新增任何代理规则文件，都必须通过 rule_proposal 提交，并由井井批准。以下内容可以直接粘贴。

### 6.1 `AGENTS.md` 新增“UI 一致性”节（建议作为 §5，放在 §4 之后）

```markdown
## 5. UI 一致性（新增或修改任何界面前必读）

1. **真源顺序**：`src/styles/tokens.css`（token 值）> `src/styles/base.css`（共享类）> `src/components/common/`（共享组件）> `docs/specs/02-ui-spec.md`、`docs/STYLE_EXTENSION_GUIDE.md`（意图与皮肤扩展）。规范与 token 冲突时以 `tokens.css` 为准，并在交付说明中指出差异。
2. **动手前先搜**：在 `src/components/common/`、`src/styles/base.css`、`src/styles/tokens.css` 中搜索已有实现，能复用就不新建。确需新建通用件时，放入 `src/components/common/` 并说明理由。
3. **必须复用**：
   - 图标：`IconSvg`，禁止内联 SVG 路径和图标字体。
   - 下拉：`CustomSelect` 或 `.vc-sel*`，禁止新增原生 `<select>`。
   - 数值滑杆用 `CompactSlider`，分栏用 `SplitPane`。
   - 按钮：`.btn` 及变体 `primary / success / danger / active / icon-only / sm / xs`。禁止新建 `*-btn` 视觉类，只允许加布局类。
   - 分段切换用 `.seg` 或 `.seg.control-seg`；输入框用 `.inp`；面板用 `.panel` + `.p-head` + `.p-body`。
   - 模态：`.export-modal-mask` + `.export-modal-card`，遮罩色用 `var(--overlay)`，层级用 `var(--z-modal)`。
4. **颜色与尺寸只用 token**：
   - 新增或修改的样式中禁止出现 `#hex`、`rgb()`、`rgba()`、`hsl()` 字面量，一律写 `var(--token)`。需要透明度时用 `color-mix(in srgb, var(--accent) 20%, transparent)`。
   - 不得新增 `var(--x, #fallback)` 形式的回退值。
   - 圆角用 `--r-panel / --r-ctrl / --r-seg / --r-pill`，阴影用 `--panel-shadow / --ctrl-shadow / --ctrl-inset`，动效用 `--dur-fast / --dur-med`，层级用 `--z-*`。
   - 禁止在组件内重定义 `--text`、`--accent` 等全局 token。
5. **皮肤兼容**：默认皮肤为 `轻新拟态`（neumorphism），另有 7 种皮肤和 6 种背景，由 `data-style` / `data-bg` 切换。新样式不得写死某一种皮肤的外观，须在默认、glass、brutal 三种皮肤以及明暗两种主题下各看一次。
6. **布局基准**：按 §3.6 的 2560×1600 设计；1920×1080 只是 `--page-scale` 的缩放档位，不能作为设计基准。
7. **无 Emoji、无第三方 UI 库**：图标只用 `IconSvg`；乐理符号 ♯ ♭ 属于文本，允许使用。
8. **交付前自检**：在仓库根执行，只检查本次改动；新增命中必须清零，或逐条说明理由。
   - `git diff -U0 -- src | Select-String '^\+' | Select-String '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\('`：查新增硬编码颜色
   - `git diff -U0 -- src | Select-String '^\+' | Select-String '<select\b|z-index:\s*\d'`：查新增原生下拉和数字层级
   - `git diff -U0 -- src | Select-String '^\+' | Select-String 'class="[^"]*-btn\b'`：查新增局部按钮类
   - `npm run typecheck`、`npm test`
9. **存量偏离不顺手大改**：硬编码颜色、原生 select、平行模态等存量问题，不在本次任务中顺手大改；触及相关文件时，只迁移被改动的区块。
```

**说明**
- 自检命令用 PowerShell 的 `Select-String`，因为本机默认 shell 是 PowerShell；如果环境里有 `rg`，可以替换。
- Emoji 自检没有写进去：码点正则会把 ♯ ♭（U+266F、U+266D）误报为 Emoji，而目前 UI Emoji 命中为 0，靠第 7 条约束即可。
- 同时建议把 `AGENTS.md:3` 的配套文档行补全为 ARCHITECTURE、CODING_STANDARDS、MODEL_INTERFACE_SPEC、PACKAGING_WINDOWS、`docs/specs/02-ui-spec.md`、`docs/STYLE_EXTENSION_GUIDE.md`。

### 6.2 Antigravity 规则入口方案

- **方案 A（推荐）**：新增一份指针文件，不复制规则内容。根目录 `GEMINI.md` 不超过 10 行，示例如下：

```markdown
# VoxFigura 代理规则入口
本仓库唯一规则真源为根目录 `AGENTS.md`。开始任何工作前完整阅读并遵守它，尤其是 §3 核心工程铁律与 §5 UI 一致性。
本文件不复述规则；如与 AGENTS.md 冲突，以 AGENTS.md 为准。
```

  如果 Antigravity 确实会读 `AGENTS.md`（§3.3 未证实），这份文件只是冗余保险，不会产生两份规则不同步的问题。
- **方案 B（官方确认不读 `AGENTS.md` 时采用）**：在 `.agents/rules/voxfigura.md` 放精简镜像，只含 §3 铁律和 §5 UI 节，控制在 24 KB 以内；目录名 `.agents` 还是 `.agent` 以官方文档为准。保持同步有两种做法，二选一：
  - 新增 `scripts/check-agent-rules.mjs`，在 `npm test` 中比对镜像段落与 `AGENTS.md` 对应段落的哈希；
  - 用脚本从 `AGENTS.md` 生成镜像，CI 中对生成结果执行 `git diff --exit-code`。
- 两种方案都属于新增规则文件，同样需走 rule_proposal 并经井井批准。
- 不建议新增 `CLAUDE.md` 或 `.cursorrules` 等其他工具的镜像；目前没有使用这些工具的证据。

### 6.3 `docs/CODING_STANDARDS.md` §6 补充（普通文档，井井审核后即可修改）

- 新增“界面实现”小节：内容与 §6.1 第 3、4、8 条相同，并注明“以 AGENTS.md §5 为准”。
- 把 `:52` 的变更验证基线改为：`npm run typecheck`、`npm test`、Python unittest，以及 `npm run build`、`npm run build:hackathon`、`npm run build:friends` 三版构建。

### 6.4 规则生效后的验证

1. 重启 Codex 会话，执行 `codex --ask-for-approval never "Summarize the current instructions."`，确认输出中出现 §5 UI 一致性。
2. 用一个小 UI 任务做 A/B 对比，例如“给设置页加一个开关”。分别在规则修改前后的会话中执行，再用 §6.1 第 8 条的自检命令统计新增的硬编码颜色和局部按钮类。
3. 在 Antigravity 中询问“列出已加载的规则文件”，确认它读到了 `AGENTS.md` 或 `GEMINI.md`。

## 7. 指导文档修订清单（按文件汇总 §2）

| 文件 | 修订项 | 对应问题 | 修改途径 |
|---|---|---|---|
| `AGENTS.md` | 新增 §5 UI 一致性；修正 `:3` 配套文档行、`:11` 免安装入口、`:12` Python 选择顺序、`:15` “三版”、`:36` 字段引用；声明 VocalCut 代号 | G-01、G-06、G-07、G-21、G-22、G-23、G-24 | rule_proposal，井井批准 |
| `docs/CODING_STANDARDS.md` | §6 增加“界面实现”；`:52` 改为三版构建 | G-02、G-08 | 普通修订 |
| `docs/specs/02-ui-spec.md` | 声明 `tokens.css` 为真源；`:116` 基准分辨率；`:128` 等数值；§6.2 原语标“规划中”；`:233` 旧名；标题品牌 | G-03、G-04、G-05、G-20、G-21 | 普通修订 |
| `docs/specs/01-design-spec.md`、`ui-preview.html` | 标题品牌；`ui-preview.html` 标注为示意稿 | G-21、G-25 | 普通修订 |
| `docs/PACKAGING_WINDOWS.md` | `:85` 去掉 .NET，改为 Tauri 2 与 WebView2 | G-09 | 普通修订 |
| `docs/MODEL_INTERFACE_SPEC.md` | `:4` 适用范围；`:57-64` ASR 门控；补 10 条路由；`:91` 注明兼容路由名 | G-10、G-11 | 普通修订 |
| `docs/ARCHITECTURE.md` | 补 `server/portable.mjs`、环境变量表与 VocalCut 代号说明 | G-07、G-21 | 普通修订 |
| `docs/OPEN_QUESTIONS.md` | `:14`、`:16` 改官方名；`:17` 关闭 IPA2Tract 部分；`:31-32` 改相对链接 | G-12、G-13、G-14 | 普通修订 |
| `docs/OPEN_SOURCE_REPRODUCIBILITY_GUIDE.md` | 全文换官方名；修复 `:467`、`:564` 断链 | G-15、G-16 | 普通修订 |
| `docs/PROGRESS.md`、`docs/工作台改版验收清单.md` | 改官方名，标题品牌 | G-19、G-21 | 普通修订 |
| `THIRD_PARTY.md` | `:9` dotenv；`:11` ASR 入包边界；`:28` 官方名 | G-17、G-18 | 普通修订，`:9` 需与删除依赖同步 |
| 新增 `GEMINI.md` | 指针文件 | §6.2 | rule_proposal，井井批准 |

代码侧建议不属于文档修订，供井井另行决策：
- 新增共享 `ModalShell` 与 `ToggleSwitch` 组件，收敛 6 套模态和 6 种开关；
- `.nav-sub-btn` 提到 `base.css`；
- 统一或去掉 `var(--danger, …)` 的回退值；
- `--green` 别名改名或加注释；
- 分批把 41 处原生 select 迁移到 `CustomSelect`。

## 8. 主代理裁决与未证实项

### 8.1 对子代理 C 初审结论的修正

| 子代理原结论 | 主代理复核 | 定稿处理 |
|---|---|---|
| ASR 应标注“默认关闭” | `engine/server.py:48` 在开发态默认启用；只有 `server/portable.mjs:73` 设置 `VOCALCUT_DISABLE_LOCAL_ASR=1` 时才关闭 | 改为“开发态可用、免安装包关闭”（G-10） |
| `OPEN_SOURCE_REPRODUCIBILITY_GUIDE.md:359` 是断链 | `:359` 是正文；断链实际在 `:467` 和 `:564` | 行号已更正（G-16） |
| `02-ui-spec.md:27-28` 引用了未编写的文档 | 原文已标注“（待编）” | 不列为问题 |
| `model-training-report.ts:623`、`:814` 使用旧名（主代理早先的线索） | 分别是权重文件名匹配模式和训练脚本参数，属于 `CODING_STANDARDS.md:16` 的豁免范围 | 降为“信息”（G-26） |
| `AGENTS.md` 链接了四份配套文档 | `:3` 只链接三份，PACKAGING_WINDOWS 在 §4.6 链接 | 已在 G-01 中更正 |
| 硬编码颜色：`.vue` 363 行 | 主代理按匹配数统计为 497（含 `.css`）；两种口径并列给出 | §4.5 |
| Emoji 自检正则只去掉 `\x{2600}-\x{26FF}` 段 | 漏检与误报都难以避免，而当前 UI Emoji 为 0 | 草案不放 Emoji 正则（§6.1 说明） |

### 8.2 未证实或待确认

1. Antigravity 的官方规则加载机制：读取哪些文件、目录名、大小与 token 预算、发现方向。目前只有第三方来源。
2. 用户本机 `~/.codex/AGENTS.md`、`AGENTS.override.md`、`config.toml` 中的 `project_doc_max_bytes` 和 fallback 设置。
3. “Codex 不跟随 Markdown 链接”：依据是官方文档没有提及，属于推断，没有明确的否定性陈述。
4. 根因结论（§5）来自规则入口分析，没有在 Codex 上实际复现，建议按 §6.4 做 A/B 验证。
5. `01-design-spec.md` 正文、`ui-preview.html` 全文未逐项比对；§4.4 中未标 ✔ 的数值差异由子代理比对，主代理未复核。
6. `tokens.css` 的 108 个属性按 `--name:` 去重计数，包含暗色主题中的重复定义；硬编码颜色统计含少量注释和数据行。

## 9. 合规声明

- 全程只读：没有修改任何原文档、源码、配置或规则文件，`AGENTS.md` 只用文件读取工具查阅。
- 没有读取 `.env.local`，没有输出任何密钥或 BYOK 请求头；本机绝对路径只描述为“本机用户目录”，没有转录。
- 没有写入 `F:\TensorTract3_Train` 或 `D:\PhoneticToolbox\PhoneticToolbox_v3`；引擎启动顺序中的 F: 路径只作为证据引用。
- 临时脚本 `.cache/review-tmp/guide_check.py`、`ui_check.py` 在定稿后删除。
- Stage 4/5、KF2Tract 等旧称只作为“被发现的问题”或代码标识符，在证据中引用。
