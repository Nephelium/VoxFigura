"""Build the glottal-only VoQS library from the selected real recordings."""

import json
from pathlib import Path

import numpy as np
import soundfile as sf

GROUPS = {
    "closure": "声门压紧、周期振动与漏气",
    "irregular": "不规则振动与嘎裂",
    "falsetto": "假声及其复合发声",
    "height": "喉位录音参照",
}
TYPES = {
    "V͈": ("挤喉发声/紧声", "closure", "pressed"), "V": ("常态浊声", "closure", "modal"),
    "V̤": ("气声", "closure", "breathy"), "Ṿ": ("耳语声", "closure", "breathy"),
    "W": ("耳语", "closure", "whisper"), "V̰": ("嘎裂声", "irregular", "creaky"),
    "C": ("嘎裂", "irregular", "creaky"), "V̰̣": ("耳语嘎裂声", "irregular", "creaky"),
    "F": ("假声", "falsetto", "falsetto"), "F̣": ("耳语假声", "falsetto", "falsetto"),
    "F̰": ("嘎裂假声", "falsetto", "falsetto"), "F̰̣": ("耳语嘎裂假声", "falsetto", "falsetto"),
    "L̝": ("喉位偏高声", "height", "modal"), "L̞": ("喉位偏低声", "height", "modal"),
}
MAIN = {"T249": "V", "T250": "V̤", "T251": "Ṿ", "T252": "W", "T253": "F", "T256": "V͈",
        "T257": "V̰", "T259": "L̝", "T260": "L̞"}
REVIEWED_EXPORTS = {"vq_08_pressed_a": "V͈", "vq_11_raised_larynx_a": "L̝", "vq_12_lowered_larynx_a": "L̞"}
PARAMS = ("f0_hz", "pr_pa", "xb_cm", "xt_cm", "ca_cm2", "lag_rad", "ra", "ps", "fl", "shim")
LOW = np.array([40, 0, -.05, -.05, -.25, 0, -1, -1, 0, 0])
HIGH = np.array([600, 1600, .30, .30, .25, 3.1415, 1, 1, 100, 100])


def voqs_symbol(task, path):
    return MAIN.get(task["id"]) or REVIEWED_EXPORTS.get(path.stem) or (task["title"].split(" · ", 1)[0] if "发声类型" in task["group"] else "")


def choose_glottis_frame(rows, audio_path, intervals):
    arr = np.asarray(rows, dtype=np.float64)
    if arr.ndim != 2 or arr.shape[1] != len(PARAMS):
        raise ValueError("VoQS 需要 50 Hz 十维声门矩阵")
    times = (np.arange(len(arr)) + .5) / 50
    valid = np.isfinite(arr).all(axis=1) & (arr >= LOW).all(axis=1) & (arr <= HIGH).all(axis=1)
    if intervals:
        keep = np.zeros(len(arr), dtype=bool)
        for interval in intervals:
            start, end = interval["start_s"], interval["end_s"]
            trim = min(.2, (end - start) * .15)
            keep |= (times >= start + trim) & (times < end - trim)
    else:
        wav, fs = sf.read(audio_path, dtype="float32", always_2d=True)
        window = int(fs * .02)
        n = min(len(arr), len(wav) // window)
        rms = np.sqrt(np.mean(wav[: n * window].reshape(n, window, wav.shape[1]) ** 2, axis=(1, 2)))
        keep = np.zeros(len(arr), dtype=bool)
        high = float(np.quantile(rms, .9))
        keep[:n] = rms >= max(min(float(np.quantile(rms, .2)) * 2, high * .50), high * .20)
    selected = np.flatnonzero(keep & valid)
    if not len(selected):
        raise ValueError("目标区间没有合格的实际模型帧")
    med = np.median(arr[selected], axis=0)
    frame = int(selected[np.argmin(np.sum(((arr[selected] - med) / (HIGH - LOW)) ** 2, axis=1))])
    return frame, {key: round(float(value), 4) for key, value in zip(PARAMS, arr[frame])}, int(len(selected))


def make_voqs_library(records, cache, recordings, root):
    profiles = {symbol: [] for symbol in TYPES}
    for item in records:
        symbol = item.get("voqs_symbol")
        path = cache / "voqs" / f"{item['id']}.json"
        if symbol not in profiles or not item["exists"] or not path.is_file():
            continue
        audio = (cache / "microphone" / f"{item['id']}.wav" if item["from_take"] else
                 recordings / ("IPA" if item["source"] == "main" else "补充") / item["file"])
        rows = json.loads(path.read_text(encoding="utf-8"))["glottis_50hz_pa"]
        interval = item.get("voqs_intervals", [])
        try:
            idx, glottis, count = choose_glottis_frame(rows, audio, interval)
        except ValueError as error:
            print(f"{item['id']}: {error}")
            continue
        profiles[symbol].append({"id": item["id"], "file": item["file"], "frame": idx, "t_s": round(idx / 50, 3),
                                 "tagged": bool(interval), "candidate_frames": count, "glottis": glottis})
    output = []
    for symbol, (label, group, legacy) in TYPES.items():
        takes = sorted(profiles[symbol], key=lambda item: not item["tagged"])
        if takes:
            output.append({"symbol": symbol, "label": label, "group": group, "group_label": GROUPS[group],
                           "legacy": legacy, "takes": takes})
    (root / "src" / "data" / "voqs-recordings.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output
