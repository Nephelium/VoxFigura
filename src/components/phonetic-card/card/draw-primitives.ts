import type { CardBox } from './layout-tree';
import type { CardResolvedTheme } from './card-themes';

export const SANS_TYPEFACE = '"VC Inter", "VC Noto Sans SC", "Noto Sans SC", "Microsoft YaHei", "Segoe UI", sans-serif';
export const SERIF_TYPEFACE = '"VC Lora", "VC Noto Serif SC", "Noto Serif SC", "Songti SC", "SimSun", Georgia, serif';
export const IPA_TYPEFACE = '"PTBIPAPlus", "Doulos SIL", "Charis SIL", "VC Inter", serif';
export const MONO_TYPEFACE = '"JetBrains Mono", "Consolas", monospace';

export type CardFontId =
  | 'follow-site'
  | 'noto-sans'
  | 'noto-serif'
  | 'kaiti'
  | 'fangsong'
  | 'zhongsong'
  | 'xingkai'
  | 'yahei'
  | 'mono-editorial'
  | 'sans'
  | 'serif';

export interface CardFontOption {
  value: Exclude<CardFontId, 'sans' | 'serif'>;
  label: string;
  family: string;
  preloadFamily?: string;
}

export const CARD_FONT_OPTIONS: ReadonlyArray<CardFontOption> = [
  {
    value: 'follow-site',
    label: '跟随当前网站字体',
    family: SANS_TYPEFACE,
  },
  {
    value: 'noto-sans',
    label: '思源黑体 · Noto Sans SC',
    family: '"VC Inter", "VC Noto Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
    preloadFamily: 'VC Noto Sans SC',
  },
  {
    value: 'noto-serif',
    label: '思源宋体 · Noto Serif SC',
    family: '"VC Lora", "VC Noto Serif SC", "Noto Serif CJK SC", "Songti SC", "SimSun", serif',
    preloadFamily: 'VC Noto Serif SC',
  },
  {
    value: 'kaiti',
    label: '人文楷体 · 楷体 / 霞鹜文楷',
    family: '"LXGW WenKai", "Kaiti SC", "STKaiti", "KaiTi", "BiauKai", "VC Noto Serif SC", serif',
  },
  {
    value: 'fangsong',
    label: '学术仿宋 · 仿宋 / 华文仿宋',
    family: '"STFangsong", "FangSong", "FangSong_GB2312", "VC Noto Serif SC", serif',
  },
  {
    value: 'zhongsong',
    label: '刊物中宋 · 华文中宋 / 宋体',
    family: '"STZhongsong", "Songti SC", "NSimSun", "SimSun", "VC Noto Serif SC", serif',
  },
  {
    value: 'xingkai',
    label: '书卷行楷 · 华文行楷 / 楷体',
    family: '"STXingkai", "Kaiti SC", "STKaiti", "KaiTi", "VC Noto Serif SC", serif',
  },
  {
    value: 'yahei',
    label: '清晰雅黑 · 微软雅黑 / 苹方',
    family: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "VC Noto Sans SC", sans-serif',
  },
  {
    value: 'mono-editorial',
    label: '仪器等宽 · JetBrains Mono',
    family: '"JetBrains Mono", "Cascadia Code", "VC Noto Sans SC", "Microsoft YaHei", monospace',
    preloadFamily: 'JetBrains Mono',
  },
];

export function resolveCardFontFamily(fontId: CardFontId | undefined): string {
  if (!fontId || fontId === 'sans') return SANS_TYPEFACE;
  if (fontId === 'serif') return SERIF_TYPEFACE;
  if (fontId === 'follow-site') {
    if (typeof document !== 'undefined') {
      const uiFont = getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim();
      if (uiFont) return uiFont;
    }
    return SANS_TYPEFACE;
  }
  return CARD_FONT_OPTIONS.find((f) => f.value === fontId)?.family ?? SANS_TYPEFACE;
}

export function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (rad <= 0.4) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

export function fitTextEllipsis(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 4 || !text) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  const glyphs = Array.from(text);
  while (glyphs.length > 0 && ctx.measureText(glyphs.join('') + '…').width > maxWidth) {
    glyphs.pop();
  }
  return glyphs.length ? glyphs.join('') + '…' : '';
}

export function drawPillBadge(
  ctx: CanvasRenderingContext2D,
  text: string,
  rightOrLeftX: number,
  centerY: number,
  u: number,
  bg: string,
  fg: string,
  borderColor: string | null,
  align: 'left' | 'right' | 'center' = 'right',
  fontFamily = MONO_TYPEFACE,
  fontSizeFactor = 11.5,
  maxWidthPx?: number,
): number {
  if (!text) return 0;
  ctx.save();
  const fs = Math.max(8.5, fontSizeFactor * u);
  ctx.font = `600 ${fs}px ${fontFamily}`;
  const padX = 7.5 * u;
  const h = Math.max(15, fs * 1.62);
  const display = maxWidthPx ? fitTextEllipsis(ctx, text, Math.max(12, maxWidthPx - padX * 2)) : text;
  if (!display) {
    ctx.restore();
    return 0;
  }
  const tw = ctx.measureText(display).width;
  const w = tw + padX * 2;
  const x = align === 'right' ? rightOrLeftX - w : align === 'center' ? rightOrLeftX - w / 2 : rightOrLeftX;
  const y = centerY - h / 2;

  roundRectPath(ctx, x, y, w, h, Math.min(h / 2, 6 * u));
  ctx.fillStyle = bg;
  ctx.fill();
  if (borderColor) {
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = Math.max(0.8, 0.9 * u);
    ctx.stroke();
  }
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(display, x + w / 2, centerY + 0.4 * u);
  ctx.restore();
  return w;
}

export function drawInstrumentGridBackdrop(
  ctx: CanvasRenderingContext2D,
  box: CardBox,
  theme: CardResolvedTheme,
  u: number,
): void {
  if (!theme.showInstrumentGrid) return;
  const step = Math.max(16, Math.round(28 * u));
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  ctx.strokeStyle = theme.subtle;
  ctx.lineWidth = Math.max(0.5, 0.65 * u);
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  for (let gx = box.x + step; gx < box.x + box.w; gx += step) {
    ctx.moveTo(gx, box.y);
    ctx.lineTo(gx, box.y + box.h);
  }
  for (let gy = box.y + step; gy < box.y + box.h; gy += step) {
    ctx.moveTo(box.x, gy);
    ctx.lineTo(box.x + box.w, gy);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawStyledSurfaceBox(
  ctx: CanvasRenderingContext2D,
  box: CardBox,
  radius: number,
  fill: string,
  theme: CardResolvedTheme,
  u: number,
  isOuterCard = false,
): void {
  const { x, y, w, h } = box;
  const bw = Math.max(1, theme.borderWidthFactor * u * (isOuterCard ? 1.15 : 0.95));

  if (theme.hardOffsetShadow > 0) {
    const off = theme.hardOffsetShadow * u * (isOuterCard ? 1.15 : 0.72);
    ctx.save();
    roundRectPath(ctx, x + off, y + off, w, h, radius);
    ctx.fillStyle = theme.strongBorder;
    ctx.globalAlpha = theme.isDark ? 0.42 : 0.85;
    ctx.fill();
    ctx.restore();
  } else if (theme.softShadowAlpha > 0) {
    ctx.save();
    ctx.shadowColor = `rgba(0, 0, 0, ${theme.softShadowAlpha * (isOuterCard ? 1 : 0.55)})`;
    ctx.shadowBlur = (isOuterCard ? 22 : 8) * u;
    ctx.shadowOffsetY = (isOuterCard ? 6 : 2) * u;
    roundRectPath(ctx, x, y, w, h, radius);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();
  }

  roundRectPath(ctx, x, y, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();

  if (theme.innerHighlightAlpha > 0) {
    ctx.save();
    roundRectPath(ctx, x + bw * 0.5, y + bw * 0.5, Math.max(1, w - bw), Math.max(1, h - bw), Math.max(0, radius - bw * 0.5));
    ctx.clip();
    ctx.strokeStyle = `rgba(255, 255, 255, ${theme.innerHighlightAlpha})`;
    ctx.lineWidth = Math.max(1, 1.4 * u);
    ctx.beginPath();
    ctx.moveTo(x, y + bw * 0.6);
    ctx.lineTo(x + w, y + bw * 0.6);
    ctx.stroke();
    ctx.restore();
  }

  roundRectPath(ctx, x, y, w, h, radius);
  ctx.strokeStyle = theme.hardOffsetShadow > 0 ? theme.strongBorder : theme.border;
  ctx.lineWidth = bw;
  ctx.stroke();
}

export function drawModuleShell(
  ctx: CanvasRenderingContext2D,
  box: CardBox,
  title: string,
  badge: string | undefined,
  theme: CardResolvedTheme,
  u: number,
  fontFamily: string,
  textScale = 1.32,
): CardBox {
  const r = theme.moduleRadiusFactor * u;
  drawStyledSurfaceBox(ctx, box, r, theme.moduleSurface, theme, u, false);

  const titleFs = Math.max(10, 13.8 * u * textScale);
  const headH = Math.max(22, Math.min(box.h * 0.28, titleFs * 1.95));
  ctx.save();
  roundRectPath(ctx, box.x, box.y, box.w, box.h, r);
  ctx.clip();

  ctx.fillStyle = theme.moduleHeaderBg;
  ctx.fillRect(box.x, box.y, box.w, headH);
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = Math.max(0.75, 0.85 * u);
  ctx.beginPath();
  ctx.moveTo(box.x, box.y + headH);
  ctx.lineTo(box.x + box.w, box.y + headH);
  ctx.stroke();

  const padX = 11 * u;
  let badgeW = 0;
  // Only render right-side pill badge when box is wide enough to avoid colliding with title
  if (badge && box.w > 195 * u * Math.min(1.25, textScale * 0.85)) {
    badgeW = drawPillBadge(
      ctx,
      badge,
      box.x + box.w - padX,
      box.y + headH / 2,
      u * textScale * 0.82,
      theme.cardSurface,
      theme.muted,
      theme.border,
      'right',
      MONO_TYPEFACE,
      11.5,
      box.w * 0.46,
    );
  }

  ctx.font = `700 ${titleFs}px ${fontFamily}`;
  ctx.fillStyle = theme.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const availTitleW = Math.max(24, box.w - padX * 2 - (badgeW ? badgeW + 8 * u : 0));
  ctx.fillText(fitTextEllipsis(ctx, title, availTitleW), box.x + padX, box.y + headH / 2 + 0.4 * u);
  ctx.restore();

  const padInner = 8.5 * u;
  return {
    x: box.x + padInner,
    y: box.y + headH + padInner * 0.72,
    w: Math.max(8, box.w - padInner * 2),
    h: Math.max(8, box.h - headH - padInner * 1.55),
  };
}

export function drawPlayheadCursor(
  ctx: CanvasRenderingContext2D,
  x: number,
  top: number,
  bottom: number,
  timeSec: number | null,
  theme: CardResolvedTheme,
  u: number,
  textScale = 1.32,
): void {
  if (bottom <= top + 4) return;
  ctx.save();
  ctx.strokeStyle = theme.primaryInk;
  ctx.lineWidth = Math.max(1.5, 2 * u);
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, bottom);
  ctx.stroke();

  const cap = 4.6 * u;
  ctx.fillStyle = theme.primaryInk;
  ctx.beginPath();
  ctx.moveTo(x - cap, top);
  ctx.lineTo(x + cap, top);
  ctx.lineTo(x, top + cap * 1.35);
  ctx.closePath();
  ctx.fill();

  if (timeSec !== null && Number.isFinite(timeSec)) {
    drawPillBadge(
      ctx,
      `${timeSec.toFixed(2)}s`,
      x,
      top + 11 * u * Math.min(1.25, textScale * 0.85),
      u * textScale * 0.72,
      theme.badgeBg,
      theme.badgeText,
      null,
      'center',
    );
  }
  ctx.restore();
}
