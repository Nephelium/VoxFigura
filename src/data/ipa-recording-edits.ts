import type { M27TrajectoryAnim } from '@vocalcut/model-adapters';
import { synthesisGainMode } from '@/data/voice-renderer';
import { defaultTractParams, VTL_PARAM_ORDER } from '@/stores/workbench';

export const IPA_RECORDING_HZ = 50;
export interface RecordingKeyframe { frame: number; radius: number; values: Record<string, number> }
export interface RecordingParameter { key: string; index: number; min: number; max?: number | null; exclusiveMin?: boolean }
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

export function clearRecordingKeyframesForSet(kit: string): void {
  try {
    const scopePrefix = `${prefix}:${kit}:`;
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(scopePrefix)) toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch {
    // ignore storage access error
  }
}

export interface KeyframeExpandError {
  code: 'out_of_range';
  field: string;
  frame: number;
  value: number;
  allowed: { min: number; max?: number | null; exclusiveMin?: boolean };
  hint: string;
}

export type KeyframeExpandResult =
  | { ok: true; keyframes: RecordingKeyframe[] }
  | { ok: false; error: KeyframeExpandError };

/**
 * Raised-cosine bell window `0.5 * (1 + cos(pi * (u - u0) / width))` delta superposition.
 * Evaluates exact user values at pinned frames while preserving onset & offset coarticulatory trajectories.
 */
export function bellSuperimposedRow(
  baseRows: readonly number[][],
  frame: number,
  keyframes: readonly RecordingKeyframe[],
  fields: readonly RecordingParameter[],
): number[] {
  const base = baseRows[frame];
  if (!base) return [];
  if (!fields.length || !keyframes.length) return editedRecordingRow(base, frame, [...keyframes], [...fields]);
  const size = baseRows.length;
  const denom = Math.max(1, size - 1);
  const u = frame / denom;
  const pinned = keyframes.find((point) => point.frame === frame)?.values ?? {};
  const deltaSum = new Float64Array(base.length);

  for (const point of keyframes) {
    const anchorBase = baseRows[point.frame];
    if (!anchorBase) continue;
    let w = 0;
    if (point.frame === frame) {
      w = 1;
    } else if (point.radius > 0) {
      const u0 = point.frame / denom;
      const width = point.radius / denom;
      const du = Math.abs(u - u0);
      if (du < width) {
        w = 0.5 * (1 + Math.cos((Math.PI * (u - u0)) / width));
      }
    }
    if (w <= 0) continue;
    for (const field of fields) {
      const targetVal = point.values[field.key];
      if (targetVal === undefined) continue;
      deltaSum[field.index] += w * (targetVal - anchorBase[field.index]);
    }
  }

  const out = [...base];
  for (const field of fields) {
    if (pinned[field.key] !== undefined) {
      out[field.index] = pinned[field.key]!;
    } else if (deltaSum[field.index] !== 0) {
      out[field.index] = base[field.index] + deltaSum[field.index];
    }
  }
  return out;
}

/**
 * Expand bell-window keyframes to per-frame radius-0 entries for backend rendering.
 * Only emits fields that are actually pinned or receive a non-zero delta at each frame,
 * so untouched out-of-range baseline fields (e.g. unvoiced F0 < 60 Hz) never cause spurious 400 errors.
 * Rejects any modified value that exceeds allowed bounds instead of silently clamping.
 */
export function expandBellKeyframesForRender(
  baseRows: readonly number[][],
  keyframes: readonly RecordingKeyframe[],
  fields: readonly RecordingParameter[],
): KeyframeExpandResult {
  if (!fields.length || !keyframes.length) return { ok: true, keyframes: [...keyframes] };
  const size = baseRows.length;
  const denom = Math.max(1, size - 1);
  const touchedFrames = new Set<number>();
  for (const point of keyframes) {
    if (!Object.keys(point.values).length) continue;
    const r = Math.max(0, point.radius);
    for (let f = Math.max(0, point.frame - r); f <= Math.min(size - 1, point.frame + r); f++) {
      touchedFrames.add(f);
    }
  }

  const expanded: RecordingKeyframe[] = [];
  for (const f of [...touchedFrames].sort((a, b) => a - b)) {
    const base = baseRows[f];
    if (!base) continue;
    const u = f / denom;
    const pinned = keyframes.find((point) => point.frame === f)?.values ?? {};
    const deltaSum = new Float64Array(base.length);
    const activeFieldMask = new Uint8Array(base.length);

    for (const point of keyframes) {
      const anchorBase = baseRows[point.frame];
      if (!anchorBase) continue;
      let w = 0;
      if (point.frame === f) {
        w = 1;
      } else if (point.radius > 0) {
        const u0 = point.frame / denom;
        const width = point.radius / denom;
        const du = Math.abs(u - u0);
        if (du < width) {
          w = 0.5 * (1 + Math.cos((Math.PI * (u - u0)) / width));
        }
      }
      if (w <= 0) continue;
      for (const field of fields) {
        const targetVal = point.values[field.key];
        if (targetVal === undefined) continue;
        const delta = w * (targetVal - anchorBase[field.index]);
        deltaSum[field.index] += delta;
        if (Math.abs(delta) > 1e-9 || point.frame === f) {
          activeFieldMask[field.index] = 1;
        }
      }
    }

    const values: Record<string, number> = {};
    for (const field of fields) {
      const isPinned = pinned[field.key] !== undefined;
      if (!isPinned && !activeFieldMask[field.index]) continue;
      const rawVal = isPinned ? pinned[field.key]! : base[field.index] + deltaSum[field.index];
      const rounded = Number(rawVal.toFixed(6));
      const below = field.exclusiveMin ? rounded <= field.min : rounded < field.min;
      const above = field.max != null && rounded > field.max;
      if (!Number.isFinite(rounded) || below || above) {
        const rangeText = field.max != null ? `[${field.min}, ${field.max}]` : `(> ${field.min})`;
        return {
          ok: false,
          error: {
            code: 'out_of_range',
            field: field.key,
            frame: f,
            value: rounded,
            allowed: {
              min: field.min,
              ...(field.max != null ? { max: field.max } : {}),
              ...(field.exclusiveMin ? { exclusiveMin: true } : {}),
            },
            hint: `第 ${f + 1} 帧的 ${field.key} 叠加结果 ${rounded} 超出允许范围 ${rangeText}，请减小关键帧偏移或余弦升窗半宽`,
          },
        };
      }
      values[field.key] = rounded;
    }

    if (Object.keys(values).length > 0) {
      expanded.push({ frame: f, radius: 0, values });
    }
  }
  return { ok: true, keyframes: expanded };
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
