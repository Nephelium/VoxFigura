"""Regression tests for T-20, T-21, T-22, T-24, T-25, T-27, and T-38 backend features."""
from __future__ import annotations

import base64
import io
import json
from pathlib import Path
import sys
import unicodedata
import unittest
from unittest.mock import patch

import numpy as np
import soundfile as sf

ENGINE = Path(__file__).resolve().parents[1]
VTL_PKG = ENGINE / "vtl_native"
BUNDLE_PKG = ENGINE / "model_bundle" / "packages" / "kf_ipa_synth"
for p in (str(ENGINE), str(VTL_PKG), str(BUNDLE_PKG)):
    if p not in sys.path:
        sys.path.insert(0, p)

from dense_channel import DenseEngineManager  # noqa: E402
import ipa_reference_library  # noqa: E402
import keyframe_lite  # noqa: E402
from kf_ipa_synth.phonetics import (  # noqa: E402
    KF26_INDEX,
    apply_diacritics_to_phys27,
    default_organ_mask,
    validate_ipa_diacritics,
)
from kf_ipa_synth.pose_bank import PoseBank  # noqa: E402
from m27_bridge import M27Bridge  # noqa: E402
from server import scan_local_models  # noqa: E402
from trills import (  # noqa: E402
    GESTURES,
    apply_trill,
    apply_trill_to_m27,
    apply_trill_to_tract19,
    resolve_trill_place,
)
from validation import validate_pose_target_or_delta  # noqa: E402
import vowel_response  # noqa: E402


class BackendEnhancementsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.mgr = DenseEngineManager()
        cls.poses = {item["symbol"]: item["params"] for item in ipa_reference_library.poses()}

    def test_t20_vowel_formants_f3_and_calibrated_jd2_poses(self) -> None:
        vf = ipa_reference_library.vowel_formants()
        records = vf["records"]
        self.assertEqual(len(records), 29)
        central_record = next(r for r in records if r["id"] == "supplement-mandarin-central-a")
        self.assertEqual(unicodedata.normalize("NFD", central_record["symbol"]), "a\u0308")
        for rec in records:
            self.assertIn("f3", rec)
            self.assertIsInstance(rec["f3"], (int, float))
            self.assertTrue(np.isfinite(rec["f3"]))
            self.assertGreater(rec["f3"], rec["f2"])

        vt_path = ENGINE / "reference_library" / "vowel-transfer-jd2-65.json"
        self.assertTrue(vt_path.is_file())
        vt = json.loads(vt_path.read_text(encoding="utf-8"))
        self.assertEqual(vt["speaker"], "JD2")
        self.assertEqual(vt["section_count"], 65)
        self.assertEqual(vt["method"], "vtl-hf-textgrid-core-v1")
        self.assertCountEqual([r["id"] for r in vt["records"]], [r["id"] for r in records])
        self.assertTrue(all("f3" in r and r["f3"] > r["f2"] for r in vt["records"]))

        # Open-central Sinological vowel 'ᴀ' (U+1D00) present in poses.json & canonical_ipa_poses.json
        self.assertIn("ᴀ", self.poses)
        vowel_poses = [p for p in ipa_reference_library.poses() if p["symbol"] in vowel_response._VOWELS]
        measured = vowel_response.measure_saved_poses("JD2", vowel_poses, dense_manager=self.mgr)
        by_sym = {r["symbol"]: r for r in measured["records"]}
        self.assertIn("ᴀ", by_sym)
        self.assertIn("f3", by_sym["ᴀ"])
        # Open-central 'ᴀ' sits acoustically between [ɑ] and [a] in F2
        self.assertGreater(by_sym["ᴀ"]["f2"], by_sym["ɑ"]["f2"])
        self.assertLess(by_sym["ᴀ"]["f2"], by_sym["a"]["f2"])

        # Match the centralized recording [ä] to the existing open-central preset ᴀ.
        pairs = [(r, by_sym["ᴀ" if r is central_record else r["symbol"]]) for r in records]
        df2_list = [abs(pose["f2"] - recording["f2"]) for recording, pose in pairs]
        df3_list = [abs(pose["f3"] - recording["f3"]) for recording, pose in pairs]
        self.assertLess(float(np.mean(df2_list)), 75.0)
        self.assertLess(float(np.mean(df3_list)), 120.0)

    def test_t20_lateral_l_geometry_bypass_and_lalala_synthesis(self) -> None:
        for sym in ("l", "ɭ", "ʎ", "ʟ"):
            self.assertIn(sym, self.poses)
            p = self.poses[sym]
            self.assertLessEqual(p[18], -0.60, f"{sym} TS3 must be negative to open lateral bypass")

        p_l = self.poses["l"]
        self.assertGreaterEqual(p_l[10], 4.6)
        self.assertLessEqual(p_l[10], 5.1)
        self.assertGreaterEqual(p_l[11], 0.55)
        self.assertLessEqual(p_l[11], 0.95)

        canonical_path = BUNDLE_PKG / "assets" / "canonical_ipa_poses.json"
        canonical_doc = json.loads(canonical_path.read_text(encoding="utf-8"))
        self.assertNotIn("Stage-4", canonical_doc["meta"]["note"])
        self.assertLess(canonical_doc["poses"]["l"]["kf26_norm"][16], -0.25)
        self.assertIn("ᴀ", canonical_doc["poses"])

        keyframe_lite._CACHED_BANK = None
        n_200 = 200
        glot_modal = [0.04, 0.04, 0.02, 1.222044, 0.85, 0.45, 20.0, 5.0]
        spans = [
            {"ipa": "sil", "phase": "silence", "start_frame": 0, "end_frame": 8},
            {"ipa": "l", "start_frame": 8, "end_frame": 32},
            {"ipa": "a", "start_frame": 32, "end_frame": 68},
            {"ipa": "l", "start_frame": 68, "end_frame": 92},
            {"ipa": "a", "start_frame": 92, "end_frame": 128},
            {"ipa": "l", "start_frame": 128, "end_frame": 152},
            {"ipa": "a", "start_frame": 152, "end_frame": 192},
            {"ipa": "sil", "phase": "silence", "start_frame": 192, "end_frame": 200},
        ]
        init_tracts = []
        for sp in spans:
            p_row = self.poses["l"] if sp["ipa"] == "l" else self.poses["a"]
            init_tracts.extend([list(p_row) for _ in range(sp["end_frame"] - sp["start_frame"])])
        syn_payload, _, _ = keyframe_lite.apply_annotation_trajectory({
            "speaker": "JD2",
            "step_hz": 200,
            "tract_frames": init_tracts,
            "f0_hz": [130.0] * n_200,
            "pressure_pa": [0.0 if i < 8 or i >= 192 else 800.0 for i in range(n_200)],
            "glottis_frames": [list(glot_modal) for _ in range(n_200)],
            "articulation_spans": spans,
        })
        syn_res = self.mgr.synthesize_dense(syn_payload)
        self.assertTrue(syn_res["ok"])
        b64_wav = syn_res.get("wav_base64") or syn_res.get("audio_wav_base64")
        sig, sr = sf.read(io.BytesIO(base64.b64decode(b64_wav)), dtype="float32")
        self.assertEqual(sr, 48000)
        self.assertTrue(np.isfinite(sig).all())
        self.assertGreater(float(np.sqrt(np.mean(sig ** 2))), 0.01)

    def test_t27_snapshot_antiformants_and_nasal_coupled(self) -> None:
        with self.mgr.lease("JD2", section_count=65) as eng:
            snap_m = eng.snapshot(self.poses["m"])
            self.assertTrue(snap_m["nasal_coupled"])
            self.assertGreaterEqual(len(snap_m["antiformants"]), 1)
            for z in snap_m["antiformants"]:
                self.assertGreaterEqual(z["f_hz"], 250.0)
                self.assertLessEqual(z["f_hz"], 5500.0)

            snap_l = eng.snapshot(self.poses["l"])
            self.assertFalse(snap_l["nasal_coupled"])
            self.assertGreaterEqual(len(snap_l["antiformants"]), 1)

            snap_a = eng.snapshot(self.poses["a"])
            self.assertFalse(snap_a["nasal_coupled"])
            self.assertEqual(snap_a["antiformants"], [])

    def test_t22_trills_envelope_realtime_and_missing_recording_fallbacks(self) -> None:
        self.assertEqual(
            set(GESTURES.keys()),
            {"bilabial", "linguolabial", "dental", "alveolar", "postalveolar", "uvular"},
        )
        self.assertEqual(resolve_trill_place("ʙ"), "bilabial")
        self.assertEqual(resolve_trill_place("r̼̊"), "linguolabial")
        self.assertEqual(resolve_trill_place("r̪"), "dental")
        self.assertEqual(resolve_trill_place("r"), "alveolar")
        self.assertEqual(resolve_trill_place("r̠̊"), "postalveolar")
        self.assertEqual(resolve_trill_place("ʀ"), "uvular")

        base = np.repeat(np.asarray(self.poses["a"], dtype=np.float64)[None, :], 80, axis=0)
        with self.mgr.lease("JD2") as eng:
            pose0 = apply_trill(eng, {"params": list(self.poses["a"])}, [(0.0, 0.20, "alveolar")], 0.0)
            pose_end = apply_trill(eng, {"params": list(self.poses["a"])}, [(0.0, 0.20, "alveolar")], 0.199999)
            mod = apply_trill_to_tract19(base, [(0.0, 0.20, "alveolar")], 400.0)
        # 10 ms smoothstep envelope starts and ends at exact baseline
        np.testing.assert_allclose(pose0["params"], self.poses["a"], atol=1e-7)
        np.testing.assert_allclose(pose_end["params"], self.poses["a"], atol=1e-5)
        # Interior TTY oscillates across [-0.40, +0.23]
        self.assertGreater(float(mod[10:70, 11].max() - mod[10:70, 11].min()), 0.45)

        # Neural 50 Hz alias-guarded modulation
        m27 = np.zeros((25, 27), dtype=np.float64)
        m27[:, 11] = -0.45
        m27[:, 18] = 8000.0
        m27_mod = apply_trill_to_m27(m27, [(0.04, 0.44, "alveolar")], 50.0, modulate_aerodynamics_50hz=True)
        self.assertGreater(float(m27_mod[4:20, 11].max() - m27_mod[4:20, 11].min()), 0.30)

        # Check original recordings untouched & missing trills main-T062..T069 served via fallback
        raw_idx = {e["id"]: e for e in ipa_reference_library.index()}
        self.assertTrue(raw_idx["main-T060"]["exists"])
        self.assertTrue(raw_idx["main-T061"]["exists"])
        self.assertTrue(raw_idx["main-T070"]["exists"])
        self.assertTrue(raw_idx["main-T071"]["exists"])
        for tid in [f"main-T0{n}" for n in range(62, 70)]:
            self.assertFalse(raw_idx[tid]["exists"], f"{tid} raw index.json flag must remain untouched")

        play_idx = {e["id"]: e for e in ipa_reference_library.playback_index()}
        for tid in [f"main-T0{n}" for n in range(62, 70)]:
            self.assertTrue(play_idx[tid]["exists"])
            self.assertTrue(play_idx[tid]["animation"])
            self.assertTrue(play_idx[tid].get("synthesized_trill"))
            audio_res = ipa_reference_library.load_resource(tid, "audio")
            anim_res = ipa_reference_library.load_resource(tid, "animation")
            self.assertIsNotNone(audio_res)
            self.assertIsNotNone(anim_res)
            anim_doc = json.loads(anim_res[0].decode("utf-8"))
            self.assertEqual(anim_doc["animation"]["schema"], "m27_anim_v3")
            self.assertGreater(anim_doc["animation"]["frame_count"], 50)

        trill_index_text = (ENGINE / "reference_library" / "trill-demos" / "index.json").read_text(encoding="utf-8")
        self.assertNotIn("Stage 5", trill_index_text)
        self.assertIn("Tract2Vox-Lite", trill_index_text)

    def test_t21_raised_cosine_bell_overlay_and_strict_validation(self) -> None:
        w = keyframe_lite.raised_cosine_bell(5, 0.5)
        self.assertAlmostEqual(float(w[0]), 0.0, places=7)
        self.assertAlmostEqual(float(w[2]), 1.0, places=7)
        self.assertAlmostEqual(float(w[4]), 0.0, places=7)

        t_base = np.repeat(np.asarray(self.poses["a"], dtype=np.float64)[None, :], 140, axis=0)
        spans_mod = [
            {"ipa": "i", "start_frame": 0, "end_frame": 40},
            {"ipa": "a", "start_frame": 40, "end_frame": 100, "target_u": 0.5, "pose_delta": {"TCX": 0.6}},
            {"ipa": "u", "start_frame": 100, "end_frame": 140},
        ]
        t_mod, err_ov = keyframe_lite.apply_keyframe_bell_overlays_tract19(t_base, spans_mod)
        self.assertIsNone(err_ov)
        assert t_mod is not None
        # Boundary at frame 40 and frame 99 preserved; midpoint (frame 70) shifted by +0.6
        self.assertAlmostEqual(float(t_mod[40, 8] - t_base[40, 8]), 0.0, places=5)
        self.assertAlmostEqual(float(t_mod[99, 8] - t_base[99, 8]), 0.0, places=5)
        self.assertAlmostEqual(float(t_mod[70, 8] - t_base[70, 8]), 0.6, places=2)

        _, err = validate_pose_target_or_delta({"JA": 5.0}, None, field_prefix="span[0]")
        self.assertIsNotNone(err)
        self.assertEqual(err["error"]["code"], "out_of_range")

    def test_t24_dac_secondary_articulation_tiebars_and_syllabic_obstruents(self) -> None:
        pb = PoseBank(
            BUNDLE_PKG / "assets" / "canonical_ipa_poses.json",
            BUNDLE_PKG / "assets" / "jd2_starter_fallback_poses.json",
        )
        mask_pj = default_organ_mask("pʲ")
        mask_tj = default_organ_mask("tʲ")
        # Labial palatalized keeps full bilabial closure weight while activating dorsal palatalization
        self.assertEqual(float(mask_pj[KF26_INDEX["LD"]]), 1.0)
        self.assertGreaterEqual(float(mask_pj[KF26_INDEX["TCY"]]), 0.75)
        # Coronal palatalized keeps full tongue-tip weight
        self.assertEqual(float(mask_tj[KF26_INDEX["TTY"]]), 1.0)

        base_phys = np.zeros(27, dtype=np.float32)
        base_phys[8] = 0.2   # TCX
        base_phys[9] = -1.8  # TCY
        p_j = apply_diacritics_to_phys27(base_phys, "pʲ")
        k_j = apply_diacritics_to_phys27(base_phys, "kʲ")
        self.assertGreater(float(p_j[9]), float(base_phys[9]))
        self.assertGreater(float(k_j[8]), float(base_phys[8]) + 0.7)

        # Compound tie-bars and syllabic obstruents pass validation & lookup cleanly
        for sym in ("k͡pʷ", "ɡ͡bʷ", "s̩", "z̩", "ʂ̩", "ʐ̩"):
            diag = validate_ipa_diacritics(sym)
            self.assertTrue(diag["valid"], f"{sym} should be valid: {diag}")
            self.assertEqual(diag["errors"], [], f"{sym} should not trigger illegal diacritic errors")
            vec = pb.raw_lookup_kf26(sym)
            self.assertEqual(vec.shape, (26,))
            self.assertTrue(np.isfinite(vec).all())

    def test_t25_custom_speaker_wav_base64_passthrough(self) -> None:
        bridge = M27Bridge()
        n = 10
        base_payload = {
            "speaker": "JD2",
            "step_hz": 50,
            "f0_hz": [135.0] * n,
            "pressure_pa": [700.0] * n,
            "tract_frames": [self.poses["a"][:] for _ in range(n)],
            "glottis_frames": [[0.04, 0.04, 0.02, 1.222044, 0.85, 0.45, 10.0, 5.0] for _ in range(n)],
            "sample_count": n * 960,
        }
        bad_type = bridge.synthesize_dense_neural({**base_payload, "speaker_wav_base64": 12345})
        self.assertFalse(bad_type["ok"])
        self.assertEqual(bad_type["error"]["field"], "speaker_wav_base64")

        # Synthesize a tiny valid 16 kHz mono WAV in memory and mock _resolve_custom_timbre / _load_tract2vox
        sr = 16000
        t = np.arange(sr // 2, dtype=np.float32) / sr
        wav_buf = io.BytesIO()
        sf.write(wav_buf, 0.2 * np.sin(2.0 * np.pi * 140.0 * t), sr, format="WAV", subtype="PCM_16")
        b64 = base64.b64encode(wav_buf.getvalue()).decode("ascii")

        fake_spk = np.ones((1, 512), dtype=np.float32) / float(np.sqrt(512.0))
        captured = {}

        def fake_gen(inputs, spk_emb):
            captured["spk_emb"] = np.asarray(spk_emb, dtype=np.float32)
            captured["shape"] = tuple(np.asarray(inputs).shape)
            return np.zeros((1, captured["shape"][1] * 320), dtype=np.float32)

        fake_models = {"device": "cpu", "gen": fake_gen}
        with patch.object(bridge, "_resolve_custom_timbre", return_value=fake_spk) as mock_spk, \
             patch.object(bridge, "_load_tract2vox", return_value=(fake_models, "cpu")):
            res = bridge.synthesize_dense_neural({**base_payload, "speaker_wav_base64": b64})
            self.assertTrue(res["ok"])
            self.assertEqual(res["voice_profile"], "custom-reference")
            mock_spk.assert_called_once()
            np.testing.assert_allclose(captured["spk_emb"], fake_spk)

    def test_t38_scan_local_models_returns_all_9_real_models(self) -> None:
        info = scan_local_models()
        self.assertTrue(info["ok"])
        self.assertEqual(info["count"], 9)
        self.assertEqual(info["available_count"], 9)
        expected_names = {
            "Vox2Tract-Lite",
            "Vox2Align-Lite v2",
            "IPA2Tract-Lite",
            "Tract2Vox-Lite",
            "Vox2Spk-Lite",
            "DPDFNet",
            "Text2Prosody-Lite",
            "Tract2Area-Proxy",
            "SwiftF0",
        }
        by_name = {m["name"]: m for m in info["models"]}
        self.assertEqual(set(by_name.keys()), expected_names)
        summed_bytes = 0
        for name, m in by_name.items():
            self.assertTrue(m["available"], f"{name} must be available on disk")
            self.assertGreater(m["file_bytes"], 50_000, f"{name} file_bytes too small")
            self.assertGreater(m["size_mb"], 0.05)
            self.assertGreater(m["params_m"], 0.01, f"{name} params_m must be > 0")
            self.assertIn(m["precision"], ("FP16", "FP32", "ONNX"))
            self.assertTrue(m["description"])
            summed_bytes += m["file_bytes"]
            for forbidden in ("Stage 4", "Stage 5", "KF2Tract"):
                self.assertNotIn(forbidden, json.dumps(m, ensure_ascii=False))
        self.assertEqual(info["total_bytes"], summed_bytes)
        self.assertAlmostEqual(info["total_size_mb"], round(summed_bytes / (1024.0 * 1024.0), 2), places=2)


if __name__ == "__main__":
    unittest.main()
