"""Standalone 27-dim JD2 (17 supraglottal tract + F0 + PR + 8 glottis/shimmer) contract & normalization.

Zero dependency on external training repositories or PyTorch at import time (optional torch helper included).
"""
from __future__ import annotations

from typing import Tuple

import numpy as np

SAMPLE_RATE_48K = 48000
SAMPLE_RATE_16K = 16000
CONTROL_HZ_200 = 200
CONTROL_HZ_50 = 50
R21_STEP_SAMPLES_48K = 240  # 5 ms @ 48 kHz
HOP_SAMPLES_16K = 320       # 20 ms @ 16 kHz (50 Hz control grid)

SCHEMA_VERSION = "m27_native_v1"

# 17 independent supraglottal indices inside JD2's 19-dim vector (TRX=14, TRY=15 auto-computed)
TRACT_17_TO_19_IDX = np.array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18], dtype=np.int64)

M27_NAMES: Tuple[str, ...] = (
    # 0..16: 17 independent supraglottal tract dims
    "HX", "HY", "JX", "JA", "LP", "LD", "VS", "VO",
    "TCX", "TCY", "TTX", "TTY", "TBX", "TBY", "TS1", "TS2", "TS3",
    # 17..25: 9 native Geometric glottis 2025 dims
    "F0", "PR", "XB", "XT", "CA", "LAG", "RA", "PS", "FL",
    # 26: M10 dynamic source perturbation shimmer
    "SHIM",
)

M27_INDEX = {name: i for i, name in enumerate(M27_NAMES)}

# Exact native JD2.speaker bounds + shimmer [0, 100]
M27_MIN = np.array(
    [
        0.0, -6.0, -0.5, -7.0, -1.0, -2.0, 0.0, -0.1,
        -3.0, -3.0, 1.5, -3.0, -3.0, -3.0, 0.0, 0.0, -1.0,
        40.0, 0.0, -0.05, -0.05, -0.25, 0.0, -1.0, -1.0, 0.0,
        0.0,
    ],
    dtype=np.float32,
)

M27_MAX = np.array(
    [
        1.0, -3.5, 0.0, 0.0, 1.0, 4.0, 1.0, 1.5,
        4.0, 1.0, 7.5, 2.5, 6.5, 5.0, 1.0, 1.0, 1.0,
        600.0, 16000.0, 0.30, 0.30, 0.25, 3.1415, 1.0, 1.0, 100.0,
        100.0,
    ],
    dtype=np.float32,
)

TRACT_SLICE = slice(0, 17)
TRACT17_NAMES: Tuple[str, ...] = M27_NAMES[0:17]
F0_IDX = 17
PR_IDX = 18
GLOTTIS8_SLICE = slice(19, 27)
GLOTTIS8_NAMES: Tuple[str, ...] = M27_NAMES[19:27]

F0_MIN_M27 = float(M27_MIN[F0_IDX])       # 40.0 Hz
F0_MAX_M27 = float(M27_MAX[F0_IDX])       # 600.0 Hz
LOG_F0_MIN_M27 = float(np.log(F0_MIN_M27))
LOG_F0_MAX_M27 = float(np.log(F0_MAX_M27))

PR_MIN_M27 = float(M27_MIN[PR_IDX])       # 0.0 dPa
PR_MAX_M27 = float(M27_MAX[PR_IDX])       # 16000.0 dPa

DEFAULT_M27_PAD_ROW = np.array(
    [
        0.5, -4.75, -0.25, -3.5, 0.0, 0.5, 0.5, -0.1,
        0.0, -1.0, 4.0, -0.5, 1.5, 0.5, 0.5, 0.5, 0.0,
        120.0, 0.0, 0.12, 0.12, 0.05, 1.222044, 0.0, 0.5, 0.0, 0.0,
    ],
    dtype=np.float32,
)


def normalize_f0_m27(f0_hz: np.ndarray) -> np.ndarray:
    arr = np.clip(np.asarray(f0_hz, dtype=np.float32), F0_MIN_M27, F0_MAX_M27)
    return (2.0 * (np.log(arr) - LOG_F0_MIN_M27) / (LOG_F0_MAX_M27 - LOG_F0_MIN_M27) - 1.0).astype(np.float32)


def denormalize_f0_m27(f0_norm: np.ndarray) -> np.ndarray:
    arr = np.clip(np.asarray(f0_norm, dtype=np.float32), -1.0, 1.0)
    return np.exp(0.5 * (arr + 1.0) * (LOG_F0_MAX_M27 - LOG_F0_MIN_M27) + LOG_F0_MIN_M27).astype(np.float32)


def normalize_pr_m27(pr_dpa: np.ndarray) -> np.ndarray:
    arr = np.clip(np.asarray(pr_dpa, dtype=np.float32), PR_MIN_M27, PR_MAX_M27)
    return (2.0 * (arr - PR_MIN_M27) / (PR_MAX_M27 - PR_MIN_M27) - 1.0).astype(np.float32)


def denormalize_pr_m27(pr_norm: np.ndarray) -> np.ndarray:
    arr = np.clip(np.asarray(pr_norm, dtype=np.float32), -1.0, 1.0)
    return (0.5 * (arr + 1.0) * (PR_MAX_M27 - PR_MIN_M27) + PR_MIN_M27).astype(np.float32)


def normalize_m27(m27: np.ndarray) -> np.ndarray:
    """Normalize physical (..., 27) control array to [-1, 1], with log scaling on F0 (col 17)."""
    arr = np.clip(np.asarray(m27, dtype=np.float32), M27_MIN, M27_MAX)
    out = 2.0 * (arr - M27_MIN) / (M27_MAX - M27_MIN) - 1.0
    out[..., F0_IDX] = normalize_f0_m27(arr[..., F0_IDX])
    return out.astype(np.float32)


def denormalize_m27(m27_norm: np.ndarray) -> np.ndarray:
    """Restore [-1, 1] normalized (..., 27) controls back to native JD2 physical units."""
    arr = np.clip(np.asarray(m27_norm, dtype=np.float32), -1.0, 1.0)
    out = 0.5 * (arr + 1.0) * (M27_MAX - M27_MIN) + M27_MIN
    out[..., F0_IDX] = denormalize_f0_m27(arr[..., F0_IDX])
    return out.astype(np.float32)


def m27_to_tract19(m27_50hz: np.ndarray) -> np.ndarray:
    """Expand 27-dim M27 control trajectory (..., 27) into JD2 19-dim tract vector."""
    arr = np.asarray(m27_50hz, dtype=np.float64)
    tract17 = np.clip(arr[..., :17], M27_MIN[:17].astype(np.float64), M27_MAX[:17].astype(np.float64))
    tract19 = np.zeros(arr.shape[:-1] + (19,), dtype=np.float64)
    tract19[..., TRACT_17_TO_19_IDX] = tract17
    return tract19


def m27_to_vtl19_glottis9_shimmer(m27: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Split physical (..., 27) M27 into (tract19, glottis9, shimmer)."""
    arr = np.asarray(m27, dtype=np.float64)
    tract19 = m27_to_tract19(arr)
    glottis9 = np.clip(arr[..., 17:26], M27_MIN[17:26].astype(np.float64), M27_MAX[17:26].astype(np.float64))
    shimmer = np.clip(arr[..., 26], 0.0, 100.0)
    return tract19, glottis9, shimmer


__all__ = [
    "CONTROL_HZ_200",
    "CONTROL_HZ_50",
    "DEFAULT_M27_PAD_ROW",
    "F0_IDX",
    "F0_MAX_M27",
    "F0_MIN_M27",
    "GLOTTIS8_NAMES",
    "GLOTTIS8_SLICE",
    "HOP_SAMPLES_16K",
    "LOG_F0_MAX_M27",
    "LOG_F0_MIN_M27",
    "M27_INDEX",
    "M27_MAX",
    "M27_MIN",
    "M27_NAMES",
    "PR_IDX",
    "PR_MAX_M27",
    "PR_MIN_M27",
    "R21_STEP_SAMPLES_48K",
    "SAMPLE_RATE_16K",
    "SAMPLE_RATE_48K",
    "SCHEMA_VERSION",
    "TRACT17_NAMES",
    "TRACT_17_TO_19_IDX",
    "TRACT_SLICE",
    "denormalize_f0_m27",
    "denormalize_m27",
    "denormalize_pr_m27",
    "m27_to_tract19",
    "m27_to_vtl19_glottis9_shimmer",
    "normalize_f0_m27",
    "normalize_m27",
    "normalize_pr_m27",
]
