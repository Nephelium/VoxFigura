import { SAMPLE_RATE_HZ, type Clip, type VcProject } from '@vocalcut/core';
import { defaultTractParams, tractRecordToArray19 } from '@/stores/workbench';
import { audioBufferFile, type WorkspaceAudio } from '@/data/workspace-transfer';
import { buildAnnotationSynthesis } from '@/components/research/annotation-audio';
import { trackFrameAt } from '@/components/research/annotation-edit';
import { blobToBase64 } from '@/components/research/research-utils';

const TRACT_INDEXES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18];
const FRAME_SMP = SAMPLE_RATE_HZ / 50;
type PoseFrames = NonNullable<WorkspaceAudio['frames']>;
export interface TransferChoice {
  id: string;
  label: string;
  startSmp: number;
  durationSmp: number;
  audio?: AudioBuffer;
  phrase?: Clip;
  poseFrames?: PoseFrames;
  poseLength?: number;
  rowsPa?: number[][];
  stageClip?: { projectId: string; assetId?: string; lengthSmp: number };
}
export interface TransferRange { choice: TransferChoice; startSmp: number; endSmp: number }
export interface VoiceTransferResult extends WorkspaceAudio { rowsPa: number[][] }

export function transferRange(choice: TransferChoice, from: number, to: number): TransferRange {
  const start = Math.round(from * SAMPLE_RATE_HZ);
  const end = Math.round(to * SAMPLE_RATE_HZ);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > choice.durationSmp || end - start < 2 * FRAME_SMP || end - start > 15 * SAMPLE_RATE_HZ) {
    throw new Error(`${choice.label} 的入点和出点必须位于片段内，选区时长须为 0.04–15 秒`);
  }
  return { choice, startSmp: choice.startSmp + start, endSmp: choice.startSmp + end };
}

export async function voiceTransferOperand(range: TransferRange, project: VcProject) {
  const { choice, startSmp, endSmp } = range;
  const count = Math.floor((endSmp - startSmp) / FRAME_SMP);
  let wav_base64: string | undefined;
  if (choice.audio) {
    const mono = new AudioBuffer({ length: count * FRAME_SMP, sampleRate: SAMPLE_RATE_HZ, numberOfChannels: 1 });
    const dest = mono.getChannelData(0);
    for (let ch = 0; ch < choice.audio.numberOfChannels; ch++) {
      const source = choice.audio.getChannelData(ch).subarray(startSmp, startSmp + dest.length);
      for (let i = 0; i < source.length; i++) dest[i] += source[i] / choice.audio.numberOfChannels;
    }
    wav_base64 = await blobToBase64(audioBufferFile(mono, 'selection.wav'));
  }
  let rows_pa: number[][] | undefined;
  if (choice.rowsPa?.length) {
    const rows = choice.rowsPa;
    rows_pa = Array.from({ length: count }, (_, i) => rows[Math.min(rows.length - 1, Math.floor(startSmp / FRAME_SMP) + i)]);
  } else if (!choice.audio && (choice.phrase || choice.poseFrames?.length)) {
    const neutral = tractRecordToArray19(defaultTractParams());
    const fallback = { f0Hz: 140, tract: neutral, releaseTract: neutral, lipWidth: 1, larynxHeight: 0 };
    const anchors = Object.values(project.phonation_anchors).sort((a, b) => a.t_smp - b.t_smp);
    const controls = choice.phrase ? buildAnnotationSynthesis(project, choice.phrase, anchors, startSmp, endSmp, fallback) : undefined;
    if (controls && !controls.ok) throw new Error(controls.error.hint);
    const data = controls?.value;
    rows_pa = Array.from({ length: count }, (_, i) => {
      const relative = (startSmp + i * FRAME_SMP - (choice.phrase?.start_smp ?? 0)) / (choice.poseLength ?? choice.durationSmp);
      const pose = trackFrameAt(choice.poseFrames ?? [], relative)?.params ?? data?.tract_frames[i * 4] ?? neutral;
      return [
        ...TRACT_INDEXES.map(index => pose[index]), data?.f0_hz[i * 4] ?? 140, data?.pressure_pa[i * 4] ?? 700,
        ...(data?.glottis_frames[i * 4] ?? [0.018, 0.012, 0, 1.22, 0.1, 0, 0, 0]),
      ];
    });
  }
  return { wav_base64, rows_pa };
}

function syllablesInRange(range: TransferRange) {
  const phrase = range.choice.phrase;
  return phrase?.syllable_order.map(id => phrase.syllables[id])
    .filter(syllable => syllable.end_smp > range.startSmp && syllable.start_smp < range.endSmp) ?? [];
}

function labeledSpans(range: TransferRange, phonemes: boolean) {
  const syllables = syllablesInRange(range);
  const spans = phonemes
    ? syllables.flatMap(syllable => syllable.segments.map(segment => ({ ...segment, label: segment.ipa })))
    : syllables.map(syllable => ({ ...syllable, label: syllable.text }));
  return spans.filter(span => span.label.trim() && span.start_smp >= range.startSmp && span.end_smp <= range.endSmp);
}

export function transferAnchors(target: TransferRange, source: TransferRange) {
  for (const phonemes of [true, false]) {
    const a = labeledSpans(target, phonemes);
    const b = labeledSpans(source, phonemes);
    const label = (value: string) => value.trim().normalize('NFC').toLowerCase();
    if (!a.length || a.length !== b.length || a.some((span, i) => label(span.label) !== label(b[i].label))) continue;
    const anchors: { t_a: number; t_b: number }[] = [];
    for (const [i, span] of a.entries()) {
      for (const key of ['start_smp', 'end_smp'] as const) {
        const t_a = (span[key] - target.startSmp) / SAMPLE_RATE_HZ;
        const t_b = (b[i][key] - source.startSmp) / SAMPLE_RATE_HZ;
        const previous = anchors[anchors.length - 1];
        if (!previous || (t_a > previous.t_a && t_b > previous.t_b)) anchors.push({ t_a, t_b });
      }
    }
    if (anchors.length > 1) return anchors;
  }
  return [];
}

export function outputPoses(rows: number[][]): PoseFrames {
  const neutral = tractRecordToArray19(defaultTractParams());
  return rows.map((row, i) => {
    const params = neutral.slice();
    for (const [column, index] of TRACT_INDEXES.entries()) params[index] = row[column];
    return { u: i / rows.length, params };
  });
}

export function transferOutputClip(range: TransferRange, durationSmp: number, targetFrameMap?: number[]): Clip | undefined {
  const phrase = range.choice.phrase;
  if (!phrase) return;
  const inputSmp = range.endSmp - range.startSmp;
  const mapped = targetFrameMap?.length ? [...targetFrameMap.map(i => i * FRAME_SMP), inputSmp] : undefined;
  function projectTime(sample: number): number {
    const local = Math.max(0, Math.min(inputSmp, sample - range.startSmp));
    if (!mapped || local === 0 || local === inputSmp) return Math.min(local === inputSmp && mapped ? durationSmp : local, durationSmp);
    const index = mapped.findIndex(value => value >= local);
    if (index <= 0) return index === 0 ? 0 : durationSmp;
    const weight = (local - mapped[index - 1]) / (mapped[index] - mapped[index - 1]);
    return Math.round((index - 1 + weight) * durationSmp / (mapped.length - 1));
  }
  function retime<T extends { start_smp: number; end_smp: number }>(span: T) {
    return { ...span, start_smp: projectTime(span.start_smp), end_smp: projectTime(span.end_smp) };
  }
  const syllables = syllablesInRange(range).map(syllable => {
    const next = retime(syllable);
    next.segments = syllable.segments.map(segment => {
      const mappedSegment = retime(segment);
      const timing = mappedSegment.stop_timing;
      const availableMs = (mappedSegment.end_smp - mappedSegment.start_smp) * 1000 / SAMPLE_RATE_HZ;
      if (timing && availableMs > 0 && availableMs < timing.closure_ms + timing.release_ms) {
        throw new Error(`节奏和选区会缩短 [${segment.ipa}] 的闭塞与释放。请调整选区或关闭节奏迁移。`);
      }
      return mappedSegment;
    }).filter(segment => segment.end_smp > segment.start_smp);
    if (syllable.segments.length) {
      const nucleus = syllable.segments[syllable.nucleus_index]?.id;
      next.nucleus_index = Math.max(0, next.segments.findIndex(segment => segment.id === nucleus));
      next.ipa = next.segments.map(segment => segment.ipa);
    }
    next.targets = syllable.targets.map(retime).filter(target => target.end_smp > target.start_smp);
    return next;
  }).filter(syllable => syllable.end_smp > syllable.start_smp);
  if (!syllables.length) return;
  return {
    id: crypto.randomUUID(), kind: 'phrase', voice_id: phrase.voice_id, start_smp: 0, end_smp: durationSmp,
    source: { lyrics: syllables.map(syllable => syllable.text).join(''), lang: phrase.source?.lang },
    syllables: Object.fromEntries(syllables.map(syllable => [syllable.id, syllable])),
    syllable_order: syllables.map(syllable => syllable.id),
  };
}
