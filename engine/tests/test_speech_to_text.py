"""Contract checks for the optional local transcription model."""
from __future__ import annotations

from hashlib import sha256
from importlib.util import find_spec
from io import BytesIO
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import wave

import numpy as np

ENGINE = Path(__file__).resolve().parents[1]
if str(ENGINE) not in sys.path:
    sys.path.insert(0, str(ENGINE))

from speech_to_text import OfflineTranscriber, TranscriptionError, _read_audio  # noqa: E402
import asr_install  # noqa: E402
import asr_models  # noqa: E402


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
        model.transcribe.return_value = (
            iter([SimpleNamespace(text=" Hello"), SimpleNamespace(text=" world.")]),
            SimpleNamespace(language="en"),
        )
        audio = np.ones(16000, dtype=np.float32)
        with patch("speech_to_text._check_runtime"), patch("speech_to_text._read_audio", return_value=audio):
            with patch.object(transcriber, "_load_model", return_value=model):
                result = transcriber.transcribe({"wav_base64": "AA=="})
        model.transcribe.assert_called_once_with(audio, language=None, task="transcribe", vad_filter=True)
        self.assertEqual(result, {
            "ok": True, "text": "Hello world.", "lang": "en", "model": "faster-whisper",
            "device_effective": "cpu", "duration_s": 1.0,
        })

    def test_explicit_selection_loads_the_requested_model(self) -> None:
        recognizer = OfflineTranscriber()
        model = Mock()
        model.transcribe.return_value = (iter([SimpleNamespace(text="你好")]), SimpleNamespace(language="zh"))
        with patch.dict("os.environ", {}, clear=True), patch("speech_to_text._check_runtime"), patch(
            "speech_to_text._read_audio", return_value=np.ones(16000, dtype=np.float32)
        ), patch.object(recognizer, "_load_model", return_value=model) as load:
            result = recognizer.transcribe({"wav_base64": "AA==", "lang": "zh", "model": "large-v3-turbo"})
        load.assert_called_once_with(asr_models.model_dir("large-v3-turbo"))
        self.assertEqual(result["text"], "你好")

    def test_installer_retries_bad_mirror_file_and_writes_selected_model(self) -> None:
        weights = b"test model"
        selected = "large-v3-turbo"
        files = {"model.bin": (len(weights), sha256(weights).hexdigest())}
        spec = asr_models.ModelFiles("test/faster-whisper", "pinned", files)

        def download(url, path, size, progress):
            path.write_bytes(b"bad mirror" if url.startswith(asr_install.HF_MIRROR) else weights)
            progress(size)

        with TemporaryDirectory() as folder, patch.object(asr_install, "CACHE", Path(folder)), patch.object(
            asr_models, "CACHE", Path(folder)
        ), patch.dict(asr_models.MODELS, {selected: spec}), patch.object(
            asr_install, "_download_sources", return_value=(asr_install.HF_MIRROR, asr_install.HUGGING_FACE)
        ), patch.object(asr_install, "_fetch_file", side_effect=download) as fetch:
            asr_install._setup_model(selected, Mock())
            self.assertEqual(fetch.call_count, 2)
            self.assertEqual((asr_models.model_dir(selected) / "model.bin").read_bytes(), weights)
            self.assertFalse(asr_models.model_dir("tiny").exists())

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
            model.transcribe.return_value = (iter([]), SimpleNamespace(language="zh"))
            with patch.object(transcriber, "_load_model", return_value=model):
                self.assert_error("no_speech", 400, transcriber.transcribe, payload)
            model.transcribe.assert_called_once_with(read.return_value, language="zh", task="transcribe", vad_filter=True)

    @unittest.skipUnless(find_spec("av"), "optional PyAV is unavailable")
    def test_local_wave_decode_is_bounded_and_rejects_external_playlist(self) -> None:
        def wav(sample_count: int) -> bytes:
            stream = BytesIO()
            with wave.open(stream, "wb") as writer:
                writer.setparams((1, 2, 16000, 0, "NONE", ""))
                writer.writeframes(b"\x00\x40" * sample_count)
            return stream.getvalue()

        decoded = _read_audio(wav(1600))
        self.assertEqual(decoded.shape, (1600,))
        self.assertEqual(float(decoded[0]), 0.5)
        self.assert_error("audio_too_short", 400, _read_audio, wav(1000))
        self.assert_error("audio_too_long", 400, _read_audio, wav(960001))
        self.assert_error("invalid_audio", 400, _read_audio, b"ffconcat version 1.0\nfile https://example.invalid/audio.mp3\n")

    @unittest.skipUnless(find_spec("av"), "optional PyAV is unavailable")
    def test_stereo_uses_only_left_channel(self) -> None:
        t = np.arange(16000) / 16000
        mic = 4000 * np.sin(2 * np.pi * 200 * t) + 5000 * np.sin(2 * np.pi * 1800 * t)
        egg = 8000 * np.sin(2 * np.pi * 150 * t)
        pcm = np.rint(np.column_stack([egg, mic])).astype("<i2")
        stream = BytesIO()
        with wave.open(stream, "wb") as writer:
            writer.setparams((2, 2, 16000, 0, "NONE", ""))
            writer.writeframes(pcm.tobytes())
        np.testing.assert_array_equal(_read_audio(stream.getvalue()), pcm[:, 0] / 32768.0)
