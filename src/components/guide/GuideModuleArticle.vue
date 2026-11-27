<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { EChartsCoreOption } from 'echarts/core';
import {
  SCORE_NOTATIONS,
  evalQtaSegmentAt,
  formatPitchInNotation,
  formatSingleNoteInNotation,
  type ScoreNotationId,
  type SongTonic,
} from '@vocalcut/core';
import IconSvg from '@/components/common/IconSvg.vue';
import TechChart, { type ChartThemeTokens } from '@/components/charts/TechChart.vue';
import GuideInteractiveDemo from '@/components/guide/GuideInteractiveDemo.vue';
import CardLayoutTreeMap from '@/components/phonetic-card/card/CardLayoutTreeMap.vue';
import {
  CARD_MODULE_MAP,
  findLeafSplitContext,
  isNestedLayoutTree,
  type CardLayoutNode,
} from '@/components/phonetic-card/card/layout-tree';
import { EASE, EASING_OPTIONS } from '@/components/studio/stage-motion';
import {
  computeCoarticulationBellBaseline,
  computeCoarticulationBellFromFrames,
  computeMainSynthesisPhysicsData,
  type CoarticulationBellSeries,
} from '@/data/guide-charts';
import { preloadPtbIpaPresets } from '@/data/ptb-ipa-presets';
import { parseShortcutTokens } from '@/data/shortcut-format';
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

const coartSeries = ref<CoarticulationBellSeries>(computeCoarticulationBellBaseline());
const coartRevision = ref(0);
const mainPhysicsRevision = ref(0);

onMounted(() => {
  if (props.module.chartKey === 'mainSynthesisPhysics') {
    void preloadPtbIpaPresets('JD2')
      .then(() => {
        mainPhysicsRevision.value += 1;
      })
      .catch(() => {});
  }
  if (props.module.chartKey !== 'coarticulation') return;
  const base = (import.meta.env?.BASE_URL ?? '/').replace(/\/?$/, '/');
  void fetch(`${base}prewarm/suan_mandarin.json`)
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { geometry_frames?: Array<{ t_s: number; params: number[] }> } | null) => {
      if (!data?.geometry_frames || data.geometry_frames.length < 6) return;
      coartSeries.value = computeCoarticulationBellFromFrames(
        data.geometry_frames,
        '实算轨迹 suan_mandarin.json（普通话「算」[swan⁵¹]）+ bellSuperimposedRow',
        1.15,
      );
      coartRevision.value += 1;
    })
    .catch(() => {
      // Keep real qTA + bellSuperimposedRow baseline if static asset fetch is unavailable
    });
});

// Interactive zero-image 5-notation comparator for the Arranger guide
const previewNotation = ref<ScoreNotationId>('je');
const previewTonic = ref<SongTonic>('B2');
const previewTonics: readonly SongTonic[] = ['B2', 'C3', 'G3'];
const activeNotationDoc = computed(() => SCORE_NOTATIONS.find((n) => n.id === previewNotation.value) ?? SCORE_NOTATIONS[0]);
const sampleScaleComparison = computed(() => {
  const n = previewNotation.value;
  const t = previewTonic.value;
  return [
    { label: '低音 5（1拍）', midi: t === 'G3' ? 50 : t === 'B2' ? 42 : 43, beats: 1, dyn: 0 },
    { label: '中音 #4（附点）', midi: t === 'G3' ? 61 : t === 'B2' ? 53 : 54, beats: 1.5, dyn: 0 },
    { label: '高音 1（半拍 · 弱 p）', midi: t === 'G3' ? 67 : t === 'B2' ? 59 : 60, beats: 0.5, dyn: -1 },
    { label: '高音 3（2拍 · 强 ff）', midi: t === 'G3' ? 71 : t === 'B2' ? 63 : 64, beats: 2, dyn: 2 },
  ].map((item) => ({
    ...item,
    pitch: formatPitchInNotation(item.midi, t, n),
    token: formatSingleNoteInNotation(item.midi, t, item.beats, n, item.dyn),
  }));
});

function buildArrangerGlideChart(t: ChartThemeTokens): EChartsCoreOption {
  // Compare real qTA pitch step (C4 -> G4, 0 st -> +7 st over 0.40s) across PORTAMENTO_RATE bounds: 18 / 32 / 65 s^-1
  const msSteps = Array.from({ length: 41 }, (_, i) => i * 10);
  const evalCurve = (lambda: number) => msSteps.map((ms) => {
    const sec = ms / 1000;
    const st = sec < 0.08
      ? 0
      : evalQtaSegmentAt(sec - 0.08, 0.32, 0, 7, lambda, { y: 0, yp: 0, ypp: 0 }).y;
    const hz = 261.63 * (2 ** (st / 12));
    return Number(hz.toFixed(1));
  });
  return {
    tooltip: {
      trigger: 'axis',
      backgroundColor: t.tooltipBg,
      borderColor: t.border,
      textStyle: { color: t.text, fontSize: 13 },
    },
    legend: { top: 6, left: 'center', icon: 'roundRect', itemWidth: 16, itemHeight: 4, itemGap: 16, textStyle: { color: t.text, fontSize: 12.5 } },
    grid: { left: 64, right: 26, top: 72, bottom: 46 },
    xAxis: {
      type: 'category',
      name: '时间 (ms)',
      nameLocation: 'middle',
      nameGap: 28,
      nameTextStyle: { color: t.muted, fontSize: 12.5 },
      data: msSteps,
      axisLabel: { color: t.muted, fontSize: 12 },
      axisLine: { lineStyle: { color: t.border } },
    },
    yAxis: {
      type: 'value',
      name: '目标基频 F0 (Hz)',
      min: 240,
      max: 420,
      nameGap: 14,
      nameTextStyle: { color: t.muted, fontSize: 12.5, align: 'left', padding: [0, 0, 0, -24] },
      axisLabel: { color: t.muted, fontSize: 12 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    series: [
      {
        name: 'λ = 18 s⁻¹（最慢柔和滑音 · 下限）',
        type: 'line',
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2.3, type: 'dashed', color: t.series[2] },
        itemStyle: { color: t.series[2] },
        data: evalCurve(18),
      },
      {
        name: 'λ = 32 s⁻¹（默认声乐滑音）',
        type: 'line',
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 3, color: t.series[0] },
        itemStyle: { color: t.series[0] },
        areaStyle: { color: t.series[0], opacity: 0.1 },
        data: evalCurve(32),
      },
      {
        name: 'λ = 65 s⁻¹（最干脆快跳进 · 上限）',
        type: 'line',
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2.2, type: 'dotted', color: t.series[1] },
        itemStyle: { color: t.series[1] },
        data: evalCurve(65),
      },
    ],
  };
}

function buildCoarticulationChart(t: ChartThemeTokens): EChartsCoreOption {
  const data = coartSeries.value;
  const allVals = [...data.origTcx, ...data.bellEditedTcx, ...data.flatBlockTcx];
  const minVal = Math.floor((Math.min(...allVals) - 0.35) * 10) / 10;
  const maxVal = Math.ceil((Math.max(...allVals) + 0.45) * 10) / 10;
  return {
    tooltip: {
      trigger: 'axis',
      backgroundColor: t.tooltipBg,
      borderColor: t.border,
      textStyle: { color: t.text, fontSize: 13 },
    },
    legend: { top: 6, left: 'center', icon: 'roundRect', itemWidth: 16, itemHeight: 4, itemGap: 16, textStyle: { color: t.text, fontSize: 12.5 } },
    grid: { left: 64, right: 26, top: 76, bottom: 48 },
    xAxis: {
      type: 'category',
      name: '时间 (ms)',
      nameLocation: 'middle',
      nameGap: 28,
      nameTextStyle: { color: t.muted, fontSize: 12.5 },
      data: data.msSteps,
      axisLabel: { color: t.muted, fontSize: 12 },
      axisLine: { lineStyle: { color: t.border } },
    },
    yAxis: {
      type: 'value',
      name: '舌体前后 TCX (cm)',
      nameGap: 14,
      min: minVal,
      max: maxVal,
      nameTextStyle: { color: t.muted, fontSize: 12.5, align: 'left', padding: [0, 0, 0, -24] },
      axisLabel: { color: t.muted, fontSize: 12 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    series: [
      {
        name: '原始协同轨迹（修改前）',
        type: 'line',
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2.2, type: 'dashed', color: t.series[7] },
        itemStyle: { color: t.series[7] },
        data: data.origTcx,
      },
      {
        name: `余弦升窗叠加 +${data.deltaCm} cm（bellSuperimposedRow）`,
        type: 'line',
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 3, color: t.series[0] },
        itemStyle: { color: t.series[0] },
        areaStyle: { color: t.series[0], opacity: 0.12 },
        markArea: {
          silent: true,
          itemStyle: { color: t.accent, opacity: 0.08 },
          label: { color: t.text, fontSize: 12, position: 'insideTop', distance: 8 },
          data: [[{ name: '余弦升窗作用区', xAxis: String(data.windowStartMs) }, { xAxis: String(data.windowEndMs) }]],
        },
        data: data.bellEditedTcx,
      },
      {
        name: '常数块直接替换（边界阶跃易爆音）',
        type: 'line',
        step: 'middle',
        symbol: 'none',
        lineStyle: { width: 2, type: 'dotted', color: t.series[6] },
        itemStyle: { color: t.series[6] },
        data: data.flatBlockTcx,
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

function buildStageCinemaCurvesChart(t: ChartThemeTokens): EChartsCoreOption {
  const steps = 40;
  const xs = Array.from({ length: steps + 1 }, (_, i) => Number((i / steps).toFixed(2)));
  return {
    tooltip: {
      trigger: 'axis',
      backgroundColor: t.tooltipBg,
      borderColor: t.border,
      textStyle: { color: t.text, fontSize: 13 },
    },
    legend: {
      top: 4,
      left: 'center',
      icon: 'roundRect',
      itemWidth: 16,
      itemHeight: 4,
      itemGap: 12,
      textStyle: { color: t.text, fontSize: 12 },
    },
    grid: { left: 58, right: 24, top: 76, bottom: 44 },
    xAxis: {
      type: 'category',
      name: '归一化时间 u (0 → 1)',
      nameLocation: 'middle',
      nameGap: 28,
      nameTextStyle: { color: t.muted, fontSize: 12.5 },
      data: xs,
      axisLabel: { color: t.muted, fontSize: 12, interval: 7 },
      axisLine: { lineStyle: { color: t.border } },
    },
    yAxis: {
      type: 'value',
      name: '位移进度 y(u)',
      nameGap: 14,
      min: -0.2,
      max: 1.25,
      nameTextStyle: { color: t.muted, fontSize: 12.5 },
      axisLabel: { color: t.muted, fontSize: 12 },
      splitLine: { lineStyle: { color: t.gridLine } },
    },
    series: EASING_OPTIONS.map((opt, idx) => {
      const fn = EASE[opt.value];
      const color = t.series[idx % t.series.length];
      return {
        name: opt.label.replace(/\s*\([^)]+\)/, ''),
        type: 'line',
        smooth: true,
        symbol: 'none',
        lineStyle: {
          width: opt.value === 'linear' ? 1.7 : 2.5,
          type: opt.value === 'linear' ? 'dashed' : 'solid',
          color,
        },
        itemStyle: { color },
        data: xs.map((u) => Number(fn(u).toFixed(3))),
      };
    }),
  };
}

function buildMainSynthesisPhysicsChart(t: ChartThemeTokens): EChartsCoreOption {
  // Real 200 Hz (5 ms) physical control lattice compiled by `buildAnnotationSynthesis()` + `stopPhaseBoundaries()`
  const data = computeMainSynthesisPhysicsData();
  const minLd = Math.min(-0.6, Math.floor((Math.min(...data.ldCm) - 0.2) * 10) / 10);
  const maxLd = Math.max(1.8, Math.ceil((Math.max(...data.ldCm) + 0.4) * 10) / 10);
  const maxPr = Math.max(1100, Math.ceil((Math.max(...data.prPa) + 120) / 100) * 100);
  return {
    tooltip: {
      trigger: 'axis',
      backgroundColor: t.tooltipBg,
      borderColor: t.border,
      textStyle: { color: t.text, fontSize: 13 },
    },
    legend: {
      top: 4,
      left: 'center',
      icon: 'roundRect',
      itemWidth: 16,
      itemHeight: 4,
      itemGap: 16,
      textStyle: { color: t.text, fontSize: 12.5 },
    },
    grid: { left: 64, right: 66, top: 76, bottom: 46 },
    xAxis: {
      type: 'category',
      name: '时间 (ms · buildAnnotationSynthesis 200 Hz 实算网格)',
      nameLocation: 'middle',
      nameGap: 28,
      nameTextStyle: { color: t.muted, fontSize: 12.5 },
      data: data.msSteps,
      axisLabel: { color: t.muted, fontSize: 12, interval: 5 },
      axisLine: { lineStyle: { color: t.border } },
    },
    yAxis: [
      {
        type: 'value',
        name: '肺压 PR (Pa) / F0 (Hz)',
        min: 0,
        max: maxPr,
        nameGap: 14,
        nameTextStyle: { color: t.muted, fontSize: 12.5, align: 'left', padding: [0, 0, 0, -24] },
        axisLabel: { color: t.muted, fontSize: 12 },
        splitLine: { lineStyle: { color: t.gridLine } },
      },
      {
        type: 'value',
        name: '双唇间距 LD (cm)',
        min: minLd,
        max: maxLd,
        nameGap: 14,
        nameTextStyle: { color: t.muted, fontSize: 12.5, align: 'right', padding: [0, -24, 0, 0] },
        axisLabel: { color: t.muted, fontSize: 12 },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '声门下肺压 PR (Pa)',
        type: 'line',
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2.4, color: t.series[2] },
        itemStyle: { color: t.series[2] },
        areaStyle: { color: t.series[2], opacity: 0.1 },
        data: data.prPa,
      },
      {
        name: '双唇间距 LD (cm · VTL 19 维实算)',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2.8, color: t.series[0] },
        itemStyle: { color: t.series[0] },
        markArea: {
          silent: true,
          itemStyle: { color: t.series[6], opacity: 0.09 },
          label: { color: t.text, fontSize: 11.5, position: 'insideTop', distance: 6 },
          data: [
            [{ name: `闭塞 ${data.closureEndMs}ms`, xAxis: '0' }, { xAxis: String(data.closureEndMs) }],
            [{ name: `除阻+VOT`, xAxis: String(data.closureEndMs) }, { xAxis: String(data.votEndMs) }],
          ],
        },
        data: data.ldCm,
      },
      {
        name: '浊音基频 F0 (Hz · qTA 阴平 55 实算)',
        type: 'line',
        smooth: true,
        symbol: 'none',
        connectNulls: false,
        lineStyle: { width: 2.8, color: t.series[1] },
        itemStyle: { color: t.series[1] },
        data: data.f0Hz,
      },
    ],
  };
}

function buildM27RealtimeBudgetChart(t: ChartThemeTokens): EChartsCoreOption {
  const modes = ['纯构型 (无音频)', '实时音频 0.7 s', '实时音频 0.8 s', '实时音频 0.9 s', '实时音频 1.0 s'];
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: t.tooltipBg,
      borderColor: t.border,
      textStyle: { color: t.text, fontSize: 13 },
    },
    legend: {
      top: 4,
      left: 'center',
      icon: 'roundRect',
      itemWidth: 16,
      itemHeight: 9,
      itemGap: 16,
      textStyle: { color: t.text, fontSize: 12.5 },
    },
    grid: { left: 64, right: 68, top: 76, bottom: 42 },
    xAxis: {
      type: 'category',
      data: modes,
      axisLabel: { color: t.text, fontSize: 12, interval: 0 },
      axisLine: { lineStyle: { color: t.border } },
    },
    yAxis: [
      {
        type: 'value',
        name: '前瞻 / 产出步长 (ms)',
        nameGap: 14,
        max: 440,
        nameTextStyle: { color: t.muted, fontSize: 12.5, align: 'left', padding: [0, 0, 0, -24] },
        axisLabel: { color: t.muted, fontSize: 12, formatter: '{value}' },
        splitLine: { lineStyle: { color: t.gridLine } },
      },
      {
        type: 'value',
        name: '滑窗总上下文 (ms)',
        nameGap: 14,
        min: 400,
        max: 2200,
        nameTextStyle: { color: t.muted, fontSize: 12.5, align: 'right', padding: [0, -24, 0, 0] },
        axisLabel: { color: t.muted, fontSize: 12, formatter: '{value}' },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '右侧前瞻 lookahead (ms)',
        type: 'bar',
        barMaxWidth: 24,
        itemStyle: { color: t.series[0], borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: 'top', color: t.text, fontSize: 11.5, formatter: '{c}' },
        data: [60, 160, 240, 300, 360],
      },
      {
        name: '单步产出 emit (ms)',
        type: 'bar',
        barMaxWidth: 24,
        itemStyle: { color: t.series[1], borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: 'top', color: t.text, fontSize: 11.5, formatter: '{c}' },
        data: [100, 200, 240, 240, 240],
      },
      {
        name: '滑窗上下文窗长 (ms)',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbol: 'circle',
        symbolSize: 9,
        lineStyle: { width: 2.6, color: t.series[2] },
        itemStyle: { color: t.series[2] },
        label: { show: true, position: 'top', color: t.series[2], fontSize: 12, formatter: '{c} ms' },
        data: [700, 1400, 1700, 1800, 1900],
      },
    ],
  };
}

// Interactive zero-image layout-tree playground reusing real CardLayoutTreeMap
type CardGuideSampleId = 'nested-1-2' | 'quad-grid' | 'whitespace-breath';

interface CardGuideTreeSample {
  id: CardGuideSampleId;
  label: string;
  desc: string;
  defaultLeafId: string;
  tree: CardLayoutNode;
}

const CARD_GUIDE_TREE_SAMPLES: readonly CardGuideTreeSample[] = [
  {
    id: 'nested-1-2',
    label: '左一右二嵌套',
    desc: '右侧纵向二分的典型非对称嵌套树，右侧检查器自动识别嵌套并启用占比滑杆而不拍平结构。',
    defaultLeafId: 'g_rt',
    tree: {
      kind: 'split',
      id: 'g_root_row',
      dir: 'row',
      ratios: [0.46, 0.54],
      children: [
        { kind: 'leaf', id: 'g_left', moduleId: 'tract-profile' },
        {
          kind: 'split',
          id: 'g_right_col',
          dir: 'col',
          ratios: [0.58, 0.42],
          children: [
            { kind: 'leaf', id: 'g_rt', moduleId: 'transfer-fn' },
            { kind: 'leaf', id: 'g_rb', moduleId: 'vowel-space' },
          ],
        },
      ],
    },
  },
  {
    id: 'quad-grid',
    label: '四联规整网格',
    desc: '经典两行两列规整网格，支持 1–5 行与 1–4 列快捷调整，适合同帧展示四维声学证据。',
    defaultLeafId: 'q_1',
    tree: {
      kind: 'split',
      id: 'q_root_col',
      dir: 'col',
      ratios: [0.54, 0.46],
      children: [
        {
          kind: 'split',
          id: 'q_r1',
          dir: 'row',
          ratios: [0.5, 0.5],
          children: [
            { kind: 'leaf', id: 'q_1', moduleId: 'tract-profile' },
            { kind: 'leaf', id: 'q_2', moduleId: 'cross-lip' },
          ],
        },
        {
          kind: 'split',
          id: 'q_r2',
          dir: 'row',
          ratios: [0.5, 0.5],
          children: [
            { kind: 'leaf', id: 'q_3', moduleId: 'transfer-fn' },
            { kind: 'leaf', id: 'q_4', moduleId: 'vowel-space' },
          ],
        },
      ],
    },
  },
  {
    id: 'whitespace-breath',
    label: '留白呼吸构图',
    desc: '右下方槽位设为「留白空槽」：编辑态以虚线提示可填入模块，正式导出自动隐藏虚线并忠实保留干净留白。',
    defaultLeafId: 'w_empty',
    tree: {
      kind: 'split',
      id: 'w_root_row',
      dir: 'row',
      ratios: [0.52, 0.48],
      children: [
        { kind: 'leaf', id: 'w_left', moduleId: 'tract-profile' },
        {
          kind: 'split',
          id: 'w_right_col',
          dir: 'col',
          ratios: [0.62, 0.38],
          children: [
            { kind: 'leaf', id: 'w_top', moduleId: 'ipa-wave-spec' },
            { kind: 'leaf', id: 'w_empty', moduleId: null },
          ],
        },
      ],
    },
  },
];

const cardGuideSampleId = ref<CardGuideSampleId>('nested-1-2');
const cardGuideSelectedLeafId = ref<string>('g_rt');

const activeCardGuideSample = computed(
  () => CARD_GUIDE_TREE_SAMPLES.find((s) => s.id === cardGuideSampleId.value) ?? CARD_GUIDE_TREE_SAMPLES[0],
);

function selectCardGuideSample(id: CardGuideSampleId): void {
  cardGuideSampleId.value = id;
  const hit = CARD_GUIDE_TREE_SAMPLES.find((s) => s.id === id);
  if (hit) cardGuideSelectedLeafId.value = hit.defaultLeafId;
}

const activeCardGuideLeafInfo = computed(() => {
  const sample = activeCardGuideSample.value;
  const ctx = findLeafSplitContext(sample.tree, cardGuideSelectedLeafId.value)
    ?? findLeafSplitContext(sample.tree, sample.defaultLeafId);
  const modMeta = ctx?.moduleId ? CARD_MODULE_MAP.get(ctx.moduleId) : null;
  return {
    isNested: isNestedLayoutTree(sample.tree),
    moduleTitle: modMeta ? `${modMeta.shortTitle}（${modMeta.sourcePage}）` : '留白空槽（moduleId: null）',
    isEmpty: !ctx?.moduleId,
    rowPct: ctx?.rowSplit ? `${Math.round(ctx.rowSplit.ratio * 100)}%（共 ${ctx.rowSplit.siblingCount} 栏）` : '通栏 100%',
    colPct: ctx?.colSplit ? `${Math.round(ctx.colSplit.ratio * 100)}%（共 ${ctx.colSplit.siblingCount} 层）` : '全高 100%',
    exportRule: ctx?.moduleId ? '按当前主题色板与离屏渲染器正常绘出内容' : 'hideEmptyPlaceholders=true：隐藏虚线导引，保留纯净构图留白',
  };
});

function buildCardExportBudgetChart(t: ChartThemeTokens): EChartsCoreOption {
  const profiles = ['MP4 · 30 fps', 'MP4 · 24 fps', 'GIF · 20 fps', 'GIF · 15 fps', 'GIF · 12 fps'];
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: t.tooltipBg,
      borderColor: t.border,
      textStyle: { color: t.text, fontSize: 13 },
    },
    legend: {
      top: 4,
      left: 'center',
      icon: 'roundRect',
      itemWidth: 16,
      itemHeight: 9,
      itemGap: 16,
      textStyle: { color: t.text, fontSize: 12.5 },
    },
    grid: { left: 64, right: 64, top: 76, bottom: 42 },
    xAxis: {
      type: 'category',
      data: profiles,
      axisLabel: { color: t.text, fontSize: 12, interval: 0 },
      axisLine: { lineStyle: { color: t.border } },
    },
    yAxis: [
      {
        type: 'value',
        name: '总帧数 (frames)',
        nameGap: 14,
        max: 500,
        nameTextStyle: { color: t.muted, fontSize: 12.5, align: 'left', padding: [0, 0, 0, -20] },
        axisLabel: { color: t.muted, fontSize: 12 },
        splitLine: { lineStyle: { color: t.gridLine } },
      },
      {
        type: 'value',
        name: '时长 (s)',
        nameGap: 14,
        min: 0,
        max: 40,
        nameTextStyle: { color: t.muted, fontSize: 12.5, align: 'right', padding: [0, -14, 0, 0] },
        axisLabel: { color: t.muted, fontSize: 12, formatter: '{value}s' },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '3 s 常用演示帧数',
        type: 'bar',
        barMaxWidth: 22,
        itemStyle: { color: t.series[0], borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: 'top', color: t.text, fontSize: 11.5, formatter: '{c}' },
        data: [90, 72, 60, 45, 36],
      },
      {
        name: '15 s 上限总帧数（护栏 ≤ 450）',
        type: 'bar',
        barMaxWidth: 22,
        itemStyle: { color: t.series[1], borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: 'top', color: t.text, fontSize: 11.5, formatter: '{c}' },
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: t.series[3], type: 'dashed', width: 1.8 },
          label: { color: t.series[3], fontSize: 11.5, formatter: 'MAX_JOB_FRAMES = 450' },
          data: [{ yAxis: 450 }],
        },
        data: [450, 360, 300, 225, 180],
      },
      {
        name: '450 帧理论容许时长 (s)',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbol: 'circle',
        symbolSize: 8,
        lineStyle: { width: 2.4, color: t.series[2] },
        itemStyle: { color: t.series[2] },
        label: { show: true, position: 'top', color: t.series[2], fontSize: 11.5, formatter: '{c}s' },
        data: [15.0, 18.8, 22.5, 30.0, 37.5],
      },
      {
        name: '工坊安全时长封顶 (15 s)',
        type: 'line',
        yAxisIndex: 1,
        symbol: 'none',
        lineStyle: { width: 2, type: 'dotted', color: t.series[4] },
        itemStyle: { color: t.series[4] },
        data: [15.0, 15.0, 15.0, 15.0, 15.0],
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

      <!-- Lightweight Vector Architecture Diagram & Live Visual Legend for Speech Synthesis (Zero Bitmap Images) -->
      <section v-if="module.diagramKey === 'main-architecture'" class="mod-diagram-stack selectable">
        <div class="mod-diagram-box">
          <div class="param-sec-title">
            <span>新版语音合成界面空间分区与联动数据流（纯矢量示意）</span>
            <span class="mono muted">3-Column Upper Deck + 100% Full-Width Timeline</span>
          </div>
          <svg class="mod-arch-svg" viewBox="0 0 960 286" role="img" aria-label="语音合成界面三栏上半区与通栏多轨时间轴架构图">
            <defs>
              <marker id="mainGuideArr" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="currentColor" />
              </marker>
            </defs>

            <!-- Top Global Bar -->
            <rect x="12" y="10" width="936" height="36" rx="7" class="dg-node accent" />
            <text x="480" y="25" class="dg-title">顶栏：[打开文件] 直载 · [语料目录(N)] 按需左抽屉 · 音节/当前音素 · [Tract2Vox-Lite / VTL 2.4] · [参考声纹] · [发送音频] · [导出] · [使用说明]</text>
            <text x="480" y="39" class="dg-sub">语料目录抽屉收起 0 占位；展开后支持多级文件夹授权恢复、搜索、双击载入与拖拽穿透遮罩直投下方时间轴</text>

            <!-- Upper Deck: 3 Strictly Bottom-Aligned Columns -->
            <rect x="12" y="56" width="212" height="122" rx="8" class="dg-group" />
            <text x="22" y="72" class="dg-group-lbl">左栏 · 全高音素替换 (200–360 px 自适应列)</text>
            <rect x="22" y="80" width="192" height="88" rx="6" class="dg-node" />
            <text x="118" y="99" class="dg-title">元音 · 辅音 · 附加符号 · 收藏</text>
            <text x="118" y="116" class="dg-sub">单击替换选中音素 / 叠加附加符</text>
            <text x="118" y="132" class="dg-sub">Ctrl+单击仅复制 · /V/ 与 /aCa/ 试听</text>
            <text x="118" y="148" class="dg-sub">右上跳转 655 条目国际音标表 Plus</text>

            <rect x="234" y="56" width="332" height="122" rx="8" class="dg-group" />
            <text x="244" y="72" class="dg-group-lbl">中栏 · 声道剖面 + 方案 A 19-D 侧栏 (约 44%)</text>
            <rect x="244" y="80" width="190" height="88" rx="6" class="dg-node primary" />
            <text x="339" y="99" class="dg-title">2D / 3D 交互声道视口</text>
            <text x="339" y="116" class="dg-sub">拖拽舌体/舌尖/双唇/下颌/软腭</text>
            <text x="339" y="132" class="dg-sub">合成/录音轨迹跟随 · 标注/网格/头</text>
            <text x="339" y="148" class="dg-sub">[复位] 一键恢复当前音素标准构型</text>
            <rect x="440" y="80" width="116" height="88" rx="6" class="dg-node accent" />
            <text x="498" y="102" class="dg-title">方案 A 侧栏</text>
            <text x="498" y="119" class="dg-sub">点[精调参数]展开</text>
            <text x="498" y="135" class="dg-sub">核心 6 维 + 13 维</text>
            <text x="498" y="151" class="dg-sub">实时预览 · 撤销栈</text>

            <rect x="576" y="56" width="372" height="122" rx="8" class="dg-group" />
            <text x="586" y="72" class="dg-group-lbl">右栏 · 四联声学分析（约 56% · 默认 2×2 全展开）</text>
            <rect x="586" y="80" width="172" height="41" rx="5" class="dg-node" />
            <text x="672" y="98" class="dg-title">A(x) 声道面积函数</text>
            <text x="672" y="113" class="dg-sub">拖拽扫描截面 · 双击追 Amin</text>
            <rect x="766" y="80" width="172" height="41" rx="5" class="dg-node" />
            <text x="852" y="98" class="dg-title">H(f) 传递函数 (5/8 kHz)</text>
            <text x="852" y="113" class="dg-sub">F 共振峰 · P 鼻峰 · Z 零点</text>
            <rect x="586" y="127" width="172" height="41" rx="5" class="dg-node" />
            <text x="672" y="145" class="dg-title">横截面 &amp; 正面唇形</text>
            <text x="672" y="160" class="dg-sub">直拖舌侧缘 TS 与唇宽手柄</text>
            <rect x="766" y="127" width="172" height="41" rx="5" class="dg-node" />
            <text x="852" y="145" class="dg-title">F1–F2 声学元音图</text>
            <text x="852" y="160" class="dg-sub">原音/构型 · 对数/线性 · 缩放平移</text>

            <!-- Lower Deck: 100% Full-Width Timeline -->
            <rect x="12" y="190" width="936" height="86" rx="8" class="dg-group" />
            <text x="24" y="206" class="dg-group-lbl">下半区 · 100% 通栏编译条与 48,000 Hz 五层联动多轨时间轴（横向 SplitPane 调高 225–550 px）</text>
            <rect x="22" y="213" width="916" height="25" rx="5" class="dg-node accent" />
            <text x="480" y="229" class="dg-sub">状态徽章 · [播放] · [原音|降噪|(编辑音频)|重合成] · [声道重建并对齐] · 中英日/IPA/VoQS 编译框 · [词典+存词典] · 构型 · 语速 · [编译入轨]</text>
            <rect x="22" y="243" width="916" height="26" rx="5" class="dg-node primary" />
            <text x="480" y="259" class="dg-title">音节 TextGrid · 音素边界 · 构型关键帧 ◊ · 发声类型 VoQS（可放大 1×–6×）· F0 基频 &amp; PR 肺压 · 试听/裁剪静音/剪切选区/存词典</text>

            <!-- Connecting Dataflow Arrows -->
            <path d="M 224 122 L 238 122" class="dg-arrow" marker-end="url(#mainGuideArr)" />
            <path d="M 566 122 L 580 122" class="dg-arrow" marker-end="url(#mainGuideArr)" />
            <path d="M 118 178 L 118 188" class="dg-arrow dashed" marker-end="url(#mainGuideArr)" />
            <path d="M 339 188 L 339 178" class="dg-arrow" marker-end="url(#mainGuideArr)" />
            <path d="M 760 188 L 760 178" class="dg-arrow dashed" marker-end="url(#mainGuideArr)" />
          </svg>
        </div>

        <div class="mod-diagram-box">
          <div class="param-sec-title">
            <span>工作台状态徽章与多轨视觉记号图例（复用真实语义 Token）</span>
            <span class="mono muted">Synthesis Workspace Legend</span>
          </div>
          <div class="ipa-legend-grid">
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-teal mono">已就绪</span>
              <div>
                <strong>绿色/琥珀/蓝状态徽章</strong>
                <p>绿 = 当前合成音频已缓存就绪；琥珀 = 改动后待合成（点播放即自动合成）；旋转蓝环 = 正在流式分句合成。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-accent mono">[tɕ]</span>
              <div>
                <strong>音素替换格双向高亮</strong>
                <p>青色表示时间轴当前选中音素，蓝色预览表示鼠标悬停目标；单击即替换，Ctrl+单击仅复制字符。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-violet mono">◊ 关键帧</span>
              <div>
                <strong>构型关键帧菱形节点</strong>
                <p>位于音素中心，单击弹出 19 维构型 + 时长 + F0 浮窗，支持 420–1200 ms 局部瞬时试听且自动同步撤销栈。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-success mono">VoQS</span>
              <div>
                <strong>发声类型锚点与 1×–6× 精编</strong>
                <p>展开 5 轨可直接拖移或 Delete 删除；点击「放大发声类型」可在缩放画布上写入 14 类实录 VoQS 与 10 维声门。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-warn mono">F0 / PR</span>
              <div>
                <strong>基频实虚线与手绘钉住圆点</strong>
                <p>实线代表浊音、虚线代表清音过渡；手绘 F0 钉住段自动避开 VoQS 音区覆写并在两端施加 20 ms 羽化。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-danger mono">塞音护栏</span>
              <div>
                <strong>塞音刚性下限与越界拦截</strong>
                <p>闭塞 ≥ 10 ms、释放 ≥ 1 ms，编辑音素浮窗实时核对 VOT；越界参数一律拒绝返回明确区间提示。</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Lightweight Vector Architecture Diagram & Live Cell Legend (Zero Bitmap Images) -->
      <section v-if="module.diagramKey === 'ipa-architecture'" class="mod-diagram-stack selectable">
        <div class="mod-diagram-box">
          <div class="param-sec-title">
            <span>界面空间分区与数据流架构图（纯矢量示意）</span>
            <span class="mono muted">IPA Plus Layout &amp; Dataflow</span>
          </div>
          <svg class="mod-arch-svg" viewBox="0 0 960 248" role="img" aria-label="国际音标表 Plus 界面分区与数据流架构图">
            <defs>
              <marker id="ipaGuideArr" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="currentColor" />
              </marker>
            </defs>

            <!-- Topbar -->
            <rect x="12" y="10" width="936" height="38" rx="7" class="dg-node accent" />
            <text x="480" y="27" class="dg-title">顶栏控制条：返回标注 · IPA (381) / extIPA (209) / VoQS (65) · 子分栏 · 构型方案派生/管理 · 参考录音库 · 点击即播 · 655 检索 · 字号</text>
            <text x="480" y="42" class="dg-sub">快捷键 Ctrl+F 聚焦检索 · Esc 退出录音库或清空检索 · Ctrl+C 复制选中音标 · Space/P 播停试听</text>

            <!-- Left Column -->
            <rect x="12" y="62" width="546" height="174" rx="8" class="dg-group" />
            <text x="24" y="79" class="dg-group-lbl">左栏 · 符号检索、声学图谱与实录审听（可拖拽 SplitPane 自由调宽 36%–74%）</text>

            <rect x="24" y="88" width="256" height="62" rx="6" class="dg-node" />
            <text x="152" y="108" class="dg-title">655 音标体系矩阵与分类卡片</text>
            <text x="152" y="124" class="dg-sub">15×13 辅音（口腔12/喉部3）· 附加/连音线</text>
            <text x="152" y="139" class="dg-sub">extIPA 四视图 · VoQS 三区块 · 参考录音库</text>

            <rect x="292" y="88" width="254" height="62" rx="6" class="dg-node" />
            <text x="419" y="108" class="dg-title">16 点元音四边形 + F1–F3 声学元音图</text>
            <text x="419" y="124" class="dg-sub">对数/线性缩放 · 蓝非圆唇 vs 紫圆唇高斯峰</text>
            <text x="419" y="139" class="dg-sub">实测/重建 ΔF 对比表 · 实时菱形点 · 静音检测</text>

            <rect x="24" y="160" width="522" height="66" rx="6" class="dg-node accent" />
            <text x="285" y="180" class="dg-title">底部常驻：资料 ZIP 下载条 + 波形与 20 ms Hann 窗语谱图（0–6 kHz）</text>
            <text x="285" y="196" class="dg-sub">单音标/全库 ZIP（原音·人工TextGrid·重建音·50Hz轨迹·可选声带MP4）</text>
            <text x="285" y="212" class="dg-sub">拖拽波形或语谱图逐帧同步右栏声道 · 原录音 / 重建音 / 修订音 · 自动增益 / 原始电平</text>

            <!-- Right Column -->
            <rect x="596" y="62" width="352" height="174" rx="8" class="dg-group" />
            <text x="608" y="79" class="dg-group-lbl">右栏 · 物理构型精修、声门曲线与时间轴写入</text>

            <rect x="608" y="88" width="328" height="44" rx="6" class="dg-node primary" />
            <text x="772" y="107" class="dg-title">2D/3D 声道视口（顶栏停靠 HUD 零遮挡）</text>
            <text x="772" y="123" class="dg-sub">编辑方案构型 / 录音反演静态 / 动态构型 · 个人录音替换</text>

            <rect x="608" y="139" width="328" height="40" rx="6" class="dg-node" />
            <text x="772" y="156" class="dg-title">50 Hz 目标帧微调 / VoQS 十维声门曲线 / 权威阐释</text>
            <text x="772" y="171" class="dg-sub">余弦升窗保留协同动程 · 码位 / 例示 / 权威文献与来源定位</text>

            <rect x="608" y="186" width="328" height="40" rx="6" class="dg-node accent" />
            <text x="772" y="203" class="dg-title">写入时间轴音素（或无损叠加附加符）/ 声门锚点</text>
            <text x="772" y="218" class="dg-sub">保存或派生新方案 · 构型保护 · 恢复默认 · 未保存确认</text>

            <!-- Connecting Arrows -->
            <path d="M 558 122 L 592 122" class="dg-arrow" marker-end="url(#ipaGuideArr)" />
            <path d="M 558 193 L 592 162" class="dg-arrow dashed" marker-end="url(#ipaGuideArr)" />
            <path d="M 592 204 L 558 204" class="dg-arrow dashed" marker-end="url(#ipaGuideArr)" />
          </svg>
        </div>

        <div class="mod-diagram-box">
          <div class="param-sec-title">
            <span>音标矩阵单元格视觉记号图例（复用真实样式 Token）</span>
            <span class="mono muted">Matrix Cell Legend</span>
          </div>
          <div class="ipa-legend-grid">
            <div class="ipa-legend-item">
              <span class="ipa-leg-cell ipa">s</span>
              <div>
                <strong>标准可选音标</strong>
                <p>单击载入右栏构型与实录；双击复制字符，不覆写剪贴板。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="ipa-leg-cell is-active ipa">i</span>
              <div>
                <strong>当前选中音标</strong>
                <p>右栏声道、波形语谱图与元音图均同步聚焦此符号。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="ipa-leg-cell is-custom ipa">y</span>
              <div>
                <strong>当前方案已自定义</strong>
                <p>底边绿色指示条，仅标示当前所选构型方案中保存过的改写项。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="ipa-leg-cell is-shaded" aria-hidden="true"></span>
              <div>
                <strong>全阴影（不可能构音）</strong>
                <p>沿用官方 IPA 判定，生理上无法构成该部位与方式组合。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="ipa-leg-cell is-half-shaded ipa">ʔ</span>
              <div>
                <strong>右半阴影（浊音不可能）</strong>
                <p>仅左半清音符号有效，右侧对应浊音生理上不可实现。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="ipa-leg-cell is-unsupported ipa">ɓ</span>
              <div>
                <strong>斜线底纹（无声道重建）</strong>
                <p>内爆音、喷音、啧音超出当前外向肺气流模型，支持阐释与原音试听。</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Lightweight Vector Architecture Diagram & 9-Lane Legend for M27 Reconstruction (Zero Bitmap Images) -->
      <section v-if="module.diagramKey === 'm27-architecture'" class="mod-diagram-stack selectable">
        <div class="mod-diagram-box">
          <div class="param-sec-title">
            <span>声道动态重建三栏分区与离线 / 实时双管线架构图（纯矢量示意）</span>
            <span class="mono muted">M27 Dual-Mode Layout &amp; Pipeline</span>
          </div>
          <svg class="mod-arch-svg" viewBox="0 0 960 272" role="img" aria-label="声道动态重建界面三栏分区与离线实时双管线架构图">
            <defs>
              <marker id="m27GuideArr" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="currentColor" />
              </marker>
            </defs>

            <!-- Left Column -->
            <rect x="12" y="10" width="256" height="252" rx="8" class="dg-group" />
            <text x="24" y="27" class="dg-group-lbl">左栏 · 控制、模型与跨区流转 (232–420 px)</text>

            <rect x="24" y="36" width="232" height="58" rx="6" class="dg-node accent" />
            <text x="140" y="53" class="dg-title">离线输入 · 降噪 · 原文转写对齐</text>
            <text x="140" y="69" class="dg-sub">拖入/麦克风/编辑录音/参考音 · DPDFNet</text>
            <text x="140" y="84" class="dg-sub">SenseVoice · Vox2Tract-Lite 联合对齐/TextGrid</text>

            <rect x="24" y="101" width="232" height="46" rx="6" class="dg-node" />
            <text x="140" y="118" class="dg-title">目标音色 + 声道反演与重合成</text>
            <text x="140" y="134" class="dg-sub">Vox2Spk-Lite · Vox2Tract-Lite · 神经 / VTL</text>

            <rect x="24" y="154" width="232" height="54" rx="6" class="dg-node primary" />
            <text x="140" y="171" class="dg-title">实时滑窗重建与三维人头开关</text>
            <text x="140" y="187" class="dg-sub">纯 ONNX 16 kHz · 0.7–1.0 s 延迟调节</text>
            <text x="140" y="201" class="dg-sub">构型 / 3D 摄像头 / 音色 / 音频 / 留存录音</text>

            <rect x="24" y="215" width="232" height="39" rx="6" class="dg-node accent" />
            <text x="140" y="232" class="dg-title">一键流转至 5 大下游工作区</text>
            <text x="140" y="246" class="dg-sub">标注 · 调音台 · 编曲改音高 · 剪辑 · 连续统 A/B</text>

            <!-- Center Column -->
            <rect x="294" y="10" width="388" height="252" rx="8" class="dg-group" />
            <text x="306" y="27" class="dg-group-lbl">中栏 · 传输剪切栏与多模态主时间轴 / 3D 舞台</text>

            <rect x="306" y="36" width="364" height="46" rx="6" class="dg-node accent" />
            <text x="488" y="53" class="dg-title">顶传输条：三路保位对听 · 倍速 · 短窗试听 · 同步剪切</text>
            <text x="488" y="69" class="dg-sub">原音/神经/物理 · 0.5–1× · ±80/120/200ms · 赋音标 · 裁剪静音/Ctrl+X/Z</text>

            <rect x="306" y="90" width="364" height="84" rx="6" class="dg-node" />
            <text x="488" y="108" class="dg-title">离线模式：0–8 kHz 语谱对齐 + 9 轨完整 27 维物理曲线</text>
            <text x="488" y="124" class="dg-sub">共享零点 1×–12× 光标缩放（≥3× 高清重绘）· 拖拽竖线 / ←→ 1 ms 精调</text>
            <text x="488" y="140" class="dg-sub">声道 5 轨 17 维 (喉颌 / 唇腭 / TC·TB / 舌尖 / 舌侧 TS1–3)</text>
            <text x="488" y="156" class="dg-sub">声门 4 轨 10 维 (F0 / PR / XB·XT·CA·LAG / RA·PS·FL·SHIM)</text>

            <rect x="306" y="182" width="364" height="72" rx="6" class="dg-node primary" />
            <text x="488" y="200" class="dg-title">实时模式：5s 9 轨 27 维示波 ↔ 实时三维透视人头 (Three.js)</text>
            <text x="488" y="216" class="dg-sub">MediaPipe 468 点本地驱动（姿态 / 表情 / 脸型微调 / 默认隐藏原画）</text>
            <text x="488" y="232" class="dg-sub">3/4 · 侧面 · 正面 · 聚焦声带 4 视角 · 半剖/全头透视 · 内部舌腭立体声带</text>

            <!-- Right Column -->
            <rect x="708" y="10" width="240" height="252" rx="8" class="dg-group" />
            <text x="720" y="27" class="dg-group-lbl">右栏 · 三视图解剖 (280–620 px)</text>

            <rect x="720" y="38" width="216" height="96" rx="6" class="dg-node accent" />
            <text x="828" y="61" class="dg-title">正中矢状面声道视口</text>
            <text x="828" y="80" class="dg-sub">舌体 · 舌尖 · 唇 · 颌 · 软腭</text>
            <text x="828" y="97" class="dg-sub">单调梯形累计流粒子（防倒吸）</text>
            <text x="828" y="114" class="dg-sub">器官标注开关 · 未重建预载 JD2</text>

            <rect x="720" y="148" width="216" height="104" rx="6" class="dg-node primary" />
            <text x="828" y="171" class="dg-title">声门俯视 + 声带冠状面</text>
            <text x="828" y="190" class="dg-sub">喉镜俯视：XB / XT / CA 裂隙</text>
            <text x="828" y="207" class="dg-sub">冠状面：Cover–Body 黏膜波 LAG</text>
            <text x="828" y="224" class="dg-sub">「频闪」慢放观测 /「实频」切换</text>
            <text x="828" y="241" class="dg-sub">3D 人头模式下独享全高显示</text>

            <!-- Connecting Arrows -->
            <path d="M 268 78 L 290 112" class="dg-arrow" marker-end="url(#m27GuideArr)" />
            <path d="M 268 182 L 290 210" class="dg-arrow" marker-end="url(#m27GuideArr)" />
            <path d="M 682 118 L 704 88" class="dg-arrow" marker-end="url(#m27GuideArr)" />
            <path d="M 682 146 L 704 196" class="dg-arrow" marker-end="url(#m27GuideArr)" />
            <path d="M 682 218 L 704 218" class="dg-arrow dashed" marker-end="url(#m27GuideArr)" />
          </svg>
        </div>

        <div class="mod-diagram-box">
          <div class="param-sec-title">
            <span>中栏 9 轨完整 27 维参数频道读图图例（50 Hz 真源直绘 · 复用语义 Token）</span>
            <span class="mono muted">5 Tract Lanes (17D) + 4 Glottis Lanes (10D)</span>
          </div>
          <div class="ipa-legend-grid">
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-teal mono">喉颌 %</span>
              <div>
                <strong>HY · HX · JA · JX（4 维，物理范围归一化）</strong>
                <p>喉高 (-6..-3.5 cm)、舌骨前后 (0..1)、颌角 (-7..0°) 与下颌前移 (-0.5..0 cm)，顶部同步报真实读数。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-accent mono">唇腭 %</span>
              <div>
                <strong>LD · LP · VO · VS（4 维，物理范围归一化）</strong>
                <p>唇开度 (-2..4 cm)、圆唇前突 (-1..1)、软腭鼻化开度 (-0.1..1.5) 与软腭形态 (0..1)。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-warn mono">TC/TB</span>
              <div>
                <strong>舌体与舌叶坐标（4 维，真实 -3.0 ~ +6.5 cm）</strong>
                <p>TCX/TCY 实线刻画元音前后高低，TBX/TBY 虚线刻画硬腭与龈腭擦音/塞擦音成阻。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-danger mono">舌尖</span>
              <div>
                <strong>TTX · TTY（2 维，真实 -3.0 ~ +7.5 cm）</strong>
                <p>敏锐反映齿龈音 /t, d, n, s, l/ 与卷舌音 /ʂ, ʐ/ 的舌尖抬升与后卷成阻。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-teal mono">舌侧</span>
              <div>
                <strong>TS1 · TS2 · TS3（3 维，真实比值 -1.0 ~ +1.0）</strong>
                <p>三段舌侧形变，决定边音 /l/ 的侧边气流通道与舌侧沟槽形态。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-warn mono">F0</span>
              <div>
                <strong>基频轨（1 维，自适应宽音域 Hz）</strong>
                <p>SwiftF0 实测与声门基频包络，直观对照汉语四声、英语语调及嘎裂低频段。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-violet mono">PR</span>
              <div>
                <strong>声门下肺压（1 维，真实 0 ~ 1600 Pa 填充）</strong>
                <p>发声气动能量源，页面统一以 Pa 显示，仅在原生引擎边界换算 dPa = Pa × 10。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-success mono">声门 %</span>
              <div>
                <strong>XB · XT · CA · LAG（4 维，物理范围归一化）</strong>
                <p>声带下/上缘位移 (cm)、后软骨裂隙面积 (cm²) 与黏膜波相位滞后 (0..π rad)。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-danger mono">激励 %</span>
              <div>
                <strong>RA · PS · FL · SHIM（4 维，物理范围归一化）</strong>
                <p>周期振幅 RA、脉冲斜率 PS、声带抖动 FL (0..100%) 与嘎裂核心微扰 SHIM (0..100%)。</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Inline Pure-SVG Dialect & Pronunciation Dictionary Architecture (Zero Bitmap Images) -->
      <section v-if="module.diagramKey === 'dialect-architecture'" class="mod-diagram-box selectable">
        <div class="param-sec-title">
          <span>发音字典管理四栏协同与三层词典优先级架构图（纯矢量图示）</span>
          <span class="mono muted">Lexicon · Tone · Sandhi</span>
        </div>
        <svg class="mod-stage-svg" viewBox="0 0 960 226" role="img" aria-label="发音字典管理四栏协同与三层词典优先级架构图">
          <defs>
            <marker id="diaArr" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="currentColor" />
            </marker>
          </defs>
          <!-- Column 1: Three-Tier Dictionary Sources -->
          <rect x="12" y="14" width="212" height="58" rx="8" class="st-box primary" />
          <text x="118" y="37" class="st-title">1. 个人字典（最高优先级）</text>
          <text x="118" y="56" class="st-sub">覆盖内置读音 · 合成与编曲共用在用本</text>

          <rect x="12" y="84" width="212" height="58" rx="8" class="st-box teal" />
          <text x="118" y="107" class="st-title">2. 内置多语词典（只读基线）</text>
          <text x="118" y="126" class="st-sub">常用 4 方案 · 个人支持 10 方案 + CMUdict/日语</text>

          <rect x="12" y="154" width="212" height="58" rx="8" class="st-box violet" />
          <text x="118" y="177" class="st-title">3. 方言字典（内置只读 / 自建）</text>
          <text x="118" y="196" class="st-sub">独立词表 + 调类体系 + 变调 + 构型</text>

          <!-- Column 2: Entry Search & Syllable Capsule Editor -->
          <rect x="262" y="14" width="216" height="92" rx="8" class="st-box accent" />
          <text x="370" y="38" class="st-title">词条检索与导入弹窗</text>
          <text x="370" y="57" class="st-sub">字词/备注/IPA 即时切换检索 · 分页</text>
          <text x="370" y="75" class="st-sub">副本「继承词条 / 个人词条」双视图</text>
          <text x="370" y="93" class="st-sub">CSV/TSV 列映射预览 · JSON 整包交换</text>

          <rect x="262" y="118" width="216" height="94" rx="8" class="st-box teal" />
          <text x="370" y="142" class="st-title">词条编辑与批量同音节替换</text>
          <text x="370" y="161" class="st-sub">整词属性与音节胶囊分层 · 无损连编</text>
          <text x="370" y="179" class="st-sub">单音节拆分 · 复制为新词条 · 就地删除</text>
          <text x="370" y="197" class="st-sub">同音节批量替换（保原声调重音）</text>

          <!-- Column 3: Tone Board & Non-Recursive Sandhi -->
          <rect x="516" y="14" width="224" height="94" rx="8" class="st-box warn" />
          <text x="628" y="38" class="st-title">双画布联动调型手绘板</text>
          <text x="628" y="57" class="st-sub">上画布：赵氏五度 PCHIP 拖点/勾画</text>
          <text x="628" y="75" class="st-sub">下画布：Hz 基频细修 · 联动说话人调域</text>
          <text x="628" y="93" class="st-sub">入声不除阻截断 [◌̚] · SwiftF0 采录</text>

          <rect x="516" y="120" width="224" height="92" rx="8" class="st-box violet" />
          <text x="628" y="144" class="st-title">非递归连读变调与沙盒</text>
          <text x="628" y="163" class="st-sub">优先级：lexical → word_pattern → pair</text>
          <text x="628" y="181" class="st-sub">单次扫描确定收敛 · 独立例词试算</text>
          <text x="628" y="199" class="st-sub">支持调类名称、编号与五度符号</text>

          <!-- Column 4: Downstream Consumers -->
          <rect x="778" y="28" width="170" height="170" rx="9" class="st-box primary" />
          <text x="863" y="58" class="st-title">实时同步下游工作区</text>
          <text x="863" y="84" class="st-sub">语音合成多语 G2P 覆盖</text>
          <text x="863" y="105" class="st-sub">声乐编曲歌词解析词典</text>
          <text x="863" y="126" class="st-sub">方言调型一键写入主轨</text>
          <text x="863" y="147" class="st-sub">关联 19 维 IPA 构型套装</text>
          <text x="863" y="168" class="st-sub">统一保存 · 无幽灵草稿</text>

          <!-- Arrows -->
          <path d="M 224 43 L 258 55" class="st-arrow" marker-end="url(#diaArr)" />
          <path d="M 224 113 L 258 148" class="st-arrow" marker-end="url(#diaArr)" />
          <path d="M 224 183 L 258 174" class="st-arrow" marker-end="url(#diaArr)" />
          <path d="M 478 60 L 512 60" class="st-arrow" marker-end="url(#diaArr)" />
          <path d="M 478 165 L 512 165" class="st-arrow" marker-end="url(#diaArr)" />
          <path d="M 740 62 L 774 92" class="st-arrow" marker-end="url(#diaArr)" />
          <path d="M 740 164 L 774 134" class="st-arrow" marker-end="url(#diaArr)" />
        </svg>
      </section>

      <!-- Lightweight Vector Architecture Diagram & Legend for Voice Mixer (Zero Bitmap Images) -->
      <section v-if="module.diagramKey === 'mixer-pipeline'" class="mod-diagram-stack selectable">
        <div class="mod-diagram-box">
          <div class="param-sec-title">
            <span>发声调音台双模式数据流、门控调制与声学验证架构（纯矢量示意）</span>
            <span class="mono muted">Voice Mixer Pipeline &amp; Layout</span>
          </div>
          <svg class="mod-arch-svg" viewBox="0 0 960 264" role="img" aria-label="发声调音台双模式数据流与界面分区架构图">
            <defs>
              <marker id="mixerGuideArr" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="currentColor" />
              </marker>
            </defs>

            <!-- Left Column: Inputs & Targets -->
            <rect x="12" y="10" width="268" height="244" rx="8" class="dg-group" />
            <text x="24" y="27" class="dg-group-lbl">左栏 · 模式切换、音频载入与目标配置</text>

            <rect x="24" y="36" width="244" height="52" rx="6" class="dg-node accent" />
            <text x="146" y="54" class="dg-title">双模式 + 双音源切换</text>
            <text x="146" y="70" class="dg-sub">发声类型调制（单人）/ 双人器官混合</text>
            <text x="146" y="83" class="dg-sub">Tract2Vox-Lite 神经 / VTL 2.4 物理</text>

            <rect x="24" y="96" width="244" height="62" rx="6" class="dg-node" />
            <text x="146" y="114" class="dg-title">音频输入与可视化裁剪标注</text>
            <text x="146" y="130" class="dg-sub">拖放 / 上传 WAV·FLAC / 录音 / 示例</text>
            <text x="146" y="144" class="dg-sub">Vox2Tract-Lite 反演 50 Hz 27 维 + 512 维声纹</text>
            <text x="146" y="154" class="dg-sub">裁剪弹窗：保留/剪切 + SenseVoice + Vox2Tract</text>

            <rect x="24" y="166" width="244" height="78" rx="6" class="dg-node primary" />
            <text x="146" y="184" class="dg-title">单人 VoQS 预设 / 双人 9 条器官轨</text>
            <text x="146" y="200" class="dg-sub">单人：13 项正式 + 3 项灰度试听 + 自定义提取</text>
            <text x="146" y="214" class="dg-sub">悬停卡片查 9 维参数与 VoQS 实录参考曲线</text>
            <text x="146" y="228" class="dg-sub">双人：胶囊开关启停 · 舌颌/喉位默认相对偏移</text>

            <!-- Center Column: Curve Engine & Acoustic Guard -->
            <rect x="308" y="10" width="388" height="244" rx="8" class="dg-group" />
            <text x="320" y="27" class="dg-group-lbl">右主区 · 时变曲线编辑器 w(t) 与声学防失真守卫</text>

            <rect x="320" y="36" width="364" height="44" rx="6" class="dg-node accent" />
            <text x="502" y="54" class="dg-title">快捷模板 + 撤销重做 + 音节局部塑形条</text>
            <text x="502" y="70" class="dg-sub">渐强/渐弱/凸起/句尾 · Ctrl+Z/Y · 单击音节拉高（Shift 叠加）</text>

            <rect x="320" y="88" width="364" height="76" rx="6" class="dg-node" />
            <text x="502" y="106" class="dg-title">时变调制画布（波形 / STFT 语谱底图）</text>
            <text x="502" y="122" class="dg-sub">单击加点 · 拖拽吸附音素边界（Alt 取消）· 双击/右键删点</text>
            <text x="502" y="137" class="dg-sub">双人模式以半透明虚线叠加其余已启用轨道（幽灵参考线）</text>
            <text x="502" y="152" class="dg-sub">红底阴影 = 静音/清辅音保护区 · 紫虚线 = 平滑目标 · 蓝实线 = 生效曲线</text>

            <rect x="320" y="172" width="364" height="72" rx="6" class="dg-node primary" />
            <text x="502" y="190" class="dg-title">两层底栏：精确节点编辑 + 声学调制参数</text>
            <text x="502" y="206" class="dg-sub">节点层：#n 时间(s) / 权重(%) 数值输入 + 节点药丸快速切换</text>
            <text x="502" y="221" class="dg-sub">声学层：软门控 · 高斯平滑 · 嘎裂脉冲不规则 · 双音调 f₂/f₁ · F0 联动</text>
            <text x="502" y="235" class="dg-sub">双人时间对齐：DTW / Vox2Tract 联合对齐 / 外置 Vox2Align / TextGrid</text>

            <!-- Right Column: Audition, Acoustics & Handoff -->
            <rect x="724" y="10" width="224" height="244" rx="8" class="dg-group" />
            <text x="736" y="27" class="dg-group-lbl">底部 · 试听对比、声学验证与流转</text>

            <rect x="736" y="38" width="200" height="62" rx="6" class="dg-node primary" />
            <text x="836" y="56" class="dg-title">三路互斥同步试听</text>
            <text x="836" y="72" class="dg-sub">原声 / 0% 重建基线 / 调音成品</text>
            <text x="836" y="88" class="dg-sub">进度条可拖拽 · Space 播停 · B 键轮切</text>

            <rect x="736" y="110" width="200" height="64" rx="6" class="dg-node" />
            <text x="836" y="128" class="dg-title">可折叠 12 项声学对比面板</text>
            <text x="836" y="144" class="dg-sub">选区窄/宽带语谱叠印 + 谱差 ΔdB</text>
            <text x="836" y="160" class="dg-sub">H1−H2* / CPP / HNR / 谱倾斜 + CSV</text>

            <rect x="736" y="184" width="200" height="60" rx="6" class="dg-node accent" />
            <text x="836" y="202" class="dg-title">WAV 导出与 6 路工作区流转</text>
            <text x="836" y="218" class="dg-sub">送入声道重建 / 标注 / 编曲 / 剪辑</text>
            <text x="836" y="233" class="dg-sub">或直达声道连续统端点 A / B</text>

            <!-- Connecting Arrows -->
            <path d="M 280 126 L 304 126" class="dg-arrow" marker-end="url(#mixerGuideArr)" />
            <path d="M 696 72 L 720 72" class="dg-arrow" marker-end="url(#mixerGuideArr)" />
            <path d="M 696 142 L 720 142" class="dg-arrow" marker-end="url(#mixerGuideArr)" />
            <path d="M 696 212 L 720 212" class="dg-arrow dashed" marker-end="url(#mixerGuideArr)" />
          </svg>
        </div>

        <div class="mod-diagram-box">
          <div class="param-sec-title">
            <span>曲线画布视觉图层与轨道开关图例（复用真实样式 Token）</span>
            <span class="mono muted">Mixer Canvas Visual Legend</span>
          </div>
          <div class="ipa-legend-grid">
            <div class="ipa-legend-item">
              <span class="ipa-leg-cell is-active mono">实</span>
              <div>
                <strong>主题色实线：门控后实际生效曲线</strong>
                <p>最终送入神经或物理合成器的逐帧混合权重；在保护区内会自动回落，防止静音与清辅音失真。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="ipa-leg-cell is-custom mono">虚</span>
              <div>
                <strong>紫/灰虚线：平滑目标曲线 &amp; 幽灵参考线</strong>
                <p>紫虚线展示高斯平滑后、软门控前的目标包络；双人模式下淡虚线显示其余已启用轨道轮廓，便于跨器官对时。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="ipa-leg-cell is-rec mono">护</span>
              <div>
                <strong>红色底纹：静音与清辅音保护区</strong>
                <p>由 SwiftF0 带声门控与肺压门控自动检出；耳语或清化目标会自动切换为全语音活动门控。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="ipa-leg-cell is-muted mono">界</span>
              <div>
                <strong>青色竖虚线：音素/音节对齐边界</strong>
                <p>默认通过 Vox2Tract-Lite 内置联合对齐（或外置 Vox2Align-Lite v2 / TextGrid）显示在画布顶部，拖拽自动吸附（Alt 取消）。</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Lightweight Vector Architecture Diagram & Cell Legend for Continuum (Zero Bitmap Images) -->
      <section v-if="module.diagramKey === 'continuum-pipeline'" class="mod-diagram-stack selectable">
        <div class="mod-diagram-box">
          <div class="param-sec-title">
            <span>声道连续统界面分区、保护插值与导出数据流（纯矢量示意）</span>
            <span class="mono muted">Continuum Pipeline &amp; Layout</span>
          </div>
          <svg class="mod-arch-svg" viewBox="0 0 960 256" role="img" aria-label="声道连续统界面分区与数据流架构图">
            <defs>
              <marker id="contGuideArr" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="currentColor" />
              </marker>
            </defs>

            <!-- Left Sidebar -->
            <rect x="12" y="10" width="268" height="236" rx="8" class="dg-group" />
            <text x="24" y="27" class="dg-group-lbl">左栏 · 端点与实验变量配置（切页自动持久化）</text>

            <rect x="24" y="36" width="244" height="58" rx="6" class="dg-node accent" />
            <text x="146" y="54" class="dg-title">端点 A ↔ 端点 B（四来源 + 一键互换）</text>
            <text x="146" y="70" class="dg-sub">预设 / 自由音素 / 重建帧 / 录音与导入</text>
            <text x="146" y="85" class="dg-sub">录后弹窗裁剪·去静音·降噪·原文对齐</text>

            <rect x="24" y="102" width="244" height="52" rx="6" class="dg-node" />
            <text x="146" y="120" class="dg-title">单双轴矩阵与变化维度</text>
            <text x="146" y="136" class="dg-sub">单轴 2–51 格 · 双轴 2–16 列 × 2–8 行</text>
            <text x="146" y="149" class="dg-sub">混合 / F0 / VoQS / 时长 / 气压 / 17 构音</text>

            <rect x="24" y="162" width="244" height="36" rx="6" class="dg-node" />
            <text x="146" y="178" class="dg-title">构音锁定（含唇形/舌形）+ 等时长对齐</text>
            <text x="146" y="192" class="dg-sub">自动检测锁定与变化轴冲突 · clip 有效时长</text>

            <rect x="24" y="204" width="244" height="34" rx="6" class="dg-node primary" />
            <text x="146" y="220" class="dg-title">VTL 2.4 (48k) / Tract2Vox-Lite (16k)</text>
            <text x="146" y="233" class="dg-sub">神经统一参考声纹 · 仅导出参数 JSON</text>

            <!-- Center Kernel & Main Grid -->
            <rect x="308" y="10" width="388" height="236" rx="8" class="dg-group" />
            <text x="320" y="27" class="dg-group-lbl">主区 · 三段式工具栏、轮廓网格与声学-构音联合分析区</text>

            <rect x="320" y="36" width="364" height="34" rx="6" class="dg-node accent" />
            <text x="502" y="51" class="dg-title">三段式工具栏：序列批处理 | 单格操作 | 视口与分析区</text>
            <text x="502" y="64" class="dg-sub">批处理支持中途取消 · 缩放 % 联动 · 快捷键 ←/→/↑/↓ + Space</text>

            <rect x="320" y="78" width="364" height="72" rx="6" class="dg-node" />
            <text x="502" y="96" class="dg-title">声道轮廓矩阵（阻塞音保护插值 + 精准依赖缓存）</text>
            <text x="502" y="113" class="dg-sub">单击选中 · 双击或右上小播键试听 · 绿点 = 已合成缓存</text>
            <text x="502" y="128" class="dg-sub">滚轮缩放 / 拖拽平移 · 改 F0/时长/气压不重载静态轮廓</text>
            <text x="502" y="143" class="dg-sub">动态录音启用 timeWarp 音素边界对齐与逐帧播放动画</text>

            <rect x="320" y="158" width="364" height="80" rx="6" class="dg-node primary" />
            <text x="502" y="176" class="dg-title">可折叠联合分析区（ContinuumInspectorPanel）</text>
            <text x="502" y="193" class="dg-sub">① 选中格高清大图 + A/B 端点舌位虚线叠影对比</text>
            <text x="502" y="209" class="dg-sub">② 语音学标准 F1–F2 元音空间轨迹（点击节点切格）</text>
            <text x="502" y="225" class="dg-sub">③ 主要变化前 6 项构音参数 A → 当前 → B 对照表</text>

            <!-- Right Outputs -->
            <rect x="724" y="10" width="224" height="236" rx="8" class="dg-group" />
            <text x="736" y="27" class="dg-group-lbl">右侧 · 科研导出与跨模块交接</text>

            <rect x="736" y="38" width="200" height="62" rx="6" class="dg-node primary" />
            <text x="836" y="57" class="dg-title">完整刺激包 ZIP</text>
            <text x="836" y="73" class="dg-sub">wav/*.wav + manifest.json</text>
            <text x="836" y="88" class="dg-sub">+ acoustic_table.csv (UTF-8)</text>

            <rect x="736" y="110" width="200" height="58" rx="6" class="dg-node" />
            <text x="836" y="129" class="dg-title">音视频与拼接导出</text>
            <text x="836" y="145" class="dg-sub">序列拼接 WAV（含 0.22s 间隔）</text>
            <text x="836" y="160" class="dg-sub">单格 WAV · 随视口 WebM 视频</text>

            <rect x="736" y="178" width="200" height="58" rx="6" class="dg-node accent" />
            <text x="836" y="197" class="dg-title">无损交接至其他工作区</text>
            <text x="836" y="213" class="dg-sub">送到标注（携带音频/构型/标注）</text>
            <text x="836" y="228" class="dg-sub">送到剪辑（直入 V1+A1 成片）</text>

            <!-- Connecting Arrows -->
            <path d="M 280 120 L 304 120" class="dg-arrow" marker-end="url(#contGuideArr)" />
            <path d="M 696 72 L 720 72" class="dg-arrow" marker-end="url(#contGuideArr)" />
            <path d="M 696 138 L 720 138" class="dg-arrow" marker-end="url(#contGuideArr)" />
            <path d="M 696 204 L 720 204" class="dg-arrow dashed" marker-end="url(#contGuideArr)" />
          </svg>
        </div>

        <div class="mod-diagram-box">
          <div class="param-sec-title">
            <span>连续统单元格状态与操作记号图例（复用真实样式 Token）</span>
            <span class="mono muted">Continuum Cell Legend</span>
          </div>
          <div class="ipa-legend-grid">
            <div class="ipa-legend-item">
              <span class="ipa-leg-cell is-active mono">1</span>
              <div>
                <strong>蓝色外框：当前选中格</strong>
                <p>单击任意格即选中，顶栏数值与下方联合分析区（大图叠影、F1–F2 节点、参数表）即时同步。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="ipa-leg-cell is-custom mono">3</span>
              <div>
                <strong>左上绿点：音频已缓存就绪</strong>
                <p>该格已完成本机合成并缓存在会话中，再次双击或序列试听时直接秒播，切页返回不丢失。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="ipa-leg-cell mono">A:B</span>
              <div>
                <strong>右上角标：步进参数与播放键</strong>
                <p>混合轴显示 100% A / 75:25 / 100% B，其他轴显示精确 Hz / ms / Pa / VoQS；旁侧小播放键可直接试听。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="ipa-leg-cell mono">F1/2</span>
              <div>
                <strong>底栏读数：共振峰或次级轴值</strong>
                <p>构音变化时显示 VTL 传递函数 F1 / F2；启用 F0、时长或气压轴时突出展示该格的物理控制值。</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Inline Pure-SVG Pipeline Schematic (Zero Bitmap Images) -->
      <section v-if="module.diagramKey === 'stage-pipeline'" class="mod-diagram-box selectable">
        <div class="param-sec-title">
          <span>剪辑合成栈与 48 kHz 音画导出架构图（纯矢量图示）</span>
          <span class="mono muted">V0–V3 × A1–A12 / A3</span>
        </div>
        <svg class="mod-stage-svg" viewBox="0 0 960 218" role="img" aria-label="剪辑页面多层合成与音画导出管线示意图">
          <defs>
            <marker id="stArr" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="currentColor" />
            </marker>
          </defs>
          <!-- Column 1: Audio & Beat Analysis -->
          <rect x="12" y="14" width="218" height="84" rx="8" class="st-box teal" />
          <text x="121" y="38" class="st-title">A1–A12 人声轨 + A3 伴奏轨</text>
          <text x="121" y="57" class="st-sub">独立增益 · 静音 M · 独奏 S · 音量包络</text>
          <text x="121" y="75" class="st-sub">同源联动驱动 V1 声道 + V3 字幕</text>

          <rect x="12" y="114" width="218" height="86" rx="8" class="st-box warn" />
          <text x="121" y="138" class="st-title">纯本地节拍网格 (Beat Sync)</text>
          <text x="121" y="157" class="st-sub">45–160 Hz 鼓点包络 + 最小二乘回归</text>
          <text x="121" y="175" class="st-sub">标尺拍点 · 拖拽吸附 · 节拍脉冲/震屏</text>

          <!-- Column 2: V0-V3 Visual Layer Stack -->
          <rect x="274" y="14" width="256" height="40" rx="7" class="st-box warn" />
          <text x="402" y="32" class="st-title">V3 歌词字幕层（最多 8 子轨）</text>
          <text x="402" y="47" class="st-sub">卡拉 OK 柔边随读 · 就地改字/IPA · 9 转场</text>

          <rect x="274" y="62" width="256" height="40" rx="7" class="st-box violet" />
          <text x="402" y="80" class="st-title">V2 角色形象层（最多 8 子轨）</text>
          <text x="402" y="95" class="st-sub">静态 PNG/JPG/WebP · 8 缓动关键帧 · 9 转场</text>

          <rect x="274" y="110" width="256" height="40" rx="7" class="st-box teal" />
          <text x="402" y="128" class="st-title">V1 声道解剖层（最多 8 子轨）</text>
          <text x="402" y="143" class="st-sub">多声部并排包围盒 · 8 缓动关键帧 · 9 转场</text>

          <rect x="274" y="158" width="256" height="42" rx="7" class="st-box accent" />
          <text x="402" y="176" class="st-title">V0 电影舞台与全局运镜层</text>
          <text x="402" y="191" class="st-sub">8 调色风格 + 透视网格 · 6 运镜 + 手持漂移</text>

          <!-- Column 3: Post Polish & Unified Export -->
          <rect x="574" y="14" width="176" height="86" rx="8" class="st-box accent" />
          <text x="662" y="38" class="st-title">电影质感后处理</text>
          <text x="662" y="57" class="st-sub">暗角 · 确定性胶片颗粒</text>
          <text x="662" y="75" class="st-sub">高光晕染 · 3 种片尾收尾</text>

          <rect x="574" y="114" width="176" height="86" rx="8" class="st-box" />
          <text x="662" y="138" class="st-title">16:9 实时监看舞台</text>
          <text x="662" y="157" class="st-sub">直拖定位 · 四角等比缩放</text>
          <text x="662" y="175" class="st-sub">自动插帧 · 5% 安全框</text>

          <rect x="786" y="24" width="162" height="168" rx="9" class="st-box primary" />
          <text x="867" y="54" class="st-title">同核逐帧导出</text>
          <text x="867" y="78" class="st-sub">MP4 (H.264 30/60fps)</text>
          <text x="867" y="99" class="st-sub">WebM 实时录制</text>
          <text x="867" y="120" class="st-sub">总混音 WAV/FLAC</text>
          <text x="867" y="141" class="st-sub">MP3 / M4A (48 kHz)</text>
          <text x="867" y="162" class="st-sub">SRT / ASS · .vcproj</text>

          <!-- Arrows -->
          <path d="M 230 56 L 270 124" class="st-arrow" marker-end="url(#stArr)" />
          <path d="M 230 46 L 270 36" class="st-arrow" marker-end="url(#stArr)" />
          <path d="M 230 158 L 270 176" class="st-arrow dashed" marker-end="url(#stArr)" />
          <path d="M 530 105 L 570 58" class="st-arrow" marker-end="url(#stArr)" />
          <path d="M 530 120 L 570 152" class="st-arrow" marker-end="url(#stArr)" />
          <path d="M 750 58 L 782 88" class="st-arrow" marker-end="url(#stArr)" />
          <path d="M 750 154 L 782 130" class="st-arrow dashed" marker-end="url(#stArr)" />
        </svg>
      </section>

      <!-- Lightweight Vector Architecture, Live Reused Nested Tree Map & 5-Zone Dock Schematic for Card Studio (Zero Bitmap Images) -->
      <section v-if="module.diagramKey === 'card-architecture'" class="mod-diagram-stack selectable">
        <div class="mod-diagram-box">
          <div class="param-sec-title">
            <span>发音卡三栏工坊架构与双出口编码管线（纯矢量示意）</span>
            <span class="mono muted">3-Column Resizable Studio &amp; Dual Export Pipeline</span>
          </div>
          <svg class="mod-arch-svg" viewBox="0 0 960 284" role="img" aria-label="发音卡三栏工坊空间分区与导出数据流架构图">
            <defs>
              <marker id="cardGuideArr" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="currentColor" />
              </marker>
            </defs>

            <!-- Top Studio Bar -->
            <rect x="12" y="10" width="936" height="36" rx="7" class="dg-node accent" />
            <text x="480" y="25" class="dg-title">顶栏：标题 · 实时尺寸 (360–3840 px) · [撤销 Ctrl+Z / 重做] · [载入当前工作台推荐模块] · [使用说明] · [Esc 关闭]</text>
            <text x="480" y="39" class="dg-sub">独立 40 步历史栈与键盘隔离，不误触主工作台撤销与播停；左右 SplitPane 可自由调宽，双击复位</text>

            <!-- Left Column: Module Gallery -->
            <rect x="12" y="56" width="214" height="148" rx="8" class="dg-group" />
            <text x="22" y="72" class="dg-group-lbl">左栏 · 16 模块元素库 (240–420 px)</text>
            <rect x="22" y="80" width="194" height="50" rx="6" class="dg-node" />
            <text x="119" y="99" class="dg-title">5 套推荐组合 · 7 类筛选</text>
            <text x="119" y="116" class="dg-sub">含「已选」过滤与一键清空</text>
            <rect x="22" y="136" width="194" height="58" rx="6" class="dg-node" />
            <text x="119" y="155" class="dg-title">实录状态徽章 · 双方式入画布</text>
            <text x="119" y="171" class="dg-sub">绿「已有数据/就绪」· 灰「示范」</text>
            <text x="119" y="185" class="dg-sub">单击快速勾选或直接拖入画布</text>

            <!-- Center Column: Canvas & Adaptive Timeline -->
            <rect x="236" y="56" width="424" height="148" rx="8" class="dg-group" />
            <text x="246" y="72" class="dg-group-lbl">中栏 · Split-Tree 交互画布与自适应时间轴</text>
            <rect x="246" y="80" width="404" height="68" rx="6" class="dg-node primary" />
            <text x="448" y="99" class="dg-title">离屏 VTL 2D/3D + 像素重映射语谱 + 递归分栏树</text>
            <text x="448" y="116" class="dg-sub">整卡拖动 &gt;5 px 五区吸附 · 柔和间隙调占比（双击均分）</text>
            <text x="448" y="133" class="dg-sub">悬停右下角移除不挡标题 · 声道格滚轮缩放 · 所见即所得留白</text>
            <rect x="246" y="154" width="404" height="40" rx="6" class="dg-node accent" />
            <text x="448" y="171" class="dg-title">底部自适应时间轴 · 7 路动态源自动匹配</text>
            <text x="448" y="186" class="dg-sub">PNG：高精度选帧定格 · MP4/GIF：起止裁剪 / 循环 / 实机样片预览</text>

            <!-- Right Column: 3-Tab Structured Inspector -->
            <rect x="670" y="56" width="278" height="148" rx="8" class="dg-group" />
            <text x="680" y="72" class="dg-group-lbl">右栏 · 三页签检查器 (292–480 px)</text>
            <rect x="680" y="80" width="258" height="36" rx="5" class="dg-node" />
            <text x="809" y="96" class="dg-title">① 画幅与排版</text>
            <text x="809" y="110" class="dg-sub">6 比例 · 1:1 嵌套树拆格占比 · 本地方案</text>
            <rect x="680" y="121" width="258" height="36" rx="5" class="dg-node" />
            <text x="809" y="137" class="dg-title">② 样式与标题</text>
            <text x="809" y="151" class="dg-sub">6 色板 · 8 风格 · 9 字体 · 默认关标题栏</text>
            <rect x="680" y="162" width="258" height="34" rx="5" class="dg-node" />
            <text x="809" y="177" class="dg-title">③ 模块细节</text>
            <text x="809" y="191" class="dg-sub">2D/3D · 合成 6 轨 · 连续统行列 · 参考云</text>

            <!-- Bottom Dual Export Pipeline -->
            <rect x="12" y="214" width="458" height="60" rx="8" class="dg-node accent" />
            <text x="241" y="236" class="dg-title">出口 A · 浏览器纯前端 PNG（零代理依赖）</text>
            <text x="241" y="253" class="dg-sub">离屏高清 Canvas 毫秒出图 · 一键「复制图片」直贴剪贴板或下载原图</text>
            <text x="241" y="267" class="dg-sub">hideEmptyPlaceholders=true 忠实保留构图留白</text>

            <rect x="486" y="214" width="462" height="60" rx="8" class="dg-node primary" />
            <text x="717" y="236" class="dg-title">出口 B · 本地代理分批编码 MP4 / GIF（FFmpeg）</text>
            <text x="717" y="253" class="dg-sub">/api/explore/card-job 分批帧流 + 48 kHz WAV → H.264+AAC / 调色板 GIF</text>
            <text x="717" y="267" class="dg-sub">450 帧音画 1:1 护栏 · 样片免重编直接保存 · 进度条与随时取消</text>

            <!-- Dataflow Arrows -->
            <path d="M 226 128 L 240 128" class="dg-arrow" marker-end="url(#cardGuideArr)" />
            <path d="M 660 128 L 674 128" class="dg-arrow" marker-end="url(#cardGuideArr)" />
            <path d="M 380 204 L 290 212" class="dg-arrow" marker-end="url(#cardGuideArr)" />
            <path d="M 550 204 L 660 212" class="dg-arrow" marker-end="url(#cardGuideArr)" />
            <path d="M 809 204 L 780 212" class="dg-arrow dashed" marker-end="url(#cardGuideArr)" />
          </svg>
        </div>

        <!-- Reused Live CardLayoutTreeMap + Pure SVG 5-Zone Dock Diagram -->
        <div class="mod-diagram-box">
          <div class="param-sec-title">
            <span>交互式嵌套分栏树示例（直接复用真实 CardLayoutTreeMap）与五区拖拽吸附热区</span>
            <span class="mono muted">Live Tree Reuse &amp; 24% / 52% Drop Zones</span>
          </div>
          <div class="card-guide-dual">
            <div class="card-guide-tree-demo">
              <div class="card-guide-sample-bar">
                <div class="seg" role="radiogroup" aria-label="选择发音卡版面结构预设">
                  <button
                    v-for="s in CARD_GUIDE_TREE_SAMPLES"
                    :key="s.id"
                    type="button"
                    :class="{ active: cardGuideSampleId === s.id }"
                    @click="selectCardGuideSample(s.id)"
                  >
                    {{ s.label }}
                  </button>
                </div>
                <span class="tree-tag mono">
                  {{ activeCardGuideLeafInfo.isNested ? '嵌套分栏' : '规整网格' }}
                </span>
              </div>
              <p class="muted card-guide-sample-desc">{{ activeCardGuideSample.desc }}</p>
              <div class="card-guide-tree-stage">
                <div class="card-guide-tree-wrap">
                  <CardLayoutTreeMap
                    :node="activeCardGuideSample.tree"
                    :selected-leaf-id="cardGuideSelectedLeafId"
                    @select="(leafId) => (cardGuideSelectedLeafId = leafId)"
                  />
                </div>
                <div class="card-guide-leaf-readout">
                  <div class="leaf-ro-row">
                    <span class="muted">选中槽位</span>
                    <strong>{{ activeCardGuideLeafInfo.moduleTitle }}</strong>
                  </div>
                  <div class="leaf-ro-row">
                    <span class="muted">水平分栏占比</span>
                    <span class="mono">{{ activeCardGuideLeafInfo.rowPct }}</span>
                  </div>
                  <div class="leaf-ro-row">
                    <span class="muted">垂直分栏占比</span>
                    <span class="mono">{{ activeCardGuideLeafInfo.colPct }}</span>
                  </div>
                  <div class="leaf-ro-row">
                    <span class="muted">最终导出行为</span>
                    <span>{{ activeCardGuideLeafInfo.exportRule }}</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="card-guide-dock-demo">
              <div class="card-guide-dock-head">
                <strong>五区整卡拖拽吸附热区（detectDropZone）</strong>
                <span class="mono muted">四边 24% 嵌套分栏 · 中央 52% 互换或填空</span>
              </div>
              <svg class="card-dock-svg" viewBox="0 0 360 208" role="img" aria-label="发音卡五区拖拽吸附热区矢量图">
                <rect x="8" y="8" width="344" height="192" rx="10" class="dg-group" />
                <!-- Top 24% -->
                <rect x="18" y="16" width="324" height="40" rx="6" class="dg-node accent" />
                <text x="180" y="34" class="dg-title">上边缘 24% · top</text>
                <text x="180" y="48" class="dg-sub">原地拆为纵向 col，插入上方新分支</text>
                <!-- Left 24% -->
                <rect x="18" y="62" width="84" height="84" rx="6" class="dg-node accent" />
                <text x="60" y="98" class="dg-title">左 24%</text>
                <text x="60" y="114" class="dg-sub">left 拆行</text>
                <!-- Center 52% -->
                <rect x="108" y="62" width="144" height="84" rx="6" class="dg-node primary" />
                <text x="180" y="96" class="dg-title">中央 52% · swap</text>
                <text x="180" y="113" class="dg-sub">有模块：原地互换槽位</text>
                <text x="180" y="128" class="dg-sub">留白空槽：直接填入</text>
                <!-- Right 24% -->
                <rect x="258" y="62" width="84" height="84" rx="6" class="dg-node accent" />
                <text x="300" y="98" class="dg-title">右 24%</text>
                <text x="300" y="114" class="dg-sub">right 拆行</text>
                <!-- Bottom 24% -->
                <rect x="18" y="152" width="324" height="40" rx="6" class="dg-node accent" />
                <text x="180" y="170" class="dg-title">下边缘 24% · bottom</text>
                <text x="180" y="184" class="dg-sub">原地拆为纵向 col，插入下方新分支</text>
              </svg>
            </div>
          </div>
        </div>

        <!-- Visual Token Legend -->
        <div class="mod-diagram-box">
          <div class="param-sec-title">
            <span>工坊关键视觉徽章与状态记号图例（复用真实语义 Token）</span>
            <span class="mono muted">Card Studio Visual Legend</span>
          </div>
          <div class="ipa-legend-grid">
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-success mono">已有数据</span>
              <div>
                <strong>左侧模块实时数据徽章</strong>
                <p>绿色徽章（已有词句 / 反演就绪 / 调音就绪 / 实录就绪等）表示工作区已有真实快照；中性灰「示范音标 / 待录入 / 工程示意」等则以内置示例预览。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-accent mono">嵌套分栏</span>
              <div>
                <strong>结构类型自动识别标签</strong>
                <p>检测到任意非对称拆分时显示「嵌套分栏」，保护结构不被拍平，自动切用缩略图选格与水平/垂直占比滑杆。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-violet mono">留白空槽</span>
              <div>
                <strong>所见即所得呼吸留白槽</strong>
                <p>画布内以柔和虚线提示可随时拖入模块；正式导出自动隐藏虚线框并完整保留留白，点「收拢空槽」可一键铺满。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-teal mono">色板同步</span>
              <div>
                <strong>全模块离屏色彩统一</strong>
                <p>6 套色板与 8 种风格同步注入 2D SVG 声道底色、3D WebGL 清屏色与像素重映射语谱图，且绝不改动主站皮肤。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-warn mono">450 帧锁</span>
              <div>
                <strong>MP4 / GIF 音画 1:1 护栏</strong>
                <p>后端分批编码上限 450 帧且时长封顶 15 秒，MP4 宽高自动偶像素对齐，确保视频帧流与 48 kHz 音轨不脱节。</p>
              </div>
            </div>
            <div class="ipa-legend-item">
              <span class="m27-lane-badge tone-danger mono">可取消</span>
              <div>
                <strong>长编码进度与即时中断</strong>
                <p>MP4/GIF 导出中展示进度条与红色取消按钮，中止后立即清理本地代理临时任务；实机样片预览满意后免重编直接保存。</p>
              </div>
            </div>
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
        v-if="module.chartKey === 'mainSynthesisPhysics'"
        title="原理解析图 · 汉语清送气塞音 + 元音 [pʰa˥˥] 的 200 Hz 实算物理控制包络"
        subtitle="由前端生产编译器 buildAnnotationSynthesis() 与 stopPhaseBoundaries() 现场编译：对照肺压 PR (Pa)、双唇间距 LD (cm) 与 qTA 阴平 F0 (Hz)"
        badge="buildAnnotationSynthesis 实算"
        :height="325"
        :revision="mainPhysicsRevision"
        :option-builder="buildMainSynthesisPhysicsChart"
        caption="闭塞段（55 ms ≥ 10 ms 刚性下限）双唇紧闭（LD 处于闭塞负值）同时声门下蓄压；除阻（10 ms ≥ 1 ms）后经 40 ms 送气 VOT 段声带起振，F0 沿 3 阶 qTA 平滑落入阴平 55 靶位，全部曲线均取自真实生产编译器输出。"
      />

      <TechChart
        v-if="module.chartKey === 'coarticulation'"
        title="原理解析图 · 目标帧余弦升窗微调如何保留前后协同发音动程"
        :subtitle="`数据来源：${coartSeries.sourceLabel}；对比生产函数 bellSuperimposedRow() 局部偏移与传统常数块硬替换`"
        badge="bellSuperimposedRow 实算"
        :height="325"
        :revision="coartRevision"
        :option-builder="buildCoarticulationChart"
        caption="在元音核靶心帧对舌体前后坐标 TCX 施加余弦升窗偏移后，作用区内平滑过渡并精确过靶，前后辅音协同轨迹完整保留；反观常数块直接替换会在区间边界制造垂直阶跃跳变，易引发声道合成爆音。"
      />

      <TechChart
        v-if="module.chartKey === 'voqsScale'"
        title="VoQS 标量度 1 / 2 / 3 参数映射速查图"
        subtitle="发声类型混合权重（%）与喉位垂直偏移量（±cm）逐级对应关系"
        badge="Ball et al. 2018"
        :height="310"
        :option-builder="buildVoqsScaleChart"
        caption="省略标量数字（如 {V̤ ... V̤}）时默认采用 2 度（70% 声门混合 / ±0.50 cm 喉高偏移），离开闭合花括号后自动平滑恢复常态浊声。"
      />

      <TechChart
        v-if="module.chartKey === 'stageCinemaCurves'"
        title="电影级 8 档关键帧贝塞尔缓动曲线（复用 stage-motion.ts 实时求解）"
        subtitle="展示归一化时间 u ∈ [0, 1] 下的位移响应 y(u)，直观区分急停、平滑、蓄力回拉 (< 0) 与过冲回弹 (> 1)"
        badge="Cubic-Bezier Kernel"
        :height="325"
        :option-builder="buildStageCinemaCurvesChart"
        caption="在剪辑台为 V1 / V2 / V3 关键帧切换缓动曲线时，监看与成片导出均调用同一 Newton-Raphson 贝塞尔求解器，保证逐帧严丝合缝。"
      />

      <TechChart
        v-if="module.chartKey === 'm27RealtimeBudget'"
        title="实时滑窗推理延迟档位与上下文窗口对照图（50 Hz / 20 ms 帧步）"
        subtitle="对应 m27-realtime.ts 实装参数：调高监听延迟可增加右侧前瞻与上下文窗长，提升 Tract2Vox-Lite 实时语音连贯度"
        badge="Realtime Window Budget"
        :height="320"
        :option-builder="buildM27RealtimeBudgetChart"
        caption="关闭「实时合成音频」仅观察声道构型时自动切至超低延迟几何窗口（前瞻仅 60 ms / 产出 100 ms）；开启音频监听默认 0.7 s，在弱 CPU 或咬字偏快时建议切到 0.9–1.0 s。"
      />

      <TechChart
        v-if="module.chartKey === 'cardExportBudget'"
        title="动态发音卡帧率、450 帧编码护栏与安全时长对照图"
        subtitle="对应 server/card-encoding.mjs (MAX_JOB_FRAMES = 450) 与 CardStudioModal 时长限幅：确保 MP4 视频帧数与 48,000 Hz 音轨 1:1 严格对齐"
        badge="450-Frame A/V Lock"
        :height="325"
        :option-builder="buildCardExportBudgetChart"
        caption="30 fps 下 15 秒恰好触及 450 帧编码上限；24 fps 及 GIF 12–20 fps 虽在 450 帧内理论可容纳更长时间，工坊统一将单次动态卡片时长封顶于 15.0 秒，以兼顾本地编码耗时、成片体积（上限 120 MB）与播放流畅度。"
      />

      <!-- Arranger Zero-Image Diagrams: Vector Architecture + Interactive 5-Notation Comparator + qTA Glide Chart -->
      <template v-if="module.chartKey === 'arrangerOverview'">
        <section class="mod-svg-box selectable">
          <div class="param-sec-title">
            <span>声乐编曲单真源架构与数据流（48 kHz 统一事件轴）</span>
            <span class="mono muted">Arranger Pipeline</span>
          </div>
          <svg class="arr-flow-svg" viewBox="0 0 920 156" role="img" aria-label="声乐编曲数据流示意图">
            <defs>
              <marker id="arrFlowArrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="currentColor" />
              </marker>
            </defs>
            <rect x="10" y="14" width="184" height="54" rx="8" class="af-node accent" />
            <text x="102" y="36" class="af-title">五种简谱 + 歌词/IPA</text>
            <text x="102" y="54" class="af-sub">JE / 4 开源 DSL · 《》单字包裹</text>

            <rect x="10" y="88" width="184" height="54" rx="8" class="af-node accent" />
            <text x="102" y="110" class="af-title">外部乐谱 / 真人重建</text>
            <text x="102" y="128" class="af-sub">MIDI · VSQX · SVP · 声道重建轨迹</text>

            <rect x="240" y="28" width="214" height="100" rx="9" class="af-node primary" />
            <text x="347" y="54" class="af-title">统一事件真源 EventNote[]</text>
            <text x="347" y="75" class="af-sub">钢琴卷帘 · 简谱区 · 音节表三向同步</text>
            <text x="347" y="95" class="af-sub">宽音域自由编排 · 选段移调</text>
            <text x="347" y="114" class="af-sub">M / S / 锁定 / 轨道音量</text>

            <rect x="500" y="28" width="186" height="100" rx="9" class="af-node" />
            <text x="593" y="54" class="af-title">声乐调度与物理控制</text>
            <text x="593" y="75" class="af-sub">辅音抢拍（元音核落正拍）</text>
            <text x="593" y="95" class="af-sub">qTA 滑音 λ + 手绘 F0 锚点</text>
            <text x="593" y="114" class="af-sub">力度 p–fff → 肺下压 PR (Pa)</text>

            <rect x="732" y="14" width="178" height="54" rx="8" class="af-node" />
            <text x="821" y="36" class="af-title">双通道人声 + 伴奏</text>
            <text x="821" y="54" class="af-sub">VTL 2.4 / Tract2Vox-Lite</text>

            <rect x="732" y="88" width="178" height="54" rx="8" class="af-node" />
            <text x="821" y="110" class="af-title">剪辑联调与多格式导出</text>
            <text x="821" y="128" class="af-sub">MIDI/VSQX/SVP · WAV/TG</text>

            <path d="M 194 41 L 236 62" class="af-arrow" marker-end="url(#arrFlowArrow)" />
            <path d="M 194 115 L 236 94" class="af-arrow" marker-end="url(#arrFlowArrow)" />
            <path d="M 454 78 L 496 78" class="af-arrow" marker-end="url(#arrFlowArrow)" />
            <path d="M 686 64 L 728 41" class="af-arrow" marker-end="url(#arrFlowArrow)" />
            <path d="M 686 92 L 728 115" class="af-arrow" marker-end="url(#arrFlowArrow)" />
          </svg>
        </section>

        <section class="mod-svg-box arr-compare-box selectable">
          <div class="param-sec-title">
            <span>五种记谱法实时互译对照（复用内核直算，零图片）</span>
            <span class="mono muted">{{ activeNotationDoc.id }}</span>
          </div>
          <div class="arr-compare-controls">
            <div class="seg control-seg" role="group" aria-label="选择预览记谱法">
              <button
                v-for="item in SCORE_NOTATIONS"
                :key="item.id"
                type="button"
                :class="{ active: previewNotation === item.id }"
                @click="previewNotation = item.id"
              >{{ item.shortLabel }}</button>
            </div>
            <div class="seg control-seg" role="group" aria-label="选择预览主音">
              <button
                v-for="tKey in previewTonics"
                :key="tKey"
                type="button"
                :class="{ active: previewTonic === tKey }"
                @click="previewTonic = tKey"
              >1 = {{ tKey }}</button>
            </div>
          </div>
          <p class="muted arr-compare-summary">{{ activeNotationDoc.summary }}</p>
          <div class="arr-compare-grid">
            <div v-for="sample in sampleScaleComparison" :key="sample.label" class="arr-compare-chip">
              <span class="muted">{{ sample.label }}</span>
              <code class="mono arr-chip-code">{{ sample.token }}</code>
              <span class="mono muted arr-chip-sub">音高记号 {{ sample.pitch }}</span>
            </div>
          </div>
          <div class="arr-code-examples">
            <div class="arr-code-row">
              <span class="muted">分开写法（配歌词「汉皇重色思倾国」）</span>
              <pre class="mono arr-code-pre">{{ activeNotationDoc.example }}</pre>
            </div>
            <div class="arr-code-row">
              <span class="muted">带字内联写法（单框提交词谱 / 发给 AI 对位）</span>
              <pre class="mono arr-code-pre">{{ activeNotationDoc.inlineExample }}</pre>
            </div>
          </div>
        </section>

        <TechChart
          title="原理解析图 · 滑音阻尼 λ 对相邻音高过渡（C4 → G4）的影响"
          subtitle="由前端三阶 qTA 核现场计算：λ 决定从前音平滑逼近新目标音高的速率，兼顾自然歌喉颤滑与快板颗粒度"
          badge="qTA 滑音 λ"
          :height="305"
          :option-builder="buildArrangerGlideChart"
          caption="编曲台默认 λ = 32 s⁻¹（允许范围 18–65 s⁻¹）；抒情慢歌可调低至 18–24 s⁻¹ 增强连绵滑音，花腔或快速跳进可调高至 50–65 s⁻¹ 保持音准利落。"
        />
      </template>

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
              <td v-for="(cell, cIdx) in row" :key="cIdx" :class="{ 'mod-cell-body': cIdx >= 2 }">
                <strong v-if="cIdx === 0">{{ cell }}</strong>
                <code v-else-if="cIdx === 1 && row.length <= 3" class="mono mod-code">{{ cell }}</code>
                <template v-else>{{ cell }}</template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Lightweight Code / Structure Reference Blocks -->
      <div v-for="blk in module.referenceCodeBlocks" :key="blk.title" class="mod-code-block-wrap selectable">
        <div class="param-sec-title">
          <span>{{ blk.title }}</span>
          <span class="mono muted">{{ blk.tag }}</span>
        </div>
        <pre class="mono mod-pre"><code>{{ blk.code }}</code></pre>
        <p v-if="blk.caption" class="muted mod-pre-cap">{{ blk.caption }}</p>
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
            <span class="mod-sc-desc">{{ row[0] }}</span>
            <span class="mod-sc-keys">
              <template v-for="(tok, tIdx) in parseShortcutTokens(row[1])" :key="tIdx">
                <kbd v-if="tok.kind === 'key'" class="mono mod-kbd">{{ tok.text }}</kbd>
                <span v-else class="mod-sc-sep" aria-hidden="true">{{ tok.text }}</span>
              </template>
            </span>
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
.mod-article {
  --guide-fs-title: 1.16rem;
  --guide-fs-lead: 1.08rem;
  --guide-fs-subhead: 1.04rem;
  --guide-fs-body: 1rem;
  --guide-fs-text: 0.95rem;
  --guide-fs-code: 0.9rem;
  --guide-fs-meta: 0.86rem;
  --guide-ink-body: color-mix(in srgb, var(--text) 88%, var(--muted));
}

.mod-head-left,
.mod-head-right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.mod-body {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.mod-summary {
  margin: 0;
  font-size: var(--guide-fs-lead);
  line-height: 1.78;
  color: var(--text);
}

.mod-block {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.mod-ul {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: var(--guide-fs-body);
  line-height: 1.75;
  color: var(--guide-ink-body);
}

.mod-steps-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(310px, 1fr));
  gap: 11px;
}

.mod-step-card {
  box-shadow: none;
  padding: 13px 15px;
  gap: 7px;
}

.mod-step-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--guide-fs-subhead);
  line-height: 1.42;
}

.mod-idx {
  font-size: var(--guide-fs-meta);
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--selected);
  color: var(--accent);
  font-weight: 700;
}

.mod-step-card p {
  margin: 0;
  font-size: var(--guide-fs-body);
  line-height: 1.72;
  color: var(--guide-ink-body);
}

.mod-ui-hint {
  font-size: var(--guide-fs-meta);
  line-height: 1.45;
  margin-top: auto;
  padding-top: 2px;
}

.mod-table-wrap {
  padding: 12px 14px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 48%, transparent);
  overflow-x: auto;
}

.mod-tbl th,
.mod-tbl td {
  padding: 9px 11px;
  font-size: var(--guide-fs-text);
  line-height: 1.62;
  vertical-align: top;
}

.mod-tbl th {
  font-size: var(--guide-fs-text);
  color: var(--text);
}

.mod-cell-body {
  color: var(--guide-ink-body);
}

.mod-code {
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--selected);
  color: var(--accent);
  font-size: var(--guide-fs-code);
  white-space: pre-wrap;
  word-break: break-word;
  display: inline-block;
}

.mod-bottom-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}

@media (max-width: 900px) {
  .mod-bottom-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.mod-pitfalls {
  padding: 13px 15px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  border-left: 3px solid var(--warning);
  background: color-mix(in srgb, var(--warning) 8%, var(--panel));
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mod-pitfall-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  font-size: var(--guide-fs-body);
  line-height: 1.68;
}

.mod-pitfall-item strong {
  font-size: var(--guide-fs-subhead);
}

.mod-pitfall-item p {
  margin: 3px 0 0;
  color: var(--guide-ink-body);
}

.mod-sc-card {
  box-shadow: none;
  padding: 13px 15px;
  gap: 7px;
  min-width: 0;
}

.mod-sc-row {
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

.mod-sc-desc {
  flex: 1 1 160px;
  min-width: 0;
  color: var(--guide-ink-body);
  overflow-wrap: break-word;
}

.mod-sc-keys {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 3px;
  flex: 0 1 auto;
  max-width: 100%;
  margin-left: auto;
}

.mod-sc-sep {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--guide-fs-meta);
  padding: 0 2px;
  user-select: none;
}

.mod-kbd {
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

.mod-placeholder-card {
  padding: 14px 16px;
  border-radius: var(--r-panel);
  border: 1px dashed var(--panel-border);
  background: color-mix(in srgb, var(--app) 50%, transparent);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mod-ph-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--guide-fs-subhead);
}

.mod-placeholder-card p {
  margin: 0;
  font-size: var(--guide-fs-body);
  line-height: 1.68;
  color: var(--guide-ink-body);
}

.mod-diagram-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mod-diagram-box,
.mod-code-block-wrap {
  padding: 12px 15px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 48%, transparent);
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.mod-arch-svg {
  width: 100%;
  height: auto;
  display: block;
  color: var(--muted);
}

.dg-group {
  fill: color-mix(in srgb, var(--panel) 54%, transparent);
  stroke: var(--panel-border);
  stroke-width: 1;
  stroke-dasharray: 4 3;
}

.dg-group-lbl {
  fill: var(--muted);
  font-size: 11.5px;
  font-weight: 600;
}

.dg-node {
  fill: var(--ctrl-bg);
  stroke: var(--panel-border);
  stroke-width: 1.15;
}

.dg-node.accent {
  fill: color-mix(in srgb, var(--selected) 52%, var(--panel));
  stroke: var(--accent);
}

.dg-node.primary {
  fill: color-mix(in srgb, var(--accent) 14%, var(--panel));
  stroke: var(--accent);
  stroke-width: 1.4;
}

.dg-title {
  fill: var(--text);
  font-size: 12px;
  font-weight: 700;
  text-anchor: middle;
}

.dg-sub {
  fill: var(--muted);
  font-size: 10.8px;
  text-anchor: middle;
}

.dg-arrow {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
  opacity: 0.88;
}

.dg-arrow.dashed {
  stroke: var(--muted);
  stroke-dasharray: 4 3;
}

.ipa-legend-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 10px;
}

.ipa-legend-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--panel-border) 75%, transparent);
  background: color-mix(in srgb, var(--panel) 72%, transparent);
  font-size: var(--guide-fs-text);
}

.ipa-legend-item strong {
  display: block;
  color: var(--text);
  font-size: var(--guide-fs-text);
}

.ipa-legend-item p {
  margin: 3px 0 0;
  color: var(--guide-ink-body);
  line-height: 1.58;
}

.ipa-leg-cell {
  flex: none;
  width: 38px;
  height: 34px;
  border-radius: max(3px, calc(var(--r-ctrl) - 2px));
  border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
  background: var(--panel);
  color: var(--text);
  font-size: 1.25rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.ipa-leg-cell.is-active {
  background: var(--accent);
  color: var(--on-accent);
  border-color: var(--accent);
}

.ipa-leg-cell.is-custom {
  box-shadow: inset 0 -2.5px 0 var(--success);
}

.ipa-leg-cell.is-shaded {
  background: color-mix(in srgb, var(--border) 42%, var(--app));
}

.ipa-leg-cell.is-half-shaded {
  justify-content: flex-start;
  padding-left: 5px;
  background: linear-gradient(
    to right,
    var(--panel) 50%,
    color-mix(in srgb, var(--border) 42%, var(--app)) 50%
  );
}

.ipa-leg-cell.is-unsupported {
  background-image: repeating-linear-gradient(
    135deg,
    transparent 0 4px,
    color-mix(in srgb, var(--muted) 14%, transparent) 4px 5px
  );
}

.mod-pre {
  margin: 0;
  padding: 11px 14px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--panel-border) 80%, transparent);
  background: var(--ctrl-bg);
  color: var(--text);
  font-size: var(--guide-fs-code);
  line-height: 1.62;
  overflow-x: auto;
  white-space: pre;
}

.mod-pre-cap {
  margin: 0;
  font-size: var(--guide-fs-meta);
  line-height: 1.58;
  color: var(--guide-ink-body);
}

.mod-svg-box {
  padding: 12px 15px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 48%, transparent);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.arr-flow-svg {
  width: 100%;
  height: auto;
  display: block;
  color: var(--accent);
}

.af-node {
  fill: var(--ctrl-bg);
  stroke: var(--panel-border);
  stroke-width: 1.15;
}

.af-node.accent {
  fill: color-mix(in srgb, var(--selected) 52%, var(--panel));
  stroke: var(--accent);
}

.af-node.primary {
  fill: color-mix(in srgb, var(--accent) 14%, var(--panel));
  stroke: var(--accent);
  stroke-width: 1.45;
}

.af-title {
  fill: var(--text);
  font-size: 12px;
  font-weight: 700;
  text-anchor: middle;
}

.af-sub {
  fill: var(--muted);
  font-size: 10.6px;
  text-anchor: middle;
}

.af-arrow {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
  opacity: 0.9;
}

.arr-compare-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.arr-compare-summary {
  margin: 0;
  font-size: var(--guide-fs-text);
  line-height: 1.64;
  color: var(--guide-ink-body);
}

.arr-compare-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(175px, 1fr));
  gap: 9px;
}

.arr-compare-chip {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 9px 11px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  font-size: var(--guide-fs-meta);
  min-width: 0;
}

.arr-chip-code {
  font-size: var(--guide-fs-subhead);
  font-weight: 700;
  color: var(--accent);
  word-break: break-word;
}

.arr-chip-sub {
  font-size: var(--guide-fs-meta);
}

.arr-code-examples {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
  gap: 10px;
}

.arr-code-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  font-size: var(--guide-fs-meta);
}

.arr-code-pre {
  margin: 0;
  padding: 9px 11px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--panel-border) 80%, transparent);
  background: var(--ctrl-bg);
  color: var(--text);
  font-size: var(--guide-fs-code);
  line-height: 1.56;
  white-space: pre-wrap;
  word-break: break-word;
}

.mod-stage-svg {
  width: 100%;
  height: auto;
  display: block;
  color: var(--muted);
}

.st-box {
  fill: var(--ctrl-bg);
  stroke: var(--panel-border);
  stroke-width: 1.15;
}

.st-box.accent {
  fill: color-mix(in srgb, var(--accent) 14%, var(--panel));
  stroke: var(--accent);
}

.st-box.teal {
  fill: color-mix(in srgb, var(--success) 14%, var(--panel));
  stroke: var(--success);
}

.st-box.violet {
  fill: color-mix(in srgb, var(--selected) 68%, var(--panel));
  stroke: var(--accent);
}

.st-box.warn {
  fill: color-mix(in srgb, var(--warning) 14%, var(--panel));
  stroke: var(--warning);
}

.st-box.primary {
  fill: color-mix(in srgb, var(--accent) 18%, var(--panel));
  stroke: var(--accent);
  stroke-width: 1.5;
}

.st-title {
  fill: var(--text);
  font-size: 12px;
  font-weight: 700;
  text-anchor: middle;
}

.st-sub {
  fill: var(--muted);
  font-size: 10.6px;
  text-anchor: middle;
}

.st-arrow {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
  opacity: 0.9;
}

.st-arrow.dashed {
  stroke: var(--muted);
  stroke-dasharray: 4 3;
}

.m27-lane-badge {
  flex: none;
  min-width: 68px;
  height: 32px;
  padding: 0 8px;
  border-radius: max(3px, calc(var(--r-ctrl) - 2px));
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  color: var(--text);
  font-size: var(--guide-fs-meta);
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-align: center;
}

.m27-lane-badge.tone-teal {
  border-color: var(--teal);
  color: var(--teal);
  background: color-mix(in srgb, var(--teal) 12%, var(--panel));
}

.m27-lane-badge.tone-accent {
  border-color: var(--accent);
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, var(--panel));
}

.m27-lane-badge.tone-warn {
  border-color: var(--warning);
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 12%, var(--panel));
}

.m27-lane-badge.tone-danger {
  border-color: var(--danger);
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, var(--panel));
}

.m27-lane-badge.tone-violet {
  border-color: var(--violet);
  color: var(--violet);
  background: color-mix(in srgb, var(--violet) 12%, var(--panel));
}

.m27-lane-badge.tone-success {
  border-color: var(--success);
  color: var(--success);
  background: color-mix(in srgb, var(--success) 12%, var(--panel));
}

.card-guide-dual {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
  gap: 14px;
  align-items: stretch;
}

.card-guide-tree-demo,
.card-guide-dock-demo {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px 14px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  min-width: 0;
}

.card-guide-sample-bar,
.card-guide-dock-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.card-guide-dock-head strong {
  font-size: var(--guide-fs-text);
}

.card-guide-sample-desc {
  margin: 0;
  font-size: var(--guide-fs-text);
  line-height: 1.6;
  color: var(--guide-ink-body);
}

.card-guide-tree-stage {
  display: grid;
  grid-template-columns: minmax(140px, 0.95fr) minmax(0, 1.25fr);
  gap: 10px;
  align-items: stretch;
  flex: 1;
}

.card-guide-tree-wrap {
  min-height: 146px;
  padding: 7px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--panel-border) 88%, transparent);
  background: var(--panel);
  display: flex;
}

.card-guide-leaf-readout {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 7px;
  padding: 10px 12px;
  border-radius: var(--r-ctrl);
  border: 1px solid color-mix(in srgb, var(--panel-border) 78%, transparent);
  background: color-mix(in srgb, var(--app) 54%, var(--panel));
  font-size: var(--guide-fs-meta);
  line-height: 1.56;
}

.leaf-ro-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.card-dock-svg {
  width: 100%;
  height: auto;
  display: block;
  margin-top: auto;
  margin-bottom: auto;
}

@media (max-width: 960px) {
  .card-guide-dual,
  .card-guide-tree-stage {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 820px) {
  .mod-bottom-grid {
    grid-template-columns: 1fr;
  }
}
</style>
