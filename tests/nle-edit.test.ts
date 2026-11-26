import { describe, expect, it } from 'vitest';
import type { Syllable } from '@vocalcut/core';
import { createInitialProject } from '@/stores/workbench';
import { placementCollision, splitTimelineClips, textSplitSamples, timelineGap } from '@/components/studio/nle-edit';
import { readTimeline, stageLayer, timelineKeys, type NleClip } from '@/components/studio/nle-timeline';

function clip(id: string, track: NleClip['track'], startSmp: number, endSmp: number): NleClip {
  return { id, track, label: id, startSmp, endSmp, sourceStartSmp: 0 };
}

function syllable(text: string, start_smp: number, end_smp: number): Syllable {
  return {
    id: text, text, start_smp, end_smp, ipa: [], segments: [], nucleus_index: 0, targets: [],
    anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
    overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
  };
}

describe('timeline edits', () => {
  it('allows touching ends and simultaneous clips on different physical lanes', () => {
    const left = clip('left', 'v2', 0, 4800);
    const right = clip('right', 'v2', 9600, 14400);
    const outgoing = clip('outgoing', 'v2', 19200, 24000);
    expect(timelineGap(right, [left, outgoing])).toEqual({ start: 4800, end: 19200 });
    expect(placementCollision([left], [left, { ...right, startSmp: 4800 }])).toBeUndefined();
    expect(placementCollision([left], [left, { ...right, startSmp: 4799 }])).toEqual(left);
    expect(placementCollision([left], [left, { ...right, startSmp: 0, visualLane: 1 }])).toBeUndefined();
  });

  it('splits on existing written boundaries and keeps source time and linked motion', () => {
    const voice = { ...clip('voice', 'a2', 48000, 67200), sourceStartSmp: 4800 };
    const pose = { ...clip('pose', 'v1', voice.startSmp, voice.endSmp), linkedAudioId: voice.id, sourceStartSmp: 4800,
      poseFrames: [{ u: 0, params: Array(19).fill(0) }, { u: 1, params: Array(19).fill(1) }], m27RowsPa: [Array(27).fill(1)] };
    const lyric = { ...clip('lyric', 'v3', voice.startSmp, voice.endSmp), linkedAudioId: voice.id, sourceStartSmp: 4800 };
    const music = clip('music', 'a3', 0, 67200);
    const syllables = [syllable('甲', 0, 9600), syllable('乙', 12000, 24000)];
    const samples = textSplitSamples(lyric, syllables);
    expect(samples).toEqual([52800, 55200]);
    const result = splitTimelineClips([voice, pose, lyric, music], lyric, samples, true, syllables);
    expect(result.selected.map(item => [item.label, item.sourceStartSmp])).toEqual([
      ['甲', 4800], ['间隔', 9600], ['乙', 12000],
    ]);
    const audio = result.clips.filter(item => item.track === 'a2');
    for (const track of ['v1', 'v3']) {
      expect(result.clips.filter(item => item.track === track).map(item => item.linkedAudioId)).toEqual(audio.map(item => item.id));
    }
    expect(result.clips.at(-1)).toBe(music);
    const project = createInitialProject();
    const keys = timelineKeys(result.clips);
    const v0 = stageLayer(project, 'v0')!;
    v0.keys = { ...v0.keys, nle_meta: keys };
    const poses = readTimeline(project, project.clip_order[0]).filter(item => item.track === 'v1');
    expect(keys.filter(key => Object.hasOwn(JSON.parse(key.frame!), 'poseFrames'))).toHaveLength(1);
    expect(poses[2].poseFrames).toBe(poses[0].poseFrames);
    expect(poses[2].m27RowsPa).toEqual(pose.m27RowsPa);
    v0.keys.nle_meta = timelineKeys(poses.slice(1));
    expect(readTimeline(project, project.clip_order[0])[1].poseFrames).toEqual(pose.poseFrames);
    expect(splitTimelineClips([voice, pose, lyric, music], lyric, samples, false).clips.filter(item => item.track === 'a2')).toEqual([voice]);
  });
});
