import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  combineIpaDiacritic,
  normalizedPhone,
  phoneTraits,
  splitPhoneNotation,
  usesTrialReferenceTrajectory,
  writtenToneLevels,
} from '../src/data/ipa-segments';
import { speechDurationScale, speechPhoneDurations, speechStopTiming } from '../src/data/speech-timing';
import {
  applyJd2DiacriticModifiers,
  preloadPtbIpaPresets,
  resolvePtbIpaPose,
} from '../src/data/ptb-ipa-presets';
import { mixedSpeechTokens, planReading, speechTokens } from '@vocalcut/g2p';
import { msToSamples } from '@vocalcut/core';
import { useWorkbenchStore } from '../src/stores/workbench';
import { buildAnnotationSynthesis } from '../src/components/research/annotation-audio';
import { buildSegmentsForSyllable } from '../src/components/research/research-utils';

describe('narrow IPA from user dictionaries', () => {
  it('retains the interval scope of combining marks, tie bars and release letters', () => {
    expect(splitPhoneNotation('[t̠͡s̟ʰa˞˧]')).toEqual(['t̠͡s̟ʰ', 'a˞']);
    expect(splitPhoneNotation('dⁿ.l̩ k͜pʼ aɪ̯')).toEqual(['dⁿ', 'l̩', 'k͜pʼ', 'aɪ̯']);
    expect(splitPhoneNotation('pʲa.tˤa')).toEqual(['pʲ','a','tˤ','a']);
    expect(normalizedPhone('ã')).toBe(normalizedPhone('ã'));
    expect(normalizedPhone('ɚ')).toBe(normalizedPhone('ə˞'));
    expect(normalizedPhone('ŋ̊')).toBe(normalizedPhone('ŋ̥'));
    expect(phoneTraits('ç')).toMatchObject({base:'ç', stop:false, voiced:false});
    expect(phoneTraits('n̍')).toMatchObject({syllabic:true});
    expect(phoneTraits('d̥')).toMatchObject({stop:true, voiced:false});
  });
  it('prefers known affricates within a span and honors written segment boundaries', () => {
    expect(splitPhoneNotation('[apɸa t̪͡s̪ʰa aɡɣa]')).toEqual(['a', 'pɸ', 'a', 't̪͡s̪ʰ', 'a', 'a', 'ɡɣ', 'a']);
    expect(splitPhoneNotation('p.ɸa t ɬa tka')).toEqual(['p', 'ɸ', 'a', 't', 'ɬ', 'a', 't', 'k', 'a']);
    expect(splitPhoneNotation('t̪s̪ʰ ȶɕ t̚s')).toEqual(['t̪s̪ʰ', 'ȶɕ', 't̚', 's']);
    expect(phoneTraits('ȶɕ')).toMatchObject({ stop: true, voiced: false });
  });
  it('limits automatic protection to selected rare stops, voiceless affricates and laterals', () => {
    expect(['q', 'p͡ɸ', 'tɬ', 'qχʰ', 'ɬ', 'ʎ'].every(usesTrialReferenceTrajectory)).toBe(true);
    expect(['p', 'tʃ', 'l', 'ɸ', 'β', 'ɮ', 'ʙ', 'ʀ̥', 'ʟ', 'bβ', 'dɮ'].some(usesTrialReferenceTrajectory)).toBe(false);
    expect(splitPhoneNotation('abβadɮa')).toEqual(['a', 'bβ', 'a', 'dɮ', 'a']);
  });
  it('reads written pitch independent of tongue height and place', () => {
    expect(writtenToneLevels('[ẽ́]')).toBe('4');
    expect(writtenToneLevels('[e̞˨˩˦]')).toBe('214');
    expect(writtenToneLevels('e̝')).toBeUndefined();
    expect(writtenToneLevels('a᷈')).toBe('342');
  });
});

describe('rule-based IPA speech timing', () => {
  it('distinguishes manner, voicing, aspiration, context and vowel length', () => {
    const [p, b, ph, ts, dz, tsh, s, m, voicelessM, a, i, schwa, longA] =
      ['p', 'b', 'pʰ', 'ts', 'dz', 'tsʰ', 's', 'm', 'm̥', 'a', 'i', 'ə', 'aː']
        .map(phone => speechPhoneDurations([phone])[0]);
    expect(p).toBeLessThan(35);
    expect(ts).toBeLessThan(s / 3);
    expect(b).toBeGreaterThan(p);
    expect(dz).toBeGreaterThan(ts);
    expect(ph).toBeGreaterThan(b);
    expect(tsh).toBeGreaterThan(s * 0.75);
    expect(voicelessM).toBe(m);
    expect(s).toBeGreaterThan(m);
    expect(longA).toBeCloseTo(a * 1.65);
    expect(a).toBeGreaterThan(i);
    expect(i).toBeGreaterThan(schwa);
    expect(speechPhoneDurations(['p'], 'a', 'a')[0]).toBeGreaterThan(p);
  });

  it.each(Object.keys(speechDurationScale) as Array<keyof typeof speechDurationScale>)(
    'allocates a legal closure, release and VOT at %s speed',
    rate => {
      const phones = ['p', 'ts', 'b', 'dz', 'pʰ', 'tsʰ'];
      const timings = phones.map(phone => {
        const duration = Math.round(speechPhoneDurations([phone])[0] * speechDurationScale[rate]);
        const timing = speechStopTiming(phone, duration);
        expect(timing.closure_ms).toBeGreaterThanOrEqual(10);
        expect(timing.release_ms).toBeGreaterThanOrEqual(1);
        expect(timing.closure_ms + timing.release_ms + timing.aspiration_ms).toBe(duration);
        return timing;
      });
      expect(timings[2].vot_ms).toBeLessThan(0);
      expect(timings[3].vot_ms).toBeLessThan(0);
      expect(timings[4].aspiration_ms).toBeGreaterThan(timings[0].release_ms);
      expect(timings[5].aspiration_ms).toBeGreaterThan(timings[1].release_ms);
    },
  );
});

describe('JD2 conditioned posture', () => {
  beforeAll(async () => {
    vi.stubGlobal('fetch', async (url:string) => new Response(readFileSync('public'+url,'utf8'), { headers: { 'Content-Type':'application/json' } }));
    expect(await preloadPtbIpaPresets('JD2')).toBe(true);
  });
  afterAll(() => vi.unstubAllGlobals());
  it('plans oral release only for the eligible lateral near the following phone', () => {
    const store = useWorkbenchStore();
    const neutral = resolvePtbIpaPose('ə').params19;
    const plan = (text: string, poseSource: 'current' | 'model' = 'current') => {
      const ipa = splitPhoneNotation(text);
      const endSmp = msToSamples(110 * ipa.length);
      const segments = buildSegmentsForSyllable('s0', ipa, 0, endSmp);
      const result = buildAnnotationSynthesis(store.project.value, {
        id: 'lateral', kind: 'phrase', voice_id: store.activeVoiceId.value,
        start_smp: 0, end_smp: endSmp, syllable_order: ['s0'], syllables: {
          s0: {
            id: 's0', text, ipa, nucleus_index: 0, segments, start_smp: 0, end_smp: endSmp,
            anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 }, targets: [],
            overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
          },
        },
      }, [], 0, endSmp, { f0Hz: 130, tract: neutral, releaseTract: neutral, lipWidth: 1, larynxHeight: 0 },
      undefined, poseSource);
      if (!result.ok || !('articulation_spans' in result.value)) throw new Error(`No articulation spans for ${text}`);
      return { ...result.value, segments };
    };

    for (const [ipa, expected] of [
      ['[la]', 'l:release'], ['[lja]', 'l:release'], ['[lwa]', 'l:release'],
      ['[lla]', 'l:hold l:release'], ['[llja]', 'l:hold l:release'],
      ['[all]', 'l:hold l:hold'], ['[allt]', 'l:hold l:hold'],
      ['[l]', 'l:hold'], ['[al]', 'l:hold'], ['[alt]', 'l:hold'],
      ['[al.a]', 'l:hold'], ['[al a]', 'l:hold'], ['[a.la]', 'l:release'],
      ['[l̩a]', 'l̩:hold'], ['[l̪a ʎj ɭt ʟ]', 'l̪:release ʎ:release ɭ:hold ʟ:hold'],
      ['[aɬaɫa]', ''],
    ]) {
      const { articulation_spans } = plan(ipa);
      expect(articulation_spans.flatMap(span => span.lateral_ending ? [`${span.ipa}:${span.lateral_ending}`] : [])
        .join(' '), ipa).toBe(expected);
    }

    const { articulation_spans, tract_frames, segments } = plan('[lla]', 'model');
    const [first, second, vowel] = articulation_spans;
    expect(first.phase).toBe('normal');
    expect(second.phase).toBe('normal');
    expect(tract_frames[first.end_frame - 1]).toEqual(tract_frames[second.start_frame]);
    expect(tract_frames[first.end_frame - 1][11]).toBe(segments[0].params![11]);
    const endOfRelease = tract_frames[second.end_frame - 1][11];
    const nextTty = segments[2].params![11];
    expect(Math.abs(endOfRelease - nextTty)).toBeLessThan(0.3 * Math.abs(segments[1].params![11] - nextTty));
    expect(tract_frames[vowel.start_frame]).toEqual(segments[2].params);
  });

  it('changes the vowel constriction and preserves larynx height for lowering', () => {
    const e=resolvePtbIpaPose('e').params;
    const lowered=resolvePtbIpaPose('e̞').params;
    expect(lowered.TCY).toBeLessThan(e.TCY);
    expect(lowered.HY).toBe(e.HY);
    expect(resolvePtbIpaPose('β̞').isFallback).toBe(false);
    expect(resolvePtbIpaPose('ã').params).toEqual(resolvePtbIpaPose('ã').params);
    expect(resolvePtbIpaPose('ã').params.VO).toBeGreaterThan(resolvePtbIpaPose('a').params.VO);
  });

  it('strips dotted-circle placeholders and never spawns phantom rounded vowels', () => {
    expect(splitPhoneNotation('a◌̹')).toEqual(['a̹']);
    expect(splitPhoneNotation('t◌ʷa')).toEqual(['tʷ', 'a']);
    expect(splitPhoneNotation('p◌ʷ')).toEqual(['pʷ']);
    expect(splitPhoneNotation('i◌̹')).toEqual(['i̹']);
    expect(splitPhoneNotation('d◌̚')).toEqual(['d̚']);
    expect(splitPhoneNotation('t̠͡s̟◌ʰ')).toEqual(['t̠͡s̟ʰ']);
    expect(splitPhoneNotation('a◌̹◌̃')).toEqual(['ã̹']);
    expect(splitPhoneNotation('aɪ◌̯')).toEqual(['aɪ̯']);
    expect(splitPhoneNotation('t◌̪s◌̪')).toEqual(['t̪s̪']);
    expect(splitPhoneNotation('◌̹')).toEqual([]);
    expect(splitPhoneNotation('a ◌̹')).toEqual(['a']);

    expect(speechTokens('[a◌̹]')).toEqual(['[a̹]']);
    expect(speechTokens('[a ◌̹]')).toEqual(['[a̹]']);
    expect(speechTokens('[t◌ʷa]')).toEqual(['[tʷa]']);
    expect(mixedSpeechTokens('a◌̹')).toEqual(['[a̹]']);

    expect(resolvePtbIpaPose('a◌̹').params).toEqual(resolvePtbIpaPose('a̹').params);
  });

  it('combines standalone diacritics onto existing phonemes without destroying the base', () => {
    expect(combineIpaDiacritic('a', '◌̹')).toBe('a̹');
    expect(combineIpaDiacritic('a̹', '̹')).toBe('a̹');
    expect(combineIpaDiacritic('ɔ̜', '◌̹')).toBe('ɔ̹');
    expect(combineIpaDiacritic('t', '◌ʷ')).toBe('tʷ');
    expect(combineIpaDiacritic('d̥', '◌̬')).toBe('d̬');
    expect(combineIpaDiacritic('ŋ̊', '◌̬')).toBe('ŋ̬');
    expect(combineIpaDiacritic('ŋ̊', '◌̥')).toBe('ŋ̊');
    expect(combineIpaDiacritic('n̩', '◌̯')).toBe('n̯');
    expect(combineIpaDiacritic('e̝', '◌̞')).toBe('e̞');
    expect(combineIpaDiacritic('u̟', '◌̠')).toBe('u̠');
    expect(combineIpaDiacritic('a̤', '◌̰')).toBe('a̰');
    expect(combineIpaDiacritic('dʰ', '◌̚')).toBe('d̚');
    expect(combineIpaDiacritic('dⁿ', '◌ˡ')).toBe('dˡ');
  });

  it('parses all voicing, phonation, nasalization, syllabicity and release traits cleanly', () => {
    expect(phoneTraits('s̬')).toMatchObject({ base: 's', voiced: true });
    expect(phoneTraits('d̥')).toMatchObject({ base: 'd', voiced: false });
    expect(phoneTraits('ŋ̊')).toMatchObject({ base: 'ŋ', voiced: false });
    // Conflicting voiceless+voiced falls back to base voicing
    expect(phoneTraits('d̥̬')).toMatchObject({ base: 'd', voiced: true });
    expect(phoneTraits('s̥̬')).toMatchObject({ base: 's', voiced: false });

    expect(phoneTraits('a̤')).toMatchObject({ base: 'a', breathy: true, creaky: false });
    expect(phoneTraits('b̤')).toMatchObject({ base: 'b', stop: true, breathy: true });
    expect(phoneTraits('a̰')).toMatchObject({ base: 'a', creaky: true, breathy: false });
    expect(phoneTraits('a̤̰')).toMatchObject({ breathy: false, creaky: false });

    expect(phoneTraits('ã')).toMatchObject({ base: 'a', nasalized: true });
    expect(phoneTraits('d̚')).toMatchObject({ base: 'd', unreleased: true, releaseMode: 'unreleased' });
    expect(phoneTraits('dⁿ')).toMatchObject({ base: 'd', nasalRelease: true, releaseMode: 'nasal' });
    expect(phoneTraits('dˡ')).toMatchObject({ base: 'd', lateralRelease: true, releaseMode: 'lateral' });
    expect(phoneTraits('dⁿˡ')).toMatchObject({ releaseMode: 'oral' });
    expect(phoneTraits('n̩')).toMatchObject({ syllabic: true, nonSyllabic: false });
    expect(phoneTraits('i̯')).toMatchObject({ syllabic: false, nonSyllabic: true });
    expect(phoneTraits('n̩̯')).toMatchObject({ syllabic: false, nonSyllabic: false });
    expect(phoneTraits('e˔')).toMatchObject({ base: 'e', vowel: true });
  });

  it('preserves all IPA 2020 diacritics in g2p planReading without dropping them', () => {
    const catalog = ['a', 'ɔ', 't', 'e', 'd', 's', 'l', 'n', 'i', 'p', 'k', 'ə'];
    const cases = ['a̹', 'ɔ̜', 'tʷ', 'ë', 'd̥', 's̬', 'a̤', 'a̰', 'l̴', 't̼', 'd̚', 'dⁿ', 'dˡ', 'n̩', 'i̯'];
    for (const ipa of cases) {
      const plan = planReading(
        { word: `[${ipa}]`, ipa, choices: [ipa], pause: 0, language: 'ipa' },
        catalog,
      );
      expect(plan.missing, `missing for ${ipa}`).toEqual([]);
      expect(plan.units, `unit count for ${ipa}`).toHaveLength(1);
      expect(normalizedPhone(plan.units[0].symbol), `symbol for ${ipa}`).toBe(normalizedPhone(ipa));
    }
    const dotted = planReading(
      { word: '[a◌̹]', ipa: 'a◌̹', choices: ['a◌̹'], pause: 0, language: 'ipa' },
      catalog,
    );
    expect(dotted.missing).toEqual([]);
    expect(dotted.units.map((u) => u.symbol)).toEqual(['a̹']);
  });

  it('applies Place x Manner conditioned modifiers across contrasting base classes safely', () => {
    // 1. Unrounded vowel (a, ᴀ) vs rounded vowel (ɔ, u)
    const a = resolvePtbIpaPose('a').params;
    const aRound = resolvePtbIpaPose('a̹').params;
    expect(aRound.LP).toBeGreaterThan(a.LP);
    expect(aRound.LD).toBeLessThan(a.LD);
    expect(aRound.LD).toBeGreaterThanOrEqual(0.20);

    const centralA = resolvePtbIpaPose('ᴀ').params;
    const centralARound = resolvePtbIpaPose('ᴀ̹').params;
    expect(centralARound.LP).toBeGreaterThan(centralA.LP + 0.40);
    expect(centralARound.LD).toBeLessThan(centralA.LD - 0.40);
    expect(centralARound.LD).toBeGreaterThanOrEqual(0.28);

    const oOpen = resolvePtbIpaPose('ɔ').params;
    const oMore = resolvePtbIpaPose('ɔ̹').params;
    const oLess = resolvePtbIpaPose('ɔ̜').params;
    expect(oMore.LP).toBeGreaterThan(oOpen.LP);
    expect(oLess.LP).toBeLessThan(oOpen.LP);
    expect(oLess.LD).toBeGreaterThan(oOpen.LD);

    const uMore = resolvePtbIpaPose('u̹').params;
    expect(uMore.LD).toBeGreaterThanOrEqual(0.20);

    // 2. Bilabial stop (p, b): unrounding & labialization NEVER break bilabial seal
    const p = resolvePtbIpaPose('p').params;
    const pLess = resolvePtbIpaPose('p̜').params;
    const pLab = resolvePtbIpaPose('pʷ').params;
    expect(pLess.LP).toBeLessThan(p.LP);
    expect(pLess.LD).toBeLessThanOrEqual(-0.15);
    expect(pLab.LP).toBeGreaterThan(p.LP);
    expect(pLab.LD).toBeLessThanOrEqual(-0.15);

    const bLess = resolvePtbIpaPose('b̜').params;
    expect(bLess.LD).toBeLessThanOrEqual(-0.15);

    // 3. Alveolar fricative (s), alveolar stop (t), velar stop (k): labialization NEVER seals lips (LD >= 0.24)
    for (const cons of ['s', 't', 'k']) {
      const base = resolvePtbIpaPose(cons).params;
      const lab = resolvePtbIpaPose(`${cons}ʷ`).params;
      expect(lab.LP, `${cons}ʷ LP`).toBeGreaterThan(base.LP);
      expect(lab.LD, `${cons}ʷ LD floor`).toBeGreaterThanOrEqual(0.24);
    }

    // 4. Lateral velarization/darkening (l̴, lˠ)
    const l = resolvePtbIpaPose('l').params;
    const darkL = resolvePtbIpaPose('l̴').params;
    expect(darkL.TCX).toBeLessThan(l.TCX);
    expect(darkL.TCY).toBeGreaterThan(l.TCY);
    expect(darkL.HX).toBeLessThan(l.HX);

    // 5. Multi-char affricates (tʃʷ, tsʷ, tɕʷ) receive labialization without sealing lips
    const baseAffr = resolvePtbIpaPose('t').params19;
    const tsLab = applyJd2DiacriticModifiers('tsʷ', baseAffr);
    expect(tsLab[4]).toBeGreaterThan(baseAffr[4]);
    expect(tsLab[5]).toBeGreaterThanOrEqual(0.24);

    // 6. Conflicting diacritic pairs cancel cleanly back to base
    expect(applyJd2DiacriticModifiers('a̟̠', resolvePtbIpaPose('a').params19)).toEqual(resolvePtbIpaPose('a').params19);
    expect(applyJd2DiacriticModifiers('ɔ̹̜', resolvePtbIpaPose('ɔ').params19)).toEqual(resolvePtbIpaPose('ɔ').params19);
    expect(applyJd2DiacriticModifiers('e̝̞', resolvePtbIpaPose('e').params19)).toEqual(resolvePtbIpaPose('e').params19);
  });

  it('propagates breathy (◌̤) and creaky (◌̰) segment diacritics in annotation synthesis when VoQS is unpinned', () => {
    const store = useWorkbenchStore();
    const project = store.project.value;
    const endSmp = msToSamples(240);
    const makeClip = (ipa: string) => ({
      id: 'c_diac',
      kind: 'phrase' as const,
      voice_id: store.activeVoiceId.value,
      start_smp: 0,
      end_smp: endSmp,
      syllable_order: ['s0'],
      syllables: {
        s0: {
          id: 's0',
          text: ipa,
          ipa: [ipa],
          nucleus_index: 0,
          start_smp: 0,
          end_smp: endSmp,
          anchor: { policy: 'speech_timing' as const, lead_ms: null, bias_ms: 0 },
          segments: [
            {
              id: 'seg_0',
              ipa,
              start_smp: 0,
              end_smp: endSmp,
              role: 'nucleus' as const,
              elastic: true,
              voiced: true,
              params: resolvePtbIpaPose('a').params19,
            },
          ],
          targets: [],
          overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
        },
      },
    });
    const fallback = {
      f0Hz: 140,
      tract: resolvePtbIpaPose('a').params19,
      releaseTract: resolvePtbIpaPose('ə').params19,
      lipWidth: 1,
      larynxHeight: 0,
    };

    const breathy = buildAnnotationSynthesis(project, makeClip('a̤'), [], 0, endSmp, fallback);
    expect(breathy.ok).toBe(true);
    if (breathy.ok && 'articulation_spans' in breathy.value) {
      expect(breathy.value.articulation_spans[0].phonation).toBe('breathy');
      expect(breathy.value.glottis_frames[10][0]).toBeGreaterThanOrEqual(0.085);
      expect(breathy.value.glottis_frames[10][2]).toBeGreaterThanOrEqual(0.105);
    }

    const creaky = buildAnnotationSynthesis(project, makeClip('a̰'), [], 0, endSmp, fallback);
    expect(creaky.ok).toBe(true);
    if (creaky.ok && 'articulation_spans' in creaky.value) {
      expect(creaky.value.articulation_spans[0].phonation).toBe('creaky');
      expect(creaky.value.glottis_frames[10][0]).toBeLessThanOrEqual(0.005);
      expect(creaky.value.glottis_frames[10][3]).toBeGreaterThanOrEqual(2.2);
    }
  });
});
