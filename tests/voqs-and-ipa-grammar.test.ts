import { describe, expect, it } from 'vitest';
import {
  arpaToIpaSyllables,
  mixedSpeechTokens,
  parseCmu,
  reviewText,
  speechTokens,
} from '@vocalcut/g2p';
import { msToSamples, retime, type Clip, type Syllable } from '@vocalcut/core';
import {
  buildSyllableQtaTargets,
  parseIpaSuprasegmentals,
  phoneTraits,
  splitPhoneNotation,
  writtenToneLevels,
} from '../src/data/ipa-segments';
import {
  buildPhonationAnchorsFromVoqsSyllables,
  parseVoqsScopedText,
} from '../src/data/voqs-parser';
import {
  SYNTHESIS_VOQS_GROUPS,
  SYNTHESIS_VOQS_PROFILES,
  VOQS_PROFILES,
  voqsSynthesisLaneIndex,
} from '../src/data/voqs-library';
import { interfaceFontStack, normalizeInterfaceFonts } from '../src/styles/interface-fonts';
import { resolveBrandIconVariant } from '../src/data/app-branding';
import {
  buildPersonalG2pMap,
  lookupUserLexiconEntry,
  lookupUserLexiconReading,
  removeUserLexiconEntry,
  saveSyllableToUserLexicon,
} from '../src/data/user-lexicon';
import { useWorkbenchStore } from '../src/stores/workbench';
import { evaluateControlPitch } from '../src/components/research/control-pitch';
import { speechLexiconSelection } from '../src/components/research/speech-lexicon';

describe('IPA multi-syllable, tone sandhi, VoQS braces & English MOP syllabification', () => {
  it('T-43 & T-44: splits bracketed and bare IPA by spaces/punctuation and separates plain ASCII digits', () => {
    const bracketed =
      '[jɜu¹¹ jɜt⁴⁵ ŋɜt³¹, päk⁴⁵ fɘŋ²³ hɘŋ²² ŋit¹¹ hɑu¹¹ ŋɑu²³ kɜn⁴⁵ pin¹¹ kɔ²³ ʔə²³ pun⁴⁵ si³¹ tsui²³ tɑi³¹.]';
    const toks = speechTokens(bracketed);
    expect(toks[0]).toBe('[jɜu¹¹]');
    expect(toks[1]).toBe('[jɜt⁴⁵]');
    expect(toks[2]).toBe('[ŋɜt³¹]');
    expect(toks[3]).toBe(',');
    expect(toks.at(-2)).toBe('[tɑi³¹]');
    expect(toks.at(-1)).toBe('.');
    expect(toks.filter((t) => t.startsWith('[')).length).toBe(17);

    const bare = 'ᴀʊ˨˩ mi˧˧(˦˥˦꜓꜓) ɓᴀk̚˥꜔ fo̞ŋ˦˥˦ mᴀ˩˧꜕꜖ kᴀɪ˨˩ lɛ˩˧, tʃi˧˧ hə̞ʊ˧˧ ɬyn˥˨ lɛ˩˧';
    const bareToks = mixedSpeechTokens(bare);
    expect(bareToks.slice(0, 5)).toEqual([
      '[ᴀʊ˨˩]',
      '[mi˧˧(˦˥˦꜓꜓)]',
      '[ɓᴀk̚˥꜔]',
      '[fo̞ŋ˦˥˦]',
      '[mᴀ˩˧꜕꜖]',
    ]);

    // Plain ASCII digits are tokenized as spoken numbers, never interpreted as tone levels
    expect(writtenToneLevels('pin11')).toBeUndefined();
    expect(writtenToneLevels('pin¹¹')).toBe('11');
    const cmu = parseCmu('ONE  W AH1 N\nTWO  T UW1\n');
    const numRows = reviewText('12', 'Standard Chinese (Beijing)', cmu, new Map());
    expect(numRows.map((r) => r.word)).toEqual(['1', '2']);
    expect(numRows[0].ipa).toBeTruthy();
  });

  it('T-44: parses superscript tones, left-stem sandhi bars, parenthesized sandhi, checked codas, and open central ᴀ', () => {
    expect(phoneTraits('ᴀ')).toMatchObject({ base: 'ᴀ', vowel: true, voiced: true });

    const p1 = parseIpaSuprasegmentals('mi˧˧(˦˥˦꜓꜓)');
    expect(p1.citationTone).toBe('33');
    expect(p1.sandhiTone).toBe('44');
    expect(p1.effectiveTone).toBe('44');
    expect(splitPhoneNotation('mi˧˧(˦˥˦꜓꜓)')).toEqual(['m', 'i']);

    const p2 = parseIpaSuprasegmentals('ɓᴀk̚˥꜔');
    expect(p2.citationTone).toBe('5');
    expect(p2.sandhiTone).toBe('3');
    expect(p2.effectiveTone).toBe('3');
    expect(p2.checked).toBe(true);
    expect(p2.durationScale).toBeLessThan(0.8);

    const p3 = parseIpaSuprasegmentals('mᴀ˩˧꜕꜖');
    expect(p3.citationTone).toBe('13');
    expect(p3.sandhiTone).toBe('21');
    expect(p3.effectiveTone).toBe('21');

    // Convex contour 454 generates 2 qTA spans
    const convexTargets = buildSyllableQtaTargets('syl_1', 0, msToSamples(280), {
      effectiveTone: '454',
      fRefHz: 165,
    });
    expect(convexTargets.length).toBe(2);
    expect(convexTargets[0].candidates.default!.b_end_st).toBeGreaterThan(
      convexTargets[1].candidates.default!.b_end_st,
    );
  });

  it('T-47: parses VoQS labelled braces with scalar degrees 1-3, multi-dimensional tags, nesting, and unrecorded tag stripping', () => {
    const recordedExample =
      '[ˈnɔ˞məl ˈvɔɪs {3V̤ ˈvɛɹi ˈbɹɛθi ˈvɔɪs 3V̤} {L̝ 1V͈ ˈlɛs ˈpɹɛst {2V̰ ˈkɹiːki 2V̰} ˈvɔɪs 1V͈ L̝}]';
    const res = parseVoqsScopedText(recordedExample);
    expect(res.hasBraces).toBe(true);
    expect(res.skippedSymbols).toEqual([]);

    const breathyChunk = res.chunks.find((c) => c.text.includes('bɹɛθi'));
    expect(breathyChunk?.state?.phonation).toMatchObject({ symbol: 'V̤', degree: 3, blend: 1.0 });

    const compoundChunk = res.chunks.find((c) => c.text.includes('pɹɛst'));
    expect(compoundChunk?.state?.phonation).toMatchObject({ symbol: 'V͈', degree: 1, blend: 0.35 });
    expect(compoundChunk?.state?.larynxHeightCm).toBeCloseTo(0.5);

    const nestedChunk = res.chunks.find((c) => c.text.includes('kɹiːki'));
    expect(nestedChunk?.state?.phonation).toMatchObject({ symbol: 'V̰', degree: 2, blend: 0.7 });
    // Inherits outer L̝ larynx raising across nested scope!
    expect(nestedChunk?.state?.larynxHeightCm).toBeCloseTo(0.5);

    const anchors = buildPhonationAnchorsFromVoqsSyllables([
      { syllableId: 's1', startSmp: 0, endSmp: 12000, state: null },
      { syllableId: 's2', startSmp: 12000, endSmp: 24000, state: compoundChunk!.state },
    ]);
    expect(anchors.length).toBe(2); // entry at 12000 + automatic modal restore at 24000
    expect(anchors[0].t_smp).toBe(12000);
    expect(anchors[0].voqs?.symbol).toBe('V͈');
    expect(anchors[0].larynx_height_cm).toBeCloseTo(0.5);
    expect(anchors[1].t_smp).toBe(24000);
    expect(anchors[1].regime).toBe('modal');

    // Unrecorded JIPA harsh voice example: strips 3V! / 1V! cleanly and reports V! in skippedSymbols
    const harshExample =
      '[ˈnɔ˞məl ˈvɔɪs {3V! ˈvɛɹi ˈhɑ˞ʃ ˈvɔɪs 3V!} {L̝ 1V! ˈlɛs ˈhɑ˞ʃ ˈvɔɪs wɪð ˈɹeɪzd ˈlæɹɪŋks 1V! L̝}]';
    const harshRes = parseVoqsScopedText(harshExample);
    expect(harshRes.skippedSymbols).toEqual(['V!']);
    expect(harshRes.plainText).not.toContain('V!');
    const raisedOnlyChunk = harshRes.chunks.find((c) => c.text.includes('læɹɪŋks'));
    expect(raisedOnlyChunk?.state?.larynxHeightCm).toBeCloseTo(0.5);
    expect(raisedOnlyChunk?.state?.phonation).toBeUndefined();
  });

  it('keeps IPA brackets balanced across VoQS spans and reads Han and kana as text', () => {
    const sample = '[ˈnɔ˞məl ˈvɔɪs {F ˈvɛɹi ˈhɑ˞ʃ ˈvɔɪs F} {L̝ W ˈlɛs ˈhɑ˞ʃ ˈvɔɪs wɪð ˈɹeɪzd ˈlæɹɪŋks W L̝}]';
    const { chunks, plainText } = parseVoqsScopedText(sample);
    const read = (text: string) => reviewText(text, 'Standard Chinese (Beijing)', new Map(), new Map());
    expect(read(plainText).map((row) => row.ipa)).toEqual([
      'ˈnɔ˞məl', 'ˈvɔɪs', 'ˈvɛɹi', 'ˈhɑ˞ʃ', 'ˈvɔɪs', 'ˈlɛs', 'ˈhɑ˞ʃ', 'ˈvɔɪs', 'wɪð', 'ˈɹeɪzd', 'ˈlæɹɪŋks',
    ]);
    expect(chunks.flatMap((chunk) => read(chunk.text)).every((row) => row.language === 'ipa')).toBe(true);
    expect(chunks.find((c) => c.text.includes('ˈlɛs'))?.state).toMatchObject({
      phonation: { symbol: 'W' }, larynxHeightCm: 0.5,
    });
    const mixed = parseVoqsScopedText('［a {F你好F} {C カタカナ ひらがな C} {F {L̝ mi L̝} F} i］');
    expect(read(mixed.plainText).map((row) => row.language)).toEqual([
      'ipa', 'zh', 'zh', ...Array(8).fill('ja'), 'ipa', 'ipa',
    ]);
    expect(mixed.chunks.find((c) => c.text === '[mi]')?.state).toMatchObject({
      phonation: { symbol: 'F' }, larynxHeightCm: 0.5,
    });
  });

  it('reads quoted Chinese, English, and Japanese words inside IPA and preserves each VoQS scope', () => {
    const cmu = parseCmu('FALSETTO  F AO0 L S EH1 T OW2\nWITH  W IH1 TH\n');
    const read = (text: string) => reviewText(text, 'Standard Chinese (Beijing)', cmu, new Map());
    const input = '[a {F"falsetto"F} {C "你好" C} {W "こんにちは" W} {L̝ W “with” W L̝} {F with F} i]';
    const parsed = parseVoqsScopedText(input);
    const voicedRows = parsed.chunks.flatMap(chunk => read(chunk.text).map(row => ({ row, state: chunk.state })));
    expect(read(parsed.plainText)).toEqual(voicedRows.map(({ row }) => row));
    expect(voicedRows.map(({ row }) => row.language)).toEqual([
      'ipa',
      'en', 'en', 'en',
      'zh', 'zh',
      'ja', 'ja', 'ja', 'ja', 'ja',
      'en',
      'ipa', 'ipa',
    ]);
    expect(voicedRows[1].state?.phonation?.symbol).toBe('F');
    expect(voicedRows[4]).toMatchObject({ row: { word: '你', language: 'zh' }, state: { phonation: { symbol: 'C' } } });
    expect(voicedRows[6]).toMatchObject({ row: { language: 'ja' }, state: { phonation: { symbol: 'W' } } });
    expect(voicedRows[11]).toMatchObject({ row: { ipa: 'ˈwɪθ' }, state: { phonation: { symbol: 'W' }, larynxHeightCm: 0.5 } });
    expect(voicedRows[12].row.ipa).toBe('with');
    expect(() => parseVoqsScopedText('[a {F "falsetto F}]')).toThrow('成对的双引号');
  });

  it('marks parser-inserted boundary spaces as syntheticSpace while preserving user whitespace between VoQS scopes', () => {
    const tight = parseVoqsScopedText('[a{F b F}]');
    expect(tight.chunks.some((c) => c.syntheticSpace === true)).toBe(true);
    const spaced = parseVoqsScopedText('[a {F b F} {W c W}]');
    const midSpace = spaced.chunks.find((c) => c.text === ' ' && !c.syntheticSpace);
    expect(midSpace).toBeTruthy();
  });

  it('uses scoped register shifts for F and C, plus voiceless W and raised larynx', () => {
    const input = '[a {F a F} {C a C} {L̝ W a W L̝} a]';
    const chunks = parseVoqsScopedText(input).chunks.filter(({ text }) => text.includes('a'));
    const length = msToSamples(200);
    const syllables = chunks.map((_, i) => ({
      id: `s${i}`, text: 'a', ipa: ['a'], nucleus_index: 0,
      start_smp: i * length, end_smp: (i + 1) * length,
      anchor: { policy: 'speech_timing' as const, lead_ms: null, bias_ms: 0 },
      segments: [], targets: [], overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
    }));
    const anchors = buildPhonationAnchorsFromVoqsSyllables(syllables.map((s, i) => ({
      syllableId: s.id, startSmp: s.start_smp, endSmp: s.end_smp, state: chunks[i].state,
    })));
    const project = useWorkbenchStore().project.value;
    const baseline = evaluateControlPitch(project, syllables, 5 * length, 165, false, false, []);
    const shaped = evaluateControlPitch(project, syllables, 5 * length, 165, false, false, anchors);
    if (!baseline.ok || !shaped.ok) throw new Error('Expected a dense F0 curve');
    expect(shaped.value.f0_hz[10]).toBe(baseline.value.f0_hz[10]);
    expect(shaped.value.f0_hz[30]).toBeGreaterThan(baseline.value.f0_hz[30]);
    expect(shaped.value.f0_hz[50]).toBeLessThan(baseline.value.f0_hz[50]);
    expect(shaped.value.f0_hz[90]).toBe(baseline.value.f0_hz[90]);
    expect(anchors.find((a) => a.voqs?.symbol === 'W')).toMatchObject({
      glottis: { ra: 0 }, larynx_height_cm: 0.5,
    });
  });

  it('T-48 & T-32: models IPA stress/length/liaison and splits multi-syllable English CMUdict words via Maximal Onset', () => {
    expect(phoneTraits('iː').lengthScale).toBeCloseTo(1.65);
    expect(phoneTraits('eˑ').lengthScale).toBeCloseTo(1.3);
    expect(phoneTraits('ə̆').lengthScale).toBeCloseTo(0.65);

    const stressed = parseIpaSuprasegmentals('ˈnɔ˞');
    expect(stressed.stress).toBe(1);
    expect(stressed.durationScale).toBeCloseTo(1.25);
    expect(stressed.pressureDeltaPa).toBe(100);

    expect(arpaToIpaSyllables('M AO1 R N IH0 NG')).toEqual(['ˈmɔɹ̠ʷ', 'nɪŋ']);
    expect(arpaToIpaSyllables('B Y UW1 T AH0 F AH0 L')).toEqual(['ˈbju', 'tə', 'fəl']);

    const cmu = parseCmu('MORNING  M AO1 R N IH0 NG\nSING  S IH1 NG\n');
    const rows = reviewText('morning singing', 'Standard Chinese (Beijing)', cmu, new Map());
    expect(rows.map((r) => r.ipa)).toEqual(['ˈmɔɹ̠ʷ', 'nɪŋ', 'ˈsɪŋ', 'ɪŋ']);
  });

  it('keeps IPA overrides separate by the Chinese transcription standard', () => {
    const word = '汉';
    const beijing = 'Standard Chinese (Beijing)';
    const unt = 'UntPhesoca宽';
    const legacy = saveSyllableToUserLexicon({ word, ipaPhones: ['x', 'a', 'n'] })!;
    const beijingEntry = saveSyllableToUserLexicon({ word, standard: beijing, ipaPhones: ['h', 'a', 'n'] })!;
    const untEntry = saveSyllableToUserLexicon({ word, standard: unt, ipaPhones: ['x', 'ɑ', 'n'], toneLevels: '51' })!;
    try {
      expect(reviewText(word, unt, new Map(), buildPersonalG2pMap(unt))[0].ipa).toBe('xɑn˥˩');
      expect(buildPersonalG2pMap(beijing).get(word)?.[0]).toBe('han');
      expect(lookupUserLexiconReading({ word, language: 'zh' }, 'UntPhesoca严')).toEqual(legacy);
      expect(lookupUserLexiconReading({ word, language: 'zh' }, beijing)).toEqual(beijingEntry);
    } finally {
      for (const entry of [legacy, beijingEntry, untEntry]) removeUserLexiconEntry(entry.key);
    }
  });

  it('saves edited timeline phones for an English syllable and a literal IPA input', () => {
    const standard = 'UntPhesoca宽';
    const english = parseCmu('MORNING  M AO1 R N IH0 NG\nNING  N IH1 NG\n');
    const lyrics = 'morning ning [ka˥]';
    const readings = reviewText(lyrics, standard, english, new Map());
    const syllables = readings.map((reading, i): Syllable => ({
      id: String(i), text: reading.word, ipa: splitPhoneNotation(reading.ipa),
      start_smp: i * 4800, end_smp: (i + 1) * 4800, nucleus_index: 0,
      anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
      segments: [{ id: `p${i}`, ipa: 'a̰', role: 'nucleus', voiced: true, elastic: true, start_smp: i * 4800, end_smp: (i + 1) * 4800 }],
      tone_levels: reading.language === 'ipa' ? '35' : undefined,
      targets: [], overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
    }));
    const clip: Clip = {
      id: 'test', kind: 'phrase', start_smp: 0, end_smp: 19200,
      source: { lyrics, transcription: standard, lang: 'mixed' },
      syllable_order: syllables.map(row => row.id), syllables: Object.fromEntries(syllables.map(row => [row.id, row])),
    };
    const selection = speechLexiconSelection(clip, syllables[1], readings, standard)!;
    const raw = speechLexiconSelection(clip, syllables[3], readings, standard)!;
    expect(selection).toMatchObject({ word: 'morning', language: 'en', syllableIndex: 1, syllableCount: 2, ipaPhones: ['a̰'] });
    expect(speechLexiconSelection(clip, syllables[1], [], standard)).toMatchObject({ word: 'morning', syllableIndex: 1 });
    expect(raw).toMatchObject({ language: 'ipa', ipa: 'a̰˧˥' });
    expect(speechLexiconSelection(clip, syllables[0], readings, standard)?.ipa).toBe('ˈa̰');
    const entries = [selection, raw].map(item => saveSyllableToUserLexicon(item)!);
    try {
      const fresh = reviewText(lyrics, standard, english, buildPersonalG2pMap(standard));
      expect(fresh).toHaveLength(readings.length);
      expect(fresh.map(row => lookupUserLexiconReading(row, standard)?.ipaJoined ?? row.ipa))
        .toEqual(['ˈmɔɹ̠ʷ', 'a̰', 'ˈnɪŋ', 'a̰˧˥']);
      expect(lookupUserLexiconEntry('ka', 'en')).toBeUndefined();
    } finally {
      entries.forEach(entry => removeUserLexiconEntry(entry.key));
    }
  });

  it('T-33 & T-46: persists user lexicon entries and retimes single-syllable clips via textgrid.set_boundary', () => {
    const saved = saveSyllableToUserLexicon({
      word: '月',
      language: 'zh',
      ipaPhones: ['ɥ', 'œ'],
      toneLevels: '51',
      segmentDurationsSmp: [4800, 14400],
      preferredDurationMs: 400,
    });
    expect(saved).not.toBeNull();
    const hit = lookupUserLexiconEntry('月', 'zh');
    expect(hit?.ipaPhones).toEqual(['ɥ', 'œ']);
    expect(hit?.segmentRatios).toEqual([0.25, 0.75]);
    if (saved) removeUserLexiconEntry(saved.key);

    // T-46: whole-syllable resize on a single-syllable clip scales clip.end_smp
    const store = useWorkbenchStore();
    const clipId = store.activeClipId.value;
    store.executeCommand({
      type: 'clip.edit',
      payload: {
        clip: {
          id: clipId,
          kind: 'phrase',
          voice_id: store.activeVoiceId.value,
          start_smp: 0,
          end_smp: 14400,
          syllable_order: ['s_only'],
          syllables: {
            s_only: {
              id: 's_only',
              text: '啊',
              ipa: ['a'],
              nucleus_index: 0,
              start_smp: 0,
              end_smp: 14400,
              anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
              segments: [
                { id: 'seg_0', ipa: 'a', start_smp: 0, end_smp: 14400, role: 'nucleus', elastic: true, voiced: true },
              ],
              targets: [],
              overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
            },
          },
        },
        resetAnnotation: true,
      },
    });
    const resizeRes = store.executeCommand({
      type: 'textgrid.set_boundary',
      payload: { clip_id: clipId, syllable_id: 's_only', end_smp: 24000 },
    });
    expect(resizeRes.ok).toBe(true);
    const updatedClip = store.project.value.clips[clipId];
    expect(updatedClip.end_smp).toBe(24000);
    expect(updatedClip.syllables.s_only.end_smp).toBe(24000);
    expect(updatedClip.syllables.s_only.segments[0].end_smp).toBe(24000);

    // T-61: non-stop onset consonant (elastic: false, e.g. /ʃ̪/) stretched to 519 ms can be shortened back cleanly
    const fricClip: typeof updatedClip = {
      id: clipId,
      kind: 'phrase',
      voice_id: store.activeVoiceId.value,
      start_smp: 0,
      end_smp: msToSamples(701),
      syllable_order: ['s_shan'],
      syllables: {
        s_shan: {
          id: 's_shan',
          text: '山',
          ipa: ['ʃ̪', 'a', 'n'],
          nucleus_index: 1,
          start_smp: 0,
          end_smp: msToSamples(701),
          anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
          segments: [
            { id: 'seg_sh', ipa: 'ʃ̪', start_smp: 0, end_smp: msToSamples(519), role: 'onset', elastic: false, voiced: false },
            { id: 'seg_a', ipa: 'a', start_smp: msToSamples(519), end_smp: msToSamples(626), role: 'nucleus', elastic: true, voiced: true },
            { id: 'seg_n', ipa: 'n', start_smp: msToSamples(626), end_smp: msToSamples(701), role: 'coda', elastic: false, voiced: true },
          ],
          targets: [],
          overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
        },
      },
    };
    const shortened = retime(fricClip, {
      clip_id: clipId,
      syllable_id: 's_shan',
      segment_id: 'seg_sh',
      new_end_smp: msToSamples(95),
    });
    expect(shortened.ok).toBe(true);
    if (shortened.ok) {
      expect(shortened.value.clip.syllables.s_shan.segments[0].end_smp).toBe(msToSamples(95));
    }
  });

  it('defaults interface font to Source Han Serif and restricts synthesis phonation list to the 5 active presets', () => {
    expect(normalizeInterfaceFonts()).toEqual({
      chinese: 'noto-serif',
      latin: 'system',
      unified: true,
      fontSizePx: 12,
    });
    expect(interfaceFontStack()).toContain('"VC Noto Serif SC"');
    expect(interfaceFontStack().startsWith('"VC Noto Serif SC"')).toBe(true);
    expect(normalizeInterfaceFonts({ chinese: 'kaiti', unified: false })).toMatchObject({
      chinese: 'kaiti',
      unified: false,
    });

    const expectedLanes = ['V͈', 'V', 'V̤', 'W', 'V̥', 'V̰', 'C', 'V̰̣', 'F'];
    expect(SYNTHESIS_VOQS_PROFILES.map((p) => p.symbol)).toEqual(expectedLanes);
    expect(SYNTHESIS_VOQS_GROUPS.flatMap((g) => g.profiles.map((p) => p.symbol))).toEqual(expectedLanes);
    expect(VOQS_PROFILES.length).toBe(14);
    expect(voqsSynthesisLaneIndex('V')).toBe(1);
    expect(voqsSynthesisLaneIndex('V̥')).toBe(4);
    expect(voqsSynthesisLaneIndex('V̰')).toBe(5);
    expect(voqsSynthesisLaneIndex('C')).toBe(6);
    expect(voqsSynthesisLaneIndex('V̰̣')).toBe(7);
    expect(voqsSynthesisLaneIndex({ regime: 'creaky', voqs: { symbol: 'V̰', source_id: 'old', t_s: 0 } })).toBe(5);

    expect(resolveBrandIconVariant('#0969da', 'light')).toBe('blue');
    expect(resolveBrandIconVariant('#0969da', 'dark')).toBe('midnight');
    expect(resolveBrandIconVariant('#1d7f7a', 'light')).toBe('green');
    expect(resolveBrandIconVariant('#6f52a3', 'light')).toBe('purple');
    expect(resolveBrandIconVariant('#d9468f', 'light')).toBe('rose');
    expect(resolveBrandIconVariant('#d97706', 'light')).toBe('amber');
    expect(resolveBrandIconVariant('#eab308', 'light')).toBe('yellow');
    expect(resolveBrandIconVariant('#6b7280', 'light')).toBe('neutral');
  });
});
