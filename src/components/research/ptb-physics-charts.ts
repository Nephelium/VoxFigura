/**
 * PhoneticToolbox-Faithful Scientific Physics & Acoustic Vowel Space Chart Renderers.
 *
 * Faithfully ported from `PhoneticToolbox_v3/frontend/public/vocal-tract/`:
 * - `area-view.mjs` (`areaReadout`)
 * - `section-view.mjs` (`sectionView`)
 * - `geometry.mjs` (`lipEdges` from `upper_lip` / `lower_lip` meshes)
 * - `app.js` (`areaChart`, `spectrumChart`, `sectionChart`, `drawLipFront`, `selectArea`)
 * - `vowel-space.mjs` (`readPeaks`, `frequencyAxis`, `referenceMarks`, inverted F2/F1 vowel chart,
 *   10 s trajectory trail, cursor-anchored wheel zoom, drag pan, double-click reset)
 *
 * Adapted to VocalCut Studio Codex Light & Dark dual themes via live CSS custom properties
 * and HiDPI devicePixelRatio scaling.
 */

import type { TractParamName } from '@vocalcut/core';
import type { TractMetrics } from '@/stores/workbench';
import { getCurrentPageScale } from '@/styles/skin-registry';
import {
  VOWEL_GAUSSIAN_STOPS,
  VOWEL_ROUNDING_COLORS,
  formatVowelChartLabel,
  isRoundedVowelSymbol,
  vowelSymbolKey,
} from '@/data/ipa-vowel-measurements';
import { readRealAntiformants, readRealPeaks, readRealTransfer } from '@/data/vtl-acoustic';
import '@/styles/acoustic-charts.css';

export interface PtbMesh {
  name: string;
  ribs: number;
  points: number;
  vertices: number[];
}

export interface PtbAirwaySection {
  index?: number;
  area?: number;
  upper: Array<number | null>;
  lower: Array<number | null>;
}

export interface PtbPoseSnapshot {
  speaker?: string;
  lip_width?: number;
  section?: number;
  centerline?: Array<[number, number, number, number?, number?]>;
  tube_lengths?: number[];
  tube_areas?: number[];
  raw_areas?: number[];
  planar?: { gap?: number[] } | null;
  airway_sections?: PtbAirwaySection[];
  frequency?: number[];
  transfer_db?: number[];
  resonances?: number[];
  resonance_peaks_hz?: number[];
  antiformants?: Array<{ f_hz: number; db: number } | number>;
  antiformants_hz?: number[];
  nasal?: { port_area?: number; port_area_cm2?: number };
  nasal_coupled?: boolean;
  nasal_port_area_cm2?: number;
  oral_min_area?: number;
  meshes?: PtbMesh[];
}

/** Nasal coupling requires `nasal_coupled === true` (i.e. velopharyngeal port >= 0.08 cm², T-27). */
export function isSnapshotNasalCoupled(
  snapshot: PtbPoseSnapshot | null | undefined,
  fallbackPortAreaCm2?: number,
): boolean {
  if (typeof snapshot?.nasal_coupled === 'boolean') {
    return snapshot.nasal_coupled;
  }
  const port =
    snapshot?.nasal_port_area_cm2 ??
    snapshot?.nasal?.port_area ??
    snapshot?.nasal?.port_area_cm2 ??
    fallbackPortAreaCm2 ??
    0;
  return Number.isFinite(port) && port >= 0.08;
}

export interface PtbAreaReadoutPoint {
  index: number;
  position: number;
  geometric: number;
  acoustic: number;
  closed: boolean;
  midlineClosed: boolean;
}

export interface PtbAreaReadoutSummary {
  readouts: PtbAreaReadoutPoint[];
  selected: PtbAreaReadoutPoint | null;
  selectedIdx: number;
  totalLengthCm: number;
  maxArea: number;
  aminCm2: number;
  aminPosCm: number;
  aminIdx: number;
  portAreaCm2: number;
}

export interface PtbLipFrontData {
  aperturePath: string;
  outerPath: string;
  viewBox: string;
  cornerZ: number;
  nasalOpen: boolean;
  portAreaCm2: number;
  isRealMesh: boolean;
}

export interface VowelAxisSpec {
  min: number;
  max: number;
  step: number;
}

export interface VowelSpaceAxes {
  f1: VowelAxisSpec;
  f2: VowelAxisSpec;
}

export type VowelCoordinateScale = 'linear' | 'logarithmic';

export interface VowelReferencePoint {
  symbol: string;
  name?: string;
  source: 'recorded' | 'transfer' | 'pose';
  f1: number;
  f2: number;
  nasal?: boolean;
}

export interface VowelTrailPoint {
  f1: number;
  f2: number;
  nasal?: boolean;
  time: number;
  breakAfter?: boolean;
}

export interface VowelSpaceRenderOptions {
  references: VowelReferencePoint[];
  current: { f1: number; f2: number; nasal?: boolean } | null;
  history: VowelTrailPoint[];
  manualAxes?: VowelSpaceAxes | null;
  scale?: VowelCoordinateScale;
  fontScale?: number;
  now?: number;
}

export interface VowelSpaceLayout {
  axes: VowelSpaceAxes;
  scale: VowelCoordinateScale;
  pad: { l: number; r: number; t: number; b: number };
  w: number;
  h: number;
  plotW: number;
  plotH: number;
  currentInView: boolean;
  marks: { x: number; y: number; point: VowelReferencePoint }[];
}

interface ChartTheme {
  isDark: boolean;
  panel: string;
  text: string;
  muted: string;
  border: string;
  grid: string;
  accent: string;
  teal: string;
  tealFill: string;
  wall: string;
  tongue: string;
  tongueStroke: string;
  danger: string;
  warning: string;
  lineWidth: number;
}

function readChartTheme(): ChartTheme {
  if (typeof window === 'undefined') {
    return {
      isDark: false,
      panel: '#ffffff',
      text: '#202020',
      muted: '#69776f',
      border: '#d6dce2',
      grid: 'rgba(130, 145, 140, 0.25)',
      accent: '#0969da',
      teal: '#297c6b',
      tealFill: 'rgba(57, 135, 121, 0.16)',
      wall: '#b48774',
      tongue: 'rgba(207, 127, 134, 0.34)',
      tongueStroke: '#b17869',
      danger: '#cf222e',
      warning: '#9a6700',
      lineWidth: 1.5,
    };
  }
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const read = (k: string, fb: string) => cs.getPropertyValue(k).trim() || fb;
  const isDark = root.getAttribute('data-mode') === 'dark' || root.getAttribute('data-theme') === 'dark';
  const teal = read('--chart-series', isDark ? '#5eead4' : '#297c6b');
  return {
    isDark,
    panel: read('--chart-panel', isDark ? '#181b22' : '#fffef9'),
    text: read('--text', isDark ? '#e6edf7' : '#202020'),
    muted: read('--muted', isDark ? '#9aa5b6' : '#6e7781'),
    border: read('--chart-outline', isDark ? '#323846' : '#d6dce2'),
    grid: read('--chart-grid', 'rgba(148, 163, 184, 0.28)'),
    accent: read('--chart-peer', isDark ? '#79aaff' : '#0969da'),
    teal,
    tealFill: read('--chart-fill', 'rgba(57, 135, 121, 0.15)'),
    wall: read('--anatomy-wall', isDark ? '#d9a48f' : '#b48774'),
    tongue: read('--tract-tongue', isDark ? 'rgba(246, 185, 190, 0.28)' : 'rgba(214, 126, 124, 0.32)'),
    tongueStroke: read('--tract-tongue-stroke', isDark ? '#f0a6ae' : '#b17869'),
    danger: read('--danger', isDark ? '#f87171' : '#cf222e'),
    warning: read('--warning', isDark ? '#fbbf24' : '#9a6700'),
    lineWidth: Number(read('--chart-line', '1.65')) || 1.65,
  };
}

function setupCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const scale = getCurrentPageScale();
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(72, Math.round(canvas.clientWidth || rect.width / scale || 200));
  const h = Math.max(60, Math.round(canvas.clientHeight || rect.height / scale || 110));
  const dpr = Math.min(2.25, window.devicePixelRatio || 1);
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

const AXIS_LEFT = 29;
const AXIS_RIGHT = 9;

function drawGridFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  xmax: number,
  ymin: number,
  ymax: number,
  theme: ChartTheme,
  xlabel?: (v: number) => string,
  ylabel?: string,
  fontScale = 1,
): { x: (v: number) => number; y: (v: number) => number; pad: { l: number; r: number; t: number; b: number } } {
  const pad = { l: AXIS_LEFT, r: AXIS_RIGHT, t: ylabel ? 15 : 8, b: 17 };
  const plotW = Math.max(20, w - pad.l - pad.r);
  const plotH = Math.max(20, h - pad.t - pad.b);
  const x = (v: number) => pad.l + (Math.max(0, Math.min(xmax, v)) / Math.max(1e-6, xmax)) * plotW;
  const y = (v: number) => h - pad.b - ((v - ymin) / Math.max(1e-6, ymax - ymin)) * plotH;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = theme.panel;
  ctx.fillRect(pad.l, pad.t, plotW, plotH);
  ctx.font = monoFont(500, 9, fontScale);
  ctx.fillStyle = theme.muted;
  if (ylabel) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(ylabel, 4, 1);
  }
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 0.8;

  for (let i = 0; i < 3; i++) {
    const v = ymin + ((ymax - ymin) * i) / 2;
    const py = y(v);
    ctx.beginPath();
    ctx.moveTo(pad.l, py);
    ctx.lineTo(w - pad.r, py);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.round(v)), pad.l - 3, py);
  }

  ctx.textBaseline = 'alphabetic';
  for (let i = 0; i < 3; i++) {
    const v = (xmax * i) / 2;
    ctx.save();
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x(v), pad.t);
    ctx.lineTo(x(v), h - pad.b);
    ctx.stroke();
    ctx.restore();
    ctx.textAlign = i === 2 ? 'right' : i === 0 ? 'left' : 'center';
    ctx.fillText(xlabel ? xlabel(v) : v.toFixed(0), x(v), h - 3);
  }
  ctx.textAlign = 'left';
  return { x, y, pad };
}

const monoFont = (weight: number, size: number, scale: number) =>
  `${weight} ${size * scale}px "JetBrains Mono", Consolas, monospace`;

function drawUnavailable(ctx: CanvasRenderingContext2D, w: number, h: number, label: string, theme: Pick<ChartTheme, 'muted'>, fontScale: number) {
  ctx.font = `500 ${11 * fontScale}px system-ui, sans-serif`;
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, w / 2, h / 2, Math.max(40, w - 16));
}

// ===========================================================================
// 1. Area Function Readout & Interactive Section Cursor (PTB area-view.mjs)
// ===========================================================================

type AreaGeometry = Omit<PtbAreaReadoutSummary,'selected'|'selectedIdx'>;
const previousAreaGeometry = new WeakMap<PtbPoseSnapshot,AreaGeometry>();

export function computeAreaReadouts(
  snapshot: PtbPoseSnapshot | null | undefined,
  sectionIdx?: number,
): PtbAreaReadoutSummary | null {
  if (!snapshot?.centerline?.length || !snapshot.tube_lengths?.length || !snapshot.tube_areas?.length) {
    return null;
  }
  let geometry=previousAreaGeometry.get(snapshot);
  if (!geometry) {
    geometry=computeAreaGeometry(snapshot,snapshot.centerline,snapshot.tube_lengths,snapshot.tube_areas);
    previousAreaGeometry.set(snapshot,geometry);
  }
  const points=geometry.readouts;
  const rawIdx=typeof sectionIdx==='number'&&Number.isFinite(sectionIdx) ? sectionIdx : snapshot.section??Math.floor(points.length*.55);
  const selectedIdx=Math.max(0,Math.min(points.length-1,Math.round(rawIdx)));
  return { ...geometry,selected:points[selectedIdx]??null,selectedIdx };
}

function computeAreaGeometry(snapshot:PtbPoseSnapshot,cl:NonNullable<PtbPoseSnapshot['centerline']>,lengths:number[],areas:number[]):AreaGeometry {
  const totalLengthCm = lengths.reduce((a, b) => a + b, 0) || 17;

  const readouts: PtbAreaReadoutPoint[] = cl.map((c, idx) => {
    const position = c[2];
    let end = 0;
    let acoustic = areas[areas.length - 1] ?? 0;
    for (let i = 0; i < lengths.length; i++) {
      end += lengths[i];
      if (position <= end + 1e-8) {
        acoustic = areas[i];
        break;
      }
    }
    if (snapshot.planar && Array.isArray(snapshot.raw_areas)) {
      const geometric = snapshot.raw_areas[idx] ?? 0;
      const midGap = snapshot.planar.gap?.[idx] ?? geometric;
      return {
        index: idx,
        position,
        geometric,
        acoustic,
        closed: geometric <= 1e-6,
        midlineClosed: midGap <= 1e-6,
      };
    }
    const sec = snapshot.airway_sections?.[idx];
    if (sec && Array.isArray(sec.upper) && Array.isArray(sec.lower)) {
      const gap = sec.upper.map((u, j) => {
        const l = sec.lower[j];
        return u === null || l === null ? 0 : Math.max(0, u - l);
      });
      const geometric =
        typeof sec.area === 'number' && Number.isFinite(sec.area)
          ? sec.area
          : gap.slice(1).reduce((sum, v, j) => sum + ((v + gap[j]) * 0.5 * 7) / 96, 0);
      return {
        index: idx,
        position,
        geometric,
        acoustic,
        closed: !gap.some((v) => v > 1e-6),
        midlineClosed: (gap[48] ?? 0) <= 1e-6,
      };
    }
    return {
      index: idx,
      position,
      geometric: acoustic,
      acoustic,
      closed: acoustic <= 1e-6,
      midlineClosed: acoustic <= 1e-6,
    };
  });

  let aminIdx = 0;
  let aminCm2 = Infinity;
  for (let i = 0; i < readouts.length; i++) {
    const a = readouts[i].closed ? 0 : readouts[i].geometric;
    if (a < aminCm2) {
      aminCm2 = a;
      aminIdx = i;
    }
  }
  if (!Number.isFinite(aminCm2)) aminCm2 = 0;

  const maxRaw = Math.max(
    ...areas,
    ...readouts.map((r) => r.geometric),
  );
  const maxArea = Math.max(8, Math.ceil(maxRaw / 4) * 4);

  return {
    readouts,
    totalLengthCm,
    maxArea,
    aminCm2,
    aminPosCm: readouts[aminIdx]?.position ?? 0,
    aminIdx,
    portAreaCm2: snapshot.nasal?.port_area ?? 0,
  };
}

export function clientXToSectionIndex(
  snapshot: PtbPoseSnapshot | null | undefined,
  canvasCssWidth: number,
  localCssX: number,
): number {
  if (!snapshot?.centerline?.length || !snapshot.tube_lengths?.length) return 0;
  const total = snapshot.tube_lengths.reduce((a, b) => a + b, 0) || 17;
  const frac = Math.max(0, Math.min(1, (localCssX - AXIS_LEFT) / Math.max(10, canvasCssWidth - AXIS_LEFT - AXIS_RIGHT)));
  const targetCm = frac * total;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < snapshot.centerline.length; i++) {
    const d = Math.abs(snapshot.centerline[i][2] - targetCm);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

// ===========================================================================
// 2. A(x) Area Function Chart (PTB areaChart)
// ===========================================================================

export function drawPtbAreaChart(
  canvas: HTMLCanvasElement | null,
  snapshot: PtbPoseSnapshot | null | undefined,
  sectionIdx: number,
  fallbackMetrics?: TractMetrics,
  fontScale = 1,
): PtbAreaReadoutSummary | null {
  if (!canvas) return null;
  const setup = setupCanvas(canvas);
  if (!setup) return null;
  const { ctx, w, h } = setup;
  const theme = readChartTheme();

  const summary = computeAreaReadouts(snapshot, sectionIdx);
  if (summary && snapshot?.tube_areas?.length && snapshot.tube_lengths?.length) {
    const { readouts, selected, totalLengthCm, maxArea } = summary;
    const { x, y } = drawGridFrame(ctx, w, h, totalLengthCm, 0, maxArea, theme, v => `${v.toFixed(1)} cm`, 'cm²', fontScale);

    // Geometric area filled solid polygon
    ctx.beginPath();
    ctx.moveTo(x(0), y(0));
    for (const a of readouts) {
      ctx.lineTo(x(a.position), y(a.closed ? 0 : a.geometric));
    }
    ctx.lineTo(x(totalLengthCm), y(0));
    ctx.closePath();
    ctx.fillStyle = theme.tealFill;
    ctx.fill();
    ctx.strokeStyle = theme.teal;
    ctx.lineWidth = theme.lineWidth;
    ctx.stroke();

    // Acoustically corrected synthesis tube (dashed step curve)
    ctx.beginPath();
    ctx.setLineDash([3, 3]);
    let pos = 0;
    snapshot.tube_areas.forEach((area, i) => {
      const val = area <= 0.00011 ? 0 : area;
      if (i) ctx.lineTo(x(pos), y(val));
      else ctx.moveTo(x(pos), y(val));
      pos += snapshot.tube_lengths![i] ?? 0;
      ctx.lineTo(x(pos), y(val));
    });
    ctx.strokeStyle = theme.wall;
    ctx.lineWidth = 1.15;
    ctx.stroke();

    // Selected section vertical cursor line + dot
    if (selected) {
      const sx = x(selected.position);
      ctx.beginPath();
      ctx.setLineDash([2, 2]);
      ctx.moveTo(sx, y(0));
      ctx.lineTo(sx, y(maxArea));
      ctx.strokeStyle = theme.muted;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.arc(sx, y(selected.closed ? 0 : selected.geometric), 3.0, 0, Math.PI * 2);
      ctx.fillStyle = selected.closed ? theme.danger : theme.teal;
      ctx.fill();
      ctx.strokeStyle = theme.panel;
      ctx.lineWidth = 1.1;
      ctx.stroke();
    }
    return summary;
  }

  if (!fallbackMetrics) {
    ctx.clearRect(0, 0, w, h);
    drawUnavailable(ctx, w, h, '暂无声道面积数据', theme, fontScale);
    return null;
  }
  // Precomputed reference track retains the native tube areas.
  const pts = fallbackMetrics.area_fn;
  const maxA = Math.max(4.5, Math.ceil(Math.max(4, ...pts.map((p) => p.area_cm2))));
  const { x, y } = drawGridFrame(ctx, w, h, Math.max(1, pts.at(-1)?.x_cm ?? 17), 0, maxA, theme,
    v => `${v.toFixed(1)} cm`, 'cm²', fontScale);
  if (pts.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(x(pts[0].x_cm), y(0));
    for (const p of pts) ctx.lineTo(x(p.x_cm), y(p.area_cm2));
    ctx.lineTo(x(pts[pts.length - 1].x_cm), y(0));
    ctx.closePath();
    ctx.fillStyle = theme.tealFill;
    ctx.fill();
    ctx.strokeStyle = theme.teal;
    ctx.lineWidth = theme.lineWidth;
    ctx.stroke();

    const sx = x(fallbackMetrics.amin_x_cm);
    ctx.beginPath();
    ctx.setLineDash([2, 2]);
    ctx.moveTo(sx, y(0));
    ctx.lineTo(sx, y(maxA));
    ctx.strokeStyle = fallbackMetrics.amin_cm2 < 0.16 ? theme.danger : theme.warning;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(sx, y(fallbackMetrics.amin_cm2), 3, 0, Math.PI * 2);
    ctx.fillStyle = fallbackMetrics.amin_cm2 < 0.16 ? theme.danger : theme.warning;
    ctx.fill();
  }
  return null;
}

// ===========================================================================
// 3. H(f) Vocal Tract Transfer Function Chart (PTB spectrumChart)
// ===========================================================================

export function drawPtbSpectrumChart(
  canvas: HTMLCanvasElement | null,
  snapshot: PtbPoseSnapshot | null | undefined,
  maxFreqHz: number,
  antiformantsInput?: ReadonlyArray<{ f_hz: number; db: number }>,
  nasalCoupledOverride?: boolean,
  fontScale = 1,
): { prefix: 'F' | 'P'; peaks: number[]; zeros: number[] } {
  const nasalOpen = nasalCoupledOverride ?? isSnapshotNasalCoupled(snapshot);
  const prefix: 'F' | 'P' = nasalOpen ? 'P' : 'F';
  const raw = snapshot as Record<string, unknown> | null;
  const rawPeaks = raw ? readRealPeaks(raw) : [];
  const peaks = rawPeaks.filter(hz => Number.isFinite(hz) && hz > 0 && hz <= maxFreqHz);
  const points = raw ? readRealTransfer(raw, maxFreqHz) : [];
  const rawZeros =
    antiformantsInput && antiformantsInput.length > 0
      ? antiformantsInput
      : raw
        ? readRealAntiformants(raw, points, nasalOpen)
        : [];
  const zerosList = rawZeros.filter(z => Number.isFinite(z.f_hz) && z.f_hz > 0 && z.f_hz <= maxFreqHz);
  const zeros = zerosList.map(z => Math.round(z.f_hz));

  if (!canvas) return { prefix, peaks, zeros };
  const setup = setupCanvas(canvas);
  if (!setup) return { prefix, peaks, zeros };
  const { ctx, w, h } = setup;
  const theme = readChartTheme();
  if (!points.length) {
    ctx.clearRect(0, 0, w, h);
    drawUnavailable(ctx, w, h, '暂无传递函数数据', theme, fontScale);
    return { prefix, peaks: [], zeros: [] };
  }
  const db = points.map(p => p.db);
  const ymax = Math.ceil(Math.max(0, ...db) / 10) * 10;
  const ymin = Math.min(ymax - 10, Math.floor(Math.min(0, ...db) / 10) * 10);
  const { x, y, pad } = drawGridFrame(ctx, w, h, maxFreqHz, ymin, ymax, theme, value =>
    value >= 1000 ? `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k` : '0 Hz', 'dB', fontScale,
  );

  if (points.length > 1) {
    const line = new Path2D();
    points.forEach((p, index) => {
      if (index) line.lineTo(x(p.f_hz), y(p.db));
      else line.moveTo(x(p.f_hz), y(p.db));
    });
    const fill = new Path2D(line);
    fill.lineTo(x(points.at(-1)!.f_hz), y(ymin));
    fill.lineTo(x(points[0].f_hz), y(ymin));
    fill.closePath();
    const fade = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
    fade.addColorStop(0, theme.tealFill);
    fade.addColorStop(1, 'transparent');
    ctx.fillStyle = fade;
    ctx.fill(fill);
    ctx.strokeStyle = theme.teal;
    ctx.lineWidth = theme.lineWidth;
    ctx.lineJoin = 'round';
    ctx.stroke(line);
  }

  // Antiformant zeros (Z1, Z2...): prominent dashed vertical marker + inverted triangle + frequency badge (T-27)
  const zeroColor = theme.danger;
  const zeroOccupied = [0, 0];
  zerosList.forEach((zero, i) => {
    const zx = x(zero.f_hz);
    const zyRaw = y(zero.db);
    const zy = Math.max(pad.t + 8, Math.min(h - pad.b - 4, zyRaw));

    ctx.save();
    ctx.setLineDash([3, 2.5]);
    ctx.strokeStyle = zeroColor;
    ctx.globalAlpha = 0.78;
    ctx.lineWidth = 1.05;
    ctx.beginPath();
    ctx.moveTo(zx, pad.t);
    ctx.lineTo(zx, h - pad.b);
    ctx.stroke();
    ctx.restore();

    // Inverted triangle pointing down into the spectral zero valley
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(zx, zy + 2.5);
    ctx.lineTo(zx - 3.8, zy - 4.2);
    ctx.lineTo(zx + 3.8, zy - 4.2);
    ctx.closePath();
    ctx.fillStyle = zeroColor;
    ctx.fill();
    ctx.strokeStyle = theme.panel;
    ctx.lineWidth = 0.9;
    ctx.stroke();
    ctx.restore();

    const text = `Z${i + 1}`;
    ctx.font = monoFont(700, 8.2, fontScale);
    const badgeW = ctx.measureText(text).width + 7;
    const bx = Math.max(pad.l + 1, Math.min(w - pad.r - badgeW, zx - badgeW * 0.5));
    const row = zeroOccupied.findIndex(right => right < bx);
    if (row < 0) return;
    zeroOccupied[row] = bx + badgeW + 3;
    const by = Math.max(pad.t + 14, h - pad.b - 13 - row * 12);
    ctx.fillStyle = theme.panel;
    ctx.strokeStyle = zeroColor;
    ctx.lineWidth = 0.95;
    ctx.beginPath();
    ctx.roundRect(bx, by, badgeW, 11, 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = zeroColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + badgeW / 2, by + 5.8);
  });

  const labelColor = nasalOpen ? theme.warning : theme.accent;
  const occupied = [0, 0, 0];
  peaks.forEach((hz, i) => {
    const fx = x(hz);
    ctx.save();
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = labelColor;
    ctx.globalAlpha = .68;
    ctx.lineWidth = .9;
    ctx.beginPath();
    ctx.moveTo(fx, pad.t);
    ctx.lineTo(fx, h - pad.b);
    ctx.stroke();
    ctx.restore();

    const text = `${prefix}${i + 1}`;
    ctx.font = monoFont(700, 8.5, fontScale);
    const width = ctx.measureText(text).width + 7;
    const bx = Math.max(pad.l + 1, Math.min(w - pad.r - width, fx - width * 0.5));
    const row = occupied.findIndex(right => right < bx);
    if (row < 0) return;
    occupied[row] = bx + width + 3;
    const by = pad.t + 2 + row * 12;
    ctx.fillStyle = theme.panel;
    ctx.strokeStyle = labelColor;
    ctx.beginPath();
    ctx.roundRect(bx, by, width, 11, 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = labelColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + width / 2, by + 6);
  });

  return { prefix, peaks, zeros };
}

// ===========================================================================
// 4. Cross-Section (PTB section-view.mjs) & Real Frontal Lip Contour (geometry.mjs)
// ===========================================================================

export function sectionView(width: number, height: number): {
  scale: number;
  centerX: number;
  centerY: number;
  x: (index: number) => number;
  y: (value: number) => number;
} {
  const top = 10;
  const bottom = 22;
  const scale = Math.max(0, Math.min(width - 20, height - top - bottom) / 7);
  const centerX = width / 2;
  const centerY = (height + top - bottom) / 2;
  return {
    scale,
    centerX,
    centerY,
    x: (index: number) => centerX + ((index * 7) / 96 - 3.5) * scale,
    y: (value: number) => centerY - value * scale,
  };
}

export function drawPtbSectionChart(
  canvas: HTMLCanvasElement | null,
  snapshot: PtbPoseSnapshot | null | undefined,
  sectionIdx: number,
  fontScale = 1,
): { open: boolean; areaCm2: number; midlineClosed: boolean; available: boolean } {
  const unavailable = { open: false, areaCm2: 0, midlineClosed: false, available: false };
  if (!canvas) return unavailable;
  const setup = setupCanvas(canvas);
  if (!setup) return unavailable;
  const { ctx, w, h } = setup;
  ctx.clearRect(0, 0, w, h);
  return paintPtbSectionChart(ctx, w, h, snapshot, sectionIdx, fontScale, readChartTheme());
}

export function paintPtbSectionChart(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  snapshot: PtbPoseSnapshot | null | undefined,
  sectionIdx: number,
  fontScale: number,
  theme: Pick<ChartTheme, 'grid' | 'muted' | 'teal' | 'tealFill' | 'danger'>,
): { open: boolean; areaCm2: number; midlineClosed: boolean; available: boolean } {
  const { scale, centerX, centerY, x, y } = sectionView(w, h);

  // Midline vertical reference line
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(centerX, 4);
  ctx.lineTo(centerX, h - 16);
  ctx.stroke();

  const sections = snapshot?.airway_sections;
  const sec = sections?.length
    ? sections[Math.max(0, Math.min(sections.length - 1, Math.round(sectionIdx)))]
    : null;

  let open = false;
  if (!sec || !Array.isArray(sec.upper) || !Array.isArray(sec.lower) || sec.upper.length < 2 || sec.lower.length < 2 || scale <= 0) {
    drawUnavailable(ctx, w, h, '暂无该截面', theme, fontScale);
    return { open: false, areaCm2: 0, midlineClosed: false, available: false };
  }
  let areaCm2 = 0;
  let midlineClosed = false;

  const N = Math.min(96, sec.upper.length, sec.lower.length);
  let i = 0;
  let sumArea = 0;
  while (i < N) {
    while (i < N && (sec.upper[i] === null || sec.lower[i] === null)) i++;
    const start = i;
    while (i < N && sec.upper[i] !== null && sec.lower[i] !== null) i++;
    const end = i;
    if (end <= start) continue;

    ctx.beginPath();
    for (let j = start; j < end; j++) {
      const u = sec.upper[j]!;
      const l = sec.lower[j]!;
      if (u - l > 1e-6) open = true;
      if (j > start) {
        const prevGap = Math.max(0, (sec.upper[j - 1] ?? 0) - (sec.lower[j - 1] ?? 0));
        const curGap = Math.max(0, u - l);
        sumArea += ((prevGap + curGap) * 0.5 * 7) / 96;
      }
      if (j === start) ctx.moveTo(x(j), y(u));
      else ctx.lineTo(x(j), y(u));
    }
    for (let j = end - 1; j >= start; j--) {
      ctx.lineTo(x(j), y(sec.lower[j]!));
    }
    ctx.closePath();
    ctx.fillStyle = theme.tealFill;
    ctx.fill();
    ctx.strokeStyle = theme.teal;
    ctx.lineWidth = 1.3;
    ctx.stroke();
  }
  areaCm2 = typeof sec.area === 'number' && Number.isFinite(sec.area) ? sec.area : sumArea;
  const midU = sec.upper[48];
  const midL = sec.lower[48];
  midlineClosed = midU === null || midL === null || midU - midL <= 1e-6;

  if (!open) {
    ctx.fillStyle = theme.danger;
    ctx.font = `600 ${9 * fontScale}px "Segoe UI", "PingFang SC", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('气道闭塞 0 cm²', centerX, centerY);
  }

  // Bottom-left 1 cm physical calibration bar (exact PTB style)
  if (scale > 4) {
    ctx.strokeStyle = theme.muted;
    ctx.fillStyle = theme.muted;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(6, h - 8);
    ctx.lineTo(6 + scale, h - 8);
    ctx.moveTo(6, h - 10.5);
    ctx.lineTo(6, h - 5.5);
    ctx.moveTo(6 + scale, h - 10.5);
    ctx.lineTo(6 + scale, h - 5.5);
    ctx.stroke();
    ctx.font = monoFont(500, 8.5, fontScale);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('1 cm', 10 + scale, h - 7.5);
  }

  return { open, areaCm2, midlineClosed, available: true };
}

function meshPoint(mesh: PtbMesh, idx: number): [number, number, number] {
  const o = idx * 3;
  return [mesh.vertices[o] ?? 0, mesh.vertices[o + 1] ?? 0, mesh.vertices[o + 2] ?? 0];
}

export function buildPtbLipFrontData(
  snapshot: PtbPoseSnapshot | null | undefined,
  fallbackTract: Record<TractParamName, number>,
): PtbLipFrontData {
  const portAreaCm2 =
    snapshot?.nasal_port_area_cm2 ??
    snapshot?.nasal?.port_area ??
    snapshot?.nasal?.port_area_cm2 ??
    Math.max(0, fallbackTract.VO) * 0.85;
  const nasalOpen = isSnapshotNasalCoupled(snapshot, portAreaCm2);
  const upper = snapshot?.meshes?.find((m) => m.name === 'upper_lip');
  const lower = snapshot?.meshes?.find((m) => m.name === 'lower_lip');

  if (upper && lower && upper.ribs >= 3 && lower.ribs >= 3 && upper.points >= 5 && lower.points >= 5) {
    const ribs = Math.min(upper.ribs, lower.ribs);
    const upEdges: Array<[number, number, number]> = [];
    const loEdges: Array<[number, number, number]> = [];
    for (let r = 0; r < ribs; r++) {
      const a = meshPoint(upper, r * upper.points + 4);
      const b = meshPoint(lower, r * lower.points + 4);
      const seam = (a[1] + b[1]) * 0.5;
      const z = (a[2] + b[2]) * 0.5;
      upEdges.push([a[0], Math.max(a[1], seam), z]);
      loEdges.push([b[0], Math.min(b[1], seam), z]);
    }
    upEdges.sort((p, q) => p[2] - q[2]);
    loEdges.sort((p, q) => p[2] - q[2]);

    const maxUpY = Math.max(...upEdges.map((p) => p[1]));
    const minLoY = Math.min(...loEdges.map((p) => p[1]));
    const cy = (maxUpY + minLoY) * 0.5;
    const pts = [...upEdges, ...[...loEdges].reverse()];
    const cornerZ = Math.max(0.8, ...pts.map((p) => Math.abs(p[2])));
    const maxAbsY = Math.max(0.45, ...pts.map((p) => Math.abs(cy - p[1])));

    const aperturePath =
      'M' + pts.map((p) => `${p[2].toFixed(3)},${(cy - p[1]).toFixed(3)}`).join('L') + 'Z';

    // Subtle outer vermilion halo derived cleanly around real aperture silhouette
    const outerUp = upEdges.map((p) => {
      const taper = Math.sqrt(Math.max(0, 1 - Math.pow(p[2] / Math.max(cornerZ, 0.01), 2)));
      return `${(p[2] * 1.12).toFixed(3)},${(cy - p[1] - 0.34 * taper - 0.06).toFixed(3)}`;
    });
    const outerLo = [...loEdges].reverse().map((p) => {
      const taper = Math.sqrt(Math.max(0, 1 - Math.pow(p[2] / Math.max(cornerZ, 0.01), 2)));
      return `${(p[2] * 1.12).toFixed(3)},${(cy - p[1] + 0.38 * taper + 0.06).toFixed(3)}`;
    });
    const outerPath = `M${[...outerUp, ...outerLo].join('L')}Z`;

    const halfW = Math.max(2.6, cornerZ * 1.38);
    const halfH = Math.max(1.55, maxAbsY + 0.72);
    return {
      aperturePath,
      outerPath,
      viewBox: `${(-halfW).toFixed(2)} ${(-halfH).toFixed(2)} ${(halfW * 2).toFixed(2)} ${(halfH * 2).toFixed(2)}`,
      cornerZ,
      nasalOpen,
      portAreaCm2,
      isRealMesh: true,
    };
  }

  // Offline parametric lip silhouette
  const round = Math.max(0, Math.min(1, (fallbackTract.LP + 1) / 2));
  const rx = Math.max(0.65, 2.05 - round * 1.05);
  const ry = Math.max(0.08, 0.16 + Math.max(0, fallbackTract.LD + 0.35) * 0.42);
  const aperturePath = `M ${(-rx).toFixed(2)},0 Q 0,${(-ry * 1.35).toFixed(2)} ${rx.toFixed(2)},0 Q 0,${(ry * 1.35).toFixed(2)} ${(-rx).toFixed(2)},0 Z`;
  const orx = rx * 1.18 + 0.15;
  const ory = ry + 0.42;
  const outerPath = `M ${(-orx).toFixed(2)},0 Q 0,${(-ory * 1.35).toFixed(2)} ${orx.toFixed(2)},0 Q 0,${(ory * 1.35).toFixed(2)} ${(-orx).toFixed(2)},0 Z`;
  return {
    aperturePath,
    outerPath,
    viewBox: '-2.80 -1.65 5.60 3.30',
    cornerZ: rx,
    nasalOpen,
    portAreaCm2,
    isRealMesh: false,
  };
}

// ===========================================================================
// 5. Acoustic Vowel Space F1–F2 Chart (PTB vowel-space.mjs)
//    Inverted F2 (left=high front, right=low back) & downward F1 (top=close, bottom=open)
// ===========================================================================

export function readPeaks(values: unknown): { f1: number; f2: number } | null {
  if (!Array.isArray(values)) return null;
  const [f1, f2] = values;
  return typeof f1 === 'number' && typeof f2 === 'number' && Number.isFinite(f1) && Number.isFinite(f2) && f1 > 0 && f2 > f1
    ? { f1, f2 }
    : null;
}

export function frequencyAxis(values: number[], kind: 'f1' | 'f2'): VowelAxisSpec {
  const isF1 = kind === 'f1';
  if (!values.length) {
    return isF1 ? { min: 200, max: 1000, step: 200 } : { min: 600, max: 2800, step: 500 };
  }
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = Math.max(high - low, isF1 ? 180 : 450);
  const mid = (low + high) / 2;
  const target = (span * 1.16) / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(1, target))));
  const step = magnitude * ([1, 2, 2.5, 5, 10].find((f) => f >= target / magnitude) ?? 10);
  const marginStep = step / 4;
  const min = Math.max(Math.min(low, marginStep), Math.floor((mid - span * 0.58) / marginStep) * marginStep);
  let max = Math.ceil((mid + span * 0.58) / marginStep) * marginStep;
  if (!isF1 && high < 4000 && max >= 4000) max = Math.max(high, 4000 - marginStep);
  if (isF1 && high <= 2000) max = Math.min(2000, max);
  return { min, max, step };
}

export function vowelViewRange(span: number, min: number): VowelAxisSpec {
  const low = Math.max(0, min);
  const target = span / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(1, target))));
  const step = magnitude * ([1, 2, 2.5, 5, 10].find((f) => f >= target / magnitude) ?? 10);
  return { min: low, max: low + span, step };
}

const VOWEL_LOG_LIMIT = Math.log(12000); // The displayed domain stays between 1 and 12000 Hz.

function logVowelViewRange(span: number, low: number): VowelAxisSpec {
  const start = Math.max(0, Math.min(VOWEL_LOG_LIMIT - span, low));
  const min = Math.exp(start);
  return vowelViewRange(Math.exp(start + span) - min, min);
}

export function zoomVowelSpaceAxes(
  axes: VowelSpaceAxes,
  anchorF1: number,
  anchorF2: number,
  deltaY: number,
  coordinateScale: VowelCoordinateScale = 'linear',
): VowelSpaceAxes {
  const scale = Math.exp(Math.max(-0.85, Math.min(0.85, deltaY * 0.0018)));
  const zoom = (axis: VowelAxisSpec, anchor: number) => {
    if (coordinateScale === 'logarithmic') {
      const low = Math.log(Math.max(1, axis.min));
      const span = Math.log(axis.max) - low;
      const newSpan = Math.max(Math.log(1.05), Math.min(VOWEL_LOG_LIMIT, span * scale));
      return logVowelViewRange(newSpan, low + (span - newSpan) * anchor);
    }
    const span = axis.max - axis.min;
    const newSpan = Math.max(60, Math.min(12000, span * scale));
    return vowelViewRange(newSpan, axis.min + (span - newSpan) * anchor);
  };
  return {
    f1: zoom(axes.f1, Math.max(0, Math.min(1, anchorF1))),
    f2: zoom(axes.f2, Math.max(0, Math.min(1, anchorF2))),
  };
}

export function panVowelSpaceAxes(
  axes: VowelSpaceAxes,
  dxPx: number,
  dyPx: number,
  plotW: number,
  plotH: number,
  coordinateScale: VowelCoordinateScale = 'linear',
): VowelSpaceAxes {
  const pan = (axis: VowelAxisSpec, shift: number) => {
    if (coordinateScale === 'logarithmic') {
      const low = Math.log(Math.max(1, axis.min));
      const span = Math.log(axis.max) - low;
      return logVowelViewRange(span, low + shift * span);
    }
    const span = axis.max - axis.min;
    return vowelViewRange(span, axis.min + shift * span);
  };
  return {
    f1: pan(axes.f1, -dyPx / Math.max(20, plotH)),
    f2: pan(axes.f2, dxPx / Math.max(20, plotW)),
  };
}

export function vowelAxisFraction(axis: Pick<VowelAxisSpec, 'min' | 'max'>, scale: VowelCoordinateScale): (hz: number) => number {
  if (scale === 'logarithmic') {
    const low = Math.log(axis.min);
    const span = Math.log(axis.max) - low;
    return hz => (Math.log(hz) - low) / span;
  }
  return hz => (hz - axis.min) / Math.max(1e-6, axis.max - axis.min);
}

export function vowelAxisTicks(axis: VowelAxisSpec, scale: VowelCoordinateScale, pixels: number, spacing: number): number[] {
  const ticks: number[] = [];
  if (scale === 'linear') {
    for (let hz = Math.ceil(axis.min / axis.step) * axis.step; hz <= axis.max + 1e-6; hz += axis.step) {
      ticks.push(hz);
    }
    return ticks;
  }
  const fraction = vowelAxisFraction(axis, scale);
  const multipliers = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8];
  let last = -Infinity;
  for (let decade = Math.floor(Math.log10(axis.min)); decade <= Math.floor(Math.log10(axis.max)); decade++) {
    for (const multiplier of multipliers) {
      const hz = multiplier * 10 ** decade;
      if (hz < axis.min || hz > axis.max) continue;
      const position = fraction(hz) * pixels;
      if (position - last < spacing) continue;
      ticks.push(hz);
      last = position;
    }
  }
  return ticks.length ? ticks : [Math.sqrt(axis.min * axis.max)];
}

const VOWEL_TRAIL_WINDOW_MS = 10000;

export function drawPtbVowelSpace(
  canvas: HTMLCanvasElement | null,
  opts: VowelSpaceRenderOptions,
): VowelSpaceLayout | null {
  if (!canvas) return null;
  const setup = setupCanvas(canvas);
  if (!setup) return null;
  const { ctx, w, h } = setup;
  const theme = readChartTheme();
  const now = opts.now ?? performance.now();
  const scale = opts.scale ?? 'linear';
  const fontScale = opts.fontScale ?? 1;

  const pad = { l: 30, r: 9, t: 17, b: 22 };
  const plotW = Math.max(30, w - pad.l - pad.r);
  const plotH = Math.max(24, h - pad.t - pad.b);

  const manualAxes = scale === 'logarithmic' && opts.manualAxes
    && Math.min(opts.manualAxes.f1.min, opts.manualAxes.f2.min) <= 0 ? null : opts.manualAxes;
  const f1Samples = opts.references.map((p) => p.f1);
  const f2Samples = opts.references.map((p) => p.f2);
  const f1Domain = f1Samples.length > 0 && f1Samples.length < 4 ? [...f1Samples, 220, 860] : f1Samples;
  const f2Domain = f2Samples.length > 0 && f2Samples.length < 4 ? [...f2Samples, 550, 2450] : f2Samples;
  const f1Axis = manualAxes?.f1 ?? frequencyAxis(f1Domain, 'f1');
  const f2Axis = manualAxes?.f2 ?? frequencyAxis(f2Domain, 'f2');
  const axes: VowelSpaceAxes = { f1: f1Axis, f2: f2Axis };
  const inView = ({ f1, f2 }: { f1: number; f2: number }) =>
    f1 >= f1Axis.min && f1 <= f1Axis.max && f2 >= f2Axis.min && f2 <= f2Axis.max;
  const current = opts.current && inView(opts.current) ? opts.current : null;
  const activeHistory = opts.history.filter((p) => now - p.time < VOWEL_TRAIL_WINDOW_MS);

  // Inverted F2 (left=high, right=low) & downward-increasing F1 (top=close, bottom=open) — exact PTB convention!
  const fractionF1 = vowelAxisFraction(f1Axis, scale);
  const fractionF2 = vowelAxisFraction(f2Axis, scale);
  const mapX = (f2Hz: number) => pad.l + (1 - fractionF2(f2Hz)) * plotW;
  const mapY = (f1Hz: number) => pad.t + fractionF1(f1Hz) * plotH;

  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = theme.panel;
  ctx.fillRect(pad.l, pad.t, plotW, plotH);

  // Axis captions
  ctx.font = monoFont(600, 8.2, fontScale);
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('F1 (Hz)', 3, 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('F2 (Hz · 前 ← → 后)', pad.l + plotW * 0.5, h - 1);

  // Adaptive Frequency Gridlines & Ticks
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 0.8;
  ctx.font = monoFont(500, 8.4, fontScale);

  for (const hz of vowelAxisTicks(f2Axis, scale, plotW, 28 * fontScale)) {
    const gx = mapX(hz);
    ctx.beginPath();
    ctx.moveTo(gx, pad.t);
    ctx.lineTo(gx, pad.t + plotH);
    ctx.stroke();
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(String(Math.round(hz)), gx, pad.t + plotH + 2);
  }

  for (const hz of vowelAxisTicks(f1Axis, scale, plotH, 17 * fontScale)) {
    const gy = mapY(hz);
    ctx.beginPath();
    ctx.moveTo(pad.l, gy);
    ctx.lineTo(pad.l + plotW, gy);
    ctx.stroke();
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.round(hz)), pad.l - 3, gy);
  }

  // Clip plot interior for reference vowel hull, dots, trail & live dot
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, plotW, plotH);
  ctx.clip();

  // Airy quadrilateral outline connecting cardinal corners if present (i -> u -> ɑ/o -> a), without muddy fill
  const bySym = new Map(opts.references.filter(point => !point.nasal).map((r) => [vowelSymbolKey(r.symbol), r]));
  const corners = ['i', 'u', 'ɑ', 'a']
    .map((sym) => bySym.get(sym) ?? (sym === 'ɑ' ? bySym.get('ɔ') ?? bySym.get('o') : undefined))
    .filter((v): v is VowelReferencePoint => Boolean(v));
  if (corners.length >= 3) {
    ctx.beginPath();
    corners.forEach((c, idx) => {
      const px = mapX(c.f2);
      const py = mapY(c.f1);
      if (idx === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.globalAlpha = theme.isDark ? 0.26 : 0.22;
    ctx.strokeStyle = theme.muted;
    ctx.lineWidth = 0.85;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // Pass 1: Render clean, luminous 2D Gaussian radial density peaks (Sky-Azure vs Iris-Violet)
  const roundingPalette = theme.isDark ? VOWEL_ROUNDING_COLORS.dark : VOWEL_ROUNDING_COLORS.light;
  const peakRadius = Math.max(11.5, 13.8 * fontScale);
  const visibleRefs: Array<{
    refPt: VowelReferencePoint;
    cx: number;
    cy: number;
    rounded: boolean;
    labelText: string;
  }> = [];

  for (const refPt of opts.references) {
    if (!inView(refPt)) continue;
    const cx = mapX(refPt.f2);
    const cy = mapY(refPt.f1);
    const rounded = isRoundedVowelSymbol(refPt.symbol);
    const rgb = rounded ? roundingPalette.roundedRgb : roundingPalette.unroundedRgb;
    const peakAlpha = theme.isDark ? 0.46 : 0.38;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, peakRadius);
    for (const [offset, weight] of VOWEL_GAUSSIAN_STOPS) {
      grad.addColorStop(offset, `rgba(${rgb}, ${(peakAlpha * weight).toFixed(3)})`);
    }
    ctx.beginPath();
    ctx.arc(cx, cy, peakRadius, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    visibleRefs.push({
      refPt,
      cx,
      cy,
      rounded,
      labelText: formatVowelChartLabel(refPt.symbol),
    });
  }

  // Pass 2: Center IPA glyph directly on each Gaussian peak (no separate dot/square clutter)
  const marks: VowelSpaceLayout['marks'] = [];
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  for (const { refPt, cx, cy, rounded, labelText } of visibleRefs) {
    marks.push({ x: cx, y: cy, point: refPt });
    const isCompound = labelText.length > 2;
    const fontSize = (isCompound ? 9.4 : 11.2) * fontScale;
    ctx.font = `600 ${fontSize}px "PTBIPAPlus", "PTB-Doulos", "Doulos SIL", serif`;

    // Crisp panel-colored text halo keeps closely spaced IPA glyphs effortless to read
    ctx.strokeStyle = theme.panel;
    ctx.lineWidth = 2.6 * fontScale;
    ctx.globalAlpha = 0.88;
    ctx.strokeText(labelText, cx, cy);

    ctx.fillStyle = rounded ? roundingPalette.roundedText : roundingPalette.unroundedText;
    ctx.globalAlpha = 1;
    ctx.fillText(labelText, cx, cy);
  }
  ctx.restore();

  // 10-second fading trajectory trail
  for (let i = 0; i < activeHistory.length; i++) {
    const p = activeHistory[i];
    if (!inView(p)) continue;
    const next = activeHistory[i + 1] ?? current;
    const alpha = Math.max(0, 1 - (now - p.time) / VOWEL_TRAIL_WINDOW_MS);
    if (next && inView(next) && !p.breakAfter) {
      ctx.beginPath();
      ctx.moveTo(mapX(p.f2), mapY(p.f1));
      ctx.lineTo(mapX(next.f2), mapY(next.f1));
      ctx.strokeStyle = theme.accent;
      ctx.globalAlpha = alpha * 0.65;
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(mapX(p.f2), mapY(p.f1), 1.9, 0, Math.PI * 2);
    ctx.fillStyle = theme.accent;
    ctx.globalAlpha = alpha * 0.72;
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Live Current Formant Bullseye (always matches bottom legend `.key-live` accent bullseye)
  if (current) {
    const lx = mapX(current.f2);
    const ly = mapY(current.f1);
    const col = theme.accent;
    ctx.beginPath();
    ctx.arc(lx, ly, 7.6, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.18;
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.arc(lx, ly, 4.6, 0, Math.PI * 2);
    ctx.fillStyle = theme.panel;
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.35;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(lx, ly, 2.1, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
  }

  ctx.restore();

  if (!opts.references.length && !current && !activeHistory.some(inView)) {
    drawUnavailable(ctx, w, h, '暂无实测或模型数据', theme, fontScale);
  }
  return { axes, scale, pad, w, h, plotW, plotH, currentInView: current !== null, marks };
}
