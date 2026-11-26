"""Utterance alignment utilities for two-speaker M27 parameter transplantation.

Supports:
  1. Automatic Sakoe-Chiba banded DTW on 17-dim vocal tract trajectories (+ normalized PR)
  2. Piecewise-linear boundary warping from TextGrid or manual anchor pairs
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np


def align_m27_dtw(
    m27_norm_a: np.ndarray,
    m27_norm_b: np.ndarray,
    *,
    band_ratio: float = 0.30,
    pr_weight: float = 0.25,
) -> Tuple[np.ndarray, np.ndarray, Dict[str, float]]:
    """Align speaker B's 50 Hz M27 trajectory onto speaker A's time grid via Sakoe-Chiba DTW.

    Returns:
        b_aligned_norm : `(T_a, 27)` float32 M27 trajectory of B warped to A's timeline
        frame_map_b    : `(T_a,)` float32 continuous source frame index in B for each frame of A
        diag           : alignment diagnostics (mean distance, duration ratio)
    """
    a = np.asarray(m27_norm_a, dtype=np.float32)
    b = np.asarray(m27_norm_b, dtype=np.float32)
    ta, tb = a.shape[0], b.shape[0]
    if ta <= 1 or tb <= 1:
        b_out = np.repeat(b[:1], ta, axis=0)
        return b_out.astype(np.float32), np.zeros(ta, dtype=np.float32), {"mean_cost": 0.0, "dur_ratio": 1.0}

    # Feature vectors: 17-dim vocal tract + weighted PR (speaker- and F0-invariant phonetic alignment)
    fa = np.concatenate([a[:, :17], a[:, 18:19] * float(pr_weight)], axis=1).astype(np.float64)
    fb = np.concatenate([b[:, :17], b[:, 18:19] * float(pr_weight)], axis=1).astype(np.float64)

    # Pairwise Euclidean distance matrix (ta, tb)
    diff = fa[:, None, :] - fb[None, :, :]
    dist = np.sqrt(np.sum(diff * diff, axis=-1) + 1e-9)

    band = max(12, int(round(max(ta, tb) * float(band_ratio))) + abs(ta - tb))
    inf = 1e18
    dp = np.full((ta, tb), inf, dtype=np.float64)
    ptr = np.zeros((ta, tb), dtype=np.int8)  # 0=diag, 1=up(i-1,j), 2=left(i,j-1)

    dp[0, 0] = dist[0, 0]
    for i in range(ta):
        center_j = int(round(i * (tb - 1) / max(1, ta - 1)))
        j_lo = max(0, center_j - band)
        j_hi = min(tb, center_j + band + 1)
        for j in range(j_lo, j_hi):
            if i == 0 and j == 0:
                continue
            best_c = inf
            best_p = 0
            if i > 0 and j > 0 and dp[i - 1, j - 1] < best_c:
                best_c = dp[i - 1, j - 1]
                best_p = 0
            if i > 0 and dp[i - 1, j] < best_c:
                best_c = dp[i - 1, j]
                best_p = 1
            if j > 0 and dp[i, j - 1] < best_c:
                best_c = dp[i, j - 1]
                best_p = 2
            if best_c < inf * 0.5:
                dp[i, j] = dist[i, j] + best_c
                ptr[i, j] = best_p

    # Backtrack warping path
    i, j = ta - 1, tb - 1
    path: List[Tuple[int, int]] = [(i, j)]
    while i > 0 or j > 0:
        p = int(ptr[i, j])
        if p == 0 and i > 0 and j > 0:
            i -= 1
            j -= 1
        elif p == 1 and i > 0:
            i -= 1
        elif j > 0:
            j -= 1
        else:
            break
        path.append((i, j))
    path.reverse()

    # Map each frame i in A to mean matched index j in B, then linearly interpolate B cleanly
    buckets: List[List[int]] = [[] for _ in range(ta)]
    for pi, pj in path:
        buckets[pi].append(pj)
    raw_map = np.empty(ta, dtype=np.float64)
    for idx_a in range(ta):
        if buckets[idx_a]:
            raw_map[idx_a] = float(np.mean(buckets[idx_a]))
        else:
            raw_map[idx_a] = idx_a * (tb - 1) / max(1, ta - 1)

    # Light monotonic median/moving smoothing so warped B trajectory has no stair-step jitter
    if ta >= 5:
        k = np.array([0.15, 0.2, 0.3, 0.2, 0.15], dtype=np.float64)
        padded = np.pad(raw_map, (2, 2), mode="edge")
        frame_map = np.convolve(padded, k, mode="valid")[:ta]
        frame_map = np.maximum.accumulate(np.clip(frame_map, 0.0, tb - 1.0))
    else:
        frame_map = np.clip(raw_map, 0.0, tb - 1.0)

    b_aligned = _interp_trajectory_by_map(b, frame_map)
    mean_cost = float(dp[ta - 1, tb - 1] / max(1, len(path)))
    return b_aligned, frame_map.astype(np.float32), {
        "mode": "dtw",
        "mean_cost": round(mean_cost, 4),
        "frames_a": int(ta),
        "frames_b": int(tb),
        "dur_ratio": round(float(tb) / max(1.0, float(ta)), 3),
    }


def align_m27_anchors(
    m27_norm_a: np.ndarray,
    m27_norm_b: np.ndarray,
    anchors_sec: Sequence[Tuple[float, float]] | Sequence[dict],
    *,
    fps: float = 50.0,
) -> Tuple[np.ndarray, np.ndarray, Dict[str, float]]:
    """Align speaker B onto speaker A via piecewise-linear anchor pairs `(t_a_sec, t_b_sec)` (e.g. TextGrid cuts)."""
    a = np.asarray(m27_norm_a, dtype=np.float32)
    b = np.asarray(m27_norm_b, dtype=np.float32)
    ta, tb = a.shape[0], b.shape[0]
    dur_a = ta / float(fps)
    dur_b = tb / float(fps)

    pts: List[Tuple[float, float]] = [(0.0, 0.0), (dur_a, dur_b)]
    for item in anchors_sec:
        if isinstance(item, dict):
            ta_s = float(item.get("t_a", 0.0))
            tb_s = float(item.get("t_b", 0.0))
        else:
            ta_s, tb_s = float(item[0]), float(item[1])
        pts.append((float(np.clip(ta_s, 0.0, dur_a)), float(np.clip(tb_s, 0.0, dur_b))))
    pts.sort(key=lambda kv: kv[0])

    # Enforce monotonic timestamps
    clean_a: List[float] = []
    clean_b: List[float] = []
    for ta_s, tb_s in pts:
        if clean_a and abs(ta_s - clean_a[-1]) < 1e-4:
            clean_b[-1] = max(clean_b[-1], tb_s)
        else:
            clean_a.append(ta_s)
            clean_b.append(max(clean_b[-1], tb_s) if clean_b else tb_s)

    t_grid_a = np.arange(ta, dtype=np.float64) / float(fps)
    t_grid_b = np.interp(t_grid_a, np.asarray(clean_a), np.asarray(clean_b))
    frame_map = np.clip(t_grid_b * float(fps), 0.0, max(0.0, tb - 1.0))
    b_aligned = _interp_trajectory_by_map(b, frame_map)
    return b_aligned, frame_map.astype(np.float32), {
        "mode": "anchors",
        "num_anchors": len(clean_a),
        "frames_a": int(ta),
        "frames_b": int(tb),
        "dur_ratio": round(float(tb) / max(1.0, float(ta)), 3),
    }


def parse_textgrid_boundaries(textgrid_str: str) -> List[Tuple[float, str]]:
    """Minimal pure-Python Praat TextGrid first-interval-tier parser returning `[(xmax_sec, label), ...]`."""
    lines = textgrid_str.splitlines()
    out: List[Tuple[float, str]] = []
    in_first_interval_tier = False
    cur_xmax: Optional[float] = None
    for raw in lines:
        s = raw.strip()
        if 'class = "IntervalTier"' in s:
            if in_first_interval_tier:
                break
            in_first_interval_tier = True
            continue
        if not in_first_interval_tier:
            continue
        if s.startswith("xmax ="):
            try:
                cur_xmax = float(s.split("=", 1)[1].strip())
            except Exception:
                cur_xmax = None
        elif s.startswith("text =") and cur_xmax is not None:
            lbl = s.split("=", 1)[1].strip().strip('"')
            out.append((cur_xmax, lbl))
            cur_xmax = None
    return out


def build_timing_morphed_maps(
    ta: int,
    tb: int,
    anchors_sec: Sequence[Tuple[float, float]] | Sequence[dict],
    w_timing_a: np.ndarray,
    *,
    fps: float = 50.0,
    max_frames: int = 750,
) -> Tuple[np.ndarray, np.ndarray, Dict[str, Any]]:
    """Build monotonic `(frame_map_a, frame_map_b)` whose per-segment durations blend A -> B by `w_timing_a`."""
    dur_a = float(ta) / float(fps)
    dur_b = float(tb) / float(fps)
    w_arr = np.clip(np.asarray(w_timing_a, dtype=np.float64), 0.0, 1.0)

    pts: List[Tuple[float, float]] = [(0.0, 0.0), (dur_a, dur_b)]
    for item in anchors_sec:
        if isinstance(item, dict):
            ta_s = float(item.get("t_a", 0.0))
            tb_s = float(item.get("t_b", 0.0))
        else:
            ta_s, tb_s = float(item[0]), float(item[1])
        pts.append((float(np.clip(ta_s, 0.0, dur_a)), float(np.clip(tb_s, 0.0, dur_b))))
    pts.sort(key=lambda kv: kv[0])

    clean_a: List[float] = []
    clean_b: List[float] = []
    for ta_s, tb_s in pts:
        if clean_a and abs(ta_s - clean_a[-1]) < 1e-4:
            clean_b[-1] = max(clean_b[-1], tb_s)
        else:
            clean_a.append(ta_s)
            clean_b.append(max(clean_b[-1], tb_s) if clean_b else tb_s)

    if len(clean_a) < 2:
        clean_a = [0.0, dur_a]
        clean_b = [0.0, dur_b]

    clean_out: List[float] = [0.0]
    min_seg_sec = 1.0 / float(fps)
    for k in range(len(clean_a) - 1):
        da = max(1e-4, clean_a[k + 1] - clean_a[k])
        db = max(1e-4, clean_b[k + 1] - clean_b[k])
        i0 = int(np.clip(np.floor(clean_a[k] * fps), 0, max(0, ta - 1)))
        i1 = int(np.clip(np.ceil(clean_a[k + 1] * fps), i0 + 1, ta))
        wk = float(np.mean(w_arr[i0:i1])) if i1 > i0 else float(w_arr[min(len(w_arr) - 1, i0)])
        d_out = max(min_seg_sec, (1.0 - wk) * da + wk * db)
        clean_out.append(clean_out[-1] + d_out)

    dur_out = float(clean_out[-1])
    t_out = int(np.clip(round(dur_out * fps), 2, max_frames))
    t_grid_out = np.linspace(0.0, dur_out, t_out, endpoint=False) if t_out > 1 else np.zeros(1, dtype=np.float64)

    arr_out = np.asarray(clean_out, dtype=np.float64)
    arr_a = np.asarray(clean_a, dtype=np.float64)
    arr_b = np.asarray(clean_b, dtype=np.float64)
    t_grid_a = np.interp(t_grid_out, arr_out, arr_a)
    t_grid_b = np.interp(t_grid_out, arr_out, arr_b)

    frame_map_a = np.clip(t_grid_a * float(fps), 0.0, max(0.0, ta - 1.0)).astype(np.float32)
    frame_map_b = np.clip(t_grid_b * float(fps), 0.0, max(0.0, tb - 1.0)).astype(np.float32)
    return frame_map_a, frame_map_b, {
        "mode": "anchors_timing",
        "num_anchors": len(clean_a),
        "frames_a": int(ta),
        "frames_b": int(tb),
        "frames_out": int(t_out),
        "dur_a_sec": round(dur_a, 3),
        "dur_b_sec": round(dur_b, 3),
        "dur_out_sec": round(t_out / float(fps), 3),
        "dur_ratio": round(float(t_out) / max(1.0, float(ta)), 3),
    }


def _interp_trajectory_by_map(traj: np.ndarray, frame_map: np.ndarray) -> np.ndarray:
    n_src, dims = traj.shape
    src_x = np.arange(n_src, dtype=np.float64)
    out = np.empty((len(frame_map), dims), dtype=np.float32)
    for col in range(dims):
        out[:, col] = np.interp(frame_map, src_x, traj[:, col].astype(np.float64)).astype(np.float32)
    return out
