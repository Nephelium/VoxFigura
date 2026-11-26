import { ref, shallowRef } from 'vue';
import type { TextGridDocument } from '@vocalcut/core';
import type { M27TrajectoryAnim } from '@vocalcut/model-adapters';
import type { IpaReference } from '@/data/ipa-reference-library';
import type { ReconstructionVersion as Version } from '@/data/reconstruction-history';
import jd2Rest from '@/data/jd2-rest.json';
import type { CurveMode, GlottisVisualFrame, VibrationMode } from '@/vendor/m27-tract-studio/tract-renderer.js';
import type { ReconstructionCutSnapshot } from './reconstruction-cut';

export const M27_AXIS_WIDTH_PX = 84;
export const M27_ZOOMS = [1, 1.5, 2, 3, 4, 6, 8, 10, 12] as const;
export const M27_MIN_ZOOM = 1;
export const M27_MAX_ZOOM = 12;
export const M27_WINDOW_MS_OPTIONS = [80, 120, 200] as const;
export type AuditionWindowMs = (typeof M27_WINDOW_MS_OPTIONS)[number];

/**
 * Static modal glottis state rendered in the bottom-right anatomy canvas
 * before any audio is reconstructed (T-12: never blank or hidden).
 */
export const MODAL_STATIC_GLOTTIS_STATE: GlottisVisualFrame & {
  voiced: boolean;
  flowSub: number;
  flowJet: number;
} = {
  t: 0,
  f0: 120,
  pr_pa: 0,
  xb: 0.04,
  xt: 0.04,
  ca: 0.02,
  lag: 1.222,
  ra: 0,
  ps: 0.5,
  fl: 25,
  shim: 0,
  voiced: false,
  flowSub: 0,
  flowJet: 0,
};

export interface CachedSpectrogramBitmap {
  sourceBlob: Blob | null;
  durationSec: number;
  pcm: Float32Array | null;
  sampleRate: number;
  bitmap: HTMLCanvasElement | null;
}

/**
 * Module-level persistent reactive session for M27 Vocal Tract Reconstruction (T-55).
 * Preserves audio, spectrogram bitmap, 50 Hz M27 trajectory, synthesized audio URLs,
 * edited TextGrid boundaries, zoom, and playhead across tab/workspace switches.
 */
export const m27Session = {
  sourceFile: shallowRef<Blob | null>(null),
  originalSource: shallowRef<Blob | null>(null),
  originalSourceUrl: ref(''),
  sourceName: ref(''),
  decodedBuffer: shallowRef<AudioBuffer | null>(null),

  speakerFile: shallowRef<File | null>(null),
  originalSpeaker: shallowRef<File | null>(null),
  /** T-11: Default strictly to 'input' ("沿用输入音色"), never lecture voice. */
  speakerChoice: ref<string>('input'),
  voiceName: ref(''),

  sourceReference: shallowRef<IpaReference | null>(null),
  sourceTextGrid: shallowRef<TextGridDocument | null>(null),
  sourceTextGridName: ref(''),
  alignmentText: ref(''),
  alignmentLang: ref<'auto' | 'zh' | 'en'>('auto'),
  alignmentMessage: ref(''),

  historyId: ref(''),
  historyStatus: ref(''),

  rows: shallowRef<number[][]>([]),
  anim: shallowRef<M27TrajectoryAnim | null>(null),
  currentDevice: ref(''),
  outputs: shallowRef<{ neural: Blob | null; physical: Blob | null }>({ neural: null, physical: null }),
  urls: ref<{ source: string; neural: string; physical: string }>({ source: '', neural: '', physical: '' }),
  version: ref<Version>('source'),

  playheadSec: ref(0),
  mediaDuration: ref(0),
  speed: ref(1),
  zoom: ref(1),
  viewStartSec: ref(0),
  selectionSec: shallowRef<[number, number] | null>(null),
  cutUndo: shallowRef<ReconstructionCutSnapshot[]>([]),
  auditionWindowMs: ref<AuditionWindowMs>(120),

  showLabels: ref(false),
  vibMode: ref<VibrationMode>('strobe'),
  curveMode: ref<CurveMode>('all'),
  status: ref(''),

  spectrogramCache: shallowRef<CachedSpectrogramBitmap>({
    sourceBlob: null,
    durationSec: 0,
    pcm: null,
    sampleRate: 16000,
    bitmap: null,
  }),
};

/** VTL contour for the factory JD2 [ə], with glottal driving set to zero. */
export const neutralJd2Anim: M27TrajectoryAnim = jd2Rest.animation;

// Older reconstructions baked this exact tract vector into settled silence.
const LEGACY_REST_TRACT = [
  1, -4.75, 0, -2.5, -0.05, 0.55, 0, -0.08,
  -0.4, -0.8, 1.8, -1.6, 0.5, -0.8, 0.15, 0.05, 0,
];

export function updateLegacyReconstructionRest(
  rows: number[][],
  animation: M27TrajectoryAnim | null,
): { rows: number[][]; animation: M27TrajectoryAnim | null } {
  const legacyFrames = new Set<number>();
  const updatedRows = rows.map((row, i) => {
    if (row[18] !== 0 || row[23] !== 0 ||
        !LEGACY_REST_TRACT.every((value, j) => Math.abs(row[j] - value) <= 0.00005)) {
      return row;
    }
    legacyFrames.add(i);
    return [...jd2Rest.tract17, ...row.slice(17)];
  });
  if (!legacyFrames.size) return { rows, animation };
  if (animation?.schema !== neutralJd2Anim.schema ||
      animation.parts.length !== neutralJd2Anim.parts.length ||
      !animation.parts.every((part, i) => part === neutralJd2Anim.parts[i] && animation.part_sizes[i] === neutralJd2Anim.part_sizes[i])) {
    return { rows: updatedRows, animation };
  }
  const { pts, nasal, ja, jx, lp, ld, vo, lm, srib, brib, frib } = neutralJd2Anim.frames[0];
  const geometry = { pts, nasal, ja, jx, lp, ld, vo, lm, srib, brib, frib };
  const frames = animation.frames.map((frame) => (
    legacyFrames.has(Math.round(frame.t * 50)) ? { ...frame, ...geometry } : frame
  ));
  return { rows: updatedRows, animation: { ...animation, frames } };
}

/**
 * Strip redundant parenthetical Pinyin annotations on word/syllable tier labels,
 * e.g. `春 (chūn)` -> `春`, `春（chūn）` -> `春` (T-54).
 */
export function stripRedundantPinyin(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const cleaned = trimmed
    .replace(/\s*[（(][A-Za-z\u00C0-\u024F\u1E00-\u1EFF0-9\s'’·-]+?[)）]/gu, '')
    .trim();
  return cleaned || trimmed;
}

/**
 * Clean redundant Pinyin from non-phoneme IntervalTiers of a TextGridDocument (T-54).
 */
export function cleanTextGridWordLabels(grid: TextGridDocument): TextGridDocument {
  return {
    ...grid,
    tiers: grid.tiers.map((tier) => {
      if (tier.kind !== 'IntervalTier') return tier;
      const isPhone = /phone|phoneme|segment|\bseg\b|ipa|音素|音标/i.test(tier.name);
      if (isPhone) return tier;
      return {
        ...tier,
        intervals: tier.intervals.map((iv) => ({
          ...iv,
          text: iv.text.trim() ? stripRedundantPinyin(iv.text) : iv.text,
        })),
      };
    }),
  };
}

export function replaceM27Url(key: Version, url = ''): void {
  const old = m27Session.urls.value[key];
  if (old && old !== url && old.startsWith('blob:')) {
    URL.revokeObjectURL(old);
  }
  m27Session.urls.value = { ...m27Session.urls.value, [key]: url };
}

export function clearM27Outputs(): void {
  m27Session.version.value = 'source';
  replaceM27Url('neural');
  replaceM27Url('physical');
  m27Session.outputs.value = { neural: null, physical: null };
  m27Session.anim.value = null;
  m27Session.rows.value = [];
  m27Session.currentDevice.value = '';
}

export function resetM27SessionSource(name: string): void {
  clearM27Outputs();
  replaceM27Url('source');
  m27Session.sourceFile.value = null;
  m27Session.originalSource.value = null;
  m27Session.originalSourceUrl.value = '';
  m27Session.decodedBuffer.value = null;
  m27Session.sourceReference.value = null;
  m27Session.sourceTextGrid.value = null;
  m27Session.sourceTextGridName.value = '';
  m27Session.alignmentText.value = '';
  m27Session.alignmentLang.value = 'auto';
  m27Session.alignmentMessage.value = '';
  m27Session.sourceName.value = name;
  m27Session.historyId.value = '';
  m27Session.historyStatus.value = '';
  m27Session.playheadSec.value = 0;
  m27Session.mediaDuration.value = 0;
  m27Session.zoom.value = 1;
  m27Session.viewStartSec.value = 0;
  m27Session.selectionSec.value = null;
  m27Session.cutUndo.value = [];
  m27Session.status.value = '';
  m27Session.spectrogramCache.value = {
    sourceBlob: null,
    durationSec: 0,
    pcm: null,
    sampleRate: 16000,
    bitmap: null,
  };
}
