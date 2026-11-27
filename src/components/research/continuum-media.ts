import { SAMPLE_RATE_HZ, assertValidF0Hz, type Clip, type Result, type SegmentAnchor, type Syllable, type TractParamName } from '@vocalcut/core';
import { audioBufferFile, type WorkspaceAudio } from '@/data/workspace-transfer';
import { shallowReactive } from 'vue';
import { M27Adapter, type M27TrajectoryAnim } from '@vocalcut/model-adapters';
import { parseTextGrid, type ComputeDevice } from '@vocalcut/core';
import { clipFromTextGrid } from '@/data/textgrid-alignment';
import { outputPoses } from '@/components/studio/voice-transfer';
import { paintReferenceFrame, type PaintableTractFrame } from '@/data/reference-geometry';
import { studioAudioContext } from '@/components/studio/studio-media';
import { blobToBase64 } from './research-utils';
import { phoneTraits } from '@/data/ipa-segments';
import { applyPeakAudioGain } from '@/data/voice-renderer';
import { waveSampleRate } from './annotation-edit';
import { strToU8, zipSync } from 'fflate';
import type { TractViewBox } from '@/vendor/m27-tract-studio/tract-renderer.js';

export const received = shallowReactive<Record<'A' | 'B', WorkspaceAudio | null>>({ A: null, B: null });
export const originalEndpointAudio = new WeakMap<File, WorkspaceAudio>();
export type ContinuumEndpointSource = 'preset' | 'phoneme' | 'm27' | 'audio';
export type ContinuumAxisKind = 'mix' | 'f0' | 'phonation' | 'duration' | 'pressure' | TractParamName;
export type ContinuumSpeakerRefMode = 'endpoint_a' | 'endpoint_b' | 'builtin';
export type ContinuumGhostMode = 'both' | 'A' | 'B' | 'off';

export const endpointSelections: Record<'A' | 'B', ContinuumEndpointSource> = { A: 'preset', B: 'preset' };

export interface ContinuumAxisRangeSetting {
  values: number[];
  min: number;
  max: number;
  unit: string;
  step?: number;
}

export interface ContinuumPersistedState {
  presetA: string;
  phonemeA: string;
  presetB: string;
  phonemeB: string;
  horizontal: ContinuumAxisKind;
  vertical: ContinuumAxisKind;
  dualAxis: boolean;
  sequenceSteps: number;
  matrixColumns: number;
  matrixRows: number;
  baseMix: number;
  synthesis: 'vtl' | 'neural';
  speakerRefMode: ContinuumSpeakerRefMode;
  regimeA: string;
  regimeB: string;
  axisSettings: Record<string, ContinuumAxisRangeSetting> | null;
  lockLips: boolean;
  lockTongueBody: boolean;
  lockTongueTip: boolean;
  lockVelum: boolean;
  lockJaw: boolean;
  equalizeDuration: boolean;
  selectedCellKey: string;
  sidebarWidth: number;
  showInspector: boolean;
  ghostMode: ContinuumGhostMode;
  renderedCacheKey: string;
  rendered: Map<string, Promise<RenderedCell>>;
  renderedWavMeta: Record<string, WavHeaderSummary & { filename: string }>;
  lastSequenceAudio: AudioBuffer | null;
  lastSequenceParts: Array<{ key: string; start_s: number; end_s: number }> | undefined;
}

export const continuumPersisted: ContinuumPersistedState = {
  presetA: 'i_high',
  phonemeA: 'i',
  presetB: 'u_back',
  phonemeB: 'u',
  horizontal: 'mix',
  vertical: 'f0',
  dualAxis: false,
  sequenceSteps: 5,
  matrixColumns: 5,
  matrixRows: 4,
  baseMix: 50,
  synthesis: 'neural',
  speakerRefMode: 'endpoint_a',
  regimeA: 'V',
  regimeB: 'V̤',
  axisSettings: null,
  lockLips: false,
  lockTongueBody: false,
  lockTongueTip: false,
  lockVelum: false,
  lockJaw: false,
  equalizeDuration: true,
  selectedCellKey: '1-1',
  sidebarWidth: 276,
  showInspector: true,
  ghostMode: 'both',
  renderedCacheKey: '',
  rendered: new Map(),
  renderedWavMeta: {},
  lastSequenceAudio: null,
  lastSequenceParts: undefined,
};

type Trajectory = NonNullable<WorkspaceAudio['frames']>;
type TimingSpan = { start: number; end: number };
type PhoneTiming = TimingSpan & { segment: SegmentAnchor };
type SyllableTiming = TimingSpan & { syllable: Syllable; phones: PhoneTiming[] };
type EndpointTiming = { syllables: SyllableTiming[]; boundaries: number[]; pattern: number[] };
export type EndpointAlignment = {
  a: EndpointTiming | null;
  b: EndpointTiming | null;
  compatible: boolean;
  message: string;
};

export function validPose(params: unknown): params is number[] {
  return Array.isArray(params) && params.length === 19 && params.every(Number.isFinite);
}

function normalizedSpan(item: { start_smp: number; end_smp: number }, clip: Clip): TimingSpan {
  const duration = clip.end_smp - clip.start_smp;
  return { start: (item.start_smp - clip.start_smp) / duration, end: (item.end_smp - clip.start_smp) / duration };
}

function validSpans(items: TimingSpan[], lo: number, hi: number) {
  return items.every((item, i) => Number.isFinite(item.start) && Number.isFinite(item.end) &&
    item.start >= (i ? items[i - 1].end : lo) && item.end > item.start && item.end <= hi);
}

function getEndpointTiming(clip?: Clip): EndpointTiming | null {
  if (!clip || clip.end_smp <= clip.start_smp || !clip.syllable_order.length) return null;
  const syllables = clip.syllable_order.flatMap(id => {
    const syllable = clip.syllables[id];
    if (!syllable) return [];
    const phones = syllable.segments.map(segment => ({ ...normalizedSpan(segment, clip), segment }));
    return [{ ...normalizedSpan(syllable, clip), syllable, phones }];
  });
  if (syllables.length !== clip.syllable_order.length || !validSpans(syllables, 0, 1) ||
    syllables.some(s => !s.phones.length || !validSpans(s.phones, s.start, s.end))) return null;
  const anchors = [0, ...syllables.flatMap(s => [s.start, ...s.phones.flatMap(p => [p.start, p.end]), s.end]), 1];
  const boundaries = [...new Set(anchors)];
  return { syllables, boundaries, pattern: anchors.map(t => boundaries.indexOf(t)) };
}

export function alignEndpointTimings(
  a: WorkspaceAudio | null,
  b: WorkspaceAudio | null,
  equalizeDuration = true,
): EndpointAlignment {
  const first = getEndpointTiming(a?.clip);
  const second = getEndpointTiming(b?.clip);
  const same = first && second && first.syllables.length === second.syllables.length &&
    first.syllables.every(({ phones }, i) => phones.length === second.syllables[i].phones.length) &&
    first.pattern.length === second.pattern.length && first.pattern.every((v, i) => v === second.pattern[i]);
  const durationNote = equalizeDuration ? '输出时长按较长端点等时长对齐' : '输出时长随插值比例变化';
  const message = same
    ? `音节和音素边界逐段对齐，${durationNote}，标签沿用较近端点。`
    : first && second
      ? `两端标注结构或间隔位置不兼容。中间格按总时长比例混合，${durationNote}，交接时携带音频和构型轨迹。`
      : first || second
        ? `目前只有一端有有效标注。中间格按总时长比例混合，${durationNote}，交接时携带音频和构型轨迹。`
        : '当前端点无可对齐的标注。交接时携带音频和构型轨迹。';
  return { a: first, b: second, compatible: !!same, message };
}

export function timeWarp(alignment: EndpointAlignment, alpha: number) {
  if (!alignment.compatible || !alignment.a || !alignment.b) return (u: number) => [u, u] as const;
  const a = alignment.a.boundaries;
  const b = alignment.b.boundaries;
  const output = a.map((t, i) => t + (b[i] - t) * alpha);
  return (u: number) => {
    let right = output.findIndex(t => t >= u);
    if (right === 0) return [0, 0] as const;
    if (right < 0) right = output.length - 1;
    const left = right - 1;
    const t = (u - output[left]) / (output[right] - output[left]);
    return [a[left] + (a[right] - a[left]) * t, b[left] + (b[right] - b[left]) * t] as const;
  };
}

export function sourceTrajectory(source: WorkspaceAudio | null, sourceSeconds?: number): Trajectory {
  const frames = source?.frames?.filter(frame => frame.u >= 0 && frame.u <= 1 && validPose(frame.params));
  const clip = source?.clip;
  if (frames?.length) {
    const ordered = [...frames].sort((a, b) => a.u - b.u);
    if (!clip || !sourceSeconds) return ordered;
    const start = clip.start_smp / (sourceSeconds * SAMPLE_RATE_HZ);
    const end = clip.end_smp / (sourceSeconds * SAMPLE_RATE_HZ);
    if (start < 0 || end <= start || end > 1.02) return ordered;
    return [
      { u: 0, params: interpolatePose(ordered, start) },
      ...ordered.filter(frame => frame.u > start && frame.u < end).map(frame => ({
        u: (frame.u - start) / (end - start), params: frame.params,
      })),
      { u: 1, params: interpolatePose(ordered, end) },
    ];
  }
  if (!clip || clip.end_smp <= clip.start_smp) return [];
  return clip.syllable_order.flatMap(id => (clip.syllables[id]?.segments ?? []).flatMap(segment => {
    const { start, end } = normalizedSpan(segment, clip);
    return validPose(segment.params) && start >= 0 && end <= 1 && end > start
      ? [{ u: (start + end) / 2, params: segment.params }] : [];
  })).sort((a, b) => a.u - b.u);
}

export function interpolatePose(points: Trajectory, u: number): number[] {
  const right = points.findIndex(point => point.u >= u);
  if (right < 0) return points[points.length - 1].params;
  if (right === 0) return points[0].params;
  const before = points[right - 1], after = points[right];
  const k = (u - before.u) / Math.max(1e-9, after.u - before.u);
  return before.params.map((value, i) => value + (after.params[i] - value) * k);
}

export function representativeContinuumPose(source: WorkspaceAudio): { params: number[]; f0Hz?: number } | undefined {
  const trajectory = sourceTrajectory(source);
  if (!trajectory.length) return;
  const clip = source.clip;
  const rows = source.m27RowsPa;
  const vowel = clip?.syllable_order.flatMap(id => clip.syllables[id]?.segments ?? [])
    .filter(segment => segment.voiced && phoneTraits(segment.ipa).vowel)
    .sort((a, b) => (b.end_smp - b.start_smp) - (a.end_smp - a.start_smp))[0];
  if (rows?.length) {
    let frame;
    if (vowel) {
      frame = Math.max(0, Math.min(rows.length - 1, Math.floor((vowel.start_smp + vowel.end_smp) * 25 / SAMPLE_RATE_HZ)));
    } else {
      const peakPressure = Math.max(...rows.map(row => row[18]));
      const active = rows.flatMap((row, index) => row[18] > Math.max(20, peakPressure * 0.45) && row[23] > 0.05 ? [index] : []);
      // Prefer a voiced oral nucleus frame (low velum opening VO = row[7]) over nasalized coda frames
      const oralVoiced = active.filter(index => rows[index][7] <= 0.06 && rows[index][23] > 0.25);
      const pool = oralVoiced.length ? oralVoiced : active;
      frame = pool.length ? pool[Math.floor(pool.length / 2)] : Math.floor(rows.length / 2);
    }
    return { params: interpolatePose(trajectory, (frame + 0.5) / rows.length), f0Hz: rows[frame][17] };
  }
  if (clip && vowel) {
    const time = ((vowel.start_smp + vowel.end_smp) / 2 - clip.start_smp) / (clip.end_smp - clip.start_smp);
    return { params: interpolatePose(trajectory, time) };
  }
  return { params: interpolatePose(trajectory, 0.5) };
}

const adapter = new M27Adapter();
const analyses = new WeakMap<File, Promise<WorkspaceAudio>>();

export function hasLegacyContinuumTrack(source: WorkspaceAudio | null): boolean {
  // Older reconstructions emitted negative TS1/TS2 during rest and at speech boundaries.
  return Boolean(source?.m27RowsPa?.some((row) => row[14] < -1e-6 || row[15] < -1e-6)
    || (source?.sourceKind === 'audio-reconstruct'
      && source.frames?.some(({ params }) => params[16] < -1e-6 || params[17] < -1e-6)));
}

export function needsContinuumAnalysis(source: WorkspaceAudio): boolean {
  return hasLegacyContinuumTrack(source) || !sourceTrajectory(source).length;
}

export function resolveContinuumSource(
  source: WorkspaceAudio,
  device: ComputeDevice,
  signal?: AbortSignal,
): Promise<WorkspaceAudio> {
  if (!needsContinuumAnalysis(source)) return Promise.resolve(source);
  let result = analyses.get(source.file);
  if (!result) {
    result = (async () => {
      const input = source.analysisFile ?? source.file;
      const guideText = source.alignmentText?.trim() || undefined;
      const response = await adapter.reconstruct({
        wav_base64: await blobToBase64(input),
        filename: input.name,
        text: guideText,
        alignment_mode: guideText ? 'guided' : undefined,
        synth_mode: 'animation',
        compute_device: device,
        fps: 25,
        signal,
      });
      if (signal?.aborted) throw new DOMException('已取消端点分析', 'AbortError');
      if (!response.ok) throw new Error(response.error.hint);
      const { alignment, m27_50hz_pa: rows } = response.value;
      if (hasLegacyContinuumTrack({ ...source, m27RowsPa: rows, frames: undefined })) {
        throw new Error('端点重建仍返回越界的 TS1/TS2。请重启本项目的本地语音引擎后重试。');
      }
      const parsed = alignment?.textgrid ? parseTextGrid(alignment.textgrid) : null;
      const textGrid = source.textGrid ?? (parsed?.ok ? parsed.value : undefined);
      const clip = source.clip ?? clipFromTextGrid(textGrid ?? null, Math.round((await endpointDuration(source)) * SAMPLE_RATE_HZ), crypto.randomUUID());
      return { ...source, clip, textGrid, m27RowsPa: rows, frames: outputPoses(rows) };
    })().catch(error => { analyses.delete(source.file); throw error; });
    analyses.set(source.file, result);
  }
  return result;
}

export function endpointEffectiveDuration(source: WorkspaceAudio | null, wholeSeconds: number): number {
  const clip = source?.clip;
  if (
    clip &&
    clip.start_smp >= 0 &&
    clip.end_smp > clip.start_smp &&
    clip.end_smp <= wholeSeconds * SAMPLE_RATE_HZ + 960
  ) {
    return (clip.end_smp - clip.start_smp) / SAMPLE_RATE_HZ;
  }
  return wholeSeconds;
}

export function sourceControls(source: WorkspaceAudio | null, wholeSeconds: number, u: number): number[] | undefined {
  const rows = source?.m27RowsPa;
  if (!rows?.length) return;
  const clip = source?.clip;
  const t = clip && clip.start_smp >= 0 && clip.end_smp <= wholeSeconds * SAMPLE_RATE_HZ + 960
    ? (clip.start_smp + u * (clip.end_smp - clip.start_smp)) / SAMPLE_RATE_HZ : u * wholeSeconds;
  const index = Math.max(0, Math.min(rows.length - 1, t * 50 - 0.5));
  const lo = Math.floor(index);
  const hi = Math.min(rows.length - 1, lo + 1);
  return rows[lo].map((value, column) => value + (rows[hi][column] - value) * (index - lo));
}

export function referenceFramesFromM27(animation: M27TrajectoryAnim, trajectory: Trajectory): PaintableTractFrame[] {
  return animation.frames.map(frame => {
    let offset = 0;
    const contours = Object.fromEntries(animation.parts.map((part, i) => {
      const points = Array.from({ length: animation.part_sizes[i] }, () => [frame.pts[offset++], frame.pts[offset++]] as [number, number]);
      return [part, points];
    }));
    return { t_s: frame.t, contours, params: interpolatePose(trajectory, frame.t / animation.duration_sec), nasal_area_cm2: frame.nasal };
  });
}

const sourceDurationCache = new WeakMap<File, Promise<number>>();
export function endpointDuration(source: WorkspaceAudio | null): Promise<number> {
  if (!source) return Promise.resolve(0.65);
  let result = sourceDurationCache.get(source.file);
  if (!result) {
    result = source.file.arrayBuffer()
      .then(data => studioAudioContext().decodeAudioData(data))
      .then(decoded => decoded.duration)
      .catch(() => {
        sourceDurationCache.delete(source.file);
        throw new Error('无法读取端点音频时长。');
      });
    sourceDurationCache.set(source.file, result);
  }
  return result;
}

export const CONTINUUM_GAP_S = 0.22;

/**
 * Resolve frame F0 for continuum synthesis without silent clamping or silent fallback
 * replacement. Out-of-range source F0 values are rejected with standard `out_of_range`.
 */
export function resolveContinuumFramePitch(params: {
  leftF0Hz?: number;
  rightF0Hz?: number;
  leftEndpointF0Hz: number;
  rightEndpointF0Hz: number;
  alpha: number;
  axisOverrideHz: number | null;
  frameIndex?: number;
}): Result<number> {
  const frameTag = params.frameIndex !== undefined ? `第 ${params.frameIndex + 1} 帧` : '控制轨';
  if (params.axisOverrideHz !== null) {
    return assertValidF0Hz(
      'continuum.axis.f0_hz',
      params.axisOverrideHz,
      `连续统 F0 轴目标值 (${params.axisOverrideHz} Hz) 须为正有限值 (> 0 Hz)`,
    );
  }
  const pitchAVal = params.leftF0Hz !== undefined ? params.leftF0Hz : params.leftEndpointF0Hz;
  const pitchAChk = assertValidF0Hz(
    'continuum.sourceA.f0_hz',
    pitchAVal,
    `端点 A ${frameTag}基频 (${pitchAVal} Hz) 须为正有限值 (> 0 Hz)；请修正源控制轨或通过 F0 轴显式指定基频`,
  );
  if (!pitchAChk.ok) return pitchAChk;

  const pitchBVal = params.rightF0Hz !== undefined ? params.rightF0Hz : params.rightEndpointF0Hz;
  const pitchBChk = assertValidF0Hz(
    'continuum.sourceB.f0_hz',
    pitchBVal,
    `端点 B ${frameTag}基频 (${pitchBVal} Hz) 须为正有限值 (> 0 Hz)；请修正源控制轨或通过 F0 轴显式指定基频`,
  );
  if (!pitchBChk.ok) return pitchBChk;

  const mixed = pitchAChk.value + (pitchBChk.value - pitchAChk.value) * params.alpha;
  return assertValidF0Hz('continuum.f0_hz', mixed);
}

export function joinContinuumAudio(context: AudioContext, buffers: AudioBuffer[]): AudioBuffer {
  if (buffers.length === 1) return buffers[0];
  const gap = Math.round(context.sampleRate * CONTINUUM_GAP_S);
  const length = buffers.reduce((sum, buffer) => sum + buffer.length, gap * (buffers.length - 1));
  const channels = Math.max(...buffers.map((buffer) => buffer.numberOfChannels));
  const sequence = context.createBuffer(channels, length, context.sampleRate);
  let offset = 0;
  for (const buffer of buffers) {
    for (let channel = 0; channel < channels; channel++) {
      sequence.getChannelData(channel).set(buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1)), offset);
    }
    offset += buffer.length + gap;
  }
  return sequence;
}

export interface WavHeaderSummary {
  sampleRateHz: number;
  numSamples: number;
  durationS: number;
}

export function inspectWavHeader(bytes: ArrayBuffer): WavHeaderSummary | null {
  const view = new DataView(bytes);
  if (view.byteLength < 12 || view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645) return null;
  let sampleRateHz = 0;
  let blockAlign = 0;
  let dataBytes: number | null = null;
  for (let offset = 12; offset + 8 <= view.byteLength; ) {
    const id = view.getUint32(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 0x666d7420 && size >= 16 && offset + 24 <= view.byteLength) {
      sampleRateHz = view.getUint32(offset + 12, true);
      blockAlign = view.getUint16(offset + 20, true);
    } else if (id === 0x64617461) {
      dataBytes = Math.min(size, Math.max(0, view.byteLength - (offset + 8)));
    }
    offset += 8 + size + (size % 2);
  }
  if (!sampleRateHz || !blockAlign || dataBytes === null) return null;
  const numSamples = Math.floor(dataBytes / blockAlign);
  return {
    sampleRateHz,
    numSamples,
    durationS: numSamples / sampleRateHz,
  };
}

export async function peakContinuumWav(file: File): Promise<File> {
  const bytes = await file.arrayBuffer();
  const context = new OfflineAudioContext(1, 1, waveSampleRate(bytes) ?? SAMPLE_RATE_HZ);
  const buffer = await context.decodeAudioData(bytes);
  applyPeakAudioGain(buffer);
  return audioBufferFile(buffer, file.name);
}

export function buildOutputAnnotation(
  alignment: EndpointAlignment, alpha: number, durationSmp: number, frames: Trajectory,
): Clip | undefined {
  const timing = alignment.compatible ? (alpha < 0.5 ? alignment.a : alignment.b)
    : alpha === 0 ? alignment.a : alpha === 1 ? alignment.b : null;
  if (!timing) return undefined;
  const other = timing === alignment.a ? alignment.b : alignment.a;
  const mix = timing === alignment.a ? alpha : 1 - alpha;
  const samples = (a: number, b?: number) => Math.round((b === undefined ? a : a + (b - a) * mix) * durationSmp);
  const clip: Clip = { id: crypto.randomUUID(), kind: 'audio', start_smp: 0, end_smp: durationSmp,
    source: { lang: 'ipa' }, syllable_order: [], syllables: {} };
  for (const [i, current] of timing.syllables.entries()) {
    const peer = alignment.compatible ? other?.syllables[i] : undefined;
    const start = samples(current.start, peer?.start);
    const end = samples(current.end, peer?.end);
    const id = 'continuum-syllable-' + (i + 1);
    const segments: SegmentAnchor[] = current.phones.flatMap((phone, j) => {
      const second = peer?.phones[j];
      const begin = samples(phone.start, second?.start);
      const finish = samples(phone.end, second?.end);
      if (finish <= begin) return [];
      const { ipa, role, voiced, elastic } = phone.segment;
      return [{ id: id + '-phone-' + (j + 1), ipa, role, voiced, elastic, start_smp: begin, end_smp: finish,
        params: [...interpolatePose(frames, (begin + finish) / (2 * durationSmp))] }];
    });
    if (end <= start || !segments.length) continue;
    const nucleus = segments.findIndex(segment => segment.role === 'nucleus');
    const { text } = current.syllable;
    clip.syllable_order.push(id);
    clip.syllables[id] = {
      id, text, ipa: segments.map(p => p.ipa), nucleus_index: Math.max(0, nucleus),
      start_smp: start, end_smp: end, segments, targets: [],
      anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
      overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
    };
  }
  if (!clip.syllable_order.length) return undefined;
  clip.source = {
    lang: 'ipa',
    lyrics: clip.syllable_order.map(id => clip.syllables[id].text).join(''),
    transcription: clip.syllable_order.map(id => clip.syllables[id].ipa.join('')).join(' '),
  };
  return clip;
}

export interface RenderedCell {
  wav: File;
  frames: PaintableTractFrame[];
  trajectory: Trajectory;
  duration: number;
  clip?: Clip;
}
export async function cellMovie(
  cell: RenderedCell,
  options?: { background?: string; viewBox?: TractViewBox },
): Promise<Blob> {
  const width = 720, height = 480;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const mime = typeof MediaRecorder === 'undefined' ? undefined
    : ['video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
  if (!ctx || !canvas.captureStream || !mime) throw new Error('当前浏览器无法编码带音频的 WebM 声道视频。');
  const resolvedPanelBg = options?.background
    || (typeof document !== 'undefined' ? getComputedStyle(document.documentElement).getPropertyValue('--panel').trim() : '')
    || 'Canvas';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const images: ImageBitmap[] = [];
  const audio = studioAudioContext();
  await audio.resume();
  const buffer = await audio.decodeAudioData(await cell.wav.arrayBuffer());
  const mix = audio.createMediaStreamDestination();
  const source = audio.createBufferSource();
  const stream = canvas.captureStream(25);
  let timer: number | undefined;
  let rafId = 0;
  let stopped = false;
  try {
    for (const frame of cell.frames) {
      paintReferenceFrame(svg, frame, { background: resolvedPanelBg, viewBox: options?.viewBox });
      svg.setAttribute('width', String(width));
      svg.setAttribute('height', String(height));
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        images.push(await createImageBitmap(image));
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    if (!images.length) throw new Error('没有用于导出的声道帧。');
    const labels = cell.clip?.syllable_order.map(id => cell.clip!.syllables[id]) ?? [];
    const draw = (t: number) => {
      const next = cell.frames.findIndex(frame => frame.t_s > t);
      const index = next < 0 ? images.length - 1 : Math.max(0, next - 1);
      const sample = Math.round(t * SAMPLE_RATE_HZ);
      const label = labels.find(item => item.start_smp <= sample && sample < item.end_smp);
      const phone = label?.segments.find(item => item.start_smp <= sample && sample < item.end_smp);
      ctx.fillStyle = resolvedPanelBg;
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(images[index], 0, 0, width, height);
      if (!label || (!label.text && !phone?.ipa)) return;
      ctx.fillStyle = 'rgba(29, 33, 37, .82)';
      ctx.fillRect(0, height - 50, width, 50);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 24px "PTBIPAPlus", "Microsoft YaHei", sans-serif';
      ctx.fillText([label.text, phone?.ipa && `[${phone.ipa}]`].filter(Boolean).join('   '), width / 2, height - 25, width - 32);
    };
    draw(0);
    source.buffer = buffer;
    source.connect(mix);
    stream.addTrack(mix.stream.getAudioTracks()[0]);
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks: Blob[] = [];
    const done = new Promise<Blob>((resolve, reject) => {
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => chunks.length ? resolve(new Blob(chunks, { type: recorder.mimeType })) : reject(new Error('没有可下载的视频帧。'));
      recorder.onerror = () => reject(new Error('视频编码失败。'));
    });
    source.onended = () => {
      stopped = true;
      if (recorder.state !== 'inactive') recorder.stop();
    };
    const start = audio.currentTime;
    recorder.start();
    source.start();
    const tick = () => {
      if (stopped) return;
      draw(Math.max(0, audio.currentTime - start));
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    timer = window.setInterval(() => {
      if (!stopped) draw(Math.max(0, audio.currentTime - start));
    }, 80);
    return await done;
  } finally {
    stopped = true;
    cancelAnimationFrame(rafId);
    window.clearInterval(timer);
    images.forEach(image => image.close());
    stream.getTracks().forEach(track => track.stop());
    source.disconnect();
    mix.disconnect();
  }
}

export interface StimulusCsvRow {
  step_a: number;
  step_b: number;
  filename: string;
  sample_rate_hz: number;
  num_samples?: number;
  f0_hz: number;
  duration_ms?: number;
  pressure_pa?: number;
  f1_hz?: number;
  f2_hz?: number;
  f3_hz?: number;
  amin_cm2?: number;
}

export function buildStimulusCsv(rows: readonly StimulusCsvRow[]): string {
  const headers = [
    'step_a', 'step_b', 'filename', 'sample_rate_hz', 'num_samples',
    'f0_hz', 'duration_ms', 'pressure_pa', 'f1_hz', 'f2_hz', 'f3_hz', 'amin_cm2',
  ] as const;
  const esc = (v: unknown) => {
    if (v === undefined || v === null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((k) => esc(row[k])).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export async function buildStimulusZip(params: {
  bundleJson: string;
  csvText: string;
  wavFiles: ReadonlyArray<{ filename: string; wav: File }>;
}): Promise<Blob> {
  const entries: Record<string, Uint8Array> = {
    'manifest.json': strToU8(params.bundleJson),
    'acoustic_table.csv': strToU8(params.csvText),
  };
  for (const item of params.wavFiles) {
    entries[`wav/${item.filename}`] = new Uint8Array(await item.wav.arrayBuffer());
  }
  const zipped = zipSync(entries, { level: 0 });
  const copy = new Uint8Array(zipped.byteLength);
  copy.set(zipped);
  return new Blob([copy], { type: 'application/zip' });
}
