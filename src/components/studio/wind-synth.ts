import type { InstrumentCue } from './instrument-voices';
import {
  Biquad,
  DcBlocker,
  FractionalDelayLine,
  ModalBodyBank,
  TAU,
  clamp,
  createPinkNoise,
  createRng,
  dcBlockerPhaseDelay,
  onePoleLowpassPhaseDelay,
  smoothstep,
  type BodyModeSpec,
} from './dsp-primitives';

export type WindInstrument = 'dizi' | 'xiao';

const DIZI_BODY_MODES: readonly BodyModeSpec[] = [
  { hz: 540, q: 2.8, gain: 0.28 },
  { hz: 1080, q: 3.4, gain: -0.32 },
  { hz: 1760, q: 4.1, gain: 0.38 },
  { hz: 2680, q: 4.6, gain: -0.34 },
  { hz: 3850, q: 5.0, gain: 0.30 },
  { hz: 5400, q: 3.8, gain: 0.18 },
];

const XIAO_BODY_MODES: readonly BodyModeSpec[] = [
  { hz: 295, q: 2.6, gain: 0.42 },
  { hz: 590, q: 3.1, gain: -0.36 },
  { hz: 1060, q: 3.6, gain: 0.38 },
  { hz: 1720, q: 3.8, gain: -0.26 },
  { hz: 2580, q: 3.4, gain: 0.16 },
];

/**
 * Coupled open-pipe air-jet waveguide synthesizer for Chinese transverse bamboo flute (Dizi)
 * and vertical notched bamboo flute (Xiao).
 *
 * Physics highlights:
 * - Zero-mean transverse acoustic mouth perturbation enters half-period jet delay while breath pressure
 *   controls jet volume-velocity amplitude -> instant Barkhausen self-oscillation within ~12 ms and exact F0 lock (< 2 cents).
 * - Dizi: nonlinear wrinkled reed membrane (dimo) thresholded tension hardening generating crisp 2.8-7.5 kHz harmonics
 *   that bloom dynamically from p to ff, plus "tu" tongue-articulation chicane on non-slurred attacks.
 * - Xiao: jet-modulated dual-band embouchure breath ("three parts air, seven parts bamboo") + warm purple-bamboo bore.
 */
export function renderWindPhrase(
  instrument: WindInstrument,
  notes: readonly InstrumentCue[],
  sampleRate: number,
  variation: number,
): Float32Array<ArrayBuffer> {
  const isDizi = instrument === 'dizi';
  const first = notes[0];
  const last = notes.at(-1)!;
  const releaseS = isDizi ? 0.135 : 0.185;
  const totalDurS = Math.max(0.02, last.at + last.duration - first.at) + releaseS;
  const phraseDurS = totalDurS - releaseS;
  const totalSamples = Math.ceil(totalDurS * sampleRate);
  const audio = new Float32Array(totalSamples);

  const minHz = Math.max(55, Math.min(...notes.map((n) => n.hz)) * 0.85);
  const maxDelay = Math.ceil(sampleRate / minHz) + 48;
  const bore = new FractionalDelayLine(maxDelay);
  const jet = new FractionalDelayLine(Math.ceil(maxDelay * 0.65) + 16);

  // Open-end radiation lowpass pole (frequency-scaled for sampleRate independence across 24kHz..96kHz)
  const basePole = isDizi ? 0.38 : 0.52;
  const loopPole = clamp(Math.exp(Math.log(basePole) * (48000 / sampleRate)), 0.12, 0.82);
  const dcR = clamp(1 - 28 / sampleRate, 0.996, 0.9996);
  const loopDc = new DcBlocker(dcR);
  const outDc = new DcBlocker(0.9975);

  // Body & radiation filter banks
  const bodyBank = new ModalBodyBank(isDizi ? DIZI_BODY_MODES : XIAO_BODY_MODES, sampleRate, isDizi ? 0.65 : 0.82);
  const toneWarmthLp = new Biquad().setLowpass(
    Math.min(sampleRate * 0.45, isDizi ? 9800 : 3900),
    isDizi ? 0.75 : 0.65,
    sampleRate,
  );

  // Dizi wrinkled reed membrane (dimo) nonlinear resonator cluster
  const dimoMode1 = new Biquad().setBandpass(2960, 5.2, sampleRate, 0.72);
  const dimoMode2 = new Biquad().setBandpass(4580, 4.4, sampleRate, -0.56);
  const dimoMode3 = new Biquad().setBandpass(6450, 3.6, sampleRate, 0.38);

  // Embouchure edge turbulence bandpass filters
  const edgeBand = new Biquad().setBandpass(isDizi ? 3300 : 2250, isDizi ? 1.9 : 1.4, sampleRate, 1);
  const throatBand = new Biquad().setBandpass(isDizi ? 1320 : 880, 1.25, sampleRate, 1);

  const pink = createPinkNoise(Math.floor(first.hz * 431) + variation * 7919);
  const white = createRng(Math.floor(first.hz * 197) + variation * 3571);

  const glideTau = isDizi ? 0.0052 : 0.0088;
  const glideAlpha = 1 - Math.exp(-1 / (sampleRate * glideTau));
  const velAlpha = 1 - Math.exp(-1 / (sampleRate * 0.010));

  let currentHz = first.hz;
  let smoothVel = clamp(first.velocity ?? 0.58, 0.15, 1);
  let lpState = 0;
  let noteIdx = 0;
  let noteOnsetT = 0;
  let isRetongue = false;
  let vibPhase = (variation * 0.73) % TAU;

  const initialAttackS = clamp(isDizi ? 0.018 : 0.038, 0.008, first.duration * 0.40);

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    while (noteIdx + 1 < notes.length && t >= notes[noteIdx + 1].at - first.at) {
      noteIdx++;
      noteOnsetT = notes[noteIdx].at - first.at;
      isRetongue = !notes[noteIdx].legato;
    }
    const note = notes[noteIdx];
    const targetVel = clamp(note.velocity ?? 0.58, 0.15, 1);
    currentHz += (note.hz - currentHz) * glideAlpha;
    smoothVel += (targetVel - smoothVel) * velAlpha;

    const noteAge = Math.max(0, t - noteOnsetT);

    // Expressive diaphragm & embouchure vibrato (progressive onset after steady pitch establish)
    const vibRate = isDizi ? 5.55 + 0.22 * Math.sin(t * 1.7) : 4.65 + 0.18 * Math.sin(t * 1.3);
    vibPhase += (TAU * vibRate) / sampleRate;
    const vibDelay = isDizi ? 0.18 : 0.22;
    const vibEnv = smoothstep(vibDelay, vibDelay + 0.22, noteAge);
    const vibLfo = Math.sin(vibPhase);
    const vibDepthCents = (isDizi ? 14.0 : 16.0) * vibEnv;

    // Subtle crisp tongue pitch micro-inflection in the very first 14 ms
    const tongueChicane = (noteIdx === 0 || isRetongue) && noteAge < 0.016
      ? (isDizi ? 9 : -6) * Math.exp(-noteAge / 0.0045)
      : 0;
    const instF0 = clamp(currentHz * 2 ** ((vibDepthCents * vibLfo + tongueChicane) / 1200), 55, sampleRate * 0.22);

    // Exact phase-compensated bore & half-period jet delay
    const omega = (TAU * instF0) / sampleRate;
    const period = sampleRate / instF0;
    const lpDelay = onePoleLowpassPhaseDelay(omega, loopPole);
    const dcDelay = dcBlockerPhaseDelay(omega, dcR);
    const boreDelay = Math.max(2.1, period - lpDelay - dcDelay);
    const jetDelay = Math.max(2.05, period * 0.5);

    // Breath envelope: phrase start, optional light tongue articulation dip between non-legato notes, and phrase release
    const startEnv = smoothstep(0, initialAttackS, t);
    const activeBreath = t <= phraseDurS
      ? 1
      : Math.max(0, 1 - (t - phraseDurS) / (releaseS * 0.45));
    let tongueGate = 1;
    let tongueBurst = 0;
    if (noteIdx === 0) {
      tongueBurst = isDizi ? 0.10 * Math.exp(-t / 0.009) * smoothstep(0, 0.0025, t) : 0.04 * Math.exp(-t / 0.018);
    } else if (isRetongue) {
      const dipWidth = isDizi ? 0.015 : 0.024;
      if (noteAge < dipWidth) {
        const u = noteAge / dipWidth;
        tongueGate = 1 - (isDizi ? 0.65 : 0.42) * Math.sin(Math.PI * u);
      } else if (noteAge < dipWidth + 0.015) {
        tongueBurst = (isDizi ? 0.09 : 0.04) * Math.exp(-(noteAge - dipWidth) / 0.008);
      }
    }

    const breathEnv = startEnv * activeBreath * tongueGate;
    // Keep healthy oscillation drive at pp (0.24) up to ff (0.62) so fundamental always speaks cleanly
    const breathAmp = breathEnv * (0.23 + 0.40 * (smoothVel ** 1.05) + tongueBurst)
      * (1 + (isDizi ? 0.065 : 0.05) * vibLfo * vibEnv);

    // Read standing wave from bore & apply open-end radiation reflection filter
    const boreOut = bore.read(boreDelay);
    lpState += (1 - loopPole) * (boreOut - lpState);
    const boreReflected = loopDc.process(lpState);

    // Jet-modulated breath noise scales quadratically with blowing effort (gentle pure tone at pp, airy rush at ff)
    const rawPink = pink();
    const edgeNoise = edgeBand.process(white() * 0.55 + rawPink * 0.65);
    const throatNoise = throatBand.process(rawPink);
    const jetMod = 0.65 + 0.55 * clamp(boreReflected, -1, 1);
    const velAir = 0.15 + 0.85 * (smoothVel * smoothVel);
    const jetNoiseSeed = (isDizi ? 0.016 * edgeNoise + 0.010 * throatNoise : 0.034 * edgeNoise + 0.032 * throatNoise)
      * jetMod * velAir * breathEnv;

    // Read BEFORE write so jetDelay equals exact fractional sample delay (no 1-sample phase lead!)
    const jetDispl = jet.read(jetDelay);
    const jetCoupling = isDizi ? 0.90 : 0.88;
    jet.write(jetCoupling * boreReflected + jetNoiseSeed);

    const onsetBoost = 1 + 0.35 * Math.exp(-noteAge / 0.016);
    const jetBias = isDizi ? 0.13 : 0.055;
    const jetSlope = (isDizi ? 3.25 : 3.00) * onsetBoost;
    const deflected = -breathAmp * (Math.tanh(jetSlope * (jetDispl + jetBias)) - Math.tanh(jetSlope * jetBias));

    // Nonlinear Dizi Dimo (wrinkled reed membrane) located ~22% down the bore from embouchure
    let dimoRadiation = 0;
    if (isDizi) {
      const pMem = bore.readLinear(Math.max(1.5, boreDelay * 0.22));
      // Softly compliant at pp, strongly nonlinear harmonic bloom at mf..ff
      const drive = pMem * (0.32 + 2.45 * (smoothVel ** 1.45));
      const excess = Math.max(0, Math.abs(drive) - 0.12);
      const wrinkleBuzz = Math.sign(drive) * (excess ** 2.0) / (1 + excess * excess) + 0.26 * drive * Math.abs(drive);
      dimoRadiation = (dimoMode1.process(wrinkleBuzz) + dimoMode2.process(wrinkleBuzz) + dimoMode3.process(wrinkleBuzz))
        * (0.18 + 1.35 * (smoothVel ** 1.4));
    }

    const loopGain = isDizi ? 0.838 : 0.852;
    const boreNext = clamp(loopGain * boreReflected + (isDizi ? 0.38 : 0.36) * deflected, -2.2, 2.2);
    bore.write(boreNext);

    // Acoustic radiation from open toneholes, embouchure air-edge, and dimo membrane
    const rawRadiated = isDizi
      ? bodyBank.process(boreOut * 0.78) + dimoRadiation + edgeNoise * breathEnv * (0.008 * velAir + tongueBurst * 0.14)
      : bodyBank.process(boreOut * 0.90) + (edgeNoise * 0.026 + throatNoise * 0.028) * breathEnv * velAir * jetMod;

    const shaped = outDc.process(toneWarmthLp.process(rawRadiated));
    const endFade = smoothstep(0, 0.008, totalDurS - t) * (1 - smoothstep(phraseDurS, totalDurS, t));
    const dynGain = (isDizi ? 0.56 : 0.60) * (0.36 + 0.74 * (smoothVel ** 0.90));
    audio[i] = Math.tanh(shaped * dynGain) * smoothstep(0, 0.0035, t) * endFade;
  }

  return audio;
}
