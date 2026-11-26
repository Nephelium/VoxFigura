import {
  F0_LIMIT_HZ,
  SAMPLE_RATE_HZ,
  hzToSt,
  stToHz,
  type ArticulatorGroup,
  type LandmarkRole,
  type MannerClass,
  type QtaTargetSpan,
} from '@vocalcut/core';

/** Unicode spelling is preserved on the annotation. Normalization is only for lookup. */
const suffix = /[\p{M}ʰʱʷʲˠˤ˞ʼⁿˡːˑ˘˔˕˖˗˓˒]/u;
const boundary = /[\s.·|‖#‿ꜛꜜ↑↓↗↘ˈˌ/\[\]()˥˦˧˨˩꜒꜓꜔꜕꜖⁰¹²³⁴⁵⁶⁷⁸⁹0-9]/u;
const ties = new Set(['͡', '͜']);
const DOTTED_CIRCLE = '\u25cc';
const referenceAffricates = [
  'pɸ', 'bβ', 'p̪f', 'b̪v', 'p͆f͆', 'b͆v͆', 't̼θ̼', 'd̼ð̼',
  't̪s̪', 'd̪z̪', 't̪θ', 'd̪ð', 't̠s̠', 'd̠z̠', 't͇s͇', 'cç', 'ɟʝ',
  'kx', 'ɡɣ', 'qχ', 'ɢʁ', 'ʡħ', 'ʡʕ', 'tɬ', 'dɮ',
];
const affricatePairs = new Set([
  'tɕ', 'tʂ', 'ts', 'tʃ', 'dʑ', 'dʐ', 'dʒ', 'dz', 'ʈʂ', 'ɖʐ', 'ȶɕ', 'ȡʑ',
  ...referenceAffricates,
].map(recordedConsonantKey));
const trialReferenceConsonants = new Set([
  'q', 'pɸ', 'p̪f', 't̪θ', 'cç', 'kx', 'qχ', 'tɬ',
  'pɸʰ', 'p̪fʰ', 't̪θʰ', 'cçʰ', 'kxʰ', 'qχʰ',
  'ɬ', 'ʎ',
].map(recordedConsonantKey));

/**
 * Strip IPA chart dotted-circle placeholders (`◌`, U+25CC) that precede diacritic marks
 * right after a phonetic base (e.g. `a◌̹` -> `a̹`, `t◌ʷ` -> `tʷ`).
 */
export function stripDottedCirclePlaceholders(raw: string): string {
  return raw.replace(
    /(?<=[^\s.·|‖#‿ꜛꜜ↑↓↗↘ˈˌ/\[\]()\u25cc])\u25cc(?=[\p{M}ʰʱʷʲˠˤ˞ʼⁿˡːˑ˘˔˕˖˗˓˒])/gu,
    '',
  );
}

export function recordedConsonantKey(ipa: string): string {
  return ipa
    .replaceAll(DOTTED_CIRCLE, '')
    .normalize('NFD')
    .replace(/[͜͡]/gu, '')
    .replaceAll('g', 'ɡ')
    .replaceAll('̊', '̥');
}

export function usesTrialReferenceTrajectory(ipa: string): boolean {
  return trialReferenceConsonants.has(recordedConsonantKey(ipa));
}

function collectSuffixes(glyphs: readonly string[], start: number): { text: string; next: number } {
  let index = start;
  let text = '';
  while (index < glyphs.length) {
    const ch = glyphs[index];
    if (suffix.test(ch)) {
      index++;
      text += ch;
      if (
        ties.has(ch) &&
        index < glyphs.length &&
        !boundary.test(glyphs[index]) &&
        !suffix.test(glyphs[index]) &&
        glyphs[index] !== DOTTED_CIRCLE
      ) {
        text += glyphs[index++];
      }
      continue;
    }
    if (ch === DOTTED_CIRCLE && index + 1 < glyphs.length && suffix.test(glyphs[index + 1])) {
      index++;
      continue;
    }
    break;
  }
  return { text, next: index };
}

function untiedAffricateEnd(first: string, glyphs: readonly string[], index: number): { text: string; next: number } | null {
  if ([...first].some(sign => ties.has(sign))) return null;
  const second = glyphs[index];
  if (!second || boundary.test(second) || suffix.test(second) || second === DOTTED_CIRCLE) return null;
  let end = index + 1;
  const parts: string[] = [second];
  while (end < glyphs.length) {
    const ch = glyphs[end];
    if (suffix.test(ch)) {
      // A following tie bar belongs to a separately annotated segment.
      if (ties.has(ch)) return null;
      parts.push(ch);
      end++;
      continue;
    }
    if (ch === DOTTED_CIRCLE && end + 1 < glyphs.length && suffix.test(glyphs[end + 1])) {
      if (ties.has(glyphs[end + 1])) return null;
      end++;
      continue;
    }
    break;
  }
  for (let candidate = parts.length; candidate > 0; candidate--) {
    const pair = first + parts.slice(0, candidate).join('');
    if (affricatePairs.has(recordedConsonantKey(pair))) {
      return { text: parts.join(''), next: end };
    }
  }
  return null;
}

function hasNonSyllabicGlideAt(glyphs: readonly string[], vowelIndex: number): boolean {
  let k = vowelIndex + 1;
  while (k < glyphs.length) {
    const ch = glyphs[k];
    if (ch === DOTTED_CIRCLE && k + 1 < glyphs.length && suffix.test(glyphs[k + 1])) {
      k++;
      continue;
    }
    if (!suffix.test(ch)) break;
    if (ch === '\u032F' || ch === '\u0311') return true;
    k++;
  }
  return false;
}

export function splitPhoneNotation(raw: string): string[] {
  // Strip parenthesized tone sandhi annotations like `(˦˥˦꜓꜓)` before segmenting phones
  const withoutToneParen = raw.trim().replace(/\([˥˦˧˨˩꜒꜓꜔꜕꜖⁰¹²³⁴⁵⁶⁷⁸⁹\s]+\)/gu, '');
  const glyphs = Array.from(withoutToneParen);
  const out: string[] = [];
  let index = 0;
  let hadBoundary = true;
  while (index < glyphs.length) {
    let segment = glyphs[index++];
    if (boundary.test(segment)) {
      hadBoundary = true;
      continue;
    }
    // Strip dotted-circle placeholder `◌` (U+25CC): attach its diacritic suffixes to the preceding
    // segment when contiguous, and never emit a phantom vowel segment when orphaned.
    if (segment === DOTTED_CIRCLE) {
      const collected = collectSuffixes(glyphs, index);
      index = collected.next;
      if (collected.text && !hadBoundary && out.length > 0) {
        out[out.length - 1] += collected.text;
      }
      continue;
    }
    // Ignore orphaned standalone combining/modifier marks with no preceding base segment.
    if (suffix.test(segment)) {
      const collected = collectSuffixes(glyphs, index);
      index = collected.next;
      continue;
    }
    const attached = collectSuffixes(glyphs, index);
    segment += attached.text;
    index = attached.next;

    const affricate = untiedAffricateEnd(segment, glyphs, index);
    if (affricate) {
      segment += affricate.text;
      index = affricate.next;
    }
    // Preserve diphthongs marked explicitly with a non-syllabic glide diacritic (e.g. aɪ̯).
    while (
      vowels.includes(segment[0] ?? '') &&
      index < glyphs.length &&
      vowels.includes(glyphs[index]) &&
      hasNonSyllabicGlideAt(glyphs, index)
    ) {
      segment += glyphs[index++];
      const glideSuffix = collectSuffixes(glyphs, index);
      segment += glideSuffix.text;
      index = glideSuffix.next;
    }
    out.push(segment);
    hadBoundary = false;
  }
  return out;
}

const equivalents: Record<string, string> = {
  'ɚ': 'ə˞',
  'ɝ': 'ɜ˞',
  'ɫ': 'l̴',
  '̊': '̥',
  '̍': '̩',
  '̑': '̯',
  '˔': '̝',
  '˕': '̞',
  '˖': '̟',
  '˗': '̠',
  '˓': '̹',
  '˒': '̜',
  '͗': '̹',
  '͑': '̜',
  '˘': '\u0306',
};

export function normalizedPhone(raw: string): string {
  return Array.from(
    raw.replaceAll(DOTTED_CIRCLE, '').normalize('NFD').replaceAll('ç', 'ç'),
    (glyph) => equivalents[glyph] ?? glyph,
  ).join('');
}

const vowels = 'aeiouyɑɒɔəɛɤɪʊʌæɐøœɨʉɯɶɞɘɵɜɚɝɩʏɿʅʮʯᴀᴇ';
const stops = new Set(Array.from('pbtdʈɖȶȡcɟkɡgqɢʡʔɓɗʄɠʛ'));
const voiceless = new Set(Array.from('ptʈȶckqʡʔɸfθsʃʂɕçxχħʜhɬʍɧ'));
const nasals = 'mɱnɳɲŋɴ';
const sonorants = new Set(Array.from(nasals + 'lɭʎʟɹɻjɰwʋrʀʙ'));
const fricatives = 'ɸβfvθðszʃʒʂʐɕʑçʝxɣχʁħʕʜʢhɦɬɮʍɧ';

export type PhoneReleaseMode = 'oral' | 'unreleased' | 'nasal' | 'lateral';

export function phoneTraits(raw: string) {
  const text = normalizedPhone(raw);
  const base = text.replace(/[\p{M}ʰʱʷʲˠˤ˞ʼⁿˡːˑ˘˔˕˖˗˓˒\u25cc]/gu, '');
  const first = Array.from(base)[0] ?? '';
  let lengthScale = 1.0;
  if (raw.includes('ː')) lengthScale *= 1.65;
  if (raw.includes('ˑ')) lengthScale *= 1.30;
  if (text.includes('\u0306') || raw.includes('˘')) lengthScale *= 0.65;

  const hasVoicelessMark = text.includes('̥');
  const hasVoicedMark = text.includes('̬');
  const baseVoiced = !!first && !voiceless.has(first);
  const voiced =
    hasVoicelessMark && !hasVoicedMark
      ? false
      : hasVoicedMark && !hasVoicelessMark
        ? true
        : baseVoiced;

  const hasBreathy = text.includes('\u0324');
  const hasCreaky = text.includes('\u0330');
  const breathy = hasBreathy && !hasCreaky;
  const creaky = hasCreaky && !hasBreathy;

  const hasSyllabic = text.includes('\u0329');
  const hasNonSyllabic = text.includes('\u032F');
  const syllabic = hasSyllabic && !hasNonSyllabic;
  const nonSyllabic = hasNonSyllabic && !hasSyllabic;

  const unreleased = text.includes('\u031A') || raw.includes('̚');
  const nasalRelease = text.includes('ⁿ');
  const lateralRelease = text.includes('ˡ');
  const releaseMode: PhoneReleaseMode = unreleased
    ? 'unreleased'
    : nasalRelease && !lateralRelease
      ? 'nasal'
      : lateralRelease && !nasalRelease
        ? 'lateral'
        : 'oral';

  return {
    base,
    vowel: !!first && vowels.includes(first),
    stop: stops.has(first),
    affricate: stops.has(first) && fricatives.includes(Array.from(base)[1] ?? '\0'),
    fricative: !!first && fricatives.includes(first),
    nasal: !!first && nasals.includes(first),
    sonorant: sonorants.has(first),
    voiced,
    aspirated: /[ʰʱ]/u.test(raw),
    breathy,
    creaky,
    nasalized: text.includes('\u0303'),
    syllabic,
    nonSyllabic,
    unreleased,
    nasalRelease,
    lateralRelease,
    releaseMode,
    lengthScale,
  };
}

const labialBases = new Set(Array.from('pbmɓɸβfvʋwʍʙ'));
const coronalBases = new Set(Array.from('tdʈɖȶȡɗnɳθðszʃʒʂʐɕʑlɭɬɮɹɻr'));
const dorsalBases = new Set(Array.from('cɟʄɲçʝjʎ'));
const velarBases = new Set(Array.from('kɡgqɢɠʛŋɴxɣχʁɰʟʀ'));
const glottalBases = new Set(Array.from('ʡʔħʕʜʢhɦ'));
const lateralBases = new Set(Array.from('lɭʎʟ'));
const approximantBases = new Set(['ʋ', 'ɹ', 'ɻ', 'j', 'ɰ', 'w', 'ɥ', ...lateralBases]);

/** True when a label contains only vowels or approximants, including lateral approximants. */
export function isVowelOrApproximant(label: string): boolean {
  const phones = splitPhoneNotation(label);
  return phones.length > 0 && phones.every((phone) => {
    const traits = phoneTraits(phone);
    return traits.vowel || approximantBases.has(traits.base)
      || (traits.fricative && normalizedPhone(phone).includes('\u031e'));
  });
}

/**
 * Derive true phonetic manner, primary articulator, and continuum landmark role
 * from an IPA phone symbol (preventing obstruents like [s] or [t̚] from being
 * mislabeled as `vowel` / `nucleus` in continuum manifests).
 */
export function classifyContinuumPhone(raw: string): {
  role: LandmarkRole;
  manner: MannerClass;
  articulator: ArticulatorGroup;
} {
  const traits = phoneTraits(raw);
  const first = Array.from(traits.base)[0] ?? '';
  if (!first || traits.vowel) {
    return { role: 'nucleus', manner: 'vowel', articulator: 'vowel' };
  }
  const articulator: ArticulatorGroup = labialBases.has(first)
    ? 'labial'
    : coronalBases.has(first)
      ? 'coronal'
      : dorsalBases.has(first)
        ? 'dorsal'
        : velarBases.has(first)
          ? 'velar'
          : glottalBases.has(first)
            ? 'glottal'
            : 'coronal';
  if (traits.affricate) {
    return { role: 'release', manner: 'affricate', articulator };
  }
  if (traits.stop) {
    return { role: traits.unreleased ? 'closure_onset' : 'release', manner: 'stop', articulator };
  }
  if (traits.fricative) {
    return { role: 'frication_end_voicing_onset', manner: 'fricative', articulator };
  }
  if (traits.nasal) {
    return { role: traits.syllabic ? 'nucleus' : 'closure_onset', manner: 'nasal', articulator };
  }
  if (lateralBases.has(first)) {
    return { role: traits.syllabic ? 'nucleus' : 'medial', manner: 'lateral', articulator };
  }
  return { role: traits.syllabic ? 'nucleus' : 'medial', manner: 'approximant', articulator };
}

const OPPOSITE_DIACRITIC_PAIRS: readonly (readonly [readonly string[], readonly string[]])[] = [
  [['\u031f', '˖'], ['\u0320', '˗']],
  [['\u031d', '˔'], ['\u031e', '˕']],
  [['\u0339', '\u0357', '˓'], ['\u031c', '\u0351', '˒']],
  [['\u0318'], ['\u0319']],
  [['\u033a'], ['\u033b']],
  [['\u0325', '\u030a'], ['\u032c']],
  [['\u0329', '\u030d'], ['\u032f', '\u0311']],
  [['\u0324'], ['\u0330']],
  [['\u031a'], ['ʰ', 'ʱ', 'ⁿ', 'ˡ']],
  [['ⁿ'], ['ˡ']],
];

/**
 * Combine an IPA diacritic mark onto an existing phoneme symbol:
 * strips dotted-circle placeholders (`◌`), removes directly conflicting opposite marks,
 * avoids duplicates, and preserves all other marks on the base phoneme.
 */
export function combineIpaDiacritic(baseIpa: string, markRaw: string): string {
  const cleanMark = markRaw.replaceAll(DOTTED_CIRCLE, '').trim();
  const cleanBase = stripDottedCirclePlaceholders(baseIpa).replaceAll(DOTTED_CIRCLE, '').trim();
  if (!cleanBase) return cleanMark;
  if (!cleanMark) return cleanBase;

  const markGlyphs = Array.from(cleanMark.normalize('NFD'));
  let glyphs = Array.from(cleanBase.normalize('NFD').replaceAll('ç', 'ç'));

  for (const mark of markGlyphs) {
    const canonMark = equivalents[mark] ?? mark;
    const toRemove = new Set<string>();
    for (const [sideA, sideB] of OPPOSITE_DIACRITIC_PAIRS) {
      if (sideA.includes(mark) || sideA.includes(canonMark)) {
        for (const opp of sideB) toRemove.add(opp);
      } else if (sideB.includes(mark) || sideB.includes(canonMark)) {
        for (const opp of sideA) toRemove.add(opp);
      }
    }
    if (toRemove.size > 0) {
      glyphs = glyphs.filter((g) => !toRemove.has(g) && !toRemove.has(equivalents[g] ?? g));
    }
    const alreadyPresent = glyphs.some((g) => g === mark || (equivalents[g] ?? g) === canonMark);
    if (!alreadyPresent) {
      glyphs.push(mark);
    }
  }
  return glyphs.join('').normalize('NFC');
}

/** Nasal devoicing changes the glottal gesture. Keep the oral/velic targets of the same nasal. */
export function nasalPoseIpa(ipa: string): string {
  if (!nasals.includes(ipa[0] ?? '\0')) return ipa;
  return ipa.replace(/[̥̊]/gu, '');
}

const toneSigns: Record<string, string> = {
  '̋': '5',
  '́': '4',
  '̄': '3',
  '̀': '2',
  '̏': '1',
  '̌': '15',
  '̂': '51',
  '᷄': '35',
  '᷅': '13',
  '᷈': '342',
};

export function stripIpaToneDiacritics(raw: string): string {
  return [...raw.normalize('NFD')].filter(mark => !Object.hasOwn(toneSigns, mark)).join('');
}

function parseChaoOrSuperscriptDigits(seq: string): { citation: string; sandhi: string } {
  let citation = '';
  let sandhi = '';
  for (const ch of seq) {
    const cIdx = '˩˨˧˦˥'.indexOf(ch);
    if (cIdx >= 0) {
      citation += String(cIdx + 1);
      continue;
    }
    const supIdx = '¹²³⁴⁵'.indexOf(ch);
    if (supIdx >= 0) {
      citation += String(supIdx + 1);
      continue;
    }
    if (ch === '⁰') {
      citation += '3';
      continue;
    }
    const leftIdx = '꜖꜕꜔꜓꜒'.indexOf(ch);
    if (leftIdx >= 0) {
      sandhi += String(leftIdx + 1);
    }
  }
  return { citation, sandhi };
}

export interface ParsedIpaSuprasegmentals {
  /** Primary (`1`), secondary (`2`), or unstressed (`0`) */
  stress: 0 | 1 | 2;
  /** Upstep/downstep cumulative semitone offset (`ꜛ` +1.5 st, `ꜜ` -1.5 st) */
  stepOffsetSt: number;
  /** Liaison tie `‿` removing inter-syllable gap */
  linkedAfter: boolean;
  /** Citation tone digits (e.g. "33", "45") */
  citationTone?: string;
  /** Sandhi / surface tone digits (e.g. "44" from `mi˧˧(˦˥˦꜓꜓)` or "3" from `ɓᴀk̚˥꜔`) */
  sandhiTone?: string;
  /** Effective tone digits driving pitch synthesis (`sandhiTone || citationTone`) */
  effectiveTone?: string;
  /** Checked entering-tone syllable ending in -p, -t, -k, -ʔ or unreleased `̚` */
  checked: boolean;
  /** Recommended duration multiplier from stress + checked syllable structure */
  durationScale: number;
  /** Peak pressure delta in Pa from stress */
  pressureDeltaPa: number;
}

/**
 * Parse IPA suprasegmentals, superscript tone digits (`¹²³⁴⁵` ONLY — plain ASCII `0-9` excluded),
 * Chao tone letters (`˥˦˧˨˩`), left-stem sandhi tone letters (`꜒꜓꜔꜕꜖`), and parenthesized sandhi (`mi˧˧(˦˥˦꜓꜓)`).
 */
export function parseIpaSuprasegmentals(
  raw: string,
  options?: { allowAsciiDigits?: boolean; isUnstressedEnglish?: boolean },
): ParsedIpaSuprasegmentals {
  const trimmed = raw.trim().replace(/^[\[/]+|[\]/]+$/gu, '');
  const linkedAfter = trimmed.includes('‿');
  const stress: 0 | 1 | 2 = trimmed.includes('ˈ') ? 1 : trimmed.includes('ˌ') ? 2 : 0;

  let stepOffsetSt = 0;
  for (const ch of trimmed) {
    if (ch === 'ꜛ') stepOffsetSt += 1.5;
    else if (ch === 'ꜜ') stepOffsetSt -= 1.5;
  }

  // Extract trailing tone cluster including optional parenthesized sandhi, e.g. `˧˧(˦˥˦꜓꜓)`, `˥꜔`, `˩˧꜕꜖`, `⁴⁵`
  const tonePattern = options?.allowAsciiDigits
    ? /([˩˨˧˦˥꜒꜓꜔꜕꜖⁰¹²³⁴⁵1-5]+)?(?:\(([˩˨˧˦˥꜒꜓꜔꜕꜖⁰¹²³⁴⁵1-5]+)\))?$/u
    : /([˩˨˧˨˩˦˥꜒꜓꜔꜕꜖⁰¹²³⁴⁵]+)?(?:\(([˩˨˧˨˩˦˥꜒꜓꜔꜕꜖⁰¹²³⁴⁵]+)\))?$/u;

  let citationTone: string | undefined;
  let sandhiTone: string | undefined;

  const cleanForTone = trimmed.replace(/‿$/u, '');
  const m = tonePattern.exec(cleanForTone);
  if (m && (m[1] || m[2])) {
    const outsideRaw = m[1] ?? '';
    const insideRaw = m[2] ?? '';
    const normalizeAscii = (s: string) =>
      options?.allowAsciiDigits
        ? [...s].map((c) => ('12345'.includes(c) ? '˩˨˧˦˥'[Number(c) - 1] : c)).join('')
        : s;

    const outParsed = parseChaoOrSuperscriptDigits(normalizeAscii(outsideRaw));
    const inParsed = parseChaoOrSuperscriptDigits(normalizeAscii(insideRaw));

    citationTone = outParsed.citation || inParsed.citation || undefined;
    // Left-stem sandhi bars win first; otherwise parenthesized contour acts as sandhi surface pitch
    sandhiTone = inParsed.sandhi || outParsed.sandhi || inParsed.citation || undefined;
  } else {
    // Check combining tone diacritics (á, à, ǎ, â, etc.)
    const marks = Array.from(cleanForTone.normalize('NFD')).filter((mark) => mark in toneSigns);
    if (marks.length > 0) {
      citationTone = marks.map((mark) => toneSigns[mark]).join('');
    }
  }

  const effectiveTone = sandhiTone ?? citationTone;
  const phones = splitPhoneNotation(trimmed);
  const lastPhone = phones.at(-1) ?? '';
  const lastTraits = lastPhone ? phoneTraits(lastPhone) : null;
  const checked = Boolean(
    lastTraits &&
      (lastTraits.unreleased ||
        (phones.length >= 2 && !lastTraits.vowel && ['p', 't', 'k', 'ʔ'].includes(lastTraits.base))),
  );

  let durationScale = 1.0;
  let pressureDeltaPa = 0;
  if (stress === 1) {
    durationScale *= 1.25;
    pressureDeltaPa = 100;
  } else if (stress === 2) {
    durationScale *= 1.10;
    pressureDeltaPa = 40;
  } else if (options?.isUnstressedEnglish) {
    durationScale *= 0.82;
    pressureDeltaPa = -40;
  }
  if (checked) {
    durationScale *= 0.65;
  }

  return {
    stress,
    stepOffsetSt,
    linkedAfter,
    citationTone,
    sandhiTone,
    effectiveTone,
    checked,
    durationScale,
    pressureDeltaPa,
  };
}

/**
 * Extract effective 5-level tone digits (`1..5`).
 * By default, only superscript digits (`¹²³⁴⁵`), Chao bars (`˥˦˧˨˩`), left-stem sandhi bars (`꜒꜓꜔꜕꜖`),
 * parenthesized sandhi, and combining tone marks are treated as tone (plain ASCII `0-9` are NOT tone).
 */
export function writtenToneLevels(raw: string, allowAsciiDigits = false): string | undefined {
  return parseIpaSuprasegmentals(raw, { allowAsciiDigits }).effectiveTone;
}

/** Convert Chao 1..5 tone level into semitone offset relative to `fRefHz`, clamped safely within `[60, 600] Hz`. */
export function chaoLevelToSemitone(level: number, fRefHz = 165, extraOffsetSt = 0): number {
  const clampedLevel = Math.max(1, Math.min(5, level));
  // 5-level log-F0 scale: 1 -> -5.0 st, 2 -> -2.5 st, 3 -> 0.0 st, 4 -> +2.5 st, 5 -> +5.0 st
  const rawSt = (clampedLevel - 3) * 2.5 + extraOffsetSt;
  const minSt = hzToSt(F0_LIMIT_HZ.min + 4, fRefHz);
  const maxSt = hzToSt(F0_LIMIT_HZ.max - 10, fRefHz);
  return Math.max(minSt, Math.min(maxSt, rawSt));
}

/**
 * Build Prom-on et al. (2009) 3rd-order qTA target spans for a syllable from its tone levels,
 * primary/secondary stress, and upstep/downstep offset.
 *  - 1 or 2 levels (e.g. `5`, `55`, `45`, `31`, `23`, `11`): single qTA span with linear target slope
 *  - 3+ levels (e.g. `214`, `454`): two sequential qTA spans capturing the convex/concave turning point
 */
export function buildSyllableQtaTargets(
  sylId: string,
  startSmp: number,
  endSmp: number,
  options: {
    effectiveTone?: string;
    stress?: 0 | 1 | 2;
    stepOffsetSt?: number;
    fRefHz?: number;
    voiced?: boolean;
  } = {},
): QtaTargetSpan[] {
  const fRefHz = options.fRefHz ?? 165;
  const stressBoostSt = options.stress === 1 ? 3.0 : options.stress === 2 ? 1.2 : 0;
  const baseShiftSt = stressBoostSt + (options.stepOffsetSt ?? 0);
  const durSec = Math.max(0.04, (endSmp - startSmp) / SAMPLE_RATE_HZ);
  const voiced = options.voiced !== false;

  const digits = (options.effectiveTone ?? '')
    .split('')
    .map((d) => Number(d))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);

  if (digits.length === 0) {
    // Intonational stress/neutral pitch target (e.g. English stressed vs unstressed syllable)
    const minSt = hzToSt(F0_LIMIT_HZ.min + 4, fRefHz);
    const maxSt = hzToSt(F0_LIMIT_HZ.max - 10, fRefHz);
    const bEnd = Math.max(minSt, Math.min(maxSt, (options.stress === 0 ? -1.0 : 0) + baseShiftSt));
    const mSlope = options.stress === 1 ? -4.5 : 0;
    return [
      {
        id: `${sylId}_t0`,
        span_id: sylId,
        start_smp: startSmp,
        end_smp: endSmp,
        voiced,
        candidates: {
          default: {
            m_st_per_s: mSlope,
            b_end_st: Number(bEnd.toFixed(2)),
            lambda_per_s: 36,
            source: 'default',
          },
        },
      },
    ];
  }

  if (digits.length === 1 || (digits.length === 2 && digits[0] === digits[1])) {
    const bEnd = chaoLevelToSemitone(digits[0], fRefHz, baseShiftSt);
    return [
      {
        id: `${sylId}_t0`,
        span_id: sylId,
        start_smp: startSmp,
        end_smp: endSmp,
        voiced,
        candidates: {
          default: {
            m_st_per_s: 0,
            b_end_st: Number(bEnd.toFixed(2)),
            lambda_per_s: 46,
            source: 'default',
          },
        },
      },
    ];
  }

  if (digits.length === 2) {
    const stStart = chaoLevelToSemitone(digits[0], fRefHz, baseShiftSt);
    const stEnd = chaoLevelToSemitone(digits[1], fRefHz, baseShiftSt);
    const slope = Math.max(-95, Math.min(95, (stEnd - stStart) / durSec));
    // Verify start Hz stays in [60, 600]
    const safeSlope =
      stToHz(stEnd - slope * durSec, fRefHz) < F0_LIMIT_HZ.min + 2 ||
      stToHz(stEnd - slope * durSec, fRefHz) > F0_LIMIT_HZ.max - 5
        ? 0
        : slope;
    return [
      {
        id: `${sylId}_t0`,
        span_id: sylId,
        start_smp: startSmp,
        end_smp: endSmp,
        voiced,
        candidates: {
          default: {
            m_st_per_s: Number(safeSlope.toFixed(2)),
            b_end_st: Number(stEnd.toFixed(2)),
            lambda_per_s: 42,
            source: 'default',
          },
        },
      },
    ];
  }

  // Complex 3+ digit contour (e.g. 214, 454): split into 2 qTA spans at midpoint
  const midSmp = startSmp + Math.round((endSmp - startSmp) * 0.52);
  const dur1 = Math.max(0.025, (midSmp - startSmp) / SAMPLE_RATE_HZ);
  const dur2 = Math.max(0.025, (endSmp - midSmp) / SAMPLE_RATE_HZ);
  const st0 = chaoLevelToSemitone(digits[0], fRefHz, baseShiftSt);
  const st1 = chaoLevelToSemitone(digits[1], fRefHz, baseShiftSt);
  const st2 = chaoLevelToSemitone(digits[digits.length - 1], fRefHz, baseShiftSt);
  const m1 = Math.max(-95, Math.min(95, (st1 - st0) / dur1));
  const m2 = Math.max(-95, Math.min(95, (st2 - st1) / dur2));

  return [
    {
      id: `${sylId}_t0`,
      span_id: `${sylId}_a`,
      start_smp: startSmp,
      end_smp: Math.max(startSmp + 1, midSmp),
      voiced,
      candidates: {
        default: {
          m_st_per_s: Number(m1.toFixed(2)),
          b_end_st: Number(st1.toFixed(2)),
          lambda_per_s: 48,
          source: 'default',
        },
      },
    },
    {
      id: `${sylId}_t1`,
      span_id: `${sylId}_b`,
      start_smp: Math.max(startSmp + 1, midSmp),
      end_smp: Math.max(midSmp + 2, endSmp),
      voiced,
      candidates: {
        default: {
          m_st_per_s: Number(m2.toFixed(2)),
          b_end_st: Number(st2.toFixed(2)),
          lambda_per_s: 48,
          source: 'default',
        },
      },
    },
  ];
}
