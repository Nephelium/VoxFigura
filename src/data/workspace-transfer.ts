import { ref, shallowRef } from 'vue';
import type { StageAudioTrack } from '@/components/studio/nle-timeline';
import type { Instrument } from '@/components/studio/instrument-voices';
import type { InstrumentRegion } from '@/components/studio/arranger-audio';
import type { Clip, TextGridDocument } from '@vocalcut/core';
import { useWorkbenchStore } from '@/stores/workbench';

export const arrangerReturn = ref<{clipId:string;partId:string}|null>(null);
export const arrangerSource = ref<string | null>(null);

export interface AnnotationPitch {
  opened?: boolean;
  projectId: string;
  clipId: string;
  startSmp: number;
  endSmp: number;
  points: { t_smp: number; f0_hz: number }[];
}

export const pendingPianoPitch = shallowRef<AnnotationPitch | null>(null);
export const arrangerStageTarget = ref<StageAudioTrack | null>(null);
export const arrangerStageOrigin = ref<WorkspaceAudio['stageOrigin'] | null>(null);

export type AudioDestination = 'studio' | 'arranger' | 'annotation' | 'continuumA' | 'continuumB' | 'm27Align' | 'mixer';

export interface WorkspaceAudio {
  file: File;
  renderedAudio?: AudioBuffer;
  stems?: {sourceClipId:string;partId:string;file:File;audio:AudioBuffer;label:string;clip?:Clip;frames?:{u:number;params:number[]}[];sourceKind?:'ipa-synth'|'audio-reconstruct'}[];
  arrangement?: {
    origin?: {clipId:string;partId:string};
    instrument: Instrument;
    regions?: InstrumentRegion[];
    accompaniment?: { file: File; audio: AudioBuffer; label: string };
  };
  analysisFile?: File;
  rawSourceFile?: File;
  reconstructedFile?: File;
  clip?: Clip;
  textGrid?: TextGridDocument;
  annotationFocusSmp?: number;
  alignmentText?: string;
  m27RowsPa?: number[][];
  label?: string;
  frames?: { u: number; params: number[] }[];
  speakerWavBase64?: string;
  stageAudioTrack?: StageAudioTrack;
  stageAutoplay?: boolean;
  sourceKind?: 'ipa-synth' | 'audio-reconstruct';
  stageOrigin?: { projectId: string; clipId: string; referenceClipId?: string; referenceVoiceId?: string };
}

const pending = new Map<AudioDestination, WorkspaceAudio>();

export function sendWorkspaceAudio(target: AudioDestination, data: WorkspaceAudio) {
  pending.set(target, { ...data, clip: data.clip ? JSON.parse(JSON.stringify(data.clip)) : undefined });
  const store = useWorkbenchStore();
  if (target === 'studio') {
    store.studioTab.value = 'stage';
    store.setWorkspace('studio');
  } else if (target === 'arranger') {
    store.studioTab.value = 'arranger';
    store.setWorkspace('studio');
  } else if (target === 'm27Align') {
    store.researchTab.value = 'm27';
    store.setWorkspace('research');
  } else if (target === 'mixer') {
    store.researchTab.value = 'mixer';
    store.setWorkspace('research');
  } else {
    store.researchTab.value = target === 'annotation' ? 'main' : 'continuum';
    store.setWorkspace('research');
  }
}

export function takeWorkspaceAudio(target: AudioDestination) {
  const data = pending.get(target) ?? null;
  pending.delete(target);
  return data;
}

export function audioBufferFile(buffer: AudioBuffer, name: string): File {
  const channels = buffer.numberOfChannels;
  const data = new ArrayBuffer(44 + buffer.length * channels * 2);
  const view = new DataView(data);
  const text = (offset: number, word: string) => [...word].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, data.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, data.byteLength - 44, true);
  for (let ch = 0; ch < channels; ch++) {
    const samples = buffer.getChannelData(ch);
    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + (i * channels + ch) * 2, Math.round(v * (v < 0 ? 32768 : 32767)), true);
    }
  }
  return new File([data], name.replace(/\.wav$/i, '') + '.wav', { type: 'audio/wav' });
}

/** Parse RIFF/WAVE chunks robustly (skipping JUNK/LIST/fact/odd padding) and return duration in 48 kHz samples. */
export function parseWavDataDurationSmp(bytes: Uint8Array, fallbackRateHz = 16000): number {
  if (bytes.byteLength < 12) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(
    bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3],
  );
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return 0;
  let channels = 1;
  let sampleRate = fallbackRateHz;
  let bitsPerSample = 16;
  let blockAlign = 2;
  let dataBytes = 0;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body > bytes.byteLength) break;
    const avail = Math.min(size, bytes.byteLength - body);
    if (id === 'fmt ' && avail >= 16) {
      channels = Math.max(1, view.getUint16(body + 2, true));
      sampleRate = Math.max(1, view.getUint32(body + 4, true));
      blockAlign = Math.max(1, view.getUint16(body + 12, true));
      bitsPerSample = Math.max(8, view.getUint16(body + 14, true));
    } else if (id === 'data') {
      dataBytes = avail;
      break;
    }
    const step = 8 + ((size + 1) & ~1);
    if (step <= 8) break;
    offset += step;
  }
  if (!dataBytes) return 0;
  const frameBytes = Math.max(blockAlign, channels * Math.ceil(bitsPerSample / 8));
  const rate = sampleRate || fallbackRateHz;
  return Math.round((dataBytes / frameBytes) * 48000 / rate);
}
