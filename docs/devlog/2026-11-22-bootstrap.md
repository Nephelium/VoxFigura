# 2026-11-22 Bootstrap 开发日志

- **日期**：2026-11-22
- **角色 / 阶段**：Stage 1 工程基建与资产整合工（`infra-assets`）
- **使用工具与模型**：gemini-4-hydrogen-high + Node v24.13.0 + PowerShell

## 1. 完成事项

1. **工程骨架初始化**：
   - 建立 `package.json`（`vocalcut-studio`，含 `dev`/`build`/`preview`/`typecheck`/`test`/`server`/`engine` 脚本）、`tsconfig.base.json`、`tsconfig.json`、`vite.config.ts`（配置 `/api` 代理至 `127.0.0.1:3001`）、`vitest.config.ts` 与 `index.html`（内置 `three` importmap 及 `PTBIPAPlus` / `Doulos SIL` / `JetBrains Mono` 字体声明）。
   - 执行 `npm install` 安装 `vue`、`three`、`dotenv`、`vite`、`@vitejs/plugin-vue`、`typescript`、`vue-tsc`、`vitest`、`@types/node`、`@types/three`（共 97 packages）。
2. **可移植静态资产与独立包**：
   - 复制刘看山 6 个透明动图（`idle.gif`、`greet.gif`、`sway.gif`、`computer.gif`、`sleepy.gif`、`dribble.gif`）与 3 张三视图（`sheet-{1,2,3}.jpg`）至 `public/assets/kanshan/` 并生成 `manifest.json`。
   - 复制字体与 OFL 许可文件至 `public/fonts/`。
   - 复制 2D/3D 声道可视化组件至 `public/vocal-tract/`，并在 `packages/vocal-tract-view/` 放置完整零框架耦合镜像包（含 `manifest.json`、`README.md`、`demo.html`）。
   - 复制 `cmudict.dict` 与 `ja-mfa-v3/*` 至 `public/vocal-tract/assets/`；移植 `packages/g2p-ts/src/` 纯函数包，剥离原工程 i18n/字体依赖并补充 Node/Browser 双环境字典加载回退，并通过 Vitest 单元测试。
   - 合并生成 655 条音标的 `public/data/ipa-plus-catalog.json`（`ipa`: 381, `extipa`: 209, `voqs`: 65）。
   - 从 `docs/specs/ui-preview.html` 提取 `src/data/references.ts`（69 条）、`src/data/explore-cases.ts`（5 个案例 + 60 个随机抽题词库）与 `src/data/dialect-packs.ts`（`yue`/`nan`/`wuu`/`cmn`）。
3. **契约与工程文档**：
   - 落盘 `schema/project.schema.json`、`schema/tool-registry.json`、`LICENSE`、`DISCLOSURE.md`、`THIRD_PARTY.md`、`AGENTS.md`、`docs/OPEN_QUESTIONS.md`、`docs/PROGRESS.md`、`docs/MODEL_INTERFACE_SPEC.md`、`docs/STYLE_EXTENSION_GUIDE.md`。

## 2. 关键决策与环境核查

- 核查本机未安装 Emscripten SDK（`emcc` 不可用），因此确认阶段一/二采用“Python 原生 VTL 2.4 DLL + Wasm 探测自动切入”双传输层方案（记录于 `docs/OPEN_QUESTIONS.md`）。
- 严格遵守只读原则，未修改 `D:\PhoneticToolbox\PhoneticToolbox_v3` 或 `F:\TensorTract3_Train` 内任何文件，未读取或打印 `.env.local` 密钥内容。

## 3. 阶段二/三合流、实测修补与视觉走查记录

- **静态图标与字体基座补充**：新增几何矢量图标 `public/favicon.svg` 并在 `index.html` 引入，消除浏览器控制台 `/favicon.svg` 404。
- **双端协议与响应字段对齐**：
  - `server/index.mjs` 兼容知乎开放平台大写 `Code`、`Data.Items` 及 `/api/v1/quota` `Data` 数组并补齐归一化 `quotas` 映射。
  - `src/stores/workbench.ts` 与 `src/views/ExploreLabView.vue` 对齐真实 VTL `/api/vtl/pose` 与 `/api/vtl/synthesize` 字段，并修复 `probeEngine()` 校验 `content-type: application/json` 与 `schema` 字段以消除 Vite SPA fallback 200 HTML 误判。
  - `src/components/modals/ExportModal.vue` 卡片预览与导出在 `vtl-engine` 就绪时优先消费实时 `currentMetrics`，与主视口保持同源。
- **真实 2D/3D 声道视口与透明舞台叠加**：`src/components/common/VocalTractViewport.vue` 改用原生 `<script type="module">` 单例加载 `/vocal-tract/embed.mjs`（规避 Vite `?import` 重写导致的 HTTP 500），并通过 `options.head = !transparentBg` 与样式覆写实现 `StudioStageView` 中 `V1 声道演员` 在 `V0` 背景上的透明叠加。
- **Visual Audit Pass 1/2 排版与字符修补**：
  - `ResearchMainView.vue`、`DialectStudioView.vue`、`TransferFunctionChart.vue` 移出 `preserveAspectRatio="none"` SVG 内的 `<text>`，改为锐利 HTML 刻度轴与叠层徽标。
  - `src/data/dialect-packs.ts` 与 `DialectStudioView.vue` 为悬空不除阻符号 `[̚]` 补全虚线圆基底 `[◌̚]`（`\u25cc\u031a`）并统一套用 `.ipa` 字体；`IpaPlusView.vue` 增加矩阵单元格呼吸间距。
  - `StudioArrangerView.vue` 修正 40 键钢琴最右侧 `D#5` 黑键对齐边界，实现零裁切展示；`StudioStageView.vue` 优化 16:9 舞台占比并补全 `V0` 默认极光频谱渲染；`AboutView.vue` / `GuideView.vue` 改为 `.set-content` 局部滚动容器隔离，并收敛 `StyleLabBackdoor.vue` 默认停靠坐标与顶栏响应式断点。

## 4. Revision 2 工程落盘、Visual Audit Pass 4 与实机交互验证

- **后端高清轮廓与批量接口**：`engine/m27_bridge.py` 新增纯 NumPy 展开的 `extract_anim_from_pa`（`/m27/extract-anim`，支持至多 3000 帧并严格校验越界不夹紧）；`engine/dense_channel.py` 新增 `batch_contours`（`/vtl/batch-contours`，单锁批量生成至多 64 帧真实 VTL 9 部件轮廓与 $A_{min}/F1/F2/F3$）。
- **只读移植与真实预设贯通**：
  - 从 `F:\TensorTract3_Train\scripts\serve_m27_dashboard.py` 移植适配 `src/components/research/m27-hd-renderers.ts`，点亮 `M27ReconstructView.vue` 与 `ContinuumView.vue` 的 M10 高清矢状面、喉镜俯视/Cover–Body 声带图谱与 7 轨 50 Hz `Pa` 物理曲线。
  - 从 `PhoneticToolbox_v3` 移植 `src/components/research/ptb-physics-charts.ts`（瞬时物理四联图），并由 `src/data/ptb-ipa-presets.ts` 统一加载 `JD2`/`W02`/`JD2-2D`/`W02-2D` 校准预设与 5 项 `TractPoseExtras`（`lip_width`/`larynx_height`/`manual_root`/`tongue_shape`/`lip_shape`），贯通 `ResearchMainView`、`IpaPlusView`、`ContinuumView`、`StudioStageView` 与 `DialectStudioView`。
  - `IpaPlusView.vue` 还原 PTB 原生矩阵与双列分组排版；`StudioStageView.vue` 隔离 `V1` 内部指针抢夺并落盘时间轴严格半开区间门控与多关键帧插值。
- **Visual Audit Pass 4 与 E2E 复验**：
  - 26 组桌面分辨率/主题视口截屏与 DOM 核验 0 console/page error；同步更新 `public/vocal-tract/scene.js` 与 `packages/vocal-tract-view/scene.js`，加入窄容器横向解剖跨度保底缩放与 `placeLabel` 视口安全边界夹紧，修复双音对比窄卡片标注裁切。
  - 交互式浏览器 E2E 7 项全部通过，包含修复 `src/components/research/ResearchTimeline.vue` 中 `onPhoneLanePointerDown` 延迟指针捕获（仅在水平拖拽位移达到 `>= 4 px` 时激活框选捕获，恢复时间轴音素块单击切换选中音素与实时声道构型联动）及全仓 `typecheck` / `test` / `build` 验证。
