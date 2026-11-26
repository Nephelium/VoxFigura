import { normalizedPhone, phoneTraits } from './ipa-segments';
import modifierData from './jd2-ipa-modifiers.json';
import { ref } from 'vue';
import type { TractParamName } from '../../packages/core-ts/src/types';

export interface TractPoseExtras {
  lip_width: number;
  larynx_height: number;
  manual_root: boolean;
  tongue_shape: [number, number, number, number];
  lip_shape: [number, number, number, number];
}

export const DEFAULT_TRACT_EXTRAS: TractPoseExtras = {
  lip_width: 1.0,
  larynx_height: 0.0,
  manual_root: false,
  tongue_shape: [0, 0, 0, 0],
  lip_shape: [0, 0, 0, 0],
};

export interface PtbSourceHints {
  mode?: string;
  pressure_pa?: number;
  opening_mm?: number;
  posterior_gap_mm2?: number;
  vibration?: number;
}

export interface ResolvedPtbIpaPose {
  symbol: string;
  matchedName: string;
  speaker: string;
  params: Record<TractParamName, number>;
  params19: number[];
  extras: TractPoseExtras;
  source?: PtbSourceHints;
  f0_hz?: number;
  isFallback: boolean;
}

export interface PtbReferenceVowel {
  symbol: string;
  name: string;
  params19: number[];
  params: Record<TractParamName, number>;
  extras: TractPoseExtras;
}

interface RawPtbEntry {
  name?: string;
  preset?: string;
  params: number[];
  lip_width?: number;
  larynx_height?: number;
  manual_root?: boolean;
  tongue_shape?: number[];
  lip_shape?: number[];
  f0?: number;
  duration?: number;
  source?: PtbSourceHints;
}

interface RawPtbFactoryFile {
  speaker?: string;
  parameters?: string[];
  presets?: RawPtbEntry[] | Record<string, RawPtbEntry>;
}

const PARAM_ORDER: readonly TractParamName[] = [
  'HX', 'HY', 'JX', 'JA', 'LP', 'LD', 'VS', 'VO',
  'TCX', 'TCY', 'TTX', 'TTY', 'TBX', 'TBY', 'TRX', 'TRY',
  'TS1', 'TS2', 'TS3',
] as const;

/** Exact calibrated JD2 schwa [ə] from public/vocal-tract/factory/JD2/ipa.json (pre-load fallback only). */
const PRELOAD_JD2_SCHWA_19: readonly number[] = [
  0.526, -5.179, -0.09, -4.344, 0.027, 0.952, 0.461, -0.1,
  0.7, -1.913, 4.587, -1.305, 3.06, -0.386, -1.781, -2.448,
  0.234, 0.212, 0.235,
];

export const PTB_REFERENCE_VOWEL_SYMBOLS: readonly string[] = [
  'i', 'y', 'e', 'ø', 'ɛ', 'œ', 'a', 'ɑ', 'ɒ', 'ɔ',
  'ɤ', 'o', 'u', 'ɯ', 'ə', 'ɨ', 'ʉ', 'æ', 'ɐ',
] as const;

export const PRIMARY_VOWELS = new Set([
  'a', 'ɑ', 'ɒ', 'æ', 'ɐ', 'ᴀ', 'e', 'ɛ', 'ə', 'ɜ', 'ɤ',
  'i', 'ɪ', 'ɨ', 'o', 'ɔ', 'ø', 'œ', 'u', 'ʊ', 'ʉ', 'ɯ', 'y', 'ʏ', 'ʌ',
]);

const MODIFIER_BASE_ALIASES: Record<string, string> = {
  g: 'ɡ',
  tʂ: 'ʈʂ',
  ʈʂ: 'tʂ',
  dʐ: 'ɖʐ',
  ɖʐ: 'dʐ',
  tɕ: 'ȶɕ',
  ȶɕ: 'tɕ',
  dʑ: 'ȡʑ',
  ȡʑ: 'dʑ',
};

const ROUNDED_VOWELS = new Set(Array.from('yʏʉuʊøɵoœɞɔɶɒʮʯ'));

type FallbackPlace =
  | 'vowel'
  | 'bilabial'
  | 'labiodental'
  | 'coronal'
  | 'retroflex'
  | 'alveolopalatal'
  | 'palatal'
  | 'velar'
  | 'uvular'
  | 'pharyngeal'
  | 'glottal'
  | 'other';

function classifyFallbackPlace(base: string, isVowel: boolean): FallbackPlace {
  if (isVowel) return 'vowel';
  if (/^[hɦʔ]$/u.test(base)) return 'glottal';
  if (/^(?:[ħʕʜʢʡ]|ʡħ|ʡʕ)$/u.test(base)) return 'pharyngeal';
  if (/^(?:[qɢɴχʁʀʛ]|qχ|ɢʁ)$/u.test(base)) return 'uvular';
  if (/^(?:[pbmʙɸβɓʘ]|pɸ|bβ)$/u.test(base)) return 'bilabial';
  if (/^(?:[fvɱⱱʋ]|pf|bv|p̪f|b̪v)$/u.test(base)) return 'labiodental';
  if (/^(?:[ɕʑȶȡ]|tɕ|dʑ|ȶɕ|ȡʑ)$/u.test(base)) return 'alveolopalatal';
  if (/^(?:[cɟɲçʝjʎʄǂɥ]|cç|ɟʝ)$/u.test(base)) return 'palatal';
  if (/^(?:[ʈɖɳʂʐɻɭɽᶑ]|tʂ|dʐ|ʈʂ|ɖʐ)$/u.test(base)) return 'retroflex';
  if (/^(?:[kɡŋxɣɰʟɠwʍɧ]|kx|ɡɣ)$/u.test(base)) return 'velar';
  if (/^(?:[tdnszθðɬɮlɫɾrɹɺʃʒɗǀǃǁ]|ts|dz|tʃ|dʒ|tθ|dð|tɬ|dɮ)$/u.test(base)) return 'coronal';
  return 'other';
}

/**
 * Apply JD2 experimentally calibrated diacritic deltas (`src/data/jd2-ipa-modifiers.json` +
 * Place x Manner DAC rules) onto any base 19-D VTL pose.
 */
export function applyJd2DiacriticModifiers(symbol: string, baseVec19: readonly number[]): number[] {
  const vec = baseVec19.slice(0, 19);
  const stripped = stripSuprasegmentals(symbol);
  const canonical = normalizedPhone(stripped);
  const traits = phoneTraits(canonical);
  const base = traits.base.replace(/[͜͡]/gu, '').replaceAll('g', 'ɡ');
  if (!base || canonical === base) return vec;

  const rules = jd2Deltas[base] ?? (MODIFIER_BASE_ALIASES[base] ? jd2Deltas[MODIFIER_BASE_ALIASES[base]] : undefined);
  const signs = new Set(Array.from(canonical));
  for (const pair of ['̟̠', '̝̞', '̹̜', '̘̙', '̺̻']) {
    if (Array.from(pair).every((mark) => signs.has(mark))) {
      for (const mark of pair) signs.delete(mark);
    }
  }

  const place = classifyFallbackPlace(base, traits.vowel);
  const isVowel = place === 'vowel';
  const isRoundedVowel = isVowel && ROUNDED_VOWELS.has(base);
  const isBilabial = place === 'bilabial';
  const isLabial = isBilabial || place === 'labiodental';
  const isStopOrAffric = traits.stop || traits.affricate;
  const isObstruent = isStopOrAffric || traits.fricative;
  const isBilabialStopOrNasal = isBilabial && (isStopOrAffric || traits.nasal);
  const isGlottalStop = base === 'ʔ';

  const touched = new Set<number>();
  const touch = (...cols: number[]) => {
    for (const c of cols) touched.add(c);
  };

  for (const mark of signs) {
    const ruleDeltas = rules?.[mark];
    if (ruleDeltas?.length) {
      for (const [column, delta] of ruleDeltas) {
        vec[column] += delta;
        touched.add(column);
      }
      continue;
    }

    // Place x Manner conditioned fallback covering all 21 articulatory IPA diacritics
    if (mark === '\u0339') {
      // More rounded (̹)
      if (isVowel && !isRoundedVowel) {
        vec[4] = Math.max(vec[4] + 0.58, 0.52);
        vec[5] = Math.max(0.28, Math.min(vec[5] - 0.55, 0.55));
        touch(4, 5);
      } else if (isRoundedVowel) {
        vec[4] += 0.32;
        vec[5] = Math.max(0.24, vec[5] - 0.25);
        touch(4, 5);
      } else if (isBilabialStopOrNasal) {
        vec[4] = Math.max(vec[4] + 0.45, 0.45);
        touch(4);
      } else {
        vec[4] = Math.max(vec[4] + 0.48, 0.45);
        vec[5] = Math.max(0.24, Math.min(vec[5] - 0.35, 0.48));
        touch(4, 5);
      }
    } else if (mark === '\u031c') {
      // Less rounded (̜) — never break bilabial stop/nasal seal
      if (isBilabialStopOrNasal) {
        vec[4] -= 0.38;
        touch(4);
      } else if (isLabial) {
        vec[4] -= 0.38;
        vec[5] += 0.08;
        touch(4, 5);
      } else if (isRoundedVowel) {
        vec[4] = Math.min(vec[4] - 0.50, -0.15);
        vec[5] += 0.42;
        touch(4, 5);
      } else {
        vec[4] -= 0.38;
        vec[5] += 0.25;
        touch(4, 5);
      }
    } else if (mark === 'ʷ') {
      // Labialized (ʷ) — Place x Manner DAC-conditioned
      if (isLabial) {
        vec[4] = Math.max(vec[4] + 0.60, 0.65);
        if (vec[5] > -0.15) {
          vec[5] = Math.max(0.18, Math.min(vec[5] - 0.20, 0.35));
          touch(5);
        }
        vec[8] -= 0.22;
        vec[9] += 0.14;
        touch(4, 8, 9);
      } else if (isVowel && !isRoundedVowel) {
        vec[4] = Math.max(vec[4] + 0.65, 0.60);
        vec[5] = Math.max(0.28, Math.min(vec[5] - 0.58, 0.50));
        touch(4, 5);
      } else if (isRoundedVowel) {
        vec[4] = Math.max(vec[4] + 0.38, 0.65);
        vec[5] = Math.max(0.24, vec[5] - 0.25);
        touch(4, 5);
      } else if (place === 'alveolopalatal' || place === 'palatal') {
        vec[4] = Math.max(vec[4] + 0.56, 0.58);
        vec[5] = Math.max(0.24, Math.min(vec[5] - 0.34, 0.42));
        touch(4, 5);
      } else if (place === 'velar' || place === 'uvular') {
        vec[4] = Math.max(vec[4] + 0.65, 0.68);
        vec[5] = Math.max(0.24, Math.min(vec[5] - 0.36, 0.36));
        vec[8] -= 0.20;
        touch(4, 5, 8);
      } else {
        vec[4] = Math.max(vec[4] + 0.58, 0.60);
        vec[5] = Math.max(0.24, Math.min(vec[5] - 0.34, 0.42));
        vec[8] -= 0.18;
        touch(4, 5, 8);
      }
    } else if (mark === 'ʲ') {
      // Palatalized (ʲ)
      if (isVowel) {
        vec[8] += 0.45; vec[9] += 0.35; vec[12] += 0.35; vec[13] += 0.30;
        touch(8, 9, 12, 13);
      } else if (isLabial) {
        vec[8] = Math.max(vec[8] + 0.85, 2.10);
        vec[9] = Math.max(vec[9] + 1.20, -0.80);
        vec[12] = Math.max(vec[12] + 0.90, 3.60);
        vec[13] = Math.max(vec[13] + 1.00, 0.92);
        vec[11] = Math.min(vec[11], -0.45);
        touch(8, 9, 11, 12, 13);
      } else if (place === 'coronal' || place === 'retroflex') {
        vec[8] = Math.max(vec[8] + 0.48, 1.62);
        vec[9] = Math.max(vec[9] + 0.72, -1.18);
        vec[12] = Math.max(vec[12] + 0.38, 2.95);
        vec[13] = Math.max(vec[13] + 0.48, 0.55);
        vec[16] = Math.max(vec[16], 0.22);
        touch(8, 9, 12, 13, 16);
      } else if (place === 'velar' || place === 'uvular') {
        vec[8] = Math.max(vec[8] + 0.85, 1.48);
        vec[9] = Math.max(vec[9] + 0.22, isStopOrAffric ? -0.35 : -0.85);
        vec[12] = Math.max(vec[12] + 0.55, 3.05);
        vec[13] = Math.max(vec[13] + 0.62, 0.85);
        touch(8, 9, 12, 13);
      } else if (place === 'alveolopalatal' || place === 'palatal') {
        vec[8] += 0.22; vec[9] += 0.15; vec[13] += 0.18;
        touch(8, 9, 13);
      } else {
        vec[8] = Math.max(vec[8] + 0.70, 1.85);
        vec[9] = Math.max(vec[9] + 0.95, -0.95);
        vec[12] = Math.max(vec[12] + 0.70, 3.35);
        vec[13] = Math.max(vec[13] + 0.80, 0.80);
        touch(8, 9, 12, 13);
      }
    } else if (mark === 'ˠ' || mark === '\u0334') {
      // Velarized (ˠ) or velarized/pharyngealized (̴)
      if (isLabial) {
        vec[8] = Math.min(vec[8] - 0.85, 0.15);
        vec[9] = Math.max(vec[9] + 0.75, -0.88);
        touch(8, 9);
      } else if (place === 'coronal' || place === 'retroflex') {
        vec[8] = Math.min(vec[8] - 0.65, 0.28);
        vec[9] = Math.max(vec[9] + 0.52, -1.05);
        vec[13] -= 0.24;
        touch(8, 9, 13);
      } else if (place === 'alveolopalatal' || place === 'palatal') {
        vec[8] -= 0.35; vec[9] += 0.20;
        touch(8, 9);
      } else {
        vec[8] = Math.min(vec[8] - 0.60, 0.25);
        vec[9] = Math.max(vec[9] + 0.45, -1.05);
        touch(8, 9);
      }
      if (mark === '\u0334') {
        vec[0] -= 0.16;
        touch(0);
      }
    } else if (mark === 'ˤ') {
      // Pharyngealized (ˤ)
      if (isLabial) {
        vec[0] = Math.min(vec[0] - 0.42, 0.05);
        vec[1] += 0.18;
        vec[8] = Math.min(vec[8] - 0.85, -0.45);
        vec[9] = Math.min(vec[9] - 0.30, -1.55);
        touch(0, 1, 8, 9);
      } else if (place === 'coronal' || place === 'retroflex') {
        vec[0] = Math.min(vec[0] - 0.38, 0.08);
        vec[8] = Math.min(vec[8] - 0.72, -0.32);
        vec[9] = Math.min(vec[9] - 0.22, -1.45);
        vec[13] -= 0.28;
        touch(0, 8, 9, 13);
      } else if (place === 'velar' || place === 'uvular') {
        vec[0] = Math.min(vec[0] - 0.32, 0.10);
        vec[8] -= 0.48;
        touch(0, 8);
      } else {
        vec[0] = Math.min(vec[0] - 0.35, 0.08);
        vec[8] = Math.min(vec[8] - 0.70, -0.35);
        vec[9] = Math.min(vec[9] - 0.25, -1.45);
        touch(0, 8, 9);
      }
    } else if (mark === '˞') {
      // Rhotacized (˞)
      if (place === 'coronal' || place === 'retroflex' || place === 'alveolopalatal') {
        vec[10] -= 0.40;
        vec[11] += 0.35;
        touch(10, 11);
      } else {
        vec[10] = Math.min(vec[10] - 0.90, 3.35);
        vec[11] = Math.max(vec[11] + 0.85, 0.55);
        vec[12] -= 0.30;
        vec[13] -= 0.25;
        vec[4] += 0.18;
        touch(4, 10, 11, 12, 13);
      }
    } else if (mark === '\u0303') {
      // Nasalized (̃) — skip plosives/affricates/glottal stop
      if (!isStopOrAffric && !isGlottalStop) {
        if (isObstruent) {
          vec[7] = Math.max(vec[7], 0.28);
          vec[6] = Math.min(vec[6], 0.82);
        } else {
          vec[7] = Math.max(vec[7], 0.62);
          vec[6] = Math.min(vec[6], 0.72);
        }
        touch(6, 7);
      }
    } else if (mark === '\u031f') {
      // Advanced (̟)
      if (place !== 'glottal') {
        if (isVowel) {
          vec[8] += 0.55; vec[12] += 0.35; touch(8, 12);
        } else if (isLabial) {
          vec[4] += 0.30; touch(4);
        } else if (place === 'coronal' || place === 'retroflex') {
          vec[10] += 0.45; vec[11] -= 0.25; vec[12] += 0.25; touch(10, 11, 12);
        } else if (place === 'alveolopalatal' || place === 'palatal') {
          vec[12] += 0.45; vec[8] += 0.35; touch(8, 12);
        } else if (place === 'velar' || place === 'uvular') {
          vec[8] += 0.65; vec[12] += 0.30; touch(8, 12);
        } else if (place === 'pharyngeal') {
          vec[0] += 0.22; vec[8] += 0.35; touch(0, 8);
        }
      }
    } else if (mark === '\u0320') {
      // Retracted (̠)
      if (place !== 'glottal') {
        if (isVowel) {
          vec[8] -= 0.55; vec[12] -= 0.35; touch(8, 12);
        } else if (isLabial) {
          vec[4] -= 0.30; vec[2] -= 0.15; touch(2, 4);
        } else if (place === 'coronal' || place === 'retroflex') {
          vec[10] -= 0.48; vec[11] += 0.38; vec[12] -= 0.20; touch(10, 11, 12);
        } else if (place === 'alveolopalatal' || place === 'palatal') {
          vec[12] -= 0.45; vec[8] -= 0.40; touch(8, 12);
        } else if (place === 'velar' || place === 'uvular') {
          vec[8] -= 0.60; vec[9] += 0.20; vec[6] += 0.10; touch(6, 8, 9);
        } else if (place === 'pharyngeal') {
          vec[0] -= 0.20; vec[8] -= 0.35; touch(0, 8);
        }
      }
    } else if (mark === '\u031d') {
      // Raised / tighter stricture (̝) — never alters larynx height (HY)
      if (!isStopOrAffric && place !== 'glottal') {
        if (isVowel) {
          vec[9] += 0.38; vec[13] += 0.25; vec[3] += 0.55; touch(3, 9, 13);
        } else if (isLabial) {
          vec[5] -= 0.28; vec[3] += 0.35; touch(3, 5);
        } else if (place === 'coronal' || place === 'retroflex') {
          vec[11] += 0.32; vec[13] += 0.18; vec[3] += 0.30; touch(3, 11, 13);
        } else if (place === 'alveolopalatal' || place === 'palatal') {
          vec[13] += 0.38; vec[9] += 0.28; vec[3] += 0.30; touch(3, 9, 13);
        } else if (place === 'velar' || place === 'uvular') {
          vec[9] += 0.38; vec[3] += 0.25; touch(3, 9);
        } else if (place === 'pharyngeal') {
          vec[0] -= 0.18; vec[8] -= 0.28; touch(0, 8);
        }
      }
    } else if (mark === '\u031e') {
      // Lowered / wider stricture (̞) — never alters larynx height (HY)
      if (!isStopOrAffric && place !== 'glottal') {
        if (isVowel) {
          vec[9] -= 0.38; vec[13] -= 0.25; vec[3] -= 0.60; touch(3, 9, 13);
        } else if (isLabial) {
          vec[5] += 0.28; vec[3] -= 0.35; touch(3, 5);
        } else if (place === 'coronal' || place === 'retroflex') {
          vec[11] -= 0.34; vec[13] -= 0.20; vec[3] -= 0.30; touch(3, 11, 13);
        } else if (place === 'alveolopalatal' || place === 'palatal') {
          vec[13] -= 0.38; vec[9] -= 0.28; vec[3] -= 0.30; touch(3, 9, 13);
        } else if (place === 'velar' || place === 'uvular') {
          vec[9] -= 0.40; vec[3] -= 0.25; touch(3, 9);
        } else if (place === 'pharyngeal') {
          vec[0] += 0.18; vec[8] += 0.28; touch(0, 8);
        }
      }
    } else if (mark === '\u0308') {
      // Centralized (̈) — vowels only
      if (isVowel) {
        vec[8] += 0.40 * (0.95 - vec[8]);
        vec[12] += 0.30 * (3.00 - vec[12]);
        touch(8, 12);
      }
    } else if (mark === '\u033d') {
      // Mid-centralized (̽) — vowels only
      if (isVowel) {
        vec[8] += 0.40 * (0.95 - vec[8]);
        vec[9] += 0.40 * (-1.70 - vec[9]);
        vec[3] += 0.35 * (-4.20 - vec[3]);
        touch(3, 8, 9);
      }
    } else if (mark === '\u0318') {
      // ATR (̘)
      if (!isGlottalStop) {
        vec[0] += 0.28; vec[1] -= 0.20; vec[8] += 0.25; vec[9] += 0.18;
        touch(0, 1, 8, 9);
      }
    } else if (mark === '\u0319') {
      // RTR (̙)
      if (!isGlottalStop) {
        vec[0] -= 0.28; vec[1] += 0.20; vec[8] -= 0.25; vec[9] -= 0.18;
        touch(0, 1, 8, 9);
      }
    } else if (mark === '\u032a') {
      // Dental (̪)
      if (isBilabial) {
        vec[2] = Math.min(vec[2], -0.35);
        vec[4] = Math.min(vec[4], -0.25);
        vec[3] = Math.max(vec[3], -2.50);
        touch(2, 3, 4);
      } else if (place === 'coronal' || place === 'retroflex') {
        vec[10] = Math.max(vec[10] + 0.35, 4.92);
        vec[11] -= 0.32;
        touch(10, 11);
      }
    } else if (mark === '\u033a') {
      // Apical (̺)
      if (place === 'coronal' || place === 'retroflex' || place === 'alveolopalatal') {
        vec[11] += 0.30; vec[13] -= 0.35;
        touch(11, 13);
      }
    } else if (mark === '\u033b') {
      // Laminal (̻)
      if (place === 'coronal' || place === 'retroflex' || place === 'alveolopalatal') {
        vec[13] += 0.45; vec[12] += 0.25; vec[11] -= 0.18;
        touch(11, 12, 13);
      }
    } else if (mark === '\u033c') {
      // Linguolabial (̼)
      if (isBilabial || place === 'coronal' || place === 'retroflex') {
        vec[10] = Math.max(vec[10] + 1.40, 6.20);
        vec[11] = Math.min(vec[11], -1.10);
        vec[12] = Math.max(vec[12] + 1.20, 4.30);
        vec[3] = Math.min(vec[3], -4.10);
        touch(3, 10, 11, 12);
      }
    }
  }

  // Post-delta Place x Manner physical safety invariants (protect baked & fallback deltas alike):
  // 1. Never break bilabial stop/nasal lip seal on unrounding (`p̜`, `b̜`, `m̜`) or secondary rounding (`pʷ`, `p̹`).
  if (isBilabialStopOrNasal && baseVec19[5] <= -0.15 && !signs.has('\u031e') && !signs.has('\u032a')) {
    vec[5] = Math.min(vec[5], Math.min(baseVec19[5], -0.15));
    touched.add(5);
  }
  // 2. Never accidentally seal the lips on non-labial phones when rounding/labializing (`sʷ`, `tʷ`, `kʷ`, `a̹`, `ᴀ̹`, `u̹`, `ɔ̹`).
  if (!isLabial && baseVec19[5] > 0.10 && (signs.has('ʷ') || signs.has('\u0339'))) {
    const isOpenVowel = isVowel && new Set(['a', 'ᴀ', 'ɑ', 'æ', 'ɐ', 'ɶ', 'ɒ']).has(base);
    const ldFloor = isVowel ? (isOpenVowel ? 0.50 : 0.23) : 0.28;
    if (vec[5] < ldFloor) {
      vec[5] = ldFloor;
      touched.add(5);
    }
  }

  for (const column of touched) {
    const bounds = dimensionBounds.get(column);
    if (bounds) vec[column] = clamp(vec[column], bounds[0], bounds[1]);
  }
  return vec;
}

/** Reactive counter incremented each time a speaker preset pack finishes loading. */
export const ptbPresetsVersion = ref(0);

const SUPPORTED_FACTORY_SPEAKERS = new Set(['JD2', 'W02', 'JD2-2D', 'W02-2D']);
const speakerCache = new Map<string, Map<string, RawPtbEntry>>();
const speakerPromises = new Map<string, Promise<boolean>>();

export function normalizeFactorySpeaker(speaker?: string): string {
  const s = String(speaker ?? 'JD2').trim();
  if (SUPPORTED_FACTORY_SPEAKERS.has(s)) return s;
  return 'JD2';
}

export function cloneTractExtras(extras?: Partial<TractPoseExtras> | null): TractPoseExtras {
  const ts = Array.isArray(extras?.tongue_shape) && extras.tongue_shape.length === 4
    ? [
        Number(extras.tongue_shape[0]) || 0,
        Number(extras.tongue_shape[1]) || 0,
        Number(extras.tongue_shape[2]) || 0,
        Number(extras.tongue_shape[3]) || 0,
      ] as [number, number, number, number]
    : [0, 0, 0, 0] as [number, number, number, number];
  const ls = Array.isArray(extras?.lip_shape) && extras.lip_shape.length === 4
    ? [
        Number(extras.lip_shape[0]) || 0,
        Number(extras.lip_shape[1]) || 0,
        Number(extras.lip_shape[2]) || 0,
        Number(extras.lip_shape[3]) || 0,
      ] as [number, number, number, number]
    : [0, 0, 0, 0] as [number, number, number, number];
  const lwRaw = Number(extras?.lip_width);
  const lhRaw = Number(extras?.larynx_height);
  return {
    lip_width: Number.isFinite(lwRaw) ? clamp(lwRaw, 0.55, 1.6) : 1.0,
    larynx_height: Number.isFinite(lhRaw) ? clamp(lhRaw, -1.0, 1.0) : 0.0,
    manual_root: Boolean(extras?.manual_root ?? false),
    tongue_shape: ts,
    lip_shape: ls,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function normalizeSymbolKey(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^[\[/⟨]+|[\]/⟩]+$/gu, '')
    .replace(/:/g, 'ː')
    .normalize('NFC');
}

function stripTieBars(s: string): string {
  return s.replace(/[\u0361\u035C]/gu, '');
}

function array19ToRecord(vec: readonly number[]): Record<TractParamName, number> {
  const out = {} as Record<TractParamName, number>;
  PARAM_ORDER.forEach((key, idx) => {
    const val = vec[idx];
    out[key] = typeof val === 'number' && Number.isFinite(val) ? val : PRELOAD_JD2_SCHWA_19[idx];
  });
  return out;
}

function recordToArray19(rec: Record<TractParamName, number>): number[] {
  return PARAM_ORDER.map((key) => rec[key]);
}

function extrasFromRaw(entry?: RawPtbEntry | null): TractPoseExtras {
  if (!entry) return cloneTractExtras(DEFAULT_TRACT_EXTRAS);
  return cloneTractExtras({
    lip_width: entry.lip_width,
    larynx_height: entry.larynx_height,
    manual_root: entry.manual_root,
    tongue_shape:
      Array.isArray(entry.tongue_shape) && entry.tongue_shape.length === 4
        ? (entry.tongue_shape as [number, number, number, number])
        : undefined,
    lip_shape:
      Array.isArray(entry.lip_shape) && entry.lip_shape.length === 4
        ? (entry.lip_shape as [number, number, number, number])
        : undefined,
  });
}

const jd2Deltas: Record<string, Record<string, number[][]>> = modifierData.bases;
const dimensionBounds = new Map<number, readonly [number, number]>([
  ...modifierData.indices.map((column, i) => [column, [modifierData.min[i], modifierData.max[i]] as const] as const),
  [14, [-4.0, 2.0] as const],
  [15, [-6.0, 0.0] as const],
]);

function registerEntry(map: Map<string, RawPtbEntry>, keyRaw: string, entry: RawPtbEntry, overwrite = false): void {
  const key = normalizeSymbolKey(keyRaw);
  if (!key) return;
  if (overwrite || !map.has(key)) {
    map.set(key, entry);
  }
  const noTie = stripTieBars(key);
  if (noTie && noTie !== key && (overwrite || !map.has(noTie))) {
    map.set(noTie, entry);
  }
}

async function fetchJsonSafe(url: string): Promise<RawPtbFactoryFile | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const ct = (resp.headers.get('content-type') ?? '').toLowerCase();
    if (!ct.includes('json') && !ct.includes('text')) return null;
    return (await resp.json()) as RawPtbFactoryFile;
  } catch {
    return null;
  }
}

export function isPtbPresetsLoaded(speaker = 'JD2'): boolean {
  const spk = normalizeFactorySpeaker(speaker);
  const map = speakerCache.get(spk);
  return Boolean(map && map.size > 0);
}

/**
 * Load real PhoneticToolbox calibrated presets (`ipa.json`, `pinyin.json`, `default-presets.json`)
 * in parallel for the requested speaker. Deduplicated per speaker.
 */
export function preloadPtbIpaPresets(speaker = 'JD2'): Promise<boolean> {
  const spk = normalizeFactorySpeaker(speaker);
  if (isPtbPresetsLoaded(spk)) return Promise.resolve(true);

  const inflight = speakerPromises.get(spk);
  if (inflight) return inflight;

  const task = (async (): Promise<boolean> => {
    const [ipaFile, pinyinFile, defaultFile] = await Promise.all([
      fetchJsonSafe(`/vocal-tract/factory/${spk}/ipa.json`),
      fetchJsonSafe(`/vocal-tract/factory/${spk}/pinyin.json`),
      fetchJsonSafe('/vocal-tract/default-presets.json'),
    ]);

    const index = new Map<string, RawPtbEntry>();

    // 1. Primary IPA factory presets
    if (ipaFile && Array.isArray(ipaFile.presets)) {
      for (const item of ipaFile.presets) {
        if (!Array.isArray(item.params) || item.params.length < 19) continue;
        if (item.name) {
          registerEntry(index, item.name, item, true);
        }
        if (item.preset) {
          const cleanedPreset = item.preset.replace(/^@[^:]+:/u, '').trim();
          // Skip numeric-only internal VTL shorthand codes like "2" for ø
          if (cleanedPreset && !/^[0-9]+$/u.test(cleanedPreset)) {
            registerEntry(index, cleanedPreset, item, false);
          }
        }
      }
    }

    // 2. Pinyin calibrated presets (trailing segment after '·' gives IPA symbol)
    if (pinyinFile && Array.isArray(pinyinFile.presets)) {
      for (const item of pinyinFile.presets) {
        if (!Array.isArray(item.params) || item.params.length < 19) continue;
        const tail = String(item.name ?? '').split('·').at(-1) ?? '';
        if (tail) {
          registerEntry(index, tail, item, false);
        }
      }
    }

    // 3. Default preset dictionary
    if (defaultFile && defaultFile.presets && !Array.isArray(defaultFile.presets)) {
      for (const [key, item] of Object.entries(defaultFile.presets)) {
        if (!item || !Array.isArray(item.params) || item.params.length < 19) continue;
        registerEntry(index, key, { ...item, name: item.name ?? key }, false);
      }
    }

    if (index.size > 0) {
      speakerCache.set(spk, index);
      ptbPresetsVersion.value += 1;
      return true;
    }
    return false;
  })().finally(() => {
    speakerPromises.delete(spk);
  });

  speakerPromises.set(spk, task);
  return task;
}

function lookupDirect(index: Map<string, RawPtbEntry>, sym: string): RawPtbEntry | null {
  if (!sym) return null;
  const nfc = normalizeSymbolKey(sym);
  const direct = index.get(nfc);
  if (direct) return direct;

  // Try ASCII 'g' -> IPA 'ɡ' (\u0261)
  if (nfc.includes('g')) {
    const ipaG = index.get(nfc.replace(/g/g, 'ɡ'));
    if (ipaG) return ipaG;
  }

  // Try without tie bars
  const noTie = stripTieBars(nfc);
  if (noTie !== nfc) {
    const hit = index.get(noTie);
    if (hit) return hit;
  }

  // Try inserting upper tie bar for common affricates (e.g. ts -> t͡s, tɕ -> t͡ɕ)
  if (noTie.length === 2) {
    const tied = `${noTie[0]}\u0361${noTie[1]}`;
    const hit = index.get(tied);
    if (hit) return hit;
  }

  return null;
}

function stripSuprasegmentals(sym: string): string {
  return normalizeSymbolKey(sym)
    .replaceAll('\u25cc', '')
    .replace(/[0-9⁰¹²³⁴⁵⁶⁷⁸⁹˥˦˧˨˩꜒꜓꜔꜕꜖]+/gu, '')
    .replace(/[ˈˌːˑʰʱ̚ⁿˡʼ˘\u0306\u031A]/gu, '')
    .trim()
    .normalize('NFC');
}

/**
 * Resolve any IPA symbol (including tone marks, diacritics, secondary articulations,
 * diphthongs, and tie-bar variants) to a calibrated PhoneticToolbox VTL 2.4 pose + 5 fine extras.
 */
export function resolvePtbIpaPose(symbol: string, speaker = 'JD2'): ResolvedPtbIpaPose {
  const spk = normalizeFactorySpeaker(speaker);
  const index = speakerCache.get(spk) ?? speakerCache.get('JD2');
  const rawCleaned = normalizeSymbolKey(symbol);

  // Trigger background load automatically if caller asks before preload completes
  if (!index && typeof window !== 'undefined') {
    void preloadPtbIpaPresets(spk);
  }

  if (!index || index.size === 0) {
    const vec = [...PRELOAD_JD2_SCHWA_19];
    return {
      symbol: rawCleaned || 'ə',
      matchedName: 'ə (preload-jd2)',
      speaker: spk,
      params: array19ToRecord(vec),
      params19: vec,
      extras: cloneTractExtras(DEFAULT_TRACT_EXTRAS),
      f0_hz: 120,
      isFallback: true,
    };
  }

  // (a) Direct NFC exact match (including tie-bar variants)
  const exactHit = lookupDirect(index, rawCleaned);
  if (exactHit) {
    const vec = exactHit.params.slice(0, 19);
    return {
      symbol: rawCleaned,
      matchedName: exactHit.name ?? rawCleaned,
      speaker: spk,
      params: array19ToRecord(vec),
      params19: vec,
      extras: extrasFromRaw(exactHit),
      source: exactHit.source ? { ...exactHit.source } : undefined,
      f0_hz: exactHit.f0,
      isFallback: false,
    };
  }

  // (b) Strip tones, stress, length, aspiration, unreleased, brackets
  const stripped = stripSuprasegmentals(rawCleaned);
  const strippedHit = lookupDirect(index, stripped);
  if (strippedHit) {
    const vec = strippedHit.params.slice(0, 19);
    return {
      symbol: rawCleaned,
      matchedName: strippedHit.name ?? stripped,
      speaker: spk,
      params: array19ToRecord(vec),
      params19: vec,
      extras: extrasFromRaw(strippedHit),
      source: strippedHit.source ? { ...strippedHit.source } : undefined,
      f0_hz: strippedHit.f0,
      isFallback: false,
    };
  }

  // Canonical equivalents share lookups while the displayed transcription retains its spelling.
  const canonical = normalizedPhone(stripped);
  const base = phoneTraits(canonical).base;
  const known = lookupDirect(index, canonical.normalize('NFC'));
  let baseEntry = known ?? lookupDirect(index, base);
  const isCompound = Array.from(base).length > 1;
  if (!baseEntry && isCompound) {
    const nucleus = Array.from(base).find(glyph => PRIMARY_VOWELS.has(glyph));
    if (nucleus) baseEntry = lookupDirect(index, nucleus);
  }
  if (baseEntry) {
    const baseVec = baseEntry.params.slice(0, 19);
    const source: PtbSourceHints | undefined = baseEntry.source ? { ...baseEntry.source } : undefined;
    const vec =
      !known && (spk === 'JD2' || spk === 'JD2-2D')
        ? applyJd2DiacriticModifiers(stripped, baseVec)
        : baseVec;
    const hasVoicing = canonical.includes('̥') !== canonical.includes('̬');
    return {
      symbol: rawCleaned, matchedName: known?.name ?? (baseEntry.name + ' · 构型参考'),
      speaker: spk, params: array19ToRecord(vec), params19: vec,
      extras: extrasFromRaw(baseEntry),
      source: hasVoicing ? { ...source, vibration: canonical.includes('̥') ? 0 : 1 } : source,
      f0_hz: baseEntry.f0, isFallback: !known,
    };
  }

  // (e) Final fallback: real calibrated PTB schwa [ə]
  const schwa = lookupDirect(index, 'ə');
  const fallbackVec = schwa ? schwa.params.slice(0, 19) : [...PRELOAD_JD2_SCHWA_19];
  return {
    symbol: rawCleaned || 'ə',
    matchedName: schwa?.name ?? 'ə',
    speaker: spk,
    params: array19ToRecord(fallbackVec),
    params19: fallbackVec,
    extras: extrasFromRaw(schwa),
    source: schwa?.source ? { ...schwa.source } : undefined,
    f0_hz: schwa?.f0 ?? 120,
    isFallback: true,
  };
}

export interface ArticulatoryPose {
  TCX: number; TCY: number; TTX: number; TTY: number; TBX: number; TBY: number;
  TRX?: number; TRY?: number;
  LD: number; LP: number; JA: number; VO: number;
  HX: number; HY: number; JX: number; VS: number;
  TS1: number; TS2: number; TS3: number;
  F0: number; PR: number;
  XB: number; XT: number; CA: number; LAG: number; RA: number; PS: number; FL: number; SHIM: number;
}
