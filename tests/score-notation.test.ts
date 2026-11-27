import { describe, expect, it } from 'vitest';
import {
  SAMPLE_RATE_HZ,
  SCORE_NOTATIONS,
  VTL_F0_LIMIT_HZ,
  formatPitchInNotation,
  formatSingleNoteInNotation,
  parseNumberedScore,
  parseScoreNotation,
  scoreSyllableSpans,
  wrapRawScoreAsSyllables,
  type ScoreNotationId,
} from '@vocalcut/core';
import {
  deepCloneVoiceDraftFields,
  formatEventsAsNotation,
  parseScoreToEvents,
  replaceSyllableEventsFromCell,
  scaleInstrumentRegionsByFactor,
  scalePitchPinsByFactor,
} from '../src/components/studio/arranger-notation-sync';
import type { LyricRow } from '../src/components/studio/arranger-edit';
import type { EventNote } from '../src/components/studio/midi-score';

const makeRows = (chars: string[]): LyricRow[] => chars.map((ch, idx) => ({
  id: `r_${idx}`,
  char: ch,
  ipa: 'a',
  choices: ['a'],
  score: '',
  restBefore: 0,
}));

describe('Multi-notation numbered score engine (JE + 4 open-source DSLs)', () => {
  it('registers JE plus 4 open-source Jianpu DSLs with complete cheatsheets', () => {
    expect(SCORE_NOTATIONS.map((n) => n.id)).toEqual([
      'je',
      'sparks-nmn',
      'jianpu-ly',
      'jianpu-player',
      'fanqie',
    ]);
    for (const meta of SCORE_NOTATIONS) {
      expect(meta.cheatsheet.length).toBeGreaterThanOrEqual(4);
      const parsed = parseScoreNotation(meta.example, 'B2', 84, true, 7, { notation: meta.id });
      expect(parsed.ok, `${meta.id} example`).toBe(true);
      const parsedInline = parseScoreNotation(meta.inlineExample, 'B2', 84, true, 4, { notation: meta.id });
      expect(parsedInline.ok, `${meta.id} inlineExample`).toBe(true);
      if (parsedInline.ok) {
        expect(parsedInline.inlineLyrics).toEqual(['汉', '皇', '重', '色']);
      }
    }
  });

  it('preserves native (), [], {} in every notation and binds syllables strictly via 《...》 / 〈...〉', () => {
    // 1. JE: () low octave, [] high octave, {} legacy double-low compat (in C4/G3 where {5} or (5) is valid)
    const je = parseScoreNotation('《(5)》 《5》 《[1]》 〈[3]/ [2]/〉', 'C3', 90, false, 4, { notation: 'je' });
    expect(je.ok).toBe(true);
    if (je.ok) {
      expect(je.score.notes.map((n) => n.midi)).toEqual([43, 55, 60, 64, 62]);
      expect(je.score.notes[4].carry).toBe(true);
    }
    const jeDoubleLow = parseScoreNotation('《{5}》', 'G3', 90, false, 1, { notation: 'je', midiRange: [21, 108] });
    expect(jeDoubleLow.ok).toBe(true);
    if (jeDoubleLow.ok) {
      expect(jeDoubleLow.score.notes[0].midi).toBe(55 + 7 - 24);
    }

    // 2. Sparks NMN: {<...>} barline attr, N: header, (...) halving group
    const sparks = parseScoreNotation("N: 《(3' 2')》 {<double>}| 《1' -》", 'B2', 84, false, 2, { notation: 'sparks-nmn' });
    expect(sparks.ok).toBe(true);
    if (sparks.ok) {
      expect(sparks.score.notes.map((n) => [n.midi, n.beats])).toEqual([
        [63, 0.5],
        [61, 0.5],
        [59, 2],
      ]);
    }

    // 3. jianpu-ly: q/s/d prefixes, ~ tie, 3[...] tuplet, R{...} repeat block
    const ly = parseScoreNotation("《q3' q2'》 《1' ~ q1'》 | R{ 《q5》 《q6》 }", 'B2', 84, false, 4, { notation: 'jianpu-ly' });
    expect(ly.ok).toBe(true);
    if (ly.ok) {
      expect(ly.score.notes.map((n) => [n.midi, n.beats])).toEqual([
        [63, 0.5],
        [61, 0.5],
        [59, 1.5],
        [54, 0.5],
        [56, 0.5],
      ]);
    }
    const lyTuplet = parseScoreNotation('《3[ q1 q2 q3 ]》', 'C3', 90, false, 1, { notation: 'jianpu-ly' });
    expect(lyTuplet.ok).toBe(true);
    if (lyTuplet.ok) {
      expect(lyTuplet.totalBeats).toBeCloseTo(1, 5);
      expect(lyTuplet.score.notes).toHaveLength(3);
    }

    // 4. jianpu-player: prefix '/. octaves, (1 2)_ shared beam, [1 3 5] chord, {a;b} polyphony
    const jp = parseScoreNotation("《('3 '2)_》 | ['1 3 5] { 1 2 ; .5 - }", 'C3', 90, false, undefined, { notation: 'jianpu-player' });
    expect(jp.ok).toBe(true);
    if (jp.ok) {
      const chordNotes = jp.score.notes.filter((n) => n.instrumental && n.startBeat === 1);
      expect(chordNotes.map((n) => n.midi)).toEqual([60, 52, 55]);
      const polyVoiceA = jp.score.notes.filter((n) => n.startBeat === 2);
      expect(polyVoiceA.map((n) => n.midi)).toEqual([48, 43]); // 1 (48) and .5 (43) simultaneously at beat 2
    }

    // 5. 番茄简谱 (.jps): Q: line, &ff dynamic, trailing {...} JSON config stripped
    const fanqie = parseScoreNotation(
      "B: 测试曲\nQ: 《3'/ 2'/》&ff 《1'-》\n{\"page\":\"A4\",\"font\":14}",
      'B2',
      84,
      false,
      2,
      { notation: 'fanqie' },
    );
    expect(fanqie.ok).toBe(true);
    if (fanqie.ok) {
      expect(fanqie.score.notes.map((n) => [n.midi, n.beats, n.dynamic])).toEqual([
        [63, 0.5, 2],
        [61, 0.5, 2],
        [59, 2, undefined],
      ]);
    }
  });

  it('completely rejects retired legacy syntax and MIDI overflow while allowing wide vocal pitches', () => {
    // Legacy +/- octave syntax & unwrapped vocal syntax must fail
    expect(parseNumberedScore('(1p23)ff 5 6-', 'C3', 120, false, 3).ok).toBe(false);
    expect(parseNumberedScore('《1+》', 'C3', 120, false, 1, { notation: 'je' }).ok).toBe(false);
    expect(parseNumberedScore('《1_》', 'C3', 120, false, 1, { notation: 'je' }).ok).toBe(false);

    // Wide vocal pitches (> 600 Hz and < 60 Hz) are allowed without 60..600 clamping
    const wideHigh = parseNumberedScore('《[[5]]》', 'G3', 100, false, 1, { notation: 'je' });
    expect(wideHigh.ok).toBe(true);
    const wideLow = parseNumberedScore('《((1))》', 'C2', 100, false, 1, { notation: 'je' });
    expect(wideLow.ok).toBe(true);

    // Beyond MIDI 0..127 (or explicit midiRange) is still rejected without silent clamping
    const midiOverflow = parseNumberedScore('《[[[[[[5]]]]]]》', 'G3', 100, false, 1, { notation: 'je' });
    expect(midiOverflow.ok).toBe(false);
    if (!midiOverflow.ok) expect(midiOverflow.issue.key).toBe('song_range');

    const rangeClipped = parseScoreNotation('[[5]]', 'G3', 100, false, undefined, {
      notation: 'je',
      instrumental: true,
      midiRange: [48, 72],
    });
    expect(rangeClipped.ok).toBe(false);
    if (!rangeClipped.ok) expect(rangeClipped.issue.key).toBe('song_range');

    const instHigh = parseScoreNotation('[[5]]', 'G3', 100, false, undefined, {
      notation: 'je',
      instrumental: true,
      midiRange: [21, 108],
    });
    expect(instHigh.ok).toBe(true);
    expect(VTL_F0_LIMIT_HZ).toEqual({ min: 40, max: 600, unit: 'Hz' });
  });

  it('round-trips unified EventNote[] <-> every supported notation identically', () => {
    const leadingSmp = 5040;
    const bpm = 96;
    const spb = (60 * SAMPLE_RATE_HZ) / bpm;
    const rows = makeRows(['春', '晓', '眠']);
    const events: EventNote[] = [
      { id: 'e1', midi: 60, startSmp: leadingSmp, endSmp: leadingSmp + Math.round(0.5 * spb), velocity: 86, lyricId: 'r_0' },
      { id: 'e2', midi: 62, startSmp: leadingSmp + Math.round(0.5 * spb), endSmp: leadingSmp + Math.round(1 * spb), velocity: 86, lyricId: 'r_0' },
      // 0.5-beat rest before r_1
      { id: 'e3', midi: 64, startSmp: leadingSmp + Math.round(1.5 * spb), endSmp: leadingSmp + Math.round(3.5 * spb), velocity: 100, lyricId: 'r_1' },
      { id: 'e4', midi: 57, startSmp: leadingSmp + Math.round(3.5 * spb), endSmp: leadingSmp + Math.round(4.5 * spb), velocity: 72, lyricId: 'r_2' },
    ];

    const allNotations: ScoreNotationId[] = ['je', 'sparks-nmn', 'jianpu-ly', 'jianpu-player', 'fanqie'];
    for (const notation of allNotations) {
      const formatted = formatEventsAsNotation(events, rows, 'C3', bpm, notation, leadingSmp);
      expect(formatted.rowScores.size).toBe(3);
      expect(scoreSyllableSpans(formatted.full)).toHaveLength(3);
      expect(formatted.inlineFull).toContain('春《');
      expect(formatted.inlineFull).toContain('晓《');
      expect(formatted.inlineFull).toContain('眠《');

      const parsed = parseScoreToEvents(formatted.full, rows, 'C3', bpm, notation, leadingSmp);
      expect(parsed.ok, `roundtrip ${notation}: ${formatted.full}`).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.events.map((e) => e.midi)).toEqual(events.map((e) => e.midi));
      expect(parsed.events.map((e) => e.lyricId)).toEqual(events.map((e) => e.lyricId));
      for (let i = 0; i < events.length; i++) {
        expect(Math.abs(parsed.events[i].startSmp - events[i].startSmp)).toBeLessThanOrEqual(4);
        expect(Math.abs(parsed.events[i].endSmp - events[i].endSmp)).toBeLessThanOrEqual(4);
      }
    }
  });

  it('supports wrapRawScoreAsSyllables, cell editing, deep-cloning, and BPM scaling helpers', () => {
    const wrapped = wrapRawScoreAsSyllables('[1]/ [2]/ [3] 0 6', 'C3', 90, 'je', ['风', '起', '云', '涌']);
    expect(wrapped.ok).toBe(true);
    if (wrapped.ok) {
      expect(wrapped.count).toBe(4);
      expect(wrapped.score).toBe('风《[1]/》 起《[2]/》 云《[3]》 0 涌《6》');
    }

    const rows = makeRows(['啊', '哦']);
    const initial: EventNote[] = [
      { id: 'e1', midi: 55, startSmp: 5040, endSmp: 29040, velocity: 86, lyricId: 'r_0' },
      { id: 'e2', midi: 57, startSmp: 29040, endSmp: 53040, velocity: 86, lyricId: 'r_1' },
    ];
    const edited = replaceSyllableEventsFromCell(initial, rows[0], '[1]/ [2]/', 'C3', 120, 'je', 5040, 5040);
    expect(edited.ok).toBe(true);
    if (edited.ok) {
      expect(edited.inserted.map((e) => e.midi)).toEqual([60, 62]);
      expect(edited.events).toHaveLength(3);
    }

    // BPM scaling scales pitchPins and instrumentRegions accurately
    const scaledPins = scalePitchPinsByFactor(
      [{ id: 'p1', start_smp: 5040, end_smp: 29040, transition_ms: 30, exit_fit_ms: 35, points: [{ t_smp: 17040, f0_hz: 220 }] }],
      5040,
      2,
    );
    expect(scaledPins?.[0].end_smp).toBe(53040);
    expect(scaledPins?.[0].points[0].t_smp).toBe(29040);

    const scaledRegions = scaleInstrumentRegionsByFactor([{ startSmp: 5040, endSmp: 29040, instrument: 'xiao' }], 5040, 0.5);
    expect(scaledRegions?.[0]).toEqual({ startSmp: 5040, endSmp: 17040, instrument: 'xiao' });

    // Deep clone isolates nested arrays/objects (undo/redo safety)
    const draft = {
      events: initial,
      rows: [{ ...rows[0], marks: ['@rit' as const], phoneBoundaries: { ipa: 'a', ratios: { 1: 0.4 } } }],
      pitchPins: [{ id: 'p1', start_smp: 0, end_smp: 100, transition_ms: 20, exit_fit_ms: 20, points: [{ t_smp: 50, f0_hz: 200 }] }],
      instrumentRegions: [{ startSmp: 0, endSmp: 100, instrument: 'piano' as const }],
    };
    const cloned = deepCloneVoiceDraftFields(draft);
    cloned.rows[0].phoneBoundaries!.ratios[1] = 0.8;
    cloned.pitchPins![0].points[0].f0_hz = 300;
    cloned.instrumentRegions![0].endSmp = 999;
    expect(draft.rows[0].phoneBoundaries.ratios[1]).toBe(0.4);
    expect(draft.pitchPins[0].points[0].f0_hz).toBe(200);
    expect(draft.instrumentRegions[0].endSmp).toBe(100);

    expect(formatPitchInNotation(60, 'C3', 'je')).toBe('[1]');
    expect(formatPitchInNotation(60, 'C3', 'jianpu-player')).toBe("'1");
    expect(formatSingleNoteInNotation(60, 'C3', 0.5, 'jianpu-ly')).toBe("q1'");
  });
});
