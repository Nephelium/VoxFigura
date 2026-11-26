<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { EChartsCoreOption } from 'echarts/core';
import { APP_BRAND_NAME } from '@/data/app-branding';
import {
  ENGINE_LOADING_ENDPOINTS,
  FULL_CORPUS_INVENTORY,
  FULL_MODEL_ZOO,
  LOCAL_MODEL_SPECS,
  LOCAL_MODEL_TOTALS,
  M27_PARAMETER_SPECS,
  MODEL_TRAINING_REPORT_META,
  ONNX_SLOT_CONTRACTS,
  RETRAINING_RECIPES,
  SYNTH_180H_MODES,
  TRAINING_CURVES,
  TRAINING_EXPERIENCE_HIGHLIGHTS,
  buildTrainingReportMarkdown,
  type CorpusRow,
} from '@/data/model-training-report';
import { useWorkbenchStore } from '@/stores/workbench';
import IconSvg from '@/components/common/IconSvg.vue';
import TechChart, { type ChartThemeTokens } from '@/components/charts/TechChart.vue';

const store = useWorkbenchStore();
const reportScrollRef = ref<HTMLElement | null>(null);
const activeSec = ref('repOverview');
const corpusFilter = ref<'全部' | CorpusRow['category']>('全部');
const m27Filter = ref<'全部' | '声道 17 维' | '基频与肺压' | '声门 8 维'>('全部');
const copiedId = ref<string | null>(null);

const NAV_ITEMS = [
  { id: 'repOverview', icon: 'cpu', label: '1. 模型体系与总览' },
  { id: 'repSpace', icon: 'sliders', label: '2. 27 维物理空间与时间契约' },
  { id: 'repDatasets', icon: 'folder-open', label: '3. 全量训练数据集清单' },
  { id: 'repTraining', icon: 'timeline', label: '4. 训练过程与实测曲线' },
  { id: 'repBenchmarks', icon: 'reconstruct', label: '5. 双语评测与真人盲测' },
  { id: 'repLessons', icon: 'warn', label: '6. 十大核心工程复盘' },
  { id: 'repRetrain', icon: 'book', label: '7. 外部语料二次训练手册' },
  { id: 'repEngine', icon: 'stage', label: '8. 引擎装载、契约与换模' },
] as const;

const CORPUS_CATEGORIES: ReadonlyArray<'全部' | CorpusRow['category']> = [
  '全部',
  '本地物理合成',
  '公开朗读/方言',
  '公开情感/表现',
  '公开干声歌唱',
  '真人传感盲测',
  '派生任务缓存',
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
  a.download = 'VoxFigura_Model_Training_Technical_Report.md';
  a.click();
  URL.revokeObjectURL(url);
  store.pushToast('已导出完整模型训练与技术报告 Markdown', 'success');
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
 * 9 ECharts Option Builders (100% Real Verified Data)
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

/** Chart 1: 9 Local ONNX Models — Params, Disk Size & CPU Latency */
function buildOnnxBudgetChart(t: ChartThemeTokens): EChartsCoreOption {
  const names = LOCAL_MODEL_SPECS.map((m) => m.name);
  return {
    tooltip: { ...baseTooltip(t), trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: baseLegend(t),
    grid: { left: 56, right: 60, top: 86, bottom: 72 },
    xAxis: {
      type: 'category',
      data: names,
      axisLabel: { color: t.muted, fontSize: 10.5, rotate: 20, interval: 0 },
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
        name: 'CPU 延迟 (ms)',
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
        barMaxWidth: 18,
        itemStyle: { color: t.series[0], borderRadius: [4, 4, 0, 0] },
        data: LOCAL_MODEL_SPECS.map((m) => m.sizeMb),
      },
      {
        name: '参数量 (M)',
        type: 'bar',
        barMaxWidth: 18,
        itemStyle: { color: t.series[1], borderRadius: [4, 4, 0, 0] },
        data: LOCAL_MODEL_SPECS.map((m) => m.paramsM),
      },
      {
        name: '端到端评测 CPU 均值 (ms)',
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
        itemStyle: {
          borderRadius: 5,
          borderColor: t.panel,
          borderWidth: 2,
        },
        label: {
          show: true,
          color: t.text,
          fontSize: 10.5,
          formatter: '{d}%',
        },
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

/** Chart 3: Vox2Tract-Large Anchored vs Unanchored Ablation Curves */
function buildInverterAnchorChart(t: ChartThemeTokens): EChartsCoreOption {
  const anchoredTract = TRAINING_CURVES.inverterAnchoredSteps.map((s, i) => [s, TRAINING_CURVES.inverterAnchoredTract[i]]);
  const anchoredGlot = TRAINING_CURVES.inverterAnchoredSteps.map((s, i) => [s, TRAINING_CURVES.inverterAnchoredGlottis[i]]);
  const unanchoredTract = TRAINING_CURVES.inverterUnanchoredSteps.map((s, i) => [s, TRAINING_CURVES.inverterUnanchoredTract[i]]);
  const unanchoredGlot = TRAINING_CURVES.inverterUnanchoredSteps.map((s, i) => [s, TRAINING_CURVES.inverterUnanchoredGlottis[i]]);
  return {
    tooltip: { ...baseTooltip(t), trigger: 'axis' },
    legend: baseLegend(t),
    grid: { left: 52, right: 24, top: 82, bottom: 42 },
    xAxis: {
      type: 'value',
      name: '训练步数 (Step)',
      nameLocation: 'middle',
      nameGap: 25,
      min: 0,
      max: 32000,
      nameTextStyle: { color: t.muted, fontSize: 11 },
      axisLabel: { color: t.muted, fontSize: 11, formatter: (v: number) => `${v / 1000}k` },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    yAxis: {
      type: 'value',
      name: '物理 PCC',
      nameGap: 14,
      min: 0.35,
      max: 0.96,
      nameTextStyle: { color: t.muted, fontSize: 11 },
      axisLabel: { color: t.muted, fontSize: 11 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    series: [
      {
        name: '双通锚定 · 声门 8 维',
        type: 'line',
        smooth: 0.25,
        symbolSize: 5,
        lineStyle: { width: 2.5, color: t.series[1] },
        itemStyle: { color: t.series[1] },
        data: anchoredGlot,
      },
      {
        name: '双通锚定 · 声道 17 维',
        type: 'line',
        smooth: 0.25,
        symbolSize: 6,
        lineStyle: { width: 2.8, color: t.series[0] },
        itemStyle: { color: t.series[0] },
        markPoint: {
          symbolSize: 42,
          label: { fontSize: 10, color: '#fff' },
          data: [{ coord: [26500, 0.82], value: '0.820', itemStyle: { color: t.series[0] } }],
        },
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { type: 'dashed', color: t.muted },
          label: {
            color: t.muted,
            fontSize: 10.5,
            position: 'insideStartBottom',
            distance: 8,
            formatter: '18k 多风格热重启',
          },
          data: [{ xAxis: 18000 }],
        },
        data: anchoredTract,
      },
      {
        name: '无锚定消融 · 声门（漂移）',
        type: 'line',
        smooth: 0.2,
        symbol: 'diamond',
        symbolSize: 6,
        lineStyle: { width: 2, type: 'dashed', color: t.series[2] },
        itemStyle: { color: t.series[2] },
        data: unanchoredGlot,
      },
      {
        name: '无锚定消融 · 声道（坍塌）',
        type: 'line',
        smooth: 0.2,
        symbol: 'diamond',
        symbolSize: 6,
        lineStyle: { width: 2.2, type: 'dashed', color: t.series[6] },
        itemStyle: { color: t.series[6] },
        data: unanchoredTract,
      },
    ],
  };
}

/** Chart 4: Vox2Tract-Large 25-Dim Per-Parameter PCC */
function buildPerDimPccChart(t: ChartThemeTokens): EChartsCoreOption {
  const rows = [...TRAINING_CURVES.perDimPcc].reverse();
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
        return `<b>${item.name}</b>（${src.group}）<br/>实测 PCC：<b>${item.value.toFixed(4)}</b>`;
      },
    },
    grid: { left: 54, right: 48, top: 20, bottom: 32 },
    xAxis: {
      type: 'value',
      min: 0.55,
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

/** Chart 5: Vocoder Large vs Lite Convergence Curves */
function buildVocoderCurveChart(t: ChartThemeTokens): EChartsCoreOption {
  return {
    tooltip: { ...baseTooltip(t), trigger: 'axis' },
    legend: baseLegend(t),
    grid: { left: 54, right: 54, top: 88, bottom: 42 },
    xAxis: {
      type: 'value',
      name: '训练步数 (Step)',
      nameLocation: 'middle',
      nameGap: 25,
      min: 2000,
      max: 32000,
      nameTextStyle: { color: t.muted, fontSize: 11 },
      axisLabel: { color: t.muted, fontSize: 11, formatter: (v: number) => `${v / 1000}k` },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    yAxis: [
      {
        type: 'value',
        name: 'val_score ↓',
        nameGap: 14,
        min: 0,
        max: 0.36,
        nameTextStyle: { color: t.muted, fontSize: 11, align: 'left', padding: [0, 0, 0, -24] },
        axisLabel: { color: t.muted, fontSize: 11 },
        splitLine: { lineStyle: { color: t.gridLine } },
      },
      {
        type: 'value',
        name: 'WavLM L24 ↑',
        nameGap: 14,
        min: 0.65,
        max: 0.92,
        nameTextStyle: { color: t.muted, fontSize: 11, align: 'right', padding: [0, -24, 0, 0] },
        axisLabel: { color: t.muted, fontSize: 11 },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: 'Large · score',
        type: 'line',
        smooth: 0.2,
        symbolSize: 5,
        lineStyle: { width: 2.5, color: t.series[0] },
        itemStyle: { color: t.series[0] },
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { type: 'dashed', color: t.series[0], opacity: 0.7 },
          label: {
            color: t.text,
            fontSize: 10,
            position: 'insideEndTop',
            distance: 6,
            formatter: '28k 低LR精调',
          },
          data: [{ xAxis: 28000 }],
        },
        data: TRAINING_CURVES.vocoderLargeSteps.map((s, i) => [s, TRAINING_CURVES.vocoderLargeScore[i]]),
      },
      {
        name: 'Lite · score',
        type: 'line',
        smooth: 0.2,
        symbolSize: 6,
        lineStyle: { width: 2.5, color: t.series[2] },
        itemStyle: { color: t.series[2] },
        markPoint: {
          symbolSize: 40,
          label: { fontSize: 10, color: '#fff' },
          data: [{ coord: [17000, 0.0626], value: '@17k', itemStyle: { color: t.series[2] } }],
        },
        data: TRAINING_CURVES.vocoderLiteSteps.map((s, i) => [s, TRAINING_CURVES.vocoderLiteScore[i]]),
      },
      {
        name: 'Large · L24',
        type: 'line',
        yAxisIndex: 1,
        smooth: 0.25,
        symbol: 'none',
        lineStyle: { width: 2, type: 'dashed', color: t.series[1] },
        itemStyle: { color: t.series[1] },
        data: TRAINING_CURVES.vocoderLargeSteps.map((s, i) => [s, TRAINING_CURVES.vocoderLargeL24[i]]),
      },
      {
        name: 'Lite · L24',
        type: 'line',
        yAxisIndex: 1,
        smooth: 0.25,
        symbol: 'none',
        lineStyle: { width: 2, type: 'dashed', color: t.series[4] },
        itemStyle: { color: t.series[4] },
        data: TRAINING_CURVES.vocoderLiteSteps.map((s, i) => [s, TRAINING_CURVES.vocoderLiteL24[i]]),
      },
    ],
  };
}

/** Chart 6: IPA2Tract-Lite Human EMA 7-Articulator Radar */
function buildEmaRadarChart(t: ChartThemeTokens): EChartsCoreOption {
  return {
    tooltip: { ...baseTooltip(t), trigger: 'item' },
    radar: {
      radius: '55%',
      center: ['50%', '53%'],
      splitNumber: 4,
      axisNameGap: 8,
      axisName: { color: t.text, fontSize: 11, fontWeight: 600 },
      splitLine: { lineStyle: { color: t.gridLine } },
      splitArea: { areaStyle: { color: ['transparent', t.isDark ? 'rgba(148,163,184,0.04)' : 'rgba(15,23,42,0.03)'] } },
      axisLine: { lineStyle: { color: t.border } },
      indicator: TRAINING_CURVES.emaRadar.map((r) => ({ name: r.axis, max: 0.8 })),
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
            value: TRAINING_CURVES.emaRadar.map((r) => r.pcc),
            name: 'IPA2Tract-Lite (20 份未见真人测试文件)',
          },
        ],
      },
    ],
  };
}

/** Chart 7A: Vox2Align-Lite v2 20k Training Curve */
function buildAlignV2Chart(t: ChartThemeTokens): EChartsCoreOption {
  return {
    tooltip: { ...baseTooltip(t), trigger: 'axis', valueFormatter: (v: unknown) => `${Number(v).toFixed(2)}%` },
    legend: { ...baseLegend(t), itemGap: 10 },
    grid: { left: 50, right: 20, top: 90, bottom: 36 },
    xAxis: {
      type: 'category',
      data: TRAINING_CURVES.alignV2Steps.map((s) => `${s / 1000}k`),
      axisLabel: { color: t.muted, fontSize: 11 },
      axisLine: { lineStyle: { color: t.border } },
    },
    yAxis: {
      type: 'value',
      name: '准确率 / 命中率',
      nameGap: 12,
      min: 74,
      max: 100,
      nameTextStyle: { color: t.muted, fontSize: 11, align: 'left', padding: [0, 0, 0, -24] },
      axisLabel: { color: t.muted, fontSize: 11, formatter: '{value}%' },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    series: [
      {
        name: '静音 Mask F1',
        type: 'line',
        smooth: true,
        symbolSize: 5,
        lineStyle: { width: 2.4, color: t.series[1] },
        itemStyle: { color: t.series[1] },
        data: [...TRAINING_CURVES.alignV2MaskF1],
      },
      {
        name: '英语 ≤20ms',
        type: 'line',
        smooth: true,
        symbolSize: 5,
        lineStyle: { width: 2.3, color: t.series[0] },
        itemStyle: { color: t.series[0] },
        data: [...TRAINING_CURVES.alignV2EnBnd20],
      },
      {
        name: '中文 ≤20ms',
        type: 'line',
        smooth: true,
        symbolSize: 5,
        lineStyle: { width: 2.3, color: t.series[5] },
        itemStyle: { color: t.series[5] },
        data: [...TRAINING_CURVES.alignV2ZhBnd20],
      },
      {
        name: '中文音节准',
        type: 'line',
        smooth: true,
        symbolSize: 5,
        lineStyle: { width: 2.3, color: t.series[2] },
        itemStyle: { color: t.series[2] },
        data: [...TRAINING_CURVES.alignV2ZhSyl],
      },
      {
        name: '中文帧准',
        type: 'line',
        smooth: true,
        symbolSize: 4,
        lineStyle: { width: 1.8, type: 'dashed', color: t.series[4] },
        itemStyle: { color: t.series[4] },
        data: [...TRAINING_CURVES.alignV2ZhFrame],
      },
      {
        name: '英语帧准',
        type: 'line',
        smooth: true,
        symbolSize: 4,
        lineStyle: { width: 1.8, type: 'dashed', color: t.series[3] },
        itemStyle: { color: t.series[3] },
        data: [...TRAINING_CURVES.alignV2EnFrame],
      },
    ],
  };
}

/** Chart 7B: Text2Prosody-Lite 4-Domain Metrics */
function buildProsodyDomainChart(t: ChartThemeTokens): EChartsCoreOption {
  const rows = TRAINING_CURVES.prosodyDomains;
  return {
    tooltip: { ...baseTooltip(t), trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: baseLegend(t),
    grid: { left: 52, right: 52, top: 84, bottom: 52 },
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
        max: 48,
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
        barMaxWidth: 28,
        itemStyle: { color: t.series[0], borderRadius: [5, 5, 0, 0] },
        label: { show: true, position: 'top', distance: 6, color: t.muted, fontSize: 10.5, formatter: '{c} ms' },
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

/** Chart 8: 8-Clip End-to-End Audition Benchmark */
function buildAudition8Chart(t: ChartThemeTokens): EChartsCoreOption {
  const rows = TRAINING_CURVES.audition8Clips;
  return {
    tooltip: { ...baseTooltip(t), trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { ...baseLegend(t), itemGap: 12 },
    grid: { left: 50, right: 20, top: 88, bottom: 48 },
    xAxis: {
      type: 'category',
      data: rows.map((r) => r.label),
      axisLabel: { color: t.muted, fontSize: 10.5, interval: 0, rotate: 16 },
      axisLine: { lineStyle: { color: t.border } },
    },
    yAxis: {
      type: 'value',
      name: '余弦相似度',
      nameGap: 14,
      min: 0.65,
      max: 0.98,
      nameTextStyle: { color: t.muted, fontSize: 11, align: 'left', padding: [0, 0, 0, -22] },
      axisLabel: { color: t.muted, fontSize: 11 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    series: [
      {
        name: '教师 Large (L24)',
        type: 'bar',
        barMaxWidth: 14,
        itemStyle: { color: t.series[0], borderRadius: [4, 4, 0, 0] },
        data: rows.map((r) => r.teacherL24),
      },
      {
        name: '紧凑 Lite (L24)',
        type: 'bar',
        barMaxWidth: 14,
        itemStyle: { color: t.series[1], borderRadius: [4, 4, 0, 0] },
        data: rows.map((r) => r.liteL24),
      },
      {
        name: '端侧闭环 E2E (L24)',
        type: 'bar',
        barMaxWidth: 14,
        itemStyle: { color: t.series[4], borderRadius: [4, 4, 0, 0] },
        data: rows.map((r) => r.e2eL24),
      },
      {
        name: '端侧声纹 (Spk Cos)',
        type: 'line',
        smooth: true,
        symbolSize: 7,
        lineStyle: { width: 2.4, color: t.series[2] },
        itemStyle: { color: t.series[2] },
        data: rows.map((r) => r.e2eSpk),
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
        <!-- Hero Overview Card -->
        <div id="repOverview" class="panel">
          <div class="p-head">
            <span>{{ APP_BRAND_NAME }} · 模型训练与技术报告</span>
            <span class="tree-tag mono">{{ MODEL_TRAINING_REPORT_META.version }}</span>
          </div>
          <div class="p-body rep-body">
            <div class="editorial-card rep-hero-card selectable">
              <strong style="font-size: 1.08rem">{{ MODEL_TRAINING_REPORT_META.suiteName }}</strong>
              <p class="muted rep-p">
                {{ MODEL_TRAINING_REPORT_META.updatedNote }}
              </p>
              <div class="rep-kpi-grid">
                <div class="rep-kpi-box">
                  <span class="muted">本地纯 ONNX 矩阵</span>
                  <strong class="mono">{{ LOCAL_MODEL_TOTALS.count }} 模 · {{ LOCAL_MODEL_TOTALS.totalSizeText }}</strong>
                  <span class="muted">{{ LOCAL_MODEL_TOTALS.totalParamsText }} 参数 · 零 PyTorch 依赖</span>
                </div>
                <div class="rep-kpi-box">
                  <span class="muted">物理可控合成语料</span>
                  <strong class="mono">270.05 小时</strong>
                  <span class="muted">180h 全发声态 27 维 + 90h 早期 22 维升格</span>
                </div>
                <div class="rep-kpi-box">
                  <span class="muted">自然与表现性训练语料</span>
                  <strong class="mono">168k+ 句 / 495 人</strong>
                  <span class="muted">AISHELL-3 / LibriSpeech / ESD / Expresso / 歌唱</span>
                </div>
                <div class="rep-kpi-box">
                  <span class="muted">训练硬件与基准几何</span>
                  <strong class="mono">RTX 5090 24G · JD2</strong>
                  <span class="muted">65 截面声道 · 50 Hz 控制 · 48 kHz 输出</span>
                </div>
              </div>
            </div>

            <!-- System Evolution Vector Pipeline SVG -->
            <div class="rep-svg-box">
              <div class="param-sec-title">
                <span>系统四代演进与旗舰向端侧 ONNX 蒸馏拓扑</span>
                <span class="mono muted">Vector Architecture Diagram</span>
              </div>
              <svg class="rep-flow-svg" viewBox="0 0 980 218" role="img" aria-label="模型家族演进与蒸馏拓扑图">
                <defs>
                  <marker id="repArr" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="currentColor" />
                  </marker>
                </defs>
                <!-- Column 1: Data Sources -->
                <rect x="12" y="16" width="196" height="58" rx="8" class="svg-node accent" />
                <text x="110" y="39" class="svg-title">VTL JD2 物理合成引擎</text>
                <text x="110" y="59" class="svg-sub">180h 全发声态 + 90h 早期基线</text>

                <rect x="12" y="92" width="196" height="58" rx="8" class="svg-node" />
                <text x="110" y="115" class="svg-title">多语种自然与表现性语料</text>
                <text x="110" y="135" class="svg-sub">朗读 · 情感 · 干声歌唱 · TIMIT</text>

                <rect x="12" y="164" width="196" height="42" rx="8" class="svg-node subtle" />
                <text x="110" y="189" class="svg-sub">USC-TIMIT 真人 EMA (276 条盲测)</text>

                <!-- Column 2: Flagship Teachers -->
                <rect x="264" y="16" width="214" height="72" rx="8" class="svg-node" />
                <text x="371" y="39" class="svg-title">旗舰教师链 (RTX 5090)</text>
                <text x="371" y="57" class="svg-sub">Vox2Tract-PR + Tract2Feat-Proxy</text>
                <text x="371" y="74" class="svg-sub">Vox2Tract-Large (22.62M) 双通锚定</text>

                <rect x="264" y="106" width="214" height="54" rx="8" class="svg-node" />
                <text x="371" y="129" class="svg-title">Tract2Vox-Large (14.36M)</text>
                <text x="371" y="148" class="svg-sub">Glottis-NSF v3 + 512 维声纹 FiLM</text>

                <!-- Column 3: Shared Cache -->
                <rect x="530" y="16" width="178" height="144" rx="8" class="svg-node accent" />
                <text x="619" y="54" class="svg-title">共享蒸馏与任务缓存</text>
                <text x="619" y="76" class="svg-sub">60k 蒸馏 (7.48 GB RAM)</text>
                <text x="619" y="96" class="svg-sub">91k 关键帧协同动腔</text>
                <text x="619" y="116" class="svg-sub">70k 双语对齐 · 52k 韵律</text>
                <text x="619" y="136" class="svg-sub">300k 管面积采样真值</text>

                <!-- Column 4: Complete 9 Local ONNX Runtime Matrix -->
                <rect x="752" y="10" width="218" height="198" rx="10" class="svg-node primary" />
                <text x="861" y="31" class="svg-title">端侧纯 ONNX 9 模矩阵</text>
                <text x="861" y="50" class="svg-sub">Vox2Tract-Lite (7.64M)</text>
                <text x="861" y="66" class="svg-sub">Vox2Align-Lite v2 (4.33M)</text>
                <text x="861" y="82" class="svg-sub">IPA2Tract-Lite (4.23M)</text>
                <text x="861" y="98" class="svg-sub">Tract2Vox-Lite (3.72M)</text>
                <text x="861" y="114" class="svg-sub">Vox2Spk-Lite (2.90M)</text>
                <text x="861" y="130" class="svg-sub">Text2Prosody-Lite (1.98M)</text>
                <text x="861" y="146" class="svg-sub">Tract2Area-Proxy (0.23M)</text>
                <text x="861" y="162" class="svg-sub">DPDFNet (2.58M) · SwiftF0 (0.03M)</text>
                <text x="861" y="190" class="svg-sub">{{ LOCAL_MODEL_TOTALS.totalParamsText }} · {{ LOCAL_MODEL_TOTALS.totalSizeText }} · 热插拔</text>

                <!-- Arrows -->
                <path d="M 208 45 L 260 45" class="svg-arrow" marker-end="url(#repArr)" />
                <path d="M 208 118 L 236 118 L 236 64 L 260 64" class="svg-arrow" marker-end="url(#repArr)" />
                <path d="M 208 130 L 260 130" class="svg-arrow" marker-end="url(#repArr)" />
                <path d="M 478 46 L 526 46" class="svg-arrow" marker-end="url(#repArr)" />
                <path d="M 478 132 L 504 132 L 504 82 L 526 82" class="svg-arrow" marker-end="url(#repArr)" />
                <path d="M 708 86 L 748 86" class="svg-arrow" marker-end="url(#repArr)" />
                <path d="M 208 185 L 748 185" class="svg-arrow dashed" marker-end="url(#repArr)" />
              </svg>
            </div>

            <!-- Chart 1: Local 9 ONNX Budget -->
            <TechChart
              title="图 1 · 本地 9 项纯 ONNX 模型体积、参数量与 CPU 端到端评测耗时"
              subtitle="零 PyTorch 运行时依赖，合计 58.96 MiB；折线展示含特征与后处理的端到端评测均值"
              badge="9 ONNX · 58.96 MiB"
              :height="325"
              :option-builder="buildOnnxBudgetChart"
              :caption="`文件体积核实自 engine/model_bundle/**/*.onnx；${MODEL_TRAINING_REPORT_META.cpuBenchmarkProtocol}`"
            />

            <!-- Full Model Zoo Table -->
            <div class="rep-table-card selectable">
              <div class="param-sec-title">
                <span>关联模型总表（Model Zoo · 14 项）</span>
                <span class="mono muted">旗舰教师 + 端侧 ONNX + 历史归档</span>
              </div>
              <div class="rep-table-scroll">
                <table class="mini-tbl rep-tbl">
                  <thead>
                    <tr>
                      <th>官方模型名</th>
                      <th>层级</th>
                      <th>核心网络结构</th>
                      <th>参数量</th>
                      <th>导出体积</th>
                      <th>训练步数与状态</th>
                      <th>核心实测指标</th>
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

        <!-- Chapter 2: Physical Control Space & Grid Contract -->
        <div id="repSpace" class="panel">
          <div class="p-head">
            <span>2. 27 维声道—声门物理控制空间与严格时间网格对齐</span>
            <span class="tree-tag mono">50 Hz ↔ 200 Hz ↔ 48 kHz</span>
          </div>
          <div class="p-body rep-body">
            <div class="settings-grid-2 selectable">
              <div class="editorial-card rep-card">
                <strong>三频同步无半帧漂移时间契约</strong>
                <ul class="rep-ul">
                  <li><strong>分析侧（16 kHz / 50 Hz）</strong>：帧移严格锁定 <code class="mono">320</code> 样点（20 ms），单条有效音频截断为 <code class="mono">T × 320</code> 样点。</li>
                  <li><strong>前端中心对称锁相</strong>：<code class="mono">PureLogMel50Hz</code> 采用 <code class="mono">n_fft=1024, win=640, hop=320, center=False</code> 并手动左右各反射填充 <code class="mono">352</code> 样点，使每帧中心精确落在 <code class="mono">(k+0.5)×320</code>，与 WavLM 25 层感受野 1:1 锁相。</li>
                  <li><strong>物理管段与输出（200 Hz → 48 kHz）</strong>：50 Hz 轨按帧心升频至 200 Hz（每 5 ms 步进 240 样点）驱动 VTL 2.4 生成 48 kHz 波形；时间坐标全仓使用 48 kHz 整数采样与半开区间 <code class="mono">[start_smp, end_smp)</code>。</li>
                </ul>
              </div>
              <div class="editorial-card rep-card">
                <strong>27 维声道—声门参数与 IPA2Tract-Lite 111 维条件张量</strong>
                <ul class="rep-ul">
                  <li><strong>JD2 19→17 维独立声道</strong>：剔除引擎自动求解的舌根坐标 <code class="mono">TRX/TRY</code>，保留 17 维独立构音参数 + 1 维对数基频 <code class="mono">F0</code> + 1 维肺压 <code class="mono">PR</code> + 8 维全声门发声态参数。</li>
                  <li><strong>安全单位边界</strong>：前端与适配器层气压统一暴露 <code class="mono">0–1600 Pa</code>，仅在 Python 原生引擎边界换算为 <code class="mono">0–16000 dPa</code>，越界一律报错拒绝。</li>
                  <li><strong>111 维协同构音输入</strong>：<code class="mono">x_base(26) + g_masked(26) + w_mask(26) + f0(1) + 相位(5) + 阻塞事件(4) + 通用音标调音特征(22) + has_phon(1)</code>，未约束通道严格置零保证零上下文泄漏。</li>
                </ul>
              </div>
            </div>

            <div class="rep-table-card selectable">
              <div class="rep-filter-bar">
                <strong>27 维声道—声门完整参数边界与生理意义表</strong>
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
                      <th>所属分支</th>
                      <th>下界</th>
                      <th>上界</th>
                      <th>单位</th>
                      <th>归一化方式</th>
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
          </div>
        </div>

        <!-- Chapter 3: Full Corpus Inventory -->
        <div id="repDatasets" class="panel">
          <div class="p-head">
            <span>3. 全量训练语料清单、180h 多发声态配比与合规边界</span>
            <span class="tree-tag mono">16 项数据源 · 隐私零混入</span>
          </div>
          <div class="p-body rep-body">
            <div class="rep-chart-grid-2">
              <TechChart
                title="图 2 · 180 小时全发声态物理合成语料分布"
                subtitle="总计 170,550 条（179.89 h），单发声态占 70.2%，句内多态渐变占 29.8%"
                badge="170,550 条 · 8 模式"
                :height="340"
                :option-builder="buildSynth180hPieChart"
                caption="数据统计自 synth_full_glottis_180h/manifest.jsonl 全量累加：50,756 条句内渐变在随机 2–3 段边界上以 50–200 ms 余弦平滑过渡，覆盖声门动力学全连续空间。"
              />
              <div class="editorial-card rep-card selectable" style="justify-content: space-between">
                <div>
                  <strong style="font-size: 1.02rem">多源数据工程与开源合规设计</strong>
                  <ul class="rep-ul" style="margin-top: 8px">
                    <li><strong>百 GB 级语料零解压流式读取</strong>：对 AISHELL-3 未压缩 <code class="mono">.tar</code> 建立字节偏移索引，对 KeSpeech 分卷设计 <code class="mono">MultiPartRawStream</code> 内存级流式解码，避免磁盘解压爆炸。</li>
                    <li><strong>共享内存蒸馏缓存（63.61 h / 7.48 GB）</strong>：由旗舰教师一次性生成 120 分片，供 <code class="mono">Vox2Tract-Lite</code>、<code class="mono">Vox2Spk-Lite</code> 与 <code class="mono">Tract2Vox-Lite</code> 复用，训练期全量预载内存达 100% RAM 命中率。</li>
                    <li><strong>7 项 MFA 质量拒识门控</strong>：<code class="mono">Text2Prosody-Lite</code> 数据构建阶段自动筛除 4,466 条高时长偏差（1,334）、低似然（1,767）、塌缩（962）与元音无声漂移（257）标注，确保韵律纯净。</li>
                    <li><strong>严格隐私与盲测隔离</strong>：多说话人索引强制设置 <code class="mono">include_voiceover=False</code> 屏蔽私有配音；验证集 84 名说话人与 USC-TIMIT 真人 EMA 276 条全程零泄漏进训练集。</li>
                  </ul>
                </div>
                <div class="rep-callout-inline">
                  <IconSvg name="shield" :size="14" />
                  <span>第三方公开语料严禁随仓库再分发原音频，复现者请按原语料协议获取并由脚本流式索引。</span>
                </div>
              </div>
            </div>

            <div class="rep-table-card selectable">
              <div class="rep-filter-bar">
                <strong>全项目训练与评测语料总清单（{{ filteredCorpus.length }} / {{ FULL_CORPUS_INVENTORY.length }} 项）</strong>
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
                      <th>条目 / 分片规模</th>
                      <th>时长 / 说话人构成</th>
                      <th>服务模型</th>
                      <th>工程处理与标注说明</th>
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

        <!-- Chapter 4: Training Procedures & Real Convergence Curves -->
        <div id="repTraining" class="panel">
          <div class="p-head">
            <span>4. 各模型训练流程、损失函数设计与实测收敛曲线</span>
            <span class="tree-tag mono">Verified Training Logs</span>
          </div>
          <div class="p-body rep-body">
            <div class="settings-grid-2 selectable">
              <div class="editorial-card rep-card">
                <strong>A. 旗舰教师链（肺压 → 声学代理 → 双分支反演 → 锚定微调 → 神经声码器）</strong>
                <ul class="rep-ul">
                  <li><strong>Vox2Tract-PR（肺压编码，30k 步）</strong>：25 层加权 WavLM + 3 维增益不变音质前端 → 8×ConvNeXt + BiLSTM，180h 训练达成 <code class="mono">PR PCC 0.9811</code>。</li>
                  <li><strong>Tract2Feat-Proxy（声学代理，50k 步）</strong>：8 层 Conformer-256 并行预测 WavLM L24（音段）与 L6（发声态），270h 联合训练达 <code class="mono">Cos24 0.8809 / Cos6 0.8408</code>。</li>
                  <li><strong>Vox2Tract-Large（合成预热 45k → 锚定微调 32k 步）</strong>：声道/声门双分支解耦，自然语音微调引入 Pass 1 真实语音 + Pass 2 合成锚定（权重 0.045），17 维声道 PCC 从 0.6309 跃升至 <code class="mono">0.8200</code>，8 维声门达 <code class="mono">0.9040</code>。</li>
                  <li><strong>Tract2Vox-Large（神经声码器，32k 步）</strong>：12 谐波 + 0.5F0 嘎裂次谐波 + 裂隙吸气噪声 <code class="mono">GlottisAwareSourceModule</code>，28k 后以 4,000 步低 LR 余弦精调将 <code class="mono">val_score</code> 压低至 <code class="mono">0.03534</code>。</li>
                </ul>
              </div>
              <div class="editorial-card rep-card">
                <strong>B. 端侧零 WavLM 7 项自研轻量模型</strong>
                <ul class="rep-ul">
                  <li><strong>Vox2Tract-Lite (55k, 132 min)</strong>：167 维纯声学前端 + 6 层 Conformer-192，65% 蒸馏缓存 + 35% 180h 真值 + 冻结双头声学感知蒸馏（8×L24 + 6×L6），未见自然 <code class="mono">T17 PCC 0.9102</code>。</li>
                  <li><strong>Vox2Spk-Lite (30k, 12.4 min)</strong>：80-Mel CMN + 3 层 ECAPA-TDNN，PK 采样 32×4，对齐 WavLM-SV 512 维空间，余弦达 <code class="mono">0.9172</code>，CPU 仅 <code class="mono">12.3 ms</code>。</li>
                  <li><strong>Tract2Vox-Lite (21k, 45.3 min)</strong>：保留完整 Glottis-NSF v3 且通道减半（ch=256），叠加教师音频 Mel 蒸馏与双声纹交替约束，第 17,000 步达最优 <code class="mono">val_score 0.06264</code>。</li>
                  <li><strong>IPA2Tract-Lite（合成预热 15k + 自然扩展 30k 步）</strong>：异步 3 阶 qTA 零滞后物理基线 + 零初始化双残差 + <code class="mono">Tract2Area-Proxy</code> 闭塞/开口护栏，较基线降误差 <code class="mono">35.88%</code>。</li>
                </ul>
              </div>
            </div>

            <!-- Chart 3: Vox2Tract-Large Anchored vs Unanchored -->
            <TechChart
              title="图 3 · Vox2Tract-Large 双通物理锚定 vs 无锚定消融实验真实训练曲线"
              subtitle="脱离合成物理锚定时，仅 5,500 步声道 PCC 便从 0.6299 降至 0.4076；加入 Pass 2 锚定后稳步攀升至 0.8200"
              badge="关键消融实证"
              :height="335"
              :option-builder="buildInverterAnchorChart"
              caption="采样自上游归档训练日志 motor_natural/metrics.jsonl 与对照组日志。第 18,000 步起进入多风格表现语料热重启，并入 ESD/Expresso 情感与 GTSinger/M4/VocalSet 歌唱语料。"
            />

            <div class="rep-chart-grid-2">
              <!-- Chart 4: 25-dim Per-parameter PCC -->
              <TechChart
                title="图 4 · Vox2Tract-Large 25 维声道与声门逐维实测 PCC"
                subtitle="第 26,500 步最优模型：声门 8 维均值 0.9040（绿），声道 17 维均值 0.8200（蓝），横轴截断起自 0.55"
                badge="25 维全览"
                :height="560"
                :option-builder="buildPerDimPccChart"
                caption="核心控制维 XT (0.9663)、XB (0.9645)、TCX (0.9512)、RA (0.9496)、VO (0.9429) 与 SHIM (0.9293) 均超过 0.92（注：横轴起始值为 0.55 以突出参数间差异）。"
              />
              <!-- Chart 5: Vocoder Large vs Lite -->
              <TechChart
                title="图 5 · Tract2Vox-Large 与 Tract2Vox-Lite 声码器收敛对比"
                subtitle="左轴 val_score（越低越好），右轴 WavLM L24 语义相似度；28k 步竖线起进入低 LR 精调"
                badge="Large 14.4M vs Lite 3.72M"
                :height="560"
                :option-builder="buildVocoderCurveChart"
                caption="Tract2Vox-Lite 以不足教师 26% 的参数量，在第 17,000 步达成 val_score 0.06264、L24 0.8588、端侧声纹闭环 Spk Cos 0.8736。"
              />
            </div>
          </div>
        </div>

        <!-- Chapter 5: Benchmarks, EMA, Vox2Align v2 & Text2Prosody -->
        <div id="repBenchmarks" class="panel">
          <div class="p-head">
            <span>5. 最新双语对齐/韵律模型、真人 EMA 检验与 8 句端到端评测</span>
            <span class="tree-tag mono">2026-11-24 Latest Runs</span>
          </div>
          <div class="p-body rep-body">
            <div class="settings-grid-2 selectable">
              <div class="editorial-card rep-card">
                <strong>Vox2Align-Lite v2（4.33 M · 20,000 步 · 66.9 min）</strong>
                <ul class="rep-ul">
                  <li><strong>核心升级</strong>：外部接收 163 维 80-Mel+Δ+能量，在算子图内实时计算 80-ΔΔ 拼接为 243 维送入 4 层 Conformer-192，经可学习残差门控与 <code class="mono">Vox2Tract-Lite</code> 先验融合，配合 15% 模态丢弃，既可挂接声道反演也能独立对齐原始音频。</li>
                  <li><strong>零非法拼音音节</strong>：新增 415 类合法汉语拼音音节 CTC 头，结合 <code class="mono">UntPhesoca 宽式</code>规则展开音素边界，并联动语音掩码 Viterbi 约束消除尾音拖入静音。</li>
                  <li><strong>500 句全验证成绩</strong>：中文 ≤20 ms 边界 <code class="mono">93.66%</code>（均值 11.23 ms），英语 ≤20 ms 边界 <code class="mono">95.47%</code>（均值 8.78 ms），中文合法音节准确率 <code class="mono">90.71%</code>，静音 Mask F1 <code class="mono">0.9885</code>，CPU 仅 <code class="mono">41.37 ms</code>。</li>
                </ul>
              </div>
              <div class="editorial-card rep-card">
                <strong>Text2Prosody-Lite（1.98 M · 最佳 @7,500 步 · 19.3 min）</strong>
                <ul class="rep-ul">
                  <li><strong>中英混排无缝韵律</strong>：基于 22 维通用音标特征、10 维句法结构位置与 4 路离散嵌入，在说话人无关的相对半音空间预测单音时长、3 点基频轮廓与边界停顿。</li>
                  <li><strong>在线增强策略</strong>：训练期施加 18% 在线中英句子拼接（带自然句中停顿与 -0.7 st 语调自然下倾）以及 30% 三声连读半三声增强。</li>
                  <li><strong>实测精度</strong>：普通话时长 MAE <code class="mono">22.94 ms</code> / F0 MAE <code class="mono">1.198 st</code>（PCC 0.7743），英语时长 MAE <code class="mono">17.37 ms</code> / F0 MAE <code class="mono">1.203 st</code>，纯 CPU 推理仅 <code class="mono">18.52 ms</code>。</li>
                </ul>
              </div>
            </div>

            <div class="rep-chart-grid-2">
              <TechChart
                title="图 6 · Vox2Align-Lite v2 20k 步多任务收敛曲线"
                subtitle="70,000+ 中英朗读与歌唱语料，中/英边界 20 ms 命中率分别突破 93.7% 与 95.5%"
                badge="4.33M · CPU 41.4 ms"
                :height="375"
                :option-builder="buildAlignV2Chart"
                caption="数据采样自上游归档日志 vox2align_v2/metrics.jsonl，第 20,000 步取得综合最优 val_score 0.9170（全验证 500 句达 0.9192）。"
              />
              <TechChart
                title="图 7 · Text2Prosody-Lite 四类语域时长误差与基频相关性"
                subtitle="中英朗读、中英混排（CS）与孤立单字（ISO）四域实测对照"
                badge="1.98M · CPU 18.5 ms"
                :height="375"
                :option-builder="buildProsodyDomainChart"
                caption="数据来自上游评估记录 text2prosody_v1/summary.json（best @7,500 步）：中英自然句子音素时长 MAE 控制在 17–23 ms 内，音高偏差约 1.2 个半音。"
              />
            </div>

            <div class="rep-chart-grid-2">
              <TechChart
                title="图 8 · IPA2Tract-Lite 真人 EMA 电磁发音仪 7 器官盲测"
                subtitle="USC-TIMIT 20 份完全未见真人传感器记录，验证模型预测轨迹与人类真实构音运动一致性"
                badge="零训练泄露盲测"
                :height="370"
                :option-builder="buildEmaRadarChart"
                caption="数据来自上游协同动腔规划评估报告（零训练泄露盲测）：脏上下文零泄漏验证 max_abs_diff = 0.0；VCV /abu/ 与 /uba/ 闭塞期内准确产生跨辅音舌体协同预移。"
              />
              <TechChart
                title="图 9 · 8 句端到端实测对比：旗舰教师 vs Lite 声码器 vs 端侧闭环"
                subtitle="覆盖普通话四声、中英自然句及气声/紧嗓/嘎裂/假声/五态连续渐变"
                badge="端到端 8 句基准"
                :height="370"
                :option-builder="buildAudition8Chart"
                caption="数据来自上游声码器 8 句对比评估汇总：Tract2Vox-Lite 均值 L24 0.8478（Tract2Vox-Large 教师均值 0.8561），全端侧无 WavLM 闭环 L24 0.8052 / Spk 0.8470。"
              />
            </div>
          </div>
        </div>

        <!-- Chapter 6: 10 Engineering Lessons -->
        <div id="repLessons" class="panel">
          <div class="p-head">
            <span>6. 研发过程十大工程复盘</span>
            <span class="tree-tag mono">10 Verified Lessons</span>
          </div>
          <div class="p-body rep-body">
            <div class="settings-grid-2 selectable">
              <div v-for="(item, idx) in TRAINING_EXPERIENCE_HIGHLIGHTS" :key="item.id" class="editorial-card lesson-card">
                <div class="lesson-head">
                  <div style="display: flex; align-items: center; gap: 6px; min-width: 0">
                    <span class="mono lesson-idx">{{ String(idx + 1).padStart(2, '0') }}</span>
                    <strong>{{ item.title }}</strong>
                  </div>
                  <span class="tree-tag">{{ item.category }}</span>
                </div>
                <p class="muted lesson-p"><strong>现象与根因：</strong>{{ item.finding }}</p>
                <p class="lesson-p"><strong>工程解法：</strong>{{ item.remedy }}</p>
              </div>
            </div>
          </div>
        </div>

        <!-- Chapter 7: Retraining & Custom Corpus Manual -->
        <div id="repRetrain" class="panel">
          <div class="p-head">
            <span>7. 使用更多语料二次训练、微调与 ONNX 导出指南</span>
            <span class="tree-tag mono">Open Reproducibility</span>
          </div>
          <div class="p-body rep-body">
            <div class="editorial-card rep-hero-card selectable">
              <strong>外部研究者接入自定义语料的基本原则</strong>
              <p class="muted rep-p">
                所有音频训练前统一转码至 16 kHz 单声道（DPDFNet 与 VTL 物理渲染侧为 48 kHz），并确保帧率严格对齐 50 Hz（hop 320）。若训练语料含声乐或方言高音，请过滤有声帧 95 分位基频高于 550 Hz 的切片；微调反演器或声码器时务必保留 12%–35% 的 VTL 物理合成真值作为锚定，避免物理构音空间漂移。
              </p>
            </div>

            <div class="rep-recipe-list">
              <div v-for="rec in RETRAINING_RECIPES" :key="rec.id" class="editorial-card rep-recipe-card selectable">
                <div class="lesson-head">
                  <strong style="font-size: 1rem">{{ rec.scenario }}</strong>
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
                    <span class="mono muted">PowerShell / Python 复现命令</span>
                    <button type="button" class="btn xs" @click="copyCode(rec.id, rec.commands)">
                      <span>{{ copiedId === rec.id ? '已复制' : '复制命令' }}</span>
                    </button>
                  </div>
                  <pre class="mono rep-pre"><code>{{ rec.commands }}</code></pre>
                </div>
              </div>
            </div>

            <div class="editorial-card rep-card selectable">
              <strong>导出兼容 {{ APP_BRAND_NAME }} 的自定义 ONNX 必须满足的 4 条规则</strong>
              <ul class="rep-ul">
                <li><strong>去除动态非 ONNX 算子</strong>：导出前移除 <code class="mono">weight_norm</code>，禁止图内包含复数 STFT、<code class="mono">pack_padded_sequence</code> 或图内随机数生成器（<code class="mono">Tract2Vox-Lite</code> 的随机包络与宽带噪声作为显式输入张量 <code class="mono">env_rand</code>、<code class="mono">n_wb</code> 传入）。</li>
                <li><strong>保留动态批与时间轴</strong>：Batch 维与时间帧维 <code class="mono">T</code>（或音素长度 <code class="mono">L</code>）须导出为动态符号维度，特征尾维须严格匹配下表契约。</li>
                <li><strong>张量名与 Dtype 精确一致</strong>：引擎装载时会执行严格校验，若输入/输出名、阶数、数据类型或固定维度不符，将直接拒绝装载并保留原可用权重。</li>
                <li><strong>单文件体积上限</strong>：每个外置 <code class="mono">.onnx</code> 文件需大于 1 KB；通过浏览器界面上传（<code class="mono">/mount-binary</code>）受 HTTP 代理包体保护上限为 <strong>64 MiB</strong>，若需加载更大模型（上限 <strong>256 MiB</strong>）请在「从文件夹装载」填入本机目录路径挂载。建议权重量化为 FP16 存储（面积敏感的 <code class="mono">Tract2Area-Proxy</code> 保持 FP32）。</li>
              </ul>
            </div>
          </div>
        </div>

        <!-- Chapter 8: Engine Loading, Hot-Plug & ONNX Slot Contracts -->
        <div id="repEngine" class="panel">
          <div class="p-head">
            <span>8. 生成引擎、本地模型装载与热插拔换模机制</span>
            <span class="tree-tag mono">Pure ONNX Runtime · Hot-Plug</span>
          </div>
          <div class="p-body rep-body">
            <div class="settings-grid-2 selectable">
              <div class="editorial-card rep-card">
                <strong>物理声道引擎三层路由 + 纯 ONNX 懒加载隔离</strong>
                <ul class="rep-ul">
                  <li><strong>物理求解优先顺序</strong>：浏览器本地 WASM Worker（预留）→ 本地 Python 原生 VTL 2.4 DLL 服务（<code class="mono">127.0.0.1:8765</code>，当前主通道）→ 预渲染样本只读兜底。</li>
                  <li><strong>零 PyTorch 推理栈</strong>：全部 9 个模型由 <code class="mono">engine/model_registry_runtime.py</code>（<code class="mono">LocalModelManager</code>）统一管理，前端特征在 <code class="mono">onnx_frontends.py</code> 中以纯 NumPy/SciPy 复现，不依赖数 GB 的 PyTorch 运行时。</li>
                  <li><strong>内存会话按需收放</strong>：点击任意模型卡片的「装载」将创建并校验 <code class="mono">InferenceSession</code>；点击「卸载」会释放内存并触发垃圾回收，相关可选模块（如韵律、协同构音）会自动平滑降级至物理规则基线。</li>
                </ul>
              </div>
              <div class="editorial-card rep-card">
                <strong>界面一键换模与目录批量扫描装载</strong>
                <ul class="rep-ul">
                  <li><strong>单槽换模</strong>：在「设置 → 声学引擎与模型」的 9 模型矩阵中点击目标卡片的「换模」，选取任意符合契约的 <code class="mono">.onnx</code> 文件上传；引擎自动校验后持久化至 <code class="mono">.cache/custom-models/&lt;slug&gt;/</code> 并生效热切换。</li>
                  <li><strong>从文件夹装载</strong>：点击矩阵右上角「从文件夹装载」，既可输入本地目录绝对路径扫描（最大递归深度 2，单文件上限 256 MiB），也可通过浏览器目录选择器批量上传（单文件上限 64 MiB）；系统先按文件名关键词匹配槽位，再以输入输出张量契约逐一校验。</li>
                  <li><strong>一键回退与状态持久</strong>：外置路径与开关状态写入 <code class="mono">.cache/local-model-registry.json</code>，重启自动延续；点击「恢复内置」或「全部恢复内置」即可切回随包默认权重。</li>
                </ul>
                <div style="margin-top: 6px">
                  <button type="button" class="btn primary sm" @click="store.openOverlay('settings', 'engine')">
                    <IconSvg name="cpu" :size="13" />
                    <span>前往「本地轻量化模型矩阵」实操装载 / 换模</span>
                  </button>
                </div>
              </div>
            </div>

            <!-- 9 ONNX Slot Tensor Contract Table -->
            <div class="rep-table-card selectable">
              <div class="param-sec-title">
                <span>9 个本地 ONNX 槽位精确输入输出张量契约（换模校验真源）</span>
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
                      <th>卸载时降级行为</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="c in ONNX_SLOT_CONTRACTS" :key="c.slug">
                      <td class="mono"><strong>{{ c.name }}</strong></td>
                      <td class="mono">{{ c.inputs }}</td>
                      <td class="mono">{{ c.outputs }}</td>
                      <td class="mono muted">{{ c.patterns }}</td>
                      <td class="muted">{{ c.fallback }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- 6 REST Endpoints -->
            <div class="rep-table-card selectable">
              <div class="param-sec-title">
                <span>热插拔与外置模型装载 HTTP API 清单</span>
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
  font-size: 0.94rem;
  line-height: 1.65;
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
  font-size: 1.04rem;
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
  font-size: 0.92rem;
  line-height: 1.62;
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
  font-size: 0.885rem;
  line-height: 1.48;
  vertical-align: top;
}

.rep-filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 0.95rem;
}

.rep-filter-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.rep-callout-inline {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  border-left: 3px solid var(--accent);
  background: color-mix(in srgb, var(--selected) 40%, transparent);
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 0.875rem;
  color: var(--text);
}

.lesson-card {
  box-shadow: none;
  gap: 6px;
}

.lesson-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.lesson-idx {
  font-size: 0.82rem;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--selected);
  color: var(--accent);
  font-weight: 700;
}

.lesson-p {
  margin: 0;
  font-size: 0.91rem;
  line-height: 1.6;
}

.rep-recipe-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.rep-recipe-card {
  box-shadow: none;
  gap: 8px;
}

.rep-meta-line {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 0.9rem;
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
  font-size: 0.915rem;
  line-height: 1.6;
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
  font-size: 12.5px;
  font-weight: 700;
  text-anchor: middle;
}

.svg-sub {
  fill: var(--muted);
  font-size: 11px;
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
