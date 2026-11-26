import { VTL_PARAM_META, type GlottisM27Params, type TractMetrics, type TractParamName } from '@/stores/workbench';
import type { TractPoseExtras } from '@/data/ptb-ipa-presets';
import { isVowelOrApproximant } from '@/data/ipa-segments';
import {
  VOWEL_GAUSSIAN_STOPS,
  VOWEL_ROUNDING_COLORS,
  formatVowelChartLabel,
  isRoundedVowelSymbol,
  vowelSymbolKey,
} from '@/data/ipa-vowel-measurements';
import {
  buildPtbLipFrontData,
  computeAreaReadouts,
  paintPtbSectionChart,
  vowelAxisFraction,
  vowelAxisTicks,
  type PtbPoseSnapshot,
} from '@/components/research/ptb-physics-charts';
import {
  drawM27GlottisCanvas,
  getM27GlottisVisHz,
  type GlottisVisualFrame,
} from '@/vendor/m27-tract-studio/tract-renderer.js';
import type { CardBox } from '../layout-tree';
import type { CardResolvedTheme } from '../card-themes';
import type { CardVowelRefPoint } from '../vowel-ref-data';
import {
  IPA_TYPEFACE,
  MONO_TYPEFACE,
  drawModuleShell,
  drawPillBadge,
  fitTextEllipsis,
  roundRectPath,
} from '../draw-primitives';

export type RasterCardImage = HTMLImageElement | HTMLCanvasElement;
export type SubPaneDirection = 'auto' | 'row' | 'col';

export interface AcousticBlockContext {
  ctx: CanvasRenderingContext2D;
  box: CardBox;
  theme: CardResolvedTheme;
  u: number;
  fontFamily: string;
  textScale: number;
  compare: boolean;
  labelA: string;
  ipaA: string;
  labelB: string;
  ipaB: string;
  vowelSymbolA: string;
  vowelSymbolB: string;
  metricsA: TractMetrics;
  metricsB: TractMetrics | null;
  paramsA: Record<TractParamName, number>;
  paramsB: Record<TractParamName, number>;
  extrasA: TractPoseExtras;
  glottis: GlottisM27Params;
  snapshotA: PtbPoseSnapshot | null;
  vtlImageA: RasterCardImage | null;
  vtlImageB: RasterCardImage | null;
  tractZoom: number;
  offsetA: { x: number; y: number };
  offsetB: { x: number; y: number };
  showOrientationCompass: boolean;
  showVowelReferenceCloud: boolean;
  crossLipDirection: SubPaneDirection;
  glottisDirection: SubPaneDirection;
  vowelRefs: readonly CardVowelRefPoint[];
  trailPoints: ReadonlyArray<{ f1: number; f2: number }>;
  time_s: number;
}

function drawImageContain(
  ctx: CanvasRenderingContext2D,
  img: RasterCardImage,
  x: number,
  y: number,
  w: number,
  h: number,
  zoom = 1,
  dx = 0,
  dy = 0,
): void {
  const nw = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
  const nh = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
  if (!nw || !nh) return;
  const scale = zoom * Math.min(w / nw, h / nh);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, x + (w - nw * scale) / 2 + dx, y + (h - nh * scale) / 2 + dy, nw * scale, nh * scale);
  ctx.restore();
}

function drawAnalyticalSagittalFallback(
  ctx: CanvasRenderingContext2D,
  box: CardBox,
  params: Record<TractParamName, number>,
  theme: CardResolvedTheme,
  u: number,
): void {
  const { x, y, w, h } = box;
  const cx = x + w * 0.46;
  const cy = y + h * 0.56;
  const s = Math.min(w, h) * 0.42;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  ctx.strokeStyle = theme.primaryInk;
  ctx.lineWidth = Math.max(1.8, 2.4 * u);
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.82, cy + s * 0.82);
  ctx.quadraticCurveTo(cx - s * 0.86, cy - s * 0.72, cx - s * 0.08, cy - s * 0.76);
  ctx.quadraticCurveTo(cx + s * 0.64, cy - s * 0.76, cx + s * 0.92, cy - s * 0.24);
  ctx.stroke();

  const tcx = ((params.TCX ?? 0.5) / 4) * s * 0.36;
  const tcy = -((params.TCY ?? 0) / 3) * s * 0.32;
  const tty = -((params.TTY ?? 0) / 3) * s * 0.26;
  const jawDrop = (Math.abs(params.JA ?? -2) / 7) * s * 0.28;

  ctx.fillStyle = theme.fillAlphaPrimary;
  ctx.strokeStyle = theme.primaryInk;
  ctx.lineWidth = Math.max(1.6, 2.1 * u);
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.62, cy + s * 0.78);
  ctx.bezierCurveTo(
    cx - s * 0.62,
    cy - s * 0.15 + tcy,
    cx + s * 0.25 + tcx,
    cy - s * 0.38 + tcy,
    cx + s * 0.74,
    cy + s * 0.05 + tty + jawDrop * 0.4,
  );
  ctx.quadraticCurveTo(cx + s * 0.2, cy + s * 0.72 + jawDrop * 0.5, cx - s * 0.62, cy + s * 0.78);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  const lipOpen = Math.max(0.04, ((params.LD ?? 0.6) + 0.5) / 4) * s * 0.34;
  const lipProt = ((params.LP ?? 0.2) / 1.2) * s * 0.18;
  ctx.fillStyle = theme.secondaryInk;
  ctx.beginPath();
  ctx.ellipse(cx + s * 0.96 + lipProt, cy - s * 0.2 - lipOpen * 0.45, s * 0.11, s * 0.065, 0, 0, Math.PI * 2);
  ctx.ellipse(cx + s * 0.95 + lipProt, cy - s * 0.05 + lipOpen * 0.55 + jawDrop * 0.35, s * 0.11, s * 0.07, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function paintGlottisModelIntoRect(
  ctx: CanvasRenderingContext2D,
  rect: CardBox,
  glottis: GlottisM27Params,
  time_s: number,
  theme: CardResolvedTheme,
  direction: SubPaneDirection = 'auto',
): void {
  if (typeof document === 'undefined' || rect.w < 16 || rect.h < 16) return;
  const useHorizontal = direction === 'row' || (direction === 'auto' && rect.w > rect.h * 1.28);

  const sub = document.createElement('canvas');
  let cw: number;
  let ch: number;
  const gap = Math.max(6, Math.round(rect.w * 0.014));
  const halfW = Math.max(40, (rect.w - gap) / 2);

  if (useHorizontal) {
    const scaleUp = Math.max(1, 230 / Math.min(halfW, rect.h));
    cw = Math.max(240, Math.round(halfW * scaleUp));
    ch = Math.max(380, Math.round(rect.h * scaleUp * 2.02));
  } else {
    const scaleUp = Math.max(1, 220 / Math.min(rect.w, rect.h));
    cw = Math.max(200, Math.round(rect.w * scaleUp));
    ch = Math.max(220, Math.round(rect.h * scaleUp));
  }

  sub.width = cw;
  sub.height = ch;
  sub.style.width = `${cw}px`;
  sub.style.height = `${ch}px`;
  sub.getBoundingClientRect = () =>
    ({
      width: cw,
      height: ch,
      top: 0,
      left: 0,
      right: cw,
      bottom: ch,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

  const st: GlottisVisualFrame = {
    t: time_s,
    f0: glottis.f0_hz,
    pr_pa: glottis.pr_pa,
    xb: glottis.xb_cm,
    xt: glottis.xt_cm,
    ca: glottis.ca_cm2,
    lag: glottis.lag_rad,
    ra: glottis.ra,
    ps: glottis.ps,
    fl: glottis.fl,
    shim: glottis.shim,
  };
  const visHz = getM27GlottisVisHz(st, 'strobe');
  const phase = time_s * Math.max(0.8, visHz) * Math.PI * 2;

  drawM27GlottisCanvas(sub, st, phase, {
    vibMode: 'strobe',
    showLabels: cw >= 195,
    theme: {
      anatomyBg: theme.cardSurface,
      anatomyMuted: theme.muted,
      anatomyDivider: theme.border,
    },
  });

  ctx.save();
  if (theme.isMonochrome) {
    ctx.filter = theme.isDark ? 'grayscale(100%) contrast(114%) brightness(106%)' : 'grayscale(100%) contrast(114%)';
  }
  if (!useHorizontal) {
    ctx.drawImage(sub, rect.x, rect.y, rect.w, rect.h);
  } else {
    const dprScale = sub.height / Math.max(1, ch);
    const supLogicalH = Math.round(ch * 0.54) + 3;
    const corLogicalTop = Math.round(ch * 0.54) + 7;
    const syTopEnd = Math.min(sub.height, Math.round(supLogicalH * dprScale));
    const syBotStart = Math.min(sub.height - 2, Math.round(corLogicalTop * dprScale));
    const syBotH = Math.max(2, sub.height - syBotStart);

    ctx.drawImage(sub, 0, 0, sub.width, syTopEnd, rect.x, rect.y, halfW, rect.h);
    ctx.drawImage(sub, 0, syBotStart, sub.width, syBotH, rect.x + halfW + gap, rect.y, halfW, rect.h);

    ctx.filter = 'none';
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rect.x + halfW + gap * 0.5, rect.y + 8);
    ctx.lineTo(rect.x + halfW + gap * 0.5, rect.y + rect.h - 8);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawGlottisModelBlock(b: AcousticBlockContext): void {
  const { ctx, box, theme, u, fontFamily, textScale, glottis } = b;
  const badge = `F0 ${Math.round(glottis.f0_hz)}Hz · ${Math.round(glottis.pr_pa)}Pa`;
  const inner = drawModuleShell(ctx, box, '声门与声带模型', badge, theme, u, fontFamily, textScale);

  ctx.save();
  roundRectPath(ctx, inner.x, inner.y, inner.w, inner.h, Math.max(4, 6 * u));
  ctx.fillStyle = theme.cardSurface;
  ctx.fill();
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = Math.max(0.8, 0.9 * u);
  ctx.stroke();
  ctx.clip();

  paintGlottisModelIntoRect(ctx, inner, glottis, b.time_s, theme, b.glottisDirection);
  ctx.restore();
}

export function drawTractProfileBlock(b: AcousticBlockContext): { a: CardBox; b?: CardBox } {
  const { ctx, box, theme, u, fontFamily, textScale, compare } = b;
  const badge = compare
    ? 'A / B 对照'
    : `F1 ${b.metricsA.f1_hz} · F2 ${b.metricsA.f2_hz} Hz`;
  const inner = drawModuleShell(ctx, box, compare ? '声道双音构型对照' : '声道几何剖面', badge, theme, u, fontFamily, textScale);

  const stacked = compare && inner.w / Math.max(1, inner.h) < 0.85;
  const gap = 8 * u;
  const subA: CardBox = !compare
    ? inner
    : stacked
      ? { x: inner.x, y: inner.y, w: inner.w, h: (inner.h - gap) / 2 }
      : { x: inner.x, y: inner.y, w: (inner.w - gap) / 2, h: inner.h };
  const subB: CardBox | undefined = !compare
    ? undefined
    : stacked
      ? { x: inner.x, y: subA.y + subA.h + gap, w: inner.w, h: subA.h }
      : { x: subA.x + subA.w + gap, y: inner.y, w: subA.w, h: inner.h };

  const paintSlot = (
    slot: CardBox,
    img: RasterCardImage | null,
    params: Record<TractParamName, number>,
    role: 'A' | 'B' | null,
    name: string,
    ipa: string,
    offset: { x: number; y: number },
    ink: string,
  ) => {
    ctx.save();
    roundRectPath(ctx, slot.x, slot.y, slot.w, slot.h, Math.max(4, (theme.moduleRadiusFactor - 3) * u));
    ctx.fillStyle = theme.cardSurface;
    ctx.fill();
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = Math.max(0.8, 0.9 * u);
    ctx.stroke();
    ctx.clip();

    const subHead = role ? Math.max(20, 24 * u * Math.min(1.25, textScale * 0.9)) : 0;
    const viewArea: CardBox = {
      x: slot.x + 2 * u,
      y: slot.y + subHead + 2 * u,
      w: Math.max(8, slot.w - 4 * u),
      h: Math.max(8, slot.h - subHead - 4 * u),
    };

    // Respect user tractZoom (1.0 = unclipped contain fit of the full oral + pharyngeal + glottal tract)
    const effectiveZoom = b.tractZoom;
    if (img) {
      if (theme.isMonochrome) {
        ctx.save();
        ctx.filter = theme.isDark ? 'grayscale(100%) contrast(116%) brightness(108%)' : 'grayscale(100%) contrast(118%)';
        drawImageContain(ctx, img, viewArea.x, viewArea.y, viewArea.w, viewArea.h, effectiveZoom, offset.x * slot.w, offset.y * slot.h);
        ctx.restore();
      } else {
        drawImageContain(ctx, img, viewArea.x, viewArea.y, viewArea.w, viewArea.h, effectiveZoom, offset.x * slot.w, offset.y * slot.h);
      }
    } else {
      drawAnalyticalSagittalFallback(ctx, viewArea, params, theme, u);
    }

    if (role) {
      ctx.fillStyle = theme.moduleHeaderBg;
      ctx.fillRect(slot.x, slot.y, slot.w, subHead);
      ctx.fillStyle = ink;
      ctx.fillRect(slot.x, slot.y + subHead - 1.8 * u, slot.w, 1.8 * u);
      const fs = Math.max(9.5, 11.5 * u * textScale);
      ctx.font = `700 ${fs}px ${fontFamily}`;
      ctx.fillStyle = theme.text;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const cleanName = name.replace(/^音\s*[AB]\s*[·：:]?\s*/u, '').trim();
      const headLbl = fitTextEllipsis(ctx, `${role} · ${cleanName || '构型'}`, slot.w * 0.56);
      ctx.fillText(headLbl, slot.x + 8 * u, slot.y + subHead / 2);
      if (ipa) {
        ctx.font = `${Math.max(10.5, 12.5 * u * textScale)}px ${IPA_TYPEFACE}`;
        ctx.fillStyle = ink;
        ctx.textAlign = 'right';
        ctx.fillText(ipa, slot.x + slot.w - 8 * u, slot.y + subHead / 2 + 0.5 * u);
      }
    }

    if (b.showOrientationCompass && viewArea.w > 125 * u && viewArea.h > 105 * u) {
      const compFs = Math.max(8.5, 10 * u * textScale);
      const cx = viewArea.x + viewArea.w - 28 * u * Math.min(1.25, textScale * 0.85);
      const cy = viewArea.y + viewArea.h - 24 * u * Math.min(1.25, textScale * 0.85);
      const stepY = compFs * 1.18;
      ctx.font = `500 ${compFs}px ${fontFamily}`;
      ctx.fillStyle = theme.muted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('上', cx, cy - stepY);
      ctx.fillText('后—前', cx, cy);
      ctx.fillText('下', cx, cy + stepY);
    }
    ctx.restore();
  };

  paintSlot(
    subA,
    b.vtlImageA,
    b.paramsA,
    compare ? 'A' : null,
    b.labelA,
    b.ipaA,
    b.offsetA,
    theme.primaryInk,
  );
  if (subB) {
    paintSlot(
      subB,
      b.vtlImageB,
      b.paramsB,
      'B',
      b.labelB,
      b.ipaB,
      b.offsetB,
      theme.secondaryInk,
    );
  }
  return { a: subA, ...(subB ? { b: subB } : {}) };
}

export function drawCrossLipBlock(b: AcousticBlockContext): void {
  const { ctx, box, theme, u, fontFamily, textScale, snapshotA, paramsA, extrasA } = b;
  const lipData = buildPtbLipFrontData(snapshotA, paramsA);
  const nasalLabel = lipData.nasalOpen ? `鼻腔连通 ${lipData.portAreaCm2.toFixed(2)} cm²` : '软腭闭塞';
  const inner = drawModuleShell(
    ctx,
    box,
    '横截面 & 正面唇形',
    snapshotA ? nasalLabel : '',
    theme,
    u,
    fontFamily,
    textScale,
  );

  const gap = Math.min(8 * u, inner.w * 0.08, inner.h * 0.08);
  const useVertical = b.crossLipDirection === 'col' || (b.crossLipDirection === 'auto' && inner.h > inner.w * 1.08);
  const secBox: CardBox = useVertical
    ? { x: inner.x, y: inner.y, w: inner.w, h: (inner.h - gap) * 0.48 }
    : { x: inner.x, y: inner.y, w: (inner.w - gap) * 0.48, h: inner.h };
  const lipBox: CardBox = useVertical
    ? { x: inner.x, y: inner.y + secBox.h + gap, w: inner.w, h: inner.h - gap - secBox.h }
    : { x: inner.x + secBox.w + gap, y: inner.y, w: inner.w - gap - secBox.w, h: inner.h };

  for (const sub of [secBox, lipBox]) {
    roundRectPath(ctx, sub.x, sub.y, sub.w, sub.h, Math.max(4, 6 * u));
    ctx.fillStyle = theme.cardSurface;
    ctx.fill();
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = Math.max(0.75, 0.85 * u);
    ctx.stroke();
  }

  const summary = computeAreaReadouts(snapshotA);
  const scx = secBox.x + secBox.w / 2;
  const capFs = Math.min(Math.max(8.5, 9.8 * u * textScale), secBox.h * 0.17, lipBox.h * 0.17);

  ctx.save();
  ctx.beginPath();
  ctx.rect(secBox.x, secBox.y, secBox.w, secBox.h);
  ctx.clip();
  ctx.translate(secBox.x, secBox.y);
  ctx.scale(u, u);
  const section = paintPtbSectionChart(
    ctx, secBox.w / u, (secBox.h - capFs * 1.8) / u,
    snapshotA, summary?.aminIdx ?? snapshotA?.section ?? 0, capFs / (10 * u),
    { grid: theme.subtle, muted: theme.muted, teal: theme.secondaryInk, tealFill: theme.fillAlphaSecondary, danger: theme.text },
  );
  ctx.restore();
  ctx.font = `600 ${capFs}px ${MONO_TYPEFACE}`;
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (section.available) {
    ctx.fillText(`Amin ${(section.open ? section.areaCm2 : 0).toFixed(2)} cm²`, scx, secBox.y + secBox.h - capFs, secBox.w * 0.9);
  }

  const lcx = lipBox.x + lipBox.w / 2;
  const lcy = lipBox.y + lipBox.h * 0.45;
  if (!lipData.isRealMesh) {
    ctx.font = `${capFs}px ${fontFamily}`;
    ctx.fillText('暂无唇形网格', lcx, lcy, lipBox.w * 0.9);
    return;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(lipBox.x + 2, lipBox.y + 2, lipBox.w - 4, lipBox.h - capFs * 1.9);
  ctx.clip();

  if (lipData.outerPath && typeof Path2D !== 'undefined') {
    const vbParts = lipData.viewBox.split(/\s+/).map(Number);
    const [vx = -3, vy = -2, vw = 6, vh = 4] = vbParts;
    const scale = Math.min((lipBox.w * 0.78) / Math.max(1, vw), ((lipBox.h - capFs * 2) * 0.78) / Math.max(1, vh));
    ctx.save();
    ctx.translate(lcx - (vx + vw / 2) * scale, lcy - (vy + vh / 2) * scale);
    ctx.scale(scale, scale);
    const outer = new Path2D(lipData.outerPath);
    ctx.fillStyle = theme.fillAlphaSecondary;
    ctx.fill(outer);
    ctx.strokeStyle = theme.primaryInk;
    ctx.lineWidth = Math.max(1.4, 1.9 * u) / scale;
    ctx.stroke(outer);
    if (lipData.aperturePath) {
      const innerP = new Path2D(lipData.aperturePath);
      ctx.fillStyle = theme.cardSurface;
      ctx.fill(innerP);
      ctx.strokeStyle = theme.secondaryInk;
      ctx.lineWidth = Math.max(1.1, 1.5 * u) / scale;
      ctx.stroke(innerP);
    }
    ctx.restore();
  }
  ctx.restore();

  ctx.font = `600 ${capFs}px ${MONO_TYPEFACE}`;
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`唇宽 ${(snapshotA?.lip_width ?? extrasA.lip_width).toFixed(2)}×`, lcx, lipBox.y + lipBox.h - capFs, lipBox.w * 0.9);
}

interface AxisPlotSpec {
  xDomain: [number, number];
  yDomain: [number, number];
  xTicks: number[];
  yTicks: number[];
  xUnitLabel: string;
  yUnitLabel: string;
}

function drawPlotGrid(
  ctx: CanvasRenderingContext2D,
  area: CardBox,
  spec: AxisPlotSpec,
  theme: CardResolvedTheme,
  u: number,
  textScale: number,
): { fx: (v: number) => number; fy: (v: number) => number; plot: CardBox } {
  const tickFs = Math.max(8.5, 10 * u * textScale);
  const padL = Math.max(36 * u, tickFs * 3.4);
  const padR = 12 * u;
  const padT = Math.max(15 * u, tickFs * 1.45);
  const padB = Math.max(22 * u, tickFs * 1.95);
  const plot: CardBox = {
    x: area.x + padL,
    y: area.y + padT,
    w: Math.max(16, area.w - padL - padR),
    h: Math.max(16, area.h - padT - padB),
  };
  const fx = (v: number) => plot.x + ((v - spec.xDomain[0]) / (spec.xDomain[1] - spec.xDomain[0])) * plot.w;
  const fy = (v: number) => plot.y + ((v - spec.yDomain[0]) / (spec.yDomain[1] - spec.yDomain[0])) * plot.h;

  ctx.save();
  ctx.strokeStyle = theme.subtle;
  ctx.lineWidth = Math.max(0.65, 0.8 * u);
  ctx.font = `500 ${tickFs}px ${MONO_TYPEFACE}`;
  ctx.fillStyle = theme.muted;

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.beginPath();
  for (const yv of spec.yTicks) {
    const py = fy(yv);
    ctx.moveTo(plot.x, py);
    ctx.lineTo(plot.x + plot.w, py);
    ctx.fillText(String(yv), plot.x - 5 * u, py);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const xv of spec.xTicks) {
    const px = fx(xv);
    ctx.moveTo(px, plot.y);
    ctx.lineTo(px, plot.y + plot.h);
    ctx.fillText(String(xv), px, plot.y + plot.h + 4 * u);
  }
  ctx.stroke();

  ctx.strokeStyle = theme.border;
  ctx.lineWidth = Math.max(0.85, 1 * u);
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);

  ctx.font = `600 ${Math.max(8, 9.4 * u * textScale)}px ${MONO_TYPEFACE}`;
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(spec.yUnitLabel, plot.x, plot.y - 2.5 * u);
  ctx.textAlign = 'right';
  ctx.fillText(spec.xUnitLabel, plot.x + plot.w, plot.y - 2.5 * u);
  ctx.restore();

  return { fx, fy, plot };
}

export function drawAreaFnBlock(b: AcousticBlockContext): void {
  const { ctx, box, theme, u, fontFamily, textScale, metricsA, metricsB, compare } = b;
  const badge = `Amin ${metricsA.amin_cm2.toFixed(2)} cm² · @${metricsA.amin_x_cm.toFixed(1)}cm`;
  const inner = drawModuleShell(ctx, box, 'A(x) 声道面积函数', badge, theme, u, fontFamily, textScale);

  const list = compare && metricsB ? [metricsA, metricsB] : [metricsA];
  const allPts = list.flatMap((m) => m.area_fn);
  const xmax = Math.max(16, Math.ceil(Math.max(15, ...allPts.map((p) => p.x_cm)) / 4) * 4);
  const ymax = Math.max(6, Math.ceil(Math.max(5, ...allPts.map((p) => p.area_cm2)) / 2) * 2);

  const { fx, fy, plot } = drawPlotGrid(
    ctx,
    inner,
    {
      xDomain: [0, xmax],
      yDomain: [ymax, 0],
      xTicks: [0, Math.round(xmax / 2), xmax],
      yTicks: [0, Math.round(ymax / 2), ymax],
      xUnitLabel: 'cm (声门→唇)',
      yUnitLabel: 'cm²',
    },
    theme,
    u,
    textScale,
  );

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();

  list.forEach((m, idx) => {
    const pts = m.area_fn.filter((p) => Number.isFinite(p.x_cm) && Number.isFinite(p.area_cm2));
    if (pts.length < 2) return;
    const isSecond = idx === 1;

    if (!isSecond) {
      ctx.beginPath();
      ctx.moveTo(fx(pts[0].x_cm), plot.y + plot.h);
      for (const p of pts) ctx.lineTo(fx(p.x_cm), fy(p.area_cm2));
      ctx.lineTo(fx(pts[pts.length - 1].x_cm), plot.y + plot.h);
      ctx.closePath();
      ctx.fillStyle = theme.fillAlphaPrimary;
      ctx.fill();

      ctx.save();
      ctx.strokeStyle = theme.secondaryInk;
      ctx.lineWidth = Math.max(0.9, 1.15 * u);
      ctx.setLineDash([3 * u, 3 * u]);
      ctx.globalAlpha = 0.72;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const px = fx(pts[i].x_cm);
        const py = fy(pts[i].area_cm2);
        if (i === 0) ctx.moveTo(px, py);
        else {
          ctx.lineTo(px, fy(pts[i - 1].area_cm2));
          ctx.lineTo(px, py);
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.strokeStyle = isSecond ? theme.secondaryInk : theme.primaryInk;
    ctx.lineWidth = Math.max(1.5, (isSecond ? 1.8 : 2.3) * u);
    if (isSecond && theme.isMonochrome) ctx.setLineDash([5 * u, 3.5 * u]);
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(fx(p.x_cm), fy(p.area_cm2)) : ctx.lineTo(fx(p.x_cm), fy(p.area_cm2))));
    ctx.stroke();
    ctx.restore();
  });

  if (Number.isFinite(metricsA.amin_x_cm) && metricsA.amin_x_cm > 0) {
    const ax = fx(metricsA.amin_x_cm);
    ctx.save();
    ctx.strokeStyle = theme.primaryInk;
    ctx.lineWidth = Math.max(0.9, 1.1 * u);
    ctx.setLineDash([2.5 * u, 2.5 * u]);
    ctx.beginPath();
    ctx.moveTo(ax, plot.y);
    ctx.lineTo(ax, plot.y + plot.h);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

export function drawTransferFnBlock(b: AcousticBlockContext): void {
  const { ctx, box, theme, u, fontFamily, textScale, metricsA, metricsB, compare } = b;
  const fSummary =
    compare && metricsB
      ? `A ${metricsA.f1_hz}/${metricsA.f2_hz} · B ${metricsB.f1_hz}/${metricsB.f2_hz} Hz`
      : `F1 ${metricsA.f1_hz} · F2 ${metricsA.f2_hz} · F3 ${metricsA.f3_hz}`;
  const inner = drawModuleShell(ctx, box, 'H(f) 声道传递函数', fSummary, theme, u, fontFamily, textScale);

  const list = compare && metricsB ? [metricsA, metricsB] : [metricsA];
  const xmax = 5000;
  const allPts = list.flatMap((m) => m.transfer_fn.filter((p) => p.f_hz <= xmax));
  const ymax = Math.max(25, Math.ceil(Math.max(20, ...allPts.map((p) => p.db)) / 10) * 10);
  const ymin = Math.min(-20, Math.floor(Math.min(-15, ...allPts.map((p) => p.db)) / 10) * 10);

  const { fx, fy, plot } = drawPlotGrid(
    ctx,
    inner,
    {
      xDomain: [0, xmax],
      yDomain: [ymax, ymin],
      xTicks: [0, 2500, 5000],
      yTicks: [ymin, 0, ymax],
      xUnitLabel: 'Hz (0–5k)',
      yUnitLabel: 'dB',
    },
    theme,
    u,
    textScale,
  );

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();

  list.forEach((m, idx) => {
    const pts = m.transfer_fn.filter((p) => Number.isFinite(p.f_hz) && Number.isFinite(p.db) && p.f_hz <= xmax);
    if (pts.length < 2) return;
    const isSecond = idx === 1;
    ctx.beginPath();
    ctx.moveTo(fx(pts[0].f_hz), plot.y + plot.h);
    for (const p of pts) ctx.lineTo(fx(p.f_hz), fy(p.db));
    ctx.lineTo(fx(pts[pts.length - 1].f_hz), plot.y + plot.h);
    ctx.closePath();
    ctx.fillStyle = isSecond ? theme.fillAlphaSecondary : theme.fillAlphaPrimary;
    ctx.fill();

    ctx.save();
    ctx.strokeStyle = isSecond ? theme.secondaryInk : theme.primaryInk;
    ctx.lineWidth = Math.max(1.5, (isSecond ? 1.9 : 2.2) * u);
    if (isSecond && theme.isMonochrome) ctx.setLineDash([5 * u, 3.5 * u]);
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(fx(p.f_hz), fy(p.db)) : ctx.lineTo(fx(p.f_hz), fy(p.db))));
    ctx.stroke();
    ctx.restore();
  });

  if (compare && metricsB && plot.w > 130 * u) {
    const legFs = Math.max(8, 9.2 * u * Math.min(1.15, textScale * 0.85));
    const lx = plot.x + plot.w - 8 * u;
    const ly = plot.y + 11 * u;
    ctx.save();
    ctx.font = `700 ${legFs}px ${MONO_TYPEFACE}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillStyle = theme.secondaryInk;
    ctx.fillText('— B', lx, ly);
    ctx.fillStyle = theme.primaryInk;
    ctx.fillText('— A', lx - 34 * u, ly);
    ctx.restore();
  }

  const peaks = (metricsA.peaks_hz?.length ? metricsA.peaks_hz : [metricsA.f1_hz, metricsA.f2_hz, metricsA.f3_hz])
    .filter((f) => Number.isFinite(f) && f > 50 && f <= xmax)
    .slice(0, 5);
  peaks.forEach((freq, i) => {
    const px = fx(freq);
    ctx.save();
    ctx.strokeStyle = theme.primaryInk;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = Math.max(0.8, 0.9 * u);
    ctx.setLineDash([2.5 * u, 3 * u]);
    ctx.beginPath();
    ctx.moveTo(px, plot.y + 18 * u);
    ctx.lineTo(px, plot.y + plot.h);
    ctx.stroke();
    ctx.restore();

    drawPillBadge(
      ctx,
      `F${i + 1}`,
      px,
      plot.y + 11 * u,
      u * textScale * 0.72,
      theme.badgeBg,
      theme.badgeText,
      null,
      'center',
    );
  });
  ctx.restore();
}

/**
 * Logarithmic F1–F2 Acoustic Vowel Space Chart:
 * - Both F1 and F2 use genuine logarithmic axes (`vowelAxisFraction(..., 'logarithmic')`).
 * - All 29 IPA reference vowel points are rendered semi-transparently on the bottom layer.
 * - Live points and their trajectories are drawn only for vowels and approximants.
 */
export function drawVowelSpaceBlock(b: AcousticBlockContext): void {
  const { ctx, box, theme, u, fontFamily, textScale, metricsA, metricsB, compare, trailPoints, vowelRefs } = b;
  const showA = isVowelOrApproximant(b.vowelSymbolA);
  const showB = compare && isVowelOrApproximant(b.vowelSymbolB);
  const badgeMetrics = showA ? metricsA : showB ? metricsB : null;
  const badge = badgeMetrics ? `F1 ${badgeMetrics.f1_hz} · F2 ${badgeMetrics.f2_hz} Hz` : undefined;
  const inner = drawModuleShell(ctx, box, 'F1–F2 声学元音图', badge, theme, u, fontFamily, textScale);

  const markers = [
    { metrics: showA ? metricsA : null, symbol: b.vowelSymbolA },
    { metrics: showB ? metricsB : null, symbol: b.vowelSymbolB },
  ];
  const refF1s = vowelRefs.map((r) => r.f1);
  const refF2s = vowelRefs.map((r) => r.f2);

  const f1Min = Math.max(180, Math.min(220, ...refF1s));
  const f1Max = Math.max(920, ...refF1s.map((v) => v + 70));
  const f2Min = Math.max(420, Math.min(540, ...refF2s.map((v) => v - 70)));
  const f2Max = Math.max(2450, ...refF2s.map((v) => v + 140));
  const inView = (f1: number, f2: number) =>
    f1 >= f1Min && f1 <= f1Max && f2 >= f2Min && f2 <= f2Max;

  const tickFs = Math.max(8.5, 9.8 * u * textScale);
  const padL = Math.max(36 * u, tickFs * 3.4);
  const padR = 12 * u;
  const padT = Math.max(15 * u, tickFs * 1.45);
  const padB = Math.max(28 * u, tickFs * 2.75);
  const plot: CardBox = {
    x: inner.x + padL,
    y: inner.y + padT,
    w: Math.max(20, inner.w - padL - padR),
    h: Math.max(20, inner.h - padT - padB),
  };

  const f1Frac = vowelAxisFraction({ min: f1Min, max: f1Max }, 'logarithmic');
  const f2Frac = vowelAxisFraction({ min: f2Min, max: f2Max }, 'logarithmic');
  const fx = (f2: number) => plot.x + (1 - f2Frac(f2)) * plot.w;
  const fy = (f1: number) => plot.y + f1Frac(f1) * plot.h;

  // Logarithmic Gridlines & Ticks
  const xTicks = vowelAxisTicks({ min: f2Min, max: f2Max, step: 200 }, 'logarithmic', plot.w, 42 * u * textScale);
  const yTicks = vowelAxisTicks({ min: f1Min, max: f1Max, step: 100 }, 'logarithmic', plot.h, 26 * u * textScale);

  ctx.save();
  ctx.strokeStyle = theme.subtle;
  ctx.lineWidth = Math.max(0.65, 0.8 * u);
  ctx.font = `500 ${tickFs}px ${MONO_TYPEFACE}`;
  ctx.fillStyle = theme.muted;

  ctx.beginPath();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const hz of xTicks) {
    const px = fx(hz);
    ctx.moveTo(px, plot.y);
    ctx.lineTo(px, plot.y + plot.h);
    ctx.fillText(String(Math.round(hz)), px, plot.y + plot.h + 3.5 * u);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const hz of yTicks) {
    const py = fy(hz);
    ctx.moveTo(plot.x, py);
    ctx.lineTo(plot.x + plot.w, py);
    ctx.fillText(String(Math.round(hz)), plot.x - 5 * u, py);
  }
  ctx.stroke();

  ctx.strokeStyle = theme.border;
  ctx.lineWidth = Math.max(0.85, 1 * u);
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);

  ctx.font = `600 ${Math.max(8, 9.2 * u * textScale)}px ${MONO_TYPEFACE}`;
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText('F1 (Hz · 对数)', plot.x, plot.y - 2.5 * u);
  ctx.textAlign = 'center';
  ctx.fillText('F2 (Hz · 前 ← 对数 → 后)', plot.x + plot.w / 2, inner.y + inner.h - 1 * u);

  // Clip plot interior
  ctx.beginPath();
  ctx.rect(plot.x + 1, plot.y + 1, plot.w - 2, plot.h - 2);
  ctx.clip();

  // Layer 1 (Bottom): Cardinal vowel quadrilateral outline + 29 reference vowel Gaussian peaks
  const bySym = new Map(vowelRefs.map((r) => [vowelSymbolKey(r.symbol), r]));
  const corners = ['i', 'u', 'ɑ', 'a']
    .map((s) => bySym.get(s))
    .filter((v): v is CardVowelRefPoint => Boolean(v));

  if (corners.length >= 3) {
    ctx.save();
    ctx.beginPath();
    corners.forEach((c, idx) => (idx === 0 ? ctx.moveTo(fx(c.f2), fy(c.f1)) : ctx.lineTo(fx(c.f2), fy(c.f1))));
    ctx.closePath();
    ctx.strokeStyle = theme.muted;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = Math.max(0.8, 0.95 * u);
    ctx.setLineDash([3.5 * u, 3 * u]);
    ctx.stroke();
    ctx.restore();
  }

  if (b.showVowelReferenceCloud) {
    const roundingPal = theme.isDark ? VOWEL_ROUNDING_COLORS.dark : VOWEL_ROUNDING_COLORS.light;
    const peakR = Math.max(9.5, 12.5 * u * textScale);
    const refFs = Math.max(8.8, 10.6 * u * textScale);
    ctx.save();
    for (const refPt of vowelRefs) {
      if (!inView(refPt.f1, refPt.f2)) continue;
      const cx = fx(refPt.f2);
      const cy = fy(refPt.f1);
      const rounded = isRoundedVowelSymbol(refPt.symbol);
      const rgb = theme.isMonochrome
        ? (theme.isDark ? '190, 198, 210' : '95, 105, 118')
        : (rounded ? roundingPal.roundedRgb : roundingPal.unroundedRgb);
      const peakAlpha = theme.isDark ? 0.38 : 0.31;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, peakR);
      for (const [stop, wgt] of VOWEL_GAUSSIAN_STOPS) {
        grad.addColorStop(stop, `rgba(${rgb}, ${(peakAlpha * wgt).toFixed(3)})`);
      }
      ctx.beginPath();
      ctx.arc(cx, cy, peakR, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const refPt of vowelRefs) {
      if (!inView(refPt.f1, refPt.f2)) continue;
      const cx = fx(refPt.f2);
      const cy = fy(refPt.f1);
      const rounded = isRoundedVowelSymbol(refPt.symbol);
      const lbl = formatVowelChartLabel(refPt.symbol);
      const fs = lbl.length > 2 ? refFs * 0.85 : refFs;
      ctx.font = `600 ${fs}px ${IPA_TYPEFACE}`;
      ctx.strokeStyle = theme.cardSurface;
      ctx.lineWidth = Math.max(2, 2.5 * u);
      ctx.globalAlpha = 0.85;
      ctx.strokeText(lbl, cx, cy);
      ctx.fillStyle = theme.isMonochrome
        ? theme.muted
        : (rounded ? roundingPal.roundedText : roundingPal.unroundedText);
      ctx.globalAlpha = 0.82;
      ctx.fillText(lbl, cx, cy);
    }
    ctx.restore();
  }

  // Layer 2 (Middle): Dynamic trajectory trail
  if (showA && trailPoints.length >= 2) {
    ctx.save();
    ctx.strokeStyle = theme.primaryInk;
    ctx.lineWidth = Math.max(1.8, 2.4 * u);
    ctx.globalAlpha = 0.72;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    trailPoints.forEach((pt, idx) => (idx === 0 ? ctx.moveTo(fx(pt.f2), fy(pt.f1)) : ctx.lineTo(fx(pt.f2), fy(pt.f1))));
    ctx.stroke();
    ctx.restore();
  }

  // Layer 3 (Top): Active sound marker(s) + Enlarged real-time IPA symbol
  markers.forEach(({ metrics, symbol }, idx) => {
    if (!metrics || !inView(metrics.f1_hz, metrics.f2_hz)) return;
    const px = fx(metrics.f2_hz);
    const py = fy(metrics.f1_hz);
    const r = (idx === 0 ? 6.8 : 5.8) * u;

    // Outer halo ring
    if (idx === 0) {
      ctx.save();
      ctx.fillStyle = theme.fillAlphaPrimary;
      ctx.beginPath();
      ctx.arc(px, py, r * 1.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.fillStyle = idx === 0 ? theme.primaryInk : theme.cardSurface;
    ctx.strokeStyle = idx === 0 ? theme.cardSurface : theme.secondaryInk;
    ctx.lineWidth = Math.max(1.8, 2.3 * u);
    ctx.beginPath();
    if (idx === 0) {
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.moveTo(px, py - r);
      ctx.lineTo(px + r, py);
      ctx.lineTo(px, py + r);
      ctx.lineTo(px - r, py);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    const ipa = symbol.trim().replace(/^[\[/]|[\]/]$/g, '');
    const rawSym = compare ? `${idx === 0 ? 'A' : 'B'} [${ipa}]` : `[${ipa}]`;

    const cleanTag = rawSym.trim();
    if (cleanTag) {
      const labelFs = Math.max(12, 16.5 * u * textScale);
      ctx.save();
      ctx.font = `700 ${labelFs}px ${IPA_TYPEFACE}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const preferAbove = py - plot.y > labelFs * 1.4;
      const ly = preferAbove ? py - r - labelFs * 0.65 : py + r + labelFs * 0.72;
      const tw = ctx.measureText(cleanTag).width;
      const lx = Math.max(plot.x + tw / 2 + 4 * u, Math.min(plot.x + plot.w - tw / 2 - 4 * u, px));

      ctx.lineJoin = 'round';
      ctx.strokeStyle = theme.cardSurface;
      ctx.lineWidth = Math.max(3, 4.5 * u);
      ctx.strokeText(cleanTag, lx, ly);
      ctx.fillStyle = idx === 0 ? theme.primaryInk : theme.secondaryInk;
      ctx.fillText(cleanTag, lx, ly);
      ctx.restore();
    }
  });

  ctx.restore();
}

export function drawArticMetricsBlock(b: AcousticBlockContext): void {
  const { ctx, box, theme, u, fontFamily, textScale, metricsA, glottis, paramsA, paramsB, compare } = b;
  const inner = drawModuleShell(
    ctx,
    box,
    '构音与声门关键参数',
    `F0 ${Math.round(glottis.f0_hz)} Hz · ${Math.round(glottis.pr_pa)} Pa`,
    theme,
    u,
    fontFamily,
    textScale,
  );

  const tileGap = 6 * u;
  const tileH = Math.min(inner.h * 0.32, 42 * u * Math.min(1.2, textScale * 0.85));
  const tiles = [
    { k: '基频 F0', v: `${Math.round(glottis.f0_hz)} Hz` },
    { k: '肺下压 PR', v: `${Math.round(glottis.pr_pa)} Pa` },
    { k: '最窄面积', v: `${metricsA.amin_cm2.toFixed(2)} cm²` },
    { k: 'F1 / F2', v: `${metricsA.f1_hz}/${metricsA.f2_hz}` },
  ];
  const tileW = (inner.w - tileGap * 3) / 4;
  tiles.forEach((t, i) => {
    const tx = inner.x + i * (tileW + tileGap);
    roundRectPath(ctx, tx, inner.y, tileW, tileH, Math.max(3, 5 * u));
    ctx.fillStyle = theme.cardSurface;
    ctx.fill();
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = Math.max(0.7, 0.8 * u);
    ctx.stroke();

    ctx.font = `500 ${Math.max(8, 9 * u * textScale)}px ${fontFamily}`;
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(fitTextEllipsis(ctx, t.k, tileW - 10 * u), tx + 6 * u, inner.y + 4 * u);

    ctx.font = `700 ${Math.max(9, 10.8 * u * textScale)}px ${MONO_TYPEFACE}`;
    ctx.fillStyle = theme.text;
    ctx.textBaseline = 'bottom';
    ctx.fillText(fitTextEllipsis(ctx, t.v, tileW - 10 * u), tx + 6 * u, inner.y + tileH - 4 * u);
  });

  const core6 = VTL_PARAM_META.filter((m) => m.core6);
  const gridTop = inner.y + tileH + 8 * u;
  const gridH = Math.max(12, inner.h - tileH - 8 * u);
  const cols = inner.w > 220 * u ? 2 : 1;
  const rows = Math.ceil(core6.length / cols);
  const colW = (inner.w - (cols - 1) * 10 * u) / cols;
  const rowH = gridH / Math.max(1, rows);

  core6.forEach((meta, idx) => {
    const c = idx % cols;
    const r = Math.floor(idx / cols);
    const rx = inner.x + c * (colW + 10 * u);
    const ry = gridTop + r * rowH;
    const valA = paramsA[meta.key] ?? meta.defaultVal;
    const normA = Math.max(0, Math.min(1, (valA - meta.min) / (meta.max - meta.min)));

    const fs = Math.max(8.5, 9.8 * u * textScale);
    ctx.font = `500 ${fs}px ${fontFamily}`;
    ctx.fillStyle = theme.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const textY = ry + rowH * 0.34;
    ctx.fillText(meta.label, rx, textY);

    ctx.font = `600 ${Math.max(8.5, 9.6 * u * textScale)}px ${MONO_TYPEFACE}`;
    ctx.fillStyle = theme.primaryInk;
    ctx.textAlign = 'right';
    const valText = compare ? `${valA.toFixed(2)} / ${(paramsB[meta.key] ?? 0).toFixed(2)}` : valA.toFixed(2);
    ctx.fillText(valText, rx + colW, textY);

    const barY = ry + rowH * 0.7;
    const barH = Math.max(3.5, 5 * u);
    roundRectPath(ctx, rx, barY, colW, barH, barH / 2);
    ctx.fillStyle = theme.subtle;
    ctx.fill();

    roundRectPath(ctx, rx, barY, Math.max(barH, colW * normA), barH, barH / 2);
    ctx.fillStyle = theme.primaryInk;
    ctx.fill();

    if (compare) {
      const valB = paramsB[meta.key] ?? meta.defaultVal;
      const normB = Math.max(0, Math.min(1, (valB - meta.min) / (meta.max - meta.min)));
      const bx = rx + colW * normB;
      ctx.fillStyle = theme.secondaryInk;
      ctx.fillRect(bx - 1.3 * u, barY - 2 * u, 2.6 * u, barH + 4 * u);
    }
  });
}
