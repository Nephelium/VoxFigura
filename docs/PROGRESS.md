# VocalCut Studio 开发进度总览（PROGRESS）

> 更新日期：2026-11-23（Revision 2 合流收口）

| 阶段 / 工作包 | 负责范围 | 当前状态 | 说明 |
| --- | --- | --- | --- |
| Stage 1 · 工程基建与资产整合 | 工程骨架、`npm install`、静态资源（含 `public/favicon.svg`）、字体、刘看山、`vocal-tract-view`、`g2p-ts`、655 IPA 目录、数据集、契约与文档 | 已完成并验证 | 见 `docs/devlog/2026-11-22-bootstrap.md` |
| Stage 2 · 核心内核与双端引擎 | `packages/core-ts`、`packages/model-adapters`、`engine/`（VTL 2.4 + TensorTract3 Stage 4/5 + `/m27/extract-anim` + `/vtl/batch-contours` + `public/prewarm/`）、`server/index.mjs`、`tests/core.test.ts` | 已完成并验证 | 48 kHz 整数采样、qTA、抢拍调度、6 档发声态、命令总线、双端代理与单测通过 |
| Stage 3 · Vue 3 三工作区界面 | `src/` 视图（探索实验室、科研工作台、剪辑工作室、设置/使用说明/关于）、公共组件（`VocalTractViewport` 等）、`src/stores/workbench.ts`、8 套质感 + 6 档背景 + 29+1 配色、Style Lab | 已完成并验证 | 全仓 `vue-tsc --noEmit`、`vitest run` 与 `vite build` 通过 |
| Revision 2 · 真实物理与高清图谱升级 | 全 8 项体验与真实化改造：`/m27/extract-anim` 与 `/vtl/batch-contours`、M10/喉镜/声带高清渲染器（`m27-hd-renderers.ts`）、PTB 瞬时物理四联图（`ptb-physics-charts.ts`）、218 音标校准预设与 5 项 `TractPoseExtras` 全链路透传（`ptb-ipa-presets.ts`）、`IpaPlusView` PTB 原生矩阵、舞台时间轴严格门控与关键帧插值、`DialectStudioView` 实听与入声闭塞对齐 | 已完成并验证 | 彻底清除手编近似构型，全部切入 VTL 2.4 与 M27 真实几何轮廓驱动 |
| Visual Audit Pass 4 & 端到端集成验收 | 26 组桌面分辨率/主题视口截屏与 DOM 核验 + 交互式浏览器端到端 7 项实机验证 | 已完成并验证 | 0 console/page error，修复 `scene.js` 双音对比窄容器标注裁切，交互式 E2E 7 项全过（含 `ResearchTimeline.vue` 音素块点击与框选延迟指针捕获修复复验） |
| 后续模型插槽 | `KF2Tract27`、`BrowserLightM27` ONNX、`SpeakerAdapter` 独立权重 | 规范已冻结（`501` 插槽） | 见 `docs/MODEL_INTERFACE_SPEC.md` |

## 当前集成状态与扩展说明

- **已接入真实引擎与外部服务**：
  - 物理引擎：VTL 2.4 原生物理管段、几何求解与批量轮廓接口（`engine/` + `/api/vtl/*`）及 `public/prewarm/` 真实 VTL 2.4 预热资产。
  - 神经反演与重合成：`F:\TensorTract3_Train\runs\m27_v1` Stage 4（`m27` 声道动态重建与高清动画轮廓提取 `/m27/extract-anim`）及 Stage 5（`ConditionalHiFiGenerator27` 神经重合成 + 零样本 `speaker_ref`）。
  - 知乎开放平台：6 项 REST 接口代理与知乎直答（Channel A）接入（含 TTL 缓存、静默过滤与 `30001` 降级），以及 Channel B `tools[]` 执行模型路由。
- **已保留规范的待接入槽位**：`KF2Tract27`、`BrowserLightM27` 与自定义 `SpeakerAdapter` 已在 `packages/model-adapters/` 与 `engine/server.py` 冻结接口并保留 `501` 契约插槽，详见 [MODEL_INTERFACE_SPEC.md](file:///c:/Users/13680/Desktop/project/%E3%80%90%E4%B8%AA%E4%BA%BA%E9%A1%B9%E7%9B%AE%E3%80%91/%E9%BB%91%E5%AE%A2%E6%9D%BE/docs/MODEL_INTERFACE_SPEC.md)。
- **风格扩展入口**：8 套表面质感 × 6 档高清科技背景 × 29+1 Codex 配色体系，提供设置页、Style Lab 浮动面板（`Alt+Shift+S` / `?stylelab=1` / 连点 Logo 5 次）、URL 参数与 `window.__VC_STYLE__` 四路入口，详见 [STYLE_EXTENSION_GUIDE.md](file:///c:/Users/13680/Desktop/project/%E3%80%90%E4%B8%AA%E4%BA%BA%E9%A1%B9%E7%9B%AE%E3%80%91/%E9%BB%91%E5%AE%A2%E6%9D%BE/docs/STYLE_EXTENSION_GUIDE.md)。
- **已知待补事项**：Emscripten SDK（`emcc`）浏览器本地 Wasm 包 `vocal-runtime.zip` 重建、Channel B 外部执行大模型 BYOK Key 配置及未训模型权重训练接入，详见 [OPEN_QUESTIONS.md](file:///c:/Users/13680/Desktop/project/%E3%80%90%E4%B8%AA%E4%BA%BA%E9%A1%B9%E7%9B%AE%E3%80%91/%E9%BB%91%E5%AE%A2%E6%9D%BE/docs/OPEN_QUESTIONS.md)。
