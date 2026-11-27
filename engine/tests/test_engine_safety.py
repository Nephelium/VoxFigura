"""Safety, validation, concurrency, and contract regression tests for the Python engine."""
from __future__ import annotations

import base64
import math
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ENGINE = Path(__file__).resolve().parents[1]
if str(ENGINE) not in sys.path:
    sys.path.insert(0, str(ENGINE))

from dense_channel import DenseEngineManager  # noqa: E402
from m27_bridge import M27Bridge  # noqa: E402
from prosody_bridge import ProsodyBridge  # noqa: E402
from server import MAX_BODY_BYTES, PayloadTooLargeError, _LOOPBACK_ORIGIN_RE  # noqa: E402
from validation import (  # noqa: E402
    M27_MAX_PA,
    M27_MIN_PA,
    decode_base64_payload,
    validate_glottis_frames,
    validate_m27_pa,
    validate_scalar_series,
    validate_tract19_frames,
)

POSE = [0.55, -4.75, -0.1, -4.5, 0.28, 0.62, 0.5, 0.0, 0.55, -1.2, 3.65, -0.8, 2.15, 0.45, -0.75, -1.85, 0.12, 0.08, 0.05]
GLOT = [0.12, 0.12, 0.05, 1.222044, 0.0, 0.5, 0.0, 0.0]


def make_valid_m27_row() -> list[float]:
    return [*POSE[:14], *POSE[16:19], 140.0, 600.0, *GLOT]


class ValidationAndSafetyTest(unittest.TestCase):
    def test_m27_rejects_nan_bool_and_every_out_of_range_column(self) -> None:
        base_row = make_valid_m27_row()
        _, err = validate_m27_pa([base_row], f0_min=40.0)
        self.assertIsNone(err)

        bad_nan = list(base_row)
        bad_nan[10] = float("nan")
        _, err = validate_m27_pa([bad_nan])
        self.assertIsNotNone(err)
        self.assertEqual(err["error"]["code"], "out_of_range")

        bad_bool = list(base_row)
        bad_bool[17] = True  # type: ignore[assignment]
        _, err = validate_m27_pa([bad_bool])
        self.assertIsNotNone(err)
        self.assertEqual(err["error"]["code"], "out_of_range")

        # Default neural mode accepts wide positive F0 (e.g. 18 Hz, 1500 Hz) and rejects <= 0 Hz
        for wide_f0 in (18.0, 20.0, 1200.0, 1500.0):
            row = list(base_row)
            row[17] = wide_f0
            arr, err = validate_m27_pa([row])
            self.assertIsNone(err, f"wide f0={wide_f0} should pass neural validation")
            self.assertIsNotNone(arr)
            self.assertAlmostEqual(float(arr[0, 17]), wide_f0, places=3)
        for bad_f0 in (0.0, -5.0):
            row = list(base_row)
            row[17] = bad_f0
            _, err = validate_m27_pa([row])
            self.assertIsNotNone(err, f"non-positive f0={bad_f0} should fail")
            self.assertEqual(err["error"]["code"], "out_of_range")

        for col in range(27):
            low = list(base_row)
            lo = 40.0 if col == 17 else float(M27_MIN_PA[col])
            low[col] = lo - 1.0
            _, err = validate_m27_pa([low], f0_min=40.0, f0_max=600.0)
            self.assertIsNotNone(err, f"col {col} low should fail")
            self.assertEqual(err["error"]["code"], "out_of_range")
            self.assertEqual(err["error"]["allowed"]["min"], lo)

            high = list(base_row)
            hi = float(M27_MAX_PA[col])
            high[col] = hi + 1.0
            _, err = validate_m27_pa([high], f0_min=40.0, f0_max=600.0)
            self.assertIsNotNone(err, f"col {col} high should fail")
            self.assertEqual(err["error"]["code"], "out_of_range")
            self.assertEqual(err["error"]["allowed"]["max"], hi)

    def test_tract_and_glottis_and_scalar_validators_reject_out_of_range(self) -> None:
        _, err = validate_scalar_series("f0_hz", [60.0, 601.0], 2, 60.0, 600.0, "Hz")
        self.assertEqual(err["error"]["code"], "out_of_range")
        self.assertEqual(err["error"]["field"], "f0_hz[1]")

        bad_tract = list(POSE)
        bad_tract[0] = 5.0
        _, err = validate_tract19_frames([bad_tract], expected_len=1)
        self.assertEqual(err["error"]["code"], "out_of_range")

        bad_glot = list(GLOT)
        bad_glot[3] = math.inf
        _, err = validate_glottis_frames([bad_glot], expected_len=1)
        self.assertEqual(err["error"]["code"], "out_of_range")

    def test_decode_base64_payload_limits_and_data_uri(self) -> None:
        encoded = "data:audio/wav;base64," + base64.b64encode(b"RIFFdemo").decode("ascii")
        self.assertEqual(decode_base64_payload(encoded), b"RIFFdemo")
        with self.assertRaises(ValueError):
            decode_base64_payload("not!valid!base64")
        with self.assertRaises(ValueError):
            decode_base64_payload(base64.b64encode(b"0123456789").decode("ascii"), max_bytes=4)

    def test_dense_lease_resets_engine_state_on_exception(self) -> None:
        mgr = DenseEngineManager()
        with self.assertRaises(RuntimeError):
            with mgr.lease("JD2", manual_root=True, section_count=129) as eng:
                self.assertTrue(eng.manual_root)
                self.assertEqual(eng.section_count, 129)
                raise RuntimeError("boom")
        with mgr.lease("JD2") as eng2:
            self.assertFalse(eng2.manual_root)
            self.assertEqual(eng2.section_count, 65)

    def test_m27_bridge_validation_guards(self) -> None:
        bridge = M27Bridge()
        bad_hold = bridge.hold_preview({"controls": make_valid_m27_row(), "frames": 5})
        self.assertFalse(bad_hold["ok"])
        self.assertEqual(bad_hold["error"]["code"], "out_of_range")

        bad_f0_hold = make_valid_m27_row()
        bad_f0_hold[17] = 0.0
        bad_ctrl_hold = bridge.hold_preview({"controls": bad_f0_hold, "frames": 50})
        self.assertFalse(bad_ctrl_hold["ok"])
        self.assertEqual(bad_ctrl_hold["error"]["code"], "out_of_range")

        bad_anim = bridge.extract_anim_from_pa({"m27_50hz_pa": [make_valid_m27_row()], "fps": 120})
        self.assertFalse(bad_anim["ok"])
        self.assertEqual(bad_anim["error"]["code"], "out_of_range")

        bad_resynth = bridge.resynthesize({"m27_50hz_pa": [make_valid_m27_row()], "tube_hz": 75, "synth_mode": "vtl"})
        self.assertFalse(bad_resynth["ok"])
        self.assertEqual(bad_resynth["error"]["field"], "tube_hz")

    def test_prosody_bridge_lifts_sub60_knots_instead_of_failing(self) -> None:
        class FakePredictor:
            def predict_timeline(self, text, **kwargs):
                return {
                    "ok": True,
                    "model_meta": {"file": "fake.pt"},
                    "syllables": [{"id": "s1", "text": "你", "tone": "214", "candidates": []}],
                    "keyframes_neural": [{"ipa": "n", "duration_ms": 60, "f0_hz": 52.0, "role": "onset", "syl_id": "s1"}],
                    "f0_knots_neural": [{"t": 0.0, "hz": 51.4}, {"t": 0.2, "hz": 120.0}],
                }

        pb = ProsodyBridge()
        with patch.object(pb, "_get_predictor", return_value=FakePredictor()):
            out = pb.predict({"text": "你好", "f0_min_hz": 60.0})
        self.assertTrue(out["ok"])
        self.assertEqual(out["f0_adjusted_count"], 1)
        self.assertGreaterEqual(out["f0_knots"][0]["hz"], 60.0)
        self.assertGreaterEqual(out["keyframes"][0]["f0_hz"], 60.0)

    def test_wide_f0_normalization_roundtrip_without_40_600_clipping(self) -> None:
        # Pure-NumPy kf_ipa_synth contract checked directly (zero torch import)
        bridge = M27Bridge()
        bridge._ensure_tt3_imports()
        import subprocess
        import numpy as np
        from kf_ipa_synth.m27_contract import denormalize_m27 as kf_denorm, normalize_m27 as kf_norm

        test_f0s = [18.0, 20.0, 40.0, 160.0, 600.0, 1200.0, 1600.0]
        rows = np.tile(np.asarray(make_valid_m27_row(), dtype=np.float32), (len(test_f0s), 1))
        rows[:, 18] *= 10.0  # Pa -> dPa native contract
        rows[:, 17] = np.asarray(test_f0s, dtype=np.float32)

        normed = kf_norm(rows)
        self.assertLess(float(normed[0, 17]), -1.0)
        self.assertGreater(float(normed[-1, 17]), 1.0)
        restored = kf_denorm(normed)
        np.testing.assert_allclose(restored[:, 17], rows[:, 17], rtol=1e-4, atol=1e-3)

        # Also verify tt3.m27_contract and m27_voice_morph.morpher in an isolated subprocess
        # so torch is never imported into the main pure-ONNX unittest process.
        from pathlib import Path
        engine_dir = str(Path(__file__).resolve().parents[1])
        script = (
            "import sys, numpy as np\n"
            f"sys.path.insert(0, {engine_dir!r})\n"
            "from m27_bridge import M27Bridge\n"
            "M27Bridge()._ensure_tt3_imports()\n"
            "from tt3.m27_contract import normalize_m27, denormalize_m27\n"
            "from m27_voice_morph.morpher import normalize_m27_phys, denormalize_m27_norm\n"
            "base = np.array([0.5,-4.75,-0.1,-2.0,0.0,0.55,0.5,-0.1,0.0,-0.5,3.5,0.0,1.0,0.5,0.2,0.2,0.0,160.0,8000.0,0.04,0.04,0.02,1.2,0.8,0.45,15.0,5.0], dtype=np.float32)\n"
            "f0s = np.array([18.0, 20.0, 40.0, 160.0, 600.0, 1200.0, 1600.0], dtype=np.float32)\n"
            "rows = np.tile(base, (len(f0s), 1)); rows[:, 17] = f0s\n"
            "for nf, df in ((normalize_m27, denormalize_m27), (normalize_m27_phys, denormalize_m27_norm)):\n"
            "    n = nf(rows)\n"
            "    assert float(n[0, 17]) < -1.0 and float(n[-1, 17]) > 1.0\n"
            "    r = df(n)\n"
            "    np.testing.assert_allclose(r[:, 17], f0s, rtol=1e-4, atol=1e-3)\n"
        )
        proc = subprocess.run([sys.executable, "-B", "-c", script], capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_server_cors_regex_and_body_cap_constants(self) -> None:
        self.assertEqual(MAX_BODY_BYTES, 64 * 1024 * 1024)
        self.assertTrue(issubclass(PayloadTooLargeError, ValueError))
        self.assertIsNotNone(_LOOPBACK_ORIGIN_RE.fullmatch("http://127.0.0.1:5173"))
        self.assertIsNotNone(_LOOPBACK_ORIGIN_RE.fullmatch("http://localhost:5174"))
        self.assertIsNotNone(_LOOPBACK_ORIGIN_RE.fullmatch("http://[::1]:3001"))
        self.assertIsNone(_LOOPBACK_ORIGIN_RE.fullmatch("https://evil.example.com"))
        self.assertIsNone(_LOOPBACK_ORIGIN_RE.fullmatch("http://127.0.0.1.evil.com"))

    def test_narrow_japanese_ipa_symbols_in_phonetics_and_pose_bank(self) -> None:
        bridge = M27Bridge()
        bridge._ensure_tt3_imports()
        import keyframe_lite
        from kf_ipa_synth.phonetics import (
            ipa_to_phon_features_32_checked,
            ipa_to_phon_features_checked,
            validate_ipa_diacritics,
        )

        bank = keyframe_lite.default_pose_bank()
        for sym in ("ä", "ɯᵝ", "ɯᵝ̥", "ɰᵝ", "e̞", "o̞", "i̥", "kʲ", "ɡʲ", "ɾʲ", "ɰ̩̃", "ɴ̩", "t̚"):
            val = validate_ipa_diacritics(sym)
            self.assertTrue(val["valid"], f"{sym} validation failed: {val['errors']}")
            self.assertEqual(val["warnings"], [], f"{sym} unexpected warnings: {val['warnings']}")
            f22, ok22 = ipa_to_phon_features_checked(sym)
            f32, ok32 = ipa_to_phon_features_32_checked(sym)
            self.assertTrue(ok22, f"{sym} failed 22-dim feature lookup")
            self.assertTrue(ok32, f"{sym} failed 32-dim feature lookup")
            kf = bank.raw_lookup_kf26(sym, False)
            self.assertFalse(bool((abs(kf) < 1e-4).all()), f"{sym} fell back to neutral pose")

        # Verify compressed [ɯᵝ] vs devoiced [ɯᵝ̥] voicing contrast
        f_voiced, _ = ipa_to_phon_features_checked("ɯᵝ")
        f_devoiced, _ = ipa_to_phon_features_checked("ɯᵝ̥")
        self.assertGreaterEqual(float(f_voiced[1]), 0.9)
        self.assertGreaterEqual(float(f_voiced[17]), 0.9)
        self.assertGreaterEqual(float(f_devoiced[1]), 0.9)
        self.assertLess(float(f_devoiced[17]), 0.1)

    def test_vtl_pose_snapshots_batch_validation_parity_and_cache(self) -> None:
        from dense_channel import DenseEngineManager, clear_vtl_caches, get_vtl_cache_stats

        mgr = DenseEngineManager()
        schwa = [0.526, -5.179, -0.09, -4.344, 0.027, 0.952, 0.461, -0.1,
                 0.7, -1.913, 4.587, -1.305, 3.06, -0.386, -1.781, -2.448, 0.234, 0.212, 0.235]
        pose_b = list(schwa)
        pose_b[3] = -3.1
        pose_b[8] = 1.8
        pose_b[9] = -0.9

        # Out-of-range pose must be rejected rather than silently clamped
        bad_pose = list(schwa)
        bad_pose[3] = 999.0
        bad = mgr.pose_snapshots_batch({"speaker": "JD2", "poses": [bad_pose]})
        self.assertFalse(bad["ok"])
        self.assertEqual(bad["error"]["code"], "out_of_range")

        clear_vtl_caches()
        single_a = mgr.pose_snapshot({"speaker": "JD2", "params": schwa})
        self.assertTrue(single_a["ok"])

        batch = mgr.pose_snapshots_batch({"speaker": "JD2", "poses": [schwa, pose_b]})
        self.assertTrue(batch["ok"])
        self.assertEqual(len(batch["items"]), 2)
        self.assertTrue(isinstance(batch.get("frequency"), list) and len(batch["frequency"]) > 10)
        self.assertEqual(batch["items"][0]["tube_areas"], single_a["tube_areas"])
        self.assertEqual(batch["items"][0]["transfer_db"], single_a["transfer_db"])

        stats_before = get_vtl_cache_stats()["pose_snapshots"]["hits"]
        batch_cached = mgr.pose_snapshots_batch({"speaker": "JD2", "poses": [schwa, pose_b]})
        self.assertTrue(batch_cached["ok"])
        self.assertEqual(batch_cached["cache_hits"], 2)
        stats_after = get_vtl_cache_stats()["pose_snapshots"]["hits"]
        self.assertGreaterEqual(stats_after - stats_before, 2)

    def test_reference_inpaint_preserves_untouched_frames_and_coarticulates_edited_span(self) -> None:
        import numpy as np
        import keyframe_lite

        n_frames = 80  # 400 ms @ 200 Hz
        base_tract = [
            0.526, -5.179, -0.09, -4.344, 0.027, 0.952, 0.461, -0.1,
            0.7, -1.913, 4.587, -1.305, 3.06, -0.386, -1.781, -2.448, 0.234, 0.212, 0.235,
        ]
        # Distinct untouched reference pose (shifted JA/TCX) to verify verbatim preservation outside collar
        ref_tract = list(base_tract)
        ref_tract[3] = -2.8
        ref_tract[8] = 1.9
        ref_glot = [0.04, 0.04, 0.02, 1.2, 0.9, 0.5, 10.0, 0.0]

        payload = {
            "speaker": "JD2",
            "step_hz": 200,
            "sample_count": n_frames * 240,
            "synth_mode": "neural",
            "reference_inpaint": True,
            "inpaint_spans": [[30, 50]],
            "tract_frames": [ref_tract for _ in range(n_frames)],
            "f0_hz": [160.0 for _ in range(n_frames)],
            "pressure_pa": [780.0 for _ in range(n_frames)],
            "glottis_frames": [ref_glot for _ in range(n_frames)],
            "articulation_spans": [
                {"start_frame": 0, "end_frame": 30, "start_sample": 0, "end_sample": 30 * 240, "ipa": "i", "phase": "normal", "voiced": True, "locked": False, "reference_anchor": True},
                {"start_frame": 30, "end_frame": 50, "start_sample": 30 * 240, "end_sample": 50 * 240, "ipa": "s", "phase": "normal", "voiced": False, "locked": False},
                {"start_frame": 50, "end_frame": 80, "start_sample": 50 * 240, "end_sample": 80 * 240, "ipa": "i", "phase": "normal", "voiced": True, "locked": False, "reference_anchor": True},
            ],
        }
        out_payload, rows_50, meta = keyframe_lite.apply_annotation_trajectory(payload)
        self.assertEqual(meta["articulation_model"], "IPA2Tract-Lite")
        tract_out = np.asarray(out_payload["tract_frames"], dtype=np.float64)
        glot_out = np.asarray(out_payload["glottis_frames"], dtype=np.float64)
        self.assertTrue(np.isfinite(tract_out).all())
        self.assertTrue(np.isfinite(rows_50).all())

        # Untouched frames beyond 50 ms collar (0..18 and 62..79) must stay bit-close to real reference
        np.testing.assert_allclose(tract_out[:18, 3], ref_tract[3], atol=1e-4)
        np.testing.assert_allclose(tract_out[62:, 3], ref_tract[3], atol=1e-4)
        np.testing.assert_allclose(glot_out[:18, 4], ref_glot[4], atol=1e-4)

        # Edited voiceless fricative [s] at center frame 40 must drop voicing RA and move tongue tip/jaw away from reference
        self.assertLess(float(glot_out[40, 4]), 0.35)
        self.assertGreater(float(np.abs(tract_out[40, 10] - ref_tract[10]) + np.abs(tract_out[40, 11] - ref_tract[11])), 0.2)


if __name__ == "__main__":
    unittest.main()
