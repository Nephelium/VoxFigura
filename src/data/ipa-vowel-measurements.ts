import { normalizedPhone } from '@/data/ipa-segments';

export type VowelReferenceMode = 'transfer' | 'recorded';
export interface RecordedVowelFormants {
  id: string;
  symbol: string;
  f1: number;
  f2: number;
  f3?: number;
  frames: number;
  core_start_s: number;
  core_end_s: number;
  nasal?: boolean;
  nasal_port_cm2?: number;
}

interface VowelOmission {
  id: string;
  symbol?: string;
  code?: 'missing_annotation' | 'missing_track' | 'missing_peaks';
  reason?: string;
}

interface VowelMeasurements {
  records: RecordedVowelFormants[];
  omitted: VowelOmission[];
  speaker?: string;
  section_count?: number;
  method?: string;
  source_geometry?: string;
  anatomy_adaptation?: 'none' | 'native_landmarks';
}

export const CENTRAL_OPEN_UNROUNDED_KEY = 'ᴀ';
export const CENTRAL_OPEN_UNROUNDED_LABEL = 'ᴀ(ä)';

const ROUNDED_VOWEL_BASES = new Set([
  'y', 'ʏ', 'ø', 'œ', 'ɶ', 'ʉ', 'ɵ', 'ɞ', 'u', 'ʊ', 'o', 'ɔ', 'ɒ', 'ʮ', 'ʯ',
]);

function stripCentralAliasSuffix(raw: string): string {
  return raw.trim().replace(/\(\s*(?:a\u0308|ä)\s*\)/gu, '');
}

export const vowelSymbolKey = (symbol: string): string => {
  const cleaned = normalizedPhone(stripCentralAliasSuffix(symbol)).normalize('NFD');
  const hasNasal = cleaned.includes('\u0303');
  const withoutNasal = cleaned.replaceAll('\u0303', '');
  if (withoutNasal === 'ᴀ' || withoutNasal === 'a\u0308') {
    return hasNasal ? `${CENTRAL_OPEN_UNROUNDED_KEY}\u0303` : CENTRAL_OPEN_UNROUNDED_KEY;
  }
  return cleaned.normalize('NFC');
};

export function formatVowelChartLabel(symbol: string): string {
  const trimmed = symbol.trim();
  if (!trimmed) return '';
  const key = vowelSymbolKey(trimmed);
  if (key === CENTRAL_OPEN_UNROUNDED_KEY) return CENTRAL_OPEN_UNROUNDED_LABEL;
  if (key === `${CENTRAL_OPEN_UNROUNDED_KEY}\u0303`) return 'ᴀ̃(ä̃)';
  return trimmed;
}

export function isRoundedVowelSymbol(symbol: string): boolean {
  const nfd = normalizedPhone(stripCentralAliasSuffix(symbol)).normalize('NFD');
  // Explicit rounding/unrounding diacritics take precedence over base vowel
  const hasLessRounded = nfd.includes('\u031C') || symbol.includes('˒');
  const hasMoreRounded = nfd.includes('\u0339') || nfd.includes('ʷ') || symbol.includes('˓');
  if (hasMoreRounded && !hasLessRounded) return true;
  if (hasLessRounded && !hasMoreRounded) return false;
  const base = Array.from(nfd.replace(/[\p{M}ʰʱʷʲˠˤ˞ʼⁿˡːˑ˘˔˕˖˗˓˒]/gu, ''))[0] ?? '';
  return ROUNDED_VOWEL_BASES.has(base);
}

export const VOWEL_ROUNDING_COLORS = {
  light: {
    unroundedRgb: '14, 165, 233',
    unroundedHex: '#0ea5e9',
    unroundedText: '#075985',
    roundedRgb: '147, 51, 234',
    roundedHex: '#9333ea',
    roundedText: '#6b21a8',
  },
  dark: {
    unroundedRgb: '56, 189, 248',
    unroundedHex: '#38bdf8',
    unroundedText: '#e0f2fe',
    roundedRgb: '192, 132, 252',
    roundedHex: '#c084fc',
    roundedText: '#f3e8ff',
  },
} as const;

/** Normalized radial stops [offset, relativeAlpha] sampling exp(-5.2 * r^2) for a clean, airy Gaussian peak */
export const VOWEL_GAUSSIAN_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 1.0],
  [0.2, 0.81],
  [0.42, 0.4],
  [0.66, 0.11],
  [0.86, 0.02],
  [1.0, 0.0],
];

const database = new Map<string, Promise<VowelMeasurements>>();
export function loadVowelMeasurements(mode: VowelReferenceMode, speaker: string) {
  const key = mode === 'recorded' ? mode : mode + ':' + speaker;
  const prior = database.get(key);
  if (prior) return prior;
  const result = (async () => {
    const query = new URLSearchParams({ source: mode });
    if (mode === 'transfer') query.set('speaker', speaker);
    const response = await fetch('/api/models/ipa-references/vowel-formants?' + query, {
      signal: AbortSignal.timeout(mode === 'transfer' ? 120000 : 8000),
    });
    if (!response.ok) throw new Error(mode === 'transfer' ? '本机 VTL 元音参考不可用' : '本机实录元音测量不可用');
    const content = await response.json() as Partial<VowelMeasurements>;
    if (!Array.isArray(content.records)
      || (mode === 'transfer' && (content.speaker !== speaker || content.section_count !== 65 || content.method !== 'vtl-hf-textgrid-core-v1'))) {
      throw new Error('元音参考数据与当前解剖模型不匹配');
    }
    return {
      ...content,
      records: content.records.filter(point => typeof point.symbol === 'string' && typeof point.id === 'string'
        && Number.isFinite(point.f1) && Number.isFinite(point.f2) && point.f1 > 0 && point.f2 > point.f1
        && Number.isSafeInteger(point.frames) && point.frames >= 4
        && Number.isFinite(point.core_start_s) && Number.isFinite(point.core_end_s)
        && point.core_start_s >= 0 && point.core_end_s > point.core_start_s),
      omitted: Array.isArray(content.omitted) ? content.omitted : [],
    };
  })().catch(error => { database.delete(key); throw error; });
  database.set(key, result);
  return result;
}

export async function loadRecordedVowelFormants() {
  return (await loadVowelMeasurements('recorded', '')).records;
}

export async function measureSavedVowelPoses(speaker: string, poses: {
  symbol: string; params: number[]; lip_width: number; larynx_height: number;
  manual_root: boolean; tongue_shape: number[]; lip_shape: number[];
}[], signal: AbortSignal) {
  const response = await fetch('/api/models/ipa-references/vowel-poses', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]), body: JSON.stringify({ speaker, poses }),
  });
  if (!response.ok) throw new Error('套装构型峰值未完成');
  const result = await response.json() as {
    speaker: string; section_count: number;
    records: Pick<RecordedVowelFormants, 'symbol' | 'f1' | 'f2' | 'f3' | 'nasal'>[];
    omitted: { symbol: string; code: 'invalid_pose' | 'missing_peaks' }[];
  };
  if (result.speaker !== speaker || result.section_count !== 65) throw new Error('套装构型峰值与当前解剖模型不匹配');
  return result;
}

export interface VowelTrackFrame {
  f1: number;
  f2: number;
  f3?: number;
  nasal?: boolean;
}

export interface VowelTrackMeasurements {
  speaker: string;
  section_count: number;
  fps: number;
  frames: Array<VowelTrackFrame | null>;
}

const trackCache = new Map<string, Promise<VowelTrackMeasurements>>();

export function interpolateVowelTrackAt(
  frames: readonly (VowelTrackFrame | null)[],
  timeSec: number,
  fps = 50,
): VowelTrackFrame | null {
  if (!frames.length || !Number.isFinite(timeSec)) return null;
  const pos = Math.max(0, Math.min(frames.length - 1, timeSec * fps));
  const lo = Math.floor(pos);
  const hi = Math.min(frames.length - 1, Math.ceil(pos));
  const a = frames[lo];
  const b = frames[hi];
  if (a && b) {
    if (lo === hi) return a;
    const t = pos - lo;
    const f3 =
      a.f3 != null && b.f3 != null && Number.isFinite(a.f3) && Number.isFinite(b.f3)
        ? a.f3 + (b.f3 - a.f3) * t
        : (t < 0.5 ? a.f3 : b.f3);
    return {
      f1: a.f1 + (b.f1 - a.f1) * t,
      f2: a.f2 + (b.f2 - a.f2) * t,
      ...(f3 != null ? { f3 } : {}),
      nasal: t < 0.5 ? a.nasal : b.nasal,
    };
  }
  if (a) return a;
  if (b) return b;
  for (let d = 1; d <= 4; d++) {
    if (lo - d >= 0 && frames[lo - d]) return frames[lo - d];
    if (hi + d < frames.length && frames[hi + d]) return frames[hi + d];
  }
  return null;
}

export function measureVowelFormantTrack(
  speaker: string,
  symbol: string,
  cacheId: string,
  rows: readonly (readonly number[])[],
  signal?: AbortSignal,
): Promise<VowelTrackMeasurements> {
  const key = `${speaker}:${symbol}:${cacheId}`;
  const existing = trackCache.get(key);
  if (existing) return existing;
  const req = (async () => {
    const response = await fetch('/api/models/ipa-references/vowel-track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
      body: JSON.stringify({ speaker, symbol, rows }),
    });
    if (!response.ok) throw new Error('动态元音轨迹峰值未完成');
    const data = (await response.json()) as Partial<VowelTrackMeasurements>;
    if (data.speaker !== speaker || data.section_count !== 65 || !Array.isArray(data.frames)) {
      throw new Error('动态元音轨迹与当前解剖模型不匹配');
    }
    return {
      speaker: data.speaker,
      section_count: data.section_count,
      fps: typeof data.fps === 'number' && data.fps > 0 ? data.fps : 50,
      frames: data.frames,
    };
  })().catch((err) => {
    trackCache.delete(key);
    throw err;
  });
  trackCache.set(key, req);
  if (trackCache.size > 48) {
    const firstKey = trackCache.keys().next().value;
    if (firstKey !== undefined) trackCache.delete(firstKey);
  }
  return req;
}
