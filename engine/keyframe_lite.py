"""Project-local IPA2Tract-Lite inference for the 111-channel / 50 Hz trajectory adapter."""
from __future__ import annotations

import threading
import time
from typing import Any, Dict, List, Tuple

import numpy as np

from ipa_articulation import (
    ArticulatorTarget,
    STOP_PHASES,
    apply_articulator_targets,
    constriction_zone,
    normalize_tract,
    preserve_stop_transients,
    recorded_stop_poses,
)
from ipa_reference_trajectory import (
    apply_reference_trajectories,
    prepare_reference_trajectories,
    protection_weights,
)
from trills import apply_trill_to_m27, resolve_trill_place
from validation import (
    CONTROL_TOL,
    M27_MAX_PA,
    M27_MIN_PA,
    M27_PARAM_NAMES,
    M27_UNITS,
    TRACT19_JD2_MAX,
    TRACT19_JD2_MIN,
    TRACT19_JD2_NAMES,
    is_finite_number,
    out_of_range_error,
    validate_glottis_frames,
    validate_pose_target_or_delta,
    validate_scalar_range,
    validate_scalar_series,
    validate_tract19_frames,
    validation_error,
)

_MODELS_LOCK = threading.Lock()
_BANK_LOCK = threading.Lock()
_INFER_LOCK = threading.Lock()
_CACHED_MODELS = None
_CACHED_BANK = None

# Jaw and tongue columns in the 17-dimensional tract used by both renderers.
_LATERAL_TRACT_COLS = (3, *range(8, 17))

_ARTICULATORY_DIACRITICS = frozenset(
    "ʷʲˠˤ˞\u0303\u0308\u0318\u0319\u031c\u031d\u031e\u031f\u0320\u032a\u0334\u0339\u033a\u033b\u033c\u033d"
)


def _active_articulatory_diacritics(symbol: str) -> set[str]:
    from kf_ipa_synth.phonetics import strip_ipa_diacritics, validate_ipa_diacritics

    base = strip_ipa_diacritics(symbol)
    if not base or base == symbol:
        return set()
    val = validate_ipa_diacritics(symbol)
    ignored = set(val["ignored_diacritics"])  # type: ignore[arg-type]
    return {ch for ch in val["diacritics"] if ch in _ARTICULATORY_DIACRITICS and ch not in ignored}  # type: ignore[union-attr]


def _secondary_diacritic_dims(active_diacs: set[str], features: np.ndarray) -> Tuple[int, ...]:
    """Return tract17 indices controlled by active secondary diacritics (orthogonal to primary stop closure)."""
    if not active_diacs:
        return ()
    dims: set[int] = set()
    is_primary_labial = float(features[3]) >= 0.8 or float(features[4]) >= 0.5
    is_primary_palatal = float(features[7]) >= 0.8
    is_primary_velar = float(features[8]) >= 0.8
    if "ʷ" in active_diacs or "\u0339" in active_diacs or "\u031c" in active_diacs:
        dims.add(4)  # LP
        if not is_primary_labial:
            dims.add(5)  # LD is secondary open rounding aperture on non-labial consonants
    if "ʲ" in active_diacs and not is_primary_palatal:
        dims.update((12, 13))
        if not is_primary_velar:
            dims.update((8, 9))
    if ("ˠ" in active_diacs or "\u0334" in active_diacs) and not is_primary_velar:
        dims.update((8, 9))
        if "\u0334" in active_diacs:
            dims.add(0)
    if "ˤ" in active_diacs or "\u0318" in active_diacs or "\u0319" in active_diacs:
        dims.update((0, 1))
        if not is_primary_velar and not is_primary_palatal:
            dims.update((8, 9))
    if "\u0303" in active_diacs:
        dims.update((6, 7))
    return tuple(sorted(dims))


def _guard_diacritic_rounding_norm(
    selected_norm: np.ndarray,
    active_diacs: set[str],
    features: np.ndarray,
    role: str,
) -> np.ndarray:
    """Enforce physical rounding safety bounds on unlocked preset targets with ʷ / ̹ / ̜."""
    if not active_diacs.intersection({"ʷ", "\u0339", "\u031c"}):
        return selected_norm
    tract_min = M27_MIN_PA[:17]
    tract_span = M27_MAX_PA[:17] - tract_min
    phys = (tract_min + (selected_norm.astype(np.float64) + 1.0) * 0.5 * tract_span).copy()
    is_vowel = float(features[1]) >= 0.5 and not (float(features[2]) >= 0.5 and float(features[15]) < 0.5)
    is_primary_labial = float(features[3]) >= 0.8 or float(features[4]) >= 0.5
    is_stop = float(features[10]) >= 0.5
    if "ʷ" in active_diacs or "\u0339" in active_diacs:
        is_strong_w = "ʷ" in active_diacs
        if is_vowel:
            is_open = phys[3] < -5.15 and phys[9] < -1.85
            phys[4] = max(float(phys[4]), 0.88 if is_strong_w else 0.86)
            ld_max = (0.52 if is_strong_w else 0.58) if is_open else 0.30
            phys[5] = float(np.clip(min(float(phys[5]), ld_max), 0.23, 0.60))
            if phys[8] > 2.48 and phys[9] > -1.45 and phys[13] > 1.05:
                phys[8] -= 0.14
                phys[13] -= 0.35
        elif is_primary_labial:
            phys[4] = max(float(phys[4]), 0.72 if is_strong_w else 0.42)
            if role in ("release", "aspiration") and is_stop:
                phys[5] = max(float(phys[5]), 0.22)
        else:
            phys[4] = max(float(phys[4]), 0.74 if is_strong_w else 0.48)
            phys[5] = float(np.clip(min(float(phys[5]), 0.42), 0.32, 0.46))
    elif "\u031c" in active_diacs:
        if is_vowel:
            phys[4] = min(float(phys[4]), 0.15)
            phys[5] = max(float(phys[5]), 0.65)
    return normalize_tract(np.clip(phys, tract_min, M27_MAX_PA[:17]))


class AnnotationControlError(ValueError):
    def __init__(self, result: Dict[str, Any]) -> None:
        super().__init__(result["error"]["hint"])
        self.result = result


def models():
    """Return hot-pluggable ONNX availability handle (kept for backward compatibility)."""
    from model_registry_runtime import LOCAL_MODEL_MANAGER
    LOCAL_MODEL_MANAGER.require_session("IPA2Tract-Lite", device="cpu")
    return ("IPA2Tract-Lite", "Tract2Area-Proxy")


def default_pose_bank():
    global _CACHED_BANK
    if _CACHED_BANK is not None:
        return _CACHED_BANK
    with _BANK_LOCK:
        if _CACHED_BANK is not None:
            return _CACHED_BANK
        from m27_bridge import M27Bridge, TT3_ROOT
        M27Bridge.ensure_tt3_imports()
        from kf_ipa_synth.pose_bank import PoseBank

        assets = TT3_ROOT / "packages" / "kf_ipa_synth" / "assets"
        canonical = assets / "canonical_ipa_poses.json"
        fallback = assets / "jd2_starter_fallback_poses.json"
        if not canonical.is_file() or not fallback.is_file():
            raise FileNotFoundError("IPA2Tract-Lite 默认构型库不可用")
        _CACHED_BANK = PoseBank(canonical_json=canonical, fallback_json=fallback)
        return _CACHED_BANK


def default_poses(payload: Dict[str, Any]) -> Dict[str, Any]:
    phones = payload.get("phones")
    if not isinstance(phones, list) or not 1 <= len(phones) <= 1024:
        raise ValueError("默认构型查询需要 1–1024 个音素")
    if any(not isinstance(phone, dict) or not isinstance(phone.get("ipa"), str)
           or not 1 <= len(phone["ipa"]) <= 64 or type(phone.get("closure")) is not bool
           for phone in phones):
        raise ValueError("默认构型查询需要 IPA 和闭塞状态")
    bank = default_pose_bank()
    from kf_ipa_synth.baseline import kf26_and_f0_to_m27
    from kf_ipa_synth.m27_contract import denormalize_m27, m27_to_tract19

    with _BANK_LOCK:
        targets = np.stack([bank.raw_lookup_kf26(phone["ipa"], phone["closure"]) for phone in phones])
    m27 = denormalize_m27(kf26_and_f0_to_m27(targets, np.zeros(len(targets), dtype=np.float32)))
    return {"ok": True, "poses": m27_to_tract19(m27).tolist()}


def predict(payload: Dict[str, Any]) -> Dict[str, Any]:
    from model_registry_runtime import LOCAL_MODEL_MANAGER
    from onnx_inference import predict_ipa2tract, predict_tract_area_cm2

    cond = np.array(payload.get("cond_111"), dtype=np.float32)
    base = np.array(payload.get("x_base_26"), dtype=np.float32)
    alpha_raw = payload.get("alpha", 1.0)
    err = validate_scalar_range("alpha", alpha_raw, 0.0, 1.0, "ratio")
    if err:
        raise AnnotationControlError(err)
    alpha = float(alpha_raw)
    if (base.ndim != 2 or not 1 <= len(base) <= 3000 or base.shape[1] != 26 or cond.shape != (len(base), 111)
            or not np.isfinite(base).all() or not np.isfinite(cond).all()):
        raise ValueError("关键帧输入须包含 1–3000 个同长度的 111 维条件帧及 26 维基线帧")
    groups = {"lips": (4, 5), "jaw": (2, 3), "tongue_tip": (10, 11),
              "tongue_blade": (12, 13), "tongue_body": (8, 9), "velum": (6, 7)}
    mask = payload.get("organ_mask") or {}
    for group, value in mask.items():
        if group not in groups and group != "tongue_root" or value not in ("free_0.0", "auto_coartic", "strong_1.0"):
            raise ValueError("未知的器官约束")
        if group == "tongue_root" and value != "auto_coartic":
            raise ValueError("JD2 的舌根由声道几何求解，不能单独指定舌根约束")
        if value != "auto_coartic":
            for i in groups.get(group, ()):
                cond[:, 52 + i] = float(value == "strong_1.0")
                cond[:, 26 + i] = base[:, i] * cond[:, 52 + i]
    with _INFER_LOCK:
        out = predict_ipa2tract(cond, base, alpha=alpha)
        areas = predict_tract_area_cm2(out[..., :17]) if LOCAL_MODEL_MANAGER.is_enabled("Tract2Area-Proxy") else np.zeros((len(out), 6), dtype=np.float32)
    return {"ok": True, "status": "neural_ipa2tract", "x_hat_26": out.tolist(),
            "tube_area_proxy_6": areas.tolist()}


def _apply_locks(predicted: np.ndarray, raw: np.ndarray, weights: np.ndarray) -> np.ndarray:
    """Keep authored controls at their centers and match the model at edit edges."""
    return predicted + weights * (raw - predicted)


def _feather_boolean_locks(mask: np.ndarray, ramp_frames: int = 3) -> np.ndarray:
    """Convert a 1-D boolean lock mask into smooth [0, 1] weights with cosine ramps at edges."""
    weights = mask.astype(np.float64)
    n = len(mask)
    if n < 2 or ramp_frames <= 0 or not np.any(mask) or np.all(mask):
        return weights
    edges = np.flatnonzero(np.diff(np.r_[False, mask, False]))
    for a, b in edges.reshape(-1, 2):
        run_len = int(b - a)
        if run_len <= 0:
            continue
        left_ramp = min(ramp_frames, run_len // 2) if a > 0 else 0
        right_ramp = min(ramp_frames, run_len - left_ramp) if b < n else 0
        if left_ramp > 0:
            u = (np.arange(left_ramp, dtype=np.float64) + 1.0) / (left_ramp + 1.0)
            weights[a:a + left_ramp] = 0.5 * (1.0 - np.cos(np.pi * u))
        if right_ramp > 0:
            u = (np.arange(right_ramp, 0, -1, dtype=np.float64)) / (right_ramp + 1.0)
            weights[b - right_ramp:b] = 0.5 * (1.0 - np.cos(np.pi * u))
    return weights


def raised_cosine_bell(length: int, target_u: float = 0.5) -> np.ndarray:
    """Construct an asymmetric C1-smooth raised-cosine bell window on ``length`` frames.

    Peaks at ``1.0`` at ``target_u`` (default ``0.5``) and decays smoothly to ``0.0`` at
    segment boundaries so coarticulatory transitions at neighbors are preserved.
    """
    if length <= 0:
        return np.zeros(0, dtype=np.float64)
    if length == 1:
        return np.ones(1, dtype=np.float64)
    if length == 2:
        u0 = float(np.clip(target_u, 0.0, 1.0))
        w = np.array([1.0 - 0.5 * u0, 0.5 + 0.5 * u0], dtype=np.float64) if u0 >= 0.5 else np.array([1.0 - 0.5 * u0, 0.5 + 0.5 * u0], dtype=np.float64)
        return w / float(np.max(w))
    u = np.linspace(0.0, 1.0, length, dtype=np.float64)
    eps = 0.5 / float(length - 1)
    u0 = float(np.clip(target_u, eps, 1.0 - eps))
    w = np.where(
        u <= u0,
        0.5 * (1.0 - np.cos(np.pi * (u / u0))),
        0.5 * (1.0 - np.cos(np.pi * ((1.0 - u) / (1.0 - u0)))),
    )
    w[0] = 0.0
    w[-1] = 0.0
    peak_idx = int(np.clip(round(float(target_u) * (length - 1)), 0, length - 1))
    if float(target_u) <= 1e-6:
        w[0] = 1.0
    elif float(target_u) >= 1.0 - 1e-6:
        w[-1] = 1.0
    else:
        peak_idx = int(np.clip(round(u0 * (length - 1)), 1, length - 2))
        if w[peak_idx] > 1e-8:
            w = np.minimum(1.0, w / float(w[peak_idx]))
        w[peak_idx] = 1.0
    return w


def apply_keyframe_bell_overlays_tract19(
    tract_arr: np.ndarray,
    spans: List[Dict[str, Any]],
    *,
    field_prefix: str = "articulation_spans",
) -> Tuple[Optional[np.ndarray], Optional[Dict[str, Any]]]:
    """Superimpose raised-cosine target_params / pose_delta onto a reference (T, 19) JD2 trajectory."""
    out = np.asarray(tract_arr, dtype=np.float64).copy()
    size = len(out)
    for idx, span in enumerate(spans):
        if not isinstance(span, dict):
            continue
        tgt_raw = span.get("target_params")
        dlt_raw = span.get("pose_delta") if span.get("pose_delta") is not None else span.get("pose_deltas")
        if tgt_raw is None and dlt_raw is None:
            continue
        a, b = span.get("start_frame"), span.get("end_frame")
        if type(a) is not int or type(b) is not int or not 0 <= a < b <= size:
            return None, validation_error(f"{field_prefix}[{idx}]", "微调音段帧区间 [start_frame, end_frame) 无效")
        u_raw = span.get("target_u", 0.5)
        err = validate_scalar_range(f"{field_prefix}[{idx}].target_u", u_raw, 0.0, 1.0, "ratio")
        if err:
            return None, err
        parsed, err = validate_pose_target_or_delta(tgt_raw, dlt_raw, field_prefix=f"{field_prefix}[{idx}]")
        if err:
            return None, err
        assert parsed is not None
        seg_len = b - a
        u0 = float(u_raw)
        bell = raised_cosine_bell(seg_len, u0)
        peak_rel = int(np.argmax(bell))
        peak_abs = a + peak_rel
        delta19 = np.zeros(19, dtype=np.float64)
        for col, val in parsed["t19_target"].items():
            delta19[col] = val - float(out[peak_abs, col])
        for col, dval in parsed["t19_delta"].items():
            delta19[col] += dval
            peak_val = float(out[peak_abs, col]) + delta19[col]
            lo, hi = float(TRACT19_JD2_MIN[col]), float(TRACT19_JD2_MAX[col])
            if peak_val < lo - CONTROL_TOL or peak_val > hi + CONTROL_TOL:
                return None, out_of_range_error(
                    f"{field_prefix}[{idx}].pose_delta[{TRACT19_JD2_NAMES[col]}]",
                    round(peak_val, 5),
                    lo,
                    hi,
                    "vtl",
                    f"微调峰值帧 {TRACT19_JD2_NAMES[col]} ({peak_val:.4f}) 超出合法范围 [{lo}, {hi}]",
                )
        out[a:b] = np.clip(out[a:b] + bell[:, None] * delta19[None, :], TRACT19_JD2_MIN, TRACT19_JD2_MAX)
    return out, None


def apply_annotation_trajectory(payload: Dict[str, Any]) -> Tuple[Dict[str, Any], np.ndarray, Dict[str, Any]]:
    """Build the full M27 trajectory matching IPA2Tract-Lite reference inference and user locks."""
    started = time.perf_counter()
    raw_hz = payload.get("step_hz")
    if type(raw_hz) is not int or raw_hz != 200:
        raise AnnotationControlError(out_of_range_error("step_hz", raw_hz, 200, 200, "Hz", "协同构音需要 200 Hz 控制轨"))
    hz = raw_hz

    tract_in = payload.get("tract_frames")
    if not isinstance(tract_in, list) or not 1 <= len(tract_in) <= 12000:
        raise ValueError("协同构音需要 1–12000 帧 200 Hz JD2 控制轨")
    size = len(tract_in)

    tract_arr, err = validate_tract19_frames(
        tract_in, TRACT19_JD2_NAMES, TRACT19_JD2_MIN, TRACT19_JD2_MAX, field="tract_frames", expected_len=size,
    )
    if err:
        raise AnnotationControlError(err)

    f0_arr, err = validate_scalar_series("f0_hz", payload.get("f0_hz"), size, 60.0, 600.0, "Hz")
    if err:
        raise AnnotationControlError(err)
    pr_arr, err = validate_scalar_series("pressure_pa", payload.get("pressure_pa"), size, 0.0, 1600.0, "Pa")
    if err:
        raise AnnotationControlError(err)
    glot_arr, err = validate_glottis_frames(payload.get("glottis_frames"), size, field="glottis_frames")
    if err:
        raise AnnotationControlError(err)
    assert tract_arr is not None and f0_arr is not None and pr_arr is not None and glot_arr is not None

    if glot_arr.shape[1] == 7:
        shimmer_val = payload.get("shimmer", 0.0)
        err = validate_scalar_range("shimmer", shimmer_val, 0.0, 100.0, "%")
        if err:
            raise AnnotationControlError(err)
        glot_arr = np.column_stack((glot_arr, np.full(size, float(shimmer_val), dtype=np.float64)))

    indices = list(range(14)) + [16, 17, 18]
    raw = np.column_stack((tract_arr[:, indices], f0_arr, pr_arr * 10.0, glot_arr)).astype(np.float32)

    from model_registry_runtime import LOCAL_MODEL_MANAGER
    from onnx_inference import (
        apply_soft_onset_200hz as _apply_soft_onset_200hz,
        apply_unreleased_zero_pressure_200hz as _apply_unreleased_zero_pressure_200hz,
        enforce_release_modes_50hz as _enforce_release_modes_50hz,
        ensure_pure_numpy_imports,
        predict_ipa2tract,
        predict_tract_area_cm2,
    )

    ensure_pure_numpy_imports()
    bank = default_pose_bank()
    from kf_ipa_synth.baseline import build_condition_from_segments, kf26_and_f0_to_m27
    from kf_ipa_synth.m27_contract import denormalize_m27, normalize_m27
    from kf_ipa_synth.phonetics import SegmentEvent, ipa_to_phon_features_checked
    from kf_ipa_synth.schema import KeyframeSpec
    from kf_ipa_synth.tract_backend import qta_filter_m27_50_to_200

    normalized = normalize_m27(raw)
    segments: List[SegmentEvent] = []
    targets: Dict[int, np.ndarray] = {}
    masks: Dict[int, np.ndarray] = {}
    roles: List[str] = []
    locks = np.zeros((size, 27), dtype=np.float64)
    silence_mask_200 = np.zeros(size, dtype=bool)
    previous_sample = 0
    samples_per_frame = 48000 // hz
    sample_count = payload.get("sample_count", size * samples_per_frame)
    if type(sample_count) is not int or not (size - 1) * samples_per_frame < sample_count <= size * samples_per_frame:
        raise AnnotationControlError(
            out_of_range_error("sample_count", sample_count, (size - 1) * samples_per_frame + 1, size * samples_per_frame, "samples")
        )
    references, missing_references = prepare_reference_trajectories(
        payload.get("reference_spans"), sample_count, samples_per_frame, size,
    )
    reference_covered_200 = np.zeros(size, dtype=bool)
    for ref in references:
        reference_covered_200[ref.frames] |= ref.weights > 0
    spans = payload["articulation_spans"]
    protected_weights = np.zeros(size)
    protected_ipa = set()
    pose_source = payload.get("pose_source")
    use_custom_pose = pose_source in ("custom", "stored")
    has_pose_targets = any(isinstance(span, dict) and "pose_target_19" in span for span in spans)
    articulation_targets: List[ArticulatorTarget] = []
    lateral_frames = np.zeros(size, dtype=bool)
    secondary_runs: List[Dict[str, Any]] = []
    short_phase_targets = {}
    recorded_phases = {}
    bell_overlays: List[Tuple[int, int, float, Dict[str, Dict[int, float]], int]] = []
    trill_spans: List[Tuple[float, float, str]] = []

    def _span_is_silent(idx_s: int) -> bool:
        if idx_s < 0 or idx_s >= len(spans):
            return True
        sp_s = spans[idx_s]
        return sp_s.get("phase") == "silence" or str(sp_s.get("ipa", "")) == "sil"

    def _span_is_nasal(idx_s: int) -> bool:
        if idx_s < 0 or idx_s >= len(spans) or _span_is_silent(idx_s):
            return False
        sym_s = str(spans[idx_s].get("ipa", ""))
        if "\u0303" in sym_s:
            return True
        feat_s, ok_s = ipa_to_phon_features_checked(sym_s)
        return bool(ok_s and feat_s[2] >= 0.5 and feat_s[13] >= 0.5)

    def predict_area(tract):
        if not LOCAL_MODEL_MANAGER.is_enabled("Tract2Area-Proxy"):
            arr_t = np.asarray(tract, dtype=np.float32)
            return np.full(arr_t.shape[:-1] + (6,), 0.5, dtype=np.float32)
        with _INFER_LOCK:
            return predict_tract_area_cm2(tract)

    for span_idx, span in enumerate(spans):
        a, b = span["start_frame"], span["end_frame"]
        if type(a) is not int or type(b) is not int or not 0 <= a <= b <= size:
            raise ValueError("音素帧区间须有序且不能重叠")
        start = span.get("start_sample", a * samples_per_frame)
        end = span.get("end_sample", min(b * samples_per_frame, sample_count))
        if type(start) is not int or type(end) is not int or not previous_sample <= start < end <= sample_count:
            raise ValueError("音素采样区间须有序且不能重叠")
        previous_sample = end
        symbol = str(span["ipa"])
        role = span.get("phase", "normal")
        if role not in ("normal", "silence", "closure", "release", "aspiration", "nasal_release", "lateral_release"):
            raise ValueError("无法识别音素相位")
        voice_locked = bool(span.get("phonation_locked"))
        pressure_locked = bool(span.get("pressure_locked"))
        pose_locked = bool(span.get("locked"))
        silent = role == "silence" or symbol == "sil"
        pose_protected = span.get("pose_protected") is True and not silent
        if pose_protected and a < b:
            bounds = span.get("protected_phone", {"start_smp": start, "end_smp": end})
            if not isinstance(bounds, dict):
                raise ValueError("保护构型需要完整音段的采样区间")
            phone_start, phone_end = bounds.get("start_smp"), bounds.get("end_smp")
            release = bounds.get("release_smp")
            if (type(phone_start) is not int or type(phone_end) is not int
                    or not phone_start <= start < end <= phone_end
                    or phone_end - phone_start > 60 * 48000
                    or (release is not None and (type(release) is not int or not phone_start < release < phone_end))):
                raise ValueError("保护构型的音段或释放位置无效")
            weights = protection_weights(phone_start, phone_end, slice(a, b), samples_per_frame, release)
            if np.any(weights):
                protected_weights[a:b] = weights
                protected_ipa.add(symbol)

        tgt_raw = span.get("target_params")
        dlt_raw = span.get("pose_delta") if span.get("pose_delta") is not None else span.get("pose_deltas")
        has_bell_edit = (tgt_raw is not None) or (dlt_raw is not None)
        if has_bell_edit:
            u_raw = span.get("target_u", 0.5)
            err = validate_scalar_range(f"articulation_spans[{span_idx}].target_u", u_raw, 0.0, 1.0, "ratio")
            if err:
                raise AnnotationControlError(err)
            parsed_edit, err = validate_pose_target_or_delta(
                tgt_raw, dlt_raw, field_prefix=f"articulation_spans[{span_idx}]",
            )
            if err:
                raise AnnotationControlError(err)
            assert parsed_edit is not None
            if a < b:
                bell_overlays.append((a, b, float(u_raw), parsed_edit, span_idx))

        seg = SegmentEvent(
            start / 48000.0,
            end / 48000.0,
            "sil" if silent else symbol,
            is_sil=silent,
            is_closure=role in ("closure", "nasal_release", "lateral_release"),
            is_release=role in ("release", "aspiration", "nasal_release", "lateral_release"),
            is_aspiration=role == "aspiration" or (role == "release" and "ʰ" in symbol),
            is_voiced=not silent and bool(span.get("voiced", True)),
            phonation_pinned=voice_locked,
        )
        trill_place = None if (silent or seg.is_aspiration or role == "closure") else resolve_trill_place(span.get("trill") or symbol)
        if trill_place is not None and end > start:
            trill_spans.append((seg.start_sec, seg.end_sec, trill_place))

        mid = min(size - 1, (start + end) // (2 * samples_per_frame))
        kf_role = "silence" if silent else role
        kf_phonation = "silence" if silent else ("auto" if not voice_locked else "modal")
        spec = KeyframeSpec(
            ipa="sil" if silent else symbol,
            duration_ms=max(20.0, (end - start) / 48.0),
            f0_hz=float(np.clip(raw[mid, 17], 45.0, 580.0)),
            phonation=kf_phonation,
            role=kf_role,
        )
        resolved = bank.resolve_keyframe(spec)
        kf26_target = resolved["kf26_norm"].copy()
        w26_mask = resolved["w_mask_26"].copy()

        # Explicit local edits take precedence over the selected set and preserve their original blend.
        authored_mid = np.delete(normalized[mid], 17)
        if pose_locked and not has_bell_edit:
            kf26_target[:17] = authored_mid[:17]
            w26_mask[:17] = 1.0
        active_diacs = set() if silent else _active_articulatory_diacritics(symbol)
        features, matched = ipa_to_phon_features_checked(symbol) if not silent else (np.zeros(22, dtype=np.float32), False)
        prev_lateral_hold = (
            span_idx > 0
            and str(spans[span_idx - 1].get("ipa", "")) == symbol
            and spans[span_idx - 1].get("lateral_ending") == "hold"
        )
        pin_lateral_raw = (
            role == "normal" and matched and features[14] >= 0.5 and features[15] >= 0.5
            and not pose_locked and not has_bell_edit
            and (
                span.get("lateral_ending") == "hold"
                or (span.get("lateral_ending") == "release" and prev_lateral_hold)
            )
        )
        if pin_lateral_raw:
            lateral_frames[a:b] = True
        sec_dims = _secondary_diacritic_dims(active_diacs, features) if matched else ()
        prev_silent = _span_is_silent(span_idx - 1)
        next_silent = _span_is_silent(span_idx + 1)
        same_prev = (span_idx > 0) and (str(spans[span_idx - 1].get("ipa", "")) == symbol)
        same_next = (span_idx + 1 < len(spans)) and (str(spans[span_idx + 1].get("ipa", "")) == symbol)

        if use_custom_pose and not silent and not pose_locked and not has_bell_edit:
            selected = None
            if "pose_target_19" in span:
                target_arr, err = validate_tract19_frames(
                    [span["pose_target_19"]], TRACT19_JD2_NAMES, TRACT19_JD2_MIN, TRACT19_JD2_MAX,
                    field=f"articulation_spans[{span_idx}].pose_target_19", expected_len=1,
                )
                if err:
                    raise AnnotationControlError(err)
                assert target_arr is not None
                selected = normalize_tract(target_arr[0, indices])
                # Legacy stored poses do not carry an explicit source selection.
                if pose_source == "stored" and any(
                    np.allclose(selected, bank.raw_lookup_kf26(symbol, closed)[:17], atol=2e-5)
                    for closed in (False, True)
                ):
                    selected = None
            elif not has_pose_targets:
                selected = authored_mid[:17]

            if selected is not None and role in ("normal", "closure", "release", "aspiration"):
                if matched and active_diacs:
                    selected = _guard_diacritic_rounding_norm(selected, active_diacs, features, role)
                zone = constriction_zone(features) if matched else None
                is_fricative = matched and features[11] >= 0.5
                is_affricate = matched and features[12] >= 0.5
                is_nasal_consonant = matched and features[2] >= 0.5 and features[13] >= 0.5
                is_lateral_consonant = matched and features[14] >= 0.5 and features[15] >= 0.5
                is_primary_labial = matched and (features[3] >= 0.8 or features[4] >= 0.5)
                primary = w26_mask[:17] >= 0.65
                # Stop and affricate static poses provide a place of articulation. Their
                # recorded closure/release targets supply the change in constriction.
                phase_target = selected.copy()
                if is_nasal_consonant and role == "normal" and not active_diacs:
                    # Static nasal presets often carry over-tight oral closures (e.g. n TTY > t/d, m LD = -0.55)
                    # that trigger plosive/flap bursts in Tract2Vox-Lite and VTL. Blend gently with the
                    # model's in-distribution nasal pose while keeping the velic port generously open.
                    native_nasal = kf26_target[:17].copy()
                    phase_target = 0.25 * selected + 0.75 * native_nasal
                    phase_target[7] = max(float(selected[7]), float(native_nasal[7]))
                    phase_target[6] = 0.5 * float(selected[6]) + 0.5 * float(native_nasal[6])
                elif is_lateral_consonant and role == "normal" and not active_diacs and not pin_lateral_raw:
                    # Keep onset laterals smooth and coarticulated instead of slamming TTY to extreme peaks
                    # that sound like an alveolar tap/flap [ɾ] in connected speech.
                    native_lat = kf26_target[:17].copy()
                    phase_target = 0.30 * selected + 0.70 * native_lat
                if role in ("closure", "release", "aspiration"):
                    key = (symbol, zone)
                    if key not in recorded_phases:
                        recorded_phases[key] = recorded_stop_poses(symbol, zone, predict_area)
                    pair = recorded_phases[key]
                    native_target = pair[0 if role == "closure" else 1] if pair else kf26_target[:17]
                    phase_target = 0.35 * selected + 0.65 * native_target
                    # Preserve secondary diacritic organs (e.g. LP & non-labial LD on tʷ/kʷ, LP on pʷ)
                    # instead of averaging them down against plain unrounded stop recordings!
                    for d_sec in sec_dims:
                        phase_target[d_sec] = selected[d_sec]
                    if role in ("release", "aspiration") and is_primary_labial and "ʷ" in active_diacs:
                        # Labialized bilabial stop release (pʷ:r): keep lips open while protruding LP
                        ld_open_norm = float(normalize_tract(
                            np.where(np.arange(17) == 5, 0.24, M27_MIN_PA[:17])
                        )[5])
                        phase_target[5] = max(float(native_target[5]), ld_open_norm)
                    if role == "closure" and zone is not None:
                        candidates = np.stack((phase_target, selected, native_target, kf26_target[:17]))
                        # Ensure candidate closure evaluation respects secondary diacritic targets too
                        for d_sec in sec_dims:
                            candidates[:, d_sec] = selected[d_sec]
                        areas = predict_area(np.where(primary, candidates, kf26_target[:17]))[:, zone]
                        if areas[0] > max(0.04, float(areas.min()) + 0.018):
                            # Restore the narrower primary gesture, leaving other organs coarticulated.
                            phase_target = candidates[int(np.argmin(areas))].copy()
                kf26_target[:17] = np.where(primary, phase_target, kf26_target[:17])
                weights = np.where(primary, np.maximum(0.85, w26_mask[:17]), 0.0)
                w26_mask[:17] = np.maximum(w26_mask[:17], weights)
                if a < b and primary.any() and not np.any(reference_covered_200[a:b]):
                    narrow_zone = zone if role == "closure" or (
                        role == "normal" and is_fricative
                    ) or (role == "release" and is_affricate) else None
                    target_weights = weights.copy()
                    if is_nasal_consonant and role == "normal" and not active_diacs:
                        # Let IPA2Tract-Lite drive smooth nasal oral transitions; pin VO cleanly without harsh release cliffs.
                        oral_mask = (np.arange(17) != 6) & (np.arange(17) != 7)
                        target_weights = np.where(oral_mask, target_weights * 0.35, target_weights)
                    elif is_lateral_consonant and role == "normal" and not active_diacs and not pin_lateral_raw:
                        # Keep onset lateral tongue-tip motion smooth so connected-speech [l] never snaps like a flap.
                        tip_mask = (np.arange(17) == 10) | (np.arange(17) == 11) | (np.arange(17) == 12) | (np.arange(17) == 13)
                        target_weights = np.where(tip_mask, target_weights * 0.40, target_weights)
                    elif (
                        not is_nasal_consonant
                        and "\u0303" not in active_diacs
                        and (_span_is_nasal(span_idx - 1) or _span_is_nasal(span_idx + 1))
                    ):
                        # Preserve anticipatory/carryover velic coarticulation on segments adjacent to nasals
                        # so the velum never slams shut before oral release (which creates an epenthetic stop).
                        target_weights[6] = 0.0
                        target_weights[7] = 0.0
                    # Split continuous secondary-diacritic gestures across multi-phase stops (closure->release)
                    # so rounding/palatalization NEVER drops to 0 at the closure->release boundary!
                    if sec_dims and role in ("closure", "release", "aspiration") and (same_prev or same_next):
                        prim_weights = target_weights.copy()
                        sec_weights = np.zeros(17, dtype=np.float64)
                        for d_sec in sec_dims:
                            sec_weights[d_sec] = max(0.92, float(target_weights[d_sec]))
                            prim_weights[d_sec] = 0.0
                        if prim_weights.any():
                            articulation_targets.append(ArticulatorTarget(
                                a, b, phase_target.copy(), prim_weights, narrow_zone,
                                hold_left=prev_silent,
                                hold_right=next_silent,
                                ramp_left=1 if same_prev else 4,
                                ramp_right=1 if same_next else 4,
                                trapezoid=True,
                            ))
                        if secondary_runs and secondary_runs[-1]["symbol"] == symbol and secondary_runs[-1]["end"] == a:
                            secondary_runs[-1]["end"] = b
                            secondary_runs[-1]["hold_right"] = next_silent
                        else:
                            secondary_runs.append({
                                "symbol": symbol,
                                "start": a,
                                "end": b,
                                "pose": phase_target.copy(),
                                "weights": sec_weights,
                                "hold_left": prev_silent,
                                "hold_right": next_silent,
                            })
                    elif target_weights.any():
                        articulation_targets.append(ArticulatorTarget(
                            a, b, phase_target.copy(), target_weights, narrow_zone,
                            hold_left=prev_silent if active_diacs else False,
                            hold_right=next_silent if active_diacs else False,
                        ))
        elif (
            not use_custom_pose and not silent and not pose_locked and not has_bell_edit
            and matched and active_diacs and role in ("normal", "closure", "release", "aspiration")
            and a < b and not np.any(reference_covered_200[a:b])
        ):
            # Model-mode spans with explicit articulatory diacritics (e.g. a̹, i̹, tʷ):
            # anchor diacritic-modified organs cleanly so IPA2Tract-Lite never drifts into trailing [u] offglides.
            primary = w26_mask[:17] >= 0.65
            if primary.any():
                weights = np.where(primary, np.maximum(0.85, w26_mask[:17]), 0.0)
                if sec_dims and role in ("closure", "release", "aspiration") and (same_prev or same_next):
                    sec_weights = np.zeros(17, dtype=np.float64)
                    for d_sec in sec_dims:
                        sec_weights[d_sec] = max(0.92, float(weights[d_sec]))
                    if secondary_runs and secondary_runs[-1]["symbol"] == symbol and secondary_runs[-1]["end"] == a:
                        secondary_runs[-1]["end"] = b
                        secondary_runs[-1]["hold_right"] = next_silent
                    else:
                        secondary_runs.append({
                            "symbol": symbol,
                            "start": a,
                            "end": b,
                            "pose": kf26_target[:17].copy(),
                            "weights": sec_weights,
                            "hold_left": prev_silent,
                            "hold_right": next_silent,
                        })
                else:
                    articulation_targets.append(ArticulatorTarget(
                        a, b, kf26_target[:17].copy(), weights, None,
                        hold_left=prev_silent,
                        hold_right=next_silent,
                    ))
        if pressure_locked:
            kf26_target[17] = authored_mid[17]
            w26_mask[17] = 1.0
        if voice_locked:
            kf26_target[18:] = authored_mid[18:]
            w26_mask[18:] = 1.0

        targets[id(seg)] = kf26_target
        masks[id(seg)] = w26_mask
        segments.append(seg)
        roles.append(role)
        if a == b:
            if role in STOP_PHASES:
                short_phase_targets[span_idx] = (
                    kf26_target[:17].copy(),
                    np.where(w26_mask[:17] >= 0.65, w26_mask[:17], 0.0),
                )
            continue
        if silent:
            silence_mask_200[a:b] = True
        if pose_locked and not pose_protected and not has_bell_edit:
            dist = np.minimum(np.arange(b - a) + 1, np.arange(b - a, 0, -1))
            locks[a:b, :17] = np.sin(np.minimum(1, dist / min(4, (b - a + 1) // 2)) * np.pi / 2)[:, None] ** 2
        if pressure_locked:
            locks[a:b, 18] = 1.0
        if voice_locked:
            locks[a:b, 19:] = 1.0

    for run in secondary_runs:
        articulation_targets.append(ArticulatorTarget(
            run["start"], run["end"], run["pose"], run["weights"], None,
            hold_left=run["hold_left"],
            hold_right=run["hold_right"],
            ramp_left=2,
            ramp_right=2,
            trapezoid=True,
        ))

    def mask_override(seg: SegmentEvent, _default: np.ndarray) -> np.ndarray:
        return masks[id(seg)].copy()

    for name in ("phonation_locks", "pressure_locks"):
        if name not in payload:
            continue
        rows = np.asarray(payload[name])
        if rows.shape != (size,) or rows.dtype != np.bool_:
            raise ValueError("声门和气压锁定须逐帧提供布尔值")
        feathered = _feather_boolean_locks(rows)
        if name == "phonation_locks":
            locks[:, 19:] = np.maximum(locks[:, 19:], feathered[:, None])
        else:
            locks[:, 18] = np.maximum(locks[:, 18], feathered)

    centers = np.arange((size + 3) // 4) * 4 + 2
    sample = np.minimum(centers, size - 1)
    f0 = normalized[sample, 17]
    cond, base, _, _ = build_condition_from_segments(
        segments, len(f0), f0, lambda seg: targets[id(seg)], mask_override=mask_override,
    )
    with _INFER_LOCK:
        output_26 = predict_ipa2tract(
            cond,
            base,
            alpha=1.0,
            articulation_spans=payload.get("articulation_spans") if isinstance(payload.get("articulation_spans"), list) else None,
            step_hz=int(hz),
        )
    generated = denormalize_m27(kf26_and_f0_to_m27(output_26, f0))
    generated = _enforce_release_modes_50hz(generated, segments, roles, centers / hz)

    leading_sil_sec = 0.0
    for seg in segments:
        if seg.is_sil:
            leading_sil_sec += seg.duration
        else:
            break

    rows_50 = _apply_locks(generated, raw[sample], locks[sample])
    rows_50[:, 17] = raw[sample, 17]
    zero_pr_50 = silence_mask_200[sample] | (raw[sample, 18] == 0)
    rows_50[zero_pr_50, 18] = 0.0

    if payload.get("synth_mode", "physical") == "physical":
        rows_200 = qta_filter_m27_50_to_200(generated)[:size]
    else:
        rows_200 = np.column_stack([np.interp(np.arange(size), centers, col) for col in generated.T])
    rows_200 = _apply_unreleased_zero_pressure_200hz(
        _apply_soft_onset_200hz(rows_200, leading_sil_sec), segments, roles,
    )
    rows_200 = _apply_locks(rows_200, raw, locks)
    apply_articulator_targets(rows_200, articulation_targets, raised_cosine_bell, predict_area)
    for target in articulation_targets:
        frame_mask = (sample >= target.start) & (sample < target.end)
        rows_50[frame_mask, :17] = rows_200[sample[frame_mask], :17]
    lateral_50 = lateral_frames[sample]
    if np.any(lateral_frames):
        # Preserve the planned oral hold or release after the model predicts coarticulation.
        rows_200[np.ix_(lateral_frames, _LATERAL_TRACT_COLS)] = raw[np.ix_(lateral_frames, _LATERAL_TRACT_COLS)]
        rows_50[np.ix_(lateral_50, _LATERAL_TRACT_COLS)] = rows_200[np.ix_(sample[lateral_50], _LATERAL_TRACT_COLS)]
    zero_pr_200 = silence_mask_200 | (raw[:, 18] == 0)
    rows_200[zero_pr_200, 18] = 0.0

    # T-21: Raised-cosine bell window superposition on 200 Hz & 50 Hz trajectories
    transient_locks = locks[sample] > 0
    transient_locks[np.ix_(lateral_50, _LATERAL_TRACT_COLS)] = True
    if bell_overlays:
        from kf_ipa_synth.m27_contract import M27_MAX, M27_MIN

        delta_full_200 = np.zeros_like(rows_200)
        for a, b, u0, parsed_edit, span_idx in bell_overlays:
            bell = raised_cosine_bell(b - a, u0)
            peak_abs = a + int(np.argmax(bell))
            inside = (sample >= a) & (sample < b)
            for col in parsed_edit["m27_target"].keys() | parsed_edit["m27_delta"].keys():
                transient_locks[inside, col] = True
            delta27 = np.zeros(27, dtype=np.float64)
            for m_col, val_pa in parsed_edit["m27_target"].items():
                native_val = val_pa * 10.0 if m_col == 18 else val_pa
                delta27[m_col] = native_val - float(rows_200[peak_abs, m_col])
            for m_col, dval_pa in parsed_edit["m27_delta"].items():
                native_d = dval_pa * 10.0 if m_col == 18 else dval_pa
                delta27[m_col] += native_d
                peak_native = float(rows_200[peak_abs, m_col]) + delta27[m_col]
                peak_ui = peak_native / 10.0 if m_col == 18 else peak_native
                lo_ui = 60.0 if m_col == 17 else float(M27_MIN_PA[m_col])
                hi_ui = float(M27_MAX_PA[m_col])
                if peak_ui < lo_ui - CONTROL_TOL or peak_ui > hi_ui + CONTROL_TOL:
                    raise AnnotationControlError(
                        out_of_range_error(
                            f"articulation_spans[{span_idx}].pose_delta[{M27_PARAM_NAMES[m_col]}]",
                            round(peak_ui, 5),
                            lo_ui,
                            hi_ui,
                            M27_UNITS[m_col],
                            f"微调峰值帧 {M27_PARAM_NAMES[m_col]} ({peak_ui:.4f}) 超出合法范围 [{lo_ui}, {hi_ui}]",
                        )
                    )
            delta_full_200[a:b] += bell[:, None] * delta27[None, :]
        rows_200 = np.clip(rows_200 + delta_full_200, M27_MIN.astype(np.float64), M27_MAX.astype(np.float64))
        rows_50 = np.clip(rows_50 + delta_full_200[sample], M27_MIN.astype(np.float64), M27_MAX.astype(np.float64))
        rows_200[zero_pr_200, 18] = 0.0
        rows_50[zero_pr_50, 18] = 0.0

    preserve_stop_transients(
        rows_50, rows_200, spans, 4, zero_pr_50, locks_50=transient_locks,
        short_targets=short_phase_targets, step_samples=samples_per_frame,
    )

    if protected_ipa:
        rows_200[:, :17] = _apply_locks(rows_200[:, :17], tract_arr[:, indices], protected_weights[:, None])
        prot_50 = protected_weights[sample] > 0
        if np.any(prot_50):
            rows_50[prot_50, :17] = rows_200[sample[prot_50], :17]
    # T-22: Physiological trill modulation on 200 Hz physical & 50 Hz neural control tracks
    if trill_spans:
        rows_200 = apply_trill_to_m27(rows_200, trill_spans, float(hz), modulate_aerodynamics_50hz=False)
        rows_50 = apply_trill_to_m27(rows_50, trill_spans, 50.0, modulate_aerodynamics_50hz=True)
        rows_200[zero_pr_200, 18] = 0.0
        rows_50[zero_pr_50, 18] = 0.0

    if references:
        apply_reference_trajectories(
            rows_200, references, (locks[:, 18] > 0) | zero_pr_200, locks[:, 19] > 0,
            silence_mask_200 | (protected_weights > 0),
        )
        ref_50 = reference_covered_200[sample] & ~(silence_mask_200[sample] | (protected_weights[sample] > 0))
        if np.any(ref_50):
            rows_50[ref_50, :17] = rows_200[sample[ref_50], :17]
            rows_50[ref_50, 18] = rows_200[sample[ref_50], 18]
            rows_50[ref_50, 19:] = rows_200[sample[ref_50], 19:]
            rows_50[zero_pr_50, 18] = 0.0

    result = tract_arr.copy()
    result[:, indices] = rows_200[:, :17]
    for a, b, u0, parsed_edit, _ in bell_overlays:
        if 14 in parsed_edit["t19_target"] or 15 in parsed_edit["t19_target"] or 14 in parsed_edit["t19_delta"] or 15 in parsed_edit["t19_delta"]:
            bell = raised_cosine_bell(b - a, u0)
            peak_abs = a + int(np.argmax(bell))
            for r_col in (14, 15):
                d_root = 0.0
                if r_col in parsed_edit["t19_target"]:
                    d_root = parsed_edit["t19_target"][r_col] - float(result[peak_abs, r_col])
                if r_col in parsed_edit["t19_delta"]:
                    d_root += parsed_edit["t19_delta"][r_col]
                result[a:b, r_col] = np.clip(result[a:b, r_col] + bell * d_root, TRACT19_JD2_MIN[r_col], TRACT19_JD2_MAX[r_col])

    result_payload = {
        **payload,
        "tract_frames": result.tolist(),
        "f0_hz": f0_arr.tolist() if references or protected_ipa else rows_200[:, 17].tolist(),
        "pressure_pa": (rows_200[:, 18] / 10.0).tolist(),
        "glottis_frames": rows_200[:, 19:].tolist(),
        "bell_modulated": bool(bell_overlays),
        "trill_modulated": bool(trill_spans or references),
        **({"trill_spans": [[s, e, pl] for s, e, pl in trill_spans]} if trill_spans else {}),
    }
    return result_payload, rows_50, {
        **({"protected_ipa_poses": sorted(protected_ipa)} if protected_ipa else {}),
        **({"recorded_articulation": [reference.info for reference in references]} if references else {}),
        **({"missing_recorded_articulation": missing_references} if missing_references else {}),
        "articulation_model": "IPA2Tract-Lite",
        "articulation_device": "cpu",
        "articulation_frames_50hz": len(rows_50),
        "articulation_model_dims": 26,
        "articulation_ms": round((time.perf_counter() - started) * 1000),
    }
