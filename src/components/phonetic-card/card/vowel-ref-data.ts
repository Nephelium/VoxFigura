import { loadVowelMeasurements } from '@/data/ipa-vowel-measurements';

export interface CardVowelRefPoint {
  symbol: string;
  f1: number;
  f2: number;
  nasal?: boolean;
}

/**
 * Built-in VTL 2.4 JD2-65 full 29-vowel reference table (mirrored from `engine/reference_library/vowel-transfer-jd2-65.json`)
 * so the logarithmic F1-F2 vowel chart always renders all reference vowel points immediately, even offline.
 */
export const DEFAULT_JD2_VOWEL_REFS: readonly CardVowelRefPoint[] = [
  { symbol: 'i', f1: 281.2, f2: 2074.2 },
  { symbol: 'y', f1: 281.2, f2: 1886.7 },
  { symbol: 'ɨ', f1: 351.6, f2: 1617.2 },
  { symbol: 'ʉ', f1: 304.7, f2: 1253.9 },
  { symbol: 'ɯ', f1: 363.3, f2: 1230.5 },
  { symbol: 'u', f1: 316.4, f2: 656.2 },
  { symbol: 'ɪ', f1: 375.0, f2: 1781.2 },
  { symbol: 'ʏ', f1: 328.1, f2: 1757.8 },
  { symbol: 'ʊ', f1: 339.8, f2: 808.6 },
  { symbol: 'e', f1: 398.4, f2: 1886.7 },
  { symbol: 'ø', f1: 398.4, f2: 1593.8 },
  { symbol: 'ɘ', f1: 445.3, f2: 1476.6 },
  { symbol: 'ɵ', f1: 445.3, f2: 1066.4 },
  { symbol: 'ɤ', f1: 410.2, f2: 1101.6 },
  { symbol: 'o', f1: 351.6, f2: 726.6 },
  { symbol: 'ə', f1: 480.5, f2: 1253.9 },
  { symbol: 'ɛ', f1: 574.2, f2: 1863.3 },
  { symbol: 'œ', f1: 468.8, f2: 1418.0 },
  { symbol: 'ɜ', f1: 515.6, f2: 1113.3 },
  { symbol: 'ɞ', f1: 457.0, f2: 878.9 },
  { symbol: 'ʌ', f1: 527.3, f2: 1019.5 },
  { symbol: 'ɔ', f1: 457.0, f2: 750.0 },
  { symbol: 'æ', f1: 656.2, f2: 1769.5 },
  { symbol: 'ɐ', f1: 597.7, f2: 1113.3 },
  { symbol: 'a', f1: 785.2, f2: 1488.3 },
  { symbol: 'ᴀ(ä)', f1: 761.7, f2: 1359.4 },
  { symbol: 'ɶ', f1: 503.9, f2: 1265.6 },
  { symbol: 'ɑ', f1: 609.4, f2: 996.1 },
  { symbol: 'ɒ', f1: 480.5, f2: 773.4 },
];

const speakerVowelCache = new Map<string, readonly CardVowelRefPoint[]>();
const speakerInFlight = new Map<string, Promise<readonly CardVowelRefPoint[]>>();

export function getCachedVowelRefs(speaker: string): readonly CardVowelRefPoint[] {
  return speakerVowelCache.get(speaker) ?? DEFAULT_JD2_VOWEL_REFS;
}

export function prefetchSpeakerVowelRefs(speaker: string): Promise<readonly CardVowelRefPoint[]> {
  const existing = speakerVowelCache.get(speaker);
  if (existing) return Promise.resolve(existing);
  const pending = speakerInFlight.get(speaker);
  if (pending) return pending;

  const req = loadVowelMeasurements('transfer', speaker)
    .then((res) => {
      if (res.records.length > 0) {
        const list = res.records.map((r) => ({
          symbol: r.symbol,
          f1: r.f1,
          f2: r.f2,
          nasal: r.nasal,
        }));
        speakerVowelCache.set(speaker, list);
        return list;
      }
      return DEFAULT_JD2_VOWEL_REFS;
    })
    .catch(() => DEFAULT_JD2_VOWEL_REFS)
    .finally(() => {
      speakerInFlight.delete(speaker);
    });

  speakerInFlight.set(speaker, req);
  return req;
}
