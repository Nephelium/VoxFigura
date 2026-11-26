<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import IconSvg from '@/components/common/IconSvg.vue';
import { ipaReferenceUrl } from '@/data/ipa-reference-library';
import { measureRecordingSilence, type RecordingSilence } from '@/data/recording-silence.js';
import {
  VOWEL_GAUSSIAN_STOPS,
  formatVowelChartLabel,
  isRoundedVowelSymbol,
  loadVowelMeasurements,
  measureSavedVowelPoses,
  vowelSymbolKey,
  type RecordedVowelFormants,
  type VowelReferenceMode,
} from '@/data/ipa-vowel-measurements';
import { vowelAxisFraction, vowelAxisTicks, type VowelCoordinateScale } from './ptb-physics-charts';
import '@/styles/acoustic-charts.css';

type Pose = Parameters<typeof measureSavedVowelPoses>[1][number];
type LivePoint = Pick<RecordedVowelFormants, 'symbol' | 'f1' | 'f2' | 'f3' | 'nasal'>;

const props = defineProps<{
  speaker: string;
  symbol: string;
  recording?: string;
  pose: Omit<Pose, 'symbol'> | null;
}>();

const emit = defineEmits<{ selectRecording: [id: string] }>();

interface VowelViewport {
  f2Hi: number;
  f2Lo: number;
  f1Lo: number;
  f1Hi: number;
}

// T-20: Tightened acoustic domain F2: 2450..450 Hz (L->R), F1: 180..860 Hz (T->B)
const DEFAULT_VIEW: VowelViewport = { f2Hi: 2450, f2Lo: 450, f1Lo: 180, f1Hi: 860 };
const PLOT = { left: 42, right: 392, top: 12, bottom: 182 } as const;
const PLOT_W = PLOT.right - PLOT.left;
const PLOT_H = PLOT.bottom - PLOT.top;
const VIEW_LIMITS = {
  f1: { min: 80, max: 1250, minSpan: 160, maxSpan: 1050 },
  f2: { min: 250, max: 3600, minSpan: 320, maxSpan: 3100 },
} as const;

const view = ref<VowelViewport>({ ...DEFAULT_VIEW });
const coordinateScale = ref<VowelCoordinateScale>('logarithmic');
const isCustomView = computed(
  () =>
    Math.abs(view.value.f2Hi - DEFAULT_VIEW.f2Hi) > 1 ||
    Math.abs(view.value.f2Lo - DEFAULT_VIEW.f2Lo) > 1 ||
    Math.abs(view.value.f1Lo - DEFAULT_VIEW.f1Lo) > 1 ||
    Math.abs(view.value.f1Hi - DEFAULT_VIEW.f1Hi) > 1,
);

function resetViewport() {
  view.value = { ...DEFAULT_VIEW };
}

const root = ref<HTMLElement>();
const svgEl = ref<SVGSVGElement>();
const visible = ref(false);
let observer: IntersectionObserver | undefined;

onMounted(() => {
  observer = new IntersectionObserver(([entry]) => {
    visible.value = entry.isIntersecting;
  });
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());

const mode = ref<VowelReferenceMode>('recorded');
const showCompareList = ref(false);
const showSilence = ref(false);
const silence = shallowRef<RecordingSilence | null>(null);
const silenceStatus = ref('');
const recordedRecords = shallowRef<RecordedVowelFormants[]>([]);
const transferRecords = shallowRef<RecordedVowelFormants[]>([]);
const message = ref('');
const live = shallowRef<LivePoint | null>(null);
const liveMessage = ref('');
const retry = ref(0);
const hoveredId = ref<string | null>(null);

const references = computed(() =>
  mode.value === 'recorded' ? recordedRecords.value : transferRecords.value,
);

const selected = computed(
  () =>
    references.value.find((p) => p.id === props.recording) ??
    references.value.find((p) => vowelSymbolKey(p.symbol) === vowelSymbolKey(props.symbol)),
);

interface VowelPairRow {
  id: string;
  symbol: string;
  rec?: RecordedVowelFormants;
  tr?: RecordedVowelFormants;
  dF1?: number;
  dF2?: number;
  dF3?: number;
}

const pairedRows = computed<VowelPairRow[]>(() => {
  const byId = new Map<string, VowelPairRow>();
  for (const r of recordedRecords.value) {
    byId.set(r.id, { id: r.id, symbol: r.symbol, rec: r });
  }
  for (const t of transferRecords.value) {
    const existing =
      byId.get(t.id) ??
      [...byId.values()].find((item) => vowelSymbolKey(item.symbol) === vowelSymbolKey(t.symbol));
    if (existing) {
      existing.tr = t;
    } else {
      byId.set(t.id, { id: t.id, symbol: t.symbol, tr: t });
    }
  }
  return [...byId.values()].map((row) => {
    const dF1 = row.rec && row.tr ? Math.round(row.tr.f1 - row.rec.f1) : undefined;
    const dF2 = row.rec && row.tr ? Math.round(row.tr.f2 - row.rec.f2) : undefined;
    const dF3 =
      row.rec?.f3 != null && row.tr?.f3 != null ? Math.round(row.tr.f3 - row.rec.f3) : undefined;
    return { ...row, dF1, dF2, dF3 };
  });
});

const pairById = computed(() => {
  const map = new Map<string, VowelPairRow>();
  for (const row of pairedRows.value) {
    map.set(row.id, row);
    if (row.tr) map.set(row.tr.id, row);
  }
  return map;
});

const activePair = computed<VowelPairRow | undefined>(() => {
  if (hoveredId.value && pairById.value.has(hoveredId.value)) {
    return pairById.value.get(hoveredId.value);
  }
  if (selected.value) {
    return (
      pairById.value.get(selected.value.id) ??
      pairedRows.value.find((r) => vowelSymbolKey(r.symbol) === vowelSymbolKey(selected.value!.symbol))
    );
  }
  return undefined;
});

const referenceReadout = computed(() => {
  const pair = activePair.value;
  if (!pair) return message.value ? '' : '滚轮缩放 · 按住平移 · 悬停查看 F1/F2/F3 与 ΔF';
  return [
    `[${formatVowelChartLabel(pair.symbol)}]`,
    isRoundedVowelSymbol(pair.symbol) ? '圆唇' : '非圆唇',
    pair.rec && `实测 ${formatF123(pair.rec)}`,
    pair.tr && `重建 ${formatF123(pair.tr, true)}`,
    pair.rec && pair.tr && `Δ(${fmtSigned(pair.dF1)}, ${fmtSigned(pair.dF2)}, ${fmtSigned(pair.dF3)})`,
  ].filter(Boolean).join(' · ');
});
const liveReadout = computed(() => live.value ? `当前构型 ${formatF123(live.value, true)}` : liveMessage.value);

watch([showSilence, () => props.recording ?? selected.value?.id], async ([show, id], _, cleanup) => {
  silence.value = null;
  silenceStatus.value = '';
  if (!show) return;
  if (!id) {
    silenceStatus.value = '点选一个元音以查看其原录音静音段';
    return;
  }
  const controller = new AbortController();
  cleanup(() => controller.abort());
  silenceStatus.value = '正在读取原录音…';
  try {
    const result = await fetch(ipaReferenceUrl(id, 'audio'), { signal: controller.signal });
    if (!result.ok) throw new Error('audio unavailable');
    const data = await measureRecordingSilence(await result.arrayBuffer());
    if (controller.signal.aborted) return;
    silence.value = data;
    silenceStatus.value = data.intervals.length
      ? data.intervals.map(({ start_s, end_s }) => `${start_s.toFixed(2)}–${end_s.toFixed(2)} s`).join('、')
      : '未检测到静音段';
  } catch {
    if (!controller.signal.aborted) silenceStatus.value = '原录音静音段暂不可用';
  }
});

// Load both recorded and vocal-tract reconstructed vowel measurements (T-23)
watch(
  [() => props.speaker, visible, retry],
  async ([speaker, show], _, cleanup) => {
    if (!show) return;
    let active = true;
    cleanup(() => {
      active = false;
    });
    message.value = '正在读取元音实测与重建共振峰…';
    const [recRes, trRes] = await Promise.allSettled([
      loadVowelMeasurements('recorded', ''),
      loadVowelMeasurements('transfer', speaker),
    ]);
    if (!active) return;
    recordedRecords.value = recRes.status === 'fulfilled' ? recRes.value.records : [];
    transferRecords.value = trRes.status === 'fulfilled' ? trRes.value.records : [];
    const activeSet = mode.value === 'recorded' ? recordedRecords.value : transferRecords.value;
    if (!recordedRecords.value.length && !transferRecords.value.length) {
      message.value = '元音参考点暂未载入';
    } else if (!activeSet.length) {
      message.value = '当前来源暂无可用元音参考点';
    } else {
      message.value = '';
    }
  },
  { immediate: true },
);

// Live saved/edited pose formant measurement
watch(
  [() => props.speaker, () => props.symbol, () => props.recording, visible, retry],
  ([speaker, symbol, , show], _, cleanup) => {
    live.value = null;
    liveMessage.value = '';
    if (!show || !symbol) return;
    const controller = new AbortController();
    let busy = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout>;
    async function measure() {
      const pose = props.pose;
      pending = false;
      if (!pose) {
        live.value = null;
        return;
      }
      busy = true;
      try {
        const result = await measureSavedVowelPoses(speaker, [{ symbol, ...pose }], controller.signal);
        if (!controller.signal.aborted && pose === props.pose) {
          live.value = result.records[0] ?? null;
          liveMessage.value = live.value ? '' : '当前构型无稳定共振峰';
        }
      } catch {
        if (!controller.signal.aborted) {
          live.value = null;
          liveMessage.value = '当前构型峰值暂不可用';
        }
      } finally {
        busy = false;
        if (pending && !controller.signal.aborted) timer = setTimeout(measure, 100);
      }
    }
    const stop = watch(
      () => props.pose,
      (pose) => {
        if (!pose) live.value = null;
        pending = true;
        if (!busy) {
          clearTimeout(timer);
          timer = setTimeout(measure, 90);
        }
      },
      { immediate: true, deep: true },
    );
    cleanup(() => {
      stop();
      controller.abort();
      clearTimeout(timer);
    });
  },
  { immediate: true },
);

const xFraction = computed(() => vowelAxisFraction({ min: view.value.f2Lo, max: view.value.f2Hi }, coordinateScale.value));
const yFraction = computed(() => vowelAxisFraction({ min: view.value.f1Lo, max: view.value.f1Hi }, coordinateScale.value));
const x = (f2: number) => PLOT.left + PLOT_W * (1 - xFraction.value(f2));
const y = (f1: number) => PLOT.top + PLOT_H * yFraction.value(f1);
const plotDescription = computed(() => {
  const { f2Hi, f2Lo, f1Lo, f1Hi } = view.value;
  const scale = coordinateScale.value === 'logarithmic' ? '对数' : '线性';
  return `元音共振峰，${scale}坐标，横轴 F2 从 ${Math.round(f2Hi)} 到 ${Math.round(f2Lo)} Hz，纵轴 F1 从 ${Math.round(f1Lo)} 到 ${Math.round(f1Hi)} Hz`;
});

function niceStep(span: number, targetCount: number) {
  const raw = Math.max(20, span / targetCount);
  const mag = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 4, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
}

const xTicks = computed(() => {
  const { f2Hi, f2Lo } = view.value;
  return vowelAxisTicks(
    { min: f2Lo, max: f2Hi, step: niceStep(f2Hi - f2Lo, 4.5) }, coordinateScale.value, PLOT_W, 38,
  ).reverse().filter(hz => x(hz) >= PLOT.left + 8 && x(hz) <= PLOT.right - 8);
});

const yTicks = computed(() => {
  const { f1Lo, f1Hi } = view.value;
  const step = !isCustomView.value ? 200 : niceStep(f1Hi - f1Lo, 3.8);
  return vowelAxisTicks(
    { min: f1Lo, max: f1Hi, step }, coordinateScale.value, PLOT_H, 22,
  ).filter(hz => y(hz) >= PLOT.top + 4 && y(hz) <= PLOT.bottom - 4);
});

function plotPosition(event: MouseEvent) {
  const matrix = svgEl.value?.getScreenCTM();
  return matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) : null;
}

function moveFrequencyRange(kind: 'f1' | 'f2', min: number, max: number, shift: number, factor = 1, anchor = 0) {
  const log = coordinateScale.value === 'logarithmic';
  const transform = log ? Math.log : (hz: number) => hz;
  const inverse = log ? Math.exp : (hz: number) => hz;
  const limits = VIEW_LIMITS[kind];
  const floor = transform(limits.min);
  const ceiling = transform(limits.max);
  const start = transform(min);
  const span = transform(max) - start;
  const minSpan = log ? Math.log(1.15) : limits.minSpan;
  const maxSpan = log ? ceiling - floor : limits.maxSpan;
  const nextSpan = factor === 1 ? span : Math.max(minSpan, Math.min(maxSpan, span * factor));
  const nextStart = Math.max(floor, Math.min(ceiling - nextSpan, start + shift * span + (span - nextSpan) * anchor));
  return [inverse(nextStart), inverse(nextStart + nextSpan)] as const;
}

let panState: {
  pointerId: number;
  startX: number;
  startY: number;
  plotStart: DOMPoint;
  moved: boolean;
  orig: typeof view.value;
} | null = null;

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0 || !e.isPrimary) return;
  const plotStart = plotPosition(e);
  if (!plotStart) return;
  panState = {
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    plotStart,
    moved: false,
    orig: { ...view.value },
  };
}

function onPointerMove(e: PointerEvent) {
  if (!panState || e.pointerId !== panState.pointerId || !svgEl.value) return;
  const dxClient = e.clientX - panState.startX;
  const dyClient = e.clientY - panState.startY;
  if (!panState.moved && Math.hypot(dxClient, dyClient) < 3.5) return;
  if (!panState.moved) {
    panState.moved = true;
    svgEl.value.setPointerCapture(e.pointerId);
  }
  const point = plotPosition(e);
  if (!point) return;
  const { orig, plotStart } = panState;
  const [f2Lo, f2Hi] = moveFrequencyRange('f2', orig.f2Lo, orig.f2Hi, (point.x - plotStart.x) / PLOT_W);
  const [f1Lo, f1Hi] = moveFrequencyRange('f1', orig.f1Lo, orig.f1Hi, (plotStart.y - point.y) / PLOT_H);
  view.value = { f2Lo, f2Hi, f1Lo, f1Hi };
}

function onPointerUp(e: PointerEvent) {
  if (!panState || e.pointerId !== panState.pointerId) return;
  panState = null;
}

function onWheel(e: WheelEvent) {
  const point = plotPosition(e);
  if (!point || !e.deltaY) return;
  const uX = Math.max(0, Math.min(1, (PLOT.right - point.x) / PLOT_W));
  const uY = Math.max(0, Math.min(1, (point.y - PLOT.top) / PLOT_H));
  const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
  const cur = view.value;
  const [f2Lo, f2Hi] = moveFrequencyRange('f2', cur.f2Lo, cur.f2Hi, 0, factor, uX);
  const [f1Lo, f1Hi] = moveFrequencyRange('f1', cur.f1Lo, cur.f1Hi, 0, factor, uY);
  view.value = { f2Lo, f2Hi, f1Lo, f1Hi };
}

function fmtSigned(delta?: number) {
  if (delta === undefined || !Number.isFinite(delta)) return '—';
  return `${delta >= 0 ? '+' : ''}${Math.round(delta)}`;
}

function formatF123(pt?: { f1: number; f2: number; f3?: number; nasal?: boolean } | null, modeled = false) {
  if (!pt) return '—';
  const p = modeled && pt.nasal ? 'P' : 'F';
  const f3Part = pt.f3 != null && Number.isFinite(pt.f3) ? ` · ${p}3 ${Math.round(pt.f3)}` : '';
  return `${p}1 ${Math.round(pt.f1)} · ${p}2 ${Math.round(pt.f2)}${f3Part} Hz`;
}

function tooltipText(id: string, fallbackPoint: RecordedVowelFormants) {
  const pair = pairById.value.get(id);
  const displaySym = formatVowelChartLabel(fallbackPoint.symbol);
  const lipKind = isRoundedVowelSymbol(fallbackPoint.symbol) ? '圆唇元音' : '非圆唇元音';
  const lines = [`[${displaySym}] · ${lipKind}`];
  if (pair?.rec) lines.push(`原音实测：${formatF123(pair.rec, false)}`);
  if (pair?.tr) lines.push(`声道重建：${formatF123(pair.tr, true)}`);
  if (pair?.rec && pair?.tr) {
    lines.push(
      `重建差值：ΔF1 ${fmtSigned(pair.dF1)} · ΔF2 ${fmtSigned(pair.dF2)} · ΔF3 ${fmtSigned(pair.dF3)} Hz`,
    );
  }
  return lines.join('\n');
}

const labels = computed(() => {
  const points = [...references.value].sort(
    (a, b) => Number(b === selected.value) - Number(a === selected.value),
  );
  return points.map((point) => {
    const px = x(point.f2);
    const py = y(point.f1);
    const displaySymbol = formatVowelChartLabel(point.symbol);
    const rounded = isRoundedVowelSymbol(point.symbol);
    const inPlot =
      px >= PLOT.left - 2 && px <= PLOT.right + 2 && py >= PLOT.top - 2 && py <= PLOT.bottom + 2;
    return { point, px, py, inPlot, displaySymbol, rounded };
  });
});

const hoveredTooltip = computed(() => {
  if (!hoveredId.value) return null;
  const pair = pairById.value.get(hoveredId.value);
  const item = labels.value.find((l) => l.point.id === hoveredId.value);
  if (!pair || !item) return null;
  return {
    pair,
    leftPct: Math.max(8, Math.min(62, (item.px / 403) * 100)),
    topPct: item.py > 102 ? Math.max(6, ((item.py - 68) / 204) * 100) : Math.min(62, ((item.py + 10) / 204) * 100),
  };
});
</script>

<template>
  <section ref="root" class="ipa-vowel-compare" aria-label="声学元音图">
    <header class="vc-card-head">
      <strong>声学元音图</strong>
      <div class="head-controls">
        <div class="seg control-seg sm" aria-label="元音参考来源">
          <button
            type="button"
            :aria-pressed="mode === 'recorded'"
            :class="{ active: mode === 'recorded' }"
            @click="mode = 'recorded'"
          >
            原音实测
          </button>
          <button
            type="button"
            :aria-pressed="mode === 'transfer'"
            :class="{ active: mode === 'transfer' }"
            title="在重建声道的传递函数上测量前三个峰"
            @click="mode = 'transfer'"
          >
            声道重建
          </button>
        </div>
        <select v-model="coordinateScale" class="inp vowel-axis-select" aria-label="元音图坐标刻度"
          title="F1 与 F2 可使用对数或线性坐标">
          <option value="logarithmic">对数</option>
          <option value="linear">线性</option>
        </select>
        <button
          type="button"
          class="btn sm"
          :aria-pressed="showSilence"
          :class="{ active: showSilence }"
          title="显示或隐藏所选原录音的低能量区间"
          @click="showSilence = !showSilence"
        >显示静音</button>
        <button
          type="button"
          class="btn sm"
          :class="{ active: showCompareList }"
          title="展开或收起全部元音 F1/F2/F3 实测与重建对比列表"
          @click="showCompareList = !showCompareList"
        >
          F1–F3 对比表
        </button>
        <button
          type="button"
          class="btn sm"
          :disabled="!isCustomView"
          title="恢复默认紧致声学视域 (F2: 2450–450 Hz, F1: 180–860 Hz)"
          @click="resetViewport"
        >
          <IconSvg name="refresh" :size="11" />
          <span>复位视口</span>
        </button>
      </div>
    </header>

    <div class="svg-stage">
      <svg
        ref="svgEl"
        class="vowel-chart-svg"
        viewBox="0 0 403 204"
        role="group"
        :aria-label="plotDescription"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @lostpointercapture="onPointerUp"
        @wheel.prevent="onWheel"
        @dblclick="resetViewport"
      >
        <defs>
          <clipPath id="ipa-vowel-plot-clip">
            <rect :x="PLOT.left" :y="PLOT.top" :width="PLOT_W" :height="PLOT_H" />
          </clipPath>
          <radialGradient id="ipa-vowel-gauss-unrounded" cx="50%" cy="50%" r="50%">
            <stop
              v-for="[off, w] in VOWEL_GAUSSIAN_STOPS"
              :key="'gu-' + off"
              :offset="`${off * 100}%`"
              stop-color="var(--vowel-unrounded, #0ea5e9)"
              :stop-opacity="(0.44 * w).toFixed(3)"
            />
          </radialGradient>
          <radialGradient id="ipa-vowel-gauss-rounded" cx="50%" cy="50%" r="50%">
            <stop
              v-for="[off, w] in VOWEL_GAUSSIAN_STOPS"
              :key="'gr-' + off"
              :offset="`${off * 100}%`"
              stop-color="var(--vowel-rounded, #9333ea)"
              :stop-opacity="(0.44 * w).toFixed(3)"
            />
          </radialGradient>
        </defs>

        <rect
          :x="PLOT.left"
          :y="PLOT.top"
          :width="PLOT_W"
          :height="PLOT_H"
          class="plot-frame"
        />

        <g class="ticks mono">
          <g v-for="hz in xTicks" :key="'x' + hz">
            <path :d="`M${x(hz)} ${PLOT.top}V${PLOT.bottom}`" />
            <text :x="x(hz)" :y="PLOT.bottom + 11" text-anchor="middle">{{ Math.round(hz) }}</text>
          </g>
          <g v-for="hz in yTicks" :key="'y' + hz">
            <path :d="`M${PLOT.left} ${y(hz)}H${PLOT.right}`" />
            <text :x="PLOT.left - 5" :y="y(hz) + 3" text-anchor="end">{{ Math.round(hz) }}</text>
          </g>
          <text x="5" y="10">F1 (Hz)</text>
          <text :x="(PLOT.left + PLOT.right) / 2" y="201" text-anchor="middle">F2 (Hz · 前 → 后)</text>
        </g>

        <g clip-path="url(#ipa-vowel-plot-clip)">
          <!-- Connecting line between recorded & reconstructed for active/selected vowel -->
          <line
            v-if="activePair?.rec && activePair?.tr"
            :x1="x(activePair.rec.f2)"
            :y1="y(activePair.rec.f1)"
            :x2="x(activePair.tr.f2)"
            :y2="y(activePair.tr.f1)"
            class="pair-delta-line"
          />

          <!-- Pass 1: Airy Gaussian radial peaks (Sky-Azure vs Iris-Violet) -->
          <circle
            v-for="{ point, px, py, rounded, inPlot } in labels"
            v-show="inPlot"
            :key="'gauss-' + point.id"
            class="gauss-peak"
            :cx="px"
            :cy="py"
            :r="point === selected || hoveredId === point.id ? 18 : 13.8"
            :fill="rounded ? 'url(#ipa-vowel-gauss-rounded)' : 'url(#ipa-vowel-gauss-unrounded)'"
          />

          <!-- Pass 2: IPA symbol centered directly on its Gaussian peak (no separate dot) -->
          <g
            v-for="{ point, px, py, inPlot, displaySymbol, rounded } in labels"
            v-show="inPlot"
            :key="point.id"
            class="vowel-peak-node"
            :class="[
              { selected: point === selected, compound: displaySymbol.length > 2 },
              rounded ? 'is-rounded' : 'is-unrounded',
            ]"
            role="button"
            tabindex="0"
            translate="no"
            :aria-label="'选择录音 [' + displaySymbol + ']'"
            @mouseenter="hoveredId = point.id"
            @mouseleave="hoveredId === point.id && (hoveredId = null)"
            @click.stop="!panState?.moved && emit('selectRecording', point.id)"
            @keydown.enter.prevent="emit('selectRecording', point.id)"
            @keydown.space.prevent="emit('selectRecording', point.id)"
          >
            <title>{{ tooltipText(point.id, point) }}</title>
            <circle class="hit" :cx="px" :cy="py" r="10.5" />
            <circle v-if="point === selected" class="selected-ring" :cx="px" :cy="py" r="10" />
            <text
              class="ipa peak-glyph"
              :x="px"
              :y="py"
              text-anchor="middle"
              dominant-baseline="central"
              translate="no"
            >
              {{ displaySymbol }}
            </text>
          </g>

          <path
            v-if="live"
            class="live-point"
            :transform="`translate(${x(live.f2)},${y(live.f1)})`"
            d="M0 -6L6 0 0 6 -6 0Z"
          >
            <title>当前构型 · {{ formatF123(live, true) }}</title>
          </path>
        </g>
      </svg>

      <!-- Floating F1/F2/F3 Tooltip on Hover -->
      <div
        v-if="hoveredTooltip"
        class="vowel-float-tip mono"
        :style="{ left: `${hoveredTooltip.leftPct}%`, top: `${hoveredTooltip.topPct}%` }"
        translate="no"
      >
        <div class="tip-head">
          <strong class="ipa">[{{ formatVowelChartLabel(hoveredTooltip.pair.symbol) }}]</strong>
          <span
            class="tip-lip-pill"
            :class="isRoundedVowelSymbol(hoveredTooltip.pair.symbol) ? 'rounded' : 'unrounded'"
          >
            {{ isRoundedVowelSymbol(hoveredTooltip.pair.symbol) ? '圆唇' : '非圆唇' }}
          </span>
          <span v-if="hoveredTooltip.pair.rec && hoveredTooltip.pair.tr" class="tip-delta">
            Δ {{ fmtSigned(hoveredTooltip.pair.dF1) }} / {{ fmtSigned(hoveredTooltip.pair.dF2) }} / {{ fmtSigned(hoveredTooltip.pair.dF3) }} Hz
          </span>
        </div>
        <div v-if="hoveredTooltip.pair.rec">实测 {{ formatF123(hoveredTooltip.pair.rec, false) }}</div>
        <div v-if="hoveredTooltip.pair.tr">重建 {{ formatF123(hoveredTooltip.pair.tr, true) }}</div>
      </div>
    </div>

    <div v-if="showSilence" class="silence-row" aria-label="原录音静音段">
      <span>原音静音</span>
      <div v-if="silence" class="silence-track" aria-hidden="true">
        <span
          v-for="{ start_s, end_s } in silence.intervals"
          :key="start_s"
          :style="{ left: `${100 * start_s / silence.duration_s}%`, width: `${100 * (end_s - start_s) / silence.duration_s}%` }"
        />
      </div>
      <span class="mono" role="status">{{ silenceStatus }}</span>
    </div>

    <!-- Collapsible Full Vowel F1/F2/F3 Comparison Table (T-23) -->
    <div v-if="showCompareList && pairedRows.length" class="vowel-compare-table-wrap">
      <table class="vowel-compare-tbl mono" translate="no">
        <thead>
          <tr>
            <th>元音</th>
            <th>实测 F1/F2/F3</th>
            <th>重建 F1/F2/F3</th>
            <th>ΔF1 / ΔF2 / ΔF3</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in pairedRows"
            :key="row.id"
            :class="{ active: row.id === selected?.id }"
            @click="emit('selectRecording', row.id)"
          >
            <td class="ipa">[{{ formatVowelChartLabel(row.symbol) }}]</td>
            <td>
              {{ row.rec ? `${Math.round(row.rec.f1)} / ${Math.round(row.rec.f2)} / ${row.rec.f3 ? Math.round(row.rec.f3) : '—'}` : '—' }}
            </td>
            <td>
              {{ row.tr ? `${Math.round(row.tr.f1)} / ${Math.round(row.tr.f2)} / ${row.tr.f3 ? Math.round(row.tr.f3) : '—'}` : '—' }}
            </td>
            <td>{{ fmtSigned(row.dF1) }} / {{ fmtSigned(row.dF2) }} / {{ fmtSigned(row.dF3) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <footer class="vc-card-foot mono">
      <div class="vowel-foot-top">
        <span class="vowel-round-legend" aria-label="圆唇与非圆唇颜色图例">
          <span class="round-key"><i class="gauss-swatch unrounded" />非圆唇</span>
          <span class="round-key"><i class="gauss-swatch rounded" />圆唇</span>
        </span>
        <span class="vowel-readout" :class="activePair ? 'reference-readout' : 'muted'" :title="referenceReadout" translate="no">
          {{ referenceReadout }}
        </span>
      </div>
      <div class="vowel-readout-row">
        <span v-if="message" class="vowel-readout" role="status" :title="message">{{ message }}</span>
        <span v-else class="vowel-readout" :class="live ? 'live-readout' : 'muted'" :title="liveReadout" translate="no">
          {{ liveReadout }}
        </span>
        <button v-if="message.includes('暂未载入')" type="button" class="btn xs" @click="retry++">
          重试
        </button>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.ipa-vowel-compare {
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--chart-panel);
  border: 1px solid var(--chart-outline);
  border-radius: var(--r-ctrl);
  overflow: hidden;
}

.vc-card-head {
  min-height: 34px;
  box-sizing: border-box;
  padding: 4px 10px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 8px;
  border-bottom: 1px solid var(--chart-outline);
  background: color-mix(in srgb, var(--sidebar, var(--panel)) 68%, transparent);
}

.vc-card-head strong {
  font-size: 0.916667rem;
  font-weight: 700;
  color: var(--text);
}

.head-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}

.vowel-axis-select {
  width: 50px;
  height: var(--control-height-sm);
  padding: 0 4px;
  font-size: var(--control-font-size-sm);
}

.silence-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 4px 10px;
  border-top: 1px solid var(--chart-outline);
  color: var(--muted);
  font-size: 0.816667rem;
}

.silence-track {
  position: relative;
  width: 92px;
  height: 7px;
  border-radius: 3px;
  background: var(--chart-grid);
  overflow: hidden;
}

.silence-track span {
  position: absolute;
  height: 100%;
  min-width: 1px;
  background: var(--accent);
}

.svg-stage {
  position: relative;
  flex: 1;
  min-height: 214px;
  display: flex;
  align-items: center;
}

.vowel-chart-svg {
  display: block;
  width: 100%;
  height: auto;
  max-height: 232px;
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.vowel-chart-svg:active {
  cursor: grabbing;
}

.plot-frame {
  fill: transparent;
  stroke: var(--chart-outline);
  stroke-width: 0.85;
}

.ticks text,
.vc-card-foot {
  color: var(--muted);
  fill: var(--muted);
  font-size: 0.816667rem;
}

.ticks path {
  stroke: var(--chart-grid);
  stroke-width: 0.8;
}

.pair-delta-line {
  stroke: var(--accent);
  stroke-width: 1.1;
  stroke-dasharray: 3 2;
  opacity: 0.75;
}

.gauss-peak {
  pointer-events: none;
  transition: r 150ms ease;
}

.vowel-peak-node {
  cursor: pointer;
}

.vowel-peak-node .hit {
  fill: transparent;
}

.vowel-peak-node .selected-ring {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.25px;
  stroke-dasharray: 2.2 1.8;
  opacity: 0.72;
}

.vowel-peak-node .peak-glyph {
  font-size: 0.96rem;
  font-weight: 600;
  paint-order: stroke fill;
  stroke: var(--chart-panel);
  stroke-width: 2.6px;
  stroke-linejoin: round;
}

.vowel-peak-node.compound .peak-glyph {
  font-size: 0.82rem;
}

.vowel-peak-node.is-unrounded {
  color: var(--vowel-unrounded-text, #075985);
}

.vowel-peak-node.is-unrounded .peak-glyph {
  fill: var(--vowel-unrounded-text, #075985);
}

.vowel-peak-node.is-rounded {
  color: var(--vowel-rounded-text, #6b21a8);
}

.vowel-peak-node.is-rounded .peak-glyph {
  fill: var(--vowel-rounded-text, #6b21a8);
}

.vowel-peak-node:focus-visible .hit {
  stroke: var(--accent);
  stroke-width: 1.4px;
}

.tip-lip-pill {
  padding: 0 5px;
  border-radius: 999px;
  font-family: var(--font-sans, sans-serif);
  font-size: 0.72rem;
  font-weight: 600;
}

.tip-lip-pill.unrounded {
  color: var(--vowel-unrounded-text, #075985);
  background: color-mix(in srgb, var(--vowel-unrounded, #0ea5e9) 16%, transparent);
}

.tip-lip-pill.rounded {
  color: var(--vowel-rounded-text, #6b21a8);
  background: color-mix(in srgb, var(--vowel-rounded, #9333ea) 16%, transparent);
}

.vowel-foot-top {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
}

.vowel-round-legend {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 7px;
  font-family: var(--font-sans, sans-serif);
  color: var(--muted);
}

.round-key {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
}

.gauss-swatch {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}

.gauss-swatch.unrounded {
  background: radial-gradient(circle, var(--vowel-unrounded, #0ea5e9) 0%, color-mix(in srgb, var(--vowel-unrounded, #0ea5e9) 38%, transparent) 55%, transparent 100%);
}

.gauss-swatch.rounded {
  background: radial-gradient(circle, var(--vowel-rounded, #9333ea) 0%, color-mix(in srgb, var(--vowel-rounded, #9333ea) 38%, transparent) 55%, transparent 100%);
}

.live-point {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2px;
  pointer-events: none;
}

.vowel-float-tip {
  position: absolute;
  z-index: 8;
  pointer-events: none;
  max-width: 260px;
  padding: 5px 8px;
  border-radius: var(--r-ctrl);
  background: var(--popover-bg, var(--panel));
  border: 1px solid var(--panel-border, var(--chart-outline));
  box-shadow: var(--popover-shadow, 0 6px 18px rgba(0, 0, 0, 0.2));
  color: var(--text);
  font-size: 0.816667rem;
  line-height: 1.45;
}

.tip-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 2px;
}

.tip-delta {
  color: var(--accent);
}

.vowel-compare-table-wrap {
  max-height: 128px;
  overflow-y: auto;
  border-top: 1px solid var(--chart-outline);
}

.vowel-compare-tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.816667rem;
}

.vowel-compare-tbl th,
.vowel-compare-tbl td {
  padding: 3px 7px;
  border-bottom: 1px solid color-mix(in srgb, var(--chart-outline) 65%, transparent);
  text-align: left;
  white-space: nowrap;
}

.vowel-compare-tbl thead th {
  position: sticky;
  top: 0;
  background: var(--chart-panel);
  color: var(--muted);
  font-weight: 600;
}

.vowel-compare-tbl tbody tr {
  cursor: pointer;
}

.vowel-compare-tbl tbody tr:hover,
.vowel-compare-tbl tbody tr.active {
  background: var(--selected);
}

.vc-card-foot {
  box-sizing: border-box;
  padding: 4px 10px;
  border-top: 1px solid var(--chart-outline);
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: repeat(2, 20px);
  align-items: center;
}

.vowel-readout-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.vowel-readout {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reference-readout {
  color: var(--chart-series);
}

.live-readout {
  color: var(--accent);
}
</style>
