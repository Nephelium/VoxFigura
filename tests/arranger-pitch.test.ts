import { describe, expect, it } from 'vitest';
import { evalF0, msToSamples, resolveAllTargets } from '@vocalcut/core';
import { buildAnnotationSynthesis } from '@/components/research/annotation-audio';
import { compileArrangement } from '@/components/studio/arranger-compile';
import {
  arrangementPitchOptions, arrangementPitchTargets, arrangerDampingRate, drawArrangerPitch, eraseArrangerPitch, transposeArrangerPitchPins,
} from '@/components/studio/arranger-pitch';
import { cropStagePhrase } from '@/components/studio/stage-voice-clips';
import { createInitialProject } from '@/stores/workbench';

const notes = [
  { rowIdx: 0, startSmp: 5040, endSmp: 19440, hz: 180, dynamic: 0, pressurePa: 800 },
  { rowIdx: 0, startSmp: 19440, endSmp: 33840, hz: 270, dynamic: 0, pressurePa: 800 },
  { rowIdx: 1, startSmp: 38640, endSmp: 53040, hz: 330, dynamic: 0, pressurePa: 800 },
];
const refHz = 165;
const stepSmp = msToSamples(5);
const evaluate = (rate: number) => evalF0({
  spans: arrangementPitchTargets(notes, refHz, rate),
  total_smp: notes.at(-1)!.endSmp,
  f_ref_hz: refHz,
  context: 'singing',
  ...arrangementPitchOptions([]),
});

describe('arranger singing F0', () => {
  it('anticipates contiguous pitch changes, adapts the rate to interval size, and leaves score boundaries intact', () => {
    const targets = arrangementPitchTargets(notes, refHz, 32);
    const resolved = resolveAllTargets(targets, 0, 'singing', true);
    expect(resolved[0].end_smp).toBe(resolved[1].start_smp);
    expect(notes[1].startSmp - resolved[1].start_smp).toBeGreaterThanOrEqual(msToSamples(35));
    expect(notes[1].startSmp - resolved[1].start_smp).toBeLessThanOrEqual(msToSamples(45));
    expect(targets[1].start_smp).toBe(notes[1].startSmp);
    expect(resolved[2].start_smp).toBe(notes[2].startSmp);
    const smaller = arrangementPitchTargets([notes[0], { ...notes[1], hz: 190 }], refHz, 32);
    expect(resolved[1].candidate.lambda_per_s).toBeLessThan(smaller[1].candidates.score!.lambda_per_s);

    const slow = evaluate(18);
    const fast = evaluate(65);
    if (!slow.ok || !fast.ok) throw Error('Expected valid qTA contours');
    const justBefore = (notes[1].startSmp - stepSmp) / stepSmp;
    const after = (notes[1].startSmp + msToSamples(40)) / stepSmp;
    expect(slow.value.f0_hz[justBefore]).toBeGreaterThan(180);
    expect(slow.value.f0_hz[after]).toBeLessThan(fast.value.f0_hz[after]);
    expect(slow.value.voiced_mask[notes[1].endSmp / stepSmp]).toBe(false);
    expect(slow.value.f0_hz[notes[2].startSmp / stepSmp]).toBeCloseTo(330);
  });

  it('draws through notes only, erases only the requested window, and rejects invalid pitch or timing', () => {
    const drawn = drawArrangerPitch([], [{ t_smp: 29040, f0_hz: 205 }, { t_smp: 43440, f0_hz: 310 }], notes);
    if (!drawn.ok) throw Error(drawn.error.hint);
    expect(drawn.value.map(pin => [pin.start_smp, pin.end_smp])).toEqual([[29040, 33840], [38640, 43441]]);
    const erased = eraseArrangerPitch(drawn.value, 30000, 31680);
    expect(erased.map(pin => [pin.start_smp, pin.end_smp])).toEqual([[29040, 30000], [31680, 33840], [38640, 43441]]);
    expect(erased[2]).toBe(drawn.value[1]);
    expect(drawArrangerPitch([], [{ t_smp: 29040, f0_hz: 601 }], notes)).toMatchObject({
      ok: false, error: { code: 'out_of_range', allowed: { min: 60, max: 600 } },
    });
    expect(drawArrangerPitch([], [{ t_smp: 29040.5, f0_hz: 250 }], notes)).toMatchObject({
      ok: false, error: { code: 'out_of_range', field: 't_smp' },
    });
  });

  it('feathers the join where a new stroke replaces part of an existing stroke', () => {
    const base = drawArrangerPitch([], [{ t_smp: 12000, f0_hz: 250 }, { t_smp: 16800, f0_hz: 250 }], notes);
    if (!base.ok) throw Error(base.error.hint);
    const redraw = drawArrangerPitch(base.value, [{ t_smp: 13200, f0_hz: 350 }, { t_smp: 15600, f0_hz: 350 }], notes);
    if (!redraw.ok) throw Error(redraw.error.hint);
    const result = evalF0({
      spans: arrangementPitchTargets(notes, refHz, 32), total_smp: notes.at(-1)!.endSmp, f_ref_hz: refHz,
      context: 'singing', ...arrangementPitchOptions(redraw.value),
    });
    if (!result.ok) throw Error(result.error.hint);
    expect(result.value.f0_hz[13200 / stepSmp]).toBeCloseTo(250);
    expect(result.value.f0_hz[13680 / stepSmp]).toBeGreaterThan(250);
    expect(result.value.f0_hz[14400 / stepSmp]).toBeCloseTo(350);
  });

  it('transposes only the part of a hand-drawn stroke covered by the selected note', () => {
    const drawn = drawArrangerPitch([], [{ t_smp: 15600, f0_hz: 180 }, { t_smp: 21920, f0_hz: 250 }], notes);
    if (!drawn.ok) throw Error(drawn.error.hint);
    const result = transposeArrangerPitchPins(drawn.value, [notes[1]], 12);
    expect(result?.map(pin => [pin.start_smp, pin.end_smp])).toEqual([[15600, 19440], [19440, 21921]]);
    expect(result?.[0].points[0].f0_hz).toBe(180);
    expect(result?.[1].points.at(-1)?.f0_hz).toBe(500);
    expect(transposeArrangerPitchPins(drawn.value, [notes[1]], 24)).toBeNull();
  });

  it('carries the authored curve and damping through arrangement compilation to the 200 Hz synthesis controls', () => {
    const project = createInitialProject();
    const voiceId = project.voice_order[0];
    const referenceHz = project.voices[voiceId].f0_ref_hz;
    const pins = drawArrangerPitch([], [{ t_smp: 12000, f0_hz: 250 }, { t_smp: 14400, f0_hz: 270 }], notes);
    if (!pins.ok) throw Error(pins.error.hint);
    const roll = {
      ok: true, issueMsg: '', notes, endSmp: notes.at(-1)!.endSmp,
      voice: { lyricsText: '啊啊', fullScoreStr: '(1/2/) 0 3', rows: [{ char: '啊', ipa: 'a' }, { char: '啊', ipa: 'a' }] },
    };
    const result = compileArrangement(roll, {
      clipId: 'test-arrangement', speakerId: voiceId, bpm: 100, tonic: 'C3', referenceHz,
      leadEnabled: true, leadMs: 75, biasMs: 0, dampingRate: 29, pitchPins: pins.value, vibrato: true,
    });
    if (!result.clip) throw Error(result.issue);
    expect(arrangerDampingRate(result.clip)).toBe(29);
    expect(result.clip.annotation_controls?.f0_pins).toEqual(pins.value);

    const compiled = result.clip;
    const fallback = { f0Hz: referenceHz, tract: Array(19).fill(0), releaseTract: Array(19).fill(0), lipWidth: 1, larynxHeight: 0 };
    const synthesis = buildAnnotationSynthesis(
      { ...project, f0_pins: compiled.annotation_controls?.f0_pins }, compiled, [], 0, compiled.end_smp, fallback,
    );
    if (!synthesis.ok) throw Error(synthesis.error.hint);
    const preview = evalF0({
      spans: arrangementPitchTargets(notes, referenceHz, 29), total_smp: roll.endSmp, f_ref_hz: referenceHz,
      context: 'singing', vibrato: { enabled: true }, ...arrangementPitchOptions(pins.value),
    });
    if (!preview.ok) throw Error(preview.error.hint);
    expect(synthesis.value.f0_hz[50]).toBe(250);
    expect(synthesis.value.f0_hz[60]).toBe(270);
    expect(synthesis.value.f0_hz.slice(21, 140)).toEqual(preview.value.f0_hz.slice(21, 140));
    expect(synthesis.value.pressure_pa[150]).toBe(0);
    expect(synthesis.value.pressure_pa[90]).toBeCloseTo(800);
    expect(synthesis.value.pressure_pa[135]).toBeLessThan(260);
    expect(synthesis.value.pressure_pa[139]).toBeLessThan(70);
    expect(compiled.syllables.syl_1.end_smp).toBe(notes[1].endSmp);
    const cropped = cropStagePhrase(compiled, 13200, 10000);
    expect(cropped.annotation_controls?.f0_pins?.[0]).toMatchObject({ start_smp: 0, end_smp: 1201 });
    expect(cropped.annotation_controls?.f0_pins?.[0].points[0].f0_hz).toBeCloseTo(Math.sqrt(250 * 270));
  });

  it('anticipates obstruents, puts a nasal on the beat, and edits only internal phones', () => {
    const start = 5040;
    const noteLength = 28800;
    const testNotes = ['pa', 'ma', 'sa'].map((_, rowIdx) => ({
      rowIdx, startSmp: start + noteLength * rowIdx, endSmp: start + noteLength * (rowIdx + 1),
      hz: 196, dynamic: 0, pressurePa: 800,
    }));
    const settings = {
      clipId: 'test', speakerId: 'lead', bpm: 100, tonic: 'G3' as const, referenceHz: 165,
      leadEnabled: true, leadMs: 75, biasMs: 0, dampingRate: 32, vibrato: true,
    };
    const rows = [
      { char: '巴', ipa: 'pa' }, { char: '妈', ipa: 'ma' }, { char: '撒', ipa: 'sa' },
    ];
    const compile = (voiceRows: typeof rows) => {
      const result = compileArrangement({
        ok: true, issueMsg: '', notes: testNotes, endSmp: testNotes[2].endSmp,
        voice: { rows: voiceRows, lyricsText: '巴妈撒', fullScoreStr: '1 1 1' },
      }, settings);
      if (!result.clip) throw Error(result.issue);
      return result.clip;
    };
    const original = compile(rows);
    const [plosive, nasal, fricative] = original.syllable_order.map(id => original.syllables[id]);
    expect(plosive.start_smp).toBeLessThan(testNotes[0].startSmp);
    expect(plosive.segments[plosive.nucleus_index].start_smp).toBe(testNotes[0].startSmp);
    expect(nasal.start_smp).toBe(testNotes[1].startSmp);
    expect(fricative.start_smp).toBeLessThan(testNotes[2].startSmp);
    expect(fricative.segments[fricative.nucleus_index].start_smp).toBe(testNotes[2].startSmp);
    const desired = nasal.segments[1].start_smp + msToSamples(15);
    const editedRow = {
      ...rows[1], vibratoCents: 67, diminuendo: 65,
      phoneBoundaries: { ipa: 'ma', ratios: { 1: (desired - nasal.start_smp) / (nasal.end_smp - nasal.start_smp) } },
    };
    const edited = compile([rows[0], editedRow, rows[2]]).syllables[nasal.id];
    expect([edited.start_smp, edited.end_smp]).toEqual([nasal.start_smp, nasal.end_smp]);
    expect(edited.segments[0].end_smp).toBe(desired);
    expect(edited.segments[1].start_smp).toBe(desired);
    expect(edited.overrides.vibrato?.depth_cents).toBe(67);
    expect(edited.overrides.pressure.at(-1)?.pressure_pa).toBeCloseTo(280);
  });
});
