import type { Syllable } from '@vocalcut/core';
import { isStageVocalTrack, type NleClip } from './nle-timeline';
import { companionOf, companionPeersOf } from './stage-voice-clips';

export function sameTimelineLane(a: NleClip, b: NleClip): boolean {
  if (a.track !== b.track || (a.visualLane ?? 0) !== (b.visualLane ?? 0)) return false;
  // Legacy duet projects display their two performances in separate rows of V1 and V3.
  return (a.track !== 'v1' && a.track !== 'v3') || a.duetVoice === undefined ||
    b.duetVoice === undefined || a.duetVoice === b.duetVoice;
}

export function overlapsTimeline(a: NleClip, b: NleClip): boolean {
  return sameTimelineLane(a, b) && a.startSmp < b.endSmp && b.startSmp < a.endSmp;
}

function overlapLength(a: NleClip, b: NleClip): number {
  return sameTimelineLane(a, b) ? Math.max(0, Math.min(a.endSmp, b.endSmp) - Math.max(a.startSmp, b.startSmp)) : 0;
}

export function placementCollision(before: readonly NleClip[], after: readonly NleClip[]): NleClip | undefined {
  const originals = new Map(before.map(clip => [clip.id, clip]));
  const changed = after.filter(clip => {
    const old = originals.get(clip.id);
    return !old || !sameTimelineLane(clip, old) || old.startSmp !== clip.startSmp || old.endSmp !== clip.endSmp;
  });
  for (const clip of changed) {
    const old = originals.get(clip.id);
    for (const other of after) {
      if (other.id === clip.id || !overlapsTimeline(clip, other)) continue;
      const oldOther = originals.get(other.id);
      if (!old || !oldOther || overlapLength(clip, other) > overlapLength(old, oldOther)) return other;
    }
  }
}

export function timelineGap(clip: NleClip, otherClips: readonly NleClip[]): { start: number; end: number } {
  let start = 0, end = Infinity;
  for (const other of otherClips) {
    if (other.id === clip.id || !sameTimelineLane(clip, other)) continue;
    if (other.endSmp <= clip.startSmp) start = Math.max(start, other.endSmp);
    else if (other.startSmp >= clip.endSmp) end = Math.min(end, other.startSmp);
    else if (other.startSmp < clip.startSmp) start = Math.max(start, clip.startSmp);
    else if (other.startSmp > clip.startSmp) end = Math.min(end, clip.endSmp);
    // An exact-start legacy overlap can be moved out in either direction.
  }
  return { start, end };
}

export function textSplitSamples(clip: NleClip, syllables: readonly Syllable[]) {
  const sourceEnd = clip.sourceStartSmp + clip.endSmp - clip.startSmp;
  const boundaries = new Set<number>();
  for (const syllable of syllables) {
    if (!syllable.text.trim()) continue;
    for (const sample of [syllable.start_smp, syllable.end_smp]) {
      if (sample > clip.sourceStartSmp && sample < sourceEnd) {
        boundaries.add(clip.startSmp + sample - clip.sourceStartSmp);
      }
    }
  }
  return [...boundaries].sort((a, b) => a - b);
}

export function splitTimelineClips(
  clips: readonly NleClip[], selected: NleClip, cuts: readonly number[],
  linked: boolean, syllables?: readonly Syllable[],
) {
  const peers = linked ? companionPeersOf(selected, clips) : [];
  const targets = [selected, ...peers];
  const root = targets.find(clip => isStageVocalTrack(clip.track));
  const pieces = new Map<string, NleClip[]>();
  const names = syllables?.filter(syllable => syllable.text.trim());
  for (const clip of targets) {
    const starts = [clip.startSmp, ...cuts.filter(cut => clip.startSmp < cut && cut < clip.endSmp), clip.endSmp];
    if (starts.length === 2) continue;
    pieces.set(clip.id, starts.slice(0, -1).map((startSmp, index) => {
      const endSmp = starts[index + 1];
      const sourceStartSmp = clip.sourceStartSmp + startSmp - clip.startSmp;
      const matches = names?.find(syllable => syllable.start_smp < sourceStartSmp + endSmp - startSmp &&
        sourceStartSmp < syllable.end_smp);
      const suffixMatch = clip.label.match(/\s*\((\d+)\)$/);
      const baseLabel = suffixMatch ? clip.label.slice(0, suffixMatch.index) : clip.label;
      const startIndex = suffixMatch ? Number(suffixMatch[1]) : 1;
      const label = names ? matches?.text ?? '间隔' : index ? `${baseLabel} (${startIndex + index})` : clip.label;
      return { ...clip, id: index ? crypto.randomUUID() : clip.id, startSmp, endSmp, sourceStartSmp, label };
    }));
  }
  const rootPieces = root && pieces.get(root.id);
  if (rootPieces) {
    for (const peer of peers.concat(selected)) {
      if (!companionOf(peer, root!)) continue;
      const parts = pieces.get(peer.id) ?? [{ ...peer }];
      for (const part of parts) {
        const audio = rootPieces.find(item => item.startSmp < part.endSmp && part.startSmp < item.endSmp);
        if (audio) part.linkedAudioId = audio.id;
      }
      pieces.set(peer.id, parts);
    }
  }
  return { clips: clips.flatMap(clip => pieces.get(clip.id) ?? clip), selected: pieces.get(selected.id) ?? [] };
}
