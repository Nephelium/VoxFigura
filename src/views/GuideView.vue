<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { EChartsCoreOption } from 'echarts/core';
import { APP_BRAND_NAME } from '@/data/app-branding';
import {
  ALL_GUIDE_MODULES,
  GUIDE_SHARED_APPENDICES,
  GUIDE_SYSTEM_OVERVIEW,
  SHORTCUT_GROUPS,
  VOQS_14_LIST,
} from '@/data/guide-content';
import {
  clearAllGuideDemoCache,
  getGuideDemoCacheStats,
  guideDemoCacheTick,
} from '@/data/guide-demo-cache';
import { useWorkbenchStore } from '@/stores/workbench';
import IconSvg from '@/components/common/IconSvg.vue';
import TechChart, { type ChartThemeTokens } from '@/components/charts/TechChart.vue';
import GuideModuleArticle from '@/components/guide/GuideModuleArticle.vue';

const store = useWorkbenchStore();
const activeSec = ref<string>(GUIDE_SYSTEM_OVERVIEW.id);
const guideScrollRef = ref<HTMLElement | null>(null);
const cacheStats = ref<{ count: number; totalBytes: number; cachedIds: string[] }>({
  count: 0,
  totalBytes: 0,
  cachedIds: [],
});
const clearingCache = ref(false);

const allAnchorIds = [
  GUIDE_SYSTEM_OVERVIEW.id,
  ...ALL_GUIDE_MODULES.map((m) => m.sectionAnchor),
  ...GUIDE_SHARED_APPENDICES.map((s) => s.id),
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function refreshCacheStats(): Promise<void> {
  cacheStats.value = await getGuideDemoCacheStats();
}

async function onClearAllCache(): Promise<void> {
  clearingCache.value = true;
  try {
    await clearAllGuideDemoCache();
    await refreshCacheStats();
    store.pushToast('已清空全部使用说明演示缓存', 'info', 2200);
  } finally {
    clearingCache.value = false;
  }
}

function scrollToSec(id: string, behavior: ScrollBehavior = 'smooth'): void {
  activeSec.value = id;
  const scroller = guideScrollRef.value;
  if (!scroller) return;
  const target = scroller.querySelector<HTMLElement>(`#${id}`);
  if (!target) return;
  const scrollerRect = scroller.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const top = scroller.scrollTop + (targetRect.top - scrollerRect.top) - 14;
  scroller.scrollTo({ top: Math.max(0, top), behavior });
}

let scrollRaf = 0;
function onScroll(): void {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const scroller = guideScrollRef.value;
    if (!scroller) return;
    const scrollerTop = scroller.getBoundingClientRect().top;
    let current = allAnchorIds[0];
    for (const id of allAnchorIds) {
      const el = scroller.querySelector<HTMLElement>(`#${id}`);
      if (!el) continue;
      if (el.getBoundingClientRect().top - scrollerTop <= 96) {
        current = id;
      }
    }
    activeSec.value = current;
  });
}

function consumeTargetAnchor(): void {
  const target = store.guideTargetSection.value;
  if (!target) return;
  store.guideTargetSection.value = null;
  void nextTick(() => {
    requestAnimationFrame(() => scrollToSec(target, 'auto'));
  });
}

watch(guideDemoCacheTick, () => {
  void refreshCacheStats();
});

watch(
  () => store.guideTargetSection.value,
  () => consumeTargetAnchor(),
);

onMounted(() => {
  void refreshCacheStats();
  consumeTargetAnchor();
});

onBeforeUnmount(() => {
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
});

function buildVoqsScaleChart(t: ChartThemeTokens): EChartsCoreOption {
  const degrees = ['常态 (无标记)', '1 度 {1...1}', '2 度 {2...2} (默认)', '3 度 {3...3}'];
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: t.tooltipBg,
      borderColor: t.border,
      textStyle: { color: t.text, fontSize: 12 },
    },
    legend: { top: 6, left: 'center', icon: 'roundRect', itemWidth: 14, itemHeight: 8, itemGap: 16, textStyle: { color: t.muted, fontSize: 11 } },
    grid: { left: 56, right: 62, top: 72, bottom: 36 },
    xAxis: {
      type: 'category',
      data: degrees,
      axisLabel: { color: t.muted, fontSize: 11, interval: 0 },
      axisLine: { lineStyle: { color: t.border } },
    },
    yAxis: [
      {
        type: 'value',
        name: '声门混合度 (%)',
        nameGap: 14,
        max: 120,
        nameTextStyle: { color: t.muted, fontSize: 11, align: 'left', padding: [0, 0, 0, -24] },
        axisLabel: { color: t.muted, fontSize: 11, formatter: '{value}%' },
        splitLine: { lineStyle: { color: t.gridLine } },
      },
      {
        type: 'value',
        name: '喉高偏移 |ΔHY| (cm)',
        nameGap: 14,
        max: 1.05,
        nameTextStyle: { color: t.muted, fontSize: 11, align: 'right', padding: [0, -24, 0, 0] },
        axisLabel: { color: t.muted, fontSize: 11, formatter: '±{value}' },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '声门发声态混合度（V̤/V͈/V̰/F 等）',
        type: 'bar',
        barMaxWidth: 34,
        itemStyle: { color: t.series[0], borderRadius: [5, 5, 0, 0] },
        label: { show: true, position: 'top', color: t.text, fontSize: 11, formatter: '{c}%' },
        data: [0, 35, 70, 100],
      },
      {
        name: '喉位垂直偏移幅度（L̝ / L̞）',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbolSize: 9,
        lineStyle: { width: 2.6, color: t.series[2] },
        itemStyle: { color: t.series[2] },
        label: { show: true, position: 'top', color: t.series[2], fontSize: 11, formatter: '±{c} cm' },
        data: [0, 0.2, 0.5, 0.8],
      },
    ],
  };
}
</script>

<template>
  <div class="settings-view">
    <!-- Left Grouped Directory Navigation -->
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

      <div class="guide-nav-caption">系统使用说明</div>
      <button
        type="button"
        class="btn guide-nav-btn"
        :class="{ active: activeSec === GUIDE_SYSTEM_OVERVIEW.id }"
        @click="scrollToSec(GUIDE_SYSTEM_OVERVIEW.id)"
      >
        <IconSvg :name="GUIDE_SYSTEM_OVERVIEW.icon" :size="13" />
        <span>{{ GUIDE_SYSTEM_OVERVIEW.nav }}</span>
      </button>

      <div class="guide-nav-caption">各模块专题与交互演示 ({{ ALL_GUIDE_MODULES.length }})</div>
      <button
        v-for="(mod, idx) in ALL_GUIDE_MODULES"
        :key="mod.id"
        type="button"
        class="btn guide-nav-btn"
        :class="{ active: activeSec === mod.sectionAnchor }"
        @click="scrollToSec(mod.sectionAnchor)"
      >
        <IconSvg :name="mod.icon" :size="13" />
        <span>{{ idx + 1 }}. {{ mod.navTitle }}</span>
      </button>

      <div class="guide-nav-caption">跨模块语法与规范</div>
      <button
        v-for="sec in GUIDE_SHARED_APPENDICES"
        :key="sec.id"
        type="button"
        class="btn guide-nav-btn"
        :class="{ active: activeSec === sec.id }"
        @click="scrollToSec(sec.id)"
      >
        <IconSvg :name="sec.icon" :size="13" />
        <span>{{ sec.nav }}</span>
      </button>

      <div class="guide-nav-footer">
        <button type="button" class="btn sm" style="width: 100%" @click="store.openOverlay('model-report')">
          <IconSvg name="cpu" :size="13" />
          <span>模型训练与技术报告</span>
        </button>
        <button type="button" class="btn sm" style="width: 100%" @click="store.openOverlay('settings', 'engine')">
          <IconSvg name="sliders" :size="13" />
          <span>本地 ONNX 模型矩阵</span>
        </button>
      </div>
    </aside>

    <!-- Right Integrated Manual Body -->
    <section ref="guideScrollRef" class="set-content" @scroll="onScroll">
      <div class="set-full-pane guide-pane">
        <!-- Hero & Cache Control Strip -->
        <div class="panel guide-hero">
          <div class="p-head">
            <span>{{ APP_BRAND_NAME }} · 系统整合使用说明与交互案例手册</span>
            <span class="mono muted" style="font-size: 0.875rem">零外置视频截图 · 本机实时合成 · IndexedDB 持久化缓存</span>
          </div>
          <div class="p-body" style="padding: 14px; display: flex; flex-direction: column; gap: 10px">
            <div class="guide-callout note">
              <IconSvg name="info" :size="16" />
              <div>
                <strong>全工作台说明书导读</strong>
                <p>
                  本手册整合了{{ APP_BRAND_NAME }}全部功能模块的使用说明（也可在各工作区顶栏点击「使用说明」单独呼出对应章节）。语音合成、音标表、声道重建、调音台、连续统、发音字典与发音卡以实验语音学视角为主；编曲与剪辑以音乐制作及音视频创作为视角编写。所有演示案例均由本机内核与声道引擎现场演算，并自动存入浏览器缓存供随时复看。
                </p>
              </div>
            </div>

            <div class="cache-strip">
              <div class="cache-info mono">
                <IconSvg name="cpu" :size="14" />
                <span>
                  本机演示缓存：已保留 <strong>{{ cacheStats.count }}</strong> 个模块结果（约 {{ formatBytes(cacheStats.totalBytes) }}）
                </span>
              </div>
              <button
                type="button"
                class="btn xs"
                :disabled="clearingCache || cacheStats.count === 0"
                @click="onClearAllCache"
              >
                <IconSvg name="trash" :size="12" />
                <span>清空全部演示缓存</span>
              </button>
            </div>
          </div>
        </div>

        <!-- System Overview Chapter -->
        <article :id="GUIDE_SYSTEM_OVERVIEW.id" class="panel guide-chapter">
          <header class="p-head">
            <div style="display: flex; align-items: center; gap: 8px; min-width: 0">
              <IconSvg :name="GUIDE_SYSTEM_OVERVIEW.icon" :size="15" />
              <span>{{ GUIDE_SYSTEM_OVERVIEW.title }}</span>
            </div>
            <span class="tree-tag mono">{{ GUIDE_SYSTEM_OVERVIEW.code }}</span>
          </header>

          <div class="p-body guide-chapter-body">
            <p class="guide-lead selectable">{{ GUIDE_SYSTEM_OVERVIEW.lead }}</p>

            <div class="guide-svg-box">
              <div class="param-sec-title">
                <span>工作台模块数据互通拓扑（共享 48,000 Hz .vcproj 工程）</span>
                <span class="mono muted">System Dataflow</span>
              </div>
              <svg class="guide-flow-svg" viewBox="0 0 980 182" role="img" aria-label="工作台数据互通图">
                <defs>
                  <marker id="gArr" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="currentColor" />
                  </marker>
                </defs>
                <rect x="14" y="16" width="176" height="60" rx="8" class="g-node accent" />
                <text x="102" y="40" class="g-title">文本 / IPA / TextGrid</text>
                <text x="102" y="59" class="g-sub">语音合成 · G2P · 韵律模型</text>

                <rect x="14" y="102" width="176" height="60" rx="8" class="g-node accent" />
                <text x="102" y="126" class="g-title">实录录音 / 音频导入</text>
                <text x="102" y="145" class="g-sub">声道动态重建 · ASR 对齐</text>

                <rect x="242" y="16" width="190" height="60" rx="8" class="g-node" />
                <text x="337" y="40" class="g-title">国际音标表 Plus &amp; 字典</text>
                <text x="337" y="59" class="g-sub">655 入口 · 构型方案 · 目标帧</text>

                <rect x="242" y="102" width="190" height="60" rx="8" class="g-node" />
                <text x="337" y="126" class="g-title">发声调音台（发声与迁移）</text>
                <text x="337" y="145" class="g-sub">时变 VoQS · 双人器官移植</text>

                <rect x="484" y="16" width="196" height="60" rx="8" class="g-node" />
                <text x="582" y="40" class="g-title">声道连续统与发音字典</text>
                <text x="582" y="59" class="g-sub">20 格刺激 · 高音试听 · 变调</text>

                <rect x="484" y="102" width="196" height="60" rx="8" class="g-node" />
                <text x="582" y="126" class="g-title">声乐编曲台</text>
                <text x="582" y="145" class="g-sub">键盘简谱 · 卷帘 · 抢拍改音高</text>

                <rect x="734" y="34" width="232" height="114" rx="10" class="g-node primary" />
                <text x="850" y="64" class="g-title">双通道求解与剪辑成片</text>
                <text x="850" y="86" class="g-sub">VTL 2.4 (48 kHz) / Tract2Vox-Lite</text>
                <text x="850" y="106" class="g-sub">剪辑 V0–V3 图层 / A1–A4 音轨</text>
                <text x="850" y="126" class="g-sub">WAV · TextGrid · PitchTier · CSV · MP4</text>

                <path d="M 190 46 L 238 46" class="g-arrow" marker-end="url(#gArr)" />
                <path d="M 190 132 L 238 132" class="g-arrow" marker-end="url(#gArr)" />
                <path d="M 190 118 L 238 60" class="g-arrow dashed" marker-end="url(#gArr)" />
                <path d="M 432 46 L 480 46" class="g-arrow" marker-end="url(#gArr)" />
                <path d="M 432 132 L 480 132" class="g-arrow" marker-end="url(#gArr)" />
                <path d="M 680 46 L 730 74" class="g-arrow" marker-end="url(#gArr)" />
                <path d="M 680 132 L 730 108" class="g-arrow" marker-end="url(#gArr)" />
              </svg>
            </div>

            <div class="guide-points">
              <div v-for="(item, idx) in GUIDE_SYSTEM_OVERVIEW.bullets" :key="idx" class="editorial-card guide-point-card selectable">
                <div class="guide-point-head">
                  <span class="mono guide-idx">{{ String(idx + 1).padStart(2, '0') }}</span>
                  <strong>{{ item.head }}</strong>
                </div>
                <p>{{ item.body }}</p>
              </div>
            </div>
          </div>
        </article>

        <!-- All Individual Modules Integrated (Same Single Source of Truth + Live Demos) -->
        <GuideModuleArticle
          v-for="mod in ALL_GUIDE_MODULES"
          :key="mod.id"
          :module="mod"
        />

        <!-- Shared Cross-Module Appendices -->
        <article v-for="s in GUIDE_SHARED_APPENDICES" :id="s.id" :key="s.id" class="panel guide-chapter">
          <header class="p-head">
            <div style="display: flex; align-items: center; gap: 8px; min-width: 0">
              <IconSvg :name="s.icon" :size="15" />
              <span>{{ s.title }}</span>
            </div>
            <span class="tree-tag mono">{{ s.code }}</span>
          </header>

          <div class="p-body guide-chapter-body">
            <p class="guide-lead selectable">{{ s.lead }}</p>

            <div class="guide-points">
              <div v-for="(item, idx) in s.bullets" :key="idx" class="editorial-card guide-point-card selectable">
                <div class="guide-point-head">
                  <span class="mono guide-idx">{{ String(idx + 1).padStart(2, '0') }}</span>
                  <strong>{{ item.head }}</strong>
                </div>
                <p>{{ item.body }}</p>
              </div>
            </div>

            <TechChart
              v-if="s.chartKey === 'voqsScale'"
              title="VoQS 标量度 1 / 2 / 3 参数映射速查图"
              subtitle="发声类型混合权重（%）与喉位垂直偏移量（±cm）逐级对应关系"
              badge="Ball et al. 2018"
              :height="285"
              :option-builder="buildVoqsScaleChart"
              caption="省略标量数字（如 {V̤ ... V̤}）时默认采用 2 度（70% 声门混合 / ±0.50 cm 喉高偏移），离开闭合花括号后自动平滑恢复常态浊声。"
            />

            <div v-if="s.showVoqsBadges" class="voqs-grid-box selectable">
              <div class="param-sec-title">
                <span>系统已完成 50 Hz 实录标定的 14 类 VoQS 符号全清单</span>
                <span class="mono muted">voqs-recordings.json</span>
              </div>
              <div class="voqs-badge-grid">
                <div v-for="v in VOQS_14_LIST" :key="v.sym" class="voqs-chip-card">
                  <span class="ipa voqs-sym">{{ v.sym }}</span>
                  <div class="voqs-meta">
                    <strong>{{ v.name }}</strong>
                    <span class="muted">{{ v.group }}</span>
                    <span class="muted voqs-phys">{{ v.physics }}</span>
                  </div>
                </div>
              </div>
            </div>

            <div v-for="tbl in s.tables" :key="tbl.caption" class="guide-table-wrap selectable">
              <div class="param-sec-title">
                <span>{{ tbl.caption }}</span>
                <span class="mono muted">{{ tbl.tag }}</span>
              </div>
              <table class="mini-tbl guide-tbl">
                <thead>
                  <tr>
                    <th v-for="h in tbl.headers" :key="h">{{ h }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, rIdx) in tbl.rows" :key="rIdx">
                    <td><strong>{{ row[0] }}</strong></td>
                    <td><code class="mono guide-code">{{ row[1] }}</code></td>
                    <td class="muted">{{ row[2] }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-if="s.showShortcutGroups" class="guide-shortcuts-grid selectable">
              <div v-for="grp in SHORTCUT_GROUPS" :key="grp.title" class="editorial-card guide-sc-card">
                <strong>{{ grp.title }}</strong>
                <div v-for="row in grp.rows" :key="row[0]" class="guide-sc-row">
                  <span class="muted">{{ row[0] }}</span>
                  <kbd class="mono guide-kbd">{{ row[1] }}</kbd>
                </div>
              </div>
            </div>

            <div v-if="s.actionButton" style="display: flex; gap: 8px; flex-wrap: wrap">
              <button
                type="button"
                class="btn primary sm"
                @click="store.openOverlay(s.actionButton.overlay, s.actionButton.settingsTab)"
              >
                <IconSvg name="sliders" :size="13" />
                <span>{{ s.actionButton.label }}</span>
              </button>
              <button type="button" class="btn sm" @click="store.openOverlay('model-report')">
                <IconSvg name="cpu" :size="13" />
                <span>查看 9 个 ONNX 张量契约与二次训练手册</span>
              </button>
            </div>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.guide-nav-caption {
  font-size: 0.84rem;
  font-weight: 700;
  color: var(--muted);
  padding: 6px 8px 2px;
  letter-spacing: 0.02em;
}

.guide-nav-btn {
  justify-content: flex-start;
  gap: 7px;
  min-height: 29px;
  text-align: left;
  font-size: 0.88rem;
}

.set-nav .guide-nav-btn:not(.active) {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}

.guide-nav-footer {
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px solid var(--panel-border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.guide-pane {
  max-width: 1360px;
  margin: 0 auto;
  padding-bottom: 28px;
}

.cache-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 11px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
}

.cache-info {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 0.86rem;
  color: var(--muted);
}

.cache-info strong {
  color: var(--accent);
}

.guide-chapter-body {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.guide-lead {
  margin: 0;
  font-size: 1rem;
  line-height: 1.66;
  color: var(--text);
}

.guide-points {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 10px;
}

.guide-point-card {
  box-shadow: none;
  gap: 5px;
  padding: 11px 13px;
}

.guide-point-head {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 0.98rem;
}

.guide-idx {
  font-size: 0.82rem;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--selected);
  color: var(--accent);
  font-weight: 700;
}

.guide-point-card p {
  margin: 0;
  font-size: 0.93rem;
  line-height: 1.64;
  color: var(--muted);
}

.guide-svg-box {
  padding: 10px 12px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 48%, transparent);
}

.guide-flow-svg {
  width: 100%;
  height: auto;
  display: block;
  margin-top: 6px;
  color: var(--muted);
}

.g-node {
  fill: var(--ctrl-bg);
  stroke: var(--panel-border);
  stroke-width: 1.2;
}

.g-node.accent {
  fill: color-mix(in srgb, var(--selected) 56%, var(--panel));
  stroke: var(--accent);
}

.g-node.primary {
  fill: color-mix(in srgb, var(--accent) 14%, var(--panel));
  stroke: var(--accent);
  stroke-width: 1.5;
}

.g-title {
  fill: var(--text);
  font-size: 12.5px;
  font-weight: 700;
  text-anchor: middle;
}

.g-sub {
  fill: var(--muted);
  font-size: 11px;
  text-anchor: middle;
}

.g-arrow {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
  opacity: 0.85;
}

.g-arrow.dashed {
  stroke: var(--muted);
  stroke-dasharray: 4 3;
}

.guide-callout {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px;
  padding: 10px 13px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  border-left-width: 3px;
  font-size: 0.94rem;
  line-height: 1.62;
}

.guide-callout.note {
  border-left-color: var(--accent);
  background: color-mix(in srgb, var(--selected) 45%, var(--panel));
  color: var(--text);
}

.guide-callout strong {
  display: block;
  margin-bottom: 2px;
  font-size: 0.98rem;
}

.guide-callout p {
  margin: 0;
  color: var(--muted);
}

.voqs-grid-box {
  padding: 10px 12px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 54%, transparent);
}

.voqs-badge-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(235px, 1fr));
  gap: 7px;
  margin-top: 8px;
}

.voqs-chip-card {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 7px 9px;
  border-radius: var(--r-ctrl);
  background: var(--ctrl-bg);
  border: 1px solid var(--panel-border);
}

.voqs-sym {
  font-size: 1.35rem;
  min-width: 30px;
  text-align: center;
  color: var(--accent);
  font-weight: 600;
  line-height: 1.3;
}

.voqs-meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  font-size: 0.88rem;
}

.voqs-meta span {
  font-size: 0.8rem;
  line-height: 1.4;
}

.voqs-phys {
  opacity: 0.88;
}

.guide-table-wrap {
  padding: 10px 12px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 48%, transparent);
  overflow-x: auto;
}

.guide-tbl th,
.guide-tbl td {
  padding: 7px 9px;
  font-size: 0.91rem;
  line-height: 1.5;
}

.guide-code {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--selected);
  color: var(--accent);
  font-size: 0.88rem;
  white-space: nowrap;
}

.guide-shortcuts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 10px;
}

.guide-sc-card {
  box-shadow: none;
  padding: 10px 12px;
  gap: 6px;
}

.guide-sc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.88rem;
  padding-top: 4px;
  border-top: 1px dashed var(--panel-border);
}

.guide-kbd {
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  color: var(--text);
  font-size: 0.82rem;
  white-space: nowrap;
}
</style>
