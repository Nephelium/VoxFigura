import { msToSamples, type Clip, type Syllable } from '@vocalcut/core';
import { buildSegmentsForSyllable, estimateSyllableNaturalDurationMs, splitIpaToPhonemes } from '@/components/research/research-utils';
import { buildSyllableQtaTargets, parseIpaSuprasegmentals, phoneTraits } from '@/data/ipa-segments';
import { speechPhoneDurations } from '@/data/speech-timing';
import { fetchIpaReferences, findTargetInterval, ipaReferenceUrl, matchingIpaReferences } from '@/data/ipa-reference-library';
import { findQuickIpaTake } from '@/components/research/quick-ipa';
import { listIpaPersonalRecordings } from '@/data/ipa-personal-recordings';
import { RECORDED_IPA_SET_ID, selectedIpaPoseSetId } from '@/data/ipa-pose-sets';
import { synthesisGainMode } from '@/data/voice-renderer';

export function buildSourcePronunciation(ipa: string, speaker: string, voiceId: string, f0Hz: number): Clip {
  const chunks = ipa.split(/[.\s]+|(?<!^)(?=[ˈˌ])/u)
    .map(text => ({ text, phones: splitIpaToPhonemes(text) }))
    .filter(chunk => chunk.phones.length);
  const syllables: Record<string, Syllable> = {};
  let start = 0;
  for (const [index, chunk] of chunks.entries()) {
    const id = `source_${index + 1}`;
    const prosody = parseIpaSuprasegmentals(chunk.text, { allowAsciiDigits: true });
    const speechPhoneMs = speechPhoneDurations(chunk.phones, chunks[index - 1]?.phones.at(-1), chunks[index + 1]?.phones[0]);
    const end = start + msToSamples(estimateSyllableNaturalDurationMs(chunk.phones, prosody.durationScale, 1, speechPhoneMs));
    const segments = buildSegmentsForSyllable(id, chunk.phones, start, end, speaker, selectedIpaPoseSetId.value, { speechPhoneMs });
    const finalStop = segments.at(-1)?.stop_timing;
    if (prosody.checked && finalStop) {
      finalStop.release_ms = 1;
      finalStop.aspiration_ms = 0;
      finalStop.vot_ms = Math.min(1, finalStop.vot_ms);
    }
    syllables[id] = {
      id, text: chunk.text, ipa: chunk.phones, start_smp: start, end_smp: end,
      nucleus_index: Math.max(0, segments.findIndex(segment => segment.role === 'nucleus')),
      tone_levels: prosody.effectiveTone,
      anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
      segments,
      targets: buildSyllableQtaTargets(id, start, end, {
        effectiveTone: prosody.effectiveTone, stress: prosody.stress,
        stepOffsetSt: prosody.stepOffsetSt, fRefHz: f0Hz, voiced: segments.some(segment => segment.voiced),
      }),
      overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
    };
    start = end;
  }
  return {
    id: 'explore-source', kind: 'phrase', voice_id: voiceId, start_smp: 0, end_smp: start,
    syllable_order: Object.keys(syllables), syllables, variants: ['synth'], active_variant: 'synth',
  };
}

let referenceIndex: ReturnType<typeof fetchIpaReferences> | undefined;

export async function loadSourcePhoneRecording(
  ipa: string, decoder: BaseAudioContext, signal: AbortSignal,
): Promise<{ buffer: AudioBuffer; start: number; end: number } | undefined> {
  referenceIndex ??= fetchIpaReferences().then(items => {
    if (!items.length) referenceIndex = undefined;
    return items;
  }).catch(() => {
    referenceIndex = undefined;
    return [];
  });
  const setId = selectedIpaPoseSetId.value;
  const [references, personal] = await Promise.all([
    referenceIndex,
    setId === RECORDED_IPA_SET_ID ? undefined : listIpaPersonalRecordings(setId).catch(() => undefined),
  ]);
  signal.throwIfAborted();
  const matching = matchingIpaReferences(references, [ipa], false, id => !!personal?.has(id));
  const own = matching.find(item => personal?.has(item.id));
  const vowel = phoneTraits(ipa).vowel;
  const medial = vowel || own ? undefined : findQuickIpaTake(matching, { symbol: ipa, category: 'consonant', nameZh: ipa });
  const reference = own ?? medial?.reference ?? matching[0];
  if (!reference) return undefined;
  let recording = personal?.get(reference.id);
  if (!recording) {
    const url = ipaReferenceUrl(reference.id, 'audio', synthesisGainMode.value);
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!response.ok) return undefined;
    recording = await response.blob();
  }
  const buffer = await decoder.decodeAudioData(await recording.arrayBuffer());
  signal.throwIfAborted();
  const target = vowel && !own ? findTargetInterval(reference, false) : undefined;
  const start = medial?.start ?? target?.start_s ?? 0;
  const end = Math.min(buffer.duration, medial?.end ?? target?.end_s ?? buffer.duration);
  return end > start ? { buffer, start, end } : undefined;
}
