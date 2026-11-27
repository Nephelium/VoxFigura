import { describe, expect, it } from 'vitest';
import {
  analyzeJapaneseAccent,
  arpaToIpaSyllables,
  convertText,
  japaneseKanjiReadingsFor,
  japaneseReadingsFor,
  jyutpingToNarrowIpa,
  loadCantoneseDictionary,
  loadCmu,
  mappingStandards,
  narrowJapaneseMoraIpa,
  parseCmu,
  readNumberedScore,
  reviewKana,
  reviewRomaji,
  reviewText,
  romajiToHiragana,
  spanishWordToNarrowIpaSyllables,
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

  it('parses numbered score dynamics p-fff and 《1p 2 3》ff priority', () => {
    const parsed = readNumberedScore('《1p》 《2fff》 《1p 2 3》ff', 'C3', 120, false, 3);
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
    expect(sentence.moras.map((m) => m.ipa)).toEqual([
      'kʲjo̞', 'o̞', 'ɰᵝä', 'i', 'i', 'te̞', 'ŋ̩', 'kʲi', 'de̞', 'sɯ̈ᵝ', 'ne̞',
    ]);
  });

  it('transcribes Tokyo Japanese narrow IPA allophony, yoon glides, centralized u, devoicing, and MFA dictionary output', async () => {
    // High-vowel devoicing: utterance-final unaccented です, inter-voiceless すき / きって, but not すすむ (fric+V+fric)
    const desu = await analyzeJapaneseAccent('天気です。');
    expect(desu.moras.map((m) => m.ipa)).toEqual(['te̞', 'ŋ̩', 'kʲi', 'de̞', 'sɯ̥̈ᵝ']);

    const suki = await analyzeJapaneseAccent('好き');
    expect(suki.moras.map((m) => m.ipa)).toEqual(['sɯ̥̈ᵝ', 'kʲi']);

    const kitte = await analyzeJapaneseAccent('切手');
    expect(kitte.moras.map((m) => m.ipa)).toEqual(['kʲi̥', 't̚', 'te̞']);

    expect(reviewKana('すすむ').map((r) => r.ipa)).toEqual(['sɯ̈ᵝ', 'sɯ̈ᵝ', 'mɯ̈ᵝ']);

    // Palatal yoon rows take /j/ glide (き/ぎ/に/ひ/び/ぴ/み/り + extended てゅ/でゅ/ふゅ/ゔゅ),
    // labiovelar yoon rows take /ɰᵝ/ glide (くぁ/ぐぁ), while alveolopalatal sibilants (し/じ/ち) stay glide-free.
    expect(reviewKana('きょうりゅうひゃくにょうびょうぴょんみゃく').map((r) => r.ipa)).toEqual([
      'kʲjo̞', 'o̞', 'ɾʲjɯ̈ᵝ', 'ɯ̈ᵝ', 'çjä', 'kɯ̈ᵝ', 'ɲjo̞', 'o̞', 'bʲjo̞', 'o̞', 'pʲjo̞', 'm̩', 'mʲjä', 'kɯ̈ᵝ',
    ]);
    expect(reviewKana('しゃ しゅ しょ ちゃ ちゅ ちょ じゃ じゅ じょ').map((r) => r.ipa)).toEqual([
      'ɕä', 'ɕɯ̈ᵝ', 'ɕo̞', 't͡ɕä', 't͡ɕɯ̈ᵝ', 't͡ɕo̞', 'd͡ʑä', 'd͡ʑɯ̈ᵝ', 'd͡ʑo̞',
    ]);
    // Unspaced ちゅちょ triggers Tokyo high-vowel devoicing between voiceless affricates
    expect(reviewKana('ちゅちょ').map((r) => r.ipa)).toEqual(['t͡ɕɯ̥̈ᵝ', 't͡ɕo̞']);
    expect(reviewKana('ぎょ てゅ でゅ ふゅ くぁ ぐぉ').map((r) => r.ipa)).toEqual([
      'ɡʲjo̞', 'tʲjɯ̈ᵝ', 'dʲjɯ̈ᵝ', 'ɸʲjɯ̈ᵝ', 'kʷɰᵝä', 'ɡʷɰᵝo̞',
    ]);

    // Initial/post-nasal affricate [d͡z, d͡ʑ] vs intervocalic fricative [z, ʑ]
    expect(reviewKana('ざっし').map((r) => r.ipa)).toEqual(['d͡zä', 'ɕ', 'ɕi']);
    expect(reviewKana('かんじ').map((r) => r.ipa)).toEqual(['kä', 'ɲ̩', 'd͡ʑi']);
    expect(reviewKana('かぜ').map((r) => r.ipa)).toEqual(['kä', 'ze̞']);
    expect(reviewKana('かじ').map((r) => r.ipa)).toEqual(['kä', 'ʑi']);

    // 6-way moraic nasal assimilation: m̩ / n̩ / ɲ̩ / ŋ̩ / ɰ̩̃ / ɴ̩
    expect(reviewKana('しんぶん').map((r) => r.ipa)).toEqual(['ɕi', 'm̩', 'bɯ̈ᵝ', 'ɴ̩']);
    expect(reviewKana('あんない').map((r) => r.ipa)).toEqual(['ä', 'n̩', 'nä', 'i']);
    expect(reviewKana('でんわ').map((r) => r.ipa)).toEqual(['de̞', 'ɰ̩̃', 'ɰᵝä']);
    expect(reviewKana('てんき').map((r) => r.ipa)).toEqual(['te̞', 'ŋ̩', 'kʲi']);

    // MFA v3.0.0 Japanese dictionary entries are normalized to narrow Tokyo IPA & helper is idempotent
    const ja = await japaneseReadingsFor('さくら');
    expect(ja.get('さくら')?.[0]).toEqual(['sä', 'kɯ̈ᵝ', 'ɾä']);
    expect(narrowJapaneseMoraIpa('co')).toBe('kʲjo̞');
    expect(narrowJapaneseMoraIpa('ɟa')).toBe('ɡʲjä');
    expect(narrowJapaneseMoraIpa('ɲo')).toBe('ɲjo̞');
    expect(narrowJapaneseMoraIpa('ço')).toBe('çjo̞');
    expect(narrowJapaneseMoraIpa('bʲɨ')).toBe('bʲjɯ̈ᵝ');
    expect(narrowJapaneseMoraIpa('ɕo')).toBe('ɕo̞');
    expect(narrowJapaneseMoraIpa('ɡwa')).toBe('ɡʷɰᵝä');
    expect(narrowJapaneseMoraIpa('tsɯ̥')).toBe('t͡sɯ̥̈ᵝ');
    expect(narrowJapaneseMoraIpa('sɨ̥')).toBe('sɯ̥̈ᵝ');
    for (const raw of ['co', 'ci', 'ɟi', 'ɟo', 'wa', 'ɡwa', 'tsɯ̥', 'kʲo̞', 'kʲjo̞', 'ɯᵝ̥', 'ɯ̥̈ᵝ', 'ɰ̩̃', 'ɲo', 'ɕɨ̥']) {
      const once = narrowJapaneseMoraIpa(raw);
      expect(narrowJapaneseMoraIpa(once)).toBe(once);
    }
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
    expect(reviewEn('apart')).toEqual(['ə', 'ˈpʰɑɹ̠ʷt']);
    expect(reviewEn('potato')).toEqual(['pʰə', 'ˈtʰeɪ', 'ˌtʰoʊ']);
    expect(reviewEn('campus')).toEqual(['ˈkʰæm', 'pəs']);
    expect(reviewEn('please')).toEqual(['ˈpʰliz']);
    expect(reviewEn('tree')).toEqual(['ˈtʰɹ̠ʷi']);
    expect(reviewEn('clean')).toEqual(['ˈkʰlin']);
    expect(reviewEn('queen')).toEqual(['ˈkʰwin']);
    expect(reviewEn('participate')).toEqual(['pʰɑɹ̠ʷ', 'ˈtʰɪ', 'sə', 'ˌpʰeɪt']);
    expect(reviewEn('cat')).toEqual(['ˈkʰæt']);

    // /s/-cluster, unstressed medial, coda, and non-sonorant loanword clusters stay unaspirated
    expect(reviewEn('stop')).toEqual(['ˈstɑp']);
    expect(reviewEn('spring')).toEqual(['ˈspɹ̠ʷɪŋ']);
    expect(reviewEn('sky')).toEqual(['ˈskaɪ']);
    expect(reviewEn('extra')).toEqual(['ˈɛk', 'stɹ̠ʷə']);
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

  it('maps IPA [...] whitespace to 175 ms short pause and dot (. / ·) to 350 ms long pause without breaking syllable dots or plain text', () => {
    const read = (text: string) => reviewText(text, 'Standard Chinese (Beijing)', new Map(), new Map());

    // Space inside [...] -> 175 ms short pause (half of 350 ms), phraseEnd stays falsy
    const spaced = read('[ˈnɔməl ˈvɔɪs]');
    expect(spaced.map((r) => ({ ipa: r.ipa, pause: r.pause, phraseEnd: Boolean(r.phraseEnd) }))).toEqual([
      { ipa: 'ˈnɔməl', pause: 175, phraseEnd: false },
      { ipa: 'ˈvɔɪs', pause: 0, phraseEnd: false },
    ]);

    // Trailing `.`, standalone `.`, and middle dot `·` -> 350 ms long pause + phraseEnd
    for (const sample of ['[ˈnɔməl. ˈvɔɪs]', '[ˈnɔməl . ˈvɔɪs]', '[ˈnɔməl · ˈvɔɪs]', '[ˈnɔməl·ˈvɔɪs]']) {
      const rows = read(sample);
      expect(rows.map((r) => ({ ipa: r.ipa, pause: r.pause, phraseEnd: Boolean(r.phraseEnd) })), sample).toEqual([
        { ipa: 'ˈnɔməl', pause: 350, phraseEnd: true },
        { ipa: 'ˈvɔɪs', pause: 0, phraseEnd: false },
      ]);
    }

    // Word-internal tight `.` remains a 0 ms syllable break; `‿` remains 0 ms linked liaison
    const tightDot = read('[ˈnɔ.məl]');
    expect(tightDot.map((r) => ({ ipa: r.ipa, pause: r.pause, phraseEnd: Boolean(r.phraseEnd) }))).toEqual([
      { ipa: 'ˈnɔ', pause: 0, phraseEnd: false },
      { ipa: 'məl', pause: 0, phraseEnd: false },
    ]);

    const linked = read('[ˈnɔməl‿ˈvɔɪs]');
    expect(linked.map((r) => ({ ipa: r.ipa, pause: r.pause, linkedToNext: Boolean(r.linkedToNext) }))).toEqual([
      { ipa: 'ˈnɔməl', pause: 0, linkedToNext: true },
      { ipa: 'ˈvɔɪs', pause: 0, linkedToNext: false },
    ]);

    // Comma keeps 180 ms phrase pause; orphan diacritic after space never adds a pause
    const comma = read('[ˈnɔməl, ˈvɔɪs]');
    expect(comma[0]).toMatchObject({ pause: 180, phraseEnd: true });
    expect(read('[a ◌̹]')).toMatchObject([{ ipa: 'a̹', pause: 0 }]);

    // Non-IPA Chinese/English spaces stay 0 ms
    const miniCmu = parseCmu('NORMAL  N AO1 R M AH0 L\nVOICE  V OY1 S\n');
    const enRows = reviewText('normal voice', 'Standard Chinese (Beijing)', miniCmu, new Map());
    expect(enRows.every((r) => r.pause === 0)).toBe(true);
    const zhRows = reviewText('你 好', 'Standard Chinese (Beijing)', miniCmu, new Map());
    expect(zhRows.every((r) => r.pause === 0)).toBe(true);
  });

  it('supports Japanese romaji, Kanji reading lookup, and singing mode disabling high-vowel devoicing', async () => {
    expect(romajiToHiragana('sakura')).toBe('さくら');
    expect(romajiToHiragana('kitte')).toBe('きって');
    expect(romajiToHiragana('matcha')).toBe('まっちゃ');
    expect(romajiToHiragana('shimbun')).toBe('しんぶん');
    expect(romajiToHiragana("shin'ai")).toBe('しんあい');
    expect(romajiToHiragana('konnichiwa')).toBe('こんにちわ');
    expect(romajiToHiragana('tōkyō')).toBe('とーきょー');
    expect(romajiToHiragana('world')).toBeNull();

    // Singing mode disables Tokyo high-vowel devoicing while speech mode preserves it
    expect(reviewKana('すき', undefined, { singing: false }).map((r) => r.ipa)).toEqual(['sɯ̥̈ᵝ', 'kʲi']);
    expect(reviewKana('すき', undefined, { singing: true }).map((r) => r.ipa)).toEqual(['sɯ̈ᵝ', 'kʲi']);
    expect(reviewRomaji('suki kitte', undefined, { singing: true }).map((r) => r.ipa)).toEqual([
      'sɯ̈ᵝ', 'kʲi', 'kʲi', 't̚', 'te̞',
    ]);

    // Japanese Kanji offline lookup + primaryLang='ja' routing in reviewText
    const jaKanji = await japaneseKanjiReadingsFor('今日は好き');
    const rows = reviewText('今日は好き sakura', 'Standard Chinese (Beijing)', new Map(), new Map(), undefined, {
      primaryLang: 'ja',
      singing: true,
      jaKanji,
    });
    expect(rows.every((r) => r.language === 'ja')).toBe(true);
    expect(rows.map((r) => r.ipa)).toEqual(['kʲjo̞', 'o̞', 'ɰᵝä', 'sɯ̈ᵝ', 'kʲi', 'sä', 'kɯ̈ᵝ', 'ɾä']);
  });

  it('supports Cantonese Jyutping/Hanzi narrow IPA, Spanish orthographic narrow allophony, and primary/secondary language disambiguation', async () => {
    // Cantonese Jyutping -> narrow HK Cantonese IPA (unreleased -p̚/-t̚/-k̚, lax ɪ/ʊ)
    expect(jyutpingToNarrowIpa('gwong2')).toBe('kʷɔːŋ˧˥');
    expect(jyutpingToNarrowIpa('jat1')).toBe('jɐt̚˥');
    expect(jyutpingToNarrowIpa('sing1')).toBe('sɪŋ˥˥');
    expect(jyutpingToNarrowIpa('m4')).toBe('m̩˨˩');

    const yueRows = reviewText('我愛你 gwong2', 'Standard Chinese (Beijing)', new Map(), new Map(), undefined, {
      primaryLang: 'yue',
    });
    expect(yueRows.map((r) => r.language)).toEqual(['yue', 'yue', 'yue', 'yue']);
    expect(yueRows.map((r) => r.ipa)).toEqual(['ŋɔː˩˧', 'ɔːi˧˧', 'nei˩˧', 'kʷɔːŋ˧˥']);

    // Spanish orthographic G2P -> narrow IPA (intervocalic spirantization β̞/ð̞/ɣ̞, trill r vs tap ɾ, stress, Castilian θ choice)
    const corazon = spanishWordToNarrowIpaSyllables('corazón');
    expect(corazon?.syllables).toEqual(['ko', 'ɾa', 'ˈson']);
    expect(corazon?.castilian).toEqual(['ko', 'ɾa', 'ˈθon']);
    expect(spanishWordToNarrowIpaSyllables('todo')?.syllables).toEqual(['ˈto', 'ð̞o']);
    expect(spanishWordToNarrowIpaSyllables('saber')?.syllables).toEqual(['sa', 'ˈβ̞eɾ']);
    expect(spanishWordToNarrowIpaSyllables('perro')?.syllables).toEqual(['ˈpe', 'ro']);
    expect(spanishWordToNarrowIpaSyllables('niño')?.syllables).toEqual(['ˈni', 'ɲo']);

    // Primary + Secondary disambiguation: ja primary + en secondary
    const cmu = await loadCmu();
    const jaEnRows = reviewText('sakura world', 'Standard Chinese (Beijing)', cmu, new Map(), undefined, {
      primaryLang: 'ja',
      secondaryLang: 'en',
      singing: true,
    });
    expect(jaEnRows.map((r) => r.language)).toEqual(['ja', 'ja', 'ja', 'en']);

    // SVP English ARPAbet extras (AX, DX, Q)
    expect(arpaToIpaSyllables('DH AX')).toEqual(['ðə']);
    expect(arpaToIpaSyllables('B AH1 DX ER0')).toEqual(['ˈbʌ', 'ɾɚ']);
  });

  it('loads offline Rime Cantonese + Unicode Unihan dictionary with polyphone and Simplified Chinese support', async () => {
    const yueLexicon = await loadCantoneseDictionary();
    expect(yueLexicon.chars.size).toBeGreaterThan(30000);
    expect(yueLexicon.words.size).toBeGreaterThan(25000);

    const reviewYue = (text: string) =>
      reviewText(text, 'Standard Chinese (Beijing)', new Map(), new Map(), undefined, {
        primaryLang: 'yue',
        yueLexicon,
      }).map((r) => r.ipa);

    // Polyphone disambiguation: 音乐/音樂 (ngok6) vs 快乐/快樂 (lok6), 银行/銀行 (hong4)
    expect(reviewYue('音樂')).toEqual(['jɐm˥˥', 'ŋɔːk̚˨']);
    expect(reviewYue('音乐')).toEqual(['jɐm˥˥', 'ŋɔːk̚˨']);
    expect(reviewYue('快樂')).toEqual(['faːi˧˧', 'lɔːk̚˨']);
    expect(reviewYue('银行')).toEqual(['ŋɐn˨˩', 'hɔːŋ˨˩']);

    // Simplified characters that collide with archaic Kangxi radicals inherit living HK Cantonese readings
    expect(reviewYue('广州')).toEqual(['kʷɔːŋ˧˥', 't͡sɐu˥˥']);
    expect(reviewYue('工厂')).toEqual(['kʊŋ˥˥', 't͡sʰɔːŋ˧˥']);
    expect(reviewYue('树叶')).toEqual(['syː˨˨', 'jiːp̚˨']);
  });
});
