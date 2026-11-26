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
  onePoleLowpassPhaseDelay,
  smoothstep,
  type BodyModeSpec,
} from './dsp-primitives';

export type BowedInstrument = 'violin' | 'erhu';

const VIOLIN_BODY_MODES: readonly BodyModeSpec[] = [
  { hz: 278, q: 9.5, gain: 0.62 },
  { hz: 406, q: 8.0, gain: -0.34 },
  { hz: 468, q: 10.5, gain: 0.78 },
  { hz: 548, q: 10.0, gain: -0.70 },
  { hz: 785, q: 7.5, gain: 0.52 },
  { hz: 1090, q: 6.8, gain: -0.44 },
  { hz: 1540, q: 6.5, gain: 0.44 },
  { hz: 2320, q: 5.0, gain: 0.72 },
  { hz: 2810, q: 5.4, gain: -0.64 },
  { hz: 3420, q: 4.6, gain: 0.54 },
  { hz: 4350, q: 3.6, gain: -0.28 },
];

const ERHU_BODY_MODES: readonly BodyModeSpec[] = [
  { hz: 315, q: 4.4, gain: 0.52 },
  { hz: 485, q: 5.0, gain: -0.40 },
  { hz: 695, q: 5.4, gain: 0.56 },
  { hz: 935, q: 5.8, gain: -0.50 },
  { hz: 1315, q: 6.4, gain: 0.74 },
  { hz: 1685, q: 6.2, gain: -0.62 },
  { hz: 2490, q: 5.5, gain: 0.48 },
  { hz: 3180, q: 4.8, gain: -0.34 },
  { hz: 4120, q: 3.8, gain: 0.20 },
];

export function renderBowedPhrase(
  instrument: BowedInstrument,
  notes: readonly InstrumentCue[],
  sampleRate: number,
  variation: number,
): Float32Array<ArrayBuffer> {
  const isViolin = instrument === 'violin';
  const first = notes[0];
  const last = notes.at(-1)!;
  const releaseS = isViolin ? 0.165 : 0.185;
  const phraseDurS = Math.max(0.02, last.at + last.duration - first.at);
  const totalDurS = phraseDurS + releaseS;
  const totalSamples = Math.ceil(totalDurS * sampleRate);
  const audio = new Float32Array(totalSamples);

  const minHz = Math.max(55, Math.min(...notes.map((n) => n.hz)) * 0.85);
  const maxDelay = Math.ceil(sampleRate / minHz) + 48;
  const bridgeLine = new FractionalDelayLine(maxDelay);
  const nutLine = new FractionalDelayLine(maxDelay);
  const dispersion = new AllpassDispersionChain(1, isViolin ? -0.14 : -0.10);

  const bridgePoleBase = isViolin ? 0.30 : 0.36;
  const nutPoleBase = isViolin ? 0.12 : 0.22;
  const bridgePole = clamp(Math.exp(Math.log(bridgePoleBase) * (48000 / sampleRate)), 0.06, 0.70);
  const nutPole = clamp(Math.exp(Math.log(nutPoleBase) * (48000 / sampleRate)), 0.02, 0.56);

  const bodyBank = new ModalBodyBank(isViolin ? VIOLIN_BODY_MODES : ERHU_BODY_MODES, sampleRate, isViolin ? 0.14 : 0.14);
  const bodyHp = new Biquad().setHighpass(isViolin ? 185 : 205, 0.70, sampleRate);
  const bodyLp = new Biquad().setLowpass(Math.min(sampleRate * 0.45, isViolin ? 10500 : 4300), isViolin ? 0.76 : 0.66, sampleRate);
  const nasalPresence = isViolin
    ? new Biquad().setHighShelf(2350, 3.0, sampleRate)
    : new Biquad().setPeaking(1420, 1.6, 2.4, sampleRate);
  const rosinBand = new Biquad().setBandpass(isViolin ? 4100 : 3200, 1.7, sampleRate, 1);
  const outDc = new DcBlocker(0.9975);

  const pink = createPinkNoise(Math.floor(first.hz * 523) + variation * 6151);

  const slurredTau = isViolin ? 0.0085 : 0.0155;
  const detachedTau = isViolin ? 0.0032 : 0.0065;
  const velAlpha = 1 - Math.exp(-1 / (sampleRate * 0.010));
  const bowAlpha = 1 - Math.exp(-1 / (sampleRate * (isViolin ? 0.0070 : 0.0090)));

  let currentHz = first.hz;
  let smoothVel = clamp(first.velocity ?? 0.58, 0.15, 1);
  let bridgeLpState = 0;
  let nutLpState = 0;
  let noteIdx = 0;
  let noteOnsetT = 0;
  let isBowChange = false;
  let bowDirection = variation % 2 === 0 ? 1 : -1;
  let smoothBowSpeed = 0;
  let vibPhase = (variation * 0.91) % TAU;

  const initialAttackS = clamp(isViolin ? 0.028 : 0.038, 0.010, first.duration * 0.42);
  const baseBeta = isViolin ? 0.114 : 0.100;

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    while (noteIdx + 1 < notes.length && t >= notes[noteIdx + 1].at - first.at) {
      noteIdx++;
      noteOnsetT = notes[noteIdx].at - first.at;
      isBowChange = !notes[noteIdx].legato;
      if (isBowChange) bowDirection = -bowDirection;
    }
    const note = notes[noteIdx];
    const targetVel = clamp(note.velocity ?? 0.58, 0.15, 1);
    const glideAlpha = 1 - Math.exp(-1 / (sampleRate * (note.legato ? slurredTau : detachedTau)));
    currentHz += (note.hz - currentHz) * glideAlpha;
    smoothVel += (targetVel - smoothVel) * velAlpha;

    const noteAge = Math.max(0, t - noteOnsetT);

    // Progressive vibrato onset (delayed past 180 ms so attacks lock cleanly onto pitch)
    const vibRate = isViolin ? 5.65 + 0.25 * Math.sin(t * 1.9) : 5.05 + 0.22 * Math.sin(t * 1.5);
    vibPhase += (TAU * vibRate) / sampleRate;
    const vibDelay = isViolin ? 0.18 : 0.20;
    const vibEnv = smoothstep(vibDelay, vibDelay + 0.24, noteAge);
    const s = Math.sin(vibPhase);
    const vibCents = isViolin
      ? 20.0 * s * vibEnv
      : (23.0 * s + 5.5 * s * s) * vibEnv;

    const instF0 = clamp(currentHz * 2 ** (vibCents / 1200), 55, sampleRate * 0.21);
    const omega = (TAU * instF0) / sampleRate;
    const period = sampleRate / instF0;

    const filterDelay = onePoleLowpassPhaseDelay(omega, bridgePole)
      + onePoleLowpassPhaseDelay(omega, nutPole)
      + dispersion.phaseDelayAt(omega);
    const netDelay = Math.max(4.2, period - filterDelay);
    // Physical fingerboard geometry: as effective string length shortens in high positions (> 500 Hz),
    // fractional bow-to-bridge ratio beta increases naturally, preventing octave double-slip harmonics.
    const highPos = smoothstep(420, 960, instF0);
    const posBeta = baseBeta + (isViolin ? 0.062 : 0.038) * highPos;
    const beta = clamp(posBeta * (1 + 0.015 * s * vibEnv), 0.085, 0.195);
    const bridgeDelay = Math.max(2.05, netDelay * beta);
    const nutDelay = Math.max(2.05, netDelay - bridgeDelay);

    const stringDecayTau = isViolin ? 1.65 : 1.35;
    const roundTripLoss = Math.exp(-period / (sampleRate * stringDecayTau));
    const rBridge = Math.sqrt(roundTripLoss) * (isViolin ? 0.9965 : 0.9945);
    const rNut = Math.sqrt(roundTripLoss) * (isViolin ? 0.998 : 0.9955);

    const startEnv = smoothstep(0, initialAttackS, t);
    let bowArticulation = 1;
    if (noteIdx > 0 && isBowChange && noteAge < 0.020) {
      bowArticulation = 0.28 + 0.72 * smoothstep(0.002, 0.020, noteAge);
    }
    const bowActiveEnv = t <= phraseDurS ? startEnv * bowArticulation : Math.max(0, 1 - (t - phraseDurS) / (releaseS * 0.35));
    const bowSpeedMag = (0.065 + 0.32 * (smoothVel ** 1.05)) * bowActiveEnv;
    const targetBowSpeed = bowDirection * bowSpeedMag;
    smoothBowSpeed += (targetBowSpeed - smoothBowSpeed) * bowAlpha;

    const rawBridge = bridgeLine.read(bridgeDelay);
    bridgeLpState += (1 - bridgePole) * (rawBridge - bridgeLpState);
    const vFromBridge = -rBridge * bridgeLpState;

    const rawNut = nutLine.read(nutDelay);
    nutLpState += (1 - nutPole) * (rawNut - nutLpState);
    const vFromNut = -rNut * dispersion.process(nutLpState);

    const vString = vFromBridge + vFromNut;
    const deltaV = smoothBowSpeed - vString;
    // Initial 18 ms rosin "bow bite" grips the resting string immediately, then settles into the
    // single-slip Helmholtz window (~0.62 |vBow|) so low strings never break into sul-ponticello multiplets.
    const bowBite = (noteIdx === 0 || isBowChange) && noteAge < 0.022
      ? 1 + 0.85 * (1 - noteAge / 0.022)
      : 1.0;
    const stickRatio = (isViolin ? 0.82 + 0.28 * highPos : 0.74 + 0.28 * highPos) * bowBite;
    const vStick = Math.max(0.016, Math.abs(smoothBowSpeed) * stickRatio);
    const absNorm = Math.abs(deltaV) / vStick;
    const muDynamic = isViolin ? 0.055 : 0.065;
    const friction = bowActiveEnv > 0.002
      ? (muDynamic + (0.90 - muDynamic) * Math.exp(-(absNorm ** 2.0))) * Math.min(1, bowActiveEnv * 3.5)
      : 0;

    const rosinTex = rosinBand.process(pink()) * Math.min(1, Math.abs(deltaV) * 4.2) * bowActiveEnv * (isViolin ? 0.010 : 0.013);
    const injection = deltaV * friction + rosinTex;

    nutLine.write(clamp(vFromBridge + injection, -2.6, 2.6));
    bridgeLine.write(clamp(vFromNut + injection, -2.6, 2.6));

    let bridgeDrive = rawBridge - vFromBridge * 0.42;
    if (!isViolin) {
      bridgeDrive = bridgeDrive + 0.22 * bridgeDrive * Math.abs(bridgeDrive);
    }

    const bodyOut = nasalPresence.process(bodyLp.process(bodyHp.process(bodyBank.process(bridgeDrive))));
    const cleaned = outDc.process(bodyOut);
    const endFade = smoothstep(0, 0.008, totalDurS - t) * (1 - smoothstep(phraseDurS - 0.004, totalDurS, t));
    const gainScale = isViolin ? 1.05 : 1.18;
    audio[i] = Math.tanh(cleaned * gainScale) * smoothstep(0, 0.0035, t) * endFade;
  }

  return audio;
}
