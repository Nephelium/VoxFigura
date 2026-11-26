import { SAMPLE_RATE_HZ, msToSamples, type Clip, type RetimeResult, type SegmentAnchor, type Syllable, type VcProject } from '@vocalcut/core';

export function splitAnnotationPhone(syllable: Syllable, index: number, splitSmp: number, rightId: string): Syllable | null {
  const phone = syllable.segments[index];
  if (!phone || phone.stop_timing || !Number.isInteger(splitSmp)
    || splitSmp <= phone.start_smp || splitSmp >= phone.end_smp) return null;
  const left = { ...phone, end_smp: splitSmp };
  const right = { ...phone, id: rightId, start_smp: splitSmp };
  const segments = [...syllable.segments.slice(0, index), left, right, ...syllable.segments.slice(index + 1)];
  const poses = syllable.overrides.poses.flatMap((pose) => {
    if (pose.seg_index > index) return [{ ...pose, seg_index: pose.seg_index + 1 }];
    if (pose.seg_index !== index) return [pose];
    return [pose, { ...pose, seg_index: index + 1, seg_id: rightId }];
  });
  return {
    ...syllable,
    ipa: segments.map((segment) => segment.ipa),
    segments,
    nucleus_index: syllable.nucleus_index > index ? syllable.nucleus_index + 1 : syllable.nucleus_index,
    overrides: { ...syllable.overrides, poses },
  };
}

export function insertAnnotationSegment(
  clip: Clip,
  syllableId: string,
  index: number,
  segment: SegmentAnchor,
  controls: Pick<VcProject, 'phonation_anchors' | 'f0_pins'>,
): RetimeResult {
  const at = segment.start_smp;
  const duration = segment.end_smp - at;
  const syllables = { ...clip.syllables };
  const position = clip.syllable_order.indexOf(syllableId);
  const syllable = syllables[syllableId];
  const shift = (sample: number) => sample + duration;
  const shiftSpan = <T extends { start_smp: number; end_smp: number }>(span: T): T => ({
    ...span, start_smp: shift(span.start_smp), end_smp: shift(span.end_smp),
  });
  const segments = [...syllable.segments.slice(0, index), segment, ...syllable.segments.slice(index).map(shiftSpan)];
  syllables[syllableId] = {
    ...syllable,
    end_smp: shift(syllable.end_smp),
    ipa: segments.map((phone) => phone.ipa),
    segments,
    nucleus_index: syllable.nucleus_index + (syllable.segments.length && index <= syllable.nucleus_index ? 1 : 0),
    targets: syllable.targets.map((target) => ({
      ...target,
      start_smp: target.start_smp > at ? shift(target.start_smp) : target.start_smp,
      end_smp: target.end_smp > at || (target.end_smp === at && at === syllable.end_smp) ? shift(target.end_smp) : target.end_smp,
    })),
    overrides: {
      ...syllable.overrides,
      poses: syllable.overrides.poses.map((pose) => pose.seg_index >= index ? { ...pose, seg_index: pose.seg_index + 1 } : pose),
    },
  };
  for (const id of clip.syllable_order.slice(position + 1)) {
    const next = syllables[id];
    syllables[id] = { ...shiftSpan(next), segments: next.segments.map(shiftSpan), targets: next.targets.map(shiftSpan) };
  }
  const phonation_anchors = Object.fromEntries(Object.entries(controls.phonation_anchors).map(([id, anchor]) => [
    id,
    anchor.t_smp > at || (anchor.t_smp === at && anchor.syllable_id !== syllableId)
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
