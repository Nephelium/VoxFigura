"""Local CPU pitch analysis for dialect recordings using hot-pluggable SwiftF0 ONNX."""
import threading

import numpy as np

from onnx_inference import extract_swift_f0_50hz
from validation import decode_base64_payload

_INFER_LOCK = threading.Lock()


def extract(payload):
    if not isinstance(payload, dict) or "pcm16le" not in payload:
        raise ValueError("缺少 pcm16le 音频数据")
    raw = decode_base64_payload(payload["pcm16le"], field="pcm16le", max_bytes=16000 * 2 * 120)
    if not 640 <= len(raw) <= 16000 * 2 * 120 or len(raw) % 2:
        raise ValueError("录音须为 20 毫秒至 120 秒的 16 kHz 单声道 PCM")
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
    with _INFER_LOCK:
        hz, voiced = extract_swift_f0_50hz(samples, fmin=46.875, fmax=2093.75)
    return {
        "model": "SwiftF0",
        "step_ms": 20,
        "duration": len(samples) / 16000,
        "hz": [round(float(v), 2) if on else None for v, on in zip(hz, voiced)],
    }
