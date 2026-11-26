import { SAMPLE_RATE_HZ, type SubtitleRow, type VcProject } from '@vocalcut/core';
import { readTimeline, stageLayer } from '@/components/studio/nle-timeline';

export function stageSubtitleRows(project: VcProject, clipId: string): SubtitleRow[] {

  if (!stageLayer(project, 'v3')?.visible) return [];

  // The monitor shows the last V3 clip at each sample, including overlaps.
  const clips = readTimeline(project, clipId).filter(clip => clip.track === 'v3').reverse();
  if (clips.some(clip=>clip.duetVoice !== undefined)) {
    const intervals = clips.flatMap(clip => {
      const phrase = project.clips[clip.phraseId ?? clipId];
      const offset = clip.startSmp-clip.sourceStartSmp;
      return phrase?.syllable_order.flatMap(id=>{
        const word = phrase.syllables[id];
        if (!word) return [];
        const start = Math.max(clip.startSmp,word.start_smp+offset), end = Math.min(clip.endSmp,word.end_smp+offset);
        return start < end ? [{ start,end,clip,text:word.text,ipa:'['+word.ipa.join('')+']' }] : [];
      }) ?? [];
    });
    const edges = [...new Set([
      ...clips.flatMap(clip=>[clip.startSmp,clip.endSmp]),
      ...intervals.flatMap(word=>[word.start,word.end]),
    ])].sort((a,b)=>a-b);
    const rows: SubtitleRow[] = [];
    for (const [i,start] of edges.entries()) {
      const end = edges[i+1];
      if (end === undefined) break;
      const current = [0,1].flatMap(voice=>{
        const clip=clips.find(item=>(item.duetVoice ?? 0)===voice && item.startSmp<=start && start<item.endSmp);
        return intervals.find(word=>word.clip===clip && word.start<=start && start<word.end) ?? [];
      });
      if (!current.length) continue;
      const text = [...new Set(current.map(word=>word.text))].join(' / ');
      const ipa = [...new Set(current.map(word=>word.ipa))].join(' / ');
      const start_s = start/SAMPLE_RATE_HZ, end_s = end/SAMPLE_RATE_HZ;
      const last = rows[rows.length-1];
      if (last?.end_s===start_s && last.text===text && last.ipa===ipa) last.end_s=end_s;
      else rows.push({ start_s,end_s,text,ipa });
    }
    // These source intervals can differ by a single sample. Avoid zero-length
    // cues when writing a timecode format whose finest resolution is 1 ms.
    return rows.filter(row=>Math.round(row.end_s*1000)>Math.round(row.start_s*1000));
  }
  const edges = [...new Set(clips.flatMap(clip => [clip.startSmp, clip.endSmp]))].sort((a, b) => a - b);
  const rows: SubtitleRow[] = [];
  for (let i = 1; i < edges.length; i++) {
    const left = edges[i - 1];
    const right = edges[i];
    const clip = clips.find(item => item.startSmp <= left && left < item.endSmp);
    if (!clip) continue;
    const phrase=project.clips[clip.phraseId??clipId];
    if(!phrase)continue;
    const shift = clip.startSmp - clip.sourceStartSmp;
    for (const id of phrase.syllable_order) {
      const syllable = phrase.syllables[id];
      if (!syllable) continue;
      const start = Math.max(left, syllable.start_smp + shift);
      const end = Math.min(right, syllable.end_smp + shift);
      if (start >= end) continue;
      rows.push({ start_s: start / SAMPLE_RATE_HZ, end_s: end / SAMPLE_RATE_HZ, text: syllable.text, ipa: '[' + syllable.ipa.join('') + ']' });
    }
  }
  return rows;
}
