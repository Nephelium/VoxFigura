import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeMidi } from 'midi-file';
import {
  CommandBus,
  PRESSURE_LIMIT_PA,
  SAMPLE_RATE_HZ,
  TRACT_PARAM_LIMITS,
  VTL_F0_LIMIT_HZ,
  assertValidF0Hz,
  checkRange,
  evalF0,
  evaluatePhonationAnchorsAt,
  evaluatePhonationTrackDense,
  heldPhonationAt,
  heldPhonationAtChecked,
  parseNumberedScore,
  scaleStopTimingMs,
  schedule,
  type PhonationAnchor,
  type TractParamName,
  type VcProject,
} from '@vocalcut/core';
import {
  VTL_PARAM_META,
  VTL_PARAM_ORDER,
  defaultTractParams,
  tractRecordToArray19,
  useWorkbenchStore,
} from '../src/stores/workbench';
import {
  VOQS_BUILTIN_PRESET_DEFAULTS,
  formatGlottis9Specs,
  normalizeMixerPreset,
} from '../src/components/research/voice-mixer';
import {
  computeShiftedPresetF0,
  row27ToTractAndGlottis,
} from '../src/components/phonetic-card/card/playback-sources';
import { buildJapaneseAccentClipData } from '../src/data/prosody-model';
import { resolveContinuumFramePitch } from '../src/components/research/continuum-media';
import {
  AntiAliasingResampler,
  base64ToFloat32Int16,
  decodeTract3DFrame,
} from '../src/components/research/m27-realtime';
import { readMidiParts } from '../src/components/studio/midi-score';
import { sanitizeExternalHttpUrl } from '../src/data/app-update';

const REPO_ROOT = resolve(__dirname, '..');

function makeMinimalProject(): VcProject {
  return {
    schema: 'vocalcut/project',
    schema_version: 1,
    revision: 1,
    id: 'prj_review_2026_11_26',
    name: 'Review Test',
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
        speaker: 'JD2',
        dimension: '3d',
        geometry: 'm10/r21',
        sections: 65,
        preset_pack: { id: 'pk_default_ipa', sha256: 'builtin' },
        f0_ref_hz: 160,
        range_st: [-6, 14],
        seed: 42,
      },
    },
    asset_order: [],
    assets: {},
    track_order: ['tr_art'],
    tracks: { tr_art: { id: 'tr_art', kind: 'articulation', voice_id: 'vo_a', clip_order: ['cl_1'] } },
    clip_order: ['cl_1'],
    clips: {
      cl_1: {
        id: 'cl_1',
        kind: 'phrase',
        voice_id: 'vo_a',
        start_smp: 0,
        end_smp: 24000,
        syllable_order: ['sy_1'],
        syllables: {
          sy_1: {
            id: 'sy_1',
            text: '啊',
            ipa: ['a'],
            nucleus_index: 0,
            start_smp: 0,
            end_smp: 24000,
            anchor: { tick: 0, policy: 'nucleus_on_beat', lead_ms: 0, bias_ms: 0 },
            segments: [{ id: 'sg_1', ipa: 'a', role: 'nucleus', start_smp: 0, end_smp: 24000, voiced: true, elastic: true }],
            targets: [],
            overrides: { poses: [], f0_resid: [], pressure: [], glottis: [] },
          },
        },
      },
    },
    layer_order: [],
    layers: {},
    phonation_anchor_order: [],
    phonation_anchors: {},
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

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (/\.(ts|tsx|vue|mjs|js)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe('2026-11-26 Code Review Fixes Regression Suite', () => {
  it('A-01: core-ts, workbench.ts, and engine/validation.py share identical 19-dim tract bounds', () => {
    const pySrc = readFileSync(join(REPO_ROOT, 'engine', 'validation.py'), 'utf8');
    const namesMatch = pySrc.match(/TRACT19_JD2_NAMES[\s\S]*?=\s*\(([\s\S]*?)\)/);
    const minMatch = pySrc.match(/TRACT19_JD2_MIN\s*=\s*np\.array\(\s*\[([\s\S]*?)\]/);
    const maxMatch = pySrc.match(/TRACT19_JD2_MAX\s*=\s*np\.array\(\s*\[([\s\S]*?)\]/);
    expect(namesMatch).toBeTruthy();
    expect(minMatch).toBeTruthy();
    expect(maxMatch).toBeTruthy();

    const pyNames = Array.from(namesMatch![1].matchAll(/"([A-Z0-9]+)"/g), (m) => m[1]) as TractParamName[];
    const pyMin = minMatch![1].split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    const pyMax = maxMatch![1].split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));

    expect(pyNames).toHaveLength(19);
    expect(pyMin).toHaveLength(19);
    expect(pyMax).toHaveLength(19);
    expect(VTL_PARAM_ORDER).toEqual(pyNames);

    const metaByKey = new Map(VTL_PARAM_META.map((m) => [m.key, m]));
    for (let i = 0; i < 19; i++) {
      const key = pyNames[i];
      const coreLim = TRACT_PARAM_LIMITS[key];
      const uiMeta = metaByKey.get(key);
      expect(coreLim, `core-ts bound for ${key}`).toEqual([pyMin[i], pyMax[i]]);
      expect(uiMeta, `workbench meta for ${key}`).toBeDefined();
      expect([uiMeta!.min, uiMeta!.max], `workbench bound for ${key}`).toEqual([pyMin[i], pyMax[i]]);
    }

    expect(TRACT_PARAM_LIMITS.TRX).toEqual([-4.0, 2.0]);
    expect(TRACT_PARAM_LIMITS.TRY).toEqual([-6.0, 0.0]);

    // CommandBus accepts TRY=-5.5 and rejects TRX=3.0
    const bus = new CommandBus(makeMinimalProject());
    const validParams = tractRecordToArray19({ ...defaultTractParams(), TRX: 1.5, TRY: -5.5 });
    const okRes = bus.execute({ op: 'artic.set_pose', args: { syllable: 'sy_1', seg: 0, params: validParams } });
    expect(okRes.ok).toBe(true);

    const badParams = tractRecordToArray19({ ...defaultTractParams(), TRX: 3.0 });
    const badRes = bus.execute({ op: 'artic.set_pose', args: { syllable: 'sy_1', seg: 0, params: badParams } });
    expect(badRes.ok).toBe(false);
    if (!badRes.ok) {
      expect(badRes.error.code).toBe('out_of_range');
      expect(badRes.error.field).toBe('params[TRX]');
    }
  });

  it('A-12: numbered score rests accumulate into subsequent syllable beat_smp (《1》《2》 vs 《1》 0 《2》)', () => {
    const parsed12 = parseNumberedScore('《1》 《2》', 'C3', 60, false, 2);
    const parsed102 = parseNumberedScore('《1》 0 《2》', 'C3', 60, false, 2);
    expect(parsed12.ok && parsed102.ok).toBe(true);
    if (!parsed12.ok || !parsed102.ok) return;

    const syllables = [
      { id: 's1', text: '啊', segments: [{ id: 'g1', ipa: 'a', role: 'nucleus' as const, voiced: true, preferred_ms: 400 }] },
      { id: 's2', text: '哦', segments: [{ id: 'g2', ipa: 'o', role: 'nucleus' as const, voiced: true, preferred_ms: 400 }] },
    ];

    const res12 = schedule({ score: parsed12.score, leading_reserve_ms: 100, f_ref_hz: 160, syllables });
    const res102 = schedule({ score: parsed102.score, leading_reserve_ms: 100, f_ref_hz: 160, syllables });
    expect(res12.ok && res102.ok).toBe(true);
    if (!res12.ok || !res102.ok) return;

    expect(res12.value.syllables.map((s) => s.beat_smp)).toEqual([4800, 52800]);
    expect(res102.value.syllables.map((s) => s.beat_smp)).toEqual([4800, 100800]);
    expect(res102.value.syllables[0].end_smp).toBeLessThanOrEqual(res102.value.syllables[1].start_smp);
    // Rest gap around 1.5 s (72000 smp) has zero pressure and is unvoiced
    const restIdx = Math.floor(72000 / res102.value.step_smp);
    expect(res102.value.pressure_pa[restIdx]).toBe(0);
    expect(res102.value.voiced_mask[restIdx]).toBe(false);
  });

  it('A-13: allow_vowel_delay_on_conflict prevents overlapping segments with double coda at 240 BPM', () => {
    const res = schedule({
      bpm: 240,
      leading_reserve_ms: 100,
      f_ref_hz: 200,
      allow_vowel_delay_on_conflict: true,
      syllables: [
        {
          id: 'syl_a',
          text: '安',
          note_hz: 261.63,
          note_beats: 0.5,
          segments: [
            { id: 'a_v', ipa: 'a', role: 'nucleus', voiced: true, preferred_ms: 120 },
            { id: 'a_c1', ipa: 'n', role: 'coda', voiced: true, preferred_ms: 80, min_ms: 50 },
            { id: 'a_c2', ipa: 't', role: 'coda', voiced: false, preferred_ms: 80, min_ms: 50 },
          ],
        },
        {
          id: 'syl_b',
          text: '巴',
          note_hz: 293.66,
          note_beats: 0.5,
          segments: [
            { id: 'b_o', ipa: 'p', role: 'onset', voiced: false, preferred_ms: 80, min_ms: 50 },
            { id: 'b_v', ipa: 'a', role: 'nucleus', voiced: true, preferred_ms: 120 },
          ],
        },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.issues.some((it) => it.key === 'song_short')).toBe(true);
    const segs = res.value.segments;
    for (let i = 0; i < segs.length; i++) {
      expect(segs[i].end_smp).toBeGreaterThan(segs[i].start_smp);
      if (i + 1 < segs.length) {
        expect(segs[i].end_smp).toBeLessThanOrEqual(segs[i + 1].start_smp);
      }
    }
  });

  it('A-14: schedule validates stop rigid floors, preserves speech stop duration, and rejects scaleStopTimingMs < 11 ms', () => {
    // Below closure floor (4 ms < 10 ms) must be rejected at schedule entry
    const badClosure = schedule({
      f_ref_hz: 180,
      syllables: [
        {
          id: 's1',
          text: '怕',
          segments: [
            {
              id: 'p_stop',
              ipa: 'pʰ',
              role: 'onset',
              voiced: false,
              preferred_ms: 12,
              stop_timing: { closure_ms: 4, release_ms: 2, aspiration_ms: 30, vot_ms: 32 },
            },
            { id: 'v_a', ipa: 'a', role: 'nucleus', voiced: true, preferred_ms: 180 },
          ],
        },
      ],
    });
    expect(badClosure.ok).toBe(false);
    if (!badClosure.ok) expect(['rigid_floor', 'out_of_range']).toContain(badClosure.error.code);

    // Below release floor (0.5 ms < 1 ms) must be rejected
    const badRelease = schedule({
      f_ref_hz: 180,
      syllables: [
        {
          id: 's1',
          text: '巴',
          segments: [
            {
              id: 'p_stop',
              ipa: 'p',
              role: 'onset',
              voiced: false,
              preferred_ms: 50,
              stop_timing: { closure_ms: 40, release_ms: 0.5, aspiration_ms: 0, vot_ms: 0.5 },
            },
            { id: 'v_a', ipa: 'a', role: 'nucleus', voiced: true, preferred_ms: 180 },
          ],
        },
      ],
    });
    expect(badRelease.ok).toBe(false);
    if (!badRelease.ok) expect(['rigid_floor', 'out_of_range']).toContain(badRelease.error.code);

    // Speech path ensures segment duration >= closure + release + aspiration
    const validSpeech = schedule({
      f_ref_hz: 180,
      syllables: [
        {
          id: 's1',
          text: '怕',
          segments: [
            {
              id: 'p_stop',
              ipa: 'pʰ',
              role: 'onset',
              voiced: false,
              preferred_ms: 12,
              stop_timing: { closure_ms: 12, release_ms: 3, aspiration_ms: 30, vot_ms: 33 },
            },
            { id: 'v_a', ipa: 'a', role: 'nucleus', voiced: true, preferred_ms: 180 },
          ],
        },
      ],
    });
    expect(validSpeech.ok).toBe(true);
    if (validSpeech.ok) {
      const stopSeg = validSpeech.value.segments.find((s) => s.id === 'p_stop')!;
      expect(stopSeg.end_smp - stopSeg.start_smp).toBeGreaterThanOrEqual(Math.round(0.045 * SAMPLE_RATE_HZ));
    }

    // scaleStopTimingMs rejects targetMs < 11 ms
    const scaledFail = scaleStopTimingMs({ closure_ms: 40, release_ms: 5, aspiration_ms: 15, vot_ms: 20 }, 9);
    expect(scaledFail.ok).toBe(false);
    if (!scaledFail.ok) expect(scaledFail.error.code).toBe('rigid_floor');

    const scaledOk = scaleStopTimingMs({ closure_ms: 40, release_ms: 5, aspiration_ms: 15, vot_ms: 20 }, 20);
    expect(scaledOk.ok).toBe(true);
    if (scaledOk.ok) {
      expect(scaledOk.value.closure_ms).toBeGreaterThanOrEqual(10);
      expect(scaledOk.value.release_ms).toBeGreaterThanOrEqual(1);
      expect(scaledOk.value.closure_ms + scaledOk.value.release_ms + scaledOk.value.aspiration_ms).toBeCloseTo(20, 5);
    }
  });

  it('A-02: voice-mixer.ts uses Pa directly with zero /10 dPa conversion', () => {
    expect(VOQS_BUILTIN_PRESET_DEFAULTS.modal.source9_phys_pa[0]).toBe(820);
    expect(VOQS_BUILTIN_PRESET_DEFAULTS.pressed.source9_phys_pa[0]).toBe(1150);
    const specs = formatGlottis9Specs(VOQS_BUILTIN_PRESET_DEFAULTS.modal.source9_phys_pa);
    expect(specs[0]).toEqual({ key: 'PR', label: '肺下压', value: '820', unit: 'Pa' });

    const normalized = normalizeMixerPreset({
      id: 'custom_1',
      label: 'Custom',
      desc: '',
      f0_shift_semitones: 0,
      is_voiceless_target: false,
      builtin: false,
      source_params: {
        pr_pa: 950,
        xb_cm: 0.04,
        xt_cm: 0.04,
        ca_cm2: 0.02,
        lag_rad: 1.2,
        ra: 0.9,
        ps: 0.5,
        fl_pct: 15,
        shim_pct: 5,
      },
    });
    expect(normalized.source9_phys_pa?.[0]).toBe(950);

    const mixerSource = readFileSync(join(REPO_ROOT, 'src', 'components', 'research', 'voice-mixer.ts'), 'utf8');
    expect(mixerSource).not.toMatch(/prDpa|\/\s*10\b/);
  });

  it('A-03, A-04, A-06, A-08 & checkRange: reject out-of-range inputs without silent clamping', async () => {
    // Unified checkRange & assertValidF0Hz helpers
    const rOk = checkRange(120, VTL_F0_LIMIT_HZ, 'f0_hz', 'Hz');
    expect(rOk.ok).toBe(true);
    expect(assertValidF0Hz('f0_hz', 20).ok).toBe(true);
    expect(assertValidF0Hz('f0_hz', 1200).ok).toBe(true);
    expect(assertValidF0Hz('f0_hz', 0).ok).toBe(false);
    const rTupleBad = checkRange(3.5, TRACT_PARAM_LIMITS.TRX, 'TRX', 'cm');
    expect(rTupleBad.ok).toBe(false);
    if (!rTupleBad.ok) {
      expect(rTupleBad.error.code).toBe('out_of_range');
      expect(rTupleBad.error.allowed).toEqual({ min: -4, max: 2, unit: 'cm' });
    }

    // A-03: row27ToTractAndGlottis rejects out-of-range PR and non-positive F0, while accepting wide F0
    const fallbackTract = defaultTractParams();
    const fallbackGlottis = {
      f0_hz: 140, pr_pa: 800, xb_cm: 0.04, xt_cm: 0.04, ca_cm2: 0.02, lag_rad: 1.2, ra: 1, ps: 0.5, fl: 20, shim: 0,
    };
    const rowBadPr = Array(27).fill(0);
    rowBadPr[17] = 150;
    rowBadPr[18] = 2200; // > 1600 Pa
    const prRes = row27ToTractAndGlottis(rowBadPr, fallbackTract, fallbackGlottis);
    expect(prRes.ok).toBe(false);
    if (!prRes.ok) {
      expect(prRes.error.code).toBe('out_of_range');
      expect(prRes.error.allowed).toEqual({ min: PRESSURE_LIMIT_PA.min, max: PRESSURE_LIMIT_PA.max, unit: 'Pa' });
    }

    const rowWideF0 = Array(27).fill(0);
    rowWideF0[17] = 25;
    rowWideF0[18] = 800;
    expect(row27ToTractAndGlottis(rowWideF0, fallbackTract, fallbackGlottis).ok).toBe(true);

    const rowNonPositiveF0 = Array(27).fill(0);
    rowNonPositiveF0[17] = 0;
    rowNonPositiveF0[18] = 800;
    const f0Res = row27ToTractAndGlottis(rowNonPositiveF0, fallbackTract, fallbackGlottis);
    expect(f0Res.ok).toBe(false);
    if (!f0Res.ok) expect(f0Res.error.code).toBe('out_of_range');

    // A-06: computeShiftedPresetF0 allows wide positive shifted F0 and rejects non-positive inputs
    const shiftWide = computeShiftedPresetF0(450, 10);
    expect(shiftWide.ok).toBe(true);
    const shiftBad = computeShiftedPresetF0(0, 10);
    expect(shiftBad.ok).toBe(false);
    if (!shiftBad.ok) expect(shiftBad.error.code).toBe('out_of_range');

    // A-04: buildJapaneseAccentClipData rejects non-positive baseF0 instead of replacing with 165 Hz
    await expect(buildJapaneseAccentClipData('あめ', 'JD2', 1, 0)).rejects.toMatchObject({
      code: 'out_of_range',
    });

    // A-08: resolveContinuumFramePitch accepts wide positive F0 and rejects non-positive source F0
    const contWide = resolveContinuumFramePitch({
      leftF0Hz: 25,
      rightF0Hz: 1200,
      leftEndpointF0Hz: 150,
      rightEndpointF0Hz: 180,
      alpha: 0.5,
      axisOverrideHz: null,
      frameIndex: 2,
    });
    expect(contWide.ok).toBe(true);
    const contBad = resolveContinuumFramePitch({
      leftF0Hz: 0,
      rightF0Hz: 180,
      leftEndpointF0Hz: 150,
      rightEndpointF0Hz: 180,
      alpha: 0.5,
      axisOverrideHz: null,
      frameIndex: 2,
    });
    expect(contBad.ok).toBe(false);
    if (!contBad.ok) {
      expect(contBad.error.code).toBe('out_of_range');
      expect(contBad.error.field).toBe('continuum.sourceA.f0_hz');
    }
  });

  it('A-05 & A-11: AntiAliasingResampler attenuates >8 kHz aliasing, odd-byte base64 is guarded, and unpaired MIDI noteOff warns without throwing', () => {
    // 1. Passband preservation (1 kHz @ 48 kHz -> 16 kHz across multiple chunks)
    const resamplerPass = new AntiAliasingResampler(16000, 7200);
    const chunksPass: number[] = [];
    const sr = 48000;
    const total = sr; // 1 s
    const blockSize = 768;
    for (let off = 0; off < total; off += blockSize) {
      const len = Math.min(blockSize, total - off);
      const blk = new Float32Array(len);
      for (let i = 0; i < len; i++) blk[i] = Math.sin((2 * Math.PI * 1000 * (off + i)) / sr);
      const out = resamplerPass.process(blk, sr);
      for (let i = 0; i < out.length; i++) chunksPass.push(out[i]);
    }
    // Trim filter warmup/tail and compute RMS of steady-state 1 kHz sine (ideal RMS = 1/sqrt(2) ≈ 0.7071)
    const steadyPass = chunksPass.slice(200, chunksPass.length - 200);
    const rmsPass = Math.sqrt(steadyPass.reduce((s, v) => s + v * v, 0) / steadyPass.length);
    expect(rmsPass).toBeGreaterThan(0.68);
    expect(rmsPass).toBeLessThan(0.73);

    // 2. Stopband attenuation (12 kHz @ 48 kHz -> 16 kHz must attenuate > 45 dB)
    const resamplerStop48 = new AntiAliasingResampler(16000, 7200);
    const chunksStop48: number[] = [];
    for (let off = 0; off < total; off += blockSize) {
      const len = Math.min(blockSize, total - off);
      const blk = new Float32Array(len);
      for (let i = 0; i < len; i++) blk[i] = Math.sin((2 * Math.PI * 12000 * (off + i)) / sr);
      const out = resamplerStop48.process(blk, sr);
      for (let i = 0; i < out.length; i++) chunksStop48.push(out[i]);
    }
    const steadyStop48 = chunksStop48.slice(200, chunksStop48.length - 200);
    const rmsStop48 = Math.sqrt(steadyStop48.reduce((s, v) => s + v * v, 0) / steadyStop48.length);
    const attenuationDb48 = 20 * Math.log10(rmsPass / Math.max(1e-12, rmsStop48));
    expect(attenuationDb48).toBeGreaterThan(45);

    // 3. Ratio < 2.5 (24 kHz -> 16 kHz, 10 kHz tone must also be strongly attenuated)
    const resamplerStop24 = new AntiAliasingResampler(16000, 7200);
    const chunksStop24: number[] = [];
    for (let off = 0; off < 24000; off += 512) {
      const len = Math.min(512, 24000 - off);
      const blk = new Float32Array(len);
      for (let i = 0; i < len; i++) blk[i] = Math.sin((2 * Math.PI * 10000 * (off + i)) / 24000);
      const out = resamplerStop24.process(blk, 24000);
      for (let i = 0; i < out.length; i++) chunksStop24.push(out[i]);
    }
    const steadyStop24 = chunksStop24.slice(200, chunksStop24.length - 200);
    const rmsStop24 = Math.sqrt(steadyStop24.reduce((s, v) => s + v * v, 0) / steadyStop24.length);
    const attenuationDb24 = 20 * Math.log10(rmsPass / Math.max(1e-12, rmsStop24));
    expect(attenuationDb24).toBeGreaterThan(35);

    // 4. base64ToFloat32Int16 odd byte payload does not throw RangeError
    const oddBytes = new Uint8Array([0x00, 0x40, 0xff]); // 3 bytes -> 1 valid int16 sample (16384)
    const oddB64 = btoa(String.fromCharCode(...oddBytes));
    const decoded = base64ToFloat32Int16(oddB64);
    expect(decoded.length).toBe(1);
    expect(decoded[0]).toBeCloseTo(0.5, 4);

    // 5. decodeTract3DFrame fallbackLimited derived from VTL_PARAM_META defaults
    const verts = new Float32Array([0, 0, 0]);
    const vertsB64 = btoa(String.fromCharCode(...new Uint8Array(verts.buffer)));
    const frame3d = decodeTract3DFrame(
      {
        vertices_f32_b64: vertsB64,
        contours: {},
        nasal_port_area: 0,
        ja_deg: -3.2,
        jx_cm: -0.1,
        ld_cm: 0.8,
        lp_cm: 0.4,
        vo: 0.1,
        tcy_cm: -1.2,
        tty_cm: -0.5,
      },
      [{ name: 'tongue', nv: 1, ribs: 1, points: 1, triangles: new Uint16Array(0) }],
    );
    expect(frame3d).not.toBeNull();
    expect(frame3d!.limited).toHaveLength(19);
    expect(frame3d!.limited[VTL_PARAM_ORDER.indexOf('JA')]).toBe(-3.2);
    expect(frame3d!.limited[VTL_PARAM_ORDER.indexOf('HX')]).toBe(
      VTL_PARAM_META.find((m) => m.key === 'HX')!.defaultVal,
    );

    // 6. MIDI import ignores stray unpaired noteOff and records a warning
    const midiBytes = writeMidi({
      header: { format: 0, numTracks: 1, ticksPerBeat: 480 },
      tracks: [
        [
          { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 }, // stray unpaired noteOff
          { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 96 },
          { deltaTime: 480, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
          { deltaTime: 0, type: 'endOfTrack' },
        ],
      ],
    });
    const imported = readMidiParts(Uint8Array.from(midiBytes));
    expect(imported.parts).toHaveLength(1);
    expect(imported.parts[0].notes).toHaveLength(1);
    expect(imported.warnings.length).toBeGreaterThan(0);
  });

  it('A-10 & A-15: qTA warns on fast level-target pitch leaps and evaluates unsorted pins cleanly', () => {
    const res = evalF0({
      total_smp: 9600, // 200 ms
      step_smp: 240,
      f_ref_hz: 200,
      context: 'singing',
      spans: [
        {
          id: 'sp1',
          span_id: 'n1',
          start_smp: 0,
          end_smp: 4800, // 100 ms
          voiced: true,
          candidates: { score: { m_st_per_s: 0, b_end_st: 0, lambda_per_s: 80, source: 'score' } },
        },
        {
          id: 'sp2',
          span_id: 'n2',
          start_smp: 4800,
          end_smp: 9600, // 100 ms, +12 st leap -> 120 st/s > Xu & Sun rising limit (10.8 + 5.6*12 = 78.0 st/s)
          voiced: true,
          candidates: { score: { m_st_per_s: 0, b_end_st: 12, lambda_per_s: 80, source: 'score' } },
        },
      ],
      pins: [
        {
          id: 'p1',
          start_smp: 2400,
          end_smp: 4800,
          transition_ms: 20,
          exit_fit_ms: 20,
          // Intentionally unsorted pin points
          points: [
            { t_smp: 4800, f0_hz: 220 },
            { t_smp: 2400, f0_hz: 200 },
            { t_smp: 3600, f0_hz: 210 },
          ],
        },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.speed_warnings.some((w) => w.span_id === 'n2')).toBe(true);
    const w = res.value.speed_warnings.find((x) => x.span_id === 'n2')!;
    // Pin exits at 220 Hz (+1.65 st), so net leap to +12 st is ~10.35 st -> Xu & Sun rising limit ≈ 10.8 + 5.6 * 10.35 ≈ 68.8 st/s
    const expectedExcursion = 12 - 12 * Math.log2(220 / 200);
    expect(w.limit_st_per_s).toBeCloseTo(10.8 + 5.6 * expectedExcursion, 0);
  });

  it('A-16: phonation rejects out-of-range blend in both interpolated and held modes', () => {
    const badAnchors: PhonationAnchor[] = [
      { id: 'bad1', t_smp: 0, regime: 'breathy', blend: 1.5 },
    ];
    const interpRes = evaluatePhonationAnchorsAt(badAnchors, 1200);
    expect(interpRes.ok).toBe(false);
    if (!interpRes.ok) expect(interpRes.error.code).toBe('out_of_range');

    const denseRes = evaluatePhonationTrackDense(badAnchors, 2400, 240);
    expect(denseRes.ok).toBe(false);
    if (!denseRes.ok) expect(denseRes.error.code).toBe('out_of_range');

    const heldChk = heldPhonationAtChecked(badAnchors, 1200);
    expect(heldChk.ok).toBe(false);
    if (!heldChk.ok) expect(heldChk.error.code).toBe('out_of_range');

    expect(() => heldPhonationAt(badAnchors, 1200)).toThrow(RangeError);
  });

  it('D-06 & D-12: CommandBus bounds oplog and keeps revision monotonic; workbench validates artic.set_pose and relative delta', () => {
    // 1. CommandBus oplog truncation & monotonic revision
    const bus = new CommandBus(makeMinimalProject(), 3);
    for (let i = 0; i < 6; i++) {
      const r = bus.execute({
        op: 'artic.set_pose_delta',
        args: { syllable: 'sy_1', seg: 0, delta: { LP: 0.05 } },
      });
      expect(r.ok).toBe(true);
    }
    expect(bus.getOpLog().length).toBeLessThanOrEqual(3);
    const revBeforeUndo = bus.getRevision();
    expect(bus.undo().ok).toBe(true);
    expect(bus.getRevision()).toBe(revBeforeUndo + 1);
    expect(bus.redo().ok).toBe(true);
    expect(bus.getRevision()).toBe(revBeforeUndo + 2);

    // 2. Workbench store artic.set_pose validation + relative delta + monotonic undo/redo
    const store = useWorkbenchStore();
    const badKeyRes = store.executeCommand({
      type: 'artic.set_pose',
      payload: { params: { UNKNOWN_KEY: 0.5 } },
    });
    expect(badKeyRes.ok).toBe(false);
    expect(badKeyRes.error?.code).toBe('validation_error');

    const nanRes = store.executeCommand({
      type: 'artic.set_pose',
      payload: { params: { LP: Number.NaN } },
    });
    expect(nanRes.ok).toBe(false);
    expect(nanRes.error?.code).toBe('validation_error');

    // Absolute params object
    const setAbs = store.executeCommand({
      type: 'artic.set_pose',
      payload: { params: { LP: 0.1 } },
    });
    expect(setAbs.ok).toBe(true);
    expect(store.currentTractParams.value.LP).toBeCloseTo(0.1, 5);

    // Relative delta adds onto current LP (0.1 + 0.25 = 0.35)
    const setDelta = store.executeCommand({
      type: 'artic.set_pose',
      payload: { delta: { LP: 0.25 } },
    });
    expect(setDelta.ok).toBe(true);
    expect(store.currentTractParams.value.LP).toBeCloseTo(0.35, 5);

    // 19-dim params array works and updates state
    const arr19 = tractRecordToArray19({ ...defaultTractParams(), LP: -0.2 });
    const setArr = store.executeCommand({
      type: 'artic.set_pose',
      payload: { params: arr19 },
    });
    expect(setArr.ok).toBe(true);
    expect(store.currentTractParams.value.LP).toBeCloseTo(-0.2, 5);

    // Undo / redo keep store project.revision strictly monotonic
    const revAfterEdit = store.project.value.revision;
    expect(store.undo()).toBe(true);
    expect(store.project.value.revision).toBe(revAfterEdit + 1);
    expect(store.currentTractParams.value.LP).toBeCloseTo(0.35, 5);
    expect(store.redo()).toBe(true);
    expect(store.project.value.revision).toBe(revAfterEdit + 2);
    expect(store.currentTractParams.value.LP).toBeCloseTo(-0.2, 5);
  });

  it('D-15: src/ contains zero direct fetch("/api/(m27|vtl)/") calls bypassing model-adapters', () => {
    const srcFiles = walkSourceFiles(join(REPO_ROOT, 'src'));
    const offenders: string[] = [];
    const directFetchRe = /fetch\s*\(\s*['"`]\/api\/(?:m27|vtl)\//;
    for (const file of srcFiles) {
      const text = readFileSync(file, 'utf8');
      if (directFetchRe.test(text)) {
        offenders.push(file.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('D-01, D-02 & D-04 frontend guards: portable gate, confirmation modal, JSON headers, and HTTPS-only update URLs', () => {
    const settingsSrc = readFileSync(join(REPO_ROOT, 'src', 'views', 'SettingsView.vue'), 'utf8');
    expect(settingsSrc).toContain('__APP_PORTABLE__');
    expect(settingsSrc).toContain('<PortableCachePanel v-if="isPortableRuntime"');

    const cachePanelSrc = readFileSync(join(REPO_ROOT, 'src', 'components', 'settings', 'PortableCachePanel.vue'), 'utf8');
    expect(cachePanelSrc).toContain('export-modal-mask');
    expect(cachePanelSrc).toContain('export-modal-card');
    expect(cachePanelSrc).toContain('confirmCleanCache');
    expect(cachePanelSrc).toContain("entry.kind === 'foreign'");

    // D-04: plain HTTP bare IP and untrusted hosts are rejected
    expect(sanitizeExternalHttpUrl('http://8.134.196.183/voxfigura/updates/latest.json')).toBe('');
    expect(sanitizeExternalHttpUrl('http://www.phonetictoolbox.com/voxfigura')).toBe('');
    expect(sanitizeExternalHttpUrl('https://evil.example.com/payload.exe')).toBe('');
    expect(sanitizeExternalHttpUrl('https://www.phonetictoolbox.com/voxfigura/releases/v1.exe')).toBe(
      'https://www.phonetictoolbox.com/voxfigura/releases/v1.exe',
    );
  });
});
