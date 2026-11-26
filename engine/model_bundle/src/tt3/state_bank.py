"""Build the JD2 + M10 R21 vowel & consonant articulatory state bank (inspired by Krug et al., 2023)."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple
import xml.etree.ElementTree as ET

import numpy as np
from scipy.signal import find_peaks
from scipy.spatial import ConvexHull

from .constants import (
    M22_MAX,
    M22_MIN,
    STATES_DEFAULT_PATH,
    SUPRAGLOTTAL_17_NAMES,
    VTL_NATIVE_DIR,
    ensure_ptb_core_on_path,
    tract17_to_19,
    tract19_to_17,
)

ensure_ptb_core_on_path()
from phonetic_core.vocal_tract.engine import Engine, check, dp  # noqa: E402
from phonetic_core.vocal_tract.jd2_starters import JD2_STARTERS  # noqa: E402


TRACT17_MIN = M22_MIN[:17].astype(np.float64)
TRACT17_MAX = M22_MAX[:17].astype(np.float64)

# 发音部位关键器官索引（在 17 维 SUPRAGLOTTAL_17_NAMES 中的下标）
# 0:HX, 1:HY, 2:JX, 3:JA, 4:LP, 5:LD, 6:VS, 7:VO,
# 8:TCX, 9:TCY, 10:TTX, 11:TTY, 12:TBX, 13:TBY, 14:TS1, 15:TS2, 16:TS3
IDX_LD = 5
IDX_VO = 7
IDX_TCX, IDX_TCY = 8, 9
IDX_TTX, IDX_TTY = 10, 11
IDX_TBX, IDX_TBY = 12, 13
IDX_TS1, IDX_TS2, IDX_TS3 = 14, 15, 16


@dataclass
class StateBank:
    vowels: np.ndarray            # (Nv, 17) float32
    vowel_f1_f2: np.ndarray       # (Nv, 2) float32
    closures: np.ndarray          # (Nc, 17) float32
    closure_poa: np.ndarray       # (Nc,) str ("labial", "dental", "alveolar", "retroflex", "palatal", "velar")
    fricatives: np.ndarray        # (Nf, 17) float32
    fricative_poa: np.ndarray     # (Nf,) str
    laterals: np.ndarray          # (Nl, 17) float32
    approximants: np.ndarray      # (Na, 17) float32


def _extract_r1_r2(engine: Engine, tract19: np.ndarray) -> Tuple[float, float] | None:
    """用 VTL 传递函数提取前两共振峰 (fR1, fR2)。"""
    n = 2048
    mag = np.empty(n, dtype=np.float64)
    phase = np.empty(n, dtype=np.float64)
    check(engine.geom.p2_transfer(n, dp(mag), dp(phase)))
    top = round(4000 * n / engine.sr)
    db = 20.0 * np.log10(np.maximum(mag[:top], 1e-12))
    idx, _ = find_peaks(db, prominence=1.5, distance=4)
    freqs = idx * engine.sr / n
    freqs = freqs[(freqs > 150.0) & (freqs < 3800.0)]
    if len(freqs) < 2:
        return None
    return float(freqs[0]), float(freqs[1])


def _clamp17(p17: np.ndarray) -> np.ndarray:
    return np.clip(np.asarray(p17, dtype=np.float64), TRACT17_MIN, TRACT17_MAX)


def _to_valid_19(engine: Engine, p17: np.ndarray) -> np.ndarray:
    return engine.validated(tract17_to_19(_clamp17(p17)))


def explore_vowels(
    engine: Engine,
    rng: np.random.Generator,
    n_random: int = 8000,
    hull_rounds: int = 5,
) -> Tuple[np.ndarray, np.ndarray]:
    """按 Krug 2023 §2 进行随机开声道探索并做多轮凸包剥离，合并 JD2 元音预设。"""
    sampled_17: List[np.ndarray] = []
    sampled_f12: List[Tuple[float, float]] = []

    # 元音探索固定 VO=-0.1（闭合鼻咽口），侧缘 TS1/TS2/TS3 留在正常范围
    lo = TRACT17_MIN.copy()
    hi = TRACT17_MAX.copy()
    lo[IDX_VO], hi[IDX_VO] = -0.1, -0.1
    lo[IDX_LD], hi[IDX_LD] = 0.05, 2.2
    lo[IDX_TS1], hi[IDX_TS1] = 0.0, 0.35
    lo[IDX_TS2], hi[IDX_TS2] = 0.0, 0.25
    lo[IDX_TS3], hi[IDX_TS3] = 0.0, 0.25

    for _ in range(n_random):
        p17 = rng.uniform(lo, hi)
        p19 = _to_valid_19(engine, p17)
        try:
            tube = engine.prepare_tube(p19)
        except RuntimeError:
            continue
        # 开声道判断（避开假声带/入口最末段可能偏差，检查主声管 min >= 0.25 cm^2）
        if float(tube["areas"].min()) < 0.25:
            continue
        f12 = _extract_r1_r2(engine, p19)
        if f12 is None:
            continue
        r1, r2 = f12
        if not (200.0 <= r1 <= 1100.0 and 500.0 <= r2 <= 3000.0 and r2 > r1 + 120.0):
            continue
        sampled_17.append(tract19_to_17(p19).astype(np.float64))
        sampled_f12.append((r1, r2))

    # 多轮二维凸包剥离，优先提取角落与边界元音
    selected_17: List[np.ndarray] = []
    selected_f12: List[Tuple[float, float]] = []
    if len(sampled_17) >= 10:
        pts = np.asarray(sampled_f12, dtype=np.float64)
        remaining = np.arange(len(sampled_17))
        for _ in range(hull_rounds):
            if len(remaining) < 4:
                break
            try:
                hull = ConvexHull(pts[remaining])
            except Exception:
                break
            v_idx = remaining[hull.vertices]
            for idx in v_idx:
                selected_17.append(sampled_17[int(idx)])
                selected_f12.append(sampled_f12[int(idx)])
            keep_mask = np.ones(len(remaining), dtype=bool)
            keep_mask[hull.vertices] = False
            remaining = remaining[keep_mask]

        # 再从内部均匀补充少量内部元音，保证连续覆盖
        if len(remaining) > 0:
            n_inner = min(30, len(remaining))
            pick = rng.choice(remaining, size=n_inner, replace=False)
            for idx in pick:
                selected_17.append(sampled_17[int(idx)])
                selected_f12.append(sampled_f12[int(idx)])

    # 并入 JD2.speaker 内置标准元音 & JD2_STARTERS 扩展 IPA 元音
    speaker_vowels = ("a", "e", "i", "o", "u", "E:", "2", "y", "I", "E", "O", "U", "9", "Y", "@", "6_mid", "6_low")
    for name in speaker_vowels:
        try:
            p19 = engine.validated(engine.preset(name))
            tube = engine.prepare_tube(p19)
            f12 = _extract_r1_r2(engine, p19) or (500.0, 1500.0)
            selected_17.append(tract19_to_17(p19).astype(np.float64))
            selected_f12.append(f12)
        except RuntimeError:
            pass

    ipa_vowels = ("ɨ", "ʉ", "ɯ", "ɪ", "ʏ", "ʊ", "ɘ", "ɵ", "ɤ", "ə", "œ", "ɜ", "ɞ", "ʌ", "ɔ", "æ", "ɐ", "ɶ", "ɑ", "ɒ")
    for sym in ipa_vowels:
        entry = JD2_STARTERS.get(sym)
        if entry is None:
            continue
        p19 = _to_valid_19(engine, tract19_to_17(np.asarray(entry["params"])))
        try:
            engine.prepare_tube(p19)
            f12 = _extract_r1_r2(engine, p19) or (500.0, 1500.0)
            selected_17.append(tract19_to_17(p19).astype(np.float64))
            selected_f12.append(f12)
        except RuntimeError:
            pass

    arr_17 = np.unique(np.round(np.asarray(selected_17, dtype=np.float32), 4), axis=0)
    # 重新按去重后索引收集 F1/F2
    final_f12: List[Tuple[float, float]] = []
    for row in arr_17:
        p19 = _to_valid_19(engine, row)
        engine.prepare_tube(p19)
        final_f12.append(_extract_r1_r2(engine, p19) or (500.0, 1500.0))

    return arr_17.astype(np.float32), np.asarray(final_f12, dtype=np.float32)


# 关键部位对应的主要控制器官下标（在 17 维中）和目标管区（50 段中的索引范围）
POA_SPECS: Dict[str, dict] = {
    "labial": {
        "anchors": ["ll-labial-closure(a)", "ll-labial-closure(i)", "ll-labial-closure(u)", "p", "b", "m"],
        "primary_idx": [2, 3, 4, 5],  # JX, JA, LP, LD
        "sec_range": (44, 50),
        "mode": "closure",
    },
    "dental": {
        "anchors": ["t̪", "d̪", "n̪"],
        "primary_idx": [3, 10, 11, 12, 13, 16],  # JA, TTX, TTY, TBX, TBY, TS3
        "sec_range": (40, 48),
        "mode": "closure",
    },
    "alveolar": {
        "anchors": ["tt-alveolar-closure(a)", "tt-alveolar-closure(i)", "tt-alveolar-closure(u)", "d", "t̠"],
        "primary_idx": [3, 10, 11, 12, 13, 16],
        "sec_range": (35, 46),
        "mode": "closure",
    },
    "retroflex": {
        "anchors": ["tt-postalveolar-closure(a)", "tt-postalveolar-closure(i)", "tt-postalveolar-closure(u)", "ʈ", "ɖ"],
        "primary_idx": [3, 8, 9, 10, 11, 12, 13, 16],
        "sec_range": (31, 42),
        "mode": "closure",
    },
    "palatal": {
        "anchors": ["c", "ɟ", "t͡ɕ"],
        "primary_idx": [3, 8, 9, 10, 11, 12, 13, 15, 16],
        "sec_range": (28, 39),
        "mode": "closure",
    },
    "velar": {
        "anchors": ["tb-velar-closure(a)", "tb-velar-closure(i)", "tb-velar-closure(u)", "k", "ɡ"],
        "primary_idx": [3, 8, 9, 12, 13, 14, 15],  # JA, TCX, TCY, TBX, TBY, TS1, TS2
        "sec_range": (20, 34),
        "mode": "closure",
    },
}


def _preset_or_starter_17(engine: Engine, name: str) -> np.ndarray | None:
    if name in JD2_STARTERS:
        return _clamp17(tract19_to_17(np.asarray(JD2_STARTERS[name]["params"])))
    try:
        return _clamp17(tract19_to_17(engine.preset(name)))
    except RuntimeError:
        return None


def _measure_constriction(engine: Engine, p17: np.ndarray, sec_range: Tuple[int, int]) -> Tuple[float, float]:
    """返回 (目标区最小截面积, 非目标区最小截面积)。"""
    p19 = _to_valid_19(engine, p17)
    tube = engine.prepare_tube(p19)
    areas = tube["areas"]
    lo, hi = sec_range
    target_min = float(areas[lo:hi].min())
    outside_mask = np.ones(len(areas), dtype=bool)
    outside_mask[max(0, lo - 3):min(len(areas), hi + 3)] = False
    # 排除声门最末端 0..4 段天然较小区域
    outside_mask[:6] = False
    outside_min = float(areas[outside_mask].min()) if outside_mask.any() else 1.0
    return target_min, outside_min


def _coarticulate_closure(
    engine: Engine,
    vowel17: np.ndarray,
    anchor17: np.ndarray,
    primary_idx: List[int],
    sec_range: Tuple[int, int],
    rng: np.random.Generator,
) -> np.ndarray | None:
    """在保持元音背景的前提下，将关键构音器官逼近闭合状态，确保目标区闭塞且其他区开放。"""
    # 构造混合方向：主器官权重 1.0，次要器官尽量留在元音附近（0.25）
    w = np.full(17, 0.25, dtype=np.float64)
    w[primary_idx] = 1.0
    w[IDX_VO] = 0.0  # 暂闭鼻咽口（合成时按需打开 VO 生成鼻音）

    # 尝试从元音向目标做平滑混合，取刚形成严格闭合的最小混合度，再小幅扰动找最贴近元音的闭合
    best = None
    for alpha in np.linspace(0.55, 1.0, 10):
        cand = _clamp17(vowel17 + alpha * w * (anchor17 - vowel17))
        cand[IDX_VO] = -0.1
        try:
            tmin, omin = _measure_constriction(engine, cand, sec_range)
        except RuntimeError:
            continue
        if tmin <= 0.015 and omin >= 0.08:
            best = cand
            break

    if best is None:
        return None

    # 局部随机微调：尽量收窄到 <= 0.01 cm^2 同时减小与元音距离
    cur = best.copy()
    cur_tmin, _ = _measure_constriction(engine, cur, sec_range)
    for _ in range(25):
        trial = cur.copy()
        delta = rng.normal(0.0, 0.12, size=len(primary_idx))
        trial[primary_idx] += delta
        trial = _clamp17(trial)
        trial[IDX_VO] = -0.1
        try:
            tmin, omin = _measure_constriction(engine, trial, sec_range)
        except RuntimeError:
            continue
        if tmin <= max(0.008, cur_tmin) and omin >= 0.10:
            # 偏好目标区更闭塞或整体更接近元音
            if tmin < cur_tmin - 1e-4 or np.linalg.norm(trial - vowel17) < np.linalg.norm(cur - vowel17):
                cur = trial
                cur_tmin = tmin
    return cur.astype(np.float32)


def generate_consonants(
    engine: Engine,
    vowels17: np.ndarray,
    rng: np.random.Generator,
    n_vowel_contexts: int = 24,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """生成闭塞音、擦音、边音、近音四类状态库（整合原生/普通话IPA起始音与协同发音变体）。"""
    closures: List[np.ndarray] = []
    closure_poa: List[str] = []
    fricatives: List[np.ndarray] = []
    fricative_poa: List[str] = []
    laterals: List[np.ndarray] = []
    approximants: List[np.ndarray] = []

    # 1. 纳入 JD2.speaker 全部辅音与 JD2_STARTERS 中文及扩展辅音
    speaker_fric = [
        ("ll-dental-fricative", "labiodental"),
        ("tt-dental-fricative", "dental"),
        ("tt-alveolar-fricative", "alveolar"),
        ("tt-postalveolar-fricative", "retroflex"),
        ("tb-palatal-fricative", "palatal"),
        ("tb-uvular-fricative", "uvular"),
    ]
    for base, poa in speaker_fric:
        for ctx in ("a", "i", "u"):
            p = _preset_or_starter_17(engine, f"{base}({ctx})")
            if p is not None:
                fricatives.append(p)
                fricative_poa.append(poa)

    for ctx in ("a", "i", "u"):
        for base in ("tt-alveolar-lateral", "tt-postalveolar-lateral"):
            p = _preset_or_starter_17(engine, f"{base}({ctx})")
            if p is not None:
                laterals.append(p)

    # 中文和常用 IPA 辅音映射
    starter_fric_map = [
        ("f", "labiodental"), ("v", "labiodental"), ("ɸ", "labial"), ("β", "labial"),
        ("θ", "dental"), ("ð", "dental"), ("s", "alveolar"), ("z", "alveolar"),
        ("ʃ", "postalveolar"), ("ʒ", "postalveolar"), ("ʂ", "retroflex"), ("ʐ", "retroflex"),
        ("ɕ", "alveolopalatal"), ("ʑ", "alveolopalatal"), ("ç", "palatal"), ("ʝ", "palatal"),
        ("x", "velar"), ("ɣ", "velar"), ("h", "glottal"), ("ɦ", "glottal"),
    ]
    for sym, poa in starter_fric_map:
        p = _preset_or_starter_17(engine, sym)
        if p is not None:
            fricatives.append(p)
            fricative_poa.append(poa)

    for sym in ("l̪", "l̠", "ɭ", "ʎ", "ʟ"):
        p = _preset_or_starter_17(engine, sym)
        if p is not None:
            laterals.append(p)

    for sym in ("w", "j", "ɥ", "ɹ", "ɻ", "ʋ", "ɰ"):
        p = _preset_or_starter_17(engine, sym)
        if p is not None:
            approximants.append(p)

    # 2. 闭塞音（原生 + 中文关键部位 + 协同发音搜索）
    starter_closures = [
        ("p", "labial"), ("t̪", "dental"), ("t̠", "alveolar"), ("d", "alveolar"),
        ("ʈ", "retroflex"), ("t͡ɕ", "palatal"), ("c", "palatal"), ("k", "velar"),
    ]
    for sym, poa in starter_closures:
        p = _preset_or_starter_17(engine, sym)
        if p is not None:
            closures.append(p)
            closure_poa.append(poa)

    # 抽代表性元音背景做协同发音闭塞生成
    n_ctx = min(n_vowel_contexts, len(vowels17))
    ctx_indices = rng.choice(len(vowels17), size=n_ctx, replace=False) if n_ctx < len(vowels17) else np.arange(len(vowels17))
    for poa, spec in POA_SPECS.items():
        anchor_list = [a for a in (_preset_or_starter_17(engine, name) for name in spec["anchors"]) if a is not None]
        if not anchor_list:
            continue
        for c_idx in ctx_indices:
            v17 = vowels17[int(c_idx)].astype(np.float64)
            anchor17 = anchor_list[int(rng.integers(0, len(anchor_list)))]
            res = _coarticulate_closure(
                engine, v17, anchor17, spec["primary_idx"], spec["sec_range"], rng
            )
            if res is not None:
                closures.append(res)
                closure_poa.append(poa)
                # 同时按 Krug 2023 §2：对部分前舌/后舌协同发音点派生对应的协同发音擦音与边音变体
                if poa in ("dental", "alveolar", "retroflex"):
                    fric = res.copy()
                    fric[IDX_TS3] = float(rng.uniform(0.28, 0.75))
                    fric[IDX_TTY] = max(TRACT17_MIN[IDX_TTY], fric[IDX_TTY] - float(rng.uniform(0.05, 0.30)))
                    fricatives.append(fric)
                    fricative_poa.append(poa)

                    lat = res.copy()
                    lat[IDX_TS3] = float(rng.uniform(-0.85, -0.45))
                    laterals.append(lat)
                elif poa in ("palatal", "velar"):
                    fric = res.copy()
                    fric[IDX_TS2] = float(rng.uniform(0.30, 0.85))
                    fric[IDX_TCY] = max(TRACT17_MIN[IDX_TCY], fric[IDX_TCY] - float(rng.uniform(0.05, 0.25)))
                    fricatives.append(fric)
                    fricative_poa.append(poa)

    return (
        np.asarray(closures, dtype=np.float32),
        np.asarray(closure_poa),
        np.asarray(fricatives, dtype=np.float32),
        np.asarray(fricative_poa),
        np.asarray(laterals, dtype=np.float32),
        np.asarray(approximants, dtype=np.float32),
    )


def build_state_bank(
    out_path: Path = STATES_DEFAULT_PATH,
    *,
    n_random_vowels: int = 8000,
    n_vowel_contexts: int = 24,
    seed: int = 42,
) -> Dict[str, object]:
    """构建并保存状态库到 .npz 文件，返回摘要统计。"""
    rng = np.random.default_rng(seed)
    engine = Engine("JD2", resource_dir=VTL_NATIVE_DIR)
    try:
        engine.set_section_count(65)
        engine.set_manual_root(False)

        vowels17, vowel_f12 = explore_vowels(engine, rng, n_random=n_random_vowels)
        closures, closure_poa, fricatives, fric_poa, laterals, approximants = generate_consonants(
            engine, vowels17, rng, n_vowel_contexts=n_vowel_contexts
        )

        out_path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(
            out_path,
            tract17_names=np.asarray(SUPRAGLOTTAL_17_NAMES),
            vowels=vowels17,
            vowel_f1_f2=vowel_f12,
            closures=closures,
            closure_poa=closure_poa,
            fricatives=fricatives,
            fricative_poa=fric_poa,
            laterals=laterals,
            approximants=approximants,
        )

        return {
            "out_path": str(out_path),
            "num_vowels": int(len(vowels17)),
            "f1_range": [float(vowel_f12[:, 0].min()), float(vowel_f12[:, 0].max())],
            "f2_range": [float(vowel_f12[:, 1].min()), float(vowel_f12[:, 1].max())],
            "num_closures": int(len(closures)),
            "closure_poa_counts": {str(k): int(np.sum(closure_poa == k)) for k in np.unique(closure_poa)},
            "num_fricatives": int(len(fricatives)),
            "num_laterals": int(len(laterals)),
            "num_approximants": int(len(approximants)),
        }
    finally:
        engine.close()
