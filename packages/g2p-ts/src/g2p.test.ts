import { describe, expect, it } from 'vitest';
import {
  analyzeJapaneseAccent,
  arpaToIpaSyllables,
  convertText,
  japaneseReadingsFor,
  loadCmu,
  mappingStandards,
  parseCmu,
  readNumberedScore,
  reviewText,
} from './index.ts';

describe('@vocalcut/g2p pure runtime', () => {
  it('supports all 10 Mandarin transcription standards', () => {
    expect(mappingStandards).toHaveLength(10);
    for (const std of mappingStandards) {
      const tokens = convertText('算', std);
      expect(tokens[0]?.kind).toBe('mapped');
      if (tokens[0]?.kind === 'mapped') {
        expect(tokens[0].value.length).toBeGreaterThan(0);
        expect(tokens[0].value).not.toBe('?');
      }
    }
  });

  it('loads CMUdict, kana dictionary, and reviews mixed text', async () => {
    const cmu = await loadCmu();
    expect(cmu.has('swan')).toBe(true);
    const ja = await japaneseReadingsFor('さくら');
    expect(ja.has('さくら')).toBe(true);
    const rows = reviewText('算 swan さくら', 'Standard Chinese (Beijing)', cmu, new Map(), ja);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows[0]?.language).toBe('zh');
    expect(rows[1]?.language).toBe('en');
    expect(rows[2]?.language).toBe('ja');
  });

  it('parses numbered score dynamics p-fff and (1p23)ff priority', () => {
    const parsed = readNumberedScore('1p 2fff (1p23)ff', 'C3', 120, false, 3);
    expect('score' in parsed).toBe(true);
    if ('score' in parsed) {
      const pitched = parsed.score.notes.filter((n) => n.midi !== null);
      expect(pitched).toHaveLength(5);
      expect(pitched[0]?.dynamic).toBe(-1); // p
      expect(pitched[1]?.dynamic).toBe(3);  // fff
      expect(pitched[2]?.dynamic).toBe(-1); // inner p wins over outer ff
      expect(pitched[3]?.dynamic).toBe(2);  // ff inherited from group
      expect(pitched[4]?.dynamic).toBe(2);  // ff inherited from group
    }
  });

  it('analyzes Japanese pitch accent offline via compact sharded dictionary', async () => {
    const arigatou = await analyzeJapaneseAccent('ありがとう');
    expect(arigatou.dictionaryHits).toBeGreaterThan(0);
    expect(arigatou.moras.map((m) => m.tone)).toEqual(['L', 'H↘', 'L', 'L', 'L']);
    expect(arigatou.moras[1].pitchSt).toBeGreaterThan(arigatou.moras[0].pitchSt);
    expect(arigatou.moras[1].pitchSt).toBeGreaterThan(arigatou.moras[2].pitchSt);

    const sentence = await analyzeJapaneseAccent('今日はいい天気ですね');
    expect(sentence.dictionaryHits).toBeGreaterThanOrEqual(4);
    expect(sentence.moras.length).toBeGreaterThanOrEqual(8);
    expect(sentence.moras[0].tone).toBe('H↘'); // 今日 (1型)
    expect(sentence.moras[1].tone).toBe('L');
    expect(sentence.moras[2].tone).toBe('L'); // は attaches to 今日
  });

  it('transcribes narrow English aspiration on fortis stops /p, t, k/ and /t͡ʃʰ/', async () => {
    const cmu = await loadCmu();
    const reviewEn = (word: string) =>
      reviewText(word, 'Standard Chinese (Beijing)', cmu, new Map()).map((r) => r.ipa);

    // Voiceless affricate /t͡ʃʰ/ & /s/+stop de-aspiration from user screenshot (`bitch, speech, switch`)
    expect(reviewEn('bitch')).toEqual(['ˈbɪt͡ʃʰ']);
    expect(reviewEn('speech')).toEqual(['ˈspit͡ʃʰ']);
    expect(reviewEn('switch')).toEqual(['ˈswɪt͡ʃʰ']);
    expect(reviewEn('church')).toEqual(['ˈt͡ʃʰɝt͡ʃʰ']);
    expect(reviewEn('teacher')).toEqual(['ˈtʰi', 't͡ʃʰɚ']);

    // Stressed / word-initial onset stops + stop-sonorant clusters aspirate
    expect(reviewEn('paper')).toEqual(['ˈpʰeɪ', 'pɚ']);
    expect(reviewEn('apart')).toEqual(['ə', 'ˈpʰɑɹt']);
    expect(reviewEn('potato')).toEqual(['pʰə', 'ˈtʰeɪ', 'ˌtʰoʊ']);
    expect(reviewEn('campus')).toEqual(['ˈkʰæm', 'pəs']);
    expect(reviewEn('please')).toEqual(['ˈpʰliz']);
    expect(reviewEn('tree')).toEqual(['ˈtʰɹi']);
    expect(reviewEn('clean')).toEqual(['ˈkʰlin']);
    expect(reviewEn('queen')).toEqual(['ˈkʰwin']);
    expect(reviewEn('participate')).toEqual(['pʰɑɹ', 'ˈtʰɪ', 'sə', 'ˌpʰeɪt']);
    expect(reviewEn('cat')).toEqual(['ˈkʰæt']);

    // /s/-cluster, unstressed medial, coda, and non-sonorant loanword clusters stay unaspirated
    expect(reviewEn('stop')).toEqual(['ˈstɑp']);
    expect(reviewEn('spring')).toEqual(['ˈspɹɪŋ']);
    expect(reviewEn('sky')).toEqual(['ˈskaɪ']);
    expect(reviewEn('extra')).toEqual(['ˈɛk', 'stɹə']);
    expect(reviewEn('dispute')).toEqual(['dɪ', 'ˈspjut']);
    expect(reviewEn('happy')).toEqual(['ˈhæ', 'pi']);
    expect(arpaToIpaSyllables('T S UW0 N AA1 M IY0')).toEqual(['tsu', 'ˈnɑ', 'mi']);

    // Direct CMUdict plural & inflected suffix fallbacks ending in /t͡ʃʰ/
    expect(reviewEn('speeches')).toEqual(['ˈspi', 't͡ʃʰəz']);
    const miniCmu = parseCmu('SWITCH  S W IH1 CH\nPITCH  P IH1 CH\n');
    expect(
      reviewText('switches pitched', 'Standard Chinese (Beijing)', miniCmu, new Map()).map((r) => r.ipa),
    ).toEqual(['ˈswɪt͡ʃʰ', 'ɪz', 'ˈpʰɪt͡ʃʰt']);
  });
});
