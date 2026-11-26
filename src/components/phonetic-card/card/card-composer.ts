import type { GlottisM27Params, TractParamName, VcProject } from '@vocalcut/core';
import type { TractMetrics } from '@/stores/workbench';
import type { TractPoseExtras } from '@/data/ptb-ipa-presets';
import type { PtbPoseSnapshot } from '@/components/research/ptb-physics-charts';
import {
  computeLayoutBoxesAndGutters,
  type CardBox,
  type CardGutter,
  type CardLayoutNode,
  type CardModuleBox,
} from './layout-tree';
import { resolveCardTheme, type CardColorPresetId, type CardSkinChoice } from './card-themes';
import type { CardVowelRefPoint } from './vowel-ref-data';
import {
  IPA_TYPEFACE,
  MONO_TYPEFACE,
  drawInstrumentGridBackdrop,
  drawPillBadge,
  drawStyledSurfaceBox,
  fitTextEllipsis,
  resolveCardFontFamily,
  type CardFontId,
} from './draw-primitives';
import {
  drawAreaFnBlock,
  drawArticMetricsBlock,
  drawCrossLipBlock,
  drawGlottisModelBlock,
  drawTractProfileBlock,
  drawTransferFnBlock,
  drawVowelSpaceBlock,
  type AcousticBlockContext,
  type RasterCardImage,
  type SubPaneDirection,
} from './blocks/acoustic-blocks';
import {
  drawArrangerRollBlock,
  drawContinuumGridBlock,
  drawDialectSandhiBlock,
  drawIpaLexiconBlock,
  drawIpaWaveSpecBlock,
  drawM27ReconstructBlock,
  drawStageNleBlock,
  drawSynthTimelineBlock,
  drawVoiceMixerBlock,
  type SynthTimelineTrackFlags,
  type WorkbenchBlockContext,
} from './blocks/workbench-blocks';
import type { ResolvedContinuumAsset, ResolvedIpaRichAsset } from './real-module-assets';
import type { ContinuumGridLayout } from './continuum-grid';

export interface CardDesignOptions {
  colorPreset: CardColorPresetId;
  skinChoice: CardSkinChoice;
  font: CardFontId;
  tractView: 'sagittal' | 'model';
  tractZoom: number;
  showFullHead: boolean;
  showOrientationCompass: boolean;
  showVowelReferenceCloud: boolean;
  showReconGlottis: boolean;
  crossLipDirection: SubPaneDirection;
  continuumGridLayout?: ContinuumGridLayout;
  glottisDirection: SubPaneDirection;
  synthTracks: SynthTimelineTrackFlags;
  showHeader: boolean;
  showTechFootnote: boolean;
  titleScale: number;
  /** User-facing scale where 1.0 (100%) maps to calibrated 1.32x baseline */
  textScale: number;
  offsetA: { x: number; y: number };
  offsetB: { x: number; y: number };
  mascotScale: number;
  mascotX?: number;
  mascotY?: number;
}

export interface ComposeCardInput {
  canvas: HTMLCanvasElement;
  canvasWidth: number;
  canvasHeight: number;
  layoutTree: CardLayoutNode | null;
  design: CardDesignOptions;
  compare: boolean;
  /** Explicit user title; empty string means leave blank (no default "汉语“算”" fallback!) */
  title: string;
  ipaHeader: string;
  activeSymbol: string;
  vowelSymbolA: string;
  vowelSymbolB: string;
  labelA: string;
  ipaA: string;
  labelB: string;
  ipaB: string;
  authorSignature: string;
  geometryNote: string;
  metricsA: TractMetrics;
  metricsB: TractMetrics | null;
  paramsA: Record<TractParamName, number>;
  paramsB: Record<TractParamName, number>;
  extrasA: TractPoseExtras;
  glottis: GlottisM27Params;
  snapshotA: PtbPoseSnapshot | null;
  vtlImageA: RasterCardImage | null;
  vtlImageB: RasterCardImage | null;
  mascotImage: RasterCardImage | null;
  vowelRefs: readonly CardVowelRefPoint[];
  project: VcProject;
  activeClipId: string;
  activeVoiceId: string;
  animated: boolean;
  clipProgress01: number;
  time_s: number;
  trailPoints: ReadonlyArray<{ f1: number; f2: number }>;
  ipaAsset?: ResolvedIpaRichAsset | null;
  continuumAsset?: ResolvedContinuumAsset | null;
  continuumCellIndex?: number;
}

export interface ComposeCardGeometry {
  cardBox: CardBox;
  contentBox: CardBox;
  moduleBoxes: CardModuleBox[];
  gutters: CardGutter[];
  tractBoxes?: { a: CardBox; b?: CardBox };
  mascotBox?: CardBox;
}

function clampScale(v: number, fallback = 1, min = 0.6, max = 1.8): number {
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
}

function drawImageContainSimple(
  ctx: CanvasRenderingContext2D,
  img: RasterCardImage,
  box: CardBox,
): void {
  const nw = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
  const nh = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
  if (!nw || !nh) return;
  const s = Math.min(box.w / nw, box.h / nh);
  ctx.drawImage(img, box.x + (box.w - nw * s) / 2, box.y + (box.h - nh * s) / 2, nw * s, nh * s);
}

export function composeCardToCanvas(input: ComposeCardInput): ComposeCardGeometry | undefined {
  const { canvas, canvasWidth: w, canvasHeight: h, design, layoutTree } = input;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;

  const theme = resolveCardTheme(design.colorPreset, design.skinChoice);
  const shortSide = Math.min(w, h);
  const u = shortSide / 1000;
  const fontFamily = resolveCardFontFamily(design.font);
  const titleScale = clampScale(design.titleScale, 1, 0.65, 1.6);
  // Re-anchor 100% user slider to 1.32x baseline as requested!
  const textScale = clampScale(design.textScale, 1, 0.65, 1.55) * 1.32;

  // 1. Outer ambient backdrop
  const bgGrad = ctx.createLinearGradient(0, 0, w, h);
  bgGrad.addColorStop(0, theme.canvasBgStart);
  bgGrad.addColorStop(1, theme.canvasBgEnd);
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, w, h);

  const outerPad = Math.round(18 * u);
  const cardBox: CardBox = {
    x: outerPad,
    y: outerPad,
    w: Math.max(40, w - outerPad * 2),
    h: Math.max(40, h - outerPad * 2),
  };

  drawStyledSurfaceBox(ctx, cardBox, theme.cardRadiusFactor * u, theme.cardSurface, theme, u, true);
  drawInstrumentGridBackdrop(ctx, cardBox, theme, u);

  const inset = Math.round(20 * u);
  const innerLeft = cardBox.x + inset;
  const innerRight = cardBox.x + cardBox.w - inset;
  const innerWidth = Math.max(20, innerRight - innerLeft);

  // 2. Optional Editorial Header (Blank by default unless user explicitly types a title!)
  let stageTop = cardBox.y + inset;
  const cleanTitle = input.title.trim();
  if (design.showHeader && cleanTitle.length > 0) {
    const titleFs = Math.max(15, 38 * u * titleScale);
    const headerRowH = titleFs * 1.24;
    const centerY = stageTop + headerRowH * 0.5;

    if (theme.headerRuleStyle === 'block') {
      ctx.fillStyle = theme.primaryInk;
      ctx.fillRect(innerLeft, centerY - headerRowH * 0.42, 10 * u, headerRowH * 0.84);
    } else if (theme.headerRuleStyle === 'bar') {
      ctx.fillStyle = theme.primaryInk;
      ctx.fillRect(innerLeft, centerY - headerRowH * 0.42, 4 * u, headerRowH * 0.84);
    }

    const titleOffset = theme.headerRuleStyle === 'editorial-line' ? 0 : theme.headerRuleStyle === 'block' ? 18 * u : 13 * u;
    const ipaStr = input.ipaHeader.trim();

    let ipaWidth = 0;
    if (ipaStr && innerWidth > 260 * u) {
      ipaWidth = drawPillBadge(
        ctx,
        ipaStr,
        innerRight,
        centerY,
        u * Math.min(1.35, textScale * 0.9),
        theme.badgeBg,
        theme.badgeText,
        null,
        'right',
        IPA_TYPEFACE,
        15,
        innerWidth * 0.44,
      );
    }

    ctx.font = `700 ${titleFs}px ${fontFamily}`;
    ctx.fillStyle = theme.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const maxTitleW = Math.max(30, innerWidth - titleOffset - (ipaWidth ? ipaWidth + 14 * u : 0));
    ctx.fillText(fitTextEllipsis(ctx, cleanTitle, maxTitleW), innerLeft + titleOffset, centerY);

    stageTop += headerRowH + 10 * u;
    if (theme.headerRuleStyle === 'editorial-line') {
      ctx.strokeStyle = theme.strongBorder;
      ctx.lineWidth = Math.max(1, 1.4 * u);
      ctx.beginPath();
      ctx.moveTo(innerLeft, stageTop - 5 * u);
      ctx.lineTo(innerRight, stageTop - 5 * u);
      ctx.stroke();
      stageTop += 4 * u;
    }
  }

  // 3. Footer (Tech provenance on left + author signature on right)
  const sig = input.authorSignature.trim();
  const hasFooter = Boolean(sig || design.showTechFootnote);
  const footH = hasFooter ? Math.max(20, 22 * u * textScale) : 0;
  const stageBottom = cardBox.y + cardBox.h - inset - (hasFooter ? footH + 8 * u : 0);

  if (hasFooter) {
    const footCenterY = cardBox.y + cardBox.h - inset - footH * 0.45;
    if (design.showTechFootnote) {
      const notes = [input.geometryNote, 'VoxFigura Core'].filter(Boolean).join(' · ');
      ctx.font = `500 ${Math.max(8.5, 10.5 * u * textScale)}px ${MONO_TYPEFACE}`;
      ctx.fillStyle = theme.muted;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(fitTextEllipsis(ctx, notes, innerWidth * (sig ? 0.56 : 0.95)), innerLeft, footCenterY);
    }
    if (sig) {
      ctx.font = `600 ${Math.max(10, 12 * u * textScale)}px ${fontFamily}`;
      ctx.fillStyle = theme.text;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(fitTextEllipsis(ctx, sig, innerWidth * 0.42), innerRight, footCenterY);
    }
  }

  // 4. Split-Tree Module Grid
  const contentBox: CardBox = {
    x: innerLeft,
    y: stageTop,
    w: innerWidth,
    h: Math.max(30, stageBottom - stageTop),
  };

  const gapPx = Math.max(6, Math.round(12 * u));
  const { boxes: moduleBoxes, gutters } = computeLayoutBoxesAndGutters(layoutTree, contentBox, gapPx);

  let tractBoxes: { a: CardBox; b?: CardBox } | undefined;

  if (moduleBoxes.length === 0) {
    ctx.save();
    ctx.strokeStyle = theme.border;
    ctx.setLineDash([6 * u, 5 * u]);
    ctx.lineWidth = Math.max(1, 1.3 * u);
    ctx.strokeRect(contentBox.x, contentBox.y, contentBox.w, contentBox.h);
    ctx.font = `600 ${Math.max(13, 16 * u * textScale)}px ${fontFamily}`;
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('请从左侧「模块元素库」点选要添加到卡片上的模块', contentBox.x + contentBox.w / 2, contentBox.y + contentBox.h / 2);
    ctx.restore();
  } else {
    for (const mb of moduleBoxes) {
      if (mb.moduleId === null) {
        ctx.save();
        drawStyledSurfaceBox(ctx, mb, theme.moduleRadiusFactor * u, theme.moduleSurface, theme, u, false);
        ctx.strokeStyle = theme.strongBorder;
        ctx.setLineDash([5 * u, 4 * u]);
        ctx.lineWidth = Math.max(1, 1.25 * u);
        const pad = 8 * u;
        ctx.strokeRect(mb.x + pad, mb.y + pad, Math.max(4, mb.w - pad * 2), Math.max(4, mb.h - pad * 2));
        ctx.setLineDash([]);
        ctx.font = `700 ${Math.max(10.5, 13 * u * textScale)}px ${fontFamily}`;
        ctx.fillStyle = theme.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const posLbl = `第 ${mb.rowIndex + 1} 行 · 第 ${mb.colIndex + 1} 列`;
        ctx.fillText(posLbl, mb.x + mb.w / 2, mb.y + mb.h / 2 - 10 * u);
        ctx.font = `500 ${Math.max(9, 10.8 * u * textScale)}px ${fontFamily}`;
        ctx.fillStyle = theme.muted;
        ctx.fillText(
          fitTextEllipsis(ctx, '空槽位 · 点击选中后从左侧添加模块或拖入', mb.w - 24 * u),
          mb.x + mb.w / 2,
          mb.y + mb.h / 2 + 11 * u,
        );
        ctx.restore();
        continue;
      }

      // Adaptive typography scale per module box: larger modules render comfortably larger text,
      // denser multi-column slots tighten smoothly to prevent overflow while keeping 2x2 at 1.0x baseline.
      const wRatio = mb.w / Math.max(1, contentBox.w * 0.5);
      const hRatio = mb.h / Math.max(1, contentBox.h * 0.5);
      const areaScale = Math.pow(Math.max(0.15, wRatio * hRatio), 0.34);
      const narrowGuard = Math.max(0.72, Math.min(wRatio, hRatio) * 1.42);
      const slotAdaptiveScale = Math.max(0.74, Math.min(1.48, Math.min(areaScale, narrowGuard)));
      const moduleTextScale = textScale * slotAdaptiveScale;

      const acousticCtx: AcousticBlockContext = {
        ctx,
        box: mb,
        theme,
        u,
        fontFamily,
        textScale: moduleTextScale,
        compare: input.compare,
        labelA: input.labelA,
        ipaA: input.ipaA,
        labelB: input.labelB,
        ipaB: input.ipaB,
        vowelSymbolA: input.vowelSymbolA,
        vowelSymbolB: input.vowelSymbolB,
        metricsA: input.metricsA,
        metricsB: input.metricsB,
        paramsA: input.paramsA,
        paramsB: input.paramsB,
        extrasA: input.extrasA,
        glottis: input.glottis,
        snapshotA: input.snapshotA,
        vtlImageA: input.vtlImageA,
        vtlImageB: input.vtlImageB,
        tractZoom: clampScale(design.tractZoom, 1, 0.45, 3.4),
        offsetA: design.offsetA,
        offsetB: design.offsetB,
        showOrientationCompass: design.showOrientationCompass,
        showVowelReferenceCloud: design.showVowelReferenceCloud,
        crossLipDirection: design.crossLipDirection ?? 'auto',
        glottisDirection: design.glottisDirection ?? 'auto',
        vowelRefs: input.vowelRefs,
        trailPoints: input.trailPoints,
        time_s: input.time_s,
      };

      const wbCtx: WorkbenchBlockContext = {
        ctx,
        box: mb,
        theme,
        u,
        fontFamily,
        textScale: moduleTextScale,
        project: input.project,
        activeClipId: input.activeClipId,
        activeVoiceId: input.activeVoiceId,
        wordLabel: input.labelA || cleanTitle,
        ipaLabel: input.activeSymbol || input.ipaHeader,
        paramsA: input.paramsA,
        glottis: input.glottis,
        synthTracks: design.synthTracks,
        showReconGlottis: design.showReconGlottis,
        glottisDirection: design.glottisDirection ?? 'auto',
        animated: input.animated,
        clipProgress01: input.clipProgress01,
        time_s: input.time_s,
        ipaAsset: input.ipaAsset ?? null,
        continuumAsset: input.continuumAsset ?? null,
        continuumGridLayout: design.continuumGridLayout ?? null,
        continuumCellIndex: input.continuumCellIndex,
        vtlImageA: input.vtlImageA,
        tractZoom: clampScale(design.tractZoom, 1, 0.45, 3.4),
        showOrientationCompass: design.showOrientationCompass,
        hasSeparateTractModule: moduleBoxes.some((m) => m.moduleId === 'tract-profile'),
      };

      switch (mb.moduleId) {
        case 'tract-profile':
          tractBoxes = drawTractProfileBlock(acousticCtx);
          break;
        case 'glottis-model':
          drawGlottisModelBlock(acousticCtx);
          break;
        case 'cross-lip':
          drawCrossLipBlock(acousticCtx);
          break;
        case 'area-fn':
          drawAreaFnBlock(acousticCtx);
          break;
        case 'transfer-fn':
          drawTransferFnBlock(acousticCtx);
          break;
        case 'vowel-space':
          drawVowelSpaceBlock(acousticCtx);
          break;
        case 'artic-metrics':
          drawArticMetricsBlock(acousticCtx);
          break;
        case 'ipa-wave-spec':
          drawIpaWaveSpecBlock(wbCtx);
          break;
        case 'ipa-lexicon':
          drawIpaLexiconBlock(wbCtx);
          break;
        case 'synth-timeline':
          drawSynthTimelineBlock(wbCtx);
          break;
        case 'm27-reconstruct':
          drawM27ReconstructBlock(wbCtx);
          break;
        case 'voice-mixer':
          drawVoiceMixerBlock(wbCtx);
          break;
        case 'continuum-grid':
          drawContinuumGridBlock(wbCtx);
          break;
        case 'dialect-sandhi':
          drawDialectSandhiBlock(wbCtx);
          break;
        case 'arranger-roll':
          drawArrangerRollBlock(wbCtx);
          break;
        case 'stage-nle':
          drawStageNleBlock(wbCtx);
          break;
      }
    }
  }

  // 5. Optional mascot sticker (Strictly anchored to bottom-right safe corner unless dragged)
  let mascotBox: CardBox | undefined;
  if (input.mascotImage) {
    const size = shortSide * 0.1 * clampScale(design.mascotScale, 1, 0.4, 2.2);
    const cx = design.mascotX === undefined ? innerRight - size * 0.52 : w * design.mascotX;
    const cy = design.mascotY === undefined ? stageBottom - size * 0.52 : h * design.mascotY;
    mascotBox = {
      x: Math.min(cardBox.x + cardBox.w - size, Math.max(cardBox.x, cx - size / 2)),
      y: Math.min(cardBox.y + cardBox.h - size, Math.max(cardBox.y, cy - size / 2)),
      w: size,
      h: size,
    };
    drawImageContainSimple(ctx, input.mascotImage, mascotBox);
  }

  return {
    cardBox,
    contentBox,
    moduleBoxes,
    gutters,
    tractBoxes,
    mascotBox,
  };
}
