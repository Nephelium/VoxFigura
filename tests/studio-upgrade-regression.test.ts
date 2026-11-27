import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE_HZ, msToSamples, type Clip, type VcProject } from '@vocalcut/core';
import { createInitialProject } from '@/stores/workbench';
import {
  EASE,
  cubicBezier,
  dampedSettle,
  encodeKeyframeEasing,
  handheld,
  mulberry32,
  parseKeyframeEasing,
  springAt,
} from '@/components/studio/stage-motion';
import {
  beatPulseAt,
  detectBeatGridFromPcm,
  readStageBeatGrid,
  snapSmpToBeatGrid,
  stageBeatGridKeys,
} from '@/components/studio/stage-beat-sync';
import {
  DEFAULT_STAGE_CINEMA,
  evaluateCameraPose,
  readStageCinemaConfig,
  stageCinemaKeys,
} from '@/components/studio/stage-fx';
import {
  computeClipTransitionState,
  layerTransitionKeys,
  readLayerTransition,
} from '@/components/studio/stage-transitions';
import { cropStagePhrase, voiceCompanionClips } from '@/components/studio/stage-voice-clips';
import { mixStageTrackSettings, readTimeline, stageAudioTrackKeys, stageLayer, timelineKeys, type NleClip } from '@/components/studio/nle-timeline';
import { splitTimelineClips } from '@/components/studio/nle-edit';
import {
  DEFAULT_SUBTITLE_ANGLE_JITTER,
  drawStageCaption,
  subtitleAngleDeg,
  subtitleSizeFactor,
} from '@/components/studio/stage-caption';
import { stageSubtitleRows } from '@/components/modals/stage-subtitles';
import {
  DEFAULT_STAGE_TRACT_VIEW,
  STAGE_HEAD_2D_VIEWBOX,
  STAGE_ORAL_2D_VIEWBOX,
  readStageTractViewConfig,
  stageTractViewKeys,
} from '@/components/studio/stage-tract-renderer';
import registeredHead from '@/vendor/m27-tract-studio/registered-head.json';
import { transformAt } from '@/components/studio/stage-scene';

describe('Phase 4: video-shotcraft cinematic motion, transitions, FX & beat sync', () => {
  it('solves cubic-bezier curves accurately with overshoot and anticipation support', () => {
    const linear = cubicBezier(0, 0, 1, 1);
    expect(linear(0)).toBe(0);
    expect(linear(0.5)).toBeCloseTo(0.5, 4);
    expect(linear(1)).toBe(1);

    expect(EASE.snappy(0.25)).toBeGreaterThan(0.5);
    expect(EASE.overshoot(0.5)).toBeGreaterThan(1.0);
    expect(EASE.anticip(0.15)).toBeLessThan(0);

    expect(dampedSettle(0)).toBe(0);
    expect(dampedSettle(2.5)).toBeCloseTo(1, 2);
    expect(springAt(0)).toBe(0);
    expect(springAt(2.5)).toBeCloseTo(1, 2);

    const rngA = mulberry32(12345);
    const rngB = mulberry32(12345);
    expect([rngA(), rngA(), rngA()]).toEqual([rngB(), rngB(), rngB()]);

    const h1 = handheld(1.25, { ampPx: 10, rotDeg: 0.6, seed: 42 });
    const h2 = handheld(1.25, { ampPx: 10, rotDeg: 0.6, seed: 42 });
    expect(h1).toEqual(h2);
    expect(Math.hypot(h1.x, h1.y)).toBeGreaterThan(0);

    expect(parseKeyframeEasing(encodeKeyframeEasing('snappy'))).toBe('snappy');
    expect(encodeKeyframeEasing('linear')).toBeUndefined();
  });

  it('recovers synthetic 120 BPM click-track beat grid accurately via least-squares fit', () => {
    const sr = SAMPLE_RATE_HZ;
    const durSec = 8;
    const pcm = new Float32Array(sr * durSec);
    const periodSec = 0.5; // 120 BPM
    const t0 = 0.25;
    for (let t = t0; t < durSec - 0.1; t += periodSec) {
      const start = Math.round(t * sr);
      const hitLen = Math.round(0.06 * sr);
      for (let i = 0; i < hitLen && start + i < pcm.length; i++) {
        const sec = i / sr;
        pcm[start + i] += Math.sin(2 * Math.PI * 85 * sec) * Math.exp(-sec * 42) * 0.9;
      }
    }
    const grid = detectBeatGridFromPcm(pcm, sr, { sourceLabel: 'kick-120' });
    expect(Math.abs(grid.bpm - 120)).toBeLessThanOrEqual(1.8);
    expect(grid.beatsSmp.length).toBeGreaterThanOrEqual(14);
    expect(grid.confidence).toBeGreaterThan(0.35);

    const firstBeat = grid.beatsSmp[2];
    const nearBeat = firstBeat + msToSamples(35);
    expect(snapSmpToBeatGrid(nearBeat, grid)).toBe(firstBeat);
    expect(snapSmpToBeatGrid(firstBeat + msToSamples(240), grid)).toBe(firstBeat + msToSamples(240));

    const pulseOn = beatPulseAt(grid.t0Sec, grid);
    const pulseLater = beatPulseAt(grid.t0Sec + 0.2, grid);
    expect(pulseOn.pulse).toBeGreaterThan(pulseLater.pulse);

    const project = createInitialProject();
    const v0 = stageLayer(project, 'v0')!;
    v0.keys = { ...v0.keys, beat_grid: stageBeatGridKeys(grid) };
    const restored = readStageBeatGrid(project);
    expect(restored?.bpm).toBe(grid.bpm);
    expect(restored?.beatsSmp.length).toBe(grid.beatsSmp.length);
  });

  it('evaluates camera presets, cinema FX serialization, and clip transitions deterministically', () => {
    const pushStart = evaluateCameraPose({ ...DEFAULT_STAGE_CINEMA, camera: 'slow-push-in' }, 0, 5);
    const pushEnd = evaluateCameraPose({ ...DEFAULT_STAGE_CINEMA, camera: 'slow-push-in' }, 5, 5);
    expect(pushEnd.scale).toBeGreaterThan(pushStart.scale);

    const dutchStart = evaluateCameraPose({ ...DEFAULT_STAGE_CINEMA, camera: 'dutch-roll-level' }, 0, 4);
    const dutchEnd = evaluateCameraPose({ ...DEFAULT_STAGE_CINEMA, camera: 'dutch-roll-level' }, 3.5, 4);
    expect(Math.abs(dutchStart.rotDeg)).toBeGreaterThan(4);
    expect(Math.abs(dutchEnd.rotDeg)).toBeLessThan(0.5);

    const project = createInitialProject();
    const v0 = stageLayer(project, 'v0')!;
    const cfg = { ...DEFAULT_STAGE_CINEMA, look: 'aurora' as const, camera: 'crash-zoom' as const, vignette: 0.4, outro: 'title-lockup' as const };
    v0.keys = { ...v0.keys, cinema_fx: stageCinemaKeys(cfg) };
    expect(readStageCinemaConfig(project)).toMatchObject({ look: 'aurora', camera: 'crash-zoom', vignette: 0.4, outro: 'title-lockup' });

    const v1 = stageLayer(project, 'v1')!;
    v1.keys = { ...v1.keys, transition_fx: layerTransitionKeys({ inType: 'clock-wipe', outType: 'barn-door', durationMs: 400 }) };
    const tCfg = readLayerTransition(v1);
    expect(tCfg).toEqual({ inType: 'clock-wipe', outType: 'barn-door', durationMs: 400 });

    const startSmp = 0;
    const endSmp = SAMPLE_RATE_HZ * 2;
    const inState = computeClipTransitionState(msToSamples(100), startSmp, endSmp, tCfg);
    const midState = computeClipTransitionState(SAMPLE_RATE_HZ, startSmp, endSmp, tCfg);
    const outState = computeClipTransitionState(endSmp - msToSamples(100), startSmp, endSmp, tCfg);
    expect(inState?.type).toBe('clock-wipe');
    expect(inState?.direction).toBe('in');
    expect(midState).toBeNull();
    expect(outState?.type).toBe('barn-door');
    expect(outState?.direction).toBe('out');
  });

  it('applies per-keyframe easing inside transformAt', () => {
    const project = createInitialProject();
    const v1 = stageLayer(project, 'v1')!;
    v1.keys = {
      ...v1.keys,
      transform: [
        { t_smp: 0, x: 20, y: 50, scale: 1, opacity: 1 },
        { t_smp: SAMPLE_RATE_HZ, x: 80, y: 50, scale: 1, opacity: 1, frame: encodeKeyframeEasing('snappy') },
      ],
    };
    const mid = transformAt(v1, 'v1', SAMPLE_RATE_HZ / 2);
    expect(mid.x).toBeGreaterThan(65);
  });
});

describe('Phase 1 studio bug-fix regressions', () => {
  it('cropStagePhrase crops and shifts both manual f0_pins and phonation_anchors', () => {
    const phrase: Clip = {
      id: 'p1',
      kind: 'audio',
      voice_id: 'v1',
      start_smp: 0,
      end_smp: SAMPLE_RATE_HZ * 2,
      syllable_order: ['s1'],
      syllables: {
        s1: {
          id: 's1',
          text: '啊',
          ipa: ['a'],
          start_smp: 10000,
          end_smp: 40000,
          nucleus_index: 0,
          anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
          segments: [{ id: 'seg1', ipa: 'a', role: 'nucleus', start_smp: 10000, end_smp: 40000, voiced: true, elastic: true }],
          targets: [],
          overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
        },
      },
      annotation_controls: {
        phonation_anchor_order: ['a_out', 'a_in'],
        phonation_anchors: {
          a_out: { id: 'a_out', t_smp: 2000, regime: 'modal', blend: 1 },
          a_in: { id: 'a_in', t_smp: 20000, regime: 'breathy', blend: 0.85 },
        },
        f0_pins: [
          { id: 'f_out', start_smp: 1000, end_smp: 5000, transition_ms: 40, exit_fit_ms: 40, points: [{ t_smp: 1000, f0_hz: 110 }, { t_smp: 5000, f0_hz: 120 }] },
          { id: 'f_in', start_smp: 15000, end_smp: 35000, transition_ms: 40, exit_fit_ms: 40, points: [{ t_smp: 15000, f0_hz: 180 }, { t_smp: 35000, f0_hz: 210 }] },
        ],
      },
    };
    const cropped = cropStagePhrase(phrase, 10000, 30000);
    expect(cropped.annotation_controls?.f0_pins).toHaveLength(1);
    expect(cropped.annotation_controls?.f0_pins?.[0].start_smp).toBe(5000);
    expect(cropped.annotation_controls?.f0_pins?.[0].points[0].t_smp).toBe(5000);
    expect(cropped.annotation_controls?.phonation_anchor_order).toEqual(['a_in']);
    expect(cropped.annotation_controls?.phonation_anchors?.a_in?.t_smp).toBe(10000);
  });

  it('voiceCompanionClips strips audio-only fields and preserves sourceStartSmp', () => {
    const audio: NleClip = {
      id: 'a1_clip',
      track: 'a1',
      label: '人声',
      startSmp: 5000,
      endSmp: 55000,
      sourceStartSmp: 12000,
      sourceLength: 96000,
      assetId: 'asset_wav',
      gain: 0.65,
      gainPoints: [{ source_smp: 15000, gain: 0.5 }],
      muted: true,
    };
    const companions = voiceCompanionClips(audio, undefined, [{ u: 0, params: new Array(19).fill(0) }]);
    expect(companions).toHaveLength(1);
    expect(companions[0].sourceStartSmp).toBe(12000);
    expect(companions[0].assetId).toBeUndefined();
    expect(companions[0].gain).toBeUndefined();
    expect(companions[0].gainPoints).toBeUndefined();
    expect(companions[0].muted).toBeUndefined();
  });

  it('mixStageTrackSettings mutes unconfigured tracks when anySolo is active and readTimeline rejects invalid gain', () => {
    const project = createInitialProject();
    const v0 = stageLayer(project, 'v0')!;
    const clips: NleClip[] = [
      { id: 'c1', track: 'a1', label: 'A1', startSmp: 0, endSmp: 48000, sourceStartSmp: 0, gain: -2 },
      { id: 'c2', track: 'a9' as NleClip['track'], label: 'A9', startSmp: 0, endSmp: 48000, sourceStartSmp: 0, gain: 0.8 },
    ];
    v0.keys = {
      ...v0.keys,
      nle_meta: timelineKeys(clips),
      nle_audio_tracks: stageAudioTrackKeys([
        { id: 'a1', name: '主唱', gain: 1, muted: false, solo: true },
      ]),
    };
    const loaded = readTimeline(project, project.clip_order[0]);
    expect(loaded.find(c => c.id === 'c1')?.gain).toBeUndefined();
    expect(loaded.find(c => c.id === 'c2')?.gain).toBe(0.8);

    const mixed = mixStageTrackSettings(project, loaded);
    expect(mixed.find(c => c.id === 'c1')?.muted).toBe(false);
    expect(mixed.find(c => c.id === 'c2')?.muted).toBe(true);
  });

  it('splitTimelineClips avoids stacking (2) (2) suffixes across repeated splits', () => {
    const clip: NleClip = { id: 'c1', track: 'a1', label: '主唱', startSmp: 0, endSmp: SAMPLE_RATE_HZ * 3, sourceStartSmp: 0 };
    const first = splitTimelineClips([clip], clip, [SAMPLE_RATE_HZ], false);
    const secondPart = first.selected[1];
    expect(secondPart.label).toBe('主唱 (2)');
    const second = splitTimelineClips(first.clips, secondPart, [SAMPLE_RATE_HZ * 2], false);
    expect(second.selected[1].label).toBe('主唱 (3)');
  });

  it('stageSubtitleRows merges concurrent visualLane V3 clips and omits empty IPA brackets', () => {
    const project: VcProject = createInitialProject();
    const clipId = project.clip_order[0];
    const phrase = project.clips[clipId];
    phrase.syllable_order = ['syl_1'];
    phrase.syllables = {
      syl_1: {
        id: 'syl_1',
        text: '风',
        ipa: [],
        start_smp: 480,
        end_smp: 24480,
        nucleus_index: 0,
        anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
        segments: [],
        targets: [],
        overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
      },
    };
    phrase.end_smp = 24480;
    const v0 = stageLayer(project, 'v0')!;
    const v3Clips: NleClip[] = [
      { id: 'v3_0', track: 'v3', visualLane: 0, label: '轨1', phraseId: clipId, startSmp: 0, endSmp: phrase.end_smp, sourceStartSmp: 0 },
      { id: 'v3_1', track: 'v3', visualLane: 1, label: '轨2', phraseId: clipId, startSmp: phrase.end_smp + 4800, endSmp: phrase.end_smp * 2 + 4800, sourceStartSmp: 0 },
    ];
    v0.keys = { ...v0.keys, nle_meta: timelineKeys(v3Clips) };
    const rows = stageSubtitleRows(project, clipId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some(r => r.start_s >= (phrase.end_smp + 4800) / SAMPLE_RATE_HZ - 0.01)).toBe(true);
    expect(rows.every(r => r.ipa !== '[]')).toBe(true);
  });

  it('readStageTractViewConfig / stageTractViewKeys round-trip 2D/3D & Synth head settings cleanly', () => {
    const project = createInitialProject();
    const v1 = stageLayer(project, 'v1')!;
    expect(readStageTractViewConfig(v1)).toEqual(DEFAULT_STAGE_TRACT_VIEW);

    v1.keys = {
      ...v1.keys,
      tract_view: stageTractViewKeys({
        dimension: '3d',
        headMode: 'head',
        view3dAngle: 'full-head',
        yawDeg: 28,
        pitchDeg: -10,
      }),
    };
    const loaded = readStageTractViewConfig(v1);
    expect(loaded).toEqual({
      dimension: '3d',
      headMode: 'head',
      view3dAngle: 'full-head',
      yawDeg: 28,
      pitchDeg: -10,
    });

    // Out-of-range angles clamp safely when deserializing malformed project files
    v1.keys = {
      ...v1.keys,
      tract_view: [{ t_smp: 0, frame: JSON.stringify({ dimension: '3d', headMode: 'none', view3dAngle: 'invalid', yawDeg: 999, pitchDeg: -999 }) }],
    };
    const sanitized = readStageTractViewConfig(v1);
    expect(sanitized.dimension).toBe('3d');
    expect(sanitized.headMode).toBe('none');
    expect(sanitized.view3dAngle).toBe('sagittal-cut');
    expect(sanitized.yawDeg).toBe(65);
    expect(sanitized.pitchDeg).toBe(-25);
  });

  it('STAGE_HEAD_2D_VIEWBOX completely encloses the Synth registered head contour without back/top/bottom clipping', () => {
    const xs = registeredHead.outline.map(p => p[0]);
    const ys = registeredHead.outline.map(p => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const maxYMath = Math.max(...ys); // SVG y = -y_math

    // Horizontal bounds include full occiput (-14.45) through nose tip (+7.88)
    expect(STAGE_HEAD_2D_VIEWBOX.x).toBeLessThan(minX - 0.3);
    expect(STAGE_HEAD_2D_VIEWBOX.x + STAGE_HEAD_2D_VIEWBOX.w).toBeGreaterThan(maxX + 0.3);
    // Top bound includes full skull crown (+17.09 -> svg -17.09)
    expect(STAGE_HEAD_2D_VIEWBOX.y).toBeLessThan(-maxYMath - 0.3);
    // Bottom bound includes sculpted collar bust below glottis (y_math = -10.5 -> svg +10.5)
    expect(STAGE_HEAD_2D_VIEWBOX.y + STAGE_HEAD_2D_VIEWBOX.h).toBeGreaterThan(10.5);
    // Pure oral fallback viewBox remains compact
    expect(STAGE_ORAL_2D_VIEWBOX.w).toBeLessThan(14);
  });

  it('subtitleAngleDeg produces deterministic bounded angles independent of size jitter and rejects invalid bounds', () => {
    expect(subtitleAngleDeg(undefined, 'clip/s1/0')).toBe(0);
    expect(subtitleAngleDeg({ ...DEFAULT_SUBTITLE_ANGLE_JITTER, enabled: false }, 'clip/s1/0')).toBe(0);

    const cfg = { enabled: true, min_deg: -15, max_deg: 15, seed: 7 };
    const a1 = subtitleAngleDeg(cfg, 'clip/s1/0');
    const a2 = subtitleAngleDeg(cfg, 'clip/s1/0');
    const b1 = subtitleAngleDeg(cfg, 'clip/s1/1');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
    expect(a1).toBeGreaterThanOrEqual(-15);
    expect(a1).toBeLessThanOrEqual(15);
    expect(b1).toBeGreaterThanOrEqual(-15);
    expect(b1).toBeLessThanOrEqual(15);

    // Same seed/key gives independent normalized ratio from size jitter
    const sizeRatio = (subtitleSizeFactor({ enabled: true, min_pct: 50, max_pct: 150, seed: 7 }, 'clip/s1/0') - 0.5);
    const angleRatio = (a1 + 15) / 30;
    expect(Math.abs(sizeRatio - angleRatio)).toBeGreaterThan(1e-4);

    // Out-of-range or inverted bounds safely return 0
    expect(subtitleAngleDeg({ enabled: true, min_deg: 10, max_deg: -10, seed: 1 }, 'k')).toBe(0);
    expect(subtitleAngleDeg({ enabled: true, min_deg: -120, max_deg: 10, seed: 1 }, 'k')).toBe(0);
    expect(subtitleAngleDeg({ enabled: true, min_deg: -10, max_deg: 10, seed: 1.5 }, 'k')).toBe(0);
  });

  it('drawStageCaption splits graphemes and rotates each glyph around its center when angle_jitter is enabled', () => {
    const rotations: number[] = [];
    const drawnTexts: string[] = [];
    const identityPoint = (x: number, y: number) => ({
      x,
      y,
      matrixTransform: () => ({ x, y }),
    });
    const origDOMPoint = globalThis.DOMPoint;
    (globalThis as unknown as { DOMPoint: unknown }).DOMPoint = function (x: number, y: number) {
      return identityPoint(x, y);
    };
    try {
      const mockCtx = {
        canvas: { width: 1920, height: 1080 },
        font: '',
        fillStyle: '',
        textAlign: 'left',
        textBaseline: 'alphabetic',
        globalAlpha: 1,
        shadowColor: '',
        shadowBlur: 0,
        save: () => {},
        restore: () => {},
        translate: () => {},
        scale: () => {},
        rotate: (rad: number) => { rotations.push(rad); },
        beginPath: () => {},
        rect: () => {},
        clip: () => {},
        fillRect: () => {},
        getTransform: () => ({}),
        measureText: (txt: string) => ({
          width: txt.length * 40,
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: txt.length * 40,
          actualBoundingBoxAscent: 36,
          actualBoundingBoxDescent: 8,
        }),
        fillText: (txt: string) => { drawnTexts.push(txt); },
      } as unknown as CanvasRenderingContext2D;

      const style = {
        font_family: 'Doulos SIL',
        font_size_px: 64,
        tilt_deg: 0,
        reveal_mode: 'word' as const,
        text_color: '#ffffff',
        highlight_color: '#79aaff',
        show_ipa: false,
        show_translation: false,
        safe_margin_px: [96, 54] as [number, number],
        angle_jitter: { enabled: true, min_deg: -12, max_deg: 12, seed: 3 },
      };
      const bounds = drawStageCaption(
        mockCtx,
        [{ key: 'c1/s1/0', text: '你好', color: '#ffffff', visible: true, progress: 0.6 }],
        style,
        64,
        960,
        900,
      );
      expect(drawnTexts).toEqual(['你', '好']);
      expect(rotations).toHaveLength(2);
      expect(rotations[0]).not.toBe(rotations[1]);
      expect(bounds).not.toBeNull();
    } finally {
      (globalThis as unknown as { DOMPoint: unknown }).DOMPoint = origDOMPoint;
    }
  });
});
