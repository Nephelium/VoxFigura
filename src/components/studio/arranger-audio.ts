import { MAX_SEQUENCE_SECONDS, SAMPLE_RATE_HZ, msToSamples, type Clip } from '@vocalcut/core';
import type { StreamPlaybackChain, SynthesizeRangeOptions, WorkbenchStore } from '@/stores/workbench';
import type { AnnotationTractFrame } from '@/components/research/annotation-edit';
import type { ArrangerTimeRange } from './arranger-edit';
import type { Instrument, InstrumentCue } from './instrument-voices';

const frameSmp = SAMPLE_RATE_HZ / 50;
const overlapSmp = msToSamples(80);
const maxSmp = MAX_SEQUENCE_SECONDS * SAMPLE_RATE_HZ;

export function cropVoicePreview(source: AudioBuffer, startSmp: number, endSmp: number): AudioBuffer | undefined {
  const scale = source.sampleRate / SAMPLE_RATE_HZ;
  const start = Math.max(0, Math.round(startSmp * scale));
  const end = Math.min(source.length, Math.round(endSmp * scale));
  if (end <= start) return;
  const preview = new AudioBuffer({ numberOfChannels: source.numberOfChannels, sampleRate: source.sampleRate, length: end - start });
  for (let channel = 0; channel < source.numberOfChannels; channel++) {
    preview.copyToChannel(source.getChannelData(channel).subarray(start, end), channel);
  }
  return preview;
}

export function fadeVoicePreview(audio: AudioBuffer) {
  const length = Math.min(Math.round(audio.sampleRate * .008), Math.floor(audio.length / 2));
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const samples = audio.getChannelData(channel);
    for (let index = 0; index < length; index++) {
      const gain = index / length;
      samples[index] *= gain;
      samples[samples.length - 1 - index] *= gain;
    }
  }
}

export interface InstrumentRegion extends ArrangerTimeRange { instrument: Instrument }

export function arrangementInstrumentRegions(
  notes: readonly (ArrangerTimeRange & { instrumental?: boolean })[],
  instrument: Instrument | undefined,
  overrides?: InstrumentRegion[],
): InstrumentRegion[] | undefined {
  if (!instrument) return overrides;
  const sorted = [...notes].sort((a, b) => a.startSmp - b.startSmp || a.endSmp - b.endSmp);
  const regions: InstrumentRegion[] = [];
  for (const note of sorted) {
    if (!note.instrumental) continue;
    const last = regions.at(-1);
    const vocalBetween = last
      ? sorted.some((n) => !n.instrumental && n.endSmp > last.endSmp && n.startSmp < note.startSmp)
      : true;
    if (last && !vocalBetween) {
      last.endSmp = Math.max(last.endSmp, note.endSmp);
    } else {
      regions.push({ startSmp: note.startSmp, endSmp: note.endSmp, instrument });
    }
  }
  return regions.concat(overrides ?? []);
}

export function arrangementInstrumentPieces(
  note: ArrangerTimeRange & { instrumental?: boolean },
  range: ArrangerTimeRange, instrument: Instrument, regions: readonly InstrumentRegion[], followVocalNotes: boolean,
): InstrumentRegion[] {
  const start = Math.max(range.startSmp, note.startSmp);
  const end = Math.min(range.endSmp, note.endSmp);
  if (end <= start) return [];
  const overlaps = regions.filter(region => region.startSmp < end && region.endSmp > start).reverse();
  const boundaries = [...new Set([start, end, ...overlaps.flatMap(region =>
    [region.startSmp, region.endSmp].filter(sample => sample > start && sample < end)
  )])].sort((a, b) => a - b);
  const pieces: InstrumentRegion[] = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const startSmp = boundaries[index], endSmp = boundaries[index + 1];
    const timbre = overlaps.find(region => startSmp >= region.startSmp && startSmp < region.endSmp)?.instrument
      ?? (note.instrumental || followVocalNotes ? instrument : undefined);
    if (!timbre) continue;
    const last = pieces.at(-1);
    if (last?.instrument === timbre && last.endSmp === startSmp) last.endSmp = endSmp;
    else pieces.push({ startSmp, endSmp, instrument: timbre });
  }
  return pieces;
}

export function arrangementInstrumentCues(
  notes: readonly (ArrangerTimeRange & { hz: number; dynamic: number; noteIndex: number; velocity?:number; instrumental?: boolean })[],
  range: ArrangerTimeRange, instrument: Instrument, regions: readonly InstrumentRegion[] = [], followVocalNotes = true,
): InstrumentCue[] {
  let prevHz = -1;
  let prevEndSmp = -1;
  return notes.flatMap((note, idx) => {
    const noteStart = Math.max(range.startSmp, note.startSmp);
    const noteEnd = Math.min(range.endSmp, note.endSmp);
    if (noteEnd <= noteStart) return [];
    const pieces = arrangementInstrumentPieces(note, range, instrument, regions, followVocalNotes);
    const durSec = (noteEnd - noteStart) / SAMPLE_RATE_HZ;
    const clampedDyn = Math.max(-3, Math.min(3, note.dynamic));
    // Expressive melodic contour: higher register & longer structural notes breathe slightly fuller;
    // grace notes (< 0.14s) stay nimble and light.
    const registerLift = Math.max(-0.04, Math.min(0.06, Math.log2(Math.max(80, note.hz) / 261.63) * 0.025));
    const graceTrim = durSec < 0.13 ? -0.05 : durSec > 0.65 ? 0.03 : 0;
    const metricPulse = idx % 4 === 0 ? 0.025 : idx % 2 === 0 ? 0.008 : -0.012;
    const velocity = note.velocity === undefined ? Math.max(0.18, Math.min(0.96, 0.58 + clampedDyn * 0.115 + registerLift + graceTrim + metricPulse)) : note.velocity / 127;
    const volume = Math.max(0.32, Math.min(1.18, 0.84 + clampedDyn * 0.095 + registerLift * 0.6));

    const contiguous = prevEndSmp === noteStart;
    const repeatedPitch = contiguous && Math.abs(note.hz - prevHz) < 0.15;
    // Repeated same-pitch notes must re-articulate (tongue / bow change) rather than fusing into one flat tone
    const baseLegato = !repeatedPitch && (note.instrumental ? contiguous && durSec <= 0.42 : note.noteIndex > 0);
    prevHz = note.hz;
    prevEndSmp = noteEnd;

    return pieces.map((piece, pieceIdx) => ({
      hz: note.hz,
      at: (piece.startSmp - range.startSmp) / SAMPLE_RATE_HZ,
      duration: (piece.endSmp - piece.startSmp) / SAMPLE_RATE_HZ,
      volume,
      velocity,
      legato: pieceIdx > 0 ? true : baseLegato,
      instrument: piece.instrument,
    }));
  });
}

export function arrangementAudioWindows(clip: Clip, fromSmp = clip.start_smp) {
  const windows: { startSmp: number; endSmp: number; coreStartSmp: number; coreEndSmp: number }[] = [];
  const syllables = clip.syllable_order.map(id => clip.syllables[id]);
  let coreStartSmp = fromSmp;
  while (coreStartSmp < clip.end_smp) {
    const startSmp = coreStartSmp === fromSmp ? coreStartSmp : coreStartSmp - overlapSmp;
    const lastWindow = clip.end_smp - startSmp <= maxSmp;
    const latest = startSmp + maxSmp - overlapSmp;
    let boundary = latest;
    if (!lastWindow) {
      const earliest = latest - 8 * SAMPLE_RATE_HZ;
      // Prefer silence near the request limit so independent engine requests don't split a phoneme.
      for (let i = syllables.length - 2; i >= 0; i--) {
        const left = Math.max(earliest, syllables[i].end_smp + overlapSmp);
        const right = Math.min(latest, syllables[i + 1].start_smp - overlapSmp);
        if (right - left >= frameSmp) {
          boundary = right;
          break;
        }
      }
    }
    const coreEndSmp = lastWindow ? clip.end_smp : Math.floor(boundary / frameSmp) * frameSmp;
    const endSmp = Math.min(clip.end_smp, coreEndSmp + overlapSmp);
    windows.push({ startSmp, endSmp, coreStartSmp, coreEndSmp });
    coreStartSmp = coreEndSmp;
  }
  return windows;
}

export async function synthesizeArrangement(
  store: WorkbenchStore, clip: Clip, options: SynthesizeRangeOptions, isCurrent: () => boolean,
): Promise<{ audio: AudioBuffer; frames?: AnnotationTractFrame[]; m27RowsPa?: number[][] } | undefined> {
  const fromSmp = options.startSmp ?? clip.start_smp;
  const windows = arrangementAudioWindows(clip, fromSmp);
  if (windows.length === 1) {
    const audio = await store.synthesizeRange(options);
    if (!audio || !isCurrent()) return;
    const details = store.synthesisInfo(audio);
    return { audio, frames: details?.tractFrames, m27RowsPa: details?.m27RowsPa };
  }

  const duration = clip.end_smp - fromSmp;
  const frames: AnnotationTractFrame[] = [];
  const rows: number[][] = [];
  let combined: AudioBuffer | undefined;
  let previousEndSmp = fromSmp;
  const streamChain: StreamPlaybackChain | undefined = options.streamPlay
    ? {
        totalSamples: duration,
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
  for (let wi = 0; wi < windows.length; wi++) {
    const window = windows[wi];
    if (!isCurrent()) return;
    if (streamChain) {
      streamChain.windowOffsetSmp = window.startSmp - fromSmp;
      streamChain.windowOverlapSmp = wi > 0 ? Math.max(0, previousEndSmp - window.startSmp) : 0;
      streamChain.finalWindow = wi === windows.length - 1;
    }
    const audio = await store.synthesizeRange({
      ...options,
      startSmp: window.startSmp,
      endSmp: window.endSmp,
      streamPlay: streamChain ? options.streamPlay : undefined,
      streamChain,
    });
    if (!audio || !isCurrent()) return;
    if (audio.sampleRate !== SAMPLE_RATE_HZ || audio.length !== window.endSmp - window.startSmp) {
      throw new Error('分段人声采样长度与工程时间轴不一致');
    }
    combined ??= new AudioBuffer({ numberOfChannels: audio.numberOfChannels, sampleRate: SAMPLE_RATE_HZ, length: duration });
    const offset = window.startSmp - fromSmp;
    const overlap = previousEndSmp - window.startSmp;
    for (let channel = 0; channel < combined.numberOfChannels; channel++) {
      const target = combined.getChannelData(channel);
      const samples = audio.getChannelData(channel);
      for (let i = 0; i < overlap; i++) {
        const weight = .5 - .5 * Math.cos(Math.PI * (i + .5) / overlap);
        target[offset + i] = target[offset + i] * (1 - weight) + samples[i] * weight;
      }
      target.set(samples.subarray(overlap), offset + overlap);
    }
    previousEndSmp = window.endSmp;
    const details = store.synthesisInfo(audio);
    details?.tractFrames?.forEach(frame => {
      const sample = window.startSmp + frame.u * audio.length;
      if (sample >= window.coreStartSmp && sample < window.coreEndSmp) {
        frames.push({ ...frame, u: (sample - fromSmp) / duration });
      }
    });
    details?.m27RowsPa?.forEach((row, index) => {
      const sample = window.startSmp + (index + .5) * frameSmp;
      if (sample >= window.coreStartSmp && sample < window.coreEndSmp) {
        rows[Math.floor((sample - fromSmp) / frameSmp)] = row;
      }
    });
  }
  if (!combined) return;
  if (streamChain?.started) store.markStreamPlayed(combined);
  return {
    audio: combined,
    frames: frames.length ? frames : undefined,
    m27RowsPa: rows.length >= Math.floor(duration / frameSmp) && rows.filter(Boolean).length === rows.length
      ? rows : undefined,
  };
}
