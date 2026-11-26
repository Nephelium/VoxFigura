"""Build the local IPA reference index and CPU reconstruction cache."""

import argparse
import base64
import csv
import json
import os
from pathlib import Path
import re
import sys
import unicodedata

import numpy as np
import soundfile as sf
from voqs_references import REVIEWED_EXPORTS, TYPES as VOQS_TYPES, make_voqs_library, voqs_symbol

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = Path.home() / "Desktop"
CACHE = ROOT / ".cache" / "ipa-references"
EXCLUDED = re.compile(r"implosive|ejective|click", re.IGNORECASE)


def selected_microphone(project, take, destination):
    """Read the selected version's existing spans and keep only its microphone channel."""
    config = take["config"]
    if "microphone" not in config.get("roles", []) or not take.get("versions"):
        return False
    channel = config["roles"].index("microphone")
    version = take["versions"][take["head"]]
    spans = []
    root = project.parent.resolve()
    for span in version["spans"]:
        path = (root / span["file"]).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            return False
        audio = np.fromfile(path, dtype="<f4").reshape(-1, span["channels"])
        spans.append(audio[span["start"]:span["end"], channel])
    if not spans or not any(len(chunk) for chunk in spans):
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.is_file() or destination.stat().st_mtime < project.stat().st_mtime:
        temp = destination.with_suffix(".tmp")
        sf.write(temp, np.concatenate(spans), config["sample_rate"], format="WAV", subtype="FLOAT")
        temp.replace(destination)
    return True


def textgrid_phones(path):
    if not path.is_file():
        return []
    raw = path.read_bytes()
    text = raw.decode("utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig")
    for tier in re.split(r"^\s*item \[\d+\]:", text, flags=re.M)[1:]:
        if not re.search(r'\bname\s*=\s*"phones?"', tier, re.I):
            continue
        intervals = re.findall(r'intervals \[\d+\]:\s*xmin\s*=\s*([\d.eE+-]+)\s*xmax\s*=\s*([\d.eE+-]+)\s*text\s*=\s*"([^"]*)"', tier)
        return [{"start_s": float(a), "end_s": float(b), "label": label.strip()} for a, b, label in intervals if label.strip()]
    return []


def make_index():
    library = DESKTOP / "国际音标"
    sources = [
        ("main", library / "IPA", DESKTOP / "IPA" / "project.json"),
        ("supplement", library / "补充", DESKTOP / "国际音标增补" / "project.json"),
    ]
    records = []
    for source, folder, project in sources:
        if not project.is_file():
            continue
        project_data = json.loads(project.read_text(encoding="utf-8-sig"))
        tasks = project_data["tasks"]
        takes = {take["id"]: take for take in project_data["takes"]}
        used = set()
        for task in tasks:
            stem = task["filename_stem"]
            path = folder / f"{stem}.wav"
            used.add(stem)
            phones = textgrid_phones(path.with_suffix(".TextGrid")) if path.is_file() else []
            cache_id = f"{source}-{task['id']}"
            derived = CACHE / "microphone" / f"{cache_id}.wav"
            take = takes.get(project_data["selected"].get(task["id"]))
            from_take = not path.is_file() and take is not None and selected_microphone(project, take, derived)
            expected = re.findall(r"\[([^]]+)\]", task["title"])
            labeled = "".join(p["label"] for p in phones).replace(" ", "")
            issues = []
            if path.is_file() and not phones:
                issues.append("缺少可用 phones 标注")
            elif phones and expected and unicodedata.normalize("NFD", "".join(expected).replace(" ", "")) != unicodedata.normalize("NFD", labeled):
                issues.append("任务读法与 phones 层拼接不同")
            if from_take:
                issues.append("来自录音工程已选版本的麦克风轨，尚无对应 TextGrid")
            if phones:
                auto = textgrid_phones(path.with_name(f"{stem}_自动保存.TextGrid"))
                if auto and auto != phones:
                    issues.append("正式 TextGrid 与自动保存版存在差异")
                signal_issue = check_boundary_audio(path, phones)
                if signal_issue:
                    issues.append(signal_issue)
            records.append(record(source, path, task, phones, "；".join(issues), from_take=from_take))
        for path in sorted(folder.glob("*.wav")):
            if path.stem not in used:
                task = {"id": path.stem, "title": path.stem, "prompt": path.stem, "group": "补充导出"}
                phones = textgrid_phones(path.with_suffix(".TextGrid"))
                issues = ["无同名任务行"]
                signal_issue = check_boundary_audio(path, phones)
                if signal_issue:
                    issues.append(signal_issue)
                records.append(record(source, path, task, phones, "；".join(issues)))
    return apply_reviewed_voqs_exports(records)


def apply_reviewed_voqs_exports(records):
    by_id = {item["id"]: item for item in records}
    for stem in REVIEWED_EXPORTS:
        item = by_id.get(f"supplement-{stem}")
        if item and item["exists"]:
            item["verified"] = True
            item["issue"] = "；".join(issue for issue in item["issue"].split("；") if issue != "无同名任务行")

    placeholder = by_id.get("supplement-S036")
    pressed = by_id.get("supplement-vq_08_pressed_a")
    if placeholder and not placeholder["exists"] and pressed and pressed["exists"]:
        records.remove(pressed)
        pressed["group"] = placeholder["group"]
        records[records.index(placeholder)] = pressed
    return records


def check_boundary_audio(path, phones):
    """Flag an energetic region wholly outside phoneme labels for human listening."""
    if not phones:
        return ""
    audio, fs = sf.read(path, dtype="float32", always_2d=True)
    samples = np.max(np.abs(audio), axis=1)
    hop = max(1, int(fs * 0.01))
    n = len(samples) // hop
    if n < 10:
        return ""
    rms = np.sqrt(np.mean(samples[:n * hop].reshape(n, hop) ** 2, axis=1))
    threshold = max(float(np.quantile(rms, .95)) * .35, float(np.quantile(rms, .2)) * 8)
    if threshold <= 0:
        return ""
    times = (np.arange(n) + .5) * hop / fs
    inside = np.zeros(n, dtype=bool)
    for phone in phones:
        inside |= (times >= phone["start_s"] - .035) & (times <= phone["end_s"] + .035)
    runs = np.flatnonzero(np.diff(np.r_[False, (~inside) & (rms > threshold), False])).reshape(-1, 2)
    spans = [(a, b) for a, b in runs if b - a >= 5]
    if spans:
        return "标注区间外持续高能量，待听辨 " + "、".join(f"{a * hop / fs:.2f}–{b * hop / fs:.2f}s" for a, b in spans)
    return ""


def record(source, path, task, phones, issue, *, from_take=False):
    symbol = voqs_symbol(task, path)
    voqs = bool(symbol or task['group'].startswith('15-'))
    title = f"{symbol} · {VOQS_TYPES[symbol][0]}" if symbol in VOQS_TYPES else task["title"]
    return {"id": f"{source}-{task['id']}", "title": title, "prompt": title if voqs else task["prompt"],
            "group": task["group"], "file": path.name, "source": source, "exists": path.is_file() or from_take, "from_take": from_take,
            "excluded": bool(EXCLUDED.search(path.stem)), "phones": [] if voqs else phones, "issue": issue,
            "voqs": voqs, "voqs_symbol": symbol,
            "voqs_intervals": [{"start_s": p["start_s"], "end_s": p["end_s"]} for p in phones] if voqs else []}


def atomic_json(path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


def build_default_poses(records):
    poses = []
    for item in records:
        target = CACHE / f"{item['id']}.json"
        if not item["exists"] or item["excluded"] or item.get("voqs") or not target.is_file():
            continue
        name = re.match(r"\[([^]]+)\]", item["title"])
        if name and not item["group"].startswith("15-"):
            symbol = name.group(1) if "元音" in item["group"] else name.group(1).removesuffix("a")
        else:
            symbol = item["phones"][0]["label"] if item["phones"] else ""
        labeled = [p for p in item["phones"] if p["label"] == symbol]
        if not symbol or not labeled:
            continue
        picked = labeled[-1]
        time_s = (picked["start_s"] + picked["end_s"]) * .5
        data = json.loads(target.read_text(encoding="utf-8"))
        row = data["m27_50hz_pa"][min(len(data["m27_50hz_pa"]) - 1, round(time_s * 50))]
        frame = min(data["animation"]["frames"], key=lambda frame: abs(frame["t"] - time_s))
        poses.append({"symbol": symbol, "params": [*row[:14], *frame["lm"][6:8], *row[14:17]]})
    atomic_json(CACHE / "poses.json", poses)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index-only", action="store_true")
    parser.add_argument("--refresh-voqs", action="store_true", help="Recompute recorded voice source controls on CPU")
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    records = make_index()
    atomic_json(CACHE / "index.json", records)
    if args.index_only:
        return
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    sys.path.insert(0, str(ROOT / "engine"))
    from m27_bridge import M27Bridge

    bridge = M27Bridge()
    errors = {}
    library = DESKTOP / "国际音标"
    eligible = [r for r in records if r["exists"] and not r["excluded"]]
    (CACHE / "voqs").mkdir(exist_ok=True)
    for i, item in enumerate(eligible, 1):
        voice_source = item.get("voqs")
        target = (CACHE / "voqs" if voice_source else CACHE) / f"{item['id']}.json"
        source = (CACHE / "microphone" / f"{item['id']}.wav" if item["from_take"]
                  else library / ("IPA" if item["source"] == "main" else "补充") / item["file"])
        if target.is_file() and target.stat().st_mtime >= source.stat().st_mtime and not (voice_source and args.refresh_voqs):
            continue
        try:
            data = bridge.reconstruct({"filename": source.name, "device": "cpu", "synth_mode": "glottis" if voice_source else "animation",
                                       "fps": 25, "wav_base64": base64.b64encode(source.read_bytes()).decode("ascii")})
            if voice_source and data.get("glottis_50hz_pa"):
                atomic_json(target, {"glottis_50hz_pa": data["glottis_50hz_pa"]})
            elif data.get("ok") and data.get("tract_glottis_anim", {}).get("frames"):
                atomic_json(target, {"m27_50hz_pa": data["m27_50hz_pa"], "animation": data["tract_glottis_anim"]})
            else:
                raise RuntimeError(data.get("error", "空白动画轨迹"))
            print(f"{i}/{len(eligible)} {item['id']} {data['wall_seconds']}s", flush=True)
        except Exception as exc:
            errors[item["id"]] = str(exc)
            atomic_json(CACHE / "errors.json", errors)
            print(f"{i}/{len(eligible)} {item['id']} {type(exc).__name__}: {exc}", flush=True)
            if len(errors) == i and i >= 3:
                raise RuntimeError("前三条重建均失败，停止批处理") from exc
    atomic_json(CACHE / "errors.json", errors)
    build_default_poses(records)
    make_voqs_library(records, CACHE, library, ROOT)
    report = ROOT / "docs" / "ipa-reference-inventory.csv"
    with report.open("w", encoding="utf-8-sig", newline="") as out:
        writer = csv.writer(out)
        writer.writerow(["编号", "任务", "分组", "文件名", "录音状态", "重建状态", "原标注区间（秒）", "待复核项"])
        for item in records:
            voice_source = item.get("voqs")
            anim = (CACHE / f"{item['id']}.json").is_file() and not voice_source
            glottis = (CACHE / "voqs" / f"{item['id']}.json").is_file() and voice_source
            writer.writerow([item["id"], item["title"], item["group"], item["file"],
                             "录音工程已选麦克风轨" if item["from_take"] else "有导出录音" if item["exists"] else "缺少录音",
                             "仅声门" if glottis else "已生成" if anim else "已排除" if item["excluded"] else "未生成",
                             " / ".join(f"{p['label']} {p['start_s']:.3f}–{p['end_s']:.3f}" for p in item["phones"]), item["issue"]])


if __name__ == "__main__":
    main()
