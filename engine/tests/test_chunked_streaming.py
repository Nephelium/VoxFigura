"""Unit tests for adaptive CPU threads, <=10s smart chunking, content-hash cache,
multi-core parallel synthesis, seamless stitching, and streaming 48 kHz playback.

Run: python -B -m unittest discover -s engine/tests
"""
from __future__ import annotations

import base64
import sys
import unittest
from pathlib import Path

import numpy as np

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from chunked_synthesis import (  # noqa: E402
    HOP_16K,
    clear_synthesis_caches,
    get_synthesis_cache_stats,
    plan_control_chunks,
    predict_ipa2tract_chunked,
    synthesize_tract2vox_chunked,
)
from m27_bridge import M27Bridge  # noqa: E402
from model_registry_runtime import (  # noqa: E402
    AUTO_THREADS_HEAVY,
    AUTO_THREADS_LIGHT,
    AUTO_THREADS_MICRO,
    LOCAL_MODEL_MANAGER,
    PARALLEL_CHUNK_WORKERS,
)


def _make_m27_dpa(n_frames: int, pause_ranges: list[tuple[int, int]] | None = None) -> np.ndarray:
    arr = np.zeros((n_frames, 27), dtype=np.float32)
    arr[:, 17] = 150.0   # F0
    arr[:, 18] = 7500.0  # PR (750 Pa = 7500 dPa)
    arr[:, 23] = 0.85    # RA
    arr[:, 22] = 1.222   # LAG
    arr[:, 24] = 0.5     # PS
    for a, b in (pause_ranges or []):
        arr[a:b, 18] = 0.0
        arr[a:b, 23] = 0.0
    return arr


class TestChunkedSynthesisAndStreaming(unittest.TestCase):
    def setUp(self) -> None:
        clear_synthesis_caches()

    def test_01_adaptive_cpu_threads_and_status_fields(self) -> None:
        self.assertEqual(AUTO_THREADS_MICRO, 1)
        self.assertTrue(2 <= AUTO_THREADS_LIGHT <= 4)
        self.assertTrue(2 <= AUTO_THREADS_HEAVY <= 8)
        self.assertGreaterEqual(PARALLEL_CHUNK_WORKERS, 1)
        status = LOCAL_MODEL_MANAGER.list_status()
        self.assertGreaterEqual(status["cpu_cores"], 1)
        self.assertEqual(status["adaptive_threads_heavy"], AUTO_THREADS_HEAVY)
        self.assertEqual(status["parallel_chunk_workers"], PARALLEL_CHUNK_WORKERS)
        by_name = {m["name"]: m for m in status["models"]}
        self.assertEqual(by_name["SwiftF0"]["threads"], 1)
        self.assertEqual(by_name["Tract2Vox-Lite"]["threads"], AUTO_THREADS_HEAVY)

    def test_02_plan_control_chunks_respects_pauses_closures_and_10s_cap(self) -> None:
        # Case A: 14s utterance with a clear 300ms silence pause at 6.0s..6.3s (frames 300..315)
        m27_paused = _make_m27_dpa(700, pause_ranges=[(300, 315)])
        chunks_a = plan_control_chunks(m27_paused, max_frames=500)
        self.assertEqual(len(chunks_a), 2)
        self.assertTrue(300 <= chunks_a[0].end_frame <= 315)
        self.assertTrue(chunks_a[0].right_is_silence)
        self.assertTrue(chunks_a[1].left_is_silence)
        self.assertEqual(chunks_a[-1].end_frame, 700)

        # Case B: 22s continuous utterance with NO pauses, but a stop closure around 8.4s (frame 420)
        m27_cont = _make_m27_dpa(1100)
        spans = [
            {"start_frame": 0, "end_frame": 1660, "phase": "normal", "ipa": "a"},
            {"start_frame": 1660, "end_frame": 1700, "phase": "closure", "ipa": "p"},
            {"start_frame": 1700, "end_frame": 4400, "phase": "normal", "ipa": "a"},
        ]
        chunks_b = plan_control_chunks(m27_cont, articulation_spans=spans, step_hz=200, max_frames=500)
        self.assertGreaterEqual(len(chunks_b), 3)
        self.assertEqual(chunks_b[0].cut_reason, "stop_closure")
        self.assertTrue(415 <= chunks_b[0].end_frame <= 425)
        for ch in chunks_b:
            self.assertLessEqual(ch.num_frames, 600)
        self.assertEqual(chunks_b[-1].end_frame, 1100)

        # Case C: Streaming mode caps first chunk <= 5s (250 frames)
        chunks_stream = plan_control_chunks(m27_cont, max_frames=500, first_chunk_max_frames=250)
        self.assertLessEqual(chunks_stream[0].num_frames, 260)

    def test_03_vocoder_content_hash_cache_incremental_edit_and_parallel(self) -> None:
        # 12s two-sentence clip (600 frames) with silence pause at frames 290..310
        n_frames = 600
        m27_dpa = _make_m27_dpa(n_frames, pause_ranges=[(290, 310)])
        m27_norm = np.zeros((1, n_frames, 27), dtype=np.float32)
        m27_norm[0, :, 18] = np.where(m27_dpa[:, 18] > 100.0, 0.0, -1.0)
        spk = np.ones((512,), dtype=np.float32) / float(np.sqrt(512.0))

        # Cold run: 2 chunks, 0 cache hits, exact length
        wav1, dev1, st1 = synthesize_tract2vox_chunked(m27_norm, spk, m27_phys_dpa=m27_dpa, allow_parallel=True)
        self.assertEqual(dev1, "cpu")
        self.assertEqual(len(wav1), n_frames * HOP_16K)
        self.assertTrue(np.isfinite(wav1).all())
        self.assertEqual(st1["total_chunks"], 2)
        self.assertEqual(st1["cache_hits"], 0)

        # Edit ONLY sentence 1 (frames 40..60); sentence 2 MUST hit cache!
        m27_norm_edited = m27_norm.copy()
        m27_norm_edited[0, 40:60, 8] = 0.35
        wav2, _, st2 = synthesize_tract2vox_chunked(m27_norm_edited, spk, m27_phys_dpa=m27_dpa, allow_parallel=True)
        self.assertEqual(len(wav2), n_frames * HOP_16K)
        self.assertEqual(st2["total_chunks"], 2)
        self.assertEqual(st2["cache_hits"], 1, f"Unchanged sentence 2 should be a cache hit: {st2}")

        # Identical repeat: 100% cache hit
        wav3, _, st3 = synthesize_tract2vox_chunked(m27_norm_edited, spk, m27_phys_dpa=m27_dpa, allow_parallel=True)
        self.assertEqual(st3["cache_hits"], 2)
        np.testing.assert_allclose(wav3, wav2)

        stats = get_synthesis_cache_stats()
        self.assertGreaterEqual(stats["vocoder"]["hits"], 3)

    def test_04_ipa2tract_chunked_overlap_and_cache(self) -> None:
        # 12s (600 frames) -> triggers chunked overlap-discard path
        n_frames = 600
        cond = np.zeros((n_frames, 111), dtype=np.float32)
        base = np.zeros((n_frames, 26), dtype=np.float32)
        base[:, 17] = 0.2  # non-zero PR
        base[295:315, 17] = -1.0  # silence pause around 6s
        out1 = predict_ipa2tract_chunked(cond, base, alpha=1.0)
        self.assertEqual(out1.shape, (n_frames, 26))
        self.assertTrue(np.isfinite(out1).all())

        # Second call hits IPA chunk cache identically
        out2 = predict_ipa2tract_chunked(cond, base, alpha=1.0)
        np.testing.assert_allclose(out2, out1)
        self.assertGreaterEqual(get_synthesis_cache_stats()["ipa2tract"]["hits"], 2)

    def test_05_streaming_48k_first_chunk_and_exact_assembly(self) -> None:
        bridge = M27Bridge()
        # 8.0s @ 50 Hz = 400 frames with pause at 4.0s..4.2s -> streams as 2 chunks
        n = 400
        pose = [0.55, -4.75, -0.1, -4.5, 0.28, 0.62, 0.5, 0.0, 0.55, -1.2, 3.65, -0.8, 2.15, 0.45, -0.75, -1.85, 0.12, 0.08, 0.05]
        glot = [0.08, 0.08, 0.03, 1.222044, 0.85, 0.5, 0.0, 0.0]
        pr = [700.0] * n
        for k in range(195, 210):
            pr[k] = 0.0
        payload = {
            "speaker": "JD2",
            "step_hz": 50,
            "f0_hz": [150.0] * n,
            "pressure_pa": pr,
            "tract_frames": [pose[:] for _ in range(n)],
            "glottis_frames": [glot[:] for _ in range(n)],
            "sample_count": n * 960,
            "device": "cpu",
        }
        events = list(bridge.synthesize_dense_neural_stream(payload))
        self.assertGreaterEqual(len(events), 4)  # meta + >=2 chunks + done
        self.assertEqual(events[0]["type"], "meta")
        self.assertEqual(events[-1]["type"], "done")
        chunks = [e for e in events if e["type"] == "chunk"]
        self.assertGreaterEqual(len(chunks), 2)
        self.assertEqual(chunks[0]["index"], 0)
        self.assertEqual(chunks[0]["start_sample"], 0)

        # Verify assembled PCM covers exact total_samples with finite samples
        total_smp = events[0]["total_samples"]
        self.assertEqual(total_smp, n * 960)
        assembled = np.zeros(total_smp, dtype=np.float32)
        for ch in chunks:
            raw = base64.b64decode(ch["pcm_i16_b64"])
            floats = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
            self.assertEqual(len(floats), ch["sample_count"])
            s = ch["start_sample"]
            assembled[s : s + len(floats)] = floats
        self.assertTrue(np.isfinite(assembled).all())
        self.assertNotIn("torch", sys.modules, "Streaming pure-ONNX synthesis must never import torch")


if __name__ == "__main__":
    unittest.main()
