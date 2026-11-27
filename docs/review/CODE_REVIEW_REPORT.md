# VoxFigura 代码审阅报告（设计 · 算法 · 打包）

> 审阅日期：2026-11-26 · 审阅方式：只读静态审阅 + 主代理实测抽查 · 适用版本：`0276314`（含 8 个未提交改动）
> 来源：两路独立的子代理审阅（researcher × 2，Opus 5.5）由主代理合并去重。冲突处的严重度由主代理裁决，关键证据由主代理逐条回读源码复核，D-03 由主代理用无害载荷实测。

## 0 概要

### 0.1 范围与方法

- **范围**
  - `server/`：Node 代理、便携缓存管理、参赛版路由。
  - `src/`：工作台 store、发音卡、科研视图、Studio，以及 8 个未提交文件。
  - `packages/core-ts`、`packages/model-adapters`。
  - `engine/`：校验器、引擎租借池、韵律桥、声音混合。
  - 打包：`scripts/portable/`、`src-tauri/`、`scripts/portable/inputs.lock.json`、`docs/PACKAGING_WINDOWS.md`。
- **标尺**：`AGENTS.md` §3 工程铁律（越界即拒绝、Pa/dPa 边界、半开区间、模型命名）和 §4 打包规范，以及 `docs/MODEL_INTERFACE_SPEC.md`。
- **约束**：全程未读取 `.env.local`，未输出任何密钥或 BYOK 请求头；未写入 `F:\TensorTract3_Train` 或 `D:\PhoneticToolbox\PhoneticToolbox_v3`；未执行 build、portable 或 install。
- **以往审阅**：复核了 `docs/reviews/代码审阅报告_2026-11-25.md` 全文，以及 `docs/reviews/CODE_REVIEW_REPORT_2026-11-23.md` 的夹紧表（L566-600）和缺陷表（L744-776）。

### 0.2 基线（主代理实跑）

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | EXIT=0 |
| `npm test` | 38 个文件、211 个用例全部通过 |
| Python 引擎单测（`F:/TensorTract3_Train/.venv` `-B -m unittest discover -s engine/tests`） | 83 个用例 OK |

测试全绿并不代表下面的问题不存在。本报告的阻断项和高危项**都没有对应的单测**。

### 0.3 问题统计

| 维度 | 阻断 | 高 | 中 | 低 | 合计 |
| --- | --- | --- | --- | --- | --- |
| 1 设计（含安全、并发、接口） | 1 | 2 | 5 | 7 | 15 |
| 2 算法（含越界、单位、区间、调度） | 0 | 0 | 8 | 8 | 16 |
| 3 打包 | 0 | 0 | 4 | 7 | 11 |
| **合计** | **1** | **2** | **17** | **22** | **42** |

### 0.4 必须先处理的三项

1. **D-01【阻断】**：缓存“清理过期”可能递归删除用户自选目录下与 VoxFigura 无关的全部内容。该面板在三个版本里都会渲染，前端点一下就执行，没有二次确认。**修复前不建议再分发便携包。**
2. **D-02【高】**：开发态代理（3001/3002/3003）和引擎（8765）不校验来源。任意网页都能借跨站简单请求触发删缓存、改缓存配置、消耗知乎或 AI 额度、安装本地 ASR。
3. **D-03【高，已实测】**：`pick-dir` 把缓存路径拼进 PowerShell 脚本时，只转义了 ASCII 单引号。主代理已实测，目录名中的 U+2019 能闭合字符串并执行任意命令。

---

## 1 设计

### 1.0 设计面覆盖结论（含已核对无问题项）

| 主题 | 结论 | 证据 |
| --- | --- | --- |
| 版本隔离（public / hackathon / friends） | 三个构建入口都在构建后执行 `check-edition`，便携组包时也会再执行一次。隔离规则还有缺口，见 D-07 | `package.json:11-13`、`scripts/portable/build.py:326`、`scripts/check-edition.mjs:33-36` |
| `server/proxy.mjs` 共用 | 三个入口共用 `startProxy`。只有参赛版挂载 `contest-routes.mjs`（3002），公开版和群友版只挂载发音卡编码（3001/3003），符合 AGENTS.md §1。共用代理默认不校验来源，见 D-02 | `server/index.mjs:2-4`、`server/hackathon.mjs:1-6`、`server/friends.mjs:2-4` |
| 模型适配器层边界 | `src/` 中有 20 处直接 `fetch('/api/m27/…')` 或 `fetch('/api/vtl/…')`，绕过了 `packages/model-adapters`，见 D-15；适配器本身的问题见 D-08、D-09 | `git grep "fetch\('/api/(m27\|vtl)/" -- src` 计数为 20 |
| 命令总线 | core `CommandBus` 的 revision 与 oplog 有缺陷，store 没有接入；舌根边界与引擎不一致，见 D-06、A-01。塞音闭塞和释放的编辑校验符合刚性下限 | `command-bus.ts:62-63,426-428,907,1068` |

### D-01【阻断】缓存清理会把缓存根下所有非活动项当作“过期版本”递归删除

**证据**（主代理已回读）

- `server/portable-cache.mjs:110-122`：根目录下凡是不等于当前活动目录的项一律可删，其中子目录归类为 `stale_version`，文件归类为 `temp`。
  ```js
  if (name.startsWith('.u-') || name.endsWith('.lock')) return 'temp';
  if (isDir) return 'stale_version';
  return 'temp';
  ```
- `server/portable-cache.mjs:199-211`：`validateCacheRootPath` 只拒绝相对路径和磁盘根目录，任何已有的非空文件夹都能通过。`src-tauri/src/main.rs:163` 同样只要求 `is_absolute() && parent().is_some()`。
- `server/portable-cache.mjs:138-140`：`collectCacheStatus` 扫描 activeRoot、configuredRoot、defaultRoot 三个根，新配置的根无需重启即被扫描。
- `server/portable-cache.mjs:312-330`：mode 默认是 `expired`，对全部非活动项执行 `rm(entry.path, { recursive: true, force: true })`。
- `src/components/settings/PortableCachePanel.vue:127-153`：`cleanCache` 直接 POST，没有二次确认，也没有列出将被删除的条目。
- `src/views/SettingsView.vue:1220`：`<PortableCachePanel />` 没有 `__APP_PORTABLE__` 门控，三个版本都会渲染。

**影响**

- **情形一**：用户把缓存位置设为已有目录（如 `D:\Data` 或桌面），再点“清理过期缓存”，该目录下所有子文件夹和文件都会被永久删除。
- **情形二**：开发态没有 `VOCALCUT_PORTABLE_ACTIVE`，所以没有任何条目受保护，`%LOCALAPPDATA%\VoxFigura\Portable` 下正在运行的便携实例目录也会被删。
- **情形三**：公开版与群友版的便携实例可以同时运行，另一个版本的运行目录会被当作 `stale_version` 删除。
- **组合**：叠加 D-02 后，这条删除链路可以被任意网页远程触发。

**修复建议**

1. 分类改成白名单。只有满足以下条件的项才可清理，其余一律标为 `foreign`，不计入可清理大小，也不可删除：
   - 目录名匹配 `^(public|hackathon|friends)-[0-9a-f]{8,}$`，且目录内有 `bundle-manifest.json`；
   - 或名称匹配 `.u-*`、`*.incomplete-*`、`<已知版本目录>.lock`。
2. 自定义缓存根强制使用专属子目录（如 `<所选>\VoxFigura-Cache`），或者要求目录为空、或带有 `.voxfigura-cache-root` 标记文件。Rust 侧的 `resolve_cache_root` 做同样的约束。
3. 删除前检测 `.lock` 是否被持有，以避开正在运行的实例。
4. 前端增加二次确认，列出具体条目和大小；非便携运行时隐藏面板，服务端对 `/api/portable/cache/*` 返回 404。
5. 补单测：在缓存根里放一个无关目录和一个无关文件，清理后断言两者都还在。

### D-02【高】开发态代理与引擎不校验来源，可被跨站请求利用（CSRF / DNS rebinding）

**证据**（主代理已回读）

- `server/proxy.mjs:333-341`：只有传入 `expectedOrigin`（便携模式）时，才校验 Host、Origin 和 `Sec-Fetch-Site`。
- `server/proxy.mjs:359-362`：`startProxy`（`npm run server*`）不传 `expectedOrigin`，而且可以用 `HOST` 环境变量改为 `0.0.0.0`。
  ```js
  const host = process.env.HOST || '127.0.0.1';
  createProxyServer(extension).listen(port, host, () => {
  ```
- `server/portable-cache.mjs:17-28`：`readJsonBody` 不检查 Content-Type。`text/plain` 的“简单请求”无需预检，也会被当作 JSON 解析。
- `engine/server.py:127-131`：只有设置了 `VOCALCUT_ENGINE_TOKEN` 才校验令牌，而 `npm run engine` 开发态不会设置它。
  ```python
  token = os.environ.get("VOCALCUT_ENGINE_TOKEN")
  if token and not compare_digest(token.encode(), supplied.encode()):
  ```
- `engine/server.py:146-158`：CORS 只限制跨域读取响应，拦不住跨站 POST 产生的副作用（旧 B-18 只修了一半）。

**影响**：开发者开着 `npm run server` 或 `npm run engine` 浏览网页时，任何站点都可以：

- POST `/api/portable/cache/location` 和 `/clean`，删除本地缓存，叠加 D-01 后可删任意目录；
- 调用 `/api/ai/chat`，消耗服务端配置的 AI 额度；
- 调用参赛版 `/api/zhihu/*`，消耗环境变量中的知乎凭据额度（`server/contest-routes.mjs:77-84`）；
- 调用 `/api/vtl/*` 和 `/api/m27/*`，造成算力型拒绝服务；
- 直接 POST `127.0.0.1:8765/m27/asr-install`，触发 pip 安装和大体积模型下载（开发态 `LOCAL_ASR_ENABLED` 默认为真，见 P-09）。

由于不校验 Host，DNS rebinding 还可以绕过只看 Origin 的校验。仓库里已有同类防护的先例：`server/contest-routes.mjs` 的 `canReuseLocalZhihu`（L9-20）做了回环地址加 Origin 校验。

**修复建议**

1. `startProxy` 默认启用 Host 白名单（`127.0.0.1:<port>`、`localhost:<port>`）。
2. 对 `/api/*` 的非 GET 请求：
   - 拒绝 `Sec-Fetch-Site: cross-site`；
   - Origin 只允许对应的 Vite 开发端口和预览端口（5173-5175、4173-4175）；
   - 强制 `Content-Type: application/json`，并要求自定义头 `X-VoxFigura-Client`，迫使跨域请求走预检。
3. `scripts/start-engine.mjs` 为开发态引擎生成随机令牌，由代理注入请求头。

### D-03【高｜已实测】`pick-dir` 拼接 PowerShell 脚本，Unicode 弯引号可以闭合字符串并执行命令

**证据**

- `server/portable-cache.mjs:222,228,234`：
  ```js
  const safeInitial = (initialDir || '').replace(/'/g, "''");
  safeInitial ? `if (Test-Path -LiteralPath '${safeInitial}') { $dlg.SelectedPath = '${safeInitial}' }` : '',
  execFile(psExe, ['-NoProfile', '-STA', '-Command', psScript], ...
  ```
- `initialDir` 来自 `cfg.cacheRoot`，可以通过 `/api/portable/cache/location` 写入（L269-274）。写入条件只有两条：是绝对路径，且 `mkdir` 成功。
- **主代理实测**（Windows PowerShell 5.1，探针按 L222-228 原样转义并拼接，用 `psobject` 代替对话框，执行后已删除）：

  | 载荷（目录名） | 结果 |
  | --- | --- |
  | `C:\x’+$(Write-Host 424242)+’` | stdout 输出 `424242`，随后是 `DONE`。注入的命令已执行，脚本也没有因语法错误中止 |

  该载荷不含 Windows 文件名的非法字符 `<>:"|?*`，所以 `mkdir` 能建出这个目录，`/location` 的校验也能通过。PowerShell 把 U+2018 至 U+201B 都当作单引号定界符。

**影响**：攻击链为“网页跨站 POST `/location` 写入恶意目录名（D-02）→ 用户或网页触发 `/pick-dir`”，结果是以当前用户权限执行任意命令。便携模式下有 Origin 校验，难以被远程触发，但开发态会暴露。

**修复建议**

- 不要把数据拼进脚本，改为通过环境变量传值：`execFile(..., { env: { ...process.env, VF_INIT: initialDir } })`，脚本内使用 `-LiteralPath $env:VF_INIT`。
- 退而求其次，至少把 `['\u2018-\u201B]` 全部双写转义。
- 补单测：用包含 U+2019 的路径构造脚本，断言注入的命令不会执行。

### D-04【中】更新清单回落到裸 IP 明文 HTTP，且没有签名

- **证据**：`server/proxy.mjs:15-18`
  ```js
  'https://www.phonetictoolbox.com/voxfigura/updates/latest.json',
  'http://8.134.196.183/voxfigura/updates/latest.json',
  ```
  `handleUpdateCheck` 在 L300-302 依次尝试这两个地址。
- **影响**：HTTPS 失败后会走明文 HTTP，中间人可以伪造版本号、公告文本或下载链接。前端如何使用清单中的链接**待确认**：在 `src/` 中 grep `download_url|downloadUrl` 没有命中，需要再核对 `src/App.vue` 启动更新检查的展示逻辑。
- **建议**：去掉 HTTP 回落，或对清单做 Ed25519 签名并在代理侧验签；下载链接限定为 HTTPS 和白名单域名。

### D-05【中】`_run_chunk` 修改共享 VTL 引擎状态后不恢复

- **证据**：`engine/dense_channel.py:1466-1469`（主代理已回读）
  ```python
  with lock:
      if is_3d and target_sc is not None and eng.section_count != target_sc:
          eng.set_section_count(target_sc)
      eng.configure_perturbation({"jitter": 0.0, "shimmer": cur_shim, "flutter": flutter, "seed": seed}, restart=True)
  ```
- **影响**：并行分块合成时，worker（可能就是 primary 引擎）的 `section_count` 和扰动配置被改写后不复位。`lease()` 在 L516-541 的 finally 里会复位（旧 B-01 已修），所以之后经由 `lease` 的请求能自愈。但经由 `get_engine` 直接读取的路径（L912、L1005、L1604、L2161）可能读到被改过的 `section_count`，扰动种子也可能遗留给下一个直接调用者。
- **建议**：`_run_chunk` 用 try/finally 保存并恢复 `section_count` 和扰动参数，或统一经由 `lease()` 获取 worker。

### D-06【中】两套撤销体系并存；全量 JSON 快照占用内存；revision 回退后被复用

- **证据**
  - `src/stores/workbench.ts:1016-1046`：每次编辑都 `JSON.stringify(project.value)`，最多保留 100 份，快照还持有 `editedAnnotationAudio` 等 AudioBuffer 引用。`restoreSnapshot` 会连同 `project.revision` 一起回滚。
  - `packages/core-ts/src/command-bus.ts:907-909`：`oplog: UndoEntry[]` 没有上限，`maxHistory=200` 只限制撤销栈。`command-bus.ts:1068` 用 `preview.base_revision !== this.project.revision` 做乐观校验。
  - 在 `src/` 中 grep `CommandBus`、`applySemanticCommand` 没有命中：store 没有使用 core 的命令总线。
- **影响**
  - **内存**：大工程（大量关键帧或内嵌标注）的撤销历史可达数百 MB，每次捕获快照都会卡顿。
  - **ABA 问题**：撤销会把 revision 还原成旧值，之后的新编辑又会复用同一个编号。基于旧 revision 生成的 AI 提案（ProposalPreview）因此仍能通过校验，被重放到另一个状态上。
  - **维护**：两套历史语义并存，维护成本高。
- **建议**
  1. revision 改为单调递增，撤销和重做也递增，另用 `state_hash` 或 `generation` 做校验。
  2. oplog 改用环形缓冲，或与 `maxHistory` 同步截断。
  3. 快照里只保存资产 id，不保存 AudioBuffer。
  4. 中期让 store 接入 `CommandBus`，配合 JSON Patch 逆操作。

### D-07【中】版本隔离检查只覆盖一部分

- **证据**：`scripts/check-edition.mjs:33-36`（公开版和群友版共用这段分支）
  ```js
  if (name.startsWith('assets/kanshan/') || explorationBundle.test(name)) problems.push(name);
  if (/\/api\/(?:zhihu\/|explore\/repo-)|\/assets\/kanshan\//.test(content)) problems.push(name);
  ```
- **问题**
  - 没有检查 `X-Zhihu-BYOK-Secret`、`zhihu-keyword` 等知乎凭据相关字符串。
  - 服务端隔离（便携包不含 `contest-routes.mjs`、`repo-knowledge.mjs`、`zhihu-cli.mjs`）只靠 `scripts/portable/build.py:190-191` 的文件允许清单隐式保证，`check-edition.mjs` 和 `verify.py` 都没有显式断言。
  - 群友版有意引用 `hackathon/branded-card`（`src/editions/friends.ts:3`、`vite.config.ts:39`），这属于设计意图，但没有在任何地方登记“允许的赛事模块白名单”。
- **影响**：知乎凭据处理代码或参赛版服务端一旦被误打进公开版或群友版，构建不会失败，违反了 AGENTS.md §1 中“公开入口独立于赛事目录”的约束。
- **建议**：check-edition 增加凭据字符串检查和群友版白名单断言；`verify.py` 断言上述三个参赛版服务端文件不在包内。

### D-08【低】`reserved-slots.ts` 把引擎 4xx 吞成“回退成功”，并沿用禁用旧称

- **证据**：`packages/model-adapters/src/reserved-slots.ts:129-143`（主代理已回读）
  ```ts
  if (res.ok) { ... return ok({ status: 'neural_kf2tract', ...data }); }
  } catch { // Fall back to deterministic physical baseline }
  return ok({ status: 'fallback_physical', ...
  ```
  另外，L170-172 有 `fallback_stage4` 和 `stage4_result`，L5、L13、L64、L218-228 的注释仍写着 `KF2TractSlot`。
- **问题**
  - `engine/server.py:603-612` 对越界输入返回 400，但适配器在 `res.ok=false` 时直接回退并返回 ok，等于把“越界即拒绝”改写成了“回退成功”。
  - 适配器只校验了 `cond_111[0]` 的维度，也没有超时或 AbortSignal。
  - 旧称违反 AGENTS.md §3.7。
  - 浏览器 ONNX 分支实际不可达。
  - 在 `src/` 中 grep 没有引用，属于休眠代码，因此定为低。
- **影响**：目前没有调用方，实际影响为零。一旦接入，越界输入会被改写成“物理规则回退成功”，调用方得不到 `out_of_range`。旧称还会被 AI 代理照抄进新代码。
- **建议**：4xx 透传为 `fail(error)`，只有网络错误或 503 时才回退；类名改为 `IPA2Tract-Lite` 相关名称，`fallback_stage4` 改为 `fallback_vox2tract_lite`（旧字段可保留为 deprecated 别名）。如确认无用，可按死代码清单处理。

### D-09【低】代理转发超时与适配器超时不一致

- **证据**：`server/proxy.mjs:13` 定义 `ENGINE_TIMEOUT_MS = 120_000`；`packages/model-adapters/src/m27-adapter.ts:225` 中 reconstruct 允许 180 s。
- **影响**：耗时在 120 到 180 s 之间的长时间声道重建会先被代理切断，前端看到的是通用失败，而不是适配器自己的超时提示。
- **建议**：代理按路由设置超时（`/api/m27/reconstruct` 不短于 180 s）。

### D-10【低】按说话人串行的引擎锁获取没有超时

- **证据**：`engine/dense_channel.py` 的 `lease`（L516-541）和 `_run_chunk`（L1466）都用 `with lock:` 阻塞获取。
- **影响**：一个长任务会让同一说话人的后续请求一直排队，直到被 `server.py:137` 的 120 s socket 超时断开，期间没有明确的“引擎忙”错误。
- **建议**：使用 `lock.acquire(timeout=…)`，失败时返回 `{ ok:false, error:{ code:'engine_busy' } }`。

### D-11【低】校验器的小缺口

- **证据**：`engine/validation.py:194` 的 `len(row) not in (7, 8)` 接受 7 维声门控制，而 AGENTS.md 写的是“声门 8 维”。超大 JSON 整数在 `float()` 时会抛 `OverflowError`，落到通用 500，不会走 `out_of_range`。
- **影响**：如果调用方误传了 7 维声门，请求不会被拒绝，缺失的那一维会按隐式语义处理。异常数值会得到 500，而不是带 `allowed` 和 `hint` 的可解释错误。
- **建议**：明确 7 维的兼容语义（补默认值并在 MODEL_INTERFACE_SPEC 登记），或只接受 8 维；数值转换时捕获 `OverflowError`，返回 `out_of_range`。

### D-12【低】`artic.set_pose` 静默忽略非法键或值，`delta` 被当作绝对值

- **证据**：`src/stores/workbench.ts:1064-1096`（`applySingleCommandToState`）
  - 未知键和 NaN 直接 `continue`，最终仍返回 ok；
  - 19 元 `params` 数组变成无操作，同样返回 ok；
  - `delta` 被当作绝对值写入，与 core 中“相对增量”的语义不一致。
- **影响**：AI 提案或脚本命令写错键名时，用户看到的是“已应用”，但工程并未改变。`delta` 命令会把增量当作绝对姿态写入，导致声道参数跳变。
- **建议**：收集非法字段，返回 `validation_error`；`delta` 语义与 core 对齐。

### D-13【低】参赛版推荐接口的 `count` 未取整，也未处理 NaN

- **证据**：`server/contest-routes.mjs:264` 写的是 `Math.min(20, Math.max(1, Number(... || 10)))`；同文件 L145 的搜索接口则用了 `Math.trunc(...) || 10`。
- **影响**：`count=abc` 会得到 NaN，`count=1.5` 会原样拼进上游参数，并在 L269 的缓存里留下无效键。
- **建议**：与 L145 保持一致。

### D-14【低】Studio 拖拽未处理 `pointercancel`（未提交文件）

- **证据**：`src/components/studio/StudioStageView.vue:623-632`、`661-671`、`2308-2313` 只注册了 `pointermove` 和 `pointerup`；同一文件的 L2110-2128、L2173-2187 已经处理了 `pointercancel`。
- **影响**：触控或笔输入被系统取消，或者切换窗口导致收不到 `pointerup` 时，window 监听器会残留，角色会继续跟随鼠标移动。
- **建议**：对元素调用 `setPointerCapture`，并统一监听 `pointerup` 和 `pointercancel`。

### D-15【中】前端多处直接调用引擎接口，绕过模型适配器层

- **证据**：在 `src/` 中 grep `fetch('/api/(m27|vtl)/`，共 20 处命中，例如：
  - `src/components/research/ContinuumView.vue:655,872`
  - `src/components/research/LiveHead3DStage.vue:413`
  - `src/components/research/m27-realtime.ts:284,305`
  - `src/components/phonetic-card/card/real-module-assets.ts:427`

  作为对照，`packages/model-adapters/src/engine-transport.ts` L22-47 已统一解析 `out_of_range`，透传 `allowed` 和 `value`，并支持取消（旧 B-22 修复）。
- **影响**：这 20 处各自处理错误、超时和取消，越界错误的 `allowed` 和 `hint` 容易被丢弃，与 AGENTS.md §1“标准化模型适配器层”的分层意图不一致。接口一旦变更，需要逐处修改。
- **建议**：为 `vtl/batch-contours`、`vtl/synthesize`、`vtl/pose`、`m27/realtime-*` 提供适配器方法，前端统一经由适配器调用；在 lint 或 grep 测试中禁止 `src/` 直接 `fetch('/api/(m27|vtl)/`。

---

## 2 算法

### 2.0 算法面覆盖结论

| 主题 | 结论 | 对应条目 |
| --- | --- | --- |
| 48 kHz 整数采样 | core 时间统一经过 `msToSamples`/`samplesToMs` 换算。调度和 qTA 默认 `step_smp=240`（5 ms），`evalF0` 要求 `step_smp` 和 `total_smp` 为整数，否则拒绝。实时路径的 48 kHz 到 16 kHz 重采样有问题 | `qta.ts:422-428`、`scheduler.ts:436,495`；A-05 |
| 半开区间 `[start_smp, end_smp)` | 调度器归属判断和 qTA 主循环采用半开区间；Pin 和导出处有闭区间写法；调度冲突路径会产生重叠区间 | `scheduler.ts:865`、`qta.ts:564`；A-10、A-13 |
| 越界即拒绝（`out_of_range`） | core 的调度器和 qTA 均合规；前端 5 处静默夹紧；调度器不校验输入的塞音刚性下限 | 2.x 表；A-03、A-04、A-06、A-07、A-08、A-14 |
| Pa 与 dPa 换算位置 | 只有 1 处违规，在前端 `voice-mixer.ts`；其余换算都在 `engine/` 内 | A-02、2.x 表下说明 |
| qTA | 公式和状态传递正确；变调速率提示有缺陷 | 2.y、A-15 |
| 抢拍调度 | 休止符时值被丢弃（已实测）；冲突路径会产生重叠音段（已实测）；其余预算与压缩逻辑正确 | 2.y、A-12、A-13、A-14 |
| 6 档发声态直连插值 | 在 10 维空间直接线性插值，实现正确；两套采样语义不一致，嘘裂声锚点的 F0 低于 60 Hz | 2.y、A-16 |

### A-01【中】core-ts 中舌根 TRX/TRY 的边界与引擎和 UI 不一致

- **证据**（主代理已回读）
  - `packages/core-ts/src/command-bus.ts:62-63` 定义 `TRX: [-4.0, 4.0]`、`TRY: [-4.0, 4.0]`。
  - `engine/validation.py:59-64` 中 `TRACT19_JD2_MIN`/`MAX` 的第 15、16 维为 TRX `[-4, 2]`、TRY `[-6, 0]`。
  - `src/stores/workbench.ts:294-295` 定义 TRX `min:-4, max:2`、TRY `min:-6, max:0`，与引擎一致。
- **影响**
  - core 会接受 TRX ∈ (2, 4]、TRY ∈ (0, 4]，这些值随后被引擎以 `out_of_range` 拒绝，错误要到合成阶段才暴露。
  - core 反过来会拒绝合法的 TRY ∈ [-6, -4)。
  - delta 的跨度计算（L250、L387-392）因此偏差。
- **建议**：把 core 改为 TRX `[-4, 2]`、TRY `[-6, 0]`，并加一条跨语言一致性测试，断言 `TRACT_PARAM_LIMITS` 与 `engine/validation.py` 的 MIN/MAX 逐维相等。更好的做法是从 `schema/` 生成一份共享常量。

### A-02【中】前端做 dPa→Pa 换算，越过了“只在 engine 和原生边界换算”的规定

- **证据**（主代理已回读）
  - `src/components/research/voice-mixer.ts:155-157`
    ```ts
    const [prDpa, xb, xt, ca, lag, ra, ps, fl, shim] = source9;
    { key: 'PR', label: '肺下压', value: String(Math.round(prDpa / 10)), unit: 'Pa' },
    ```
  - `engine/voice_morph_bridge.py:119-121` 把预设的 `source9_phys` 原样对外暴露，其中第 0 维 PR 的单位是 dPa（例如 8200）。`voice-mixer.ts` L82-131 中 TS 默认值也按 dPa 硬编码。
- **影响**：违反 AGENTS.md §3.3。`source9_phys` 没有单位后缀，前端其他调用方很容易把 8200 当作 Pa，从而超出 0..1600 的范围。旧 B-21 已修过同类问题，这是新出现的违规。在 `src/` 和 `packages/` 中没有找到其他 `*10` 或 `/10` 换算，其余命中只是注释和取整。
- **建议**：在 `voice_morph_bridge.py` 出口把 PR 转为 Pa，字段改名（例如拆成带 `_pa`、`_cm` 后缀的命名字段）；TS 默认值同步改为 Pa，删除前端的 `/10`。

### A-03【中】发音卡回放对模型输出的 PR 静默夹紧，F0 门槛与 60 Hz 下限不一致

- **证据**：`src/components/phonetic-card/card/playback-sources.ts:154-155`（主代理已回读）
  ```ts
  f0_hz: Number.isFinite(row[17]) && row[17] > 20 ? row[17] : fallbackGlottis.f0_hz,
  pr_pa: Number.isFinite(row[18]) ? Math.max(0, Math.min(1600, row[18])) : fallbackGlottis.pr_pa,
  ```
- **影响**
  - 违反 AGENTS.md §3.4。模型输出的 PR 越界时被悄悄截断后直接用于合成，用户和测试都看不到模型异常。
  - F0 门槛是 20 Hz，20 到 60 Hz 的值会被送到后端，再被后端拒绝，前端得到的是合成失败，而不是可解释的回退。
- **建议**：越界时返回 `out_of_range`（带 `allowed` 和 `hint`），由调用方决定是否回退到 `fallbackGlottis` 并提示用户；F0 门槛改用 `F0_LIMIT_HZ.min`。

### A-04【中】日语声调路径静默替换和夹紧 F0

- **证据**：`src/data/prosody-model.ts:460,479`（主代理已回读）
  ```ts
  const safeBaseF0 = Number.isFinite(baseF0) && baseF0 >= F0_LIMIT_HZ.min && baseF0 <= F0_LIMIT_HZ.max ? baseF0 : 165;
  const f0Hz = Math.round(Math.max(F0_LIMIT_HZ.min, Math.min(F0_LIMIT_HZ.max, rawHz)) * 10) / 10;
  ```
  作为对照，同一文件中 Text2Prosody-Lite 的路径（L115-116）在越界时直接 `throw`，两条路径策略不一致。
- **影响**：基准 F0 越界时被静默改为 165 Hz；音拍音高越界时被夹紧，声调轮廓的形状被削平，但界面显示“成功”。
- **建议**：越界时返回 `{ ok:false, error:{ code:'out_of_range', allowed:[60,600], hint } }`，提示用户调低基准或减小音域。`baseF0` 是否直接来自 UI 输入**待确认**。

### A-05【中】实时声道重建的重采样几乎没有抗混叠，且与离线路径不一致（未提交文件）

- **证据**：`src/components/research/m27-realtime.ts:508-529`
  ```ts
  const avgRadius = ratio >= 2.5 ? Math.floor(ratio * 0.5) : 0;
  for (let j = lo; j <= hi; j++) { sum += input[j]; cnt++; }
  out.push(input[i0] * (1 - frac) + input[i1] * frac);
  ```
  离线路径 `src/components/research/M27ReconstructView.vue:1022-1023` 用 `new AudioContext({ sampleRate: 16000 })` 加 `decodeAudioData`，由浏览器重采样，自带抗混叠。
- **分析**
  - 48 kHz 降到 16 kHz 时，ratio=3、半径为 1，相当于 3 点盒式滤波。它在 8 kHz 处的响应 H = (1 + 2cos60°)/3 ≈ 0.667（−3.5 dB），8 到 16 kHz 的能量几乎全部折叠进 0 到 8 kHz。
  - 输入为 24 kHz 或 32 kHz 时（ratio < 2.5），只做线性插值，完全没有低通。
  - 窗口在块边界被截断，引入轻微的块周期误差。
- **影响**：同一说话人走实时与离线两条路径时，送进 Vox2Tract-Lite 的特征分布不同，擦音（如 /s/、/ɕ/ 在 4 到 12 kHz 的能量）受影响最大。对精度的实际影响**待确认**，需要 A/B 对比。
- **建议**：在 AudioWorklet 中实现带跨块状态的多相 FIR 低通（截止约 7.2 kHz，31 到 63 taps），或直接以 16 kHz 的 AudioContext 采集。再用同一段录音分别走实时和离线路径，比较 19 维轨迹，作为回归测试。

### A-06【低】预设移调后的 F0 被硬夹到 60..600

- **证据**：`src/components/phonetic-card/card/playback-sources.ts:813`
  ```ts
  const shiftedF0 = Math.max(60, Math.min(600, glottis.f0_hz * Math.pow(2, f0Shift / 12)));
  ```
  夹紧后的值直接送入 `store.synthesizeRange`（L814-819）。
- **影响**：内置预设一般不会越界，但这属于字面违规，而且写的是魔法数，而不是 `F0_LIMIT_HZ`。
- **建议**：越界时拒绝并提示，或用断言暴露预设数据错误。

### A-07【低】关键帧弹窗打开时夹紧 F0 和时长，用户只要保存就会静默改写数据

- **证据**：`src/components/research/KeyframePopover.vue:90,93`
  ```ts
  durationMs.value = Math.max(15, Math.round(samplesToMs(seg.end_smp - seg.start_smp)));
  f0TargetHz.value = Math.round(Math.max(F0_LIMIT_HZ.min, Math.min(F0_LIMIT_HZ.max, hz)));
  ```
- **影响**：导入的越界目标（例如从 TextGrid 或旧工程换算出的低于 60 Hz 的值），在用户“打开并保存”后被改成边界值，时长也被抬到 15 ms。
- **建议**：表单显示原值并标红，提交时由校验器拒绝，不在初始化时夹紧。

### A-08【低】连续统 F0 静默替换仍未修复（旧 C14）

- **证据**：`src/components/research/ContinuumView.vue:844-845`
  ```ts
  const pitchA = left && left[17] >= 60 ? left[17] : leftEndpoint.f0Hz;
  ```
- **影响**：源控制轨中低于 60 Hz 的帧被替换为端点 F0，替换对用户不可见，研究结果可能被误读。
- **建议**：在 manifest 中记录替换的帧数和原因，或显式拒绝并提示用户修正源控制轨。

### A-09【低】Text2Prosody-Lite 引擎桥的 F0 下限可配到 40 Hz，上限静默截断到 600

- **证据**：`engine/prosody_bridge.py:45` 为 `_num_opt("f0_min_hz", 60.0, 40.0, 120.0)`；L74-79 把低于下限的值抬到 `f0_min_hz`，把高于 600 的值截到 600。
- **影响**：接口会返回 `f0_adjusted_count`，所以旧 B-04 算已缓解。但 `f0_min_hz` 取 40 到 60 时，产出的低于 60 Hz 的结点会被前端 `prosody-model.ts:115` 拒绝。
- **建议**：可配下限改为 60；在 MODEL_INTERFACE_SPEC 中登记“模型输出后处理调整”的语义。

### A-10【低】半开区间约定有几处用了闭区间写法

- **证据**
  - `packages/core-ts/src/qta.ts:605` 用 `tSmp >= pin.start_smp && tSmp <= pin.end_smp`，同类写法还有 `qta.ts:285`（拟合窗口包含 `end_smp`）。
  - `src/components/modals/ExportModal.vue:233`（未提交）用 `t >= clip.start_smp && t <= clip.end_smp` 筛选 PitchTier 导出点。
- **影响**
  - qta 出口的交叉淡化在 u=0 时 w=0，所以数值上等价，只是约定不一致。
  - PitchTier 的 `xmax` 在 Praat 中本来就是闭端，导出写法可能是有意的，**待确认**。
- **建议**：qta 改为 `tSmp < pin.end_smp`；导出处如果是有意为之，加注释说明。另外，`interpolatePinAt` 每帧都对每个 Pin 的点集复制并排序一次（`qta.ts:351`），复杂度为 O(F·P·n log n)，建议在进入主循环前一次性排好。

### A-11【低】其他数值细节

以下三处影响范围小，合并为一条。证据、影响和建议分列在各子项中。

- **证据** `engine/dense_channel.py:801-802`：`rel_amp<=0` 时把 F0 写成 125 Hz。**影响**：这只发生在清音帧，听感无差，但属于静默替换。**建议**：在接口文档中注明。L803 的 `np.clip(g, gmin, gmax)` 是前置校验之后的安全兜底，合理。
- **证据** `src/components/studio/midi-score.ts:147-148`（未提交）：遇到未配对的 noteOff 直接抛错。**影响**：部分 DAW 导出的文件带有冗余 noteOff，整个文件会导入失败。**建议**：改为忽略并计入警告。其余已核对无误：tempo map 按 tick 累积、`sample()` 取整、导出时同 tick 的 noteOff 优先、`conflictsWithNote` 的半开判断。
- **证据** `src/components/research/m27-realtime.ts:174`（未提交）：字节数为奇数时，`base64ToFloat32Int16` 的 `new Int16Array(bytes.buffer)` 会抛 RangeError。同文件 L431-440 中，`getUserMedia` 之后如果 `AudioContext` 构造失败，MediaStream 不会被停止。**影响**：实时会话异常中断，麦克风指示灯常亮。**建议**：先检查字节长度；在 `finally` 中停止音轨。

### A-12【中｜已实测】抢拍调度丢弃简谱休止符，后续音节提前

- **证据**
  - `packages/core-ts/src/scheduler.ts:162`：`parseNumberedScore` 把休止符解析为 `{ midi: null, beats: 1 }`，并计入 `totalBeats`。
  - `scheduler.ts:446-457`：`schedule` 映射乐谱时用 `if (n.midi === null) continue;` 跳过休止符，其拍数既没有累加到下一拍子的起点，也没有产生空位。
  - `scheduler.ts:494-501`：拍点只由音节自己的 `beats` 累加得到。
  - **主代理实测**（临时 `vite-node` 探针，`bpm=60`，两个单元音音节，执行后已删除）：

    | 简谱 | 解析出的音符 | 两个音节的 `beat_smp` |
    | --- | --- | --- |
    | `12` | `[48,1] [50,1]` | 4800, 52800 |
    | `102` | `[48,1] [null,1] [50,1]` | **4800, 52800**（预期第 2 个为 100800） |
- **影响**：带休止符的乐谱中，休止符之后的所有音节都会提前，提前量等于休止时值，与伴奏或节拍器错位。传入 `score` 的调用方有 `src/data/guide-demo-runner.ts:1205-1207`。`arranger-compile.ts:150` 不传 `score`，不受影响。`tests/core.test.ts` 中没有休止符的调度用例。
- **建议**：遍历音符时把休止时值累计为下一音节的 `rest_before_beats`，并计入 `accBeats`；前一音节的 qTA 区间标记 `is_rest_after`；补充 `102` 与 `12` 的拍点回归测试。

### A-13【中｜已实测】元音晚到的冲突路径会产生重叠音段，破坏半开区间的连续性

- **证据**
  - `scheduler.ts:628-637`：`allow_vowel_delay_on_conflict=true` 时，韵尾和下一字头都取最小时长。
  - `scheduler.ts:642`：下一音节从 `max(tNucI + holdMin, …)` 开始。
  - `scheduler.ts:697`：核心元音至少保留 20 ms。
  - `scheduler.ts:716`：最后一个韵尾的结束点取 `max(cur + 10 ms, sylEnd)`。

  韵尾的最小总长超过「音节结束 − 核心起点 − 20 ms」时，韵尾会延伸到下一音节的起点之后。
  - **主代理实测**：`bpm=240`，音节 a 为核心加 2 个韵尾（各 80 ms）、`note_beats=0.5`，音节 b 为字头加核心。输出中 `a_c2=[8160,8640)`、`b_o=[8400,10800)`，**重叠 240 smp（5 ms）**，并产生一条 `song_short` issue。
- **影响**：Studio 编曲编译 `src/components/studio/arranger-compile.ts:150-152` 固定传入 `allow_vowel_delay_on_conflict: true`，快速段落会得到重叠音段。下游的 TextGrid 导出、关键帧放置和音段归属（按半开区间查找）都可能得到不一致的结果。
- **建议**：由 `sylEndSmp[i]` 倒推韵尾区间，以 `sylEnd − Σcoda` 作为核心结束的上界；若仍然不足，把 `sylStartSmp[i+1]` 顺延并记入 issue。最后断言所有音段满足 `end_smp ≤ next.start_smp`，并补充对应单测。

### A-14【中｜已实测】调度器不校验输入塞音的刚性下限，语音路径也不保证音段容得下 stop_timing

- **证据**
  - `scheduler.ts:363-373`：只有 `auto_generated && !locked` 的塞音才套用 `STOP_RIGID_FLOOR`，其余塞音直接把输入的总时长当作下限，不检查 `closure_ms ≥ 10`、`release_ms ≥ 1`。
  - `scheduler.ts:773-786`：自然语音路径中，音段时长只取 `max(10, preferred_ms)`，`stop_timing` 原样拷贝。
  - 作为对照，编辑入口 `command-bus.ts:426-428` 和 `retime.ts:108-134` 都会拒绝低于下限的值。
  - **主代理实测**：输入 `closure_ms=4`、`release_ms=0.5`、`aspiration_ms=30`、`preferred_ms=12`，`schedule` 返回 ok，音段为 `[0,576)`（12 ms），`stop_timing` 保持原值（34.5 ms）。
- **影响**：违反 AGENTS.md §3.4 的「塞音刚性下限（闭塞 10 ms、释放 1 ms）越界即拒绝」。音段比内部的闭塞加释放加送气更短，下游生成关键帧时会得到不一致的时序。经过命令总线编辑的数据是安全的，但导入、AI 提案或引导演示的数据可能绕过校验。
- **建议**：在 `schedule` 入口校验每个 `stop_timing`（与 `command-bus.ts:426-428` 保持一致），越界时返回 `rigid_floor` 或 `out_of_range`；语音路径的塞音时长取 `max(preferred_ms, closure + release + aspiration)`。`scaleStopTimingMs`（L382-391）在目标时长小于 11 ms 时，各分量之和会超过目标，也应该改为拒绝。

### A-15【低】qTA 变调速率提示对平调跳进失效，经验系数待核对

- **证据**：`packages/core-ts/src/qta.ts:452-468`。
  ```ts
  const excursion = Math.abs(sp.candidate.m_st_per_s) * durS;
  const limit = Math.max(85, 10.7 + 12.4 * excursion);
  if (Math.abs(sp.candidate.m_st_per_s) > limit) {
  ```
- **问题**
  - 只用靶斜率 `m` 评估速率。当区间之间的 `b_end` 跳变很大，而斜率 `m=0`（平调、唱歌音符大跳进）时，永远不会告警。而生理速率的压力恰恰来自这种跳进。
  - 文献中 Xu & Sun (2002) 的上升经验式一般引作约 `10.8 + 5.6·d`，下降约 `8.9 + 6.2·d`（st/s）。本实现的系数 12.4 与下限 85 的来源**待确认**。
- **影响**：只影响提示，不影响合成结果。最终的 60..600 Hz 抦门（L679-689）按规范拒绝越界。
- **建议**：改用相邻区间的靶高差 `|b_end[i] − y_start[i]| / D` 估计所需速率，按升降分别套用文献系数，并在注释中注明引用。

### A-16【低】发声态两套采样语义不一致；嘘裂声锚点 F0 为 58 Hz；blend 越界被静默处理

- **证据**
  - `packages/core-ts/src/phonation.ts:218-261` 的 `evaluatePhonationAnchorsAt` 在相邻锚点间做 10 维线性插值，首个锚点之前取首个锚点的值。`phonation.ts:299-324` 的 `heldPhonationAt` 则按 `[锚点, 下一锚点)` 保持，首个锚点之前取 modal。在 `src/` 中只引用了 `heldPhonationAt`（`workbench.ts:977,1269`、`annotation-audio.ts:437`），两个插值函数只在 core 中使用。
  - `phonation.ts:113` 的 creaky 锚点 `f0_hz: 58`，低于 `F0_LIMIT_HZ.min=60`。`M27_GLOTTIS_BOUNDS.f0_hz.min=40`（L42）是 VoQS 原生下限。引擎的非 VoQS 路径要求 F0 不低于 60 Hz（`engine/dense_channel.py:52,723,1609`）。
  - `phonation.ts:239` 对 `blend` 静默夹到 [0,1]。`phonation.ts:322-323` 中 blend 越界时，`interpolateGlottis10D` 失败后静默回落为完整的发声态参数。
- **影响**
  - 文档描述的「直连插值」与工作台实际使用的「分段保持」并存，调用方容易选错函数。
  - 如果 creaky 锚点的 `f0_hz` 被作为合成 F0 送入引擎的非 VoQS 路径，请求会被拒绝（合成是否以 qTA F0 覆盖该维，**待确认**）。
  - blend 越界时不报错，与「越界即拒绝」不一致。
- **建议**：在 `phonation.ts` 文件头和 `docs/ARCHITECTURE.md` 中写明两套语义各自的用途（播放头按分段保持，密集轨迹按直连插值）；在注释中注明 creaky 锚点的 F0 只用于 VoQS 参考路径，或将其改为 60；blend 越界时返回 `out_of_range`。

### 2.y 核心算法正确性结论（主代理逐行审阅）

**范围**：
- `packages/core-ts/src/qta.ts` 的 L100-210 与 L418-722（`evalQtaSegmentAt`、`resolveAllTargets`、`evalF0` 主循环）；
- `scheduler.ts` 的 L1-45 与 L256-896（`schedule` 全函数）；
- `phonation.ts` 全文（327 行）。

未覆盖：`parseNumberedScore` 的记号解析细节、`toneLevelsToQtaTargets`、`fitHanddrawnToQtaTarget`、`continuum.ts`、`dialect.ts`、`textgrid.ts`、`retime.ts`。

| 模块 | 已核对、无问题 | 有问题 |
| --- | --- | --- |
| qTA | 三阶临界阻尼解 `x(t)=m(t−D)+b_end`，系数 `c1=y0−b_start`、`c2=y0'+c1λ−m`、`c3=(y0''+2c2λ−c1λ²)/2`，导数表达式与 Prom-on, Xu & Thipakorn (2009) 的公式一致（L117-135）。区间末状态 `(y, y', y'')` 传递给下一区间，长停顿超过 150 ms 或遇到休止后重置（L499-550）。Pin 出口状态由拟合得到，避免跳变（L525-536）。候选靶优先级为 user > transfer > score > default（L139-154）。歌唱前滑只移动 qTA 靶边界，并受 25% 与 20 ms 的保护（L183-199）。浊音帧越界按 `out_of_range` 拒绝，不夹紧（L679-689）。`λ` 和 `t` 的内部夹紧只是数值保护 | Pin 闭区间与每帧排序（A-10）；变调速率提示（A-15）；恰好等于 `last.end_smp` 的那一帧落到 `fMidSt`（L590 用 `>`），但该帧为清音，影响可忽略 |
| 抢拍调度 | 核心元音落拍（`nucleus_on_beat`）与字头落拍（`onset_on_beat`）两种策略（L521-577、L589-593）。相邻核心之间的预算为 `间隔 − holdMin`，其中 `holdMin = max(50 ms, 40% 音符)`。预算足够时用偏好时长；在最小与偏好之间时线性压缩；不足时默认返回 `rigid_floor`（L611-638）。拍点按累计拍数换算为整数采样，不累积取整误差（L494-501）。音强叠加 ±120 Pa/级后的气压、引导气压和包络在入口处校验（L397-481），密集气压逐帧校验（L878-879）。音节归属按半开区间判断（L865）。总时长上限有校验（L835-843） | 休止符丢失（A-12）；冲突路径重叠（A-13）；塞音刚性下限不校验（A-14）。另有两点静默处理：偏好时长上限 180 ms（L378）、语音路径时长下限 10 ms（L774），属于策略性处理，建议写入接口文档。性能：逐帧 `scheduledSyllables.find` 加包络排序（L865、L347），复杂度为 O(F·S) |
| 6 档发声态插值 | 6 个锚点都在 10 维 M27 声门空间中定义，气压单位为 Pa（L63-136）。`interpolateGlottis10D` 对 10 维直接线性插值，不经过中间档位，`alpha` 越界时拒绝（L192-212）。VoQS 锚点校验 10 维取值范围和喉高（L173-186）。`heldPhonationAt` 用二分查找实现 `[锚点, 下一锚点)` 的半开保持（L299-311） | 语义不一致、creaky 锚点 58 Hz、blend 静默处理（A-16）。性能：`evaluatePhonationAnchorsAt` 每次调用都要重新排序（L234），密集轨迹复杂度为 O(F·A log A) |

### 2.x 越界夹紧点的判定汇总（主代理 grep 加子代理复核）

| 位置 | 判定 | 说明 |
| --- | --- | --- |
| `playback-sources.ts:155` | **违规** | 见 A-03 |
| `playback-sources.ts:813` | **违规（低）** | 见 A-06 |
| `KeyframePopover.vue:90,93` | **违规（低）** | 见 A-07 |
| `prosody-model.ts:460,479` | **违规** | 见 A-04 |
| `ContinuumView.vue:844-845` | **违规（低）** | 见 A-08 |
| `workbench-blocks.ts:965` | 合规 | 只用于绘图显示，建议改名为 `clampForDisplay` 以便审计 |
| `engine/ipa_reference_trajectory.py:219-220` | 合规 | 引擎内部参考轨迹缩放后的数值安全截断 |
| `engine/keyframe_lite.py:134` | 合规 | 规划结果的生理范围兜底，输入已经校验过 |
| `engine/model_bundle/.../curves.py:161,173` | 合规 | 给出 output_range 时抛出 `F0ShiftOutOfRange` |
| `engine/chunked_synthesis.py:208,391-394,601-604` | 合规 | 只用于分块规划，不改写合成参数。注释“[-1,1] → [0,16000 dPa]”与 1600 Pa 一致 |
| `engine/ipa_glottis_movie.py:135,149,189` | 合规 | 只用于声门动画可视化 |

Pa 与 dPa 的换算点集中在 `engine/dense_channel.py:792/1202/1381`、`engine/m27_bridge.py:611/825/1023`、`engine/keyframe_lite.py:842`、`engine/ipa_reference_trajectory.py:236`，都在 engine 内，符合规范。唯一的例外是 A-02。

---

## 3 打包

### 3.0 打包面覆盖结论（对照 AGENTS.md §4 与 `docs/PACKAGING_WINDOWS.md`）

| 规范要求 | 实现位置 | 结论 |
| --- | --- | --- |
| 按允许清单组包 | `scripts/portable/build.py` 的 `ENGINE_FILES`、`MODEL_FILES` 和服务端 5 个 mjs（L25-43、L190-191） | 引擎、模型、服务端都按允许清单组包；`engine/vendor` 整树拷贝，见 P-01 |
| 禁带依赖（PyTorch、CUDA、GPU Provider、本地转写、训练权重） | `build.py:51-58` 的 `PRIVATE_PATH`、`verify.py:95-98` | 本地转写已隔离；规则有缺口，见 P-01、P-09 |
| `inputs.lock.json` 逐项锁定来源与 SHA-256 | `scripts/portable/inputs.lock.json` | 锁定不完整；vendor、ONNX、Rust 工具链和壳 EXE 未锁定；存在遗留项，见 P-02、P-10 |
| 逐文件长度与 SHA-256，并单独记录成品 EXE 的 SHA-256 | `build.py:346,352-355` | 逐文件长度和 SHA-256、成品 EXE 的 sidecar 都已生成；外部输入信息不全，见 P-02 |
| 体积统计（EXE、缓存、分类） | `build.py:354-355` | 只有 `EXE_BYTES`，没有分类统计和缓存占用，见 P-03 |
| Tauri 2 启动壳、自动展开、关闭即停止 | `src-tauri/src/main.rs` | 退出链路和中文路径已核对，没有问题；就绪检查、单实例和早期错误注入有缺陷，见 P-04、P-05 |
| 内置示例与参考库使用 192 kbps MP3 | `encode_references.py:47-67` | 参考库已核验；内置示例没有核验，见 P-07、P-08 |
| 文档与实现一致 | `docs/PACKAGING_WINDOWS.md` | 约 L85 仍写 .NET 启动器，见 P-10 |

> D-01（缓存清理）在便携版里同样存在。便携版有 Origin 校验，不能被跨站触发，但用户误选目录后仍能一键删除，所以它同时也是**发包前置项**。

### P-01【中】禁带文件规则有缺口，vendor 目录整树拷贝

- **证据**（主代理已回读）
  - `scripts/portable/build.py:51-58`：`PRIVATE_PATH` 拦截了以下内容：
    - 目录：`faster_whisper`、`ctranslate2`、`av`、`pyopenjtalk`、`huggingface_hub`、`tokenizers`；
    - 扩展名：`.pt`、`.pth`、`.ckpt`；
    - DLL：`cu*`、`nvrtc*`、`onnxruntime_providers_(cuda|tensorrt).dll`。

    但**没有**拦截以下内容：
    - `torch/`、`c10.dll`、`torch_cpu.dll`；
    - `onnxruntime_gpu`、`nvidia/`、`triton`、`DirectML.dll`、`whisper/`；
    - 九个槽位之外的 `.onnx`，以及 `.safetensors`、`.bin`、`.onnx_data` 等权重格式。
  - `scripts/portable/build.py:167-169`：`engine/vendor/python-cp311-win_amd64` 整树拷贝，只过滤 pyc、pyi、pdb。`verify.py:95` 复用同一个正则，缺口相同。
- **影响**：目前 vendor 里只有 Pillow 12.1.1，所以这是纵深防御层面的缺口。一旦有人往 vendor 里装了依赖链，比如顺带装进 torch 或 onnxruntime-gpu，打包不会失败，从而违反 AGENTS.md §4.3。
- **建议**
  - vendor 改为按锁定的包名清单逐项拷贝。
  - 补全上述匹配模式。
  - `verify.py` 改为正向比对：`.onnx` 恰好 9 个且路径都等于槽位路径，其余目录走白名单。

### P-02【中】外部输入锁定不完整，Tauri 壳构建不可复现

- **证据**
  - `scripts/portable/build.py:263-264`：`cargo build --release` 没有加 `--locked`（主代理已回读）。
  - Rust 工具链版本、`Cargo.lock` 哈希、壳 `voxfigura-desktop.exe` 和 7zr SFX 头的 SHA-256 都没有写入 manifest 的外部输入信息。`build.py:352-353` 只写了成品 EXE 的 sha256 sidecar。
  - vendored Pillow 不在 `inputs.lock.json` 里，只在 `DISCLOSURE.md` L67 记录了 wheel 的 SHA。
  - 九个 ONNX 文件和正式参考库取自工作区，`build.py` 没有对照固定的 SHA 清单。
  - `inputs.lock.json` L17-20 的 VC 运行库使用 `aka.ms` 跳转地址。哈希虽已锁定，但上游一旦更新，构建就会失败，不可复现。
- **影响**：不满足 AGENTS.md §4.2 “外部输入由 `inputs.lock.json` 逐项锁定来源和 SHA-256”的要求。
- **建议**
  - 改为 `cargo build --release --locked`，并把 `rustc -V`、`Cargo.lock` 哈希、壳 EXE 和 7zr 的 SHA-256 写入 manifest。
  - vendor 逐文件 SHA 和 9 个 ONNX 的 SHA 写入 lock，`build.py` 逐项校验。
  - VC 运行库改用带版本号的固定 URL，或改为本地预置文件。

### P-03【中】没有生成分类体积统计和用户缓存占用记录

- **证据**：`scripts/portable/build.py:346,354-355` 只输出逐文件的 bytes、sha256，以及 `EXE=` 和 `EXE_BYTES=`。`verify.py` L84-117 只校验 manifest 的一致性。
- **影响**：AGENTS.md §4.4 要求记录交付 EXE 大小、用户运行缓存占用，并按网页、原生推理、模型、参考库、媒体编码分类统计。目前只能人工计算，体积回归无法自动发现。
- **建议**：组包结束时按 stage 路径前缀汇总，写入 `size-report.json` 或 manifest 的 `size_breakdown`；`verify.py` 展开后统计缓存实际占用，并与上一版对比，增长时告警。

### P-04【中】启动壳的就绪检查过浅，解包器未校验，也没有单实例保护

- **证据**：`src-tauri/src/main.rs:110-123`（主代理已回读）
  ```rust
  Ok(h) if h == manifest_hash => {
      app.join("runtime").join("node").join("node.exe").is_file()
          && app.join("runtime").join("python").join("python.exe").is_file()
          && app.join("server").join("portable.mjs").is_file()
  ```
  另外两处：
  - 写出 7zr.exe 时不校验哈希（约 L208 处 `compute_hash=false`）。
  - 没有单实例互斥量，第二次启动只能通过 err_buf 报端口冲突（L464-473）。
- **影响**
  - 缓存被部分删除时（D-01 的清理，或杀毒软件隔离了 onnxruntime DLL 或 ONNX 文件）不会触发重新展开，启动后部分功能缺失。
  - 首次展开期间关闭窗口，7zr 子进程可能残留，还会留下 `.u-*` 目录。
- **已核对无问题**
  - 进程退出链路：`stop_child` 关闭 stdin，等待 4 s 后 kill（L271-286）；接着由 `server/portable.mjs` 的 `--parent-stdin` 机制（L86-109）和 `engine/server.py` 的 `VOCALCUT_ENGINE_PARENT_PIPE`（L865-870）兜底。
  - 中文和空格路径：Rust `Command` 按参数逐个传递，正确。
- **建议**
  - 启动时按 manifest 抽样比对关键文件（模型、DLL）的长度，失败则重新展开。
  - 把 7zr 的 SHA 写入 meta，展开前校验。
  - 增加命名互斥量，保证单实例。

### P-05【低｜待确认时序】启动壳的状态和错误注入可能在页面加载前丢失

- **证据**：`src-tauri/src/main.rs:355`、`:383`
  ```rust
  let script = format!("window.{fn_name} && window.{fn_name}({json_text});");
  ```
- **影响**：`prepare_bundle` 在后台线程立即执行。如果它很早就失败，`window.eval` 可能在 `src-tauri/dist/index.html` 定义 `__vfSetError` 之前执行，`&&` 守卫会把错误静默丢弃，窗口一直停在“加载中”。
- **建议**：Rust 侧保存最后一条状态和错误，在页面加载后补发；或者在 `initialization_script` 中先注入一个队列桩函数。

### P-06【低】构建脚本改写仓库内文件

- **证据**：`scripts/portable/build.py:256-257` 中，`build_tauri_shell` 会向 `src-tauri/icons` 写图标，向 `src-tauri/dist` 写启动页。
- **影响**：每次打包都会弄脏工作区，构建产物容易被误提交。
- **建议**：改为写入 `.cache/portable-build/`，再通过 `tauri.conf.json` 的路径覆盖或环境变量指向它。

### P-07【低】内置示例 MP3 没有在打包阶段逐条核验

- **证据**：只有 `scripts/portable/encode_references.py:47-67` 对参考库做码率和解码核验。`build.py` L219-226 一带拷贝预热音频、卡片录音和颤音示例时，没有类似检查。
- **影响**：不满足 AGENTS.md §4.7 “逐条检查声道与解码时长”的要求。是否已有其他单测覆盖，**待确认**。
- **建议**：`verify.py` 统一解析包内所有 `.mp3` 的帧头（码率、声道、采样率），并与源 WAV 的样本数比对。

### P-08【低】`repair_mp3_tail` 默认按单声道计算 Info 帧位置

- **证据**：`scripts/portable/encode_references.py` 中的 `repair_mp3_tail` 按单声道计算 side-info 偏移，遇到立体声时直接报错退出（fail closed）。
- **影响**：目前参考库全是单声道，不受影响。一旦加入立体声实录，组包就会失败，属于安全失败，不会产出错误的包。
- **建议**：按声道模式计算 side-info 长度（单声道 17 字节，立体声 32 字节）。

### P-09【低】引擎本地 ASR 默认开启，要显式关闭才禁用

- **证据**：`engine/server.py:48-55`（主代理已回读）
  ```python
  LOCAL_ASR_ENABLED = os.environ.get("VOCALCUT_DISABLE_LOCAL_ASR") != "1"
  if LOCAL_ASR_ENABLED:
      from asr_install import AsrInstallJob
  ```
- **影响**：便携包本身是安全的，原因有三：
  - `build.py` 的 ENGINE_FILES（L25-31）不含 `asr_install`、`asr_models`、`speech_to_text`，`verify.py:97-98` 也做了断言；
  - `server/portable.mjs:73` 会设置 `VOCALCUT_DISABLE_LOCAL_ASR=1`；
  - 前端 `src/data/whisper-models.ts:1` 写有 `!__APP_PORTABLE__`。

  但默认开启放大了 D-02 的影响，而且和 AGENTS.md §4.3 “不提供本地转写”的产品方向不一致。`package.json` 里仍保留着 `setup:asr` 脚本。
- **建议**：改为默认关闭，只在 `npm run setup:asr` 等研发场景下显式设置 `VOCALCUT_ENABLE_LOCAL_ASR=1`。是否保留开发态 ASR，需要井井决策。

### P-10【低】遗留打包文件和过时描述

- **证据**
  - 仓库里仍有 `scripts/portable/Launcher.cs`、`scripts/portable/build_asr_cpu.py`。
  - `inputs.lock.json` 里还有 `asr_build_wheels`（pybind11、setuptools、wheel）。
  - `docs/PACKAGING_WINDOWS.md` 约 L85 仍写着 “.NET Framework” 启动器。
- **影响**：与当前的 Tauri 2 启动壳、禁止本地转写入包的规范冲突，容易误导后续维护者，包括 AI 代理。
- **建议**：列入死代码清单（见 `DEAD_CODE_CANDIDATES.md`），从 lock 中移除 `asr_build_wheels`，同步修订文档（见 `GUIDANCE_DOCS_AUDIT.md`）。

### P-11【低】vendored 包的元数据泄露本机用户名和目录

- **证据**：`engine/vendor/python-cp311-win_amd64/pillow-12.1.1.dist-info/direct_url.json`（主代理已复核）里的 `url` 字段为 `file:///C:/Users/<本机用户名>/Desktop/project/…/.cache/voice-morph/pillow-12.1.1-….whl`，这个文件会随包分发。
- **影响**：公开发布或群内转发时，会暴露开发者本机的用户名和目录结构，属于隐私泄露，也与 AGENTS.md §4.3“禁止随包交付用户配置”的精神不一致。
- **建议**：入包时排除 `direct_url.json`，或重写其中的本机路径；同时检查 `RECORD` 和 `INSTALLER`。

### 3.x 打包侧已核对、无问题的项

- **九个 ONNX 槽位**：`MODEL_FILES` 里 7 个，加上 `dpdfnet2_48khz_hr.onnx` 和 `swift-f0-0.3.0.onnx`（`build.py` L32-43、L205-206）。
- **组包流程**：
  - 拒绝 WAV 入包（L344-345）；
  - 参考库经 `encode_references.py` 编码为 192 kbps MP3（L329-331）；
  - 组包时运行 `check-edition`（L326）；
  - 包名带 `-local` 标记（L316）；
  - `._pth` 中没有 `import site`（L136）。
- **服务端入包**：只包含 `card-encoding`、`portable`、`portable-cache`、`proxy`、`studio-encoding`（L190-191）。知乎和 contest 路由不入包，`.zhihu-author-defaults.local.json` 被 `PRIVATE_PATH` 排除。
- **进程生命周期和中文路径**：见 P-04 中的“已核对无问题”。

---

## 4 以往审阅问题复核表

| 编号 | 原结论 | 现状 | 证据 |
| --- | --- | --- | --- |
| 11-25 S1/S3/S6/S7/S9/S10/R3/R4/L1（前端） | 多项缺陷 | 已修复，有回归单测 | `tests/review-2026-11-25.test.ts` L98、126、181、255、334、348、407 |
| 11-25 S2/S5/S8/S9/S10（引擎） | 校验与接口缺陷 | 已修复，有单测 | `engine/tests/test_review_2026_11_25.py` L26、68、96、143；`engine/dense_channel.py:448-487` |
| 11-25 S4 | 连续统说话人参考不统一 | 已修复 | `ContinuumView.vue:854` `resolveUniformSpeakerRef` |
| 11-25 R1 | 方言工作台异步竞态 | 已修复 | `DialectStudioView.vue:530-534` |
| 11-25 R2 | 舞台视频动画不启动 | 已修复 | `StageVideo.vue:37-38` |
| 11-23 B-01 | 租借池 manual_root/section_count 泄漏 | 已修复（`_run_chunk` 的残余问题见 D-05） | `engine/dense_channel.py:516-541` |
| 11-23 B-02 | 共振缓存跨说话人串用 | 已修复 | `engine/dense_channel.py:499,513` |
| 11-23 B-03 | 合成请求竞态 | 已修复 | `src/stores/workbench.ts:2101-2106` |
| 11-23 B-04 | 韵律模型 F0 低于下限 | Text2Prosody-Lite 路径已修复；日语路径见 A-04；引擎桥残余问题见 A-09 | `prosody-model.ts:115-116`；`engine/prosody_bridge.py:70-93` |
| 11-23 B-06 | m27_bridge、keyframe_lite 输入未校验 | 已修复 | `engine/m27_bridge.py:539,767,978,1014,1177,1241` 等 |
| 11-23 B-08 | 引擎无超时、无请求体上限 | 部分修复 | `engine/server.py:110`（64 MiB 上限）、`:137`（120 s 超时）；锁获取超时见 D-10 |
| 11-23 B-14 | 播放恢复与节点检查 | 已修复 | `src/stores/workbench.ts:2643,2682` |
| 11-23 B-18 | 引擎 CORS 为 `*` | 部分修复：CORS 已限回环，但缺少跨站 POST 防护（见 D-02） | `engine/server.py:111,146-158` |
| 11-23 B-20 | UI 使用 Emoji | 已修复 | 全仓 grep 无命中 |
| 11-23 B-21 | 前端做 dPa 换算 | 已修复（新出现的违规见 A-02） | `packages/core-ts` 中 grep `Dpa` 无命中 |
| 11-23 B-22 | 适配器丢弃 `allowed` 和 `value`，不可取消 | 大部分已修复（残余见 D-08） | `engine-transport.ts` L22-47；`m27-adapter.ts:152-181` |
| 11-23 C14 | 连续统 F0 静默替换 | **未修复**（见 A-08） | `ContinuumView.vue:844-845` |
| 11-23 B-05、B-07、B-09 至 B-13、B-15 至 B-17、B-19 | 见原报告 L744-776 | **待确认**，本轮未逐条复核 | `docs/reviews/CODE_REVIEW_REPORT_2026-11-23.md:744-776` |

---

## 5 可优化项（非缺陷）

1. **统一越界工具函数**：在 `packages/core-ts` 中提供 `checkRange(value, limit, field)`，统一返回 `out_of_range`，替换前端散落的 `Math.max/min`（A-03、A-04、A-06、A-07、A-08）。只用于显示的夹紧统一改名为 `clampForDisplay`，便于 grep 审计。
2. **参数边界只保留一份来源**：`packages/core-ts`、`engine/validation.py` 和 `src/stores/workbench.ts` 各自维护 19 维边界（A-01 就是这样出现的分叉），建议从 `schema/` 生成，并加跨语言一致性测试。
3. **统一撤销体系**：见 D-06。
4. **qTA 预排序**：Pin 点集只排序一次，见 A-10。
5. **`m27-realtime.ts` 内存分配**：`ingestRawBlock` 每块都执行一次 `Float32Array.from(number[])`（L509、L534），可以改为预分配缓冲。
6. **3D 帧回退常数**：`decodeTract3DFrame` 的 `fallbackLimited` 是 19 个魔法常数（L230-234），建议从 `VTL_PARAM_META` 的默认值生成。
7. **代理按路由设超时，引擎锁加超时**：见 D-09、D-10。
8. **打包可观测性**：把 `size_breakdown` 与上一版的差异写入发布记录，见 P-03。

---

## 6 优先修复清单

| 优先级 | 编号 | 动作 | 涉及文件 |
| --- | --- | --- | --- |
| **P0（发包前）** | D-01 | 缓存清理改为白名单分类加专属子目录，前端二次确认，非便携运行时隐藏面板；补“无关目录不被删除”单测 | `server/portable-cache.mjs`、`src-tauri/src/main.rs`、`PortableCachePanel.vue`、`SettingsView.vue` |
| **P0** | D-03 | `pick-dir` 改为通过环境变量传值，补弯引号注入单测 | `server/portable-cache.mjs` |
| **P0** | D-02 | 开发态代理启用 Host、Origin、`Sec-Fetch-Site` 校验，写接口强制 JSON 加自定义头；开发态引擎注入令牌 | `server/proxy.mjs`、`server/portable-cache.mjs`、`scripts/start-engine.mjs`、`engine/server.py` |
| P1 | A-01 | 统一 TRX/TRY 边界，补跨语言一致性测试 | `packages/core-ts/src/command-bus.ts` |
| P1 | A-12、A-13、A-14 | 调度器累计休止符时值；冲突路径不再产生重叠音段；入口校验塞音刚性下限；补充对应回归用例 | `packages/core-ts/src/scheduler.ts` |
| P2 | D-15 | 前端直连引擎的调用收敛到适配器层 | `packages/model-adapters`、`src/components/research/*` |
| P1 | A-02、A-03、A-04 | 前端 dPa 换算移回引擎；发音卡和日语路径改为越界即拒绝 | `voice_morph_bridge.py`、`voice-mixer.ts`、`playback-sources.ts`、`prosody-model.ts` |
| P1 | P-01、P-02 | 补全禁带规则，vendor 按清单拷贝，verify 断言 ONNX 恰好 9 个；`cargo --locked`，锁全外部输入 | `scripts/portable/build.py`、`verify.py`、`inputs.lock.json` |
| P1 | D-04 | 去掉 HTTP 回落，或对清单签名 | `server/proxy.mjs` |
| P2 | A-05 | 实时重采样加抗混叠，补离线与实时一致性回归 | `m27-realtime.ts` |
| P2 | P-03、P-04 | 分类体积报告；就绪检查抽样校验，7zr 校验哈希，单实例 | `build.py`、`verify.py`、`src-tauri/src/main.rs` |
| P2 | D-05、D-06、D-07 | `_run_chunk` 复位状态；revision 单调递增，oplog 截断；版本隔离检查加强 | `dense_channel.py`、`command-bus.ts`、`workbench.ts`、`check-edition.mjs` |
| P3 | 其余低级问题 | 按第 1 至 3 节的建议逐项处理 | — |

---

## 附录：检索、读取与实测记录

- **主代理基线**：`npm run typecheck`、`npm test`、Python 引擎单测，结果见 0.2。
- **主代理夹紧 grep**：在 `packages`、`src`、`server`、`engine` 范围内，排除 vendor 和 json，执行 `git grep -n -i -E "(clamp|Math\.(min|max)|np\.clip|min\(max\().*(f0|hz|pressure|_pa\b|pa\)|subglottal|lung)"`。命中点的判定见 2.x 节。
- **主代理换算 grep**：执行 `git grep -n -i -E "dpa|\* ?10\b.*(pa|press)|(pa|press).*\* ?10\b"`，换算点都在 `engine/` 内。
- **主代理回读复核的证据**：`portable-cache.mjs` L110-122、L199-237、L305-335；`proxy.mjs` L12-19、L328-366；`command-bus.ts` L55-67；`validation.py` L55-67；`workbench.ts` L290-297；`voice-mixer.ts` L150-160；`build.py` L48-61、L260-266；`PortableCachePanel.vue` L125-153；`SettingsView.vue` L1215-1222；`reserved-slots.ts` L125-145；`prosody-model.ts` L456-482；`engine/server.py` L44-56、L124-133；`main.rs` L108-125；`dense_channel.py` L1460-1472；`playback-sources.ts` L145-160、L805-820；`KeyframePopover.vue` L85-98。
- **D-03 实测**：在 `.cache/review-tmp/` 下写了一个临时 Node 探针，按 `portable-cache.mjs:222-228` 原样转义并拼接，用 `psobject` 代替对话框，载荷为 `C:\x’+$(Write-Host 424242)+’`，输出 `424242`、`DONE`。探针执行后已删除（`Test-Path` 返回 False），也没有调用真实的 `/pick-dir` 接口。
- **A-12 至 A-14 实测**：在 `.cache/review-tmp/` 下写了临时 `vite-node` 探针，只 import `packages/core-ts/src/scheduler.ts`，不修改任何仓库文件。探针覆盖三种输入：简谱 `12` 与 `102` 的拍点对比、冲突路径下的双韵尾、语音路径下 `closure_ms=4` 的塞音。输出已写入各条目，探针执行后已删除。
- **P-11 复核**：读取 `direct_url.json`，用户名在输出时已脱敏。
- **子代理检索**：读取了 `server/*.mjs`、`engine/{validation,dense_channel,server,prosody_bridge,ipa_reference_trajectory,keyframe_lite,chunked_synthesis,voice_morph_bridge,asr_install,asr_models}.py`、`scripts/portable/{build.py,inputs.lock.json,encode_references.py,verify.py}`、`src-tauri/{src/main.rs,tauri.conf.json,Cargo.toml}`、`packages/core-ts/src/{command-bus,qta,textgrid,types}.ts`、`packages/model-adapters/src/{reserved-slots,m27-adapter,engine-transport}.ts`，以及未提交的文件。
- **未覆盖，待确认**
  - `packages/core-ts` 中连续统、方言变调、TextGrid、retime 对空区间和零时长输入的边界处理（抢拍调度、qTA 和发声态已在 2.y 覆盖）；
  - `packages/g2p-ts` 的边界处理；
  - `engine/model_registry_runtime.py` 中 ONNX 会话的复用与加锁；
  - 未提交文件 `AlignedPianoRoll.vue`、`StudioArrangerView.vue`、`guide-modules-creative.ts` 只做了 grep，没有逐行审阅；
  - 旧 11-23 报告中 B-05 至 B-19 的部分条目。
- **合规声明**：未读取 `.env.local`，未输出任何密钥或 BYOK 请求头的值，未写入外部基线目录，未执行构建、打包或安装命令。
