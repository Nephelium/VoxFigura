import { describe, expect, it } from 'vitest';
import { evalF0, hzToSt, type QtaTargetSpan } from '@vocalcut/core';
import { holdProsodyPinEnds } from '@/data/prosody-model';
import { buildF0CurvePaths } from '@/components/research/f0-curve-paths';
import { buildAnnotationSynthesis } from '@/components/research/annotation-audio';
import { evaluateControlPitch, setUnmarkedIpaPitchMode } from '@/components/research/control-pitch';
import { buildSegmentsForSyllable } from '@/components/research/research-utils';
import { buildSyllableQtaTargets } from '@/data/ipa-segments';
import { createInitialProject, defaultTractParams, tractRecordToArray19 } from '@/stores/workbench';
import type { Clip, Syllable } from '@vocalcut/core';

const F_REF = 165;
const STEP = 240; // 5 ms

function span(id: string, start: number, end: number, bEndSt: number): QtaTargetSpan {
  return { id: `${id}_t0`, span_id: id, start_smp: start, end_smp: end, voiced: true,
    candidates: { default: { m_st_per_s: 0, b_end_st: bEndSt, lambda_per_s: 34, source: 'default' } } };
}

/** Largest change in st over any 20 ms window (4 frames of 5 ms). */
function maxJumpPer20ms(st: readonly number[]): number {
  let worst = 0;
  for (let i = 4; i < st.length; i++) worst = Math.max(worst, Math.abs(st[i] - st[i - 4]));
  return worst;
}

describe('F0 pin exit continuity (qta.ts)', () => {
  it('continues qTA from the pin exit state inside the span instead of restarting from the span start', () => {
    // One 1 s syllable aiming at 0 st; a hand-drawn pin at ~7 st ends at 0.5 s, in the middle of the span.
    const result = evalF0({
      total_smp: 48000, step_smp: STEP, f_ref_hz: F_REF, context: 'speech',
      spans: [span('s1', 0, 48000, 0)],
      pins: [{ id: 'p', start_smp: 9600, end_smp: 24000, transition_ms: 30, exit_fit_ms: 35,
        points: [{ t_smp: 9600, f0_hz: 250 }, { t_smp: 16800, f0_hz: 250 }, { t_smp: 24000, f0_hz: 250 }] }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const st = result.value.f0_st;
    const exit = 24000 / STEP;
    const pinSt = hzToSt(250, F_REF);
    // Before the fix the frame after the exit fell back to the restarted qTA (~0 st): a ~7 st cliff.
    expect(Math.abs(st[exit + 1] - pinSt)).toBeLessThan(0.3);
    expect(Math.abs(st[exit + 1] - st[exit])).toBeLessThan(0.3);
    // Then it relaxes smoothly toward the span target, without a jump anywhere after the pin.
    expect(maxJumpPer20ms(st.slice(exit - 8))).toBeLessThan(2);
    expect(st.at(-1)!).toBeLessThan(pinSt - 3);
  });

  it('starts the next span from the state at the end of the exit span, not the state at the pin exit', () => {
    const result = evalF0({
      total_smp: 72000, step_smp: STEP, f_ref_hz: F_REF, context: 'speech',
      spans: [span('s1', 0, 48000, 0), span('s2', 48000, 72000, 0)],
      pins: [{ id: 'p', start_smp: 4800, end_smp: 14400, transition_ms: 30, exit_fit_ms: 35,
        points: [{ t_smp: 4800, f0_hz: 250 }, { t_smp: 14400, f0_hz: 250 }] }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const st = result.value.f0_st;
    const boundary = 48000 / STEP;
    expect(Math.abs(st[boundary] - st[boundary - 1])).toBeLessThan(0.3);
    expect(maxJumpPer20ms(st)).toBeLessThan(8); // only the pin entry itself is steep
    expect(maxJumpPer20ms(st.slice(14400 / STEP))).toBeLessThan(2);
  });
});

describe('Speech qTA starts from the first target of a phrase', () => {
  it('uses the target after a long pause and carries the state across adjacent syllables', () => {
    const rising = span('s3', 28800, 38400, 2);
    rising.candidates.default!.m_st_per_s = 20;
    const result = evalF0({
      total_smp: 38400, step_smp: STEP, f_ref_hz: F_REF, context: 'speech', speech_onset_from_target: true,
      spans: [span('s1', 0, 9600, -1), span('s2', 9600, 19200, 4), rising],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const f0 = result.value.f0_st;
    expect(f0[0]).toBeCloseTo(-1);
    expect(f0[9600 / STEP]).toBeCloseTo(-1);
    expect(f0[28800 / STEP]).toBeCloseTo(-2);
    expect(f0.at(-1)).toBeGreaterThan(1.5);
  });

  it('gives the same flat IPA onset in the timeline and synthesis, with pins taking priority', () => {
    const project = createInitialProject();
    const voiceId = project.voice_order[0];
    const end = 18960;
    const phones = ['a', 't͡ɬ', 'i'];
    const syllable: Syllable = {
      id: 'ipa', text: '[at͡ɬi]', ipa: phones, nucleus_index: 0, start_smp: 0, end_smp: end,
      anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
      targets: buildSyllableQtaTargets('ipa', 0, end, { fRefHz: F_REF, stress: 0 }),
      segments: buildSegmentsForSyllable('ipa', phones, 0, end),
      overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
    };
    const clip: Clip = {
      id: 'clip', kind: 'phrase', voice_id: voiceId, start_smp: 0, end_smp: end,
      syllable_order: ['ipa'], syllables: { ipa: syllable },
    };
    const tract = tractRecordToArray19(defaultTractParams());
    const fallback = { tract, releaseTract: tract, f0Hz: F_REF, lipWidth: 1, larynxHeight: 0 };
    const timeline = evaluateControlPitch(project, [syllable], end, F_REF);
    const plan = buildAnnotationSynthesis(project, clip, [], 0, end, fallback);
    const targetHz = F_REF * 2 ** (-1 / 12);
    expect(timeline.ok && timeline.value.f0_hz[0]).toBeCloseTo(targetHz);
    expect(plan.ok && plan.value.f0_hz.every(hz => Math.abs(hz - targetHz) < 1e-8)).toBe(true);

    const pinned = buildAnnotationSynthesis({
      ...project,
      f0_pins: [{ id: 'pin', start_smp: 0, end_smp: end, transition_ms: 30, exit_fit_ms: 35,
        points: [{ t_smp: 0, f0_hz: 127 }, { t_smp: end, f0_hz: 149 }] }],
    }, clip, [], 0, end, fallback);
    expect(pinned.ok && pinned.value.f0_hz[0]).toBeCloseTo(127);
    expect(pinned.ok && pinned.value.f0_hz.at(-1)).toBeGreaterThan(148);

    // Optional natural intonation mode adds gentle arch + declination on unmarked IPA only.
    try {
      setUnmarkedIpaPitchMode('natural');
      const naturalTimeline = evaluateControlPitch(project, [syllable], end, F_REF);
      const naturalPlan = buildAnnotationSynthesis(project, clip, [], 0, end, fallback);
      expect(naturalTimeline.ok && naturalPlan.ok).toBe(true);
      if (naturalTimeline.ok && naturalPlan.ok) {
        const hz = naturalTimeline.value.f0_hz;
        expect(hz[0]).toBeCloseTo(targetHz, 1);
        expect(Math.max(...hz)).toBeGreaterThan(targetHz + 1.5);
        expect(hz.at(-1)!).toBeLessThan(targetHz - 4.0);
        expect(Math.max(...hz) - Math.min(...hz)).toBeLessThan(18);
        // Tone-marked syllables stay unaffected by unmarked natural intonation.
        const marked: Syllable = { ...syllable, tone_levels: '55' };
        const markedEval = evaluateControlPitch(project, [marked], end, F_REF);
        expect(markedEval.ok && markedEval.value.f0_hz.every(v => Math.abs(v - targetHz) < 1e-8)).toBe(true);
      }
    } finally {
      setUnmarkedIpaPitchMode('flat');
    }
  });
});

describe('Text2Prosody pin covers the whole clip (prosody-model.ts)', () => {
  // Knots shaped like a Mandarin contour (T1 T4 T2 T3), first knot after 0, last before the clip end.
  const knotsS: Array<[number, number]> = [
    [0.12, 210], [0.2, 212], [0.28, 211], [0.34, 230], [0.42, 190], [0.5, 150], [0.56, 140], [0.64, 160],
    [0.72, 185], [0.8, 150], [0.88, 125], [0.95, 120], [1.02, 135], [1.1, 150],
  ];
  const totalSmp = 60000; // 1.25 s
  const knots = knotsS.map(([t, hz]) => ({ t_smp: Math.round(t * 48000), f0_hz: hz }));

  it('holds the first and last knot values to 0 and totalSmp (as np.interp does)', () => {
    const held = holdProsodyPinEnds(knots, totalSmp);
    expect(held[0]).toEqual({ t_smp: 0, f0_hz: 210 });
    expect(held.at(-1)).toEqual({ t_smp: totalSmp, f0_hz: 150 });
    expect(held.slice(1, -1)).toEqual(knots);
    expect(holdProsodyPinEnds([{ t_smp: 0, f0_hz: 200 }, { t_smp: totalSmp, f0_hz: 180 }], totalSmp)).toHaveLength(2);
  });

  it('gives a continuous curve over all frames that follows the knots', () => {
    const held = holdProsodyPinEnds(knots, totalSmp);
    // Rule targets deliberately far from the knots: any frame not covered by the pin would jump.
    const syllables = [[0, 16000, -4], [16000, 30000, 8], [30000, 44000, -6], [44000, totalSmp, 9]] as const;
    const result = evalF0({
      total_smp: totalSmp, step_smp: STEP, f_ref_hz: F_REF, context: 'speech',
      spans: syllables.map(([a, b, target], i) => span(`s${i}`, a, b, target)),
      pins: [{ id: 'prosody', start_smp: held[0].t_smp, end_smp: held.at(-1)!.t_smp, points: held,
        transition_ms: 30, exit_fit_ms: 35 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { f0_st: st, f0_hz: hz, times_smp: times } = result.value;
    expect(hz.every((v) => Number.isFinite(v) && v >= 60 && v <= 600)).toBe(true);
    expect(maxJumpPer20ms(st)).toBeLessThan(2);
    // Reference: np.interp over the knots with end holds (linear in Hz).
    const interp = (t: number) => {
      if (t <= knots[0].t_smp) return knots[0].f0_hz;
      for (let i = 1; i < knots.length; i++) {
        if (t <= knots[i].t_smp) {
          const u = (t - knots[i - 1].t_smp) / (knots[i].t_smp - knots[i - 1].t_smp);
          return knots[i - 1].f0_hz + u * (knots[i].f0_hz - knots[i - 1].f0_hz);
        }
      }
      return knots.at(-1)!.f0_hz;
    };
    const worst = Math.max(...times.map((t, i) => Math.abs(st[i] - hzToSt(interp(t), F_REF))));
    expect(worst).toBeLessThan(0.5);
  });
});

describe('F0 display paths (f0-curve-paths.ts)', () => {
  it('keeps one continuous line across voiced/unvoiced changes', () => {
    const pts = [
      { x: 0, y: 10, voiced: true }, { x: 1, y: 11, voiced: true }, { x: 2, y: 12, voiced: false },
      { x: 3, y: 13, voiced: false }, { x: 4, y: 14, voiced: true }, { x: 5, y: 15, voiced: true },
    ];
    const { voicedPaths, unvoicedPaths } = buildF0CurvePaths(pts);
    expect(voicedPaths).toEqual(['M 0.0,10.0 L 1.0,11.0', 'M 3.0,13.0 L 4.0,14.0 L 5.0,15.0']);
    expect(unvoicedPaths).toEqual(['M 1.0,11.0 L 2.0,12.0 L 3.0,13.0']);
    // Every path after the first starts where the previous one ended: no gaps.
    const all = [voicedPaths[0], unvoicedPaths[0], voicedPaths[1]];
    for (let i = 1; i < all.length; i++) {
      const prevEnd = all[i - 1].split(/[ML] /).at(-1)!.trim();
      expect(all[i].startsWith(`M ${prevEnd}`)).toBe(true);
    }
  });
});

describe('Falsetto register F0 lift (control-pitch.ts)', () => {
  it('lifts F0 for falsetto anchors over Text2Prosody pins while still honoring user-drawn F0 pins', () => {
    const project = createInitialProject();
    const end = 48000;
    const syl: Syllable = {
      id: 's1', text: '春', ipa: ['ʈʂʰ', 'w', 'ə', 'n'], nucleus_index: 2, start_smp: 0, end_smp: end,
      anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
      targets: buildSyllableQtaTargets('s1', 0, end, { fRefHz: F_REF, stress: 0 }),
      segments: buildSegmentsForSyllable('s1', ['ʈʂʰ', 'w', 'ə', 'n'], 0, end),
      overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
    };
    const prosodyPin = {
      id: 'prosody-clip1', start_smp: 0, end_smp: end, transition_ms: 30, exit_fit_ms: 35,
      points: [{ t_smp: 0, f0_hz: 165 }, { t_smp: end, f0_hz: 165 }],
    };
    const withProsody = { ...project, f0_pins: [prosodyPin] };
    const falsettoAnchors = [{ id: 'a1', t_smp: 0, regime: 'falsetto' as const, blend: 1 }];

    const base = evaluateControlPitch(withProsody, [syl], end, F_REF, true, false, []);
    const lifted = evaluateControlPitch(withProsody, [syl], end, F_REF, true, false, falsettoAnchors);
    expect(base.ok && lifted.ok).toBe(true);
    if (!base.ok || !lifted.ok) return;
    const mid = Math.floor(lifted.value.f0_hz.length / 2);
    expect(lifted.value.f0_hz[mid]).toBeGreaterThan(base.value.f0_hz[mid] * 1.35);
    expect(lifted.value.f0_hz.every((hz) => hz >= 60 && hz <= 600)).toBe(true);

    // Explicit user hand-drawn F0 pins still override automatic register shift.
    const withUserPin = {
      ...project,
      f0_pins: [{ id: 'user-pin-1', start_smp: 0, end_smp: end, transition_ms: 30, exit_fit_ms: 35,
        points: [{ t_smp: 0, f0_hz: 180 }, { t_smp: end, f0_hz: 180 }] }],
    };
    const pinned = evaluateControlPitch(withUserPin, [syl], end, F_REF, true, false, falsettoAnchors);
    expect(pinned.ok && pinned.value.f0_hz[mid]).toBeCloseTo(180, 1);
  });
});
