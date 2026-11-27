"""Tract2Vox-Lite geometry-extras guard.

Run: python -B -m unittest discover -s engine/tests   (engine interpreter; numpy only, no model loading)
"""
import sys
import unittest
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE))

from m27_bridge import M27Bridge, stage5_geometry_extras  # noqa: E402

N = 20
POSE = [0.55, -4.75, -0.1, -4.5, 0.28, 0.62, 0.5, 0.0, 0.55, -1.2, 3.65, -0.8, 2.15, 0.45, -0.75, -1.85, 0.12, 0.08, 0.05]
GLOT = [0.12, 0.12, 0.05, 1.222044, 0.0, 0.5, 0.0, 0.0]


def payload(**over):
    p = {"speaker": "JD2", "step_hz": 200, "f0_hz": [140.0] * N, "pressure_pa": [600.0] * N,
         "tract_frames": [POSE[:] for _ in range(N)], "glottis_frames": [GLOT[:] for _ in range(N)],
         "lip_width_frames": [1.0] * N, "larynx_height_frames": [0.0] * N,
         "tongue_shape_frames": [[0, 0, 0, 0] for _ in range(N)], "lip_shape_frames": [[0, 0, 0, 0] for _ in range(N)],
         "manual_root_frames": [False] * N, "sample_count": N * 240}
    p.update(over)
    return p


class GeometryExtrasTest(unittest.TestCase):
    def test_defaults_have_no_extras(self):
        self.assertEqual(stage5_geometry_extras(payload()), [])

    def test_reports_field_and_first_frame(self):
        lip = [1.0] * N
        lip[7] = 0.9
        tongue = [[0, 0, 0, 0] for _ in range(N)]
        tongue[3] = [0.5, 0.01, -0.5, -0.17]
        found = stage5_geometry_extras(payload(lip_width_frames=lip, tongue_shape_frames=tongue, manual_root=True))
        self.assertIn({"field": "lip_width_frames", "frame": 7}, found)
        self.assertIn({"field": "tongue_shape_frames", "frame": 3}, found)
        self.assertIn({"field": "manual_root", "frame": None}, found)

    def test_direct_path_rejects_with_named_field(self):
        tongue = [[0, 0, 0, 0] for _ in range(N)]
        tongue[5] = [0.3, 0, 0, 0]
        res = M27Bridge().synthesize_dense_neural(payload(tongue_shape_frames=tongue))
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"]["code"], "unsupported_geometry")
        self.assertEqual(res["error"]["field"], "tongue_shape_frames")
        self.assertIn("第 5 帧", res["error"]["hint"])

    def test_out_of_range_still_rejected_before_geometry(self):
        res = M27Bridge().synthesize_dense_neural(payload(f0_hz=[0.0] * N, lip_width_frames=[0.9] * N))
        self.assertEqual(res["error"]["code"], "out_of_range")
        res = M27Bridge().synthesize_dense_neural(payload(pressure_pa=[1700.0] * N))
        self.assertEqual(res["error"]["code"], "out_of_range")


if __name__ == "__main__":
    unittest.main()
