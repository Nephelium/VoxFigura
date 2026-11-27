/**
 * Japanese Romaji (Hepburn, Kunrei-shiki, Nihon-shiki, IME & extended katakana)
 * to Hiragana & narrow Tokyo IPA converter.
 *
 * Strictly pure TypeScript, reusing `reviewKana` for narrow Tokyo allophony
 * (6-way moraic nasal assimilation, geminate closures/frication, intervocalic /z, ʑ/,
 * yoon /j/ & /ɰᵝ/ glides, optional singing mode disabling high-vowel devoicing,
 * and offline MFA v3.0.0 Japanese dictionary lookups).
 */
import { reviewKana, type KanaLexicon, type ReviewKanaOptions } from './kana-readings.ts';
import type { ReadingRow } from './text-readings.ts';

export interface RomajiMoraToken {
  /** Original romaji slice for this mora (e.g. 'sa', 'ku', 'ra', 'n', 't'). */
  romaji: string;
  /** Corresponding Hiragana mora (1–2 chars, e.g. 'さ', 'きゃ', 'っ', 'ん', 'ー'). */
  kana: string;
}

const LONG_VOWEL_MAP: Record<string, [string, string]> = {
  'ā': ['a', 'ー'],
  'ī': ['i', 'ー'],
  'ū': ['u', 'ー'],
  'ē': ['e', 'ー'],
  'ō': ['o', 'ー'],
  'â': ['a', 'ー'],
  'î': ['i', 'ー'],
  'û': ['u', 'ー'],
  'ê': ['e', 'ー'],
  'ô': ['o', 'ー'],
};

/**
 * Longest-match romaji-to-hiragana table covering Hepburn, Kunrei-shiki, Nihon-shiki,
 * standard Japanese IME sequences, and extended katakana loanword moras.
 */
const ROMAJI_TABLE: ReadonlyArray<readonly [string, string]> = [
  // 4-char sequences
  ['ltsu', 'っ'],
  ['xtsu', 'っ'],
  // 3-char sequences (palatal yoon, sibilants, extended katakana, Kunrei/Hepburn)
  ['sha', 'しゃ'], ['shi', 'し'], ['shu', 'しゅ'], ['she', 'しぇ'], ['sho', 'しょ'],
  ['sya', 'しゃ'], ['syu', 'しゅ'], ['sye', 'しぇ'], ['syo', 'しょ'],
  ['cha', 'ちゃ'], ['chi', 'ち'], ['chu', 'ちゅ'], ['che', 'ちぇ'], ['cho', 'ちょ'],
  ['tya', 'ちゃ'], ['tyu', 'ちゅ'], ['tye', 'ちぇ'], ['tyo', 'ちょ'],
  ['cya', 'ちゃ'], ['cyu', 'ちゅ'], ['cye', 'ちぇ'], ['cyo', 'ちょ'],
  ['tsu', 'つ'], ['tsa', 'つぁ'], ['tsi', 'つぃ'], ['tse', 'つぇ'], ['tso', 'つぉ'],
  ['tha', 'てゃ'], ['thi', 'てぃ'], ['thu', 'てゅ'], ['the', 'てぇ'], ['tho', 'てょ'],
  ['dha', 'でゃ'], ['dhi', 'でぃ'], ['dhu', 'でゅ'], ['dhe', 'でぇ'], ['dho', 'でょ'],
  ['dya', 'ぢゃ'], ['dyi', 'でぃ'], ['dyu', 'でゅ'], ['dye', 'ぢぇ'], ['dyo', 'ぢょ'],
  ['twu', 'とぅ'], ['dwu', 'どぅ'],
  ['kya', 'きゃ'], ['kyu', 'きゅ'], ['kye', 'きぇ'], ['kyo', 'きょ'],
  ['gya', 'ぎゃ'], ['gyu', 'ぎゅ'], ['gye', 'ぎぇ'], ['gyo', 'ぎょ'],
  ['kwa', 'くぁ'], ['kwi', 'くぃ'], ['kwe', 'くぇ'], ['kwo', 'くぉ'],
  ['gwa', 'ぐぁ'], ['gwi', 'ぐぃ'], ['gwe', 'ぐぇ'], ['gwo', 'ぐぉ'],
  ['nya', 'にゃ'], ['nyu', 'にゅ'], ['nye', 'にぇ'], ['nyo', 'にょ'],
  ['hya', 'ひゃ'], ['hyu', 'ひゅ'], ['hye', 'ひぇ'], ['hyo', 'ひょ'],
  ['bya', 'びゃ'], ['byu', 'びゅ'], ['bye', 'びぇ'], ['byo', 'びょ'],
  ['pya', 'ぴゃ'], ['pyu', 'ぴゅ'], ['pye', 'ぴぇ'], ['pyo', 'ぴょ'],
  ['mya', 'みゃ'], ['myu', 'みゅ'], ['mye', 'みぇ'], ['myo', 'みょ'],
  ['rya', 'りゃ'], ['ryu', 'りゅ'], ['rye', 'りぇ'], ['ryo', 'りょ'],
  ['fya', 'ふゃ'], ['fyu', 'ふゅ'], ['fyo', 'ふょ'],
  ['vya', 'ゔゃ'], ['vyu', 'ゔゅ'], ['vyo', 'ゔょ'],
  ['jya', 'じゃ'], ['jyu', 'じゅ'], ['jye', 'じぇ'], ['jyo', 'じょ'],
  ['zya', 'じゃ'], ['zyu', 'じゅ'], ['zye', 'じぇ'], ['zyo', 'じょ'],
  ['swi', 'すぃ'], ['zwi', 'ずぃ'],
  ['wha', 'うぁ'], ['whi', 'うぃ'], ['whe', 'うぇ'], ['who', 'うぉ'],
  ['ltu', 'っ'], ['xtu', 'っ'],
  // 2-char sequences
  ['ka', 'か'], ['ki', 'き'], ['ku', 'く'], ['ke', 'け'], ['ko', 'こ'],
  ['ga', 'が'], ['gi', 'ぎ'], ['gu', 'ぐ'], ['ge', 'げ'], ['go', 'ご'],
  ['sa', 'さ'], ['si', 'し'], ['su', 'す'], ['se', 'せ'], ['so', 'そ'],
  ['za', 'ざ'], ['zi', 'じ'], ['zu', 'ず'], ['ze', 'ぜ'], ['zo', 'ぞ'],
  ['ja', 'じゃ'], ['ji', 'じ'], ['ju', 'じゅ'], ['je', 'じぇ'], ['jo', 'じょ'],
  ['ta', 'た'], ['ti', 'ち'], ['tu', 'つ'], ['te', 'て'], ['to', 'と'],
  ['da', 'だ'], ['di', 'ぢ'], ['du', 'づ'], ['de', 'で'], ['do', 'ど'],
  ['na', 'な'], ['ni', 'に'], ['nu', 'ぬ'], ['ne', 'ね'], ['no', 'の'],
  ['ha', 'は'], ['hi', 'ひ'], ['hu', 'ふ'], ['he', 'へ'], ['ho', 'ほ'],
  ['fa', 'ふぁ'], ['fi', 'ふぃ'], ['fu', 'ふ'], ['fe', 'ふぇ'], ['fo', 'ふぉ'],
  ['ba', 'ば'], ['bi', 'び'], ['bu', 'ぶ'], ['be', 'べ'], ['bo', 'ぼ'],
  ['pa', 'ぱ'], ['pi', 'ぴ'], ['pu', 'ぷ'], ['pe', 'ぺ'], ['po', 'ぽ'],
  ['ma', 'ま'], ['mi', 'み'], ['mu', 'む'], ['me', 'め'], ['mo', 'も'],
  ['ya', 'や'], ['yi', 'い'], ['yu', 'ゆ'], ['ye', 'いぇ'], ['yo', 'よ'],
  ['ra', 'ら'], ['ri', 'り'], ['ru', 'る'], ['re', 'れ'], ['ro', 'ろ'],
  ['wa', 'わ'], ['wi', 'うぃ'], ['wu', 'う'], ['we', 'うぇ'], ['wo', 'を'],
  ['va', 'ゔぁ'], ['vi', 'ゔぃ'], ['vu', 'ゔ'], ['ve', 'ゔぇ'], ['vo', 'ゔぉ'],
  ['dz', 'づ'],
  // 1-char vowels
  ['a', 'あ'], ['i', 'い'], ['u', 'う'], ['e', 'え'], ['o', 'お'],
];

const ROMAJI_MAP = new Map<string, string>(ROMAJI_TABLE);
const GEMINATE_CONSONANTS = new Set(['k', 'g', 's', 'z', 'j', 't', 'd', 'h', 'f', 'b', 'p', 'r', 'w', 'v', 'c']);
const VOWELS_OR_Y = new Set(['a', 'i', 'u', 'e', 'o', 'y']);
const LABIAL_CONSONANTS = new Set(['b', 'p', 'm']);

/** Normalize macrons/circumflexes into base vowel + `ー` marker while keeping case folded. */
function preprocessRomaji(raw: string): string {
  const nfc = raw.normalize('NFC').toLowerCase().replace(/’/gu, "'");
  let out = '';
  for (const ch of nfc) {
    const mapped = LONG_VOWEL_MAP[ch];
    if (mapped) {
      out += mapped[0] + mapped[1];
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Parse a single Japanese romaji word (or hyphen/apostrophe-delimited romaji string)
 * into an ordered list of `{ romaji, kana }` moras.
 * Returns `null` if the string cannot be cleanly parsed as valid Japanese romaji.
 */
export function romajiToMoras(rawWord: string): RomajiMoraToken[] | null {
  const trimmed = rawWord.trim();
  if (!trimmed) return null;
  // Reject standalone control symbols or anything containing non-romaji punctuation/digits.
  if (trimmed === '-' || trimmed === "'" || trimmed === 'ー') return null;
  const s = preprocessRomaji(trimmed);
  if (!/^[a-z'ー-]+$/u.test(s)) return null;

  const moras: RomajiMoraToken[] = [];
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    // Separator apostrophe after a completed mora (e.g. shin'ai -> shi + n + a + i)
    if (ch === "'") {
      if (moras.length === 0) return null;
      i++;
      continue;
    }

    // Long vowel mark `ー` or hyphen `-` after a vowel mora (e.g. ra-men, kōhī)
    if (ch === 'ー' || ch === '-') {
      if (moras.length === 0) return null;
      const prevKana = moras[moras.length - 1].kana;
      // Treat `-` after `n` as syllable separator (`shin-ai` -> `しんあい`), not prolongation
      if (ch === '-' && prevKana === 'ん') {
        i++;
        continue;
      }
      if (prevKana === 'っ' || prevKana === 'ん') return null;
      moras.push({ romaji: ch === 'ー' ? 'ー' : '-', kana: 'ー' });
      i++;
      continue;
    }

    // Explicit `t` before `ch` (e.g. `matcha` -> `まっちゃ`)
    if (ch === 't' && s.slice(i + 1, i + 3) === 'ch' && i + 3 < s.length) {
      moras.push({ romaji: 't', kana: 'っ' });
      i++;
      continue;
    }

    // Explicit `c` before `ch` (e.g. `maccha` -> `まっちゃ`)
    if (ch === 'c' && s.slice(i + 1, i + 3) === 'ch' && i + 3 < s.length) {
      moras.push({ romaji: 'c', kana: 'っ' });
      i++;
      continue;
    }

    // Doubled consonant gemination (kk, tt, ss, pp, etc., excluding nn/mm handled below)
    if (i + 1 < s.length && s[i + 1] === ch && GEMINATE_CONSONANTS.has(ch)) {
      // Ensure the following sequence can actually form a mora (don't allow trailing `kk`)
      if (i + 2 >= s.length) return null;
      moras.push({ romaji: ch, kana: 'っ' });
      i++;
      continue;
    }

    // Traditional Hepburn `m` before `b/p/m` (e.g. `shimbun`, `tempura`, `sempai`, `gumma`)
    if (ch === 'm' && i + 1 < s.length && LABIAL_CONSONANTS.has(s[i + 1])) {
      moras.push({ romaji: 'm', kana: 'ん' });
      i++;
      continue;
    }

    // Moraic nasal `n`:
    //  - `n'` or `n-` -> explicit moraic `ん`
    //  - `nn` at end or before consonant/apostrophe -> `ん` (if `nn` before vowel like `konnichiwa`,
    //    first `n` is `ん`, second `n` starts `ni`!)
    //  - `n` at end of word or before any consonant other than `y` -> `ん`
    if (ch === 'n') {
      const next = s[i + 1];
      if (next === undefined) {
        moras.push({ romaji: 'n', kana: 'ん' });
        i++;
        continue;
      }
      if (next === "'") {
        moras.push({ romaji: "n'", kana: 'ん' });
        i += 2;
        continue;
      }
      if (next === '-') {
        moras.push({ romaji: 'n', kana: 'ん' });
        i += 2;
        continue;
      }
      if (next === 'n') {
        const after = s[i + 2];
        if (after === undefined || (!VOWELS_OR_Y.has(after) && after !== 'n')) {
          // `nn` as a single explicit moraic nasal at word end or before consonant (`kann`, `nnda`)
          moras.push({ romaji: 'nn', kana: 'ん' });
          i += 2;
          continue;
        }
        // `konnichiwa`: first `n` is moraic `ん`, leave second `n` to start `ni`
        moras.push({ romaji: 'n', kana: 'ん' });
        i++;
        continue;
      }
      if (!VOWELS_OR_Y.has(next)) {
        moras.push({ romaji: 'n', kana: 'ん' });
        i++;
        continue;
      }
    }

    // Longest-match lookup (4 -> 3 -> 2 -> 1)
    let matched = false;
    for (let len = Math.min(4, s.length - i); len >= 1; len--) {
      const sub = s.slice(i, i + len);
      const kana = ROMAJI_MAP.get(sub);
      if (kana) {
        moras.push({ romaji: sub, kana });
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) return null;
  }

  return moras.length > 0 ? moras : null;
}

/** Convert a single romaji word to a Hiragana string, or `null` if invalid romaji. */
export function romajiToHiragana(rawWord: string): string | null {
  const moras = romajiToMoras(rawWord);
  return moras ? moras.map((m) => m.kana).join('') : null;
}

/** True if `rawWord` cleanly parses into valid Japanese romaji moras. */
export function isRomajiWord(rawWord: string): boolean {
  return romajiToMoras(rawWord) !== null;
}

/**
 * Convert a single romaji word into narrow Tokyo IPA `ReadingRow[]` (one row per mora),
 * delegating phonological rules & optional MFA dictionary lookup to `reviewKana`.
 */
export function reviewRomajiWord(
  rawWord: string,
  lexicon?: KanaLexicon,
  options?: ReviewKanaOptions,
): ReadingRow[] | null {
  const moras = romajiToMoras(rawWord);
  if (!moras) return null;
  const kanaText = moras.map((m) => m.kana).join('');
  let kanaRows: ReadingRow[];
  try {
    kanaRows = reviewKana(kanaText, lexicon, options);
  } catch {
    return null;
  }
  if (!kanaRows.length) return null;
  const multi = kanaRows.length > 1;
  return kanaRows.map((row, idx) => ({
    ...row,
    word: moras[idx]?.romaji ?? row.word,
    language: 'ja',
    ...(multi
      ? {
          sourceWord: rawWord,
          syllableIndex: idx,
          syllableCount: kanaRows.length,
        }
      : {
          sourceWord: rawWord,
          syllableIndex: 0,
          syllableCount: 1,
        }),
  }));
}

/**
 * Convert a space/punctuation-separated Japanese romaji phrase into narrow Tokyo IPA rows.
 */
export function reviewRomaji(
  text: string,
  lexicon?: KanaLexicon,
  options?: ReviewKanaOptions,
): ReadingRow[] {
  const parts = text.match(/[A-Za-zāīūēōâîûêô'ー-]+|[,，、：:;；.!?。！？…\r\n]+|\s+/gu) ?? [];
  const rows: ReadingRow[] = [];
  for (const part of parts) {
    if (/^\s+$/u.test(part)) continue;
    if (/^[,，、：:;；.!?。！？…\r\n]+$/u.test(part)) {
      const last = rows.at(-1);
      if (last) {
        const ms = /[.!?。！？…\n]/u.test(part) ? 350 : 180;
        last.pause = Math.max(last.pause, ms);
        last.phraseEnd = true;
      }
      continue;
    }
    const wordRows = reviewRomajiWord(part, lexicon, options);
    if (wordRows) rows.push(...wordRows);
  }
  return rows;
}
