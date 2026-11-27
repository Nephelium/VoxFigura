"""Unit tests for low-latency realtime sliding-window M27 inversion & neural synthesis.

Run: python -B -m unittest discover -s engine/tests
"""
from __future__ import annotations

import base64
import io
import sys
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from realtime_m27 import HOP_16K, RealtimeM27Service  # noqa: E402


def _make_speech_like_pcm16_b64(seconds: float = 0.8, f0: float = 165.0, amp: float = 0.25) -> str:
    n = int(round(16000 * seconds))
    t = np.arange(n, dtype=np.float32) / 16000.0
    sig = amp * (
        0.65 * np.sin(2.0 * np.pi * f0 * t)
        + 0.25 * np.sin(2.0 * np.pi * 2.0 * f0 * t)
        + 0.15 * np.sin(2.0 * np.pi * 3.0 * f0 * t)
    )
    i16 = np.clip(np.round(sig * 32767.0), -32768, 32767).astype("<i2")
    return base64.b64encode(i16.tobytes()).decode("ascii")


def _make_vowel_like_pcm16_b64(seconds: float = 0.9, f0: float = 165.0, amp: float = 0.30) -> str:
    """Rich harmonic vowel-like pulse train (/a/-like formant weights) so Vox2Tract-Lite detects strong modal voicing."""
    n = int(round(16000 * seconds))
    t = np.arange(n, dtype=np.float64) / 16000.0
    sig = np.zeros(n, dtype=np.float64)
    formants = ((730.0, 90.0), (1090.0, 110.0), (2440.0, 170.0))
    for k in range(1, 22):
        freq = k * f0
        if freq >= 7200.0:
            break
        gain = 1.0 / (k ** 0.85)
        f_boost = sum(1.0 / (1.0 + ((freq - fc) / bw) ** 2) for fc, bw in formants)
        sig += gain * (0.25 + f_boost) * np.sin(2.0 * np.pi * freq * t + 0.3 * k)
    peak = float(np.max(np.abs(sig))) or 1.0
    sig = (sig / peak) * amp
    i16 = np.clip(np.round(sig * 32767.0), -32768, 32767).astype("<i2")
    return base64.b64encode(i16.tobytes()).decode("ascii")


def _make_ref_wav_b64(seconds: float = 1.0) -> str:
    n = int(round(16000 * seconds))
    t = np.arange(n, dtype=np.float32) / 16000.0
    sig = 0.22 * np.sin(2.0 * np.pi * 190.0 * t) + 0.10 * np.sin(2.0 * np.pi * 380.0 * t)
    buf = io.BytesIO()
    sf.write(buf, sig, 16000, format="WAV", subtype="PCM_16")
    return base64.b64encode(buf.getvalue()).decode("ascii")


class TestRealtimeM27Service(unittest.TestCase):
    def setUp(self) -> None:
        self.svc = RealtimeM27Service()

    def test_01_silence_fast_path_skips_heavy_models(self) -> None:
        silent_b64 = _make_speech_like_pcm16_b64(seconds=0.7, amp=0.0005)
        res = self.svc.step({
            "session_id": "test_sil",
            "pcm16le_base64": silent_b64,
            "emit_frames": 5,
            "lookahead_frames": 3,
            "include_tract_geometry": True,
            "use_timbre_model": False,
            "synthesize_audio": True,
        })
        self.assertTrue(res["ok"], res)
        self.assertTrue(res["silent"])
        self.assertFalse(res["voiced"])
        self.assertEqual(res["emit_frames"], 5)
        self.assertEqual(len(res["m27_50hz_pa"]), 5)
        self.assertIn("tract_glottis_anim", res)
        self.assertGreaterEqual(len(res["tract_glottis_anim"]["frames"]), 1)
        self.assertIn("pcm16le_base64", res)
        pcm = np.frombuffer(base64.b64decode(res["pcm16le_base64"]), dtype="<i2")
        self.assertEqual(len(pcm), 5 * HOP_16K)
        self.assertEqual(int(np.max(np.abs(pcm))), 0)

    def test_02_tract_only_mode_omits_audio(self) -> None:
        pcm_b64 = _make_speech_like_pcm16_b64(seconds=0.7, f0=170.0, amp=0.25)
        res = self.svc.step({
            "session_id": "test_tract_only",
            "pcm16le_base64": pcm_b64,
            "emit_frames": 5,
            "lookahead_frames": 3,
            "include_tract_geometry": True,
            "use_timbre_model": False,
            "synthesize_audio": False,
            "fps": 25,
        })
        self.assertTrue(res["ok"], res)
        self.assertFalse(res["silent"])
        self.assertEqual(len(res["m27_50hz_pa"]), 5)
        self.assertIn("tract_glottis_anim", res)
        self.assertGreaterEqual(len(res["tract_glottis_anim"]["frames"]), 2)
        self.assertNotIn("pcm16le_base64", res)

    def test_03_audio_without_timbre_or_geometry(self) -> None:
        pcm_b64 = _make_speech_like_pcm16_b64(seconds=1.9, f0=155.0, amp=0.25)
        res = self.svc.step({
            "session_id": "test_audio_only",
            "pcm16le_base64": pcm_b64,
            "emit_frames": 12,
            "lookahead_frames": 18,
            "include_tract_geometry": False,
            "use_timbre_model": False,
            "synthesize_audio": True,
        })
        self.assertTrue(res["ok"], res)
        self.assertNotIn("tract_glottis_anim", res)
        self.assertEqual(res["timbre_status"], "builtin-default")
        self.assertIn("pcm16le_base64", res)
        pcm = np.frombuffer(base64.b64decode(res["pcm16le_base64"]), dtype="<i2")
        self.assertEqual(len(pcm), 12 * HOP_16K + res["overlap_left_samples"])
        self.assertGreater(res["overlap_left_samples"], 0)

        # The following silence uses the same left overlap to fade the voiced tail.
        pause = self.svc.step({
            "session_id": "test_audio_only",
            "pcm16le_base64": _make_speech_like_pcm16_b64(amp=0.0005),
            "emit_frames": 7,
            "lookahead_frames": 3,
            "include_tract_geometry": False,
            "synthesize_audio": True,
        })
        self.assertTrue(pause["silent"])
        self.assertEqual(pause["overlap_left_samples"], res["overlap_left_samples"])
        pause_pcm = base64.b64decode(pause["pcm16le_base64"])
        self.assertEqual(pause_pcm, bytes(2 * (7 * HOP_16K + pause["overlap_left_samples"])))

    def test_04_prepare_speaker_and_full_realtime_pipeline_zero_torch(self) -> None:
        ref_b64 = _make_ref_wav_b64(1.0)
        prep1 = self.svc.prepare_speaker({"speaker_wav_base64": ref_b64})
        self.assertTrue(prep1["ok"], prep1)
        self.assertFalse(prep1["cached"])
        self.assertIsNotNone(prep1.get("median_f0_hz"))
        self.assertAlmostEqual(float(prep1["median_f0_hz"]), 190.0, delta=15.0)
        spk_key = prep1["speaker_key"]

        # Second call hits in-memory speaker cache (0 ms) and preserves median_f0_hz
        prep2 = self.svc.prepare_speaker({"speaker_wav_base64": ref_b64})
        self.assertTrue(prep2["ok"])
        self.assertTrue(prep2["cached"])
        self.assertEqual(prep2["speaker_key"], spk_key)
        self.assertEqual(prep2.get("median_f0_hz"), prep1.get("median_f0_hz"))

        # Full realtime step with all 3 toggles ON
        pcm_b64 = _make_speech_like_pcm16_b64(seconds=0.8, f0=180.0, amp=0.25)
        res = self.svc.step({
            "session_id": "test_full",
            "pcm16le_base64": pcm_b64,
            "emit_frames": 7,
            "lookahead_frames": 3,
            "include_tract_geometry": True,
            "use_timbre_model": True,
            "synthesize_audio": True,
            "speaker_mode": "reference",
            "speaker_key": spk_key,
        })
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["timbre_status"], "reference-cached")
        self.assertIn("tract_glottis_anim", res)
        self.assertIn("pcm16le_base64", res)
        self.assertNotIn("torch", sys.modules, "Realtime pure-ONNX service must never import torch")

    def test_05_tract_3d_compact_payload_and_topology(self) -> None:
        pcm_b64 = _make_speech_like_pcm16_b64(seconds=0.7, f0=168.0, amp=0.24)
        res1 = self.svc.step({
            "session_id": "test_3d",
            "pcm16le_base64": pcm_b64,
            "emit_frames": 5,
            "lookahead_frames": 3,
            "include_tract_geometry": True,
            "include_tract_3d": True,
            "include_tract_3d_topology": True,
            "use_timbre_model": False,
            "synthesize_audio": False,
        })
        self.assertTrue(res1["ok"], res1)
        self.assertIn("tract_3d", res1)
        t3d = res1["tract_3d"]
        self.assertIn("topology", t3d)
        self.assertEqual(len(t3d["topology"]), 9)
        total_nv = sum(part["nv"] for part in t3d["topology"])
        verts_f32 = np.frombuffer(base64.b64decode(t3d["vertices_f32_b64"]), dtype="<f4")
        self.assertEqual(len(verts_f32), total_nv * 3)
        self.assertTrue(np.all(np.isfinite(verts_f32)))
        self.assertIn("tongue", [p["name"] for p in t3d["topology"]])
        self.assertIn("upper_lip", t3d["contours"])
        self.assertIn("tongue", t3d["contours"])
        self.assertEqual(len(t3d["limited"]), 19)
        self.assertIsInstance(t3d["tongue_floor_rib"], int)

        # Subsequent step with include_tract_3d_topology=False omits redundant triangle indices
        res2 = self.svc.step({
            "session_id": "test_3d",
            "pcm16le_base64": pcm_b64,
            "emit_frames": 5,
            "lookahead_frames": 3,
            "include_tract_geometry": False,
            "include_tract_3d": True,
            "include_tract_3d_topology": False,
            "use_timbre_model": False,
            "synthesize_audio": False,
        })
        self.assertTrue(res2["ok"], res2)
        self.assertIn("tract_3d", res2)
        self.assertNotIn("topology", res2["tract_3d"])
        verts2 = np.frombuffer(base64.b64decode(res2["tract_3d"]["vertices_f32_b64"]), dtype="<f4")
        self.assertEqual(len(verts2), total_nv * 3)


    def test_06_warmup_prepares_models_without_live_session_or_pcm(self) -> None:
        result = self.svc.step({
            "warmup": True,
            "include_tract_geometry": True,
            "include_tract_3d": True,
            "synthesize_audio": True,
            "use_timbre_model": True,
            "speaker_mode": "input",
        })
        self.assertTrue(result["ok"], result)
        self.assertEqual(set(result), {"ok", "compute_ms"})
        self.assertFalse(self.svc._sessions)

    def test_07_realtime_phonation_presets_modulate_glottis_f0_and_larynx(self) -> None:
        pcm_b64 = _make_vowel_like_pcm16_b64(seconds=0.9, f0=165.0, amp=0.30)
        base = self.svc.step({
            "session_id": "test_phon_base",
            "pcm16le_base64": pcm_b64,
            "emit_frames": 6,
            "lookahead_frames": 3,
            "include_tract_geometry": False,
            "use_timbre_model": False,
            "synthesize_audio": False,
            "phonation_preset": "none",
        })
        self.assertTrue(base["ok"], base)
        self.assertEqual(base["phonation_preset"], "none")
        base_rows = np.asarray(base["m27_50hz_pa"], dtype=np.float64)

        whisper = self.svc.step({
            "session_id": "test_phon_whisper",
            "pcm16le_base64": pcm_b64,
            "emit_frames": 6,
            "lookahead_frames": 3,
            "include_tract_geometry": False,
            "use_timbre_model": False,
            "synthesize_audio": True,
            "phonation_preset": "whisper",
            "phonation_strength": 1.0,
        })
        self.assertTrue(whisper["ok"], whisper)
        self.assertEqual(whisper["phonation_preset"], "whisper")
        whisper_rows = np.asarray(whisper["m27_50hz_pa"], dtype=np.float64)
        # Whisper suppresses periodic vibration RA (col 23 -> ~0) and opens posterior gap CA (col 21)
        self.assertLess(float(np.mean(whisper_rows[:, 23])), 0.05)
        self.assertLess(float(np.mean(whisper_rows[:, 23])), float(np.mean(base_rows[:, 23])))
        self.assertGreater(float(np.mean(whisper_rows[:, 21])), float(np.mean(base_rows[:, 21])) + 0.03)
        self.assertIn("pcm16le_base64", whisper)

        falsetto_coupled = self.svc.step({
            "session_id": "test_phon_falsetto_on",
            "pcm16le_base64": pcm_b64,
            "emit_frames": 6,
            "lookahead_frames": 3,
            "include_tract_geometry": False,
            "use_timbre_model": False,
            "synthesize_audio": False,
            "phonation_preset": "falsetto",
            "phonation_strength": 0.9,
            "phonation_f0_coupling": True,
        })
        falsetto_uncoupled = self.svc.step({
            "session_id": "test_phon_falsetto_off",
            "pcm16le_base64": pcm_b64,
            "emit_frames": 6,
            "lookahead_frames": 3,
            "include_tract_geometry": False,
            "use_timbre_model": False,
            "synthesize_audio": False,
            "phonation_preset": "falsetto",
            "phonation_strength": 0.9,
            "phonation_f0_coupling": False,
        })
        self.assertTrue(falsetto_coupled["ok"], falsetto_coupled)
        self.assertTrue(falsetto_uncoupled["ok"], falsetto_uncoupled)
        fal_on_rows = np.asarray(falsetto_coupled["m27_50hz_pa"], dtype=np.float64)
        fal_off_rows = np.asarray(falsetto_uncoupled["m27_50hz_pa"], dtype=np.float64)
        self.assertGreater(float(np.mean(fal_on_rows[:, 17])), float(np.mean(base_rows[:, 17])) + 80.0)
        self.assertAlmostEqual(float(np.mean(fal_off_rows[:, 17])), float(np.mean(base_rows[:, 17])), delta=15.0)

        creaky = self.svc.step({
            "session_id": "test_phon_creaky",
            "pcm16le_base64": pcm_b64,
            "emit_frames": 6,
            "lookahead_frames": 3,
            "include_tract_geometry": False,
            "use_timbre_model": False,
            "synthesize_audio": False,
            "phonation_preset": "creaky",
            "phonation_strength": 0.9,
            "phonation_f0_coupling": True,
            "phonation_creak_irregularity": 0.8,
        })
        self.assertTrue(creaky["ok"], creaky)
        creaky_rows = np.asarray(creaky["m27_50hz_pa"], dtype=np.float64)
        self.assertLess(float(np.mean(creaky_rows[:, 17])), float(np.mean(base_rows[:, 17])) - 40.0)
        self.assertGreater(float(np.mean(creaky_rows[:, 25])), float(np.mean(base_rows[:, 25])) + 10.0)

        raised = self.svc.step({
            "session_id": "test_phon_raised",
            "pcm16le_base64": pcm_b64,
            "emit_frames": 6,
            "lookahead_frames": 3,
            "include_tract_geometry": False,
            "use_timbre_model": False,
            "synthesize_audio": False,
            "phonation_preset": "raised_larynx",
            "phonation_strength": 1.0,
        })
        self.assertTrue(raised["ok"], raised)
        raised_rows = np.asarray(raised["m27_50hz_pa"], dtype=np.float64)
        # HY (col 1) shifts upward toward -3.5 cm
        self.assertGreater(float(np.mean(raised_rows[:, 1])), float(np.mean(base_rows[:, 1])) + 0.3)
        self.assertNotIn("torch", sys.modules, "Realtime phonation modulation must remain pure NumPy/ONNX")

    def test_08_realtime_phonation_validation_rejects_invalid_and_out_of_range(self) -> None:
        pcm_b64 = _make_speech_like_pcm16_b64(seconds=0.7, amp=0.0005)
        bad_preset = self.svc.step({
            "session_id": "test_val",
            "pcm16le_base64": pcm_b64,
            "phonation_preset": "nonexistent_voqs",
        })
        self.assertFalse(bad_preset["ok"])
        self.assertEqual(bad_preset["error"]["code"], "validation_error")

        bad_strength = self.svc.step({
            "session_id": "test_val",
            "pcm16le_base64": pcm_b64,
            "phonation_preset": "breathy",
            "phonation_strength": 1.25,
        })
        self.assertFalse(bad_strength["ok"])
        self.assertEqual(bad_strength["error"]["code"], "out_of_range")
        self.assertEqual(bad_strength["error"]["field"], "phonation_strength")

        bad_irreg = self.svc.step({
            "session_id": "test_val",
            "pcm16le_base64": pcm_b64,
            "phonation_preset": "creaky",
            "phonation_creak_irregularity": -0.2,
        })
        self.assertFalse(bad_irreg["ok"])
        self.assertEqual(bad_irreg["error"]["code"], "out_of_range")
        self.assertEqual(bad_irreg["error"]["field"], "phonation_creak_irregularity")

        bad_f0_flag = self.svc.step({
            "session_id": "test_val",
            "pcm16le_base64": pcm_b64,
            "phonation_preset": "falsetto",
            "phonation_f0_coupling": "yes",
        })
        self.assertFalse(bad_f0_flag["ok"])
        self.assertEqual(bad_f0_flag["error"]["code"], "validation_error")

    def test_09_realtime_hot_switch_speaker_and_phonation_in_same_session(self) -> None:
        ref_b64 = _make_ref_wav_b64(1.0)
        prep = self.svc.prepare_speaker({"speaker_wav_base64": ref_b64})
        self.assertTrue(prep["ok"], prep)
        spk_key = prep["speaker_key"]
        pcm_b64 = _make_speech_like_pcm16_b64(seconds=0.8, f0=170.0, amp=0.25)

        step1 = self.svc.step({
            "session_id": "test_hot_switch",
            "pcm16le_base64": pcm_b64,
            "emit_frames": 6,
            "lookahead_frames": 3,
            "include_tract_geometry": False,
            "use_timbre_model": True,
            "synthesize_audio": True,
            "speaker_mode": "lecture",
            "phonation_preset": "none",
        })
        self.assertTrue(step1["ok"], step1)
        self.assertEqual(step1["timbre_status"], "lecture-default")
        self.assertEqual(step1["phonation_preset"], "none")

        step2 = self.svc.step({
            "session_id": "test_hot_switch",
            "pcm16le_base64": pcm_b64,
            "emit_frames": 6,
            "lookahead_frames": 3,
            "include_tract_geometry": True,
            "use_timbre_model": True,
            "synthesize_audio": True,
            "speaker_mode": "reference",
            "speaker_key": spk_key,
            "phonation_preset": "breathy",
            "phonation_strength": 0.85,
        })
        self.assertTrue(step2["ok"], step2)
        self.assertEqual(step2["timbre_status"], "reference-cached")
        self.assertEqual(step2["phonation_preset"], "breathy")
        self.assertIn("pcm16le_base64", step2)
        self.assertIn("tract_glottis_anim", step2)

    def test_10_realtime_speaker_pitch_match_and_creaky_falsetto_preset(self) -> None:
        # High-pitched reference speaker (~250 Hz) vs low-pitched live input (~125 Hz)
        n = int(round(16000 * 1.0))
        t = np.arange(n, dtype=np.float32) / 16000.0
        ref_sig = 0.22 * np.sin(2.0 * np.pi * 250.0 * t) + 0.10 * np.sin(2.0 * np.pi * 500.0 * t)
        buf = io.BytesIO()
        sf.write(buf, ref_sig, 16000, format="WAV", subtype="PCM_16")
        ref_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        prep = self.svc.prepare_speaker({"speaker_wav_base64": ref_b64})
        self.assertTrue(prep["ok"], prep)
        self.assertAlmostEqual(float(prep["median_f0_hz"]), 250.0, delta=15.0)
        spk_key = prep["speaker_key"]

        low_input_b64 = _make_vowel_like_pcm16_b64(seconds=0.9, f0=125.0, amp=0.30)
        no_match = self.svc.step({
            "session_id": "test_spk_f0_off",
            "pcm16le_base64": low_input_b64,
            "emit_frames": 6,
            "lookahead_frames": 3,
            "include_tract_geometry": False,
            "use_timbre_model": True,
            "synthesize_audio": False,
            "speaker_mode": "reference",
            "speaker_key": spk_key,
            "speaker_pitch_match": False,
        })
        matched = self.svc.step({
            "session_id": "test_spk_f0_on",
            "pcm16le_base64": low_input_b64,
            "emit_frames": 6,
            "lookahead_frames": 3,
            "include_tract_geometry": False,
            "use_timbre_model": True,
            "synthesize_audio": True,
            "speaker_mode": "reference",
            "speaker_key": spk_key,
            "speaker_pitch_match": True,
        })
        self.assertTrue(no_match["ok"], no_match)
        self.assertTrue(matched["ok"], matched)
        self.assertAlmostEqual(float(no_match["speaker_f0_ratio"]), 1.0, delta=0.01)
        self.assertGreater(float(matched["speaker_f0_ratio"]), 1.5)
        self.assertAlmostEqual(float(matched["speaker_target_f0_hz"]), float(prep["median_f0_hz"]), delta=1.0)
        f0_off = float(np.mean(np.asarray(no_match["m27_50hz_pa"])[:, 17]))
        f0_on = float(np.mean(np.asarray(matched["m27_50hz_pa"])[:, 17]))
        self.assertGreater(f0_on, f0_off + 70.0)

        # Verify Voice Morph Studio creak preset (`creaky_falsetto`) works seamlessly via delegated morpher
        creaky_fal = self.svc.step({
            "session_id": "test_creaky_falsetto",
            "pcm16le_base64": low_input_b64,
            "emit_frames": 6,
            "lookahead_frames": 3,
            "include_tract_geometry": False,
            "use_timbre_model": False,
            "synthesize_audio": False,
            "speaker_pitch_match": False,
            "phonation_preset": "creaky_falsetto",
            "phonation_strength": 0.9,
        })
        self.assertTrue(creaky_fal["ok"], creaky_fal)
        self.assertEqual(creaky_fal["phonation_preset"], "creaky_falsetto")
        cf_rows = np.asarray(creaky_fal["m27_50hz_pa"], dtype=np.float64)
        # CF4 lifts low 125 Hz input up toward ~310 Hz falsetto register with controlled subharmonic-ready flutter
        self.assertGreater(float(np.mean(cf_rows[:, 17])), 230.0)
        self.assertGreater(float(np.mean(cf_rows[:, 25])), 12.0)
        self.assertNotIn("torch", sys.modules)


if __name__ == "__main__":
    unittest.main()
