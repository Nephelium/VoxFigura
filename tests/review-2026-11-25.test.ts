import { describe, expect, it } from 'vitest';
import {
  SAMPLE_RATE_HZ,
  buildContinuum2D,
  parseTextGrid,
  projectToTextGrid,
  stringifyTextGrid,
  type Clip,
  type ContinuumLandmark,
  type Syllable,
  type VcProject,
} from '@vocalcut/core';
import {
  estimateSpeakerPitchRangeFromCurves,
  fitChaoFromPitchCurve,
} from '@/data/dialect-exchange';
import { classifyContinuumPhone } from '@/data/ipa-segments';
import { inspectWavHeader } from '@/components/research/continuum-media';
import { MixerSpectrogramCache } from '@/components/research/mixer-spectrogram';
import { IpaRecordingAnalysisRunner } from '@/components/research/ipa-recording-analysis';
import {
  LOCAL_MODEL_SPECS,
  MODEL_TRAINING_REPORT_META,
  RETRAINING_RECIPES,
} from '@/data/model-training-report';
import {
  MIN_SHELL_HEIGHT_PX,
  MIN_SHELL_WIDTH_PX,
  computeAutoPageScale,
  computeDesktopViewportSize,
} from '@/styles/skin-registry';

function makeWav16leMono(sampleRateHz: number, numSamples: number): ArrayBuffer {
  const dataBytes = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  return buf;
}

function makeTestProject(): VcProject {
  return {
    schema: 'vocalcut/project',
    schema_version: 1,
    revision: 1,
    id: 'tg_gap_test',
    name: 'TG Gap Test',
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
    voice_order: [],
    voices: {},
    asset_order: [],
    assets: {},
    track_order: [],
    tracks: {},
    clip_order: [],
    clips: {},
    layer_order: [],
    layers: {},
    phonation_anchor_order: [],
    phonation_anchors: {},
    f0_pins: [],
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

describe('Code review 2026-11-25 regression suite', () => {
  it('S1: fits Chao 5-level tones in log-F0 against speaker pitch range and refuses self-normalized flat 11', () => {
    const flat120 = Array.from({ length: 25 }, (_, i) => ({ u: i / 24, hz: 120 }));
    const flat240 = Array.from({ length: 25 }, (_, i) => ({ u: i / 24, hz: 240 }));

    // Without speaker reference pitch range, never fabricate 11 from a single monotone clip
    expect(fitChaoFromPitchCurve(flat120, null)).toBeNull();
    expect(fitChaoFromPitchCurve(flat240, undefined)).toBeNull();
    expect(estimateSpeakerPitchRangeFromCurves([flat240])).toBeNull();

    // Multi-word speaker register estimation succeeds when pitch span >= 3.5 st
    const register = estimateSpeakerPitchRangeFromCurves([flat120, flat240]);
    expect(register).not.toBeNull();

    const refRange = { minHz: 105, maxHz: 255 };
    const fitLowFlat = fitChaoFromPitchCurve(flat120, refRange);
    const fitHighFlat = fitChaoFromPitchCurve(flat240, refRange);
    expect(fitLowFlat?.chao).toBe('11');
    expect(fitHighFlat?.chao).toBe('55');

    // Same contour shape shifted upward in register yields higher Chao digits
    const lowRise = Array.from({ length: 25 }, (_, i) => ({ u: i / 24, hz: 110 + (45 * i) / 24 }));
    const highRise = Array.from({ length: 25 }, (_, i) => ({ u: i / 24, hz: 165 + (85 * i) / 24 }));
    const fitLowRise = fitChaoFromPitchCurve(lowRise, refRange);
    const fitHighRise = fitChaoFromPitchCurve(highRise, refRange);
    expect(fitLowRise?.chao).toBe('13');
    expect(fitHighRise?.chao).toBe('35');
  });

  it('S3: classifies obstruent endpoints accurately, omits unmeasured t_ms, and reads 16 kHz WAV metadata', () => {
    expect(classifyContinuumPhone('s')).toEqual({
      role: 'frication_end_voicing_onset',
      manner: 'fricative',
      articulator: 'coronal',
    });
    expect(classifyContinuumPhone('t̚')).toEqual({
      role: 'closure_onset',
      manner: 'stop',
      articulator: 'coronal',
    });
    expect(classifyContinuumPhone('a')).toEqual({
      role: 'nucleus',
      manner: 'vowel',
      articulator: 'vowel',
    });

    const neutral19 = new Array(19).fill(0);
    const sCls = classifyContinuumPhone('s');
    const shCls = classifyContinuumPhone('ʂ');
    const lmA: ContinuumLandmark[] = [
      { slot_id: 'primary', ...sCls, ipa: 's', params: neutral19 },
    ];
    const lmB: ContinuumLandmark[] = [
      { slot_id: 'primary', ...shCls, ipa: 'ʂ', params: neutral19 },
    ];
    const built = buildContinuum2D({
      id: 'vc_continuum_5',
      label_a: '[s]',
      label_b: '[ʂ]',
      landmarks_a: lmA,
      landmarks_b: lmB,
      steps_a: 5,
      steps_b: 1,
      dim2: { kind: 'phonation', regime_a: 'modal', regime_b: 'breathy' },
      sample_rate_hz: 16000,
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.value.sample_rate_hz).toBe(16000);
      const cell0 = built.value.cells[0];
      expect(cell0.landmarks[0].manner).toBe('fricative');
      expect(cell0.landmarks[0].articulator).toBe('coronal');
      expect('t_ms' in cell0.landmarks[0]).toBe(false);
    }

    const wav16k = makeWav16leMono(16000, 10560);
    const meta = inspectWavHeader(wav16k);
    expect(meta).toEqual({
      sampleRateHz: 16000,
      numSamples: 10560,
      durationS: 0.66,
    });
  });

  it('S6: fills silent pause gaps in exported TextGrid and splits overlapping clips onto companion tiers', () => {
    const proj = makeTestProject();
    const makeSyl = (id: string, text: string, ipa: string, sSec: number, eSec: number): Syllable => ({
      id,
      text,
      ipa: [ipa],
      nucleus_index: 0,
      start_smp: Math.round(sSec * SAMPLE_RATE_HZ),
      end_smp: Math.round(eSec * SAMPLE_RATE_HZ),
      anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
      segments: [
        {
          id: `${id}_p1`,
          ipa,
          role: 'nucleus',
          voiced: true,
          elastic: true,
          start_smp: Math.round(sSec * SAMPLE_RATE_HZ),
          end_smp: Math.round(eSec * SAMPLE_RATE_HZ),
        },
      ],
      targets: [],
      overrides: { poses: [], pressure: [], f0_resid: [], glottis: [] },
    });

    const syl1 = makeSyl('s1', '啊', 'a', 0, 0.3);
    const syl2 = makeSyl('s2', '衣', 'i', 0.6, 1.0);
    const clipA: Clip = {
      id: 'c1',
      kind: 'phrase',
      start_smp: 0,
      end_smp: SAMPLE_RATE_HZ,
      syllable_order: ['s1', 's2'],
      syllables: { s1: syl1, s2: syl2 },
    };
    const sylOverlap = makeSyl('s3', '乌', 'u', 0.2, 0.8);
    const clipB: Clip = {
      id: 'c2',
      kind: 'phrase',
      start_smp: Math.round(0.2 * SAMPLE_RATE_HZ),
      end_smp: Math.round(0.8 * SAMPLE_RATE_HZ),
      syllable_order: ['s3'],
      syllables: { s3: sylOverlap },
    };
    proj.clip_order = ['c1', 'c2'];
    proj.clips = { c1: clipA, c2: clipB };

    const grid = projectToTextGrid(proj);
    const intervalTiers = grid.tiers.filter((t) => t.kind === 'IntervalTier');
    expect(intervalTiers.map((t) => t.name)).toEqual(['syllable', 'phone', 'syllable_2', 'phone_2']);

    for (const tier of intervalTiers) {
      if (tier.kind !== 'IntervalTier') continue;
      expect(tier.intervals.length).toBeGreaterThanOrEqual(1);
      expect(tier.intervals[0].xmin).toBe(0);
      expect(tier.intervals.at(-1)?.xmax).toBe(1);
      for (let i = 1; i < tier.intervals.length; i++) {
        expect(tier.intervals[i].xmin).toBe(tier.intervals[i - 1].xmax);
        expect(tier.intervals[i].xmax).toBeGreaterThan(tier.intervals[i].xmin);
      }
    }

    const primaryPhone = intervalTiers.find((t) => t.name === 'phone');
    expect(primaryPhone?.kind === 'IntervalTier' ? primaryPhone.intervals : []).toEqual([
      { xmin: 0, xmax: 0.3, text: 'a' },
      { xmin: 0.3, xmax: 0.6, text: '' },
      { xmin: 0.6, xmax: 1, text: 'i' },
    ]);

    // Round-trip serialized TextGrid parses cleanly
    const reparsed = parseTextGrid(stringifyTextGrid(grid));
    expect(reparsed.ok).toBe(true);
  });

  it('S7: accepts Praat standard short-format TextGrid and rejects truncated long-format TextGrid', () => {
    const shortFormat = [
      'File type = "ooTextFile"',
      'Object class = "TextGrid"',
      '',
      '0',
      '1',
      '<exists>',
      '1',
      '"IntervalTier"',
      '"phone"',
      '0',
      '1',
      '1',
      '0',
      '1',
      '"a"',
    ].join('\n');
    const parsedShort = parseTextGrid(shortFormat);
    expect(parsedShort.ok).toBe(true);
    if (parsedShort.ok) {
      expect(parsedShort.value.tiers).toHaveLength(1);
      expect(parsedShort.value.tiers[0]).toEqual({
        kind: 'IntervalTier',
        name: 'phone',
        xmin: 0,
        xmax: 1,
        intervals: [{ xmin: 0, xmax: 1, text: 'a' }],
      });
    }

    // Header declares 3 tiers, truncated right after tier 1
    const truncatedLong = [
      'File type = "ooTextFile"',
      'Object class = "TextGrid"',
      '',
      'xmin = 0',
      'xmax = 1',
      'tiers? <exists>',
      'size = 3',
      'item []:',
      '    item [1]:',
      '        class = "IntervalTier"',
      '        name = "phone"',
      '        xmin = 0',
      '        xmax = 1',
      '        intervals: size = 1',
      '        intervals [1]:',
      '            xmin = 0',
      '            xmax = 1',
      '            text = "a"',
    ].join('\n');
    const parsedTrunc = parseTextGrid(truncatedLong);
    expect(parsedTrunc.ok).toBe(false);

    // Tier declares 2 intervals, truncated after interval 1
    const truncatedIntervals = [
      'File type = "ooTextFile"',
      'Object class = "TextGrid"',
      '',
      'xmin = 0',
      'xmax = 1',
      'tiers? <exists>',
      'size = 1',
      'item []:',
      '    item [1]:',
      '        class = "IntervalTier"',
      '        name = "phone"',
      '        xmin = 0',
      '        xmax = 1',
      '        intervals: size = 2',
      '        intervals [1]:',
      '            xmin = 0',
      '            xmax = 0.5',
      '            text = "a"',
    ].join('\n');
    expect(parseTextGrid(truncatedIntervals).ok).toBe(false);
  });

  it('S9 & S10: accurately documents Tract2Area-Proxy 6-zone output, benchmark protocol, and --mode flags', () => {
    const areaSpec = LOCAL_MODEL_SPECS.find((m) => m.name === 'Tract2Area-Proxy');
    expect(areaSpec).toBeDefined();
    expect(areaSpec!.role).toContain('6 维');
    expect(areaSpec!.role).not.toContain('65 截面');
    expect(MODEL_TRAINING_REPORT_META.cpuBenchmarkProtocol).toContain('ONNX Runtime');
    for (const rec of RETRAINING_RECIPES) {
      if (rec.commands.includes('export_onnx_models.py')) {
        expect(rec.commands).toContain('--mode ');
        expect(rec.commands).not.toMatch(/export_onnx_models\.py\s+--(benchmark|finalize)/);
      }
    }
  });

  it('R3 & R4: MixerSpectrogramCache never spawns Worker after destroy() and IpaRecordingAnalysisRunner cancels stale jobs', async () => {
    const origOffCtx = globalThis.OfflineAudioContext;
    const origWorker = globalThis.Worker;
    let workerConstructed = 0;

    try {
      // Simulate async decodeAudioData completing AFTER destroy()
      globalThis.OfflineAudioContext = class {
        async decodeAudioData() {
          await new Promise((r) => setTimeout(r, 5));
          return {
            length: 160,
            duration: 0.01,
            sampleRate: 16000,
            numberOfChannels: 1,
            getChannelData: () => new Float32Array(160),
          } as unknown as AudioBuffer;
        }
      } as unknown as typeof OfflineAudioContext;
      globalThis.Worker = class {
        constructor() {
          workerConstructed++;
        }
        addEventListener() {}
        removeEventListener() {}
        postMessage() {}
        terminate() {}
      } as unknown as typeof Worker;

      const cache = new MixerSpectrogramCache();
      const wavBlob = new Blob([makeWav16leMono(16000, 160)], { type: 'audio/wav' });
      const pending = cache.render(wavBlob, 400, true);
      cache.destroy();
      const res = await pending;
      expect(res).toBeNull();
      expect(cache.hasActiveWorker).toBe(false);
      expect(workerConstructed).toBe(0);
    } finally {
      globalThis.OfflineAudioContext = origOffCtx;
      globalThis.Worker = origWorker;
    }

    // R4: Abort before completion resolves null cleanly while latest job computes accurate STFT
    const runner = new IpaRecordingAnalysisRunner();
    const fakeBuf = {
      numberOfChannels: 1,
      sampleRate: 16000,
      duration: 0.1,
      getChannelData: () => Float32Array.from({ length: 1600 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 16000)),
    } as unknown as AudioBuffer;
    const aborted = new AbortController();
    aborted.abort();
    expect(await runner.run(fakeBuf, aborted.signal)).toBeNull();
    const valid = await runner.run(fakeBuf);
    expect(valid).not.toBeNull();
    expect(valid!.columns).toBeGreaterThanOrEqual(240);
    runner.destroy();
  });

  it('L1: fits 1120x700 (16:10) window on a 2560x1600 screen without outer overflow while allowing <16:10 horizontal scroll', () => {
    // Fixed 2560x1600 DPR=1 monitor, window resized to 1120x700 (exact 16:10)
    const scale1120 = computeAutoPageScale({
      screenWidth: 2560,
      screenHeight: 1600,
      dpr: 1,
      innerWidth: 1120,
      innerHeight: 700,
    });
    const vp1120 = computeDesktopViewportSize(1120, 700, scale1120, true);
    expect(vp1120).toEqual({ width: 1120, height: 700 });
    expect(vp1120.width / scale1120).toBeGreaterThanOrEqual(MIN_SHELL_WIDTH_PX);
    expect(vp1120.height / scale1120).toBeGreaterThanOrEqual(MIN_SHELL_HEIGHT_PX);

    // 1440x900 and 2560x1600 on the same 2560x1600 screen remain at 100% scale
    expect(
      computeAutoPageScale({ screenWidth: 2560, screenHeight: 1600, dpr: 1, innerWidth: 1440, innerHeight: 900 }),
    ).toBe(1);
    expect(
      computeAutoPageScale({ screenWidth: 2560, screenHeight: 1600, dpr: 1, innerWidth: 2560, innerHeight: 1600 }),
    ).toBe(1);

    // Narrower than 16:10 (900x700) keeps height=700 without vertical overflow and widens width for horizontal scroll
    const scale900 = computeAutoPageScale({
      screenWidth: 2560,
      screenHeight: 1600,
      dpr: 1,
      innerWidth: 900,
      innerHeight: 700,
    });
    const vp900 = computeDesktopViewportSize(900, 700, scale900, true);
    expect(vp900.height).toBe(700);
    expect(vp900.width).toBeGreaterThan(900);
  });
});
