/**
 * Local-only webcam MediaPipe 3D FaceLandmarker controller, 3D adaptive landmark stabilizer,
 * head rigid-pose solver, dynamic facial expression rig, and anatomical face-to-VTL head appearance calibrator.
 *
 * Coordinate convention in VTL 3D space (units: cm):
 *   +X: Anterior (forward out of nose/lips)
 *   +Y: Superior (upward toward crown)
 *   +Z: Subject's Left cheek (-Z is Subject's Right cheek; Z = 0 is midsagittal plane)
 */
import {
  FACE_BOUNDS_INDICES,
  FACE_OVAL_INDICES,
  INNER_LIP_INDICES,
  LANDMARK_NEIGHBORS,
  OUTER_LIP_INDICES,
} from './face-mesh-topology';

export interface CameraDeviceOption {
  deviceId: string;
  label: string;
}

export interface VisualLipMetrics {
  openRatio: number;
  outerWidthRatio: number;
  areaRatio: number;
  circularity: number;
  jawOpenBlend: number;
  mouthPuckerBlend: number;
  mouthSmileBlend: number;
}

export interface FaceExpressionState {
  /** 0..1 overall jaw drop from visual landmarks + blendshapes */
  jawOpen: number;
  /** -1..+1 lateral jaw shift (+1 toward subject left +Z) */
  jawSide: number;
  /** 0..1 jaw anterior protrusion */
  jawForward: number;
  /** 0..1 lip rounding / funnel / pucker */
  lipPucker: number;
  /** 0..1 mouth corner smile / horizontal stretch (left & right) */
  smileLeft: number;
  smileRight: number;
  /** 0..1 mouth corner frown / pull down */
  frown: number;
  /** 0..1 upper lip lift & lower lip depressor */
  upperLipUp: number;
  lowerLipDown: number;
  /** 0..1 cheek squint / apple-cheek raise */
  cheekRaiseLeft: number;
  cheekRaiseRight: number;
  /** -1..+1 eyebrow vertical motion (+up / -frown down) */
  browLeft: number;
  browRight: number;
  /** 0..1 eyelid blink closure */
  blinkLeft: number;
  blinkRight: number;
  /** 0..1 nasal alar flare / sneer */
  noseSneer: number;
}

export interface HeadPoseAngles {
  yawRad: number;
  pitchRad: number;
  rollRad: number;
}

export interface FaceAppearanceProfile {
  calibratedFrames: number;
  cheekWidthRatio: number;
  jawWidthRatio: number;
  chinLengthRatio: number;
  foreheadRatio: number;
  noseBridgeRatio: number;
  noseWidthRatio: number;
  mouthWidthRatio: number;
}

export interface FaceFrameUpdate {
  detected: boolean;
  /** 478 * 3 coordinates mapped into VTL head cm space (canonical head-local frame). */
  vtlPointsCm: Float32Array | null;
  pose: HeadPoseAngles;
  metrics: VisualLipMetrics;
  expression: FaceExpressionState;
  appearance: FaceAppearanceProfile;
  inferenceMs: number;
  fps: number;
  delegate: string;
}

export function defaultAppearanceProfile(): FaceAppearanceProfile {
  return {
    calibratedFrames: 0,
    cheekWidthRatio: 1.0,
    jawWidthRatio: 1.0,
    chinLengthRatio: 1.0,
    foreheadRatio: 1.0,
    noseBridgeRatio: 1.0,
    noseWidthRatio: 1.0,
    mouthWidthRatio: 1.0,
  };
}

export function defaultVisualLipMetrics(): VisualLipMetrics {
  return {
    openRatio: 0,
    outerWidthRatio: 0.36,
    areaRatio: 0,
    circularity: 0,
    jawOpenBlend: 0,
    mouthPuckerBlend: 0,
    mouthSmileBlend: 0,
  };
}

export function defaultFaceExpression(): FaceExpressionState {
  return {
    jawOpen: 0,
    jawSide: 0,
    jawForward: 0,
    lipPucker: 0,
    smileLeft: 0,
    smileRight: 0,
    frown: 0,
    upperLipUp: 0,
    lowerLipDown: 0,
    cheekRaiseLeft: 0,
    cheekRaiseRight: 0,
    browLeft: 0,
    browRight: 0,
    blinkLeft: 0,
    blinkRight: 0,
    noseSneer: 0,
  };
}

export async function listCameraDevices(): Promise<CameraDeviceOption[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const cams = all.filter((d) => d.kind === 'videoinput');
    return cams.map((d, idx) => ({
      deviceId: d.deviceId,
      label: d.label?.trim() || `摄像头 ${idx + 1}`,
    }));
  } catch {
    return [];
  }
}

/**
 * 3D extension of PhoneticToolbox M05 LandmarkStabilizer:
 * neighbor-averaged speed adaptive One-Euro low-pass filter on (x, y, z).
 */
class LandmarkStabilizer3D {
  private est: Float32Array | null = null;
  private prev: Float32Array | null = null;
  private deriv: Float32Array | null = null;
  private lastTimeSec: number | null = null;
  private readonly minCutoffHz: number;

  constructor(minCutoffHz = 14) {
    this.minCutoffHz = minCutoffHz;
  }

  reset(): void {
    this.est = null;
    this.prev = null;
    this.deriv = null;
    this.lastTimeSec = null;
  }

  filter(raw: Float32Array, timeSec: number): Float32Array {
    const nPts = Math.floor(raw.length / 3);
    if (!this.est || !this.prev || !this.deriv || this.lastTimeSec === null || this.est.length !== raw.length) {
      this.est = raw.slice();
      this.prev = raw.slice();
      this.deriv = new Float32Array(raw.length);
      this.lastTimeSec = timeSec;
      return raw.slice();
    }
    if (timeSec <= this.lastTimeSec) {
      return this.est.slice();
    }

    const dt = Math.min(timeSec - this.lastTimeSec, 0.25);
    const dCutoff = 1.0;
    const ad = dt / (1 / (2 * Math.PI * dCutoff) + dt);

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < nPts; i++) {
      const x = this.est[i * 3];
      const y = this.est[i * 3 + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const faceScale = Math.max(1e-3, Math.hypot(maxX - minX, maxY - minY));

    const speeds = new Float32Array(nPts);
    for (let i = 0; i < nPts; i++) {
      const b = i * 3;
      const dx = ad * ((raw[b] - this.prev[b]) / dt) + (1 - ad) * this.deriv[b];
      const dy = ad * ((raw[b + 1] - this.prev[b + 1]) / dt) + (1 - ad) * this.deriv[b + 1];
      const dz = ad * ((raw[b + 2] - this.prev[b + 2]) / dt) + (1 - ad) * this.deriv[b + 2];
      this.deriv[b] = dx;
      this.deriv[b + 1] = dy;
      this.deriv[b + 2] = dz;
      speeds[i] = Math.hypot(dx, dy);
    }

    const out = new Float32Array(raw.length);
    for (let i = 0; i < nPts; i++) {
      const nb = i < LANDMARK_NEIGHBORS.length ? LANDMARK_NEIGHBORS[i] : [];
      let sumSpd = speeds[i];
      let cnt = 1;
      for (let k = 0; k < nb.length; k++) {
        const j = nb[k];
        if (j < nPts) {
          sumSpd += speeds[j];
          cnt++;
        }
      }
      const avgSpd = sumSpd / cnt;
      const effSpd = Math.max(0, avgSpd - 0.11 * faceScale);
      const cutoff = this.minCutoffHz + 0.08 * effSpd;
      const tau = 1 / (2 * Math.PI * Math.max(cutoff, 1e-4));
      const alpha = dt / (tau + dt);

      const b = i * 3;
      const rx = raw[b] - this.est[b];
      const ry = raw[b + 1] - this.est[b + 1];
      const rz = raw[b + 2] - this.est[b + 2];
      const res2d = Math.hypot(rx, ry) - 0.01 * faceScale;
      const gate = Math.max(0, Math.min(1, res2d / Math.max(1e-5, 0.014 * faceScale)));
      const gainXY = Math.max(alpha, gate);
      const gainZ = Math.min(gainXY, alpha * 0.72 + 0.04);

      out[b] = this.est[b] + gainXY * rx;
      out[b + 1] = this.est[b + 1] + gainXY * ry;
      out[b + 2] = this.est[b + 2] + gainZ * rz;
    }

    this.prev.set(raw);
    this.est.set(out);
    this.lastTimeSec = timeSec;
    return out;
  }
}

function polygonArea2D(pts: Float32Array, indices: readonly number[], aspectX: number): number {
  let sum = 0;
  const n = indices.length;
  for (let i = 0; i < n; i++) {
    const a = indices[i] * 3;
    const b = indices[(i + 1) % n] * 3;
    sum += pts[a] * aspectX * pts[b + 1] - pts[b] * aspectX * pts[a + 1];
  }
  return 0.5 * Math.abs(sum);
}

function polygonPerimeter2D(pts: Float32Array, indices: readonly number[], aspectX: number): number {
  let len = 0;
  const n = indices.length;
  for (let i = 0; i < n; i++) {
    const a = indices[i] * 3;
    const b = indices[(i + 1) % n] * 3;
    len += Math.hypot((pts[b] - pts[a]) * aspectX, pts[b + 1] - pts[a + 1]);
  }
  return len;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Calibrates speaker facial proportions from canonical de-rotated 3D landmarks,
 * extracts real-time facial expression controls, and maps 478 landmarks into VTL cm space.
 */
export class FaceAppearanceCalibrator {
  private profile: FaceAppearanceProfile = defaultAppearanceProfile();
  private smoothPose: HeadPoseAngles = { yawRad: 0, pitchRad: 0, rollRad: 0 };
  private smoothExpr: FaceExpressionState = defaultFaceExpression();

  reset(): void {
    this.profile = defaultAppearanceProfile();
    this.smoothPose = { yawRad: 0, pitchRad: 0, rollRad: 0 };
    this.smoothExpr = defaultFaceExpression();
  }

  get currentProfile(): FaceAppearanceProfile {
    return { ...this.profile };
  }

  processLandmarks(
    pts: Float32Array,
    width: number,
    height: number,
    blendshapes: Record<string, number> | null,
    adaptAppearance: boolean,
  ): {
    vtlPointsCm: Float32Array;
    pose: HeadPoseAngles;
    metrics: VisualLipMetrics;
    expression: FaceExpressionState;
    appearance: FaceAppearanceProfile;
  } {
    const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
    const nPts = Math.min(478, Math.floor(pts.length / 3));

    // Aspect-corrected camera space:
    //   cx: right on image (= subject's left cheek, +Z in VTL)
    //   cy: upward (= +Y in VTL)
    //   cz: forward toward camera (= +X in VTL; MediaPipe z is negative toward camera)
    const cam = new Float32Array(nPts * 3);
    for (let i = 0; i < nPts; i++) {
      const u = pts[i * 3];
      const v = pts[i * 3 + 1];
      const z = pts[i * 3 + 2];
      cam[i * 3] = (u - 0.5) * aspect;
      cam[i * 3 + 1] = -(v - 0.5);
      cam[i * 3 + 2] = -z * aspect;
    }

    const pt = (idx: number): [number, number, number] => [
      cam[idx * 3],
      cam[idx * 3 + 1],
      cam[idx * 3 + 2],
    ];

    // Rigid cranial frame from upper-face landmarks (immune to jaw drop)
    const pEyeR = pt(33);
    const pEyeL = pt(263);
    const pSubnasal = pt(2);
    const pForehead = pt(10);

    let latX = pEyeL[0] - pEyeR[0];
    let latY = pEyeL[1] - pEyeR[1];
    let latZ = pEyeL[2] - pEyeR[2];
    const eyeSpan = Math.hypot(latX, latY, latZ) || 1e-4;
    latX /= eyeSpan;
    latY /= eyeSpan;
    latZ /= eyeSpan;

    let upX = pForehead[0] - pSubnasal[0];
    let upY = pForehead[1] - pSubnasal[1];
    let upZ = pForehead[2] - pSubnasal[2];
    const dotUL = upX * latX + upY * latY + upZ * latZ;
    upX -= dotUL * latX;
    upY -= dotUL * latY;
    upZ -= dotUL * latZ;
    const upLen = Math.hypot(upX, upY, upZ) || 1e-4;
    upX /= upLen;
    upY /= upLen;
    upZ /= upLen;

    // Forward axis = lat x up (points anteriorly out of nose toward camera)
    let fwdX = latY * upZ - latZ * upY;
    let fwdY = latZ * upX - latX * upZ;
    let fwdZ = latX * upY - latY * upX;
    const fwdLen = Math.hypot(fwdX, fwdY, fwdZ) || 1e-4;
    fwdX /= fwdLen;
    fwdY /= fwdLen;
    fwdZ /= fwdLen;

    // Head pose angles:
    //   rawPitch > 0 when user tilts head UP (fwdY > 0 -> +Z rotation in VTL lifts +X nose toward +Y!)
    //   rawYaw > 0 when user turns head toward screen-right (mirror convention)
    //   rawRoll > 0 when user tilts head toward right shoulder
    const rawYaw = clamp(Math.atan2(-fwdX, fwdZ), -0.65, 0.65);
    const rawPitch = clamp(Math.asin(clamp(fwdY, -0.95, 0.95)) - 0.04, -0.52, 0.52);
    const rawRoll = clamp(Math.atan2(latY, latX), -0.45, 0.45);
    const poseAlpha = 0.32;
    this.smoothPose = {
      yawRad: this.smoothPose.yawRad + poseAlpha * (rawYaw - this.smoothPose.yawRad),
      pitchRad: this.smoothPose.pitchRad + poseAlpha * (rawPitch - this.smoothPose.pitchRad),
      rollRad: this.smoothPose.rollRad + poseAlpha * (rawRoll - this.smoothPose.rollRad),
    };

    const cmPerUnit = 9.15 / eyeSpan;
    const anchorX = 6.22;
    const anchorY = 0.48;
    const vtl = new Float32Array(nPts * 3);
    for (let i = 0; i < nPts; i++) {
      const dx = cam[i * 3] - pSubnasal[0];
      const dy = cam[i * 3 + 1] - pSubnasal[1];
      const dz = cam[i * 3 + 2] - pSubnasal[2];

      const localFwdCm = (dx * fwdX + dy * fwdY + dz * fwdZ) * cmPerUnit;
      const localUpCm = (dx * upX + dy * upY + dz * upZ) * cmPerUnit;
      const localLatCm = (dx * latX + dy * latY + dz * latZ) * cmPerUnit;

      vtl[i * 3] = anchorX + localFwdCm * 0.92 + 0.08;
      vtl[i * 3 + 1] = anchorY + localUpCm * 0.96;
      vtl[i * 3 + 2] = localLatCm;
    }

    // Extract dynamic facial expression controls from both 3D landmarks and MediaPipe 52 blendshapes
    const bs = (key: string) => clamp(blendshapes?.[key] ?? 0, 0, 1);
    const innerLipGapCm = Math.max(0, vtl[13 * 3 + 1] - vtl[14 * 3 + 1]);
    const geomJawOpen = clamp((innerLipGapCm - 0.06) / 2.35, 0, 1);
    const rawJawOpen = blendshapes
      ? clamp(Math.max(bs('jawOpen') * 1.08, geomJawOpen * 0.92), 0, 1)
      : geomJawOpen;

    const rawExpression: FaceExpressionState = {
      jawOpen: rawJawOpen,
      jawSide: clamp(bs('jawLeft') - bs('jawRight') + clamp(vtl[152 * 3 + 2] * 0.22, -0.4, 0.4), -1, 1),
      jawForward: bs('jawForward'),
      lipPucker: clamp(Math.max(bs('mouthPucker'), bs('mouthFunnel') * 0.85), 0, 1),
      // Note: MediaPipe's Left/Right is camera-frame or subject-frame; map to subject +Z (left) and -Z (right)
      smileLeft: clamp(bs('mouthSmileLeft') + bs('mouthStretchLeft') * 0.35, 0, 1),
      smileRight: clamp(bs('mouthSmileRight') + bs('mouthStretchRight') * 0.35, 0, 1),
      frown: clamp(0.5 * (bs('mouthFrownLeft') + bs('mouthFrownRight')), 0, 1),
      upperLipUp: clamp(0.5 * (bs('mouthUpperUpLeft') + bs('mouthUpperUpRight')), 0, 1),
      lowerLipDown: clamp(0.5 * (bs('mouthLowerDownLeft') + bs('mouthLowerDownRight')), 0, 1),
      cheekRaiseLeft: bs('cheekSquintLeft'),
      cheekRaiseRight: bs('cheekSquintRight'),
      browLeft: clamp(Math.max(bs('browInnerUp'), bs('browOuterUpLeft')) - bs('browDownLeft') * 0.9, -1, 1),
      browRight: clamp(Math.max(bs('browInnerUp'), bs('browOuterUpRight')) - bs('browDownRight') * 0.9, -1, 1),
      blinkLeft: bs('eyeBlinkLeft'),
      blinkRight: bs('eyeBlinkRight'),
      noseSneer: clamp(0.5 * (bs('noseSneerLeft') + bs('noseSneerRight')), 0, 1),
    };

    const exprAlpha = 0.48; // Fast response (< 30 ms lag) for snappy mouth/jaw synchronization
    const lerpE = (a: number, b: number) => a + exprAlpha * (b - a);
    this.smoothExpr = {
      jawOpen: lerpE(this.smoothExpr.jawOpen, rawExpression.jawOpen),
      jawSide: lerpE(this.smoothExpr.jawSide, rawExpression.jawSide),
      jawForward: lerpE(this.smoothExpr.jawForward, rawExpression.jawForward),
      lipPucker: lerpE(this.smoothExpr.lipPucker, rawExpression.lipPucker),
      smileLeft: lerpE(this.smoothExpr.smileLeft, rawExpression.smileLeft),
      smileRight: lerpE(this.smoothExpr.smileRight, rawExpression.smileRight),
      frown: lerpE(this.smoothExpr.frown, rawExpression.frown),
      upperLipUp: lerpE(this.smoothExpr.upperLipUp, rawExpression.upperLipUp),
      lowerLipDown: lerpE(this.smoothExpr.lowerLipDown, rawExpression.lowerLipDown),
      cheekRaiseLeft: lerpE(this.smoothExpr.cheekRaiseLeft, rawExpression.cheekRaiseLeft),
      cheekRaiseRight: lerpE(this.smoothExpr.cheekRaiseRight, rawExpression.cheekRaiseRight),
      browLeft: lerpE(this.smoothExpr.browLeft, rawExpression.browLeft),
      browRight: lerpE(this.smoothExpr.browRight, rawExpression.browRight),
      blinkLeft: lerpE(this.smoothExpr.blinkLeft, rawExpression.blinkLeft),
      blinkRight: lerpE(this.smoothExpr.blinkRight, rawExpression.blinkRight),
      noseSneer: lerpE(this.smoothExpr.noseSneer, rawExpression.noseSneer),
    };

    // Update speaker static appearance ratios when head is reasonably frontal
    if (adaptAppearance && Math.abs(rawYaw) < 0.38 && Math.abs(rawPitch) < 0.35) {
      const zSpan = (a: number, b: number) => Math.abs(vtl[b * 3 + 2] - vtl[a * 3 + 2]);
      const cheekW = zSpan(FACE_BOUNDS_INDICES.left, FACE_BOUNDS_INDICES.right);
      const jawW = zSpan(172, 397);
      const noseW = zSpan(129, 358);
      const mouthW = zSpan(61, 291);
      const upperFaceH = Math.max(2.5, vtl[10 * 3 + 1] - vtl[2 * 3 + 1]);
      const chinH = Math.max(1.8, vtl[2 * 3 + 1] - vtl[152 * 3 + 1]);
      const noseTipProj = Math.max(0.5, vtl[1 * 3] - 0.5 * (vtl[33 * 3] + vtl[263 * 3]));

      const calmMouth = rawJawOpen < 0.14 && rawExpression.lipPucker < 0.2;

      const targetCheek = clamp(cheekW / 13.1, 0.84, 1.18);
      const targetJaw = clamp(jawW / 10.7, 0.82, 1.20);
      const targetForehead = clamp(upperFaceH / 8.6, 0.86, 1.16);
      const targetNoseBridge = clamp(noseTipProj / 2.75, 0.84, 1.22);
      const targetNoseWidth = clamp(noseW / 3.55, 0.84, 1.22);
      const targetChin = calmMouth ? clamp(chinH / 5.15, 0.85, 1.18) : this.profile.chinLengthRatio;
      const targetMouthW = calmMouth ? clamp(mouthW / 4.85, 0.85, 1.18) : this.profile.mouthWidthRatio;

      const k = this.profile.calibratedFrames < 15 ? 0.18 : 0.04;
      this.profile = {
        calibratedFrames: this.profile.calibratedFrames + 1,
        cheekWidthRatio: this.profile.cheekWidthRatio + k * (targetCheek - this.profile.cheekWidthRatio),
        jawWidthRatio: this.profile.jawWidthRatio + k * (targetJaw - this.profile.jawWidthRatio),
        chinLengthRatio: this.profile.chinLengthRatio + k * (targetChin - this.profile.chinLengthRatio),
        foreheadRatio: this.profile.foreheadRatio + k * (targetForehead - this.profile.foreheadRatio),
        noseBridgeRatio: this.profile.noseBridgeRatio + k * (targetNoseBridge - this.profile.noseBridgeRatio),
        noseWidthRatio: this.profile.noseWidthRatio + k * (targetNoseWidth - this.profile.noseWidthRatio),
        mouthWidthRatio: this.profile.mouthWidthRatio + k * (targetMouthW - this.profile.mouthWidthRatio),
      };
    }

    const faceW = Math.max(1e-4, Math.abs(pts[FACE_BOUNDS_INDICES.right * 3] - pts[FACE_BOUNDS_INDICES.left * 3]) * aspect);
    const faceH = Math.max(1e-4, Math.abs(pts[FACE_BOUNDS_INDICES.bottom * 3 + 1] - pts[FACE_BOUNDS_INDICES.top * 3 + 1]));
    let lipMinX = Infinity;
    let lipMaxX = -Infinity;
    for (const idx of OUTER_LIP_INDICES) {
      const x = pts[idx * 3] * aspect;
      if (x < lipMinX) lipMinX = x;
      if (x > lipMaxX) lipMaxX = x;
    }
    const outerW = Math.max(0, lipMaxX - lipMinX);
    const innerOpen = Math.max(0, pts[14 * 3 + 1] - pts[13 * 3 + 1]);
    const faceArea = Math.max(1e-5, polygonArea2D(pts, FACE_OVAL_INDICES, aspect));
    const outerArea = polygonArea2D(pts, OUTER_LIP_INDICES, aspect);
    const innerArea = polygonArea2D(pts, INNER_LIP_INDICES, aspect);
    const lipArea = Math.max(0, outerArea - innerArea);
    const perim = Math.max(1e-4, polygonPerimeter2D(pts, OUTER_LIP_INDICES, aspect));

    const metrics: VisualLipMetrics = {
      openRatio: clamp(innerOpen / faceH, 0, 0.5),
      outerWidthRatio: clamp(outerW / faceW, 0.15, 0.75),
      areaRatio: clamp(lipArea / faceArea, 0, 0.35),
      circularity: clamp((4 * Math.PI * outerArea) / (perim * perim), 0, 1),
      jawOpenBlend: this.smoothExpr.jawOpen,
      mouthPuckerBlend: this.smoothExpr.lipPucker,
      mouthSmileBlend: 0.5 * (this.smoothExpr.smileLeft + this.smoothExpr.smileRight),
    };

    return {
      vtlPointsCm: vtl,
      pose: { ...this.smoothPose },
      metrics,
      expression: { ...this.smoothExpr },
      appearance: { ...this.profile },
    };
  }
}

/**
 * Applies smooth, non-penetrating anatomical appearance morphing to the subdivided VTL head shell
 * (`0 .. baseVertexCount - 1`), keeping the internal oral/pharyngeal cavity untouched.
 */
export function applyAppearanceToHeadRest(
  originalRest: Float32Array,
  targetRest: Float32Array,
  baseVertexCount: number,
  profile: FaceAppearanceProfile,
  strength = 1.0,
): void {
  targetRest.set(originalRest);
  if (strength <= 0.001 || profile.calibratedFrames === 0) return;

  const dCheek = (profile.cheekWidthRatio - 1.0) * strength;
  const dJaw = (profile.jawWidthRatio - 1.0) * strength;
  const dChin = (profile.chinLengthRatio - 1.0) * strength;
  const dFore = (profile.foreheadRatio - 1.0) * strength;
  const dNoseProj = (profile.noseBridgeRatio - 1.0) * strength;
  const dNoseW = (profile.noseWidthRatio - 1.0) * strength;
  const dMouthW = (profile.mouthWidthRatio - 1.0) * strength;

  for (let i = 0; i < baseVertexCount; i++) {
    const b = i * 3;
    const x = originalRest[b];
    const y = originalRest[b + 1];
    const z = originalRest[b + 2];
    const absZ = Math.abs(z);

    const anteriorMask = smoothstep(-2.5, 2.2, x);
    if (anteriorMask <= 0.001) continue;

    const cheekBand = smoothstep(-2.2, 0.8, y) * (1 - smoothstep(3.6, 7.2, y));
    const jawBand = smoothstep(-5.2, -3.2, y) * (1 - smoothstep(-0.4, 1.8, y));
    const mouthBand =
      smoothstep(3.6, 5.2, x) *
      (1 - smoothstep(0.0, 2.2, Math.abs(y + 0.55))) *
      (1 - smoothstep(2.0, 3.8, absZ));

    const zScale =
      1 +
      anteriorMask * (dCheek * cheekBand * 0.9 + dJaw * jawBand * 0.95) +
      dMouthW * mouthBand * 0.65;

    const noseRegion =
      smoothstep(4.2, 5.6, x) *
      smoothstep(0.35, 1.1, y) *
      (1 - smoothstep(3.6, 5.2, y)) *
      (1 - smoothstep(1.1, 2.4, absZ));

    const chinRegion = smoothstep(1.2, 4.2, x) * smoothstep(-1.65, -3.4, y);
    const foreRegion = smoothstep(-1.0, 3.5, x) * smoothstep(3.8, 7.5, y);

    targetRest[b] = x + noseRegion * dNoseProj * 1.15 + chinRegion * dChin * 0.35;
    targetRest[b + 1] =
      y - chinRegion * dChin * 1.35 + foreRegion * dFore * (y - 3.8) * 0.55;
    targetRest[b + 2] = z * (zScale + noseRegion * dNoseW * 0.65);
  }
}

/**
 * Ultra-fast (< 0.1 ms / frame) real-time facial expression deformation on posed head shell vertices
 * (`positions`, excluding neck column >= neckStartVertex).
 * Deforms cheeks, mouth corners, brows, eyelids, nasal alae, and lateral jaw shift in sync with webcam motions.
 */
export function applyDynamicExpressionToPosedHead(
  positions: Float32Array,
  neckStartVertex: number,
  expr: FaceExpressionState,
): void {
  const hasMotion =
    expr.smileLeft > 0.01 ||
    expr.smileRight > 0.01 ||
    expr.lipPucker > 0.01 ||
    expr.frown > 0.01 ||
    Math.abs(expr.browLeft) > 0.01 ||
    Math.abs(expr.browRight) > 0.01 ||
    expr.cheekRaiseLeft > 0.01 ||
    expr.cheekRaiseRight > 0.01 ||
    expr.blinkLeft > 0.02 ||
    expr.blinkRight > 0.02 ||
    expr.noseSneer > 0.01 ||
    Math.abs(expr.jawSide) > 0.01;
  if (!hasMotion) return;

  for (let i = 0; i < neckStartVertex; i++) {
    const b = i * 3;
    const x = positions[b];
    if (x < 1.2) continue; // Only anterior facial mask moves with expressions
    const y = positions[b + 1];
    const z = positions[b + 2];
    const absZ = Math.abs(z);
    const isLeft = z >= 0;
    const smile = isLeft ? expr.smileLeft : expr.smileRight;
    const cheek = isLeft ? expr.cheekRaiseLeft : expr.cheekRaiseRight;
    const brow = isLeft ? expr.browLeft : expr.browRight;
    const blink = isLeft ? expr.blinkLeft : expr.blinkRight;

    let dx = 0;
    let dy = 0;
    let dz = 0;

    // 1. Perioral & mouth-corner smile / pucker / frown deformation
    if (x > 3.2 && y > -2.8 && y < 1.1 && absZ < 3.6) {
      const wOralY = 1 - smoothstep(0.0, 2.1, Math.abs(y + 0.55));
      const wCorner = smoothstep(0.7, 1.9, absZ) * (1 - smoothstep(2.4, 3.6, absZ)) * wOralY;
      const wLipCenter = (1 - smoothstep(0.4, 2.3, absZ)) * wOralY;

      // Smile pulls corners laterally, upward, and slightly back against teeth
      dz += (z >= 0 ? 1 : -1) * smile * 0.52 * wCorner;
      dy += (smile * 0.42 - expr.frown * 0.35) * wCorner;
      dx -= smile * 0.14 * wCorner;

      // Pucker / rounding narrows mouth laterally and protrudes lips forward
      dz -= z * expr.lipPucker * 0.26 * wOralY;
      dx += expr.lipPucker * 0.48 * wLipCenter;
    }

    // 2. Cheek / zygomaticus lift during smile & squint
    if (x > 2.0 && y > -1.2 && y < 2.8 && absZ > 1.2 && absZ < 5.6) {
      const wCheek =
        smoothstep(2.0, 4.2, x) *
        (1 - smoothstep(0.0, 2.0, Math.abs(y - 0.85))) *
        smoothstep(1.2, 2.8, absZ) *
        (1 - smoothstep(4.2, 5.6, absZ));
      const lift = Math.min(1, smile * 0.65 + cheek * 0.75);
      dy += lift * 0.36 * wCheek;
      dx += lift * 0.22 * wCheek;
    }

    // 3. Eyebrow raise / furrow (around y in [3.5, 5.6], |z| in [0.6, 4.2])
    if (x > 3.2 && y > 3.3 && y < 6.0 && absZ < 4.5) {
      const wBrow =
        smoothstep(3.2, 4.8, x) *
        (1 - smoothstep(0.0, 1.35, Math.abs(y - 4.45))) *
        (1 - smoothstep(3.2, 4.5, absZ));
      dy += brow * 0.46 * wBrow;
      dx += Math.max(0, brow) * 0.10 * wBrow;
    }

    // 4. Upper eyelid blink (around y in [2.3, 3.4], |z| in [1.3, 3.8])
    if (blink > 0.02 && x > 3.4 && y > 2.2 && y < 3.5 && absZ > 1.2 && absZ < 3.9) {
      const wLid =
        smoothstep(3.4, 4.6, x) *
        (1 - smoothstep(0.0, 0.65, Math.abs(y - 2.85))) *
        smoothstep(1.2, 1.9, absZ) *
        (1 - smoothstep(3.2, 3.9, absZ));
      dy -= blink * 0.32 * wLid;
    }

    // 5. Nasal alar flare / sneer
    if (expr.noseSneer > 0.01 && x > 4.4 && y > 0.2 && y < 1.9 && absZ > 0.5 && absZ < 2.3) {
      const wNose =
        (1 - smoothstep(0.0, 0.85, Math.abs(y - 0.95))) *
        smoothstep(0.5, 1.2, absZ) *
        (1 - smoothstep(1.7, 2.3, absZ));
      dy += expr.noseSneer * 0.24 * wNose;
      dz += (z >= 0 ? 1 : -1) * expr.noseSneer * 0.18 * wNose;
    }

    // 6. Subtle lateral jaw shift on chin/mandible
    if (Math.abs(expr.jawSide) > 0.01 && y < -0.6 && y > -5.5) {
      const wMandible = smoothstep(-0.6, -2.8, y) * smoothstep(1.5, 4.2, x);
      dz += expr.jawSide * 0.45 * wMandible;
    }

    positions[b] = x + dx;
    positions[b + 1] = y + dy;
    positions[b + 2] = z + dz;
  }
}

interface WorkerPending {
  resolve: (val: any) => void;
  reject: (err: Error) => void;
  timer: number;
}

export class WebcamFaceTracker {
  private worker: Worker | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private nextId = 0;
  private pending = new Map<number, WorkerPending>();
  private stabilizer = new LandmarkStabilizer3D(14);
  private calibrator = new FaceAppearanceCalibrator();

  private active = false;
  private inFlight = false;
  private rafId = 0;
  private vfcId = 0;
  private lastVideoTime = -1;
  private fpsWindow: number[] = [];
  private delegateName = 'GPU';
  private adaptAppearance = true;

  private onFrame: (update: FaceFrameUpdate) => void;
  private onError: (msg: string) => void;

  constructor(callbacks: {
    onFrame: (update: FaceFrameUpdate) => void;
    onError: (msg: string) => void;
  }) {
    this.onFrame = callbacks.onFrame;
    this.onError = callbacks.onError;
  }

  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  setAdaptAppearance(enabled: boolean): void {
    this.adaptAppearance = enabled;
  }

  resetAppearance(): void {
    this.calibrator.reset();
  }

  private callWorker(
    op: string,
    extra: Record<string, unknown> = {},
    transfer: Transferable[] = [],
  ): Promise<any> {
    if (!this.worker) return Promise.reject(new Error('特征点推理线程未启动'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('面部特征点模型响应超时'));
      }, 45000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ id, op, ...extra }, transfer);
    });
  }

  async start(deviceId = ''): Promise<void> {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持摄像头采集');
    }

    const videoConstraints: MediaTrackConstraints = {
      width: { ideal: 960 },
      height: { ideal: 540 },
      frameRate: { ideal: 30, max: 30 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
    };

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false,
    });

    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.srcObject = this.stream;
    await video.play();
    this.video = video;

    const workerUrl = new URL(`${import.meta.env.BASE_URL}mediapipe-0.10.14/face-worker.js`, window.location.href);
    const worker = new Worker(workerUrl);
    worker.onmessage = ({ data }) => {
      const item = this.pending.get(data.id);
      if (!item) return;
      clearTimeout(item.timer);
      this.pending.delete(data.id);
      if (data.ok) item.resolve(data.value);
      else item.reject(new Error(data.error || '特征点推理错误'));
    };
    worker.onerror = (ev) => {
      this.onError(ev.message || '面部特征点后台线程异常');
    };
    this.worker = worker;

    const initInfo = await this.callWorker('init', { delegate: 'GPU', mode: 'VIDEO' });
    this.delegateName = initInfo?.delegate || 'CPU';
    this.stabilizer.reset();
    this.fpsWindow = [];
    this.lastVideoTime = -1;
    this.active = true;
    this.inFlight = false;
    this.scheduleNextFrame();
  }

  private scheduleNextFrame(): void {
    if (!this.active || !this.video) return;
    const vid = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
    };
    if (typeof vid.requestVideoFrameCallback === 'function') {
      this.vfcId = vid.requestVideoFrameCallback((now) => {
        if (!this.active) return;
        void this.processTick(now);
        this.scheduleNextFrame();
      });
    } else {
      this.rafId = requestAnimationFrame((now) => {
        if (!this.active) return;
        void this.processTick(now);
        this.scheduleNextFrame();
      });
    }
  }

  private async processTick(nowMs: number): Promise<void> {
    const vid = this.video;
    if (!this.active || this.inFlight || !vid || vid.readyState < 2 || !vid.videoWidth) return;
    if (vid.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = vid.currentTime;
    this.inFlight = true;

    let bmp: ImageBitmap | null = null;
    try {
      bmp = await createImageBitmap(vid);
      if (!this.active || !this.worker) {
        bmp.close();
        return;
      }
      const w = bmp.width;
      const h = bmp.height;
      const res = await this.callWorker('frame', { frame: bmp, time_ms: nowMs, mode: 'VIDEO' }, [bmp]);
      bmp = null;
      if (!this.active) return;

      const stamp = performance.now();
      this.fpsWindow.push(stamp);
      while (this.fpsWindow.length > 1 && stamp - this.fpsWindow[0] > 2000) {
        this.fpsWindow.shift();
      }
      const fps =
        this.fpsWindow.length > 1
          ? ((this.fpsWindow.length - 1) * 1000) / Math.max(1, stamp - this.fpsWindow[0])
          : 0;

      if (res?.points instanceof Float32Array && res.points.length >= 468 * 3) {
        const stabilized = this.stabilizer.filter(res.points, nowMs / 1000);
        const mapped = this.calibrator.processLandmarks(
          stabilized,
          w,
          h,
          res.blendshapes ?? null,
          this.adaptAppearance,
        );
        this.onFrame({
          detected: true,
          vtlPointsCm: mapped.vtlPointsCm,
          pose: mapped.pose,
          metrics: mapped.metrics,
          expression: mapped.expression,
          appearance: mapped.appearance,
          inferenceMs: res.inference_ms ?? 0,
          fps,
          delegate: this.delegateName,
        });
      } else {
        this.onFrame({
          detected: false,
          vtlPointsCm: null,
          pose: { yawRad: 0, pitchRad: 0, rollRad: 0 },
          metrics: defaultVisualLipMetrics(),
          expression: defaultFaceExpression(),
          appearance: this.calibrator.currentProfile,
          inferenceMs: res?.inference_ms ?? 0,
          fps,
          delegate: this.delegateName,
        });
      }
    } catch (err) {
      bmp?.close();
      if (this.active) {
        this.onError(err instanceof Error ? err.message : '摄像头特征点提取失败');
      }
    } finally {
      this.inFlight = false;
    }
  }

  stop(): void {
    this.active = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.vfcId && this.video) {
      const vid = this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (id: number) => void };
      vid.cancelVideoFrameCallback?.(this.vfcId);
      this.vfcId = 0;
    }
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('stopped'));
    }
    this.pending.clear();
    if (this.worker) {
      try {
        this.worker.postMessage({ id: ++this.nextId, op: 'close' });
      } catch {
        // ignore
      }
      this.worker.terminate();
      this.worker = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video = null;
    }
    this.inFlight = false;
  }
}
