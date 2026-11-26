"""Render independent Stage 5 placement comparisons and PTB trill demonstrations."""

import argparse
import json
from pathlib import Path
import sys

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))
from dense_channel import DenseEngineManager
from ipa_reference_library import CACHE, index, recording_path
from m27_bridge import M27Bridge, _m27_to_tract19, _M27_TRACT17_MAX, _M27_TRACT17_MIN
from audit_ipa_constrictions import sample_geometry, summarize_run, target_phones, REGIONS
from prepare_ipa_references import atomic_json

TRACT = "HX HY JX JA LP LD VS VO TCX TCY TTX TTY TBX TBY TS1 TS2 TS3".split()
SEP = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18]
LIMIT_SPAN = _M27_TRACT17_MAX - _M27_TRACT17_MIN
DEMO_SYMBOLS = (
    ("trill-r-dental-unvoiced", "r̪̊", "r̪", "dental", False),
    ("trill-r-dental", "r̪", "r̪", "dental", True),
    ("trill-r-alveolar-unvoiced", "r̊", "r", "alveolar", False),
    ("trill-r-alveolar", "r", "r", "alveolar", True),
    ("trill-r-postalveolar-unvoiced", "r̠̊", "r̠", "postalveolar", False),
    ("trill-r-postalveolar", "r̠", "r̠", "postalveolar", True),
    ("trill-r-uvular", "ʀ", "ʀ", "uvular", True),
)


def factory_poses():
    path = ROOT / "public" / "vocal-tract" / "factory" / "JD2" / "ipa.json"
    return {p["name"]: np.array(p["params"]) for p in json.loads(path.read_text(encoding="utf-8"))["presets"]}


def minimum_change(eng, rows, interval, poses, needed, allowed, masks):
    a, b = interval["start_s"], interval["end_s"]
    active = np.flatnonzero((np.arange(len(rows)) / 50 >= a) & (np.arange(len(rows)) / 50 < b))
    mid = active[1:-1] if len(active) > 3 else active
    targets = [np.asarray(pose)[SEP] for pose in poses]
    weight = np.array([min(1, (i + 1) / 2, (len(active) - i) / 2) for i in range(len(active))])[:, None]
    original = rows[active, :17]
    alternatives = []
    for target in targets:
        for mask in masks:
            affected = [TRACT.index(name) for name in mask.split()]
            move = np.zeros_like(original)
            move[:, affected] = target[affected] - original[:, affected]
            for factor in np.arange(.1, 1.01, .05):
                proposal = original + factor * weight * move
                test = rows[active].copy()
                test[:, :17] = proposal
                representative = test[np.searchsorted(active, mid[len(mid) // 2])]
                geometry = sample_geometry(eng, _m27_to_tract19(representative), needed)
                if geometry[0] not in needed or not allowed[0] <= geometry[1] <= allowed[1]:
                    continue
                central = [sample_geometry(eng, _m27_to_tract19(test[np.searchsorted(active, frame)]), needed) for frame in mid]
                correct = sum(geo[0] in needed and allowed[0] <= geo[1] <= allowed[1] for geo in central)
                if correct / len(central) < .75:
                    continue
                cost = np.mean(np.sum(((proposal - original) / LIMIT_SPAN) ** 2, axis=1))
                alternatives.append((cost, affected, float(factor), proposal))
                break
    if not alternatives:
        raise RuntimeError(f"{a:.3f}–{b:.3f} s 未找到满足预期区域的候选")
    cost, affected, factor, proposal = min(alternatives, key=lambda alt: alt[0])
    rows[active, :17] = proposal
    return {"organs": [TRACT[i] for i in affected], "fraction": round(factor, 2), "cost": round(float(cost), 5)}


def comparisons(engine, bridge, entries, presets):
    output = ROOT / "docs" / "试听"
    output.mkdir(exist_ok=True)
    settings = {
        "main-T111": ([presets[x] for x in ("ʁ", "q", "ɣ")], (3,), (.03, .48),
                      ["VS TCX TCY", "TCX TCY TBX TBY VS", "TCX TCY TTX TTY TBX TBY VS", "TCX TCY TTX TTY TBX TBY VS JX JA", " ".join(TRACT)]),
        "main-T130": ([presets[x] for x in ("ð", "l", "θ")], (1,), (.12, .85),
                      ["LD LP TTX TTY", "LD LP TTX TTY TBX TBY", "LD LP TTX TTY TBX TBY JA", " ".join(TRACT)]),
    }
    report = {}
    for item_id, (targets, expected, allowed, masks) in settings.items():
        item = entries[item_id]
        rows = np.asarray(json.loads((CACHE / f"{item_id}.json").read_text(encoding="utf-8"))["m27_50hz_pa"])
        candidate = rows.copy()
        detail = []
        for interval in target_phones(item):
            a, b = interval["start_s"], interval["end_s"]
            change = minimum_change(engine, candidate, interval, targets, expected, allowed, masks)
            before = summarize_run(engine, _m27_to_tract19(rows), a, b, expected)
            after = summarize_run(engine, _m27_to_tract19(candidate), a, b, expected)
            change.update({"interval": [a, b], "before": printable_run(before), "after": printable_run(after)})
            detail.append(change)
        assert np.array_equal(rows[:, 17:], candidate[:, 17:])
        atomic_json(CACHE / f"{item_id}-candidate.json", {"m27_50hz_pa": candidate.tolist()})
        speaker = recording_path(item)
        (output / f"{item_id}-原轨迹-Stage5.wav").write_bytes(bridge.neural_reference_audio(rows, speaker))
        (output / f"{item_id}-候选轨迹-Stage5.wav").write_bytes(bridge.neural_reference_audio(candidate, speaker))
        report[item_id] = {"speaker_reference": item["file"], "cases": detail}
        print(item_id, detail, flush=True)
    atomic_json(CACHE / "constriction-comparison.json", report)


def printable_run(run):
    result = {key: float(run[key]) for key in ("area", "gap", "x", "y", "share")}
    result["region"] = REGIONS[run["region"]]
    return result


def trills(engine, bridge, entries, presets):
    from phonetic_core.vocal_tract.trills import apply_trill

    output = CACHE / "trill-demos"
    output.mkdir(exist_ok=True)
    speaker = recording_path(entries["supplement-S017"])
    profile = next(entry for entry in json.loads((ROOT / "src" / "data" / "voqs-recordings.json").read_text(encoding="utf-8")) if entry["symbol"] == "V")
    source = list(profile["takes"][0]["glottis"].values())
    records = []
    for demo_id, symbol, preset, place, voiced in DEMO_SYMBOLS:
        rows = []
        for frame in range(53):
            time = frame / 50
            blend = max(0, min(1, (time - .16) / .08, (.92 - time) / .08))
            base = presets["a"] + (presets[preset] - presets["a"]) * blend
            motion = apply_trill(engine, {"params": base.tolist()}, [(.24, .84, place)], time)
            glottis = source.copy()
            glottis[1] *= max(0, min(1, time / .04, (1.06 - time) / .08))
            if not voiced and .24 <= time < .84:
                glottis[6] = 0
            rows.append([*np.array(motion["params"])[SEP], *glottis])
        audio = bridge.neural_reference_audio(rows, speaker)
        (output / f"{demo_id}.wav").write_bytes(audio)
        records.append({"id": demo_id, "symbol": symbol, "label": "PTB 颤音构型 · 井井音色 Stage 5 合成"})
        print(f"[{symbol}] {len(audio)} bytes", flush=True)
    atomic_json(output / "index.json", records)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["comparisons", "trills"])
    args = parser.parse_args()
    dense = DenseEngineManager()
    bridge = M27Bridge(dense)
    engine, _ = dense.get_engine("JD2")
    presets = factory_poses()
    entries = {item["id"]: item for item in index()}
    (comparisons if args.mode == "comparisons" else trills)(engine, bridge, entries, presets)


if __name__ == "__main__":
    main()
