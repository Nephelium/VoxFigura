/**
 * Unified Speech & Singing Scheduler (48 kHz Integer Samples, Half-Open Intervals)
 *
 * Replaces separate speech/singing top-level modes with one unified pipeline:
 *  - Nucleus-on-beat alignment when musical score/beats are provided
 *  - Consonant lead-time budget & compression between adjacent nuclei
 *  - Rigid stop_timing floor enforcement (closure >= 10 ms, release >= 1 ms)
 *  - Full numbered-score dynamics (`p/pp/ppp/f/ff/fff` & `(1p23)ff` +/-120 Pa/level)
 *  - Dense `f0_hz[]` and `pressure_pa[]` emission (no 201-point ceiling)
 */

import {
  MAX_SEQUENCE_SECONDS,
  PRESSURE_LIMIT_PA,
  SAMPLE_RATE_HZ,
  assertInRange,
  assertValidF0Hz,
  fail,
  hzToSt,
  msToSamples,
  ok,
  outOfRange,
  samplesToMs,
  type CoreErrorDetail,
  type F0PinSegment,
  type F0ResidualSegment,
  type PerturbationConfig,
  type PressurePoint,
  type QtaTargetSpan,
  type Result,
  type SegmentAnchor,
  type StopTiming,
  type Syllable,
  type VibratoConfig,
} from './types';
import { evalF0, toneLevelsToQtaTargets } from './qta';
import {
  DEFAULT_SCORE_NOTATION,
  TONIC_MIDI,
  parseScoreNotation,
  type ParseNotationOptions,
  type ScoreIssue,
  type ScoreNotationId,
  type SongNote,
  type SongScore,
  type SongTonic,
} from './score-notation';

export { TONIC_MIDI, type SongTonic, type SongNote, type SongScore, type ScoreIssue };

export const STOP_RIGID_FLOOR = {
  closure_ms: 10,
  release_ms: 1,
} as const;

export const DEFAULT_BASE_PRESSURE_PA = 800;
export const DYNAMIC_STEP_PA = 120;

/**
 * Parse numbered score notation using the unified JE / open-source Jianpu DSL engine.
 * Legacy custom shorthand has been completely removed.
 */
export function parseNumberedScore(
  source: string,
  tonic: SongTonic,
  bpm: number,
  vibrato: boolean,
  expectedRows?: number,
  options?: ParseNotationOptions,
) {
  return parseScoreNotation(source, tonic, bpm, vibrato, expectedRows, {
    notation: DEFAULT_SCORE_NOTATION,
    ...options,
  });
}

export type { ScoreNotationId };

export interface ScheduleSegmentInput {
  id: string;
  ipa: string;
  role: 'onset' | 'nucleus' | 'coda' | 'aspiration' | 'rest';
  voiced: boolean;
  preferred_ms: number;
  min_ms?: number;
  is_stop?: boolean;
  stop_timing?: StopTiming;
  params?: number[];
}

export interface ScheduleSyllableInput {
  id: string;
  text: string;
  segments: ScheduleSegmentInput[];
  tone_levels?: string; // e.g. "55", "35", "21", "214", "51"
  checked?: boolean;
  note_hz?: number;      // direct pitch in Hz (singing)
  note_beats?: number;   // duration in beats (when bpm provided)
  rest_before_beats?: number; // accumulated rest duration in beats before this syllable
  dynamic_level?: number; // -3..+3 (p..fff)
  pressure_pa?: number;   // base pressure in Pa (default 800)
  pressure_envelope?: PressurePoint[]; // optional hand-drawn non-piano PS curve
  lead_policy?: 'nucleus_on_beat' | 'onset_on_beat';
  lead_ms?: number | null;
  bias_ms?: number;
  lambda_per_s?: number;
  residuals?: F0ResidualSegment[];
  target_overrides?: QtaTargetSpan['candidates'];
}

export interface ScheduleInput {
  syllables: ScheduleSyllableInput[];
  score?: SongScore;
  bpm?: number;
  leading_reserve_ms?: number; // e.g. 100 ms -> 4800 smp
  f_ref_hz: number;
  range_st?: [number, number];
  step_smp?: number;           // default 240 (5 ms @ 48 kHz = 200 Hz)
  base_pressure_pa?: number;   // default 800 Pa
  global_pressure_envelope?: PressurePoint[];
  pins?: F0PinSegment[];
  vibrato?: Partial<VibratoConfig>;
  perturbation?: Partial<PerturbationConfig>;
  allow_vowel_delay_on_conflict?: boolean;
  finalCodaWithinBeat?: boolean;
}

export interface ScheduledSegment {
  id: string;
  syllable_id: string;
  ipa: string;
  role: SegmentAnchor['role'];
  start_smp: number;
  end_smp: number;
  voiced: boolean;
  elastic: boolean;
  stop_timing?: StopTiming;
  params?: number[];
}

export interface ScheduledSyllable {
  id: string;
  text: string;
  start_smp: number;
  end_smp: number;
  beat_smp: number;
  nucleus_start_smp: number;
  lead_ms: number;
  compression_ratio: number;
  pressure_pa: number;
  segments: ScheduledSegment[];
}

export interface ScheduleOutput {
  total_smp: number;
  step_smp: number;
  bpm?: number;
  leading_reserve_smp: number;
  syllables: ScheduledSyllable[];
  segments: ScheduledSegment[];
  f0_hz: number[];
  f0_st: number[];
  voiced_mask: boolean[];
  pressure_pa: number[];
  issues: ScoreIssue[];
}

function interpolatePressurePoints(points: readonly PressurePoint[], u: number, fallbackPa: number): number {
  if (points.length === 0) return fallbackPa;
  const pts = [...points].sort((a, b) => a.u - b.u);
  if (u <= pts[0].u) return pts[0].pressure_pa;
  const last = pts[pts.length - 1];
  if (u >= last.u) return last.pressure_pa;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (u >= a.u && u <= b.u) {
      const span = b.u - a.u;
      const frac = span > 0 ? (u - a.u) / span : 0;
      return a.pressure_pa + (b.pressure_pa - a.pressure_pa) * frac;
    }
  }
  return last.pressure_pa;
}

function segmentMinAndPreferredMs(seg: ScheduleSegmentInput): { minMs: number; prefMs: number } {
  if (seg.stop_timing) {
    const durMs = seg.stop_timing.closure_ms + seg.stop_timing.release_ms + seg.stop_timing.aspiration_ms;
    if (seg.stop_timing.auto_generated && !seg.stop_timing.locked) {
      const minClosure = STOP_RIGID_FLOOR.closure_ms;
      const minRelease = STOP_RIGID_FLOOR.release_ms;
      const minAsp = seg.stop_timing.aspiration_ms > 0 ? 5 : 0;
      return { minMs: minClosure + minRelease + minAsp, prefMs: durMs };
    }
    return { minMs: durMs, prefMs: durMs };
  }
  if (seg.role === 'aspiration') {
    return { minMs: seg.min_ms ?? 45, prefMs: seg.preferred_ms || 45 };
  }
  const minMs = seg.min_ms ?? 50;
  const prefMs = Math.max(minMs, Math.min(180, seg.preferred_ms));
  return { minMs, prefMs };
}

function validateStopTiming(st: StopTiming, fieldPrefix: string): Result<StopTiming> {
  if (typeof st.closure_ms !== 'number' || !Number.isFinite(st.closure_ms) || st.closure_ms > 2999) {
    const chk = assertInRange(`${fieldPrefix}.closure_ms`, st.closure_ms, STOP_RIGID_FLOOR.closure_ms, 2999, 'ms');
    if (!chk.ok) return chk;
  }
  if (st.closure_ms < STOP_RIGID_FLOOR.closure_ms) {
    return fail({
      code: 'rigid_floor',
      field: `${fieldPrefix}.closure_ms`,
      value: st.closure_ms,
      allowed: { min: STOP_RIGID_FLOOR.closure_ms, max: 2999, unit: 'ms' },
      hint: `塞音闭塞时长 ${st.closure_ms} ms 低于刚性下限 ${STOP_RIGID_FLOOR.closure_ms} ms`,
    });
  }
  if (typeof st.release_ms !== 'number' || !Number.isFinite(st.release_ms) || st.release_ms > 50) {
    const chk = assertInRange(`${fieldPrefix}.release_ms`, st.release_ms, STOP_RIGID_FLOOR.release_ms, 50, 'ms');
    if (!chk.ok) return chk;
  }
  if (st.release_ms < STOP_RIGID_FLOOR.release_ms) {
    return fail({
      code: 'rigid_floor',
      field: `${fieldPrefix}.release_ms`,
      value: st.release_ms,
      allowed: { min: STOP_RIGID_FLOOR.release_ms, max: 50, unit: 'ms' },
      hint: `塞音释放时长 ${st.release_ms} ms 低于刚性下限 ${STOP_RIGID_FLOOR.release_ms} ms`,
    });
  }
  const aspChk = assertInRange(`${fieldPrefix}.aspiration_ms`, st.aspiration_ms, 0, 1000, 'ms');
  if (!aspChk.ok) return aspChk;
  const votChk = assertInRange(`${fieldPrefix}.vot_ms`, st.vot_ms, -st.closure_ms, st.release_ms + st.aspiration_ms, 'ms');
  if (!votChk.ok) return votChk;
  return ok(st);
}

export function scaleStopTimingMs(
  st: StopTiming,
  targetMs: number,
  fieldPrefix: string = 'stop_timing',
): Result<StopTiming> {
  const valid = validateStopTiming(st, fieldPrefix);
  if (!valid.ok) return valid;
  const rigidFloorMs = STOP_RIGID_FLOOR.closure_ms + STOP_RIGID_FLOOR.release_ms;
  if (typeof targetMs !== 'number' || !Number.isFinite(targetMs) || targetMs < rigidFloorMs - 1e-6) {
    return fail({
      code: 'rigid_floor',
      field: fieldPrefix,
      value: targetMs,
      allowed: { min: rigidFloorMs, max: 4049, unit: 'ms' },
      hint: `塞音目标时长 ${targetMs} ms 低于闭塞(${STOP_RIGID_FLOOR.closure_ms} ms) + 释放(${STOP_RIGID_FLOOR.release_ms} ms) 刚性下限 ${rigidFloorMs} ms`,
    });
  }
  const orig = st.closure_ms + st.release_ms + st.aspiration_ms;
  if (orig <= 0 || Math.abs(targetMs - orig) < 1e-6) return ok({ ...st });
  const effTarget = Math.max(rigidFloorMs, targetMs);
  const ratio = effTarget / orig;
  const rawC = st.closure_ms * ratio;
  const rawR = st.release_ms * ratio;
  let closure_ms: number;
  let release_ms: number;
  if (rawC < STOP_RIGID_FLOOR.closure_ms) {
    closure_ms = STOP_RIGID_FLOOR.closure_ms;
    release_ms = Math.max(STOP_RIGID_FLOOR.release_ms, Math.min(effTarget - closure_ms, rawR));
  } else if (rawR < STOP_RIGID_FLOOR.release_ms) {
    release_ms = STOP_RIGID_FLOOR.release_ms;
    closure_ms = Math.max(STOP_RIGID_FLOOR.closure_ms, Math.min(effTarget - release_ms, rawC));
  } else {
    closure_ms = rawC;
    release_ms = rawR;
  }
  const aspiration_ms = Math.max(0, effTarget - closure_ms - release_ms);
  const vot_ms = Math.max(-closure_ms, Math.min(release_ms + aspiration_ms, st.vot_ms * ratio));
  return ok({ ...st, closure_ms, release_ms, aspiration_ms, vot_ms });
}

/**
 * Unified speech & singing schedule compiler.
 */
export function schedule(input: ScheduleInput): Result<ScheduleOutput> {
  const fRefCheck = assertValidF0Hz('f_ref_hz', input.f_ref_hz);
  if (!fRefCheck.ok) return fRefCheck;

  const basePressure = input.base_pressure_pa ?? DEFAULT_BASE_PRESSURE_PA;
  const basePCheck = assertInRange('base_pressure_pa', basePressure, PRESSURE_LIMIT_PA.min, PRESSURE_LIMIT_PA.max, 'Pa');
  if (!basePCheck.ok) return basePCheck;

  if (input.syllables.length === 0) {
    return fail({
      code: 'validation_error',
      field: 'syllables',
      hint: '至少需要一个音节才能执行调度',
    });
  }

  // Validate explicit note_hz, pressure points, rest beats, and stop rigid floors up front (no silent clamping!)
  for (const syl of input.syllables) {
    if (syl.note_hz !== undefined) {
      const r = assertValidF0Hz(`syllables.${syl.id}.note_hz`, syl.note_hz);
      if (!r.ok) return r;
    }
    if (syl.rest_before_beats !== undefined) {
      const r = assertInRange(`syllables.${syl.id}.rest_before_beats`, syl.rest_before_beats, 0, 1024, 'beats');
      if (!r.ok) return r;
    }
    if (syl.pressure_pa !== undefined) {
      const r = assertInRange(`syllables.${syl.id}.pressure_pa`, syl.pressure_pa, PRESSURE_LIMIT_PA.min, PRESSURE_LIMIT_PA.max, 'Pa');
      if (!r.ok) return r;
    }
    if (syl.pressure_envelope) {
      for (const pt of syl.pressure_envelope) {
        const r = assertInRange(`syllables.${syl.id}.pressure_envelope.pressure_pa`, pt.pressure_pa, PRESSURE_LIMIT_PA.min, PRESSURE_LIMIT_PA.max, 'Pa');
        if (!r.ok) return r;
      }
    }
    for (const seg of syl.segments) {
      if (seg.stop_timing) {
        const stopChk = validateStopTiming(seg.stop_timing, `syllables.${syl.id}.segments.${seg.id}.stop_timing`);
        if (!stopChk.ok) return stopChk;
      }
    }
  }
  if (input.global_pressure_envelope) {
    for (const pt of input.global_pressure_envelope) {
      const r = assertInRange('global_pressure_envelope.pressure_pa', pt.pressure_pa, PRESSURE_LIMIT_PA.min, PRESSURE_LIMIT_PA.max, 'Pa');
      if (!r.ok) return r;
    }
  }

  const stepSmp = input.step_smp ?? 240; // 5 ms @ 48 kHz
  const bpm = input.score?.bpm ?? input.bpm;
  const hasBeats = Boolean(bpm && input.syllables.some((s) => s.note_beats !== undefined || s.note_hz !== undefined || input.score));
  const leadingReserveMs = input.leading_reserve_ms ?? (hasBeats ? 100 : 0);
  const leadingReserveSmp = msToSamples(leadingReserveMs);
  const issues: ScoreIssue[] = [];

  // Map score notes to syllables if score is provided, preserving rest durations
  const scorePitchByIdx: Array<{
    hz: number;
    beats: number;
    dyn: number;
    rest_before_beats: number;
    has_rest_after: boolean;
  } | null> = [];
  if (input.score) {
    let pendingRestBeats = 0;
    for (const n of input.score.notes) {
      if (n.midi === null) {
        pendingRestBeats += n.beats;
        if (scorePitchByIdx.length > 0) {
          scorePitchByIdx[scorePitchByIdx.length - 1]!.has_rest_after = true;
        }
        continue;
      }
      const hz = 440 * Math.pow(2, (n.midi - 69) / 12);
      const hzCheck = assertValidF0Hz('score.note_hz', hz);
      if (!hzCheck.ok) return hzCheck;
      if (!n.carry) {
        scorePitchByIdx.push({
          hz,
          beats: n.beats,
          dyn: n.dynamic ?? 0,
          rest_before_beats: pendingRestBeats,
          has_rest_after: false,
        });
        pendingRestBeats = 0;
      } else if (scorePitchByIdx.length > 0) {
        const last = scorePitchByIdx[scorePitchByIdx.length - 1]!;
        last.beats += n.beats;
        if (pendingRestBeats > 0) {
          last.beats += pendingRestBeats;
          pendingRestBeats = 0;
        }
      }
    }
  }

  // Determine beat times (where each syllable's nucleus should attack in singing context)
  const sylMeta = input.syllables.map((syl, idx) => {
    const sc = scorePitchByIdx[idx];
    const noteHz = syl.note_hz ?? sc?.hz;
    const beats = syl.note_beats ?? sc?.beats ?? 1;
    const restBeforeBeats = syl.rest_before_beats ?? sc?.rest_before_beats ?? 0;
    const hasRestAfter = Boolean(sc?.has_rest_after);
    const dynLevel = syl.dynamic_level ?? sc?.dyn ?? 0;
    const targetPressure = (syl.pressure_pa ?? basePressure) + dynLevel * DYNAMIC_STEP_PA;
    return { syl, noteHz, beats, restBeforeBeats, hasRestAfter, dynLevel, targetPressure };
  });
  for (let i = 0; i < sylMeta.length - 1; i++) {
    if (sylMeta[i + 1].restBeforeBeats > 0) {
      sylMeta[i].hasRestAfter = true;
    }
  }

  // Strict check on dynamic-adjusted target pressures
  for (const m of sylMeta) {
    const pCheck = assertInRange(
      `syllables.${m.syl.id}.effective_pressure_pa`,
      m.targetPressure,
      PRESSURE_LIMIT_PA.min,
      PRESSURE_LIMIT_PA.max,
      'Pa',
      `音节 ${m.syl.text} (${m.syl.id}) 叠加音强偏移后气压 ${m.targetPressure} Pa 超出 [0, 1600] Pa 范围`,
    );
    if (!pCheck.ok) return pCheck;
  }

  const scheduledSyllables: ScheduledSyllable[] = [];
  const allSegments: ScheduledSegment[] = [];
  const qtaSpans: QtaTargetSpan[] = [];
  const allResiduals: F0ResidualSegment[] = [];

  if (hasBeats && bpm) {
    // --- Musical beat-anchored scheduling (nucleus on beat, consonant pre-beat lead) ---
    const secPerBeat = 60 / bpm;
    const beatSamples: number[] = [];
    const noteDurSamples: number[] = [];
    let accBeats = 0;
    for (let i = 0; i < sylMeta.length; i++) {
      accBeats += sylMeta[i].restBeforeBeats;
      const bSmp = leadingReserveSmp + Math.round(accBeats * secPerBeat * SAMPLE_RATE_HZ);
      beatSamples.push(bSmp);
      const nextAccBeats = accBeats + sylMeta[i].beats;
      const nextBSmp = leadingReserveSmp + Math.round(nextAccBeats * secPerBeat * SAMPLE_RATE_HZ);
      noteDurSamples.push(nextBSmp - bSmp);
      accBeats = nextAccBeats;
    }

    // Partition each syllable into onset (before nucleus), nucleus, coda (after nucleus)
    const parts = sylMeta.map((m) => {
      let nucIdx = m.syl.segments.findIndex((s) => s.role === 'nucleus');
      if (nucIdx < 0) nucIdx = 0;
      return {
        onset: m.syl.segments.slice(0, nucIdx),
        nucleus: m.syl.segments[nucIdx],
        coda: m.syl.segments.slice(nucIdx + 1),
      };
    });

    // Compute per-boundary budgets between nucleus_i and nucleus_{i+1}
    const sylStartSmp: number[] = new Array(sylMeta.length).fill(0);
    const sylEndSmp: number[] = new Array(sylMeta.length).fill(0);
    const segTimingMs = new Map<string, number>();
    const compressionRatios: number[] = new Array(sylMeta.length).fill(1);

    // Handle the initial onset before or on the first beat, according to the syllable policy.
    if (sylMeta[0].syl.lead_policy === 'onset_on_beat') {
      sylStartSmp[0] = beatSamples[0];
      for (const seg of parts[0].onset) segTimingMs.set(seg.id, segmentMinAndPreferredMs(seg).prefMs);
    } else {
      const onset0 = parts[0].onset;
      const bias0 = sylMeta[0].syl.bias_ms ?? 0;
      const targetNuc0 = beatSamples[0] + msToSamples(bias0);
      let prefSum0 = 0;
      let minSum0 = 0;
      for (const seg of onset0) {
        const { minMs, prefMs } = segmentMinAndPreferredMs(seg);
        const effPref = sylMeta[0].syl.lead_ms !== null && sylMeta[0].syl.lead_ms !== undefined && onset0.length === 1
          ? sylMeta[0].syl.lead_ms
          : prefMs;
        prefSum0 += effPref;
        minSum0 += minMs;
      }
      const avail0Ms = samplesToMs(targetNuc0);
      if (prefSum0 <= avail0Ms + 1e-6) {
        for (const seg of onset0) {
          const effPref = sylMeta[0].syl.lead_ms !== null && sylMeta[0].syl.lead_ms !== undefined && onset0.length === 1
            ? sylMeta[0].syl.lead_ms
            : segmentMinAndPreferredMs(seg).prefMs;
          segTimingMs.set(seg.id, effPref);
        }
        sylStartSmp[0] = targetNuc0 - msToSamples(prefSum0);
      } else if (minSum0 <= avail0Ms + 1e-6) {
        const slack = prefSum0 - minSum0;
        const ratio = slack > 0 ? (avail0Ms - minSum0) / slack : 0;
        for (const seg of onset0) {
          const { minMs, prefMs } = segmentMinAndPreferredMs(seg);
          segTimingMs.set(seg.id, minMs + (prefMs - minMs) * ratio);
        }
        compressionRatios[0] = avail0Ms / Math.max(1e-6, prefSum0);
        sylStartSmp[0] = 0;
      } else {
        issues.push({
          key: 'song_short',
          row: 1,
          values: { required_ms: Math.round(minSum0), available_ms: Math.round(avail0Ms) },
          message: `首音节字头最小前置需求 ${minSum0.toFixed(1)} ms 超过预留时长 ${avail0Ms.toFixed(1)} ms`,
          options: ['delay_vowel', 'trim_coda', 'extend_prev_note'],
        });
        if (!input.allow_vowel_delay_on_conflict) {
          return fail({
            code: 'rigid_floor',
            field: `syllables.${sylMeta[0].syl.id}`,
            allowed: { min: minSum0, max: avail0Ms, unit: 'ms' },
            hint: `首音节字头不可压缩至低于 ${minSum0.toFixed(1)} ms；可选择延后元音起点或加大 leading_reserve_ms`,
          });
        }
        for (const seg of onset0) {
          segTimingMs.set(seg.id, segmentMinAndPreferredMs(seg).minMs);
        }
        sylStartSmp[0] = 0;
      }
    }

    // Inter-nucleus budgets (between syllable i and i+1)
    for (let i = 0; i < sylMeta.length - 1; i++) {
      const biasI = sylMeta[i].syl.bias_ms ?? 0;
      const biasNext = sylMeta[i + 1].syl.bias_ms ?? 0;
      const tNucI = beatSamples[i] + msToSamples(biasI);
      const tNucNext = beatSamples[i + 1] + msToSamples(biasNext);
      const intervalMs = samplesToMs(tNucNext - tNucI);
      const holdMinMs = Math.max(50, samplesToMs(noteDurSamples[i]) * 0.4);
      const budgetG = intervalMs - holdMinMs;

      const leadNext = sylMeta[i + 1].syl.lead_policy !== 'onset_on_beat';
      const nextOnset = leadNext ? parts[i + 1].onset : [];
      if (!leadNext) for (const seg of parts[i + 1].onset) {
        segTimingMs.set(seg.id, segmentMinAndPreferredMs(seg).prefMs);
      }
      const edgeSegs = [...parts[i].coda, ...nextOnset];
      const mins: number[] = [];
      const prefs: number[] = [];
      for (let k = 0; k < edgeSegs.length; k++) {
        const seg = edgeSegs[k];
        const { minMs, prefMs } = segmentMinAndPreferredMs(seg);
        const isSingleNextOnset =
          k >= parts[i].coda.length &&
          nextOnset.length === 1 &&
          sylMeta[i + 1].syl.lead_ms !== null &&
          sylMeta[i + 1].syl.lead_ms !== undefined;
        mins.push(minMs);
        prefs.push(isSingleNextOnset ? sylMeta[i + 1].syl.lead_ms! : prefMs);
      }
      const prefSum = prefs.reduce((a, b) => a + b, 0);
      const minSum = mins.reduce((a, b) => a + b, 0);

      if (prefSum <= budgetG + 1e-6) {
        edgeSegs.forEach((seg, k) => segTimingMs.set(seg.id, prefs[k]));
      } else if (minSum <= budgetG + 1e-6) {
        const slack = prefSum - minSum;
        const factor = slack > 0 ? Math.max(0, Math.min(1, (budgetG - minSum) / slack)) : 0;
        edgeSegs.forEach((seg, k) => {
          segTimingMs.set(seg.id, mins[k] + (prefs[k] - mins[k]) * factor);
        });
        compressionRatios[i + 1] = budgetG / Math.max(1e-6, prefSum);
      } else {
        issues.push({
          key: 'song_short',
          row: i + 2,
          values: { required_ms: Math.round(minSum), available_ms: Math.round(budgetG) },
          message: `第 ${i + 2} 音节字头与前音节韵尾最小时长合计 ${minSum.toFixed(1)} ms 超过可用预算 ${budgetG.toFixed(1)} ms`,
          options: ['delay_vowel', 'trim_coda', 'extend_prev_note'],
        });
        if (!input.allow_vowel_delay_on_conflict) {
          return fail({
            code: 'rigid_floor',
            field: `syllables.${sylMeta[i + 1].syl.id}`,
            allowed: { min: minSum, max: Math.max(0, budgetG), unit: 'ms' },
            hint: `音节 ${sylMeta[i + 1].syl.text} 前导量触碰闭塞/辅音刚性下限；可选择元音晚到、删弱韵尾或延长前一音符`,
          });
        }
        edgeSegs.forEach((seg, k) => segTimingMs.set(seg.id, mins[k]));
        compressionRatios[i + 1] = 0;
      }

      const nextOnsetMs = nextOnset.reduce((a, s) => a + (segTimingMs.get(s.id) ?? 0), 0);
      const nextOnsetSmp = msToSamples(nextOnsetMs);
      sylStartSmp[i + 1] = Math.max(tNucI + msToSamples(holdMinMs), tNucNext - nextOnsetSmp);
      const hasRestGap = sylMeta[i + 1].restBeforeBeats > 0;
      const noteEndI = beatSamples[i] + noteDurSamples[i];
      sylEndSmp[i] = hasRestGap
        ? Math.min(sylStartSmp[i + 1], Math.max(tNucI + msToSamples(holdMinMs), noteEndI))
        : sylStartSmp[i + 1];
    }

    // Final syllable trailing coda + end
    {
      const last = sylMeta.length - 1;
      const codaMs = parts[last].coda.reduce((a, s) => {
        const p = segmentMinAndPreferredMs(s).prefMs;
        segTimingMs.set(s.id, p);
        return a + p;
      }, 0);
      const lastBeatEnd = beatSamples[last] + noteDurSamples[last];
      sylEndSmp[last] = Math.max(beatSamples[last] + msToSamples(50),
        lastBeatEnd + (input.finalCodaWithinBeat ? 0 : msToSamples(codaMs)));
    }

    // Build exact sample intervals for every segment & syllable (strictly non-overlapping half-open intervals)
    const minNucSmp = msToSamples(20);
    const minCodaFloorSmp = msToSamples(10);
    const stopFloorSmp = msToSamples(STOP_RIGID_FLOOR.closure_ms + STOP_RIGID_FLOOR.release_ms);
    let prevActualEndSmp = 0;

    for (let i = 0; i < sylMeta.length; i++) {
      const m = sylMeta[i];
      const part = parts[i];
      const biasSmp = msToSamples(m.syl.bias_ms ?? 0);
      const policy = m.syl.lead_policy ?? 'nucleus_on_beat';

      if (i > 0 && sylStartSmp[i] < prevActualEndSmp) {
        sylStartSmp[i] = prevActualEndSmp;
      }

      let cur = sylStartSmp[i];
      const onsetSegs: ScheduledSegment[] = [];
      for (const seg of part.onset) {
        const durMs = segTimingMs.get(seg.id) ?? segmentMinAndPreferredMs(seg).prefMs;
        const durSmp = msToSamples(durMs);
        let st: StopTiming | undefined;
        if (seg.stop_timing) {
          const scaled = scaleStopTimingMs(seg.stop_timing, durMs, `syllables.${m.syl.id}.segments.${seg.id}.stop_timing`);
          if (!scaled.ok) return scaled;
          st = scaled.value;
        }
        onsetSegs.push({
          id: seg.id,
          syllable_id: m.syl.id,
          ipa: seg.ipa,
          role: seg.role,
          start_smp: cur,
          end_smp: cur + durSmp,
          voiced: seg.voiced,
          elastic: !seg.stop_timing && seg.role !== 'aspiration',
          stop_timing: st,
          params: seg.params,
        });
        cur += durSmp;
      }

      const nucStart = policy === 'nucleus_on_beat' ? Math.max(cur, beatSamples[i] + biasSmp) : cur;
      if (onsetSegs.length > 0 && nucStart > cur) {
        // Align final onset end right up to nucleus start so segments are contiguous
        const delta = nucStart - cur;
        onsetSegs[onsetSegs.length - 1].end_smp += delta;
        const lastOnset = onsetSegs[onsetSegs.length - 1];
        const rawLastOnset = part.onset[part.onset.length - 1];
        if (rawLastOnset?.stop_timing) {
          const scaled = scaleStopTimingMs(
            rawLastOnset.stop_timing,
            samplesToMs(lastOnset.end_smp - lastOnset.start_smp),
            `syllables.${m.syl.id}.segments.${rawLastOnset.id}.stop_timing`,
          );
          if (!scaled.ok) return scaled;
          lastOnset.stop_timing = scaled.value;
        }
        cur = nucStart;
      }

      // Compute coda durations and derive nucleus end backwards from sylEndSmp[i].
      // If budget is insufficient, extend sylEndSmp[i] and push sylStartSmp[i + 1] forward with an issue.
      const codaDursSmp = part.coda.map((seg) => {
        const durMs = segTimingMs.get(seg.id) ?? segmentMinAndPreferredMs(seg).prefMs;
        const floor = seg.stop_timing ? stopFloorSmp : minCodaFloorSmp;
        return Math.max(floor, msToSamples(durMs));
      });
      const codaSmpTotal = codaDursSmp.reduce((a, b) => a + b, 0);
      const minRequiredSylEnd = nucStart + minNucSmp + codaSmpTotal;

      if (sylEndSmp[i] < minRequiredSylEnd) {
        const shortfallMs = samplesToMs(minRequiredSylEnd - sylEndSmp[i]);
        sylEndSmp[i] = minRequiredSylEnd;
        if (i + 1 < sylMeta.length && sylStartSmp[i + 1] < minRequiredSylEnd) {
          sylStartSmp[i + 1] = minRequiredSylEnd;
          if (!issues.some((it) => it.key === 'song_short' && it.row === i + 2)) {
            issues.push({
              key: 'song_short',
              row: i + 2,
              values: { required_ms: Math.round(samplesToMs(minNucSmp + codaSmpTotal)), available_ms: Math.max(0, Math.round(samplesToMs(minNucSmp + codaSmpTotal) - shortfallMs)) },
              message: `第 ${i + 1} 音节核心与韵尾超出预算 ${shortfallMs.toFixed(1)} ms，已顺延下一音节起点以避免重叠`,
              options: ['delay_vowel', 'trim_coda', 'extend_prev_note'],
            });
          }
        }
      }

      const nucEnd = sylEndSmp[i] - codaSmpTotal;
      const nucSeg: ScheduledSegment = {
        id: part.nucleus.id,
        syllable_id: m.syl.id,
        ipa: part.nucleus.ipa,
        role: part.nucleus.role,
        start_smp: nucStart,
        end_smp: nucEnd,
        voiced: part.nucleus.voiced,
        elastic: true,
        params: part.nucleus.params,
      };

      // Place codas working backwards from sylEndSmp[i] so boundaries match [start_smp, end_smp) exactly
      const codaStarts: number[] = new Array(part.coda.length);
      const codaEnds: number[] = new Array(part.coda.length);
      let backCursor = sylEndSmp[i];
      for (let k = part.coda.length - 1; k >= 0; k--) {
        codaEnds[k] = backCursor;
        backCursor -= codaDursSmp[k];
        codaStarts[k] = backCursor;
      }

      const codaSegs: ScheduledSegment[] = [];
      for (let k = 0; k < part.coda.length; k++) {
        const seg = part.coda[k];
        const segStart = codaStarts[k];
        const segEnd = codaEnds[k];
        let st: StopTiming | undefined;
        if (seg.stop_timing) {
          const scaled = scaleStopTimingMs(
            seg.stop_timing,
            samplesToMs(segEnd - segStart),
            `syllables.${m.syl.id}.segments.${seg.id}.stop_timing`,
          );
          if (!scaled.ok) return scaled;
          st = scaled.value;
        }
        codaSegs.push({
          id: seg.id,
          syllable_id: m.syl.id,
          ipa: seg.ipa,
          role: seg.role,
          start_smp: segStart,
          end_smp: segEnd,
          voiced: seg.voiced,
          elastic: !seg.stop_timing,
          stop_timing: st,
          params: seg.params,
        });
      }

      const segs = [...onsetSegs, nucSeg, ...codaSegs];
      prevActualEndSmp = segs[segs.length - 1].end_smp;
      allSegments.push(...segs);
      const leadMs = samplesToMs(nucStart - sylStartSmp[i]);
      scheduledSyllables.push({
        id: m.syl.id,
        text: m.syl.text,
        start_smp: segs[0].start_smp,
        end_smp: segs[segs.length - 1].end_smp,
        beat_smp: beatSamples[i],
        nucleus_start_smp: nucStart,
        lead_ms: leadMs,
        compression_ratio: compressionRatios[i],
        pressure_pa: m.targetPressure,
        segments: segs,
      });

      const targetSt = m.noteHz !== undefined ? hzToSt(m.noteHz, input.f_ref_hz) : 0;
      const lam = m.syl.lambda_per_s ?? (leadMs < 50 ? 95 : 70);
      qtaSpans.push({
        id: `qta_${m.syl.id}`,
        span_id: m.syl.id,
        start_smp: segs[0].start_smp,
        end_smp: segs[segs.length - 1].end_smp,
        voiced: true,
        is_rest_after: m.hasRestAfter || undefined,
        pre_glide_ms: leadMs,
        candidates: {
          ...m.syl.target_overrides,
          score: m.noteHz !== undefined
            ? { m_st_per_s: 0, b_end_st: targetSt, lambda_per_s: lam, source: 'score', rule: 'singing_note' }
            : undefined,
        },
      });
      if (m.syl.residuals) allResiduals.push(...m.syl.residuals);
    }
  } else {
    // --- Natural speech timing ---
    let cur = leadingReserveSmp;
    for (const m of sylMeta) {
      const segs: ScheduledSegment[] = [];
      const sylStart = cur;
      for (const seg of m.syl.segments) {
        const stopMinMs = seg.stop_timing
          ? seg.stop_timing.closure_ms + seg.stop_timing.release_ms + seg.stop_timing.aspiration_ms
          : 0;
        const durSmp = msToSamples(Math.max(10, seg.preferred_ms, stopMinMs));
        segs.push({
          id: seg.id,
          syllable_id: m.syl.id,
          ipa: seg.ipa,
          role: seg.role,
          start_smp: cur,
          end_smp: cur + durSmp,
          voiced: seg.voiced,
          elastic: !seg.stop_timing && seg.role !== 'aspiration',
          stop_timing: seg.stop_timing ? { ...seg.stop_timing } : undefined,
          params: seg.params,
        });
        cur += durSmp;
      }
      const nucSeg = segs.find((s) => s.role === 'nucleus') ?? segs[0];
      allSegments.push(...segs);
      scheduledSyllables.push({
        id: m.syl.id,
        text: m.syl.text,
        start_smp: sylStart,
        end_smp: cur,
        beat_smp: sylStart,
        nucleus_start_smp: nucSeg.start_smp,
        lead_ms: samplesToMs(nucSeg.start_smp - sylStart),
        compression_ratio: 1,
        pressure_pa: m.targetPressure,
        segments: segs,
      });

      const durSec = (cur - sylStart) / SAMPLE_RATE_HZ;
      const toneTargets = toneLevelsToQtaTargets(
        m.syl.tone_levels ?? '55',
        durSec,
        input.range_st ?? [-6, 4],
        { lambda: m.syl.lambda_per_s ?? 45, checked: m.syl.checked },
      );
      for (let ti = 0; ti < toneTargets.length; ti++) {
        const tt = toneTargets[ti];
        const s0 = sylStart + Math.round((cur - sylStart) * tt.fracStart);
        const s1 = sylStart + Math.round((cur - sylStart) * tt.fracEnd);
        qtaSpans.push({
          id: `qta_${m.syl.id}_${ti}`,
          span_id: toneTargets.length === 1 ? m.syl.id : `${m.syl.id}#${ti}`,
          start_smp: s0,
          end_smp: s1,
          voiced: true,
          candidates: {
            ...m.syl.target_overrides,
            default: tt.candidate,
          },
        });
      }
      if (m.syl.residuals) allResiduals.push(...m.syl.residuals);
    }
  }

  const totalSmp = scheduledSyllables.length > 0
    ? scheduledSyllables[scheduledSyllables.length - 1].end_smp
    : leadingReserveSmp;

  if (totalSmp / SAMPLE_RATE_HZ > MAX_SEQUENCE_SECONDS) {
    return fail({
      code: 'out_of_range',
      field: 'total_seconds',
      value: totalSmp / SAMPLE_RATE_HZ,
      allowed: { min: 0, max: MAX_SEQUENCE_SECONDS, unit: 's' },
      hint: `合成总时长超过 ${MAX_SEQUENCE_SECONDS} 秒单块上限`,
    });
  }

  const f0Res = evalF0({
    spans: qtaSpans,
    total_smp: totalSmp,
    step_smp: stepSmp,
    f_ref_hz: input.f_ref_hz,
    range_st: input.range_st ?? (hasBeats ? [-6, 14] : [-6, 4]),
    context: hasBeats ? 'singing' : 'speech',
    residuals: allResiduals,
    pins: input.pins,
    vibrato: input.vibrato ?? (input.score ? { enabled: input.score.vibrato } : undefined),
  });
  if (!f0Res.ok) return f0Res;

  // Build dense pressure_pa[] array aligned sample-by-sample with f0Res.times_smp
  const pressurePa: number[] = [];
  for (const tSmp of f0Res.value.times_smp) {
    let pVal = basePressure;
    if (input.global_pressure_envelope && input.global_pressure_envelope.length > 0 && totalSmp > 0) {
      pVal = interpolatePressurePoints(input.global_pressure_envelope, tSmp / totalSmp, basePressure);
    } else {
      const owner = scheduledSyllables.find((s) => tSmp >= s.start_smp && tSmp < s.end_smp);
      if (owner) {
        const meta = sylMeta.find((m) => m.syl.id === owner.id);
        if (meta?.syl.pressure_envelope && meta.syl.pressure_envelope.length > 0) {
          const span = Math.max(1, owner.end_smp - owner.start_smp);
          pVal = interpolatePressurePoints(meta.syl.pressure_envelope, (tSmp - owner.start_smp) / span, owner.pressure_pa);
        } else {
          pVal = owner.pressure_pa;
        }
      } else {
        pVal = 0; // silence/reserve before first utterance or inside musical rest gaps
      }
    }
    const check = assertInRange('pressure_pa', pVal, PRESSURE_LIMIT_PA.min, PRESSURE_LIMIT_PA.max, 'Pa');
    if (!check.ok) return check as { ok: false; error: CoreErrorDetail };
    pressurePa.push(pVal);
  }

  return ok({
    total_smp: totalSmp,
    step_smp: stepSmp,
    bpm,
    leading_reserve_smp: leadingReserveSmp,
    syllables: scheduledSyllables,
    segments: allSegments,
    f0_hz: f0Res.value.f0_hz,
    f0_st: f0Res.value.f0_st,
    voiced_mask: f0Res.value.voiced_mask,
    pressure_pa: pressurePa,
    issues,
  });
}
