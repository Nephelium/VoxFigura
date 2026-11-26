/**
 * Pure TypeScript Voice Quality & Spectral Comparison Engine for 发声调音台.
 *
 * Computes:
 *  - High-resolution narrowband/wideband STFT spectrogram slice (0..5000 Hz) + F0 & F1..F3 contours
 *  - Voiced-frame averaged narrowband power spectrum + cepstral-liftered smooth envelope
 *  - Classic experimental phonetics voice quality metrics:
 *      F0, F1, F2, F3,
 *      H1 - H2, H2 - H4, H4 - H2kHz (uncorrected harmonic differences, dB),
 *      H1* - H2*, H2* - H4*, H1* - A1*, H1* - A2*, H1* - A3* (Iseli, Shue & Alwan 2007 formant-corrected, dB),
 *      CPP (Hillenbrand 1994 Cepstral Peak Prominence, dB),
 *      HNR (Boersma 1993 Harmonics-to-Noise Ratio, dB),
 *      Spectral Tilt (0.1..4.0 kHz linear regression slope, dB/kHz).
 */

export type SpectrogramBandMode = 'narrowband' | 'wideband';

export interface HarmonicMarker {
  key: 'H1' | 'H2' | 'H4' | 'A1' | 'A2' | 'A3';
  freqHz: number;
  db: number;
}

export interface VoiceQualityMetrics {
  voicedFrames: number;
  totalFrames: number;
  f0Hz: number | null;
  f1Hz: number | null;
  f2Hz: number | null;
  f3Hz: number | null;
  h1MinusH2Db: number | null;
  h2MinusH4Db: number | null;
  h4MinusH2kDb: number | null;
  h1StarMinusH2StarDb: number | null;
  h2StarMinusH4StarDb: number | null;
  h1StarMinusA1StarDb: number | null;
  h1StarMinusA2StarDb: number | null;
  h1StarMinusA3StarDb: number | null;
  cppDb: number | null;
  hnrDb: number | null;
  spectralTiltDbPerKhz: number | null;
}

export interface IntervalSpectralAnalysis {
  startSec: number;
  endSec: number;
  durationMs: number;
  maxFreqHz: number;
  /** Row-major [row * specCols + col], row 0 = maxFreqHz (top), row (specRows - 1) = 0 Hz (bottom), in dB [-80..0] */
  specDb: Float32Array;
  specCols: number;
  specRows: number;
  f0TrackHz: Array<number | null>;
  f1TrackHz: Array<number | null>;
  f2TrackHz: Array<number | null>;
  f3TrackHz: Array<number | null>;
  /** Frequency axis for sliceDb & envelopeDb (0..maxFreqHz) */
  sliceFreqsHz: Float32Array;
  /** Averaged narrowband power spectrum normalized so max peak in 0..maxFreqHz is 0 dB */
  sliceDb: Float32Array;
  /** Smooth cepstral-liftered macro spectral envelope in dB */
  envelopeDb: Float32Array;
  markers: HarmonicMarker[];
  metrics: VoiceQualityMetrics;
}

export function fftRadix2(real: Float64Array, imag: Float64Array, inverse = false): void {
  const n = real.length;
  for (let i = 1, rev = 0; i < n; i++) {
    let bit = n >> 1;
    while (rev & bit) {
      rev ^= bit;
      bit >>= 1;
    }
    rev ^= bit;
    if (i < rev) {
      const tr = real[i];
      real[i] = real[rev];
      real[rev] = tr;
      const ti = imag[i];
      imag[i] = imag[rev];
      imag[rev] = ti;
    }
  }
  const dir = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (dir * 2 * Math.PI) / len;
    const wLenRe = Math.cos(ang);
    const wLenIm = Math.sin(ang);
    const half = len >> 1;
    for (let start = 0; start < n; start += len) {
      let wRe = 1;
      let wIm = 0;
      for (let i = start; i < start + half; i++) {
        const j = i + half;
        const uRe = real[j] * wRe - imag[j] * wIm;
        const uIm = real[j] * wIm + imag[j] * wRe;
        real[j] = real[i] - uRe;
        imag[j] = imag[i] - uIm;
        real[i] += uRe;
        imag[i] += uIm;
        const nextRe = wRe * wLenRe - wIm * wLenIm;
        wIm = wRe * wLenIm + wIm * wLenRe;
        wRe = nextRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      real[i] /= n;
      imag[i] /= n;
    }
  }
}

function median(values: readonly number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = clean.length >> 1;
  return clean.length % 2 === 1 ? clean[mid] : 0.5 * (clean[mid - 1] + clean[mid]);
}

/**
 * Estimate F0 (Hz) and Boersma (1993) Hann-window corrected HNR (dB) on a single frame.
 */
function estimateFramePitchAndHnr(
  frame: Float64Array,
  sampleRate: number,
  minF0 = 55,
  maxF0 = 520,
): { f0Hz: number | null; hnrDb: number | null } {
  const n = frame.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += frame[i];
  mean /= Math.max(1, n);

  let energy = 0;
  const centered = new Float64Array(n);
  const windowed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = frame[i] - mean;
    centered[i] = x;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1));
    windowed[i] = x * w;
    energy += windowed[i] * windowed[i];
  }
  if (energy < 1e-9) return { f0Hz: null, hnrDb: null };

  const minLag = Math.max(2, Math.floor(sampleRate / maxF0));
  const maxLag = Math.min(Math.floor(n * 0.72), Math.ceil(sampleRate / minF0));
  if (maxLag <= minLag + 2) return { f0Hz: null, hnrDb: null };

  // FFT-accelerated autocorrelation of Hann-windowed signal
  const nfft = 1 << Math.ceil(Math.log2(n * 2));
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let i = 0; i < n; i++) re[i] = windowed[i];
  fftRadix2(re, im, false);
  for (let i = 0; i < nfft; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  fftRadix2(re, im, true);
  const r0 = re[0];
  if (r0 <= 1e-12) return { f0Hz: null, hnrDb: null };

  // Analytic normalized autocorrelation of a Hann window r_w(tau) (Boersma 1993 Eq. 11)
  const hannWindowAutocorr = (lag: number): number => {
    const u = lag / n;
    if (u >= 1) return 0;
    return (1 - u) * (2 / 3 + (1 / 3) * Math.cos(2 * Math.PI * u)) + (1 / (2 * Math.PI)) * Math.sin(2 * Math.PI * u);
  };

  const rx = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    const rw = Math.max(0.08, hannWindowAutocorr(lag));
    rx[lag] = Math.min(0.9995, (re[lag] / r0) / rw);
  }

  let bestLag = -1;
  let bestVal = -1;
  // Prefer highest local peak with modest octave-cost bias (Boersma 1993)
  for (let lag = minLag; lag <= maxLag; lag++) {
    const v = rx[lag];
    if (v > rx[lag - 1] && v >= rx[lag + 1] && v > 0.32) {
      const score = v - 0.015 * Math.log2((lag * minF0) / sampleRate + 1);
      if (score > bestVal) {
        bestVal = score;
        bestLag = lag;
      }
    }
  }
  if (bestLag < 0) return { f0Hz: null, hnrDb: null };

  const y1 = rx[bestLag - 1];
  const y2 = rx[bestLag];
  const y3 = rx[bestLag + 1];
  const denom = y1 - 2 * y2 + y3;
  const shift = Math.abs(denom) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y1 - y3)) / denom)) : 0;
  const refinedLag = bestLag + shift;
  const peakR = Math.max(0.01, Math.min(0.999, y2 - 0.25 * (y1 - y3) * shift));
  const f0Hz = sampleRate / refinedLag;
  if (f0Hz < minF0 || f0Hz > maxF0) return { f0Hz: null, hnrDb: null };
  const hnrDb = 10 * Math.log10(peakR / Math.max(1e-4, 1 - peakR));
  return { f0Hz, hnrDb };
}

/**
 * Estimate F1, F2, F3 & bandwidths via 10 kHz decimated pre-emphasized LPC + Durand-Kerner complex roots.
 */
function estimateFrameFormantsLpc(
  frame: Float64Array,
  sampleRate: number,
): Array<{ fHz: number; bwHz: number }> {
  const targetSr = 10000;
  const ratio = sampleRate / targetSr;
  const decLen = Math.floor(frame.length / ratio);
  if (decLen < 48) return [];

  // Simple anti-alias box/triangle low-pass + resample to 10 kHz + 0.97 pre-emphasis + Hann window
  const x = new Float64Array(decLen);
  let prev = 0;
  for (let i = 0; i < decLen; i++) {
    const center = i * ratio;
    const i0 = Math.max(0, Math.floor(center));
    const i1 = Math.min(frame.length - 1, i0 + 1);
    const frac = center - i0;
    const s = frame[i0] + (frame[i1] - frame[i0]) * frac;
    const pre = i === 0 ? s : s - 0.97 * prev;
    prev = s;
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / Math.max(1, decLen - 1));
    x[i] = pre * w;
  }

  const order = 11;
  const r = new Float64Array(order + 1);
  for (let k = 0; k <= order; k++) {
    let acc = 0;
    for (let i = 0; i < decLen - k; i++) acc += x[i] * x[i + k];
    r[k] = acc;
  }
  if (r[0] <= 1e-11) return [];

  // Levinson-Durbin recursion for A(z) = 1 + a[1] z^-1 + ... + a[order] z^-order
  const a = new Float64Array(order + 1);
  const prevA = new Float64Array(order + 1);
  a[0] = 1;
  let err = r[0];
  for (let m = 1; m <= order; m++) {
    let sum = r[m];
    for (let j = 1; j < m; j++) sum += a[j] * r[m - j];
    const k = -sum / err;
    if (!Number.isFinite(k) || Math.abs(k) >= 0.9999) break;
    prevA.set(a);
    a[m] = k;
    for (let j = 1; j < m; j++) a[j] = prevA[j] + k * prevA[m - j];
    err *= 1 - k * k;
    if (err <= 1e-12) break;
  }

  // Solve z^p + a[1] z^(p-1) + ... + a[p] = 0 via Durand-Kerner iteration
  const p = order;
  const rootsRe = new Float64Array(p);
  const rootsIm = new Float64Array(p);
  for (let i = 0; i < p; i++) {
    const theta = (0.4 + 0.9 * i) * ((2 * Math.PI) / p);
    const rad = 0.85;
    rootsRe[i] = rad * Math.cos(theta);
    rootsIm[i] = rad * Math.sin(theta);
  }

  for (let iter = 0; iter < 42; iter++) {
    let maxDelta = 0;
    for (let i = 0; i < p; i++) {
      const zRe = rootsRe[i];
      const zIm = rootsIm[i];
      // Evaluate monic polynomial P(z) via Horner's method
      let pRe = 1;
      let pIm = 0;
      for (let k = 1; k <= p; k++) {
        const nextRe = pRe * zRe - pIm * zIm + a[k];
        const nextIm = pRe * zIm + pIm * zRe;
        pRe = nextRe;
        pIm = nextIm;
      }
      // Denominator product (z_i - z_j)
      let dRe = 1;
      let dIm = 0;
      for (let j = 0; j < p; j++) {
        if (j === i) continue;
        const diffRe = zRe - rootsRe[j];
        const diffIm = zIm - rootsIm[j];
        const nextRe = dRe * diffRe - dIm * diffIm;
        const nextIm = dRe * diffIm + dIm * diffRe;
        dRe = nextRe;
        dIm = nextIm;
      }
      const denomSq = dRe * dRe + dIm * dIm;
      if (denomSq < 1e-18) continue;
      const deltaRe = (pRe * dRe + pIm * dIm) / denomSq;
      const deltaIm = (pIm * dRe - pRe * dIm) / denomSq;
      rootsRe[i] -= deltaRe;
      rootsIm[i] -= deltaIm;
      const step = Math.hypot(deltaRe, deltaIm);
      if (step > maxDelta) maxDelta = step;
    }
    if (maxDelta < 1e-7) break;
  }

  const candidates: Array<{ fHz: number; bwHz: number }> = [];
  for (let i = 0; i < p; i++) {
    if (rootsIm[i] <= 1e-4) continue; // upper half-plane conjugate pairs only
    const mag = Math.hypot(rootsRe[i], rootsIm[i]);
    if (mag <= 0.3 || mag >= 1.02) continue;
    const angle = Math.atan2(rootsIm[i], rootsRe[i]);
    const fHz = (angle * targetSr) / (2 * Math.PI);
    const clampedMag = Math.min(0.995, mag);
    const bwHz = Math.max(45, (-Math.log(clampedMag) * targetSr) / Math.PI);
    if (fHz >= 160 && fHz <= 4600 && bwHz <= 720) {
      candidates.push({ fHz, bwHz });
    }
  }
  candidates.sort((u, v) => u.fHz - v.fHz);
  return candidates.slice(0, 4);
}

/**
 * Iseli, Shue & Alwan (2007) vocal-tract resonance gain L_i(f) in dB at frequency fHz
 * given formant frequency Fi and bandwidth Bi. Subtracting sum_{i=1..3} L_i(f) yields H*.
 */
export function formantGainDbIseli2007(
  fHz: number,
  formants: ReadonlyArray<{ fHz: number; bwHz: number }>,
  sampleRate = 16000,
): number {
  let gainDb = 0;
  const omega = (2 * Math.PI * fHz) / sampleRate;
  for (const { fHz: fi, bwHz: bi } of formants.slice(0, 3)) {
    if (!(fi > 0) || !Number.isFinite(fi)) continue;
    // Hawks & Miller (1995) / Iseli (2007) conservative bandwidth floor prevents over-correction near formant peak
    const safeBw = Math.max(bi || 80, 50 + 0.05 * fi);
    const r = Math.exp((-Math.PI * safeBw) / sampleRate);
    const omegaI = (2 * Math.PI * fi) / sampleRate;
    const num = Math.pow(1 - 2 * r * Math.cos(omegaI) + r * r, 2);
    const d1 = 1 - 2 * r * Math.cos(omega - omegaI) + r * r;
    const d2 = 1 - 2 * r * Math.cos(omega + omegaI) + r * r;
    const ratio = num / Math.max(1e-12, d1 * d2);
    gainDb += 10 * Math.log10(Math.max(1e-8, ratio));
  }
  return gainDb;
}

/**
 * Compute Hillenbrand (1994) Cepstral Peak Prominence (CPP, dB) from a Hann-windowed frame's log power spectrum.
 */
function computeFrameCppDb(logPowerDb: Float64Array, sampleRate: number): number | null {
  const nfft = logPowerDb.length;
  const re = new Float64Array(logPowerDb);
  const im = new Float64Array(nfft);
  fftRadix2(re, im, true);

  // Quefrency regression domain: [1.0 ms .. 18.0 ms] (covers 55..1000 Hz)
  const qMin = Math.max(2, Math.floor(0.001 * sampleRate));
  const qMax = Math.min((nfft >> 1) - 2, Math.ceil(0.018 * sampleRate));
  if (qMax <= qMin + 4) return null;

  // Cepstrum amplitude in dB scale (20 * log10(|c[q]|) or direct real cepstrum of dB spectrum)
  // Using Hillenbrand's power-cepstrum-in-dB convention: power of real cepstrum converted to dB
  const cepDb = new Float64Array(qMax + 1);
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  const count = qMax - qMin + 1;
  for (let q = qMin; q <= qMax; q++) {
    const valDb = 20 * Math.log10(Math.max(1e-6, Math.abs(re[q])));
    cepDb[q] = valDb;
    sumX += q;
    sumY += valDb;
    sumXX += q * q;
    sumXY += q * valDb;
  }

  const denom = count * sumXX - sumX * sumX;
  const slope = Math.abs(denom) > 1e-12 ? (count * sumXY - sumX * sumY) / denom : 0;
  const intercept = (sumY - slope * sumX) / count;

  // Peak search in speech F0 range [60..520 Hz] -> quefrency [sampleRate/520 .. sampleRate/60]
  const pMin = Math.max(qMin + 1, Math.floor(sampleRate / 520));
  const pMax = Math.min(qMax - 1, Math.ceil(sampleRate / 60));
  if (pMax <= pMin) return null;

  let bestProm = -Infinity;
  for (let q = pMin; q <= pMax; q++) {
    const prom = cepDb[q] - (intercept + slope * q);
    if (prom > bestProm) bestProm = prom;
  }
  return Number.isFinite(bestProm) ? bestProm : null;
}

function measureHarmonicPeakDb(
  magDb: Float64Array,
  binHz: number,
  targetHz: number,
  toleranceHz: number,
): { freqHz: number; db: number } | null {
  const minBin = Math.max(1, Math.floor((targetHz - toleranceHz) / binHz));
  const maxBin = Math.min(magDb.length - 2, Math.ceil((targetHz + toleranceHz) / binHz));
  if (maxBin < minBin) return null;

  let bestBin = minBin;
  let bestDb = -Infinity;
  for (let b = minBin; b <= maxBin; b++) {
    if (magDb[b] > bestDb) {
      bestDb = magDb[b];
      bestBin = b;
    }
  }
  if (!Number.isFinite(bestDb)) return null;
  const y1 = magDb[bestBin - 1];
  const y2 = magDb[bestBin];
  const y3 = magDb[bestBin + 1];
  const denom = y1 - 2 * y2 + y3;
  const shift = Math.abs(denom) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y1 - y3)) / denom)) : 0;
  const refinedDb = y2 - 0.25 * (y1 - y3) * shift;
  return { freqHz: (bestBin + shift) * binHz, db: refinedDb };
}

function cepstralSmoothEnvelope(sliceDb: Float32Array, binHz: number, cutoffSec = 0.0011): Float32Array {
  const m = sliceDb.length;
  const nfft = 1 << Math.ceil(Math.log2(m * 2));
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let i = 0; i < m; i++) re[i] = sliceDb[i];
  for (let i = m; i <= nfft >> 1; i++) re[i] = sliceDb[m - 1];
  for (let i = 1; i < nfft >> 1; i++) re[nfft - i] = re[i];

  fftRadix2(re, im, true);
  // Effective spectrum sample rate along frequency axis: nfft * binHz = original audio sample rate
  const effSr = nfft * binHz;
  const qCut = Math.max(4, Math.round(cutoffSec * effSr));
  re[0] *= 1;
  for (let q = 1; q <= nfft >> 1; q++) {
    let w = 0;
    if (q < qCut) {
      w = 0.5 + 0.5 * Math.cos((Math.PI * q) / qCut);
    }
    re[q] *= w;
    if (nfft - q !== q) re[nfft - q] *= w;
  }
  im.fill(0);
  fftRadix2(re, im, false);
  const out = new Float32Array(m);
  for (let i = 0; i < m; i++) out[i] = re[i];
  return out;
}

export interface AnalyzeIntervalOptions {
  bandMode?: SpectrogramBandMode;
  maxFreqHz?: number;
  specCols?: number;
}

export function analyzeIntervalAcoustics(
  pcm: Float32Array,
  sampleRate: number,
  startSec: number,
  endSec: number,
  opts: AnalyzeIntervalOptions = {},
): IntervalSpectralAnalysis {
  const totalSec = pcm.length / Math.max(1, sampleRate);
  const s0 = Math.max(0, Math.min(totalSec, Math.min(startSec, endSec)));
  const s1 = Math.max(s0 + 0.03, Math.min(totalSec, Math.max(startSec, endSec)));
  const i0 = Math.max(0, Math.floor(s0 * sampleRate));
  const i1 = Math.min(pcm.length, Math.ceil(s1 * sampleRate));
  const sub = pcm.subarray(i0, i1);
  const maxFreqHz = Math.min(opts.maxFreqHz ?? 5000, sampleRate * 0.48);
  const bandMode = opts.bandMode ?? 'narrowband';

  // 1. 2D Spectrogram Grid over [s0, s1]
  const specCols = Math.max(48, Math.min(240, opts.specCols ?? 156));
  const winSec = bandMode === 'narrowband' ? 0.036 : 0.008;
  const specWinLen = Math.max(32, Math.min(Math.max(32, sub.length), Math.round(winSec * sampleRate)));
  const specNfft = Math.max(512, 1 << Math.ceil(Math.log2(specWinLen * 2)));
  const specBinHz = sampleRate / specNfft;
  const specRows = Math.max(32, Math.min(specNfft >> 1, Math.floor(maxFreqHz / specBinHz) + 1));
  const specWin = Float64Array.from(
    { length: specWinLen },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, specWinLen - 1)),
  );

  const rawPowerGrid = new Float64Array(specCols * specRows);
  let maxPower = 1e-12;
  const reSpec = new Float64Array(specNfft);
  const imSpec = new Float64Array(specNfft);

  const f0TrackHz: Array<number | null> = new Array(specCols).fill(null);
  const f1TrackHz: Array<number | null> = new Array(specCols).fill(null);
  const f2TrackHz: Array<number | null> = new Array(specCols).fill(null);
  const f3TrackHz: Array<number | null> = new Array(specCols).fill(null);

  // Track contours every ~3 columns and linearly interpolate tiny 1-col gaps for smooth visual tracks
  const analysisWinLen = Math.max(64, Math.min(Math.max(64, sub.length), Math.round(0.042 * sampleRate)));
  const trackFrame = new Float64Array(analysisWinLen);
  const trackStepCols = Math.max(1, Math.floor(specCols / 42));

  for (let col = 0; col < specCols; col++) {
    const u = specCols > 1 ? col / (specCols - 1) : 0.5;
    const centerIdx = Math.round(u * Math.max(0, sub.length - 1));
    const startIdx = centerIdx - (specWinLen >> 1);
    reSpec.fill(0);
    imSpec.fill(0);
    for (let k = 0; k < specWinLen; k++) {
      const idx = startIdx + k;
      const sample = idx >= 0 && idx < sub.length ? sub[idx] : 0;
      reSpec[k] = sample * specWin[k];
    }
    fftRadix2(reSpec, imSpec, false);
    for (let r = 0; r < specRows; r++) {
      const p = reSpec[r] * reSpec[r] + imSpec[r] * imSpec[r];
      rawPowerGrid[col * specRows + r] = p;
      if (p > maxPower) maxPower = p;
    }

    if (col % trackStepCols === 0 || col === specCols - 1) {
      const aStart = centerIdx - (analysisWinLen >> 1);
      for (let k = 0; k < analysisWinLen; k++) {
        const idx = aStart + k;
        trackFrame[k] = idx >= 0 && idx < sub.length ? sub[idx] : 0;
      }
      const { f0Hz } = estimateFramePitchAndHnr(trackFrame, sampleRate);
      f0TrackHz[col] = f0Hz;
      if (f0Hz !== null || maxPower > 1e-8) {
        const formants = estimateFrameFormantsLpc(trackFrame, sampleRate);
        f1TrackHz[col] = formants[0]?.fHz ?? null;
        f2TrackHz[col] = formants[1]?.fHz ?? null;
        f3TrackHz[col] = formants[2]?.fHz ?? null;
      }
    }
  }

  // Fill intermediate contour columns cleanly
  const fillSampledTrack = (arr: Array<number | null>, maxJumpHz: number) => {
    let prevIdx = -1;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] === null) continue;
      if (prevIdx >= 0 && i - prevIdx <= trackStepCols + 1) {
        const v0 = arr[prevIdx]!;
        const v1 = arr[i]!;
        if (Math.abs(v1 - v0) <= maxJumpHz) {
          for (let k = prevIdx + 1; k < i; k++) {
            arr[k] = v0 + ((v1 - v0) * (k - prevIdx)) / (i - prevIdx);
          }
        }
      }
      prevIdx = i;
    }
  };
  fillSampledTrack(f0TrackHz, 70);
  fillSampledTrack(f1TrackHz, 260);
  fillSampledTrack(f2TrackHz, 420);
  fillSampledTrack(f3TrackHz, 520);

  const specDb = new Float32Array(specCols * specRows);
  for (let col = 0; col < specCols; col++) {
    for (let r = 0; r < specRows; r++) {
      const relDb = 10 * Math.log10(Math.max(1e-12, rawPowerGrid[col * specRows + r] / maxPower));
      // Row 0 = highest frequency (top), row (specRows - 1) = 0 Hz (bottom)
      specDb[(specRows - 1 - r) * specCols + col] = Math.max(-80, Math.min(0, relDb));
    }
  }

  // 2. Frame-by-frame Voice Quality Measurement & Narrowband Slice Accumulation (12 ms hop, 42 ms Hann window)
  const vqWinLen = Math.max(64, Math.min(Math.max(64, sub.length), Math.round(0.042 * sampleRate)));
  const vqHop = Math.max(16, Math.round(0.012 * sampleRate));
  const sliceNfft = Math.max(2048, 1 << Math.ceil(Math.log2(Math.max(vqWinLen * 2, sampleRate * 0.12))));
  const sliceBinHz = sampleRate / sliceNfft;
  const sliceBins = Math.max(64, Math.min(sliceNfft >> 1, Math.floor(maxFreqHz / sliceBinHz) + 1));

  const vqWin = Float64Array.from(
    { length: vqWinLen },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, vqWinLen - 1)),
  );
  const accumPower = new Float64Array(sliceBins);
  const accumAllPower = new Float64Array(sliceBins);
  let voicedFrames = 0;
  let totalFrames = 0;

  const f0List: number[] = [];
  const f1List: number[] = [];
  const f2List: number[] = [];
  const f3List: number[] = [];
  const h1h2List: number[] = [];
  const h2h4List: number[] = [];
  const h4h2kList: number[] = [];
  const h1h2StarList: number[] = [];
  const h2h4StarList: number[] = [];
  const h1a1StarList: number[] = [];
  const h1a2StarList: number[] = [];
  const h1a3StarList: number[] = [];
  const cppList: number[] = [];
  const hnrList: number[] = [];

  const frameBuf = new Float64Array(vqWinLen);
  const reVq = new Float64Array(sliceNfft);
  const imVq = new Float64Array(sliceNfft);
  const fullLogPow = new Float64Array(sliceNfft);
  const halfMagDb = new Float64Array(sliceBins);

  const frameStarts: number[] = [];
  if (sub.length <= vqWinLen) {
    frameStarts.push(0);
  } else {
    for (let pos = 0; pos + vqWinLen <= sub.length; pos += vqHop) frameStarts.push(pos);
    if (frameStarts.length === 0) frameStarts.push(0);
  }

  for (const pos of frameStarts) {
    totalFrames++;
    frameBuf.fill(0);
    reVq.fill(0);
    imVq.fill(0);
    let rmsSq = 0;
    for (let k = 0; k < vqWinLen && pos + k < sub.length; k++) {
      const s = sub[pos + k];
      frameBuf[k] = s;
      rmsSq += s * s;
      reVq[k] = s * vqWin[k];
    }
    if (rmsSq / vqWinLen < 1e-8) continue;

    fftRadix2(reVq, imVq, false);
    for (let b = 0; b < sliceNfft; b++) {
      const p = reVq[b] * reVq[b] + imVq[b] * imVq[b];
      fullLogPow[b] = 10 * Math.log10(Math.max(1e-14, p));
      if (b < sliceBins) {
        accumAllPower[b] += p;
        halfMagDb[b] = fullLogPow[b];
      }
    }

    const cpp = computeFrameCppDb(fullLogPow, sampleRate);
    if (cpp !== null) cppList.push(cpp);

    const { f0Hz, hnrDb } = estimateFramePitchAndHnr(frameBuf, sampleRate);
    const formants = estimateFrameFormantsLpc(frameBuf, sampleRate);
    if (formants[0]) f1List.push(formants[0].fHz);
    if (formants[1]) f2List.push(formants[1].fHz);
    if (formants[2]) f3List.push(formants[2].fHz);

    if (f0Hz !== null) {
      voicedFrames++;
      f0List.push(f0Hz);
      if (hnrDb !== null) hnrList.push(hnrDb);
      for (let b = 0; b < sliceBins; b++) {
        accumPower[b] += reVq[b] * reVq[b] + imVq[b] * imVq[b];
      }

      const tol = Math.max(18, f0Hz * 0.14);
      const h1 = measureHarmonicPeakDb(halfMagDb, sliceBinHz, f0Hz, tol);
      const h2 = measureHarmonicPeakDb(halfMagDb, sliceBinHz, 2 * f0Hz, tol);
      const h4 = measureHarmonicPeakDb(halfMagDb, sliceBinHz, 4 * f0Hz, tol * 1.25);
      const h2k = measureHarmonicPeakDb(halfMagDb, sliceBinHz, 2000, Math.max(f0Hz * 0.75, 110));

      if (h1 && h2) h1h2List.push(h1.db - h2.db);
      if (h2 && h4) h2h4List.push(h2.db - h4.db);
      if (h4 && h2k) h4h2kList.push(h4.db - h2k.db);

      if (formants.length >= 1 && h1 && h2) {
        const h1Star = h1.db - formantGainDbIseli2007(h1.freqHz, formants, sampleRate);
        const h2Star = h2.db - formantGainDbIseli2007(h2.freqHz, formants, sampleRate);
        h1h2StarList.push(h1Star - h2Star);
        if (h4) {
          const h4Star = h4.db - formantGainDbIseli2007(h4.freqHz, formants, sampleRate);
          h2h4StarList.push(h2Star - h4Star);
        }
        const aTol = Math.max(f0Hz * 0.85, 95);
        if (formants[0]) {
          const a1 = measureHarmonicPeakDb(halfMagDb, sliceBinHz, formants[0].fHz, aTol);
          if (a1) h1a1StarList.push(h1Star - (a1.db - formantGainDbIseli2007(a1.freqHz, formants, sampleRate)));
        }
        if (formants[1]) {
          const a2 = measureHarmonicPeakDb(halfMagDb, sliceBinHz, formants[1].fHz, aTol);
          if (a2) h1a2StarList.push(h1Star - (a2.db - formantGainDbIseli2007(a2.freqHz, formants, sampleRate)));
        }
        if (formants[2]) {
          const a3 = measureHarmonicPeakDb(halfMagDb, sliceBinHz, formants[2].fHz, aTol);
          if (a3) h1a3StarList.push(h1Star - (a3.db - formantGainDbIseli2007(a3.freqHz, formants, sampleRate)));
        }
      }
    }
  }

  const chosenPower = voicedFrames > 0 ? accumPower : accumAllPower;
  const chosenCount = Math.max(1, voicedFrames > 0 ? voicedFrames : totalFrames);
  let slicePeakPow = 1e-14;
  for (let b = 0; b < sliceBins; b++) {
    const avgP = chosenPower[b] / chosenCount;
    if (avgP > slicePeakPow) slicePeakPow = avgP;
  }

  const sliceFreqsHz = new Float32Array(sliceBins);
  const sliceDb = new Float32Array(sliceBins);
  for (let b = 0; b < sliceBins; b++) {
    sliceFreqsHz[b] = b * sliceBinHz;
    const avgP = chosenPower[b] / chosenCount;
    sliceDb[b] = Math.max(-85, 10 * Math.log10(Math.max(1e-14, avgP / slicePeakPow)));
  }
  const envelopeDb = cepstralSmoothEnvelope(sliceDb, sliceBinHz, 0.0011);

  // Compute overall spectral tilt (dB / kHz) from 100 Hz to min(4000 Hz, maxFreqHz)
  let tiltSlope: number | null = null;
  const tiltLoBin = Math.max(1, Math.ceil(100 / sliceBinHz));
  const tiltHiBin = Math.min(sliceBins - 1, Math.floor(Math.min(4000, maxFreqHz) / sliceBinHz));
  if (tiltHiBin > tiltLoBin + 6) {
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    const cnt = tiltHiBin - tiltLoBin + 1;
    for (let b = tiltLoBin; b <= tiltHiBin; b++) {
      const fKhz = sliceFreqsHz[b] / 1000;
      const y = envelopeDb[b];
      sx += fKhz;
      sy += y;
      sxx += fKhz * fKhz;
      sxy += fKhz * y;
    }
    const den = cnt * sxx - sx * sx;
    if (Math.abs(den) > 1e-9) tiltSlope = (cnt * sxy - sx * sy) / den;
  }

  // Build Harmonic Markers on averaged slice for visual callouts
  const markers: HarmonicMarker[] = [];
  const medF0 = median(f0List);
  const medF1 = median(f1List);
  const medF2 = median(f2List);
  const medF3 = median(f3List);
  const sliceFloat64 = Float64Array.from(sliceDb);
  if (medF0 !== null) {
    const tol = Math.max(18, medF0 * 0.16);
    const h1 = measureHarmonicPeakDb(sliceFloat64, sliceBinHz, medF0, tol);
    const h2 = measureHarmonicPeakDb(sliceFloat64, sliceBinHz, 2 * medF0, tol);
    const h4 = measureHarmonicPeakDb(sliceFloat64, sliceBinHz, 4 * medF0, tol * 1.3);
    if (h1) markers.push({ key: 'H1', ...h1 });
    if (h2) markers.push({ key: 'H2', ...h2 });
    if (h4 && h4.freqHz <= maxFreqHz) markers.push({ key: 'H4', ...h4 });

    const aTol = Math.max(medF0 * 0.85, 95);
    if (medF1 !== null && medF1 <= maxFreqHz) {
      const a1 = measureHarmonicPeakDb(sliceFloat64, sliceBinHz, medF1, aTol);
      if (a1) markers.push({ key: 'A1', ...a1 });
    }
    if (medF2 !== null && medF2 <= maxFreqHz) {
      const a2 = measureHarmonicPeakDb(sliceFloat64, sliceBinHz, medF2, aTol);
      if (a2) markers.push({ key: 'A2', ...a2 });
    }
    if (medF3 !== null && medF3 <= maxFreqHz) {
      const a3 = measureHarmonicPeakDb(sliceFloat64, sliceBinHz, medF3, aTol);
      if (a3) markers.push({ key: 'A3', ...a3 });
    }
  }

  return {
    startSec: s0,
    endSec: s1,
    durationMs: Math.round((s1 - s0) * 1000),
    maxFreqHz,
    specDb,
    specCols,
    specRows,
    f0TrackHz,
    f1TrackHz,
    f2TrackHz,
    f3TrackHz,
    sliceFreqsHz,
    sliceDb,
    envelopeDb,
    markers,
    metrics: {
      voicedFrames,
      totalFrames,
      f0Hz: medF0,
      f1Hz: medF1,
      f2Hz: medF2,
      f3Hz: medF3,
      h1MinusH2Db: median(h1h2List),
      h2MinusH4Db: median(h2h4List),
      h4MinusH2kDb: median(h4h2kList),
      h1StarMinusH2StarDb: median(h1h2StarList),
      h2StarMinusH4StarDb: median(h2h4StarList),
      h1StarMinusA1StarDb: median(h1a1StarList),
      h1StarMinusA2StarDb: median(h1a2StarList),
      h1StarMinusA3StarDb: median(h1a3StarList),
      cppDb: median(cppList),
      hnrDb: median(hnrList),
      spectralTiltDbPerKhz: tiltSlope,
    },
  };
}

/**
 * Locate the most strongly modulated voiced region ( ~180..380 ms ) to serve as default selection.
 */
export function findMostModulatedSpan(
  appliedCurve: readonly number[] | undefined,
  voicedGate: readonly number[] | undefined,
  durationSec: number,
): [number, number] {
  const dur = Math.max(0.08, durationSec);
  const defaultSpan = Math.min(dur, Math.max(0.14, Math.min(0.36, dur * 0.34)));
  const n = appliedCurve?.length ?? 0;
  if (n < 3) {
    const mid = dur * 0.5;
    const s0 = Math.max(0, mid - defaultSpan * 0.5);
    return [s0, Math.min(dur, s0 + defaultSpan)];
  }

  const winFrames = Math.max(2, Math.min(n, Math.round((defaultSpan / dur) * n)));
  let bestStart = 0;
  let bestScore = -1;
  for (let i = 0; i + winFrames <= n; i++) {
    let sum = 0;
    for (let k = 0; k < winFrames; k++) {
      const w = appliedCurve![i + k] ?? 0;
      const g = voicedGate?.length === n ? (voicedGate[i + k] ?? 1) : 1;
      sum += w * (0.25 + 0.75 * g);
    }
    if (sum > bestScore) {
      bestScore = sum;
      bestStart = i;
    }
  }
  const s0 = Math.max(0, (bestStart / Math.max(1, n - 1)) * dur);
  const s1 = Math.min(dur, s0 + defaultSpan);
  return s1 - s0 >= 0.05 ? [s0, s1] : [0, Math.min(dur, defaultSpan)];
}

/**
 * Map a Before time interval `[startSec, endSec]` to the corresponding After interval when duration differs.
 */
export function mapBeforeSpanToAfter(
  spanBefore: readonly [number, number],
  durBeforeSec: number,
  durAfterSec: number,
): [number, number] {
  if (!(durBeforeSec > 0) || !(durAfterSec > 0) || Math.abs(durBeforeSec - durAfterSec) < 0.015) {
    return [
      Math.max(0, Math.min(durAfterSec, spanBefore[0])),
      Math.max(0.04, Math.min(durAfterSec, spanBefore[1])),
    ];
  }
  const scale = durAfterSec / durBeforeSec;
  const a0 = Math.max(0, Math.min(durAfterSec, spanBefore[0] * scale));
  const a1 = Math.max(a0 + 0.04, Math.min(durAfterSec, spanBefore[1] * scale));
  return [a0, a1];
}
