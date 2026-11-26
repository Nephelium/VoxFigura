# VoxFigura 工程与代码规范（CODING_STANDARDS）

> 文档版本：1.0 · 2026-11-24
> 配合 [AGENTS.md](../AGENTS.md) 与 [ARCHITECTURE.md](./ARCHITECTURE.md) 共同生效

## 1. 模型官方命名铁律

1. 代码注释、文档、界面文案、错误提示、类型定义与接口说明中，**一律使用 VoxFigura Core 官方模型名**：
   - `Vox2Tract-Lite`（取代旧称 `Stage 4` / `BrowserLightM27Inverter`）
   - `Tract2Vox-Lite`（取代旧称 `Stage 5` / `Stage 5 Lite` / `Stage 5 HiFiGAN` / `ConditionalHiFiGenerator27`）
   - `IPA2Tract-Lite`（取代旧称 `KF2Tract` / `KF2Tract27`）
   - `Tract2Area-Proxy`（取代旧称 `TubeAreaProxy27`）
   - `Vox2Spk-Lite`（取代旧称 `BrowserLightSpeakerEncoder`）
   - `Text2Prosody-Lite`
   - `Vox2Align-Lite v2`
2. 例外仅限上游权重/SDK 固有历史包名或序列化键（如 `legacy_source`、`runs/browser_m27_stage5`、兼容性 API 字段 `stage5_ready`）或学术历史综述。新增代码中严禁使用 `Stage 4`、`Stage 5` 称呼模型。

## 2. 单位、时间轴与区间铁律

1. **48 kHz 整数采样与半开区间**：全部时间轴编辑与调度使用 `SAMPLE_RATE_HZ = 48000` 整数采样和 `[start_smp, end_smp)`。字段命名必须带单位后缀（`_smp`, `_ms`, `_st`, `_hz`, `_pa`, `_cm`）。
2. **气压单位隔离**：UI、前端状态、核心库、Model Adapters、HTTP JSON 请求与响应中气压一律使用帕斯卡 `Pa`（`0..1600 Pa`）。仅在 Python `engine/` 与 VTL 原生 DLL / M27 契约的边界换算 `dPa = pa * 10`，**禁止**在 `packages/` 或前端层执行 `* 10` 换算。
3. **帧率与时间对齐**：模型控制轨为 `50 Hz`（20 ms/帧，帧中心 `(k + 0.5) / 50` s）；VTL 物理控制为 `200 Hz`（5 ms/帧 = `240` 采样 @ 48 kHz）；前后端对 50 Hz 动画帧索引统一按帧中心 `t * 50 - 0.5` 取样，不得引入 10 ms 半帧偏差。

## 3. 越界即拒绝（Zero Silent Clamping）

1. 所有用户可输入或外部传入的参数进入归一化（`normalize_m27`）、神经网络或 VTL 原生层前，必须通过集中校验器校验：
   - 后端统一使用 `engine/validation.py`（`validate_m27_pa`、`validate_tract19_array`、`validate_glottis_array`、`validate_scalar_range`）。
   - 前端与内核统一使用 `packages/core-ts` 的 `assertInRange` / `outOfRange`。
2. 必须同时检查：`type(v) is not bool`、`isfinite(v)`（拦截 `NaN` / `Inf`）以及上下限范围。
3. 越界一律返回标准契约 `{ ok: false, error: { code: 'out_of_range', field, value, allowed: { min, max, unit }, hint } }` 与 HTTP `400`。前端 Adapter（`M27Adapter`、`VocalEngineTransport`）必须原样透传 `out_of_range` 与 `allowed`，禁止压平为 `validation_error`。

## 4. 引擎并发、锁边界与 VTL 作用域租借

1. **VTL 原生引擎租借**：任何需要调用 `VocalTractLab` 原生几何或声管的对象，必须通过 `with DENSE_MANAGER.lease(speaker, manual_root=..., section_count=...):` 获取，严禁在业务代码直接持有 `eng` 后修改 `manual_root` 或 `section_count` 而不复位。
2. **共享缓存线程安全**：跨请求缓存在按说话人加锁的前提下独立持有（如 `_resonance_caches[speaker]`），缓存键必须包含完整几何上下文 `(speaker, section_count, manual_root, pose)`。
3. **细粒度锁与共享模型池**：I/O 解码、音频重采样不得持推理锁；反演锁与声码器锁分离；`VoiceMorphBridge` 必须复用 `M27Bridge` 共享的 `VoiceMorphEngine`；`Tract2Vox-Lite` 模型按设备字典缓存，避免 CUDA/CPU 单槽互踢。
4. **HTTP 与代理防线**：Python 服务绑定 socket 超时（`120 s`）、限制请求体上限（`64 MiB`）、静默处理空闲保活断连异常、CORS 限制为回环来源。Node 代理对全部 `/api/(vtl|m27|models)/*` 透传 `AbortController` 并限制 `64 MiB` 包体。

## 5. 前端异步安全、资源回收与 G2P/简谱约定

1. **防竞态与取消链**：所有会触发状态写回的 `fetch` 必须绑定 `AbortController` 与 `AbortSignal.timeout(...)`；有顺序依赖的操作使用单调递增序列号或单飞复用；组件 `onBeforeUnmount` 必须递增序列号、中止在途请求并释放资源。
2. **WebGL 与媒体回收**：异步 `mountVocalTract` 返回后必须复检 `disposed`，若已卸载立即 `destroy()`；`sessionMedia` 在素材移除或工程切换时必须调用 `URL.revokeObjectURL` 并清除引用。
3. **音频解析禁止硬编码偏移**：解析 WAV 时按 RIFF 子块（`fmt ` / `data`）遍历定位，或直接读取接口返回 `sample_count` / `duration_s`。
4. **通用简谱与音标切分**：
   - 简谱支持通用键盘记号（`1-7`、`0` 休止、`'`/`+` 高八度、`,`/`-` 低八度、`/`/`_` 减时、`.` 附点、`*`/独立 `-` 增时、`(3//5//)` 多音连奏、`p/pp/ppp/f/ff/fff` 及 `(1p23)ff`），序列化优先输出标准时值符号与无竖线连奏括号，从语音导入时量化至 1/4 拍网格（非标准时值最多保留 2 位小数）。
   - IPA 音标切分（`splitPhoneNotation`）仅合并双字符塞擦音对，不将双元音强行合并为单符号；录音构型查表在别名与剥离附加符回退时不泄露 PTB 工厂非默认 `tongue_shape`/`lip_shape` 通道。

## 6. 界面与代码质量守则

- **零 UI Emoji 与界面库禁用**：严禁引入 Element Plus / Ant Design Vue / Naive UI；严禁出现任何 UI Emoji 装饰（如 `⏸`），静音统一使用 `'sil'` 或空文本。
- **超大文件治理边界**：新编写的 TS/Python 模块单个功能函数保持单一职责、浅层嵌套；对现存 >1000 行的 Vue 单文件组件，新增独立逻辑优先抽入 `.ts` composable 或纯函数工具模块，不继续膨胀单文件。
- **变更验证基线**：任何实质改动交付前，必须实跑并通过 `npm run typecheck`、`npm test`、Python `unittest` 与双版 `npm run build` / `npm run build:hackathon`。
