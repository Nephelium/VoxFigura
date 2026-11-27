"""Regression coverage for F0 and voicing alignment in Voice Mixer."""

from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import numpy as np

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE))

from keyframe_lite import AnnotationControlError
from m27_bridge import M27Bridge
from voice_morph_bridge import AnalyzedClip, VoiceMorphBridge

M27Bridge.ensure_tt3_imports()

from m27_voice_morph import morpher
from m27_voice_morph.curves import F0ShiftOutOfRange, apply_f0_semitone_coupling
from m27_voice_morph.presets import BUILTIN_PHONATION_PRESETS, CustomPresetStore, ORGAN_GROUPS


class VoiceMixerTest(unittest.TestCase):
    def test_explicit_f0_offset_reports_out_of_range(self):
        with self.assertRaises(F0ShiftOutOfRange) as error:
            apply_f0_semitone_coupling(np.array([400.0]), np.array([1.0]), semitones=12,
                                       output_range_hz=(60.0, 600.0))
        self.assertEqual(error.exception.hz, 800.0)

    def test_falsetto_reaches_target_at_eighty_percent_and_respects_manual_shift(self):
        track = morpher.denormalize_m27_norm(np.zeros((5, 27), dtype=np.float32))
        track[:, morpher.F0_INDEX] = [150, 125, 140, 155, 350]
        source = morpher.normalize_m27_phys(track)
        gate = np.array([0, 0.75, 0.75, 0.75, 0.75], dtype=np.float32)
        config = morpher.PresetMorphConfig(
            preset_id="falsetto", knots=[{"t": 0, "v": 0.8}, {"t": 1, "v": 0.8}],
            enable_f0_coupling=True, output_f0_range_hz=(60.0, 600.0),
        )
        with patch.object(morpher, "compute_voicing_and_speech_gates", return_value=(gate, gate)):
            result = morpher.apply_preset_phonation_morph(source, config)
            self.assertEqual(result["f0_target_hz"], 400.0)
            before, after = result["f0_before_hz"], result["f0_after_hz"]
            self.assertEqual(float(after[0]), float(before[0]))
            self.assertAlmostEqual(float(np.median(after[1:])), 400.0, delta=0.2)
            self.assertLessEqual(float(after.max()), 600.0)
            self.assertTrue(np.all(np.diff(after[1:]) > 0))

            config.f0_shift_semitones = 0
            manual = morpher.apply_preset_phonation_morph(source, config)
            self.assertIsNone(manual["f0_target_hz"])
            np.testing.assert_array_equal(manual["f0_after_hz"], before)

    def test_source_voicing_is_warped_to_target_clock_before_register_estimation(self):
        a = np.zeros((4, 27), dtype=np.float32)
        b = np.zeros((7, 27), dtype=np.float32)
        b_voiced = np.array([0, 0, 1, 1, 1, 0, 0], dtype=np.float32)
        config = morpher.DualMorphConfig(align_mode="anchors", anchors_sec=[{"t_a": 0.04, "t_b": 0.1}],
                                        enable_f0_coupling=True,
                                        group_curves={"glottis": [{"t": 0, "v": 1}, {"t": 1, "v": 1}]})
        with patch.object(morpher, "compute_voicing_and_speech_gates", wraps=morpher.compute_voicing_and_speech_gates) as gates:
            result = morpher.apply_dual_speaker_morph(a, b, config, f0_voiced_b=b_voiced)
        expected = np.interp(result["frame_map_b"], np.arange(len(b_voiced)), b_voiced)
        np.testing.assert_allclose(gates.call_args.kwargs["f0_voiced"], expected)

    def test_custom_preset_store_saves_and_deletes_only_custom_entries(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            store = CustomPresetStore(Path(tmpdir) / "presets.json")
            entry = store.save_custom("custom_test", label="测试气声", source9_phys=[8000.0] + [0.0] * 8)
            self.assertEqual(entry["id"], "custom_test")
            self.assertIn("custom_test", store.load_all())
            self.assertFalse(store.delete_custom("breathy"))
            self.assertTrue(store.delete_custom("custom_test"))
            self.assertNotIn("custom_test", store.load_all())

    def test_organ_groups_include_coupling_notes_and_official_model_names(self):
        self.assertIn("coupling_note", ORGAN_GROUPS["glottis"])
        self.assertTrue(ORGAN_GROUPS["speaker"].get("is_speaker"))
        for group in ORGAN_GROUPS.values():
            combined = f"{group.get('label', '')} {group.get('desc', '')} {group.get('coupling_note', '')}"
            self.assertNotIn("Stage 4", combined)
            self.assertNotIn("Stage 5", combined)
        self.assertIn("timing", ORGAN_GROUPS)
        self.assertTrue(ORGAN_GROUPS["timing"].get("is_timing"))
        self.assertTrue(ORGAN_GROUPS["timing"].get("requires_alignment"))

    def test_timing_prosody_track_requires_anchors_and_blends_segment_durations(self):
        a = np.zeros((50, 27), dtype=np.float32)  # 1.00 s at 50 Hz
        b = np.zeros((100, 27), dtype=np.float32)  # 2.00 s at 50 Hz
        b[:, 0] = 0.5
        anchors = [{"t_a": 0.4, "t_b": 1.0}]  # Segment 1: 0.4s -> 1.0s, Segment 2: 0.6s -> 1.0s

        # Without anchors, timing curve must be rejected cleanly
        with self.assertRaises(ValueError):
            morpher.apply_dual_speaker_morph(
                a, b,
                morpher.DualMorphConfig(
                    align_mode="dtw",
                    group_curves={"timing": [{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}]},
                ),
            )

        # At 100% timing weight, output length matches B (100 frames = 2.00 s) while keeping A's voice/tract
        res_full = morpher.apply_dual_speaker_morph(
            a, b,
            morpher.DualMorphConfig(
                align_mode="anchors",
                anchors_sec=anchors,
                group_curves={"timing": [{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}]},
            ),
        )
        self.assertEqual(res_full["m27_norm"].shape[0], 100)
        self.assertEqual(len(res_full["applied_curves"]["timing"]), 50)
        self.assertAlmostEqual(float(np.max(np.abs(res_full["m27_norm"][:, 0]))), 0.0, places=4)

        # At 50% timing weight, output duration is halfway (~75 frames = 1.50 s)
        res_half = morpher.apply_dual_speaker_morph(
            a, b,
            morpher.DualMorphConfig(
                align_mode="anchors",
                anchors_sec=anchors,
                group_curves={
                    "timing": [{"t": 0.0, "v": 0.5}, {"t": 1.0, "v": 0.5}],
                    "larynx": [{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                },
                delta_groups=[],
            ),
        )
        self.assertEqual(res_half["m27_norm"].shape[0], 75)
        self.assertAlmostEqual(float(np.mean(res_half["m27_norm"][:, 0])), 0.5, places=3)

    def test_include_baseline_and_render_baseline_cache_unmodulated_reconstruction(self):
        from voice_morph_bridge import AnalyzedClip, VoiceMorphBridge

        bridge = VoiceMorphBridge(M27Bridge())
        clip = AnalyzedClip(
            clip_id="clip_base_1",
            name="测试片段",
            wav_16k=np.zeros(3200, dtype=np.float32),
            m27_norm=np.zeros((10, 27), dtype=np.float32),
            m27_phys=np.tile(np.array([0.0] * 17 + [140.0, 8000.0] + [0.04, 0.04, 0.02, 1.2, 0.8, 0.5, 15.0, 5.0], dtype=np.float32), (10, 1)),
            f0_voiced=np.ones(10, dtype=np.float32),
            voiced_gate=np.ones(10, dtype=np.float32),
            speech_gate=np.ones(10, dtype=np.float32),
            spk_emb=np.ones((1, 512), dtype=np.float32) / np.sqrt(512.0),
            dur_sec=0.2,
            n_frames=10,
            invert_ms=4.0,
        )
        bridge.clips[clip.clip_id] = clip

        calls = []

        def fake_synth(m27_norm, spk_seq, device):
            calls.append(float(np.mean(np.abs(m27_norm[:, 19:]))))
            return np.full(m27_norm.shape[0] * 320, 0.1, dtype=np.float32), 16000

        with patch.object(bridge, "_synthesize_neural_onnx", side_effect=fake_synth), \
             patch.object(bridge.native_engine, "_validate_requested_device", return_value=None):
            res1 = bridge.dispatch({
                "action": "render_preset",
                "clip_id": "clip_base_1",
                "preset_id": "breathy",
                "knots": [{"t": 0.0, "v": 0.8}, {"t": 1.0, "v": 0.8}],
                "synth": "neural",
                "device": "cpu",
                "include_baseline": True,
            })
            self.assertTrue(res1["ok"])
            self.assertIn("baseline_audio_base64", res1)
            self.assertEqual(res1["baseline_rate_hz"], 16000)
            self.assertEqual(len(calls), 2)  # 1 modulated + 1 unmodulated baseline

            # Second render with different curve reuses cached baseline without re-running vocoder on baseline
            res2 = bridge.dispatch({
                "action": "render_preset",
                "clip_id": "clip_base_1",
                "preset_id": "pressed",
                "knots": [{"t": 0.0, "v": 0.9}, {"t": 1.0, "v": 0.9}],
                "synth": "neural",
                "device": "cpu",
                "include_baseline": True,
            })
            self.assertEqual(res2["baseline_audio_base64"], res1["baseline_audio_base64"])
            self.assertEqual(len(calls), 3)

            res_only = bridge.dispatch({
                "action": "render_baseline",
                "clip_id": "clip_base_1",
                "synth": "neural",
                "device": "cpu",
            })
            self.assertTrue(res_only["ok"])
            self.assertEqual(res_only["baseline_audio_base64"], res1["baseline_audio_base64"])
            self.assertEqual(len(calls), 3)


    def test_diplophonia_dual_source_modes_ratio_and_validation(self):
        preset = BUILTIN_PHONATION_PRESETS["diplophonia"]
        self.assertTrue(preset.get("supports_diplophonia"))
        self.assertFalse(preset.get("experimental"))
        self.assertAlmostEqual(preset["default_diplophonia_ratio"], 0.73, places=2)

        base_phys = morpher.denormalize_m27_norm(np.zeros((20, 27), dtype=np.float32))
        base_phys[:, morpher.F0_INDEX] = np.linspace(140.0, 180.0, 20)
        base_phys[:, morpher.PR_INDEX] = 8500.0
        source = morpher.normalize_m27_phys(base_phys)
        gate = np.array([0.0, 0.0] + [1.0] * 16 + [0.0, 0.0], dtype=np.float32)

        with patch.object(morpher, "compute_voicing_and_speech_gates", return_value=(gate, gate)):
            par = morpher.apply_preset_phonation_morph(
                source,
                morpher.PresetMorphConfig(
                    preset_id="diplophonia",
                    knots=[{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                    smooth_ms=0.0,
                    diplophonia_mode="parallel",
                    diplophonia_ratio=0.73,
                    output_f0_range_hz=(40.0, 600.0),
                ),
            )
            vent = morpher.apply_preset_phonation_morph(
                source,
                morpher.PresetMorphConfig(
                    preset_id="diplophonia",
                    knots=[{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                    smooth_ms=0.0,
                    diplophonia_mode="ventricular",
                    diplophonia_ratio=0.58,
                    output_f0_range_hz=(40.0, 600.0),
                ),
            )
            vert = morpher.apply_preset_phonation_morph(
                source,
                morpher.PresetMorphConfig(
                    preset_id="diplophonia",
                    knots=[{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                    smooth_ms=0.0,
                    diplophonia_mode="vertical",
                    diplophonia_ratio=1.37,
                    output_f0_range_hz=(40.0, 600.0),
                ),
            )

        for label, res, exp_am in (("parallel", par, 0.0), ("ventricular", vent, 0.28), ("vertical", vert, 0.16)):
            dip = res["diplophonia"]
            self.assertIsNotNone(dip, label)
            self.assertEqual(dip["mode"], label)
            self.assertAlmostEqual(dip["am_depth_max"], exp_am, places=2)
            # 17-dim vocal tract must be bit-identical between primary and secondary tracks
            np.testing.assert_array_equal(res["m27_phys"][:, :17], dip["m27_secondary_phys"][:, :17])
            # Unvoiced boundary frames preserve primary F0 cleanly
            self.assertAlmostEqual(float(dip["f_b_50hz"][0]), float(res["f0_after_hz"][0]), places=2)

        # Parallel ratio tracks exact user ratio f2/f1 on voiced frames
        ratios_par = par["diplophonia"]["f_b_50hz"][2:18] / par["f0_after_hz"][2:18]
        self.assertAlmostEqual(float(np.median(ratios_par)), 0.73, delta=0.01)
        ratios_vert = vert["diplophonia"]["f_b_50hz"][2:18] / vert["f0_after_hz"][2:18]
        self.assertAlmostEqual(float(np.median(ratios_vert)), 1.37, delta=0.03)

        # VTL 2.4 physical mode rejects out-of-range secondary F0 cleanly (no silent clamping)
        with patch.object(morpher, "compute_voicing_and_speech_gates", return_value=(gate, gate)):
            with self.assertRaises(F0ShiftOutOfRange):
                morpher.apply_preset_phonation_morph(
                    source,
                    morpher.PresetMorphConfig(
                        preset_id="diplophonia",
                        knots=[{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                        smooth_ms=0.0,
                        diplophonia_mode="parallel",
                        diplophonia_ratio=0.20,
                        output_f0_range_hz=(40.0, 600.0),
                    ),
                )

        # mix_diplophonia_audio keeps unvoiced prefix pure Track A and adds a-b sideband under AM
        sr = 16000
        t = np.arange(int(sr * 0.6), dtype=np.float64) / sr
        wav_a = (0.4 * np.sin(2.0 * np.pi * 150.0 * t)).astype(np.float32)
        wav_b = (0.4 * np.sin(2.0 * np.pi * 95.0 * t)).astype(np.float32)
        curve = np.array([0.0] * 10 + [1.0] * 20, dtype=np.float32)
        fb = np.full(30, 95.0, dtype=np.float32)
        lin = morpher.mix_diplophonia_audio(wav_a, wav_b, curve, fb, sr, ratio_b_max=0.36, am_depth_max=0.0)
        am = morpher.mix_diplophonia_audio(wav_a, wav_b, curve, fb, sr, ratio_b_max=0.36, am_depth_max=0.28)
        self.assertLess(float(np.max(np.abs(lin[:1600] - wav_a[:1600]))), 1e-4)
        seg_lin = lin[int(0.28 * sr) : int(0.56 * sr)] * np.hanning(int(0.28 * sr))
        seg_am = am[int(0.28 * sr) : int(0.56 * sr)] * np.hanning(int(0.28 * sr))
        freqs = np.fft.rfftfreq(8192, d=1.0 / sr)
        spec_lin = np.abs(np.fft.rfft(seg_lin, n=8192))
        spec_am = np.abs(np.fft.rfft(seg_am, n=8192))
        sb_mask = np.abs(freqs - 55.0) <= 4.0  # f_a - f_b = 150 - 95 = 55 Hz
        self.assertGreater(float(np.max(spec_am[sb_mask])), float(np.max(spec_lin[sb_mask])) * 5.0)

        # Bridge rejects out-of-range diplophonia_ratio with HTTP 400 out_of_range contract
        native = MagicMock()
        native._validate_requested_device.return_value = None
        bridge = VoiceMorphBridge(native)
        bridge.clips["clip_dip_1"] = AnalyzedClip(
            clip_id="clip_dip_1",
            name="dip.wav",
            wav_16k=np.zeros(6400, dtype=np.float32),
            m27_norm=source,
            m27_phys=base_phys,
            f0_voiced=gate,
            voiced_gate=gate,
            speech_gate=gate,
            spk_emb=np.zeros((20, 512), dtype=np.float32),
            dur_sec=0.4,
            n_frames=20,
            invert_ms=5.0,
        )
        with self.assertRaises(AnnotationControlError) as ctx:
            bridge.dispatch({
                "action": "render_preset",
                "clip_id": "clip_dip_1",
                "preset_id": "diplophonia",
                "knots": [{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                "diplophonia_mode": "parallel",
                "diplophonia_ratio": 3.5,
                "synth": "neural",
                "device": "cpu",
            })
        self.assertEqual(ctx.exception.result["error"]["code"], "out_of_range")
        self.assertEqual(ctx.exception.result["error"]["field"], "diplophonia_ratio")

    def test_experimental_voqs_presets_and_larynx_height_offset(self):
        for preset_id in (
            "creak",
            "whispery_creaky",
            "raised_larynx",
            "lowered_larynx",
            "diplophonia",
        ):
            self.assertIn(preset_id, BUILTIN_PHONATION_PRESETS)
            self.assertEqual(len(BUILTIN_PHONATION_PRESETS[preset_id]["source9_phys"]), 9)
            self.assertFalse(BUILTIN_PHONATION_PRESETS[preset_id].get("experimental"))
        for preset_id in ("whispery_falsetto", "creaky_falsetto", "whispery_creaky_falsetto"):
            self.assertIn(preset_id, BUILTIN_PHONATION_PRESETS)
            self.assertEqual(len(BUILTIN_PHONATION_PRESETS[preset_id]["source9_phys"]), 9)
            self.assertTrue(BUILTIN_PHONATION_PRESETS[preset_id].get("experimental"))
        self.assertNotIn("harsh", BUILTIN_PHONATION_PRESETS)

        base_phys = morpher.denormalize_m27_norm(np.zeros((6, 27), dtype=np.float32))
        base_phys[:, 1] = -4.8  # HY baseline in cm
        source = morpher.normalize_m27_phys(base_phys)
        gate = np.ones(6, dtype=np.float32)

        with patch.object(morpher, "compute_voicing_and_speech_gates", return_value=(gate, gate)):
            raised = morpher.apply_preset_phonation_morph(
                source,
                morpher.PresetMorphConfig(
                    preset_id="raised_larynx",
                    knots=[{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                    smooth_ms=0.0,
                ),
            )
            lowered = morpher.apply_preset_phonation_morph(
                source,
                morpher.PresetMorphConfig(
                    preset_id="lowered_larynx",
                    knots=[{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                    smooth_ms=0.0,
                ),
            )
        self.assertAlmostEqual(float(np.mean(raised["m27_phys"][:, 1])), -3.6, places=2)
        self.assertAlmostEqual(float(np.mean(lowered["m27_phys"][:, 1])), -6.0, places=2)

    def test_creaky_lowers_f0_near_40hz_and_creaky_falsetto_raises_f0(self):
        track = morpher.denormalize_m27_norm(np.zeros((20, 27), dtype=np.float32))
        track[:, morpher.F0_INDEX] = np.linspace(150.0, 210.0, 20)
        track[:, morpher.PR_INDEX] = 8500.0
        source = morpher.normalize_m27_phys(track)
        gate = np.array([0.0] + [0.85] * 19, dtype=np.float32)

        with patch.object(morpher, "compute_voicing_and_speech_gates", return_value=(gate, gate)):
            creaky_res = morpher.apply_preset_phonation_morph(
                source,
                morpher.PresetMorphConfig(
                    preset_id="creaky",
                    knots=[{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                    enable_f0_coupling=True,
                    output_f0_range_hz=(40.0, 600.0),
                ),
            )
            creak_res = morpher.apply_preset_phonation_morph(
                source,
                morpher.PresetMorphConfig(
                    preset_id="creak",
                    knots=[{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                    enable_f0_coupling=True,
                    output_f0_range_hz=None,  # Neural wide-range supports ~30 Hz pulse creak
                ),
            )
            creaky_falsetto_res = morpher.apply_preset_phonation_morph(
                source,
                morpher.PresetMorphConfig(
                    preset_id="creaky_falsetto",
                    knots=[{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                    enable_f0_coupling=True,
                    output_f0_range_hz=(40.0, 600.0),
                ),
            )
            whisper_res = morpher.apply_preset_phonation_morph(
                source,
                morpher.PresetMorphConfig(
                    preset_id="whisper",
                    knots=[{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                    smooth_ms=0.0,
                ),
            )
            voiceless_res = morpher.apply_preset_phonation_morph(
                source,
                morpher.PresetMorphConfig(
                    preset_id="voiceless",
                    knots=[{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                    smooth_ms=0.0,
                ),
            )
            # Physical mode rejects 30 Hz creak cleanly instead of silently clamping
            with self.assertRaises(F0ShiftOutOfRange):
                morpher.apply_preset_phonation_morph(
                    source,
                    morpher.PresetMorphConfig(
                        preset_id="creak",
                        knots=[{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                        enable_f0_coupling=True,
                        output_f0_range_hz=(40.0, 600.0),
                    ),
                )

        # Creaky (~60 Hz) & Creak (~30 Hz neural) & Creaky Falsetto (~290 Hz) all exhibit irregular F0 jitter
        self.assertEqual(creaky_res["f0_target_hz"], 60.0)
        self.assertEqual(float(creaky_res["f0_after_hz"][0]), float(creaky_res["f0_before_hz"][0]))
        self.assertAlmostEqual(float(np.median(creaky_res["f0_after_hz"][1:])), 60.0, delta=6.0)
        self.assertGreaterEqual(float(creaky_res["f0_after_hz"][1:].min()), 40.0)
        self.assertGreater(float(np.std(np.diff(creaky_res["f0_after_hz"][1:]))), 1.0)

        self.assertEqual(creak_res["f0_target_hz"], 30.0)
        self.assertAlmostEqual(float(np.median(creak_res["f0_after_hz"][1:])), 30.0, delta=4.5)
        self.assertGreater(float(np.std(np.diff(creak_res["f0_after_hz"][1:]))), 1.0)

        self.assertEqual(creaky_falsetto_res["f0_target_hz"], 310.0)
        self.assertAlmostEqual(float(np.median(creaky_falsetto_res["f0_after_hz"][1:])), 310.0, delta=25.0)
        self.assertGreater(float(np.std(np.diff(creaky_falsetto_res["f0_after_hz"][1:]))), 2.0)

        # Voiceless has lower PR and wider glottis than whisper (weaker glottal frication)
        self.assertLess(
            float(np.mean(voiceless_res["m27_phys"][1:, morpher.PR_INDEX])),
            float(np.mean(whisper_res["m27_phys"][1:, morpher.PR_INDEX])) * 0.72,
        )
        self.assertGreater(
            float(np.mean(voiceless_res["m27_phys"][1:, 19])),
            float(np.mean(whisper_res["m27_phys"][1:, 19])) + 0.10,
        )

        # Creak irregularity slider: 0.0 -> regular (near-zero jitter), 1.0 -> stronger irregular jitter
        with patch.object(morpher, "compute_voicing_and_speech_gates", return_value=(gate, gate)):
            reg_creak = morpher.apply_preset_phonation_morph(
                source,
                morpher.PresetMorphConfig(
                    preset_id="creaky_falsetto",
                    knots=[{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                    enable_f0_coupling=True,
                    creak_irregularity=0.0,
                    output_f0_range_hz=(40.0, 600.0),
                ),
            )
            irreg_creak = morpher.apply_preset_phonation_morph(
                source,
                morpher.PresetMorphConfig(
                    preset_id="creaky_falsetto",
                    knots=[{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                    enable_f0_coupling=True,
                    creak_irregularity=1.0,
                    output_f0_range_hz=(40.0, 600.0),
                ),
            )
        self.assertLess(
            float(np.std(np.diff(reg_creak["f0_after_hz"][1:]))),
            float(np.std(np.diff(irreg_creak["f0_after_hz"][1:]))) * 0.25,
        )

        # Whispery compound presets carry light open posterior chink CA (0.020..0.065 cm^2) so whisper never drowns pitch/creak
        for wid in ("whispery_creaky", "whispery_falsetto", "whispery_creaky_falsetto"):
            ca = BUILTIN_PHONATION_PRESETS[wid]["source9_phys"][3]
            self.assertGreaterEqual(ca, 0.020)
            self.assertLessEqual(ca, 0.065)

        # Falsetto (F2) attaches voiced softening, Creaky Falsetto (CF4) attaches subharmonic alternation,
        # and Whispery Creaky Falsetto (WCF5) attaches subharmonic + shared-tract 22% whisper air layer
        with patch.object(morpher, "compute_voicing_and_speech_gates", return_value=(gate, gate)):
            fal_post = morpher.apply_preset_phonation_morph(
                source,
                morpher.PresetMorphConfig(
                    preset_id="falsetto",
                    knots=[{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                    enable_f0_coupling=True,
                ),
            )["audio_post"]
            wcf_res = morpher.apply_preset_phonation_morph(
                source,
                morpher.PresetMorphConfig(
                    preset_id="whispery_creaky_falsetto",
                    knots=[{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                    enable_f0_coupling=True,
                ),
            )
        self.assertIn("soft_falsetto", fal_post)
        self.assertIn("subharmonic_creak", wcf_res["audio_post"])
        self.assertAlmostEqual(wcf_res["audio_post"]["whisper_air"]["ratio_b_max"], 0.22, places=2)
        np.testing.assert_array_equal(
            wcf_res["m27_phys"][:, :17],
            wcf_res["audio_post"]["whisper_air"]["m27_whisper_phys"][:, :17],
        )

        # Verify pure-NumPy falsetto softening attenuates >950 Hz on voiced frames while leaving unvoiced untouched
        sr = 16000
        t = np.arange(int(sr * 0.5), dtype=np.float64) / sr
        sig = (0.3 * np.sin(2.0 * np.pi * 310.0 * t) + 0.3 * np.sin(2.0 * np.pi * 2400.0 * t)).astype(np.float32)
        curve = np.array([0.0] * 10 + [1.0] * 15, dtype=np.float32)
        soft = morpher.apply_voiced_falsetto_softening(sig, curve, sr, cutoff_hz=950.0, atten_db=-10.0)
        self.assertLess(float(np.max(np.abs(soft[:1600] - sig[:1600]))), 1e-4)
        sub = morpher.apply_subharmonic_creaky_falsetto(
            (0.4 * np.sin(2.0 * np.pi * 310.0 * t)).astype(np.float32),
            np.full(25, 310.0, dtype=np.float32),
            curve,
            sr,
            w2=0.28,
            w3=0.44,
            w4=0.28,
            irregularity=0.30,
        )
        seg_sub = sub[int(0.25 * sr) : int(0.48 * sr)] * np.hanning(int(0.23 * sr))
        fr_sub = np.fft.rfftfreq(8192, d=1.0 / sr)
        sp_sub = np.abs(np.fft.rfft(seg_sub, n=8192))
        # f0 - f0/3 (~207 Hz) & f0/3 (~103 Hz) subharmonic sidebands clearly emerge
        self.assertGreater(
            float(np.max(sp_sub[np.abs(fr_sub - 207.0) <= 12.0])),
            float(np.max(sp_sub[np.abs(fr_sub - 310.0) <= 10.0])) * 0.15,
        )

        # All 5 creak / creaky presets default to 30% pulse irregularity
        for cid in ("creaky", "creak", "whispery_creaky", "creaky_falsetto", "whispery_creaky_falsetto"):
            self.assertAlmostEqual(
                BUILTIN_PHONATION_PRESETS[cid]["default_creak_irregularity"],
                0.30,
                places=2,
            )

        # Female / high-pitched speaker (modal ~280 Hz) still gets clear adaptive upward F0 lift on falsetto & creaky_falsetto
        female_track = morpher.denormalize_m27_norm(np.zeros((16, 27), dtype=np.float32))
        female_track[:, morpher.F0_INDEX] = np.linspace(260.0, 300.0, 16)
        female_track[:, morpher.PR_INDEX] = 8500.0
        female_src = morpher.normalize_m27_phys(female_track)
        female_gate = np.array([0.0] + [0.85] * 15, dtype=np.float32)
        with patch.object(morpher, "compute_voicing_and_speech_gates", return_value=(female_gate, female_gate)):
            fem_falsetto = morpher.apply_preset_phonation_morph(
                female_src,
                morpher.PresetMorphConfig(
                    preset_id="falsetto",
                    knots=[{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                    enable_f0_coupling=True,
                    output_f0_range_hz=None,
                ),
            )
            fem_creaky_falsetto = morpher.apply_preset_phonation_morph(
                female_src,
                morpher.PresetMorphConfig(
                    preset_id="creaky_falsetto",
                    knots=[{"t": 0.0, "v": 1.0}, {"t": 1.0, "v": 1.0}],
                    enable_f0_coupling=True,
                    output_f0_range_hz=None,
                ),
            )
        self.assertGreater(float(np.median(fem_falsetto["f0_after_hz"][1:])), 430.0)
        self.assertGreater(float(np.median(fem_creaky_falsetto["f0_after_hz"][1:])), 370.0)

        pressed_src = BUILTIN_PHONATION_PRESETS["pressed"]["source9_phys"]
        self.assertLess(pressed_src[1], 0.0)  # negative XB medial compression
        self.assertLess(pressed_src[2], 0.0)  # negative XT medial compression
        self.assertLessEqual(pressed_src[3], 0.0)  # sealed CA chink
        self.assertGreaterEqual(pressed_src[6], 0.85)  # sharp closing pulse PS

    def test_extract_custom_preset_uses_middle_40_percent_steady_frames(self):
        from m27_voice_morph.presets import extract_phonation_preset_from_m27_phys

        # 10 active frames surrounded by 2 silent frames at each end:
        # middle 40% of the 10 active frames = active indices 3..6 (4 steady frames)
        m27 = np.zeros((14, 27), dtype=np.float32)
        voiced = np.array([False, False] + [True] * 10 + [False, False], dtype=bool)
        # Onset/offset active frames carry outlier PR/RA/F0, while middle 40% carry steady values
        m27[2:5, 17] = 300.0
        m27[2:5, 18] = 15000.0
        m27[2:5, 23] = 0.95
        m27[5:9, 17] = 160.0
        m27[5:9, 18] = 8800.0
        m27[5:9, 23] = 0.42
        m27[9:12, 17] = 90.0
        m27[9:12, 18] = 3000.0
        m27[9:12, 23] = 0.05

        extracted = extract_phonation_preset_from_m27_phys(m27, voiced_mask=voiced)
        self.assertEqual(extracted["frames_used"], 4)
        self.assertAlmostEqual(extracted["ref_f0_hz"], 160.0, places=1)
        self.assertAlmostEqual(extracted["source9_phys"][0], 8800.0, places=1)
        self.assertAlmostEqual(extracted["source9_phys"][5], 0.42, places=2)
        self.assertFalse(extracted["is_voiceless_target"])


if __name__ == "__main__":
    unittest.main()
