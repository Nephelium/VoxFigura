"""Apply local keyframes to an indexed IPA recording and render its entire track."""
from __future__ import annotations

import base64
from io import BytesIO
import json
import math
from pathlib import Path

import numpy as np
import soundfile as sf

import ipa_reference_library as references
from ipa_materials import align_wave, prepare_materials


MAX_RADIUS = 50
_APP_MAX = {"TTX": 7.0, "TBX": 5.5}


def edit_limits(bridge):
    bridge._ensure_tt3_imports()
    from tt3.glottis27_generator import M27_MAX, M27_MIN, M27_NAMES

    fields = []
    for index, name in enumerate(M27_NAMES):
        low, high = float(M27_MIN[index]), float(M27_MAX[index])
        if name == "F0":
            fields.append({"key": name, "index": index, "min": 0.0, "exclusiveMin": True, "max": None})
            continue
        if name == "PR":
            low, high = 0.0, 1600.0
        high = min(high, _APP_MAX.get(name, high))
        fields.append({"key": name, "index": index, "min": low, "max": high})
    return {"fields": fields, "fps": 50, "max_radius": MAX_RADIUS}


class FrameEditError(ValueError):
    def __init__(self, field, hint, allowed=None, value=None):
        super().__init__(hint)
        self.detail = {"code": "out_of_range" if allowed else "validation_error", "field": field, "hint": hint}
        if allowed:
            self.detail.update(allowed=allowed, value=value)


def apply_keyframes(baseline, keyframes, limits):
    """Blend local absolute values into the original, pinning every explicit key exactly."""
    size = len(baseline)
    if not isinstance(keyframes, list) or len(keyframes) > size:
        raise FrameEditError("keyframes", "请提供同一条录音的有效关键帧")
    fields = {item["key"]: item for item in limits["fields"]}
    weighted = np.zeros_like(baseline)
    total = np.zeros_like(baseline)
    exact = []
    dedupe = set()
    for item in keyframes:
        if not isinstance(item, dict):
            raise FrameEditError("keyframes", "关键帧数据无效")
        frame, radius, values = item.get("frame"), item.get("radius"), item.get("values")
        if type(frame) is not int or frame in dedupe or not 0 <= frame < size:
            raise FrameEditError("frame", "每个帧号只允许一个关键帧，且必须在录音帧范围内")
        dedupe.add(frame)
        if type(radius) is not int or not 0 <= radius <= MAX_RADIUS:
            raise FrameEditError("radius", "过渡宽度必须为 0 到 50 帧", {"min": 0, "max": MAX_RADIUS, "unit": "frames"}, radius)
        if not isinstance(values, dict) or any(name not in fields for name in values):
            raise FrameEditError("values", "关键帧只能修改登记的 M27 参数")
        left, right = max(0, frame - radius), min(size, frame + radius + 1)
        distance = np.abs(np.arange(left, right) - frame)
        weight = (1 + np.cos(np.pi * distance / radius)) * .5 if radius else np.ones(1)
        for name, value in values.items():
            field = fields[name]
            if type(value) not in (int, float) or not math.isfinite(value):
                raise FrameEditError(name, f"{name} 必须是有限数值")
            low, high = field["min"], field.get("max")
            excl = bool(field.get("exclusiveMin"))
            below = (value <= low) if excl else (value < low)
            above = (high is not None) and (value > high)
            if below or above:
                if high is None:
                    raise FrameEditError(name, f"{name} 必须大于 {low:g}", {"min": low, "exclusiveMin": excl}, value)
                raise FrameEditError(name, f"{name} 必须在 {low:g}–{high:g} 之间",
                                     {"min": low, "max": high}, value)
            index = field["index"]
            weighted[left:right, index] += value * weight
            total[left:right, index] += weight
            exact.append((frame, index, value))
    result = (baseline * np.maximum(0, 1 - total) + weighted) / np.maximum(1, total)
    for frame, index, value in exact:
        result[frame, index] = value
    return result


def render_revision(payload, bridge):
    record_id = payload.get("recording_id")
    item = next((entry for entry in references.index() if entry["id"] == record_id
                 and entry["exists"] and entry["animation"] and not entry["excluded"] and not entry.get("voqs")), None)
    if not item:
        raise FrameEditError("recording_id", "这条录音没有可修订的 M27 声道轨迹")
    mode = payload.get("mode", "neural")
    if mode not in ("neural", "physical"):
        raise FrameEditError("mode", "请选择神经或物理重合成")
    source = references.recording_path(item)
    wave, _, track, _ = prepare_materials(item, references.LIBRARY, source, audio_gain="original")
    if track is None:
        raise FrameEditError("recording_id", "找不到原始反演轨迹")
    data = json.loads(track.read_bytes() if isinstance(track, Path) else track)
    baseline = np.asarray(data["m27_50hz_pa"], dtype=np.float64)
    if baseline.ndim != 2 or baseline.shape[1] != 27 or not 0 < len(baseline) <= 3000 or not np.isfinite(baseline).all():
        raise FrameEditError("recording_id", "原始反演轨迹不是有效的 50 Hz M27")
    frames = apply_keyframes(baseline, payload.get("keyframes"), edit_limits(bridge))
    if np.array_equal(frames, baseline):
        raise FrameEditError("keyframes", "请先修改至少一个关键帧参数")
    args = {
        "m27_50hz_pa": frames.tolist(), "synth_mode": "neural" if mode == "neural" else "vtl",
        "device": "cuda" if payload.get("device") == "cuda" else "cpu", "fps": 50,
        "audio_gain": "original",
    }
    if mode == "neural":
        args["speaker_ref_wav_base64"] = base64.b64encode(source.read_bytes()).decode("ascii")
    output = bridge.resynthesize(args)
    if not output.get("ok"):
        return output
    audio = base64.b64decode(output["neural_16k_wav_base64" if mode == "neural" else "vtl_48k_wav_base64"])
    aligned = align_wave(audio, wave, audio_gain=payload.get("audio_gain", "peak"))
    animation = output["tract_glottis_anim"]
    animation["duration_sec"] = sf.info(BytesIO(aligned)).duration
    return {"ok": True, "animation": animation, "m27_50hz_pa": frames.tolist(),
            "wav_base64": base64.b64encode(aligned).decode("ascii"), "mode": mode}
