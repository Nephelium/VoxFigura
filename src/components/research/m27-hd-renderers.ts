/**
 * High-Definition M10 Mid-Sagittal Tract, M27 Hyper-Realistic Laryngoscopic / Coronal
 * Vocal Fold Medical Atlas & 50 Hz 7-Track Parameter Curve Renderers.
 *
 * Adapted 1:1 from the TensorTract3 M27 training dashboard visualizers with:
 * - Seamless Codex Light & Dark dual-theme palette support
 * - Per-instance unique SVG clipPath/gradient `idPrefix` (zero cross-SVG ID collisions)
 * - Strict Pa pressure units (`0..1600 Pa`, auto-normalizing raw engine fields safely)
 */

export type M27ThemeMode = 'light' | 'dark';
export type M27VibMode = 'strobe' | 'realtime';
export type M27CurveMode = 'all' | 'tract' | 'glottis';
export type Point2D = [number, number];
export type TractPartsMap = Record<string, Point2D[]>;

export interface M27AnimLikeFrame {
  t: number;
  pts: number[];
  nasal?: number;
  ja?: number;
  lp?: number;
  ld?: number;
  vo?: number;
  lm?: number[];
  srib?: number;
  brib?: number;
  frib?: number;
  f0?: number;
  pr_pa?: number;
  pr?: number;
  xb?: number;
  xt?: number;
  ca?: number;
  lag?: number;
  ra?: number;
  ps?: number;
  fl?: number;
  shim?: number;
  voiced?: number;
}

export interface M27AnimLike {
  schema?: string;
  fps?: number;
  duration_sec?: number;
  frame_count?: number;
  bounds?: { xmin: number; xmax: number; ymin: number; ymax: number };
  parts: string[];
  part_sizes: number[];
  frames: M27AnimLikeFrame[];
  _cumFlowSub?: Float64Array;
  _cumFlowJet?: Float64Array;
}

export interface M27InterpolatedState {
  t: number;
  dur: number;
  idx: number;
  flowSub: number;
  flowJet: number;
  parts: TractPartsMap;
  ghosts: Array<{ parts: TractPartsMap; age: number }>;
  lm: number[];
  surfPt: Point2D | null;
  bladePt: Point2D | null;
  frib: number;
  f0: number;
  pr_pa: number;
  xb: number;
  xt: number;
  ca: number;
  lag: number;
  ra: number;
  ps: number;
  fl: number;
  shim: number;
  vo: number;
  nasal: number;
  ja: number;
  lp: number;
  ld: number;
  voiced: boolean;
}

export interface M27CurvesBgCache {
  key: string;
  canvas: HTMLCanvasElement | null;
}

/** Normalize pressure strictly to Pa (`0..1600 Pa`), safely handling either `pr_pa` or native `pr` (tenths of Pa). */
export function readFramePrPa(frame: { pr_pa?: number; pr?: number } | null | undefined): number {
  if (!frame) return 0;
  if (typeof frame.pr_pa === 'number' && Number.isFinite(frame.pr_pa)) {
    return Math.max(0, frame.pr_pa);
  }
  if (typeof frame.pr === 'number' && Number.isFinite(frame.pr)) {
    return Math.max(0, frame.pr / 10);
  }
  return 0;
}

export function splitM27TractParts(
  flatPts: number[] | undefined,
  parts: string[] | undefined,
  partSizes: number[] | undefined,
): TractPartsMap {
  const out: TractPartsMap = {};
  if (!Array.isArray(flatPts) || !Array.isArray(parts) || !Array.isArray(partSizes)) return out;
  let off = 0;
  for (let p = 0; p < parts.length; p++) {
    const n = partSizes[p] || 0;
    const arr: Point2D[] = [];
    for (let i = 0; i < n; i++) {
      const x = flatPts[off++];
      const y = flatPts[off++];
      if (Number.isFinite(x) && Number.isFinite(y)) {
        arr.push([x, y]);
      }
    }
    out[parts[p]] = arr;
  }
  return out;
}

export function interpM27AnimState(anim: M27AnimLike | null | undefined, timeSec: number): M27InterpolatedState | null {
  const frames = anim?.frames || [];
  if (!frames.length || !anim) return null;
  const dur = Math.max(0.02, anim.duration_sec || frames[frames.length - 1].t || 1);
  const t = Math.min(dur, Math.max(0, timeSec));
  const fps = anim.fps || 25;
  let idx = Math.floor(t * fps);
  if (idx < 0) idx = 0;
  if (idx >= frames.length) idx = frames.length - 1;
  while (idx > 0 && frames[idx].t > t) idx--;
  while (idx + 1 < frames.length && frames[idx + 1].t <= t) idx++;

  const f0 = frames[idx];
  const f1 = frames[Math.min(frames.length - 1, idx + 1)];
  const span = f1.t - f0.t;
  const alpha = span > 1e-6 ? Math.min(1, Math.max(0, (t - f0.t) / span)) : 0;

  const pts = new Array<number>(f0.pts.length);
  for (let i = 0; i < pts.length; i++) {
    const a = f0.pts[i] ?? 0;
    const b = f1.pts[i] ?? a;
    pts[i] = a + (b - a) * alpha;
  }
  const lm0 = f0.lm || [];
  const lm1 = f1.lm || [];
  const lm = lm0.map((v, i) => v + ((lm1[i] ?? v) - v) * alpha);

  const sampleRib = (flat: number[], station: number): Point2D | null => {
    const pObj = splitM27TractParts(flat, anim.parts, anim.part_sizes);
    const tg = pObj.tongue || [];
    if (!tg.length) return null;
    const rib = Math.max(0, Math.min(Math.min(32, tg.length - 1), Number.isFinite(station) ? station : 16));
    const lo = Math.floor(rib);
    const hi = Math.min(tg.length - 1, Math.ceil(rib));
    const fr = rib - lo;
    return [
      tg[lo][0] * (1 - fr) + tg[hi][0] * fr,
      tg[lo][1] * (1 - fr) + tg[hi][1] * fr,
    ];
  };
  const lerpPt = (a: Point2D | null, b: Point2D | null): Point2D | null =>
    a && b ? [a[0] + (b[0] - a[0]) * alpha, a[1] + (b[1] - a[1]) * alpha] : a || b;

  const surfPt = lerpPt(sampleRib(f0.pts, f0.srib ?? 16), sampleRib(f1.pts, f1.srib ?? 16));
  const bladePt = lerpPt(sampleRib(f0.pts, f0.brib ?? 21), sampleRib(f1.pts, f1.brib ?? 21));

  const lerpNum = (k: keyof M27AnimLikeFrame, def = 0): number => {
    const va = f0[k];
    const vb = f1[k];
    const a = typeof va === 'number' && Number.isFinite(va) ? va : def;
    const b = typeof vb === 'number' && Number.isFinite(vb) ? vb : a;
    return a + (b - a) * alpha;
  };

  if (!anim._cumFlowSub || anim._cumFlowSub.length !== frames.length) {
    const cumSub = new Float64Array(frames.length);
    const cumJet = new Float64Array(frames.length);
    for (let i = 1; i < frames.length; i++) {
      const dt = Math.max(0, (frames[i].t || 0) - (frames[i - 1].t || 0));
      const p0 = Math.min(1, Math.max(0, readFramePrPa(frames[i - 1]) / 1600));
      const p1 = Math.min(1, Math.max(0, readFramePrPa(frames[i]) / 1600));
      const pm = 0.5 * (p0 + p1);
      cumSub[i] = cumSub[i - 1] + dt * (0.08 + 0.72 * pm);
      cumJet[i] = cumJet[i - 1] + dt * (0.16 + 1.65 * Math.pow(pm, 0.85));
    }
    anim._cumFlowSub = cumSub;
    anim._cumFlowJet = cumJet;
  }

  const idxNext = Math.min(frames.length - 1, idx + 1);
  const flowSub = anim._cumFlowSub[idx] + (anim._cumFlowSub[idxNext] - anim._cumFlowSub[idx]) * alpha;
  const flowJet = (anim._cumFlowJet?.[idx] ?? 0) + ((anim._cumFlowJet?.[idxNext] ?? 0) - (anim._cumFlowJet?.[idx] ?? 0)) * alpha;

  const ghosts: Array<{ parts: TractPartsMap; age: number }> = [];
  for (let g = 3; g >= 1; g--) {
    const gi = idx - g;
    if (gi >= 0) {
      ghosts.push({ parts: splitM27TractParts(frames[gi].pts, anim.parts, anim.part_sizes), age: g });
    }
  }

  const pr0 = readFramePrPa(f0);
  const pr1 = readFramePrPa(f1);

  return {
    t,
    dur,
    idx,
    flowSub,
    flowJet,
    parts: splitM27TractParts(pts, anim.parts, anim.part_sizes),
    ghosts,
    lm,
    surfPt,
    bladePt,
    frib: typeof f0.frib === 'number' && Number.isFinite(f0.frib) ? f0.frib : 10,
    f0: lerpNum('f0', 120),
    pr_pa: pr0 + (pr1 - pr0) * alpha,
    xb: lerpNum('xb', 0),
    xt: lerpNum('xt', 0),
    ca: lerpNum('ca', 0),
    lag: lerpNum('lag', 1.22),
    ra: lerpNum('ra', 0),
    ps: lerpNum('ps', 0),
    fl: lerpNum('fl', 0),
    shim: lerpNum('shim', 0),
    vo: lerpNum('vo', 0),
    nasal: lerpNum('nasal', 0),
    ja: lerpNum('ja', 0),
    lp: lerpNum('lp', 0),
    ld: lerpNum('ld', 0),
    voiced: ((alpha < 0.5 ? f0.voiced : f1.voiced) ?? 0) > 0,
  };
}

export function getM27GlottisVisHz(st: Pick<M27InterpolatedState, 'f0'> | null | undefined, vibMode: M27VibMode = 'strobe'): number {
  if (vibMode === 'realtime') {
    return st && st.f0 > 40 ? st.f0 : 120;
  }
  return st && st.f0 > 40 ? 2.2 + 3.2 * Math.min(1, (st.f0 - 60) / 340) : 2.8;
}

export function getCurvesLayout(w: number, h: number, nLanes = 7): {
  padL: number;
  plotW: number;
  padT: number;
  gap: number;
  laneH: number;
} {
  const padL = 8;
  const padR = 8;
  const padT = 5;
  const padB = 5;
  const gap = 4;
  const n = Math.max(1, nLanes);
  const laneH = (h - padT - padB - gap * (n - 1)) / n;
  return { padL, plotW: Math.max(40, w - padL - padR), padT, gap, laneH };
}
