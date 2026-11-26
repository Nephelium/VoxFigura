import type { TextGridDocument, TextGridInterval, TextGridTier } from '@vocalcut/core';
import { audioBufferFile } from '@/data/workspace-transfer';
import type { CurveAlignInterval, MorphKnot } from '@/vendor/m27-voice-morph/curve-editor.js';
import { exciseAudioBufferRange } from './audio-cut';

export interface MixerAnnotationTierView {
  index: number;
  name: string;
  label: string;
  intervals: CurveAlignInterval[];
}

export interface AudioSliceResult {
  file: File;
  duration: number;
}

const MIN_AUDIO_SEC = 0.04;
const MIN_INTERVAL_SEC = 0.02;

function roundSec(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function cloneTextGrid(grid: TextGridDocument): TextGridDocument {
  return JSON.parse(JSON.stringify(grid)) as TextGridDocument;
}

export function extractIntervalTiers(grid: TextGridDocument | null | undefined): MixerAnnotationTierView[] {
  if (!grid) return [];
  const out: MixerAnnotationTierView[] = [];
  grid.tiers.forEach((tier, index) => {
    if (tier.kind !== 'IntervalTier' || !tier.intervals.length) return;
    const isPhone = /phone|phoneme|segment|\bseg\b|ipa|音素|音标/i.test(tier.name);
    const isWord = /syl|word|char|text|音节|词|字/i.test(tier.name);
    const label = isWord ? '音节 / 词层' : isPhone ? '音素层' : tier.name || `标注层 ${index + 1}`;
    out.push({
      index,
      name: tier.name,
      label,
      intervals: tier.intervals.map((iv) => ({ xmin: iv.xmin, xmax: iv.xmax, text: iv.text.trim() })),
    });
  });
  return out;
}

export function countAnnotatedSegments(grid: TextGridDocument | null | undefined): number {
  const tiers = extractIntervalTiers(grid);
  if (!tiers.length) return 0;
  const preferred =
    tiers.find((t) => /syl|word|char|text|音节|词|字/i.test(t.name)) ??
    tiers[0];
  return preferred.intervals.filter((iv) => iv.text && iv.text !== 'sil' && iv.text !== 'sp').length;
}

export function createEqualTextGrid(
  durationSec: number,
  labels: readonly string[],
  tierName = 'words',
): TextGridDocument {
  const dur = Math.max(MIN_AUDIO_SEC, roundSec(durationSec));
  const cleanLabels = labels.map((s) => s.trim()).filter(Boolean);
  const items = cleanLabels.length ? cleanLabels : ['段 1', '段 2', '段 3'];
  const step = dur / items.length;
  const intervals: TextGridInterval[] = items.map((text, idx) => ({
    xmin: idx === 0 ? 0 : roundSec(idx * step),
    xmax: idx === items.length - 1 ? dur : roundSec((idx + 1) * step),
    text,
  }));
  return {
    xmin: 0,
    xmax: dur,
    tiers: [{ kind: 'IntervalTier', name: tierName, xmin: 0, xmax: dur, intervals }],
  };
}

export function cropTextGridKeepRange(
  grid: TextGridDocument,
  keepStartSec: number,
  keepEndSec: number,
): TextGridDocument {
  const s0 = Math.max(0, keepStartSec);
  const s1 = Math.max(s0 + MIN_AUDIO_SEC, keepEndSec);
  const nextDur = roundSec(s1 - s0);
  const tiers: TextGridTier[] = grid.tiers.map((tier) => {
    if (tier.kind !== 'IntervalTier') {
      return {
        ...tier,
        xmin: 0,
        xmax: nextDur,
        points: tier.points
          .filter((pt) => pt.number >= s0 && pt.number <= s1)
          .map((pt) => ({ ...pt, number: roundSec(pt.number - s0) })),
      };
    }
    const kept: TextGridInterval[] = [];
    for (const iv of tier.intervals) {
      const a = Math.max(s0, iv.xmin);
      const b = Math.min(s1, iv.xmax);
      if (b - a < 0.002) continue;
      kept.push({
        xmin: roundSec(a - s0),
        xmax: roundSec(b - s0),
        text: iv.text,
      });
    }
    if (!kept.length) {
      kept.push({ xmin: 0, xmax: nextDur, text: '' });
    } else {
      kept[0].xmin = 0;
      kept[kept.length - 1].xmax = nextDur;
      for (let i = 1; i < kept.length; i++) kept[i].xmin = kept[i - 1].xmax;
    }
    return { ...tier, xmin: 0, xmax: nextDur, intervals: kept };
  });
  return { xmin: 0, xmax: nextDur, tiers };
}

export function exciseTextGridRange(
  grid: TextGridDocument,
  cutStartSec: number,
  cutEndSec: number,
): TextGridDocument {
  const c0 = Math.max(0, Math.min(grid.xmax, cutStartSec));
  const c1 = Math.max(c0, Math.min(grid.xmax, cutEndSec));
  const removed = c1 - c0;
  if (removed < 0.002) return cloneTextGrid(grid);
  const nextDur = Math.max(MIN_AUDIO_SEC, roundSec(grid.xmax - removed));

  const mapTime = (t: number) => (t <= c0 ? t : t >= c1 ? t - removed : c0);

  const tiers: TextGridTier[] = grid.tiers.map((tier) => {
    if (tier.kind !== 'IntervalTier') {
      return {
        ...tier,
        xmin: 0,
        xmax: nextDur,
        points: tier.points
          .filter((pt) => pt.number <= c0 || pt.number >= c1)
          .map((pt) => ({ ...pt, number: roundSec(mapTime(pt.number)) })),
      };
    }
    const nextIntervals: TextGridInterval[] = [];
    for (const iv of tier.intervals) {
      const a = mapTime(iv.xmin);
      const b = mapTime(iv.xmax);
      if (b - a < 0.002) continue;
      nextIntervals.push({
        xmin: roundSec(a),
        xmax: roundSec(b),
        text: iv.text,
      });
    }
    if (!nextIntervals.length) {
      nextIntervals.push({ xmin: 0, xmax: nextDur, text: '' });
    } else {
      nextIntervals[0].xmin = 0;
      nextIntervals[nextIntervals.length - 1].xmax = nextDur;
      for (let i = 1; i < nextIntervals.length; i++) nextIntervals[i].xmin = nextIntervals[i - 1].xmax;
    }
    return { ...tier, xmin: 0, xmax: nextDur, intervals: nextIntervals };
  });
  return { xmin: 0, xmax: nextDur, tiers };
}

export function moveBoundaryInTier(
  grid: TextGridDocument,
  tierIndex: number,
  boundaryIndex: number,
  targetSec: number,
): TextGridDocument {
  const copy = cloneTextGrid(grid);
  const tier = copy.tiers[tierIndex];
  if (!tier || tier.kind !== 'IntervalTier') return copy;
  if (boundaryIndex <= 0 || boundaryIndex >= tier.intervals.length) return copy;
  const left = tier.intervals[boundaryIndex - 1];
  const right = tier.intervals[boundaryIndex];
  const lo = left.xmin + MIN_INTERVAL_SEC;
  const hi = right.xmax - MIN_INTERVAL_SEC;
  if (lo > hi) return copy;
  const next = roundSec(Math.max(lo, Math.min(hi, targetSec)));
  left.xmax = next;
  right.xmin = next;
  return copy;
}

export function updateIntervalLabelInTier(
  grid: TextGridDocument,
  tierIndex: number,
  intervalIndex: number,
  text: string,
): TextGridDocument {
  const copy = cloneTextGrid(grid);
  const tier = copy.tiers[tierIndex];
  if (!tier || tier.kind !== 'IntervalTier' || !tier.intervals[intervalIndex]) return copy;
  tier.intervals[intervalIndex].text = text.trim();
  return copy;
}

export function splitIntervalInTier(
  grid: TextGridDocument,
  tierIndex: number,
  intervalIndex: number,
  splitSec?: number,
): TextGridDocument {
  const copy = cloneTextGrid(grid);
  const tier = copy.tiers[tierIndex];
  if (!tier || tier.kind !== 'IntervalTier' || !tier.intervals[intervalIndex]) return copy;
  const target = tier.intervals[intervalIndex];
  if (target.xmax - target.xmin < MIN_INTERVAL_SEC * 2) return copy;
  const mid =
    splitSec !== undefined && Number.isFinite(splitSec)
      ? roundSec(Math.max(target.xmin + MIN_INTERVAL_SEC, Math.min(target.xmax - MIN_INTERVAL_SEC, splitSec)))
      : roundSec(0.5 * (target.xmin + target.xmax));
  const origEnd = target.xmax;
  target.xmax = mid;
  tier.intervals.splice(intervalIndex + 1, 0, { xmin: mid, xmax: origEnd, text: '' });
  return copy;
}

export function mergeIntervalWithNextInTier(
  grid: TextGridDocument,
  tierIndex: number,
  intervalIndex: number,
): TextGridDocument {
  const copy = cloneTextGrid(grid);
  const tier = copy.tiers[tierIndex];
  if (!tier || tier.kind !== 'IntervalTier') return copy;
  if (intervalIndex < 0 || intervalIndex >= tier.intervals.length - 1) return copy;
  const left = tier.intervals[intervalIndex];
  const right = tier.intervals[intervalIndex + 1];
  left.xmax = right.xmax;
  if (!left.text.trim() && right.text.trim()) {
    left.text = right.text.trim();
  } else if (left.text.trim() && right.text.trim()) {
    left.text = `${left.text.trim()}${right.text.trim()}`;
  }
  tier.intervals.splice(intervalIndex + 1, 1);
  return copy;
}

/**
 * Build strictly monotonic curve knots placing a localized plateau over an annotated interval.
 * When `additive` is true (e.g. Shift+Click), merges the new segment plateau onto existing knots.
 */
export function buildSegmentPlateauKnots(
  existingKnots: readonly MorphKnot[],
  interval: CurveAlignInterval,
  durationSec: number,
  options: { weight?: number; rampSec?: number; additive?: boolean } = {},
): MorphKnot[] {
  const dur = Math.max(MIN_AUDIO_SEC, durationSec);
  const weight = Math.max(0.05, Math.min(1, options.weight ?? 0.9));
  const tStart = Math.max(0, Math.min(1, interval.xmin / dur));
  const tEnd = Math.max(tStart + 0.004, Math.min(1, interval.xmax / dur));
  const segSpan = tEnd - tStart;
  const ramp = Math.min((options.rampSec ?? 0.025) / dur, segSpan * 0.25);
  const minGap = 0.002;

  const plateau: MorphKnot[] = [];
  const leftOut = Math.max(0, tStart - ramp);
  const rightOut = Math.min(1, tEnd + ramp);

  if (leftOut > minGap) {
    plateau.push({ t: 0, v: 0 });
    plateau.push({ t: leftOut, v: 0 });
  }
  plateau.push({ t: tStart <= minGap ? 0 : tStart, v: weight });
  plateau.push({ t: tEnd >= 1 - minGap ? 1 : tEnd, v: weight });
  if (rightOut < 1 - minGap) {
    plateau.push({ t: rightOut, v: 0 });
    plateau.push({ t: 1, v: 0 });
  }

  let merged: MorphKnot[];
  if (!options.additive) {
    merged = plateau;
  } else {
    // Keep existing knots outside `[leftOut, rightOut]` and splice the new plateau cleanly inside
    const outer = existingKnots
      .filter((k) => k.t < leftOut - minGap || k.t > rightOut + minGap)
      .map((k) => ({ ...k }));
    const inner = plateau.filter((k) => k.t >= leftOut - 1e-4 && k.t <= rightOut + 1e-4);
    merged = [...outer, ...inner];
    if (!merged.some((k) => k.t <= 1e-4)) merged.push({ t: 0, v: 0 });
    if (!merged.some((k) => k.t >= 1 - 1e-4)) merged.push({ t: 1, v: 0 });
  }

  merged.sort((a, b) => a.t - b.t);
  const deduped: MorphKnot[] = [];
  for (const knot of merged) {
    const t = Math.max(0, Math.min(1, Number(knot.t.toFixed(4))));
    const v = Math.max(0, Math.min(1, Number(knot.v.toFixed(3))));
    const prev = deduped.at(-1);
    if (!prev) {
      deduped.push({ t, v });
    } else if (t - prev.t < minGap) {
      prev.v = Math.max(prev.v, v);
    } else {
      deduped.push({ t, v });
    }
  }
  if (deduped.length < 2) {
    return [
      { t: 0, v: weight },
      { t: 1, v: weight },
    ];
  }
  deduped[0].t = 0;
  deduped[deduped.length - 1].t = 1;
  return deduped.slice(0, 50);
}

/** Keep only `[keepStartSec, keepEndSec]` from an audio Blob with short raised-cosine edge fades. */
export async function sliceAudioBlobKeepRange(
  blob: Blob,
  keepStartSec: number,
  keepEndSec: number,
  fallbackName: string,
): Promise<AudioSliceResult> {
  const bytes = await blob.arrayBuffer();
  const decoded = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(bytes.slice(0));
  const sr = decoded.sampleRate;
  const s0 = Math.max(0, Math.min(decoded.length, Math.round(keepStartSec * sr)));
  const s1 = Math.max(s0, Math.min(decoded.length, Math.round(keepEndSec * sr)));
  const len = s1 - s0;
  if (len / sr < MIN_AUDIO_SEC) {
    throw new Error('保留选区时长不得短于 0.04 秒');
  }
  const out = new AudioBuffer({
    length: len,
    numberOfChannels: decoded.numberOfChannels,
    sampleRate: sr,
  });
  const fade = Math.min(Math.round(sr * 0.004), Math.floor(len / 4));
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    const src = decoded.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      let sample = src[s0 + i];
      if (fade > 0 && i < fade) {
        sample *= 0.5 * (1 - Math.cos((Math.PI * i) / fade));
      } else if (fade > 0 && i >= len - fade) {
        sample *= 0.5 * (1 - Math.cos((Math.PI * (len - 1 - i)) / fade));
      }
      dst[i] = sample;
    }
  }
  const baseName = (blob instanceof File ? blob.name : fallbackName).replace(/\.[^.]+$/, '') || 'audio';
  return {
    file: audioBufferFile(out, baseName),
    duration: out.duration,
  };
}

/** Excise `[cutStartSec, cutEndSec]` from an audio Blob with crossfade splice. */
export async function exciseAudioBlobRange(
  blob: Blob,
  cutStartSec: number,
  cutEndSec: number,
  fallbackName: string,
): Promise<AudioSliceResult> {
  const bytes = await blob.arrayBuffer();
  const decoded = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(bytes.slice(0));
  if (cutEndSec - cutStartSec < 0.01) {
    throw new Error('请先拖选需要剪切的音频区间');
  }
  if (decoded.duration - (cutEndSec - cutStartSec) < MIN_AUDIO_SEC) {
    throw new Error('剪切后剩余音频不得短于 0.04 秒');
  }
  const next = exciseAudioBufferRange(decoded, cutStartSec, cutEndSec);
  const baseName = (blob instanceof File ? blob.name : fallbackName).replace(/\.[^.]+$/, '') || 'audio';
  return {
    file: audioBufferFile(next, baseName),
    duration: next.duration,
  };
}
