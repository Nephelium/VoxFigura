import type { Clip, SubtitleAngleJitterConfig, SubtitleJitterConfig, SubtitleStyleConfig, Syllable } from '@vocalcut/core';

export const DEFAULT_SUBTITLE_JITTER: Readonly<SubtitleJitterConfig> = { enabled: false, min_pct: 80, max_pct: 120, seed: 1 };
export const DEFAULT_SUBTITLE_ANGLE_JITTER: Readonly<SubtitleAngleJitterConfig> = { enabled: false, min_deg: -10, max_deg: 10, seed: 1 };
export const SUBTITLE_MAX_FONT_PX = 240;
export const SUBTITLE_MIN_JITTER_PCT = 20;
export const SUBTITLE_MAX_JITTER_PCT = 300;
export const SUBTITLE_MIN_ANGLE_JITTER_DEG = -90;
export const SUBTITLE_MAX_ANGLE_JITTER_DEG = 90;

export interface StageCaptionToken {
  key: string; text: string; ipa?: string; visible?: boolean; color: string;
  progress?: number; wordCharCount?: number;
}
export interface StageCaptionBounds { left: number; top: number; right: number; bottom: number; clipId?: string }
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const captionGraphemes = (text: string) => Array.from(segmenter.segment(text), unit => unit.segment);

interface CaptionLine { syllables: Syllable[]; start: number; end: number; punctuation: string }
const clipLines = new WeakMap<Clip, CaptionLine[]>();
const lyricContent = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');

const LATIN_WORD_RE = /^[\p{Script=Latin}\p{N}'’-]+$/u;

function linesForClip(phrase: Clip): CaptionLine[] {
  const cached = clipLines.get(phrase);
  if (cached) return cached;
  const syllables = phrase.syllable_order
    .map(id => phrase.syllables[id])
    .filter((s): s is Syllable => Boolean(s) && Boolean(s.text.trim()) && !/^(?:sp|sil|<sil>|pause)$/i.test(s.text.trim()));
  const text = syllables.map(syllable => lyricContent(syllable.text)).join('');
  const lyrics = phrase.source?.lyrics ?? '';
  const breaks = new Map<number, string>();
  if (text && lyrics.trim()) {
    if (lyricContent(lyrics) === text) {
      let offset = 0;
      for (const match of lyrics.matchAll(/([^\p{P}\r\n]+)([\p{P}\r\n]*)/gu)) {
        offset += lyricContent(match[1]).length;
        if (offset && match[2]) breaks.set(offset, (breaks.get(offset) ?? '') + match[2].trim());
      }
    } else {
      // Relaxed sequential prefix matching when user edited single characters or imported pauses.
      let cursor = 0;
      const normalized = lyricContent(lyrics);
      const rawMatches = [...lyrics.matchAll(/([^\p{P}\r\n]+)([\p{P}\r\n]*)/gu)];
      let normPos = 0;
      for (const match of rawMatches) {
        const chunk = lyricContent(match[1]);
        if (!chunk) continue;
        const found = text.indexOf(chunk, cursor);
        if (found >= 0 && found - cursor <= 6) {
          cursor = found + chunk.length;
          if (match[2]) breaks.set(cursor, (breaks.get(cursor) ?? '') + match[2].trim());
        } else {
          normPos += chunk.length;
          if (normPos <= normalized.length && cursor < text.length && match[2]) {
            breaks.set(Math.min(text.length, normPos), (breaks.get(Math.min(text.length, normPos)) ?? '') + match[2].trim());
          }
        }
      }
    }
  }
  const lines: CaptionLine[] = [];
  let line: Syllable[] = [], offset = 0, width = 0;
  for (let i = 0; i < syllables.length; i++) {
    const syllable = syllables[i];
    const next = syllables[i + 1];
    const count = Math.max(1, lyricContent(syllable.text).length);
    offset += lyricContent(syllable.text).length;
    width += LATIN_WORD_RE.test(syllable.text.trim()) ? Math.min(count, 4) : count;
    line.push(syllable);
    const hasLongGap = next && (next.start_smp - syllable.end_smp) >= 48000 * 1.2;
    if (breaks.has(offset) || hasLongGap || width >= 28 || i === syllables.length - 1) {
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
  return line.syllables.flatMap((syllable, sylIdx) => {
    const tokens = mode === 'char_by_char' || single ? captionGraphemes(syllable.text) : [syllable.text];
    const nextSyl = line.syllables[sylIdx + 1];
    const needsSpaceAfter = !single && Boolean(nextSyl)
      && LATIN_WORD_RE.test(syllable.text.trim())
      && LATIN_WORD_RE.test(nextSyl.text.trim());
    return tokens.flatMap((text, index) => {
      const duration = syllable.end_smp - syllable.start_smp;
      const start = syllable.start_smp + duration * index / tokens.length;
      const end = syllable.start_smp + duration * (index + 1) / tokens.length;
      if (source && (end <= source.startSmp || start >= source.endSmp)) return [];
      const active = start <= local && local < end;
      if (single && !active) return [];
      const punctuation = !single && syllable === line.syllables.at(-1) && index === tokens.length - 1 ? line.punctuation : '';
      const trailingSpace = index === tokens.length - 1 && !punctuation && needsSpaceAfter ? ' ' : '';
      const progress = duration > 0 ? Math.max(0, Math.min(1, (local - start) / Math.max(1, end - start))) : (local >= start ? 1 : 0);
      return [{ key: phrase.id + '/' + syllable.id + '/' + index, text: text + punctuation + trailingSpace,
        ipa: single || index === 0 ? syllable.ipa.join('') : '', lit: mode === 'line' || local >= start, active, progress,
        wordCharCount: tokens.length }];
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

export function subtitleAngleDeg(jitter: SubtitleAngleJitterConfig | undefined, key: string): number {
  if (!jitter?.enabled || !Number.isFinite(jitter.min_deg) || !Number.isFinite(jitter.max_deg) || !Number.isSafeInteger(jitter.seed)
      || jitter.min_deg < SUBTITLE_MIN_ANGLE_JITTER_DEG || jitter.max_deg > SUBTITLE_MAX_ANGLE_JITTER_DEG || jitter.min_deg > jitter.max_deg) return 0;
  let hash = 0x811c9dc5;
  for (const char of `angle/${jitter.seed}/${key}`) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193);
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  const ratio = ((hash ^ (hash >>> 16)) >>> 0) / 0x100000000;
  return jitter.min_deg + ratio * (jitter.max_deg - jitter.min_deg);
}

function union(a: StageCaptionBounds | null, b: StageCaptionBounds): StageCaptionBounds {
  if (!a) return b;
  return { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
}

export function drawStageCaption(ctx: CanvasRenderingContext2D, tokens: StageCaptionToken[], style: SubtitleStyleConfig | undefined,
  size: number, x = 0, y = 0, options: { gap?: number; weight?: number; shadow?: string; karaokeFill?: boolean } = {}): StageCaptionBounds | null {
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
  const splitGlyphs = Boolean(style?.size_jitter?.enabled || style?.angle_jitter?.enabled);
  const rows = tokens.map(token => {
    const units = splitGlyphs ? captionGraphemes(token.text) : [token.text];
    const glyphs = units.map((text, index) => {
      const scale = subtitleSizeFactor(style?.size_jitter, `${token.key}/${index}`);
      const angleDeg = subtitleAngleDeg(style?.angle_jitter, `${token.key}/${index}`);
      const settings = font(size * scale);
      ctx.font = settings;
      return { text, scale, angleDeg, settings, metrics: ctx.measureText(text) };
    });
    const textWidth = glyphs.reduce((sum, glyph) => sum + glyph.metrics.width, 0);
    const ipa = ipaVisible ? token.ipa ?? '' : '';
    const ipaFont = font(size * .52 * (glyphs[0]?.scale ?? 1), true);
    ctx.font = ipaFont;
    const ipaMetrics = ctx.measureText(ipa);
    // Avoid stretching single Latin letters in char_by_char mode to the full word IPA width.
    const multiCharWord = (token.wordCharCount ?? 1) > 1 && token.text.trim().length <= 1;
    const width = multiCharWord ? textWidth : Math.max(textWidth, ipaMetrics.width);
    const maxScale = glyphs.reduce((m, g) => Math.max(m, g.scale), 1);
    const maxAbsAngleDeg = glyphs.reduce((m, g) => Math.max(m, Math.abs(g.angleDeg)), 0);
    return { token, glyphs, textWidth, ipa, ipaFont, ipaMetrics, width, multiCharWord, maxScale, maxAbsAngleDeg };
  });
  const gap = options.gap ?? size * .09;
  const rawTotalWidth = rows.reduce((sum, row) => sum + row.width, 0) + gap * Math.max(0, rows.length - 1);
  const safeMarginX = style?.safe_margin_px?.[0] ?? 96;
  const maxContentW = Math.max(320, 1920 - safeMarginX * 2);
  const fitScale = rawTotalWidth > maxContentW ? maxContentW / rawTotalWidth : 1;
  if (fitScale < 1) {
    ctx.translate(x, y);
    ctx.scale(fitScale, fitScale);
    ctx.translate(-x, -y);
  }
  const maxGlyphScale = rows.reduce((m, r) => Math.max(m, r.maxScale), 1);
  const maxAbsAngleRad = (rows.reduce((m, r) => Math.max(m, r.maxAbsAngleDeg), 0) * Math.PI) / 180;
  const ipaOffsetY = size * (0.58 + Math.max(0, maxGlyphScale - 1) * 0.28 + Math.sin(maxAbsAngleRad) * 0.22);
  let left = x - rawTotalWidth / 2;
  let bounds: StageCaptionBounds | null = null;
  const baseTransform = ctx.getTransform();
  const draw = (text: string, fontCss: string, metrics: TextMetrics, px: number, baseline: number, angleDeg = 0) => {
    if (!text.trim()) return;
    ctx.font = fontCss;
    let drawTransform = baseTransform;
    let x0 = px - metrics.actualBoundingBoxLeft;
    let x1 = px + metrics.actualBoundingBoxRight;
    let y0 = baseline - metrics.actualBoundingBoxAscent;
    let y1 = baseline + metrics.actualBoundingBoxDescent;
    if (Math.abs(angleDeg) > 1e-4) {
      const cx = px + metrics.width * 0.5;
      const ascent = metrics.actualBoundingBoxAscent || size * 0.72;
      const descent = metrics.actualBoundingBoxDescent || size * 0.16;
      const cy = baseline - (ascent - descent) * 0.5;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((angleDeg * Math.PI) / 180);
      ctx.fillText(text, px - cx, baseline - cy);
      drawTransform = ctx.getTransform();
      ctx.restore();
      x0 -= cx;
      x1 -= cx;
      y0 -= cy;
      y1 -= cy;
    } else {
      ctx.fillText(text, px, baseline);
    }
    const extents = [new DOMPoint(x0, y0), new DOMPoint(x1, y0), new DOMPoint(x0, y1), new DOMPoint(x1, y1)].map(p => p.matrixTransform(drawTransform));
    bounds = union(bounds, {
      left: Math.min(...extents.map(p => p.x)) / ctx.canvas.width,
      right: Math.max(...extents.map(p => p.x)) / ctx.canvas.width,
      top: Math.min(...extents.map(p => p.y)) / ctx.canvas.height,
      bottom: Math.max(...extents.map(p => p.y)) / ctx.canvas.height,
    });
  };
  const karaoke = Boolean(options.karaokeFill);
  const highlightColor = style?.highlight_color ?? '#79aaff';
  const baseColor = style?.text_color ?? '#eef2ff';
  for (const row of rows) {
    if (karaoke) {
      // KaraokeFillSync (adapted from Vincentwei1021/video-shotcraft, Apache-2.0):
      // Dimmed base text + left-to-right progress fill clip + accent baseline indicator.
      const prog = row.token.visible === false ? 0 : Math.max(0, Math.min(1, row.token.progress ?? 1));
      const textStart = left + (row.width - row.textWidth) / 2;
      const baselineY = y + size * (ipaVisible ? -0.08 : 0.33);
      ctx.save();
      ctx.globalAlpha *= 0.42;
      ctx.fillStyle = baseColor;
      let px = textStart;
      for (const glyph of row.glyphs) {
        draw(glyph.text, glyph.settings, glyph.metrics, px, baselineY, glyph.angleDeg);
        px += glyph.metrics.width;
      }
      ctx.restore();

      if (prog > 0.005) {
        ctx.save();
        ctx.beginPath();
        const padX = row.maxAbsAngleDeg > 0 ? Math.max(6, size * 0.32) : 4;
        ctx.rect(textStart - padX, baselineY - size * 1.8, (row.textWidth + padX * 2) * prog, size * 2.6);
        ctx.clip();
        ctx.fillStyle = prog < 0.995 ? highlightColor : baseColor;
        let fillPx = textStart;
        for (const glyph of row.glyphs) {
          draw(glyph.text, glyph.settings, glyph.metrics, fillPx, baselineY, glyph.angleDeg);
          fillPx += glyph.metrics.width;
        }
        ctx.restore();

        // Subtle sweeping underline under active token
        if (prog < 0.995) {
          ctx.save();
          ctx.fillStyle = highlightColor;
          ctx.globalAlpha *= 0.85;
          ctx.fillRect(textStart, baselineY + size * 0.14, row.textWidth * prog, Math.max(2, size * 0.08));
          ctx.restore();
        }
      }
      if (row.ipa && prog > 0.005) {
        ctx.fillStyle = prog < 0.995 ? highlightColor : baseColor;
        const ipaLeft = row.multiCharWord ? left : left + (row.width - row.ipaMetrics.width) / 2;
        draw(row.ipa, row.ipaFont, row.ipaMetrics, ipaLeft, y + ipaOffsetY);
      }
    } else if (row.token.visible !== false) {
      ctx.fillStyle = row.token.color;
      let px = left + (row.width - row.textWidth) / 2;
      for (const glyph of row.glyphs) {
        draw(glyph.text, glyph.settings, glyph.metrics, px, y + size * (ipaVisible ? -.08 : .33), glyph.angleDeg);
        px += glyph.metrics.width;
      }
      if (row.ipa) {
        const ipaLeft = row.multiCharWord ? left : left + (row.width - row.ipaMetrics.width) / 2;
        draw(row.ipa, row.ipaFont, row.ipaMetrics, ipaLeft, y + ipaOffsetY);
      }
    }
    left += row.width + gap;
  }
  ctx.restore();
  return bounds;
}
