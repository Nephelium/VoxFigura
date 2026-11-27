"""Time-varying automation curves, anti-click smoothing, voicing/silence gating, and F0 coupling."""
from __future__ import annotations

from typing import Iterable, List, Optional, Sequence, Tuple

import numpy as np

from .presets import F0_INDEX, PR_INDEX


def sample_curve_50hz(
    knots: Sequence[Tuple[float, float]] | Sequence[dict],
    n_frames: int,
    *,
    fps: float = 50.0,
    default_value: float = 0.0,
    interp_mode: str = "linear",
) -> np.ndarray:
    """Sample user control knots `(t_norm_or_sec, value)` onto a 50 Hz frame grid in `[0, 1]`.

    Knots accept either:
      - list of `(t_norm, v)` tuples where `t_norm` is in `[0, 1]`
      - list of `{"t": float, "v": float}` dicts (`t` in `[0, 1]` normalized time)
    """
    n_frames = max(1, int(n_frames))
    if not knots:
        return np.full((n_frames,), float(np.clip(default_value, 0.0, 1.0)), dtype=np.float32)

    pairs: List[Tuple[float, float]] = []
    for k in knots:
        if isinstance(k, dict):
            t_v = float(k.get("t", 0.0))
            v_v = float(k.get("v", default_value))
        else:
            t_v, v_v = float(k[0]), float(k[1])
        pairs.append((float(np.clip(t_v, 0.0, 1.0)), float(np.clip(v_v, 0.0, 1.0))))
    pairs.sort(key=lambda kv: kv[0])

    # Deduplicate coincident timestamps by averaging
    ts: List[float] = []
    vs: List[float] = []
    for t_v, v_v in pairs:
        if ts and abs(t_v - ts[-1]) < 1e-6:
            vs[-1] = 0.5 * (vs[-1] + v_v)
        else:
            ts.append(t_v)
            vs.append(v_v)

    t_grid = np.linspace(0.0, 1.0, n_frames, dtype=np.float64) if n_frames > 1 else np.array([0.0])
    if len(ts) == 1:
        return np.full((n_frames,), float(vs[0]), dtype=np.float32)

    t_arr = np.asarray(ts, dtype=np.float64)
    v_arr = np.asarray(vs, dtype=np.float64)
    if interp_mode == "smoothstep":
        # Cosine easing between adjacent knots, shared with the canvas preview.
        out = np.empty(n_frames, dtype=np.float64)
        for i, tg in enumerate(t_grid):
            if tg <= t_arr[0]:
                out[i] = v_arr[0]
            elif tg >= t_arr[-1]:
                out[i] = v_arr[-1]
            else:
                j = int(np.searchsorted(t_arr, tg, side="right")) - 1
                j = max(0, min(len(t_arr) - 2, j))
                u = (tg - t_arr[j]) / max(1e-9, t_arr[j + 1] - t_arr[j])
                u_s = 0.5 - 0.5 * np.cos(np.pi * u)
                out[i] = (1.0 - u_s) * v_arr[j] + u_s * v_arr[j + 1]
        return np.clip(out, 0.0, 1.0).astype(np.float32)

    out = np.interp(t_grid, t_arr, v_arr, left=v_arr[0], right=v_arr[-1])
    return np.clip(out, 0.0, 1.0).astype(np.float32)


def smooth_curve_anti_click(
    curve: np.ndarray,
    *,
    smooth_ms: float = 25.0,
    fps: float = 50.0,
) -> np.ndarray:
    """Apply gentle Gaussian smoothing (~20-30 ms) to prevent abrupt parameter jumps and synthesis clicks."""
    arr = np.asarray(curve, dtype=np.float32).reshape(-1)
    n = arr.shape[0]
    if n <= 2 or smooth_ms <= 0.5:
        return arr.copy()

    # Convert full-width half-max style smooth_ms to Gaussian sigma in frames (50 Hz -> 20 ms/frame)
    sigma_frames = max(0.35, (float(smooth_ms) / 1000.0) * float(fps) * 0.5)
    radius = max(1, int(np.ceil(3.0 * sigma_frames)))
    radius = min(radius, max(1, n - 1))
    offs = np.arange(-radius, radius + 1, dtype=np.float64)
    kernel = np.exp(-0.5 * (offs / sigma_frames) ** 2)
    kernel /= kernel.sum()

    padded = np.pad(arr.astype(np.float64), (radius, radius), mode="edge")
    smoothed = np.convolve(padded, kernel, mode="valid")[:n]
    return np.clip(smoothed, 0.0, 1.0).astype(np.float32)


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -30.0, 30.0)))


def compute_voicing_and_speech_gates(
    m27_phys: np.ndarray,
    *,
    f0_voiced: Optional[np.ndarray] = None,
    pr_threshold_dpa: float = 950.0,
    ra_threshold: float = 0.22,
    edge_smooth_ms: float = 24.0,
    fps: float = 50.0,
) -> Tuple[np.ndarray, np.ndarray]:
    """Compute soft per-frame `[0, 1]` gates protecting silence and unvoiced consonants.

    Returns:
        voiced_gate: `[0, 1]` high only on actively phonating voiced frames (vowels / voiced consonants).
                     Protects both silence AND voiceless consonants (/s/, /t/, /p/, /ʂ/) from accidental voicing.
        speech_gate: `[0, 1]` high on any non-silent speech frame (including voiceless fricatives/aspiration).
                     Used when the target preset itself is whisper or voiceless.
    """
    arr = np.asarray(m27_phys, dtype=np.float32)
    n = arr.shape[0]
    pr = arr[:, PR_INDEX].astype(np.float64)
    ra = arr[:, 23].astype(np.float64)  # RA = glottal vibration amplitude

    pr_gate = _sigmoid((pr - float(pr_threshold_dpa)) / 320.0)
    ra_gate = _sigmoid((ra - float(ra_threshold)) / 0.08)

    if f0_voiced is not None and len(f0_voiced) >= n:
        fv = np.asarray(f0_voiced[:n], dtype=np.float64)
        # Blend physical RA evidence with SwiftF0 periodicity so mild breathy/creaky vowels still pass cleanly
        periodicity = np.maximum(ra_gate, 0.75 * np.clip(fv, 0.0, 1.0))
        raw_voiced = pr_gate * periodicity
    else:
        raw_voiced = pr_gate * ra_gate

    raw_speech = pr_gate

    voiced_gate = smooth_curve_anti_click(raw_voiced.astype(np.float32), smooth_ms=edge_smooth_ms, fps=fps)
    speech_gate = smooth_curve_anti_click(raw_speech.astype(np.float32), smooth_ms=edge_smooth_ms, fps=fps)
    return voiced_gate, speech_gate


class F0ShiftOutOfRange(ValueError):
    def __init__(self, hz: float):
        self.hz = hz
        super().__init__(f"调制后的基频为 {hz:.2f} Hz，超出允许范围")


def apply_f0_semitone_coupling(
    f0_hz: np.ndarray,
    eff_weight: np.ndarray,
    *,
    semitones: float,
    strength: float = 1.0,
    f0_min: Optional[float] = None,
    f0_max: Optional[float] = None,
    output_range_hz: Optional[Tuple[float, float]] = None,
) -> np.ndarray:
    """Shift log-F0 smoothly by `eff_weight(t) * semitones * strength` semitones."""
    f0 = np.maximum(np.asarray(f0_hz, dtype=np.float64), 1e-3)
    if f0_min is not None or f0_max is not None:
        f0 = np.clip(f0, f0_min if f0_min is not None else 1e-3, f0_max if f0_max is not None else np.inf)
    w = np.clip(np.asarray(eff_weight, dtype=np.float64), 0.0, 1.0)
    delta_st = float(semitones) * float(strength)
    if abs(delta_st) < 1e-6:
        return f0.astype(np.float32)
    shifted = f0 * np.power(2.0, (w * delta_st) / 12.0)
    if output_range_hz is not None:
        lo, hi = output_range_hz
        # A model-estimated low baseline can remain as-is or move towards range.
        invalid = (shifted < np.minimum(lo, f0) - 1e-3) | (shifted > np.maximum(hi, f0) + 1e-3)
        if np.any(invalid):
            raise F0ShiftOutOfRange(float(shifted[np.flatnonzero(invalid)[0]]))
    if f0_min is not None or f0_max is not None:
        shifted = np.clip(shifted, f0_min if f0_min is not None else 1e-3, f0_max if f0_max is not None else np.inf)
    return shifted.astype(np.float32)


def slerp_speaker_sequence(
    emb_a: np.ndarray,
    emb_b: np.ndarray,
    weight_curve: np.ndarray,
) -> np.ndarray:
    """Frame-wise spherical linear interpolation (SLERP) between two L2-normalized 512-d speaker embeddings.

    Returns:
        `(T, 512)` float32 L2-normalized speaker embedding trajectory.
    """
    a = np.asarray(emb_a, dtype=np.float64).reshape(-1)
    b = np.asarray(emb_b, dtype=np.float64).reshape(-1)
    a = a / max(1e-8, float(np.linalg.norm(a)))
    b = b / max(1e-8, float(np.linalg.norm(b)))
    w = np.clip(np.asarray(weight_curve, dtype=np.float64).reshape(-1), 0.0, 1.0)

    dot = float(np.clip(np.dot(a, b), -1.0, 1.0))
    if dot > 0.9995:
        seq = (1.0 - w)[:, None] * a[None, :] + w[:, None] * b[None, :]
    else:
        omega = float(np.arccos(dot))
        sin_o = float(np.sin(omega))
        c_a = np.sin((1.0 - w) * omega) / sin_o
        c_b = np.sin(w * omega) / sin_o
        seq = c_a[:, None] * a[None, :] + c_b[:, None] * b[None, :]

    norms = np.linalg.norm(seq, axis=1, keepdims=True)
    seq = seq / np.maximum(norms, 1e-8)
    return seq.astype(np.float32)
