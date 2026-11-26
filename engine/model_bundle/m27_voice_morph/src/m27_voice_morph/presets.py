"""Phonation presets, anatomical parameter groups, and user preset persistence for M27 Voice Morph."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np

# Canonical 27-dim M27 layout (matching tt3.m27_contract):
#   0..16 : 17 vocal tract params [HX, HY, JX, JA, LP, LD, VS, VO, TCX, TCY, TTX, TTY, TBX, TBY, TS1, TS2, TS3]
#   17    : F0 (Hz, 40..600, log-normalized)
#   18    : PR (dPa, 0..16000)
#   19..26: 8 glottis/phonation params [XB, XT, CA, LAG, RA, PS, FL, SHIM]
M27_PARAM_NAMES: Tuple[str, ...] = (
    "HX", "HY", "JX", "JA", "LP", "LD", "VS", "VO",
    "TCX", "TCY", "TTX", "TTY", "TBX", "TBY", "TS1", "TS2", "TS3",
    "F0", "PR",
    "XB", "XT", "CA", "LAG", "RA", "PS", "FL", "SHIM",
)

TRACT_INDICES: Tuple[int, ...] = tuple(range(0, 17))
F0_INDEX = 17
PR_INDEX = 18
GLOTTIS8_INDICES: Tuple[int, ...] = tuple(range(19, 27))
SOURCE10_INDICES: Tuple[int, ...] = tuple(range(17, 27))

# Anatomically coherent control groups for two-speaker time-varying transplantation
ORGAN_GROUPS: Dict[str, Dict[str, Any]] = {
    "glottis": {
        "id": "glottis",
        "label": "声门发声类型 (8维)",
        "desc": "XB, XT, CA, LAG, RA, PS, FL, SHIM：决定气声/紧声/嘎裂声/假声等声源谱形态",
        "indices": [19, 20, 21, 22, 23, 24, 25, 26],
        "recommended_delta": False,
        "coupling_note": "高独立性：与声道滤波器天然正交，适合任意混合",
    },
    "f0_pr": {
        "id": "f0_pr",
        "label": "音高与肺压 (F0 + PR)",
        "desc": "基频轮廓与肺下压驱动包络",
        "indices": [17, 18],
        "recommended_delta": False,
        "coupling_note": "高独立性：决定语调起伏与响度强弱",
    },
    "timing": {
        "id": "timing",
        "label": "时长与韵律 (标注对齐)",
        "desc": "逐音节/音素迁移时长与停顿节律（需 A、B 完成文字或音节标注对齐）",
        "indices": [],
        "is_timing": True,
        "requires_alignment": True,
        "recommended_delta": False,
        "coupling_note": "需双人文字或音节标注对齐：0% 保持 A 的节律时长，100% 迁移 B 的时长与停顿韵律",
    },
    "tract_all": {
        "id": "tract_all",
        "label": "整套声道滤波器 (17维)",
        "desc": "全部 17 维口腔/咽腔/唇/软腭/喉位构音轨迹",
        "indices": list(range(0, 17)),
        "recommended_delta": False,
        "coupling_note": "整体替换安全：完整移植第二人的构音方式与口音",
    },
    "lips": {
        "id": "lips",
        "label": "唇部构形 (LP, LD)",
        "desc": "双唇前突与开合度",
        "indices": [4, 5],
        "recommended_delta": False,
        "coupling_note": "较独立：适合移植圆唇/展唇与提前圆唇协同发音",
    },
    "velum": {
        "id": "velum",
        "label": "软腭与鼻化 (VS, VO)",
        "desc": "软腭形状与腭咽口面积",
        "indices": [6, 7],
        "recommended_delta": False,
        "coupling_note": "高独立性：无损控制鼻化程度与软腭早开时机",
    },
    "larynx": {
        "id": "larynx",
        "label": "喉位 / 舌骨 (HX, HY)",
        "desc": "喉头前后与高低位置，改变声道总长与音色明暗",
        "indices": [0, 1],
        "recommended_delta": True,
        "coupling_note": "较独立：建议支持相对偏移以适配个体解剖基准",
    },
    "tongue_jaw": {
        "id": "tongue_jaw",
        "label": "舌颌构音组 (JX, JA, TC, TT, TB, TS)",
        "desc": "下颌与舌体/舌尖/舌叶/舌侧缘联动整体",
        "indices": [2, 3, 8, 9, 10, 11, 12, 13, 14, 15, 16],
        "recommended_delta": True,
        "coupling_note": "强耦合组：整组替换或开启相对偏移可避免舌腭穿模与漏气",
    },
    "speaker": {
        "id": "speaker",
        "label": "说话人音色 (Vox2Spk-Lite)",
        "desc": "512 维静态音色身份，在时间轴上逐帧球面插值",
        "indices": [],
        "is_speaker": True,
        "recommended_delta": False,
        "coupling_note": "仅作用于 Tract2Vox-Lite，用于句内音色过渡",
    },
}

# Physical 9-dim source prototypes [PR(dPa), XB, XT, CA, LAG, RA, PS, FL, SHIM]
# Strictly named per VoQS (2016 中英双语版) and calibrated against the steady-state middle (25%–75%)
# frames of verified high-fidelity VoQS reference recordings (main-T249..T257, supplement-S018..S023).
BUILTIN_PHONATION_PRESETS: Dict[str, Dict[str, Any]] = {
    "modal": {
        "id": "modal",
        "label": "常态浊声 (Modal · V)",
        "desc": "自然均衡的常态浊声（参考 VoQS V 稳定段）",
        "source9_phys": [8200.0, 0.034, 0.039, 0.013, 1.38, 0.86, 0.47, 19.7, 6.7],
        "f0_shift_semitones": 0.0,
        "default_f0_coupling": False,
        "is_voiceless_target": False,
        "builtin": True,
    },
    "breathy": {
        "id": "breathy",
        "label": "气声 (Breathy · V̤)",
        "desc": "声门开度增大、相对振幅降低并伴随气噪与微扰（参考 VoQS V̤ 稳定段）",
        "source9_phys": [8800.0, 0.075, 0.056, 0.072, 1.48, 0.38, -0.18, 46.0, 36.0],
        "f0_shift_semitones": -0.5,
        "default_f0_coupling": False,
        "is_voiceless_target": False,
        "builtin": True,
    },
    "pressed": {
        "id": "pressed",
        "label": "挤喉发声/紧声 (Pressed · V͈)",
        "desc": "高声门下压、声带收紧与高相位滞后，高频谐波集中（参考 VoQS V͈ 稳定段）",
        "source9_phys": [11200.0, 0.015, 0.018, 0.006, 1.62, 0.88, 0.58, 18.8, 6.4],
        "f0_shift_semitones": 1.5,
        "default_f0_coupling": False,
        "is_voiceless_target": False,
        "builtin": True,
    },
    "creaky": {
        "id": "creaky",
        "label": "嘎裂声 (Creaky · V̰)",
        "desc": "后部收紧（负 CA）、高相位滞后与强微扰（高 FL / SHIM，参考 VoQS V̰ 稳定段）",
        "source9_phys": [7400.0, 0.028, 0.046, -0.019, 1.94, 0.64, 0.34, 61.0, 66.5],
        "f0_shift_semitones": -5.0,
        "default_f0_coupling": False,
        "is_voiceless_target": False,
        "builtin": True,
    },
    "falsetto": {
        "id": "falsetto",
        "label": "假声 (Falsetto · F)",
        "desc": "低相位滞后（低 LAG）、小振幅边缘振动并同步抬高基频（参考 VoQS F 稳定段）",
        "source9_phys": [6400.0, 0.012, 0.035, 0.036, 0.58, 0.18, -0.04, 22.0, 12.0],
        "f0_shift_semitones": 10.0,
        "f0_target_hz": 400.0,
        "default_f0_coupling": True,
        "is_voiceless_target": False,
        "builtin": True,
    },
    "whispery": {
        "id": "whispery",
        "label": "耳语声 (Whispery · Ṿ)",
        "desc": "保留弱周期振动（低 RA）并叠加较大后部隙漏气湍流（参考 VoQS Ṿ 稳定段）",
        "source9_phys": [9200.0, 0.058, 0.048, 0.088, 1.32, 0.24, 0.06, 42.0, 26.0],
        "f0_shift_semitones": 0.0,
        "default_f0_coupling": False,
        "is_voiceless_target": False,
        "builtin": True,
    },
    "whisper": {
        "id": "whisper",
        "label": "耳语 (Whisper · W)",
        "desc": "关闭周期振动（RA=0），以声门狭缝湍流气噪驱动声道（参考 VoQS W 稳定段）",
        "source9_phys": [8600.0, 0.084, 0.048, 0.082, 1.84, 0.00, 0.00, 50.0, 32.0],
        "f0_shift_semitones": 0.0,
        "default_f0_coupling": False,
        "is_voiceless_target": True,
        "builtin": True,
    },
    "voiceless": {
        "id": "voiceless",
        "label": "清化 (Voiceless)",
        "desc": "声门大开无周期振动，用于清化连续统实验",
        "source9_phys": [8000.0, 0.180, 0.180, 0.020, 1.22, 0.00, 0.50, 0.0, 0.0],
        "f0_shift_semitones": 0.0,
        "default_f0_coupling": False,
        "is_voiceless_target": True,
        "builtin": True,
    },
}


class CustomPresetStore:
    """Lightweight JSON store for user-extracted custom phonation presets."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def load_all(self) -> Dict[str, Dict[str, Any]]:
        out = {k: dict(v) for k, v in BUILTIN_PHONATION_PRESETS.items()}
        if self.path.is_file():
            try:
                raw = self._read_custom()
            except ValueError:
                return out
            for k, v in raw.items():
                if (k not in out and isinstance(v, dict) and isinstance(v.get("label"), str)
                        and isinstance(v.get("source9_phys"), list) and len(v["source9_phys"]) == 9
                        and all(type(x) in (int, float) and np.isfinite(x) for x in v["source9_phys"])):
                    out[k] = {**v, "id": k, "builtin": False}
        return out

    def _read_custom(self) -> Dict[str, Any]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError) as error:
            raise ValueError("无法读取本地发声类型预设文件，请检查该文件。") from error
        if not isinstance(raw, dict):
            raise ValueError("本地发声类型预设文件格式无效。")
        return raw

    def save_custom(
        self,
        preset_id: str,
        *,
        label: str,
        source9_phys: List[float],
        f0_shift_semitones: float = 0.0,
        ref_f0_hz: float = 150.0,
        is_voiceless_target: bool = False,
        desc: str = "从录音提取的自定义发声类型原型",
    ) -> Dict[str, Any]:
        if len(source9_phys) != 9:
            raise ValueError("source9_phys must have length 9: [PR, XB, XT, CA, LAG, RA, PS, FL, SHIM]")
        cur = self._read_custom() if self.path.is_file() else {}
        entry = {
            "id": preset_id,
            "label": label,
            "desc": desc,
            "source9_phys": [round(float(x), 5) for x in source9_phys],
            "f0_shift_semitones": round(float(f0_shift_semitones), 2),
            "ref_f0_hz": round(float(ref_f0_hz), 1),
            "is_voiceless_target": bool(is_voiceless_target),
            "builtin": False,
        }
        cur[preset_id] = entry
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp.json")
        tmp.write_text(json.dumps(cur, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.path)
        return entry

    def delete_custom(self, preset_id: str) -> bool:
        if preset_id in BUILTIN_PHONATION_PRESETS or not self.path.is_file():
            return False
        cur = self._read_custom()
        if preset_id not in cur:
            return False
        del cur[preset_id]
        tmp = self.path.with_suffix(".tmp.json")
        tmp.write_text(json.dumps(cur, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.path)
        return True


def extract_phonation_preset_from_m27_phys(
    m27_phys: np.ndarray,
    *,
    voiced_mask: np.ndarray | None = None,
    t_start_sec: float | None = None,
    t_end_sec: float | None = None,
    fps: float = 50.0,
) -> Dict[str, Any]:
    """Compute robust median [PR, XB, XT, CA, LAG, RA, PS, FL, SHIM] + median F0 from a voiced region."""
    arr = np.asarray(m27_phys, dtype=np.float32)
    n = arr.shape[0]
    i0 = max(0, int(round((t_start_sec or 0.0) * fps)))
    i1 = min(n, int(round(t_end_sec * fps))) if (t_end_sec is not None and t_end_sec > 0) else n
    if i1 <= i0:
        i0, i1 = 0, n

    sub = arr[i0:i1]
    if voiced_mask is not None:
        vm = np.asarray(voiced_mask, dtype=bool)[i0:i1]
    else:
        vm = (sub[:, PR_INDEX] > 1200.0) & (sub[:, 23] > 0.22)  # PR > 1200 dPa & RA > 0.22

    active = sub[vm] if np.any(vm) else sub[sub[:, PR_INDEX] > 600.0]
    if active.shape[0] == 0:
        active = sub

    med_src9 = np.median(active[:, 18:27], axis=0)
    med_f0 = float(np.median(active[:, F0_INDEX]))
    is_voiceless = bool(med_src9[5] < 0.15)  # RA < 0.15
    return {
        "source9_phys": [round(float(x), 5) for x in med_src9.tolist()],
        "ref_f0_hz": round(med_f0, 1),
        "is_voiceless_target": is_voiceless,
        "frames_used": int(active.shape[0]),
    }
