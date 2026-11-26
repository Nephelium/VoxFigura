import { describe, expect, it } from 'vitest';
import { createInitialProject } from '@/stores/workbench';
import type { Syllable } from '@vocalcut/core';
import { readTimeline, stageLayer, stageVisualLaneCount, timelineKeys } from '@/components/studio/nle-timeline';
import { stageLyricTokens, subtitleSizeFactor } from '@/components/studio/stage-caption';
import { stageSubtitleRows } from '@/components/modals/stage-subtitles';

describe('stage subtitle export', () => {
  it('maps V3 source trims and moves to the same half-open timeline as the monitor', () => {
    const project = createInitialProject();
    const phrase = project.clips[project.clip_order[0]];
    const first: Syllable = {
      id: 'word', text: '花', ipa: ['x', 'w', 'a'], start_smp: 480, end_smp: 36480, nucleus_index: 2,
      anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 }, segments: [], targets: [],
      overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
    };
    phrase.syllable_order = [first.id];
    phrase.syllables = { [first.id]: first };
    phrase.end_smp = first.end_smp;
    const sourceStart = first.start_smp + 50;
    const sourceLength = first.end_smp - sourceStart;
    const background = stageLayer(project, 'v0')!;
    background.keys = { ...background.keys, nle_meta: timelineKeys([
      { id: 'v3-cut', track: 'v3', label: '字幕', startSmp: 48000, endSmp: 48000 + sourceLength, sourceStartSmp: sourceStart },
    ]) };
    expect(stageSubtitleRows(project, phrase.id)).toEqual([
      { start_s: 1, end_s: 1 + sourceLength / 48000, text: first.text, ipa: '[' + first.ipa.join('') + ']' },
    ]);
    stageLayer(project, 'v3')!.visible = false;
    expect(stageSubtitleRows(project, phrase.id)).toEqual([]);
  });

  it('breaks timed lyric and IPA at punctuation and a line break', () => {
    const project = createInitialProject();
    const phrase = project.clips[project.clip_order[0]];
    const syllables = [...'甲乙丙丁'].map((text, i): Syllable => ({
      id: String(i), text, ipa: [String(i)], start_smp: (i + 1) * 480, end_smp: (i + 2) * 480, nucleus_index: 0,
      anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 }, segments: [], targets: [],
      overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
    }));
    phrase.source = { lyrics: '甲乙，丙\n丁。' };
    phrase.syllable_order = syllables.map(item => item.id);
    phrase.syllables = Object.fromEntries(syllables.map(item => [item.id, item]));
    const visible = (sample: number) => stageLyricTokens(phrase, sample).filter(item => item.lit).map(item => [item.text, item.ipa]);
    expect(visible(960)).toEqual([['甲', '0'], ['乙，', '1']]);
    expect(visible(1440)).toEqual([['丙', '2']]);
    expect(visible(1920)).toEqual([['丁。', '3']]);
    expect(visible(2400)).toEqual([]);
    expect(stageLyricTokens(phrase, 960, 'single_char').map(item => [item.text, item.ipa])).toEqual([['乙', '1']]);
    expect(stageLyricTokens(phrase, 960, 'char_by_char', { startSmp: 960, endSmp: 1440 }).map(item => item.text)).toEqual(['乙，']);
  });

  it('makes adjacent glyph sizes distinct and repeatable for the same seed', () => {
    const jitter = { enabled: true, min_pct: 60, max_pct: 140, seed: 31 };
    const sizes = Array.from({ length: 12 }, (_, index) => subtitleSizeFactor(jitter, 'clip/syllable-' + index + '/0'));
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeGreaterThan(.35);
    expect(sizes.every(size => size >= .6 && size <= 1.4)).toBe(true);
    expect(subtitleSizeFactor(jitter, 'clip/syllable-0/0')).toBe(sizes[0]);
    expect(subtitleSizeFactor({ ...jitter, seed: 32 }, 'clip/syllable-0/0')).not.toBe(sizes[0]);
  });

  it('keeps only the active grapheme when a syllable has multiple written letters', () => {
    const project = createInitialProject();
    const phrase = project.clips[project.clip_order[0]];
    const syllable: Syllable = {
      id: 'hi', text: 'hi', ipa: ['h', 'aɪ'], start_smp: 0, end_smp: 960, nucleus_index: 0,
      anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 }, segments: [], targets: [],
      overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
    };
    phrase.syllable_order = ['hi'];
    phrase.syllables = { hi: syllable };
    const textAt = (sample: number) => stageLyricTokens(phrase, sample, 'single_char').map(token => token.text);
    expect(textAt(479)).toEqual(['h']);
    expect(textAt(480)).toEqual(['i']);
    expect(textAt(960)).toEqual([]);
  });

  it('restores a secondary visual lane and defaults older timelines to the primary lane', () => {
    const project = createInitialProject();
    const layer = stageLayer(project, 'v3')!;
    expect(stageVisualLaneCount(project, 'v3')).toBe(1);
    layer.keys = { ...layer.keys, nle_lanes: [{ t_smp: 0, frame: '2' }] };
    const background = stageLayer(project, 'v0')!;
    background.keys = { ...background.keys, nle_meta: timelineKeys([
      { id: 'primary', track: 'v3', label: '主字幕', startSmp: 0, endSmp: 480, sourceStartSmp: 0 },
      { id: 'secondary', track: 'v3', label: '第二字幕轨', visualLane: 1, startSmp: 0, endSmp: 480, sourceStartSmp: 0 },
    ]) };
    expect(stageVisualLaneCount(project, 'v3')).toBe(2);
    expect(readTimeline(project, project.clip_order[0]).map(clip => clip.visualLane ?? 0)).toEqual([0, 1]);
  });
});
