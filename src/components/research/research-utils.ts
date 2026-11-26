import { nasalPoseIpa, splitPhoneNotation, stripDottedCirclePlaceholders, phoneTraits, writtenToneLevels } from '@/data/ipa-segments';
import { speechPhoneDurations, speechStopTiming } from '@/data/speech-timing';
import { ref } from 'vue';
import {
  SAMPLE_RATE_HZ,
  msToSamples,
  samplesToMs,
  type PhonationRegime,
  type SegmentAnchor,
  type TractParamName,
} from '@vocalcut/core';
import { defaultTractParams, tractArray19ToRecord, tractRecordToArray19 } from '@/stores/workbench';
import { getProtectedIpaPose, ipaPoseKey, getSelectedIpaPoseMatch, getSelectedIpaPoseParams, selectedIpaPoseSetId, RECORDED_IPA_SET_ID } from '@/data/ipa-pose-sets';
import {
  applyJd2DiacriticModifiers,
  cloneTractExtras,
  DEFAULT_TRACT_EXTRAS,
  resolvePtbIpaPose,
  type PtbSourceHints,
  type TractPoseExtras,
} from '@/data/ptb-ipa-presets';
import type { SelectOption } from '@/components/common/CustomSelect.vue';

export const SPEAKER_OPTIONS: ReadonlyArray<SelectOption<string>> = [
  { value: 'JD2', label: 'JD2 · 成年男声 3D', badge: 'VTL 2.4' },
];

/** Shared in-memory registry for dragging corpus files from ResearchMainView into ResearchTimeline. */
export const corpusDragFileRegistry = new Map<string, File>();
export const CORPUS_DRAG_MIME = 'application/x-vocalcut-corpus-id';

export interface PhonationLaneMeta {
  regime: PhonationRegime;
  shortLabel: string;
  enLabel: string;
  laneIdx: number;
}

export const PHONATION_LANES: readonly PhonationLaneMeta[] = [
  { regime: 'pressed', shortLabel: '挤喉/紧声', enLabel: 'Pressed', laneIdx: 0 },
  { regime: 'modal', shortLabel: '常态浊声', enLabel: 'Modal', laneIdx: 1 },
  { regime: 'breathy', shortLabel: '气声', enLabel: 'Breathy', laneIdx: 2 },
  { regime: 'whisper', shortLabel: '耳语', enLabel: 'Whisper', laneIdx: 3 },
  { regime: 'creaky', shortLabel: '嘎裂声', enLabel: 'Creaky', laneIdx: 4 },
  { regime: 'falsetto', shortLabel: '假声', enLabel: 'Falsetto', laneIdx: 5 },
] as const;

export interface QuickIpaItem {
  symbol: string;
  display?: string;
  nameZh: string;
  category: 'vowel' | 'consonant' | 'diacritic';
  entryId?: string;
}

const IPA_FAVORITES_KEY = 'vocalcut.ipa-favorites';
const ipaFavorites = ref<QuickIpaItem[]>([]);
try {
  const saved: unknown = JSON.parse(localStorage.getItem(IPA_FAVORITES_KEY) ?? '[]');
  if (Array.isArray(saved)) {
    ipaFavorites.value = saved.filter((item): item is QuickIpaItem =>
      typeof item?.symbol === 'string' && typeof item?.nameZh === 'string' && typeof item?.entryId === 'string');
  }
} catch {
  // The collection remains available for this session if storage is unavailable.
}
export { ipaFavorites };

export function toggleIpaFavorite(item: QuickIpaItem): void {
  ipaFavorites.value = ipaFavorites.value.some((saved) => saved.entryId === item.entryId)
    ? ipaFavorites.value.filter((saved) => saved.entryId !== item.entryId)
    : [...ipaFavorites.value, item];
  try {
    localStorage.setItem(IPA_FAVORITES_KEY, JSON.stringify(ipaFavorites.value));
  } catch {
    // The in-memory collection is still editable.
  }
}

export const QUICK_IPA_ITEMS: readonly QuickIpaItem[] = [
  // Vowels (poses resolved exclusively from real PhoneticToolbox calibrated factory presets)
  { symbol: 'i', nameZh: '前高不圆唇元音', category: 'vowel' },
  { symbol: 'y', nameZh: '前高圆唇元音', category: 'vowel' },
  { symbol: 'e', nameZh: '前半高不圆唇元音', category: 'vowel' },
  { symbol: 'ɛ', nameZh: '前半低不圆唇元音', category: 'vowel' },
  { symbol: 'a', nameZh: '前低不圆唇元音', category: 'vowel' },
  { symbol: 'ɑ', nameZh: '后低不圆唇元音', category: 'vowel' },
  { symbol: 'ɒ', nameZh: '后低圆唇元音', category: 'vowel' },
  { symbol: 'ɔ', nameZh: '后半低圆唇元音', category: 'vowel' },
  { symbol: 'o', nameZh: '后半高圆唇元音', category: 'vowel' },
  { symbol: 'u', nameZh: '后高圆唇元音', category: 'vowel' },
  { symbol: 'ɯ', nameZh: '后高不圆唇元音', category: 'vowel' },
  { symbol: 'ə', nameZh: '央中元音 (Schwa)', category: 'vowel' },
  { symbol: 'ɤ', nameZh: '后半高不圆唇元音', category: 'vowel' },
  { symbol: 'ɐ', nameZh: '次低央元音', category: 'vowel' },
  { symbol: 'aʊ', nameZh: '复合双元音 /aʊ/', category: 'vowel' },
  { symbol: 'eɪ', nameZh: '复合双元音 /eɪ/', category: 'vowel' },
  // Consonants
  { symbol: 'p', nameZh: '清双唇塞音', category: 'consonant' },
  { symbol: 'b', nameZh: '浊双唇塞音', category: 'consonant' },
  { symbol: 'm', nameZh: '双唇鼻音', category: 'consonant' },
  { symbol: 'f', nameZh: '清唇齿擦音', category: 'consonant' },
  { symbol: 't', nameZh: '清齿龈塞音', category: 'consonant' },
  { symbol: 'd', nameZh: '浊齿龈塞音', category: 'consonant' },
  { symbol: 'n', nameZh: '齿龈鼻音', category: 'consonant' },
  { symbol: 'l', nameZh: '齿龈边近音', category: 'consonant' },
  { symbol: 's', nameZh: '清齿龈擦音', category: 'consonant' },
  { symbol: 'ʂ', nameZh: '清卷舌擦音', category: 'consonant' },
  { symbol: 'ɕ', nameZh: '清龈腭擦音', category: 'consonant' },
  { symbol: 'tɕ', nameZh: '清龈腭塞擦音', category: 'consonant' },
  { symbol: 'k', nameZh: '清软腭塞音', category: 'consonant' },
  { symbol: 'x', nameZh: '清软腭擦音', category: 'consonant' },
  { symbol: 'ŋ', nameZh: '软腭鼻音', category: 'consonant' },
  { symbol: 'w', nameZh: '唇软腭近音', category: 'consonant' },
  // Diacritics & VoQS
  { symbol: 'ã', nameZh: '鼻化元音 (VO 开启)', category: 'diacritic' },
  { symbol: 't̚', nameZh: '不除阻齿龈塞音 (粤语入声)', category: 'diacritic' },
  { symbol: 'p̚', nameZh: '不除阻双唇塞音 (入声)', category: 'diacritic' },
  { symbol: 'k̚', nameZh: '不除阻软腭塞音 (入声)', category: 'diacritic' },
  { symbol: 'a̤', nameZh: '气声发声类型元音', category: 'diacritic' },
  { symbol: 'a̰', nameZh: '嘎裂声发声类型元音', category: 'diacritic' },
  { symbol: 'ə˞', nameZh: '卷舌儿化央元音 (呼麦)', category: 'diacritic' },
  { symbol: 'Ṽ', nameZh: 'VoQS 持续鼻化音质', category: 'diacritic' },
  { symbol: 'V̞', nameZh: 'VoQS 降喉暗沉音质', category: 'diacritic' },
  { symbol: 'V̝', nameZh: 'VoQS 升喉明亮音质', category: 'diacritic' },
  { symbol: 'Vʷ', nameZh: 'VoQS 持续圆唇音质', category: 'diacritic' },
  { symbol: 'Vˤ', nameZh: 'VoQS 咽化音质', category: 'diacritic' },
];

export interface CustomIpaPoseEntry {
  id: string;
  symbol: string;
  nameZh: string;
  system: 'ipa' | 'extipa' | 'voqs';
  params: Record<TractParamName, number>;
  extras?: TractPoseExtras;
  referenceRecordingId?: string;
  savedAt: number;
}

export interface FullIpaPoseResult {
  params: Record<TractParamName, number>;
  params19: number[];
  extras: TractPoseExtras;
  source?: PtbSourceHints;
  f0_hz?: number;
}

const CUSTOM_IPA_STORAGE_KEY = 'vocalcut.customIpaPoses.v1';

function loadInitialCustomPoses(): Record<string, CustomIpaPoseEntry> {
  try {
    const raw = localStorage.getItem(CUSTOM_IPA_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, CustomIpaPoseEntry>;
  } catch {
    return {};
  }
}

export const customIpaPoses = ref<Record<string, CustomIpaPoseEntry>>(loadInitialCustomPoses());

export function customPoseKey(id:string, setId = selectedIpaPoseSetId.value):string {
  return setId === RECORDED_IPA_SET_ID ? id : setId + '::' + id;
}

export function poseOverridesForSet(setId: string) {
  return Object.entries(customIpaPoses.value).filter(([key, entry]) => key === customPoseKey(entry.id, setId)).map(([,entry]) => JSON.parse(JSON.stringify(entry)) as CustomIpaPoseEntry);
}

export function saveCustomIpaPose(entry: CustomIpaPoseEntry): void {
  customIpaPoses.value = {
    ...customIpaPoses.value,
    [customPoseKey(entry.id)]: {
      ...entry,
      params: { ...entry.params },
      extras: entry.extras ? cloneTractExtras(entry.extras) : undefined,
      savedAt: Date.now(),
    },
  };
  try {
    localStorage.setItem(CUSTOM_IPA_STORAGE_KEY, JSON.stringify(customIpaPoses.value));
  } catch {
    // ignore quota error
  }
}

export function deleteCustomIpaPose(id: string): void {
  const next = { ...customIpaPoses.value };
  delete next[customPoseKey(id)];
  customIpaPoses.value = next;
  try {
    localStorage.setItem(CUSTOM_IPA_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

/**
 * Resolve full 19-D VTL parameters + 5 fine anatomical extras (`lip_width`, `larynx_height`,
 * `manual_root`, `tongue_shape`, `lip_shape`) from user custom overrides or real PhoneticToolbox
 * calibrated presets (`src/data/ptb-ipa-presets.ts`). Zero hand-coded heuristics.
 */
export function getFullPoseForIpa(symbol: string, entryId?: string, speaker = 'JD2', setId = selectedIpaPoseSetId.value): FullIpaPoseResult {
  const selectedMatch = getSelectedIpaPoseMatch(symbol, setId);
  const selectedPose = selectedMatch?.params ?? getSelectedIpaPoseParams(symbol, setId);
  const protectedKey = getProtectedIpaPose(symbol, setId) ? ipaPoseKey(symbol) : undefined;
  const custom = (entryId ? customIpaPoses.value[customPoseKey(entryId, setId)] : undefined)
    ?? Object.values(customIpaPoses.value).find(e =>
      e === customIpaPoses.value[customPoseKey(e.id, setId)] &&
      (e.symbol === symbol || (protectedKey !== undefined && ipaPoseKey(e.symbol) === protectedKey)));

  const ptb = resolvePtbIpaPose(symbol, speaker);

  if (custom) {
    const mergedParams = { ...defaultTractParams(), ...custom.params };
    return {
      params: mergedParams,
      params19: tractRecordToArray19(mergedParams),
      extras: custom.extras ? cloneTractExtras(custom.extras) : cloneTractExtras(ptb.extras),
      source: ptb.source ? { ...ptb.source } : undefined,
      f0_hz: ptb.f0_hz,
    };
  }

  if (selectedMatch) {
    const adjusted19 = selectedMatch.exact
      ? [...selectedMatch.params]
      : applyJd2DiacriticModifiers(symbol, selectedMatch.params);
    return {
      params: tractArray19ToRecord(adjusted19),
      params19: adjusted19,
      extras: cloneTractExtras(DEFAULT_TRACT_EXTRAS),
      source: ptb.source ? { ...ptb.source } : undefined,
      f0_hz: ptb.f0_hz,
    };
  }

  const useRecordedExtras = Boolean(selectedPose) || setId === RECORDED_IPA_SET_ID;
  const baseVec19 = selectedPose ?? ptb.params19;
  const needsModifierPass = !selectedPose && ptb.isFallback && !ptb.matchedName.includes('构型参考');
  const resolved19 = needsModifierPass ? applyJd2DiacriticModifiers(symbol, baseVec19) : [...baseVec19];
  return {
    params: tractArray19ToRecord(resolved19),
    params19: resolved19,
    extras: cloneTractExtras(useRecordedExtras ? DEFAULT_TRACT_EXTRAS : ptb.extras),
    source: ptb.source ? { ...ptb.source } : undefined,
    f0_hz: ptb.f0_hz,
  };
}

/**
 * Extract 5-field `TractPoseExtras` from a timeline `SegmentAnchor`, preferring explicitly saved
 * segment fields (`lip_width`, `larynx_height_cm`, `tongue_shape`, `lip_shape`) and filling any
 * missing field (including `manual_root`) from the calibrated PTB preset for `seg.ipa`.
 */
export function extractSegmentExtras(
  seg: SegmentAnchor | null | undefined,
  speaker = 'JD2',
): TractPoseExtras {
  const base = getFullPoseForIpa(seg?.ipa ?? 'ə', undefined, speaker).extras;
  if (!seg) return base;
  return cloneTractExtras({
    lip_width: typeof seg.lip_width === 'number' ? seg.lip_width : base.lip_width,
    larynx_height: typeof seg.larynx_height_cm === 'number' ? seg.larynx_height_cm : base.larynx_height,
    manual_root: seg.manual_root ?? base.manual_root,
    tongue_shape:
      Array.isArray(seg.tongue_shape) && seg.tongue_shape.length === 4
        ? (seg.tongue_shape as [number, number, number, number])
        : base.tongue_shape,
    lip_shape:
      Array.isArray(seg.lip_shape) && seg.lip_shape.length === 4
        ? (seg.lip_shape as [number, number, number, number])
        : base.lip_shape,
  });
}

export interface ImportedM27Frame {
  label: string;
  timeSec: number;
  params: Record<TractParamName, number>;
  f0Hz: number;
  prPa: number;
}

/** Shared handoff ref so M27 Reconstruct can send frames directly into Continuum Endpoint A/B */
export const m27ImportedEndpointA = ref<ImportedM27Frame | null>(null);
export const m27ImportedEndpointB = ref<ImportedM27Frame | null>(null);

export function extractToneLevels(ipa: string): string | undefined {
  return writtenToneLevels(ipa);
}

export function toneTarget(levels: string) {
  const first = Number(levels[0]);
  const last = Number(levels.at(-1));
  const bEnd = last === 5 ? 5 : last === 1 ? -3 : last === 4 ? 2.5 : 0.5;
  const slope = levels === '214' ? -3.5 : (last - first) * 2.5;
  return { m_st_per_s: slope, b_end_st: bEnd, lambda_per_s: 34, source: 'default' as const };
}

export function splitIpaToPhonemes(rawIpa: string): string[] {
  return splitPhoneNotation(rawIpa);
}

export interface BuildSyllableSegmentsOptions {
  segmentRatios?: readonly number[];
  speechPhoneMs?: readonly number[];
  segmentPoses?: ReadonlyArray<{
    ipa: string;
    params19: readonly number[];
    extras?: Partial<TractPoseExtras>;
  }>;
  larynxHeightOverrideCm?: number;
}

/** Allocation weights for callers supplying an external score or alignment. */
function legacyPhoneWeight(sym: string): number {
  if (sym === 'sil') return 100;
  const t = phoneTraits(sym);
  if ((t.vowel && !t.nonSyllabic) || t.syllabic) {
    return 135 * t.lengthScale;
  }
  if ((t.vowel && t.nonSyllabic) || ['j', 'w', 'ɥ', 'ɰ'].includes(t.base)) {
    return 55 * t.lengthScale;
  }
  if (t.unreleased) {
    return 52 * t.lengthScale;
  }
  if (sym.includes('ʰ') || sym.includes('ʱ')) {
    return 78 * t.lengthScale;
  }
  return 65 * t.lengthScale;
}

/** Dynamically compute natural syllable duration (ms) from its phone inventory and suprasegmental scale. */
export function estimateSyllableNaturalDurationMs(
  ipaTokens: readonly string[],
  durationScale = 1.0,
  tempoScale = 1.0,
  phoneDurations = speechPhoneDurations(ipaTokens.length ? ipaTokens : ['ə']),
): number {
  const rawMs = phoneDurations.reduce((sum, ms) => sum + ms, 0);
  const floorMs = ipaTokens.reduce((sum, sym) => sum + (phoneTraits(sym).stop ? 12 : 15), 0);
  return Math.max(floorMs, Math.round(rawMs * durationScale * tempoScale));
}

export function buildSegmentsForSyllable(
  sylId: string,
  ipaTokens: string[],
  startSmp: number,
  endSmp: number,
  speaker = 'JD2',
  setId = selectedIpaPoseSetId.value,
  options?: BuildSyllableSegmentsOptions,
): SegmentAnchor[] {
  const safeTokens = ipaTokens.length > 0 ? ipaTokens : ['ə'];
  const totalSmp = Math.max(safeTokens.length, endSmp - startSmp);
  const segCount = safeTokens.length;
  const traits = safeTokens.map(phoneTraits);
  let nucIdx = traits.findIndex(t => t.syllabic);
  if (nucIdx < 0) nucIdx = traits.findIndex(t => t.vowel && !t.nonSyllabic);
  if (nucIdx < 0) nucIdx = segCount > 1 ? 1 : 0;

  const hasValidUserRatios =
    Boolean(options?.segmentRatios) &&
    options!.segmentRatios!.length === segCount &&
    options!.segmentRatios!.every((r) => Number.isFinite(r) && r > 0);

  const weights = hasValidUserRatios
    ? options!.segmentRatios!.map((r) => Math.max(0.02, r))
    : options?.speechPhoneMs ?? safeTokens.map((sym) => Math.max(12, legacyPhoneWeight(sym)));
  const weightSum = weights.reduce((a, b) => a + b, 0) || segCount;

  // Allocate integer sample widths proportionally while protecting stop/segment rigid floors when space permits
  const floors = traits.map((t) => (t.stop ? msToSamples(12) : msToSamples(15)));
  const totalFloor = floors.reduce((a, b) => a + b, 0);
  const rawWidths = weights.map((w) => Math.max(1, Math.round((totalSmp * w) / weightSum)));

  if (totalSmp >= totalFloor && segCount > 1) {
    for (let i = 0; i < segCount; i++) {
      if (rawWidths[i] < floors[i]) rawWidths[i] = floors[i];
    }
  }
  let curSum = rawWidths.reduce((a, b) => a + b, 0);
  let diff = totalSmp - curSum;
  let guard = 0;
  while (diff !== 0 && guard++ < 256) {
    if (diff > 0) {
      const targetIdx = nucIdx >= 0 && nucIdx < segCount ? nucIdx : 0;
      rawWidths[targetIdx] += diff;
      diff = 0;
    } else {
      // Shrink the segment with the largest slack above its floor
      let bestIdx = -1;
      let bestSlack = 0;
      for (let i = 0; i < segCount; i++) {
        const minAllowed = totalSmp >= totalFloor ? floors[i] : 1;
        const slack = rawWidths[i] - minAllowed;
        if (slack > bestSlack) {
          bestSlack = slack;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) {
        bestIdx = rawWidths.indexOf(Math.max(...rawWidths));
        if (rawWidths[bestIdx] <= 1) break;
        const take = Math.min(-diff, rawWidths[bestIdx] - 1);
        rawWidths[bestIdx] -= take;
        diff += take;
      } else {
        const take = Math.min(-diff, bestSlack);
        rawWidths[bestIdx] -= take;
        diff += take;
      }
    }
  }

  let cursor = startSmp;
  return safeTokens.map((sym, idx) => {
    const s0 = cursor;
    const s1 = idx === segCount - 1 ? endSmp : Math.min(endSmp - (segCount - 1 - idx), s0 + Math.max(1, rawWidths[idx]));
    cursor = s1;
    const isStop = traits[idx].stop;
    const durMs = Math.max(11, samplesToMs(s1 - s0));
    const role: SegmentAnchor['role'] =
      sym === 'sil' ? 'rest' : idx < nucIdx ? 'onset' : idx === nucIdx ? 'nucleus' : 'coda';
    const voiced = sym === 'sil' ? false : traits[idx].voiced;
    const full = getFullPoseForIpa(nasalPoseIpa(sym), undefined, speaker, setId);
    const savedPose = options?.segmentPoses?.[idx];
    const params19 =
      savedPose && Array.isArray(savedPose.params19) && savedPose.params19.length === 19
        ? [...savedPose.params19]
        : [...full.params19];
    const extras = savedPose?.extras
      ? cloneTractExtras({ ...full.extras, ...savedPose.extras })
      : full.extras;
    const larynxHeight =
      options?.larynxHeightOverrideCm !== undefined ? options.larynxHeightOverrideCm : extras.larynx_height;

    const closureMs = Math.max(10, Math.min(Math.max(10, Math.floor(durMs - 1)), Math.round(durMs * 0.6)));
    const remAfterClosure = Math.max(1, Math.floor(durMs - closureMs));
    const releaseMs = sym.endsWith('̚') || traits[idx].unreleased ? 1 : Math.max(1, Math.min(remAfterClosure, Math.round(durMs * 0.14)));
    const aspMs = sym.includes('ʰ') ? Math.max(0, Math.min(Math.max(0, remAfterClosure - releaseMs), Math.round(durMs * 0.26))) : 0;

    return {
      id: `${sylId}_seg_${idx}`,
      ipa: sym,
      start_smp: s0,
      end_smp: s1,
      role,
      elastic: !isStop && role === 'nucleus',
      voiced,
      params: params19,
      lip_width: extras.lip_width,
      larynx_height_cm: larynxHeight,
      manual_root: extras.manual_root,
      tongue_shape: [...extras.tongue_shape],
      lip_shape: [...extras.lip_shape],
      ...(isStop
        ? {
            stop_timing: options?.speechPhoneMs ? speechStopTiming(sym, durMs) : {
              closure_ms: closureMs,
              release_ms: releaseMs,
              aspiration_ms: aspMs,
              vot_ms: voiced ? -Math.min(10, closureMs) : sym.includes('ʰ') ? Math.min(38, releaseMs + aspMs) : Math.min(12, releaseMs + aspMs),
              auto_generated: true,
            },
          }
        : {}),
    };
  });
}

export function replaceSegmentIpa(segment: SegmentAnchor, symbol: string, speaker: string, entryId?: string): SegmentAnchor {
  const cleanSymbol = stripDottedCirclePlaceholders(symbol).replaceAll('\u25cc', '').trim() || symbol;
  const poseIpa = nasalPoseIpa(cleanSymbol);
  const { params19, extras } = getFullPoseForIpa(poseIpa, poseIpa === cleanSymbol ? entryId : undefined, speaker);
  const { stop, voiced, aspirated, unreleased } = phoneTraits(cleanSymbol);
  const durationMs = samplesToMs(segment.end_smp - segment.start_smp);
  const releaseMs = unreleased ? 1 : Math.max(1, Math.floor(durationMs * 0.12));
  return {
    ...segment,
    ipa: cleanSymbol,
    voiced,
    elastic: !stop && segment.role === 'nucleus',
    params: [...params19],
    lip_width: extras.lip_width,
    larynx_height_cm: extras.larynx_height,
    tongue_shape: [...extras.tongue_shape],
    manual_root: extras.manual_root,
    lip_shape: [...extras.lip_shape],
    stop_timing: stop ? {
      closure_ms: Math.max(10, Math.floor(durationMs * 0.58)),
      release_ms: releaseMs,
      aspiration_ms: aspirated ? Math.max(0, Math.floor(durationMs * 0.18)) : 0,
      vot_ms: voiced ? -10 : aspirated ? 38 : 12,
      auto_generated: true,
    } : undefined,
  };
}

export interface MiniTractPaths {
  upperWall: string;
  pharynxWall: string;
  lowerJaw: string;
  tongue: string;
  airway: string;
  nasal: string;
  aminPt: [number, number];
}

export function formatTimecode(smp: number): string {
  const sec = Math.max(0, smp / SAMPLE_RATE_HZ);
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${String(mins).padStart(2, '0')}:${rem.toFixed(2).padStart(5, '0')}`;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('File read failed'));
    reader.readAsDataURL(blob);
  });
}

export { encodeMonoWavBase64 } from '@/data/wav-encoding';

export function downloadTextFile(filename: string, content: string, mime = 'application/json;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
