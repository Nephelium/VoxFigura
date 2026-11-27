/**
 * Pure TypeScript audio beat-grid detector & rhythm synchronization helper.
 *
 * Adapted from Vincentwei1021/video-shotcraft (Apache-2.0):
 * - references/music-beat-sync.md (low-band energy onset picking + least-squares
 *   linear beat-grid regression t_i = t0 + i * T + 0.5x/1x/2x tempo disambiguation)
 *
 * Runs 100% locally in browser Web Audio / Node with zero external dependencies.
 */

import { SAMPLE_RATE_HZ, type VcProject, type VisualLayerKeyframe } from '@vocalcut/core';
import { stageLayer } from './nle-timeline';

export interface StageBeatGrid {
  bpm: number;
  t0Sec: number;
  beatIntervalSec: number;
  confidence: number;
  beatsSmp: number[];
  strongHitsSmp: number[];
  sourceLabel?: string;
}

const DEFAULT_HOP_SEC = 0.01; // 10 ms analysis hop (100 Hz envelope)

/**
 * Second-order bandpass filter centered on kick drum fundamental (45-160 Hz).
 */
function lowBandEnergyEnvelope(samples: Float32Array, sampleRate: number, hopSec = DEFAULT_HOP_SEC): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate * hopSec));
  const frames = Math.floor(samples.length / hop);
  if (frames < 8) return new Float32Array(0);

  // Simple 2nd-order Butterworth-like biquad bandpass at 95 Hz, Q = 1.0
  const f0 = 95;
  const Q = 1.0;
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosW0 = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b1 = 0;
  const b2 = -alpha / a0;
  const a1 = (-2 * cosW0) / a0;
  const a2 = (1 - alpha) / a0;

  const env = new Float32Array(frames);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let f = 0; f < frames; f++) {
    let sumSq = 0;
    const base = f * hop;
    for (let i = 0; i < hop; i++) {
      const x0 = samples[base + i] ?? 0;
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x0;
      y2 = y1; y1 = y0;
      sumSq += y0 * y0;
    }
    env[f] = Math.sqrt(sumSq / hop);
  }
  return env;
}

/**
 * Broadband RMS energy envelope (for drop / strong hit detection).
 */
function broadbandEnvelope(samples: Float32Array, sampleRate: number, hopSec = DEFAULT_HOP_SEC): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate * hopSec));
  const frames = Math.floor(samples.length / hop);
  if (frames < 8) return new Float32Array(0);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sumSq = 0;
    const base = f * hop;
    for (let i = 0; i < hop; i++) {
      const s = samples[base + i] ?? 0;
      sumSq += s * s;
    }
    env[f] = Math.sqrt(sumSq / hop);
  }
  return env;
}

function onsetStrength(env: Float32Array): Float32Array {
  const out = new Float32Array(env.length);
  for (let i = 1; i < env.length; i++) {
    out[i] = Math.max(0, env[i] - env[i - 1]);
  }
  return out;
}

function pickPeaks(curve: Float32Array, hopSec: number, refractorySec: number, zThreshold: number): { tSec: number; strength: number }[] {
  if (!curve.length) return [];
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < curve.length; i++) {
    sum += curve[i];
    sumSq += curve[i] * curve[i];
  }
  const mean = sum / curve.length;
  const std = Math.sqrt(Math.max(0, sumSq / curve.length - mean * mean));
  const threshold = mean + std * zThreshold;
  const minGap = Math.max(1, Math.round(refractorySec / hopSec));
  const peaks: { idx: number; strength: number }[] = [];

  for (let i = 1; i < curve.length - 1; i++) {
    const v = curve[i];
    if (v <= threshold || v < curve[i - 1] || v < curve[i + 1]) continue;
    const prev = peaks.at(-1);
    if (prev && i - prev.idx < minGap) {
      if (v > prev.strength) peaks[peaks.length - 1] = { idx: i, strength: v };
    } else {
      peaks.push({ idx: i, strength: v });
    }
  }
  return peaks.map(p => ({ tSec: p.idx * hopSec, strength: p.strength }));
}

function estimateInitialPeriodSec(flux: Float32Array, hopSec: number, minBpm = 70, maxBpm = 180): { periodSec: number; score: number } {
  const minLag = Math.max(2, Math.floor((60 / maxBpm) / hopSec));
  const maxLag = Math.min(flux.length - 2, Math.ceil((60 / minBpm) / hopSec));
  if (maxLag <= minLag) return { periodSec: 0.5, score: 0 };

  // Prefer tempos around 115 BPM subtly to resolve 0.5x / 2x octave ambiguity.
  let bestLag = Math.round(0.5 / hopSec);
  let bestScore = -1;
  let zeroLag = 0;
  for (let i = 0; i < flux.length; i++) zeroLag += flux[i] * flux[i];
  if (zeroLag <= 1e-12) return { periodSec: 0.5, score: 0 };

  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    const count = flux.length - lag;
    for (let i = 0; i < count; i++) acc += flux[i] * flux[i + lag];
    const norm = acc / zeroLag;
    const bpm = 60 / (lag * hopSec);
    const octavePrior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 118) / 0.55, 2));
    const weighted = norm * (0.72 + 0.28 * octavePrior);
    if (weighted > bestScore) {
      bestScore = weighted;
      bestLag = lag;
    }
  }

  // Parabolic interpolation around bestLag for sub-hop precision.
  const scoreAt = (lag: number) => {
    if (lag < 1 || lag >= flux.length) return 0;
    let acc = 0;
    for (let i = 0; i < flux.length - lag; i++) acc += flux[i] * flux[i + lag];
    return acc / zeroLag;
  };
  const yL = scoreAt(bestLag - 1);
  const yC = scoreAt(bestLag);
  const yR = scoreAt(bestLag + 1);
  const denom = yL - 2 * yC + yR;
  const shift = Math.abs(denom) > 1e-9 ? Math.max(-0.5, Math.min(0.5, 0.5 * (yL - yR) / denom)) : 0;

  return { periodSec: (bestLag + shift) * hopSec, score: Math.max(0, Math.min(1, bestScore * 2.2)) };
}

/**
 * Least-squares linear fit: t_i = t0 + i * T on inlier peaks.
 */
function fitBeatGridLeastSquares(
  peaks: readonly { tSec: number; strength: number }[],
  initPeriodSec: number,
): { t0Sec: number; periodSec: number; inlierRatio: number } {
  if (peaks.length < 3 || !Number.isFinite(initPeriodSec) || initPeriodSec <= 0.1) {
    return { t0Sec: peaks[0]?.tSec ?? 0, periodSec: initPeriodSec || 0.5, inlierRatio: 0 };
  }

  // Pick phase offset t0 that maximizes weighted inlier alignment.
  let bestT0 = peaks[0].tSec % initPeriodSec;
  let bestWeight = -1;
  const candidates = peaks.slice(0, Math.min(peaks.length, 24));
  for (const cand of candidates) {
    const phase = ((cand.tSec % initPeriodSec) + initPeriodSec) % initPeriodSec;
    let w = 0;
    for (const p of peaks) {
      const idx = Math.round((p.tSec - phase) / initPeriodSec);
      const err = Math.abs(p.tSec - (phase + idx * initPeriodSec));
      if (err <= initPeriodSec * 0.16) w += p.strength * (1 - err / (initPeriodSec * 0.16));
    }
    if (w > bestWeight) {
      bestWeight = w;
      bestT0 = phase;
    }
  }

  // Perform 2 passes of IRLS linear regression: y = t0 + T * idx
  let t0 = bestT0;
  let period = initPeriodSec;
  let inlierCount = 0;
  for (let pass = 0; pass < 2; pass++) {
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    inlierCount = 0;
    for (const p of peaks) {
      const idx = Math.round((p.tSec - t0) / period);
      const err = Math.abs(p.tSec - (t0 + idx * period));
      if (err > period * 0.18) continue;
      inlierCount++;
      const w = Math.max(1e-4, p.strength);
      sw += w;
      sx += w * idx;
      sy += w * p.tSec;
      sxx += w * idx * idx;
      sxy += w * idx * p.tSec;
    }
    const det = sw * sxx - sx * sx;
    if (inlierCount >= 3 && Math.abs(det) > 1e-9) {
      const nextPeriod = (sw * sxy - sx * sy) / det;
      const nextT0 = (sy - nextPeriod * sx) / sw;
      if (nextPeriod >= 60 / 200 && nextPeriod <= 60 / 60) {
        period = nextPeriod;
        t0 = ((nextT0 % period) + period) % period;
      }
    }
  }

  return { t0Sec: t0, periodSec: period, inlierRatio: inlierCount / peaks.length };
}

/**
 * Analyze mono PCM Float32Array and return a clean beat grid aligned to 48 kHz samples.
 */
export function detectBeatGridFromPcm(
  monoSamples: Float32Array,
  sampleRate: number,
  options: { offsetSmp?: number; sourceLabel?: string } = {},
): StageBeatGrid {
  const offsetSmp = Math.max(0, Math.round(options.offsetSmp ?? 0));
  const durationSec = monoSamples.length / Math.max(1, sampleRate);
  if (durationSec < 0.8) {
    return {
      bpm: 120,
      t0Sec: 0,
      beatIntervalSec: 0.5,
      confidence: 0,
      beatsSmp: [],
      strongHitsSmp: [],
      sourceLabel: options.sourceLabel,
    };
  }

  const lowEnv = lowBandEnergyEnvelope(monoSamples, sampleRate);
  const wideEnv = broadbandEnvelope(monoSamples, sampleRate);
  const lowFlux = onsetStrength(lowEnv);
  const wideFlux = onsetStrength(wideEnv);

  // Blend low-band kick flux (70%) + broadband transient flux (30%) for crisp percussive detection.
  const combined = new Float32Array(lowFlux.length);
  for (let i = 0; i < combined.length; i++) {
    combined[i] = lowFlux[i] * 0.72 + (wideFlux[i] ?? 0) * 0.28;
  }

  const init = estimateInitialPeriodSec(combined, DEFAULT_HOP_SEC);
  const peaks = pickPeaks(combined, DEFAULT_HOP_SEC, 0.22, 0.85);
  const fit = fitBeatGridLeastSquares(peaks, init.periodSec);

  const beatIntervalSec = Math.max(0.3, Math.min(1.0, fit.periodSec));
  const bpm = Math.round((60 / beatIntervalSec) * 10) / 10;
  const t0Sec = Math.max(0, fit.t0Sec);
  const offsetSec = offsetSmp / SAMPLE_RATE_HZ;

  const beatsSmp: number[] = [];
  for (let t = t0Sec; t <= durationSec + 1e-6; t += beatIntervalSec) {
    beatsSmp.push(Math.round((t + offsetSec) * SAMPLE_RATE_HZ));
  }

  // Identify high-energy strong hits / drops (bar accents or top 18% onset spikes, >= 1.4 s apart).
  const strongPeaks = pickPeaks(combined, DEFAULT_HOP_SEC, 1.4, 2.0);
  const strongHitsSmp = strongPeaks.map(p => Math.round((p.tSec + offsetSec) * SAMPLE_RATE_HZ));

  const confidence = Math.max(0, Math.min(1, 0.55 * init.score + 0.45 * fit.inlierRatio));

  return {
    bpm,
    t0Sec: t0Sec + offsetSec,
    beatIntervalSec,
    confidence: Math.round(confidence * 100) / 100,
    beatsSmp,
    strongHitsSmp,
    sourceLabel: options.sourceLabel,
  };
}

/**
 * Convenience wrapper accepting a Web Audio API AudioBuffer (downmixes stereo cleanly).
 */
export function detectBeatGridFromAudioBuffer(
  buffer: AudioBuffer,
  options: { offsetSmp?: number; sourceLabel?: string } = {},
): StageBeatGrid {
  const len = buffer.length;
  const chCount = Math.max(1, buffer.numberOfChannels);
  const mono = new Float32Array(len);
  const scale = 1 / chCount;
  for (let ch = 0; ch < chCount; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) mono[i] += data[i] * scale;
  }
  return detectBeatGridFromPcm(mono, buffer.sampleRate, options);
}

/**
 * Snap a 48 kHz sample coordinate to the nearest beat marker when within tolerance.
 */
export function snapSmpToBeatGrid(smp: number, grid: StageBeatGrid | null | undefined, maxDistSmp = Math.round(SAMPLE_RATE_HZ * 0.14)): number {
  if (!grid || !grid.beatsSmp.length) return smp;
  let best = smp;
  let bestDist = maxDistSmp + 1;
  for (const beat of grid.beatsSmp) {
    const d = Math.abs(beat - smp);
    if (d < bestDist) {
      bestDist = d;
      best = beat;
    }
  }
  return bestDist <= maxDistSmp ? best : smp;
}

/**
 * Evaluate beat-synced decay pulse (1.0 right on beat, fast exponential decay after beat).
 */
export function beatPulseAt(tSec: number, grid: StageBeatGrid | null | undefined, fallbackBpm = 120): {
  beatIndex: number;
  timeSinceBeatSec: number;
  pulse: number;
  isStrongHit: boolean;
  timeSinceStrongSec: number;
} {
  const interval = grid && grid.beatIntervalSec > 0.2 ? grid.beatIntervalSec : 60 / Math.max(40, fallbackBpm);
  const t0 = grid ? grid.t0Sec : 0;
  const rel = tSec - t0;
  const beatIndex = Math.floor(rel / interval);
  const timeSinceBeatSec = rel >= 0 ? rel - beatIndex * interval : interval;
  const pulse = rel >= 0 ? Math.exp(-timeSinceBeatSec * 14) : 0;

  let timeSinceStrongSec = 99;
  if (grid && grid.strongHitsSmp.length) {
    const tSmp = tSec * SAMPLE_RATE_HZ;
    for (const hit of grid.strongHitsSmp) {
      const dt = (tSmp - hit) / SAMPLE_RATE_HZ;
      if (dt >= 0 && dt < timeSinceStrongSec) timeSinceStrongSec = dt;
    }
  } else if (rel >= 0 && beatIndex % 4 === 0) {
    timeSinceStrongSec = timeSinceBeatSec;
  }

  return {
    beatIndex: Math.max(0, beatIndex),
    timeSinceBeatSec,
    pulse,
    isStrongHit: timeSinceStrongSec < 0.08,
    timeSinceStrongSec,
  };
}

export function readStageBeatGrid(project: VcProject): StageBeatGrid | null {
  const raw = stageLayer(project, 'v0')?.keys?.beat_grid?.[0]?.frame;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StageBeatGrid>;
    if (typeof parsed.bpm !== 'number' || !Array.isArray(parsed.beatsSmp)) return null;
    return {
      bpm: parsed.bpm,
      t0Sec: typeof parsed.t0Sec === 'number' ? parsed.t0Sec : 0,
      beatIntervalSec: typeof parsed.beatIntervalSec === 'number' && parsed.beatIntervalSec > 0.1
        ? parsed.beatIntervalSec
        : 60 / Math.max(40, parsed.bpm),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      beatsSmp: parsed.beatsSmp.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)),
      strongHitsSmp: Array.isArray(parsed.strongHitsSmp)
        ? parsed.strongHitsSmp.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
        : [],
      sourceLabel: typeof parsed.sourceLabel === 'string' ? parsed.sourceLabel : undefined,
    };
  } catch {
    return null;
  }
}

export function stageBeatGridKeys(grid: StageBeatGrid | null): VisualLayerKeyframe[] {
  return grid ? [{ t_smp: 0, frame: JSON.stringify(grid) }] : [];
}
