import { SAMPLE_RATE_HZ, msToSamples, type Clip, type F0PinSegment, type PhonationAnchor, type RetimeResult, type SegmentAnchor, type Syllable, type VcProject } from '@vocalcut/core';

const BRACKETED_IPA_RE = /^([\[［])(.*)([\]］])$/u;
const LEADING_PROSODY_RE = /^([ˈˌꜛꜜ]+)/u;
const TRAILING_TONE_RE = /((?:[˥˦˧˨˩꜒꜓꜔꜕꜖⁰¹²³⁴⁵⁶⁷⁸⁹0-5]+)?(?:\([˥˦˧˨˩꜒꜓꜔꜕꜖⁰¹²³⁴⁵⁶⁷⁸⁹0-5]+\))?‿?)$/u;

/**
 * Synchronize `syllable.ipa` with `syllable.segments` and, when `syllable.text` is an
 * IPA syllable label (bracketed `[tʂʰɑu˧˥]` or bare IPA matching the prior segments),
 * update the segmental body while preserving brackets, stress marks, and tone letters.
 * Orthographic words (`潮`, `Hello`, `今日`) keep their written text intact.
 */
export function syncSyllableTextFromSegments(
  syllable: Syllable,
  previousSegmentsIpa?: readonly string[],
): void {
  syllable.ipa = syllable.segments.map((s) => s.ipa);
  const newBody = syllable.segments
    .filter((s) => s.role !== 'rest' && s.ipa !== 'sil')
    .map((s) => s.ipa)
    .join('');
  const trimmed = (syllable.text ?? '').trim();
  if (!trimmed) return;

  const bracketed = BRACKETED_IPA_RE.exec(trimmed);
  if (bracketed) {
    const [, open, inner, close] = bracketed;
    const cleanInner = inner.trim();
    const lead = LEADING_PROSODY_RE.exec(cleanInner)?.[1] ?? '';
    const afterLead = cleanInner.slice(lead.length);
    const trail = TRAILING_TONE_RE.exec(afterLead)?.[1] ?? '';
    syllable.text = `${open}${lead}${newBody || 'sil'}${trail}${close}`;
    return;
  }

  const prevBody = (previousSegmentsIpa ?? []).filter((p) => p && p !== 'sil').join('');
  if (prevBody) {
    const lead = LEADING_PROSODY_RE.exec(trimmed)?.[1] ?? '';
    const afterLead = trimmed.slice(lead.length);
    const trail = TRAILING_TONE_RE.exec(afterLead)?.[1] ?? '';
    const core = afterLead.slice(0, afterLead.length - trail.length).trim();
    if (core === prevBody) {
      syllable.text = `${lead}${newBody || 'sil'}${trail}`;
    }
  }
}

function cloneSegmentGeometry(phone: SegmentAnchor): Pick<SegmentAnchor, 'params' | 'tongue_shape' | 'lip_shape'> {
  return {
    ...(phone.params ? { params: [...phone.params] } : {}),
    ...(phone.tongue_shape ? { tongue_shape: [...phone.tongue_shape] } : {}),
    ...(phone.lip_shape ? { lip_shape: [...phone.lip_shape] } : {}),
  };
}

export function splitAnnotationPhone(syllable: Syllable, index: number, splitSmp: number, rightId: string): Syllable | null {
  const phone = syllable.segments[index];
  if (!phone || phone.stop_timing || !Number.isInteger(splitSmp)
    || splitSmp <= phone.start_smp || splitSmp >= phone.end_smp) return null;
  const left = { ...phone, ...cloneSegmentGeometry(phone), end_smp: splitSmp };
  const right = { ...phone, ...cloneSegmentGeometry(phone), id: rightId, start_smp: splitSmp };
  const segments = [...syllable.segments.slice(0, index), left, right, ...syllable.segments.slice(index + 1)];
  const poses = syllable.overrides.poses.flatMap((pose) => {
    if (pose.seg_index > index) return [{ ...pose, seg_index: pose.seg_index + 1 }];
    if (pose.seg_index !== index) return [pose];
    return [pose, { ...pose, seg_index: index + 1, seg_id: rightId }];
  });
  const prevIpa = syllable.segments.map((s) => s.ipa);
  const nextSyl: Syllable = {
    ...syllable,
    ipa: segments.map((segment) => segment.ipa),
    segments,
    nucleus_index: syllable.nucleus_index > index ? syllable.nucleus_index + 1 : syllable.nucleus_index,
    overrides: { ...syllable.overrides, poses },
  };
  syncSyllableTextFromSegments(nextSyl, prevIpa);
  return nextSyl;
}

export function insertAnnotationSegment(
  clip: Clip,
  syllableId: string,
  index: number,
  segment: SegmentAnchor,
  controls: Pick<VcProject, 'phonation_anchors' | 'f0_pins'>,
): RetimeResult {
  const syllable = clip.syllables[syllableId];
  if (!syllable) {
    return {
      clip,
      phonation_anchors: { ...controls.phonation_anchors },
      f0_pins: [...(controls.f0_pins ?? [])],
      mappings: [],
      warnings: [`未找到音节 ${syllableId}`],
    };
  }
  const at = segment.start_smp;
  const duration = segment.end_smp - at;
  const syllables = { ...clip.syllables };
  const position = clip.syllable_order.indexOf(syllableId);
  const shift = (sample: number) => sample + duration;
  const shiftSpan = <T extends { start_smp: number; end_smp: number }>(span: T): T => ({
    ...span, start_smp: shift(span.start_smp), end_smp: shift(span.end_smp),
  });
  const segments = [...syllable.segments.slice(0, index), segment, ...syllable.segments.slice(index).map(shiftSpan)];
  const prevIpa = syllable.segments.map((phone) => phone.ipa);
  const nextSyl: Syllable = {
    ...syllable,
    end_smp: shift(syllable.end_smp),
    ipa: segments.map((phone) => phone.ipa),
    segments,
    nucleus_index: syllable.nucleus_index + (syllable.segments.length && index <= syllable.nucleus_index ? 1 : 0),
    targets: syllable.targets.map((target) => {
      const nextStart = target.start_smp > at ? shift(target.start_smp) : target.start_smp;
      const nextEnd = target.end_smp > at || (target.end_smp === at && at === syllable.end_smp) ? shift(target.end_smp) : target.end_smp;
      const oldDur = Math.max(1, target.end_smp - target.start_smp);
      const newDur = Math.max(1, nextEnd - nextStart);
      if (newDur === oldDur) {
        return { ...target, start_smp: nextStart, end_smp: nextEnd };
      }
      const scaleSlope = oldDur / newDur;
      const rescale = <T extends { m_st_per_s: number } | undefined>(cand: T): T =>
        cand ? { ...cand, m_st_per_s: Number((cand.m_st_per_s * scaleSlope).toFixed(3)) } : cand;
      return {
        ...target,
        start_smp: nextStart,
        end_smp: nextEnd,
        candidates: {
          ...target.candidates,
          default: rescale(target.candidates.default) ?? target.candidates.default,
          user: rescale(target.candidates.user),
          transfer: rescale(target.candidates.transfer),
          score: rescale(target.candidates.score),
        },
      };
    }),
    overrides: {
      ...syllable.overrides,
      poses: syllable.overrides.poses.map((pose) => pose.seg_index >= index ? { ...pose, seg_index: pose.seg_index + 1 } : pose),
    },
  };
  syncSyllableTextFromSegments(nextSyl, prevIpa);
  syllables[syllableId] = nextSyl;
  for (const id of clip.syllable_order.slice(position + 1)) {
    const next = syllables[id];
    syllables[id] = { ...shiftSpan(next), segments: next.segments.map(shiftSpan), targets: next.targets.map(shiftSpan) };
  }
  const phonation_anchors = Object.fromEntries(Object.entries(controls.phonation_anchors).map(([id, anchor]) => [
    id,
    anchor.t_smp > at || (anchor.t_smp === at && anchor.syllable_id !== undefined && anchor.syllable_id !== syllableId)
      ? { ...anchor, t_smp: shift(anchor.t_smp) } : anchor,
  ]));
  const f0_pins = (controls.f0_pins ?? []).map((pin) => pin.end_smp <= at ? pin : ({
    ...pin,
    start_smp: pin.start_smp >= at ? shift(pin.start_smp) : pin.start_smp,
    end_smp: shift(pin.end_smp),
    points: pin.points.map((point) => point.t_smp >= at ? { ...point, t_smp: shift(point.t_smp) } : point),
  }));
  return { clip: { ...clip, end_smp: shift(clip.end_smp), syllables }, phonation_anchors, f0_pins, mappings: [], warnings: [] };
}

/**
 * Delete one or more selected phoneme segments from `clip`, closing time gaps smoothly,
 * remapping poses/targets/phonation anchors/F0 pins, removing any syllable left with 0 segments,
 * and syncing IPA syllable text labels. Returns `null` if deleting would leave 0 segments total.
 */
export function deleteAnnotationSegments(
  clip: Clip,
  phoneIds: readonly string[],
  controls: Pick<VcProject, 'phonation_anchors' | 'f0_pins'>,
): (RetimeResult & { deletedCount: number; nextFocusPhoneId?: string; nextFocusSyllableId?: string }) | null {
  const dropSet = new Set(phoneIds);
  if (dropSet.size === 0) return null;

  let totalPhones = 0;
  let matchingPhones = 0;
  for (const sid of clip.syllable_order) {
    const syl = clip.syllables[sid];
    if (!syl) continue;
    for (const seg of syl.segments) {
      totalPhones++;
      if (dropSet.has(seg.id)) matchingPhones++;
    }
  }
  if (matchingPhones === 0 || matchingPhones >= totalPhones) return null;

  const removedRanges: Array<{ start: number; end: number }> = [];
  for (const sid of clip.syllable_order) {
    const syl = clip.syllables[sid];
    if (!syl) continue;
    for (const seg of syl.segments) {
      if (dropSet.has(seg.id) && seg.end_smp > seg.start_smp) {
        removedRanges.push({ start: seg.start_smp, end: seg.end_smp });
      }
    }
  }
  removedRanges.sort((a, b) => a.start - b.start);
  const mergedRanges: Array<{ start: number; end: number }> = [];
  for (const r of removedRanges) {
    const prev = mergedRanges[mergedRanges.length - 1];
    if (prev && r.start <= prev.end) prev.end = Math.max(prev.end, r.end);
    else mergedRanges.push({ ...r });
  }

  const totalRemoved = mergedRanges.reduce((sum, r) => sum + (r.end - r.start), 0);
  const isInsideRemoved = (smp: number) => mergedRanges.some((r) => smp >= r.start && smp < r.end);
  const shiftLeft = (smp: number): number => {
    let shift = 0;
    for (const r of mergedRanges) {
      if (smp >= r.end) shift += r.end - r.start;
      else if (smp > r.start) shift += smp - r.start;
    }
    return Math.max(clip.start_smp, smp - shift);
  };

  const nextOrder: string[] = [];
  const nextSyllables: Record<string, Syllable> = {};
  let nextFocusPhoneId: string | undefined;
  let nextFocusSyllableId: string | undefined;
  let sawDrop = false;

  for (const sid of clip.syllable_order) {
    const syl = clip.syllables[sid];
    if (!syl) continue;
    const prevIpa = syl.segments.map((s) => s.ipa);
    const indexMap = new Map<number, number>();
    const keptSegments: SegmentAnchor[] = [];
    syl.segments.forEach((seg, oldIdx) => {
      if (dropSet.has(seg.id)) {
        sawDrop = true;
        return;
      }
      const newIdx = keptSegments.length;
      indexMap.set(oldIdx, newIdx);
      const nextSeg: SegmentAnchor = {
        ...seg,
        ...cloneSegmentGeometry(seg),
        start_smp: shiftLeft(seg.start_smp),
        end_smp: shiftLeft(seg.end_smp),
      };
      keptSegments.push(nextSeg);
      if (sawDrop && !nextFocusPhoneId) {
        nextFocusPhoneId = nextSeg.id;
        nextFocusSyllableId = sid;
      }
    });
    if (keptSegments.length === 0) continue;

    const sylStart = keptSegments[0].start_smp;
    const sylEnd = Math.max(sylStart + 1, keptSegments[keptSegments.length - 1].end_smp);
    const oldDur = Math.max(1, syl.end_smp - syl.start_smp);
    const newDur = Math.max(1, sylEnd - sylStart);
    const scaleSlope = oldDur / newDur;

    const nextTargets = syl.targets.map((target) => {
      const t0 = Math.max(sylStart, Math.min(sylEnd - 1, shiftLeft(target.start_smp)));
      const t1 = Math.max(t0 + 1, Math.min(sylEnd, shiftLeft(target.end_smp)));
      if (t1 - t0 === target.end_smp - target.start_smp) {
        return { ...target, start_smp: t0, end_smp: t1 };
      }
      const rescale = <T extends { m_st_per_s: number } | undefined>(cand: T): T =>
        cand ? { ...cand, m_st_per_s: Number((cand.m_st_per_s * scaleSlope).toFixed(3)) } : cand;
      return {
        ...target,
        start_smp: t0,
        end_smp: t1,
        candidates: {
          ...target.candidates,
          default: rescale(target.candidates.default) ?? target.candidates.default,
          user: rescale(target.candidates.user),
          transfer: rescale(target.candidates.transfer),
          score: rescale(target.candidates.score),
        },
      };
    });

    const nextPoses = (syl.overrides?.poses ?? []).flatMap((pose) => {
      if (pose.seg_id && dropSet.has(pose.seg_id)) return [];
      const mappedIdx = pose.seg_id
        ? keptSegments.findIndex((s) => s.id === pose.seg_id)
        : indexMap.get(pose.seg_index);
      if (mappedIdx === undefined || mappedIdx < 0) return [];
      return [{ ...pose, seg_index: mappedIdx, seg_id: keptSegments[mappedIdx].id }];
    });

    const nucIdx = keptSegments.findIndex((s) => s.role === 'nucleus');
    const nextSyl: Syllable = {
      ...syl,
      start_smp: sylStart,
      end_smp: sylEnd,
      segments: keptSegments,
      ipa: keptSegments.map((s) => s.ipa),
      nucleus_index: nucIdx >= 0 ? nucIdx : 0,
      targets: nextTargets,
      overrides: {
        ...syl.overrides,
        poses: nextPoses,
      },
    };
    syncSyllableTextFromSegments(nextSyl, prevIpa);
    nextOrder.push(sid);
    nextSyllables[sid] = nextSyl;
  }

  if (!nextFocusPhoneId && nextOrder.length > 0) {
    const lastSid = nextOrder[nextOrder.length - 1];
    const lastSyl = nextSyllables[lastSid];
    nextFocusSyllableId = lastSid;
    nextFocusPhoneId = lastSyl?.segments.at(-1)?.id;
  }

  const nextEndSmp = Math.max(clip.start_smp + 1, clip.end_smp - totalRemoved);
  const phonation_anchors = Object.fromEntries(
    Object.entries(controls.phonation_anchors).flatMap(([id, anchor]) => {
      if (isInsideRemoved(anchor.t_smp)) return [];
      return [[id, { ...anchor, t_smp: Math.min(nextEndSmp, shiftLeft(anchor.t_smp)) }]];
    }),
  );
  const f0_pins = (controls.f0_pins ?? []).flatMap((pin) => {
    const pts = pin.points
      .filter((pt) => !isInsideRemoved(pt.t_smp))
      .map((pt) => ({ ...pt, t_smp: Math.min(nextEndSmp, shiftLeft(pt.t_smp)) }));
    const dedup: typeof pts = [];
    for (const pt of pts) {
      const prev = dedup[dedup.length - 1];
      if (prev && prev.t_smp === pt.t_smp) dedup[dedup.length - 1] = pt;
      else dedup.push(pt);
    }
    if (dedup.length < 2) return [];
    return [{
      ...pin,
      start_smp: dedup[0].t_smp,
      end_smp: Math.max(dedup[0].t_smp + 1, dedup[dedup.length - 1].t_smp),
      points: dedup,
    }];
  });

  return {
    clip: {
      ...clip,
      end_smp: nextEndSmp,
      syllable_order: nextOrder,
      syllables: nextSyllables,
    },
    phonation_anchors,
    f0_pins,
    mappings: [],
    warnings: [],
    deletedCount: matchingPhones,
    nextFocusPhoneId,
    nextFocusSyllableId,
  };
}

/**
 * Resize an empty silence gap `[gapStartSmp, gapEndSmp)` (leading, inter-syllable, or trailing)
 * to `newDurationSmp` (>= 0) by ripple-shifting all subsequent syllables, segments, targets,
 * phonation anchors, and F0 pins without altering the duration of any preceding or following syllable.
 */
export function resizeAnnotationSilenceGap(
  clip: Clip,
  gapStartSmp: number,
  gapEndSmp: number,
  newDurationSmp: number,
  controls: Pick<VcProject, 'phonation_anchors' | 'f0_pins'>,
): RetimeResult {
  const safeStart = Math.max(clip.start_smp, Math.round(gapStartSmp));
  const safeEnd = Math.max(safeStart, Math.round(gapEndSmp));
  const targetDur = Math.max(0, Math.round(newDurationSmp));
  const origDur = safeEnd - safeStart;
  const delta = targetDur - origDur;

  if (delta === 0) {
    return {
      clip,
      phonation_anchors: { ...controls.phonation_anchors },
      f0_pins: [...(controls.f0_pins ?? [])],
      mappings: [],
      warnings: [],
    };
  }

  const mapTime = (smp: number): number => {
    if (smp <= safeStart) return smp;
    if (smp >= safeEnd) return Math.max(safeStart + targetDur, smp + delta);
    if (origDur <= 0) return safeStart + targetDur;
    const u = (smp - safeStart) / origDur;
    return Math.round(safeStart + u * targetDur);
  };

  const shiftSpan = <T extends { start_smp: number; end_smp: number }>(span: T): T => ({
    ...span,
    start_smp: span.start_smp + delta,
    end_smp: span.end_smp + delta,
  });

  const nextSyllables: Record<string, Syllable> = {};
  for (const sid of clip.syllable_order) {
    const syl = clip.syllables[sid];
    if (!syl) continue;
    if (syl.start_smp >= safeEnd) {
      nextSyllables[sid] = {
        ...shiftSpan(syl),
        segments: syl.segments.map((seg) => ({
          ...seg,
          ...cloneSegmentGeometry(seg),
          start_smp: seg.start_smp + delta,
          end_smp: seg.end_smp + delta,
        })),
        targets: syl.targets.map(shiftSpan),
      };
    } else {
      nextSyllables[sid] = syl;
    }
  }

  const nextEndSmp = Math.max(clip.start_smp + 1, clip.end_smp + delta);
  const phonation_anchors = Object.fromEntries(
    Object.entries(controls.phonation_anchors).map(([id, anchor]) => [
      id,
      { ...anchor, t_smp: Math.max(clip.start_smp, Math.min(nextEndSmp, mapTime(anchor.t_smp))) },
    ]),
  );

  const f0_pins = (controls.f0_pins ?? []).flatMap((pin) => {
    const pts = pin.points.map((pt) => ({
      ...pt,
      t_smp: Math.max(clip.start_smp, Math.min(nextEndSmp, mapTime(pt.t_smp))),
    }));
    const dedup: typeof pts = [];
    for (const pt of pts) {
      const prev = dedup[dedup.length - 1];
      if (prev && prev.t_smp === pt.t_smp) dedup[dedup.length - 1] = pt;
      else dedup.push(pt);
    }
    if (dedup.length < 2) return [];
    return [{
      ...pin,
      start_smp: dedup[0].t_smp,
      end_smp: Math.max(dedup[0].t_smp + 1, dedup[dedup.length - 1].t_smp),
      points: dedup,
    }];
  });

  return {
    clip: {
      ...clip,
      end_smp: nextEndSmp,
      syllables: nextSyllables,
    },
    phonation_anchors,
    f0_pins,
    mappings: [],
    warnings: [],
  };
}

export interface SlideBoundsSmp {
  minDelta: number;
  maxDelta: number;
}

function isRestSegment(seg: SegmentAnchor): boolean {
  return seg.role === 'rest' || seg.ipa === 'sil';
}

function orderedSyllables(clip: Clip): Syllable[] {
  return clip.syllable_order
    .map((id) => clip.syllables[id])
    .filter((s): s is Syllable => Boolean(s))
    .sort((a, b) => a.start_smp - b.start_smp);
}

/**
 * Compute horizontal slide bounds `[minDelta, maxDelta]` (in samples) for a contiguous
 * selection of syllables moving purely inside adjacent silence gaps without altering
 * any syllable's duration or pushing neighbors. Returns `null` if non-contiguous or immobile.
 */
export function getSyllableSlideBounds(clip: Clip, syllableIds: readonly string[]): SlideBoundsSmp | null {
  if (!syllableIds.length) return null;
  const ordered = orderedSyllables(clip);
  const pickedSet = new Set(syllableIds);
  const indices: number[] = [];
  ordered.forEach((syl, idx) => {
    if (pickedSet.has(syl.id)) indices.push(idx);
  });
  if (!indices.length) return null;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1] + 1) return null;
  }
  const firstIdx = indices[0];
  const lastIdx = indices[indices.length - 1];
  const leftLimit = firstIdx > 0 ? ordered[firstIdx - 1].end_smp : clip.start_smp;
  const rightLimit = lastIdx < ordered.length - 1 ? ordered[lastIdx + 1].start_smp : clip.end_smp;
  const minDelta = Math.min(0, leftLimit - ordered[firstIdx].start_smp);
  const maxDelta = Math.max(0, rightLimit - ordered[lastIdx].end_smp);
  if (minDelta === 0 && maxDelta === 0) return null;
  return { minDelta, maxDelta };
}

function shiftRangeControls(
  clip: Clip,
  rangeStart: number,
  rangeEnd: number,
  delta: number,
  controls: Pick<VcProject, 'phonation_anchors' | 'f0_pins'>,
): Pick<RetimeResult, 'phonation_anchors' | 'f0_pins'> {
  const clampClip = (t: number) => Math.max(clip.start_smp, Math.min(clip.end_smp, t));
  const mapPoint = (t: number) => (t >= rangeStart && t <= rangeEnd ? clampClip(t + delta) : t);
  const phonation_anchors = Object.fromEntries(
    Object.entries(controls.phonation_anchors).map(([id, anchor]) => [
      id,
      { ...anchor, t_smp: mapPoint(anchor.t_smp) },
    ]),
  );
  const f0_pins = (controls.f0_pins ?? []).flatMap((pin) => {
    const pts = pin.points
      .map((pt) => ({ ...pt, t_smp: mapPoint(pt.t_smp) }))
      .sort((a, b) => a.t_smp - b.t_smp);
    const dedup: typeof pts = [];
    for (const pt of pts) {
      const prev = dedup[dedup.length - 1];
      if (prev && prev.t_smp === pt.t_smp) dedup[dedup.length - 1] = pt;
      else dedup.push(pt);
    }
    if (dedup.length < 2) return [];
    return [{
      ...pin,
      start_smp: dedup[0].t_smp,
      end_smp: Math.max(dedup[0].t_smp + 1, dedup[dedup.length - 1].t_smp),
      points: dedup,
    }];
  });
  return { phonation_anchors, f0_pins };
}

/**
 * Slide one or more contiguous syllables horizontally by `deltaSmp` inside adjacent silence gaps,
 * keeping every syllable's duration and all neighboring syllables' positions invariant.
 */
export function slideAnnotationSyllables(
  clip: Clip,
  syllableIds: readonly string[],
  deltaSmp: number,
  controls: Pick<VcProject, 'phonation_anchors' | 'f0_pins'>,
): RetimeResult | null {
  const bounds = getSyllableSlideBounds(clip, syllableIds);
  if (!bounds) return null;
  const delta = Math.round(Math.max(bounds.minDelta, Math.min(bounds.maxDelta, deltaSmp)));
  if (delta === 0) return null;

  const pickedSet = new Set(syllableIds);
  const pickedSyls = orderedSyllables(clip).filter((s) => pickedSet.has(s.id));
  const rangeStart = pickedSyls[0].start_smp;
  const rangeEnd = pickedSyls[pickedSyls.length - 1].end_smp;

  const shiftSpan = <T extends { start_smp: number; end_smp: number }>(span: T): T => ({
    ...span,
    start_smp: span.start_smp + delta,
    end_smp: span.end_smp + delta,
  });

  const nextSyllables: Record<string, Syllable> = {};
  for (const sid of clip.syllable_order) {
    const syl = clip.syllables[sid];
    if (!syl) continue;
    if (pickedSet.has(sid)) {
      nextSyllables[sid] = {
        ...shiftSpan(syl),
        segments: syl.segments.map((seg) => ({
          ...seg,
          ...cloneSegmentGeometry(seg),
          start_smp: seg.start_smp + delta,
          end_smp: seg.end_smp + delta,
        })),
        targets: syl.targets.map(shiftSpan),
      };
    } else {
      nextSyllables[sid] = syl;
    }
  }

  const { phonation_anchors, f0_pins } = shiftRangeControls(clip, rangeStart, rangeEnd, delta, controls);
  return {
    clip: { ...clip, syllables: nextSyllables },
    phonation_anchors,
    f0_pins,
    mappings: [],
    warnings: [],
  };
}

interface PhoneSliceMatch {
  mode: 'syllables';
  syllableIds: string[];
  bounds: SlideBoundsSmp;
}
interface SingleSylPhoneSliceMatch {
  mode: 'phones';
  syllableId: string;
  firstIdx: number;
  lastIdx: number;
  leftRestIdx: number | null;
  rightRestIdx: number | null;
  bounds: SlideBoundsSmp;
}

function resolvePhoneSlideMatch(
  clip: Clip,
  phoneIds: readonly string[],
): PhoneSliceMatch | SingleSylPhoneSliceMatch | null {
  if (!phoneIds.length) return null;
  const pickedSet = new Set(phoneIds);
  const ordered = orderedSyllables(clip);
  const touched: Array<{ sylIdx: number; syl: Syllable; segIndices: number[] }> = [];

  ordered.forEach((syl, sylIdx) => {
    const segIndices: number[] = [];
    syl.segments.forEach((seg, sIdx) => {
      if (pickedSet.has(seg.id)) segIndices.push(sIdx);
    });
    if (segIndices.length) touched.push({ sylIdx, syl, segIndices });
  });
  if (!touched.length) return null;

  // If selection covers complete syllable(s) (including single-phoneme syllables), delegate to syllable sliding.
  if (touched.every((t) => t.segIndices.length === t.syl.segments.length)) {
    const syllableIds = touched.map((t) => t.syl.id);
    const bounds = getSyllableSlideBounds(clip, syllableIds);
    return bounds ? { mode: 'syllables', syllableIds, bounds } : null;
  }

  // Sub-syllable sliding requires a contiguous slice within one syllable.
  if (touched.length !== 1) return null;
  const { sylIdx, syl, segIndices } = touched[0];
  for (let i = 1; i < segIndices.length; i++) {
    if (segIndices[i] !== segIndices[i - 1] + 1) return null;
  }
  const firstIdx = segIndices[0];
  const lastIdx = segIndices[segIndices.length - 1];
  const firstSeg = syl.segments[firstIdx];
  const lastSeg = syl.segments[lastIdx];

  let leftLimit: number;
  let leftRestIdx: number | null = null;
  if (firstIdx > 0) {
    const prevSeg = syl.segments[firstIdx - 1];
    if (isRestSegment(prevSeg)) {
      leftLimit = prevSeg.start_smp;
      leftRestIdx = firstIdx - 1;
    } else {
      leftLimit = prevSeg.end_smp;
    }
  } else {
    leftLimit = sylIdx > 0 ? ordered[sylIdx - 1].end_smp : clip.start_smp;
  }

  let rightLimit: number;
  let rightRestIdx: number | null = null;
  if (lastIdx < syl.segments.length - 1) {
    const nextSeg = syl.segments[lastIdx + 1];
    if (isRestSegment(nextSeg)) {
      rightLimit = nextSeg.end_smp;
      rightRestIdx = lastIdx + 1;
    } else {
      rightLimit = nextSeg.start_smp;
    }
  } else {
    rightLimit = sylIdx < ordered.length - 1 ? ordered[sylIdx + 1].start_smp : clip.end_smp;
  }

  const minDelta = Math.min(0, leftLimit - firstSeg.start_smp);
  const maxDelta = Math.max(0, rightLimit - lastSeg.end_smp);
  if (minDelta === 0 && maxDelta === 0) return null;

  return {
    mode: 'phones',
    syllableId: syl.id,
    firstIdx,
    lastIdx,
    leftRestIdx,
    rightRestIdx,
    bounds: { minDelta, maxDelta },
  };
}

/**
 * Compute horizontal slide bounds `[minDelta, maxDelta]` (in samples) for a selected phoneme
 * or contiguous phoneme group moving into adjacent silence gaps (or adjacent `sil` rest segments).
 */
export function getPhoneSlideBounds(clip: Clip, phoneIds: readonly string[]): SlideBoundsSmp | null {
  return resolvePhoneSlideMatch(clip, phoneIds)?.bounds ?? null;
}

/**
 * Slide a selected phoneme (or contiguous group of phonemes) horizontally by `deltaSmp`
 * into adjacent silence gaps without changing the phoneme's own duration.
 */
export function slideAnnotationPhones(
  clip: Clip,
  phoneIds: readonly string[],
  deltaSmp: number,
  controls: Pick<VcProject, 'phonation_anchors' | 'f0_pins'>,
): RetimeResult | null {
  const match = resolvePhoneSlideMatch(clip, phoneIds);
  if (!match) return null;
  if (match.mode === 'syllables') {
    return slideAnnotationSyllables(clip, match.syllableIds, deltaSmp, controls);
  }
  const delta = Math.round(Math.max(match.bounds.minDelta, Math.min(match.bounds.maxDelta, deltaSmp)));
  if (delta === 0) return null;

  const syl = clip.syllables[match.syllableId];
  if (!syl) return null;
  const rangeStart = syl.segments[match.firstIdx].start_smp;
  const rangeEnd = syl.segments[match.lastIdx].end_smp;

  const updatedSegments: SegmentAnchor[] = [];
  const indexMap = new Map<number, number>();
  syl.segments.forEach((seg, idx) => {
    let nextSeg: SegmentAnchor = { ...seg, ...cloneSegmentGeometry(seg) };
    if (idx >= match.firstIdx && idx <= match.lastIdx) {
      nextSeg = { ...nextSeg, start_smp: seg.start_smp + delta, end_smp: seg.end_smp + delta };
    } else if (idx === match.leftRestIdx && delta < 0) {
      const trimmedEnd = syl.segments[match.firstIdx].start_smp + delta;
      if (trimmedEnd <= seg.start_smp) return;
      nextSeg = { ...nextSeg, end_smp: trimmedEnd };
    } else if (idx === match.rightRestIdx && delta > 0) {
      const trimmedStart = syl.segments[match.lastIdx].end_smp + delta;
      if (trimmedStart >= seg.end_smp) return;
      nextSeg = { ...nextSeg, start_smp: trimmedStart };
    }
    indexMap.set(idx, updatedSegments.length);
    updatedSegments.push(nextSeg);
  });

  if (!updatedSegments.length) return null;
  const newSylStart = updatedSegments[0].start_smp;
  const newSylEnd = updatedSegments[updatedSegments.length - 1].end_smp;
  const oldDur = Math.max(1, syl.end_smp - syl.start_smp);
  const newDur = Math.max(1, newSylEnd - newSylStart);
  const scaleSlope = oldDur / newDur;

  const nextTargets = syl.targets.map((target) => {
    const t0 = target.start_smp === syl.start_smp ? newSylStart : Math.max(newSylStart, Math.min(newSylEnd - 1, target.start_smp));
    const t1 = target.end_smp === syl.end_smp ? newSylEnd : Math.max(t0 + 1, Math.min(newSylEnd, target.end_smp));
    if (t1 - t0 === target.end_smp - target.start_smp) {
      return { ...target, start_smp: t0, end_smp: t1 };
    }
    const rescale = <T extends { m_st_per_s: number } | undefined>(cand: T): T =>
      cand ? { ...cand, m_st_per_s: Number((cand.m_st_per_s * scaleSlope).toFixed(3)) } : cand;
    return {
      ...target,
      start_smp: t0,
      end_smp: t1,
      candidates: {
        ...target.candidates,
        default: rescale(target.candidates.default) ?? target.candidates.default,
        user: rescale(target.candidates.user),
        transfer: rescale(target.candidates.transfer),
        score: rescale(target.candidates.score),
      },
    };
  });

  const nextPoses = (syl.overrides?.poses ?? []).flatMap((pose) => {
    const mappedIdx = pose.seg_id
      ? updatedSegments.findIndex((s) => s.id === pose.seg_id)
      : indexMap.get(pose.seg_index);
    if (mappedIdx === undefined || mappedIdx < 0) return [];
    return [{ ...pose, seg_index: mappedIdx, seg_id: updatedSegments[mappedIdx].id }];
  });

  const nucIdx = updatedSegments.findIndex((s) => s.role === 'nucleus');
  const nextSyl: Syllable = {
    ...syl,
    start_smp: newSylStart,
    end_smp: newSylEnd,
    segments: updatedSegments,
    ipa: updatedSegments.map((s) => s.ipa),
    nucleus_index: nucIdx >= 0 ? nucIdx : 0,
    targets: nextTargets,
    overrides: {
      ...syl.overrides,
      poses: nextPoses,
    },
  };

  const { phonation_anchors, f0_pins } = shiftRangeControls(clip, rangeStart, rangeEnd, delta, controls);
  return {
    clip: {
      ...clip,
      syllables: {
        ...clip.syllables,
        [syl.id]: nextSyl,
      },
    },
    phonation_anchors,
    f0_pins,
    mappings: [],
    warnings: [],
  };
}

export type AnnotationClipboardPayload =
  | {
      kind: 'syllables';
      syllables: Syllable[];
      totalDurationSmp: number;
      phonationAnchors: PhonationAnchor[];
      f0Pins: F0PinSegment[];
      summary: string;
    }
  | {
      kind: 'phones';
      segments: SegmentAnchor[];
      totalDurationSmp: number;
      phonationAnchors: PhonationAnchor[];
      f0Pins: F0PinSegment[];
      summary: string;
    };

function extractRelativeControls(
  origin: number,
  end: number,
  controls: Pick<VcProject, 'phonation_anchors' | 'f0_pins'>,
): { phonationAnchors: PhonationAnchor[]; f0Pins: F0PinSegment[] } {
  const phonationAnchors = Object.values(controls.phonation_anchors)
    .filter((a) => a.t_smp >= origin && a.t_smp <= end)
    .map((a) => ({ ...JSON.parse(JSON.stringify(a)) as PhonationAnchor, t_smp: a.t_smp - origin }));
  const f0Pins: F0PinSegment[] = [];
  for (const pin of controls.f0_pins ?? []) {
    const pts = pin.points
      .filter((pt) => pt.t_smp >= origin && pt.t_smp <= end)
      .map((pt) => ({ ...pt, t_smp: pt.t_smp - origin }));
    if (pts.length >= 2) {
      f0Pins.push({
        ...JSON.parse(JSON.stringify(pin)) as F0PinSegment,
        start_smp: pts[0].t_smp,
        end_smp: Math.max(pts[0].t_smp + 1, pts[pts.length - 1].t_smp),
        points: pts,
      });
    }
  }
  return { phonationAnchors, f0Pins };
}

/**
 * Copy the currently selected time range, phonemes, or syllables into a relative-timestamp
 * clipboard payload (preserving poses, stop timings, tones, silence gaps, VoQS anchors, and F0 pins).
 */
export function copyAnnotationSelection(
  clip: Clip,
  selection: {
    phoneIds?: readonly string[];
    syllableIds?: readonly string[];
    range?: { startSmp: number; endSmp: number } | null;
  },
  controls: Pick<VcProject, 'phonation_anchors' | 'f0_pins'>,
): AnnotationClipboardPayload | null {
  const ordered = orderedSyllables(clip);
  if (!ordered.length) return null;

  let chosenSyllables: Syllable[] = [];
  let chosenSegments: SegmentAnchor[] = [];

  if (selection.range && selection.range.endSmp > selection.range.startSmp) {
    const { startSmp, endSmp } = selection.range;
    const hitSyls = ordered.filter((s) => s.end_smp > startSmp && s.start_smp < endSmp);
    if (hitSyls.length === 1) {
      const hitSegs = hitSyls[0].segments.filter((seg) => seg.end_smp > startSmp && seg.start_smp < endSmp);
      if (hitSegs.length > 0 && hitSegs.length < hitSyls[0].segments.length) {
        chosenSegments = hitSegs;
      } else if (hitSegs.length > 0) {
        chosenSyllables = hitSyls;
      }
    } else if (hitSyls.length > 1) {
      chosenSyllables = hitSyls;
    }
  }

  if (!chosenSyllables.length && !chosenSegments.length && selection.phoneIds?.length) {
    const pSet = new Set(selection.phoneIds);
    const touched: Array<{ syl: Syllable; segs: SegmentAnchor[] }> = [];
    for (const syl of ordered) {
      const segs = syl.segments.filter((s) => pSet.has(s.id));
      if (segs.length) touched.push({ syl, segs });
    }
    if (touched.length && touched.every((t) => t.segs.length === t.syl.segments.length)) {
      chosenSyllables = touched.map((t) => t.syl);
    } else {
      chosenSegments = touched.flatMap((t) => t.segs);
    }
  }

  if (!chosenSyllables.length && !chosenSegments.length && selection.syllableIds?.length) {
    const sSet = new Set(selection.syllableIds);
    chosenSyllables = ordered.filter((s) => sSet.has(s.id));
  }

  if (chosenSyllables.length) {
    const origin = chosenSyllables[0].start_smp;
    const end = chosenSyllables[chosenSyllables.length - 1].end_smp;
    const totalDurationSmp = Math.max(1, end - origin);
    const relSyls = chosenSyllables.map((syl) => {
      const copy = JSON.parse(JSON.stringify(syl)) as Syllable;
      copy.start_smp -= origin;
      copy.end_smp -= origin;
      copy.segments = copy.segments.map((seg) => ({
        ...seg,
        start_smp: seg.start_smp - origin,
        end_smp: seg.end_smp - origin,
      }));
      copy.targets = copy.targets.map((tg) => ({
        ...tg,
        start_smp: tg.start_smp - origin,
        end_smp: tg.end_smp - origin,
      }));
      return copy;
    });
    const { phonationAnchors, f0Pins } = extractRelativeControls(origin, end, controls);
    const summary = relSyls.length === 1
      ? `1 个音节「${relSyls[0].text}」`
      : `${relSyls.length} 个音节`;
    return { kind: 'syllables', syllables: relSyls, totalDurationSmp, phonationAnchors, f0Pins, summary };
  }

  if (chosenSegments.length) {
    const origin = chosenSegments[0].start_smp;
    const end = chosenSegments[chosenSegments.length - 1].end_smp;
    const totalDurationSmp = Math.max(1, end - origin);
    const relSegs = chosenSegments.map((seg) => {
      const copy = JSON.parse(JSON.stringify(seg)) as SegmentAnchor;
      copy.start_smp -= origin;
      copy.end_smp -= origin;
      return copy;
    });
    const { phonationAnchors, f0Pins } = extractRelativeControls(origin, end, controls);
    const ipaText = relSegs.map((s) => s.ipa).join(' ');
    const summary = relSegs.length === 1
      ? `1 个音素 [${ipaText}]`
      : `${relSegs.length} 个音素 [${ipaText}]`;
    return { kind: 'phones', segments: relSegs, totalDurationSmp, phonationAnchors, f0Pins, summary };
  }

  return null;
}

/**
 * Paste a previously copied `AnnotationClipboardPayload` into `clip` at the active selection
 * or playhead position, generating unique IDs, shifting subsequent elements cleanly (dropping
 * into roomy silence gaps without pushing neighbors when pasting syllables in a gap), and
 * restoring relative VoQS anchors & F0 pins.
 */
export function pasteAnnotationClipboard(
  clip: Clip,
  payload: AnnotationClipboardPayload,
  target: { playheadSmp: number; afterPhoneId?: string; afterSyllableId?: string },
  controls: Pick<VcProject, 'phonation_anchors' | 'f0_pins'>,
  makeId: (prefix: string) => string = (prefix) => `${prefix}_${crypto.randomUUID()}`,
): (RetimeResult & { pastedSyllableIds: string[]; pastedPhoneIds: string[]; pasteEndSmp: number }) | null {
  const ordered = orderedSyllables(clip);
  const shiftSpan = <T extends { start_smp: number; end_smp: number }>(span: T, d: number): T => ({
    ...span,
    start_smp: span.start_smp + d,
    end_smp: span.end_smp + d,
  });

  if (payload.kind === 'phones') {
    if (!payload.segments.length) return null;
    let targetSyl: Syllable | undefined;
    let insertIdx = -1;

    if (target.afterPhoneId) {
      for (const syl of ordered) {
        const idx = syl.segments.findIndex((s) => s.id === target.afterPhoneId);
        if (idx >= 0) {
          targetSyl = syl;
          insertIdx = idx + 1;
          break;
        }
      }
    }
    if (!targetSyl) {
      const hit = ordered.find((s) => target.playheadSmp >= s.start_smp && target.playheadSmp <= s.end_smp);
      if (hit) {
        targetSyl = hit;
        const idx = hit.segments.findIndex((s) => (s.start_smp + s.end_smp) * 0.5 > target.playheadSmp);
        insertIdx = idx < 0 ? hit.segments.length : idx;
      }
    }

    // If playhead sits in a silence gap (or clip is empty), wrap pasted phones into a new IPA syllable!
    if (!targetSyl) {
      const ipaBody = payload.segments.filter((s) => s.role !== 'rest' && s.ipa !== 'sil').map((s) => s.ipa).join('');
      const synthetic: Syllable = {
        id: makeId('syl'),
        text: `[${ipaBody || 'sil'}]`,
        ipa: payload.segments.map((s) => s.ipa),
        nucleus_index: Math.max(0, payload.segments.findIndex((s) => s.role === 'nucleus')),
        start_smp: 0,
        end_smp: payload.totalDurationSmp,
        anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
        segments: payload.segments,
        targets: [],
        overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
      };
      return pasteAnnotationClipboard(
        clip,
        {
          kind: 'syllables',
          syllables: [synthetic],
          totalDurationSmp: payload.totalDurationSmp,
          phonationAnchors: payload.phonationAnchors,
          f0Pins: payload.f0Pins,
          summary: payload.summary,
        },
        { playheadSmp: target.playheadSmp },
        controls,
        makeId,
      );
    }

    const at = insertIdx === 0
      ? targetSyl.start_smp
      : (targetSyl.segments[insertIdx - 1]?.end_smp ?? targetSyl.end_smp);
    const delta = payload.totalDurationSmp;
    const clonedSegs = payload.segments.map((seg) => {
      const copy = JSON.parse(JSON.stringify(seg)) as SegmentAnchor;
      copy.id = makeId('seg');
      copy.start_smp = at + seg.start_smp;
      copy.end_smp = at + seg.end_smp;
      return copy;
    });
    const prevIpa = targetSyl.segments.map((s) => s.ipa);
    const nextSegments = [
      ...targetSyl.segments.slice(0, insertIdx),
      ...clonedSegs,
      ...targetSyl.segments.slice(insertIdx).map((s) => ({ ...s, ...cloneSegmentGeometry(s), start_smp: s.start_smp + delta, end_smp: s.end_smp + delta })),
    ];
    const oldDur = Math.max(1, targetSyl.end_smp - targetSyl.start_smp);
    const newSylEnd = targetSyl.end_smp + delta;
    const newDur = Math.max(1, newSylEnd - targetSyl.start_smp);
    const scaleSlope = oldDur / newDur;
    const nextTargets = targetSyl.targets.map((tg) => {
      const t0 = tg.start_smp > at ? tg.start_smp + delta : tg.start_smp;
      const t1 = tg.end_smp > at || (tg.end_smp === at && at === targetSyl!.end_smp) ? tg.end_smp + delta : tg.end_smp;
      if (t1 - t0 === tg.end_smp - tg.start_smp) return { ...tg, start_smp: t0, end_smp: t1 };
      const rescale = <T extends { m_st_per_s: number } | undefined>(cand: T): T =>
        cand ? { ...cand, m_st_per_s: Number((cand.m_st_per_s * scaleSlope).toFixed(3)) } : cand;
      return {
        ...tg,
        start_smp: t0,
        end_smp: t1,
        candidates: {
          ...tg.candidates,
          default: rescale(tg.candidates.default) ?? tg.candidates.default,
          user: rescale(tg.candidates.user),
          transfer: rescale(tg.candidates.transfer),
          score: rescale(tg.candidates.score),
        },
      };
    });
    const nextPoses = (targetSyl.overrides?.poses ?? []).map((pose) =>
      pose.seg_index >= insertIdx ? { ...pose, seg_index: pose.seg_index + clonedSegs.length } : pose,
    );
    const nucIdx = nextSegments.findIndex((s) => s.role === 'nucleus');
    const updatedTargetSyl: Syllable = {
      ...targetSyl,
      end_smp: newSylEnd,
      segments: nextSegments,
      ipa: nextSegments.map((s) => s.ipa),
      nucleus_index: nucIdx >= 0 ? nucIdx : 0,
      targets: nextTargets,
      overrides: { ...targetSyl.overrides, poses: nextPoses },
    };
    syncSyllableTextFromSegments(updatedTargetSyl, prevIpa);

    const nextSyllables: Record<string, Syllable> = {};
    for (const sid of clip.syllable_order) {
      const syl = clip.syllables[sid];
      if (!syl) continue;
      if (sid === targetSyl.id) {
        nextSyllables[sid] = updatedTargetSyl;
      } else if (syl.start_smp >= at) {
        nextSyllables[sid] = {
          ...shiftSpan(syl, delta),
          segments: syl.segments.map((s) => ({ ...s, ...cloneSegmentGeometry(s), start_smp: s.start_smp + delta, end_smp: s.end_smp + delta })),
          targets: syl.targets.map((tg) => shiftSpan(tg, delta)),
        };
      } else {
        nextSyllables[sid] = syl;
      }
    }

    const phonation_anchors: Record<string, PhonationAnchor> = Object.fromEntries(
      Object.entries(controls.phonation_anchors).map(([id, a]) => [
        id,
        a.t_smp > at ? { ...a, t_smp: a.t_smp + delta } : a,
      ]),
    );
    for (const a of payload.phonationAnchors) {
      const id = makeId('phon');
      phonation_anchors[id] = { ...JSON.parse(JSON.stringify(a)) as PhonationAnchor, id, t_smp: at + a.t_smp };
    }

    const f0_pins: F0PinSegment[] = (controls.f0_pins ?? []).map((pin) =>
      pin.end_smp <= at
        ? pin
        : {
            ...pin,
            start_smp: pin.start_smp >= at ? pin.start_smp + delta : pin.start_smp,
            end_smp: pin.end_smp + delta,
            points: pin.points.map((pt) => (pt.t_smp >= at ? { ...pt, t_smp: pt.t_smp + delta } : pt)),
          },
    );
    for (const pin of payload.f0Pins) {
      f0_pins.push({
        ...JSON.parse(JSON.stringify(pin)) as F0PinSegment,
        id: makeId('pin'),
        start_smp: at + pin.start_smp,
        end_smp: at + pin.end_smp,
        points: pin.points.map((pt) => ({ ...pt, t_smp: at + pt.t_smp })),
      });
    }

    return {
      clip: { ...clip, end_smp: Math.max(clip.end_smp + delta, at + delta), syllables: nextSyllables },
      phonation_anchors,
      f0_pins,
      mappings: [],
      warnings: [],
      pastedSyllableIds: [targetSyl.id],
      pastedPhoneIds: clonedSegs.map((s) => s.id),
      pasteEndSmp: at + delta,
    };
  }

  // payload.kind === 'syllables'
  if (!payload.syllables.length) return null;
  let insertAt = Math.max(clip.start_smp, Math.round(target.playheadSmp));
  let rippleFull = false;

  if (target.afterSyllableId && clip.syllables[target.afterSyllableId]) {
    insertAt = clip.syllables[target.afterSyllableId].end_smp;
    rippleFull = true;
  } else {
    const enclosing = ordered.find((s) => insertAt > s.start_smp && insertAt < s.end_smp);
    if (enclosing) {
      insertAt = enclosing.end_smp;
      rippleFull = true;
    }
  }

  const nextAfter = ordered.find((s) => s.start_smp >= insertAt);
  const shiftDelta = !nextAfter
    ? 0
    : rippleFull
      ? payload.totalDurationSmp
      : Math.max(0, insertAt + payload.totalDurationSmp - nextAfter.start_smp);

  const nextSyllables: Record<string, Syllable> = {};
  for (const sid of clip.syllable_order) {
    const syl = clip.syllables[sid];
    if (!syl) continue;
    if (shiftDelta > 0 && syl.start_smp >= insertAt) {
      nextSyllables[sid] = {
        ...shiftSpan(syl, shiftDelta),
        segments: syl.segments.map((s) => ({ ...s, ...cloneSegmentGeometry(s), start_smp: s.start_smp + shiftDelta, end_smp: s.end_smp + shiftDelta })),
        targets: syl.targets.map((tg) => shiftSpan(tg, shiftDelta)),
      };
    } else {
      nextSyllables[sid] = syl;
    }
  }

  const pastedSyllableIds: string[] = [];
  const pastedPhoneIds: string[] = [];
  for (const srcSyl of payload.syllables) {
    const newSylId = makeId('syl');
    const copy = JSON.parse(JSON.stringify(srcSyl)) as Syllable;
    copy.id = newSylId;
    copy.start_smp = insertAt + srcSyl.start_smp;
    copy.end_smp = insertAt + srcSyl.end_smp;
    const segIdMap = new Map<string, string>();
    copy.segments = copy.segments.map((seg, idx) => {
      const newSegId = makeId('seg');
      segIdMap.set(srcSyl.segments[idx].id, newSegId);
      pastedPhoneIds.push(newSegId);
      return {
        ...seg,
        id: newSegId,
        start_smp: insertAt + srcSyl.segments[idx].start_smp,
        end_smp: insertAt + srcSyl.segments[idx].end_smp,
      };
    });
    copy.targets = copy.targets.map((tg, idx) => ({
      ...tg,
      id: makeId('tgt'),
      span_id: newSylId,
      start_smp: insertAt + srcSyl.targets[idx].start_smp,
      end_smp: insertAt + srcSyl.targets[idx].end_smp,
    }));
    if (copy.overrides?.poses?.length) {
      copy.overrides.poses = copy.overrides.poses.map((pose) => ({
        ...pose,
        seg_id: pose.seg_id ? (segIdMap.get(pose.seg_id) ?? pose.seg_id) : pose.seg_id,
      }));
    }
    nextSyllables[newSylId] = copy;
    pastedSyllableIds.push(newSylId);
  }

  const nextOrder = Object.values(nextSyllables)
    .sort((a, b) => a.start_smp - b.start_smp)
    .map((s) => s.id);
  const pasteEndSmp = insertAt + payload.totalDurationSmp;
  const maxSylEnd = nextOrder.length ? nextSyllables[nextOrder[nextOrder.length - 1]].end_smp : pasteEndSmp;
  const nextEndSmp = Math.max(clip.end_smp + shiftDelta, maxSylEnd, pasteEndSmp);

  const phonation_anchors: Record<string, PhonationAnchor> = Object.fromEntries(
    Object.entries(controls.phonation_anchors).map(([id, a]) => [
      id,
      shiftDelta > 0 && a.t_smp >= insertAt ? { ...a, t_smp: a.t_smp + shiftDelta } : a,
    ]),
  );
  for (const a of payload.phonationAnchors) {
    const id = makeId('phon');
    phonation_anchors[id] = { ...JSON.parse(JSON.stringify(a)) as PhonationAnchor, id, t_smp: insertAt + a.t_smp };
  }

  const f0_pins: F0PinSegment[] = (controls.f0_pins ?? []).map((pin) =>
    shiftDelta === 0 || pin.end_smp <= insertAt
      ? pin
      : {
          ...pin,
          start_smp: pin.start_smp >= insertAt ? pin.start_smp + shiftDelta : pin.start_smp,
          end_smp: pin.end_smp + shiftDelta,
          points: pin.points.map((pt) => (pt.t_smp >= insertAt ? { ...pt, t_smp: pt.t_smp + shiftDelta } : pt)),
        },
  );
  for (const pin of payload.f0Pins) {
    f0_pins.push({
      ...JSON.parse(JSON.stringify(pin)) as F0PinSegment,
      id: makeId('pin'),
      start_smp: insertAt + pin.start_smp,
      end_smp: insertAt + pin.end_smp,
      points: pin.points.map((pt) => ({ ...pt, t_smp: insertAt + pt.t_smp })),
    });
  }

  return {
    clip: { ...clip, end_smp: nextEndSmp, syllable_order: nextOrder, syllables: nextSyllables },
    phonation_anchors,
    f0_pins,
    mappings: [],
    warnings: [],
    pastedSyllableIds,
    pastedPhoneIds,
    pasteEndSmp,
  };
}

export function stopPhaseBoundaries(phone: SegmentAnchor) {
  const timing = phone.stop_timing;
  if (!timing) return null;
  const releaseStart = Math.min(phone.end_smp, phone.start_smp + msToSamples(timing.closure_ms));
  const releaseEnd = Math.min(phone.end_smp, releaseStart + msToSamples(timing.release_ms));
  return { releaseStart, releaseEnd };
}

export interface AnnotationTractFrame {
  u: number;
  params: number[];
}

export function withImportedTractFrames(clip: Clip, track: readonly AnnotationTractFrame[]): Clip {
  if (!track.length) return clip;
  const duration = Math.max(1, clip.end_smp - clip.start_smp);
  const syllables = { ...clip.syllables };
  for (const id of clip.syllable_order) {
    const syllable = syllables[id];
    syllables[id] = {
      ...syllable,
      segments: syllable.segments.map((phone) => {
        const midpoint = (phone.start_smp + phone.end_smp) / 2;
        const pose = trackFrameAt(track, (midpoint - clip.start_smp) / duration);
        return pose ? { ...phone, params: [...pose.params] } : phone;
      }),
    };
  }
  return { ...clip, syllables };
}

export function trackFrameAt(track: readonly AnnotationTractFrame[], u: number): AnnotationTractFrame | undefined {
  return frameInTrack(track, u, false);
}

export function interpolateTrackFrame(track: readonly AnnotationTractFrame[], u: number): AnnotationTractFrame | undefined {
  return frameInTrack(track, u, true);
}

function frameInTrack(track: readonly AnnotationTractFrame[], u: number, interpolate: boolean): AnnotationTractFrame | undefined {
  let low = 0;
  let high = track.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (track[middle].u < u) low = middle + 1;
    else high = middle;
  }
  const a = track[low - 1];
  const b = track[low];
  if (!a || !b) return a ?? b;
  if (!interpolate || b.u <= a.u) return u - a.u <= b.u - u ? a : b;
  const f = (u - a.u) / (b.u - a.u);
  return { u, params: a.params.map((value, index) => value + (b.params[index] - value) * f) };
}

export function waveSampleRate(bytes: ArrayBuffer): number | undefined {
  const view = new DataView(bytes);
  if (view.byteLength < 12 || view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645) return;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const size = view.getUint32(offset + 4, true);
    if (view.getUint32(offset) === 0x666d7420 && size >= 16 && offset + 24 <= view.byteLength) {
      return view.getUint32(offset + 12, true);
    }
    offset += 8 + size + size % 2;
  }
}

export function spliceAnnotationPcm(
  original: Float32Array, replacement: Float32Array, start: number, end: number, rate: number = SAMPLE_RATE_HZ,
  destination?: Float32Array,
): Float32Array {
  const length = end - start;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > original.length
    || length <= 0 || replacement.length < length) throw new RangeError('无法对齐音素与录音采样边界');
  const next = destination ?? new Float32Array(original);
  const fade = Math.min(Math.round(rate * 0.004), Math.floor(length / 3));
  for (let i = 0; i < length; i++) {
    const alpha = fade === 0 ? 1 : Math.min(1, i / fade, (length - 1 - i) / fade);
    next[start + i] = original[start + i] * (1 - alpha) + replacement[i] * alpha;
  }
  return next;
}
