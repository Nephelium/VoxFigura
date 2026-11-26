"""Comprehensive tests for pure-ONNX runtime, hot-plug load/unload, and external ONNX mounting.

Run: python -B -m unittest discover -s engine/tests
"""
from __future__ import annotations

import base64
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

import model_registry_runtime as reg  # noqa: E402
from model_registry_runtime import (  # noqa: E402
    LOCAL_MODEL_MANAGER,
    MODEL_SLOTS,
    LocalModelManager,
    ModelContractError,
    ModelUnloadedError,
    TT3_ROOT,
)
import onnx_inference as oinf  # noqa: E402
import chunked_synthesis  # noqa: E402
import dpdf_audio  # noqa: E402
import swift_pitch  # noqa: E402
from prosody_bridge import ProsodyBridge  # noqa: E402


def _make_sine_wav(sr: int = 16000, seconds: float = 0.6, f0: float = 160.0) -> np.ndarray:
    t = np.arange(int(round(sr * seconds)), dtype=np.float32) / float(sr)
    wav = 0.25 * np.sin(2.0 * np.pi * f0 * t) + 0.12 * np.sin(2.0 * np.pi * 2.0 * f0 * t)
    return wav.astype(np.float32)


class TestOnnxRuntimeAndHotPlug(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_01_zero_pytorch_imported_at_runtime(self) -> None:
        """Pure-ONNX modules must operate without ever importing torch."""
        self.assertNotIn("torch", sys.modules, "PyTorch must NOT be imported by the pure-ONNX runtime")

    def test_reconstruction_rests_at_factory_schwa_without_optional_alignment(self) -> None:
        factory_path = ENGINE_DIR.parent / "public" / "vocal-tract" / "factory" / "JD2" / "ipa.json"
        factory = json.loads(factory_path.read_text(encoding="utf-8"))
        params = next(pose["params"] for pose in factory["presets"] if pose["preset"] == "@jd2:ə")
        tract17 = params[:14] + params[16:]
        np.testing.assert_allclose(oinf.REST_M27_PHYS[:17], tract17, atol=1e-6)

        speech = _make_sine_wav(seconds=0.2)
        wav = np.concatenate((np.zeros(3200), speech, np.zeros(960), speech, np.zeros(3200))).astype(np.float32)
        is_enabled = LOCAL_MODEL_MANAGER.is_enabled
        with patch.object(LOCAL_MODEL_MANAGER, "is_enabled", side_effect=lambda name: name != "Vox2Align-Lite v2" and is_enabled(name)):
            masked, _ = oinf.analyze_waveform_onnx(wav, alignment_mode="none")
            raw, _ = oinf.analyze_waveform_onnx(wav, alignment_mode="none", apply_silence_mask=False)
        rest_rows = masked["m27_phys"][[0, -1]]
        np.testing.assert_allclose(rest_rows[:, :17], [tract17, tract17], atol=1e-6)
        np.testing.assert_array_equal(rest_rows[:, 18], [0, 0])
        np.testing.assert_array_equal(masked["m27_phys"][20:23], raw["m27_phys"][20:23])

    def test_02_all_9_models_smoke_inference(self) -> None:
        """Exercise real ONNX Runtime inference for all 9 bundled models."""
        manager = LocalModelManager(state_path=self.tmp_dir / "smoke-registry.json")
        self.enterContext(patch.object(oinf, "LOCAL_MODEL_MANAGER", manager))
        self.enterContext(patch.object(chunked_synthesis, "LOCAL_MODEL_MANAGER", manager))
        # 1. Tract2Area-Proxy
        area = oinf.predict_tract_area_cm2(np.zeros((1, 8, 17), dtype=np.float32))
        self.assertEqual(area.shape, (1, 8, 6))
        self.assertTrue(np.isfinite(area).all())

        # 2. IPA2Tract-Lite
        x_hat = oinf.predict_ipa2tract(
            np.zeros((1, 12, 111), dtype=np.float32),
            np.zeros((1, 12, 26), dtype=np.float32),
            alpha=0.8,
        )
        self.assertEqual(x_hat.shape, (1, 12, 26))
        self.assertTrue(np.isfinite(x_hat).all())

        # 3. Text2Prosody-Lite (via ProsodyBridge)
        prosody = ProsodyBridge().predict({"text": "你好 world", "lang": "auto", "base_f0": 150.0})
        self.assertTrue(prosody["ok"], prosody)
        self.assertGreater(len(prosody["keyframes"]), 0)
        self.assertGreater(len(prosody["f0_knots"]), 0)

        # 4. Vox2Spk-Lite
        wav_16k = _make_sine_wav(16000, 0.8, 150.0)
        spk, spk_dev = oinf.extract_speaker_embedding(wav_16k)
        self.assertEqual(spk.shape, (512,))
        self.assertEqual(spk_dev, "cpu")
        self.assertAlmostEqual(float(np.linalg.norm(spk)), 1.0, places=3)

        # 5. Tract2Vox-Lite
        m27_norm = np.zeros((1, 10, 27), dtype=np.float32)
        synth, _ = oinf.synthesize_tract2vox(m27_norm, spk)
        self.assertEqual(synth.shape, (10 * 320,))
        self.assertTrue(np.isfinite(synth).all())

        # 6. SwiftF0 (via swift_pitch.extract)
        pcm16 = np.clip(np.round(wav_16k * 32767.0), -32768, 32767).astype("<i2").tobytes()
        f0_out = swift_pitch.extract({"pcm16le": base64.b64encode(pcm16).decode("ascii")})
        self.assertEqual(f0_out["model"], "SwiftF0")
        voiced = [v for v in f0_out["hz"] if v is not None]
        self.assertGreater(len(voiced), 10)
        self.assertAlmostEqual(float(np.median(voiced)), 150.0, delta=15.0)

        # 7 & 8. Vox2Tract-Lite + Vox2Align-Lite v2
        analysis, _ = oinf.analyze_waveform_onnx(wav_16k, text="", lang="auto", alignment_mode="blind")
        self.assertTrue(analysis["ok"], analysis)
        m27_phys = np.asarray(analysis["m27_phys"], dtype=np.float32)
        self.assertEqual(m27_phys.ndim, 2)
        self.assertEqual(m27_phys.shape[1], 27)
        self.assertTrue(np.isfinite(m27_phys).all())

        # 9. DPDFNet (via dpdf_audio.denoise)
        wav_48k = _make_sine_wav(48000, 0.25, 220.0)
        buf = io.BytesIO()
        sf.write(buf, wav_48k, 48000, format="WAV", subtype="PCM_16")
        clean_wav_bytes = dpdf_audio.denoise(buf.getvalue(), audio_gain="original")
        clean_48k, sr_out = sf.read(io.BytesIO(clean_wav_bytes), dtype="float32")
        self.assertEqual(sr_out, 48000)
        self.assertEqual(clean_48k.shape, wav_48k.shape)
        self.assertTrue(np.isfinite(clean_48k).all())

        # Verify zero PyTorch after running ALL 9 models!
        self.assertNotIn("torch", sys.modules, "PyTorch was unexpectedly imported during ONNX inference")

        # All 9 models should now report in_memory=True
        status = manager.list_status()
        self.assertEqual(status["in_memory_count"], 9)

    def test_03_hotplug_load_unload_and_error_handling(self) -> None:
        """Isolated LocalModelManager supports hot unload, ModelUnloadedError, and reload."""
        state_file = self.tmp_dir / "registry.json"
        mgr = LocalModelManager(state_path=state_file)

        # Load SwiftF0 eagerly
        st = mgr.load_model("SwiftF0")
        self.assertTrue(st["loaded"])
        self.assertTrue(st["in_memory"])

        # Unload SwiftF0 -> clears memory and refuses require_session
        st_off = mgr.unload_model("SwiftF0")
        self.assertFalse(st_off["loaded"])
        self.assertFalse(st_off["in_memory"])
        with self.assertRaises(ModelUnloadedError) as ctx:
            mgr.require_session("SwiftF0")
        self.assertEqual(ctx.exception.model_name, "SwiftF0")
        self.assertEqual(ctx.exception.code, "model_unloaded")

        # Persistence check: new instance reading same state_file sees SwiftF0 disabled
        mgr2 = LocalModelManager(state_path=state_file)
        self.assertFalse(mgr2.is_enabled("SwiftF0"))
        self.assertTrue(mgr2.is_enabled("DPDFNet"))

        # Reload SwiftF0 restores session
        st_on = mgr.load_model("SwiftF0")
        self.assertTrue(st_on["loaded"])
        self.assertTrue(st_on["in_memory"])

        # Unload all then load single
        all_off = mgr.unload_all()
        self.assertEqual(all_off["loaded_count"], 0)
        self.assertEqual(all_off["in_memory_count"], 0)
        mgr.load_model("Tract2Area-Proxy")
        self.assertEqual(mgr.list_status()["loaded_count"], 1)

    def test_04_external_mount_validation_folder_scan_and_reset(self) -> None:
        """External `.onnx` mount validates IO contracts, rejects mismatched graphs, and resets cleanly."""
        state_file = self.tmp_dir / "registry_ext.json"
        custom_dir = self.tmp_dir / "custom_models"
        ext_folder = self.tmp_dir / "third_party_models"
        ext_folder.mkdir(parents=True, exist_ok=True)

        # Copy two real builtin models into external folder with renamed filenames
        src_area = TT3_ROOT / "models/IPA2Tract-Lite/tract2area_proxy.onnx"
        src_f0 = TT3_ROOT / "ptb/resources/neural/swift-f0-0.3.0.onnx"
        dst_area = ext_folder / "custom_area_v2.onnx"
        dst_f0 = ext_folder / "partner_pitch.onnx"
        shutil.copy2(src_area, dst_area)
        shutil.copy2(src_f0, dst_f0)

        # Also place an invalid corrupt .onnx file in the folder
        bad_onnx = ext_folder / "broken_model.onnx"
        bad_onnx.write_bytes(b"NOT_A_VALID_ONNX_PROTOBUF" * 200)

        with patch.object(reg, "CUSTOM_MODELS_DIR", custom_dir):
            mgr = LocalModelManager(state_path=state_file)

            # 1. Wrong slot mount must raise ModelContractError and keep builtin intact
            with self.assertRaises(ModelContractError):
                mgr.mount_external_file("Vox2Tract-Lite", dst_f0)
            self.assertEqual(mgr.slot_status("Vox2Tract-Lite")["source"], "builtin")

            # 2. Valid single-file mount succeeds
            st = mgr.mount_external_file("Tract2Area-Proxy", dst_area, label="第三方面积代理")
            self.assertEqual(st["source"], "external")
            self.assertEqual(st["external_label"], "第三方面积代理")
            self.assertTrue(st["in_memory"])

            # 3. Binary auto-detect mount succeeds for SwiftF0 (even with non-matching filename!)
            st_auto = mgr.mount_external_bytes_auto("my_custom_weights.onnx", src_f0.read_bytes())
            self.assertEqual(st_auto["name"], "SwiftF0")
            self.assertEqual(st_auto["source"], "external")
            self.assertTrue(st_auto["in_memory"])

            # 4. Reset single model restores builtin
            st_reset = mgr.reset_model("SwiftF0")
            self.assertEqual(st_reset["source"], "builtin")
            self.assertIsNone(st_reset["external_label"])

            # 5. Folder scan auto-matches valid models and reports corrupt file in unmatched
            scan_res = mgr.scan_and_mount_folder(ext_folder, mount=True)
            self.assertTrue(scan_res["ok"])
            self.assertEqual(scan_res["mounted_count"], 2)
            matched_names = {item["name"] for item in scan_res["matched"]}
            self.assertEqual(matched_names, {"Tract2Area-Proxy", "SwiftF0"})
            self.assertEqual(len(scan_res["unmatched"]), 1)
            self.assertEqual(scan_res["unmatched"][0]["file"], "broken_model.onnx")

            # 6. Reset all clears external overrides
            all_reset = mgr.reset_all()
            self.assertEqual(all_reset["external_count"], 0)
            self.assertEqual(all_reset["loaded_count"], len(MODEL_SLOTS))

    def test_05_prosody_bridge_raises_model_unloaded_when_disabled(self) -> None:
        """Unloading Text2Prosody-Lite raises ModelUnloadedError cleanly through ProsodyBridge."""
        orig_state_path = LOCAL_MODEL_MANAGER._state_path
        LOCAL_MODEL_MANAGER._state_path = self.tmp_dir / "global_tmp_state.json"
        try:
            LOCAL_MODEL_MANAGER.unload_model("Text2Prosody-Lite")
            with self.assertRaises(ModelUnloadedError) as ctx:
                ProsodyBridge().predict({"text": "测试卸载", "lang": "zh", "base_f0": 140.0})
            self.assertEqual(ctx.exception.code, "model_unloaded")
            self.assertEqual(ctx.exception.model_name, "Text2Prosody-Lite")
        finally:
            LOCAL_MODEL_MANAGER.load_model("Text2Prosody-Lite")
            LOCAL_MODEL_MANAGER._state_path = orig_state_path


if __name__ == "__main__":
    unittest.main()
