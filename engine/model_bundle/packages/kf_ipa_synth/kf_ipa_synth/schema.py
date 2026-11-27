"""Data contracts & 27-dim vocal-tract parameter metadata for kf_ipa_synth.

Defines:
  - M27_PARAM_SPECS: Full human + machine readable catalog of all 27 articulatory & glottal parameters
    (index, physical bounds, unit, step, organ group, zh/en labels) for vocal-tract ↔ keyframe binding.
  - KeyframeSpec / F0Point / TimelineSpec / TractOverridePatch / SynthOptions / SynthResult.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .m27_contract import M27_MAX, M27_MIN, M27_NAMES

# Physical 9-dim source presets [PR, XB, XT, CA, LAG, RA, PS, FL, SHIM]
PHONATION_PRESETS_PHYS: Dict[str, List[float]] = {
    "modal":     [8200.0,  0.040,  0.040,  0.020, 1.22,  0.92,  0.45,  8.0,  2.0],
    "breathy":   [7800.0,  0.085,  0.085,  0.105, 0.72,  0.76, -0.25, 28.0, 18.0],
    "pressed":   [11500.0, -0.012, -0.012, -0.020, 1.95, 0.94,  0.78, 10.0,  5.0],
    "creaky":    [5200.0,  0.000,  0.000, -0.008, 2.25,  0.80,  0.78, 72.0, 72.0],
    "falsetto":  [7200.0,  0.065,  0.065,  0.065, 0.25,  0.54, -0.45, 16.0,  8.0],
    "whisper":   [8500.0,  0.115,  0.115,  0.155, 1.10,  0.00,  0.00, 30.0, 12.0],
    "voiceless": [8000.0,  0.180,  0.180,  0.020, 1.22,  0.00,  0.50,  0.0,  0.0],
    "silence":   [0.0,     0.120,  0.120,  0.050, 1.22,  0.00,  0.50,  0.0,  0.0],
}

# Organ-grouped parameter specifications shared by Python backend & JS Vocal-Tract Bridge
_PARAM_META: Dict[str, Tuple[str, str, str, str, float]] = {
    # name: (organ_group, zh_label, en_label, unit, ui_step)
    "HX":   ("hyoid",    "舌骨前后",     "Hyoid X",               "ratio", 0.02),
    "HY":   ("hyoid",    "舌骨高低",     "Hyoid Y",               "cm",    0.05),
    "JX":   ("jaw",      "下颌前后",     "Jaw X",                 "cm",    0.02),
    "JA":   ("jaw",      "下颌开合角",   "Jaw Angle",             "deg",   0.1),
    "LP":   ("lips",     "唇前突/圆唇",  "Lip Protrusion",        "ratio", 0.05),
    "LD":   ("lips",     "双唇间距",     "Lip Distance",          "cm",    0.05),
    "VS":   ("velum",    "软腭形状",     "Velum Shape",           "ratio", 0.05),
    "VO":   ("velum",    "鼻腔通道开度", "Velic Opening",         "ratio", 0.05),
    "TCX":  ("tongue",   "舌体中心 X",   "Tongue Center X",       "cm",    0.08),
    "TCY":  ("tongue",   "舌体中心 Y",   "Tongue Center Y",       "cm",    0.08),
    "TTX":  ("tongue",   "舌尖 X",       "Tongue Tip X",          "cm",    0.08),
    "TTY":  ("tongue",   "舌尖 Y",       "Tongue Tip Y",          "cm",    0.08),
    "TBX":  ("tongue",   "舌叶 X",       "Tongue Blade X",        "cm",    0.08),
    "TBY":  ("tongue",   "舌叶 Y",       "Tongue Blade Y",        "cm",    0.08),
    "TS1":  ("sides",    "舌边后部",     "Tongue Side 1",         "ratio", 0.05),
    "TS2":  ("sides",    "舌边中部",     "Tongue Side 2",         "ratio", 0.05),
    "TS3":  ("sides",    "舌边前部/边音", "Tongue Side 3",        "ratio", 0.05),
    "F0":   ("glottis",  "基频 F0",      "Fundamental Frequency", "Hz",    1.0),
    "PR":   ("glottis",  "声门下肺压",   "Subglottal Pressure",   "dPa",   200.0),
    "XB":   ("glottis",  "声带下缘位移", "Lower Glottal Disp.",   "cm",    0.005),
    "XT":   ("glottis",  "声带上缘位移", "Upper Glottal Disp.",   "cm",    0.005),
    "CA":   ("glottis",  "杓间裂隙",     "Chink Area",            "cm²",   0.005),
    "LAG":  ("glottis",  "声带相位差",   "Phase Lag",             "rad",   0.05),
    "RA":   ("glottis",  "相对振幅",     "Relative Amplitude",    "ratio", 0.02),
    "PS":   ("glottis",  "声门脉冲斜率", "Pulse Skewness",        "ratio", 0.05),
    "FL":   ("glottis",  "基频微扰",     "Flutter / Jitter",      "%",     2.0),
    "SHIM": ("glottis",  "振幅微扰",     "Shimmer",               "%",     2.0),
}

M27_PARAM_SPECS: List[Dict[str, Any]] = [
    {
        "index": idx,
        "name": name,
        "organ": _PARAM_META[name][0],
        "label_zh": _PARAM_META[name][1],
        "label_en": _PARAM_META[name][2],
        "unit": _PARAM_META[name][3],
        "step": _PARAM_META[name][4],
        "min": round(float(M27_MIN[idx]), 4),
        "max": round(float(M27_MAX[idx]), 4),
        "is_tract": idx < 17,
        "is_f0": idx == 17,
        "is_glottis": idx >= 18,
    }
    for idx, name in enumerate(M27_NAMES)
]

M27_PARAM_SPEC_BY_NAME: Dict[str, Dict[str, Any]] = {s["name"]: s for s in M27_PARAM_SPECS}


@dataclass
class KeyframeSpec:
    """Single phonetic keyframe on the timeline with optional vocal-tract micro-adjustments.

    Vocal-tract bidirectional linkage fields:
      - ``pose_overrides``: absolute physical target values keyed by M27 parameter name
        (e.g. ``{"TTX": 5.35, "TTY": 1.15, "LP": 0.45}``).
      - ``pose_deltas``: relative physical offsets added on top of the resolved IPA pose
        (e.g. ``{"TCY": +0.35, "JA": -0.8}``).
      - ``mask_overrides``: optional explicit organ constraint weights in ``[0, 1]`` for KF26 dims.
      - ``auto_pin_overrides``: when True (default), any parameter edited in ``pose_overrides`` or
        ``pose_deltas`` automatically raises its organ mask ``w_mask`` to ``1.0`` so neither the
        async qTA baseline nor KF2Tract27 discards the user's vocal-tract micro-adjustment.
    """

    ipa: str = "sil"
    duration_ms: float = 160.0
    f0_hz: float = 150.0
    phonation: str = "auto"
    role: str = "normal"
    syl_id: str = ""
    mora_no: Optional[int] = None
    pose_overrides: Dict[str, float] = field(default_factory=dict)
    pose_deltas: Dict[str, float] = field(default_factory=dict)
    mask_overrides: Dict[str, float] = field(default_factory=dict)
    auto_pin_overrides: bool = True

    @classmethod
    def from_dict(cls, raw: Dict[str, Any]) -> "KeyframeSpec":
        po = {
            str(k): float(v)
            for k, v in (raw.get("pose_overrides") or {}).items()
            if str(k) in M27_PARAM_SPEC_BY_NAME and v is not None
        }
        pd = {
            str(k): float(v)
            for k, v in (raw.get("pose_deltas") or {}).items()
            if str(k) in M27_PARAM_SPEC_BY_NAME and v is not None
        }
        mo = {
            str(k): float(max(0.0, min(1.0, float(v))))
            for k, v in (raw.get("mask_overrides") or {}).items()
            if str(k) in M27_PARAM_SPEC_BY_NAME and str(k) != "F0" and v is not None
        }
        mora_raw = raw.get("mora_no")
        return cls(
            ipa=str(raw.get("ipa", "sil")).strip() or "sil",
            duration_ms=max(20.0, min(3000.0, float(raw.get("duration_ms", 160.0)))),
            f0_hz=max(1e-3, float(raw.get("f0_hz", 150.0))),
            phonation=str(raw.get("phonation", "auto")).strip().lower() or "auto",
            role=str(raw.get("role", "normal")).strip().lower() or "normal",
            syl_id=str(raw.get("syl_id", "")),
            mora_no=int(mora_raw) if mora_raw is not None else None,
            pose_overrides=po,
            pose_deltas=pd,
            mask_overrides=mo,
            auto_pin_overrides=bool(raw.get("auto_pin_overrides", True)),
        )

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        if d["mora_no"] is None:
            d.pop("mora_no")
        if not d["pose_overrides"]:
            d.pop("pose_overrides")
        if not d["pose_deltas"]:
            d.pop("pose_deltas")
        if not d["mask_overrides"]:
            d.pop("mask_overrides")
        if d["auto_pin_overrides"]:
            d.pop("auto_pin_overrides")
        return d


@dataclass
class F0Point:
    t: float
    hz: float

    @classmethod
    def from_dict(cls, raw: Dict[str, Any]) -> "F0Point":
        return cls(t=float(raw["t"]), hz=max(1e-3, float(raw["hz"])))


@dataclass
class SynthRequest:
    keyframes: List[KeyframeSpec]
    f0_points: List[F0Point] = field(default_factory=list)
    source_text: str = ""
    alpha: float = 1.0
    checkpoint: str = "auto"            # "auto" | "baseline_only" | file path
    gain_mode: str = "calibrated"       # "calibrated" | "auto_rms" | "raw"
    dirty_b_donor: str = ""
    render_r21: bool = True             # Render 48 kHz VTL R21 audio when JD2 native backend is present
    render_animation: bool = True       # Render 25 fps sagittal animation (JD2 native or parametric fallback)
    animation_fps: int = 25
    use_neural_vocoder: bool = False    # Render 16 kHz Stage-5 (Stage5Lite or Teacher) neural voice
    vocoder_checkpoint: str = "auto"    # "auto" | file path
    speaker_profile: str = ""           # Saved 1 KB speaker profile ID/path
    speaker_embedding: Optional[List[float]] = None  # Raw 512-d embedding directly passed by another model
    ref_wav: str = ""                   # Or extract speaker embedding on the fly from a wav file

    @classmethod
    def from_dict(cls, raw: Dict[str, Any]) -> "SynthRequest":
        kfs = [KeyframeSpec.from_dict(x) for x in (raw.get("keyframes") or [])]
        f0s: List[F0Point] = []
        for pt in (raw.get("f0_points") or []):
            if isinstance(pt, dict) and "t" in pt and "hz" in pt:
                try:
                    f0s.append(F0Point.from_dict(pt))
                except (TypeError, ValueError):
                    pass
        gain_mode = str(raw.get("gain_mode", "calibrated")).strip().lower()
        if gain_mode not in ("calibrated", "auto_rms", "raw"):
            gain_mode = "calibrated"
        use_nv = bool(raw.get("use_neural_vocoder", raw.get("use_stage5", False)))
        spk_emb = raw.get("speaker_embedding")
        if spk_emb is not None:
            spk_emb = [float(x) for x in spk_emb]
        return cls(
            keyframes=kfs,
            f0_points=f0s,
            source_text=str(raw.get("source_text", "")),
            alpha=float(raw.get("alpha", 1.0)),
            checkpoint=str(raw.get("checkpoint", "auto")).strip() or "auto",
            gain_mode=gain_mode,
            dirty_b_donor=str(raw.get("dirty_b_donor", "")).strip(),
            render_r21=bool(raw.get("render_r21", True)),
            render_animation=bool(raw.get("render_animation", True)),
            animation_fps=max(5, min(50, int(raw.get("animation_fps", 25)))),
            use_neural_vocoder=use_nv,
            vocoder_checkpoint=str(raw.get("vocoder_checkpoint", "auto")).strip() or "auto",
            speaker_profile=str(raw.get("speaker_profile", "")).strip(),
            speaker_embedding=spk_emb,
            ref_wav=str(raw.get("ref_wav", "")).strip(),
        )


__all__ = [
    "F0Point",
    "KeyframeSpec",
    "M27_PARAM_SPECS",
    "M27_PARAM_SPEC_BY_NAME",
    "PHONATION_PRESETS_PHYS",
    "SynthRequest",
]
