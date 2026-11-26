"""Regressions for selected IPA targets and sub-frame articulation events."""

from pathlib import Path
import sys
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ipa_articulation import normalize_tract, preserve_stop_transients
from ipa_reference_library import poses
from ipa_reference_trajectory import prepare_reference_trajectories, protection_weights
from keyframe_lite import apply_annotation_trajectory, default_poses
from validation import M27_MIN_PA


class IpaArticulationTest(unittest.TestCase):
    def test_selected_vowel_tracks_its_primary_tract_and_keeps_model_default(self):
        recorded = next(entry["params"] for entry in poses() if entry["symbol"] == "a")
        n = 30
        span = {"start_frame": 0, "end_frame": n, "ipa": "a", "phase": "normal"}
        payload = {
            "step_hz": 200, "speaker": "JD2", "synth_mode": "neural",
            "f0_hz": [130] * n, "pressure_pa": [620] * n,
            "tract_frames": [recorded] * n,
            "glottis_frames": [[0.04, 0.04, 0.04, 1.2, 0, 0.4, 0, 0]] * n,
            "articulation_spans": [span],
        }
        baseline, _, _ = apply_annotation_trajectory(payload)
        current, _, _ = apply_annotation_trajectory({
            **payload, "pose_source": "custom",
            "articulation_spans": [{**span, "pose_target_19": recorded}],
        })
        primary = [3, 4, 5, 7, 8, 9]
        desired = np.asarray(recorded)[primary]
        actual = np.asarray(current["tract_frames"])[14, primary]
        original = np.asarray(baseline["tract_frames"])[14, primary]
        self.assertLess(np.linalg.norm(actual - desired), 0.4 * np.linalg.norm(original - desired))

        model = default_poses({"phones": [{"ipa": "a", "closure": False}]})["poses"][0]
        model_anchored, _, _ = apply_annotation_trajectory({
            **payload, "pose_source": "stored",
            "articulation_spans": [{**span, "pose_target_19": model}],
        })
        np.testing.assert_array_equal(model_anchored["tract_frames"], baseline["tract_frames"])

    def test_lateral_endings_survive_both_control_rates(self):
        recorded = {entry["symbol"]: entry["params"] for entry in poses()}
        lateral = np.array(recorded["l"])
        vowel = np.array(recorded["a"])
        targets = np.vstack((
            np.tile(lateral, (34, 1)),
            np.linspace(lateral, vowel, 6),
            np.tile(vowel, (20, 1)),
        ))
        spans = [
            {"start_frame": 0, "end_frame": 20, "ipa": "l", "phase": "normal", "lateral_ending": "hold"},
            {"start_frame": 20, "end_frame": 40, "ipa": "l", "phase": "normal", "lateral_ending": "release"},
            {"start_frame": 40, "end_frame": 60, "ipa": "a", "phase": "normal"},
        ]
        payload = {
            "step_hz": 200, "speaker": "JD2", "f0_hz": [130] * 60, "pressure_pa": [620] * 60,
            "tract_frames": targets.tolist(), "articulation_spans": spans,
            "glottis_frames": [[0.04, 0.04, 0.04, 1.2, 0, 0.4, 0, 0]] * 60,
        }
        for mode in ("physical", "neural"):
            with self.subTest(mode=mode):
                rendered, rows_50, _ = apply_annotation_trajectory({**payload, "synth_mode": mode})
                dense = np.asarray(rendered["tract_frames"])
                np.testing.assert_allclose(dense[:40, [11, 18]], targets[:40, [11, 18]], atol=1e-6)
                centers = np.arange(2, 40, 4)
                np.testing.assert_allclose(rows_50[:len(centers), [11, 16]], targets[centers][:, [11, 18]], atol=1e-6)
                self.assertTrue(np.all(np.asarray(rendered["pressure_pa"])[5:40] > 0))
                ordinary_spans = [{key: value for key, value in span.items() if key != "lateral_ending"} for span in spans]
                ordinary, _, _ = apply_annotation_trajectory({**payload, "synth_mode": mode, "articulation_spans": ordinary_spans})
                np.testing.assert_array_equal(dense[40:], ordinary["tract_frames"][40:])

    def test_reference_selection_distinguishes_onset_and_intervocalic_affricates(self):
        requests = [
            {"ipa": "p͡ɸ", "start_smp": 0, "end_smp": 3600, "affricate": True,
             "position": "onset", "right_vowel": "a"},
            {"ipa": "pɸ", "start_smp": 7200, "end_smp": 12000, "affricate": True,
             "position": "intervocalic", "left_vowel": "a", "right_vowel": "a"},
            {"ipa": "pɸ̥", "start_smp": 12000, "end_smp": 14400, "affricate": True,
             "position": "intervocalic"},
        ]
        refs, missing = prepare_reference_trajectories(requests, 14400, 240, 60)
        self.assertEqual(missing, ["pɸ̥"])
        self.assertEqual([ref.info["reference_position"] for ref in refs], ["onset", "intervocalic"])
        self.assertLess(refs[0].info["source_end_s"], refs[1].info["source_start_s"])
        self.assertGreater(np.ptp(refs[1].controls_pa[:, 5]), 0)

    def test_reference_and_protected_pose_preserve_synth_mode_and_sync_50hz(self):
        vowel = next(entry["params"] for entry in poses() if entry["symbol"] == "a")
        protected = [*vowel]
        protected[5] = 1.7
        n = 66
        requests = [{
            "ipa": "ɸ", "start_smp": 20 * 240, "end_smp": 46 * 240,
            "position": "intervocalic", "left_vowel": "a", "right_vowel": "a",
        }]
        payload = {
            "step_hz": 200, "speaker": "JD2", "synth_mode": "neural",
            "f0_hz": list(range(135, 135 + n)), "pressure_pa": [620] * n,
            "pressure_locks": [True] * n,
            "tract_frames": [protected] * 20 + [vowel] * (n - 20),
            "glottis_frames": [[0.04, 0.04, 0.04, 1.2, 0, 0.4, 0, 0]] * n,
            "articulation_spans": [
                {"start_frame": 0, "end_frame": 20, "ipa": "a", "phase": "normal", "locked": True,
                 "pose_protected": True, "pressure_locked": True},
                {"start_frame": 20, "end_frame": 46, "ipa": "ɸ", "phase": "normal", "voiced": False,
                 "pressure_locked": True},
                {"start_frame": 46, "end_frame": n, "ipa": "a", "phase": "normal", "pressure_locked": True},
            ],
            "reference_spans": requests,
        }
        resolved, rows_50, info = apply_annotation_trajectory(payload)
        self.assertEqual(resolved["synth_mode"], "neural")
        self.assertEqual(info["protected_ipa_poses"], ["a"])
        self.assertEqual(info["recorded_articulation"][0]["reference_position"], "intervocalic")
        weights = protection_weights(0, 20 * 240, slice(0, 20), 240)
        self.assertEqual(weights[0], 0)
        self.assertEqual(weights[-1], 0)
        raw = np.asarray(resolved["tract_frames"])
        indices = list(range(14)) + [16, 17, 18]
        np.testing.assert_allclose(raw[:20][weights == 1], [protected] * int(np.sum(weights == 1)), atol=1e-7)

        refs, _ = prepare_reference_trajectories(requests, n * 240, 240, n)
        core = refs[0].weights == 1
        np.testing.assert_allclose(raw[20:46, indices][core], refs[0].controls_pa[core, :17], atol=1e-8)

        # 50 Hz neural control rows receive both the protected pose and the reference trajectory.
        centers = np.minimum(np.arange((n + 3) // 4) * 4 + 2, n - 1)
        prot_50 = (centers < 20) & (weights[np.minimum(centers, 19)] == 1)
        self.assertTrue(np.any(prot_50))
        np.testing.assert_allclose(
            rows_50[prot_50, :17],
            np.repeat(np.asarray(protected)[indices][None, :], int(np.sum(prot_50)), axis=0),
            atol=1e-6,
        )
        ref_50_core = (centers >= 20) & (centers < 46)
        ref_50_core[ref_50_core] &= core[centers[ref_50_core] - 20]
        self.assertTrue(np.any(ref_50_core))
        np.testing.assert_allclose(rows_50[ref_50_core, :17], raw[centers[ref_50_core]][:, indices], atol=1e-6)

        normal, _, _ = apply_annotation_trajectory({**payload, "reference_spans": []})
        for key in ("tract_frames", "pressure_pa", "glottis_frames"):
            for edge in (20, 45, 46, 47):
                np.testing.assert_array_equal(resolved[key][edge], normal[key][edge])
        np.testing.assert_array_equal(resolved["f0_hz"], payload["f0_hz"])
        np.testing.assert_allclose(resolved["pressure_pa"], payload["pressure_pa"], atol=1e-6)

        # Physical mode remains physical when explicitly requested.
        phys, _, _ = apply_annotation_trajectory({**payload, "synth_mode": "physical"})
        self.assertEqual(phys["synth_mode"], "physical")

    def test_reference_trajectory_aligns_pressure_and_preserves_host_voice_quality(self):
        vowel = next(entry["params"] for entry in poses() if entry["symbol"] == "a")
        n = 96
        payload = {
            "step_hz": 200, "speaker": "JD2", "synth_mode": "neural",
            "f0_hz": [155.0] * n, "pressure_pa": [750.0] * n,
            "tract_frames": [vowel] * n,
            "glottis_frames": [[0.04, 0.04, 0.02, 1.22, 1.0, 0.5, 20.0, 0.0]] * n,
            "articulation_spans": [
                {"start_frame": 0, "end_frame": 32, "ipa": "a", "phase": "normal"},
                {"start_frame": 32, "end_frame": 62, "ipa": "ʎ", "phase": "normal", "voiced": True},
                {"start_frame": 62, "end_frame": n, "ipa": "a", "phase": "normal"},
            ],
            "reference_spans": [{
                "ipa": "ʎ", "start_smp": 32 * 240, "end_smp": 62 * 240,
                "position": "intervocalic", "left_vowel": "a", "right_vowel": "a",
            }],
        }
        resolved, _, _ = apply_annotation_trajectory(payload)
        baseline, _, _ = apply_annotation_trajectory({**payload, "reference_spans": []})
        pr = np.asarray(resolved["pressure_pa"])
        gl = np.asarray(resolved["glottis_frames"])
        gl_base = np.asarray(baseline["glottis_frames"])
        # No +100 Pa single-frame cliff at the reference boundary.
        self.assertLess(float(np.max(np.abs(np.diff(pr[10:-5])))), 45.0)
        # Voiced lateral preserves host glottal quality (LAG, RA, PS, FL, SHIM).
        np.testing.assert_allclose(gl[:, 3:], gl_base[:, 3:], atol=1e-6)

    def test_short_articulator_targets_do_not_inject_single_frame_spikes(self):
        from ipa_articulation import ArticulatorTarget, apply_articulator_targets
        from keyframe_lite import raised_cosine_bell

        rows = np.zeros((10, 27), dtype=np.float64)
        rows[:, :17] = M27_MIN_PA[:17] + 0.5
        target_pose = np.ones(17, dtype=np.float64)
        weights = np.ones(17, dtype=np.float64)
        before = rows.copy()
        apply_articulator_targets(rows, [ArticulatorTarget(4, 5, target_pose, weights, None)], raised_cosine_bell, lambda x: x)
        apply_articulator_targets(rows, [ArticulatorTarget(4, 6, target_pose, weights, None)], raised_cosine_bell, lambda x: x)
        np.testing.assert_array_equal(rows, before)

    def test_protection_ramp_preserves_release_and_uses_full_uncropped_bounds(self):
        step = 240
        weights = protection_weights(0, 24 * step, slice(0, 24), step, 20 * step)
        self.assertEqual(weights[0], 0.)
        self.assertEqual(weights[20], 1.)
        self.assertEqual(weights[21], 1.)
        self.assertEqual(weights[23], 0.)
        cropped = protection_weights(-18 * step, 6 * step, slice(0, 6), step, 2 * step)
        np.testing.assert_array_equal(cropped, weights[18:])

    def test_sub_grid_release_and_explicit_locks_preserve_peak_without_leaking(self):
        dense = np.repeat(M27_MIN_PA[None, :], 12, axis=0)
        dense[6, 5] = 0.4
        dense[6, 18:24] = [520, 0.1, 0.1, 0.1, 1.2, 0.1]
        control = np.repeat(M27_MIN_PA[None, :], 3, axis=0)
        control[:, 17] = 180
        control[1, 5] = 0.75
        control[1, 18] = 200
        before = control.copy()
        target = M27_MIN_PA[:17].copy()
        target[5] = 0.3
        weights = np.zeros(17)
        weights[5] = 1
        locked = np.zeros(control.shape, dtype=bool)
        locked[1, 18] = True
        events = [
            {"phase": "closure", "start_frame": 0, "end_frame": 4},
            {"phase": "release", "start_frame": 5, "end_frame": 5,
             "start_sample": 1008, "end_sample": 1152},
            {"phase": "release", "start_frame": 6, "end_frame": 8},
            {"phase": "release", "start_frame": 8, "end_frame": 10},
        ]
        preserve_stop_transients(
            control, dense, events, 4, [False, False, True], locks_50=locked,
            short_targets={1: (normalize_tract(target), weights)}, step_samples=240,
        )
        self.assertAlmostEqual(control[1, 5], 0.3, places=5)
        self.assertEqual(control[1, 18], 200)
        np.testing.assert_array_equal(control[:, 17], before[:, 17])
        np.testing.assert_array_equal(control[2], before[2])

        control = before.copy()
        preserve_stop_transients(control, dense, events[2:], 4, [False, False, True], locks_50=locked)
        self.assertEqual(control[1, 5], 0.4)
        self.assertEqual(control[1, 18], 200)
        self.assertEqual(control[1, 19], 0.1)

    def test_connected_lateral_and_nasal_custom_poses_stay_smooth(self):
        recorded = {entry["symbol"]: entry["params"] for entry in poses()}
        a_pose, l_pose, m_pose = recorded["a"], recorded["l"], recorded["m"]

        # 1) Prevocalic onset lateral [a l a] without hard lateral_ending overwrite stays smooth (no flap cliff).
        n_lat = 56
        lat_payload = {
            "step_hz": 200, "speaker": "JD2", "synth_mode": "neural", "pose_source": "custom",
            "f0_hz": [150.0] * n_lat, "pressure_pa": [800.0] * n_lat,
            "tract_frames": [a_pose] * 20 + [l_pose] * 16 + [a_pose] * 20,
            "glottis_frames": [[0.01, 0.01, 0.05, 1.22, 0.2, 0.0, 0.25, 0.0]] * n_lat,
            "articulation_spans": [
                {"start_frame": 0, "end_frame": 20, "ipa": "a", "phase": "normal", "pose_target_19": a_pose},
                {"start_frame": 20, "end_frame": 36, "ipa": "l", "phase": "normal", "lateral_ending": "release", "pose_target_19": l_pose},
                {"start_frame": 36, "end_frame": n_lat, "ipa": "a", "phase": "normal", "pose_target_19": a_pose},
            ],
        }
        lat_out, _, _ = apply_annotation_trajectory(lat_payload)
        lat_tr = np.asarray(lat_out["tract_frames"])
        self.assertLess(float(np.max(np.abs(np.diff(lat_tr[:, 11])))), 0.18)

        # 2) Intervocalic nasal [a m a] keeps soft lip closure and preserves anticipatory/carryover velum coupling.
        n_nas = 60
        nas_payload = {
            "step_hz": 200, "speaker": "JD2", "synth_mode": "neural", "pose_source": "custom",
            "f0_hz": [150.0] * n_nas, "pressure_pa": [800.0] * n_nas,
            "tract_frames": [a_pose] * 20 + [m_pose] * 20 + [a_pose] * 20,
            "glottis_frames": [[0.01, 0.01, 0.05, 1.22, 0.2, 0.0, 0.25, 0.0]] * n_nas,
            "articulation_spans": [
                {"start_frame": 0, "end_frame": 20, "ipa": "a", "phase": "normal", "pose_target_19": a_pose},
                {"start_frame": 20, "end_frame": 40, "ipa": "m", "phase": "normal", "pose_target_19": m_pose},
                {"start_frame": 40, "end_frame": n_nas, "ipa": "a", "phase": "normal", "pose_target_19": a_pose},
            ],
        }
        nas_out, _, _ = apply_annotation_trajectory(nas_payload)
        nas_tr = np.asarray(nas_out["tract_frames"])
        # Velum stays coupled across nasal release instead of slamming shut to -0.10 immediately.
        self.assertGreater(float(nas_tr[41, 7]), 0.15)
        # Lip motion inside the nasal closure [20..38] stays smooth without harsh flap/plosive snaps.
        self.assertLess(float(np.max(np.abs(np.diff(nas_tr[20:39, 5])))), 0.25)

    def test_english_narrow_aspiration_for_stops_and_ch(self):
        bundle_pkg = Path(__file__).resolve().parents[1] / "model_bundle" / "packages" / "kf_ipa_synth"
        if str(bundle_pkg) not in sys.path:
            sys.path.insert(0, str(bundle_pkg))
        from kf_ipa_synth.phonetics import ipa_to_phon_features, is_ipa_aspirated
        from kf_ipa_synth.text2ipa import _arpabet_or_timit_to_ipa_stresses

        self.assertTrue(is_ipa_aspirated("tʃʰ"))
        self.assertFalse(is_ipa_aspirated("tʃ"))
        self.assertEqual(float(ipa_to_phon_features("tʃʰ")[18]), 1.0)

        speech_ipa, _ = _arpabet_or_timit_to_ipa_stresses(["S", "P", "IY1", "CH"], is_cmu=True)
        bitch_ipa, _ = _arpabet_or_timit_to_ipa_stresses(["B", "IH1", "CH"], is_cmu=True)
        switch_ipa, _ = _arpabet_or_timit_to_ipa_stresses(["S", "W", "IH1", "CH"], is_cmu=True)
        paper_ipa, _ = _arpabet_or_timit_to_ipa_stresses(["P", "EY1", "P", "ER0"], is_cmu=True)
        apart_ipa, _ = _arpabet_or_timit_to_ipa_stresses(["AH0", "P", "AA1", "R", "T"], is_cmu=True)
        tsunami_ipa, _ = _arpabet_or_timit_to_ipa_stresses(["T", "S", "UW0", "N", "AA1", "M", "IY0"], is_cmu=True)

        self.assertEqual(speech_ipa, ["s", "p", "i", "tʃʰ"])
        self.assertEqual(bitch_ipa, ["b", "ɪ", "tʃʰ"])
        self.assertEqual(switch_ipa, ["s", "w", "ɪ", "tʃʰ"])
        self.assertEqual(paper_ipa, ["pʰ", "eɪ", "p", "ɚ"])
        self.assertEqual(apart_ipa, ["ə", "pʰ", "ɑ", "ɹ", "t"])
        self.assertEqual(tsunami_ipa, ["t", "s", "u", "n", "ɑ", "m", "i"])

