"""Pure-NumPy + native JD2 mid-sagittal vocal tract contour extractor (zero torch dependency)."""
from __future__ import annotations

from pathlib import Path
import sys
from typing import Any, Dict, List, Optional

import numpy as np

PTB_CORE_SRC = Path(__file__).resolve().parents[3] / "vtl_native"
VTL_NATIVE_DIR = PTB_CORE_SRC / "native"

PARTS_ORDER = (
    "upper_cover",
    "lower_cover",
    "upper_teeth",
    "lower_teeth",
    "upper_lip",
    "lower_lip",
    "tongue",
    "uvula",
    "epiglottis",
)

# 17 independent supraglottal tract indices inside JD2's 19-dim vector (TRX=14, TRY=15 auto)
_TRACT_17_TO_19_IDX = np.array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18], dtype=np.int64)
_M17_MIN = np.array(
    [0.0, -6.0, -0.5, -7.0, -1.0, -0.5, 0.0, -0.1, -2.5, -3.0, 1.5, -3.0, -2.0, -3.0, 0.0, 0.0, -1.0],
    dtype=np.float64,
)
_M17_MAX = np.array(
    [1.0, -3.5, 0.0, 0.0, 1.0, 2.5, 1.0, 1.0, 3.5, 0.8, 6.0, 2.5, 5.0, 4.5, 1.0, 1.0, 1.0],
    dtype=np.float64,
)


_M27_TRACT17_MIN = np.array(
    [0.0, -6.0, -0.5, -7.0, -1.0, -2.0, 0.0, -0.1, -3.0, -3.0, 1.5, -3.0, -3.0, -3.0, 0.0, 0.0, -1.0],
    dtype=np.float64,
)
_M27_TRACT17_MAX = np.array(
    [1.0, -3.5, 0.0, 0.0, 1.0, 4.0, 1.0, 1.5, 4.0, 1.0, 7.5, 2.5, 6.5, 5.0, 1.0, 1.0, 1.0],
    dtype=np.float64,
)


def m27_to_tract19(m27_50hz: np.ndarray) -> np.ndarray:
    """Expand 27-dim M27 control trajectory (..., 27) into JD2 19-dim tract vector."""
    arr = np.asarray(m27_50hz, dtype=np.float64)
    tract17 = np.clip(arr[..., :17], _M27_TRACT17_MIN, _M27_TRACT17_MAX)
    tract19 = np.zeros(arr.shape[:-1] + (19,), dtype=np.float64)
    tract19[..., _TRACT_17_TO_19_IDX] = tract17
    return tract19


def _qta_3rd_order_filter(targets: np.ndarray, dt: float, tau: float) -> np.ndarray:
    """Analytical 3rd-order critically damped Target Approximation filter (Xu & Wang 2001 / Prom-on 2009)."""
    seq = np.asarray(targets, dtype=np.float64)
    n_steps, n_dims = seq.shape
    out = np.empty_like(seq)
    if n_steps == 0:
        return out

    lam = 1.0 / max(1e-4, float(tau))
    for d in range(n_dims):
        col = seq[:, d]
        y0 = float(col[0])
        yp0 = 0.0
        ypp0 = 0.0
        changes = np.flatnonzero(np.abs(np.diff(col)) > 1e-9) + 1
        bounds = np.concatenate(([0], changes, [n_steps]))
        for i in range(len(bounds) - 1):
            a, b = int(bounds[i]), int(bounds[i + 1])
            target_val = float(col[a])
            t = np.arange(b - a, dtype=np.float64) * dt
            c0 = y0 - target_val
            c1 = yp0 + lam * c0
            c2 = 0.5 * ypp0 + lam * yp0 + 0.5 * (lam ** 2) * c0
            exp_lt = np.exp(-lam * t)
            poly = c0 + c1 * t + c2 * (t ** 2)
            out[a:b, d] = target_val + poly * exp_lt

            t_end = float(b - a) * dt
            e_end = float(np.exp(-lam * t_end))
            p_end = c0 + c1 * t_end + c2 * (t_end ** 2)
            dp_end = c1 + 2.0 * c2 * t_end
            d2p_end = 2.0 * c2
            y0 = target_val + p_end * e_end
            yp0 = (dp_end - lam * p_end) * e_end
            ypp0 = (d2p_end - 2.0 * lam * dp_end + (lam ** 2) * p_end) * e_end
    return out


_QTA_GLOTTIS_FAST_COLS = [18, 19, 20, 21, 23]  # PR, XB, XT, CA, RA
_QTA_QUALITY_COLS = [22, 24, 25, 26]           # LAG, PS, FL, SHIM


def qta_filter_m27_50_to_200(
    arr_50: np.ndarray,
    *,
    tau_tract: float = 0.018,
    tau_glottis: float = 0.008,
    tau_quality: float = 0.020,
) -> np.ndarray:
    """Upsample 50 Hz M27 targets to 200 Hz via zero-lag 3rd-order critically damped qTA (Xu & Wang 2001).

    Uses anticipatory target lookahead (2.5 * tau) to cancel the causal filter's group delay so
    synthesized consonant bursts, vowel onsets, F0, and sagittal animations stay tightly synchronized.
    """
    seq = np.asarray(arr_50, dtype=np.float64)
    n50, n_dims = seq.shape
    n200 = n50 * 4
    if n50 <= 1:
        return np.repeat(seq, n200, axis=0)

    dt = 0.005  # 200 Hz (5 ms/step)
    held = np.repeat(seq, 4, axis=0)
    out = held.copy()

    def _run_group(cols: List[int], tau: float) -> None:
        if tau <= 1e-4:
            return
        shift = max(0, int(round(2.5 * tau / dt)))
        src = held[:, cols]
        if shift > 0:
            if shift < n200:
                src_shifted = np.concatenate([src[shift:], np.repeat(src[-1:, :], shift, axis=0)], axis=0)
            else:
                src_shifted = np.repeat(src[-1:, :], n200, axis=0)
        else:
            src_shifted = src
        out[:, cols] = _qta_3rd_order_filter(src_shifted, dt, tau)

    _run_group(list(range(0, 17)), tau_tract)
    _run_group(_QTA_GLOTTIS_FAST_COLS, tau_glottis)
    _run_group(_QTA_QUALITY_COLS, tau_quality)

    # Preserve exact extracted F0 contour via linear interpolation
    t50 = (np.arange(n50, dtype=np.float64) + 0.5) / 50.0
    t200 = (np.arange(n200, dtype=np.float64) + 0.5) / 200.0
    out[:, 17] = np.interp(t200, t50, seq[:, 17])
    return out


def qta_smooth_m27_50hz(
    arr_50: np.ndarray,
    *,
    tau_tract: float = 0.018,
    tau_glottis: float = 0.008,
    tau_quality: float = 0.020,
) -> np.ndarray:
    """Return 50 Hz center-sampled trajectory matching the 200 Hz qTA critically damped kinematics."""
    s200 = qta_filter_m27_50_to_200(
        arr_50,
        tau_tract=tau_tract,
        tau_glottis=tau_glottis,
        tau_quality=tau_quality,
    )
    return s200[1::4]


def extract_m27_animation(
    synth_or_engine: Any,
    m27_50hz: np.ndarray,
    fps: int = 25,
    apply_qta: bool = False,
) -> Dict[str, Any]:
    """Extract native JD2 sagittal contours + dynamic R21 material ribs + 10 glottal params from 50 Hz M27."""
    eng = getattr(synth_or_engine, "engine", synth_or_engine)
    arr = np.asarray(m27_50hz, dtype=np.float64)
    if arr.ndim != 2 or arr.shape[1] != 27 or arr.shape[0] < 1:
        raise ValueError(f"期望形状 (T, 27)，收到 {arr.shape}")

    if apply_qta and arr.shape[0] >= 3:
        arr = qta_smooth_m27_50hz(arr)

    clamped_fps = max(5, min(50, int(fps)))
    stride = max(1, int(round(50.0 / clamped_fps)))
    eff_fps = round(50.0 / stride, 2)

    tract19 = m27_to_tract19(arr)
    part_sizes: Optional[List[int]] = None
    frames: List[Dict[str, Any]] = []

    for idx in range(0, arr.shape[0], stride):
        contours, nasal_port_area, limited = eng.inversion_profile(tract19[idx])
        if part_sizes is None:
            part_sizes = [len(contours[p]) for p in PARTS_ORDER]

        srib = float(eng.geom.p8_surface_rib()) if hasattr(eng, "geom") and eng.geom is not None else 16.0
        brib = float(eng.geom.p4_blade_rib()) if hasattr(eng, "geom") and eng.geom is not None else 21.0
        frib = int(eng.geom.p6_floor_rib()) if hasattr(eng, "geom") and eng.geom is not None else 10

        flat_pts: List[float] = []
        for part in PARTS_ORDER:
            for pt in contours[part]:
                flat_pts.append(round(float(pt[0]), 2))
                flat_pts.append(round(float(pt[1]), 2))

        row = arr[idx]
        frames.append(
            {
                "t": round(idx * 0.02, 3),
                "pts": flat_pts,
                "nasal": round(float(nasal_port_area), 3),
                "ja": round(float(limited[3]), 2),
                "jx": round(float(limited[2]), 2),
                "lp": round(float(limited[4]), 2),
                "ld": round(float(limited[5]), 2),
                "vo": round(float(limited[7]), 3),
                # Collision-clamped native JD2 landmarks: [TCX, TCY, TTX, TTY, TBX, TBY, TRX, TRY]
                "lm": [round(float(limited[c]), 2) for c in (8, 9, 10, 11, 12, 13, 14, 15)],
                "srib": round(srib, 3),
                "brib": round(brib, 3),
                "frib": frib,
                "f0": round(float(row[17]), 1),
                "pr": round(float(row[18]), 1),
                "xb": round(float(row[19]), 3),
                "xt": round(float(row[20]), 3),
                "ca": round(float(row[21]), 3),
                "lag": round(float(row[22]), 2),
                "ra": round(float(row[23]), 2),
                "ps": round(float(row[24]), 2),
                "fl": round(float(row[25]), 1),
                "shim": round(float(row[26]), 1),
                "voiced": int(row[18] > 1500.0 and row[23] > 0.12),
            }
        )

    return {
        "schema": "m27_anim_v3",
        "qta_damping": bool(apply_qta),
        "fps": eff_fps,
        "duration_sec": round(arr.shape[0] * 0.02, 3),
        "frame_count": len(frames),
        "bounds": {"xmin": -4.6, "xmax": 8.2, "ymin": -8.4, "ymax": 2.4},
        "parts": list(PARTS_ORDER),
        "part_sizes": part_sizes or [],
        "frames": frames,
    }


def open_jd2_engine() -> Any:
    """Open native M10 R21 JD2 engine directly without importing PyTorch."""
    src_str = str(PTB_CORE_SRC)
    if src_str not in sys.path:
        sys.path.insert(0, src_str)
    from phonetic_core.vocal_tract.engine import Engine  # noqa: E402

    eng = Engine("JD2", resource_dir=VTL_NATIVE_DIR)
    eng.set_section_count(65)
    eng.set_manual_root(False)
    return eng


def m22_to_tract19(m22_50hz: np.ndarray) -> np.ndarray:
    """Expand 22-dim TT3 control trajectory (..., 22) into JD2 19-dim tract vector."""
    arr = np.asarray(m22_50hz, dtype=np.float64)
    tract17 = np.clip(arr[..., :17], _M17_MIN, _M17_MAX)
    tract19 = np.zeros(arr.shape[:-1] + (19,), dtype=np.float64)
    tract19[..., _TRACT_17_TO_19_IDX] = tract17
    return tract19


def extract_tract_animation(
    synth_or_engine: Any,
    m22_50hz: np.ndarray,
    voiced_mask: Optional[np.ndarray] = None,
    fps: int = 25,
) -> Dict[str, Any]:
    """Extract compact native JD2 sagittal contour frames from a 50 Hz M22 trajectory."""
    eng = getattr(synth_or_engine, "engine", synth_or_engine)
    arr = np.asarray(m22_50hz, dtype=np.float64)
    if arr.ndim != 2 or arr.shape[1] != 22 or arr.shape[0] < 1:
        raise ValueError(f"期望形状 (T, 22)，收到 {arr.shape}")

    clamped_fps = max(5, min(50, int(fps)))
    stride = max(1, int(round(50.0 / clamped_fps)))
    eff_fps = round(50.0 / stride, 2)

    tract19 = m22_to_tract19(arr)
    part_sizes: Optional[List[int]] = None
    frames: List[Dict[str, Any]] = []

    for idx in range(0, arr.shape[0], stride):
        contours, nasal_port_area, _ = eng.inversion_profile(tract19[idx])
        if part_sizes is None:
            part_sizes = [len(contours[p]) for p in PARTS_ORDER]

        flat_pts: List[float] = []
        for part in PARTS_ORDER:
            for pt in contours[part]:
                flat_pts.append(round(float(pt[0]), 2))
                flat_pts.append(round(float(pt[1]), 2))

        frames.append(
            {
                "t": round(idx * 0.02, 3),
                "pts": flat_pts,
                "nasal": round(float(nasal_port_area), 3),
                "f0": round(float(arr[idx, 21]), 1),
                "pr": round(float(arr[idx, 20]), 1),
                "voiced": int(bool(voiced_mask[idx])) if voiced_mask is not None else 1,
                "ja": round(float(arr[idx, 3]), 2),
                "jx": round(float(arr[idx, 2]), 2),
                "lp": round(float(arr[idx, 4]), 2),
                "ld": round(float(arr[idx, 5]), 2),
                "vo": round(float(arr[idx, 7]), 3),
                "lm": [round(float(arr[idx, c]), 2) for c in (8, 9, 10, 11, 12, 13, 0, 1)],
            }
        )

    return {
        "fps": eff_fps,
        "duration_sec": round(arr.shape[0] * 0.02, 3),
        "frame_count": len(frames),
        "bounds": {"xmin": -4.6, "xmax": 8.2, "ymin": -8.4, "ymax": 2.4},
        "parts": list(PARTS_ORDER),
        "part_sizes": part_sizes or [],
        "frames": frames,
    }
