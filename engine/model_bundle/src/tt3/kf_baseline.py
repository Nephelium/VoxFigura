"""Mask-aware asynchronous 3rd-order Target Approximation baseline & 111-dim condition builder.

Pure NumPy (zero PyTorch dependency) so training, evaluation, desktop PhoneticToolbox, and
browser WASM/TypeScript runtimes stay bit-compatible with zero train/inference skew.
"""
from __future__ import annotations

from typing import Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np
try:
    from scipy.signal import lfilter as _scipy_lfilter, lfilter_zi as _scipy_lfilter_zi
except Exception:  # pragma: no cover - pure-NumPy fallback when scipy is absent
    _scipy_lfilter = None
    _scipy_lfilter_zi = None

from .kf_phonetics import (
    KF26_INDEX,
    KF26_NAMES,
    KF26_TO_M27_IDX,
    M27_F0_IDX,
    PHON_FEAT_DIM,
    SegmentEvent,
    default_organ_mask,
    ipa_to_phon_features,
    ipa_to_phon_features_checked,
)

# Condition tensor layout at 50 Hz (20 ms/frame):
#   0..25   : x_base      (26)  mask-bridged async qTA baseline in [-1, 1]
#   26..51  : g_masked    (26)  g_pose * w_mask in [-1, 1] (zero leakage when w==0!)
#   52..77  : w_mask      (26)  organ & glottis constraint weights in [0, 1]
#   78      : f0_norm     (1)   read-only log-F0 in [-1, 1]
#   79..83  : phase       (5)   [u_norm, dt_start_s/0.5, dt_end_s/0.5, log(dur/0.1), is_sil]
#   84..87  : events      (4)   [is_closure, is_release, is_aspiration, is_voiced_target]
#   88..109 : phon_feat   (22)  universal articulatory features
#   110     : has_phon    (1)   1.0 if phonetic features are supplied, 0.0 for unlabeled mask mode
KF_COND_DIM = 26 + 26 + 26 + 1 + 5 + 4 + PHON_FEAT_DIM + 1  # 111
KF_OUT_DIM = 26

# Neutral normalized [-1, 1] fallback when an entire utterance leaves a channel unspecified (w==0)
# Derived from DEFAULT_M27_PAD_ROW in m27_contract.py
DEFAULT_KF26_NEUTRAL_NORM = np.array(
    [
        0.0, 0.0, 0.0, 0.0, 0.0, -0.1667, 0.0, -1.0,
        -0.1429, 0.0, -0.1667, -0.0909, -0.0526, -0.125, 0.0, 0.0, 0.0,
        -1.0, -0.0286, -0.0286, 0.2, -0.222, 0.0, 0.5, -1.0, -1.0,
    ],
    dtype=np.float32,
)

# Organ-grouped physical time constants (seconds) for 3rd-order critically damped qTA
# Slow vocalic backdrop: HX, HY, JX, JA, TCX, TCY
# Anticipatory coarticulators: LP, VO
# Fast primary constrictors: LD, VS, TTX, TTY, TBX, TBY, TS1, TS2, TS3
# Fast glottal valves: PR, XB, XT, CA, RA
# Slow voice-quality timbre: LAG, PS, FL, SHIM
KF26_TAU_SEC = np.array(
    [
        0.026, 0.026, 0.026, 0.026,  # HX, HY, JX, JA
        0.022, 0.013, 0.015, 0.022,  # LP, LD, VS, VO
        0.026, 0.026,                # TCX, TCY
        0.013, 0.013, 0.014, 0.014,  # TTX, TTY, TBX, TBY
        0.015, 0.015, 0.015,         # TS1, TS2, TS3
        0.006, 0.006, 0.006, 0.006,  # PR, XB, XT, CA
        0.020, 0.006, 0.020, 0.020, 0.020,  # LAG, RA, PS, FL, SHIM
    ],
    dtype=np.float64,
)

# Extra anticipatory lookahead (seconds) applied ONLY on LP (lip protrusion) & VO (velopharyngeal opening)
KF26_EXTRA_ANTICIPATION_SEC = np.zeros(KF_OUT_DIM, dtype=np.float64)
KF26_EXTRA_ANTICIPATION_SEC[KF26_INDEX["LP"]] = 0.015
KF26_EXTRA_ANTICIPATION_SEC[KF26_INDEX["VO"]] = 0.015


_QTA3_ZOH_CACHE: Dict[Tuple[float, float], Tuple[np.ndarray, np.ndarray, np.ndarray]] = {}


def _get_qta3_zoh_coeffs(dt: float, tau: float) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Exact zero-order-hold IIR coefficients for G(s)=lam^3/(s+lam)^3 (matches analytical form to ~1e-14)."""
    key = (float(dt), float(tau))
    cached = _QTA3_ZOH_CACHE.get(key)
    if cached is not None:
        return cached
    lam = 1.0 / max(1e-4, float(tau))
    e = float(np.exp(-lam * dt))
    ld = lam * dt
    a = np.array([1.0, -3.0 * e, 3.0 * e * e, -e * e * e], dtype=np.float64)
    s1 = 1.0 - (1.0 + ld + 0.5 * ld * ld) * e
    s2 = 1.0 - (1.0 + 2.0 * ld + 2.0 * ld * ld) * (e * e)
    s3 = 1.0 - (1.0 + 3.0 * ld + 4.5 * ld * ld) * (e * e * e)
    h1, h2, h3 = s1, s2 - s1, s3 - s2
    b1 = h1
    b2 = h2 + a[1] * h1
    b3 = h3 + a[1] * h2 + a[2] * h1
    b = np.array([0.0, b1, b2, b3], dtype=np.float64)
    zi = _scipy_lfilter_zi(b, a)
    _QTA3_ZOH_CACHE[key] = (b, a, zi)
    return b, a, zi


def _qta_3rd_order_1d(col: np.ndarray, dt: float, tau: float) -> np.ndarray:
    """Exact 3rd-order critically damped qTA filter on a 1-D piecewise-constant target.

    Uses bit-exact C-level ZOH IIR via scipy.signal.lfilter (~28x faster, max diff ~1e-14 in float64
    and 0.0 in float32) with an automatic pure-NumPy analytical fallback.
    """
    n = col.shape[0]
    if n == 0:
        return np.empty(0, dtype=np.float64)
    if _scipy_lfilter is not None and _scipy_lfilter_zi is not None:
        b, a, zi = _get_qta3_zoh_coeffs(dt, tau)
        out, _ = _scipy_lfilter(b, a, col, zi=zi * float(col[0]))
        return out
    out = np.empty(n, dtype=np.float64)
    lam = 1.0 / max(1e-4, float(tau))
    y0 = float(col[0])
    yp0 = 0.0
    ypp0 = 0.0
    changes = np.flatnonzero(np.abs(np.diff(col)) > 1e-7) + 1
    bounds = np.concatenate(([0], changes, [n]))
    for i in range(len(bounds) - 1):
        a_i, b_i = int(bounds[i]), int(bounds[i + 1])
        target_val = float(col[a_i])
        t = np.arange(b_i - a_i, dtype=np.float64) * dt
        c0 = y0 - target_val
        c1 = yp0 + lam * c0
        c2 = 0.5 * ypp0 + lam * yp0 + 0.5 * (lam ** 2) * c0
        exp_lt = np.exp(-lam * t)
        out[a_i:b_i] = target_val + (c0 + c1 * t + c2 * (t ** 2)) * exp_lt

        t_end = float(b_i - a_i) * dt
        e_end = float(np.exp(-lam * t_end))
        p_end = c0 + c1 * t_end + c2 * (t_end ** 2)
        dp_end = c1 + 2.0 * c2 * t_end
        d2p_end = 2.0 * c2
        y0 = target_val + p_end * e_end
        yp0 = (dp_end - lam * p_end) * e_end
        ypp0 = (d2p_end - 2.0 * lam * dp_end + (lam ** 2) * p_end) * e_end
    return out


def bridge_masked_targets_50hz(
    kf_targets_26: np.ndarray,
    kf_masks_26: np.ndarray,
    *,
    anchor_thresh: float = 0.25,
    neutral_norm: np.ndarray = DEFAULT_KF26_NEUTRAL_NORM,
) -> np.ndarray:
    """Bridge don't-care (w == 0) spans linearly between neighboring specified anchors per channel.

    Guarantees exact zero leakage for any frame/dim with w == 0: kf_targets_26[t, d] is never
    read when kf_masks_26[t, d] == 0.
    """
    tgt = np.asarray(kf_targets_26, dtype=np.float32)
    msk = np.clip(np.asarray(kf_masks_26, dtype=np.float32), 0.0, 1.0)
    n_frames, n_dims = tgt.shape
    out = np.empty((n_frames, n_dims), dtype=np.float32)
    if n_frames == 0:
        return out

    idx_all = np.arange(n_frames, dtype=np.float64)
    for d in range(n_dims):
        w = msk[:, d]
        y = tgt[:, d]
        strong = np.flatnonzero(w >= anchor_thresh)
        if strong.size == 0:
            any_pos = np.flatnonzero(w > 1e-6)
            if any_pos.size == 0:
                out[:, d] = neutral_norm[d]
                continue
            strong = any_pos

        bridged = np.interp(idx_all, strong.astype(np.float64), y[strong].astype(np.float64))
        # Blend soft-weighted frames (0 < w < anchor_thresh) proportionally; w==0 stays 100% bridged
        soft = (w > 1e-6) & (w < anchor_thresh)
        if np.any(soft):
            blend = (w[soft] / anchor_thresh).astype(np.float64)
            bridged[soft] = (1.0 - blend) * bridged[soft] + blend * y[soft].astype(np.float64)
        out[:, d] = bridged.astype(np.float32)
    return out


def compute_async_baseline_50hz(
    kf_targets_26: np.ndarray,
    kf_masks_26: np.ndarray,
    *,
    tau_sec: np.ndarray = KF26_TAU_SEC,
    extra_anticipation_sec: np.ndarray = KF26_EXTRA_ANTICIPATION_SEC,
) -> np.ndarray:
    """Compute organ-asynchronous, zero-lag 3rd-order qTA baseline trajectory at 50 Hz.

    Upsamples internally to 200 Hz (5 ms/step) with per-organ time constant tau_d and
    group-delay cancellation (2.5 * tau_d + extra_anticipation_d), then center-samples 50 Hz.
    """
    bridged = bridge_masked_targets_50hz(kf_targets_26, kf_masks_26)
    n50, n_dims = bridged.shape
    if n50 <= 1:
        return np.clip(bridged, -1.0, 1.0).astype(np.float32)

    dt = 0.005  # 200 Hz internal kinematics
    held = np.repeat(bridged.astype(np.float64), 4, axis=0)
    n200 = held.shape[0]
    out200 = np.empty_like(held)

    for d in range(n_dims):
        tau = float(tau_sec[d])
        ant = float(extra_anticipation_sec[d])
        # Zero-lag anticipation cancels 3rd-order causal group delay (~2.5 * tau)
        shift = max(0, int(round((2.5 * tau + ant) / dt)))
        col = held[:, d]
        if shift > 0:
            if shift < n200:
                col_shifted = np.concatenate([col[shift:], np.full(shift, col[-1], dtype=np.float64)])
            else:
                col_shifted = np.full(n200, col[-1], dtype=np.float64)
        else:
            col_shifted = col
        out200[:, d] = _qta_3rd_order_1d(col_shifted, dt, tau)

    # Center-sample 50 Hz frames (aligned to 20 ms WavLM / M27 grid)
    out50 = np.clip(out200[1::4], -1.0, 1.0).astype(np.float32)
    return out50


def build_condition_from_segments(
    segments: Sequence[SegmentEvent],
    n_frames: int,
    f0_norm_50hz: np.ndarray,
    pose_lookup: Callable[[SegmentEvent], np.ndarray],
    *,
    mask_override: Optional[Callable[[SegmentEvent, np.ndarray], np.ndarray]] = None,
    pose_perturb_fn: Optional[Callable[[np.ndarray, np.ndarray, SegmentEvent], np.ndarray]] = None,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Expand time-aligned SegmentEvents onto the 50 Hz grid and build (cond_111, x_base_26, w_mask_26, events_4).

    Args:
        segments: ordered SegmentEvent sequence covering [0, n_frames * 0.02] s.
        n_frames: target 50 Hz length T.
        f0_norm_50hz: (T,) normalized log-F0 in [-1, 1].
        pose_lookup: returns canonical normalized (26,) target pose for a SegmentEvent.
        mask_override: optional hook (seg, default_w26) -> custom_w26 (e.g. user pinned phonation).
        pose_perturb_fn: optional training-time augmentation (pose26, w26, seg) -> augmented_pose26.

    Returns:
        cond_111 : (T, 111) float32 model input tensor
        x_base   : (T, 26)  float32 mask-bridged async qTA baseline in [-1, 1]
        w_mask   : (T, 26)  float32 organ constraint mask in [0, 1]
        events_4 : (T, 4)   float32 [is_closure, is_release, is_aspiration, is_voiced]
    """
    t_len = int(n_frames)
    f0 = np.asarray(f0_norm_50hz, dtype=np.float32).reshape(t_len)

    g_pose = np.repeat(DEFAULT_KF26_NEUTRAL_NORM[None, :], t_len, axis=0)
    w_mask = np.zeros((t_len, KF_OUT_DIM), dtype=np.float32)
    phase = np.zeros((t_len, 5), dtype=np.float32)
    events = np.zeros((t_len, 4), dtype=np.float32)
    phon = np.zeros((t_len, PHON_FEAT_DIM), dtype=np.float32)
    has_phon = np.ones((t_len, 1), dtype=np.float32)

    # Frame centers in seconds: (k + 0.5) * 0.02
    frame_times = (np.arange(t_len, dtype=np.float64) + 0.5) * 0.02

    # Default uncovered frames to silence
    phase[:, 4] = 1.0
    phon[:, 0] = 1.0

    for seg in segments:
        if seg.end_sec <= seg.start_sec:
            continue
        in_seg = (frame_times >= seg.start_sec) & (frame_times < seg.end_sec)
        idxs = np.flatnonzero(in_seg)
        if idxs.size == 0:
            # Keep very short bursts/releases (< 20 ms) visible on the nearest single frame
            mid = 0.5 * (seg.start_sec + seg.end_sec)
            nearest = int(np.clip(np.floor(mid / 0.02), 0, t_len - 1))
            idxs = np.array([nearest], dtype=np.int64)

        w26 = default_organ_mask(
            seg.ipa,
            is_closure=seg.is_closure,
            is_release=seg.is_release,
            is_aspiration=seg.is_aspiration,
            is_sil=seg.is_sil,
            phonation_pinned=seg.phonation_pinned,
        )
        if mask_override is not None:
            w26 = np.clip(np.asarray(mask_override(seg, w26), dtype=np.float32), 0.0, 1.0)

        p26 = np.clip(np.asarray(pose_lookup(seg), dtype=np.float32), -1.0, 1.0)
        if pose_perturb_fn is not None:
            p26 = np.clip(np.asarray(pose_perturb_fn(p26, w26, seg), dtype=np.float32), -1.0, 1.0)

        dur = max(0.01, seg.duration)
        log_dur = float(np.clip(np.log(dur / 0.10), -2.0, 2.0))
        ft = frame_times[idxs]
        dt_start = np.clip(ft - seg.start_sec, 0.0, 0.5) / 0.5
        dt_end = np.clip(seg.end_sec - ft, 0.0, 0.5) / 0.5
        u = np.clip((ft - seg.start_sec) / dur, 0.0, 1.0)

        g_pose[idxs] = p26[None, :]
        w_mask[idxs] = w26[None, :]
        phase[idxs, 0] = u.astype(np.float32)
        phase[idxs, 1] = dt_start.astype(np.float32)
        phase[idxs, 2] = dt_end.astype(np.float32)
        phase[idxs, 3] = log_dur
        phase[idxs, 4] = 1.0 if seg.is_sil else 0.0

        events[idxs, 0] = 1.0 if seg.is_closure else 0.0
        events[idxs, 1] = 1.0 if seg.is_release else 0.0
        events[idxs, 2] = 1.0 if seg.is_aspiration else 0.0
        events[idxs, 3] = 1.0 if seg.is_voiced else 0.0

        pf, matched = ipa_to_phon_features_checked(seg.ipa)
        phon[idxs] = pf[None, :]
        if not matched:
            # Unknown / custom pose label -> cleanly drop into pure articulatory-pose mode (has_phon = 0.0)
            has_phon[idxs, 0] = 0.0

    x_base = compute_async_baseline_50hz(g_pose, w_mask)
    # Exact zero-leakage masking: zero-weight dims become identically 0.0 in model input!
    g_masked = g_pose * w_mask

    cond = np.concatenate(
        [x_base, g_masked, w_mask, f0[:, None], phase, events, phon, has_phon],
        axis=-1,
    ).astype(np.float32)
    return cond, x_base, w_mask, events


def build_condition_from_sparse_anchors(
    anchor_spans: Sequence[Tuple[int, int]],
    anchor_poses_26: np.ndarray,
    anchor_masks_26: np.ndarray,
    n_frames: int,
    f0_norm_50hz: np.ndarray,
    *,
    events_4: Optional[np.ndarray] = None,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Build (cond_111, x_base_26, w_mask_26, events_4) for unlabeled sparse-keyframe inpainting.

    Used in Stage K1 (180h multi-phonation synthetic corpus) and Stage K2 expressive voice-quality
    inpainting (GTSinger / emotion corpora without IPA labels). Sets has_phon = 0.0 cleanly.
    """
    t_len = int(n_frames)
    f0 = np.asarray(f0_norm_50hz, dtype=np.float32).reshape(t_len)
    g_pose = np.repeat(DEFAULT_KF26_NEUTRAL_NORM[None, :], t_len, axis=0)
    w_mask = np.zeros((t_len, KF_OUT_DIM), dtype=np.float32)
    phase = np.zeros((t_len, 5), dtype=np.float32)
    ev = np.zeros((t_len, 4), dtype=np.float32) if events_4 is None else np.asarray(events_4, dtype=np.float32).copy()
    phon = np.zeros((t_len, PHON_FEAT_DIM), dtype=np.float32)
    has_phon = np.zeros((t_len, 1), dtype=np.float32)

    for k, (s_idx, e_idx) in enumerate(anchor_spans):
        a = max(0, int(s_idx))
        b = min(t_len, int(e_idx))
        if b <= a:
            continue
        dur = max(0.02, (b - a) * 0.02)
        log_dur = float(np.clip(np.log(dur / 0.10), -2.0, 2.0))
        local = np.arange(b - a, dtype=np.float32)
        u = (local + 0.5) / float(b - a)
        dt_start = np.clip((local + 0.5) * 0.02, 0.0, 0.5) / 0.5
        dt_end = np.clip(((b - a) - local - 0.5) * 0.02, 0.0, 0.5) / 0.5

        g_pose[a:b] = np.clip(anchor_poses_26[k], -1.0, 1.0)[None, :]
        w_mask[a:b] = np.clip(anchor_masks_26[k], 0.0, 1.0)[None, :]
        phase[a:b, 0] = u
        phase[a:b, 1] = dt_start
        phase[a:b, 2] = dt_end
        phase[a:b, 3] = log_dur
        # Mark silence if PR target is locked low (near -1.0)
        is_sil = bool(w_mask[a, KF26_INDEX["PR"]] > 0.5 and g_pose[a, KF26_INDEX["PR"]] < -0.92)
        phase[a:b, 4] = 1.0 if is_sil else 0.0
        if events_4 is None:
            is_voiced = bool(not is_sil and g_pose[a, KF26_INDEX["RA"]] > 0.05)
            ev[a:b, 3] = 1.0 if is_voiced else 0.0

    x_base = compute_async_baseline_50hz(g_pose, w_mask)
    g_masked = g_pose * w_mask
    cond = np.concatenate(
        [x_base, g_masked, w_mask, f0[:, None], phase, ev, phon, has_phon],
        axis=-1,
    ).astype(np.float32)
    return cond, x_base, w_mask, ev


def m27_to_kf26(m27: np.ndarray) -> np.ndarray:
    """Slice 26 predicted channels [tract17, PR, glottis8] out of canonical (..., 27) M27."""
    return np.asarray(m27)[..., KF26_TO_M27_IDX]


def kf26_and_f0_to_m27(kf26: np.ndarray, f0: np.ndarray) -> np.ndarray:
    """Reassemble canonical (..., 27) M27 from (..., 26) kf26 and (...,) or (..., 1) F0."""
    arr = np.asarray(kf26, dtype=np.float32)
    f0_arr = np.asarray(f0, dtype=np.float32)
    if f0_arr.ndim == arr.ndim - 1:
        f0_arr = f0_arr[..., None]
    return np.concatenate([arr[..., :17], f0_arr, arr[..., 17:]], axis=-1).astype(np.float32)


__all__ = [
    "DEFAULT_KF26_NEUTRAL_NORM",
    "KF26_EXTRA_ANTICIPATION_SEC",
    "KF26_TAU_SEC",
    "KF_COND_DIM",
    "KF_OUT_DIM",
    "bridge_masked_targets_50hz",
    "build_condition_from_segments",
    "build_condition_from_sparse_anchors",
    "compute_async_baseline_50hz",
    "kf26_and_f0_to_m27",
    "m27_to_kf26",
]
