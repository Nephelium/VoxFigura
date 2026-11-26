"""SwiftF0 0.3.0 pitch extraction aligned to the 50 Hz (20 ms) WavLM frame grid."""
from __future__ import annotations

import importlib.util
import sys
from typing import Tuple

import numpy as np
import onnxruntime as ort

from .constants import (
    F0_MAX,
    F0_MIN,
    PTB_CORE_SRC,
    SAMPLE_RATE_16K,
    SWIFTF0_ONNX,
    WAVLM_HOP_SAMPLES,
)


def _load_swift_pitch():
    """Load `swift_pitch` directly from neural.py without importing `phonetic_core.acoustic` (which requires parselmouth)."""
    mod_name = "_ptb_acoustic_neural"
    cached = sys.modules.get(mod_name)
    if cached is not None:
        return cached.swift_pitch
    neural_path = PTB_CORE_SRC / "phonetic_core" / "acoustic" / "neural.py"
    spec = importlib.util.spec_from_file_location(mod_name, str(neural_path))
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load swift_pitch module from {neural_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    spec.loader.exec_module(module)
    return module.swift_pitch


swift_pitch = _load_swift_pitch()


class SwiftF0Extractor:
    """使用主仓库随带的 SwiftF0 0.3.0 ONNX 模型提取 50 Hz 对齐基频轨迹。"""

    def __init__(self, fmin: float = F0_MIN, fmax: float = F0_MAX) -> None:
        self.fmin = float(fmin)
        self.fmax = float(fmax)
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            str(SWIFTF0_ONNX),
            sess_options=opts,
            providers=["CPUExecutionProvider"],
        )

    def extract_50hz(
        self,
        wav_16k: np.ndarray,
        num_frames: int | None = None,
    ) -> Tuple[np.ndarray, np.ndarray]:
        """提取与 WavLM 50 Hz 网格对齐的 F0 (Hz) 和有声掩码。

        Args:
            wav_16k: 1D float32 单声道 16 kHz 波形
            num_frames: 期望输出帧数；默认 len(wav_16k) // 320

        Returns:
            f0_50hz: (T,) float32，有效区间线性插值、端点外推；全清音则默认 120.0 Hz，夹紧在 [F0_MIN, F0_MAX]
            voiced_50hz: (T,) bool，该 20 ms 帧是否检测到周期浊音
        """
        x = np.asarray(wav_16k, dtype=np.float32)
        if num_frames is None:
            num_frames = max(1, len(x) // WAVLM_HOP_SAMPLES)

        target_times = (np.arange(num_frames, dtype=np.float64) + 0.5) * 0.020
        pitch = swift_pitch(x, SAMPLE_RATE_16K, self.session, low=self.fmin, high=self.fmax)

        if len(pitch.times) == 0:
            return np.full(num_frames, 120.0, dtype=np.float32), np.zeros(num_frames, dtype=bool)

        valid = np.isfinite(pitch.values)
        if not valid.any():
            return np.full(num_frames, 120.0, dtype=np.float32), np.zeros(num_frames, dtype=bool)

        f0_interp = np.interp(target_times, pitch.times[valid], pitch.values[valid])
        f0_interp = np.clip(f0_interp, self.fmin, self.fmax).astype(np.float32)

        voiced_prob = np.interp(target_times, pitch.times, valid.astype(np.float64))
        voiced_mask = voiced_prob >= 0.5
        return f0_interp, voiced_mask
