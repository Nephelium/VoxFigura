"""Physiological articulator trill gestures (23-28 Hz) for VTL 2.4 and Tract2Vox-Lite.

Ported from PhoneticToolbox v3 (`phonetic_core.vocal_tract.trills`) and extended with
linguolabial [r̼/r̼̊] and voiceless ring-above [r̊] mappings plus 200 Hz / 50 Hz trajectory helpers.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple
import unicodedata

import numpy as np

from validation import TRACT19_JD2_MAX, TRACT19_JD2_MIN, TRACT19_JD2_NAMES

TRILL_PLACES: Dict[str, str] = {
    "ʙ": "bilabial",
    "ʙ̥": "bilabial",
    "ʙ̊": "bilabial",
    "r̼": "linguolabial",
    "r̼̊": "linguolabial",
    "r̼̥": "linguolabial",
    "r̪": "dental",
    "r̪̊": "dental",
    "r̪̥": "dental",
    "r": "alveolar",
    "r̊": "alveolar",
    "r̥": "alveolar",
    "r̠": "postalveolar",
    "r̠̊": "postalveolar",
    "r̠̥": "postalveolar",
    "ʀ": "uvular",
    "ʀ̥": "uvular",
    "ʀ̊": "uvular",
}

# Rate (Hz), primary control name, opening offset, and closing offset about the JD2 base posture.
# LD and TTY are in cm; VS is normalized velum shape (accompanied by TCY +0.26, TS2 -0.25).
GESTURES: Dict[str, Tuple[float, str, float, float]] = {
    "bilabial": (25.0, "LD", 0.23, -0.20),
    "linguolabial": (28.0, "TTY", -0.38, 0.25),
    "dental": (28.0, "TTY", -0.38, 0.25),
    "alveolar": (27.0, "TTY", -0.40, 0.23),
    "postalveolar": (26.0, "TTY", -0.64, 0.12),
    "uvular": (23.0, "VS", -0.85, 0.0),
}

_STRIP_NON_PLACE = frozenset(
    "\u0325\u030a\u032c\u0324\u0330\u0329\u032f\u0303ʰʷʲˠˤʼːˑˈˌ"
)
_NON_TRILL_MODIFIERS = frozenset("\u0306\u031e")  # extra-short tap (ʀ̆) or lowered approximant


def resolve_trill_place(symbol_or_place: Optional[str]) -> Optional[str]:
    """Resolve an IPA phone string or explicit place name to one of the 6 trill gesture keys."""
    if not symbol_or_place or not isinstance(symbol_or_place, str):
        return None
    raw = symbol_or_place.strip()
    if raw in GESTURES:
        return raw
    nfc = unicodedata.normalize("NFC", raw)
    if nfc in TRILL_PLACES:
        return TRILL_PLACES[nfc]
    nfd = unicodedata.normalize("NFD", raw)
    if any(ch in _NON_TRILL_MODIFIERS for ch in nfd):
        return None
    cleaned = "".join(ch for ch in nfd if ch not in _STRIP_NON_PLACE)
    cleaned_nfc = unicodedata.normalize("NFC", cleaned)
    if cleaned_nfc in TRILL_PLACES:
        return TRILL_PLACES[cleaned_nfc]
    if "ʙ" in nfd:
        return "bilabial"
    if "ʀ" in nfd:
        return "uvular"
    if "r" in nfd:
        if "\u033c" in nfd:
            return "linguolabial"
        if "\u032a" in nfd:
            return "dental"
        if "\u0320" in nfd:
            return "postalveolar"
        return "alveolar"
    return None


def smoothstep_envelope(local_s: float, remaining_s: float, ramp_s: float = 0.010) -> float:
    """10 ms smoothstep onset & release envelope."""
    if ramp_s <= 0.0:
        return 1.0
    u = max(0.0, min(1.0, local_s / ramp_s, remaining_s / ramp_s))
    return u * u * (3.0 - 2.0 * u)


def apply_trill(
    engine: Optional[Any],
    pose: Dict[str, Any],
    spans: Sequence[Tuple[float, float, str]],
    seconds: float,
) -> Dict[str, Any]:
    """Modulate a JD2 pose dictionary in-place-safe at timestamp ``seconds``."""
    if pose.get("silent") or pose.get("aspiration"):
        return pose
    names = list(engine.names) if engine is not None else list(TRACT19_JD2_NAMES)
    minimum = np.asarray(engine.minimum if engine is not None else TRACT19_JD2_MIN, dtype=np.float64)
    maximum = np.asarray(engine.maximum if engine is not None else TRACT19_JD2_MAX, dtype=np.float64)

    for start, end, raw_place in spans:
        place = resolve_trill_place(raw_place)
        if place is not None and start <= seconds < end:
            local = seconds - start
            weight = smoothstep_envelope(local, end - seconds, 0.010)
            rate, control, opened, closed = GESTURES[place]
            closure = 0.5 - 0.5 * math.cos(2.0 * math.pi * rate * local)
            params = list(pose["params"])

            def add(name: str, delta: float) -> None:
                i = names.index(name)
                params[i] = float(max(minimum[i], min(maximum[i], params[i] + weight * delta)))

            if place == "uvular":
                add("TCY", 0.26)
                add("TS2", -0.25)
            add(control, opened + (closed - opened) * closure)
            return {**pose, "params": params}
    return pose


def apply_trill_to_tract19(
    tract19: np.ndarray,
    spans: Sequence[Tuple[float, float, str]],
    step_hz: float,
    *,
    names: Sequence[str] = TRACT19_JD2_NAMES,
    minimum: Sequence[float] = TRACT19_JD2_MIN,
    maximum: Sequence[float] = TRACT19_JD2_MAX,
) -> np.ndarray:
    """Apply physiological trill modulation onto a (T, 19) JD2 trajectory at ``step_hz``."""
    out = np.asarray(tract19, dtype=np.float64).copy()
    if not spans or len(out) == 0:
        return out
    name_idx = {name: i for i, name in enumerate(names)}
    mins = np.asarray(minimum, dtype=np.float64)
    maxs = np.asarray(maximum, dtype=np.float64)
    times = (np.arange(len(out), dtype=np.float64) + 0.5) / float(step_hz)

    for start, end, raw_place in spans:
        place = resolve_trill_place(raw_place)
        if place is None or end <= start:
            continue
        mask = (times >= start) & (times < end)
        if not np.any(mask):
            continue
        t_sel = times[mask]
        local = t_sel - start
        rem = end - t_sel
        u = np.clip(np.minimum(local / 0.010, rem / 0.010), 0.0, 1.0)
        weight = np.minimum(1.0, u * u * (3.0 - 2.0 * u))
        rate, control, opened, closed = GESTURES[place]
        # Avoid exact Nyquist phase-lock cancellation if step_hz == 50 Hz
        eff_rate = min(rate, 0.44 * float(step_hz)) if step_hz <= 60.0 else rate
        closure = 0.5 - 0.5 * np.cos(2.0 * math.pi * eff_rate * local + (0.35 if step_hz <= 60.0 else 0.0))
        if place == "uvular":
            i_tcy = name_idx["TCY"]
            i_ts2 = name_idx["TS2"]
            out[mask, i_tcy] = np.clip(out[mask, i_tcy] + weight * 0.26, mins[i_tcy], maxs[i_tcy])
            out[mask, i_ts2] = np.clip(out[mask, i_ts2] + weight * (-0.25), mins[i_ts2], maxs[i_ts2])
        i_ctl = name_idx[control]
        delta = opened + (closed - opened) * closure
        out[mask, i_ctl] = np.clip(out[mask, i_ctl] + weight * delta, mins[i_ctl], maxs[i_ctl])
    return out


_M27_TRACT_IDX = {
    "HX": 0, "HY": 1, "JX": 2, "JA": 3, "LP": 4, "LD": 5, "VS": 6, "VO": 7,
    "TCX": 8, "TCY": 9, "TTX": 10, "TTY": 11, "TBX": 12, "TBY": 13,
    "TS1": 14, "TS2": 15, "TS3": 16,
}
_M27_TRACT_MIN = TRACT19_JD2_MIN[[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18]]
_M27_TRACT_MAX = TRACT19_JD2_MAX[[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18]]


def apply_trill_to_m27(
    rows_m27: np.ndarray,
    spans: Sequence[Tuple[float, float, str]],
    step_hz: float,
    *,
    modulate_aerodynamics_50hz: bool = False,
) -> np.ndarray:
    """Apply physiological trill gestures onto a (T, 27) physical M27 trajectory (PR in dPa).

    At 50 Hz (Tract2Vox-Lite neural path), 25-28 Hz oscillations sit at/above the 25 Hz Nyquist
    limit; ``eff_rate`` is smoothly alias-guarded to <= 22.5 Hz (preserving clear 22.5 Hz tap-open
    alternation in 20 ms frames) and optional aerodynamic tap-release modulation (PR dip during
    contact, brief release burst) reinforces audible trill flutter in the neural vocoder.
    """
    out = np.asarray(rows_m27, dtype=np.float64).copy()
    if not spans or len(out) == 0:
        return out
    times = (np.arange(len(out), dtype=np.float64) + 0.5) / float(step_hz)

    for start, end, raw_place in spans:
        place = resolve_trill_place(raw_place)
        if place is None or end <= start:
            continue
        mask = (times >= start) & (times < end)
        if not np.any(mask):
            continue
        t_sel = times[mask]
        local = t_sel - start
        rem = end - t_sel
        u = np.clip(np.minimum(local / 0.010, rem / 0.010), 0.0, 1.0)
        weight = np.minimum(1.0, u * u * (3.0 - 2.0 * u))
        rate, control, opened, closed = GESTURES[place]
        eff_rate = min(rate, 22.5) if step_hz <= 60.0 else rate
        phase_offset = 0.35 if step_hz <= 60.0 else 0.0
        closure = 0.5 - 0.5 * np.cos(2.0 * math.pi * eff_rate * local + phase_offset)

        if place == "uvular":
            i_tcy = _M27_TRACT_IDX["TCY"]
            i_ts2 = _M27_TRACT_IDX["TS2"]
            out[mask, i_tcy] = np.clip(out[mask, i_tcy] + weight * 0.26, _M27_TRACT_MIN[i_tcy], _M27_TRACT_MAX[i_tcy])
            out[mask, i_ts2] = np.clip(out[mask, i_ts2] + weight * (-0.25), _M27_TRACT_MIN[i_ts2], _M27_TRACT_MAX[i_ts2])
        i_ctl = _M27_TRACT_IDX[control]
        delta = opened + (closed - opened) * closure
        out[mask, i_ctl] = np.clip(out[mask, i_ctl] + weight * delta, _M27_TRACT_MIN[i_ctl], _M27_TRACT_MAX[i_ctl])

        if modulate_aerodynamics_50hz:
            # During brief oral contact (closure -> 1), radiated oral energy dips; on opening (closure -> 0), it rebounds.
            pr_scale = 1.0 - weight * (0.28 * closure - 0.06 * (1.0 - closure))
            out[mask, 18] = np.clip(out[mask, 18] * pr_scale, 0.0, 16000.0)
    return out
