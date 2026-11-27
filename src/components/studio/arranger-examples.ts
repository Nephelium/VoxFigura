import type { ScoreNotationId, SongTonic } from '@vocalcut/core';
import type { Instrument } from './instrument-voices';

export interface ArrangerExampleSpec {
  id: string;
  title: string;
  badge: string;
  group?: string;
  credit?: string;
  notation: ScoreNotationId;
  lyrics: string;
  tonic: SongTonic;
  bpm: number;
  beatsPerMeasure: 2 | 3 | 4 | 6;
  interludeInstrument?: Instrument;
  /** Optional relative file under `public/examples/` (e.g. `'长恨歌.mid'`). */
  midiFile?: string;
  /** When true, load all MIDI tracks directly from `midiFile` without score compilation. */
  midiOnly?: boolean;
  score: string;
}

// 五色石南叶演唱，白居易词，王之炀传谱。依据井井提供的沁澜斯博鹭版谱图。
// 采用 JE 谱记谱法，每个字对应的音节用《》包裹，未包裹段为无词器乐间奏。
const opening = `《[3]/ [2]/》 《[1]/ 6/》 《[1]/ [2]/》 《[3]/// [2]/// [3]/.》 | 《[2]/ [3]/》 《[1]/ 6/》 《[2]/// [1]/// [2]:1.75》 |
《[1]/ 6/》 《6》 《[1]/ 6/》 《5》 | 《6/// 5/// 6/.》 《5/ 3/》 《3/// 5:1.875》`;
const answer = `《6》 《5/ 6/》 《[1]》 《[2]》 | 《[3]/// [2]/// [3]/.》 《[1]/// 6:0.875》 《5 -》 |
《6》 《[1]/ 6/》 《5/ 6/》 《5》 | 《[3]/ [2]/》 《[1]/ [2]/》 《[1] -》`;
const firstEnding = answer
  .replace('《[1]》 《[2]》 |', '《[1]》 《[2]/// [1]/// [2]/.》 |')
  .replace(/《\[1\] -》$/u, '@rit 《[1] -》');
const interlude = `@tempo [2]/// [3]/// [5]:1.25 [3] [2]/// [3]//. [2]/// [2]//. [1]/ |
[2] [5]/ [3]. 5/ 6/ | [1]/ [2]//// [3]//// [2]//. [1]/ 6/ [1]/. [2]/. [3]/ | [5] - 0 [2]/// [3]//. [5]/ |
[6]/ [6]/// [[1]]//. [[1]]/ [6] [5]/// [6]//. [5]/ [3]/ | [5]/ [6] [2]/// [3]:1.375 5/// 6//. [1]/ |
[2]/ [2]/// [3]//. [2]/ [1]/ 6/. 6/// [1]:0.625 [3]/ | [2] - - -`;
const ending = `《6》 《5/ 6/》 《[1]》 《[2]》 | 《[3]/// [2]/// [3]/.》 《[1]/// 6:0.875》 《5 -》 |
《6》 《[1]/ 6/》 《5/ 6/》 《5》 | @rit 《[3] [2]》 @hold 《[1] [2]》 | 《[1] - - -》`;

export const everlastingRegretExample: ArrangerExampleSpec = {
  id: 'everlasting-regret',
  title: '长恨歌',
  badge: 'JE · B2 · 84 BPM',
  group: '人声与伴奏示范',
  credit: '五色石南叶演唱 · 王之炀传谱 · 沁澜斯博鹭扒谱',
  notation: 'je',
  lyrics: `汉皇重色思倾国，御宇多年求不得。
杨家有女初长成，养在深闺人未识。
天生丽质难自弃，一朝选在君王侧。
回眸一笑百媚生，六宫粉黛无颜色。

临别殷勤重寄词，词中有誓两心知。
七月七日长生殿，夜半无人私语时。
在天愿作比翼鸟，在地愿为连理枝。
天长地久有时尽，此恨绵绵无绝期。`,
  tonic: 'B2',
  bpm: 84,
  beatsPerMeasure: 4,
  interludeInstrument: 'xiao',
  midiFile: '长恨歌.mid',
  score: [opening, answer, opening, firstEnding, interlude, opening, answer, opening, ending].join(' |\n\n'),
};

export const melodyAndChordsExample: ArrangerExampleSpec = {
  id: 'melody-and-chords-midi',
  title: '逐字旋律与和弦',
  badge: 'MIDI 多轨',
  group: '多轨 MIDI 示范',
  notation: 'je',
  lyrics: '',
  tonic: 'C3',
  bpm: 92,
  beatsPerMeasure: 4,
  midiFile: '逐字旋律与和弦.mid',
  midiOnly: true,
  score: '',
};

/** Built-in arranger examples shown in the example picker dropdown. Append new examples here. */
export const ARRANGER_EXAMPLES: readonly ArrangerExampleSpec[] = [
  everlastingRegretExample,
  melodyAndChordsExample,
];

export function getArrangerExample(id?: string): ArrangerExampleSpec | undefined {
  if (!id) return undefined;
  return ARRANGER_EXAMPLES.find((item) => item.id === id);
}
