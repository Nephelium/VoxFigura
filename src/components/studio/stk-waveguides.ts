// Physical waveguide synthesis originally inspired by Perry R. Cook & Gary P. Scavone's STK
// (public/licenses/stk.txt), redesigned with 3rd-order fractional delay lines, exact loop phase
// compensation, nonlinear dizi dimo membrane, python-skin erhu formants, and Cremonese violin modes.
import type { InstrumentCue } from './instrument-voices';
import { renderBowedPhrase, type BowedInstrument } from './bowed-synth';
import { renderWindPhrase, type WindInstrument } from './wind-synth';

export type WaveguideInstrument = WindInstrument | BowedInstrument;

export function isWaveguideInstrument(instrument: string): instrument is WaveguideInstrument {
  return instrument === 'dizi' || instrument === 'xiao' || instrument === 'violin' || instrument === 'erhu';
}

export function renderWaveguidePhrase(
  instrument: WaveguideInstrument,
  notes: readonly InstrumentCue[],
  sampleRate: number,
  variation: number,
): Float32Array<ArrayBuffer> {
  if (instrument === 'dizi' || instrument === 'xiao') {
    return renderWindPhrase(instrument, notes, sampleRate, variation);
  }
  return renderBowedPhrase(instrument, notes, sampleRate, variation);
}
