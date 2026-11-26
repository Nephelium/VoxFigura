import { describe, expect, it } from 'vitest';
import { msToSamples, samplesToMs, type Clip, type F0PinSegment, type PhonationAnchor } from '@vocalcut/core';
import { parseIpaSuprasegmentals, phoneTraits } from '@/data/ipa-segments';
import { buildSpeechProsodyClipData, type ProsodyPredictionPayload } from '@/data/prosody-model';
import { connectedRuleDurationScale, rescaleClipForSpeechRate, speechDurationScale, speechPhoneDurations } from '@/data/speech-timing';
import { estimateSyllableNaturalDurationMs, splitIpaToPhonemes } from '@/components/research/research-utils';

const SAMPLE_PREDICTION: ProsodyPredictionPayload = {
  ok: true,
  syllables: [
    { id: 'syl_1', text: '春', tone: '55', candidates: [{ ipa_display: 'tʂʰwən' }] },
    { id: 'syl_2', text: '江', tone: '55', candidates: [{ ipa_display: 'tɕjaŋ' }] },
  ],
  keyframes: [
    { ipa: 'tʂ', duration_ms: 40, f0_hz: 210, role: 'closure', syl_id: 'syl_1' },
    { ipa: 'tʂʰ', duration_ms: 60, f0_hz: 210, role: 'aspiration', syl_id: 'syl_1' },
    { ipa: 'ə', duration_ms: 140, f0_hz: 220, role: 'nucleus', syl_id: 'syl_1' },
    { ipa: 'n', duration_ms: 90, f0_hz: 218, role: 'coda', syl_id: 'syl_1' },
    { ipa: 'tɕ', duration_ms: 14, f0_hz: 215, role: 'closure', syl_id: 'syl_2' },
    { ipa: 'tɕ', duration_ms: 16, f0_hz: 215, role: 'release', syl_id: 'syl_2' },
    { ipa: 'a', duration_ms: 160, f0_hz: 225, role: 'nucleus', syl_id: 'syl_2' },
    { ipa: 'ŋ', duration_ms: 80, f0_hz: 220, role: 'coda', syl_id: 'syl_2' },
  ],
  f0_knots: [
    { t: 0.1, hz: 220 },
    { t: 0.33, hz: 218 },
    { t: 0.52, hz: 225 },
  ],
};

describe('speech rate scaling for Text2Prosody-Lite and live timeline rescaling', () => {
  it('scales Text2Prosody-Lite syllable durations and F0 knots according to speechRate while protecting stop floors', () => {
    const medium = buildSpeechProsodyClipData(SAMPLE_PREDICTION, 'JD2', speechDurationScale.medium);
    const fast = buildSpeechProsodyClipData(SAMPLE_PREDICTION, 'JD2', speechDurationScale.fast);
    const slow = buildSpeechProsodyClipData(SAMPLE_PREDICTION, 'JD2', speechDurationScale.slow);

    expect(fast.totalSmp).toBeLessThan(medium.totalSmp * 0.72);
    expect(slow.totalSmp).toBeGreaterThan(medium.totalSmp * 1.55);

    // Rigid stop floor preserved on fast rate (14 ms * 0.58 = 8.12 -> floored to 10 ms closure)
    const fastStop = fast.syllables.syl_2.segments[0].stop_timing;
    expect(fastStop).toBeDefined();
    expect(fastStop!.closure_ms).toBeGreaterThanOrEqual(10);
    expect(fastStop!.release_ms).toBeGreaterThanOrEqual(1);

    // F0 pins cover the exact scaled clip duration
    expect(fast.pitch.at(-1)!.t_smp).toBe(fast.totalSmp);
    expect(slow.pitch.at(-1)!.t_smp).toBe(slow.totalSmp);
  });

  it('rescales an existing synthetic clip, F0 pins, and phonation anchors cleanly on live speechRate change', () => {
    const medium = buildSpeechProsodyClipData(SAMPLE_PREDICTION, 'JD2', 1);
    const clip: Clip = {
      id: 'clip_1',
      kind: 'phrase',
      voice_id: 'voice_1',
      start_smp: 0,
      end_smp: medium.totalSmp,
      variants: ['synth'],
      active_variant: 'synth',
      syllable_order: medium.syllableOrder,
      syllables: medium.syllables,
    };
    const anchors: Record<string, PhonationAnchor> = {
      a1: { id: 'a1', t_smp: Math.round(medium.totalSmp * 0.5), regime: 'breathy', blend: 1 },
    };
    const pins: F0PinSegment[] = [
      { id: 'p1', start_smp: 0, end_smp: medium.totalSmp, points: medium.pitch, transition_ms: 30, exit_fit_ms: 35 },
    ];

    const fastRes = rescaleClipForSpeechRate(clip, { phonation_anchors: anchors, f0_pins: pins }, speechDurationScale.fast);
    expect(fastRes.clip.end_smp).toBeLessThan(clip.end_smp * 0.72);
    expect(fastRes.retimed.phonation_anchors.a1.t_smp).toBeLessThan(anchors.a1.t_smp);
    expect(fastRes.retimed.f0_pins[0].end_smp).toBe(fastRes.clip.end_smp);

    const stopTiming = fastRes.clip.syllables.syl_2.segments[0].stop_timing;
    expect(stopTiming).toBeDefined();
    expect(stopTiming!.closure_ms).toBeGreaterThanOrEqual(10);
    expect(stopTiming!.release_ms).toBeGreaterThanOrEqual(1);
    expect(samplesToMs(fastRes.clip.syllables.syl_2.segments[0].end_smp - fastRes.clip.syllables.syl_2.segments[0].start_smp))
      .toBeGreaterThanOrEqual(11);

    const slowRes = rescaleClipForSpeechRate(clip, { phonation_anchors: anchors, f0_pins: pins }, speechDurationScale.slow);
    expect(slowRes.clip.end_smp).toBeGreaterThan(clip.end_smp * 1.55);
    expect(msToSamples(1)).toBeGreaterThan(0);
  });

  it('keeps isolated [a] clear while compressing multi-phone IPA / VoQS tokens into natural medium-rate timing', () => {
    const singleA = ['a'];
    const singleADur = estimateSyllableNaturalDurationMs(
      singleA,
      connectedRuleDurationScale(singleA, 1, 'ipa'),
      speechDurationScale.medium,
      speechPhoneDurations(singleA),
    );
    expect(singleADur).toBeGreaterThanOrEqual(200);

    const maPhones = splitIpaToPhonemes('ma');
    const maDur = estimateSyllableNaturalDurationMs(
      maPhones,
      connectedRuleDurationScale(maPhones, 1, 'ipa'),
      speechDurationScale.medium,
      speechPhoneDurations(maPhones),
    );
    expect(maDur).toBeGreaterThanOrEqual(220);
    expect(maDur).toBeLessThanOrEqual(310);

    const phraseTokens = ['ˈnɔ˞məl', 'ˈvɔɪs', 'fɔlˈsɛtoʊ', 'ˈwɪspəɹʷi'];
    const mediumSpeechMs = phraseTokens.reduce((sum, raw) => {
      const phones = splitIpaToPhonemes(raw);
      const supraseg = parseIpaSuprasegmentals(raw);
      return sum + estimateSyllableNaturalDurationMs(
        phones,
        connectedRuleDurationScale(phones, supraseg.durationScale, 'ipa'),
        speechDurationScale.medium,
        speechPhoneDurations(phones),
      );
    }, 0);
    // Compressed from ~4.3s down into natural ~1.9-2.7s speech duration (plus pauses)
    expect(mediumSpeechMs).toBeGreaterThanOrEqual(1800);
    expect(mediumSpeechMs).toBeLessThanOrEqual(2700);

    // Rigid floor invariants stay valid even at fast rate (0.58)
    for (const raw of phraseTokens) {
      const phones = splitIpaToPhonemes(raw);
      const supraseg = parseIpaSuprasegmentals(raw);
      const fastMs = estimateSyllableNaturalDurationMs(
        phones,
        connectedRuleDurationScale(phones, supraseg.durationScale, 'ipa'),
        speechDurationScale.fast,
        speechPhoneDurations(phones),
      );
      const floorMs = phones.reduce((sum, sym) => sum + (phoneTraits(sym).stop ? 12 : 15), 0);
      expect(fastMs).toBeGreaterThanOrEqual(floorMs);
    }
  });
});
