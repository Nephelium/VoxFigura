"""Regression coverage for F0 and voicing alignment in Voice Mixer."""

from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE))

from m27_bridge import M27Bridge

M27Bridge.ensure_tt3_imports()

from m27_voice_morph import morpher
from m27_voice_morph.curves import F0ShiftOutOfRange, apply_f0_semitone_coupling
from m27_voice_morph.presets import CustomPresetStore, ORGAN_GROUPS


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


if __name__ == "__main__":
    unittest.main()
