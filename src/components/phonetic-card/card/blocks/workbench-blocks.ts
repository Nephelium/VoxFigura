import { SAMPLE_RATE_HZ, type GlottisM27Params, type PhonationRegime, type TractParamName, type VcProject } from '@vocalcut/core';
import { panelSnapshots } from '@/data/panel-snapshots';
import { m27Session } from '@/components/research/m27-session';
import { evaluateControlPitch } from '@/components/research/control-pitch';
import {
  VOQS_BUILTIN_PRESET_DEFAULTS,
  evalCurveAt,
  formatGlottis9Specs,
} from '@/components/research/voice-mixer';
import { DIALECT_PACKS } from '@/data/dialect-packs';
import { readTimeline } from '@/components/studio/nle-timeline';
import type { CardBox } from '../layout-tree';
import { parseColorRgb, type CardResolvedTheme } from '../card-themes';
import { layoutContinuumGrid, type ContinuumGridLayout } from '../continuum-grid';
import { paintGlottisModelIntoRect, type RasterCardImage, type SubPaneDirection } from './acoustic-blocks';
import type { ResolvedContinuumAsset, ResolvedIpaRichAsset } from '../real-module-assets';
import {
  IPA_TYPEFACE,
  MONO_TYPEFACE,
  drawModuleShell,
  drawPillBadge,
  drawPlayheadCursor,
  fitTextEllipsis,
  roundRectPath,
} from '../draw-primitives';

function clampForDisplay(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface SynthTimelineTrackFlags {
  syllables: boolean;
  phones: boolean;
  phonation: boolean;
  f0: boolean;
  pressure: boolean;
  waveform: boolean;
}

export interface WorkbenchBlockContext {
  ctx: CanvasRenderingContext2D;
  box: CardBox;
  theme: CardResolvedTheme;
  u: number;
  fontFamily: string;
  textScale: number;
  project: VcProject;
  activeClipId: string;
  activeVoiceId: string;
  wordLabel: string;
  ipaLabel: string;
  paramsA: Record<TractParamName, number>;
  glottis: GlottisM27Params;
  ipaAsset?: ResolvedIpaRichAsset | null;
  continuumAsset?: ResolvedContinuumAsset | null;
  continuumGridLayout: ContinuumGridLayout;
  continuumCellIndex?: number;
  vtlImageA?: RasterCardImage | null;
  tractZoom?: number;
  showOrientationCompass?: boolean;
  hasSeparateTractModule?: boolean;
  synthTracks: SynthTimelineTrackFlags;
  showReconGlottis: boolean;
  glottisDirection: SubPaneDirection;
  animated: boolean;
  clipProgress01: number;
  time_s: number;
}

const REGIME_LABELS_ZH: Readonly<Record<PhonationRegime, string>> = {
  modal: '常态 V',
  breathy: '气声 V̤',
  pressed: '紧声 V͈',
  creaky: '嘎裂 V̰',
  falsetto: '假声 F',
  whisper: '耳语 W',
};

function drawMiniTractSilhouette(
  ctx: CanvasRenderingContext2D,
  rect: CardBox,
  params: Record<TractParamName, number>,
  theme: CardResolvedTheme,
  u: number,
  active: boolean,
): void {
  const cx = rect.x + rect.w * 0.48;
  const cy = rect.y + rect.h * 0.56;
  const s = Math.min(rect.w, rect.h) * 0.36;
  const tcx = ((params.TCX ?? 0.5) / 4) * s * 0.38;
  const tcy = -((params.TCY ?? 0) / 3) * s * 0.34;
  const jaw = (Math.abs(params.JA ?? -2) / 7) * s * 0.25;

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  ctx.strokeStyle = active ? theme.primaryInk : theme.muted;
  ctx.lineWidth = Math.max(1.1, (active ? 1.8 : 1.3) * u);
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.8, cy + s * 0.72);
  ctx.quadraticCurveTo(cx - s * 0.82, cy - s * 0.72, cx, cy - s * 0.74);
  ctx.quadraticCurveTo(cx + s * 0.65, cy - s * 0.74, cx + s * 0.88, cy - s * 0.2);
  ctx.stroke();

  ctx.fillStyle = active ? theme.fillAlphaPrimary : theme.subtle;
  ctx.strokeStyle = active ? theme.primaryInk : theme.secondaryInk;
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.6, cy + s * 0.7);
  ctx.bezierCurveTo(
    cx - s * 0.55,
    cy - s * 0.12 + tcy,
    cx + s * 0.24 + tcx,
    cy - s * 0.36 + tcy,
    cx + s * 0.72,
    cy + s * 0.08 + jaw * 0.4,
  );
  ctx.quadraticCurveTo(cx + s * 0.15, cy + s * 0.66 + jaw * 0.4, cx - s * 0.6, cy + s * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function wrapTextLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean || maxW <= 8 || maxLines <= 0) return [];
  const out: string[] = [];
  let line = '';
  for (const ch of Array.from(clean)) {
    if (ctx.measureText(line + ch).width > maxW && line) {
      out.push(line);
      line = ch;
      if (out.length >= maxLines) break;
    } else {
      line += ch;
    }
  }
  if (line && out.length < maxLines) {
    out.push(line);
  } else if (out.length === maxLines && line) {
    out[maxLines - 1] = fitTextEllipsis(ctx, out[maxLines - 1] + line, maxW);
  }
  return out;
}

const themedSpecCache = new WeakMap<Uint8Array, Map<string, HTMLCanvasElement>>();

function getThemedSpectrogramCanvas(
  analysis: NonNullable<ResolvedIpaRichAsset['analysis']>,
  bgColor: string,
  inkColor: string,
): HTMLCanvasElement | null {
  if (typeof document === 'undefined' || analysis.columns <= 0 || analysis.rows <= 0) return null;
  const key = `${bgColor}|${inkColor}`;
  let map = themedSpecCache.get(analysis.spectrum);
  const hit = map?.get(key);
  if (hit) return hit;

  const bg = parseColorRgb(bgColor) ?? [255, 255, 255];
  const ink = parseColorRgb(inkColor) ?? [20, 20, 24];
  const c = document.createElement('canvas');
  c.width = analysis.columns;
  c.height = analysis.rows;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(analysis.columns, analysis.rows);
  const data = img.data;
  const spec = analysis.spectrum;
  for (let i = 0; i < spec.length; i++) {
    const t = Math.pow(spec[i] / 255, 0.92);
    const p = i * 4;
    data[p] = Math.round(bg[0] + (ink[0] - bg[0]) * t);
    data[p + 1] = Math.round(bg[1] + (ink[1] - bg[1]) * t);
    data[p + 2] = Math.round(bg[2] + (ink[2] - bg[2]) * t);
    data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  if (!map) {
    map = new Map();
    themedSpecCache.set(analysis.spectrum, map);
  }
  if (map.size >= 8) {
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
  map.set(key, c);
  return c;
}

/**
 * 1a. IPA Waveform & 0-6kHz Spectrogram Stacked Card (Left column matching IpaPlusView bottom monitor)
 */
export function drawIpaWaveSpecBlock(w: WorkbenchBlockContext): void {
  const { ctx, box, theme, u, fontFamily, textScale } = w;
  const asset = w.ipaAsset;
  const analysis = asset?.analysis ?? null;
  const phones = asset?.referencePhones ?? [];
  const totalSec = Math.max(
    0.2,
    analysis?.duration || asset?.recordingDuration_s || (asset?.m27RowsPa?.length ? asset.m27RowsPa.length / 50 : 1.6),
  );
  const symbolClean = (asset?.symbol || w.ipaLabel || '').replace(/^[\[/]|[\]/]$/g, '').trim();
  const phoneSummary = phones.length
    ? `[${phones.filter((p) => p.label && p.label !== 'sil').map((p) => p.label).join('')}]`
    : symbolClean
      ? `[${symbolClean}]`
      : '';
  const curT = Math.max(0, Math.min(totalSec, w.time_s));
  const badge = `${phoneSummary ? `${phoneSummary} · ` : ''}${curT.toFixed(2)} / ${totalSec.toFixed(2)}s`;
  const inner = drawModuleShell(ctx, box, '波形与语谱图', badge, theme, u, fontFamily, textScale);

  const scaleT = Math.min(1.12, Math.max(0.74, textScale * 0.86));
  const gap = 8 * u;
  const waveH = Math.max(46 * u, (inner.h - gap) * 0.45);
  const specH = Math.max(54 * u, inner.h - gap - waveH);
  const waveBox: CardBox = { x: inner.x, y: inner.y, w: inner.w, h: waveH };
  const specBox: CardBox = { x: inner.x, y: inner.y + waveH + gap, w: inner.w, h: specH };

  // Find target phoneme highlight interval matching IpaPlusView blue band
  const nonSilPhones = phones.filter((p) => p.label && p.label !== 'sil' && p.label !== 'sp');
  const targetInterval =
    nonSilPhones.find((p) => p.label === symbolClean)
    ?? nonSilPhones.find((p) => symbolClean && p.label.includes(symbolClean))
    ?? nonSilPhones[Math.floor(nonSilPhones.length / 2)]
    ?? null;

  const tickFs = Math.max(7.6, 8.8 * u * scaleT);
  const padL = Math.max(30 * u, tickFs * 3.1);
  const padR = 8 * u;
  const padT = 8 * u;
  const padB = Math.max(15 * u, tickFs * 1.65);

  const drawSubFrame = (sub: CardBox): CardBox => {
    roundRectPath(ctx, sub.x, sub.y, sub.w, sub.h, Math.max(4, 6 * u));
    ctx.fillStyle = theme.cardSurface;
    ctx.fill();
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = Math.max(0.75, 0.9 * u);
    ctx.stroke();
    return {
      x: sub.x + padL,
      y: sub.y + padT,
      w: Math.max(18, sub.w - padL - padR),
      h: Math.max(18, sub.h - padT - padB),
    };
  };

  const drawTimeAxisAndOverlay = (plot: CardBox, showPlayhead: boolean) => {
    // Target phone highlight band
    if (targetInterval && totalSec > 0.05) {
      const bx0 = plot.x + Math.max(0, Math.min(1, targetInterval.start_s / totalSec)) * plot.w;
      const bx1 = plot.x + Math.max(0, Math.min(1, targetInterval.end_s / totalSec)) * plot.w;
      if (bx1 - bx0 > 2) {
        ctx.save();
        ctx.fillStyle = theme.fillAlphaPrimary;
        ctx.fillRect(bx0, plot.y, bx1 - bx0, plot.h);
        ctx.strokeStyle = theme.primaryInk;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = Math.max(0.8, 1 * u);
        ctx.beginPath();
        ctx.moveTo(bx0, plot.y);
        ctx.lineTo(bx0, plot.y + plot.h);
        ctx.moveTo(bx1, plot.y);
        ctx.lineTo(bx1, plot.y + plot.h);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Time ticks (5 ticks matching IpaPlusView)
    ctx.save();
    ctx.font = `500 ${tickFs}px ${MONO_TYPEFACE}`;
    ctx.fillStyle = theme.muted;
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 4; i++) {
      const frac = i / 4;
      const px = plot.x + frac * plot.w;
      const tVal = totalSec * frac;
      ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
      ctx.fillText(i === 4 ? `${tVal.toFixed(2)} s` : tVal.toFixed(2), px, plot.y + plot.h + 2.5 * u);
    }
    ctx.restore();

    if (showPlayhead) {
      const headX = plot.x + Math.max(0, Math.min(1, curT / totalSec)) * plot.w;
      drawPlayheadCursor(ctx, headX, plot.y, plot.y + plot.h, null, theme, u, scaleT);
    }
  };

  // --- TOP PANE: High-Density Oscilloscope Waveform ---
  const wavePlot = drawSubFrame(waveBox);
  ctx.save();
  ctx.strokeStyle = theme.subtle;
  ctx.lineWidth = Math.max(0.65, 0.8 * u);
  const midY = wavePlot.y + wavePlot.h / 2;
  ctx.beginPath();
  ctx.moveTo(wavePlot.x, midY);
  ctx.lineTo(wavePlot.x + wavePlot.w, midY);
  ctx.stroke();

  // Compute peak amplitude for Y-axis readout
  let maxAbs = 0.25;
  if (analysis?.waveform?.length) {
    for (let i = 0; i < analysis.waveform.length; i++) {
      const a = Math.abs(analysis.waveform[i]);
      if (a > maxAbs) maxAbs = a;
    }
  }
  const yScale = Math.max(0.15, Math.min(1.0, maxAbs * 1.08));

  ctx.font = `500 ${tickFs}px ${MONO_TYPEFACE}`;
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(`+${yScale.toFixed(2)}`, wavePlot.x - 4 * u, wavePlot.y + 4 * u);
  ctx.fillText('0', wavePlot.x - 4 * u, midY);
  ctx.fillText(`-${yScale.toFixed(2)}`, wavePlot.x - 4 * u, wavePlot.y + wavePlot.h - 4 * u);

  if (analysis && analysis.waveColumns > 1) {
    const cols = analysis.waveColumns;
    const wf = analysis.waveform;
    const mean = analysis.waveMean;
    const halfH = wavePlot.h * 0.46;

    ctx.save();
    ctx.beginPath();
    ctx.rect(wavePlot.x, wavePlot.y, wavePlot.w, wavePlot.h);
    ctx.clip();

    // Filled min-max envelope
    ctx.fillStyle = theme.fillAlphaSecondary;
    ctx.beginPath();
    for (let c = 0; c < cols; c++) {
      const px = wavePlot.x + (c / (cols - 1)) * wavePlot.w;
      const hi = Math.max(-1, Math.min(1, wf[c * 2 + 1] / yScale));
      const py = midY - hi * halfH;
      if (c === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    for (let c = cols - 1; c >= 0; c--) {
      const px = wavePlot.x + (c / (cols - 1)) * wavePlot.w;
      const lo = Math.max(-1, Math.min(1, wf[c * 2] / yScale));
      const py = midY - lo * halfH;
      ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();

    // Crisp envelope outline + central RMS/mean trace
    ctx.strokeStyle = theme.secondaryInk;
    ctx.lineWidth = Math.max(0.9, 1.15 * u);
    ctx.beginPath();
    for (let c = 0; c < cols; c++) {
      const px = wavePlot.x + (c / (cols - 1)) * wavePlot.w;
      const hi = Math.max(-1, Math.min(1, wf[c * 2 + 1] / yScale));
      const lo = Math.max(-1, Math.min(1, wf[c * 2] / yScale));
      ctx.moveTo(px, midY - hi * halfH);
      ctx.lineTo(px, midY - lo * halfH);
    }
    ctx.stroke();

    ctx.strokeStyle = theme.primaryInk;
    ctx.lineWidth = Math.max(0.85, 1.05 * u);
    ctx.beginPath();
    for (let c = 0; c < cols; c++) {
      const px = wavePlot.x + (c / (cols - 1)) * wavePlot.w;
      const mv = Math.max(-1, Math.min(1, mean[c] / yScale));
      const py = midY - mv * halfH;
      if (c === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
  } else {
    ctx.font = `500 ${Math.max(9, 10.5 * u * scaleT)}px ${fontFamily}`;
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('正在载入或该音标暂无参考录音波形', wavePlot.x + wavePlot.w / 2, midY);
  }
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = Math.max(0.7, 0.85 * u);
  ctx.strokeRect(wavePlot.x, wavePlot.y, wavePlot.w, wavePlot.h);
  drawTimeAxisAndOverlay(wavePlot, w.animated || curT > 0.001);
  ctx.restore();

  // --- BOTTOM PANE: Real 0-6 kHz STFT Spectrogram ---
  const specPlot = drawSubFrame(specBox);
  ctx.save();
  const maxKHz = Math.round((analysis?.maximumHz ?? 6000) / 1000);
  ctx.font = `500 ${tickFs}px ${MONO_TYPEFACE}`;
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${maxKHz}k`, specPlot.x - 4 * u, specPlot.y + 5 * u);
  ctx.fillText(`${Math.round(maxKHz / 2)}k`, specPlot.x - 4 * u, specPlot.y + specPlot.h / 2);
  ctx.fillText('0Hz', specPlot.x - 4 * u, specPlot.y + specPlot.h - 4 * u);

  const specCanvas = analysis
    ? getThemedSpectrogramCanvas(analysis, theme.cardSurface, theme.text)
    : asset?.spectrogramImage ?? null;
  if (specCanvas) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(specPlot.x, specPlot.y, specPlot.w, specPlot.h);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(specCanvas, specPlot.x, specPlot.y, specPlot.w, specPlot.h);
    ctx.restore();
  } else {
    ctx.fillStyle = theme.moduleHeaderBg;
    ctx.fillRect(specPlot.x, specPlot.y, specPlot.w, specPlot.h);
    ctx.font = `500 ${Math.max(9, 10.5 * u * scaleT)}px ${fontFamily}`;
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('待载入 0–6 kHz 语谱图', specPlot.x + specPlot.w / 2, specPlot.y + specPlot.h / 2);
  }
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = Math.max(0.7, 0.85 * u);
  ctx.strokeRect(specPlot.x, specPlot.y, specPlot.w, specPlot.h);
  drawTimeAxisAndOverlay(specPlot, w.animated || curT > 0.001);
  ctx.restore();
}

/** 1b. International Phonetic Alphabet Plus / extIPA / VoQS Card (mirrors IpaPlusView right panel with integrated vocal tract!) */
export function drawIpaLexiconBlock(w: WorkbenchBlockContext): void {
  const { ctx, box, theme, u, fontFamily, textScale } = w;
  const snap = panelSnapshots.ipa.value;
  const asset = w.ipaAsset;
  const symbol = asset?.symbol || snap?.symbol || w.ipaLabel.replace(/^[\[/]|[\]/]$/g, '') || 'χ';
  const sys = asset?.system ?? snap?.system ?? 'ipa';
  const codePts = asset?.codePoints?.length ? asset.codePoints : (snap?.codePoints ?? []);
  const sysBadge = codePts.length ? `${sys.toUpperCase()} · ${codePts.slice(0, 2).join(' ')}` : sys.toUpperCase();
  const inner = drawModuleShell(ctx, box, '音标物理构型与语音学阐释', sysBadge, theme, u, fontFamily, textScale);

  // Adaptive typography matching actual module size (no tiny 1.16 ceiling when module is big!)
  const scaleT = Math.min(1.85, Math.max(0.72, textScale * 0.96));
  const embedTract = !w.hasSeparateTractModule && inner.h > 210 * u;
  const topRowH = Math.min(Math.max(54 * u, inner.h * (embedTract ? 0.145 : 0.24)), 98 * u);
  const glyphBoxW = Math.min(topRowH * 1.06, inner.w * 0.24, 92 * u);

  // Top Header Row: Hero Glyph + Zh/En Titles + Reference Status Pill (just like IpaPlusView right panel)
  roundRectPath(ctx, inner.x, inner.y, glyphBoxW, topRowH, Math.max(6, 9 * u));
  ctx.fillStyle = theme.cardSurface;
  ctx.fill();
  ctx.strokeStyle = theme.strongBorder;
  ctx.lineWidth = Math.max(1.1, 1.4 * u);
  ctx.stroke();

  ctx.save();
  ctx.font = `700 ${Math.max(22, Math.min(topRowH * 0.62, glyphBoxW * 0.64))}px ${IPA_TYPEFACE}`;
  ctx.fillStyle = theme.primaryInk;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    fitTextEllipsis(ctx, symbol, glyphBoxW - 8 * u),
    inner.x + glyphBoxW / 2,
    inner.y + topRowH * 0.52,
  );
  ctx.restore();

  const metaX = inner.x + glyphBoxW + 12 * u;
  const metaW = Math.max(24, inner.x + inner.w - metaX);
  let my = inner.y + 1 * u;

  const titleZh = asset?.nameZh || snap?.nameZh || w.wordLabel || '标准国际音标构型';
  const titleEn = asset?.nameEn || snap?.nameEn || 'International Phonetic Alphabet';
  const titleFs = Math.max(12.5, Math.min(topRowH * 0.36, 15.8 * u * scaleT));
  ctx.font = `700 ${titleFs}px ${fontFamily}`;
  ctx.fillStyle = theme.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(fitTextEllipsis(ctx, titleZh, metaW), metaX, my);
  my += titleFs * 1.24;

  const subFs = Math.max(9.5, Math.min(topRowH * 0.22, 11.4 * u * scaleT));
  ctx.font = `500 ${subFs}px ${MONO_TYPEFACE}`;
  ctx.fillStyle = theme.muted;
  ctx.fillText(fitTextEllipsis(ctx, titleEn, metaW), metaX, my);
  my += subFs * 1.32;

  const refBadgeText = asset?.m27RowsPa?.length
    ? `声道重建录音 · 50Hz (${asset.m27RowsPa.length}帧)`
    : asset?.referenceTitle
      ? `实录参考 · ${asset.referenceTitle}`
      : `F0 ${Math.round(w.glottis.f0_hz)}Hz · PR ${Math.round(w.glottis.pr_pa)}Pa`;
  if (my + 13 * u <= inner.y + topRowH + 6 * u) {
    drawPillBadge(
      ctx,
      refBadgeText,
      metaX,
      my + 7.5 * u,
      u * Math.min(1.45, scaleT * 0.78),
      theme.moduleHeaderBg,
      theme.primaryInk,
      theme.border,
      'left',
      fontFamily,
      10.5,
      metaW,
    );
  }

  // Optional Middle Integrated Vocal Tract Sagittal Stage (matches IpaPlusView right panel!)
  let contentTop = inner.y + topRowH + 8 * u;
  if (embedTract) {
    const availH = inner.y + inner.h - contentTop;
    const tractH = Math.max(100 * u, Math.min(availH * 0.49, inner.w * 0.6));
    const tractBox: CardBox = { x: inner.x, y: contentTop, w: inner.w, h: tractH };
    roundRectPath(ctx, tractBox.x, tractBox.y, tractBox.w, tractBox.h, Math.max(5, 7 * u));
    ctx.fillStyle = theme.cardSurface;
    ctx.fill();
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = Math.max(0.8, 0.95 * u);
    ctx.stroke();

    ctx.save();
    roundRectPath(ctx, tractBox.x + 1, tractBox.y + 1, tractBox.w - 2, tractBox.h - 2, Math.max(4, 6 * u));
    ctx.clip();
    if (w.vtlImageA) {
      if (theme.isMonochrome) {
        ctx.filter = theme.isDark ? 'grayscale(100%) contrast(116%) brightness(108%)' : 'grayscale(100%) contrast(118%)';
      }
      const nw = w.vtlImageA instanceof HTMLImageElement ? w.vtlImageA.naturalWidth : w.vtlImageA.width;
      const nh = w.vtlImageA instanceof HTMLImageElement ? w.vtlImageA.naturalHeight : w.vtlImageA.height;
      if (nw > 0 && nh > 0) {
        const vx = tractBox.x + 3 * u;
        const vy = tractBox.y + 3 * u;
        const vw = tractBox.w - 6 * u;
        const vh = tractBox.h - 6 * u;
        const sc = (w.tractZoom ?? 1) * 1.08 * Math.min(vw / nw, vh / nh);
        ctx.drawImage(w.vtlImageA, vx + (vw - nw * sc) / 2, vy + (vh - nh * sc) / 2, nw * sc, nh * sc);
      }
      ctx.filter = 'none';
    } else {
      drawMiniTractSilhouette(ctx, tractBox, w.paramsA, theme, u, true);
    }

    // Subtle VTL 2.4 badge top-left + anatomical compass bottom-right
    drawPillBadge(
      ctx,
      'VTL 2.4 · 2D 真实几何',
      tractBox.x + 8 * u,
      tractBox.y + 13 * u,
      u * Math.min(1.4, scaleT * 0.72),
      theme.moduleHeaderBg,
      theme.secondaryInk,
      theme.border,
      'left',
      MONO_TYPEFACE,
      10,
      tractBox.w * 0.56,
    );
    if (w.showOrientationCompass !== false && tractBox.w > 130 * u && tractBox.h > 90 * u) {
      const compFs = Math.max(8.5, 10.2 * u * Math.min(1.45, scaleT));
      const cx = tractBox.x + tractBox.w - 26 * u;
      const cy = tractBox.y + tractBox.h - 22 * u;
      ctx.font = `500 ${compFs}px ${fontFamily}`;
      ctx.fillStyle = theme.muted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('上', cx, cy - compFs * 1.15);
      ctx.fillText('后—前', cx, cy);
      ctx.fillText('下', cx, cy + compFs * 1.15);
    }
    ctx.restore();

    contentTop += tractH + 8 * u;
  }

  // Body Panel: Adaptive-Font Structured Phonetic Elucidation (fills available space gracefully like IpaPlusView!)
  const bodyY = contentTop;
  const bodyH = Math.max(24, inner.y + inner.h - bodyY);
  const bodyBox: CardBox = { x: inner.x, y: bodyY, w: inner.w, h: bodyH };
  roundRectPath(ctx, bodyBox.x, bodyBox.y, bodyBox.w, bodyBox.h, Math.max(5, 7 * u));
  ctx.fillStyle = theme.cardSurface;
  ctx.fill();
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = Math.max(0.75, 0.9 * u);
  ctx.stroke();

  ctx.save();
  roundRectPath(ctx, bodyBox.x + 1, bodyBox.y + 1, Math.max(2, bodyBox.w - 2), Math.max(2, bodyBox.h - 2), 6 * u);
  ctx.clip();

  const padX = Math.max(10 * u, Math.min(18 * u, bodyBox.w * 0.028));
  const padY = Math.max(8 * u, Math.min(16 * u, bodyBox.h * 0.045));
  const tx = bodyBox.x + padX;
  const tw = Math.max(20, bodyBox.w - padX * 2);
  const bottomLimit = bodyBox.y + bodyBox.h - padY;

  const desc =
    asset?.descriptionZh
    || snap?.descriptionZh
    || `舌背 (${w.paramsA.TCX.toFixed(2)}, ${w.paramsA.TCY.toFixed(2)}) cm · 唇开 ${w.paramsA.LD.toFixed(2)} cm · 腭咽口 ${w.paramsA.VO.toFixed(2)}`;
  const usage = asset?.usageZh || snap?.usageZh || '';
  const contrast = asset?.contrastZh || snap?.contrastZh || '';
  const notes = asset?.notesZh || snap?.notesZh || asset?.representation || '';
  const examples = asset?.examples?.length ? asset.examples : (snap?.examples ?? []);
  const sourceRefs = asset?.sourceRefs?.length ? asset.sourceRefs : (snap?.sourceRefs ?? []);

  const paragraphs: Array<{ label: string; content: string; isCallout: boolean; maxLines: number }> = [
    { label: '发音机制', content: desc, isCallout: false, maxLines: 5 },
    { label: '用法语境', content: usage, isCallout: false, maxLines: 3 },
    { label: '对比辨析', content: contrast, isCallout: true, maxLines: 3 },
    { label: '语音学注记', content: notes, isCallout: false, maxLines: 2 },
  ].filter((p) => Boolean(p.content.trim()));

  // Auto-fit body font size to the box area so large cards have generous, editorial typography and small cards stay unclipped!
  const hasExRow = (examples.length > 0 || codePts.length > 0) && bodyH > 72 * u;
  const hasRefRow = sourceRefs.length > 0 && bodyH > 135 * u;
  const maxBodyFs = Math.max(11, Math.min(26 * u, 14.5 * u * scaleT, bodyBox.w * 0.032, bodyBox.h * 0.088));
  const minBodyFs = Math.max(8.6, 9.6 * u);

  const measureParagraphBlockHeight = (fs: number): number => {
    const lh = fs * 1.54;
    let total = 0;
    ctx.font = `400 ${fs}px ${fontFamily}`;
    for (const p of paragraphs) {
      const prefix = p.label ? `${p.label}：` : '';
      const lines = wrapTextLines(ctx, prefix + p.content, tw - (p.isCallout ? 14 * u : 0), p.maxLines);
      if (!lines.length) continue;
      total += lines.length * lh + (p.isCallout ? fs * 0.85 : fs * 0.45);
    }
    return total;
  };

  let bodyFs = maxBodyFs;
  const footerReserve = (hasExRow ? Math.max(24 * u, bodyFs * 1.75) : 0) + (hasRefRow ? Math.max(15 * u, bodyFs * 1.1) : 0);
  const availTextH = Math.max(24, bottomLimit - (bodyBox.y + padY) - footerReserve);
  while (bodyFs > minBodyFs + 0.5 && measureParagraphBlockHeight(bodyFs) > availTextH) {
    bodyFs -= 0.75;
  }

  const lineH = bodyFs * 1.54;
  const exReserve = hasExRow ? Math.max(24 * u, bodyFs * 1.75) : 0;
  const refReserve = hasRefRow ? Math.max(15 * u, bodyFs * 1.1) : 0;
  const textBottom = bottomLimit - exReserve - refReserve;
  let cy = bodyBox.y + padY;

  for (const p of paragraphs) {
    if (cy + lineH > textBottom) break;
    const availLines = Math.max(1, Math.min(p.maxLines, Math.floor((textBottom - cy) / lineH)));
    ctx.font = `400 ${bodyFs}px ${fontFamily}`;
    const prefix = p.label ? `${p.label}：` : '';
    const lines = wrapTextLines(ctx, prefix + p.content, tw - (p.isCallout ? 14 * u : 0), availLines);
    if (!lines.length) continue;

    if (p.isCallout) {
      const padBox = Math.max(4 * u, bodyFs * 0.28);
      const boxH = lines.length * lineH + padBox * 1.5;
      roundRectPath(ctx, tx, cy - padBox * 0.4, tw, boxH, 5 * u);
      ctx.fillStyle = theme.fillAlphaPrimary;
      ctx.fill();
      ctx.fillStyle = theme.primaryInk;
      ctx.fillRect(tx, cy - padBox * 0.4, Math.max(2.8, 3.4 * u), boxH);
      cy += padBox * 0.35;
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const lx = tx + (p.isCallout ? 10 * u : 0);
      if (i === 0 && p.label) {
        ctx.font = `700 ${bodyFs}px ${fontFamily}`;
        ctx.fillStyle = p.isCallout ? theme.primaryInk : theme.secondaryInk;
        const lblW = ctx.measureText(prefix).width;
        ctx.fillText(prefix, lx, cy);
        ctx.font = `400 ${bodyFs}px ${fontFamily}`;
        ctx.fillStyle = theme.text;
        ctx.fillText(ln.slice(prefix.length), lx + lblW, cy);
      } else {
        ctx.font = `400 ${bodyFs}px ${fontFamily}`;
        ctx.fillStyle = theme.text;
        ctx.fillText(ln, lx, cy);
      }
      cy += lineH;
    }
    cy += p.isCallout ? bodyFs * 0.62 : bodyFs * 0.42;
  }

  // Example chips + Unicode codepoint row (sized proportionally to bodyFs)
  if (hasExRow && cy + 14 * u <= bottomLimit) {
    const chipY = Math.max(cy + bodyFs * 0.5, bottomLimit - exReserve - refReserve + exReserve * 0.45);
    const metaFs = Math.max(9.2, bodyFs * 0.88);
    const pillScale = (metaFs / 10.2);
    let cx = tx;
    ctx.font = `600 ${metaFs}px ${fontFamily}`;
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    if (examples.length > 0) {
      const exTag = '例示：';
      ctx.fillText(exTag, cx, chipY);
      cx += ctx.measureText(exTag).width + 4 * u;
      for (const ex of examples.slice(0, 3)) {
        const lbl = ex.noteZh && ex.noteZh !== '原表例示' ? `${ex.text} · ${ex.noteZh}` : ex.text;
        const remainW = tx + tw - cx - (codePts.length ? Math.max(76 * u, metaFs * 6.5) : 0);
        if (remainW < 34 * u) break;
        const chipW = drawPillBadge(
          ctx,
          lbl,
          cx,
          chipY,
          pillScale,
          theme.moduleHeaderBg,
          theme.text,
          theme.border,
          'left',
          IPA_TYPEFACE,
          10.2,
          remainW,
        );
        cx += chipW + 6 * u;
      }
    }
    if (codePts.length > 0) {
      drawPillBadge(
        ctx,
        `码位 ${codePts[0]}`,
        tx + tw,
        chipY,
        pillScale * 0.94,
        theme.moduleHeaderBg,
        theme.muted,
        theme.border,
        'right',
        MONO_TYPEFACE,
        9.8,
        tw * 0.42,
      );
    }
  }

  // Authoritative provenance footer line
  if (hasRefRow) {
    const srcText = `来源：${sourceRefs
      .slice(0, 2)
      .map((s) => (s.locator ? `${s.title} (${s.locator})` : s.title))
      .join(' · ')}`;
    ctx.font = `500 ${Math.max(8, bodyFs * 0.72)}px ${fontFamily}`;
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(fitTextEllipsis(ctx, srcText, tw), tx, bottomLimit + 1 * u);
  }

  ctx.restore();
}

/**
 * 2. Speech Synthesis Multi-Tier Annotation & Prosody Timeline
 * Supports sub-options for toggling: syllables, phones, VoQS phonation, F0 pitch, subglottal pressure (Pa), and waveform!
 */
export function drawSynthTimelineBlock(w: WorkbenchBlockContext): void {
  const { ctx, box, theme, u, fontFamily, textScale, project, activeClipId, synthTracks } = w;
  const syn = panelSnapshots.synthesis.value;
  const clip = syn?.clip ?? project.clips[activeClipId] ?? null;
  const syllables = clip ? clip.syllable_order.map((id) => clip.syllables[id]).filter(Boolean) : [];
  const totalSmp = clip && clip.end_smp > clip.start_smp ? clip.end_smp - clip.start_smp : SAMPLE_RATE_HZ * 2;
  const durSec = totalSmp / SAMPLE_RATE_HZ;

  const badge = syn?.standardLabel ? `${syn.standardLabel} · ${durSec.toFixed(2)}s` : `${durSec.toFixed(2)} s`;
  const inner = drawModuleShell(ctx, box, '语音合成 · 标注与韵律时间轴', badge, theme, u, fontFamily, textScale);

  type LaneKind = 'waveform' | 'syllables' | 'phones' | 'phonation' | 'f0' | 'pressure';
  const enabledLanes: Array<{ kind: LaneKind; weight: number; tag: string }> = [];
  if (synthTracks.waveform) enabledLanes.push({ kind: 'waveform', weight: 1.05, tag: '波形' });
  if (synthTracks.syllables) enabledLanes.push({ kind: 'syllables', weight: 0.85, tag: '词条' });
  if (synthTracks.phones) enabledLanes.push({ kind: 'phones', weight: 0.85, tag: '音素' });
  if (synthTracks.phonation) enabledLanes.push({ kind: 'phonation', weight: 0.85, tag: '发声' });
  if (synthTracks.f0) enabledLanes.push({ kind: 'f0', weight: 1.55, tag: '基频' });
  if (synthTracks.pressure) enabledLanes.push({ kind: 'pressure', weight: 1.25, tag: '肺压' });
  if (enabledLanes.length === 0) {
    ctx.save();
    ctx.font = `500 ${Math.max(10, 11.5 * u * textScale)}px ${fontFamily}`;
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('请在右侧「模块细节」至少勾选 1 条展示轨道', inner.x + inner.w / 2, inner.y + inner.h / 2);
    ctx.restore();
    return;
  }

  const labelGutterW = inner.w > 240 * u ? Math.max(32 * u, 30 * u * textScale) : 0;
  const laneLeft = inner.x + labelGutterW;
  const laneW = Math.max(16, inner.w - labelGutterW);
  const gapY = 4 * u;
  const usableH = Math.max(enabledLanes.length * 10, inner.h - gapY * (enabledLanes.length - 1));
  const weightSum = enabledLanes.reduce((s, l) => s + l.weight, 0) || 1;

  const startSmp = clip?.start_smp ?? 0;
  const fx = (smp: number) => laneLeft + ((smp - startSmp) / Math.max(1, totalSmp)) * laneW;
  const curSmp = startSmp + w.clipProgress01 * totalSmp;

  let curY = inner.y;
  for (let li = 0; li < enabledLanes.length; li++) {
    const lane = enabledLanes[li];
    const lh = li === enabledLanes.length - 1
      ? inner.y + inner.h - curY
      : usableH * (lane.weight / weightSum);
    const lBox: CardBox = { x: laneLeft, y: curY, w: laneW, h: Math.max(12, lh) };

    if (labelGutterW > 0) {
      ctx.font = `600 ${Math.max(8, 9.2 * u * textScale)}px ${fontFamily}`;
      ctx.fillStyle = theme.muted;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(lane.tag, inner.x, lBox.y + lBox.h / 2);
    }

    roundRectPath(ctx, lBox.x, lBox.y, lBox.w, lBox.h, 4 * u);
    ctx.fillStyle = theme.cardSurface;
    ctx.fill();
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = Math.max(0.75, 0.85 * u);
    ctx.stroke();

    ctx.save();
    roundRectPath(ctx, lBox.x + 1, lBox.y + 1, Math.max(2, lBox.w - 2), Math.max(2, lBox.h - 2), 3 * u);
    ctx.clip();

    if (lane.kind === 'waveform') {
      const buf = syn?.audioBuffer;
      const midY = lBox.y + lBox.h / 2;
      if (buf && buf.length > 0) {
        const ch = buf.getChannelData(0);
        const cols = Math.max(40, Math.min(240, Math.floor(lBox.w / (2.2 * u))));
        const step = Math.max(1, Math.floor(ch.length / cols));
        const colW = lBox.w / cols;
        ctx.fillStyle = theme.primaryInk;
        ctx.globalAlpha = 0.72;
        for (let i = 0; i < cols; i++) {
          let peak = 0;
          const base = i * step;
          for (let j = 0; j < step && base + j < ch.length; j += Math.max(1, Math.floor(step / 8))) {
            const amp = Math.abs(ch[base + j]);
            if (amp > peak) peak = amp;
          }
          const bh = Math.max(1.5 * u, Math.min(lBox.h * 0.88, peak * lBox.h * 0.92));
          ctx.fillRect(lBox.x + i * colW, midY - bh / 2, Math.max(1, colW * 0.72), bh);
        }
      } else {
        ctx.strokeStyle = theme.subtle;
        ctx.beginPath();
        ctx.moveTo(lBox.x, midY);
        ctx.lineTo(lBox.x + lBox.w, midY);
        ctx.stroke();
      }
    } else if (lane.kind === 'syllables') {
      if (syllables.length > 0) {
        for (const syl of syllables) {
          const sx = fx(syl.start_smp);
          const sw = Math.max(2, fx(syl.end_smp) - sx);
          if (w.animated && curSmp >= syl.start_smp && curSmp < syl.end_smp) {
            ctx.fillStyle = theme.fillAlphaPrimary;
            ctx.fillRect(sx, lBox.y, sw, lBox.h);
          }
          ctx.strokeStyle = theme.border;
          ctx.beginPath();
          ctx.moveTo(sx, lBox.y);
          ctx.lineTo(sx, lBox.y + lBox.h);
          ctx.stroke();

          if (sw > 14 * u) {
            ctx.font = `700 ${Math.max(9.5, 11.2 * u * textScale)}px ${fontFamily}`;
            ctx.fillStyle = theme.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(fitTextEllipsis(ctx, syl.text || 'sil', sw - 4 * u), sx + sw / 2, lBox.y + lBox.h / 2);
          }
        }
      } else {
        ctx.font = `500 ${Math.max(9, 10.8 * u * textScale)}px ${fontFamily}`;
        ctx.fillStyle = theme.muted;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(syn?.lyrics || '待输入合成词句', lBox.x + lBox.w / 2, lBox.y + lBox.h / 2);
      }
    } else if (lane.kind === 'phones') {
      const segments = syllables.flatMap((s) => s.segments);
      if (segments.length > 0) {
        for (const seg of segments) {
          const sx = fx(seg.start_smp);
          const sw = Math.max(2, fx(seg.end_smp) - sx);
          const active = w.animated && curSmp >= seg.start_smp && curSmp < seg.end_smp;
          if (active) {
            ctx.fillStyle = theme.badgeBg;
            ctx.fillRect(sx, lBox.y, sw, lBox.h);
          }
          ctx.strokeStyle = theme.subtle;
          ctx.beginPath();
          ctx.moveTo(sx, lBox.y);
          ctx.lineTo(sx, lBox.y + lBox.h);
          ctx.stroke();

          if (sw > 12 * u) {
            ctx.font = `600 ${Math.max(9.5, 11.4 * u * textScale)}px ${IPA_TYPEFACE}`;
            ctx.fillStyle = active ? theme.badgeText : theme.primaryInk;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(fitTextEllipsis(ctx, seg.ipa || 'sil', sw - 2 * u), sx + sw / 2, lBox.y + lBox.h / 2 + 0.5 * u);
          }
        }
      }
    } else if (lane.kind === 'phonation') {
      // Render VoQS phonation anchors & syllable glottis spans
      const anchorMap = clip?.annotation_controls?.phonation_anchors ?? project.phonation_anchors ?? {};
      const anchorOrder = clip?.annotation_controls?.phonation_anchor_order ?? project.phonation_anchor_order ?? [];
      const anchors = anchorOrder
        .map((id) => anchorMap[id])
        .filter((a): a is NonNullable<typeof a> => Boolean(a))
        .sort((a, b) => a.t_smp - b.t_smp);

      const spans: Array<{ s0: number; s1: number; label: string; isNonModal: boolean }> = [];
      if (anchors.length > 0) {
        anchors.forEach((a, idx) => {
          const s0 = Math.max(startSmp, idx === 0 ? startSmp : a.t_smp);
          const s1 = idx + 1 < anchors.length ? anchors[idx + 1].t_smp : startSmp + totalSmp;
          if (s1 > s0) {
            const voqsTag = a.voqs?.symbol ? `${a.voqs.symbol} (${REGIME_LABELS_ZH[a.regime]})` : REGIME_LABELS_ZH[a.regime];
            spans.push({ s0, s1, label: voqsTag, isNonModal: a.regime !== 'modal' || Boolean(a.voqs) });
          }
        });
      } else {
        // Also inspect syllable-level glottis mix overrides
        for (const syl of syllables) {
          const gMix = syl.overrides?.glottis?.[0];
          const regime: PhonationRegime = gMix?.preset ?? 'modal';
          spans.push({
            s0: syl.start_smp,
            s1: syl.end_smp,
            label: REGIME_LABELS_ZH[regime],
            isNonModal: regime !== 'modal',
          });
        }
        if (spans.length === 0) {
          spans.push({ s0: startSmp, s1: startSmp + totalSmp, label: '常态浊声 (Modal · V)', isNonModal: false });
        }
      }

      for (const sp of spans) {
        const sx = fx(sp.s0);
        const sw = Math.max(2, fx(sp.s1) - sx);
        ctx.fillStyle = sp.isNonModal ? theme.fillAlphaSecondary : theme.subtle;
        ctx.globalAlpha = sp.isNonModal ? 0.85 : 0.25;
        ctx.fillRect(sx, lBox.y, sw, lBox.h);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = theme.border;
        ctx.beginPath();
        ctx.moveTo(sx, lBox.y);
        ctx.lineTo(sx, lBox.y + lBox.h);
        ctx.stroke();

        if (sw > 28 * u) {
          ctx.font = `600 ${Math.max(8.5, 10 * u * textScale)}px ${fontFamily}`;
          ctx.fillStyle = sp.isNonModal ? theme.secondaryInk : theme.muted;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(fitTextEllipsis(ctx, sp.label, sw - 6 * u), sx + sw / 2, lBox.y + lBox.h / 2);
        }
      }
    } else if (lane.kind === 'f0') {
      const refHz = project.voices[w.activeVoiceId]?.f0_ref_hz ?? 180;
      const f0Res = clip && syllables.length > 0 ? evaluateControlPitch(project, syllables, clip.end_smp, refHz) : null;
      if (f0Res?.ok && f0Res.value.f0_hz.length >= 2) {
        const { f0_hz, times_smp } = f0Res.value;
        const vals = f0_hz.filter((v) => Number.isFinite(v) && v > 0);
        const minF0 = vals.length ? Math.max(5, Math.min(...vals) - 20) : 60;
        const maxF0 = vals.length ? Math.max(minF0 + 40, Math.max(...vals) + 20) : 320;
        const fy = (hz: number) => lBox.y + lBox.h - ((hz - minF0) / (maxF0 - minF0)) * (lBox.h - 12 * u) - 6 * u;

        ctx.beginPath();
        times_smp.forEach((t, idx) => {
          const px = fx(t);
          const py = fy(f0_hz[idx]);
          if (idx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.strokeStyle = theme.primaryInk;
        ctx.lineWidth = Math.max(1.8, 2.4 * u);
        ctx.stroke();

        const hasPins = Boolean((clip?.annotation_controls?.f0_pins ?? project.f0_pins)?.length);
        ctx.font = `600 ${Math.max(8, 9.2 * u * textScale)}px ${MONO_TYPEFACE}`;
        ctx.fillStyle = theme.muted;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(
          `${hasPins ? 'F0 (qTA + 调制)' : 'qTA F0'} · ${Math.round(minF0)}–${Math.round(maxF0)} Hz`,
          lBox.x + 6 * u,
          lBox.y + 3 * u,
        );
      } else {
        const midY = lBox.y + lBox.h * 0.52;
        ctx.strokeStyle = theme.primaryInk;
        ctx.lineWidth = Math.max(1.6, 2.1 * u);
        ctx.beginPath();
        ctx.moveTo(lBox.x + 6 * u, midY);
        ctx.lineTo(lBox.x + lBox.w - 6 * u, midY);
        ctx.stroke();
        ctx.font = `600 ${Math.max(8, 9.2 * u * textScale)}px ${MONO_TYPEFACE}`;
        ctx.fillStyle = theme.muted;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`F0 ${Math.round(w.glottis.f0_hz)} Hz`, lBox.x + 6 * u, lBox.y + 3 * u);
      }
    } else if (lane.kind === 'pressure') {
      // Subglottal Pressure PR in Pa (strictly Pa, 0..1600 Pa)
      const rowsPa = syn?.m27RowsPa;
      const pts: Array<[number, number]> = [];
      if (rowsPa?.length) {
        rowsPa.forEach((r, idx) => {
          const smp = startSmp + (idx / Math.max(1, rowsPa.length - 1)) * totalSmp;
          pts.push([smp, clampForDisplay(r[18] ?? w.glottis.pr_pa, 0, 1600)]);
        });
      } else if (syllables.length > 0) {
        const nominalPa = Math.max(200, w.glottis.pr_pa || 780);
        pts.push([startSmp, 80]);
        for (const syl of syllables) {
          const customP = syl.overrides?.pressure;
          if (customP?.length) {
            for (const p of customP) {
              pts.push([syl.start_smp + p.u * (syl.end_smp - syl.start_smp), p.pressure_pa]);
            }
          } else {
            const span = syl.end_smp - syl.start_smp;
            const isSil = !syl.text.trim() || syl.text === 'sil';
            pts.push([syl.start_smp + span * 0.12, isSil ? 40 : nominalPa]);
            pts.push([syl.start_smp + span * 0.85, isSil ? 40 : nominalPa * 0.94]);
          }
        }
        pts.push([startSmp + totalSmp, 60]);
      } else {
        pts.push([startSmp, w.glottis.pr_pa], [startSmp + totalSmp, w.glottis.pr_pa]);
      }

      const maxPa = Math.max(1000, Math.ceil(Math.max(850, ...pts.map((p) => p[1])) / 200) * 200);
      const fyPa = (pa: number) => lBox.y + lBox.h - (pa / maxPa) * (lBox.h - 12 * u) - 4 * u;

      ctx.beginPath();
      ctx.moveTo(fx(pts[0][0]), lBox.y + lBox.h);
      for (const [smp, pa] of pts) ctx.lineTo(fx(smp), fyPa(pa));
      ctx.lineTo(fx(pts[pts.length - 1][0]), lBox.y + lBox.h);
      ctx.closePath();
      ctx.fillStyle = theme.fillAlphaSecondary;
      ctx.fill();

      ctx.beginPath();
      pts.forEach(([smp, pa], idx) => (idx === 0 ? ctx.moveTo(fx(smp), fyPa(pa)) : ctx.lineTo(fx(smp), fyPa(pa))));
      ctx.strokeStyle = theme.secondaryInk;
      ctx.lineWidth = Math.max(1.5, 2 * u);
      ctx.stroke();

      ctx.font = `600 ${Math.max(8, 9.2 * u * textScale)}px ${MONO_TYPEFACE}`;
      ctx.fillStyle = theme.muted;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`声门下压 PR (0–${maxPa} Pa)`, lBox.x + 6 * u, lBox.y + 3 * u);
    }

    ctx.restore();
    curY += lBox.h + gapY;
  }

  if (w.animated) {
    drawPlayheadCursor(ctx, laneLeft + w.clipProgress01 * laneW, inner.y, inner.y + inner.h, w.time_s, theme, u, textScale);
  }
}

/**
 * 3. M27 Vocal Tract Dynamic Reconstruction Card (Vox2Tract-Lite)
 * Reuses real 50Hz trajectories from M27ReconstructView, IpaPlusView reference library, Synthesis, or Arranger!
 */
export function drawM27ReconstructBlock(w: WorkbenchBlockContext): void {
  const { ctx, box, theme, u, fontFamily, textScale } = w;
  const sessionRows = m27Session.rows.value;
  const ipaRows = w.ipaAsset?.m27RowsPa ?? panelSnapshots.ipa.value?.m27RowsPa;
  const synRows = panelSnapshots.synthesis.value?.m27RowsPa;
  const arrRows = panelSnapshots.arranger.value?.m27RowsPa;
  const activeRows =
    sessionRows.length >= 2
      ? sessionRows
      : ipaRows && ipaRows.length >= 2
        ? ipaRows
        : synRows && synRows.length >= 2
          ? synRows
          : arrRows && arrRows.length >= 2
            ? arrRows
            : null;
  const sourceTag =
    sessionRows.length >= 2
      ? m27Session.sourceName.value || '反演录音'
      : ipaRows && ipaRows.length >= 2
        ? w.ipaAsset?.referenceTitle || `[${w.ipaAsset?.symbol || 'IPA'}] 音标实录反演`
        : synRows && synRows.length >= 2
          ? '语音合成 50Hz'
          : arrRows && arrRows.length >= 2
            ? '编曲唱段 50Hz'
            : '静态构型';
  const dur =
    sessionRows.length >= 2 && m27Session.mediaDuration.value
      ? m27Session.mediaDuration.value
      : activeRows
        ? activeRows.length / 50
        : 2.0;
  const badge = activeRows ? `${sourceTag} · 50Hz (${activeRows.length} 帧)` : 'Vox2Tract-Lite 轨迹与声门';
  const inner = drawModuleShell(ctx, box, '声道动态重建 · 反演轨迹与声门', badge, theme, u, fontFamily, textScale);

  const canShowGlottis = w.showReconGlottis && inner.w > 250 * u;
  const gapX = 8 * u;
  const wantWideGlottis =
    w.glottisDirection === 'row' || (w.glottisDirection === 'auto' && inner.w / Math.max(1, inner.h) > 2.1);
  const glottisW = canShowGlottis
    ? Math.min(inner.w * (wantWideGlottis ? 0.36 : 0.28), Math.max(132 * u, inner.h * (wantWideGlottis ? 1.55 : 0.92)))
    : 0;
  const leftW = Math.max(40, inner.w - (canShowGlottis ? glottisW + gapX : 0));

  const phones =
    sessionRows.length < 2 && w.ipaAsset?.referencePhones?.length
      ? w.ipaAsset.referencePhones
      : [];
  const phoneRowH = phones.length > 0 && inner.h > 92 * u ? Math.max(18 * u, 18 * u * Math.min(1.15, textScale * 0.85)) : 0;
  const specH = Math.max(20, Math.min(44 * u, (inner.h - phoneRowH) * 0.28));
  let curLeftY = inner.y;

  // Optional Aligned Phone Interval Tier from IPA Reference Library (e.g. [a] [ɸ] [a])
  if (phoneRowH > 0) {
    const pBox: CardBox = { x: inner.x, y: curLeftY, w: leftW, h: phoneRowH };
    roundRectPath(ctx, pBox.x, pBox.y, pBox.w, pBox.h, 4 * u);
    ctx.fillStyle = theme.cardSurface;
    ctx.fill();
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = Math.max(0.7, 0.8 * u);
    ctx.stroke();

    const maxT = Math.max(dur, ...phones.map((p) => p.end_s));
    const curT = w.clipProgress01 * maxT;
    for (const ph of phones) {
      const px0 = pBox.x + (ph.start_s / Math.max(0.05, maxT)) * pBox.w;
      const px1 = pBox.x + (ph.end_s / Math.max(0.05, maxT)) * pBox.w;
      const pw = Math.max(2, px1 - px0);
      const active = w.animated && curT >= ph.start_s && curT < ph.end_s;
      if (active) {
        ctx.fillStyle = theme.fillAlphaPrimary;
        ctx.fillRect(px0, pBox.y + 1, pw, pBox.h - 2);
      }
      ctx.strokeStyle = theme.subtle;
      ctx.beginPath();
      ctx.moveTo(px0, pBox.y);
      ctx.lineTo(px0, pBox.y + pBox.h);
      ctx.stroke();
      if (pw > 14 * u && ph.label) {
        ctx.font = `700 ${Math.max(9, 10.6 * u * Math.min(1.15, textScale * 0.85))}px ${IPA_TYPEFACE}`;
        ctx.fillStyle = active ? theme.primaryInk : theme.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(fitTextEllipsis(ctx, ph.label, pw - 4 * u), px0 + pw / 2, pBox.y + pBox.h / 2);
      }
    }
    curLeftY += phoneRowH + 5 * u;
  }

  const specBox: CardBox = { x: inner.x, y: curLeftY, w: leftW, h: specH };
  const trackBox: CardBox = {
    x: inner.x,
    y: curLeftY + specH + 5 * u,
    w: leftW,
    h: Math.max(16, inner.y + inner.h - (curLeftY + specH + 5 * u)),
  };

  for (const sub of [specBox, trackBox]) {
    roundRectPath(ctx, sub.x, sub.y, sub.w, sub.h, 4 * u);
    ctx.fillStyle = theme.cardSurface;
    ctx.fill();
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = Math.max(0.75, 0.85 * u);
    ctx.stroke();
  }

  // Left-Top: Cached spectrogram bitmap or real 50Hz PR energy envelope
  ctx.save();
  roundRectPath(ctx, specBox.x + 1, specBox.y + 1, specBox.w - 2, specBox.h - 2, 3 * u);
  ctx.clip();
  const bmp = sessionRows.length >= 2 ? m27Session.spectrogramCache.value.bitmap : null;
  if (bmp) {
    if (theme.isMonochrome) ctx.filter = 'grayscale(100%) contrast(115%)';
    ctx.drawImage(bmp, specBox.x, specBox.y, specBox.w, specBox.h);
    ctx.filter = 'none';
  } else {
    const barCount = Math.max(24, Math.min(110, Math.floor(specBox.w / (3.5 * u))));
    const barStep = specBox.w / barCount;
    const midY = specBox.y + specBox.h / 2;
    ctx.fillStyle = theme.primaryInk;
    ctx.globalAlpha = 0.62;
    for (let i = 0; i < barCount; i++) {
      const ratio = i / barCount;
      const pr = activeRows
        ? Math.max(0, Math.min(1, (activeRows[Math.floor(ratio * activeRows.length)]?.[18] ?? 0) / 1100))
        : 0.35 + 0.45 * Math.sin(ratio * Math.PI);
      const bh = Math.max(2 * u, pr * specBox.h * 0.84);
      ctx.fillRect(specBox.x + i * barStep + barStep * 0.16, midY - bh / 2, Math.max(1, barStep * 0.68), bh);
    }
  }
  ctx.restore();

  // Left-Bottom: Multi-channel 50Hz articulatory & glottal trajectories (LD, TCY, F0, PR)
  const channels = [
    { label: '唇开 LD', idx: 5, min: -1.5, max: 3.5, dash: [] as number[] },
    { label: '舌背 TCY', idx: 9, min: -3, max: 1, dash: [4 * u, 2.5 * u] },
    { label: '基频 F0', idx: 17, min: 70, max: 360, dash: [1.8 * u, 2 * u] },
    { label: '肺压 PR', idx: 18, min: 0, max: 1400, dash: [6 * u, 2.5 * u] },
  ];

  ctx.save();
  ctx.beginPath();
  ctx.rect(trackBox.x + 2, trackBox.y + 2, trackBox.w - 4, trackBox.h - 4);
  ctx.clip();

  channels.forEach((ch, cIdx) => {
    ctx.save();
    ctx.strokeStyle =
      cIdx === 0 ? theme.primaryInk : cIdx === 1 ? theme.secondaryInk : cIdx === 2 ? theme.tertiaryInk : theme.muted;
    ctx.lineWidth = Math.max(1.3, (cIdx === 0 ? 2.1 : 1.55) * u);
    if (ch.dash.length) ctx.setLineDash(ch.dash);
    ctx.beginPath();
    const n = activeRows ? activeRows.length : 40;
    for (let i = 0; i < n; i++) {
      const px = trackBox.x + (i / Math.max(1, n - 1)) * trackBox.w;
      const raw = activeRows
        ? (activeRows[i]?.[ch.idx] ?? ch.min)
        : ch.idx === 5
          ? w.paramsA.LD
          : ch.idx === 9
            ? w.paramsA.TCY
            : ch.idx === 17
              ? w.glottis.f0_hz
              : w.glottis.pr_pa;
      const norm = Math.max(0.05, Math.min(0.95, (raw - ch.min) / (ch.max - ch.min)));
      const py = trackBox.y + trackBox.h - norm * (trackBox.h - 22 * u) - 5 * u;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
  });

  let lx = trackBox.x + 8 * u;
  ctx.font = `600 ${Math.max(8, 9.2 * u * Math.min(1.15, textScale * 0.88))}px ${fontFamily}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  channels.forEach((ch, idx) => {
    ctx.fillStyle =
      idx === 0 ? theme.primaryInk : idx === 1 ? theme.secondaryInk : idx === 2 ? theme.tertiaryInk : theme.muted;
    ctx.fillText(ch.label, lx, trackBox.y + 4 * u);
    lx += ctx.measureText(ch.label).width + 12 * u;
  });
  ctx.restore();

  if (w.animated) {
    drawPlayheadCursor(ctx, inner.x + w.clipProgress01 * leftW, inner.y, inner.y + inner.h, w.clipProgress01 * dur, theme, u, textScale);
  }

  // Right Pane: Hyper-realistic Superior Laryngoscopic + Coronal Cover-Body Glottis & Vocal Folds Model!
  if (canShowGlottis) {
    const gBox: CardBox = {
      x: inner.x + leftW + gapX,
      y: inner.y,
      w: glottisW,
      h: inner.h,
    };
    ctx.save();
    roundRectPath(ctx, gBox.x, gBox.y, gBox.w, gBox.h, 5 * u);
    ctx.fillStyle = theme.cardSurface;
    ctx.fill();
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = Math.max(0.8, 0.9 * u);
    ctx.stroke();
    ctx.clip();

    paintGlottisModelIntoRect(ctx, gBox, w.glottis, w.time_s, theme, w.glottisDirection);

    // Only draw compact fallback label when glottis canvas is too narrow for its built-in labels
    if (gBox.w < 190 * u) {
      ctx.font = `600 ${Math.max(7.5, 8.6 * u * Math.min(1.15, textScale * 0.85))}px ${fontFamily}`;
      ctx.fillStyle = theme.muted;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(fitTextEllipsis(ctx, '声门与声带', gBox.w - 12 * u), gBox.x + 6 * u, gBox.y + 4 * u);
    }
    ctx.restore();
  }
}

/** 4. Voice Mixer (Mirrors VoiceMixerView M27CurveEditor with real waveform, gate, intervals & knot handles) */
export function drawVoiceMixerBlock(w: WorkbenchBlockContext): void {
  const { ctx, box, theme, u, fontFamily, textScale } = w;
  const mix = panelSnapshots.mixer.value;
  const fallbackPreset = VOQS_BUILTIN_PRESET_DEFAULTS.breathy;
  const mode = mix?.mode ?? 'preset';
  const titleLabel = mode === 'dual' ? '双人声音属性混合' : (mix?.presetLabel ?? fallbackPreset.label);
  const inner = drawModuleShell(ctx, box, '发声调音台 · 发声态时变调制', titleLabel, theme, u, fontFamily, textScale);

  const specs = formatGlottis9Specs(mix?.source9Phys ?? fallbackPreset.source9_phys_pa).slice(0, 5);
  const footH = specs.length ? Math.min(38 * u, inner.h * 0.25) : 0;
  const plotBox: CardBox = {
    x: inner.x,
    y: inner.y,
    w: inner.w,
    h: Math.max(24, inner.h - (footH ? footH + 6 * u : 0)),
  };

  roundRectPath(ctx, plotBox.x, plotBox.y, plotBox.w, plotBox.h, 5 * u);
  ctx.fillStyle = theme.cardSurface;
  ctx.fill();
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = Math.max(0.75, 0.85 * u);
  ctx.stroke();

  const padL = 32 * u;
  const padR = 10 * u;
  const padT = 14 * u;
  const padB = 18 * u;
  const gx0 = plotBox.x + padL;
  const gy0 = plotBox.y + padT;
  const gw = Math.max(16, plotBox.w - padL - padR);
  const gh = Math.max(14, plotBox.h - padT - padB);
  const durS = Math.max(0.5, mix?.outputDuration_s || mix?.inputDuration_s || 2.5);

  ctx.save();
  ctx.beginPath();
  ctx.rect(plotBox.x + 1, plotBox.y + 1, plotBox.w - 2, plotBox.h - 2);
  ctx.clip();

  // Y-axis percentage grid (0%, 50%, 100%) matching M27CurveEditor
  const tickFs = Math.max(7.2, 8.2 * u * Math.min(1.15, textScale * 0.85));
  ctx.font = `500 ${tickFs}px ${MONO_TYPEFACE}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const pct of [0, 0.5, 1]) {
    const gy = gy0 + gh * (1 - pct);
    ctx.strokeStyle = theme.subtle;
    ctx.lineWidth = Math.max(0.6, 0.75 * u);
    ctx.beginPath();
    ctx.moveTo(gx0, gy);
    ctx.lineTo(gx0 + gw, gy);
    ctx.stroke();
    ctx.fillStyle = theme.muted;
    ctx.fillText(`${Math.round(pct * 100)}%`, gx0 - 5 * u, gy);
  }

  // X-axis time ticks (0.0s .. durS)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const tx = gx0 + frac * gw;
    ctx.fillStyle = theme.muted;
    ctx.fillText(`${(frac * durS).toFixed(1)}s`, tx, gy0 + gh + 3 * u);
  }

  // Real voiced gate protection shading (from M27CurveEditor)
  if (mix?.gateSeries?.length) {
    const gArr = mix.gateSeries;
    const stepW = gw / gArr.length;
    ctx.fillStyle = theme.subtle;
    ctx.globalAlpha = 0.22;
    for (let i = 0; i < gArr.length; i++) {
      if (gArr[i] < 0.25) ctx.fillRect(gx0 + i * stepW, gy0, Math.max(1, stepW), gh);
    }
    ctx.globalAlpha = 1;
  }

  // Real waveform background
  if (mix?.waveformPeaks?.length) {
    const peaks = mix.waveformPeaks;
    const midY = gy0 + gh * 0.5;
    ctx.fillStyle = theme.subtle;
    ctx.globalAlpha = 0.52;
    const step = gw / peaks.length;
    peaks.forEach((pk, idx) => {
      const h = Math.max(1, pk * gh * 0.78);
      ctx.fillRect(gx0 + idx * step, midY - h / 2, Math.max(1, step * 0.72), h);
    });
    ctx.globalAlpha = 1;
  }

  // Aligned phoneme interval dividers when TextGrid / Vox2Align-Lite intervals exist
  if (mix?.alignIntervals?.length) {
    ctx.font = `600 ${Math.max(7.2, 8 * u)}px ${IPA_TYPEFACE}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const iv of mix.alignIntervals) {
      const x0 = gx0 + (iv.xmin / durS) * gw;
      const x1 = gx0 + (iv.xmax / durS) * gw;
      ctx.strokeStyle = theme.subtle;
      ctx.beginPath();
      ctx.moveTo(x0, gy0);
      ctx.lineTo(x0, gy0 + gh);
      ctx.stroke();
      if (iv.text && x1 - x0 > 14 * u) {
        ctx.fillStyle = theme.muted;
        ctx.fillText(fitTextEllipsis(ctx, iv.text, x1 - x0 - 2 * u), (x0 + x1) / 2, gy0 + 2 * u);
      }
    }
  }

  const curveKeys = mode === 'preset' ? ['preset'] : (mix?.enabledGroups?.length ? mix.enabledGroups.slice(0, 3) : ['glottis', 'tongue_jaw']);
  const interp = mix?.interpolation ?? 'smoothstep';
  let activePct = 0;

  curveKeys.forEach((key, idx) => {
    const knots = mix?.curves[key] ?? [{ t: 0, v: 0.05 }, { t: 0.5, v: 0.85 }, { t: 1, v: 0.65 }];
    const steps = 60;
    const strokeCol = idx === 0 ? theme.primaryInk : idx === 1 ? theme.secondaryInk : theme.tertiaryInk;
    if (idx === 0) {
      activePct = Math.round(evalCurveAt(knots, w.clipProgress01, interp) * 100);
      ctx.beginPath();
      ctx.moveTo(gx0, gy0 + gh);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const val = Math.max(0, Math.min(1, evalCurveAt(knots, t, interp)));
        ctx.lineTo(gx0 + t * gw, gy0 + gh - val * gh);
      }
      ctx.lineTo(gx0 + gw, gy0 + gh);
      ctx.closePath();
      ctx.fillStyle = theme.fillAlphaPrimary;
      ctx.fill();
    }

    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = Math.max(1.7, (idx === 0 ? 2.4 : 1.7) * u);
    if (idx > 0 && theme.isMonochrome) ctx.setLineDash([4 * u, 3 * u]);
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const val = Math.max(0, Math.min(1, evalCurveAt(knots, t, interp)));
      const px = gx0 + t * gw;
      const py = gy0 + gh - val * gh;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw real M27CurveEditor knot handles
    for (const knot of knots) {
      const kx = gx0 + Math.max(0, Math.min(1, knot.t)) * gw;
      const ky = gy0 + gh - Math.max(0, Math.min(1, knot.v)) * gh;
      ctx.beginPath();
      ctx.arc(kx, ky, Math.max(3, 3.8 * u), 0, Math.PI * 2);
      ctx.fillStyle = theme.cardSurface;
      ctx.fill();
      ctx.strokeStyle = strokeCol;
      ctx.lineWidth = Math.max(1.4, 1.8 * u);
      ctx.stroke();
    }
  });

  if (w.animated) {
    const cx = gx0 + w.clipProgress01 * gw;
    drawPlayheadCursor(ctx, cx, gy0, gy0 + gh, null, theme, u, textScale);
    drawPillBadge(ctx, `调制 ${activePct}%`, cx, gy0 + 11 * u, u * textScale * 0.72, theme.badgeBg, theme.badgeText, null, 'center');
  }
  ctx.restore();

  if (footH > 0) {
    const fy = plotBox.y + plotBox.h + 6 * u;
    const gap = 5 * u;
    const maxCards = Math.max(2, Math.min(specs.length, Math.floor((inner.w + gap) / (58 * u))));
    const shownSpecs = specs.slice(0, maxCards);
    const cw = (inner.w - gap * (shownSpecs.length - 1)) / shownSpecs.length;
    shownSpecs.forEach((sp, i) => {
      const sx = inner.x + i * (cw + gap);
      roundRectPath(ctx, sx, fy, cw, footH, 4 * u);
      ctx.fillStyle = theme.cardSurface;
      ctx.fill();
      ctx.strokeStyle = theme.border;
      ctx.stroke();

      ctx.save();
      roundRectPath(ctx, sx + 1, fy + 1, Math.max(2, cw - 2), Math.max(2, footH - 2), 3 * u);
      ctx.clip();
      const maxTxtW = Math.max(12, cw - 8 * u);
      ctx.font = `500 ${Math.max(7.5, 8.6 * u * Math.min(1.15, textScale * 0.85))}px ${fontFamily}`;
      ctx.fillStyle = theme.muted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(fitTextEllipsis(ctx, sp.key, maxTxtW), sx + cw / 2, fy + 3 * u);

      ctx.font = `700 ${Math.max(8.5, 9.6 * u * Math.min(1.15, textScale * 0.85))}px ${MONO_TYPEFACE}`;
      ctx.fillStyle = theme.text;
      ctx.textBaseline = 'bottom';
      const valStr = `${sp.value}${sp.unit ? ' ' + sp.unit : ''}`;
      ctx.fillText(fitTextEllipsis(ctx, valStr, maxTxtW), sx + cw / 2, fy + footH - 3 * u);
      ctx.restore();
    });
  }
}

export function drawContinuumGridBlock(w: WorkbenchBlockContext): void {
  const { ctx, box, theme, u, fontFamily, textScale } = w;
  const asset = w.continuumAsset;
  const labelPair = asset ? `${asset.ipaA || asset.labelA} → ${asset.ipaB || asset.labelB}` : '';
  const inner = drawModuleShell(ctx, box, '声道连续统 · 刺激卡片序列', labelPair, theme, u, fontFamily, textScale);
  if (!asset?.cells.length) return;

  const { columns: cols, rows, positions } = layoutContinuumGrid(
    asset.cells.length, inner.w, inner.h, asset.dualAxis ? asset.columns : undefined, w.continuumGridLayout,
  );
  const gap = Math.min(6 * u, inner.w / cols * 0.12, inner.h / rows * 0.12);
  const cellW = (inner.w - gap * (cols - 1)) / cols;
  const cellH = (inner.h - gap * (rows - 1)) / rows;
  const activeIdx = w.animated ? w.continuumCellIndex : undefined;
  const scaleT = Math.min(1.12, Math.max(0.75, textScale * 0.86));
  const pad = Math.min(5 * u, cellW * 0.08, cellH * 0.08);
  const topFs = Math.min(Math.max(7.6, 8.8 * u * scaleT), cellH * 0.22, cellW * 0.28);
  const footFs = Math.min(Math.max(7.2, 8.4 * u * scaleT), cellH * 0.19, cellW * 0.11);

  asset.cells.forEach((cell, idx) => {
    const { row, column } = positions[idx];
    const cx = inner.x + column * (cellW + gap);
    const cy = inner.y + row * (cellH + gap);
    const isHit = idx === activeIdx;

    roundRectPath(ctx, cx, cy, cellW, cellH, Math.max(4, 6 * u));
    ctx.fillStyle = isHit ? theme.moduleHeaderBg : theme.cardSurface;
    ctx.fill();
    ctx.strokeStyle = isHit ? theme.primaryInk : theme.border;
    ctx.lineWidth = Math.max(0.85, (isHit ? 2.0 : 0.95) * u);
    ctx.stroke();
    ctx.save();
    ctx.clip();

    const headH = topFs + pad * 2;
    ctx.font = `700 ${topFs}px ${MONO_TYPEFACE}`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = theme.text;
    ctx.textAlign = 'left';
    const number = asset.dualAxis ? `${cell.stepA}·${cell.stepB}` : String(cell.stepA);
    ctx.fillText(number, cx + pad, cy + pad, cellW - pad * 2);
    const badgeWidth = cellW - ctx.measureText(number).width - pad * 3;
    if (badgeWidth >= topFs * 2) {
      ctx.fillStyle = isHit ? theme.primaryInk : theme.secondaryInk;
      ctx.textAlign = 'right';
      ctx.fillText(fitTextEllipsis(ctx, cell.axisBadge, badgeWidth), cx + cellW - pad, cy + pad);
    }

    const footH = footFs + pad * 2;
    const imgBox: CardBox = {
      x: cx + pad,
      y: cy + headH,
      w: cellW - pad * 2,
      h: cellH - headH - footH,
    };

    if (cell.tractImage) {
      const iw = 'naturalWidth' in cell.tractImage ? cell.tractImage.naturalWidth : cell.tractImage.width;
      const ih = 'naturalHeight' in cell.tractImage ? cell.tractImage.naturalHeight : cell.tractImage.height;
      const scale = Math.min(imgBox.w / iw, imgBox.h / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      const dx = imgBox.x + (imgBox.w - dw) / 2;
      const dy = imgBox.y + (imgBox.h - dh) / 2;
      ctx.save();
      if (theme.isMonochrome) ctx.filter = 'grayscale(100%) contrast(112%)';
      ctx.drawImage(cell.tractImage, dx, dy, dw, dh);
      ctx.restore();
    } else {
      ctx.font = `${footFs}px ${fontFamily}`;
      ctx.fillStyle = theme.muted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('声道几何未就绪', cx + cellW / 2, imgBox.y + imgBox.h / 2, imgBox.w);
    }

    const m = cell.metrics;
    ctx.font = `600 ${footFs}px ${MONO_TYPEFACE}`;
    ctx.fillStyle = theme.muted;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText(`F1 ${m?.f1_hz || '—'}`, cx + pad, cy + cellH - pad, cellW * 0.45);
    ctx.textAlign = 'right';
    ctx.fillText(`F2 ${m?.f2_hz || '—'}`, cx + cellW - pad, cy + cellH - pad, cellW * 0.45);
    ctx.restore();
  });
}

/** 6. Dialect Pack Chao 5-Level Tone Contour & Sandhi Trace */
export function drawDialectSandhiBlock(w: WorkbenchBlockContext): void {
  const { ctx, box, theme, u, fontFamily, textScale } = w;
  const dia = panelSnapshots.dialect.value;
  const fallbackPack = DIALECT_PACKS.yue;
  const packName = dia?.packName ?? fallbackPack.name;
  const tones = dia?.tones?.length ? dia.tones : fallbackPack.tones;
  const inner = drawModuleShell(ctx, box, '方言五度调值与连读变调', packName, theme, u, fontFamily, textScale);

  const splitCols = inner.w > 250 * u;
  const leftW = splitCols ? inner.w * 0.56 : inner.w;
  const chartBox: CardBox = { x: inner.x, y: inner.y, w: leftW, h: inner.h };

  roundRectPath(ctx, chartBox.x, chartBox.y, chartBox.w, chartBox.h, 5 * u);
  ctx.fillStyle = theme.cardSurface;
  ctx.fill();
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = Math.max(0.75, 0.85 * u);
  ctx.stroke();

  const padL = 24 * u;
  const padR = 12 * u;
  const padT = 12 * u;
  const padB = 12 * u;
  const pw = Math.max(10, chartBox.w - padL - padR);
  const ph = Math.max(10, chartBox.h - padT - padB);
  const lvY = (lv: number) => chartBox.y + padT + ((5 - lv) / 4) * ph;

  ctx.font = `600 ${Math.max(8, 9.6 * u * textScale)}px ${MONO_TYPEFACE}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let lv = 1; lv <= 5; lv++) {
    const py = lvY(lv);
    ctx.strokeStyle = theme.subtle;
    ctx.beginPath();
    ctx.moveTo(chartBox.x + padL, py);
    ctx.lineTo(chartBox.x + padL + pw, py);
    ctx.stroke();
    ctx.fillStyle = theme.muted;
    ctx.fillText(String(lv), chartBox.x + padL - 5 * u, py);
  }

  const activeIdx = dia?.activeToneIdx ?? 0;
  tones.slice(0, 6).forEach((tone, idx) => {
    const isSel = idx === activeIdx;
    const digits = Array.from(tone.chao).map((d) => Number(d)).filter((n) => n >= 1 && n <= 5);
    const pts = digits.length >= 2 ? digits : digits.length === 1 ? [digits[0], digits[0]] : [3, 3];
    ctx.save();
    ctx.strokeStyle = isSel ? theme.primaryInk : theme.muted;
    ctx.globalAlpha = isSel ? 1 : 0.42;
    ctx.lineWidth = Math.max(1.2, (isSel ? 2.4 : 1.4) * u);
    ctx.beginPath();
    pts.forEach((lv, k) => {
      const px = chartBox.x + padL + (k / (pts.length - 1)) * (pw * (tone.checked ? 0.55 : 1));
      const py = lvY(lv);
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.restore();
  });

  if (splitCols) {
    const rx = chartBox.x + chartBox.w + 8 * u;
    const rw = inner.x + inner.w - rx;
    roundRectPath(ctx, rx, inner.y, rw, inner.h, 5 * u);
    ctx.fillStyle = theme.cardSurface;
    ctx.fill();
    ctx.strokeStyle = theme.border;
    ctx.stroke();

    ctx.font = `700 ${Math.max(9, 10.6 * u * textScale)}px ${fontFamily}`;
    ctx.fillStyle = theme.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('调类与变调推导', rx + 8 * u, inner.y + 7 * u);

    let ry = inner.y + 26 * u * Math.min(1.2, textScale * 0.85);
    if (dia?.sandboxTrace?.length) {
      dia.sandboxTrace.slice(0, 4).forEach((item, idx) => {
        if (ry + 16 * u > inner.y + inner.h) return;
        ctx.font = `600 ${Math.max(8.5, 9.8 * u * textScale)}px ${MONO_TYPEFACE}`;
        ctx.fillStyle = item.rewritten_by ? theme.primaryInk : theme.muted;
        const txt = `#${idx + 1}  ${item.text || item.original_tone_id} → [${item.levels}${item.checked ? '̚' : ''}]`;
        ctx.fillText(fitTextEllipsis(ctx, txt, rw - 16 * u), rx + 8 * u, ry);
        ry += 18 * u * Math.min(1.2, textScale * 0.85);
      });
    } else {
      tones.slice(0, 4).forEach((t, idx) => {
        if (ry + 15 * u > inner.y + inner.h) return;
        ctx.font = `${idx === activeIdx ? '700' : '500'} ${Math.max(8.5, 9.8 * u * textScale)}px ${fontFamily}`;
        ctx.fillStyle = idx === activeIdx ? theme.primaryInk : theme.text;
        ctx.fillText(fitTextEllipsis(ctx, `${t.name}  [${t.chao}${t.checked ? '̚' : ''}]`, rw - 16 * u), rx + 8 * u, ry);
        ry += 17 * u * Math.min(1.2, textScale * 0.85);
      });
    }
  }
}

/** 7. Studio Arranger: Numbered Musical Notation (Jianpu) & Piano Roll */
export function drawArrangerRollBlock(w: WorkbenchBlockContext): void {
  const { ctx, box, theme, u, fontFamily, textScale } = w;
  const arr = panelSnapshots.arranger.value;
  const bpm = arr?.bpm ?? w.project.settings.tempo_map[0]?.bpm ?? 92;
  const tonic = arr?.tonic ?? 'C';
  const badge = `1 = ${tonic} · ${bpm} BPM`;
  const inner = drawModuleShell(ctx, box, '编曲 · 逐字简谱与钢琴卷帘', badge, theme, u, fontFamily, textScale);

  const notes = arr?.notes?.length
    ? arr.notes
    : [
        { text: '春', ipa: 'tʂʰwən', midi: 60, noteLabel: '1', start_smp: 0, end_smp: 24000 },
        { text: '江', ipa: 'tɕjɑŋ', midi: 62, noteLabel: '2', start_smp: 24000, end_smp: 48000 },
        { text: '潮', ipa: 'tʂʰɑʊ', midi: 64, noteLabel: '3', start_smp: 48000, end_smp: 72000 },
        { text: '水', ipa: 'ʂweɪ', midi: 67, noteLabel: '5', start_smp: 72000, end_smp: 108000 },
      ];
  const endSmp = Math.max(1, arr?.endSmp || notes[notes.length - 1].end_smp);
  const scoreRowH = Math.max(24, Math.min(38 * u, inner.h * 0.27));
  const rollTop = inner.y + scoreRowH + 5 * u;
  const rollH = Math.max(18, inner.y + inner.h - rollTop);
  const fx = (smp: number) => inner.x + (smp / endSmp) * inner.w;
  const curSmp = w.clipProgress01 * endSmp;

  roundRectPath(ctx, inner.x, inner.y, inner.w, scoreRowH, 4 * u);
  ctx.fillStyle = theme.cardSurface;
  ctx.fill();
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = Math.max(0.75, 0.85 * u);
  ctx.stroke();

  for (const n of notes) {
    const nx = fx(n.start_smp);
    const nw = Math.max(4, fx(n.end_smp) - nx);
    if (nw > 14 * u) {
      ctx.font = `700 ${Math.max(8.5, 9.8 * u * textScale)}px ${MONO_TYPEFACE}`;
      ctx.fillStyle = theme.primaryInk;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(n.noteLabel || '1', nx + nw / 2, inner.y + 3 * u);

      ctx.font = `600 ${Math.max(8.5, 9.8 * u * textScale)}px ${fontFamily}`;
      ctx.fillStyle = theme.text;
      ctx.textBaseline = 'bottom';
      ctx.fillText(fitTextEllipsis(ctx, n.text, nw - 2 * u), nx + nw / 2, inner.y + scoreRowH - 2 * u);
    }
  }

  roundRectPath(ctx, inner.x, rollTop, inner.w, rollH, 4 * u);
  ctx.fillStyle = theme.cardSurface;
  ctx.fill();
  ctx.strokeStyle = theme.border;
  ctx.stroke();

  const midis = notes.map((n) => n.midi ?? 60);
  const minMidi = Math.min(...midis) - 2;
  const maxMidi = Math.max(minMidi + 7, Math.max(...midis) + 2);
  const midiSpan = maxMidi - minMidi + 1;
  const noteH = Math.max(4 * u, (rollH - 8 * u) / midiSpan);
  const fyMidi = (m: number) => rollTop + rollH - 4 * u - (m - minMidi + 1) * noteH;

  ctx.save();
  ctx.beginPath();
  ctx.rect(inner.x + 1, rollTop + 1, inner.w - 2, rollH - 2);
  ctx.clip();

  ctx.strokeStyle = theme.subtle;
  ctx.lineWidth = Math.max(0.5, 0.65 * u);
  for (let m = minMidi; m <= maxMidi; m += 2) {
    const gy = fyMidi(m);
    ctx.beginPath();
    ctx.moveTo(inner.x, gy);
    ctx.lineTo(inner.x + inner.w, gy);
    ctx.stroke();
  }

  for (const n of notes) {
    if (n.midi == null) continue;
    const nx = fx(n.start_smp);
    const nw = Math.max(3 * u, fx(n.end_smp) - nx - 1.5 * u);
    const ny = fyMidi(n.midi);
    const active = w.animated && curSmp >= n.start_smp && curSmp < n.end_smp;
    roundRectPath(ctx, nx, ny, nw, Math.max(5 * u, noteH * 0.9), 3 * u);
    ctx.fillStyle = active ? theme.primaryInk : theme.fillAlphaPrimary;
    ctx.fill();
    ctx.strokeStyle = theme.primaryInk;
    ctx.lineWidth = Math.max(1, 1.2 * u);
    ctx.stroke();
  }

  if (arr?.f0Points?.length) {
    ctx.strokeStyle = theme.secondaryInk;
    ctx.lineWidth = Math.max(1.5, 2.0 * u);
    ctx.beginPath();
    arr.f0Points.forEach((pt, idx) => {
      const midiFloat = 69 + 12 * Math.log2(Math.max(40, pt.f0_hz) / 440);
      const px = fx(pt.t_smp);
      const py = fyMidi(midiFloat) + noteH / 2;
      if (idx === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }
  ctx.restore();

  if (w.animated) {
    drawPlayheadCursor(ctx, inner.x + w.clipProgress01 * inner.w, inner.y, inner.y + inner.h, (w.clipProgress01 * endSmp) / SAMPLE_RATE_HZ, theme, u, textScale);
  }
}

/** 8. Studio Stage NLE Multi-Track Overview */
export function drawStageNleBlock(w: WorkbenchBlockContext): void {
  const { ctx, box, theme, u, fontFamily, textScale, project, activeClipId } = w;
  const clips = readTimeline(project, activeClipId);
  const endSmp = Math.max(SAMPLE_RATE_HZ * 3, ...clips.map((c) => c.endSmp));
  const durSec = endSmp / SAMPLE_RATE_HZ;
  const inner = drawModuleShell(
    ctx,
    box,
    '多轨时间线排布',
    `${clips.length} 片段 · ${durSec.toFixed(1)}s`,
    theme,
    u,
    fontFamily,
    textScale,
  );

  const trackDefs = [
    { id: 'v1', name: 'V1 声道动画' },
    { id: 'v3', name: 'V3 字幕层' },
    { id: 'a1', name: 'A1 主唱轨' },
    { id: 'a2', name: 'A2 伴奏轨' },
  ];
  const labelW = Math.min(86 * u * Math.min(1.2, textScale * 0.85), inner.w * 0.25);
  const laneX = inner.x + labelW + 6 * u;
  const laneW = Math.max(16, inner.w - labelW - 6 * u);
  const rowGap = 4 * u;
  const rowH = (inner.h - rowGap * (trackDefs.length - 1)) / trackDefs.length;
  const fx = (smp: number) => laneX + (smp / endSmp) * laneW;

  trackDefs.forEach((tr, idx) => {
    const ry = inner.y + idx * (rowH + rowGap);
    ctx.font = `600 ${Math.max(8, 9.4 * u * textScale)}px ${fontFamily}`;
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(fitTextEllipsis(ctx, tr.name, labelW), inner.x, ry + rowH / 2);

    roundRectPath(ctx, laneX, ry, laneW, rowH, 4 * u);
    ctx.fillStyle = theme.cardSurface;
    ctx.fill();
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = Math.max(0.7, 0.8 * u);
    ctx.stroke();

    const trackClips = clips.filter((c) => c.track === tr.id);
    if (trackClips.length > 0) {
      for (const c of trackClips) {
        const cx = fx(c.startSmp);
        const cw = Math.max(6 * u, fx(c.endSmp) - cx);
        roundRectPath(ctx, cx, ry + 2 * u, cw, Math.max(4, rowH - 4 * u), 3 * u);
        ctx.fillStyle = idx % 2 === 0 ? theme.fillAlphaPrimary : theme.fillAlphaSecondary;
        ctx.fill();
        ctx.strokeStyle = idx % 2 === 0 ? theme.primaryInk : theme.secondaryInk;
        ctx.lineWidth = Math.max(0.9, 1.1 * u);
        ctx.stroke();

        if (cw > 28 * u) {
          ctx.font = `600 ${Math.max(8, 9.2 * u * textScale)}px ${fontFamily}`;
          ctx.fillStyle = theme.text;
          ctx.textAlign = 'left';
          ctx.fillText(fitTextEllipsis(ctx, c.label || tr.name, cw - 8 * u), cx + 5 * u, ry + rowH / 2);
        }
      }
    } else if (idx === 0 || idx === 2) {
      const cw = laneW * 0.72;
      roundRectPath(ctx, laneX + 4 * u, ry + 2 * u, cw, Math.max(4, rowH - 4 * u), 3 * u);
      ctx.fillStyle = theme.fillAlphaPrimary;
      ctx.fill();
      ctx.strokeStyle = theme.primaryInk;
      ctx.stroke();
      ctx.font = `600 ${Math.max(8, 9.2 * u * textScale)}px ${fontFamily}`;
      ctx.fillStyle = theme.text;
      ctx.fillText(fitTextEllipsis(ctx, project.name || '工程片段', cw - 10 * u), laneX + 9 * u, ry + rowH / 2);
    }
  });

  if (w.animated) {
    drawPlayheadCursor(ctx, laneX + w.clipProgress01 * laneW, inner.y, inner.y + inner.h, w.clipProgress01 * durSec, theme, u, textScale);
  }
}
