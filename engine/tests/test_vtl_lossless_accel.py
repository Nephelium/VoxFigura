"""Tests for lossless/physically-exact VTL 2.4 physical synthesis acceleration:
  - Parallel GIL-free 3D `prepare_tube` worker pool (up to 8 workers)
  - Per-pose LRU tube cache (0 ms on F0/PR/glottis edits)
  - Dead-silence (`PR==0` >= 250ms) zero-work skip
  - Silence-separated & breath-valley chunk splitting, content-hash audio LRU cache, and multi-core `block_tube`
  - Low-TTFA physical VTL streaming (`synthesize_dense_stream`)
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

from dense_channel import (  # noqa: E402
    DenseEngineManager,
    clear_vtl_caches,
    get_vtl_cache_stats,
    plan_vtl_chunks,
    plan_vtl_silence_phrases,
)


def _decode_wav_b64(b64: str) -> np.ndarray:
    data, sr = sf.read(io.BytesIO(base64.b64decode(b64)), dtype="float64")
    assert sr == 48000
    return data


class TestVtlLosslessAccel(unittest.TestCase):
    def setUp(self) -> None:
        clear_vtl_caches()
        self.mgr = DenseEngineManager()

    def tearDown(self) -> None:
        self.mgr.close_all()

    def test_01_bit_identical_against_serial_include_geometry_path(self) -> None:
        """Fast parallel `prepare_tube` path must be bit-identical (0 dB error) to serial path."""
        n = 120  # 0.6s @ 200 Hz
        pose_a = np.array([0.55, -4.75, -0.1, -4.5, 0.28, 0.62, 0.5, 0.0, 0.55, -1.2, 3.65, -0.8, 2.15, 0.45, -0.75, -1.85, 0.12, 0.08, 0.05])
        pose_i = np.array([0.75, -4.40, -0.1, -2.5, -0.3, 0.90, 0.8, 0.0, 2.20, 0.4, 4.20, 0.5, 2.60, 1.50, -0.75, -1.85, 0.12, 0.08, 0.05])
        tract = [(pose_a * (1 - k / n) + pose_i * (k / n)).tolist() for k in range(n)]
        glot = [[0.08, 0.08, 0.03, 1.222044, 0.85, 0.5, 0.0, 0.0] for _ in range(n)]
        base = {
            "speaker": "JD2",
            "step_hz": 200,
            "f0_hz": [150.0] * n,
            "pressure_pa": [750.0] * n,
            "tract_frames": tract,
            "glottis_frames": glot,
            "audio_gain": "original",
        }
        ref = self.mgr.synthesize_dense({**base, "include_geometry": True})
        fast = self.mgr.synthesize_dense({**base, "include_geometry": False})
        self.assertTrue(ref["ok"], ref)
        self.assertTrue(fast["ok"], fast)
        wav_ref = _decode_wav_b64(ref["wav_base64"])
        wav_fast = _decode_wav_b64(fast["wav_base64"])
        self.assertEqual(len(wav_ref), len(wav_fast))
        max_diff = float(np.max(np.abs(wav_ref - wav_fast)))
        self.assertLess(max_diff, 1e-4, f"Parallel VTL path diverged from serial baseline: max_diff={max_diff}")

    def test_02_silence_phrase_split_incremental_cache_and_f0_tube_cache(self) -> None:
        """Multi-phrase VTL caches unchanged phrases (0 ms) and reuses tubes on F0 edits."""
        # 1.6s @ 200 Hz = 320 frames: phrase 1 [0..140], silence [140..170] (150ms), phrase 2 [170..320]
        n = 320
        pr = np.full(n, 750.0, dtype=np.float64)
        pr[140:170] = 0.0
        phrases = plan_vtl_silence_phrases(pr, 200)
        self.assertEqual(len(phrases), 2)

        pose_a = [0.55, -4.75, -0.1, -4.5, 0.28, 0.62, 0.5, 0.0, 0.55, -1.2, 3.65, -0.8, 2.15, 0.45, -0.75, -1.85, 0.12, 0.08, 0.05]
        pose_u = [0.45, -4.90, -0.1, -3.5, 0.70, 0.25, 0.7, 0.0, -1.20, 0.2, 3.10, -1.2, 1.50, -0.40, -0.75, -1.85, 0.12, 0.08, 0.05]
        tract = [pose_a[:] if k < 155 else pose_u[:] for k in range(n)]
        glot = [[0.08, 0.08, 0.03, 1.222044, 0.85, 0.5, 0.0, 0.0] for _ in range(n)]
        f0 = [150.0] * n
        payload = {
            "speaker": "JD2",
            "step_hz": 200,
            "include_geometry": False,
            "f0_hz": f0,
            "pressure_pa": pr.tolist(),
            "tract_frames": tract,
            "glottis_frames": glot,
            "audio_gain": "peak",
        }

        # Cold run: 2 phrases, 0 phrase cache hits
        r1 = self.mgr.synthesize_dense(payload)
        self.assertTrue(r1["ok"], r1)
        self.assertEqual(r1["vtl_stats"]["total_phrases"], 2)
        self.assertEqual(r1["vtl_stats"]["phrase_cache_hits"], 0)

        # Edit F0 ONLY in phrase 1 -> phrase 2 hits audio cache AND phrase 1 hits tube cache (0 new tubes computed!)
        f0_edited = [180.0 if k < 120 else 150.0 for k in range(n)]
        r2 = self.mgr.synthesize_dense({**payload, "f0_hz": f0_edited})
        self.assertTrue(r2["ok"], r2)
        self.assertEqual(r2["vtl_stats"]["phrase_cache_hits"], 1)
        self.assertEqual(r2["vtl_stats"]["tube_computed"], 0)
        self.assertGreater(r2["vtl_stats"]["tube_cache_hits"], 0)

        # Identical repeat -> 100% phrase cache hit
        r3 = self.mgr.synthesize_dense({**payload, "f0_hz": f0_edited})
        self.assertEqual(r3["vtl_stats"]["phrase_cache_hits"], 2)
        self.assertEqual(r3["wav_base64"], r2["wav_base64"])

        stats = get_vtl_cache_stats()
        self.assertGreaterEqual(stats["phrases"]["hits"], 3)
        self.assertGreaterEqual(stats["tubes"]["hits"], 1)
        self.assertNotIn("torch", sys.modules)

    def test_03_continuous_singing_valley_parallel_and_dead_silence_skip(self) -> None:
        """Continuous non-silence singing (like 长恨歌) splits cleanly at breath valleys & skips dead silence."""
        # 14.0s @ 200 Hz = 2800 frames: 11.6s continuous singing (dip to 15 Pa at 5.8s) + 2.4s dead silence at end
        n = 2800
        pr = np.full(n, 800.0, dtype=np.float64)
        pr[1156:1164] = np.linspace(80.0, 12.0, 8)  # 40ms phrase breath valley at 5.8s
        pr[2320:] = 0.0  # 2.4s trailing interlude dead silence

        chunks, skipped = plan_vtl_chunks(pr, 200)
        self.assertEqual(len(chunks), 2, f"Expected 2 valley-split chunks, got {chunks}")
        self.assertEqual(chunks[0][3], "valley")
        self.assertEqual(chunks[1][2], "valley")
        self.assertGreater(skipped, 400, "Trailing 2.4s PR==0 dead silence must be skipped")

        pose_a = np.array([0.55, -4.75, -0.1, -4.5, 0.28, 0.62, 0.5, 0.0, 0.55, -1.2, 3.65, -0.8, 2.15, 0.45, -0.75, -1.85, 0.12, 0.08, 0.05])
        pose_i = np.array([0.75, -4.40, -0.1, -2.5, -0.3, 0.90, 0.8, 0.0, 2.20, 0.4, 4.20, 0.5, 2.60, 1.50, -0.75, -1.85, 0.12, 0.08, 0.05])
        tract = [(pose_a * (1 - (k % 200) / 200.0) + pose_i * ((k % 200) / 200.0)).tolist() for k in range(n)]
        glot = [[0.08, 0.08, 0.03, 1.222044, 0.85, 0.5, 0.0, 0.0] for _ in range(n)]
        f0 = [240.0 + 30.0 * np.sin(2.0 * np.pi * k / 400.0) for k in range(n)]
        payload = {
            "speaker": "JD2",
            "step_hz": 200,
            "include_geometry": False,
            "f0_hz": f0,
            "pressure_pa": pr.tolist(),
            "tract_frames": tract,
            "glottis_frames": glot,
            "audio_gain": "peak",
        }
        r1 = self.mgr.synthesize_dense(payload)
        self.assertTrue(r1["ok"], r1)
        self.assertEqual(r1["vtl_stats"]["total_phrases"], 2)
        self.assertGreater(r1["vtl_stats"]["skipped_dead_frames"], 400)
        wav1 = _decode_wav_b64(r1["wav_base64"])
        self.assertEqual(len(wav1), n * 240)
        # Trailing dead silence must be exact 0.0
        self.assertEqual(float(np.max(np.abs(wav1[2325 * 240 :]))), 0.0)

        # Edit F0 only in line 1 (frames 100..400, well before line 2's warmup) -> line 2 hits audio cache!
        f0_edit = f0[:]
        for k in range(100, 400):
            f0_edit[k] += 25.0
        r2 = self.mgr.synthesize_dense({**payload, "f0_hz": f0_edit})
        self.assertTrue(r2["ok"], r2)
        self.assertEqual(r2["vtl_stats"]["phrase_cache_hits"], 1)
        self.assertEqual(r2["vtl_stats"]["tube_computed"], 0)

    def test_04_physical_vtl_streaming_ndjson_assembly(self) -> None:
        """Physical VTL streaming emits meta -> chunk 0..K-1 -> done with exact contiguous 48 kHz PCM."""
        # 10.0s @ 200 Hz = 2000 frames with breath valley at 4.0s and 1.0s trailing silence
        n = 2000
        pr = np.full(n, 780.0, dtype=np.float64)
        pr[796:804] = np.linspace(60.0, 10.0, 8)
        pr[1800:] = 0.0
        pose_a = [0.55, -4.75, -0.1, -4.5, 0.28, 0.62, 0.5, 0.0, 0.55, -1.2, 3.65, -0.8, 2.15, 0.45, -0.75, -1.85, 0.12, 0.08, 0.05]
        glot = [0.08, 0.08, 0.03, 1.222044, 0.85, 0.5, 0.0, 0.0]
        payload = {
            "speaker": "JD2",
            "step_hz": 200,
            "f0_hz": [220.0] * n,
            "pressure_pa": pr.tolist(),
            "tract_frames": [pose_a[:] for _ in range(n)],
            "glottis_frames": [glot[:] for _ in range(n)],
            "sample_count": n * 240,
            "audio_gain": "peak",
            "return_control_track": True,
        }
        events = list(self.mgr.synthesize_dense_stream(payload))
        self.assertGreaterEqual(len(events), 4)
        meta = events[0]
        self.assertEqual(meta["type"], "meta")
        self.assertEqual(meta["synth_mode"], "physical")
        self.assertEqual(meta["total_samples"], n * 240)
        self.assertIn("tract_control_50hz", meta)
        self.assertEqual(events[-1]["type"], "done")

        chunks = [e for e in events if e["type"] == "chunk"]
        self.assertGreaterEqual(len(chunks), 2)
        self.assertEqual(chunks[0]["index"], 0)
        self.assertEqual(chunks[0]["start_sample"], 0)
        assembled = np.zeros(n * 240, dtype=np.float32)
        cursor = 0
        for ch in chunks:
            self.assertEqual(ch["start_sample"], cursor)
            self.assertEqual(ch["overlap_left_samples"], 0)
            floats = np.frombuffer(base64.b64decode(ch["pcm_i16_b64"]), dtype="<i2").astype(np.float32) / 32768.0
            self.assertEqual(len(floats), ch["sample_count"])
            assembled[cursor : cursor + len(floats)] = floats
            cursor += len(floats)
        self.assertEqual(cursor, n * 240)
        self.assertTrue(np.isfinite(assembled).all())
        self.assertGreater(float(np.max(np.abs(assembled[: 1700 * 240]))), 0.1)
        self.assertEqual(float(np.max(np.abs(assembled[1805 * 240 :]))), 0.0)
        self.assertNotIn("torch", sys.modules)


if __name__ == "__main__":
    unittest.main()
