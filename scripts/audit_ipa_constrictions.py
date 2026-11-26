"""Screen cached M27 trajectories for mismatched JD2 constriction regions."""

import csv
import json
from pathlib import Path
import re
import sys
import unicodedata

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache" / "ipa-references"
REGIONS = ("唇区", "前口腔冠部", "硬腭带", "后腭舌背区", "咽部")
EXPECTED = {
    "labial_palatal": ("唇—硬腭双部位", (0, 2), True),
    "labial_velar": ("唇—软腭双部位", (0, 3), True),
    "velo_pharyngeal": ("软腭—咽双部位", (3, 4), True),
    "alveolo_palatal": ("龈腭", (1, 2), False),
    "labiodental": ("唇齿", (0, 1), False),
    "dentolabial": ("齿唇", (0, 1), True),
    "linguolabial": ("舌唇", (0, 1), True),
    "postalveolar": ("齿龈后", (1, 2), False),
    "bilabial": ("双唇", (0,), False),
    "dental": ("齿", (1,), False),
    "alveolar": ("齿龈", (1,), False),
    "retroflex": ("卷舌", (1, 2), False),
    "palatal": ("硬腭", (1, 2, 3), False),
    "velar": ("软腭", (3,), False),
    "uvular": ("小舌", (3, 4), False),
    "pharyngeal": ("咽", (4,), False),
    "epiglottal": ("会厌", (), True),
    "glottal": ("声门", (), True),
}


def key(text):
    return unicodedata.normalize("NFD", text).translate(str.maketrans({"͜": "", "͡": "", "g": "ɡ", "̊": "̥"}))


def expected_place(item):
    name = Path(item["file"]).stem
    if item["group"].startswith("14-"):
        rank = next((label for token, label in (("front", "前"), ("central", "央"), ("back", "后")) if f"_{token}_" in name), "")
        return f"{rank}元音舌位", (), "元音的最小面积不等同于元音舌位"
    if "发声类型" in item["group"] or name.startswith("vq_"):
        return "声门／喉部发声态", (), "口咽最窄截面不检验发声态"
    for token, (place, regions, uncertain) in EXPECTED.items():
        if f"_{token}_" in f"_{name}_":
            reason = "单条正中气道截面难区分该结构" if uncertain else ""
            if "lateral" in name:
                reason = "边音有正中闭合与侧通道，最小面积不足以确定接触点"
            return place, regions, reason
    return "未从任务确定", (), "录音命名不能给出唯一预期部位"


def target_phones(item):
    phones = item["phones"]
    if item["group"].startswith("14-") or "发声类型" in item["group"] or item["file"].startswith("vq_"):
        return phones
    name = re.match(r"\[([^]]+)\]", item["title"])
    if not name:
        return []
    symbol = key(name.group(1).removesuffix("a"))
    return [p for p in phones if key(p["label"]) == symbol]


def constrain_region(center):
    x, y = center[:2]
    if x >= 5.22:
        return 0
    if x >= 3.85:
        return 1
    if x >= 1.18:
        return 2
    return 4 if y < -1.05 else 3


def sample_geometry(eng, row, expected):
    centers, areas, gaps = eng.constriction_sections({"lip_width": 1.0}, row)
    # Exclude the glottal entrance and the duplicated terminal contour station.
    candidates = [i for i in range(8, len(centers) - 1) if np.isfinite(areas[i]) and -6.9 <= centers[i, 1]]
    if not candidates:
        return None
    best = min(candidates, key=lambda i: (areas[i], gaps[i]))
    region = constrain_region(centers[best])
    in_expected = [i for i in candidates if constrain_region(centers[i]) in expected]
    expected_min = min((areas[i] for i in in_expected), default=np.nan)
    return region, float(areas[best]), float(gaps[best]), centers[best, :3].tolist(), float(expected_min)


def summarize_run(eng, rows, start, end, expected):
    # Skip boundary coarticulation when there are enough frames to keep a central sample.
    span = end - start
    inner_a = start + span * .15 if span >= .1 else start
    inner_b = end - span * .15 if span >= .1 else end
    indices = [i for i in range(len(rows)) if inner_a <= i / 50 < inner_b]
    measurements = [sample_geometry(eng, rows[i], expected) for i in indices]
    measurements = [value for value in measurements if value is not None]
    if not measurements:
        return None
    count = np.bincount([p[0] for p in measurements], minlength=len(REGIONS))
    region = int(np.argmax(count))
    winner = [p for p in measurements if p[0] == region]
    area, gap = np.median([p[1:3] for p in winner], axis=0)
    x, y, s = np.median([p[3] for p in winner], axis=0)
    comparison = [p[4] for p in winner if np.isfinite(p[4])]
    expected_area = np.median(comparison) if comparison else np.nan
    share = count[region] / len(measurements)
    near_edge = min(abs(x - edge) for edge in (1.18, 3.85, 5.22)) <= .22 or x < 1.18 and abs(y + 1.05) <= .22
    stable = len(measurements) >= 3 and share >= .70 and not near_edge
    distinct = area <= .35 and gap <= .60 and np.isfinite(expected_area) and expected_area >= max(.50, area * 2)
    return {"range": (start, end), "n": len(measurements), "region": region, "area": area, "gap": gap, "x": x,
            "y": y, "s": s, "expected_area": expected_area, "share": share, "stable": stable, "distinct": distinct}


def format_run(run):
    start, end = run["range"]
    expected_area = f"{run['expected_area']:.3f}" if np.isfinite(run["expected_area"]) else "—"
    return (f"{start:.3f}–{end:.3f}s {REGIONS[run['region']]} {run['share']:.0%}/{run['n']}帧，"
            f"x={run['x']:.2f} y={run['y']:.2f} 弧长={run['s']:.2f}cm，"
            f"最窄={run['area']:.3f}cm² 正中间隙={run['gap']:.2f}cm 期望区最窄={expected_area}cm²")


def main():
    sys.path.insert(0, str(ROOT / "engine"))
    from dense_channel import DenseEngineManager
    from m27_bridge import _m27_to_tract19

    data = json.loads((CACHE / "index.json").read_text(encoding="utf-8"))
    eng, _ = DenseEngineManager().get_engine("JD2")
    output = ROOT / "docs" / "ipa-constriction-audit.csv"
    report = []
    for item in data:
        path = CACHE / f"{item['id']}.json"
        if item["excluded"] or item.get("voqs") or not item["exists"] or not path.is_file():
            continue
        record = json.loads(path.read_text(encoding="utf-8"))
        rows = _m27_to_tract19(record["m27_50hz_pa"])
        place, regions, reason = expected_place(item)
        intervals = target_phones(item)
        if not intervals:
            reason = "；".join(filter(None, (reason, "无目标音的标注区间，取全录音中央一半作描述")))
            duration = len(rows) / 50
            intervals = [{"start_s": duration * .25, "end_s": duration * .75}]
        runs = [summarize_run(eng, rows, p["start_s"], p["end_s"], regions) for p in intervals]
        runs = [run for run in runs if run is not None]
        if reason or not runs:
            outcome = "待定"
            reason = reason or "目标音区间没有足够的重建帧"
        elif all(run["stable"] and run["region"] in regions and run["area"] <= .70 for run in runs):
            outcome = "与期望粗分区相符"
        elif all(run["stable"] and run["distinct"] and run["region"] not in regions for run in runs):
            outcome = "疑似偏位"
            reason = "所有标注实例的稳定主收窄均在期望粗分区之外，需结合轮廓和听辨复核"
        else:
            outcome = "待定"
            reason = "收窄较弱、靠近分区边界、帧数不足或同一录音内的实例不一致"
        report.append([item["id"], item["title"], item["file"], place, "／".join(REGIONS[i] for i in regions),
                       " | ".join(format_run(r) for r in runs), outcome, reason, item["issue"]])
    with output.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.writer(file)
        writer.writerow(["编号", "录音任务", "文件名", "期望调音部位", "可判定的期望粗分区", "模型主收窄位置与证据", "筛查结果", "判定或不确定原因", "录音和标注备注"])
        writer.writerows(report)
    from collections import Counter
    print(len(report), Counter(row[6] for row in report))


if __name__ == "__main__":
    main()
