import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SAMPLE_RATE_HZ,
  importPtbVocalJson,
  parseNumberedScore,
  type Clip,
  type VcProject,
} from '@vocalcut/core';
import * as phonationModule from '../packages/core-ts/src/phonation';
import {
  MAX_MIDI,
  analyzeLyrics,
  arrangementFromPitch,
  distributeScore,
  lyricRowSpans,
  noteInRange,
  noteTranspositionLimits,
  numberedNote,
  quantizeImportedBeats,
  scoreFromRows,
  scoreRowSpans,
  sourceArrangement,
} from '../src/components/studio/arranger-edit';
import { formatEventsAsNotation } from '../src/components/studio/arranger-notation-sync';
import { everlastingRegretExample } from '../src/components/studio/arranger-examples';
import { readArrangerScore, timelineOfScore } from '../src/components/studio/arranger-score';
import { compileArrangement } from '../src/components/studio/arranger-compile';
import { arrangementAudioWindows, arrangementInstrumentCues, arrangementInstrumentRegions } from '../src/components/studio/arranger-audio';
import { instruments, renderInstrumentNote } from '../src/components/studio/instrument-voices';
import { splitPhoneNotation } from '../src/data/ipa-segments';
import {
  createIpaPoseSet, deleteIpaPoseSet, duplicateActiveIpaPoseSet, getProtectedIpaPose, getSelectedIpaPoseParams,
  loadDefaultIpaPoses, RECORDED_IPA_SET_ID, selectIpaPoseSet, selectedIpaPoseSetId, setIpaPoseProtected,
} from '../src/data/ipa-pose-sets';
import { buildAnnotationSynthesis } from '../src/components/research/annotation-audio';
import { buildQuickIpaClip } from '../src/components/research/quick-ipa';
import { insertAnnotationSegment } from '../src/components/research/annotation-edit';
import { clipFromTextGrid } from '../src/data/textgrid-alignment';
import { getFullPoseForIpa } from '../src/components/research/research-utils';
import { parseWavDataDurationSmp } from '../src/data/workspace-transfer';
import { DEFAULT_TRACT_EXTRAS } from '../src/data/ptb-ipa-presets';
import { createInitialProject, useWorkbenchStore } from '../src/stores/workbench';

describe('regression fixes verification', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps all 41 bars and the instrumental interlude aligned in the supplied rendition', async () => {
    const { lyrics, score, tonic, bpm, beatsPerMeasure, notation } = everlastingRegretExample;
    expect(tonic).toBe('B2');
    expect(notation).toBe('je');
    const rows = await analyzeLyrics(lyrics, 'UntPhesoca宽', 'JD2', false);
    expect(rows).toHaveLength(112);
    expect(rows.every(row => row.ipa)).toBe(true);
    const arranged = distributeScore(score, tonic, bpm, rows, notation);
    if (!arranged.ok) throw new Error(arranged.issue.message);
    const measures = score.split('|').map(bar => bar.trim());
    expect(measures).toHaveLength(41);
    for (const [index, measure] of measures.entries()) {
      const parsed = readArrangerScore(measure, tonic, bpm, false, undefined, index >= 16 && index < 24, notation);
      if (!parsed.ok) throw new Error(`bar ${index + 1}: ${parsed.issue.message}`);
      expect(parsed.score.notes.reduce((beats, note) => beats + note.beats, 0), `bar ${index + 1}`).toBe(beatsPerMeasure);
    }
    const canonical = scoreFromRows(arranged.rows, arranged.finalRest, notation);
    const lead = 5040;
    const roll = timelineOfScore(canonical, tonic, bpm, true, lead, rows.length, notation);
    if (!roll.ok) throw new Error(roll.issue.message);
    expect(roll.notes[0]?.midi).toBe(63); // D♯4
    expect(roll.endSmp - lead).toBe(Math.round((164 + 3.41) * SAMPLE_RATE_HZ * 60 / bpm));
    const result = compileArrangement({
      ok: true, issueMsg: '', endSmp: roll.endSmp,
      voice: { rows, lyricsText: lyrics, fullScoreStr: score },
      notes: roll.notes.map(note => ({ ...note, pressurePa: 800 })),
    }, {
      clipId: 'test-song', speakerId: 'voice_lead', bpm, tonic, notation, referenceHz: 165,
      leadEnabled: true, leadMs: 75, biasMs: 0, dampingRate: 32, vibrato: true,
    });
    if (!result.clip) throw new Error(result.issue);
    expect(result.clip.syllable_order).toHaveLength(112);
    const windows = arrangementAudioWindows(result.clip);
    expect(windows).toHaveLength(2);
    expect(windows.every(window => window.endSmp - window.startSmp <= 60 * SAMPLE_RATE_HZ)).toBe(true);
    const beforeInterlude = result.clip.syllables.syl_56.end_smp;
    const afterInterlude = result.clip.syllables.syl_57.start_smp;
    expect(afterInterlude - beforeInterlude).toBeGreaterThan(22 * SAMPLE_RATE_HZ);
    expect(windows[0].coreEndSmp).toBeGreaterThan(beforeInterlude);
    expect(windows[0].coreEndSmp).toBeLessThan(afterInterlude);

    const seekSmp = result.clip.syllables.syl_2.start_smp + 173;
    const seekWindows = arrangementAudioWindows(result.clip, seekSmp);
    expect(seekWindows).toHaveLength(2);
    expect(seekWindows[0].startSmp).toBe(seekSmp);
    expect(seekWindows[0].coreEndSmp).toBe(seekWindows[1].coreStartSmp);
    expect(seekWindows[1].endSmp).toBe(result.clip.end_smp);
    expect(seekWindows.every(window => window.endSmp - window.startSmp <= 60 * SAMPLE_RATE_HZ)).toBe(true);
  });

  it('allows wide vocal and lyric-free instrumental pitch ranges while rejecting MIDI overflow', () => {
    const score = '[[1]] 0 [[2]]/ [[3]]/ ((5))';
    expect(readArrangerScore(`《[[1]]》`, 'G3', 84, false, 1, false, 'je').ok).toBe(true);
    expect(readArrangerScore(`《[[[[[[5]]]]]]》`, 'G3', 84, false, 1, false, 'je').ok).toBe(false);
    const result = distributeScore(score, 'G3', 84, [], 'je');
    if (!result.ok) throw new Error(result.issue.message);
    expect(result.rows.length).toBeGreaterThanOrEqual(3);
    expect(result.rows.every(row => row.instrumental && !row.ipa)).toBe(true);
    expect(result.rows[1].restBefore).toBe(1);
  });

  it('selects partial notes at each edge and transposes notes via unified EventNote[] -> notation sync', () => {
    const range = { startSmp: 4, endSmp: 12 };
    const selected = [[0, 4], [2, 6], [12, 14], [10, 20]].filter(([startSmp, endSmp]) => noteInRange({ startSmp, endSmp }, range));
    expect(selected).toEqual([[2, 6], [10, 20]]);
    const rows = [{ id: 'a', char: '风', ipa: 'fəŋ', choices: ['fəŋ'], score: '', restBefore: 0 }];
    const spb = Math.round((60 * SAMPLE_RATE_HZ) / 84);
    const formatted = formatEventsAsNotation(
      [
        { id: 'n1', midi: 62, startSmp: 0, endSmp: Math.round(spb * 0.5), velocity: 72, lyricId: 'a' },
        { id: 'n2', midi: 51, startSmp: Math.round(spb * 0.5), endSmp: spb, velocity: 86, lyricId: 'a' },
      ],
      rows,
      'C3',
      84,
      'je',
      0,
    );
    expect(formatted.full).toBe('《[2]/p #2/》');
    expect(noteTranspositionLimits([{ midi: 36, instrumental: true }, { midi: MAX_MIDI }]).max).toBe(0);
  });

  it('keeps explicit instrument notes and the last assigned timbre when mixing with voice', () => {
    const note = { startSmp: 0, endSmp: 48000, hz: 220, dynamic: 0, noteIndex: 0 };
    const regions = [
      { startSmp: 12000, endSmp: 36000, instrument: 'dizi' as const },
      { startSmp: 24000, endSmp: 42000, instrument: 'violin' as const },
    ];
    const notes = [note, { ...note, startSmp: 48000, endSmp: 96000, instrumental: true }];
    const cues = arrangementInstrumentCues(notes, { startSmp: 18000, endSmp: 96000 }, 'piano', regions, false);
    expect(cues.map(cue => [cue.at, cue.duration, cue.instrument])).toEqual([
      [0, .125, 'dizi'], [.125, .375, 'violin'], [.625, 1, 'piano'],
    ]);
    expect(arrangementInstrumentCues([note], { startSmp: 0, endSmp: 48000 }, 'piano')[0].duration).toBe(1);
  });

  it('uses the example interlude timbre only for its instrumental notes and honors manual overrides', () => {
    const note = { hz: 220, dynamic: 0, noteIndex: 0 };
    const notes = [
      { ...note, startSmp: 0, endSmp: 24000 },
      { ...note, startSmp: 24000, endSmp: 48000, instrumental: true },
      { ...note, startSmp: 72000, endSmp: 96000, instrumental: true },
      { ...note, startSmp: 96000, endSmp: 120000 },
    ];
    const range = { startSmp: 0, endSmp: 120000 };
    const preset = arrangementInstrumentRegions(notes, everlastingRegretExample.interludeInstrument);
    expect(preset).toEqual([{ startSmp: 24000, endSmp: 96000, instrument: 'xiao' }]);
    expect(arrangementInstrumentCues(notes, range, 'piano', preset).map(cue => cue.instrument))
      .toEqual(['piano', 'xiao', 'xiao', 'piano']);
    const overridden = arrangementInstrumentRegions(notes, everlastingRegretExample.interludeInstrument, [
      { startSmp: 72000, endSmp: 96000, instrument: 'dizi' },
    ]);
    expect(arrangementInstrumentCues(notes, range, 'piano', overridden, false).map(cue => [cue.at, cue.instrument]))
      .toEqual([[.5, 'xiao'], [1.5, 'dizi']]);
    // Interleaved vocal note between two instrumental notes must never be swallowed into one instrumental region
    const interleaved = [
      { ...note, startSmp: 0, endSmp: 24000, instrumental: true },
      { ...note, startSmp: 24000, endSmp: 48000 },
      { ...note, startSmp: 48000, endSmp: 72000, instrumental: true },
    ];
    expect(arrangementInstrumentRegions(interleaved, 'xiao')).toEqual([
      { startSmp: 0, endSmp: 24000, instrument: 'xiao' },
      { startSmp: 48000, endSmp: 72000, instrument: 'xiao' },
    ]);
  });

  it('maps playback rows to the editable score and the correct occurrence of repeated words', () => {
    const score = '@rit 《[2]/ [3]:1.5》 | 0/ 《1 - -》 | ((5))';
    const spans = scoreRowSpans(score, ['a', 'b']);
    expect([...spans.values()].map(span => score.slice(span.start, span.end))).toEqual(['《[2]/ [3]:1.5》', '《1 - -》']);
    const lyrics = '啊 Hello, hello！';
    const words = [
      { char: '啊', id: 'a' },
      ...['b', 'c', 'd', 'e'].map((id, index) => ({
        id, char: index % 2 ? 'lo' : 'Hel', sourceWord: 'hello', syllableIndex: index % 2, syllableCount: 2,
      })),
    ].map(row => ({ ...row, ipa: '', choices: [], score: '', restBefore: 0 }));
    expect([...lyricRowSpans(lyrics, words).values()].map(span => lyrics.slice(span.start, span.end)))
      .toEqual(['啊', 'Hello', 'Hello', 'hello', 'hello']);
  });

  it('generates distinct instrument timbres with audible attacks and decaying releases', () => {
    const spectra = new Set<number>();
    for (const { value } of instruments) {
      if (value === 'piano') continue;
      const samples = renderInstrumentNote(value, { hz: 330, at: 0, duration: .35, volume: 1 }, 24000, 1);
      const energy = samples.reduce((sum, value) => sum + value ** 2, 0);
      expect(energy).toBeGreaterThan(1);
      expect(samples.slice(-120).every(value => Math.abs(value) < .01)).toBe(true);
      spectra.add(Math.round(energy));
    }
    expect(spectra.size).toBeGreaterThanOrEqual(6);
  });

  it('supports JE and open-source DSL notations with clean quantization and zero legacy | noise', () => {
    const arranged = readArrangerScore('《5 -》 《3/ 5/》 0 《(6)》 《[1]》 《♯4.》 《♭7/》', 'C3', 92, false, 6, false, 'je');
    expect(arranged.ok).toBe(true);
    if (arranged.ok) {
      expect(arranged.score.notes[0].beats).toBe(2); // 5 -
      expect(arranged.score.notes[1].beats).toBe(0.5); // 3/
      expect(arranged.score.notes[2].beats).toBe(0.5); // 5/
      expect(arranged.score.notes[2].carry).toBe(true);
      expect(arranged.score.notes[3].midi).toBeNull(); // 0 rest
      expect(arranged.score.notes[5].midi).toBe(60); // [1] in C3 (48 + 12)
      expect(arranged.score.notes[6].beats).toBe(1.5); // #4.
      expect(arranged.score.notes[7].beats).toBe(0.5); // b7/
    }

    const sparks = parseNumberedScore("《5 -》 0 《(3 5)》 0 《6,》 《1'》", 'C3', 92, false, 4, { notation: 'sparks-nmn' });
    expect(sparks.ok).toBe(true);
    if (!sparks.ok) return;
    expect(sparks.score.notes[0].beats).toBe(2);
    expect(sparks.score.notes[1].midi).toBeNull();
    expect(sparks.score.notes[2].beats).toBe(0.5);
    expect(sparks.score.notes[3].beats).toBe(0.5);
    expect(sparks.score.notes[3].carry).toBe(true);

    // Retired legacy syntax without 《》 must be rejected
    expect(parseNumberedScore('(1p23)ff 5 6-', 'C3', 120, false, 3).ok).toBe(false);

    expect(numberedNote(60, 'C3', 2, 0, 'je')).toBe('[1] -');
    expect(numberedNote(60, 'C3', 2, 0, 'sparks-nmn')).toBe("1' -");
    expect(quantizeImportedBeats(0.380266667)).toBe(0.5);

    const baseClip: Clip = {
      id: 'c1',
      kind: 'phrase',
      start_smp: 0,
      end_smp: SAMPLE_RATE_HZ,
      syllable_order: ['s1'],
      syllables: {
        s1: {
          id: 's1',
          text: '春',
          ipa: ['tʂʰ', 'w', 'ə', 'n'],
          nucleus_index: 2,
          start_smp: 0,
          end_smp: 24000,
          anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
          segments: [],
          targets: [
            { id: 't1', span_id: 's1', start_smp: 1800, end_smp: 12000, voiced: true, candidates: { default: { m_st_per_s: 0, b_end_st: 2, lambda_per_s: 34, source: 'default' } } },
            { id: 't2', span_id: 's1', start_smp: 12000, end_smp: 24000, voiced: true, candidates: { score: { m_st_per_s: 0, b_end_st: 4, lambda_per_s: 34, source: 'score' } } },
          ],
          overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
        },
      },
    };
    const arr = sourceArrangement(baseClip, 'C3', 92, 165, () => 220, 'je');
    expect(arr.rows[0].score).not.toContain('|');
    expect(arr.rows[0].score).not.toMatch(/\.\d{3,}/);
    const pitchArr = arrangementFromPitch(baseClip, 'C3', 92, 165, [
      { t_smp: 5000, f0_hz: 220 },
      { t_smp: 15000, f0_hz: 261.63 },
    ], 'je');
    expect(pitchArr.rows[0].score).not.toContain('|');
    expect(readArrangerScore(pitchArr.rows[0].score, 'C3', 92, false, 1, false, 'je', true).ok).toBe(true);
  });

  it('splits plain Mandarin/English diphthongs while keeping explicit non-syllabic glides intact', () => {
    expect(splitPhoneNotation('maɪ.feɪ.xaʊ.toʊ')).toEqual(['m', 'a', 'ɪ', 'f', 'e', 'ɪ', 'x', 'a', 'ʊ', 't', 'o', 'ʊ']);
    expect(splitPhoneNotation('tʂʰʊə˧˥')).toEqual(['tʂʰ', 'ʊ', 'ə']);
    expect(splitPhoneNotation('dⁿ.l̩ k͜pʼ aɪ̯')).toEqual(['dⁿ', 'l̩', 'k͜pʼ', 'aɪ̯']);
    expect(splitPhoneNotation('[t̠͡s̟ʰa˞˧]')).toEqual(['t̠͡s̟ʰ', 'a˞']);
  });

  describe('IPA pose fallback eliminates Tract2Vox-Lite geometry extras leaks', () => {
    const fakePose = Array.from({ length: 19 }, (_, i) => i * 0.01);
    beforeEach(async () => {
      vi.stubGlobal('fetch', async (url: string) => {
        if (url === '/api/models/ipa-references/poses') {
          return new Response(
            JSON.stringify({
              poses: [
                { symbol: 'n', params: fakePose },
                { symbol: 't', params: fakePose },
                { symbol: 'v', params: fakePose },
                { symbol: 'ʋ', params: fakePose },
                { symbol: 'ʈʂʰ', params: fakePose },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(null, { status: 404 });
      });
      await loadDefaultIpaPoses();
    });

    it('resolves Japanese diacritic/length variants and Mandarin aliases cleanly with zero extras', () => {
      for (const sym of ['n̩', 'nː', 't̚', 'tː', 'tʲ', 'vʲ', 'tʂʰ', 'ʋ̩']) {
        expect(getSelectedIpaPoseParams(sym, RECORDED_IPA_SET_ID)).toEqual(fakePose);
        const full = getFullPoseForIpa(sym, undefined, 'JD2', RECORDED_IPA_SET_ID);
        expect(full.extras).toEqual(DEFAULT_TRACT_EXTRAS);
      }
      // Even an unrecorded symbol under recorded-default never leaks PTB factory tongue_shape/lip_shape
      const exotic = getFullPoseForIpa('qʷ', undefined, 'JD2', RECORDED_IPA_SET_ID);
      expect(exotic.extras).toEqual(DEFAULT_TRACT_EXTRAS);
    });
  });

  it('drops 1 ms aspirated release placeholder and emits explicit sil spans for annotation synthesis', () => {
    const project: VcProject = createInitialProject();
    const clipId = project.clip_order[0];
    const startGap = 2400; // 50 ms
    const closureEnd = startGap + 2400; // 50 ms stop closure
    const relEnd = closureEnd + 48; // 1 ms placeholder release
    const stopEnd = relEnd + 1872; // 39 ms aspiration
    const sylEnd = stopEnd + 4800; // 100 ms vowel
    const totalEnd = sylEnd + 2400; // 50 ms trailing gap

    const clip: Clip = {
      id: clipId,
      kind: 'phrase',
      voice_id: project.voice_order[0],
      start_smp: 0,
      end_smp: totalEnd,
      syllable_order: ['s1'],
      syllables: {
        s1: {
          id: 's1',
          text: '他',
          ipa: ['tʰ', 'a'],
          nucleus_index: 1,
          start_smp: startGap,
          end_smp: sylEnd,
          anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
          segments: [
            {
              id: 'seg0',
              ipa: 'tʰ',
              start_smp: startGap,
              end_smp: stopEnd,
              role: 'onset',
              elastic: false,
              voiced: false,
              stop_timing: { closure_ms: 50, release_ms: 1, aspiration_ms: 39, vot_ms: 0, auto_generated: true },
            },
            {
              id: 'seg1',
              ipa: 'a',
              start_smp: stopEnd,
              end_smp: sylEnd,
              role: 'nucleus',
              elastic: true,
              voiced: true,
            },
          ],
          targets: [
            { id: 't0', span_id: 's1', start_smp: startGap, end_smp: sylEnd, voiced: true, candidates: { default: { m_st_per_s: 0, b_end_st: 0, lambda_per_s: 34, source: 'default' } } },
          ],
          overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
        },
      },
    };

    const res = buildAnnotationSynthesis(project, clip, [], 0, totalEnd, {
      f0Hz: 165,
      tract: Array(19).fill(0),
      releaseTract: Array(19).fill(0),
      lipWidth: 1,
      larynxHeight: 0,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const spans = (res.value as { articulation_spans?: Array<{ ipa: string; phase: string }> }).articulation_spans ?? [];
    expect(spans.some((s) => s.phase === 'release')).toBe(false);
    expect(spans[0]).toMatchObject({ ipa: 'sil', phase: 'silence' });
    expect(spans.at(-1)).toMatchObject({ ipa: 'sil', phase: 'silence' });
    expect(spans.map((s) => s.phase)).toEqual(['silence', 'closure', 'aspiration', 'normal', 'silence']);

    const tract = Array.from({ length: 19 }, (_, i) => i * 0.01);
    clip.syllables.s1.segments[1].params = tract;
    const fallback = { f0Hz: 165, tract, releaseTract: tract, lipWidth: 1, larynxHeight: 0 };
    const current = buildAnnotationSynthesis(project, clip, [], 0, totalEnd, fallback, undefined, 'current');
    const model = buildAnnotationSynthesis(project, clip, [], 0, totalEnd, fallback, undefined, 'model');
    expect(current.ok && current.value).toMatchObject({
      pose_source: 'custom',
      articulation_spans: expect.arrayContaining([{ ...spans[3], pose_target_19: tract }]),
    });
    expect(model.ok && model.value).not.toHaveProperty('pose_source');
  });

  it('adds a contextual reference for a whole affricate and honors independently timed textgrid phones', () => {
    const project = createInitialProject();
    const voiceId = project.voice_order[0];
    const clip = clipFromTextGrid(null, 24000, 'context', voiceId, [
      { label: 'q', start_s: 0, end_s: 0.1 },
      { label: 'a', start_s: 0.1, end_s: 0.2 },
      { label: 'p͡ɸ', start_s: 0.2, end_s: 0.3 },
      { label: 'a', start_s: 0.3, end_s: 0.4 },
      { label: 't', start_s: 0.4, end_s: 0.45 },
      { label: 'ɬ', start_s: 0.45, end_s: 0.5 },
    ])!;
    const tract = getFullPoseForIpa('a').params19;
    const fallback = { f0Hz: 165, tract, releaseTract: tract, lipWidth: 1, larynxHeight: 0 };
    const result = buildAnnotationSynthesis(project, clip, [], 0, clip.end_smp, fallback);
    expect(result.ok && result.value).toMatchObject({
      reference_spans: [
        { ipa: 'q', start_smp: 0, end_smp: 4800, position: 'onset', right_vowel: 'a', affricate: false },
        { ipa: 'p͡ɸ', start_smp: 9600, end_smp: 14400, position: 'intervocalic', left_vowel: 'a', right_vowel: 'a', affricate: true },
        { ipa: 'ɬ', start_smp: 21600, end_smp: 24000, affricate: false },
      ],
    });
    const cropped = buildAnnotationSynthesis(project, clip, [], 12000, 14400, fallback);
    expect(cropped.ok && cropped.value).toMatchObject({
      reference_spans: [{ ipa: 'p͡ɸ', start_smp: -2400, end_smp: 2400, position: 'intervocalic' }],
    });
  });

  it('uses the nasal gesture throughout and restores voicing near the end of a devoiced nasal', () => {
    const project = createInitialProject();
    const voiceId = project.voice_order[0];
    const tract = getFullPoseForIpa('a').params19;
    const fallback = { f0Hz: 165, tract, releaseTract: tract, lipWidth: 1, larynxHeight: 0 };
    const plan = (symbol: string) => {
      const clip = buildQuickIpaClip({ symbol, nameZh: symbol, category: 'consonant' }, 'JD2', voiceId);
      const result = buildAnnotationSynthesis(project, clip, [], 0, clip.end_smp, fallback, undefined, 'current');
      if (!result.ok || !('articulation_spans' in result.value)) throw new Error('Expected a JD2 articulation plan');
      const nasal = result.value.articulation_spans[1];
      return { nasal, payload: result.value };
    };

    for (const [plain, devoiced] of [['m', 'm̥'], ['n', 'n̥'], ['ŋ', 'ŋ̊']]) {
      const voiced = plan(plain);
      const partial = plan(devoiced);
      const { start_frame: from, end_frame: to } = voiced.nasal;
      expect(partial.nasal).toEqual(voiced.nasal);
      expect(partial.payload.tract_frames.slice(from, to)).toEqual(voiced.payload.tract_frames.slice(from, to));
      expect(partial.payload.pressure_pa.slice(from, to)).toEqual(voiced.payload.pressure_pa.slice(from, to));
      expect(partial.payload.phonation_locks.slice(from, to).every(Boolean)).toBe(true);
      expect(voiced.payload.phonation_locks.slice(from, to).some(Boolean)).toBe(false);
      expect(voiced.payload.glottis_frames.slice(from, to).every(frame => frame[4] > 0)).toBe(true);
      expect(partial.payload.glottis_frames[from][4]).toBe(0);
      expect(partial.payload.glottis_frames[to - 1]).toEqual(voiced.payload.glottis_frames[to - 1]);
    }

    // Default auto-generated voiced stops stay unlocked so IPA2Tract-Lite transitions smoothly.
    for (const stop of ['b', 'd', 'ɡ']) {
      const stopPlan = plan(stop);
      expect(stopPlan.payload.phonation_locks.some(Boolean)).toBe(false);
    }
  });

  it('protects exact saved poses per scheme and takes precedence over an automatic reference', () => {
    const project = createInitialProject();
    const prior = selectedIpaPoseSetId.value;
    const baseline = getFullPoseForIpa('a').params19;
    const saved = [...baseline];
    saved[5] = 1.7;
    const setId = createIpaPoseSet('测试方案', { a: saved, 'p͡ɸ': saved })!;
    let duplicate: string | undefined;
    try {
      expect(setIpaPoseProtected('a', true)).toBe(true);
      expect(setIpaPoseProtected('pɸ', true)).toBe(true);
      expect(getProtectedIpaPose('ã')).toBeUndefined();
      expect(setIpaPoseProtected('a', true, RECORDED_IPA_SET_ID)).toBe(false);
      duplicate = duplicateActiveIpaPoseSet('测试副本');
      expect(getProtectedIpaPose('pɸ', duplicate)).toEqual(saved);
      selectIpaPoseSet(setId);
      const clip = clipFromTextGrid(null, 9600, 'protected', project.voice_order[0], [
        { label: 'pɸ', start_s: 0, end_s: 0.1 }, { label: 'a', start_s: 0.1, end_s: 0.2 },
      ])!;
      const fallback = { f0Hz: 165, tract: baseline, releaseTract: baseline, lipWidth: 1, larynxHeight: 0 };
      const build = () => {
        const result = buildAnnotationSynthesis(project, clip, [], 0, clip.end_smp, fallback, undefined, 'current');
        if (!result.ok) throw new Error(result.error.hint);
        return result.value;
      };
      expect(build()).toMatchObject({ articulation_spans: expect.arrayContaining([
        expect.objectContaining({ ipa: 'a', pose_protected: true, locked: true }),
      ]) });
      expect(build().tract_frames.slice(20)).toEqual(Array(20).fill(saved));
      expect(build()).not.toHaveProperty('reference_spans');
      expect(setIpaPoseProtected('pɸ', false)).toBe(true);
      expect(build()).toMatchObject({ reference_spans: [expect.objectContaining({ ipa: 'pɸ' })] });
      expect(getProtectedIpaPose('pɸ', duplicate)).toEqual(saved);
    } finally {
      if (duplicate) deleteIpaPoseSet(duplicate);
      deleteIpaPoseSet(setId);
      selectIpaPoseSet(prior);
    }
  });

  it('inserts a phone without moving earlier samples and keeps later annotation controls in sync', () => {
    const clip = clipFromTextGrid(null, 9600, 'speech', undefined, [
      { label: 'a', start_s: 0, end_s: 0.1 },
      { label: 'i', start_s: 0.1, end_s: 0.2 },
    ])!;
    const [first, second] = clip.syllable_order;
    clip.syllables[first].overrides.poses.push({ seg_index: 0, delta: { LD: 0.1 } });
    const result = insertAnnotationSegment(clip, first, 0, {
      id: 'inserted', ipa: 'ʃ', start_smp: 0, end_smp: 3840, role: 'onset', elastic: false, voiced: false,
    }, {
      phonation_anchors: {
        left: { id: 'left', t_smp: 0, syllable_id: first, regime: 'modal', blend: 1 },
        right: { id: 'right', t_smp: 4800, syllable_id: second, regime: 'breathy', blend: 1 },
      },
      f0_pins: [{
        id: 'pitch', start_smp: 4800, end_smp: 9600, transition_ms: 0, exit_fit_ms: 0,
        points: [{ t_smp: 6000, f0_hz: 150 }],
      }],
    });
    expect(result.clip.end_smp).toBe(13440);
    expect(result.clip.syllables[first]).toMatchObject({
      ipa: ['ʃ', 'a'], nucleus_index: 1,
      segments: [{ start_smp: 0, end_smp: 3840 }, { start_smp: 3840, end_smp: 8640 }],
      overrides: { poses: [{ seg_index: 1 }] },
    });
    expect(result.clip.syllables[second].segments[0]).toMatchObject({ start_smp: 8640, end_smp: 13440 });
    expect(result.phonation_anchors.left.t_smp).toBe(0);
    expect(result.phonation_anchors.right.t_smp).toBe(8640);
    expect(result.f0_pins[0]).toMatchObject({ start_smp: 8640, end_smp: 13440, points: [{ t_smp: 9840 }] });
    expect(clip.syllables[first].ipa).toEqual(['a']);
  });

  it('parses WAV duration across JUNK/LIST chunks and cleans legacy textgrid/phonation behaviors', () => {
    // Construct a WAV buffer: RIFF + JUNK (12 bytes body) + fmt (16 bytes, 2ch, 24000 Hz, 16-bit) + data (96000 bytes = 1.0 sec)
    const buf = new ArrayBuffer(12 + (8 + 12) + (8 + 16) + 8);
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    const putStr = (off: number, s: string) => [...s].forEach((c, i) => { bytes[off + i] = c.charCodeAt(0); });
    putStr(0, 'RIFF');
    view.setUint32(4, buf.byteLength - 8, true);
    putStr(8, 'WAVE');
    putStr(12, 'JUNK');
    view.setUint32(16, 12, true);
    putStr(32, 'fmt ');
    view.setUint32(36, 16, true);
    view.setUint16(40, 1, true);
    view.setUint16(42, 2, true); // 2 channels
    view.setUint32(44, 24000, true); // 24 kHz
    view.setUint16(52, 4, true); // blockAlign = 4
    view.setUint16(54, 16, true);
    const dataHeader = 56;
    const sampleBytes = 96000;
    const full = new Uint8Array(dataHeader + 8 + sampleBytes);
    full.set(bytes, 0);
    const fullView = new DataView(full.buffer);
    [...'data'].forEach((c, i) => { full[dataHeader + i] = c.charCodeAt(0); });
    fullView.setUint32(dataHeader + 4, sampleBytes, true);
    expect(parseWavDataDurationSmp(full, 16000)).toBe(SAMPLE_RATE_HZ); // 1.0s = 48000 smp

    const imported = importPtbVocalJson({ frames: [{ silent: true, duration: 0.15 }] });
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      const clip = imported.value.clips[imported.value.clip_order[0]];
      expect(clip.syllables[clip.syllable_order[0]].segments[0].ipa).toBe('sil');
    }
    expect('glottis10DToNativeDpaRow' in phonationModule).toBe(false);
  });

  it('consumes stream-played flag once so cached audio replays cleanly on subsequent clicks', () => {
    const store = useWorkbenchStore();
    const fakeBuffer = { duration: 1.2, sampleRate: SAMPLE_RATE_HZ, numberOfChannels: 1, length: SAMPLE_RATE_HZ } as unknown as AudioBuffer;
    expect(store.consumeStreamPlayed(fakeBuffer)).toBe(false);
    store.markStreamPlayed(fakeBuffer);
    expect(store.wasStreamPlayed(fakeBuffer)).toBe(true);
    expect(store.consumeStreamPlayed(fakeBuffer)).toBe(true);
    expect(store.wasStreamPlayed(fakeBuffer)).toBe(false);
    expect(store.consumeStreamPlayed(fakeBuffer)).toBe(false);
  });
});
