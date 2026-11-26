import { looksLikeBareIpaToken } from '@vocalcut/g2p';
import { msToSamples, type Clip } from '@vocalcut/core';

export type SentenceLanguage = 'zh' | 'en' | 'ja' | 'zh_en' | 'rule';

export interface SentenceChunk {
  text: string;
  language: SentenceLanguage;
  trailingPauseMs: number;
}

export interface SentenceSynthesisWindow {
  startSmp: number;
  endSmp: number;
}

const FRAME_50HZ_SMP = 960; // 20 ms @ 48 kHz
const SENTENCE_END_PUNCT_RE = /^[。！？!?.…]+$/u;
const SENTENCE_TRAIL_CLOSERS = new Set(Array.from('”’"\'」』》）)]'));
const ABBREV_PREFIX_RE =
  /(?:^|[\s(（"“'‘])(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|fig|no|vol|eq|inc|ltd|co)$/iu;
const INITIALISM_PREFIX_RE = /(?:^|[\s(（"“'‘])(?:[A-Za-z]\.){1,}[A-Za-z]$/u;
const SINGLE_CAP_INITIAL_RE = /(?:^|[\s(（"“'‘])[A-Z]$/u;
const EXPLICIT_IPA_MARK_RE = /[⁰¹²³⁴⁵˥˦˧˨˩꜒꜓꜔꜕꜖‿ꜛꜜ]/u;
const SPEAKABLE_RE = /[\p{L}\p{N}]/u;

function nextNonSpaceChar(text: string, fromIndex: number): string {
  for (let i = fromIndex; i < text.length; i++) {
    const ch = text[i];
    if (!/\s/u.test(ch)) return ch;
  }
  return '';
}

function shouldSplitAsciiDot(text: string, dotIndex: number, fragmentSoFar: string): boolean {
  const prev = dotIndex > 0 ? text[dotIndex - 1] : '';
  const next = dotIndex + 1 < text.length ? text[dotIndex + 1] : '';

  // Decimals / versions like 3.14 or v2.0
  if (/\d/u.test(prev) && /\d/u.test(next)) return false;

  // Embedded dot directly inside identifier / initialism like U.S.A. or foo.bar
  if (/[A-Za-z0-9]/u.test(next)) return false;

  // Ellipsis `...` at top level acts as a real pause boundary.
  if (next === '.' || prev === '.') return true;

  const afterSpace = nextNonSpaceChar(text, dotIndex + 1);
  if (!afterSpace) return true;

  // Common title / academic abbreviations: `Mr. Smith`, `Dr. Lee`, `Fig. 2`
  if (ABBREV_PREFIX_RE.test(fragmentSoFar) && /[\p{L}\p{N}]/u.test(afterSpace)) {
    return false;
  }

  // Multi-dot initialism like `U.S.A. yesterday.` when followed by lowercase/digit
  if (INITIALISM_PREFIX_RE.test(fragmentSoFar) && /[a-z0-9]/u.test(afterSpace)) {
    return false;
  }

  // Single uppercase initial like `J. K. Rowling`
  if (SINGLE_CAP_INITIAL_RE.test(fragmentSoFar) && /[A-Z]/u.test(afterSpace)) {
    return false;
  }

  return true;
}

/**
 * Split user input into sentence-level chunks at top-level sentence-ending punctuation
 * (`。`, `！`, `？`, `…`, `.`, `!`, `?`, and newlines), while keeping `[...]` IPA spans,
 * `{...}` VoQS spans, decimals (`3.14`), and abbreviations (`Mr. Smith`, `U.S.A.`) intact.
 */
export function splitTextIntoSentences(rawText: string): SentenceChunk[] {
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  const rawParts: string[] = [];
  let bracketDepth = 0;
  let braceDepth = 0;
  let buf = '';

  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];

    if (ch === '[' || ch === '［') {
      bracketDepth++;
      buf += ch;
      i++;
      continue;
    }
    if ((ch === ']' || ch === '］') && bracketDepth > 0) {
      bracketDepth--;
      buf += ch;
      i++;
      continue;
    }
    if (ch === '{') {
      braceDepth++;
      buf += ch;
      i++;
      continue;
    }
    if (ch === '}' && braceDepth > 0) {
      braceDepth--;
      buf += ch;
      i++;
      continue;
    }

    if (bracketDepth === 0 && braceDepth === 0) {
      if (ch === '\r' || ch === '\n') {
        if (buf.trim()) rawParts.push(buf.trim());
        buf = '';
        while (i < trimmed.length && (trimmed[i] === '\r' || trimmed[i] === '\n')) i++;
        continue;
      }

      const isTerminator =
        ch === '。' ||
        ch === '！' ||
        ch === '？' ||
        ch === '…' ||
        ch === '!' ||
        ch === '?' ||
        (ch === '.' && shouldSplitAsciiDot(trimmed, i, buf));

      if (isTerminator) {
        buf += ch;
        i++;
        // Consume clustered sentence terminators (e.g. `……`, `？！`, `...`)
        while (i < trimmed.length && SENTENCE_END_PUNCT_RE.test(trimmed[i])) {
          buf += trimmed[i++];
        }
        // Attach immediately adjacent closing quotation marks / parentheses to the ending sentence
        while (i < trimmed.length && SENTENCE_TRAIL_CLOSERS.has(trimmed[i])) {
          buf += trimmed[i++];
        }
        if (buf.trim()) rawParts.push(buf.trim());
        buf = '';
        continue;
      }
    }

    buf += ch;
    i++;
  }

  if (buf.trim()) rawParts.push(buf.trim());

  const speakable = rawParts.filter((part) => SPEAKABLE_RE.test(part));
  const finalTexts = speakable.length > 0 ? speakable : [trimmed];

  return finalTexts.map((text, idx) => ({
    text,
    language: classifySentenceLanguage(text),
    trailingPauseMs: idx + 1 < finalTexts.length ? 350 : 0,
  }));
}

/**
 * Determine the dominant language / compilation path for a single sentence chunk.
 */
export function classifySentenceLanguage(sentence: string): SentenceLanguage {
  if (
    sentence.includes('[') ||
    sentence.includes('［') ||
    sentence.includes('{') ||
    EXPLICIT_IPA_MARK_RE.test(sentence)
  ) {
    return 'rule';
  }

  const tokens = sentence
    .split(/[\s,，、：:;；.!?。！？…()（）"“”‘’《》「」]+/u)
    .filter(Boolean);
  if (tokens.some((tok) => looksLikeBareIpaToken(tok))) {
    return 'rule';
  }

  const hasKana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(sentence);
  const hasHan = /\p{Script=Han}/u.test(sentence);
  const hasLatin = /\p{Script=Latin}/u.test(sentence);

  if (hasKana && !hasLatin) return 'ja';
  if (hasHan && !hasKana && !hasLatin) return 'zh';
  if (hasLatin && !hasHan && !hasKana) return 'en';
  if (hasHan && hasLatin && !hasKana) return 'zh_en';
  return 'rule';
}

const SENTENCE_ID_PREFIX_RE = /^s(\d+)_/u;

/**
 * Partition `[fromSmp, toSmp)` of a multi-sentence clip at silence boundaries between
 * consecutive `s<n>_*` sentence groups so each sentence can be synthesized with an
 * independent vocal tract state and stitched sample-accurately onto the unified timeline.
 */
export function partitionClipSentenceWindows(
  clip: Pick<Clip, 'start_smp' | 'end_smp' | 'syllable_order' | 'syllables'>,
  fromSmp?: number,
  toSmp?: number,
): SentenceSynthesisWindow[] {
  const start = Math.max(clip.start_smp, fromSmp ?? clip.start_smp);
  const end = Math.min(clip.end_smp, toSmp ?? clip.end_smp);
  if (end <= start) return [];

  interface SentenceSpan {
    tag: string;
    startSmp: number;
    endSmp: number;
  }

  const groups: SentenceSpan[] = [];
  for (const id of clip.syllable_order) {
    const syl = clip.syllables[id];
    if (!syl) continue;
    const match = SENTENCE_ID_PREFIX_RE.exec(id);
    if (!match) continue;
    const tag = match[1];
    const last = groups[groups.length - 1];
    if (last && last.tag === tag) {
      last.startSmp = Math.min(last.startSmp, syl.start_smp);
      last.endSmp = Math.max(last.endSmp, syl.end_smp);
    } else {
      groups.push({ tag, startSmp: syl.start_smp, endSmp: syl.end_smp });
    }
  }

  const overlapping = groups.filter((g) => g.endSmp > start && g.startSmp < end);
  if (overlapping.length <= 1) {
    return [{ startSmp: start, endSmp: end }];
  }

  // Merge adjacent sentence groups whose pause gap is < 40 ms so we never slice inside speech.
  const merged: SentenceSpan[] = [{ ...overlapping[0] }];
  const minGapSmp = msToSamples(40);
  for (let i = 1; i < overlapping.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = overlapping[i];
    if (cur.startSmp - prev.endSmp < minGapSmp) {
      prev.endSmp = Math.max(prev.endSmp, cur.endSmp);
    } else {
      merged.push({ ...cur });
    }
  }

  if (merged.length <= 1) {
    return [{ startSmp: start, endSmp: end }];
  }

  const windows: SentenceSynthesisWindow[] = [];
  let winStart = start;
  for (let i = 0; i < merged.length - 1; i++) {
    const gapLo = Math.max(winStart + 1, merged[i].endSmp);
    const gapHi = Math.min(end - 1, merged[i + 1].startSmp);
    let cutSmp: number;
    if (gapHi <= gapLo) {
      cutSmp = Math.max(winStart + 1, Math.min(end - 1, Math.round((gapLo + gapHi) / 2)));
    } else {
      const mid = Math.round((gapLo + gapHi) / 2);
      const snapped = Math.round(mid / FRAME_50HZ_SMP) * FRAME_50HZ_SMP;
      cutSmp =
        snapped >= gapLo + FRAME_50HZ_SMP / 2 && snapped <= gapHi - FRAME_50HZ_SMP / 2
          ? snapped
          : mid;
    }
    if (cutSmp > winStart && cutSmp < end) {
      windows.push({ startSmp: winStart, endSmp: cutSmp });
      winStart = cutSmp;
    }
  }
  windows.push({ startSmp: winStart, endSmp: end });
  return windows;
}
