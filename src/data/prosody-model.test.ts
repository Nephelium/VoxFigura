import { describe, expect, it } from 'vitest';
import {
  extractMixedProsodyRuns,
  mapProsodyRunDurationsMs,
  mapProsodyRunPitchToTimeline,
  type MixedProsodyRowInput,
} from './prosody-model';

describe('Mixed-language Text2Prosody run extraction and timeline mapping', () => {
  it('keeps Mandarin and English runs intact when [IPA] segments appear in the same utterance', () => {
    const rows: MixedProsodyRowInput[] = [
      { word: '你', language: 'zh', pause: 0, eligible: true, groupKey: 'plain' },
      { word: '好', language: 'zh', pause: 0, eligible: true, groupKey: 'plain' },
      { word: 'hel', language: 'en', sourceWord: 'hello', syllableIndex: 0, syllableCount: 2, pause: 0, eligible: true, groupKey: 'plain' },
      { word: 'lo', language: 'en', sourceWord: 'hello', syllableIndex: 1, syllableCount: 2, pause: 0, eligible: true, groupKey: 'plain' },
      { word: '[pʰa]', language: 'ipa', pause: 0, eligible: false, groupKey: 'plain' },
      { word: '谢', language: 'zh', pause: 0, eligible: true, groupKey: 'plain' },
      { word: '谢', language: 'zh', pause: 0, eligible: true, groupKey: 'plain' },
    ];

    const runs = extractMixedProsodyRuns(rows);
    expect(runs).toEqual([
      { startIndex: 0, endIndex: 4, text: '你好 hello' },
      { startIndex: 5, endIndex: 7, text: '谢谢' },
    ]);
  });

  it('splits runs across VoQS scope changes and preserves internal punctuation pauses', () => {
    const rows: MixedProsodyRowInput[] = [
      { word: '今', language: 'zh', pause: 0, eligible: true, groupKey: 'plain' },
      { word: '天', language: 'zh', pause: 180, phraseEnd: true, eligible: true, groupKey: 'plain' },
      { word: 'world', language: 'en', pause: 0, eligible: true, groupKey: 'plain' },
      { word: '好', language: 'zh', pause: 0, eligible: true, groupKey: 'breathy:' },
    ];

    const runs = extractMixedProsodyRuns(rows);
    expect(runs).toEqual([
      { startIndex: 0, endIndex: 3, text: '今天，world' },
      { startIndex: 3, endIndex: 4, text: '好' },
    ]);
  });

  it('maps predicted run F0 knots strictly inside target syllable bounds without leaking into adjacent IPA', () => {
    const predicted = {
      syllableOrder: ['s1', 's2'],
      syllables: {
        s1: { start_smp: 2880, end_smp: 12000 },
        s2: { start_smp: 12000, end_smp: 22000 },
      },
      pitch: [
        { t_smp: 0, f0_hz: 165 },
        { t_smp: 4000, f0_hz: 155 },
        { t_smp: 10000, f0_hz: 210 },
        { t_smp: 16000, f0_hz: 140 },
        { t_smp: 21000, f0_hz: 185 },
        { t_smp: 26000, f0_hz: 185 },
      ],
    };
    const targetSyllables = [
      { start_smp: 4800, end_smp: 14400 },
      { start_smp: 14400, end_smp: 24000 },
    ];

    const mapped = mapProsodyRunPitchToTimeline(predicted, targetSyllables);
    expect(mapped.length).toBeGreaterThanOrEqual(4);
    expect(mapped[0].t_smp).toBe(4800);
    expect(mapped[mapped.length - 1].t_smp).toBe(24000);
    // Every point stays strictly within [4800, 24000] and is strictly increasing in time.
    for (let i = 0; i < mapped.length; i++) {
      expect(mapped[i].t_smp).toBeGreaterThanOrEqual(4800);
      expect(mapped[i].t_smp).toBeLessThanOrEqual(24000);
      if (i > 0) expect(mapped[i].t_smp).toBeGreaterThan(mapped[i - 1].t_smp);
    }
    // Preserves the natural pitch contour excursion (not flattened).
    const f0s = mapped.map((p) => p.f0_hz);
    expect(Math.max(...f0s) - Math.min(...f0s)).toBeGreaterThan(50);
  });

  it('distributes Text2Prosody-Lite word durations across multi-syllable English words proportionally', () => {
    const predicted = {
      syllableOrder: ['w1', 'w2', 'w3', 'w4'],
      syllables: {
        w1: { start_smp: 0, end_smp: 16800 },      // 350 ms (`Welcome`)
        w2: { start_smp: 16800, end_smp: 24000 },  // 150 ms (`to`)
        w3: { start_smp: 24000, end_smp: 38400 },  // 300 ms (`speech`)
        w4: { start_smp: 38400, end_smp: 57600 },  // 400 ms (`science`)
      },
    };
    const rows = [
      { sourceWord: 'Welcome', syllableIndex: 0, syllableCount: 2 },
      { sourceWord: 'Welcome', syllableIndex: 1, syllableCount: 2 },
      { sourceWord: 'to', syllableIndex: 0, syllableCount: 1 },
      { sourceWord: 'speech', syllableIndex: 0, syllableCount: 1 },
      { sourceWord: 'science', syllableIndex: 0, syllableCount: 2 },
      { sourceWord: 'science', syllableIndex: 1, syllableCount: 2 },
    ];
    const weights = [240, 160, 120, 260, 250, 150];

    const mapped = mapProsodyRunDurationsMs(rows, predicted, weights);
    expect(mapped).toEqual([210, 140, 150, 300, 250, 150]);

    // Exact 1:1 count preserves direct model millisecond durations
    expect(mapProsodyRunDurationsMs(rows.slice(0, 4), predicted)).toEqual([350, 150, 300, 400]);

    // Mismatched group count returns null
    expect(mapProsodyRunDurationsMs(rows.slice(0, 3), predicted, weights.slice(0, 3))).toBeNull();
  });

  it('extracts eligible unmarked [IPA] runs separated by VoQS scopes for Text2Prosody-Lite LANG_IPA=3', () => {
    const rows: MixedProsodyRowInput[] = [
      { word: 'ˈnɔ', language: 'ipa', ipaPhones: ['n', 'ɔ'], pause: 0, eligible: true, groupKey: 'plain' },
      { word: 'məl', language: 'ipa', ipaPhones: ['m', 'ə', 'l'], pause: 0, eligible: true, groupKey: 'plain' },
      { word: 'ˈvɔɪs', language: 'ipa', ipaPhones: ['v', 'ɔ', 'ɪ', 's'], pause: 350, phraseEnd: true, eligible: true, groupKey: 'plain' },
      { word: 'fɔl', language: 'ipa', ipaPhones: ['f', 'ɔ', 'l'], pause: 0, eligible: true, groupKey: 'F:' },
      { word: 'ˈsɛ', language: 'ipa', ipaPhones: ['s', 'ɛ'], pause: 0, eligible: true, groupKey: 'F:' },
      { word: 'toʊ', language: 'ipa', ipaPhones: ['t', 'oʊ'], pause: 0, eligible: true, groupKey: 'F:' },
      { word: 'ma⁵⁵', language: 'ipa', ipaPhones: ['m', 'a'], pause: 0, eligible: false, groupKey: 'plain' },
    ];
    const runs = extractMixedProsodyRuns(rows);
    expect(runs).toEqual([
      { startIndex: 0, endIndex: 3, text: '[n ɔ] [m ə l] [v ɔ ɪ s].' },
      { startIndex: 3, endIndex: 6, text: '[f ɔ l] [s ɛ] [t oʊ].' },
    ]);
  });

  it('keeps continuous IPA prosody across 175 ms space short-pauses while splitting dot boundaries and keeping commas', () => {
    const rows: MixedProsodyRowInput[] = [
      { word: '[ˈnɔməl]', language: 'ipa', ipaPhones: ['n', 'ɔ', 'm', 'ə', 'l'], pause: 175, eligible: true, groupKey: 'plain' },
      { word: '[ˈvɔɪs]', language: 'ipa', ipaPhones: ['v', 'ɔ', 'ɪ', 's'], pause: 350, phraseEnd: true, eligible: true, groupKey: 'plain' },
      { word: '[ˈtɛst]', language: 'ipa', ipaPhones: ['t', 'ɛ', 's', 't'], pause: 180, phraseEnd: true, eligible: true, groupKey: 'plain' },
      { word: '[ˈwʌn]', language: 'ipa', ipaPhones: ['w', 'ʌ', 'n'], pause: 0, eligible: true, groupKey: 'plain' },
    ];
    expect(extractMixedProsodyRuns(rows)).toEqual([
      { startIndex: 0, endIndex: 2, text: '[n ɔ m ə l] [v ɔ ɪ s].' },
      { startIndex: 2, endIndex: 4, text: '[t ɛ s t], [w ʌ n].' },
    ]);
  });
});
