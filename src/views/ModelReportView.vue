<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { EChartsCoreOption } from 'echarts/core';
import { APP_BRAND_NAME } from '@/data/app-branding';
import {
  ENGINE_LOADING_ENDPOINTS,
  FULL_CORPUS_INVENTORY,
  FULL_MODEL_ZOO,
  IPA32_FEATURE_SPECS,
  LOCAL_MODEL_SPECS,
  LOCAL_MODEL_TOTALS,
  M27_PARAMETER_SPECS,
  MODEL_ARCHITECTURE_LAYERS,
  MODEL_TRAINING_REPORT_META,
  ONNX_SLOT_CONTRACTS,
  RETRAINING_RECIPES,
  SYNTH_180H_MODES,
  TRAINING_CURVES,
  buildTrainingReportMarkdown,
  type CorpusRow,
  type Ipa32FeatureSpec,
} from '@/data/model-training-report';
import { useWorkbenchStore } from '@/stores/workbench';
import IconSvg from '@/components/common/IconSvg.vue';
import TechChart, { type ChartThemeTokens } from '@/components/charts/TechChart.vue';
import ModelArchDiagrams from '@/components/model-report/ModelArchDiagrams.vue';

const store = useWorkbenchStore();
const reportScrollRef = ref<HTMLElement | null>(null);
const activeSec = ref('repOverview');
const corpusFilter = ref<'全部' | CorpusRow['category']>('全部');
const m27Filter = ref<'全部' | '声道 17 维' | '基频与肺压' | '声门 8 维'>('全部');
const ipa32Filter = ref<'全部' | Ipa32FeatureSpec['group']>('全部');
const copiedId = ref<string | null>(null);

const NAV_ITEMS = [
  { id: 'repOverview', icon: 'cpu', label: '1. 最新 8 模型体系与总览' },
  { id: 'repSpace', icon: 'sliders', label: '2. 27 维物理与 32 维 IPA 特征' },
  { id: 'repArch', icon: 'stage', label: '3. 神经网络架构详解' },
  { id: 'repDatasets', icon: 'folder-open', label: '4. 扩充后训练语料清单' },
  { id: 'repBenchmarks', icon: 'reconstruct', label: '5. Batch-2 最新评测结果' },
  { id: 'repEngine', icon: 'book', label: '6. 槽位契约与方言扩展' },
] as const;

const CORPUS_CATEGORIES: ReadonlyArray<'全部' | CorpusRow['category']> = [
  '全部',
  '本地物理合成',
  '开源朗读语料',
  '受限授权语料',
  '研究情感/表现语料',
  '研究歌唱/特殊发声',
  '独立盲测/自录评测',
  '派生任务缓存',
];

const IPA32_GROUPS: ReadonlyArray<'全部' | Ipa32FeatureSpec['group']> = [
  '全部',
  '基础类别 (3)',
  '构音部位 (10)',
  '构音方式 (8)',
  '嗓音与元音 (5)',
  '窄标扩展 (6)',
];

const filteredCorpus = computed(() =>
  corpusFilter.value === '全部'
    ? FULL_CORPUS_INVENTORY
    : FULL_CORPUS_INVENTORY.filter((c) => c.category === corpusFilter.value),
);

const filteredM27 = computed(() =>
  m27Filter.value === '全部'
    ? M27_PARAMETER_SPECS
    : M27_PARAMETER_SPECS.filter((p) => p.group === m27Filter.value),
);

const filteredIpa32 = computed(() =>
  ipa32Filter.value === '全部'
    ? IPA32_FEATURE_SPECS
    : IPA32_FEATURE_SPECS.filter((f) => f.group === ipa32Filter.value),
);

function scrollToId(id: string): void {
  activeSec.value = id;
  const scroller = reportScrollRef.value;
  if (!scroller) return;
  const target = scroller.querySelector<HTMLElement>(`#${id}`);
  if (!target) return;
  const scrollerRect = scroller.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const top = scroller.scrollTop + (targetRect.top - scrollerRect.top) - 14;
  scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

let scrollRaf = 0;
function onReportScroll(): void {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const scroller = reportScrollRef.value;
    if (!scroller) return;
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

function downloadReportMd(): void {
  const blob = new Blob([buildTrainingReportMarkdown()], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'VoxFigura_Batch2_Technical_Report.md';
  a.click();
  URL.revokeObjectURL(url);
  store.pushToast('已导出最新模型训练与技术报告 Markdown', 'success');
}

async function copyCode(id: string, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    copiedId.value = id;
    store.pushToast('已复制训练命令到剪贴板', 'success', 1800);
    setTimeout(() => {
      if (copiedId.value === id) copiedId.value = null;
    }, 1800);
  } catch {
    store.pushToast('复制失败，请手动选中文本复制', 'warning', 2200);
  }
}

/* ============================================================================
 * 7 Focused Batch-2 ECharts Builders (100% Real Verified Data)
 * ============================================================================ */

function baseTooltip(t: ChartThemeTokens) {
  return {
    backgroundColor: t.tooltipBg,
    borderColor: t.border,
    borderWidth: 1,
    textStyle: { color: t.text, fontSize: 12 },
  };
}

function baseLegend(t: ChartThemeTokens) {
  return {
    top: 6,
    left: 'center',
    itemGap: 14,
    itemWidth: 16,
    itemHeight: 10,
    textStyle: { color: t.muted, fontSize: 11 },
  };
}

/** Chart 1: 8 Local ONNX Models — Params, Disk Size & CPU Latency */
function buildOnnxBudgetChart(t: ChartThemeTokens): EChartsCoreOption {
  const names = LOCAL_MODEL_SPECS.map((m) => m.name);
  return {
    tooltip: { ...baseTooltip(t), trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: baseLegend(t),
    grid: { left: 56, right: 60, top: 76, bottom: 68 },
    xAxis: {
      type: 'category',
      data: names,
      axisLabel: { color: t.muted, fontSize: 10.5, rotate: 18, interval: 0 },
      axisLine: { lineStyle: { color: t.border } },
    },
    yAxis: [
      {
        type: 'value',
        name: '体积 (MiB) / 参数 (M)',
        nameGap: 14,
        nameTextStyle: { color: t.muted, fontSize: 11, align: 'left', padding: [0, 0, 0, -24] },
        axisLabel: { color: t.muted, fontSize: 11 },
        splitLine: { lineStyle: { color: t.gridLine } },
      },
      {
        type: 'value',
        name: 'ORT CPU (ms)',
        nameGap: 14,
        nameTextStyle: { color: t.muted, fontSize: 11, align: 'right', padding: [0, -18, 0, 0] },
        axisLabel: { color: t.muted, fontSize: 11 },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '磁盘体积 (MiB)',
        type: 'bar',
        barMaxWidth: 20,
        itemStyle: { color: t.series[0], borderRadius: [4, 4, 0, 0] },
        data: LOCAL_MODEL_SPECS.map((m) => m.sizeMb),
      },
      {
        name: '参数量 (M)',
        type: 'bar',
        barMaxWidth: 20,
        itemStyle: { color: t.series[1], borderRadius: [4, 4, 0, 0] },
        data: LOCAL_MODEL_SPECS.map((m) => m.paramsM),
      },
      {
        name: '3s 纯 ONNX CPU 耗时 (ms)',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbol: 'circle',
        symbolSize: 7,
        lineStyle: { width: 2.4, color: t.series[2] },
        itemStyle: { color: t.series[2] },
        data: LOCAL_MODEL_SPECS.map((m) => m.cpuLatencyMs),
      },
    ],
  };
}

/** Chart 2: 180h Synthetic Corpus 8-Mode Distribution */
function buildSynth180hPieChart(t: ChartThemeTokens): EChartsCoreOption {
  return {
    tooltip: {
      ...baseTooltip(t),
      trigger: 'item',
      formatter: '{b}<br/>条数：<b>{c}</b> ({d}%)',
    },
    legend: {
      bottom: 2,
      left: 'center',
      itemGap: 10,
      itemWidth: 11,
      itemHeight: 9,
      textStyle: { color: t.muted, fontSize: 10.5 },
    },
    series: [
      {
        name: '180h 多发声态分布',
        type: 'pie',
        radius: ['36%', '60%'],
        center: ['50%', '39%'],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 5, borderColor: t.panel, borderWidth: 2 },
        label: { show: true, color: t.text, fontSize: 10.5, formatter: '{d}%' },
        labelLine: { length: 8, length2: 8, lineStyle: { color: t.muted } },
        data: SYNTH_180H_MODES.map((m, i) => ({
          name: m.name,
          value: m.count,
          itemStyle: { color: t.series[i % t.series.length] },
        })),
      },
    ],
  };
}

/** Chart 3: Vox2TractAlign v4 25-Dim Per-Parameter PCC */
function buildV4PerDimPccChart(t: ChartThemeTokens): EChartsCoreOption {
  const rows = [...TRAINING_CURVES.v4PerDimPcc].reverse();
  return {
    tooltip: {
      ...baseTooltip(t),
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const list = params as Array<{ name: string; value: number; dataIndex: number }>;
        const item = list[0];
        if (!item) return '';
        const src = rows[item.dataIndex];
        return `<b>${item.name}</b>（${src.group}）<br/>未见自然语音 PCC：<b>${item.value.toFixed(4)}</b>`;
      },
    },
    grid: { left: 54, right: 48, top: 18, bottom: 28 },
    xAxis: {
      type: 'value',
      min: 0.7,
      max: 1.0,
      axisLabel: { color: t.muted, fontSize: 11 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    yAxis: {
      type: 'category',
      data: rows.map((r) => r.dim),
      axisLabel: { color: t.text, fontSize: 10.5, interval: 0, fontFamily: 'var(--font-mono, monospace)' },
      axisLine: { lineStyle: { color: t.border } },
    },
    series: [
      {
        name: '逐维 PCC',
        type: 'bar',
        barWidth: 13,
        label: {
          show: true,
          position: 'right',
          distance: 5,
          color: t.muted,
          fontSize: 10,
          formatter: (p: { value: unknown }) => Number(p.value).toFixed(3),
        },
        data: rows.map((r) => ({
          value: r.val,
          itemStyle: {
            color: r.group === '声门' ? t.series[1] : t.series[0],
            borderRadius: [0, 4, 4, 0],
          },
        })),
      },
    ],
  };
}

/** Chart 4: 50-Sentence Offline Whisper Large-v3-Turbo ASR Gate */
function buildWhisperAsrChart(t: ChartThemeTokens): EChartsCoreOption {
  const rows = TRAINING_CURVES.whisperAsrGate;
  return {
    tooltip: { ...baseTooltip(t), trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: baseLegend(t),
    grid: { left: 52, right: 54, top: 76, bottom: 68 },
    xAxis: {
      type: 'category',
      data: rows.map((r) => r.name),
      axisLabel: { color: t.muted, fontSize: 10, rotate: 16, interval: 0 },
      axisLine: { lineStyle: { color: t.border } },
    },
    yAxis: [
      {
        type: 'value',
        name: '字/词错率 (%) ↓',
        nameGap: 14,
        max: 16,
        nameTextStyle: { color: t.muted, fontSize: 11, align: 'left', padding: [0, 0, 0, -24] },
        axisLabel: { color: t.muted, fontSize: 11, formatter: '{value}%' },
        splitLine: { lineStyle: { color: t.gridLine } },
      },
      {
        type: 'value',
        name: 'WavLM L24 ↑',
        nameGap: 14,
        min: 0.84,
        max: 0.90,
        nameTextStyle: { color: t.muted, fontSize: 11, align: 'right', padding: [0, -20, 0, 0] },
        axisLabel: { color: t.muted, fontSize: 11 },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '中英均值错率 (%) ↓',
        type: 'bar',
        barMaxWidth: 22,
        itemStyle: { color: t.series[0], borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: 'top', distance: 5, color: t.text, fontSize: 10, formatter: '{c}%' },
        data: rows.map((r) => r.meanErr),
      },
      {
        name: '中文 CER (%)',
        type: 'bar',
        barMaxWidth: 14,
        itemStyle: { color: t.series[4], opacity: 0.7, borderRadius: [4, 4, 0, 0] },
        data: rows.map((r) => r.zhCer),
      },
      {
        name: '英文 WER (%)',
        type: 'bar',
        barMaxWidth: 14,
        itemStyle: { color: t.series[1], opacity: 0.75, borderRadius: [4, 4, 0, 0] },
        data: rows.map((r) => r.enWer),
      },
      {
        name: '语义相似度 L24 ↑',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbolSize: 7,
        lineStyle: { width: 2.3, color: t.series[2] },
        itemStyle: { color: t.series[2] },
        data: rows.map((r) => r.l24),
      },
    ],
  };
}

/** Chart 5: Text2Prosody-Lite v4 (32D) 5-Domain Metrics */
function buildProsodyV4Chart(t: ChartThemeTokens): EChartsCoreOption {
  const rows = TRAINING_CURVES.prosodyV4Domains;
  return {
    tooltip: { ...baseTooltip(t), trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: baseLegend(t),
    grid: { left: 52, right: 52, top: 76, bottom: 52 },
    xAxis: {
      type: 'category',
      data: rows.map((r) => r.domain.replace(' (', '\n(')),
      axisLabel: { color: t.muted, fontSize: 10.5, interval: 0, lineHeight: 14 },
      axisLine: { lineStyle: { color: t.border } },
    },
    yAxis: [
      {
        type: 'value',
        name: '时长 MAE (ms)',
        nameGap: 14,
        max: 52,
        nameTextStyle: { color: t.muted, fontSize: 11, align: 'left', padding: [0, 0, 0, -24] },
        axisLabel: { color: t.muted, fontSize: 11 },
        splitLine: { lineStyle: { color: t.gridLine } },
      },
      {
        type: 'value',
        name: 'F0 PCC',
        nameGap: 14,
        min: 0.4,
        max: 0.9,
        nameTextStyle: { color: t.muted, fontSize: 11, align: 'right', padding: [0, -16, 0, 0] },
        axisLabel: { color: t.muted, fontSize: 11 },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '音素时长 MAE (ms)',
        type: 'bar',
        barMaxWidth: 26,
        itemStyle: { color: t.series[0], borderRadius: [5, 5, 0, 0] },
        label: { show: true, position: 'top', distance: 5, color: t.muted, fontSize: 10, formatter: '{c} ms' },
        data: rows.map((r) => r.durMaeMs),
      },
      {
        name: '相对半音 F0 PCC',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbolSize: 8,
        lineStyle: { width: 2.5, color: t.series[1] },
        itemStyle: { color: t.series[1] },
        data: rows.map((r) => r.f0Pcc),
      },
    ],
  };
}

/** Chart 6: IPA2Tract-Lite v4 (32D) Human EMA 7-Articulator Radar */
function buildEmaRadarChart(t: ChartThemeTokens): EChartsCoreOption {
  return {
    tooltip: { ...baseTooltip(t), trigger: 'item' },
    radar: {
      radius: '56%',
      center: ['50%', '53%'],
      splitNumber: 4,
      axisNameGap: 8,
      axisName: { color: t.text, fontSize: 11, fontWeight: 600 },
      splitLine: { lineStyle: { color: t.gridLine } },
      splitArea: { areaStyle: { color: ['transparent', t.isDark ? 'rgba(148,163,184,0.04)' : 'rgba(15,23,42,0.03)'] } },
      axisLine: { lineStyle: { color: t.border } },
      indicator: TRAINING_CURVES.emaRadarV4.map((r) => ({ name: r.axis, max: 0.8 })),
    },
    series: [
      {
        name: 'USC-TIMIT 真人 EMA 盲测 PCC',
        type: 'radar',
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { width: 2.6, color: t.series[0] },
        itemStyle: { color: t.series[0] },
        areaStyle: { color: t.series[0], opacity: 0.22 },
        data: [
          {
            value: TRAINING_CURVES.emaRadarV4.map((r) => r.pcc),
            name: 'IPA2Tract-Lite v4 32D（20 份未见真人文件）',
          },
        ],
      },
    ],
  };
}

/** Chart 7: Vox2Spk-v2.1 Speaker Fidelity & Discrimination Comparison */
function buildVox2SpkChart(t: ChartThemeTokens): EChartsCoreOption {
  const rows = TRAINING_CURVES.vox2spkCompare;
  return {
    tooltip: { ...baseTooltip(t), trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: baseLegend(t),
    grid: { left: 52, right: 24, top: 76, bottom: 48 },
    xAxis: {
      type: 'category',
      data: rows.map((r) => r.name),
      axisLabel: { color: t.muted, fontSize: 10.5, interval: 0 },
      axisLine: { lineStyle: { color: t.border } },
    },
    yAxis: {
      type: 'value',
      name: '余弦 / 区分度',
      nameGap: 14,
      min: 0.2,
      max: 1.02,
      nameTextStyle: { color: t.muted, fontSize: 11, align: 'left', padding: [0, 0, 0, -24] },
      axisLabel: { color: t.muted, fontSize: 11 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    series: [
      {
        name: '常规人声 Teacher Cos',
        type: 'bar',
        barMaxWidth: 20,
        itemStyle: { color: t.series[0], borderRadius: [4, 4, 0, 0] },
        data: rows.map((r) => r.spCos),
      },
      {
        name: '165 Hz 实时换声 Self Cos',
        type: 'bar',
        barMaxWidth: 20,
        itemStyle: { color: t.series[1], borderRadius: [4, 4, 0, 0] },
        data: rows.map((r) => r.tts165Cos),
      },
      {
        name: '女声歌唱类间 Gap',
        type: 'bar',
        barMaxWidth: 20,
        itemStyle: { color: t.series[2], borderRadius: [4, 4, 0, 0] },
        data: rows.map((r) => r.femGap),
      },
      {
        name: '女声歌唱 Top-1',
        type: 'line',
        smooth: true,
        symbolSize: 8,
        lineStyle: { width: 2.4, color: t.series[4] },
        itemStyle: { color: t.series[4] },
        data: rows.map((r) => r.femTop1),
      },
    ],
  };
}
</script>

<template>
  <div class="settings-view">
    <!-- Left Technical Report Navigation -->
    <aside class="set-nav">
      <button
        type="button"
        class="btn primary"
        style="margin-bottom: 6px; justify-content: flex-start"
        @click="store.closeOverlay()"
      >
        <IconSvg name="arrow-left" :size="13" />
        <span>返回工作台 (Esc)</span>
      </button>
      <button
        type="button"
        class="btn sm"
        style="margin-bottom: 8px; justify-content: flex-start"
        @click="store.openOverlay('about')"
      >
        <IconSvg name="info" :size="13" />
        <span>前往关于{{ APP_BRAND_NAME }}</span>
      </button>

      <div class="rep-nav-caption">模型训练与技术报告</div>
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

      <div class="rep-nav-footer">
        <button type="button" class="btn sm" style="width: 100%" @click="store.openOverlay('settings', 'engine')">
          <IconSvg name="sliders" :size="12" />
          <span>打开本地模型矩阵</span>
        </button>
        <button type="button" class="btn sm" style="width: 100%" @click="downloadReportMd">
          <IconSvg name="download" :size="12" />
          <span>导出 Markdown 报告</span>
        </button>
      </div>
    </aside>

    <!-- Main Report Body -->
    <section ref="reportScrollRef" class="set-content" @scroll="onReportScroll">
      <div class="set-full-pane rep-pane">
        <!-- Chapter 1: Overview & 8-Model Matrix -->
        <div id="repOverview" class="panel">
          <div class="p-head">
            <span>{{ APP_BRAND_NAME }} · 模型训练与技术报告</span>
            <span class="tree-tag mono">{{ MODEL_TRAINING_REPORT_META.version }}</span>
          </div>
          <div class="p-body rep-body">
            <div class="editorial-card rep-hero-card selectable">
              <strong style="font-size: 1.06rem">{{ MODEL_TRAINING_REPORT_META.suiteName }}</strong>
              <p class="muted rep-p">{{ MODEL_TRAINING_REPORT_META.updatedNote }}</p>
              <div class="rep-kpi-grid">
                <div class="rep-kpi-box">
                  <span class="muted">默认端侧纯 ONNX 矩阵</span>
                  <strong class="mono">{{ LOCAL_MODEL_TOTALS.count }} 模 · {{ LOCAL_MODEL_TOTALS.totalSizeText }}</strong>
                  <span class="muted">{{ LOCAL_MODEL_TOTALS.totalParamsText }} 参数 · 零 PyTorch 运行时</span>
                </div>
                <div class="rep-kpi-box">
                  <span class="muted">扩充后总语料规模</span>
                  <strong class="mono">450+ 小时 / 18 项数据源</strong>
                  <span class="muted">物理合成 + 多语朗读 + 情感配音 + 戏曲歌唱</span>
                </div>
                <div class="rep-kpi-box">
                  <span class="muted">50 句双语 Whisper 门禁</span>
                  <strong class="mono">7.18% 均值错率 (Lite v3)</strong>
                  <span class="muted">Large v2 7.31% · 较旧 Lite v1 降 2.40%</span>
                </div>
                <div class="rep-kpi-box">
                  <span class="muted">物理空间与 IPA 编码</span>
                  <strong class="mono">27D 物理 · 32D 窄标 IPA</strong>
                  <span class="muted">20–1200 Hz 宽音域 · 293 键构型库</span>
                </div>
              </div>
            </div>

            <!-- Batch-2 Dual-Path Topology SVG -->
            <div class="rep-svg-box">
              <div class="param-sec-title">
                <span>Batch-2 双链路协同拓扑（8 项纯 ONNX 矩阵）</span>
                <span class="mono muted">50 Hz 27D Physical Bridge</span>
              </div>
              <svg class="rep-flow-svg" viewBox="0 0 980 210" role="img" aria-label="Batch-2 8模型双链路拓扑图">
                <defs>
                  <marker id="repArr" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="currentColor" />
                  </marker>
                </defs>
                <!-- Left: Inputs -->
                <rect x="12" y="16" width="192" height="72" rx="8" class="svg-node" />
                <text x="108" y="42" class="svg-title">链路 A · 录音与声纹输入</text>
                <text x="108" y="61" class="svg-sub">DPDFNet (48k 降噪)</text>
                <text x="108" y="77" class="svg-sub">SwiftF0 (47–2094 Hz)</text>

                <rect x="12" y="114" width="192" height="78" rx="8" class="svg-node" />
                <text x="108" y="140" class="svg-title">链路 B · 文本与窄标 IPA</text>
                <text x="108" y="159" class="svg-sub">普通话 / 英语 / 日语 / [IPA]</text>
                <text x="108" y="176" class="svg-sub">32 维发音特征 + 293 键构型</text>

                <!-- Mid-Left: Encoders / Planners -->
                <rect x="252" y="12" width="222" height="44" rx="8" class="svg-node primary" />
                <text x="363" y="31" class="svg-title">Vox2TractAlign v4 (9.40M)</text>
                <text x="363" y="47" class="svg-sub">单次前向：27D 轨迹 + 7 路中英对齐</text>

                <rect x="252" y="64" width="222" height="36" rx="8" class="svg-node accent" />
                <text x="363" y="81" class="svg-title">Vox2Spk-v2.1 (4.60M)</text>
                <text x="363" y="95" class="svg-sub">512D 高区分度声纹嵌入</text>

                <rect x="252" y="114" width="222" height="36" rx="8" class="svg-node" />
                <text x="363" y="131" class="svg-title">Text2Prosody-Lite v4 (1.98M)</text>
                <text x="363" y="145" class="svg-sub">32D 时长 / 停顿 / 3 点半音 F0</text>

                <rect x="252" y="158" width="222" height="38" rx="8" class="svg-node accent" />
                <text x="363" y="175" class="svg-title">IPA2Tract-Lite v4 (4.23M)</text>
                <text x="363" y="190" class="svg-sub">qTA 基线 + 零初残差 + Area-Proxy</text>

                <!-- Center: Physical 27D Bridge -->
                <rect x="524" y="44" width="176" height="118" rx="10" class="svg-node primary" />
                <text x="612" y="74" class="svg-title">27D 物理控制桥梁</text>
                <text x="612" y="95" class="svg-sub">17 维声道 + 宽域 F0</text>
                <text x="612" y="113" class="svg-sub">1 维肺压 + 8 维声门</text>
                <text x="612" y="135" class="svg-sub">3D 声道编辑 / VoQS 曲线</text>
                <text x="612" y="151" class="svg-sub">实时器官移植与连续统</text>

                <!-- Right: Renderers -->
                <rect x="748" y="24" width="220" height="72" rx="8" class="svg-node primary" />
                <text x="858" y="48" class="svg-title">Tract2Vox-Large v2.1 (14.4M)</text>
                <text x="858" y="66" class="svg-sub">Glottis-NSF v4 神经声码器</text>
                <text x="858" y="83" class="svg-sub">可选极速档：Lite v3 (3.73M)</text>

                <rect x="748" y="116" width="220" height="62" rx="8" class="svg-node subtle" />
                <text x="858" y="142" class="svg-title">VocalTractLab 2.4 原生求解</text>
                <text x="858" y="161" class="svg-sub">65 截面 200 Hz → 48 kHz 物理发声</text>

                <!-- Arrows -->
                <path d="M 204 40 L 248 34" class="svg-arrow" marker-end="url(#repArr)" />
                <path d="M 204 64 L 248 80" class="svg-arrow" marker-end="url(#repArr)" />
                <path d="M 204 140 L 248 132" class="svg-arrow" marker-end="url(#repArr)" />
                <path d="M 204 168 L 248 175" class="svg-arrow" marker-end="url(#repArr)" />
                <path d="M 474 34 L 520 76" class="svg-arrow" marker-end="url(#repArr)" />
                <path d="M 474 176 L 520 130" class="svg-arrow" marker-end="url(#repArr)" />
                <path d="M 474 82 L 502 82 L 502 18 L 726 18 L 726 48 L 744 48" class="svg-arrow dashed" marker-end="url(#repArr)" />
                <path d="M 700 84 L 744 64" class="svg-arrow" marker-end="url(#repArr)" />
                <path d="M 700 124 L 744 144" class="svg-arrow dashed" marker-end="url(#repArr)" />
              </svg>
            </div>

            <TechChart
              title="图 1 · 默认 8 项纯 ONNX 模型体积、参数量与 CPU 前向耗时"
              subtitle="Vox2TractAlign v4 合并原独立对齐模型，合计 37.44 M / 77.61 MiB（可按需换用 3.73 M Lite v3 极速声码器）"
              badge="8 ONNX · 77.61 MiB"
              :height="305"
              :option-builder="buildOnnxBudgetChart"
              :caption="MODEL_TRAINING_REPORT_META.cpuBenchmarkProtocol"
            />

            <div class="rep-table-card selectable">
              <div class="param-sec-title">
                <span>Batch-2 最新模型总表（8 项核心 + 2 项可选扩展）</span>
                <span class="mono muted">Pure ONNX Runtime</span>
              </div>
              <div class="rep-table-scroll">
                <table class="mini-tbl rep-tbl">
                  <thead>
                    <tr>
                      <th>模型名</th>
                      <th>定位</th>
                      <th>核心网络结构</th>
                      <th>参数量</th>
                      <th>导出体积</th>
                      <th>训练周期</th>
                      <th>最新实测指标</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="m in FULL_MODEL_ZOO" :key="m.name">
                      <td class="mono"><strong>{{ m.name }}</strong></td>
                      <td><span class="tree-tag">{{ m.tier }}</span></td>
                      <td>{{ m.arch }}</td>
                      <td class="mono">{{ m.params }}</td>
                      <td class="mono">{{ m.weightSize }}</td>
                      <td class="mono">{{ m.schedule }}</td>
                      <td class="muted">{{ m.metrics }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <!-- Chapter 2: 27D Physical Space & 32D IPA Feature System -->
        <div id="repSpace" class="panel">
          <div class="p-head">
            <span>2. 27 维物理控制空间与 32 维国际音标发音特征</span>
            <span class="tree-tag mono">27D Physical · 32D IPA</span>
          </div>
          <div class="p-body rep-body">
            <div class="settings-grid-2 selectable">
              <div class="editorial-card rep-card">
                <strong>三频同步锁相与宽域基频契约</strong>
                <ul class="rep-ul">
                  <li><strong>50 Hz 神经分析（16 kHz / hop 320）</strong>：前端 80-Mel 对称填充 352 样点，与 WavLM 帧心 1:1 对齐，零半帧漂移。</li>
                  <li><strong>200 Hz 物理求解 → 48 kHz 输出</strong>：时间轴全仓使用 48 kHz 整数采样与半开区间；气压 UI 统一 <code class="mono">0–1600 Pa</code>，引擎边界换算 <code class="mono">dPa</code>。</li>
                  <li><strong>宽域 F0 对数外延</strong>：保留 <code class="mono">[40, 600] Hz</code> 锚点不变，平滑外延至 <code class="mono">20–1200 Hz</code> 覆盖深嘎裂与超高音花腔。</li>
                </ul>
              </div>
              <div class="editorial-card rep-card">
                <strong>32 维窄标 IPA 特征与 121 维动腔条件</strong>
                <ul class="rep-ul">
                  <li><strong>32 维特征（PHON_FEAT_NAMES_32）</strong>：在原 22 维基础类别、部位、方式与元音坐标上新增 10 维窄标分辨维度（齿音、有咝擦音、小舌、咽音、成音节、唯闭、音段气声/嘎裂及声门/软腭气流机制）。</li>
                  <li><strong>IPA2Tract-Lite v4 121 维输入</strong>：<code class="mono">x_base(26) + g_masked(26) + w_mask(26) + f0(1) + 相位(5) + 阻塞(4) + IPA特征(32) + has_phon(1)</code>，配套 293 键窄标构型库。</li>
                  <li><strong>Text2Prosody-Lite v4 直通</strong>：以 32 维特征 + <code class="mono">LANG_IPA=3</code> 直接为任意无标调国际音标串预测自然语调与停顿。</li>
                </ul>
              </div>
            </div>

            <!-- 27D Physical Parameter Table -->
            <div class="rep-table-card selectable">
              <div class="rep-filter-bar">
                <strong>27 维声道—声门物理控制参数表（{{ filteredM27.length }} / 27 维）</strong>
                <div class="rep-filter-pills">
                  <button
                    v-for="tab in (['全部', '声道 17 维', '基频与肺压', '声门 8 维'] as const)"
                    :key="tab"
                    type="button"
                    class="btn xs"
                    :class="{ active: m27Filter === tab }"
                    @click="m27Filter = tab"
                  >
                    {{ tab }}
                  </button>
                </div>
              </div>
              <div class="rep-table-scroll">
                <table class="mini-tbl rep-tbl">
                  <thead>
                    <tr>
                      <th>下标</th>
                      <th>缩写</th>
                      <th>分组</th>
                      <th>下界</th>
                      <th>上界</th>
                      <th>单位</th>
                      <th>归一化</th>
                      <th>生理与声学意义</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="p in filteredM27" :key="p.idx">
                      <td class="mono">{{ p.idx }}</td>
                      <td class="mono"><strong>{{ p.code }}</strong></td>
                      <td><span class="tree-tag">{{ p.group }}</span></td>
                      <td class="mono">{{ p.min }}</td>
                      <td class="mono">{{ p.max }}</td>
                      <td class="mono">{{ p.unit }}</td>
                      <td class="mono muted">{{ p.norm }}</td>
                      <td class="muted">{{ p.meaning }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- 32D Universal IPA Feature Table -->
            <div class="rep-table-card selectable">
              <div class="rep-filter-bar">
                <strong>32 维通用国际音标发音特征表（{{ filteredIpa32.length }} / 32 维）</strong>
                <div class="rep-filter-pills">
                  <button
                    v-for="grp in IPA32_GROUPS"
                    :key="grp"
                    type="button"
                    class="btn xs"
                    :class="{ active: ipa32Filter === grp }"
                    @click="ipa32Filter = grp"
                  >
                    {{ grp }}
                  </button>
                </div>
              </div>
              <div class="rep-table-scroll">
                <table class="mini-tbl rep-tbl">
                  <thead>
                    <tr>
                      <th>下标</th>
                      <th>特征键名</th>
                      <th>分组</th>
                      <th>取值</th>
                      <th>代表音标</th>
                      <th>语音学意义</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="f in filteredIpa32" :key="f.idx">
                      <td class="mono">{{ f.idx }}</td>
                      <td class="mono"><strong>{{ f.key }}</strong></td>
                      <td><span class="tree-tag">{{ f.group }}</span></td>
                      <td class="mono">{{ f.range }}</td>
                      <td class="mono">{{ f.examples }}</td>
                      <td class="muted">{{ f.meaning }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <!-- Chapter 3: Detailed Neural Architectures (CNN / Conformer / RNN) -->
        <div id="repArch" class="panel">
          <div class="p-head">
            <span>3. 神经网络架构详解（CNN / Conformer / RNN 分层拆解）</span>
            <span class="tree-tag mono">Hybrid Physical-Neural Design</span>
          </div>
          <div class="p-body rep-body">
            <div class="rep-table-card selectable">
              <div class="param-sec-title">
                <span>自研模型网络层数与结构家族对照（直接核验自工程源码）</span>
                <span class="mono muted">Conv1d / BiLSTM / BiGRU / ConformerBlock</span>
              </div>
              <div class="rep-table-scroll">
                <table class="mini-tbl rep-tbl">
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th>阶段</th>
                      <th>参数量</th>
                      <th>架构家族</th>
                      <th>CNN 卷积层</th>
                      <th>RNN 层</th>
                      <th>Attention / Conformer</th>
                      <th>Linear 层</th>
                      <th>设计核心</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="a in MODEL_ARCHITECTURE_LAYERS" :key="a.name">
                      <td class="mono"><strong>{{ a.name }}</strong></td>
                      <td>{{ a.stage }}</td>
                      <td class="mono">{{ a.params }}</td>
                      <td class="mono">{{ a.family }}</td>
                      <td class="mono">{{ a.cnn }}</td>
                      <td class="mono">{{ a.rnn }}</td>
                      <td class="mono">{{ a.attention }}</td>
                      <td class="mono">{{ a.linear }}</td>
                      <td class="muted">{{ a.highlight }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <ModelArchDiagrams />
          </div>
        </div>

        <!-- Chapter 4: Expanded Corpus Inventory -->
        <div id="repDatasets" class="panel">
          <div class="p-head">
            <span>4. 扩充后训练与评测语料清单</span>
            <span class="tree-tag mono">{{ FULL_CORPUS_INVENTORY.length }} 项数据源 · 第三方原音频不随包</span>
          </div>
          <div class="p-body rep-body">
            <div class="rep-chart-grid-2">
              <TechChart
                title="图 2 · 180 小时全发声态物理合成语料分布"
                subtitle="170,550 条（179.89 h），另新增 20–1200 Hz 宽域合成与 12,000 条神经飞轮闭环语料"
                badge="170,550 条 · 8 模式"
                :height="325"
                :option-builder="buildSynth180hPieChart"
                caption="70.2% 单发声态 + 29.8% 句内多态余弦渐变；Batch-2 另有 45,136 条情感配音、京剧清唱、呼麦与喉声泛音真实语料（各库按原协议用于离线训练）。"
              />
              <div class="editorial-card rep-card selectable" style="justify-content: space-between">
                <div>
                  <strong style="font-size: 1rem">Batch-2 语料扩充重点与合规隔离</strong>
                  <ul class="rep-ul" style="margin-top: 8px">
                    <li><strong>多情感与配音大幅扩充</strong>：在原 ESD / Expresso 基础上新增 <code class="mono">EmotionTalk</code>（22.9 h）、<code class="mono">CSEMOTIONS</code>（9.6 h）、<code class="mono">EmoV-DB</code>（8.9 h）与 <code class="mono">RAVDESS</code>（1.7 h）。</li>
                    <li><strong>高音戏曲与特殊发声态补全</strong>：新增 <code class="mono">Jingju a Cappella 京剧清唱</code>（7,604 条 / 10.44 h）及 <code class="mono">EMVD / AVP / Beatbox / 图瓦呼麦与喉声泛音</code>（3,133 条 / 4.27 h），同步扩展 <code class="mono">20–1200 Hz</code> 宽域物理合成。</li>
                    <li><strong>窄标构型与神经飞轮</strong>：构建 293 键窄标库 <code class="mono">kf_dataset_narrow_v2</code>（63k 动腔 + 52k 韵律）与 12,000 条 <code class="mono">flywheel_large_v2_12k</code> 闭环数据。</li>
                    <li><strong>盲测隔离与版权边界</strong>：84 位验证说话人、USC-TIMIT EMA 276 条（0 条进训练）与 <code class="mono">Tract2Vox</code> 盲测用 236 条自录 IPA/VoQS 实录严格隔离；第三方训练语料均不随仓库与安装包再分发，亦不适用 GPL-3.0 再授权。</li>
                  </ul>
                </div>
                <div class="rep-callout-inline">
                  <IconSvg name="shield" :size="14" />
                  <span>训练脚本采用本地流式索引与分片缓存；复现者须分别遵循各原语料许可协议自行获取数据。</span>
                </div>
              </div>
            </div>

            <div class="rep-table-card selectable">
              <div class="rep-filter-bar">
                <strong>全量训练与评测数据源清单（{{ filteredCorpus.length }} / {{ FULL_CORPUS_INVENTORY.length }} 项）</strong>
                <div class="rep-filter-pills">
                  <button
                    v-for="cat in CORPUS_CATEGORIES"
                    :key="cat"
                    type="button"
                    class="btn xs"
                    :class="{ active: corpusFilter === cat }"
                    @click="corpusFilter = cat"
                  >
                    {{ cat }}
                  </button>
                </div>
              </div>
              <div class="rep-table-scroll">
                <table class="mini-tbl rep-tbl">
                  <thead>
                    <tr>
                      <th>数据集名称</th>
                      <th>类别</th>
                      <th>规模</th>
                      <th>时长 / 构成</th>
                      <th>服务模型</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="c in filteredCorpus" :key="c.name">
                      <td class="mono"><strong>{{ c.name }}</strong></td>
                      <td><span class="tree-tag">{{ c.category }}</span></td>
                      <td class="mono">{{ c.scale }}</td>
                      <td>{{ c.durationOrSpk }}</td>
                      <td class="mono">{{ c.usedBy }}</td>
                      <td class="muted">{{ c.notes }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <!-- Chapter 5: Batch-2 Latest Evaluation Results -->
        <div id="repBenchmarks" class="panel">
          <div class="p-head">
            <span>5. Batch-2 最新训练结果与实测评测</span>
            <span class="tree-tag mono">Verified Batch-2 Benchmarks</span>
          </div>
          <div class="p-body rep-body">
            <div class="rep-chart-grid-2">
              <TechChart
                title="图 3 · Vox2TractAlign v4 25 维声道与声门逐维实测 PCC"
                subtitle="未见自然语音声道均值 0.9108（TCX 0.9656 / LD 0.9557 / VO 0.9499），同模型中/英 ≤20ms 对齐达 93.0% / 94.9%"
                badge="9.40M · CPU 24.3 ms"
                :height="520"
                :option-builder="buildV4PerDimPccChart"
                caption="数据来自 runs/vox2tract_align_v4_flywheel/summary.json（best @8k）：宽域 20–1200 Hz 声门 PCC 达 0.9200，中文合法音节准 91.38%，静音 Mask F1 0.9889。"
              />
              <TechChart
                title="图 4 · 50 句离线 Whisper Large-v3-Turbo 双语可懂度门禁"
                subtitle="25 句 AISHELL-3 + 25 句 LibriSpeech：Lite v3 (3.73M) 达成 7.18% 全场最低均值错率，Large v2.1 L24 语义 0.8829 最高"
                badge="ASR Gate · 50 句"
                :height="520"
                :option-builder="buildWhisperAsrChart"
                caption="数据来自 runs/tract2vox_lite_v3/asr_gate/asr_gate_summary.json 与 runs/tract2vox_large_v2*：默认 Large v2.1 保真与发声态细节最佳，3.73M Lite v3 可作极速低占替代。"
              />
            </div>

            <div class="rep-chart-grid-2">
              <TechChart
                title="图 5 · Text2Prosody-Lite v4 (32D) 五域实测精度"
                subtitle="新增任意手写 [IPA] (LANG_IPA=3) 域，时长 MAE 21.44 ms，中/英朗读分别为 22.55 / 17.33 ms"
                badge="1.98M · CPU 1.5 ms"
                :height="355"
                :option-builder="buildProsodyV4Chart"
                caption="数据来自 runs/prosody_ipa_joint_v4_32d/summary.json（best @2.4k）：普通话 F0 PCC 0.7786，英语 0.6728，纯 IPA 0.5883。"
              />
              <TechChart
                title="图 6 · IPA2Tract-Lite v4 (32D) 真人 EMA 7 器官盲测"
                subtitle="USC-TIMIT 20 份零训练泄漏真人传感器记录；Clean 降误差 43.41%，宽域 20–1200 Hz 降误差 50.69%"
                badge="4.23M · 零泄漏 0.0"
                :height="355"
                :option-builder="buildEmaRadarChart"
                caption="数据来自 runs/prosody_ipa_joint_v4_32d/summary.json：脏上下文零泄漏 max_abs_diff = 0.0，唇开口 LD 0.7013，舌尖前后 TTX 0.6674。"
              />
            </div>

            <TechChart
              title="图 7 · Vox2Spk-v2.1 音色保真度与类间区分度实测对比"
              subtitle="常规人声保住 Teacher Cos 0.9422，女声歌唱 Gap 跃升至 0.3531（Top-1 46.2%），4 人 165 Hz 实时换声 Cos 0.8013 追平 94M 教师"
              badge="4.60M · CPU 4.3 ms"
              :height="320"
              :option-builder="buildVox2SpkChart"
              caption="数据来自 runs/vox2spk_v2_1/summary.json（best @4.2k）与 Tract2Vox-Large v2.1 端到端 4 人换声实测（margin +0.0649 领先 v2 的 +0.0589 与 v1 的 +0.0503）。"
            />
          </div>
        </div>

        <!-- Chapter 6: Engine Loading, ONNX Slot Contracts & Dialect Retraining -->
        <div id="repEngine" class="panel">
          <div class="p-head">
            <span>6. 引擎装载、ONNX 槽位契约与方言/多语种扩展</span>
            <span class="tree-tag mono">8 Core + 1 Optional Aligner</span>
          </div>
          <div class="p-body rep-body">
            <div class="settings-grid-2 selectable">
              <div class="editorial-card rep-card">
                <strong>8 项默认模型矩阵与可选独立对齐槽位</strong>
                <ul class="rep-ul">
                  <li><strong>联合反演对齐默认精简</strong>：<code class="mono">Vox2Tract-Lite</code> 挂载联合权重 <code class="mono">Vox2TractAlign v4</code> 后自动完成声道反演、静音门控与中英对齐，不再默认装载独立的 <code class="mono">Vox2Align-Lite v2</code>。</li>
                  <li><strong>保留小语种与方言自训入口</strong>：若研究者需要针对其他语种或方言自行训练对齐模型，可在「设置 → 声学引擎与模型」底部展开可选槽位 <code class="mono">Vox2Align-Lite v2</code> 并挂载自训 ONNX，启用后自动接管对齐。</li>
                  <li><strong>一键换模与严格校验</strong>：支持单槽换模与目录批量扫描（本机路径上限 256 MiB，浏览器上传上限 64 MiB），状态持久写入 <code class="mono">.cache/local-model-registry.json</code>。</li>
                </ul>
                <div style="margin-top: 6px">
                  <button type="button" class="btn primary sm" @click="store.openOverlay('settings', 'engine')">
                    <IconSvg name="cpu" :size="13" />
                    <span>前往「本地轻量化模型矩阵」装载 / 换模</span>
                  </button>
                </div>
              </div>
              <div class="editorial-card rep-card">
                <strong>自定义导出兼容 ONNX 的 4 条核心规则</strong>
                <ul class="rep-ul">
                  <li><strong>纯 ONNX 算子</strong>：导出前移除 <code class="mono">weight_norm</code>，避免复数 STFT 与图内随机数（声码器噪声由 <code class="mono">env_rand</code>、<code class="mono">n_wb</code> 显式传入）。</li>
                  <li><strong>动态时间与批维</strong>：保留动态 <code class="mono">B</code> 与帧长 <code class="mono">T</code>（或音素长 <code class="mono">L</code>），特征尾维精确匹配下表契约。</li>
                  <li><strong>权重存储格式</strong>：大权重建议导出 FP16 存储 + FP32 算子计算（误差 &lt; 1e-3），截面积代理 <code class="mono">Tract2Area-Proxy</code> 保持 FP32。</li>
                  <li><strong>平滑降级</strong>：卸载 <code class="mono">Text2Prosody-Lite</code> 退回规则韵律，卸载 <code class="mono">IPA2Tract-Lite</code> 退回 qTA 基线，卸载 <code class="mono">Tract2Vox-Lite</code> 保留 VTL 物理发声。</li>
                </ul>
              </div>
            </div>

            <!-- Slot Contracts Table -->
            <div class="rep-table-card selectable">
              <div class="param-sec-title">
                <span>ONNX 槽位输入输出张量契约（8 项核心 + 1 项可选方言对齐槽位）</span>
                <span class="mono muted">engine/model_registry_runtime.py</span>
              </div>
              <div class="rep-table-scroll">
                <table class="mini-tbl rep-tbl">
                  <thead>
                    <tr>
                      <th>槽位名称</th>
                      <th>输入张量契约</th>
                      <th>输出张量契约</th>
                      <th>目录匹配关键词</th>
                      <th>降级与扩展说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="c in ONNX_SLOT_CONTRACTS" :key="c.slug">
                      <td class="mono">
                        <strong>{{ c.name }}</strong>
                        <span v-if="c.optionalNote" class="tree-tag" style="margin-left: 6px">可选扩展</span>
                      </td>
                      <td class="mono">{{ c.inputs }}</td>
                      <td class="mono">{{ c.outputs }}</td>
                      <td class="mono muted">{{ c.patterns }}</td>
                      <td class="muted">{{ c.fallback }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- Concise Retraining Recipes -->
            <div class="rep-recipe-list">
              <div v-for="rec in RETRAINING_RECIPES" :key="rec.id" class="editorial-card rep-recipe-card selectable">
                <div class="lesson-head">
                  <strong style="font-size: 0.98rem">{{ rec.scenario }}</strong>
                  <span class="tree-tag">{{ rec.difficulty }}</span>
                </div>
                <div class="rep-meta-line">
                  <span><strong>目标模型：</strong><code class="mono">{{ rec.targetModels }}</code></span>
                  <span><strong>语料与算力：</strong>{{ rec.corpusReq }}</span>
                </div>
                <ol class="rep-ol">
                  <li v-for="(s, sIdx) in rec.steps" :key="sIdx">{{ s }}</li>
                </ol>
                <div class="rep-code-box">
                  <div class="rep-code-head">
                    <span class="mono muted">复现与微调命令</span>
                    <button type="button" class="btn xs" @click="copyCode(rec.id, rec.commands)">
                      <span>{{ copiedId === rec.id ? '已复制' : '复制命令' }}</span>
                    </button>
                  </div>
                  <pre class="mono rep-pre"><code>{{ rec.commands }}</code></pre>
                </div>
              </div>
            </div>

            <!-- REST Endpoints -->
            <div class="rep-table-card selectable">
              <div class="param-sec-title">
                <span>热插拔与外置模型装载 HTTP API</span>
                <span class="mono muted">Node Proxy → Python Engine</span>
              </div>
              <div class="rep-table-scroll">
                <table class="mini-tbl rep-tbl">
                  <thead>
                    <tr>
                      <th>方法</th>
                      <th>接口路径</th>
                      <th>功能职责</th>
                      <th>载荷 / 返回说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="ep in ENGINE_LOADING_ENDPOINTS" :key="ep.path">
                      <td><span class="tree-tag mono">{{ ep.method }}</span></td>
                      <td class="mono"><strong>{{ ep.path }}</strong></td>
                      <td>{{ ep.purpose }}</td>
                      <td class="mono muted">{{ ep.payload }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.rep-nav-caption {
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

.rep-nav-footer {
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px solid var(--panel-border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rep-pane {
  max-width: 1380px;
  margin: 0 auto;
  padding-bottom: 28px;
}

.rep-body {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.rep-hero-card {
  border-left: 3px solid var(--accent);
  box-shadow: none;
  gap: 8px;
}

.rep-p {
  margin: 0;
  font-size: 0.93rem;
  line-height: 1.62;
}

.rep-kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 8px;
  margin-top: 4px;
}

.rep-kpi-box {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 11px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  font-size: 0.85rem;
}

.rep-kpi-box strong {
  font-size: 1.03rem;
  color: var(--accent);
}

.rep-card {
  box-shadow: none;
  gap: 6px;
}

.rep-ul {
  margin: 4px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 0.91rem;
  line-height: 1.6;
  color: var(--muted);
}

.rep-ul strong {
  color: var(--text);
}

.rep-chart-grid-2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(520px, 1fr));
  gap: 12px;
}

.rep-arch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(460px, 1fr));
  gap: 12px;
}

.rep-arch-card {
  box-shadow: none;
  gap: 8px;
}

.rep-arch-flow {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rep-arch-step {
  padding: 7px 10px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rep-arch-step.accent {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--panel-border));
  background: color-mix(in srgb, var(--selected) 48%, var(--ctrl-bg));
}

.rep-arch-step-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.9rem;
}

.rep-arch-step-detail {
  font-size: 0.85rem;
  line-height: 1.5;
  padding-left: 28px;
}

.rep-table-card {
  padding: 11px 13px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 45%, transparent);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rep-table-scroll {
  overflow-x: auto;
}

.rep-tbl th,
.rep-tbl td {
  padding: 6px 9px;
  font-size: 0.88rem;
  line-height: 1.48;
  vertical-align: top;
}

.rep-filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 0.94rem;
}

.rep-filter-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.rep-callout-inline {
  margin-top: 8px;
  padding: 7px 10px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  border-left: 3px solid var(--accent);
  background: color-mix(in srgb, var(--selected) 40%, transparent);
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 0.86rem;
  color: var(--text);
}

.lesson-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.lesson-idx {
  font-size: 0.8rem;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--selected);
  color: var(--accent);
  font-weight: 700;
}

.rep-recipe-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rep-recipe-card {
  box-shadow: none;
  gap: 8px;
}

.rep-meta-line {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 0.89rem;
  color: var(--muted);
}

.rep-meta-line strong {
  color: var(--text);
}

.rep-ol {
  margin: 2px 0 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.9rem;
  line-height: 1.58;
  color: var(--text);
}

.rep-code-box {
  border: 1px solid var(--panel-border);
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--sidebar) 86%, var(--app));
  overflow: hidden;
}

.rep-code-head {
  padding: 5px 10px;
  border-bottom: 1px solid var(--panel-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.82rem;
}

.rep-pre {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  font-size: 0.84rem;
  line-height: 1.55;
  color: var(--text);
}

/* Vector Architecture SVG */
.rep-svg-box {
  padding: 11px 13px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 48%, transparent);
}

.rep-flow-svg {
  width: 100%;
  height: auto;
  display: block;
  margin-top: 6px;
  color: var(--muted);
}

.svg-node {
  fill: var(--ctrl-bg);
  stroke: var(--panel-border);
  stroke-width: 1.2;
}

.svg-node.accent {
  fill: color-mix(in srgb, var(--selected) 58%, var(--panel));
  stroke: var(--accent);
}

.svg-node.primary {
  fill: color-mix(in srgb, var(--accent) 14%, var(--panel));
  stroke: var(--accent);
  stroke-width: 1.6;
}

.svg-node.subtle {
  fill: color-mix(in srgb, var(--app) 68%, var(--panel));
  stroke-dasharray: 4 3;
}

.svg-title {
  fill: var(--text);
  font-size: 12px;
  font-weight: 700;
  text-anchor: middle;
}

.svg-sub {
  fill: var(--muted);
  font-size: 10.5px;
  text-anchor: middle;
}

.svg-arrow {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
  opacity: 0.85;
}

.svg-arrow.dashed {
  stroke: var(--muted);
  stroke-dasharray: 5 4;
}
</style>
