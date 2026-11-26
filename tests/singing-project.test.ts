import { describe, expect, it, vi } from 'vitest';
import { readSingingProject } from '../src/components/studio/singing-project';

vi.mock('../src/components/studio/arranger-edit', () => ({
  analyzeLyrics: vi.fn(async () => [
    { char:'唱', ipa:'tʂʰaŋ', score:'', choices:[], restBefore:0 },
  ]),
}));

const quarter = 705600000;
const note = (onset:number, lyrics:string, phonemes = '') => ({
  onset, duration:quarter, pitch:60, lyrics, phonemes,
});
function project(groupID = 'verse') {
  const source = {
    time:{
      meter:[{index:0,numerator:3,denominator:4},{index:1,numerator:4,denominator:4}],
      tempo:[{position:0,bpm:120},{position:quarter,bpm:60}],
    },
    library:[{uuid:'verse',notes:[note(0,'sing','S IH NG'),note(quarter,'-')]}],
    tracks:[{
      name:'合唱',mainGroup:{uuid:'main',notes:[note(0,'唱')]},
      groups:[1,3].map(beat => ({
        groupID, blickOffset:beat*quarter, pitchOffset:2,
        database:{language:'english',phoneset:'arpabet'},
      })),
    }],
  };
  return new File(['\uFEFF', JSON.stringify(source), '\0'], 'chorus.svp');
}

describe('歌声工程直接导入', () => {
  it('keeps group instances, native phonemes, sung continuations and the tempo change', async () => {
    const {parts} = await readSingingProject(project(),'standard','JD2',5040);
    const track = parts[0];
    expect(track.events.map(n=>n.startSmp)).toEqual([5040,29040,77040,125040,173040]);
    expect(track.events.map(n=>n.midi)).toEqual([60,62,62,62,62]);
    expect(new Set(track.events.map(n=>n.id)).size).toBe(5);
    expect(track.rows.map(r=>r.ipa)).toEqual(['tʂʰaŋ','sɪŋ','sɪŋ']);
    expect(track.events[1].lyricId).toBe(track.events[2].lyricId);
    expect(track.events[1].lyricId).not.toBe(track.events[3].lyricId);
    expect(track.events[1].sourcePhones).toBe('S IH NG');
    expect(track.events[2].sourceLyric).toBe('-');
    expect(track.meters[1].beat).toBe(3);
  });
  it('rejects missing group references before modifying the arrangement', async () => {
    await expect(readSingingProject(project('absent'),'standard','JD2',0)).rejects.toThrow('absent');
  });
});
