"""Contract checks for the optional offline SenseVoice-Small ONNX recognizer."""
from __future__ import annotations

from hashlib import sha256
from io import BytesIO
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch
import wave

import numpy as np

ENGINE = Path(__file__).resolve().parents[1]
if str(ENGINE) not in sys.path:
    sys.path.insert(0, str(ENGINE))

import asr_install  # noqa: E402
import asr_models  # noqa: E402
from speech_to_text import (  # noqa: E402
    OfflineTranscriber,
    TranscriptionError,
    _apply_lfr,
    _clean_sensevoice_text,
    _extract_kaldi_fbank,
    _read_audio,
)


class OfflineTranscriberTest(unittest.TestCase):
    def assert_error(self, code: str, status: int, handler, *args) -> None:
        with self.assertRaises(TranscriptionError) as failure:
            handler(*args)
        self.assertEqual(failure.exception.status, status)
        self.assertEqual(failure.exception.result["error"]["code"], code)

    def test_validates_language_device_and_audio_before_loading(self) -> None:
        transcribe = OfflineTranscriber().transcribe
        with patch("speech_to_text._check_runtime") as runtime:
            self.assert_error("unsupported_language", 400, transcribe, {"lang": []})
            self.assert_error("unsupported_device", 400, transcribe, {"device": "cuda"})
            self.assert_error("unsupported_model", 400, transcribe, {"model": "../other"})
            self.assert_error("validation_error", 400, transcribe, {})
            self.assert_error("invalid_audio", 400, transcribe, {"wav_base64": "???"})
        runtime.assert_not_called()

    def test_missing_runtime_reports_unavailable(self) -> None:
        transcriber = OfflineTranscriber()
        with patch("speech_to_text.find_spec", return_value=None):
            self.assert_error("model_unavailable", 503, transcriber.transcribe, {"wav_base64": "AA=="})
            self.assertFalse(transcriber.status()["ready"])

    def test_auto_language_offline_model_and_transcript_contract(self) -> None:
        transcriber = OfflineTranscriber()
        model = Mock()
        model.transcribe.return_value = ("Hello world.", "en")
        audio = np.ones(16000, dtype=np.float32)
        with patch("speech_to_text._check_runtime"), patch("speech_to_text._read_audio", return_value=audio):
            with patch.object(transcriber, "_load_model", return_value=model):
                result = transcriber.transcribe({"wav_base64": "AA=="})
        model.transcribe.assert_called_once_with(audio, lang="auto")
        self.assertEqual(result, {
            "ok": True,
            "text": "Hello world.",
            "lang": "en",
            "model": "sensevoice-small",
            "device_effective": "cpu",
            "duration_s": 1.0,
        })

    def test_explicit_selection_loads_the_requested_model(self) -> None:
        recognizer = OfflineTranscriber()
        model = Mock()
        model.transcribe.return_value = ("你好世界", "zh")
        with patch.dict("os.environ", {}, clear=True), patch("speech_to_text._check_runtime"), patch(
            "speech_to_text._read_audio", return_value=np.ones(16000, dtype=np.float32)
        ), patch.object(recognizer, "_load_model", return_value=model) as load:
            result = recognizer.transcribe({"wav_base64": "AA==", "lang": "zh", "model": "sensevoice-small"})
        load.assert_called_once_with(asr_models.model_dir("sensevoice-small"))
        self.assertEqual(result["text"], "你好世界")

    def test_installer_retries_bad_mirror_file_and_writes_selected_model(self) -> None:
        weights = b"test onnx model"
        tokens = b"<unk> 0\n"
        selected = "sensevoice-small"
        files = {
            "tokens.txt": (len(tokens), sha256(tokens).hexdigest()),
            "model.int8.onnx": (len(weights), sha256(weights).hexdigest()),
        }
        spec = asr_models.ModelFiles("test/sensevoice", "pinned", "ms/sensevoice", files)

        def download(url, path, size, progress):
            if url.startswith(asr_install.HF_MIRROR):
                path.write_bytes(b"bad mirror")
            else:
                path.write_bytes(tokens if url.endswith("tokens.txt") else weights)
            progress(size)

        sources = (
            asr_install.DownloadSource("hf_mirror", "国内 HF 镜像", "hf", asr_install.HF_MIRROR),
            asr_install.DownloadSource("huggingface", "Hugging Face", "hf", asr_install.HUGGING_FACE),
        )
        reports: list[dict] = []
        with TemporaryDirectory() as folder, patch.dict("os.environ", {"VOCALCUT_ASR_CACHE_DIR": folder}), patch.dict(
            asr_models.MODELS, {selected: spec}
        ), patch.object(
            asr_install, "_download_sources", return_value=("cn", sources)
        ), patch.object(
            asr_install, "_fetch_file", side_effect=download
        ) as fetch:
            asr_install._setup_model(selected, reports.append)
            self.assertEqual(fetch.call_count, 3)  # 1 failed on mirror + 2 succeeded on HF
            self.assertEqual((asr_models.model_dir(selected) / "model.int8.onnx").read_bytes(), weights)
            self.assertEqual((asr_models.model_dir(selected) / "tokens.txt").read_bytes(), tokens)
            self.assertTrue(any(r.get("progress") == 100 for r in reports))

    def test_download_sources_order_by_region(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            with patch.object(asr_install, "_detect_region", return_value="cn"):
                region, sources = asr_install._download_sources()
                self.assertEqual(region, "cn")
                self.assertEqual([s.id for s in sources], ["hf_mirror", "modelscope", "huggingface"])
            with patch.object(asr_install, "_detect_region", return_value="global"):
                region, sources = asr_install._download_sources()
                self.assertEqual(region, "global")
                self.assertEqual([s.id for s in sources], ["huggingface", "hf_mirror", "modelscope"])

    def test_no_speech_or_busy_never_returns_partial_success(self) -> None:
        transcriber = OfflineTranscriber()
        payload = {"wav_base64": "AA==", "lang": "zh"}
        with patch("speech_to_text._check_runtime"), patch("speech_to_text._read_audio") as read:
            read.return_value = np.zeros(16000, dtype=np.float32)
            self.assert_error("no_speech", 400, transcriber.transcribe, payload)
            read.return_value = np.ones(16000, dtype=np.float32)
            with transcriber._lock:
                self.assert_error("asr_busy", 409, transcriber.transcribe, payload)
            model = Mock()
            model.transcribe.return_value = ("", "zh")
            with patch.object(transcriber, "_load_model", return_value=model):
                self.assert_error("no_speech", 400, transcriber.transcribe, payload)
            model.transcribe.assert_called_once_with(read.return_value, lang="zh")

    def test_fbank_lfr_and_ctc_text_cleaning(self) -> None:
        t = np.arange(16000, dtype=np.float32) / 16000.0
        sig = 0.25 * np.sin(2.0 * np.pi * 440.0 * t)
        fb = _extract_kaldi_fbank(sig, 16000)
        self.assertEqual(fb.shape[1], 80)
        lfr = _apply_lfr(fb, 7, 6)
        self.assertEqual(lfr.shape[1], 560)
        tokens = ["<unk>", "<|zh|>", "<|NEUTRAL|>", "<|Speech|>", "<|withitn|>", "▁你", "好", "▁world"]
        ids = np.asarray([1, 2, 3, 4, 5, 5, 0, 6, 0, 7, 7], dtype=np.int64)
        text, lang = _clean_sensevoice_text(tokens, ids)
        self.assertEqual(lang, "zh")
        self.assertEqual(text, "你好 world")

    def test_local_wave_decode_is_bounded_and_rejects_external_playlist(self) -> None:
        def wav(sample_count: int) -> bytes:
            stream = BytesIO()
            with wave.open(stream, "wb") as writer:
                writer.setparams((1, 2, 16000, 0, "NONE", ""))
                writer.writeframes(b"\x00\x40" * sample_count)
            return stream.getvalue()

        decoded = _read_audio(wav(1600))
        self.assertEqual(decoded.shape, (1600,))
        self.assertAlmostEqual(float(decoded[0]), 0.5, places=4)
        self.assert_error("audio_too_short", 400, _read_audio, wav(1000))
        self.assert_error("audio_too_long", 400, _read_audio, wav(960001))
        self.assert_error("invalid_audio", 400, _read_audio, b"ffconcat version 1.0\nfile https://example.invalid/audio.mp3\n")

    def test_stereo_uses_only_left_channel(self) -> None:
        t = np.arange(16000) / 16000.0
        left = (np.sin(2 * np.pi * 440 * t) * 16000).astype("<i2")
        right = (np.sin(2 * np.pi * 880 * t) * 16000).astype("<i2")
        interleaved = np.column_stack((left, right)).reshape(-1).tobytes()
        stream = BytesIO()
        with wave.open(stream, "wb") as writer:
            writer.setparams((2, 2, 16000, 0, "NONE", ""))
            writer.writeframes(interleaved)
        decoded = _read_audio(stream.getvalue())
        self.assertEqual(decoded.shape, (16000,))
        np.testing.assert_allclose(decoded, left.astype(np.float32) / 32768.0, atol=1e-4)


if __name__ == "__main__":
    unittest.main()
