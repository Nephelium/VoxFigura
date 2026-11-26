/**
 * Prom-on et al. (2009) 3rd-Order Critically Damped qTA & 6-Layer F0 Evaluator
 *
 * Implements L0..L6 F0 evaluation in semitones relative to `f_ref_hz`:
 *  - L0: Speaker reference frequency `f_ref_hz` & range `[lo_st, hi_st]`
 *  - L1: Target resolution (`user > transfer > score > default`)
 *  - L2: 3rd-order critically damped qTA with unified `b_end` intercept
 *  - L3: PCHIP residual fragments (30 ms raised-cosine feather) & absolute pin
 *        (entry crossfade + 35 ms exit quadratic least-squares state feedback)
 *  - L4: Deterministic vibrato (cents, delayed attack & taper)
 *  - L5: Perturbation metadata (flutter executed in VTL source; never mutates F0_ctl)
 *  - L6: Strict 60..600 Hz guard (rejects out_of_range without silent clamping)
 */

import {
  F0_LIMIT_HZ,
  SAMPLE_RATE_HZ,
  hzToSt,
  msToSamples,
  ok,
  outOfRange,
  samplesToMs,
  stToHz,
  type F0PinSegment,
  type F0ResidualPoint,
  type F0ResidualSegment,
  type QtaTargetCandidate,
  type QtaTargetSpan,
  type Result,
  type TargetSource,
  type VibratoConfig,
} from './types';

export const TARGET_SOURCE_PRIORITY: readonly TargetSource[] = [
  'user',
  'transfer',
  'score',
  'default',
] as const;

export const DEFAULT_VIBRATO: VibratoConfig = {
  enabled: false,
  rate_hz: 5.5,
  depth_cents: 25,
  delay_ms: 200,
  fade_in_ms: 120,
  fade_out_ms: 90,
  min_hold_ms: 400,
};

/** Prom-on et al. (2009) Table V Mandarin canonical qTA values (b_end in st). */
export const MANDARIN_PROM_ON_2009 = {
  T1_55: { m_st_per_s: 0.0, b_end_st: 0.0, lambda_per_s: 54.5 },
  T2_35: { m_st_per_s: 93.4, b_end_st: -2.2, lambda_per_s: 40.7 },
  T3_21: { m_st_per_s: 0.0, b_end_st: -8.9, lambda_per_s: 34.1 },
  T4_51: { m_st_per_s: -106.4, b_end_st: -2.5, lambda_per_s: 39.3 },
} as const;

export interface QtaState {
  y: number;   // st
  yp: number;  // st / s
  ypp: number; // st / s^2
}

export interface ResolvedQtaSpan {
  span_id: string;
  start_smp: number;
  end_smp: number;
  voiced: boolean;
  is_rest_after: boolean;
  candidate: QtaTargetCandidate;
}

export interface EvalF0Input {
  spans: QtaTargetSpan[];
  total_smp: number;
  step_smp?: number; // default 240 (5 ms @ 48 kHz = 200 Hz)
  f_ref_hz: number;
  range_st?: [number, number];
  context?: 'speech' | 'singing';
  speech_onset_from_target?: boolean;
  singing_onset_bend_st?: number;
  long_pause_reset_ms?: number; // default 150 ms
  singing_portamento?: boolean;
  residuals?: F0ResidualSegment[];
  pins?: F0PinSegment[];
  local_pins?: F0PinSegment[];
  vibrato?: Partial<VibratoConfig>;
  vibratoRegions?: readonly { start_smp: number; end_smp: number; config: Partial<VibratoConfig> }[];
}

export interface EvalF0Output {
  step_smp: number;
  times_smp: number[];
  qta_st: number[];
  f0_st: number[];
  f0_hz: number[];
  voiced_mask: boolean[];
  resolved_spans: ResolvedQtaSpan[];
  end_state: QtaState;
  speed_warnings: Array<{ span_id: string; required_st_per_s: number; limit_st_per_s: number; hint: string }>;
}

/**
 * Evaluate single 3rd-order critically damped qTA interval at local time t in [0, D].
 * Uses unified end-of-interval intercept `b_end`:
 *   x(t) = m*(t - D) + b_end = m*t + b_start,  b_start = b_end - m*D
 */
export function evalQtaSegmentAt(
  tSec: number,
  durationSec: number,
  m: number,
  bEnd: number,
  lambda: number,
  init: QtaState,
): { y: number; yp: number; ypp: number } {
  const D = Math.max(1e-6, durationSec);
  const t = Math.max(0, Math.min(D, tSec));
  const lam = Math.max(1e-4, lambda);
  const bStart = bEnd - m * D;

  const c1 = init.y - bStart;
  const c2 = init.yp + c1 * lam - m;
  const c3 = (init.ypp + 2 * c2 * lam - c1 * lam * lam) / 2;

  const expLt = Math.exp(-lam * t);
  const poly = c1 + c2 * t + c3 * t * t;
  const dpoly = c2 + 2 * c3 * t;
  const d2poly = 2 * c3;

  const x = m * (t - D) + bEnd;
  const y = x + poly * expLt;
  const yp = m + (dpoly - lam * poly) * expLt;
  const ypp = (d2poly - 2 * lam * dpoly + lam * lam * poly) * expLt;
  return { y, yp, ypp };
}

/** Resolve L1 candidate priority: user > transfer > score > default. */
export function resolveTargetCandidate(
  span: QtaTargetSpan,
  fallbackBEndSt: number = 0,
): QtaTargetCandidate {
  for (const src of TARGET_SOURCE_PRIORITY) {
    const c = span.candidates[src];
    if (c) return { ...c, source: src };
  }
  return {
    m_st_per_s: 0,
    b_end_st: fallbackBEndSt,
    lambda_per_s: 45,
    source: 'default',
    rule: 'fallback_mid',
  };
}

/**
 * Resolve L1 targets across all spans, applying pre-glide for short/zero onsets (<50 ms)
 * in singing contexts when requested.
 */
export function resolveAllTargets(
  spans: readonly QtaTargetSpan[],
  fMidSt: number = 0,
  context: 'speech' | 'singing' = 'speech',
  singingPortamento = false,
): ResolvedQtaSpan[] {
  const sorted = [...spans].sort((a, b) => a.start_smp - b.start_smp);
  const resolved: ResolvedQtaSpan[] = sorted.map((s) => {
    const candidate = resolveTargetCandidate(s, fMidSt);
    let lambda = candidate.lambda_per_s;
    if (context === 'singing' && !singingPortamento && typeof s.pre_glide_ms === 'number' && s.pre_glide_ms < 50 && lambda < 90) {
      lambda = 95;
    }
    return {
      span_id: s.span_id,
      start_smp: s.start_smp,
      end_smp: s.end_smp,
      voiced: s.voiced !== false,
      is_rest_after: Boolean(s.is_rest_after),
      candidate: { ...candidate, lambda_per_s: lambda },
    };
  });

  // Move the qTA target boundary only. Score and phonation timing stay on their authored intervals.
  if (context === 'singing') {
    for (let i = 1; i < sorted.length; i++) {
      const cur = sorted[i];
      const prev = resolved[i - 1];
      if (!prev.voiced || prev.is_rest_after || !resolved[i].voiced || prev.end_smp !== cur.start_smp) continue;
      if (typeof cur.pre_glide_ms !== 'number' || !Number.isFinite(cur.pre_glide_ms)) continue;
      if (singingPortamento && (prev.candidate.source !== 'score' || resolved[i].candidate.source !== 'score')) continue;
      const preGlideMs = singingPortamento ? Math.min(50, cur.pre_glide_ms) : cur.pre_glide_ms < 50 ? 45 : 0;
      const prevDurSmp = sorted[i - 1].end_smp - sorted[i - 1].start_smp;
      const shiftSmp = Math.min(msToSamples(preGlideMs), Math.floor(prevDurSmp * 0.25));
      if (shiftSmp > 0 && prevDurSmp - shiftSmp >= msToSamples(20)) {
        prev.end_smp -= shiftSmp;
        resolved[i].start_smp -= shiftSmp;
      }
    }
  }

  return resolved;
}

/**
 * Monotone piecewise cubic Hermite interpolating polynomial (PCHIP, Fritsch-Carlson)
 * for overshoot-free F0 residual curves.
 */
export function evaluatePchip(points: readonly F0ResidualPoint[], u: number): number {
  if (points.length === 0) return 0;
  const pts = [...points].sort((a, b) => a.u - b.u);
  if (pts.length === 1) return pts[0].st;
  if (u <= pts[0].u) return pts[0].st;
  const last = pts[pts.length - 1];
  if (u >= last.u) return last.st;

  const n = pts.length;
  const h = new Array<number>(n - 1);
  const delta = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = Math.max(1e-9, pts[i + 1].u - pts[i].u);
    delta[i] = (pts[i + 1].st - pts[i].st) / h[i];
  }

  const d = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] > 0) {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      d[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    } else {
      d[i] = 0;
    }
  }
  if (n === 2) {
    d[0] = delta[0];
    d[1] = delta[0];
  } else {
    const d0 = ((2 * h[0] + h[1]) * delta[0] - h[0] * delta[1]) / (h[0] + h[1]);
    d[0] = d0 * delta[0] <= 0 ? 0 : Math.abs(d0) > 3 * Math.abs(delta[0]) ? 3 * delta[0] : d0;
    const dn = ((2 * h[n - 2] + h[n - 3]) * delta[n - 2] - h[n - 2] * delta[n - 3]) / (h[n - 2] + h[n - 3]);
    d[n - 1] = dn * delta[n - 2] <= 0 ? 0 : Math.abs(dn) > 3 * Math.abs(delta[n - 2]) ? 3 * delta[n - 2] : dn;
  }

  let idx = 0;
  for (let i = 0; i < n - 1; i++) {
    if (u >= pts[i].u && u <= pts[i + 1].u) {
      idx = i;
      break;
    }
  }
  const s = (u - pts[idx].u) / h[idx];
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  return h00 * pts[idx].st + h10 * h[idx] * d[idx] + h01 * pts[idx + 1].st + h11 * h[idx] * d[idx + 1];
}

function raisedCosineWeight(tMs: number, startMs: number, endMs: number, featherMs: number): number {
  if (tMs < startMs || tMs > endMs) return 0;
  const f = Math.min(Math.max(1, featherMs), (endMs - startMs) * 0.5);
  if (tMs - startMs < f) {
    return 0.5 * (1 - Math.cos((Math.PI * (tMs - startMs)) / f));
  }
  if (endMs - tMs < f) {
    return 0.5 * (1 - Math.cos((Math.PI * (endMs - tMs)) / f));
  }
  return 1;
}

/**
 * Quadratic least squares fit y(dt) = a0 + a1*dt + a2*dt^2 over the exit tail
 * of an absolute pin segment, returning state `(y, y', y'')` at dt = 0 (exit boundary).
 * Acceleration `2*a2` is clamped to physiological bounds [-800, 800] st/s^2.
 */
function fitPinExitState(
  pin: F0PinSegment,
  fRefHz: number,
): QtaState {
  const fitWindowSmp = msToSamples(Math.max(20, Math.min(45, pin.exit_fit_ms || 35)));
  const tailStart = Math.max(pin.start_smp, pin.end_smp - fitWindowSmp);
  const pts = [...pin.points]
    .filter((p) => p.t_smp >= tailStart && p.t_smp <= pin.end_smp)
    .sort((a, b) => a.t_smp - b.t_smp);

  if (pts.length === 0) {
    const last = pin.points[pin.points.length - 1];
    return { y: last ? hzToSt(last.f0_hz, fRefHz) : 0, yp: 0, ypp: 0 };
  }
  if (pts.length === 1) {
    return { y: hzToSt(pts[0].f0_hz, fRefHz), yp: 0, ypp: 0 };
  }
  if (pts.length === 2) {
    const dt = Math.max(1e-4, (pts[1].t_smp - pts[0].t_smp) / SAMPLE_RATE_HZ);
    const y0 = hzToSt(pts[0].f0_hz, fRefHz);
    const y1 = hzToSt(pts[1].f0_hz, fRefHz);
    return { y: y1, yp: (y1 - y0) / dt, ypp: 0 };
  }

  // Fit polynomial in local time dt = (t_smp - end_smp) / sr <= 0 so that at dt=0:
  // y(0) = a0, y'(0) = a1, y''(0) = 2*a2
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  let b0 = 0, b1 = 0, b2 = 0;
  for (const p of pts) {
    const x = (p.t_smp - pin.end_smp) / SAMPLE_RATE_HZ;
    const y = hzToSt(p.f0_hz, fRefHz);
    const x2 = x * x;
    s0 += 1;
    s1 += x;
    s2 += x2;
    s3 += x2 * x;
    s4 += x2 * x2;
    b0 += y;
    b1 += x * y;
    b2 += x2 * y;
  }

  // Solve 3x3 normal equations via Gaussian elimination with partial pivoting
  const A = [
    [s0, s1, s2, b0],
    [s1, s2, s3, b1],
    [s2, s3, s4, b2],
  ];
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    }
    if (pivot !== col) [A[col], A[pivot]] = [A[pivot], A[col]];
    const diag = Math.abs(A[col][col]) < 1e-12 ? 1e-12 : A[col][col];
    for (let r = col + 1; r < 3; r++) {
      const factor = A[r][col] / diag;
      for (let c = col; c < 4; c++) A[r][c] -= factor * A[col][c];
    }
  }
  const coef = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let rhs = A[r][3];
    for (let c = r + 1; c < 3; c++) rhs -= A[r][c] * coef[c];
    coef[r] = rhs / (Math.abs(A[r][r]) < 1e-12 ? 1e-12 : A[r][r]);
  }

  const ypp = Math.max(-800, Math.min(800, 2 * coef[2]));
  const yp = Math.max(-200, Math.min(200, coef[1]));
  return { y: coef[0], yp, ypp };
}

function interpolatePinAt(pin: F0PinSegment, tSmp: number, fRefHz: number): number {
  const pts = [...pin.points].sort((a, b) => a.t_smp - b.t_smp);
  if (pts.length === 0) return 0;
  if (tSmp <= pts[0].t_smp) return hzToSt(pts[0].f0_hz, fRefHz);
  const last = pts[pts.length - 1];
  if (tSmp >= last.t_smp) return hzToSt(last.f0_hz, fRefHz);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (tSmp >= a.t_smp && tSmp <= b.t_smp) {
      const span = b.t_smp - a.t_smp;
      const u = span > 0 ? (tSmp - a.t_smp) / span : 0;
      const ya = hzToSt(a.f0_hz, fRefHz);
      const yb = hzToSt(b.f0_hz, fRefHz);
      return ya + (yb - ya) * u;
    }
  }
  return hzToSt(last.f0_hz, fRefHz);
}

/** Interpolate time-ordered pin points on the same logarithmic scale as the piano roll. */
export function interpolateF0PinHz(points: readonly F0PinSegment['points'][number][], tSmp: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].t_smp <= tSmp) lo = mid;
    else hi = mid;
  }
  const left = points[lo];
  const right = points[hi];
  if (tSmp <= left.t_smp) return left.f0_hz;
  if (tSmp >= right.t_smp) return right.f0_hz;
  const u = (tSmp - left.t_smp) / (right.t_smp - left.t_smp);
  return left.f0_hz * (right.f0_hz / left.f0_hz) ** u;
}

function localPinBlends(pins: F0PinSegment[], spans: ResolvedQtaSpan[]) {
  if (!pins.length) return [];
  const runs: { start_smp: number; end_smp: number }[] = [];
  for (const span of spans) {
    if (!span.voiced) continue;
    const last = runs.at(-1);
    if (last && last.end_smp === span.start_smp) last.end_smp = span.end_smp;
    else runs.push({ start_smp: span.start_smp, end_smp: span.end_smp });
  }
  return pins.flatMap((pin, index) => {
    const prev = pins[index - 1];
    const next = pins[index + 1];
    const fadeSmp = msToSamples(Math.max(20, Math.min(40, pin.transition_ms || 30)));
    const entry = prev ? Math.min(fadeSmp, Math.floor((pin.start_smp - prev.end_smp) / 2)) : fadeSmp;
    const exit = next ? Math.min(fadeSmp, Math.floor((next.start_smp - pin.end_smp) / 2)) : fadeSmp;
    return runs.filter((run) => pin.start_smp < run.end_smp && run.start_smp < pin.end_smp).map((run) => ({
      pin,
      start_smp: Math.max(run.start_smp, pin.start_smp - Math.max(0, entry)),
      end_smp: Math.min(run.end_smp, pin.end_smp + Math.max(0, exit)),
      join: prev?.end_smp === pin.start_smp && prev.end_smp > run.start_smp ? {
        f0_hz: interpolateF0PinHz(prev.points, prev.end_smp - 1),
        end_smp: pin.start_smp + Math.min(fadeSmp, Math.floor((pin.end_smp - pin.start_smp) / 2)),
      } : undefined,
    }));
  });
}

/**
 * Main L0..L6 F0 evaluator.
 * Rejects any voiced output outside 60..600 Hz without silent clamping.
 */
export function evalF0(input: EvalF0Input): Result<EvalF0Output> {
  const fRefRes = outOfRangeCheck('f_ref_hz', input.f_ref_hz, F0_LIMIT_HZ.min, F0_LIMIT_HZ.max, 'Hz');
  if (!fRefRes.ok) return fRefRes;

  const stepSmp = input.step_smp ?? 240; // 5 ms @ 48 kHz
  if (!Number.isInteger(stepSmp) || stepSmp <= 0) {
    return outOfRange('step_smp', stepSmp, 1, SAMPLE_RATE_HZ, 'smp');
  }
  if (!Number.isInteger(input.total_smp) || input.total_smp < 0) {
    return outOfRange('total_smp', input.total_smp, 0, SAMPLE_RATE_HZ * 60, 'smp');
  }

  // Validate pin points up front against 60..600 Hz
  const pins = [...(input.pins ?? [])].sort((a, b) => a.start_smp - b.start_smp);
  const localPins = (input.local_pins ?? []).filter(pin => pin.points.length).sort((a, b) => a.start_smp - b.start_smp);
  for (const pin of [...pins, ...localPins]) {
    for (const pt of pin.points) {
      const r = outOfRangeCheck('pin.f0_hz', pt.f0_hz, F0_LIMIT_HZ.min, F0_LIMIT_HZ.max, 'Hz');
      if (!r.ok) return r;
    }
  }

  const rangeSt = input.range_st ?? [-6, 14];
  const fMidSt = (rangeSt[0] + rangeSt[1]) / 2;
  const context = input.context ?? 'speech';
  const longPauseResetMs = input.long_pause_reset_ms ?? 150;
  const vib: VibratoConfig = { ...DEFAULT_VIBRATO, ...input.vibrato };
  const vibratoRegions = (input.vibratoRegions ?? []).map(region => ({ ...region, config: { ...vib, ...region.config } }));
  let vibratoCursor = 0;

  const resolvedSpans = resolveAllTargets(input.spans, fMidSt, context, input.singing_portamento);
  const localBlends = localPinBlends(localPins, resolvedSpans);
  const speedWarnings: EvalF0Output['speed_warnings'] = [];

  // Xu & Sun (2002) maximum pitch change speed empirical check (hint only, never blocks)
  for (const sp of resolvedSpans) {
    const durS = (sp.end_smp - sp.start_smp) / SAMPLE_RATE_HZ;
    if (durS > 0 && sp.voiced) {
      const excursion = Math.abs(sp.candidate.m_st_per_s) * durS;
      // Empirical max speed roughly 10.7 + 12.4 * excursion (st/s) or ~120 st/s practical ceiling
      const limit = Math.max(85, 10.7 + 12.4 * excursion);
      if (Math.abs(sp.candidate.m_st_per_s) > limit) {
        speedWarnings.push({
          span_id: sp.span_id,
          required_st_per_s: Math.round(Math.abs(sp.candidate.m_st_per_s) * 10) / 10,
          limit_st_per_s: Math.round(limit * 10) / 10,
          hint: '变调速率接近或超过人声生理经验上限，可延长前导量或降低跳进幅度',
        });
      }
    }
  }

  const timesSmp: number[] = [];
  const qtaSt: number[] = [];
  const f0St: number[] = [];
  const f0Hz: number[] = [];
  const voicedMask: boolean[] = [];

  // Precompute segment boundary states across all resolved spans + pins
  const spanMap = new Map<string, ResolvedQtaSpan>();
  for (const sp of resolvedSpans) spanMap.set(sp.span_id, sp);

  // Initialize state according to speech vs singing rules
  let state: QtaState = { y: fMidSt, yp: 0, ypp: 0 };
  if (context === 'singing' && resolvedSpans.length > 0) {
    const firstVoiced = resolvedSpans.find((s) => s.voiced) ?? resolvedSpans[0];
    const bend = input.singing_onset_bend_st ?? 0;
    state = { y: firstVoiced.candidate.b_end_st + bend, yp: 0, ypp: 0 };
  }

  // Track exact start state for each span so we can evaluate any sample time cleanly
  const spanInitStates = new Map<string, QtaState>();
  // Pin exits inside a span: after the last exit the span continues from the
  // fitted exit state over the remaining duration instead of restarting from
  // the span's initial state (which produced exit jumps of several semitones).
  const spanExitStates = new Map<string, { exit_smp: number; state: QtaState }>();
  let prevSpanEndSmp = 0;
  let prevWasRest = false;
  const speechOnsetFromTarget = context === 'speech' && input.speech_onset_from_target;
  let needsSpeechOnset = speechOnsetFromTarget;

  for (let i = 0; i < resolvedSpans.length; i++) {
    const sp = resolvedSpans[i];
    const gapMs = samplesToMs(Math.max(0, sp.start_smp - prevSpanEndSmp));
    const durS = Math.max(1e-6, (sp.end_smp - sp.start_smp) / SAMPLE_RATE_HZ);

    if (i > 0 && (gapMs > longPauseResetMs || prevWasRest)) {
      if (context === 'singing') {
        const bend = input.singing_onset_bend_st ?? 0;
        state = { y: sp.candidate.b_end_st + bend, yp: 0, ypp: 0 };
      } else {
        state = { y: fMidSt, yp: 0, ypp: 0 };
        needsSpeechOnset = speechOnsetFromTarget;
      }
    }
    if (needsSpeechOnset && sp.voiced) {
      const targetStartSt = sp.candidate.b_end_st - sp.candidate.m_st_per_s * durS;
      const targetStartHz = stToHz(targetStartSt, input.f_ref_hz);
      // Some linear targets extrapolate beyond the valid source range at the start.
      // Use the usual onset in that case and let the output guard validate the contour.
      const onsetSt = targetStartHz >= F0_LIMIT_HZ.min && targetStartHz <= F0_LIMIT_HZ.max ? targetStartSt : fMidSt;
      state = { y: onsetSt, yp: 0, ypp: 0 };
      needsSpeechOnset = false;
    }

    spanInitStates.set(sp.span_id, { ...state });

    // Check if an absolute pin exits inside or at the end of this span
    const exitingPins = pins.filter((p) => p.end_smp > sp.start_smp && p.end_smp <= sp.end_smp);
    const intersectingPin = exitingPins.reduce<F0PinSegment | undefined>(
      (latest, p) => (!latest || p.end_smp > latest.end_smp ? p : latest), undefined);
    if (intersectingPin) {
      const exitState = fitPinExitState(intersectingPin, input.f_ref_hz);
      spanExitStates.set(sp.span_id, { exit_smp: intersectingPin.end_smp, state: exitState });
      const remainS = (sp.end_smp - intersectingPin.end_smp) / SAMPLE_RATE_HZ;
      state = remainS > 0
        ? evalQtaSegmentAt(remainS, remainS, sp.candidate.m_st_per_s, sp.candidate.b_end_st,
          sp.candidate.lambda_per_s, exitState)
        : exitState;
    } else {
      state = evalQtaSegmentAt(
        durS,
        durS,
        sp.candidate.m_st_per_s,
        sp.candidate.b_end_st,
        sp.candidate.lambda_per_s,
        state,
      );
    }

    prevSpanEndSmp = sp.end_smp;
    prevWasRest = !sp.voiced && sp.is_rest_after;
  }

  const residuals = input.residuals ?? [];
  let spanCursor = 0;
  let localPinCursor = 0;

  for (let tSmp = 0; tSmp < input.total_smp; tSmp += stepSmp) {
    while (spanCursor < resolvedSpans.length - 1 && tSmp >= resolvedSpans[spanCursor].end_smp) {
      spanCursor++;
    }
    const sp = resolvedSpans[spanCursor];
    let qVal = fMidSt;
    let isVoiced = false;

    if (sp && tSmp >= sp.start_smp && tSmp < sp.end_smp) {
      const durS = Math.max(1e-6, (sp.end_smp - sp.start_smp) / SAMPLE_RATE_HZ);
      const localS = (tSmp - sp.start_smp) / SAMPLE_RATE_HZ;
      const exit = spanExitStates.get(sp.span_id);
      if (exit && tSmp > exit.exit_smp) {
        const remainS = Math.max(1e-6, (sp.end_smp - exit.exit_smp) / SAMPLE_RATE_HZ);
        qVal = evalQtaSegmentAt(
          (tSmp - exit.exit_smp) / SAMPLE_RATE_HZ,
          remainS,
          sp.candidate.m_st_per_s,
          sp.candidate.b_end_st,
          sp.candidate.lambda_per_s,
          exit.state,
        ).y;
      } else {
        const initState = spanInitStates.get(sp.span_id) ?? { y: fMidSt, yp: 0, ypp: 0 };
        qVal = evalQtaSegmentAt(
          localS,
          durS,
          sp.candidate.m_st_per_s,
          sp.candidate.b_end_st,
          sp.candidate.lambda_per_s,
          initState,
        ).y;
      }
      isVoiced = sp.voiced;
    } else if (resolvedSpans.length > 0 && tSmp > resolvedSpans[resolvedSpans.length - 1].end_smp) {
      qVal = state.y;
    }

    // L3: Absolute Pin (entry crossfade + direct replacement + exit crossfade)
    let qWithPin = qVal;
    for (const pin of pins) {
      const transSmp = msToSamples(Math.max(20, Math.min(40, pin.transition_ms || 30)));
      const entryStart = pin.start_smp - transSmp;
      const exitEnd = pin.end_smp + transSmp;
      if (tSmp >= entryStart && tSmp < pin.start_smp) {
        const u = (tSmp - entryStart) / Math.max(1, transSmp);
        const w = 0.5 * (1 - Math.cos(Math.PI * u));
        const pinVal = interpolatePinAt(pin, pin.start_smp, input.f_ref_hz);
        qWithPin = qWithPin * (1 - w) + pinVal * w;
      } else if (tSmp >= pin.start_smp && tSmp <= pin.end_smp) {
        qWithPin = interpolatePinAt(pin, tSmp, input.f_ref_hz);
      } else if (tSmp > pin.end_smp && tSmp < exitEnd) {
        const u = (tSmp - pin.end_smp) / Math.max(1, transSmp);
        const w = 0.5 * (1 - Math.cos(Math.PI * u));
        const pinVal = interpolatePinAt(pin, pin.end_smp, input.f_ref_hz);
        qWithPin = pinVal * (1 - w) + qVal * w;
      }
    }

    // L3: Relative Residuals (PCHIP + 30 ms raised-cosine feathering)
    let residSum = 0;
    const tMs = samplesToMs(tSmp);
    for (const res of residuals) {
      const targetSpan = spanMap.get(res.span_id);
      if (!targetSpan) continue;
      const sMs = samplesToMs(targetSpan.start_smp);
      const eMs = samplesToMs(targetSpan.end_smp);
      if (tMs >= sMs && tMs <= eMs) {
        const spanDur = Math.max(1e-6, targetSpan.end_smp - targetSpan.start_smp);
        const u = (tSmp - targetSpan.start_smp) / spanDur;
        const w = raisedCosineWeight(tMs, sMs, eMs, res.feather_ms ?? 30);
        residSum += w * evaluatePchip(res.points, u);
      }
    }

    // L4: Deterministic Vibrato (in cents -> semitones)
    let vibSt = 0;
    while (vibratoRegions[vibratoCursor]?.end_smp <= tSmp) vibratoCursor++;
    const region = vibratoRegions[vibratoCursor]?.start_smp <= tSmp ? vibratoRegions[vibratoCursor] : undefined;
    const vibratoSpan = region ?? sp;
    const vibrato = region?.config ?? vib;
    if (vibrato.enabled && vibratoSpan && isVoiced) {
      const spanDurMs = samplesToMs(vibratoSpan.end_smp - vibratoSpan.start_smp);
      if (spanDurMs >= vibrato.min_hold_ms) {
        const localMs = samplesToMs(tSmp - vibratoSpan.start_smp);
        const attackMs = vibrato.delay_ms;
        const releaseMs = spanDurMs - vibrato.fade_out_ms;
        if (localMs > attackMs && localMs < releaseMs) {
          const inFactor = Math.min(1, (localMs - attackMs) / Math.max(1, vibrato.fade_in_ms));
          const outFactor = Math.min(1, (spanDurMs - localMs) / Math.max(1, vibrato.fade_out_ms));
          const env = Math.min(inFactor, outFactor);
          const phase = 2 * Math.PI * vibrato.rate_hz * ((tSmp / SAMPLE_RATE_HZ));
          vibSt = (env * vibrato.depth_cents * Math.sin(phase)) / 100;
        }
      }
    }

    let totalSt = qWithPin + residSum + vibSt;
    let hz = stToHz(totalSt, input.f_ref_hz);
    while (localBlends[localPinCursor]?.end_smp <= tSmp) localPinCursor++;
    const local = localBlends[localPinCursor];
    if (isVoiced && local && local.start_smp <= tSmp) {
      const { pin } = local;
      const pinHz = interpolateF0PinHz(pin.points, tSmp);
      if (tSmp >= pin.start_smp && tSmp < pin.end_smp) {
        const join = local.join;
        if (join && tSmp < join.end_smp) {
          const u = (tSmp - pin.start_smp) / (join.end_smp - pin.start_smp);
          const weight = 0.5 * (1 - Math.cos(Math.PI * u));
          hz = join.f0_hz * (pinHz / join.f0_hz) ** weight;
        } else {
          hz = pinHz;
        }
      } else {
        const u = tSmp < pin.start_smp
          ? (tSmp - local.start_smp) / (pin.start_smp - local.start_smp)
          : (local.end_smp - tSmp) / (local.end_smp - pin.end_smp);
        const weight = 0.5 * (1 - Math.cos(Math.PI * u));
        hz *= (pinHz / hz) ** weight;
      }
      totalSt = hzToSt(hz, input.f_ref_hz);
    }

    // L6: Strict 60..600 Hz guard without silent clamping
    if (isVoiced && (hz < F0_LIMIT_HZ.min || hz > F0_LIMIT_HZ.max || !Number.isFinite(hz))) {
      return outOfRange(
        'f0_hz',
        Math.round(hz * 100) / 100,
        F0_LIMIT_HZ.min,
        F0_LIMIT_HZ.max,
        'Hz',
        `音节/区间 ${sp?.span_id ?? '?'} 在 ${(tSmp / SAMPLE_RATE_HZ).toFixed(3)}s 处基频 ${hz.toFixed(1)} Hz 超出声源范围 [60, 600] Hz；请整体移调或调整靶点，系统不会静默夹紧`,
      );
    }

    timesSmp.push(tSmp);
    qtaSt.push(qVal);
    f0St.push(totalSt);
    f0Hz.push(hz);
    voicedMask.push(isVoiced);
  }

  return ok({
    step_smp: stepSmp,
    times_smp: timesSmp,
    qta_st: qtaSt,
    f0_st: f0St,
    f0_hz: f0Hz,
    voiced_mask: voicedMask,
    resolved_spans: resolvedSpans,
    end_state: state,
    speed_warnings: speedWarnings,
  });
}

function outOfRangeCheck(
  field: string,
  val: number,
  min: number,
  max: number,
  unit: string,
): Result<number> {
  if (typeof val !== 'number' || !Number.isFinite(val) || val < min || val > max) {
    return outOfRange(field, val, min, max, unit);
  }
  return ok(val);
}

/**
 * Convert Chao 5-level tone digits (e.g. "55", "35", "21", "214", "51", "5", "0")
 * into 1 or 2 qTA target segments according to 3.2.2 spec.
 *
 * `st(d) = st_lo + ((d - 1) / 4) * R`
 */
export function toneLevelsToQtaTargets(
  levels: string,
  durationSec: number,
  rangeSt: [number, number] = [-6, 4],
  options?: { lambda?: number; splitRatio?: number; checked?: boolean },
): Array<{ fracStart: number; fracEnd: number; candidate: QtaTargetCandidate }> {
  const [stLo, stHi] = rangeSt;
  const R = stHi - stLo;
  const stOf = (d: number): number => stLo + ((d - 1) / 4) * R;
  const lam = options?.lambda ?? 45;
  const D = Math.max(0.02, durationSec);

  const digits = levels.replace(/[^0-5]/g, '');
  if (!digits || digits === '0') {
    const mid = stLo + 0.5 * R;
    return [
      {
        fracStart: 0,
        fracEnd: 1,
        candidate: {
          m_st_per_s: 0,
          b_end_st: mid,
          lambda_per_s: 28,
          source: 'default',
          rule: 'neutral_tone_0',
        },
      },
    ];
  }

  if (digits.length === 1) {
    const val = stOf(Number(digits[0]));
    return [
      {
        fracStart: 0,
        fracEnd: 1,
        candidate: {
          m_st_per_s: 0,
          b_end_st: val,
          lambda_per_s: options?.checked ? Math.max(lam, 50) : lam,
          source: 'default',
          rule: `tone_${digits}`,
        },
      },
    ];
  }

  if (digits.length === 2) {
    const a = Number(digits[0]);
    const b = Number(digits[1]);
    if (a === b) {
      return [
        {
          fracStart: 0,
          fracEnd: 1,
          candidate: {
            m_st_per_s: 0,
            b_end_st: stOf(b),
            lambda_per_s: lam,
            source: 'default',
            rule: `tone_${digits}`,
          },
        },
      ];
    }
    const m = (stOf(b) - stOf(a)) / D;
    return [
      {
        fracStart: 0,
        fracEnd: 1,
        candidate: {
          m_st_per_s: m,
          b_end_st: stOf(b),
          lambda_per_s: lam,
          source: 'default',
          rule: `tone_${digits}`,
        },
      },
    ];
  }

  // Dipping / complex contour e.g. 214 -> split at 40% by default
  const split = options?.splitRatio ?? 0.4;
  const a = Number(digits[0]);
  const b = Number(digits[1]);
  const c = Number(digits[2]);
  const d1 = D * split;
  const d2 = D * (1 - split);
  return [
    {
      fracStart: 0,
      fracEnd: split,
      candidate: {
        m_st_per_s: (stOf(b) - stOf(a)) / Math.max(0.02, d1),
        b_end_st: stOf(b),
        lambda_per_s: lam,
        source: 'default',
        rule: `tone_${digits}_part1`,
      },
    },
    {
      fracStart: split,
      fracEnd: 1,
      candidate: {
        m_st_per_s: (stOf(c) - stOf(b)) / Math.max(0.02, d2),
        b_end_st: stOf(c),
        lambda_per_s: lam,
        source: 'default',
        rule: `tone_${digits}_part2`,
      },
    },
  ];
}

/**
 * Single-syllable tone calibration (3.2.2):
 * Because qTA lags behind steep slopes, search `b_end_st` in 1-D so the isolated
 * syllable's realized surface F0 at offset hits `desiredEndSt` within tolerance.
 */
export function calibrateMonosyllableTone(
  initial: QtaTargetCandidate,
  durationSec: number,
  desiredEndSt: number,
  initYSt: number = 0,
): QtaTargetCandidate {
  let lo = desiredEndSt - 18;
  let hi = desiredEndSt + 18;
  const initState: QtaState = { y: initYSt, yp: 0, ypp: 0 };

  for (let iter = 0; iter < 32; iter++) {
    const mid = 0.5 * (lo + hi);
    const realized = evalQtaSegmentAt(
      durationSec,
      durationSec,
      initial.m_st_per_s,
      mid,
      initial.lambda_per_s,
      initState,
    ).y;
    if (realized < desiredEndSt) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return {
    ...initial,
    b_end_st: 0.5 * (lo + hi),
    rule: `${initial.rule ?? 'tone'}_calibrated`,
  };
}

/**
 * Fit a hand-drawn F0 contour (samples in {t_sec, f0_st}) to a qTA target `(m, b_end, λ)`
 * via 1-D grid search over `λ` and closed-form OLS on `(m, b_end)`.
 * Returns RMS error in semitones; if rmse <= 0.3 st, write back as `user` target.
 */
export function fitHanddrawnToQtaTarget(
  samples: ReadonlyArray<{ t_sec: number; f0_st: number }>,
  durationSec: number,
  init: QtaState,
): { candidate: QtaTargetCandidate; rmse_st: number } | null {
  if (samples.length < 3 || durationSec <= 0) return null;
  const D = durationSec;
  let best: { m: number; bEnd: number; lam: number; rmse: number } | null = null;

  for (let lam = 20; lam <= 115; lam += 5) {
    // At fixed lambda, f0(t) is linear in (m, b_end):
    // Let b_start = b_end - m*D.
    // c1 = y0 - b_end + m*D
    // c2 = yp0 + lam*y0 - lam*b_end + (lam*D - 1)*m
    // c3 = (ypp0 + 2*lam*yp0 + lam^2*y0 - lam^2*b_end + (lam^2*D - 2*lam)*m)/2
    // So f0(t) = const_part(t) + A_m(t)*m + A_b(t)*b_end
    let sMM = 0, sMB = 0, sBB = 0, rM = 0, rB = 0;
    const amList: number[] = [];
    const abList: number[] = [];
    const rhsList: number[] = [];

    for (const pt of samples) {
      const t = Math.max(0, Math.min(D, pt.t_sec));
      const e = Math.exp(-lam * t);
      const t2 = t * t;

      const c0Const = init.y + (init.yp + lam * init.y) * t + 0.5 * (init.ypp + 2 * lam * init.yp + lam * lam * init.y) * t2;
      const constVal = c0Const * e;

      const am = (t - D) + (D + (lam * D - 1) * t + 0.5 * (lam * lam * D - 2 * lam) * t2) * e;
      const ab = 1 - (1 + lam * t + 0.5 * lam * lam * t2) * e;
      const rhs = pt.f0_st - constVal;

      amList.push(am);
      abList.push(ab);
      rhsList.push(rhs);
      sMM += am * am;
      sMB += am * ab;
      sBB += ab * ab;
      rM += am * rhs;
      rB += ab * rhs;
    }

    const det = sMM * sBB - sMB * sMB;
    if (Math.abs(det) < 1e-10) continue;
    const m = (rM * sBB - rB * sMB) / det;
    const bEnd = (sMM * rB - sMB * rM) / det;

    let sse = 0;
    for (let i = 0; i < rhsList.length; i++) {
      const err = amList[i] * m + abList[i] * bEnd - rhsList[i];
      sse += err * err;
    }
    const rmse = Math.sqrt(sse / rhsList.length);
    if (!best || rmse < best.rmse) {
      best = { m, bEnd, lam, rmse };
    }
  }

  if (!best) return null;
  return {
    candidate: {
      m_st_per_s: best.m,
      b_end_st: best.bEnd,
      lambda_per_s: best.lam,
      source: 'user',
      rule: 'handdrawn_qta_fit',
    },
    rmse_st: best.rmse,
  };
}
