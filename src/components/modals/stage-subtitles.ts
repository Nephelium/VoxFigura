import { SAMPLE_RATE_HZ, type SubtitleRow, type VcProject } from '@vocalcut/core';
import { readTimeline, stageLayer, type NleClip } from '@/components/studio/nle-timeline';
import { stagePhraseId } from '@/components/studio/stage-tract-renderer';

function formatIpaBracket(ipa: readonly string[]): string {
  const joined = ipa.join('').trim();
  return joined ? '[' + joined + ']' : '';
}

function collectClipWordIntervals(
  project: VcProject,
  allClips: readonly NleClip[],
  clip: NleClip,
  fallbackClipId: string,
) {
  const phraseKey = stagePhraseId(clip, allClips, fallbackClipId);
  const phrase = phraseKey ? project.clips[phraseKey] : undefined;
  if (!phrase) return [];
  const offset = clip.startSmp - clip.sourceStartSmp;
  return phrase.syllable_order.flatMap(id => {
    const word = phrase.syllables[id];
    if (!word) return [];
    const start = Math.max(clip.startSmp, word.start_smp + offset);
    const end = Math.min(clip.endSmp, word.end_smp + offset);
    return start < end ? [{ start, end, clip, text: word.text, ipa: formatIpaBracket(word.ipa) }] : [];
  });
}

export function stageSubtitleRows(project: VcProject, clipId: string): SubtitleRow[] {
  if (!stageLayer(project, 'v3')?.visible) return [];

  const allClips = readTimeline(project, clipId);
  const clips = allClips.filter(clip => clip.track === 'v3').reverse();
  if (!clips.length) return [];

  const intervals = clips.flatMap(clip => collectClipWordIntervals(project, allClips, clip, clipId));
  if (!intervals.length) return [];

  const edges = [...new Set([
    ...clips.flatMap(clip => [clip.startSmp, clip.endSmp]),
    ...intervals.flatMap(word => [word.start, word.end]),
  ])].sort((a, b) => a - b);

  const isDuet = clips.some(clip => clip.duetVoice !== undefined);
  const rows: SubtitleRow[] = [];

  for (let i = 0; i < edges.length - 1; i++) {
    const start = edges[i];
    const end = edges[i + 1];
    if (start >= end) continue;

    let activeClips: NleClip[];
    if (isDuet) {
      const slotMap = new Map<string, NleClip>();
      for (const clip of clips) {
        if (!(clip.startSmp <= start && start < clip.endSmp)) continue;
        const slot = clip.duetVoice !== undefined
          ? `duet:${clip.duetVoice}`
          : `lane:${clip.visualLane ?? 0}:${clip.id}`;
        if (!slotMap.has(slot)) slotMap.set(slot, clip);
      }
      activeClips = [...slotMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, clip]) => clip);
    } else {
      // Group by visualLane so parallel V3 lanes export concurrently; within the same lane latest wins.
      const laneMap = new Map<number, NleClip>();
      for (const clip of clips) {
        if (!(clip.startSmp <= start && start < clip.endSmp)) continue;
        const lane = clip.visualLane ?? 0;
        if (!laneMap.has(lane)) laneMap.set(lane, clip);
      }
      activeClips = [...laneMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, clip]) => clip);
    }

    const current = activeClips.flatMap(clip => {
      const hit = intervals.find(word => word.clip === clip && word.start <= start && start < word.end);
      return hit ? [hit] : [];
    });
    if (!current.length) continue;

    const text = [...new Set(current.map(word => word.text))].join(' / ');
    const ipaParts = [...new Set(current.map(word => word.ipa).filter(Boolean))];
    const ipa = ipaParts.join(' / ');
    const start_s = start / SAMPLE_RATE_HZ;
    const end_s = end / SAMPLE_RATE_HZ;
    const last = rows[rows.length - 1];
    if (last && last.end_s === start_s && last.text === text && last.ipa === ipa) {
      last.end_s = end_s;
    } else {
      rows.push({ start_s, end_s, text, ipa });
    }
  }

  // Avoid zero-length cues when writing a timecode format whose finest resolution is 1 ms.
  return rows.filter(row => Math.round(row.end_s * 1000) > Math.round(row.start_s * 1000));
}
