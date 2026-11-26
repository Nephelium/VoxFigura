import { describe, expect, it } from 'vitest';
import { arrangementInstrumentCues } from '../src/components/studio/arranger-audio';
import { buildConcertRoomImpulse } from '../src/components/studio/dsp-primitives';
import { instruments, renderInstrumentNote, type Instrument } from '../src/components/studio/instrument-voices';
import { renderWaveguidePhrase } from '../src/components/studio/stk-waveguides';

const SR = 48000;

/** Estimate fundamental frequency (Hz) on a steady window using YIN CMNDF + parabolic interpolation. */
function estimateF0Yin(samples: Float32Array, sampleRate: number, startSec: number, windowSec: number): number {
  const start = Math.max(0, Math.floor(startSec * sampleRate));
  const N = Math.min(Math.floor(windowSec * sampleRate), samples.length - start);
  const half = Math.floor(N / 2);
  const minLag = Math.floor(sampleRate / 1800);
  const maxLag = Math.min(half - 1, Math.ceil(sampleRate / 65));

  const diff = new Float64Array(maxLag + 1);
  for (let tau = 1; tau <= maxLag; tau++) {
    let sum = 0;
    for (let i = 0; i < half; i++) {
      const d = samples[start + i] - samples[start + i + tau];
      sum += d * d;
    }
    diff[tau] = sum;
  }

  const cmndf = new Float64Array(maxLag + 1);
  cmndf[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    runningSum += diff[tau];
    cmndf[tau] = runningSum > 0 ? (diff[tau] * tau) / runningSum : 1;
  }

  let globalMin = 1;
  let globalBestTau = minLag;
  for (let tau = minLag; tau < maxLag; tau++) {
    if (cmndf[tau] < globalMin) {
      globalMin = cmndf[tau];
      globalBestTau = tau;
    }
  }
  let bestTau = globalBestTau;
  const threshold = Math.min(0.10, Math.max(0.02, globalMin * 2.5));
  for (let tau = minLag; tau < maxLag; tau++) {
    if (cmndf[tau] <= threshold) {
      while (tau + 1 < maxLag && cmndf[tau + 1] <= cmndf[tau]) tau++;
      bestTau = tau;
      break;
    }
  }

  // Parabolic refinement
  if (bestTau > minLag && bestTau < maxLag) {
    const s0 = cmndf[bestTau - 1];
    const s1 = cmndf[bestTau];
    const s2 = cmndf[bestTau + 1];
    const denom = 2 * (s0 - 2 * s1 + s2);
    if (Math.abs(denom) > 1e-12) {
      return sampleRate / (bestTau + (s0 - s2) / denom);
    }
  }
  return sampleRate / bestTau;
}

function rmsOf(samples: Float32Array, from = 0, to = samples.length): number {
  const end = Math.min(samples.length, to);
  if (end <= from) return 0;
  let sum = 0;
  for (let i = from; i < end; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (end - from));
}

/** Compute spectral centroid (Hz) and high-band energy ratio (> splitHz) via discrete Fourier bins. */
function spectralProfile(samples: Float32Array, sampleRate: number, startSec: number, durSec: number, splitHz = 2400) {
  const start = Math.floor(startSec * sampleRate);
  const N = Math.min(4096, Math.floor(durSec * sampleRate), samples.length - start);
  let weightedFreq = 0;
  let totalMag = 0;
  let highEnergy = 0;
  let lowMidEnergy = 0;
  const maxBin = Math.floor((10000 * N) / sampleRate);
  for (let k = 1; k <= maxBin; k += 2) {
    const freq = (k * sampleRate) / N;
    const w = (2 * Math.PI * k) / N;
    let re = 0;
    let im = 0;
    for (let n = 0; n < N; n++) {
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1));
      const x = samples[start + n] * hann;
      re += x * Math.cos(w * n);
      im -= x * Math.sin(w * n);
    }
    const pwr = re * re + im * im;
    const mag = Math.sqrt(pwr);
    weightedFreq += freq * mag;
    totalMag += mag;
    if (freq >= splitHz) highEnergy += pwr;
    else lowMidEnergy += pwr;
  }
  return {
    centroidHz: totalMag > 0 ? weightedFreq / totalMag : 0,
    highRatio: highEnergy / Math.max(1e-12, highEnergy + lowMidEnergy),
  };
}

describe('instrument physical synthesis acoustic verification', () => {
  const synthVoices = instruments
    .map((item) => item.value)
    .filter((v): v is Exclude<Instrument, 'piano'> => v !== 'piano');

  it('locks onto accurate fundamental pitch (< 10 cents) across registers for all 7 modeled instruments', () => {
    const testCases: Record<Exclude<Instrument, 'piano'>, number[]> = {
      dizi: [293.66, 440, 659.25, 880],
      xiao: [220, 329.63, 440, 587.33],
      violin: [196, 293.66, 440, 659.25, 880],
      erhu: [261.63, 392, 523.25, 783.99],
      guzheng: [146.83, 261.63, 440, 659.25],
      pipa: [196, 329.63, 523.25, 783.99],
      guitar: [110, 196, 329.63, 523.25],
    };

    for (const voice of synthVoices) {
      for (const targetHz of testCases[voice]) {
        const audio = renderInstrumentNote(voice, { hz: targetHz, at: 0, duration: 0.45, volume: 1, velocity: 0.65 }, SR, 0);
        // Check waveform sanity: finite, bounded, DC-free
        let allFinite = true;
        let dc = 0;
        let peak = 0;
        for (let i = 0; i < audio.length; i++) {
          const v = audio[i];
          if (!Number.isFinite(v)) allFinite = false;
          dc += v;
          const a = Math.abs(v);
          if (a > peak) peak = a;
        }
        expect(allFinite, `${voice}@${targetHz}Hz finite`).toBe(true);
        expect(Math.abs(dc / audio.length), `${voice}@${targetHz}Hz DC`).toBeLessThan(0.008);
        expect(peak, `${voice}@${targetHz}Hz audible`).toBeGreaterThan(0.08);
        expect(peak, `${voice}@${targetHz}Hz bounded`).toBeLessThanOrEqual(1.0);

        // Measure steady-state F0 before strong vibrato modulation develops
        const measuredHz = estimateF0Yin(audio, SR, 0.055, 0.12);
        const centsError = Math.abs(1200 * Math.log2(measuredHz / targetHz));
        expect(centsError, `${voice} target=${targetHz}Hz got=${measuredHz.toFixed(2)}Hz`).toBeLessThan(10);
      }
    }
  });

  it('reproduces authentic acoustic timbre signatures between counterpart instruments', () => {
    const note = { hz: 440, at: 0, duration: 0.6, volume: 1, velocity: 0.75 };
    const dizi = renderInstrumentNote('dizi', note, SR, 1);
    const xiao = renderInstrumentNote('xiao', note, SR, 1);
    const diziSpec = spectralProfile(dizi, SR, 0.08, 0.25, 2500);
    const xiaoSpec = spectralProfile(xiao, SR, 0.08, 0.25, 2500);
    // Dizi's nonlinear reed membrane (dimo) yields markedly brighter upper harmonics than vertical Xiao
    expect(diziSpec.centroidHz).toBeGreaterThan(xiaoSpec.centroidHz * 1.25);
    expect(diziSpec.highRatio).toBeGreaterThan(xiaoSpec.highRatio * 1.8);

    // Dizi dimo nonlinearity opens up dynamically with blowing velocity
    const diziSoft = spectralProfile(
      renderInstrumentNote('dizi', { ...note, velocity: 0.25 }, SR, 1),
      SR, 0.08, 0.25, 2500,
    );
    expect(diziSpec.highRatio).toBeGreaterThan(diziSoft.highRatio * 1.15);

    // Violin Bridge Hill vs Erhu vocal midrange warmth
    const violin = renderInstrumentNote('violin', { hz: 392, at: 0, duration: 0.6, volume: 1, velocity: 0.72 }, SR, 1);
    const erhu = renderInstrumentNote('erhu', { hz: 392, at: 0, duration: 0.6, volume: 1, velocity: 0.72 }, SR, 1);
    const violinSpec = spectralProfile(violin, SR, 0.1, 0.25, 2300);
    const erhuSpec = spectralProfile(erhu, SR, 0.1, 0.25, 2300);
    expect(violinSpec.centroidHz).toBeGreaterThan(erhuSpec.centroidHz);

    // Plucked sustain & brightness hierarchy: Pipa crispest attack; Guzheng longest resonant ring-over
    const pluckNote = { hz: 293.66, at: 0, duration: 0.25, volume: 1, velocity: 0.72 };
    const pipa = renderInstrumentNote('pipa', pluckNote, SR, 2);
    const guzheng = renderInstrumentNote('guzheng', pluckNote, SR, 2);
    const guitar = renderInstrumentNote('guitar', pluckNote, SR, 2);

    const pipaAttack = spectralProfile(pipa, SR, 0.005, 0.08, 2000);
    const guitarAttack = spectralProfile(guitar, SR, 0.005, 0.08, 2000);
    expect(pipaAttack.centroidHz).toBeGreaterThan(guitarAttack.centroidHz * 1.3);

    // Plucked strings ring naturally past short score duration instead of organ-like abrupt cutoff
    const guzhengRingRms = rmsOf(guzheng, Math.floor(0.32 * SR), Math.floor(0.55 * SR));
    expect(guzhengRingRms).toBeGreaterThan(0.01);
    expect(guzheng.length).toBeGreaterThan(pipa.length);
  });

  it('responds monotonically to musical dynamics (pp vs ff) and articulates repeated pitches cleanly', () => {
    for (const voice of synthVoices) {
      const pp = renderInstrumentNote(voice, { hz: 349.23, at: 0, duration: 0.4, volume: 1, velocity: 0.22 }, SR, 0);
      const ff = renderInstrumentNote(voice, { hz: 349.23, at: 0, duration: 0.4, volume: 1, velocity: 0.90 }, SR, 0);
      expect(rmsOf(ff), `${voice} ff louder than pp`).toBeGreaterThan(rmsOf(pp) * 1.35);
    }

    // Continuous waveguide phrase with slurred transition + tongued/bow-changed repeated note
    const phrase = [
      { hz: 440, at: 0, duration: 0.25, volume: 1, velocity: 0.65, legato: false },
      { hz: 493.88, at: 0.25, duration: 0.25, volume: 1, velocity: 0.7, legato: true },
      { hz: 493.88, at: 0.50, duration: 0.30, volume: 1, velocity: 0.72, legato: false },
    ];
    for (const wg of ['dizi', 'xiao', 'violin', 'erhu'] as const) {
      const wave = renderWaveguidePhrase(wg, phrase, SR, 0);
      expect(rmsOf(wave, Math.floor(0.30 * SR), Math.floor(0.45 * SR))).toBeGreaterThan(0.03);
      expect(rmsOf(wave, Math.floor(0.56 * SR), Math.floor(0.75 * SR))).toBeGreaterThan(0.03);
      expect(wave.slice(-96).every((v) => Math.abs(v) < 0.01)).toBe(true);
    }

    // Repeated instrumental notes get legato=false in arrangementInstrumentCues
    const cues = arrangementInstrumentCues([
      { startSmp: 0, endSmp: 12000, hz: 587.33, dynamic: 0, noteIndex: 0, instrumental: true },
      { startSmp: 12000, endSmp: 24000, hz: 587.33, dynamic: 0, noteIndex: 1, instrumental: true },
      { startSmp: 24000, endSmp: 36000, hz: 659.25, dynamic: 2, noteIndex: 2, instrumental: true },
    ], { startSmp: 0, endSmp: 36000 }, 'dizi');
    expect(cues[1].legato).toBe(false);
    expect(cues[2].legato).toBe(true);
    expect(cues[2].velocity!).toBeGreaterThan(cues[0].velocity! + 0.15);
  });

  it('builds a clean stereo decorrelated concert room impulse response', () => {
    const [left, right] = buildConcertRoomImpulse(SR, 1.32);
    expect(left.length).toBe(right.length);
    let dot = 0;
    let eL = 0;
    let eR = 0;
    for (let i = 0; i < left.length; i++) {
      dot += left[i] * right[i];
      eL += left[i] * left[i];
      eR += right[i] * right[i];
    }
    const corr = dot / Math.sqrt(eL * eR);
    expect(eL).toBeGreaterThan(0.1);
    expect(corr).toBeLessThan(0.75);
  });
});
