import { describe, expect, it } from 'vitest';
import type { Clip, Syllable } from '@vocalcut/core';
import { extractMixedProsodyRuns, type MixedProsodyRowInput } from './prosody-model';
import {
  classifySentenceLanguage,
  partitionClipSentenceWindows,
  splitTextIntoSentences,
} from './sentence-compiler';

function makeDummySyllable(id: string, startSmp: number, endSmp: number): Syllable {
  return {
    id,
    text: id,
    ipa: ['a'],
    nucleus_index: 0,
    start_smp: startSmp,
    end_smp: endSmp,
    anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
    segments: [
      {
        id: `${id}_seg`,
        ipa: 'a',
        role: 'nucleus',
        voiced: true,
        elastic: true,
        start_smp: startSmp,
        end_smp: endSmp,
      },
    ],
    targets: [],
    overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
  };
}

describe('sentence-compiler sentence splitting & per-language classification', () => {
  it('splits mixed Chinese, English, Japanese, and [IPA/{VoQS}] sentences without breaking inside brackets', () => {
    const input =
      '今天天气真好。Welcome to speech science. こんにちは。[ˈnɔ˞məl ˈvɔɪs. {F fɔlˈsɛtoʊ F}. {W ˈwɪspəɹʷi W}]';
    const chunks = splitTextIntoSentences(input);

    expect(chunks.map((c) => c.text)).toEqual([
      '今天天气真好。',
      'Welcome to speech science.',
      'こんにちは。',
      '[ˈnɔ˞məl ˈvɔɪs. {F fɔlˈsɛtoʊ F}. {W ˈwɪspəɹʷi W}]',
    ]);
    expect(chunks.map((c) => c.language)).toEqual(['zh', 'en', 'ja', 'rule']);
    expect(chunks.map((c) => c.trailingPauseMs)).toEqual([350, 350, 350, 0]);
  });

  it('protects decimals, abbreviations, ellipses, closing quotes, and outer VoQS blocks', () => {
    expect(splitTextIntoSentences('圆周率约等于 3.14。下一句。').map((c) => c.text)).toEqual([
      '圆周率约等于 3.14。',
      '下一句。',
    ]);
    expect(
      splitTextIntoSentences('Mr. Smith visited U.S.A. yesterday. Today he rested.').map((c) => c.text),
    ).toEqual([
      'Mr. Smith visited U.S.A. yesterday.',
      'Today he rested.',
    ]);
    expect(splitTextIntoSentences('今天真好……明天呢？').map((c) => c.text)).toEqual([
      '今天真好……',
      '明天呢？',
    ]);
    expect(splitTextIntoSentences('他说：“你好。”我笑了。').map((c) => c.text)).toEqual([
      '他说：“你好。”',
      '我笑了。',
    ]);

    const voqsWrapped = splitTextIntoSentences('{B 第一句。第二句。 B}');
    expect(voqsWrapped).toHaveLength(1);
    expect(voqsWrapped[0]?.language).toBe('rule');

    expect(classifySentenceLanguage('今天 Hello World')).toBe('zh_en');
    expect(classifySentenceLanguage('今日はいい天気ですね')).toBe('ja');
    expect(classifySentenceLanguage('bitch, speech, switch')).toBe('en');
  });

  it('splits internal sentence boundaries inside extractMixedProsodyRuns on long pauses', () => {
    const rows: MixedProsodyRowInput[] = [
      { word: '你', language: 'zh', pause: 0, eligible: true, groupKey: 'breathy:' },
      { word: '好', language: 'zh', pause: 350, phraseEnd: true, eligible: true, groupKey: 'breathy:' },
      { word: 'hello', language: 'en', pause: 0, eligible: true, groupKey: 'breathy:' },
    ];
    const runs = extractMixedProsodyRuns(rows);
    expect(runs).toEqual([
      { startIndex: 0, endIndex: 2, text: '你好' },
      { startIndex: 2, endIndex: 3, text: 'hello' },
    ]);
  });

  it('partitions multi-sentence clips cleanly inside silence gaps and keeps touching sentences merged', () => {
    const syllables: Record<string, Syllable> = {
      s1_syl_01: makeDummySyllable('s1_syl_01', 2880, 14400),
      s1_syl_02: makeDummySyllable('s1_syl_02', 14400, 28800),
      s2_syl_01: makeDummySyllable('s2_syl_01', 45600, 62400),
      s3_syl_01: makeDummySyllable('s3_syl_01', 79200, 96000),
    };
    const clip: Pick<Clip, 'start_smp' | 'end_smp' | 'syllable_order' | 'syllables'> = {
      start_smp: 0,
      end_smp: 100800,
      syllable_order: ['s1_syl_01', 's1_syl_02', 's2_syl_01', 's3_syl_01'],
      syllables,
    };

    const windows = partitionClipSentenceWindows(clip);
    expect(windows).toHaveLength(3);
    expect(windows[0].startSmp).toBe(0);
    expect(windows[0].endSmp).toBe(windows[1].startSmp);
    expect(windows[1].endSmp).toBe(windows[2].startSmp);
    expect(windows[2].endSmp).toBe(100800);
    // Cuts sit strictly inside the inter-sentence silence gaps
    expect(windows[0].endSmp).toBeGreaterThanOrEqual(28800);
    expect(windows[0].endSmp).toBeLessThanOrEqual(45600);
    expect(windows[1].endSmp).toBeGreaterThanOrEqual(62400);
    expect(windows[1].endSmp).toBeLessThanOrEqual(79200);

    // Zero-gap touching sentences merge rather than slicing speech
    const tightClip: Pick<Clip, 'start_smp' | 'end_smp' | 'syllable_order' | 'syllables'> = {
      start_smp: 0,
      end_smp: 20000,
      syllable_order: ['s1_a', 's2_a'],
      syllables: {
        s1_a: makeDummySyllable('s1_a', 0, 10000),
        s2_a: makeDummySyllable('s2_a', 10200, 20000),
      },
    };
    expect(partitionClipSentenceWindows(tightClip)).toEqual([{ startSmp: 0, endSmp: 20000 }]);
  });
});
