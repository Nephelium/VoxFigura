import type { InstrumentCue } from './instrument-voices';
import {
  AllpassDispersionChain,
  Biquad,
  DcBlocker,
  FractionalDelayLine,
  ModalBodyBank,
  TAU,
  clamp,
  createPinkNoise,
  createRng,
  smoothstep,
  type BodyModeSpec,
} from './dsp-primitives';

export type PluckedInstrument = 'guzheng' | 'pipa' | 'guitar';

const GUZHENG_BODY_MODES: readonly BodyModeSpec[] = [
  { hz: 142, q: 6.2, gain: 0.55 },
  { hz: 268, q: 6.8, gain: -0.48 },
  { hz: 435, q: 7.4, gain: 0.58 },
  { hz: 695, q: 7.8, gain: -0.52 },
  { hz: 1120, q: 7.2, gain: 0.60 },
  { hz: 1780, q: 6.4, gain: -0.46 },
  { hz: 2640, q: 5.8, gain: 0.48 },
  { hz: 3880, q: 4.8, gain: -0.34 },
  { hz: 5450, q: 3.8, gain: 0.22 },
];

const PIPA_BODY_MODES: readonly BodyModeSpec[] = [
  { hz: 315, q: 5.2, gain: 0.34 },
  { hz: 520, q: 6.4, gain: -0.42 },
  { hz: 835, q: 7.2, gain: 0.62 },
  { hz: 1280, q: 7.8, gain: -0.64 },
  { hz: 1920, q: 7.2, gain: 0.72 },
  { hz: 2820, q: 6.4, gain: -0.58 },
  { hz: 3920, q: 5.4, gain: 0.48 },
  { hz: 5350, q: 4.2, gain: -0.30 },
];

const GUITAR_BODY_MODES: readonly BodyModeSpec[] = [
  { hz: 98, q: 8.2, gain: 0.72 },
  { hz: 198, q: 8.6, gain: -0.68 },
  { hz: 292, q: 7.5, gain: 0.52 },
  { hz: 418, q: 7.0, gain: -0.44 },
  { hz: 595, q: 6.6, gain: 0.46 },
  { hz: 980, q: 5.8, gain: -0.36 },
  { hz: 1620, q: 5.0, gain: 0.30 },
  { hz: 2480, q: 4.2, gain: -0.20 },
];

interface PluckedProfile {
  readonly modes: readonly BodyModeSpec[];
  readonly pickPos: number;
  readonly baseDecayS: number;
  readonly ringOverS: number;
  readonly loopDampB: number;
  readonly dispStages: number;
  readonly dispCoeff: number;
  readonly detuneCents: number;
}

const PROFILES: Record<PluckedInstrument, PluckedProfile> = {
  guzheng: {
    modes: GUZHENG_BODY_MODES,
    pickPos: 0.132,
    baseDecayS: 2.45,
    ringOverS: 1.45,
    loopDampB: 0.042,
    dispStages: 3,
    dispCoeff: -0.25,
    detuneCents: 1.45,
  },
  pipa: {
    modes: PIPA_BODY_MODES,
    pickPos: 0.082,
    baseDecayS: 1.15,
    ringOverS: 0.68,
    loopDampB: 0.024,
    dispStages: 3,
    dispCoeff: -0.31,
    detuneCents: 1.85,
  },
  guitar: {
    modes: GUITAR_BODY_MODES,
    pickPos: 0.192,
    baseDecayS: 1.75,
    ringOverS: 0.96,
    loopDampB: 0.125,
    dispStages: 2,
    dispCoeff: -0.14,
    detuneCents: 1.05,
  },
};

/**
 * Commuted Dual-Polarization Dispersive Waveguide Plucked String Synthesizer.
 */
export function renderPluckedNote(
  instrument: PluckedInstrument,
  note: InstrumentCue,
  sampleRate: number,
  variation: number,
): Float32Array<ArrayBuffer> {
  const profile = PROFILES[instrument];
  const hz = clamp(note.hz, 45, sampleRate * 0.22);
  const velocity = clamp(note.velocity ?? 0.58, 0.12, 1);

  const pitchScale = (261.63 / Math.max(90, hz)) ** 0.34;
  const decayTauH = profile.baseDecayS * pitchScale;
  const decayTauV = decayTauH * 0.38;
  const tailS = clamp(profile.ringOverS * Math.min(1.25, pitchScale), 0.38, 1.95);
  const totalDurS = Math.max(0.06, note.duration) + tailS;
  const totalSamples = Math.ceil(totalDurS * sampleRate);
  const audio = new Float32Array(totalSamples);

  const nylonBlend = instrument === 'guitar' ? smoothstep(155, 235, hz) : 0;
  const brightVelMod = 1 - 0.36 * velocity;
  const srScale = Math.min(1.5, 48000 / sampleRate);
  const dampBBase = instrument === 'guitar'
    ? (0.052 * (1 - nylonBlend) + 0.175 * nylonBlend) * brightVelMod * srScale
    : profile.loopDampB * brightVelMod * srScale;
  const bH = clamp(dampBBase, 0.010, 0.232);
  const bV = clamp(dampBBase * 1.35, 0.015, 0.242);

  const dispCoeff = instrument === 'guitar'
    ? -0.20 * (1 - nylonBlend) - 0.04 * nylonBlend
    : profile.dispCoeff;
  const dispH = new AllpassDispersionChain(profile.dispStages, dispCoeff);
  const dispV = new AllpassDispersionChain(profile.dispStages, dispCoeff * 0.92);

  const maxDelay = Math.ceil(sampleRate / Math.max(40, hz * 0.92)) + 32;
  const stringH = new FractionalDelayLine(maxDelay);
  const stringV = new FractionalDelayLine(maxDelay);

  // Build physical pluck excitation + impulse-compensated commuted body response
  const exciteLen = Math.min(totalSamples, Math.ceil(0.068 * sampleRate));
  const excitation = new Float64Array(exciteLen);
  const rng = createRng(Math.floor(hz * 313) + variation * 4999);
  const pink = createPinkNoise(Math.floor(hz * 617) + variation * 2713);

  const pickPos = clamp(profile.pickPos + ((variation % 7) - 3) * 0.0035, 0.06, 0.26);
  const combDelaySmp = Math.max(2, Math.round((sampleRate / hz) * pickPos));

  const pulseMs = instrument === 'pipa'
    ? 1.05 - 0.38 * velocity
    : instrument === 'guzheng'
      ? 1.75 - 0.55 * velocity
      : (3.2 - 0.85 * velocity) * (0.75 + 0.35 * nylonBlend);
  const pulseSmp = Math.max(3, Math.round((pulseMs * 0.001) * sampleRate));
  const rawForce = new Float64Array(exciteLen);

  for (let i = 0; i < exciteLen; i++) {
    let f = 0;
    if (instrument === 'guitar') {
      const fleshEnd = pulseSmp;
      const nailEnd = Math.min(exciteLen - 1, pulseSmp + Math.max(2, Math.round(0.00085 * sampleRate)));
      if (i < fleshEnd) {
        f += 0.72 * Math.sin((Math.PI * i) / fleshEnd);
      } else if (i < nailEnd) {
        const u = (i - fleshEnd) / Math.max(1, nailEnd - fleshEnd);
        f += (0.38 + 0.36 * velocity) * (1 - nylonBlend * 0.32) * Math.sin(Math.PI * u);
      }
    } else {
      if (i < pulseSmp) {
        const u = i / pulseSmp;
        f += (u ** 0.72) * (1 - u ** 6);
      }
      const scrapeDecay = Math.exp(-i / (sampleRate * (instrument === 'pipa' ? 0.0022 : 0.0030)));
      f += (rng() * 0.45 + pink() * 0.55) * scrapeDecay * (instrument === 'pipa' ? 0.42 : 0.26) * (0.55 + 0.45 * velocity);
    }

    const combed = f - (i >= combDelaySmp ? 0.88 * rawForce[i - combDelaySmp] : 0);
    rawForce[i] = f;
    excitation[i] = combed;
  }

  // Impulse-energy compensated modal body (narrowband resonators need ~10x impulse gain vs direct pluck)
  const impulseScaledModes = profile.modes.map((m) => ({
    hz: m.hz,
    q: m.q,
    gain: m.gain * 9.5,
  }));
  const commutedBody = new ModalBodyBank(impulseScaledModes, sampleRate, 0.58);
  const knockBand = new Biquad().setBandpass(
    instrument === 'guitar' ? 145 : instrument === 'guzheng' ? 235 : 420,
    2.2,
    sampleRate,
    instrument === 'pipa' ? 0.95 : 1.35,
  );
  const exciteLp = new Biquad().setLowpass(
    Math.min(
      sampleRate * 0.46,
      instrument === 'guitar'
        ? (4600 * (1 - nylonBlend) + 3100 * nylonBlend) * (0.70 + 0.55 * velocity)
        : (instrument === 'pipa' ? 12500 : 9200) * (0.68 + 0.52 * velocity),
    ),
    0.72,
    sampleRate,
  );

  let sumExcSq = 1e-12;
  for (let i = 0; i < exciteLen; i++) {
    const knockLen = Math.max(3, Math.round(0.0042 * sampleRate));
    const knockPulse = i < knockLen ? Math.sin((Math.PI * i) / knockLen) * 0.42 : 0;
    const bodyColored = commutedBody.process(excitation[i]) + knockBand.process(knockPulse);
    const val = exciteLp.process(bodyColored);
    excitation[i] = val;
    sumExcSq += val * val;
  }

  // Calibrate excitation RMS energy & remove DC offset so waveguide loop never accumulates static bias
  let meanExc = 0;
  for (let i = 0; i < exciteLen; i++) meanExc += excitation[i];
  meanExc /= Math.max(1, exciteLen);
  let acSq = 1e-12;
  for (let i = 0; i < exciteLen; i++) {
    excitation[i] -= meanExc;
    acSq += excitation[i] * excitation[i];
  }
  const rmsExc = Math.sqrt(acSq / exciteLen);
  const targetExcRms = (0.045 + 0.145 * (velocity ** 1.05)) / rmsExc;
  for (let i = 0; i < exciteLen; i++) {
    excitation[i] *= targetExcRms;
  }

  const postBody = new ModalBodyBank(profile.modes.slice(0, 5), sampleRate, 0.78);
  const outDc = new DcBlocker(0.995);

  let s1H = 0;
  let s2H = 0;
  let s1V = 0;
  let s2V = 0;

  const baseOmegaH = (TAU * hz) / sampleRate;
  const f0VBase = hz * 2 ** (profile.detuneCents / 1200);
  const baseOmegaV = (TAU * f0VBase) / sampleRate;
  const fixedDispDelayH = dispH.phaseDelayAt(baseOmegaH);
  const fixedDispDelayV = dispV.phaseDelayAt(baseOmegaV);

  const periodBase = sampleRate / hz;
  const gainH = Math.exp(-periodBase / (sampleRate * decayTauH));
  const gainV = Math.exp(-periodBase / (sampleRate * decayTauV));

  const hasGuzhengPress = instrument === 'guzheng' && note.duration >= 0.48;
  const pressRate = 4.25 + (variation % 3) * 0.22;
  const fretThreshold = 0.26;
  const softReleaseStart = note.duration + tailS * 0.45;

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;

    let pitchModRatio = 1;
    if (hasGuzhengPress && t > 0.18) {
      const pressEnv = smoothstep(0.18, 0.38, t) * Math.exp(-Math.max(0, t - 0.28) * 0.85);
      const bendCents = 13.0 * (0.55 * Math.sin(TAU * pressRate * (t - 0.18)) + 0.35 * (1 - Math.cos(TAU * pressRate * 0.5 * (t - 0.18)))) * pressEnv;
      pitchModRatio = 2 ** (bendCents / 1200);
    }

    const curHzH = hz * pitchModRatio;
    const curHzV = f0VBase * pitchModRatio;
    const delayH = Math.max(2.05, sampleRate / curHzH - 1.0 - fixedDispDelayH);
    const delayV = Math.max(2.05, sampleRate / curHzV - 1.0 - fixedDispDelayV);

    const s0H = stringH.read(delayH);
    const s0V = stringV.read(delayV);

    const lpH = bH * s0H + (1 - 2 * bH) * s1H + bH * s2H;
    s2H = s1H;
    s1H = s0H;

    const lpV = bV * s0V + (1 - 2 * bV) * s1V + bV * s2V;
    s2V = s1V;
    s1V = s0V;

    const dispersedH = dispH.process(lpH);
    const dispersedV = dispV.process(lpV);

    let fretBuzz = 0;
    if (instrument === 'pipa' && t < 0.11) {
      const combinedDisp = dispersedV + 0.5 * dispersedH;
      if (combinedDisp < -fretThreshold) {
        const excess = -combinedDisp - fretThreshold;
        const buzzEnv = Math.exp(-t / 0.048) * (0.42 + 0.58 * velocity);
        fretBuzz = Math.min(0.36, (excess ** 1.3) * 0.68 * buzzEnv);
      }
    }

    const endDamp = t > softReleaseStart ? 1 - 0.022 * smoothstep(softReleaseStart, totalDurS, t) : 1;
    const exc = i < exciteLen ? excitation[i] : 0;

    const nextH = (dispersedH * gainH + dispersedV * 0.0018 + fretBuzz * 0.18) * endDamp + exc * 0.66;
    const nextV = (dispersedV * gainV + dispersedH * 0.0018 + fretBuzz * 0.36) * endDamp + exc * 0.90;

    stringH.write(clamp(nextH, -3.5, 3.5));
    stringV.write(clamp(nextV, -3.5, 3.5));

    const bridgeSignal = s0V * 0.68 + s0H * 0.56 + fretBuzz * 0.55;
    const bodyOut = postBody.process(bridgeSignal);

    const tailFade = smoothstep(0, 0.008, totalDurS - t) * (1 - smoothstep(totalDurS - 0.048, totalDurS, t));
    const gainScale = instrument === 'pipa' ? 0.92 : instrument === 'guzheng' ? 0.88 : 0.96;
    audio[i] = outDc.process(Math.tanh(bodyOut * gainScale)) * smoothstep(0, 0.0012, t) * tailFade;
  }

  return audio;
}
