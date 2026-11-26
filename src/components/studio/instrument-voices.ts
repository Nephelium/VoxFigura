import { renderPluckedNote } from './plucked-strings';
import { renderWaveguidePhrase } from './stk-waveguides';

export const instruments = [
  { value: 'piano', label: '钢琴' },
  { value: 'dizi', label: '笛子' },
  { value: 'xiao', label: '洞箫' },
  { value: 'violin', label: '小提琴' },
  { value: 'erhu', label: '二胡' },
  { value: 'guzheng', label: '古筝' },
  { value: 'pipa', label: '琵琶' },
  { value: 'guitar', label: '尼龙弦吉他' },
] as const;

export type Instrument = typeof instruments[number]['value'];

export interface InstrumentCue {
  hz: number;
  at: number;
  duration: number;
  volume: number;
  velocity?: number;
  legato?: boolean;
  instrument?: Instrument;
  lane?: string;
}

export function renderInstrumentNote(
  instrument: Exclude<Instrument, 'piano'>,
  note: InstrumentCue,
  sampleRate: number,
  variation: number,
): Float32Array<ArrayBuffer> {
  switch (instrument) {
    case 'dizi':
    case 'xiao':
    case 'violin':
    case 'erhu':
      return renderWaveguidePhrase(instrument, [note], sampleRate, variation);
    case 'guzheng':
    case 'pipa':
    case 'guitar':
      return renderPluckedNote(instrument, note, sampleRate, variation);
  }
}
