import { SAMPLE_RATE_HZ, msToSamples, type AnnotationControls, type Clip, type Syllable } from '@vocalcut/core';
import { trackFrameAt, type AnnotationTractFrame } from '@/components/research/annotation-edit';
import { isStageVocalTrack, type NleClip } from './nle-timeline';
import { cropArrangerPitchPin } from './arranger-pitch';

export function voiceCompanionClips(audio: NleClip, phrase: Clip | undefined,
  frames: NleClip['poseFrames'] = [], rows?: number[][]): NleClip[] {
  if (!isStageVocalTrack(audio.track)) return [];
  const { gain: _gain, gainPoints: _gainPoints, muted: _muted, assetId: _assetId, ...visualBase } = audio;
  const shared: NleClip = {
    ...visualBase,
    linkedAudioId: audio.id,
    sourceStartSmp: Number.isSafeInteger(audio.sourceStartSmp) && audio.sourceStartSmp >= 0
      ? audio.sourceStartSmp
      : (phrase?.start_smp ?? 0),
  };
  const companions: NleClip[] = [];
  if (phrase?.syllable_order.length) {
    companions.push({ ...shared, id: crypto.randomUUID(), track: 'v3' });
  }
  if (frames.length || phrase?.syllable_order.length) {
    companions.push({ ...shared, id: crypto.randomUUID(), track: 'v1', sourceLength: audio.sourceLength ?? (audio.endSmp - audio.startSmp),
      poseFrames: frames, m27RowsPa: rows });
  }
  return companions;
}

export function copyStageAudio(audio: AudioBuffer, offset: number, length: number): AudioBuffer {
  if (audio.sampleRate !== SAMPLE_RATE_HZ) throw new Error('音频尚未转为 48 kHz 工程时基');
  const safeOffset = Math.max(0, Math.floor(offset));
  const available = Math.max(0, audio.length - safeOffset);
  const copyLen = Math.min(Math.max(0, Math.floor(length)), available);
  if (copyLen <= 0) throw new Error('所选片段超出源音频有效时长范围');
  const channels = audio.numberOfChannels;
  const result = new AudioBuffer({ numberOfChannels: channels, length: copyLen, sampleRate: SAMPLE_RATE_HZ });
  for (let channel = 0; channel < channels; channel++) {
    result.copyToChannel(audio.getChannelData(channel).subarray(safeOffset, safeOffset + copyLen), channel);
  }
  return result;
}

export function cropStagePhrase(clip: Clip, offset: number, duration: number): Clip {
  const limit = offset + duration;
  const syllable_order: string[] = [];
  const syllables: Record<string, Syllable> = {};
  const span = (start: number, end: number) => ({
    start_smp: Math.max(0, start - offset), end_smp: Math.min(limit, end) - offset,
  });
  for (const id of clip.syllable_order) {
    const syllable = clip.syllables[id];
    if (!syllable || syllable.end_smp <= offset || syllable.start_smp >= limit) continue;
    const segments = syllable.segments.filter(phone => phone.end_smp > offset && phone.start_smp < limit).map(phone => {
      const time = span(phone.start_smp, phone.end_smp);
      const stop = phone.stop_timing;
      const truncated = time.end_smp - time.start_smp !== phone.end_smp - phone.start_smp;
      return { ...phone, ...time, stop_timing: truncated && stop &&
        time.end_smp - time.start_smp < msToSamples(stop.closure_ms + stop.release_ms) ? undefined : stop };
    });
    const nucleus = syllable.segments[syllable.nucleus_index]?.id;
    const targets = syllable.targets.filter(target => target.end_smp > offset && target.start_smp < limit)
      .map(target => ({ ...target, ...span(target.start_smp, target.end_smp) }));
    const poses = syllable.overrides.poses.flatMap(pose => {
      const phoneId = pose.seg_id ?? syllable.segments[pose.seg_index]?.id;
      const index = segments.findIndex(segment => segment.id === phoneId);
      return index < 0 ? [] : [{ ...pose, seg_id: phoneId, seg_index: index }];
    });
    syllables[id] = {
      ...syllable, ...span(syllable.start_smp, syllable.end_smp), segments, targets,
      ipa: segments.map(phone => phone.ipa), nucleus_index: Math.max(0, segments.findIndex(phone => phone.id === nucleus)),
      overrides: { ...syllable.overrides, poses },
    };
    syllable_order.push(id);
  }
  const source = { ...clip.source };
  if (syllable_order.length !== clip.syllable_order.length) {
    source.lyrics = syllable_order.map(id => syllables[id].text).join('');
    delete source.score;
  }
  const rawControls = clip.annotation_controls;
  const croppedPins = (rawControls?.f0_pins ?? []).flatMap(pin => {
    const cropped = cropArrangerPitchPin(pin, offset, limit);
    return cropped ? [{
      ...cropped,
      start_smp: cropped.start_smp - offset,
      end_smp: cropped.end_smp - offset,
      points: cropped.points.map(point => ({ ...point, t_smp: point.t_smp - offset })),
    }] : [];
  });
  const croppedAnchors: AnnotationControls['phonation_anchors'] = {};
  const croppedAnchorOrder: string[] = [];
  for (const anchorId of rawControls?.phonation_anchor_order ?? Object.keys(rawControls?.phonation_anchors ?? {})) {
    const anchor = rawControls?.phonation_anchors?.[anchorId];
    if (!anchor || anchor.t_smp < offset || anchor.t_smp >= limit) continue;
    croppedAnchors[anchorId] = { ...anchor, t_smp: anchor.t_smp - offset };
    croppedAnchorOrder.push(anchorId);
  }
  const annotation_controls: AnnotationControls | undefined = rawControls
    ? {
      ...rawControls,
      phonation_anchor_order: croppedAnchorOrder,
      phonation_anchors: croppedAnchors,
      f0_pins: croppedPins,
    }
    : undefined;
  return {
    ...clip, start_smp: 0, end_smp: duration, syllable_order, syllables, source,
    annotation_controls,
  };
}

export function cropStageFrames(
  frames: readonly AnnotationTractFrame[] | undefined, from: number, length: number, sourceLength: number,
): AnnotationTractFrame[] {
  if (!frames?.length || sourceLength <= 0 || length <= 0) return [];
  const first = Math.max(0, Math.min(1, from / sourceLength));
  const last = Math.max(first, Math.min(1, (from + length) / sourceLength));
  const factor = sourceLength / length;
  const a = trackFrameAt(frames, first), b = trackFrameAt(frames, last);
  return [
    ...(a ? [{ ...a, u: 0 }] : []),
    ...frames.filter(frame => frame.u > first && frame.u < last).map(frame => ({ ...frame, u: (frame.u - first) * factor })),
    ...(b ? [{ ...b, u: 1 }] : []),
  ];
}

export function companionOf(visual: NleClip, audio: NleClip) {
  return (visual.track === 'v1' || visual.track === 'v3') && (visual.linkedAudioId === audio.id ||
    (!visual.linkedAudioId && Boolean(audio.phraseId) && visual.phraseId === audio.phraseId &&
      visual.startSmp === audio.startSmp && visual.endSmp === audio.endSmp));
}

export function companionGroupRootId(clip: NleClip, allClips: readonly NleClip[]): string | null {
  if (isStageVocalTrack(clip.track)) {
    return allClips.some(other => other.id !== clip.id && companionOf(other, clip)) ? clip.id : null;
  }
  if (clip.track === 'v1' || clip.track === 'v3') {
    const audio = allClips.find(item => isStageVocalTrack(item.track) && companionOf(clip, item));
    if (audio) return audio.id;
    if (clip.linkedAudioId && allClips.some(item => item.id !== clip.id && item.linkedAudioId === clip.linkedAudioId)) {
      return clip.linkedAudioId;
    }
  }
  return null;
}

export function companionPeersOf(clip: NleClip, allClips: readonly NleClip[]): NleClip[] {
  const rootId = companionGroupRootId(clip, allClips);
  if (!rootId) return [];
  return allClips.filter(item => item.id !== clip.id && companionGroupRootId(item, allClips) === rootId);
}
