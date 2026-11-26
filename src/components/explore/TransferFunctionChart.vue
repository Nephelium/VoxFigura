<script setup lang="ts">
import { computed } from 'vue';
import type { TractMetrics } from '@/stores/workbench';
import '@/styles/acoustic-charts.css';

const props = withDefaults(
  defineProps<{
    metricsA: TractMetrics;
    metricsB?: TractMetrics | null;
    compareMode?: boolean;
    heightPx?: number;
    metric?: 'spectrum' | 'area' | 'vowels';
  }>(),
  { metricsB: null, compareMode: false, heightPx: 168, metric: 'spectrum' },
);

const W = 600;
const H = 112;
const series = computed(() =>
  props.compareMode && props.metricsB ? [props.metricsA, props.metricsB] : [props.metricsA],
);
const titles = {
  spectrum: 'H(f) 声道传递函数',
  area: 'A(x) 声道面积函数',
  vowels: 'F1–F2 声学元音图',
};
const units = {
  spectrum: ['频率 (Hz)', 'dB'],
  area: ['距离 (cm)', 'cm²'],
  vowels: ['F2 (Hz) 前 ← → 后', 'F1 (Hz)'],
};

const peakLists = computed(() =>
  series.value.map(
    (m) => m.peaks_hz ?? [m.f1_hz, m.f2_hz, m.f3_hz].filter((hz) => Number.isFinite(hz) && hz > 0),
  ),
);

const maxFrequency = computed(() =>
  series.value.some((m) => (m.transfer_fn.at(-1)?.f_hz ?? 0) >= 7900) ? 8000 : 5000,
);

const shownPeaks = computed(() =>
  peakLists.value.map((peaks) => peaks.filter((hz) => hz <= maxFrequency.value)),
);

// T-27: Read `metrics.antiformants` and `metrics.nasal_coupled` to render Z1..Zn antiformant zeros
const hasNasalCoupled = computed(() => series.value.some((m) => Boolean(m.nasal_coupled)));
const shownZeros = computed(() =>
  series.value.map((m) =>
    (m.antiformants ?? []).filter(
      (z) => Number.isFinite(z.f_hz) && z.f_hz > 0 && z.f_hz <= maxFrequency.value,
    ),
  ),
);

const pathData = computed(() =>
  series.value.map((m) => {
    if (props.metric === 'area') return m.area_fn.map((p) => [p.x_cm, p.area_cm2] as const);
    if (props.metric === 'vowels')
      return m.f1_hz > 0 && m.f2_hz > 0 ? [[m.f2_hz, m.f1_hz] as const] : [];
    return m.transfer_fn
      .filter((p) => p.f_hz <= maxFrequency.value)
      .map((p) => [p.f_hz, p.db] as const);
  }),
);

const domains = computed(() => {
  const points = pathData.value.flat();
  const x = points.map((p) => p[0]);
  const y = points.map((p) => p[1]);
  if (props.metric === 'area') {
    return {
      x0: 0,
      x1: Math.max(5, Math.ceil(Math.max(...x, 0) / 5) * 5),
      y0: 0,
      y1: Math.max(2, Math.ceil(Math.max(...y, 0))),
    };
  }
  if (props.metric === 'vowels') {
    return {
      x0: Math.max(3000, Math.ceil(Math.max(...x, 0) / 500) * 500),
      x1: 0,
      y0: Math.max(1000, Math.ceil(Math.max(...y, 0) / 200) * 200),
      y1: 0,
    };
  }
  const hi = Math.ceil(Math.max(0, ...y) / 10) * 10;
  return {
    x0: 0,
    x1: maxFrequency.value,
    y0: Math.min(hi - 10, Math.floor(Math.min(0, ...y) / 10) * 10),
    y1: hi,
  };
});

const mapX = (x: number) => (W * (x - domains.value.x0)) / (domains.value.x1 - domains.value.x0);
const mapY = (y: number) => H * (1 - (y - domains.value.y0) / (domains.value.y1 - domains.value.y0));
const clampPlotY = (py: number) => Math.max(8, Math.min(H - 8, py));

const ticks = (start: number, end: number, steps: number) =>
  Array.from({ length: steps + 1 }, (_, i) => Math.round(start + (i / steps) * (end - start)));
const xTicks = computed(() => ticks(domains.value.x0, domains.value.x1, 4));
const yTicks = computed(() => ticks(domains.value.y1, domains.value.y0, 3));
const curves = computed(() =>
  pathData.value.map((points) =>
    points.map(([x, y], i) => `${i ? 'L' : 'M'}${mapX(x).toFixed(2)},${mapY(y).toFixed(2)}`).join(' '),
  ),
);

const seriesClass = (i: number) => (i ? 'peer' : 'primary');
const source = computed(() =>
  series.value.every((m) => m.source === 'vtl-engine') ? 'VTL 模型' : '含解析参考',
);
</script>

<template>
  <section
    class="chart-card acoustic-plot"
    :style="{ minHeight: heightPx + 'px' }"
    :aria-label="titles[metric]"
  >
    <header class="plot-title">
      <strong>{{ titles[metric] }}</strong>
      <small>{{ source }}</small>
      <span v-if="metric === 'spectrum' && hasNasalCoupled" class="nasal-badge">鼻腔耦合</span>
      <span v-if="compareMode" class="series-key">
        <i class="primary" /><b>A</b><i class="peer" /><b>B</b>
      </span>
    </header>

    <div class="plot-body">
      <div class="ticks y-ticks mono">
        <span v-for="(tick, i) in yTicks" :key="i">{{ tick }}</span>
      </div>

      <div class="plot-linebox">
        <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" :aria-label="titles[metric]">
          <path v-for="tick in yTicks" :key="`y-${tick}`" class="grid" :d="`M0 ${mapY(tick)}H${W}`" />
          <path v-for="tick in xTicks" :key="`x-${tick}`" class="grid minor" :d="`M${mapX(tick)} 0V${H}`" />

          <template v-if="metric !== 'vowels'">
            <path
              v-if="curves[0] && pathData[0]?.length"
              class="series-area"
              :d="`${curves[0]} L${mapX(pathData[0].at(-1)![0])},${H} L${mapX(pathData[0][0][0])},${H}Z`"
            />
            <path v-for="(d, i) in curves" :key="i" :class="['curve', seriesClass(i)]" :d="d" />

            <!-- Spectrum Formant Peaks (F1..Fn) & Antiformant Zeros (Z1..Zn) -->
            <g v-if="metric === 'spectrum'">
              <g v-for="(peaks, i) in shownPeaks" :key="'pk-' + i">
                <path
                  v-for="(hz, j) in peaks"
                  :key="j"
                  :class="['peak-guide', seriesClass(i)]"
                  :d="`M${mapX(hz)} 0V${H}`"
                >
                  <title>
                    {{ series[i].source === 'vtl-engine' ? '共振峰' : '解析峰' }} F{{ j + 1 }} · {{ hz.toFixed(1) }} Hz
                  </title>
                </path>
              </g>

              <g v-for="(zeros, i) in shownZeros" :key="'zr-' + i">
                <path
                  v-for="(zero, zIdx) in zeros"
                  :key="zIdx"
                  :class="['zero-guide', seriesClass(i)]"
                  :d="`M${mapX(zero.f_hz)} 0V${H}`"
                >
                  <title>
                    反共振零点 Z{{ zIdx + 1 }} · {{ Math.round(zero.f_hz) }} Hz ({{ zero.db.toFixed(1) }} dB)
                  </title>
                </path>
              </g>
            </g>
          </template>
        </svg>

        <!-- HTML Overlay Badges so text & inverted triangles stay crisp without SVG aspect distortion -->
        <template v-if="metric === 'spectrum'">
          <template v-for="(peaks, i) in shownPeaks" :key="'pkb-' + i">
            <span
              v-for="(hz, j) in peaks.slice(0, 5)"
              :key="'f-' + i + '-' + j"
              :class="['marker-pill', 'formant-pill', seriesClass(i), { 'row-b': i > 0 }]"
              :style="{ left: (mapX(hz) / W) * 100 + '%' }"
              :title="`共振峰 F${j + 1} · ${Math.round(hz)} Hz`"
            >
              F{{ j + 1 }}
            </span>
          </template>

          <template v-for="(zeros, i) in shownZeros" :key="'zrb-' + i">
            <span
              v-for="(zero, zIdx) in zeros"
              :key="'z-' + i + '-' + zIdx"
              :class="['marker-pill', 'zero-pill', seriesClass(i)]"
              :style="{
                left: (mapX(zero.f_hz) / W) * 100 + '%',
                top: (clampPlotY(mapY(zero.db)) / H) * 100 + '%',
              }"
              :title="`反共振零点 Z${zIdx + 1} · ${Math.round(zero.f_hz)} Hz (${zero.db.toFixed(1)} dB)`"
            >
              <svg class="zero-tri" viewBox="0 0 8 7" aria-hidden="true">
                <polygon points="0,0 8,0 4,7" fill="currentColor" />
              </svg>
              <b>Z{{ zIdx + 1 }}</b>
            </span>
          </template>
        </template>

        <template v-if="metric === 'vowels'">
          <div v-for="(points, i) in pathData" :key="i">
            <span
              v-if="points[0]"
              :class="['vowel-dot', seriesClass(i)]"
              :style="{
                left: (mapX(points[0][0]) / W) * 100 + '%',
                top: (mapY(points[0][1]) / H) * 100 + '%',
              }"
              :title="`F1 ${points[0][1]} Hz · F2 ${points[0][0]} Hz`"
            />
          </div>
        </template>

        <span v-if="pathData.every((p) => !p.length)" class="no-series">没有可绘制的模型数据</span>
      </div>

      <span class="unit-y">{{ units[metric][1] }}</span>
    </div>

    <div class="ticks x-ticks mono">
      <span v-for="tick in xTicks" :key="tick">{{ tick }}</span>
    </div>

    <div class="tail">
      <span>{{ units[metric][0] }}</span>
      <div v-if="metric === 'spectrum'" class="peak-list mono" aria-label="可见频段内的共振峰与反共振零点">
        <span
          v-for="(peaks, i) in shownPeaks"
          :key="'pl-' + i"
          :class="seriesClass(i)"
          :data-peak-count="peaks.length"
        >
          {{ compareMode ? (i ? 'B ' : 'A ') : ''
          }}{{ peaks.map((hz, j) => `F${j + 1} ${Math.round(hz)}`).join(' · ')
          }}{{ peaks.length ? ' Hz' : '暂无共振峰' }}
          <template v-if="shownZeros[i]?.length">
            ·
            <span class="zero-readout">
              {{ shownZeros[i].map((z, k) => `Z${k + 1} ${Math.round(z.f_hz)}`).join(' · ') }} Hz
            </span>
          </template>
        </span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.chart-card {
  margin: 0 12px 7px;
  flex: none;
  display: grid;
  grid-template-rows: auto minmax(74px, 1fr) auto auto;
  padding: 8px 11px;
  gap: 4px;
  color: var(--text);
}

.plot-title,
.tail {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.plot-title strong {
  font-size: 0.916667rem;
}

.plot-title small,
.ticks,
.unit-y,
.tail {
  font-size: 0.791667rem;
  color: var(--muted);
}

.nasal-badge {
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--warning, #b45309);
  background: color-mix(in srgb, var(--warning, #b45309) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning, #b45309) 36%, transparent);
}

.series-key {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  font-size: 0.833333rem;
}

.series-key i {
  width: 15px;
  border-top: 2px solid currentColor;
}

.series-key .peer {
  border-top-style: dashed;
}

.plot-body {
  display: grid;
  grid-template-columns: 29px minmax(0, 1fr) 21px;
  gap: 5px;
  align-items: stretch;
}

.plot-linebox {
  position: relative;
  border: 1px solid var(--chart-outline);
  overflow: hidden;
  background: color-mix(in srgb, var(--chart-panel) 94%, var(--text));
}

.plot-linebox svg {
  width: 100%;
  height: 100%;
  display: block;
}

.grid,
.curve,
.peak-guide,
.zero-guide {
  fill: none;
  vector-effect: non-scaling-stroke;
}

.grid {
  stroke: var(--chart-grid);
  stroke-width: 1;
}

.minor {
  stroke-dasharray: 2 4;
}

.curve {
  stroke: currentColor;
  stroke-width: var(--chart-line);
  stroke-linecap: round;
  stroke-linejoin: round;
}

.primary {
  color: var(--chart-series);
}

.peer {
  color: var(--chart-peer);
}

.curve.peer {
  stroke-dasharray: 5 3;
}

.series-area {
  fill: var(--chart-fill);
  opacity: 0.8;
}

.peak-guide {
  stroke: currentColor;
  stroke-dasharray: 2 4;
  stroke-width: 1;
  opacity: 0.67;
}

.zero-guide {
  stroke: var(--warning, #c2410c);
  stroke-dasharray: 4 2.5;
  stroke-width: 1.15;
  opacity: 0.85;
}

.marker-pill {
  position: absolute;
  pointer-events: auto;
  font: 700 8px/1 var(--font-mono, monospace);
  padding: 1.5px 3.5px;
  border-radius: 2.5px;
  white-space: nowrap;
  user-select: none;
}

.formant-pill {
  top: 2px;
  transform: translateX(-50%);
  background: color-mix(in srgb, var(--chart-panel) 90%, transparent);
  border: 1px solid currentColor;
}

.formant-pill.row-b {
  top: 15px;
}

.zero-pill {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  transform: translate(-50%, -100%);
  color: var(--warning, #c2410c);
  background: color-mix(in srgb, var(--chart-panel) 92%, transparent);
  border: 1px dashed var(--warning, #c2410c);
}

.zero-pill b {
  font-weight: 700;
}

.zero-tri {
  width: 6px !important;
  height: 5.5px !important;
  flex: none;
}

.zero-readout {
  color: var(--warning, #c2410c);
}

.ticks {
  display: flex;
  justify-content: space-between;
  font-variant-numeric: tabular-nums;
}

.y-ticks {
  flex-direction: column;
  text-align: right;
}

.x-ticks {
  padding: 0 23px 0 32px;
}

.tail {
  padding-left: 33px;
}

.peak-list {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 3px 9px;
  font-size: 0.75rem;
}

.vowel-dot {
  position: absolute;
  width: 9px;
  aspect-ratio: 1;
  transform: translate(-50%, -50%);
  background: currentColor;
  border: 1px solid var(--panel);
  border-radius: 50%;
  box-shadow: 0 0 0 3px var(--chart-fill);
}

.no-series {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--muted);
  font-size: 0.833333rem;
}
</style>
