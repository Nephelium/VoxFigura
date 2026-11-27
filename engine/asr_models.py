"""Pinned ONNX model files for optional offline SenseVoice-Small transcription."""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path


DEFAULT_CACHE = Path(__file__).resolve().parents[1] / ".cache" / "asr"
DEFAULT_MODEL = "sensevoice-small"


@dataclass(frozen=True)
class ModelFiles:
    repository: str
    revision: str
    modelscope_repository: str
    files: dict[str, tuple[int, str]]

    @property
    def size_bytes(self) -> int:
        return sum(size for size, _ in self.files.values())


MODELS: dict[str, ModelFiles] = {
    "sensevoice-small": ModelFiles(
        repository="csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
        revision="2365baeacb507f821a0c8120fcee3d484dba7a07",
        modelscope_repository="pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue",
        files={
            "tokens.txt": (
                315894,
                "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
            ),
            "model.int8.onnx": (
                239233841,
                "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
            ),
        },
    ),
}


def cache_root() -> Path:
    configured = os.environ.get("VOCALCUT_ASR_CACHE_DIR", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return DEFAULT_CACHE


def model_dir(name: str = DEFAULT_MODEL) -> Path:
    return cache_root() / name


def has_model_files(path: Path) -> bool:
    return (path / "model.int8.onnx").is_file() and (path / "tokens.txt").is_file()


def is_installed(name: str = DEFAULT_MODEL) -> bool:
    spec = MODELS.get(name)
    if spec is None:
        return False
    path = model_dir(name)
    try:
        return all((path / filename).stat().st_size == size for filename, (size, _) in spec.files.items())
    except OSError:
        return False


def default_local_model() -> str:
    return DEFAULT_MODEL
