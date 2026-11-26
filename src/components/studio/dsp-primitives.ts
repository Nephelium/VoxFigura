/**
 * Acoustic DSP primitives for physical modeling & stereo room acoustics.
 * Pure TypeScript, zero external dependencies, deterministic & Float64-stabilized.
 */

export const TAU = 2 * Math.PI;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const u = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return u * u * (3 - 2 * u);
}

/** Deterministic fast xorshift32 PRNG returning uniform [-1, 1). */
export function createRng(seed: number): () => number {
  let state = (Math.imul(Math.floor(seed) | 0, 2654435761) ^ 0x9e3779b9) | 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state / 2147483648;
  };
}

/** Paul Kellet's 3-pole pink-ish filtered noise generator for organic breath & rosin texture. */
export function createPinkNoise(seed: number): () => number {
  const white = createRng(seed);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  return () => {
    const w = white();
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    return clamp((b0 + b1 + b2 + w * 0.1848) * 0.28, -1, 1);
  };
}

/**
 * Circular delay line supporting 4-point 3rd-order Lagrange fractional delay.
 * Zero state-switching clicks during continuous vibrato, portamento, and pitch bends,
 * with flat passband magnitude and exact fractional phase delay.
 */
export class FractionalDelayLine {
  private readonly buf: Float64Array;
  private cursor = 0;

  constructor(length: number) {
    this.buf = new Float64Array(Math.max(16, Math.ceil(length)));
  }

  get capacity(): number {
    return this.buf.length;
  }

  clear(): void {
    this.buf.fill(0);
    this.cursor = 0;
  }

  write(sample: number): void {
    this.buf[this.cursor] = sample;
    this.cursor = (this.cursor + 1) % this.buf.length;
  }

  /** Linear read for auxiliary taps or sub-2-sample extreme edge cases. */
  readLinear(delay: number): number {
    const len = this.buf.length;
    const d = clamp(delay, 1, len - 2);
    const pos = this.cursor + len - d;
    const base = Math.floor(pos);
    const frac = pos - base;
    return this.buf[base % len] * (1 - frac) + this.buf[(base + 1) % len] * frac;
  }

  /** 4-point 3rd-order Lagrange fractional delay read (exact delay >= 2 samples). */
  read(delay: number): number {
    const len = this.buf.length;
    if (delay < 2.02) return this.readLinear(delay);
    const d = Math.min(len - 3, delay);
    const pos = this.cursor + len * 2 - d;
    const i = Math.floor(pos);
    const u = pos - i;
    const ym1 = this.buf[(i - 1) % len];
    const y0 = this.buf[i % len];
    const y1 = this.buf[(i + 1) % len];
    const y2 = this.buf[(i + 2) % len];
    const um1 = u - 1;
    const um2 = u - 2;
    const up1 = u + 1;
    const cm1 = -(u * um1 * um2) / 6;
    const c0 = (up1 * um1 * um2) * 0.5;
    const c1 = -(up1 * u * um2) * 0.5;
    const c2 = (up1 * u * um1) / 6;
    return cm1 * ym1 + c0 * y0 + c1 * y1 + c2 * y2;
  }
}

/** Exact phase delay (in samples) of H(z) = (1 - p) / (1 - p z^-1) at angular frequency omega. */
export function onePoleLowpassPhaseDelay(omega: number, pole: number): number {
  if (omega <= 1e-9) return pole / Math.max(1e-6, 1 - pole);
  return Math.atan2(pole * Math.sin(omega), 1 - pole * Math.cos(omega)) / omega;
}

/** Exact phase delay (in samples) of H(z) = (1 - z^-1) / (1 - R z^-1) DC blocker at omega. */
export function dcBlockerPhaseDelay(omega: number, poleR: number): number {
  if (omega <= 1e-9) return 0;
  const numPhase = Math.atan2(Math.sin(omega), 1 - Math.cos(omega)); // (pi - omega) / 2
  const denPhase = Math.atan2(poleR * Math.sin(omega), 1 - poleR * Math.cos(omega));
  return -(numPhase - denPhase) / omega;
}

/**
 * Cascaded first-order allpass chain for string bending stiffness (inharmonicity).
 * Each section A(z) = (a + z^-1) / (1 + a z^-1) with a < 0 makes high partials travel faster.
 */
export class AllpassDispersionChain {
  private readonly x1: Float64Array;
  private readonly y1: Float64Array;
  private coeff: number;

  constructor(private readonly stages: number, coeff = -0.2) {
    this.x1 = new Float64Array(stages);
    this.y1 = new Float64Array(stages);
    this.coeff = clamp(coeff, -0.82, 0.82);
  }

  setCoefficient(coeff: number): void {
    this.coeff = clamp(coeff, -0.82, 0.82);
  }

  process(input: number): number {
    let x = input;
    const a = this.coeff;
    for (let i = 0; i < this.stages; i++) {
      const y = a * (x - this.y1[i]) + this.x1[i];
      this.x1[i] = x;
      this.y1[i] = y;
      x = y;
    }
    return x;
  }

  /** Exact phase delay (in samples) of the entire cascade at angular frequency omega. */
  phaseDelayAt(omega: number): number {
    if (this.stages === 0) return 0;
    const a = this.coeff;
    if (omega <= 1e-9) return this.stages * ((1 - a) / (1 + a));
    const phi = Math.atan2(a * Math.sin(omega), 1 + a * Math.cos(omega));
    return this.stages * (1 - (2 * phi) / omega);
  }
}

/** First-order DC blocker y[n] = x[n] - x[n-1] + R * y[n-1]. */
export class DcBlocker {
  private x1 = 0;
  private y1 = 0;

  constructor(private readonly r = 0.9965) {}

  process(x: number): number {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

/** Standard RBJ Biquad section in Direct Form II Transposed (Float64 state). */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }

  /** Constant-0dB-peak bandpass resonator scaled by `gain` (signed for modal phase alternation). */
  setBandpass(freqHz: number, q: number, sampleRate: number, gain = 1): this {
    const nyquistLimit = sampleRate * 0.475;
    if (freqHz <= 15 || freqHz >= nyquistLimit || q <= 0) {
      this.b0 = 0;
      this.b1 = 0;
      this.b2 = 0;
      this.a1 = 0;
      this.a2 = 0;
      return this;
    }
    const w0 = (TAU * freqHz) / sampleRate;
    const sinW = Math.sin(w0);
    const cosW = Math.cos(w0);
    const alpha = sinW / (2 * q);
    const invA0 = 1 / (1 + alpha);
    this.b0 = alpha * gain * invA0;
    this.b1 = 0;
    this.b2 = -alpha * gain * invA0;
    this.a1 = -2 * cosW * invA0;
    this.a2 = (1 - alpha) * invA0;
    return this;
  }

  setLowpass(freqHz: number, q: number, sampleRate: number): this {
    const f = clamp(freqHz, 20, sampleRate * 0.475);
    const w0 = (TAU * f) / sampleRate;
    const sinW = Math.sin(w0);
    const cosW = Math.cos(w0);
    const alpha = sinW / (2 * Math.max(0.1, q));
    const invA0 = 1 / (1 + alpha);
    const b1 = 1 - cosW;
    const b0 = b1 * 0.5;
    this.b0 = b0 * invA0;
    this.b1 = b1 * invA0;
    this.b2 = b0 * invA0;
    this.a1 = -2 * cosW * invA0;
    this.a2 = (1 - alpha) * invA0;
    return this;
  }

  setHighpass(freqHz: number, q: number, sampleRate: number): this {
    const f = clamp(freqHz, 12, sampleRate * 0.475);
    const w0 = (TAU * f) / sampleRate;
    const sinW = Math.sin(w0);
    const cosW = Math.cos(w0);
    const alpha = sinW / (2 * Math.max(0.1, q));
    const invA0 = 1 / (1 + alpha);
    const b1 = -(1 + cosW);
    const b0 = (1 + cosW) * 0.5;
    this.b0 = b0 * invA0;
    this.b1 = b1 * invA0;
    this.b2 = b0 * invA0;
    this.a1 = -2 * cosW * invA0;
    this.a2 = (1 - alpha) * invA0;
    return this;
  }

  setPeaking(freqHz: number, q: number, dbGain: number, sampleRate: number): this {
    const nyquistLimit = sampleRate * 0.475;
    if (freqHz <= 15 || freqHz >= nyquistLimit) {
      this.b0 = 1;
      this.b1 = 0;
      this.b2 = 0;
      this.a1 = 0;
      this.a2 = 0;
      return this;
    }
    const A = 10 ** (dbGain / 40);
    const w0 = (TAU * freqHz) / sampleRate;
    const alpha = Math.sin(w0) / (2 * Math.max(0.1, q));
    const cosW = Math.cos(w0);
    const invA0 = 1 / (1 + alpha / A);
    this.b0 = (1 + alpha * A) * invA0;
    this.b1 = -2 * cosW * invA0;
    this.b2 = (1 - alpha * A) * invA0;
    this.a1 = -2 * cosW * invA0;
    this.a2 = (1 - alpha / A) * invA0;
    return this;
  }

  setHighShelf(freqHz: number, dbGain: number, sampleRate: number): this {
    const f = clamp(freqHz, 80, sampleRate * 0.46);
    const A = 10 ** (dbGain / 40);
    const w0 = (TAU * f) / sampleRate;
    const cosW = Math.cos(w0);
    const alpha = (Math.sin(w0) * 0.5) * Math.SQRT2;
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
    const invA0 = 1 / ((A + 1) - (A - 1) * cosW + twoSqrtAAlpha);
    this.b0 = A * ((A + 1) + (A - 1) * cosW + twoSqrtAAlpha) * invA0;
    this.b1 = -2 * A * ((A - 1) + (A + 1) * cosW) * invA0;
    this.b2 = A * ((A + 1) + (A - 1) * cosW - twoSqrtAAlpha) * invA0;
    this.a1 = 2 * ((A - 1) - (A + 1) * cosW) * invA0;
    this.a2 = ((A + 1) - (A - 1) * cosW - twoSqrtAAlpha) * invA0;
    return this;
  }
}

export interface BodyModeSpec {
  readonly hz: number;
  readonly q: number;
  readonly gain: number;
}

/**
 * Parallel modal resonator bank + direct blend for acoustic soundboards, tubes, and cavities.
 * Alternating-sign gains naturally produce realistic inter-modal antiresonances (notches).
 */
export class ModalBodyBank {
  private readonly filters: Biquad[];

  constructor(modes: readonly BodyModeSpec[], sampleRate: number, private readonly directMix = 0) {
    this.filters = modes.map((mode) => new Biquad().setBandpass(mode.hz, mode.q, sampleRate, mode.gain));
  }

  process(x: number): number {
    let sum = x * this.directMix;
    for (let i = 0; i < this.filters.length; i++) {
      sum += this.filters[i].process(x);
    }
    return sum;
  }
}

/**
 * Synthesize a realistic stereo wooden recital hall impulse response (Early Reflections + Diffuse Tail)
 * for Web Audio ConvolverNode. Zero external assets, zero metallic comb ringing.
 */
export function buildConcertRoomImpulse(sampleRate: number, durationSeconds = 1.32): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const length = Math.ceil(durationSeconds * sampleRate);
  const left = new Float32Array(length);
  const right = new Float32Array(length);

  // Asymmetric early reflections from a warm wooden recital chamber (~11m x 15m x 6.5m)
  const earlyTapsL: readonly [number, number][] = [
    [0.0083, 0.34], [0.0147, -0.26], [0.0219, 0.23], [0.0296, 0.19],
    [0.0384, -0.16], [0.0471, 0.14], [0.0568, -0.12], [0.0663, 0.10],
  ];
  const earlyTapsR: readonly [number, number][] = [
    [0.0097, 0.33], [0.0163, -0.25], [0.0241, 0.22], [0.0328, -0.18],
    [0.0412, 0.16], [0.0509, -0.13], [0.0597, 0.11], [0.0694, -0.09],
  ];

  for (const [timeS, amp] of earlyTapsL) {
    const idx = Math.floor(timeS * sampleRate);
    if (idx < length) left[idx] += amp;
  }
  for (const [timeS, amp] of earlyTapsR) {
    const idx = Math.floor(timeS * sampleRate);
    if (idx < length) right[idx] += amp;
  }

  // Smooth early reflections with wooden wall absorption
  const erLpL = new Biquad().setLowpass(4600, 0.65, sampleRate);
  const erLpR = new Biquad().setLowpass(4500, 0.65, sampleRate);
  const erLimit = Math.min(length, Math.ceil(0.085 * sampleRate));
  for (let i = 0; i < erLimit; i++) {
    left[i] = erLpL.process(left[i]);
    right[i] = erLpR.process(right[i]);
  }

  // Decorrelated stereo diffuse tail with frequency-dependent air & wood damping
  const rngL = createRng(0x517cc1b7);
  const rngR = createRng(0x27d4eb2f);
  const tailStart = Math.floor(0.024 * sampleRate);
  const t60Mid = 1.18;
  const decayRate = 6.907755 / t60Mid; // ln(1000) / T60
  let airLpL = 0;
  let airLpR = 0;
  const hpL = new Biquad().setHighpass(135, 0.707, sampleRate);
  const hpR = new Biquad().setHighpass(135, 0.707, sampleRate);

  for (let i = tailStart; i < length; i++) {
    const t = i / sampleRate;
    const buildUp = smoothstep(0.024, 0.078, t);
    const env = buildUp * Math.exp(-decayRate * (t - 0.024)) * (1 - smoothstep(durationSeconds - 0.08, durationSeconds, t));
    // Progressive high-frequency absorption over time (warmer late reverb tail)
    const hfCoeff = clamp(0.46 - 0.30 * Math.min(1, t / durationSeconds), 0.12, 0.5);
    airLpL += hfCoeff * (rngL() - airLpL);
    airLpR += hfCoeff * (rngR() - airLpR);
    left[i] = hpL.process(left[i] + airLpL * env * 0.055);
    right[i] = hpR.process(right[i] + airLpR * env * 0.055);
  }

  // Normalize impulse energy so a 0.25 wet send maintains clean unity loudness
  let energy = 0;
  for (let i = 0; i < length; i++) {
    energy += left[i] * left[i] + right[i] * right[i];
  }
  const scale = energy > 0 ? 0.85 / Math.sqrt(energy * 0.5) : 1;
  for (let i = 0; i < length; i++) {
    left[i] *= scale;
    right[i] *= scale;
  }
  return [left, right];
}
