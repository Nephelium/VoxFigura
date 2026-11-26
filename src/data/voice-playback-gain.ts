const ACTIVE_RMS_TARGET = .16;
const MIN_FRAME_POWER = .001 ** 2;
const MAX_MAKEUP_GAIN = 12;
const gainCache = new WeakMap<AudioBuffer, number>();
const ceilingCurve = Float32Array.from({ length: 2049 }, (_, index) => softLimitVoiceSample(index / 1024 - 1));

export function softLimitVoiceSample(sample: number): number {
  const magnitude = Math.abs(sample);
  return magnitude <= .8 ? sample : Math.sign(sample) * (.8 + .18 * Math.tanh((magnitude - .8) / .18));
}

/** Estimate one makeup gain from active audio, with silence excluded. */
export function measureVoicePlaybackGain(channels: readonly Float32Array[], sampleRate: number): number | undefined {
  if (!channels.length) return;
  const window = Math.max(1, Math.round(sampleRate * .04));
  const frames: number[] = [];
  let strongest = 0;
  const length = channels[0].length;
  for (let start = 0; start < length; start += window) {
    const end = Math.min(length, start + window);
    let energy = 0;
    for (const channel of channels) {
      for (let i = start; i < end; i++) energy += channel[i] * channel[i];
    }
    const power = energy / ((end - start) * channels.length);
    if (!Number.isFinite(power)) continue;
    frames.push(power);
    strongest = Math.max(strongest, power);
  }
  if (strongest < MIN_FRAME_POWER) return;
  const gate = Math.max(MIN_FRAME_POWER, strongest * .025);
  let power = 0;
  let count = 0;
  for (const frame of frames) {
    if (frame < gate) continue;
    power += frame;
    count++;
  }
  return Math.max(1, Math.min(MAX_MAKEUP_GAIN, ACTIVE_RMS_TARGET / Math.sqrt(power / count)));
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
