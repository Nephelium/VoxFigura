import { SAMPLE_RATE_HZ, type Clip, type VcProject } from '@vocalcut/core';
import { applyPeakAudioGain, synthesisGainMode, voiceRenderLabels, voiceRenderMode, type VoiceRenderMode } from '@/data/voice-renderer';
import { speakerReferenceAudio, speakerReferenceId } from '@/data/synthesis-speaker';
import { defaultTractParams, tractRecordToArray19, type WorkbenchStore } from '@/stores/workbench';
import { spliceAnnotationPcm, type AnnotationTractFrame } from '@/components/research/annotation-edit';
import { absolutePianoNotes } from '@/components/research/control-pitch';
import { getFullPoseForIpa } from '@/components/research/research-utils';
import { ipaPoseSetRevision, loadDefaultIpaPoses } from '@/data/ipa-pose-sets';
import { preloadPtbIpaPresets } from '@/data/ptb-ipa-presets';
import { isStageAudioTrack, isStageVocalTrack, readTimeline, stageAudioSettings, type NleClip } from './nle-timeline';
import { sessionMedia } from './studio-media';
import { companionOf } from './stage-voice-clips';
import { scheduleStageGain, type StageGainPoint } from './stage-gain';

interface StageSound {
  buffer: AudioBuffer;
  sourceOriginSmp: number;
  motion?: StageSynthesisMotion;
}

interface StageSynthesisMotion {
  frames: AnnotationTractFrame[];
  m27RowsPa?: number[][];
  poseSetRevision: number;
  mode: VoiceRenderMode;
  sourceOriginSmp: number;
  sourceLengthSmp: number;
}

const synthesizedMotion = new WeakMap<VcProject, Map<string, StageSynthesisMotion>>();
export function getStageSynthesisMotion(project: VcProject, clipId: string): StageSynthesisMotion | undefined {
  const motion = synthesizedMotion.get(project)?.get(clipId);
  return motion?.mode === voiceRenderMode.value && motion.poseSetRevision === ipaPoseSetRevision.value ? motion : undefined;
}

export function visualSynthesisMotion(project: VcProject, clips: readonly NleClip[], visual: NleClip, activeClipId: string) {
  const voice = clips.find(clip => isStageVocalTrack(clip.track) && companionOf(visual, clip))
    ?? clips.find(clip => clip.track === 'a1' && clip.startSmp === visual.startSmp && clip.endSmp === visual.endSmp &&
      getStagePhrase(project, activeClipId, clip)?.id === (visual.phraseId ?? activeClipId));
  return voice ? getStageSynthesisMotion(project, voice.id) : undefined;
}

export interface StageAudioPart {
  buffer: AudioBuffer;
  gain: number;
  startSmp: number;
  offsetSmp: number;
  lengthSmp: number;
  gainPoints?: readonly StageGainPoint[];
  sourceStartSmp?: number;
}

export function getStagePhrase(project: VcProject, activeClipId: string, clip: NleClip): Clip | undefined {
  if (clip.phraseId && project.clips[clip.phraseId]) return project.clips[clip.phraseId];
  if (clip.assetId) {
    const linked = project.clip_order.map(id => project.clips[id]).find(phrase => phrase?.asset_id === clip.assetId);
    if (linked) return linked;
  }
  if (!clip.assetId && clip.id === `c_${clip.track}_1`) return project.clips[activeClipId];
  if (!clip.assetId && isStageVocalTrack(clip.track)) {
    const voiceId = stageAudioSettings(project).find(track => track.id === clip.track)?.voiceId;
    if (clip.track !== 'a1' && !voiceId) return;
    const sourceEnd = clip.sourceStartSmp + clip.endSmp - clip.startSmp;
    const matching = project.clip_order.map(id => project.clips[id]).filter(phrase =>
      canSynthesize(phrase) && (!voiceId || phrase.voice_id === voiceId) &&
      phrase.start_smp <= clip.sourceStartSmp && sourceEnd <= phrase.end_smp);
    if (matching.length === 1) return matching[0];
  }
}

const phraseSyllables = (phrase: Clip) => phrase.syllable_order.flatMap(id => phrase.syllables[id] ?? []);
const canSynthesize = (phrase: Clip | undefined): phrase is Clip => Boolean(phrase && phraseSyllables(phrase)
  .some(syllable => syllable.segments.some(phone => phone.ipa.trim() && phone.end_smp > phone.start_smp)));

export function stageAudioLimit(project: VcProject, activeClipId: string, clips: readonly NleClip[]) {
  for (const clip of clips) {
    if (!isStageAudioTrack(clip.track) || clip.muted || clip.gain === 0) continue;
    if (clip.assetId && sessionMedia.get(clip.assetId)?.audio) continue;
    if (isStageVocalTrack(clip.track) && canSynthesize(getStagePhrase(project, activeClipId, clip))) continue;
    return clip.assetId ? `请重新关联音频「${clip.label}」。` : `「${clip.label}」还没有录音或可合成的音素。`;
  }
  return '';
}

function captureAudioState(store: WorkbenchStore, project: VcProject, activeClipId: string, clips: readonly NleClip[]) {
  return {
    store, project, activeClipId, clips, mode: voiceRenderMode.value, audioGain: synthesisGainMode.value,
    device: store.computeDevice.value, speakerId: speakerReferenceId.value,
    speakerWavBase64: speakerReferenceAudio.value,
  };
}

type StageAudioState = ReturnType<typeof captureAudioState>;
const renderedPhrases = new Map<string, Promise<AudioBuffer>>();
const fallbackTract = defaultTractParams();
const defaultPose = tractRecordToArray19(fallbackTract);

function stageControlReference(state: StageAudioState, clip: NleClip, phrase: Clip) {
  if (clip.assetId && state.project.assets[clip.assetId]?.role === 'studio_synthesis') return;
  const pose = state.clips.find(item => item.track === 'v1' && companionOf(item, clip));
  const recording = clip.assetId ? sessionMedia.get(clip.assetId)?.transferred : undefined;
  const frames = clip.poseFrames ?? pose?.poseFrames ?? recording?.frames;
  const rows = clip.m27RowsPa ?? pose?.m27RowsPa ?? recording?.rowsPa;
  const expected = phrase.end_smp - phrase.start_smp;
  const sourceLength = pose?.sourceLength ?? clip.sourceLength
    ?? (clip.assetId ? state.project.assets[clip.assetId]?.duration_smp : undefined);
  if (sourceLength !== undefined && Math.abs(sourceLength - expected) > SAMPLE_RATE_HZ / 50) return;
  const m27RowsPa = rows && Math.abs(rows.length * SAMPLE_RATE_HZ / 50 - expected) <= SAMPLE_RATE_HZ / 50 ? rows : undefined;
  return frames?.length || m27RowsPa?.length ? { frames, m27RowsPa } : undefined;
}

async function synthesizePhrase(state: StageAudioState, clip: NleClip, phrase: Clip, signal?: AbortSignal): Promise<AudioBuffer> {
  const { store, project, activeClipId, mode, audioGain, device } = state;
  const voiceId = stageAudioSettings(project).find(track => track.id === clip.track)?.voiceId
    ?? phrase.voice_id ?? store.activeVoiceId.value;
  const voice = project.voices[voiceId];
  const annotationControls = phrase.id === activeClipId ? {
    phonation_anchor_order: project.phonation_anchor_order,
    phonation_anchors: project.phonation_anchors,
    f0_pins: project.f0_pins,
    vibrato: project.vibrato,
    perturbation: project.perturbation,
  } : phrase.annotation_controls;
  let scoped: Clip = { ...phrase, voice_id: voiceId, annotation_controls: annotationControls };
  const needsPose = (params?: number[]) => params?.length !== 19 || params.every(value => value === 0) ||
    params.every((value, index) => Math.abs(value - defaultPose[index]) < 1e-4);
  const syllables = phraseSyllables(phrase).filter(syllable => syllable.segments.some(phone => needsPose(phone.params)));
  if (syllables.length) {
    const speaker = voice?.speaker ?? 'JD2';
    await waitForAudio(Promise.all([preloadPtbIpaPresets(speaker), loadDefaultIpaPoses()]), signal);
    signal?.throwIfAborted();
    scoped = { ...scoped, syllables: { ...phrase.syllables } };
    for (const syllable of syllables) {
      scoped.syllables[syllable.id] = {
        ...syllable,
        segments: syllable.segments.map(phone => {
          if (!needsPose(phone.params)) return phone;
          const pose = getFullPoseForIpa(phone.ipa, undefined, speaker);
          return {
            ...phone, params: pose.params19,
            lip_width: phone.lip_width ?? pose.extras.lip_width,
            larynx_height_cm: phone.larynx_height_cm ?? pose.extras.larynx_height,
            manual_root: phone.manual_root ?? pose.extras.manual_root,
            tongue_shape: phone.tongue_shape ?? pose.extras.tongue_shape,
            lip_shape: phone.lip_shape ?? pose.extras.lip_shape,
          };
        }),
      };
    }
  }
  const referenceTrack = stageControlReference(state, clip, phrase);
  const key = JSON.stringify([
    project.id, scoped, voice, mode, audioGain, mode === 'neural' ? [device, state.speakerId] : 'cpu',
    referenceTrack, ipaPoseSetRevision.value,
  ]);
  const cached = renderedPhrases.get(key);
  if (cached) {
    renderedPhrases.delete(key);
    renderedPhrases.set(key, cached);
    return waitForAudio(cached, signal);
  }
  const job = store.synthesizeRange({
    annotation: true, phrase: scoped, mode, audioGain, computeDevice: device, cacheWaveform: false,
    tractParams: fallbackTract, f0Hz: voice?.f0_ref_hz ?? 125, returnControlTrack: true, referenceTrack,
    speakerWavBase64: state.speakerWavBase64,
  }).then(audio => {
    if (!audio) throw new Error(`「${clip.label}」未完成${voiceRenderLabels[mode]}。请检查引擎和音素设置。`);
    return audio;
  }).catch(error => {
    if (renderedPhrases.get(key) === job) renderedPhrases.delete(key);
    throw error;
  });
  renderedPhrases.set(key, job);
  if (renderedPhrases.size > 8) {
    const oldest = renderedPhrases.keys().next().value;
    if (oldest !== undefined) renderedPhrases.delete(oldest);
  }
  return waitForAudio(job, signal);
}

function waitForAudio<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

async function resolveStageSound(
  state: StageAudioState, clip: NleClip, signal?: AbortSignal, forceRender = false,
): Promise<StageSound> {
  signal?.throwIfAborted();
  const raw = clip.assetId ? sessionMedia.get(clip.assetId)?.audio : undefined;
  const phrase = isStageVocalTrack(clip.track) ? getStagePhrase(state.project, state.activeClipId, clip) : undefined;
  const committed = clip.assetId && state.project.assets[clip.assetId]?.role === 'studio_synthesis';
  if (!canSynthesize(phrase)) {
    if (raw && !forceRender) return { buffer: raw, sourceOriginSmp: 0 };
    throw new Error(clip.assetId ? `请重新关联音频「${clip.label}」。` : `「${clip.label}」没有可合成的音素。`);
  }
  const notes = raw && !committed && phrase.source?.transcription !== 'jianpu-arranger'
    ? absolutePianoNotes(phraseSyllables(phrase), state.project.voices[phrase.voice_id ?? '']?.f0_ref_hz ?? 220)
    : [];
  if (raw && !forceRender && !notes.length) return { buffer: raw, sourceOriginSmp: 0 };
  const poseSetRevision = ipaPoseSetRevision.value;
  const buffer = await synthesizePhrase(state, clip, phrase, signal);
  if (!raw || !notes.length) {
    const sourceOriginSmp = committed || clip.sourceStartSmp < phrase.start_smp ? 0 : phrase.start_smp;
    const details = state.store.synthesisInfo(buffer);
    const motion = details?.tractFrames?.length ? {
      frames: details.tractFrames, m27RowsPa: details.m27RowsPa, mode: state.mode, poseSetRevision,
      sourceOriginSmp, sourceLengthSmp: Math.round(buffer.duration * SAMPLE_RATE_HZ),
    } : undefined;
    if (motion) {
      const tracks = synthesizedMotion.get(state.project) ?? new Map();
      tracks.set(clip.id, motion);
      synthesizedMotion.set(state.project, tracks);
    }
    return { buffer, sourceOriginSmp, motion };
  }
  const result = new AudioBuffer({ sampleRate: raw.sampleRate, length: raw.length, numberOfChannels: raw.numberOfChannels });
  const native = buffer.getChannelData(0);
  for (let channel = 0; channel < raw.numberOfChannels; channel++) {
    const input = raw.getChannelData(channel);
    const destination = result.getChannelData(channel);
    destination.set(input);
    for (const note of notes) {
      const start = Math.max(clip.sourceStartSmp, phrase.start_smp, note.startSmp);
      const end = Math.min(clip.sourceStartSmp + clip.endSmp - clip.startSmp,
        phrase.start_smp + native.length, raw.length, note.endSmp);
      if (end > start) {
        spliceAnnotationPcm(input, native.subarray(start - phrase.start_smp, end - phrase.start_smp),
          start, end, raw.sampleRate, destination);
      }
    }
  }
  if (state.audioGain === 'peak') applyPeakAudioGain(result);
  return { buffer: result, sourceOriginSmp: 0 };
}

export function stageSoundForClip(store: WorkbenchStore, clip: NleClip, forceRender = false) {
  const project = store.project.value;
  const id = store.activeClipId.value;
  return resolveStageSound(captureAudioState(store, project, id, readTimeline(project, id)), clip, undefined, forceRender);
}

export async function prepareStageAudio(
  store: WorkbenchStore, project: VcProject, activeClipId: string, clips: readonly NleClip[],
  fromSmp: number, signal?: AbortSignal,
): Promise<StageAudioPart[]> {
  const state = captureAudioState(store, project, activeClipId, clips);
  const parts: StageAudioPart[] = [];
  for (const clip of clips) {
    signal?.throwIfAborted();
    if (!isStageAudioTrack(clip.track) || clip.muted || clip.gain === 0 || clip.endSmp <= fromSmp) continue;
    const { buffer, sourceOriginSmp } = await resolveStageSound(state, clip, signal);
    const startSmp = Math.max(clip.startSmp, fromSmp, clip.startSmp + sourceOriginSmp - clip.sourceStartSmp);
    const offsetSmp = startSmp - clip.startSmp + clip.sourceStartSmp - sourceOriginSmp;
    const lengthSmp = Math.min(clip.endSmp - startSmp, Math.round(buffer.duration * SAMPLE_RATE_HZ) - offsetSmp);
    if (lengthSmp > 0) parts.push({ buffer, startSmp, offsetSmp, lengthSmp, gain: clip.gain ?? 1,
      gainPoints: clip.gainPoints, sourceStartSmp: clip.sourceStartSmp + startSmp - clip.startSmp });
    else if (fromSmp <= clip.startSmp) throw new Error(`「${clip.label}」的入点超出可播放的源音频。`);
  }
  return parts;
}

export function scheduleStageAudio(
  context: BaseAudioContext, output: AudioNode, parts: readonly StageAudioPart[], origin: number, fromSmp = 0,
): AudioBufferSourceNode[] {
  return parts.map(part => {
    const node = context.createBufferSource();
    node.buffer = part.buffer;
    const gain = context.createGain();
    const atTime = origin + (part.startSmp - fromSmp) / SAMPLE_RATE_HZ;
    scheduleStageGain(gain.gain, part.gain, part.gainPoints ?? [], atTime,
      part.sourceStartSmp ?? 0, part.lengthSmp, SAMPLE_RATE_HZ);
    node.connect(gain).connect(output);
    node.addEventListener('ended', () => { node.disconnect(); gain.disconnect(); }, { once: true });
    node.start(atTime,
      part.offsetSmp / SAMPLE_RATE_HZ, part.lengthSmp / SAMPLE_RATE_HZ);
    return node;
  });
}
