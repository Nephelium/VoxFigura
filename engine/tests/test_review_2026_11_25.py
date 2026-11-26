from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import unittest

import numpy as np

ENGINE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = ENGINE_DIR.parent
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from dense_channel import DenseEngineManager, resample_tract_frames_to_50hz  # noqa: E402
from model_registry_runtime import LOCAL_MODEL_MANAGER  # noqa: E402
import onnx_inference as oi  # noqa: E402


class Review20261125Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.mgr = DenseEngineManager()

    def test_s2_control_track_50hz_exact_length_and_omitted_step_hz(self) -> None:
        pose_a = [0.55, -4.75, -0.1, -4.5, -0.40, 0.62, 0.5, 0.0, 0.55, -1.2, 3.65, -0.8, 2.15, 0.45, -0.75, -1.85, 0.12, 0.08, 0.05]
        pose_b = [0.55, -4.75, -0.1, -4.5, +0.40, 0.62, 0.5, 0.0, 0.55, -1.2, 3.65, -0.8, 2.15, 0.45, -0.75, -1.85, 0.12, 0.08, 0.05]

        # Test explicit 25 Hz, 125 Hz, 200 Hz, and omitted step_hz (default 200 Hz)
        for step_hz in (25, 125, 200, None):
            eff_hz = 200 if step_hz is None else step_hz
            half = eff_hz // 2
            frames = [pose_a[:] for _ in range(half)] + [pose_b[:] for _ in range(eff_hz - half)]
            payload = {
                "speaker": "JD2",
                "f0_hz": [165.0] * eff_hz,
                "pressure_pa": [650.0] * eff_hz,
                "tract_frames": frames,
                "include_geometry": False,
                "return_control_track": True,
            }
            if step_hz is not None:
                payload["step_hz"] = step_hz

            res = self.mgr.synthesize_dense(payload)
            self.assertTrue(res.get("ok"), msg=f"step_hz={step_hz} failed: {res}")
            self.assertAlmostEqual(float(res["duration_s"]), 1.0, places=4)
            track50 = res.get("tract_control_50hz")
            self.assertIsInstance(track50, list)
            self.assertEqual(len(track50), 50, msg=f"step_hz={step_hz} expected 50 frames, got {len(track50)}")
            # Step transition around t = 0.50 s must stay negative well before 0.50 s and positive after 0.50 s
            self.assertLess(track50[10][4], -0.35)
            self.assertGreater(track50[40][4], 0.35)

            # Stream route must produce identical 50-frame track
            stream_events = list(self.mgr.synthesize_dense_stream(payload))
            self.assertEqual(stream_events[0]["type"], "meta")
            self.assertEqual(len(stream_events[0]["tract_control_50hz"]), 50)

        # Direct transition-midpoint check on 200 Hz -> 50 Hz
        frames_200 = np.asarray([pose_a[:] for _ in range(100)] + [pose_b[:] for _ in range(100)], dtype=np.float64)
        resampled = resample_tract_frames_to_50hz(frames_200, 200, 48000)
        self.assertEqual(len(resampled), 50)
        self.assertAlmostEqual(resampled[24][4], -0.40, places=5)
        self.assertAlmostEqual(resampled[25][4], +0.40, places=5)

    def test_s5_batch_contours_respects_lip_width_and_extras(self) -> None:
        eng, _ = self.mgr.get_engine("JD2")
        neutral = eng.neutral.tolist()

        res_default = self.mgr.batch_contours({"speaker": "JD2", "poses": [neutral]})
        res_wide_lip = self.mgr.batch_contours({
            "speaker": "JD2",
            "poses": [neutral],
            "lip_width_frames": [1.3],
        })
        self.assertTrue(res_default.get("ok"))
        self.assertTrue(res_wide_lip.get("ok"))
        item_a = res_default["items"][0]
        item_b = res_wide_lip["items"][0]
        # Lip width 1.0 -> 1.3 measurably raises JD2 F1 and F2 and matches reference_formants
        self.assertGreater(item_b["f1_hz"], item_a["f1_hz"] + 5.0)
        self.assertGreater(item_b["f2_hz"], item_a["f2_hz"] + 5.0)

        ref_peaks, _ = eng.reference_formants(neutral, 1.3, 0.0, None, None)
        self.assertIsNotNone(ref_peaks)
        self.assertAlmostEqual(item_b["f1_hz"], round(float(ref_peaks[0]), 1), places=1)
        self.assertAlmostEqual(item_b["f2_hz"], round(float(ref_peaks[1]), 1), places=1)

        # Out-of-range lip_width must be rejected without silent clamping
        bad = self.mgr.batch_contours({"speaker": "JD2", "poses": [neutral], "lip_width_frames": [2.5]})
        self.assertFalse(bad.get("ok"))
        self.assertEqual(bad["error"]["code"], "out_of_range")

    def test_s8_mandarin_blind_decode_neutral_tone_de_me_uses_schwa(self) -> None:
        oi.ensure_pure_numpy_imports()
        from tt3.mandarin_unt_ipa import ZH_ID_TO_SYL, ZH_SYL_BLANK_ID

        n_f = 24
        vocab_n = len(oi.ALIGN_VOCAB_V2)
        syl_n = max(ZH_ID_TO_SYL.keys()) + 2
        de_id = next(k for k, v in ZH_ID_TO_SYL.items() if v == "de")
        me_id = next(k for k, v in ZH_ID_TO_SYL.items() if v == "me")

        syl_lp = np.full((n_f, syl_n), -8.0, dtype=np.float32)
        syl_lp[:, ZH_SYL_BLANK_ID] = 2.0
        syl_lp[4, :] = -8.0
        syl_lp[4, de_id] = 6.0
        syl_lp[14, :] = -8.0
        syl_lp[14, me_id] = 6.0

        t_id = oi.ALIGN_V2_IPA_TO_ID["t"]
        m_id = oi.ALIGN_V2_IPA_TO_ID["m"]
        schwa_id = oi.ALIGN_V2_IPA_TO_ID["ə"]
        mid_back_id = oi.ALIGN_V2_IPA_TO_ID["ɤ"]

        frame_raw = np.full((n_f, vocab_n), -6.0, dtype=np.float32)
        frame_raw[2:6, t_id] = 5.0
        frame_raw[6:12, schwa_id] = 5.0
        frame_raw[6:12, mid_back_id] = 1.0
        frame_raw[12:16, m_id] = 5.0
        frame_raw[16:22, schwa_id] = 5.0
        frame_raw[16:22, mid_back_id] = 1.0
        frame_lp = oi._log_softmax(frame_raw, axis=-1)
        ctc_lp = frame_lp.copy()

        bnd_p = np.full((n_f,), 0.05, dtype=np.float32)
        sp_p = np.full((n_f,), 0.98, dtype=np.float32)
        # First test: even if initial CTC frame has tone 1, refined alignment span has neutral tone (index 5 -> tone_id 5)
        tone_p = np.full((n_f, 8), 0.01, dtype=np.float32)
        tone_p[4, 1] = 0.90  # Force Pass 1 init_tones to pick tone=1 ([ɤ]), triggering Pass 2 re-alignment to tone=5 ([ə])!
        tone_p[0:4, 5] = 0.92
        tone_p[5:24, 5] = 0.92

        syls, phs, _ = oi._decode_mandarin_blind_island(
            syl_lp, frame_lp, ctc_lp, bnd_p, sp_p, tone_p, ia=0, ib=n_f, n_f=n_f
        )
        self.assertEqual([s["sub_label"] for s in syls], ["de5", "me5"])
        self.assertEqual([s["tone_id"] for s in syls], [5, 5])
        self.assertEqual([p["ipa"] for p in phs], ["t", "ə", "m", "ə"])

    def test_s9_s10_tract2area_spec_and_export_cli_flags(self) -> None:
        status = LOCAL_MODEL_MANAGER.list_status()
        area = next(item for item in status["models"] if item["name"] == "Tract2Area-Proxy")
        self.assertIn("6 维", area["role"])
        self.assertNotIn("65 截面", area["role"])

        proc = subprocess.run(
            [sys.executable, "-B", str(REPO_ROOT / "scripts" / "export_onnx_models.py"), "--help"],
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertIn("--mode {benchmark,finalize}", proc.stdout)


if __name__ == "__main__":
    unittest.main()
