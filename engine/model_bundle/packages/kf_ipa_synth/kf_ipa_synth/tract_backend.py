"""Pluggable Vocal-Tract Geometry & Physical Synthesis Backend for kf_ipa_synth.

Automatically uses the native VTL R21 / JD2 engine when available (via env vars
``KF_IPA_PTB_CORE_SRC`` / ``KF_IPA_VTL_NATIVE_DIR`` or local PhoneticToolbox install),
and seamlessly falls back to a pure-NumPy parametric mid-sagittal contour model when
running on platforms/containers without native VTL DLLs.
"""
from __future__ import annotations

import os
from pathlib import Path
import sys
import threading
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from .m27_contract import (
    CONTROL_HZ_200,
    M27_MAX,
    M27_MIN,
    R21_STEP_SAMPLES_48K,
    SAMPLE_RATE_48K,
    m27_to_tract19,
    m27_to_vtl19_glottis9_shimmer,
)

PARTS_ORDER: Tuple[str, ...] = (
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

SAGITTAL_BOUNDS: Dict[str, float] = {"xmin": -4.6, "xmax": 8.2, "ymin": -8.4, "ymax": 2.4}

_QTA_GLOTTIS_FAST_COLS = [18, 19, 20, 21, 23]  # PR, XB, XT, CA, RA
_QTA_QUALITY_COLS = [22, 24, 25, 26]           # LAG, PS, FL, SHIM


def _qta_3rd_order_filter(targets: np.ndarray, dt: float, tau: float) -> np.ndarray:
    seq = np.asarray(targets, dtype=np.float64)
    n_steps, n_dims = seq.shape
    out = np.empty_like(seq)
    if n_steps == 0:
        return out
    lam = 1.0 / max(1e-4, float(tau))
    for d in range(n_dims):
        col = seq[:, d]
        y0, yp0, ypp0 = float(col[0]), 0.0, 0.0
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
            out[a:b, d] = target_val + (c0 + c1 * t + c2 * (t ** 2)) * exp_lt
            t_end = float(b - a) * dt
            e_end = float(np.exp(-lam * t_end))
            p_end = c0 + c1 * t_end + c2 * (t_end ** 2)
            dp_end = c1 + 2.0 * c2 * t_end
            d2p_end = 2.0 * c2
            y0 = target_val + p_end * e_end
            yp0 = (dp_end - lam * p_end) * e_end
            ypp0 = (d2p_end - 2.0 * lam * dp_end + (lam ** 2) * p_end) * e_end
    return out


def qta_filter_m27_50_to_200(
    arr_50: np.ndarray,
    *,
    tau_tract: float = 0.018,
    tau_glottis: float = 0.008,
    tau_quality: float = 0.020,
) -> np.ndarray:
    """Upsample 50 Hz M27 targets to 200 Hz via zero-lag 3rd-order critically damped qTA."""
    seq = np.asarray(arr_50, dtype=np.float64)
    n50, _ = seq.shape
    n200 = n50 * 4
    if n50 <= 1:
        return np.repeat(seq, n200, axis=0)
    dt = 0.005
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

    t50 = (np.arange(n50, dtype=np.float64) + 0.5) / 50.0
    t200 = (np.arange(n200, dtype=np.float64) + 0.5) / 200.0
    out[:, 17] = np.interp(t200, t50, seq[:, 17])
    return out


def _catmull_rom(pts: List[Tuple[float, float]], samples_per_seg: int = 5) -> List[Tuple[float, float]]:
    if len(pts) < 3:
        return pts
    arr = np.asarray(pts, dtype=np.float64)
    ext = np.vstack([arr[0:1], arr, arr[-1:]])
    out: List[Tuple[float, float]] = []
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
        for s in range(samples_per_seg):
            t = s / float(samples_per_seg)
            t2, t3 = t * t, t * t * t
            pt = 0.5 * (
                (2.0 * p1)
                + (-p0 + p2) * t
                + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
                + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
            )
            out.append((float(pt[0]), float(pt[1])))
    out.append((float(arr[-1, 0]), float(arr[-1, 1])))
    return out


def _parametric_sagittal_contours(m27_row: np.ndarray) -> Tuple[Dict[str, List[Tuple[float, float]]], float, np.ndarray]:
    """Pure-NumPy anatomical mid-sagittal contour fallback matching JD2 coordinate bounds [-4.6..8.2, -8.4..2.4]."""
    p = np.clip(np.asarray(m27_row, dtype=np.float64), M27_MIN.astype(np.float64), M27_MAX.astype(np.float64))
    hx, hy, jx, ja, lp, ld, vs, vo = p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7]
    tcx, tcy, ttx, tty, tbx, tby = p[8], p[9], p[10], p[11], p[12], p[13]

    # Upper fixed roof: pharynx wall -> velar vault -> hard palate -> alveolar ridge
    upper_cover = [
        (-2.5, -7.8), (-2.6, -5.2), (-2.4, -2.5), (-1.9, -0.4), (-1.0, 0.9),
        (0.4, 1.65), (2.2, 1.85), (4.0, 1.65), (5.3, 1.05), (6.0, 0.35), (6.5, 0.1),
    ]
    # Jaw kinematics shift for lower structures
    jaw_drop = max(0.0, -ja) * 0.28
    jaw_x = jx * 1.1
    lower_cover = [
        (-0.8, -7.8), (-0.6, -5.8 + (hy + 4.8) * 0.4), (0.6, -4.6 - jaw_drop * 0.5),
        (2.8 + jaw_x, -3.5 - jaw_drop * 0.8), (5.5 + jaw_x, -2.4 - jaw_drop), (6.7 + jaw_x, -1.6 - jaw_drop),
    ]
    upper_teeth = [(5.95, 0.35), (6.35, 0.35), (6.28, -0.45), (5.92, -0.45), (5.95, 0.35)]
    lt_y = -0.55 - jaw_drop * 0.72
    lower_teeth = [
        (5.75 + jaw_x, lt_y), (6.15 + jaw_x, lt_y),
        (6.10 + jaw_x, lt_y - 0.75), (5.72 + jaw_x, lt_y - 0.75), (5.75 + jaw_x, lt_y),
    ]

    lip_x = 6.75 + lp * 0.85
    lip_gap = np.clip(ld, -0.35, 2.8) * 0.32
    upper_lip = [
        (6.45, 0.65), (lip_x + 0.45, 0.45 + lip_gap * 0.25), (lip_x + 0.55, 0.05 + lip_gap * 0.2),
        (lip_x - 0.1, -0.15 + lip_gap * 0.2), (6.45, 0.15), (6.45, 0.65),
    ]
    ll_y = -0.35 - lip_gap - jaw_drop * 0.25
    lower_lip = [
        (6.45 + jaw_x, ll_y + 0.15), (lip_x + 0.45, ll_y + 0.1), (lip_x + 0.40, ll_y - 0.42),
        (6.40 + jaw_x, ll_y - 0.55), (6.45 + jaw_x, ll_y + 0.15),
    ]

    # Tongue spline driven directly by HY, HX, TCX/TCY, TBX/TBY, TTX/TTY
    root_x = -1.65 + (tcx * 0.25) + (hx - 0.5) * 0.5
    root_y = hy - 0.8
    dorsum_x = np.clip(tcx, -2.5, 3.8)
    dorsum_y = np.clip(tcy + 1.35, -2.2, 1.65)
    blade_x = np.clip(max(dorsum_x + 0.8, tbx + 1.5), 0.5, 5.8)
    blade_y = np.clip(tby * 0.45 + 0.15, -2.2, 1.55)
    tip_x = np.clip(ttx, 2.0, 6.45)
    tip_y = np.clip(tty, -2.4, 1.45)
    tongue_ctrl = [
        (root_x + 0.2, -6.3),
        (root_x, root_y),
        ((root_x + dorsum_x) * 0.5 - 0.3, (root_y + dorsum_y) * 0.5 + 0.6),
        (dorsum_x, dorsum_y),
        (blade_x, blade_y),
        (tip_x, tip_y),
        (tip_x - 0.55, tip_y - 0.75),
        (dorsum_x + 0.4, -2.7 - jaw_drop * 0.4),
        (root_x + 0.5, -5.2),
    ]
    tongue = _catmull_rom(tongue_ctrl, samples_per_seg=4)

    # Velum / Uvula: VO opens velopharyngeal port (drops & moves forward away from back wall)
    vo_c = np.clip(vo, -0.1, 1.2)
    uvula = [
        (0.2, 1.55),
        (-0.45 + vo_c * 0.55, 0.85 - vo_c * 0.35),
        (-0.95 + vo_c * 0.85, -0.25 - vo_c * 0.65 - (1.0 - vs) * 0.2),
        (-0.55 + vo_c * 0.75, -0.35 - vo_c * 0.55),
        (0.15 + vo_c * 0.3, 0.75),
        (0.2, 1.55),
    ]
    epiglottis = [
        (root_x + 0.2, -5.8), (root_x - 0.35, -4.6), (root_x - 0.15, -4.45), (root_x + 0.35, -5.6),
    ]

    contours = {
        "upper_cover": upper_cover,
        "lower_cover": lower_cover,
        "upper_teeth": upper_teeth,
        "lower_teeth": lower_teeth,
        "upper_lip": upper_lip,
        "lower_lip": lower_lip,
        "tongue": tongue,
        "uvula": uvula,
        "epiglottis": epiglottis,
    }
    nasal_area = float(max(0.0, vo_c) * 1.4)
    tract19 = m27_to_tract19(p)
    return contours, nasal_area, tract19


class TractBackend:
    """Thread-safe wrapper around native JD2 / VTL R21 with automatic pure-NumPy fallback."""

    def __init__(
        self,
        ptb_core_src: Optional[Path] = None,
        vtl_native_dir: Optional[Path] = None,
        enable_native: bool = True,
    ) -> None:
        self._lock = threading.Lock()
        self._engine: Any = None
        self._native_checked = False
        self._native_error: Optional[str] = None
        self.enable_native = bool(enable_native)

        env_core = os.environ.get("KF_IPA_PTB_CORE_SRC", "").strip()
        env_vtl = os.environ.get("KF_IPA_VTL_NATIVE_DIR", "").strip()
        native_root = Path(__file__).resolve().parents[4] / "vtl_native"
        self.ptb_core_src = Path(ptb_core_src or env_core or native_root)
        self.vtl_native_dir = Path(vtl_native_dir or env_vtl or native_root / "native")

    def _ensure_native(self) -> Any:
        if not self.enable_native:
            return None
        if self._native_checked:
            return self._engine
        self._native_checked = True
        try:
            if not self.ptb_core_src.is_dir() or not self.vtl_native_dir.is_dir():
                self._native_error = "Native VTL R21 directory not found (running in portable fallback mode)"
                return None
            src_str = str(self.ptb_core_src)
            if src_str not in sys.path:
                sys.path.insert(0, src_str)
            from phonetic_core.vocal_tract.engine import Engine  # type: ignore

            eng = Engine("JD2", resource_dir=self.vtl_native_dir)
            eng.set_section_count(65)
            eng.set_manual_root(False)
            eng.configure_perturbation({"jitter": 0.0, "shimmer": 0.0, "seed": 1}, restart=True)
            self._engine = eng
        except Exception as exc:
            self._native_error = str(exc)
            self._engine = None
        return self._engine

    @property
    def native_available(self) -> bool:
        with self._lock:
            return self._ensure_native() is not None

    @property
    def backend_mode(self) -> str:
        return "jd2_r21_native" if self.native_available else "parametric_fallback"

    def close(self) -> None:
        with self._lock:
            if self._engine is not None:
                try:
                    self._engine.close()
                except Exception:
                    pass
                self._engine = None
            self._native_checked = False

    def extract_single_contour(self, m27_row: np.ndarray) -> Dict[str, Any]:
        """Extract one sagittal contour frame (for instant live dragging in Vocal-Tract widgets)."""
        row = np.clip(np.asarray(m27_row, dtype=np.float64).reshape(27), M27_MIN.astype(np.float64), M27_MAX.astype(np.float64))
        with self._lock:
            eng = self._ensure_native()
            if eng is not None:
                tract19 = m27_to_tract19(row)
                contours, nasal_area, limited = eng.inversion_profile(tract19)
                mode = "jd2_r21_native"
            else:
                contours, nasal_area, limited = _parametric_sagittal_contours(row)
                mode = "parametric_fallback"

        part_sizes = [len(contours[p]) for p in PARTS_ORDER]
        flat_pts: List[float] = []
        for part in PARTS_ORDER:
            for pt in contours[part]:
                flat_pts.append(round(float(pt[0]), 2))
                flat_pts.append(round(float(pt[1]), 2))
        return {
            "schema": "m27_contour_v1",
            "backend": mode,
            "bounds": dict(SAGITTAL_BOUNDS),
            "parts": list(PARTS_ORDER),
            "part_sizes": part_sizes,
            "frame": {
                "t": 0.0,
                "pts": flat_pts,
                "nasal": round(float(nasal_area), 3),
                "ja": round(float(limited[3]), 2),
                "lp": round(float(limited[4]), 2),
                "ld": round(float(limited[5]), 2),
                "vo": round(float(limited[7]), 3),
                "lm": [round(float(limited[c]), 2) for c in (8, 9, 10, 11, 12, 13, 14, 15)],
                "f0": round(float(row[17]), 1),
                "pr": round(float(row[18]), 1),
                "ra": round(float(row[23]), 2),
                "lag": round(float(row[22]), 2),
                "shim": round(float(row[26]), 1),
                "voiced": int(row[18] > 1500.0 and row[23] > 0.12),
            },
        }

    def extract_animation(self, m27_50hz: np.ndarray, fps: int = 25) -> Dict[str, Any]:
        arr = np.asarray(m27_50hz, dtype=np.float64)
        clamped_fps = max(5, min(50, int(fps)))
        stride = max(1, int(round(50.0 / clamped_fps)))
        eff_fps = round(50.0 / stride, 2)
        tract19 = m27_to_tract19(arr)
        part_sizes: Optional[List[int]] = None
        frames: List[Dict[str, Any]] = []

        with self._lock:
            eng = self._ensure_native()
            mode = "jd2_r21_native" if eng is not None else "parametric_fallback"
            for idx in range(0, arr.shape[0], stride):
                if eng is not None:
                    contours, nasal_area, limited = eng.inversion_profile(tract19[idx])
                else:
                    contours, nasal_area, limited = _parametric_sagittal_contours(arr[idx])
                if part_sizes is None:
                    part_sizes = [len(contours[p]) for p in PARTS_ORDER]
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
                        "nasal": round(float(nasal_area), 3),
                        "ja": round(float(limited[3]), 2),
                        "lp": round(float(limited[4]), 2),
                        "ld": round(float(limited[5]), 2),
                        "vo": round(float(limited[7]), 3),
                        "lm": [round(float(limited[c]), 2) for c in (8, 9, 10, 11, 12, 13, 14, 15)],
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
            "backend": mode,
            "fps": eff_fps,
            "duration_sec": round(arr.shape[0] * 0.02, 3),
            "frame_count": len(frames),
            "bounds": dict(SAGITTAL_BOUNDS),
            "parts": list(PARTS_ORDER),
            "part_sizes": part_sizes or [],
            "frames": frames,
        }

    def synthesize_r21_48k(
        self,
        m27_200hz: np.ndarray,
        *,
        perturb_seed: int = 1,
        tube_hz: int = 100,
    ) -> Optional[np.ndarray]:
        """Render 48 kHz mono physical audio using native VTL R21 when available; returns None otherwise."""
        stride = CONTROL_HZ_200 // int(tube_hz)
        tract19_seq, glottis9_seq, shim_seq = m27_to_vtl19_glottis9_shimmer(m27_200hz)
        with self._lock:
            eng = self._ensure_native()
            if eng is None:
                return None
            tract19_seq = np.clip(tract19_seq, eng.minimum, eng.maximum)
            glottis9_seq = np.clip(glottis9_seq, eng.gmin, eng.gmax)
            n_steps = tract19_seq.shape[0]
            anchors = list(range(0, n_steps, stride))
            if anchors[-1] != n_steps - 1:
                anchors.append(n_steps - 1)
            tubes: Dict[int, Any] = {}
            prev_p: Optional[np.ndarray] = None
            prev_t: Any = None
            for idx in anchors:
                cur_p = tract19_seq[idx]
                if prev_p is not None and float(np.max(np.abs(cur_p - prev_p))) < 1e-4:
                    tubes[idx] = prev_t
                else:
                    prev_t = eng.prepare_tube(cur_p)
                    prev_p = cur_p
                    tubes[idx] = prev_t

            pseed = max(1, int(perturb_seed) & 0x7FFFFFFF)
            last_shim = float(shim_seq[0])
            eng.configure_perturbation({"jitter": 0.0, "shimmer": last_shim, "seed": pseed}, restart=True)
            first_tube = tubes[0]
            eng.reset_tube(first_tube, np.ascontiguousarray(glottis9_seq[0]))
            chunks: List[np.ndarray] = [
                np.asarray(
                    eng.block_tube(first_tube, np.ascontiguousarray(glottis9_seq[0]), R21_STEP_SAMPLES_48K),
                    dtype=np.float32,
                )
            ]
            ai = 0
            n_anchors = len(anchors)
            for k in range(1, n_steps):
                cur_shim = float(shim_seq[k])
                if abs(cur_shim - last_shim) >= 2.0:
                    eng.configure_perturbation({"jitter": 0.0, "shimmer": cur_shim, "seed": pseed}, restart=False)
                    last_shim = cur_shim
                if stride == 1:
                    tube_use = tubes[k]
                else:
                    while ai + 1 < n_anchors and k > anchors[ai + 1]:
                        ai += 1
                    a0 = anchors[ai]
                    a1 = anchors[ai + 1] if ai + 1 < n_anchors else a0
                    if a0 == a1 or k == a0:
                        tube_use = tubes[a0]
                    elif k == a1:
                        tube_use = tubes[a1]
                    else:
                        t0_d, t1_d = tubes[a0], tubes[a1]
                        if t0_d is t1_d:
                            tube_use = t0_d
                        else:
                            alpha = float(k - a0) / float(a1 - a0)
                            tube_use = {
                                "lengths": t0_d["lengths"] * (1.0 - alpha) + t1_d["lengths"] * alpha,
                                "areas": t0_d["areas"] * (1.0 - alpha) + t1_d["areas"] * alpha,
                                "articulators": t0_d["articulators"] if alpha < 0.5 else t1_d["articulators"],
                                "extras": t0_d["extras"] * (1.0 - alpha) + t1_d["extras"] * alpha,
                            }
                pcm = eng.block_tube(tube_use, np.ascontiguousarray(glottis9_seq[k]), R21_STEP_SAMPLES_48K)
                chunks.append(np.asarray(pcm, dtype=np.float32))
            if not chunks:
                return None
            wav_48k = np.concatenate(chunks, axis=0)
            if not np.isfinite(wav_48k).all() or float(np.max(np.abs(wav_48k))) > 10.0:
                return None
            return wav_48k.astype(np.float32)


__all__ = ["PARTS_ORDER", "SAGITTAL_BOUNDS", "TractBackend", "qta_filter_m27_50_to_200"]
