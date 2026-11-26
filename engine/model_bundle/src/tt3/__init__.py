"""PhonoTract Studio (PhonoTract Core) self-training package (tt3 compatibility namespace)."""

from .model_registry import (
    MODEL_REGISTRY,
    MODEL_SUITE_NAME,
    ModelSpec,
    PROJECT_NAME,
    canonicalize_model_name,
    get_model_spec,
    list_models,
    registry_summary_dicts,
    resolve_model_path,
)

__all__ = [
    "MODEL_REGISTRY",
    "MODEL_SUITE_NAME",
    "ModelSpec",
    "PROJECT_NAME",
    "canonicalize_model_name",
    "get_model_spec",
    "list_models",
    "registry_summary_dicts",
    "resolve_model_path",
]
