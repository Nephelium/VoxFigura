import { MIN_NORMALIZE_PEAK, PEAK_AUDIO_TARGET, measureAudioBufferPeak } from '@/data/voice-renderer';

const BLOCK_S = 0.02;

export interface IpaPlaybackGain {
  readonly levels: Float32Array;
  readonly step: number;
  readonly gain: number;
}

export function uniformPeakGain(
  buffer: Pick<AudioBuffer, 'numberOfChannels' | 'getChannelData'>,
  targetPeak = PEAK_AUDIO_TARGET,
): number {
  const peak = measureAudioBufferPeak(buffer);
  if (!Number.isFinite(peak) || peak < MIN_NORMALIZE_PEAK) return 1;
  return targetPeak / peak;
}

/**
 * Compute one uniform whole-clip peak gain (target 0.8 FS) so internal relative
 * dynamics remain completely unchanged across the entire recording.
 */
export function analyzeIpaPlaybackGain(
  buffer: Pick<AudioBuffer, 'sampleRate' | 'length' | 'numberOfChannels' | 'getChannelData'>,
): IpaPlaybackGain {
  const block = Math.max(1, Math.round(buffer.sampleRate * BLOCK_S));
  const gain = uniformPeakGain(buffer, PEAK_AUDIO_TARGET);
  const levels = new Float32Array(Math.max(1, Math.ceil(buffer.length / block)));
  levels.fill(gain);
  return { step: block / buffer.sampleRate, levels, gain };
}

export function ipaGainAt(profile: IpaPlaybackGain | undefined, seconds: number): number {
  if (!profile?.levels.length || !Number.isFinite(seconds)) return 1;
  return profile.gain;
}
