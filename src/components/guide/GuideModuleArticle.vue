<script setup lang="ts">
import type { EChartsCoreOption } from 'echarts/core';
import IconSvg from '@/components/common/IconSvg.vue';
import TechChart, { type ChartThemeTokens } from '@/components/charts/TechChart.vue';
import GuideInteractiveDemo from '@/components/guide/GuideInteractiveDemo.vue';
import type { GuideModuleDoc } from '@/data/guide-types';
import { useWorkbenchStore } from '@/stores/workbench';

const props = withDefaults(
  defineProps<{
    module: GuideModuleDoc;
    standalone?: boolean;
  }>(),
  {
    standalone: false,
  },
);

const store = useWorkbenchStore();

function buildCoarticulationChart(t: ChartThemeTokens): EChartsCoreOption {
  const frames = Array.from({ length: 41 }, (_, i) => i * 20);
  const flatBlock = frames.map((ms) => (ms < 220 ? -0.45 : ms <= 540 ? 1.85 : -0.85));
  const origCurve = frames.map((ms) => {
    const u1 = 1 / (1 + Math.exp(-(ms - 210) / 36));
    const u2 = 1 / (1 + Math.exp(-(ms - 550) / 40));
    return Number((-0.45 + 1.35 * u1 - 1.75 * u2).toFixed(3));
  });
  const editedCurve = frames.map((ms) => {
    const u1 = 1 / (1 + Math.exp(-(ms - 210) / 38));
    const u2 = 1 / (1 + Math.exp(-(ms - 550) / 42));
    return Number((-0.45 + 2.30 * u1 - 2.70 * u2).toFixed(3));
  });
  return {
    tooltip: {
      trigger: 'axis',
      backgroundColor: t.tooltipBg,
      borderColor: t.border,
      textStyle: { color: t.text, fontSize: 12 },
    },
    legend: { top: 6, left: 'center', icon: 'roundRect', itemWidth: 16, itemHeight: 4, itemGap: 14, textStyle: { color: t.muted, fontSize: 11 } },
    grid: { left: 56, right: 24, top: 72, bottom: 42 },
    xAxis: {
      type: 'category',
      name: '时间 (ms)',
      nameLocation: 'middle',
      nameGap: 25,
      nameTextStyle: { color: t.muted, fontSize: 11 },
      data: frames,
      axisLabel: { color: t.muted, fontSize: 10.5 },
      axisLine: { lineStyle: { color: t.border } },
    },
    yAxis: {
      type: 'value',
      name: '舌体前后 TCX (cm)',
      nameGap: 14,
      min: -1.4,
      max: 2.3,
      nameTextStyle: { color: t.muted, fontSize: 11, align: 'left', padding: [0, 0, 0, -24] },
      axisLabel: { color: t.muted, fontSize: 11 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    series: [
      {
        name: '微调前原始协同轨迹',
        type: 'line',
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2, type: 'dashed', color: t.series[7] },
        itemStyle: { color: t.series[7] },
        data: origCurve,
      },
      {
        name: '微调目标靶位后（保留协同）',
        type: 'line',
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2.8, color: t.series[0] },
        itemStyle: { color: t.series[0] },
        areaStyle: { color: t.series[0], opacity: 0.12 },
        markArea: {
          silent: true,
          itemStyle: { color: t.isDark ? 'rgba(56,189,248,0.08)' : 'rgba(2,132,199,0.06)' },
          label: { color: t.muted, fontSize: 10.5, position: 'insideTop', distance: 8 },
          data: [[{ name: '目标元音核区间', xAxis: '220' }, { xAxis: '540' }]],
        },
        data: editedCurve,
      },
      {
        name: '传统常数块替换（易爆音）',
        type: 'line',
        step: 'middle',
        symbol: 'none',
        lineStyle: { width: 1.8, type: 'dotted', color: t.series[6] },
        itemStyle: { color: t.series[6] },
        data: flatBlock,
      },
    ],
  };
}

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
  <article :id="module.sectionAnchor" class="panel mod-article">
    <header v-if="!standalone" class="p-head">
      <div class="mod-head-left">
        <IconSvg :name="module.icon" :size="15" />
        <span>{{ module.title }}</span>
      </div>
      <div class="mod-head-right">
        <span class="tree-tag">{{ module.perspectiveBadge }}</span>
        <span class="tree-tag mono">{{ module.code }}</span>
      </div>
    </header>

    <div class="p-body mod-body">
      <p class="mod-summary selectable">{{ module.summary }}</p>

      <!-- Principle / Basis -->
      <section class="mod-block selectable">
        <div class="param-sec-title">
          <span>{{ module.phoneticBasisTitle }}</span>
          <span class="mono muted">{{ module.perspectiveBadge }}</span>
        </div>
        <ul class="mod-ul">
          <li v-for="(line, idx) in module.phoneticBasis" :key="idx">{{ line }}</li>
        </ul>
      </section>

      <!-- Workflow Steps -->
      <section class="mod-block selectable">
        <div class="param-sec-title">
          <span>分步操作流程</span>
          <span class="mono muted">{{ module.workflowSteps.length }} 步实操</span>
        </div>
        <div class="mod-steps-grid">
          <div v-for="(step, idx) in module.workflowSteps" :key="idx" class="editorial-card mod-step-card">
            <div class="mod-step-head">
              <span class="mono mod-idx">{{ String(idx + 1).padStart(2, '0') }}</span>
              <strong>{{ step.title }}</strong>
            </div>
            <p>{{ step.detail }}</p>
            <span v-if="step.uiHint" class="mono muted mod-ui-hint">位置：{{ step.uiHint }}</span>
          </div>
        </div>
      </section>

      <!-- Live Compute & Cached Demo (or Placeholder) -->
      <GuideInteractiveDemo v-if="module.demoSpec" :spec="module.demoSpec" />
      <section v-else-if="module.demoPlaceholder" class="mod-placeholder-card selectable">
        <div class="mod-ph-head">
          <span class="tree-tag mono">{{ module.demoPlaceholder.badge }}</span>
          <strong>{{ module.demoPlaceholder.title }}</strong>
        </div>
        <p class="muted">{{ module.demoPlaceholder.detail }}</p>
      </section>

      <!-- Optional Principle Chart -->
      <TechChart
        v-if="module.chartKey === 'coarticulation'"
        title="原理解析图 · 单音目标靶位微调如何保留前后协同发音动程"
        subtitle="以舌体前后坐标 TCX 为例，对比 3 阶 qTA + IPA2Tract-Lite 连续规划与传统静态常数块替换"
        badge="协同发音原理"
        :height="295"
        :option-builder="buildCoarticulationChart"
        caption="微调单音靶位后，仅元音核目标点抬升，前后辅音衔接区仍保持平滑 S 形过渡与共振峰弯头，避免阶跃爆音。"
      />

      <TechChart
        v-if="module.chartKey === 'voqsScale'"
        title="VoQS 标量度 1 / 2 / 3 参数映射速查图"
        subtitle="发声类型混合权重（%）与喉位垂直偏移量（±cm）逐级对应关系"
        badge="Ball et al. 2018"
        :height="275"
        :option-builder="buildVoqsScaleChart"
        caption="省略标量数字（如 {V̤ ... V̤}）时默认采用 2 度（70% 声门混合 / ±0.50 cm 喉高偏移），离开闭合花括号后自动平滑恢复常态浊声。"
      />

      <!-- Tables -->
      <div v-for="tbl in module.tables" :key="tbl.caption" class="mod-table-wrap selectable">
        <div class="param-sec-title">
          <span>{{ tbl.caption }}</span>
          <span class="mono muted">{{ tbl.tag }}</span>
        </div>
        <table class="mini-tbl mod-tbl">
          <thead>
            <tr>
              <th v-for="h in tbl.headers" :key="h">{{ h }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, rIdx) in tbl.rows" :key="rIdx">
              <td><strong>{{ row[0] }}</strong></td>
              <td><code class="mono mod-code">{{ row[1] }}</code></td>
              <td class="muted">{{ row[2] }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pitfalls & Shortcuts -->
      <div class="mod-bottom-grid selectable">
        <div v-if="module.pitfalls.length" class="mod-pitfalls">
          <div class="param-sec-title">
            <span>注意事项与科研边界</span>
            <span class="mono muted">Cautions</span>
          </div>
          <div v-for="(p, i) in module.pitfalls" :key="i" class="mod-pitfall-item">
            <IconSvg name="warn" :size="14" />
            <div>
              <strong>{{ p.title }}</strong>
              <p>{{ p.detail }}</p>
            </div>
          </div>
        </div>

        <div v-if="module.shortcuts.length" class="editorial-card mod-sc-card">
          <div class="param-sec-title">
            <span>常用快捷键</span>
            <span class="mono muted">Shortcuts</span>
          </div>
          <div v-for="row in module.shortcuts" :key="row[0]" class="mod-sc-row">
            <span class="muted">{{ row[0] }}</span>
            <kbd class="mono mod-kbd">{{ row[1] }}</kbd>
          </div>
          <button
            v-if="module.jumpAction?.overlay || module.jumpAction?.guideSection"
            type="button"
            class="btn sm"
            style="margin-top: 6px; align-self: flex-start"
            @click="module.jumpAction.guideSection ? store.openGuideSection(module.jumpAction.guideSection) : store.openOverlay(module.jumpAction.overlay!, module.jumpAction.settingsTab)"
          >
            <IconSvg name="book" :size="13" />
            <span>{{ module.jumpAction.label }}</span>
          </button>
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.mod-head-left,
.mod-head-right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.mod-body {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 13px;
}

.mod-summary {
  margin: 0;
  font-size: 0.98rem;
  line-height: 1.66;
  color: var(--text);
}

.mod-block {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.mod-ul {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 0.92rem;
  line-height: 1.62;
  color: var(--muted);
}

.mod-steps-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(275px, 1fr));
  gap: 9px;
}

.mod-step-card {
  box-shadow: none;
  padding: 10px 12px;
  gap: 5px;
}

.mod-step-head {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 0.95rem;
}

.mod-idx {
  font-size: 0.8rem;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--selected);
  color: var(--accent);
  font-weight: 700;
}

.mod-step-card p {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.58;
  color: var(--muted);
}

.mod-ui-hint {
  font-size: 0.78rem;
  margin-top: auto;
}

.mod-table-wrap {
  padding: 10px 12px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 48%, transparent);
  overflow-x: auto;
}

.mod-tbl th,
.mod-tbl td {
  padding: 6px 9px;
  font-size: 0.89rem;
  line-height: 1.5;
}

.mod-code {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--selected);
  color: var(--accent);
  font-size: 0.86rem;
  white-space: nowrap;
}

.mod-bottom-grid {
  display: grid;
  grid-template-columns: minmax(280px, 1.4fr) minmax(240px, 1fr);
  gap: 10px;
}

.mod-pitfalls {
  padding: 10px 12px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  border-left: 3px solid var(--warning);
  background: color-mix(in srgb, var(--warning) 8%, var(--panel));
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mod-pitfall-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 7px;
  font-size: 0.89rem;
  line-height: 1.54;
}

.mod-pitfall-item p {
  margin: 2px 0 0;
  color: var(--muted);
}

.mod-sc-card {
  box-shadow: none;
  padding: 10px 12px;
  gap: 6px;
}

.mod-sc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.87rem;
  padding-top: 4px;
  border-top: 1px dashed var(--panel-border);
}

.mod-kbd {
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  color: var(--text);
  font-size: 0.8rem;
  white-space: nowrap;
}

.mod-placeholder-card {
  padding: 12px 14px;
  border-radius: var(--r-panel);
  border: 1px dashed var(--panel-border);
  background: color-mix(in srgb, var(--app) 50%, transparent);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mod-ph-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.94rem;
}

.mod-placeholder-card p {
  margin: 0;
  font-size: 0.88rem;
  line-height: 1.56;
}

@media (max-width: 820px) {
  .mod-bottom-grid {
    grid-template-columns: 1fr;
  }
}
</style>
