"""Shared paths, parameter contracts, and normalization utilities for TT3 (M10 R21 + JD2)."""
from __future__ import annotations

from pathlib import Path
import sys
from typing import TYPE_CHECKING, Tuple

import numpy as np

if TYPE_CHECKING:
    import torch

# 只读引用主仓库路径（绝不写入主仓库）
TRAIN_ROOT = Path(__file__).resolve().parents[2]
PTB_ROOT = TRAIN_ROOT / "ptb"
PTB_CORE_SRC = PTB_ROOT / "packages" / "phonetic_core" / "src"
VTL_NATIVE_DIR = TRAIN_ROOT.parent / "vtl_native" / "native"
SWIFTF0_ONNX = PTB_ROOT / "resources/neural/swift-f0-0.3.0.onnx"
HF_CACHE_DIR = TRAIN_ROOT / "cache" / "hf"
STATES_DEFAULT_PATH = TRAIN_ROOT / "data" / "states" / "states_jd2_r21.npz"

# 只读语料路径
LIBRISPEECH_DIR = Path(r"F:\LibriSpeech ASR corpus\data")
KESPEECH_SPLITS_DIR = Path(r"F:\KeSpeech\KeSpeech.splits")
SYLLABLE_DIR = Path(r"C:\Users\13680\Desktop\project\【中山大学】\pitch_perception\shared\data\training_audio")

# 声道与采样常量
SAMPLE_RATE_16K = 16000
SAMPLE_RATE_48K = 48000
CONTROL_HZ_50 = 50
CONTROL_HZ_200 = 200
WAVLM_HOP_SAMPLES = 320  # 16000 / 50 = 320 samples (20 ms)
R21_STEP_SAMPLES_48K = 240  # 48000 / 200 = 240 samples (5 ms)

# JD2 19 维声道参数顺序（与 VTL 2.4 一致）
JD2_TRACT_19_NAMES: Tuple[str, ...] = (
    "HX", "HY", "JX", "JA", "LP", "LD", "VS", "VO",
    "TCX", "TCY", "TTX", "TTY", "TBX", "TBY", "TRX", "TRY",
    "TS1", "TS2", "TS3",
)

# 去掉自动舌根 TRX (14), TRY (15)，剩余 17 维独立声道控制
TRACT_17_TO_19_IDX = np.array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18], dtype=np.int64)
SUPRAGLOTTAL_17_NAMES: Tuple[str, ...] = tuple(JD2_TRACT_19_NAMES[i] for i in TRACT_17_TO_19_IDX)

# 3 维独立声门参数（Geometric glottis 2025）：XB=x_bottom, CA=chink_area, RA=rel_amp
GLOTTIS_3_NAMES: Tuple[str, ...] = ("XB", "CA", "RA")

# 20 维电机主编码器输出 m20 = [17 tract, 3 glottis]
M20_NAMES: Tuple[str, ...] = SUPRAGLOTTAL_17_NAMES + GLOTTIS_3_NAMES
# 22 维完整控制流 m = [m20, PR, F0]
M22_NAMES: Tuple[str, ...] = M20_NAMES + ("PR", "F0")

# 22 维物理上下界（严格匹配计划契约）
M22_BOUNDS: Tuple[Tuple[float, float], ...] = (
    # 17 维声道
    (0.0, 1.0),     # HX
    (-6.0, -3.5),   # HY
    (-0.5, 0.0),    # JX
    (-7.0, 0.0),    # JA
    (-1.0, 1.0),    # LP
    (-0.5, 2.5),    # LD
    (0.0, 1.0),     # VS
    (-0.1, 1.0),    # VO
    (-2.5, 3.5),    # TCX
    (-3.0, 0.8),    # TCY
    (1.5, 6.0),     # TTX
    (-3.0, 2.5),    # TTY
    (-2.0, 5.0),    # TBX
    (-3.0, 4.5),    # TBY
    (0.0, 1.0),     # TS1
    (0.0, 1.0),     # TS2
    (-1.0, 1.0),    # TS3
    # 3 维声门
    (0.0, 0.26),    # XB (cm)
    (0.0, 0.12),    # CA (cm^2)
    (0.0, 1.0),     # RA (rel_amp)
    # 2 维辅助控制
    (0.0, 8000.0),  # PR (dPa; 8000 dPa = 800 Pa)
    (60.0, 450.0),  # F0 (Hz; 对数归一化)
)

M22_MIN = np.array([lo for lo, _ in M22_BOUNDS], dtype=np.float32)
M22_MAX = np.array([hi for _, hi in M22_BOUNDS], dtype=np.float32)
M20_MIN = M22_MIN[:20]
M20_MAX = M22_MAX[:20]
PR_MIN, PR_MAX = float(M22_MIN[20]), float(M22_MAX[20])
F0_MIN, F0_MAX = float(M22_MIN[21]), float(M22_MAX[21])
LOG_F0_MIN, LOG_F0_MAX = float(np.log(F0_MIN)), float(np.log(F0_MAX))

# Geometric glottis 2025 固定辅助参数（来自 JD2.speaker modal）
GLOTTIS_2025_LAG = 1.222044
GLOTTIS_2025_PULSE_SHAPE = 0.5
GLOTTIS_2025_FLUTTER = 0.0


def ensure_ptb_core_on_path() -> None:
    """只读添加主仓库 phonetic_core 源码目录到 sys.path。"""
    src = str(PTB_CORE_SRC)
    if src not in sys.path:
        sys.path.insert(0, src)


def tract19_to_17(tract19: np.ndarray) -> np.ndarray:
    """将 19 维 VTL 声道参数转换为去除 TRX/TRY 的 17 维。支持 (..., 19)。"""
    arr = np.asarray(tract19, dtype=np.float32)
    return arr[..., TRACT_17_TO_19_IDX]


def tract17_to_19(tract17: np.ndarray) -> np.ndarray:
    """将 17 维声道参数还原为 19 维（TRX/TRY 暂填 0，由自动舌根与 engine.validated 处理）。"""
    arr = np.asarray(tract17, dtype=np.float64)
    out = np.zeros(arr.shape[:-1] + (19,), dtype=np.float64)
    out[..., TRACT_17_TO_19_IDX] = arr
    return out


def clamp_m22(m22: np.ndarray) -> np.ndarray:
    """按契约物理范围夹紧 22 维控制流。"""
    arr = np.asarray(m22, dtype=np.float32)
    return np.clip(arr, M22_MIN, M22_MAX)


def normalize_m20(m20: np.ndarray) -> np.ndarray:
    """将物理 20 维 [17 tract, XB, CA, RA] 线性归一化到 [-1, 1]。"""
    arr = np.clip(np.asarray(m20, dtype=np.float32), M20_MIN, M20_MAX)
    return 2.0 * (arr - M20_MIN) / (M20_MAX - M20_MIN) - 1.0


def denormalize_m20(m20_norm: np.ndarray) -> np.ndarray:
    """将 [-1, 1] 的 20 维输出还原为物理值。"""
    arr = np.clip(np.asarray(m20_norm, dtype=np.float32), -1.0, 1.0)
    return 0.5 * (arr + 1.0) * (M20_MAX - M20_MIN) + M20_MIN


def normalize_pr(pr: np.ndarray) -> np.ndarray:
    arr = np.clip(np.asarray(pr, dtype=np.float32), PR_MIN, PR_MAX)
    return 2.0 * (arr - PR_MIN) / (PR_MAX - PR_MIN) - 1.0


def denormalize_pr(pr_norm: np.ndarray) -> np.ndarray:
    arr = np.clip(np.asarray(pr_norm, dtype=np.float32), -1.0, 1.0)
    return 0.5 * (arr + 1.0) * (PR_MAX - PR_MIN) + PR_MIN


def normalize_f0(f0: np.ndarray) -> np.ndarray:
    arr = np.clip(np.asarray(f0, dtype=np.float32), F0_MIN, F0_MAX)
    return 2.0 * (np.log(arr) - LOG_F0_MIN) / (LOG_F0_MAX - LOG_F0_MIN) - 1.0


def denormalize_f0(f0_norm: np.ndarray) -> np.ndarray:
    arr = np.clip(np.asarray(f0_norm, dtype=np.float32), -1.0, 1.0)
    return np.exp(0.5 * (arr + 1.0) * (LOG_F0_MAX - LOG_F0_MIN) + LOG_F0_MIN)


def normalize_m22(m22: np.ndarray) -> np.ndarray:
    """将 22 维物理控制流 (..., 22) 归一化到 [-1, 1]，其中 F0 取对数映射。"""
    arr = np.asarray(m22, dtype=np.float32)
    out = np.empty_like(arr, dtype=np.float32)
    out[..., :20] = normalize_m20(arr[..., :20])
    out[..., 20] = normalize_pr(arr[..., 20])
    out[..., 21] = normalize_f0(arr[..., 21])
    return out


def denormalize_m22(m22_norm: np.ndarray) -> np.ndarray:
    """将 [-1, 1] 的 22 维控制流还原为物理值。"""
    arr = np.asarray(m22_norm, dtype=np.float32)
    out = np.empty_like(arr, dtype=np.float32)
    out[..., :20] = denormalize_m20(arr[..., :20])
    out[..., 20] = denormalize_pr(arr[..., 20])
    out[..., 21] = denormalize_f0(arr[..., 21])
    return out


def normalize_m22_torch(m22: "torch.Tensor") -> "torch.Tensor":
    """Torch 版本 22 维物理值归一化到 [-1, 1]。支持 (B, T, 22) 或 (..., 22)。"""
    import torch

    device = m22.device
    dtype = m22.dtype
    m_min = torch.as_tensor(M22_MIN, device=device, dtype=dtype)
    m_max = torch.as_tensor(M22_MAX, device=device, dtype=dtype)
    clamped = torch.clamp(m22, m_min, m_max)
    lin = 2.0 * (clamped[..., :21] - m_min[:21]) / (m_max[:21] - m_min[:21]) - 1.0
    f0_log = 2.0 * (torch.log(clamped[..., 21:22]) - LOG_F0_MIN) / (LOG_F0_MAX - LOG_F0_MIN) - 1.0
    return torch.cat([lin, f0_log], dim=-1)


def m22_to_vtl19_glottis9(m22: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """将物理 22 维 (..., 22) 展开为 JD2 19 维声道 + 9 维 Geometric glottis 2025。"""
    arr = clamp_m22(m22)
    tract19 = tract17_to_19(arr[..., :17])
    lead = arr.shape[:-1]
    glottis9 = np.empty(lead + (9,), dtype=np.float64)
    glottis9[..., 0] = arr[..., 21]   # f0
    glottis9[..., 1] = arr[..., 20]   # pressure (dPa)
    glottis9[..., 2] = arr[..., 17]   # x_bottom
    glottis9[..., 3] = arr[..., 17]   # x_top = x_bottom
    glottis9[..., 4] = arr[..., 18]   # chink_area
    glottis9[..., 5] = GLOTTIS_2025_LAG
    glottis9[..., 6] = arr[..., 19]   # rel_amp
    glottis9[..., 7] = GLOTTIS_2025_PULSE_SHAPE
    glottis9[..., 8] = GLOTTIS_2025_FLUTTER
    return tract19, glottis9
