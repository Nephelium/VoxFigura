"""Full-native 27-dim JD2 (17 tract + 9 Geometric glottis 2025 + shimmer) contract & normalization."""
from __future__ import annotations

from typing import Tuple

import numpy as np
import torch

from .glottis27_generator import (
    M27_MAX as M27_MAX_F64,
    M27_MIN as M27_MIN_F64,
    M27_NAMES,
    SCHEMA_VERSION,
    TRACT_17_TO_19_IDX,
    promote_m22_to_m27,
)

M27_MIN = M27_MIN_F64.astype(np.float32)
M27_MAX = M27_MAX_F64.astype(np.float32)

TRACT_SLICE = slice(0, 17)
TRACT17_NAMES: Tuple[str, ...] = M27_NAMES[0:17]
F0_IDX = 17
PR_IDX = 18
GLOTTIS8_SLICE = slice(19, 27)
GLOTTIS8_NAMES: Tuple[str, ...] = M27_NAMES[19:27]  # XB, XT, CA, LAG, RA, PS, FL, SHIM

F0_MIN_M27 = float(M27_MIN[F0_IDX])       # 40.0 Hz
F0_MAX_M27 = float(M27_MAX[F0_IDX])       # 600.0 Hz
LOG_F0_MIN_M27 = float(np.log(F0_MIN_M27))
LOG_F0_MAX_M27 = float(np.log(F0_MAX_M27))

PR_MIN_M27 = float(M27_MIN[PR_IDX])       # 0.0 dPa
PR_MAX_M27 = float(M27_MAX[PR_IDX])       # 16000.0 dPa

# Safe silence padding row in physical units (prevents log(0) on F0)
DEFAULT_M27_PAD_ROW = np.array(
    [
        0.5, -4.75, -0.25, -3.5, 0.0, 0.5, 0.5, -0.1,
        0.0, -1.0, 4.0, -0.5, 1.5, 0.5, 0.5, 0.5, 0.0,
        120.0, 0.0, 0.12, 0.12, 0.05, 1.222044, 0.0, 0.5, 0.0, 0.0,
    ],
    dtype=np.float32,
)

# Selective per-dim weights for the 8 glottis/source motor outputs [XB, XT, CA, LAG, RA, PS, FL, SHIM]
NATIVE_GLOTTIS8_MASK = np.ones(8, dtype=np.float32)
# Legacy synth_100h froze XT=XB, LAG=1.222044, PS=0.5, FL=0, SHIM=0: mask those 5 dims to 0.0!
LEGACY_GLOTTIS8_MASK = np.array([0.25, 0.0, 0.25, 0.0, 0.25, 0.0, 0.0, 0.0], dtype=np.float32)


def normalize_f0_m27(f0_hz: np.ndarray) -> np.ndarray:
    """Affine log-F0 normalization anchored at 40 Hz -> -1.0 and 600 Hz -> +1.0 (unclamped > 0 Hz)."""
    arr = np.maximum(np.asarray(f0_hz, dtype=np.float32), np.float32(1e-3))
    return (2.0 * (np.log(arr) - LOG_F0_MIN_M27) / (LOG_F0_MAX_M27 - LOG_F0_MIN_M27) - 1.0).astype(np.float32)


def denormalize_f0_m27(f0_norm: np.ndarray) -> np.ndarray:
    """Inverse affine log-F0 mapping preserving unclamped wide F0 outside [-1, 1]."""
    arr = np.clip(np.asarray(f0_norm, dtype=np.float32), np.float32(-10.0), np.float32(10.0))
    return np.exp(0.5 * (arr + 1.0) * (LOG_F0_MAX_M27 - LOG_F0_MIN_M27) + LOG_F0_MIN_M27).astype(np.float32)


def normalize_pr_m27(pr_dpa: np.ndarray) -> np.ndarray:
    arr = np.clip(np.asarray(pr_dpa, dtype=np.float32), PR_MIN_M27, PR_MAX_M27)
    return (2.0 * (arr - PR_MIN_M27) / (PR_MAX_M27 - PR_MIN_M27) - 1.0).astype(np.float32)


def denormalize_pr_m27(pr_norm: np.ndarray) -> np.ndarray:
    arr = np.clip(np.asarray(pr_norm, dtype=np.float32), -1.0, 1.0)
    return (0.5 * (arr + 1.0) * (PR_MAX_M27 - PR_MIN_M27) + PR_MIN_M27).astype(np.float32)


def normalize_m27(m27: np.ndarray) -> np.ndarray:
    """Normalize physical (..., 27) control array to [-1, 1], with unclamped log scaling on F0 (col 17)."""
    raw = np.asarray(m27, dtype=np.float32)
    arr = np.clip(raw, M27_MIN, M27_MAX)
    out = 2.0 * (arr - M27_MIN) / (M27_MAX - M27_MIN) - 1.0
    out[..., F0_IDX] = normalize_f0_m27(raw[..., F0_IDX])
    return out.astype(np.float32)


def denormalize_m27(m27_norm: np.ndarray) -> np.ndarray:
    """Restore normalized (..., 27) controls back to physical units (unclamped F0 on col 17)."""
    raw = np.asarray(m27_norm, dtype=np.float32)
    arr = np.clip(raw, -1.0, 1.0)
    out = 0.5 * (arr + 1.0) * (M27_MAX - M27_MIN) + M27_MIN
    out[..., F0_IDX] = denormalize_f0_m27(raw[..., F0_IDX])
    return out.astype(np.float32)


def promote_m22_to_m27_f32(m22: np.ndarray) -> np.ndarray:
    """Lossless promotion of legacy synth_100h m22 (..., 22) into physical float32 m27 (..., 27)."""
    return promote_m22_to_m27(m22).astype(np.float32)


def assemble_m27_norm(
    tract17_norm: torch.Tensor,
    f0_norm: torch.Tensor,
    pr_norm: torch.Tensor,
    glottis8_norm: torch.Tensor,
) -> torch.Tensor:
    """Assemble (B, T, 27) in canonical M27_NAMES order: [tract17, F0, PR, glottis8]."""
    if f0_norm.ndim == 2:
        f0_norm = f0_norm.unsqueeze(-1)
    if pr_norm.ndim == 2:
        pr_norm = pr_norm.unsqueeze(-1)
    return torch.cat([tract17_norm, f0_norm, pr_norm, glottis8_norm], dim=-1)


__all__ = [
    "DEFAULT_M27_PAD_ROW",
    "F0_IDX",
    "F0_MAX_M27",
    "F0_MIN_M27",
    "GLOTTIS8_NAMES",
    "GLOTTIS8_SLICE",
    "LEGACY_GLOTTIS8_MASK",
    "LOG_F0_MAX_M27",
    "LOG_F0_MIN_M27",
    "M27_MAX",
    "M27_MIN",
    "M27_NAMES",
    "NATIVE_GLOTTIS8_MASK",
    "PR_IDX",
    "PR_MAX_M27",
    "PR_MIN_M27",
    "SCHEMA_VERSION",
    "TRACT_17_TO_19_IDX",
    "TRACT_SLICE",
    "assemble_m27_norm",
    "denormalize_f0_m27",
    "denormalize_m27",
    "denormalize_pr_m27",
    "normalize_f0_m27",
    "normalize_m27",
    "normalize_pr_m27",
    "promote_m22_to_m27_f32",
]
