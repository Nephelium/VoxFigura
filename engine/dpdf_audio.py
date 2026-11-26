"""DPDFNet CPU inference via the unified hot-plug ONNX model registry."""
import io
import threading

import numpy as np
import soundfile as sf

from dense_channel import apply_synthesis_gain
from onnx_inference import denoise_channel_dpdfnet

_lock = threading.Lock()


def denoise(raw, *, audio_gain: str | None = "peak"):
    source, rate = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    if not len(source):
        raise ValueError("音频没有采样")
    with _lock:
        clean = np.column_stack([denoise_channel_dpdfnet(channel, rate) for channel in source.T])
    clean = apply_synthesis_gain(clean, audio_gain)
    output = io.BytesIO()
    sf.write(output, clean, rate, format="WAV", subtype="PCM_16")
    return output.getvalue()
