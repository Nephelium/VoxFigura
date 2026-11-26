import type { Clip, SubtitleJitterConfig, SubtitleStyleConfig, Syllable } from '@vocalcut/core';

export const DEFAULT_SUBTITLE_JITTER: Readonly<SubtitleJitterConfig> = { enabled: false, min_pct: 80, max_pct: 120, seed: 1 };
export const SUBTITLE_MAX_FONT_PX = 240;
export const SUBTITLE_MIN_JITTER_PCT = 20;
export const SUBTITLE_MAX_JITTER_PCT = 300;

export interface StageCaptionToken {
  key: string; text: string; ipa?: string; visible?: boolean; color: string;
}
export interface StageCaptionBounds { left: number; top: number; right: number; bottom: number; clipId?: string }
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const captionGraphemes = (text: string) => Array.from(segmenter.segment(text), unit => unit.segment);

interface CaptionLine { syllables: Syllable[]; start: number; end: number; punctuation: string }
const clipLines = new WeakMap<Clip, CaptionLine[]>();
const lyricContent = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');

function linesForClip(phrase: Clip): CaptionLine[] {
  const cached = clipLines.get(phrase);
  if (cached) return cached;
  const syllables = phrase.syllable_order.map(id => phrase.syllables[id]).filter(Boolean);
  const text = syllables.map(syllable => lyricContent(syllable.text)).join('');
  const lyrics = phrase.source?.lyrics ?? '';
  const breaks = new Map<number, string>();
  if (text && lyricContent(lyrics) === text) {
    let offset = 0;
    for (const match of lyrics.matchAll(/([^\p{P}\r\n]+)([\p{P}\r\n]*)/gu)) {
      offset += lyricContent(match[1]).length;
      if (offset && match[2]) breaks.set(offset, (breaks.get(offset) ?? '') + match[2].trim());
    }
  }
  const lines: CaptionLine[] = [];
  let line: Syllable[] = [], offset = 0, width = 0;
  for (const syllable of syllables) {
    const count = lyricContent(syllable.text).length;
    offset += count;
    width += count;
    line.push(syllable);
    if (breaks.has(offset) || width >= 28 || syllable === syllables.at(-1)) {
      lines.push({ syllables: line, start: line[0].start_smp, end: syllable.end_smp, punctuation: breaks.get(offset) ?? '' });
      line = [];
      width = 0;
    }
  }
  clipLines.set(phrase, lines);
  return lines;
}

export function stageLyricTokens(phrase: Clip | undefined, local: number,
  mode: SubtitleStyleConfig['reveal_mode'] = 'char_by_char', source?: { startSmp: number; endSmp: number }) {
  if (!phrase) return [];
  const line = linesForClip(phrase).find(line => line.start <= local && local < line.end);
  if (!line) return [];
  const single = mode === 'single_char';
  return line.syllables.flatMap(syllable => {
    const tokens = mode === 'char_by_char' || single ? captionGraphemes(syllable.text) : [syllable.text];
    return tokens.flatMap((text, index) => {
      const duration = syllable.end_smp - syllable.start_smp;
      const start = syllable.start_smp + duration * index / tokens.length;
      const end = syllable.start_smp + duration * (index + 1) / tokens.length;
      if (source && (end <= source.startSmp || start >= source.endSmp)) return [];
      const active = start <= local && local < end;
      if (single && !active) return [];
      const punctuation = !single && syllable === line.syllables.at(-1) && index === tokens.length - 1 ? line.punctuation : '';
      return [{ key: phrase.id + '/' + syllable.id + '/' + index, text: text + punctuation,
        ipa: single || index === 0 ? syllable.ipa.join('') : '', lit: mode === 'line' || local >= start, active }];
    });
  });
}

export function subtitleSizeFactor(jitter: SubtitleJitterConfig | undefined, key: string): number {
  if (!jitter?.enabled || !Number.isFinite(jitter.min_pct) || !Number.isFinite(jitter.max_pct) || !Number.isSafeInteger(jitter.seed)
      || jitter.min_pct < SUBTITLE_MIN_JITTER_PCT || jitter.max_pct > SUBTITLE_MAX_JITTER_PCT || jitter.min_pct > jitter.max_pct) return 1;
  let hash = 0x811c9dc5;
  for (const char of `${jitter.seed}/${key}`) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193);
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  const ratio = ((hash ^ (hash >>> 16)) >>> 0) / 0x100000000;
  return (jitter.min_pct + ratio * (jitter.max_pct - jitter.min_pct)) / 100;
}

function union(a: StageCaptionBounds | null, b: StageCaptionBounds): StageCaptionBounds {
  if (!a) return b;
  return { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
}

export function drawStageCaption(ctx: CanvasRenderingContext2D, tokens: StageCaptionToken[], style: SubtitleStyleConfig | undefined,
  size: number, x = 0, y = 0, options: { gap?: number; weight?: number; shadow?: string } = {}): StageCaptionBounds | null {
  if (!tokens.length) return null;
  const family = (style?.font_family ?? '').replace(/["\\\n\r]/g, '').trim();
  const lyricFamily = `${family ? `"${family}",` : ''}"Segoe UI","Microsoft YaHei",sans-serif`;
  const ipaFamily = '"PTBIPAPlus","Doulos SIL",serif';
  const weight = options.weight ?? 650;
  const font = (pixels: number, ipa = false) => `${weight} ${pixels.toFixed(3)}px ${ipa ? ipaFamily : lyricFamily}`;
  const ipaVisible = !!style?.show_ipa && tokens.some(token => token.ipa);
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  if (options.shadow) { ctx.shadowColor = options.shadow; ctx.shadowBlur = 9; }
  const rows = tokens.map(token => {
    const units = style?.size_jitter?.enabled ? captionGraphemes(token.text) : [token.text];
    const glyphs = units.map((text, index) => {
      const scale = subtitleSizeFactor(style?.size_jitter, `${token.key}/${index}`);
      const settings = font(size * scale);
      ctx.font = settings;
      return { text, scale, settings, metrics: ctx.measureText(text) };
    });
    const textWidth = glyphs.reduce((sum, glyph) => sum + glyph.metrics.width, 0);
    const ipa = ipaVisible ? token.ipa ?? '' : '';
    const ipaFont = font(size * .52 * (glyphs[0]?.scale ?? 1), true);
    ctx.font = ipaFont;
    const ipaMetrics = ctx.measureText(ipa);
    return { token, glyphs, textWidth, ipa, ipaFont, ipaMetrics, width: Math.max(textWidth, ipaMetrics.width) };
  });
  const gap = options.gap ?? size * .09;
  let left = x - (rows.reduce((sum, row) => sum + row.width, 0) + gap * (rows.length - 1)) / 2;
  let bounds: StageCaptionBounds | null = null;
  const transform = ctx.getTransform();
  const draw = (text: string, fontCss: string, metrics: TextMetrics, px: number, baseline: number) => {
    if (!text.trim()) return;
    ctx.font = fontCss;
    ctx.fillText(text, px, baseline);
    const x0 = px - metrics.actualBoundingBoxLeft, x1 = px + metrics.actualBoundingBoxRight;
    const y0 = baseline - metrics.actualBoundingBoxAscent, y1 = baseline + metrics.actualBoundingBoxDescent;
    const extents = [new DOMPoint(x0, y0), new DOMPoint(x1, y0), new DOMPoint(x0, y1), new DOMPoint(x1, y1)].map(p => p.matrixTransform(transform));
    bounds = union(bounds, {
      left: Math.min(...extents.map(p => p.x)) / ctx.canvas.width,
      right: Math.max(...extents.map(p => p.x)) / ctx.canvas.width,
      top: Math.min(...extents.map(p => p.y)) / ctx.canvas.height,
      bottom: Math.max(...extents.map(p => p.y)) / ctx.canvas.height,
    });
  };
  for (const row of rows) {
    if (row.token.visible !== false) {
      ctx.fillStyle = row.token.color;
      let px = left + (row.width - row.textWidth) / 2;
      for (const glyph of row.glyphs) {
        draw(glyph.text, glyph.settings, glyph.metrics, px, y + size * (ipaVisible ? -.08 : .33));
        px += glyph.metrics.width;
      }
      draw(row.ipa, row.ipaFont, row.ipaMetrics, left + (row.width - row.ipaMetrics.width) / 2, y + size * .67);
    }
    left += row.width + gap;
  }
  ctx.restore();
  return bounds;
}
