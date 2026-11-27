/**
 * Pure Canvas 2D cinematic camera presets, stage looks, film polish & montage outro renderer.
 *
 * Adapted from Vincentwei1021/video-shotcraft (Apache-2.0):
 * - demos/_fixtures/Look.tsx (8 cinematic studio palettes & perspective floor grid)
 * - demos/_fixtures/Polish.tsx (vignette, deterministic grain, halation bloom)
 * - assets/lib/shots/camera/{SlowPushIn,DutchRollToLevel,CrashZoomReal,JumpCutPunchIn}.tsx
 * - assets/lib/shots/rhythm/{RisoBeatPump,StrobeBlackFrames,DropBlackoutSlam}.tsx
 * - assets/lib/shots/transitions/GrainDissolve.tsx
 *
 * Implemented natively in Canvas 2D for VoxFigura (monitor preview == MP4/WebM export).
 */

import type { VcProject, VisualLayerKeyframe } from '@vocalcut/core';
import { stageLayer } from './nle-timeline';
import { clamp01, dampedImpact, dampedSettle, handheld, mulberry32, ramp } from './stage-motion';
import { beatPulseAt, type StageBeatGrid } from './stage-beat-sync';

export type StageLookId =
  | 'default'
  | 'midnight'
  | 'aurora'
  | 'ember'
  | 'graphite'
  | 'lime'
  | 'paper'
  | 'porcelain'
  | 'sand';

export type CameraPresetId =
  | 'none'
  | 'slow-push-in'
  | 'pull-back'
  | 'dutch-roll-level'
  | 'crash-zoom'
  | 'jump-cut-punch';

export type RhythmFxId =
  | 'none'
  | 'beat-pump'
  | 'strobe-black'
  | 'drop-slam';

export type OutroPresetId =
  | 'none'
  | 'fade-black'
  | 'grain-condense'
  | 'title-lockup';

export interface StageCinemaConfig {
  look: StageLookId;
  gridFloor: boolean;
  camera: CameraPresetId;
  cameraStrength: number; // 0.2..2.0 (default 1)
  handheldAmp: number;    // 0..1 (default 0)
  vignette: number;       // 0..1 (default 0)
  grain: number;          // 0..1 (default 0)
  halation: number;       // 0..1 (default 0)
  rhythmFx: RhythmFxId;
  rhythmIntensity: number;// 0..1 (default 0.65)
  outro: OutroPresetId;
  outroSec: number;       // 0.6..4.0 (default 1.5)
  outroTitle: string;
  outroSubtitle: string;
}

export const DEFAULT_STAGE_CINEMA: Readonly<StageCinemaConfig> = {
  look: 'default',
  gridFloor: false,
  camera: 'none',
  cameraStrength: 1,
  handheldAmp: 0,
  vignette: 0,
  grain: 0,
  halation: 0,
  rhythmFx: 'none',
  rhythmIntensity: 0.65,
  outro: 'none',
  outroSec: 1.5,
  outroTitle: 'VoxFigura',
  outroSubtitle: '声道可见 · 声音可塑',
};

export const STAGE_LOOK_OPTIONS: ReadonlyArray<{ value: StageLookId; label: string }> = [
  { value: 'default', label: '默认声学青灰' },
  { value: 'midnight', label: '午夜冷蓝影棚 (Midnight)' },
  { value: 'aurora', label: '极光冷青 (Aurora)' },
  { value: 'ember', label: '余烬暖橙暗棚 (Ember)' },
  { value: 'graphite', label: '石墨电影暗灰 (Graphite)' },
  { value: 'lime', label: '高反差荧绿 (Lime)' },
  { value: 'paper', label: '暖米胶片纸面 (Paper)' },
  { value: 'porcelain', label: '瓷白展台 (Porcelain)' },
  { value: 'sand', label: '暖沙海报 (Sand)' },
];

export const CAMERA_PRESET_OPTIONS: ReadonlyArray<{ value: CameraPresetId; label: string }> = [
  { value: 'none', label: '静态机位' },
  { value: 'slow-push-in', label: '慢推压迫 (Slow Push-In)' },
  { value: 'pull-back', label: '拉远孤立 (Pull-Back)' },
  { value: 'dutch-roll-level', label: '斜角滚正 (Dutch Roll)' },
  { value: 'crash-zoom', label: '急推回弹 (Crash Zoom)' },
  { value: 'jump-cut-punch', label: '三级跳切推近 (Jump-Cut)' },
];

export const RHYTHM_FX_OPTIONS: ReadonlyArray<{ value: RhythmFxId; label: string }> = [
  { value: 'none', label: '关闭节拍特效' },
  { value: 'beat-pump', label: '节拍脉冲缩放 (Beat Pump)' },
  { value: 'strobe-black', label: '高能频闪黑帧 (Strobe)' },
  { value: 'drop-slam', label: '落拍震屏冲击 (Drop Slam)' },
];

export const OUTRO_PRESET_OPTIONS: ReadonlyArray<{ value: OutroPresetId; label: string }> = [
  { value: 'none', label: '无片尾收尾' },
  { value: 'fade-black', label: '电影渐暗收尾 (Fade Black)' },
  { value: 'grain-condense', label: '颗粒凝聚定格 (Grain Condense)' },
  { value: 'title-lockup', label: '蒙太奇字标落幕 (Title Lockup)' },
];

export interface StageLookSpec {
  bg: string;
  key: string;
  fill: string;
  accent: string;
  grid: string;
  ink: string;
  light: boolean;
}

const LOOK_SPECS: Readonly<Record<StageLookId, StageLookSpec>> = {
  default: { bg: '#16242a', key: '#344d50', fill: '#1c2f36', accent: '#5eead4', grid: 'rgba(185,214,215,0.065)', ink: '#eef6f8', light: false },
  midnight: { bg: '#081122', key: '#1b3564', fill: '#0e2040', accent: '#60a5fa', grid: 'rgba(147,197,253,0.09)', ink: '#e2ecff', light: false },
  aurora: { bg: '#07171d', key: '#11484d', fill: '#1a2748', accent: '#2dd4bf', grid: 'rgba(94,234,212,0.085)', ink: '#e6fffa', light: false },
  ember: { bg: '#180d0b', key: '#5a2515', fill: '#2c1512', accent: '#fb923c', grid: 'rgba(253,186,116,0.085)', ink: '#ffedd5', light: false },
  graphite: { bg: '#14161a', key: '#2f3540', fill: '#1e222a', accent: '#cbd5e1', grid: 'rgba(203,213,225,0.075)', ink: '#f1f5f9', light: false },
  lime: { bg: '#0d140c', key: '#294816', fill: '#162614', accent: '#a3e635', grid: 'rgba(163,230,53,0.09)', ink: '#ecfccb', light: false },
  paper: { bg: '#f2ece1', key: '#fffbf2', fill: '#e5dac8', accent: '#b45309', grid: 'rgba(68,54,39,0.085)', ink: '#292118', light: true },
  porcelain: { bg: '#eef2f6', key: '#ffffff', fill: '#dce5f0', accent: '#2563eb', grid: 'rgba(30,58,138,0.08)', ink: '#1e293b', light: true },
  sand: { bg: '#e9dfd1', key: '#f7f1e6', fill: '#d6c6b2', accent: '#9a3412', grid: 'rgba(71,52,37,0.085)', ink: '#271e16', light: true },
};

export function getStageLookSpec(look: StageLookId): Readonly<StageLookSpec> {
  return LOOK_SPECS[look] ?? LOOK_SPECS.default;
}

export function readStageCinemaConfig(project: VcProject): StageCinemaConfig {
  const raw = stageLayer(project, 'v0')?.keys?.cinema_fx?.[0]?.frame;
  if (!raw) return { ...DEFAULT_STAGE_CINEMA };
  try {
    const parsed = JSON.parse(raw) as Partial<StageCinemaConfig>;
    return {
      look: parsed.look && parsed.look in LOOK_SPECS ? parsed.look : DEFAULT_STAGE_CINEMA.look,
      gridFloor: Boolean(parsed.gridFloor),
      camera: CAMERA_PRESET_OPTIONS.some(o => o.value === parsed.camera) ? parsed.camera! : 'none',
      cameraStrength: typeof parsed.cameraStrength === 'number' && Number.isFinite(parsed.cameraStrength)
        ? Math.max(0.2, Math.min(2, parsed.cameraStrength)) : 1,
      handheldAmp: typeof parsed.handheldAmp === 'number' && Number.isFinite(parsed.handheldAmp)
        ? Math.max(0, Math.min(1, parsed.handheldAmp)) : 0,
      vignette: typeof parsed.vignette === 'number' && Number.isFinite(parsed.vignette)
        ? Math.max(0, Math.min(1, parsed.vignette)) : 0,
      grain: typeof parsed.grain === 'number' && Number.isFinite(parsed.grain)
        ? Math.max(0, Math.min(1, parsed.grain)) : 0,
      halation: typeof parsed.halation === 'number' && Number.isFinite(parsed.halation)
        ? Math.max(0, Math.min(1, parsed.halation)) : 0,
      rhythmFx: RHYTHM_FX_OPTIONS.some(o => o.value === parsed.rhythmFx) ? parsed.rhythmFx! : 'none',
      rhythmIntensity: typeof parsed.rhythmIntensity === 'number' && Number.isFinite(parsed.rhythmIntensity)
        ? Math.max(0, Math.min(1, parsed.rhythmIntensity)) : 0.65,
      outro: OUTRO_PRESET_OPTIONS.some(o => o.value === parsed.outro) ? parsed.outro! : 'none',
      outroSec: typeof parsed.outroSec === 'number' && Number.isFinite(parsed.outroSec)
        ? Math.max(0.6, Math.min(4, parsed.outroSec)) : 1.5,
      outroTitle: typeof parsed.outroTitle === 'string' ? parsed.outroTitle.slice(0, 60) : DEFAULT_STAGE_CINEMA.outroTitle,
      outroSubtitle: typeof parsed.outroSubtitle === 'string' ? parsed.outroSubtitle.slice(0, 80) : DEFAULT_STAGE_CINEMA.outroSubtitle,
    };
  } catch {
    return { ...DEFAULT_STAGE_CINEMA };
  }
}

export function stageCinemaKeys(config: StageCinemaConfig): VisualLayerKeyframe[] {
  return [{ t_smp: 0, frame: JSON.stringify(config) }];
}

export interface CameraPose {
  scale: number;
  rotDeg: number;
  txPx: number;
  tyPx: number;
}

export function evaluateCameraPose(
  config: StageCinemaConfig,
  tSec: number,
  totalSec: number,
  beatGrid?: StageBeatGrid | null,
): CameraPose {
  const dur = Math.max(0.5, totalSec);
  const strength = config.cameraStrength;
  let scale = 1;
  let rotDeg = 0;
  let txPx = 0;
  let tyPx = 0;

  if (config.camera === 'slow-push-in') {
    const u = ramp(tSec, 0, dur, 'smooth');
    scale = 1 + 0.14 * strength * u;
  } else if (config.camera === 'pull-back') {
    const u = ramp(tSec, 0, dur, 'out');
    scale = 1 + 0.18 * strength * (1 - u);
  } else if (config.camera === 'dutch-roll-level') {
    const settle = dampedSettle(tSec, 1.35, 3.2);
    rotDeg = 6.5 * strength * (1 - settle);
    scale = 1 + 0.08 * strength * (1 - clamp01(tSec / Math.min(2.2, dur)));
  } else if (config.camera === 'crash-zoom') {
    const settle = dampedSettle(Math.max(0, tSec - 0.12), 2.4, 5.2);
    scale = 1 + 0.22 * strength * settle;
    tyPx = -10 * strength * settle;
  } else if (config.camera === 'jump-cut-punch') {
    const stepDur = Math.max(0.35, beatGrid ? beatGrid.beatIntervalSec * 2 : dur / 3.5);
    const stepIdx = Math.min(3, Math.floor(Math.max(0, tSec) / stepDur));
    scale = 1 + stepIdx * 0.085 * strength;
  }

  // Beat-synced pump or drop impact camera kick
  if (config.rhythmFx !== 'none' && config.rhythmIntensity > 0.01) {
    const beat = beatPulseAt(tSec, beatGrid);
    if (config.rhythmFx === 'beat-pump') {
      scale *= 1 + 0.055 * config.rhythmIntensity * beat.pulse;
    } else if (config.rhythmFx === 'drop-slam' && beat.timeSinceStrongSec < 0.55) {
      const imp = dampedImpact(beat.timeSinceStrongSec, 14, 9.5);
      scale *= 1 + 0.1 * config.rhythmIntensity * Math.exp(-beat.timeSinceStrongSec * 8);
      txPx += imp * 26 * config.rhythmIntensity;
      tyPx += Math.cos(beat.timeSinceStrongSec * 38) * Math.exp(-beat.timeSinceStrongSec * 9.5) * 18 * config.rhythmIntensity;
      rotDeg += imp * 1.9 * config.rhythmIntensity;
    }
  }

  // Subtle pull-back during grain-condense outro
  if (config.outro === 'grain-condense' && dur > 0.4) {
    const outroStart = Math.max(0, dur - config.outroSec);
    if (tSec > outroStart) {
      const u = ramp(tSec, outroStart, dur, 'smooth');
      scale *= 1 - 0.06 * u;
    }
  }

  // Handheld organic drift
  if (config.handheldAmp > 0.005) {
    const drift = handheld(tSec, {
      ampPx: 14 * config.handheldAmp,
      rotDeg: 0.75 * config.handheldAmp,
      freq: 0.62,
      seed: 42,
    });
    txPx += drift.x;
    tyPx += drift.y;
    rotDeg += drift.rotDeg;
  }

  return { scale, rotDeg, txPx, tyPx };
}

export function drawStageLookBackdrop(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  config: StageCinemaConfig,
  opacity: number,
  scale: number,
  tSec: number,
): void {
  const spec = LOOK_SPECS[config.look] ?? LOOK_SPECS.default;
  ctx.save();
  ctx.globalAlpha = clamp01(opacity);
  ctx.translate(w / 2, h / 2);
  ctx.scale(scale, scale);
  ctx.translate(-w / 2, -h / 2);

  // Base fill
  ctx.fillStyle = spec.bg;
  ctx.fillRect(0, 0, w, h);

  // Key studio radial light (subtle animated breathe for non-default looks)
  const driftX = config.look === 'default' ? 0 : Math.sin(tSec * 0.45) * w * 0.03;
  const driftY = config.look === 'default' ? 0 : Math.cos(tSec * 0.35) * h * 0.025;
  const keyGrad = ctx.createRadialGradient(w * 0.45 + driftX, h * 0.44 + driftY, 0, w * 0.45 + driftX, h * 0.44 + driftY, w * 0.62);
  keyGrad.addColorStop(0, spec.key);
  keyGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = keyGrad;
  ctx.fillRect(0, 0, w, h);

  // Secondary fill rim
  if (config.look !== 'default') {
    const fillGrad = ctx.createRadialGradient(w * 0.82, h * 0.78, 0, w * 0.82, h * 0.78, w * 0.46);
    fillGrad.addColorStop(0, spec.fill);
    fillGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = fillGrad;
    ctx.fillRect(0, 0, w, h);
  }

  // Orthogonal reference grid (default look) or perspective horizon grid floor
  ctx.strokeStyle = spec.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (config.gridFloor) {
    const horizonY = h * 0.68;
    const vanishX = w * 0.5;
    for (let i = -10; i <= 10; i++) {
      ctx.moveTo(vanishX + i * w * 0.045, horizonY);
      ctx.lineTo(vanishX + i * w * 0.22, h);
    }
    for (let r = 1; r <= 9; r++) {
      const frac = Math.pow(r / 9, 1.85);
      const y = horizonY + (h - horizonY) * frac;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
  } else {
    for (let x = 0; x < w; x += 96) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let y = 0; y < h; y += 96) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
  }
  ctx.stroke();
  ctx.restore();
}

// Pre-baked deterministic grain tiles (6 tiles * 160x160 = tiny RAM, zero per-frame allocation)
let grainTiles: HTMLCanvasElement[] | null = null;
function getGrainTiles(): HTMLCanvasElement[] {
  if (grainTiles) return grainTiles;
  if (typeof document === 'undefined') return [];
  const size = 160;
  const tiles: HTMLCanvasElement[] = [];
  for (let idx = 0; idx < 6; idx++) {
    const tile = document.createElement('canvas');
    tile.width = size;
    tile.height = size;
    const gctx = tile.getContext('2d');
    if (gctx) {
      const img = gctx.createImageData(size, size);
      const rng = mulberry32(9001 + idx * 7919);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.floor(rng() * 255);
        img.data[i] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      gctx.putImageData(img, 0, 0);
    }
    tiles.push(tile);
  }
  grainTiles = tiles;
  return tiles;
}

/**
 * Draw post-processing polish: rhythm FX (strobe / shockwave), halation bloom,
 * vignette, deterministic film grain, and montage outro lockup.
 */
export function drawStagePostPolish(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  config: StageCinemaConfig,
  tSec: number,
  totalSec: number,
  beatGrid?: StageBeatGrid | null,
): void {
  const spec = LOOK_SPECS[config.look] ?? LOOK_SPECS.default;
  const dur = Math.max(0.5, totalSec);

  // 1. Rhythm FX overlays (drop-slam shockwave ring / strobe black frame)
  if (config.rhythmFx !== 'none' && config.rhythmIntensity > 0.01) {
    const beat = beatPulseAt(tSec, beatGrid);
    if (config.rhythmFx === 'drop-slam' && beat.timeSinceStrongSec < 0.48) {
      const u = clamp01(beat.timeSinceStrongSec / 0.48);
      const r = (0.08 + u * 0.68) * Math.min(w, h);
      ctx.save();
      ctx.strokeStyle = spec.accent;
      ctx.globalAlpha = (1 - u) * 0.55 * config.rhythmIntensity;
      ctx.lineWidth = Math.max(2, (1 - u) * 12);
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else if (config.rhythmFx === 'strobe-black' && beat.timeSinceStrongSec < 0.24) {
      const frameIdx = Math.floor(beat.timeSinceStrongSec * 30);
      if (frameIdx % 2 === 0) {
        ctx.save();
        ctx.fillStyle = '#05070b';
        ctx.globalAlpha = 0.72 * config.rhythmIntensity;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
    }
  }

  // 2. Halation warm/accent studio bloom
  if (config.halation > 0.01) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const grad = ctx.createRadialGradient(w * 0.5, h * 0.46, w * 0.04, w * 0.5, h * 0.46, w * 0.52);
    grad.addColorStop(0, spec.accent);
    grad.addColorStop(1, 'transparent');
    ctx.globalAlpha = config.halation * 0.24;
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // 3. Outro envelope
  let extraVignette = 0;
  let extraGrain = 0;
  let outroU = 0;
  if (config.outro !== 'none' && dur > 0.4) {
    const outroStart = Math.max(0, dur - config.outroSec);
    if (tSec > outroStart) {
      outroU = ramp(tSec, outroStart, dur, 'smooth');
      if (config.outro === 'grain-condense') {
        extraVignette = outroU * 0.55;
        extraGrain = outroU * 0.45;
      }
    }
  }

  // 4. Vignette
  const vigStrength = clamp01(config.vignette + extraVignette);
  if (vigStrength > 0.01) {
    ctx.save();
    const vg = ctx.createRadialGradient(w * 0.5, h * 0.5, w * 0.24, w * 0.5, h * 0.5, w * 0.68);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, `rgba(4,7,14,${(vigStrength * 0.78).toFixed(3)})`);
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // 5. Deterministic Film Grain (tiled cached canvas)
  const grainStrength = clamp01(config.grain + extraGrain);
  if (grainStrength > 0.01) {
    const tiles = getGrainTiles();
    if (tiles.length) {
      const tile = tiles[Math.floor(Math.max(0, tSec) * 24) % tiles.length];
      const pattern = ctx.createPattern(tile, 'repeat');
      if (pattern) {
        ctx.save();
        ctx.globalCompositeOperation = 'overlay';
        ctx.globalAlpha = grainStrength * 0.24;
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
    }
  }

  // 6. Montage Outro Curtain / Title Lockup
  if (outroU > 0.001) {
    if (config.outro === 'fade-black' || config.outro === 'grain-condense') {
      ctx.save();
      ctx.fillStyle = '#06090f';
      ctx.globalAlpha = clamp01(config.outro === 'fade-black' ? outroU : outroU * 0.88);
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    } else if (config.outro === 'title-lockup') {
      const curtainAlpha = clamp01(outroU * 1.15) * 0.86;
      const enterU = ramp(outroU, 0.12, 0.78, 'snappy');
      const settleY = (1 - enterU) * 34;
      ctx.save();
      ctx.fillStyle = '#070b14';
      ctx.globalAlpha = curtainAlpha;
      ctx.fillRect(0, 0, w, h);

      ctx.globalAlpha = enterU;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Accent rule
      const ruleW = 140 * enterU;
      ctx.fillStyle = spec.accent;
      ctx.fillRect(w / 2 - ruleW / 2, h * 0.49 + settleY, ruleW, 3);

      // Main title
      if (config.outroTitle.trim()) {
        ctx.fillStyle = '#f8fafc';
        ctx.font = '700 72px "VC Noto Serif SC","Noto Serif CJK SC","Microsoft YaHei",serif';
        ctx.fillText(config.outroTitle.trim(), w / 2, h * 0.42 + settleY);
      }

      // Subtitle
      if (config.outroSubtitle.trim()) {
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '500 30px "VC Noto Serif SC","Noto Serif CJK SC","Microsoft YaHei",sans-serif';
        ctx.fillText(config.outroSubtitle.trim(), w / 2, h * 0.56 + settleY);
      }
      ctx.restore();
    }
  }
}
