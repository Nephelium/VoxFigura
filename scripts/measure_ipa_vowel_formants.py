"""Measure the marked centers of the local, unmodified IPA vowel recordings."""
import argparse
import json
import math
import unicodedata
from pathlib import Path

import numpy as np
import parselmouth


def measure(path, start, end):
    return measure_sound(parselmouth.Sound(str(path)), start, end)


def measure_sound(sound, start, end):
    sound = sound.convert_to_mono()
    end = min(end, sound.duration)
    width = end - start
    if start < 0 or width < 0.08:
        return None
    core_start, core_end = start + 0.3 * width, start + 0.7 * width
    formants = sound.to_formant_burg(time_step=0.01, max_number_of_formants=5,
                                    maximum_formant=5000, window_length=0.025, pre_emphasis_from=50)
    pitch = sound.to_pitch_ac(time_step=0.01, pitch_floor=65, pitch_ceiling=500)
    strength = pitch.selected_array["strength"]
    frequency = pitch.selected_array["frequency"]
    pitch_times = pitch.xs()
    times = formants.xs()
    samples = sound.values[0]
    half_window = round(sound.sampling_frequency * .0125)
    raw = []
    for time in times[(times >= core_start) & (times <= core_end)]:
        index = int(np.argmin(abs(pitch_times - time)))
        if abs(pitch_times[index] - time) > .015 or frequency[index] <= 0 or strength[index] < .55:
            continue
        center = round(time * sound.sampling_frequency)
        window = samples[max(0, center-half_window):center+half_window+1]
        rms = float(np.sqrt(np.mean(window ** 2)))
        f1 = formants.get_value_at_time(1, time)
        f2 = formants.get_value_at_time(2, time)
        if np.isfinite([f1, f2, rms]).all() and 100 <= f1 <= 1500 and f1 + 45 <= f2 <= 4000:
            raw.append([f1, f2, rms])
    if len(raw) < 4:
        return None
    readings = np.array(raw)
    readings = readings[readings[:, 2] >= .35 * np.median(readings[:, 2]), :2]
    center = np.median(readings, axis=0)
    mad = np.median(abs(readings-center), axis=0)
    stable = readings[np.all(abs(readings-center) <= np.maximum([75, 150], 4*mad), axis=1)]
    if len(stable) < 4:
        return None
    f1, f2 = np.median(stable, axis=0)
    return {"f1": round(float(f1), 1), "f2": round(float(f2), 1), "frames": len(stable),
            "core_start_s": round(core_start, 4), "core_end_s": round(core_end, 4)}


def plain_symbol(record):
    title = record["title"]
    if title.startswith("[") and "]" in title:
        return unicodedata.normalize("NFC", title[1:title.index("]")])
    return ""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", type=Path, default=Path(__file__).resolve().parents[1] / "engine" / "reference_library")
    args = parser.parse_args()
    source = args.library
    records = json.loads((source / "index.json").read_text(encoding="utf-8"))
    measured, omitted = [], []
    for record in records:
        if not record.get("exists") or record.get("voqs") or record.get("excluded") or "元音" not in record.get("group", ""):
            continue
        symbol = plain_symbol(record)
        phones = [phone for phone in record["phones"] if unicodedata.normalize("NFC", phone["label"]) == symbol]
        if len(phones) != 1 or not all(math.isfinite(phones[0][key]) for key in ("start_s", "end_s")):
            omitted.append({"id": record["id"], "reason": "缺少唯一元音标注"})
            continue
        folder = "microphone" if record.get("from_take") else "recordings"
        path = source / folder / (record["id"] + ".wav")
        try:
            data = measure(path, phones[0]["start_s"], phones[0]["end_s"])
        except (OSError, parselmouth.PraatError):
            data = None
        if data:
            measured.append({"id": record["id"], "symbol": symbol, **data})
        else:
            omitted.append({"id": record["id"], "reason": "有效稳定有声帧不足"})
    output = {"method": "Praat Burg", "parselmouth": parselmouth.__version__,
              "window_ms": 25, "step_ms": 10, "ceiling_hz": 5000, "core_fraction": [0.3, 0.7],
              "records": measured, "omitted": omitted}
    target = source / "vowel-formants.json"
    target.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{len(measured)} measured, {len(omitted)} omitted")


if __name__ == "__main__":
    main()
