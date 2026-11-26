import {
  msToSamples,
  samplesToMs,
  type Clip,
  type F0PinSegment,
  type PhonationAnchor,
  type SegmentAnchor,
  type StopTiming,
} from '@vocalcut/core';
import { nasalPoseIpa, phoneTraits } from './ipa-segments';

export const speechDurationScale = { slow: 1.7, medium: 1, fast: 0.58 } as const;
export type SpeechRate = keyof typeof speechDurationScale;

export interface PiecewiseTimePoint {
  orig: number;
  next: number;
}

export function mapPiecewiseTime(points: readonly PiecewiseTimePoint[], origValue: number): number {
  if (!points.length) return origValue;
  if (origValue <= points[0].orig) return points[0].next;
  const last = points[points.length - 1];
  if (origValue >= last.orig) return last.next;
  let lo = 0;
  let hi = points.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].orig <= origValue) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const span = b.orig - a.orig;
  if (span <= 0) return b.next;
  const u = (origValue - a.orig) / span;
  return a.next + u * (b.next - a.next);
}

function rescaleStopTiming(timing: StopTiming, scaledDurMs: number, factor: number): StopTiming {
  const totalMs = Math.max(11, Math.round(scaledDurMs));
  const releaseMs = Math.max(1, Math.min(totalMs - 10, Math.round(timing.release_ms * factor)));
  const maxAsp = Math.max(0, totalMs - 10 - releaseMs);
  const aspirationMs = Math.max(0, Math.min(maxAsp, Math.round(timing.aspiration_ms * factor)));
  const closureMs = Math.max(10, totalMs - releaseMs - aspirationMs);
  const votMs =
    timing.vot_ms < 0
      ? -Math.min(closureMs, Math.max(1, Math.round(-timing.vot_ms * factor)))
      : timing.vot_ms === 0
        ? 0
        : Math.min(releaseMs + aspirationMs, Math.max(1, Math.round(timing.vot_ms * factor)));
  return {
    ...timing,
    closure_ms: closureMs,
    release_ms: releaseMs,
    aspiration_ms: aspirationMs,
    vot_ms: votMs,
  };
}

/**
 * Rescale all syllables, phoneme segments, stop timings, QTA targets, F0 pins,
 * and phonation anchors by `factor` while preserving 48 kHz integer half-open
 * `[start_smp, end_smp)` invariants and rigid stop floors (>= 10 ms closure, >= 1 ms release).
 */
export function rescaleClipForSpeechRate(
  clip: Clip,
  controls: {
    phonation_anchors: Record<string, PhonationAnchor>;
    f0_pins: F0PinSegment[];
  },
  factor: number,
): {
  clip: Clip;
  retimed: {
    phonation_anchors: Record<string, PhonationAnchor>;
    f0_pins: F0PinSegment[];
  };
} {
  const nextClip = JSON.parse(JSON.stringify(clip)) as Clip;
  if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 1e-6 || !nextClip.syllable_order.length) {
    return {
      clip: nextClip,
      retimed: {
        phonation_anchors: JSON.parse(JSON.stringify(controls.phonation_anchors)) as Record<string, PhonationAnchor>,
        f0_pins: JSON.parse(JSON.stringify(controls.f0_pins)) as F0PinSegment[],
      },
    };
  }

  const warp: PiecewiseTimePoint[] = [{ orig: 0, next: 0 }];
  let prevOrig = 0;
  let cursor = 0;

  for (const sid of nextClip.syllable_order) {
    const syl = nextClip.syllables[sid];
    if (!syl || !syl.segments.length) continue;

    const origSylStart = syl.start_smp;
    const origSylEnd = syl.end_smp;
    if (origSylStart > prevOrig) {
      cursor += Math.max(0, Math.round((origSylStart - prevOrig) * factor));
      warp.push({ orig: origSylStart, next: cursor });
      prevOrig = origSylStart;
    }

    const newSylStart = cursor;
    for (const seg of syl.segments) {
      const origSegStart = seg.start_smp;
      const origSegEnd = seg.end_smp;
      if (origSegStart > prevOrig) {
        cursor += Math.max(0, Math.round((origSegStart - prevOrig) * factor));
        warp.push({ orig: origSegStart, next: cursor });
        prevOrig = origSegStart;
      }
      const isStop = Boolean(seg.stop_timing) || phoneTraits(seg.ipa).stop;
      const floorMs = isStop ? 11 : seg.role === 'rest' ? 10 : 15;
      const floorSmp = msToSamples(floorMs);
      const origDurSmp = Math.max(1, origSegEnd - origSegStart);
      const scaledDurSmp = Math.max(floorSmp, Math.round(origDurSmp * factor));

      seg.start_smp = cursor;
      seg.end_smp = cursor + scaledDurSmp;
      if (seg.stop_timing) {
        seg.stop_timing = rescaleStopTiming(seg.stop_timing, samplesToMs(scaledDurSmp), factor);
      }

      cursor = seg.end_smp;
      warp.push({ orig: origSegEnd, next: cursor });
      prevOrig = origSegEnd;
    }

    const newSylEnd = syl.segments[syl.segments.length - 1].end_smp;
    syl.start_smp = newSylStart;
    syl.end_smp = newSylEnd;

    const origSylDur = Math.max(1, origSylEnd - origSylStart);
    const actualSylScale = Math.max(0.1, (newSylEnd - newSylStart) / origSylDur);
    for (const target of syl.targets) {
      const mappedStart = Math.round(mapPiecewiseTime(warp, target.start_smp));
      const mappedEnd = Math.round(mapPiecewiseTime(warp, target.end_smp));
      target.start_smp = Math.max(newSylStart, Math.min(newSylEnd - 1, mappedStart));
      target.end_smp = Math.max(target.start_smp + 1, Math.min(newSylEnd, mappedEnd));
      for (const candidate of Object.values(target.candidates)) {
        if (candidate && Number.isFinite(candidate.m_st_per_s)) {
          candidate.m_st_per_s = Number((candidate.m_st_per_s / actualSylScale).toFixed(3));
        }
      }
    }
  }

  if (clip.end_smp > prevOrig) {
    cursor += Math.max(0, Math.round((clip.end_smp - prevOrig) * factor));
    warp.push({ orig: clip.end_smp, next: cursor });
  }
  nextClip.start_smp = 0;
  nextClip.end_smp = Math.max(1, cursor);

  const mapSmp = (smp: number) => Math.max(0, Math.min(nextClip.end_smp, Math.round(mapPiecewiseTime(warp, smp))));

  const nextAnchors: Record<string, PhonationAnchor> = {};
  for (const [id, anchor] of Object.entries(controls.phonation_anchors)) {
    nextAnchors[id] = {
      ...anchor,
      t_smp: mapSmp(anchor.t_smp),
    };
  }

  const nextPins: F0PinSegment[] = controls.f0_pins.map((seg) => {
    const points = seg.points.map((pt) => ({
      ...pt,
      t_smp: mapSmp(pt.t_smp),
    }));
    const startSmp = points.length ? points[0].t_smp : mapSmp(seg.start_smp);
    const endSmp = points.length ? Math.max(startSmp + 1, points[points.length - 1].t_smp) : Math.max(startSmp + 1, mapSmp(seg.end_smp));
    return {
      ...seg,
      start_smp: startSmp,
      end_smp: endSmp,
      points,
    };
  });

  return {
    clip: nextClip,
    retimed: {
      phonation_anchors: nextAnchors,
      f0_pins: nextPins,
    },
  };
}

const sibilants = 'szʃʒʂʐɕʑ';
const glides = ['j', 'w', 'ɥ', 'ɰ', 'ʋ'];

/** Medium-rate priors informed by the local CV/VCV IPA TextGrids.
 * VCV annotations include closure, while initial voiceless stops often start at the burst.
 * Use the local contrast and reserve enough time for synthesis to form the initial seal.
 */
export function speechPhoneDurations(
  phones: readonly string[],
  leftPhone?: string,
  rightPhone?: string,
): number[] {
  const traits = phones.map(phoneTraits);
  const leftEdge = leftPhone === undefined ? undefined : phoneTraits(leftPhone);
  const rightEdge = rightPhone === undefined ? undefined : phoneTraits(rightPhone);
  const lastVowel = traits.reduce((last, phone, index) => phone.vowel ? index : last, -1);
  return traits.map((phone, index) => {
    if (phones[index] === 'sil') return 100;
    const left = traits[index - 1] ?? leftEdge;
    const right = traits[index + 1] ?? rightEdge;
    const intervocalic = Boolean(left?.vowel && right?.vowel);
    const first = phone.base[0] ?? '';
    let durationMs = 100;
    if (phone.vowel && !phone.nonSyllabic) {
      durationMs = /^[əɐɘɵɚ]/u.test(first) ? 130
        : /^[iyɨʉɯuɪʏʊ]/u.test(first) ? 165
        : /^[aɑɒæɶ]/u.test(first) ? 220 : 185;
      if (Array.from(phone.base).length > 1 && !/[˞]/u.test(phones[index])) durationMs += 28;
      if (right && !right.vowel && lastVowel > index + 1) durationMs *= 0.72;
    } else if (phone.stop) {
      if (phone.unreleased) durationMs = intervocalic ? 69 : 43;
      else if (phone.affricate) {
        durationMs = phone.aspirated ? 158 : phone.voiced ? 83 : 58;
        if (intervocalic) durationMs += 48;
      } else {
        durationMs = phone.aspirated ? 108 : phone.voiced ? 54 : 27;
        if (first === 'k' || first === 'q') durationMs += 5;
        if (intervocalic) durationMs += 56;
      }
    } else if (phone.nasal) {
      durationMs = first === 'm' || first === 'n' ? 170 : 150;
      if (phone.syllabic) durationMs += 28;
    } else if (phone.fricative) {
      const sibilant = !!first && sibilants.includes(first);
      durationMs = phone.voiced ? (sibilant ? 148 : 128) : (sibilant ? 195 : 174);
    } else if (phone.nonSyllabic || glides.includes(phone.base)) {
      durationMs = 88;
    } else if (/^[ɾɽⱱ]/u.test(first)) {
      durationMs = 37;
    } else if (/^[rʀʙ]/u.test(first)) {
      durationMs = 136;
    } else if (phone.sonorant) {
      durationMs = 126;
    }
    return durationMs * phone.lengthScale;
  });
}

/**
 * Connected-speech duration multiplier for rule-compiled IPA / VoQS / fallback syllables.
 * `speechPhoneDurations` reflects isolated VCV citation priors; multi-phone tokens compress
 * smoothly into natural connected-speech timing and avoid inflating every unstressed vowel in
 * un-dotted multi-syllable `[...]` tokens with a full `1.25x` primary-stress boost.
 */
export function connectedRuleDurationScale(
  phonemes: readonly string[],
  rawDurationScale = 1.0,
  language?: 'zh' | 'en' | 'ja' | 'ipa',
): number {
  const n = phonemes.length;
  let compression =
    n <= 1 ? 1.0 :
    n === 2 ? 0.72 :
    n === 3 ? 0.62 : 0.56;
  if (language === 'en') {
    compression = Math.min(compression, 0.58);
  }
  const safeStress = Number.isFinite(rawDurationScale) && rawDurationScale > 0 ? rawDurationScale : 1.0;
  let effectiveStress = safeStress;
  if (safeStress > 1.0) {
    const vowelCount = phonemes.reduce((cnt, sym) => {
      const t = phoneTraits(sym);
      return cnt + ((t.vowel && !t.nonSyllabic) || t.syllabic ? 1 : 0);
    }, 0);
    if (vowelCount >= 2) {
      effectiveStress = 1 + (safeStress - 1) * 0.32;
    }
  }
  return effectiveStress * compression;
}

export function speechStopTiming(ipa: string, durationMs: number): StopTiming {
  const { affricate, aspirated, unreleased, voiced } = phoneTraits(ipa);
  const availableMs = Math.max(11, durationMs);
  const aspirationMs = aspirated && !unreleased
    ? Math.min(availableMs - 11, Math.round(availableMs * (affricate ? 0.43 : 0.58)))
    : 0;
  const releaseMs = unreleased ? 1 : Math.max(1,
    Math.min(50, availableMs - 10 - aspirationMs, Math.round(availableMs * (affricate ? 0.38 : 0.16))));
  const closureMs = availableMs - releaseMs - aspirationMs;
  return {
    closure_ms: closureMs,
    release_ms: releaseMs,
    aspiration_ms: aspirationMs,
    vot_ms: voiced ? -Math.min(closureMs, Math.round(closureMs * 0.75), affricate ? 42 : 36)
      : releaseMs + aspirationMs,
    auto_generated: true,
  };
}

export function segmentVoicingStartSmp(phone: SegmentAnchor): number | undefined {
  if (nasalPoseIpa(phone.ipa) !== phone.ipa) {
    return phone.start_smp + Math.floor((phone.end_smp - phone.start_smp) * 0.72);
  }
  const timing = phone.stop_timing;
  if (phone.voiced && timing && timing.vot_ms < 0) {
    return Math.min(phone.end_smp, phone.start_smp + msToSamples(timing.closure_ms + timing.vot_ms));
  }
}

export function isSegmentVoicedAt(phone: SegmentAnchor, sample: number): boolean {
  const start = segmentVoicingStartSmp(phone);
  return start === undefined ? phone.voiced : sample >= start;
}
