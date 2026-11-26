"""Playback loudness normalization helpers shared across inference, eval, and dashboard."""
from __future__ import annotations

import numpy as np


def normalize_playback(
    wav: np.ndarray,
    target_rms: float = 0.12,
    max_peak: float = 0.92,
) -> np.ndarray:
    """Remove DC offset and boost/attenuate audio to a comfortable RMS without clipping."""
    x = np.asarray(wav, dtype=np.float64)
    if x.size == 0:
        return np.zeros(0, dtype=np.float32)
    x = x - float(np.mean(x))
    peak = float(np.max(np.abs(x)))
    rms = float(np.sqrt(np.mean(x * x)))
    if peak > 1e-5 and rms > 1e-6:
        gain = min(target_rms / rms, max_peak / peak)
        x = np.clip(x * gain, -0.98, 0.98)
    return x.astype(np.float32)
