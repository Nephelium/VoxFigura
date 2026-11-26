import { SAMPLE_RATE_HZ, msToSamples, type TextGridDocument } from '@vocalcut/core';
import type { M27TrajectoryAnim } from '@vocalcut/model-adapters';
import type { ReconstructionVersion } from '@/data/reconstruction-history';
import { applyPeakAudioGain, synthesisGainMode } from '@/data/voice-renderer';
import { audioBufferFile } from '@/data/workspace-transfer';
import {
  detectLeadingTrailingSilence,
  exciseAudioBufferRange,
  exciseM27TrajectoryRange,
  exciseTextGridRange,
} from './audio-cut';

export interface ReconstructionCutMedia {
  source: Blob;
  original: Blob | null;
  grid: TextGridDocument | null;
  rows: number[][];
  anim: M27TrajectoryAnim | null;
  outputs: { neural: Blob | null; physical: Blob | null };
}

export interface ReconstructionCutSnapshot extends ReconstructionCutMedia {
  gridName: string;
  version: ReconstructionVersion;
  device: string;
  playheadSec: number;
  viewStartSec: number;
  selectionSec: [number, number] | null;
  speaker: File | null;
  speakerChoice: string;
}

type SampleRange = readonly [startSmp: number, endSmp: number];

function cutRanges(
  audioBuffer: AudioBuffer,
  grid: TextGridDocument | null,
  selectionSec: readonly [number, number] | null,
): SampleRange[] {
  const totalSmp = Math.round(audioBuffer.duration * SAMPLE_RATE_HZ);
  if (selectionSec) {
    const toSample = (sec: number) => Math.max(0, Math.min(totalSmp, Math.round(sec * SAMPLE_RATE_HZ)));
    const from = toSample(selectionSec[0]);
    const to = toSample(selectionSec[1]);
    if (to - from < msToSamples(15)) throw new Error('剪切区间至少需 15 ms');
    if (totalSmp - (to - from) < msToSamples(80)) throw new Error('剪切后须保留至少 80 ms 音频');
    return [[from, to]];
  }

  const bounds = detectLeadingTrailingSilence({ audioBuffer, grid });
  if (!bounds) return [];
  const keepEnd = Math.min(totalSmp, bounds.keepEndSmp);
  if (keepEnd - bounds.keepStartSmp < msToSamples(80)) return [];
  const ranges: SampleRange[] = [];
  if (totalSmp - keepEnd >= msToSamples(45)) ranges.push([keepEnd, totalSmp]);
  if (bounds.keepStartSmp > 0) ranges.push([0, bounds.keepStartSmp]);
  return ranges;
}

export async function prepareReconstructionCut(
  media: ReconstructionCutMedia,
  name: string,
  selectionSec: readonly [number, number] | null,
  decode: (blob: Blob) => Promise<AudioBuffer>,
) {
  const sourceBuffer = await decode(media.source);
  const ranges = cutRanges(sourceBuffer, media.grid, selectionSec);
  if (!ranges.length) return null;
  const seconds = ranges.map(([start, end]) => [start / SAMPLE_RATE_HZ, end / SAMPLE_RATE_HZ] as const);
  const cutBuffer = (buffer: AudioBuffer) => {
    const cut = seconds.reduce(
      (result, [start, end]) => exciseAudioBufferRange(result, start, end),
      buffer,
    );
    if (synthesisGainMode.value === 'peak') applyPeakAudioGain(cut);
    return cut;
  };
  const cutFile = (buffer: AudioBuffer, blob: Blob, fallbackName: string) => audioBufferFile(
    cutBuffer(buffer),
    (blob instanceof File ? blob.name : fallbackName).replace(/\.[^.]+$/, ''),
  );
  const source = cutFile(sourceBuffer, media.source, name);
  const raw = media.original;
  const [original, physical, neural] = await Promise.all([
    !raw || raw === media.source
      ? source
      : decode(raw).then((buffer) => cutFile(buffer, raw, name)),
    media.outputs.physical ? decode(media.outputs.physical).then(cutBuffer) : null,
    media.outputs.neural
      ? media.outputs.neural.arrayBuffer()
        .then((bytes) => new OfflineAudioContext(1, 1, 16000).decodeAudioData(bytes))
        .then(cutBuffer)
      : null,
  ]);
  const grid = media.grid && seconds.reduce(
    (result, [start, end]) => exciseTextGridRange(result, start, end),
    media.grid,
  );
  const trajectory = seconds.reduce(
    (result, [start, end]) => exciseM27TrajectoryRange(result.rows, result.anim, start, end),
    { rows: media.rows, anim: media.anim },
  );

  return {
    source,
    original,
    grid,
    ...trajectory,
    outputs: {
      physical: physical && audioBufferFile(physical, '物理重合成'),
      neural: neural && audioBufferFile(neural, '神经重合成'),
    },
    playheadSec: selectionSec ? seconds[0][0] : 0,
  };
}
