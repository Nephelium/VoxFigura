import { describe, expect, it } from 'vitest';
import {
  CANTONESE_DIALECT_PACK,
  CommandBus,
  MANDARIN_DIALECT_PACK,
  PHONATION_M27_ANCHORS,
  PHONATION_REGIMES,
  SAMPLE_RATE_HZ,
  alignContinuumLandmarks,
  applyDialectSandhi,
  buildContinuum2D,
  calibrateMonosyllableTone,
  evalF0,
  evalQtaSegmentAt,
  evaluatePhonationAnchorsAt,
  heldPhonationAt,
  exportPitchTier,
  exportSubtitles,
  getRulesByTopic,
  importPtbVocalJson,
  parseChannelAProposalBlocks,
  parseNumberedScore,
  parsePitchTier,
  parseTextGrid,
  parseVcProject,
  projectToTextGrid,
  retime,
  schedule,
  serializeVcProject,
  stringifyTextGrid,
  toneLevelsToQtaTargets,
  type ContinuumLandmark,
  type PhonationAnchor,
  type VcProject,
} from '@vocalcut/core';
import {
  BrowserLightM27Slot,
  KF2TractSlot,
  VocalEngineTransport,
  mapComputeDeviceToTorch,
} from '@vocalcut/model-adapters';
import { evaluateControlPitch, setPianoNote } from '../src/components/research/control-pitch';

function makeStarterProject(): VcProject {
  return {
    schema: 'vocalcut/project',
    schema_version: 1,
    revision: 1,
    id: 'prj_test',
    name: 'Test Project',
    settings: {
      sample_rate_hz: SAMPLE_RATE_HZ,
      fps: 60,
      size_px: [1920, 1080],
      tempo_map: [{ tick: 0, bpm: 120 }],
      ppq: 480,
      time_signature: [4, 4],
      default_lead_policy: 'nucleus_on_beat',
      compute_device: 'wasm-cpu',
    },
    voice_order: ['vo_a'],
    voices: {
      vo_a: {
        id: 'vo_a',
        speaker: 'W02',
        dimension: '3d',
        geometry: 'm10/r21',
        sections: 65,
        preset_pack: { id: 'pk_default_ipa', sha256: 'builtin' },
        f0_ref_hz: 200,
        range_st: [-6, 14],
        seed: 20261120,
      },
    },
    asset_order: [],
    assets: {},
    track_order: ['tr_tg', 'tr_art', 'tr_phon', 'tr_f0', 'tr_ps', 'tr_sub'],
    tracks: {
      tr_tg: { id: 'tr_tg', kind: 'textgrid', voice_id: 'vo_a', tiers: ['syllable', 'phone'] },
      tr_art: { id: 'tr_art', kind: 'articulation', voice_id: 'vo_a', clip_order: ['cl_v1'] },
      tr_phon: { id: 'tr_phon', kind: 'phonation', voice_id: 'vo_a' },
      tr_f0: { id: 'tr_f0', kind: 'f0', voice_id: 'vo_a' },
      tr_ps: { id: 'tr_ps', kind: 'pressure', voice_id: 'vo_a' },
      tr_sub: { id: 'tr_sub', kind: 'subtitle' },
    },
    clip_order: ['cl_v1'],
    clips: {
      cl_v1: {
        id: 'cl_v1',
        kind: 'phrase',
        voice_id: 'vo_a',
        start_smp: 0,
        end_smp: 48000,
        variants: ['synth'],
        active_variant: 'synth',
        source: { lyrics: '好朵', lang: 'cmn' },
        syllable_order: ['sy_0001', 'sy_0002'],
        syllables: {
          sy_0001: {
            id: 'sy_0001',
            text: '好',
            ipa: ['x', 'aʊ'],
            nucleus_index: 1,
            start_smp: 0,
            end_smp: 24000,
            tone_levels: '21',
            anchor: { tick: 0, policy: 'nucleus_on_beat', lead_ms: 80, bias_ms: 0 },
            segments: [
              { id: 'sg_1_0', ipa: 'x', role: 'onset', start_smp: 0, end_smp: 4800, voiced: false, elastic: true },
              { id: 'sg_1_1', ipa: 'aʊ', role: 'nucleus', start_smp: 4800, end_smp: 24000, voiced: true, elastic: true },
            ],
            targets: [
              {
                id: 'qta_1',
                span_id: 'sy_0001',
                start_smp: 0,
                end_smp: 24000,
                voiced: true,
                candidates: { score: { m_st_per_s: 0, b_end_st: 4, lambda_per_s: 70, source: 'score' } },
              },
            ],
            overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
          },
          sy_0002: {
            id: 'sy_0002',
            text: '朵',
            ipa: ['t', 'w', 'ɔ'],
            nucleus_index: 2,
            start_smp: 24000,
            end_smp: 48000,
            tone_levels: '214',
            anchor: { tick: 480, policy: 'nucleus_on_beat', lead_ms: 80, bias_ms: 0 },
            segments: [
              {
                id: 'sg_2_0',
                ipa: 't',
                role: 'onset',
                start_smp: 24000,
                end_smp: 27840,
                voiced: false,
                elastic: false,
                stop_timing: { closure_ms: 60, release_ms: 8, aspiration_ms: 12, vot_ms: 20, auto_generated: true },
              },
              { id: 'sg_2_1', ipa: 'ɔ', role: 'nucleus', start_smp: 27840, end_smp: 48000, voiced: true, elastic: true },
            ],
            targets: [
              {
                id: 'qta_2',
                span_id: 'sy_0002',
                start_smp: 24000,
                end_smp: 48000,
                voiced: true,
                candidates: { score: { m_st_per_s: 0, b_end_st: 7, lambda_per_s: 70, source: 'score' } },
              },
            ],
            overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
          },
        },
      },
    },
    layer_order: ['ly_sub'],
    layers: {
      ly_sub: { id: 'ly_sub', kind: 'subtitle', z_index: 10, visible: true },
    },
    phonation_anchor_order: ['ph_1', 'ph_2'],
    phonation_anchors: {
      ph_1: { id: 'ph_1', t_smp: 0, regime: 'modal', blend: 1, syllable_id: 'sy_0001' },
      ph_2: { id: 'ph_2', t_smp: 38400, regime: 'modal', blend: 1, syllable_id: 'sy_0002' },
    },
    render: {
      container: 'mp4',
      video: 'h264',
      audio: 'aac',
      safe_margin_px: [96, 54],
      max_width_px: 1920,
      max_height_px: 1080,
    },
  };
}

describe('VocalCut Core Kernel Tests', () => {
  it('1. 120 BPM 4800 / 28800 采样踩拍与 80 ms 字头前置 (0.520 s)', () => {
    const res = schedule({
      bpm: 120,
      leading_reserve_ms: 100, // 4800 samples @ 48 kHz
      f_ref_hz: 200,
      syllables: [
        {
          id: 'sy_1',
          text: '好',
          note_hz: 261.63,
          note_beats: 1,
          segments: [
            { id: 'sg_1_v', ipa: 'a', role: 'nucleus', voiced: true, preferred_ms: 400 },
          ],
        },
        {
          id: 'sy_2',
          text: '来',
          note_hz: 293.66,
          note_beats: 1,
          segments: [
            { id: 'sg_2_l', ipa: 'l', role: 'onset', voiced: true, preferred_ms: 80 },
            { id: 'sg_2_v', ipa: 'aɪ', role: 'nucleus', voiced: true, preferred_ms: 400 },
          ],
        },
      ],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.leading_reserve_smp).toBe(4800);
    expect(res.value.syllables[0].nucleus_start_smp).toBe(4800);
    expect(res.value.syllables[1].nucleus_start_smp).toBe(28800);

    const segL = res.value.segments.find((s) => s.id === 'sg_2_l')!;
    expect(segL.start_smp).toBe(24960); // 0.520 s * 48000 = 24960
    expect(segL.end_smp).toBe(28800);
  });

  it('2. qTA 阶跃精度 (< 1 ms 残余误差)、连续性与普通话斜调无跑飞及单字调校准', () => {
    // Step response test: lambda=80, step from 0 st to +6 st over 0.15 s -> >99% settled
    const d = 0.15;
    const stepEnd = evalQtaSegmentAt(d, d, 0, 6, 80, { y: 0, yp: 0, ypp: 0 });
    expect(Math.abs(stepEnd.y - 6)).toBeLessThan(0.01);

    // Timing accuracy: at 90% completion (lambda * t = 5.322 -> t = 66.5 ms for lambda=80)
    const t90 = 5.322 / 80;
    const at90 = evalQtaSegmentAt(t90, 0.5, 0, 10, 80, { y: 0, yp: 0, ypp: 0 });
    expect(at90.y).toBeCloseTo(9.0, 1);

    // Mandarin oblique tone 35 & 51 with b_end intercept: stays strictly bounded, no runaway
    const targets35 = toneLevelsToQtaTargets('35', 0.25, [-6, 4]);
    expect(targets35).toHaveLength(1);
    expect(targets35[0].candidate.b_end_st).toBeCloseTo(4, 5);

    const targets214 = toneLevelsToQtaTargets('214', 0.3, [-6, 4]);
    expect(targets214).toHaveLength(2);

    // Calibrate monosyllable tone so surface offset hits desired target
    const calibrated = calibrateMonosyllableTone(targets35[0].candidate, 0.25, 4, -1);
    const realized = evalQtaSegmentAt(0.25, 0.25, calibrated.m_st_per_s, calibrated.b_end_st, calibrated.lambda_per_s, {
      y: -1,
      yp: 0,
      ypp: 0,
    });
    expect(Math.abs(realized.y - 4)).toBeLessThan(0.01);

    // Multi-layer evalF0: L1 priority (user > transfer > score > default), L3 PCHIP + Pin exit feedback, L4 vibrato
    const f0Res = evalF0({
      total_smp: 48000,
      step_smp: 240,
      f_ref_hz: 200,
      context: 'speech',
      spans: [
        {
          id: 'sp1',
          span_id: 'sy_1',
          start_smp: 0,
          end_smp: 24000,
          candidates: {
            default: { m_st_per_s: 0, b_end_st: 0, lambda_per_s: 50, source: 'default' },
            score: { m_st_per_s: 0, b_end_st: 2, lambda_per_s: 50, source: 'score' },
            user: { m_st_per_s: 0, b_end_st: 4, lambda_per_s: 55, source: 'user' },
          },
        },
        {
          id: 'sp2',
          span_id: 'sy_2',
          start_smp: 24000,
          end_smp: 48000,
          candidates: {
            default: { m_st_per_s: -20, b_end_st: -2, lambda_per_s: 45, source: 'default' },
          },
        },
      ],
      residuals: [
        {
          id: 'r1',
          span_id: 'sy_1',
          feather_ms: 30,
          points: [{ u: 0.2, st: 0 }, { u: 0.5, st: 1.5 }, { u: 0.8, st: 0 }],
        },
      ],
      pins: [
        {
          id: 'pin1',
          start_smp: 12000,
          end_smp: 24000,
          transition_ms: 30,
          exit_fit_ms: 35,
          points: [
            { t_smp: 12000, f0_hz: 250 },
            { t_smp: 18000, f0_hz: 270 },
            { t_smp: 24000, f0_hz: 260 },
          ],
        },
      ],
      vibrato: { enabled: true, rate_hz: 5.5, depth_cents: 25 },
    });
    expect(f0Res.ok).toBe(true);
    if (!f0Res.ok) return;
    expect(f0Res.value.resolved_spans[0].candidate.source).toBe('user');
    // Continuity across span boundary (24000 smp -> index 100 vs 99)
    const diffSt = Math.abs(f0Res.value.f0_st[100] - f0Res.value.f0_st[99]);
    expect(diffSt).toBeLessThan(0.5);
  });

  it('3. p–fff 与 (1p23)ff 音强优先级及密集数组突破 201 点上限', () => {
    const parsed = parseNumberedScore('(1p23)ff 5 6fff', 'C3', 120, false, 3);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // In (1p23)ff: note 0 ('1p') keeps -1 (p), notes 1 & 2 ('2','3') inherit +2 (ff)
    expect(parsed.score.notes[0].dynamic).toBe(-1);
    expect(parsed.score.notes[1].dynamic).toBe(2);
    expect(parsed.score.notes[2].dynamic).toBe(2);
    expect(parsed.score.notes[3].midi).toBeNull();
    expect(parsed.score.notes[6].dynamic).toBe(3); // 6fff -> +3

    // Schedule 6-second sequence -> > 1000 dense points (exceeding legacy 201-point ceiling)
    const sched = schedule({
      bpm: 120,
      f_ref_hz: 200,
      base_pressure_pa: 800,
      syllables: Array.from({ length: 12 }, (_, idx) => ({
        id: `sy_${idx}`,
        text: '啊',
        note_hz: 261.63,
        note_beats: 1,
        dynamic_level: idx === 0 ? -1 : idx === 1 ? 2 : 0, // p (-120 Pa) vs ff (+240 Pa)
        segments: [{ id: `sg_${idx}`, ipa: 'a', role: 'nucleus', voiced: true, preferred_ms: 400 }],
      })),
    });
    expect(sched.ok).toBe(true);
    if (!sched.ok) return;

    expect(sched.value.f0_hz.length).toBeGreaterThan(1000);
    expect(sched.value.pressure_pa.length).toBe(sched.value.f0_hz.length);
    expect(sched.value.syllables[0].pressure_pa).toBe(680);  // 800 - 120
    expect(sched.value.syllables[1].pressure_pa).toBe(1040); // 800 + 240
  });

  it('4. 6 档离散发声态直连 10 维 m27 插值（绝不经过中间档位）', () => {
    expect(PHONATION_REGIMES).toEqual(['pressed', 'modal', 'breathy', 'whisper', 'creaky', 'falsetto']);

    const anchors: PhonationAnchor[] = [
      { id: 'a1', t_smp: 0, regime: 'pressed', blend: 1 },
      { id: 'a2', t_smp: 48000, regime: 'falsetto', blend: 1 },
    ];
    const midRes = evaluatePhonationAnchorsAt(anchors, 24000);
    expect(midRes.ok).toBe(true);
    if (!midRes.ok) return;

    const p = PHONATION_M27_ANCHORS.pressed;
    const f = PHONATION_M27_ANCHORS.falsetto;
    // Direct linear midpoint in 10-D m27 space, completely bypassing modal/breathy/whisper/creaky
    expect(midRes.value.f0_hz).toBeCloseTo((p.f0_hz + f.f0_hz) / 2, 6);
    expect(midRes.value.pr_pa).toBeCloseTo((p.pr_pa + f.pr_pa) / 2, 6);
    expect(midRes.value.xb_cm).toBeCloseTo((p.xb_cm + f.xb_cm) / 2, 6);
    expect(midRes.value.ca_cm2).toBeCloseTo((p.ca_cm2 + f.ca_cm2) / 2, 6);
    expect(midRes.value.lag_rad).toBeCloseTo((p.lag_rad + f.lag_rad) / 2, 6);
    expect(midRes.value.ra).toBeCloseTo((p.ra + f.ra) / 2, 6);
    expect(midRes.value.shim).toBeCloseTo((p.shim + f.shim) / 2, 6);
    // Notice modal.ra is 1.0, whisper.ra is 0.0, whereas direct midpoint pressed<->falsetto is (1.0+0.48)/2 = 0.74
    expect(midRes.value.ra).toBeCloseTo(0.74, 6);
  });

  it('标注发声态在每个半开区间内保持至下一锚点', () => {
    const anchors: PhonationAnchor[] = [
      { id: 'a1', t_smp: 24000, regime: 'pressed', blend: 1 },
      { id: 'a2', t_smp: 48000, regime: 'falsetto', blend: 1 },
    ];
    expect(heldPhonationAt(anchors, 23999)).toEqual(PHONATION_M27_ANCHORS.modal);
    expect(heldPhonationAt(anchors, 24000)).toEqual(PHONATION_M27_ANCHORS.pressed);
    expect(heldPhonationAt(anchors, 47999)).toEqual(PHONATION_M27_ANCHORS.pressed);
    expect(heldPhonationAt(anchors, 48000)).toEqual(PHONATION_M27_ANCHORS.falsetto);
    expect(heldPhonationAt(anchors, 72000)).toEqual(PHONATION_M27_ANCHORS.falsetto);
  });

  it('卷帘精确音高覆盖模型钉点，同时保持选外控制基频', () => {
    const project = makeStarterProject();
    project.f0_pins = [{
      id: 'model',
      start_smp: 0,
      end_smp: 48000,
      points: [{ t_smp: 0, f0_hz: 200 }, { t_smp: 48000, f0_hz: 220 }],
      transition_ms: 30,
      exit_fit_ms: 35,
    }];
    const clip = project.clips.cl_v1;
    const original = clip.syllable_order.map((id) => clip.syllables[id]);
    const noteStart = 4800;
    const noteEnd = 24000;
    const updated = [setPianoNote(original[0], noteStart, noteEnd, 440, 200, 'n1'), original[1]];
    const before = evaluateControlPitch(project, original, clip.end_smp, 200);
    const after = evaluateControlPitch(project, updated, clip.end_smp, 200);
    expect(before.ok && after.ok).toBe(true);
    if (before.ok && after.ok) {
      for (const [index, sample] of after.value.times_smp.entries()) {
        expect(after.value.f0_hz[index]).toBeCloseTo(
          sample >= noteStart && sample < noteEnd ? 440 : before.value.f0_hz[index],
          10,
        );
      }
    }
    expect(updated[0].targets[0]).toBe(original[0].targets[0]);
    expect(updated[1]).toBe(original[1]);
  });

  it('5. 命令总线、AI 提案预演与全撤销逐字节一致', () => {
    const initial = makeStarterProject();
    const initialJson = JSON.stringify(initial);
    const bus = new CommandBus(initial);

    // Single command with RFC 6902 patch & inverse
    const cmd1 = bus.execute({
      op: 'artic.set_pose_delta',
      base_revision: 1,
      args: { syllable: 'sy_0002', seg: 1, delta: { TCY: -0.25 }, scope: ['tongue_body'] },
    });
    expect(cmd1.ok).toBe(true);
    expect(bus.getRevision()).toBe(2);

    // Stale base_revision must be rejected as conflict
    const stale = bus.execute({
      op: 'voice.set_glottis',
      base_revision: 1,
      args: { syllable_id: 'sy_0002', preset: 'breathy', blend: 0.6 },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('conflict');

    // AI proposal dry-run preview does not mutate live project
    const previewRes = bus.previewProposal([
      {
        op: 'voice.set_glottis',
        base_revision: 2,
        args: { syllable_id: 'sy_0002', u0: 0.6, u1: 1.0, preset: 'breathy', blend: 0.7 },
      },
      {
        op: 'voice.set_pressure',
        args: { syllable_id: 'sy_0002', points: [{ u: 0, pressure_pa: 800 }, { u: 1, pressure_pa: 520 }] },
      },
    ]);
    expect(previewRes.ok).toBe(true);
    expect(bus.getRevision()).toBe(2); // still untouched before commit

    if (!previewRes.ok) return;
    const committed = bus.commitProposal(previewRes.value);
    expect(committed.ok).toBe(true);
    expect(bus.getRevision()).toBe(3);

    // Undo proposal in 1 step, then undo cmd1 -> byte-for-byte identical to initial
    expect(bus.undo().ok).toBe(true);
    expect(bus.getRevision()).toBe(2);
    expect(bus.undo().ok).toBe(true);
    expect(bus.getRevision()).toBe(1);
    expect(JSON.stringify(bus.getProject())).toBe(initialJson);

    // Redo restores deterministically
    expect(bus.redo().ok).toBe(true);
    expect(bus.getRevision()).toBe(2);
  });

  it('6. 越界参数 (660 Hz / 1800 Pa / 塞音下限) 明确拒绝不夹紧', () => {
    // 660 Hz in evalF0
    const badF0 = evalF0({
      total_smp: 9600,
      f_ref_hz: 200,
      spans: [
        {
          id: 'sp',
          span_id: 'sy_bad',
          start_smp: 0,
          end_smp: 9600,
          candidates: { user: { m_st_per_s: 0, b_end_st: 12 * Math.log2(660 / 200), lambda_per_s: 80, source: 'user' } },
        },
      ],
    });
    expect(badF0.ok).toBe(false);
    if (!badF0.ok) {
      expect(badF0.error.code).toBe('out_of_range');
      expect(badF0.error.allowed).toEqual({ min: 60, max: 600, unit: 'Hz' });
    }

    // 660 Hz in CommandBus
    const bus = new CommandBus(makeStarterProject());
    const badCmd = bus.execute({
      op: 'f0.set_targets',
      base_revision: 1,
      args: { targets: [{ syllable_id: 'sy_0001', note_hz: 660 }] },
    });
    expect(badCmd.ok).toBe(false);
    if (!badCmd.ok) expect(badCmd.error.code).toBe('out_of_range');

    // 1800 Pa pressure in CommandBus
    const badPr = bus.execute({
      op: 'voice.set_pressure',
      base_revision: 1,
      args: { syllable_id: 'sy_0001', points: [{ u: 0.5, pressure_pa: 1800 }] },
    });
    expect(badPr.ok).toBe(false);
    if (!badPr.ok) expect(badPr.error.code).toBe('out_of_range');

    // Retime stop_timing below 10 ms closure + 1 ms release rigid floor -> blocked
    const clip = makeStarterProject().clips.cl_v1;
    const badRetime = retime(clip, {
      clip_id: 'cl_v1',
      syllable_id: 'sy_0002',
      segment_id: 'sg_2_0',
      new_end_smp: 24000 + 240, // 5 ms < 11 ms rigid floor
    });
    expect(badRetime.ok).toBe(false);
    if (!badRetime.ok) expect(badRetime.error.code).toBe('rigid_floor');
  });

  it('7. TextGrid (区间层+点层) / PitchTier / 字幕往返与 .vcproj/.ptb-vocal.json 兼容', () => {
    const proj = makeStarterProject();
    const tgDoc = projectToTextGrid(proj);
    const tgText = stringifyTextGrid(tgDoc);
    const parsedTg = parseTextGrid(tgText);

    expect(parsedTg.ok).toBe(true);
    if (!parsedTg.ok) return;
    expect(parsedTg.value.tiers).toHaveLength(3);
    expect(parsedTg.value.tiers[0].kind).toBe('IntervalTier');
    expect(parsedTg.value.tiers[1].kind).toBe('IntervalTier');
    expect(parsedTg.value.tiers[2].kind).toBe('TextTier');
    if (parsedTg.value.tiers[2].kind === 'TextTier') {
      expect(parsedTg.value.tiers[2].points).toHaveLength(2);
      expect(parsedTg.value.tiers[2].points[0].mark).toBe('modal');
    }

    // PitchTier round-trip
    const ptText = exportPitchTier([{ time_s: 0.1, f0_hz: 220 }, { time_s: 0.5, f0_hz: 280 }]);
    const ptParsed = parsePitchTier(ptText);
    expect(ptParsed.ok).toBe(true);
    if (ptParsed.ok) expect(ptParsed.value.points[1].f0_hz).toBe(280);

    // Subtitles & vcproj round-trip
    expect(exportSubtitles(proj, 'srt')).toContain('[xaʊ]');
    expect(exportSubtitles(proj, 'ass')).toContain('\\kf');
    expect(exportSubtitles(proj, 'lrc')).toContain('[00:00.00]');

    const vcParsed = parseVcProject(serializeVcProject(proj));
    expect(vcParsed.ok).toBe(true);

    // Legacy .ptb-vocal.json read-only import
    const legacy = importPtbVocalJson({
      speaker: 'JD2',
      frames: [
        { name: 'a', text: '啊', duration: 0.25, f0: 130, source: { mode: 'voiced', pressure_pa: 820 } },
      ],
    });
    expect(legacy.ok).toBe(true);
    if (legacy.ok) {
      expect(legacy.value.schema).toBe('vocalcut/project');
      expect(legacy.value.phonation_anchors.ph_sy_0001.regime).toBe('modal');
    }
  });

  it('8. 方言连读变调单次改写终止性 & 粤语入声不除阻标记', () => {
    const mandarinOut = applyDialectSandhi(MANDARIN_DIALECT_PACK, [
      { text: '一', tone_id: 'T1', domain_id: 'w1' },
      { text: '定', tone_id: 'T4', domain_id: 'w1' },
      { text: '好', tone_id: 'T3', domain_id: 'w2' },
      { text: '好', tone_id: 'T3', domain_id: 'w2', is_prepausal: true },
    ]);
    expect(mandarinOut.ok).toBe(true);
    if (!mandarinOut.ok) return;
    expect(mandarinOut.value[0].levels).toBe('35'); // "一" before T4 -> 35
    expect(mandarinOut.value[2].levels).toBe('35'); // T3 + T3 -> left becomes 35
    expect(mandarinOut.value[3].levels).toBe('214'); // prepausal T3 -> 214

    // Randomized stress test: each syllable rewritten at most once, strictly deterministic
    for (let trial = 0; trial < 20; trial++) {
      const seq = Array.from({ length: 8 }, (_, k) => ({
        text: k % 3 === 0 ? '不' : '字',
        tone_id: `T${(k + trial) % 4 + 1}`,
        domain_id: k < 4 ? 'd1' : 'd2',
      }));
      const r1 = applyDialectSandhi(MANDARIN_DIALECT_PACK, seq);
      const r2 = applyDialectSandhi(MANDARIN_DIALECT_PACK, seq);
      expect(r1).toEqual(r2);
    }

    // Cantonese checked tone unreleased coda
    const canto = applyDialectSandhi(CANTONESE_DIALECT_PACK, [{ text: '塞', tone_id: 'T7' }]);
    expect(canto.ok).toBe(true);
    if (canto.ok) {
      expect(canto.value[0].checked).toBe(true);
      expect(canto.value[0].coda_release).toBe('unreleased');
      expect(canto.value[0].dur_scale).toBe(0.5);
    }
  });

  it('9. 2D 连续统对齐、AI 提案解析、rules.get 与预留模型插槽回落契约', async () => {
    const lmA: ContinuumLandmark[] = [
      { slot_id: 'onset', role: 'frication_end_voicing_onset', ipa: 'ʈʂ', manner: 'affricate', articulator: 'coronal', t_ms: 80, params: Array(19).fill(0) },
      { slot_id: 'medial', role: 'medial', ipa: 'w', manner: 'approximant', articulator: 'labial', t_ms: 140, params: Array(19).fill(0.5) },
      { slot_id: 'nuc', role: 'nucleus', ipa: 'ɑ', manner: 'vowel', articulator: 'vowel', t_ms: 260, params: Array(19).fill(0.2) },
    ];
    const lmB: ContinuumLandmark[] = [
      { slot_id: 'onset', role: 'frication_end_voicing_onset', ipa: 'ʈʂ', manner: 'affricate', articulator: 'coronal', t_ms: 80, params: Array(19).fill(0) },
      { slot_id: 'nuc', role: 'nucleus', ipa: 'ɑ', manner: 'vowel', articulator: 'vowel', t_ms: 240, params: Array(19).fill(0.2) },
    ];
    const aligned = alignContinuumLandmarks(lmA, lmB);
    expect(aligned.find((x) => x.slot_id === 'medial')?.b.virtual).toBe(true);
    expect(aligned.find((x) => x.slot_id === 'onset')?.locked).toBe(true);

    const grid = buildContinuum2D({
      id: 'zhuang_zhang',
      label_a: '庄',
      label_b: '张',
      landmarks_a: lmA,
      landmarks_b: lmB,
      steps_a: 9,
      steps_b: 7,
      dim2: { kind: 'phonation', regime_a: 'modal', regime_b: 'breathy' },
    });
    expect(grid.ok).toBe(true);
    if (grid.ok) expect(grid.value.cells).toHaveLength(63);

    // Channel A JSON proposal parser
    const parsedProp = parseChannelAProposalBlocks(
      '建议如下：\n```json\n{"commands":[{"op":"voice.set_glottis","args":{"syllable_id":"sy_0002","preset":"breathy","blend":0.6}}]}\n```',
    );
    expect(parsedProp.ok).toBe(true);
    if (parsedProp.ok) expect(parsedProp.value.commands).toHaveLength(1);

    expect(getRulesByTopic('limits').ok).toBe(true);
    expect(getRulesByTopic('diagnosis').ok).toBe(true);

    // Model adapters: KF2TractSlot fallback + ComputeDevice mapping
    expect(mapComputeDeviceToTorch('webgpu-high')).toBe('cuda');
    expect(mapComputeDeviceToTorch('wasm-cpu')).toBe('cpu');

    const kfSlot = new KF2TractSlot({
      fetchImpl: async () => new Response(null, { status: 404 }),
    });
    const kfRes = await kfSlot.predict({
      cond_111: [Array(111).fill(0)],
      x_base_26: [Array(26).fill(0.1)],
    });
    expect(kfRes.ok).toBe(true);
    if (kfRes.ok) expect(kfRes.value.status).toBe('fallback_physical');

    const lightSlot = new BrowserLightM27Slot({
      fetchImpl: async () => new Response(null, { status: 404 }),
    });
    const probe = await lightSlot.probe();
    expect(probe.ready).toBe(false);

    const transport = new VocalEngineTransport({
      fetchImpl: async () => new Response(null, { status: 503 }),
    });
    const status = await transport.probeBackend();
    expect(status.backend).toBe('prewarm-fallback');
  });
});
