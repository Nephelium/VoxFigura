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

export interface M10RenderOptions {
  idPrefix: string;
  viewBox?: string;
  showGhost?: boolean;
  showLabels?: boolean;
  theme?: M27ThemeMode;
  nasal?: number;
  lm?: number[];
  surfPt?: Point2D | null;
  bladePt?: Point2D | null;
  ghosts?: Array<{ parts: TractPartsMap; age: number }>;
  transparentPanel?: boolean;
}

export interface M27CurvesBgCache {
  key: string;
  canvas: HTMLCanvasElement | null;
}

const M10_SVG_NS = 'http://www.w3.org/2000/svg';

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

function readCssColorVar(varName: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return val || fallback;
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

// ===========================================================================
// 1. M10 High-Definition Mid-Sagittal Vocal Tract SVG Renderer (Tract-Only)
// ===========================================================================

interface M10Palette {
  panel: string;
  legendBg: string;
  ink: string;
  handle: string;
  handleSoft: string;
  muted: string;
  line: string;
  wall: string;
  skinEdge: string;
  tongue: string;
  tongueFill: string;
  tongueEdge: string;
  lip: string;
  velum: string;
  epiglottisFill: string;
  tooth: string;
  toothEdge: string;
  guide: string;
}

function getM10Palette(theme: M27ThemeMode): M10Palette {
  if (theme === 'dark') {
    const panel = readCssColorVar('--panel', '#181b22');
    return {
      panel,
      legendBg: '#222733',
      ink: '#e4ebf5',
      handle: '#5eead4',
      handleSoft: '#79c9be',
      muted: '#9ba6b8',
      line: '#323947',
      wall: '#c79388',
      skinEdge: '#d4b3a3',
      tongue: '#e08691',
      tongueFill: '#3b242c',
      tongueEdge: '#f1a5ae',
      lip: '#e0828d',
      velum: '#d79ca2',
      epiglottisFill: '#7c655f',
      tooth: '#f1eadb',
      toothEdge: '#b8a78c',
      guide: '#5eead4',
    };
  }
  return {
    panel: '#fffef9',
    legendBg: '#f4f5ee',
    ink: '#27332f',
    handle: '#237768',
    handleSoft: '#76aa9f',
    muted: '#7f8a80',
    line: '#e5e7dd',
    wall: '#ab7467',
    skinEdge: '#b99987',
    tongue: '#cf7f86',
    tongueFill: '#f5e5e3',
    tongueEdge: '#a9545f',
    lip: '#c96f79',
    velum: '#d4969b',
    epiglottisFill: '#cbb0a3',
    tooth: '#fffaf0',
    toothEdge: '#b3a183',
    guide: '#3f8f80',
  };
}

function m10SvgEl(name: string, attrs: Record<string, string | number> = {}): SVGElement {
  const e = document.createElementNS(M10_SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function m10Path(pts: Point2D[] | undefined, close = false): string {
  if (!pts || !pts.length) return '';
  return 'M' + pts.map((p) => `${p[0].toFixed(3)},${(-p[1]).toFixed(3)}`).join('L') + (close ? 'Z' : '');
}

function m10Curve(pts: Point2D[] | undefined, close = false): string {
  if (!pts || pts.length < 3) return m10Path(pts, close);
  const at = (p: Point2D) => `${p[0].toFixed(3)},${(-p[1]).toFixed(3)}`;
  const mid = (a: Point2D, b: Point2D) => `${((a[0] + b[0]) * 0.5).toFixed(3)},${(-(a[1] + b[1]) * 0.5).toFixed(3)}`;
  const n = pts.length;
  if (close) {
    let d = 'M' + mid(pts[n - 1], pts[0]);
    for (let i = 0; i < n; i++) d += 'Q' + at(pts[i]) + ' ' + mid(pts[i], pts[(i + 1) % n]);
    return d + 'Z';
  }
  let d = 'M' + at(pts[0]) + 'L' + mid(pts[0], pts[1]);
  for (let i = 1; i < n - 1; i++) d += 'Q' + at(pts[i]) + ' ' + mid(pts[i], pts[i + 1]);
  return d + 'L' + at(pts[n - 1]);
}

function m10Rounded(pts: Point2D[] | undefined, close = true): Point2D[] {
  if (!pts || pts.length < 2) return pts || [];
  const last = pts[pts.length - 1];
  const open =
    close && pts.length > 1 && Math.hypot(pts[0][0] - last[0], pts[0][1] - last[1]) < 1e-5
      ? pts.slice(0, -1)
      : pts;
  const out: Point2D[] = [];
  const lim = open.length - (close ? 0 : 1);
  for (let i = 0; i < lim; i++) {
    const a = open[i];
    const b = open[(i + 1) % open.length];
    out.push(
      [0.78 * a[0] + 0.22 * b[0], 0.78 * a[1] + 0.22 * b[1]],
      [0.22 * a[0] + 0.78 * b[0], 0.22 * a[1] + 0.78 * b[1]],
    );
  }
  return close ? out : [open[0], ...out, open[open.length - 1]];
}

function m10CutCorners(pts: Point2D[]): Point2D[] {
  if (!pts || pts.length < 2) return pts || [];
  const out: Point2D[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    out.push(
      [0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]],
      [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]],
    );
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function m10Leaf(pts: Point2D[], base: number, tip: number): Point2D[] {
  if (!pts || pts.length < 2) return [];
  const left: Point2D[] = [];
  const right: Point2D[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const half = base + ((tip - base) * i) / (pts.length - 1);
    const nx = (-(b[1] - a[1]) / len) * half;
    const ny = ((b[0] - a[0]) / len) * half;
    left.push([p[0] + nx, p[1] + ny]);
    right.push([p[0] - nx, p[1] - ny]);
  }
  return [...left, ...right.reverse()];
}

interface M10LipsResult {
  upper: Point2D[];
  lower: Point2D[];
  edge: number;
  upperHandle?: Point2D;
  lowerHandle?: Point2D;
}

function m10BuildLips(c: TractPartsMap): M10LipsResult {
  const uRaw = c.upper_lip || [];
  const lRaw = c.lower_lip || [];
  if (uRaw.length < 5 || lRaw.length < 5) return { upper: uRaw, lower: lRaw, edge: 4 };
  const seam = 0.5 * (uRaw[4][1] + lRaw[4][1]);
  let up: Point2D[] = uRaw.slice(1).map((p) => [p[0], Math.max(p[1], seam)]);
  let lo: Point2D[] = lRaw.slice(1).map((p) => [p[0], Math.min(p[1], seam)]);
  for (let n = 0; n < 2; n++) {
    up = m10CutCorners(up);
    lo = m10CutCorners(lo);
  }
  const edge = Math.round((3 / Math.max(1, uRaw.length - 2)) * (up.length - 1));
  return {
    upper: up,
    lower: lo,
    edge,
    upperHandle: [uRaw[4][0], Math.max(uRaw[4][1], seam)],
    lowerHandle: [lRaw[4][0], Math.min(lRaw[4][1], seam)],
  };
}

interface M10VelumResult {
  profile: Point2D[];
  exposedProfile: Point2D[];
  root: Point2D;
  tip: Point2D;
  contact: Point2D;
  gap: number;
  wall: number;
}

function m10BuildVelum(c: TractPartsMap, nasalArea: number): M10VelumResult | null {
  const uc = c.upper_cover || [];
  const u = c.uvula || [];
  if (uc.length < 14 || u.length < 3) return null;
  const area = Math.max(0, nasalArea || 0);
  const free = uc[9];
  const root = uc[13];
  const tip = u[u.length - 1];
  const a7 = uc[7];
  const b8 = uc[8];
  const wallAt = (y: number) => a7[0] + ((y - a7[1]) * (b8[0] - a7[0])) / (b8[1] - a7[1] || 1);
  const wall = wallAt(free[1] + 0.65);
  const clearance = Math.max(0.001, u[0][0] - wall + 0.001);
  const gap = Math.min((2 * area) / (Math.PI * 1.6), clearance);
  const contact: Point2D = [wall + gap, free[1] + 0.65];

  const ant1: Point2D = [free[0] * 0.76 + tip[0] * 0.24 + 0.02, free[1] * 0.66 + tip[1] * 0.34];
  const ant2: Point2D = [free[0] * 0.40 + tip[0] * 0.60 + 0.01, free[1] * 0.28 + tip[1] * 0.72];
  const lower: Point2D[] = [...uc.slice(9, 14).slice().reverse(), ant1, ant2, tip];
  const back: Point2D[] = u.slice(0, -1).slice().reverse();
  const shoulder = back[back.length - 1];
  const joint: Point2D = [contact[0], Math.max(contact[1], shoulder[1] + 0.30)];
  const roof: Point2D[] = [];
  for (let i = 1; i <= 20; i++) {
    const first = i <= 6;
    const t = first ? i / 6 : (i - 6) / 14;
    const v = 1 - t;
    const pa: Point2D = first ? shoulder : joint;
    const pb: Point2D = first ? joint : [root[0], root[1] + 0.32];
    const rise = (joint[1] - shoulder[1]) / 3;
    const pc: Point2D = first ? [shoulder[0], shoulder[1] + rise] : [joint[0], joint[1] + 0.40];
    const pd: Point2D = first ? [joint[0], joint[1] - rise] : [root[0] - 0.65, root[1] + 0.48];
    roof.push([
      v * v * v * pa[0] + 3 * v * v * t * pc[0] + 3 * v * t * t * pd[0] + t * t * t * pb[0],
      v * v * v * pa[1] + 3 * v * v * t * pc[1] + 3 * v * t * t * pd[1] + t * t * t * pb[1],
    ]);
  }
  const profile = [...lower, ...back, ...roof];
  const exposedProfile = [...lower, ...back];
  return { profile, exposedProfile, root, tip, contact, gap, wall };
}

function m10InterpFloorY(floorSeg: Point2D[], x: number): number {
  if (!floorSeg.length) return -3.4;
  if (x <= floorSeg[0][0]) return floorSeg[0][1];
  for (let i = 1; i < floorSeg.length; i++) {
    const a = floorSeg[i - 1];
    const b = floorSeg[i];
    if (x <= b[0] + 1e-6) {
      const span = b[0] - a[0];
      if (Math.abs(span) < 1e-6) return Math.max(a[1], b[1]);
      const t = Math.max(0, Math.min(1, (x - a[0]) / span));
      return a[1] + t * (b[1] - a[1]);
    }
  }
  return floorSeg[floorSeg.length - 1][1];
}

interface M10TongueResult {
  dorsal: Point2D[];
  contour: Point2D[];
  outline: Point2D[];
  belly: Point2D;
  anchorPt: Point2D;
}

function m10BuildTongue(c: TractPartsMap, lm?: number[]): M10TongueResult {
  const tg = c.tongue || [];
  const lc = c.lower_cover || [];
  const lt = c.lower_teeth || [];
  const D = Math.min(34, tg.length);
  if (D < 6 || lc.length < 11) {
    return { dorsal: tg, contour: tg, outline: tg, belly: tg[0] || [0, -2], anchorPt: lc[10] || [1.7, -3.3] };
  }
  const dorsal = tg.slice(0, D);
  const anchor = 10;
  const b = lc[anchor];
  const a = dorsal[D - 1];
  const prev = dorsal[D - 2];
  const ttx = Number.isFinite(lm?.[2]) ? (lm as number[])[2] : a[0];
  const tty = Number.isFinite(lm?.[3]) ? (lm as number[])[3] : a[1];
  const tbx = Number.isFinite(lm?.[4]) ? (lm as number[])[4] : dorsal[Math.min(D - 1, 21)][0];
  const tby = Number.isFinite(lm?.[5]) ? (lm as number[])[5] : dorsal[Math.min(D - 1, 21)][1];
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const curl = clamp01((tbx - ttx) / 0.75) * clamp01((tty - tby) / 0.5);

  let front = -Infinity;
  for (let i = 0; i < D; i++) if (dorsal[i][0] > front) front = dorsal[i][0];
  const len = Math.hypot(a[0] - prev[0], a[1] - prev[1]) || 1;
  const cx0 = a[0] + 0.14;
  const dx0 = Math.max(b[0] + 0.12, front + 0.20);
  const ctrlC: Point2D = [
    cx0 + curl * (a[0] + (0.38 * (a[0] - prev[0])) / len - cx0),
    a[1] - 0.36 + curl * (0.36 + (0.38 * (a[1] - prev[1])) / len),
  ];
  const ctrlD: Point2D = [
    dx0 + curl * (Math.max(dx0, front + 0.45) - dx0),
    b[1] + 0.08,
  ];

  const floorSeg = lc.slice(8);
  let crownX = Infinity;
  let crownY = -Infinity;
  if (lt.length >= 4) {
    for (const tp of lt) {
      if (tp[0] < crownX) crownX = tp[0];
      if (tp[1] > crownY) crownY = tp[1];
    }
  }
  const hasTeeth = Number.isFinite(crownX) && Number.isFinite(crownY);
  const smoothstep = (e0: number, e1: number, x: number) => {
    const s = Math.max(0, Math.min(1, (x - e0) / Math.max(1e-6, e1 - e0)));
    return s * s * (3 - 2 * s);
  };
  const softMax = (v1: number, v2: number, k = 0.18) => 0.5 * (v1 + v2 + Math.hypot(v1 - v2, k));

  const ventral: Point2D[] = [a];
  const Q = 24;
  for (let r = 1; r <= Q; r++) {
    const t = r / Q;
    const u = 1 - t;
    const px = u * u * u * a[0] + 3 * u * u * t * ctrlC[0] + 3 * u * t * t * ctrlD[0] + t * t * t * b[0];
    let py = u * u * u * a[1] + 3 * u * u * t * ctrlC[1] + 3 * u * t * t * ctrlD[1] + t * t * t * b[1];
    const floorY = m10InterpFloorY(floorSeg, px);
    let minY = floorY;
    if (hasTeeth) {
      const sTooth = smoothstep(crownX - 0.42, crownX + 0.22, px);
      const lift = Math.max(0, crownY - floorY);
      minY = floorY + sTooth * lift;
    }
    const edgeWeight = Math.sin(Math.PI * t);
    const kSmooth = 0.20 * edgeWeight + 0.02;
    py = r === Q ? Math.max(b[1], floorY) : softMax(py, minY, kSmooth);
    ventral.push([px, py]);
  }
  if (ventral.length >= 4) {
    const orig: Point2D[] = ventral.map((pt) => [pt[0], pt[1]]);
    for (let r = 1; r < ventral.length - 1; r++) {
      const px = 0.25 * orig[r - 1][0] + 0.5 * orig[r][0] + 0.25 * orig[r + 1][0];
      const py = 0.25 * orig[r - 1][1] + 0.5 * orig[r][1] + 0.25 * orig[r + 1][1];
      const floorY = m10InterpFloorY(floorSeg, px);
      ventral[r][0] = px;
      ventral[r][1] = Math.max(py, floorY);
    }
  }
  const contour = [...dorsal.slice(0, D - 1), ...ventral];
  const outline = [...contour, ...lc.slice(4, anchor).slice().reverse()];
  const belly = ventral[Math.floor(ventral.length * 0.5)] || b;
  return { dorsal, contour, outline, belly, anchorPt: b };
}

function m10SampleXAtY(poly: Point2D[], y: number): number[] {
  const hits: number[] = [];
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    if ((y >= a[1] - 1e-6 && y <= b[1] + 1e-6) || (y >= b[1] - 1e-6 && y <= a[1] + 1e-6)) {
      const dy = b[1] - a[1];
      const t = Math.abs(dy) < 1e-6 ? 0.5 : (y - a[1]) / dy;
      if (t >= -0.01 && t <= 1.01) hits.push(a[0] + Math.max(0, Math.min(1, t)) * (b[0] - a[0]));
    }
  }
  return hits;
}

function m10SampleYAtX(poly: Point2D[], x: number): number[] {
  const hits: number[] = [];
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    if ((x >= a[0] - 1e-6 && x <= b[0] + 1e-6) || (x >= b[0] - 1e-6 && x <= a[0] + 1e-6)) {
      const dx = b[0] - a[0];
      const t = Math.abs(dx) < 1e-6 ? 0.5 : (x - a[0]) / dx;
      if (t >= -0.01 && t <= 1.01) hits.push(a[1] + Math.max(0, Math.min(1, t)) * (b[1] - a[1]));
    }
  }
  return hits;
}

function m10BuildAirwaySegments(
  c: TractPartsMap,
  tongue: M10TongueResult,
  velum: M10VelumResult | null,
  lips: M10LipsResult,
): Point2D[][] {
  const uc = c.upper_cover || [];
  const lc = c.lower_cover || [];
  const epi = c.epiglottis || [];
  if (uc.length < 18 || lc.length < 10) return [];
  const segs: Point2D[][] = [];
  let cur: Point2D[] = [];
  const flush = () => {
    if (cur.length > 1) segs.push(cur);
    cur = [];
  };

  const postWall = uc.slice(0, 9);
  const lowLarynx = lc.slice(0, 5);
  const pharTongue = tongue.dorsal.slice(0, 14);
  const yPharTop = velum ? Math.min(-0.85, velum.tip[1] - 0.12) : -0.90;
  for (let i = 0; i <= 20; i++) {
    const y = -8.65 + (i / 20) * (yPharTop - -8.65);
    const lefts = m10SampleXAtY(postWall, y);
    if (!lefts.length) continue;
    const xL = Math.min(...lefts);
    const rights = [
      ...m10SampleXAtY(lowLarynx, y),
      ...m10SampleXAtY(epi, y),
      ...m10SampleXAtY(pharTongue, y),
    ].filter((x) => x > xL - 0.1);
    if (!rights.length) continue;
    const xR = Math.min(...rights);
    if (xR - xL > 0.04) cur.push([0.5 * (xL + xR), y]);
    else flush();
  }

  const roofChain: Point2D[] = [
    ...(velum ? velum.exposedProfile.slice(0, 8).slice().reverse() : uc.slice(9, 14)),
    ...uc.slice(13),
    ...(c.upper_teeth ? c.upper_teeth.slice(0, 3) : []),
    ...lips.upper.slice(0, Math.min(lips.upper.length, lips.edge + 3)),
  ];
  const floorChain: Point2D[] = [
    ...tongue.dorsal,
    ...(c.lower_teeth ? c.lower_teeth.slice(1, 3) : []),
    ...lips.lower.slice(0, Math.min(lips.lower.length, lips.edge + 3)),
  ];
  const xOralStart = velum ? Math.max(-1.65, velum.tip[0] + 0.32) : -1.55;
  for (let i = 0; i <= 32; i++) {
    const x = xOralStart + (i / 32) * (6.75 - xOralStart);
    const tops = m10SampleYAtX(roofChain, x);
    const bots = m10SampleYAtX(floorChain, x);
    if (!tops.length || !bots.length) continue;
    const yT = Math.min(...tops);
    const yB = Math.max(...bots);
    if (yT - yB > 0.03) cur.push([x, 0.5 * (yT + yB)]);
    else flush();
  }
  flush();
  return segs;
}

function m10TextWidth(text: string, size: number): number {
  let sum = 0;
  for (const ch of String(text)) sum += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 1.0 : 0.56;
  return sum * size;
}

const M10_LABEL_STEPS: Record<string, Point2D> = {
  right: [1, 0],
  left: [-1, 0],
  up: [0, 1],
  down: [0, -1],
  upRight: [1, 1],
  upLeft: [-1, 1],
  downRight: [1, -1],
  downLeft: [-1, -1],
};

function m10PlaceLabel(
  boxes: Array<[number, number, number, number]>,
  p: Point2D,
  width: number,
  height: number,
  gap: number,
  prefer: string,
): [number, number, number, number] {
  let best: { box: [number, number, number, number]; overlap: number } | null = null;
  const order = [prefer, ...Object.keys(M10_LABEL_STEPS)];
  const seen = new Set<string>();
  for (const side of order) {
    if (!side || seen.has(side) || !M10_LABEL_STEPS[side]) continue;
    seen.add(side);
    const [dx, dy] = M10_LABEL_STEPS[side];
    const reach = dx && dy ? 0.62 : 1.0;
    const x = p[0] + dx * (gap * reach + width * 0.5);
    const y = p[1] + dy * (gap * reach + height * 0.5);
    const box: [number, number, number, number] = [x - width * 0.5, y - height * 0.5, x + width * 0.5, y + height * 0.5];
    let overlap = 0;
    for (const b of boxes) {
      overlap +=
        Math.max(0, Math.min(box[2], b[2]) - Math.max(box[0], b[0])) *
        Math.max(0, Math.min(box[3], b[3]) - Math.max(box[1], b[1]));
    }
    if (!best || overlap < best.overlap - 1e-9) best = { box, overlap };
    if (!overlap) break;
  }
  const chosen = best!.box;
  boxes.push(chosen);
  return chosen;
}

// ===========================================================================
// 2. Hyper-Realistic Superior Laryngoscopic & Coronal Cover-Body Atlas Canvas
// ===========================================================================

const M27_AIR_DOTS: Array<[number, number, number]> = (() => {
  let seed = 4219;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i < 190; i++) pts.push([rnd() * 2 - 1, rnd(), rnd()]);
  return pts;
})();

export function getM27GlottisVisHz(st: Pick<M27InterpolatedState, 'f0'> | null | undefined, vibMode: M27VibMode = 'strobe'): number {
  if (vibMode === 'realtime') {
    return st && st.f0 > 40 ? st.f0 : 120;
  }
  return st && st.f0 > 40 ? 2.2 + 3.2 * Math.min(1, (st.f0 - 60) / 340) : 2.8;
}

function setupHiDpiCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number; dpr: number } | null {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(200, Math.round(rect.width || canvas.clientWidth || 320));
  const h = Math.max(160, Math.round(rect.height || canvas.clientHeight || 260));
  const dpr = Math.min(2.25, window.devicePixelRatio || 1);
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h, dpr };
}

// ===========================================================================
// 3. 50 Hz 7-Track Physical & Glottal Curves Canvas (PR strictly 0..1600 Pa)
// ===========================================================================

interface CurveSeriesSpec {
  k?: keyof M27AnimLikeFrame | 'pr_pa';
  lmIdx?: number;
  label: string;
  col: string;
  min: number;
  max: number;
  unit: string;
  dec: number;
  fill?: string;
  dash?: number[];
}

interface CurveLaneSpec {
  title: string;
  zeroLine?: number;
  zeroRange?: [number, number];
  series: CurveSeriesSpec[];
}

function getCurveVal(obj: M27AnimLikeFrame | M27InterpolatedState | null | undefined, ser: CurveSeriesSpec): number {
  if (!obj) return ser.min;
  if (ser.lmIdx !== undefined) {
    const v = obj.lm?.[ser.lmIdx];
    return typeof v === 'number' && Number.isFinite(v) ? v : ser.min;
  }
  if (ser.k === 'pr_pa') {
    return readFramePrPa(obj);
  }
  if (ser.k) {
    const raw = (obj as unknown as Record<string, unknown>)[ser.k];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : ser.min;
  }
  return ser.min;
}

function getCurvesLanes(frames: M27AnimLikeFrame[], curveMode: M27CurveMode, isDark: boolean): CurveLaneSpec[] {
  let maxF0 = 320;
  for (let i = 0; i < frames.length; i++) {
    const f0 = frames[i].f0 ?? 0;
    if (f0 > maxF0) maxF0 = f0;
  }
  maxF0 = Math.min(600, Math.ceil(maxF0 / 40) * 40);

  const cTeal = isDark ? '#2dd4bf' : '#0f766e';
  const cBlue = isDark ? '#60a5fa' : '#1d63b8';
  const cViolet = isDark ? '#c084fc' : '#7c3aed';
  const cAmber = isDark ? '#fbbf24' : '#b45309';
  const cCrimson = isDark ? '#fb7185' : '#c93b4b';
  const cGreen = isDark ? '#4ade80' : '#15803d';
  const cSky = isDark ? '#38bdf8' : '#0369a1';
  const cPink = isDark ? '#f472b6' : '#be185d';
  const cIndigo = isDark ? '#a78bfa' : '#6d4aff';
  const cMint = isDark ? '#5eead4' : '#237768';
  const cOrange = isDark ? '#fb923c' : '#c2410c';
  const cRed = isDark ? '#f87171' : '#b91c1c';

  const tractLanes: CurveLaneSpec[] = [
    {
      title: '唇颌开合',
      series: [
        { k: 'ja', label: 'JA', col: cTeal, min: -7.0, max: 0.0, unit: '', dec: 2 },
        { k: 'ld', label: 'LD', col: cBlue, min: -0.5, max: 2.5, unit: '', dec: 2 },
        { k: 'lp', label: 'LP', col: cViolet, min: -1.0, max: 1.0, unit: '', dec: 2 },
      ],
    },
    {
      title: '舌体/舌叶',
      series: [
        { lmIdx: 0, label: 'TCX', col: cAmber, min: -2.5, max: 3.5, unit: '', dec: 2 },
        { lmIdx: 1, label: 'TCY', col: cCrimson, min: -3.0, max: 0.8, unit: '', dec: 2 },
        { lmIdx: 4, label: 'TBX', col: cGreen, min: -2.0, max: 5.0, unit: '', dec: 2 },
        { lmIdx: 5, label: 'TBY', col: cSky, min: -3.0, max: 4.5, unit: '', dec: 2 },
      ],
    },
    {
      title: '舌尖/舌根',
      series: [
        { lmIdx: 2, label: 'TTX', col: cPink, min: 1.5, max: 6.0, unit: '', dec: 2 },
        { lmIdx: 3, label: 'TTY', col: cIndigo, min: -3.0, max: 2.5, unit: '', dec: 2 },
        { lmIdx: 6, label: 'TRX', col: cMint, min: -4.0, max: 1.0, unit: '', dec: 2 },
        { lmIdx: 7, label: 'TRY', col: cOrange, min: -6.0, max: 0.0, unit: '', dec: 2 },
      ],
    },
  ];

  const glottisLanes: CurveLaneSpec[] = [
    {
      title: '声源激励',
      series: [
        { k: 'f0', label: 'F0', col: cAmber, min: 40, max: maxF0, unit: 'Hz', dec: 0 },
        {
          k: 'pr_pa',
          label: 'PR',
          col: cCrimson,
          min: 0,
          max: 1600,
          unit: 'Pa',
          dec: 0,
          fill: isDark ? 'rgba(251, 113, 133, 0.14)' : 'rgba(201, 59, 75, 0.10)',
        },
      ],
    },
    {
      title: '声门几何',
      zeroLine: 0.0,
      zeroRange: [-0.05, 0.30],
      series: [
        { k: 'xb', label: 'XB', col: cGreen, min: -0.05, max: 0.30, unit: '', dec: 3 },
        { k: 'xt', label: 'XT', col: cBlue, min: -0.05, max: 0.30, unit: '', dec: 3 },
        { k: 'ca', label: 'CA', col: cViolet, min: -0.05, max: 0.30, unit: '', dec: 3 },
      ],
    },
    {
      title: '声门动力',
      zeroLine: 0.0,
      zeroRange: [-1.0, 1.0],
      series: [
        { k: 'ra', label: 'RA', col: cPink, min: -1.0, max: 1.0, unit: '', dec: 2 },
        { k: 'lag', label: 'LAG', col: cSky, min: 0.0, max: 3.1416, unit: '', dec: 2 },
        { k: 'ps', label: 'PS', col: cTeal, min: -1.0, max: 1.0, unit: '', dec: 2 },
      ],
    },
    {
      title: '微扰/鼻音',
      series: [
        { k: 'fl', label: 'FL', col: cOrange, min: 0, max: 100, unit: '', dec: 0 },
        { k: 'shim', label: 'SHIM', col: cRed, min: 0, max: 100, unit: '', dec: 0 },
        { k: 'vo', label: 'VO', col: cMint, min: -0.1, max: 1.5, unit: '', dec: 2, dash: [4, 3] },
      ],
    },
  ];

  if (curveMode === 'tract') return tractLanes;
  if (curveMode === 'glottis') return glottisLanes;
  return [...tractLanes, ...glottisLanes];
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

export function drawM27CurvesCanvas(
  canvas: HTMLCanvasElement | null,
  anim: M27AnimLike | null,
  st: M27InterpolatedState | null,
  curveMode: M27CurveMode = 'all',
  theme: M27ThemeMode = 'light',
  bgCache?: M27CurvesBgCache,
): void {
  if (!canvas) return;
  const setup = setupHiDpiCanvas(canvas);
  if (!setup) return;
  const { ctx, w, h, dpr } = setup;

  const isDark = theme === 'dark';
  const sheetBg = isDark ? readCssColorVar('--panel', '#181b22') : '#fffef9';
  const laneBg = isDark ? '#1e222d' : '#f7f9f3';
  const laneBorder = isDark ? '#303746' : '#dce2d5';
  const titleCol = isDark ? '#9ca8ba' : '#5c6b63';
  const cursorCol = isDark ? 'rgba(94, 234, 212, 0.85)' : 'rgba(35, 119, 104, 0.82)';

  if (!anim || !anim.frames?.length || !st) {
    ctx.fillStyle = sheetBg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = titleCol;
    ctx.font = '11px "Segoe UI", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('等待 50 Hz 声道与声门轨迹...', w * 0.5, h * 0.5);
    return;
  }

  const frames = anim.frames;
  const dur = Math.max(0.02, anim.duration_sec || frames[frames.length - 1].t || 1);
  const lanes = getCurvesLanes(frames, curveMode, isDark);
  const lay = getCurvesLayout(w, h, lanes.length);

  const firstSig = `${frames[0]?.f0 ?? 0}:${readFramePrPa(frames[0])}:${frames[frames.length - 1]?.t ?? 0}`;
  const bgKey = `${theme}:${curveMode}:${w}x${h}:${dpr}:${frames.length}:${firstSig}`;

  if (!bgCache || bgCache.key !== bgKey || !bgCache.canvas) {
    const off = document.createElement('canvas');
    off.width = Math.round(w * dpr);
    off.height = Math.round(h * dpr);
    const octx = off.getContext('2d');
    if (octx) {
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx.fillStyle = sheetBg;
      octx.fillRect(0, 0, w, h);

      lanes.forEach((lane, li) => {
        const ly = lay.padT + li * (lay.laneH + lay.gap);
        const headerH = 15;
        const plotT = ly + headerH;
        const plotB = ly + lay.laneH - 3;
        const plotH = Math.max(10, plotB - plotT);

        octx.fillStyle = laneBg;
        octx.strokeStyle = laneBorder;
        octx.lineWidth = 1;
        octx.beginPath();
        octx.roundRect(lay.padL, ly, lay.plotW, lay.laneH, 6);
        octx.fill();
        octx.stroke();

        const mapX = (t: number) => lay.padL + 3 + (Math.min(dur, Math.max(0, t)) / dur) * (lay.plotW - 6);
        const mapY = (val: number, vmin: number, vmax: number) => {
          const u = Math.min(1, Math.max(0, (val - vmin) / Math.max(1e-6, vmax - vmin)));
          return plotB - u * plotH;
        };

        if (lane.zeroLine !== undefined && lane.zeroRange) {
          const zy = mapY(lane.zeroLine, lane.zeroRange[0], lane.zeroRange[1]);
          octx.save();
          octx.setLineDash([3, 3]);
          octx.strokeStyle = isDark ? 'rgba(156, 168, 186, 0.28)' : 'rgba(105, 119, 111, 0.30)';
          octx.lineWidth = 0.85;
          octx.beginPath();
          octx.moveTo(lay.padL + 3, zy);
          octx.lineTo(lay.padL + lay.plotW - 3, zy);
          octx.stroke();
          octx.restore();
        }

        lane.series.forEach((ser) => {
          if (ser.fill) {
            octx.save();
            octx.beginPath();
            frames.forEach((f, i) => {
              const x = mapX(f.t);
              const y = mapY(getCurveVal(f, ser), ser.min, ser.max);
              if (i === 0) octx.moveTo(x, plotB);
              octx.lineTo(x, y);
            });
            octx.lineTo(mapX(frames[frames.length - 1].t), plotB);
            octx.closePath();
            octx.fillStyle = ser.fill;
            octx.fill();
            octx.restore();
          }

          octx.save();
          if (ser.dash) octx.setLineDash(ser.dash);
          octx.strokeStyle = ser.col;
          octx.lineWidth = 1.45;
          octx.beginPath();
          frames.forEach((f, i) => {
            const x = mapX(f.t);
            const y = mapY(getCurveVal(f, ser), ser.min, ser.max);
            if (i === 0) octx.moveTo(x, y);
            else octx.lineTo(x, y);
          });
          octx.stroke();
          octx.restore();
        });
      });
    }
    if (bgCache) {
      bgCache.key = bgKey;
      bgCache.canvas = off;
    } else {
      ctx.drawImage(off, 0, 0, w, h);
    }
  }

  if (bgCache?.canvas) {
    ctx.drawImage(bgCache.canvas, 0, 0, w, h);
  }

  const px = lay.padL + 3 + (Math.min(dur, Math.max(0, st.t)) / dur) * (lay.plotW - 6);

  lanes.forEach((lane, li) => {
    const ly = lay.padT + li * (lay.laneH + lay.gap);
    const headerH = 15;
    const plotT = ly + headerH;
    const plotB = ly + lay.laneH - 3;
    const plotH = Math.max(10, plotB - plotT);

    ctx.save();
    ctx.strokeStyle = cursorCol;
    ctx.lineWidth = 1.35;
    ctx.beginPath();
    ctx.moveTo(px, ly + 2);
    ctx.lineTo(px, ly + lay.laneH - 2);
    ctx.stroke();
    ctx.restore();

    let lx = lay.padL + 7;
    ctx.font = '600 9.5px "Segoe UI", "PingFang SC", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = titleCol;
    ctx.fillText(lane.title, lx, ly + 8);
    lx += ctx.measureText(lane.title).width + 10;

    ctx.font = '600 9.5px "JetBrains Mono", Consolas, monospace';
    lane.series.forEach((ser) => {
      const val = getCurveVal(st, ser);
      const u = Math.min(1, Math.max(0, (val - ser.min) / Math.max(1e-6, ser.max - ser.min)));
      const cy = plotB - u * plotH;

      ctx.fillStyle = ser.col;
      ctx.beginPath();
      ctx.arc(px, cy, 2.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = sheetBg;
      ctx.lineWidth = 1.1;
      ctx.stroke();

      const txt = `${ser.label} ${val.toFixed(ser.dec)}${ser.unit ? ' ' + ser.unit : ''}`;
      ctx.fillStyle = ser.col;
      ctx.fillText(txt, lx, ly + 8);
      lx += ctx.measureText(txt).width + 10;
    });
  });
}
