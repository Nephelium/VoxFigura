import { isKanaRun, japaneseReadingsFor, reviewKana } from '@vocalcut/g2p';
import type { Clip, SegmentAnchor, Syllable } from '@vocalcut/core';
import { buildSegmentsForSyllable, splitIpaToPhonemes } from './research-utils';

const hasKana = (s: string) => /[ぁ-ゖァ-ヶーｦ-ﾟ]/u.test(s);
export function needsKanaReading(syl: Syllable) {
  return isKanaRun(syl.text) && (!syl.segments.length || syl.segments.some(seg => hasKana(seg.ipa)) || syl.ipa.some(hasKana));
}

// Old duet files can carry kana in the phone tier and a hand-annotated IPA string in the subtitle tier.
export async function resolveKanaPhones(clip: Clip, speaker: string): Promise<Clip> {
  const rows = clip.syllable_order.map(id => clip.syllables[id]);
  if (!rows.some(needsKanaReading)) return clip;
  const syllables = { ...clip.syllables };
  for (let i = 0; i < rows.length;) {
    const start = i++;
    if (!isKanaRun(rows[start].text)) continue;
    while (i < rows.length && isKanaRun(rows[i].text) && rows[i].start_smp - rows[i-1].end_smp < 24000) i++;
    const group = rows.slice(start, i);
    if (!group.some(needsKanaReading)) continue;
    const text = group.map(row => row.text).join('');
    const at = new Map<number, string>();
    const missing = group.some(row => needsKanaReading(row) && (!row.ipa.length || row.ipa.some(hasKana))
      && (!row.segments.length || row.segments.some(seg => hasKana(seg.ipa))));
    if (missing) {
      const lexicon = await japaneseReadingsFor(text);
      let chars = 0;
      try {
        for (const reading of reviewKana(text, lexicon)) {
          at.set(chars, reading.ipa);
          chars += reading.word.normalize('NFKC').length;
        }
      } catch {
        // Isolated length and gemination marks can lack a neighbour in edited projects.
        // Keep those labels available for correction and resolve the other moras.
        for (const row of group) {
          try { at.set(chars, reviewKana(row.text, lexicon).map(r => r.ipa).join('')); }
          catch { /* This mora requires context that the clip does not contain. */ }
          chars += row.text.normalize('NFKC').length;
        }
      }
    }
    let offset = 0;
    for (const row of group) {
      const end = offset + row.text.normalize('NFKC').length;
      const ipa = row.ipa.length && row.ipa.every(s => !hasKana(s)) ? row.ipa :
        row.segments.length && row.segments.every(seg => !hasKana(seg.ipa)) ? row.segments.map(seg => seg.ipa) :
        Array.from({length:end-offset}, (_,k) => at.get(offset+k)).filter((v):v is string=>!!v).flatMap(splitIpaToPhonemes);
      offset = end;
      if (!needsKanaReading(row) || !ipa.length) continue;
      // Retain a fully aligned IPA tier. A kana placeholder supplies its mora boundary.
      const old = row.segments;
      let segments: SegmentAnchor[];
      if (old.length && old.every(seg => !hasKana(seg.ipa))) segments = old;
      else {
        const generated = buildSegmentsForSyllable(row.id, ipa, row.start_smp, row.end_smp, speaker);
        const matched = old.length === generated.length;
        segments = generated.map((seg,k) => {
          if (matched && !hasKana(old[k].ipa) && old[k].ipa === seg.ipa) return old[k];
          const time = (n:number) => row.start_smp + Math.round((row.end_smp-row.start_smp)*n/generated.length);
          const start_smp = matched ? old[k].start_smp : time(k);
          const end_smp = matched ? old[k].end_smp : time(k+1);
          return { ...seg, id: matched ? old[k].id : seg.id, start_smp, end_smp,
            stop_timing: seg.stop_timing && (seg.stop_timing.closure_ms + seg.stop_timing.release_ms) * 48 <= end_smp - start_smp ? seg.stop_timing : undefined };
        });
      }
      const poses = row.overrides.poses.flatMap(pose => {
        const prior = old.find(seg => seg.id === pose.seg_id) ?? old[pose.seg_index];
        if (!prior) return [];
        const index = segments.findIndex(seg => seg.start_smp <= prior.start_smp && prior.start_smp < seg.end_smp);
        return index < 0 ? [] : [{ ...pose, seg_index:index, seg_id:segments[index].id }];
      });
      syllables[row.id] = { ...row, ipa, segments, overrides:{ ...row.overrides, poses },
        nucleus_index: Math.max(0,segments.findIndex(seg => seg.role === 'nucleus')) };
    }
  }
  return { ...clip, syllables };
}
