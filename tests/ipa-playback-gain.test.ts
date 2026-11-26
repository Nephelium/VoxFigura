import { describe, expect, it } from 'vitest';
import { analyzeIpaPlaybackGain, ipaGainAt } from '@/components/research/ipa-playback-gain';
import { applyPeakAudioGain, measureAudioBufferPeak, PEAK_AUDIO_TARGET } from '@/data/voice-renderer';
import { measureVoicePlaybackGain } from '@/data/voice-playback-gain';

function audioFixture(...channels: Float32Array<ArrayBuffer>[]) {
  return {
    sampleRate: 48000,
    length: channels[0]?.length ?? 0,
    numberOfChannels: channels.length,
    getChannelData: (index: number) => channels[index],
  };
}

describe('whole-clip peak audio normalization', () => {
  it('applies one uniform clip-wide gain for IPA playback without altering internal dynamics or mutating input', () => {
    const signal = Float32Array.from({ length: 48000 }, (_, index) => (
      (index < 12000 ? 0.00002 : 0.018) * Math.sin((index * Math.PI) / 40)
    ));
    signal[26000] = 0.12;
    const before = signal.slice();
    const profile = analyzeIpaPlaybackGain(audioFixture(signal));

    const expectedGain = PEAK_AUDIO_TARGET / 0.12;
    expect(profile.gain).toBeCloseTo(expectedGain, 6);
    expect(ipaGainAt(profile, 0.1)).toBeCloseTo(expectedGain, 6);
    expect(ipaGainAt(profile, 0.6)).toBeCloseTo(expectedGain, 6);
    expect(profile.gain * signal[26000]).toBeCloseTo(PEAK_AUDIO_TARGET, 6);
    expect(signal).toEqual(before);
  });

  it('scales multi-channel AudioBuffers uniformly to 0.8 peak while preserving ratios and exact zeros', () => {
    const left = new Float32Array(1000);
    const right = new Float32Array(1000);
    left[200] = 0.05;
    left[500] = -0.2;
    right[500] = 0.1;
    const buffer = audioFixture(left, right) as unknown as AudioBuffer;

    const scale = applyPeakAudioGain(buffer);
    expect(scale).toBeCloseTo(PEAK_AUDIO_TARGET / 0.2, 6);
    expect(measureAudioBufferPeak(buffer)).toBeCloseTo(PEAK_AUDIO_TARGET, 6);
    expect(left[0]).toBe(0);
    expect(right[0]).toBe(0);
    expect(Math.abs(left[500] / left[200])).toBeCloseTo(4, 6);
    expect(Math.abs(left[500] / right[500])).toBeCloseTo(2, 6);
  });

  it('leaves near-silent audio untouched', () => {
    const silent = new Float32Array(256);
    silent[10] = 1e-7;
    const profile = analyzeIpaPlaybackGain(audioFixture(silent));
    expect(profile.gain).toBe(1);

    const scale = applyPeakAudioGain(audioFixture(silent) as unknown as AudioBuffer);
    expect(scale).toBe(1);
    expect(silent[10]).toBeCloseTo(1e-7, 12);
  });
});

describe('arrangement voice makeup gain', () => {
  it('estimates gain from active voice even with a high transient and long rests', () => {
    const voice = Float32Array.from({ length: 48000 }, (_, index) => .035 * Math.sin(index * Math.PI / 20));
    voice[1000] = .8;
    const padded = new Float32Array(144000);
    padded.set(voice, 96000);
    const original = voice.slice();
    const gain = measureVoicePlaybackGain([voice], 48000);
    expect(gain).toBeGreaterThan(5);
    expect(measureVoicePlaybackGain([padded], 48000)).toBeCloseTo(gain!, 6);
    expect(voice).toEqual(original);
  });

  it('keeps loud or silent audio at unity and bounds gain on barely audible input', () => {
    const loud = new Float32Array(48000).fill(.3);
    const faint = new Float32Array(48000).fill(.002);
    expect(measureVoicePlaybackGain([loud], 48000)).toBe(1);
    expect(measureVoicePlaybackGain([faint], 48000)).toBe(12);
    expect(measureVoicePlaybackGain([new Float32Array(48000).fill(.0001)], 48000)).toBeUndefined();
  });
});
