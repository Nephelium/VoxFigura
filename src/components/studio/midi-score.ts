import { parseMidi, writeMidi, type MidiEvent } from 'midi-file';
import { SAMPLE_RATE_HZ } from '@vocalcut/core';
import type { Instrument } from './instrument-voices';

export interface EventNote {
  id: string;
  midi: number;
  startSmp: number;
  endSmp: number;
  velocity: number;
  lyricId?: string;
  sourceLyric?: string;
  sourcePhones?: string;
  sourceAlphabet?: string;
}
export interface BeatChange { beat: number; sample: number; samplesPerBeat: number }

export function gridSample(beat: number, map: readonly BeatChange[]) {
  const change = beatChangeAt(beat, map, 'beat');
  return Math.round(change.sample + (beat - change.beat) * change.samplesPerBeat);
}

function beatChangeAt(value: number, map: readonly BeatChange[], key: 'beat' | 'sample') {
  let left = 0, right = map.length;
  while (right - left > 1) {
    const middle = Math.floor((left + right) / 2);
    if (map[middle][key] <= value) left = middle;
    else right = middle;
  }
  return map[left];
}

export function gridBeat(sample: number, map: readonly BeatChange[]) {
  const change = beatChangeAt(sample, map, 'sample');
  return change.beat + (sample - change.sample) / change.samplesPerBeat;
}

export interface MeterChange { beat:number; numerator:number; denominator:number }
type ChannelControl = Extract<MidiEvent,{type:'controller'|'pitchBend'|'channelAftertouch'|'noteAftertouch'}>;
export interface MidiControl { sample:number; event:ChannelControl }
export const instrumentPrograms: Record<Instrument,number> = {piano:0,guitar:24,violin:40,xiao:77,dizi:73,erhu:110,guzheng:107,pipa:105};
export interface ImportedPart {
  controls?: MidiControl[];
  name: string;
  notes: EventNote[];
  instrument: Instrument;
  channel: number;
  program: number;
  lyrics?: {sample:number;text:string}[];
}
function midiText(raw: string) {
  const bytes=Uint8Array.from(raw, char=>char.charCodeAt(0));
  try { return new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
  catch { return raw; }
}

export function readMidiParts(bytes: Uint8Array) {
  if (bytes.length > 16 * 1024 * 1024) throw new Error('请将 MIDI 拆成小于 16 MiB 的文件');
  const { header, tracks } = parseMidi(bytes);
  const ppq = header.ticksPerBeat;
  if (!ppq || header.format > 1 || tracks.length !== header.numTracks) throw new Error('需要完整的 Format 0/1、PPQ 时间基准 MIDI 文件');
  const meters=new Map<number,MeterChange>([[0,{beat:0,numerator:4,denominator:4}]]);
  const changes = new Map([[0, 500000]]);
  for (const track of tracks) {
    let tick = 0;
    for (const event of track) {
      tick += event.deltaTime;
      if (event.type === 'timeSignature' && event.numerator>0 && event.denominator>0) meters.set(tick,{beat:tick/ppq,numerator:event.numerator,denominator:event.denominator});
      if (event.type === 'setTempo') changes.set(tick, event.microsecondsPerBeat);
    }
  }
  const tempos = [...changes].sort((a,b) => a[0]-b[0]).map(([tick, us]) => ({tick, us, sample: 0}));
  for (const [i, tempo] of tempos.entries()) {
    if (tempo.us <= 0) throw new Error('MIDI 速度无效');
    if (i) {
      const prev = tempos[i-1];
      tempo.sample = prev.sample + (tempo.tick-prev.tick)*prev.us*SAMPLE_RATE_HZ/(ppq*1e6);
    }
  }
  function sample(tick: number) {
    let lo = 0, hi = tempos.length;
    while (hi-lo > 1) {
      const mid = Math.floor((hi+lo)/2);
      if (tempos[mid].tick <= tick) lo = mid; else hi = mid;
    }
    const t = tempos[lo];
    return Math.round(t.sample + (tick-t.tick)*t.us*SAMPLE_RATE_HZ/(ppq!*1e6));
  }
  const parts: ImportedPart[] = [];
  const playbackLimits=new Set<string>();
  const lyricTracks:{track:number;lyrics:{sample:number;text:string}[]}[]=[];
  for (const [index, track] of tracks.entries()) {
    const name = midiText(track.find(e => e.type === 'trackName')?.text ?? '') || 'MIDI ' + (index+1);
    const lyrics:{sample:number;text:string}[]=[];
    const programs = new Map<number,number>();
    const controls = new Map<number,MidiControl[]>();
    const groups = new Map<string,ImportedPart>();
    const open = new Map<number, {start: number; velocity: number; part: ImportedPart}[]>();
    let tick = 0;
    for (const e of track) {
      tick += e.deltaTime;
      if (e.type==='lyrics' && e.text.trim()) lyrics.push({sample:sample(tick),text:midiText(e.text)});
      if (e.type==='controller' || e.type==='pitchBend' || e.type==='channelAftertouch' || e.type==='noteAftertouch') {
        const channelEvents=controls.get(e.channel) ?? [];
        channelEvents.push({sample:sample(tick),event:e});
        controls.set(e.channel,channelEvents);
        if(e.type==='channelAftertouch' || e.type==='noteAftertouch') playbackLimits.add('触后');
      }
      if (e.type==='pitchBend') playbackLimits.add('弯音');
      if (e.type==='controller') playbackLimits.add(e.controllerType===64 ? '延音踏板' : '控制器');
      if (e.type === 'programChange') programs.set(e.channel,e.programNumber);
      if (e.type !== 'noteOn' && e.type !== 'noteOff') continue;
      const key = e.channel*128 + e.noteNumber;
      const queue = open.get(key) ?? [];
      if (e.type === 'noteOn' && e.velocity) {
        const program = programs.get(e.channel) ?? 0;
        const group = e.channel + '/' + program;
        let part = groups.get(group);
        if (!part) {
          const instrument = (Object.keys(instrumentPrograms) as Instrument[]).find(voice=>instrumentPrograms[voice]===program) ?? 'piano';
          part = { name, notes: [], instrument, program, channel: e.channel+1 };
          groups.set(group,part);
        }
        queue.push({start: sample(tick), velocity: e.velocity, part});
        open.set(key,queue);
      } else {
        const held = queue.shift();
        if (!held) throw new Error(name+' 有未配对的音符结束事件');
        const end = sample(tick);
        if (end > held.start) held.part.notes.push({id:crypto.randomUUID(), midi:e.noteNumber,
          startSmp:held.start, endSmp:end, velocity:held.velocity});
      }
    }
    if ([...open.values()].some(q=>q.length)) throw new Error(name+' 有未结束的音符');
    if (lyrics.length) lyricTracks.push({track:index,lyrics});
    for (const part of groups.values()) {
      part.controls=controls.get(part.channel-1);
      if (lyrics.length) part.lyrics=lyrics;
      part.notes.sort((a,b)=>a.startSmp-b.startSmp || a.midi-b.midi);
      if (part.notes.some(n=>n.endSmp > 900*SAMPLE_RATE_HZ)) throw new Error('请将乐谱拆为 15 分钟以内的片段');
      if (part.notes.length) parts.push(part);
    }
  }
  if (!parts.length) throw new Error('MIDI 文件没有可导入的音符');
  const beatMap = tempos.map(t => ({beat:t.tick/ppq, sample:t.sample, samplesPerBeat:t.us*SAMPLE_RATE_HZ/1e6}));
  return {parts,beatMap,lyricTracks,sharedChannels:new Set(parts.map(p=>p.channel)).size<parts.length,playbackLimits:[...playbackLimits],meters:[...meters.values()].sort((a,b)=>a.beat-b.beat),bpm:60e6/tempos[0].us};
}

export interface NoteSpan { midi: number; startSmp: number; endSmp: number }

export function conflictsWithNote(notes: readonly EventNote[], candidate: NoteSpan, skipId?: string, vocal = false) {
  return notes.some(n => n.id !== skipId && (n.midi === candidate.midi || (vocal && n.lyricId))
    && candidate.startSmp < n.endSmp && n.startSmp < candidate.endSmp);
}

export interface ScoreMidiTrack {
  controls?: readonly MidiControl[];
  name: string;
  channel?: number;
  program: number;
  notes: readonly (NoteSpan & {velocity:number})[];
  lyrics?: readonly {sample:number;text:string}[];
}

const PPQ = 960;
type TimedEvent = {tick:number; event:MidiEvent};
function deltaEvents(entries: TimedEvent[]): MidiEvent[] {
  let previous = 0;
  const result = entries.sort((a,b) => a.tick-b.tick || Number(b.event.type==='noteOff')-Number(a.event.type==='noteOff')).map(({tick,event})=>{
    const deltaTime = tick-previous;
    previous = tick;
    return {...event,deltaTime};
  });
  return [...result,{deltaTime:0,type:'endOfTrack'}];
}

function midiString(text: string) {
  return Array.from(new TextEncoder().encode(text), byte=>String.fromCharCode(byte)).join('');
}

export function exportMidiScore(parts: readonly ScoreMidiTrack[], beatMap: readonly BeatChange[], meters: readonly MeterChange[]) {
  if (!parts.length) throw new Error('没有可导出的音符');
  const tickAt = (sample:number) => Math.max(0,Math.round(gridBeat(sample,beatMap)*PPQ));
  const conductor: TimedEvent[] = beatMap.map(t=>({tick:Math.round(t.beat*PPQ),event:{
    deltaTime:0,type:'setTempo',microsecondsPerBeat:Math.round(t.samplesPerBeat*1e6/SAMPLE_RATE_HZ),
  }}));
  if(conductor.some(e=>e.event.type==='setTempo' && (e.event.microsecondsPerBeat<1 || e.event.microsecondsPerBeat>0xffffff))) throw new Error('速度超出标准 MIDI 范围');
  for (const meter of meters) conductor.push({tick:Math.round(meter.beat*PPQ),event:{
    deltaTime:0,type:'timeSignature',numerator:meter.numerator,denominator:meter.denominator,metronome:24,thirtyseconds:8,
  }});
  const tracks=[deltaEvents(conductor)];
  const used=new Set<number>();
  const melodicChannels=Array.from({length:16},(_,i)=>i+1).filter(i=>i!==10);
  for (const part of parts) {
    const channel=part.channel===10 ? 10 : [part.channel,...melodicChannels].find(c=>c && c!==10 && !used.has(c));
    if (!channel || used.has(channel)) throw new Error('当前单端口 MIDI 最多支持 15 个独立旋律声部和 1 个鼓声部，请分批启用声部导出');
    used.add(channel);
    const ch=channel-1;
    const timeline:TimedEvent[]=[
      {tick:0,event:{deltaTime:0,type:'trackName',text:midiString(part.name)}},
      {tick:0,event:{deltaTime:0,type:'programChange',channel:ch,programNumber:part.program}},
    ];
    for(const control of part.controls ?? []) timeline.push({tick:tickAt(control.sample),event:{...control.event,channel:ch,deltaTime:0}});
    for(const lyric of part.lyrics ?? []) timeline.push({tick:tickAt(lyric.sample),event:{deltaTime:0,type:'lyrics',text:midiString(lyric.text)}});
    const previousEnd=new Map<number,number>();
    for (const n of [...part.notes].sort((a,b)=>a.startSmp-b.startSmp)) {
      const start=tickAt(n.startSmp), end=Math.max(start+1,tickAt(n.endSmp));
      if(previousEnd.has(n.midi) && previousEnd.get(n.midi)!>start) throw new Error(part.name+' 的同音音符重叠，请错开后导出');
      previousEnd.set(n.midi,end);
      timeline.push({tick:start,event:{deltaTime:0,type:'noteOn',channel:ch,noteNumber:n.midi,velocity:n.velocity}},
        {tick:end,event:{deltaTime:0,type:'noteOff',channel:ch,noteNumber:n.midi,velocity:0}});
    }
    tracks.push(deltaEvents(timeline));
  }
  return new Uint8Array(writeMidi({header:{format:1,numTracks:tracks.length,ticksPerBeat:PPQ},tracks}));
}

/** Match timed syllables when possible, otherwise require exactly one note per syllable. */
export function fitMelody(rows: readonly {id:string;char:string}[], melody: readonly EventNote[],
  lyrics: readonly {sample:number;text:string}[] = []): EventNote[] {
  const notes=[...melody].sort((a,b)=>a.startSmp-b.startSmp);
  if (!rows.length || !notes.length) throw new Error('请先解析歌词并选择有音符的旋律轨');
  if (notes.some((n,i)=>i>0 && n.startSmp<notes[i-1].endSmp)) throw new Error('参考轨有同时发声的音，请选择单音旋律轨');
  const anchors=lyrics.filter(l=>l.text.trim()!=='-');
  const starts=new Set(notes.map(n=>n.startSmp));
  const timed=anchors.length===rows.length && anchors.every((l,i)=>
    (i===0 || l.sample>anchors[i-1].sample) && starts.has(l.sample)) && anchors[0].sample===notes[0].startSmp;
  if (!timed && rows.length!==notes.length) throw new Error('歌词有 '+rows.length+' 个音节，旋律有 '+notes.length+' 个音。可按逐字手势指定一字多音');
  let index=0;
  return notes.map((note,i)=>{
    if(timed && index+1<anchors.length && note.startSmp>=anchors[index+1].sample) index++;
    return {...note,id:crypto.randomUUID(),lyricId:rows[timed ? index : i].id};
  });
}
