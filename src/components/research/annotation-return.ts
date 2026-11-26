import { SAMPLE_RATE_HZ, type AnnotationControls, type Clip, type VcProject } from '@vocalcut/core';
import { spliceAnnotationPcm } from './annotation-edit';

export function currentAnnotationControls(project: VcProject): AnnotationControls {
  return {
    phonation_anchor_order: project.phonation_anchor_order, phonation_anchors: project.phonation_anchors,
    f0_pins: project.f0_pins, vibrato: project.vibrato, perturbation: project.perturbation,
  };
}

type Span = { start_smp: number; end_smp: number };

// A changed duration or global prosody requires a new take. Local edits keep the
// original PCM outside the affected spans, including unvoiced consonants.
export function changedAudioSpans(before: Clip, after: Clip, globalChange: boolean): Span[] | 'whole' {
  if (globalChange || before.start_smp !== after.start_smp || before.end_smp !== after.end_smp
      || before.syllable_order.join('|') !== after.syllable_order.join('|')) return 'whole';
  const spans: Span[] = [];
  for (const id of after.syllable_order) {
    const old = before.syllables[id], next = after.syllables[id];
    if (!old || !next || old.start_smp !== next.start_smp || old.end_smp !== next.end_smp) return 'whole';
    const { segments, text, ipa, overrides, ...nextTiming } = next;
    const { segments: prior, text: _text, ipa: _ipa, overrides: oldOverrides, ...oldTiming } = old;
    const { poses, ...prosody } = overrides;
    const { poses: priorPoses, ...oldProsody } = oldOverrides;
    if (JSON.stringify(nextTiming) !== JSON.stringify(oldTiming) || JSON.stringify(oldProsody) !== JSON.stringify(prosody)
      || prior.length !== segments.length || segments.some((seg,i) => seg.start_smp !== prior[i].start_smp || seg.end_smp !== prior[i].end_smp)) {
      spans.push(next);
      continue;
    }
    for (const [index, seg] of segments.entries()) {
      const own = (pose: typeof poses[number]) => pose.seg_id ? pose.seg_id === seg.id : pose.seg_index === index;
      if (JSON.stringify(seg) !== JSON.stringify(prior[index]) ||
          JSON.stringify(poses.filter(own)) !== JSON.stringify(priorPoses.filter(own))) spans.push(seg);
    }
  }
  return spans;
}

export async function replaceRenderedSpans(original: AudioBuffer, rendered: AudioBuffer, spans: Span[], offset: number): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, original.length, original.sampleRate);
  const source = ctx.createBufferSource();
  source.buffer = rendered;
  source.connect(ctx.destination);
  source.start();
  const mono = (await ctx.startRendering()).getChannelData(0);
  const result = new AudioBuffer({ numberOfChannels: original.numberOfChannels, length: original.length, sampleRate: original.sampleRate });
  for (let ch = 0; ch < original.numberOfChannels; ch++) {
    const pcm = original.getChannelData(ch), output = result.getChannelData(ch);
    output.set(pcm);
    for (const span of spans) {
      const start = Math.round((span.start_smp - offset) * original.sampleRate / SAMPLE_RATE_HZ);
      const end = Math.min(pcm.length, Math.round((span.end_smp - offset) * original.sampleRate / SAMPLE_RATE_HZ));
      if (start >= 0 && start < end) spliceAnnotationPcm(pcm, mono.subarray(start,end), start, end, original.sampleRate, output);
    }
  }
  return result;
}
