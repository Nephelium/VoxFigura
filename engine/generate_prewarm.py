"""Generate real VTL 2.4 prewarmed MP3 + physics JSON into public/prewarm/.

Covers:
  1. 5 Explore Lab featured cases (suan_vs_swan, khoomei_overtone,
     creaky_vs_breathy, cantonese_checked, voqs_quality)
  2. Jasmine Flower ("好一朵美丽的茉莉花") first singing phrase (jasmine_phrase1)
  3. Speaker metadata snapshots (meta_JD2.json, meta_W02.json) & index.json

Archival WAVs are written under `assets/source-audio/prewarm/`.
"""
from __future__ import annotations

import base64
from functools import partial
import json
import os
from pathlib import Path
import shutil
import sys
from tempfile import TemporaryDirectory
from typing import Any, Dict, List

import numpy as np

ENGINE_DIR = Path(__file__).resolve().parent
REPO_ROOT = ENGINE_DIR.parent
PREWARM_DIR = REPO_ROOT / "public" / "prewarm"
SOURCE_AUDIO_DIR = REPO_ROOT / "assets" / "source-audio" / "prewarm"

if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from dense_channel import DenseEngineManager  # noqa: E402


def _interp_tract_keyframes(keyframes: List[tuple[float, np.ndarray]], n_frames: int, step_hz: int = 200) -> List[List[float]]:
    dur_s = n_frames / float(step_hz)
    t_grid = np.linspace(0.0, dur_s, n_frames, endpoint=False)
    times = np.array([kf[0] * dur_s for kf in keyframes], dtype=np.float64)
    mat = np.stack([kf[1] for kf in keyframes], axis=0)
    out = np.empty((n_frames, 19), dtype=np.float64)
    for d in range(19):
        out[:, d] = np.interp(t_grid, times, mat[:, d])
    return out.round(5).tolist()


def _save_case(manager: DenseEngineManager, case_id: str, title: str, payload: Dict[str, Any], *, glottis_only: bool = False) -> Dict[str, Any]:
    if glottis_only and case_id not in {"suan_mandarin", "jasmine_phrase1", "cantonese_checked"}:
        return {}
    res = manager.synthesize_dense(payload)
    if not res.get("ok"):
        raise RuntimeError(f"Prewarm case {case_id} failed: {res}")
    wav_bytes = base64.b64decode(res.pop("wav_base64"))
    wav_path = SOURCE_AUDIO_DIR / f"{case_id}.wav"
    if glottis_only:
        json_path = PREWARM_DIR / f"{case_id}.json"
        stored = json.loads(json_path.read_text(encoding="utf-8"))
        if wav_bytes != wav_path.read_bytes():
            raise RuntimeError(f"{case_id} regenerated WAV differs; cannot attach glottis controls to the original")
        if [frame['t_s'] for frame in stored["geometry_frames"]] != [frame['t_s'] for frame in res["geometry_frames"]]:
            raise RuntimeError(f"{case_id} frame clocks differ")
        for original, frame in zip(stored["geometry_frames"], res["geometry_frames"]):
            original["glottis"] = frame["glottis"]
        json_path.write_text(json.dumps(stored, ensure_ascii=False), encoding="utf-8")
        print(f"Added {case_id} native glottis controls ({len(stored['geometry_frames'])} frames, WAV unchanged)")
        return {}
    ffmpeg = shutil.which(os.environ.get("VOCALCUT_FFMPEG", "ffmpeg"))
    if ffmpeg is None:
        raise RuntimeError("FFmpeg with libmp3lame is needed to regenerate prewarm audio")
    from scripts.portable.encode_references import encode_mp3

    SOURCE_AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".encode-", dir=SOURCE_AUDIO_DIR) as directory:
        source = Path(directory) / wav_path.name
        source.write_bytes(wav_bytes)
        encoded = source.with_suffix(".mp3")
        encode_mp3(source, encoded, Path(ffmpeg))
        source.replace(wav_path)
        encoded.replace(PREWARM_DIR / encoded.name)

    res["case_id"] = case_id
    res["title"] = title
    res["wav_url"] = f"/prewarm/{case_id}.mp3"
    json_path = PREWARM_DIR / f"{case_id}.json"
    json_path.write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
    return {
        "case_id": case_id,
        "title": title,
        "speaker": res["speaker"],
        "duration_s": res["duration_s"],
        "wav_url": res["wav_url"],
        "json_url": f"/prewarm/{case_id}.json",
    }


def main(glottis_only: bool = False) -> None:
    PREWARM_DIR.mkdir(parents=True, exist_ok=True)
    manager = DenseEngineManager()
    save_case = partial(_save_case, glottis_only=glottis_only)
    eng_jd2, _ = manager.get_engine("JD2")
    eng_w02, _ = manager.get_engine("W02")

    # Save speaker metadata for offline fallback
    for spk in (() if glottis_only else ("JD2", "W02")):
        meta = manager.metadata(spk)
        (PREWARM_DIR / f"meta_{spk}.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

    # Helper to grab validated poses
    p_s = eng_jd2.preset("tt-alveolar-fricative(a)")
    p_s[eng_jd2.names.index("TS3")] = 0.32
    p_u = eng_jd2.preset("u")
    p_a = eng_jd2.preset("a")
    p_o = eng_jd2.preset("o")
    p_i = eng_jd2.preset("i")
    p_n = eng_jd2.preset("tt-alveolar-closure(a)")
    p_n[eng_jd2.names.index("VO")] = 0.5
    p_t = eng_jd2.preset("tt-alveolar-closure(a)")

    step_hz = 200
    entries: List[Dict[str, Any]] = []

    # 1a. "算" [swan51] (Mandarin rounded glide + front/mid open + falling 51 tone)
    n1 = int(0.85 * step_hz)
    p_swan_a = p_a.copy()
    p_swan_a[eng_jd2.names.index("LP")] = -0.15
    p_swan_a[eng_jd2.names.index("TCX")] = 0.45
    f0_51 = np.linspace(175.0, 96.0, n1).round(2).tolist()
    pr_1 = [0.0 if i < 6 else (820.0 if i < n1 - 12 else 300.0) for i in range(n1)]
    entries.append(
        save_case(
            manager,
            "suan_mandarin",
            "汉语「算」 [swan⁵¹]",
            {
                "speaker": "JD2",
                "step_hz": step_hz,
                "fps": 30,
                "f0_hz": f0_51,
                "pressure_pa": pr_1,
                "tract_frames": _interp_tract_keyframes(
                    [(0.0, p_s), (0.22, p_s), (0.38, p_u), (0.65, p_swan_a), (1.0, p_n)],
                    n1,
                    step_hz,
                ),
            },
        )
    )

    # 1b. "swan" [swɒn] (English retracted back rounded vowel + lower F0 contour)
    p_swan_en = p_o.copy()
    p_swan_en[eng_jd2.names.index("TCX")] = -1.1
    p_swan_en[eng_jd2.names.index("TCY")] = -1.6
    p_swan_en[eng_jd2.names.index("LP")] = 0.35
    p_swan_en[eng_jd2.names.index("LD")] = 0.55
    f0_en = np.linspace(142.0, 110.0, n1).round(2).tolist()
    entries.append(
        save_case(
            manager,
            "swan_english",
            "英语「swan」 [swɒn]",
            {
                "speaker": "JD2",
                "step_hz": step_hz,
                "fps": 30,
                "f0_hz": f0_en,
                "pressure_pa": pr_1,
                "tract_frames": _interp_tract_keyframes(
                    [(0.0, p_s), (0.22, p_s), (0.38, p_u), (0.68, p_swan_en), (1.0, p_n)],
                    n1,
                    step_hz,
                ),
            },
        )
    )

    # 2. 呼麦双峰共振调谐 (Khoomei overtone formant sweep on drone F0=120 Hz)
    n2 = int(1.6 * step_hz)
    p_kh1 = p_a.copy()
    p_kh1[eng_jd2.names.index("TTX")] = 4.2
    p_kh1[eng_jd2.names.index("TTY")] = 0.8
    p_kh2 = p_i.copy()
    p_kh2[eng_jd2.names.index("TTX")] = 4.8
    p_kh2[eng_jd2.names.index("TTY")] = 1.4
    p_kh2[eng_jd2.names.index("LP")] = 0.2
    entries.append(
        save_case(
            manager,
            "overtone_khoomei",
            "呼麦双峰共振调谐",
            {
                "speaker": "JD2",
                "step_hz": step_hz,
                "fps": 30,
                "f0_hz": [120.0] * n2,
                "pressure_pa": [950.0] * n2,
                "tract_frames": _interp_tract_keyframes(
                    [(0.0, p_kh1), (0.5, p_kh2), (1.0, p_kh1)],
                    n2,
                    step_hz,
                ),
            },
        )
    )

    # 3. 嘎裂与气声 (Creaky -> Modal -> Breathy 10-D m27 glottis morph)
    n3 = int(1.5 * step_hz)
    glottis_3: List[List[float]] = []
    f0_3: List[float] = []
    pr_3: List[float] = []
    for i in range(n3):
        u = i / float(max(1, n3 - 1))
        if u < 0.5:
            a = u * 2.0
            # creaky -> modal
            f0_3.append(round(68.0 + (125.0 - 68.0) * a, 2))
            pr_3.append(round(520.0 + (800.0 - 520.0) * a, 2))
            glottis_3.append([
                -0.008 + (0.04 - -0.008) * a,
                -0.008 + (0.04 - -0.008) * a,
                0.0 + 0.02 * a,
                1.95 + (1.222 - 1.95) * a,
                0.92 + (1.0 - 0.92) * a,
                0.88 + (0.5 - 0.88) * a,
                80.0 + (20.0 - 80.0) * a,
            ])
        else:
            a = (u - 0.5) * 2.0
            # modal -> breathy
            f0_3.append(125.0)
            pr_3.append(round(800.0 + (750.0 - 800.0) * a, 2))
            glottis_3.append([
                0.04 + (0.075 - 0.04) * a,
                0.04 + (0.08 - 0.04) * a,
                0.02 + (0.085 - 0.02) * a,
                1.222 + (0.75 - 1.222) * a,
                1.0 + (0.85 - 1.0) * a,
                0.5 + (-0.25 - 0.5) * a,
                20.0 + (25.0 - 20.0) * a,
            ])
    entries.append(
        save_case(
            manager,
            "creaky_vs_breathy",
            "嘎裂声 ↔ 常态 ↔ 气声",
            {
                "speaker": "JD2",
                "step_hz": step_hz,
                "fps": 30,
                "f0_hz": f0_3,
                "pressure_pa": pr_3,
                "tract_frames": [p_a.round(5).tolist()] * n3,
                "glottis_frames": glottis_3,
            },
        )
    )

    # 4. 湾区粤语入声 -t 不除阻 [sat5]
    n4 = int(0.55 * step_hz)
    pr_4 = [0.0 if i < 6 else (860.0 if i < int(n4 * 0.72) else 120.0) for i in range(n4)]
    entries.append(
        save_case(
            manager,
            "cantonese_checked",
            "湾区粤语入声 [sɐt̚⁵]",
            {
                "speaker": "JD2",
                "step_hz": step_hz,
                "fps": 30,
                "f0_hz": [165.0] * n4,
                "pressure_pa": pr_4,
                "tract_frames": _interp_tract_keyframes(
                    [(0.0, p_s), (0.28, p_s), (0.45, p_a), (0.72, p_a), (0.82, p_t), (1.0, p_t)],
                    n4,
                    step_hz,
                ),
            },
        )
    )

    # 5. VoQS 音质符号 (Modal -> Pressed -> Falsetto)
    n5 = int(1.5 * step_hz)
    glottis_5: List[List[float]] = []
    f0_5: List[float] = []
    pr_5: List[float] = []
    for i in range(n5):
        u = i / float(max(1, n5 - 1))
        if u < 0.5:
            a = u * 2.0
            f0_5.append(round(125.0 + 10.0 * a, 2))
            pr_5.append(round(800.0 + 350.0 * a, 2))
            glottis_5.append([
                0.04 + (-0.015 - 0.04) * a,
                0.04 + (-0.018 - 0.04) * a,
                0.02 * (1.0 - a),
                1.222 + (1.9 - 1.222) * a,
                1.0,
                0.5 + 0.35 * a,
                20.0 - 8.0 * a,
            ])
        else:
            a = (u - 0.5) * 2.0
            f0_5.append(round(135.0 + (320.0 - 135.0) * a, 2))
            pr_5.append(round(1150.0 + (680.0 - 1150.0) * a, 2))
            glottis_5.append([
                -0.015 + (0.055 - -0.015) * a,
                -0.018 + (0.058 - -0.018) * a,
                0.0 + 0.04 * a,
                1.9 + (0.15 - 1.9) * a,
                1.0 + (0.48 - 1.0) * a,
                0.85 + (-0.45 - 0.85) * a,
                12.0 + 8.0 * a,
            ])
    entries.append(
        save_case(
            manager,
            "voqs_quality",
            "VoQS 音质符号对照",
            {
                "speaker": "JD2",
                "step_hz": step_hz,
                "fps": 30,
                "f0_hz": f0_5,
                "pressure_pa": pr_5,
                "tract_frames": [p_a.round(5).tolist()] * n5,
                "glottis_frames": glottis_5,
            },
        )
    )

    # 6. 《茉莉花》首句 ("好一朵美丽的茉莉花", W02 female soprano)
    w_a = eng_w02.preset("a")
    w_o = eng_w02.preset("o")
    w_i = eng_w02.preset("i")
    w_u = eng_w02.preset("u")
    w_e = eng_w02.preset("e")
    # Notes (E4=329.63, E4, G4=392, A4=440, C5=523.25, A4, G4) ~ 2.4 s
    n6 = int(2.4 * step_hz)
    note_f0s = [
        (0.0, 0.35, 329.63, w_a),
        (0.35, 0.65, 329.63, w_i),
        (0.65, 0.95, 392.00, w_o),
        (0.95, 1.25, 440.00, w_e),
        (1.25, 1.60, 523.25, w_i),
        (1.60, 1.95, 440.00, w_i),
        (1.95, 2.40, 392.00, w_a),
    ]
    f0_6: List[float] = []
    pr_6: List[float] = []
    tract_6: List[List[float]] = []
    for k in range(n6):
        t = k / float(step_hz)
        cur_f0 = 329.63
        cur_p = w_a
        for t0, t1, hz, pose in note_f0s:
            if t0 <= t <= t1:
                cur_f0 = hz
                cur_p = pose
                break
        f0_6.append(cur_f0)
        pr_6.append(820.0 if t < 2.28 else 350.0)
        tract_6.append(cur_p.round(5).tolist())
    entries.append(
        save_case(
            manager,
            "jasmine_phrase1",
            "《茉莉花》首句示范（W02 女声）",
            {
                "speaker": "W02",
                "step_hz": step_hz,
                "fps": 30,
                "f0_hz": f0_6,
                "pressure_pa": pr_6,
                "tract_frames": tract_6,
            },
        )
    )

    if glottis_only:
        return
    index_path = PREWARM_DIR / "index.json"
    index_path.write_text(
        json.dumps({"schema": "vocalcut/prewarm-index", "version": 1, "cases": entries}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Generated {len(entries)} prewarm VTL 2.4 cases in {PREWARM_DIR}")


if __name__ == "__main__":
    main(glottis_only="--glottis-only" in sys.argv[1:])
