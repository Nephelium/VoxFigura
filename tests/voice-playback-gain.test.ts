import { describe, expect, it } from 'vitest';
import {
  MAX_MAKEUP_GAIN,
  TARGET_VOICED_PEAK,
  measureVoicePlaybackGain,
} from '@/data/voice-playback-gain';

const SR = 48000;

function makeTone(seconds: number, peak: number): Float32Array {
  return Float32Array.from({ length: Math.round(SR * seconds) }, (_, i) =>
    peak * Math.sin((2 * Math.PI * 220 * i) / SR));
}

describe('bounded global voice playback gain', () => {
  it('leaves silence and noise floor untouched', () => {
    const silence = makeTone(0.5, 0.001);
    expect(measureVoicePlaybackGain([silence], SR)).toBeUndefined();
  });

  it('scales normal voiced speech toward ~0.58 peak', () => {
    const voiced = makeTone(0.6, 0.25);
    const gain = measureVoicePlaybackGain([voiced], SR)!;
    expect(gain).toBeCloseTo(TARGET_VOICED_PEAK / 0.25, 2);
    expect(0.25 * gain).toBeGreaterThanOrEqual(0.55);
    expect(0.25 * gain).toBeLessThanOrEqual(0.60);
  });

  it('caps quiet voiceless sounds at MAX_MAKEUP_GAIN so they stay softer than voiced speech', () => {
    const voiceless = makeTone(0.4, 0.06);
    const gain = measureVoicePlaybackGain([voiceless], SR)!;
    expect(gain).toBeCloseTo(MAX_MAKEUP_GAIN, 5);
    expect(0.06 * gain).toBeLessThan(0.25);
  });

  it('does not attenuate audio that already exceeds the target peak', () => {
    const loud = makeTone(0.4, 0.75);
    expect(measureVoicePlaybackGain([loud], SR)).toBe(1);
  });
});
