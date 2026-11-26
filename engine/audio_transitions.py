"""Click-free boundaries for freshly generated engine audio."""
from __future__ import annotations

from functools import lru_cache
import numpy as np
from scipy.signal import butter, sosfilt

@lru_cache(maxsize=2)
def _high_pass(sample_rate: int):
    return butter(2, 26, btype="highpass", fs=sample_rate, output="sos")


def finish_synthesis(audio: np.ndarray, pressure_pa: np.ndarray, step_samples: int, sample_count: int,
                     sample_rate: int = 48000) -> np.ndarray:
    signal = np.asarray(audio, dtype=np.float64).reshape(-1)[:sample_count].copy()
    if len(signal) != sample_count or not np.isfinite(signal).all():
        raise ValueError("合成器返回的采样长度或数值无效")
    signal = sosfilt(_high_pass(sample_rate), signal)
    # A vocoder can emit residual noise during zero-pressure frames. Use the
    # original control clock to keep rests and preserve exact edit boundaries.
    edges = np.flatnonzero(np.diff(np.r_[0, np.asarray(pressure_pa) > 0, 0])).astype(np.int64)
    last_end = 0
    for begin, end in edges.reshape(-1, 2) * step_samples:
        begin, end = min(begin, sample_count), min(end, sample_count)
        signal[last_end:begin] = 0
        width = min(round(sample_rate*.005), (end - begin) // 4)
        if width:
            ramp = np.sin(np.linspace(0, np.pi / 2, width)) ** 2
            signal[begin:begin + width] *= ramp
            signal[end - width:end] *= ramp[::-1]
        last_end = end
    signal[last_end:] = 0
    return signal
