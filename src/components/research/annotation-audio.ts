import {
  activePhonationAnchorAt,
  heldPhonationAt,
  msToSamples,
  SAMPLE_RATE_HZ,
  type Clip,
  type PhonationAnchor,
  type SegmentAnchor,
  type Syllable,
  type VcProject,
} from '@vocalcut/core';
import { getProtectedIpaPose } from '@/data/ipa-pose-sets';
import { getFullPoseForIpa } from './research-utils';
import { nasalPoseIpa, phoneTraits, splitPhoneNotation, usesTrialReferenceTrajectory } from '@/data/ipa-segments';
import { segmentVoicingStartSmp } from '@/data/speech-timing';
import { absolutePianoNotes, evaluateControlPitch, isArrangedNote } from './control-pitch';
import { interpolateTrackFrame, stopPhaseBoundaries, type AnnotationTractFrame } from './annotation-edit';

export interface ReferenceWarpSegment {
  /** Target span in the new clip (48 kHz samples) */
  startSmp?: number;
  endSmp?: number;
  targetStartSmp?: number;
  targetEndSmp?: number;
  /** Source span in the original reconstructed track (samples, seconds, normalized u in [0,1], or 50 Hz frame indices) */
  sourceStartSmp?: number;
  sourceEndSmp?: number;
  sourceStartSec?: number;
  sourceEndSec?: number;
  sourceU0?: number;
  sourceU1?: number;
  sourceStartFrame?: number;
  sourceEndFrame?: number;
  syllableId?: string;
}

export interface AnnotationControlReference {
  frames?: readonly AnnotationTractFrame[];
  m27RowsPa?: readonly number[][];
  editedPhoneIds?: readonly string[];
  durationSmp?: number;
  /** Optional baseline/source clip carrying original syllable/phone boundaries for piecewise time-warping (T-50) */
  sourceClip?: Clip;
  baselineClip?: Clip;
  /** Explicit piecewise time-warping boundary spans (syllable/phone sample or 50 Hz frame intervals, T-50) */
  warpSpans?: readonly ReferenceWarpSegment[];
  syllableSpans?: readonly ReferenceWarpSegment[];
  segmentMap?: readonly ReferenceWarpSegment[];
  /** When true, keep reconstructed vocal-tract articulation while forcing the new clip's F0 pitch contour */
  preserveArticulationOnly?: boolean;
  overridePitch?: boolean;
  preservePressure?: boolean;
}

export type AnnotationIpaPoseSource = 'current' | 'model';

const nativeTractIndices = [...Array.from({ length: 14 }, (_, i) => i), 16, 17, 18];
const lateralBases = new Set(['l', 'ɭ', 'ʎ', 'ʟ']);
const approximantBases = new Set(['ʋ', 'ɹ', 'ɻ', 'j', 'ɰ', 'w', 'ɥ', ...lateralBases]);
const lateralTractIndices = [3, 8, 9, 10, 11, 12, 13, 16, 17, 18];

function writtenSyllableEnds(syllable: Syllable): Set<number> {
  const notation = /^\[([\s\S]*)\]$/u.exec(syllable.text)?.[1];
  if (!notation) return new Set();
  const groups = notation.split(/[\s.·|‖#ˈˌ]+/u).map(splitPhoneNotation).filter(group => group.length > 0);
  if (groups.length < 2 || groups.reduce((count, group) => count + group.length, 0) !== syllable.segments.length) {
    return new Set();
  }
  let offset = 0;
  return new Set(groups.slice(0, -1).map(group => (offset += group.length) - 1));
}

function lateralGesturesForSynthesis(
  syllables: readonly Syllable[],
  speaker: string,
  authoredPoseIds: ReadonlySet<string>,
  protectedPoses: ReadonlyMap<string, unknown>,
) {
  const gestures = new Map<string, {
    base: string;
    holdPose: number[];
    release?: { startSmp: number; pose: number[] };
  }>();
  for (const syllable of syllables) {
    const writtenEnds = writtenSyllableEnds(syllable);
    for (const [index, phone] of syllable.segments.entries()) {
      if (phone.role === 'rest' || phone.stop_timing || authoredPoseIds.has(phone.id) || protectedPoses.has(phone.id)) continue;
      const traits = phoneTraits(phone.ipa);
      if (!lateralBases.has(traits.base) || /[ɫˠ̴]/u.test(phone.ipa)) continue;
      const next = syllable.segments[index + 1];
      const nextTraits = next && phoneTraits(next.ipa);
      const release = !traits.syllabic && !traits.unreleased && !writtenEnds.has(index) && next && nextTraits &&
        next.role !== 'rest' && next.start_smp === phone.end_smp && traits.base !== nextTraits.base &&
        (nextTraits.vowel || approximantBases.has(nextTraits.base))
        ? {
            startSmp: phone.end_smp - Math.min(msToSamples(32), Math.ceil((phone.end_smp - phone.start_smp) * 0.4)),
            pose: next.params ?? getFullPoseForIpa(next.ipa, undefined, speaker).params19,
          }
        : undefined;
      gestures.set(phone.id, {
        base: traits.base,
        holdPose: phone.params ?? getFullPoseForIpa(phone.ipa, undefined, speaker).params19,
        release,
      });
    }
  }
  return gestures;
}

function interpolateM27(rows: readonly number[][], clock: number): number[] | undefined {
  if (!rows.length) return undefined;
  const clamped = Math.max(0, Math.min(rows.length - 1, clock));
  const a = rows[Math.floor(clamped)];
  const b = rows[Math.min(rows.length - 1, Math.ceil(clamped))];
  if (a?.length !== 27 || b?.length !== 27) return;
  const f = clamped - Math.floor(clamped);
  return a.map((value, index) => value + (b[index] - value) * f);
}

/**
 * Only non-modal VoQS anchors (or explicit larynx height shifts) lock glottal phonation.
 * Plain modal restoration anchors (`V` / `modal`) and unanchored singing/speech spans leave
 * `phonation: 'auto'` unlocked so `IPA2Tract-Lite` / `Tract2Vox-Lite` perform natural high-F0 glottal synergy (T-32).
 */
export function isExplicitNonModalAnchor(anchor: PhonationAnchor | undefined): boolean {
  if (!anchor) return false;
  if (anchor.larynx_height_cm !== undefined && Math.abs(anchor.larynx_height_cm) > 1e-4) return true;
  if (anchor.voqs?.symbol && anchor.voqs.symbol !== 'V') return true;
  if (anchor.regime !== 'modal') return true;
  return false;
}

function hasAuthoredPressure(syllable: Syllable): boolean {
  const points = syllable.overrides?.pressure ?? [];
  // Older automatically compiled Mandarin and the built-in song used these
  // exact repeated envelopes. They are model targets, not manual gain edits.
  if (
    points.length === 4 &&
    points.every((point, i) => point.u === [0, 0.35, 0.85, 1][i]) &&
    (points.every((point, i) => point.pressure_pa === [640, 840, 760, 500][i]) ||
      points.every((point, i) => point.pressure_pa === [680, 860, 790, 520][i]))
  ) {
    return false;
  }
  return points.length > 0;
}

function pressureAt(syllable: Syllable, sample: number, fallback: number): number {
  const points = syllable.overrides?.pressure;
  if (!points?.length) return fallback;
  const u = (sample - syllable.start_smp) / Math.max(1, syllable.end_smp - syllable.start_smp);
  const nextIndex = points.findIndex((point) => point.u >= u);
  if (nextIndex < 0) return points[points.length - 1].pressure_pa;
  const next = points[nextIndex];
  if (nextIndex === 0) return next.pressure_pa;
  const previous = points[nextIndex - 1];
  const weight = (u - previous.u) / Math.max(1e-8, next.u - previous.u);
  return previous.pressure_pa + weight * (next.pressure_pa - previous.pressure_pa);
}

interface WarpInterval {
  t0: number;
  t1: number;
  u0: number;
  u1: number;
}

function normalizeSourceU(
  seg: ReferenceWarpSegment,
  refDurationSmp: number,
  m27RowCount: number,
): { u0: number; u1: number } | null {
  const safeDurSmp = Math.max(1, refDurationSmp);
  const safeFrames = Math.max(1, m27RowCount);
  let u0: number | undefined = seg.sourceU0;
  let u1: number | undefined = seg.sourceU1;

  if (u0 === undefined && seg.sourceStartSmp !== undefined) u0 = seg.sourceStartSmp / safeDurSmp;
  if (u1 === undefined && seg.sourceEndSmp !== undefined) u1 = seg.sourceEndSmp / safeDurSmp;

  if (u0 === undefined && seg.sourceStartSec !== undefined) u0 = (seg.sourceStartSec * SAMPLE_RATE_HZ) / safeDurSmp;
  if (u1 === undefined && seg.sourceEndSec !== undefined) u1 = (seg.sourceEndSec * SAMPLE_RATE_HZ) / safeDurSmp;

  if (u0 === undefined && seg.sourceStartFrame !== undefined) u0 = seg.sourceStartFrame / safeFrames;
  if (u1 === undefined && seg.sourceEndFrame !== undefined) u1 = seg.sourceEndFrame / safeFrames;

  if (u0 === undefined || u1 === undefined || !Number.isFinite(u0) || !Number.isFinite(u1)) return null;
  const c0 = Math.max(0, Math.min(1, u0));
  const c1 = Math.max(c0, Math.min(1, u1));
  return { u0: c0, u1: c1 };
}

/**
 * Build a piecewise-linear time-warping mapper from new `clip` sample coordinates onto
 * normalized `[0, 1]` position of the original reconstructed 50 Hz vocal-tract trajectory (T-50).
 */
export function buildPiecewiseReferenceMapper(
  clip: Clip,
  reference: AnnotationControlReference | undefined,
  referenceDurationSmp: number,
): (sampleSmp: number) => number {
  const clipDuration = Math.max(1, clip.end_smp - clip.start_smp);
  const linearFallback = (sampleSmp: number) =>
    Math.max(0, Math.min(1, (sampleSmp - clip.start_smp) / clipDuration));

  if (!reference) return linearFallback;

  const m27Len = reference.m27RowsPa?.length ?? 0;
  const intervals: WarpInterval[] = [];

  const explicitSpans = reference.warpSpans ?? reference.syllableSpans ?? reference.segmentMap;
  if (explicitSpans && explicitSpans.length > 0) {
    for (const seg of explicitSpans) {
      const t0 = seg.targetStartSmp ?? seg.startSmp;
      const t1 = seg.targetEndSmp ?? seg.endSmp;
      if (t0 === undefined || t1 === undefined || !(t1 > t0)) continue;
      const normU = normalizeSourceU(seg, referenceDurationSmp, m27Len);
      if (!normU) continue;
      intervals.push({ t0, t1, u0: normU.u0, u1: normU.u1 });
    }
  } else {
    const srcClip = reference.sourceClip ?? reference.baselineClip;
    if (srcClip && srcClip.syllable_order.length > 0 && clip.syllable_order.length > 0) {
      const srcDur = Math.max(1, reference.durationSmp ?? (srcClip.end_smp - srcClip.start_smp));
      const srcOrigin = srcClip.start_smp;
      const srcSyls = srcClip.syllable_order
        .map((id) => srcClip.syllables[id])
        .filter((s): s is Syllable => Boolean(s) && s.segments.some((seg) => seg.role !== 'rest'));
      const dstSyls = clip.syllable_order
        .map((id) => clip.syllables[id])
        .filter((s): s is Syllable => Boolean(s) && s.segments.some((seg) => seg.role !== 'rest'));

      dstSyls.forEach((dstSyl, idx) => {
        const matchedSrc = srcClip.syllables[dstSyl.id] ?? srcSyls[idx];
        if (!matchedSrc) return;
        const dstActiveSegs = dstSyl.segments.filter((s) => s.role !== 'rest');
        const srcActiveSegs = matchedSrc.segments.filter((s) => s.role !== 'rest');
        // Subdivide to phone-level piecewise warp when phoneme counts match; otherwise warp at syllable boundaries
        if (dstActiveSegs.length > 0 && dstActiveSegs.length === srcActiveSegs.length) {
          for (let k = 0; k < dstActiveSegs.length; k++) {
            const dSeg = dstActiveSegs[k];
            const sSeg = srcActiveSegs[k];
            if (dSeg.end_smp <= dSeg.start_smp) continue;
            intervals.push({
              t0: dSeg.start_smp,
              t1: dSeg.end_smp,
              u0: Math.max(0, Math.min(1, (sSeg.start_smp - srcOrigin) / srcDur)),
              u1: Math.max(0, Math.min(1, (sSeg.end_smp - srcOrigin) / srcDur)),
            });
          }
        } else if (dstSyl.end_smp > dstSyl.start_smp) {
          intervals.push({
            t0: dstSyl.start_smp,
            t1: dstSyl.end_smp,
            u0: Math.max(0, Math.min(1, (matchedSrc.start_smp - srcOrigin) / srcDur)),
            u1: Math.max(0, Math.min(1, (matchedSrc.end_smp - srcOrigin) / srcDur)),
          });
        }
      });
    }
  }

  if (intervals.length === 0) return linearFallback;
  intervals.sort((a, b) => a.t0 - b.t0);

  return (sampleSmp: number): number => {
    if (sampleSmp <= intervals[0].t0) {
      const first = intervals[0];
      if (first.t0 <= clip.start_smp) return first.u0;
      const frac = Math.max(0, (sampleSmp - clip.start_smp) / Math.max(1, first.t0 - clip.start_smp));
      return frac * first.u0;
    }
    for (let i = 0; i < intervals.length; i++) {
      const cur = intervals[i];
      if (sampleSmp >= cur.t0 && sampleSmp <= cur.t1) {
        const w = (sampleSmp - cur.t0) / Math.max(1, cur.t1 - cur.t0);
        return cur.u0 + w * (cur.u1 - cur.u0);
      }
      const next = intervals[i + 1];
      if (next && sampleSmp > cur.t1 && sampleSmp < next.t0) {
        // Hold/glide gently across inserted inter-syllable rests
        const w = (sampleSmp - cur.t1) / Math.max(1, next.t0 - cur.t1);
        return cur.u1 + w * (next.u0 - cur.u1);
      }
    }
    const last = intervals[intervals.length - 1];
    if (clip.end_smp <= last.t1) return last.u1;
    const tailFrac = Math.min(1, (sampleSmp - last.t1) / Math.max(1, clip.end_smp - last.t1));
    return last.u1 + tailFrac * Math.max(0, 1 - last.u1);
  };
}

/** Raised-cosine coarticulatory blend across segment boundaries for custom-tuned poses (T-21). */
function cosineCoarticulatedStaticPose(
  sample: number,
  phone: SegmentAnchor | undefined,
  prevPhone: SegmentAnchor | undefined,
  nextPhone: SegmentAnchor | undefined,
  fallbackTract: readonly number[],
): number[] {
  const center = phone?.params ?? fallbackTract;
  if (!phone) return [...center];
  const segLen = phone.end_smp - phone.start_smp;
  if (segLen <= 4) return [...center];
  // Smooth raised-cosine window up to 32 ms (at most 28% of segment on each edge)
  const edgeSmp = Math.min(Math.floor(segLen * 0.28), msToSamples(32));
  if (edgeSmp <= 2) return [...center];

  if (prevPhone?.params && prevPhone.params.length === center.length && sample - phone.start_smp < edgeSmp) {
    const prevMid = prevPhone.params.map((v, i) => 0.5 * (v + center[i]));
    const u = Math.max(0, Math.min(1, (sample - phone.start_smp) / edgeSmp));
    const w = 0.5 - 0.5 * Math.cos(Math.PI * u);
    return prevMid.map((v, i) => v + w * (center[i] - v));
  }
  if (nextPhone?.params && nextPhone.params.length === center.length && phone.end_smp - sample < edgeSmp) {
    const nextMid = nextPhone.params.map((v, i) => 0.5 * (v + center[i]));
    const u = Math.max(0, Math.min(1, (phone.end_smp - sample) / edgeSmp));
    const w = 0.5 - 0.5 * Math.cos(Math.PI * u);
    return nextMid.map((v, i) => v + w * (center[i] - v));
  }
  return [...center];
}

export function buildAnnotationSynthesis(
  project: VcProject,
  clip: Clip,
  anchors: readonly PhonationAnchor[],
  startSmp: number,
  endSmp: number,
  fallback: { f0Hz: number; tract: number[]; releaseTract: number[]; lipWidth: number; larynxHeight: number },
  reference?: AnnotationControlReference,
  poseSource?: AnnotationIpaPoseSource,
) {
  const stepHz = 200;
  const stepSmp = SAMPLE_RATE_HZ / stepHz;
  const voice = clip.voice_id ? project.voices[clip.voice_id] : undefined;
  const syllables = clip.syllable_order.map((id) => clip.syllables[id]).filter(Boolean);
  const phones = syllables.flatMap((syllable) => syllable.segments);
  const referenceHz = voice?.f0_ref_hz ?? fallback.f0Hz;
  const pitch = evaluateControlPitch(project, syllables, clip.end_smp, referenceHz, true, false, anchors);
  if (!pitch.ok) return pitch;
  const fixedNotes = absolutePianoNotes(syllables, referenceHz);
  const scoreNotes = syllables.flatMap((syllable) => syllable.targets.filter(isArrangedNote));
  const isSingingClip = scoreNotes.length > 0 || fixedNotes.length > 0;
  const useReference = Boolean(reference?.frames?.length || reference?.m27RowsPa?.length);
  const controlledVoicing = new Map(phones.flatMap(phone => {
    const devoicedNasal = nasalPoseIpa(phone.ipa) !== phone.ipa;
    const start = segmentVoicingStartSmp(phone);
    const explicitStopPrevoice = Boolean(
      !isSingingClip && start !== undefined && phone.stop_timing && !phone.stop_timing.auto_generated,
    );
    return !useReference && (devoicedNasal || explicitStopPrevoice) && start !== undefined
      ? [[phone.id, { nasal: devoicedNasal, start }]] as const
      : [];
  }));
  const authoredPoseIds = new Set(reference?.editedPhoneIds);
  for (const syllable of syllables) {
    for (const pose of syllable.overrides?.poses ?? []) {
      const id = pose.seg_id ?? syllable.segments[pose.seg_index]?.id;
      if (id) authoredPoseIds.add(id);
    }
  }
  const speaker = voice?.speaker ?? 'JD2';
  const protectedPoses = new Map(!useReference && poseSource !== 'model' && ['JD2', 'JD2-2D'].includes(speaker)
    ? phones.flatMap(phone => {
        if (authoredPoseIds.has(phone.id) || phone.role === 'rest') return [];
        const params = getProtectedIpaPose(phone.ipa);
        if (!params) return [];
        return [[phone.id, { params, extras: getFullPoseForIpa(phone.ipa, undefined, speaker).extras }]] as const;
      })
    : []);
  const lateralGestures = useReference ? undefined : lateralGesturesForSynthesis(syllables, speaker, authoredPoseIds, protectedPoses);
  const authoredPressureIds = new Set(syllables.filter(hasAuthoredPressure).map((syllable) => syllable.id));
  const authoredPitch = Boolean(
    reference?.preserveArticulationOnly ||
      reference?.overridePitch ||
      project.f0_pins?.length ||
      fixedNotes.length ||
      scoreNotes.length ||
      syllables.some(
        (syllable) =>
          syllable.overrides?.f0_resid?.length || syllable.targets.some((target) => target.candidates.user),
      ),
  );
  const clipDuration = Math.max(1, clip.end_smp - clip.start_smp);
  const referenceDuration =
    reference?.durationSmp ??
    (reference?.m27RowsPa?.length ? Math.round((reference.m27RowsPa.length / 50) * SAMPLE_RATE_HZ) : clipDuration);
  const mapReferencePosition = buildPiecewiseReferenceMapper(clip, reference, referenceDuration);
  const hasAnyExplicitVoqs = anchors.some((a) => isExplicitNonModalAnchor(a));

  const payload = {
    speaker,
    step_hz: stepHz,
    include_geometry: false,
    per_frame_shimmer: true,
    phonation: (!hasAnyExplicitVoqs || isSingingClip ? 'auto' : 'pinned') as 'auto' | 'pinned',
    f0_hz: [] as number[],
    pressure_pa: [] as number[],
    tract_frames: [] as number[][],
    glottis_frames: [] as number[][],
    lip_width_frames: [] as number[],
    larynx_height_frames: [] as number[],
    tongue_shape_frames: [] as number[][],
    lip_shape_frames: [] as number[][],
    manual_root_frames: [] as boolean[],
    pressure_locks: [] as boolean[],
    phonation_locks: [] as boolean[],
    articulation_source: useReference ? ('reference' as const) : ('annotation' as const),
    shimmer: project.perturbation?.shimmer ?? 0,
    flutter: project.perturbation?.flutter ?? 0,
    seed: project.perturbation?.seed,
  };

  let syllableIndex = 0;
  let phoneIndex = 0;
  let pitchIndex = 0;
  let noteIndex = 0;
  let scoreIndex = 0;
  for (let sample = startSmp; sample < endSmp; sample += stepSmp) {
    while (syllableIndex < syllables.length && syllables[syllableIndex].end_smp <= sample) syllableIndex++;
    while (phoneIndex < phones.length && phones[phoneIndex].end_smp <= sample) phoneIndex++;
    while (pitchIndex + 1 < pitch.value.times_smp.length && pitch.value.times_smp[pitchIndex + 1] <= sample) pitchIndex++;
    while (fixedNotes[noteIndex] && fixedNotes[noteIndex].endSmp <= sample) noteIndex++;
    while (scoreNotes[scoreIndex] && scoreNotes[scoreIndex].end_smp <= sample) scoreIndex++;

    const possibleSyllable = syllables[syllableIndex];
    const syllable = possibleSyllable?.start_smp <= sample ? possibleSyllable : undefined;
    const possiblePhone = phones[phoneIndex];
    const phone = possiblePhone?.start_smp <= sample ? possiblePhone : undefined;
    const prevPhone = phoneIndex > 0 ? phones[phoneIndex - 1] : undefined;
    const nextPhone = phoneIndex + 1 < phones.length ? phones[phoneIndex + 1] : undefined;

    const active = activePhonationAnchorAt(anchors, sample);
    const explicitVoqs = isExplicitNonModalAnchor(active);
    const recorded = explicitVoqs && active?.voqs ? active.glottis : undefined;
    const g = recorded ?? heldPhonationAt(anchors, sample);

    const baseHz = pitch.value.f0_hz[pitchIndex] || g.f0_hz;
    const nextHz = pitch.value.f0_hz[pitchIndex + 1] || baseHz;
    const offset = Math.max(0, sample - (pitch.value.times_smp[pitchIndex] ?? sample));
    const note = fixedNotes[noteIndex];
    const position = mapReferencePosition(sample);
    const row =
      reference?.m27RowsPa &&
      interpolateM27(reference.m27RowsPa, (position * referenceDuration) / (SAMPLE_RATE_HZ / 50) - 0.5);
    const draftPitch =
      note && note.startSmp <= sample
        ? note.hz
        : baseHz + Math.min(1, offset / pitch.value.step_smp) * (nextHz - baseHz);
    const frameF0 = row && !authoredPitch ? row[17] : draftPitch;
    payload.f0_hz.push(frameF0);

    const score = scoreNotes[scoreIndex];
    const singingNote = !scoreNotes.length || Boolean(score && score.start_smp <= sample);
    const lead = Boolean(score && phone?.role === 'onset' && phone.start_smp <= sample && sample < phone.end_smp);
    const voiceLocked = explicitVoqs;
    const timedVoice = phone && controlledVoicing.get(phone.id);
    const pressureLocked = voiceLocked || (Boolean(syllable) && authoredPressureIds.has(syllable!.id));
    const allowsSource = Boolean(syllable) && phone?.role !== 'rest' && (singingNote || lead);
    payload.phonation_locks.push(voiceLocked || Boolean(timedVoice));
    payload.pressure_locks.push(pressureLocked);
    payload.pressure_pa.push(
      !allowsSource && (isSingingClip || reference?.preserveArticulationOnly)
        ? 0
        : row && (reference?.preservePressure || !pressureLocked)
          ? row[18]
          : allowsSource && syllable
            ? (isSingingClip && pressureLocked ? pressureAt(syllable, sample, g.pr_pa)
              : recorded?.pr_pa ?? pressureAt(syllable, sample, g.pr_pa))
            : 0,
    );

    const manualPose = Boolean(phone && authoredPoseIds.has(phone.id));
    const protectedPose = phone && protectedPoses.get(phone.id);
    const staticPose = protectedPose?.params ?? (manualPose
      ? cosineCoarticulatedStaticPose(sample, phone, prevPhone, nextPhone, fallback.tract)
      : (phone?.params ?? fallback.tract));
    const importedPose = reference?.frames && interpolateTrackFrame(reference.frames, position);
    const referencePose = row ? [...(importedPose?.params ?? fallback.tract)] : importedPose?.params;
    if (row && referencePose) nativeTractIndices.forEach((col, i) => (referencePose[col] = row[i]));

    const phase = phone ? stopPhaseBoundaries(phone) : null;
    let tract = staticPose;
    if (phase && (!referencePose || manualPose) && sample >= phase.releaseStart) {
      const endpoint = (nextPhone && protectedPoses.get(nextPhone.id)?.params) ?? nextPhone?.params ?? fallback.releaseTract;
      const u = Math.min(1, (sample - phase.releaseStart) / Math.max(1, phase.releaseEnd - phase.releaseStart));
      tract = staticPose.map((value, i) => value + u * ((endpoint[i] ?? value) - value));
    }
    const lateral = phone && lateralGestures?.get(phone.id);
    if (phone && lateral) {
      tract = [...lateral.holdPose];
      const release = lateral.release;
      if (release && sample >= release.startSmp) {
        const u = (sample - release.startSmp) / (phone.end_smp - release.startSmp);
        const blend = 0.5 - 0.5 * Math.cos(Math.PI * u);
        for (const col of lateralTractIndices) tract[col] += blend * (release.pose[col] - tract[col]);
      } else if (prevPhone?.params && prevPhone.end_smp === phone.start_smp &&
                 lateralGestures?.get(prevPhone.id)?.base !== lateral.base) {
        const entrySmp = Math.min(msToSamples(15), Math.ceil((phone.end_smp - phone.start_smp) * 0.25));
        const u = Math.min(1, (sample - phone.start_smp) / entrySmp);
        if (u < 1) {
          const blend = 0.5 + 0.5 * Math.cos(Math.PI * u);
          for (const col of lateralTractIndices) tract[col] += blend * (prevPhone.params[col] - tract[col]);
        }
      }
    }
    if (referencePose) {
      const ramp =
        phone && manualPose ? Math.min((phone.end_smp - phone.start_smp) * 0.35, msToSamples(35)) : 0;
      const blend =
        phone && ramp > 0
          ? Math.sin(
              Math.min(1, (sample - phone.start_smp) / ramp, (phone.end_smp - sample) / ramp) * (Math.PI / 2),
            ) ** 2
          : 0;
      tract = blend === 0 ? referencePose : referencePose.map((value, i) => value + blend * (tract[i] - value));
    }
    payload.tract_frames.push(tract);

    // High-pitch F0-glottis synergy fallback for direct physical synthesis when no non-modal VoQS anchor locks the glottis (T-32)
    const highPitchFactor = !voiceLocked && frameF0 > 200 ? Math.min(1, (frameF0 - 200) / 240) : 0;
    const effXb = g.xb_cm * (1 - 0.32 * highPitchFactor);
    const effXt = g.xt_cm * (1 - 0.35 * highPitchFactor);
    const voicingOn = timedVoice ? sample >= timedVoice.start : phone?.voiced !== false;
    const opening = timedVoice && !voicingOn ? (timedVoice.nasal ? 0.18 : 0) : undefined;
    const ordinaryGlottis = [
      opening ?? effXb,
      opening ?? effXt,
      opening === 0 ? 0 : g.ca_cm2,
      g.lag_rad,
      voicingOn ? g.ra : 0,
      g.ps,
      Math.max(g.fl, payload.flutter),
      Math.max(g.shim, payload.shimmer),
    ];
    if (!voiceLocked && voicingOn && phone && phone.role !== 'rest') {
      const voiceTraits = phoneTraits(phone.ipa);
      if (voiceTraits.breathy) {
        ordinaryGlottis[0] = Math.max(ordinaryGlottis[0], 0.085);
        ordinaryGlottis[1] = Math.max(ordinaryGlottis[1], 0.085);
        ordinaryGlottis[2] = Math.max(ordinaryGlottis[2], 0.105);
        ordinaryGlottis[3] = Math.min(ordinaryGlottis[3], 0.72);
        ordinaryGlottis[4] = Math.min(ordinaryGlottis[4], 0.76);
        ordinaryGlottis[5] = Math.min(ordinaryGlottis[5], -0.25);
        ordinaryGlottis[6] = Math.max(ordinaryGlottis[6], 28);
        ordinaryGlottis[7] = Math.max(ordinaryGlottis[7], 18);
      } else if (voiceTraits.creaky) {
        ordinaryGlottis[0] = Math.min(ordinaryGlottis[0], 0.005);
        ordinaryGlottis[1] = Math.min(ordinaryGlottis[1], 0.005);
        ordinaryGlottis[2] = Math.min(ordinaryGlottis[2], 0);
        ordinaryGlottis[3] = Math.max(ordinaryGlottis[3], 2.2);
        ordinaryGlottis[5] = Math.max(ordinaryGlottis[5], 0.75);
        ordinaryGlottis[6] = Math.max(ordinaryGlottis[6], 70);
        ordinaryGlottis[7] = Math.max(ordinaryGlottis[7], 70);
      }
    }
    const glottis =
      row && !voiceLocked && !(reference?.preserveArticulationOnly && frameF0 > 220)
        ? row.slice(19)
        : ordinaryGlottis;
    glottis[6] = Math.max(payload.flutter, glottis[6]);
    glottis[7] = Math.max(payload.shimmer, glottis[7]);
    payload.glottis_frames.push(glottis);
    const extras = protectedPose?.extras;
    payload.lip_width_frames.push(extras?.lip_width ?? phone?.lip_width ?? fallback.lipWidth);
    payload.larynx_height_frames.push(active?.larynx_height_cm ?? extras?.larynx_height ?? phone?.larynx_height_cm ?? fallback.larynxHeight);
    payload.tongue_shape_frames.push(extras?.tongue_shape ?? phone?.tongue_shape ?? [0, 0, 0, 0]);
    payload.lip_shape_frames.push(extras?.lip_shape ?? phone?.lip_shape ?? [0, 0, 0, 0]);
    payload.manual_root_frames.push(extras?.manual_root ?? phone?.manual_root ?? false);
  }

  const frameAt = (sample: number) =>
    Math.max(0, Math.min(payload.f0_hz.length, Math.ceil((sample - startSmp) / stepSmp)));
  const minPlaceholderReleaseSmp = msToSamples(2);
  const rawSpans = syllables
    .flatMap((syllable) =>
      syllable.segments.flatMap((phone) => {
        const stop = stopPhaseBoundaries(phone);
        const poseProtected = protectedPoses.has(phone.id);
        const protectedPhone = poseProtected ? {
          start_smp: phone.start_smp - startSmp,
          end_smp: phone.end_smp - startSmp,
          release_smp: stop && stop.releaseStart < phone.end_smp ? stop.releaseStart - startSmp : undefined,
        } : undefined;
        const traits = phoneTraits(phone.ipa);
        const lateral = lateralGestures?.get(phone.id);
        const makeSpan = (start: number, end: number, phase: string, voiced: boolean) => {
          const start_frame = frameAt(start);
          const end_frame = frameAt(end);
          const start_sample = Math.max(0, start - startSmp);
          const end_sample = Math.min(endSmp, end) - startSmp;
          if (start_sample >= end_sample) return [];
          const locked = authoredPoseIds.has(phone.id) || poseProtected;
          const anchor = activePhonationAnchorAt(anchors, Math.floor((start + end) / 2));
          const phonationLocked = isExplicitNonModalAnchor(anchor);
          const diacriticPhonation =
            phase === 'silence' || !voiced
              ? undefined
              : traits.breathy
                ? 'breathy'
                : traits.creaky
                  ? 'creaky'
                  : undefined;
          const spanPhonation =
            phase === 'silence'
              ? 'silence'
              : phonationLocked
                ? anchor!.regime
                : diacriticPhonation ?? 'auto';
          return [
            {
              start_frame,
              end_frame,
              start_sample,
              end_sample,
              ipa: nasalPoseIpa(phone.ipa),
              phase,
              voiced,
              locked,
              pose_protected: poseProtected,
              protected_phone: protectedPhone,
              pose_target_19: phase === 'silence' || poseSource === 'model' ? undefined : phone.params,
              ...(lateral && { lateral_ending: lateral.release ? 'release' as const : 'hold' as const }),
              pressure_locked: authoredPressureIds.has(syllable.id) || phonationLocked,
              phonation_locked: phonationLocked,
              phonation: spanPhonation,
            },
          ];
        };
        if (phone.role === 'rest') return makeSpan(phone.start_smp, phone.end_smp, 'silence', false);
        if (!stop)
          return makeSpan(
            phone.start_smp,
            phone.end_smp,
            phone.role === 'aspiration' ? 'aspiration' : 'normal',
            controlledVoicing.get(phone.id)?.nasal || phone.voiced,
          );
        const closureEnd = traits.unreleased ? phone.end_smp : stop.releaseStart;
        const prevoice = controlledVoicing.get(phone.id)?.start;
        const closureSpans = prevoice === undefined
          ? makeSpan(phone.start_smp, closureEnd, 'closure', phone.voiced)
          : [
              ...makeSpan(phone.start_smp, prevoice, 'closure', false),
              ...makeSpan(prevoice, closureEnd, 'closure', true),
            ];
        if (traits.unreleased) return closureSpans;
        const release = traits.releaseMode === 'nasal'
          ? 'nasal_release'
          : traits.releaseMode === 'lateral'
            ? 'lateral_release'
            : 'release';
        const aspirated = traits.aspirated;
        if (aspirated && stop.releaseEnd - stop.releaseStart <= minPlaceholderReleaseSmp) {
          return [
            ...closureSpans,
            ...makeSpan(stop.releaseStart, phone.end_smp, 'aspiration', phone.ipa.includes('ʱ')),
          ];
        }
        return [
          ...closureSpans,
          ...makeSpan(stop.releaseStart, stop.releaseEnd, release, phone.voiced),
          ...makeSpan(stop.releaseEnd, phone.end_smp, aspirated ? 'aspiration' : 'release',
            aspirated ? phone.ipa.includes('ʱ') : phone.voiced),
        ];
      }),
    )
    .sort((a, b) => a.start_sample - b.start_sample);

  const totalSamples = endSmp - startSmp;
  const articulationSpans: typeof rawSpans = [];
  let cursorSample = 0;
  for (const span of rawSpans) {
    if (span.start_sample - cursorSample >= stepSmp) {
      const gapStartFrame = frameAt(startSmp + cursorSample);
      const gapEndFrame = frameAt(startSmp + span.start_sample);
      if (gapEndFrame > gapStartFrame) {
        articulationSpans.push({
          start_frame: gapStartFrame,
          end_frame: gapEndFrame,
          start_sample: cursorSample,
          end_sample: span.start_sample,
          ipa: 'sil',
          phase: 'silence',
          voiced: false,
          locked: false,
          pose_protected: false,
          protected_phone: undefined,
          pose_target_19: undefined,
          pressure_locked: false,
          phonation_locked: false,
          phonation: 'silence',
        });
      }
    }
    articulationSpans.push(span);
    cursorSample = Math.max(cursorSample, span.end_sample);
  }
  if (totalSamples - cursorSample >= stepSmp) {
    const gapStartFrame = frameAt(startSmp + cursorSample);
    const gapEndFrame = frameAt(endSmp);
    if (gapEndFrame > gapStartFrame) {
      articulationSpans.push({
        start_frame: gapStartFrame,
        end_frame: gapEndFrame,
        start_sample: cursorSample,
        end_sample: totalSamples,
        ipa: 'sil',
        phase: 'silence',
        voiced: false,
        locked: false,
        pose_protected: false,
        protected_phone: undefined,
        pose_target_19: undefined,
        pressure_locked: false,
        phonation_locked: false,
        phonation: 'silence',
      });
    }
  }
  const canPredict = !useReference && ['JD2', 'JD2-2D'].includes(payload.speaker) && articulationSpans.length > 0;
  const hasPoseTargets = articulationSpans.some((span) => span.pose_target_19 !== undefined);
  const referenceSpans = canPredict ? phones.flatMap((phone, index) => {
    if (phone.end_smp <= startSmp || phone.start_smp >= endSmp ||
        authoredPoseIds.has(phone.id) || protectedPoses.has(phone.id) || lateralGestures?.has(phone.id) ||
        !usesTrialReferenceTrajectory(phone.ipa)) return [];
    const previous = phones[index - 1];
    const next = phones[index + 1];
    const left = previous?.end_smp === phone.start_smp && phoneTraits(previous.ipa).vowel ? previous : undefined;
    const right = next?.start_smp === phone.end_smp && phoneTraits(next.ipa).vowel ? next : undefined;
    const traits = phoneTraits(phone.ipa);
    const explicitStop = phone.stop_timing && (phone.stop_timing.locked || !phone.stop_timing.auto_generated);
    return [{
      ipa: phone.ipa,
      start_smp: phone.start_smp - startSmp,
      end_smp: phone.end_smp - startSmp,
      position: left && right ? 'intervocalic' : 'onset',
      left_vowel: left?.ipa,
      right_vowel: right?.ipa,
      affricate: traits.affricate,
      ...(explicitStop && stopPhaseBoundaries(phone)!.releaseStart < phone.end_smp
        ? { release_smp: stopPhaseBoundaries(phone)!.releaseStart - startSmp } : {}),
    }];
  }) : [];
  return {
    ok: true as const,
    value: canPredict
      ? {
          ...payload,
          predict_articulation: true,
          ...(hasPoseTargets ? { pose_source: poseSource === 'current' ? 'custom' : 'stored' } : {}),
          articulation_spans: articulationSpans,
          ...(referenceSpans.length ? { reference_spans: referenceSpans } : {}),
        }
      : payload,
  };
}
