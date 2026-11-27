<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { renderM27TractSvg, type TractViewBox } from '@/vendor/m27-tract-studio/tract-renderer.js';
import { paintReferenceFrame, type PaintableTractFrame } from '@/data/reference-geometry';
import { tractArray19ToRecord, VTL_PARAM_META } from '@/stores/workbench';
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

export interface FormantTrackPoint {
  u: number;
  f1_hz: number;
  f2_hz: number;
  f3_hz: number;
}

export interface DynamicContourSample {
  u: number;
  parts: TractPartsMap;
}

const props = defineProps<{
  cells: readonly InspectorCellItem[];
  selectedCell: InspectorCellItem | null;
  contoursByKey: Readonly<Record<string, InspectorContourData>>;
  formantTracksByKey: Readonly<Record<string, readonly FormantTrackPoint[]>>;
  isDynamic: boolean;
  endpointAParams: Record<TractParamName, number>;
  endpointBParams: Record<TractParamName, number>;
  endpointALabel: string;
  endpointBLabel: string;
  endpointAContour?: InspectorContourData;
  endpointBContour?: InspectorContourData;
  endpointADynamicContours?: readonly DynamicContourSample[];
  endpointBDynamicContours?: readonly DynamicContourSample[];
  dualAxis: boolean;
  viewBox: string;
  viewBoxObj: TractViewBox;
  ghostMode: ContinuumGhostMode;
  activePlaybackFrame: PaintableTractFrame | null;
  activePlaybackKey: string;
  activePlaybackProgress: number;
  controlsBusy: boolean;
  themeStamp: string;
}>();

const emit = defineEmits<{
  'update:ghostMode': [mode: ContinuumGhostMode];
  selectCell: [key: string];
  auditionSelected: [];
  auditionCompare: [];
}>();

const previewSvgRef = ref<SVGSVGElement | null>(null);

const ghostOptions: ReadonlyArray<{ value: ContinuumGhostMode; label: string }> = [
  { value: 'both', label: 'A+B 叠影' },
  { value: 'A', label: '端点 A' },
  { value: 'B', label: '端点 B' },
  { value: 'off', label: '无叠影' },
];

// Always follow whichever cell is currently playing, falling back to the selected cell
const activeCell = computed(() => {
  if (props.activePlaybackKey) {
    const playing = props.cells.find((c) => c.key === props.activePlaybackKey);
    if (playing) return playing;
  }
  return props.selectedCell;
});

const isFollowingPlayback = computed(() => Boolean(props.activePlaybackKey && props.activePlaybackFrame));

function sampleDynamicParts(samples: readonly DynamicContourSample[] | undefined, u: number): TractPartsMap | undefined {
  if (!samples?.length) return undefined;
  let best = samples[0];
  let bestDist = Math.abs(best.u - u);
  for (let i = 1; i < samples.length; i++) {
    const d = Math.abs(samples[i].u - u);
    if (d < bestDist) {
      best = samples[i];
      bestDist = d;
    }
  }
  return best.parts;
}

function cutCorners(pts: readonly [number, number][]): [number, number][] {
  if (pts.length < 2) return [...pts];
  const out: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    out.push(
      [0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]],
      [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]],
    );
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function buildLipProfiles(parts: TractPartsMap): { upper?: [number, number][]; lower?: [number, number][] } {
  const uRaw = parts.upper_lip;
  const lRaw = parts.lower_lip;
  if (!uRaw || !lRaw || uRaw.length < 5 || lRaw.length < 5) {
    return { upper: uRaw?.slice(1), lower: lRaw?.slice(1) };
  }
  // Match tract-renderer.js m10BuildLips: drop internal attachment point [0], clamp at lip seam, smooth twice
  const seam = 0.5 * (uRaw[4][1] + lRaw[4][1]);
  let upper: [number, number][] = uRaw.slice(1).map((p) => [p[0], Math.max(p[1], seam)]);
  let lower: [number, number][] = lRaw.slice(1).map((p) => [p[0], Math.min(p[1], seam)]);
  for (let n = 0; n < 2; n++) {
    upper = cutCorners(upper);
    lower = cutCorners(lower);
  }
  return { upper, lower };
}

function buildSmoothCurvePath(pts: readonly [number, number][] | undefined): string {
  if (!pts || pts.length < 2) return '';
  // Match tract-renderer.js m10Curve exactly (VTL Y-up -> SVG Y-down via -y)
  const at = (p: readonly [number, number]) => `${p[0].toFixed(3)},${(-p[1]).toFixed(3)}`;
  if (pts.length < 3) return `M${at(pts[0])}L${at(pts[1])}`;
  const mid = (a: readonly [number, number], b: readonly [number, number]) =>
    `${((a[0] + b[0]) * 0.5).toFixed(3)},${(-(a[1] + b[1]) * 0.5).toFixed(3)}`;
  let d = `M${at(pts[0])}L${mid(pts[0], pts[1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    d += `Q${at(pts[i])} ${mid(pts[i], pts[i + 1])}`;
  }
  return `${d}L${at(pts[pts.length - 1])}`;
}

function readTokenColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function appendHighContrastGhosts(svg: SVGSVGElement): void {
  if (props.ghostMode === 'off') return;
  const u = isFollowingPlayback.value ? props.activePlaybackProgress : 0.5;
  const partsA =
    props.isDynamic && isFollowingPlayback.value && props.endpointADynamicContours?.length
      ? sampleDynamicParts(props.endpointADynamicContours, u)
      : props.endpointAContour?.parts;
  const partsB =
    props.isDynamic && isFollowingPlayback.value && props.endpointBDynamicContours?.length
      ? sampleDynamicParts(props.endpointBDynamicContours, u)
      : props.endpointBContour?.parts;

  const ns = 'http://www.w3.org/2000/svg';
  const group = document.createElementNS(ns, 'g');
  group.setAttribute('data-role', 'continuum-ghost-overlay');
  group.setAttribute('pointer-events', 'none');

  const drawParts = (parts: TractPartsMap | undefined, color: string, dash: string) => {
    if (!parts) return;
    const tongueDorsal = parts.tongue?.slice(0, Math.min(34, parts.tongue.length));
    const lips = buildLipProfiles(parts);
    const segments: Array<{ pts?: readonly [number, number][]; width: number }> = [
      { pts: tongueDorsal, width: 0.095 },
      { pts: lips.upper, width: 0.07 },
      { pts: lips.lower, width: 0.07 },
    ];
    for (const seg of segments) {
      const d = buildSmoothCurvePath(seg.pts);
      if (!d) continue;
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', String(seg.width));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('stroke-dasharray', dash);
      path.setAttribute('opacity', '0.9');
      group.appendChild(path);
    }
  };

  if (props.ghostMode === 'both' || props.ghostMode === 'A') {
    drawParts(partsA, readTokenColor('--teal', 'currentColor'), '0.24 0.12');
  }
  if (props.ghostMode === 'both' || props.ghostMode === 'B') {
    drawParts(partsB, readTokenColor('--warning', 'currentColor'), '0.14 0.10');
  }

  if (group.childNodes.length) {
    svg.appendChild(group);
  }
}

function paintPreview(): void {
  const svg = previewSvgRef.value;
  const cell = activeCell.value;
  if (!svg || !cell) return;
  if (props.activePlaybackFrame && props.activePlaybackKey === cell.key) {
    paintReferenceFrame(svg, props.activePlaybackFrame, { viewBox: props.viewBoxObj });
    svg.setAttribute('viewBox', props.viewBox);
    appendHighContrastGhosts(svg);
    return;
  }
  const hd = props.contoursByKey[cell.key];
  if (!hd) return;
  renderM27TractSvg(
    svg,
    {},
    {
      parts: hd.parts,
      lm: hd.lm,
      nasal: hd.nasal,
      ja: hd.ja,
      jx: hd.jx,
    },
    {
      showLabels: false,
      showGhost: false,
      viewBox: props.viewBoxObj,
      theme: { anatomyBg: 'transparent' },
    },
  );
  svg.setAttribute('viewBox', props.viewBox);
  appendHighContrastGhosts(svg);
}

watch(
  [
    () => activeCell.value?.key,
    () => props.contoursByKey,
    () => props.endpointADynamicContours,
    () => props.endpointBDynamicContours,
    () => props.ghostMode,
    () => props.viewBox,
    () => props.activePlaybackFrame,
    () => props.activePlaybackKey,
    () => props.activePlaybackProgress,
    () => props.themeStamp,
  ],
  () => {
    void nextTick(paintPreview);
  },
  { immediate: true },
);

const rowCells = computed(() => {
  const refCell = activeCell.value;
  if (!refCell || !props.dualAxis) return props.cells;
  return props.cells.filter((c) => c.stepB === refCell.stepB);
});

function trackColorForBlend(blend: number): string {
  const pctB = Math.round(Math.max(0, Math.min(1, blend)) * 100);
  if (pctB <= 50) {
    const t = Math.round((pctB / 50) * 100);
    return `color-mix(in srgb, var(--accent) ${t}%, var(--teal))`;
  }
  const t = Math.round(((pctB - 50) / 50) * 100);
  return `color-mix(in srgb, var(--warning) ${t}%, var(--accent))`;
}

// Dynamic multi-trajectory vowel plot (one full time-varying F1-F2 curve per continuum cell!)
const dynamicPlot = computed(() => {
  if (!props.isDynamic) return null;
  const curves = rowCells.value
    .map((cell) => {
      const raw = (props.formantTracksByKey[cell.key] ?? []).filter(
        (pt) => pt.f1_hz >= 140 && pt.f1_hz <= 1300 && pt.f2_hz >= 420 && pt.f2_hz <= 3200,
      );
      return { cell, raw };
    })
    .filter((entry) => entry.raw.length >= 2);
  if (!curves.length) return null;

  const allPts = curves.flatMap((c) => c.raw);
  const f1MinRaw = Math.min(...allPts.map((p) => p.f1_hz));
  const f1MaxRaw = Math.max(...allPts.map((p) => p.f1_hz));
  const f2MinRaw = Math.min(...allPts.map((p) => p.f2_hz));
  const f2MaxRaw = Math.max(...allPts.map((p) => p.f2_hz));
  const f1Span = Math.max(160, f1MaxRaw - f1MinRaw);
  const f2Span = Math.max(360, f2MaxRaw - f2MinRaw);
  const f1Lo = Math.max(140, Math.floor((f1MinRaw - f1Span * 0.16) / 50) * 50);
  const f1Hi = Math.ceil((f1MaxRaw + f1Span * 0.16) / 50) * 50;
  const f2Lo = Math.max(400, Math.floor((f2MinRaw - f2Span * 0.14) / 100) * 100);
  const f2Hi = Math.ceil((f2MaxRaw + f2Span * 0.14) / 100) * 100;

  const padL = 38;
  const padR = 16;
  const padT = 18;
  const padB = 22;
  const w = 320;
  const h = 164;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const toX = (f2: number) => Number((padL + ((f2Hi - f2) / Math.max(1, f2Hi - f2Lo)) * plotW).toFixed(1));
  const toY = (f1: number) => Number((padT + ((f1 - f1Lo) / Math.max(1, f1Hi - f1Lo)) * plotH).toFixed(1));

  const placedLabels: Array<{ x: number; y: number }> = [];
  const rawTracks = curves.map(({ cell, raw }) => {
    const pts = raw.map((p) => ({
      u: p.u,
      f1: Math.round(p.f1_hz),
      f2: Math.round(p.f2_hz),
      f3: Math.round(p.f3_hz),
      x: toX(p.f2_hz),
      y: toY(p.f1_hz),
    }));
    const end = pts[pts.length - 1];
    const nearRight = end.x > w - padR - 18;
    const labelAnchor = nearRight ? 'end' : 'start';
    const lx = nearRight ? end.x - 6 : end.x + 6;
    let ly = end.y + 3;
    for (let tries = 0; tries < 6; tries++) {
      const clash = placedLabels.find((pl) => Math.abs(pl.x - lx) < 13 && Math.abs(pl.y - ly) < 10);
      if (!clash) break;
      ly = ly <= clash.y ? clash.y - 10.5 : clash.y + 10.5;
      if (ly < padT + 9) ly = clash.y + 10.5;
      if (ly > h - padB - 3) ly = clash.y - 10.5;
    }
    ly = Math.max(padT + 9, Math.min(h - padB - 3, ly));
    placedLabels.push({ x: lx, y: ly });
    const isPlaying = props.activePlaybackKey === cell.key;
    const isSelected = activeCell.value?.key === cell.key;
    return {
      key: cell.key,
      stepA: cell.stepA,
      stepB: cell.stepB,
      color: trackColorForBlend(cell.blend),
      pts,
      polyline: pts.map((p) => `${p.x},${p.y}`).join(' '),
      start: pts[0],
      end,
      lx: Number(lx.toFixed(1)),
      ly: Number(ly.toFixed(1)),
      labelAnchor,
      isPlaying,
      isSelected,
    };
  });
  // Paint active/playing track last so it stays crisply on top of peer trajectories
  const tracks = [...rawTracks].sort((a, b) => Number(a.isSelected || a.isPlaying) - Number(b.isSelected || b.isPlaying));

  // Compute live moving playhead marker along the currently playing cell's trajectory
  let cursor: { x: number; y: number; f1: number; f2: number; f3: number; color: string } | null = null;
  if (props.activePlaybackKey) {
    const playingTrack = tracks.find((t) => t.key === props.activePlaybackKey);
    if (playingTrack && playingTrack.pts.length >= 2) {
      const u = Math.max(0, Math.min(1, props.activePlaybackProgress));
      const pts = playingTrack.pts;
      // Show live cursor while playback is inside (or near) this cell's voiced vowel trajectory span
      if (u >= pts[0].u - 0.04 && u <= pts[pts.length - 1].u + 0.04) {
        const clampedU = Math.max(pts[0].u, Math.min(pts[pts.length - 1].u, u));
        const idx = pts.findIndex((p) => p.u >= clampedU);
        if (idx <= 0) {
          const p0 = pts[0];
          cursor = { x: p0.x, y: p0.y, f1: p0.f1, f2: p0.f2, f3: p0.f3, color: playingTrack.color };
        } else {
          const a = pts[idx - 1];
          const b = pts[idx];
          const k = (clampedU - a.u) / Math.max(1e-6, b.u - a.u);
          cursor = {
            x: Number((a.x + (b.x - a.x) * k).toFixed(1)),
            y: Number((a.y + (b.y - a.y) * k).toFixed(1)),
            f1: Math.round(a.f1 + (b.f1 - a.f1) * k),
            f2: Math.round(a.f2 + (b.f2 - a.f2) * k),
            f3: Math.round(a.f3 + (b.f3 - a.f3) * k),
            color: playingTrack.color,
          };
        }
      }
    }
  }

  return { w, h, padL, padR, padT, padB, f1Lo, f1Hi, f2Lo, f2Hi, tracks, cursor };
});

// Static single-pose vowel plot (for preset / phoneme / single-frame continuum)
const staticPlot = computed(() => {
  if (dynamicPlot.value) return null;
  const valid = rowCells.value.filter((c) => c.metrics && c.metrics.f1_hz > 0 && c.metrics.f2_hz > 0);
  if (valid.length < 2) return null;
  const f1Vals = valid.map((c) => c.metrics!.f1_hz);
  const f2Vals = valid.map((c) => c.metrics!.f2_hz);
  const f1MinRaw = Math.min(...f1Vals);
  const f1MaxRaw = Math.max(...f1Vals);
  const f2MinRaw = Math.min(...f2Vals);
  const f2MaxRaw = Math.max(...f2Vals);
  const f1Span = Math.max(140, f1MaxRaw - f1MinRaw);
  const f2Span = Math.max(300, f2MaxRaw - f2MinRaw);
  const f1Lo = Math.max(150, Math.floor((f1MinRaw - f1Span * 0.2) / 50) * 50);
  const f1Hi = Math.ceil((f1MaxRaw + f1Span * 0.2) / 50) * 50;
  const f2Lo = Math.max(400, Math.floor((f2MinRaw - f2Span * 0.18) / 100) * 100);
  const f2Hi = Math.ceil((f2MaxRaw + f2Span * 0.18) / 100) * 100;

  const padL = 38;
  const padR = 16;
  const padT = 18;
  const padB = 22;
  const w = 320;
  const h = 164;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const pts = valid.map((c) => {
    const f1 = c.metrics!.f1_hz;
    const f2 = c.metrics!.f2_hz;
    const x = padL + ((f2Hi - f2) / Math.max(1, f2Hi - f2Lo)) * plotW;
    const y = padT + ((f1 - f1Lo) / Math.max(1, f1Hi - f1Lo)) * plotH;
    return {
      key: c.key,
      stepA: c.stepA,
      stepB: c.stepB,
      f1,
      f2,
      color: trackColorForBlend(c.blend),
      x: Number(x.toFixed(1)),
      y: Number(y.toFixed(1)),
      selected: c.key === activeCell.value?.key,
      playing: c.key === props.activePlaybackKey,
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

// Live acoustic readout chips (follows live cursor when playing dynamic track)
const liveMetricsReadout = computed(() => {
  const cell = activeCell.value;
  if (!cell) return null;
  const cursor = dynamicPlot.value?.cursor;
  return {
    f0: cell.f0Hz,
    f1: cursor?.f1 ?? cell.metrics?.f1_hz ?? 0,
    f2: cursor?.f2 ?? cell.metrics?.f2_hz ?? 0,
    f3: cursor?.f3 ?? cell.metrics?.f3_hz ?? 0,
    durationMs: cell.durationS !== null ? Math.round(cell.durationS * 1000) : null,
    pressurePa: cell.pressurePa !== null ? Math.round(cell.pressurePa) : null,
  };
});

// Top changed articulatory parameters (live-updates from activePlaybackFrame.params during playback!)
const topChangedParams = computed(() => {
  const cell = activeCell.value;
  if (!cell) return [];
  const liveParams =
    props.activePlaybackFrame && props.activePlaybackFrame.params.length === 19
      ? tractArray19ToRecord(props.activePlaybackFrame.params)
      : cell.params;
  const rows = VTL_PARAM_META.filter((m) => m.key !== 'TRX' && m.key !== 'TRY').map((meta) => {
    const a = props.endpointAParams[meta.key];
    const b = props.endpointBParams[meta.key];
    const cur = liveParams[meta.key];
    const span = Math.max(1e-6, meta.max - meta.min);
    const diffNorm = Math.max(Math.abs(b - a), Math.abs(cur - a)) / span;
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
  <section v-if="activeCell" class="ci-wrap" aria-label="声学与构音联合分析">
    <div class="ci-card ci-preview">
      <div class="ci-head">
        <span class="ci-title">
          <span v-if="isFollowingPlayback" class="ci-live-badge mono">播放中</span>
          <strong>{{ dualAxis ? `格 A${activeCell.stepA}·B${activeCell.stepB}` : `第 ${activeCell.stepA} 格` }} 构型对比</strong>
          <span class="muted mono">{{ activeCell.axisBadge }}</span>
        </span>
        <div class="ci-head-tools">
          <button
            type="button"
            class="btn xs"
            :disabled="controlsBusy"
            title="依次连播「端点 A → 当前选中格 → 端点 B」直接对比听感"
            @click="emit('auditionCompare')"
          >
            <IconSvg name="play" :size="10" />
            <span>对比听 A·中·B</span>
          </button>
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
      </div>
      <div class="ci-svg-box sci-plane" @dblclick="emit('auditionSelected')" title="双击试听当前格；播放任意格时实时同步动画与叠影">
        <svg
          v-if="contoursByKey[activeCell.key] || (activePlaybackFrame && activePlaybackKey === activeCell.key)"
          ref="previewSvgRef"
          class="ci-svg"
          :viewBox="viewBox"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        />
        <span v-else class="muted">等待声道轮廓…</span>
      </div>
      <div class="ci-legend muted">
        <span class="ci-leg-item"><i class="ci-swatch solid" />当前格</span>
        <span v-if="ghostMode === 'both' || ghostMode === 'A'" class="ci-leg-item" :title="endpointALabel">
          <i class="ci-swatch ghost-a" />端点 A
        </span>
        <span v-if="ghostMode === 'both' || ghostMode === 'B'" class="ci-leg-item" :title="endpointBLabel">
          <i class="ci-swatch ghost-b" />端点 B
        </span>
      </div>
    </div>

    <div class="ci-card ci-chart">
      <div class="ci-head">
        <span class="ci-title">
          <strong>F1–F2 元音空间轨迹</strong>
          <span class="muted">
            {{
              dynamicPlot
                ? `${dynamicPlot.tracks.length} 条动态轨迹（口腔峰）`
                : dualAxis
                  ? `第 ${activeCell.stepB} 行`
                  : '静态步进'
            }}
          </span>
        </span>
        <span class="muted mono">{{ dynamicPlot ? '○ 起点 · ● 终点 · 点击轨迹切格' : '点击节点切格' }}</span>
      </div>

      <!-- Mode 1: Dynamic Multi-Trajectory Plot (one curve per audio continuum cell) -->
      <div v-if="dynamicPlot" class="ci-plot-box sci-plane">
        <svg
          :viewBox="`0 0 ${dynamicPlot.w} ${dynamicPlot.h}`"
          class="ci-plot-svg"
          role="img"
          aria-label="多条动态音频 F1-F2 元音空间轨迹图"
        >
          <rect
            :x="dynamicPlot.padL"
            :y="dynamicPlot.padT"
            :width="dynamicPlot.w - dynamicPlot.padL - dynamicPlot.padR"
            :height="dynamicPlot.h - dynamicPlot.padT - dynamicPlot.padB"
            class="ci-plot-frame"
          />
          <line
            :x1="dynamicPlot.padL"
            :y1="(dynamicPlot.padT + dynamicPlot.h - dynamicPlot.padB) / 2"
            :x2="dynamicPlot.w - dynamicPlot.padR"
            :y2="(dynamicPlot.padT + dynamicPlot.h - dynamicPlot.padB) / 2"
            class="ci-plot-grid"
          />
          <line
            :x1="(dynamicPlot.padL + dynamicPlot.w - dynamicPlot.padR) / 2"
            :y1="dynamicPlot.padT"
            :x2="(dynamicPlot.padL + dynamicPlot.w - dynamicPlot.padR) / 2"
            :y2="dynamicPlot.h - dynamicPlot.padB"
            class="ci-plot-grid"
          />
          <text :x="dynamicPlot.padL" :y="12" class="ci-plot-lbl">F2 {{ dynamicPlot.f2Hi }}</text>
          <text :x="dynamicPlot.w - dynamicPlot.padR" :y="12" text-anchor="end" class="ci-plot-lbl">{{ dynamicPlot.f2Lo }} Hz</text>
          <text :x="dynamicPlot.padL - 4" :y="dynamicPlot.padT + 8" text-anchor="end" class="ci-plot-lbl">{{ dynamicPlot.f1Lo }}</text>
          <text :x="dynamicPlot.padL - 4" :y="dynamicPlot.h - dynamicPlot.padB" text-anchor="end" class="ci-plot-lbl">{{ dynamicPlot.f1Hi }}</text>
          <text :x="dynamicPlot.padL - 4" :y="(dynamicPlot.padT + dynamicPlot.h - dynamicPlot.padB) / 2 + 3" text-anchor="end" class="ci-plot-lbl">F1</text>

          <g
            v-for="tr in dynamicPlot.tracks"
            :key="tr.key"
            class="ci-dyn-track"
            :class="{ active: tr.isSelected || tr.isPlaying }"
            @click="emit('selectCell', tr.key)"
          >
            <polyline :points="tr.polyline" class="ci-dyn-hit" />
            <polyline
              :points="tr.polyline"
              class="ci-dyn-line"
              :style="{ stroke: tr.color }"
            />
            <circle :cx="tr.start.x" :cy="tr.start.y" :r="tr.isSelected || tr.isPlaying ? 3.2 : 2.3" class="ci-dyn-start" :style="{ stroke: tr.color }" />
            <circle :cx="tr.end.x" :cy="tr.end.y" :r="tr.isSelected || tr.isPlaying ? 3.8 : 2.6" :style="{ fill: tr.color }" />
            <text :x="tr.lx" :y="tr.ly" :text-anchor="tr.labelAnchor" class="ci-plot-step" :style="{ fill: tr.color }">{{ tr.stepA }}</text>
            <title>第 {{ tr.stepA }} 格轨迹 · 起点 F1 {{ tr.start.f1 }}/F2 {{ tr.start.f2 }} → 终点 F1 {{ tr.end.f1 }}/F2 {{ tr.end.f2 }} Hz</title>
          </g>

          <!-- Live moving playback dot -->
          <g v-if="dynamicPlot.cursor" class="ci-live-dot" pointer-events="none">
            <circle :cx="dynamicPlot.cursor.x" :cy="dynamicPlot.cursor.y" r="7.5" class="ci-live-halo" />
            <circle :cx="dynamicPlot.cursor.x" :cy="dynamicPlot.cursor.y" r="4.2" class="ci-live-core" />
          </g>
        </svg>
      </div>

      <!-- Mode 2: Static Cell-to-Cell Vowel Path -->
      <div v-else-if="staticPlot" class="ci-plot-box sci-plane">
        <svg :viewBox="`0 0 ${staticPlot.w} ${staticPlot.h}`" class="ci-plot-svg" role="img" aria-label="F1-F2 共振峰轨迹图">
          <rect
            :x="staticPlot.padL"
            :y="staticPlot.padT"
            :width="staticPlot.w - staticPlot.padL - staticPlot.padR"
            :height="staticPlot.h - staticPlot.padT - staticPlot.padB"
            class="ci-plot-frame"
          />
          <line
            :x1="staticPlot.padL"
            :y1="(staticPlot.padT + staticPlot.h - staticPlot.padB) / 2"
            :x2="staticPlot.w - staticPlot.padR"
            :y2="(staticPlot.padT + staticPlot.h - staticPlot.padB) / 2"
            class="ci-plot-grid"
          />
          <line
            :x1="(staticPlot.padL + staticPlot.w - staticPlot.padR) / 2"
            :y1="staticPlot.padT"
            :x2="(staticPlot.padL + staticPlot.w - staticPlot.padR) / 2"
            :y2="staticPlot.h - staticPlot.padB"
            class="ci-plot-grid"
          />
          <text :x="staticPlot.padL" :y="12" class="ci-plot-lbl">F2 {{ staticPlot.f2Hi }}</text>
          <text :x="staticPlot.w - staticPlot.padR" :y="12" text-anchor="end" class="ci-plot-lbl">{{ staticPlot.f2Lo }} Hz</text>
          <text :x="staticPlot.padL - 4" :y="staticPlot.padT + 8" text-anchor="end" class="ci-plot-lbl">{{ staticPlot.f1Lo }}</text>
          <text :x="staticPlot.padL - 4" :y="staticPlot.h - staticPlot.padB" text-anchor="end" class="ci-plot-lbl">{{ staticPlot.f1Hi }}</text>
          <text :x="staticPlot.padL - 4" :y="(staticPlot.padT + staticPlot.h - staticPlot.padB) / 2 + 3" text-anchor="end" class="ci-plot-lbl">F1</text>

          <polyline :points="staticPlot.polyline" class="ci-plot-line" />

          <g
            v-for="pt in staticPlot.pts"
            :key="pt.key"
            class="ci-plot-node"
            :class="{ selected: pt.selected, playing: pt.playing }"
            @click="emit('selectCell', pt.key)"
          >
            <circle :cx="pt.x" :cy="pt.y" :r="pt.playing ? 6.2 : pt.selected ? 5.2 : 3.8" />
            <text :x="pt.x" :y="pt.y - 8" text-anchor="middle" class="ci-plot-step">{{ pt.stepA }}</text>
            <title>第 {{ pt.stepA }} 格 · F1 {{ pt.f1 }} Hz / F2 {{ pt.f2 }} Hz</title>
          </g>
        </svg>
      </div>
      <div v-else class="ci-plot-empty sci-plane muted">
        <IconSvg name="waveform" :size="15" />
        <span>{{ isDynamic ? '正在采样各格动态共振峰轨迹…' : '当前轮廓共振峰数据未就绪' }}</span>
      </div>

      <div v-if="liveMetricsReadout" class="ci-metrics-row mono">
        <span class="metric-chip">F1 {{ liveMetricsReadout.f1 || '—' }} · F2 {{ liveMetricsReadout.f2 || '—' }} Hz</span>
        <span class="metric-chip">F3 {{ liveMetricsReadout.f3 || '—' }} Hz</span>
        <span class="metric-chip">F0 {{ liveMetricsReadout.f0 }} Hz</span>
        <span v-if="liveMetricsReadout.durationMs !== null" class="metric-chip">{{ liveMetricsReadout.durationMs }} ms</span>
        <span v-if="liveMetricsReadout.pressurePa !== null" class="metric-chip">{{ liveMetricsReadout.pressurePa }} Pa</span>
      </div>
    </div>

    <div class="ci-card ci-params">
      <div class="ci-head">
        <span class="ci-title">
          <strong>主要变化构音参数</strong>
          <span class="muted">{{ isFollowingPlayback ? '实时帧' : '端点 A → 当前 → 端点 B' }}</span>
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
  grid-template-columns: minmax(250px, 1.15fr) minmax(270px, 1.3fr) minmax(200px, 0.9fr);
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
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.ci-live-badge {
  padding: 1px 6px;
  border-radius: var(--r-pill);
  font-size: 0.75rem;
  font-weight: 700;
  background: color-mix(in srgb, var(--success) 18%, var(--panel));
  color: var(--success);
  border: 1px solid color-mix(in srgb, var(--success) 55%, var(--border));
}

.ci-head-tools {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.ci-ghost-seg {
  display: inline-flex;
}

.ci-svg-box {
  height: 176px;
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
  gap: 12px;
  flex-wrap: wrap;
  font-size: 0.791667rem;
}

.ci-leg-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.ci-swatch {
  display: inline-block;
  width: 16px;
  height: 0;
  border-top-width: 2px;
}

.ci-swatch.solid {
  border-top-style: solid;
  border-top-color: var(--text);
}

.ci-swatch.ghost-a {
  border-top-style: dashed;
  border-top-color: var(--teal);
}

.ci-swatch.ghost-b {
  border-top-style: dotted;
  border-top-color: var(--warning);
}

.ci-plot-box,
.ci-plot-empty {
  height: 164px;
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

.ci-dyn-track {
  cursor: pointer;
  opacity: 0.52;
  transition: opacity var(--dur-fast) var(--ease-out-expo);
}

.ci-dyn-track:hover {
  opacity: 0.9;
}

.ci-dyn-track.active {
  opacity: 1;
}

.ci-dyn-hit {
  fill: none;
  stroke: transparent;
  stroke-width: 10;
}

.ci-dyn-line {
  fill: none;
  stroke-width: 1.5;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.ci-dyn-track.active .ci-dyn-line {
  stroke-width: 2.6;
}

.ci-dyn-start {
  fill: var(--panel);
  stroke-width: 1.5;
}

.ci-live-halo {
  fill: color-mix(in srgb, var(--success) 26%, transparent);
}

.ci-live-core {
  fill: var(--success);
  stroke: var(--panel);
  stroke-width: 1.5;
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

.ci-plot-node.playing circle {
  fill: var(--success);
  stroke: var(--panel);
  stroke-width: 1.6;
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
