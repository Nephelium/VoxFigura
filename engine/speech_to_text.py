"""Offline SenseVoice-Small ONNX transcription using existing onnxruntime + numpy."""
from __future__ import annotations

from importlib.util import find_spec
from io import BytesIO
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
from threading import Lock
from typing import Any

import numpy as np

from asr_models import DEFAULT_MODEL, MODELS, default_local_model, has_model_files, is_installed, model_dir
from m27_bridge import MAX_INPUT_DURATION_S, SAMPLE_RATE_16K, WAVLM_HOP_SAMPLES
from validation import decode_base64_payload, validation_error

SUPPORTED_LANGUAGES = ("auto", "zh", "en", "ja", "ko", "yue")
MAX_AUDIO_SAMPLES = int(MAX_INPUT_DURATION_S * SAMPLE_RATE_16K)
MIN_AUDIO_SAMPLES = 4 * WAVLM_HOP_SAMPLES
SETUP_HINT = "请点击界面中的「本地自动转文字」按钮一键下载 SenseVoice-Small 模型（约 228 MB）"

_SPECIAL_TAG_RE = re.compile(r"<\|[^|>]+\|>")
_LANG_TAG_RE = re.compile(r"<\|(zh|en|ja|ko|yue)\|>")
_MULTISPACE_RE = re.compile(r"\s+")
_CJK_SPACE_RE = re.compile(r"(?<=[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af])\s+(?=[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af])")

# Cached Kaldi 80-bin mel filterbank for 16 kHz / n_fft=512
_MEL_FILTERBANK_CACHE: np.ndarray | None = None
_HAMMING_WIN_CACHE: np.ndarray | None = None


class TranscriptionError(ValueError):
    def __init__(self, code: str, field: str, hint: str, status: int = 400) -> None:
        super().__init__(hint)
        self.status = status
        self.result = validation_error(field, hint, code)


def _model_dir(name: str | None) -> Path:
    configured = os.environ.get("VOCALCUT_ASR_MODEL_DIR", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return model_dir(name or default_local_model())


def _check_runtime(directory: Path) -> None:
    if find_spec("onnxruntime") is None or find_spec("numpy") is None:
        raise TranscriptionError("model_unavailable", "model", "本地 ONNX 推理运行库不可用", 503)
    if os.environ.get("VOCALCUT_ASR_MODEL_DIR", "").strip():
        if not has_model_files(directory):
            raise TranscriptionError(
                "model_unavailable",
                "model",
                "指定的 SenseVoice-Small 模型目录缺少 model.int8.onnx 或 tokens.txt",
                503,
            )
    elif not is_installed(directory.name):
        raise TranscriptionError("model_unavailable", "model", "本地 SenseVoice-Small 模型尚未下载。" + SETUP_HINT, 503)


def _find_ffmpeg() -> str | None:
    env_ff = os.environ.get("VOCALCUT_FFMPEG", "").strip()
    if env_ff and Path(env_ff).is_file():
        return env_ff
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg  # type: ignore[import-untyped]

        candidate = imageio_ffmpeg.get_ffmpeg_exe()
        if candidate and Path(candidate).is_file():
            return candidate
    except Exception:
        pass
    return None


def _resample_linear_or_poly(audio: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    if src_sr == dst_sr:
        return audio.astype(np.float32, copy=False)
    try:
        from scipy.signal import resample_poly

        g = math.gcd(int(src_sr), int(dst_sr))
        return resample_poly(audio, dst_sr // g, src_sr // g).astype(np.float32, copy=False)
    except Exception:
        ratio = dst_sr / float(src_sr)
        out_len = max(1, int(round(len(audio) * ratio)))
        x_old = np.linspace(0.0, 1.0, len(audio), endpoint=False)
        x_new = np.linspace(0.0, 1.0, out_len, endpoint=False)
        return np.interp(x_new, x_old, audio).astype(np.float32)


def _read_audio_ffmpeg(content: bytes) -> np.ndarray:
    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        raise TranscriptionError("invalid_audio", "wav_base64", "无法解码该音频格式，请转换为 WAV/FLAC 后重试")
    cmd = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "pipe",
        "-i",
        "pipe:0",
        "-vn",
        "-sn",
        "-dn",
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE_16K),
        "-f",
        "f32le",
        "-t",
        str(MAX_INPUT_DURATION_S + 0.5),
        "pipe:1",
    ]
    # Note: remove -nostdin because we feed audio via pipe:0
    cmd.remove("-nostdin")
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.run(
            cmd,
            input=content,
            capture_output=True,
            timeout=30,
            creationflags=creationflags,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise TranscriptionError("invalid_audio", "wav_base64", "音频解码超时或失败，请检查录音文件") from error
    if proc.returncode != 0 or not proc.stdout:
        raise TranscriptionError("invalid_audio", "wav_base64", "无法解码音频，请重新导入受支持的录音文件")
    audio = np.frombuffer(proc.stdout, dtype="<f4").copy()
    if audio.size > MAX_AUDIO_SAMPLES:
        raise TranscriptionError("audio_too_long", "wav_base64", "单次识别最多 60 秒录音，请分段处理")
    if audio.size < MIN_AUDIO_SAMPLES:
        raise TranscriptionError("audio_too_short", "wav_base64", "录音至少需要 80 毫秒")
    return audio


def _read_audio(content: bytes) -> np.ndarray:
    if not content:
        raise TranscriptionError("invalid_audio", "wav_base64", "录音内容为空")
    # Reject ffconcat / playlist text payloads upfront
    head = content[:64].lstrip()
    if head.startswith(b"ffconcat") or head.startswith(b"#EXTM3U"):
        raise TranscriptionError("invalid_audio", "wav_base64", "不支持外部播放列表文件")

    if find_spec("soundfile") is not None:
        import soundfile as sf

        try:
            with sf.SoundFile(BytesIO(content)) as sf_file:
                sr = int(sf_file.samplerate)
                if sr <= 0 or sf_file.channels <= 0:
                    raise TranscriptionError("invalid_audio", "wav_base64", "导入文件缺少有效音轨")
                max_src_frames = int(math.ceil((MAX_INPUT_DURATION_S + 0.05) * sr))
                data = sf_file.read(frames=max_src_frames + 1, dtype="float32", always_2d=True)
                if len(data) == 0:
                    raise TranscriptionError("audio_too_short", "wav_base64", "录音至少需要 80 毫秒")
                mono = data[:, 0]
                if sr == SAMPLE_RATE_16K:
                    if len(mono) > MAX_AUDIO_SAMPLES:
                        raise TranscriptionError("audio_too_long", "wav_base64", "单次识别最多 60 秒录音，请分段处理")
                    audio = mono.astype(np.float32, copy=False)
                else:
                    if len(mono) / float(sr) > MAX_INPUT_DURATION_S + 1e-6:
                        raise TranscriptionError("audio_too_long", "wav_base64", "单次识别最多 60 秒录音，请分段处理")
                    audio = _resample_linear_or_poly(mono, sr, SAMPLE_RATE_16K)
                if audio.size > MAX_AUDIO_SAMPLES:
                    raise TranscriptionError("audio_too_long", "wav_base64", "单次识别最多 60 秒录音，请分段处理")
                if audio.size < MIN_AUDIO_SAMPLES:
                    raise TranscriptionError("audio_too_short", "wav_base64", "录音至少需要 80 毫秒")
                return audio
        except TranscriptionError:
            raise
        except Exception:
            pass

    return _read_audio_ffmpeg(content)


def _hz_to_mel_kaldi(freq: np.ndarray | float) -> np.ndarray | float:
    return 1127.0 * np.log(1.0 + np.asarray(freq, dtype=np.float64) / 700.0)


def _kaldi_mel_filterbank(
    sample_rate: int = 16000,
    n_fft: int = 512,
    num_bins: int = 80,
    low_freq: float = 20.0,
    high_freq: float = 8000.0,
) -> np.ndarray:
    global _MEL_FILTERBANK_CACHE
    if _MEL_FILTERBANK_CACHE is not None:
        return _MEL_FILTERBANK_CACHE

    num_fft_bins = n_fft // 2
    fft_bin_width = sample_rate / float(n_fft)
    mel_low = float(_hz_to_mel_kaldi(low_freq))
    mel_high = float(_hz_to_mel_kaldi(high_freq))
    mel_delta = (mel_high - mel_low) / float(num_bins + 1)

    bins = np.zeros((num_bins, num_fft_bins + 1), dtype=np.float32)
    freqs = np.arange(num_fft_bins + 1, dtype=np.float64) * fft_bin_width
    mels = _hz_to_mel_kaldi(freqs)

    for b in range(num_bins):
        left = mel_low + b * mel_delta
        center = mel_low + (b + 1) * mel_delta
        right = mel_low + (b + 2) * mel_delta
        up = (mels - left) / (center - left)
        down = (right - mels) / (right - center)
        bins[b] = np.maximum(0.0, np.minimum(up, down)).astype(np.float32)

    _MEL_FILTERBANK_CACHE = bins
    return bins


def _extract_kaldi_fbank(waveform: np.ndarray, sample_rate: int = 16000) -> np.ndarray:
    """Compute 80-dim Kaldi-compatible log mel filterbank features (snip_edges=True)."""
    global _HAMMING_WIN_CACHE
    frame_length = int(round(0.025 * sample_rate))  # 400
    frame_shift = int(round(0.010 * sample_rate))   # 160
    n_fft = 512

    # Scale float [-1, 1] waveform to 16-bit PCM range as expected by FunASR / kaldi-native-fbank
    sig = waveform.astype(np.float32, copy=False) * 32768.0
    if sig.size < frame_length:
        sig = np.pad(sig, (0, frame_length - sig.size), mode="constant")

    num_frames = 1 + (sig.size - frame_length) // frame_shift
    strides = (sig.strides[0] * frame_shift, sig.strides[0])
    frames = np.lib.stride_tricks.as_strided(sig, shape=(num_frames, frame_length), strides=strides).copy()

    # Remove DC offset per frame
    frames -= frames.mean(axis=1, keepdims=True)
    # Pre-emphasis (0.97)
    frames[:, 1:] = frames[:, 1:] - 0.97 * frames[:, :-1]
    frames[:, 0] *= 1.0 - 0.97

    if _HAMMING_WIN_CACHE is None:
        _HAMMING_WIN_CACHE = np.hamming(frame_length).astype(np.float32)
    frames *= _HAMMING_WIN_CACHE

    spec = np.fft.rfft(frames, n=n_fft, axis=1)
    power = (spec.real ** 2 + spec.imag ** 2).astype(np.float32)
    mel_fb = _kaldi_mel_filterbank(sample_rate=sample_rate, n_fft=n_fft, num_bins=80)
    mel_energy = np.matmul(power, mel_fb.T)
    return np.log(np.maximum(mel_energy, 1e-10)).astype(np.float32)


def _apply_lfr(feats: np.ndarray, lfr_m: int = 7, lfr_n: int = 6) -> np.ndarray:
    t, d = feats.shape
    t_lfr = int(math.ceil(t / float(lfr_n)))
    left_pad = np.repeat(feats[:1], (lfr_m - 1) // 2, axis=0)
    padded = np.vstack([left_pad, feats])
    t_pad = padded.shape[0]
    out = np.empty((t_lfr, d * lfr_m), dtype=np.float32)
    for i in range(t_lfr):
        start = i * lfr_n
        end = start + lfr_m
        if end <= t_pad:
            chunk = padded[start:end]
        else:
            tail = padded[start:]
            pad_cnt = lfr_m - tail.shape[0]
            chunk = np.vstack([tail, np.repeat(padded[-1:], pad_cnt, axis=0)])
        out[i] = chunk.reshape(-1)
    return out


def _parse_float_meta(meta: dict[str, str], key: str) -> np.ndarray | None:
    raw = meta.get(key)
    if not raw:
        return None
    parts = [p for p in raw.replace(",", " ").split() if p]
    return np.asarray([float(x) for x in parts], dtype=np.float32)


def _clean_sensevoice_text(tokens: list[str], raw_ids: np.ndarray) -> tuple[str, str]:
    detected_lang = "zh"
    # First 4 positions carry language / emotion / event / ITN prompt tokens
    for tid in raw_ids[:4]:
        idx = int(tid)
        if 0 <= idx < len(tokens):
            match = _LANG_TAG_RE.search(tokens[idx])
            if match:
                detected_lang = match.group(1)
                break

    # CTC greedy collapse on frames after the 4 prompt tokens (or all frames if shorter)
    body = raw_ids[4:] if len(raw_ids) > 4 else raw_ids
    pieces: list[str] = []
    prev = -1
    for tid in body:
        idx = int(tid)
        if idx == prev:
            continue
        prev = idx
        if idx == 0 or idx >= len(tokens):
            continue
        tok = tokens[idx]
        if tok in ("<unk>", "<s>", "</s>", "<blk>"):
            continue
        pieces.append(tok)

    raw_text = "".join(pieces)
    text = _SPECIAL_TAG_RE.sub("", raw_text)
    text = text.replace("\u2581", " ")
    text = _MULTISPACE_RE.sub(" ", text).strip()
    text = _CJK_SPACE_RE.sub("", text)
    return text, detected_lang


class _SenseVoiceSession:
    def __init__(self, directory: Path) -> None:
        import onnxruntime as ort

        model_path = directory / "model.int8.onnx"
        tokens_path = directory / "tokens.txt"
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = max(1, min(4, os.cpu_count() or 4))
        opts.inter_op_num_threads = 1
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(str(model_path), sess_options=opts, providers=["CPUExecutionProvider"])

        meta = self.session.get_modelmeta().custom_metadata_map or {}
        self.lfr_m = int(meta.get("lfr_window_size", "7"))
        self.lfr_n = int(meta.get("lfr_window_shift", "6"))
        self.neg_mean = _parse_float_meta(meta, "neg_mean")
        self.inv_stddev = _parse_float_meta(meta, "inv_stddev")
        self.lang_ids = {
            "auto": int(meta.get("lang_auto", "0")),
            "zh": int(meta.get("lang_zh", "3")),
            "en": int(meta.get("lang_en", "4")),
            "yue": int(meta.get("lang_yue", "7")),
            "ja": int(meta.get("lang_ja", "11")),
            "ko": int(meta.get("lang_ko", "12")),
        }
        self.with_itn = int(meta.get("with_itn", "14"))

        max_id = -1
        pairs: list[tuple[int, str]] = []
        for line in tokens_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.rsplit(" ", 1)
            if len(parts) != 2:
                continue
            token_str, id_str = parts[0], parts[1]
            idx = int(id_str)
            pairs.append((idx, token_str))
            if idx > max_id:
                max_id = idx
        vocab = [""] * (max_id + 1)
        for idx, token_str in pairs:
            vocab[idx] = token_str
        self.tokens = vocab

    def transcribe(self, audio: np.ndarray, lang: str = "auto") -> tuple[str, str]:
        fbank = _extract_kaldi_fbank(audio, SAMPLE_RATE_16K)
        feats = _apply_lfr(fbank, self.lfr_m, self.lfr_n)
        if self.neg_mean is not None and self.inv_stddev is not None:
            feats = (feats + self.neg_mean) * self.inv_stddev
        x = feats[np.newaxis, :, :].astype(np.float32, copy=False)
        x_length = np.asarray([feats.shape[0]], dtype=np.int32)
        lang_id = self.lang_ids.get(lang, self.lang_ids["auto"])
        language = np.asarray([lang_id], dtype=np.int32)
        text_norm = np.asarray([self.with_itn], dtype=np.int32)

        logits = self.session.run(
            None,
            {
                "x": x,
                "x_length": x_length,
                "language": language,
                "text_norm": text_norm,
            },
        )[0]
        pred_ids = np.argmax(logits[0], axis=-1)
        text, detected = _clean_sensevoice_text(self.tokens, pred_ids)
        final_lang = detected if lang == "auto" else lang
        return text, final_lang


class OfflineTranscriber:
    def __init__(self) -> None:
        self._lock = Lock()
        self._model: _SenseVoiceSession | None = None
        self._loaded_model_dir: Path | None = None

    def unload(self) -> None:
        with self._lock:
            self._model = None
            self._loaded_model_dir = None

    def status(self, name: str | None = None) -> dict[str, Any]:
        selected = name or default_local_model()
        result = {"model": selected, "device": "cpu"}
        directory = _model_dir(selected)
        try:
            _check_runtime(directory)
        except TranscriptionError as error:
            return {**result, "ready": False, "hint": str(error)}
        return {**result, "ready": True, "loaded": self._loaded_model_dir == directory}

    def _load_model(self, directory: Path) -> _SenseVoiceSession:
        if self._model is None or self._loaded_model_dir != directory:
            self._model = None
            self._loaded_model_dir = None
            self._model = _SenseVoiceSession(directory)
            self._loaded_model_dir = directory
        return self._model

    def transcribe(self, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise TranscriptionError("validation_error", "payload", "请传入 JSON 对象")

        lang = payload.get("lang", "auto")
        if not isinstance(lang, str) or lang not in SUPPORTED_LANGUAGES:
            raise TranscriptionError("unsupported_language", "lang", "本地语音识别支持 auto/zh/en/ja/ko/yue")

        device = payload.get("device", "cpu")
        if device != "cpu":
            raise TranscriptionError("unsupported_device", "device", "本地语音识别仅支持 cpu 推理")

        requested_model = payload.get("model")
        if requested_model is None or requested_model == "":
            selected_model = default_local_model()
        elif isinstance(requested_model, str) and requested_model in MODELS:
            selected_model = requested_model
        else:
            raise TranscriptionError("unsupported_model", "model", f"不支持的本地语音识别模型：{requested_model}")

        wav_b64 = payload.get("wav_base64")
        if not isinstance(wav_b64, str) or not wav_b64.strip():
            raise TranscriptionError("validation_error", "wav_base64", "请提供 base64 编码的音频数据")

        try:
            raw_bytes = decode_base64_payload(wav_b64, "wav_base64")
        except ValueError as error:
            raise TranscriptionError("invalid_audio", "wav_base64", str(error)) from error

        directory = _model_dir(selected_model)
        _check_runtime(directory)
        audio = _read_audio(raw_bytes)
        if float(np.max(np.abs(audio))) < 1e-5:
            raise TranscriptionError("no_speech", "wav_base64", "录音几乎静音，未检测到可识别语音")

        if not self._lock.acquire(blocking=False):
            raise TranscriptionError("asr_busy", "model", "正在识别另一段录音，请稍候重试", 409)
        try:
            session = self._load_model(directory)
            text, detected_lang = session.transcribe(audio, lang=lang)
        finally:
            self._lock.release()

        if not text:
            raise TranscriptionError("no_speech", "wav_base64", "未检测到清晰语音，请尝试提高音量或缩短静音段")

        return {
            "ok": True,
            "text": text,
            "lang": detected_lang,
            "model": selected_model,
            "device_effective": "cpu",
            "duration_s": round(float(audio.size) / float(SAMPLE_RATE_16K), 3),
        }
