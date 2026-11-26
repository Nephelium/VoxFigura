# 架构未决问题与当前默认策略（OPEN_QUESTIONS）

> 记录截至 2026-11-22 核查出的 5 项关键工程与合规问题及其当前默认落地策略。

## 1. Emscripten SDK 缺失与双传输层策略

- **核查事实**：当前环境 `PATH` 中未检测到 `emcc`（Emscripten SDK 未就绪），无法在本轮直接重新编译 `build_m10_wasm.py` 产出 `vocal-runtime.zip`。
- **当前默认方案**：采用 **Python 原生 DLL + Wasm 自动切入双传输层（`VocalEngineTransport`）**。
  - 前端适配器优先探测 `/vocal-wasm/manifest.json`；若存在则自动切入浏览器本地 Pyodide + VTL Wasm Worker。
  - 未检测到 Wasm 包时无缝切换至 `/api/vtl/*`（由 `server/index.mjs` 转发至本机 `engine/server.py` 真实 VTL 2.4 DLL）。
  - 断网或引擎未启动时，自动回落至 `/prewarm/` 真实 VTL 预渲染结果并明确标注状态。
- **后续动作**：在具备 Emscripten 4.0.9 的环境重建 `vocal-runtime.zip` 并置于 `public/vocal-wasm/` 后，前端零改动即可自动切入纯浏览器 Wasm 运行。

## 2. Stage 4/5 已就绪，但关键帧 / 浏览器极轻 / 独立发音人模型尚待训练

- **核查事实**：`F:\TensorTract3_Train\runs\m27_v1` 已包含可用的 Stage 4（`motor_natural/best.pt`, `pr_encoder/best.pt`）与 Stage 5（`neural_synth/best.pt`）检查点；而 `KF2Tract27`（`src/tt3/kf_models.py`）、`BrowserLightInverter`（`src/tt3/distill_models.py`）与自定义 `SpeakerAdapter` 微调权重尚未产出最终导出检查点。
- **当前默认方案**：在 `packages/model-adapters/` 与 `engine/server.py` 为上述三项未训模型保留标准化插槽（`/models/kf2tract` 等返回明确 `501` 契约 JSON 说明），严格按 `docs/MODEL_INTERFACE_SPEC.md` 冻结张量形状、归一化边界与 `model.manifest.json` 规范，后续模型训完即可热插拔上线。
  - 其中发音人模型在当前已可通过 Stage 5 `FrozenSpeakerEncoder` 接收可选 `speaker_ref` WAV 执行零样本音色转换。

## 3. `.env.local` 仅配置知乎 Secret 时的 LLM 降级与 BYOK 策略

- **核查事实**：`.env.example` 显示 `LLM_API_BASE_URL` / `LLM_API_KEY` 为可选项。当运行环境仅配置了 `ZHIHU_ACCESS_SECRET` 而未配置外部 `tools[]` 大模型密钥时，Channel B 无法直接发起外部函数调用。
- **当前默认方案**：
  - AI 对话采取双通道路由：Channel A（`zhida`，走知乎直答 `POST /v1/chat/completions`）可直接使用服务端知乎凭证，并通过受控系统提示词返回“解说文本 + Schema JSON 提案块”由前端解析送入 `CommandBus`。
  - Channel B（`tools`，支持 OpenAI `tools[]` 与多模态 `image_url`）优先读取服务端环境变量，若未配置则接受用户设置页传入的 `X-LLM-BYOK-*` 请求头；均未配置时返回明确的 `400/503` 结构化提示，引导切换 Channel A、填入 BYOK Key 或使用本地回放模式。

## 4. GPL-3.0 开源许可与知乎黑客松参赛合规口径

- **核查事实**：VocalTractLab 2.4 与 `PhoneticToolbox v3` 的 VTL 桥接层为 `GPL-3.0-or-later`。知乎黑客松 S3 规则禁止“已公开发布的项目原封不动参赛”，允许合规使用开源组件并在计划书中如实披露，核心功能与主要创新须由团队独立形成。
- **当前默认方案**：
  - 本仓库整体采用 `GPL-3.0-or-later`（见根目录 [LICENSE](file:///c:/Users/13680/Desktop/project/%E3%80%90%E4%B8%AA%E4%BA%BA%E9%A1%B9%E7%9B%AE%E3%80%91/%E9%BB%91%E5%AE%A2%E6%9D%BE/LICENSE)）。
  - 在 [DISCLOSURE.md](file:///c:/Users/13680/Desktop/project/%E3%80%90%E4%B8%AA%E4%BA%BA%E9%A1%B9%E7%9B%AE%E3%80%91/%E9%BB%91%E5%AE%A2%E6%9D%BE/DISCLOSURE.md) 中逐文件区分“沿用自 PTB/VTL”与“全新独立开发（路线 B 三工作区、qTA、抢拍调度器、6 档发声态直连、CommandBus、知乎联动与双通道 AI）”。
  - 待负责人向赛事官方小助手最终确认口径。

## 5. 示例曲目版权替代（《茉莉花》替代《人是猫》）

- **核查事实**：原基线中使用的《人是猫》为他人原创曲目，存在未授权参赛演示版权风险。
- **当前默认方案**：全仓库公开演示工程、探索预热片段与剪辑工作室默认工程统一替换为公有领域传统民歌《茉莉花》首句（“好一朵美丽的茉莉花”）以及 5 个知乎发音对比案例；《人是猫》不随公开包分发。
