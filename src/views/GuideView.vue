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
import { parseShortcutTokens } from '@/data/shortcut-format';
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
      textStyle: { color: t.text, fontSize: 13 },
    },
    legend: { top: 6, left: 'center', icon: 'roundRect', itemWidth: 16, itemHeight: 9, itemGap: 18, textStyle: { color: t.text, fontSize: 12.5 } },
    grid: { left: 64, right: 68, top: 76, bottom: 42 },
    xAxis: {
      type: 'category',
      data: degrees,
      axisLabel: { color: t.text, fontSize: 12.5, interval: 0 },
      axisLine: { lineStyle: { color: t.border } },
    },
    yAxis: [
      {
        type: 'value',
        name: '声门混合度 (%)',
        nameGap: 14,
        max: 120,
        nameTextStyle: { color: t.muted, fontSize: 12.5, align: 'left', padding: [0, 0, 0, -24] },
        axisLabel: { color: t.muted, fontSize: 12, formatter: '{value}%' },
        splitLine: { lineStyle: { color: t.gridLine } },
      },
      {
        type: 'value',
        name: '喉高偏移 |ΔHY| (cm)',
        nameGap: 14,
        max: 1.05,
        nameTextStyle: { color: t.muted, fontSize: 12.5, align: 'right', padding: [0, -24, 0, 0] },
        axisLabel: { color: t.muted, fontSize: 12, formatter: '±{value}' },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '声门发声态混合度（V̤/V͈/V̰/F 等）',
        type: 'bar',
        barMaxWidth: 36,
        itemStyle: { color: t.series[0], borderRadius: [5, 5, 0, 0] },
        label: { show: true, position: 'top', color: t.text, fontSize: 12.5, formatter: '{c}%' },
        data: [0, 35, 70, 100],
      },
      {
        name: '喉位垂直偏移幅度（L̝ / L̞）',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbolSize: 10,
        lineStyle: { width: 2.8, color: t.series[2] },
        itemStyle: { color: t.series[2] },
        label: { show: true, position: 'top', color: t.series[2], fontSize: 12.5, formatter: '±{c} cm' },
        data: [0, 0.2, 0.5, 0.8],
      },
    ],
  };
}
</script>

<template>
  <div class="settings-view guide-shell guide-reading-scope">
    <!-- Left Grouped Directory Navigation -->
    <aside class="set-nav">
      <button
        type="button"
        class="btn primary guide-back"
        @click="store.closeOverlay()"
      >
        <IconSvg name="arrow-left" :size="14" />
        <span>返回工作台 (Esc)</span>
      </button>

      <div class="guide-nav-caption">系统使用说明</div>
      <button
        type="button"
        class="btn guide-nav-btn"
        :class="{ active: activeSec === GUIDE_SYSTEM_OVERVIEW.id }"
        @click="scrollToSec(GUIDE_SYSTEM_OVERVIEW.id)"
      >
        <IconSvg :name="GUIDE_SYSTEM_OVERVIEW.icon" :size="14" />
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
        <IconSvg :name="mod.icon" :size="14" />
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
        <IconSvg :name="sec.icon" :size="14" />
        <span>{{ sec.nav }}</span>
      </button>

      <div class="guide-nav-footer">
        <button type="button" class="btn sm" style="width: 100%" @click="store.openOverlay('model-report')">
          <IconSvg name="cpu" :size="14" />
          <span>模型训练与技术报告</span>
        </button>
        <button type="button" class="btn sm" style="width: 100%" @click="store.openOverlay('settings', 'engine')">
          <IconSvg name="sliders" :size="14" />
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
            <span class="mono muted guide-hero-meta">零截图纯矢量图示 · 真实生产管线演算 · IndexedDB 持久化缓存</span>
          </div>
          <div class="p-body" style="padding: 16px 18px; display: flex; flex-direction: column; gap: 12px">
            <div class="guide-callout note">
              <IconSvg name="info" :size="18" />
              <div>
                <strong>全工作台说明书导读</strong>
                <p>
                  本手册整合了{{ APP_BRAND_NAME }}全部功能模块的使用说明（也可在各工作区顶栏点击「使用说明」单独呼出对应章节，并随时重播该页首次进入操作指引）。语音合成、国际音标表 Plus、声道动态重建、发声调音台、声道连续统、发音字典与发音卡工坊以实验语音学及学术制图视角为主；声乐编曲与多轨剪辑以音乐制作及音视频创作为视角编写。手册内全部原理曲线与交互演示均由真实生产管线与内置实录语料、参考录音库及示例乐谱现场演算，不使用合成假数据敷衍演示，计算结果自动存入浏览器缓存供随时复看。
                </p>
              </div>
            </div>

            <div class="cache-strip">
              <div class="cache-info mono">
                <IconSvg name="cpu" :size="15" />
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
                <IconSvg name="trash" :size="13" />
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
                <text x="102" y="59" class="g-sub">语音合成 · 三栏联调 · 通栏轴</text>

                <rect x="14" y="102" width="176" height="60" rx="8" class="g-node accent" />
                <text x="102" y="126" class="g-title">实录录音 / 音频导入</text>
                <text x="102" y="145" class="g-sub">声道重建 · 27 维 · 实时 3D</text>

                <rect x="242" y="16" width="190" height="60" rx="8" class="g-node" />
                <text x="337" y="40" class="g-title">国际音标表 Plus &amp; 字典</text>
                <text x="337" y="59" class="g-sub">655 条目 · 构型方案 · 目标帧</text>

                <rect x="242" y="102" width="190" height="60" rx="8" class="g-node" />
                <text x="337" y="126" class="g-title">发声调音台（发声与迁移）</text>
                <text x="337" y="145" class="g-sub">时变 VoQS · 双人 9 轨 · 声学对比</text>

                <rect x="484" y="16" width="196" height="60" rx="8" class="g-node" />
                <text x="582" y="40" class="g-title">声道连续统与发音字典</text>
                <text x="582" y="59" class="g-sub">单双轴刺激包 · 叠影/F1-F2 · 变调</text>

                <rect x="484" y="102" width="196" height="60" rx="8" class="g-node" />
                <text x="582" y="126" class="g-title">声乐编曲台</text>
                <text x="582" y="145" class="g-sub">JE/开源DSL · MIDI/VSQX/SVP · 抢拍</text>

                <rect x="734" y="16" width="232" height="68" rx="9" class="g-node primary" />
                <text x="850" y="39" class="g-title">双通道求解与剪辑成片</text>
                <text x="850" y="57" class="g-sub">VTL 2.4 / Tract2Vox-Lite · V0–V3 / A1–A12</text>
                <text x="850" y="73" class="g-sub">运镜转场 · 节拍卡点 · MP4 / WAV / SRT</text>

                <rect x="734" y="98" width="232" height="68" rx="9" class="g-node primary" />
                <text x="850" y="121" class="g-title">发音卡排版与导出工坊</text>
                <text x="850" y="139" class="g-sub">跨全站 16 模块 · 嵌套分栏与留白保留</text>
                <text x="850" y="155" class="g-sub">PNG / 剪贴板 · MP4(AAC) / GIF (450 帧)</text>

                <path d="M 190 46 L 238 46" class="g-arrow" marker-end="url(#gArr)" />
                <path d="M 190 132 L 238 132" class="g-arrow" marker-end="url(#gArr)" />
                <path d="M 190 118 L 238 60" class="g-arrow dashed" marker-end="url(#gArr)" />
                <path d="M 432 46 L 480 46" class="g-arrow" marker-end="url(#gArr)" />
                <path d="M 432 132 L 480 132" class="g-arrow" marker-end="url(#gArr)" />
                <path d="M 680 46 L 730 48" class="g-arrow" marker-end="url(#gArr)" />
                <path d="M 680 58 L 730 120" class="g-arrow dashed" marker-end="url(#gArr)" />
                <path d="M 680 124 L 730 66" class="g-arrow dashed" marker-end="url(#gArr)" />
                <path d="M 680 136 L 730 136" class="g-arrow" marker-end="url(#gArr)" />
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
              :height="310"
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
                    <span class="voqs-phys">{{ v.physics }}</span>
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
                    <td v-for="(cell, cIdx) in row" :key="cIdx" :class="{ 'guide-cell-body': cIdx >= 2 }">
                      <strong v-if="cIdx === 0">{{ cell }}</strong>
                      <code v-else-if="cIdx === 1 && row.length <= 3" class="mono guide-code">{{ cell }}</code>
                      <template v-else>{{ cell }}</template>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-if="s.showShortcutGroups" class="guide-shortcuts-grid selectable">
              <div v-for="grp in SHORTCUT_GROUPS" :key="grp.title" class="editorial-card guide-sc-card">
                <strong>{{ grp.title }}</strong>
                <div v-for="row in grp.rows" :key="row[0]" class="guide-sc-row">
                  <span class="guide-sc-desc">{{ row[0] }}</span>
                  <span class="guide-sc-keys">
                    <template v-for="(tok, tIdx) in parseShortcutTokens(row[1])" :key="tIdx">
                      <kbd v-if="tok.kind === 'key'" class="mono guide-kbd">{{ tok.text }}</kbd>
                      <span v-else class="guide-sc-sep" aria-hidden="true">{{ tok.text }}</span>
                    </template>
                  </span>
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
.guide-shell {
  --guide-fs-title: 1.16rem;
  --guide-fs-lead: 1.08rem;
  --guide-fs-subhead: 1.04rem;
  --guide-fs-body: 1rem;
  --guide-fs-text: 0.95rem;
  --guide-fs-code: 0.9rem;
  --guide-fs-meta: 0.86rem;
  --guide-fs-nav: 0.94rem;
  --guide-ink-body: color-mix(in srgb, var(--text) 88%, var(--muted));
  grid-template-columns: 244px minmax(0, 1fr);
}

.guide-back {
  margin-bottom: 8px;
  justify-content: flex-start;
  min-height: 30px;
  font-size: var(--guide-fs-nav);
}

.guide-nav-caption {
  font-size: var(--guide-fs-meta);
  font-weight: 700;
  color: var(--muted);
  padding: 8px 8px 3px;
  letter-spacing: 0.02em;
}

.guide-nav-btn {
  justify-content: flex-start;
  gap: 8px;
  min-height: 30px;
  padding: 4px 9px;
  text-align: left;
  font-size: var(--guide-fs-nav);
  line-height: 1.35;
}

.set-nav .guide-nav-btn:not(.active) {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}

.guide-nav-footer {
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid var(--panel-border);
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.guide-pane {
  max-width: 1380px;
  margin: 0 auto;
  padding-bottom: 34px;
}

.guide-hero-meta {
  font-size: var(--guide-fs-meta);
}

.cache-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 13px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
}

.cache-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--guide-fs-text);
  color: var(--guide-ink-body);
}

.cache-info strong {
  color: var(--accent);
}

.guide-chapter-body {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.guide-lead {
  margin: 0;
  font-size: var(--guide-fs-lead);
  line-height: 1.78;
  color: var(--text);
}

.guide-points {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 12px;
}

.guide-point-card {
  box-shadow: none;
  gap: 7px;
  padding: 13px 15px;
}

.guide-point-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--guide-fs-subhead);
  line-height: 1.42;
}

.guide-idx {
  font-size: var(--guide-fs-meta);
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--selected);
  color: var(--accent);
  font-weight: 700;
}

.guide-point-card p {
  margin: 0;
  font-size: var(--guide-fs-body);
  line-height: 1.74;
  color: var(--guide-ink-body);
}

.guide-svg-box {
  padding: 12px 14px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 48%, transparent);
}

.guide-flow-svg {
  width: 100%;
  height: auto;
  display: block;
  margin-top: 8px;
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
  font-size: 13px;
  font-weight: 700;
  text-anchor: middle;
}

.g-sub {
  fill: var(--muted);
  font-size: 11.5px;
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
  gap: 12px;
  padding: 13px 16px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  border-left-width: 3px;
  font-size: var(--guide-fs-body);
  line-height: 1.75;
}

.guide-callout.note {
  border-left-color: var(--accent);
  background: color-mix(in srgb, var(--selected) 45%, var(--panel));
  color: var(--text);
}

.guide-callout strong {
  display: block;
  margin-bottom: 4px;
  font-size: var(--guide-fs-subhead);
}

.guide-callout p {
  margin: 0;
  color: var(--guide-ink-body);
}

.voqs-grid-box {
  padding: 12px 14px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 54%, transparent);
}

.voqs-badge-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 9px;
  margin-top: 10px;
}

.voqs-chip-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 11px;
  border-radius: var(--r-ctrl);
  background: var(--ctrl-bg);
  border: 1px solid var(--panel-border);
}

.voqs-sym {
  font-size: 1.4rem;
  min-width: 32px;
  text-align: center;
  color: var(--accent);
  font-weight: 600;
  line-height: 1.3;
}

.voqs-meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  font-size: var(--guide-fs-text);
}

.voqs-meta span {
  font-size: var(--guide-fs-meta);
  line-height: 1.5;
}

.voqs-phys {
  color: var(--guide-ink-body);
}

.guide-table-wrap {
  padding: 12px 14px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 48%, transparent);
  overflow-x: auto;
}

.guide-tbl th,
.guide-tbl td {
  padding: 9px 11px;
  font-size: var(--guide-fs-text);
  line-height: 1.62;
  vertical-align: top;
}

.guide-tbl th {
  font-size: var(--guide-fs-text);
  color: var(--text);
}

.guide-cell-body {
  color: var(--guide-ink-body);
}

.guide-code {
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--selected);
  color: var(--accent);
  font-size: var(--guide-fs-code);
  white-space: pre-wrap;
  word-break: break-word;
  display: inline-block;
}

.guide-shortcuts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr));
  gap: 12px;
  align-items: start;
}

.guide-sc-card {
  box-shadow: none;
  padding: 12px 14px;
  gap: 7px;
  min-width: 0;
}

.guide-sc-card strong {
  font-size: var(--guide-fs-subhead);
}

.guide-sc-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  font-size: var(--guide-fs-text);
  line-height: 1.5;
  padding-top: 7px;
  border-top: 1px dashed var(--panel-border);
}

.guide-sc-desc {
  flex: 1 1 160px;
  min-width: 0;
  color: var(--guide-ink-body);
  overflow-wrap: break-word;
}

.guide-sc-keys {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 3px;
  flex: 0 1 auto;
  max-width: 100%;
  margin-left: auto;
}

.guide-sc-sep {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--guide-fs-meta);
  padding: 0 2px;
  user-select: none;
}

.guide-kbd {
  padding: 2px 7px;
  border-radius: 4px;
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  color: var(--text);
  font-size: var(--guide-fs-meta);
  line-height: 1.35;
  max-width: 100%;
  overflow-wrap: break-word;
}

.guide-reading-scope :deep(.p-head) {
  font-size: var(--guide-fs-title);
  min-height: 36px;
  padding-top: 6px;
  padding-bottom: 6px;
}

.guide-reading-scope :deep(.param-sec-title) {
  font-size: var(--guide-fs-subhead);
  line-height: 1.45;
  color: var(--text);
}

.guide-reading-scope :deep(.param-sec-title .muted) {
  font-size: var(--guide-fs-meta);
}

.guide-reading-scope :deep(.tree-tag) {
  font-size: var(--guide-fs-meta);
  padding: 2px 7px;
}

.guide-reading-scope :deep(.btn.sm) {
  min-height: 28px;
  padding: 3px 10px;
  font-size: var(--guide-fs-meta);
}

.guide-reading-scope :deep(.btn.xs) {
  min-height: 24px;
  padding: 2px 8px;
  font-size: var(--guide-fs-meta);
}

.guide-reading-scope :deep(.tech-chart-title-row) {
  font-size: var(--guide-fs-subhead);
  line-height: 1.45;
}

.guide-reading-scope :deep(.tech-chart-sub) {
  font-size: var(--guide-fs-text);
  line-height: 1.58;
  color: var(--guide-ink-body);
}

.guide-reading-scope :deep(.tech-chart-cap) {
  font-size: var(--guide-fs-text);
  line-height: 1.66;
  color: var(--guide-ink-body);
  padding: 10px 14px;
}
</style>
