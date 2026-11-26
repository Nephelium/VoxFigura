import { SAMPLE_RATE_HZ, type Clip } from '@vocalcut/core';
import { partitionClipSentenceWindows } from '@/data/sentence-compiler';
import {
  synthesisGainMode,
  voiceRenderLabels,
  voiceRenderMode,
} from '@/data/voice-renderer';
import type {
  StreamPlaybackChain,
  SynthesisInfo,
  SynthesizeRangeOptions,
  WorkbenchStore,
} from '@/stores/workbench';
import type { AnnotationTractFrame } from './annotation-edit';

const FRAME_50HZ_SMP = 960; // 20 ms @ 48 kHz

/**
 * Synthesize `[startSmp, endSmp)` of `clip`. When the clip contains multiple compiled
 * sentences separated by pause gaps (from sentence-ending punctuation), each sentence
 * window is synthesized independently so articulatory states do not bleed across sentences,
 * then stitched sample-accurately onto a unified 48 kHz `AudioBuffer`.
 */
export async function synthesizeClipBySentences(
  store: WorkbenchStore,
  clip: Clip,
  options: SynthesizeRangeOptions,
  isCurrent: () => boolean,
): Promise<AudioBuffer | null> {
  // Audio-reconstruction return (referenceTrack) already warps a unified real trajectory;
  // do not split it into isolated windows.
  if (options.referenceTrack) {
    return store.synthesizeRange(options);
  }

  const fromSmp = Math.max(clip.start_smp, options.startSmp ?? clip.start_smp);
  const toSmp = Math.min(clip.end_smp, options.endSmp ?? clip.end_smp);
  if (toSmp <= fromSmp) return null;

  const windows = partitionClipSentenceWindows(clip, fromSmp, toSmp);
  if (windows.length <= 1) {
    return store.synthesizeRange(options);
  }

  const totalDurationSmp = toSmp - fromSmp;
  const effectiveMode = options.mode ?? voiceRenderMode.value;
  const effectiveGain = options.audioGain ?? synthesisGainMode.value;

  const streamChain: StreamPlaybackChain | undefined = options.streamPlay
    ? {
        totalSamples: totalDurationSmp,
        windowOffsetSmp: 0,
        windowOverlapSmp: 0,
        finalWindow: false,
        activeSeq: 0,
        streamStartTime: 0,
        started: false,
        prevGainNode: null,
        lastScheduledNode: null,
        finished: false,
      }
    : undefined;

  let combined: AudioBuffer | null = null;
  const mergedTractFrames: AnnotationTractFrame[] = [];
  const expectedM27Rows = Math.floor(totalDurationSmp / FRAME_50HZ_SMP);
  const mergedM27Rows: Array<number[] | undefined> = [];
  const mergedRecordedArt: NonNullable<SynthesisInfo['recordedArticulation']> = [];
  const protectedSet = new Set<string>();
  const ignoredSet = new Set<string>();
  let totalModelMs = 0;
  let hasModelMs = false;
  let totalChunks = 0;
  let totalCacheHits = 0;
  let maxWorkers = 1;
  let firstDetails: SynthesisInfo | undefined;

  for (let wi = 0; wi < windows.length; wi++) {
    if (!isCurrent()) return null;
    const win = windows[wi];
    const winDurSmp = win.endSmp - win.startSmp;

    if (streamChain) {
      streamChain.windowOffsetSmp = win.startSmp - fromSmp;
      streamChain.windowOverlapSmp = 0;
      streamChain.finalWindow = wi === windows.length - 1;
    }

    // Synthesize each sentence window with `'original'` gain and normalize once across the
    // stitched utterance below so sentence-level loudness contrasts stay natural.
    const audio = await store.synthesizeRange({
      ...options,
      startSmp: win.startSmp,
      endSmp: win.endSmp,
      audioGain: 'original',
      cacheWaveform: false,
      streamPlay: streamChain ? options.streamPlay : undefined,
      streamChain,
    });
    if (!audio || !isCurrent()) return null;

    if (!combined) {
      combined = new AudioBuffer({
        numberOfChannels: audio.numberOfChannels,
        sampleRate: SAMPLE_RATE_HZ,
        length: totalDurationSmp,
      });
    }

    const offset = win.startSmp - fromSmp;
    for (let ch = 0; ch < combined.numberOfChannels; ch++) {
      const target = combined.getChannelData(ch);
      const src = audio.getChannelData(Math.min(ch, audio.numberOfChannels - 1));
      const copyLen = Math.min(src.length, winDurSmp, Math.max(0, totalDurationSmp - offset));
      if (copyLen > 0) {
        target.set(src.subarray(0, copyLen), offset);
      }
    }

    const info = store.synthesisInfo(audio);
    if (info) {
      firstDetails ??= info;
      if (typeof info.modelMs === 'number') {
        totalModelMs += info.modelMs;
        hasModelMs = true;
      }
      if (info.chunkStats) {
        totalChunks += info.chunkStats.total_chunks;
        totalCacheHits += info.chunkStats.cache_hits;
        maxWorkers = Math.max(maxWorkers, info.chunkStats.parallel_workers);
      }
      info.protectedIpaPoses?.forEach((p) => protectedSet.add(p));
      info.ignoredGeometryFields?.forEach((f) => ignoredSet.add(f));
      if (info.recordedArticulation?.length) {
        mergedRecordedArt.push(...info.recordedArticulation);
      }
      info.tractFrames?.forEach((frame) => {
        const globalSmp = win.startSmp + frame.u * audio.length;
        const u = Math.max(0, Math.min(1, (globalSmp - fromSmp) / totalDurationSmp));
        mergedTractFrames.push({ ...frame, u });
      });
      info.m27RowsPa?.forEach((row, rowIdx) => {
        const globalSmp = win.startSmp + (rowIdx + 0.5) * FRAME_50HZ_SMP;
        const slot = Math.floor((globalSmp - fromSmp) / FRAME_50HZ_SMP);
        if (slot >= 0) mergedM27Rows[slot] = row;
      });
    }
  }

  if (!combined || !isCurrent()) return null;

  const validM27 =
    mergedM27Rows.length > 0 &&
    mergedM27Rows.length >= expectedM27Rows &&
    mergedM27Rows.slice(0, expectedM27Rows).every(Boolean)
      ? (mergedM27Rows.slice(0, expectedM27Rows) as number[][])
      : undefined;

  const mergedInfo: SynthesisInfo = {
    mode: firstDetails?.mode ?? effectiveMode,
    sourceBadge: firstDetails?.sourceBadge ?? voiceRenderLabels[effectiveMode],
    device: firstDetails?.device,
    voiceProfile: firstDetails?.voiceProfile,
    modelMs: hasModelMs ? Math.round(totalModelMs * 10) / 10 : firstDetails?.modelMs,
    articulationModel: firstDetails?.articulationModel,
    articulationFrames50Hz: validM27?.length ?? (mergedTractFrames.length || undefined),
    articulationSource: firstDetails?.articulationSource,
    recordedArticulation: mergedRecordedArt.length ? mergedRecordedArt : undefined,
    protectedIpaPoses: protectedSet.size ? [...protectedSet] : undefined,
    ignoredGeometryFields: ignoredSet.size ? [...ignoredSet] : undefined,
    tractFrames: mergedTractFrames.length ? mergedTractFrames : undefined,
    m27RowsPa: validM27,
    chunkStats: totalChunks > 0
      ? {
          total_chunks: totalChunks,
          cache_hits: totalCacheHits,
          parallel_workers: maxWorkers,
          wall_ms: hasModelMs ? Math.round(totalModelMs * 10) / 10 : undefined,
        }
      : firstDetails?.chunkStats,
  };

  store.registerCombinedAudio(combined, mergedInfo, {
    mode: options.mode ? undefined : effectiveMode,
    audioGain: effectiveGain,
    streamPlayed: Boolean(streamChain?.started),
    applyPeakGain: effectiveGain === 'peak',
  });

  return combined;
}
