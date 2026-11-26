"""Recorded stop phases and bounded articulator targets for connected speech."""

from dataclasses import dataclass
from functools import lru_cache
import json
import unicodedata

import numpy as np

from ipa_reference_library import LIBRARY, index, recording_path
from validation import M27_MAX_PA, M27_MIN_PA


TRACT_MIN = M27_MIN_PA[:17]
TRACT_SPAN = M27_MAX_PA[:17] - TRACT_MIN
STOP_PHASES = frozenset(("closure", "release", "aspiration", "nasal_release", "lateral_release"))
_SYMBOL_ALIASES = {"ȶɕ": "tɕ", "ȡʑ": "dʑ", "ʈʂ": "tʂ", "ɖʐ": "dʐ"}


def normalize_tract(tract):
    return (2.0 * (tract - TRACT_MIN) / TRACT_SPAN - 1.0).astype(np.float32)


def _phone_key(symbol):
    symbol = unicodedata.normalize("NFC", symbol).translate(str.maketrans({"͡": "", "͜": "", "g": "ɡ"}))
    base = symbol.rstrip("ʰʱ")
    return _SYMBOL_ALIASES.get(base, base) + symbol[len(base):]


@lru_cache(maxsize=1)
def _references():
    entries = {}
    for item in index():
        if not item["exists"] or item["excluded"] or not item["animation"]:
            continue
        for phone in item["phones"]:
            label = _phone_key(phone["label"])
            entries.setdefault(label, []).append((item, phone["start_s"], phone["end_s"]))
    return entries


def _release_sample(audio, rate, start, end):
    first = max(1, round((start - 0.010) * rate))
    last = min(len(audio), round(min(end, start + 0.085) * rate))
    block = max(2, round(0.004 * rate))
    if last - first < block:
        return None
    diff = np.diff(audio[first - 1:last])
    usable = len(diff) // block * block
    energy = np.mean(diff[:usable].reshape(-1, block) ** 2, axis=1)
    if not np.isfinite(energy).all() or max(energy) <= 1e-10:
        return None
    # Choose the first prominent broadband transient near the labeled release.
    hits = np.flatnonzero(energy >= 0.45 * max(energy))
    return (first + (int(hits[0]) + 0.5) * block) / rate


@lru_cache(maxsize=96)
def _stop_windows(symbol):
    import soundfile as sf

    windows = []
    records = _references().get(symbol, ())
    for item, start, end in sorted(records, key=lambda hit: -(hit[2] - hit[1]))[:6]:
        try:
            content = json.loads((LIBRARY / f"{item['id']}.json").read_text(encoding="utf-8"))
            dense = np.asarray(content["m27_50hz_pa"], dtype=np.float32)
            audio, rate = sf.read(recording_path(item), dtype="float32", always_2d=True)
        except (OSError, RuntimeError, ValueError, KeyError):
            continue
        if dense.ndim != 2 or dense.shape[1] != 27:
            continue
        burst = _release_sample(audio.mean(axis=1), rate, start, end)
        if burst is None:
            continue
        centers = (np.arange(len(dense)) + 0.5) / 50.0
        tract = dense[:, :17]
        valid = np.isfinite(tract).all(axis=1) & (tract >= TRACT_MIN - 1e-5).all(axis=1)
        valid &= (tract <= TRACT_MIN + TRACT_SPAN + 1e-5).all(axis=1)
        closure = tract[valid & (centers >= start - 0.045) & (centers < burst)]
        release_ids = np.flatnonzero(valid & (centers >= burst - 0.004) & (centers < min(end, burst + 0.035)))
        if len(closure) and len(release_ids):
            nearest = release_ids[np.argmin(np.abs(centers[release_ids] - burst))]
            windows.append((normalize_tract(closure), normalize_tract(tract[nearest])))
    return windows


def recorded_stop_poses(symbol, zone, predict_area):
    """Return a low-area frame and a later burst-adjacent frame if they form a credible pair."""
    if zone is None:
        return None
    windows = _stop_windows(_phone_key(symbol))
    if not windows:
        from kf_ipa_synth.phonetics import strip_ipa_diacritics
        base = strip_ipa_diacritics(symbol)
        if base and base != symbol:
            windows = _stop_windows(_phone_key(base))
    if not windows:
        return None
    area = predict_area(np.concatenate([np.vstack((closed, release)) for closed, release in windows]))[:, zone]
    offset = 0
    best = None
    best_score = float("inf")
    for closed, release in windows:
        closed_area = area[offset:offset + len(closed)]
        row = int(np.argmin(closed_area))
        opened_area = area[offset + len(closed)]
        offset += len(closed) + 1
        if not np.isfinite(opened_area) or closed_area[row] > 0.12 or opened_area < closed_area[row] + 0.015:
            continue
        if closed_area[row] < best_score:
            best_score = float(closed_area[row])
            best = closed[row], release
    return best


def constriction_zone(features):
    # Primary oral constriction takes precedence over secondary diacritic place flags
    # (e.g. tʷ/kʷ/sʷ labialized, tʲ/pʲ palatalized, tˤ/kˤ pharyngealized, tʼ ejective).
    has_primary_oral = (
        features[3] >= 0.8 or features[4] >= 0.5
        or features[5] >= 0.8 or features[6] >= 0.8
        or features[7] >= 0.8 or features[8] >= 0.8
    )
    if features[9] >= 0.5 and not has_primary_oral:  # Glottal/pharyngeal phones have no oral stop zone.
        return None
    if features[5] >= 0.8 or features[6] >= 0.8:
        return 2
    if features[7] >= 0.8 or features[8] >= 0.8:
        return 3
    if features[3] >= 0.8 or features[4] >= 0.5:
        return 1
    if features[5] >= 0.5 or features[6] >= 0.5:
        return 2
    if features[7] >= 0.5 or features[8] >= 0.5:
        return 3
    if features[3] >= 0.5:
        return 1
    return 0


@dataclass(frozen=True)
class ArticulatorTarget:
    start: int
    end: int
    pose: np.ndarray
    weights: np.ndarray
    narrow_zone: int | None
    hold_left: bool = False
    hold_right: bool = False
    ramp_left: int = 6
    ramp_right: int = 6
    trapezoid: bool = False


def _trapezoid_envelope(seg_len: int, hold_left: bool, hold_right: bool, ramp_left: int, ramp_right: int) -> np.ndarray:
    """Flat-top C1-smooth envelope that stays 1.0 at utterance/silence edges and ramps only against speech neighbors."""
    env = np.ones(seg_len, dtype=np.float64)
    if seg_len <= 1:
        return env if (hold_left or hold_right) else np.zeros(seg_len, dtype=np.float64)
    if not hold_left:
        max_l = seg_len - 1 if hold_right else seg_len // 2
        rl = min(max(1, ramp_left), max_l)
        if rl >= 1:
            u = (np.arange(rl, dtype=np.float64) + 1.0) / float(rl + 1)
            env[:rl] = 0.5 * (1.0 - np.cos(np.pi * u))
    if not hold_right:
        max_r = seg_len - 1 if hold_left else seg_len // 2
        rr = min(max(1, ramp_right), max_r)
        if rr >= 1:
            u = np.arange(rr, 0, -1, dtype=np.float64) / float(rr + 1)
            env[seg_len - rr:] = np.minimum(env[seg_len - rr:], 0.5 * (1.0 - np.cos(np.pi * u)))
    return env


def apply_articulator_targets(rows, targets, bell, predict_area):
    """Pin the primary articulators across each target span and check their local narrowing."""
    if not targets:
        return
    planned = []
    guard_poses = []
    for target in targets:
        seg_len = target.end - target.start
        if target.trapezoid or target.hold_left or target.hold_right:
            if seg_len <= 0:
                continue
            envelope = _trapezoid_envelope(
                seg_len, target.hold_left, target.hold_right, target.ramp_left, target.ramp_right,
            )
        else:
            if seg_len < 3:
                continue
            envelope = bell(seg_len)
            if seg_len < 6:
                envelope = envelope * ((seg_len - 2) / 4.0)
        current = normalize_tract(rows[target.start:target.end, :17])
        peak = current[int(np.argmax(envelope))]
        full = np.where(target.weights > 0, target.pose, peak)
        preferred = peak + target.weights * (target.pose - peak)
        if target.narrow_zone is not None:
            guard_poses.extend([preferred, full])
        planned.append((target, envelope))
    areas = predict_area(np.asarray(guard_poses)) if guard_poses else []
    guard = 0
    for target, envelope in planned:
        weights = target.weights
        if target.narrow_zone is not None:
            usual, narrow = areas[guard:guard + 2, target.narrow_zone]
            guard += 2
            if usual > narrow + max(0.015, 0.25 * narrow):
                weights = np.where(weights > 0, 1.0, 0.0)
        # Re-read current slice fresh so overlapping primary & continuous secondary targets never overwrite each other
        current = normalize_tract(rows[target.start:target.end, :17])
        anchored = current + envelope[:, None] * weights * (target.pose - current)
        rows[target.start:target.end, :17] = TRACT_MIN + (anchored + 1.0) * 0.5 * TRACT_SPAN


def preserve_stop_transients(
    rows_50, dense, spans, factor, silent_50=None, *,
    locks_50=None, short_targets=None, step_samples=None,
):
    """Keep a coherent dense control frame for an event instead of averaging its peak away."""
    if factor <= 1:
        return rows_50
    selected = {}
    n = len(dense)
    for span_id, span in enumerate(spans):
        if not isinstance(span, dict):
            continue
        role = span.get("phase")
        if role not in STOP_PHASES:
            continue
        start, end = span.get("start_frame"), span.get("end_frame")
        if type(start) is not int or type(end) is not int or not 0 <= start <= end <= n:
            continue
        short_target = None
        if start == end:
            short_target = short_targets.get(span_id) if short_targets else None
            if short_target is None or step_samples is None:
                continue
            frame = min(n - 1, (span["start_sample"] + span["end_sample"]) // (2 * step_samples))
        else:
            frame = (start + end - 1) // 2
        slot = frame // factor
        if silent_50 is not None and silent_50[slot]:
            continue
        # A merged 20 ms slot can carry only one event. Prefer the release transient.
        rank = 2 if role in ("release", "nasal_release", "lateral_release") else 1 if role == "closure" else 0
        if slot not in selected or rank > selected[slot][0]:
            selected[slot] = (rank, frame, short_target)
    for slot, (_, frame, short_target) in selected.items():
        current = rows_50[slot]
        if short_target is None:
            replacement = dense[frame]
        else:
            target, weights = short_target
            replacement = current.copy()
            pose = TRACT_MIN + (target + 1.0) * 0.5 * TRACT_SPAN
            replacement[:17] += weights * (pose - replacement[:17])
        if locks_50 is not None:
            replacement = np.where(locks_50[slot], current, replacement)
        current[:17] = replacement[:17]
        current[18:24] = replacement[18:24]
    return rows_50
