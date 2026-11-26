import { shallowRef, type ShallowRef } from 'vue';
import type { Clip, SandhiSyllableOutput, TractParamName } from '@vocalcut/core';
import type { AnnotationTractFrame } from '@/components/research/annotation-edit';
import type { TractPoseExtras } from '@/data/ptb-ipa-presets';

export interface IpaPanelSnapshot {
  symbol: string;
  system: 'ipa' | 'extipa' | 'voqs';
  nameZh: string;
  nameEn: string;
  section: string;
  codePoints?: string[];
  descriptionZh: string;
  usageZh?: string;
  contrastZh?: string;
  notesZh?: string;
  representation?: string;
  aliases?: string[];
  examples?: Array<{ text: string; noteZh?: string }>;
  sourceRefs?: Array<{ title: string; locator?: string }>;
  params: Record<TractParamName, number>;
  extras: TractPoseExtras;
  referenceId?: string;
  referenceTitle?: string;
  referenceHasAudio?: boolean;
  referenceHasAnimation?: boolean;
  referencePhones?: Array<{ start_s: number; end_s: number; label: string }>;
  recordingBlob?: Blob | null;
  recordingDuration_s?: number;
  m27RowsPa?: number[][];
}

export interface SynthesisPanelSnapshot {
  lyrics: string;
  standardLabel: string;
  clip: Clip | null;
  audioBuffer: AudioBuffer | null;
  startSmp: number;
  tractFrames: AnnotationTractFrame[];
  m27RowsPa?: number[][];
}

export interface MixerPanelSnapshot {
  mode: 'preset' | 'dual';
  presetId: string;
  presetLabel: string;
  presetDesc: string;
  source9Phys?: number[];
  f0ShiftSt: number;
  interpolation: 'smoothstep' | 'linear';
  curves: Record<string, Array<{ t: number; v: number }>>;
  enabledGroups: string[];
  inputName?: string;
  inputDuration_s: number;
  inputBlob?: Blob | null;
  waveformPeaks?: number[];
  gateSeries?: number[];
  alignIntervals?: Array<{ xmin: number; xmax: number; text: string }>;
  outputBlob?: Blob | null;
  outputDuration_s?: number;
  appliedCurves?: Record<string, number[]>;
}

export interface ContinuumCellSnapshot {
  key: string;
  stepA: number;
  stepB: number;
  blend: number;
  f0_hz: number;
  axisBadge: string;
  params: Record<TractParamName, number>;
  extras: TractPoseExtras;
  metrics?: { f1_hz: number; f2_hz: number; f3_hz: number; amin_cm2: number };
  hdContour?: {
    parts: Record<string, number[][]>;
    lm: number[];
    nasal: number;
  };
}

export interface ContinuumPanelSnapshot {
  dualAxis: boolean;
  horizontalAxis: string;
  verticalAxis: string;
  columns: number;
  rows: number;
  labelA: string;
  ipaA: string;
  labelB: string;
  ipaB: string;
  viewBox?: string;
  cells: ContinuumCellSnapshot[];
  sequenceAudio?: AudioBuffer | null;
  sequenceParts?: Array<{ key: string; start_s: number; end_s: number }>;
}

export interface DialectPanelSnapshot {
  packName: string;
  tones: Array<{
    id?: string;
    name: string;
    chao: string;
    pts: number[];
    checked?: boolean;
    f0?: Array<{ u: number; hz: number }>;
  }>;
  activeToneIdx: number;
  sandboxInput: string;
  sandboxTrace: SandhiSyllableOutput[];
}

export interface ArrangerPanelSnapshot {
  partName: string;
  tonic: string;
  bpm: number;
  lyrics: string;
  scoreText: string;
  endSmp: number;
  notes: Array<{
    text: string;
    ipa: string;
    midi: number | null;
    noteLabel: string;
    start_smp: number;
    end_smp: number;
  }>;
  phones: Array<{
    ipa: string;
    start_smp: number;
    end_smp: number;
  }>;
  f0Points: Array<{ t_smp: number; f0_hz: number }>;
  audioBuffer?: AudioBuffer | null;
  poseFrames?: Array<{ u: number; params: number[] }>;
  m27RowsPa?: number[][];
}

export interface PanelSnapshotMap {
  ipa: IpaPanelSnapshot | null;
  synthesis: SynthesisPanelSnapshot | null;
  mixer: MixerPanelSnapshot | null;
  continuum: ContinuumPanelSnapshot | null;
  dialect: DialectPanelSnapshot | null;
  arranger: ArrangerPanelSnapshot | null;
}

export const panelSnapshots: {
  readonly [K in keyof PanelSnapshotMap]: ShallowRef<PanelSnapshotMap[K]>;
} = {
  ipa: shallowRef<IpaPanelSnapshot | null>(null),
  synthesis: shallowRef<SynthesisPanelSnapshot | null>(null),
  mixer: shallowRef<MixerPanelSnapshot | null>(null),
  continuum: shallowRef<ContinuumPanelSnapshot | null>(null),
  dialect: shallowRef<DialectPanelSnapshot | null>(null),
  arranger: shallowRef<ArrangerPanelSnapshot | null>(null),
};

export function publishPanelSnapshot<K extends keyof PanelSnapshotMap>(
  kind: K,
  snapshot: PanelSnapshotMap[K],
): void {
  panelSnapshots[kind].value = snapshot;
}
