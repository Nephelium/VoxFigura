import {
  SAMPLE_RATE_HZ,
  hzToSt,
  type Clip,
  type TextGridDocument,
  type TextGridInterval,
  type TractParamName,
  type VcProject,
} from '@vocalcut/core';
import type { M27TrajectoryAnim } from '@vocalcut/model-adapters';
import { buildAnnotationSynthesis } from '@/components/research/annotation-audio';
import { currentAnnotationControls } from '@/components/research/annotation-return';
import { phoneTraits } from '@/data/ipa-segments';

export type TimeSeriesSamplingMode = '50hz' | 'norm10';

export const TRACT_19_COLUMN_NAMES: readonly TractParamName[] = [
  'HX', 'HY', 'JX', 'JA', 'LP', 'LD', 'VS', 'VO',
  'TCX', 'TCY', 'TTX', 'TTY', 'TBX', 'TBY', 'TRX', 'TRY',
  'TS1', 'TS2', 'TS3',
] as const;

const M27_TRACT17_TO_19_INDEX = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18] as const;
const JD2_NEUTRAL_ROOT = [-2.24, -2.95] as const;

export const TIMESERIES_CSV_COLUMNS = [
  'source_mode',
  'sampling_mode',
  'speaker',
  'clip_id',
  'syllable_idx',
  'syllable_id',
  'syllable_text',
  'tone_levels',
  'phone_idx',
  'phone_ipa',
  'phone_role',
  'voiced',
  'frame_idx',
  'sample_smp',
  'time_s',
  'time_ms',
  'u_syllable',
  'u_phone',
  'f0_hz',
  'f0_st',
  'pr_pa',
  'xb_cm',
  'xt_cm',
  'ca_cm2',
  'lag_rad',
  'ra',
  'ps',
  'fl_pct',
  'shim_pct',
  'larynx_height_cm',
  'lip_width',
  'amin_cm2',
  'f1_hz',
  'f2_hz',
  'f3_hz',
  ...TRACT_19_COLUMN_NAMES,
] as const;

function escapeCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function fmtNum(v: number | null | undefined, digits = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  return Number(v.toFixed(digits)).toString();
}

function interpolateVector(rows: readonly (readonly number[])[], pos: number): number[] {
  if (!rows.length) return [];
  const clamped = Math.max(0, Math.min(rows.length - 1, pos));
  const i0 = Math.floor(clamped);
  const i1 = Math.min(rows.length - 1, Math.ceil(clamped));
  const a = rows[i0];
  const b = rows[i1];
  if (!a) return [];
  if (!b || i0 === i1) return [...a];
  const w = clamped - i0;
  return a.map((val, idx) => val + ((b[idx] ?? val) - val) * w);
}

function interpolateScalar(values: readonly number[], pos: number): number {
  if (!values.length) return 0;
  const clamped = Math.max(0, Math.min(values.length - 1, pos));
  const i0 = Math.floor(clamped);
  const i1 = Math.min(values.length - 1, Math.ceil(clamped));
  const a = values[i0] ?? 0;
  const b = values[i1] ?? a;
  if (i0 === i1) return a;
  return a + (b - a) * (clamped - i0);
}

export interface AnnotationTimeSeriesOptions {
  project: VcProject;
  clip: Clip;
  mode: TimeSeriesSamplingMode;
  fallbackTract19?: readonly number[];
  fallbackLipWidth?: number;
  fallbackLarynxHeight?: number;
  pointsPerSegment?: number;
}

/**
 * Export a multi-column R / GAMM / SSANOVA ready long-format CSV from a project phrase Clip.
 * Includes UTF-8 BOM (`\uFEFF`) so Windows Excel & R/Pandas both parse IPA and CJK cleanly.
 */
export function buildAnnotationTimeSeriesCsv(opts: AnnotationTimeSeriesOptions): {
  ok: true;
  csv: string;
  rowCount: number;
} | {
  ok: false;
  hint: string;
} {
  const { project, clip, mode } = opts;
  const syllables = clip.syllable_order.map((id) => clip.syllables[id]).filter(Boolean);
  if (!syllables.length || clip.end_smp <= clip.start_smp) {
    return { ok: false, hint: '当前乐句没有可导出的音节或时间序列' };
  }

  const voice = project.voices[clip.voice_id ?? project.voice_order[0]];
  const speaker = voice?.speaker ?? 'JD2';
  const f0RefHz = voice?.f0_ref_hz ?? 165;
  const controls = clip.annotation_controls ?? currentAnnotationControls(project);
  const anchors = controls.phonation_anchor_order
    .map((id) => controls.phonation_anchors[id])
    .filter(Boolean);

  const defaultTract19 = opts.fallbackTract19?.length === 19
    ? [...opts.fallbackTract19]
    : [1.0, -4.75, 0.0, -2.0, -0.07, 0.95, 0.0, -0.1, -0.4, -1.46, 3.5, -1.0, 2.0, 0.5, -2.24, -2.95, 0.0, 0.0, 0.0];

  const synthRes = buildAnnotationSynthesis(
    project,
    clip,
    anchors,
    clip.start_smp,
    clip.end_smp,
    {
      f0Hz: f0RefHz,
      tract: defaultTract19,
      releaseTract: defaultTract19,
      lipWidth: opts.fallbackLipWidth ?? 1.0,
      larynxHeight: opts.fallbackLarynxHeight ?? 0.0,
    },
  );
  if (!synthRes.ok) {
    return { ok: false, hint: synthRes.error.hint };
  }

  const syn = synthRes.value;
  const stepSmp200Hz = SAMPLE_RATE_HZ / syn.step_hz; // 240 samples @ 200 Hz
  const frameCount200 = syn.f0_hz.length;
  if (!frameCount200) {
    return { ok: false, hint: '合成控制轨迹为空，无法导出时间序列' };
  }

  interface FlatPhoneMeta {
    sylIdx: number;
    sylId: string;
    sylText: string;
    toneLevels: string;
    sylStart: number;
    sylEnd: number;
    phoneIdx: number;
    phoneIpa: string;
    phoneRole: string;
    voiced: boolean;
    startSmp: number;
    endSmp: number;
  }

  const flatPhones: FlatPhoneMeta[] = [];
  syllables.forEach((syl, sylIdx) => {
    syl.segments.forEach((seg, segIdx) => {
      flatPhones.push({
        sylIdx: sylIdx + 1,
        sylId: syl.id,
        sylText: syl.text,
        toneLevels: syl.tone_levels ?? '',
        sylStart: syl.start_smp,
        sylEnd: syl.end_smp,
        phoneIdx: segIdx + 1,
        phoneIpa: seg.ipa,
        phoneRole: seg.role,
        voiced: seg.voiced,
        startSmp: seg.start_smp,
        endSmp: seg.end_smp,
      });
    });
  });

  const findPhoneAt = (smp: number): FlatPhoneMeta | undefined =>
    flatPhones.find((p) => smp >= p.startSmp && smp < p.endSmp);

  const lines: string[] = [TIMESERIES_CSV_COLUMNS.join(',')];
  let rowIndex = 0;

  const appendSampleRow = (sampleSmp: number, explicitPhone?: FlatPhoneMeta, explicitUPhone?: number) => {
    const pos200 = (sampleSmp - clip.start_smp) / stepSmp200Hz;
    const f0Hz = interpolateScalar(syn.f0_hz, pos200);
    const prPa = interpolateScalar(syn.pressure_pa, pos200);
    const tract19 = interpolateVector(syn.tract_frames, pos200);
    const glot8 = interpolateVector(syn.glottis_frames, pos200);
    const lipW = interpolateScalar(syn.lip_width_frames, pos200);
    const larH = interpolateScalar(syn.larynx_height_frames, pos200);

    const ph = explicitPhone ?? findPhoneAt(sampleSmp);
    const isVoiced = Boolean(ph && ph.phoneRole !== 'rest' && ph.voiced && prPa > 5 && f0Hz > 0);
    const uSyl = ph
      ? Math.max(0, Math.min(1, (sampleSmp - ph.sylStart) / Math.max(1, ph.sylEnd - ph.sylStart)))
      : null;
    const uPh = explicitUPhone !== undefined
      ? explicitUPhone
      : ph
        ? Math.max(0, Math.min(1, (sampleSmp - ph.startSmp) / Math.max(1, ph.endSmp - ph.startSmp)))
        : null;

    const timeSec = sampleSmp / SAMPLE_RATE_HZ;
    const rowCells: Array<string | number | boolean> = [
      'annotation_synth',
      mode,
      speaker,
      clip.id,
      ph ? ph.sylIdx : '',
      ph ? ph.sylId : '',
      ph ? ph.sylText : '',
      ph ? ph.toneLevels : '',
      ph ? ph.phoneIdx : '',
      ph ? ph.phoneIpa : 'sil',
      ph ? ph.phoneRole : 'rest',
      isVoiced ? 1 : 0,
      rowIndex++,
      Math.round(sampleSmp),
      fmtNum(timeSec, 5),
      fmtNum(timeSec * 1000, 2),
      uSyl !== null ? fmtNum(uSyl, 4) : '',
      uPh !== null ? fmtNum(uPh, 4) : '',
      fmtNum(f0Hz, 2),
      f0Hz > 0 && f0RefHz > 0 ? fmtNum(hzToSt(f0Hz, f0RefHz), 3) : '',
      fmtNum(prPa, 2),
      fmtNum(glot8[0], 4),
      fmtNum(glot8[1], 4),
      fmtNum(glot8[2], 4),
      fmtNum(glot8[3], 4),
      fmtNum(glot8[4], 4),
      fmtNum(glot8[5], 4),
      fmtNum(glot8[6], 2),
      fmtNum(glot8[7], 2),
      fmtNum(larH, 4),
      fmtNum(lipW, 4),
      '',
      '',
      '',
      '',
      ...TRACT_19_COLUMN_NAMES.map((_, i) => fmtNum(tract19[i], 5)),
    ];
    lines.push(rowCells.map(escapeCsvCell).join(','));
  };

  if (mode === '50hz') {
    const step50HzSmp = SAMPLE_RATE_HZ / 50; // 960 samples = 20 ms
    for (let smp = clip.start_smp; smp < clip.end_smp; smp += step50HzSmp) {
      appendSampleRow(smp);
    }
  } else {
    const nPts = Math.max(2, Math.min(50, Math.round(opts.pointsPerSegment ?? 10)));
    const activePhones = flatPhones.filter((p) => p.phoneRole !== 'rest' && p.endSmp > p.startSmp);
    if (!activePhones.length) {
      return { ok: false, hint: '当前乐句没有非静音音素区间，无法按音段等分导出' };
    }
    for (const ph of activePhones) {
      const span = Math.max(1, ph.endSmp - ph.startSmp - 1);
      for (let k = 0; k < nPts; k++) {
        const u = k / (nPts - 1);
        const smp = ph.startSmp + u * span;
        appendSampleRow(smp, ph, u);
      }
    }
  }

  return {
    ok: true,
    csv: '\uFEFF' + lines.join('\n'),
    rowCount: rowIndex,
  };
}

export interface M27TimeSeriesOptions {
  rows50HzPa: readonly (readonly number[])[];
  mode: TimeSeriesSamplingMode;
  speaker?: string;
  clipId?: string;
  f0RefHz?: number;
  textGrid?: TextGridDocument | null;
  anim?: M27TrajectoryAnim | null;
  pointsPerSegment?: number;
}

function isSilentLabel(label: string): boolean {
  const clean = label.trim().toLowerCase();
  return !clean || clean === 'sil' || clean === 'sp' || clean === 'spn' || clean === '<eps>' || clean === '#';
}

/**
 * Export a multi-column long-format CSV from 50 Hz `Vox2Tract-Lite` reconstructed `M27` rows (in Pa).
 */
export function buildM27ReconstructionTimeSeriesCsv(opts: M27TimeSeriesOptions): {
  ok: true;
  csv: string;
  rowCount: number;
} | {
  ok: false;
  hint: string;
} {
  const { rows50HzPa, mode } = opts;
  if (!rows50HzPa.length || rows50HzPa[0]?.length !== 27) {
    return { ok: false, hint: '当前没有可导出的 27 维声道重建序列' };
  }

  const speaker = opts.speaker || 'JD2';
  const clipId = opts.clipId || 'm27-reconstruction';
  const f0RefHz = opts.f0RefHz && opts.f0RefHz > 0 ? opts.f0RefHz : 165;
  const intervalTiers = (opts.textGrid?.tiers ?? []).filter(
    (t): t is Extract<TextGridDocument['tiers'][number], { kind: 'IntervalTier' }> => t.kind === 'IntervalTier',
  );
  const wordTier = intervalTiers.length > 1 ? intervalTiers[0] : undefined;
  const phoneTier = intervalTiers.length > 1 ? intervalTiers[intervalTiers.length - 1] : intervalTiers[0];
  const animFrames = (opts.anim as unknown as { frames?: Array<Record<string, unknown>> } | null)?.frames ?? [];

  const findInterval = (intervals: readonly TextGridInterval[] | undefined, tSec: number) => {
    if (!intervals?.length) return undefined;
    const idx = intervals.findIndex((iv) => tSec >= iv.xmin && tSec < iv.xmax);
    return idx >= 0 ? { iv: intervals[idx], idx: idx + 1 } : undefined;
  };

  const lines: string[] = [TIMESERIES_CSV_COLUMNS.join(',')];
  let rowIndex = 0;

  const appendAtTimeSec = (tSec: number, explicitPhone?: { iv: TextGridInterval; idx: number }, explicitUPhone?: number) => {
    const framePos = Math.max(0, Math.min(rows50HzPa.length - 1, tSec * 50));
    const row27 = interpolateVector(rows50HzPa, framePos);
    const tract19 = Array<number>(19).fill(0);
    tract19[14] = JD2_NEUTRAL_ROOT[0];
    tract19[15] = JD2_NEUTRAL_ROOT[1];
    M27_TRACT17_TO_19_INDEX.forEach((col19, idx17) => {
      tract19[col19] = row27[idx17] ?? 0;
    });

    const f0Hz = row27[17] ?? 0;
    const prPa = row27[18] ?? 0;
    const glot8 = row27.slice(19, 27);

    const wHit = findInterval(wordTier?.intervals, tSec);
    const pHit = explicitPhone ?? findInterval(phoneTier?.intervals, tSec);
    const phoneText = pHit ? pHit.iv.text.trim() : '';
    const wordText = wHit ? wHit.iv.text.trim() : '';
    const silent = isSilentLabel(phoneText || wordText);
    const traits = !silent && phoneText ? phoneTraits(phoneText) : null;
    const voiced = !silent && prPa > 15 && glot8[4] > 0.05 && f0Hz > 0;

    const uSyl = wHit && !isSilentLabel(wordText)
      ? Math.max(0, Math.min(1, (tSec - wHit.iv.xmin) / Math.max(1e-6, wHit.iv.xmax - wHit.iv.xmin)))
      : null;
    const uPh = explicitUPhone !== undefined
      ? explicitUPhone
      : pHit && !silent
        ? Math.max(0, Math.min(1, (tSec - pHit.iv.xmin) / Math.max(1e-6, pHit.iv.xmax - pHit.iv.xmin)))
        : null;

    const animIdx = Math.min(animFrames.length - 1, Math.max(0, Math.round(framePos)));
    const af = animFrames[animIdx];
    const amin = typeof af?.amin_cm2 === 'number' ? af.amin_cm2 : typeof af?.oral_min_area_cm2 === 'number' ? af.oral_min_area_cm2 : null;
    const fArr = Array.isArray(af?.formants_hz) ? (af.formants_hz as number[]) : null;

    const sampleSmp = Math.round(tSec * SAMPLE_RATE_HZ);
    const rowCells: Array<string | number | boolean> = [
      'm27_reconstruction',
      mode,
      speaker,
      clipId,
      wHit && !isSilentLabel(wordText) ? wHit.idx : '',
      wHit && !isSilentLabel(wordText) ? `word_${wHit.idx}` : '',
      !isSilentLabel(wordText) ? wordText : '',
      '',
      pHit && !silent ? pHit.idx : '',
      silent ? 'sil' : phoneText,
      silent ? 'rest' : traits?.vowel ? 'nucleus' : 'consonant',
      voiced ? 1 : 0,
      rowIndex++,
      sampleSmp,
      fmtNum(tSec, 5),
      fmtNum(tSec * 1000, 2),
      uSyl !== null ? fmtNum(uSyl, 4) : '',
      uPh !== null ? fmtNum(uPh, 4) : '',
      fmtNum(f0Hz, 2),
      f0Hz > 0 ? fmtNum(hzToSt(f0Hz, f0RefHz), 3) : '',
      fmtNum(prPa, 2),
      fmtNum(glot8[0], 4),
      fmtNum(glot8[1], 4),
      fmtNum(glot8[2], 4),
      fmtNum(glot8[3], 4),
      fmtNum(glot8[4], 4),
      fmtNum(glot8[5], 4),
      fmtNum(glot8[6], 2),
      fmtNum(glot8[7], 2),
      '',
      '',
      amin !== null ? fmtNum(amin, 4) : '',
      fArr && Number.isFinite(fArr[0]) ? fmtNum(fArr[0], 1) : '',
      fArr && Number.isFinite(fArr[1]) ? fmtNum(fArr[1], 1) : '',
      fArr && Number.isFinite(fArr[2]) ? fmtNum(fArr[2], 1) : '',
      ...TRACT_19_COLUMN_NAMES.map((_, i) => fmtNum(tract19[i], 5)),
    ];
    lines.push(rowCells.map(escapeCsvCell).join(','));
  };

  if (mode === '50hz') {
    for (let i = 0; i < rows50HzPa.length; i++) {
      appendAtTimeSec(i / 50);
    }
  } else {
    const nPts = Math.max(2, Math.min(50, Math.round(opts.pointsPerSegment ?? 10)));
    const activePhoneIntervals = (phoneTier?.intervals ?? [])
      .map((iv, i) => ({ iv, idx: i + 1 }))
      .filter(({ iv }) => !isSilentLabel(iv.text) && iv.xmax > iv.xmin + 1e-4);

    if (activePhoneIntervals.length > 0) {
      for (const item of activePhoneIntervals) {
        const span = item.iv.xmax - item.iv.xmin;
        for (let k = 0; k < nPts; k++) {
          const u = k / (nPts - 1);
          appendAtTimeSec(item.iv.xmin + u * span, item, u);
        }
      }
    } else {
      const totalDurSec = Math.max(0.02, (rows50HzPa.length - 1) / 50);
      for (let k = 0; k < nPts; k++) {
        const u = k / (nPts - 1);
        appendAtTimeSec(u * totalDurSec, undefined, u);
      }
    }
  }

  return {
    ok: true,
    csv: '\uFEFF' + lines.join('\n'),
    rowCount: rowIndex,
  };
}
