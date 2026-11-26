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
    """Self-contained exact M27 normalization matching tt3.m27_contract."""
    arr = np.clip(np.asarray(m27_phys, dtype=np.float32), M27_MIN_PHYS, M27_MAX_PHYS)
    out = 2.0 * (arr - M27_MIN_PHYS) / (M27_MAX_PHYS - M27_MIN_PHYS) - 1.0
    out[..., F0_INDEX] = (2.0 * (np.log(arr[..., F0_INDEX]) - _LOG_F0_MIN) / (_LOG_F0_MAX - _LOG_F0_MIN) - 1.0)
    return np.clip(out, -1.0, 1.0).astype(np.float32)


def denormalize_m27_norm(m27_norm: np.ndarray) -> np.ndarray:
    """Self-contained exact M27 denormalization matching tt3.m27_contract."""
    arr = np.clip(np.asarray(m27_norm, dtype=np.float32), -1.0, 1.0)
    out = 0.5 * (arr + 1.0) * (M27_MAX_PHYS - M27_MIN_PHYS) + M27_MIN_PHYS
    out[..., F0_INDEX] = np.exp(0.5 * (arr[..., F0_INDEX] + 1.0) * (_LOG_F0_MAX - _LOG_F0_MIN) + _LOG_F0_MIN)
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
    fps: float = 50.0
    output_f0_range_hz: Optional[Tuple[float, float]] = None


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


def _raise_f0_register(
    f0_hz: np.ndarray,
    curve: np.ndarray,
    voiced_gate: np.ndarray,
    config: PresetMorphConfig,
    target_hz: float,
) -> Tuple[np.ndarray, float]:
    """Raise the high-weight voiced register while retaining the input pitch contour."""
    lo, hi = config.output_f0_range_hz or (float(M27_MIN_PHYS[F0_INDEX]), float(M27_MAX_PHYS[F0_INDEX]))
    if not lo <= target_hz <= hi:
        raise F0ShiftOutOfRange(target_hz)
    voiced = (voiced_gate >= 0.5) & (curve > 1e-4)
    if not np.any(voiced) or config.f0_coupling_strength <= 0.0:
        return f0_hz, 0.0

    # A steady 80% modulation reaches the target. Weaker weights ease into the register.
    full_weight = 0.8
    reference_frames = voiced & (curve >= min(full_weight, 0.9 * float(np.max(curve[voiced]))))
    reference_hz = float(np.median(f0_hz[reference_frames]))
    if reference_hz >= target_hz:
        return f0_hz, 0.0

    mix = np.minimum(curve / full_weight, 1.0)
    if config.enable_voicing_gate:
        # SwiftF0-confirmed voicing contributes 0.75 to the shared soft gate.
        mix *= np.minimum(voiced_gate / 0.75, 1.0)
    pitch_octaves = np.log2(f0_hz.astype(np.float64) / reference_hz)
    high_excursion = float(np.max(pitch_octaves[mix > 0.0]))
    headroom = np.log2(hi / target_hz)
    contour_scale = headroom / high_excursion if high_excursion > headroom else 1.0
    register_shift = np.log2(target_hz / reference_hz)
    # Reduce the contour's span only when its high excursions would exceed the model range.
    shift_octaves = np.maximum(0.0, register_shift + (contour_scale - 1.0) * pitch_octaves)
    applied_octaves = mix * min(config.f0_coupling_strength, 1.0) * shift_octaves
    return (f0_hz * np.exp2(applied_octaves)).astype(np.float32), float(12.0 * np.median(applied_octaves[reference_frames]))


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

    # 1. Blend 8-dim glottis smoothly toward target preset
    w_col = w_eff[:, None]
    phys_out[:, 19:27] = (1.0 - w_col) * phys_in[:, 19:27] + w_col * target_glot8[None, :]

    # 2. Modulate PR relative to modal baseline (8200 dPa) while preserving natural loudness contour & silence
    modal_pr = 8200.0
    pr_ratio = np.clip(target_pr / modal_pr, 0.35, 1.80)
    pr_scale = 1.0 + w_eff * (pr_ratio - 1.0) * float(np.clip(config.pr_modulation_ratio, 0.0, 1.0))
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
    if config.enable_f0_coupling and target_hz is not None:
        phys_out[:, F0_INDEX], applied_semitones = _raise_f0_register(
            f0_before, w_smooth, voiced_gate, config, float(target_hz),
        )
        if applied_semitones > 0.0:
            applied_target_hz = target_hz
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
