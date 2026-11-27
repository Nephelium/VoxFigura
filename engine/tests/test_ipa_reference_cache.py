"""Regression tests for IPA reference library playback_index caching and isolation."""

import json
from pathlib import Path
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ipa_materials as im
import ipa_reference_library as rl
import vowel_response as vr


class IpaReferenceCacheTest(unittest.TestCase):
    def test_playback_index_caches_and_returns_isolated_copies(self):
        rl._clear_playback_index_cache()
        first = rl.playback_index()
        self.assertGreater(len(first), 200)
        self.assertTrue(any(item.get("id") == "main-T221" and item.get("exists") for item in first))

        # Mutating caller result must not corrupt cached snapshot
        first[0]["title"] = "MUTATED_BY_CALLER"

        t0 = time.perf_counter()
        second = rl.playback_index()
        cached_ms = (time.perf_counter() - t0) * 1000.0

        self.assertEqual(len(second), len(first))
        self.assertNotEqual(second[0].get("title"), "MUTATED_BY_CALLER")
        self.assertLess(cached_ms, 200.0)

    def test_measure_vowel_track_matches_core_and_caches(self):
        entry = next(item for item in rl.index() if item.get("id") == "main-T248")
        _, _, anim_bytes, _ = im.prepare_materials(entry, rl.LIBRARY, rl.recording_path(entry), audio_gain="original")
        rows = json.loads(anim_bytes)["m27_50hz_pa"]

        first = vr.measure_vowel_track("JD2", rows, symbol="ɒ")
        self.assertEqual(first["speaker"], "JD2")
        self.assertEqual(first["section_count"], 65)
        self.assertEqual(first["fps"], 50)
        self.assertEqual(len(first["frames"]), len(rows))
        # Steady midpoint matches reconstructed vowel-transfer-jd2-65.json (480.5 / 773.4 / 2871.1 Hz)
        mid = first["frames"][len(rows) // 2]
        self.assertIsNotNone(mid)
        self.assertAlmostEqual(mid["f1"], 480.5, delta=1.5)
        self.assertAlmostEqual(mid["f2"], 773.4, delta=1.5)
        # Tail frame matches VTL dynamic offset (492.2 / 808.6 / 2871.1 Hz)
        tail = first["frames"][-1]
        self.assertIsNotNone(tail)
        self.assertAlmostEqual(tail["f1"], 492.2, delta=1.5)
        self.assertAlmostEqual(tail["f2"], 808.6, delta=1.5)

        t0 = time.perf_counter()
        second = vr.measure_vowel_track("JD2", rows, symbol="ɒ")
        self.assertLess((time.perf_counter() - t0) * 1000.0, 50.0)
        self.assertEqual(second["frames"][0], first["frames"][0])

        with self.assertRaises(ValueError):
            vr.measure_vowel_track("UNKNOWN_SPK", rows, symbol="ɒ")
        with self.assertRaises(ValueError):
            vr.measure_vowel_track("JD2", [], symbol="ɒ")


if __name__ == "__main__":
    unittest.main()
