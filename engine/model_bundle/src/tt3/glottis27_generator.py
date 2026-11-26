"""Zero-PyTorch, full-native 27-dim M10 R21 (JD2, 65-section) synthetic speech generator.

Covers all 17 independent supraglottal tract parameters + all 9 native Geometric glottis 2025
parameters + M10 shimmer across exact native JD2.speaker ranges and diverse phonation regimes
(modal, breathy, pressed, creaky, falsetto, whisper, full-box explore, and intra-utterance morphs).
"""
from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor, as_completed
import json
import os
from pathlib import Path
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from scipy.signal import resample_poly

from .tract_anim import open_jd2_engine

TRAIN_ROOT = Path(__file__).resolve().parents[2]
STATES_DEFAULT_PATH = TRAIN_ROOT / "data" / "states" / "states_jd2_r21.npz"

SAMPLE_RATE_48K = 48000
SAMPLE_RATE_16K = 16000
CONTROL_HZ_200 = 200
CONTROL_HZ_50 = 50
R21_STEP_SAMPLES_48K = 240  # 5 ms @ 48 kHz
WAVLM_HOP_SAMPLES = 320     # 20 ms @ 16 kHz

# 17 independent supraglottal indices inside JD2's 19-dim vector (TRX=14, TRY=15 auto-computed)
TRACT_17_TO_19_IDX = np.array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18], dtype=np.int64)

SCHEMA_VERSION = "m27_native_v1"

M27_NAMES: Tuple[str, ...] = (
    # 0..16: 17 independent supraglottal tract dims
    "HX", "HY", "JX", "JA", "LP", "LD", "VS", "VO",
    "TCX", "TCY", "TTX", "TTY", "TBX", "TBY", "TS1", "TS2", "TS3",
    # 17..25: 9 native Geometric glottis 2025 dims (exact Engine.gnames order)
    "F0", "PR", "XB", "XT", "CA", "LAG", "RA", "PS", "FL",
    # 26: M10 dynamic source perturbation shimmer
    "SHIM",
)

# Exact native JD2.speaker bounds (verified via Engine("JD2").minimum/maximum/gmin/gmax) + shimmer 0..100
M27_MIN = np.array(
    [
        0.0, -6.0, -0.5, -7.0, -1.0, -2.0, 0.0, -0.1,
        -3.0, -3.0, 1.5, -3.0, -3.0, -3.0, 0.0, 0.0, -1.0,
        40.0, 0.0, -0.05, -0.05, -0.25, 0.0, -1.0, -1.0, 0.0,
        0.0,
    ],
    dtype=np.float64,
)

M27_MAX = np.array(
    [
        1.0, -3.5, 0.0, 0.0, 1.0, 4.0, 1.0, 1.5,
        4.0, 1.0, 7.5, 2.5, 6.5, 5.0, 1.0, 1.0, 1.0,
        600.0, 16000.0, 0.30, 0.30, 0.25, 3.1415, 1.0, 1.0, 100.0,
        100.0,
    ],
    dtype=np.float64,
)

_TRACT_SPAN = M27_MAX[:17] - M27_MIN[:17]

TAU_TRACT_SEC = 0.015
TAU_F0_SEC = 0.020
TAU_GLOTTIS_FAST_SEC = 0.006
TAU_QUALITY_SEC = 0.018

_GLOTTIS_FAST_IDX = [18, 19, 20, 21, 23]  # PR, XB, XT, CA, RA
_QUALITY_IDX = [22, 24, 25, 26]           # LAG, PS, FL, SHIM

SINGLE_REGIME_NAMES: Tuple[str, ...] = (
    "modal",
    "breathy",
    "pressed",
    "creaky",
    "falsetto",
    "whisper",
    "explore",
)
SINGLE_REGIME_PROBS = np.array([0.26, 0.16, 0.15, 0.16, 0.17, 0.05, 0.05], dtype=np.float64)
MORPH_REGIME_POOL: Tuple[str, ...] = ("modal", "breathy", "pressed", "creaky", "falsetto", "whisper")
ALL_REGIME_TAGS: Tuple[str, ...] = SINGLE_REGIME_NAMES + ("morph",)


def target_approximation_filter(
    targets: np.ndarray,
    dt: float,
    tau: float,
) -> np.ndarray:
    """Analytical 3rd-order critically damped Target Approximation Model filter (Xu & Wang 2001)."""
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


def m27_to_vtl19_glottis9_shimmer(
    m27_seq: np.ndarray,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Expand (..., 27) control sequence into JD2 (..., 19) tract, (..., 9) glottis, and (...,) shimmer."""
    arr = np.asarray(m27_seq, dtype=np.float64)
    if arr.shape[-1] != 27:
        raise ValueError(f"期望最后一维为 27，收到 {arr.shape}")
    tract17 = np.clip(arr[..., :17], M27_MIN[:17], M27_MAX[:17])
    tract19 = np.zeros(arr.shape[:-1] + (19,), dtype=np.float64)
    tract19[..., TRACT_17_TO_19_IDX] = tract17
    glottis9 = np.clip(arr[..., 17:26], M27_MIN[17:26], M27_MAX[17:26])
    shimmer = np.clip(arr[..., 26], M27_MIN[26], M27_MAX[26])
    return tract19, glottis9, shimmer


def promote_m22_to_m27(m22_seq: np.ndarray) -> np.ndarray:
    """Promote legacy 22-dim synth_100h controls into the canonical 27-dim full-native layout."""
    arr = np.asarray(m22_seq, dtype=np.float64)
    if arr.shape[-1] != 22:
        raise ValueError(f"期望最后一维为 22，收到 {arr.shape}")
    out = np.empty(arr.shape[:-1] + (27,), dtype=np.float64)
    out[..., :17] = arr[..., :17]
    out[..., 17] = arr[..., 21]       # F0
    out[..., 18] = arr[..., 20]       # PR
    out[..., 19] = arr[..., 17]       # XB
    out[..., 20] = arr[..., 17]       # XT = XB
    out[..., 21] = arr[..., 18]       # CA
    out[..., 22] = 1.222044           # LAG (JD2 modal neutral)
    out[..., 23] = arr[..., 19]       # RA
    out[..., 24] = 0.5                # PS (JD2 modal/stop preset)
    out[..., 25] = 0.0                # FL (legacy m10 synth flutter=0)
    out[..., 26] = 0.0                # SHIM
    return np.clip(out, M27_MIN, M27_MAX)


class StateBankLoader:
    """Load JD2 tract state bank from states_jd2_r21.npz."""

    def __init__(self, path: Path = STATES_DEFAULT_PATH) -> None:
        with np.load(path, allow_pickle=False) as d:
            self.vowels = np.asarray(d["vowels"], dtype=np.float64)
            self.closures = np.asarray(d["closures"], dtype=np.float64)
            self.fricatives = np.asarray(d["fricatives"], dtype=np.float64)
            self.laterals = np.asarray(d["laterals"], dtype=np.float64)
            self.approximants = np.asarray(d["approximants"], dtype=np.float64)


def _sample_regime_params(regime: str, rng: np.random.Generator) -> Dict[str, Any]:
    """Sample one phonation regime's base parameters inside exact native JD2 bounds."""
    creak_amp = 0.0
    if regime == "modal":
        f0_min, f0_max = 70.0, 280.0
        f0_base = float(rng.uniform(75.0, 250.0))
        pr = float(rng.uniform(4500.0, 12000.0))
        xb = float(rng.uniform(0.025, 0.060))
        xt = float(np.clip(xb + rng.uniform(-0.015, 0.015), -0.05, 0.30))
        ca = float(rng.uniform(0.005, 0.045))
        lag = float(rng.uniform(0.85, 1.55))
        ra = float(rng.uniform(0.80, 1.00))
        ps = float(rng.uniform(0.15, 0.70))
        fl = float(rng.uniform(0.0, 40.0))
        shim = float(rng.uniform(0.0, 12.0))
    elif regime == "breathy":
        f0_min, f0_max = 75.0, 340.0
        f0_base = float(rng.uniform(85.0, 310.0))
        pr = float(rng.uniform(4500.0, 15500.0))
        xb = float(rng.uniform(0.055, 0.130))
        xt = float(np.clip(xb + rng.uniform(-0.020, 0.025), -0.05, 0.30))
        ca = float(rng.uniform(0.040, 0.180))
        lag = float(rng.uniform(0.30, 1.15))
        ra = float(rng.uniform(0.55, 0.98))
        ps = float(rng.uniform(-0.75, 0.35))
        fl = float(rng.uniform(10.0, 55.0))
        shim = float(rng.uniform(5.0, 35.0))
    elif regime == "pressed":
        f0_min, f0_max = 75.0, 360.0
        f0_base = float(rng.uniform(85.0, 320.0))
        if rng.random() < 0.80:
            pr = float(rng.uniform(7500.0, 16000.0))
            xb = float(rng.uniform(-0.035, 0.015))
        else:
            pr = float(rng.uniform(3800.0, 7500.0))
            xb = float(rng.uniform(-0.008, 0.015))
        xt = float(np.clip(xb + rng.uniform(-0.015, 0.015), -0.05, 0.30))
        ca = float(rng.uniform(-0.08, 0.015))
        lag = float(rng.uniform(1.35, 2.60))
        ra = float(rng.uniform(0.82, 1.00))
        ps = float(rng.uniform(0.50, 1.00))
        fl = float(rng.uniform(0.0, 30.0))
        shim = float(rng.uniform(0.0, 15.0))
    elif regime == "creaky":
        f0_min, f0_max = 40.0, 88.0
        f0_base = float(rng.uniform(44.0, 78.0))
        creak_amp = float(rng.uniform(4.5, 11.0))
        xb = float(rng.uniform(-0.016, 0.012))
        pr_floor = 4600.0 if xb < -0.006 else 3400.0
        pr = float(rng.uniform(pr_floor, 8500.0))
        xt = float(np.clip(xb + rng.uniform(-0.012, 0.012), -0.05, 0.30))
        ca = float(rng.uniform(-0.03, 0.012))
        lag = float(rng.uniform(1.45, 2.80))
        ra = float(rng.uniform(0.68, 1.00))
        ps = float(rng.uniform(0.50, 1.00))
        fl = float(rng.uniform(45.0, 100.0))
        shim = float(rng.uniform(50.0, 100.0))
    elif regime == "falsetto":
        f0_min, f0_max = 240.0, 600.0
        f0_base = float(rng.uniform(255.0, 560.0))
        pr = float(rng.uniform(4000.0, 12500.0))
        xb = float(rng.uniform(0.030, 0.095))
        xt = float(np.clip(xb + rng.uniform(-0.020, 0.025), -0.05, 0.30))
        ca = float(rng.uniform(0.015, 0.110))
        lag = float(rng.uniform(0.00, 0.55))
        ra = float(rng.uniform(0.25, 0.80))
        ps = float(rng.uniform(-1.00, 0.20))
        fl = float(rng.uniform(0.0, 45.0))
        shim = float(rng.uniform(0.0, 25.0))
    elif regime == "whisper":
        f0_min, f0_max = 80.0, 320.0
        f0_base = float(rng.uniform(90.0, 290.0))
        pr = float(rng.uniform(5000.0, 14500.0))
        xb = float(rng.uniform(0.045, 0.180))
        xt = float(np.clip(xb + rng.uniform(-0.025, 0.025), -0.05, 0.30))
        ca = float(rng.uniform(0.060, 0.250))
        lag = float(rng.uniform(0.0, 3.1415))
        ra = float(rng.uniform(-0.15, 0.15))
        ps = float(rng.uniform(-1.0, 1.0))
        fl = float(rng.uniform(0.0, 100.0))
        shim = float(rng.uniform(0.0, 40.0))
    elif regime == "explore":
        f0_min, f0_max = 40.0, 600.0
        f0_base = float(np.exp(rng.uniform(np.log(40.0), np.log(600.0))))
        pr = float(rng.uniform(2400.0, 16000.0))
        xb = float(rng.uniform(-0.05, 0.28))
        xt = float(rng.uniform(-0.05, 0.28))
        ca = float(rng.uniform(-0.25, 0.25))
        lag = float(rng.uniform(0.0, 3.1415))
        ra = float(rng.uniform(0.15, 1.0)) if rng.random() < 0.80 else float(rng.uniform(-1.0, 0.15))
        ps = float(rng.uniform(-1.0, 1.0))
        fl = float(rng.uniform(0.0, 100.0))
        shim = float(rng.uniform(0.0, 100.0))
        if f0_base < 90.0 and rng.random() < 0.25:
            creak_amp = float(rng.uniform(4.0, 10.0))
    else:
        raise ValueError(f"Unknown phonation regime: {regime}")

    # Cols 17..26 vector: [F0, PR, XB, XT, CA, LAG, RA, PS, FL, SHIM]
    vec10 = np.array([f0_base, pr, xb, xt, ca, lag, ra, ps, fl, shim], dtype=np.float64)
    return {
        "vec10": vec10,
        "f0_min": f0_min,
        "f0_max": f0_max,
        "creak_amp": creak_amp,
    }


def _build_regime_timeline(
    n_steps: int,
    rng: np.random.Generator,
) -> Tuple[str, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Build per-step baseline voiced source params (n_steps, 10), f0 bounds, and creak amplitude."""
    if rng.random() < 0.70 or n_steps < 140:
        regime_tag = str(rng.choice(SINGLE_REGIME_NAMES, p=SINGLE_REGIME_PROBS))
        p = _sample_regime_params(regime_tag, rng)
        base10 = np.repeat(p["vec10"][None, :], n_steps, axis=0)
        f0_min_arr = np.full(n_steps, p["f0_min"], dtype=np.float64)
        f0_max_arr = np.full(n_steps, p["f0_max"], dtype=np.float64)
        creak_arr = np.full(n_steps, p["creak_amp"], dtype=np.float64)
        return regime_tag, base10, f0_min_arr, f0_max_arr, creak_arr

    regime_tag = "morph"
    k_reg = 3 if (n_steps >= 300 and rng.random() < 0.30) else 2
    chosen = [str(r) for r in rng.choice(MORPH_REGIME_POOL, size=k_reg, replace=False)]
    params = [_sample_regime_params(r, rng) for r in chosen]

    # Split timeline across k_reg regimes with jittered boundaries (each >= 60 steps = 300 ms)
    bounds = [0]
    for i in range(1, k_reg):
        nom = i / k_reg
        pos = int(round(np.clip(nom + rng.uniform(-0.12, 0.12), 0.15, 0.85) * n_steps))
        pos = max(bounds[-1] + 60, min(n_steps - (k_reg - i) * 60, pos))
        bounds.append(pos)
    bounds.append(n_steps)

    base10 = np.empty((n_steps, 10), dtype=np.float64)
    f0_min_arr = np.empty(n_steps, dtype=np.float64)
    f0_max_arr = np.empty(n_steps, dtype=np.float64)
    creak_arr = np.empty(n_steps, dtype=np.float64)
    for i in range(k_reg):
        a, b = bounds[i], bounds[i + 1]
        p = params[i]
        base10[a:b] = p["vec10"]
        f0_min_arr[a:b] = p["f0_min"]
        f0_max_arr[a:b] = p["f0_max"]
        creak_arr[a:b] = p["creak_amp"]

    # Half of morph utterances apply smooth cosine blends across regime boundaries
    if rng.random() < 0.50:
        half_r = max(10, int(round(rng.uniform(0.050, 0.200) * CONTROL_HZ_200)))
        for i in range(1, k_reg):
            b = bounds[i]
            s = max(bounds[i - 1] + 10, b - half_r)
            e = min(bounds[i + 1] - 10, b + half_r)
            if e <= s + 2:
                continue
            u = 0.5 - 0.5 * np.cos(np.pi * np.linspace(0.0, 1.0, e - s))
            pl, pr_ = params[i - 1], params[i]
            base10[s:e] = pl["vec10"][None, :] * (1.0 - u[:, None]) + pr_["vec10"][None, :] * u[:, None]
            f0_min_arr[s:e] = np.minimum(pl["f0_min"], pr_["f0_min"])
            f0_max_arr[s:e] = np.maximum(pl["f0_max"], pr_["f0_max"])
            creak_arr[s:e] = pl["creak_amp"] * (1.0 - u) + pr_["creak_amp"] * u

    return regime_tag, base10, f0_min_arr, f0_max_arr, creak_arr


def _perturb_tract(tract: np.ndarray, scale: float, rng: np.random.Generator) -> np.ndarray:
    perturbed = tract + rng.normal(0.0, scale * _TRACT_SPAN)
    return np.clip(perturbed, M27_MIN[:17], M27_MAX[:17])


def _sample_m27_utterance_targets(
    bank: StateBankLoader,
    rng: np.random.Generator,
    min_sec: float = 2.0,
    max_sec: float = 5.6,
) -> Tuple[np.ndarray, str]:
    """Generate a 200 Hz smoothed 27-dim JD2 trajectory across rich native voice qualities."""
    target_50_frames = int(rng.integers(round(min_sec * CONTROL_HZ_50), round(max_sec * CONTROL_HZ_50) + 1))
    n_steps = target_50_frames * (CONTROL_HZ_200 // CONTROL_HZ_50)

    def ms_to_steps(ms: float) -> int:
        return max(2, int(round(ms * 0.001 * CONTROL_HZ_200)))

    # Segment stream: (n_steps, tract17, kind, voiced)
    events: List[Tuple[int, np.ndarray, str, bool]] = []
    if rng.random() < 0.85:
        v0 = _perturb_tract(bank.vowels[int(rng.integers(len(bank.vowels)))], 0.025, rng)
        v0[7] = -0.1
        events.append((ms_to_steps(rng.uniform(60.0, 220.0)), v0, "silence", False))

    acc_steps = sum(ev[0] for ev in events)
    next_is_vowel = bool(rng.random() < 0.60)
    while acc_steps < n_steps - ms_to_steps(120.0):
        if len(events) >= 3 and rng.random() < 0.08:
            pause_steps = ms_to_steps(rng.uniform(90.0, 260.0))
            last_tract = events[-1][1].copy()
            events.append((pause_steps, last_tract, "silence", False))
            acc_steps += pause_steps
            continue

        dur_steps = ms_to_steps(rng.uniform(50.0, 200.0))
        if next_is_vowel:
            tract = bank.vowels[int(rng.integers(len(bank.vowels)))].copy()
            scale = 0.025 if rng.random() < 0.70 else 0.060
            tract = _perturb_tract(tract, scale, rng)
            tract[7] = float(rng.uniform(0.25, 0.78)) if rng.random() < 0.18 else -0.1
            events.append((dur_steps, np.clip(tract, M27_MIN[:17], M27_MAX[:17]), "vowel", True))
            next_is_vowel = bool(rng.random() < 0.25)
        else:
            r = rng.random()
            if r < 0.28 and len(bank.closures) > 0:
                tract = _perturb_tract(bank.closures[int(rng.integers(len(bank.closures)))], 0.015, rng)
                tract[7] = -0.1
                events.append((dur_steps, tract, "closure", bool(rng.random() < 0.45)))
            elif r < 0.60 and len(bank.fricatives) > 0:
                tract = _perturb_tract(bank.fricatives[int(rng.integers(len(bank.fricatives)))], 0.015, rng)
                tract[7] = -0.1
                events.append((dur_steps, tract, "fricative", bool(rng.random() < 0.35)))
            elif r < 0.76 and len(bank.closures) > 0:
                tract = _perturb_tract(bank.closures[int(rng.integers(len(bank.closures)))], 0.015, rng)
                tract[7] = float(rng.uniform(0.35, 0.85))
                events.append((dur_steps, np.clip(tract, M27_MIN[:17], M27_MAX[:17]), "nasal", True))
            elif r < 0.86 and len(bank.laterals) > 0:
                tract = _perturb_tract(bank.laterals[int(rng.integers(len(bank.laterals)))], 0.025, rng)
                tract[7] = -0.1
                events.append((dur_steps, tract, "lateral", True))
            elif r < 0.94 and len(bank.approximants) > 0:
                tract = _perturb_tract(bank.approximants[int(rng.integers(len(bank.approximants)))], 0.025, rng)
                tract[7] = -0.1
                events.append((dur_steps, tract, "approximant", True))
            else:
                gs_steps = min(dur_steps, ms_to_steps(rng.uniform(35.0, 85.0)))
                tract = _perturb_tract(bank.vowels[int(rng.integers(len(bank.vowels)))], 0.020, rng)
                tract[7] = -0.1
                events.append((gs_steps, tract, "glottal_stop", False))
                dur_steps = gs_steps
            next_is_vowel = bool(rng.random() < 0.82)

        acc_steps += dur_steps

    rem = n_steps - acc_steps
    if rem > 0:
        last_tract = events[-1][1].copy() if events else bank.vowels[0].copy()
        events.append((rem, last_tract, "silence", False))
    else:
        over = acc_steps - n_steps
        last_len, last_tr, last_k, last_v = events[-1]
        events[-1] = (max(1, last_len - over), last_tr, last_k, last_v)

    regime_tag, base10, f0_min_arr, f0_max_arr, creak_arr = _build_regime_timeline(n_steps, rng)

    raw_targets = np.empty((n_steps, 27), dtype=np.float64)
    raw_targets[:, 17:27] = base10

    cursor = 0
    seg_spans: List[Tuple[int, int, str, bool]] = []
    for seg_len, tract, kind, voiced in events:
        end = min(n_steps, cursor + seg_len)
        if end <= cursor:
            continue
        raw_targets[cursor:end, :17] = tract
        seg_spans.append((cursor, end, kind, voiced))
        cursor = end

    # First pass: apply prosodic F0 inflection & consonant/silence glottal targets
    for s, e, kind, voiced in seg_spans:
        f0_mult = float(rng.uniform(0.72, 1.32))
        raw_targets[s:e, 17] = np.clip(
            raw_targets[s:e, 17] * f0_mult,
            f0_min_arr[s:e],
            f0_max_arr[s:e],
        )

        if kind == "silence":
            raw_targets[s:e, 18] = 0.0        # PR
            raw_targets[s:e, 19] = 0.12       # XB
            raw_targets[s:e, 20] = 0.12       # XT
            raw_targets[s:e, 21] = 0.05       # CA
            raw_targets[s:e, 22] = 1.222044   # LAG
            raw_targets[s:e, 23] = 0.0        # RA
            raw_targets[s:e, 24] = 0.5        # PS
            raw_targets[s:e, 25] = 0.0        # FL
            raw_targets[s:e, 26] = 0.0        # SHIM
        elif kind == "glottal_stop":
            # Native JD2 "stop" preset shuts down glottal pulse under positive subglottal pressure
            raw_targets[s:e, 18] = np.maximum(raw_targets[s:e, 18], 5000.0)
            raw_targets[s:e, 19] = -0.010
            raw_targets[s:e, 20] = -0.010
            raw_targets[s:e, 21] = -0.001
            raw_targets[s:e, 23] = -0.204
            raw_targets[s:e, 26] = 0.0
        elif kind == "closure" and not voiced:
            raw_targets[s:e, 18] = np.maximum(raw_targets[s:e, 18], 6500.0)
            raw_targets[s:e, 19] = 0.25
            raw_targets[s:e, 20] = 0.25
            raw_targets[s:e, 21] = 0.0
            raw_targets[s:e, 23] = -1.0 if rng.random() < 0.50 else 0.0
            raw_targets[s:e, 26] = 0.0
        elif kind == "fricative" and not voiced:
            raw_targets[s:e, 18] = np.maximum(raw_targets[s:e, 18], 6500.0)
            raw_targets[s:e, 19] = 0.15
            raw_targets[s:e, 20] = 0.15
            raw_targets[s:e, 21] = 0.0
            raw_targets[s:e, 23] = 0.0
            raw_targets[s:e, 26] = 0.0
        elif not voiced:
            raw_targets[s:e, 18] = np.maximum(raw_targets[s:e, 18], 6000.0)
            raw_targets[s:e, 19] = 0.10
            raw_targets[s:e, 20] = 0.10
            raw_targets[s:e, 21] = 0.04
            raw_targets[s:e, 23] = 0.0
            raw_targets[s:e, 26] = 0.0
        elif kind == "fricative" and voiced:
            raw_targets[s:e, 19] = np.clip(raw_targets[s:e, 19] + 0.025, -0.05, 0.30)
            raw_targets[s:e, 20] = np.clip(raw_targets[s:e, 20] + 0.025, -0.05, 0.30)
            raw_targets[s:e, 21] = np.clip(raw_targets[s:e, 21] + 0.035, -0.25, 0.25)

    # Second pass: Krug (2023) glottal asynchrony (post-release VOT & pre-fricative abduction)
    shift_pos_vot = ms_to_steps(rng.uniform(30.0, 55.0))
    shift_neg_fric = ms_to_steps(rng.uniform(20.0, 35.0))
    for idx_ev, (s, e, kind, voiced) in enumerate(seg_spans):
        if kind == "closure" and not voiced:
            next_kind = seg_spans[idx_ev + 1][2] if idx_ev + 1 < len(seg_spans) else "silence"
            if next_kind != "silence":
                ge = min(n_steps, e + shift_pos_vot)
                if ge > e:
                    raw_targets[e:ge, 18] = np.maximum(raw_targets[e:ge, 18], 6500.0)
                    raw_targets[e:ge, 19] = 0.045
                    raw_targets[e:ge, 20] = 0.045
                    raw_targets[e:ge, 21] = 0.10
                    raw_targets[e:ge, 23] = 0.0
                    raw_targets[e:ge, 26] = 0.0
        elif kind == "fricative" and not voiced:
            prev_kind = seg_spans[idx_ev - 1][2] if idx_ev > 0 else "silence"
            if prev_kind != "silence":
                gs = max(0, s - shift_neg_fric)
                if s > gs:
                    raw_targets[gs:s, 18] = np.maximum(raw_targets[gs:s, 18], 6500.0)
                    raw_targets[gs:s, 19] = 0.15
                    raw_targets[gs:s, 20] = 0.15
                    raw_targets[gs:s, 21] = 0.0
                    raw_targets[gs:s, 23] = 0.0
                    raw_targets[gs:s, 26] = 0.0

    # Third-order target approximation smoothing grouped by physical time constant
    dt = 1.0 / CONTROL_HZ_200
    smooth = np.empty_like(raw_targets)
    smooth[:, :17] = target_approximation_filter(raw_targets[:, :17], dt, TAU_TRACT_SEC)
    smooth[:, 17:18] = target_approximation_filter(raw_targets[:, 17:18], dt, TAU_F0_SEC)
    smooth[:, _GLOTTIS_FAST_IDX] = target_approximation_filter(
        raw_targets[:, _GLOTTIS_FAST_IDX], dt, TAU_GLOTTIS_FAST_SEC
    )
    smooth[:, _QUALITY_IDX] = target_approximation_filter(
        raw_targets[:, _QUALITY_IDX], dt, TAU_QUALITY_SEC
    )

    # Apply fast irregular / diplophonic F0 jitter during creaky phonation intervals
    if np.any(creak_arr > 0.01):
        t = np.arange(n_steps, dtype=np.float64) * dt
        ph1 = float(rng.uniform(0.0, 2.0 * np.pi))
        ph2 = float(rng.uniform(0.0, 2.0 * np.pi))
        f1 = float(rng.uniform(22.0, 34.0))
        f2 = float(rng.uniform(8.0, 15.0))
        creak_mod = creak_arr * (
            0.62 * np.sin(2.0 * np.pi * f1 * t + ph1) + 0.38 * np.sin(2.0 * np.pi * f2 * t + ph2)
        )
        voiced_gate = (smooth[:, 18] > 1500.0) & (smooth[:, 23] > 0.30)
        smooth[:, 17] = smooth[:, 17] + creak_mod * voiced_gate

    smooth = np.clip(smooth, M27_MIN, M27_MAX)
    return smooth, regime_tag


class M27Synthesizer:
    """Single-process CPU M10 R21 JD2 synthesizer supporting full 9-dim glottis + shimmer."""

    def __init__(self, section_count: int = 65) -> None:
        self.engine = open_jd2_engine()
        if section_count != 65:
            self.engine.set_section_count(section_count)
        self.engine.set_manual_root(False)
        self.engine.configure_perturbation({"jitter": 0.0, "shimmer": 0.0, "seed": 1}, restart=True)
        if self.engine.sr != SAMPLE_RATE_48K:
            raise RuntimeError(f"意外的 VTL 采样率 {self.engine.sr}，期望 {SAMPLE_RATE_48K}")

    def close(self) -> None:
        self.engine.close()

    def __enter__(self) -> "M27Synthesizer":
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.close()

    def synthesize_200hz(
        self,
        m27_200hz: np.ndarray,
        *,
        perturb_seed: int = 1,
        tube_hz: int = 100,
        return_48k: bool = False,
    ) -> Optional[Tuple[Optional[np.ndarray], np.ndarray]]:
        """Synthesize 200 Hz (5 ms/step) 27-dim control matrix into 16 kHz (and optional 48 kHz) audio.

        ``tube_hz`` in (200, 100, 50) controls how often full sagittal-to-tube geometry is solved;
        sub-steps interpolate the 65-section tube linearly while glottis9, shimmer, and block_tube
        always run at the full 200 Hz (5 ms) rate. Identical steady-state frames reuse cached tubes.
        """
        if tube_hz not in (200, 100, 50):
            raise ValueError(f"tube_hz 必须为 200、100 或 50，收到 {tube_hz}")
        stride = CONTROL_HZ_200 // tube_hz

        tract19_seq, glottis9_seq, shim_seq = m27_to_vtl19_glottis9_shimmer(m27_200hz)
        tract19_seq = np.clip(tract19_seq, self.engine.minimum, self.engine.maximum)
        glottis9_seq = np.clip(glottis9_seq, self.engine.gmin, self.engine.gmax)

        n_steps = tract19_seq.shape[0]
        chunks: List[np.ndarray] = []
        pseed = max(1, int(perturb_seed) & 0x7FFFFFFF)
        try:
            anchors = list(range(0, n_steps, stride))
            if anchors[-1] != n_steps - 1:
                anchors.append(n_steps - 1)
            tubes: Dict[int, Dict[str, Any]] = {}
            prev_p: Optional[np.ndarray] = None
            prev_t: Optional[Dict[str, Any]] = None
            for idx in anchors:
                cur_p = tract19_seq[idx]
                if prev_p is not None and float(np.max(np.abs(cur_p - prev_p))) < 1e-4:
                    tubes[idx] = prev_t  # lossless reuse across steady-state / silence
                else:
                    prev_t = self.engine.prepare_tube(cur_p)
                    prev_p = cur_p
                    tubes[idx] = prev_t

            last_shim = float(shim_seq[0])
            self.engine.configure_perturbation(
                {"jitter": 0.0, "shimmer": last_shim, "seed": pseed},
                restart=True,
            )
            first_tube = tubes[0]
            self.engine.reset_tube(first_tube, np.ascontiguousarray(glottis9_seq[0]))
            chunks.append(
                self.engine.block_tube(
                    first_tube,
                    np.ascontiguousarray(glottis9_seq[0]),
                    R21_STEP_SAMPLES_48K,
                )
            )
            ai = 0
            n_anchors = len(anchors)
            for k in range(1, n_steps):
                cur_shim = float(shim_seq[k])
                if abs(cur_shim - last_shim) >= 2.0:
                    self.engine.configure_perturbation(
                        {"jitter": 0.0, "shimmer": cur_shim, "seed": pseed},
                        restart=False,
                    )
                    last_shim = cur_shim
                if stride == 1:
                    tube = tubes[k]
                else:
                    while ai + 1 < n_anchors and k > anchors[ai + 1]:
                        ai += 1
                    a0 = anchors[ai]
                    a1 = anchors[ai + 1] if ai + 1 < n_anchors else a0
                    if a0 == a1 or k == a0:
                        tube = tubes[a0]
                    elif k == a1:
                        tube = tubes[a1]
                    else:
                        t0_d, t1_d = tubes[a0], tubes[a1]
                        if t0_d is t1_d:
                            tube = t0_d
                        else:
                            alpha = (k - a0) / (a1 - a0)
                            tube = {
                                "lengths": t0_d["lengths"] * (1.0 - alpha) + t1_d["lengths"] * alpha,
                                "areas": t0_d["areas"] * (1.0 - alpha) + t1_d["areas"] * alpha,
                                "articulators": t0_d["articulators"] if alpha < 0.5 else t1_d["articulators"],
                                "extras": t0_d["extras"] * (1.0 - alpha) + t1_d["extras"] * alpha,
                            }
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
        if float(np.max(np.abs(wav_48k))) > 10.0:
            return None

        wav_16k = resample_poly(wav_48k, 1, 3).astype(np.float32)
        if not np.isfinite(wav_16k).all():
            return None

        if return_48k:
            return wav_48k.astype(np.float32), wav_16k
        return None, wav_16k


_WORKER_SYNTH: Optional[M27Synthesizer] = None
_WORKER_BANK: Optional[StateBankLoader] = None


def _silence_native_worker_stdout() -> None:
    """Redirect child process OS/C stdout fd 1 to devnull so VTL2.4 C++ printf never spams logs."""
    try:
        devnull_fd = os.open(os.devnull, os.O_WRONLY)
        if devnull_fd != 1:
            os.dup2(devnull_fd, 1)
        if os.name == "nt":
            import ctypes
            import msvcrt

            ctypes.windll.kernel32.SetStdHandle(-11, msvcrt.get_osfhandle(1))
        if devnull_fd not in (0, 1, 2):
            os.close(devnull_fd)
    except OSError:
        pass


def _init_worker(state_path_str: str) -> None:
    global _WORKER_SYNTH, _WORKER_BANK
    _silence_native_worker_stdout()
    _WORKER_SYNTH = M27Synthesizer(section_count=65)
    _WORKER_BANK = StateBankLoader(Path(state_path_str))


def _generate_shard_task(args: Tuple[int, int, int, str, float, float, int]) -> Dict[str, Any]:
    shard_idx, utts_per_shard, base_seed, out_dir_str, min_sec, max_sec, tube_hz = args
    assert _WORKER_SYNTH is not None and _WORKER_BANK is not None

    rng = np.random.default_rng(base_seed + shard_idx * 100003)
    out_dir = Path(out_dir_str)
    shard_path = out_dir / f"shard_{shard_idx:06d}.npz"
    tmp_path = out_dir / f"shard_{shard_idx:06d}.tmp.npz"

    audio_chunks: List[np.ndarray] = []
    m27_chunks: List[np.ndarray] = []
    regime_tags: List[str] = []
    audio_offsets = [0]
    frame_offsets = [0]
    regime_counts: Dict[str, int] = {k: 0 for k in ALL_REGIME_TAGS}

    attempts = 0
    failed = 0
    total_samples = 0
    max_attempts = utts_per_shard * 4

    f0_min_obs = float("inf")
    f0_max_obs = float("-inf")
    pr_max_obs = 0.0
    shim_max_obs = 0.0

    while len(audio_chunks) < utts_per_shard and attempts < max_attempts:
        attempts += 1
        m27_200, regime_tag = _sample_m27_utterance_targets(
            _WORKER_BANK, rng, min_sec=min_sec, max_sec=max_sec
        )
        res = _WORKER_SYNTH.synthesize_200hz(
            m27_200,
            perturb_seed=int(rng.integers(1, 2_000_000_000)),
            tube_hz=tube_hz,
            return_48k=False,
        )
        if res is None:
            failed += 1
            continue
        _, wav_16k = res

        peak = float(np.max(np.abs(wav_16k)))
        if peak < 0.0015 or not np.isfinite(wav_16k).all():
            failed += 1
            continue

        n_frames = m27_200.shape[0] // 4
        expected_samples = n_frames * WAVLM_HOP_SAMPLES
        wav_16k = wav_16k[:expected_samples]
        if len(wav_16k) != expected_samples:
            failed += 1
            continue

        reshaped = m27_200[: n_frames * 4].reshape(n_frames, 4, 27)
        m27_50 = reshaped.mean(axis=1)
        m27_50[:, 18] = np.median(reshaped[:, :, 18], axis=1)  # preserve sharp PR transitions

        scale = max(1.0, peak)
        audio_i16 = np.rint(np.clip(wav_16k / scale, -1.0, 1.0) * 32767.0).astype(np.int16)
        m27_f16 = m27_50.astype(np.float16)

        audio_chunks.append(audio_i16)
        m27_chunks.append(m27_f16)
        regime_tags.append(regime_tag)
        regime_counts[regime_tag] = regime_counts.get(regime_tag, 0) + 1
        total_samples += expected_samples
        audio_offsets.append(audio_offsets[-1] + expected_samples)
        frame_offsets.append(frame_offsets[-1] + n_frames)

        f0_min_obs = min(f0_min_obs, float(np.min(m27_50[:, 17])))
        f0_max_obs = max(f0_max_obs, float(np.max(m27_50[:, 17])))
        pr_max_obs = max(pr_max_obs, float(np.max(m27_50[:, 18])))
        shim_max_obs = max(shim_max_obs, float(np.max(m27_50[:, 26])))

    if not audio_chunks:
        raise RuntimeError(f"分片 {shard_idx} 连续 {attempts} 次合成均失败！")

    np.savez(
        tmp_path,
        audio_i16=np.concatenate(audio_chunks),
        m27_f16=np.concatenate(m27_chunks, axis=0),
        m27_names=np.asarray(M27_NAMES),
        audio_offsets=np.asarray(audio_offsets, dtype=np.int64),
        frame_offsets=np.asarray(frame_offsets, dtype=np.int64),
        regime_tags=np.asarray(regime_tags),
    )
    os.replace(tmp_path, shard_path)

    return {
        "schema": SCHEMA_VERSION,
        "tube_hz": tube_hz,
        "shard_idx": shard_idx,
        "file": shard_path.name,
        "num_utts": len(audio_chunks),
        "attempts": attempts,
        "failed": failed,
        "seconds": total_samples / SAMPLE_RATE_16K,
        "bytes": shard_path.stat().st_size,
        "f0_min": round(f0_min_obs, 2),
        "f0_max": round(f0_max_obs, 2),
        "pr_max": round(pr_max_obs, 1),
        "shim_max": round(shim_max_obs, 1),
        "regime_counts": regime_counts,
    }


def _cleanup_stray_tmp_files(out_dir: Path) -> int:
    removed = 0
    for tmp in out_dir.glob("*.tmp.npz"):
        try:
            tmp.unlink()
            removed += 1
        except OSError:
            pass
    return removed


def generate_m27_corpus(
    out_dir: Path,
    state_bank_path: Path = STATES_DEFAULT_PATH,
    *,
    target_hours: float = 180.0,
    utts_per_shard: int = 50,
    workers: int = 20,
    tube_hz: int = 100,
    min_sec: float = 2.0,
    max_sec: float = 5.6,
    seed: int = 20261121,
    resume: bool = True,
) -> Dict[str, Any]:
    """Multiprocess sharded generator for full-native 27-dim M10 R21 corpus with clean resume."""
    if tube_hz not in (200, 100, 50):
        raise ValueError(f"tube_hz 必须为 200、100 或 50，收到 {tube_hz}")
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "manifest.jsonl"

    cleaned_tmp = _cleanup_stray_tmp_files(out_dir)
    if cleaned_tmp > 0:
        print(f"[Synth27] 清理中断残留临时分片: {cleaned_tmp} 个", flush=True)

    existing: Dict[int, Dict[str, Any]] = {}
    if resume and manifest_path.is_file():
        for line in manifest_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            rec = json.loads(line)
            if (out_dir / rec["file"]).is_file():
                existing[int(rec["shard_idx"])] = rec

    avg_sec = 0.5 * (min_sec + max_sec)
    target_seconds = float(target_hours) * 3600.0
    # Shrink utts_per_shard only on fresh tiny smoke runs so resumed runs never shift shard granularity
    if not existing and (target_seconds / avg_sec < utts_per_shard):
        utts_per_shard = max(8, int(np.ceil(target_seconds / avg_sec)))
    n_shards = max(1, int(np.ceil(target_seconds / (utts_per_shard * avg_sec))))

    pending_tasks = [
        (idx, utts_per_shard, seed, str(out_dir), float(min_sec), float(max_sec), int(tube_hz))
        for idx in range(n_shards)
        if idx not in existing
    ]

    base_sec = sum(float(r["seconds"]) for r in existing.values())
    base_attempts = sum(int(r["attempts"]) for r in existing.values())
    base_failed = sum(int(r["failed"]) for r in existing.values())
    done_new_sec = 0.0
    done_attempts = 0
    done_failed = 0

    t0 = time.perf_counter()
    new_records: List[Dict[str, Any]] = []
    if pending_tasks:
        n_workers = max(1, min(int(workers), len(pending_tasks)))
        print(
            f"[Synth27] 已启动 {n_workers} 个工作进程（每分片 {utts_per_shard} 条，共 {len(pending_tasks)} 待生成分片），"
            "首批分片约 1–2 分钟后陆续落盘并刷新速度/ETA...",
            flush=True,
        )
        with ProcessPoolExecutor(
            max_workers=n_workers,
            initializer=_init_worker,
            initargs=(str(state_bank_path),),
        ) as pool:
            futures = [pool.submit(_generate_shard_task, task) for task in pending_tasks]
            for fut in as_completed(futures):
                rec = fut.result()
                new_records.append(rec)
                with open(manifest_path, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

                done_new_sec += float(rec["seconds"])
                done_attempts += int(rec["attempts"])
                done_failed += int(rec["failed"])
                elapsed_so_far = max(1e-6, time.perf_counter() - t0)
                tot_sec = base_sec + done_new_sec
                tot_h = tot_sec / 3600.0
                rtf = done_new_sec / elapsed_so_far
                tot_att = base_attempts + done_attempts
                tot_fail = base_failed + done_failed
                fail_pct = 100.0 * tot_fail / max(1, tot_att)
                rem_sec = max(0.0, target_seconds - tot_sec)
                eta_h = (rem_sec / rtf) / 3600.0 if rtf > 1e-6 else 0.0
                done_shards = len(existing) + len(new_records)
                print(
                    f"[Synth27] shard {done_shards}/{n_shards} ({rec['file']}) | "
                    f"total={tot_h:.2f}/{target_hours:.1f}h | rtf={rtf:.2f}x | "
                    f"fail={fail_pct:.2f}% | eta={eta_h:.2f}h",
                    flush=True,
                )

    elapsed = time.perf_counter() - t0
    all_records = list(existing.values()) + new_records
    all_records.sort(key=lambda r: int(r["shard_idx"]))

    manifest_path.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in all_records) + ("\n" if all_records else ""),
        encoding="utf-8",
    )

    new_sec = sum(float(r["seconds"]) for r in new_records)
    total_sec = sum(float(r["seconds"]) for r in all_records)
    total_attempts = sum(int(r["attempts"]) for r in all_records)
    total_failed = sum(int(r["failed"]) for r in all_records)
    total_bytes = sum(int(r["bytes"]) for r in all_records)
    agg_regimes: Dict[str, int] = {k: 0 for k in ALL_REGIME_TAGS}
    for r in all_records:
        for k, v in r.get("regime_counts", {}).items():
            agg_regimes[k] = agg_regimes.get(k, 0) + int(v)

    return {
        "schema": SCHEMA_VERSION,
        "tube_hz": tube_hz,
        "out_dir": str(out_dir),
        "n_shards": len(all_records),
        "total_utts": sum(int(r["num_utts"]) for r in all_records),
        "total_hours": round(total_sec / 3600.0, 4),
        "total_seconds": round(total_sec, 2),
        "total_gb": round(total_bytes / (1024 ** 3), 4),
        "total_mb": round(total_bytes / (1024 ** 2), 2),
        "failure_rate": round(total_failed / max(1, total_attempts), 4),
        "new_seconds": round(new_sec, 2),
        "wall_seconds": round(elapsed, 2),
        "realtime_factor": round(new_sec / max(1e-6, elapsed), 2),
        "regime_counts": agg_regimes,
    }
