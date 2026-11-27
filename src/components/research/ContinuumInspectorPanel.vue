<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { renderM27TractSvg, type TractViewBox } from '@/vendor/m27-tract-studio/tract-renderer.js';
import { paintReferenceFrame, type PaintableTractFrame } from '@/data/reference-geometry';
import { VTL_PARAM_META } from '@/stores/workbench';
import type { TractParamName } from '@vocalcut/core';
import type { ContinuumGhostMode } from './continuum-media';
import type { TractPartsMap } from './m27-hd-renderers';
import IconSvg from '@/components/common/IconSvg.vue';

export interface InspectorCellItem {
  key: string;
  stepA: number;
  stepB: number;
  blend: number;
  f0Hz: number;
  durationS: number | null;
  pressurePa: number | null;
  axisBadge: string;
  params: Record<TractParamName, number>;
  metrics?: { f1_hz: number; f2_hz: number; f3_hz: number; amin_cm2: number };
}

export interface InspectorContourData {
  parts: TractPartsMap;
  lm: number[];
  nasal: number;
  ja: number;
  jx: number;
}

const props = defineProps<{
  cells: readonly InspectorCellItem[];
  selectedCell: InspectorCellItem | null;
  contoursByKey: Readonly<Record<string, InspectorContourData>>;
  endpointAParams: Record<TractParamName, number>;
  endpointBParams: Record<TractParamName, number>;
  endpointALabel: string;
  endpointBLabel: string;
  endpointAContour?: InspectorContourData;
  endpointBContour?: InspectorContourData;
  dualAxis: boolean;
  viewBox: string;
  viewBoxObj: TractViewBox;
  ghostMode: ContinuumGhostMode;
  activePlaybackFrame: PaintableTractFrame | null;
  activePlaybackKey: string;
  themeStamp: string;
}>();

const emit = defineEmits<{
  'update:ghostMode': [mode: ContinuumGhostMode];
  selectCell: [key: string];
  auditionSelected: [];
}>();

const previewSvgRef = ref<SVGSVGElement | null>(null);

const ghostOptions: ReadonlyArray<{ value: ContinuumGhostMode; label: string }> = [
  { value: 'both', label: 'A+B 叠影' },
  { value: 'A', label: '端点 A' },
  { value: 'B', label: '端点 B' },
  { value: 'off', label: '无叠影' },
];

function paintPreview(): void {
  const svg = previewSvgRef.value;
  const cell = props.selectedCell;
  if (!svg || !cell) return;
  if (props.activePlaybackFrame && props.activePlaybackKey === cell.key) {
    paintReferenceFrame(svg, props.activePlaybackFrame, { viewBox: props.viewBoxObj });
    svg.setAttribute('viewBox', props.viewBox);
    return;
  }
  const hd = props.contoursByKey[cell.key];
  if (!hd) return;
  const ghosts: Array<{ parts: TractPartsMap; age: number }> = [];
  if ((props.ghostMode === 'both' || props.ghostMode === 'A') && props.endpointAContour) {
    ghosts.push({ parts: props.endpointAContour.parts, age: 1 });
  }
  if ((props.ghostMode === 'both' || props.ghostMode === 'B') && props.endpointBContour) {
    ghosts.push({ parts: props.endpointBContour.parts, age: props.ghostMode === 'both' ? 2 : 1 });
  }
  renderM27TractSvg(
    svg,
    {},
    {
      parts: hd.parts,
      lm: hd.lm,
      nasal: hd.nasal,
      ja: hd.ja,
      jx: hd.jx,
      ghosts,
    },
    {
      showLabels: false,
      showGhost: ghosts.length > 0,
      viewBox: props.viewBoxObj,
      theme: { anatomyBg: 'transparent' },
    },
  );
  svg.setAttribute('viewBox', props.viewBox);
}

watch(
  [
    () => props.selectedCell?.key,
    () => props.contoursByKey,
    () => props.ghostMode,
    () => props.viewBox,
    () => props.activePlaybackFrame,
    () => props.activePlaybackKey,
    () => props.themeStamp,
  ],
  () => {
    void nextTick(paintPreview);
  },
  { immediate: true },
);

// Build F1-F2 acoustic trajectory plot (phonetic vowel-chart orientation: F2 descending left->right, F1 ascending top->bottom)
const rowCells = computed(() => {
  if (!props.selectedCell) return props.cells;
  if (!props.dualAxis) return props.cells;
  return props.cells.filter((c) => c.stepB === props.selectedCell!.stepB);
});

const formantPoints = computed(() => {
  const valid = rowCells.value.filter((c) => c.metrics && c.metrics.f1_hz > 0 && c.metrics.f2_hz > 0);
  if (valid.length < 2) return null;
  const f1Vals = valid.map((c) => c.metrics!.f1_hz);
  const f2Vals = valid.map((c) => c.metrics!.f2_hz);
  const f1MinRaw = Math.min(...f1Vals);
  const f1MaxRaw = Math.max(...f1Vals);
  const f2MinRaw = Math.min(...f2Vals);
  const f2MaxRaw = Math.max(...f2Vals);
  const f1Span = Math.max(120, f1MaxRaw - f1MinRaw);
  const f2Span = Math.max(260, f2MaxRaw - f2MinRaw);
  const f1Lo = Math.max(150, Math.floor((f1MinRaw - f1Span * 0.2) / 50) * 50);
  const f1Hi = Math.ceil((f1MaxRaw + f1Span * 0.2) / 50) * 50;
  const f2Lo = Math.max(400, Math.floor((f2MinRaw - f2Span * 0.18) / 100) * 100);
  const f2Hi = Math.ceil((f2MaxRaw + f2Span * 0.18) / 100) * 100;

  const padL = 38;
  const padR = 14;
  const padT = 18;
  const padB = 24;
  const w = 300;
  const h = 156;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const pts = valid.map((c) => {
    const f1 = c.metrics!.f1_hz;
    const f2 = c.metrics!.f2_hz;
    // Standard phonetic vowel space: high F2 on left, low F2 on right; low F1 on top, high F1 on bottom
    const x = padL + ((f2Hi - f2) / Math.max(1, f2Hi - f2Lo)) * plotW;
    const y = padT + ((f1 - f1Lo) / Math.max(1, f1Hi - f1Lo)) * plotH;
    return {
      key: c.key,
      stepA: c.stepA,
      stepB: c.stepB,
      f1,
      f2,
      x: Number(x.toFixed(1)),
      y: Number(y.toFixed(1)),
      selected: c.key === props.selectedCell?.key,
    };
  });

  return {
    w,
    h,
    padL,
    padR,
    padT,
    padB,
    f1Lo,
    f1Hi,
    f2Lo,
    f2Hi,
    pts,
    polyline: pts.map((p) => `${p.x},${p.y}`).join(' '),
  };
});

// Top changed articulatory parameters between Endpoint A and B
const topChangedParams = computed(() => {
  const cell = props.selectedCell;
  if (!cell) return [];
  const rows = VTL_PARAM_META.filter((m) => m.key !== 'TRX' && m.key !== 'TRY').map((meta) => {
    const a = props.endpointAParams[meta.key];
    const b = props.endpointBParams[meta.key];
    const cur = cell.params[meta.key];
    const span = Math.max(1e-6, meta.max - meta.min);
    const diffNorm = Math.abs(b - a) / span;
    return {
      key: meta.key,
      label: meta.label,
      a,
      cur,
      b,
      diffNorm,
    };
  });
  rows.sort((x, y) => y.diffNorm - x.diffNorm);
  return rows.slice(0, 6);
});
</script>

<template>
  <section v-if="selectedCell" class="ci-wrap" aria-label="声学与构音联合分析">
    <div class="ci-card ci-preview">
      <div class="ci-head">
        <span class="ci-title">
          <strong>{{ dualAxis ? `格 A${selectedCell.stepA}·B${selectedCell.stepB}` : `第 ${selectedCell.stepA} 格` }} 构型对比</strong>
          <span class="muted mono">{{ selectedCell.axisBadge }}</span>
        </span>
        <div class="seg ci-ghost-seg" role="group" aria-label="端点叠影模式">
          <button
            v-for="opt in ghostOptions"
            :key="opt.value"
            type="button"
            class="btn xs"
            :class="{ active: ghostMode === opt.value }"
            @click="emit('update:ghostMode', opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
      <div class="ci-svg-box sci-plane" @dblclick="emit('auditionSelected')" title="双击试听当前格">
        <svg
          v-if="contoursByKey[selectedCell.key] || (activePlaybackFrame && activePlaybackKey === selectedCell.key)"
          ref="previewSvgRef"
          class="ci-svg"
          :viewBox="viewBox"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        />
        <span v-else class="muted">等待声道轮廓…</span>
      </div>
      <div class="ci-legend muted">
        <span>实线：当前格</span>
        <span v-if="ghostMode !== 'off'">虚线：{{ ghostMode === 'both' ? '端点 A / B 舌位叠影' : ghostMode === 'A' ? `端点 A (${endpointALabel})` : `端点 B (${endpointBLabel})` }}</span>
      </div>
    </div>

    <div class="ci-card ci-chart">
      <div class="ci-head">
        <span class="ci-title">
          <strong>F1–F2 元音空间轨迹</strong>
          <span class="muted">{{ dualAxis ? `第 ${selectedCell.stepB} 行` : '全序列' }}</span>
        </span>
        <span class="muted mono">点击节点切换格</span>
      </div>
      <div v-if="formantPoints" class="ci-plot-box sci-plane">
        <svg :viewBox="`0 0 ${formantPoints.w} ${formantPoints.h}`" class="ci-plot-svg" role="img" aria-label="F1-F2 共振峰轨迹图">
          <!-- Axes box -->
          <rect
            :x="formantPoints.padL"
            :y="formantPoints.padT"
            :width="formantPoints.w - formantPoints.padL - formantPoints.padR"
            :height="formantPoints.h - formantPoints.padT - formantPoints.padB"
            class="ci-plot-frame"
          />
          <!-- Mid grid lines -->
          <line
            :x1="formantPoints.padL"
            :y1="(formantPoints.padT + formantPoints.h - formantPoints.padB) / 2"
            :x2="formantPoints.w - formantPoints.padR"
            :y2="(formantPoints.padT + formantPoints.h - formantPoints.padB) / 2"
            class="ci-plot-grid"
          />
          <line
            :x1="(formantPoints.padL + formantPoints.w - formantPoints.padR) / 2"
            :y1="formantPoints.padT"
            :x2="(formantPoints.padL + formantPoints.w - formantPoints.padR) / 2"
            :y2="formantPoints.h - formantPoints.padB"
            class="ci-plot-grid"
          />
          <!-- Axis labels -->
          <text :x="formantPoints.padL" :y="12" class="ci-plot-lbl">F2 {{ formantPoints.f2Hi }}</text>
          <text :x="formantPoints.w - formantPoints.padR" :y="12" text-anchor="end" class="ci-plot-lbl">{{ formantPoints.f2Lo }} Hz</text>
          <text :x="formantPoints.padL - 4" :y="formantPoints.padT + 8" text-anchor="end" class="ci-plot-lbl">{{ formantPoints.f1Lo }}</text>
          <text :x="formantPoints.padL - 4" :y="formantPoints.h - formantPoints.padB" text-anchor="end" class="ci-plot-lbl">{{ formantPoints.f1Hi }}</text>
          <text :x="formantPoints.padL - 4" :y="(formantPoints.padT + formantPoints.h - formantPoints.padB) / 2 + 3" text-anchor="end" class="ci-plot-lbl">F1</text>

          <!-- Trajectory path -->
          <polyline :points="formantPoints.polyline" class="ci-plot-line" />

          <!-- Nodes -->
          <g
            v-for="pt in formantPoints.pts"
            :key="pt.key"
            class="ci-plot-node"
            :class="{ selected: pt.selected }"
            @click="emit('selectCell', pt.key)"
          >
            <circle :cx="pt.x" :cy="pt.y" :r="pt.selected ? 5.5 : 3.8" />
            <text :x="pt.x" :y="pt.y - 8" text-anchor="middle" class="ci-plot-step">{{ pt.stepA }}</text>
            <title>第 {{ pt.stepA }} 格 · F1 {{ pt.f1 }} Hz / F2 {{ pt.f2 }} Hz</title>
          </g>
        </svg>
      </div>
      <div v-else class="ci-plot-empty sci-plane muted">
        <IconSvg name="waveform" :size="15" />
        <span>当前轮廓共振峰数据未就绪</span>
      </div>
      <div class="ci-metrics-row mono">
        <span class="metric-chip">F0 {{ selectedCell.f0Hz }} Hz</span>
        <span class="metric-chip">F3 {{ selectedCell.metrics?.f3_hz || '—' }} Hz</span>
        <span v-if="selectedCell.durationS !== null" class="metric-chip">时长 {{ Math.round(selectedCell.durationS * 1000) }} ms</span>
        <span v-if="selectedCell.pressurePa !== null" class="metric-chip">气压 {{ Math.round(selectedCell.pressurePa) }} Pa</span>
      </div>
    </div>

    <div class="ci-card ci-params">
      <div class="ci-head">
        <span class="ci-title">
          <strong>主要变化构音参数</strong>
          <span class="muted">端点 A → 当前 → 端点 B</span>
        </span>
      </div>
      <table class="mini-tbl ci-tbl">
        <thead>
          <tr>
            <th>参数</th>
            <th>A</th>
            <th>当前</th>
            <th>B</th>
          </tr>
        </thead>
        <tbody class="mono">
          <tr v-for="row in topChangedParams" :key="row.key">
            <td :title="row.label">{{ row.key }}</td>
            <td class="muted">{{ row.a.toFixed(2) }}</td>
            <td class="ci-cur-val">{{ row.cur.toFixed(2) }}</td>
            <td class="muted">{{ row.b.toFixed(2) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.ci-wrap {
  flex: none;
  display: grid;
  grid-template-columns: minmax(220px, 1.05fr) minmax(250px, 1.25fr) minmax(210px, 0.95fr);
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

.ci-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--panel-border);
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--panel) 84%, var(--app));
}

.ci-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 0.875rem;
}

.ci-title {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.ci-ghost-seg {
  display: inline-flex;
}

.ci-svg-box {
  height: 172px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  cursor: pointer;
}

.ci-svg {
  width: 100%;
  height: 100%;
  display: block;
}

.ci-legend {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.791667rem;
}

.ci-plot-box,
.ci-plot-empty {
  height: 156px;
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.ci-plot-svg {
  width: 100%;
  height: 100%;
  display: block;
}

.ci-plot-frame {
  fill: none;
  stroke: var(--border);
  stroke-width: 1;
}

.ci-plot-grid {
  stroke: color-mix(in srgb, var(--border) 65%, transparent);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}

.ci-plot-lbl {
  fill: var(--muted);
  font-size: 9px;
  font-family: var(--font-mono);
}

.ci-plot-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.75;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.ci-plot-node {
  cursor: pointer;
}

.ci-plot-node circle {
  fill: var(--panel);
  stroke: var(--accent);
  stroke-width: 1.8;
  transition: r var(--dur-fast) var(--ease-out-expo);
}

.ci-plot-node.selected circle {
  fill: var(--accent);
  stroke: var(--text);
  stroke-width: 1.5;
}

.ci-plot-step {
  fill: var(--text);
  font-size: 9px;
  font-weight: 700;
  font-family: var(--font-mono);
  pointer-events: none;
}

.ci-metrics-row {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.ci-tbl {
  width: 100%;
  font-size: 0.833333rem;
}

.ci-cur-val {
  color: var(--accent);
  font-weight: 700;
}

@container desktop (max-width: 1280px) {
  .ci-wrap {
    grid-template-columns: 1fr 1fr;
  }
  .ci-params {
    grid-column: 1 / -1;
  }
}

@media (max-width: 1120px) {
  .ci-wrap {
    grid-template-columns: 1fr;
  }
}
</style>
