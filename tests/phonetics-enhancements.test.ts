import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE_HZ, type Clip, type VcProject } from '@vocalcut/core';
import {
  CENTRAL_OPEN_UNROUNDED_KEY,
  CENTRAL_OPEN_UNROUNDED_LABEL,
  VOWEL_GAUSSIAN_STOPS,
  formatVowelChartLabel,
  isRoundedVowelSymbol,
  vowelSymbolKey,
} from '../src/data/ipa-vowel-measurements';
import { createIpaPoseSet, deleteIpaPoseSet, getSelectedIpaPoseParams } from '../src/data/ipa-pose-sets';
import { frequencyAxis } from '../src/components/research/ptb-physics-charts';
import {
  TIMESERIES_CSV_COLUMNS,
  buildAnnotationTimeSeriesCsv,
  buildM27ReconstructionTimeSeriesCsv,
} from '../src/data/research-timeseries-csv';
import {
  analyzeIntervalAcoustics,
  findMostModulatedSpan,
  formantGainDbIseli2007,
  mapBeforeSpanToAfter,
} from '../src/components/research/voice-quality-acoustics';

function synthesizeHarmonicVowel(opts: {
  sr: number;
  durSec: number;
  f0Hz: number;
  spectralSlopePerHarmonicDb: number;
  h1BoostDb?: number;
  noiseAmp?: number;
}): Float32Array {
  const { sr, durSec, f0Hz, spectralSlopePerHarmonicDb, h1BoostDb = 0, noiseAmp = 0 } = opts;
  const n = Math.round(sr * durSec);
  const out = new Float32Array(n);
  // Deterministic LCG PRNG for aspiration noise
  let seed = 1234567;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let acc = 0;
    for (let k = 1; k <= 18; k++) {
      const f = k * f0Hz;
      if (f >= sr * 0.46) break;
      // Add mild broad formant resonance around F1 = 520 Hz and F2 = 1520 Hz
      const f1GainDb = 10 / (1 + Math.pow((f - 520) / 140, 2));
      const f2GainDb = 7 / (1 + Math.pow((f - 1520) / 200, 2));
      const db = (k === 1 ? h1BoostDb : 0) + (k - 1) * spectralSlopePerHarmonicDb + f1GainDb + f2GainDb;
      const amp = Math.pow(10, db / 20);
      acc += amp * Math.sin(2 * Math.PI * f * t + k * 0.17);
    }
    acc += noiseAmp * nextRand();
    out[i] = acc * 0.08;
  }
  return out;
}

describe('声学元音图央低元音符号归并、圆展唇分类与默认视域', () => {
  it('将 ä / ä 与小型大写 ᴀ 归并为同一规范键并统一显示为 ᴀ(ä)', () => {
    expect(vowelSymbolKey('a\u0308')).toBe(CENTRAL_OPEN_UNROUNDED_KEY);
    expect(vowelSymbolKey('ä')).toBe(CENTRAL_OPEN_UNROUNDED_KEY);
    expect(vowelSymbolKey('ᴀ')).toBe(CENTRAL_OPEN_UNROUNDED_KEY);
    expect(vowelSymbolKey('ᴀ(ä)')).toBe(CENTRAL_OPEN_UNROUNDED_KEY);

    expect(formatVowelChartLabel('ᴀ')).toBe(CENTRAL_OPEN_UNROUNDED_LABEL);
    expect(formatVowelChartLabel('a\u0308')).toBe(CENTRAL_OPEN_UNROUNDED_LABEL);
    expect(formatVowelChartLabel('ä')).toBe(CENTRAL_OPEN_UNROUNDED_LABEL);
    expect(formatVowelChartLabel('a')).toBe('a');
    expect(formatVowelChartLabel('ɑ')).toBe('ɑ');

    const pose19 = Array.from({ length: 19 }, (_, i) => i * 0.05);
    const setId = createIpaPoseSet('测试央低元音套装', { 'ᴀ': pose19 });
    expect(setId).toBeTruthy();
    try {
      expect(getSelectedIpaPoseParams('a\u0308', setId)).toEqual(pose19);
      expect(getSelectedIpaPoseParams('ä', setId)).toEqual(pose19);
    } finally {
      if (setId) deleteIpaPoseSet(setId);
    }
  });

  it('准确区分全部圆唇元音与非圆唇元音及唇形附加符号', () => {
    const rounded = ['y', 'ʉ', 'u', 'ʏ', 'ʊ', 'ø', 'ɵ', 'o', 'œ', 'ɞ', 'ɔ', 'ɶ', 'ɒ', 'ʮ', 'ʯ', 'ɔ̃', 'iʷ', 'e̹'];
    const unrounded = ['i', 'ɨ', 'ɯ', 'ɪ', 'e', 'ɘ', 'ɤ', 'ə', 'ɛ', 'ɜ', 'ʌ', 'æ', 'ɐ', 'a', 'ᴀ', 'ᴀ(ä)', 'ɑ', 'ɿ', 'ʅ', 'ɚ', 'u̜'];

    for (const sym of rounded) {
      expect(isRoundedVowelSymbol(sym), `${sym} should be rounded`).toBe(true);
    }
    for (const sym of unrounded) {
      expect(isRoundedVowelSymbol(sym), `${sym} should be unrounded`).toBe(false);
    }

    expect(VOWEL_GAUSSIAN_STOPS[0]).toEqual([0.0, 1.0]);
    expect(VOWEL_GAUSSIAN_STOPS.at(-1)).toEqual([1.0, 0.0]);
  });

  it('包含套装构型点时自适应坐标轴覆盖完整元音四边形视域而非缩进单点', () => {
    const poseVowels = [
      { f1: 270, f2: 2290 }, // i
      { f1: 300, f2: 620 },  // u
      { f1: 785, f2: 1488 }, // a
      { f1: 609, f2: 996 },  // ɑ
    ];
    const f1Axis = frequencyAxis(poseVowels.map((p) => p.f1), 'f1');
    const f2Axis = frequencyAxis(poseVowels.map((p) => p.f2), 'f2');
    expect(f1Axis.min).toBeLessThanOrEqual(270);
    expect(f1Axis.max).toBeGreaterThanOrEqual(785);
    expect(f2Axis.min).toBeLessThanOrEqual(620);
    expect(f2Axis.max).toBeGreaterThanOrEqual(2290);
  });
});

describe('动态时间序列长表 CSV 导出 (50 Hz 逐帧与音段 10 等分点)', () => {
  it('从 M27 重建轨迹与 TextGrid 正确生成 50 Hz 及每音素 10 点长表', () => {
    const rows50HzPa = Array.from({ length: 20 }, (_, i) => [
      1.0, -4.75, 0, -3.2 - i * 0.05, 0.1, 0.8, 0.2, -0.1,
      0.5, -1.5, 3.6, -1.0, 2.2, 0.2, 0.1, 0.1, 0.05,
      150 + i * 2, // F0 Hz
      780,         // PR Pa
      0.04, 0.04, 0.02, 1.22, 0.85, 0.5, 18, 5,
    ]);
    const textGrid = {
      xmin: 0,
      xmax: 0.4,
      tiers: [
        {
          kind: 'IntervalTier' as const,
          name: 'words',
          xmin: 0,
          xmax: 0.4,
          intervals: [{ xmin: 0, xmax: 0.4, text: '八' }],
        },
        {
          kind: 'IntervalTier' as const,
          name: 'phones',
          xmin: 0,
          xmax: 0.4,
          intervals: [
            { xmin: 0, xmax: 0.12, text: 'p' },
            { xmin: 0.12, xmax: 0.4, text: 'ᴀ' },
          ],
        },
      ],
    };

    const res50 = buildM27ReconstructionTimeSeriesCsv({
      rows50HzPa,
      mode: '50hz',
      speaker: 'JD2',
      clipId: 'test_ba',
      textGrid,
    });
    expect(res50.ok).toBe(true);
    if (!res50.ok) return;
    expect(res50.rowCount).toBe(20);
    expect(res50.csv.startsWith('\uFEFF')).toBe(true);
    const lines50 = res50.csv.slice(1).split('\n');
    expect(lines50[0]).toBe(TIMESERIES_CSV_COLUMNS.join(','));
    expect(lines50).toHaveLength(21);

    const resNorm = buildM27ReconstructionTimeSeriesCsv({
      rows50HzPa,
      mode: 'norm10',
      speaker: 'JD2',
      clipId: 'test_ba',
      textGrid,
      pointsPerSegment: 10,
    });
    expect(resNorm.ok).toBe(true);
    if (!resNorm.ok) return;
    // 2 non-silent phones * 10 normalized points = 20 rows
    expect(resNorm.rowCount).toBe(20);
    const colsFirst = resNorm.csv.slice(1).split('\n')[1].split(',');
    const uPhoneCol = TIMESERIES_CSV_COLUMNS.indexOf('u_phone');
    const phoneIpaCol = TIMESERIES_CSV_COLUMNS.indexOf('phone_ipa');
    expect(colsFirst[phoneIpaCol]).toBe('p');
    expect(Number(colsFirst[uPhoneCol])).toBe(0);
    const colsTenth = resNorm.csv.slice(1).split('\n')[10].split(',');
    expect(Number(colsTenth[uPhoneCol])).toBe(1);
  });

  it('从工程标注乐句导出 50 Hz 与音段等分长表', () => {
    const durSmp = Math.round(0.3 * SAMPLE_RATE_HZ);
    const clip: Clip = {
      id: 'clip_1',
      kind: 'phrase',
      voice_id: 'v1',
      start_smp: 0,
      end_smp: durSmp,
      syllable_order: ['s1'],
      syllables: {
        s1: {
          id: 's1',
          text: '啊',
          ipa: ['a'],
          nucleus_index: 0,
          start_smp: 0,
          end_smp: durSmp,
          tone_levels: '55',
          anchor: { policy: 'speech_timing', lead_ms: null, bias_ms: 0 },
          segments: [
            {
              id: 'seg1',
              ipa: 'a',
              start_smp: 0,
              end_smp: durSmp,
              role: 'nucleus',
              elastic: true,
              voiced: true,
              params: [0.2, -4.3, -0.1, -6.5, -0.3, 2.5, 0.47, -0.1, 0.6, -2.3, 3.3, -2.0, 2.7, -1.2, -2.6, -2.5, 0.28, 0.09, 0.3],
            },
          ],
          targets: [
            {
              id: 't1',
              span_id: 's1',
              start_smp: 0,
              end_smp: durSmp,
              voiced: true,
              candidates: { default: { m_st_per_s: 0, b_end_st: 2, lambda_per_s: 45, source: 'default' } },
            },
          ],
          overrides: { poses: [], f0_resid: [], pressure: [{ u: 0, pressure_pa: 750 }, { u: 1, pressure_pa: 700 }], glottis: [] },
        },
      },
    };
    const project: VcProject = {
      schema: 'vocalcut/project',
      schema_version: 1,
      revision: 1,
      id: 'proj_test',
      name: '测试工程',
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
      voice_order: ['v1'],
      voices: {
        v1: {
          id: 'v1',
          speaker: 'JD2',
          dimension: '3d',
          geometry: 'm10/r21',
          sections: 65,
          preset_pack: { id: 'default', sha256: '0' },
          f0_ref_hz: 180,
          range_st: [-12, 12],
          seed: 1,
        },
      },
      asset_order: [],
      assets: {},
      track_order: [],
      tracks: {},
      clip_order: ['clip_1'],
      clips: { clip_1: clip },
      layer_order: [],
      layers: {},
      phonation_anchor_order: [],
      phonation_anchors: {},
      render: { container: 'mp4', video: 'h264', audio: 'aac', safe_margin_px: [32, 32], max_width_px: 1920, max_height_px: 1080 },
    };

    const res50 = buildAnnotationTimeSeriesCsv({ project, clip, mode: '50hz' });
    expect(res50.ok).toBe(true);
    if (res50.ok) expect(res50.rowCount).toBe(15); // 0.3s * 50Hz = 15 frames

    const resNorm = buildAnnotationTimeSeriesCsv({ project, clip, mode: 'norm10', pointsPerSegment: 10 });
    expect(resNorm.ok).toBe(true);
    if (resNorm.ok) expect(resNorm.rowCount).toBe(10);
  });
});

describe('发声调音台选区频谱与 H1-H2 / H2-H4 / CPP 声源声学计算', () => {
  it('准确估计紧声/常态声与气声的 H1-H2、H2-H4、H1*-H2*、CPP 与 HNR 差异', () => {
    const sr = 16000;
    const pressedModal = synthesizeHarmonicVowel({
      sr,
      durSec: 0.45,
      f0Hz: 150,
      spectralSlopePerHarmonicDb: -1.8,
      h1BoostDb: -2.0,
      noiseAmp: 0.01,
    });
    const breathy = synthesizeHarmonicVowel({
      sr,
      durSec: 0.45,
      f0Hz: 150,
      spectralSlopePerHarmonicDb: -5.5,
      h1BoostDb: 6.5,
      noiseAmp: 0.35,
    });

    const mPressed = analyzeIntervalAcoustics(pressedModal, sr, 0.05, 0.4);
    const mBreathy = analyzeIntervalAcoustics(breathy, sr, 0.05, 0.4);

    expect(mPressed.metrics.f0Hz).not.toBeNull();
    expect(Math.abs(mPressed.metrics.f0Hz! - 150)).toBeLessThan(3);

    expect(mBreathy.metrics.h1MinusH2Db!).toBeGreaterThan(mPressed.metrics.h1MinusH2Db! + 8);
    expect(mBreathy.metrics.h2MinusH4Db!).toBeGreaterThan(mPressed.metrics.h2MinusH4Db! + 4);
    expect(mBreathy.metrics.h1StarMinusH2StarDb!).toBeGreaterThan(mPressed.metrics.h1StarMinusH2StarDb! + 6);
    expect(mPressed.metrics.hnrDb!).toBeGreaterThan(mBreathy.metrics.hnrDb!);
    expect(mPressed.metrics.cppDb!).toBeGreaterThan(mBreathy.metrics.cppDb!);
    expect(mBreathy.markers.some((m) => m.key === 'H1')).toBe(true);
    expect(mBreathy.markers.some((m) => m.key === 'H2')).toBe(true);
    expect(mBreathy.markers.some((m) => m.key === 'H4')).toBe(true);

    // Formant gain is positive right near F1 peak
    const gAtF1 = formantGainDbIseli2007(520, [{ fHz: 520, bwHz: 80 }], sr);
    const gFar = formantGainDbIseli2007(1800, [{ fHz: 520, bwHz: 80 }], sr);
    expect(gAtF1).toBeGreaterThan(gFar + 8);
  });

  it('自动定位峰值调制带声区间并支持跨时长比例映射', () => {
    const curve = [0, 0.05, 0.1, 0.85, 0.95, 0.9, 0.2, 0.05, 0, 0];
    const gate = [0, 1, 1, 1, 1, 1, 1, 1, 0, 0];
    const [s0, s1] = findMostModulatedSpan(curve, gate, 2.0);
    expect(s0).toBeGreaterThan(0.35);
    expect(s1).toBeLessThan(1.55);
    expect(s1 - s0).toBeGreaterThan(0.2);

    expect(mapBeforeSpanToAfter([0.4, 0.8], 1.0, 1.0)).toEqual([0.4, 0.8]);
    const [m0, m1] = mapBeforeSpanToAfter([0.4, 0.8], 1.0, 2.0);
    expect(m0).toBeCloseTo(0.8, 3);
    expect(m1).toBeCloseTo(1.6, 3);
  });
});
