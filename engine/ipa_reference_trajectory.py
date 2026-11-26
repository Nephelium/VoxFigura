"""Select labeled IPA takes and place their control trajectories on the annotation clock."""
from dataclasses import dataclass
import json
import math
import unicodedata

import numpy as np

from ipa_articulation import _release_sample
from ipa_reference_library import LIBRARY, index, recording_path
from validation import CONTROL_TOL, M27_MAX_PA, M27_MIN_PA, SAMPLE_RATE_HZ


_VOWELS = frozenset("aeiouyɑɒɔəɛɤɪʊʌæɐøœɨʉɯɶɞɘɵɜɚɝɩʏɿʅᴀᴇ")
_CONTROL_HZ = 50
_TRACT = slice(0, 17)


def _key(ipa):
    return unicodedata.normalize("NFD", ipa).translate(str.maketrans({"͡": "", "͜": "", "g": "ɡ", "̊": "̥"}))


def _vowel(ipa):
    return isinstance(ipa, str) and bool(ipa) and _key(ipa)[0:1] in _VOWELS


def _neighbors(phones, i):
    phone = phones[i]
    left = phones[i - 1] if i else None
    right = phones[i + 1] if i + 1 < len(phones) else None
    return (
        left["label"] if left and _vowel(left["label"]) and abs(phone["start_s"] - left["end_s"]) <= .02 else None,
        right["label"] if right and _vowel(right["label"]) and abs(phone["end_s"] - right["start_s"]) <= .02 else None,
    )


@dataclass
class ReferenceTrajectory:
    info: dict
    frames: slice
    controls_pa: np.ndarray
    weights: np.ndarray


def protection_weights(start_smp, end_smp, frames, step_smp, release_smp=None):
    """Keep the ramp inside the full phoneme, even when previewing a cropped range."""
    first_smp = math.ceil(start_smp / step_smp) * step_smp
    last_smp = (math.ceil(end_smp / step_smp) - 1) * step_smp
    extent_smp = last_smp - first_smp
    if extent_smp < 2 * step_smp:
        return np.zeros(frames.stop - frames.start)
    head_smp = min(.030 * SAMPLE_RATE_HZ, extent_smp * .35)
    tail_smp = min(.035 * SAMPLE_RATE_HZ, extent_smp * .40)
    if release_smp is not None:
        head_smp = min(head_smp, max(step_smp, release_smp - first_smp))
        tail_smp = min(tail_smp, max(step_smp, last_smp - release_smp - step_smp))
    times_smp = np.arange(frames.start, frames.stop) * step_smp
    progress = np.clip(np.minimum((times_smp - first_smp) / head_smp, (last_smp - times_smp) / tail_smp), 0., 1.)
    return .5 - .5 * np.cos(np.pi * progress)


def _select(takes, request, step_smp, frames, weights, tracks):
    options = []
    for take, phone, left, right in takes:
        position = "intervocalic" if left and right else "onset" if right else "other"
        score = (
            position == request["position"],
            sum(_key(actual) == _key(wanted) for actual, wanted in
                ((left, request.get("left_vowel")), (right, request.get("right_vowel"))) if actual and wanted),
            phone["end_s"] - phone["start_s"],
        )
        options.append((score, take, phone, position))

    start_smp, end_smp = request["start_smp"], request["end_smp"]
    target_smp = np.arange(frames.start, frames.stop) * step_smp
    for _, take, phone, position in sorted(options, key=lambda item: item[0], reverse=True):
        take_id = take["id"]
        if take_id not in tracks:
            try:
                data = json.loads((LIBRARY / f"{take_id}.json").read_text(encoding="utf-8"))
                tracks[take_id] = np.asarray(data["m27_50hz_pa"], dtype=np.float64)
            except (OSError, ValueError, KeyError, TypeError):
                tracks[take_id] = None
        dense = tracks[take_id]
        if dense is None or dense.ndim != 2 or dense.shape[1] != 27:
            continue
        start_s, end_s = phone["start_s"], phone["end_s"]
        centers_s = (np.arange(len(dense)) + .5) / _CONTROL_HZ
        within = (centers_s >= start_s) & (centers_s < end_s)
        rows = dense[within]
        if (len(rows) < 2 or not np.isfinite(rows).all()
                or (rows < M27_MIN_PA - CONTROL_TOL).any() or (rows > M27_MAX_PA + CONTROL_TOL).any()):
            continue
        target_points = [start_smp, end_smp]
        source_points = [start_s, end_s]
        release_smp = request.get("release_smp")
        if release_smp is not None:
            import soundfile as sf
            try:
                audio, rate = sf.read(recording_path(take), dtype="float32", always_2d=True)
                burst_s = _release_sample(audio.mean(axis=1), rate, start_s, end_s)
            except (OSError, RuntimeError, ValueError):
                burst_s = None
            if burst_s is None or not start_s < burst_s < end_s:
                continue
            target_points.insert(1, release_smp)
            source_points.insert(1, burst_s)
        mapped_s = np.interp(target_smp, target_points, source_points)
        control = np.column_stack([np.interp(mapped_s, centers_s[within], col) for col in rows.T])
        info = {
            "ipa": request["ipa"], "reference_id": take_id, "position": request["position"],
            "reference_position": position, "source_start_s": start_s, "source_end_s": end_s,
            "start_smp": max(0, start_smp), "end_smp": min(end_smp, request["render_end_smp"]),
        }
        return ReferenceTrajectory(info, frames, control, weights)
    return None


def prepare_reference_trajectories(requests, sample_count, step_smp, frame_count):
    if requests is None:
        return [], []
    if not isinstance(requests, list) or len(requests) > frame_count:
        raise ValueError("参考动程须为有序的音段列表")
    keys = set()
    checked = []
    previous_end = -60 * SAMPLE_RATE_HZ
    for request in requests:
        if not isinstance(request, dict):
            raise ValueError("参考动程须为有序的音段列表")
        ipa, start, end = (request.get(name) for name in ("ipa", "start_smp", "end_smp"))
        if (not isinstance(ipa, str) or not 1 <= len(ipa) <= 32
                or type(start) is not int or type(end) is not int
                or not previous_end <= start < min(end, sample_count) or end <= 0
                or end - start > 60 * SAMPLE_RATE_HZ
                or request.get("position") not in ("onset", "intervocalic")
                or any(request.get(name) is not None and not _vowel(request[name])
                       for name in ("left_vowel", "right_vowel"))):
            raise ValueError("参考动程音标、位置或采样区间无效")
        release = request.get("release_smp")
        if release is not None and (type(release) is not int or not start < release < end):
            raise ValueError("参考动程的释放位置须在音段内")
        key = _key(ipa)
        keys.add(key)
        checked.append((key, {**request, "render_end_smp": sample_count}))
        previous_end = end

    takes = {key: [] for key in keys}
    for take in index() if keys else ():
        if not take["exists"] or take["excluded"] or not take["animation"]:
            continue
        phones = take["phones"]
        for i, phone in enumerate(phones):
            key = _key(phone["label"])
            if key in takes:
                takes[key].append((take, phone, *_neighbors(phones, i)))

    selected, missing, tracks = [], [], {}
    for key, request in checked:
        first = math.ceil(request["start_smp"] / step_smp)
        last = math.ceil(request["end_smp"] / step_smp)
        if last - first < 3 or (request.get("affricate") and request["end_smp"] - request["start_smp"] < 3 * step_smp):
            missing.append(request["ipa"])
            continue
        frames = slice(max(0, first), min(frame_count, last))
        weights = protection_weights(
            request["start_smp"], request["end_smp"], frames, step_smp, request.get("release_smp"),
        )
        if not np.any(weights):
            continue
        trajectory = _select(takes[key], request, step_smp, frames, weights, tracks)
        if trajectory is None:
            missing.append(request["ipa"])
        else:
            selected.append(trajectory)
    return selected, list(dict.fromkeys(missing))


def _smooth_ramp_zone(rows, start, stop, weights, cols):
    """Apply two gentle zero-phase smoothing passes across transition ramps without altering core frames."""
    span_len = stop - start
    if span_len < 3:
        return
    ramp_mask = (weights > 0.0) & (weights < 1.0)
    if not np.any(ramp_mask):
        return
    lo = max(1, start)
    hi = min(len(rows) - 1, stop)
    if lo >= hi:
        return
    local_mask = np.zeros(hi - lo, dtype=bool)
    offset = lo - start
    local_mask[:] = ramp_mask[offset:offset + (hi - lo)]
    for _ in range(2):
        prev_vals = rows[lo - 1:hi - 1, cols]
        curr_vals = rows[lo:hi, cols]
        next_vals = rows[lo + 1:hi + 1, cols]
        smoothed = 0.25 * prev_vals + 0.5 * curr_vals + 0.25 * next_vals
        rows[lo:hi, cols] = np.where(local_mask[:, None], smoothed, curr_vals)


def _baseline_pressure_dpa(host_pr_dpa, src_pr_dpa):
    """Scale recorded reference pressure to match the host trajectory's boundary level."""
    host_edges = []
    src_edges = []
    for idx in (0, -1):
        if host_pr_dpa[idx] > 1000.0 and src_pr_dpa[idx] > 1000.0:
            host_edges.append(float(host_pr_dpa[idx]))
            src_edges.append(float(src_pr_dpa[idx]))
    if host_edges:
        host_level = float(np.mean(host_edges))
        src_level = float(np.mean(src_edges))
    else:
        active_host = host_pr_dpa[host_pr_dpa > 1000.0]
        active_src = src_pr_dpa[src_pr_dpa > 1000.0]
        if not active_host.size or not active_src.size:
            return src_pr_dpa
        host_level = float(np.median(active_host))
        src_level = float(np.median(active_src))
    scale = float(np.clip(host_level / max(1000.0, src_level), 0.45, 1.35))
    return np.clip(src_pr_dpa * scale, 0.0, float(M27_MAX_PA[18]) * 10.0)


def apply_reference_trajectories(rows, references, pressure_locks, phonation_locks, excluded):
    """Blend reference geometry and baseline-aligned excitation without boundary cliffs."""
    abduction_cols = [19, 20, 21]
    for reference in references:
        frames, source = reference.frames, reference.controls_pa
        target = rows[frames]
        w = reference.weights * ~excluded[frames]
        if not np.any(w):
            continue
        target[:, _TRACT] += w[:, None] * (source[:, _TRACT] - target[:, _TRACT])

        pressure = w * ~pressure_locks[frames]
        if np.any(pressure):
            aligned_pr = _baseline_pressure_dpa(target[:, 18], source[:, 18] * 10.0)
            target[:, 18] += pressure * (aligned_pr - target[:, 18])

        phonation = w * ~phonation_locks[frames]
        voiceless_ref = float(np.min(source[:, 23])) < 0.15
        if voiceless_ref and np.any(phonation):
            # Preserve voiceless abduction and voicing dip while keeping host speaker timbre (LAG/PS/FL/SHIM).
            target[:, abduction_cols] += phonation[:, None] * (source[:, abduction_cols] - target[:, abduction_cols])
            host_edges = [float(v) for v in (target[0, 23], target[-1, 23]) if v > 0.15]
            host_ra = float(np.mean(host_edges)) if host_edges else max(0.15, float(np.max(target[:, 23])))
            src_ra = max(0.20, float(np.max(source[:, 23])))
            ra_scale = float(np.clip(host_ra / src_ra, 0.4, 1.2))
            aligned_ra = np.where(source[:, 23] > 0.0, source[:, 23] * ra_scale, source[:, 23])
            aligned_ra = np.clip(aligned_ra, float(M27_MIN_PA[23]), float(M27_MAX_PA[23]))
            target[:, 23] += phonation * (aligned_ra - target[:, 23])

        smooth_cols = list(range(17))
        if np.any(pressure):
            smooth_cols.append(18)
        if voiceless_ref and np.any(phonation):
            smooth_cols.extend((19, 20, 21, 23))
        _smooth_ramp_zone(rows, frames.start, frames.stop, w, smooth_cols)
