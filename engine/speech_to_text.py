"""Offline Mandarin and English transcription for the reconstruction workbench."""
from __future__ import annotations

from importlib.util import find_spec
from io import BytesIO
import os
from pathlib import Path
from threading import Lock
from typing import Any

import numpy as np

from asr_install import add_runtime_path
from asr_models import LEGACY_MODEL, MODELS, default_local_model, has_model_files, is_installed, model_dir
from m27_bridge import MAX_INPUT_DURATION_S, SAMPLE_RATE_16K, WAVLM_HOP_SAMPLES
from validation import decode_base64_payload, validation_error


add_runtime_path()

SUPPORTED_LANGUAGES = ("auto", "zh", "en")
MAX_AUDIO_SAMPLES = int(MAX_INPUT_DURATION_S * SAMPLE_RATE_16K)
MIN_AUDIO_SAMPLES = 4 * WAVLM_HOP_SAMPLES
MEDIA_OPTIONS = {
    "format_whitelist": "aac,aiff,flac,matroska,webm,mov,mp3,ogg,wav,w64",
    "protocol_whitelist": "pipe",
}
SETUP_HINT = "请在声道重建中下载 Whisper，或运行 npm run setup:asr"


class TranscriptionError(ValueError):
    def __init__(self, code: str, field: str, hint: str, status: int = 400) -> None:
        super().__init__(hint)
        self.status = status
        self.result = validation_error(field, hint, code)


def _model_dir(name: str | None) -> Path:
    configured = os.environ.get("VOCALCUT_ASR_MODEL_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return model_dir(name or default_local_model())


def _check_runtime(model_dir: Path) -> None:
    add_runtime_path()
    modules = ("faster_whisper", "ctranslate2", "av", "onnxruntime", "huggingface_hub", "tokenizers", "tqdm", "yaml")
    if any(find_spec(name) is None for name in modules):
        raise TranscriptionError("model_unavailable", "model", "本地语音识别依赖缺失。" + SETUP_HINT, 503)
    if os.environ.get("VOCALCUT_ASR_MODEL_DIR"):
        if not has_model_files(model_dir):
            raise TranscriptionError("model_unavailable", "model", "指定的 Whisper 模型目录缺少完整权重，请检查 VOCALCUT_ASR_MODEL_DIR", 503)
    elif not is_installed(model_dir.name.removeprefix("faster-whisper-")):
        raise TranscriptionError("model_unavailable", "model", "本地多语言 Whisper 权重缺失。" + SETUP_HINT, 503)


def _reject_external_media(*_: object) -> None:
    raise OSError("External media references are disabled")


def _read_audio(content: bytes) -> np.ndarray:
    import av

    chunks: list[np.ndarray] = []
    count = 0
    resampler: av.AudioResampler | None = None

    def append_resampled(frame: Any) -> None:
        nonlocal count
        assert resampler is not None
        for output in resampler.resample(frame):
            count += output.samples
            if count > MAX_AUDIO_SAMPLES:
                raise TranscriptionError("audio_too_long", "wav_base64", "单次识别最多 60 秒录音，请分段处理")
            chunks.append(output.to_ndarray())

    try:
        with av.open(BytesIO(content), mode="r", options=MEDIA_OPTIONS, io_open=_reject_external_media) as media:
            if not media.streams.audio:
                raise TranscriptionError("invalid_audio", "wav_base64", "导入文件缺少音轨")
            for frame in media.decode(audio=0):
                if resampler is None:
                    layout = "stereo" if len(frame.layout.channels) == 2 else "mono"
                    resampler = av.AudioResampler(format="s16p", layout=layout, rate=SAMPLE_RATE_16K)
                frame.pts = None
                append_resampled(frame)
            if resampler is not None:
                append_resampled(None)
    except TranscriptionError:
        raise
    except (av.error.FFmpegError, ValueError, OSError) as error:
        raise TranscriptionError("invalid_audio", "wav_base64", "无法解码音频，请重新导入受支持的录音文件") from error

    if count < MIN_AUDIO_SAMPLES:
        raise TranscriptionError("audio_too_short", "wav_base64", "录音至少需要 80 毫秒")
    return np.concatenate(chunks, axis=1)[0].astype(np.float32) / 32768.0


class OfflineTranscriber:
    def __init__(self) -> None:
        self._lock = Lock()
        self._model: Any = None
        self._loaded_model_dir: Path | None = None

    def status(self, name: str | None = None) -> dict[str, Any]:
        result = {"model": "faster-whisper", "device": "cpu"}
        directory = _model_dir(name)
        try:
            _check_runtime(directory)
        except TranscriptionError as error:
            return {**result, "ready": False, "hint": str(error)}
        return {**result, "ready": True, "loaded": self._loaded_model_dir == directory}

    def _load_model(self, model_dir: Path) -> Any:
        if self._model is None or self._loaded_model_dir != model_dir:
            from faster_whisper import WhisperModel

            self._model = None
            self._loaded_model_dir = None
            model = WhisperModel(str(model_dir), device="cpu", compute_type="int8", cpu_threads=4, local_files_only=True)
            if not model.model.is_multilingual:
                raise TranscriptionError("model_unavailable", "model", "请配置同时支持普通话和英语的 Whisper 权重", 503)
            self._model = model
            self._loaded_model_dir = model_dir
        return self._model

    def transcribe(self, payload: dict[str, Any]) -> dict[str, Any]:
        lang = payload.get("lang", "auto")
        if lang not in SUPPORTED_LANGUAGES:
            raise TranscriptionError("unsupported_language", "lang", "识别语言应为 auto、zh 或 en")
        if payload.get("device", "cpu") != "cpu":
            raise TranscriptionError("unsupported_device", "device", "本地语音识别使用 CPU，请指定 cpu")
        name = payload.get("model")
        if name is not None and (not isinstance(name, str) or name not in (*MODELS, LEGACY_MODEL)):
            raise TranscriptionError("unsupported_model", "model", "请选择可用的本地 Whisper 模型")
        encoded = payload.get("wav_base64")
        if not isinstance(encoded, str) or not encoded.strip():
            raise TranscriptionError("validation_error", "wav_base64", "请提供待识别的音频")
        try:
            content = decode_base64_payload(encoded)
        except ValueError as error:
            raise TranscriptionError("invalid_audio", "wav_base64", str(error)) from error

        model_dir = _model_dir(name)
        _check_runtime(model_dir)
        try:
            audio = _read_audio(content)
        except (ImportError, OSError) as error:
            raise TranscriptionError("model_unavailable", "model", "本地音频解码依赖无法加载。" + SETUP_HINT, 503) from error
        if not np.any(audio):
            raise TranscriptionError("no_speech", "wav_base64", "录音中未检测到可识别的语音")

        if not self._lock.acquire(blocking=False):
            raise TranscriptionError("asr_busy", "model", "本地识别正在处理另一段录音，请稍后重试", 409)
        try:
            try:
                model = self._load_model(model_dir)
            except TranscriptionError:
                raise
            except (ImportError, OSError, RuntimeError, ValueError) as error:
                raise TranscriptionError("model_unavailable", "model", "本地 Whisper 模型无法加载。" + SETUP_HINT, 503) from error

            try:
                segments, info = model.transcribe(
                    audio, language=None if lang == "auto" else lang, task="transcribe", vad_filter=True,
                )
                text = "".join(segment.text for segment in segments).strip()
            except (RuntimeError, ValueError) as error:
                raise TranscriptionError("asr_failed", "wav_base64", "本地 Whisper 转写失败，请尝试缩短片段", 503) from error
        finally:
            self._lock.release()

        if not text:
            raise TranscriptionError("no_speech", "wav_base64", "录音中未检测到可识别的语音")
        if info.language not in ("zh", "en"):
            raise TranscriptionError("unsupported_language", "lang", "检测到其他语种，可手动选择普通话或英语后重试")
        if len(text) > 4000:
            raise TranscriptionError("transcript_too_long", "text", "转写文本超过 4000 字符，请分段识别")
        return {
            "ok": True, "text": text, "lang": info.language, "model": "faster-whisper",
            "device_effective": "cpu", "duration_s": len(audio) / SAMPLE_RATE_16K,
        }
