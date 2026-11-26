"""R21 (65-section, JD2 + Geometric glottis 2025) VTL forward synthesizer wrapper."""
from __future__ import annotations

from typing import Optional, Tuple

import numpy as np
from scipy.signal import resample_poly

from .constants import (
    CONTROL_HZ_200,
    CONTROL_HZ_50,
    R21_STEP_SAMPLES_48K,
    SAMPLE_RATE_16K,
    SAMPLE_RATE_48K,
    VTL_NATIVE_DIR,
    ensure_ptb_core_on_path,
    m22_to_vtl19_glottis9,
)

ensure_ptb_core_on_path()
from phonetic_core.vocal_tract.engine import Engine  # noqa: E402


def interpolate_50hz_to_200hz(m22_50hz: np.ndarray) -> np.ndarray:
    """将 50 Hz (20 ms/帧) 的 22 维控制轨迹线性插值到 200 Hz (5 ms/步)。"""
    arr = np.asarray(m22_50hz, dtype=np.float64)
    if arr.ndim != 2 or arr.shape[1] != 22 or arr.shape[0] < 1:
        raise ValueError(f"期望形状 (T, 22)，收到 {arr.shape}")
    t_50_len = arr.shape[0]
    t_200_len = t_50_len * (CONTROL_HZ_200 // CONTROL_HZ_50)  # * 4
    if t_50_len == 1:
        return np.repeat(arr, t_200_len, axis=0)
    t_50 = (np.arange(t_50_len, dtype=np.float64) + 0.5) / CONTROL_HZ_50
    t_200 = (np.arange(t_200_len, dtype=np.float64) + 0.5) / CONTROL_HZ_200
    out = np.empty((t_200_len, 22), dtype=np.float64)
    for col in range(22):
        out[:, col] = np.interp(t_200, t_50, arr[:, col])
    return out


class R21Synthesizer:
    """单进程独占的 M10 R21 (JD2, 65截面) 正向合成器。"""

    def __init__(self, section_count: int = 65) -> None:
        self.engine = Engine("JD2", resource_dir=VTL_NATIVE_DIR)
        self.engine.set_section_count(section_count)
        self.engine.set_manual_root(False)
        self.engine.configure_perturbation({"jitter": 0.0, "shimmer": 0.0, "seed": 1})
        if self.engine.sr != SAMPLE_RATE_48K:
            raise RuntimeError(f"意外的 VTL 采样率 {self.engine.sr}，期望 {SAMPLE_RATE_48K}")

    def close(self) -> None:
        self.engine.close()

    def __enter__(self) -> "R21Synthesizer":
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.close()

    def synthesize_200hz(
        self,
        m22_200hz: np.ndarray,
        *,
        return_48k: bool = False,
    ) -> Optional[Tuple[Optional[np.ndarray], np.ndarray]]:
        """用 200 Hz (5 ms/步) 22 维控制轨迹合成 16 kHz（可选 48 kHz）波形。

        遇到非有限合成或原生求解错误时返回 None，便于批量生成器安全丢弃坏样本。
        """
        tract19_seq, glottis9_seq = m22_to_vtl19_glottis9(m22_200hz)
        glottis9_seq = np.clip(glottis9_seq, self.engine.gmin, self.engine.gmax)

        n_steps = tract19_seq.shape[0]
        chunks = []
        try:
            first_tube = self.engine.prepare_tube(tract19_seq[0])
            self.engine.reset_tube(first_tube, np.ascontiguousarray(glottis9_seq[0]))
            chunks.append(
                self.engine.block_tube(
                    first_tube,
                    np.ascontiguousarray(glottis9_seq[0]),
                    R21_STEP_SAMPLES_48K,
                )
            )
            for k in range(1, n_steps):
                tube = self.engine.prepare_tube(tract19_seq[k])
                chunks.append(
                    self.engine.block_tube(
                        tube,
                        np.ascontiguousarray(glottis9_seq[k]),
                        R21_STEP_SAMPLES_48K,
                    )
                )
        except (RuntimeError, ValueError):
            return None

        wav_48k = np.concatenate(chunks)
        if not np.isfinite(wav_48k).all():
            return None

        # 对极少数声管极端闭合数值爆表做硬阈值过滤
        peak = float(np.max(np.abs(wav_48k)))
        if peak > 10.0:
            return None

        wav_16k = resample_poly(wav_48k, 1, 3).astype(np.float32)
        if not np.isfinite(wav_16k).all():
            return None

        if return_48k:
            return wav_48k.astype(np.float32), wav_16k
        return None, wav_16k

    def synthesize_50hz(
        self,
        m22_50hz: np.ndarray,
        *,
        return_48k: bool = False,
    ) -> Optional[Tuple[Optional[np.ndarray], np.ndarray]]:
        """将 50 Hz (20 ms/帧) 控制轨迹插值到 200 Hz 并合成波形。"""
        m22_200hz = interpolate_50hz_to_200hz(m22_50hz)
        return self.synthesize_200hz(m22_200hz, return_48k=return_48k)
