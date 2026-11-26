import {tr} from './shims.ts';

export const pauseMark=/^[,，、：:;；.!?。！？…\r\n]+$/u;
export const longPause=/[.!?。！？…\n]/u;
export const startsIpa=(word:string)=>word.startsWith('[')||word.startsWith('［');

/**
 * Characters that unambiguously mark bare phonetic/IPA notation (never ordinary English orthography):
 *  - IPA extensions, spacing modifiers, superscript tone digits, Chao tone bars, left-stem sandhi bars,
 *    combining diacritics on phonetic bases, tie bars, stress/length/step marks.
 */
const BARE_IPA_MARKER_RE =
  /[ɐ-ʯᴀ-ᶿ⁰¹²³⁴⁵⁶⁷⁸⁹˥˦˧˨˩꜒꜓꜔꜕꜖ˈˌːˑʰʱʷʲˠˤ˞̚ʼⁿˡ˔˕˖˗˓˒˘͜͡‿ꜛꜜθðβɸχʁħʕʡʢʘǀǃǂǁɓɗʄɠʛɱɳɲɴɬɮʋɹɻɰɭʎʟɾɽʀʙɚɝɪʏʊɛœøɯɤʌɑɒɔəɨʉɶɘɵɜɞɿʅ]|[\u0300-\u036F\u1DC0-\u1DFF]/u;

const PAREN_TONE_BAR_RE = /\([˥˦˧˨˩꜒꜓꜔꜕꜖⁰¹²³⁴⁵⁶⁷⁸⁹]+\)/u;

export function looksLikeBareIpaToken(token: string): boolean {
  if (!token || pauseMark.test(token)) return false;
  if (/^\d+$/u.test(token)) return false;
  return BARE_IPA_MARKER_RE.test(token) || PAREN_TONE_BAR_RE.test(token);
}

/**
 * Split the interior of `[...]` (or a bare IPA run) into per-syllable `[...]` tokens and pause marks:
 *  - Whitespace separates syllables (`[jɜu¹¹ jɜt⁴⁵]` -> `['[jɜu¹¹]', '[jɜt⁴⁵]']`).
 *  - Punctuation (`,`, `;`, `?`, `!`, sentence-final `.`) becomes a pause token.
 *  - Word-internal `.` (e.g. `ˈfəʊ.nɪ.tɪks`) splits adjacent syllables with zero pause.
 *  - Linking arc `‿` attaches to the preceding syllable so zero-gap linking is preserved.
 */
export function splitIpaSpanTokens(rawInner: string): string[] {
  const out: string[] = [];
  // Strip dotted-circle placeholder `◌` (U+25CC) copied from IPA charts when attached after a base
  const trimmed = rawInner
    .trim()
    .replace(/(?<=[^\s,，、：:;；!?。！？….\u25cc])\u25cc(?=[\p{M}ʰʱʷʲˠˤ˞ʼⁿˡːˑ˘˔˕˖˗˓˒])/gu, '');
  if (!trimmed) return out;

  // Match parenthesized sandhi contours like `(˦˥˦꜓꜓)` attached to a syllable, pause punctuation, or non-space run
  const pieces =
    trimmed.match(
      /(?:[^\s,，、：:;；!?。！？…]+(?:\([˥˦˧˨˩꜒꜓꜔꜕꜖⁰¹²³⁴⁵⁶⁷⁸⁹]+\))?)|[,，、：:;；!?。！？…]+/gu,
    ) ?? [];

  for (let piece of pieces) {
    if (pauseMark.test(piece)) {
      out.push(piece);
      continue;
    }
    const orphanDiacritic = /^(?:\u25cc)?([\p{M}ʰʱʷʲˠˤ˞ʼⁿˡːˑ˘˔˕˖˗˓˒]+)$/u.exec(piece);
    if (orphanDiacritic) {
      const prev = out.at(-1);
      if (prev && prev.startsWith('[') && prev.endsWith(']')) {
        out[out.length - 1] = `[${prev.slice(1, -1)}${orphanDiacritic[1]}]`;
      }
      continue;
    }
    if (piece === '\u25cc') continue;
    // Trailing sentence period(s), e.g. `lei³¹.`
    let trailingSentenceDot = '';
    const trailMatch = /^(.*?)(\.+)$/u.exec(piece);
    if (trailMatch && trailMatch[1]) {
      piece = trailMatch[1];
      trailingSentenceDot = trailMatch[2];
    } else if (/^\.+$/u.test(piece)) {
      out.push('.');
      continue;
    }

    // Split on linking arc `‿` while keeping `‿` on the left syllable to signal zero-gap liaison
    const liaisonParts = piece.split(/(?<=‿)|(?=‿)/gu);
    const mergedLiaison: string[] = [];
    for (const lp of liaisonParts) {
      if (lp === '‿') {
        if (mergedLiaison.length > 0) mergedLiaison[mergedLiaison.length - 1] += '‿';
      } else if (lp) {
        mergedLiaison.push(lp);
      }
    }

    for (const wordChunk of mergedLiaison) {
      // Split on explicit syllable dot `.` inside IPA word (e.g. `nɔ˞.məl`)
      const dotSyllables = wordChunk.split('.').map((s) => s.trim()).filter(Boolean);
      for (const syl of dotSyllables) {
        // Plain ASCII digits standing alone remain plain digit tokens (read as numbers, not IPA)
        if (/^\d+$/u.test(syl)) {
          out.push(syl);
        } else {
          out.push(`[${syl}]`);
        }
      }
    }

    if (trailingSentenceDot) {
      out.push(trailingSentenceDot);
    }
  }
  return out;
}

/**
 * Tokenize unbracketed text:
 *  - Han characters individually
 *  - Bare IPA syllables (including Chao tone bars, superscript tones, and parenthesized sandhi) as `[...]`
 *  - Pure ASCII numbers `\d+` as separate number tokens (never merged as tone suffixes!)
 *  - Plain Latin words (with apostrophes)
 *  - Punctuation / line breaks
 */
export function tokens(text: string): string[] {
  const rawRuns =
    text.match(
      /\p{Script=Han}|\d+|[^\s\p{Script=Han},，、：:;；!?。！？…\[\]［］"“”‘’《》「」]+(?:\([˥˦˧˨˩꜒꜓꜔꜕꜖⁰¹²³⁴⁵⁶⁷⁸⁹]+\))?|\r?\n|[^\s]/gu,
    ) ?? [];

  // Heuristic: if ≥40% of multi-char runs in this chunk contain unambiguous IPA markers,
  // treat adjacent short ASCII phonetic syllables (like `la`, `ma`, `si`, `mi`) in the same IPA sentence as IPA too.
  const wordLike = rawRuns.filter((r) => r.length > 1 && !pauseMark.test(r) && !/^\d+$/u.test(r));
  const ipaRatio =
    wordLike.length > 0
      ? wordLike.filter((r) => looksLikeBareIpaToken(r)).length / wordLike.length
      : 0;
  const inBareIpaPassage = ipaRatio >= 0.5 && wordLike.length >= 2;

  const out: string[] = [];
  for (const run of rawRuns) {
    if (/^\p{Script=Han}$/u.test(run) || /^\d+$/u.test(run) || pauseMark.test(run)) {
      out.push(run);
      continue;
    }
    if (looksLikeBareIpaToken(run) || (inBareIpaPassage && /^[\p{Script=Latin}\p{M}']+$/u.test(run))) {
      out.push(...splitIpaSpanTokens(run));
      continue;
    }
    // Split plain text run into standard words, numbers, and punctuation
    const sub =
      run.match(
        /\d+|[\p{Script=Latin}\p{M}]+(?:['’][\p{Script=Latin}\p{M}]+)*|[^\s]/gu,
      ) ?? [];
    out.push(...sub);
  }
  return out;
}

export function speechTokens(source: string): string[] {
  const result: string[] = [];
  const chunks = source.match(/\[[^\[\]［］]*\]|［[^\[\]［］]*］|[^\[\]［］]+|[\[\]［］]/gu) ?? [];
  for (const chunk of chunks) {
    if (startsIpa(chunk) && chunk.length > 1) {
      const inner = chunk.slice(1, -1).trim();
      if (inner) result.push(...splitIpaSpanTokens(inner));
    } else if (/[\[\]［］]/u.test(chunk)) {
      throw Error(tr('modules.vocal-tract.text_brackets'));
    } else {
      result.push(...tokens(chunk));
    }
  }
  return result;
}

// Keep neighbouring kana together for mora segmentation and dictionary lookup.
const kanaRun = /([ぁ-ゖァ-ヶーゟヿ・\u3099\u309a\uff65-\uff9f]+)/gu;
export const isKanaRun = (value: string) => /^[ぁ-ゖァ-ヶーゟヿ・\u3099\u309a\uff65-\uff9f]+$/u.test(value);

export function mixedSpeechTokens(source: string): string[] {
  const chunks = source.split(/(\[[^\[\]［］]*\]|［[^\[\]［］]*］)/gu);
  return chunks.flatMap((chunk) =>
    startsIpa(chunk) && chunk.length > 1
      ? speechTokens(chunk)
      : chunk.split(kanaRun).flatMap((part) => (isKanaRun(part) ? [part] : speechTokens(part))),
  );
}
