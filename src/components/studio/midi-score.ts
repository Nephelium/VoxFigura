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
// General MIDI Level 1 programs, in wire order (display numbers start at 1).
export const gmProgramNames = [
  '三角钢琴 明亮钢琴 电声三角钢琴 酒吧钢琴 电钢琴1 电钢琴2 羽管键琴 击弦键琴',
  '钢片琴 钟琴 八音盒 颤音琴 马林巴 木琴 管钟 扬琴',
  '拉杆风琴 打击风琴 摇滚风琴 教堂管风琴 簧风琴 手风琴 口琴 探戈手风琴',
  '尼龙弦吉他 钢弦吉他 爵士电吉他 清音电吉他 闷音电吉他 过载吉他 失真吉他 吉他泛音',
  '原声贝司 指弹贝司 拨片贝司 无品贝司 击弦贝司1 击弦贝司2 合成贝司1 合成贝司2',
  '小提琴 中提琴 大提琴 低音提琴 弦乐震音 弦乐拨奏 竖琴 定音鼓',
  '弦乐合奏1 弦乐合奏2 合成弦乐1 合成弦乐2 合唱啊声 人声嘟声 合成人声 乐团齐奏',
  '小号 长号 大号 弱音小号 圆号 铜管组 合成铜管1 合成铜管2',
  '高音萨克斯 中音萨克斯 次中音萨克斯 上低音萨克斯 双簧管 英国管 巴松 单簧管',
  '短笛 长笛 竖笛 排箫 吹瓶 尺八 口哨 陶笛',
  '方波主奏 锯齿主奏 汽笛主奏 气声主奏 查朗主奏 人声主奏 五度主奏 贝司主奏',
  '新时代音垫 温暖音垫 复音合成音垫 合唱音垫 弓弦音垫 金属音垫 光环音垫 扫频音垫',
  '雨声 电影音效 水晶 大气 明亮 小妖 回声 星际',
  '西塔琴 班卓琴 三味线 日本筝 卡林巴 风笛 乡村提琴 唢呐',
  '叮当铃 阿戈戈鼓 钢鼓 木鱼 太鼓 中音鼓 合成鼓 反向镲',
  '吉他滑弦声 呼吸声 海浪 鸟鸣 电话铃 直升机 掌声 枪声',
].flatMap(family => family.split(' '));

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
  const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0) & 0xff);
  for (const encoding of ['utf-8', 'gb18030', 'shift-jis'] as const) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      // Try next common MIDI text encoding
    }
  }
  return raw;
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
  const warnings: string[] = [];
  const lyricTracks:{track:number;lyrics:{sample:number;text:string}[]}[]=[];
  for (const [index, track] of tracks.entries()) {
    const name = midiText(track.find(e => e.type === 'trackName')?.text ?? '') || 'MIDI ' + (index+1);
    const lyrics:{sample:number;text:string}[]=[];
    const programs = new Map<number,number>();
    const controls = new Map<number,MidiControl[]>();
    const groups = new Map<string,ImportedPart>();
    const open = new Map<number, {start: number; velocity: number; part: ImportedPart}[]>();
    let unpairedNoteOffCount = 0;
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
        if (!held) {
          unpairedNoteOffCount++;
          continue;
        }
        const end = sample(tick);
        if (end > held.start) held.part.notes.push({id:crypto.randomUUID(), midi:e.noteNumber,
          startSmp:held.start, endSmp:end, velocity:held.velocity});
      }
    }
    if (unpairedNoteOffCount > 0) {
      warnings.push(`${name} 忽略了 ${unpairedNoteOffCount} 条未配对的音符结束事件`);
    }
    let unclosedNoteOnCount = 0;
    const trackEndSmp = sample(tick + Math.max(1, Math.round(ppq / 4)));
    for (const [key, queue] of open.entries()) {
      const noteNumber = key % 128;
      while (queue.length) {
        const held = queue.shift()!;
        unclosedNoteOnCount++;
        const end = Math.max(held.start + Math.round(SAMPLE_RATE_HZ * 0.12), trackEndSmp);
        held.part.notes.push({
          id: crypto.randomUUID(),
          midi: noteNumber,
          startSmp: held.start,
          endSmp: end,
          velocity: held.velocity,
        });
      }
    }
    if (unclosedNoteOnCount > 0) {
      warnings.push(`${name} 自动补齐了 ${unclosedNoteOnCount} 个未闭合音符的结束时刻`);
    }
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
  return {parts,beatMap,lyricTracks,sharedChannels:new Set(parts.map(p=>p.channel)).size<parts.length,playbackLimits:[...playbackLimits],warnings,meters:[...meters.values()].sort((a,b)=>a.beat-b.beat),bpm:60e6/tempos[0].us};
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
    if (!channel || used.has(channel)) throw new Error('当前单端口 MIDI 最多支持 15 条独立旋律轨和 1 条鼓轨，请分批启用轨道导出');
    used.add(channel);
    const ch=channel-1;
    const timeline:TimedEvent[]=[
      {tick:0,event:{deltaTime:0,type:'trackName',text:midiString(part.name)}},
      {tick:0,event:{deltaTime:0,type:'programChange',channel:ch,programNumber:part.program}},
    ];
    for(const control of part.controls ?? []) timeline.push({tick:tickAt(control.sample),event:{...control.event,channel:ch,deltaTime:0}});
    for(const lyric of part.lyrics ?? []) timeline.push({tick:tickAt(lyric.sample),event:{deltaTime:0,type:'lyrics',text:midiString(lyric.text)}});
    const previous = new Map<number, { endTick: number; endSmp: number; offEntry: TimedEvent }>();
    for (const n of [...part.notes].sort((a, b) => a.startSmp - b.startSmp)) {
      let start = tickAt(n.startSmp);
      const prev = previous.get(n.midi);
      if (prev) {
        if (prev.endSmp > n.startSmp) {
          throw new Error(part.name + ' 的同音音符重叠，请错开后导出');
        }
        if (prev.endTick > start) {
          // Adjacent in 48 kHz samples but collided by 1 tick after quantization: clamp previous noteOff cleanly
          if (prev.offEntry.tick > start && start > 0) {
            prev.offEntry.tick = start;
            prev.endTick = start;
          } else {
            start = prev.endTick;
          }
        }
      }
      const end = Math.max(start + 1, tickAt(n.endSmp));
      const offEntry: TimedEvent = { tick: end, event: { deltaTime: 0, type: 'noteOff', channel: ch, noteNumber: n.midi, velocity: 0 } };
      previous.set(n.midi, { endTick: end, endSmp: n.endSmp, offEntry });
      timeline.push(
        { tick: start, event: { deltaTime: 0, type: 'noteOn', channel: ch, noteNumber: n.midi, velocity: n.velocity } },
        offEntry,
      );
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
