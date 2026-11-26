/* ============================================================================
 * M27TractRenderer — Pure Stateless Canvas & SVG Renderers
 * ----------------------------------------------------------------------------
 * Includes:
 *   - interpM27AnimState (monotonic cumulative flow integrals + rib tracking)
 *   - renderM27TractSvg  (M10 mid-sagittal vocal tract w/ smoothed ventral tongue)
 *   - drawM27GlottisCanvas (hyper-realistic superior laryngoscopic + coronal Cover-Body)
 *   - drawM27CurvesCanvas  (theme-aware 7-lane articulatory & glottal kinematics)
 *
 * Zero global DOM queries or hardcoded IDs; safe for multiple instances per page.
 * ============================================================================ */

// ES module adapter. The workbench API sends pressure in Pa.
import { faceProfile, profileLandmarks } from '../../../packages/vocal-tract-view/face-model.mjs';
import { oralSectionBoundary } from '../../../packages/vocal-tract-view/geometry.mjs';
import registeredHead from './registered-head.json';

  const M10_SVG_NS = "http://www.w3.org/2000/svg";
  const M10_PALETTE = {
    panel: "#fffef9",
    ink: "#27332f",
    handle: "#237768",
    handleSoft: "#76aa9f",
    muted: "#8a9489",
    line: "#e5e7dd",
    wall: "#ab7467",
    skinEdge: "#b99987",
    tongue: "#cf7f86",
    tongueFill: "#f5e5e3",
    tongueEdge: "#a9545f",
    lip: "#c96f79",
    velum: "#d4969b",
    epiglottisFill: "#cbb0a3",
    tooth: "#fffaf0",
    toothEdge: "#b3a183",
    guide: "#3f8f80",
  };

  let _svgUidCounter = 0;
  const HEAD_MARKS = profileLandmarks(registeredHead.outline);
  const NASAL_REFERENCE_CUT = registeredHead.nasal.map(path => m10Path(path, true)).join(' ');
  const rootAnatomy = () => getComputedStyle(document.documentElement);
  const SVG_TISSUE_TOKENS = {
    wall:'wall', skinEdge:'skin-edge', tongue:'tongue', tongueFill:'tongue-fill', tongueEdge:'tongue-edge',
    lip:'lip', velum:'velum', epiglottisFill:'epiglottis', tooth:'tooth', toothEdge:'tooth-edge',
  };

  function readThemePalette(el) {
    const cs = el ? getComputedStyle(el) : null;
    const get = (name, fallback) => {
      if (!cs) return fallback;
      const v = cs.getPropertyValue(name).trim();
      return v || fallback;
    };
    return {
      anatomyBg: get("--anatomy-bg", get("--ts-anatomy-bg", "#fffef9")),
      anatomyMuted: get("--ts-anatomy-muted", "#69776f"),
      anatomyDivider: get("--ts-anatomy-divider", "#dde2d6"),
      curvesBg: get("--ts-curves-bg", "#fffef9"),
      laneBg: get("--ts-lane-bg", "#f7f9f3"),
      laneBorder: get("--ts-lane-border", "#dce2d5"),
      laneTitle: get("--ts-lane-title", "#5c6b63"),
      zeroLine: get("--ts-zero-line", "rgba(105, 119, 111, 0.30)"),
      playhead: get("--ts-playhead", "rgba(31, 122, 104, 0.78)"),
      dotStroke: get("--ts-dot-stroke", "#fffef9"),
    };
  }

  function setupVizCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(200, Math.round(rect.width || canvas.clientWidth || 320));
    const h = Math.max(200, Math.round(rect.height || canvas.clientHeight || 300));
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function drawVizEmpty(el, msg, theme) {
    if (!el) return;
    const pal = theme || {};
    if (el.tagName && el.tagName.toLowerCase() === "svg") {
      el.setAttribute("viewBox", "-5.85 -3.05 15.15 12.35");
      const bg = pal.anatomyBg || "#fffef9";
      const fg = pal.anatomyMuted || "#7a877f";
      el.innerHTML = `<rect x="-5.85" y="-3.05" width="15.15" height="12.35" fill="${bg}"/><text x="1.72" y="3.12" fill="${fg}" font-size="0.38" text-anchor="middle" dominant-baseline="middle">${msg}</text>`;
      return;
    }
    const isCurve = el.classList && el.classList.contains("ts-curves-canvas");
    const { ctx, w, h } = setupVizCanvas(el);
    ctx.fillStyle = isCurve ? (pal.curvesBg || "#fffef9") : (pal.anatomyBg || "#fffef9");
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = isCurve ? (pal.laneTitle || "#7a877f") : (pal.anatomyMuted || "#7a877f");
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(msg, w * 0.5, h * 0.5);
  }

  function splitM27TractParts(flatPts, parts, partSizes) {
    const out = {};
    if (!Array.isArray(flatPts) || !Array.isArray(parts) || !Array.isArray(partSizes)) return out;
    let off = 0;
    for (let p = 0; p < parts.length; p++) {
      const n = partSizes[p] || 0;
      const arr = [];
      for (let i = 0; i < n; i++) {
        arr.push([flatPts[off++], flatPts[off++]]);
      }
      out[parts[p]] = arr;
    }
    return out;
  }

  function interpM27AnimState(anim, timeSec) {
    const frames = anim?.frames || [];
    if (!frames.length) return null;
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

    const pts = new Array(f0.pts.length);
    for (let i = 0; i < pts.length; i++) {
      pts[i] = f0.pts[i] + (f1.pts[i] - f0.pts[i]) * alpha;
    }
    const lm0 = f0.lm || [];
    const lm1 = f1.lm || [];
    const lm = lm0.map((v, i) => v + ((lm1[i] ?? v) - v) * alpha);

    const sampleRib = (flat, station) => {
      const pObj = splitM27TractParts(flat, anim.parts, anim.part_sizes);
      const tg = pObj.tongue || [];
      if (!tg.length) return null;
      const rib = Math.max(0, Math.min(Math.min(32, tg.length - 1), Number.isFinite(station) ? station : 16));
      const lo = Math.floor(rib), hi = Math.min(tg.length - 1, Math.ceil(rib)), fr = rib - lo;
      return [
        tg[lo][0] * (1 - fr) + tg[hi][0] * fr,
        tg[lo][1] * (1 - fr) + tg[hi][1] * fr,
      ];
    };
    const lerpPt = (a, b) => (a && b ? [a[0] + (b[0] - a[0]) * alpha, a[1] + (b[1] - a[1]) * alpha] : (a || b));
    const surfPt = lerpPt(sampleRib(f0.pts, f0.srib ?? 16), sampleRib(f1.pts, f1.srib ?? 16));
    const bladePt = lerpPt(sampleRib(f0.pts, f0.brib ?? 21), sampleRib(f1.pts, f1.brib ?? 21));

    const lerpNum = (k, def = 0) => {
      const a = Number.isFinite(f0[k]) ? f0[k] : def;
      const b = Number.isFinite(f1[k]) ? f1[k] : a;
      return a + (b - a) * alpha;
    };
    if (!anim._cumFlowSub || anim._cumFlowSub.length !== frames.length) {
      const cumSub = new Float64Array(frames.length);
      const cumJet = new Float64Array(frames.length);
      for (let i = 1; i < frames.length; i++) {
        const dt = Math.max(0, (frames[i].t || 0) - (frames[i - 1].t || 0));
        const p0 = Math.min(1, Math.max(0, (frames[i - 1].pr_pa || 0) / 1600));
        const p1 = Math.min(1, Math.max(0, (frames[i].pr_pa || 0) / 1600));
        const pm = 0.5 * (p0 + p1);
        cumSub[i] = cumSub[i - 1] + dt * (0.08 + 0.72 * pm);
        cumJet[i] = cumJet[i - 1] + dt * (0.16 + 1.65 * Math.pow(pm, 0.85));
      }
      anim._cumFlowSub = cumSub;
      anim._cumFlowJet = cumJet;
    }
    const idxNext = Math.min(frames.length - 1, idx + 1);
    const flowSub = anim._cumFlowSub[idx] + (anim._cumFlowSub[idxNext] - anim._cumFlowSub[idx]) * alpha;
    const flowJet = anim._cumFlowJet[idx] + (anim._cumFlowJet[idxNext] - anim._cumFlowJet[idx]) * alpha;

    const ghosts = [];
    for (let g = 3; g >= 1; g--) {
      const gi = idx - g;
      if (gi >= 0) {
        ghosts.push({ parts: splitM27TractParts(frames[gi].pts, anim.parts, anim.part_sizes), age: g });
      }
    }
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
      frib: Number.isFinite(f0.frib) ? f0.frib : 10,
      f0: lerpNum("f0", 120),
      pr_pa: lerpNum("pr_pa", 0),
      xb: lerpNum("xb", 0),
      xt: lerpNum("xt", 0),
      ca: lerpNum("ca", 0),
      lag: lerpNum("lag", 1.22),
      ra: lerpNum("ra", 0),
      ps: lerpNum("ps", 0),
      fl: lerpNum("fl", 0),
      shim: lerpNum("shim", 0),
      vo: lerpNum("vo", 0),
      nasal: lerpNum("nasal", 0),
      ja: lerpNum("ja", 0),
      jx: lerpNum("jx", 0),
      lp: lerpNum("lp", 0),
      ld: lerpNum("ld", 0),
      voiced: (alpha < 0.5 ? f0.voiced : f1.voiced) > 0,
    };
  }

  // --------------------------------------------------------------------------
  // Exact M10 2-D Mid-Sagittal Vocal Tract SVG Renderer
  // --------------------------------------------------------------------------
  function m10SvgEl(name, attrs = {}) {
    const e = document.createElementNS(M10_SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  }

  function m10Path(pts, close = false) {
    if (!pts || !pts.length) return "";
    return "M" + pts.map(p => p[0].toFixed(3) + "," + (-p[1]).toFixed(3)).join("L") + (close ? "Z" : "");
  }

  function m10Curve(pts, close = false) {
    if (!pts || pts.length < 3) return m10Path(pts, close);
    const at = p => p[0].toFixed(3) + "," + (-p[1]).toFixed(3);
    const mid = (a, b) => ((a[0] + b[0]) * 0.5).toFixed(3) + "," + (-(a[1] + b[1]) * 0.5).toFixed(3);
    const n = pts.length;
    if (close) {
      let d = "M" + mid(pts[n - 1], pts[0]);
      for (let i = 0; i < n; i++) d += "Q" + at(pts[i]) + " " + mid(pts[i], pts[(i + 1) % n]);
      return d + "Z";
    }
    let d = "M" + at(pts[0]) + "L" + mid(pts[0], pts[1]);
    for (let i = 1; i < n - 1; i++) d += "Q" + at(pts[i]) + " " + mid(pts[i], pts[i + 1]);
    return d + "L" + at(pts[n - 1]);
  }

  function m10Rounded(pts, close = true) {
    if (!pts || pts.length < 2) return pts || [];
    const last = pts[pts.length - 1];
    const open = close && pts.length > 1 && Math.hypot(pts[0][0] - last[0], pts[0][1] - last[1]) < 1e-5
      ? pts.slice(0, -1)
      : pts;
    const out = [];
    const lim = open.length - (close ? 0 : 1);
    for (let i = 0; i < lim; i++) {
      const a = open[i], b = open[(i + 1) % open.length];
      out.push(
        [0.78 * a[0] + 0.22 * b[0], 0.78 * a[1] + 0.22 * b[1]],
        [0.22 * a[0] + 0.78 * b[0], 0.22 * a[1] + 0.78 * b[1]]
      );
    }
    return close ? out : [open[0], ...out, open[open.length - 1]];
  }

  function m10CutCorners(pts) {
    if (!pts || pts.length < 2) return pts || [];
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      out.push(
        [0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]],
        [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]
      );
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  function m10Leaf(pts, base, tip) {
    if (!pts || pts.length < 2) return [];
    const left = [], right = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const half = base + (tip - base) * i / (pts.length - 1);
      const nx = -(b[1] - a[1]) / len * half;
      const ny = (b[0] - a[0]) / len * half;
      left.push([p[0] + nx, p[1] + ny]);
      right.push([p[0] - nx, p[1] - ny]);
    }
    return [...left, ...right.reverse()];
  }

  function m10BuildLips(c) {
    const uRaw = c.upper_lip || [], lRaw = c.lower_lip || [];
    if (uRaw.length < 5 || lRaw.length < 5) return { upper: uRaw, lower: lRaw, edge: 4 };
    const seam = 0.5 * (uRaw[4][1] + lRaw[4][1]);
    let up = uRaw.slice(1).map(p => [p[0], Math.max(p[1], seam)]);
    let lo = lRaw.slice(1).map(p => [p[0], Math.min(p[1], seam)]);
    for (let n = 0; n < 2; n++) {
      up = m10CutCorners(up);
      lo = m10CutCorners(lo);
    }
    const edge = Math.round(3 / Math.max(1, uRaw.length - 2) * (up.length - 1));
    return {
      upper: up,
      lower: lo,
      edge,
      upperHandle: [uRaw[4][0], Math.max(uRaw[4][1], seam)],
      lowerHandle: [lRaw[4][0], Math.min(lRaw[4][1], seam)],
    };
  }

  function m10BuildVelum(c, nasalArea) {
    const uc = c.upper_cover || [], u = c.uvula || [];
    if (uc.length < 14 || u.length < 3) return null;
    const area = Math.max(0, nasalArea || 0);
    const free = uc[9], root = uc[13], tip = u[u.length - 1];
    const a7 = uc[7], b8 = uc[8];
    const wallAt = y => a7[0] + (y - a7[1]) * (b8[0] - a7[0]) / ((b8[1] - a7[1]) || 1);
    const wall = wallAt(free[1] + 0.65);
    const clearance = Math.max(0.001, u[0][0] - wall + 0.001);
    const gap = Math.min(2 * area / (Math.PI * 1.6), clearance);
    const contact = [wall + gap, free[1] + 0.65];

    const ant1 = [free[0] * 0.76 + tip[0] * 0.24 + 0.02, free[1] * 0.66 + tip[1] * 0.34];
    const ant2 = [free[0] * 0.40 + tip[0] * 0.60 + 0.01, free[1] * 0.28 + tip[1] * 0.72];
    const lower = [...uc.slice(9, 14).slice().reverse(), ant1, ant2, tip];
    const back = u.slice(0, -1).slice().reverse();
    const shoulder = back[back.length - 1];
    const joint = [contact[0], Math.max(contact[1], shoulder[1] + 0.30)];
    const roof = [];
    for (let i = 1; i <= 20; i++) {
      const first = i <= 6;
      const t = first ? i / 6 : (i - 6) / 14;
      const v = 1 - t;
      const pa = first ? shoulder : joint;
      const pb = first ? joint : [root[0], root[1] + 0.32];
      const rise = (joint[1] - shoulder[1]) / 3;
      const pc = first ? [shoulder[0], shoulder[1] + rise] : [joint[0], joint[1] + 0.40];
      const pd = first ? [joint[0], joint[1] - rise] : [root[0] - 0.65, root[1] + 0.48];
      roof.push([
        v * v * v * pa[0] + 3 * v * v * t * pc[0] + 3 * v * t * t * pd[0] + t * t * t * pb[0],
        v * v * v * pa[1] + 3 * v * v * t * pc[1] + 3 * v * t * t * pd[1] + t * t * t * pb[1],
      ]);
    }
    const profile = [...lower, ...back, ...roof];
    const exposedProfile = [...lower, ...back];
    return { profile, exposedProfile, root, tip, contact, gap, wall };
  }

  function m10InterpFloorY(floorSeg, x) {
    if (!floorSeg.length) return -3.4;
    if (x <= floorSeg[0][0]) return floorSeg[0][1];
    for (let i = 1; i < floorSeg.length; i++) {
      const a = floorSeg[i - 1], b = floorSeg[i];
      if (x <= b[0] + 1e-6) {
        const span = b[0] - a[0];
        if (Math.abs(span) < 1e-6) return Math.max(a[1], b[1]);
        const t = Math.max(0, Math.min(1, (x - a[0]) / span));
        return a[1] + t * (b[1] - a[1]);
      }
    }
    return floorSeg[floorSeg.length - 1][1];
  }

  function m10BuildTongue(c, lm) {
    const tg = c.tongue || [], lc = c.lower_cover || [], lt = c.lower_teeth || [];
    const D = Math.min(34, tg.length);
    if (D < 6 || lc.length < 11) {
      return { dorsal: tg, contour: tg, outline: tg, belly: tg[0] || [0, -2], anchorPt: lc[10] || [1.7, -3.3] };
    }
    const dorsal = tg.slice(0, D);
    const anchor = 10;
    const b = lc[anchor];
    const a = dorsal[D - 1], prev = dorsal[D - 2];
    const ttx = Number.isFinite(lm?.[2]) ? lm[2] : a[0];
    const tty = Number.isFinite(lm?.[3]) ? lm[3] : a[1];
    const tbx = Number.isFinite(lm?.[4]) ? lm[4] : dorsal[Math.min(D - 1, 21)][0];
    const tby = Number.isFinite(lm?.[5]) ? lm[5] : dorsal[Math.min(D - 1, 21)][1];
    const clamp01 = v => Math.max(0, Math.min(1, v));
    const curl = clamp01((tbx - ttx) / 0.75) * clamp01((tty - tby) / 0.5);

    let front = -Infinity;
    for (let i = 0; i < D; i++) if (dorsal[i][0] > front) front = dorsal[i][0];
    const len = Math.hypot(a[0] - prev[0], a[1] - prev[1]) || 1;
    const cx0 = a[0] + 0.14;
    const dx0 = Math.max(b[0] + 0.12, front + 0.20);
    const ctrlC = [
      cx0 + curl * (a[0] + 0.38 * (a[0] - prev[0]) / len - cx0),
      a[1] - 0.36 + curl * (0.36 + 0.38 * (a[1] - prev[1]) / len),
    ];
    const ctrlD = [
      dx0 + curl * (Math.max(dx0, front + 0.45) - dx0),
      b[1] + 0.08,
    ];

    const floorSeg = lc.slice(8);
    let crownX = Infinity, crownY = -Infinity;
    if (lt.length >= 4) {
      for (const tp of lt) {
        if (tp[0] < crownX) crownX = tp[0];
        if (tp[1] > crownY) crownY = tp[1];
      }
    }
    const hasTeeth = Number.isFinite(crownX) && Number.isFinite(crownY);
    const smoothstep = (e0, e1, x) => {
      const s = Math.max(0, Math.min(1, (x - e0) / Math.max(1e-6, e1 - e0)));
      return s * s * (3 - 2 * s);
    };
    const softMax = (v1, v2, k = 0.18) => 0.5 * (v1 + v2 + Math.hypot(v1 - v2, k));

    const ventral = [a];
    const Q = 24;
    for (let r = 1; r <= Q; r++) {
      const t = r / Q, u = 1 - t;
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
      const orig = ventral.map(pt => [pt[0], pt[1]]);
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

  function m10SampleXAtY(poly, y) {
    const hits = [];
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1], b = poly[i];
      if ((y >= a[1] - 1e-6 && y <= b[1] + 1e-6) || (y >= b[1] - 1e-6 && y <= a[1] + 1e-6)) {
        const dy = b[1] - a[1];
        const t = Math.abs(dy) < 1e-6 ? 0.5 : (y - a[1]) / dy;
        if (t >= -0.01 && t <= 1.01) hits.push(a[0] + Math.max(0, Math.min(1, t)) * (b[0] - a[0]));
      }
    }
    return hits;
  }

  function m10SampleYAtX(poly, x) {
    const hits = [];
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1], b = poly[i];
      if ((x >= a[0] - 1e-6 && x <= b[0] + 1e-6) || (x >= b[0] - 1e-6 && x <= a[0] + 1e-6)) {
        const dx = b[0] - a[0];
        const t = Math.abs(dx) < 1e-6 ? 0.5 : (x - a[0]) / dx;
        if (t >= -0.01 && t <= 1.01) hits.push(a[1] + Math.max(0, Math.min(1, t)) * (b[1] - a[1]));
      }
    }
    return hits;
  }

  function m10BuildAirwaySegments(c, tongue, velum, lips) {
    const uc = c.upper_cover || [], lc = c.lower_cover || [], epi = c.epiglottis || [];
    if (uc.length < 18 || lc.length < 10) return [];
    const segs = [];
    let cur = [];
    const flush = () => { if (cur.length > 1) segs.push(cur); cur = []; };

    const postWall = uc.slice(0, 9);
    const lowLarynx = lc.slice(0, 5);
    const pharTongue = tongue.dorsal.slice(0, 14);
    const yPharTop = velum ? Math.min(-0.85, velum.tip[1] - 0.12) : -0.90;
    for (let i = 0; i <= 20; i++) {
      const y = -8.65 + (i / 20) * (yPharTop - (-8.65));
      const lefts = m10SampleXAtY(postWall, y);
      if (!lefts.length) continue;
      const xL = Math.min(...lefts);
      const rights = [
        ...m10SampleXAtY(lowLarynx, y),
        ...m10SampleXAtY(epi, y),
        ...m10SampleXAtY(pharTongue, y),
      ].filter(x => x > xL - 0.1);
      if (!rights.length) continue;
      const xR = Math.min(...rights);
      if (xR - xL > 0.04) cur.push([0.5 * (xL + xR), y]);
      else flush();
    }

    const roofChain = [
      ...(velum ? velum.exposedProfile.slice(0, 8).slice().reverse() : uc.slice(9, 14)),
      ...uc.slice(13),
      ...(c.upper_teeth ? c.upper_teeth.slice(0, 3) : []),
      ...lips.upper.slice(0, Math.min(lips.upper.length, lips.edge + 3)),
    ];
    const floorChain = [
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

  function m10TextWidth(text, size) {
    let sum = 0;
    for (const ch of String(text)) sum += (ch.codePointAt(0) > 0x2e7f ? 1.0 : 0.56);
    return sum * size;
  }

  const M10_LABEL_STEPS = {
    right: [1, 0], left: [-1, 0], up: [0, 1], down: [0, -1],
    upRight: [1, 1], upLeft: [-1, 1], downRight: [1, -1], downLeft: [-1, -1],
  };

  function m10PlaceLabel(boxes, p, width, height, gap, prefer, bounds) {
    let best = null;
    const order = [prefer, ...Object.keys(M10_LABEL_STEPS)];
    const seen = new Set();
    for (const side of order) {
      if (!side || seen.has(side) || !M10_LABEL_STEPS[side]) continue;
      seen.add(side);
      const [dx, dy] = M10_LABEL_STEPS[side];
      const reach = dx && dy ? 0.62 : 1.0;
      let x = p[0] + dx * (gap * reach + width * 0.5);
      let y = p[1] + dy * (gap * reach + height * 0.5);
      let outPenalty = 0;
      if (bounds) {
        const minX = bounds[0] + width * 0.5;
        const maxX = bounds[2] - width * 0.5;
        const minY = bounds[1] + height * 0.5;
        const maxY = bounds[3] - height * 0.5;
        if (x < minX) { outPenalty += (minX - x) * 4; x = minX; }
        else if (x > maxX) { outPenalty += (x - maxX) * 4; x = maxX; }
        if (y < minY) { outPenalty += (minY - y) * 4; y = minY; }
        else if (y > maxY) { outPenalty += (y - maxY) * 4; y = maxY; }
      }
      const box = [x - width * 0.5, y - height * 0.5, x + width * 0.5, y + height * 0.5];
      let overlap = outPenalty;
      for (const b of boxes) {
        overlap += Math.max(0, Math.min(box[2], b[2]) - Math.max(box[0], b[0])) *
                   Math.max(0, Math.min(box[3], b[3]) - Math.max(box[1], b[1]));
      }
      if (!best || overlap < best.overlap - 1e-9) best = { box, overlap };
      if (!overlap) break;
    }
    boxes.push(best.box);
    return best.box;
  }

  function renderM27TractSvg(svgEl, anim, st, opts = {}) {
    if (!svgEl) return;
    if (!st || !anim) {
      drawVizEmpty(svgEl, "等待加载声道轮廓...", opts.theme);
      return;
    }
    if (!svgEl.dataset.tsSvgUid) {
      svgEl.dataset.tsSvgUid = `tsvg_${++_svgUidCounter}`;
    }
    const uid = svgEl.dataset.tsSvgUid;
    const c = st.parts;
    const css = rootAnatomy();
    const fromCss = key => css.getPropertyValue(`--anatomy-${key}`).trim();
    const P = { ...M10_PALETTE, panel: opts.theme?.anatomyBg || fromCss('bg') || M10_PALETTE.panel };
    for (const [key, token] of Object.entries(SVG_TISSUE_TOKENS)) P[key] = fromCss(token) || P[key];
    const showGhost = opts.showGhost !== false;
    const showLabels = opts.showLabels !== false;

    const vb = opts.viewBox;
    const vbX = Number.isFinite(vb?.x) ? vb.x : -5.85;
    const vbY = Number.isFinite(vb?.y) ? vb.y : -3.05;
    const vbW = Number.isFinite(vb?.w) ? vb.w : 15.15;
    const vbH = Number.isFinite(vb?.h) ? vb.h : 12.35;
    svgEl.setAttribute("viewBox", `${vbX} ${vbY} ${vbW} ${vbH}`);
    const clientH = Math.max(320, svgEl.clientHeight || 408);
    const px = vbH / clientH;

    svgEl.replaceChildren();
    const defs = m10SvgEl("defs");
    svgEl.appendChild(defs);
    const layer = m10SvgEl("g", { "stroke-linejoin": "round", "stroke-linecap": "round" });
    svgEl.appendChild(layer);

    layer.appendChild(m10SvgEl("rect", { x: vbX - 24, y: vbY - 24, width: vbW + 48, height: vbH + 48, fill: P.panel }));

    const addPath = (parent, pts, attrs = {}, close = false, smooth = false) => {
      if (!pts || pts.length < 2) return null;
      const node = m10SvgEl("path", { d: (smooth ? m10Curve : m10Path)(pts, close), ...attrs });
      parent.appendChild(node);
      return node;
    };

    const lips = m10BuildLips(c);
    const velum = m10BuildVelum(c, st.nasal);
    const tongue = m10BuildTongue(c, st.lm);
    // PTB duet frames include the original display-ready envelope and dorsal contour.
    if (c.tongue_outline?.length && c.tongue_surface?.length) {
      tongue.dorsal = c.tongue_surface;
      tongue.contour = c.tongue_surface;
      tongue.outline = c.tongue_outline;
      if (velum && c.velum?.length === velum.profile.length) {
        velum.profile = c.velum;
        velum.exposedProfile = c.velum.slice(0, velum.exposedProfile.length);
      }
    }

    const idOutTeeth = `${uid}-tongueOutsideTeeth`;
    const idTissue = `${uid}-tongueTissueSide`;
    const idDental = `${uid}-rigidDentalClip`;
    const idVelum = `${uid}-velumTone`;

    const teethD = ["upper_teeth", "lower_teeth"].map(n => m10Path(c[n], true)).join(" ");
    const tongueClear = m10SvgEl("clipPath", { id: idOutTeeth, clipPathUnits: "userSpaceOnUse" });
    tongueClear.appendChild(m10SvgEl("path", { d: `M-100,-100H100V100H-100Z ${teethD}`, "clip-rule": "evenodd" }));
    defs.appendChild(tongueClear);

    const tongueClip = m10SvgEl("clipPath", { id: idTissue, clipPathUnits: "userSpaceOnUse" });
    tongueClip.appendChild(m10SvgEl("path", { d: m10Path(tongue.outline, true) }));
    defs.appendChild(tongueClip);

    const headAlpha = opts.showHead === false ? 0 : Number(fromCss('head-2d'));
    if (headAlpha > 0 && c.upper_lip?.length > 4 && c.lower_lip?.length > 4 && c.upper_cover?.length && c.lower_cover?.length > 4) {
      const face = faceProfile(registeredHead.outline, HEAD_MARKS, c, st.ja ?? 0, st.jx ?? 0);
      const maskId = `${uid}-outside-airway`;
      const maskBounds = { x: -64, y: -64, width: 128, height: 128 };
      const mask = m10SvgEl('mask', { id: maskId, maskUnits: 'userSpaceOnUse', ...maskBounds });
      mask.appendChild(m10SvgEl('rect', { ...maskBounds, fill: 'white' }));
      mask.appendChild(m10SvgEl('path', { d: m10Path(oralSectionBoundary({ contours: c }), true), fill: 'black' }));
      mask.appendChild(m10SvgEl('path', { d: NASAL_REFERENCE_CUT, fill: 'black', 'fill-rule': 'evenodd' }));
      defs.appendChild(mask);
      addPath(layer, face.outline, { 'data-role': 'head-outline', fill: fromCss('skin') || P.skinEdge, 'fill-opacity': headAlpha, mask: `url(#${maskId})` }, true, true);
      for (const line of [face.below, face.above]) addPath(layer, line, { fill: 'none', stroke: P.skinEdge, 'stroke-width': 0.04, opacity: headAlpha }, false, true);
    }

    if (showGhost && st.ghosts?.length) {
      for (const g of st.ghosts) {
        const gd = g.parts?.tongue?.slice(0, 34);
        if (!gd || gd.length < 3) continue;
        addPath(layer, gd, {
          fill: "none",
          stroke: P.tongue,
          "stroke-width": 0.042,
          "stroke-dasharray": "0.14 0.10",
          opacity: g.age === 1 ? 0.34 : g.age === 2 ? 0.21 : 0.11,
        }, false, true);
      }
    }

    const uc = c.upper_cover || [], lc = c.lower_cover || [];
    for (const seg of [uc.slice(0, 9), uc.slice(13), lc.slice(0, 5), lc.slice(10)]) {
      addPath(layer, seg, { fill: "none", stroke: P.wall, "stroke-width": 0.17, opacity: 0.16 }, false, true);
      addPath(layer, seg, { fill: "none", stroke: P.wall, "stroke-width": 0.05 }, false, true);
    }

    const rooted = (parent, pts, reach, clipRef) => {
      for (let step = 0; step < 24; step++) {
        addPath(parent, pts, {
          fill: "none",
          stroke: P.panel,
          "stroke-width": (2 * reach * Math.pow(1 - step / 24, 1.3) + 0.04).toFixed(4),
          opacity: 0.105,
          "clip-path": clipRef,
        }, false, false);
      }
    };

    const tongueLayer = m10SvgEl("g", { "clip-path": `url(#${idOutTeeth})` });
    layer.appendChild(tongueLayer);
    tongueLayer.appendChild(m10SvgEl("path", { d: m10Path(tongue.outline, true), fill: P.tongueFill }));
    for (let step = 0; step < 22; step++) {
      addPath(tongueLayer, tongue.dorsal, {
        fill: "none",
        stroke: P.tongue,
        "stroke-width": (3.4 * Math.pow(1 - step / 22, 1.5) + 0.2).toFixed(4),
        opacity: 0.058,
        "clip-path": `url(#${idTissue})`,
      }, false, true);
    }
    if (lc.length >= 11) {
      rooted(tongueLayer, [lc[4], ...lc.slice(8, 11)], 0.95, `url(#${idTissue})`);
    }
    addPath(tongueLayer, tongue.contour, { fill: "none", stroke: P.tongueEdge, "stroke-width": 0.065 }, false, true);

    if (tongue.anchorPt && opts.showControls !== false) {
      const fl = tongue.anchorPt;
      layer.appendChild(m10SvgEl("rect", {
        x: (fl[0] - px * 3.1).toFixed(3),
        y: (-fl[1] - px * 3.1).toFixed(3),
        width: (px * 6.2).toFixed(3),
        height: (px * 6.2).toFixed(3),
        fill: P.panel,
        stroke: P.handle,
        "stroke-width": (px * 1.3).toFixed(3),
      }));
    }

    if (teethD) {
      const dentalClip = m10SvgEl("clipPath", { id: idDental, clipPathUnits: "userSpaceOnUse" });
      dentalClip.appendChild(m10SvgEl("path", { d: teethD }));
      defs.appendChild(dentalClip);
      const dentalBg = m10SvgEl("g", { "clip-path": `url(#${idDental})` });
      dentalBg.appendChild(m10SvgEl("rect", { x: vbX, y: vbY, width: vbW, height: vbH, fill: P.panel }));
      layer.appendChild(dentalBg);
      for (const tn of ["upper_teeth", "lower_teeth"]) {
        if (c[tn]?.length >= 3) {
          addPath(layer, m10Rounded(c[tn]), { fill: P.tooth, stroke: P.toothEdge, "stroke-width": 0.036 }, true, true);
        }
      }
    }

    for (const [lname, prof] of [["upper_lip", lips.upper], ["lower_lip", lips.lower]]) {
      if (!prof || prof.length < 4) continue;
      const red = prof.slice(Math.max(0, lips.edge - 7), lips.edge + 11);
      const clipId = `${uid}-${lname}Section`;
      const lClip = m10SvgEl("clipPath", { id: clipId, clipPathUnits: "userSpaceOnUse" });
      lClip.appendChild(m10SvgEl("path", { d: m10Path(prof, true) }));
      defs.appendChild(lClip);
      const lipG = m10SvgEl("g");
      layer.appendChild(lipG);
      for (let step = 0; step < 14; step++) {
        addPath(lipG, red, {
          fill: "none",
          stroke: P.lip,
          "stroke-width": (1.3 * Math.pow(1 - step / 14, 1.4) + 0.2).toFixed(4),
          opacity: 0.072,
          "clip-path": `url(#${clipId})`,
        }, false, true);
      }
      rooted(lipG, [prof[prof.length - 1], prof[0]], 0.30, `url(#${clipId})`);
      addPath(lipG, prof, { fill: "none", stroke: P.skinEdge, "stroke-width": 0.045 }, false, true);
    }

    if (velum) {
      const vGrad = m10SvgEl("linearGradient", {
        id: idVelum,
        gradientUnits: "userSpaceOnUse",
        x1: velum.root[0].toFixed(3), y1: "0",
        x2: (velum.root[0] - 1.5).toFixed(3), y2: "0",
      });
      vGrad.appendChild(m10SvgEl("stop", { offset: "0", "stop-color": P.velum, "stop-opacity": "0" }));
      vGrad.appendChild(m10SvgEl("stop", { offset: "1", "stop-color": P.velum, "stop-opacity": "0.78" }));
      defs.appendChild(vGrad);
      addPath(layer, velum.profile, { fill: `url(#${idVelum})`, stroke: "none" }, true, true);
      addPath(layer, velum.exposedProfile, { fill: "none", stroke: P.wall, "stroke-width": 0.052 }, false, true);
    }

    if (c.epiglottis?.length >= 3) {
      addPath(layer, m10Leaf(c.epiglottis, 0.13, 0.035), {
        fill: P.epiglottisFill,
        stroke: P.wall,
        "stroke-width": 0.04,
      }, true, true);
    }

    const airSegs = m10BuildAirwaySegments(c, tongue, velum, lips);
    for (const seg of airSegs) {
      addPath(layer, seg, {
        fill: "none",
        stroke: P.guide,
        "stroke-width": 0.028,
        "stroke-dasharray": "0.14 0.12",
        opacity: 0.82,
      }, false, true);
    }

    if (showLabels) {
      const dLen = tongue.dorsal.length;
      const ptSurf = st.surfPt || tongue.dorsal[Math.min(dLen - 1, 16)];
      const ptBlade = st.bladePt || tongue.dorsal[Math.min(dLen - 1, 21)];
      const ptBody = (Number.isFinite(st.lm?.[0]) && Number.isFinite(st.lm?.[1])) ? [st.lm[0], st.lm[1]] : [0.5, -1.6];
      const ptTip = (Number.isFinite(st.lm?.[2]) && Number.isFinite(st.lm?.[3])) ? [st.lm[2], st.lm[3]] : tongue.dorsal[dLen - 1];
      const ptRoot = (Number.isFinite(st.lm?.[6]) && Number.isFinite(st.lm?.[7]) && st.lm[7] > -5.2) ? [st.lm[6], st.lm[7]] : tongue.dorsal[Math.min(dLen - 1, 2)];
      const ptHyoid = lc[4] || [-0.93, -5.51];
      const ptLarynx = (uc.length && lc.length) ? [0.5 * (uc[0][0] + lc[0][0]), lc[0][1]] : [-1.69, -8.71];

      const handles = [
        { name: "surface", label: "舌面", p: ptSurf, own: true, side: "up" },
        { name: "blade", label: "舌叶", p: ptBlade, own: true, side: "up" },
        { name: "tip", label: "舌尖", p: ptTip, own: true, side: "right" },
        { name: "belly", label: "舌底", p: tongue.belly, own: true, side: "down" },
        { name: "tongue", label: "舌背", p: ptBody, own: true, side: "down" },
        { name: "root", label: "舌根", p: ptRoot, own: true, side: "left" },
        { name: "hyoid", label: "舌骨", p: ptHyoid, own: true, side: "left" },
        { name: "velum", label: "软腭", p: velum ? velum.tip : [-2.05, -0.79], own: false, side: "left" },
        { name: "upper_lip", label: "上唇", p: lips.upperHandle || [6.5, -0.7], own: false, side: "up" },
        { name: "lower_lip", label: "下唇", p: lips.lowerHandle || [6.2, -1.0], own: false, side: "right" },
        { name: "larynx", label: "声门", p: ptLarynx, own: false, side: "down" },
      ];

      const size = px * 11.2;
      const notes = m10SvgEl("g", { "pointer-events": "none" });
      const taken = handles.map(({ p }) => [p[0] - px * 8, p[1] - px * 8, p[0] + px * 8, p[1] + px * 8]);

      const labelBounds = [
        vbX + px * 6,
        -(vbY + vbH) + px * 18,
        vbX + vbW - px * 6,
        -vbY - px * 6,
      ];
      const writeText = (boxes, text, p, prefer, gap, attrs) => {
        const box = m10PlaceLabel(boxes, p, m10TextWidth(text, size), size * 1.32, gap, prefer, labelBounds);
        const node = m10SvgEl("text", {
          x: ((box[0] + box[2]) * 0.5).toFixed(3),
          y: (-(box[1] + box[3]) * 0.5 + size * 0.35).toFixed(3),
          "font-size": size.toFixed(3),
          "text-anchor": "middle",
          "paint-order": "stroke",
          "stroke-linejoin": "round",
          ...attrs,
        });
        node.textContent = text;
        notes.appendChild(node);
        return box;
      };

      for (const hItem of handles) {
        if (!hItem.own) continue;
        writeText(taken, hItem.label, hItem.p, hItem.side, px * 12, {
          fill: P.handle,
          stroke: P.panel,
          "stroke-width": (px * 3.2).toFixed(3),
          "font-weight": "600",
        });
      }

      const callouts = [];
      if (tongue.anchorPt) callouts.push(["口底附着", tongue.anchorPt, [0.65, -0.62]]);
      if (uc.length > 17) callouts.push(["硬腭", uc[17], [0.22, 1.05]]);
      if (velum) callouts.push(["软腭 / 小舌", velum.tip, [-1.25, 1.28]]);
      if (c.epiglottis?.length) callouts.push(["会厌", c.epiglottis[c.epiglottis.length - 1], [-1.45, -0.38]]);
      if (c.upper_teeth?.length > 2) callouts.push(["门齿截面", c.upper_teeth[2], [1.95, 1.15]]);

      for (const [label, pt, off] of callouts) {
        const box = writeText(taken, label, [pt[0] + off[0], pt[1] + off[1]], off[0] < 0 ? "left" : "right", px * 2, {
          fill: P.muted,
          stroke: P.panel,
          "stroke-width": (px * 3).toFixed(3),
        });
        const end = [
          Math.max(box[0], Math.min(box[2], pt[0])),
          Math.max(box[1], Math.min(box[3], pt[1])),
        ];
        addPath(layer, [pt, end], { fill: "none", stroke: P.muted, "stroke-width": (px * 0.95).toFixed(4), opacity: 0.58 });
        layer.appendChild(m10SvgEl("circle", {
          cx: pt[0].toFixed(3), cy: (-pt[1]).toFixed(3),
          r: (px * 1.75).toFixed(3), fill: P.muted, opacity: 0.78,
        }));
      }

      for (const hItem of handles) {
        const { p, own } = hItem;
        const tone = own ? P.handle : P.handleSoft;
        const g = m10SvgEl("g", { transform: `translate(${p[0].toFixed(3)} ${(-p[1]).toFixed(3)})` });
        g.appendChild(m10SvgEl("circle", {
          r: (px * (own ? 6.4 : 4.2)).toFixed(3),
          fill: P.panel,
          stroke: tone,
          "stroke-width": (px * (own ? 1.85 : 1.35)).toFixed(3),
        }));
        g.appendChild(m10SvgEl("circle", {
          r: (px * (own ? 2.55 : 1.55)).toFixed(3),
          fill: tone,
        }));
        layer.appendChild(g);
      }

      layer.appendChild(notes);

      const legY = vbY + vbH - 0.52;
      layer.appendChild(m10SvgEl("rect", {
        x: (vbX + 0.25).toFixed(2), y: (legY - 0.28).toFixed(2),
        width: "3.95", height: "0.56", rx: "0.18",
        fill: "#f4f5ee", stroke: P.line, "stroke-width": "0.03",
      }));
      layer.appendChild(m10SvgEl("circle", { cx: (vbX + 0.52).toFixed(2), cy: legY.toFixed(2), r: "0.10", fill: P.tongue }));
      const legT1 = m10SvgEl("text", { x: (vbX + 0.74).toFixed(2), y: (legY + 0.11).toFixed(2), fill: P.ink, "font-size": "0.31" });
      legT1.textContent = "发音器官";
      layer.appendChild(legT1);
      layer.appendChild(m10SvgEl("circle", { cx: (vbX + 2.34).toFixed(2), cy: legY.toFixed(2), r: "0.10", fill: P.handle }));
      const legT2 = m10SvgEl("text", { x: (vbX + 2.56).toFixed(2), y: (legY + 0.11).toFixed(2), fill: P.ink, "font-size": "0.31" });
      legT2.textContent = "气腔参考";
      layer.appendChild(legT2);

      const cmpX = vbX + vbW - 1.15, cmpY = vbY + vbH - 0.92;
      for (const [txt, dx, dy] of [["上", 0, -0.42], ["后 ── 前", 0, 0], ["下", 0, 0.42]]) {
        const tn = m10SvgEl("text", {
          x: (cmpX + dx).toFixed(2), y: (cmpY + dy).toFixed(2),
          fill: P.muted, "font-size": "0.32", "text-anchor": "middle", "dominant-baseline": "middle",
        });
        tn.textContent = txt;
        layer.appendChild(tn);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Hyper-Realistic Medical-Atlas Vocal Fold & Glottis Canvas Renderer
  // --------------------------------------------------------------------------
  const M27_AIR_DOTS = (() => {
    const pts = [];
    let seed = 20261122;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 190; i++) pts.push([rnd() * 2 - 1, rnd(), rnd()]);
    return pts;
  })();

  function getM27GlottisVisHz(st, vibMode = "strobe") {
    if (vibMode === "realtime") {
      return st && st.f0 > 40 ? st.f0 : 120;
    }
    return st && st.f0 > 40 ? 2.2 + 3.2 * Math.min(1, (st.f0 - 60) / 340) : 2.8;
  }

  function hexToRgba(hex, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return `rgba(255, 254, 249, ${a})`;
    const v = parseInt(m[1], 16);
    return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
  }

  function drawM27GlottisCanvas(canvas, st, phase, opts = {}) {
    const vibMode = typeof opts === "string" ? opts : (opts.vibMode || "strobe");
    const theme = typeof opts === "object" && opts.theme ? opts.theme : {};
    if (!st) {
      drawVizEmpty(canvas, "等待声门参数...", theme);
      return;
    }
    const { ctx, w, h } = setupVizCanvas(canvas);
    const showLabels = opts.showLabels !== false;
    const panelBg = theme.anatomyBg || "#fffef9";
    const panelBgZero = hexToRgba(panelBg, 0);
    const captionCol = theme.anatomyMuted || "#69776f";
    const dividerCol = theme.anatomyDivider || "#dde2d6";

    const smoothstep = (e0, e1, x) => {
      const t = Math.min(1, Math.max(0, (x - e0) / Math.max(1e-6, e1 - e0)));
      return t * t * (3 - 2 * t);
    };
    const hzVis = getM27GlottisVisHz(st, vibMode);
    const isRealtime = vibMode === "realtime";

    ctx.fillStyle = panelBg;
    ctx.fillRect(0, 0, w, h);

    const f0Clamped = Math.min(500, Math.max(60, st.f0 || 150));
    const lenFactor = Math.min(1.09, Math.max(0.91, 1.0 + 0.10 * ((Math.log(f0Clamped) - Math.log(150)) / 1.45)));
    const bandScale = 1.0 / Math.sqrt(lenFactor);

    const activeVib = st.pr_pa > 90 && st.ra > 0.05;
    const flutterMod = 1 + 0.10 * (st.fl / 100) * Math.sin(st.t * 31.0);
    // Avoid 60 Hz / 120 Hz Nyquist monitor aliasing in realtime mode (e.g. F0 = 120/180 Hz freezing at 0 Hz):
    // map high-speed visual oscillation near the screen's anti-aliased rapid-flutter band (~26.7 Hz)
    // while preserving the exact physical F0 readout and multi-phase motion-blur envelope.
    const effPhase = isRealtime && activeVib
      ? (Number.isFinite(st.t) ? st.t : 0) * Math.PI * 2 * (25.7 + 2.6 * ((f0Clamped - 60) / 440)) + phase * 0.07
      : phase;
    const shimMod = 1 + 0.16 * (st.shim / 100) * Math.sin(effPhase * 0.5 + 1.1);
    const vibAmp = activeVib ? Math.max(0, st.ra) * 0.115 * flutterMod * shimMod : 0;
    const evalMemX = dphi => ({
      low: Math.max(0, st.xb + vibAmp * Math.sin(effPhase + dphi)),
      up: Math.max(0, st.xt + vibAmp * Math.sin(effPhase + dphi - st.lag) + 0.014 * st.ps * Math.sin(2 * (effPhase + dphi))),
    });
    const mem0 = evalMemX(0);
    const xLow = mem0.low;
    const xUp = mem0.up;
    const xMinMem = Math.max(0, Math.min(xLow, xUp));
    const xRestMem = Math.max(0, 0.5 * (st.xb + st.xt));
    const caPos = Math.max(0, st.ca);

    const supH = Math.round(h * 0.54);
    const cxSup = showLabels ? w * 0.41 : w * 0.50;
    const cySup = (supH - 14) * 0.50 + 2;
    const S = Math.min((w - (showLabels ? 86 : 18)) / 2.30, (supH - 20) / 1.90);
    const X = nx => cxSup + nx * S;
    const Y = ny => cySup + ny * S;

    const nyAnt = -0.50 * lenFactor;
    const nyPost = 0.50 * lenFactor;
    const Lvf = nyPost - nyAnt;
    const nyVP = nyAnt + 0.60 * Lvf;
    const nyMid = nyAnt + 0.31 * Lvf;

    const medComp = Math.min(1, Math.max(0, xMinMem / 0.030));
    const nxVP = Math.min(0.29, xMinMem * 1.34 + caPos * (0.07 + 0.54 * medComp));
    const nxPost = Math.min(0.32, nxVP * 0.78 + caPos * 1.32);
    const nxMid = Math.max(0.0025, Math.min(0.31, 0.54 * nxVP + xMinMem * 0.38));
    const nxAnt = Math.max(0.002, Math.min(0.012, nxMid * 0.08));
    const wBand = 0.195 * bandScale;
    const chinkSharp = (1 - smoothstep(0.014, 0.038, nxVP)) * smoothstep(0.030, 0.056, nxPost);

    ctx.save();

    const traceOuterShield = () => {
      ctx.beginPath();
      ctx.moveTo(X(0), Y(-0.92));
      ctx.bezierCurveTo(X(0.32), Y(-0.92), X(0.50), Y(-0.68), X(0.76), Y(-0.46));
      ctx.bezierCurveTo(X(1.01), Y(-0.25), X(1.14), Y(-0.18), X(1.13), Y(-0.02));
      ctx.bezierCurveTo(X(1.12), Y(0.14), X(0.86), Y(0.34), X(0.71), Y(0.56));
      ctx.bezierCurveTo(X(0.60), Y(0.73), X(0.52), Y(0.89), X(0.27), Y(0.92));
      ctx.bezierCurveTo(X(0.12), Y(0.94), X(0.05), Y(0.88), X(0), Y(0.88));
      ctx.bezierCurveTo(X(-0.05), Y(0.88), X(-0.12), Y(0.94), X(-0.27), Y(0.92));
      ctx.bezierCurveTo(X(-0.52), Y(0.89), X(-0.60), Y(0.73), X(-0.71), Y(0.56));
      ctx.bezierCurveTo(X(-0.86), Y(0.34), X(-1.12), Y(0.14), X(-1.13), Y(-0.02));
      ctx.bezierCurveTo(X(-1.14), Y(-0.18), X(-1.01), Y(-0.25), X(-0.76), Y(-0.46));
      ctx.bezierCurveTo(X(-0.50), Y(-0.68), X(-0.32), Y(-0.92), X(0), Y(-0.92));
      ctx.closePath();
    };
    traceOuterShield();
    const fleshGrad = ctx.createRadialGradient(X(0), Y(-0.10), S * 0.15, X(0), Y(0.05), S * 1.18);
    fleshGrad.addColorStop(0, "#f4dcd1");
    fleshGrad.addColorStop(0.65, "#eccac0");
    fleshGrad.addColorStop(1, "#e2bbb0");
    ctx.fillStyle = fleshGrad;
    ctx.fill();
    ctx.strokeStyle = "#d3a89c";
    ctx.lineWidth = 1.1;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(X(-0.34), Y(-0.74));
    ctx.quadraticCurveTo(X(0), Y(-0.84), X(0.34), Y(-0.74));
    ctx.strokeStyle = "rgba(182, 122, 110, 0.55)";
    ctx.lineWidth = 1.3;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(X(-0.03), Y(0.80));
    ctx.quadraticCurveTo(X(0), Y(0.86), X(0.01), Y(0.90));
    ctx.strokeStyle = "#aa645c";
    ctx.lineWidth = 2.0;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(X(-0.62), Y(-0.38));
    ctx.bezierCurveTo(X(-0.36), Y(-0.66), X(-0.18), Y(-0.72), X(0), Y(-0.69));
    ctx.bezierCurveTo(X(0.18), Y(-0.72), X(0.36), Y(-0.66), X(0.62), Y(-0.38));
    ctx.strokeStyle = "#771f26";
    ctx.lineWidth = Math.max(2.0, S * 0.028);
    ctx.lineCap = "round";
    ctx.stroke();

    const traceRimOuter = () => {
      ctx.beginPath();
      ctx.moveTo(X(0), Y(-0.64));
      ctx.bezierCurveTo(X(0.24), Y(-0.67), X(0.46), Y(-0.52), X(0.72), Y(-0.32));
      ctx.bezierCurveTo(X(0.96), Y(-0.15), X(1.01), Y(-0.04), X(0.92), Y(0.14));
      ctx.bezierCurveTo(X(0.80), Y(0.34), X(0.64), Y(0.52), X(0.54), Y(0.72));
      ctx.bezierCurveTo(X(0.46), Y(0.85), X(0.22), Y(0.86), X(0), Y(0.81));
      ctx.bezierCurveTo(X(-0.22), Y(0.86), X(-0.46), Y(0.85), X(-0.54), Y(0.72));
      ctx.bezierCurveTo(X(-0.64), Y(0.52), X(-0.80), Y(0.34), X(-0.92), Y(0.14));
      ctx.bezierCurveTo(X(-1.01), Y(-0.04), X(-0.96), Y(-0.15), X(-0.72), Y(-0.32));
      ctx.bezierCurveTo(X(-0.46), Y(-0.52), X(-0.24), Y(-0.67), X(0), Y(-0.64));
      ctx.closePath();
    };
    traceRimOuter();
    const rimGrad = ctx.createLinearGradient(X(0), Y(-0.68), X(0), Y(0.86));
    rimGrad.addColorStop(0, "#f5dbd0");
    rimGrad.addColorStop(0.5, "#f8e4db");
    rimGrad.addColorStop(1, "#edd0c3");
    ctx.fillStyle = rimGrad;
    ctx.fill();
    ctx.strokeStyle = "#6c1a21";
    ctx.lineWidth = Math.max(2.2, S * 0.032);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(X(-0.48), Y(-0.43));
    ctx.bezierCurveTo(X(-0.24), Y(-0.60), X(-0.10), Y(-0.56), X(0), Y(-0.55));
    ctx.bezierCurveTo(X(0.10), Y(-0.56), X(0.24), Y(-0.60), X(0.48), Y(-0.43));
    ctx.strokeStyle = "#9b504d";
    ctx.lineWidth = Math.max(1.4, S * 0.018);
    ctx.stroke();

    const traceVestibule = () => {
      ctx.beginPath();
      ctx.moveTo(X(0), Y(nyAnt - 0.01));
      ctx.bezierCurveTo(X(0.18), Y(nyAnt - 0.09), X(0.44), Y(-0.55), X(0.76), Y(-0.26));
      ctx.bezierCurveTo(X(0.91), Y(-0.12), X(0.90), Y(0.01), X(0.77), Y(0.19));
      ctx.bezierCurveTo(X(0.64), Y(0.36), X(0.54), Y(0.49), X(nxPost + 0.28), Y(nyPost + 0.06));
      ctx.lineTo(X(-(nxPost + 0.28)), Y(nyPost + 0.06));
      ctx.bezierCurveTo(X(-0.54), Y(0.49), X(-0.64), Y(0.36), X(-0.77), Y(0.19));
      ctx.bezierCurveTo(X(-0.90), Y(0.01), X(-0.91), Y(-0.12), X(-0.76), Y(-0.26));
      ctx.bezierCurveTo(X(-0.44), Y(-0.55), X(-0.18), Y(nyAnt - 0.09), X(0), Y(nyAnt - 0.01));
      ctx.closePath();
    };

    ctx.save();
    traceVestibule();
    ctx.clip();

    ctx.fillStyle = "#b8686f";
    ctx.fillRect(X(-1.05), Y(-0.70), S * 2.1, S * 1.6);

    for (const dir of [-1, 1]) {
      const cushGrad = ctx.createRadialGradient(
        X(dir * 0.43), Y(-0.05), S * 0.04,
        X(dir * 0.48), Y(0.02), S * 0.54
      );
      cushGrad.addColorStop(0, "#fdebe8");
      cushGrad.addColorStop(0.38, "#f3c3c4");
      cushGrad.addColorStop(0.74, "#da8f94");
      cushGrad.addColorStop(1, "rgba(168, 82, 90, 0)");
      ctx.fillStyle = cushGrad;
      ctx.beginPath();
      ctx.arc(X(dir * 0.46), Y(0.0), S * 0.56, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(255, 240, 238, 0.46)";
      ctx.beginPath();
      for (let k = 0; k < 5; k++) {
        const u0 = 0.24 + k * 0.11;
        ctx.moveTo(X(dir * u0), Y(-0.34 + k * 0.03));
        ctx.quadraticCurveTo(X(dir * (u0 + 0.07)), Y(-0.16 + k * 0.04), X(dir * (u0 + 0.11)), Y(-0.28 + k * 0.04));
      }
      ctx.fill();

      ctx.fillStyle = "rgba(182, 92, 100, 0.32)";
      ctx.beginPath();
      for (let k = 0; k < 5; k++) {
        const u0 = 0.26 + k * 0.10;
        ctx.moveTo(X(dir * u0), Y(0.38 - k * 0.03));
        ctx.quadraticCurveTo(X(dir * (u0 + 0.06)), Y(0.19 - k * 0.03), X(dir * (u0 + 0.10)), Y(0.33 - k * 0.04));
      }
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(X(dir * (nxAnt + wBand * 0.45)), Y(nyAnt - 0.02));
      ctx.quadraticCurveTo(X(dir * (nxMid + wBand * 1.12)), Y(nyMid), X(dir * (nxPost + wBand * 1.02)), Y(nyPost + 0.04));
      ctx.strokeStyle = "rgba(116, 42, 50, 0.34)";
      ctx.lineWidth = Math.max(3.0, S * 0.055);
      ctx.stroke();
    }

    traceVestibule();
    ctx.strokeStyle = "rgba(118, 34, 42, 0.65)";
    ctx.lineWidth = Math.max(3.5, S * 0.055);
    ctx.stroke();

    const traceMedialEdge = (dir, reverse = false) => {
      const xA = X(dir * nxAnt), yA = Y(nyAnt - 0.015);
      const xM = X(dir * nxMid), yM = Y(nyMid);
      const xV = X(dir * nxVP), yV = Y(nyVP);
      const xP = X(dir * nxPost), yP = Y(nyPost + 0.035);
      const c1xCurve = X(dir * (nxVP + (nxPost - nxVP) * 0.46));
      const c1xLine = X(dir * (nxVP + (nxPost - nxVP) * 0.38));
      const c1x = c1xCurve + (c1xLine - c1xCurve) * chinkSharp;
      const c1y = Y(nyVP + (nyPost - nyVP) * 0.38);
      const c2xCurve = X(dir * (nxPost + 0.010));
      const c2xLine = X(dir * (nxVP + (nxPost - nxVP) * 0.76));
      const c2x = c2xCurve + (c2xLine - c2xCurve) * chinkSharp;
      const c2y = Y(nyVP + (nyPost - nyVP) * 0.76);
      if (!reverse) {
        ctx.quadraticCurveTo(xM, yM, xV, yV);
        ctx.bezierCurveTo(c1x, c1y, c2x, c2y, xP, yP);
      } else {
        ctx.bezierCurveTo(c2x, c2y, c1x, c1y, xV, yV);
        ctx.quadraticCurveTo(xM, yM, xA, yA);
      }
    };

    ctx.beginPath();
    ctx.moveTo(X(-nxAnt), Y(nyAnt - 0.015));
    traceMedialEdge(-1, false);
    ctx.lineTo(X(nxPost), Y(nyPost + 0.035));
    traceMedialEdge(1, true);
    ctx.closePath();
    const glotGrad = ctx.createLinearGradient(X(0), Y(nyAnt), X(0), Y(nyPost));
    glotGrad.addColorStop(0, "#3b4c66");
    glotGrad.addColorStop(0.36, "#223047");
    glotGrad.addColorStop(0.72, "#0d131f");
    glotGrad.addColorStop(1, "#030407");
    ctx.fillStyle = glotGrad;
    ctx.fill();

    const ringAlpha = 0.38 * smoothstep(0.03, 0.11, nxPost);
    if (ringAlpha > 0.01) {
      ctx.beginPath();
      ctx.ellipse(X(0), Y(nyPost - 0.04), S * nxPost * 0.78, S * 0.065, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(92, 62, 58, ${ringAlpha.toFixed(3)})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    for (const dir of [-1, 1]) {
      const latAnt = nxAnt + wBand * 0.44;
      const latMid = nxMid * 0.74 + wBand * 0.98;
      const latVP = nxVP + wBand * 1.05;
      const latPost = nxPost + wBand * 0.90;

      const traceVocalFold = () => {
        ctx.beginPath();
        ctx.moveTo(X(dir * nxAnt), Y(nyAnt - 0.02));
        traceMedialEdge(dir, false);
        ctx.lineTo(X(dir * latPost), Y(nyPost + 0.025));
        ctx.bezierCurveTo(
          X(dir * (latVP + 0.016)), Y(nyVP + (nyPost - nyVP) * 0.48),
          X(dir * latVP), Y(nyVP - 0.04),
          X(dir * latMid), Y(nyMid)
        );
        ctx.quadraticCurveTo(
          X(dir * (latAnt + 0.045)), Y(nyAnt + 0.08),
          X(dir * latAnt), Y(nyAnt - 0.02)
        );
        ctx.closePath();
      };

      ctx.save();
      traceVocalFold();
      ctx.clip();

      const latGrad = ctx.createLinearGradient(X(dir * (nxVP + wBand)), Y(nyVP), X(dir * nxVP), Y(nyVP));
      latGrad.addColorStop(0, "#fbfcfe");
      latGrad.addColorStop(0.42, "#eef1f8");
      latGrad.addColorStop(0.75, "#cfd6e8");
      latGrad.addColorStop(1, "#b4bed8");
      ctx.fillStyle = latGrad;
      ctx.fillRect(X(-0.9), Y(nyAnt - 0.1), S * 1.8, S * (Lvf + 0.25));

      ctx.beginPath();
      ctx.moveTo(X(dir * (nxAnt + wBand * 0.28)), Y(nyAnt - 0.01));
      ctx.bezierCurveTo(
        X(dir * (nxMid * 0.85 + wBand * 0.62)), Y(nyMid),
        X(dir * (nxVP + wBand * 0.66)), Y(nyVP),
        X(dir * (nxPost + wBand * 0.60)), Y(nyPost + 0.02)
      );
      ctx.lineTo(X(dir * (nxPost + wBand * 0.86)), Y(nyPost + 0.02));
      ctx.bezierCurveTo(
        X(dir * (nxVP + wBand * 0.94)), Y(nyVP),
        X(dir * (nxMid * 0.78 + wBand * 0.90)), Y(nyMid),
        X(dir * (nxAnt + wBand * 0.40)), Y(nyAnt - 0.01)
      );
      ctx.closePath();
      const sheenGrad = ctx.createLinearGradient(X(0), Y(nyAnt), X(0), Y(nyPost));
      sheenGrad.addColorStop(0, "rgba(255, 255, 255, 0.18)");
      sheenGrad.addColorStop(0.45, "rgba(255, 255, 255, 0.78)");
      sheenGrad.addColorStop(1, "rgba(255, 255, 255, 0.95)");
      ctx.fillStyle = sheenGrad;
      ctx.fill();

      for (const frac of [0.33, 0.60]) {
        ctx.beginPath();
        ctx.moveTo(X(dir * (nxAnt + wBand * 0.36 * frac)), Y(nyAnt));
        ctx.bezierCurveTo(
          X(dir * (nxMid * (1 - 0.24 * frac) + wBand * frac)), Y(nyMid),
          X(dir * (nxVP + wBand * frac)), Y(nyVP),
          X(dir * (nxPost + wBand * 0.86 * frac)), Y(nyPost + 0.02)
        );
        ctx.strokeStyle = frac < 0.45 ? "rgba(122, 134, 166, 0.62)" : "rgba(154, 165, 192, 0.45)";
        ctx.lineWidth = 1.0;
        ctx.stroke();
      }

      const hoodGrad = ctx.createLinearGradient(X(0), Y(nyAnt - 0.02), X(0), Y(nyAnt + Lvf * 0.32));
      hoodGrad.addColorStop(0, "rgba(66, 76, 105, 0.62)");
      hoodGrad.addColorStop(0.55, "rgba(96, 107, 138, 0.25)");
      hoodGrad.addColorStop(1, "rgba(96, 107, 138, 0)");
      ctx.fillStyle = hoodGrad;
      ctx.fillRect(X(-0.9), Y(nyAnt - 0.06), S * 1.8, S * Lvf * 0.42);
      ctx.restore();

      if (isRealtime && activeVib && vibAmp > 0.003) {
        const memNx = xM => {
          const mc = Math.min(1, Math.max(0, xM / 0.030));
          const vp = Math.min(0.29, xM * 1.34 + caPos * (0.07 + 0.54 * mc));
          const mid = Math.max(0.0025, Math.min(0.31, 0.54 * vp + xM * 0.38));
          return [mid, vp];
        };
        const [midLo, vpLo] = memNx(Math.max(0, xRestMem - vibAmp * 1.15));
        const [midHi, vpHi] = memNx(xRestMem + vibAmp * 1.15);
        ctx.beginPath();
        ctx.moveTo(X(dir * nxAnt), Y(nyAnt));
        ctx.quadraticCurveTo(X(dir * midHi), Y(nyMid), X(dir * vpHi), Y(nyVP));
        ctx.lineTo(X(dir * vpLo), Y(nyVP));
        ctx.quadraticCurveTo(X(dir * midLo), Y(nyMid), X(dir * nxAnt), Y(nyAnt));
        ctx.closePath();
        ctx.fillStyle = "rgba(96, 165, 250, 0.42)";
        ctx.fill();

        for (let k = 1; k <= 5; k++) {
          const mPhi = evalMemX((k * Math.PI * 2) / 5);
          const [midP, vpP] = memNx(Math.max(0, Math.min(mPhi.low, mPhi.up)));
          ctx.beginPath();
          ctx.moveTo(X(dir * nxAnt), Y(nyAnt));
          ctx.quadraticCurveTo(X(dir * midP), Y(nyMid), X(dir * vpP), Y(nyVP));
          ctx.strokeStyle = "rgba(59, 130, 246, 0.48)";
          ctx.lineWidth = 1.15;
          ctx.stroke();
        }
      }

      const ghostAlpha = 0.48 * smoothstep(0.002, 0.014, vibAmp);
      if (ghostAlpha > 0.01) {
        const xGhost = Math.max(0.002, xRestMem + vibAmp);
        ctx.beginPath();
        ctx.moveTo(X(dir * nxAnt), Y(nyAnt));
        ctx.quadraticCurveTo(X(dir * Math.min(0.30, xGhost * 1.15)), Y(nyMid + 0.06), X(dir * nxVP), Y(nyVP));
        ctx.strokeStyle = `rgba(138, 150, 184, ${ghostAlpha.toFixed(3)})`;
        ctx.lineWidth = 1.0;
        ctx.stroke();
      }

      traceVocalFold();
      ctx.strokeStyle = "#2b3242";
      ctx.lineWidth = 1.45;
      ctx.stroke();
    }

    ctx.restore();

    ctx.beginPath();
    ctx.moveTo(X(-0.76), Y(-0.26));
    ctx.bezierCurveTo(X(-0.44), Y(-0.55), X(-0.18), Y(nyAnt - 0.09), X(0), Y(nyAnt - 0.01));
    ctx.bezierCurveTo(X(0.18), Y(nyAnt - 0.09), X(0.44), Y(-0.55), X(0.76), Y(-0.26));
    ctx.strokeStyle = "#6e1c23";
    ctx.lineWidth = Math.max(1.8, S * 0.024);
    ctx.stroke();

    const iaHalf = Math.max(0.018, nxPost * 0.90 + 0.018);
    ctx.beginPath();
    ctx.moveTo(X(-iaHalf), Y(nyPost - 0.01));
    ctx.quadraticCurveTo(X(0), Y(nyPost + 0.025), X(iaHalf), Y(nyPost - 0.01));
    ctx.bezierCurveTo(
      X(iaHalf * 0.58), Y(nyPost + 0.11),
      X(iaHalf * 0.92), Y(nyPost + 0.22),
      X(iaHalf * 0.76), Y(nyPost + 0.30)
    );
    ctx.quadraticCurveTo(X(0), Y(nyPost + 0.34), X(-iaHalf * 0.76), Y(nyPost + 0.30));
    ctx.bezierCurveTo(
      X(-iaHalf * 0.92), Y(nyPost + 0.22),
      X(-iaHalf * 0.58), Y(nyPost + 0.11),
      X(-iaHalf), Y(nyPost - 0.01)
    );
    ctx.closePath();
    const iaGrad = ctx.createLinearGradient(X(0), Y(nyPost), X(0), Y(nyPost + 0.33));
    iaGrad.addColorStop(0, "#bc746e");
    iaGrad.addColorStop(0.45, "#da9c93");
    iaGrad.addColorStop(1, "#c8837a");
    ctx.fillStyle = iaGrad;
    ctx.fill();
    ctx.strokeStyle = "#6e1b22";
    ctx.lineWidth = 1.4;
    ctx.stroke();

    for (const dir of [-1, 1]) {
      const axIn = Math.max(0.006, nxPost * 0.84);
      const axOut = nxPost * 0.45 + 0.46;
      ctx.beginPath();
      ctx.moveTo(X(dir * axIn), Y(nyPost));
      ctx.bezierCurveTo(
        X(dir * (axIn + 0.15)), Y(nyPost - 0.045),
        X(dir * (axOut - 0.05)), Y(nyPost - 0.07),
        X(dir * (axOut + 0.06)), Y(nyPost + 0.05)
      );
      ctx.bezierCurveTo(
        X(dir * (axOut + 0.08)), Y(nyPost + 0.21),
        X(dir * (axIn + 0.29)), Y(nyPost + 0.33),
        X(dir * (axIn + 0.09)), Y(nyPost + 0.30)
      );
      ctx.bezierCurveTo(
        X(dir * (axIn - 0.01)), Y(nyPost + 0.24),
        X(dir * (axIn - 0.01)), Y(nyPost + 0.10),
        X(dir * axIn), Y(nyPost)
      );
      ctx.closePath();

      const aryGrad = ctx.createRadialGradient(
        X(dir * (axIn + 0.18)), Y(nyPost + 0.10), S * 0.02,
        X(dir * (axIn + 0.20)), Y(nyPost + 0.15), S * 0.30
      );
      aryGrad.addColorStop(0, "#fcf0ea");
      aryGrad.addColorStop(0.50, "#f1cfc1");
      aryGrad.addColorStop(1, "#dfb0a1");
      ctx.fillStyle = aryGrad;
      ctx.fill();

      ctx.strokeStyle = "#7a2329";
      ctx.lineWidth = 1.65;
      ctx.stroke();

      ctx.save();
      ctx.translate(X(dir * (axIn + 0.18)), Y(nyPost + 0.11));
      ctx.rotate(dir * -0.36);
      ctx.beginPath();
      ctx.ellipse(0, 0, S * 0.082, S * 0.046, 0, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.84)";
      ctx.fill();
      ctx.restore();
    }

    if (showLabels) {
      const spineNx = Math.max(0.52, nxVP + wBand + 0.06);
      const bx = Math.min(w - 74, X(spineNx));
      const yA = Y(nyAnt), yV = Y(nyVP), yP = Y(nyPost);
      const xTickTop = X(nxAnt + wBand * 0.42);
      const xTickMid = X(nxVP + wBand * 1.02);
      const xTickBot = X(nxPost + wBand * 0.88);

      const drawAtlasBracket = (xStart, y0, xEnd, y1, label) => {
        const ym = 0.5 * (y0 + y1);
        const tickX = Math.min(w - 68, Math.max(bx + 6, X(0.96)));
        ctx.save();
        for (const [col, lw] of [[panelBg, 3.6], ["#27332f", 1.35]]) {
          ctx.strokeStyle = col;
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.moveTo(xStart, y0);
          ctx.lineTo(bx, y0);
          ctx.lineTo(bx, y1);
          ctx.lineTo(xEnd, y1);
          ctx.moveTo(bx, ym);
          ctx.lineTo(tickX, ym);
          ctx.stroke();
        }
        ctx.font = "600 9.5px Segoe UI, PingFang SC, sans-serif";
        const tw = ctx.measureText(label).width + 9;
        const th = 15.5;
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "#27332f";
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.roundRect(tickX, ym - th * 0.5, tw, th, 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#1f2926";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, tickX + 4.5, ym + 0.5);
        ctx.restore();
      };

      drawAtlasBracket(xTickTop, yA, xTickMid, yV - 1.5, "膜部 60%");
      drawAtlasBracket(xTickMid, yV + 1.5, xTickBot, yP, "软骨部 40%");

      const spineNxRight = Math.max(0.52, nxVP + wBand + 0.06);
      const bxRight = Math.min(w - 74, X(spineNxRight));
      const tickXRight = Math.min(w - 68, Math.max(bxRight + 6, X(0.96)));
      ctx.save();
      ctx.font = "600 9px Consolas, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#6d28d9";
      ctx.fillText(`CA ${st.ca.toFixed(3)}`, tickXRight, Math.min(supH - 15, yP + 13));

      ctx.font = "600 9px Consolas, Segoe UI, sans-serif";
      ctx.fillStyle = "#8a4b12";
      ctx.fillText(`F0 ${Math.round(st.f0)}Hz · L ×${lenFactor.toFixed(2)}`, 7, 11);
      ctx.fillStyle = "#8c453a";
      ctx.fillText(`FL ${Math.round(st.fl)} · SHIM ${Math.round(st.shim)}`, 7, 22.5);

      const gpLbl = "声门 Glottis";
      ctx.font = "600 9px Segoe UI, PingFang SC, sans-serif";
      const gpW = ctx.measureText(gpLbl).width + 10;
      const gpH = 15;
      const gpX = 7;
      const gpY = supH - 20;
      ctx.beginPath();
      ctx.setLineDash([2.5, 2.5]);
      ctx.moveTo(gpX + gpW, gpY);
      ctx.lineTo(X(0), Y(nyVP + 0.06));
      ctx.strokeStyle = "rgba(45, 58, 72, 0.36)";
      ctx.lineWidth = 1.0;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(45, 58, 72, 0.52)";
      ctx.beginPath();
      ctx.arc(X(0), Y(nyVP + 0.06), 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
      ctx.strokeStyle = "#3b4c5e";
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.roundRect(gpX, gpY - gpH * 0.5, gpW, gpH, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#1e293b";
      ctx.fillText(gpLbl, gpX + 5, gpY + 0.5);
      ctx.restore();
    }

    ctx.restore();

    // Always render vibration mode badge at top-right even when showLabels is toggled off
    ctx.save();
    ctx.font = "600 9.5px Consolas, Segoe UI, PingFang SC, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const badgeText = activeVib
      ? (isRealtime ? `实频高速 ${Math.round(st.f0 || 0)} Hz · 包络残影` : `频闪慢放 ${hzVis.toFixed(1)} Hz · 单周清晰`)
      : (isRealtime ? `实频模式（发浊音观察高速包络）` : `频闪模式（发浊音观察慢放黏膜波）`);
    const bw = ctx.measureText(badgeText).width + 12;
    ctx.fillStyle = isRealtime ? "rgba(29, 99, 184, 0.16)" : "rgba(15, 118, 110, 0.16)";
    ctx.strokeStyle = isRealtime ? "rgba(59, 130, 246, 0.55)" : "rgba(20, 184, 166, 0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(w - bw - 6, 4, bw, 17, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = isRealtime ? "#60a5fa" : "#2dd4bf";
    ctx.fillText(badgeText, w - 12, 12.5);
    ctx.restore();

    ctx.fillStyle = captionCol;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("俯视声带解剖 · 前联合↑ · 膜部 60% + 软骨部 40% (CA)↓", w * 0.5, supH - 3);

    const divY = supH + 5;
    ctx.strokeStyle = dividerCol;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(10, divY);
    ctx.lineTo(w - 10, divY);
    ctx.stroke();

    // Coronal Histological Cover-Body + Ventricle + Pressure-Responsive Upward Airflow
    const cx = w * 0.5;
    const corTop = divY + 5;
    const corBot = h - 16;
    const corH = Math.max(82, corBot - corTop);
    const R = Math.min((w - 60) * 0.44, corH * 0.51);

    const yVestTop = corTop + corH * 0.03;
    const yFalseTip = corTop + corH * 0.195;
    const yVentPocket = corTop + corH * 0.275;
    const yUp = corTop + corH * 0.435;
    const yLow = corTop + corH * 0.655;
    const yTrachBot = corTop + corH * 0.955;
    const dyFold = yLow - yUp;
    const ym = 0.5 * (yUp + yLow);

    const cmCor = R * 2.05;
    const upHalf = Math.min(R * 0.40, Math.max(0, xUp) * cmCor);
    const lowHalf = Math.min(R * 0.40, Math.max(0, xLow) * cmCor);
    const psBow = st.ps * 2.6;
    const midHalf = Math.max(0, 0.5 * (upHalf + lowHalf) + psBow);
    const covThick = Math.max(6.2, R * 0.125);
    const xOuterPad = R * 1.12;

    const buildWallSegs = dir => {
      const xVest = cx + dir * R * 0.50;
      const xFalse = cx + dir * Math.max(R * 0.25, upHalf + R * 0.15);
      const xPocket = cx + dir * R * 0.77;
      const xu = cx + dir * upHalf;
      const xl = cx + dir * lowHalf;
      const xm = cx + dir * midHalf;
      const xTrach = cx + dir * R * 0.63;
      const tmX = (xl - xu) * 0.22;
      const tmY = dyFold * 0.22;
      return [
        [xVest, yVestTop, xVest - dir * R * 0.02, yVestTop + corH * 0.075, xFalse, yFalseTip - corH * 0.065, xFalse, yFalseTip],
        [xFalse, yFalseTip, xFalse, yFalseTip + corH * 0.045, xPocket, yVentPocket - corH * 0.052, xPocket, yVentPocket],
        [xPocket, yVentPocket, xPocket, yVentPocket + corH * 0.062, xu, yUp - corH * 0.065, xu, yUp],
        [xu, yUp, xu, yUp + dyFold * 0.22, xm - tmX, ym - tmY, xm, ym],
        [xm, ym, xm + tmX, ym + tmY, xl, yLow - dyFold * 0.22, xl, yLow],
        [xl, yLow, xl, yLow + (yTrachBot - yLow) * 0.28, xTrach - dir * R * 0.03, yLow + (yTrachBot - yLow) * 0.46, xTrach, yTrachBot],
      ];
    };
    const traceSegs = (segs, moveFirst = true) => {
      if (moveFirst) ctx.moveTo(segs[0][0], segs[0][1]);
      for (const s of segs) ctx.bezierCurveTo(s[2], s[3], s[4], s[5], s[6], s[7]);
    };
    const traceSegsReversed = segs => {
      for (let i = segs.length - 1; i >= 0; i--) {
        const s = segs[i];
        ctx.bezierCurveTo(s[4], s[5], s[2], s[3], s[0], s[1]);
      }
    };

    const wallL = buildWallSegs(-1);
    const wallR = buildWallSegs(1);
    const traceLumenClip = () => {
      ctx.beginPath();
      traceSegs(wallL, true);
      ctx.lineTo(wallR[wallR.length - 1][6], wallR[wallR.length - 1][7]);
      traceSegsReversed(wallR);
      ctx.closePath();
    };

    const pLevel = Math.min(1, Math.max(0, (st.pr_pa || 0) / 1600));
    const pActive = smoothstep(0.01, 0.06, pLevel);
    const lerp3 = (c0, c1, u) => [
      Math.round(c0[0] + (c1[0] - c0[0]) * u),
      Math.round(c0[1] + (c1[1] - c0[1]) * u),
      Math.round(c0[2] + (c1[2] - c0[2]) * u),
    ];
    const rgbMain = pLevel <= 0.5
      ? lerp3([142, 198, 238], [58, 138, 218], pLevel * 2)
      : lerp3([58, 138, 218], [26, 86, 194], (pLevel - 0.5) * 2);
    const rgbJet = lerp3([150, 206, 242], [38, 114, 214], pLevel);
    const rgbPrText = lerp3([70, 122, 168], [22, 74, 178], pLevel);
    const pCol = a => `rgba(${rgbMain[0]}, ${rgbMain[1]}, ${rgbMain[2]}, ${a.toFixed(3)})`;
    const pJetCol = a => `rgba(${rgbJet[0]}, ${rgbJet[1]}, ${rgbJet[2]}, ${a.toFixed(3)})`;

    const minCorGap = Math.min(upHalf, lowHalf);
    const gapInst = smoothstep(0.25, 5.0, minCorGap);
    const vibCarry = activeVib ? Math.min(1, Math.max(0, st.ra)) * 0.45 : 0;
    const chinkLeak = smoothstep(0.012, 0.09, caPos) * 0.42;
    const jetOpen = Math.min(1, Math.max(gapInst, vibCarry, chinkLeak));
    const flowSub = Number.isFinite(st.flowSub) ? st.flowSub : st.t * 0.25;
    const flowJet = Number.isFinite(st.flowJet) ? st.flowJet : st.t * 0.55;

    if (pActive > 0.01) {
      ctx.save();
      traceLumenClip();
      ctx.clip();

      const subGlow = ctx.createLinearGradient(cx, yTrachBot, cx, yLow - 3);
      subGlow.addColorStop(0, pCol((0.08 + 0.34 * pLevel) * pActive));
      subGlow.addColorStop(0.55, pCol((0.05 + 0.24 * pLevel) * pActive));
      subGlow.addColorStop(1, pCol((0.03 + 0.16 * pLevel) * pActive));
      ctx.fillStyle = subGlow;
      ctx.fillRect(cx - R, yLow - 5, R * 2, yTrachBot - yLow + 7);

      const shutCushion = (1 - smoothstep(0.4, 2.4, minCorGap)) * smoothstep(0.15, 0.5, pLevel);
      if (shutCushion > 0.01) {
        const cushGrad = ctx.createRadialGradient(cx, yLow + 6, 1.5, cx, yLow + 8, R * 0.42);
        cushGrad.addColorStop(0, pCol((0.18 + 0.32 * pLevel) * pActive * shutCushion));
        cushGrad.addColorStop(0.65, pCol((0.08 + 0.16 * pLevel) * pActive * shutCushion));
        cushGrad.addColorStop(1, pCol(0));
        ctx.fillStyle = cushGrad;
        ctx.fillRect(cx - R * 0.6, yLow - 2, R * 1.2, R * 0.55);
      }

      const stBaseAlpha = (0.14 + 0.48 * pLevel) * pActive * jetOpen;
      if (stBaseAlpha > 0.01) {
        const stGrad = ctx.createLinearGradient(cx, yTrachBot, cx, yVestTop);
        stGrad.addColorStop(0, pJetCol(0.08 * stBaseAlpha));
        stGrad.addColorStop(0.28, pJetCol(stBaseAlpha));
        stGrad.addColorStop(0.64, pJetCol(0.86 * stBaseAlpha));
        stGrad.addColorStop(1, pJetCol(0));
        ctx.strokeStyle = stGrad;
        ctx.lineCap = "round";
        ctx.lineWidth = 0.75 + 1.15 * pLevel;
        const dOn = 4.5 + 7.5 * pLevel;
        const dOff = 8.0 - 2.0 * pLevel;
        ctx.setLineDash([dOn, dOff]);
        ctx.lineDashOffset = -(flowJet * 26);
        for (let s = -2; s <= 2; s++) {
          const sFrac = s / 2.35;
          const sx0 = cx + sFrac * (R * 0.50);
          const sxL = cx + sFrac * Math.max(0.8, lowHalf * 0.80);
          const sxM = cx + sFrac * Math.max(0.6, midHalf * 0.78);
          const sxU = cx + sFrac * Math.max(0.8, upHalf * 0.80);
          const sxF = cx + sFrac * Math.max(upHalf * 0.9, R * 0.30);
          const sxT = cx + sFrac * (R * 0.36);
          ctx.beginPath();
          ctx.moveTo(sx0, yTrachBot);
          ctx.bezierCurveTo(sx0, yTrachBot - (yTrachBot - yLow) * 0.42, sxL, yLow + (yTrachBot - yLow) * 0.25, sxL, yLow);
          ctx.bezierCurveTo(sxL, yLow - dyFold * 0.32, sxM, ym + dyFold * 0.25, sxM, ym);
          ctx.bezierCurveTo(sxM, ym - dyFold * 0.25, sxU, yUp + dyFold * 0.32, sxU, yUp);
          ctx.bezierCurveTo(sxU, yUp - (yUp - yFalseTip) * 0.45, sxF, yFalseTip + (yUp - yFalseTip) * 0.35, sxF, yFalseTip);
          ctx.bezierCurveTo(sxF, yFalseTip - (yFalseTip - yVestTop) * 0.45, sxT, yVestTop + (yFalseTip - yVestTop) * 0.35, sxT, yVestTop);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }

      const jetBaseAlpha = (0.12 + 0.36 * pLevel) * pActive * jetOpen;
      if (jetBaseAlpha > 0.01) {
        const yPlumeTop = yUp - (yUp - yVestTop) * (0.45 + 0.55 * pLevel);
        const pGrad = ctx.createLinearGradient(cx, yUp, cx, yPlumeTop);
        pGrad.addColorStop(0, pJetCol(jetBaseAlpha));
        pGrad.addColorStop(0.55, pJetCol(0.54 * jetBaseAlpha));
        pGrad.addColorStop(1, pJetCol(0));
        const pWBot = Math.max(2.4, Math.min(R * 0.22, upHalf * 0.85 + 2.0));
        const pWTop = Math.max(6.2, pWBot * (1.85 + 0.35 * pLevel));
        ctx.fillStyle = pGrad;
        ctx.beginPath();
        ctx.moveTo(cx - pWBot, yUp + 2);
        ctx.quadraticCurveTo(cx - pWTop * 0.72, (yUp + yPlumeTop) * 0.52, cx - pWTop, yPlumeTop);
        ctx.lineTo(cx + pWTop, yPlumeTop);
        ctx.quadraticCurveTo(cx + pWTop * 0.72, (yUp + yPlumeTop) * 0.52, cx + pWBot, yUp + 2);
        ctx.closePath();
        ctx.fill();

        const chevSpan = Math.max(10, yUp - 3 - (yVestTop + 6));
        const chevHW = Math.min(R * 0.14, 6.2 + 1.8 * pLevel);
        const chevDy = 4.2 + 1.0 * pLevel;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = 1.0 + 1.15 * pLevel;
        const thirdGate = smoothstep(0.35, 0.72, pLevel);
        for (let k = 0; k < 3; k++) {
          const u = (k / 3 + ((flowJet * 0.62) % 1)) % 1;
          const cyChev = (yUp - 3) - u * chevSpan;
          const gate = k === 2 ? thirdGate : 1;
          const aChev = Math.sin(Math.PI * u) * (0.20 + 0.58 * pLevel) * pActive * jetOpen * gate;
          if (aChev > 0.01) {
            ctx.strokeStyle = pCol(aChev);
            ctx.beginPath();
            ctx.moveTo(cx - chevHW, cyChev + chevDy);
            ctx.quadraticCurveTo(cx, cyChev - 1.2, cx, cyChev);
            ctx.quadraticCurveTo(cx, cyChev - 1.2, cx + chevHW, cyChev + chevDy);
            ctx.stroke();
          }
        }
      }

      const nSub = 165;
      for (let i = 0; i < nSub; i++) {
        const [rx, ry, rz] = M27_AIR_DOTS[i % M27_AIR_DOTS.length];
        const frac = i / nSub;
        const densGate = smoothstep(frac - 0.14, frac + 0.08, 0.12 + 0.94 * pLevel);
        if (densGate <= 0.02) continue;
        const u = (ry + ((flowSub * 0.48) % 1)) % 1;
        const yy = yTrachBot - 2 - u * Math.max(6, yTrachBot - yLow - 2);
        const domeSpan = lowHalf + (R * 0.58 - lowHalf) * Math.pow(1 - u, 0.58);
        const xx = cx + rx * Math.max(1.5, domeSpan - 2.5);
        const edgeFade = Math.sin(Math.PI * Math.min(0.95, Math.max(0.05, u)));
        const a = densGate * pActive * (0.26 + 0.52 * pLevel) * (0.45 + 0.55 * edgeFade);
        if (a > 0.02) {
          ctx.fillStyle = pCol(a);
          ctx.beginPath();
          ctx.arc(xx, yy, 0.90 + 0.48 * pLevel + 0.32 * rz, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (jetOpen * pActive > 0.01) {
        const nJet = 52;
        ctx.lineCap = "round";
        for (let i = 0; i < nJet; i++) {
          const [rx, ry, rz] = M27_AIR_DOTS[(i * 3 + 17) % M27_AIR_DOTS.length];
          const frac = i / nJet;
          const densGate = smoothstep(frac - 0.14, frac + 0.08, 0.15 + 0.90 * pLevel);
          if (densGate <= 0.02) continue;
          const u = (ry + ((flowJet * 0.52) % 1)) % 1;
          const yy = yLow - u * Math.max(8, yLow - yVestTop - 2);
          const inGlottis = yy >= yUp && yy <= yLow;
          const tGlot = inGlottis ? (yLow - yy) / Math.max(1, dyFold) : 0;
          const spanW = inGlottis
            ? Math.max(1.5, lowHalf + (upHalf - lowHalf) * tGlot - 1.5)
            : (yy > yVentPocket ? Math.max(upHalf, R * 0.36) : R * 0.42);
          const xx = cx + rx * spanW;
          const a = densGate * (0.22 + 0.54 * pLevel) * pActive * jetOpen * Math.sin(Math.PI * u);
          if (a > 0.02) {
            const halfLen = inGlottis ? 1.4 + 3.2 * pLevel : 0.8 + 1.8 * pLevel;
            ctx.strokeStyle = pJetCol(a);
            ctx.lineWidth = 1.0 + 0.65 * pLevel + 0.25 * rz;
            ctx.beginPath();
            ctx.moveTo(xx, yy + halfLen);
            ctx.lineTo(xx, yy - halfLen);
            ctx.stroke();
          }
        }
      }

      ctx.restore();
    }

    for (const dir of [-1, 1]) {
      const segs = dir < 0 ? wallL : wallR;
      const xFalse = segs[0][6];
      const xu = cx + dir * upHalf;
      const xl = cx + dir * lowHalf;
      const xm = cx + dir * midHalf;
      const xTrach = cx + dir * R * 0.63;
      const xOuter = cx + dir * xOuterPad;

      ctx.save();

      ctx.beginPath();
      traceSegs(segs.slice(0, 2), true);
      ctx.lineTo(xOuter, yVentPocket);
      ctx.lineTo(xOuter, yVestTop);
      ctx.closePath();
      const falseGrad = ctx.createLinearGradient(xFalse, yFalseTip, xOuter, yFalseTip);
      falseGrad.addColorStop(0, "rgba(240, 172, 180, 0.52)");
      falseGrad.addColorStop(0.55, "rgba(247, 206, 211, 0.24)");
      falseGrad.addColorStop(0.95, panelBgZero);
      ctx.fillStyle = falseGrad;
      ctx.fill();

      ctx.beginPath();
      traceSegs(segs.slice(2), true);
      ctx.lineTo(xOuter, yTrachBot);
      ctx.lineTo(xOuter, yVentPocket);
      ctx.closePath();
      const covGrad = ctx.createLinearGradient(cx + dir * Math.min(upHalf, lowHalf), ym, xOuter, ym);
      covGrad.addColorStop(0, "#f2949e");
      covGrad.addColorStop(0.36, "#f6b5bd");
      covGrad.addColorStop(0.74, "#fadadd");
      covGrad.addColorStop(0.96, panelBgZero);
      ctx.fillStyle = covGrad;
      ctx.fill();

      const bu = xu + dir * covThick;
      const bm = xm + dir * covThick;
      const bl = xl + dir * covThick;
      const yB0 = yUp + covThick * 0.92;
      const yB1 = yLow + covThick * 0.18;
      const ymB = 0.5 * (yB0 + yB1);
      const bmX = (bl - bu) * 0.20;
      const bmY = (yB1 - yB0) * 0.24;

      const traceBodyCore = closeOuter => {
        ctx.beginPath();
        ctx.moveTo(xOuter, yUp + covThick * 0.42);
        ctx.bezierCurveTo(
          cx + dir * R * 0.72, yUp + covThick * 0.38,
          bu, yUp + covThick * 0.48,
          bu, yB0
        );
        ctx.bezierCurveTo(
          bu, yB0 + (yB1 - yB0) * 0.24,
          bm - bmX, ymB - bmY,
          bm, ymB
        );
        ctx.bezierCurveTo(
          bm + bmX, ymB + bmY,
          bl, yB1 - (yB1 - yB0) * 0.24,
          bl, yB1
        );
        ctx.bezierCurveTo(
          bl, yB1 + (yTrachBot - yB1) * 0.32,
          xTrach + dir * covThick * 0.95, yB1 + (yTrachBot - yB1) * 0.62,
          closeOuter ? xOuter : xTrach + dir * (covThick * 1.15), yTrachBot
        );
        if (closeOuter) ctx.closePath();
      };

      traceBodyCore(true);
      const bodyGrad = ctx.createLinearGradient(bu, ym, xOuter, ym);
      bodyGrad.addColorStop(0, "#9f4b56");
      bodyGrad.addColorStop(0.42, "#bf747d");
      bodyGrad.addColorStop(0.78, "#e5bfc3");
      bodyGrad.addColorStop(0.96, panelBgZero);
      ctx.fillStyle = bodyGrad;
      ctx.fill();

      traceBodyCore(false);
      const lpStrokeGrad = ctx.createLinearGradient(bu, ym, xOuter, ym);
      lpStrokeGrad.addColorStop(0, "rgba(242, 171, 181, 0.92)");
      lpStrokeGrad.addColorStop(0.55, "rgba(242, 171, 181, 0.52)");
      lpStrokeGrad.addColorStop(0.90, "rgba(242, 171, 181, 0)");
      lpStrokeGrad.addColorStop(1, "rgba(242, 171, 181, 0)");
      ctx.strokeStyle = lpStrokeGrad;
      ctx.lineWidth = 1.3;
      ctx.lineCap = "round";
      ctx.stroke();

      if (isRealtime && activeVib && vibAmp > 0.003) {
        for (const dphi of [-2.1, -1.05, 0, 1.05, 2.1]) {
          const mPhi = evalMemX(dphi);
          const uPhi = Math.min(R * 0.40, Math.max(0, mPhi.up) * cmCor);
          const lPhi = Math.min(R * 0.40, Math.max(0, mPhi.low) * cmCor);
          const mHalfPhi = Math.max(0, 0.5 * (uPhi + lPhi) + psBow);
          const xuP = cx + dir * uPhi, xlP = cx + dir * lPhi, xmP = cx + dir * mHalfPhi;
          const tmXp = (xlP - xuP) * 0.22, tmYp = dyFold * 0.22;
          ctx.beginPath();
          ctx.moveTo(xuP, yUp);
          ctx.bezierCurveTo(xuP, yUp + dyFold * 0.22, xmP - tmXp, ym - tmYp, xmP, ym);
          ctx.bezierCurveTo(xmP + tmXp, ym + tmYp, xlP, yLow - dyFold * 0.22, xlP, yLow);
          ctx.strokeStyle = "rgba(244, 63, 94, 0.36)";
          ctx.lineWidth = 1.45;
          ctx.lineCap = "round";
          ctx.stroke();
        }
      }

      ctx.beginPath();
      traceSegs(segs, true);
      ctx.strokeStyle = "#bf1d50";
      ctx.lineWidth = 1.85;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();

      ctx.fillStyle = "#1d63b8";
      ctx.strokeStyle = panelBg;
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.arc(xu, yUp, 2.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#15803d";
      ctx.beginPath();
      ctx.arc(xl, yLow, 2.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.restore();
    }

    if (showLabels) {
      ctx.save();
      ctx.font = "600 9.5px Segoe UI, PingFang SC, sans-serif";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillStyle = captionCol;
      ctx.fillText("室带 / 喉室", 7, yVentPocket - 2);
      ctx.fillStyle = "#b91c4b";
      ctx.fillText("Cover 黏膜层", 7, yUp + 2);
      ctx.fillStyle = "#7f303b";
      ctx.fillText("Body 声带肌", 7, yUp + dyFold * 0.78);
      ctx.font = "600 9px Consolas, monospace";
      ctx.fillStyle = `rgb(${rgbPrText[0]}, ${rgbPrText[1]}, ${rgbPrText[2]})`;
      ctx.fillText(`PR ${st.pr_pa.toFixed(0)} Pa`, 7, yTrachBot - 11);
      ctx.fillStyle = "rgba(148, 175, 205, 0.24)";
      ctx.beginPath();
      ctx.roundRect(7, yTrachBot - 5.2, 48, 3.5, 1.75);
      ctx.fill();
      if (pLevel > 0.005) {
        ctx.fillStyle = pCol(0.92);
        ctx.beginPath();
        ctx.roundRect(7, yTrachBot - 5.2, Math.max(2.0, 48 * pLevel), 3.5, 1.75);
        ctx.fill();
      }

      ctx.textAlign = "right";
      ctx.fillStyle = "#1d63b8";
      ctx.fillText(`XT ${st.xt.toFixed(3)}`, w - 7, yUp);
      ctx.fillStyle = "#15803d";
      ctx.fillText(`XB ${st.xb.toFixed(3)}`, w - 7, yLow);
      ctx.fillStyle = "#7f303b";
      ctx.fillText(`RA ${st.ra.toFixed(2)} · PS ${st.ps.toFixed(2)}`, w - 7, yLow + (yTrachBot - yLow) * 0.48);
      ctx.fillStyle = "#4b5b53";
      ctx.fillText(`LAG ${st.lag.toFixed(2)}`, w - 7, yTrachBot - 6);
      ctx.restore();
    }

    ctx.fillStyle = captionCol;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("冠状面喉室 · Cover–Body 黏膜波与声门下气压", cx, h - 7);
  }

  // --------------------------------------------------------------------------
  // 7-Lane Articulator & Glottal Kinematics Trajectory Canvas
  // --------------------------------------------------------------------------
  function getCurveVal(obj, ser) {
    if (!obj) return ser.min;
    const v = ser.lmIdx !== undefined ? (obj.lm ? obj.lm[ser.lmIdx] : undefined) : obj[ser.k];
    return Number.isFinite(v) ? v : ser.min;
  }

  function getCurvesLanes(frames, curveMode = "all") {
    let maxF0 = 320, maxPR = 1200;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].f0 > maxF0) maxF0 = frames[i].f0;
      if (frames[i].pr_pa > maxPR) maxPR = frames[i].pr_pa;
    }
    maxF0 = Math.ceil(maxF0 / 40) * 40;
    maxPR = Math.ceil(maxPR / 200) * 200;

    const tractLanes = [
      {
        title: "唇颌开合",
        series: [
          { k: "ja", label: "JA", col: "#0f766e", min: -7.0, max: 0.0, unit: "", dec: 2 },
          { k: "ld", label: "LD", col: "#1d63b8", min: -0.5, max: 2.5, unit: "", dec: 2 },
          { k: "lp", label: "LP", col: "#7c3aed", min: -1.0, max: 1.0, unit: "", dec: 2 },
        ],
      },
      {
        title: "舌体/舌叶",
        series: [
          { lmIdx: 0, label: "TCX", col: "#b45309", min: -2.5, max: 3.5, unit: "", dec: 2 },
          { lmIdx: 1, label: "TCY", col: "#c93b4b", min: -3.0, max: 0.8, unit: "", dec: 2 },
          { lmIdx: 4, label: "TBX", col: "#15803d", min: -2.0, max: 5.0, unit: "", dec: 2 },
          { lmIdx: 5, label: "TBY", col: "#0369a1", min: -3.0, max: 4.5, unit: "", dec: 2 },
        ],
      },
      {
        title: "舌尖/舌根",
        series: [
          { lmIdx: 2, label: "TTX", col: "#be185d", min: 1.5, max: 6.0, unit: "", dec: 2 },
          { lmIdx: 3, label: "TTY", col: "#6d4aff", min: -3.0, max: 2.5, unit: "", dec: 2 },
          { lmIdx: 6, label: "TRX", col: "#237768", min: -4.0, max: 1.0, unit: "", dec: 2 },
          { lmIdx: 7, label: "TRY", col: "#c2410c", min: -6.0, max: 0.0, unit: "", dec: 2 },
        ],
      },
    ];
    const glottisLanes = [
      {
        title: "声源激励",
        series: [
          { k: "f0", label: "F0", col: "#b45309", min: 40, max: maxF0, unit: "Hz", dec: 0 },
          { k: "pr_pa", label: "PR", col: "#c93b4b", min: 0, max: maxPR, unit: "Pa", dec: 0, fill: "rgba(201,59,75,0.12)" },
        ],
      },
      {
        title: "声门几何",
        zeroLine: 0.0,
        zeroRange: [-0.05, 0.30],
        series: [
          { k: "xb", label: "XB", col: "#15803d", min: -0.05, max: 0.30, unit: "", dec: 3 },
          { k: "xt", label: "XT", col: "#1d63b8", min: -0.05, max: 0.30, unit: "", dec: 3 },
          { k: "ca", label: "CA", col: "#7c3aed", min: -0.05, max: 0.30, unit: "", dec: 3 },
        ],
      },
      {
        title: "声门动力",
        zeroLine: 0.0,
        zeroRange: [-1.0, 1.0],
        series: [
          { k: "ra", label: "RA", col: "#be185d", min: -1.0, max: 1.0, unit: "", dec: 2 },
          { k: "lag", label: "LAG", col: "#0369a1", min: 0.0, max: 3.1416, unit: "", dec: 2 },
          { k: "ps", label: "PS", col: "#0f766e", min: -1.0, max: 1.0, unit: "", dec: 2 },
        ],
      },
      {
        title: "微扰/鼻音",
        series: [
          { k: "fl", label: "FL", col: "#c2410c", min: 0, max: 100, unit: "", dec: 0 },
          { k: "shim", label: "SHIM", col: "#b91c1c", min: 0, max: 100, unit: "", dec: 0 },
          { k: "vo", label: "VO", col: "#237768", min: -0.1, max: 1.5, unit: "", dec: 2, dash: [4, 3] },
        ],
      },
    ];
    if (curveMode === "tract") return tractLanes;
    if (curveMode === "glottis") return glottisLanes;
    return [...tractLanes, ...glottisLanes];
  }

  function getCurvesLayout(w, h, nLanes = 7) {
    const padL = 8, padR = 8, padT = 5, padB = 5, gap = 4, n = Math.max(1, nLanes);
    const laneH = (h - padT - padB - gap * (n - 1)) / n;
    return { padL, plotW: Math.max(40, w - padL - padR), padT, gap, laneH };
  }

  function drawM27CurvesCanvas(canvas, anim, st, opts = {}) {
    const pal = opts.theme || {};
    if (!anim || !anim.frames?.length || !st) {
      drawVizEmpty(canvas, "等待参数轨迹...", pal);
      return;
    }
    const curveMode = opts.curveMode || "all";
    const jobId = opts.jobId || "";
    const cache = opts.cache || {};
    const { ctx, w, h } = setupVizCanvas(canvas);
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const frames = anim.frames;
    const dur = Math.max(0.02, anim.duration_sec || frames[frames.length - 1].t || 1);
    const lanes = getCurvesLanes(frames, curveMode);
    const lay = getCurvesLayout(w, h, lanes.length);

    const curvesBg = pal.curvesBg || "#fffef9";
    const laneBg = pal.laneBg || "#f7f9f3";
    const laneBorder = pal.laneBorder || "#dce2d5";
    const laneTitle = pal.laneTitle || "#5c6b63";
    const zeroLine = pal.zeroLine || "rgba(105, 119, 111, 0.30)";
    const playhead = pal.playhead || "rgba(35, 119, 104, 0.78)";
    const dotStroke = pal.dotStroke || "#fffef9";

    const bgKey = `${curvesBg}:${laneBg}:${laneBorder}:${curveMode}:${jobId}:${w}x${h}:${dpr}:${frames.length}`;
    if (cache.bgKey !== bgKey) {
      cache.bgKey = bgKey;
      const off = document.createElement("canvas");
      off.width = Math.round(w * dpr);
      off.height = Math.round(h * dpr);
      const octx = off.getContext("2d");
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);

      octx.fillStyle = curvesBg;
      octx.fillRect(0, 0, w, h);

      lanes.forEach((lane, li) => {
        const ly = lay.padT + li * (lay.laneH + lay.gap);
        const headerH = 15;
        const plotT = ly + headerH;
        const plotB = ly + lay.laneH - 3;
        const plotH = Math.max(12, plotB - plotT);

        octx.fillStyle = laneBg;
        octx.strokeStyle = laneBorder;
        octx.lineWidth = 1;
        octx.beginPath();
        octx.roundRect(lay.padL, ly, lay.plotW, lay.laneH, 6);
        octx.fill();
        octx.stroke();

        const mapX = t => lay.padL + 3 + (Math.min(dur, Math.max(0, t)) / dur) * (lay.plotW - 6);
        const mapY = (val, vmin, vmax) => {
          const u = Math.min(1, Math.max(0, (val - vmin) / (vmax - vmin)));
          return plotB - u * plotH;
        };

        if (lane.zeroLine !== undefined && lane.zeroRange) {
          const zy = mapY(lane.zeroLine, lane.zeroRange[0], lane.zeroRange[1]);
          octx.save();
          octx.setLineDash([3, 3]);
          octx.strokeStyle = zeroLine;
          octx.lineWidth = 0.85;
          octx.beginPath();
          octx.moveTo(lay.padL + 3, zy);
          octx.lineTo(lay.padL + lay.plotW - 3, zy);
          octx.stroke();
          octx.restore();
        }

        lane.series.forEach(ser => {
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

      cache.bgCanvas = off;
    }

    if (cache.bgCanvas) {
      ctx.drawImage(cache.bgCanvas, 0, 0, w, h);
    }

    const px = lay.padL + 3 + (Math.min(dur, Math.max(0, st.t)) / dur) * (lay.plotW - 6);

    lanes.forEach((lane, li) => {
      const ly = lay.padT + li * (lay.laneH + lay.gap);
      const headerH = 15;
      const plotT = ly + headerH;
      const plotB = ly + lay.laneH - 3;
      const plotH = Math.max(12, plotB - plotT);

      ctx.save();
      ctx.strokeStyle = playhead;
      ctx.lineWidth = 1.35;
      ctx.beginPath();
      ctx.moveTo(px, ly + 2);
      ctx.lineTo(px, ly + lay.laneH - 2);
      ctx.stroke();
      ctx.restore();

      let lx = lay.padL + 7;
      ctx.font = "600 9.5px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = laneTitle;
      ctx.fillText(lane.title, lx, ly + 8);
      lx += ctx.measureText(lane.title).width + 10;

      ctx.font = "600 9.5px Consolas, monospace";
      lane.series.forEach(ser => {
        const val = getCurveVal(st, ser);
        const u = Math.min(1, Math.max(0, (val - ser.min) / (ser.max - ser.min)));
        const cy = plotB - u * plotH;

        ctx.fillStyle = ser.col;
        ctx.beginPath();
        ctx.arc(px, cy, 2.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = dotStroke;
        ctx.lineWidth = 1.1;
        ctx.stroke();

        const txt = `${ser.label} ${val.toFixed(ser.dec)}${ser.unit ? " " + ser.unit : ""}`;
        ctx.fillStyle = ser.col;
        ctx.fillText(txt, lx, ly + 8);
        lx += ctx.measureText(txt).width + 10;
      });
    });
  }

export { readThemePalette, renderM27TractSvg, interpM27AnimState, getM27GlottisVisHz,
  drawM27GlottisCanvas, drawM27CurvesCanvas, getCurvesLayout };
