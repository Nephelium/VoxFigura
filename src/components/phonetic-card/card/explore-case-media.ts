import { SAMPLE_RATE_HZ } from '@vocalcut/core';
import { cardOptions } from '@vocalcut/edition';
import {
  loadReferenceGeometry,
  referenceFrame,
  type ReferenceClip,
  type ReferenceFrame,
} from '@/data/reference-geometry';
import { applyPeakAudioGain, synthesisGainMode } from '@/data/voice-renderer';
import { computeAnalyticalMetrics, tractArray19ToRecord, type TractMetrics } from '@/stores/workbench';
import { publicAssetUrl } from '@/utils/asset-url';
import { samplePair } from '../samples';

const SWAN_SLICE = {
  A: { start_s: 2160 / SAMPLE_RATE_HZ, end_s: 26400 / SAMPLE_RATE_HZ },
  B: { start_s: 8880 / SAMPLE_RATE_HZ, end_s: 42240 / SAMPLE_RATE_HZ },
} as const;

const PREWARM_WAV_BY_CASE: Readonly<Record<string, string>> = {
  swan: publicAssetUrl('prewarm/suan_mandarin.mp3'),
  creaky: publicAssetUrl('prewarm/creaky_vs_breathy.mp3'),
  khoomei: publicAssetUrl('prewarm/overtone_khoomei.mp3'),
  cantonese: publicAssetUrl('prewarm/cantonese_checked.mp3'),
  voqs: publicAssetUrl('prewarm/voqs_quality.mp3'),
};

const resolvedClips = new Map<string, ReferenceClip>();
const inflightClips = new Map<string, Promise<ReferenceClip | null>>();
const decodedAudioCache = new Map<string, Promise<AudioBuffer | null>>();

function fetchClipCached(sampleId: string): Promise<ReferenceClip | null> {
  if (!sampleId) return Promise.resolve(null);
  const ready = resolvedClips.get(sampleId);
  if (ready) return Promise.resolve(ready);
  const pending = inflightClips.get(sampleId);
  if (pending) return pending;
  const req = loadReferenceGeometry(sampleId)
    .then((clip) => {
      resolvedClips.set(sampleId, clip);
      return clip;
    })
    .catch(() => null);
  inflightClips.set(sampleId, req);
  return req;
}

export async function prefetchExploreCaseClips(caseId: string): Promise<{
  clipA: ReferenceClip | null;
  clipB: ReferenceClip | null;
}> {
  const pair = samplePair(caseId);
  const [clipA, clipB] = await Promise.all([
    fetchClipCached(pair.a),
    pair.b === pair.a ? fetchClipCached(pair.a) : fetchClipCached(pair.b),
  ]);
  return { clipA, clipB };
}

export function sampleExploreCaseFrames(
  caseId: string,
  phase01: number,
): {
  frameA: ReferenceFrame | null;
  frameB: ReferenceFrame | null;
  clipA: ReferenceClip | null;
  clipB: ReferenceClip | null;
} {
  const pair = samplePair(caseId);
  const clipA = resolvedClips.get(pair.a) ?? null;
  const clipB = resolvedClips.get(pair.b) ?? null;
  const u = Math.max(0, Math.min(1, phase01));

  const pickAt = (clip: ReferenceClip | null): ReferenceFrame | null => {
    if (!clip || !clip.geometry_frames.length) return null;
    const lastT = clip.geometry_frames[clip.geometry_frames.length - 1]?.t_s ?? 0;
    // For suan/swan, skip the initial static /s/ pad slightly only when u > 0 so frame 0 starts cleanly and scrubbing spans full articulation
    const t = lastT * u;
    return referenceFrame(clip, t);
  };

  return {
    frameA: pickAt(clipA),
    frameB: pickAt(clipB),
    clipA,
    clipB,
  };
}

/**
 * Converts a prewarm `ReferenceFrame` into full `TractMetrics` (real VTL 2.4 H(f) transfer_fn,
 * A(x) area_fn, and resonance peaks) so both A and B charts animate accurately on every scrub frame.
 */
export function referenceFrameToTractMetrics(frame: ReferenceFrame): TractMetrics {
  const fallback = computeAnalyticalMetrics(tractArray19ToRecord(frame.params));
  const transfer_fn =
    frame.frequency_hz?.length && frame.transfer_db?.length
      ? frame.frequency_hz.map((f_hz, i) => ({
          f_hz,
          db: Number.isFinite(frame.transfer_db[i]) ? frame.transfer_db[i] : -30,
        }))
      : fallback.transfer_fn;

  const area_fn: Array<{ x_cm: number; area_cm2: number }> = [];
  if (frame.tube_areas?.length) {
    let x = 0;
    let minArea = Infinity;
    let minX = fallback.amin_x_cm;
    for (let i = 0; i < frame.tube_areas.length; i++) {
      const len = frame.tube_lengths?.[i] ?? 0.34;
      const area = frame.tube_areas[i];
      const midX = x + len * 0.5;
      area_fn.push({ x_cm: Number(midX.toFixed(3)), area_cm2: area });
      if (area < minArea) {
        minArea = area;
        minX = midX;
      }
      x += len;
    }
    const peaks = (frame.resonances_hz ?? []).filter((f) => Number.isFinite(f) && f > 50);
    return {
      f1_hz: Math.round(peaks[0] ?? fallback.f1_hz),
      f2_hz: Math.round(peaks[1] ?? fallback.f2_hz),
      f3_hz: Math.round(peaks[2] ?? fallback.f3_hz),
      peaks_hz: peaks.length ? peaks.map((p) => Math.round(p)) : fallback.peaks_hz,
      amin_cm2: Number.isFinite(frame.oral_min_area_cm2) ? frame.oral_min_area_cm2 : minArea,
      amin_x_cm: Number(minX.toFixed(2)),
      area_fn,
      transfer_fn,
      source: 'vtl-engine',
    };
  }

  return {
    ...fallback,
    transfer_fn,
  };
}

export function exploreCaseNaturalDurationSec(caseId: string, compare: boolean): number {
  if (caseId === 'swan') return compare || !cardOptions.recordings ? 0.85 : 0.66;
  if (caseId === 'creaky') return cardOptions.recordings ? (compare ? 2.1 : 1.0) : 1.5;
  const pair = samplePair(caseId);
  const clip = resolvedClips.get(pair.a);
  const lastT = clip?.geometry_frames.at(-1)?.t_s;
  if (lastT && lastT > 0.2) return Number(lastT.toFixed(2));
  if (caseId === 'khoomei') return 1.6;
  if (caseId === 'cantonese') return 1.1;
  if (caseId === 'voqs') return 1.5;
  return 2.4;
}

function fetchAndDecodeAudioUrl(url: string): Promise<AudioBuffer | null> {
  if (typeof OfflineAudioContext === 'undefined' && typeof AudioContext === 'undefined') {
    return Promise.resolve(null);
  }
  const hit = decodedAudioCache.get(url);
  if (hit) return hit;
  const p = (async (): Promise<AudioBuffer | null> => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const ab = await resp.arrayBuffer();
      const ctx = new OfflineAudioContext(1, 48000, SAMPLE_RATE_HZ);
      return await ctx.decodeAudioData(ab);
    } catch {
      return null;
    }
  })();
  decodedAudioCache.set(url, p);
  return p;
}

function sliceMonoSegment(buf: AudioBuffer, start_s: number, end_s: number): Float32Array {
  const sr = buf.sampleRate;
  const s0 = Math.max(0, Math.min(buf.length - 1, Math.round(start_s * sr)));
  const s1 = Math.max(s0 + 1, Math.min(buf.length, Math.round(end_s * sr)));
  const len = s1 - s0;
  const src = buf.getChannelData(0);
  const out = new Float32Array(len);
  out.set(src.subarray(s0, s1));
  // Short 8ms fade-in/out to avoid click
  const fade = Math.min(Math.floor(len / 8), Math.round(sr * 0.008));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    out[i] *= g;
    out[len - 1 - i] *= g;
  }
  return out;
}

function normalizePeakFloat(data: Float32Array, target = 0.86): Float32Array {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-4) return data;
  const gain = target / peak;
  for (let i = 0; i < data.length; i++) data[i] *= gain;
  return data;
}

/**
 * Resolves the genuine Explore page audio for built-in Explore cases
 * (`算 vs swan` stereo L/R real recordings, `常态 vs 气声` real takes, or prewarm case WAVs).
 */
export async function resolveExploreCaseAudioBuffer(
  caseId: string,
  compare: boolean,
  rangeDuration_s: number,
): Promise<AudioBuffer | null> {
  const recordings = cardOptions.recordings;
  if (caseId === 'swan' && recordings) {
    const [bufA, bufB] = await Promise.all([
      fetchAndDecodeAudioUrl(recordings.suan),
      compare ? fetchAndDecodeAudioUrl(recordings.swan) : Promise.resolve(null),
    ]);
    if (!bufA) return null;
    const sr = bufA.sampleRate;
    const segA = sliceMonoSegment(bufA, SWAN_SLICE.A.start_s, SWAN_SLICE.A.end_s);
    if (synthesisGainMode.value === 'peak') normalizePeakFloat(segA);

    if (compare && bufB) {
      const segB = sliceMonoSegment(bufB, SWAN_SLICE.B.start_s, SWAN_SLICE.B.end_s);
      if (synthesisGainMode.value === 'peak') normalizePeakFloat(segB);
      // Match ExploreLabView: simultaneous stereo comparison (Left = 算, Right = swan) at natural speed!
      const naturalLen = Math.max(segA.length, segB.length);
      const outLen = Math.max(naturalLen, Math.round(Math.min(rangeDuration_s, 1.2) * sr));
      const stereo = new AudioBuffer({ length: outLen, numberOfChannels: 2, sampleRate: sr });
      stereo.getChannelData(0).set(segA, 0);
      stereo.getChannelData(1).set(segB, 0);
      return stereo;
    }

    const mono = new AudioBuffer({ length: segA.length, numberOfChannels: 1, sampleRate: sr });
    mono.getChannelData(0).set(segA, 0);
    return mono;
  }

  if (caseId === 'creaky' && recordings) {
    const [bufA, bufB] = await Promise.all([
      fetchAndDecodeAudioUrl(recordings.modal),
      compare ? fetchAndDecodeAudioUrl(recordings.breathy) : Promise.resolve(null),
    ]);
    if (!bufA) return null;
    if (compare && bufB) {
      const sr = bufA.sampleRate;
      const gap = Math.round(sr * 0.12);
      const joined = new AudioBuffer({
        length: bufA.length + gap + bufB.length,
        numberOfChannels: 1,
        sampleRate: sr,
      });
      joined.getChannelData(0).set(bufA.getChannelData(0), 0);
      joined.getChannelData(0).set(bufB.getChannelData(0), bufA.length + gap);
      if (synthesisGainMode.value === 'peak') applyPeakAudioGain(joined);
      return joined;
    }
    return bufA;
  }

  const wavUrl = PREWARM_WAV_BY_CASE[caseId];
  if (wavUrl) {
    const buf = await fetchAndDecodeAudioUrl(wavUrl);
    if (buf) return buf;
  }
  return null;
}
