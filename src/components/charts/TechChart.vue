<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import {
  BarChart,
  LineChart,
  PieChart,
  RadarChart,
} from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  RadarComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';
import IconSvg from '@/components/common/IconSvg.vue';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  RadarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  MarkAreaComponent,
  MarkPointComponent,
  RadarComponent,
  CanvasRenderer,
]);

export interface ChartThemeTokens {
  isDark: boolean;
  text: string;
  muted: string;
  accent: string;
  border: string;
  panel: string;
  app: string;
  tooltipBg: string;
  gridLine: string;
  series: readonly [string, string, string, string, string, string, string, string];
}

const props = withDefaults(
  defineProps<{
    title: string;
    subtitle?: string;
    badge?: string;
    height?: number;
    caption?: string;
    revision?: string | number;
    optionBuilder: (theme: ChartThemeTokens) => EChartsCoreOption;
  }>(),
  {
    subtitle: '',
    badge: '',
    height: 310,
    caption: '',
    revision: 0,
  },
);

const chartHostRef = ref<HTMLElement | null>(null);
const modalChartRef = ref<HTMLElement | null>(null);
const expanded = ref(false);

let chartInst: echarts.ECharts | null = null;
let modalChartInst: echarts.ECharts | null = null;
let resizeObs: ResizeObserver | null = null;
let themeObs: MutationObserver | null = null;
let themeRaf = 0;

function parseCssLuminance(raw: string): number {
  const s = raw.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(s);
  if (rgb) {
    return (0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3])) / 255;
  }
  return 0.5;
}

function readThemeTokens(): ChartThemeTokens {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const app = pick('--app', '#11161f');
  const panel = pick('--panel', '#171e2a');
  const text = pick('--text', '#e6edf7');
  const muted = pick('--muted', '#94a3b8');
  const accent = pick('--accent', '#38bdf8');
  const border = pick('--border', 'rgba(148,163,184,0.22)');
  const isDark = parseCssLuminance(app) < 0.45;
  return {
    isDark,
    text,
    muted,
    accent,
    border,
    panel,
    app,
    tooltipBg: isDark ? 'rgba(15, 21, 32, 0.94)' : 'rgba(255, 255, 255, 0.96)',
    gridLine: isDark ? 'rgba(148, 163, 184, 0.14)' : 'rgba(30, 41, 59, 0.10)',
    series: isDark
      ? [accent, '#34d399', '#f59e0b', '#f472b6', '#a78bfa', '#22d3ee', '#fb7185', '#94a3b8']
      : [accent, '#059669', '#d97706', '#db2777', '#7c3aed', '#0284c7', '#e11d48', '#64748b'],
  };
}

function renderChart(target: echarts.ECharts | null): void {
  if (!target) return;
  const tokens = readThemeTokens();
  const baseOption = props.optionBuilder(tokens);
  target.setOption(
    {
      backgroundColor: 'transparent',
      color: [...tokens.series],
      animationDuration: 520,
      animationEasing: 'cubicOut',
      textStyle: {
        color: tokens.text,
        fontFamily: 'var(--font-sans, Inter, system-ui, sans-serif)',
      },
      ...baseOption,
    },
    true,
  );
}

function scheduleThemeRefresh(): void {
  if (themeRaf) cancelAnimationFrame(themeRaf);
  themeRaf = requestAnimationFrame(() => {
    themeRaf = 0;
    renderChart(chartInst);
    renderChart(modalChartInst);
  });
}

function openExpanded(): void {
  expanded.value = true;
}

function closeExpanded(): void {
  expanded.value = false;
}

function exportPng(): void {
  const inst = expanded.value && modalChartInst ? modalChartInst : chartInst;
  if (!inst) return;
  const tokens = readThemeTokens();
  const url = inst.getDataURL({
    type: 'png',
    pixelRatio: 2,
    backgroundColor: tokens.panel,
  });
  const a = document.createElement('a');
  a.href = url;
  a.download = `${props.title.replace(/[^\w\u4e00-\u9fff-]+/g, '_')}.png`;
  a.click();
}

const stageStyle = computed(() => ({
  height: `${props.height}px`,
}));

onMounted(() => {
  if (chartHostRef.value) {
    chartInst = echarts.init(chartHostRef.value, undefined, { renderer: 'canvas' });
    renderChart(chartInst);
    resizeObs = new ResizeObserver(() => {
      chartInst?.resize();
    });
    resizeObs.observe(chartHostRef.value);
  }
  themeObs = new MutationObserver(() => {
    scheduleThemeRefresh();
  });
  themeObs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme', 'data-palette', 'data-skin', 'data-mode'],
  });
});

watch(
  [() => props.optionBuilder, () => props.revision],
  () => {
    renderChart(chartInst);
    renderChart(modalChartInst);
  },
);

watch(expanded, (open) => {
  if (open) {
    requestAnimationFrame(() => {
      if (!modalChartRef.value) return;
      modalChartInst?.dispose();
      modalChartInst = echarts.init(modalChartRef.value, undefined, { renderer: 'canvas' });
      renderChart(modalChartInst);
    });
  } else {
    modalChartInst?.dispose();
    modalChartInst = null;
  }
});

onBeforeUnmount(() => {
  if (themeRaf) cancelAnimationFrame(themeRaf);
  themeObs?.disconnect();
  resizeObs?.disconnect();
  chartInst?.dispose();
  modalChartInst?.dispose();
  chartInst = null;
  modalChartInst = null;
});
</script>

<template>
  <figure class="tech-chart-card">
    <header class="tech-chart-head">
      <div class="tech-chart-titles">
        <div class="tech-chart-title-row">
          <strong>{{ title }}</strong>
          <span v-if="badge" class="tree-tag mono">{{ badge }}</span>
        </div>
        <span v-if="subtitle" class="muted tech-chart-sub">{{ subtitle }}</span>
      </div>
      <div class="tech-chart-actions">
        <button type="button" class="btn xs" title="导出高清 PNG" @click="exportPng">
          <IconSvg name="download" :size="11" />
          <span>PNG</span>
        </button>
        <button type="button" class="btn xs" title="放大检视" @click="openExpanded">
          <IconSvg name="zoom-in" :size="11" />
          <span>大图</span>
        </button>
      </div>
    </header>

    <div ref="chartHostRef" class="tech-chart-stage" :style="stageStyle" />

    <figcaption v-if="caption" class="tech-chart-cap muted">
      {{ caption }}
    </figcaption>

    <Teleport to="body">
      <div
        v-if="expanded"
        class="export-modal-mask"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        @click.self="closeExpanded"
      >
        <div class="export-modal-card tech-chart-modal">
          <div class="p-head">
            <div style="display: flex; align-items: center; gap: 8px">
              <span>{{ title }}</span>
              <span v-if="badge" class="tree-tag mono">{{ badge }}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 6px">
              <button type="button" class="btn xs" @click="exportPng">
                <IconSvg name="download" :size="12" />
                <span>导出 2× PNG</span>
              </button>
              <button type="button" class="btn xs icon-only" aria-label="关闭大图" @click="closeExpanded">
                <IconSvg name="close" :size="13" />
              </button>
            </div>
          </div>
          <div class="p-body" style="padding: 16px">
            <div ref="modalChartRef" class="tech-chart-modal-stage" />
            <p v-if="caption" class="muted" style="margin: 10px 0 0; font-size: 0.92rem; line-height: 1.6">
              {{ caption }}
            </p>
          </div>
        </div>
      </div>
    </Teleport>
  </figure>
</template>

<style scoped>
.tech-chart-card {
  margin: 0;
  border: 1px solid var(--panel-border);
  border-radius: var(--r-panel);
  background: color-mix(in srgb, var(--app) 42%, var(--panel));
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.tech-chart-head {
  padding: 9px 12px;
  border-bottom: 1px solid var(--panel-border);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  background: color-mix(in srgb, var(--panel) 84%, transparent);
}

.tech-chart-titles {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.tech-chart-title-row {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  font-size: 0.97rem;
}

.tech-chart-sub {
  font-size: 0.85rem;
  line-height: 1.45;
}

.tech-chart-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: none;
}

.tech-chart-stage {
  width: 100%;
  min-height: 220px;
}

.tech-chart-cap {
  padding: 8px 12px;
  font-size: 0.875rem;
  line-height: 1.55;
  border-top: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--panel) 65%, transparent);
}

.tech-chart-modal {
  width: min(1080px, 94vw);
}

.tech-chart-modal-stage {
  width: 100%;
  height: min(64vh, 540px);
}
</style>
