import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PHONATION_M27_ANCHORS,
  SAMPLE_RATE_HZ,
  msToSamples,
  type SegmentAnchor,
} from '@vocalcut/core';
import { createInitialProject, defaultTractParams, tractRecordToArray19, useWorkbenchStore } from '@/stores/workbench';
import {
  exciseAudioBufferRange,
  exciseClipAndControlsRange,
  exciseM27TrajectoryRange,
} from '@/components/research/audio-cut';
import {
  copyAnnotationSelection,
  deleteAnnotationSegments,
  getPhoneSlideBounds,
  getSyllableSlideBounds,
  pasteAnnotationClipboard,
  resizeAnnotationSilenceGap,
  slideAnnotationPhones,
  slideAnnotationSyllables,
  syncSyllableTextFromSegments,
} from '@/components/research/annotation-edit';
import {
  buildAnnotationSynthesis,
  isBracketedIpaSyllable,
  resolveSyllablePoseSource,
} from '@/components/research/annotation-audio';
import { textPoseOptions, textPoseSource } from '@/data/ipa-pose-source';
import { quickIpaAliases, quickIpaKey } from '@/components/research/quick-ipa';
import { formatTimecode, replaceSegmentIpa } from '@/components/research/research-utils';
import { buildF0CurvePaths } from '@/components/research/f0-curve-paths';
import { evaluateControlPitch } from '@/components/research/control-pitch';
import { ARRANGED_NOTE_RULE } from '@/components/studio/arranger-score';
import { phoneTraits, splitPhoneNotation } from '@/data/ipa-segments';
import { applyJd2DiacriticModifiers } from '@/data/ptb-ipa-presets';
import {
  clearVtlPoseClientCache,
  getCachedVtlPose,
  hydratePoseBatchResponse,
  prefetchVtlPoseBatch,
} from '@/data/vtl-pose-client';
import { sendWorkspaceAudio, takeWorkspaceAudio } from '@/data/workspace-transfer';

class FakeAudioBuffer {
  readonly length: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  readonly duration: number;
  private readonly channels: Float32Array[];

  constructor(opts: { length: number; numberOfChannels?: number; sampleRate: number }) {
    this.length = opts.length;
    this.numberOfChannels = opts.numberOfChannels ?? 1;
    this.sampleRate = opts.sampleRate;
    this.duration = opts.length / opts.sampleRate;
    this.channels = Array.from({ length: this.numberOfChannels }, () => new Float32Array(opts.length));
  }

  getChannelData(ch: number): Float32Array {
    return this.channels[ch];
  }
}

describe('synthesis page audio excision and splice regression fixes', () => {
  const prevAudioBuffer = globalThis.AudioBuffer;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'AudioBuffer', {
      value: FakeAudioBuffer,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'AudioBuffer', {
      value: prevAudioBuffer,
      configurable: true,
      writable: true,
    });
  });

  it('exciseAudioBufferRange preserves DC level and avoids post-cut sample duplication', () => {
    const sr = SAMPLE_RATE_HZ;
    const totalLen = Math.round(sr * 0.4);
    const dcBuf = new FakeAudioBuffer({ length: totalLen, numberOfChannels: 1, sampleRate: sr });
    dcBuf.getChannelData(0).fill(1);

    const cutDc = exciseAudioBufferRange(dcBuf as unknown as AudioBuffer, 0.1, 0.2);
    expect(cutDc.length).toBe(Math.round(sr * 0.3));
    const dcData = cutDc.getChannelData(0);
    for (let i = 0; i < dcData.length; i++) {
      expect(dcData[i]).toBeCloseTo(1, 5);
    }

    // Distinct marker ramp to confirm centered crossfade does not repeat tail audio
    const rampBuf = new FakeAudioBuffer({ length: totalLen, numberOfChannels: 1, sampleRate: sr });
    const ramp = rampBuf.getChannelData(0);
    for (let i = 0; i < totalLen; i++) ramp[i] = i;

    const s0 = Math.round(0.1 * sr);
    const s1 = Math.round(0.2 * sr);
    const halfFade = Math.round(0.0025 * sr);
    const cutRamp = exciseAudioBufferRange(rampBuf as unknown as AudioBuffer, 0.1, 0.2);
    const out = cutRamp.getChannelData(0);

    // Just before splice window equals untouched head
    expect(out[s0 - halfFade - 1]).toBe(s0 - halfFade - 1);
    // Just after splice window equals untouched post-cut tail without 5ms shift
    expect(out[s0 + halfFade + 1]).toBe(s1 + halfFade + 1);
    // Splice midpoint blends lookahead/lookbehind symmetrically around (s0, s1)
    expect(out[s0]).toBeGreaterThan(s0);
    expect(out[s0]).toBeLessThan(s1);
  });

  it('exciseAudioBufferRange applies trailing fade on actualEnd when cutting the tail', () => {
    const sr = SAMPLE_RATE_HZ;
    const totalLen = Math.round(sr * 0.4);
    const buf = new FakeAudioBuffer({ length: totalLen, numberOfChannels: 1, sampleRate: sr });
    buf.getChannelData(0).fill(1);

    const cut = exciseAudioBufferRange(buf as unknown as AudioBuffer, 0.2, 0.4);
    const out = cut.getChannelData(0);
    expect(out[out.length - 1]).toBeCloseTo(0, 4);
    expect(out[0]).toBeCloseTo(1, 5);
  });

  it('exciseM27TrajectoryRange shifts boundary frames consistently with c1 - 1e-5', () => {
    const rows = Array.from({ length: 20 }, (_, i) => [i]);
    const anim = {
      fps: 25,
      duration_sec: 0.4,
      frame_count: 5,
      frames: [
        { t: 0.0, lm: [] },
        { t: 0.1, lm: [] },
        { t: 0.2, lm: [] },
        { t: 0.3, lm: [] },
        { t: 0.4, lm: [] },
      ],
    };
    const res = exciseM27TrajectoryRange(rows, anim as never, 0.1, 0.2);
    expect(res.anim?.frames.map((f) => f.t)).toEqual([0, 0.1, 0.2, 0.3]);
  });

  it('exciseClipAndControlsRange remaps pose overrides, deduplicates phonation anchors and bounds stop timing', () => {
    const project = createInitialProject();
    const clipId = project.clip_order[0];
    const clip = project.clips[clipId];
    const s1Id = 'syl_cut_test';
    const seg0End = msToSamples(100);
    const seg1End = msToSamples(220);
    const seg2End = msToSamples(320);

    clip.start_smp = 0;
    clip.end_smp = seg2End;
    clip.syllable_order = [s1Id];
    clip.syllables = {
      [s1Id]: {
        id: s1Id,
        text: 'pa',
        ipa: ['pʰ', 'a', 'n'],
        nucleus_index: 1,
        start_smp: 0,
        end_smp: seg2End,
        anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
        segments: [
          {
            id: 'seg_0',
            ipa: 'pʰ',
            start_smp: 0,
            end_smp: seg0End,
            role: 'onset',
            elastic: false,
            voiced: false,
            stop_timing: { closure_ms: 60, release_ms: 15, aspiration_ms: 20, vot_ms: 35, auto_generated: true },
          },
          {
            id: 'seg_1',
            ipa: 'a',
            start_smp: seg0End,
            end_smp: seg1End,
            role: 'nucleus',
            elastic: true,
            voiced: true,
          },
          {
            id: 'seg_2',
            ipa: 'n',
            start_smp: seg1End,
            end_smp: seg2End,
            role: 'coda',
            elastic: false,
            voiced: true,
          },
        ],
        targets: [],
        overrides: {
          poses: [
            { seg_index: 1, seg_id: 'seg_1', delta: { JA: -2 } },
            { seg_index: 2, seg_id: 'seg_2', delta: { VO: 0.8 } },
          ],
          pressure: [],
          f0_resid: [],
          glottis: [],
        },
      },
    };
    project.phonation_anchor_order = ['a0', 'a1', 'a2'];
    project.phonation_anchors = {
      a0: { id: 'a0', t_smp: msToSamples(10), regime: 'modal', blend: 1, glottis: { ...PHONATION_M27_ANCHORS.modal } },
      a1: { id: 'a1', t_smp: msToSamples(60), regime: 'breathy', blend: 1, glottis: { ...PHONATION_M27_ANCHORS.breathy } },
      a2: { id: 'a2', t_smp: msToSamples(220), regime: 'creaky', blend: 1, glottis: { ...PHONATION_M27_ANCHORS.creaky } },
    };

    // Cut [30ms, 220ms): seg_0 shrinks to 30ms, seg_1 is removed, seg_2 shifts to index 1, a2 lands at 30ms
    const res = exciseClipAndControlsRange(project, clipId, msToSamples(30), msToSamples(220));
    expect(res).not.toBeNull();
    const nextSyl = res!.nextClip.syllables[s1Id];
    expect(nextSyl.segments.map((s) => s.id)).toEqual(['seg_0', 'seg_2']);

    // Stop timing bounded within 30ms
    const stop = nextSyl.segments[0].stop_timing!;
    expect(stop.closure_ms).toBeGreaterThanOrEqual(10);
    expect(stop.release_ms).toBeGreaterThanOrEqual(1);
    expect(stop.closure_ms + stop.release_ms + (stop.aspiration_ms ?? 0)).toBeLessThanOrEqual(30);

    // Pose override for removed seg_1 pruned, seg_2 remapped to index 1
    expect(nextSyl.overrides.poses).toHaveLength(1);
    expect(nextSyl.overrides.poses[0].seg_id).toBe('seg_2');
    expect(nextSyl.overrides.poses[0].seg_index).toBe(1);

    // Anchor a2 already sits at c0 (30ms), so carry-over from a1 must NOT duplicate at 30ms
    const anchorTimes = res!.nextProject.phonation_anchor_order.map((id) => res!.nextProject.phonation_anchors[id].t_smp);
    expect(new Set(anchorTimes).size).toBe(anchorTimes.length);
  });
});

describe('synthesis page IPA, timecode, F0 path and VoQS register fixes', () => {
  it('normalizes affricate aliases consistently across quickIpaKey and quickIpaAliases', () => {
    expect(quickIpaKey('ȶɕʰ')).toBe('tɕʰ');
    expect(quickIpaKey('t͡ɕʰ')).toBe('tɕʰ');
    expect(quickIpaKey('ʈʂ')).toBe('tʂ');
    expect(quickIpaAliases('tɕʰ')).toContain('ȶɕʰ');
    expect(quickIpaAliases('tɕʰ')).toContain('ȶ͡ɕʰ');
  });

  it('formats centisecond boundary rollover without producing 00:60.00 or NaN', () => {
    expect(formatTimecode(Math.round(59.996 * SAMPLE_RATE_HZ))).toBe('01:00.00');
    expect(formatTimecode(Number.NaN)).toBe('00:00.00');
    expect(formatTimecode(-500)).toBe('00:00.00');
  });

  it('bounds stop_timing on short phones and updates role when transitioning to/from sil', () => {
    const shortSeg: SegmentAnchor = {
      id: 'seg_short',
      ipa: 'a',
      start_smp: 0,
      end_smp: msToSamples(20),
      role: 'nucleus',
      elastic: true,
      voiced: true,
    };
    const asStop = replaceSegmentIpa(shortSeg, 'pʰ', 'JD2');
    expect(asStop.stop_timing).toBeDefined();
    const st = asStop.stop_timing!;
    expect(st.closure_ms).toBeGreaterThanOrEqual(10);
    expect(st.release_ms).toBeGreaterThanOrEqual(1);
    expect(st.closure_ms + st.release_ms + (st.aspiration_ms ?? 0)).toBeLessThanOrEqual(20);

    const asSil = replaceSegmentIpa(shortSeg, 'sil', 'JD2');
    expect(asSil.role).toBe('rest');
    expect(asSil.voiced).toBe(false);
    expect(asSil.stop_timing).toBeUndefined();

    const backToVowel = replaceSegmentIpa(asSil, 'a', 'JD2');
    expect(backToVowel.role).toBe('nucleus');
    expect(backToVowel.voiced).toBe(true);
  });

  it('breaks F0 SVG paths on non-finite coordinates and drops degenerate single-point paths', () => {
    const res = buildF0CurvePaths([
      { x: 0, y: 10, voiced: true },
      { x: 10, y: 12, voiced: true },
      { x: 20, y: Number.NaN, voiced: true },
      { x: 30, y: 15, voiced: true },
      { x: 40, y: Number.POSITIVE_INFINITY, voiced: false },
      { x: 50, y: 18, voiced: false },
      { x: 60, y: 20, voiced: false },
    ]);
    expect(res.voicedPaths).toEqual(['M 0.0,10.0 L 10.0,12.0']);
    expect(res.unvoicedPaths).toEqual(['M 50.0,18.0 L 60.0,20.0']);
  });

  it('avoids false pitch dip between consecutive same-register VoQS anchors and respects user F0 pins', () => {
    const project = createInitialProject();
    const totalSmp = msToSamples(400);
    const syl = {
      id: 'syl_voqs_test',
      text: 'a',
      ipa: ['a'],
      nucleus_index: 0,
      start_smp: 0,
      end_smp: totalSmp,
      anchor: { policy: 'speech_timing' as const, lead_ms: null, bias_ms: 0 },
      segments: [
        {
          id: 'seg_voqs_0',
          ipa: 'a',
          start_smp: 0,
          end_smp: totalSmp,
          role: 'nucleus' as const,
          elastic: true,
          voiced: true,
        },
      ],
      targets: [
        {
          id: 't0',
          span_id: 'syl_voqs_test',
          start_smp: 0,
          end_smp: totalSmp,
          voiced: true,
          candidates: { default: { m_st_per_s: 0, b_end_st: 0, lambda_per_s: 36, source: 'default' as const } },
        },
      ],
      overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
    };
    project.phonation_anchor_order = ['f1', 'f2'];
    project.phonation_anchors = {
      f1: { id: 'f1', t_smp: 0, regime: 'falsetto', blend: 1, glottis: { ...PHONATION_M27_ANCHORS.falsetto } },
      f2: { id: 'f2', t_smp: msToSamples(200), regime: 'falsetto', blend: 1, glottis: { ...PHONATION_M27_ANCHORS.falsetto } },
    };
    project.f0_pins = [
      {
        id: 'pin_mid',
        start_smp: msToSamples(280),
        end_smp: msToSamples(340),
        transition_ms: 30,
        exit_fit_ms: 35,
        points: [
          { t_smp: msToSamples(280), f0_hz: 150 },
          { t_smp: msToSamples(340), f0_hz: 150 },
        ],
      },
    ];

    const res = evaluateControlPitch(project, [syl], totalSmp, 125, true, true, undefined, {
      unmarkedPitchMode: 'flat',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Around 200ms (second consecutive falsetto anchor), pitch must stay flat at falsetto register (no dip toward 125 Hz)
    const idxAt100 = res.value.times_smp.findIndex((t) => t >= msToSamples(100));
    const idxAt200 = res.value.times_smp.findIndex((t) => t >= msToSamples(200));
    expect(idxAt100).toBeGreaterThan(0);
    expect(idxAt200).toBeGreaterThan(idxAt100);
    expect(res.value.f0_hz[idxAt200]).toBeGreaterThan(200);
    expect(Math.abs(res.value.f0_hz[idxAt200] - res.value.f0_hz[idxAt100])).toBeLessThan(1);

    // Inside the explicit user F0 pin [280ms, 340ms], user's 150 Hz pin must not be shifted upward by falsetto
    const idxAt310 = res.value.times_smp.findIndex((t) => t >= msToSamples(310));
    expect(idxAt310).toBeGreaterThan(0);
    expect(res.value.f0_hz[idxAt310]).toBeCloseTo(150, 0);

    // Multi-sentence automatic prosody pins (`s4_prosody-...`) must still receive VoQS falsetto register shift
    const multiSentProj = createInitialProject();
    multiSentProj.phonation_anchor_order = ['f1'];
    multiSentProj.phonation_anchors = {
      f1: { id: 'f1', t_smp: 0, regime: 'falsetto', blend: 1, glottis: { ...PHONATION_M27_ANCHORS.falsetto } },
    };
    multiSentProj.f0_pins = [
      {
        id: 's4_prosody-clip_1-run-2',
        start_smp: 0,
        end_smp: totalSmp,
        transition_ms: 30,
        exit_fit_ms: 35,
        points: [
          { t_smp: 0, f0_hz: 155 },
          { t_smp: totalSmp, f0_hz: 145 },
        ],
      },
    ];
    const multiRes = evaluateControlPitch(multiSentProj, [syl], totalSmp, 165, true, true, undefined, {
      unmarkedPitchMode: 'flat',
    });
    expect(multiRes.ok).toBe(true);
    if (multiRes.ok) {
      const idxMid = multiRes.value.times_smp.findIndex((t) => t >= msToSamples(200));
      expect(multiRes.value.f0_hz[idxMid]).toBeGreaterThan(230);
    }
  });

  it('uses calibrated schwa [ə] as the default neutral vocal tract pose', () => {
    const def = defaultTractParams();
    expect(def.JA).toBeCloseTo(-4.507, 2);
    expect(def.TCY).toBeCloseTo(-1.73, 2);
    expect(def.TBY).toBeCloseTo(-0.974, 2);
    expect(def.TTY).toBeCloseTo(-0.972, 2);
    expect(def.VO).toBeCloseTo(-0.1, 2);
  });

  it('parses and modifies narrow Japanese IPA symbols including compressed [ɯᵝ], [ɯᵝ̥], and [ɰᵝ]', () => {
    expect(splitPhoneNotation('kʲo̞')).toEqual(['kʲ', 'o̞']);
    expect(splitPhoneNotation('ɰᵝä')).toEqual(['ɰᵝ', 'ä']);
    expect(splitPhoneNotation('sɯᵝ̥')).toEqual(['s', 'ɯᵝ̥']);
    expect(splitPhoneNotation('kʲi̥')).toEqual(['kʲ', 'i̥']);
    expect(splitPhoneNotation('ɰ̩̃')).toEqual(['ɰ̩̃']);

    const uComp = phoneTraits('ɯᵝ');
    expect(uComp.base).toBe('ɯ');
    expect(uComp.vowel).toBe(true);
    expect(uComp.voiced).toBe(true);

    const uDevoiced = phoneTraits('ɯᵝ̥');
    expect(uDevoiced.base).toBe('ɯ');
    expect(uDevoiced.vowel).toBe(true);
    expect(uDevoiced.voiced).toBe(false);

    const wComp = phoneTraits('ɰᵝ');
    expect(wComp.base).toBe('ɰ');
    expect(wComp.sonorant).toBe(true);
    expect(wComp.voiced).toBe(true);

    // Compressed labialization narrows LD without protruding LP
    const baseU = [0.5, -5.0, -0.1, -3.5, 0.2, 0.9, 0.5, -0.1, -0.4, -1.0, 4.0, -1.2, 2.5, -0.5, -1.7, -2.4, 0.2, 0.2, 0.2];
    const modU = applyJd2DiacriticModifiers('ɯᵝ', baseU);
    expect(modU[4]).toBeLessThanOrEqual(0.08);
    expect(modU[5]).toBeLessThan(baseU[5]);
    expect(modU[5]).toBeGreaterThanOrEqual(0.28);
    expect(modU[8]).toBeGreaterThan(baseU[8]);
  });

  it('hydrates batch VTL pose snapshots into the sync client cache and falls back cleanly on 404', async () => {
    clearVtlPoseClientCache();
    const sharedFreq = [100, 200, 300];
    const sharedTris = { tongue: [[0, 1, 2]] };
    const hydrated = hydratePoseBatchResponse({
      speaker: 'JD2',
      frequency: sharedFreq,
      mesh_triangles: sharedTris,
      items: [
        { tract_params: { JA: -4.2 }, transfer_db: [-1, -2, -3], meshes: [{ name: 'tongue', vertices: [] }] },
      ],
    });
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0].frequency).toBe(sharedFreq);
    expect((hydrated[0].meshes as Array<{ triangles?: unknown }>)[0].triangles).toBe(sharedTris.tongue);

    const prevFetch = globalThis.fetch;
    try {
      const calls: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/pose-batch')) {
          return new Response(JSON.stringify({ ok: false, error: { code: 'not_found' } }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({ ok: true, frequency: [100], transfer_db: [-3], meshes: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch;

      const baseParams = tractRecordToArray19(defaultTractParams());
      const secondParams = [...baseParams];
      secondParams[3] = -3.2;
      const reqA = {
        speaker: 'JD2',
        section_count: 65,
        params: baseParams,
        lip_width: 1,
        larynx_height: 0,
        manual_root: false,
        tongue_shape: [0, 0, 0, 0] as [number, number, number, number],
        lip_shape: [0, 0, 0, 0] as [number, number, number, number],
      };
      const reqB = { ...reqA, params: secondParams };
      await prefetchVtlPoseBatch([reqA, reqB]);
      expect(calls.some((u) => u.endsWith('/pose-batch'))).toBe(true);
      expect(calls.some((u) => u.endsWith('/pose'))).toBe(true);
      expect(getCachedVtlPose(reqA)).not.toBeNull();
      expect(getCachedVtlPose(reqB)).not.toBeNull();
    } finally {
      globalThis.fetch = prevFetch;
      clearVtlPoseClientCache();
    }
  });

  it('routes audio handoff to voice mixer with TextGrid and transcript preserved', () => {
    const store = useWorkbenchStore();
    const wavFile = new File([new Uint8Array(64)], 'synth.wav', { type: 'audio/wav' });
    const grid = {
      xmin: 0,
      xmax: 0.5,
      tiers: [{ kind: 'IntervalTier' as const, name: 'syllables', xmin: 0, xmax: 0.5, intervals: [{ xmin: 0, xmax: 0.5, text: '今日' }] }],
    };
    sendWorkspaceAudio('mixer', {
      file: wavFile,
      label: '今日',
      textGrid: grid,
      alignmentText: '今日はいい天気ですね',
      sourceKind: 'ipa-synth',
    });
    expect(store.activeWorkspace.value).toBe('research');
    expect(store.researchTab.value).toBe('mixer');
    const received = takeWorkspaceAudio('mixer');
    expect(received?.file.name).toBe('synth.wav');
    expect(received?.alignmentText).toBe('今日はいい天気ですね');
    expect(received?.textGrid?.tiers[0]?.name).toBe('syllables');
  });

  it('scales speech F0 register for custom reference speakers while preserving VoQS falsetto and singing notes', () => {
    const project = createInitialProject();
    const clip = project.clips[project.clip_order[0]];
    const totalSmp = msToSamples(800);
    clip.start_smp = 0;
    clip.end_smp = totalSmp;
    const syl = {
      id: 'syl_reg',
      text: 'falsetto',
      ipa: ['f', 'ɔ', 'l', 's', 'ɛ', 't', 'o', 'ʊ'],
      nucleus_index: 1,
      start_smp: 0,
      end_smp: totalSmp,
      anchor: { policy: 'speech_timing' as const, lead_ms: null, bias_ms: 0 },
      segments: [],
      targets: [],
      overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
    };
    project.f0_pins = [{
      id: 's4_prosody-clip_1-run-1',
      start_smp: 0,
      end_smp: totalSmp,
      transition_ms: 0,
      exit_fit_ms: 0,
      points: [
        { t_smp: 0, f0_hz: 165 },
        { t_smp: totalSmp, f0_hz: 165 },
      ],
    }];
    const falsettoAnchors = [
      { id: 'a0', t_smp: 0, regime: 'modal' as const, blend: 1, glottis: { ...PHONATION_M27_ANCHORS.modal } },
      { id: 'a1', t_smp: msToSamples(400), regime: 'falsetto' as const, blend: 1, glottis: { ...PHONATION_M27_ANCHORS.falsetto } },
    ];
    const female = evaluateControlPitch(project, [syl], totalSmp, 165, true, false, falsettoAnchors, {
      speechRegisterRatio: 264 / 165,
    });
    const male = evaluateControlPitch(project, [syl], totalSmp, 165, true, false, falsettoAnchors, {
      speechRegisterRatio: 115 / 165,
    });
    expect(female.ok && male.ok).toBe(true);
    if (!female.ok || !male.ok) return;
    const modalIdx = female.value.times_smp.findIndex((t) => t >= msToSamples(200));
    const falsettoIdx = female.value.times_smp.findIndex((t) => t >= msToSamples(600));
    expect(female.value.f0_hz[modalIdx]).toBeCloseTo(264, 0);
    expect(male.value.f0_hz[modalIdx]).toBeCloseTo(115, 0);
    // VoQS falsetto lifts cleanly above both shifted modal registers
    expect(female.value.f0_hz[falsettoIdx]).toBeGreaterThan(female.value.f0_hz[modalIdx] + 60);
    expect(male.value.f0_hz[falsettoIdx]).toBeGreaterThan(male.value.f0_hz[modalIdx] + 60);

    // Arranged singing notes stay immune to speechRegisterRatio
    const singingSyl = {
      ...syl,
      targets: [{
        id: 'score_0',
        span_id: syl.id,
        start_smp: 0,
        end_smp: totalSmp,
        voiced: true,
        candidates: { score: { m_st_per_s: 0, b_end_st: 0, lambda_per_s: 36, source: 'score' as const, rule: ARRANGED_NOTE_RULE } },
      }],
    };
    const singShifted = evaluateControlPitch(project, [singingSyl], totalSmp, 165, false, false, [], {
      speechRegisterRatio: 264 / 165,
    });
    expect(singShifted.ok).toBe(true);
    if (!singShifted.ok) return;
    expect(singShifted.value.f0_hz[modalIdx]).toBeCloseTo(165, 0);
  });

  it('syncs bracketed and bare IPA syllable labels on phoneme edits while leaving orthographic words intact', () => {
    const baseSeg: SegmentAnchor = {
      id: 'p0',
      ipa: 'a',
      start_smp: 0,
      end_smp: msToSamples(100),
      role: 'nucleus',
      elastic: true,
      voiced: true,
      params: tractRecordToArray19(defaultTractParams()),
    };
    const baseSyl = {
      id: 'syl_0',
      text: '[tʂʰɑu˧˥]',
      ipa: ['tʂʰ', 'ɑ', 'u'],
      nucleus_index: 1,
      start_smp: 0,
      end_smp: msToSamples(300),
      anchor: { policy: 'speech_timing' as const, lead_ms: null, bias_ms: 0 },
      segments: [
        { ...baseSeg, id: 'p0', ipa: 'tʂʰ' },
        { ...baseSeg, id: 'p1', ipa: 'u' },
        { ...baseSeg, id: 'p2', ipa: 'u' },
      ],
      targets: [],
      overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
    };

    const ipaSyl = { ...baseSyl };
    syncSyllableTextFromSegments(ipaSyl, ['tʂʰ', 'ɑ', 'u']);
    expect(ipaSyl.text).toBe('[tʂʰuu˧˥]');
    expect(ipaSyl.ipa).toEqual(['tʂʰ', 'u', 'u']);

    const bareSyl = {
      ...baseSyl,
      text: 'tʂʰɑu˧˥',
      segments: [
        { ...baseSeg, id: 'p0', ipa: 'tʂʰ' },
        { ...baseSeg, id: 'p1', ipa: 'i' },
      ],
    };
    syncSyllableTextFromSegments(bareSyl, ['tʂʰ', 'ɑ', 'u']);
    expect(bareSyl.text).toBe('tʂʰi˧˥');

    const hanziSyl = {
      ...baseSyl,
      text: '潮',
      segments: [
        { ...baseSeg, id: 'p0', ipa: 'tʂʰ' },
        { ...baseSeg, id: 'p1', ipa: 'u' },
      ],
    };
    syncSyllableTextFromSegments(hanziSyl, ['tʂʰ', 'ɑ', 'u']);
    expect(hanziSyl.text).toBe('潮');
  });

  it('deletes phonemes cleanly, resizes silence gaps without changing syllable durations, and slides syllables/phones into silence', () => {
    const project = createInitialProject();
    const clip = JSON.parse(JSON.stringify(project.clips[project.clip_order[0]]));
    const t = (ms: number) => msToSamples(ms);
    const baseSeg: SegmentAnchor = {
      id: 'p0',
      ipa: 'a',
      start_smp: 0,
      end_smp: t(100),
      role: 'nucleus',
      elastic: true,
      voiced: true,
      params: tractRecordToArray19(defaultTractParams()),
    };

    clip.start_smp = 0;
    clip.end_smp = t(1400);
    clip.syllable_order = ['syl_a', 'syl_b'];
    clip.syllables = {
      syl_a: {
        id: 'syl_a',
        text: '[tʂʰɑu˧˥]',
        ipa: ['tʂʰ', 'ɑ', 'u'],
        nucleus_index: 1,
        start_smp: t(0),
        end_smp: t(300),
        anchor: { policy: 'speech_timing' as const, lead_ms: null, bias_ms: 0 },
        segments: [
          { ...baseSeg, id: 'a0', ipa: 'tʂʰ', start_smp: t(0), end_smp: t(100), role: 'onset' as const, voiced: false },
          { ...baseSeg, id: 'a1', ipa: 'ɑ', start_smp: t(100), end_smp: t(200), role: 'nucleus' as const, voiced: true },
          { ...baseSeg, id: 'a2', ipa: 'u', start_smp: t(200), end_smp: t(300), role: 'coda' as const, voiced: true },
        ],
        targets: [],
        overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
      },
      syl_b: {
        id: 'syl_b',
        text: '[daŋ]',
        ipa: ['d', 'a', 'ŋ'],
        nucleus_index: 1,
        start_smp: t(700),
        end_smp: t(1100),
        anchor: { policy: 'speech_timing' as const, lead_ms: null, bias_ms: 0 },
        segments: [
          { ...baseSeg, id: 'b0', ipa: 'd', start_smp: t(700), end_smp: t(800), role: 'onset' as const, voiced: true },
          { ...baseSeg, id: 'b1', ipa: 'a', start_smp: t(800), end_smp: t(950), role: 'nucleus' as const, voiced: true },
          { ...baseSeg, id: 'b2', ipa: 'ŋ', start_smp: t(950), end_smp: t(1100), role: 'coda' as const, voiced: true },
        ],
        targets: [],
        overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
      },
    };
    const controls = { phonation_anchors: {}, f0_pins: [] };

    // 1. Resizing inter-syllable silence gap [300, 700] to 150 ms preserves both syllable durations exactly
    const resized = resizeAnnotationSilenceGap(clip, t(300), t(700), t(150), controls);
    expect(resized.clip.syllables.syl_a.end_smp - resized.clip.syllables.syl_a.start_smp).toBe(t(300));
    expect(resized.clip.syllables.syl_b.start_smp).toBe(t(450));
    expect(resized.clip.syllables.syl_b.end_smp - resized.clip.syllables.syl_b.start_smp).toBe(t(400));
    expect(resized.clip.end_smp).toBe(t(1150));

    // 2. Sliding whole syllable syl_b inside its left/right silence gaps (300..700 left, 1100..1400 right)
    const sylBounds = getSyllableSlideBounds(clip, ['syl_b']);
    expect(sylBounds).toEqual({ minDelta: -t(400), maxDelta: t(300) });
    const slidLeft = slideAnnotationSyllables(clip, ['syl_b'], -t(600), controls);
    expect(slidLeft).not.toBeNull();
    expect(slidLeft!.clip.syllables.syl_b.start_smp).toBe(t(300));
    expect(slidLeft!.clip.syllables.syl_b.end_smp).toBe(t(700));
    expect(slidLeft!.clip.syllables.syl_a.end_smp).toBe(t(300));

    // 3. Sliding first phone [d] left into silence gap keeps [d] duration invariant & opens internal gap
    const dBounds = getPhoneSlideBounds(clip, ['b0']);
    expect(dBounds).toEqual({ minDelta: -t(400), maxDelta: 0 });
    const slidD = slideAnnotationPhones(clip, ['b0'], -t(150), controls);
    expect(slidD).not.toBeNull();
    expect(slidD!.clip.syllables.syl_b.segments[0].start_smp).toBe(t(550));
    expect(slidD!.clip.syllables.syl_b.segments[0].end_smp).toBe(t(650));
    expect(slidD!.clip.syllables.syl_b.segments[1].start_smp).toBe(t(800));
    // Sliding middle phone [a] when touching both neighbors returns null
    expect(getPhoneSlideBounds(clip, ['b1'])).toBeNull();

    // 4. Deleting a single phoneme shrinks syllable, shifts subsequent syllable, and syncs IPA syllable label
    const deleted = deleteAnnotationSegments(clip, ['a1'], controls);
    expect(deleted).not.toBeNull();
    expect(deleted!.deletedCount).toBe(1);
    expect(deleted!.clip.syllables.syl_a.text).toBe('[tʂʰu˧˥]');
    expect(deleted!.clip.syllables.syl_a.segments.map((s) => s.ipa)).toEqual(['tʂʰ', 'u']);
    expect(deleted!.clip.syllables.syl_b.start_smp).toBe(t(600));

    // 5. Rejects deleting every phoneme in the clip
    expect(deleteAnnotationSegments(clip, ['a0', 'a1', 'a2', 'b0', 'b1', 'b2'], controls)).toBeNull();
  });

  it('enables local neural reference_inpaint only when reconstructed clip phones are edited and preserves untouched spans as anchors', () => {
    const project = createInitialProject();
    const clip = JSON.parse(JSON.stringify(project.clips[project.clip_order[0]]));
    const t = (ms: number) => msToSamples(ms);
    const baseSeg: SegmentAnchor = {
      id: 'p0',
      ipa: 'a',
      start_smp: 0,
      end_smp: t(200),
      role: 'nucleus',
      elastic: true,
      voiced: true,
      params: tractRecordToArray19(defaultTractParams()),
    };
    clip.start_smp = 0;
    clip.end_smp = t(600);
    clip.syllable_order = ['s0'];
    clip.syllables = {
      s0: {
        id: 's0',
        text: '测试',
        ipa: ['tʂʰ', 'ɑ', 'u'],
        nucleus_index: 1,
        start_smp: 0,
        end_smp: t(600),
        anchor: { policy: 'speech_timing' as const, lead_ms: null, bias_ms: 0 },
        segments: [
          { ...baseSeg, id: 'p0', ipa: 'tʂʰ', start_smp: t(0), end_smp: t(200), role: 'onset' as const, voiced: false },
          { ...baseSeg, id: 'p1', ipa: 'ɑ', start_smp: t(200), end_smp: t(400), role: 'nucleus' as const, voiced: true },
          { ...baseSeg, id: 'p2', ipa: 'u', start_smp: t(400), end_smp: t(600), role: 'coda' as const, voiced: true },
        ],
        targets: [],
        overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
      },
    };
    // 30 frames at 50 Hz = 600 ms; simulate a real reconstructed 27-D trajectory where p1 originally had voiceless/low pressure
    const refRows = Array.from({ length: 30 }, () => {
      const row = new Array(27).fill(0);
      row[17] = 180; // F0
      row[18] = 0; // PR = 0 (voiceless original frame)
      row[19] = 0.08; // open glottis
      return row;
    });
    const baseline = JSON.parse(JSON.stringify(clip));

    const fallback = {
      f0Hz: 180,
      tract: tractRecordToArray19(defaultTractParams()),
      releaseTract: tractRecordToArray19(defaultTractParams()),
      lipWidth: 1,
      larynxHeight: 0,
    };

    // Untouched reconstructed clip: pure reference playback, no neural inpainting
    const untouchedRes = buildAnnotationSynthesis(
      project,
      clip,
      [],
      0,
      t(600),
      fallback,
      { m27RowsPa: refRows, durationSmp: t(600), editedPhoneIds: [] },
      'model',
    );
    expect(untouchedRes.ok).toBe(true);
    if (!untouchedRes.ok) return;
    expect('predict_articulation' in untouchedRes.value).toBe(false);
    expect('reference_inpaint' in untouchedRes.value).toBe(false);

    // Edited phoneme p1: activates local neural reference_inpaint, marks untouched p0/p2 as reference_anchor,
    // keeps edited p1 unlocked in 'model' mode, and avoids copying old voiceless glottis/pressure on edited frames.
    const editedRes = buildAnnotationSynthesis(
      project,
      clip,
      [],
      0,
      t(600),
      fallback,
      { m27RowsPa: refRows, durationSmp: t(600), editedPhoneIds: ['p1'] },
      'model',
    );
    expect(editedRes.ok).toBe(true);
    if (!editedRes.ok) return;
    const edited = editedRes.value;
    expect('predict_articulation' in edited && edited.predict_articulation).toBe(true);
    expect('reference_inpaint' in edited && edited.reference_inpaint).toBe(true);
    if (!('reference_inpaint' in edited)) return;
    expect(edited.inpaint_spans?.length).toBe(1);
    const spans = edited.articulation_spans ?? [];
    const spanP0 = spans.find((s) => s.ipa === 'tʂʰ');
    const spanP1 = spans.find((s) => s.ipa === 'ɑ');
    const spanP2 = spans.find((s) => s.ipa === 'u');
    expect(spanP0?.reference_anchor).toBe(true);
    expect(spanP2?.reference_anchor).toBe(true);
    expect(spanP1?.reference_anchor).toBeUndefined();
    expect(spanP1?.locked).toBe(false);
    expect(spanP1?.pose_target_19).toBeUndefined();
    // Edited midpoint frame (frame 60 at 200 Hz = 300 ms) should carry ordinary voiced pressure (> 0), not old 0 Pa
    expect(edited.pressure_pa[60]).toBeGreaterThan(100);
  });

  it('copies and pastes phonemes and syllables via timeline clipboard with unique IDs and silence-gap-aware insertion', () => {
    const project = createInitialProject();
    const clip = JSON.parse(JSON.stringify(project.clips[project.clip_order[0]]));
    const t = (ms: number) => msToSamples(ms);
    const baseSeg: SegmentAnchor = {
      id: 'p0',
      ipa: 'a',
      start_smp: 0,
      end_smp: t(100),
      role: 'nucleus',
      elastic: true,
      voiced: true,
      params: tractRecordToArray19(defaultTractParams()),
    };
    clip.start_smp = 0;
    clip.end_smp = t(1200);
    clip.syllable_order = ['s_left', 's_right'];
    clip.syllables = {
      s_left: {
        id: 's_left',
        text: '[ma]',
        ipa: ['m', 'a'],
        nucleus_index: 1,
        start_smp: t(0),
        end_smp: t(200),
        anchor: { policy: 'speech_timing' as const, lead_ms: null, bias_ms: 0 },
        segments: [
          { ...baseSeg, id: 'l0', ipa: 'm', start_smp: t(0), end_smp: t(80), role: 'onset' as const, voiced: true },
          { ...baseSeg, id: 'l1', ipa: 'a', start_smp: t(80), end_smp: t(200), role: 'nucleus' as const, voiced: true },
        ],
        targets: [],
        overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
      },
      s_right: {
        id: 's_right',
        text: '[da]',
        ipa: ['d', 'a'],
        nucleus_index: 1,
        start_smp: t(800),
        end_smp: t(1000),
        anchor: { policy: 'speech_timing' as const, lead_ms: null, bias_ms: 0 },
        segments: [
          { ...baseSeg, id: 'r0', ipa: 'd', start_smp: t(800), end_smp: t(880), role: 'onset' as const, voiced: true },
          { ...baseSeg, id: 'r1', ipa: 'a', start_smp: t(880), end_smp: t(1000), role: 'nucleus' as const, voiced: true },
        ],
        targets: [],
        overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
      },
    };
    const controls = { phonation_anchors: {}, f0_pins: [] };
    let seq = 0;
    const makeId = (prefix: string) => `${prefix}_copy_${++seq}`;

    // 1. Copy whole syllable s_left (200 ms) and paste into roomy silence gap at 300 ms -> s_right stays at 800 ms!
    const copiedSyl = copyAnnotationSelection(clip, { syllableIds: ['s_left'] }, controls);
    expect(copiedSyl?.kind).toBe('syllables');
    const pastedSyl = pasteAnnotationClipboard(clip, copiedSyl!, { playheadSmp: t(300) }, controls, makeId);
    expect(pastedSyl).not.toBeNull();
    expect(pastedSyl!.clip.syllable_order.length).toBe(3);
    const insertedId = pastedSyl!.pastedSyllableIds[0];
    expect(insertedId).not.toBe('s_left');
    expect(pastedSyl!.clip.syllables[insertedId].start_smp).toBe(t(300));
    expect(pastedSyl!.clip.syllables[insertedId].end_smp).toBe(t(500));
    expect(pastedSyl!.clip.syllables.s_right.start_smp).toBe(t(800));

    // 2. Copy single phone [m] (80 ms) and paste after [d] in s_right -> s_right becomes [dma] & shifts cleanly
    const copiedPhone = copyAnnotationSelection(clip, { phoneIds: ['l0'] }, controls);
    expect(copiedPhone?.kind).toBe('phones');
    const pastedPhone = pasteAnnotationClipboard(
      clip,
      copiedPhone!,
      { playheadSmp: t(880), afterPhoneId: 'r0' },
      controls,
      makeId,
    );
    expect(pastedPhone).not.toBeNull();
    expect(pastedPhone!.clip.syllables.s_right.segments.map((s) => s.ipa)).toEqual(['d', 'm', 'a']);
    expect(pastedPhone!.clip.syllables.s_right.text).toBe('[dma]');
    expect(pastedPhone!.clip.syllables.s_right.end_smp).toBe(t(1080));
  });

  it('splits Japanese narrow yoon glides and centralized compressed u cleanly and centralizes TCX', () => {
    expect(splitPhoneNotation('kʲjo̞')).toEqual(['kʲ', 'j', 'o̞']);
    expect(splitPhoneNotation('sɯ̈ᵝ')).toEqual(['s', 'ɯ̈ᵝ']);
    expect(splitPhoneNotation('sɯ̥̈ᵝ')).toEqual(['s', 'ɯ̥̈ᵝ']);
    expect(splitPhoneNotation('kʷɰᵝä')).toEqual(['kʷ', 'ɰᵝ', 'ä']);

    const voicedU = phoneTraits('ɯ̈ᵝ');
    expect(voicedU.vowel).toBe(true);
    expect(voicedU.voiced).toBe(true);

    const devoicedU = phoneTraits('ɯ̥̈ᵝ');
    expect(devoicedU.vowel).toBe(true);
    expect(devoicedU.voiced).toBe(false);

    const baseU = tractRecordToArray19({ ...defaultTractParams(), TCX: 0.1, TCY: -1.04, LP: 0.13, LD: 0.69 });
    const compressedU = applyJd2DiacriticModifiers('ɯᵝ', baseU);
    const centralizedU = applyJd2DiacriticModifiers('ɯ̈ᵝ', baseU);
    expect(centralizedU[8]).toBeGreaterThan(compressedU[8]);
  });

  it('referenceNose staticSegments contains zero spurious diagonal strip-cut chords and matches public mirror', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const geom = (await import('../packages/vocal-tract-view/geometry.mjs')) as unknown as {
      nasalOutlet: (nose: Record<string, unknown>) => number[];
      referenceNose: (nose: Record<string, unknown>, outlet: number[]) => { staticSegments: [number[], number[]][] };
    };
    const { registerNose } = (await import('../packages/vocal-tract-view/anatomy.mjs')) as unknown as {
      registerNose: (nose: Record<string, unknown>) => Record<string, unknown>;
    };

    const nosePath = path.resolve(process.cwd(), 'packages/vocal-tract-view/assets/nasal.json');
    const nose = JSON.parse(fs.readFileSync(nosePath, 'utf8'));
    Object.assign(nose, registerNose(nose));
    const outlet = geom.nasalOutlet(nose);
    const ref = geom.referenceNose(nose, outlet);
    const maxSeg = Math.max(
      ...ref.staticSegments.map(([a, b]: [number[], number[]]) => Math.hypot(a[0] - b[0], a[1] - b[1])),
    );
    expect(maxSeg).toBeLessThan(1.5);

    for (const file of ['geometry.mjs', 'anatomy.mjs', 'scene.js', 'embed.mjs']) {
      const pkgBytes = fs.readFileSync(path.resolve(process.cwd(), 'packages/vocal-tract-view', file));
      const pubBytes = fs.readFileSync(path.resolve(process.cwd(), 'public/vocal-tract', file));
      expect(pkgBytes.equals(pubBytes), `public/vocal-tract/${file} mirror parity`).toBe(true);
    }
  });

  it('defaults textPoseSource to auto and switches per syllable between text (model) and bracketed [IPA] (current)', () => {
    expect(textPoseSource.value).toBe('auto');
    expect(textPoseOptions.map((o) => o.value)).toEqual(['auto', 'model', 'current']);
    expect(textPoseOptions[0].label).toBe('自动切换');

    expect(isBracketedIpaSyllable({ text: '今' })).toBe(false);
    expect(isBracketedIpaSyllable({ text: 'What' })).toBe(false);
    expect(isBracketedIpaSyllable({ text: 'きょ' })).toBe(false);
    expect(isBracketedIpaSyllable({ text: '[ljɯb]' })).toBe(true);
    expect(isBracketedIpaSyllable({ text: '［ˈnɔməl］' })).toBe(true);

    expect(resolveSyllablePoseSource('auto', { text: '今' })).toBe('model');
    expect(resolveSyllablePoseSource('auto', { text: '[ljɯb]' })).toBe('current');
    expect(resolveSyllablePoseSource('model', { text: '[ljɯb]' })).toBe('model');
    expect(resolveSyllablePoseSource('current', { text: '今' })).toBe('current');

    const params19 = tractRecordToArray19(defaultTractParams());
    const t = (ms: number) => msToSamples(ms);
    const makeSyl = (id: string, text: string, startMs: number, endMs: number, ipa: string) => ({
      id,
      text,
      ipa: [ipa],
      nucleus_index: 0,
      start_smp: t(startMs),
      end_smp: t(endMs),
      anchor: { policy: 'speech_timing' as const, lead_ms: null, bias_ms: 0 },
      segments: [
        {
          id: `${id}_seg`,
          ipa,
          start_smp: t(startMs),
          end_smp: t(endMs),
          role: 'nucleus' as const,
          elastic: true,
          voiced: true,
          params: [...params19],
        },
      ],
      targets: [],
      overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
    });

    const fallback = {
      f0Hz: 165,
      tract: [...params19],
      releaseTract: [...params19],
      lipWidth: 1,
      larynxHeight: 0,
    };

    const buildWithSyllables = (
      syls: ReturnType<typeof makeSyl>[],
      poseSource: 'auto' | 'model' | 'current',
    ) => {
      const project = createInitialProject();
      const clipId = project.clip_order[0];
      const clip = project.clips[clipId];
      clip.start_smp = 0;
      clip.end_smp = syls[syls.length - 1].end_smp;
      clip.syllable_order = syls.map((s) => s.id);
      clip.syllables = Object.fromEntries(syls.map((s) => [s.id, s]));
      const res = buildAnnotationSynthesis(
        project,
        clip,
        [],
        0,
        clip.end_smp,
        fallback,
        undefined,
        poseSource,
      );
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('unexpected error');
      return res.value;
    };

    // 1. Pure plain text in auto mode -> identical to model mode (omits pose_source & pose_target_19)
    const pureTextAuto = buildWithSyllables(
      [makeSyl('s1', '今', 0, 180, 'a'), makeSyl('s2', 'What', 180, 360, 'i')],
      'auto',
    );
    expect('pose_source' in pureTextAuto ? pureTextAuto.pose_source : undefined).toBeUndefined();
    const pureTextSpans = 'articulation_spans' in pureTextAuto ? (pureTextAuto.articulation_spans ?? []) : [];
    expect(pureTextSpans.length).toBeGreaterThan(0);
    expect(pureTextSpans.every((sp) => sp.pose_target_19 === undefined)).toBe(true);

    // 2. Pure bracketed [IPA] in auto mode -> custom pose_source with pose_target_19 on every IPA span
    const pureIpaAuto = buildWithSyllables([makeSyl('s1', '[ljɯb]', 0, 200, 'a')], 'auto');
    expect('pose_source' in pureIpaAuto ? pureIpaAuto.pose_source : undefined).toBe('custom');
    const ipaNonSilence = ('articulation_spans' in pureIpaAuto ? (pureIpaAuto.articulation_spans ?? []) : [])
      .filter((sp) => sp.phase !== 'silence');
    expect(ipaNonSilence.length).toBeGreaterThan(0);
    expect(ipaNonSilence.every((sp) => Array.isArray(sp.pose_target_19))).toBe(true);

    // 3. Mixed text + [IPA] in one clip -> custom pose_source, pose_target_19 ONLY on [IPA] spans
    const mixedAuto = buildWithSyllables(
      [
        makeSyl('s1', '今', 0, 160, 'a'),
        makeSyl('s2', '[ljɯb]', 160, 340, 'u'),
        makeSyl('s3', 'What', 340, 500, 'i'),
      ],
      'auto',
    );
    expect('pose_source' in mixedAuto ? mixedAuto.pose_source : undefined).toBe('custom');
    const mixedSpans = ('articulation_spans' in mixedAuto ? (mixedAuto.articulation_spans ?? []) : [])
      .filter((sp) => sp.phase !== 'silence');
    const textSpans = mixedSpans.filter((sp) => sp.ipa === 'a' || sp.ipa === 'i');
    const bracketSpans = mixedSpans.filter((sp) => sp.ipa === 'u');
    expect(textSpans.length).toBeGreaterThan(0);
    expect(bracketSpans.length).toBeGreaterThan(0);
    expect(textSpans.every((sp) => sp.pose_target_19 === undefined)).toBe(true);
    expect(bracketSpans.every((sp) => Array.isArray(sp.pose_target_19))).toBe(true);
  });

  it('routes arranger Chinese/English/Japanese lyrics to model default poses and [IPA] lyrics to current IPA poses under auto', async () => {
    const { compileArrangement } = await import('@/components/studio/arranger-compile');
    const project = createInitialProject();
    const voiceId = project.voice_order[0];
    const beatSmp = msToSamples(500);
    const makeNote = (rowIdx: number, hz: number) => ({
      rowIdx,
      hz,
      startSmp: msToSamples(105) + rowIdx * beatSmp,
      endSmp: msToSamples(105) + (rowIdx + 1) * beatSmp,
      dynamic: 0,
      pressurePa: 820,
    });
    const compiled = compileArrangement(
      {
        ok: true,
        issueMsg: '',
        voice: {
          rows: [
            { char: '汉', ipa: 'xan', language: 'zh' },
            { char: 'hel', ipa: 'hɛl', language: 'en' },
            { char: 'あ', ipa: 'a', language: 'ja' },
          ],
          lyricsText: '汉 hel あ',
          fullScoreStr: '《1》 《2》 《3》',
        },
        notes: [makeNote(0, 261.63), makeNote(1, 293.66), makeNote(2, 329.63)],
        endSmp: msToSamples(105) + 3 * beatSmp,
      },
      {
        clipId: 'arranger_plain_lyrics',
        speakerId: voiceId,
        speaker: 'JD2',
        bpm: 120,
        tonic: 'C3',
        referenceHz: 165,
        leadEnabled: true,
        leadMs: 75,
        biasMs: 0,
        dampingRate: 32,
        vibrato: false,
      },
    );
    expect(compiled.clip).toBeDefined();
    const params19 = tractRecordToArray19(defaultTractParams());
    const fallback = { f0Hz: 165, tract: params19, releaseTract: params19, lipWidth: 1, larynxHeight: 0 };
    const plainPlan = buildAnnotationSynthesis(
      project,
      compiled.clip!,
      [],
      0,
      compiled.clip!.end_smp,
      fallback,
      undefined,
      'auto',
    );
    expect(plainPlan.ok).toBe(true);
    if (!plainPlan.ok) return;
    expect('pose_source' in plainPlan.value ? plainPlan.value.pose_source : undefined).toBeUndefined();
    const plainSpans = 'articulation_spans' in plainPlan.value ? (plainPlan.value.articulation_spans ?? []) : [];
    expect(plainSpans.length).toBeGreaterThan(0);
    expect(plainSpans.every((sp) => sp.pose_target_19 === undefined)).toBe(true);

    // Mixed lyric track: plain Chinese/Japanese text uses model default, explicit [IPA] keeps current IPA pose
    const mixedCompiled = compileArrangement(
      {
        ok: true,
        issueMsg: '',
        voice: {
          rows: [
            { char: '汉', ipa: 'xan', language: 'zh' },
            { char: '[pʰa]', ipa: 'pʰa', language: 'ipa' },
            { char: 'あ', ipa: 'a', language: 'ja' },
          ],
          lyricsText: '汉 [pʰa] あ',
          fullScoreStr: '《1》 《2》 《3》',
        },
        notes: [makeNote(0, 261.63), makeNote(1, 293.66), makeNote(2, 329.63)],
        endSmp: msToSamples(105) + 3 * beatSmp,
      },
      {
        clipId: 'arranger_mixed_lyrics',
        speakerId: voiceId,
        speaker: 'JD2',
        bpm: 120,
        tonic: 'C3',
        referenceHz: 165,
        leadEnabled: true,
        leadMs: 75,
        biasMs: 0,
        dampingRate: 32,
        vibrato: false,
      },
    );
    expect(mixedCompiled.clip).toBeDefined();
    const mixedPlan = buildAnnotationSynthesis(
      project,
      mixedCompiled.clip!,
      [],
      0,
      mixedCompiled.clip!.end_smp,
      fallback,
      undefined,
      'auto',
    );
    expect(mixedPlan.ok).toBe(true);
    if (!mixedPlan.ok) return;
    expect('pose_source' in mixedPlan.value ? mixedPlan.value.pose_source : undefined).toBe('custom');
    const mixedSpans = ('articulation_spans' in mixedPlan.value ? (mixedPlan.value.articulation_spans ?? []) : [])
      .filter((sp) => sp.phase !== 'silence');
    const ipaSpan = mixedSpans.find((sp) => sp.ipa === 'pʰ');
    const zhSpan = mixedSpans.find((sp) => sp.ipa === 'x');
    const jaSpan = mixedSpans.filter((sp) => sp.ipa === 'a').at(-1);
    expect(ipaSpan?.pose_target_19).toBeDefined();
    expect(zhSpan?.pose_target_19).toBeUndefined();
    expect(jaSpan?.pose_target_19).toBeUndefined();
  });
});
