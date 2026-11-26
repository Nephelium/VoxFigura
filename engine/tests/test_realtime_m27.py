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
        spk_key = prep1["speaker_key"]

        # Second call hits in-memory speaker cache (0 ms)
        prep2 = self.svc.prepare_speaker({"speaker_wav_base64": ref_b64})
        self.assertTrue(prep2["ok"])
        self.assertTrue(prep2["cached"])
        self.assertEqual(prep2["speaker_key"], spk_key)

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


if __name__ == "__main__":
    unittest.main()
