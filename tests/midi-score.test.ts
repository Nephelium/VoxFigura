import { describe, expect, it } from 'vitest';
import { writeMidi, type MidiData } from 'midi-file';
import { conflictsWithNote, exportMidiScore, fitMelody, gridBeat, gridSample, readMidiParts } from '../src/components/studio/midi-score';

const file: MidiData = {
  header: {format:1,numTracks:2,ticksPerBeat:480},
  tracks:[
    [{deltaTime:0,type:'timeSignature',numerator:3,denominator:4,metronome:24,thirtyseconds:8},
     {deltaTime:480,type:'setTempo',microsecondsPerBeat:1000000}],
    [{deltaTime:0,type:'noteOn',channel:0,noteNumber:60,velocity:101},
     {deltaTime:0,type:'noteOn',channel:0,noteNumber:64,velocity:55},
     {deltaTime:240,type:'noteOff',channel:0,noteNumber:64,velocity:0},
     {deltaTime:240,type:'noteOn',channel:1,noteNumber:67,velocity:77},
     {deltaTime:480,type:'noteOff',channel:0,noteNumber:60,velocity:0},
     {deltaTime:0,type:'noteOn',channel:1,noteNumber:67,velocity:0}],
  ],
};
describe('MIDI import and drawing grid',()=>{
  it('keeps overlapping notes, channels, velocities, time signatures and tempo changes',()=>{
    const {parts,meters,beatMap}=readMidiParts(new Uint8Array(writeMidi(file)));
    expect(parts.map(p=>p.channel)).toEqual([1,2]);
    expect(parts[0].notes.map(n=>[n.midi,n.startSmp,n.endSmp,n.velocity])).toEqual([[60,0,72000,101],[64,0,12000,55]]);
    expect(meters[0]).toEqual({beat:0,numerator:3,denominator:4});
    expect(gridSample(1.125,beatMap)).toBe(30000);
    expect(gridBeat(30000,beatMap)).toBe(1.125);
  });
});

describe('MIDI note editing and export',()=>{
  const note=(midi:number,startSmp:number,endSmp:number)=>({id:'n'+midi+startSmp,midi,startSmp,endSmp,velocity:97});
  const notes=[note(60,0,12000),note(62,12000,24000),note(61,24000,36000)];
  it('rejects overlap on the same key while permitting adjacent notes and chords',()=>{
    expect(conflictsWithNote(notes,note(60,6000,13000))).toBe(true);
    expect(conflictsWithNote(notes,note(60,12000,24000))).toBe(false);
    expect(conflictsWithNote(notes,note(64,0,12000))).toBe(false);
  });
  it('preserves Chinese lyrics, independent releases, velocity, tempo and channel controls',()=>{
    const meter=[{beat:0,numerator:3,denominator:4}];
    const map=[{beat:0,sample:0,samplesPerBeat:24000},{beat:1,sample:24000,samplesPerBeat:48000}];
    const bytes=exportMidiScore([{name:'和弦',program:24,channel:2,notes:[...notes,note(67,0,24000)],
      lyrics:[{sample:0,text:'春'}],controls:[{sample:6000,event:{type:'controller',controllerType:64,channel:1,value:127,deltaTime:0}}]}],map,meter);
    const restored=readMidiParts(bytes);
    expect(restored.parts[0]).toMatchObject({name:'和弦',program:24,channel:2,lyrics:[{sample:0,text:'春'}]});
    expect(restored.parts[0].notes.map(n=>[n.midi,n.endSmp,n.velocity])).toEqual([[60,12000,97],[67,24000,97],[62,24000,97],[61,36000,97]]);
    expect(restored.parts[0].controls?.[0]).toMatchObject({sample:6000,event:{type:'controller',controllerType:64,value:127}});
    expect(restored.meters).toEqual(meter);
  });
  it('binds all notes under a timed syllable and rejects ambiguous mappings',()=>{
    const rows=[{id:'r1',char:'春'},{id:'r2',char:'风'}];
    expect(fitMelody(rows,notes,[{sample:0,text:'春'},{sample:12000,text:'风'}]).map(n=>n.lyricId)).toEqual(['r1','r2','r2']);
    expect(()=>fitMelody(rows,notes)).toThrow('音节');
    expect(()=>fitMelody(rows,[notes[0],note(65,0,6000)])).toThrow('单音');
  });

  it('decodes GBK Chinese track names and lyrics, auto-closes unclosed notes with warning, and avoids short-note tick overlap on export', () => {
    // 1. Unclosed noteOn (no matching noteOff) should auto-close at track end with warning instead of throwing
    const unclosedMidi: MidiData = {
      header: { format: 1, numTracks: 1, ticksPerBeat: 480 },
      tracks: [[
        { deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 },
        { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 90 },
        { deltaTime: 480, type: 'noteOn', channel: 0, noteNumber: 64, velocity: 85 },
        { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 64, velocity: 0 },
      ]],
    };
    const parsedUnclosed = readMidiParts(new Uint8Array(writeMidi(unclosedMidi)));
    expect(parsedUnclosed.parts).toHaveLength(1);
    expect(parsedUnclosed.parts[0].notes).toHaveLength(2);
    expect(parsedUnclosed.warnings.length).toBeGreaterThan(0);

    // 2. GBK Chinese trackName / lyrics bytes decode cleanly instead of mojibake
    // GBK for "春风" is B4 BA B7 E7
    const gbkRaw = String.fromCharCode(0xb4, 0xba, 0xb7, 0xe7);
    const gbkMidi: MidiData = {
      header: { format: 1, numTracks: 1, ticksPerBeat: 480 },
      tracks: [[
        { deltaTime: 0, type: 'trackName', text: gbkRaw },
        { deltaTime: 0, type: 'lyrics', text: gbkRaw },
        { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 90 },
        { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
      ]],
    };
    const parsedGbk = readMidiParts(new Uint8Array(writeMidi(gbkMidi)));
    expect(parsedGbk.parts[0].name).toBe('春风');
    expect(parsedGbk.parts[0].lyrics?.[0].text).toBe('春风');

    // 3. Adjacent same-pitch very short notes export cleanly without false tick-quantization overlap error
    const shortAdj = [
      { id: 's1', midi: 60, startSmp: 0, endSmp: 55, velocity: 90 },
      { id: 's2', midi: 60, startSmp: 55, endSmp: 1200, velocity: 90 },
    ];
    const exported = exportMidiScore(
      [{ name: '快音', program: 0, channel: 1, notes: shortAdj }],
      [{ beat: 0, sample: 0, samplesPerBeat: 24000 }],
      [{ beat: 0, numerator: 4, denominator: 4 }],
    );
    const roundTrip = readMidiParts(exported);
    expect(roundTrip.parts[0].notes).toHaveLength(2);
  });
});
