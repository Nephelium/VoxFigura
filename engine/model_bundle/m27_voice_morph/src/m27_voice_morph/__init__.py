"""M27 Voice Morph — Packable time-varying phonation modulation & dual-speaker organ transplantation kit."""
from .alignment import align_m27_anchors, align_m27_dtw, parse_textgrid_boundaries
from .curves import (
    apply_f0_semitone_coupling,
    compute_voicing_and_speech_gates,
    sample_curve_50hz,
    slerp_speaker_sequence,
    smooth_curve_anti_click,
)
from .morpher import (
    DualMorphConfig,
    PresetMorphConfig,
    apply_dual_speaker_morph,
    apply_preset_phonation_morph,
    denormalize_m27_norm,
    normalize_m27_phys,
)
from .presets import (
    BUILTIN_PHONATION_PRESETS,
    CustomPresetStore,
    M27_PARAM_NAMES,
    ORGAN_GROUPS,
    extract_phonation_preset_from_m27_phys,
)

__all__ = [
    "BUILTIN_PHONATION_PRESETS",
    "CustomPresetStore",
    "DualMorphConfig",
    "M27_PARAM_NAMES",
    "ORGAN_GROUPS",
    "PresetMorphConfig",
    "align_m27_anchors",
    "align_m27_dtw",
    "apply_dual_speaker_morph",
    "apply_f0_semitone_coupling",
    "apply_preset_phonation_morph",
    "compute_voicing_and_speech_gates",
    "denormalize_m27_norm",
    "extract_phonation_preset_from_m27_phys",
    "normalize_m27_phys",
    "parse_textgrid_boundaries",
    "sample_curve_50hz",
    "slerp_speaker_sequence",
    "smooth_curve_anti_click",
]
