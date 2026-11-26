import { computed, ref } from 'vue';
import { SAMPLE_RATE_HZ } from '@vocalcut/core';
import type { SynthesisGainMode } from '@vocalcut/model-adapters';
import { encodeWavFromAudioBuffer } from '@/components/modals/download';

export type VoiceRenderMode = 'physical' | 'neural';
export const PEAK_AUDIO_TARGET = 0.8;
export const MIN_NORMALIZE_PEAK = 1e-5;
const preferenceKey = 'vocalcut.voice-renderer.v1';
function storedPreference(): VoiceRenderMode | null {
  try {
    const value = localStorage.getItem(preferenceKey);
    return value === 'physical' || value === 'neural' ? value : null;
  } catch { return null; }
}
const chosenMode = ref(storedPreference());
export const defaultVoiceRenderMode = ref<VoiceRenderMode>('neural');
export const voiceRenderMode = computed<VoiceRenderMode>({
  get: () => chosenMode.value ?? defaultVoiceRenderMode.value,
  set(mode) {
    chosenMode.value = mode;
    try { localStorage.setItem(preferenceKey, mode); } catch { /* retain this session's selection */ }
  },
});

export const voiceRenderLabels: Record<VoiceRenderMode, string> = {
  neural: 'Tract2Vox-Lite 神经合成',
  physical: 'VTL 2.4 物理合成',
};

const gainPreferenceKey = 'vocalcut.synthesis-gain.v1';
const gainPreference = ref<SynthesisGainMode>('peak');
try {
  if (localStorage.getItem(gainPreferenceKey) === 'original') gainPreference.value = 'original';
} catch { /* Use the default when storage is unavailable. */ }

export const synthesisGainMode = computed<SynthesisGainMode>({
  get: () => gainPreference.value,
  set(mode) {
    gainPreference.value = mode;
    try { localStorage.setItem(gainPreferenceKey, mode); } catch { /* Keep the session preference. */ }
  },
});

export function measureAudioBufferPeak(
  buffer: Pick<AudioBuffer, 'numberOfChannels' | 'getChannelData'>,
): number {
  let peak = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const channel = buffer.getChannelData(ch);
    for (let i = 0; i < channel.length; i++) {
      const a = Math.abs(channel[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

export function applyPeakAudioGain(
  buffer: Pick<AudioBuffer, 'numberOfChannels' | 'getChannelData'>,
  targetPeak = PEAK_AUDIO_TARGET,
): number {
  const peak = measureAudioBufferPeak(buffer);
  if (!Number.isFinite(peak) || peak < MIN_NORMALIZE_PEAK) return 1;
  const gain = targetPeak / peak;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const channel = buffer.getChannelData(ch);
    for (let sample = 0; sample < channel.length; sample++) channel[sample] *= gain;
  }
  return gain;
}

export function parseWavSampleRate(bytes: ArrayBuffer): number | undefined {
  if (bytes.byteLength < 12) return undefined;
  const u8 = new Uint8Array(bytes);
  const view = new DataView(bytes);
  const tag = (off: number) => String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body > bytes.byteLength) break;
    if (id === 'fmt ' && body + 8 <= bytes.byteLength) {
      const rate = view.getUint32(body + 4, true);
      return rate >= 8000 && rate <= 192000 ? rate : undefined;
    }
    const step = 8 + ((size + 1) & ~1);
    if (step <= 8) break;
    offset += step;
  }
  return undefined;
}

export async function normalizeAudioFile(
  blob: Blob,
  filename?: string,
  mode: SynthesisGainMode = synthesisGainMode.value,
): Promise<File> {
  const rawName = filename || (blob instanceof File ? blob.name : 'audio.wav');
  const fallback = blob instanceof File && (!filename || blob.name === filename)
    ? blob
    : new File([blob], rawName, { type: blob.type || 'audio/wav' });
  if (mode === 'original' || typeof OfflineAudioContext === 'undefined') return fallback;
  try {
    const bytes = await blob.arrayBuffer();
    const rate = parseWavSampleRate(bytes) ?? SAMPLE_RATE_HZ;
    const decoded = await new OfflineAudioContext(1, 1, rate).decodeAudioData(bytes.slice(0));
    const peak = measureAudioBufferPeak(decoded);
    if (!Number.isFinite(peak) || peak < MIN_NORMALIZE_PEAK) return fallback;
    applyPeakAudioGain(decoded, PEAK_AUDIO_TARGET);
    const wavName = rawName.replace(/\.[^./\\]+$/, '') + '.wav';
    return new File([encodeWavFromAudioBuffer(decoded)], wavName, { type: 'audio/wav' });
  } catch {
    return fallback;
  }
}
