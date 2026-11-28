export const TARGET_VOICED_PEAK = .58;
export const SILENCE_PEAK_GATE = .003;
export const MAX_MAKEUP_GAIN = 3;
const gainCache = new WeakMap<AudioBuffer, number>();
const ceilingCurve = Float32Array.from({ length: 2049 }, (_, index) => softLimitVoiceSample(index / 1024 - 1));

export function softLimitVoiceSample(sample: number): number {
  const magnitude = Math.abs(sample);
  return magnitude <= .8 ? sample : Math.sign(sample) * (.8 + .18 * Math.tanh((magnitude - .8) / .18));
}

/**
 * Estimate a bounded makeup gain from active 40 ms windows.
 * - Silence / noise floor below SILENCE_PEAK_GATE stays at 1x.
 * - Normal voiced speech is scaled toward TARGET_VOICED_PEAK (~0.58).
 * - Quiet voiceless segments are capped by MAX_MAKEUP_GAIN (3x) so natural
 *   voiced/voiceless loudness contrast is preserved.
 */
export function measureVoicePlaybackGain(channels: readonly Float32Array[], sampleRate: number): number | undefined {
  if (!channels.length) return;
  const window = Math.max(1, Math.round(sampleRate * .04));
  const peaks: number[] = [];
  let maxPeak = 0;
  const length = channels[0].length;
  for (let start = 0; start < length; start += window) {
    const end = Math.min(length, start + window);
    let winPeak = 0;
    for (const channel of channels) {
      for (let i = start; i < end; i++) {
        const a = Math.abs(channel[i]);
        if (a > winPeak) winPeak = a;
      }
    }
    if (!Number.isFinite(winPeak)) continue;
    peaks.push(winPeak);
    if (winPeak > maxPeak) maxPeak = winPeak;
  }
  if (maxPeak < SILENCE_PEAK_GATE) return;
  const gate = Math.max(SILENCE_PEAK_GATE, maxPeak * .1);
  const active = peaks.filter((p) => p >= gate).sort((a, b) => a - b);
  if (!active.length) return;
  const refPeak = active[Math.min(active.length - 1, Math.floor((active.length - 1) * .9))];
  if (!Number.isFinite(refPeak) || refPeak < SILENCE_PEAK_GATE) return;
  return Math.max(1, Math.min(MAX_MAKEUP_GAIN, TARGET_VOICED_PEAK / refPeak));
}

export function voicePlaybackGain(buffer: AudioBuffer): number {
  const cached = gainCache.get(buffer);
  if (cached !== undefined) return cached;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  const gain = measureVoicePlaybackGain(channels, buffer.sampleRate) ?? 1;
  gainCache.set(buffer, gain);
  return gain;
}

export function createPlaybackCeiling(context: BaseAudioContext) {
  const ceiling = context.createWaveShaper();
  ceiling.curve = ceilingCurve;
  return ceiling;
}

export function createVoicePlaybackBus(context: BaseAudioContext, destination: AudioNode = context.destination) {
  const input = context.createGain();
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 3;
  limiter.ratio.value = 18;
  limiter.attack.value = .003;
  limiter.release.value = .07;
  const ceiling = createPlaybackCeiling(context);
  input.connect(limiter).connect(ceiling).connect(destination);
  return {
    input,
    dispose() { input.disconnect(); limiter.disconnect(); ceiling.disconnect(); },
  };
}
