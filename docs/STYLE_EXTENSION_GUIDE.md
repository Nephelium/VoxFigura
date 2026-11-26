# VoxFigura 视觉风格体系与扩展指南（STYLE_EXTENSION_GUIDE）

## 1. 架构总览：8 × 6 × (29 + 1)

VoxFigura 采用正交的三维主题架构，全部基于原生 CSS 自定义属性（CSS Custom Properties）与 `<html>` 根节点的 `data-*` 属性驱动，严禁引入 Element Plus / Ant Design Vue / Naive UI 等第三方重型组件库：

1. **8 套表面质感（`data-style`）**：
   - `neumorphism`：轻新拟态 × 磨砂玻璃（默认）
   - `clay`：轻黏土拟态
   - `glass`：液态磨砂玻璃
   - `minimal`：精致仪器风
   - `material`：材质层级 Material
   - `swiss`：瑞士网格
   - `bauhaus`：包豪斯几何
   - `brutal`：轻新粗野
2. **6 档高清科技背景（`data-bg`）**：
   - `aurora`：极光网格（默认）
   - `spectrum`：流光光谱
   - `radar`：声学雷达
   - `topo`：声纹等高线
   - `nebula`：星云弥散
   - `plain`：极简素底
   - 配套实时调节参数：`--glass-blur`（默认 `7px`，滑块范围 `0–22px`）、`--glass-alpha`、背景饱和度与覆盖度。
3. **29 + 1 套配色体系（默认 `codex`，支持 `light` / `dark` 明暗双模）**：
   - 29 套预设：`absolutely`, `ayu`, `catppuccin`, `codex`, `dracula`, `everforest`, `github`, `gruvbox`, `linear`, `lobster`, `material`, `matrix`, `monokai`, `night-owl`, `nord`, `notion`, `og`, `oscurange`, `one`, `proof`, `raycast`, `rose-pine`, `sentry`, `solarized`, `temple`, `tokyo-night`, `vercel`, `vscode-plus`, `xcode`。
   - +1 自定义面板：`custom`（支持实时取色覆盖 `--bg`、`--fg`、`--accent`）。

## 2. 四重风格控制入口（Style Lab 四重后门）

用户或开发者可通过以下四种方式切换与调试风格：

1. **设置页（Settings Modal）**：顶栏右上角点击「设置」，可视化选择 8 套质感、6 档背景、29+1 配色、明暗模式及磨砂模糊半径滑块。
2. **Style Lab 浮动面板**：
   - URL 参数 `?stylelab=1` 自动弹出浮动风格实验室；
   - 全局快捷键 `Alt + Shift + S` 随时呼出/收起；
   - 连续点击顶栏 Logo 5 次触发隐藏开发者 Style Lab 面板。
3. **URL 查询参数直达**：支持 `?style=<id>&bg=<id>&palette=<id>&theme=light|dark&blur=<n>` 在页面初始化时直接覆盖默认状态（便于分享特定风格的截图或演示链接）。
4. **控制台脚本接口 `window.__VC_STYLE__`**：
   - `window.__VC_STYLE__.listSkins()`
   - `window.__VC_STYLE__.setStyle('neumorphism' | ...)`
   - `window.__VC_STYLE__.setBackdrop('aurora' | ...)`
   - `window.__VC_STYLE__.setPalette('codex' | ...)`
   - `window.__VC_STYLE__.setTheme('light' | 'dark')`
   - `window.__VC_STYLE__.registerSkin(id, label, vars)`
   - `window.__VC_STYLE__.openLab()`
   - `window.__VC_STYLE__.reset()`

## 3. 新增风格与配色扩展规范

### 3.1 新增一套表面质感
1. 在主题样式表中新增 `:root[data-style="<new-id>"]`（以及必要时的 `[data-theme="dark"]` 覆盖块），必须完整定义 `--border-w`、`--r-ctrl`、`--r-seg`、`--ctrl-shadow`、`--ctrl-border`、`--panel-shadow` 令牌，禁止写死颜色值。
2. 在 Style Lab 与设置页注册表加入 `{ id: '<new-id>', label: '<中文名>' }`。
3. 核查在 `plain` 与 `aurora` 背景下的文字对比度（WCAG AA）及 `1080p -> 86%` 视口缩放下无边框裁切。

### 3.2 新增一套配色
1. 在 `PALETTES` 注册表中追加 `{ id, name, light: [bg, fg, accent], dark: [bg, fg, accent] }`。
2. 确保亮/暗两组配色在频谱图、声道矢状剖面与 TextGrid 音素色块上保持足够区分度，不得屏蔽 `--green` / `--red` 语义状态色。

### 3.3 硬性视觉约束
- 全界面禁用任何操作系统原生暗黑 `<select>`，统一下拉菜单必须挂载主题浮层组件（`.vc-sel`）。
- 全仓库禁用任何 UI Emoji 字符；状态图标统一使用纯矢量 SVG 或单色几何标记。
- 术语拼写必须严格使用 `轻新拟态`、`声道重建`、`刘看山`、`VoQS`、`extIPA`。
