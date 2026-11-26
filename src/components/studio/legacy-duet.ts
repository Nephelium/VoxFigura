import { parseNumberedScore, SAMPLE_RATE_HZ, type Clip, type SegmentAnchor, type Syllable, type VcProject } from '@vocalcut/core';
import { createInitialProject } from '@/stores/workbench';
import { resolveKanaPhones } from '@/components/research/japanese-annotation';
import { buildSegmentsForSyllable, splitIpaToPhonemes } from '@/components/research/research-utils';
import { stageLayer, timelineKeys, type NleClip, type StageTargetId } from './nle-timeline';
import { sessionMedia, type SessionMedia } from './studio-media';

export type DuetPoint = [number, number];
export type DuetContour = Record<string, DuetPoint[]>;
export interface DuetGeometry { time: number; contours: DuetContour }
export interface DuetKey { sample: number; x: number; y: number; zoom: number; angle?: number; flip?: boolean; layout?: string }
export interface DuetLayer {
  id: string; name: string; atlas: string; visible: boolean; columns: number; rows: number;
  width: number; height: number; keys: DuetKey[]; cues: { sample: number; cell: number; reveal?: number }[];
}
type Phone = { text: string; start: number; end: number };
type Word = Phone & { ipa?: string; phones?: Phone[]; pitch?: { base?: { hz?: number }; points?: { sample: number; hz: number }[] } };
type SourceFrame = { name: string; duration: number; params: number[]; f0?: number; lip_width?: number; larynx_height?: number;
  tongue_shape?: number[]; lip_shape?: number[]; source?: { pressure_pa?: number; mode?: string };
  stop_timing?: { closure: number; release: number; aspiration: number; vot: number } };
interface Motion {
  speaker: string; geometry: DuetGeometry[]; subtitles: Word[];
  source?: { frames: SourceFrame[]; pitch_curve?: [number, number][] } | null;
  dense?: { stepSeconds: number; frames: { params?: number[] | null }[]; score?: { words: Word[]; sourceLength: number } };
}
interface LegacyAsset { id: string; name: string; length: number; sampleRate: number; channelCount: number; words: Word[]; motion?: Motion }
interface LegacyClip { id: string; assetId: string; start: number; offset: number; length: number }
interface DuetTrack { id: string; name: string; kind: 'voice' | 'music'; gain?: number; muted?: boolean; clips: LegacyClip[] }
interface DuetAppearance { sample: number; theme: string; background: string }
interface DuetStage {
  backgroundImage?: string; background?: string; theme?: string; pulse?: number;
  layout?: string; keyframes?: Record<string, DuetKey[]>; cameraKeys?: DuetKey[];
  appearanceKeys?: DuetAppearance[]; layers?: DuetLayer[]; exportFps?: number;
}
interface LegacyManifest { assets: LegacyAsset[]; project: { version: number; sampleRate: number; tracks: DuetTrack[]; stage?: DuetStage } }
interface TimeMap { srcStart: number; srcEnd: number; dstStart: number; dstEnd: number }
export interface DuetMotion { geometry: DuetGeometry[]; timeMap: TimeMap[] }
export interface DuetScene {
  stage: DuetStage;
  voices: string[];
  motion: Map<string, DuetMotion>;
  name: string;
}
export const duetScenes = new Map<string, DuetScene>();

const MAX_BYTES = 512 * 1024 ** 2;
const MAX_MANIFEST = 128 * 1024 ** 2;
const ascii = (view: DataView) => String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset, 8));
const smp = (seconds: number) => Math.round(seconds * SAMPLE_RATE_HZ);
function assert(valid: unknown, message: string): asserts valid {
  if (!valid) throw new Error(message);
}
function integer(value: number, min: number, max: number) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function picture(value?: string) {
  return typeof value === 'string' && /^data:image\/(?:png|jpe?g|webp);base64,/i.test(value);
}
function validateStage(stage: DuetStage) {
  const color = (value?: string) => !value || /^#[0-9a-f]{6}$/i.test(value);
  const ordered = (keys?: { sample: number }[]) => !keys || Array.isArray(keys) && keys.every((key, i) =>
    integer(key?.sample, 0, Number.MAX_SAFE_INTEGER) && (!i || key.sample > keys[i - 1].sample));
  const poses = (keys?: DuetKey[]) => ordered(keys) && (!keys || keys.every(key =>
    [key.x,key.y,key.zoom,key.angle ?? 0].every(Number.isFinite) && key.zoom > 0 && key.zoom <= 16));
  assert(!stage.backgroundImage || picture(stage.backgroundImage), 'Stella 背景图格式无效');
  assert(poses(stage.cameraKeys) && ordered(stage.appearanceKeys) && Object.values(stage.keyframes ?? {}).every(poses), 'Stella 镜头关键帧无效');
  assert(color(stage.background) && color(stage.theme) && (stage.appearanceKeys ?? []).every(key => color(key.background) && color(key.theme)), 'Stella 背景颜色无效');
  assert(!stage.layers || Array.isArray(stage.layers) && stage.layers.length <= 64, 'Stella 图像图层无效');
  for (const layer of stage.layers ?? []) {
    assert(typeof layer.id === 'string' && typeof layer.name === 'string' && picture(layer.atlas) &&
      integer(layer.columns,1,2048) && integer(layer.rows,1,2048) &&
      integer(layer.width,1,8192) && integer(layer.height,1,8192) &&
      poses(layer.keys) && ordered(layer.cues) &&
      layer.cues.every(cue => integer(cue.cell,-1,layer.rows*layer.columns-1) &&
        (cue.reveal === undefined || Number.isFinite(cue.reveal) && cue.reveal >= 0 && cue.reveal <= 1)), 'Stella 图像图集或关键帧无效');
  }
}

function sourcePhones(frames: readonly SourceFrame[]) {
  let time = 0;
  return frames.map(frame => {
    const start = smp(time);
    time += frame.duration;
    return { ...frame, text: frame.name, start, end: smp(time) };
  }).filter(frame => frame.text && Number.isFinite(frame.end) && frame.end > frame.start);
}
function wordsFrom(asset: LegacyAsset): Word[] {
  const subs = asset.motion?.subtitles?.filter(word => word.text?.trim());
  if (subs?.length) return subs.map(word => ({ ...word, start: smp(word.start), end: smp(word.end) }));
  return (asset.words ?? []).filter(word => word.text?.trim());
}
function mapTimes(words: readonly Word[], dense?: Motion['dense']): TimeMap[] {
  const original = dense?.score?.words?.filter(word => word.text?.trim());
  if (original?.length !== words.length || words.some((word, i) => word.text !== original[i].text)) return [];
  return words.map((word,i) => ({ srcStart: original[i].start, srcEnd: original[i].end, dstStart: word.start, dstEnd: word.end }));
}
function alignedSyllables(asset: LegacyAsset, words: Word[], timing: TimeMap[], prefix: string) {
  const original = asset.motion?.dense?.score?.words?.filter(word => word.text?.trim()) ?? [];
  const source = sourcePhones(asset.motion?.source?.frames ?? []);
  const syllables: Syllable[] = [];
  for (const [index, word] of words.entries()) {
    const id = prefix + '_' + index;
    const start_smp = word.start, end_smp = Math.min(asset.length, word.end);
    if (!integer(start_smp,0,asset.length-1) || !integer(end_smp,start_smp+1,asset.length)) continue;
    const originalWord = timing[index];
    const mapped = originalWord && original[index]?.phones?.map(phone => {
      const point = (t: number) => Math.round(start_smp + (t-originalWord.srcStart) *
        (end_smp-start_smp) / Math.max(1,originalWord.srcEnd-originalWord.srcStart));
      return { ...phone, start: point(phone.start), end: point(phone.end) };
    });
    const rawPhones: (Phone & Partial<SourceFrame>)[] = mapped?.length ? mapped : source.filter(phone => phone.start < end_smp && start_smp < phone.end);
    const phones = rawPhones.flatMap(phone => {
      const start = Math.max(start_smp,phone.start), end = Math.min(end_smp,phone.end);
      return end > start && phone.text.length ? [{ ...phone, start, end }] : [];
    });
    const importedIpa = splitIpaToPhonemes(word.ipa ?? '');
    const ipa = phones.length ? phones.map(phone => phone.text) : word.ipa ? importedIpa : [];
    const baseline = ipa.length ? buildSegmentsForSyllable(id,ipa,start_smp,end_smp,asset.motion?.speaker || 'JD2') : [];
    const nucleus = Math.max(0,baseline.findIndex(segment=>segment.role==='nucleus'));
    const segments: SegmentAnchor[] = phones.length ? phones.map((phone,i) => {
      const sourceFrame = phone.params?.length === 19 && phone.params.every(Number.isFinite);
      const stop = phone.stop_timing;
      const stop_timing = stop && (stop.closure+stop.release+stop.aspiration)*SAMPLE_RATE_HZ <= (phone.end-phone.start)+1
        ? { closure_ms: stop.closure*1000, release_ms: stop.release*1000, aspiration_ms: stop.aspiration*1000, vot_ms: stop.vot*1000 }
        : undefined;
      return { ...baseline[i], start_smp: phone.start, end_smp: phone.end,
        ...(sourceFrame ? { params: phone.params, lip_width: phone.lip_width,
          larynx_height_cm: phone.larynx_height, tongue_shape: phone.tongue_shape, lip_shape: phone.lip_shape } : {}),
        ...(stop_timing ? { stop_timing } : {}) };
    }) : baseline;
    syllables.push({ id, text: word.text, ipa: word.ipa ? importedIpa : ipa, nucleus_index: nucleus,
      start_smp, end_smp, segments, targets: [],
      anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
      overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] } });
  }
  return syllables;
}

function numberedTone(midi: number|null) {
  const degrees = ['1','#1','2','#2','3','4','#4','5','#5','6','#6','7'];
  if (midi === null || !Number.isFinite(midi)) return '0';
  const relative = midi-50;
  const octaves = Math.floor(relative/12);
  return degrees[(relative%12+12)%12] + (octaves>=0 ? '+'.repeat(Math.min(octaves,5)) : '-'.repeat(Math.min(-octaves,5)));
}
function scoreFor(asset: LegacyAsset, syllables: Syllable[]) {
  const pitch = asset.motion?.source?.pitch_curve ?? [];
  const dense = asset.motion?.dense?.score?.words?.filter(word => word.text?.trim()) ?? [];
  const notation = (hz: number, duration: number) => {
    return numberedTone(hz > 0 ? Math.round(69 + 12*Math.log2(hz/440)) : null) + ':' + (duration*148/(60*SAMPLE_RATE_HZ)).toFixed(7);
  };
  const result: string[] = [];
  let seek = 0, last = 0;
  for (const [i, syl] of syllables.entries()) {
    if (syl.start_smp > last) result.push(notation(0,syl.start_smp-last));
    const center = (syl.start_smp+syl.end_smp)/(2*SAMPLE_RATE_HZ);
    while (seek+1 < pitch.length && pitch[seek+1][0] <= center) seek++;
    const hz = dense[i]?.pitch?.base?.hz ?? pitch[seek]?.[1] ??
      dense[i]?.pitch?.points?.find(point => point.hz > 0)?.hz;
    if (!hz) return;
    result.push(notation(hz,syl.end_smp-syl.start_smp));
    last = syl.end_smp;
  }
  if (asset.length > last) result.push(notation(0,asset.length-last));
  return result.join(' | ');
}

export function applyDuetScorebook(project: VcProject, timeline: readonly NleClip[], text: string) {
  if (!project.id.startsWith('duet_') || !text.slice(0,800).includes('人是猫｜完整人声语法简谱与歌词')) return 0;
  const rows = text.replaceAll('\r','').split(/\n(?=\d{2}\s)/).slice(1);
  const scorebook = rows.flatMap(row => {
    const match = /^.+\n原视频定位\s+(\d+(?:\.\d+)?)[^\n]+\n歌词[：:]\s*\n([^\n]+)\n简谱[：:]\s*\n([^\n]+)/u.exec(row);
    if (!match) return [];
    // Spaces in the source syntax are timed rests.
    const origin = Number(match[1]);
    const score = match[3].trim().replace(/[ \u3000]/gu,'|0|');
    const units = match[2].trim().match(/.[ゃゅょぁぃぅぇぉ]?/gu) ?? [];
    const parsed = parseNumberedScore(score,'D3',148,false,units.length);
    if (!parsed.ok) return [];
    const starts: { note: number; time: number }[] = [];
    let time = origin;
    const { notes } = parsed.score;
    for (const [note, value] of notes.entries()) {
      if (!value.carry && value.midi !== null) starts.push({ note,time });
      time += value.beats*60/148;
    }
    return [{ units, score, notes, starts }];
  });
  let count = 0;
  for (const clip of Object.values(project.clips)) {
    if (!clip.source?.lyrics || !clip.syllable_order.length) continue;
    const syllables = clip.syllable_order.map(id=>clip.syllables[id]);
    const items = timeline.filter(item=>item.phraseId===clip.id && (item.track==='a1' || item.track==='a2'));
    const candidates = scorebook.flatMap(chapter => chapter.units.flatMap((_,start) => {
      if (start+syllables.length > chapter.units.length || !syllables.every((syllable,i)=>syllable.text===chapter.units[start+i])) return [];
      const distance = Math.min(...items.map(item=>Math.abs(chapter.starts[start].time-(item.startSmp+syllables[0].start_smp-item.sourceStartSmp)/SAMPLE_RATE_HZ)));
      return [{ chapter,start,distance }];
    }));
    const best = candidates.sort((a,b)=>a.distance-b.distance)[0];
    if (!best) continue;
    const { chapter,start } = best;
    const stop = start+syllables.length;
    let score = chapter.score;
    if (start || stop<chapter.units.length) {
      const notes = chapter.notes.slice(chapter.starts[start].note,chapter.starts[stop]?.note ?? chapter.notes.length);
      while (notes[notes.length-1]?.midi === null) notes.pop();
      const parts: string[] = [];
      let group: string[] = [];
      const closeGroup = () => { if (group.length) parts.push(group.length===1 ? group[0] : '('+group.join('|')+')'); group=[]; };
      for (const note of notes) {
        if (!note.carry) closeGroup();
        const dynamic = note.dynamic ?? 0;
        const token = numberedTone(note.midi)+':'+note.beats.toFixed(8)+(dynamic<0?'p':'f').repeat(Math.abs(dynamic));
        if (note.midi === null && !note.carry) parts.push(token);
        else group.push(token);
      }
      closeGroup();
      score = parts.join('|');
    }
    if (!parseNumberedScore(score,'D3',148,false,syllables.length).ok) continue;
    clip.source = { ...clip.source, score };
    count++;
  }
  return count;
}

export async function importLegacyDuet(file: File): Promise<{ project: VcProject; timeline: NleClip[] }> {
  assert(integer(file.size,12,MAX_BYTES), 'Stella 工程文件大小无效');
  const outer = new DataView(await file.slice(0,80).arrayBuffer());
  const isSealed = ascii(outer) === 'PTBCUT01';
  const offset = isSealed ? 80 : 0;
  const length = isSealed ? outer.getUint32(8,true) : file.size;
  assert(!isSealed || offset+length+outer.getUint32(12,true) === file.size, 'Stella 工程封装长度不符');
  const inner = new DataView(await file.slice(offset,offset+12).arrayBuffer());
  assert(inner.byteLength === 12 && ascii(inner) === 'PTBDUET1', '文件不是 PhoneticToolbox 双人剪辑工程');
  const manifestLength = inner.getUint32(8,true);
  assert(integer(manifestLength,2,Math.min(MAX_MANIFEST,length-12)), 'Stella 工程清单长度无效');
  const manifest: LegacyManifest = JSON.parse(await file.slice(offset+12,offset+12+manifestLength).text());
  const base = manifest.project;
  assert(base?.version === 1 && base.sampleRate === SAMPLE_RATE_HZ && Array.isArray(base.tracks) && Array.isArray(manifest.assets), '此版本的 Stella 工程暂不支持');
  const trackCount = base.tracks.length, voiceTracks = base.tracks.filter(track => track.kind === 'voice');
  assert(trackCount > 0 && trackCount <= 3 && voiceTracks.length > 0 && voiceTracks.length <= 2 && trackCount-voiceTracks.length <= 1, '工程需包含一或两个声部及可选伴奏');
  assert(base.tracks.every(track => typeof track.name === 'string' && typeof track.id === 'string' && Array.isArray(track.clips) &&
      ['voice','music'].includes(track.kind) && (track.gain === undefined || Number.isFinite(track.gain) && track.gain >= 0 && track.gain <= 8)), 'Stella 音轨或音量无效');
  const stage = base.stage ?? {};
  validateStage(stage);
  const media = new Map<string, SessionMedia>(), assetMap = new Map<string,LegacyAsset>();
  const project = createInitialProject();
  // Reopen a saved VocalCut edit and relink it to the same source file.
  const headerHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(file.name + ':' + file.size + ':' + file.lastModified)));
  project.id = 'duet_' + Array.from(headerHash.slice(0,12), byte => byte.toString(16).padStart(2,'0')).join('');
  project.name = file.name.replace(/\.ptb-duet$/i,'');
  project.assets = {}; project.asset_order = []; project.clips = {}; project.clip_order = [];
  project.phonation_anchor_order = []; project.phonation_anchors = {};
  project.vibrato = undefined; project.perturbation = undefined;
  project.settings.tempo_map = [{ tick: 0, bpm: 148 }];
  project.settings.fps = stage.exportFps === 30 ? 30 : 60;
  project.render = { ...project.render, container: 'mp4', video: 'h264', audio: 'aac' };
  project.voices = Object.fromEntries(voiceTracks.map((track,i) => {
    const voice = project.voices.voice_lead;
    return [track.id,{ ...voice, id: track.id, speaker: i === 0 ? 'JD2' : 'W02', f0_ref_hz: i === 0 ? 220 : 440 }];
  }));
  project.voice_order = voiceTracks.map(track => track.id);
  project.tracks.trk_tg.voice_id = project.voice_order[0];
  for (const track of Object.values(project.tracks)) if (track.voice_id) track.voice_id = project.voice_order[0];
  if (stageLayer(project,'v3')?.style) Object.assign(stageLayer(project,'v3')!.style!, { font_size_px: 54, tilt_deg: -7, highlight_color: '#a8f6ff' });
  const cache: DuetScene = { stage, voices: project.voice_order, motion: new Map(), name: file.name };
  let cursor = offset+12+manifestLength;
  const end = offset+length;
  for (const spec of manifest.assets) {
    assert(typeof spec.id === 'string' && typeof spec.name === 'string' && !assetMap.has(spec.id) &&
      spec.sampleRate === SAMPLE_RATE_HZ && integer(spec.channelCount,1,2) &&
      integer(spec.length,1,Math.floor((end-cursor)/(spec.channelCount*4))), 'Stella 音频清单无效');
    const id = project.id + '_' + spec.id;
    const audio = new AudioBuffer({ sampleRate: SAMPLE_RATE_HZ, length: spec.length, numberOfChannels: spec.channelCount });
    for (let channel = 0; channel < spec.channelCount; channel++) {
      const data = new Float32Array(await file.slice(cursor,cursor+spec.length*4).arrayBuffer());
      assert(data.length === spec.length && data.every(Number.isFinite), 'Stella 音频采样无效');
      audio.copyToChannel(data,channel);
      cursor += spec.length*4;
    }
    assetMap.set(spec.id,spec);
    media.set(id,{ audio, url: '' });
    project.assets[id] = { id, kind: 'audio', path: spec.name, duration_smp: spec.length, sha256: id, role: 'ptb_duet_audio' };
    project.asset_order.push(id);
  }
  assert(cursor === end, 'Stella 工程音频长度不符');
  const timeline: NleClip[] = [];
  const linkedPhrases = new Map<string,string>();
  for (const track of base.tracks) for (const item of track.clips) {
    const asset = assetMap.get(item.assetId);
    assert(asset && typeof item.id === 'string' && integer(item.start,0,Number.MAX_SAFE_INTEGER-item.length) &&
      integer(item.offset,0,asset.length-1) && integer(item.length,1,asset.length-item.offset), 'Stella 剪辑区间无效');
    const duetVoice = voiceTracks.indexOf(track);
    const assetId = project.id + '_' + asset.id;
    const clip: Omit<NleClip,'track'> = { id: item.id, label: asset.name, assetId, startSmp: item.start, endSmp: item.start+item.length,
      sourceStartSmp: item.offset, sourceLength: asset.length, gain: track.gain ?? 1, muted: track.muted === true };
    const audioTrack: StageTargetId = duetVoice < 0 ? 'a3' : duetVoice === 0 ? 'a1' : 'a2';
    if (duetVoice < 0) { timeline.push({ ...clip, track: audioTrack }); continue; }
    clip.duetVoice = duetVoice;
    const key = track.id + '_' + asset.id;
    const previous = linkedPhrases.get(key);
    const phraseId = previous ?? 'duet_phrase_' + item.id;
    clip.phraseId = phraseId;
    if (!previous) {
      const words = wordsFrom(asset), timeMap = mapTimes(words,asset.motion?.dense);
      const syllables = alignedSyllables(asset,words,timeMap,phraseId);
      const phrase: Clip = { id: phraseId, kind: 'phrase', voice_id: track.id, asset_id: assetId,
        start_smp: 0, end_smp: asset.length, variants: ['original'], active_variant: 'original',
        syllable_order: syllables.map(syllable => syllable.id), syllables: Object.fromEntries(syllables.map(syllable => [syllable.id,syllable])),
        source: { lyrics: syllables.map(syllable=>syllable.text).join(''), score: scoreFor(asset,syllables), lang: 'mixed' } };
      project.clips[phraseId] = await resolveKanaPhones(phrase, asset.motion?.speaker ?? 'JD2');
      project.clip_order.push(phraseId);
      linkedPhrases.set(key,phraseId);
      if (asset.motion?.geometry?.length) cache.motion.set(assetId,{ geometry: asset.motion.geometry, timeMap });
    }
    timeline.push({ ...clip, track: audioTrack }, { ...clip, id: 'v1_' + item.id, track: 'v1' }, { ...clip, id: 'v3_' + item.id, track: 'v3' });
  }
  assert(project.clip_order.length > 0 && timeline.length > 0, 'Stella 工程没有可编辑声部');
  project.tracks.trk_tg.clip_order = project.clip_order;
  const endSmp = Math.max(...timeline.map(clip=>clip.endSmp));
  timeline.push({ id: 'duet_background', track: 'v0', label: 'Stella 背景', startSmp: 0, endSmp, sourceStartSmp: 0 });
  for (const layer of stage.layers ?? []) if (!['lyrics','syllable0','syllable1'].includes(layer.id)) {
    timeline.push({ id: 'duet_layer_' + layer.id, track: 'v2', label: layer.name, startSmp: 0, endSmp, sourceStartSmp: 0, duetLayer: layer.id });
  }
  stageLayer(project,'v0')!.keys = { nle_meta: timelineKeys(timeline) };
  for (const [id, value] of media) sessionMedia.set(id,value);
  duetScenes.set(project.id,cache);
  return { project,timeline };
}
