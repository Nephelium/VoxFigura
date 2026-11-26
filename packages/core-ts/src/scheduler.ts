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
  F0_LIMIT_HZ,
  MAX_SEQUENCE_SECONDS,
  PRESSURE_LIMIT_PA,
  SAMPLE_RATE_HZ,
  assertInRange,
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

export const STOP_RIGID_FLOOR = {
  closure_ms: 10,
  release_ms: 1,
} as const;

export const DEFAULT_BASE_PRESSURE_PA = 800;
export const DYNAMIC_STEP_PA = 120;

export const TONIC_MIDI = {
  C2: 36, D2: 38, E2: 40, F2: 41, G2: 43, A2: 45, B2: 47,
  C3: 48, D3: 50, E3: 52, F3: 53, G3: 55,
} as const;

export type SongTonic = keyof typeof TONIC_MIDI;

export interface SongNote {
  midi: number | null;
  beats: number;
  carry: boolean;
  dynamic?: number; // -3 (ppp) .. +3 (fff)
}

export interface SongScore {
  bpm: number;
  notes: SongNote[];
  vibrato: boolean;
}

export interface ScoreIssue {
  key: 'song_tempo_error' | 'song_token' | 'song_range' | 'song_empty' | 'song_count' | 'song_short' | 'song_limit' | 'song_nucleus';
  row?: number;
  values?: Record<string, string | number>;
  message: string;
  options?: Array<'delay_vowel' | 'trim_coda' | 'extend_prev_note'>;
}

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];

/**
 * Parse numbered score notation (jianpu) supporting `p/pp/ppp/f/ff/fff`,
 * melisma groups `(1p23)ff`, octaves `+`/`-`, durations `/`/`*`/`.`/`:x`, and rests `0`/` `.
 * Preserves per-note dynamics over group-level dynamics (e.g. `(1p23)ff` -> 1:-120 Pa, 2:+240 Pa, 3:+240 Pa).
 */
export function parseNumberedScore(
  source: string,
  tonic: SongTonic,
  bpm: number,
  vibrato: boolean,
  expectedRows?: number,
  options?: { maxSeconds?: number; midiRange?: readonly [number, number] },
): { ok: true; score: SongScore; labels: string[]; seconds: number } | { ok: false; issue: ScoreIssue } {
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 240) {
    return { ok: false, issue: { key: 'song_tempo_error', message: `BPM (${bpm}) 必须在 40..240 之间` } };
  }
  const notes: SongNote[] = [];
  const labels: string[] = [];
  const invalid = (token: string): { ok: false; issue: ScoreIssue } => ({
    ok: false,
    issue: { key: 'song_token', values: { token }, message: `无法识别的简谱记号: ${token}` },
  });

  const text = source
    .replaceAll('（', '(')
    .replaceAll('）', ')')
    .replaceAll('♯', '#')
    .replaceAll('♭', 'b')
    .replaceAll('\u0307', "'")
    .replaceAll('\u0323', ',');
  const dynLevel = (mark: string): number => mark.length * (mark.startsWith('f') ? 1 : -1);
  const noteRe = /([#b]?)([0-7])((?::\d+(?:\.\d+)?|[+\-',_pf/.·*])*)/uy;

  let groupStart = -1;
  let firstPitch = -1;
  let lastPitch = -1;
  let totalBeats = 0;

  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === '(') {
      if (groupStart >= 0) return invalid(ch);
      groupStart = i++;
      firstPitch = -1;
      lastPitch = -1;
      continue;
    }
    if (ch === ')') {
      if (groupStart < 0 || firstPitch < 0) return invalid(ch);
      for (let j = firstPitch + 1; j <= lastPitch; j++) {
        notes[j].carry = true;
      }
      i++;
      const mark = /^(p+|f+)/u.exec(text.slice(i))?.[0];
      if (mark) {
        const grpDyn = dynLevel(mark);
        for (let j = firstPitch; j <= lastPitch; j++) {
          if (notes[j].midi !== null && notes[j].dynamic === undefined) {
            notes[j].dynamic = grpDyn;
          }
        }
        i += mark.length;
      }
      labels.push(text.slice(groupStart, i));
      groupStart = -1;
      continue;
    }
    if (/[|｜\r\n]/u.test(ch)) {
      i++;
      continue;
    }
    if (ch === '-' || ch === '—' || ch === '–') {
      if (notes.length === 0) return invalid(ch);
      notes[notes.length - 1].beats += 1;
      totalBeats += 1;
      if (groupStart < 0 && notes[notes.length - 1].midi !== null && labels.length > 0) {
        labels[labels.length - 1] += ' -';
      }
      i++;
      continue;
    }
    if (ch === ' ' || ch === '　') {
      if (groupStart >= 0 || /^[ \u3000]*[-—–]/u.test(text.slice(i))) {
        i++;
        continue;
      }
      notes.push({ midi: null, beats: 1, carry: false });
      totalBeats += 1;
      i++;
      continue;
    }

    noteRe.lastIndex = i;
    const m = noteRe.exec(text);
    if (!m) return invalid(ch);
    const [token, accidental, digit, suffix] = m;
    const degree = Number(digit);
    let duration = 1;
    let shift = 0;
    let mark = '';
    let explicitLen = false;

    for (const sym of suffix.match(/:\d+(?:\.\d+)?|./gu) ?? []) {
      if (sym.startsWith(':')) {
        if (explicitLen) return invalid(token);
        duration *= Number(sym.slice(1));
        explicitLen = true;
      } else if (sym === '+' || sym === "'" || sym === '-' || sym === ',') {
        const oct = (sym === '+' || sym === "'") ? 12 : -12;
        if (shift * oct < 0) return invalid(token);
        shift += oct;
      } else if (sym === 'p' || sym === 'f') {
        if (mark && mark[0] !== sym) return invalid(token);
        mark += sym;
      } else {
        duration *= (sym === '/' || sym === '_') ? 0.5 : sym === '*' ? 2 : 1.5;
      }
    }

    if (!Number.isFinite(duration) || duration <= 0 || (!degree && (shift || accidental || mark))) {
      return invalid(token);
    }

    const midi = degree
      ? TONIC_MIDI[tonic] + MAJOR_SCALE[degree - 1] + shift + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0)
      : null;

    if (midi !== null) {
      const hz = 440 * Math.pow(2, (midi - 69) / 12);
      const range = options?.midiRange;
      if (range ? midi < range[0] || midi > range[1] : hz < F0_LIMIT_HZ.min || hz > F0_LIMIT_HZ.max) {
        return {
          ok: false,
          issue: {
            key: 'song_range',
            values: { token, hz: Math.round(hz * 10) / 10 },
            message: range ? `音符 ${token} 超出乐器音域 (MIDI ${range.join('–')})`
              : `音符 ${token} (${hz.toFixed(1)} Hz) 超出声源范围 [60, 600] Hz`,
          },
        };
      }
      if (groupStart < 0) {
        labels.push(token);
      } else {
        lastPitch = notes.length;
        if (firstPitch < 0) firstPitch = lastPitch;
      }
    }

    notes.push({
      midi,
      beats: duration,
      carry: false,
      ...(mark ? { dynamic: dynLevel(mark) } : {}),
    });
    i = noteRe.lastIndex;
    totalBeats += duration;
  }

  if (groupStart >= 0) return invalid('(');
  if (notes.length === 0) return { ok: false, issue: { key: 'song_empty', message: '乐谱为空' } };
  if (typeof expectedRows === 'number' && labels.length !== expectedRows) {
    return {
      ok: false,
      issue: {
        key: 'song_count',
        values: { notes: labels.length, rows: expectedRows },
        message: `乐谱音节数 (${labels.length}) 与歌词音节数 (${expectedRows}) 不一致`,
      },
    };
  }

  const seconds = (totalBeats * 60) / bpm;
  const maxSeconds = options?.maxSeconds ?? MAX_SEQUENCE_SECONDS;
  if (seconds > maxSeconds) {
    return { ok: false, issue: { key: 'song_limit', message: `总时长 ${seconds.toFixed(1)}s 超出 ${maxSeconds}s 上限` } };
  }

  return { ok: true, score: { bpm, notes, vibrato }, labels, seconds };
}

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

function scaleStopTimingMs(st: StopTiming, targetMs: number): StopTiming {
  const orig = st.closure_ms + st.release_ms + st.aspiration_ms;
  if (orig <= 0 || Math.abs(targetMs - orig) < 1e-6) return { ...st };
  const ratio = targetMs / orig;
  const closure_ms = Math.max(STOP_RIGID_FLOOR.closure_ms, st.closure_ms * ratio);
  const release_ms = Math.max(STOP_RIGID_FLOOR.release_ms, st.release_ms * ratio);
  const aspiration_ms = Math.max(0, targetMs - closure_ms - release_ms);
  const vot_ms = Math.max(-closure_ms, Math.min(release_ms + aspiration_ms, st.vot_ms * ratio));
  return { ...st, closure_ms, release_ms, aspiration_ms, vot_ms };
}

/**
 * Unified speech & singing schedule compiler.
 */
export function schedule(input: ScheduleInput): Result<ScheduleOutput> {
  const fRefCheck = assertInRange('f_ref_hz', input.f_ref_hz, F0_LIMIT_HZ.min, F0_LIMIT_HZ.max, 'Hz');
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

  // Validate any explicit note_hz or pressure points up front (no silent clamping!)
  for (const syl of input.syllables) {
    if (syl.note_hz !== undefined) {
      const r = assertInRange(`syllables.${syl.id}.note_hz`, syl.note_hz, F0_LIMIT_HZ.min, F0_LIMIT_HZ.max, 'Hz');
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

  // Map score notes to syllables if score is provided
  const scorePitchByIdx: Array<{ hz: number; beats: number; dyn: number } | null> = [];
  if (input.score) {
    for (const n of input.score.notes) {
      if (n.midi === null) continue;
      const hz = 440 * Math.pow(2, (n.midi - 69) / 12);
      const hzCheck = assertInRange('score.note_hz', hz, F0_LIMIT_HZ.min, F0_LIMIT_HZ.max, 'Hz');
      if (!hzCheck.ok) return hzCheck;
      if (!n.carry) {
        scorePitchByIdx.push({ hz, beats: n.beats, dyn: n.dynamic ?? 0 });
      } else if (scorePitchByIdx.length > 0) {
        const last = scorePitchByIdx[scorePitchByIdx.length - 1]!;
        last.beats += n.beats;
      }
    }
  }

  // Determine beat times (where each syllable's nucleus should attack in singing context)
  const sylMeta = input.syllables.map((syl, idx) => {
    const sc = scorePitchByIdx[idx];
    const noteHz = syl.note_hz ?? sc?.hz;
    const beats = syl.note_beats ?? sc?.beats ?? 1;
    const dynLevel = syl.dynamic_level ?? sc?.dyn ?? 0;
    const targetPressure = (syl.pressure_pa ?? basePressure) + dynLevel * DYNAMIC_STEP_PA;
    return { syl, noteHz, beats, dynLevel, targetPressure };
  });

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
      sylEndSmp[i] = sylStartSmp[i + 1];
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

    // Build exact sample intervals for every segment & syllable
    for (let i = 0; i < sylMeta.length; i++) {
      const m = sylMeta[i];
      const part = parts[i];
      const biasSmp = msToSamples(m.syl.bias_ms ?? 0);
      const policy = m.syl.lead_policy ?? 'nucleus_on_beat';

      let cur = sylStartSmp[i];
      const onsetSegs: ScheduledSegment[] = [];
      for (const seg of part.onset) {
        const durMs = segTimingMs.get(seg.id) ?? segmentMinAndPreferredMs(seg).prefMs;
        const durSmp = msToSamples(durMs);
        const st = seg.stop_timing ? scaleStopTimingMs(seg.stop_timing, durMs) : undefined;
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
        cur = nucStart;
      }

      const codaMsTotal = part.coda.reduce((a, s) => a + (segTimingMs.get(s.id) ?? 0), 0);
      const codaSmpTotal = msToSamples(codaMsTotal);
      const nucEnd = Math.max(nucStart + msToSamples(20), sylEndSmp[i] - codaSmpTotal);

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
      cur = nucEnd;

      const codaSegs: ScheduledSegment[] = [];
      for (let k = 0; k < part.coda.length; k++) {
        const seg = part.coda[k];
        const durMs = segTimingMs.get(seg.id) ?? segmentMinAndPreferredMs(seg).prefMs;
        const end = k === part.coda.length - 1 ? Math.max(cur + msToSamples(10), sylEndSmp[i]) : cur + msToSamples(durMs);
        const st = seg.stop_timing ? scaleStopTimingMs(seg.stop_timing, samplesToMs(end - cur)) : undefined;
        codaSegs.push({
          id: seg.id,
          syllable_id: m.syl.id,
          ipa: seg.ipa,
          role: seg.role,
          start_smp: cur,
          end_smp: end,
          voiced: seg.voiced,
          elastic: !seg.stop_timing,
          stop_timing: st,
          params: seg.params,
        });
        cur = end;
      }

      const segs = [...onsetSegs, nucSeg, ...codaSegs];
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
        const durSmp = msToSamples(Math.max(10, seg.preferred_ms));
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
      } else if (tSmp < (scheduledSyllables[0]?.start_smp ?? 0)) {
        pVal = 0; // silence/reserve before first utterance
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
