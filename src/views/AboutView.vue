<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { editionCorpusBoundary, editionDisplayLabel, editionIsolationNote, exploreLabel } from '@vocalcut/edition';
import { APP_BRAND_NAME, APP_BRAND_TAGLINE, APP_VERSION } from '@/data/app-branding';
import { workspaceIconUrl } from '@/data/workspace-images';
import { hasUpdate, latestRelease, openUpdateModal } from '@/data/app-update';
import { METHOD_REFERENCES } from '@/data/references';
import { useWorkbenchStore } from '@/stores/workbench';
import IconSvg from '@/components/common/IconSvg.vue';

const store = useWorkbenchStore();
const activeSec = ref('aboutOverview');
const aboutScrollRef = ref<HTMLElement | null>(null);

const editionLabel = editionDisplayLabel;

const NAV_ITEMS = [
  { id: 'aboutOverview', icon: 'info', label: '定位与版本形态' },
  { id: 'aboutCapabilities', icon: 'layers', label: '三大能力版图' },
  { id: 'aboutPackages', icon: 'stage', label: '工程分层与独立包' },
  { id: 'aboutPtb', icon: 'book', label: '前序开源项目 PhoneticToolbox' },
  { id: 'aboutCompliance', icon: 'shield', label: '科研红线与隐私边界' },
  { id: 'aboutCredits', icon: 'folder-open', label: `开源许可与学术引用 (${METHOD_REFERENCES.length})` },
] as const;

const CAPABILITY_CLUSTERS = [
  {
    code: 'CLUSTER 01',
    title: '发音与重建',
    modules: [
      { name: '国际音标表 Plus', desc: '655 项 IPA / extIPA / VoQS 符号，含 308 项参考录音库索引（276 份实录音频与 267 份人工精修 TextGrid）、个人实录评估与可派生构型方案。' },
      { name: '语音合成', desc: '中英日文本与 [ipa] / TextGrid 编译，支持 32 维窄标 IPA 协同构音、任意无标调 [IPA] 韵律预测与参考音色中位基频自动匹配，联调 3 阶 qTA 基频、VoQS 发声锚点、65 截面面积与传递函数图谱。' },
      { name: '声道动态重建', desc: '端侧 50 Hz 27 维联合反演与双语强制对齐，同步矢状面、喉镜与声带冠状面三视图，支持摄像头 MediaPipe 三维透视人头-声道联合重建与 SenseVoice-Small (ONNX) 离线转写。' },
    ],
  },
  {
    code: 'CLUSTER 02',
    title: '调控与实验',
    modules: [
      { name: '发声调音台', desc: '基于 20–1200 Hz 宽域声门—声道—声纹解耦表征，支持单人时变发声类型曲线调制与双人多器官属性迁移。' },
      { name: '声道连续统', desc: '支持单轴/双轴（默认 20 格）阻音保护生理连续统矩阵制作，并内置 550–800 Hz 持续元音高音移调试听。' },
      { name: '发音字典管理', desc: '维护高于内置词典优先级的个人词条、10 套汉语注音标准、手绘五度方言调型及三类非递归连读变调规则。' },
    ],
  },
  {
    code: 'CLUSTER 03',
    title: '编曲与出版',
    modules: [
      { name: '声乐编曲台', desc: '通用键盘简谱、强弱力度肺压映射、钢琴卷帘微调、辅音抢拍（韵核精准踩拍）、数字波导伴奏与改音高保留咬字演唱。' },
      { name: '非线性剪辑', desc: 'V0–V3 多子轨画面图层与 A1–A12 人声 / A3 伴奏混音轨同轴编辑，支持逐字高亮双行字幕（汉字 + IPA）与成片视频导出。' },
      { name: '发音卡工坊', desc: '响应式自由分栏拖拽排版声学图表，浏览器本地生成高清 PNG 或调用代理导出 MP4/GIF 动卡。' },
    ],
  },
] as const;

const ARCHITECTURE_PACKAGES = [
  {
    pkg: 'packages/core-ts/',
    role: '纯函数声学与编曲内核',
    detail:
      '48,000 Hz 整数采样与半开区间 [start_smp, end_smp)、3 阶临界阻尼 qTA、辅音抢拍调度、VoQS 锚点、RFC 6902 命令总线、Praat TextGrid 读写、连续统及非递归方言变调。',
  },
  {
    pkg: 'packages/g2p-ts/',
    role: '多语文本转 IPA 与简谱解析包',
    detail:
      '封装 10 套汉语注音标准（含 UntPhesoca 宽/严式）、CMUdict 英语词典、日语假名读音与通用键盘简谱解析，完全脱离前端框架耦合。',
  },
  {
    pkg: 'packages/vocal-tract-view/',
    role: '2D / 3D 声道几何独立视口包',
    detail:
      '零框架耦合提供 mountVocalTract 接口（支持无 WebGL 2D 矢状面与 JD2 3D 头颈模型），附带 demo.html 与 manifest.json，可独立嵌入外部教学或科研网页。',
  },
  {
    pkg: 'packages/model-adapters/ + engine/',
    role: '物理求解与本地 ONNX 推理服务',
    detail:
      '统一桥接 VocalTractLab 2.4 原生声管引擎与 8 项核心纯 ONNX Runtime 本地推理模型（零 PyTorch 运行时依赖），执行严格物理量纲边界校验、端侧推理与热插拔外置换模。',
  },
] as const;

const PTB_TOOL_GROUPS = [
  { area: '分析与采集（6 工具）', items: '任务录音、唇形提取、批量参数估计、多轨参数显示、EGG 喉电图信号分析、局部 LPC 频谱图' },
  { area: '合成与操控（5 工具）', items: 'Klatt 声学参数合成、生理参数声道合成、发声类型连续统合成、变速变调（PSOLA）、语谱图转音频' },
  { area: '标注与实验（6 工具）', items: '国际音标表 Plus、汉字转国际音标、MFA 自动强制对齐、TextGrid 多层标注、田野音系归纳、感知实验设计' },
  { area: '文献与地理（2 工具）', items: '语音学论文精读（译读批注）、中国省市县方言语言地图与多地对比研究' },
] as const;

const PTB_LINKS = [
  {
    label: 'PhoneticToolbox 官方网站',
    href: 'https://www.phonetictoolbox.com/',
    desc: '获取 Windows 安装版 / 免安装版、macOS Apple Silicon 测试版与版本更新记录',
    tag: '官网',
  },
  {
    label: 'GitHub 开源代码仓库',
    href: 'https://github.com/Nephelium/PhoneticToolbox',
    desc: '查阅 v3 主线源码、19 个独立模块文档、科学方法说明与开发指南',
    tag: 'GitHub',
  },
  {
    label: 'GitHub Releases 发行档案',
    href: 'https://github.com/Nephelium/PhoneticToolbox/releases',
    desc: '浏览 3.1.3 正式版与全部历史发行包，便于对照复现实验环境',
    tag: 'Releases',
  },
] as const;

const SCIENTIFIC_REDLINES = [
  '控制基频（F0_ctl）不等同于实测输出音频基频，两路轨迹分开标注。',
  '声管传递函数 H(f) 极点频率不等同于输出音频的 LPC 实测共振峰。',
  '声道动态重建轨迹是满足解剖边界的模型候选解，不等同于真实生理舌位。',
  '60 fps 视觉插值动画帧不等同于 50 Hz / 200 Hz 原生求解控制帧。',
  'VTL 2.4 物理管段合成音频与 Tract2Vox-Lite 神经声码器音频始终保留独立来源标识。',
  '局部区间试听会重新初始化声管状态，不等同于整句连续协同定稿渲染。',
] as const;

const LICENSE_LAYERS = [
  { scope: '主工程与独立核心包', license: 'GPL-3.0-or-later', detail: '含前端工作台、Node 代理、core-ts / g2p-ts / vocal-tract-view 与 VTL 2.4 桥接代码' },
  { scope: '专用音标与界面字体', license: 'SIL OFL 1.1', detail: 'PTBIPAPlus、Doulos SIL、Noto Sans/Serif SC、Inter、Lora 与 JetBrains Mono 随 public/fonts/ 同原许可文本分发' },
  {
    scope: exploreLabel ? '前端渲染与数学排版' : '前端渲染与推理组件',
    license: 'MIT / Apache-2.0 / BSD-2-Clause',
    detail: exploreLabel
      ? 'Three.js / KaTeX / SwiftF0 (MIT)，DPDFNet / MediaPipe / SenseVoice (Apache-2.0)，CMUdict (BSD-2-Clause)'
      : 'Three.js / SwiftF0 (MIT)，DPDFNet / MediaPipe / SenseVoice (Apache-2.0)，CMUdict (BSD-2-Clause)',
  },
  { scope: '语料与版本素材边界', license: '原语料协议 / 版本授权', detail: editionCorpusBoundary },
] as const;

function scrollToId(id: string): void {
  activeSec.value = id;
  const scroller = aboutScrollRef.value;
  if (!scroller) return;
  const target = scroller.querySelector<HTMLElement>(`#${id}`);
  if (!target) return;
  const scrollerRect = scroller.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const top = scroller.scrollTop + (targetRect.top - scrollerRect.top) - 14;
  scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

let scrollRaf = 0;
function onAboutScroll(): void {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const scroller = aboutScrollRef.value;
    if (!scroller) return;
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
      activeSec.value = NAV_ITEMS[NAV_ITEMS.length - 1].id;
      return;
    }
    const topEdge = scroller.getBoundingClientRect().top;
    let current = NAV_ITEMS[0].id as string;
    for (const item of NAV_ITEMS) {
      const el = scroller.querySelector<HTMLElement>(`#${item.id}`);
      if (el && el.getBoundingClientRect().top - topEdge <= 96) {
        current = item.id;
      }
    }
    activeSec.value = current;
  });
}

onBeforeUnmount(() => {
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
});
</script>

<template>
  <div class="settings-view">
    <!-- Left Navigation -->
    <aside class="set-nav">
      <button
        type="button"
        class="btn primary"
        style="margin-bottom: 8px; justify-content: flex-start"
        @click="store.closeOverlay()"
      >
        <IconSvg name="arrow-left" :size="13" />
        <span>返回工作台 (Esc)</span>
      </button>
      <div class="about-nav-caption">关于 {{ APP_BRAND_NAME }}</div>
      <button
        v-for="item in NAV_ITEMS"
        :key="item.id"
        type="button"
        class="btn nav-sub-btn"
        :class="{ active: activeSec === item.id }"
        @click="scrollToId(item.id)"
      >
        <IconSvg :name="item.icon" :size="13" />
        <span>{{ item.label }}</span>
      </button>

      <div class="about-nav-footer">
        <button type="button" class="btn sm" style="width: 100%" @click="store.openOverlay('guide')">
          <IconSvg name="book" :size="12" />
          <span>系统使用说明</span>
        </button>
        <button type="button" class="btn sm" style="width: 100%" @click="store.openOverlay('model-report')">
          <IconSvg name="cpu" :size="12" />
          <span>模型训练与技术报告</span>
        </button>
        <button type="button" class="btn sm" style="width: 100%" @click="store.openOverlay('settings', 'engine')">
          <IconSvg name="sliders" :size="12" />
          <span>引擎与模型管理</span>
        </button>
      </div>
    </aside>

    <!-- Right Content -->
    <section ref="aboutScrollRef" class="set-content" @scroll="onAboutScroll">
      <div class="set-full-pane about-pane">
        <!-- 1. Identity, Motivation & Editions -->
        <div id="aboutOverview" class="panel">
          <div class="p-head">
            <span>关于 {{ APP_BRAND_NAME }} · {{ APP_BRAND_TAGLINE }}</span>
            <span class="tree-tag mono">v{{ APP_VERSION }} · GPL-3.0-or-later</span>
          </div>
          <div class="p-body about-body">
            <div class="editorial-card about-hero-card selectable">
              <div class="about-hero-top">
                <strong class="about-brand">
                  <img :src="workspaceIconUrl" width="28" height="28" alt="" />
                  {{ APP_BRAND_NAME }}
                </strong>
                <div class="about-meta-chips">
                  <span class="metric-chip mono">当前形态：{{ editionLabel }}</span>
                  <span class="metric-chip mono">采样标准：48,000 Hz 整数采样</span>
                </div>
              </div>
              <p class="muted about-p">
                {{ APP_BRAND_NAME }} 是一款面向语言学与实验语音学研究、声乐教学及语音科普创作者的物理声道驱动工作台。它将原本分散在声道仿真器、Praat 标注、神经声码器与非线性音视频剪辑之间的工作流程整合入同一工程文件（<code class="mono">.vcproj</code>）内，既可从实录语音反演 27 维声道与发声动力学轨迹，也可由文本、国际音标与键盘简谱驱动物理及神经双通道合成。
              </p>
              <div class="about-portal-row">
                <button type="button" class="btn sm primary" @click="store.openOverlay('guide')">
                  <IconSvg name="book" :size="13" />
                  <span>操作步骤与实时演示 → 使用说明</span>
                </button>
                <button type="button" class="btn sm" @click="store.openOverlay('model-report')">
                  <IconSvg name="cpu" :size="13" />
                  <span>模型架构、32 维特征与评测 → 技术报告</span>
                </button>
                <button type="button" class="btn sm" @click="store.openOverlay('settings', 'engine')">
                  <IconSvg name="sliders" :size="13" />
                  <span>模型装卸与算力配置 → 设置中心</span>
                </button>
                <button
                  type="button"
                  class="btn sm"
                  :class="{ primary: hasUpdate }"
                  @click="openUpdateModal(true)"
                >
                  <IconSvg :name="hasUpdate ? 'sparkles' : 'download'" :size="13" />
                  <span>
                    {{ hasUpdate && latestRelease ? `发现新版本 v${latestRelease.version}` : '检查更新' }}
                  </span>
                </button>
              </div>
            </div>

            <div class="editorial-card selectable" style="box-shadow: none; gap: 6px">
              <strong>三版本构建隔离设计</strong>
              <p class="muted about-p">
                {{ editionIsolationNote }}
              </p>
            </div>
          </div>
        </div>

        <!-- 2. Capabilities Overview -->
        <div id="aboutCapabilities" class="panel">
          <div class="p-head">
            <span>工作台核心能力版图（九大公共模块协同）</span>
            <span class="tree-tag mono">Phonetics · Experiments · Studio</span>
          </div>
          <div class="p-body about-body">
            <div class="about-cluster-grid selectable">
              <div v-for="cl in CAPABILITY_CLUSTERS" :key="cl.code" class="editorial-card about-cluster-card">
                <div class="about-cluster-head">
                  <strong>{{ cl.title }}</strong>
                  <span class="tree-tag mono">{{ cl.code }}</span>
                </div>
                <div v-for="mod in cl.modules" :key="mod.name" class="about-mod-item">
                  <strong>{{ mod.name }}</strong>
                  <p class="muted">{{ mod.desc }}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 3. Headless-First Architecture Packages -->
        <div id="aboutPackages" class="panel">
          <div class="p-head">
            <span>零 UI 耦合工程分层与独立组件包</span>
            <span class="tree-tag mono">Headless-First · Modular</span>
          </div>
          <div class="p-body about-body">
            <div class="settings-grid-2 selectable">
              <div v-for="item in ARCHITECTURE_PACKAGES" :key="item.pkg" class="editorial-card about-pillar-card">
                <div class="about-cluster-head">
                  <strong>{{ item.role }}</strong>
                  <span class="tree-tag mono">{{ item.pkg }}</span>
                </div>
                <p class="muted about-p">{{ item.detail }}</p>
              </div>
            </div>
          </div>
        </div>

        <!-- 4. Prior Open-Source Project: PhoneticToolbox -->
        <div id="aboutPtb" class="panel">
          <div class="p-head">
            <span>前序开源项目 · PhoneticToolbox（语音学工具箱 v3）</span>
            <span class="tree-tag mono">19 个语音学工具 · 同源生态</span>
          </div>
          <div class="p-body about-body">
            <div class="editorial-card ptb-feature-card selectable">
              <div class="about-cluster-head">
                <strong style="font-size: 1.04rem">同源生态与功能互补</strong>
                <span class="mono muted" style="font-size: 0.85rem">作者：井立文 · 正式版 3.1.3</span>
              </div>
              <p class="muted about-p">
                <strong>PhoneticToolbox（语音学工具箱）</strong>是由作者开发的桌面实验语音学平台（Vue 3 + PyQt6 / Qt WebEngine），集成录音采集、声学参数分析、语音合成、标注实验、论文精读与中国方言地图等 19 个高频工具，支持 Windows x64 与 macOS Apple Silicon。
              </p>
              <p class="muted about-p">
                {{ APP_BRAND_NAME }} 沿用了 PhoneticToolbox 的国际音标表 Plus（655 项体系）、汉语注音与 UntPhesoca 宽式映射、2D/3D 声道几何组件及 PTBIPAPlus 字体，并在此基础上拓展出端侧 27 维声道动态反演、协同动腔规划、双人器官迁移与视听声乐编曲工作流。若你的研究需要 EGG 喉电图分析、Klatt 合成、批量参数提取或田野音系归纳，推荐搭配 PhoneticToolbox 使用。
              </p>

              <div class="ptb-tool-grid">
                <div v-for="g in PTB_TOOL_GROUPS" :key="g.area" class="ptb-tool-box">
                  <strong>{{ g.area }}</strong>
                  <span class="muted">{{ g.items }}</span>
                </div>
              </div>

              <div class="ptb-links-grid">
                <a
                  v-for="lnk in PTB_LINKS"
                  :key="lnk.href"
                  :href="lnk.href"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="ptb-link-card"
                >
                  <div class="ptb-link-top">
                    <strong>{{ lnk.label }}</strong>
                    <span class="tree-tag mono">{{ lnk.tag }} ↗</span>
                  </div>
                  <span class="mono ptb-link-url">{{ lnk.href }}</span>
                  <span class="muted ptb-link-desc">{{ lnk.desc }}</span>
                </a>
              </div>
            </div>
          </div>
        </div>

        <!-- 5. Scientific Redlines & Privacy Boundary -->
        <div id="aboutCompliance" class="panel">
          <div class="p-head">
            <span>科研可信度边界、数据规范与隐私声明</span>
            <span class="tree-tag mono">Auditable · Local-First</span>
          </div>
          <div class="p-body about-body">
            <div class="settings-grid-2 selectable">
              <div class="editorial-card about-pillar-card">
                <strong>六组声学口径严格区分</strong>
                <ol class="about-ol">
                  <li v-for="(line, i) in SCIENTIFIC_REDLINES" :key="i">{{ line }}</li>
                </ol>
              </div>
              <div class="editorial-card about-pillar-card">
                <strong>量纲守卫、离线计算与凭据边界</strong>
                <p class="muted about-p">
                  所有物理控制边界（正基频 F0 > 0 Hz，其中 VTL 2.4 物理声门保留 40–600 Hz 硬件边界，神经声码器通道支持 20–1200 Hz 宽域基频；声门下压 0–1600 Pa；17/19 维声道；8 维声门与塞音闭塞刚性下限）一律遵循越界即拒绝原则，返回合法范围提示而不做静默截断。
                </p>
                <p class="muted about-p">
                  物理求解、声道反演、转写对齐与降噪均在用户本机执行，不向外部上传用户录音；在右上角 AI 助手抽屉的模型连接设置中可选填第三方大模型或语音识别 API Key，仅驻留于当前会话内存，不写入代码、工程文件或磁盘日志。
                </p>
              </div>
            </div>
          </div>
        </div>

        <!-- 6. Multi-layer Licenses & Academic Citations -->
        <div id="aboutCredits" class="panel">
          <div class="p-head">
            <span>多层开源许可构成与学术文献引用（{{ METHOD_REFERENCES.length }} 条）</span>
            <span class="tree-tag mono">GB/T 7714 Ready</span>
          </div>
          <div class="p-body about-body">
            <div class="editorial-card selectable" style="box-shadow: none; overflow-x: auto">
              <table class="mini-tbl about-tbl">
                <thead>
                  <tr>
                    <th>组成部分</th>
                    <th>适用许可</th>
                    <th>说明与归属范围</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="lic in LICENSE_LAYERS" :key="lic.scope">
                    <td><strong>{{ lic.scope }}</strong></td>
                    <td><span class="tree-tag mono">{{ lic.license }}</span></td>
                    <td class="muted">{{ lic.detail }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="editorial-card selectable" style="box-shadow: none; gap: 8px">
              <p class="muted about-p">
                本项目依托 VocalTractLab 2.4（Peter Birkholz 等）、PhoneticToolbox v3、Ball / Esling / Dickson (2018) VoQS 体系、Prom-on et al. (2009) qTA 模型、Praat / Parselmouth、SwiftF0、DPDFNet、MediaPipe、Three.js、ECharts 与 CMUdict 等研究成果与开源项目构建。文献、来源链接与已登记的许可信息可在下方弹窗查阅并复制。
              </p>
              <div>
                <button type="button" class="btn primary sm" @click="store.referencesModalOpen.value = true">
                  <IconSvg name="book" :size="13" />
                  <span>查阅全部 {{ METHOD_REFERENCES.length }} 条学术引用与开源致谢</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.about-nav-caption {
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--muted);
  padding: 4px 8px 2px;
  letter-spacing: 0.02em;
}

.nav-sub-btn {
  justify-content: flex-start;
  text-align: left;
  gap: 7px;
  min-height: 31px;
}

.set-nav .nav-sub-btn:not(.active) {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}

.about-nav-footer {
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px solid var(--panel-border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.about-pane {
  max-width: 1360px;
  margin: 0 auto;
  padding-bottom: 28px;
}

.about-body {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.about-hero-card {
  border-left: 3px solid var(--accent);
  box-shadow: none;
  gap: 8px;
}

.about-hero-top,
.about-cluster-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.about-meta-chips,
.about-portal-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.about-brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 1.12rem;
}

.about-cluster-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 10px;
}

.about-cluster-card,
.about-pillar-card {
  box-shadow: none;
  gap: 8px;
}

.about-mod-item {
  padding-top: 6px;
  border-top: 1px dashed var(--panel-border);
  font-size: 0.9rem;
  line-height: 1.56;
}

.about-mod-item p {
  margin: 2px 0 0;
}

.about-p {
  margin: 0;
  font-size: 0.935rem;
  line-height: 1.66;
}

.ptb-feature-card {
  border-left: 3px solid var(--accent);
  box-shadow: none;
  gap: 10px;
}

.ptb-tool-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 8px;
}

.ptb-tool-box {
  padding: 8px 10px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 55%, var(--panel));
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 0.88rem;
  line-height: 1.5;
}

.ptb-links-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 10px;
  margin-top: 2px;
}

.ptb-link-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  text-decoration: none;
  color: var(--text);
  transition: border-color 150ms ease, background-color 150ms ease, transform 150ms ease;
}

.ptb-link-card:hover {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--selected) 45%, var(--ctrl-bg));
  transform: translateY(-1px);
}

.ptb-link-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 0.96rem;
}

.ptb-link-url {
  font-size: 0.82rem;
  color: var(--accent);
  word-break: break-all;
}

.ptb-link-desc {
  font-size: 0.85rem;
  line-height: 1.5;
}

.about-tbl th,
.about-tbl td {
  padding: 6px 9px;
  font-size: 0.9rem;
}

.about-ol {
  margin: 4px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.91rem;
  line-height: 1.6;
  color: var(--muted);
}
</style>
