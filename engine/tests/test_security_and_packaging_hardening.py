"""Regression tests for D-02, D-05, D-10, D-11, A-02, A-09, and P-01..P-11 hardening."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ENGINE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = ENGINE_DIR.parent
PORTABLE_DIR = REPO_ROOT / "scripts" / "portable"

for p in (ENGINE_DIR, PORTABLE_DIR):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from dense_channel import DenseEngineManager, EngineBusyError  # noqa: E402
from prosody_bridge import ProsodyBridge  # noqa: E402
import server as engine_server  # noqa: E402
from validation import (  # noqa: E402
    validate_glottis_frames,
    validate_m27_pa,
    validate_scalar_range,
    validate_scalar_series,
    validate_tract19_frames,
)
from voice_morph_bridge import VoiceMorphBridge  # noqa: E402
import build as portable_build  # noqa: E402
import encode_references  # noqa: E402
import verify as portable_verify  # noqa: E402


POSE = [0.55, -4.75, -0.1, -4.5, 0.28, 0.62, 0.5, 0.0, 0.55, -1.2, 3.65, -0.8, 2.15, 0.45, -0.75, -1.85, 0.12, 0.08, 0.05]
GLOT8 = [0.04, 0.04, 0.02, 1.222044, 0.85, 0.45, 10.0, 5.0]


class EngineSecurityAndBoundaryTests(unittest.TestCase):
    def test_d02_engine_header_guard_blocks_cross_site_dns_rebinding_and_text_plain(self) -> None:
        ok, status, _ = engine_server.validate_engine_request_headers(
            "POST",
            {
                "Host": "127.0.0.1:8765",
                "Origin": "http://127.0.0.1:5173",
                "Sec-Fetch-Site": "same-origin",
                "Content-Type": "application/json",
                "X-VoxFigura-Engine-Token": "secret-tok",
            },
            expected_token="secret-tok",
            server_port=8765,
        )
        self.assertTrue(ok)
        self.assertEqual(status, 200)

        # Non-loopback Host (DNS rebinding)
        ok, status, _ = engine_server.validate_engine_request_headers(
            "GET",
            {"Host": "evil.example:8765"},
            server_port=8765,
        )
        self.assertFalse(ok)
        self.assertEqual(status, 403)

        # Cross-site Sec-Fetch-Site
        ok, status, _ = engine_server.validate_engine_request_headers(
            "POST",
            {"Host": "127.0.0.1:8765", "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json"},
            server_port=8765,
        )
        self.assertFalse(ok)
        self.assertEqual(status, 403)

        # Foreign Origin
        ok, status, _ = engine_server.validate_engine_request_headers(
            "POST",
            {"Host": "127.0.0.1:8765", "Origin": "https://evil.example", "Content-Type": "application/json"},
            server_port=8765,
        )
        self.assertFalse(ok)
        self.assertEqual(status, 403)

        # Missing/wrong engine token
        ok, status, _ = engine_server.validate_engine_request_headers(
            "POST",
            {"Host": "127.0.0.1:8765", "Content-Type": "application/json"},
            expected_token="secret-tok",
            server_port=8765,
        )
        self.assertFalse(ok)
        self.assertEqual(status, 403)

        # Simple text/plain POST rejected with 415
        ok, status, _ = engine_server.validate_engine_request_headers(
            "POST",
            {"Host": "127.0.0.1:8765", "Content-Type": "text/plain; charset=utf-8"},
            server_port=8765,
        )
        self.assertFalse(ok)
        self.assertEqual(status, 415)

    def test_d05_run_chunk_and_stream_restore_section_count_and_perturbation(self) -> None:
        mgr = DenseEngineManager()
        eng, _ = mgr.get_engine("JD2")
        self.assertEqual(eng.section_count, 65)
        initial_pert = dict(eng.perturbation) if isinstance(eng.perturbation, dict) else None
        initial_flutter = float(eng.flutter)

        n_frames = 30
        payload = {
            "speaker": "JD2",
            "step_hz": 200,
            "section_count": 129,
            "shimmer": 22.0,
            "flutter": 35.0,
            "seed": 4242,
            "f0_hz": [165.0] * n_frames,
            "pressure_pa": [750.0] * n_frames,
            "tract_frames": [POSE[:] for _ in range(n_frames)],
            "include_geometry": False,
        }
        res = mgr.synthesize_dense(payload)
        self.assertTrue(res.get("ok"), msg=str(res))
        self.assertEqual(eng.section_count, 65)
        self.assertEqual(eng.perturbation, initial_pert)
        self.assertAlmostEqual(float(eng.flutter), initial_flutter, places=4)

        events = list(mgr.synthesize_dense_stream(payload))
        self.assertTrue(events and events[0].get("ok"))
        self.assertEqual(eng.section_count, 65)
        self.assertEqual(eng.perturbation, initial_pert)
        self.assertAlmostEqual(float(eng.flutter), initial_flutter, places=4)

    def test_d10_lock_timeout_returns_engine_busy_and_maps_to_http_503(self) -> None:
        mgr = DenseEngineManager(lock_timeout_s=0.05)
        _, primary_lock = mgr.get_engine("JD2")
        held = threading.Event()
        release = threading.Event()

        def hold_lock() -> None:
            with primary_lock:
                held.set()
                release.wait(timeout=5.0)

        t = threading.Thread(target=hold_lock, daemon=True)
        t.start()
        self.assertTrue(held.wait(timeout=2.0))
        try:
            with self.assertRaises(EngineBusyError) as ctx:
                with mgr.lease("JD2", timeout=0.05):
                    pass
            self.assertEqual(ctx.exception.result["error"]["code"], "engine_busy")
            self.assertEqual(engine_server._status_for_result(ctx.exception.result), 503)

            snap = mgr.pose_snapshot({"speaker": "JD2", "params": POSE})
            self.assertFalse(snap.get("ok"))
            self.assertEqual(snap["error"]["code"], "engine_busy")
            self.assertEqual(engine_server._status_for_result(snap), 503)

            contours = mgr.batch_contours({"speaker": "JD2", "poses": [POSE]})
            self.assertFalse(contours.get("ok"))
            self.assertEqual(contours["error"]["code"], "engine_busy")
        finally:
            release.set()
            t.join(timeout=2.0)

    def test_d11_overflow_int_returns_out_of_range_and_glottis_7_or_8_dim_contract(self) -> None:
        huge = 10**400
        err = validate_scalar_range("f0_hz", huge, 60.0, 600.0, "Hz")
        self.assertIsNotNone(err)
        self.assertEqual(err["error"]["code"], "out_of_range")

        _, err_series = validate_scalar_series("pressure_pa", [700.0, -huge], 2, 0.0, 1600.0, "Pa")
        self.assertIsNotNone(err_series)
        self.assertEqual(err_series["error"]["code"], "out_of_range")

        bad_tract = list(POSE)
        bad_tract[0] = huge  # type: ignore[assignment]
        _, err_tract = validate_tract19_frames([bad_tract], expected_len=1)
        self.assertIsNotNone(err_tract)
        self.assertEqual(err_tract["error"]["code"], "out_of_range")

        bad_m27 = [*POSE[:14], *POSE[16:19], 140.0, huge, *GLOT8]
        _, err_m27 = validate_m27_pa([bad_m27])
        self.assertIsNotNone(err_m27)
        self.assertEqual(err_m27["error"]["code"], "out_of_range")

        # 8-dim canonical and legacy 7-dim (shimmer omitted) both pass; 6-dim or 9-dim rejected
        arr8, err8 = validate_glottis_frames([GLOT8], expected_len=1)
        self.assertIsNone(err8)
        self.assertEqual(arr8.shape, (1, 8))
        arr7, err7 = validate_glottis_frames([GLOT8[:7]], expected_len=1)
        self.assertIsNone(err7)
        self.assertEqual(arr7.shape, (1, 7))
        _, err6 = validate_glottis_frames([GLOT8[:6]], expected_len=1)
        self.assertIsNotNone(err6)
        self.assertEqual(err6["error"]["code"], "validation_error")

    def test_a02_voice_morph_public_preset_exports_pa_without_dpa_leak(self) -> None:
        raw_preset = {
            "id": "modal",
            "label": "常态浊声 (Modal · V)",
            "desc": "test",
            "f0_shift_semitones": 0.0,
            "f0_target_hz": None,
            "default_f0_coupling": False,
            "is_voiceless_target": False,
            "builtin": True,
            "source9_phys": [8200.0, 0.034, 0.039, 0.013, 1.38, 0.86, 0.47, 19.7, 6.7],
        }
        pub = VoiceMorphBridge._public_preset(raw_preset)
        self.assertNotIn("source9_phys", pub)
        self.assertIn("source9_phys_pa", pub)
        self.assertAlmostEqual(pub["source9_phys_pa"][0], 820.0, places=2)
        self.assertEqual(len(pub["source9_phys_pa"]), 9)
        self.assertAlmostEqual(pub["source_params"]["pr_pa"], 820.0, places=2)

    def test_a09_prosody_bridge_allows_wide_f0_and_handles_invalid_bounds(self) -> None:
        bridge = ProsodyBridge()
        with self.assertRaises(ValueError):
            bridge.predict({"text": "你好", "f0_min_hz": 0.0})
        with self.assertRaises(ValueError):
            bridge.predict({"text": "你好", "base_f0": 10**400})
        fake_timeline = {
            "ok": True,
            "model_meta": {"file": "text2prosody_lite.onnx"},
            "syllables": [{"id": "s1", "text": "你", "tone": 3, "candidates": []}],
            "keyframes_neural": [{"t": 0.0, "f0_hz": 52.0}],
            "f0_knots_neural": [{"t": 0.0, "hz": 52.0}, {"t": 0.5, "hz": 640.0}],
        }
        with patch.object(bridge._predictor, "predict_timeline", return_value=fake_timeline):
            out = bridge.predict({"text": "你好", "f0_min_hz": 60.0})
        self.assertTrue(out["ok"])
        self.assertEqual(out["f0_floor_hz"], 60.0)
        self.assertEqual(out["f0_adjusted_count"], 1)
        self.assertEqual(out["f0_knots"][0]["hz"], 60.0)
        self.assertEqual(out["f0_knots"][1]["hz"], 640.0)

    def test_p09_local_asr_enabled_for_ondemand_onnx_and_respects_disable_flag(self) -> None:
        if os.environ.get("VOCALCUT_DISABLE_LOCAL_ASR") == "1":
            self.assertFalse(engine_server.LOCAL_ASR_ENABLED)
        else:
            self.assertTrue(engine_server.LOCAL_ASR_ENABLED)
            status = engine_server.asr_install_status()
            self.assertEqual(status["model"], "sensevoice-small")
            self.assertIn(status["state"], {"missing", "ready", "installing", "failed"})


class PackagingHardeningTests(unittest.TestCase):
    def test_p01_p11_forbidden_patterns_and_record_scrubbing(self) -> None:
        must_block = [
            "runtime/python/site-packages/torch/__init__.py",
            "runtime/python/site-packages/torch/lib/c10.dll",
            "runtime/python/site-packages/torch/lib/torch_cpu.dll",
            "runtime/python/site-packages/onnxruntime_gpu/capi.pyd",
            "runtime/python/site-packages/nvidia/cublas/bin/cublas64.dll",
            "runtime/python/site-packages/triton/runtime.py",
            "runtime/python/DirectML.dll",
            "runtime/python/site-packages/whisper/model.py",
            "engine/model_bundle/weights.safetensors",
            "engine/model_bundle/model.bin",
            "engine/model_bundle/model.onnx_data",
            "engine/vendor/python-cp311-win_amd64/pillow-12.1.1.dist-info/direct_url.json",
        ]
        for path in must_block:
            self.assertIsNotNone(portable_build.PRIVATE_PATH.search(path), msg=f"Should block: {path}")

        record = (
            "PIL/Image.py,sha256=abc,100\n"
            "PIL/__pycache__/Image.cpython-311.pyc,,\n"
            "PIL/_imaging.pyi,sha256=def,10\n"
            "pillow-12.1.1.dist-info/direct_url.json,sha256=xyz,99\n"
            "pillow-12.1.1.dist-info/METADATA,sha256=123,500\n"
        )
        scrubbed = portable_build.sanitize_dist_info_record(record)
        self.assertNotIn("direct_url.json", scrubbed)
        self.assertNotIn(".pyc", scrubbed)
        self.assertNotIn(".pyi", scrubbed)
        self.assertIn("PIL/Image.py", scrubbed)
        self.assertIn("pillow-12.1.1.dist-info/METADATA", scrubbed)

    def test_p02_p03_inputs_lock_pins_8_onnx_and_vendor_and_size_breakdown_sums(self) -> None:
        lock = json.loads((PORTABLE_DIR / "inputs.lock.json").read_text(encoding="utf-8"))
        self.assertEqual(set(lock["onnx_models"].keys()), portable_build.OFFICIAL_ONNX_SLOTS)
        self.assertIn("engine/model_bundle/models/IPA2Tract-Lite/canonical_ipa_poses_narrow.json", lock.get("model_assets", {}))
        self.assertNotIn("asr_build_wheels", lock)
        self.assertIn("vendor_files", lock)
        self.assertTrue(all(not k.endswith("direct_url.json") for k in lock["vendor_files"]))

        sample_files = {
            "public/index.html": {"bytes": 1000},
            "engine/model_bundle/models/Vox2Tract-Lite/vox2tract_lite.onnx": {"bytes": 5000},
            "runtime/media/ffmpeg.exe": {"bytes": 3000},
            "engine/reference_library/index.json": {"bytes": 2000},
            "engine/vtl_native/native/VocalTractLabApi.dll": {"bytes": 4000},
            "runtime/node/node.exe": {"bytes": 6000},
            "server/proxy.mjs": {"bytes": 500},
        }
        breakdown = portable_build.compute_size_breakdown(sample_files)
        self.assertEqual(breakdown["total_unpacked_bytes"], 21500)
        self.assertEqual(
            sum(v["bytes"] for v in breakdown["categories"].values()),
            breakdown["total_unpacked_bytes"],
        )

    def test_p08_repair_mp3_tail_supports_both_mono_and_stereo_side_info(self) -> None:
        for ch_mode, expected_info_off, expected_pad_off in ((3, 21, 162), (0, 36, 177)):
            tag_len = expected_info_off + 169
            buf = bytearray(tag_len + 16)
            # MPEG-1 Layer III 192 kbps 48 kHz header with channel_mode
            buf[0] = 0xFF
            buf[1] = 0xFB
            buf[2] = 0xB4
            buf[3] = (ch_mode << 6)
            buf[expected_info_off : expected_info_off + 8] = b"Info\x00\x00\x00\x0f"
            init_delay = 576
            init_pad = 400
            init_field = (init_delay << 12) | init_pad
            buf[expected_pad_off : expected_pad_off + 3] = init_field.to_bytes(3, "big")
            crc_off = expected_info_off + 154
            buf[crc_off : crc_off + 2] = b"\x00\x00"
            crc = encode_references._tag_crc(bytes(buf[:tag_len]))
            buf[crc_off : crc_off + 2] = crc.to_bytes(2, "big")

            with tempfile.TemporaryDirectory() as tmp:
                mp3 = Path(tmp) / f"sample_mode_{ch_mode}.mp3"
                mp3.write_bytes(buf)
                encode_references.repair_mp3_tail(mp3, 128)
                updated = bytearray(mp3.read_bytes())
                new_field = int.from_bytes(updated[expected_pad_off : expected_pad_off + 3], "big")
                self.assertEqual(new_field >> 12, init_delay)
                self.assertEqual(new_field & 0xFFF, init_pad + 128)
                stored_crc = int.from_bytes(updated[crc_off : crc_off + 2], "big")
                updated[crc_off : crc_off + 2] = b"\x00\x00"
                self.assertEqual(encode_references._tag_crc(bytes(updated[:tag_len])), stored_crc)

    def test_p07_verify_mp3_frame_headers_on_workspace_examples(self) -> None:
        for rel in (
            "public/onboarding/demo_en.mp3",
            "public/prewarm/suan_mandarin.mp3",
            "engine/reference_library/trill-demos/trill-r-alveolar.mp3",
        ):
            hdr = portable_verify.parse_mp3_frame_header((REPO_ROOT / rel).read_bytes())
            self.assertEqual(hdr["bitrate_kbps"], 192, msg=rel)
            self.assertEqual(hdr["channels"], 1, msg=rel)

        # Build a miniature stage dir containing workspace examples and run verify_packaged_mp3s
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp)
            for sub in ("onboarding", "prewarm"):
                dst_dir = stage / "public" / sub
                dst_dir.mkdir(parents=True, exist_ok=True)
                for src in (REPO_ROOT / "public" / sub).glob("*.mp3"):
                    (dst_dir / src.name).write_bytes(src.read_bytes())
            stats = portable_verify.verify_packaged_mp3s(stage, repo_root=REPO_ROOT)
            self.assertGreaterEqual(stats["mp3_192kbps_checked"], 9)
            self.assertGreaterEqual(stats["example_source_wav_compared"], 9)


if __name__ == "__main__":
    unittest.main()
