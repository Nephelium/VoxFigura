import type { M27TrajectoryAnim } from '@vocalcut/model-adapters';
import { synthesisGainMode } from '@/data/voice-renderer';
import { defaultTractParams, VTL_PARAM_ORDER } from '@/stores/workbench';

export const IPA_RECORDING_HZ = 50;
export interface RecordingKeyframe { frame: number; radius: number; values: Record<string, number> }
export interface RecordingParameter { key: string; index: number; min: number; max: number }
export interface RecordingLimits { fields: RecordingParameter[]; fps: number; max_radius: number }
export interface RecordingTrack { animation: M27TrajectoryAnim; m27_50hz_pa: number[][] }
export interface RecordingRevision extends RecordingTrack { audio: Blob; mode: 'neural' | 'physical' }

type SavedKeyframes = { size: number; keyframes: RecordingKeyframe[] };
const prefix = 'vocalcut.ipa.recording-keyframes.v1';
const key = (kit: string, recording: string) => `${prefix}:${kit}:${recording}`;
export const signatureForKeyframes = (frames: readonly RecordingKeyframe[]) => JSON.stringify(frames);

export function loadRecordingKeyframes(kit: string, recording: string, size: number): RecordingKeyframe[] {
  try {
    const stored: SavedKeyframes = JSON.parse(localStorage.getItem(key(kit, recording)) ?? 'null');
    if (stored?.size !== size || !Array.isArray(stored.keyframes)) return [];
    return stored.keyframes.filter(point => Number.isInteger(point?.frame) && point.frame >= 0 && point.frame < size
      && Number.isInteger(point.radius) && point.radius >= 0 && point.radius <= 50 && point.values
      && typeof point.values === 'object' && Object.values(point.values).every(Number.isFinite));
  } catch {
    return [];
  }
}

export function saveRecordingKeyframes(kit: string, recording: string, size: number, keyframes: RecordingKeyframe[]): void {
  localStorage.setItem(key(kit, recording), JSON.stringify({ size, keyframes } satisfies SavedKeyframes));
}

export function recordingFrameAt(seconds: number, size: number): number {
  return Math.max(0, Math.min(size - 1, Math.round(seconds * IPA_RECORDING_HZ)));
}

export function editedRecordingRow(base: readonly number[], frame: number, keyframes: RecordingKeyframe[], fields: RecordingParameter[]): number[] {
  const pinned = keyframes.find(point => point.frame === frame)?.values ?? {};
  const sums = Array<number>(base.length).fill(0);
  const weights = Array<number>(base.length).fill(0);
  for (const point of keyframes) {
    const distance = Math.abs(point.frame - frame);
    if (!distance || !point.radius || distance >= point.radius) continue;
    const weight = (.5 + .5 * Math.cos(Math.PI * distance / point.radius));
    for (const field of fields) {
      const value = point.values[field.key];
      if (value === undefined) continue;
      weights[field.index] += weight;
      sums[field.index] += weight * value;
    }
  }
  const result = [...base];
  for (const { key, index } of fields) {
    const mass = weights[index];
    result[index] = pinned[key] ?? (base[index] * Math.max(0, 1 - mass) + sums[index]) / Math.max(1, mass);
  }
  return result;
}

const tractIndexes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18];
export function recordingTractParams(row: readonly number[]) {
  const pose = defaultTractParams();
  tractIndexes.forEach((index, dimension) => {
    if (Number.isFinite(row[dimension])) pose[VTL_PARAM_ORDER[index]] = row[dimension];
  });
  return pose;
}

export async function fetchRecordingLimits(): Promise<RecordingLimits> {
  const response = await fetch('/api/models/ipa-recording-edits/limits', { signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok || !data.ok || data.fps !== IPA_RECORDING_HZ || data.fields?.length !== 27) throw new Error('关键帧参数范围暂不可用');
  return data as RecordingLimits;
}

export async function renderRecordingRevision(recording: string, keyframes: RecordingKeyframe[], mode: 'neural' | 'physical',
  device: 'cpu' | 'cuda', signal: AbortSignal): Promise<RecordingRevision> {
  const response = await fetch('/api/models/ipa-recording-edits/render', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
    body: JSON.stringify({ recording_id: recording, keyframes, mode, device, audio_gain: synthesisGainMode.value }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error?.hint ?? '本地修订重合成失败');
  const wave = Uint8Array.from(atob(data.wav_base64), value => value.charCodeAt(0));
  return { animation: data.animation, m27_50hz_pa: data.m27_50hz_pa, mode: data.mode,
    audio: new Blob([wave], { type: 'audio/wav' }) };
}
