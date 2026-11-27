/**
 * Real-computation data builders for principle charts embedded in the user manual.
 *
 * Every curve is produced by VoxFigura's production acoustic/editing kernels
 * (`buildAnnotationSynthesis`, `stopPhaseBoundaries`, `evalQtaSegmentAt`, `bellSuperimposedRow`)
 * and/or bundled vocal-tract trajectories (`public/prewarm/suan_mandarin.json`),
 * without hand-fabricated synthetic curve formulas.
 */

import {
  SAMPLE_RATE_HZ,
  evalQtaSegmentAt,
  msToSamples,
  samplesToMs,
  type Clip,
  type Syllable,
} from '@vocalcut/core';
import { buildAnnotationSynthesis } from '@/components/research/annotation-audio';
import { stopPhaseBoundaries } from '@/components/research/annotation-edit';
import { buildSegmentsForSyllable, estimateSyllableNaturalDurationMs } from '@/components/research/research-utils';
import { bellSuperimposedRow, type RecordingKeyframe, type RecordingParameter } from '@/data/ipa-recording-edits';
import { buildSyllableQtaTargets } from '@/data/ipa-segments';
import { resolvePtbIpaPose } from '@/data/ptb-ipa-presets';
import { connectedRuleDurationScale, speechPhoneDurations, speechStopTiming } from '@/data/speech-timing';
import { createInitialProject, defaultTractParams, tractRecordToArray19 } from '@/stores/workbench';

export interface MainSynthesisPhysicsSeries {
  msSteps: number[];
  prPa: number[];
  ldCm: number[];
  f0Hz: Array<number | null>;
  closureEndMs: number;
  releaseEndMs: number;
  votEndMs: number;
  totalMs: number;
}

/**
 * Exact calibrated JD2 factory 19-D vectors from `public/vocal-tract/factory/JD2/ipa.json`,
 * used synchronously before async `preloadPtbIpaPresets('JD2')` resolves (or in Node tests).
 */
const JD2_FACTORY_CALIBRATED_19: Record<'pʰ' | 'a' | 's' | 'n', readonly number[]> = {
  'pʰ': [0.2657, -5.0554, 0, -3.04, 0.0718, -0.9, 0.8, -0.1, -0.1616, -2.2942, 4.2381, -1.3232, 2.5237, -0.4736, -2.3879, -3.1643, 0.2064, 0.0384, 0.1488],
  a: [0.129, -4.239709, -0.0319, -6.551353, -0.224641, 1.93493, 0.45, -0.1, 0.403071, -2.171418, 3.670186, -1.96699, 2.863982, -0.987431, -2.7, -2.8, 0.3551, 0.1057, 0.2034],
  s: [0.1253, -4.5949, 0, -3.5812, 0.1226, 0.3436, 1, -0.1, -0.0633, -2.0029, 4.6, -0.3463, 2.0519, 0.0436, -2.455, -3.0826, 0, 0.018, 0.32],
  n: [0.2273, -4.6458, 0, -3.2692, 0.0718, 0.9937, 0.8, 0.5, 1.6893, -2.4763, 4.7519398, -0.2297915, 4.6010994, 0.0014736, -1.8289209, -2.4763, 0.2064, 0.0384, 0],
};

function resolveCalibratedJd2(symbol: 'pʰ' | 'a' | 's' | 'n'): number[] {
  const resolved = resolvePtbIpaPose(symbol, 'JD2');
  return resolved.isFallback ? [...JD2_FACTORY_CALIBRATED_19[symbol]] : [...resolved.params19];
}

/**
 * Compile a real aspirated bilabial stop + high-level vowel syllable `[pʰa˥˥]`
 * through the exact production rule pipeline (`speechPhoneDurations`, `connectedRuleDurationScale`,
 * `buildSegmentsForSyllable`, `speechStopTiming`, `buildSyllableQtaTargets`,
 * `buildAnnotationSynthesis`, and `stopPhaseBoundaries`) at 200 Hz (5 ms).
 */
export function computeMainSynthesisPhysicsData(): MainSynthesisPhysicsSeries {
  const project = createInitialProject();
  const voiceId = project.voice_order[0];
  const refHz = project.voices[voiceId]?.f0_ref_hz ?? 165;
  const posePh = resolveCalibratedJd2('pʰ');
  const poseA = resolveCalibratedJd2('a');
  const neutralTract = tractRecordToArray19(defaultTractParams());

  const phonemes = ['pʰ', 'a'];
  const phoneMs = speechPhoneDurations(phonemes);
  const totalMs = estimateSyllableNaturalDurationMs(phonemes, connectedRuleDurationScale(phonemes, 1.0, 'zh'), 1.0, phoneMs);
  const totalSmp = msToSamples(totalMs);

  const segments = buildSegmentsForSyllable('guide_syl_pha', phonemes, 0, totalSmp, 'JD2', undefined, {
    speechPhoneMs: phoneMs,
  });
  segments[0].params = [...posePh];
  segments[1].params = [...poseA];

  const stopSeg = segments[0];
  const stopDurMs = Math.max(12, samplesToMs(stopSeg.end_smp - stopSeg.start_smp));
  stopSeg.stop_timing = speechStopTiming('pʰ', stopDurMs);
  const onsetEndSmp = stopSeg.end_smp;
  const onsetEndMs = Math.round(samplesToMs(onsetEndSmp));

  const targets = buildSyllableQtaTargets('guide_syl_pha', 0, totalSmp, {
    effectiveTone: '55',
    fRefHz: refHz,
    voiced: true,
  });

  const syllable: Syllable = {
    id: 'guide_syl_pha',
    text: '趴',
    ipa: phonemes,
    start_smp: 0,
    end_smp: totalSmp,
    nucleus_index: 1,
    anchor: { policy: 'nucleus_on_beat', lead_ms: 70, bias_ms: 0 },
    segments,
    targets,
    overrides: {
      poses: [],
      f0_resid: [],
      pressure: [
        { u: 0, pressure_pa: 640 },
        { u: 0.35, pressure_pa: 840 },
        { u: 0.85, pressure_pa: 760 },
        { u: 1, pressure_pa: 500 },
      ],
      glottis: [{ u0: 0, u1: 1, preset: 'modal', blend: 1 }],
    },
  };

  const clip: Clip = {
    id: 'guide_clip_pha',
    kind: 'phrase',
    voice_id: voiceId,
    start_smp: 0,
    end_smp: totalSmp,
    syllable_order: [syllable.id],
    syllables: { [syllable.id]: syllable },
  };

  const stopBounds = stopPhaseBoundaries(stopSeg);
  const closureEndMs = stopBounds ? Math.round(samplesToMs(stopBounds.releaseStart)) : Math.round(stopSeg.stop_timing.closure_ms);
  const releaseEndMs = stopBounds
    ? Math.round(samplesToMs(stopBounds.releaseEnd))
    : Math.round(stopSeg.stop_timing.closure_ms + stopSeg.stop_timing.release_ms);

  const built = buildAnnotationSynthesis(
    project,
    clip,
    [],
    0,
    totalSmp,
    {
      f0Hz: refHz,
      tract: neutralTract,
      releaseTract: neutralTract,
      lipWidth: 1,
      larynxHeight: 0,
    },
  );

  if (!built.ok) {
    throw new Error(built.error.hint || '无法通过主合成内核编译 [pʰa˥˥]');
  }

  const stepMs = 1000 / built.value.step_hz;
  const n = built.value.f0_hz.length;
  const spans = 'articulation_spans' in built.value ? built.value.articulation_spans : [];

  const msSteps: number[] = [];
  const prPa: number[] = [];
  const ldCm: number[] = [];
  const f0Hz: Array<number | null> = [];

  for (let i = 0; i < n; i++) {
    const tMs = Math.round(i * stepMs);
    msSteps.push(tMs);
    prPa.push(Math.round(built.value.pressure_pa[i] ?? 0));
    // Index 5 in VTL 19-dim vector is LD (lip distance, cm)
    const ld = built.value.tract_frames[i]?.[5] ?? 0;
    ldCm.push(Number(ld.toFixed(3)));

    const activeSpan = spans.find((sp) => i >= sp.start_frame && i < sp.end_frame);
    const isVoiced = activeSpan ? activeSpan.voiced : tMs >= onsetEndMs;
    f0Hz.push(isVoiced ? Number((built.value.f0_hz[i] ?? refHz).toFixed(1)) : null);
  }

  return {
    msSteps,
    prPa,
    ldCm,
    f0Hz,
    closureEndMs,
    releaseEndMs,
    votEndMs: onsetEndMs,
    totalMs,
  };
}

export interface CoarticulationBellSeries {
  sourceLabel: string;
  msSteps: number[];
  origTcx: number[];
  bellEditedTcx: number[];
  flatBlockTcx: number[];
  targetFrameIdx: number;
  windowStartMs: number;
  windowEndMs: number;
  deltaCm: number;
}

const TCX_FIELD: RecordingParameter = {
  key: 'TCX',
  index: 8,
  min: -3.0,
  max: 4.0,
};

/**
 * Compute real cosine-bell target-frame superposition (`bellSuperimposedRow`)
 * vs naive flat-block replacement on a real vocal-tract parameter sequence.
 */
export function computeCoarticulationBellFromFrames(
  frames: ReadonlyArray<{ t_s: number; params: readonly number[] }>,
  sourceLabel: string,
  deltaCm = 1.15,
  radiusFrames?: number,
): CoarticulationBellSeries {
  if (frames.length < 5) {
    throw new Error('声道轨迹帧数不足，无法计算余弦升窗叠加');
  }
  const baseRows = frames.map((f) => [...f.params]);
  const msSteps = frames.map((f) => Math.round(f.t_s * 1000));

  // Locate the vowel-nucleus target frame (around 50% of the trajectory where TCX dips toward vowel /a/)
  const searchStart = Math.floor(frames.length * 0.35);
  const searchEnd = Math.ceil(frames.length * 0.68);
  let targetFrameIdx = Math.floor(frames.length * 0.5);
  let minTcx = Number.POSITIVE_INFINITY;
  for (let i = searchStart; i <= Math.min(frames.length - 1, searchEnd); i++) {
    const val = baseRows[i]?.[TCX_FIELD.index] ?? 0;
    if (val < minTcx) {
      minTcx = val;
      targetFrameIdx = i;
    }
  }

  const baseAtTarget = baseRows[targetFrameIdx][TCX_FIELD.index] ?? 0;
  const targetVal = Number((baseAtTarget + deltaCm).toFixed(3));
  if (targetVal < TCX_FIELD.min || (typeof TCX_FIELD.max === 'number' && targetVal > TCX_FIELD.max)) {
    throw new Error(`TCX 目标值 ${targetVal} 超出物理允许范围 [${TCX_FIELD.min}, ${TCX_FIELD.max}]`);
  }
  const actualDelta = Number((targetVal - baseAtTarget).toFixed(2));
  // Matches IpaPlusView.vue `defaultBellRadius` when omitted: 28% of frame count clamped to [6, 50]
  const resolvedRadius = radiusFrames ?? Math.max(6, Math.min(50, Math.round(frames.length * 0.28)));
  const safeRadius = Math.max(6, Math.min(50, Math.round(resolvedRadius)));

  const keyframes: RecordingKeyframe[] = [
    {
      frame: targetFrameIdx,
      radius: safeRadius,
      values: { TCX: targetVal },
    },
  ];

  const origTcx: number[] = [];
  const bellEditedTcx: number[] = [];
  const flatBlockTcx: number[] = [];
  const winStartIdx = Math.max(0, targetFrameIdx - safeRadius);
  const winEndIdx = Math.min(frames.length - 1, targetFrameIdx + safeRadius);

  for (let i = 0; i < frames.length; i++) {
    const orig = baseRows[i][TCX_FIELD.index] ?? 0;
    const bellRow = bellSuperimposedRow(baseRows, i, keyframes, [TCX_FIELD]);
    const edited = bellRow[TCX_FIELD.index] ?? orig;
    origTcx.push(Number(orig.toFixed(3)));
    bellEditedTcx.push(Number(edited.toFixed(3)));
    // Flat block replacement clamps the entire target window to the constant target value
    const inBlock = i >= Math.max(0, targetFrameIdx - Math.floor(safeRadius * 0.7)) &&
      i <= Math.min(frames.length - 1, targetFrameIdx + Math.floor(safeRadius * 0.7));
    flatBlockTcx.push(Number((inBlock ? targetVal : orig).toFixed(3)));
  }

  return {
    sourceLabel,
    msSteps,
    origTcx,
    bellEditedTcx,
    flatBlockTcx,
    targetFrameIdx,
    windowStartMs: msSteps[winStartIdx],
    windowEndMs: msSteps[winEndIdx],
    deltaCm: actualDelta,
  };
}

/**
 * Synchronous real-kernel baseline computed via JD2 IPA poses (`s -> a -> n`) +
 * 3rd-order critically damped `evalQtaSegmentAt` + `bellSuperimposedRow`, used before
 * async fetch of `public/prewarm/suan_mandarin.json` resolves (or in headless tests).
 */
export function computeCoarticulationBellBaseline(): CoarticulationBellSeries {
  const poseS = resolveCalibratedJd2('s');
  const poseA = resolveCalibratedJd2('a');
  const poseN = resolveCalibratedJd2('n');
  const count = 41; // 0..800 ms at 20 ms (50 Hz)
  const frames: Array<{ t_s: number; params: number[] }> = [];

  let state = { y: poseS[8], yp: 0, ypp: 0 };
  for (let i = 0; i < count; i++) {
    const tSec = i * 0.02;
    let tcx = poseS[8];
    if (tSec < 0.22) {
      tcx = poseS[8];
      state = { y: tcx, yp: 0, ypp: 0 };
    } else if (tSec < 0.56) {
      const ev = evalQtaSegmentAt(tSec - 0.22, 0.34, 0, poseA[8], 18, { y: poseS[8], yp: 0, ypp: 0 });
      tcx = ev.y;
      if (i === 27) state = ev;
    } else {
      const ev = evalQtaSegmentAt(tSec - 0.56, 0.24, 0, poseN[8], 18, state);
      tcx = ev.y;
    }
    const row = [...poseA];
    row[8] = tcx;
    frames.push({ t_s: tSec, params: row });
  }

  return computeCoarticulationBellFromFrames(
    frames,
    'JD2 [s-a-n] 50 Hz qTA 协同轨迹 + bellSuperimposedRow',
    1.15,
  );
}

/** Helper to check real duration consistency in tests */
export const GUIDE_CHART_SAMPLE_RATE = SAMPLE_RATE_HZ;
