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

        for col in range(27):
            low = list(base_row)
            lo = 60.0 if col == 17 else float(M27_MIN_PA[col])
            low[col] = lo - 1.0
            _, err = validate_m27_pa([low], f0_min=60.0)
            self.assertIsNotNone(err, f"col {col} low should fail")
            self.assertEqual(err["error"]["code"], "out_of_range")
            self.assertEqual(err["error"]["allowed"]["min"], lo)

            high = list(base_row)
            hi = float(M27_MAX_PA[col])
            high[col] = hi + 1.0
            _, err = validate_m27_pa([high], f0_min=60.0)
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
        bad_f0_hold[17] = 20.0
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

    def test_server_cors_regex_and_body_cap_constants(self) -> None:
        self.assertEqual(MAX_BODY_BYTES, 64 * 1024 * 1024)
        self.assertTrue(issubclass(PayloadTooLargeError, ValueError))
        self.assertIsNotNone(_LOOPBACK_ORIGIN_RE.fullmatch("http://127.0.0.1:5173"))
        self.assertIsNotNone(_LOOPBACK_ORIGIN_RE.fullmatch("http://localhost:5174"))
        self.assertIsNotNone(_LOOPBACK_ORIGIN_RE.fullmatch("http://[::1]:3001"))
        self.assertIsNone(_LOOPBACK_ORIGIN_RE.fullmatch("https://evil.example.com"))
        self.assertIsNone(_LOOPBACK_ORIGIN_RE.fullmatch("http://127.0.0.1.evil.com"))


if __name__ == "__main__":
    unittest.main()
