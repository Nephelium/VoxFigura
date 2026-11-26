# Vocal Tract View (`@vocalcut/vocal-tract-view`)

零框架耦合的 2D 矢状面 / 3D 声道几何可视化独立组件包，镜像自 `PhoneticToolbox v3` 的 `embed.mjs` 渲染核心（基于 VocalTractLab 2.4 几何模型与 Three.js）。

任何第三方纯静态页面、Vue、React 或原生前端项目只需复制本目录即可独立挂载使用，无需安装任何前端框架依赖。

## 快速接入

1. 在 HTML `<head>` 中声明 `importmap`（指向同目录下的 `vendor/three.module.js`）：

```html
<script type="importmap">
  {
    "imports": {
      "three": "./vendor/three.module.js"
    }
  }
</script>
```

2. 调用 `mountVocalTract(host, options)` 挂载声道视图：

```js
import { mountVocalTract } from './embed.mjs';

const metadata = await fetch('./presentation-metadata.json').then((r) => r.json());
const view = await mountVocalTract(document.getElementById('stage'), {
  metadata,
  state: initialState,
  view: 'sagittal', // 'sagittal' (2D) | 'model' (3D)
  locale: 'zh-CN',
  pose: async (nextPose) => {
    const res = await fetch('/api/vtl/pose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nextPose),
    });
    return res.json();
  },
});
```

## 本地示例

通过任意静态 HTTP 服务器打开 `demo.html`（禁止 `file://` 直接双击，因 ES Module 需要 HTTP 协议）：

```bash
npx serve .
```

## 许可说明

本组件包衍生自 `PhoneticToolbox v3`（GPL-3.0-or-later）与 `VocalTractLab 2.4`（GPL-3.0-or-later），`vendor/three.module.js` 与 `vendor/OrbitControls.js` 遵循 MIT 许可。
