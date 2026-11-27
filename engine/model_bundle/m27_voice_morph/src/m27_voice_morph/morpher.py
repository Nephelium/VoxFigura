"""Core M27 time-varying voice morphing algorithms (Preset Modulation & Dual-Speaker Transplantation).

100% pure-NumPy scientific core (zero UI/server coupling, deterministic, unit-testable):
  - Mode 1 (`apply_preset_phonation_morph`): Alignment-free preset phonation modulation on any single recording
  - Mode 2 (`apply_dual_speaker_morph`):     Time-aligned multi-organ & frame-wise SLERP timbre morphing between A & B
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

from .alignment import (
    _interp_trajectory_by_map,
    align_m27_anchors,
    align_m27_dtw,
    build_timing_morphed_maps,
)
from .curves import (
    F0ShiftOutOfRange,
    apply_f0_semitone_coupling,
    compute_voicing_and_speech_gates,
    sample_curve_50hz,
    slerp_speaker_sequence,
    smooth_curve_anti_click,
)
from .presets import (
    BUILTIN_PHONATION_PRESETS,
    F0_INDEX,
    GLOTTIS8_INDICES,
    ORGAN_GROUPS,
    PR_INDEX,
)

try:
    from tt3.glottis27_generator import M27_MAX as _TT3_MAX, M27_MIN as _TT3_MIN
    M27_MIN_PHYS = _TT3_MIN.astype(np.float32)
    M27_MAX_PHYS = _TT3_MAX.astype(np.float32)
except ImportError:
    M27_MIN_PHYS = np.array(
        [
            0.0, -6.0, -0.5, -7.0, -1.0, -2.0, 0.0, -0.1,
            -3.0, -3.0, 1.5, -3.0, -3.0, -3.0, 0.0, 0.0, -1.0,
            40.0, 0.0,
            -0.05, -0.05, -0.25, 0.0, -1.0, -1.0, 0.0, 0.0,
        ],
        dtype=np.float32,
    )
    M27_MAX_PHYS = np.array(
        [
            1.0, -3.5, 0.0, 0.0, 1.0, 4.0, 1.0, 1.5,
            4.0, 1.0, 7.5, 2.5, 6.5, 5.0, 1.0, 1.0, 1.0,
            600.0, 16000.0,
            0.30, 0.30, 0.25, 3.1415, 1.0, 1.0, 100.0, 100.0,
        ],
        dtype=np.float32,
    )
_LOG_F0_MIN = float(np.log(40.0))
_LOG_F0_MAX = float(np.log(600.0))


def normalize_m27_phys(m27_phys: np.ndarray) -> np.ndarray:
    """Self-contained exact M27 normalization matching tt3.m27_contract (unclamped log-F0)."""
    raw = np.asarray(m27_phys, dtype=np.float32)
    arr = np.clip(raw, M27_MIN_PHYS, M27_MAX_PHYS)
    out = np.clip(2.0 * (arr - M27_MIN_PHYS) / (M27_MAX_PHYS - M27_MIN_PHYS) - 1.0, -1.0, 1.0)
    f0_safe = np.maximum(raw[..., F0_INDEX], np.float32(1e-3))
    out[..., F0_INDEX] = (2.0 * (np.log(f0_safe) - _LOG_F0_MIN) / (_LOG_F0_MAX - _LOG_F0_MIN) - 1.0)
    return out.astype(np.float32)


def denormalize_m27_norm(m27_norm: np.ndarray) -> np.ndarray:
    """Self-contained exact M27 denormalization matching tt3.m27_contract (unclamped log-F0)."""
    raw = np.asarray(m27_norm, dtype=np.float32)
    arr = np.clip(raw, -1.0, 1.0)
    out = 0.5 * (arr + 1.0) * (M27_MAX_PHYS - M27_MIN_PHYS) + M27_MIN_PHYS
    f0_n = np.clip(raw[..., F0_INDEX], np.float32(-10.0), np.float32(10.0))
    out[..., F0_INDEX] = np.exp(0.5 * (f0_n + 1.0) * (_LOG_F0_MAX - _LOG_F0_MIN) + _LOG_F0_MIN)
    return out.astype(np.float32)


@dataclass
class PresetMorphConfig:
    preset_id: str = "breathy"
    knots: List[Dict[str, float]] = field(default_factory=lambda: [{"t": 0.0, "v": 0.0}, {"t": 1.0, "v": 0.85}])
    interp_mode: str = "smoothstep"       # "linear" | "smoothstep"
    enable_voicing_gate: bool = True      # Protects silence & voiceless consonants
    smooth_ms: float = 25.0               # Anti-click Gaussian smoothing (ms)
    enable_f0_coupling: bool = False      # Optional phonation-linked F0 semitone shift
    f0_shift_semitones: Optional[float] = None  # None -> use the preset's register target or semitone shift
    f0_coupling_strength: float = 1.0
    pr_modulation_ratio: float = 0.60     # Scales natural PR envelope toward preset PR without flattening prosody
    creak_irregularity: float = 0.30      # 0.0 = regular periodic pulses, 1.0 = strong irregular creak jitter/shimmer
    diplophonia_mode: str = "parallel"    # "parallel" | "ventricular" | "vertical"
    diplophonia_ratio: float = 0.73       # Secondary/primary vibration frequency ratio f2/f1
    fps: float = 50.0
    output_f0_range_hz: Optional[Tuple[float, float]] = None


DIPLOPHONIA_MODES: Dict[str, Dict[str, Any]] = {
    "parallel": {
        "default_ratio": 0.73,
        "ratio_b_max": 0.38,
        "am_depth_max": 0.0,
        "contour_tracking": 1.0,
        "slow_drift": 0.0,
        "source_blend": 0.35,
        "secondary_source9_phys": [9200.0, -0.008, -0.010, -0.015, 1.85, 0.85, 0.75, 22.0, 18.0],
    },
    "ventricular": {
        "default_ratio": 0.58,
        "ratio_b_max": 0.36,
        "am_depth_max": 0.28,
        "contour_tracking": 0.28,
        "slow_drift": 0.025,
        "source_blend": 0.50,
        "secondary_source9_phys": [9200.0, -0.008, -0.010, -0.015, 1.85, 0.85, 0.75, 22.0, 18.0],
    },
    "vertical": {
        "default_ratio": 1.37,
        "ratio_b_max": 0.34,
        "am_depth_max": 0.16,
        "contour_tracking": 1.0,
        "slow_drift": 0.010,
        "source_blend": 0.55,
        "secondary_source9_phys": [8200.0, 0.018, 0.022, 0.010, 0.65, 0.45, 0.05, 16.0, 10.0],
    },
}


def _smooth_1d_gaussian(arr: np.ndarray, sigma: float) -> np.ndarray:
    """Pure-NumPy 1D Gaussian smoothing with edge padding for click-free sample gates."""
    x = np.asarray(arr, dtype=np.float64)
    if sigma < 0.75 or x.size < 4:
        return x
    radius = max(1, int(round(3.0 * sigma)))
    grid = np.arange(-radius, radius + 1, dtype=np.float64)
    kernel = np.exp(-0.5 * (grid / sigma) ** 2)
    kernel /= float(np.sum(kernel))
    padded = np.pad(x, (radius, radius), mode="edge")
    return np.convolve(padded, kernel, mode="valid")


def mix_diplophonia_audio(
    wav_primary: np.ndarray,
    wav_secondary: np.ndarray,
    mix_curve_50hz: np.ndarray,
    f_b_50hz: np.ndarray,
    sample_rate: int,
    *,
    ratio_b_max: float = 0.36,
    am_depth_max: float = 0.0,
    fps: float = 50.0,
) -> np.ndarray:
    """Mix two shared-tract tracks along `mix_curve_50hz` with constant-power crossfade and optional series AM."""
    a = np.asarray(wav_primary, dtype=np.float64).reshape(-1)
    b = np.asarray(wav_secondary, dtype=np.float64).reshape(-1)
    n = min(a.size, b.size)
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    a = a[:n].copy()
    b = b[:n].copy()

    curve = np.asarray(mix_curve_50hz, dtype=np.float64).reshape(-1)
    if curve.size == 0 or float(np.max(curve)) <= 1e-5:
        return a.astype(np.float32)

    t_frames = (np.arange(curve.size, dtype=np.float64) + 0.5) / float(fps)
    t_samp = np.arange(n, dtype=np.float64) / float(sample_rate)
    w_raw = np.interp(t_samp, t_frames, curve)
    w_s = np.clip(_smooth_1d_gaussian(w_raw, sigma=max(1.0, 0.012 * float(sample_rate))), 0.0, 1.0)

    # Match track B's voiced-region RMS to track A's voiced-region RMS before applying mix ratio
    active = w_s > 0.25
    if not np.any(active):
        active = w_s > 0.05
    if np.any(active):
        rms_a = float(np.sqrt(np.mean(a[active] ** 2)) + 1e-12)
        rms_b = float(np.sqrt(np.mean(b[active] ** 2)) + 1e-12)
        if rms_b > 1e-6:
            b = b * (rms_a / rms_b)

    # Optional series envelope modulation at instantaneous secondary frequency f_b(t) -> a +/- b sidebands
    if am_depth_max > 1e-5 and np.asarray(f_b_50hz).size > 0:
        fb_arr = np.asarray(f_b_50hz, dtype=np.float64).reshape(-1)
        t_fb = (np.arange(fb_arr.size, dtype=np.float64) + 0.5) / float(fps)
        fb_s = np.maximum(1.0, np.interp(t_samp, t_fb, fb_arr))
        phi_b = 2.0 * np.pi * np.cumsum(fb_s) / float(sample_rate)
        m_t = float(np.clip(am_depth_max, 0.0, 0.65)) * w_s
        wave = 0.85 * np.cos(phi_b) + 0.15 * np.cos(2.0 * phi_b)
        norm_rms = np.sqrt(1.0 + 0.5 * (0.85**2 + 0.15**2) * (m_t**2))
        a = a * ((1.0 + m_t * wave) / norm_rms)

    rb = float(np.clip(ratio_b_max, 0.0, 0.85))
    theta_max = float(np.arctan(rb / max(1e-4, 1.0 - rb)))
    theta = theta_max * w_s
    mixed = np.cos(theta) * a + np.sin(theta) * b
    return np.ascontiguousarray(mixed, dtype=np.float32)


def _zero_phase_butter2_split(x: np.ndarray, cutoff_hz: float, sample_rate: int) -> Tuple[np.ndarray, np.ndarray]:
    """Pure-NumPy zero-phase 2nd-order Butterworth split: |H_lo(f)|^2 = 1 / (1 + (f / fc)^4)."""
    arr = np.asarray(x, dtype=np.float64).reshape(-1)
    n = arr.size
    if n < 8 or cutoff_hz <= 0.0 or cutoff_hz >= 0.49 * float(sample_rate):
        return arr.copy(), np.zeros_like(arr)
    pad = min(n - 1, max(32, int(round(0.015 * float(sample_rate)))))
    padded = np.pad(arr, (pad, pad), mode="reflect")
    m = padded.size
    nfft = 1 << (m - 1).bit_length()
    freqs = np.fft.rfftfreq(nfft, d=1.0 / float(sample_rate))
    ratio4 = np.power(freqs / float(cutoff_hz), 4.0)
    h_lo = 1.0 / (1.0 + ratio4)
    spec = np.fft.rfft(padded, n=nfft)
    lo_full = np.fft.irfft(spec * h_lo, n=nfft)[pad : pad + n]
    return lo_full, arr - lo_full


def apply_voiced_falsetto_softening(
    wav: np.ndarray,
    w_eff_50hz: np.ndarray,
    sample_rate: int,
    *,
    cutoff_hz: float = 950.0,
    atten_db: float = -10.0,
    fps: float = 50.0,
) -> np.ndarray:
    """Voiced-only sinusoidal falsetto spectral-tilt softening (attenuates chest-voice buzz while keeping consonants crisp)."""
    x = np.asarray(wav, dtype=np.float64).reshape(-1)
    n = x.size
    curve = np.asarray(w_eff_50hz, dtype=np.float64).reshape(-1)
    if n == 0 or curve.size == 0 or float(np.max(curve)) <= 1e-5:
        return np.ascontiguousarray(x, dtype=np.float32)

    t_f = (np.arange(curve.size, dtype=np.float64) + 0.5) / float(fps)
    t_s = np.arange(n, dtype=np.float64) / float(sample_rate)
    g = np.clip(_smooth_1d_gaussian(np.interp(t_s, t_f, curve), sigma=max(1.0, 0.012 * float(sample_rate))), 0.0, 1.0)

    x_lo, x_hi = _zero_phase_butter2_split(x, cutoff_hz, sample_rate)
    hi_gain = float(10.0 ** (float(atten_db) / 20.0))
    x_soft = x_lo + hi_gain * x_hi

    v = g > 0.5
    if np.any(v):
        r0 = float(np.sqrt(np.mean(x[v] ** 2)) + 1e-12)
        r1 = float(np.sqrt(np.mean(x_soft[v] ** 2)) + 1e-12)
        if r1 > 1e-6:
            x_soft = x_soft * (r0 / r1)

    return np.ascontiguousarray(x * (1.0 - g) + x_soft * g, dtype=np.float32)


def apply_subharmonic_creaky_falsetto(
    wav: np.ndarray,
    f0_50hz: np.ndarray,
    w_eff_50hz: np.ndarray,
    sample_rate: int,
    *,
    w2: float = 0.28,
    w3: float = 0.44,
    w4: float = 0.28,
    sharpness: float = 2.0,
    floor_lvl: float = 0.14,
    irregularity: float = 0.30,
    bifurcation: bool = True,
    crisp_shelf_db: float = 5.8,
    crisp_hz: float = 1050.0,
    fps: float = 50.0,
) -> np.ndarray:
    """Laver Fig. 17b-2/3 faithful F0-locked period-2/3/4 subharmonic creaky-falsetto modulator (pure NumPy)."""
    x = np.asarray(wav, dtype=np.float64).reshape(-1)
    n = x.size
    curve = np.asarray(w_eff_50hz, dtype=np.float64).reshape(-1)
    f0_arr = np.asarray(f0_50hz, dtype=np.float64).reshape(-1)
    if n == 0 or curve.size == 0 or f0_arr.size == 0 or float(np.max(curve)) <= 1e-5:
        return np.ascontiguousarray(x, dtype=np.float32)

    t_f = (np.arange(curve.size, dtype=np.float64) + 0.5) / float(fps)
    t_f0 = (np.arange(f0_arr.size, dtype=np.float64) + 0.5) / float(fps)
    t_s = np.arange(n, dtype=np.float64) / float(sample_rate)
    g = np.clip(_smooth_1d_gaussian(np.interp(t_s, t_f, curve), sigma=max(1.0, 0.010 * float(sample_rate))), 0.0, 1.0)
    f0_s = np.maximum(60.0, np.interp(t_s, t_f0, f0_arr))

    ir = float(np.clip(irregularity, 0.0, 1.0))
    micro_jit = 1.0 + 0.075 * ir * (
        0.55 * np.sin(2.0 * np.pi * 13.7 * t_s + 0.4)
        + 0.45 * np.sin(2.0 * np.pi * 23.3 * t_s + 1.9)
    )
    phi0 = 2.0 * np.pi * np.cumsum(f0_s * micro_jit) / float(sample_rate)

    p2 = np.power(0.5 + 0.5 * np.cos(0.5 * phi0), sharpness)
    p3 = np.power(0.5 + 0.5 * np.cos((1.0 / 3.0) * phi0 + 0.7), sharpness)
    p4 = np.power(0.5 + 0.5 * np.cos(0.25 * phi0 + 1.6), sharpness)

    if bifurcation and ir > 1e-4:
        sw = 0.5 + 0.5 * np.sin(2.0 * np.pi * 5.3 * t_s + 0.6 * np.sin(2.0 * np.pi * 2.1 * t_s))
        eff_w2 = w2 * (0.45 + 0.55 * sw)
        eff_w3 = w3 * (0.45 + 0.55 * (1.0 - sw))
        eff_w4 = w4 * (0.35 + 0.65 * (1.0 - sw))
    else:
        eff_w2, eff_w3, eff_w4 = w2, w3, w4

    alt = (eff_w2 * p2 + eff_w3 * p3 + eff_w4 * p4) / (eff_w2 + eff_w3 + eff_w4 + 1e-12)
    shimmer = 1.0 + 0.28 * ir * (
        0.60 * np.sin(2.0 * np.pi * 17.3 * t_s + 1.1)
        + 0.40 * np.sin(2.0 * np.pi * 29.1 * t_s + 2.3)
    )
    alt = np.clip(alt * shimmer, 0.0, 1.25)

    env_sub = floor_lvl + (1.0 - floor_lvl) * alt
    env_rms = float(np.sqrt(np.mean(env_sub**2)) + 1e-12)
    env_norm = env_sub / env_rms

    if crisp_shelf_db > 0.1:
        _, x_hi = _zero_phase_butter2_split(x, crisp_hz, sample_rate)
        spike_gate = np.clip((alt - 0.35) / 0.65, 0.0, 1.0)
        hi_boost = (10.0 ** (float(crisp_shelf_db) / 20.0) - 1.0) * (0.35 + 0.65 * spike_gate) * g
        x_crisp = x + hi_boost * x_hi
    else:
        x_crisp = x

    y = x_crisp * env_norm
    v = g > 0.5
    if np.any(v):
        peak_v = float(np.percentile(np.abs(y[v]), 98) + 1e-12)
        yn = y / peak_v
        y_asym = (yn + 0.14 * np.maximum(0.0, yn) ** 2) * peak_v
        r0 = float(np.sqrt(np.mean(x[v] ** 2)) + 1e-12)
        r1 = float(np.sqrt(np.mean(y_asym[v] ** 2)) + 1e-12)
        if r1 > 1e-6:
            y = y_asym * (r0 / r1)

    return np.ascontiguousarray(x * (1.0 - g) + y * g, dtype=np.float32)


@dataclass
class DualMorphConfig:
    align_mode: str = "dtw"               # "dtw" | "anchors"
    anchors_sec: List[Dict[str, float]] = field(default_factory=list)
    group_curves: Dict[str, List[Dict[str, float]]] = field(default_factory=dict)
    delta_groups: List[str] = field(default_factory=lambda: ["tongue_jaw", "larynx"])
    interp_mode: str = "smoothstep"
    enable_voicing_gate: bool = True      # Prevents injecting voiced glottis into silent frames
    smooth_ms: float = 25.0               # Anti-click Gaussian smoothing (ms)
    enable_f0_coupling: bool = False      # Auto-aligns A's F0 register toward B along speaker/glottis curve
    f0_coupling_strength: float = 1.0
    fps: float = 50.0
    output_f0_range_hz: Optional[Tuple[float, float]] = None


def _shift_f0_register(
    f0_hz: np.ndarray,
    curve: np.ndarray,
    voiced_gate: np.ndarray,
    config: PresetMorphConfig,
    target_hz: float,
    *,
    min_lift_semitones: float = 0.0,
) -> Tuple[np.ndarray, float, float]:
    """Shift the high-weight voiced register up (falsetto, speaker-adaptive) or down (creaky/creak) while retaining pitch contour."""
    if config.output_f0_range_hz is not None:
        lo, hi = config.output_f0_range_hz
        if not lo <= target_hz <= hi:
            raise F0ShiftOutOfRange(target_hz)
    else:
        lo, hi = None, None
    voiced = (voiced_gate >= 0.5) & (curve > 1e-4)
    if not np.any(voiced) or config.f0_coupling_strength <= 0.0:
        return f0_hz, 0.0, target_hz

    # A steady 80% modulation reaches the target. Weaker weights ease into the register.
    full_weight = 0.8
    reference_frames = voiced & (curve >= min(full_weight, 0.9 * float(np.max(curve[voiced]))))
    reference_hz = float(np.median(f0_hz[reference_frames]))
    lowering = target_hz < 100.0
    effective_target_hz = float(target_hz)
    if not lowering and min_lift_semitones > 0.0:
        # Adapt falsetto register upward for high-pitched / female speakers whose modal F0 is already 200-360 Hz.
        adaptive_hz = reference_hz * float(2.0 ** (min_lift_semitones / 12.0))
        if hi is not None:
            adaptive_hz = min(adaptive_hz, hi * 0.96)
        effective_target_hz = max(effective_target_hz, adaptive_hz)

    if lowering and reference_hz <= effective_target_hz:
        return f0_hz, 0.0, effective_target_hz
    if not lowering and reference_hz >= effective_target_hz:
        return f0_hz, 0.0, effective_target_hz

    mix = np.minimum(curve / full_weight, 1.0)
    if config.enable_voicing_gate:
        # SwiftF0-confirmed voicing contributes 0.75 to the shared soft gate.
        mix *= np.minimum(voiced_gate / 0.75, 1.0)
    pitch_octaves = np.log2(np.maximum(f0_hz.astype(np.float64), 1e-3) / max(reference_hz, 1e-3))
    register_shift = np.log2(effective_target_hz / max(reference_hz, 1e-3))
    if lowering:
        floor_hz = lo if lo is not None else min(36.0, max(20.0, effective_target_hz * 0.80))
        low_excursion = float(np.min(pitch_octaves[mix > 0.0]))
        footroom = np.log2(min(floor_hz, effective_target_hz) / effective_target_hz)
        if low_excursion < footroom and abs(low_excursion) > 1e-9:
            contour_scale = max(0.0, footroom / low_excursion)
        else:
            contour_scale = 1.0
        shift_octaves = np.minimum(0.0, register_shift + (contour_scale - 1.0) * pitch_octaves)
    else:
        high_excursion = float(np.max(pitch_octaves[mix > 0.0]))
        if hi is not None:
            headroom = np.log2(hi / effective_target_hz)
            contour_scale = headroom / high_excursion if high_excursion > headroom else 1.0
        else:
            contour_scale = 1.0
        # Reduce the contour's span only when its high excursions would exceed the model range.
        shift_octaves = np.maximum(0.0, register_shift + (contour_scale - 1.0) * pitch_octaves)
    applied_octaves = mix * min(config.f0_coupling_strength, 1.0) * shift_octaves
    return (
        (f0_hz * np.exp2(applied_octaves)).astype(np.float32),
        float(12.0 * np.median(applied_octaves[reference_frames])),
        round(effective_target_hz, 1),
    )


_raise_f0_register = _shift_f0_register


def apply_preset_phonation_morph(
    m27_norm: np.ndarray,
    config: PresetMorphConfig,
    *,
    preset_dict: Optional[Dict[str, Any]] = None,
    f0_voiced: Optional[np.ndarray] = None,
) -> Dict[str, Any]:
    """Mode 1: Alignment-free time-varying phonation preset modulation on a single recording."""
    norm_in = np.asarray(m27_norm, dtype=np.float32)
    phys_in = denormalize_m27_norm(norm_in)
    n_frames = phys_in.shape[0]

    preset = preset_dict or BUILTIN_PHONATION_PRESETS.get(config.preset_id)
    if preset is None:
        raise KeyError(f"未知发声类型预设: {config.preset_id}")

    src9 = np.asarray(preset["source9_phys"], dtype=np.float32)
    target_pr = float(src9[0])
    target_glot8 = src9[1:9]  # [XB, XT, CA, LAG, RA, PS, FL, SHIM]
    is_voiceless_target = bool(preset.get("is_voiceless_target", False))
    is_diplophonia = bool(preset.get("supports_diplophonia", False))

    w_raw = sample_curve_50hz(
        config.knots,
        n_frames,
        fps=config.fps,
        default_value=0.0,
        interp_mode=config.interp_mode,
    )
    w_smooth = smooth_curve_anti_click(w_raw, smooth_ms=config.smooth_ms, fps=config.fps)
    voiced_gate, speech_gate = compute_voicing_and_speech_gates(
        phys_in, f0_voiced=f0_voiced, fps=config.fps
    )

    if config.enable_voicing_gate:
        active_gate = speech_gate if is_voiceless_target else voiced_gate
        w_eff = (w_smooth * active_gate).astype(np.float32)
    else:
        w_eff = w_smooth.copy()

    phys_out = phys_in.copy()

    if not is_diplophonia:
        # 1. Blend 8-dim glottis smoothly toward target preset
        w_col = w_eff[:, None]
        phys_out[:, 19:27] = (1.0 - w_col) * phys_in[:, 19:27] + w_col * target_glot8[None, :]

        # 1b. Optional larynx height offset (HY index = 1, cm) for VoQS L̝ / L̞ presets
        hy_delta = preset.get("larynx_hy_delta_cm")
        if isinstance(hy_delta, (int, float)) and abs(float(hy_delta)) > 1e-5:
            phys_out[:, 1] = np.clip(
                phys_in[:, 1] + w_eff * float(hy_delta),
                float(M27_MIN_PHYS[1]),
                float(M27_MAX_PHYS[1]),
            )

        # 2. Modulate PR relative to modal baseline (8200 dPa) while preserving natural loudness contour & silence
        modal_pr = 8200.0
        pr_ratio = np.clip(target_pr / modal_pr, 0.20, 1.80)
        pr_mod_ratio = float(preset.get("pr_modulation_ratio", config.pr_modulation_ratio))
        pr_scale = 1.0 + w_eff * (pr_ratio - 1.0) * float(np.clip(pr_mod_ratio, 0.0, 1.0))
        phys_out[:, PR_INDEX] = np.clip(phys_in[:, PR_INDEX] * pr_scale, 0.0, 16000.0)

    # 3. Optional F0 coupling (strictly gated on voiced frames so unvoiced segments never get distorted)
    f0_before = phys_in[:, F0_INDEX].copy()
    semitones = (
        float(config.f0_shift_semitones)
        if config.f0_shift_semitones is not None
        else float(preset.get("f0_shift_semitones", 0.0))
    )
    applied_semitones = 0.0
    applied_target_hz = None
    target_hz = preset.get("f0_target_hz") if config.f0_shift_semitones is None else None
    min_lift_st = float(preset.get("f0_min_lift_semitones") or 0.0)
    if config.enable_f0_coupling and target_hz is not None:
        phys_out[:, F0_INDEX], applied_semitones, effective_target = _shift_f0_register(
            f0_before, w_smooth, voiced_gate, config, float(target_hz), min_lift_semitones=min_lift_st,
        )
        if abs(applied_semitones) > 1e-4:
            applied_target_hz = effective_target
    elif config.enable_f0_coupling and abs(semitones) > 1e-4:
        f0_gate = w_smooth * voiced_gate if config.enable_voicing_gate else w_smooth
        phys_out[:, F0_INDEX] = apply_f0_semitone_coupling(
            f0_before,
            f0_gate,
            semitones=semitones,
            strength=config.f0_coupling_strength,
            output_range_hz=config.output_f0_range_hz,
        )
        applied_semitones = semitones * config.f0_coupling_strength

    # 3b. Deterministic regular <-> irregular F0 jitter & crisp pulse-amplitude shimmer for creak / creaky presets
    f0_jitter_ratio = float(preset.get("f0_jitter_ratio") or 0.0)
    pr_pulse_ratio = float(preset.get("pr_pulse_ratio") or 0.0)
    if (f0_jitter_ratio > 1e-4 or pr_pulse_ratio > 1e-4) and n_frames > 0:
        irreg = float(np.clip(config.creak_irregularity, 0.0, 1.0))
        irreg_scale = irreg / 0.70  # 0.0 -> 0x (regular), 0.70 -> 1.0x (default), 1.0 -> 1.43x (strong fry)
        t_sec = np.arange(n_frames, dtype=np.float64) / float(config.fps)
        jitter_gate = (
            (w_smooth * np.minimum(voiced_gate / 0.75, 1.0)).astype(np.float64)
            if config.enable_voicing_gate
            else w_smooth.astype(np.float64)
        )
        # Scale FL (25) & SHIM (26) perturbation channels with irregularity so 0% yields clean regular pulses
        fl_shim_scale = 0.30 + 0.70 * min(1.30, irreg_scale)
        for dim_idx in (25, 26):
            target_pert = float(np.clip(target_glot8[dim_idx - 19] * fl_shim_scale, 0.0, 100.0))
            phys_out[:, dim_idx] = ((1.0 - w_eff) * phys_in[:, dim_idx] + w_eff * target_pert).astype(np.float32)

        if f0_jitter_ratio > 1e-4 and irreg > 1e-4:
            # Sub-Nyquist incommensurate waves on 50 Hz grid -> irregular diplophonic / vocal fry pitch flutter
            f0_wave = (
                0.50 * np.sin(2.0 * np.pi * 19.3 * t_sec + 0.4)
                + 0.32 * np.sin(2.0 * np.pi * 11.7 * t_sec + 1.9)
                + 0.18 * np.sin(2.0 * np.pi * 6.1 * t_sec + 3.1)
            )
            f0_next = phys_out[:, F0_INDEX].astype(np.float64) * np.exp(
                jitter_gate * (f0_jitter_ratio * irreg_scale) * f0_wave
            )
            if config.output_f0_range_hz is not None:
                lo_j, hi_j = config.output_f0_range_hz
                f0_next = np.clip(f0_next, lo_j, hi_j)
            else:
                f0_next = np.maximum(f0_next, 20.0)
            phys_out[:, F0_INDEX] = f0_next.astype(np.float32)
        if pr_pulse_ratio > 1e-4:
            # Blend from clean periodic pulse train (irreg=0) to sharp asymmetric irregular creak pulses (irreg>0)
            reg_wave = np.sin(2.0 * np.pi * 12.5 * t_sec)
            irreg_raw = (
                0.52 * np.sin(2.0 * np.pi * 17.3 * t_sec + 1.1)
                + 0.30 * np.sin(2.0 * np.pi * 9.7 * t_sec + 2.6)
                + 0.18 * np.sin(2.0 * np.pi * 4.9 * t_sec + 0.2)
            )
            # Carve sharper inter-pulse troughs so discrete creak pulses punch cleanly even in falsetto register
            irreg_sharp = 2.0 * np.power(np.clip(0.5 + 0.5 * irreg_raw, 0.0, 1.0), 1.75) - 1.0
            amp_wave = (1.0 - irreg) * (0.55 * reg_wave) + irreg * irreg_sharp
            pulse_strength = pr_pulse_ratio * (0.45 + 0.55 * irreg_scale)
            pulse_gain = np.clip(1.0 + jitter_gate * pulse_strength * amp_wave, 0.18, 1.55)
            phys_out[:, PR_INDEX] = np.clip(phys_out[:, PR_INDEX] * pulse_gain, 0.0, 16000.0).astype(np.float32)
            ra_pulse = np.clip(1.0 + jitter_gate * (0.85 * pulse_strength) * amp_wave, 0.05, 1.35)
            phys_out[:, 23] = np.clip(phys_out[:, 23] * ra_pulse, -1.0, 1.0).astype(np.float32)

    # 3c. Dual-source shared-tract diplophonia (V‼) secondary vocal source track
    diplophonia_payload: Optional[Dict[str, Any]] = None
    if is_diplophonia:
        dip_mode = config.diplophonia_mode if config.diplophonia_mode in DIPLOPHONIA_MODES else str(
            preset.get("default_diplophonia_mode", "parallel")
        )
        spec = DIPLOPHONIA_MODES[dip_mode]
        ratio = float(config.diplophonia_ratio)
        if not np.isfinite(ratio) or ratio <= 0.0:
            raise F0ShiftOutOfRange(ratio)

        f0_primary = phys_out[:, F0_INDEX].astype(np.float64)
        v_mask = voiced_gate >= 0.5
        med_f0 = float(np.median(f0_primary[v_mask])) if np.any(v_mask) else float(np.median(f0_primary))
        tracking = float(spec["contour_tracking"])
        base_contour = (1.0 - tracking) * med_f0 + tracking * f0_primary
        f0_sec_raw = base_contour * ratio
        slow_drift = float(spec["slow_drift"])
        if slow_drift > 0.0 and n_frames > 0:
            t_sec = np.arange(n_frames, dtype=np.float64) / float(config.fps)
            drift = (
                1.0
                + slow_drift * np.sin(2.0 * np.pi * 2.7 * t_sec)
                + 0.6 * slow_drift * np.sin(2.0 * np.pi * 6.3 * t_sec + 1.1)
            )
            f0_sec_raw = f0_sec_raw * drift

        active_v = v_mask & (w_smooth > 1e-4)
        if config.output_f0_range_hz is not None and np.any(active_v):
            lo_d, hi_d = config.output_f0_range_hz
            min_v = float(np.min(f0_sec_raw[active_v]))
            max_v = float(np.max(f0_sec_raw[active_v]))
            if min_v < lo_d:
                raise F0ShiftOutOfRange(min_v)
            if max_v > hi_d:
                raise F0ShiftOutOfRange(max_v)
        elif np.any(active_v):
            min_v = float(np.min(f0_sec_raw[active_v]))
            if not np.isfinite(min_v) or min_v <= 0.0:
                raise F0ShiftOutOfRange(min_v)

        vg = voiced_gate.astype(np.float64)
        f0_sec = f0_primary * (1.0 - vg) + f0_sec_raw * vg
        phys_secondary = phys_out.copy()
        phys_secondary[:, F0_INDEX] = f0_sec.astype(np.float32)
        sec_src9 = np.asarray(spec["secondary_source9_phys"], dtype=np.float32)
        blend_w = (float(spec["source_blend"]) * voiced_gate)[:, None].astype(np.float32)
        phys_secondary[:, 18:27] = (1.0 - blend_w) * phys_out[:, 18:27] + blend_w * sec_src9[None, :]
        phys_secondary[:, PR_INDEX] = np.clip(phys_secondary[:, PR_INDEX], 0.0, 16000.0)

        diplophonia_payload = {
            "mode": dip_mode,
            "ratio": round(ratio, 3),
            "m27_secondary_phys": phys_secondary,
            "m27_secondary_norm": normalize_m27_phys(phys_secondary),
            "f_b_50hz": phys_secondary[:, F0_INDEX].copy(),
            "mix_curve_50hz": w_eff.copy(),
            "ratio_b_max": float(spec["ratio_b_max"]),
            "am_depth_max": float(spec["am_depth_max"]),
        }

    # 3d. Optional preset-specific audio post-processing specs (sinusoidal falsetto softening, F0-locked
    #     Laver 17b-2/3 subharmonic creaky-falsetto, and shared-tract continuous posterior-chink whisper air)
    audio_post: Optional[Dict[str, Any]] = None
    post_soft = preset.get("post_soft_falsetto")
    post_sub = preset.get("post_subharmonic_creak")
    post_air = float(preset.get("post_whisper_air_ratio") or 0.0)
    if post_soft or post_sub or post_air > 1e-4:
        audio_post = {}
        if isinstance(post_soft, dict):
            audio_post["soft_falsetto"] = dict(post_soft)
        if isinstance(post_sub, dict):
            audio_post["subharmonic_creak"] = {
                **post_sub,
                "irregularity": float(np.clip(config.creak_irregularity, 0.0, 1.0)),
            }
        if post_air > 1e-4:
            whisper_src9 = np.asarray(BUILTIN_PHONATION_PRESETS["whisper"]["source9_phys"], dtype=np.float32)
            w_air = (w_smooth * speech_gate).astype(np.float32) if config.enable_voicing_gate else w_smooth.copy()
            phys_air = phys_in.copy()
            w_air_col = w_air[:, None]
            phys_air[:, 19:27] = (1.0 - w_air_col) * phys_in[:, 19:27] + w_air_col * whisper_src9[1:9][None, :]
            pr_air_ratio = float(np.clip(float(whisper_src9[0]) / 8200.0, 0.20, 1.80))
            pr_air_scale = 1.0 + w_air * (pr_air_ratio - 1.0) * float(np.clip(config.pr_modulation_ratio, 0.0, 1.0))
            phys_air[:, PR_INDEX] = np.clip(phys_in[:, PR_INDEX] * pr_air_scale, 0.0, 16000.0)
            audio_post["whisper_air"] = {
                "ratio_b_max": float(np.clip(post_air, 0.0, 0.60)),
                "m27_whisper_phys": phys_air,
                "m27_whisper_norm": normalize_m27_phys(phys_air),
                "mix_curve_50hz": w_air,
            }

    norm_out = normalize_m27_phys(phys_out)
    return {
        "m27_norm": norm_out,
        "m27_phys": phys_out,
        "w_raw": w_raw,
        "w_smooth": w_smooth,
        "w_eff": w_eff,
        "voiced_gate": voiced_gate,
        "speech_gate": speech_gate,
        "f0_before_hz": f0_before,
        "f0_after_hz": phys_out[:, F0_INDEX].copy(),
        "applied_semitones": round(applied_semitones, 2),
        "f0_target_hz": applied_target_hz,
        "diplophonia": diplophonia_payload,
        "audio_post": audio_post,
    }


def apply_dual_speaker_morph(
    m27_norm_a: np.ndarray,
    m27_norm_b: np.ndarray,
    config: DualMorphConfig,
    *,
    spk_emb_a: Optional[np.ndarray] = None,
    spk_emb_b: Optional[np.ndarray] = None,
    f0_voiced_a: Optional[np.ndarray] = None,
    f0_voiced_b: Optional[np.ndarray] = None,
) -> Dict[str, Any]:
    """Mode 2: Align B onto A's timeline (or blend segment durations via `timing`), then apply per-organ curves + SLERP."""
    a_norm = np.asarray(m27_norm_a, dtype=np.float32)
    b_norm = np.asarray(m27_norm_b, dtype=np.float32)
    ta = a_norm.shape[0]
    tb = b_norm.shape[0]
    applied_curves: Dict[str, np.ndarray] = {}

    # 1. Optional annotation-aligned timing/prosody duration morphing (`timing` curve on A's time axis)
    timing_knots = config.group_curves.get("timing")
    timing_active = False
    w_timing_a = np.zeros(ta, dtype=np.float32)
    if timing_knots:
        w_timing_raw = sample_curve_50hz(
            timing_knots, ta, fps=config.fps, default_value=0.0, interp_mode=config.interp_mode
        )
        w_timing_a = smooth_curve_anti_click(w_timing_raw, smooth_ms=config.smooth_ms, fps=config.fps)
        applied_curves["timing"] = w_timing_a
        if float(np.max(w_timing_a)) > 1e-5:
            if config.align_mode != "anchors" or not config.anchors_sec:
                raise ValueError("启用「时长与韵律」轨前，请先为说话人 A 与 B 完成文字或音节标注对齐")
            timing_active = True

    if timing_active:
        frame_map_a, frame_map_b, align_info = build_timing_morphed_maps(
            ta, tb, config.anchors_sec, w_timing_a, fps=config.fps
        )
        a_work_norm = _interp_trajectory_by_map(a_norm, frame_map_a)
        b_aligned_norm = _interp_trajectory_by_map(b_norm, frame_map_b)
        f0_voiced_a_work = (
            np.interp(frame_map_a, np.arange(len(f0_voiced_a)), f0_voiced_a).astype(np.float32)
            if f0_voiced_a is not None and len(f0_voiced_a)
            else None
        )
    else:
        frame_map_a = np.arange(ta, dtype=np.float32)
        a_work_norm = a_norm
        f0_voiced_a_work = f0_voiced_a
        if config.align_mode == "anchors" and config.anchors_sec:
            b_aligned_norm, frame_map_b, align_info = align_m27_anchors(
                a_norm, b_norm, config.anchors_sec, fps=config.fps
            )
        else:
            b_aligned_norm, frame_map_b, align_info = align_m27_dtw(a_norm, b_norm)

    t_out = a_work_norm.shape[0]
    src_a_idx = np.arange(ta, dtype=np.float64)

    def _map_a_curve_to_out(w_on_a: np.ndarray) -> np.ndarray:
        if not timing_active:
            return w_on_a
        return np.interp(frame_map_a.astype(np.float64), src_a_idx, w_on_a.astype(np.float64)).astype(np.float32)

    def _project_out_curve_to_a(w_on_out: np.ndarray) -> np.ndarray:
        if not timing_active:
            return w_on_out
        return np.interp(src_a_idx, frame_map_a.astype(np.float64), w_on_out.astype(np.float64)).astype(np.float32)

    a_phys = denormalize_m27_norm(a_work_norm)
    b_phys = denormalize_m27_norm(b_aligned_norm)
    voiced_gate_a, speech_gate_a = compute_voicing_and_speech_gates(
        a_phys, f0_voiced=f0_voiced_a_work, fps=config.fps
    )

    out_norm = a_work_norm.copy()
    delta_set = set(config.delta_groups or [])
    applied_curves_out: Dict[str, np.ndarray] = {}

    # Track per-dimension weights when multiple groups are active; apply coarse groups first then fine overrides
    group_order = ("tract_all", "tongue_jaw", "larynx", "lips", "velum", "f0_pr", "glottis")
    for gid in group_order:
        if gid not in config.group_curves:
            continue
        knots = config.group_curves[gid]
        if not knots:
            continue
        gdef = ORGAN_GROUPS.get(gid)
        if not gdef or not gdef.get("indices"):
            continue
        w_raw_a = sample_curve_50hz(knots, ta, fps=config.fps, default_value=0.0, interp_mode=config.interp_mode)
        w_sm_a = smooth_curve_anti_click(w_raw_a, smooth_ms=config.smooth_ms, fps=config.fps)
        w_sm = _map_a_curve_to_out(w_sm_a)
        if float(np.max(w_sm)) < 1e-5:
            applied_curves[gid] = w_sm_a
            applied_curves_out[gid] = w_sm
            continue

        if config.enable_voicing_gate and gid == "glottis":
            adds_vibration = b_phys[:, 23] > a_phys[:, 23]
            w_eff = (w_sm * np.where(adds_vibration, voiced_gate_a, speech_gate_a)).astype(np.float32)
        else:
            w_eff = w_sm

        idxs = gdef["indices"]
        use_delta = gid in delta_set
        if use_delta:
            # Transfer B's dynamic excursion relative to B's own median posture onto A's anatomical baseline
            med_b = np.median(b_aligned_norm[:, idxs], axis=0, keepdims=True)
            med_a = np.median(a_work_norm[:, idxs], axis=0, keepdims=True)
            b_rel_on_a = np.clip(med_a + (b_aligned_norm[:, idxs] - med_b), -1.0, 1.0)
            out_norm[:, idxs] = (1.0 - w_eff[:, None]) * out_norm[:, idxs] + w_eff[:, None] * b_rel_on_a
        else:
            out_norm[:, idxs] = (1.0 - w_eff[:, None]) * out_norm[:, idxs] + w_eff[:, None] * b_aligned_norm[:, idxs]

        applied_curves_out[gid] = w_eff
        applied_curves[gid] = _project_out_curve_to_a(w_eff)

    # 2. Frame-wise speaker embedding SLERP for neural synthesis.
    spk_curve_knots = config.group_curves.get("speaker")
    spk_w_a = (
        smooth_curve_anti_click(
            sample_curve_50hz(spk_curve_knots, ta, fps=config.fps, default_value=0.0, interp_mode=config.interp_mode),
            smooth_ms=config.smooth_ms,
            fps=config.fps,
        )
        if spk_curve_knots
        else np.zeros(ta, dtype=np.float32)
    )
    spk_w = _map_a_curve_to_out(spk_w_a)
    applied_curves["speaker"] = spk_w_a
    applied_curves_out["speaker"] = spk_w

    spk_seq: Optional[np.ndarray] = None
    if spk_emb_a is not None and spk_emb_b is not None:
        spk_seq = slerp_speaker_sequence(spk_emb_a, spk_emb_b, spk_w)
    elif spk_emb_a is not None:
        ea = np.asarray(spk_emb_a, dtype=np.float32).reshape(1, -1)
        ea = ea / max(1e-8, float(np.linalg.norm(ea)))
        spk_seq = np.repeat(ea, t_out, axis=0)

    out_phys = denormalize_m27_norm(out_norm)

    # 3. Optional F0 register coupling (shifts A's F0 median toward B's register along speaker/glottis curve
    #    when f0_pr itself is not already fully transplanted)
    auto_shift_st = 0.0
    if config.enable_f0_coupling:
        drive_w = np.maximum(
            applied_curves_out.get("speaker", np.zeros(t_out, dtype=np.float32)),
            applied_curves_out.get("glottis", np.zeros(t_out, dtype=np.float32)),
        )
        f0_pr_w = applied_curves_out.get("f0_pr", np.zeros(t_out, dtype=np.float32))
        residual_w = np.clip(drive_w * (1.0 - f0_pr_w), 0.0, 1.0)
        if float(np.max(residual_w)) > 1e-4:
            va_mask = voiced_gate_a > 0.5
            source_voiced = None
            if f0_voiced_b is not None and len(f0_voiced_b):
                source_voiced = np.interp(frame_map_b, np.arange(len(f0_voiced_b)), f0_voiced_b)
            vb_gate, _ = compute_voicing_and_speech_gates(b_phys, f0_voiced=source_voiced, fps=config.fps)
            vb_mask = vb_gate > 0.5
            med_f0_a = float(np.median(a_phys[va_mask, F0_INDEX])) if np.any(va_mask) else float(np.median(a_phys[:, F0_INDEX]))
            med_f0_b = float(np.median(b_phys[vb_mask, F0_INDEX])) if np.any(vb_mask) else float(np.median(b_phys[:, F0_INDEX]))
            auto_shift_st = float(np.clip(12.0 * np.log2(max(40.0, med_f0_b) / max(40.0, med_f0_a)), -14.0, 14.0))
            gate_use = voiced_gate_a if config.enable_voicing_gate else np.ones(t_out, dtype=np.float32)
            out_phys[:, F0_INDEX] = apply_f0_semitone_coupling(
                out_phys[:, F0_INDEX],
                residual_w * gate_use,
                semitones=auto_shift_st,
                strength=config.f0_coupling_strength,
                output_range_hz=config.output_f0_range_hz,
            )
            out_norm = normalize_m27_phys(out_phys)

    return {
        "m27_norm": out_norm,
        "m27_phys": out_phys,
        "spk_seq": spk_seq,
        "frame_map_a": frame_map_a,
        "frame_map_b": frame_map_b,
        "align_info": align_info,
        "out_dur_sec": round(float(t_out) / float(config.fps), 3),
        "voiced_gate_a": voiced_gate_a,
        "speech_gate_a": speech_gate_a,
        "applied_curves": applied_curves,
        "f0_before_hz": a_phys[:, F0_INDEX].copy(),
        "f0_after_hz": out_phys[:, F0_INDEX].copy(),
        "auto_f0_shift_semitones": round(auto_shift_st * config.f0_coupling_strength, 2) if config.enable_f0_coupling else 0.0,
    }
