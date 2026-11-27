/**
 * Pure Canvas 2D clip-edge & cut transition renderer (9 cinematic presets).
 *
 * Adapted from Vincentwei1021/video-shotcraft (Apache-2.0):
 * - assets/lib/shots/transitions/{WhipPanReal,ClockWipe,BarnDoorSplit,BlindsSlice,
 *   CircleMatchIris,LightLeakBurn,GlitchDisplace,FlashCut,MaskWipeReal}.tsx
 *
 * Deterministic at any sample timestamp tSmp so 16:9 stage preview and MP4/WebM export
 * produce identical frames.
 */

import { msToSamples, type VisualLayer, type VisualLayerKeyframe } from '@vocalcut/core';
import { clamp01, mulberry32, resolveEasing } from './stage-motion';

export type TransitionPresetId =
  | 'none'
  | 'crossfade'
  | 'whip-pan'
  | 'clock-wipe'
  | 'barn-door'
  | 'blinds-slice'
  | 'circle-iris'
  | 'light-leak-burn'
  | 'glitch-displace'
  | 'flash-cut';

export interface LayerTransitionConfig {
  inType: TransitionPresetId;
  outType: TransitionPresetId;
  durationMs: number; // 120..1800 ms
}

export const DEFAULT_LAYER_TRANSITION: Readonly<LayerTransitionConfig> = {
  inType: 'none',
  outType: 'none',
  durationMs: 420,
};

export const TRANSITION_OPTIONS: ReadonlyArray<{ value: TransitionPresetId; label: string }> = [
  { value: 'none', label: '无转场' },
  { value: 'crossfade', label: '平滑叠化 (Crossfade)' },
  { value: 'whip-pan', label: '甩镜横扫 (Whip Pan)' },
  { value: 'clock-wipe', label: '时钟扫描 (Clock Wipe)' },
  { value: 'barn-door', label: '对开门裂幕 (Barn Door)' },
  { value: 'blinds-slice', label: '12 栏百叶窗 (Blinds)' },
  { value: 'circle-iris', label: '圆形光圈 (Circle Iris)' },
  { value: 'light-leak-burn', label: '胶片漏光烧穿 (Light Leak)' },
  { value: 'glitch-displace', label: '故障条带撕裂 (Glitch)' },
  { value: 'flash-cut', label: '高能闪白切 (Flash Cut)' },
];

export function isTransitionPresetId(v: unknown): v is TransitionPresetId {
  return typeof v === 'string' && TRANSITION_OPTIONS.some(o => o.value === v);
}

export function readLayerTransition(layer: VisualLayer | undefined): LayerTransitionConfig {
  const raw = layer?.keys?.transition_fx?.[0]?.frame;
  if (!raw) return { ...DEFAULT_LAYER_TRANSITION };
  try {
    const parsed = JSON.parse(raw) as Partial<LayerTransitionConfig>;
    return {
      inType: isTransitionPresetId(parsed.inType) ? parsed.inType : 'none',
      outType: isTransitionPresetId(parsed.outType) ? parsed.outType : 'none',
      durationMs: typeof parsed.durationMs === 'number' && Number.isFinite(parsed.durationMs)
        ? Math.max(120, Math.min(1800, Math.round(parsed.durationMs)))
        : 420,
    };
  } catch {
    return { ...DEFAULT_LAYER_TRANSITION };
  }
}

export function layerTransitionKeys(cfg: LayerTransitionConfig): VisualLayerKeyframe[] {
  if (cfg.inType === 'none' && cfg.outType === 'none') return [];
  return [{ t_smp: 0, frame: JSON.stringify(cfg) }];
}

export interface ActiveTransitionState {
  type: Exclude<TransitionPresetId, 'none'>;
  /** Visibility progress: 0 = completely hidden, 1 = completely revealed */
  progress: number;
  direction: 'in' | 'out';
}

/**
 * Compute whether timestamp `tSmp` falls within a clip's entry or exit transition window.
 */
export function computeClipTransitionState(
  tSmp: number,
  startSmp: number,
  endSmp: number,
  cfg: LayerTransitionConfig,
): ActiveTransitionState | null {
  if (cfg.inType === 'none' && cfg.outType === 'none') return null;
  const clipLen = Math.max(1, endSmp - startSmp);
  const maxDurSmp = Math.min(msToSamples(cfg.durationMs), Math.floor(clipLen * 0.48));
  if (maxDurSmp <= 0) return null;

  if (cfg.inType !== 'none' && tSmp >= startSmp && tSmp < startSmp + maxDurSmp) {
    const rawU = clamp01((tSmp - startSmp) / maxDurSmp);
    return { type: cfg.inType, progress: resolveEasing('out')(rawU), direction: 'in' };
  }
  if (cfg.outType !== 'none' && tSmp > endSmp - maxDurSmp && tSmp <= endSmp) {
    const rawU = clamp01((endSmp - tSmp) / maxDurSmp);
    return { type: cfg.outType, progress: resolveEasing('out')(rawU), direction: 'out' };
  }
  return null;
}

/**
 * Render `drawContent()` wrapped in one of the 9 Canvas 2D transitions.
 * Coordinates operate in stage logical space (`0..w`, `0..h`).
 */
export function renderWithCanvasTransition(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  state: ActiveTransitionState | null,
  drawContent: () => void,
  seed = 101,
): void {
  if (!state || state.progress >= 0.999) {
    drawContent();
    return;
  }
  if (state.progress <= 0.001) return;

  const p = clamp01(state.progress);
  const inv = 1 - p;

  ctx.save();
  switch (state.type) {
    case 'crossfade': {
      ctx.globalAlpha *= p;
      drawContent();
      break;
    }

    case 'whip-pan': {
      const dir = state.direction === 'in' ? 1 : -1;
      const offsetX = dir * inv * w * 0.42;
      const stretchX = 1 + Math.sin(p * Math.PI) * 0.16;
      ctx.globalAlpha *= clamp01(p * 1.25);
      ctx.translate(w / 2 + offsetX, h / 2);
      ctx.scale(stretchX, 1 / Math.sqrt(stretchX));
      ctx.translate(-w / 2, -h / 2);
      drawContent();
      // Subtle directional velocity light streak
      const streakAlpha = Math.sin(p * Math.PI) * 0.28;
      if (streakAlpha > 0.01) {
        const g = ctx.createLinearGradient(0, 0, w, 0);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.5, `rgba(220,240,255,${streakAlpha.toFixed(3)})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
      break;
    }

    case 'clock-wipe': {
      const r = Math.hypot(w, h) * 0.6;
      const startAngle = -Math.PI / 2;
      const endAngle = startAngle + p * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(w / 2, h / 2);
      ctx.arc(w / 2, h / 2, r, startAngle, endAngle, false);
      ctx.closePath();
      ctx.clip();
      drawContent();
      break;
    }

    case 'barn-door': {
      const halfW = (w / 2) * p;
      ctx.beginPath();
      ctx.rect(w / 2 - halfW, 0, halfW * 2, h);
      ctx.clip();
      drawContent();
      break;
    }

    case 'blinds-slice': {
      const cols = 12;
      const colW = w / cols;
      ctx.beginPath();
      for (let i = 0; i < cols; i++) {
        // Staggered blinds opening from left to right
        const localP = clamp01((p * 1.35) - (i / cols) * 0.35);
        const stripW = colW * localP;
        if (stripW > 0.5) {
          ctx.rect(i * colW, 0, stripW + 0.5, h);
        }
      }
      ctx.clip();
      drawContent();
      break;
    }

    case 'circle-iris': {
      const maxR = Math.hypot(w / 2, h / 2) * 1.05;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, maxR * p, 0, Math.PI * 2);
      ctx.clip();
      drawContent();
      break;
    }

    case 'light-leak-burn': {
      ctx.globalAlpha *= clamp01(p * 1.18);
      drawContent();
      const burn = Math.sin(p * Math.PI);
      if (burn > 0.01) {
        ctx.globalCompositeOperation = 'screen';
        const cx = w * (0.15 + p * 0.72);
        const cy = h * 0.42;
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, w * 0.55);
        grad.addColorStop(0, `rgba(255,220,150,${(burn * 0.78).toFixed(3)})`);
        grad.addColorStop(0.45, `rgba(255,118,52,${(burn * 0.46).toFixed(3)})`);
        grad.addColorStop(1, 'rgba(255,80,30,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
      }
      break;
    }

    case 'glitch-displace': {
      const bands = 8;
      const bandH = h / bands;
      const frameBucket = Math.floor(p * 18);
      const rng = mulberry32(seed + frameBucket * 97);
      const jitterMag = Math.sin(p * Math.PI) * 76;
      for (let b = 0; b < bands; b++) {
        const dx = (rng() - 0.5) * 2 * jitterMag;
        const showBand = rng() < clamp01(p * 1.3);
        if (!showBand) continue;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, b * bandH, w, bandH + 1);
        ctx.clip();
        ctx.translate(dx, 0);
        ctx.globalAlpha *= clamp01(0.45 + p * 0.55);
        drawContent();
        // Occasional subtle chromatic bar tint
        if (Math.abs(dx) > jitterMag * 0.55) {
          ctx.globalCompositeOperation = 'screen';
          ctx.fillStyle = b % 2 === 0 ? 'rgba(56,189,248,0.18)' : 'rgba(244,114,182,0.18)';
          ctx.fillRect(0, b * bandH, w, bandH);
        }
        ctx.restore();
      }
      break;
    }

    case 'flash-cut': {
      const scale = 1 + inv * 0.08;
      ctx.translate(w / 2, h / 2);
      ctx.scale(scale, scale);
      ctx.translate(-w / 2, -h / 2);
      ctx.globalAlpha *= clamp01(p * 1.25);
      drawContent();
      const flash = Math.pow(inv, 1.35) * 0.85;
      if (flash > 0.01) {
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = `rgba(255,255,255,${flash.toFixed(3)})`;
        ctx.fillRect(0, 0, w, h);
      }
      break;
    }
  }
  ctx.restore();
}
