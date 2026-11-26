"""kf_ipa_synth — Portable IPA-to-Vocal-Tract Speech Synthesis Core, Speaker Profile Store & Web Studio.

PyTorch-only symbols are lazily loaded via PEP 562 `__getattr__` so pure-NumPy submodules
(`m27_contract`, `phonetics`, `pose_bank`, `baseline`, `text2ipa`, `tract_backend`) never import `torch`.
"""
from __future__ import annotations

from .m27_contract import (
    M27_INDEX,
    M27_MAX,
    M27_MIN,
    M27_NAMES,
    SAMPLE_RATE_16K,
    SAMPLE_RATE_48K,
    denormalize_m27,
    normalize_m27,
)
from .phonetics import (
    KF26_INDEX,
    KF26_NAMES,
    SegmentEvent,
    validate_ipa_diacritics,
)
from .pose_bank import PoseBank
from .schema import (
    F0Point,
    KeyframeSpec,
    M27_PARAM_SPECS,
    M27_PARAM_SPEC_BY_NAME,
    PHONATION_PRESETS_PHYS,
    SynthRequest,
)
from .text2ipa import convert_text_to_timeline
from .tract_backend import TractBackend

__version__ = "0.1.0"

_LAZY_IMPORTS = {
    "IPASynthAPI": (".api", "IPASynthAPI"),
    "create_fastapi_router": (".api", "create_fastapi_router"),
    "EngineConfig": (".engine", "EngineConfig"),
    "IPASynthEngine": (".engine", "IPASynthEngine"),
    "IPA2Tract": (".models", "IPA2Tract"),
    "IPA2TractLite": (".models", "IPA2TractLite"),
    "Tract2VoxLarge": (".models", "Tract2VoxLarge"),
    "Tract2VoxLite": (".models", "Tract2VoxLite"),
    "Vox2SpkLite": (".models", "Vox2SpkLite"),
    "SpeakerProfileStore": (".speaker_store", "SpeakerProfileStore"),
}


def __getattr__(name: str):
    target = _LAZY_IMPORTS.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    import importlib
    mod = importlib.import_module(target[0], __name__)
    return getattr(mod, target[1])


__all__ = [
    "EngineConfig",
    "F0Point",
    "IPA2Tract",
    "IPA2TractLite",
    "IPASynthAPI",
    "IPASynthEngine",
    "Tract2VoxLarge",
    "Tract2VoxLite",
    "Vox2SpkLite",
    "KF26_INDEX",
    "KF26_NAMES",
    "KeyframeSpec",
    "M27_INDEX",
    "M27_MAX",
    "M27_MIN",
    "M27_NAMES",
    "M27_PARAM_SPECS",
    "M27_PARAM_SPEC_BY_NAME",
    "PHONATION_PRESETS_PHYS",
    "PoseBank",
    "SAMPLE_RATE_16K",
    "SAMPLE_RATE_48K",
    "SegmentEvent",
    "SpeakerProfileStore",
    "SynthRequest",
    "TractBackend",
    "__version__",
    "convert_text_to_timeline",
    "create_fastapi_router",
    "denormalize_m27",
    "normalize_m27",
    "validate_ipa_diacritics",
]
