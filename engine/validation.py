"""Centralized boundary validation and safe decoding for the VoxFigura Python engine.

Enforces the zero-silent-clamping rule across every M27 / VTL / glottis / scalar
entry point, returning standard `{ok: False, error: {code: 'out_of_range' | ...}}`
contracts before any normalization or native VTL call.
"""
from __future__ import annotations

import base64
import binascii
import math
from typing import Any, Dict, Optional, Sequence, Tuple

import numpy as np

SAMPLE_RATE_HZ = 48000
CONTROL_TOL = 1e-6

M27_PARAM_NAMES: Tuple[str, ...] = (
    "HX", "HY", "JX", "JA", "LP", "LD", "VS", "VO",
    "TCX", "TCY", "TTX", "TTY", "TBX", "TBY", "TS1", "TS2", "TS3",
    "F0", "PR",
    "XB", "XT", "CA", "LAG", "RA", "PS", "FL", "SHIM",
)

# Canonical physical units with PR in Pascals (Pa, 0..1600) and F0 in Hz.
M27_MIN_PA = np.array(
    [
        0.0, -6.0, -0.5, -7.0, -1.0, -2.0, 0.0, -0.1,
        -3.0, -3.0, 1.5, -3.0, -3.0, -3.0, 0.0, 0.0, -1.0,
        40.0, 0.0,
        -0.05, -0.05, -0.25, 0.0, -1.0, -1.0, 0.0, 0.0,
    ],
    dtype=np.float64,
)

M27_MAX_PA = np.array(
    [
        1.0, -3.5, 0.0, 0.0, 1.0, 4.0, 1.0, 1.5,
        4.0, 1.0, 7.5, 2.5, 6.5, 5.0, 1.0, 1.0, 1.0,
        600.0, 1600.0,
        0.30, 0.30, 0.25, 3.1415, 1.0, 1.0, 100.0, 100.0,
    ],
    dtype=np.float64,
)

M27_UNITS: Tuple[str, ...] = (
    "ratio", "cm", "cm", "deg", "ratio", "cm", "ratio", "ratio",
    "cm", "cm", "cm", "cm", "cm", "cm", "ratio", "ratio", "ratio",
    "Hz", "Pa",
    "cm", "cm", "cm2", "rad", "ratio", "ratio", "%", "%",
)

TRACT19_JD2_NAMES: Tuple[str, ...] = (
    "HX", "HY", "JX", "JA", "LP", "LD", "VS", "VO",
    "TCX", "TCY", "TTX", "TTY", "TBX", "TBY", "TRX", "TRY",
    "TS1", "TS2", "TS3",
)
TRACT19_JD2_MIN = np.array(
    [0.0, -6.0, -0.5, -7.0, -1.0, -2.0, 0.0, -0.1, -3.0, -3.0, 1.5, -3.0, -3.0, -3.0, -4.0, -6.0, 0.0, 0.0, -1.0],
    dtype=np.float64,
)
TRACT19_JD2_MAX = np.array(
    [1.0, -3.5, 0.0, 0.0, 1.0, 4.0, 1.0, 1.5, 4.0, 1.0, 7.5, 2.5, 6.5, 5.0, 2.0, 0.0, 1.0, 1.0, 1.0],
    dtype=np.float64,
)

GLOTTIS8_NAMES: Tuple[str, ...] = ("xb_cm", "xt_cm", "ca_cm2", "lag_rad", "ra", "ps", "fl", "shim")
GLOTTIS8_MIN = np.array([-0.05, -0.05, -0.25, 0.0, -1.0, -1.0, 0.0, 0.0], dtype=np.float64)
GLOTTIS8_MAX = np.array([0.30, 0.30, 0.25, 3.1415, 1.0, 1.0, 100.0, 100.0], dtype=np.float64)
GLOTTIS8_UNITS: Tuple[str, ...] = ("cm", "cm", "cm2", "rad", "ratio", "ratio", "%", "%")


def _safe_value_repr(value: Any) -> str:
    """Format an invalid/non-finite/overflowing numeric value safely for error responses."""
    try:
        text = str(value) if isinstance(value, (int, float, np.number)) else repr(value)
    except Exception:
        return "<unrepresentable>"
    if len(text) > 48:
        return text[:24] + "..." + text[-12:]
    return text


def is_finite_number(value: Any) -> bool:
    """Return True for numeric non-bool finite values (catching OverflowError on huge ints)."""
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, float, np.number)):
        return False
    try:
        return math.isfinite(float(value))
    except (OverflowError, TypeError, ValueError):
        return False


def validation_error(field: str, hint: str, code: str = "validation_error") -> Dict[str, Any]:
    return {"ok": False, "error": {"code": code, "field": field, "hint": hint}}


def out_of_range_error(
    field: str,
    value: Any,
    lo: float,
    hi: float,
    unit: str,
    hint: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "ok": False,
        "error": {
            "code": "out_of_range",
            "field": field,
            "value": value,
            "allowed": {"min": lo, "max": hi, "unit": unit},
            "hint": hint or f"{field} ({value} {unit}) 超出合法范围 [{lo}, {hi}] {unit}",
        },
    }


def positive_scalar_error(
    field: str,
    value: Any,
    unit: str = "Hz",
    hint: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "ok": False,
        "error": {
            "code": "out_of_range",
            "field": field,
            "value": value,
            "allowed": {"min": 0.0, "exclusiveMin": True, "unit": unit},
            "hint": hint or f"{field} ({value} {unit}) 须为有限正数 (> 0 {unit})",
        },
    }


def validate_positive_scalar(
    field: str,
    value: Any,
    unit: str = "Hz",
    hint: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    if not is_finite_number(value):
        return positive_scalar_error(field, _safe_value_repr(value), unit, hint)
    num = float(value)
    if num <= 0.0:
        return positive_scalar_error(field, num, unit, hint)
    return None


def validate_positive_series(
    field: str,
    values: Any,
    expected_len: int,
    unit: str = "Hz",
) -> Tuple[Optional[np.ndarray], Optional[Dict[str, Any]]]:
    if not isinstance(values, (list, tuple, np.ndarray)):
        return None, validation_error(field, f"{field} 必须为长度为 {expected_len} 的数值数组")
    if isinstance(values, np.ndarray) and values.ndim != 1:
        return None, validation_error(field, f"{field} 必须为一维数组")
    if len(values) != expected_len:
        return None, validation_error(field, f"{field} 长度 ({len(values)}) 与主控制轨 ({expected_len}) 不一致")
    for idx, val in enumerate(values):
        if not is_finite_number(val):
            return None, positive_scalar_error(f"{field}[{idx}]", _safe_value_repr(val), unit)
        num = float(val)
        if num <= 0.0:
            return None, positive_scalar_error(f"{field}[{idx}]", num, unit)
    return np.asarray(values, dtype=np.float64), None


def validate_scalar_range(
    field: str,
    value: Any,
    lo: float,
    hi: float,
    unit: str,
    *,
    tol: float = CONTROL_TOL,
) -> Optional[Dict[str, Any]]:
    if not is_finite_number(value):
        return out_of_range_error(field, _safe_value_repr(value), lo, hi, unit)
    num = float(value)
    if num < lo - tol or num > hi + tol:
        return out_of_range_error(field, num, lo, hi, unit)
    return None


def validate_scalar_series(
    field: str,
    values: Any,
    expected_len: int,
    lo: float,
    hi: float,
    unit: str,
    *,
    tol: float = CONTROL_TOL,
) -> Tuple[Optional[np.ndarray], Optional[Dict[str, Any]]]:
    if not isinstance(values, (list, tuple, np.ndarray)):
        return None, validation_error(field, f"{field} 必须为长度为 {expected_len} 的数值数组")
    if isinstance(values, np.ndarray) and values.ndim != 1:
        return None, validation_error(field, f"{field} 必须为一维数组")
    if len(values) != expected_len:
        return None, validation_error(field, f"{field} 长度 ({len(values)}) 与主控制轨 ({expected_len}) 不一致")
    for idx, val in enumerate(values):
        if not is_finite_number(val):
            return None, out_of_range_error(f"{field}[{idx}]", _safe_value_repr(val), lo, hi, unit)
        num = float(val)
        if num < lo - tol or num > hi + tol:
            return None, out_of_range_error(f"{field}[{idx}]", num, lo, hi, unit)
    arr = np.asarray(values, dtype=np.float64)
    return np.clip(arr, lo, hi), None


def validate_tract19_frames(
    frames: Any,
    names: Sequence[str] = TRACT19_JD2_NAMES,
    mins: Sequence[float] = TRACT19_JD2_MIN,
    maxs: Sequence[float] = TRACT19_JD2_MAX,
    *,
    field: str = "tract_frames",
    expected_len: Optional[int] = None,
    tol: float = CONTROL_TOL,
) -> Tuple[Optional[np.ndarray], Optional[Dict[str, Any]]]:
    if not isinstance(frames, (list, tuple, np.ndarray)) or len(frames) == 0:
        return None, validation_error(field, f"{field} 必须为非空 19 维构型数组")
    if expected_len is not None and len(frames) != expected_len:
        return None, validation_error(field, f"{field} 帧数 ({len(frames)}) 与控制轨长度 ({expected_len}) 不一致")
    mins_f = [float(x) for x in mins]
    maxs_f = [float(x) for x in maxs]
    for r_idx, row in enumerate(frames):
        if not isinstance(row, (list, tuple, np.ndarray)) or len(row) != 19:
            return None, validation_error(f"{field}[{r_idx}]", "每帧声道构型必须为 19 维")
        for c_idx, val in enumerate(row):
            name = names[c_idx]
            lo, hi = mins_f[c_idx], maxs_f[c_idx]
            if not is_finite_number(val):
                return None, out_of_range_error(f"{field}[{r_idx}][{name}]", _safe_value_repr(val), lo, hi, "vtl")
            num = float(val)
            if num < lo - tol or num > hi + tol:
                return None, out_of_range_error(f"{field}[{r_idx}][{name}]", num, lo, hi, "vtl")
    arr = np.asarray(frames, dtype=np.float64)
    return np.clip(arr, np.asarray(mins_f, dtype=np.float64), np.asarray(maxs_f, dtype=np.float64)), None


def validate_glottis_frames(
    frames: Any,
    expected_len: int,
    *,
    field: str = "glottis_frames",
    tol: float = CONTROL_TOL,
) -> Tuple[Optional[np.ndarray], Optional[Dict[str, Any]]]:
    """Validate per-frame glottis controls.

    Canonical contract is 8-dim `[xb_cm, xt_cm, ca_cm2, lag_rad, ra, ps, fl, shim]`.
    Legacy 7-dim rows omitting `shim` are accepted for backward compatibility and
    treated by downstream synthesizers (`dense_channel`, `m27_bridge`, `keyframe_lite`)
    as `shim = 0.0`.
    """
    if not isinstance(frames, (list, tuple, np.ndarray)):
        return None, validation_error(field, f"{field} 必须为声门帧数组")
    if len(frames) != expected_len:
        return None, validation_error(field, f"{field} 帧数 ({len(frames)}) 与控制轨长度 ({expected_len}) 不一致")
    cols_len: Optional[int] = None
    for r_idx, row in enumerate(frames):
        if not isinstance(row, (list, tuple, np.ndarray)) or len(row) not in (7, 8):
            return None, validation_error(f"{field}[{r_idx}]", "每帧声门控制须为 8 维（兼容省略 shim 的旧 7 维格式）")
        if cols_len is None:
            cols_len = len(row)
        elif len(row) != cols_len:
            return None, validation_error(f"{field}[{r_idx}]", "各帧声门控制维数必须一致（统一 8 维或兼容 7 维）")
        for c_idx, val in enumerate(row):
            name = GLOTTIS8_NAMES[c_idx]
            lo, hi, unit = float(GLOTTIS8_MIN[c_idx]), float(GLOTTIS8_MAX[c_idx]), GLOTTIS8_UNITS[c_idx]
            if not is_finite_number(val):
                return None, out_of_range_error(f"{field}[{r_idx}][{name}]", _safe_value_repr(val), lo, hi, unit)
            num = float(val)
            if num < lo - tol or num > hi + tol:
                return None, out_of_range_error(f"{field}[{r_idx}][{name}]", num, lo, hi, unit)
    arr = np.asarray(frames, dtype=np.float64)
    k = arr.shape[1]
    return np.clip(arr, GLOTTIS8_MIN[:k], GLOTTIS8_MAX[:k]), None


def validate_m27_pa(
    rows: Any,
    *,
    field: str = "m27_50hz_pa",
    min_frames: int = 1,
    max_frames: int = 3000,
    f0_min: Optional[float] = None,
    f0_max: Optional[float] = None,
    tol: float = CONTROL_TOL,
) -> Tuple[Optional[np.ndarray], Optional[Dict[str, Any]]]:
    """Validate an (T, 27) M27 trajectory in physical units (PR in Pa, F0 in Hz)."""
    if not isinstance(rows, (list, tuple, np.ndarray)):
        return None, validation_error(field, f"缺少非空 27 维轨迹 {field}")
    if isinstance(rows, np.ndarray) and rows.ndim != 2:
        return None, validation_error(field, "轨迹必须为 (T, 27) 二维数组")
    n = len(rows)
    if n < min_frames or n > max_frames:
        return None, out_of_range_error(
            f"{field}.length",
            n,
            min_frames,
            max_frames,
            "frames",
            f"帧数 {n} 超出允许范围 [{min_frames}, {max_frames}]",
        )
    mins = M27_MIN_PA.copy()
    maxs = M27_MAX_PA.copy()
    bounded_f0 = (f0_min is not None) or (f0_max is not None)
    eff_f0_min = float(f0_min) if f0_min is not None else 0.0
    eff_f0_max = float(f0_max) if f0_max is not None else float("inf")
    if bounded_f0:
        mins[17] = eff_f0_min
        maxs[17] = eff_f0_max

    for r_idx, row in enumerate(rows):
        if not isinstance(row, (list, tuple, np.ndarray)) or len(row) != 27:
            return None, validation_error(f"{field}[{r_idx}]", "每帧必须为 27 维数值列表")
        for c_idx, val in enumerate(row):
            unit = M27_UNITS[c_idx]
            name = M27_PARAM_NAMES[c_idx]
            if c_idx == 17 and not bounded_f0:
                if not is_finite_number(val):
                    return None, positive_scalar_error(
                        f"{field}[{r_idx}][{c_idx}]",
                        _safe_value_repr(val),
                        unit,
                        f"第 {r_idx} 帧 {name} 含有非有限数值或无效类型",
                    )
                num = float(val)
                if num <= 0.0:
                    return None, positive_scalar_error(
                        f"{field}[{r_idx}][{c_idx}]",
                        num,
                        unit,
                        f"第 {r_idx} 帧 {name} ({num} {unit}) 须为有限正数 (> 0 {unit})",
                    )
                continue
            lo, hi = float(mins[c_idx]), float(maxs[c_idx])
            if not is_finite_number(val):
                return None, out_of_range_error(f"{field}[{r_idx}][{c_idx}]", _safe_value_repr(val), lo, hi, unit,
                                                f"第 {r_idx} 帧 {name} 含有非有限数值或无效类型")
            num = float(val)
            if num < lo - tol or num > hi + tol:
                return None, out_of_range_error(
                    f"{field}[{r_idx}][{c_idx}]",
                    num,
                    lo,
                    hi,
                    unit,
                    f"第 {r_idx} 帧 {name} ({num} {unit}) 超出合法范围 [{lo}, {hi}] {unit}",
                )
    arr = np.asarray(rows, dtype=np.float64)
    if bounded_f0:
        return np.clip(arr, mins, maxs), None
    f0_col = arr[:, 17].copy()
    clipped = np.clip(arr, mins, maxs)
    clipped[:, 17] = f0_col
    return clipped, None


def validate_shape_frames(
    frames: Any,
    expected_len: int,
    *,
    field: str,
    lo: float = -2.0,
    hi: float = 2.0,
) -> Optional[Dict[str, Any]]:
    """Validate optional 4-dim tongue/lip shape modifiers per frame."""
    if not isinstance(frames, (list, tuple, np.ndarray)) or len(frames) != expected_len:
        return validation_error(field, f"{field} 帧数须与控制轨等长 ({expected_len})")
    for r_idx, row in enumerate(frames):
        if row is None:
            continue
        if not isinstance(row, (list, tuple, np.ndarray)) or len(row) != 4:
            return validation_error(f"{field}[{r_idx}]", f"{field} 每帧须为 4 维向量或 null")
        for c_idx, val in enumerate(row):
            if not is_finite_number(val):
                return out_of_range_error(f"{field}[{r_idx}][{c_idx}]", _safe_value_repr(val), lo, hi, "ratio")
            num = float(val)
            if num < lo - CONTROL_TOL or num > hi + CONTROL_TOL:
                return out_of_range_error(f"{field}[{r_idx}][{c_idx}]", num, lo, hi, "ratio")
    return None


_TRACT19_TO_M27_COL: Dict[int, Optional[int]] = {
    0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7,
    8: 8, 9: 9, 10: 10, 11: 11, 12: 12, 13: 13,
    14: None, 15: None,
    16: 14, 17: 15, 18: 16,
}


def validate_pose_target_or_delta(
    target_params: Any,
    pose_delta: Any,
    *,
    field_prefix: str = "articulation_spans",
    tol: float = CONTROL_TOL,
) -> Tuple[Optional[Dict[str, Dict[int, float]]], Optional[Dict[str, Any]]]:
    """Validate optional segment target_params and/or pose_delta without silent clamping.

    Accepts either a 19-dim JD2 list, a 17-dim M27 tract list, or a parameter-name dict
    (names in ``TRACT19_JD2_NAMES`` or ``M27_PARAM_NAMES``). Returns index maps in both
    M27 physical space (PR in Pa) and 19-dim JD2 space:
      ``{"m27_target": ..., "t19_target": ..., "m27_delta": ..., "t19_delta": ...}``
    """
    t19_idx = {name: i for i, name in enumerate(TRACT19_JD2_NAMES)}
    m27_idx = {name: i for i, name in enumerate(M27_PARAM_NAMES)}
    m27_to_t19 = {m_col: t_col for t_col, m_col in _TRACT19_TO_M27_COL.items() if m_col is not None}

    def _parse_one(
        raw: Any,
        sub_field: str,
        is_delta: bool,
    ) -> Tuple[Optional[Dict[int, float]], Optional[Dict[int, float]], Optional[Dict[str, Any]]]:
        if raw is None:
            return {}, {}, None
        m27_map: Dict[int, float] = {}
        t19_map: Dict[int, float] = {}
        if isinstance(raw, (list, tuple, np.ndarray)):
            if len(raw) == 19:
                for c_i, val in enumerate(raw):
                    name = TRACT19_JD2_NAMES[c_i]
                    span = float(TRACT19_JD2_MAX[c_i] - TRACT19_JD2_MIN[c_i])
                    lo = -span if is_delta else float(TRACT19_JD2_MIN[c_i])
                    hi = span if is_delta else float(TRACT19_JD2_MAX[c_i])
                    if not is_finite_number(val):
                        return None, None, out_of_range_error(f"{sub_field}[{name}]", _safe_value_repr(val), lo, hi, "vtl")
                    num = float(val)
                    if num < lo - tol or num > hi + tol:
                        return None, None, out_of_range_error(f"{sub_field}[{name}]", num, lo, hi, "vtl")
                    num = float(np.clip(num, lo, hi))
                    t19_map[c_i] = num
                    m_col = _TRACT19_TO_M27_COL[c_i]
                    if m_col is not None:
                        m27_map[m_col] = num
                return m27_map, t19_map, None
            if len(raw) == 17:
                for m_col, val in enumerate(raw):
                    name = M27_PARAM_NAMES[m_col]
                    span = float(M27_MAX_PA[m_col] - M27_MIN_PA[m_col])
                    lo = -span if is_delta else float(M27_MIN_PA[m_col])
                    hi = span if is_delta else float(M27_MAX_PA[m_col])
                    unit = M27_UNITS[m_col]
                    if not is_finite_number(val):
                        return None, None, out_of_range_error(f"{sub_field}[{name}]", _safe_value_repr(val), lo, hi, unit)
                    num = float(val)
                    if num < lo - tol or num > hi + tol:
                        return None, None, out_of_range_error(f"{sub_field}[{name}]", num, lo, hi, unit)
                    num = float(np.clip(num, lo, hi))
                    m27_map[m_col] = num
                    t19_map[m27_to_t19[m_col]] = num
                return m27_map, t19_map, None
            return None, None, validation_error(sub_field, f"{sub_field} 数组长度须为 19 维 (JD2) 或 17 维 (M27 声道)")
        if isinstance(raw, dict):
            for key, val in raw.items():
                if not isinstance(key, str):
                    return None, None, validation_error(sub_field, f"{sub_field} 参数键名须为字符串")
                if key in m27_idx:
                    m_col = m27_idx[key]
                    unit = M27_UNITS[m_col]
                    if m_col == 17:
                        if not is_finite_number(val):
                            return None, None, positive_scalar_error(f"{sub_field}.{key}", _safe_value_repr(val), unit)
                        num = float(val)
                        if not is_delta and num <= 0.0:
                            return None, None, positive_scalar_error(f"{sub_field}.{key}", num, unit)
                        m27_map[m_col] = num
                        continue
                    base_lo = float(M27_MIN_PA[m_col])
                    base_hi = float(M27_MAX_PA[m_col])
                    span = base_hi - base_lo
                    lo, hi = (-span, span) if is_delta else (base_lo, base_hi)
                    if not is_finite_number(val):
                        return None, None, out_of_range_error(f"{sub_field}.{key}", _safe_value_repr(val), lo, hi, unit)
                    num = float(val)
                    if num < lo - tol or num > hi + tol:
                        return None, None, out_of_range_error(f"{sub_field}.{key}", num, lo, hi, unit)
                    num = float(np.clip(num, lo, hi))
                    m27_map[m_col] = num
                    if m_col in m27_to_t19:
                        t19_map[m27_to_t19[m_col]] = num
                elif key in t19_idx:
                    t_col = t19_idx[key]
                    span = float(TRACT19_JD2_MAX[t_col] - TRACT19_JD2_MIN[t_col])
                    lo = -span if is_delta else float(TRACT19_JD2_MIN[t_col])
                    hi = span if is_delta else float(TRACT19_JD2_MAX[t_col])
                    if not is_finite_number(val):
                        return None, None, out_of_range_error(f"{sub_field}.{key}", _safe_value_repr(val), lo, hi, "vtl")
                    num = float(val)
                    if num < lo - tol or num > hi + tol:
                        return None, None, out_of_range_error(f"{sub_field}.{key}", num, lo, hi, "vtl")
                    t19_map[t_col] = float(np.clip(num, lo, hi))
                else:
                    return None, None, validation_error(f"{sub_field}.{key}", f"未知的声道或声门参数名: {key}")
            return m27_map, t19_map, None
        return None, None, validation_error(sub_field, f"{sub_field} 须为 19/17 维数组或参数字典")

    m_tgt, t_tgt, err = _parse_one(target_params, f"{field_prefix}.target_params", False)
    if err:
        return None, err
    m_dlt, t_dlt, err = _parse_one(pose_delta, f"{field_prefix}.pose_delta", True)
    if err:
        return None, err
    assert m_tgt is not None and t_tgt is not None and m_dlt is not None and t_dlt is not None
    return {"m27_target": m_tgt, "t19_target": t_tgt, "m27_delta": m_dlt, "t19_delta": t_dlt}, None


def decode_base64_payload(encoded: str, field: str = "wav_base64", *, max_bytes: int = 64 * 1024 * 1024) -> bytes:
    """Safely decode optional data-URI prefixed base64 audio payloads."""
    if not isinstance(encoded, str) or not encoded.strip():
        raise ValueError(f"缺少有效的 {field} 数据")
    payload = encoded.strip()
    if payload.startswith("data:"):
        if "," not in payload:
            raise ValueError(f"{field} data URI 格式无效")
        payload = payload.partition(",")[2]
    if len(payload) > (max_bytes * 4) // 3 + 64:
        raise ValueError(f"{field} 体积超出上限 ({max_bytes // (1024 * 1024)} MiB)")
    try:
        decoded = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"{field} Base64 解码失败") from exc
    if len(decoded) > max_bytes:
        raise ValueError(f"{field} 体积超出上限 ({max_bytes} B)")
    return decoded
