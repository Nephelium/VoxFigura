/**
 * Pure TypeScript cinematic easing, physics & deterministic noise math kernel.
 *
 * Adapted from Vincentwei1021/video-shotcraft (Apache-2.0):
 * - assets/lib/helpers/motion.ts (cubic-bezier solver, ramp, mix, velocityAt)
 * - assets/lib/helpers/shake.ts (deterministic handheld drift)
 * - assets/lib/helpers/rand.ts (mulberry32 deterministic PRNG)
 * - demos/_fixtures/Polish.tsx (8 named cinema easing curves & dampedSettle)
 *
 * Re-implemented cleanly for VoxFigura Canvas 2D studio timeline & keyframe engine.
 */

export type EasingName =
  | 'linear'
  | 'snappy'
  | 'out'
  | 'smooth'
  | 'swift'
  | 'exit'
  | 'anticip'
  | 'overshoot';

export type EasingFn = (t: number) => number;

export const EASING_OPTIONS: ReadonlyArray<{ value: EasingName; label: string }> = [
  { value: 'linear', label: '线性 (Linear)' },
  { value: 'snappy', label: '干脆急停 (Snappy)' },
  { value: 'out', label: '舒缓落位 (Ease Out)' },
  { value: 'smooth', label: '平滑进出 (Smooth)' },
  { value: 'swift', label: '疾速起势 (Swift)' },
  { value: 'exit', label: '加速退场 (Exit)' },
  { value: 'anticip', label: '蓄力回拉 (Anticipate)' },
  { value: 'overshoot', label: '过冲回弹 (Overshoot)' },
];

export function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

export function mix(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

/**
 * Exact CSS cubic-bezier(x1, y1, x2, y2) solver via Newton-Raphson with bisection fallback.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EasingFn {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;

  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number) => ((ay * u + by) * u + cy) * u;
  const sampleDerivX = (u: number) => (3 * ax * u + 2 * bx) * u + cx;

  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let u = x;
    for (let i = 0; i < 6; i++) {
      const err = sampleX(u) - x;
      if (Math.abs(err) < 1e-6) return sampleY(u);
      const d = sampleDerivX(u);
      if (Math.abs(d) < 1e-6) break;
      u -= err / d;
    }
    let lo = 0;
    let hi = 1;
    u = x;
    for (let i = 0; i < 12; i++) {
      const val = sampleX(u);
      if (Math.abs(val - x) < 1e-6) break;
      if (x > val) lo = u;
      else hi = u;
      u = 0.5 * (lo + hi);
    }
    return sampleY(u);
  };
}

export const EASE: Readonly<Record<EasingName, EasingFn>> = {
  linear: (t) => clamp01(t),
  snappy: cubicBezier(0.16, 1, 0.3, 1),
  out: cubicBezier(0.22, 1, 0.36, 1),
  smooth: cubicBezier(0.42, 0, 0.2, 1),
  swift: cubicBezier(0.12, 0.9, 0.24, 1),
  exit: cubicBezier(0.55, 0, 0.85, 0.35),
  anticip: cubicBezier(0.45, -0.35, 0.3, 1.05),
  overshoot: cubicBezier(0.22, 1.28, 0.36, 1),
};

export function isEasingName(v: unknown): v is EasingName {
  return typeof v === 'string' && v in EASE;
}

export function resolveEasing(name?: string): EasingFn {
  return isEasingName(name) ? EASE[name] : EASE.linear;
}

export function ramp(t: number, start: number, end: number, ease: EasingName | EasingFn = 'linear'): number {
  if (end <= start) return t >= end ? 1 : 0;
  const u = clamp01((t - start) / (end - start));
  return typeof ease === 'function' ? ease(u) : resolveEasing(ease)(u);
}

/**
 * Exponentially damped sinusoidal settle from 0 -> 1 (or impact decay when inverted).
 */
export function dampedSettle(tSec: number, freqHz = 3.2, damping = 6.5): number {
  if (tSec <= 0) return 0;
  return 1 - Math.exp(-damping * tSec) * Math.cos(2 * Math.PI * freqHz * tSec);
}

/**
 * Exponentially decaying impact oscillation centered around 0 (peaks near t = 0).
 */
export function dampedImpact(tSec: number, freqHz = 11, damping = 12): number {
  if (tSec <= 0) return 0;
  return Math.exp(-damping * tSec) * Math.sin(2 * Math.PI * freqHz * tSec);
}

/**
 * Second-order underdamped/critically damped spring response from 0 -> 1.
 */
export function springAt(
  tSec: number,
  opts: { stiffness?: number; damping?: number; mass?: number } = {},
): number {
  if (tSec <= 0) return 0;
  const k = Math.max(1, opts.stiffness ?? 180);
  const c = Math.max(0.1, opts.damping ?? 20);
  const m = Math.max(0.1, opts.mass ?? 1);
  const wn = Math.sqrt(k / m);
  const zeta = c / (2 * Math.sqrt(k * m));
  if (zeta < 1) {
    const wd = wn * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * wn * tSec);
    return 1 - decay * (Math.cos(wd * tSec) + (zeta * wn / wd) * Math.sin(wd * tSec));
  }
  if (Math.abs(zeta - 1) < 1e-4) {
    return 1 - Math.exp(-wn * tSec) * (1 + wn * tSec);
  }
  const sq = Math.sqrt(zeta * zeta - 1);
  const r1 = -wn * (zeta - sq);
  const r2 = -wn * (zeta + sq);
  const c1 = r2 / (r2 - r1);
  const c2 = -r1 / (r2 - r1);
  return 1 - (c1 * Math.exp(r1 * tSec) + c2 * Math.exp(r2 * tSec));
}

export function velocityAt(fn: (t: number) => number, t: number, dt = 1 / 60): number {
  return (fn(t + dt) - fn(t - dt)) / (2 * dt);
}

/**
 * Deterministic 32-bit mulberry32 PRNG.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic multi-harmonic handheld camera drift (smooth, frame-index independent).
 */
export function handheld(
  tSec: number,
  opts: { ampPx?: number; rotDeg?: number; freq?: number; seed?: number } = {},
): { x: number; y: number; rotDeg: number } {
  const ampPx = opts.ampPx ?? 8;
  const rotDeg = opts.rotDeg ?? 0.45;
  const freq = opts.freq ?? 0.65;
  const seed = opts.seed ?? 17;
  const rng = mulberry32(seed);
  const p1 = rng() * Math.PI * 2;
  const p2 = rng() * Math.PI * 2;
  const p3 = rng() * Math.PI * 2;
  const p4 = rng() * Math.PI * 2;
  const w = 2 * Math.PI * freq;
  const x = ampPx * (0.62 * Math.sin(w * tSec + p1) + 0.38 * Math.sin(w * 2.13 * tSec + p2));
  const y = ampPx * (0.58 * Math.cos(w * 0.87 * tSec + p3) + 0.42 * Math.sin(w * 1.79 * tSec + p4));
  const rot = rotDeg * (0.65 * Math.sin(w * 0.71 * tSec + p2) + 0.35 * Math.cos(w * 1.53 * tSec + p1));
  return { x, y, rotDeg: rot };
}

export function parseKeyframeEasing(frame?: string): EasingName {
  if (!frame) return 'linear';
  try {
    const parsed = JSON.parse(frame) as { ease?: unknown };
    return isEasingName(parsed?.ease) ? parsed.ease : 'linear';
  } catch {
    return isEasingName(frame) ? frame : 'linear';
  }
}

export function encodeKeyframeEasing(ease: EasingName): string | undefined {
  return ease === 'linear' ? undefined : JSON.stringify({ ease });
}
