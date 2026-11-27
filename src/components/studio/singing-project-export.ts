import { SAMPLE_RATE_HZ } from '@vocalcut/core';
import type { LyricsLanguage } from '@vocalcut/g2p';
import { gridBeat, type BeatChange, type MeterChange } from './midi-score';

export interface SingingExportNote {
  midi: number;
  startSmp: number;
  endSmp: number;
  velocity: number;
  lyric: string;
  ipa?: string;
  language?: string;
  sourcePhones?: string;
  sourceAlphabet?: string;
  continuation?: boolean;
  instrumental?: boolean;
  breath?: boolean;
  clClosure?: boolean;
}

export interface SingingExportTrack {
  name: string;
  muted?: boolean;
  solo?: boolean;
  gain?: number;
  primaryLang?: LyricsLanguage;
  notes: readonly SingingExportNote[];
}

type SingingLang = LyricsLanguage;

interface BarMeter {
  bar: number;
  beat: number;
  numerator: number;
  denominator: number;
}

interface ExportTempo {
  beat: number;
  bpm: number;
}

interface QuantizedNote {
  start: number;
  dur: number;
  midi: number;
  velocity: number;
  note: SingingExportNote;
}

const VSQX_PPQ = 480;
const VSQX_PRE_MEASURE = 1;
const SVP_BLICKS_PER_BEAT = 705_600_000;

const SVP_TRACK_COLORS = [
  'ff7db235',
  'ff3b82f6',
  'ffec4899',
  'fff59e0b',
  'ff8b5cf6',
  'ff14b8a6',
] as const;

/* -------------------------------------------------------------------------- */
/*  VOCALOID VSQX Tables (strictly VOCALOID 4 XML conventions)                */
/* -------------------------------------------------------------------------- */

const IPA_TO_VSQX_ZH_XSAMPA: ReadonlyArray<readonly [string, string]> = [
  ['tɕʰ', 'ts\\_h'],
  ['tʂʰ', 'ts`_h'],
  ['tsʰ', 'ts_h'],
  ['tɕ', 'ts\\'],
  ['tʂ', 'ts`'],
  ['ts', 'ts'],
  ['pʰ', 'p_h'],
  ['tʰ', 't_h'],
  ['kʰ', 'k_h'],
  ['ɻ̩', 'i`'],
  ['ɹ̩', 'i\\'],
  ['ɕ', 's\\'],
  ['ʂ', 's`'],
  ['ʐ', 'z`'],
  ['ɻ', 'r\\`'],
  ['ɹ', 'r\\'],
  ['ʋ', 'v\\'],
  ['ɨ', 'i\\'],
  ['ɚ', '@`'],
  ['ə', '@'],
  ['ɤ', '7'],
  ['œ', '9'],
  ['ɑ', 'A'],
  ['ɛ', 'E'],
  ['ɪ', 'I'],
  ['ɔ', 'O'],
  ['ʊ', 'U'],
  ['ŋ', 'N'],
  ['ɥ', 'H'],
  ['y', 'y'],
];

const IPA_TO_VSQX_EN_XSAMPA: ReadonlyArray<readonly [string, string]> = [
  ['tʃʰ', 'tS'],
  ['tʃ', 'tS'],
  ['dʒ', 'dZ'],
  ['pʰ', 'ph'],
  ['tʰ', 'th'],
  ['kʰ', 'kh'],
  ['ʊə', 'U@'],
  ['ɪə', 'I@'],
  ['eə', 'e@'],
  ['ɔə', 'O@'],
  ['ɑə', 'Q@'],
  ['ɜː', '3:'],
  ['ɔː', 'O:'],
  ['iː', 'i:'],
  ['uː', 'u:'],
  ['ɑː', 'A:'],
  ['aɪ', 'aI'],
  ['eɪ', 'eI'],
  ['ɔɪ', 'OI'],
  ['aʊ', 'aU'],
  ['əʊ', '@U'],
  ['oʊ', 'oU'],
  ['ɚ', '@r'],
  ['ɝ', '3:'],
  ['ɪ', 'I'],
  ['ʊ', 'U'],
  ['ʌ', 'V'],
  ['æ', '{'],
  ['ə', '@'],
  ['ɒ', 'Q'],
  ['ɑ', 'A:'],
  ['ɔ', 'O:'],
  ['ɛ', 'e'],
  ['ð', 'D'],
  ['θ', 'T'],
  ['ʃ', 'S'],
  ['ʒ', 'Z'],
  ['ŋ', 'N'],
  ['ɹ', 'r'],
  ['ɡ', 'g'],
];

const IPA_TO_VSQX_JA_XSAMPA: ReadonlyArray<readonly [string, string]> = [
  ['tɕ', 'tS'],
  ['dʑ', 'dZ'],
  ['ts', 'ts'],
  ['dz', 'dz'],
  ['ɯ̈ᵝ', 'M'],
  ['ɯᵝ', 'M'],
  ['ɯ', 'M'],
  ['ɰᵝ', 'w'],
  ['ɰ̩̃', 'N\\'],
  ['ɲ̩', 'J'],
  ['ŋ̩', 'N'],
  ['ɴ̩', 'N\\'],
  ['m̩', 'm'],
  ['n̩', 'n'],
  ['ɲ', 'J'],
  ['ŋ', 'N'],
  ['ɴ', 'N\\'],
  ['ɕ', 'S'],
  ['ʑ', 'Z'],
  ['ç', 'C'],
  ['ɸ', 'p\\'],
  ['ɾ', '4'],
  ['ɡ', 'g'],
  ['ä', 'a'],
  ['e̞', 'e'],
  ['o̞', 'o'],
];

const IPA_TO_VSQX_ES_XSAMPA: ReadonlyArray<readonly [string, string]> = [
  ['tʃ', 'tS'],
  ['β̞', 'B'],
  ['ð̞', 'D'],
  ['ɣ̞', 'G'],
  ['β', 'B'],
  ['ð', 'D'],
  ['ɣ', 'G'],
  ['ɲ', 'J'],
  ['ʎ', 'L'],
  ['θ', 'T'],
  ['ʝ', 'j'],
  ['ɾ', '4'],
  ['r', 'rr'],
  ['ɡ', 'g'],
];

/* -------------------------------------------------------------------------- */
/*  Synthesizer V SVP Tables (strictly SVP 5-language phoneset conventions)   */
/* -------------------------------------------------------------------------- */

/** SVP Mandarin X-SAMPA (`ph/th/kh/tsh/ts\h/ts\`h` without `_h`). */
const IPA_TO_SVP_ZH_XSAMPA: ReadonlyArray<readonly [string, string]> = [
  ['tɕʰ', 'ts\\h'],
  ['tʂʰ', 'ts`h'],
  ['tsʰ', 'tsh'],
  ['tɕ', 'ts\\'],
  ['tʂ', 'ts`'],
  ['ts', 'ts'],
  ['pʰ', 'ph'],
  ['tʰ', 'th'],
  ['kʰ', 'kh'],
  ['ɻ̩', 'i\\`'],
  ['ɹ̩', 'i\\'],
  ['ɕ', 's\\'],
  ['ʂ', 's`'],
  ['ʐ', 'z`'],
  ['ɻ', 'r\\`'],
  ['ɹ', 'r\\'],
  ['ʋ', 'w'],
  ['ɨ', 'i\\'],
  ['ɚ', 'r\\`'],
  ['ɑʊ', 'AU'],
  ['əʊ', '@U'],
  ['jɑʊ', 'iAU'],
  ['jəʊ', 'i@U'],
  ['joʊ', 'iU'],
  ['jɑ', 'iA'],
  ['jɛ', 'iE'],
  ['je', 'ie'],
  ['ja', 'ia'],
  ['ɥɛ', 'yE'],
  ['ɥæ', 'y{'],
  ['wɑ', 'uA'],
  ['wə', 'u@'],
  ['we', 'ue'],
  ['wo', 'uo'],
  ['wa', 'ua'],
  ['ə', '@'],
  ['ɤ', '7'],
  ['œ', 'e'],
  ['ɑ', 'A'],
  ['ɛ', 'e'],
  ['ɪ', ':\\i'],
  ['ɔ', 'o'],
  ['ʊ', 'U'],
  ['ŋ', 'N'],
  ['ɥ', 'y'],
  ['y', 'y'],
];

/** SVP Cantonese X-SAMPA (exact 46-phone inventory). */
const IPA_TO_SVP_YUE_XSAMPA: ReadonlyArray<readonly [string, string]> = [
  ['kʷʰ', 'kwh'],
  ['kʷ', 'kw'],
  ['tsʰ', 'tsh'],
  ['ts', 'ts'],
  ['pʰ', 'ph'],
  ['tʰ', 'th'],
  ['kʰ', 'kh'],
  ['p̚', ':p_}'],
  ['t̚', ':t_}'],
  ['k̚', ':k_}'],
  ['m̩', 'm='],
  ['ŋ̩', 'N='],
  ['aː', 'a'],
  ['ɛː', 'E'],
  ['iː', 'i'],
  ['ɔː', 'O'],
  ['uː', 'u'],
  ['œː', '9'],
  ['yː', 'y'],
  ['ɐ', '6'],
  ['ɪ', 'I'],
  ['ʊ', 'U'],
  ['ɵ', '8'],
  ['ŋ', 'N'],
  ['ɡ', 'k'],
];

/** SVP English ARPAbet (48-phone inventory). */
const IPA_TO_SVP_EN_ARPABET: ReadonlyArray<readonly [string, string]> = [
  ['tʃʰ', 'CH'],
  ['tʃ', 'CH'],
  ['dʒ', 'JH'],
  ['pʰ', 'P'],
  ['tʰ', 'T'],
  ['kʰ', 'K'],
  ['aɪ', 'AY'],
  ['aʊ', 'AW'],
  ['ɔɪ', 'OY'],
  ['eɪ', 'EY'],
  ['oʊ', 'OW'],
  ['əʊ', 'OW'],
  ['iː', 'IY'],
  ['uː', 'UW'],
  ['ɑː', 'AA'],
  ['ɔː', 'AO'],
  ['ɜː', 'ER'],
  ['ɚ', 'ER'],
  ['ɝ', 'ER'],
  ['ɪ', 'IH'],
  ['ʊ', 'UH'],
  ['ɛ', 'EH'],
  ['æ', 'AE'],
  ['ʌ', 'AH'],
  ['ə', 'AX'],
  ['ɑ', 'AA'],
  ['ɒ', 'AA'],
  ['ɔ', 'AO'],
  ['i', 'IY'],
  ['u', 'UW'],
  ['e', 'EH'],
  ['o', 'OW'],
  ['a', 'AA'],
  ['ʃ', 'SH'],
  ['ʒ', 'ZH'],
  ['θ', 'TH'],
  ['ð', 'DH'],
  ['ŋ', 'NG'],
  ['ɾ', 'DX'],
  ['ʔ', 'Q'],
  ['ɹ', 'R'],
  ['j', 'Y'],
  ['ɡ', 'G'],
  ['p', 'P'],
  ['b', 'B'],
  ['t', 'T'],
  ['d', 'D'],
  ['k', 'K'],
  ['g', 'G'],
  ['f', 'F'],
  ['v', 'V'],
  ['s', 'S'],
  ['z', 'Z'],
  ['h', 'HH'],
  ['m', 'M'],
  ['n', 'N'],
  ['l', 'L'],
  ['w', 'W'],
  ['r', 'R'],
];

/** SVP Japanese Romaji phonemes (exact 42-phone inventory). */
const IPA_TO_SVP_JA_ROMAJI: ReadonlyArray<readonly [string, string]> = [
  ['kʷɰᵝ', 'kw'],
  ['ɡʷɰᵝ', 'gw'],
  ['kʲj', 'ky'],
  ['ɡʲj', 'gy'],
  ['ɲj', 'ny'],
  ['çj', 'hy'],
  ['bʲj', 'by'],
  ['pʲj', 'py'],
  ['mʲj', 'my'],
  ['ɾʲj', 'ry'],
  ['tʲj', 'ty'],
  ['dʲj', 'dy'],
  ['tɕ', 'ch'],
  ['dʑ', 'j'],
  ['ts', 'ts'],
  ['dz', 'z'],
  ['kʲ', 'k'],
  ['ɡʲ', 'g'],
  ['bʲ', 'b'],
  ['pʲ', 'p'],
  ['mʲ', 'm'],
  ['ɾʲ', 'r'],
  ['tʲ', 't'],
  ['dʲ', 'd'],
  ['ɸʲ', 'f'],
  ['vʲ', 'v'],
  ['p̚', 'cl'],
  ['t̚', 'cl'],
  ['k̚', 'cl'],
  ['ʔ', 'cl'],
  ['ɯ̈ᵝ', 'u'],
  ['ɯᵝ', 'u'],
  ['ɯ', 'u'],
  ['ɰᵝ', 'w'],
  ['ɰ̩̃', 'N'],
  ['m̩', 'N'],
  ['n̩', 'N'],
  ['ɲ̩', 'N'],
  ['ŋ̩', 'N'],
  ['ɴ̩', 'N'],
  ['ɴ', 'N'],
  ['ŋ', 'N'],
  ['ɲ', 'n'],
  ['ɕ', 'sh'],
  ['ʑ', 'j'],
  ['ç', 'h'],
  ['ɸ', 'f'],
  ['ɾ', 'r'],
  ['ɡ', 'g'],
  ['j', 'y'],
  ['ä', 'a'],
  ['e̞', 'e'],
  ['o̞', 'o'],
];

/** SVP Spanish X-SAMPA (exact 30-phone inventory). */
const IPA_TO_SVP_ES_XSAMPA: ReadonlyArray<readonly [string, string]> = [
  ['tʃ', 'ch'],
  ['β̞', 'B'],
  ['ð̞', 'D'],
  ['ɣ̞', 'g'],
  ['β', 'B'],
  ['ð', 'D'],
  ['ɣ', 'g'],
  ['ɲ', 'J'],
  ['ŋ', 'N'],
  ['θ', 'C'],
  ['ʃ', 'sh'],
  ['ʝ', 'y'],
  ['ʎ', 'll'],
  ['ɾ', 'r'],
  ['r', 'rr'],
  ['ɡ', 'g'],
  ['j', 'I'],
  ['w', 'U'],
];

function cleanIpa(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .trim()
    .replace(/^\[|\]$/gu, '')
    .replace(/[˥˦˧˨˩¹²³⁴⁵ˈˌ.\s͜͡\u0325\u030a]+/gu, '');
}

function greedyMapIpa(
  ipa: string,
  table: ReadonlyArray<readonly [string, string]>,
  asciiPassRe?: RegExp,
  allowPalatalSuffix = false,
): string {
  const cleaned = cleanIpa(ipa);
  if (!cleaned) return '';
  const tokens: string[] = [];
  let idx = 0;
  while (idx < cleaned.length) {
    let matched = false;
    for (const [src, dst] of table) {
      if (cleaned.startsWith(src, idx)) {
        idx += src.length;
        if (allowPalatalSuffix && cleaned[idx] === 'ʲ') {
          tokens.push(dst + "'");
          idx += 1;
        } else {
          tokens.push(dst);
        }
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const ch = cleaned[idx];
    if (ch === 'ː') {
      idx += 1;
      continue;
    }
    if (asciiPassRe?.test(ch)) {
      idx += 1;
      if (allowPalatalSuffix && cleaned[idx] === 'ʲ') {
        tokens.push(ch + "'");
        idx += 1;
      } else {
        tokens.push(ch);
      }
      continue;
    }
    return '';
  }
  return tokens.join(' ');
}

function detectTrackLang(track: SingingExportTrack): SingingLang {
  if (track.primaryLang) return track.primaryLang;
  const counts: Record<SingingLang, number> = { zh: 0, en: 0, ja: 0, yue: 0, es: 0 };
  for (const n of track.notes) {
    if (n.instrumental || n.continuation || n.breath || n.clClosure) continue;
    const alpha = (n.sourceAlphabet ?? '').toLowerCase();
    if (alpha === 'vocaloid-0' || /japanese|romaji/.test(alpha)) counts.ja += 2;
    else if (alpha === 'vocaloid-1' || /english|arpabet/.test(alpha)) counts.en += 2;
    else if (alpha === 'vocaloid-3' || /spanish/.test(alpha)) counts.es += 2;
    else if (/cantonese|yue/.test(alpha)) counts.yue += 2;
    else if (alpha === 'vocaloid-4' || /mandarin|chinese|zh|cmn|xsampa/.test(alpha)) counts.zh += 2;

    const lang = (n.language ?? '').toLowerCase();
    if (lang === 'yue') counts.yue += 3;
    else if (lang === 'es') counts.es += 3;
    else if (lang.startsWith('ja')) counts.ja += 2;
    else if (lang.startsWith('en')) counts.en += 2;
    else if (lang.startsWith('zh') || lang.startsWith('cmn')) counts.zh += 2;

    const text = n.lyric.trim();
    if (/[\u3040-\u30ff]/u.test(text)) counts.ja += 3;
    else if (/[嘅咗喺唔佢啲咁冇嚟睇畀嘢仲㗎]/u.test(text)) counts.yue += 4;
    else if (/[\u4e00-\u9fff]/u.test(text)) counts.zh += 3;
    else if (/[ñáéíóúü]/iu.test(text)) counts.es += 3;
    else if (/[A-Za-z]/u.test(text)) counts.en += 2;
  }
  let best: SingingLang = 'zh';
  let bestScore = -1;
  for (const l of ['zh', 'ja', 'en', 'yue', 'es'] as const) {
    if (counts[l] > bestScore) {
      bestScore = counts[l];
      best = l;
    }
  }
  return bestScore > 0 ? best : 'zh';
}

function resolveVsqxPhones(note: SingingExportNote, lang: SingingLang): string {
  if (note.continuation) return '-';
  if (note.breath || /^br$/iu.test(note.lyric.trim())) return 'br';
  if (note.instrumental) return 'a';
  const bs = lang === 'ja' ? '0' : lang === 'en' ? '1' : lang === 'es' ? '3' : '4';
  const converted = lang === 'ja'
    ? greedyMapIpa(note.ipa ?? '', IPA_TO_VSQX_JA_XSAMPA, /^[abdehijkmnopstwz]$/u, true)
    : lang === 'en'
      ? greedyMapIpa(note.ipa ?? '', IPA_TO_VSQX_EN_XSAMPA, /^[abdefhijklmnopstuvwz]$/u)
      : lang === 'es'
        ? greedyMapIpa(note.ipa ?? '', IPA_TO_VSQX_ES_XSAMPA, /^[abdefhijklmnopstuvwxz]$/u)
        : greedyMapIpa(note.ipa ?? '', IPA_TO_VSQX_ZH_XSAMPA, /^[abdefhijklmnoprstuwxz]$/u);
  if (converted) return converted;
  if (note.sourcePhones?.trim() && note.sourceAlphabet === `vocaloid-${bs}`) {
    return note.sourcePhones.trim();
  }
  return '';
}

function resolveSvpPhones(note: SingingExportNote, lang: SingingLang): string {
  if (note.continuation || note.instrumental) return '';
  if (note.breath || /^br$/iu.test(note.lyric.trim())) return 'br';
  if (note.clClosure || /^cl$/iu.test(note.lyric.trim())) return 'cl';
  if (lang === 'zh') {
    const converted = greedyMapIpa(note.ipa ?? '', IPA_TO_SVP_ZH_XSAMPA, /^[abdefhijklmnoprstuwxz]$/u);
    if (converted) return converted;
    if (note.sourcePhones?.trim() && /svp-mandarin|xsampa|mandarin/i.test(note.sourceAlphabet ?? '')) {
      return note.sourcePhones.trim();
    }
    return '';
  }
  if (lang === 'yue') {
    const converted = greedyMapIpa(note.ipa ?? '', IPA_TO_SVP_YUE_XSAMPA, /^[abefhijklmnopstuwz]$/u);
    if (converted) return converted;
    if (note.sourcePhones?.trim() && /cantonese|yue/i.test(note.sourceAlphabet ?? '')) {
      return note.sourcePhones.trim();
    }
    return '';
  }
  if (lang === 'en') {
    const converted = greedyMapIpa(note.ipa ?? '', IPA_TO_SVP_EN_ARPABET);
    if (converted) return converted;
    if (note.sourcePhones?.trim() && /arpabet|english|synthv/i.test(note.sourceAlphabet ?? '')) {
      return note.sourcePhones.trim();
    }
    return '';
  }
  if (lang === 'ja') {
    const converted = greedyMapIpa(note.ipa ?? '', IPA_TO_SVP_JA_ROMAJI, /^[abdefghikmnoprstuvwyz]$/u);
    if (converted) return converted;
    if (note.sourcePhones?.trim() && /romaji|japanese/i.test(note.sourceAlphabet ?? '')) {
      return note.sourcePhones.trim();
    }
    return '';
  }
  if (lang === 'es') {
    const converted = greedyMapIpa(note.ipa ?? '', IPA_TO_SVP_ES_XSAMPA, /^[abdefghiklmnopstux]$/u);
    if (converted) return converted;
    if (note.sourcePhones?.trim() && /spanish/i.test(note.sourceAlphabet ?? '')) {
      return note.sourcePhones.trim();
    }
    return '';
  }
  return '';
}

function normalizeBarMeters(meters: readonly MeterChange[]): BarMeter[] {
  const sorted = [...meters]
    .filter((m) => Number.isFinite(m.beat) && Number.isInteger(m.numerator) && m.numerator >= 1 && Number.isInteger(m.denominator) && m.denominator >= 1)
    .sort((a, b) => a.beat - b.beat);
  if (!sorted.length || sorted[0].beat > 0) {
    sorted.unshift({ beat: 0, numerator: 4, denominator: 4 });
  }
  const result: BarMeter[] = [];
  let bar = 0;
  let curBeat = 0;
  let curWidth = (sorted[0].numerator * 4) / sorted[0].denominator;
  result.push({ bar: 0, beat: 0, numerator: sorted[0].numerator, denominator: sorted[0].denominator });
  for (let i = 1; i < sorted.length; i++) {
    const m = sorted[i];
    if (m.beat <= curBeat + 1e-6) {
      result[result.length - 1] = { bar, beat: curBeat, numerator: m.numerator, denominator: m.denominator };
      curWidth = (m.numerator * 4) / m.denominator;
      continue;
    }
    const deltaBars = Math.max(1, Math.round((m.beat - curBeat) / curWidth));
    bar += deltaBars;
    curBeat += deltaBars * curWidth;
    curWidth = (m.numerator * 4) / m.denominator;
    result.push({ bar, beat: curBeat, numerator: m.numerator, denominator: m.denominator });
  }
  return result;
}

function normalizeTempos(beatMap: readonly BeatChange[], shiftBeat: number): ExportTempo[] {
  const map = new Map<number, number>();
  for (const change of beatMap) {
    const bpm = (SAMPLE_RATE_HZ * 60) / change.samplesPerBeat;
    if (!Number.isFinite(bpm) || bpm <= 0) throw new Error('速度超出歌声工程支持范围');
    const beat = Math.max(0, change.beat + shiftBeat);
    map.set(beat, bpm);
  }
  if (!map.has(0)) {
    const first = [...map.entries()].sort((a, b) => a[0] - b[0])[0];
    map.set(0, first ? first[1] : 120);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([beat, bpm]) => ({ beat, bpm }));
}

function computeOriginShiftBeat(tracks: readonly SingingExportTrack[], beatMap: readonly BeatChange[]): number {
  let minBeat = 0;
  for (const track of tracks) {
    for (const note of track.notes) {
      const b = gridBeat(note.startSmp, beatMap);
      if (b < minBeat) minBeat = b;
    }
  }
  return minBeat < 0 ? -minBeat : 0;
}

function quantizeTrackNotes(
  notes: readonly SingingExportNote[],
  beatMap: readonly BeatChange[],
  unitsPerBeat: number,
  shiftBeat: number,
): QuantizedNote[] {
  const ordered = [...notes].sort((a, b) => a.startSmp - b.startSmp || a.midi - b.midi);
  const out: QuantizedNote[] = [];
  let prevEndSmp = -Infinity;
  for (const n of ordered) {
    const startBeat = Math.max(0, gridBeat(n.startSmp, beatMap) + shiftBeat);
    const endBeat = Math.max(startBeat, gridBeat(n.endSmp, beatMap) + shiftBeat);
    let start = Math.max(0, Math.round(startBeat * unitsPerBeat));
    const prev = out.at(-1);
    if (prev && prevEndSmp <= n.startSmp) {
      const prevEnd = prev.start + prev.dur;
      if (prevEnd > start) {
        if (start > prev.start) {
          prev.dur = start - prev.start;
        } else {
          start = prevEnd;
        }
      }
    }
    const end = Math.max(start + 1, Math.round(endBeat * unitsPerBeat));
    out.push({
      start,
      dur: end - start,
      midi: Math.max(0, Math.min(127, Math.round(n.midi))),
      velocity: Math.max(1, Math.min(127, Math.round(n.velocity || 86))),
      note: n,
    });
    prevEndSmp = Math.max(prevEndSmp, n.endSmp);
  }
  return out;
}

function cdata(text: string): string {
  return `<![CDATA[${text.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

function gainToDb(gain: number | undefined, minDb: number, maxDb: number): number {
  const g = gain ?? 1;
  if (!Number.isFinite(g) || g <= 0) return minDb;
  const db = 20 * Math.log10(g);
  return Math.max(minDb, Math.min(maxDb, db));
}

export function exportVsqxProject(
  parts: readonly SingingExportTrack[],
  beatMap: readonly BeatChange[],
  meters: readonly MeterChange[],
  projectName = 'VoxFigura',
): string {
  const activeTracks = parts.filter((p) => p.notes.length > 0);
  if (!activeTracks.length) throw new Error('没有可导出的音符');
  const map = beatMap.length ? beatMap : [{ beat: 0, sample: 0, samplesPerBeat: (60 * SAMPLE_RATE_HZ) / 120 }];
  const shiftBeat = computeOriginShiftBeat(activeTracks, map);
  const tempos = normalizeTempos(map, shiftBeat);
  const barMeters = normalizeBarMeters(meters);
  const firstBarBeats = (barMeters[0].numerator * 4) / barMeters[0].denominator;
  const originTicks = Math.round(VSQX_PRE_MEASURE * firstBarBeats * VSQX_PPQ);

  const trackLangs = activeTracks.map((t) => detectTrackLang(t));
  const bsForLang = (lang: SingingLang) => (lang === 'ja' ? 0 : lang === 'en' ? 1 : lang === 'es' ? 3 : 4);
  const usedBs = new Set(trackLangs.map(bsForLang));
  const voiceCatalog: Record<number, { compId: string; name: string }> = {
    0: { compId: 'BCX52J3728749X29', name: 'VoxFigura Japanese' },
    1: { compId: 'BCX52J3728749X30', name: 'VoxFigura English' },
    3: { compId: 'BCX52J3728749X32', name: 'VoxFigura Spanish' },
    4: { compId: 'BCX52J3728749X31', name: 'VoxFigura Mandarin' },
  };

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<vsq4 xmlns="http://www.yamaha.co.jp/vocaloid/schema/vsq4/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.yamaha.co.jp/vocaloid/schema/vsq4/ vsq4.xsd">',
    `  <vender>${cdata('VoxFigura')}</vender>`,
    `  <version>${cdata('4.0.0.3')}</version>`,
    '  <vVoiceTable>',
  ];

  for (const bs of [...usedBs].sort((a, b) => a - b)) {
    const entry = voiceCatalog[bs];
    lines.push(
      '    <vVoice>',
      `      <bs>${bs}</bs>`,
      '      <pc>0</pc>',
      `      <id>${cdata(entry.compId)}</id>`,
      `      <name>${cdata(entry.name)}</name>`,
      '      <vPrm><bre>0</bre><bri>0</bri><cle>0</cle><gen>0</gen><ope>0</ope></vPrm>',
      '    </vVoice>',
    );
  }
  lines.push('  </vVoiceTable>', '  <mixer>', '    <masterUnit><oDev>0</oDev><rLvl>0</rLvl><vol>0</vol></masterUnit>');

  for (const [idx, track] of activeTracks.entries()) {
    const vol = Math.round(gainToDb(track.gain, -89.8, 6) * 10);
    lines.push(
      '    <vsUnit>',
      `      <tNo>${idx}</tNo>`,
      '      <iGin>0</iGin><sLvl>-898</sLvl><sEnable>0</sEnable>',
      `      <m>${track.muted ? 1 : 0}</m><s>${track.solo ? 1 : 0}</s><pan>64</pan><vol>${vol}</vol>`,
      '    </vsUnit>',
    );
  }
  lines.push(
    '    <monoUnit><iGin>0</iGin><sLvl>-898</sLvl><sEnable>0</sEnable><m>0</m><s>0</s><pan>64</pan><vol>0</vol></monoUnit>',
    '    <stUnit><iGin>0</iGin><m>0</m><s>0</s><vol>-129</vol></stUnit>',
    '  </mixer>',
    '  <masterTrack>',
    `    <seqName>${cdata(projectName || 'VoxFigura')}</seqName>`,
    `    <seqComment>${cdata('Exported by VoxFigura')}</seqComment>`,
    `    <resolution>${VSQX_PPQ}</resolution>`,
    `    <preMeasure>${VSQX_PRE_MEASURE}</preMeasure>`,
  );

  for (const m of barMeters) {
    const barNum = m.bar === 0 ? 0 : m.bar + VSQX_PRE_MEASURE;
    lines.push(`    <timeSig><m>${barNum}</m><nu>${m.numerator}</nu><de>${m.denominator}</de></timeSig>`);
  }
  for (const t of tempos) {
    const tick = t.beat <= 0 ? 0 : originTicks + Math.round(t.beat * VSQX_PPQ);
    const val = Math.max(2000, Math.min(30000, Math.round(t.bpm * 100)));
    lines.push(`    <tempo><t>${tick}</t><v>${val}</v></tempo>`);
  }
  lines.push('  </masterTrack>');

  for (const [idx, track] of activeTracks.entries()) {
    const lang = trackLangs[idx];
    const bs = bsForLang(lang);
    const quantized = quantizeTrackNotes(track.notes, map, VSQX_PPQ, shiftBeat);
    const lastEnd = quantized.reduce((max, q) => Math.max(max, q.start + q.dur), 0);
    const playTime = Math.max(VSQX_PPQ * 4, lastEnd + VSQX_PPQ);
    lines.push(
      '  <vsTrack>',
      `    <tNo>${idx}</tNo>`,
      `    <name>${cdata(track.name || `Track ${idx + 1}`)}</name>`,
      `    <comment>${cdata('')}</comment>`,
      '    <vsPart>',
      `      <t>${originTicks}</t>`,
      `      <playTime>${playTime}</playTime>`,
      `      <name>${cdata(track.name || `Part ${idx + 1}`)}</name>`,
      `      <comment>${cdata('')}</comment>`,
      `      <sPlug><id>${cdata('ACA9C502-A04B-42b5-B2EB-5CEA36D16FCE')}</id><name>${cdata('VOCALOID2 Compatible Style')}</name><version>${cdata('3.0.0.1')}</version></sPlug>`,
      '      <pStyle><v id="accent">50</v><v id="bendDep">8</v><v id="bendLen">0</v><v id="decay">50</v><v id="fallPort">0</v><v id="opening">127</v><v id="risePort">0</v></pStyle>',
      `      <singer><t>0</t><bs>${bs}</bs><pc>0</pc></singer>`,
    );
    for (const q of quantized) {
      const lyricText = q.note.continuation
        ? '-'
        : q.note.breath
          ? 'br'
          : (q.note.lyric.trim() || 'a');
      const phones = resolveVsqxPhones(q.note, lang);
      lines.push(
        '      <note>',
        `        <t>${q.start}</t><dur>${q.dur}</dur><n>${q.midi}</n><v>${q.velocity}</v>`,
        `        <y>${cdata(lyricText)}</y><p>${cdata(phones)}</p>`,
        '        <nStyle><v id="accent">50</v><v id="bendDep">0</v><v id="bendLen">0</v><v id="decay">50</v><v id="fallPort">0</v><v id="opening">127</v><v id="risePort">0</v><v id="vibLen">0</v><v id="vibType">0</v></nStyle>',
        '      </note>',
      );
    }
    lines.push('    </vsPart>', '  </vsTrack>');
  }

  lines.push('  <monoTrack />', '  <stTrack />', '  <aux><id><![CDATA[AUX_VST_HOST_CHUNK_INFO]]></id><content><![CDATA[VlNDSwAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=]]></content></aux>', '</vsq4>');
  return lines.join('\n');
}

export function exportSvpProject(
  parts: readonly SingingExportTrack[],
  beatMap: readonly BeatChange[],
  meters: readonly MeterChange[],
  projectName = 'VoxFigura',
): string {
  const activeTracks = parts.filter((p) => p.notes.length > 0);
  if (!activeTracks.length) throw new Error('没有可导出的音符');
  const map = beatMap.length ? beatMap : [{ beat: 0, sample: 0, samplesPerBeat: (60 * SAMPLE_RATE_HZ) / 120 }];
  const shiftBeat = computeOriginShiftBeat(activeTracks, map);
  const tempos = normalizeTempos(map, shiftBeat);
  const barMeters = normalizeBarMeters(meters);

  const emptyParameters = () => ({
    pitchDelta: { mode: 'cubic', points: [] as number[] },
    vibratoEnv: { mode: 'cubic', points: [] as number[] },
    loudness: { mode: 'cubic', points: [] as number[] },
    tension: { mode: 'cubic', points: [] as number[] },
    breathiness: { mode: 'cubic', points: [] as number[] },
    voicing: { mode: 'cubic', points: [] as number[] },
    gender: { mode: 'cubic', points: [] as number[] },
  });

  const svpDbMeta = (lang: SingingLang): { language: string; phoneset: string } => {
    switch (lang) {
      case 'ja': return { language: 'japanese', phoneset: 'romaji' };
      case 'en': return { language: 'english', phoneset: 'arpabet' };
      case 'yue': return { language: 'cantonese', phoneset: 'xsampa' };
      case 'es': return { language: 'spanish', phoneset: 'xsampa' };
      default: return { language: 'mandarin', phoneset: 'xsampa' };
    }
  };

  const tracks = activeTracks.map((track, idx) => {
    const lang = detectTrackLang(track);
    const dbMeta = svpDbMeta(lang);
    const uuid = crypto.randomUUID();
    const quantized = quantizeTrackNotes(track.notes, map, SVP_BLICKS_PER_BEAT, shiftBeat);
    const notes = quantized.map((q) => ({
      onset: q.start,
      duration: q.dur,
      lyrics: q.note.continuation
        ? '-'
        : q.note.breath
          ? 'br'
          : q.note.clClosure
            ? 'cl'
            : (q.note.instrumental ? '' : q.note.lyric.trim()),
      phonemes: resolveSvpPhones(q.note, lang),
      pitch: q.midi,
      attributes: {},
    }));

    return {
      name: track.name || `Track ${idx + 1}`,
      dispColor: SVP_TRACK_COLORS[idx % SVP_TRACK_COLORS.length],
      dispOrder: idx,
      renderEnabled: false,
      mixer: {
        gainDecibel: Number(gainToDb(track.gain, -48, 12).toFixed(2)),
        pan: 0,
        mute: Boolean(track.muted),
        solo: Boolean(track.solo),
        display: true,
      },
      mainGroup: {
        name: 'main',
        uuid,
        parameters: emptyParameters(),
        vocalModes: {},
        notes,
      },
      mainRef: {
        groupID: uuid,
        blickAbsolute: 0,
        blickOffset: 0,
        pitchOffset: 0,
        isInstrumental: false,
        database: {
          name: '',
          language: dbMeta.language,
          phoneset: dbMeta.phoneset,
          languageOverride: '',
          phonesetOverride: '',
          backendType: '',
          version: '',
        },
        dictionary: '',
        voice: {},
      },
      groups: [],
    };
  });

  const svp = {
    version: 119,
    time: {
      meter: barMeters.map((m) => ({
        index: m.bar,
        numerator: m.numerator,
        denominator: m.denominator,
      })),
      tempo: tempos.map((t) => ({
        position: Math.max(0, Math.round(t.beat * SVP_BLICKS_PER_BEAT)),
        bpm: Number(t.bpm.toFixed(4)),
      })),
    },
    library: [],
    tracks,
    renderConfig: {
      destination: './',
      filename: projectName || 'untitled',
      numChannels: 1,
      aspirationFormat: 'noAspiration',
      bitDepth: 16,
      sampleRate: SAMPLE_RATE_HZ,
      exportMixDown: true,
    },
  };

  return JSON.stringify(svp, null, 2);
}
