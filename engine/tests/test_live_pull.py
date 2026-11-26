"""Unit tests for stateful VTL 2.4 live_pull continuous tube synthesis & strict range validation."""
from __future__ import annotations

import base64
from pathlib import Path
import sys
import unittest

import numpy as np

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from dense_channel import DenseEngineManager  # noqa: E402


class TestVtlLivePull(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manager = DenseEngineManager()
        meta = cls.manager.metadata("JD2")
        cls.neutral_params = [float(p["neutral"]) for p in meta["parameters"]]

    def test_live_pull_generates_continuous_finite_48khz_blocks(self) -> None:
        first = self.manager.live_pull(
            {
                "speaker": "JD2",
                "reset": True,
                "blocks": 3,
                "params": self.neutral_params,
                "f0_hz": 168.0,
                "pressure_pa": 780.0,
            }
        )
        self.assertTrue(first.get("ok"))
        self.assertEqual(first["sample_rate_hz"], 48000)
        self.assertEqual(first["samples"], 3 * 960)
        pcm1 = np.frombuffer(base64.b64decode(first["pcm_f32_b64"]), dtype="<f4")
        self.assertEqual(len(pcm1), 2880)
        self.assertTrue(np.isfinite(pcm1).all())
        self.assertGreater(float(np.max(np.abs(pcm1))), 0.02)

        # Follow-up block without reset continues smoothly across block boundary
        second = self.manager.live_pull(
            {
                "speaker": "JD2",
                "reset": False,
                "blocks": 2,
                "params": self.neutral_params,
                "f0_hz": 168.0,
                "pressure_pa": 780.0,
            }
        )
        self.assertTrue(second.get("ok"))
        pcm2 = np.frombuffer(base64.b64decode(second["pcm_f32_b64"]), dtype="<f4")
        self.assertEqual(len(pcm2), 1920)
        self.assertTrue(np.isfinite(pcm2).all())
        # Boundary sample jump should remain smooth (no full-scale step click)
        boundary_jump = abs(float(pcm2[0]) - float(pcm1[-1]))
        self.assertLess(boundary_jump, 0.35)

    def test_live_pull_rejects_out_of_range_without_silent_clamping(self) -> None:
        bad_f0 = self.manager.live_pull(
            {
                "speaker": "JD2",
                "params": self.neutral_params,
                "f0_hz": 45.0,
                "pressure_pa": 800.0,
            }
        )
        self.assertFalse(bad_f0.get("ok"))
        self.assertEqual(bad_f0["error"]["code"], "out_of_range")

        bad_pr = self.manager.live_pull(
            {
                "speaker": "JD2",
                "params": self.neutral_params,
                "f0_hz": 160.0,
                "pressure_pa": 1850.0,
            }
        )
        self.assertFalse(bad_pr.get("ok"))
        self.assertEqual(bad_pr["error"]["code"], "out_of_range")


if __name__ == "__main__":
    unittest.main()
