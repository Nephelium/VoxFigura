"""Pinned, multilingual CTranslate2 Whisper model files."""
from dataclasses import dataclass
from pathlib import Path


CACHE = Path(__file__).resolve().parents[1] / ".cache" / "asr"
DEFAULT_MODEL = "tiny"
LEGACY_MODEL = "base"


@dataclass(frozen=True)
class ModelFiles:
    repository: str
    revision: str
    files: dict[str, tuple[int, str]]

    @property
    def size_bytes(self) -> int:
        return sum(size for size, _ in self.files.values())


MODELS = {
    "tiny": ModelFiles("Systran/faster-whisper-tiny", "d90ca5fe260221311c53c58e660288d3deb8d356", {
        "config.json": (2249, "a73a28cdfe1c43ccc7202fa333d1f89c202477271407ae9a7f19afa52039cac8"),
        "tokenizer.json": (2203239, "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab"),
        "vocabulary.txt": (459861, "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913"),
        "model.bin": (75538270, "dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1"),
    }),
    "large-v3-turbo": ModelFiles("mobiuslabsgmbh/faster-whisper-large-v3-turbo", "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf", {
        "config.json": (2263, "b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e"),
        "preprocessor_config.json": (340, "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711"),
        "tokenizer.json": (2710337, "297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd"),
        "vocabulary.json": (1068114, "c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1"),
        "model.bin": (1617884929, "e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da"),
    }),
    "large-v3": ModelFiles("Systran/faster-whisper-large-v3", "edaa852ec7e145841d8ffdb056a99866b5f0a478", {
        "config.json": (2394, "a9306624f5ec14270a014b647e5c316b6e03a662c369758d1b90697a7b0655b9"),
        "preprocessor_config.json": (340, "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711"),
        "tokenizer.json": (2480617, "6d8cbd7cd0d8d5815e478dac67b85a26bbe77c1f5e0c6d76d1ce2abc0e5f21ca"),
        "vocabulary.json": (1068114, "c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1"),
        "model.bin": (3087284237, "69f74147e3334731bc3a76048724833325d2ec74642fb52620eda87352e3d4f1"),
    }),
}


def model_dir(name: str) -> Path:
    return CACHE / f"faster-whisper-{name}"


def has_model_files(path: Path) -> bool:
    return all((path / name).is_file() for name in ("config.json", "model.bin", "tokenizer.json")) and any(
        (path / name).is_file() for name in ("vocabulary.txt", "vocabulary.json")
    )


def is_installed(name: str) -> bool:
    path = model_dir(name)
    if name == LEGACY_MODEL:
        return has_model_files(path)
    try:
        return all((path / filename).stat().st_size == size for filename, (size, _) in MODELS[name].files.items())
    except OSError:
        return False


def default_local_model() -> str:
    return next((name for name in (DEFAULT_MODEL, LEGACY_MODEL, "large-v3-turbo", "large-v3")
                 if is_installed(name)), DEFAULT_MODEL)
