/**
 * 6-Regime Discrete Phonation Anchors -> 10-Dim M27 Glottis Space
 *
 * Strictly aligns with TensorTract3 m27_contract / glottis27_generator
 * (`F0`, `PR`, `XB`, `XT`, `CA`, `LAG`, `RA`, `PS`, `FL`, `SHIM`) and VTL 2.4
 * Geometric glottis 2025 limits. Frontend & TS use `pr_pa` in Pa (0..1600 Pa);
 * Python engine/native boundary converts `dPa = pr_pa * 10`.
 *
 * Interpolation between ANY two anchors runs directly linearly in 10-D space
 * without passing through intermediate discrete regimes on the vertical lane.
 */

import {
  assertInRange,
  fail,
  ok,
  type GlottisM27Params,
  type PhonationAnchor,
  type PhonationRegime,
  type Result,
} from './types';

export const PHONATION_REGIMES: readonly PhonationRegime[] = [
  'pressed',
  'modal',
  'breathy',
  'whisper',
  'creaky',
  'falsetto',
] as const;

export const PHONATION_REGIME_LABELS: Record<PhonationRegime, string> = {
  pressed: '挤喉发声/紧声 · Pressed',
  modal: '常态浊声 · Modal',
  breathy: '气声 · Breathy',
  whisper: '耳语 · Whisper',
  creaky: '嘎裂声 · Creaky',
  falsetto: '假声 · Falsetto',
};

export const M27_GLOTTIS_BOUNDS = {
  f0_hz: { min: 40, max: 600, unit: 'Hz' },
  pr_pa: { min: 0, max: 1600, unit: 'Pa' },
  xb_cm: { min: -0.05, max: 0.30, unit: 'cm' },
  xt_cm: { min: -0.05, max: 0.30, unit: 'cm' },
  ca_cm2: { min: -0.25, max: 0.25, unit: 'cm^2' },
  lag_rad: { min: 0, max: 3.1415, unit: 'rad' },
  ra: { min: -1, max: 1, unit: 'ratio' },
  ps: { min: -1, max: 1, unit: 'ratio' },
  fl: { min: 0, max: 100, unit: '%' },
  shim: { min: 0, max: 100, unit: '%' },
} as const;

export const M27_GLOTTIS_DIM_NAMES = [
  'F0', 'PR', 'XB', 'XT', 'CA', 'LAG', 'RA', 'PS', 'FL', 'SHIM',
] as const;

/**
 * Canonical 10-dim M27 glottal anchors for the 6 discrete phonation regimes.
 * Values follow F:\TensorTract3_Train\scripts\demo_phonation_types.py and
 * glottis27_generator.py centroids, with pressure converted from dPa -> Pa.
 */
export const PHONATION_M27_ANCHORS: Readonly<Record<PhonationRegime, Readonly<GlottisM27Params>>> = {
  pressed: {
    f0_hz: 135,
    pr_pa: 1150,
    xb_cm: -0.015,
    xt_cm: -0.018,
    ca_cm2: 0.0,
    lag_rad: 1.9,
    ra: 1.0,
    ps: 0.85,
    fl: 12,
    shim: 0,
  },
  modal: {
    f0_hz: 125,
    pr_pa: 800,
    xb_cm: 0.04,
    xt_cm: 0.04,
    ca_cm2: 0.02,
    lag_rad: 1.222044,
    ra: 1.0,
    ps: 0.5,
    fl: 20,
    shim: 0,
  },
  breathy: {
    f0_hz: 125,
    pr_pa: 750,
    xb_cm: 0.075,
    xt_cm: 0.08,
    ca_cm2: 0.085,
    lag_rad: 0.75,
    ra: 0.85,
    ps: -0.25,
    fl: 25,
    shim: 12,
  },
  whisper: {
    f0_hz: 125,
    pr_pa: 850,
    xb_cm: 0.11,
    xt_cm: 0.115,
    ca_cm2: 0.15,
    lag_rad: 1.222044,
    ra: 0.0,
    ps: 0.0,
    fl: 35,
    shim: 15,
  },
  creaky: {
    f0_hz: 58,
    pr_pa: 520,
    xb_cm: -0.008,
    xt_cm: -0.008,
    ca_cm2: 0.0,
    lag_rad: 1.95,
    ra: 0.92,
    ps: 0.88,
    fl: 80,
    shim: 100,
  },
  falsetto: {
    f0_hz: 330,
    pr_pa: 680,
    xb_cm: 0.055,
    xt_cm: 0.058,
    ca_cm2: 0.04,
    lag_rad: 0.15,
    ra: 0.48,
    ps: -0.45,
    fl: 20,
    shim: 8,
  },
};

export function isPhonationRegime(value: unknown): value is PhonationRegime {
  return typeof value === 'string' && (PHONATION_REGIMES as readonly string[]).includes(value);
}

export function getPhonationAnchorParams(
  regime: PhonationRegime,
  overrides?: Partial<GlottisM27Params>,
): GlottisM27Params {
  const base = PHONATION_M27_ANCHORS[regime];
  return {
    ...base,
    ...overrides,
  };
}

export function validateGlottisM27(params: GlottisM27Params): Result<GlottisM27Params> {
  const checks: Array<[keyof GlottisM27Params, { min: number; max: number; unit: string }]> = [
    ['f0_hz', M27_GLOTTIS_BOUNDS.f0_hz],
    ['pr_pa', M27_GLOTTIS_BOUNDS.pr_pa],
    ['xb_cm', M27_GLOTTIS_BOUNDS.xb_cm],
    ['xt_cm', M27_GLOTTIS_BOUNDS.xt_cm],
    ['ca_cm2', M27_GLOTTIS_BOUNDS.ca_cm2],
    ['lag_rad', M27_GLOTTIS_BOUNDS.lag_rad],
    ['ra', M27_GLOTTIS_BOUNDS.ra],
    ['ps', M27_GLOTTIS_BOUNDS.ps],
    ['fl', M27_GLOTTIS_BOUNDS.fl],
    ['shim', M27_GLOTTIS_BOUNDS.shim],
  ];
  for (const [key, b] of checks) {
    const r = assertInRange(`glottis.${key}`, params[key], b.min, b.max, b.unit);
    if (!r.ok) return r;
  }
  return ok({ ...params });
}

export function validateVoqsAnchor(anchor: PhonationAnchor): Result<PhonationAnchor> {
  if (!anchor.voqs) return ok(anchor);
  const { symbol, source_id, t_s } = anchor.voqs;
  if (typeof symbol !== 'string' || typeof source_id !== 'string' || !symbol.trim() || !source_id.trim() || !Number.isFinite(t_s) || t_s < 0 || !anchor.glottis) {
    return fail({ code: 'validation_error', field: 'anchors.voqs', hint: 'VoQS 实录锚点需要五十赫兹声门帧、录音来源与非负时刻' });
  }
  const controls = validateGlottisM27(anchor.glottis);
  if (!controls.ok) return controls;
  if (anchor.larynx_height_cm !== undefined) {
    const height = assertInRange('anchors.larynx_height_cm', anchor.larynx_height_cm, -1, 1, 'cm');
    if (!height.ok) return height;
  }
  return ok(anchor);
}

/**
 * Direct linear interpolation in 10-D m27 glottal space between `a` and `b`
 * at factor `alpha` in [0, 1]. Never passes through intermediate discrete lanes.
 */
export function interpolateGlottis10D(
  a: GlottisM27Params,
  b: GlottisM27Params,
  alpha: number,
): Result<GlottisM27Params> {
  const rAlpha = assertInRange('alpha', alpha, 0, 1, 'ratio');
  if (!rAlpha.ok) return rAlpha;
  const lerp = (x: number, y: number): number => x + (y - x) * alpha;
  return ok({
    f0_hz: lerp(a.f0_hz, b.f0_hz),
    pr_pa: lerp(a.pr_pa, b.pr_pa),
    xb_cm: lerp(a.xb_cm, b.xb_cm),
    xt_cm: lerp(a.xt_cm, b.xt_cm),
    ca_cm2: lerp(a.ca_cm2, b.ca_cm2),
    lag_rad: lerp(a.lag_rad, b.lag_rad),
    ra: lerp(a.ra, b.ra),
    ps: lerp(a.ps, b.ps),
    fl: lerp(a.fl, b.fl),
    shim: lerp(a.shim, b.shim),
  });
}

/**
 * Sample a sequence of discrete phonation anchors at arbitrary integer sample `t_smp`.
 * Anchors are sorted by `t_smp`; adjacent anchors interpolate directly in 10-D m27 space.
 */
export function evaluatePhonationAnchorsAt(
  anchors: readonly PhonationAnchor[],
  t_smp: number,
): Result<GlottisM27Params> {
  if (!Number.isFinite(t_smp) || t_smp < 0) {
    return fail({
      code: 'out_of_range',
      field: 't_smp',
      value: t_smp,
      allowed: { min: 0, max: Number.MAX_SAFE_INTEGER, unit: 'smp' },
      hint: '采样时刻必须为非负整数',
    });
  }
  if (anchors.length === 0) {
    return ok({ ...PHONATION_M27_ANCHORS.modal });
  }
  const sorted = [...anchors].sort((x, y) => x.t_smp - y.t_smp);
  const resolveParams = (anc: PhonationAnchor): GlottisM27Params => {
    const base = PHONATION_M27_ANCHORS[anc.regime];
    if (anc.glottis) return anc.glottis;
    if (anc.blend >= 1 || anc.regime === 'modal') return { ...base };
    const r = interpolateGlottis10D(PHONATION_M27_ANCHORS.modal, base, Math.max(0, Math.min(1, anc.blend)));
    return r.ok ? r.value : { ...base };
  };

  if (t_smp <= sorted[0].t_smp) {
    return ok(resolveParams(sorted[0]));
  }
  const last = sorted[sorted.length - 1];
  if (t_smp >= last.t_smp) {
    return ok(resolveParams(last));
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    const left = sorted[i];
    const right = sorted[i + 1];
    if (t_smp >= left.t_smp && t_smp <= right.t_smp) {
      const span = right.t_smp - left.t_smp;
      if (span <= 0) return ok(resolveParams(right));
      const u = (t_smp - left.t_smp) / span;
      return interpolateGlottis10D(resolveParams(left), resolveParams(right), u);
    }
  }
  return ok(resolveParams(last));
}

export function evaluatePhonationTrackDense(
  anchors: readonly PhonationAnchor[],
  totalSamples: number,
  stepSamples: number = 240, // 5 ms @ 48 kHz (200 Hz)
): Result<Array<{ t_smp: number; glottis: GlottisM27Params }>> {
  if (!Number.isInteger(totalSamples) || totalSamples < 0) {
    return fail({
      code: 'out_of_range',
      field: 'totalSamples',
      value: totalSamples,
      allowed: { min: 0, max: 48000 * 60, unit: 'smp' },
      hint: 'totalSamples 必须为非负整数',
    });
  }
  if (!Number.isInteger(stepSamples) || stepSamples <= 0) {
    return fail({
      code: 'out_of_range',
      field: 'stepSamples',
      value: stepSamples,
      allowed: { min: 1, max: 48000, unit: 'smp' },
      hint: 'stepSamples 必须为正整数',
    });
  }
  const frames: Array<{ t_smp: number; glottis: GlottisM27Params }> = [];
  for (let t = 0; t < totalSamples; t += stepSamples) {
    const res = evaluatePhonationAnchorsAt(anchors, t);
    if (!res.ok) return res;
    frames.push({ t_smp: t, glottis: res.value });
  }
  return ok(frames);
}

/**
 * Evaluate a timeline's discrete regime at t using [anchor, next anchor) holds.
 * Callers pass anchors sorted by t_smp. Before the first anchor, use modal voice.
 */
export function activePhonationAnchorAt(
  anchors: readonly PhonationAnchor[],
  tSmp: number,
): PhonationAnchor | undefined {
  let lo = 0;
  let hi = anchors.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (anchors[mid].t_smp <= tSmp) lo = mid + 1;
    else hi = mid;
  }
  return anchors[lo - 1];
}

export function heldPhonationAt(
  anchors: readonly PhonationAnchor[],
  tSmp: number,
): GlottisM27Params {
  const anchor = activePhonationAnchorAt(anchors, tSmp);
  if (!anchor) return getPhonationAnchorParams('modal');
  if (anchor.glottis) return { ...anchor.glottis };
  const base = getPhonationAnchorParams(anchor.regime);
  if (anchor.blend >= 1 || anchor.regime === 'modal') return base;
  const blended = interpolateGlottis10D(getPhonationAnchorParams('modal'), base, anchor.blend);
  return blended.ok ? blended.value : base;
}

export const VOQS_NOTE = 'VoQS anchor glottis controls are evaluated strictly in 50 Hz M27 units.';
