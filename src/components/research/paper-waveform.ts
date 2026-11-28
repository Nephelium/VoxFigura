/**
 * Publication-grade acoustic oscillogram renderer & X-axis zoom viewport helpers.
 * Renders continuous signed min/max oscillogram envelopes (and sample-level polylines when zoomed in)
 * matching academic phonetics / Praat paper figures instead of discrete vertical bars.
 */

export const WAVE_MIN_ZOOM = 1;
export const WAVE_MAX_ZOOM = 20;

export interface WaveViewport {
  zoom: number;
  startSec: number;
  endSec: number;
  spanSec: number;
}

export function clampWaveViewport(
  durationSec: number,
  zoom: number,
  startSec: number,
  minZoom = WAVE_MIN_ZOOM,
  maxZoom = WAVE_MAX_ZOOM,
): WaveViewport {
  const dur = Math.max(0.001, Number.isFinite(durationSec) ? durationSec : 0.001);
  const clampedZoom = Math.max(minZoom, Math.min(maxZoom, Number.isFinite(zoom) ? zoom : 1));
  const spanSec = dur / clampedZoom;
  const maxStart = Math.max(0, dur - spanSec);
  const clampedStart = Math.max(0, Math.min(maxStart, Number.isFinite(startSec) ? startSec : 0));
  return {
    zoom: clampedZoom,
    startSec: clampedStart,
    endSec: Math.min(dur, clampedStart + spanSec),
    spanSec,
  };
}

export function zoomViewportAround(
  durationSec: number,
  currentZoom: number,
  currentStartSec: number,
  factor: number,
  anchorSec: number,
  minZoom = WAVE_MIN_ZOOM,
  maxZoom = WAVE_MAX_ZOOM,
): WaveViewport {
  const dur = Math.max(0.001, Number.isFinite(durationSec) ? durationSec : 0.001);
  const cur = clampWaveViewport(dur, currentZoom, currentStartSec, minZoom, maxZoom);
  const nextZoom = Math.max(minZoom, Math.min(maxZoom, cur.zoom * factor));
  const nextSpan = dur / nextZoom;
  const anchorRatio = cur.spanSec > 0 ? Math.max(0, Math.min(1, (anchorSec - cur.startSec) / cur.spanSec)) : 0.5;
  const nextStart = anchorSec - anchorRatio * nextSpan;
  return clampWaveViewport(dur, nextZoom, nextStart, minZoom, maxZoom);
}

export function computePcmPeakAbs(samples: Float32Array | null | undefined): number {
  if (!samples || samples.length === 0) return 1;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  return peak > 1e-5 ? peak : 1;
}

export interface PaperWaveformDrawOptions {
  x0: number;
  y0: number;
  width: number;
  height: number;
  viewStartSec: number;
  viewEndSec: number;
  peakAbs: number;
  strokeColor: string;
  axisColor: string;
  gridColor?: string;
}

export function drawPaperWaveform(
  ctx: CanvasRenderingContext2D,
  samples: Float32Array,
  sampleRate: number,
  opts: PaperWaveformDrawOptions,
): void {
  const { x0, y0, width, height, viewStartSec, viewEndSec, peakAbs, strokeColor, axisColor, gridColor } = opts;
  if (!samples.length || sampleRate <= 0 || width <= 2 || height <= 4) return;

  const midY = y0 + height * 0.5;
  const halfH = height * 0.44;
  const norm = peakAbs > 1e-5 ? peakAbs : 1;

  // Subtle academic ±0.5 reference hairlines
  if (gridColor) {
    ctx.save();
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.75;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.moveTo(x0, midY - halfH * 0.5);
    ctx.lineTo(x0 + width, midY - halfH * 0.5);
    ctx.moveTo(x0, midY + halfH * 0.5);
    ctx.lineTo(x0 + width, midY + halfH * 0.5);
    ctx.stroke();
    ctx.restore();
  }

  // Crisp zero-amplitude baseline
  ctx.save();
  ctx.strokeStyle = axisColor;
  ctx.lineWidth = 0.9;
  ctx.globalAlpha = 0.75;
  ctx.beginPath();
  ctx.moveTo(x0, midY);
  ctx.lineTo(x0 + width, midY);
  ctx.stroke();
  ctx.restore();

  const spanSec = Math.max(1e-5, viewEndSec - viewStartSec);
  const startSample = Math.max(0, Math.floor(viewStartSec * sampleRate));
  const endSample = Math.min(samples.length, Math.ceil(viewEndSec * sampleRate));
  const visibleSamples = endSample - startSample;
  if (visibleSamples <= 0) return;

  const samplesPerPixel = visibleSamples / width;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, width, height);
  ctx.clip();

  ctx.strokeStyle = strokeColor;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (samplesPerPixel <= 1.5) {
    // Zoomed-in continuous oscillogram polyline through actual PCM samples
    ctx.lineWidth = 1.15;
    ctx.beginPath();
    const first = Math.max(0, startSample - 1);
    const last = Math.min(samples.length - 1, endSample + 1);
    for (let i = first; i <= last; i++) {
      const t = i / sampleRate;
      const px = x0 + ((t - viewStartSec) / spanSec) * width;
      const py = midY - (samples[i] / norm) * halfH;
      if (i === first) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  } else {
    // Classic Praat / speech-paper continuous signed min-max oscillogram trace
    const cols = Math.max(2, Math.floor(width));
    ctx.lineWidth = 1;
    ctx.beginPath();
    let prevYMin = midY;
    let prevYMax = midY;
    for (let col = 0; col < cols; col++) {
      const t0 = viewStartSec + (col / cols) * spanSec;
      const t1 = viewStartSec + ((col + 1) / cols) * spanSec;
      const i0 = Math.max(0, Math.floor(t0 * sampleRate));
      const i1 = Math.min(samples.length, Math.max(i0 + 1, Math.ceil(t1 * sampleRate)));
      let sMin = Infinity;
      let sMax = -Infinity;
      for (let i = i0; i < i1; i++) {
        const v = samples[i];
        if (v < sMin) sMin = v;
        if (v > sMax) sMax = v;
      }
      if (!Number.isFinite(sMin)) {
        sMin = 0;
        sMax = 0;
      }
      const x = x0 + col + 0.5;
      const yTop = midY - (sMax / norm) * halfH;
      const yBot = midY - (sMin / norm) * halfH;

      // Connect vertically across steep transitions so the trace stays continuous like Praat
      const drawTop = col > 0 ? Math.min(yTop, prevYMax) : yTop;
      const drawBot = col > 0 ? Math.max(yBot, prevYMin) : yBot;
      ctx.moveTo(x, drawTop);
      ctx.lineTo(x, Math.max(drawTop + 0.75, drawBot));
      prevYMin = yTop;
      prevYMax = yBot;
    }
    ctx.stroke();
  }

  ctx.restore();
}
